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
 * ⚠️ **注意「改造前」在当前代码里不是一个可运行的模式**：
 *   本仓库的 `recall()` **尚未接线向量路**（`src/store/recall.ts` 步骤 2c 仍写着
 *   「本阶段整路缺席」）⇒ 「flat 路线」在本脚本里是**用生产 `FlatVectorBackend` 的
 *   候选口径手工组装的**（**同样的候选集合、同样的点积、同样的排序**）
 *   ⇒ **它测的是「若把向量路按 flat 口径接进召回，会占多少」**。
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
  /** recall（文本路 + 图谱路）的耗时分布（毫秒）。 */
  readonly recallLatency: ReturnType<typeof summarizeLatency>;
  /** **向量路耗时占比**（0~1）。 */
  readonly vectorShare: number;
  /** 与参考线的差（正数 = 达标）。 */
  readonly shareDelta: number;
}

/**
 * 测一次「flat 路线下向量路的耗时占比」。
 *
 * @param db 库句柄（**已灌语料**）
 * @param store 生产门面
 * @param options 语料参数
 * @param queryCount 查询条数
 * @returns 测量结果
 */
export function measureBaselineFlat(
  db: Database.Database,
  store: MemoryStore,
  options: CorpusOptions,
  queryCount: number,
): BaselineFlatResult {
  const queries = generateQueries(options, queryCount);
  const flatSamples: number[] = [];
  const recallSamples: number[] = [];

  // ── 预热（**不计入统计**）──
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    const query = queries[round % Math.max(1, queries.length)];
    if (query !== undefined) {
      flatTopK(db, query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
    }
    store.recall({ context: '预热', now: BENCH_NOW });
  }

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

  const flatMean = meanOf(flatSamples);
  const recallMean = meanOf(recallSamples);
  const total = flatMean + recallMean;
  const vectorShare = total === 0 ? 0 : flatMean / total;

  return {
    corpusSize: options.size,
    samples: queries.length,
    warmupRounds: WARMUP_ROUNDS,
    flatVectorLatency: summarizeLatency(flatSamples),
    recallLatency: summarizeLatency(recallSamples),
    vectorShare,
    shareDelta: vectorShare - FLAT_SHARE_REFERENCE,
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
  const machine = machineInfo();
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
  });
  const db = prepared.db;
  const store = new MemoryStore({ dbPath });
  const result = measureBaselineFlat(db, store, options, queryCount);

  writeJsonFile(outPath, {
    corpusSize: result.corpusSize,
    samples: result.samples,
    warmupRounds: result.warmupRounds,
    flatVectorLatency: result.flatVectorLatency,
    recallLatency: result.recallLatency,
    vectorShare: result.vectorShare,
    reference: FLAT_SHARE_REFERENCE,
    shareDelta: result.shareDelta,
    note:
      '这是「改造前」的前置测量（证据，不是验收条件）；' +
      '「改造后」的分桶路线占比见 bench/perf.ts 的 vectorRouteShare。',
    benchNow: BENCH_NOW,
    machine,
    phases: phaseInfo(prepared),
  });

  process.stdout.write(
    `  flat 向量路耗时：p50 ${result.flatVectorLatency.p50Ms.toFixed(3)}ms / ` +
      `p99 ${result.flatVectorLatency.p99Ms.toFixed(3)}ms（样本 ${result.samples}）\n` +
      `  recall（文本路+图谱路）：p50 ${result.recallLatency.p50Ms.toFixed(3)}ms / ` +
      `p99 ${result.recallLatency.p99Ms.toFixed(3)}ms\n` +
      `  **向量路耗时占比 = ${(result.vectorShare * 100).toFixed(2)}%**` +
      `（参考线 ≥ ${(FLAT_SHARE_REFERENCE * 100).toFixed(0)}% ⇒ ` +
      `${result.shareDelta >= 0 ? '达标' : '未达标'}）\n` +
      `  灌库 ${prepared.loadMs.toFixed(0)}ms / 训练 ${prepared.trainMs.toFixed(0)}ms / ` +
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
