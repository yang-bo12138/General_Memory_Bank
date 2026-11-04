/**
 * **可证上界剪枝**的共用原语（C′ 档 T04 ·
 * 规格 `docs/design/perf-c2-admissible-two-stage.md` §4 算法 / §5.1.1 接口 / §5.1.7 早停）。
 *
 * ## 这个模块存在的唯一理由
 *
 * 「两段式」（先读 768B 的 int8 码算**可证上界**，只对**可能入选**的行读 3KB 的原向量精确重排）
 * 在**读路径**（top-K 语义）与**写路径**（阈值 + top-K 语义）上是**同一件事**：
 * 「按上界降序精确重排，剩余上界的最大值已经不可能进前 K 时停止」。
 * ⇒ 把它写成一份实现 ⇒ 两条路不可能各写一份、也不可能各自漂移。
 *
 * ## 它与调用方的边界（四条纪律，每条都对应一个具体后果）
 *
 * | # | 纪律 | 不这么定会怎样 |
 * |---|---|---|
 * | ① | **不导出**「谁是第几名」的中间态，只给 `survivors` + 三个计数 | 导出堆 ⇒ 调用方会顺手拿堆内元素自己排序 ⇒ 定序出现第二份实现 |
 * | ② | **不自己算点积 / 不自己钳制**：`scoreOf` 由调用方注入 | 「结果键」的口径只能有一份，而它在存储层 / 后端：写路径是 `cosineOf()`（`dedupCandidates.ts`，**结尾也是 `clampCos`**）、读路径是 `clampCos(dot())` —— 两者的**分数空间是同一个 `[0, 1]`**。放进本模块就成了**第三套**口径（`fuseScore` 下游会看到不同的 `score` ⇒ A2 红） |
 * | ③ | 排序**复用** `compareHits`（`flat.ts`） | 自己写一个 `(a, b) => b.score - a.score` 就是漏掉「同分 id 升序」⇒ 同分跨越 K 边界时 A1/A2 会**偶发**红（最难查的一类） |
 * | ④ | **不 import `better-sqlite3`、不写 SQL** | 一旦它能读库，`scanned` / `bytesRead` 的口径就会被撕成两处，T06 的账没法归因 |
 *
 * ## 为什么「跳过」不丢召回（证明见 ADR §8.3 / 本档 §1）
 *
 * ```
 * cos_true = q·x = q·x̂ + q·(x − x̂) ≤ q·x̂ + ‖q‖·‖x − x̂‖ = q·x̂ + eps     （‖q‖ = 1）
 * ```
 * · **写路径**：只跳过 `upper < 阈值` 的行 ⇒ 每一行「真实分 ≥ 阈值」的行都还在池里
 *   ⇒ 池是 `{cos ≥ θ}` 的**超集** ⇒ 池里按精确分取 top-K 之后，`cos ≥ θ` 的行一个都不会被挤掉
 *   （「凑数行」的精确分 `< θ` ⇒ 只能填不满 K 的空位，见 §5.1.6 的推导）。
 * · **读路径**：早停判据是「剩余 `upper` 最大值 **<** 当前第 K 名」⇒ 被跳过的行**可证**不是前 K。
 * · **无码行**（`kind === 'uncoded'`）的 `upper = +∞` ⇒ 排最前 ⇒ 只要还有无码行没读，早停就不可能触发。
 *
 * ⚠️ **`threshold` 作用在 `upper` 上，不是作用在精确分上**（§5.1.6）：
 * 作用在精确分上就等于在本模块里**再实现一份结果门槛**，而结果门槛属于下游
 * （`dedupCandidates.ts` 的 `cos < DEDUP_COS_MIN`）；两份 θ 对边界的处理未必一致。
 *
 * ## 前提：码行必须按 `memories.embedding` 的**当前值**编
 *
 * 本模块的**全部正确性**都建立在一个前提上：
 * > **码行是按 `memories.embedding` 的当前值编的**（`eps` 是「这一条向量」的误差）。
 *
 * T05（码行维护）**尚未落地** ⇒ 这个前提靠「两条会改向量的路径都**让码失效**」维持：
 * · `src/store/merge.ts:253` 的 `UPDATE ... SET embedding = @embedding WHERE ... embedding IS NULL`
 *   —— 只在**补空值**时改（旧向量是 `NULL` ⇒ 本来就没有码 ⇒ **无害**）；
 * · ★ `src/store/updateContent.ts` 的 `UPDATE ... SET content = …, embedding = @embedding`
 *   —— **无条件**就地换向量（`旧值 → 另一个值`）⇒ 同一事务里调
 *     `clearCodeRow()`（`src/vector/bucketAssign.ts`，**码表的唯一写入点**；T04 收尾补的）
 *     把该行的码行删掉（fail-open 降级）。
 *     ⇒ 该行下一轮召回是「**无码**」⇒ 走精确兜底（多读 3KB，**不漏召回**）；
 *       `codesMissing` +1（可见）、A6 的 `codes − members = −1`（可观测，`pnpm codes:backfill` 修复）。
 *
 * ⚠️ **为什么是「删码」而不是「重编码」**：重编码要落在
 *   `assignBucket()` / `unassignBucket()`（桶归属的唯一写入点）里，那是 **T05 的交付**
 *   —— 在这里再写一份编码就是第二份码维护实现 ⇒ `EPS_SAFETY_MARGIN` 之类只在一处生效
 *   ⇒ 上界在其中一条路上不再是上界。
 *
 * 🚧 **TODO(T05)**：`assignBucket()` / `unassignBucket()` 是桶归属的唯一写入点（6 处生产调用点全走它，
 *   `updateContent()` 也在同一事务里调它）⇒ **码行的重编码必须收在那里**（先 DELETE 再 INSERT，
 *   与成员行同生同死），`fineId === null` 的早退分支**必须删码行**（fail-open，绝不「留旧码」）。
 *   T05 落地后，`updateContent()` 里那次 `clearCodeRow()` 调用应当**删掉**
 *   （改由 `assignBucket()` 统一维护）—— 否则「码失效」仍有两份实现。
 */

import { MemoryError } from '../core/errors.js';
import type { VectorHit } from './backend.js';
import { compareHits } from './flat.js';
import { approxDot } from './quantize.js';

/**
 * **写路径**的精确重排预算（`scanBucketCandidates()` 显式传这个值，§5.1.4）。
 *
 * 语义（见 `PruneOptions.exactRescoreBudget`）：`scoreOf` 被调用次数**达到**这个数之后
 * **撤回剪枝** —— 剩下的行**逐行精确**算完，不再早停。结果是**同一个结果集**
 * （多读不会改变前 K：比第 K 名差的行进不了堆，因为 `upper` 是**上界**
 * ⇒ `score ≤ upper < 第 K 名`），只是 IO 退化回「扫完整个桶」。
 *
 * ⚠️ **它不是正确性机制，是退化下限**：当码坏掉（`eps` 异常大）或大量行无码时，
 *   `exactReads` 会逼近 `candidates`；本保险丝让「剪枝失效」这件事**变成可观测的读数**
 *   （`exactReads / candidates` ⇒ 出关条件①的剪枝率），而不是一个无上限的循环。
 *
 * ⚠️ **只有写路径用它，读路径不传**（T04 收尾的裁决）：写路径 `k = VECTOR_TOPK`（20）
 *   ⇒ 正常早停只付 ~20 次 ⇒ 64 是它的 3 倍余量（远大于 `DEDUP_COS_MIN` 的通过数），
 *   **正常路径永远碰不到它**。而读路径 `k = VECTOR_TOPK × 3 = 60` ⇒ 同一个 64 只剩 4 次早停机会
 *   ⇒ 剪枝在读路径上**基本不存在**：本轮实测（300 行夹具 / 探针吃满 12 个细桶 / `k = 60`），
 *   读路径不带预算时 `exactReads = 67`（> 64，早停真的在 64 之后发生过一次）；
 *   把 64 硬塞回读路径 ⇒ `exactReads = 300 = scanned`（预算用尽 ⇒ 撤回剪枝 ⇒ **扫完整个桶**，剪枝归零）。
 *   ⇒ 读路径**不传** = 无预算（`undefined`），早停由「剩余上界 < 第 K 名」独家判定。
 *
 * ⚠️ **不要把它写成 `Infinity` 传进去**：「不传」与「传 `Infinity`」表达同一件事
 *   ⇒ 两种写法必然漂移（`=== undefined` 与 `=== Infinity` 会在某个分支里分叉）。
 */
export const WRITE_EXACT_RESCORE_BUDGET = 64;

/** 「有码」候选：上界可由码算出。 */
export interface CodedEntry {
  readonly kind: 'coded';
  /** 记忆 id。 */
  readonly id: string;
  /** 维度个 int8。**长度校验在调用方**（`ivf.ts` 的 `readCodes()` 已判），这里只做形状断言。 */
  readonly code: Int8Array;
  /** `x̂ = scale × code`；必须有限。 */
  readonly scale: number;
  /** 编码期实算的 `‖x − x̂‖₂`（已含 `EPS_SAFETY_MARGIN`）；必须非负有限。 */
  readonly eps: number;
}

/** 「无码」候选：上界按 `+∞` 处理 ⇒ 一律并入 survivors（§5.1.5 的 fail-open）。 */
export interface UncodedEntry {
  readonly kind: 'uncoded';
  /** 记忆 id。 */
  readonly id: string;
}

/** 剪枝池里的一条（有码 / 无码）。 */
export type PruneEntry = CodedEntry | UncodedEntry;

/** 一条入选行（形状与 `VectorHit` 逐字段相同 ⇒ 可直接交给 `compareHits`）。 */
export interface PruneHit {
  readonly id: string;
  readonly score: number;
}

/** `pruneTopK()` 的入参。 */
export interface PruneOptions {
  /** 查询向量（**已 L2 归一化**；长度必须 == 每个 `code.length`）。 */
  readonly query: Float32Array;
  /** 取前 `k` 条（非负整数；`0` ⇒ 返回空 survivors，但 `candidates` 仍如实计数）。 */
  readonly k: number;
  /**
   * **上界门槛**（写路径 = `params.DEDUP_COS_MIN`；读路径**不传**）。
   *
   * ⚠️ 它作用在 `upper = approxDot + eps` 上，**不是**作用在精确分上（见文件头）。
   */
  readonly threshold?: number;
  /**
   * **结果键的下界**（`clampCos` 的下界 = `0`；缺省 `-Infinity` = 无下界）。
   *
   * ★ **为什么必须有它**（这是一条会**静默丢行**的硬约束，不是优化项）：
   *   剪枝的证明依赖 `score ≤ upper`。而两条路的结果键都是**钳制后的**余弦
   *   （`clampCos(cos) = min(1, max(0, cos))`）⇒ `score = max(0, cos)` ≥ `cos`。
   *   于是当 `cos < 0` 时 `score (= 0) > upper (= cos + eps)` —— **上界对结果键不再成立**。
   *
   *   失效的确切形状（**弱查询上很常见**，`compareHits` 的注释原话：「被钳制到 0 的负余弦大量同分」）：
   *   第 K 名的分恰好是 `0`，而队列里剩下的行 `upper < 0` ⇒ 它们的精确分**也是 `0`**（被钳到 0）
   *   ⇒ 与第 K 名**同分** ⇒ 按 `compareHits` 的「同分 id 升序」，**id 更小的那些本该入选**
   *   ⇒ 用 `upper < 第 K 名` 判早停就会把它们**静默跳掉**（条数一样、分数一样，只有 id 不同）。
   *   ⇒ 取 `max(upper, scoreFloor)` 当判据：`0 < 0` 为假 ⇒ 不早停 ⇒ 行为正确。
   *   ⚠️ 代价（诚实记）：当第 K 名正是下界分时，早停**不会触发** ⇒ 读到队列尾。
   *     这是**正确性**的要求（同分只能靠 id 定序，而 `upper` 推不出 id 的大小）。
   */
  readonly scoreFloor?: number;
  /**
   * **精确重排的预算**（`scoreOf` 最多被调用几次；**缺省 `undefined` = 无预算**）。
   *
   * 语义：调用次数**达到**这个数之后**撤回剪枝** —— 剩下的行**逐行精确**算完，不再早停。
   * ⇒ 结果集**不变**（`upper` 是上界 ⇒ 比第 K 名差的行进不了堆），只是 IO 退化成「扫完整个桶」。
   *
   * ★ **两条路各自的值（这是 T04 收尾的裁决，不是可调参数）**：
   * · **写路径**（`scanBucketCandidates()`）显式传 `WRITE_EXACT_RESCORE_BUDGET`（= 64）；
   * · **读路径**（`search()`）**不传** ⇒ 无预算 ⇒ 早停只由「剩余上界 < 第 K 名」判定。
   *   理由：读路径 `k = 60`，若沿用 64 ⇒ 堆刚满就撞预算 ⇒ 剪枝名存实亡。
   *
   * ⚠️ **不要用 `Infinity` 表达「无预算」**：两种写法表达同一件事必然漂移
   *   （`=== undefined` 与 `=== Infinity` 会在某个分支里分叉）⇒ 校验只接受
   *   「**有限非负整数**」或 `undefined`，`Infinity` 会被**拒**（响亮失败）。
   */
  readonly exactRescoreBudget?: number;
  /**
   * **算一条的精确分**（读原向量 + 点积 + 结果键的变换，口径由调用方持有 ⇒ C36）。
   *
   * · 返回 `number` ⇒ 该行参与 K 竞争；
   * · 返回 `null` ⇒ **该行不在候选宇宙里**（软删 / 不过时间窗 / 无向量），
   *   **不入堆、不占 K 名额**（但仍计入 `exactReads`：那一次调用可能已经读了整行）；
   * · 抛错 ⇒ 原样透传（**不许吞**）。
   *
   * ⚠️ `null` **不表达**「分数不够」：分数门槛归调用方（见文件头）。
   */
  readonly scoreOf: (id: string) => number | null;
}

/** `pruneTopK()` 的产物。 */
export interface PruneOutcome {
  /** 入选行，**已按 `compareHits` 定序**（精确分降序、同分 id 升序）。 */
  readonly survivors: readonly PruneHit[];
  /** **候选宇宙条数 = entries.length**（★ 不是 survivors.length）。 */
  readonly candidates: number;
  /** 走精确兜底的条数（`entries` 里 `kind === 'uncoded'` 的个数）。 */
  readonly uncoded: number;
  /**
   * `scoreOf` 被调用的**次数**（返回 `null` 也算 —— 那一次同样可能已经读了整行）。
   * ⇒ 它是「为精确分付了代价的行数」的**上界**，不是 survivors 的条数。
   */
  readonly exactReads: number;
}

/** 队列里的一条（`upper` 算好的候选）。 */
interface Queued {
  /** 记忆 id。 */
  readonly id: string;
  /** 可证上界（无码 = `+∞`）。 */
  readonly upper: number;
}

/**
 * 按可证上界降序取 top-k，**精确重排 + 严格小于早停**。
 *
 * @param entries 剪枝池（有码 + 无码）。**调用方负责**把「不在候选宇宙里」的行先剔掉
 *                （`scoreOf` 返回 `null` 是**兜底**，不是主路径）
 * @param options 查询向量 / k / 门槛 / 精确分口径
 * @returns 入选行 + 三个计数
 * @throws {MemoryError} `INVALID_INPUT`：`k` 非非负整数 / `query` 为空 /
 *         `query.length` 与某条 `code.length` 不等 / `scale`·`eps` 非有限 / `eps < 0` /
 *         `threshold` 为 NaN / `exactRescoreBudget` 不是「有限非负整数」（含 `Infinity`）
 */
export function pruneTopK(entries: readonly PruneEntry[], options: PruneOptions): PruneOutcome {
  const { query, k, threshold, scoreOf } = options;
  // ⚠️ **结果键的下界**（见 `PruneOptions.scoreFloor`）：缺省「无下界」⇒ 判据退化成纯 `upper`。
  const scoreFloor = options.scoreFloor ?? Number.NEGATIVE_INFINITY;
  // ⚠️ **预算**：缺省 `undefined` = **无预算**（`nullish` 合并会把 `undefined` 变成具体数字 ⇒ 不用它）。
  const budget = options.exactRescoreBudget;
  assertNonNegativeInteger(k, 'k');
  if (query.length === 0) {
    throw MemoryError.invalidInput('剪枝需要非空查询向量', {
      reason: 'dim',
      expected: '>= 1',
      actual: '0',
    });
  }
  if (budget !== undefined) {
    // ⚠️ `assertNonNegativeInteger` 会把 `Infinity` 判死（`Number.isInteger(Infinity) === false`）
    //   —— 这正是要的：**「无预算」只有一个写法**（`undefined`），不许有第二种同义写法。
    assertNonNegativeInteger(budget, 'exactRescoreBudget');
  }
  if (threshold !== undefined && Number.isNaN(threshold)) {
    // ⚠️ NaN 门槛会让 `upper < NaN` **恒假** ⇒ 静默退化成「不剪」；
    //   「不剪」听起来无害，但它会**掩盖**调用方把 `undefined` 算成 NaN 的接线错误。
    throw MemoryError.invalidInput('剪枝门槛不能是 NaN', {
      reason: 'threshold',
      expected: '有限实数（或省略）',
      actual: 'NaN',
    });
  }

  // ── ① 逐条算上界（无码 ⇒ +∞；threshold 只剪上界）──
  let uncoded = 0;
  const queued: Queued[] = [];
  for (const entry of entries) {
    if (entry.kind === 'uncoded') {
      uncoded += 1;
      queued.push({ id: entry.id, upper: Number.POSITIVE_INFINITY });
      continue;
    }
    assertCodedEntry(entry, query.length);
    const upper = approxDot(query, entry.code, entry.scale) + entry.eps;
    if (threshold !== undefined && upper < threshold) {
      continue;
    }
    queued.push({ id: entry.id, upper });
  }

  if (k === 0) {
    // ⚠️ **`k = 0` ⇒ 一条都不读**（`scoreOf` 一次都不调）：没有 K 名额 ⇒ 无可比对象 ⇒ 读谁都是白读。
    return { survivors: [], candidates: entries.length, uncoded, exactReads: 0 };
  }

  // ── ② 队列排序：`upper` 降序；**同 `upper` 按 `id` 升序**（§5.1.7）──
  //   ⚠️ 同 upper 不定序 ⇒ 哪些行被读、被跳在两次运行间不同 ⇒ `exactReads` 抖、事故复盘对不上
  //     （结果集仍对，但**没法自证**）。
  queued.sort(compareByUpperDescThenIdAsc);

  // ── ③ 精确重排 + 早停（§5.1.7）──
  //   `heap` 是小顶堆、容量 `k`、**根 = 当前第 k 名（最差的那一个）**。
  const heap = new WorstHeap(k);
  let exactReads = 0;
  for (const item of queued) {
    if (heap.isFull()) {
      // 早停判据：剩余「**结果键可能达到的最大值**」**<** 第 k 名的精确分才停（**严格小于**）。
      //   ⚠️ 用 `≤`：上界恰好等于第 k 名时会把该行跳过，而它可能**真实分等于第 k 名
      //     且 id 更小** ⇒ 破坏 `compareHits` 的「同分 id 升序」定序 ⇒ A2 偶发红。
      //   ⚠️ 用 `max(upper, scoreFloor)` 而不是裸 `upper`：结果键被钳制过
      //     （`clampCos` ⇒ 负余弦一律变 `0`）⇒ 裸 `upper < 0` 的行**精确分也是 0**
      //     ⇒ 它们与「第 k 名 = 0」同分 ⇒ 会按 id 抢名额 ⇒ 跳掉就是丢行（见 `scoreFloor`）。
      //   ⚠️ 预算用尽（`exactRescoreBudget !== undefined && exactReads >= 预算`）
      //     ⇒ **撤回剪枝**：不再早停、逐行精确。⚠️ `undefined` = **无预算** ⇒ 永远不撤回。
      const budgetExhausted = budget !== undefined && exactReads >= budget;
      if (!budgetExhausted && Math.max(item.upper, scoreFloor) < heap.worst().score) {
        break;
      }
    }
    exactReads += 1;
    const score = scoreOf(item.id);
    if (score === null) {
      // 不在候选宇宙里 ⇒ 不入堆、不占 K 名额（但这次调用已经算过代价）。
      continue;
    }
    heap.offer({ id: item.id, score });
  }

  // ── ④ 返回前按 `compareHits` 排一次（堆是无序的）──
  const survivors = heap.drain().sort(compareHits);
  return { survivors, candidates: entries.length, uncoded, exactReads };
}

/** 队列的排序：上界降序、同上界 id 升序（纯函数，便于单测钉住）。 */
function compareByUpperDescThenIdAsc(left: Queued, right: Queued): number {
  if (left.upper !== right.upper) {
    // ⚠️ `b - a` 在 `+∞` 与有限值混排时得到 `-Infinity`（合法比较结果）；
    //   `+∞` 与 `+∞` 相减是 **NaN** ⇒ 所以必须先判相等再相减（与 `compareHits` 同一写法）。
    return right.upper - left.upper;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

/**
 * `a` 是否比 `b` **更差**（= 堆里更该被踢出去的那一个）。
 *
 * ⚠️ 与 `compareHits` **对偶**，不另立一套顺序：`compareHits(a, b) > 0` ⟺ `a` 更差。
 */
function isWorse(left: PruneHit, right: PruneHit): boolean {
  return compareHits(left, right) > 0;
}

/**
 * **最差在前**的小顶堆（容量固定）。
 *
 * ⚠️ 只在本模块内部使用、**不导出**（纪律 ①）：调用方只该拿到 `survivors`，
 *   否则「谁排第几名」会有第二份实现。
 */
class WorstHeap {
  /** 堆内元素（`items[0]` 恒为**最差**的那一个）。 */
  private readonly items: PruneHit[] = [];

  /** 容量（= k；`0` ⇒ 什么都不收）。 */
  private readonly capacity: number;

  /**
   * @param capacity 容量（非负整数）
   */
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** 当前元素个数。 */
  get size(): number {
    return this.items.length;
  }

  /** 堆是否已满（满了才允许早停）。 */
  isFull(): boolean {
    return this.items.length >= this.capacity;
  }

  /** 第 k 名（最差的那一个）；堆为空 ⇒ `INVALID_INPUT`（调用方保证不会这么调）。 */
  worst(): PruneHit {
    const root = this.items[0];
    if (root === undefined) {
      throw MemoryError.invalidInput('空堆没有第 k 名（调用方必须先判 isFull）', {
        reason: 'empty-heap',
      });
    }
    return root;
  }

  /**
   * 收一条（堆满时：比根**更差或相同** ⇒ 直接丢弃；比根更好 ⇒ 替换根）。
   *
   * ⚠️ **方向写反就是「保最差的 k 条」**（本类是「保最好的 k 条」的小顶堆：根 = 第 k 名）：
   *   判定式必须问「**根是否比新来的更差**」（是 ⇒ 新的更好 ⇒ 换掉根），
   *   而不是「新来的是否比根更差」（那是「把更差的收进来」⇒ 结果正好取反）。
   *
   * @param hit 一条精确结果
   */
  offer(hit: PruneHit): void {
    if (this.capacity === 0) {
      return;
    }
    if (this.items.length < this.capacity) {
      this.items.push(hit);
      this.siftUp(this.items.length - 1);
      return;
    }
    const root = this.items[0];
    if (root === undefined) {
      return;
    }
    if (!isWorse(root, hit)) {
      // 第 k 名不比新来的差 ⇒ 新来的进不了前 k
      return;
    }
    this.items[0] = hit;
    this.siftDown(0);
  }

  /** 取出全部元素（**顺序不保证**：调用方必须自己按 `compareHits` 排）。 */
  drain(): PruneHit[] {
    return [...this.items];
  }

  /** 向上调整（新元素可能比父更差 ⇒ 往根方向走）。 */
  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const current = this.items[index];
      const above = this.items[parent];
      if (current === undefined || above === undefined) {
        return;
      }
      if (!isWorse(current, above)) {
        return;
      }
      this.items[index] = above;
      this.items[parent] = current;
      index = parent;
    }
  }

  /** 向下调整（根被替换成更好的元素之后，可能不再是最差 ⇒ 往叶子方向走）。 */
  private siftDown(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let target = index;
      const currentTarget = this.items[target];
      const leftItem = this.items[left];
      if (
        leftItem !== undefined &&
        currentTarget !== undefined &&
        isWorse(leftItem, currentTarget)
      ) {
        target = left;
      }
      const targetItem = this.items[target];
      const rightItem = this.items[right];
      if (rightItem !== undefined && targetItem !== undefined && isWorse(rightItem, targetItem)) {
        target = right;
      }
      if (target === index) {
        return;
      }
      const moved = this.items[index];
      const other = this.items[target];
      if (moved === undefined || other === undefined) {
        return;
      }
      this.items[index] = other;
      this.items[target] = moved;
      index = target;
    }
  }
}

/**
 * 校验「有码」条目（形状 / 有限性）。
 *
 * @param entry 有码条目
 * @param queryLength 查询向量长度（码必须等长）
 * @throws {MemoryError} `INVALID_INPUT`
 */
function assertCodedEntry(entry: CodedEntry, queryLength: number): void {
  if (entry.code.length !== queryLength) {
    // ⚠️ **响亮失败，不钳制、不补零**：维度对不上算出来的「上界」不是上界
    //   ⇒ 继续跑就是**静默漏检**（本档唯一不可接受的失效形状）。
    //   ⚠️ 生产路径上这种行**进不到这里**：`readCodes()` 已把它们归入「无码」⇒ 精确兜底。
    throw MemoryError.invalidInput('码的长度必须与查询向量一致', {
      reason: 'dim',
      expected: String(queryLength),
      actual: `${String(entry.code.length)}（id = ${entry.id}）`,
    });
  }
  if (!Number.isFinite(entry.scale)) {
    throw MemoryError.invalidInput('码的还原标量必须有限', {
      reason: 'scale',
      expected: '有限实数',
      actual: `${String(entry.scale)}（id = ${entry.id}）`,
    });
  }
  if (!Number.isFinite(entry.eps) || entry.eps < 0) {
    // ⚠️ `eps < 0` 是**不可能的输入**（编码器永远给非负）⇒ 抛错，而不是钳到 0：
    //   钳掉就等于「悄悄把上界变紧」⇒ 直接破坏 §8.3 的证明。
    throw MemoryError.invalidInput('码的误差项必须是有限非负实数', {
      reason: 'eps',
      expected: '>= 0 的有限实数',
      actual: `${String(entry.eps)}（id = ${entry.id}）`,
    });
  }
}

/**
 * 校验非负整数。
 *
 * @param value 待校验值
 * @param field 字段名（错误信息里用）
 * @throws {MemoryError} `INVALID_INPUT`
 */
function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw MemoryError.invalidInput(`${field} 必须是非负整数`, {
      reason: field,
      expected: '>= 0 的整数',
      actual: String(value),
    });
  }
}

/**
 * 形状断言（**编译期**）：`PruneHit` 必须与契约里的 `VectorHit` 逐字段兼容
 * ⇒ 调用方可以把 `survivors` 直接当成 `VectorHit[]` 用（结构类型），
 * 而不必在向量层与召回层之间再写一遍映射（那是「同一个形状两份定义」的起点）。
 */
export type PruneHitAssignableToVectorHit = PruneHit extends VectorHit ? true : never;
