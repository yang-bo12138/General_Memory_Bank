/**
 * 五个机制开关 —— DESIGN-v2.md §5（ADR-21）。
 *
 * ★ **基线条件（完整）**：「与 v1.0 逐位一致」= **四个布尔开关全关** + **`VECTOR_ROUTER='flat'`**
 *   （三值选择器 ⇒ 只能说「设为 flat」，不能「关闭」）
 *   + `ARCHIVAL_CACHE` 任意（关掉 = 走慢路但结果相同）。
 *   ⚠️ **`'auto'` 不构成基线条件**（它的实际走向随库规模变）。
 *   ⚠️ **默认 `VECTOR_ROUTER='auto'` ⇒ 默认配置下「四开关全关」并不等于 v1.0 行为。**
 *   ⚠️ `ARCHIVAL_CACHE` **也必须**纳入基线组：虽然它的**结果**与逐行精筛逐位相同，
 *      但**实现路径不同**——不纳入的话，「逐位一致」这句话在字面上就不成立。
 *
 * ⚠️ **开关的读取时机**：必须在**每次调用时**读（运行时可切换），不能在 `open()` 时快照。
 *   ⇒ 本模块是**纯函数** `resolveFlags(params)`：调用方每次拿当前参数重新解析，
 *      没有任何「快照」的概念可供误用。
 */

import { DEFAULT_PARAMS, type Params, type VectorRouterMode } from './params.js';

/** 四个布尔机制开关的键名（§5 的机制开关表）。 */
export const BOOLEAN_FLAG_KEYS = [
  'coactivation',
  'inhibition',
  'writeBack',
  'ARCHIVAL_CACHE',
] as const;

/** 四个布尔机制开关的键名。 */
export type BooleanFlagKey = (typeof BOOLEAN_FLAG_KEYS)[number];

/**
 * 五个机制开关的解析结果。
 *
 * ⚠️ 四个布尔开关是**小写**键：它们不是业务参数，是「机制有没有」的开关。
 *   `ARCHIVAL_CACHE` 与 `VECTOR_ROUTER` 是**大写**键，因为它们本身有取值语义。
 */
export interface FeatureFlags {
  /** 关：`touch` 不写 `coacts`；联想路与簇跳不执行；主题簇不计算也不使用。 */
  coactivation: boolean;
  /** 关：无侧抑制（候选带不重排，直接按 base 分取 topN）。 */
  inhibition: boolean;
  /** 关：关闭「扩散唤起 → 采纳 → 回写」的**联动**（`touch` 自身的 `growStability` 加固**不受影响**）。 */
  writeBack: boolean;
  /** 关：`countArchived()` 退回逐行精筛（结果相同、路径不同）。 */
  ARCHIVAL_CACHE: boolean;
  /** 向量路后端选择器（三值，不是布尔）。 */
  VECTOR_ROUTER: VectorRouterMode;
}

/**
 * 五个机制开关的规格表（§5 的机制开关表 + 机制级开关表，逐字）。
 *
 * ⚠️ 把它做成**代码里的常量**而不是散落在各处的注释，是为了让它**可被断言**：
 *   「开关的准确行为」这条设计约束，在阶段 0 就能被单测钉住。
 */
export const FEATURE_FLAG_SPEC: ReadonlyArray<{
  key: BooleanFlagKey | 'VECTOR_ROUTER';
  defaultValue: boolean | VectorRouterMode;
  /** 关闭 / 改值后的行为（§5 原文）。 */
  disabledBehavior: string;
}> = [
  {
    key: 'coactivation',
    defaultValue: true,
    disabledBehavior: 'touch 不写 coacts；联想路不执行；§4.14 簇跳不执行；主题簇不计算也不使用',
  },
  {
    key: 'inhibition',
    defaultValue: true,
    disabledBehavior: '无侧抑制（候选带不重排，直接按 base 分取 topN）',
  },
  {
    key: 'writeBack',
    defaultValue: true,
    disabledBehavior:
      '关闭「扩散唤起 → 采纳 → 回写」的联动部分（touch 自身的 growStability 加固不受影响）',
  },
  {
    key: 'ARCHIVAL_CACHE',
    defaultValue: true,
    disabledBehavior: 'countArchived() 退回逐行精筛（结果相同、路径不同）',
  },
  {
    key: 'VECTOR_ROUTER',
    defaultValue: 'auto',
    disabledBehavior:
      "三值选择器，不是布尔：'auto' / 'ivf' / 'flat'（'flat' 才是真正回到 v1.0 的向量路）",
  },
];

/**
 * 从参数集合解析出五个机制开关。
 *
 * ⚠️ **每次调用都重新解析**——这是「运行时可切换、立即生效」的实现方式。
 *   不得在 `open()` 时把结果快照下来（那会让「改开关立即生效」变成假象）。
 *
 * @param params 当前生效的全量参数
 */
export function resolveFlags(params: Params): FeatureFlags {
  return {
    coactivation: params.coactivation,
    inhibition: params.inhibition,
    writeBack: params.writeBack,
    ARCHIVAL_CACHE: params.ARCHIVAL_CACHE,
    VECTOR_ROUTER: params.VECTOR_ROUTER,
  };
}

/**
 * 基线组的开关取值（§5 基线条件注记）。
 *
 * ⚠️ `ARCHIVAL_CACHE` **也取 false**：它的**结果**与逐行精筛逐位相同，但**实现路径不同**——
 *   不纳入基线组的话，「逐位一致」这句话在字面上就不成立（§5 基线组说明）。
 */
export const BASELINE_FLAGS: FeatureFlags = {
  coactivation: false,
  inhibition: false,
  writeBack: false,
  ARCHIVAL_CACHE: false,
  VECTOR_ROUTER: 'flat',
};

/**
 * 判断一份参数是否构成「与 v1.0 逐位一致」的基线配置。
 *
 * ★ 判定条件（完整）：**四个布尔开关全为 false** + **`VECTOR_ROUTER === 'flat'`**。
 *   ⚠️ `VECTOR_ROUTER === 'auto'` **不构成**基线条件（它的实际走向随库规模变）。
 */
export function isBaselineConfig(params: Params): boolean {
  const flags = resolveFlags(params);
  return (
    flags.coactivation === BASELINE_FLAGS.coactivation &&
    flags.inhibition === BASELINE_FLAGS.inhibition &&
    flags.writeBack === BASELINE_FLAGS.writeBack &&
    flags.ARCHIVAL_CACHE === BASELINE_FLAGS.ARCHIVAL_CACHE &&
    flags.VECTOR_ROUTER === BASELINE_FLAGS.VECTOR_ROUTER
  );
}

/**
 * 把参数集合调整到基线组（四个布尔开关全关 + `VECTOR_ROUTER='flat'`）。
 *
 * ⚠️ 只动五个开关，**其余 55 项一字不改**——基线是「关掉新机制」，不是「重置全部参数」。
 */
export function toBaselineParams(params: Params): Params {
  return {
    ...params,
    coactivation: BASELINE_FLAGS.coactivation,
    inhibition: BASELINE_FLAGS.inhibition,
    writeBack: BASELINE_FLAGS.writeBack,
    ARCHIVAL_CACHE: BASELINE_FLAGS.ARCHIVAL_CACHE,
    VECTOR_ROUTER: BASELINE_FLAGS.VECTOR_ROUTER,
  };
}

/**
 * 向量路后端的**状态**取值（§6 的 `MemoryStats.vectorBackend.mode`）。
 *
 * ⚠️ **四个互不相同的字面量**，不是「mode + flatReason」两个字段
 *   （两个字段 = 又一个「两份副本可能不一致」的新坑，§6）。
 * ⚠️ **C36：配置与状态不得共用同一套词**——
 *   `VECTOR_ROUTER='flat'`（**要求**）与 `mode='flat_auto'`（**实际走的**）语义不同。
 */
export type VectorBackendMode = 'flat_explicit' | 'flat_auto' | 'ivf' | 'absent';

/** 向量路后端状态（§6 的 `vectorBackend` 观测块）。 */
export interface VectorBackendState {
  /** 实际走的向量路。 */
  mode: VectorBackendMode;
  /** ★ **仅 `mode === 'absent'` 时有意义**：true = 正在重训；false = 从未训练 / 训练失败。 */
  inRetrain: boolean;
}

/** 判定向量路状态所需的外部事实。 */
export interface VectorBackendFacts {
  /** 库内**未删且有向量**的记忆数（§4.15.6 状态① 的判据）。 */
  embeddedCount: number;
  /** 是否**存在可用的细桶**（`vector_fine_cells` 非空）——「曾调用过 rebuildVectorBuckets()」不算。 */
  hasTrainedBuckets: boolean;
  /** 当前是否正在重训（§4.15.5）。 */
  inRetrain: boolean;
}

/**
 * 判定向量路的**实际状态**（§4.6 步骤 0 的判定顺序 + §6 的四值枚举）。
 *
 * 判定顺序（**自动优先**，§4.6 步骤 0 ①）：
 * 1. **未命中 `ROUTER_MIN_TRAINING`**（库规模太小）⇒ 走 flat，**无论 `VECTOR_ROUTER` 设成什么**；
 *    显式 `'ivf'` 在此时**照建桶 + 记一条 warn 日志**（**不静默回落**——
 *    静默回落 = 静默改写调用方的显式配置）。
 * 2. 否则按 `VECTOR_ROUTER`：`'flat'` ⇒ flat；`'ivf'` / `'auto'` ⇒ 走两级分桶。
 * 3. **第三分支（堵一个静默失效）**：规模 ≥ 门槛**且分桶尚未训练** ⇒ **向量路整体缺席**
 *    （`mode='absent'`）——既不静默走 ivf（桶表为空 ⇒ 向量路恒空），
 *    也不静默回落 flat（那会改写调用方显式指定的 `'ivf'`）。
 *
 * ⚠️ **设计稿内部有一处自相矛盾，本实现取「`'auto'` 必须真的自动」那一版**：
 *   · §4.6 步骤 0 ② 写「`'auto'` / `'flat'` ⇒ 走 flat」；
 *   · 但紧随其后的 ★ 注写「**`'auto'` 必须真的自动**（否则它是个**死值**：两个分支里都等价于 flat）：
 *     规模 ≥ `ROUTER_MIN_TRAINING` ⇒ **走 ivf**；否则 ⇒ 走 flat」；
 *   · §5 的 `VECTOR_ROUTER` 行也写「`'auto'`（默认，按 `ROUTER_MIN_TRAINING` 自动选：
 *     低于门槛 → flat，达到 → 建桶）」。
 *   ⇒ 若按 ② 实现，`'auto'` 永远是 flat = **死值**，v2.1 的分桶路由整条能力形同虚设；
 *     故取 ★ 注 / §5 / §4.15.3 / §4.15.6 一致的口径：**过门槛 ⇒ `'auto'` 走 ivf**。
 */
export function resolveVectorBackendState(
  params: Params,
  facts: VectorBackendFacts,
): VectorBackendState {
  const router = params.VECTOR_ROUTER;
  const belowThreshold = facts.embeddedCount < params.ROUTER_MIN_TRAINING;

  if (belowThreshold) {
    if (router === 'ivf') {
      // 强制建桶（低于门槛也照建）+ 记一条 warn 日志；结果仍然正确（桶内全量精确点积）
      return { mode: 'ivf', inRetrain: false };
    }
    if (router === 'flat') {
      return { mode: 'flat_explicit', inRetrain: false };
    }
    return { mode: 'flat_auto', inRetrain: false };
  }

  if (router === 'flat') {
    return { mode: 'flat_explicit', inRetrain: false };
  }

  // 'ivf' 或 'auto'：规模已过门槛
  if (facts.hasTrainedBuckets) {
    return { mode: 'ivf', inRetrain: false };
  }
  return { mode: 'absent', inRetrain: facts.inRetrain };
}

/**
 * 默认参数下的开关状态（供调用方做「默认即基线？」之类的自检）。
 *
 * ⚠️ 默认 `VECTOR_ROUTER='auto'` ⇒ 默认配置**不构成**基线（§5 基线条件注记）。
 */
export function defaultFlags(): FeatureFlags {
  return resolveFlags(DEFAULT_PARAMS);
}
