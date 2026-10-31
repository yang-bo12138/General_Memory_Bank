/**
 * 融合打分 —— DESIGN-v2.md §4.6 步骤 3（DEVELOPMENT-PLAN.md **P1-T08**）。
 *
 * ★ **本文件是「分数」的唯一权威**：五因子加权和、`normBm25` 三分支、`graphProximity`、
 *   `recency` 四件事全部在这里；`src/store/recall.ts` 只负责**取候选**与**排序截断**。
 *   ⇒ 与 §4.2 把 `growStability` 收成「唯一写入点」是同一条纪律：
 *     「五条路各写各的公式」必然漂移，而漂移**极难在实现期被发现**
 *     （两边的数都像正常值，测试也照样绿）。
 *
 * ⚠️ **纯逻辑 + 一处批量查询**：除 `graphProximity` 的那一次 `SELECT` 外，本文件**不碰数据库**，
 *   其余全是纯函数 ⇒ 可单测、无副作用、**不写库**。
 *
 * ★ **本文件也是「准入闸门的数值」的唯一权威**（§4.6 步骤 2 / §4.15.2）：
 *   精筛阈值（`ARCHIVE_LINE`）、精筛判定（严格大于）、**粗筛两档窗口**都在这里。
 *   ⚠️ **闸门与打分必须同源**：铁律①要求「准入闸门对三路**一视同仁**」，
 *     而阶段 2 的向量路（`VectorBackend.search` 的 `filter`）要的**就是同一对下界**
 *     （`VectorFilter.timeFloor` / `pinnedTimeFloor` ≡ SQL 的 `@coarseCutoff` /
 *     `@coarseCutoffPinned`）。
 *   ⇒ SQL 的**文本形状**留在 SQL 层（每条路的 SQL 形状不同），
 *     但**闸门的数字**只有这一处 —— 两份数字必然漂移，而漂移**不报错**。
 *
 * ⚠️ **C37 时钟注入**：本文件唯一读时间的地方是 `recency()`，它的签名含 `now?`，
 *   真实时钟只经 `resolveNow()`（唯一入口 `src/core/clock.ts`）。
 *   ⇒ 本文件**不得**出现 `Date.now()` / `new Date()`，
 *     否则 `scripts/check-clock.ts` 会判为「未获准的时钟读取」而使 CI 变红。
 *
 * ⚠️ **参数纪律**：除下面两处**刻意硬编码**的常量（五项权重、`normBm25` 的 sigmoid 斜率 0.2）
 *   外，本文件的每一个数字都来自 `DEFAULT_PARAMS`（`RECENCY_DECAY_DAYS` / `ARCHIVE_LINE`）
 *   或 `src/core/decay.ts` 的 `MS_PER_DAY`。
 *   ⇒ 「本地写死一个 14 天」这类做法会让参数表与实现分叉，
 *     而分叉的表现是「改了参数没反应」——**不报错、只是行为不变**。
 */

import { resolveNow } from './clock.js';
import { MS_PER_DAY, archiveSpanFactor, effectiveStability } from './decay.js';
import { MemoryError } from './errors.js';
import type { Params } from './params.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、五因子加权和
// ═══════════════════════════════════════════════════════════════════════════

/** 五个因子的名字（顺序 = §4.6 步骤 3 公式里的书写顺序）。 */
export type ScoreFactorName = 'intensity' | 'vectorSim' | 'normBm25' | 'graphProximity' | 'recency';

/** 五个因子的名字清单（遍历用；加一个用例不会让断言失效）。 */
export const SCORE_FACTOR_NAMES: readonly ScoreFactorName[] = [
  'intensity',
  'vectorSim',
  'normBm25',
  'graphProximity',
  'recency',
];

/** 五项权重的形状。 */
export interface ScoreWeights {
  /** §4.6：`0.30 × intensity`。 */
  readonly intensity: number;
  /** §4.6：`0.25 × vectorSim`。 */
  readonly vectorSim: number;
  /** §4.6：`0.20 × normBm25`。 */
  readonly normBm25: number;
  /** §4.6：`0.15 × graphProximity`。 */
  readonly graphProximity: number;
  /** §4.6：`0.10 × recency`。 */
  readonly recency: number;
}

/**
 * ★ **五个权重刻意硬编码，不进 `DEFAULT_PARAMS`**（§4.6 步骤 3 / §5）：
 *
 * · **它们必须恒和为 1.0** —— 单独调一个会让其余四项的相对比例失真，
 *   而「五项加权和 == `Hit.score`」这条可测恒等式（§4.13.1 硬约束①）就失去了参照系。
 * · **调它们没有任何指标能验证好坏** —— 与 `normBm25` 斜率 0.2 不开放的理由**完全同构**：
 *   开放它等于把「排序的形状」变成运行时可调项，而不同实例的分数从此不可比。
 * · **改权重是一次设计变更**，应走 §13 的 ADR，**不是**运行时配置。
 *
 * ⚠️ **权重的相对顺序有论证，具体数值没有基准数据支撑**：
 *   0.30 / 0.25 / 0.20 / 0.15 / 0.10 是按 §4.6 的四条理由先验排定的，
 *   **从未用真实查询回归过** ⇒ 纠正方式是 **§12 阶段 3/4 的回归**，而不是在这里反复改数。
 *   （顺序的理由：intensity 最大——「活着」是记忆库与普通 RAG 的分界；
 *     vectorSim 刻意低于 intensity——旧事实与新事实语义高度相似（「已升级到 PG15」vs「PG17」）
 *     让向量压过活跃度会稳定地盖住当前信息；
 *     normBm25 不删——错误码 / 文件路径 / 人名上字面匹配远胜语义匹配；
 *     recency 压得低——它与 intensity 高度相关，两者合计 0.40 已足够，
 *     再多就是同一个信号投两次票。）
 */
export const SCORE_WEIGHTS: ScoreWeights = {
  intensity: 0.3,
  vectorSim: 0.25,
  normBm25: 0.2,
  graphProximity: 0.15,
  recency: 0.1,
};

/**
 * 五项权重之和（**由权重算出**，不是手写的字面量）。
 *
 * ⚠️ 它必须由 `SCORE_WEIGHTS` 派生而不是写死成 `1`：
 *   写死的话「有人把某个权重改了」这条漂移**永远不会被发现**（假绿）。
 *   ⇒ 单测断言「它 == 1.0」，改动权重 ⇒ 这条断言立刻变红。
 */
export const SCORE_WEIGHT_SUM: number = Object.values(SCORE_WEIGHTS).reduce(
  (sum, weight) => sum + weight,
  0,
);

/** 打分需要的五个因子取值（每一项 ∈ `[0, 1]`）。 */
export interface ScoreFactors {
  /** §4.1 的强度。 */
  readonly intensity: number;
  /** 语义余弦（已钳制到 `[0, 1]`）。 */
  readonly vectorSim: number;
  /** 归一化后的 BM25（§4.6 步骤 3 的三条规则）。 */
  readonly normBm25: number;
  /** 实体交集判定（`1.0` / `0.0`）。 */
  readonly graphProximity: number;
  /** 创建时间的新近度。 */
  readonly recency: number;
}

/**
 * 五个加权后的分项（**字段名与 §6 的 `Hit.breakdown` 一一对应**）。
 *
 * ⚠️ 字段名**刻意**用 `vectorPart` / `textPart` / `graphPart`（而不是 `normBm25Part`）：
 *   §6 的 `Hit.breakdown` 是对外契约，改名会破坏调用方与既有断言。
 */
export interface ScoreParts {
  /** `0.30 × intensity`。 */
  readonly intensityPart: number;
  /** `0.25 × vectorSim`。 */
  readonly vectorPart: number;
  /** `0.20 × normBm25`。 */
  readonly textPart: number;
  /** `0.15 × graphProximity`。 */
  readonly graphPart: number;
  /** `0.10 × recency`。 */
  readonly recencyPart: number;
}

/** 融合打分的完整结果。 */
export interface FusionResult {
  /** 总分（五项加权和，**恒等于**五个分项之和，误差 ≤ 1e-9）。 */
  readonly score: number;
  /** 五个分项（供 `Hit.breakdown` 与 `explain` 使用）。 */
  readonly breakdown: ScoreParts;
}

/**
 * 校验一个因子取值合法（有限数且 ∈ `[0, 1]`）。
 *
 * ⚠️ **为什么要校验**：五项权重恒和为 1 ⇒ 只要有一项越界，`score` 就会越界，
 *   而 `score` 后面要跟 `ARCHIVE_LINE` 这类阈值比较（§4.4 的层级判定）。
 *   ⇒ **越界必须当场炸掉**，不能悄悄流到排序里 —— 那会表现为「topN 里的顺序不对」，极难定位。
 *
 * @param name 因子名（用于错误详情）
 * @param value 取值
 * @throws {MemoryError} code = `INVALID_INPUT`
 */
function assertFactorInRange(name: ScoreFactorName, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw MemoryError.invalidInput(`打分因子 ${name} 必须是 [0, 1] 内的有限数`, {
      factor: {
        current: String(value),
        reason: '五项权重恒和为 1：任一因子越界都会让 score 越界，进而污染层级判定与排序',
      },
    });
  }
}

/**
 * 五因子融合打分（§4.6 步骤 3）。
 *
 * ```
 * score = 0.30 × intensity
 *       + 0.25 × vectorSim
 *       + 0.20 × normBm25
 *       + 0.15 × graphProximity
 *       + 0.10 × recency
 * ```
 *
 * ★ **五项权重恒和为 1.0；缺项一律记 0，不重算分母。**
 *
 * ⚠️ **为什么不按缺项重算分母**（§4.6 原话，违反它 ⇒ 分数失去可比性）：
 *   分母一旦随候选而变，**同一条候选在不同批次里得到的分就不是同一个尺子量出来的**。
 *   于是「只有三路命中、且三路都满分」的候选会被折算成 `1.0`，
 *   **压过**「五路命中、每路 0.8」的候选（`0.8`）。
 *   ⇒ 这正是「补偿稀疏候选」的**经典翻车现场**，而且它在测试里极难被抓到
 *     （两条记忆各自看都很合理）。
 *   ⇒ 本实现里 `Partial<ScoreFactors>` 的**缺项直接当 0**，
 *     结构上**不存在**可以「重算分母」的地方（没有分母这个概念）。
 *
 * ⚠️ **代价明写**：**无 embedding 的记忆理论最高分 0.75**
 *   （0.30 + 0.20 + 0.15 + 0.10，缺的是 `vectorSim` 那 0.25）。
 *   ⇒ 它不会被永久埋没（0.75 仍高于一条各方面平庸、只是满配向量的候选），
 *     但**回填越晚越吃亏**。
 *   ⇒ 这是刻意的：让「没向量」成为一个**能被观测到的劣势**（`stats().embeddedRatio`），
 *     而不是悄悄让所有人的分数都虚高。
 *
 * @param factors 五个因子取值；**缺项（键不存在）= 0**
 * @returns 总分 + 五个分项
 * @throws {MemoryError} code = `INVALID_INPUT`（某项因子越界）
 */
export function fuseScore(factors: Partial<ScoreFactors>): FusionResult {
  // ⚠️ 缺项先落成 0，**不分母、不归一**（理由见上）。
  const values: Record<ScoreFactorName, number> = {
    intensity: 0,
    vectorSim: 0,
    normBm25: 0,
    graphProximity: 0,
    recency: 0,
  };

  for (const name of SCORE_FACTOR_NAMES) {
    const value = factors[name];
    if (value === undefined) {
      continue; // 缺项 = 0（不是「此项为零分」，但计算上等同）
    }
    assertFactorInRange(name, value);
    values[name] = value;
  }

  const breakdown: ScoreParts = {
    intensityPart: values.intensity * SCORE_WEIGHTS.intensity,
    vectorPart: values.vectorSim * SCORE_WEIGHTS.vectorSim,
    textPart: values.normBm25 * SCORE_WEIGHTS.normBm25,
    graphPart: values.graphProximity * SCORE_WEIGHTS.graphProximity,
    recencyPart: values.recency * SCORE_WEIGHTS.recency,
  };

  // ⚠️ 总分由**五个分项相加**得到（而不是另写一遍加权式）：
  //   这样「五项加权和 == score」这条恒等式**在结构上不可能被破坏**——
  //   两份公式各自演化正是「公式漂移」的温床（§4.6 步骤 2.5 的同一条纪律）。
  const score =
    breakdown.intensityPart +
    breakdown.vectorPart +
    breakdown.textPart +
    breakdown.graphPart +
    breakdown.recencyPart;

  return { score, breakdown };
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、`normBm25` 的三条规则
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **`normBm25` 的 sigmoid 斜率刻意硬编码，不进 `DEFAULT_PARAMS`**（§4.6 步骤 3）：
 *   它只决定候选**内部**的相对排序陡缓，不改变任何绝对阈值；
 *   开放为参数等于把「归一化曲线的形状」变成可调项，
 *   而**调它没法用指标验证好坏**，只会让不同实例的分数不可比
 *   （与五项权重不开放的理由完全同构）。
 */
export const NORM_BM25_SLOPE = 0.2;

/**
 * 本次文本路走的哪条分支（§4.6 步骤 2a）。
 *
 * ⚠️ **这个判据是 `normBm25` 三分支的入口条件**：
 *   ① `'like'` ⇒ LIKE 单字兜底 ⇒ 全部 `normBm25 = 1.0`；
 *   ② `'fts'` ⇒ 走了 FTS ⇒ 按中位数归一；
 *   ③ `'none'` ⇒ 文本路整体没执行 ⇒ 全部 `0.0`。
 *
 * ⚠️ **判据不该是「`bm25List` 是否为空」，而是「本次文本路到底走没走 FTS」**：
 *   兜底路的 0.2 分**要给**——它确实命中了文本，只是没有相关度可言。
 *   若用「`bm25List` 是否为空」当判据，兜底路（`raw_bm25` 全是 null）会落进 ③，
 *   于是同一批 LIKE 命中同时有 1.0 与 0.0 两种说得通的结果 —— 而 0.2 分的归属
 *   要靠一个括号救场，顺序读反就得到完全不同的分数。
 */
export type TextRouteMode = 'fts' | 'like' | 'none';

/** `normBm25` 的输入：一条候选的**原始** BM25 证据。 */
export interface Bm25Candidate {
  /** 记忆 id（仅用于调试与调用方索引，**不参与计算**）。 */
  readonly memoryId: string;
  /**
   * FTS5 的 `bm25()` 原始值（**负值，越负越相关**）。
   *
   * ⚠️ **未走文本路时恒为 `null`**（纯图谱命中 / 纯向量命中 / LIKE 兜底路）。
   *   ⚠️ **不使用 `-1.0` 哨兵值**（§4.6 步骤 2a）：哨兵值与真实 bm25 负值混在一起，
   *     谁也分不清「命中得弱」与「压根没走文本路」——而这两者的归一化规则完全不同。
   */
  readonly rawBm25: number | null;
}

/** `normBm25` 的输出。 */
export interface Bm25Normalization {
  /** 与输入**等长**的 `normBm25` 数组（未走文本路的条目严格为 `0.0`）。 */
  readonly normBm25: readonly number[];
  /** 中位数（仅 FTS 分支有值；其余分支为 `null`）。 */
  readonly medianBm25: number | null;
}

/**
 * 中位数（升序后取中间；偶数个取中间两个的平均）。
 *
 * ⚠️ **空样本抛错，不返回 0**：空样本意味着调用方把「没有文本路命中」当成了「有文本路命中」，
 *   返回 0 会让中位数基准悄悄变成 0 ⇒ 所有 `normBm25` 变成同一个数 ⇒ 排序信号消失，
 *   而**不报错**。
 *
 * @param values 样本（调用方保证非空）
 * @returns 中位数
 * @throws {MemoryError} code = `INVALID_INPUT`（空样本）
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw MemoryError.invalidInput('中位数不接受空样本', {
      median: {
        current: '0',
        reason: '空样本会让归一化基准静默塌成常数，排序信号消失且不报错',
      },
    });
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    const only = sorted[middle];
    if (only === undefined) {
      throw MemoryError.invalidInput('中位数样本不足', {
        median: { current: String(sorted.length), reason: '奇数长度样本的中间元素缺失' },
      });
    }
    return only;
  }

  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) {
    throw MemoryError.invalidInput('中位数样本不足', {
      median: { current: String(sorted.length), reason: '偶数长度样本的中间两个元素缺失' },
    });
  }
  return (lower + upper) / 2;
}

/**
 * `normBm25` 的 sigmoid 形状：`1 / (1 + exp(0.2 × (raw - median)))`。
 *
 * ⚠️ **方向校验**（这是最容易写反的一处）：
 *   FTS5 的 `bm25()` 返回**负值**，**越负越相关**。
 *   ⇒ `raw` 越负 ⇒ `raw - median` 越负 ⇒ `exp` 越小 ⇒ `normBm25` **越接近 1**。✔
 *   ⇒ 写反（`exp(0.2 × (median - raw))`）会让**越相关的条目分数越低**，
 *     而它仍然是「一个 0~1 的数」、排序也不报错 ⇒ 静默地反向排序。
 *
 * @param rawBm25 原始 BM25（负值，越负越相关）
 * @param medianBm25 中位数基准
 * @returns `normBm25 ∈ (0, 1)`
 */
export function normBm25Sigmoid(rawBm25: number, medianBm25: number): number {
  return 1 / (1 + Math.exp(NORM_BM25_SLOPE * (rawBm25 - medianBm25)));
}

/**
 * `normBm25` 归一化（§4.6 步骤 3 的**三条规则**，顺序不可换、先命中先返回）。
 *
 * ① **LIKE 兜底路** ⇒ 全部 `normBm25 = 1.0`（不参与中位数归一）。
 * ② **否则若去重后的候选集里存在文本路命中**（`raw_bm25` 非空）⇒
 *    `bm25List` = 所有 `raw_bm25` 非空的候选值；`medianBm25` = 中位数；
 *    `normBm25 = 1 / (1 + exp(0.2 × (raw_bm25 - medianBm25)))`；
 *    **未走文本路的条目严格置 `0.0`**。
 * ③ **否则（整批都没走文本路）** ⇒ 全部置 `0.0`。
 *
 * ⚠️ **未走文本路的条目不得以 0 或 -1 参与中位数计算**
 *   （纯图谱命中、纯向量命中的 `raw_bm25` 是 `null`）：
 *   若把它们当成 0 塞进中位数，基准会被拉向 0 ⇒ 文本路命中的条目
 *   全部算出接近 1 的 `normBm25` ⇒ **相对排序被抹平**（全体都"很相关"）。
 *   ⇒ 这也是「文本路全命中时 median 逐位不变」这条断言的根据。
 *
 * @param candidates 去重后的候选集（各路的 `raw_bm25` 各自独立保留，**不合并、不取平均**）
 * @param route 本次文本路走的分支
 * @returns 归一化结果（与输入等长）
 * @throws {MemoryError} code = `INVALID_INPUT`（`raw_bm25` 不是有限数）
 */
export function normalizeBm25(
  candidates: readonly Bm25Candidate[],
  route: TextRouteMode,
): Bm25Normalization {
  // ── ① LIKE 兜底路：全部同等相关，统一 1.0 ──
  // ⚠️ 排序交由 intensity / recency / graphProximity 决定（§4.6 步骤 3）。
  if (route === 'like') {
    return { normBm25: candidates.map(() => 1), medianBm25: null };
  }

  // ── ③ 文本路整体没执行 ⇒ 全部 0.0 ──
  // ⚠️ 「整条向量路缺席」与「向量分全 0」不是一回事（§4.6 铁律 2）；
  //   这里是**文本路**的同类情形：没跑就是没跑，不是「跑了但没命中」。
  if (route === 'none') {
    return { normBm25: candidates.map(() => 0), medianBm25: null };
  }

  // ── ② 走了 FTS：只取 `raw_bm25` 非空的候选算中位数 ──
  const bm25List: number[] = [];
  for (const candidate of candidates) {
    if (candidate.rawBm25 === null) {
      continue;
    }
    if (!Number.isFinite(candidate.rawBm25)) {
      throw MemoryError.invalidInput('raw_bm25 必须是有限数或 null', {
        rawBm25: {
          current: String(candidate.rawBm25),
          reason: '非有限数会让中位数变成 NaN，进而让整批 normBm25 静默失效',
        },
      });
    }
    bm25List.push(candidate.rawBm25);
  }

  // ⚠️ ② 内部「`bm25List` 为空」这一句在②里不可达（能进②就说明走过 FTS），
  //   但 **FTS 查了却一条没命中**是可能的（此时候选集里全是图谱/向量命中）
  //   ⇒ 落到 ③（全部 0.0）。
  if (bm25List.length === 0) {
    return { normBm25: candidates.map(() => 0), medianBm25: null };
  }

  const medianBm25 = median(bm25List);
  const normBm25 = candidates.map((candidate) =>
    candidate.rawBm25 === null ? 0 : normBm25Sigmoid(candidate.rawBm25, medianBm25),
  );

  return { normBm25, medianBm25 };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、`graphProximity`（全库唯一判定处）
// ═══════════════════════════════════════════════════════════════════════════

/** 批量查询用到的预编译语句的最小结构（与 better-sqlite3 的 `Statement` 兼容）。 */
export interface ScoringStatement {
  all(...params: unknown[]): unknown[];
}

/**
 * 批量查询用到的数据库的最小结构（与 better-sqlite3 的 `Database` 兼容）。
 *
 * ⚠️ **刻意声明成最小结构**而不是直接依赖 `better-sqlite3` 的 `Database` 类型：
 *   `src/core/` 是**纯逻辑层**，不应因一个 `SELECT` 就把原生模块的类型绑进核心
 *   （与 `src/core/entities.ts` 的 `EntityDatabase` 同一口径）。
 */
export interface ScoringDatabase {
  prepare(sql: string): ScoringStatement;
}

/**
 * `graphProximity` 的批量查询 SQL（§4.6 步骤 3）：
 * `SELECT memory_id FROM memory_entities WHERE memory_id IN (...) AND entity_id IN (...)`。
 *
 * ⚠️ **两个列表各压成一个 JSON 参数**（`json_each`）而不是展开成一串 `?`：
 *   `IN (?, ?, …, ?)` 要把候选数 + 实体数个绑定变量一次性塞进去，
 *   而 SQLite 的绑定变量上限**历史上是 999**（老版本 `SQLITE_MAX_VARIABLE_NUMBER`）
 *   ⇒ 候选一多就是「too many SQL variables」的**运行时炸裂**，而且**炸的时刻取决于库的大小**。
 *   `json_each` 把两个列表各变成**一个**参数 ⇒ 上限问题从根上消失。
 *   ⚠️ JSON 函数自 SQLite 3.38 起是**核心功能**（不再需要单独编译选项），
 *     better-sqlite3 捆绑的版本远高于此 ⇒ 一定可用。
 *   ⚠️ 索引仍然用得上：实测查询计划是 `SEARCH memory_entities USING INDEX idx_me_memory`。
 */
export const GRAPH_PROXIMITY_SQL =
  'SELECT memory_id FROM memory_entities WHERE memory_id IN (SELECT value FROM json_each(?)) ' +
  'AND entity_id IN (SELECT value FROM json_each(?))';

/**
 * 找出与上下文实体**有交集**的记忆 id 集合（`graphProximity = 1.0` 的那批）。
 *
 * ⚠️ **不能用「是否由图路召回」代替**（§4.6 步骤 3 原话）：
 *   图路候选有 `LIMIT 100`，一条记忆完全可能与上下文实体**有交集**、
 *   却因为最近使用时间排在第 100 名之外而**没进图路候选**。
 *   它同时是文本路的高相关命中 ⇒ 若按「来自哪条路」判，
 *   它的 `intensity` 与 `graph` 两项会被判 0 ⇒ **直接被挤出 topN**——
 *   而它恰恰是最该被召回的那一类（内容相关 + 实体相关）。
 *   ⇒ 所以判定必须落在**数据**（实体交集）上，而不是落在**来源**上。
 *
 * ⚠️ **一次批量查询，不是逐条查询**：`O(候选数)` 的打标成本，不是 `O(候选数)` 次 IO。
 *
 * ⚠️ **实体 id 为空 ⇒ 直接返回空集**（不发查询）：
 *   `IN ()` 是 SQL 语法错误；而「没有上下文实体」在语义上就是「没有任何记忆与上下文有交集」。
 *
 * @param db 数据库句柄
 * @param memoryIds **去重后**的候选记忆 id 列表
 * @param entityIds 上下文的 entity_id 列表（可为空）
 * @returns 与上下文实体有交集的记忆 id 集合
 */
export function findMemoriesWithEntityIntersection(
  db: ScoringDatabase,
  memoryIds: readonly string[],
  entityIds: readonly string[],
): Set<string> {
  const memories = [...new Set(memoryIds)].filter((id) => id !== '');
  const entities = [...new Set(entityIds)].filter((id) => id !== '');
  const intersecting = new Set<string>();

  if (memories.length === 0 || entities.length === 0) {
    return intersecting;
  }

  const rows = db
    .prepare(GRAPH_PROXIMITY_SQL)
    .all(JSON.stringify(memories), JSON.stringify(entities));

  for (const row of rows) {
    const memoryId = (row as { memory_id?: unknown } | null | undefined)?.memory_id;
    if (typeof memoryId === 'string') {
      intersecting.add(memoryId);
    }
  }

  return intersecting;
}

/**
 * 单条候选的 `graphProximity`（`1.0` / `0.0`）。
 *
 * ⚠️ 判定依据**只有**「实体是否相交」——**不看这条候选是从哪条路来的**（理由见上）。
 *
 * @param memoryId 候选记忆 id
 * @param intersecting 有实体交集的记忆 id 集合
 * @returns `1.0` 或 `0.0`
 */
export function graphProximityOf(memoryId: string, intersecting: ReadonlySet<string>): number {
  return intersecting.has(memoryId) ? 1 : 0;
}

/**
 * 给一批候选打上 `graphProximity` 标记（一次批量查询 + 逐条查表）。
 *
 * @param db 数据库句柄
 * @param memoryIds 去重后的候选记忆 id 列表
 * @param entityIds 上下文的 entity_id 列表
 * @returns `memoryId → 1.0 / 0.0`（**每个传入的 id 都有条目**）
 */
export function assignGraphProximity(
  db: ScoringDatabase,
  memoryIds: readonly string[],
  entityIds: readonly string[],
): Map<string, number> {
  const intersecting = findMemoriesWithEntityIntersection(db, memoryIds, entityIds);
  const assigned = new Map<string, number>();
  for (const memoryId of new Set(memoryIds)) {
    assigned.set(memoryId, graphProximityOf(memoryId, intersecting));
  }
  return assigned;
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、`recency` 与 `cos` 的钳制
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 新近度（§4.6 步骤 3）：`min(1, exp(-Δt / (RECENCY_DECAY_DAYS × 86400000)))`，
 * `Δt = max(0, now - created_at)`。
 *
 * ⚠️ **基于创建时间**（`created_at`），不是 `last_access`：
 *   它反映「客观新近度」，而 `intensity` 已经覆盖了「最近被用过多久」。
 *   两项都用 `last_access` 就是**同一个信号投两次票**。
 *
 * ⚠️ **`RECENCY_DECAY_DAYS`（默认 14 天）是时间常数 τ，不是半衰期**：
 *   实际半衰期 = `14 × ln2 ≈ 9.7` 天（与 §4.1 的量纲口径同一条纪律）。
 *
 * ⚠️ **公式里没有 `confidence`**（§4.6 步骤 3，与 §3 的 schema 注释一致，避免两处口径冲突）：
 *   · 五项权重之和恰为 1.0，再插一项会破坏这一整洁性；
 *   · `confidence` 与 `intensity` 高度相关（置信度低的记忆通常也难被反复强化），
 *     再计分等于重复加权。
 *   ⇒ `confidence` 通过**写入侧**的 `initialDifficulty` 生效
 *     （§4.3：`initialDifficulty = min(0.95, baseDifficulty + 0.2 × (1 - confidence))`），
 *     让低置信记忆一开始就「更难记牢」，从而在后续所有强度计算中自然体现。
 *
 * @param createdAt 记忆的创建时刻（epoch 毫秒）
 * @param params 生效参数（**必传**：`RECENCY_DECAY_DAYS` 是可调项）
 * @param now 注入时钟（C37）；缺省取真实时钟
 * @returns `recency ∈ (0, 1]`
 */
export function recency(createdAt: number, params: Params, now?: number): number {
  const at = resolveNow(now);
  const elapsedMs = Math.max(0, at - createdAt);
  const tauMs = params.RECENCY_DECAY_DAYS * MS_PER_DAY;
  return Math.min(1, Math.exp(-elapsedMs / tauMs));
}

/**
 * 余弦钳制（§4.6 步骤 2c）：`cos = min(1, max(0, dot))`。
 *
 * ⚠️ **为什么必须钳制**：向量已 L2 归一化 ⇒ 点积的理论范围是 `[-1, 1]`，
 *   但**浮点误差可能给出 `1.0000001`**；不钳制会让 `cos ≥ VECTOR_MIN_COS`
 *   在边界上不稳定（同一个向量，两次算出的 `cos` 一个过线一个不过线）。
 *
 * ⚠️ **负余弦被钳到 0 而不是保留负值**：`cos` 在这里是「相似度」，
 *   负相似度对召回**没有意义**（一条语义相反的记忆不是「稍微负相关的记忆」，
 *   它是**不该被召回**的那一类）。⇒ 留在 0，与「没进向量路」之外的「进了但不相关」一致。
 *
 * @param dot 点积
 * @returns `cos ∈ [0, 1]`
 * @throws {MemoryError} code = `INVALID_INPUT`（非有限数）
 */
export function clampCos(dot: number): number {
  if (typeof dot !== 'number' || !Number.isFinite(dot)) {
    throw MemoryError.invalidInput('余弦必须是有限数', {
      cos: {
        current: String(dot),
        reason: 'NaN / Infinity 会让 score 变成 NaN，而 NaN 的比较恒为 false ⇒ 排序静默失效',
      },
    });
  }
  return Math.min(1, Math.max(0, dot));
}

/**
 * 两向量点积并钳制（§4.6 步骤 2c）。
 *
 * ⚠️ **前提：两个向量都已 L2 归一化**（本库不存未归一化的向量）⇒ 点积就是余弦。
 *
 * @param left 左向量
 * @param right 右向量
 * @returns `cos ∈ [0, 1]`
 * @throws {MemoryError} code = `INVALID_INPUT`（维度不一致 / 非有限数）
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw MemoryError.invalidInput('向量维度不一致', {
      dimensions: {
        current: `${left.length} vs ${right.length}`,
        reason: '维度不一致说明两侧不是同一个 embedding 空间，点积没有意义',
      },
    });
  }

  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return clampCos(dot);
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、准入闸门里的「强度精筛」（§4.6 步骤 2）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 强度精筛阈值（§4.6 步骤 2）。
 *
 * · `includeArchived = false`（默认）⇒ `ARCHIVE_LINE`（归档线，`0.05`）——
 *   精筛剔除 `intensity ≤ ARCHIVE_LINE` 的项。
 * · `includeArchived = true` ⇒ `0.0`——**只过滤 `deleted = 0`**，
 *   归档记忆照常参与打分与排序。
 *   ⇒ 这是「**显式查询归档层**」的唯一代码路径（§4.4「归档仅显式查询可见」）。
 *
 * ⚠️ **`ARCHIVE_LINE` 来自参数表**（可调项），这里**不得**写死 `0.05`。
 *
 * @param params 生效参数
 * @param includeArchived 是否显式查询归档层
 * @returns 精筛阈值
 */
export function archiveFilterThreshold(params: Params, includeArchived: boolean): number {
  return includeArchived ? 0 : params.ARCHIVE_LINE;
}

/**
 * 强度精筛判定（§4.6 步骤 2）：`intensity > threshold`。
 *
 * ⚠️ **严格大于**：设计稿原文是 `intensity > ARCHIVE_LINE`（不是 `≥`），
 *   写成 `≥` 会让「恰好落在归档线上」的记忆留在候选集里，
 *   而归档线本身是可调参数 ⇒ 调参时边界行为会悄悄反向。
 *
 * @param intensityValue 候选的强度
 * @param threshold 阈值（`archiveFilterThreshold` 的输出）
 * @returns 是否通过精筛
 */
export function passesIntensityFilter(intensityValue: number, threshold: number): boolean {
  return intensityValue > threshold;
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、准入闸门：粗筛窗口（§4.6 步骤 2 的两档窗口）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 粗筛窗口（§4.6 步骤 2 的**两档窗口**）。
 *
 * ⚠️ **字段名刻意与 SQL 的绑定名逐字相同**（`@coarseCutoff` / `@coarseCutoffPinned`）：
 *   「名字即契约」—— SQL 层拿到的键名与 core 层算出的字段名是同一批词，
 *   于是「把 `pinnedTimeFloor` 绑成普通窗口」这类**接错线**在读代码时就看得出来。
 */
export interface CoarseGateWindow {
  /**
   * 是否设粗筛（`false` ⇒ 显式查询归档层，粗筛窗口**整体取消**，§4.6 步骤 2）。
   *
   * ⚠️ **单独给出这个标志，而不是让调用方从数值反推**：
   *   「取消粗筛」这件事一旦只能靠「下界是不是 0」来推断，
   *   它就成了一个**隐式编码** ⇒ 换个实现（如下界取 `-1`）就会静默改变语义。
   */
  readonly enabled: boolean;
  /**
   * 普通记忆的 `last_access` 下界（毫秒）—— SQL 的 `@coarseCutoff`。
   *
   * ⚠️ `enabled === false` 时恒为 **0**（不是 `undefined`、不是 `null`）：
   *   §4.6 步骤 2 的原话就是「令 `@coarseCutoff = 0`（不设 last_access 粗筛）」。
   *   ⚠️ **但 0 是「占位值」而不是「可以照绑的下界」**：
   *   `m.last_access >= 0` 对**负值时间戳**仍然是个筛子 ⇒ 真正「不设粗筛」的做法是
   *   **把粗筛片段从 SQL 里去掉**，而不是把阈值绑成 0。
   *   ⇒ 调用方**必须按 `enabled` 决定要不要绑定**（`enabled === false` ⇒ 一个键都不绑）。
   */
  readonly coarseCutoff: number;
  /**
   * 被 pin 记忆的 `last_access` 下界（毫秒）—— SQL 的 `@coarseCutoffPinned`。
   *
   * ⚠️ `enabled === false` 时恒为 **0**（同上：**占位值**，不得照绑）。
   */
  readonly coarseCutoffPinned: number;
}

/**
 * 粗筛窗口（§4.6 步骤 2 的两档窗口）—— **三路共用的唯一计算处**。
 *
 * ```
 * coarseCutoff       = now - MAX_STABILITY × ln(1/ARCHIVE_LINE) × 86400000        (默认 ≈ 539 天)
 * coarseCutoffPinned = now - MAX_STABILITY × MAX_PIN_FACTOR × ln(1/ARCHIVE_LINE) × 86400000  (默认 ≈ 2696 天)
 * ```
 *
 * ★ **为什么必须三路共用这一个函数**（这是本函数存在的全部理由）：
 *   §4.6 的**铁律①**是「准入闸门对三路**一视同仁**」，
 *   而 §4.15.2 的 `VectorBackend.search(query, k, filter)` 契约明写
 *   「`filter` 承载**准入闸门条件**（`deleted = 0` + 粗筛窗口）」——
 *   ⇒ 阶段 2 的向量路要的**就是这两个数**（`VectorFilter.timeFloor` /
 *     `pinnedTimeFloor`），它们与文本路/图谱路 SQL 里绑的 `@coarseCutoff` /
 *     `@coarseCutoffPinned` **是同一对数**。
 *   ⚠️ **若向量路另算一份**，最坏情况非常具体：
 *     **向量路的窗口比文本路宽 ⇒ 一条早已淡忘的记忆从向量路溜进来**
 *     ⇒ 正是铁律①要防的「用相似度废掉遗忘曲线」，而且它**不报错**，只是让遗忘曲线失效。
 *
 * ⚠️ **为什么用 `effectiveStability` 算 τ**（而不是直接写 `MAX_STABILITY × MAX_PIN_FACTOR`）：
 *   τ 的定义只有一处（`src/core/decay.ts` 的 `effectiveStability` = `stability × pin_factor`）。
 *   ⇒ 粗筛窗口用的 τ 与 `intensity` 用的 τ **必然同源**：
 *     粗筛是「粗」的上界（τ 取最大值），精筛用每行自己的 τ ⇒ 粗筛**绝不会**
 *     挡掉一条精筛本该放行的记忆（两个口径打架的表现是「明明没过期却召不回」）。
 *
 * ⚠️ **`includeArchived === true` ⇒ 粗筛整体取消**（两个下界都取 0）：
 *   §4.6 步骤 2 原话：「`includeArchived = true`：令 `@coarseCutoff = 0`（不设 last_access 粗筛），
 *   精筛阈值 `@archiveLine = 0.0`，即只过滤 `deleted = 0`」。
 *   ⇒ 这是「**显式查询归档层**」的唯一代码路径（§4.4「归档仅显式查询可见」）。
 *   ⚠️⚠️ **「精筛阈值 0.0」这句原话已被 ADR 判为自相矛盾，实际口径是「归档模式整体不判强度」**：
 *     `passesIntensityFilter` 是**严格大于**（`>`），而 `intensity = min(1, exp(-Δt/τ))`
 *     在 Δt 足够大时**下溢成恰好 0.0** ⇒ 若真按「阈值 0.0」判，这些行会被挡掉，
 *     可它们**已经被 SQL 捞进来了** ⇒ 「显式查询归档层」名存实亡。
 *     ⇒ 归档模式下**不调用** `passesIntensityFilter`（见 `src/store/recall.ts` 的 `filterAndSlice`），
 *       判据只有一条「只过滤 `deleted = 0`」。
 *     ⇒ 本函数只管**粗筛**（`last_access` 下界）；粗筛与精筛是两件事，别混。
 *   ⚠️ **向量路必须服从同一个开关**（铁律①）：否则「显式查归档层」只对两路生效，
 *     而归档层的记忆**根本进不了向量路** ⇒ 归档层在语义上就只被部分看见。
 *   ⚠️ **取消粗筛的做法是「不绑这两个参数」（并把 SQL 里的粗筛片段去掉）**，
 *     **不是**「把它们绑成 0」—— 后者对负值时间戳仍然是个筛子（详见字段注释）。
 *
 * @param params 生效参数（**必传**：窗口由 `MAX_STABILITY` / `MAX_PIN_FACTOR` / `ARCHIVE_LINE` 决定）
 * @param now 注入时钟（C37）；缺省取真实时钟
 * @param includeArchived 是否显式查询归档层（`true` ⇒ 粗筛整体取消）
 * @returns 粗筛窗口（**形状恒定**，字段恒为三个）
 */
export function coarseGateWindow(
  params: Params,
  now: number,
  includeArchived: boolean,
): CoarseGateWindow {
  if (includeArchived) {
    // ⚠️ 用 0 而不是 null/undefined：绑定参数**恒有两个**（见下方「形状恒定」的说明）。
    return { enabled: false, coarseCutoff: 0, coarseCutoffPinned: 0 };
  }

  // ⚠️ τ 的算法只有一处：`effectiveStability` = `stability × pin_factor`。
  const plainTauDays = effectiveStability({
    stability: params.MAX_STABILITY,
    pin_factor: 1,
    last_access: 0,
  });
  const pinnedTauDays = effectiveStability({
    stability: params.MAX_STABILITY,
    pin_factor: params.MAX_PIN_FACTOR,
    last_access: 0,
  });
  // ⚠️ **归档跨度不自己算**（C36：同一件事不得有两套公式）：
  //   `ln(1 / ARCHIVE_LINE)` 的唯一权威是 `decay.ts` 的 `archiveSpanFactor()`
  //   （`archiveAt()` 与本函数是同一公式的正反两面）⇒ 这里直接调用，不重写一遍。
  //   ⚠️ 历史上这个式子有三份副本（decay.ts / db/migrate.ts / 本文件）
  //   ⇒ 改一处不改另一处 ⇒ 粗筛窗口与归档时刻差一截，**且不报错**。
  const archiveSpanDays = archiveSpanFactor(params.ARCHIVE_LINE);

  return {
    enabled: true,
    coarseCutoff: now - plainTauDays * archiveSpanDays * MS_PER_DAY,
    coarseCutoffPinned: now - pinnedTauDays * archiveSpanDays * MS_PER_DAY,
  };
}
