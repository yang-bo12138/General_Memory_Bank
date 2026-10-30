/**
 * `memory-ocean` —— 通用记忆库 v2.1（记忆海版）公共导出入口。
 *
 * ⚠️ **阶段 0（P0-T01~T06）的导出面刻意很小**：
 * DESIGN-v2.md §12 阶段 0 原文——「本阶段**不实现任何新机制**，只建开关与不变量测试。
 * 没有这个阶段，后面每个机制的『没改坏别的东西』都无法证明。」
 *
 * ⇒ 本阶段只导出**不变量设施**（参数表 / 机制开关 / 事件流 / 错误类型 / 时钟契约），
 *   23 个公开方法的门面 `MemoryStore` 分属阶段 1~5（DEVELOPMENT-PLAN.md §3.1 方法归位表），
 *   **本阶段刻意不实现任何业务机制**。
 *
 * ⇒ §14.3 边界原则 1「每个承诺都要能指到唯一代码路径」：
 *   阶段 0 只承诺「版本常量 + 阶段 0 的不变量设施」，这些都能指到唯一实现；
 *   不在此处声明一个「23 个方法齐全、但一个都没实现」的空接口。
 */

export {
  CLOCK_EXEMPT_METHODS,
  CLOCK_INJECTION_METHODS,
  resolveNow,
  resolveNowStrictly,
} from './core/clock.js';
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
  type Params,
  type ParamViolation,
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
