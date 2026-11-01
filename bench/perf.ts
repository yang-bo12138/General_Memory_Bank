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
 * 用法：
 * ```
 * pnpm exec tsx bench/perf.ts --scale=1000000 --queries=200 --writes=200
 * ```
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../src/core/params.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { loadCentroidModel } from '../src/vector/centroids.js';
import { IvfVectorBackend } from '../src/vector/ivf.js';
import { type CorpusOptions, DEFAULT_CORPUS_OPTIONS, generateQueries } from './corpus.js';
import { embedText } from './embedder.js';
import { prepareBench } from './lib/db.js';
import {
  BENCH_NOW,
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
} as const;

/** 预热轮次（**不计入统计**）。 */
export const WARMUP_ROUNDS = 20;

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
  for (const query of queries) {
    const start = process.hrtime.bigint();
    backend.route(
      query.embedding,
      DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
      DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
    );
    backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
    const end = process.hrtime.bigint();
    vectorRouteSamples.push(Number(end - start) / 1_000_000);
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

  const recallMean = meanOf(recallSamples);
  const vectorMean = meanOf(vectorRouteSamples);
  // ⚠️ **「向量路占总耗时」的分母 = recall 全程 + 向量路**（接线后的真实构成）。
  const vectorRouteShare =
    recallMean + vectorMean === 0 ? 0 : vectorMean / (recallMean + vectorMean);

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
    recallLatency: toDistribution(recallSamples),
    writeLatency: toDistribution(writeSamples),
    vectorRouteLatency: toDistribution(vectorRouteSamples),
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
