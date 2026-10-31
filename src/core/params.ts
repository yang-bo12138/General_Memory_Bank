/**
 * 参数表 —— DESIGN-v2.md §5（**代码里唯一的真相**）。
 *
 * ⚠️ **逐字抄 §6 的 `DEFAULT_PARAMS` 代码块**（含全部参数项）。
 * 「§5 是写给人看的表、`DEFAULT_PARAMS` 是代码里的真相」——
 * 两边不一致时**实现者照哪边写都行**，而这类漂移**极难在实现期被发现**
 * （参数名对、值不同 ⇒ 行为不同但无报错）。
 * ⇒ **每次改参数必须同时改两处**，并由 `scripts/check-params.ts`（G26 验收断言）在 CI 里守住。
 *
 * ⚠️ **本文件不复述「分类构成」与「参数总数」**（F-01 残余②）：
 *   副本必然漂移，而副本漂移**不会被任何门禁抓住** ⇒ 假绿。
 *   ⇒ 构成与总数**以 `DESIGN-v2.md` §5 为唯一出处**，
 *     由 `scripts/check-doc-counts.ts`（连同 `DEVELOPMENT-PLAN.md` 的那份）一起守住。
 *
 * ⚠️ 五个机制开关的**大小写不要统一**（§5）：
 * · `coactivation` / `inhibition` / `writeBack` —— **小写**，它们是「机制有没有」的开关，
 *   不是业务参数，小写是刻意的（避免被误当成可调业务参数写进参数表与跨参数校验）；
 * · `ARCHIVAL_CACHE` / `VECTOR_ROUTER` —— **大写**，因为它们本身有取值语义。
 */

import { MemoryError } from './errors.js';

/** 向量路后端选择器的三个取值（§5 的 `VECTOR_ROUTER` 行）。 */
export type VectorRouterMode = 'auto' | 'ivf' | 'flat';

/** `VECTOR_ROUTER` 的三个合法取值（§5）。 */
export const VECTOR_ROUTER_MODES: readonly VectorRouterMode[] = ['auto', 'ivf', 'flat'];

/**
 * §3 的 `coacts` 表 CHECK 约束 `affinity <= 1.0` 写死的上界。
 *
 * ⚠️ **跨参数校验第 8 条**：`COACT_AFFINITY_MAX` 与这个常量**必须同步**——
 * 改上界要同时改 DDL，否则应用层钳制与库层约束不一致。
 * ⇒ 这里是「DDL 侧的上界」的单点声明，`check-params.ts` 会比对两者。
 */
export const COACT_AFFINITY_MAX_DDL_CHECK = 1.0;

/**
 * `VECTOR_OVERFETCH_FACTOR` —— **本版硬编码 3，不开放为参数**（C26）。
 *
 * ⚠️ 依据：DESIGN-v2.md §4.6 步骤 2c 的 SQL「`LIMIT @VECTOR_TOPK * 3`」。
 * C26 的契约是「参数名（默认值 N）必须在 §5 + `DEFAULT_PARAMS` **或显式硬编码**」——
 * ⇒ 它选择的是「显式硬编码」这条路，因此**必须**在正文与代码注释里写明「硬编码 3」。
 * ⇒ 本常量是这条硬编码的**唯一**声明点；阶段 2 的向量路必须引用它，不得再写一个字面量 3。
 */
export const VECTOR_OVERFETCH_FACTOR = 3;

/**
 * 全部参数项的默认值（§6 的代码块，逐字抄）。
 *
 * ⚠️ **这里不复述「参数项的分类构成」**（例如「行为语义 16 + 性能 9 + …」）：
 *   那是 §5 末的分类声明的**副本**，而**副本必然漂移**——
 *   F-01 残余②的实测：把源码里的这份副本（或计划稿里的那份）改回旧口径
 *   （照抄相加得 61），**6 条门禁全部 exit 0** ⇒ 假绿。
 *   ⇒ **构成以 `DESIGN-v2.md` §5 为唯一出处**（§5 是写给人看的表，本文件是代码里的真相，
 *     两者不一致时由 `scripts/check-params.ts` 抓住）。
 *   ⇒ 现在 `scripts/check-doc-counts.ts` 还会**同时**校验
 *     `docs/design/DEVELOPMENT-PLAN.md` 里的那份构成声明：
 *     **三处（§5 / 计划稿 / 本文件的键数）必须一致**，谁漂了门禁就红。
 *   ⇒ **本注释只写「以 §5 为准」，不写数字**（复述即漂）。
 */
export const DEFAULT_PARAMS = {
  // ── 衰减与分层（v1.0 继承）──
  MAX_STABILITY: 180,
  MAX_PIN_FACTOR: 5.0, // 必须与 §3 schema 的 CHECK (pin_factor <= 5.0) 同步；
  // 漏了这个键，§4.1 的 `factor <= MAX_PIN_FACTOR` 会与 undefined 比较恒为 false，
  // 结果 pin() 对任何输入都抛 INVALID_INPUT
  THRESHOLD_L3: 0.7,
  THRESHOLD_L2: 0.3,
  ARCHIVE_LINE: 0.05,
  EDGE_STABILITY: 30,
  MAX_EDGE_WEIGHT: 3.0,

  // ── 写入与增长（v1.0 继承）──
  INITIAL_STABILITY: 1.0,
  EMOTION_WEIGHT: 2.0,
  DIFFICULTY_BASE: 1.5,
  DIFFICULTY_SCALE: 0.5,
  DIFFICULTY_FIRST: 0.3,
  DIFFICULTY_NORMAL: 0.5,
  SPACING_CAP: 2.0,

  // ── 去重与关联（v1.0 继承）──
  DEDUP_ENTITY_MIN: 2,
  DEDUP_COS_MIN: 0.92, // 仅凭余弦即可判为同一事实的阈值（§4.9 步骤 3c）；与 DEDUP_ENTITY_MIN 是「或」的关系
  DEDUP_BOOST: 1.3,
  INITIAL_EDGE_WEIGHT: 0.8,
  EDGE_REINFORCE_STEP: 0.3,

  // ── 检索与扩散（v1.0 继承）──
  RECALL_TOP_N: 5,
  EMBED_DIM: 768, // **只读参数**：setParams() 传入它抛 INVALID_INPUT，只在构造时生效。
  // 它不是可调项——改维度等于全库旧向量作废，且同维度的换模型无法检测（§5）
  VECTOR_TOPK: 20, // 向量路带进打分的候选数，与文本路 slice(0, 20) 对齐
  VECTOR_MIN_COS: 0.25, // 低于此余弦不进候选（不是得 0 分，是根本不出现）
  ACTIVATION_DECAY: 0.2,
  ACTIVATION_MIN: 0.15,
  MAX_DIFFUSED_NODES: 20, // 必须与 §4.7 的 diffused 取前 N 一致；漏了这个键，取前 N 会变成 undefined
  MAX_DIFFUSED_VISITS: 200, // 扩散的边处理预算，语义见 §4.7（不是候选数）
  RECENCY_DECAY_DAYS: 14,
  SWEEP_BATCH_SIZE: 500, // sweep() 的批次粒度：既是每条事务的分组大小，也是归档统计的游标步长

  // ── v2.0 新增：神经元交互（§4.11 / §4.13）──
  COACT_AFFINITY_MAX: 1.0, // 共激活亲和度上限。必须与 §3 的 CHECK (affinity <= 1.0) 同步
  COACT_AFFINITY_MIN: 0.15, // 共激活有效亲和度下限。一套阈值三处语义：
  //   簇的边判定 / sweep() 的淘汰判据 / 「这一对还算不算一条关联」
  COACT_REINFORCE_STEP: 0.2,
  COACT_CAUSAL_BONUS: 0.25,
  COACT_STABILITY: 21, // 时间常数 τ（天），半衰期 = 21×ln2 ≈ 14.6 天
  COACT_MIN_ENTITIES: 2, // 只校验 >= 1，**不与 DEDUP_ENTITY_MIN 联动**（语义不同）
  COACT_MIN_COS: 0.5,
  COACT_MAX_PAIRS_PER_TOUCH: 20,
  COACT_BATCH_MAX: 256, // 单次 touch 的 coActivateWith 条目数上限；超出抛 INVALID_INPUT，不静默截断
  CLUSTER_TOPK: 3,
  MAX_CLUSTER_SHARE: 0.5, // 兜底切分的**触发阈值**（单簇占比），不是目标尺寸
  CLUSTER_MAX_FRACTION: 0.02, // 切分的**目标尺寸**（库规模的比例）
  CLUSTER_MEMBER_SAMPLE_MAX: 50, // 所有列出簇成员的操作的 LIMIT
  CLUSTER_RECALC_INTERVAL_MS: 3600000,
  REDUNDANCY_COS: 0.9, // 校验 0 < REDUNDANCY_COS <= DEDUP_COS_MIN

  // ── v2.0 新增：分桶路由（§4.15）──
  ROUTER_COARSE_CENTERS: 200,
  ROUTER_FINE_CENTERS: 10000,
  ROUTER_NPROBE_COARSE: 20, // 粗层探查桶数；召回损失的唯一来源（§4.15.4）
  ROUTER_NPROBE_FINE: 50, // 细层探查桶数
  ROUTER_BUCKET_MAX: 300, // 桶内成员数 P95 上限，超过触发全量重训
  ROUTER_NPROBE_WRITE_COARSE: 8, // 写入去重路径的粗层探查桶数（§4.9 步骤 3a2）
  ROUTER_NPROBE_WRITE_FINE: 20, // 写入去重路径的细层探查桶数（候选面 ≤ 召回路径）
  COACT_DEGREE_MAX: 32, // 单条记忆的共激活邻居数上限（度数爆炸的唯一闸门）
  ROUTER_MIN_TRAINING: 10000, // 建分桶的最小库规模；低于它走 flat（设计内行为，非故障）
  VECTOR_ROUTER: 'auto' as VectorRouterMode, // 第五个机制开关（三值选择器）：'auto'（**默认**，按 ROUTER_MIN_TRAINING 自动选：
  //   低于门槛 → flat，达到 → 建桶）/ 'ivf'（**强制**两级分桶，即使低于门槛也照建桶 + 记 warn）/
  //   'flat'（**强制**全表精确，v1.0 做法）
  //   ★ 切到 'flat' 才能做「与 v1.0 逐位一致」这条基线断言（ADR-21）；
  //     ⚠️ 'auto' **不构成**基线条件（它的实际走向随库规模变）
  CLUSTER_BONUS: 0.4, // 簇跳进入 diffused 的加成系数（§4.14.3）
  ARCHIVAL_ORPHAN_CHECK: 1000, // 归档缓存一致性抽样条数（§9.4.4）

  // ── v2.0 新增：机制级开关（ADR-21）── ★ **基线条件（完整）**：
  // 「与 v1.0 逐位一致」= **四个布尔开关全关** + **`VECTOR_ROUTER='flat'`**（三值选择器 ⇒ 只能说「设为 flat」，不能「关闭」）
  // + `ARCHIVAL_CACHE` 任意（关掉 = 走慢路但结果相同）
  // ⚠️ **'auto' 不构成基线条件**（它的实际走向随库规模变）
  // ⚠️ **默认 VECTOR_ROUTER='auto' ⇒ 默认配置下「四开关全关」并不等于 v1.0 行为**
  // ⚠️ 这四个键是**小写**的：它们不是业务参数，是「机制有没有」的开关。
  //    小写是刻意的——避免被误当成可调业务参数写进参数表与跨参数校验。
  coactivation: true, // 关：touch 不写 coacts；联想路与簇跳不执行；簇不计算
  inhibition: true, // 关：无侧抑制，直接按 base 分取 topN
  writeBack: true, // 关：关闭「扩散唤起 → 采纳 → 回写」的联动（growStability 不受影响）
  ARCHIVAL_CACHE: true, // 关：countArchived() 退回逐行精筛（§9.4）
};

/** 全部生效参数的形状。 */
export type Params = typeof DEFAULT_PARAMS;

/** 全部参数的键名。 */
export type ParamKey = keyof Params;

/** 全部参数的值类型。 */
export type ParamValue = Params[ParamKey];

/** `EMBED_DIM` 是**只读**参数（§5/§6）：类型上排除，运行期再兜一道。 */
export type MutableParamKey = Exclude<ParamKey, 'EMBED_DIM'>;

/** `setParams()` 接受的补丁形状：`EMBED_DIM` 在**类型上**被排除。 */
export type ParamPatch = Partial<Omit<Params, 'EMBED_DIM'>>;

/** 全部参数的键名清单（顺序 = `DEFAULT_PARAMS` 的书写顺序）。 */
export const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as ParamKey[];

/** 参数总数（§5：29 → 60）。 */
export const PARAM_COUNT = 60;

/**
 * 一条跨参数校验的违反项。
 *
 * ⚠️ §5 原文：「校验失败时 `INVALID_INPUT` 的 `details` 必须带上**建议值**：
 * 给出建议值省掉调用方自己算——而 `DEDUP_COS_MIN` 本身也是可调参数，合法上界会随它一起动。」
 */
export interface ParamViolation {
  /** 违反的参数键（`details` 的第一层键）。 */
  key: ParamKey;
  /** 当前的（非法）取值。 */
  current: number | boolean | string;
  /** 建议的**上界**（含）；存在时写入 `details[key].maxAllowed`。 */
  maxAllowed?: number;
  /** 建议的**下界**（不含）；存在时写入 `details[key].minAllowed`。 */
  minAllowed?: number;
  /** 人类可读的理由（必须写明**为什么**，不能只写「非法」）。 */
  reason: string;
}

/**
 * 校验失败时抛出的错误的 `details` 形状。
 *
 * ⚠️ §5 原文的形状是「**一个键一个对象**」：
 *   `details = { REDUNDANCY_COS: { current: 0.90, maxAllowed: 0.85, reason: '...' } }`
 *   ⇒ `details[key]` **不是数组**（改成数组会破坏调用方与既有断言的形状）。
 */
export type ParamViolationDetails = Record<string, ParamViolationDetail>;

/**
 * 一个键的违反详情（`details[key]`）。
 *
 * ⚠️ 在 §5 的形状之上，**额外**保留该键的**全部**违反项：
 *   同一个键可能同时违反多条约束（例：`ROUTER_COARSE_CENTERS` 同时低于
 *   `ROUTER_NPROBE_COARSE` 与 `ROUTER_NPROBE_WRITE_COARSE` 两个探针数），
 *   只留一条会把另一条**掩盖**掉（QA 报告 §四·观察项 7）。
 */
export interface ParamViolationDetail extends Omit<ParamViolation, 'key'> {
  /**
   * 该键的**全部**违反项（仅当该键违反**多条**约束时才有）。
   *
   * ⚠️ 之所以不是数组而是「对象 + 这个列表」：
   *   §5 承诺的 `details[key]` 形状是**一个对象**（含可直接读取的建议值），
   *   改成数组会破坏调用方的形状契约与既有断言。
   */
  violations?: ParamViolation[];
}

/**
 * 把**同一个键**的**一条或多条**违反项合并成**一条**可执行的建议值（§5）。
 *
 * ⚠️ 为什么不能简单地「保留第一条」：
 *   同一个键的若干条违反项**都要满足** ⇒ 真正的**约束**是它们里**最严**的那条
 *   （下界取**最大**、上界取**最小**）。若只报第一条，可能报出一个
 *   **照着改仍然不合法**的建议值（例：`ROUTER_NPROBE_WRITE_COARSE = 100` 时，
 *   `ROUTER_COARSE_CENTERS` 的两条违反项分别要求 ≥20 与 ≥100，
 *   只报 20 ⇒ 调用方改成 20 依旧非法）。
 * ⇒ 这里取**最严**的界，并 `violations` 保留全部违反项（不掩盖）。
 *
 * ⚠️ 「取最大/取最小」是**与顺序无关**的 ⇒ 同一组违反项无论校验顺序如何，
 *   得到的建议值都相同（可复现）。
 */
function mergeViolationDetails(violations: readonly ParamViolation[]): ParamViolationDetail {
  const first = violations[0];
  if (first === undefined) {
    throw new Error('mergeViolationDetails 需要至少一条违反项');
  }

  const detail: ParamViolationDetail = {
    current: first.current,
    // ⚠️ 理由**全部**保留（用「；」连接）⇒ 哪一条约束也不被掩盖。
    reason: violations.map((violation) => violation.reason).join('；'),
  };

  let minAllowed: number | undefined;
  let maxAllowed: number | undefined;
  for (const violation of violations) {
    if (violation.minAllowed !== undefined) {
      minAllowed =
        minAllowed === undefined
          ? violation.minAllowed
          : Math.max(minAllowed, violation.minAllowed);
    }
    if (violation.maxAllowed !== undefined) {
      maxAllowed =
        maxAllowed === undefined
          ? violation.maxAllowed
          : Math.min(maxAllowed, violation.maxAllowed);
    }
  }
  if (minAllowed !== undefined) {
    detail.minAllowed = minAllowed;
  }
  if (maxAllowed !== undefined) {
    detail.maxAllowed = maxAllowed;
  }
  if (violations.length > 1) {
    detail.violations = [...violations];
  }
  return detail;
}

/**
 * 8 条跨参数校验（§5，编号 1~8）。
 *
 * ⚠️ **刻意不做的联动校验**（§5 明写）：
 * · `COACT_MIN_COS` 与 `REDUNDANCY_COS` **不联动**——
 *   前者是「要不要建立关联」，后者是「要不要让位」，两个独立旋钮绑死会让其中一个失去调节余地
 *   （§11.4 的前提正是「人能独立调旋钮」）。
 * · `COACT_MIN_ENTITIES` 与 `DEDUP_ENTITY_MIN` **不联动**（语义不同）。
 * ⇒ **不要**在实现里「顺手」加这两条联动。
 *
 * @param params 全量生效参数
 * @returns 全部违反项（空数组 = 合法）
 */
export function validateParams(params: Params): ParamViolation[] {
  const violations: ParamViolation[] = [];

  // ── 1. `0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN`（默认 0.90 ≤ 0.92 ✓）──
  // ⚠️ **方向是 `≤` 不是 `<`**：若要求严格小于，参数空间会塌缩到 (0.90, 0.92)，
  //    不到 0.02 的宽区间，任何一次调参都可能落进非法区直接抛错。
  if (params.REDUNDANCY_COS <= 0 || params.REDUNDANCY_COS > params.DEDUP_COS_MIN) {
    violations.push({
      key: 'REDUNDANCY_COS',
      current: params.REDUNDANCY_COS,
      maxAllowed: params.DEDUP_COS_MIN,
      minAllowed: 0,
      reason: 'must be <= DEDUP_COS_MIN（抑制不得比合并更严）',
    });
  }

  // ── 2. `COACT_AFFINITY_MAX > COACT_REINFORCE_STEP + COACT_CAUSAL_BONUS`（默认 1.0 > 0.45 ✓）──
  // ⚠️ **必须是严格大于**：若 `MAX <= base` ⇒ `min(MAX, a_old+Δ)` 在**第一次强化就顶格**
  //    ⇒ 亲和度谱塌缩（所有对一步到 MAX ⇒ 全部 ≥ COACT_AFFINITY_MIN ⇒ 图上全连通 ⇒ 巨型簇风险），
  //    **且不报错**。
  const coactBase = params.COACT_REINFORCE_STEP + params.COACT_CAUSAL_BONUS;
  if (!(params.COACT_AFFINITY_MAX > coactBase)) {
    violations.push({
      key: 'COACT_AFFINITY_MAX',
      current: params.COACT_AFFINITY_MAX,
      minAllowed: coactBase,
      maxAllowed: COACT_AFFINITY_MAX_DDL_CHECK,
      reason:
        'must be > COACT_REINFORCE_STEP + COACT_CAUSAL_BONUS（否则第一次强化就顶格，亲和度谱塌缩成巨型簇）',
    });
  }

  // ── 3. `COACT_REINFORCE_STEP ≥ COACT_AFFINITY_MIN`（默认 0.20 ≥ 0.15 ✓）──
  // ⇒ 单次共现即成边 ⇒ 簇 = 原始共激活图的连通分量 ⇒ 巨型簇风险。
  //    ★ 默认参数**就是**「单次共现成边」（有意取舍），但必须写成可检的关系。
  if (params.COACT_REINFORCE_STEP < params.COACT_AFFINITY_MIN) {
    violations.push({
      key: 'COACT_REINFORCE_STEP',
      current: params.COACT_REINFORCE_STEP,
      minAllowed: params.COACT_AFFINITY_MIN,
      reason: 'must be >= COACT_AFFINITY_MIN（否则单次共现不足以成边，簇的涌现密度会塌）',
    });
  }

  // ── 4. `COACT_MIN_ENTITIES >= 1`、`COACT_MIN_COS ∈ (0,1]` ──
  if (params.COACT_MIN_ENTITIES < 1) {
    violations.push({
      key: 'COACT_MIN_ENTITIES',
      current: params.COACT_MIN_ENTITIES,
      minAllowed: 1,
      reason: 'must be >= 1（建立共激活所需的最小共享实体数）',
    });
  }
  if (params.COACT_MIN_COS <= 0 || params.COACT_MIN_COS > 1) {
    violations.push({
      key: 'COACT_MIN_COS',
      current: params.COACT_MIN_COS,
      minAllowed: 0,
      maxAllowed: 1,
      reason: 'must be in (0, 1]（建立共激活所需的最小余弦）',
    });
  }

  // ── 5. `COACT_MAX_PAIRS_PER_TOUCH >= 1`、`COACT_BATCH_MAX >= 1` ──
  if (params.COACT_MAX_PAIRS_PER_TOUCH < 1) {
    violations.push({
      key: 'COACT_MAX_PAIRS_PER_TOUCH',
      current: params.COACT_MAX_PAIRS_PER_TOUCH,
      minAllowed: 1,
      reason: 'must be >= 1（单次 touch 最多记多少对共激活）',
    });
  }
  if (params.COACT_BATCH_MAX < 1) {
    violations.push({
      key: 'COACT_BATCH_MAX',
      current: params.COACT_BATCH_MAX,
      minAllowed: 1,
      reason: 'must be >= 1（单次 touch 的 coActivateWith 条目数上限）',
    });
  }

  // ── 6. `ROUTER_NPROBE_COARSE ≥ 1` 且 `ROUTER_NPROBE_FINE ≥ 1`（探针数为 0 会让向量路恒空）──
  if (params.ROUTER_NPROBE_COARSE < 1) {
    violations.push({
      key: 'ROUTER_NPROBE_COARSE',
      current: params.ROUTER_NPROBE_COARSE,
      minAllowed: 1,
      reason: 'must be >= 1（探针数为 0 会让向量路恒空）',
    });
  }
  if (params.ROUTER_NPROBE_FINE < 1) {
    violations.push({
      key: 'ROUTER_NPROBE_FINE',
      current: params.ROUTER_NPROBE_FINE,
      minAllowed: 1,
      reason: 'must be >= 1（探针数为 0 会让向量路恒空）',
    });
  }

  // ── 7. 探针数不得大于中心数（写入路径的两个探针数同理）──
  if (params.ROUTER_COARSE_CENTERS < params.ROUTER_NPROBE_COARSE) {
    violations.push({
      key: 'ROUTER_COARSE_CENTERS',
      current: params.ROUTER_COARSE_CENTERS,
      minAllowed: params.ROUTER_NPROBE_COARSE,
      reason: 'must be >= ROUTER_NPROBE_COARSE（探针数不得大于中心数）',
    });
  }
  if (params.ROUTER_FINE_CENTERS < params.ROUTER_NPROBE_FINE) {
    violations.push({
      key: 'ROUTER_FINE_CENTERS',
      current: params.ROUTER_FINE_CENTERS,
      minAllowed: params.ROUTER_NPROBE_FINE,
      reason: 'must be >= ROUTER_NPROBE_FINE（探针数不得大于中心数）',
    });
  }
  if (params.ROUTER_COARSE_CENTERS < params.ROUTER_NPROBE_WRITE_COARSE) {
    violations.push({
      key: 'ROUTER_COARSE_CENTERS',
      current: params.ROUTER_COARSE_CENTERS,
      minAllowed: params.ROUTER_NPROBE_WRITE_COARSE,
      reason: 'must be >= ROUTER_NPROBE_WRITE_COARSE（写入路径的探针数同样不得大于中心数）',
    });
  }
  if (params.ROUTER_FINE_CENTERS < params.ROUTER_NPROBE_WRITE_FINE) {
    violations.push({
      key: 'ROUTER_FINE_CENTERS',
      current: params.ROUTER_FINE_CENTERS,
      minAllowed: params.ROUTER_NPROBE_WRITE_FINE,
      reason: 'must be >= ROUTER_NPROBE_WRITE_FINE（写入路径的探针数同样不得大于中心数）',
    });
  }

  // ── 8. `COACT_AFFINITY_MAX` 与 §3 的 CHECK 约束必须同步 ──
  // ⚠️ 本条的**库层**部分：§3 的 `coacts` 表 CHECK 写死 `affinity <= 1.0`，
  //    ⇒ 应用层的钳制上界不得高于它，否则应用层放行、库层拒绝 ⇒ 写入时才炸。
  //    **DDL 侧**的同步由 `scripts/check-params.ts` 比对 `COACT_AFFINITY_MAX_DDL_CHECK`。
  if (params.COACT_AFFINITY_MAX > COACT_AFFINITY_MAX_DDL_CHECK) {
    violations.push({
      key: 'COACT_AFFINITY_MAX',
      current: params.COACT_AFFINITY_MAX,
      maxAllowed: COACT_AFFINITY_MAX_DDL_CHECK,
      reason: 'must be <= 1.0（必须与 §3 coacts 表的 CHECK (affinity <= 1.0) 同步）',
    });
  }

  return violations;
}

/**
 * §5 的 **8 条跨参数校验**的清单（机器可读）。
 *
 * ⚠️ **条数是会被交叉引用与断言的量**：清单增删必须同步改引用处的数字
 *   （与 §12 方法覆盖表同一条纪律，C25）。
 *   ⇒ `scripts/check-contract-ids.ts` 会把它与 §5 正文里数出来的条数、
 *     以及 §12 里引用的数字**三方比对**。
 */
export const CROSS_PARAM_VALIDATION_RULES: ReadonlyArray<{
  /** 编号（1~8，连续）。 */
  id: number;
  /** 条件（§5 原文的简写）。 */
  condition: string;
  /** 默认值下的方向说明（§5 原文）。 */
  direction?: string;
}> = [
  {
    id: 1,
    condition: '0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN',
    direction: '0.90 ≤ 0.92 ✓（方向是 ≤ 不是 <）',
  },
  {
    id: 2,
    condition: 'COACT_AFFINITY_MAX > COACT_REINFORCE_STEP + COACT_CAUSAL_BONUS',
    direction: '1.0 > 0.45 ✓（严格大于）',
  },
  {
    id: 3,
    condition: 'COACT_REINFORCE_STEP ≥ COACT_AFFINITY_MIN',
    direction: '0.20 ≥ 0.15 ✓',
  },
  {
    id: 4,
    condition: 'COACT_MIN_ENTITIES >= 1、COACT_MIN_COS ∈ (0,1]',
  },
  {
    id: 5,
    condition: 'COACT_MAX_PAIRS_PER_TOUCH >= 1、COACT_BATCH_MAX >= 1',
  },
  {
    id: 6,
    condition: 'ROUTER_NPROBE_COARSE ≥ 1 且 ROUTER_NPROBE_FINE ≥ 1',
  },
  {
    id: 7,
    condition:
      'ROUTER_COARSE_CENTERS ≥ ROUTER_NPROBE_COARSE 且 ROUTER_FINE_CENTERS ≥ ROUTER_NPROBE_FINE（写入路径两个探针数同理）',
  },
  {
    id: 8,
    condition: 'COACT_AFFINITY_MAX = 1.0 与 §3 的 CHECK 约束必须同步',
    direction: '改上界要同时改 DDL',
  },
];

/** §5 的跨参数校验条数（写死的期望值）。 */
export const CROSS_PARAM_VALIDATION_COUNT = CROSS_PARAM_VALIDATION_RULES.length;

/**
 * 校验全量参数；不合法则抛 `MemoryError.INVALID_INPUT`（`details` 带建议值）。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`
 */
export function assertParamsValid(params: Params): void {
  const violations = validateParams(params);
  if (violations.length === 0) {
    return;
  }
  // ⚠️ 同一个键可能有多条违反（如 `ROUTER_COARSE_CENTERS` 同时低于两个探针数）⇒
  //    按键**分组**后合并成**一条**可执行的建议值（取最严的界），并保留全部违反项。
  //    详见 `mergeViolationDetails` 的说明。
  const byKey = new Map<string, ParamViolation[]>();
  for (const violation of violations) {
    const bucket = byKey.get(violation.key);
    if (bucket === undefined) {
      byKey.set(violation.key, [violation]);
    } else {
      bucket.push(violation);
    }
  }

  const details: ParamViolationDetails = {};
  for (const [key, group] of byKey) {
    details[key] = mergeViolationDetails(group);
  }

  throw MemoryError.invalidInput(
    `参数未通过跨参数校验：${violations.map((v) => v.key).join(', ')}`,
    details,
  );
}

/** 值的类型是否与期望的类型名一致（`expected` 取自 `typeof` 的结果）。 */
function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

/**
 * 应用一个参数补丁：**先全量校验 → 再返回合并结果**。
 *
 * ⚠️ 原子性：校验不通过时**直接抛错，不返回任何新参数**——
 * 调用方拿不到「改了一半」的对象，这正是 §5「一个参数都不落库」的前半段保证
 * （落库那一半由 `ParamStore` 在单事务里完成，见 `src/store/params.ts`）。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`
 */
export function applyParamPatch(current: Params, patch: ParamPatch): Params {
  const raw = patch as Record<string, unknown>;

  // ── `EMBED_DIM` 是只读参数：§6 明确「两层都要」（类型上排除 + 运行期再兜一道）──
  if (Object.prototype.hasOwnProperty.call(raw, 'EMBED_DIM')) {
    throw MemoryError.invalidInput(
      'EMBED_DIM 是只读参数：setParams() 传入它抛 INVALID_INPUT，只在 MemoryConfig 构造时生效',
      {
        EMBED_DIM: {
          current: current.EMBED_DIM,
          reason: 'read-only parameter（改维度等于全库旧向量作废，必须全量重嵌入）',
        },
      },
    );
  }

  // ── 未知键 ──
  const unknownKeys = Object.keys(raw).filter(
    (key) => !Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, key),
  );
  if (unknownKeys.length > 0) {
    throw MemoryError.invalidInput(`未知参数键：${unknownKeys.join(', ')}`, {
      unknownKeys: {
        current: unknownKeys.join(','),
        reason: '不是 DEFAULT_PARAMS 中的键',
      },
    });
  }

  // ── 类型检查（值的类型必须与默认值一致）──
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    const paramKey = key as ParamKey;
    const expected = typeof DEFAULT_PARAMS[paramKey];
    if (!matchesType(value, expected)) {
      throw MemoryError.invalidInput(`参数 ${key} 的类型必须是 ${expected}`, {
        [key]: {
          current: value,
          reason: `expected type ${expected}`,
        },
      });
    }
  }

  // ── `VECTOR_ROUTER` 的取值必须是三值之一（§5）──
  if (raw.VECTOR_ROUTER !== undefined && raw.VECTOR_ROUTER !== null) {
    const mode = raw.VECTOR_ROUTER as VectorRouterMode;
    if (!VECTOR_ROUTER_MODES.includes(mode)) {
      throw MemoryError.invalidInput(
        `VECTOR_ROUTER 必须是 ${VECTOR_ROUTER_MODES.join(' / ')} 之一`,
        {
          VECTOR_ROUTER: {
            current: String(mode),
            reason: `must be one of ${VECTOR_ROUTER_MODES.join(' / ')}`,
          },
        },
      );
    }
  }

  const next = { ...current, ...(patch as Partial<Params>) } as Params;

  // ── 8 条跨参数校验（全量）──
  assertParamsValid(next);

  return next;
}

/** 一次参数变更的差异项（写进 `config` 事件的 `changed`）。 */
export interface ParamChange {
  key: string;
  from: unknown;
  to: unknown;
}

/**
 * 计算两个参数集合的差异（用于 `config` 事件的 `changed` 字段）。
 *
 * ⚠️ §8.4 硬规则 2：`changed` 只供人看「这次动了哪几个」；
 *   重放读的是 `params`（完整快照），不是 `changed`。
 */
export function diffParams(before: Params, after: Params): ParamChange[] {
  const changes: ParamChange[] = [];
  for (const key of PARAM_KEYS) {
    const from = before[key];
    const to = after[key];
    if (from !== to) {
      changes.push({ key, from, to });
    }
  }
  return changes;
}
