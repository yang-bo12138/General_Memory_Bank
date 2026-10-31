/**
 * 强调与取消强调：`pin(id, factor?)` / `unpin(id)` —— DESIGN-v2.md §4.1 末
 * （「`pin()` / `unpin()` 的完整行为」），对应 DEVELOPMENT-PLAN.md **P1-T09**。
 *
 * ★ **这两个方法不接收 `now`**（§11.1 的豁免清单：`pin` / `unpin`「不写任何时间派生字段」）：
 *   它们只改 `pin_factor` 这一列，`stability` / `last_access` **全程不动**
 *   ⇒ 不引入当前时刻 ⇒ 事件时间戳用真实时钟即可（事件时间戳**不参与任何计算**）。
 *
 * ⚠️ **`pin_factor` 只在算 `intensity` 时相乘，绝不回写 `stability`**（§4.1）：
 *   直接改 `stability` 就**无法撤销**了——这正是用 `pin_factor` 而非直接改 `stability` 的原因。
 *   ⇒ `unpin` 只要把系数复原成 1.0，记忆的历史稳定度增长就**完整保留**。
 *
 * ⚠️ **表里没有 `pinned` 列，也不要加**（§4.1）：
 *   `pin_factor > 1.0` 本身就是「是否被强调」的判据；
 *   另立一个布尔列等于同一件事存两份，两列一旦不同步（例如手工修库）就没有权威答案。
 *
 * ⚠️ **校验在查库之后、写库之前**（§4.1 的步骤顺序）：
 *   先写后校验会留下一条 `factor` 非法的行。
 *
 * ⚠️ **软删的记忆不接受 pin / unpin**：`SELECT ... AND deleted = 0` 查不到 ⇒ 抛 `NOT_FOUND`。
 */

import type Database from 'better-sqlite3';

import { MemoryError, translateSqliteError } from '../core/errors.js';
import type { PinEventPayload, UnpinEventPayload } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import type { EventWriter } from './events.js';

/**
 * `pin()` 的缺省强调倍率（§4.1 的步骤 2：「factor 缺省为 2.0」）。
 *
 * ⚠️ **它不是参数**：`DEFAULT_PARAMS` 的 60 项是**冻结**的（`scripts/check-params.ts` 逐键比对），
 *   §5 的参数表里也**没有**「缺省 pin 系数」这一项 ⇒ 它只能作为**设计稿给定的字面量**存在。
 *   ⇒ 唯一的**上界**（`MAX_PIN_FACTOR`）是参数，从 `store.params` 取。
 */
export const DEFAULT_PIN_FACTOR = 2.0;

/** `pin` / `unpin` 需要的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface PinStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（`MAX_PIN_FACTOR` 是可调项 ⇒ **必传**）。 */
  params: Params;
  /** 事件写入器（`pin` / `unpin` 各自要记一条事件，§8.4）。 */
  events: EventWriter;
}

/**
 * 读出「可被 pin / unpin 的记忆」。
 *
 * ⚠️ **`AND deleted = 0` 是刻意的**（§4.1 步骤 1）：软删的记忆不接受强调。
 */
const SELECT_PINNABLE_MEMORY_SQL =
  'SELECT id, pin_factor FROM memories WHERE id = @id AND deleted = 0';

/**
 * 更新强调系数。
 *
 * ⚠️ **只写 `pin_factor` 一列**：`stability` / `last_access` / `access_count` 全程不动
 *   （§4.1：「绝不同步写 stability」——写了就撤销不回来）。
 */
const UPDATE_PIN_FACTOR_SQL = 'UPDATE memories SET pin_factor = @factor WHERE id = @id';

/** 判断一个错误是否已是本库的错误类型（是则原样抛出，不再转译）。 */
function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError;
}

/**
 * 执行一段强调写入；把 SQLite 原生错误转译成 §11.2 的语义错误。
 *
 * ⚠️ **已经是 `MemoryError` 的原样抛出**：转译器只看 `code`，
 *   把一个 `NOT_FOUND` 再转一次会变成 `CONFLICT` 或 `INVALID_INPUT` ⇒ 语义被覆盖。
 *
 * ⚠️ **更新与事件必须同事务**：`events` 表是「可完整重放」的唯一依据（§9.2）——
 *   系数改了但事件没记（或反之），重放出来的库与实际生效的库不是同一个。
 */
function runPinWrite<T>(db: Database.Database, body: () => T): T {
  try {
    return db.transaction(body)();
  } catch (error) {
    if (isMemoryError(error)) {
      throw error;
    }
    throw translateSqliteError(error);
  }
}

/**
 * 只读实例上拒绝写操作（§7.1：「真正的写操作抛 `MemoryError.READONLY_VIOLATION`，不短路」）。
 *
 * ⚠️ 注意与**事件写入**的差别：事件在只读实例上是**短路**（跳过写入并记一条 warn，
 *   见 `src/store/events.ts`）；而 `pin_factor` 的更新是**真正的写操作** ⇒ 必须抛错。
 */
function assertWritable(store: PinStore, method: 'pin' | 'unpin'): void {
  if (store.events.readonly) {
    throw MemoryError.readonlyViolation(
      `只读实例上不能执行 ${method}（§7.1：真正的写操作一律抛 READONLY_VIOLATION，不短路）`,
      { method },
    );
  }
}

/**
 * 校验 `factor`（§4.1 的校验规则）。
 *
 * ⚠️ **必须是有限数**：`NaN` 与任何数的比较恒为 false ⇒ 只写 `factor < 1.0 || factor > MAX`
 *   的实现会让 `NaN` **穿过校验**（`NaN > 5` 为 false ⇒ 判为合法），
 *   然后落库成 `NaN` ⇒ 有效寿命变成不可计算的值、强度恒为 `NaN`、层级判定恒失真。
 *
 * ⚠️ **必须落在 `[1.0, MAX_PIN_FACTOR]`**：
 *   · 传 0 ⇒ `effectiveStability = 0` ⇒ 除零（强度变 `NaN` / `Infinity`）；
 *   · 传负数 ⇒ 记忆强度随时间长**上升**；
 *   · 传超大值（如 1e9）⇒ 这条记忆实际等于「永生」——
 *     强度永不跌破归档线、每次召回都被捞出并排在最前，而 §4.6 的粗筛对它也永久豁免。
 *     **单条记忆就能污染整个召回结果。**
 *
 * ⚠️ **抛错而不是静默钳制**（§5 的跨参数校验纪律）：
 *   静默钳制会让调用方以为「我传 6 被接受了」⇒ 库里实际是 5 ⇒ 排查时完全看不出发生过替换。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`（`details.factor` 带建议值）
 */
function assertFactorValid(factor: number, params: Params): void {
  if (!Number.isFinite(factor)) {
    throw MemoryError.invalidInput(`pin 的 factor 必须是有限数（收到 ${String(factor)}）`, {
      factor: {
        current: factor,
        reason:
          '必须是有限数：NaN / Infinity 会让有效寿命变成不可计算的值，且 NaN 与任何数的比较恒为 false ⇒ 只判上下界会让它穿过校验',
      },
    });
  }
  if (factor < 1.0 || factor > params.MAX_PIN_FACTOR) {
    throw MemoryError.invalidInput(
      `pin 的 factor 必须落在 [1.0, ${String(params.MAX_PIN_FACTOR)}]（收到 ${String(factor)}）`,
      {
        factor: {
          current: factor,
          minAllowed: 1.0,
          maxAllowed: params.MAX_PIN_FACTOR,
          reason:
            '下界 1.0：传 0 会除零、传负数会让强度随时间上升；上界 MAX_PIN_FACTOR：超大值等价于「永生」，单条记忆就能污染整个召回结果',
        },
      },
    );
  }
}

/**
 * `pin(id, factor?)` —— §4.1 的完整行为。
 *
 * 步骤：
 * 1. `SELECT id, pin_factor FROM memories WHERE id = @id AND deleted = 0`
 *    —— 不存在（含软删）⇒ 抛 `NOT_FOUND`；
 * 2. 校验 `factor`（缺省 2.0）：有限数且落在 `[1.0, MAX_PIN_FACTOR]`
 *    —— **校验在查库之后、写库之前**；
 * 3. `UPDATE memories SET pin_factor = @factor WHERE id = @id`
 *    —— **绝不写 `stability`**；
 * 4. 记 `events(type='pin', payload={ id, factor, prevFactor })`
 *    —— `prevFactor` 记的是**改之前**的值（`pin` 可被连续调用，只看 `factor` 无法还原「原来是多强」）。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器
 * @param id 记忆的业务 uuid
 * @param factor 强调倍率（缺省 2.0）
 * @throws {MemoryError} `NOT_FOUND`（目标不存在或已软删）／`INVALID_INPUT`（`factor` 非法）
 */
export function pin(store: PinStore, id: string, factor: number = DEFAULT_PIN_FACTOR): void {
  assertWritable(store, 'pin');
  const db = store.db;

  runPinWrite(db, () => {
    // ── 步骤 1：查库（软删的记忆不接受 pin）──
    const row = db.prepare(SELECT_PINNABLE_MEMORY_SQL).get({ id }) as
      | { id: string; pin_factor: number }
      | undefined;
    if (row === undefined) {
      throw MemoryError.notFound(`pin 的目标记忆不存在或已被软删（软删的记忆不接受 pin）：${id}`, {
        id,
      });
    }

    // ── 步骤 2：校验（**查库之后、写库之前**）──
    assertFactorValid(factor, store.params);

    // ── 步骤 3：只改 pin_factor ──
    const prevFactor = row.pin_factor;
    db.prepare(UPDATE_PIN_FACTOR_SQL).run({ id, factor });

    // ── 步骤 4：记事件（prevFactor = 改之前的值）──
    const payload: PinEventPayload = { id, factor, prevFactor };
    store.events.appendEvent('pin', id, payload);
  });
}

/**
 * `unpin(id)` —— §4.1 的完整行为。
 *
 * 步骤：
 * 1. `SELECT id, pin_factor FROM memories WHERE id = @id AND deleted = 0`
 *    —— 不存在（含软删）⇒ 抛 `NOT_FOUND`；
 * 2. `prevFactor == 1.0`（本就未强调）⇒ **幂等返回：不写库、不记事件**
 *    （重复 unpin 不该在事件流里堆噪音，§8.4 硬规则 1 的同一条理由）；
 * 3. `UPDATE memories SET pin_factor = 1.0 WHERE id = @id`
 *    —— 复原系数即完成撤销：**`stability` 全程未被触碰，历史增长完整保留**；
 * 4. 记 `events(type='unpin', payload={ id, prevFactor })`
 *    —— **记 `prevFactor` 而不是 `factor`**：unpin 后 factor 恒为 1.0，
 *    记 `factor: 1` 等于没记任何信息；记改前的值才知道「取消的是多强的强调」。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器
 * @param id 记忆的业务 uuid
 * @throws {MemoryError} `NOT_FOUND`（目标不存在或已软删）
 */
export function unpin(store: PinStore, id: string): void {
  assertWritable(store, 'unpin');
  const db = store.db;

  runPinWrite(db, () => {
    // ── 步骤 1：查库（软删的记忆不接受 unpin）──
    const row = db.prepare(SELECT_PINNABLE_MEMORY_SQL).get({ id }) as
      | { id: string; pin_factor: number }
      | undefined;
    if (row === undefined) {
      throw MemoryError.notFound(
        `unpin 的目标记忆不存在或已被软删（软删的记忆不接受 unpin）：${id}`,
        {
          id,
        },
      );
    }

    // ── 步骤 2：幂等（本就没被强调 ⇒ 不写库、不记事件）──
    const prevFactor = row.pin_factor;
    if (prevFactor === 1.0) {
      return;
    }

    // ── 步骤 3：复原系数（**stability 不动**）──
    db.prepare(UPDATE_PIN_FACTOR_SQL).run({ id, factor: 1.0 });

    // ── 步骤 4：记事件（只记改前的值）──
    const payload: UnpinEventPayload = { id, prevFactor };
    store.events.appendEvent('unpin', id, payload);
  });
}
