/**
 * **吻合率测量** —— P2-T08 的核心验收项（DEVELOPMENT-PLAN.md 行 2041~2052）。
 *
 * ⚠️ **口径（C29 + C30，逐条钉死）**：
 *   · **分母** = flat 的 **top-20 全集**（`|flat_top20|`），**不是**候选全集、不是别的；
 *   · **分子** = `|bucket_top20 ∩ flat_top20|`（**集合交集**，**不是**顺序比较）；
 *   · 判据 = **`|intersect| / |flat_top20| ≥ 0.98`**（**软阈值** ⇒ 允许「漏」）。
 *   ⇒ **不查条数相等**（探针边界效应 ⇒ 允许少一条）。
 *
 * ⚠️ ★ **「只漏不错」怎么写成断言**（本任务的硬要求）：
 *   「不错」= **分桶结果里的每一条都必须出现在 flat 的 top-20 里**
 *   ⇒ 断言形式：**分桶 top-20 ⊆ flat top-20**（**集合包含**，不是顺序相等）。
 *   ⚠️ **为什么这是「只查漏、不查错」**：
 *   · 「漏」⇒ flat top-20 里有、而分桶 top-20 里没有的 ⇒ **允许**（探针边界效应）
 *     ⇒ 只体现在**吻合率**上（`|intersect| / |flat_top20|` 掉了）。
 *   · 「错」⇒ 分桶 top-20 里有、而 flat top-20 里没有的 ⇒ **不允许**
 *     ⇒ 这就是 `bucket ⊆ flat` 的**集合包含**断言。
 *   ⇒ **两个断言合起来 = 「只漏不错」**：分桶不引入 flat 之外的候选（不错），
 *     同时允许漏掉少数（只漏，且漏的比例被 0.98 卡住）。
 *
 * ⚠️ **分桶 ⊆ flat 的「分母纪律」（C29）**：另有一条**独立的**断言
 *   ——「**分桶候选集合 ⊆ flat 候选全集**」，分母是 **flat 的候选全集**
 *   （**不是** flat 的 top-20）⇒ 否则探针不足会被误判成算法错误（**假失败**）。
 *   ⚠️ **为什么这条与上面的「分桶 top-20 ⊆ flat top-20」不是同一条**：
 *   前者比的是**结果**（top-20），后者比的是**候选面**（探针扫过的那批行）。
 *   ⇒ 前者会因探针不足而**真的**不成立（漏的那条会同时让分桶 top-20 少一条 ⇒
 *     仍是子集成立！**因为少的是 flat 里的 ⇒ 不错**）；
 *   后者比的是**桶扫到的行**（可能远多于 20 条）⇒ 它必须 ⊆ flat 的**候选全集**
 *   （不是 top-20）⇒ 这才是 C29 的分母纪律。
 *
 * ⚠️ **规模**：默认 **100 万条**（§7.1 的验收行：规模必须写进验收行）。
 *   ⇒ 实测跑不动时**不许**把小规模说成 100 万 ⇒ 报告里必须写清**实际规模**。
 * ⚠️ ★ **规模守卫**（P2 收官 · Q-02）：**规模 < 100 万 ⇒ 直接失败**
 *   （抛错 + **非零退出码** + **不落盘**）⇒ 因为「小库根本走不到分桶路径」
 *   ⇒ **在小库上测得的吻合率什么也没验到** ⇒ 不许冒充验收结论。
 *   ⚠️ **降级开关 `--allow-small-scale`（默认关闭）**：只为冒烟 / 自检 / 工具链联调
 *   留一条**合法的小规模路径**（否则每次自检都要 5 小时）；
 *   **默认必须拒绝** ⇒ 降级跑出来的文件名**带规模数字** ⇒ 一眼可辨。
 *
 * 用法：
 * ```
 * pnpm exec tsx bench/agreement.ts --scale=1000000 --queries=100
 * ```
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../src/core/params.js';
import { loadCentroidModel } from '../src/vector/centroids.js';
import { IvfVectorBackend } from '../src/vector/ivf.js';
import {
  type BenchQuery,
  type CorpusOptions,
  DEFAULT_CORPUS_OPTIONS,
  generateQueries,
  querySynonymCosine,
} from './corpus.js';
import { prepareBench } from './lib/db.js';
import { flatCandidateUniverse, flatTopK, flatTopKMulti } from './lib/flat.js';
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

/** 吻合率的**软阈值**（§7.1 验收行：吻合率 ≥ 0.98）。 */
export const AGREEMENT_THRESHOLD = 0.98;

/**
 * ★ **「同义改写真的接近」的下限**（**硬断言**：这是**测量有效性的前提**，不是性能门槛）。
 *
 * ⚠️ **为什么它是硬断言**：如果查询（= 同义改写）与它改写的那条记录在向量上不接近
 *   ⇒ 说明语料的「同义」是假的 ⇒ 测出来的吻合率**不是**「探针覆盖不足导致的漏」
 *   而是「语义本来就不该匹配」⇒ **整个吻合率结论无效**。
 *   ⇒ 所以它是**前提条件**：不满足就直接判失败（而不是记一条 warning）。
 *
 * ⚠️ **为什么下限取 0.5 而不是 0.9**：真实 embedder 的同义改写余弦会随语料波动
 *   ⇒ 门槛定太高 ⇒ 因语料波动而 flaky ⇒ 门禁失效。
 *   ⇒ 0.5 足够区分「同义（同组 ⇒ 0.85~0.97）」与「不同组（≈ 0.02）」两种形态。
 */
export const SYNONYM_COSINE_MIN = 0.5;

/** 参与比较的 top-N（**与 §4.6 步骤 2c 的 `VECTOR_TOPK` 一致**）。 */
export const TOP_N = DEFAULT_PARAMS.VECTOR_TOPK;

/** 一次吻合率测量的结果。 */
export interface AgreementResult {
  /** 语料规模（**必须写进报告** ⇒ 不许把小规模说成大规模）。 */
  readonly corpusSize: number;
  /** 查询条数。 */
  readonly queryCount: number;
  /** 逐条查询的吻合率（**分母 = flat top-20 全集**）。 */
  readonly perQuery: readonly number[];
  /** 总体吻合率（**分子 = 全部交集之和，分母 = 全部 flat top-20 之和**）。 */
  readonly overall: number;
  /** 最差的一条查询的吻合率。 */
  readonly worst: number;
  /** 最好的一条查询的吻合率。 */
  readonly best: number;
  /** 「漏」的总数（flat 有、分桶没有的）。 */
  readonly missingTotal: number;
  /** 「错」的总数（分桶有、flat 没有的）—— **必须为 0**（不错）。 */
  readonly extraTotal: number;
  /** flat 的候选全集规模（**C29 的分母**）。 */
  readonly flatCandidateUniverse: number;
  /** 分桶探到的候选条数（**分桶 ⊆ flat 候选全集**的实测）。 */
  readonly bucketCandidateTotal: number;
  /** 分桶候选里**不在** flat 候选全集里的条数（**必须为 0**）。 */
  readonly bucketCandidatesOutsideUniverse: number;
  /** 每条查询的耗时（毫秒）—— 探针覆盖的代价。 */
  readonly queryLatency: readonly number[];
  /** ★ **查询与「它改写的那条记录」之间的余弦均值**（同义改写真的接近的实测证据）。 */
  readonly synonymCosineMean: number;
  /** ★ **同上，最小值**。 */
  readonly synonymCosineMin: number;
  /** ★ **同上，最大值**。 */
  readonly synonymCosineMax: number;
  /**
   * ★ **桶内精确性**（C30 的「有没有算错」那半）。
   *
   * ⚠️ **这是硬断言**（不是软阈值）：分桶的 top-K 必须与
   *   「对同一个桶集合做全量精确扫描」的 top-K **逐位相同**（id / 顺序 / 分数）。
   *   ⇒ 不一致的描述在这里（**空数组 = 逐位相同**）。
   */
  readonly bucketInternalMismatches: readonly string[];
}

/**
 * 测一次吻合率。
 *
 * @param db 库句柄（**已灌语料、已训练分桶**）
 * @param options 语料参数
 * @param queryCount 查询条数
 * @param params 参数表（探针数从中取 ⇒ **不写死数字**）
 * @returns 测量结果
 */
export function measureAgreement(
  db: Database.Database,
  options: CorpusOptions,
  queryCount: number,
  params: typeof DEFAULT_PARAMS = DEFAULT_PARAMS,
): AgreementResult {
  const queries = generateQueries(options, queryCount);
  const model = loadCentroidModel(db);
  const backend = new IvfVectorBackend({
    db,
    centroids: () => model,
    nprobeCoarse: params.ROUTER_NPROBE_COARSE,
    nprobeFine: params.ROUTER_NPROBE_FINE,
  });
  backend.init({
    dimensions: params.EMBED_DIM,
    coarseCenters: params.ROUTER_COARSE_CENTERS,
    fineCenters: params.ROUTER_FINE_CENTERS,
  });

  const universe = flatCandidateUniverse(db);
  const perQuery: number[] = [];
  const latencies: number[] = [];
  const synonymCosines: number[] = [];
  let intersectSum = 0;
  let flatSum = 0;
  let missingTotal = 0;
  let extraTotal = 0;
  let bucketCandidateTotal = 0;
  let bucketCandidatesOutsideUniverse = 0;
  const internalMismatches: string[] = [];

  // ⚠️ ★ **flat 参照用「一遍全表」的批量版**：
  //   百万条下本机的磁盘只有 ~2.4MB/s ⇒ 每个查询单独扫一遍 2.17GB ≈ 15 分钟
  //   ⇒ 合成一遍扫描后，**每条查询仍是全表精确 top-20**（口径不变）。
  const flatHitsPerQuery = flatTopKMulti(
    db,
    queries.map((query) => query.embedding),
    TOP_N,
  );

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex] as BenchQuery;
    const start = process.hrtime.bigint();
    const bucketHits = backend.search(query.embedding, TOP_N);
    const end = process.hrtime.bigint();
    latencies.push(Number(end - start) / 1_000_000);

    // ⚠️ ★ **桶内精确性**（C30 的硬断言那半）：
    //   分桶的 top-K 与「对同一个桶集合做全量精确扫描」的 top-K 逐位比较。
    for (const mismatch of bucketInternalMismatches(db, backend, query.embedding, TOP_N)) {
      internalMismatches.push(`查询 ${query.id}：${mismatch}`);
    }

    // ⚠️ ★ **先量「同义改写真的接近」**（关键口径 #2 的实测证据）。
    synonymCosines.push(querySynonymCosine(query));

    // ⚠️ **flat 参照**：同一候选宇宙上的**精确 top-N**（分桶扫的是「桶内精确点积」，
    //   flat 是「全表精确点积」⇒ 唯一的差别就是**探针覆盖**）。
    const flatHits = flatHitsPerQuery[queryIndex] ?? [];
    const flatIds = new Set(flatHits.map((hit) => hit.id));
    const bucketIds = new Set(bucketHits.map((hit) => hit.id));

    let intersect = 0;
    for (const id of bucketIds) {
      if (flatIds.has(id)) {
        intersect += 1;
      }
    }
    // ⚠️ **「错」**：分桶有、flat 没有 ⇒ 必须为 0（不错）。
    for (const id of bucketIds) {
      if (!flatIds.has(id)) {
        extraTotal += 1;
      }
    }
    // ⚠️ **「漏」**：flat 有、分桶没有 ⇒ 允许（探针边界效应 ⇒ 只漏）。
    for (const id of flatIds) {
      if (!bucketIds.has(id)) {
        missingTotal += 1;
      }
    }

    intersectSum += intersect;
    flatSum += flatIds.size;
    perQuery.push(flatIds.size === 0 ? 1 : intersect / flatIds.size);
  }

  // ⚠️ **分桶候选 ⊆ flat 候选全集**（C29 的分母纪律）：
  //   分母是**候选全集**（不是 flat 的 top-20）⇒ 探针不足不会被误判成算法错误。
  const bucketMembers = db.prepare('SELECT memory_id FROM vector_cell_members').all() as Array<{
    memory_id: string;
  }>;
  for (const member of bucketMembers) {
    bucketCandidateTotal += 1;
    if (!universe.has(member.memory_id)) {
      bucketCandidatesOutsideUniverse += 1;
    }
  }

  return {
    corpusSize: options.size,
    queryCount: queries.length,
    perQuery,
    overall: flatSum === 0 ? 1 : intersectSum / flatSum,
    worst: perQuery.length === 0 ? 1 : Math.min(...perQuery),
    best: perQuery.length === 0 ? 1 : Math.max(...perQuery),
    missingTotal,
    extraTotal,
    flatCandidateUniverse: universe.size,
    bucketCandidateTotal,
    bucketCandidatesOutsideUniverse,
    queryLatency: latencies,
    synonymCosineMean:
      synonymCosines.length === 0
        ? 0
        : synonymCosines.reduce((total, value) => total + value, 0) / synonymCosines.length,
    synonymCosineMin: synonymCosines.length === 0 ? 0 : Math.min(...synonymCosines),
    synonymCosineMax: synonymCosines.length === 0 ? 0 : Math.max(...synonymCosines),
    bucketInternalMismatches: internalMismatches,
  };
}

/**
 * 吻合率的**断言**（**逐条写死** ⇒ 可被变异打红）。
 *
 * ⚠️ **断言分三类**（对应「吻合率」与「分桶 ⊆ flat」两条口径）：
 *   ① **吻合率**：总体 `|intersect| / |flat_top20| ≥ 0.98`（**软阈值** ⇒ 允许漏）。
 *   ② **只漏不错（不错部分）**：分桶 top-20 ⊆ flat top-20 ⇒ **错数必须为 0**。
 *      ⚠️ **逐条查**（不是只查总数）⇒ 变异把某个 id 换掉时**这条会红**。
 *   ③ **分桶 ⊆ flat 候选全集（C29）**：桶成员里不在 flat 候选全集的**必须为 0**。
 *
 * @param result 测量结果
 * @returns 违规清单（**空数组 = 全部通过**）
 */
/**
 * ★ ★ **桶内精确性的硬断言**（C30 的「有没有算错」那半）。
 *
 * ⚠️ **为什么要单独一条**：C30 把问题分为两个区：
 *   · **「有没有算错」** ⇒ **硬断言**：桶内是**精确点积**，
 *     不得产生**近似误差** ⇒ 断言：
 *     **分桶的 top-K 与「对同一个桶集合做全量精确扫描」的 top-K 逐位相同**；
 *   · **「漏了多少」** ⇒ **软断言**：探针边界效应 ⇒ 合瑶率 ≥ 0.98。
 * ⇒ 两条合起来才是完整的「只漏不错」。
 *
 * ⚠️ **口径为什么是「同一个桶集合」**：
 *   分桶路径只扫命中桶的成员 ⇒ 它的候选集合就是「命中桶的全部成员」
 *   ⇒ 把同一个集合交给**全量精确扫描**（bench/lib/flat.ts 的 `restrict` 参数）
 *   ⇒ 两边应该**逐位相同**（id、顺序、分数）。
 *
 * @param db 库句柄
 * @param backend 生产的分桶后端
 * @param query 查询向量
 * @param k 取前 K 条
 * @returns 不一致清单（**空数组 = 逐位相同**）
 */
export function bucketInternalMismatches(
  db: Database.Database,
  backend: IvfVectorBackend,
  query: Float32Array,
  k: number,
): string[] {
  const fineIds = backend.route(
    query,
    DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
  );
  const members = new Set<string>();
  const statement = db.prepare('SELECT memory_id FROM vector_cell_members WHERE fine_id = ?');
  for (const fineId of fineIds) {
    for (const row of statement.all(fineId) as Array<{ memory_id: string }>) {
      members.add(row.memory_id);
    }
  }

  // ⚠️ **参考**：对同一个桶集合做**全量精确扫描**（流式、同一个口径）。
  const expected = flatTopK(db, query, k, undefined, members);
  const actual = backend.search(query, k);

  const mismatches: string[] = [];
  if (expected.length !== actual.length) {
    mismatches.push(
      `桶内 top-K 条数不同：全量扫描 ${expected.length} 条 vs 分桶 ${actual.length} 条`,
    );
  }
  const limit = Math.min(expected.length, actual.length);
  for (let index = 0; index < limit; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left === undefined || right === undefined) {
      break;
    }
    if (left.id !== right.id) {
      mismatches.push(`桶内第 ${index + 1} 名 id 不同：全量扫描 ${left.id} vs 分桶 ${right.id}`);
      break;
    }
    if (left.score !== right.score) {
      mismatches.push(
        `桶内第 ${index + 1} 名分数不同：全量扫描 ${left.score} vs 分桶 ${right.score}（${left.id}）`,
      );
      break;
    }
  }
  return mismatches;
}

export function checkAgreement(result: AgreementResult): string[] {
  const failures: string[] = [];

  // ① 吻合率（总体口径：分母 = flat top-20 全集之和）。
  if (result.overall < AGREEMENT_THRESHOLD) {
    failures.push(
      `吻合率 ${result.overall.toFixed(6)} < ${AGREEMENT_THRESHOLD}（分母 = flat top-20 全集）`,
    );
  }

  // ② 「不错」：错数必须为 0（分桶不得引入 flat top-20 之外的候选）。
  if (result.extraTotal !== 0) {
    failures.push(`「不错」被破：分桶 top-20 里有 ${result.extraTotal} 条不在 flat top-20 里`);
  }

  // ③ C29 的分母纪律：分桶候选 ⊆ flat **候选全集**（不是 top-20）。
  if (result.bucketCandidatesOutsideUniverse !== 0) {
    failures.push(
      `C29 被破：${result.bucketCandidatesOutsideUniverse} 条分桶候选不在 flat 的候选全集里` +
        `（全集 ${result.flatCandidateUniverse} 条）`,
    );
  }

  // ⚠️ **非空查询**（否则「吻合率 = 1」是**真空通过**）。
  if (result.queryCount === 0) {
    failures.push('查询数为 0 ⇒ 吻合率是真空通过（必须至少有查询）');
  }

  // ④ ★ **桶内精确性**（C30 的「有没有算错」那半 ⇒ **硬断言**）。
  if (result.bucketInternalMismatches.length > 0) {
    failures.push(
      '「算错」被破：桶内 top-K 与「对同一个桶集合做全量精确扫描」不逐位相同' +
        `（${result.bucketInternalMismatches.length} 处，首处：${result.bucketInternalMismatches[0] ?? ''}）`,
    );
  }

  // ⑤ ★ **「同义改写真的接近」**（**测量有效性的前提** ⇒ 不满足则结论无效）。
  if (result.synonymCosineMean < SYNONYM_COSINE_MIN) {
    failures.push(
      `同义改写余弦均值 ${result.synonymCosineMean.toFixed(6)} < ${SYNONYM_COSINE_MIN}` +
        '（语料的「同义」不成立 ⇒ 吻合率结论无效）',
    );
  }

  return failures;
}

/** 主流程（**独立可跑**：`pnpm exec tsx bench/agreement.ts`）。 */
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scale = intArg(args, 'scale', DEFAULT_CORPUS_OPTIONS.size);
  const queryCount = intArg(args, 'queries', 100);
  const seed = intArg(args, 'seed', DEFAULT_CORPUS_OPTIONS.seed);
  const dbPath = stringArg(args, 'db', `${benchWorkDir()}/agreement-${scale}.db`);
  const outPath = stringArg(args, 'out', `docs/baseline/agreement-${scale}.json`);

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
  process.stdout.write(`吻合率测量：语料 ${scale} 条 / 查询 ${queryCount} 条 / 库 ${dbPath}\n`);

  // ⚠️ **走共享的库准备流程**（`bench/lib/db.ts`）⇒ 三个脚本的准备口径**同一份**
  //   ⇒ 不会「一个脚本灌了、另一个脚本没灌」这种漂移（C36）。
  const prepared = prepareBench({
    dbPath,
    corpus: options,
    coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
    fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
    nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    reuseExisting: args.reuse === 'true',
  });
  const db = prepared.db;
  const result = measureAgreement(db, options, queryCount);
  const failures = checkAgreement(result);

  const latency = summarizeLatency(result.queryLatency);
  writeJsonFile(outPath, {
    corpusSize: result.corpusSize,
    trainedCells: prepared.fineCells,
    trainedMembers: prepared.members,
    flatCandidateUniverseSize: result.flatCandidateUniverse,
    queryCount: result.queryCount,
    overall: result.overall,
    worst: result.worst,
    best: result.best,
    missingTotal: result.missingTotal,
    extraTotal: result.extraTotal,
    flatCandidateUniverse: result.flatCandidateUniverse,
    bucketCandidateTotal: result.bucketCandidateTotal,
    bucketCandidatesOutsideUniverse: result.bucketCandidatesOutsideUniverse,
    synonymCosineMean: result.synonymCosineMean,
    synonymCosineMin: result.synonymCosineMin,
    synonymCosineMax: result.synonymCosineMax,
    bucketInternalMismatches: result.bucketInternalMismatches,
    queryLatencyMs: latency,
    perQueryAgreement: result.perQuery,
    failures,
    benchNow: BENCH_NOW,
    machine,
    phases: phaseInfo(prepared),
  });

  process.stdout.write(
    `  总体吻合率 = ${result.overall.toFixed(6)}（阈值 ${AGREEMENT_THRESHOLD}）\n` +
      `  最差 / 最好 = ${result.worst.toFixed(6)} / ${result.best.toFixed(6)}\n` +
      `  漏 = ${result.missingTotal} / 错 = ${result.extraTotal}（错必须为 0）\n` +
      `  同义改写余弦 均/小/大 = ${result.synonymCosineMean.toFixed(4)} / ` +
      `${result.synonymCosineMin.toFixed(4)} / ${result.synonymCosineMax.toFixed(4)}` +
      `（下限 ${SYNONYM_COSINE_MIN}）\n` +
      `  分桶候选 ${result.bucketCandidateTotal} 条 ⊆ flat 候选全集 ${result.flatCandidateUniverse} 条\n` +
      `  查询耗时 p50/p99 = ${latency.p50Ms.toFixed(3)} / ${latency.p99Ms.toFixed(3)} ms\n` +
      `  灌库 ${prepared.loadMs.toFixed(0)}ms / 训练 ${prepared.trainMs.toFixed(0)}ms / ` +
      `${formatPeakRss(prepared.trainPeakRss)}\n` +
      `  结果已写入 ${outPath}\n`,
  );

  if (failures.length > 0) {
    process.stderr.write(`\n✗ 吻合率验收失败（${failures.length} 处）：\n`);
    for (const failure of failures) {
      process.stderr.write(`    ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✓ 吻合率验收通过\n');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  main();
}
