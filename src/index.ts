/**
 * `memory-ocean` —— 通用记忆库 v2.1（记忆海版）公共导出入口。
 *
 * ⚠️ **本文件是「公开承诺」的清单**：导出的每一个名字都要能指到唯一代码路径
 *   （§14.3 边界原则 1「每个承诺都要能指到唯一代码路径」）。
 *
 * ## 导出面的两个阶段
 *
 * · **阶段 0（P0-T01~T06）** 只导出**不变量设施**（参数表 / 机制开关 / 事件流 /
 *   错误类型 / 时钟契约）——
 *   DESIGN-v2.md §12 阶段 0 原文「本阶段**不实现任何新机制**，只建开关与不变量测试。
 *   没有这个阶段，后面每个机制的『没改坏别的东西』都无法证明。」
 *   那时 23 个公开方法的门面 `MemoryStore` 分属阶段 1~5（DEVELOPMENT-PLAN.md §3.1 方法归位表），
 *   **阶段 0 刻意不实现任何业务机制**。
 * · **阶段 1（P1-T10 起）** 追加导出**门面 `MemoryStore`** 与它那 **10 个方法**用到的公共类型：
 *   `write` / `recall` / `touch` / `get` / `pin` / `unpin` / `link` / `linkByIds` /
 *   `setAlias` / `mergeEntities`。
 *   ⇒ **只导这 10 个**：其余 13 个方法分属阶段 2~5，在各自阶段落地前**不进导出面**
 *   （导出了却没实现 = 空承诺，比不导更糟）。
 *
 * ⚠️ ★ **「只导这 10 个」的准确读法**（P2 收官 · Q-10）：
 *   那句话的**主语是「`MemoryStore` 的那 23 个方法」**——即「**阶段 1 那一批方法**
 *   **只导这 10 个**」。
 *   ⇒ **它不是说「导出面只含阶段 1 的东西」**：
 *   **导出面会随阶段推进逐步加入类型与类**（例如阶段 2 起加入的向量层相关类型、
 *   阶段 3 的共激活形状类型等）⇒ 「导出面的内容」= **截至当前已落地的各阶段的承诺之并集**。
 *   ⇒ 而「**逐阶段推进**」正是本文件存在的意义（§14.3 边界原则 1）
 *   ⇒ **只有一条纪律始终不变**：**导出的每个名字都必须能指到唯一实现**
 *     （「导出了却没实现 = 空承诺，比不导更糟」）。
 *
 * ⚠️ **导出面 ≠ 库的全部能力**（ADR-P1-T07-DEC D-1 / DESIGN-v2.md §4.6 步骤 1）：
 *   导出面**只含 §12 阶段 1 方法清单内的东西**。
 *   ⇒ **便利函数不在其中**：例如 `extractEntityNames()`
 *   （「按上下文匹配库里已知实体名」的便利查询）**刻意没有**进导出面——
 *     阶段 1 **不实现**它（它不在 §12 阶段 1 的方法清单里 ⇒ 实现它会把阶段 1 的范围
 *     扩到清单之外；§4.6 步骤 1 只**留了口子**）。
 *   ⇒ **阶段 1 连实现都没有**：它已从 `src/store/recall.ts` **整体删除**
 *     （**不是**「实现了但不导」——是**根本不存在**）。
 *     ⇒ 若阶段 2 要它，须作为**独立于召回流水线**的辅助 API **新写**，
 *       由调用方**显式调用**（成本 O(#实体 + #别名) 的行扫描，必须写在脸上）。
 *   ⇒ 推论：**任何**便利函数在它所属阶段落地前都**不进导出面**
 *     （阶段 0 的不变量设施与阶段 1 的门面是仅有的两批）。
 *
 * ⇒ §14.3 边界原则 1「每个承诺都要能指到唯一代码路径」：
 *   导出面只承诺「版本常量 + 不变量设施 + 阶段 1 的门面与其依赖的类型」，
 *   这些都能指到唯一实现；
 *   不在此处声明一个「23 个方法齐全、但一个都没实现」的空接口。
 */

export {
  computeStabilityGrowth,
  difficultyBonus,
  spacingFactor,
  type StabilityGrowth,
  type StabilityInput,
} from './core/stability.js';
export {
  CLOCK_EXEMPT_METHODS,
  CLOCK_INJECTION_METHODS,
  resolveNow,
  resolveNowStrictly,
} from './core/clock.js';
export {
  archiveAt,
  edgeWeight,
  effectiveStability,
  intensity,
  layerOf,
  MS_PER_DAY,
  type DecayEdgeInput,
  type DecayMemoryInput,
  type MemoryLayer,
} from './core/decay.js';
export {
  RESOLVE_ENTITY_BY_ALIAS_SQL,
  RESOLVE_ENTITY_BY_NAME_SQL,
  resolveEntity,
  type EntityDatabase,
  type EntityStatement,
} from './core/entities.js';
export {
  findPrimaryNameConflict,
  isSelfLoop,
  mergeEdges,
  missingIds,
  reinforceWeight,
  selectMergeSelfLoops,
  type GraphEdgeInput,
  type MergedEdge,
} from './core/graph.js';
export {
  CONTENT_TEXT_KEY,
  EVENT_PAYLOAD_KEYS,
  EVENT_PAYLOAD_VARIANTS,
  EVENT_TYPES,
  TYPES_ALLOWING_CONTENT_TEXT,
  TOUCH_ALWAYS_KEYS,
  TOUCH_EXPLICIT_ONLY_KEYS,
  isRestoreMergePayload,
  type AliasEventPayload,
  type ActivationWrite,
  type CoactPair,
  type CoactSkipped,
  type ConfigEventPayload,
  type EventPayload,
  type EventType,
  type ForgetEventPayload,
  type LinkEventPayload,
  type ManualFixEventPayload,
  type MergeEventPayload,
  type MergeEventPayload3c,
  type MergeEventPayloadRestoreMerge,
  type PinEventPayload,
  type RecallEventPayload,
  type RestoreEventPayload,
  type SweepEventPayload,
  type SweepItemEventPayload,
  type SweepRebuildBucketsEventPayload,
  type SweepSummaryEventPayload,
  type TouchEventPayload,
  type UnpinEventPayload,
  type WriteEventPayload,
} from './core/events.types.js';
export {
  ERROR_SEMANTICS,
  MemoryError,
  MemoryErrorCode,
  METHODS_RETURNING_NULL,
  METHODS_THROWING_CONFLICT,
  METHODS_THROWING_NOT_FOUND,
  METHODS_THROWING_READONLY_VIOLATION,
  MISSING_IDS_KEY,
  NOT_FOUND_METHODS_WITH_MISSING_IDS,
  translateSqliteError,
  WARNING_ONLY_CASES,
  type ConflictDetails,
  type ErrorSemantic,
  type MemoryErrorDetails,
  type MissingExpression,
} from './core/errors.js';
export {
  BASELINE_FLAGS,
  BOOLEAN_FLAG_KEYS,
  FEATURE_FLAG_SPEC,
  isBaselineConfig,
  resolveFlags,
  resolveVectorBackendState,
  toBaselineParams,
  type BooleanFlagKey,
  type FeatureFlags,
  type VectorBackendFacts,
  type VectorBackendMode,
  type VectorBackendState,
} from './core/flags.js';
export {
  applyParamPatch,
  assertParamsValid,
  COACT_AFFINITY_MAX_DDL_CHECK,
  DEFAULT_PARAMS,
  diffParams,
  PARAM_COUNT,
  PARAM_KEYS,
  validateParams,
  VECTOR_OVERFETCH_FACTOR,
  VECTOR_ROUTER_MODES,
  type ParamChange,
  type ParamKey,
  type ParamPatch,
  type ParamViolation,
  type ParamViolationDetail,
  type ParamViolationDetails,
  type Params,
  type VectorRouterMode,
} from './core/params.js';
export { LIBRARY_VERSION, SCHEMA_VERSION } from './core/version.js';
export {
  allowsContentText,
  EventWriter,
  type EventDatabase,
  type EventStatement,
  type EventWriterOptions,
} from './store/events.js';
// ── 阶段 1（P1-T10）的门面与它那 10 个方法用到的公共类型 ──
// ⚠️ 类型名**全部来自 `src/` 里已有的定义**（先 grep 再导），不自造别名。
export { type MemoryConfig, MemoryStore } from './store/MemoryStore.js';
export type { MergeEntitiesResult } from './store/entities.js';
// ⚠️⚠️ **v2.1（P2 QA 第二轮 ②-1 + P2-T06 发现 1）**：
//   `MemoryMaintainer` 此前是 **type-only 导出** ⇒ 运行时**拿不到这个类**
//   ⇒ ⇒ 宿主**根本调不到「启动对账」**（`reconcileBuckets()`）
//   ⇒ ⇒ 而「启动对账」是 §9.3.2 ③ 的**宿主责任**（库不自动跑：只读实例不能修 §7.1、
//   且每次 open 多一遍全表扫）⇒ 没有宿主可调的入口 ⇒ 这条能力**等于不存在**。
//   ⇒ ⇒ 现在**改成值导出**（**类的运行时值**）⇒ 宿主能 `new MemoryMaintainer(...)` 或
//   从实例拿到它 ⇒ 有了真正的入口。
//   ⇒ ⚠️ **不新增 `MemoryStore` 的公开方法**：§3.1 的方法归位表规定阶段 2 只加
//   `rebuildVectorBuckets` 一个 ⇒ 这里只动**导出面**，不动**门面方法清单**。
export { MemoryMaintainer } from './store/maintain.js';
export type {
  MaintainContext,
  RebuildBucketsOptions,
  RebuildBucketsResult,
  RebuildOnceOutcome,
} from './store/maintain.js';
export type {
  MediaType,
  MemoryKind,
  MemoryView,
} from './store/get.js';
export type { LinkOptions, LinkResult } from './store/link.js';
export { DEFAULT_PIN_FACTOR } from './store/pin.js';
/**
 * ★ `Hit` 是 DESIGN-v2.md §6 的**规范名**；`RecallHit` 是它的**弃用别名**
 *   （**保留是为了不打断已有调用方，不要删**；**新代码一律用 `Hit`**）。
 *
 * ⚠️ **C36（同一件事不得有两套词/两份实现）**：两个都导出，但**规范名必须在公共入口上** ——
 *   否则「弃用的那套」反而成了公共入口上唯一的名字，等于同一件事有两套词**且弃用的那套赢了**。
 */
export type {
  Hit,
  RecallBreakdown,
  RecallDiffused,
  RecallExplain,
  RecallHit,
  RecallOptions,
  RecallResult,
  RecallRouteInfo,
  RecallSuppressed,
} from './store/recall.js';
// ⚠️ `extractEntityNames` **阶段 1 既不实现、也不进导出面**
//   （ADR-P1-T07-DEC D-1 / DESIGN §4.6 步骤 1）：
//   它已从 `src/store/recall.ts` **整体删除** ——
//   ⇒ 在这里「没进导出面」与「这个函数不存在」**是同一件事**（别再写「仍从 recall.ts 导出」）。
export type {
  GrowStabilityOutcome,
  TouchOptions,
  TouchOutcome,
  TouchReason,
} from './store/touch.js';
export type { WriteInput, WriteResult, WriteWarning } from './store/write.js';
// ── 阶段 3（P3-T02 / P3-T03）的门面方法用到的公共类型 ──
// ⚠️ **只导类型，不导实现函数**：`inhibitionTrace` / `recluster` 的**唯一公开入口**
//   是门面 `MemoryStore` 上的那两个方法（§6）⇒ 导出实现函数会变成**第二条公开路径**
//   （同一件事两套词，C36）⇒ 这里只导它们的**入参 / 返回类型**（调用方标注需要）。
export type {
  InhibitionTraceCandidate,
  InhibitionTraceOptions,
  InhibitionTraceResult,
} from './store/inhibition.js';
export type { ReclusterResult } from './store/clusters.js';
// ⚠️ `clusters()` 的返回类型**同样只导类型**（理由同上：唯一公开入口是门面方法）
export type {
  ClustersOptions,
  ClustersResult,
  ClusterSplitInfo,
  ClusterView,
} from './store/clusters.js';
export {
  FileLogger,
  flattenField,
  flattenFields,
  formatLogLine,
  LOG_ACTIONS,
  LOG_QUEUE_MAX_LINES,
  LOG_QUEUE_MAX_MS,
  MemoryLogger,
  type FileLoggerOptions,
  type LogAction,
  type LogFields,
  type LogLevel,
  type Logger,
} from './util/log.js';
