/**
 * **前置测量：flat 路线下向量路的耗时占比** —— P2-T08
 * （DEVELOPMENT-PLAN.md 行 2027~2031）。
 *
 * ⚠️ **这条测的是「改造前」的形态**（§12 阶段 2 的原文）：
 *   「flat 路线下**向量路耗时占比 ≥ 80%** —— 这是「**为什么要上分桶**」的**证据**，
 *   **不是验收条件**。」
 *   ⇒ **它是证据**：它说明「在 100 万条下，向量路（全表精确扫描）吃掉了几乎全部召回耗时
 *   ⇒ 所以必须把它换成只扫几千条的分桶」。
 *
 * ⚠️ ★ **口径（必须写死，否则这条证据没有可判定性）**：
 *   · **分子** = flat 路线下**向量路**的耗时
 *     （**全表精确点积** —— `bench/lib/flat.ts` 的流式扫描，与生产 `FlatVectorBackend`
 *     **同口径**：`dot()` + `clampCos()` + `compareHits()`）。
 *   · **分母** = 分子 + **文本路 + 图谱路**的耗时
 *     （走**生产的 `MemoryStore.recall()`** ⇒ 与真实召回同一条路径）。
 *   ⇒ **占比 = 向量路 / (向量路 + recall 其余部分)**。
 *   ⚠️ **为什么分母要含 recall**：只测向量路自己 ⇒ 占比恒为 100% ⇒ 无信息量。
 *
 * ⚠️ **它与 `bench/perf.ts` 的「向量路占总耗时」是两条不同的数**：
 *   · 本脚本 = **flat 路线**（改造前）⇒ 预期 **≥80%**；
 *   · perf.ts = **分桶路线**（改造后）⇒ 门槛 **≤20%**。
 *   ⇒ **两者方向相反、绝对值不同** ⇒ 报告里必须分开列，**不许混用**。
 *
 * ⚠️ ★★ **「改造前」现在是一个真能跑的模式**（2026-11-02 改；旧版本此处写的是
 *   「本仓库的 `recall()` **尚未接线向量路**」+「『改造前』在当前代码里不是一个可运行的模式」
 *   —— **这两句在 `96568eb`（向量路接线）之后已经是假话**，已改掉）：
 *   · `recall()` 的步骤 2c 已接线（入口条件 = 「有 `queryEmbedding` ∧ 端口可装配」）；
 *   · `VECTOR_ROUTER='flat'`（`src/core/params.ts` 的三值选择器）会让四态判定落到
 *     **`flat_explicit`** ⇒ ⇒ **`VECTOR_ROUTER='flat'` + 传 `queryEmbedding`**
 *     就是「改造前」的**真实运行形态**：召回内部走**全表精确点积**。
 *     ⚠️ 判据出处不是本文猜测：`src/store/stats.ts` 的 `resolveVectorBackendMode()`
 *     第 1 条就是「调用方**显式**选了 flat ⇒ `flat_explicit`（那是**要求**，不是降级）」。
 *   ⇒ **本文件因此有两个档**：
 *     · **原有档（一个数都不删）** = `flatTopK()` 的**手工组装**扫描
 *       （不经 `recall()` ⇒ 量的是**扫描本身**）+ 不传向量的召回 ⇒ 分子/分母见上；
 *     · **新增档** = flat 模式 store 上的 `recall({ context, queryEmbedding })`
 *       ⇒ 落盘在**新键** `recallVectorPath`（**整条召回**，向量路在里面）；
 *   ⇒ ⇒ **两条数回答两个不同问题**（「扫描本身多重」vs「整条召回多重」）
 *     ⇒ 与 `bench/perf.ts` 里 `vectorRoute*` vs `recallVectorPath` 是同一种分工
 *     ⇒ **不许把它们合成一个数**。
 *   ⚠️ **为什么不直接删掉手工档、只留真跑档**：手工档是**历史基线的出处**
 *     （已落盘的 `docs/baseline/baseline-flat-*.json` 读的就是它的键）
 *     ⇒ 删掉 = 老基线与新代码**不可比**，且「60%~80%」那条历史读数再也无法复现。
 *
 * ⚠️ ★ **规模守卫**（P2 收官 · Q-02；硬断言「规模写进验收行」）：
 *   **规模 < 100 万 ⇒ 直接失败**（抛错 + **非零退出码** + **不落盘**）
 *   ⇒ 「小库根本走不到分桶路径」⇒ **在小库上测得的占比什么也没验到**。
 *   ⚠️ **降级开关 `--allow-small-scale`（默认关闭）**：只为冒烟 / 自检 / 工具链联调
 *   留一条**合法的小规模路径**；**默认必须拒绝**。
 *
 * 用法：
 * ```
 * pnpm exec tsx bench/baseline-flat.ts --scale=1000000 --queries=100
 * ```
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../src/core/params.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { type CorpusOptions, DEFAULT_CORPUS_OPTIONS, generateQueries } from './corpus.js';
import { prepareBench } from './lib/db.js';
import { flatTopK } from './lib/flat.js';
import {
  BENCH_NOW,
  benchWorkDir,
  formatLoadMs,
  formatPeakRss,
  intArg,
  machineInfo,
  parseArgs,
  phaseInfo,
  stringArg,
  summarizeLatency,
  writeJsonFile,
} from './lib/harness.js';
import { enforceBenchScale } from './lib/scale.js';
// ★ **探针复用 `bench/perf.ts` 的实现**（C36：同一件事不得有两套口径）
//   ⇒ 否则两个脚本会对「向量路跑没跑」给出两套不同的判据。
import { type VectorPathProbe, probeVectorPathOfRecall } from './perf.js';

/** 前置测量的**参考线**（§12 的原文：**证据，不是验收条件**）。 */
export const FLAT_SHARE_REFERENCE = 0.8;

/** 预热轮次（**不计入统计**）。 */
export const WARMUP_ROUNDS = 5;

/** 一次前置测量的结果。 */
export interface BaselineFlatResult {
  /** 语料规模（**实测**）。 */
  readonly corpusSize: number;
  /** 样本数。 */
  readonly samples: number;
  /** 预热轮次。 */
  readonly warmupRounds: number;
  /** flat 向量路的耗时分布（毫秒）。 */
  readonly flatVectorLatency: ReturnType<typeof summarizeLatency>;
  /**
   * recall 的耗时分布（毫秒）—— ★ **old-path 档**（**不传 `queryEmbedding`** ⇒ 向量路整段不执行）。
   *
   * ⚠️ **旧版本此处写着「文本路 + 图谱路」**：接线之后那句话**只对不传向量的调用成立**
   *   ⇒ 改成口径名「**old-path 档**」（传向量的那档见 `recallVectorPath`）
   *   ⇒ 否则读代码的人会以为「recall 里永远没有向量路」。
   */
  readonly recallLatency: ReturnType<typeof summarizeLatency>;
  /** **向量路耗时占比**（0~1；**原有档的口径**：手工扫描 ÷ (手工扫描 + old-path 召回)）。 */
  readonly vectorShare: number;
  /** 与参考线的差（正数 = 达标）。 */
  readonly shareDelta: number;
  /**
   * ★ **new-path 档**：`VECTOR_ROUTER='flat'` 的 store 上 `recall({ context, queryEmbedding })`
   * ⇒ **向量路真的在召回内部跑了**（全表精确点积）。
   *
   * ⚠️ **键名 `recallVectorPath` 与 `bench/perf.ts` 的同名档同义**（都是「整条召回」）
   *   ⇒ 但**上下文不同**：这里是 **flat 路线**、那边是**分桶路线**
   *   ⇒ ⇒ **两条数不许横向比**（一条是「改造前」、一条是「改造后」）。
   */
  readonly recallVectorPath: BaselineFlatRecallVectorPath;
}

/**
 * ★ **new-path 档的读数**（`VECTOR_ROUTER='flat'` + 传 `queryEmbedding`）。
 *
 * ⚠️ **为什么这一档必须自带一条 old-path 基线**（`oldPathMeanMs`）：
 *   本文件原有的 `recallLatency` 是量在**另一个 store**（`auto` 模式的 `store`）上的
 *   ⇒ 两个 store 是两个 `MemoryStore` 实例（各自的预编译语句、各自的缓存）
 *   ⇒ 用「新档 − 原有 `recallLatency`」当差值 ⇒ 差值里混进了「换实例」这件事
 *   ⇒ ⇒ 所以新档**在自己的 store 上**再测一条不传向量的召回（`oldPathMeanMs`）
 *   ⇒ 差值是**同一个实例上**的量（只差「传不传向量」这一个变量）。
 */
export interface BaselineFlatRecallVectorPath {
  /** 样本数（0 ⇒ 本档缺席：调用方没给 flat 模式的 store）。 */
  readonly samples: number;
  /** 耗时分布（**整条召回**，含向量路）。 */
  readonly latency: ReturnType<typeof summarizeLatency>;
  /** P99（毫秒）。 */
  readonly p99Ms: number;
  /** 均值（毫秒）。 */
  readonly meanMs: number;
  /** **同一个 store 上**不传向量的召回均值（毫秒）—— 新档的对照基线。 */
  readonly oldPathMeanMs: number;
  /** `meanMs − oldPathMeanMs`（毫秒；**正数 = 接线后更慢**）。 */
  readonly meanDeltaMs: number;
  /**
   * 「向量路在**整条召回**里占多少」（推导值；`null` ⇒ 本档缺席）。
   *
   * ⚠️ **算法**：`meanDeltaMs ÷ meanMs` ⇒ 分子 = 「把向量路接进来之后召回变慢了多少」
   *   ⇒ 它就是 flat 路线下向量路在召回里的**真实占比**（§12 那条「≥80%」证据的
   *   **直接可测形态**）。
   * ⚠️ **可能为负**（差值被噪声 / 页缓存状态吃掉）⇒ **负数照实落盘，不钳到 0**
   *   （钳掉就等于伪造「向量路确实占了钱」这个结论）。
   * ⚠️ 它是**两个独立档的差**，不是一次调用内的段计时 ⇒ **只作量级参考**。
   */
  readonly vectorShareFromDelta: number | null;
  /** 采样之后、计时之外的一次性探针（复用 `bench/perf.ts` 的实现 ⇒ 一份口径）。 */
  readonly probe: VectorPathProbe;
  /** 口径说明（**必须落盘**）。 */
  readonly note: string;
}

/**
 * 测一次「flat 路线下向量路的耗时占比」。
 *
 * @param db 库句柄（**已灌语料**）
 * @param store 生产门面（**auto 模式**；原有档用它 ⇒ 与历史基线可比）
 * @param options 语料参数
 * @param queryCount 查询条数
 * @param flatStore **flat 模式**的生产门面（`VECTOR_ROUTER='flat'`）；
 *                  `null` ⇒ **new-path 档缺席**（落盘 `samples: 0` + 说明，**不猜**）
 * @returns 测量结果
 */
export function measureBaselineFlat(
  db: Database.Database,
  store: MemoryStore,
  options: CorpusOptions,
  queryCount: number,
  flatStore: MemoryStore | null = null,
): BaselineFlatResult {
  const queries = generateQueries(options, queryCount);
  const flatSamples: number[] = [];
  const recallSamples: number[] = [];
  // ── new-path 档的三个样本数组 ──
  //   `flatOldPathSamples` = **同一个 flat store 上**不传向量的召回（差值用的基线）。
  const recallVectorSamples: number[] = [];
  const flatOldPathSamples: number[] = [];

  // ★ **查询向量在计时之外一次转好**（`bench/corpus.ts` 给的是 `Float32Array`，
  //   `RecallOptions.queryEmbedding` 要的是 `number[]`）：
  //   · **不许 `as` 强转**：那不是转换，只是把错推迟到运行时（`Array.isArray()` 才是判据）；
  //   · **不许在计时窗口里转**：转换是**调用方**的成本（生产里向量由应用侧算好再传）
  //     ⇒ 计入就污染 P99。
  const queryVectors: number[][] = queries.map((query) => Array.from(query.embedding));

  // ── 预热（**不计入统计**）──
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    const query = queries[round % Math.max(1, queries.length)];
    if (query !== undefined) {
      flatTopK(db, query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
    }
    store.recall({ context: '预热', now: BENCH_NOW });
    // ★ new-path 档也要预热（JIT + 页缓存 + 端口首次装配 + `flat_explicit` 判定）
    //   ⇒ 不预热 ⇒ new-path 的 P99 会被第一轮冷启动主导。
    const warmVector = queryVectors[round % Math.max(1, queryVectors.length)];
    if (flatStore !== null && query !== undefined && warmVector !== undefined) {
      flatStore.recall({ context: '预热', now: BENCH_NOW });
      flatStore.recall({ context: '预热', queryEmbedding: warmVector, now: BENCH_NOW });
    }
  }

  // ── 原有档（**口径与顺序一个都不改** ⇒ 与已落盘的历史基线可比）──
  for (const query of queries) {
    const start = process.hrtime.bigint();
    flatTopK(db, query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
    const end = process.hrtime.bigint();
    flatSamples.push(Number(end - start) / 1_000_000);

    const recallStart = process.hrtime.bigint();
    store.recall({ context: query.context, now: BENCH_NOW });
    const recallEnd = process.hrtime.bigint();
    recallSamples.push(Number(recallEnd - recallStart) / 1_000_000);
  }

  // ── ★ new-path 档（`flat_explicit` ⇒ 向量路在召回内部真跑）──
  // ⚠️ **两档背靠背，并按查询序号轮换先后**（偶数 old 先 / 奇数 new 先）：
  //   先跑的那一档替后跑的那一档装载页缓存 ⇒ 固定顺序会让后跑者被系统性优待
  //   ⇒ 而本档要回答的正是「这两档差多少」⇒ 顺序偏置必须对称掉。
  if (flatStore !== null) {
    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index];
      if (query === undefined) {
        continue;
      }
      const queryVector = queryVectors[index] ?? [];
      /** 基线：**同一个 flat store 上**不传向量（向量路整段不执行）。 */
      const sampleOldPath = (): void => {
        const start = process.hrtime.bigint();
        flatStore.recall({ context: query.context, now: BENCH_NOW });
        const end = process.hrtime.bigint();
        flatOldPathSamples.push(Number(end - start) / 1_000_000);
      };
      /** 目标档：传向量 ⇒ 召回内部走**全表精确点积**。 */
      const sampleNewPath = (): void => {
        const start = process.hrtime.bigint();
        flatStore.recall({ context: query.context, queryEmbedding: queryVector, now: BENCH_NOW });
        const end = process.hrtime.bigint();
        recallVectorSamples.push(Number(end - start) / 1_000_000);
      };
      if (index % 2 === 1) {
        sampleNewPath();
        sampleOldPath();
      } else {
        sampleOldPath();
        sampleNewPath();
      }
    }
  }

  const flatMean = meanOf(flatSamples);
  const recallMean = meanOf(recallSamples);
  const total = flatMean + recallMean;
  const vectorShare = total === 0 ? 0 : flatMean / total;

  // ── ★ new-path 档的读数 ──
  const vectorLatency = summarizeLatency(recallVectorSamples);
  const flatOldPathMean = meanOf(flatOldPathSamples);
  const meanDeltaMs = vectorLatency.meanMs - flatOldPathMean;
  const recallVectorPath: BaselineFlatRecallVectorPath = {
    samples: recallVectorSamples.length,
    latency: vectorLatency,
    p99Ms: vectorLatency.p99Ms,
    meanMs: vectorLatency.meanMs,
    oldPathMeanMs: flatOldPathMean,
    meanDeltaMs,
    vectorShareFromDelta: vectorLatency.meanMs > 0 ? meanDeltaMs / vectorLatency.meanMs : null,
    // ⚠️ **采样之后、计时窗口之外**跑（放前面会改变两档的采样条件）。
    probe:
      flatStore === null
        ? {
            ran: false,
            candidates: 0,
            mode: 'unknown',
            note:
              '⚠️ 本档**缺席**：调用方没提供 `VECTOR_ROUTER=flat` 的 store ⇒ 探针无从执行 ' +
              '⇒ `ran=false` 是**未测**，**不代表** flat 路线的向量路跑不起来。',
          }
        : probeVectorPathOfRecall(flatStore, queries, queryVectors),
    note:
      '① **new-path 档** = `VECTOR_ROUTER=flat` 的 store 上 `recall({ context, queryEmbedding, now })`' +
      '（四态判定 ⇒ `flat_explicit`）⇒ **向量路真的在召回内部跑了**，走**全表精确点积**；' +
      '② **对照基线 `oldPathMeanMs` 是同一次运行、同一个 store 上不传向量**的召回均值' +
      '⇒ 差值是「只差传不传向量」这一个变量（不用原有 `recallLatency`：那是另一个 store 实例的量）；' +
      '③ 两档**背靠背跑、按查询序号轮换先后**（偶数 old 先 / 奇数 new 先）⇒ 对称掉「后跑者得利」；' +
      '④ `vectorShareFromDelta` = `meanDeltaMs ÷ meanMs` ⇒ flat 路线下向量路在**整条召回**里的占比' +
      '（§12 那条「≥80%」证据的**直接可测形态**）；⚠️ **可能为负**（噪声 / 页缓存状态）⇒ 照实落盘、不钳 0；' +
      '⑤ ⚠️ **本档与原「向量路耗时占比」(`vectorShare`) 不是同一条数**：`vectorShare` 的分子是' +
      '`flatTopK()` 的**手工扫描**（不含文本路 / 图谱路 / 打分 / 排序），本档是**整条召回**；' +
      '⑥ `probe` 复用 `bench/perf.ts` 的 `probeVectorPathOfRecall()`（一份口径）' +
      '⇒ `ran=true` 才证明「向量路真在召回里跑」，只靠耗时差区分不了「跑了但很快」与「没跑」。',
  };

  return {
    corpusSize: options.size,
    samples: queries.length,
    warmupRounds: WARMUP_ROUNDS,
    flatVectorLatency: summarizeLatency(flatSamples),
    recallLatency: summarizeLatency(recallSamples),
    vectorShare,
    shareDelta: vectorShare - FLAT_SHARE_REFERENCE,
    recallVectorPath,
  };
}

/**
 * 样本的均值（**空样本返回 0**）。
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

/** 主流程（**独立可跑**：`pnpm exec tsx bench/baseline-flat.ts`）。 */
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scale = intArg(args, 'scale', DEFAULT_CORPUS_OPTIONS.size);
  const queryCount = intArg(args, 'queries', 100);
  const seed = intArg(args, 'seed', DEFAULT_CORPUS_OPTIONS.seed);
  const dbPath = stringArg(args, 'db', `${benchWorkDir()}/baseline-flat-${scale}.db`);
  const outPath = stringArg(args, 'out', `docs/baseline/baseline-flat-${scale}.json`);

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
    `前置测量（flat 路线的向量路耗时占比）：语料 ${scale} 条 / 查询 ${queryCount} 条\n`,
  );

  // ⚠️ **走共享的库准备流程**（`bench/lib/db.ts`）⇒ 三个脚本的准备口径**同一份**
  //   ⇒ 不会「一个脚本灌了、另一个脚本没灌」这种漂移（C36）。
  //   ⇒ ⚠️ **本脚本不需要训练分桶**（它测的是 flat 路线 ⇒ 桶不参与）
  //   ⇒ 但**仍要训练**：不训练就没有「改造后」的对照数据，且 `prepareBench`
  //     的训练耗时是**资源规划**（§12 的 R-04）的一部分 ⇒ 一次跑完，两头都要。
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
  // ★ **flat 模式的第二个门面**（new-path 档要多在它上面跑）：
  //   `VECTOR_ROUTER='flat'` ⇒ 四态判定 ⇒ `flat_explicit`
  //   （`src/store/stats.ts` 的第 1 条判据：「调用方显式选了 flat ⇒ 那是要求，不是降级」）
  //   ⇒ ⇒ 这就是「改造前」的**真实运行形态**（不再靠手工模拟）。
  //   ⚠️ **为什么另开一个实例而不是改这个 `store`**：`MemoryConfig.params` 只在**构造时**生效
  //     （`setParams()` 改不动 `VECTOR_ROUTER` 这种影响已建索引的参数）；
  //     而两个实例读同一个库文件是安全的（均为读多写少）⇒ 代价可接受。
  const flatStore = new MemoryStore({ dbPath, params: { VECTOR_ROUTER: 'flat' } });
  const result = measureBaselineFlat(db, store, options, queryCount, flatStore);

  writeJsonFile(outPath, {
    corpusSize: result.corpusSize,
    samples: result.samples,
    warmupRounds: result.warmupRounds,
    flatVectorLatency: result.flatVectorLatency,
    recallLatency: result.recallLatency,
    vectorShare: result.vectorShare,
    reference: FLAT_SHARE_REFERENCE,
    shareDelta: result.shareDelta,
    // ⚠️ ★ **new-path 档（新键，不与上面任何键重名）**：
    //   `recallLatency` / `vectorShare` / `shareDelta` 是**原有档**（手工扫描 + 不传向量的召回）；
    //   `recallVectorPath` 是**新增档**（flat 模式 + 传向量 ⇒ 向量路在 recall 内部真跑）。
    recallVectorPath: result.recallVectorPath,
    note:
      '这是「改造前」的前置测量（证据，不是验收条件）；' +
      '「改造后」的分桶路线占比见 bench/perf.ts 的 vectorRouteShare。' +
      '★ 自 2026-11-02 起本文件有两个档：原有档（flatVectorLatency / recallLatency / ' +
      'vectorShare ⇒ 手工组装的全表扫描 + 不传向量的召回）与 new-path 档（recallVectorPath ' +
      '⇒ VECTOR_ROUTER=flat 的 store 上传向量的召回，向量路真在 recall 内部跑）；' +
      '两档口径不同（扫描本身 vs 整条召回），不许合成一个数。',
    benchNow: BENCH_NOW,
    machine,
    phases: phaseInfo(prepared),
  });

  process.stdout.write(
    `  flat 向量路耗时（手工扫描本身，不经 recall）：p50 ${result.flatVectorLatency.p50Ms.toFixed(3)}ms / ` +
      `p99 ${result.flatVectorLatency.p99Ms.toFixed(3)}ms（样本 ${result.samples}）\n` +
      `  recall（old-path · 不传向量，auto 模式）：p50 ${result.recallLatency.p50Ms.toFixed(3)}ms / ` +
      `p99 ${result.recallLatency.p99Ms.toFixed(3)}ms\n` +
      `  ★ recall（new-path · 传向量，flat 模式）：p50 ${result.recallVectorPath.latency.p50Ms.toFixed(3)}ms / ` +
      `p99 ${result.recallVectorPath.p99Ms.toFixed(3)}ms（样本 ${result.recallVectorPath.samples}）` +
      ` ｜ 同 store 不传向量基线均 ${result.recallVectorPath.oldPathMeanMs.toFixed(3)}ms` +
      ` ｜ 差值 ${result.recallVectorPath.meanDeltaMs.toFixed(3)}ms\n` +
      `  ★ new-path 探针：向量路 ran = ${result.recallVectorPath.probe.ran}` +
      `（mode = ${result.recallVectorPath.probe.mode}，候选 ${result.recallVectorPath.probe.candidates} 条）\n` +
      `  ★ 向量路在整条召回里的占比（推导值）= ${
        result.recallVectorPath.vectorShareFromDelta === null
          ? '**未测到**'
          : `${(result.recallVectorPath.vectorShareFromDelta * 100).toFixed(2)}%`
      }（可能为负 ⇒ 照实落盘、不钳 0）\n` +
      `  **原口径 向量路耗时占比 = ${(result.vectorShare * 100).toFixed(2)}%**` +
      `（参考线 ≥ ${(FLAT_SHARE_REFERENCE * 100).toFixed(0)}% ⇒ ` +
      `${result.shareDelta >= 0 ? '达标' : '未达标'}；分子 = 手工扫描本身）\n` +
      `  灌库 ${formatLoadMs(prepared.loadMs)} / 训练 ${prepared.trainMs.toFixed(0)}ms / ` +
      `${formatPeakRss(prepared.trainPeakRss)}\n` +
      `  结果已写入 ${outPath}\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  main();
}
