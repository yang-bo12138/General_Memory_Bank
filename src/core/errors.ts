/**
 * 统一错误类型体系 —— DESIGN-v2.md §11.2。
 *
 * §11.2 的核心纪律有三条，本文件逐条落地：
 *
 * 1. **「缺失」的表达方式必须一眼看完**（读接口用返回值、写接口用异常）：
 *    · 写接口（目标必须存在才成功）⇒ 抛 `NOT_FOUND`
 *    · 读接口（查不到是常态）⇒ **返回 `null`**（只有 `get`）
 * 2. **`CONFLICT` 必须带 `details.conflictingId`**（或 `details.conflictingEntityId`），
 *    否则调用方无法决定下一步（三个来源：`restore` 撞 hash / `updateContent` 撞 hash /
 *    `setAlias` 撞主名）。
 * 3. **裸的 SQLite 错误码绝不能抛给调用方**（§4.9 步骤 2 并发兜底）：
 *    `SQLITE_CONSTRAINT_UNIQUE` 必须被捕获并转成 `MemoryError.CONFLICT`。
 *
 * ⚠️ **`ALIAS_CONFLICT` 刻意不是异常**，而是 `write()` 返回值的 `warnings`（§11.2 末）：
 * 别名冲突时**记忆本身已经写成功**，只有附属的别名映射没落库；
 * 抛异常会让调用方重试 `write()`，结果是同一事实被写两遍。
 */

/** 五个错误码（§11.2）。 */
export const MemoryErrorCode = {
  /** 在只读实例执行写操作。 */
  READONLY_VIOLATION: 'READONLY_VIOLATION',
  /** 目标记忆或实体不存在。 */
  NOT_FOUND: 'NOT_FOUND',
  /** 输入参数未通过校验。 */
  INVALID_INPUT: 'INVALID_INPUT',
  /** 唯一性冲突（必须带 `details.conflictingId` / `details.conflictingEntityId`）。 */
  CONFLICT: 'CONFLICT',
  /** 并发等待超时。 */
  DATABASE_BUSY: 'DATABASE_BUSY',
} as const;

/** 五个错误码的联合类型。 */
export type MemoryErrorCode = (typeof MemoryErrorCode)[keyof typeof MemoryErrorCode];

/** 错误附带的结构化详情（`details`）。 */
export type MemoryErrorDetails = Record<string, unknown>;

/**
 * `CONFLICT` 的详情：**类型层面强制**至少带一个冲突标识。
 *
 * ⚠️ §11.2 原文：「错误对象必须携带 `details.conflictingId`（或 `details.conflictingEntityId`），
 * 否则调用方无法决定下一步。」
 * ⇒ 用联合类型把它变成编译期约束，而不是一句注释。
 */
export type ConflictDetails =
  | { conflictingId: string; conflictingEntityId?: string }
  | { conflictingEntityId: string; conflictingId?: string };

/**
 * 库对外抛出的唯一错误类型。
 *
 * ⚠️ 客户端**只应**看到本类（一个规范化的错误结构），
 * 裸的 SQLite 错误码不得穿到调用方（§4.9 步骤 2）。
 */
export class MemoryError extends Error {
  /** 五个错误码常量（便于 `MemoryError.NOT_FOUND` 直接引用）。 */
  static readonly READONLY_VIOLATION = MemoryErrorCode.READONLY_VIOLATION;
  static readonly NOT_FOUND = MemoryErrorCode.NOT_FOUND;
  static readonly INVALID_INPUT = MemoryErrorCode.INVALID_INPUT;
  static readonly CONFLICT = MemoryErrorCode.CONFLICT;
  static readonly DATABASE_BUSY = MemoryErrorCode.DATABASE_BUSY;

  /** 错误码（五选一）。 */
  readonly code: MemoryErrorCode;

  /** 结构化详情；内容随 `code` 而异（见 §11.2）。 */
  readonly details: MemoryErrorDetails;

  constructor(code: MemoryErrorCode, message: string, details: MemoryErrorDetails = {}) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.details = details;
    // ⚠️ 继承内置 Error 时必须显式修复原型链，否则 `instanceof` 在编译目标为 ES5 时会失效。
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** 只读实例上执行写操作（§7.1：真正的写操作抛错，不短路）。 */
  static readonly readonlyViolation = (
    message: string,
    details: MemoryErrorDetails = {},
  ): MemoryError => new MemoryError(MemoryErrorCode.READONLY_VIOLATION, message, details);

  /** 目标不存在（写接口专用；读接口 `get` 返回 `null`，不抛）。 */
  static readonly notFound = (message: string, details: MemoryErrorDetails = {}): MemoryError =>
    new MemoryError(MemoryErrorCode.NOT_FOUND, message, details);

  /** 输入非法；`details` 建议带上**建议值**（§5：给出建议值省掉调用方自己算）。 */
  static readonly invalidInput = (message: string, details: MemoryErrorDetails = {}): MemoryError =>
    new MemoryError(MemoryErrorCode.INVALID_INPUT, message, details);

  /** 唯一性冲突；`details` 必须带 `conflictingId` 或 `conflictingEntityId`。 */
  static readonly conflict = (message: string, details: ConflictDetails): MemoryError =>
    new MemoryError(MemoryErrorCode.CONFLICT, message, details);

  /** 并发等待超时（`SQLITE_BUSY` 的规范化出口）。 */
  static readonly databaseBusy = (message: string, details: MemoryErrorDetails = {}): MemoryError =>
    new MemoryError(MemoryErrorCode.DATABASE_BUSY, message, details);
}
