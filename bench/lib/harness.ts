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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus as cpus_, freemem, totalmem } from 'node:os';
import { dirname, join, parse as parsePath } from 'node:path';
import { Worker } from 'node:worker_threads';

import type Database from 'better-sqlite3';

import { openDatabase } from '../../src/db/connection.js';
import { ensureSchema } from '../../src/db/migrate.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { vectorToBlob } from '../../src/vector/centroids.js';
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
 * **采样器 worker 的源码**（用 `eval: true` 内联 ⇒ 不依赖任何额外文件）。
 *
 * ⚠️ ★ **为什么必须是 worker 线程**（这是「采样峰值一直采不到」的**根因**）：
 *   Node 的**定时器在主线程的同步长任务期间不会触发** ⇒ 训练（同步、几十秒~几小时）
 *   期间**主线程的 `setInterval` 一次都跑不到** ⇒ 「采样峰值」永远是「训练开始前」的那一次。
 *   ⇒ **worker 线程有自己的事件循环** ⇒ 主线程被同步代码占住时，worker **照样在跑**
 *     ⇒ 而且 `process.memoryUsage.rss()` 报的是**进程级**的 RSS
 *     （不是「线程自己的」）⇒ **worker 量到的就是整个进程的 RSS**。
 *   ⇒ 实测（`D:/Git/wt/p2-final` 的探针）：主线程跑 2 秒同步忙等期间，
 *     主线程的 `setInterval` **一次都没触发**，而 worker 稳定采到了进程 RSS。
 *
 * ⚠️ **为什么用 `SharedArrayBuffer` 而不是「postMessage 回报」**：
 *   主线程在训练期间**不跑事件循环** ⇒ worker 的消息会**堆在队列里**，
 *   直到训练结束才被处理 ⇒ `stop()` 那一刻读到的是**过期值**。
 *   ⇒ `SharedArrayBuffer` + `Atomics` ⇒ worker **直接写共享内存**，
 *     主线程**随时同步读**（不依赖事件循环）⇒ 且 64 位写入是**原子的**（不会读到「半截值」）。
 */
const RSS_SAMPLER_WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const shared = new BigInt64Array(workerData.sharedBuffer);
const intervalMs = workerData.intervalMs;
let peak = 0n;
let count = 0n;
const timer = setInterval(() => {
  const rss = process.memoryUsage.rss();
  count += 1n;
  if (BigInt(rss) > peak) {
    peak = BigInt(rss);
    Atomics.store(shared, 0, peak);
  }
  Atomics.store(shared, 1, count);
}, intervalMs);
parentPort.on('message', (message) => {
  if (message === 'stop') {
    clearInterval(timer);
    Atomics.store(shared, 0, peak);
    Atomics.store(shared, 1, count);
    parentPort.close();
  }
});
`;

/** 共享内存里的槽位下标（`BigInt64Array`）。 */
const SHARED_SLOT_PEAK = 0;
/** 共享内存里的槽位下标：采样次数。 */
const SHARED_SLOT_COUNT = 1;
/** 共享内存的槽位数（8 字节 × 3）。 */
const SHARED_SLOT_COUNT_TOTAL = 3;

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
 * ⚠️ ★ **两个数必须分开报**（P2 收官 · Q-06）：
 *   · **`kernelPeakBytes`** = `process.resourceUsage().maxRSS * 1024`
 *     ⇒ **内核维护的高水位**（永不丢失）⇒ 但它是**进程级**的 ⇒ **含灌库阶段的占用**
 *       ⇒ 它是「训练期峰值内存」的**上界**，**不是**「训练段自己的峰值」。
 *   · **`sampledPeakBytes`** = **采样器独立观察**到的峰值
 *     ⇒ 只覆盖**采样器活着的那一段时间** ⇒ **才是「训练段自己的峰值」**。
 *   ⚠️ **曾经这两个数是同一个**（`peakBytes()` 取了两者的 max）
 *     ⇒ 「采样峰值」其实是高水位 ⇒ **它从来不是一个独立测量值**
 *     ⇒ 而复用旧库时旧清单里没有这个字段 ⇒ `?? 0` ⇒ 落盘成 **`sampledPeakRssBytes: 0`**
 *     ⇒ **看起来像「测到 0」，其实是「没测到」** ⇒ 现在**分开**，且「没测到」用 `null`。
 */
export class PeakRssSampler {
  /** 与 worker 共享的内存（`BigInt64Array` 视图）。 */
  private readonly shared: BigInt64Array;

  /** worker 线程（**采样真正靠它**）。 */
  private worker: Worker | undefined;

  /** worker 是否成功启动（`false` ⇒ 退回了主线程定时器）。 */
  private workerActive = false;

  /** 降级路径的主线程定时器（worker 起不来时用）。 */
  private fallbackTimer: NodeJS.Timeout | undefined;

  /** 降级路径采到的峰值（字节）。 */
  private localPeak = 0;

  /** 采样间隔（毫秒）。 */
  private readonly intervalMs: number;

  /**
   * @param intervalMs 采样间隔（毫秒；默认 50ms）
   */
  constructor(intervalMs = 50) {
    this.intervalMs = intervalMs;
    const buffer = new SharedArrayBuffer(SHARED_SLOT_COUNT_TOTAL * 8);
    this.shared = new BigInt64Array(buffer);
    Atomics.store(this.shared, SHARED_SLOT_PEAK, 0n);
    Atomics.store(this.shared, SHARED_SLOT_COUNT, 0n);
  }

  /** 开始采样。 */
  start(): void {
    this.sampleLocal();
    try {
      this.worker = new Worker(RSS_SAMPLER_WORKER_SOURCE, {
        eval: true,
        workerData: { sharedBuffer: this.shared.buffer, intervalMs: this.intervalMs },
      });
      // ⚠️ **`unref()`**：worker **不阻止进程退出** ⇒ 万一忘了 `stop()` 也不会挂住脚本。
      //   ⇒ 它仍然会**照常运行**（unref 只影响「是否让进程等它」）。
      this.worker.unref();
      this.workerActive = true;
    } catch {
      // ⚠️ **降级**：worker 起不来（受限环境 / 资源不足）⇒ 用主线程定时器。
      //   ⇒ 此时**同步长任务期间采不到** ⇒ `sampleCount()` 会是 0 ⇒ 报告里如实写「没采到」。
      this.worker = undefined;
      this.workerActive = false;
      this.fallbackTimer = setInterval(() => {
        this.sampleLocal();
      }, this.intervalMs);
    }
  }

  /** 停止采样（幂等）。 */
  stop(): void {
    // ⚠️ **先在主线程采一次**：worker 的最后一次采样可能还没发生 ⇒ 用主线程此刻的 RSS 兜底。
    this.sampleLocal();
    if (this.fallbackTimer !== undefined) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    if (this.worker !== undefined) {
      // ⚠️ **不用等 worker 的回信**（主线程此刻拿不到事件循环）⇒ 直接读共享内存。
      this.worker.postMessage('stop');
      void this.worker.terminate();
      this.worker = undefined;
    }
  }

  /** 立即采一次（**主线程自己的 RSS** —— 进程级）。 */
  private sampleLocal(): void {
    const rss = process.memoryUsage().rss;
    if (rss > this.localPeak) {
      this.localPeak = rss;
    }
  }

  /**
   * **采样器独立观察**到的峰值 RSS（字节）。
   *
   * ⚠️ **这是「训练段自己的峰值」**（不含灌库阶段的占用）⇒
   *   与 `kernelPeakBytes()`（进程高水位 = 上界）是**两条不同的数**。
   * ⚠️ **worker 的读数含 worker 自己那点开销**（约 10MB 量级的 isolate + 栈）
   *   ⇒ 它是**进程级**的 RSS ⇒ 略高于「纯主线程」的读数 ⇒ **偏保守（不低报）**。
   */
  sampledPeakBytes(): number {
    const shared = Number(Atomics.load(this.shared, SHARED_SLOT_PEAK));
    return Math.max(shared, this.localPeak);
  }

  /**
   * **内核维护的进程高水位**（字节）—— **上界**（含灌库阶段的占用）。
   *
   * ⚠️ **`maxRSS` 的单位是 KB**（本机 Windows 实测：`maxRSS=71792` ⇒ `×1024` 后
   *   与 `process.memoryUsage().rss` 同量级）⇒ 所以这里要 `× 1024`。
   */
  kernelPeakBytes(): number {
    return process.resourceUsage().maxRSS * 1024;
  }

  /** 采样器实际采样次数（`0` ⇒ **一次都没采到** ⇒ 那个峰值不可信）。 */
  sampleCount(): number {
    return Number(Atomics.load(this.shared, SHARED_SLOT_COUNT));
  }

  /** 采样器是否跑在 **worker 线程**上（`true` ⇒ 能在**同步长任务**期间采样）。 */
  isWorkerActive(): boolean {
    return this.workerActive;
  }

  /**
   * 峰值 RSS（字节）—— **上界**（采样峰值与内核高水位取大）。
   *
   * ⚠️ **取「采样峰值」与「内核高水位」的较大者**：
   *   采样峰值只覆盖「采样器活着的那段」⇒ 可能偏低；
   *   而 `maxRSS` 永远正确（内核高水位）⇒ 两者取大 ⇒ **既不漏报也不虚报**。
   */
  peakBytes(): number {
    return Math.max(this.sampledPeakBytes(), this.kernelPeakBytes());
  }
}

/**
 * **峰值内存的测量口径**（**两个数必须一起报** ⇒ 报告里不许只写一个）。
 */
export interface PeakRssMeasurement {
  /** **内核高水位**（进程级、含灌库阶段）⇒ 「训练期峰值内存」的**上界**（字节）。 */
  readonly kernelPeakBytes: number;
  /**
   * **采样器独立观察**到的峰值（**只覆盖采样器活着的这段时间**）（字节）。
   *
   * ⚠️ **`null` ⇒ 这次运行没采到**（采样器一次都没触发 / 复用了旧清单里没有这个字段）
   *   ⇒ **`null` 与 `0` 是两件事**：`0` 是「测到了 0 字节」（不可能），
   *   `null` 是「**没测到**」⇒ 报告里必须这么写。
   */
  readonly sampledPeakBytes: number | null;
  /** 采样次数（`0` ⇒ 没采到）。 */
  readonly sampleCount: number;
  /** 采样器是否跑在 **worker 线程**上（`true` ⇒ 同步长任务期间也采得到）。 */
  readonly workerActive: boolean;
}

// ═══════════════════════════════ 存储介质（判据的介质解耦落点） ═══════════════════════════════

/**
 * ★ **存储介质类别** —— **绝对毫秒门槛的介质解耦落点**（2026-11-02 架构师裁决）。
 *
 * ⚠️ **为什么必须有它**（裁决原文）：
 *   「**bench 必须把「存储介质类别」与「每行读成本」记进落盘 JSON**
 *   （否则换一块盘，判据的含义会**静默改变**——这正是「文档与数据不一致」的另一种形态）。」
 * ⇒ ⇒ **同一个 H1（2,000 行候选）在 SATA HDD 上是 ~16~28ms、在 NVMe SSD 上是 ~2~5ms**
 *   ⇒ ⇒ **毫秒数必须按介质分档记录，而判据由 H1/H2（纯计数）承担**。
 */
export type StorageMediaClass = 'HDD' | 'SSD' | 'NVMe' | 'unknown';

/**
 * 存储介质的采集结果（**拿不到就是 `unknown`**，**不是**猜一个）。
 */
export interface StorageMediaInfo {
  /** 介质类别（**`unknown` ⇒ 没测到**，不是「测到的是未知」）。 */
  readonly mediaClass: StorageMediaClass;
  /** 采集用的手段（`powershell:Get-PhysicalDisk` / `lsblk` / `diskutil` / `none`）。 */
  readonly source: string;
  /** 采集是否成功（`false` ⇒ `mediaClass` 恒为 `'unknown'`）。 */
  readonly detected: boolean;
  /** 补充信息（型号 / 总线类型 / 原始 `MediaType` 字符串；`null` ⇒ 没有）。 */
  readonly detail: string | null;
}

/**
 * ★ **外部命令的执行器**（**可注入 ⇒ 负控能在「不依赖真实硬件」的前提下测**）。
 *
 * ⚠️ **为什么要抽出来**（本仓库方法论第 2 条：「守卫的判据要抽成可注入的纯函数
 *   ⇒ 负控才能在不污染源码/正文的前提下测它」）：
 *   介质探测是**唯一**会问操作系统的地方 ⇒ 它的失败路径（「命令不存在 / 被策略禁用 /
 *   超时」）**必须能被测**，而**不能**靠「在一台没有 PowerShell 的机器上跑」来测
 *   ⇒ ⇒ **把「怎么执行命令」变成一个参数**，测试就能**注入**一个「必失败」的执行器。
 *
 * @param file 可执行文件名
 * @param args 参数
 * @returns 命令的标准输出
 */
export type CommandRunner = (file: string, args: readonly string[]) => string;

/**
 * 探测的**可注入项**（**缺省 = 真实行为** ⇒ 生产路径一行不改）。
 */
export interface StorageMediaProbeOptions {
  /**
   * 平台（缺省 `process.platform`）。
   *
   * ⚠️ **为什么可注入**：三条平台分支（PowerShell / `lsblk` / `diskutil`）
   *   **必须在任意一台机器上都能被测**（否则 Windows 上的 CI 永远测不到 Linux 分支）
   *   ⇒ ⇒ 注入平台 ⇒ **三条分支都能被测**。
   */
  readonly platform?: NodeJS.Platform;
  /**
   * 命令执行器（缺省 `execFileSync`）。
   *
   * ⚠️ **注入一个「必失败」的执行器 ⇒ 就能测「拿不到 ⇒ 记 `unknown` 且绝不抛错」**
   *   这条**最关键的纪律**（bench 必须能在任何机器上跑）。
   */
  readonly runner?: CommandRunner;
}

/**
 * 采集**存储介质类别**（**失败 ⇒ `unknown`；绝不抛错**）。
 *
 * ⚠️ ★ **「拿不到就记 `unknown`」是硬要求**：
 *   bench 必须能在**任何机器**上跑（CI 容器 / Linux / macOS / 没有 PowerShell 的 Windows）
 *   ⇒ **介质探测失败绝不能让整轮测量失败** ⇒ 所有异常都被吞掉并降级成 `'unknown'`。
 *
 * ⚠️ **Windows 走 PowerShell**（`Get-Partition → Get-Disk → Get-PhysicalDisk` 的 `MediaType`）：
 *   Node **没有**直接给介质类型的 API ⇒ 只能问操作系统。
 *   ⇒ ⚠️ **有超时**（默认 5 秒）⇒ 机器上 PowerShell 被策略禁用时**不会**把 bench 拖死。
 *
 * @param targetPath 要判定的路径（缺省 = 工作目录 ⇒ bench 的库都落在工作目录下的同一卷）
 * @param options 可注入项（**缺省 = 真实行为**）
 * @returns 介质信息（**永不抛错**）
 */
export function detectStorageMedia(
  targetPath: string = process.cwd(),
  options: StorageMediaProbeOptions = {},
): StorageMediaInfo {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultCommandRunner;
  if (platform === 'win32') {
    return detectWindowsMedia(targetPath, runner);
  }
  if (platform === 'linux') {
    return detectLinuxMedia(targetPath, runner);
  }
  if (platform === 'darwin') {
    return detectDarwinMedia(targetPath, runner);
  }
  return { mediaClass: 'unknown', source: 'none', detected: false, detail: null };
}

/** 默认的命令执行器（**真实行为**）：`execFileSync` + 5 秒超时 + 隐藏窗口。 */
const defaultCommandRunner: CommandRunner = (file, args) =>
  execFileSync(file, [...args], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });

/** Windows 的介质探测（PowerShell）；失败 ⇒ `'unknown'`。 */
function detectWindowsMedia(targetPath: string, runner: CommandRunner): StorageMediaInfo {
  const root = parsePath(targetPath).root;
  const driveLetter = root.replace(/[:\\/]/g, '').toUpperCase();
  if (driveLetter === '') {
    return { mediaClass: 'unknown', source: 'none', detected: false, detail: null };
  }
  // ⚠️ **一条命令问完整条链**（分区 → 物理盘 → 物理盘的介质类型）。
  //   ⚠️ 逐条问会更慢（每次 spawn 一次 PowerShell ≈ 0.5~1.5 秒）。
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$p = Get-Partition -DriveLetter ${driveLetter}`,
    'if ($p) {',
    '  $d = $p | Get-Disk',
    '  $pd = $d | Get-PhysicalDisk',
    `  Write-Output ('MediaType=' + $pd.MediaType)`,
    `  Write-Output ('BusType=' + $d.BusType)`,
    `  Write-Output ('FriendlyName=' + $pd.FriendlyName)`,
    `} else { Write-Output 'MediaType=' }`,
  ].join('; ');
  try {
    const output = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const mediaType = readField(output, 'MediaType');
    const busType = readField(output, 'BusType');
    const friendlyName = readField(output, 'FriendlyName');
    if (mediaType === null || mediaType === '') {
      return {
        mediaClass: 'unknown',
        source: 'powershell:Get-PhysicalDisk',
        detected: false,
        detail: null,
      };
    }
    return {
      mediaClass: classifyMediaType(mediaType, busType),
      source: 'powershell:Get-PhysicalDisk',
      detected: true,
      detail: [mediaType, busType, friendlyName]
        .filter((part) => part !== null && part !== '')
        .join(' | '),
    };
  } catch {
    // ⚠️ **拿不到就记 `unknown`**（PowerShell 被禁用 / 超时 / 命令不存在）。
    return {
      mediaClass: 'unknown',
      source: 'powershell:Get-PhysicalDisk',
      detected: false,
      detail: null,
    };
  }
}

/** Linux 的介质探测（`findmnt` + `lsblk`）；失败 ⇒ `'unknown'`。 */
function detectLinuxMedia(targetPath: string, runner: CommandRunner): StorageMediaInfo {
  try {
    const device = runner('findmnt', ['-no', 'SOURCE', '--target', targetPath]).trim();
    if (device === '') {
      return { mediaClass: 'unknown', source: 'lsblk', detected: false, detail: null };
    }
    // ⚠️ **`rota` = 1 ⇒ 机械盘（HDD）；`rota` = 0 ⇒ 固态（SSD 或 NVMe）**。
    //   ⇒ SSD 与 NVMe 的区分靠 `tran`（传输类型）。
    const rota = runner('lsblk', ['-ndo', 'rota', device]).trim();
    const tran = runner('lsblk', ['-ndo', 'tran', device]).trim();
    if (rota === '') {
      return { mediaClass: 'unknown', source: 'lsblk', detected: false, detail: null };
    }
    const mediaClass: StorageMediaClass = tran.toLowerCase().includes('nvme')
      ? 'NVMe'
      : rota === '1'
        ? 'HDD'
        : 'SSD';
    return {
      mediaClass,
      source: 'lsblk',
      detected: true,
      detail: `device=${device} rota=${rota} tran=${tran}`,
    };
  } catch {
    return { mediaClass: 'unknown', source: 'lsblk', detected: false, detail: null };
  }
}

/** macOS 的介质探测（`diskutil info`）；失败 ⇒ `'unknown'`。 */
function detectDarwinMedia(targetPath: string, runner: CommandRunner): StorageMediaInfo {
  try {
    const output = runner('diskutil', ['info', targetPath]);
    const lower = output.toLowerCase();
    // ⚠️ **`diskutil info` 的措辞**：「Solid State」⇒ SSD；「Rotational」⇒ HDD；「NVMe」⇒ NVMe。
    const mediaClass: StorageMediaClass = lower.includes('nvme')
      ? 'NVMe'
      : lower.includes('solid state')
        ? 'SSD'
        : lower.includes('rotational')
          ? 'HDD'
          : 'unknown';
    if (mediaClass === 'unknown') {
      return { mediaClass: 'unknown', source: 'diskutil', detected: false, detail: null };
    }
    return {
      mediaClass,
      source: 'diskutil',
      detected: true,
      detail: `path=${targetPath}`,
    };
  } catch {
    return { mediaClass: 'unknown', source: 'diskutil', detected: false, detail: null };
  }
}

/**
 * 从命令输出里读一个 `Key=Value` 字段（**读不到 ⇒ `null`**）。
 *
 * @param output 命令输出
 * @param key 字段名
 * @returns 字段值（`null` ⇒ 没有这个字段）
 */
function readField(output: string, key: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const prefix = `${key}=`;
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

/**
 * 把操作系统给的**原始介质字符串**归到三个类别里。
 *
 * ⚠️ **Windows 的 `MediaType` 取值**：`HDD` / `SSD` / `NVMe` / `Unspecified`。
 *   `Unspecified` ⇒ **不能猜** ⇒ 归 `'unknown'`（宁可不知道，也不要给一个假的类别）。
 *
 * @param mediaType 原始介质字符串
 * @param busType 总线类型（**辅助**：SATA 上的 NVMe 盘有时 `MediaType` 报 `Unspecified`）
 * @returns 介质类别
 */
function classifyMediaType(mediaType: string, busType: string | null): StorageMediaClass {
  const media = mediaType.toLowerCase();
  if (media.includes('nvme')) {
    return 'NVMe';
  }
  if (media === 'hdd' || media.includes('hard disk')) {
    return 'HDD';
  }
  if (media === 'ssd' || media.includes('solid state')) {
    return 'SSD';
  }
  // ⚠️ **`MediaType` 说不清、但总线说得清** ⇒ 用总线兜底（NVMe 总线 ⇒ NVMe）。
  const bus = (busType ?? '').toLowerCase();
  if (bus.includes('nvme')) {
    return 'NVMe';
  }
  return 'unknown';
}

// ═══════════════════════════════ 页缓存状态（判据的运行档位标注） ═══════════════════════════════

/**
 * ★ **页缓存状态**（**冷 / 热 / 未知**）—— **判据的运行档位标注**。
 *
 * ⚠️ ★ **为什么必须有它（且只能是「可标注」而不是「可测量」）**：
 *   **Windows 没有公开 API 能告诉你「这个库有多少在页缓存里」**
 *   （Linux 可以读 `/proc/meminfo` 的 `Cached`，但那也不是「这个库」的那一部分）
 *   ⇒ ⇒ **页缓存状态无法直接测量** ⇒ ⇒ **只能由跑的人声明**
 *   ⇒ ⇒ ⚠️ **缺省必须是 `unknown`**（**不许猜**）——
 *   与 `detectStorageMedia()` 同一纪律：**拿不到就记 `unknown`，绝不假装测到了**。
 *
 * ⚠️ ★ **为什么它必须机器可读**（而不是只写在报告的人话里）：
 *   冷 / 热两档的毫秒数**差 21.6 倍** ⇒ 现在这个区分**只靠人记**
 *   ⇒ ⇒ **让机器能读出来** ⇒ 以后每次采集都自带这个标注
 *   ⇒ ⇒ **换一块盘 / 换一个缓存状态 ⇒ 毫秒数的含义会静默改变** ⇒ 必须落进 JSON。
 */
export type PageCacheState = 'cold' | 'warm' | 'unknown';

/**
 * 页缓存状态的采集结果（**由跑的人声明** ⇒ 不是仪器测量值）。
 */
export interface PageCacheStateInfo {
  /** 状态（**`unknown` ⇒ 没声明 / 不可知**，不是「测到了未知」）。 */
  readonly state: PageCacheState;
  /** 声明来源（`cli:--cache-state` / `none`）。 */
  readonly source: string;
  /** 是否由**跑的人显式声明**（`false` ⇒ 缺省 `unknown` ⇒ **不许猜**）。 */
  readonly declared: boolean;
  /** 说明（**必须落盘** ⇒ 读的人不会把「声明」误读成「测量」）。 */
  readonly note: string;
}

/**
 * ★ **页缓存档位的「判档对照」（落进 `note` ⇒ 声明不再纯主观）。
 *
 * ⚠️ ★ **它不是仪器**（页缓存状态本身**无法直接测量** ⇒ 仍然**由跑的人声明**）
 *   ⇒ ⇒ **本段只是给出「怎么判断自己该声明哪一档」的可复算旁证**
 *   ⇒ ⇒ **不改变「缺省 unknown、不许猜」这条纪律**。
 *
 * ⚠️ ★ **旁证的来源**（工程师-7 在 2026-11-01 23:43 的补测里实测）：
 *   **顺序读吞吐 ≈ 166 MB/s**（≈ **机械盘速度** ⇒ SATA HDD 的量级）
 *   ⇒ ⇒ 页缓存只命中了 **~0.55 GB**（4.23 GiB 的库**装不下**）
 *   ⇒ ⇒ ⇒ **随机读路径基本没命中缓存** ⇒ ⇒ **这就是「冷盘档」的物理含义**。
 *
 * ⚠️ **换机器必须用自己的盘速重算这个对照**（⇒ 本段带机器相关性）。
 */
const PAGE_CACHE_STATE_CROSS_CHECK =
  '⚠️ **判档的可复算旁证（不是仪器）**：**先测一下顺序读吞吐** ⇒ ' +
  '⚠️ 本机 2026-11-01 冷盘档实测 ≈ **166 MB/s**（≈ 机械盘速度）' +
  '⇒ 页缓存只命中 **~0.55 GB**（4.23 GiB 的库装不下）⇒ ⇒ **随机读路径基本没命中缓存**' +
  '⇒ ⇒ **「顺序读吞吐接近本机盘速」⇒ 多半是冷盘档**' +
  '（⚠️ 本机是 SATA HDD ⇒ **换机器请用自己的盘速重算这个对照**）。';

/**
 * 解析 `--cache-state` 参数（**缺省 `unknown`**；**非法值 ⇒ 报错**，不静默钳制）。
 *
 * ⚠️ **为什么非法值必须报错**（同 `intArg()` 的纪律）：
 *   静默钳制 ⇒ 「我以为我采的是冷盘档、其实跑的是热盘档」⇒ **毫秒数的档位就是假的**
 *   ⇒ ⇒ **宁可失败**。
 *
 * ⚠️ **「`warm`」这一档的定义**（**写死在这里 ⇒ 报告与断言同源**）：
 *   **库文件本体已在 OS 页缓存中**（⇒ 候选行读基本不落盘）
 *   ⇒ 对照「`cold`」= **库文件本体不在 OS 页缓存中**（⇒ 每次候选行读都是真实随机读）。
 *
 * @param raw `--cache-state=` 的原始值（`undefined` ⇒ 没给这个参数）
 * @returns 页缓存状态信息
 * @throws {Error} 值不在 `cold` / `warm` / `unknown` 三个里
 */
export function parsePageCacheState(raw: string | undefined): PageCacheStateInfo {
  if (raw === undefined) {
    return {
      state: 'unknown',
      source: 'none',
      declared: false,
      note:
        '⚠ **没声明**（缺省 `unknown` ⇒ **不许猜** —— 与介质探测同一纪律）' +
        '⇒ 页缓存状态**不可知** ⇒ ' +
        '⚠️ **毫秒数不可跨次比较**（⇒ 但 H1 / H2 的行数判据不受影响）' +
        '（⇒ **想让它变成可判的**：用 `--cache-state=cold|warm` 声明，并参照「判档的可复算旁证」自证）。',
    };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized !== 'cold' && normalized !== 'warm' && normalized !== 'unknown') {
    throw new Error(
      `bench 参数 --cache-state 只能是 cold / warm / unknown，收到 "${raw}"` +
        '（⚠️ 非法值必须报错而不是静默钳制 ⇒ 否则「档位」是假的）',
    );
  }
  if (normalized === 'unknown') {
    return {
      state: 'unknown',
      source: 'cli:--cache-state',
      declared: true,
      note:
        '⚠ **显式声明为 `unknown`** ⇒ 页缓存状态**不可知** ⇒ ' +
        '⚠️ **毫秒数不可跨次比较**（⇒ 但 H1 / H2 的行数判据不受影响）' +
        '（⇒ **想让它变成可判的**：改用 `--cache-state=cold|warm` 声明，并参照「判档的可复算旁证」自证）。',
    };
  }
  return {
    state: normalized,
    source: 'cli:--cache-state',
    declared: true,
    note:
      '⚠ **由跑的人声明**（不是仪器测量值 —— Windows 没有公开 API 能报「这个库有多少在页缓存里」）' +
      '⇒ 本档的毫秒数**只能与同档比较**。' +
      PAGE_CACHE_STATE_CROSS_CHECK,
  };
}

// ═══════════════════════════════ 行读计数（H1 的「实测口径」取数装置） ═══════════════════════════════

/**
 * ★ **行读计数器的快照**（**累计值**；两次快照相减 = 那段窗口里读的行数）。
 */
export interface RowReadSnapshot {
  /**
   * **候选行读数**（`memories` 表**实际物化**的行数）—— **H1 的判据量**。
   *
   * ⚠️ **口径**：与**写入路径**那个「候选 ≤ 2000」（§4.9 步骤 3a2 的扫描量）**同一口径**
   *   （都是「候选行」⇒ **同一个库、同一个量、同一个被考核方**）。
   */
  readonly candidateRows: number;
  /**
   * **桶成员行读数**（`vector_cell_members` 表**实际物化**的行数）—— **附加信息**，不判 H1。
   */
  readonly bucketMemberRows: number;
}

/**
 * ★ **行读计数器**（装在库句柄上；**只读观测，不改 `src/**`**）。
 */
export interface RowReadCounter {
  /** 开始计数（幂等）。 */
  start(): void;
  /** 停止计数（幂等）。 */
  stop(): void;
  /** 取**累计**快照（两次快照相减 = 窗口内读的行数）。 */
  snapshot(): RowReadSnapshot;
  /** 拆掉计数器（把 `db.prepare` 恢复原状）。 */
  uninstall(): void;
}

/**
 * ★ **行读计数器的选项**（**仅测试用的注入点**）。
 */
export interface RowReadCounterOptions {
  /**
   * ★ **仅测试用**：**装了计数器但不计数**（⇒ 实测值恒为 0）。
   *
   * ⚠️ ★ **为什么需要它**（门禁必须有「牙」）：
   *   「**计数器失效 ⇒ 兜底必须把 `mode` 标成 `derived`**」这条纪律
   *   ⇒ **单靠「实测 == 推算」的恒等式断言是抓不到它的**
   *   （⇒ 那个恒等式在当前实现下天然成立 ⇒ **对「口径被换掉」这类变异天然失明**）
   *   ⇒ ⇒ **必须有一个能制造「计数器抓不到」的注入点** ⇒ **本选项就是它**。
   *
   * ⚠️ **生产路径不传这个选项** ⇒ **零影响**（默认值 `false` ⇒ 计数照常）。
   */
  readonly forceDisabled?: boolean;
}

/**
 * ★ **给库句柄装一个行读计数器**（**H1 的「实测口径」的取数装置**）。
 *
 * ⚠️ ★ **为什么需要它**（2026-11-02 架构师裁决的落地）：
 *   「H1 的口径从『命中桶成员数之和（**推算**）』改成『**实际读取的行数（实测）**』
 *   ⇒ 对任何实现都成立（**不再模型化任何实现假设**）。」
 * ⇒ **推算口径模型化了「桶内全量精确点积、桶内不设 LIMIT」这个实现**（§4.15.3）
 * ⇒ ⇒ **阶段 4 一旦引入「桶内 LIMIT」或「两段式读（先读低维 sketch 再读全量）」**
 *   ⇒ **真实读的行数会降、推算值却不会降** ⇒ ⇒ **会出现「实现降了、判据却还红」的假红**。
 *
 * ⚠️ ★ **怎么在不改 `src/**` 的前提下拿到「实际读了多少行」**：
 *   本函数在 **bench 侧**替换库句柄的 `prepare` ⇒ 对**生产 SQL 实际物化出来的行**计数
 *   ⇒ **测的是生产代码真正跑的那条 SQL**（**不是** bench 自己抄一份）
 *   ⇒ ⇒ **对任何实现都成立**（桶内 LIMIT / 两段式读 ⇒ 物化的行数变少 ⇒ 这个数自动跟着降）。
 *
 * ⚠️ ★ **为什么按 SQL 分类**（口径必须写死）：
 *   · `memories` ⇒ **候选行**（= H1 的判据量）；
 *   · `vector_cell_members` ⇒ **桶成员行**（路由侧的行读；**附加信息**，不判 H1）。
 *   ⇒ ⇒ ⚠️ **聚合查询不算行读**（`COUNT(*)` 之类 ⇒ 它读的是索引，**不是候选行**）。
 *
 * ⚠️ **纪律**：
 *   · **计数只在 `start()` ~ `stop()` 之间累积**（⇒ 采集窗口可控）；
 *   · **计数器的开销必须可忽略**（一次 Proxy + 一次 `rows.length` ⇒ 相对毫秒级耗时可忽略）；
 *   · ⚠️ **本模块只提供「装置」** ⇒ **拿不到实测值时 bench 必须退回推算口径并显式标注**
 *       （**不许假装它是实测**）。
 *
 * @param db 库句柄（**会被就地改造** ⇒ 用完请 `uninstall()`）
 * @param options 选项（**仅测试用的注入点** ⇒ 生产路径不传）
 * @returns 计数器句柄
 */
export function installRowReadCounter(
  db: Database.Database,
  options: RowReadCounterOptions = {},
): RowReadCounter {
  type ReadKind = 'candidate' | 'bucketMember';
  const counters: Record<ReadKind, number> = { candidate: 0, bucketMember: 0 };
  let counting = false;
  // ⚠️ **「装了但不计数」**（**仅测试用的注入点**）⇒ 实测值恒为 0
  //   ⇒ ⇒ 用来验证「计数器失效 ⇒ 兜底把 `mode` 标成 `derived`」这条纪律。
  const forceDisabled = options.forceDisabled === true;

  const handle = db as unknown as { prepare: (source: string) => unknown };
  // ⚠️ **存「原函数对象」而不是它的 bind 产物** ⇒ `uninstall()` 能**逐位**还原
  //   （⇒ bench 不许给生产句柄留任何残桩 ⇒ 可被逐字核对）。
  const originalPrepare = handle.prepare;

  handle.prepare = (source: string): unknown => {
    const statement = originalPrepare.call(db, source);
    const kind = classifyReadKind(source);
    // ⚠️ **不是候选行 / 桶成员行的 SQL ⇒ 原样返回**（不包装 ⇒ 零开销）。
    if (kind === null) {
      return statement;
    }
    return wrapStatement(statement, kind);
  };

  function wrapStatement(statement: unknown, kind: ReadKind): unknown {
    const target = statement as {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      iterate: (...args: unknown[]) => IterableIterator<unknown>;
    };
    return new Proxy(target, {
      get(inner, property) {
        if (property === 'all') {
          return (...args: unknown[]): unknown[] => {
            const rows = target.all(...args);
            if (counting) {
              counters[kind] += rows.length;
            }
            return rows;
          };
        }
        if (property === 'get') {
          return (...args: unknown[]): unknown => {
            const row = target.get(...args);
            if (counting && row !== undefined) {
              counters[kind] += 1;
            }
            return row;
          };
        }
        if (property === 'iterate') {
          return (...args: unknown[]): IterableIterator<unknown> => {
            const iterator = target.iterate(...args);
            return (function* counted(): Generator<unknown> {
              for (const row of iterator) {
                if (counting) {
                  counters[kind] += 1;
                }
                yield row;
              }
            })();
          };
        }
        // ⚠️ **其余属性原样透传**（且函数**绑到真语句**上 ⇒ native 方法的 `this` 正确）。
        const value = Reflect.get(inner, property) as unknown;
        return typeof value === 'function' ? value.bind(inner) : value;
      },
    });
  }

  return {
    start(): void {
      // ⚠️ **「装了但不计数」的注入点** ⇒ `start()` 不生效（实测值恒为 0）。
      if (!forceDisabled) {
        counting = true;
      }
    },
    stop(): void {
      counting = false;
    },
    snapshot(): RowReadSnapshot {
      return { candidateRows: counters.candidate, bucketMemberRows: counters.bucketMember };
    },
    uninstall(): void {
      counting = false;
      handle.prepare = originalPrepare;
    },
  };
}

/**
 * 把一条 SQL 归到「候选行 / 桶成员行 / 不计」三类。
 *
 * ⚠️ **口径**：
 *   · `FROM memories` / `JOIN memories` ⇒ **候选行**（写入路径那条 JOIN 也归这一类
 *     ⇒ 因为它的**结果集**就是候选行）；
 *   · `FROM vector_cell_members` / `JOIN vector_cell_members` ⇒ **桶成员行**；
 *   · **聚合查询**（`COUNT(` / `SUM(` / `AVG(` …）⇒ **不计**（它读的是索引，不是行）。
 *
 * @param sql SQL 文本
 * @returns 分类（`null` ⇒ 不计）
 */
function classifyReadKind(sql: string): 'candidate' | 'bucketMember' | null {
  if (/\b(?:COUNT|SUM|AVG|TOTAL)\s*\(/i.test(sql)) {
    return null;
  }
  if (/\b(?:FROM|JOIN)\s+memories\b/i.test(sql)) {
    return 'candidate';
  }
  if (/\b(?:FROM|JOIN)\s+vector_cell_members\b/i.test(sql)) {
    return 'bucketMember';
  }
  return null;
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

// ═══════════════════════════════ 落盘（结果与报告） ═══════════════════════════════

/**
 * **机器环境**（**基线必须记录在案的机器上采** ⇒ 报告里必须带这一段）。
 *
 * ⚠️ **为什么必须记**：P99 是「**这份数据 + 这台机器**」的结论
 *   ⇒ 换一台机器数字就变 ⇒ 没有机器信息的 P99 **不可复现、不可比较**。
 *
 * ⚠️ ★ **磁盘也要记**（2026-11-01 补）：百万级的库本体 **~4.4GB**（100 万行 × 3KB BLOB）
 *   ⇒ 「这台机器的磁盘装不装得下 / 还剩多少空间」**直接决定这个规模跑不跑得动**
 *   ⇒ 与「可用内存」是同一类**资源约束** ⇒ 必须进机器信息。
 *   ⚠️ **口径**：`totalDiskBytes` = 文件系统**总量**（硬件属性 ⇒ 属「可比性标识」）、
 *   `freeDiskBytes` = 采集时刻的**可用量**（**瞬时快照** ⇒ 同 `freeMemoryBytes`，
 *   **不能**当机器指纹用）。
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
  /**
   * 工作目录所在文件系统的**总量**（字节）。
   *
   * ⚠️ **硬件属性** ⇒ 与 `totalMemoryBytes` 同类 ⇒ **属「可比性标识」**
   *   （两台机器的这个数相同 ⇒ 磁盘规模相同 ⇒ P99 可比）。
   */
  readonly totalDiskBytes: number;
  /**
   * 采集时刻工作目录所在文件系统的**可用量**（字节）。
   *
   * ⚠️ **瞬时快照**（同 `freeMemoryBytes`）⇒ **不能**当机器指纹用。
   */
  readonly freeDiskBytes: number;
  /**
   * ★ **存储介质类别**（HDD / SSD / NVMe / `unknown`）。
   *
   * ⚠️ **它是「判据的介质解耦落点」**（2026-11-02 架构师裁决）：
   *   同一个 H1（候选读取行数 ≤ 2,000）在 SATA HDD 上是 ~16~28ms、在 NVMe 上是 ~2~5ms
   *   ⇒ **毫秒数必须按介质分档读** ⇒ **落盘 JSON 必须带上它**
   *   ⇒ 否则「换一块盘，判据的含义会静默改变」。
   * ⚠️ **`unknown` ⇒ 没测到**（不是「测到了未知」）⇒ 报告里要这么读。
   */
  readonly storageMedia: StorageMediaInfo;
}

/**
 * 取工作目录所在文件系统的容量（字节）。
 *
 * ⚠️ **为什么用 `statfsSync`**：Node 自带（`node:fs`）⇒ **不引第三方依赖**
 *   ⇒ 与 bench「只有 better-sqlite3 一个依赖」的纪律一致。
 * ⚠️ **为什么取 `cwd` 而不是库文件路径**：`machineInfo()` 不带库路径
 *   ⇒ 而 bench 的库一律落在工作目录（`.tmp/bench/`）下 ⇒ **同一个卷** ⇒ 取 `cwd` 即可。
 * ⚠️ **拿不到就报 0，不抛错**：机器信息是**记录**用的 ⇒ 取不到不该让整轮测量失败
 *   ⇒ 但 **0 是「没测到」**（不是「磁盘为 0」）⇒ 报告里要这么读。
 *
 * @returns 磁盘总量与可用量（字节）
 */
function diskInfo(): { totalDiskBytes: number; freeDiskBytes: number } {
  try {
    const stats = statfsSync(process.cwd());
    return {
      totalDiskBytes: Number(stats.blocks) * Number(stats.bsize),
      freeDiskBytes: Number(stats.bavail) * Number(stats.bsize),
    };
  } catch {
    return { totalDiskBytes: 0, freeDiskBytes: 0 };
  }
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
  const disk = diskInfo();
  return {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes,
    freeMemoryBytes,
    usedMemoryBytes: totalMemoryBytes - freeMemoryBytes,
    totalDiskBytes: disk.totalDiskBytes,
    freeDiskBytes: disk.freeDiskBytes,
    // ⚠️ **介质探测失败不抛错**（`detectStorageMedia` 内部全吞）⇒ 这一行不会让 bench 挂掉。
    storageMedia: detectStorageMedia(),
  };
}

/**
 * 把**峰值内存的测量口径**排成一行人话（**报告与控制台输出共用这一份**）。
 *
 * ⚠️ **两个数必须都在**（否则读者会把「上界」当成「训练段自己的峰值」）：
 *   · **进程高水位** = 上界（含灌库阶段）；
 *   · **采样峰值** = 训练段自己的峰值（`null` ⇒ **没测到**，**不许**写成 0）。
 *
 * @param measurement 测量口径
 * @returns 一行说明
 */
export function formatPeakRss(measurement: PeakRssMeasurement): string {
  const kernelMb = (measurement.kernelPeakBytes / 1024 / 1024).toFixed(0);
  const sampled =
    measurement.sampledPeakBytes === null
      ? '**未采到**'
      : `${(measurement.sampledPeakBytes / 1024 / 1024).toFixed(0)}MB`;
  const worker = measurement.workerActive ? '，worker 线程' : '';
  return (
    `峰值 RSS：进程高水位 ${kernelMb}MB（上界，含灌库阶段）/ ` +
    `采样峰值 ${sampled}（仅训练段，采样 ${measurement.sampleCount} 次${worker}）`
  );
}

/**
 * 把「灌库耗时」排成一行人话（**`null` ⇒ 「未测到」**，**不许**写成 `0`）。
 *
 * ⚠️ **为什么单独一个函数**：三个 bench 脚本都要打这一行
 *   ⇒ 抄三份必然漂 ⇒ 漂了就会有一处把 `null` 打成 `0` ⇒ **假数进报告**。
 *
 * @param loadMs 灌库耗时（`null` ⇒ 没测到）
 * @returns 一行说明
 */
export function formatLoadMs(loadMs: number | null): string {
  return loadMs === null ? '**未测到**' : `${loadMs.toFixed(0)}ms`;
}

/**
 * 训练阶段的**相位信息**（**报告里必须带** ⇒ 规模与耗时可核对）。
 */
export interface PhaseInfo {
  /**
   * 灌库耗时（毫秒）。
   *
   * ⚠️ ★ **`null` ⇒ 这次运行没测到**（**不是 `0`**）：
   *   复用一份「别人已经灌好」的库时 ⇒ 灌库发生在**别的进程**下 ⇒ 本次**没测到**
   *   ⇒ 记 `0` 会被读成「灌库耗时 0 毫秒」（假）⇒ 与 `sampledPeakRssBytes` 同一纪律。
   */
  readonly loadMs: number | null;
  /** 训练耗时（毫秒）。 */
  readonly trainMs: number;
  /**
   * 训练第一段（「**读向量 + 建中心**」）的耗时（毫秒）。
   *
   * ⚠️ ★ **`null` ⇒ 这次运行没测到 / 拆不开**（**不是 `0`**）：
   *   · **自己灌库 + 训练**的路径（`prepareBench` 的非复用分支）**不拆段**
   *     ⇒ 这里一定是 `null`（**不是 0** ⇒ 0 会被读成「这段 0 毫秒」（假））；
   *   · **复用**一份「别人训好的库」时 ⇒ 取决于那份清单有没有记这两段。
   * ⇒ **为什么要拆**（2026-11-01 实测）：百万级的训练**一次跑完会被环境的后台进程时限掐掉**
   *   ⇒ 实测拆成「建中心段 ~98 分钟」+「迁移段 ~36 分钟」两段跑
   *   ⇒ ⇒ **两段都要能单独读出来**（否则 `trainMs` 是个说不清来源的和）。
   */
  readonly trainReadAndKmeansMs: number | null;
  /**
   * 训练第二段（「**迁移 100 万条归属**」）的耗时（毫秒）。
   *
   * ⚠️ **`null` ⇒ 没测到 / 拆不开**（同 `trainReadAndKmeansMs` 的纪律）。
   */
  readonly trainMigrateMs: number | null;
  /**
   * 训练**前**的 RSS（字节）。
   *
   * ⚠️ ★ **`null` ⇒ 这次运行没测到**（**不是 `0`**）：
   *   「峰值 − 训练前」= 训练自身的增量 ⇒ 训练前没测到 ⇒ **增量也测不到**
   *   ⇒ 记 `0` ⇒ 增量会被算成「峰值 − 0 = 峰值」⇒ **把上界当成增量** ⇒ 偏大。
   */
  readonly rssBeforeTrainBytes: number | null;
  /**
   * 训练期峰值 RSS 的**上界**（字节）—— **进程高水位**（含灌库阶段的占用）。
   *
   * ⚠️ **口径**：它是**进程级**的 ⇒ 不是「纯训练峰值」⇒ 报告里必须这么写。
   */
  readonly peakRssBytes: number;
  /**
   * 训练段**采样**到的峰值 RSS（字节）—— **只覆盖采样器活着的这段时间**。
   *
   * ⚠️ **`null` ⇒ 这次运行没采到**（复用了旧清单 / 采样器没触发）
   *   ⇒ **`null` ≠ `0`**：`0` 是「测到了 0 字节」（不可能），`null` 是「**没测到**」。
   */
  readonly sampledPeakRssBytes: number | null;
  /** 峰值内存的**完整测量口径**（两个数 + 采样次数 + 是否 worker）。 */
  readonly peakRss: PeakRssMeasurement;
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
 *   ⇒ 而 `sampledPeakRssBytes` 才是**采样器独立观察**到的值（**训练段自己的峰值**）。
 *
 * @param prepared 库准备结果
 * @returns 相位信息
 */
export function phaseInfo(prepared: {
  loadMs: number | null;
  trainMs: number;
  trainReadAndKmeansMs: number | null;
  trainMigrateMs: number | null;
  rssBeforeTrainBytes: number | null;
  trainPeakRss: PeakRssMeasurement;
  fineCells: number;
  members: number;
}): PhaseInfo {
  const sampled = prepared.trainPeakRss.sampledPeakBytes;
  return {
    loadMs: prepared.loadMs,
    trainMs: prepared.trainMs,
    trainReadAndKmeansMs: prepared.trainReadAndKmeansMs,
    trainMigrateMs: prepared.trainMigrateMs,
    rssBeforeTrainBytes: prepared.rssBeforeTrainBytes,
    peakRssBytes: Math.max(prepared.trainPeakRss.kernelPeakBytes, sampled ?? 0),
    sampledPeakRssBytes: sampled,
    peakRss: prepared.trainPeakRss,
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
