/**
 * bench 的**共享基础设施** —— P2-T08（DEVELOPMENT-PLAN.md 行 2004~2052）。
 *
 * ⚠️ **这个文件是 bench 目录里唯一读时钟的地方**，且**读的是「单调经过时间」**。
 *   ⇒ **为什么不用 `performance.now()`**：`scripts/check-clock.ts` 的 C37 扫描
 *     把 `performance.now()` 与 `Date.now()` / `new Date()` 列为**墙钟读取形态**
 *     （§11.1 的时钟注入纪律管的是「**参与业务判断**的时间戳」）。
 *     而 bench 里的时钟**只用来量耗时**（P99 统计、耗时占比）⇒ 它不是墙钟，
 *     而是**单调计数器**⇒ 用 `process.hrtime.bigint()`（单调、纳秒、**不是墙钟**）
 *     ⇒ **完全不落在 C37 的三种形态里** ⇒ 不需要动 C37 的豁免清单，
 *     也不需要动设计稿 §11.1（那份清单与代码是**双向比对**的 ⇒ 改它就是改设计）。
 *   ⇒ **为什么仍然收口到一个文件**：万一日后决定改用 `performance.now()`，
 *     只需改这一处 ⇒ 纪律仍然是「一处」。
 *
 * ⚠️ **bench 与 `pnpm run verify` 的关系**（团队关心的「怎么解耦」）：
 *   · bench 的**五个脚本**（corpus / embedder / perf / baseline-flat / agreement）
 *     **不在 verify 链里**（它们要跑几分钟 ⇒ 每次门禁跑一遍不可接受）；
 *   · verify 链里只有**一个小规模冒烟**（`tests/bench/bench-smoke.test.ts`）：
 *     它在**小规模**（数千条）上跑**同一套断言逻辑** ⇒ bench 的断言不会腐坏；
 *   · ⇒ 「重测」与「守门」分离：**重测靠人跑脚本，守门靠小规模冒烟**。
 *
 * ⚠️ **本文件不复制生产逻辑**：能 import 的都 import（`src/db/connection.ts`、
 *   `src/db/migrate.ts`、`src/store/transaction.ts`、`src/vector/centroids.ts`、
 *   `src/vector/rebuild.ts`）⇒ 测出来的数**测的是生产实现**，
 *   而不是一份「bench 专用实现」。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus as cpus_, freemem, totalmem } from 'node:os';
import { dirname, join } from 'node:path';

import type Database from 'better-sqlite3';

import { openDatabase } from '../../src/db/connection.js';
import { ensureSchema } from '../../src/db/migrate.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { blobToVector, vectorToBlob } from '../../src/vector/centroids.js';
import { rebuildBuckets } from '../../src/vector/rebuild.js';

// ═══════════════════════════════ 时钟（唯一的计时入口） ═══════════════════════════════

/**
 * 读**单调经过时间**（纳秒）。
 *
 * ⚠️ **不是墙钟** ⇒ 不落在 C37 的三种形态里（见文件头）。
 * ⚠️ **只用于「量耗时」**（P99 统计、耗时占比）—— **不参与任何被测结果**
 *   （向量、命中集合、分数）⇒ 与 §11.1 的注入时钟纪律不是同一件事。
 *
 * @returns 纳秒（相对任意起点，单调）
 */
export function monotonicNs(): bigint {
  return process.hrtime.bigint();
}

/**
 * 量一段同步代码的耗时（毫秒）。
 *
 * ⚠️ **必须包住「被测的那一段」**：计时器本身的开销（两次 `hrtime` 读数 ≈ 几十纳秒）
 *   相对毫秒级耗时可忽略 ⇒ 但**样本数很少时**（比如自检探针）要留意。
 *
 * @param body 被测代码
 * @returns 耗时（毫秒）
 */
export function measureMs(body: () => void): number {
  const start = monotonicNs();
  body();
  const end = monotonicNs();
  return Number(end - start) / 1_000_000;
}

// ═══════════════════════════════ 确定性随机（语料可复现的根基） ═══════════════════════════════

/**
 * mulberry32 伪随机发生器（32 位状态 ⇒ **完全确定**、跨平台一致）。
 *
 * ⚠️ **为什么不用 `Math.random()`**：它不可播种 ⇒ 同一份语料两次生成不同
 *   ⇒ 「同种子 ⇒ 同一批文本」这条验收断言**恒假** ⇒ 整个性能基线失去意义。
 * ⚠️ **为什么自己写而不是引库**：`bench/` 的全部依赖只有 `better-sqlite3`
 *   ⇒ 少一个依赖就少一份「这个库的 PRNG 在别的版本上会不会变」的风险。
 *
 * @param seed 种子（32 位无符号）
 * @returns 产出 `[0, 1)` 均匀分布的函数
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 字符串的 32 位 FNV-1a 哈希（**确定性**、跨平台一致）。
 *
 * ⚠️ **不用 `node:crypto` 的哈希做分桶**：MD5/SHA 的输出是 16/32 字节
 *   ⇒ 取低位做桶索引时分布不均；FNV-1a 的低位分布更好，且更快。
 *   ⇒ `sha1Hex` 只用于**内容指纹**（`content_hash` 必须是 SHA-1 ⇒ 生产口径）。
 *
 * @param text 待哈希的字符串
 * @returns 32 位无符号哈希
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 内容指纹（SHA-1 ⇒ **生产口径**：`content_hash` 就是 `sha1(normalize(content))`）。
 *
 * @param text 待指纹的字符串
 * @returns 40 位十六进制字符串
 */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

// ═══════════════════════════════ 统计口径（P99 的定义写在这里） ═══════════════════════════════

/**
 * 百分位（**nearest-rank** 法）。
 *
 * ⚠️ **口径必须写死**（不然「P99 ≤ 200ms」这句话没有可判定性）：
 *   · 样本升序排序；
 *   · 取第 `ceil(p / 100 × n)` 个样本（**1 起数**）；
 *   · `n = 0` ⇒ 返回 `0`（**不是** `NaN` ⇒ 不会被后续比较静默吞掉）。
 *
 * @param samples 样本（**不要求已排序**；内部会复制后排序 ⇒ 不改调用方的数组）
 * @param percentileValue 百分位（0~100）
 * @returns 百分位对应的样本值
 */
export function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((percentileValue / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? 0;
}

/**
 * 一组耗时的汇总统计（**报告里要贴的就是这个**）。
 */
export interface LatencySummary {
  /** 样本数（**报告必须写明**）。 */
  readonly count: number;
  /** 最小值（毫秒）。 */
  readonly minMs: number;
  /** 中位数（毫秒）。 */
  readonly p50Ms: number;
  /** p90（毫秒）。 */
  readonly p90Ms: number;
  /** p95（毫秒）。 */
  readonly p95Ms: number;
  /** **p99（毫秒）** ⇒ 门槛判定用的就是它。 */
  readonly p99Ms: number;
  /** 最大值（毫秒）。 */
  readonly maxMs: number;
  /** 平均值（毫秒）。 */
  readonly meanMs: number;
}

/**
 * 汇总一组耗时。
 *
 * ⚠️ **样本数必须进结果**（`count`）：「P99 = 12ms」在 10 个样本与 10 万个样本上
 *   是**两条完全不同的结论** ⇒ 报告里不写样本数 ⇒ 数字没有意义。
 *
 * @param samples 耗时样本（毫秒）
 * @returns 汇总统计
 */
export function summarizeLatency(samples: readonly number[]): LatencySummary {
  const count = samples.length;
  if (count === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[count - 1] ?? 0,
    meanMs: sum / count,
  };
}

// ═══════════════════════════════ 峰值内存（训练期 ≥ 3.5GB 的测量） ═══════════════════════════════

/**
 * 峰值 RSS 采样器（**字节**）。
 *
 * ⚠️ **为什么采样 `rss` 而不是 `heapUsed`**：
 *   · `heapUsed` 只是 V8 的堆 ⇒ **看不到 `Buffer` / `Float32Array` 的外部内存**
 *     ⇒ 而训练期的 3GB 向量**全在堆外**（`Float32Array` 的 backing store）⇒
 *     `heapUsed` 会把峰值报成几百 MB ⇒ **完全失真**；
 *   · `rss`（常驻集）是**进程实际占用的物理内存** ⇒ 才是「这台机器要留多少内存」的答案。
 *   ⇒ 而 §12 的 R-04 说「训练期峰值内存 ≥ 3.5GB」⇒ 说的是**资源规划** ⇒ 必须用 RSS。
 *
 * ⚠️ **采样是「尽力而为」**：Node 的定时器在**同步长任务**期间不触发
 *   ⇒ 训练（同步、几十秒~几分钟）期间**采样器可能一次都跑不到**。
 *   ⇒ 故本采样器**同时**用 `process.resourceUsage().maxRSS` 兜底
 *     （那是内核维护的**高水位**，**不会**因为采样器没跑到而丢失）。
 */
export class PeakRssSampler {
  /** 采样到的最高 RSS（字节）。 */
  private sampledPeak = 0;

  /** 定时器句柄。 */
  private timer: NodeJS.Timeout | undefined;

  /** 采样间隔（毫秒）。 */
  private readonly intervalMs: number;

  /**
   * @param intervalMs 采样间隔（毫秒；默认 50ms）
   */
  constructor(intervalMs = 50) {
    this.intervalMs = intervalMs;
  }

  /** 开始采样。 */
  start(): void {
    this.sample();
    this.timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);
    // ⚠️ **不 `unref()`**：我们要它活到 `stop()`（否则进程可能提前退出 ⇒ 采样丢失）。
  }

  /** 停止采样（幂等）。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.sample();
  }

  /** 立即采一次。 */
  sample(): void {
    const rss = process.memoryUsage().rss;
    if (rss > this.sampledPeak) {
      this.sampledPeak = rss;
    }
  }

  /**
   * 峰值 RSS（字节）。
   *
   * ⚠️ **取「采样峰值」与「内核高水位」的较大者**：
   *   同步长任务期间采样器可能没跑到 ⇒ 采样值会偏小；
   *   而 `maxRSS` 永远正确（内核高水位）⇒ 两者取大 ⇒ **既不漏报也不虚报**。
   */
  peakBytes(): number {
    const kernelPeak = process.resourceUsage().maxRSS * 1024;
    return Math.max(this.sampledPeak, kernelPeak);
  }
}

// ═══════════════════════════════ 库与训练（复用生产代码） ═══════════════════════════════

/**
 * bench 的**基准时间**（毫秒）。
 *
 * ⚠️ **必须固定**：召回的粗筛窗口、时间窗过滤、强度过滤全部依赖 `now`
 *   ⇒ `now` 一变 ⇒ 候选集合就变 ⇒ 同一份语料的测量结果就不可比。
 *   ⇒ 且它**远早于真实时钟**（2025-06-01）⇒ 用**注入时钟**调用生产 API
 *   ⇒ 测量全程不依赖真实时间（可复现）。
 */
export const BENCH_NOW = 1_749_873_600_000;

/**
 * 开一个 bench 用的库（**生产 DDL + 生产 PRAGMA**）。
 *
 * @param dbPath 库文件路径（父目录会自动建）
 * @returns 库句柄
 */
export function openBenchDatabase(dbPath: string): Database.Database {
  const parent = dirname(dbPath);
  if (parent !== '' && parent !== '.') {
    mkdirSync(parent, { recursive: true });
  }
  const db = openDatabase({ dbPath });
  ensureSchema(db);
  return db;
}

/**
 * 训练两级分桶并全量重分配（**直接调用生产重训序列** `src/vector/rebuild.ts`）。
 *
 * ⚠️ **为什么不走 `MemoryStore.rebuildVectorBuckets()`**：那条路会**顺带记事件**
 *   （`type='sweep'`）⇒ 事件表会多出一批噪声 ⇒ 拖慢训练、污染库。
 *   ⇒ bench 直接调**同一个重训函数**（`rebuildBuckets`）⇒ **测的是生产实现**，
 *     只是不记事件（事件不是被测对象）。
 * ⚠️ **事务语义仍然用生产那一份**（`runWriteTransaction`）⇒ 批次提交的行为一致。
 *
 * @param db 库句柄
 * @param options 训练参数（粗/细中心数、探针数）
 * @returns 训练结果（桶数 / 迁移条数）
 */
export function trainBenchBuckets(
  db: Database.Database,
  options: {
    coarseCenters: number;
    fineCenters: number;
    nprobeCoarse: number;
    now?: number;
  },
): { cells: number; coarseCells: number; members: number; migrated: number } {
  // ⚠️ 生产 `runWriteTransaction(db, body)` 带库句柄，而 `rebuildBuckets` 要的是
  //   **已绑定本库**的 `runInTransaction(body)` ⇒ 这里做一次绑定（事务语义仍是生产那一份）。
  const result = rebuildBuckets(db, (body) => runWriteTransaction(db, body), {
    coarseCenters: options.coarseCenters,
    fineCenters: options.fineCenters,
    nprobeCoarse: options.nprobeCoarse,
    now: options.now ?? BENCH_NOW,
  });
  return {
    cells: result.cells,
    coarseCells: result.coarseCells,
    members: result.members,
    migrated: result.migrated,
  };
}

/**
 * 把向量编码成落库用的 BLOB（**生产口径**：`src/vector/centroids.ts` 的同一份实现）。
 *
 * @param vector 向量（Float32）
 * @returns BLOB（Float32 小端）
 */
export function encodeVector(vector: Float32Array): Buffer {
  return vectorToBlob(vector);
}

/**
 * 把库里的 BLOB 解回向量（**生产口径**）。
 *
 * @param blob BLOB
 * @returns 向量（Float32）
 */
export function decodeVector(blob: Buffer): Float32Array {
  return blobToVector(blob);
}

// ═══════════════════════════════ 落盘（结果与报告） ═══════════════════════════════

/**
 * **机器环境**（**基线必须记录在案的机器上采** ⇒ 报告里必须带这一段）。
 *
 * ⚠️ **为什么必须记**：P99 是「**这份数据 + 这台机器**」的结论
 *   ⇒ 换一台机器数字就变 ⇒ 没有机器信息的 P99 **不可复现、不可比较**。
 */
export interface MachineInfo {
  /** 平台（`process.platform` + `process.arch`）。 */
  readonly platform: string;
  /** Node 版本。 */
  readonly node: string;
  /** CPU 型号（`os.cpus()[0].model`）。 */
  readonly cpuModel: string;
  /** CPU 逻辑核数。 */
  readonly cpuCount: number;
  /** 物理内存总量（字节）。 */
  readonly totalMemoryBytes: number;
  /** 采集时刻的**可用**内存（字节）—— **这一项决定能不能跑百万级**。 */
  readonly freeMemoryBytes: number;
  /** 采集时刻的**已用**内存（字节）。 */
  readonly usedMemoryBytes: number;
}

/**
 * 采集机器环境。
 *
 * @returns 机器环境快照
 */
export function machineInfo(): MachineInfo {
  const cpus = cpus_();
  const totalMemoryBytes = totalmem();
  const freeMemoryBytes = freemem();
  return {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes,
    freeMemoryBytes,
    usedMemoryBytes: totalMemoryBytes - freeMemoryBytes,
  };
}

/**
 * 训练阶段的**相位信息**（**报告里必须带** ⇒ 规模与耗时可核对）。
 */
export interface PhaseInfo {
  /** 灌库耗时（毫秒）。 */
  readonly loadMs: number;
  /** 训练耗时（毫秒）。 */
  readonly trainMs: number;
  /** 训练**前**的 RSS（字节）。 */
  readonly rssBeforeTrainBytes: number;
  /** 训练**后**的进程高水位 RSS（字节）—— **含灌库阶段的占用**。 */
  readonly peakRssBytes: number;
  /** 训练段**采样**到的峰值 RSS（字节）—— 只覆盖训练那一段。 */
  readonly sampledPeakRssBytes: number;
  /** 细桶数。 */
  readonly fineCells: number;
  /** 桶归属条数。 */
  readonly members: number;
}

/**
 * 把「库准备」的结果压成相位信息。
 *
 * ⚠️ **峰值口径必须写清**：`peakRssBytes` 是**进程高水位**
 *   （内核维护）⇒ 它**包含灌库阶段的占用** ⇒ 它是「训练期峰值内存」的**上界**。
 *   ⇒ 报告里必须这么写，**不能**说成「纯训练峰值」。
 *
 * @param prepared 库准备结果
 * @returns 相位信息
 */
export function phaseInfo(prepared: {
  loadMs: number;
  trainMs: number;
  rssBeforeTrainBytes: number;
  trainPeakRssBytes: number;
  trainSampledPeakRssBytes: number;
  fineCells: number;
  members: number;
}): PhaseInfo {
  return {
    loadMs: prepared.loadMs,
    trainMs: prepared.trainMs,
    rssBeforeTrainBytes: prepared.rssBeforeTrainBytes,
    peakRssBytes: prepared.trainPeakRssBytes,
    sampledPeakRssBytes: prepared.trainSampledPeakRssBytes,
    fineCells: prepared.fineCells,
    members: prepared.members,
  };
}

/**
 * bench 的**默认工作目录**（仓库根下的 `.tmp/bench/`）。
 *
 * ⚠️ **落在 `.tmp/`**：它已被 `.gitignore` 忽略 ⇒ **大文件（几 GB 的库）不进版本库**。
 */
export function benchWorkDir(): string {
  return join(process.cwd(), '.tmp', 'bench');
}

/**
 * 解析 `--key=value` 形式的命令行参数。
 *
 * ⚠️ **不用 `node:util` 的 `parseArgs`**：它要求**选项必须先声明**
 *   ⇒ 每次加一个开关都要改这里 ⇒ 改两处。自己解析 ⇒ 一次写对、以后不用改。
 *
 * @param argv `process.argv.slice(2)`
 * @returns 解析结果（键 → 值；`--flag` 形式 ⇒ 值为 `'true'`）
 */
export function parseArgs(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      continue;
    }
    const body = argument.slice(2);
    const separator = body.indexOf('=');
    if (separator < 0) {
      result[body] = 'true';
      continue;
    }
    result[body.slice(0, separator)] = body.slice(separator + 1);
  }
  return result;
}

/**
 * 取一个整数参数（带缺省值与**越界即错**）。
 *
 * ⚠️ **越界必须报错而不是静默钳制**：静默钳制 ⇒ 「我以为跑的是 100 万条，
 *   其实跑的是 10 万条」⇒ **报告里的规模就是假的**（本仓库的纪律：绝不把小规模
 *   说成大规模）。⇒ 宁可失败。
 *
 * @param args 解析后的参数
 * @param name 参数名
 * @param fallback 缺省值
 * @returns 整数参数
 */
export function intArg(args: Record<string, string>, name: string, fallback: number): number {
  const raw = args[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`bench 参数 --${name} 必须是正整数，收到 "${raw}"`);
  }
  return parsed;
}

/**
 * 取一个字符串参数（带缺省值）。
 *
 * @param args 解析后的参数
 * @param name 参数名
 * @param fallback 缺省值
 * @returns 字符串参数
 */
export function stringArg(args: Record<string, string>, name: string, fallback: string): string {
  return args[name] ?? fallback;
}

/**
 * 写一个 JSON 文件（**UTF-8 + 缩进 2** ⇒ 可 diff、可人工审）。
 *
 * @param path 目标路径（父目录会自动建）
 * @param value 内容（可 JSON 序列化）
 */
export function writeJsonFile(path: string, value: unknown): void {
  const parent = dirname(path);
  if (parent !== '' && parent !== '.') {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
