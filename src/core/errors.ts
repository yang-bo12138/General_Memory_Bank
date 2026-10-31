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

// ─────────────────────────── §11.2 的「缺失的表达方式」契约 ───────────────────────────

/**
 * §11.2「缺失的表达方式对照」——**写接口用异常表达缺失**。
 *
 * ⚠️ 「目标不存在，且方法必须成功才有意义」⇒ 抛 `NOT_FOUND`。
 *   `link` 仅在 `createMissing: false` 时属于这一类。
 */
export const METHODS_THROWING_NOT_FOUND: readonly string[] = [
  'forget',
  'restore',
  'updateContent',
  'pin',
  'unpin',
  'touch',
  'link',
  'linkByIds',
  'setAlias',
  'mergeEntities',
];

/**
 * §11.2「缺失的表达方式对照」——**读接口用返回值表达缺失**。
 *
 * ⚠️ 只有 `get`：单条读取是查看器与调试的高频操作，「查不到」是常态而不是异常；
 *   写成异常会让每次单条读取都得包一层 try-catch。
 */
export const METHODS_RETURNING_NULL: readonly string[] = ['get'];

/**
 * §11.2：抛 `CONFLICT` 的方法（**必须带 `details.conflictingId`**）。
 *
 * 三个来源，全部是「唯一索引挡住的合法意图」：
 * 1. `restore()` 撞 `content_hash` → 传 `mergeInto` 走合并；
 * 2. `updateContent()` 的新正文撞另一条未删记忆 → 应改走 `write()` 或先清理重复项；
 * 3. `setAlias()` 的 alias 撞既有主名 → 需先 `mergeEntities`。
 */
export const METHODS_THROWING_CONFLICT: readonly string[] = [
  'restore',
  'updateContent',
  'setAlias',
];

/**
 * §7.1：只读实例上抛 `READONLY_VIOLATION` 的 **16 个写方法**。
 *
 * ⚠️ 「不要用『等』字省略」——只读拒绝必须**按方法**判定，
 *   而不能靠调用方记得哪些参数算写。漏掉任何一个 = 它在只读实例上会真的写下去。
 */
export const METHODS_THROWING_READONLY_VIOLATION: readonly string[] = [
  'write',
  'touch',
  'link',
  'linkByIds',
  'forget',
  'restore',
  'pin',
  'unpin',
  'setAlias',
  'mergeEntities',
  'updateContent',
  'sweep',
  'setParams',
  'rebuildArchivalSchedule',
  'rebuildVectorBuckets',
  'recluster',
];

/**
 * §11.2 末：**主体工作做成了，但附属产出未生效 ⇒ 不抛错**，走 `write()` 的 `warnings`。
 *
 * ⚠️ `ALIAS_CONFLICT` 刻意不是异常：别名冲突时**记忆本身已经写成功**，
 *   只有附属的别名映射没落库。抛异常会让调用方重试 `write()`，
 *   结果是同一事实被写两遍。
 */
export const WARNING_ONLY_CASES: readonly string[] = ['ALIAS_CONFLICT'];

/**
 * §4.2 / §4.5：`NOT_FOUND` 的 `details` 里承载「**缺失 id 差集**」的键名。
 *
 * ⚠️ §4.2 原文：`touch(ids)` 取回的集合与传入 ids 不等 ⇒ 抛 `NOT_FOUND`，
 *   `details.missingIds` = **差集**（先校验全集，一条都不加固）。
 *   §4.5 原文：`linkByIds` 的任一实体缺失 ⇒ 抛 `NOT_FOUND`（`details.missingIds`）。
 *
 * ⚠️ **阶段 0 只声明这个键名，不实现差集算法**（`touch` 属 P1-T06）。
 *   它在这里的作用是给 P1-T06 留一个**机器可检的锚点**：
 *   `scripts/check-contract-ids.ts` 会断言它被 §11.2 的 `NOT_FOUND` 分组引用，
 *   避免 P1-T06 把键名写成别的、或把它塞进一个**不抛** `NOT_FOUND` 的方法里。
 */
export const MISSING_IDS_KEY = 'missingIds';

/**
 * `details` 里装「缺失的**实体名**」的键名（v2.1 勘误）。
 *
 * ⚠️ **为什么要另起一个键，而不是复用 `missingIds`**：
 *   `missingIds` 的语义是「**行 id** 差集」——§11.2 的 FK 兜底句明写
 *   「本库所有 FK 列都是 **id 引用** ⇒ FK 违规 ⇒ `NOT_FOUND`（带 `details.missingIds`）」。
 *   而 `link` 的端点入参是**实体名**（不是 id）⇒ 把名字塞进 `missingIds`
 *   会让**同一个键在 `touch`/`linkByIds`（装 id）与 `link`（装名字）下表达两件事**
 *   ⇒ 违反 §14.3.1 的 C36（同一件事不得有两套词）。
 *   ⇒ 裁决（ADR-P1-C 冲突 2）：`link` 的端点缺失 ⇒ `details.missingEntityNames`；
 *     `memoryId` 缺失 ⇒ `details.missingIds`（它本来就是记忆 id）。
 *
 * ⚠️ **命名取 `missingEntityNames` 而非 `missingNames`**：与仓库既有词汇一致
 *   （`entityNames` 是 write 事件 payload 的键；`autoCreatedEntities` 是 §4.5 步骤 2 的键）
 *   ⇒ 明确表示「是实体名、不是记忆名」。
 */
export const MISSING_ENTITY_NAMES_KEY = 'missingEntityNames';

/**
 * §11.2 的 `NOT_FOUND` 分组中，`details` **必须**带 `missingIds`（差集）的方法。
 *
 * ⚠️ 这不是「哪些方法会抛 `NOT_FOUND`」的完整名单（那份是 `METHODS_THROWING_NOT_FOUND`），
 *   而是「抛了 `NOT_FOUND` 之后、`details` 里必须额外说明**缺了哪些 id**」的子集。
 *
 * ⚠️ `link` 在此名单内（v2.1 勘误）：它的 `memoryId` 缺失路径带 `details.missingIds`。
 *   ⚠️ **它的端点实体缺失路径带的是 `missingEntityNames`**（不是 `missingIds`）
 *   —— 见 `MISSING_ENTITY_NAMES_KEY` 的说明。
 */
export const NOT_FOUND_METHODS_WITH_MISSING_IDS: readonly string[] = ['touch', 'linkByIds', 'link'];

/** 一个方法在「目标不存在」时的表达方式。 */
export type MissingExpression = 'throw_not_found' | 'return_null' | 'not_applicable';

/** §11.2 的错误语义表（机器可检；`scripts/check-contract-ids.ts` 会与 §11.2 的表比对）。 */
export interface ErrorSemantic {
  /** 方法名。 */
  method: string;
  /** 目标不存在时的表达方式。 */
  missing: MissingExpression;
  /** 备注（§11.2 的原文要点）。 */
  note: string;
}

/**
 * §11.2「缺失的表达方式对照」的**代码化声明**。
 *
 * ⚠️ 这张表是「一眼看完」的机器可读版本：
 *   读接口返回 `null`，写接口抛 `NOT_FOUND`——**边界必须一眼看完**。
 */
export const ERROR_SEMANTICS: readonly ErrorSemantic[] = [
  ...METHODS_THROWING_NOT_FOUND.map(
    (method): ErrorSemantic => ({
      method,
      missing: 'throw_not_found',
      note:
        method === 'link'
          ? 'link({createMissing:false})'
          : '目标不存在，且方法必须成功才有意义 ⇒ 抛 NOT_FOUND',
    }),
  ),
  ...METHODS_RETURNING_NULL.map(
    (method): ErrorSemantic => ({
      method,
      missing: 'return_null',
      note: '目标不存在，但「查不到」是该接口的常态 ⇒ 返回 null（不抛错）',
    }),
  ),
];

// ─────────────────────────── SQLite 错误码的规范化出口 ───────────────────────────

/** better-sqlite3 抛出的错误形状（只取用得上的字段）。 */
export interface SqliteErrorLike {
  code?: string;
  message?: string;
}

/**
 * 把 SQLite 的错误码翻译成库对外的错误类型。
 *
 * ⚠️ **裸的 SQLite 错误码绝不能抛给调用方**（§4.9 步骤 2 并发兜底）：
 * · `SQLITE_CONSTRAINT_UNIQUE` ⇒ `MemoryError.CONFLICT`（**带 `details.conflictingId`**）；
 * · `SQLITE_BUSY` / `SQLITE_LOCKED` ⇒ `MemoryError.DATABASE_BUSY`。
 *
 * · `SQLITE_CONSTRAINT_FOREIGNKEY` ⇒ `MemoryError.NOT_FOUND`：
 *   FK 违规的语义 =「**被引用的行不存在**」⇒ 复用既有的 `NOT_FOUND`，
 *   **不扩码**（扩码是破坏性变更：§11.2 的五个 code 是一个封闭集合）。
 *   ⚠️ 这条是**兜底**，不是主路径：§4.5 步骤 4 要求 `linkByIds` **自己校验实体存在性**，
 *   不能指望外键——外键报错里不带「缺了哪些 id」，
 *   而 `details.missingIds`（差集）必须由**调用方**算出来才能带上（§4.2 / §4.5）。
 *   ⇒ 主路径自己校验（抛 `NOT_FOUND` + `details.missingIds`），本分支只保证「不穿裸错误码」。
 *
 * @param error 捕获到的错误
 * @param details 冲突详情（`CONFLICT` 时必须带 `conflictingId` / `conflictingEntityId`）
 * @returns 规范化后的 `MemoryError`
 */
export function translateSqliteError(
  error: unknown,
  details: MemoryErrorDetails = {},
): MemoryError {
  const candidate = error as SqliteErrorLike | null;
  const code = candidate?.code;

  if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const conflictingId =
      typeof details.conflictingId === 'string' ? details.conflictingId : undefined;
    const conflictingEntityId =
      typeof details.conflictingEntityId === 'string' ? details.conflictingEntityId : undefined;
    const reason =
      conflictingId === undefined && conflictingEntityId === undefined
        ? 'conflictingId 缺失：调用方必须先查出冲突对象再转译（§11.2：否则调用方无法决定下一步）'
        : undefined;
    return new MemoryError(
      MemoryErrorCode.CONFLICT,
      '唯一性冲突：目标已存在（§4.8.1 / §4.9.1 / §4.9.2 的三个来源）',
      reason === undefined
        ? { ...details, conflictingId, conflictingEntityId }
        : { ...details, reason },
    );
  }

  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    // FK 违规 =「被引用的行不存在」⇒ NOT_FOUND（复用，不扩码）
    return new MemoryError(
      MemoryErrorCode.NOT_FOUND,
      '外键约束失败：被引用的行不存在（§4.5 步骤 4：linkByIds 必须自己校验实体存在性，不能指望外键）',
      details,
    );
  }

  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return new MemoryError(
      MemoryErrorCode.DATABASE_BUSY,
      '并发等待超时（§9.1 的 busy_timeout = 5000）',
      details,
    );
  }

  // ⚠️ 不在 §11.2 五个 code 之内的错误：**原样抛出**。
  //   把未知错误硬塞进某个 code 只会让调用方拿到一个**语义错误**的 code，
  //   比「未类型化的错误」更难排查。
  throw error;
}
