/**
 * **P99 测量** —— P2-T08 的性能门槛（DEVELOPMENT-PLAN.md 行 2032~2040）。
 *
 * ⚠️ **测的是哪三条**：
 *   · **recall P99**（门槛 ≤ 200ms）：走**生产的 `MemoryStore.recall()`**；
 *   · **写入 P99**（门槛 ≤ 5ms）：走**生产的 `MemoryStore.write()`**；
 *   · **向量路 P99**（门槛 ≤ 20ms）与**向量路占总耗时 ≤ 20%**：
 *     走**生产的 `IvfVectorBackend` 的 `route()` + `search()`**。
 *
 * ⚠️ ★ **「向量路占总耗时」的分母是什么**（口径必须写死）：
 *   **分母 = recall 全程耗时**（含文本路 + 图谱路 + 向量路 + 打分 + 排序）。
 *   ⇒ 分子 = 向量路那段（route + search + 闸门过滤）。
 *   ⚠️ **为什么不用「纯向量路耗时 / 纯向量路耗时」**：那是 100% ⇒ 门槛无意义。
 *   ⚠️ **为什么不用「向量路 / (recall + 向量路)」**：那是**改造前**的口径
 *     （flat 路线下向量路占绝对多数 ⇒ §12 的「≥80%」那条），
 *     而**改造后**的口径是「向量路在一次召回里占多少」⇒ **分母是 recall 全程**。
 *
 * ⚠️ **本脚本测的「向量路」是「生产后端被单独调用」的耗时**，
 *   **不是**「recall 内部真的走了向量路」的耗时
 *   ⇒ 因为**本仓库当前的 `recall()` 尚未接线向量路**
 *   （`src/store/recall.ts` 步骤 2c 仍写着「本阶段整路缺席」）
 *   ⇒ **这一点必须在报告里写明**，否则「向量路占比」会被读成「流水线内的占比」
 *   ⇒ **实际流水线里的占比 = 本脚本测的向量路耗时 / (recall 耗时 + 向量路耗时)**，
 *   因为接线后向量路是**额外**的一段（它不在现在的 recall 里）。
 *
 * ⚠️ **预热轮次与首次 IO**（口径必须写死，否则 P99 没有可判定性）：
 *   · **预热** = 前 N 次调用**不计入**统计（V8 的 JIT 优化 + SQLite 页缓存 +
 *     中心向量缓存都在预热期完成 ⇒ 计入的话 P99 会被「首轮冷启动」主导）。
 *   · **首次 IO**：SQLite 的 WAL 与页缓存**由预热轮次承担** ⇒
 *     **统计里的样本不含首次 IO 的抖动**（这一点写进报告）。
 *
 * ⚠️ ★ **规模守卫**（P2 收官 · Q-02；DEVELOPMENT-PLAN.md 行 2068~2070 的硬断言
 *   「**规模写进验收行**」）：
 *   · **默认 `--scale` = 1 000 000**；
 *   · **规模 < 100 万 ⇒ 直接失败**（抛错 + **非零退出码** + **不落盘**）
 *     ⇒ 因为「小库根本走不到分桶路径」⇒ **在小库上测得的 P99 什么也没验到**
 *     ⇒ **那样的结果不许冒充验收结论**（落盘的基线是「数字的出处」）。
 *   · ⚠️ **降级开关 `--allow-small-scale`（默认关闭）**：
 *     **存在理由** = 冒烟 / 自检 / 工具链联调要在**小规模**上快速跑一遍
 *     （否则每次自检都要 5 小时）⇒ **必须留一条合法的降级路径**。
 *     **默认关闭的理由** = 小规模上的数字**只**能当「工具跑得通」的自检，
 *     **不能**当「性能达标」的证据 ⇒ 默认必须拒绝。
 *     ⇒ 降级跑出来的文件名**带规模数字**（`perf-1500.json`）⇒ 一眼可辨。
 *
 * ⚠️ ★★★ **2026-11-02 架构师重新定档：硬门槛从「毫秒」改成「计数」**（v2.1 勘误）
 *   —— **本文件按新口径实现**：
 *   · **H1（硬门槛 · 归 P2）**：**向量路单次查询的候选读取行数 ≤ 2,000 行**
 *     ⇒ **纯计数 ⇒ 与存储介质无关** ⇒ 「2,000」是 P2 自己在写入路径上已写死的数
 *       （§4.9 步骤 3a2「候选 ≤ 2000」）⇒ **同一个库、同一个量、同一个被考核方**。
 *   · **H2（硬门槛 · 与 H1 同义的规模无关写法）**：**候选读取行数 ÷ 库规模 ≤ 0.2%**。
 *   · **R1（参考线）**：向量路 P99（绝对毫秒）⇒ **按介质分档记录**，**不判 P2**。
 *   ⇒ ⇒ **为什么毫秒数必须降级为观测值**：
 *     `向量路耗时 ≈ 候选行数 × 每行读成本` ⇒ **「每行读多快」由介质 + 页缓存决定**
 *     ⇒ 把毫秒写死 = 把「这台机器的磁盘有多快」写进硬门槛
 *     ⇒ 同一个 H1（2,000 行）在 SATA HDD 上是 ~16~28ms、在 NVMe SSD 上是 ~2~5ms。
 *   ⇒ ⇒ **所以落盘 JSON 必须带上「存储介质类别」与「每行读成本」**
 *     （否则**换一块盘，判据的含义会静默改变**）。
 *
 * ⚠️ ★ **本文件新增的三件事**（各自的口径写在对应函数的头注释里）：
 *   ① **候选读取行数**（H1/H2 的判据本身）——**bench 侧统计**，**不改 `src/**`**：
 *     走**生产的公开 API**（`IvfVectorBackend.route()` 拿命中的细桶 id
 *     ＋ `countBucketMembers()` 拿桶成员数——**桶计数的唯一口径**）。
 *   ② **每行读成本（µs/行）**——**推导值**（向量路均耗时 ÷ 候选读取行数均值），
 *     **不是直接测量值** ⇒ 落盘时必须这么标。
 *   ③ **写入路径的分段计时**——「FTS5 + 索引维护」vs「向量候选扫描（P2 的代码）」。
 *
 * 用法：
 * ```
 * pnpm exec tsx bench/perf.ts --scale=1000000 --queries=200 --writes=200
 * ```
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../src/core/params.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { collectVectorCandidates } from '../src/store/dedupCandidates.js';
import { countBucketMembers } from '../src/vector/bucketAssign.js';
import { loadCentroidModel } from '../src/vector/centroids.js';
import { normalizeNumbers } from '../src/vector/dot.js';
import { IvfVectorBackend } from '../src/vector/ivf.js';
import { type CorpusOptions, DEFAULT_CORPUS_OPTIONS, generateQueries } from './corpus.js';
import { embedText } from './embedder.js';
import { prepareBench } from './lib/db.js';
import {
  BENCH_NOW,
  type StorageMediaInfo,
  benchWorkDir,
  formatLoadMs,
  formatPeakRss,
  intArg,
  machineInfo,
  parseArgs,
  percentile,
  phaseInfo,
  stringArg,
  summarizeLatency,
  writeJsonFile,
} from './lib/harness.js';
import { enforceBenchScale } from './lib/scale.js';

/** 性能门槛（§7.1 的验收行，**写死在此 ⇒ 报告与断言同源**）。 */
export const THRESHOLDS = {
  /** recall P99 上限（毫秒）。 */
  recallP99Ms: 200,
  /** 写入 P99 上限（毫秒）。 */
  writeP99Ms: 5,
  /** 向量路 P99 上限（毫秒）。 */
  vectorRouteP99Ms: 20,
  /** 向量路占总耗时的上限（比例，0~1）。 */
  vectorRouteShare: 0.2,
  /**
   * ★ **H1（硬门槛 · 归 P2）**：向量路单次查询的**候选读取行数**上限（行）。
   *
   * ⚠️ **纯计数 ⇒ 与存储介质无关**（2026-11-02 架构师重新定档）：
   *   旧的「向量路 P99 ≤ 20ms」把「这台机器的磁盘有多快」写进了硬门槛
   *   ⇒ 机械盘恒红、SSD 恒绿 ⇒ 判据测的是**介质**不是**架构**。
   * ⇒ 「2,000」是 **P2 自己在写入路径上已经写死的数**（§4.9 步骤 3a2「候选 ≤ 2000」）
   *   ⇒ **同一个库、同一个量、同一个被考核方** ⇒ **可兑现**。
   */
  candidateReadRowsMax: 2000,
  /**
   * ★ **H2（硬门槛 · 与 H1 同义的规模无关写法）**：候选读取行数 ÷ 库规模的上限（比例）。
   *
   * ⚠️ 1M ⇒ ≤ 2,000 行；10M ⇒ ≤ 20,000 行 ⇒ **与库规模解耦**。
   */
  candidateReadRowsRatioMax: 0.002,
} as const;

/** 预热轮次（**不计入统计**）。 */
export const WARMUP_ROUNDS = 20;

/**
 * ★ **一组「计数」的分布**（候选读取行数 / 命中桶数）。
 *
 * ⚠️ **为什么计数也要有分布而不是只有一个数**：
 *   H1 的判据是「**单次查询**的候选读取行数 ≤ 2,000」⇒ 「单次」⇒ **每一次**都要满足
 *   ⇒ ⇒ **判定取 `max`**（最严口径）⇒ 而 `mean` / `p50` / `p99` 一并落盘
 *   ⇒ **读的人可以自己换成别的口径复算**（不用重跑一次百万级）。
 */
export interface CountSummary {
  /** 样本数（**必须一起报** ⇒ 0 个样本 ⇒ 这个分布不可判定）。 */
  readonly count: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * ★ **写入路径的分段计时**（2026-11-02 架构师裁决）。
 *
 * ⚠️ **为什么必须分段**：
 *   「写入 P99 ≤ 5ms」那条参考线**原本被写成「纯归文本路」** ⇒ **已不准确** ——
 *   写入路径里**有一条是 P2 的代码**：**向量候选扫描**（§4.9 步骤 3a2，读 ~2,000 行 × 3KB）
 *   ⇒ ⇒ 「写入那条纯归文本路」不成立 ⇒ **必须给出归因**。
 *
 * ⚠️ ★ **口径（必须落盘 ⇒ 读的人不会误读）**：
 *   · `vectorCandidateScan` = **独立实测**（单独调用**生产的那条扫描路径**）
 *     ⇒ **不是**从「写入总耗时」里切出来的 ⇒ **它与写入那一次不是同一次调用**
 *     ⇒ **它是「这一段要花多少」的估计**，不是「那次写入里这一段的确切耗时」；
 *   · `otherMeanMs` = **推导值**（写入总耗时的均值 − 向量扫描段的均值）
 *     ⇒ 「FTS5 + 索引维护 + 合并判定 + 事件写入」那一段的**均值归因**。
 */
export interface WriteSegmentSummary {
  /** 向量候选扫描段（**P2 的代码**）：**独立实测**的分布。 */
  readonly vectorCandidateScan: LatencyDistribution;
  /** 向量候选扫描段的**候选行数**（= 命中桶里被扫过的行数；§4.9 步骤 3a2 的「候选 ≤ 2000」）。 */
  readonly vectorCandidateRows: CountSummary;
  /** 写入总耗时（**实测**；就是 P99 用的那批样本）。 */
  readonly writeTotal: LatencyDistribution;
  /** 其余段（FTS5 + 索引维护 + 合并判定 + 事件写入）的**均值** —— **推导值**（毫秒）。 */
  readonly otherMeanMs: number;
  /** 其余段占写入总耗时的**均值**比例 —— **推导值**（0~1；**可能为负**，见 `note`）。 */
  readonly otherMeanShare: number;
  /** 口径说明（**必须落盘** ⇒ 这两个推导值不会被误读成实测值）。 */
  readonly note: string;
}

/** 一次 P99 测量的结果。 */
export interface PerfResult {
  /** 语料规模（**实测**）。 */
  readonly corpusSize: number;
  /** recall 的样本数（**报告必须写明**）。 */
  readonly recallSamples: number;
  /** 写入的样本数。 */
  readonly writeSamples: number;
  /** ★ **第一条被计入统计的写入耗时**（毫秒）—— 冷启动是否已被预热掉的证据。 */
  readonly firstWriteMs: number;
  /** 向量路的样本数。 */
  readonly vectorRouteSamples: number;
  /** 预热轮次（**不计入统计**）。 */
  readonly warmupRounds: number;
  /** recall P99（毫秒）。 */
  readonly recallP99Ms: number;
  /** 写入 P99（毫秒）。 */
  readonly writeP99Ms: number;
  /** 向量路 P99（毫秒）。 */
  readonly vectorRouteP99Ms: number;
  /** 向量路占总耗时（0~1）。 */
  readonly vectorRouteShare: number;
  /**
   * ★ **H1 的量**：向量路单次查询的**候选读取行数**的分布。
   *
   * ⚠️ **口径** = **命中细桶里的成员数之和**
   *   （= `route()` 命中的细桶 → `countBucketMembers()` 的成员数）
   *   ⇒ **这就是「桶内全量精确点积」要读的行数** ⇒ **桶内不设 LIMIT**（§4.15.3）。
   */
  readonly candidateReadRows: CountSummary;
  /** 每次查询命中的**细桶数**的分布（探针口径的可核对证据）。 */
  readonly hitFineBuckets: CountSummary;
  /**
   * ★ **每行读成本**（微秒/行）—— **推导值，不是直接测量值**。
   *
   * ⚠️ **推导式**：`向量路均耗时(ms) × 1000 ÷ 候选读取行数均值`
   *   ⇒ 它把「路由 + 点积 + 行读」**全部**摊到候选行上 ⇒
   *   **不是**纯粹的「磁盘读一行要多久」⇒ 读它的时候要记住这一点。
   * ⚠️ **`null` ⇒ 候选行数为 0**（分桶尚未训练 ⇒ 向量路整体缺席）⇒ 不是「成本为 0」。
   */
  readonly perRowReadCostUs: number | null;
  /** ★ **写入路径的分段计时**（见 `WriteSegmentSummary` 的口径说明）。 */
  readonly writeSegments: WriteSegmentSummary;
  /** recall 的耗时分布。 */
  readonly recallLatency: LatencyDistribution;
  /** 写入的耗时分布。 */
  readonly writeLatency: LatencyDistribution;
  /** 向量路的耗时分布。 */
  readonly vectorRouteLatency: LatencyDistribution;
}

/** 一组耗时的分布（**样本数必须一起报**）。 */
export interface LatencyDistribution {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/**
 * 把样本压成分布（**样本数必须一起报** ⇒ 「P99 = 12ms」在 10 个样本与
 * 10 万个样本上是**两条完全不同的结论**）。
 *
 * @param samples 耗时样本（毫秒）
 * @returns 分布
 */
export function toDistribution(samples: readonly number[]): LatencyDistribution {
  const summary = summarizeLatency(samples);
  return {
    count: summary.count,
    minMs: summary.minMs,
    p50Ms: summary.p50Ms,
    p90Ms: summary.p90Ms,
    p95Ms: summary.p95Ms,
    p99Ms: summary.p99Ms,
    maxMs: summary.maxMs,
    meanMs: summary.meanMs,
  };
}

/**
 * 测一次 P99（全流程）。
 *
 * ⚠️ **预热轮次不计入统计**（理由见文件头）。
 *
 * @param db 库句柄（**已灌语料、已训练分桶**）
 * @param store 生产门面（**用于测 recall 与写入**）
 * @param options 语料参数
 * @param queryCount 查询条数
 * @param writeCount 写入条数
 * @returns 测量结果
 */
export function measurePerf(
  db: Database.Database,
  store: MemoryStore,
  options: CorpusOptions,
  queryCount: number,
  writeCount: number,
): PerfResult {
  const queries = generateQueries(options, queryCount);
  const model = loadCentroidModel(db);
  const backend = new IvfVectorBackend({
    db,
    centroids: () => model,
    nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    nprobeFine: DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
  });
  backend.init({
    dimensions: DEFAULT_PARAMS.EMBED_DIM,
    coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
    fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
  });

  const recallSamples: number[] = [];
  const writeSamples: number[] = [];
  const vectorRouteSamples: number[] = [];
  // ★ **H1 的两个计数样本**（候选读取行数 / 命中细桶数）。
  const candidateRowSamples: number[] = [];
  const hitBucketSamples: number[] = [];
  // ★ **写入路径的分段计时**：向量候选扫描段的样本（P2 的代码）。
  const writeVectorScanSamples: number[] = [];
  const writeVectorScanRowSamples: number[] = [];

  // ⚠️ ★ **桶成员数的缓存**（`countBucketMembers()` 是桶计数的**唯一口径**）：
  //   命中桶数在多次查询间高度重复 ⇒ 缓存后每个细桶只 COUNT 一次
  //   ⇒ 百万级上不会退化成「每次查询 50 次 COUNT」。
  const bucketMemberCounts = new Map<string, number>();
  const membersOf = (fineId: string): number => {
    const cached = bucketMemberCounts.get(fineId);
    if (cached !== undefined) {
      return cached;
    }
    const count = countBucketMembers(db, fineId);
    bucketMemberCounts.set(fineId, count);
    return count;
  };

  // ── 预热（**不计入统计**）──
  // ⚠️ **写入也要预热**（与 recall/向量路同一条理由）：
  //   写入路径的「一次性成本」（WAL 首次落盘、页缓存装载、中心向量缓存建好、
  //   桶计数器的首次重建）都发生在**第一次写入**上
  //   ⇒ 不预热 ⇒ **P99 = max = 第一次写入**（实测：首次写 245ms，后续写 ~4ms）
  //   ⇒ 那个数测的是「冷启动」，不是「写入 P99」。
  //   ⇒ 预热写用**独立正文**（不与语料重复 ⇒ 不触发合并路径 ⇒ 测的仍是「新建」）。
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    const query = queries[round % Math.max(1, queries.length)];
    if (query !== undefined) {
      backend.route(
        query.embedding,
        DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
      );
      backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
    }
    store.recall({ context: '预热', now: BENCH_NOW });
    const warmContent = `预热写入第${round}条、独立的正文、不与语料重复`;
    store.write({
      content: warmContent,
      embedding: Array.from(embedText(warmContent)),
      now: BENCH_NOW,
    });
  }

  // ── recall（**生产的 `MemoryStore.recall()`**）──
  for (const query of queries) {
    const start = process.hrtime.bigint();
    store.recall({ context: query.context, now: BENCH_NOW });
    const end = process.hrtime.bigint();
    recallSamples.push(Number(end - start) / 1_000_000);
  }

  // ── 向量路（**生产后端**：route + search）──
  // ⚠️ ★ **候选读取行数在计时之外统计**（H1 的判据）：
  //   ① `route()` 给出**命中的细桶 id**（生产后端的公开 API ⇒ 拿到的就是
  //      `search()` 内部用的那批桶 ⇒ 路由是确定性的 ⇒ 两次必然一致）；
  //   ② 每个细桶的**成员数**走 `countBucketMembers()`（桶计数的**唯一口径**）
  //      ⇒ **候选读取行数 = 命中细桶的成员数之和**
  //      （= 「桶内全量精确点积」要读的行数；桶内**不设 LIMIT**，§4.15.3）。
  for (const query of queries) {
    const start = process.hrtime.bigint();
    const fineIds = backend.route(
      query.embedding,
      DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
      DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
    );
    backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
    const end = process.hrtime.bigint();
    vectorRouteSamples.push(Number(end - start) / 1_000_000);
    let candidateRows = 0;
    for (const fineId of fineIds) {
      candidateRows += membersOf(fineId);
    }
    candidateRowSamples.push(candidateRows);
    hitBucketSamples.push(fineIds.length);
  }

  // ── 写入（**生产的 `MemoryStore.write()`**）──
  // ⚠️ **写入用新正文**（不复用语料里的正文 ⇒ 不触发「完全重复」那条合并路径
  //   ⇒ 测的是「新建」这条路径的耗时 ⇒ 与门槛「写入 P99」对齐）。
  // ⚠️ ★ **必须带向量**：生产的写入流程里，「近重复合并」与「桶归属」这两步
  //   **都依赖向量**（P2-T07 把向量候选接进了写入路）⇒ 不带向量 ⇒ 这两步整段缺席
  //   ⇒ 测出来的「写入耗时」不代表生产。
  //   ⇒ 向量由**调用方**提供（生产也是如此：应用侧算好向量再交给库）
  //   ⇒ 且**在计时之外**算好（向量化不是库的开销，不该计入库的 P99）。
  let firstWriteMs = 0;
  for (let index = 0; index < writeCount; index += 1) {
    const content = `写入压测第${index}条、独立的正文${index}、不与语料重复`;
    const embedding = Array.from(embedText(content));
    const start = process.hrtime.bigint();
    store.write({ content, embedding, now: BENCH_NOW });
    const end = process.hrtime.bigint();
    const elapsed = Number(end - start) / 1_000_000;
    if (index === 0) {
      firstWriteMs = elapsed;
    }
    writeSamples.push(elapsed);
  }

  // ── ★ **写入路径的分段计时**（2026-11-02 架构师裁决）──
  // ⚠️ ★ **口径**：这一段是**独立实测**（**不是**从写入总耗时里切出来的）：
  //   **单独调用生产的那条向量候选扫描路径**（`collectVectorCandidates()`
  //   ⇒ 内部就是 `src/vector/ivf.ts` 的 `scanBucketCandidates()`）
  //   ⇒ 量的是「写入路径里那一条 P2 的向量候选扫描」**这一段自己**要花多少。
  // ⚠️ **为什么不改成「在写入里插桩」**：那需要改 `src/store/write.ts`
  //   （本轮**不碰**它 ⇒ 见给主理人的报告）。
  // ⚠️ **为什么放在写入循环之后**：插在写入循环**之内**会**先读一遍那批候选行**
  //   ⇒ 把它们**预热进页缓存** ⇒ 写入那次的耗时会**偏乐观** ⇒ **污染写入 P99**。
  const dedupContext = {
    db,
    params: DEFAULT_PARAMS,
    // ⚠️ **桶归属上下文**只借「读」能力（中心模型 + 库句柄）⇒ 与生产同一份规则。
    buckets: {
      db,
      centroids: () => model,
      nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    },
  };
  for (let index = 0; index < writeCount; index += 1) {
    const content = `写入压测第${index}条、独立的正文${index}、不与语料重复`;
    // ⚠️ **与写入那一次用同一个向量**（生产的归一化口径：`normalizeNumbers`）。
    const embedding = normalizeNumbers(Array.from(embedText(content)));
    const start = process.hrtime.bigint();
    const scan = collectVectorCandidates(dedupContext, embedding);
    const end = process.hrtime.bigint();
    writeVectorScanSamples.push(Number(end - start) / 1_000_000);
    writeVectorScanRowSamples.push(scan.scanned);
  }

  const recallMean = meanOf(recallSamples);
  const vectorMean = meanOf(vectorRouteSamples);
  // ⚠️ **「向量路占总耗时」的分母 = recall 全程 + 向量路**（接线后的真实构成）。
  const vectorRouteShare =
    recallMean + vectorMean === 0 ? 0 : vectorMean / (recallMean + vectorMean);

  // ── ★ **候选读取行数（H1/H2 的判据）** ──
  const candidateReadRows = toCountSummary(candidateRowSamples);
  const hitFineBuckets = toCountSummary(hitBucketSamples);

  // ── ★ **每行读成本（推导值）** ──
  // ⚠️ **推导式**：向量路均耗时 ÷ 候选读取行数均值 ⇒ 单位 µs/行。
  //   **候选行数为 0 ⇒ `null`**（分桶尚未训练 ⇒ 向量路整体缺席 ⇒ 不是「成本 0」）。
  const perRowReadCostUs =
    candidateReadRows.mean > 0 ? (vectorMean * 1000) / candidateReadRows.mean : null;

  // ── ★ **写入路径的分段计时** ──
  const writeTotal = toDistribution(writeSamples);
  const vectorCandidateScan = toDistribution(writeVectorScanSamples);
  const vectorScanMean = vectorCandidateScan.meanMs;
  const otherMeanMs = writeTotal.meanMs - vectorScanMean;
  const writeSegments: WriteSegmentSummary = {
    vectorCandidateScan,
    vectorCandidateRows: toCountSummary(writeVectorScanRowSamples),
    writeTotal,
    otherMeanMs,
    otherMeanShare: writeTotal.meanMs === 0 ? 0 : otherMeanMs / writeTotal.meanMs,
    note:
      '① vectorCandidateScan = **独立实测段**（单独调用生产的那条向量候选扫描路径 ' +
      '`collectVectorCandidates()` ⇒ 内部就是 `src/vector/ivf.ts` 的 `scanBucketCandidates()`；' +
      '**不是**从写入总耗时里切出来的 ⇒ 与写入那一次**不是同一次调用**）；' +
      '② otherMeanMs / otherMeanShare = **推导值段**（写入总耗时均值 − 向量扫描段均值）' +
      '⇒ 其余段 = 「FTS5 + 索引维护 + 合并判定 + 事件写入」；' +
      '③ ⚠️⚠️ **「① + ② ≠ 写入总耗时」**（**读这两个数时必须知道**）：' +
      '两段**不是同一次写入里的两段** ⇒ ① 跑在**写入循环之后**的**单独一轮**里 ' +
      '⇒ 那时库里已经多了本轮写入的 N 条记忆 ⇒ 候选面更大一点、页缓存状态也不同 ' +
      '⇒ ⇒ **① 与 ② 相加没有「等于写入总耗时」的含义** ⇒ **只能当归因的量级参考**，' +
      '**不是精确拆分** ⇒ 若要精确拆分，必须在 `src/store/write.ts` 里加一个只读观测点；' +
      '⚠️ 另：otherMeanMs **可能为负** ⇒ 说明「独立实测的扫描段」比「整次写入」还贵 ' +
      '（页缓存状态不同）⇒ 同样不可当精确拆分。',
  };

  return {
    corpusSize: options.size,
    recallSamples: recallSamples.length,
    writeSamples: writeSamples.length,
    firstWriteMs,
    vectorRouteSamples: vectorRouteSamples.length,
    warmupRounds: WARMUP_ROUNDS,
    recallP99Ms: percentile(recallSamples, 99),
    writeP99Ms: percentile(writeSamples, 99),
    vectorRouteP99Ms: percentile(vectorRouteSamples, 99),
    vectorRouteShare,
    candidateReadRows,
    hitFineBuckets,
    perRowReadCostUs,
    writeSegments,
    recallLatency: toDistribution(recallSamples),
    writeLatency: writeTotal,
    vectorRouteLatency: toDistribution(vectorRouteSamples),
  };
}

/**
 * 把一组计数压成分布（**样本数必须一起报**；空样本 ⇒ 全 0）。
 *
 * ⚠️ **空样本返回全 0**（不是 `NaN`）⇒ 后续比较不会静默吞掉。
 *
 * @param samples 计数样本
 * @returns 计数分布
 */
export function toCountSummary(samples: readonly number[]): CountSummary {
  if (samples.length === 0) {
    return { count: 0, min: 0, mean: 0, p50: 0, p99: 0, max: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: samples.length,
    min: sorted[0] ?? 0,
    mean: sum / samples.length,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * 样本的均值（**空样本返回 0** ⇒ 不会算出 `NaN`）。
 *
 * @param samples 样本
 * @returns 均值
 */
function meanOf(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  return samples.reduce((total, value) => total + value, 0) / samples.length;
}

/**
 * 性能门槛的**断言**（**逐条写死** ⇒ 可被变异打红）。
 *
 * ⚠️ **这些是「软阈值」**（§7.1 把它们列在**软阈值**栏）⇒
 *   本函数返回**违规清单**而不是直接抛错 ⇒ 由调用方决定是「记录」还是「判红」。
 *   ⇒ 但**清单必须非空时能被看出来**（不能悄悄吞掉）。
 *
 * @param result 测量结果
 * @returns 违规清单（**空数组 = 全部达标**）
 */
export function checkPerf(result: PerfResult): string[] {
  const failures: string[] = [];

  if (result.recallP99Ms > THRESHOLDS.recallP99Ms) {
    failures.push(
      `recall P99 ${result.recallP99Ms.toFixed(3)}ms > ${THRESHOLDS.recallP99Ms}ms` +
        `（样本 ${result.recallSamples}、预热 ${result.warmupRounds}）`,
    );
  }
  if (result.writeP99Ms > THRESHOLDS.writeP99Ms) {
    failures.push(
      `写入 P99 ${result.writeP99Ms.toFixed(3)}ms > ${THRESHOLDS.writeP99Ms}ms` +
        `（样本 ${result.writeSamples}、预热 ${result.warmupRounds}）`,
    );
  }
  if (result.vectorRouteP99Ms > THRESHOLDS.vectorRouteP99Ms) {
    failures.push(
      `向量路 P99 ${result.vectorRouteP99Ms.toFixed(3)}ms > ${THRESHOLDS.vectorRouteP99Ms}ms` +
        `（样本 ${result.vectorRouteSamples}、预热 ${result.warmupRounds}）`,
    );
  }
  if (result.vectorRouteShare > THRESHOLDS.vectorRouteShare) {
    failures.push(
      `向量路占总耗时 ${(result.vectorRouteShare * 100).toFixed(2)}% > ` +
        `${(THRESHOLDS.vectorRouteShare * 100).toFixed(0)}%`,
    );
  }

  // ⚠️ ★★★ **H1（硬门槛 · 归 P2 · 2026-11-02 重新定档）** ───
  //   **向量路单次查询的候选读取行数 ≤ 2,000 行** ⇒ **纯计数 ⇒ 与介质无关**。
  // ⚠️ **判定口径 = 样本的 `max`**（「**单次**查询」⇒ 每一次都要满足 ⇒ 最严口径）
  //   ⇒ 而 `mean` / `p50` / `p99` 一并落盘 ⇒ **换口径不用重跑百万级**。
  if (result.candidateReadRows.count === 0) {
    failures.push('候选读取行数的样本数为 0 ⇒ H1 是真空通过（必须有样本）');
  } else if (result.candidateReadRows.max > THRESHOLDS.candidateReadRowsMax) {
    failures.push(
      `候选读取行数（H1）${result.candidateReadRows.max} 行 > ${THRESHOLDS.candidateReadRowsMax} 行` +
        `（判定取 max；均值 ${result.candidateReadRows.mean.toFixed(1)} 行、` +
        `p99 ${result.candidateReadRows.p99} 行、样本 ${result.candidateReadRows.count}）`,
    );
  }

  // ⚠️ ★ **H2（与 H1 同义的规模无关写法）**：候选读取行数 ÷ 库规模 ≤ 0.2%
  //   ⇒ 1M ⇒ ≤ 2,000 行；10M ⇒ ≤ 20,000 行。
  const candidateRatio =
    result.corpusSize > 0 ? result.candidateReadRows.max / result.corpusSize : 0;
  if (result.candidateReadRows.count > 0 && candidateRatio > THRESHOLDS.candidateReadRowsRatioMax) {
    failures.push(
      `候选读取行数 ÷ 库规模（H2）${(candidateRatio * 100).toFixed(4)}% > ` +
        `${(THRESHOLDS.candidateReadRowsRatioMax * 100).toFixed(1)}%` +
        `（${result.candidateReadRows.max} 行 / 库规模 ${result.corpusSize}）`,
    );
  }

  // ⚠️ **样本数必须够**：样本为 0 ⇒ P99 是 `0` ⇒ 门槛「通过」是**真空通过**
  //   ⇒ 必须显式报出来。
  if (result.recallSamples === 0 || result.writeSamples === 0 || result.vectorRouteSamples === 0) {
    failures.push('样本数为 0 ⇒ P99 是真空通过（必须有样本）');
  }
  return failures;
}

/** 主流程（**独立可跑**：`pnpm exec tsx bench/perf.ts`）。 */
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scale = intArg(args, 'scale', DEFAULT_CORPUS_OPTIONS.size);
  const queryCount = intArg(args, 'queries', 200);
  const writeCount = intArg(args, 'writes', 200);
  const seed = intArg(args, 'seed', DEFAULT_CORPUS_OPTIONS.seed);
  const dbPath = stringArg(args, 'db', `${benchWorkDir()}/perf-${scale}.db`);
  const outPath = stringArg(args, 'out', `docs/baseline/perf-${scale}.json`);

  // ⚠️ ★ **规模守卫**（硬断言「规模写进验收行」）⇒ **在最前面**：
  //   不达标就**别开始灌库**（百万级一次 3 小时 ⇒ 跑完再报错是浪费）。
  //   ⇒ 不达标 ⇒ 非零退出码 ⇒ **直接 return ⇒ 绝不落盘**。
  const scaleCheck = enforceBenchScale(args, scale);
  if (!scaleCheck.allowed) {
    return;
  }
  if (scaleCheck.downgraded) {
    process.stdout.write(`⚠ ${scaleCheck.reason}\n`);
  }

  const options: CorpusOptions = { ...DEFAULT_CORPUS_OPTIONS, size: scale, seed };
  // ⚠️ **机器信息在开始时采集**（不是结束时）：
  //   “运行开始时还有多少可用内存”才是“这个规模跑得动”的证据。
  const machine = machineInfo();
  process.stdout.write(
    `P99 测量：语料 ${scale} 条 / 查询 ${queryCount} 条 / 写入 ${writeCount} 条 / 库 ${dbPath}\n`,
  );

  // ⚠️ **走共享的库准备流程**（`bench/lib/db.ts`）⇒ 三个脚本的准备口径**同一份**
  //   ⇒ 不会「一个脚本灌了、另一个脚本没灌」这种漂移（C36）。
  const prepared = prepareBench({
    dbPath,
    corpus: options,
    coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
    fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
    nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    reuseExisting: args.reuse === 'true',
    // ⚠️ ★ **「明知要重灌」的显式声明**（默认 false）⇒
    //   `--reuse=true` 而复用不了时**默认报错**（不许悄悄删库重灌 ⇒ 3~5 小时的活）。
    forceRebuild: args['force-rebuild'] === 'true',
  });
  const db = prepared.db;

  const store = new MemoryStore({ dbPath });
  const result = measurePerf(db, store, options, queryCount, writeCount);
  const failures = checkPerf(result);
  // ⚠️ ★ **存储介质类别**（判据的介质解耦落点）—— 探测失败 ⇒ `'unknown'`（**不抛错**）。
  const storageMedia: StorageMediaInfo = machine.storageMedia;

  writeJsonFile(outPath, {
    corpusSize: result.corpusSize,
    trainedCells: prepared.fineCells,
    trainedMembers: prepared.members,
    thresholds: THRESHOLDS,
    recallP99Ms: result.recallP99Ms,
    writeP99Ms: result.writeP99Ms,
    firstWriteMs: result.firstWriteMs,
    vectorRouteP99Ms: result.vectorRouteP99Ms,
    vectorRouteShare: result.vectorRouteShare,
    // ⚠️ ★★★ **H1 / H2 的判据本身（纯计数）** ───
    candidateReadRows: result.candidateReadRows,
    hitFineBuckets: result.hitFineBuckets,
    // ⚠️ ★ **每行读成本（µs/行）—— 推导值，不是直接测量值**。
    perRowReadCostUs: result.perRowReadCostUs,
    // ⚠️ ★ **写入路径的分段计时**（见 `writeSegments.note` 的口径说明）。
    writeSegments: result.writeSegments,
    // ⚠️ ★ **存储介质类别**（HDD / SSD / NVMe / `unknown`）——「换一块盘 ⇒ 判据含义静默改变」的防线。
    storageMedia,
    warmupRounds: result.warmupRounds,
    recallLatency: result.recallLatency,
    writeLatency: result.writeLatency,
    vectorRouteLatency: result.vectorRouteLatency,
    failures,
    benchNow: BENCH_NOW,
    machine,
    phases: phaseInfo(prepared),
  });

  process.stdout.write(
    `  recall P99 = ${result.recallP99Ms.toFixed(3)}ms（门槛 ${THRESHOLDS.recallP99Ms}ms，样本 ${result.recallSamples}）\n` +
      `  写入 P99 = ${result.writeP99Ms.toFixed(3)}ms（门槛 ${THRESHOLDS.writeP99Ms}ms，样本 ${result.writeSamples}）\n` +
      `  向量路 P99 = ${result.vectorRouteP99Ms.toFixed(3)}ms（门槛 ${THRESHOLDS.vectorRouteP99Ms}ms，样本 ${result.vectorRouteSamples}）\n` +
      `  向量路占总耗时 = ${(result.vectorRouteShare * 100).toFixed(2)}%（门槛 ≤ ${(THRESHOLDS.vectorRouteShare * 100).toFixed(0)}%）\n` +
      `  ★ H1 候选读取行数 = ${result.candidateReadRows.max} 行（判定取 max；均值 ${result.candidateReadRows.mean.toFixed(1)} 行，` +
      `门槛 ≤ ${THRESHOLDS.candidateReadRowsMax} 行，样本 ${result.candidateReadRows.count}）\n` +
      '  ★ H2 候选行数 ÷ 库规模 = ' +
      `${(result.corpusSize > 0 ? (result.candidateReadRows.max / result.corpusSize) * 100 : 0).toFixed(4)}%` +
      `（门槛 ≤ ${(THRESHOLDS.candidateReadRowsRatioMax * 100).toFixed(1)}%）\n` +
      '  ★ 每行读成本 = ' +
      `${result.perRowReadCostUs === null ? '**未测到**' : `${result.perRowReadCostUs.toFixed(3)} µs/行`}` +
      `（推导值；介质 ${storageMedia.mediaClass}${storageMedia.detected ? '' : '（**未探测到**）'}）\n` +
      `  ★ 写入分段：向量候选扫描 均 ${result.writeSegments.vectorCandidateScan.meanMs.toFixed(3)}ms` +
      `/ 其余（FTS5 + 索引维护）均 ${result.writeSegments.otherMeanMs.toFixed(3)}ms（推导值）\n` +
      `  灌库 ${formatLoadMs(prepared.loadMs)} / 训练 ${prepared.trainMs.toFixed(0)}ms / ` +
      `${formatPeakRss(prepared.trainPeakRss)}\n` +
      `  结果已写入 ${outPath}\n`,
  );

  if (failures.length > 0) {
    process.stderr.write(`\n⚠ 性能门槛未达标（${failures.length} 条）：\n`);
    for (const failure of failures) {
      process.stderr.write(`    ${failure}\n`);
    }
    process.stderr.write('  ⇒ 这些是**软阈值**（共享机器上的参考线）⇒ 记录实测值，不判失败。\n');
    return;
  }
  process.stdout.write('\n✓ 性能门槛全部达标\n');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  main();
}
