/**
 * 撤销遗忘 —— `restore(id, options?)`，DESIGN-v2.md §4.8.1，对应 DEVELOPMENT-PLAN.md **P4-T02**。
 *
 * ⚠️ **默认路径不删任何东西**（§14.3 边界原则 3 的三处物理删除点之一，也是最容易被漏掉的一处）：
 *   撞 `content_hash` 时**抛 `CONFLICT`**，让调用方决定；
 *   只有调用方**显式**传 `mergeInto` 才走「合并」分支 ⇒ 那一支会**删掉待恢复行**。
 *
 * ⚠️ **为什么不自动合并**（§4.8.1 的原文理由）：两条同 hash 记录**必有一方的正文被淘汰**
 *   ⇒ 用户点的是「恢复」，结果却少了一条 ⇒ 这类「操作意图与实际结果不符」的 bug
 *   **最难被用户描述清楚**。
 *
 * ⚠️ **合并分支刻意不走 forget 的脱敏流程**：
 *   合并后正文由目标记忆承载 ⇒ 历史事件保留原文即构成「**可审计的合并痕迹**」；
 *   若在此脱敏，反而抹掉了「这条记忆曾被单独记过」这一事实。
 *   ⇒ 这也是「同一条库里有三处物理删除点，但可回滚口径各不相同」的原因：
 *     `restore_merge` 的语义是「**数据不丢（已并入目标），但那一行本身不可复原**」。
 *
 * ⚠️ **合并事件的 payload 刻意少六项**（`intervalDays` / `boostApplied` / `contentText` /
 *   `contentLength` / `contentHash` / `prevContentLength`，§8.4 的 `restore_merge` 子集）：
 *   本路径不调 `growStability`、不改写任何正文 ⇒ 硬填 `0`/`false` 等于**伪造一条
 *   「发生过间隔重复」的假记录**，重放会据此算错衰减。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import type { MergeEventPayloadRestoreMerge, RestoreEventPayload } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

/** `restore` 需要的上下文。 */
export interface RestoreStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（本方法当前不读参数，保留字段以与其它 store 同构）。 */
  params: Params;
  /** 事件写入器。 */
  events: EventWriter;
}

/** `restore()` 的选项（§6）。 */
export interface RestoreOptions {
  /**
   * 撞 hash 时把待恢复行**合并进哪一条**（必须是那个冲突对象的 id）。
   *
   * ⚠️ 不传 ⇒ 抛 `CONFLICT`（让调用方决定，库不替用户猜）。
   */
  mergeInto?: string;
}

/** 读待恢复行的状态 + hash。 */
const SELECT_RESTORE_TARGET_SQL =
  'SELECT id, deleted, content_hash AS contentHash FROM memories WHERE id = @id';

/** 找「同 hash 且未删」的另一条（冲突对象）。 */
const SELECT_CONFLICTING_SQL = `SELECT id FROM memories
   WHERE content_hash = @hash AND deleted = 0 AND id <> @id`;

/** 撤销软删。 */
const UNDELETE_SQL = 'UPDATE memories SET deleted = 0, deleted_at = NULL WHERE id = @id';

/** 差集：源有、目标没有的实体关联（★ **必须在插入之前算**）。 */
const SELECT_ENTITY_DIFF_SQL = `SELECT entity_id FROM memory_entities WHERE memory_id = @source
   EXCEPT
   SELECT entity_id FROM memory_entities WHERE memory_id = @target`;

/** 把差集补进目标。 */
const INSERT_ENTITY_LINK_SQL =
  'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (@target, @entity)';

/** 正文历史迁到目标名下。 */
const MOVE_CONTENT_HISTORY_SQL =
  'UPDATE content_history SET memory_id = @target WHERE memory_id = @source';

/** 边改指向目标（避免边失去证据）。 */
const MOVE_EDGES_SQL = 'UPDATE edges SET memory_id = @target WHERE memory_id = @source';

/** 硬删待恢复行（触发器同步 FTS，FK 级联清理残留关联）。 */
const DELETE_SOURCE_SQL = 'DELETE FROM memories WHERE id = @id';

/**
 * 只读实例上拒绝写操作（§7.1）。
 */
function assertWritable(store: RestoreStore): void {
  if (store.events.readonly) {
    throw MemoryError.readonlyViolation(
      '只读实例上不能执行 restore（§7.1：真正的写操作一律抛 READONLY_VIOLATION，不短路）',
      { method: 'restore' },
    );
  }
}

/**
 * `restore(id, options?)` —— §4.8.1 的撤销与冲突处理。
 *
 * 步骤：
 * 1. 查行：不存在（已被硬删）⇒ `NOT_FOUND`；`deleted = 0` ⇒ **幂等返回**（不写事件）；
 * 2. 查冲突：`content_hash` 相同且未删的另一条；
 * 3. 无冲突 ⇒ 撤销软删 + 记 `restore` 事件；
 * 4. 有冲突且未传 `mergeInto` ⇒ 抛 `CONFLICT`（`details.conflictingId`）；
 * 5. 有冲突且 `mergeInto === conflictingId` ⇒ 合并（差集 → 历史 → 边 → 删源行 → 记 `merge` 事件）。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器
 * @param id 记忆的业务 uuid
 * @param options `mergeInto`
 * @param now 注入时钟（事件时间戳，C37）
 * @throws {MemoryError} `NOT_FOUND` / `CONFLICT` / `INVALID_INPUT`（`mergeInto` 指错对象）／`READONLY_VIOLATION`
 */
export function restore(
  store: RestoreStore,
  id: string,
  options: RestoreOptions = {},
  now?: number,
): void {
  assertWritable(store);
  const at = resolveNow(now);
  const db = store.db;

  runWriteTransaction(db, () => {
    const row = db.prepare(SELECT_RESTORE_TARGET_SQL).get({ id }) as
      | { id: string; deleted: number; contentHash: string }
      | undefined;
    if (row === undefined) {
      throw MemoryError.notFound(`restore 的目标记忆不存在（已被硬删，不可恢复）：${id}`, { id });
    }

    // ⚠️ **幂等：本来就没删 ⇒ 直接返回**（不写库、不记事件，避免事件流里的假「恢复」记录）
    if (row.deleted === 0) {
      return;
    }

    const conflicting = db.prepare(SELECT_CONFLICTING_SQL).get({
      hash: row.contentHash,
      id,
    }) as { id: string } | undefined;

    // ── 无冲突：普通撤销 ──
    if (conflicting === undefined) {
      db.prepare(UNDELETE_SQL).run({ id });
      const payload: RestoreEventPayload = { id };
      store.events.appendEvent('restore', id, payload, at);
      return;
    }

    // ── 有冲突：库不替用户猜 ──
    if (options.mergeInto === undefined) {
      throw MemoryError.conflict(
        `restore 撞上同 hash 的未删记忆（${conflicting.id}）：请显式传 mergeInto 决定合并目标，或先清理重复项`,
        { conflictingId: conflicting.id },
      );
    }
    if (options.mergeInto !== conflicting.id) {
      throw MemoryError.invalidInput(
        `restore 的 mergeInto（${options.mergeInto}）必须是那个冲突对象（${conflicting.id}）`,
        {
          mergeInto: {
            current: options.mergeInto,
            reason: `only ${conflicting.id} shares the same content_hash`,
          },
        },
      );
    }

    // ── 合并分支：顺序不能反 ──
    // a. **先算差集再插入**（先插再算 ⇒ 交集已并进去 ⇒ 差集恒为空）
    const addedEntities: string[] = [];
    const diffRows = db
      .prepare(SELECT_ENTITY_DIFF_SQL)
      .all({ source: id, target: conflicting.id }) as Array<{ entity_id: string }>;
    for (const entityRow of diffRows) {
      db.prepare(INSERT_ENTITY_LINK_SQL).run({
        target: conflicting.id,
        entity: entityRow.entity_id,
      });
      addedEntities.push(entityRow.entity_id);
    }

    // b. 正文历史迁到目标名下
    db.prepare(MOVE_CONTENT_HISTORY_SQL).run({ source: id, target: conflicting.id });
    // c. 边改指向目标（避免边失去证据）
    db.prepare(MOVE_EDGES_SQL).run({ source: id, target: conflicting.id });
    // d. 硬删待恢复行（**不走脱敏**：合并后正文由目标承载，历史事件是审计痕迹）
    db.prepare(DELETE_SOURCE_SQL).run({ id });
    // e. 记 merge 事件（restore_merge 子集：刻意不含 stability / 正文四项）
    const payload: MergeEventPayloadRestoreMerge = {
      targetId: conflicting.id,
      addedEntities,
      mergedFrom: id,
      reason: 'restore_merge',
    };
    store.events.appendEvent('merge', conflicting.id, payload, at);
  });
}
