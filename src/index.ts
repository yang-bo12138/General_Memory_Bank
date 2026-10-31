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
 * ⚠️ **导出面 ≠ 库的全部能力**（ADR-P1-T07-DEC D-1 / DESIGN-v2.md §4.6 步骤 1）：
 *   导出面**只含 §12 阶段 1 方法清单内的东西**。
 *   ⇒ **便利函数不在其中**：例如 `extractEntityNames()`
 *   （「按上下文匹配库里已知实体名」的便利查询）**刻意没有**进导出面——
 *     阶段 1 **不实现**它（它不在 §12 阶段 1 的方法清单里 ⇒ 实现它会把阶段 1 的范围
 *     扩到清单之外；§4.6 步骤 1 只**留了口子**）。
 *   ⇒ 它仍然**从 `src/store/recall.ts` 独立导出**（阶段 2 的向量路/实体名入口会用上它），
 *     只是**公开入口不导它** ⇒ 「没进导出面」与「这个函数不存在」是**两件事**。
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
export type {
  MediaType,
  MemoryKind,
  MemoryView,
} from './store/get.js';
export type { LinkOptions, LinkResult } from './store/link.js';
export { DEFAULT_PIN_FACTOR } from './store/pin.js';
export type {
  RecallBreakdown,
  RecallDiffused,
  RecallExplain,
  RecallHit,
  RecallOptions,
  RecallResult,
  RecallRouteInfo,
  RecallSuppressed,
} from './store/recall.js';
// ⚠️ `extractEntityNames` **刻意不在导出面**（ADR-P1-T07-DEC D-1 / DESIGN §4.6 步骤 1）：
//   阶段 1 **不实现**它（它不在 §12 阶段 1 的方法清单里）⇒ 它**仍从
//   `src/store/recall.ts` 独立导出**（阶段 2 会用），只是**公开入口不导它**。
export type {
  GrowStabilityOutcome,
  TouchOptions,
  TouchOutcome,
  TouchReason,
} from './store/touch.js';
export type { WriteInput, WriteResult, WriteWarning } from './store/write.js';
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
