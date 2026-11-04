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
 * ⚠️ ★★★ **本脚本测两个「召回档」**（2026-11-02 补：`recall()` 已接线向量路，`96568eb`）：
 *   · **old-path 档** = `store.recall({ context, now })` —— **不传 `queryEmbedding`**
 *     ⇒ 向量路**整段不执行**（`src/store/recall.ts` 步骤 2c 的入口条件是「有向量 ∧ 有端口」）
 *     ⇒ 它就是「**接线之前**」的召回形状 ⇒ **这是对照组，结构与键名一个都不许改**
 *     （改掉 = **永久丢失**「接线前后快慢」的唯一对照）；
 *   · **new-path 档** = `store.recall({ context, queryEmbedding, now })`
 *     ⇒ 向量路**真的在召回内部跑**（采样前由一次性 `diagnostics` 探针证实
 *     `explain.routes.vector.ran === true`，探针结果落盘）。
 *   ⇒ **落盘键名**（不复用、不并列重名）：
 *     · old-path ⇒ `recallLatency` / `recallP99Ms`（**原有键，原样不动**）；
 *     · new-path ⇒ `recallVectorPath`（**新键**，内含 `latency` / `p99Ms` / `meanMs` /
 *       `oldPathMeanMs` / `meanDeltaMs` / `probe`）。
 *   ⇒ **文件头这一句就是键名的权威说明**：`recall*` = old-path，`recallVectorPath` = new-path。
 *
 * ⚠️ ★★ **「向量扫描本身」与「整条召回」是两条不同的数（绝不混成一个）**：
 *   · `vectorRouteLatency` / `vectorRouteP99Ms` / `candidateReadRows` / `hitFineBuckets`
 *     —— **直接调 `backend.route()` + `backend.search()`** 量出来的
 *     ⇒ 它回答「**向量扫描（含路由）这一段自己花多少**」，
 *     **不含**文本路 / 图谱路 / 打分 / 排序 ⇒ **它不是召回读数**（落盘另有 `vectorScanNote` 声明）；
 *   · `recallVectorPath`（new-path 档）—— **整条召回**（向量路在里面）
 *     ⇒ 它回答「**一次召回花多少**」。
 *   ⇒ ⇒ 「向量路在一次召回里占多少」的正确算法是
 *     `vectorRouteLatency.meanMs ÷ recallVectorPath.latency.meanMs`（**同一次运行内**比），
 *     已作为推导值落盘在 `recallVectorPath.vectorScanShareOfNewPath`。
 *   ⚠️ **为什么仍保留「独立跑一遍向量扫描」这种写法**：bench **不改 `src/**`**
 *     ⇒ 无法在 `recall()` 内部插桩 ⇒ **分档归因只能靠独立跑一遍**
 *     ⇒ 保留它，但**口径必须落盘**（`vectorScanNote`）⇒ 读的人不会把它当召回读数。
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
 *   · **H1（硬门槛 · 归 P2）**：**写入去重路径**单次写入的**候选读取行数 ≤ 2,000 行**
 *     （探针写死为写入路径那一组：`ROUTER_NPROBE_WRITE_COARSE=8` / `ROUTER_NPROBE_WRITE_FINE=20`）
 *     ⇒ **纯计数 ⇒ 与存储介质无关** ⇒ 「2,000」是 P2 自己在写入路径上已写死的数
 *       （§4.9 步骤 3a2「候选 ≤ 2000」）⇒ **同一个库、同一个量、同一个被考核方**。
 *   · **H2（硬门槛 · 与 H1 同义的规模无关写法）**：
 *     **写入去重路径的候选读取行数 ÷ 库规模 ≤ 0.2%**。
 *   · **R1（参考线）**：向量路 P99（绝对毫秒）⇒ **按介质分档记录**，**不判 P2**。
 *   ⇒ ⇒ **为什么毫秒数必须降级为观测值**：
 *     `向量路耗时 ≈ 候选行数 × 每行读成本` ⇒ **「每行读多快」由介质 + 页缓存决定**
 *     ⇒ 把毫秒写死 = 把「这台机器的磁盘有多快」写进硬门槛
 *     ⇒ 同一个 H1（2,000 行）在 SATA HDD 上是 ~16~28ms、在 NVMe SSD 上是 ~2~5ms。
 *   ⇒ ⇒ **所以落盘 JSON 必须带上「存储介质类别」与「每行读成本」**
 *     （否则**换一块盘，判据的含义会静默改变**）。
 *
 * ⚠️ ★★★ **2026-11-03 架构师归口：H1/H2 的考核主体 = 「写入去重路径」**
 *   （`DECISIONS.md` D10 · `DESIGN-v2-errata.md` §11.8）—— **本文件此前是「同一件事两套词」**：
 *   · **改前（错的口径）**：H1/H2 直接拿 `candidateReadRows`（**召回探针 20/50** 采的量）去撞
 *     **写入路径**的门槛 2,000 ⇒ 一个**召回侧**的量冒充「写入路径超了 6.39 倍」；
 *   · **改后（现在的口径）**：H1/H2 的**唯一**判据量 = `writeSegments.vectorCandidateRows`
 *     （**写入探针 8/20** · 拿的是 `collectVectorCandidates()` 里生产 SQL 实际返回的行数）；
 *     **召回路径的同名量** `candidateReadRows` ⇒ **另立 R6（`RECALL_VEC_ROWS`）**，
 *     **只观测 · 不设门槛 · 不判红绿**。
 *   ⇒ ⚠️ ⚠️ **归口 ≠ 达标**：1M 实测里 **H1 = 5,521 行（门槛的 2.76 倍 ⇒ 仍红）**、
 *     **R6 = 12,782 行（相对 2,000 行是 6.39 倍 ⇒ 读数仍然红）**
 *     ⇒ **6.39 倍没有变小，它换了主语**；「R6 没有门槛可判」**绝不等于**「R6 达标」。
 *   ⇒ ⇒ 门槛**数值与判定方式一个都没改**（仍 ≤ 2,000 行 / ≤ 0.2% · 仍判定取 `max`）
 *     ⇒ 这次改的是**主语**（谁被考核），不是门槛 ⇒ 所以 `THRESHOLDS` 里的**键名与数值原样保留**
 *     （改名会让同一个门槛在两份 JSON / 两个脚本里叫两个名字 ⇒ 正是本轮要消灭的「两套词」）。
 *
 * ⚠️ ★ **本文件新增的四件事**（各自的口径写在对应函数的头注释里）：
 *   ① **候选读取行数**（★ 现在的身份：**R6 的观测值** —— H1/H2 的判据量见 ③）——**bench 侧统计**，**不改 `src/**`**：
 *     ⚠️ ★ **2026-11-02 架构师裁决的「口径加固」** —— **取数来源从「推算」换成「实测」**：
 *     · **实测口径（★ R6 现在的取数）** = **生产 SQL 实际物化的候选行数**
 *       （`memories` 表 ⇒ 与写入路径那个「候选 ≤ 2000」**同一口径**）
 *       ⇒ 由 **bench 侧的行读计数器**（`bench/lib/harness.ts` 的 `installRowReadCounter()`）
 *         统计**生产代码真正跑的那条 SQL** ⇒ ⇒ **对任何实现都成立**
 *         （阶段 4 引入「桶内 LIMIT」/「两段式读」⇒ 这个数**会跟着降** ⇒ 不再有假红）；
 *     · **推算口径（只作对照，**不判任何门槛**）** = 命中细桶的成员数之和
 *       （`IvfVectorBackend.route()` ＋ `countBucketMembers()`）
 *       ⇒ ⚠️ **它模型化了「桶内不设 LIMIT」这个实现** ⇒ **阶段 4 引入桶内 LIMIT 后它不会跟着降**
 *       ⇒ ⇒ **不许用它判任何门槛**（但保留它 ⇒ 读的人能看见「实测 vs 推算」的差）。
 *     ⚠️ ★★ **它跑的是「召回探针 20/50」那一路** ⇒ ⇒ **它是 R6 的量，不是 H1 的量**
 *       （H1 的量在 `writeSegments.vectorCandidateRows`，见 ③）。
 *   ② **每行读成本（µs/行）**——**推导值**（向量路均耗时 ÷ 候选读取行数均值，
 *     ★ 这里的「候选读取行数」是**召回路径那一组（R6）**，因为分子同样是召回路径的耗时），
 *     **不是直接测量值** ⇒ 落盘时必须这么标。
 *   ③ **写入路径的分段计时**——「FTS5 + 索引维护」vs「向量候选扫描（P2 的代码）」。
 *     ⇒ ★ **`writeSegments.vectorCandidateRows` 就是 H1/H2 的判据量**（写入探针 8/20 · 实测）。
 *   ④ **页缓存状态（冷 / 热 / 未知）**——⚠️ **Windows 没有公开 API 能报「这个库有多少在页缓存里」**
 *     ⇒ ⇒ **只能「可标注」不能「可测量」** ⇒ 由 **跑的人声明**（`--cache-state=cold|warm|unknown`）
 *     ⇒ **缺省 `unknown`**（**不许猜**）⇒ 落盘进 JSON ⇒ **让机器能读出这个档位**。
 *
 * 用法：
 * ```
 * pnpm exec tsx bench/perf.ts --scale=1000000 --queries=200 --writes=200
 * pnpm exec tsx bench/perf.ts --scale=1000000 --cache-state=cold   # 显式声明「冷盘档」
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
import {
  type BenchQuery,
  type CorpusOptions,
  DEFAULT_CORPUS_OPTIONS,
  generateQueries,
} from './corpus.js';
import { embedText } from './embedder.js';
import { prepareBench } from './lib/db.js';
import {
  BENCH_NOW,
  type ByteReadSnapshot,
  type PageCacheStateInfo,
  type StorageMediaInfo,
  benchWorkDir,
  formatLoadMs,
  formatPeakRss,
  installRowReadCounter,
  intArg,
  machineInfo,
  parseArgs,
  parsePageCacheState,
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
   * ★ **H1（硬门槛 · 归 P2）**：**写入去重路径**的单次**候选读取行数**上限（行）。
   *
   * ⚠️ ★★★ **考核主体 = 写入去重路径**（2026-11-03 归口 · `DECISIONS.md` D10）：
   *   判据量 = **`writeSegments.vectorCandidateRows.max`**
   *   （探针 `ROUTER_NPROBE_WRITE_COARSE=8` / `ROUTER_NPROBE_WRITE_FINE=20`）；
   *   ⇒ ⚠️ **不是** `candidateReadRows` —— 那是**召回探针 20/50** 采的量，
   *     它的身份是 **R6（`RECALL_VEC_ROWS`）观测值：不设门槛、不判红绿**。
   *   ⇒ ⚠️ **为什么键名不改**：读旧 JSON / 旧脚本的人靠这个名字对账
   *     ⇒ 改名 = 让**同一个门槛**在两份 JSON 里叫两个名字 ⇒ 那正是本轮要消灭的「两套词」
   *     ⇒ **数值与键名一律原样保留，只把「它约束的是谁」写进注释与判定处**。
   *
   * ⚠️ **纯计数 ⇒ 与存储介质无关**（2026-11-02 架构师重新定档）：
   *   旧的「向量路 P99 ≤ 20ms」把「这台机器的磁盘有多快」写进了硬门槛
   *   ⇒ 机械盘恒红、SSD 恒绿 ⇒ 判据测的是**介质**不是**架构**。
   * ⇒ 「2,000」是 **P2 自己在写入路径上已经写死的数**（§4.9 步骤 3a2「候选 ≤ 2000」）
   *   ⇒ **同一个库、同一个量、同一个被考核方** ⇒ **可兑现**。
   */
  candidateReadRowsMax: 2000,
  /**
   * ★ **H2（硬门槛 · 与 H1 同义的规模无关写法）**：
   * **写入去重路径**的候选读取行数 ÷ 库规模的上限（比例）。
   *
   * ⚠️ 1M ⇒ ≤ 2,000 行；10M ⇒ ≤ 20,000 行 ⇒ **与库规模解耦**。
   * ⚠️ **主语与 H1 完全相同**（写入去重路径 · 探针 8/20）⇒ 两者是**同一个量的两种写法**，
   *   不是一个量在召回侧、一个量在写入侧。
   */
  candidateReadRowsRatioMax: 0.002,
  /**
   * ★★ **H1′（字节 · 唯一判据 · T06）**：**写入去重路径**的单次**向量载荷字节**上限（字节）。
   *
   * ⚠️ ★★★ **为什么是「字节」而不是「行」**（口径 §5 / ADR §8.5 理由 2）：
   *   「行」是**实现相关**的单位（768 B 的 int8 码 vs 96 B 的码 vs 打包块 ⇒ 行数含义完全不同）
   *   ⇒ ⇒ **换存储形态就等于换了一把尺** ⇒ ⇒ 字节口径**与码宽 / 存储形态无关** ⇒ 换实现不换尺。
   * ⚠️ **6,144,000 B = 2,000 行 × 3,072 B** ⇒ **与旧 H1 的 2,000 行同源**（同一笔、同一探针 8/20）
   *   ⇒ ⇒ **H1′ 与 H1 可比**（不是另立一个数）。
   * ⚠️ **判定只取 `bytesRead.max`**（「单次」⇒ 每一次都要满足 ⇒ 最严口径）。
   */
  bytesReadMax: 6_144_000,
  /**
   * ★ **H2′（与 H1′ 同义的规模无关写法）**：
   * **写入去重路径**的向量载荷字节 ÷（库规模 × 3,072 B）的上限（比例）。
   *
   * ⚠️ 1M ⇒ ≤ 6,144,000 B；10M ⇒ ≤ 61,440,000 B ⇒ **与库规模解耦**。
   * ⚠️ **主语与 H1′ 完全相同**（同一个量、同一批样本、同一个探针）⇒ 两者必然同时红 / 同时绿。
   */
  bytesReadRatioMax: 0.002,
  /**
   * ★ **剪枝率（出关条件①）**：`embeddingCalls ÷ candidateUniverse` 的上限（比例）。
   *
   * ⚠️ ★★★ **分子必须是「`get()` 调用次数」**（口径 §1.7 / §2 断言 1c-bench）：
   *   门槛是「≤ 15%」⇒ **分子偏小 = 更容易过 = 偏松 = 假绿**
   *   ⇒ 最坏情形：命中桶内全是软删成员 ⇒ 「返回行数」= 0 ⇒ **剪枝率 0% ⇒ 假绿**
   *   ⇒ ⇒ 必须数**调用次数**（返回 `undefined` 也计）⇒ 它**定义上** == `prune` 的 `exactReads`
   *   ⇒ ⇒ 等价性由 `tests/unit/prune.test.ts` 的断言 1c 钉住（**零 `src/**` 改动**）。
   */
  pruneRateMax: 0.15,
} as const;

/**
 * ★ **一条向量行的字节数**（768 个 float32 = 3,072 B）。
 *
 * ⚠️ **为什么跟着参数走**（不写死 3,072）：`EMBED_DIM` 是**参数**
 *   ⇒ 维度一改 ⇒ 向量字节就改 ⇒ ⇒ 写死 3,072 会在改维度后**悄悄算错**。
 * ⚠️ **它只用于「规模无关写法」的分母**（H2′：`bytesRead ÷ (库规模 × 本值)`）
 *   ⇒ ⇒ 与旧 H2 的分母（库规模）**同形** ⇒ ⇒ **可与旧 H2 逐位对照**。
 */
const BYTES_PER_VECTOR_ROW = DEFAULT_PARAMS.EMBED_DIM * 4;

/** 预热轮次（**不计入统计**）。 */
export const WARMUP_ROUNDS = 20;

/**
 * ★ **一组「计数」的分布**（候选读取行数 / 命中桶数）。
 *
 * ⚠️ **为什么计数也要有分布而不是只有一个数**：
 *   **H1 的判据是「单次写入的候选读取行数 ≤ 2,000」⇒ 「单次」⇒ 每一次都要满足**
 *   ⇒ ⇒ **判定取 `max`**（最严口径）⇒ 而 `mean` / `p50` / `p99` 一并落盘
 *   ⇒ **读的人可以自己换成别的口径复算**（不用重跑一次百万级）。
 * ⚠️ **本类型同时用于两组量**（H1 的写入路径组 / R6 的召回路径组）
 *   ⇒ 两组**探针配置不同**（8/20 vs 20/50）⇒ ⇒ **不可混读、不可比大小**
 *   （见文件头 2026-11-03 归口那一段）。
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
 * ★ **R6（`RECALL_VEC_ROWS`）的口径声明**（**必须落盘** ⇒ 读 JSON 的人**不会**把
 * 「推算」误读成「实测」）。
 *
 * ⚠️ ★ **为什么必须有它**（2026-11-02 架构师裁决）：
 *   「⚠️ **别让读 JSON 的人误以为它是实测。**」
 * ⇒ ⇒ **口径模式（`mode`）是显式的一个字段**，不是一个「读的人自己该知道」的隐含约定。
 *
 * ⚠️ ★★ **2026-11-03 归口之后，它声明的是「R6 那个量」的口径** —— **不是 H1 的**：
 *   H1/H2 的判据量在 `writeSegments.vectorCandidateRows`（写入探针 8/20，行数就是生产 SQL
 *   实际返回的行数 ⇒ **不存「推算」这种备选**）⇒ ⇒ 本类型**不参与任何红/绿判定**。
 */
export interface CandidateReadRowsBasis {
  /**
   * 口径模式：
   * · `'measured'` = **实测**：生产 SQL **实际物化**的行数（bench 侧行读计数器）；
   * · `'derived'` = **推算**：按「命中桶成员数之和」算出来的
   *   （⚠️ **它模型化了「桶内不设 LIMIT」这个实现** ⇒ **不可用它判任何门槛**）。
   */
  readonly mode: 'measured' | 'derived';
  /** 口径说明（**必须落盘** ⇒ 读的人不用猜）。 */
  readonly note: string;
  /**
   * **对照用**：同一次测量里的「推算值」（命中细桶的成员数之和）。
   *
   * ⚠️ **它模型化了「桶内不设 LIMIT」** ⇒ 阶段 4 引入桶内 LIMIT 后**它不会跟着降**
   * ⇒ ⇒ **保留它是为了让「实测 vs 推算」的差可见**，**不是**拿它判门槛。
   */
  readonly derivedCrossCheck: CountSummary | null;
  /**
   * **附加信息**：桶成员侧（`vector_cell_members`）**实际读到**的行数。
   *
   * ⚠️ **不判任何门槛**（H1 判的是**写入路径的候选行**；R6 判的是观测值）。
   */
  readonly bucketMemberRowsRead: CountSummary | null;
}

/**
 * ★★ **T06 · 一次采样的字节读数**（**逐样本**；落盘时压成分布）。
 *
 * ⚠️ ★ **为什么是「逐样本」而不是「全程一个总数」**：
 *   判据取 `max`（「单次写入」⇒ 每一次都要满足）⇒ ⇒ 必须**逐样本**采 ⇒ ⇒ 才能压出分布。
 */
export interface VectorByteSample {
  /** 物化的 `memories` 行数（窄读 + 向量）。 */
  readonly memoryRowsRead: number;
  /** 物化的 `vector_codes` 行数（Q2）。 */
  readonly codeRowsRead: number;
  /** **向量载荷字节**（`codeBytes + embeddingBytes`，零容差恒等式）。 */
  readonly bytesRead: number;
  /** 命中桶内的候选总数（写路径 = `scan.scanned`；读路径 = `COUNT(DISTINCT memory_id)`）。 */
  readonly candidateUniverse: number;
  /** 码字节之和（Σ `row.code.byteLength`）。 */
  readonly codeBytes: number;
  /** 向量字节之和（Σ `row.embedding.byteLength`）。 */
  readonly embeddingBytes: number;
  /** 正文字节（Q4 的 `content` + `content_tokens` 的 UTF-8 实测；**不在** `bytesRead` 里）。 */
  readonly contentBytes: number;
  /** **物化出 `embedding` 的行数**（字节账的分子；**含** Q4 的整行读）。 */
  readonly embeddingRowsRead: number;
  /** ★ **`scoreOf` 的 `get()` 返回了行的次数**（= `embeddingCalls` 减去白调用）。 */
  readonly embeddingExactRows: number;
  /** ★ **`scoreOf` 的 `get()` 调用次数**（**无条件**计数 ⇒ **剪枝率分子** ≡ `exactReads`）。 */
  readonly embeddingCalls: number;
  /** Q3 窄读行数（**0 字节**）。 */
  readonly narrowRowsRead: number;
  /** Q1 成员行数（**0 字节**进判据）。 */
  readonly bucketMemberRows: number;
  /**
   * ★ **由 `route()` 命中桶推算出来的成员行数之和**（**读路径专有**；写路径 = `null`）。
   *
   * ⚠️ ★★ **它是「读路径对账」的另一半**（口径裁决落地 #1）：
   *   · `bucketMemberRows` = **计数器实测**的成员行数（`search()` 真正扫的桶）；
   *   · `bucketMemberRowsDerived` = **`route()` 命中的桶**各自 `countBucketMembers()` 之和
   *     （**在计时窗口之外**算 ⇒ 不污染字节读数）。
   *   ⇒ ⇒ **两者逐样本相等** ⇒ ⇒ 证明「`search()` 看到的桶」与「`route()` 看到的桶」
   *     **是同一批** ⇒ ⇒ 落盘的 `candidateUniverse`（由 `route()` 的 `fineIds` 算）
   *     **对得上**实测的字节账。
   *   ⇒ ⇒ 不等 ⇒ **`search()` 与 `route()` 看到的不是同一批桶** ⇒ ⇒ 落盘的
   *     `candidateUniverse` 对不上 ⇒ ⇒ **不可判定 ⇒ 判红**。
   *
   * ⚠️ ★ **不许拿 `candidateUniverse` 当比较对象**：它是 `COUNT(DISTINCT memory_id)`
   *   ⇒ 一个记忆落在多个命中桶时它**小于**成员行总数 ⇒ ⇒ 1M 规模下**不成立**。
   */
  readonly bucketMemberRowsDerived: number | null;
  /** 码长 ≠ 768 的行数（**健康库恒 0** ⇒ 非 0 ⇒ 前提违例 ⇒ 判红）。 */
  readonly badCodeRows: number;
  /** **命中零来源**（未登记形状）的行数（**必须 0**）。 */
  readonly unclassifiedRows: number;
  /** 未登记语句的指纹集合（**打印 + 落盘**）。 */
  readonly unclassifiedSqlKinds: readonly string[];
  /** legacy 计数器的候选行数（**交叉校验 1b** 用；与 `memoryRowsRead` 在写路径相等）。 */
  readonly legacyCandidateRows: number;
  /** legacy 计数器的码行数（**交叉校验 1b** 用）。 */
  readonly legacyCodeRows: number;
}

/**
 * ★★ **T06 · 字节读数的 breakdown**（口径 §4 的 `breakdown`）。
 *
 * ⚠️ ★ **每一项都必须是 `CountSummary` 分布**（口径 §4：判据取 `max` 有值可取、
 *   且与既有 `vectorCandidateRows` 同形 ⇒ 「换口径不用重跑百万级」）。
 *
 * ⚠️ ★ **共 13 项**（口径 §4 的表里列了 12 项 ⇒ ⇒ **本轮多落了一项 `embeddingExactRows`**
 *   ⇒ ⇒ 口径若要写死清单 ⇒ **请把 `embeddingExactRows` 补进去**）。
 */
export interface VectorByteReadsBreakdown {
  /** 码字节之和（**进** `bytesRead`）。 */
  readonly codeBytes: CountSummary;
  /** 向量字节之和（**进** `bytesRead`）。 */
  readonly embeddingBytes: CountSummary;
  /** ★ **正文字节**（Q4 的 `content` + `content_tokens`）⇒ **不在** `bytesRead` 里 ⇒ 让「下界差多少」可见。 */
  readonly contentBytes: CountSummary;
  /** 物化出 `embedding` 的行数（字节账的分子）。 */
  readonly embeddingRowsRead: CountSummary;
  /** ★ **`scoreOf` 返回了行的次数**（= `embeddingCalls` 减去「白调用」）。 */
  readonly embeddingExactRows: CountSummary;
  /** ★ **`get()` 调用次数**（**剪枝率分子**；定义上 == `prune` 的 `exactReads`）。 */
  readonly embeddingCalls: CountSummary;
  /** Q3 窄读行数（**0 字节**）。 */
  readonly narrowRowsRead: CountSummary;
  /** Q1 成员行数（**0 字节**进判据）。 */
  readonly bucketMemberRows: CountSummary;
  /** 坏码行数（**健康库恒 0**；非 0 ⇒ 白读 ⇒ 前提违例 ⇒ 判红）。 */
  readonly badCodeRows: number;
  /** **命中零来源**的行数（**必须 0**；> 0 ⇒ 口径不完整 ⇒ 判红）。 */
  readonly unclassifiedRows: number;
  /** 未登记语句的指纹集合（**打印 + 落盘**）。 */
  readonly unclassifiedSqlKinds: string[];
  /** 剪枝率的分布（每样本 `embeddingCalls ÷ candidateUniverse`；判定取 `max`）。 */
  readonly pruneRate: CountSummary;
  /**
   * ★ **样本对齐**（断言 1d）。
   *
   * ⚠️ **写路径 = 两轮对齐**（轮 A 计时 / 轮 B 计量 ⇒ `candidateUniverse` 逐样本相等）
   *   ⇒ ⇒ **它有牙**：计量若扰动了扫描 ⇒ 两个候选宇宙不等 ⇒ 红。
   * ⚠️ ★★ **读路径 = 实测桶成员行 === 推算桶成员行**（口径裁决落地 #1）：
   *   · **实测** = 计数器认领的「成员来源」行数（`search()` 真正扫的桶）；
   *   · **推算** = `route()` 命中的桶各自 `countBucketMembers()` 之和；
   *   ⇒ ⇒ **逐样本相等** ⇒ ⇒ 「`search()` 看到的桶」与「`route()` 看到的桶」是同一批
   *     ⇒ ⇒ 落盘的 `candidateUniverse` 对得上实测字节账 ⇒ ⇒ **可判定**；
   *   ⇒ ⇒ **不等 ⇒ 不可判定 ⇒ 判红**。
   *
   * ⚠️ ★★★ **为什么不能是「字节样本数 == 计时样本数」**（**那条是恒真的**）：
   *   两个 `push` 在**同一个循环体内、无条件、无 `continue` / `break`** ⇒ 长度必然相等
   *   ⇒ ⇒ 那条比较**永远为 true** ⇒ ⇒ 它挂在判红守卫上却**永远打不红** ⇒ ⇒ **说谎**。
   *   ⇒ ⇒ 换成上面那个**真的会因为「两处看到的桶不是同一批」而变红**的量。
   */
  readonly samplesAligned: boolean;
}

/**
 * ★★ **T06 · 向量字节读数**（**四读数 + breakdown + note**；口径 §4）。
 *
 * ⚠️ ★ **四个读数用 ADR §8.5 的原名**（`memoryRowsRead` / `codeRowsRead` /
 *   `bytesRead` / `candidateUniverse`）⇒ **不另立名字** ⇒ 读旧 JSON 的人对得上账。
 */
export interface VectorByteReads {
  /** 物化的 `memories` 行数（窄读 + 向量）＝ ADR §8.5 的「原口径」。 */
  readonly memoryRowsRead: CountSummary;
  /** 物化的 `vector_codes` 行数（Q2 返回行数）。 */
  readonly codeRowsRead: CountSummary;
  /** ★ **向量载荷字节**（**唯一判据量**；H1′ / H2′ 都看它）。 */
  readonly bytesRead: CountSummary;
  /** 命中桶内的候选总数。 */
  readonly candidateUniverse: CountSummary;
  /** 来源分解（**13 项**）。 */
  readonly breakdown: VectorByteReadsBreakdown;
  /** 口径说明（**必须落盘** ⇒ 读的人不会把它误读成「一次真实写入的总字节」）。 */
  readonly note: string;
}

/**
 * ★ **写入路径的分段摘要**（旧键一个都没动；新增 `vectorByteReads`）。
 */
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
  /**
   * ★ **H1 / H2 的判据量（唯一）**：**写入去重路径**的**候选读取行数**的分布。
   *
   * ⚠️ ★★★ **口径（2026-11-03 归口 · `DECISIONS.md` D10）**：
   *   探针 = **写入路径那一组**（`ROUTER_NPROBE_WRITE_COARSE=8` / `ROUTER_NPROBE_WRITE_FINE=20`）；
   *   取数 = `collectVectorCandidates()` 里**生产 SQL 实际返回的行数**（`scan.scanned`）
   *   ⇒ ⇒ **这就是 §4.9 步骤 3a2 的「候选 ≤ 2000」同一口径** ⇒ **同一个库、同一个量、同一个被考核方**。
   * ⚠️ **为什么它就是「实测」而不再有 `derived` 备选**：
   *   `scanned` 本身就是「这条生产 SQL 返回了几行」——**它就是行数本身**，
   *   不存在「按桶成员数推算」的第二条取数路径 ⇒ 没有兜底、也没有「口径被悄悄换掉」的空间。
   * ⚠️ **代价**：它衡量的是「这一段扫描的候选面」，
   *   **不含**「扫描 + 逐条算 cos + 排序」的其余成本 ⇒ 那些在 `vectorCandidateScan`（耗时）里。
   */
  readonly vectorCandidateRows: CountSummary;
  /**
   * ★★ **T06 · 字节读数（★ H1′ / H2′ 的【唯一】判据量）**。
   *
   * ⚠️ ★★★ **口径**：本块 = **bench 的「写入扫描独立实测段」**
   *   （`collectVectorCandidates()` 那一笔 ⇒ 与旧 H1 的 `vectorCandidateRows`
   *   **同一笔**：同探针 8/20、同库、同被考核方）⇒ ⇒ **H1′ 与 H1 可比**。
   * ⚠️ ⚠️ **它【不是】`store.write()` 内部那一笔** —— 生产写入内部自己就会走向量候选扫描
   *   （`src/store/write.ts:671` → `collectDedupCandidates()` → `collectVectorCandidates()`）
   *   ⇒ 那一笔**不单独落盘**（已被 `writeTotal` 的计时覆盖）⇒ ⇒ **两笔都在，只有一笔是判据量**
   *   ⇒ ⇒ 详见 `vectorByteReads.note`。
   */
  readonly vectorByteReads: VectorByteReads;
  /** 写入总耗时（**实测**；就是 P99 用的那批样本）。 */
  readonly writeTotal: LatencyDistribution;
  /** 其余段（FTS5 + 索引维护 + 合并判定 + 事件写入）的**均值** —— **推导值**（毫秒）。 */
  readonly otherMeanMs: number;
  /** 其余段占写入总耗时的**均值**比例 —— **推导值**（0~1；**可能为负**，见 `note`）。 */
  readonly otherMeanShare: number;
  /** 口径说明（**必须落盘** ⇒ 这两个推导值不会被误读成实测值）。 */
  readonly note: string;
}

/**
 * ★ **new-path 档的一次性探针**（回答「向量路在召回里到底跑没跑」）。
 *
 * ⚠️ **为什么必须有它**（没有它，new-path 档的数字不可辩护）：
 *   `recall()` 的向量路有两个入口条件（**有 `queryEmbedding`  ∧  **端口可装配**）
 *   ⇒ 传了向量**仍可能整路缺席**（库规模 < 门槛 ⇒ `flat_auto` 走 flat；
 *   或 ≥ 门槛但桶未训练 ⇒ `absent` ⇒ 端口为 `null`）
 *   ⇒ **只看耗时差无法区分「向量路跑了但很快」与「向量路根本没跑」**
 *   ⇒ ⇒ 探针用 `diagnostics: true` 读 `explain.routes.vector` ⇒ **落盘成证据**。
 *
 * ⚠️ **探针跑在计时之外**（`diagnostics` 会多算一次 recall，且它本身有开销）
 *   ⇒ 它的耗时**不进任何 P99 样本**。
 */
export interface VectorPathProbe {
  /** 向量路**跑没跑**（`explain.routes.vector.ran`）。 */
  readonly ran: boolean;
  /** 向量路本次产出的**候选条数**（`explain.routes.vector.candidates`；`ran=false` ⇒ 0）。 */
  readonly candidates: number;
  /**
   * 后端**四态模式**（`stats().vectorBackend.mode`）：
   * `'ivf'` / `'flat_explicit'` / `'flat_auto'` / `'absent'` / `'unknown'`。
   *
   * ⚠️ **为什么要把模式一起落盘**：同样是 new-path 档，
   *   `mode='ivf'` 与 `mode='flat_auto'` 是**两条完全不同的性能故事**
   *   （后者 = 全表精确点积 ⇒ 百万级上必然慢）⇒ 不写模式 ⇒ 读的人会把 flat 的慢
   *   读成「接线本身慢」。
   * ⚠️ `'unknown'` = 读 `stats()` 抛错 ⇒ **不猜**（`stats()` 是观测面 ⇒ 它坏掉不该弄死测量）。
   */
  readonly mode: string;
  /** 口径说明（**必须落盘** ⇒ 读的人知道这是探针，不是测量样本）。 */
  readonly note: string;
}

/**
 * ★ **new-path 档（传 `queryEmbedding` 的召回）的读数** —— 与 old-path 档**并列落盘**。
 *
 * ⚠️ **键名纪律**：本对象用**新键** `recallVectorPath`；old-path 档继续用原有的
 *   `recallLatency` / `recallP99Ms` / `recallSamples`
 *   ⇒ ⇒ 有脚本 / 文档在读旧键（`docs/baseline/*.json`）⇒ **旧键一个都不许改名或挪位**。
 */
export interface RecallVectorPathSummary {
  /** new-path 档的样本数（**必须与 old-path 同批查询**；0 ⇒ 本档缺席）。 */
  readonly samples: number;
  /** new-path 档的耗时分布（**整条召回**，含向量路）。 */
  readonly latency: LatencyDistribution;
  /** new-path 档 P99（毫秒；便于与 old-path 的 `recallP99Ms` 并排读）。 */
  readonly p99Ms: number;
  /** new-path 档均值（毫秒）。 */
  readonly meanMs: number;
  /** old-path 档均值（毫秒）——**同一次运行内**量与它比 ⇒ 读的人不必自己回算。 */
  readonly oldPathMeanMs: number;
  /** `meanMs − oldPathMeanMs`（毫秒；**正数 = 接线后更慢**）。 */
  readonly meanDeltaMs: number;
  /**
   * 「向量扫描本身」占 new-path 整条召回的**均值比例**（0~1；**推导值**）。
   *
   * ⚠️ **分子与分母来自同一次运行**（`vectorRouteLatency.meanMs` ÷ 本档 `meanMs`）
   *   ⇒ 这条推导才有意义；⚠️ 两者**不是同一次调用**（向量扫描是独立跑的一遍）
   *   ⇒ 它只能当归因的量级参考，**不是**精确拆分。
   * ⚠️ `null` ⇒ new-path 均值为 0（本档缺席）⇒ **不是「占比为 0」**。
   */
  readonly vectorScanShareOfNewPath: number | null;
  /**
   * **一次性探针**（采样**之后**、计时窗口**之外**跑；`diagnostics: true`）。
   *
   * ⚠️ **为什么放在采样之后**：探针要回答「刚刚那批样本里向量路跑没跑」
   *   ⇒ 先跑探针再采样 ⇒ 探针可能**自己**把页缓存 / 端口装配预热掉 ⇒
   *   两档读数都被它改变；放在采样之后 ⇒ 它**碰不到**任何已落盘的样本。
   */
  readonly probe: VectorPathProbe;
  /** 口径说明（**必须落盘**）。 */
  readonly note: string;
}

/** 一次 P99 测量的结果。 */
export interface PerfResult {
  /** 语料规模（**实测**）。 */
  readonly corpusSize: number;
  /** recall 的样本数（**报告必须写明**）。 */
  readonly recallSamples: number;
  /**
   * ★ **new-path 档（传 `queryEmbedding` 的召回）** —— 与 old-path 档并列。
   *
   * ⚠️ **old-path 档在 `recallLatency` / `recallP99Ms` / `recallSamples`**（原有键，未改）
   *   ⇒ 本字段是**新增的对照档**，不是替换。
   */
  readonly recallVectorPath: RecallVectorPathSummary;
  /**
   * ★ **「向量扫描」口径声明**（`vectorRoute*` / `candidateReadRows` 那几块的口径）。
   *
   * ⚠️ **必须落盘**：`vectorRouteLatency` 是「直接调 `backend.search()`」的耗时
   *   ⇒ 它**不含**文本路 / 图谱路 / 打分 / 排序 ⇒ **它不是召回读数**
   *   ⇒ 不声明，读的人会把它与 `recallVectorPath` 混成一个数。
   */
  readonly vectorScanNote: string;
  /** 写入的样本数。 */
  readonly writeSamples: number;
  /** ★ **第一条被计入统计的写入耗时**（毫秒）—— 冷启动是否已被预热掉的证据。 */
  readonly firstWriteMs: number;
  /** 向量路的样本数。 */
  readonly vectorRouteSamples: number;
  /** 预热轮次（**不计入统计**）。 */
  readonly warmupRounds: number;
  /**
   * recall P99（毫秒）—— ★ **old-path 档**（不传 `queryEmbedding` ⇒ 向量路整段不执行）。
   *
   * ⚠️ **这是对照组**（接线前的形状）⇒ 键名保持原样，**不许改**。
   *   new-path 档见 `recallVectorPath.p99Ms`。
   */
  readonly recallP99Ms: number;
  /** 写入 P99（毫秒）。 */
  readonly writeP99Ms: number;
  /** 向量路 P99（毫秒）。 */
  readonly vectorRouteP99Ms: number;
  /** 向量路占总耗时（0~1）。 */
  readonly vectorRouteShare: number;
  /**
   * ★ **R6（`RECALL_VEC_ROWS`）的观测值**：**召回路径**（探针 20/50）的**候选读取行数**的分布。
   *
   * ⚠️ ★★★ **2026-11-03 归口之前它被当成 H1 的判据量 ⇒ 那是错的**（详见文件头）：
   *   它是**召回探针 20/50** 采的量，而门槛 2,000 的出处是**写入探针 8/20**
   *   ⇒ 拿一个召回侧的量去撞写入侧的线 ⇒ 把「桶倾斜 + 探针错位」混报成「写入路径超了 6.39 倍」。
   * ⇒ ⇒ **现在它只观测、不设门槛、不判红绿**（`checkPerf()` 一个字都不引用它）。
   * ⚠️ ⚠️ **但「没有门槛可判」绝不等于「达标」**：1M 实测 max = **12,782 行**
   *   = 门槛 2,000 行的 **6.39 倍** ⇒ **读数仍然红**，只是**它的主语是召回路径**。
   * ⚠️ **口径细节见 `candidateReadRowsBasis`**（**必须落盘** ⇒ 读的人不会误读）。
   * ⚠️ **键名不改**（读旧 JSON 的脚本靠它对账）⇒ 只把「它是 R6」写进这里与 `gateRegrouping`。
   */
  readonly candidateReadRows: CountSummary;
  /**
   * ★ **R6 的口径声明**（**实测还是推算** ⇒ 读 JSON 的人不会误读）。
   *
   * ⚠️ **必须在落盘的 JSON 里**（与 `candidateReadRows` 并排）⇒ **不许假装它是实测**。
   * ⚠️ ★ **它不参与任何红/绿判定**（2026-11-03 归口）⇒ H1/H2 的口径见 `writeSegments`。
   */
  readonly candidateReadRowsBasis: CandidateReadRowsBasis;
  /** 每次查询命中的**细桶数**的分布（探针口径的可核对证据）。 */
  readonly hitFineBuckets: CountSummary;
  /**
   * ★ **每行读成本**（微秒/行）—— **推导值，不是直接测量值**。
   *
   * ⚠️ **推导式**：`向量路均耗时(ms) × 1000 ÷ 候选读取行数均值`
   *   ⇒ 它把「路由 + 点积 + 行读」**全部**摊到候选行上 ⇒
   *   **不是**纯粹的「磁盘读一行要多久」⇒ 读它的时候要记住这一点。
   * ⚠️ **分子分母必须同属「召回路径」**（分子 = `vectorRouteLatency`（召回探针 20/50 的扫描），
   *   分母 = `candidateReadRows.mean`（同一路 ⇒ **R6 那一组**））⇒ **不许拿 H1 的写入路径行数当分母**
   *   （那会把两个探针配置混成一个比值 ⇒ 这正是 2026-11-03 归口要消灭的那类错位）。
   * ⚠️ **`null` ⇒ 候选行数为 0**（分桶尚未训练 ⇒ 向量路整体缺席）⇒ 不是「成本为 0」。
   */
  readonly perRowReadCostUs: number | null;
  /**
   * ★★ **T06 · 召回路径的字节读数**（**观测值，不判门槛**）。
   *
   * ⚠️ ★ **为什么放顶层而不塞进 `recallVectorPath`**（口径 §4）：
   *   `recallVectorPath` 是「new-path 档**整条召回**的 old vs new 时序对比」
   *   ⇒ **字节数不参与那个对比** ⇒ 塞进去会 mislead
   *   ⇒ ⇒ 而字节读数的采样窗口**正是** `candidateReadRows` 那个（`backend.search()`，探针 20/50）
   *   ⇒ ⇒ **与同组读数放一起**才不拆散。
   * ⚠️ **它不判红绿**（与 R6 同组：观测值）⇒ 判据只在 `writeSegments.vectorByteReads`。
   */
  readonly vectorRouteByteReads: VectorByteReads;
  /** ★ **写入路径的分段计时**（见 `WriteSegmentSummary` 的口径说明）。 */
  readonly writeSegments: WriteSegmentSummary;
  /** recall 的耗时分布 —— ★ **old-path 档**（不传 `queryEmbedding`）；new-path 见 `recallVectorPath.latency`。 */
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
 * ★ **「向量扫描本身」的口径声明** —— 落盘字段 `vectorScanNote`。
 *
 * ⚠️ **为什么必须是一段落盘的文字**（而不是只写在文件头注释里）：
 *   文件头注释**不会随 JSON 一起走**（`docs/baseline/*.json` 会被单独读、单独引用）
 *   ⇒ 只在文件头声明 ⇒ 读 JSON 的人**看不到这条边界** ⇒ 必然把
 *   `vectorRouteLatency`（向量扫描）读成「召回耗时」⇒ 两条数被混成一个结论。
 *   ⇒ ⇒ 口径**跟着数据走**：声明必须是 JSON 的一个字段。
 */
export const VECTOR_SCAN_NOTE: string =
  '① ★ **本段（`vectorRouteLatency` / `vectorRouteP99Ms` / `vectorRouteSamples` / ' +
  '`candidateReadRows` / `hitFineBuckets` / `perRowReadCostUs`）测的是「向量扫描本身」**：' +
  '它**直接调** `IvfVectorBackend.route()` + `search()`（**绕过 `recall()`**）' +
  '⇒ 量的是「**向量扫描（含路由 + 闸门过滤）这一段自己花多少**」，' +
  '**不含**文本路 / 图谱路 / 五路打分 / 侧抑制 / 排序 ⇒ ⇒ **它不是召回读数**；' +
  '② **它回答的问题与 new-path 档不同**：它对应文档里的 **R6 / `RECALL_VEC_ROWS`** 口径 ' +
  '（「向量扫描这一步要读多少行、多重」），而 `recallVectorPath`（new-path 档）' +
  '回答「**一次召回总共多重**」⇒ **两条数回答两个不同问题，绝不可互换、不可相加**；' +
  '③ 「向量路在一次召回里占多少」只能用 **同一次运行内**的推导值 ' +
  '`recallVectorPath.vectorScanShareOfNewPath`（= 本段 `meanMs` ÷ new-path 档 `meanMs`）' +
  '—— 那两个数来自同一次运行，但**不是同一次调用**（见 ④）；' +
  '④ ⚠️ **为什么保留「独立跑一遍向量扫描」而不在 `recall()` 内部插桩**：' +
  'bench **不改 `src/**`**（本轮纪律）⇒ 拿不到召回内部的段计时 ⇒ 分档归因只剩' +
  '「独立跑一遍」这一条路 ⇒ ⇒ 保留它；代价是**分子（扫描）与分母（整条召回）不是同一次调用**' +
  '⇒ 该比例**只作归因的量级参考**，**不是精确拆分**（精确拆分要在 `src/store/recall.ts` 里加观测点）。';

/**
 * ★ **门槛归口的落盘声明**（JSON 字段 `gateRegrouping`）—— 2026-11-03 的 `D10` 裁决。
 *
 * ⚠️ **为什么必须是一个 JSON 字段**（而不是只写在文件头注释里）：
 *   `docs/baseline/*.json` 会被单独读、单独引用、单独贴进报告
 *   ⇒ 只在文件头声明 ⇒ 读 JSON 的人**看不到这条边界** ⇒ 必然把
 *   `candidateReadRows`（**召回**路径）当成 H1 的判据量 ⇒ **两套词又回来了**。
 *   ⇒ ⇒ 口径**跟着数据走**。
 *
 * ⚠️ **为什么键名一个都不改**（`candidateReadRows` / `vectorCandidateRows` / `thresholds.*`）：
 *   有脚本 / 文档在读旧 JSON 的旧键 ⇒ 改名 = 让**同一个量**在两个版本里叫两个名字
 *   ⇒ ⇒ 本轮新增**说明字段**，不动**数据字段**（数据字段的语义由本字段解释）。
 */
export interface GateRegrouping {
  /** 归口裁决的日期（ISO 日期串）。 */
  readonly decidedAt: string;
  /** 裁决编号（`docs/design/DECISIONS.md`）。 */
  readonly decision: string;
  /** 正文出处（含节号 ⇒ 读的人能一次读到原文）。 */
  readonly source: string;
  /** **H1 / H2 的判据量**（JSON 里的路径写法 ⇒ 机器可读）。 */
  readonly h1h2Quantity: string;
  /** **H1 / H2 的考核主体**（探针配置一起写死 ⇒ 不会「同一个量两套探针」）。 */
  readonly h1h2Subject: string;
  /** **R6 的量**（召回路径的同名量 ⇒ 现在是观测值）。 */
  readonly r6Quantity: string;
  /** **R6 的性质**（一句话：不设门槛、不判红绿 ⇒ **但不是达标**）。 */
  readonly r6Status: string;
  /** 口径说明（**必须落盘** ⇒ 读 JSON 的人不用猜，也不会混读）。 */
  readonly note: string;
}

/**
 * ★ **门槛归口的落盘声明**（`D10` · 2026-11-03）—— 写进每一份 perf JSON。
 *
 * ⚠️ **三条必须同时在场**（少一条就足够让人读错）：
 *   ① 归口的**日期与出处**；② **H1/H2 判哪一块**；③ **`candidateReadRows` 是 R6 观测值**。
 */
export const GATE_REGROUPING: GateRegrouping = {
  decidedAt: '2026-11-03',
  decision: 'D10（H1 归口拆分）',
  source: 'docs/design/DESIGN-v2-errata.md §11.8 勘误 ⑫ / docs/design/DECISIONS.md 的 D10',
  h1h2Quantity:
    'writeSegments.vectorCandidateRows（★ **已降级为并列观测**）⇒ ★ **现行判据量 = ' +
    'writeSegments.vectorByteReads.bytesRead（★ H1′ · 判定取 max）**',
  h1h2Subject:
    '写入去重路径（探针 ROUTER_NPROBE_WRITE_COARSE=8 / ROUTER_NPROBE_WRITE_FINE=20）；' +
    '⚠️ **旧行数门槛 ≤ 2000 行 / ≤ 0.2% 与判定方式（取 max）一个都没删**（仍在本文件里），' +
    '但 ★ **字节口径下它们已不是判据**（H1′ = ≤ 6,144,000 B / ≤ 0.2%）',
  r6Quantity:
    'candidateReadRows（召回路径 · 探针 ROUTER_NPROBE_COARSE=20 / ROUTER_NPROBE_FINE=50）',
  r6Status: '观测值：本轮不设门槛、不判红绿',
  note:
    '① **2026-11-03 归口**（`D10`）：H1/H2 的考核主体收窄到「**写入去重路径**」——' +
    '门槛 2,000 行的出处本来就是写入路径（§4.9 步骤 3a2 的「候选 ≤ 2000」）' +
    '⇒ ⇒ 判据量与门槛**同源**；' +
    '② **H1/H2 的判据量 = `writeSegments.vectorCandidateRows`**' +
    '（写入探针 8/20 · 取的是生产 SQL 实际返回的行数 ⇒ 实测，无「推算」备选）；' +
    '③ ⚠️ **`candidateReadRows` = R6（`RECALL_VEC_ROWS`）的观测值**（召回探针 20/50），' +
    '**不设门槛、不判红绿** ⇒ ⇒ **但「没有门槛可判」绝不等于「达标」**：' +
    '1M 实测里它的 max = 12,782 行 = 门槛 2,000 行的 **6.39 倍** ⇒ **读数仍然红**，' +
    '只是它**不再冒充「写入路径超了 6.39 倍」**；' +
    '④ ⚠️ **两组量的探针配置不同**（8/20 vs 20/50）⇒ **不可混读、不可比大小**' +
    '（「2.76 倍」与「6.39 倍」是**两个不同的量各自有数**，不是一个数在改善）；' +
    '⑤ ⚠️ **归口 ≠ 达标**：H1 在 1M 实测里是 5,521 行 = 门槛的 **2.76 倍 ⇒ 仍红**' +
    '⇒ 这次改的是**主语**，不是门槛；' +
    '⑥ ⚠️ ★★ **T06（2026-11-05）追加**：**旧行数判据已降级为并列观测**（仍落盘、仍打印，' +
    '但**不再进 `failures`**）⇒ ★ **唯一判据 = `writeSegments.vectorByteReads.bytesRead`**（H1′，' +
    '≤ 6,144,000 B）⇒ 阈值常量 `candidateReadRowsMax` / `candidateReadRowsRatioMax` **一个都没删**。',
};

/**
 * ★ **new-path 档的一次性探针**：证实「传了 `queryEmbedding` 之后向量路真的在
 * `recall()` 内部跑了」。
 *
 * ⚠️ **为什么需要它**（没有它，new-path 档的读数不可辩护）：见 `VectorPathProbe` 的说明
 *   —— 传了向量**仍可能整路缺席**（库小 ⇒ `flat_auto`；桶未训练 ⇒ `absent`）
 *   ⇒ **只看耗时差无法区分「向量路跑了但很快」与「向量路根本没跑」**。
 *
 * ⚠️ **只跑一次**（第一条查询）⇒ 它是**存在性证据**，不是统计量
 *   ⇒ 它的耗时**不进任何 P99 样本**（`diagnostics: true` 本身有开销）。
 *   ⚠️ 用 `diagnostics` 而**不是** `explain`：前者**不写** `recall` 事件
 *   ⇒ 探针不会污染被测库（`explain` 会写一条事件 ⇒ 多一次写放大）。
 *
 * @param store 生产门面（**与计时用的是同一个实例** ⇒ 状态一致）
 * @param queries 查询集（取第 0 条；**空集 ⇒ 探针无从执行**）
 * @param queryVectors **已经转成 `number[]`** 的查询向量（与计时用的是同一批）
 * @returns 探针结果（**永不抛错** ⇒ 观测面坏掉不该弄死测量）
 */
export function probeVectorPathOfRecall(
  store: MemoryStore,
  queries: readonly BenchQuery[],
  queryVectors: readonly number[][],
): VectorPathProbe {
  // ① **先取后端四态模式**：它不依赖 `recall()` 成功与否 ⇒ 即使探针跑挂也能落盘。
  //    ⚠️ `stats()` 抛错 ⇒ `'unknown'`（**不猜**；`stats()` 是观测面）。
  let mode = 'unknown';
  try {
    mode = store.stats(BENCH_NOW).vectorBackend.mode;
  } catch {
    mode = 'unknown';
  }

  const query = queries[0];
  const queryVector = queryVectors[0];
  if (query === undefined || queryVector === undefined) {
    return {
      ran: false,
      candidates: 0,
      mode,
      note:
        '⚠️ 本轮**没有查询**（`--queries=0`）⇒ 探针无从执行 ⇒ `ran=false` 是**未测**，' +
        '**不代表**向量路缺席。',
    };
  }

  // ② **真的调一次带向量的召回**（`diagnostics: true` ⇒ 只读诊断、不记事件）。
  let ran = false;
  let candidates = 0;
  let note: string;
  try {
    const result = store.recall({
      context: query.context,
      queryEmbedding: queryVector,
      now: BENCH_NOW,
      diagnostics: true,
    });
    const vectorRoute = result.explain?.routes.vector;
    ran = vectorRoute?.ran === true;
    candidates = vectorRoute?.candidates ?? 0;
    note =
      '① **存在性证据**（只跑 1 次、取第一条查询）⇒ 不是统计量，耗时不计入任何 P99；' +
      '② `ran=true` ⇒ 该次召回的 `explain.routes.vector.ran === true`' +
      '⇒ 向量路**真的在 `recall()` 内部执行了**（不是「传了向量但被入口条件挡掉」）；' +
      '③ `ran=false` ⇒ 该次召回**向量路整路缺席**，原因看 `mode`：' +
      '`flat_auto`（库规模 < `ROUTER_MIN_TRAINING` ⇒ 全表精确点积）/ ' +
      '`absent`（过了门槛但桶未训练）/ `flat_explicit`（调用方显式选了 flat）；' +
      '④ ⚠️ `mode` 与 `ran` 是**两个观测面**（`stats()` 说「后端处于哪一态」，' +
      '`explain` 说「这一次跑没跑」）⇒ 若 `mode=ivf` 而 `ran=false`，说明**入口条件另有拦口**' +
      '（如查询向量不合法被丢弃）⇒ **必须查**，不能当成「偶然」；' +
      '⑤ ⚠️ `diagnostics: true`（**不是** `explain: true`）⇒ 探针**不写** `recall` 事件' +
      '⇒ 不污染被测库的写放大。';
  } catch (error) {
    // ⚠️ **探针自己跑挂 ≠ 向量路缺席**：这两件事必须分开说，否则读数会被误判。
    note =
      `⚠️ 探针本身抛错（${error instanceof Error ? error.message : String(error)}）⇒ ` +
      '这一条**不是**「向量路缺席」的证据，它只说明**探针跑挂了**' +
      '⇒ new-path 档的耗时读数仍有效，但「向量路跑没跑」**未证实**。';
  }
  return { ran, candidates, mode, note };
}

/**
 * ★ **写路径一次扫描的行读读数**（T06 第一段的观测产物；**计量轮**那一笔）。
 *
 * ⚠️ ★ **为什么是「行数」而不是「字节数」**：
 *   「**字节怎么算**」由架构师裁决（`bytesRead` 的口径 · 每类行的字节系数 · 落盘字段名）
 *   ⇒ ⇒ **本段只负责「把每一类读了多少行」采到**（口径 = 生产 SQL **实际物化**的行数）
 *   ⇒ ⇒ **不许在这里乘任何字节系数**（那会变成第二套字节口径 ⇒ 两套账必然漂移）。
 *
 * ⚠️ **这几个数对应写路径（两段式）的四段读**：
 *   · `candidateUniverse` = **候选宇宙**（`scan.scanned` = 命中桶的成员数；**不是**读出来的行数）
 *     —— ⚠️ 它与 `writeSegments.vectorCandidateRows` 是**同一个量**（架构师 §10.1 的「有意的冗余」）；
 *   · `bucketMemberRows` = **Q1**（`vector_cell_members`）；
 *   · `codeRows` = **Q2**（`vector_codes` 的 int8 码池）；
 *   · `candidateRows` = **`memories` 侧的行读**（`scoreOf` 的逐条读 + Q4 survivors 整行读）
 *     —— ⚠️ **写路径里它恰好等于架构师口径的 `memoryRowsRead`**（写路径不发 Q3 窄读）。
 */
export interface WritePathReadSample {
  /** 候选宇宙（`scan.scanned` = 命中桶的**成员数**；⚠️ **不是**读出来的行数）。 */
  readonly candidateUniverse: number;
  /** **Q1**：桶成员行（`vector_cell_members`）。 */
  readonly bucketMemberRows: number;
  /** **Q2**：码行（`vector_codes` 的 int8 码池）。 */
  readonly codeRows: number;
  /**
   * **`memories` 侧的行读**（`scoreOf` 的逐条读 + Q4 survivors 整行读）。
   *
   * ⚠️ ★ **已知缺口（留给 T06 第二段）**：**Q3 的窄列读也会被算在这里**
   *   （`readGateColumns()` 的 `SELECT id, last_access, pin_factor FROM memories …`
   *   ⇒ 含 `FROM memories` ⇒ 被认成候选行）
   *   ⇒ ⇒ **本数目前是「Q3 + Q4 + `scoreOf`」的合计**，**不是**纯 Q4
   *   ⇒ ⇒ 架构师裁决「按 SQL 分别累计字节」（`byteSources.ts` 的第二结论）之后，这一项必须拆开。
   *   ⚠️ **写路径当前不发 Q3**（窄列 gate 只在读路径用）⇒ ⇒ **在写路径上本数 == `memoryRowsRead`**。
   */
  readonly candidateRows: number;
}

/**
 * ★ **`measurePerf` 的测量选项**（**仅测试用的注入点**）。
 */
export interface PerfMeasurementOptions {
  /**
   * ★ **仅测试用**：让行读计数器「**装了但不计数**」⇒ 实测值恒为 0
   * ⇒ ⇒ 用来验证「**计数器失效 ⇒ 兜底必须把 `mode` 标成 `derived`**」这条纪律。
   *
   * ⚠️ **为什么必须有这个注入点**（门禁必须有「牙」）：
   *   「实测 == 推算」这个恒等式在**当前实现下天然成立**
   *   ⇒ ⇒ **任何以它为断言的测试，对「口径被悄悄换掉」这类变异天然失明**
   *   ⇒ ⇒ **必须能人为制造「实测拿不到」的场景** ⇒ **本选项就是它**。
   *
   * ⚠️ **生产路径不传这个选项** ⇒ **零影响**（默认值 `false` ⇒ 计数照常）。
   */
  readonly disableRowReadCounter?: boolean;
  /**
   * ★ **仅测试用**：**写路径计数窗口**的观测钩子（`measurePerf()` 跑完写路径扫描后回调一次，
   * 参数 = 每一次写路径扫描各读到多少行）。
   *
   * ⚠️ ★ **为什么需要它**（T06 第一段）：
   *   「**计数器窗口覆盖写入路径**」这件事**在返回值里看不见**（本段**不落盘**——
   *   落盘字段的名字与层级由架构师裁决 ⇒ **不许在这一段抢先定**）
   *   ⇒ ⇒ 没有钩子的话，这条改动**无法被测试证伪**（窗口开不开、罩没罩住，都没人能问）
   *   ⇒ ⇒ **钩子是本段唯一的可观测出口**（**它只送样本，不改任何判定**）。
   *
   * ⚠️ **它不参与任何红/绿判定**（⇒ 与 `disableRowReadCounter` 一样是**注入点**，
   *   **不是**生产路径的开关 ⇒ 生产路径不传 ⇒ 零影响）。
   */
  readonly onWritePathReads?: (samples: readonly WritePathReadSample[]) => void;
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
 * @param measurementOptions 测量选项（**仅测试用的注入点** ⇒ 生产路径省略）
 * @returns 测量结果
 */
export function measurePerf(
  db: Database.Database,
  store: MemoryStore,
  options: CorpusOptions,
  queryCount: number,
  writeCount: number,
  measurementOptions: PerfMeasurementOptions = {},
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
  // ★ **new-path 档的样本**（传 `queryEmbedding` ⇒ 向量路在召回内部真的跑）。
  const recallVectorSamples: number[] = [];
  const writeSamples: number[] = [];
  const vectorRouteSamples: number[] = [];
  // ★ **R6（召回路径）的两个计数样本**（候选读取行数 / 命中细桶数）
  //   ⚠️ 2026-11-03 归口之后：**这两个数不再参与任何红/绿判定**（H1/H2 判的是写入路径，
  //   见下方的 `writeVectorScanRowSamples`）⇒ 它们仍然采样、仍然落盘 ⇒ **只当观测值**。
  const candidateRowSamples: number[] = [];
  const hitBucketSamples: number[] = [];
  // ★ **推算口径的对照样本**（命中细桶的成员数之和 ⇒ **模型化了「桶内不设 LIMIT」**）。
  const candidateRowDerivedSamples: number[] = [];
  // ★ **桶成员侧的行读样本**（附加信息；**不判任何门槛**）。
  const bucketMemberRowSamples: number[] = [];
  // ★ **写入路径的分段计时**：向量候选扫描段的样本（P2 的代码）。
  //   ⚠️ ★★★ `writeVectorScanRowSamples` 就是 **H1/H2 的判据量**（2026-11-03 归口）：
  //   写入探针 8/20 ⇒ 与门槛 2,000 的出处**同源**（§4.9 步骤 3a2）。
  const writeVectorScanSamples: number[] = [];
  const writeVectorScanRowSamples: number[] = [];
  // ⚠️ ★★ **T06 · 写路径两轮制的候选宇宙样本**（轮 A 计时 / 轮 B 计量）
  //   ⇒ ⇒ **逐样本相等** = `samplesAligned`（口径 §2 断言 1d ⇒ 它证明「计量没有扰动扫描」）。
  //   ⚠️ **读路径【没有】这两个数组** ⇒ 因为读路径是**单轮**（字节与毫秒同源 ⇒ 天然绑定）。
  const writeUniverseSamples: number[] = [];
  const writeUniverseSamplesB: number[] = [];
  // ⚠️ ★★ **T06 · 读路径的字节样本**（**单轮**：与计时窗口**同一个**执行 ⇒ 天然绑定）。
  const readByteSamples: VectorByteSample[] = [];

  // ⚠️ ★★★ **行读计数器**（H1 的「实测口径」的取数装置 —— **bench 侧只读观测，不改 `src/**`**）。
  //   ⇒ 它统计**生产 SQL 实际物化**了多少候选行 ⇒ ⇒ **对任何实现都成立**
  //   （阶段 4 引入「桶内 LIMIT」/「两段式读」⇒ 这个数**会跟着降** ⇒ 不再有假红）。
  const rowCounter = installRowReadCounter(db, {
    forceDisabled: measurementOptions.disableRowReadCounter === true,
  });

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
  //
  // ★★ **new-path 档的查询向量必须在计时之外先转好**：
  //   ⚠️ `bench/corpus.ts` 的 `BenchQuery.embedding` 是 **`Float32Array`**，
  //   而 `RecallOptions.queryEmbedding` 要的是 **`number[]`** ⇒ **必须先 `Array.from()`**：
  //   · **不许 `as` 强转**：`Float32Array` 与 `number[]` 不是同一类对象，
  //     强转只是把错误推迟到运行时；而 `normalizeQueryEmbedding()` 按下标读时
  //     TypedArray **碰巧也能读** ⇒ 这类错误会**静默**通过（`Array.isArray()` 才是判据，
  //     强转骗不过它，但骗得过「先跑起来看看」）⇒ ⇒ 早晚在换实现时炸；
  //   · **也不许在计时窗口里转**：转换是**调用方**的成本（生产里向量由调用方算好再传进来），
  //     计入就污染 P99 ⇒ ⇒ 一次转好，两档共用。
  const queryVectors: number[][] = queries.map((query) => Array.from(query.embedding));

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
    // ★ **new-path 档也要预热**（同一条理由：JIT + 页缓存 + 后端对象的首次分配
    //   + 四态判定的首次 count）⇒ 不预热 ⇒ new-path 的 P99 会被「第一轮的冷启动」主导
    //   ⇒ 那时两档的差是「预热差」而不是「接线差」。
    const warmVector = queryVectors[round % Math.max(1, queryVectors.length)];
    if (warmVector !== undefined) {
      store.recall({ context: '预热', queryEmbedding: warmVector, now: BENCH_NOW });
    }
    const warmContent = `预热写入第${round}条、独立的正文、不与语料重复`;
    store.write({
      content: warmContent,
      embedding: Array.from(embedText(warmContent)),
      now: BENCH_NOW,
    });
  }

  // ── recall · **两档并列测**（old-path = 生产的 `MemoryStore.recall()`，不传向量）──
  // ★ old-path 档：`store.recall({ context, now })` —— **这一行是接线前的形状，原样保留**
  //   （删它就永久丢失对照组 ⇒ 「接线前后快慢」再也测不出来）。
  // ★ new-path 档：`store.recall({ context, queryEmbedding, now })` —— 向量路在召回内部跑。
  //
  // ⚠️ ★ **两档在同一轮里背靠背跑，且**按查询序号**轮换先后顺序**（偶数 old 先 / 奇数 new 先）：
  //   · **为什么背靠背**（而不是「先跑完 200 条 old、再跑 200 条 new」）：中间隔几分钟，
  //     页缓存 / SQLite 的 WAL 检查点 / 后台合并都可能变化 ⇒ 两档就不是同一条时间线上的数；
  //   · **为什么必须轮换顺序**：先跑的那一档要**替后跑的那一档**装载页缓存
  //     ⇒ 固定顺序 ⇒ 后跑的一档被系统性优待（读数偏乐观）⇒ 而本档要回答的正是「这两档谁快」
  //     ⇒ ⇒ 顺序偏置必须**对称掉**（各占一半）⇒ 剩下的差才可辩护。
  //   · **代价（诚实记）**：new-path 档的召回会顺带把文本路 / 图谱路的缓存也带热
  //     （两档共用同一条文本路）⇒ 两档的差里含「向量路之外的热身差异」；
  //     但这条差异**方向固定且远小于向量路本身**，且 old-path 档的绝对读数不受影响。
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    if (query === undefined) {
      continue;
    }
    const queryVector = queryVectors[index] ?? [];
    /** old-path 档的一次采样（**不传 `queryEmbedding`** ⇒ 向量路整段不执行）。 */
    const sampleOldPath = (): void => {
      const start = process.hrtime.bigint();
      store.recall({ context: query.context, now: BENCH_NOW });
      const end = process.hrtime.bigint();
      recallSamples.push(Number(end - start) / 1_000_000);
    };
    /** new-path 档的一次采样（**传 `queryEmbedding`** ⇒ 向量路在召回内部跑）。 */
    const sampleNewPath = (): void => {
      const start = process.hrtime.bigint();
      store.recall({ context: query.context, queryEmbedding: queryVector, now: BENCH_NOW });
      const end = process.hrtime.bigint();
      recallVectorSamples.push(Number(end - start) / 1_000_000);
    };
    if (index % 2 === 1) {
      // 奇数轮：new-path 先跑（对称掉「后跑者得利」）。
      sampleNewPath();
      sampleOldPath();
    } else {
      // 偶数轮：old-path 先跑（对照组不因新档的改动而系统性变慢）。
      sampleOldPath();
      sampleNewPath();
    }
  }

  // ★ **一次性探针（采样之后、计时窗口之外）**：证实「new-path 档里向量路真的跑了」。
  //   ⚠️ **为什么不放在采样之前**：探针自己会装载页缓存 / 装配端口 ⇒ 放前面会**改变**
  //   两档的采样条件（尤其 old-path 档）⇒ ⇒ 放后面，它碰不到任何已落盘的样本。
  const vectorPathProbe = probeVectorPathOfRecall(store, queries, queryVectors);

  // ── 向量路（**生产后端**：route + search）──
  // ⚠️ ★★★ **这一段采的量 = R6（`RECALL_VEC_ROWS`）的观测值**（**不是 H1 的判据量**）：
  //   · 探针是**召回那一组**（`ROUTER_NPROBE_COARSE=20` / `ROUTER_NPROBE_FINE=50`）；
  //   · 2026-11-03 归口之后**它不参与任何红/绿判定** ⇒ ✅ 只落盘、只打印。
  //   ① `route()` 给出**命中的细桶 id**（生产后端的公开 API ⇒ 拿到的就是
  //      `search()` 内部用的那批桶 ⇒ 路由是确定性的 ⇒ 两次必然一致）；
  //   ② ★ **实测**：`search()` 内部的生产 SQL **实际物化**了多少**候选行**
  //      ⇒ 由**行读计数器**统计 ⇒ 与「H1 的写入路径那个数」**是两条不同的数**（探针不同）；
  //   ③ **推算**（只作对照）：命中细桶的成员数之和
  //      （= 「桶内全量精确点积」要读的行数；桶内**不设 LIMIT**，§4.15.3）
  //      ⇒ ⚠️ **它模型化了实现** ⇒ 阶段 4 引入桶内 LIMIT 后**它不会跟着降** ⇒ **不判任何门槛**。
  // ── ⚠️ ★★★ **读路径 = 单轮（HEAD 逐字同形 · 口径同源）** ──
  //   ⚠️ **为什么读路径【不】分两轮**（与写路径相反！裁决第 1 号）：
  //   · **HEAD 的读路径本来就是「装计数器 + 计数 + 计时」**（已复核 `git show HEAD:bench/perf.ts`）：
  //       const start = process.hrtime.bigint();
  //       const fineIds = backend.route(...);
  //       const before = rowCounter.snapshot();
  //       rowCounter.start();          ← ★ 计数器【在计数】
  //       backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
  //       const end = process.hrtime.bigint();   ← 计时在 search 之后
  //       rowCounter.stop();
  //       const after = rowCounter.snapshot();
  //     ⇒ ⇒ **历史基线的 `vectorRouteP99Ms` 本来就含计数器的逐行开销**
  //     ⇒ ⇒ **把它拆成两轮（轮 A = 装着但不计数）= 改了口径（方向是变快）**
  //     ⇒ ⇒ **与历史基线不再逐位可比** ⇒ ⇒ **读路径必须回到单轮**。
  //   · **口径 §3.3 第 3 条**也是这么说的：「召回窗口（`rowCounter`）本轮【完全不动】
  //     ⇒ `vectorRouteP99Ms` 的口径没变」⇒ ⇒ 口径要的是「**不动**」，不是「拆开」。
  //   · **字节读数就在这个窗口里取** ⇒ ⇒ **字节与毫秒来自同一次执行 ⇒ 天然绑定**
  //     ⇒ ⇒ 读路径**不需要**「两轮对齐」（断言 1d 是**写路径**两轮的对账凭据）
  //     ⇒ ⇒ **但读路径仍需要一个对账量**（口径裁决落地 #1）：
  //     「**实测桶成员行**」必须等于「**推算桶成员行**」
  //     ⇒ ⇒ 否则 `search()` 与 `route()` 看到的不是同一批桶
  //     ⇒ ⇒ 落盘的 `candidateUniverse` 对不上 ⇒ ⇒ **不可判定 ⇒ 判红**。
  //   · **读路径的字节只观测、不判门槛**（口径 §4：顶层 `vectorRouteByteReads` 是观测量；
  //     **判据量是写路径的 `writeSegments.vectorByteReads`**）⇒ ⇒ 付不起「执行次数翻倍」的代价。
  for (const query of queries) {
    const start = process.hrtime.bigint();
    const fineIds = backend.route(
      query.embedding,
      DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
      DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
    );
    // ⚠️ **计数窗口只包住 `search()`**（`route()` 不读行 ⇒ 读的是中心向量，在内存里）。
    const before = rowCounter.snapshot();
    rowCounter.start();
    backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
    // ⚠️ **计时在 `search()` 之后立刻取**（⇒ 与历史基线的取时位置**逐字同形**）。
    const end = process.hrtime.bigint();
    rowCounter.stop();
    const after = rowCounter.snapshot();
    vectorRouteSamples.push(Number(end - start) / 1_000_000);
    // ★ **实测**：生产 SQL 实际物化的候选行数（**R6 的观测值** ⇒ 不判门槛）。
    candidateRowSamples.push(after.candidateRows - before.candidateRows);
    bucketMemberRowSamples.push(after.bucketMemberRows - before.bucketMemberRows);
    // ★ **推算**（对照用）：命中细桶的成员数之和。
    let candidateRowsDerived = 0;
    for (const fineId of fineIds) {
      candidateRowsDerived += membersOf(fineId);
    }
    candidateRowDerivedSamples.push(candidateRowsDerived);
    hitBucketSamples.push(fineIds.length);
    // ⚠️ ★ **候选宇宙（读路径口径）**：`COUNT(DISTINCT memory_id)`
    //   ⇒ **在计时窗口之外**执行（聚合查询本就不计行；口径 §1.7）。
    const universe = countDistinctMembers(db, fineIds);
    // ⚠️ ★ **字节读数取自【同一个窗口】**（字节与毫秒同源 ⇒ 天然绑定）。
    // ⚠️ ★★ **第四个参数 = 「由 `route()` 命中桶推算的成员行数之和」**
    //   ⇒ ⇒ 它与样本里的 `bucketMemberRows`（**计数器实测**）**逐样本配对**
    //   ⇒ ⇒ 读路径的对账量（口径裁决落地 #1）就是这一对。
    readByteSamples.push(buildByteSample(before, after, universe, candidateRowsDerived));
  }
  // ⚠️ **计数器用完就拆**（把 `db.prepare` 恢复原状 ⇒ 后面那些调用不再被包装）。
  rowCounter.uninstall();

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

  // ⚠️ ★★★ **T06 · 两轮制（轮 A 计时 / 轮 B 计量 · 同一份输入）** ──
  //
  // ⚠️ ★★ **为什么必须两轮**（口径 §3.3 第 3 条的硬证据 · 已复核 `git show HEAD:bench/perf.ts`）：
  //   HEAD 的写路径扫描段是「`start` → `collectVectorCandidates` → `end`」
  //   ⇒ **那段计时窗口里【没有计数器】**
  //   ⇒ ⇒ 历史基线的 `writeSegments.vectorCandidateScan` 是**「无计数器的干净测量」**
  //   ⇒ ⇒ **单轮（把计数器塞进被测区间）= 改口径 = 与基线不再逐位可比 = 要重采百万级基线**
  //   ⇒ ⇒ **两轮 = 逐字复现旧取时位置 ⇒ 基线不用重采**。
  //   ⇒ ⇒ **这不是「怕代理开销」的口味问题，是「基线要不要重采」的成本问题。**
  //
  // ⚠️ ★★★ **为什么必须独立装一个计数器**（这是「窗口该开多大」的关键）：
  //   · 召回那个计数器在上面就拆了 ⇒ **它的窗口 = 召回窗口** ⇒ 写路径的读数**采不到**；
  //   · 但 **不能**把它的 `uninstall()` 往后挪 ⇒ 因为它与写路径之间还夹着
  //     **生产的写入循环**（`store.write()` × `writeCount`）—— 那段区间里跑的是**生产的写路径**
  //     ⇒ **生产写入内部自己就会走向量候选扫描**（`src/store/write.ts:671` → `findMergeCandidate`
  //     → `collectDedupCandidates()` → `collectVectorCandidates()`）
  //     ⇒ ① 那些读数会被算进「写路径窗口」⇒ **判据量被污染**；
  //       ② 代理的开销会落进 `store.write()` 的计时里 ⇒ **写入 P99（硬门槛 ≤ 5ms）被污染**；
  //   ⇒ ⇒ **独立装一个计数器、只罩住写路径的计量轮** ⇒ 两个窗口**互不重叠、互不污染**，
  //     且**生产写入循环的计时完全不受影响**（代理根本不在那个区间里）。
  //   ⇒ ★ **架构师 §3.3 第 5 条 / 施工规格 T06-2 验收标准 1**（口径一致）。
  //
  // ⚠️ ★ **口径**：这个窗口量的是**写路径去重扫描那一段**（`collectVectorCandidates()`）
  //   —— 与旧 H1 的判据量（`writeSegments.vectorCandidateRows`）**同一个探针、同一个库、
  //   同一个被考核方**（§4.9 步骤 3a2）⇒ ⇒ **字节账与行数账必然对得上**。
  //
  // ⚠️ ★★ **两轮必须用同一份输入**（同一个 `content`、同一个 `embedding`）
  //   ⇒ ⇒ **先把输入算好**（向量化在计时之外，与写入那一次同一口径）
  //   ⇒ ⇒ 两轮跑的是**同一条生产扫描** ⇒ ⇒ `samplesAligned` 有牙（断言 1d）。
  const writeScanInputs: Array<{ content: string; embedding: Float32Array }> = [];
  for (let index = 0; index < writeCount; index += 1) {
    const content = `写入压测第${index}条、独立的正文${index}、不与语料重复`;
    // ⚠️ **与写入那一次用同一个向量**（生产的归一化口径：`normalizeNumbers`）。
    //   ⚠️ **向量化在计时之外**（向量化不是库的开销 ⇒ 不该计入库的 P99 ⇒ 与召回侧同一纪律）。
    writeScanInputs.push({
      content,
      embedding: normalizeNumbers(Array.from(embedText(content))),
    });
  }

  // ── 轮 A（计时轮 · **不装任何计数器** ⇒ 逐字复现 HEAD 的取时位置）──
  for (const input of writeScanInputs) {
    const start = process.hrtime.bigint();
    const scan = collectVectorCandidates(dedupContext, input.embedding);
    const end = process.hrtime.bigint();
    writeVectorScanSamples.push(Number(end - start) / 1_000_000);
    // ⚠️ ★ **旧行数观测量取自轮 A**（与计时同源 ⇒ 两者可以互相解读）。
    writeVectorScanRowSamples.push(scan.scanned);
    writeUniverseSamples.push(scan.scanned);
  }

  // ── 轮 B（计量轮 · **装计数器** ⇒ 字节 / 行读 / 剪枝率的判据量全部取自这一轮）──
  const writeRowCounter = installRowReadCounter(db, {
    forceDisabled: measurementOptions.disableRowReadCounter === true,
  });
  const writePathReadSamples: WritePathReadSample[] = [];
  const writeByteSamples: VectorByteSample[] = [];
  for (const input of writeScanInputs) {
    // ⚠️ ★ **计数窗口只包住 `collectVectorCandidates()`**（与召回窗口同一形状）：
    //   快照在窗口**外**取 ⇒ 计数器自身的快照开销不落在被测区间里。
    const before = writeRowCounter.snapshot();
    writeRowCounter.start();
    const scan = collectVectorCandidates(dedupContext, input.embedding);
    writeRowCounter.stop();
    const after = writeRowCounter.snapshot();
    writeByteSamples.push(buildByteSample(before, after, scan.scanned));
    writeUniverseSamplesB.push(scan.scanned);
    // ⚠️ ★ **写路径的行读读数**（legacy 结论；**只采、不落盘** ⇒ 落盘字段名由架构师裁决）。
    writePathReadSamples.push({
      candidateUniverse: scan.scanned,
      bucketMemberRows: after.bucketMemberRows - before.bucketMemberRows,
      codeRows: after.codeRows - before.codeRows,
      candidateRows: after.candidateRows - before.candidateRows,
    });
  }
  // ⚠️ **计数器用完就拆**（把 `db.prepare` 恢复原状 ⇒ 后面那些调用不再被包装）。
  writeRowCounter.uninstall();
  // ⚠️ ★ **观测钩子**（**仅测试用** ⇒ 生产路径不传 ⇒ 零影响）。
  measurementOptions.onWritePathReads?.(writePathReadSamples);

  const recallMean = meanOf(recallSamples);
  const vectorMean = meanOf(vectorRouteSamples);
  // ⚠️ **「向量路占总耗时」的分母 = recall 全程 + 向量路**（接线后的真实构成）。
  const vectorRouteShare =
    recallMean + vectorMean === 0 ? 0 : vectorMean / (recallMean + vectorMean);

  // ── ★ **new-path 档（传 `queryEmbedding`）的读数** ──
  // ⚠️ **与 old-path 档并列落盘**（old-path 的键原样不动）。
  const recallVectorLatency = toDistribution(recallVectorSamples);
  const recallVectorPath: RecallVectorPathSummary = {
    samples: recallVectorSamples.length,
    latency: recallVectorLatency,
    p99Ms: recallVectorLatency.p99Ms,
    meanMs: recallVectorLatency.meanMs,
    oldPathMeanMs: recallMean,
    meanDeltaMs: recallVectorLatency.meanMs - recallMean,
    vectorScanShareOfNewPath:
      recallVectorLatency.meanMs > 0 ? vectorMean / recallVectorLatency.meanMs : null,
    probe: vectorPathProbe,
    note:
      '① **new-path 档** = `store.recall({ context, queryEmbedding, now })`' +
      '⇒ `queryEmbedding` 取自 `query.embedding`，且**用 `Array.from()` 真转成 `number[]`**' +
      '（`bench/corpus.ts` 给的是 `Float32Array`；`as` 强转不算转换）⇒ 转换在**计时之外**做；' +
      '② **old-path 档 = 本文件原有的 `recallLatency` / `recallP99Ms`**（不传 `queryEmbedding`' +
      ' ⇒ 向量路整段不执行）⇒ **两档同一批查询、同一次运行、同一条时间线**；' +
      '③ **两档背靠背跑，且按查询序号轮换先后顺序**（偶数 old 先 / 奇数 new 先）' +
      '⇒ 先跑者替后跑者装载页缓存 ⇒ 固定顺序会让后跑的一档偏乐观 ⇒ 顺序偏置必须对称掉；' +
      '④ `meanDeltaMs` = new-path 均值 − old-path 均值（**正数 = 接线后更慢**，单位毫秒）；' +
      '⑤ `vectorScanShareOfNewPath` = **向量扫描本身**（`vectorRouteLatency.meanMs`）÷ 本档均值' +
      '—— **推导值**，分子分母**不是同一次调用**（扫描是独立跑的一遍）⇒ 只作量级参考；' +
      '⑥ `probe` = **一次性探针**（`diagnostics: true`，跑在采样**之后**、计时窗口**之外**）：' +
      '`ran=false` ⇒ **本轮向量路整路缺席**（`mode` 会说明是 `flat_auto` 还是 `absent`）' +
      '⇒ 那时 `meanDeltaMs` **不能**读成「向量路的成本」；' +
      '⑦ ⚠️ **本档不参与 `checkPerf` 的门槛判定**：门槛（recall P99 ≤ 200ms）是**架构师裁决**的口径，' +
      '工程师不能把旧门槛悄悄顺延到一个新口径上 ⇒ 本档先**只落盘观测值**；' +
      '要不要给它定门槛，由架构师裁决。',
  };

  // ── ★ **候选读取行数（★ 2026-11-03 归口后 = R6 的观测值，不判门槛）** ──
  //   ⚠️ **H1/H2 的判据量不在这里**：它在 `writeSegments.vectorCandidateRows`（写入探针 8/20）。
  const candidateReadRowsMeasured = toCountSummary(candidateRowSamples);
  const candidateReadRowsDerived = toCountSummary(candidateRowDerivedSamples);
  const hitFineBuckets = toCountSummary(hitBucketSamples);

  // ⚠️ ★★★ **口径的兜底（不许假装它是实测）**：
  //   实测值全为 0、而推算值不为 0 ⇒ **行读计数器没抓到东西**
  //   （装桩失败 / 生产 SQL 变了 / 候选宇宙口径变了）⇒ ⇒ **退回推算口径**
  //   ⇒ ⇒ 且 `mode` 标成 `'derived'` ⇒ **落盘 JSON 里读的人不会误以为它是实测**。
  const measuredLooksBroken =
    candidateReadRowsMeasured.max === 0 && candidateReadRowsDerived.max > 0;
  const candidateReadRows = measuredLooksBroken
    ? candidateReadRowsDerived
    : candidateReadRowsMeasured;
  const candidateReadRowsBasis: CandidateReadRowsBasis = {
    mode: measuredLooksBroken ? 'derived' : 'measured',
    note: measuredLooksBroken
      ? '⚠️ **本轮退回「推算口径」**（行读计数器没抓到候选行 ⇒ 装桩失败 / 生产 SQL 变了）' +
        '⇒ **R6 的取数 = 命中细桶的成员数之和** ⇒ ⚠️ **它模型化了「桶内不设 LIMIT」这个实现**' +
        '⇒ ⇒ **阶段 4 引入桶内 LIMIT 后它不会跟着降** ⇒ ⇒ **这条要修好行读计数器才作数**；' +
        '⚠️ **它不影响 H1/H2**（H1/H2 判的是 `writeSegments.vectorCandidateRows` ⇒ 不用这个计数器）。'
      : '① **mode = "measured"**（★ 2026-11-02 口径加固）：R6 的取数 = **生产 SQL 实际物化的候选行数**' +
        '（由 **bench 侧的行读计数器**统计**生产代码真正跑的那条 SQL**）' +
        '⇒ ⇒ **不再模型化「桶内不设 LIMIT」这个实现** ⇒ **阶段 4 引入桶内 LIMIT / 两段式读 ⇒ 这个数会跟着降**；' +
        '② **derivedCrossCheck = 推算值**（命中细桶的成员数之和）—— ⚠️ **它模型化了「桶内不设 LIMIT」**' +
        '⇒ **阶段 4 引入桶内 LIMIT 后它不会跟着降** ⇒ ⇒ **只作对照，不判任何门槛**；' +
        '③ **bucketMemberRowsRead = 桶成员侧的行读**（`vector_cell_members`）—— **附加信息**，不判任何门槛；' +
        '④ ⚠️ ★★ **2026-11-03 归口：本块（`candidateReadRows`）的身份 = R6（`RECALL_VEC_ROWS`）观测值**' +
        '（**召回探针 20/50**）⇒ **不设门槛、不判红绿**；**H1/H2 的判据量是 `writeSegments.vectorCandidateRows`**' +
        '（**写入探针 8/20** · 与门槛 2,000 的出处同源）⇒ ⇒ **两块不可混读、不可比大小**；' +
        '⚠️ **「没有门槛可判」不等于「达标」**：1M 实测里本块 max = 12,782 行 = 门槛 2,000 行的 6.39 倍 ⇒ **读数仍然红**。',
    derivedCrossCheck: candidateReadRowsDerived,
    bucketMemberRowsRead: toCountSummary(bucketMemberRowSamples),
  };

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

  // ⚠️ ★★ **两轮对齐**（口径 §2 断言 1d）：轮 A（计时）与轮 B（计量）的候选宇宙逐样本相等。
  //   ⚠️ ★ **这是【写路径】的对账凭据**（读路径是**单轮** ⇒ 字节与毫秒同源 ⇒ 天然绑定
  //   ⇒ ⇒ 读路径不需要「两轮对齐」这个量）。
  const writeSamplesAligned = samplesAlignedOf(writeUniverseSamples, writeUniverseSamplesB);
  // ⚠️ ★★★ **读路径的对账凭据（口径裁决落地 #1 · 换掉了那条【恒真】的比较）**：
  //   **实测桶成员行**（计数器：`search()` 真正扫的桶）**逐样本等于**
  //   **推算桶成员行**（`route()` 命中的桶各自 `countBucketMembers()` 之和）。
  //
  // ⚠️ ★ **为什么不能是「字节样本数 == 计时样本数」**：
  //   两个 `push` 在**同一个循环体内、无条件、无 `continue` / `break`** ⇒ 长度必然相等
  //   ⇒ ⇒ 那条比较**恒为 true** ⇒ ⇒ 它挂在判红守卫上却**永远打不红** ⇒ ⇒ **说谎**。
  //
  // ⚠️ ★ **为什么这个量有牙**（口径裁决落地 #1 的原文理由）：
  //   ① 读路径落盘的 `candidateUniverse` 来自 `countDistinctMembers(db, route() 的 fineIds)`
  //      （**在计时窗口之外**算），而字节来自 **`search()` 实际扫的桶**
  //      ⇒ 若 `search()` 内部路由与外层 `route()` 不一致 ⇒ 落盘的 `candidateUniverse`
  //      **对应的是另一批桶** ⇒ ⇒ **读数不可对账** ⇒ ⇒ 必须判红；
  //   ② 两个量**同形可比**：都是「命中桶的成员行总数」
  //      （`readMemberIds()` 逐桶全量读、无 LIMIT；`membersOf()` = `countBucketMembers()`
  //      是桶计数的**唯一口径**）；
  //   ③ ⚠️ **不许用 `bucketMemberRows === candidateUniverse`** —— 后者是
  //      `COUNT(DISTINCT memory_id)` ⇒ 当一个记忆落在多个命中桶时它**小于**成员行总数
  //      ⇒ ⇒ 1M 规模下**不成立**。
  const readSamplesAligned = readSamplesAlignedOf(
    readByteSamples.map((sample) => sample.bucketMemberRows),
    readByteSamples.map((sample) => sample.bucketMemberRowsDerived),
  );

  // ⚠️ ★★ **写路径的字节读数**（★ H1′ / H2′ 的**唯一**判据量）。
  const writeVectorByteReads = buildVectorByteReads(
    writeByteSamples,
    writeSamplesAligned,
    '① ★ **口径**：`bytesRead` = **向量载荷字节**（码 BLOB + embedding BLOB 的**实测** `byteLength` 之和；' +
      '**恒等式** `bytesRead = codeBytes + embeddingBytes`，零容差）；' +
      '**不含**正文 / 标量 / 成员标识 / SQLite 行头与页开销 ' +
      '⇒ ⇒ **是真实搬运量的【下界】⇒ 判据偏严、不会假绿**（口径 §1.3 裁决 A）；' +
      '② ⚠️ ★ **ADR §8.6 那个 4.44 MB 也是【下界】**（它是按「码 768 B/行 + 精确分 3 KB/行」估的）' +
      '⇒ ⇒ **实测大于它是预期、不是回归**（口径更严）；' +
      '⚠️ ★ **具体差在哪**：**写路径 survivors 的 `embedding` 被读【两次】** —— ' +
      '**`scoreOf` 逐条一次** + **Q4 整行批量再一次** ⇒ ⇒ **§8.6 那张表漏了 Q4 那一笔**；' +
      '③ ⚠️ ★ **H1′ 判的是哪一笔**：本块 = **bench 的「写入扫描独立实测段」** ' +
      '（`collectVectorCandidates()` 那一笔 ⇒ 同探针 8/20、同库、同被考核方 ⇒ **与旧 H1 的 ' +
      '`vectorCandidateRows` 同一笔 ⇒ H1′ 与 H1 可比**）；' +
      '⚠️ **它【不是】`store.write()` 内部那一笔** —— 生产写入内部自己就会走向量候选扫描 ' +
      '（`src/store/write.ts:671` → `collectDedupCandidates()` → `collectVectorCandidates()`）' +
      '⇒ 那一笔**不单独落盘**（已被 `writeTotal` 的计时覆盖）⇒ **两笔都在，只有一笔是判据量**；' +
      '⇒ 且独立实测段跑在写入循环**之后**（库里已多了 N 条 ⇒ 候选面更大）⇒ **略偏悲观 ⇒ H1′ 偏严**；' +
      '⚠️ **真实写入的「总读取字节」远不止这些**（文本路 FTS / 合并判定 / 桶归属）⇒ **那些字节一次都没被观测** ' +
      '⇒ ⇒ **H1′ 不是「一次真实写入的总字节预算」**（它只是**向量载荷**这一项）；' +
      '④ ⚠️ ★ **剪枝率分子的等价性前提**：分子 = `embeddingCalls` = bench 侧数出来的 ' +
      '**`get()` 调用次数**（**无条件**计数 ⇒ 返回 `undefined` 也计）' +
      '⇒ ⇒ 它**定义上** == `prune` 的 `exactReads`（`src/vector/prune.ts:289-290` 一一对应）' +
      '⇒ ⇒ 等价性由 `tests/unit/prune.test.ts` 的断言 1c 钉住（**零 `src/**` 改动**）；' +
      '⚠️ **该等价性只在两段式分支（`prune = true`）成立**（`prune = false` 的对照分支不调 `scoreOf`）；' +
      '⚠️ ★ **方向纪律**：门槛是「≤」⇒ **分子偏小 = 偏松 = 假绿** ⇒ **绝不许用「返回行数」当分子**；' +
      '⑤ ⚠️ ★ **计时口径**：**写路径 = 两轮制**（轮 A 计时**不装**计数器 / 轮 B 计量**装**计数器，' +
      '**同一份输入**）⇒ ⇒ **`vectorCandidateScan` 的毫秒数与历史基线逐位可比**（口径同源）' +
      '⇒ ⇒ `samplesAligned` 证明「计量没有扰动扫描」；' +
      '⚠️ ★ **读路径 = 单轮**（计数器**装着且在计数** + 计时 ⇒ **与 HEAD 逐字同形**）' +
      '⇒ ⇒ **字节读数与毫秒数来自【同一个计时窗口】**；' +
      '⑥ ⚠️ ★ **读路径的字节累加与行读计数同处一个计时窗口** ⇒ 逐行字节计算的微小开销落在 ' +
      '`vectorRouteP99Ms` 里 ⇒ 与历史基线是**同量级而非逐位**；' +
      '但相对每行 3 KB 的读取开销**可忽略（< 1%）** ⇒ **判门槛的 `vectorRouteP99Ms` 不受影响**；' +
      '⑦ **旧行数判据已降级为并列观测**（`writeSegments.vectorCandidateRows` 仍落盘、仍打印，' +
      '但**不再进 `failures`** ⇒ 字节口径下它已不是判据；阈值常量一个都没删）。',
  );

  // ⚠️ ★★ **读路径的字节读数**（**观测值，不判门槛**；口径 §4）。
  const vectorRouteByteReads = buildVectorByteReads(
    readByteSamples,
    readSamplesAligned,
    '① ★ **口径**：`bytesRead` = **向量载荷字节**（码 BLOB + embedding BLOB 的**实测** `byteLength` 之和；' +
      '**恒等式** `bytesRead = codeBytes + embeddingBytes`，零容差）；' +
      '**不含**正文 / 标量 / 成员标识 / SQLite 行头与页开销 ' +
      '⇒ ⇒ **是真实搬运量的【下界】⇒ 判据偏严、不会假绿**（口径 §1.3 裁决 A）；' +
      '② ⚠️ ★ **ADR §8.6 那个 4.44 MB 也是【下界】** ⇒ ⇒ **实测大于它是预期、不是回归**（口径更严）；' +
      '③ ★ **读路径**：无 Q4（survivors 的 `embedding` 只读一次）⇒ 字节构成 = 码字节 + `scoreOf` 的向量字节；' +
      '④ **候选宇宙** = `COUNT(DISTINCT memory_id)`（**在计时窗口之外**执行）；' +
      '⚠️ ★ **等价前提**：bench 的 `backend` 是**新建实例** ⇒ `overlay` 空；' +
      '`backend.search(q, k)` **不带 filter** ⇒ 无 `excludeIds`、无时间窗 ⇒ **Q3 不发** ' +
      '⇒ ⇒ 该值 **== `memberIds.size`**（逐位）⇒ **前提一破即不等**（口径 §1.7 / §13 第 3 条）；' +
      '⑤ ⚠️ **读路径【不判门槛】**（与 R6 同组：观测值）⇒ 判据只在 `writeSegments.vectorByteReads`；' +
      '⑥ ⚠️ ★ **剪枝率的分子（`embeddingCalls`）只在【两段式分支】与 `prune` 的 `exactReads` 定义性相等**；' +
      '⚠️ ★ **方向纪律**：**绝不许用「返回行数」当分子**（偏小 = 偏松 = 假绿）；' +
      '⑦ ★ **计时口径**：**读路径 = 单轮**（计数器**装着且在计数** + 计时 ⇒ **与 HEAD 逐字同形**）' +
      '⇒ ⇒ **字节读数与毫秒数来自【同一个计时窗口】** ⇒ **字节与毫秒天然同源**；' +
      '⚠️ ★ **因此**：`vectorRouteP99Ms` 与历史基线是**同量级而非逐位**（逐行字节计算的微小开销落在窗口里）' +
      '⇒ 但相对每行 3 KB 的读取开销**可忽略（< 1%）** ⇒ **判门槛的 `vectorRouteP99Ms` 不受影响**；' +
      '⑧ ★★ **读路径的对账量（口径裁决落地 #1）**：`samplesAligned` = ' +
      '**实测桶成员行**（计数器认领的「成员来源」行数 = `search()` 真正扫的桶）' +
      '**逐样本等于** **推算桶成员行**（`route()` 命中的桶各自 `countBucketMembers()` 之和）' +
      '⇒ ⇒ 不等 ⇒ `search()` 看到的桶与 `route()` 看到的不是同一批' +
      '⇒ ⇒ 落盘的 `candidateUniverse` 对不上 ⇒ ⇒ **不可判定 ⇒ 判红**；' +
      '⚠️ ★ **读路径原先那条「字节样本数 == 计时样本数」是【恒真的】**' +
      '（两个 `push` 在同一个循环体内、无条件、无 `continue` / `break` ⇒ 长度必然相等' +
      '⇒ ⇒ 挂在判红守卫上却**永远打不红**）⇒ ⇒ **已换掉**；' +
      '⚠️ **注意：写路径才是两轮制**（轮 A 计时**不装**计数器 / 轮 B 计量**装**计数器）⇒ ' +
      '`samplesAligned` 的**两轮对账只在写路径有牙**（读路径的对账量是**上面第 ⑧ 条**）。',
  );

  const writeSegments: WriteSegmentSummary = {
    vectorCandidateScan,
    vectorCandidateRows: toCountSummary(writeVectorScanRowSamples),
    vectorByteReads: writeVectorByteReads,
    writeTotal,
    otherMeanMs,
    otherMeanShare: writeTotal.meanMs === 0 ? 0 : otherMeanMs / writeTotal.meanMs,
    note:
      '① vectorCandidateScan = **独立实测段**（单独调用生产的那条向量候选扫描路径 ' +
      '`collectVectorCandidates()` ⇒ 内部就是 `src/vector/ivf.ts` 的 `scanBucketCandidates()`；' +
      '**不是**从写入总耗时里切出来的 ⇒ 与写入那一次**不是同一次调用**）；' +
      '⚠️ ★ **T06 起这一段改成【两轮制】**（轮 A 计时**不装**计数器 / 轮 B 计量**装**计数器，' +
      '**同一份输入**）⇒ ⇒ **计时窗口 100% 干净 ⇒ 与历史基线逐位可比**（口径同源）' +
      '⇒ ⇒ 另加 `samplesAligned` 证明「计量没有扰动扫描」；' +
      '② otherMeanMs / otherMeanShare = **推导值段**（写入总耗时均值 − 向量扫描段均值）' +
      '⇒ 其余段 = 「FTS5 + 索引维护 + 合并判定 + 事件写入」；' +
      '③ ⚠️⚠️ **「① + ② ≠ 写入总耗时」**（**读这两个数时必须知道**）：' +
      '两段**不是同一次写入里的两段** ⇒ ① 跑在**写入循环之后**的**单独一轮**里 ' +
      '⇒ 那时库里已经多了本轮写入的 N 条记忆 ⇒ 候选面更大一点、页缓存状态也不同 ' +
      '⇒ ⇒ **① 与 ② 相加没有「等于写入总耗时」的含义** ⇒ **只能当归因的量级参考**，' +
      '**不是精确拆分** ⇒ 若要精确拆分，必须在 `src/store/write.ts` 里加一个只读观测点；' +
      '⚠️ 另：otherMeanMs **可能为负** ⇒ 说明「独立实测的扫描段」比「整次写入」还贵 ' +
      '（页缓存状态不同）⇒ 同样不可当精确拆分；' +
      '④ ⚠️ ★★ **`vectorCandidateRows`（旧行数判据量）已降级为【并列观测】**（字节口径下它已不是判据）' +
      '⇒ **仍落盘、仍打印，但不再进 `failures`**（阈值常量 `candidateReadRowsMax` / ' +
      '`candidateReadRowsRatioMax` **一个都没删**）⇒ ★ **H1′ 的唯一判据量 = `vectorByteReads.bytesRead`**。',
  };

  return {
    corpusSize: options.size,
    recallSamples: recallSamples.length,
    recallVectorPath,
    vectorScanNote: VECTOR_SCAN_NOTE,
    writeSamples: writeSamples.length,
    firstWriteMs,
    vectorRouteSamples: vectorRouteSamples.length,
    warmupRounds: WARMUP_ROUNDS,
    recallP99Ms: percentile(recallSamples, 99),
    writeP99Ms: percentile(writeSamples, 99),
    vectorRouteP99Ms: percentile(vectorRouteSamples, 99),
    vectorRouteShare,
    candidateReadRows,
    candidateReadRowsBasis,
    hitFineBuckets,
    perRowReadCostUs,
    // ⚠️ ★★ **T06 · 召回路径的字节读数**（观测值，不判门槛；口径 §4）。
    vectorRouteByteReads,
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
 * ★ **两次快照相减 ⇒ 一个样本的字节读数**（口径 §4 的逐样本采样）。
 *
 * ⚠️ **为什么用「相减」而不是「重置」**：计数器是**累计**的（两次快照相减 = 那段窗口）
 *   ⇒ ⇒ 同一个计数器实例可以罩住**整个采样循环**（逐样本 `start()` / `stop()`）
 *   ⇒ ⇒ **装配一次、窗口逐样本切**（口径 §3.3 第 5 条的「串行安装」纪律）。
 *
 * @param before 窗口前的快照
 * @param after 窗口后的快照
 * @param candidateUniverse 候选宇宙（写路径 = `scan.scanned`；读路径 = `COUNT(DISTINCT …)`）
 * @param bucketMemberRowsDerived **读路径专有**：由 `route()` 命中桶推算的成员行数之和
 *   （写路径 = `null`）⇒ ⇒ 与样本里的 `bucketMemberRows`（**计数器实测**）**逐样本配对**
 *   ⇒ ⇒ 读路径的对账量（`readSamplesAlignedOf()`）就是这一对。
 * @returns 逐样本的字节读数
 */
function buildByteSample(
  before: ByteReadSnapshot,
  after: ByteReadSnapshot,
  candidateUniverse: number,
  bucketMemberRowsDerived: number | null = null,
): VectorByteSample {
  return {
    memoryRowsRead: after.memoryRowsRead - before.memoryRowsRead,
    codeRowsRead: after.codeRowsRead - before.codeRowsRead,
    bytesRead: after.bytesRead - before.bytesRead,
    candidateUniverse,
    codeBytes: after.codeBytes - before.codeBytes,
    embeddingBytes: after.embeddingBytes - before.embeddingBytes,
    contentBytes: after.contentBytes - before.contentBytes,
    embeddingRowsRead: after.embeddingRowsRead - before.embeddingRowsRead,
    embeddingExactRows: after.embeddingExactRows - before.embeddingExactRows,
    embeddingCalls: after.embeddingCalls - before.embeddingCalls,
    narrowRowsRead: after.narrowRowsRead - before.narrowRowsRead,
    bucketMemberRows: after.bucketMemberRowsRead - before.bucketMemberRowsRead,
    bucketMemberRowsDerived,
    badCodeRows: after.badCodeRows - before.badCodeRows,
    unclassifiedRows: after.unclassifiedRows - before.unclassifiedRows,
    // ⚠️ 指纹集合是**累计**的（快照里是「至今见过的全部」）⇒ 逐样本带全量 ⇒
    //   落盘时取**并集**（⇒ 少一次集合运算，也保证「打印 + 落盘」看到的是全集）。
    unclassifiedSqlKinds: after.unclassifiedSqlKinds,
    legacyCandidateRows: after.candidateRows - before.candidateRows,
    legacyCodeRows: after.codeRows - before.codeRows,
  };
}

/**
 * ★ **读路径的候选宇宙**（口径 §1.7：`COUNT(DISTINCT memory_id)`）。
 *
 * ⚠️ ★ **在计时窗口之外执行**（⇒ 聚合查询本就不计行 ⇒ 不污染读数）。
 * ⚠️ ★ **等价前提**（口径 §1.7 / §13 第 3 条）：bench 的 `backend` 是**新建实例**
 *   ⇒ `overlay` 空；`backend.search(q, k)` **不带 filter** ⇒ 无 `excludeIds`、无时间窗
 *   ⇒ Q3 不发 ⇒ 该值 **== `memberIds.size`**（逐位）⇒ **前提一破即不等**（⇒ 写进 note）。
 *
 * @param db 库句柄
 * @param fineIds 命中的细桶 id
 * @returns 候选宇宙（命中桶内的成员去重数）
 */
function countDistinctMembers(db: Database.Database, fineIds: readonly string[]): number {
  if (fineIds.length === 0) {
    return 0;
  }
  const placeholders = fineIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      'SELECT COUNT(DISTINCT memory_id) AS n FROM vector_cell_members ' +
        `WHERE fine_id IN (${placeholders})`,
    )
    .get(...fineIds) as { n: number };
  return row.n;
}

/**
 * ★ **两轮样本是否对齐**（口径 §2 断言 1d）。
 *
 * ⚠️ **逐样本比较**（不是比总数）⇒ ⇒ 「两轮看到的是同一批数据」这件事才被证明。
 *
 * @param roundA 轮 A（计时）的候选宇宙
 * @param roundB 轮 B（计量）的候选宇宙
 * @returns 逐样本相等吗
 */
function samplesAlignedOf(roundA: readonly number[], roundB: readonly number[]): boolean {
  if (roundA.length !== roundB.length) {
    return false;
  }
  return roundA.every((value, index) => value === roundB[index]);
}

/**
 * ★★ **读路径的样本是否对齐**（口径裁决落地 #1 · 读路径的**真正有牙**的对账量）。
 *
 * ⚠️ ★★ **为什么单独一个函数（而不是内联在 `measurePerf()` 里）**：
 *   本仓库的纪律是「**先想变异，再写断言**」⇒ ⇒ 这条量**必须能被单独喂数据**
 *   ⇒ ⇒ 门禁里有一条**负控**（喂两个**不相等**的数组 ⇒ 必须返回 `false`）
 *   ⇒ ⇒ **证明它不是恒绿守卫**（这正是断言 5「两头锁死」的纪律）。
 *
 * ⚠️ ★★★ **这个量为什么有牙**（裁决落地 #1 的原文理由）：
 *   ① 读路径落盘的 `candidateUniverse` 来自 `countDistinctMembers(db, route() 的 fineIds)`
 *      （**在计时窗口之外**算），而字节来自 **`search()` 实际扫的桶**
 *      ⇒ 若 `search()` 内部路由与外层 `route()` 不一致 ⇒ 落盘的 `candidateUniverse`
 *      **对应的是另一批桶** ⇒ ⇒ **读数不可对账** ⇒ ⇒ 必须判红；
 *   ② 两个量**同形可比**：都是「命中桶的成员行总数」
 *      （`readMemberIds()` 逐桶全量读、无 LIMIT；`membersOf()` = `countBucketMembers()`
 *      是桶计数的**唯一口径**）；
 *   ③ ⚠️ **不许用 `bucketMemberRows === candidateUniverse`** —— 后者是
 *      `COUNT(DISTINCT memory_id)` ⇒ 当一个记忆落在多个命中桶时它**小于**成员行总数
 *      ⇒ ⇒ 1M 规模下**不成立**。
 *
 * ⚠️ ★ **为什么 `derived` 允许 `null`**：写路径没有「推算桶成员行」这个量
 *   （写路径的对账量是**两轮 `candidateUniverse`**，见 `samplesAlignedOf()`）
 *   ⇒ ⇒ 读路径专用 ⇒ ⇒ 但**函数本身是纯函数** ⇒ ⇒ 门禁能单独喂数据（含 `null`）。
 *   ⚠️ ★ **`null` 一律判 false**（**方向纪律**：对不上 ⇒ 不可判定 ⇒ 判红 ⇒ 宁可误红不可假绿）。
 *
 * @param measured 实测的桶成员行数（逐样本）
 * @param derived 推算的桶成员行数（逐样本；`null` = 没算 ⇒ 不可判定）
 * @returns 逐样本相等吗
 */
export function readSamplesAlignedOf(
  measured: readonly number[],
  derived: readonly (number | null)[],
): boolean {
  if (measured.length !== derived.length) {
    return false;
  }
  return measured.every((value, index) => {
    const other = derived[index];
    if (other === null || other === undefined) {
      return false;
    }
    return value === other;
  });
}

/**
 * ★ **把逐样本的字节读数压成落盘结构**（口径 §4）。
 *
 * ⚠️ **四个读数 + breakdown 全部是 `CountSummary` 分布** ⇒ 判据取 `max`。
 *
 * @param samples 逐样本读数
 * @param samplesAligned 样本是否对齐（**写路径** = 两轮 `candidateUniverse` 逐样本相等；
 *   **读路径** = 单轮 ⇒ 对账量 = **逐样本「实测桶成员行 === route 侧推算桶成员行」**
 *   （`readSamplesAlignedOf()`）⇒ **不是**「字节样本数 == 计时样本数」（**那条恒真**））
 * @param note 口径说明（**必须落盘**）
 * @returns 落盘结构
 */
function buildVectorByteReads(
  samples: readonly VectorByteSample[],
  samplesAligned: boolean,
  note: string,
): VectorByteReads {
  const unclassifiedKinds = new Set<string>();
  let unclassifiedRows = 0;
  let badCodeRows = 0;
  for (const sample of samples) {
    unclassifiedRows += sample.unclassifiedRows;
    badCodeRows += sample.badCodeRows;
    for (const kind of sample.unclassifiedSqlKinds) {
      unclassifiedKinds.add(kind);
    }
  }
  return {
    memoryRowsRead: toCountSummary(samples.map((sample) => sample.memoryRowsRead)),
    codeRowsRead: toCountSummary(samples.map((sample) => sample.codeRowsRead)),
    bytesRead: toCountSummary(samples.map((sample) => sample.bytesRead)),
    candidateUniverse: toCountSummary(samples.map((sample) => sample.candidateUniverse)),
    breakdown: {
      codeBytes: toCountSummary(samples.map((sample) => sample.codeBytes)),
      embeddingBytes: toCountSummary(samples.map((sample) => sample.embeddingBytes)),
      contentBytes: toCountSummary(samples.map((sample) => sample.contentBytes)),
      embeddingRowsRead: toCountSummary(samples.map((sample) => sample.embeddingRowsRead)),
      embeddingExactRows: toCountSummary(samples.map((sample) => sample.embeddingExactRows)),
      embeddingCalls: toCountSummary(samples.map((sample) => sample.embeddingCalls)),
      narrowRowsRead: toCountSummary(samples.map((sample) => sample.narrowRowsRead)),
      bucketMemberRows: toCountSummary(samples.map((sample) => sample.bucketMemberRows)),
      badCodeRows,
      unclassifiedRows,
      unclassifiedSqlKinds: [...unclassifiedKinds].sort(),
      // ⚠️ ★ **剪枝率 = `embeddingCalls ÷ candidateUniverse`**（分子 = **调用次数** ⇒ 偏大 = 更严）。
      pruneRate: toCountSummary(
        samples.map((sample) =>
          sample.candidateUniverse > 0 ? sample.embeddingCalls / sample.candidateUniverse : 0,
        ),
      ),
      samplesAligned,
    },
    note,
  };
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

  // ⚠️ ★★★ **H1′（字节 · 唯一判据 · T06 · 口径 §5）** ───
  //   **写入去重路径的单次向量载荷字节 ≤ 6,144,000 B**（= 2,000 行 × 3,072 B）
  //   ⇒ ⇒ **判定只取 `bytesRead.max`**（「单次」⇒ 每一次都要满足 ⇒ 最严口径）。
  //
  // ⚠️ ★★★ **旧 H1（行）/ H2（行）已【降级为并列观测】**（口径 §5）：
  //   · 「行」是**实现相关**的单位（768 B 的码 vs 96 B 的码 vs 打包块 ⇒ 行数含义完全不同）
  //     ⇒ ⇒ 换存储形态 = 换了一把尺 ⇒ 违反 ADR §8.5 理由 2；
  //   · C′ 的 `scanned` = **候选宇宙**（≈ 5,521 行）**必然 > 2,000**
  //     ⇒ ⇒ 留着当判据 ⇒ **本档永远红、无法交付** ⇒ 降级是**必需**，不是偏好；
  //   · ⇒ ⇒ **常量 `candidateReadRowsMax` / `candidateReadRowsRatioMax` 一个都不许删**
  //     （删常量 = 制造「同一个门槛两个名字」的镜像问题）⇒ ⇒ 它们仍在 `THRESHOLDS` 里。
  const byteReads = result.writeSegments.vectorByteReads;
  const bytesRead = byteReads.bytesRead;
  const byteBasisNote =
    '口径：实测（写入去重路径的生产 SQL 实际物化的向量载荷字节 = 实测 byteLength 之和）；' +
    '判据量 = writeSegments.vectorByteReads.bytesRead（写入探针 8/20，与旧 H1 的 2,000 行同源）';
  if (bytesRead.count === 0) {
    failures.push(
      '写入去重路径（探针 8/20）向量载荷字节（H1′）的样本数为 0 ⇒ H1′ 是真空通过' +
        `（必须有样本；${byteBasisNote}）`,
    );
  } else if (bytesRead.max === 0) {
    failures.push(
      '写入去重路径（探针 8/20）向量载荷字节（H1′）恒为 0 ⇒ 向量路在写入路径整路缺席 ' +
        `⇒ H1′ 是真空通过（不是「0 字节 ⇒ 达标」；${byteBasisNote}）`,
    );
  } else if (bytesRead.max > THRESHOLDS.bytesReadMax) {
    failures.push(
      `写入去重路径（探针 8/20）向量载荷字节（H1′）${bytesRead.max} B > ${THRESHOLDS.bytesReadMax} B` +
        `（判定取 max；均值 ${bytesRead.mean.toFixed(1)} B、p99 ${bytesRead.p99} B、样本 ${bytesRead.count}；${byteBasisNote}）`,
    );
  }

  // ⚠️ ★ **H2′（与 H1′ 同义的规模无关写法）**：
  //   **写入去重路径**的向量载荷字节 ÷（库规模 × 3,072 B）≤ 0.2%
  //   ⇒ 1M ⇒ ≤ 6,144,000 B；10M ⇒ ≤ 61,440,000 B。
  // ⚠️ **主语与 H1′ 完全相同**（同一个量、同一批样本、同一个探针）⇒ 两者必然同时红 / 同时绿。
  const byteRatio =
    result.corpusSize > 0 ? bytesRead.max / (result.corpusSize * BYTES_PER_VECTOR_ROW) : 0;
  if (bytesRead.count > 0 && byteRatio > THRESHOLDS.bytesReadRatioMax) {
    failures.push(
      '写入去重路径（探针 8/20）向量载荷字节 ÷（库规模 × 3,072 B）（H2′）' +
        `${(byteRatio * 100).toFixed(4)}% > ${(THRESHOLDS.bytesReadRatioMax * 100).toFixed(1)}%` +
        `（${bytesRead.max} B /（库规模 ${result.corpusSize} × ${BYTES_PER_VECTOR_ROW} B）；` +
        '判据量 = writeSegments.vectorByteReads.bytesRead）',
    );
  }

  // ⚠️ ★ **剪枝率（出关条件① · 标签 `（PRUNE_RATE）`）**：
  //   `embeddingCalls ÷ candidateUniverse` ≤ 15%
  // ⚠️ ★★★ **分子必须是「调用次数」**（口径 §1.7 的方向纪律）：
  //   门槛是「≤」⇒ **分子偏小 = 更容易过 = 偏松 = 假绿**
  //   ⇒ 最坏情形：命中桶内全是软删成员 ⇒ 「返回行数」= 0 ⇒ 剪枝率 0% ⇒ **假绿**
  //   ⇒ ⇒ 分子 = `embeddingCalls`（`get()` 调用次数，**无条件**计数）⇒ 它定义上 == `exactReads`。
  const pruneRate = byteReads.breakdown.pruneRate;
  if (pruneRate.count > 0 && pruneRate.max > THRESHOLDS.pruneRateMax) {
    failures.push(
      `写入去重路径（探针 8/20）剪枝率（PRUNE_RATE）${(pruneRate.max * 100).toFixed(2)}% > ` +
        `${(THRESHOLDS.pruneRateMax * 100).toFixed(0)}%` +
        '（分子 = embeddingCalls（get() 调用次数 ≡ prune 的 exactReads）；' +
        '分母 = candidateUniverse；判定取 max）',
    );
  }

  // ⚠️ ★★★ **三条同级的「不可判定」守卫（全部判红 · 口径 §5 末条）** ───
  //   ① `unclassifiedRows > 0` ⇒ **口径不完整**（有语句没认领 ⇒ 字节账偏小 ⇒ 假绿）；
  //   ② `badCodeRows > 0` ⇒ **前提违例**（坏码行 = 白读）；
  //   ③ `samplesAligned === false` ⇒ **样本不可对账**。
  //   ⚠️ ★ **写路径与读路径的 `samplesAligned` 含义不同**（⇒ 文案也必须分开写）：
  //   · **写路径 = 两轮**（轮 A 计时 / 轮 B 计量）⇒ 逐样本 `candidateUniverse` 必须相等；
  //   · **读路径 = 实测桶成员行 vs 推算桶成员行**（口径裁决落地 #1）
  //     ⇒ ⇒ 「`search()` 看到的桶」必须与「`route()` 看到的桶」是同一批
  //     ⇒ ⇒ 否则落盘的 `candidateUniverse` 对不上 ⇒ ⇒ **不可判定**。
  for (const [label, reads, alignmentText] of [
    [
      '写入去重路径（探针 8/20）',
      byteReads,
      '两轮样本（轮 A 计时 / 轮 B 计量）的 candidateUniverse **逐样本不相等**' +
        '⇒ 两轮看到的不是同一批数据 ⇒ 读数不可对账 ⇒ 不可判定',
    ],
    [
      '召回路径（探针 20/50）',
      result.vectorRouteByteReads,
      '**实测桶成员行 ≠ 推算桶成员行**' +
        '⇒ `search()` 看到的桶与 `route()` 看到的不是同一批' +
        '⇒ 落盘的 `candidateUniverse` 对不上 ⇒ 不可判定',
    ],
  ] as const) {
    if (reads.breakdown.unclassifiedRows > 0) {
      failures.push(
        `${label}有 ${reads.breakdown.unclassifiedRows} 行**命中零来源**（未登记的语句形状）` +
          '⇒ 口径不完整 ⇒ 不可判定（指纹：' +
          `${reads.breakdown.unclassifiedSqlKinds.join(' | ') || '（空）'}）`,
      );
    }
    if (reads.breakdown.badCodeRows > 0) {
      failures.push(
        `${label}有 ${reads.breakdown.badCodeRows} 行**坏码行**（码长 ≠ 768）` +
          '⇒ 读了、搬了字节，却被 fail-open 丢弃 ⇒ **白读** ⇒ 前提违例 ⇒ 不可判定',
      );
    }
    if (!reads.breakdown.samplesAligned) {
      failures.push(`${label}${alignmentText}`);
    }
  }

  // ⚠️ **样本数必须够**：样本为 0 ⇒ P99 是 `0` ⇒ 门槛「通过」是**真空通过**
  //   ⇒ 必须显式报出来。
  if (result.recallSamples === 0 || result.writeSamples === 0 || result.vectorRouteSamples === 0) {
    failures.push('样本数为 0 ⇒ P99 是真空通过（必须有样本）');
  }
  return failures;
}

/**
 * ★ **R6（`RECALL_VEC_ROWS`）的观测行** —— **只打印 / 只落盘，不判红绿**。
 *
 * ⚠️ ★★★ **为什么它必须是「一行文字」而不是 `checkPerf()` 的一条 failure**：
 *   `checkPerf()` 的返回值是**门槛清单**（空 = 全部达标）⇒ 把 R6 塞进去
 *   ⇒ 要么**判它红**（但它没有门槛 ⇒ 判红是在编一条不存在的线）、
 *   要么**判它绿**（⇒ 那是更坏的错：**12,782 行 = 2,000 行的 6.39 倍**会被读成「达标」）。
 *   ⇒ ⇒ **第三条路：不给它结论**，只给**读数 + 一句「它仍然红，只是没有门槛可判」**。
 *
 * ⚠️ ★ **为什么文字里必须出现「6.39 倍」这类比较**（不能只报 `max`）：
 *   只报「12,782 行」而不说它与 2,000 的关系 ⇒ 读的人会以为「既然不判红绿，那大概没问题」
 *   ⇒ ⇒ **必须把「仍然红」写在同一个句子里**，且说明**这条门槛不属于它**。
 *
 * @param result 测量结果
 * @returns 一行说明（**不含任何「达标」结论**）
 */
export function formatRecallVecRowsObservation(result: PerfResult): string {
  const rows = result.candidateReadRows;
  const gate = THRESHOLDS.candidateReadRowsMax;
  const multiple = gate > 0 ? rows.max / gate : 0;
  const conclusion =
    rows.max > gate
      ? `⚠ 它仍然红：${rows.max} 行 = ${gate} 行的 ${multiple.toFixed(2)} 倍 ` +
        '—— 但这个倍数**没有变小**，只是这条量**不再冒充「写入路径」**' +
        '（**历史行数口径** 2,000 行归的是写入去重路径 ⇒ 旧的 H1/H2；' +
        '⚠️ **字节口径下它已不是判据** ⇒ H1′ 判的是 `writeSegments.vectorByteReads.bytesRead`）' +
        ' ⇒ ⇒ **不是「达标」，也不是「不再是问题」**'
      : `⚠ 低于 ${gate} 行只说明「这一轮读数不大」，` +
        '**不构成任何门槛结论**（它没有门槛可判 ⇒ 既不算红也不算绿）';
  return (
    `R6 召回路径向量扫描量（RECALL_VEC_ROWS）= ${rows.max} 行` +
    `（均值 ${rows.mean.toFixed(1)}；**观测值，不设门槛、不判红绿**；探针 20/50）；${conclusion}`
  );
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
  // ⚠️ ★ **页缓存状态（冷 / 热 / 未知）** —— ⚠️ **Windows 没有公开 API 能报「这个库有多少在页缓存里」**
  //   ⇒ ⇒ **只能「可标注」不能「可测量」** ⇒ **由跑的人声明**
  //   ⇒ ⇒ **缺省 `unknown`**（**不许猜**）⇒ **非法值 ⇒ 报错**（不静默钳制 ⇒ 否则档位是假的）。
  const pageCacheState: PageCacheStateInfo = parsePageCacheState(args['cache-state']);

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
  const machine = machineInfo(dbPath);
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
  // ★ **H1/H2 的判据量**（2026-11-03 归口：**写入去重路径**；不是 `candidateReadRows`）。
  const h1Rows = result.writeSegments.vectorCandidateRows;
  // ⚠️ ★★ **T06 · H1′ 的判据量**（字节口径）+ 三个并列读数 + 剪枝率（打印用）。
  const h1Bytes = result.writeSegments.vectorByteReads.bytesRead;
  const h1MemoryRows = result.writeSegments.vectorByteReads.memoryRowsRead;
  const h1CodeRows = result.writeSegments.vectorByteReads.codeRowsRead;
  const h1Universe = result.writeSegments.vectorByteReads.candidateUniverse;
  const h1PruneRate = result.writeSegments.vectorByteReads.breakdown.pruneRate.max;
  // ★ **R6 的观测行**（**不判红绿** ⇒ 单独算一次 ⇒ 控制台与「未达标清单」用**同一段文字**）。
  const r6Observation = formatRecallVecRowsObservation(result);
  // ⚠️ ★ **存储介质类别**（判据的介质解耦落点）—— 探测失败 ⇒ `'unknown'`（**不抛错**）。
  const storageMedia: StorageMediaInfo = machine.storageMedia;

  writeJsonFile(outPath, {
    corpusSize: result.corpusSize,
    trainedCells: prepared.fineCells,
    trainedMembers: prepared.members,
    thresholds: THRESHOLDS,
    // ⚠️ ★★★ **门槛归口的声明**（2026-11-03 · `D10`）⇒ **必须与数据一起落盘**：
    //   ① H1/H2 的判据量 = `writeSegments.vectorCandidateRows`（写入探针 8/20）；
    //   ② `candidateReadRows` = R6（`RECALL_VEC_ROWS`）观测值 ⇒ **不判门槛**；
    //   ③ 「没有门槛可判」**不等于**「达标」。
    //   ⚠️ **它是新增的说明字段** ⇒ **数据字段（`candidateReadRows` / `writeSegments`）一个都没改名**
    //   ⇒ 读旧 JSON 的脚本不受影响（旧 JSON 里没有这个字段 ⇒ 按「归口前」读即可）。
    gateRegrouping: GATE_REGROUPING,
    // ⚠️ ★★★ **两个召回档并列落盘**（键名不复用 ⇒ 读的人不会把两档混成一个数）：
    //   · `recallP99Ms` / `recallLatency` / `recallSamples` ⇒ **old-path 档**（原有键，**一个都没改**
    //     ⇒ `tests/bench/bench-smoke.test.ts` 与 `docs/baseline/README.md` 读的就是它们）；
    //   · `recallVectorPath` ⇒ **new-path 档**（**新键**，含 `latency` / `p99Ms` / `meanMs` /
    //     `oldPathMeanMs` / `meanDeltaMs` / `vectorScanShareOfNewPath` / `probe`）。
    recallVectorPath: result.recallVectorPath,
    // ⚠️ ★ **「向量扫描本身」的口径声明**（跟数据一起走 ⇒ 读 JSON 的人看得到边界）。
    vectorScanNote: result.vectorScanNote,
    recallP99Ms: result.recallP99Ms,
    writeP99Ms: result.writeP99Ms,
    firstWriteMs: result.firstWriteMs,
    vectorRouteP99Ms: result.vectorRouteP99Ms,
    vectorRouteShare: result.vectorRouteShare,
    // ⚠️ ★★★ **R6 的观测值**（**召回路径** · 探针 20/50）—— **键名不改**（读旧 JSON 的脚本靠它对账），
    //   但它的身份已按 `gateRegrouping` 改成「观测值：不设门槛、不判红绿」⇒ **H1/H2 不再引用它**。
    candidateReadRows: result.candidateReadRows,
    // ⚠️ ★★★ **R6 的口径声明**（★ 实测还是推算 ⇒ **读 JSON 的人不许误读**）。
    candidateReadRowsBasis: result.candidateReadRowsBasis,
    hitFineBuckets: result.hitFineBuckets,
    // ⚠️ ★★ **每行读成本（µs/行）—— 推导值，不是直接测量值**。
    perRowReadCostUs: result.perRowReadCostUs,
    // ⚠️ ★★ **T06 · 召回路径的字节读数**（**新键**；观测值、不判门槛 ⇒ 与同组的
    //   `candidateReadRows` / `hitFineBuckets` 放一起 ⇒ 不拆散）。
    vectorRouteByteReads: result.vectorRouteByteReads,
    // ⚠️ ★★★ **写入路径的分段计时**（见 `writeSegments.note` 的口径说明）
    //   ⇒ ⇒ **其中 `vectorCandidateRows` 就是 H1/H2 的判据量**（写入探针 8/20）。
    writeSegments: result.writeSegments,
    // ⚠️ ★ **存储介质类别**（HDD / SSD / NVMe / `unknown`）——「换一块盘 ⇒ 判据含义静默改变」的防线。
    storageMedia,
    // ⚠️ ★ **页缓存状态（冷 / 热 / 未知）** ——「换一种缓存状态 ⇒ 毫秒数含义静默改变」的防线。
    pageCacheState,
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
    `  recall P99（old-path · 不传向量）= ${result.recallP99Ms.toFixed(3)}ms（门槛 ${THRESHOLDS.recallP99Ms}ms，样本 ${result.recallSamples}）\n` +
      `  recall P99（new-path · 传向量）= ${result.recallVectorPath.p99Ms.toFixed(3)}ms（**只观测、不判门槛**，样本 ${result.recallVectorPath.samples}）\n` +
      `    ★ 两档均值差 = ${result.recallVectorPath.meanDeltaMs.toFixed(3)}ms` +
      `（new ${result.recallVectorPath.meanMs.toFixed(3)}ms − old ${result.recallVectorPath.oldPathMeanMs.toFixed(3)}ms；正数 = 接线后更慢）\n` +
      `    ★ new-path 探针：向量路 ran = ${result.recallVectorPath.probe.ran}（mode = ${result.recallVectorPath.probe.mode}，` +
      `候选 ${result.recallVectorPath.probe.candidates} 条）\n` +
      `    ★ 向量扫描占 new-path 整条召回 = ${result.recallVectorPath.vectorScanShareOfNewPath === null ? '**未测到**' : `${(result.recallVectorPath.vectorScanShareOfNewPath * 100).toFixed(2)}%`}（推导值）\n` +
      `  写入 P99 = ${result.writeP99Ms.toFixed(3)}ms（门槛 ${THRESHOLDS.writeP99Ms}ms，样本 ${result.writeSamples}）\n` +
      `  向量扫描本身 P99 = ${result.vectorRouteP99Ms.toFixed(3)}ms（门槛 ${THRESHOLDS.vectorRouteP99Ms}ms，样本 ${result.vectorRouteSamples}）` +
      '（⚠️ **直接调 backend.route()+search()** ⇒ 不是召回读数，见 vectorScanNote）\n' +
      `  向量路占总耗时 = ${(result.vectorRouteShare * 100).toFixed(2)}%（门槛 ≤ ${(THRESHOLDS.vectorRouteShare * 100).toFixed(0)}%）\n` +
      `  ★★ H1′ 向量载荷字节（**写入去重路径** · 探针 8/20）= ${h1Bytes.max} B` +
      `（判定取 max；均值 ${h1Bytes.mean.toFixed(1)} B、p99 ${h1Bytes.p99} B，` +
      `门槛 ≤ ${THRESHOLDS.bytesReadMax} B，样本 ${h1Bytes.count}）\n` +
      '    ★ H1′ 口径 = **实测（生产 SQL 实际物化的向量载荷字节 = 实测 byteLength 之和）**' +
      '（**不含正文 / 标量 / 页开销 ⇒ 是真实搬运量的下界 ⇒ 判据偏严**；' +
      '判据量 = writeSegments.vectorByteReads.bytesRead）\n' +
      '  ★★ H2′ 向量载荷字节 ÷（库规模 × 3,072 B）（**写入去重路径** · 探针 8/20）= ' +
      `${(result.corpusSize > 0 ? (h1Bytes.max / (result.corpusSize * 3_072)) * 100 : 0).toFixed(4)}%` +
      `（门槛 ≤ ${(THRESHOLDS.bytesReadRatioMax * 100).toFixed(1)}%）\n` +
      '  ★★ 剪枝率（PRUNE_RATE · 分子 = embeddingCalls = get() 调用次数）= ' +
      `${(h1PruneRate * 100).toFixed(2)}%（门槛 ≤ ${(THRESHOLDS.pruneRateMax * 100).toFixed(0)}%）\n` +
      `  ★ 记忆行读数 memoryRowsRead = ${h1MemoryRows.max} 行` +
      `（均值 ${h1MemoryRows.mean.toFixed(1)}；码行 codeRowsRead = ${h1CodeRows.max} 行；` +
      `候选宇宙 candidateUniverse = ${h1Universe.max}）\n` +
      `  ★ 旧行数（**观测值** = ${h1Rows.max} 行，写入去重路径 · 探针 8/20）` +
      `（均值 ${h1Rows.mean.toFixed(1)} 行；⚠️ **字节口径下它已不是判据**；` +
      `历史行数口径 ≤ ${THRESHOLDS.candidateReadRowsMax} 行，样本 ${h1Rows.count}）\n` +
      '  ★ 旧行数 ÷ 库规模（**观测值**）= ' +
      `${(result.corpusSize > 0 ? (h1Rows.max / result.corpusSize) * 100 : 0).toFixed(4)}%` +
      `（历史行数口径 ≤ ${(THRESHOLDS.candidateReadRowsRatioMax * 100).toFixed(1)}%）\n` +
      `  ★ ${r6Observation}\n` +
      '    ★ R6 口径 = ' +
      `**${result.candidateReadRowsBasis.mode === 'measured' ? '实测（召回路径的生产 SQL 实际物化的候选行数）' : '⚠ 推算（模型化了「桶内不设 LIMIT」）'}**` +
      `（对照推算值 max = ${result.candidateReadRowsBasis.derivedCrossCheck?.max ?? 0} 行；` +
      '⚠️ **它不参与任何红/绿判定**）\n' +
      '  ★ 每行读成本 = ' +
      `${result.perRowReadCostUs === null ? '**未测到**' : `${result.perRowReadCostUs.toFixed(3)} µs/行`}` +
      `（推导值；介质 ${storageMedia.mediaClass}${storageMedia.detected ? '' : '（**未探测到**）'}）\n` +
      `  ★ 页缓存状态 = **${pageCacheState.state}**` +
      `${pageCacheState.declared ? '（跑的人声明）' : '（**没声明 ⇒ 不可知**）'}` +
      '（⚠️ 由跑的人声明，不是仪器测量值）\n' +
      `  ★ 写入分段：向量候选扫描 均 ${result.writeSegments.vectorCandidateScan.meanMs.toFixed(3)}ms` +
      `/ 其余（FTS5 + 索引维护 + 合并判定 + 事件写入）均 ${result.writeSegments.otherMeanMs.toFixed(3)}ms（推导值）\n` +
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
  } else {
    process.stdout.write('\n✓ 性能门槛全部达标（H1/H2 判的是**写入去重路径** · 探针 8/20）\n');
  }
  // ⚠️ ★★★ **R6 必须在这里也出现一次**（哪怕它不判红绿）：
  //   把「观测值」藏在 stdout 的横幅里 ⇒ 读 stderr 的人（CI、只看未达标清单的人）
  //   会以为「清单里没有 R6 ⇒ R6 没问题」⇒ ⇒ **那正是本轮要消灭的误读**
  //   ⇒ 所以它**既不进门槛清单，也不省略**：单列一节，并写明「不判红绿」与「仍然红」。
  process.stderr.write(
    '\n⚠ 观测值（**不判红绿 · 非门槛**）：\n' +
      `    ${r6Observation}\n` +
      '  ⇒ 它与 H1/H2 是**两条不同的量**（探针 20/50 vs 8/20）⇒ **不可混读、不可比大小**；\n' +
      '  ⇒ 「没有门槛可判」**不等于**「达标」（见 JSON 的 gateRegrouping 字段）。\n',
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  main();
}
