/**
 * 遗忘 —— `forget(id, options?, now?)`，DESIGN-v2.md §4.8，对应 DEVELOPMENT-PLAN.md **P4-T02**。
 *
 * 两种删法，语义完全不同：
 *
 * | | 软删（默认） | 硬删（`hard: true`） |
 * |---|---|---|
 * | `memories` 行 | 保留，`deleted = 1` | **删除** |
 * | 正文 / 向量 / 历史 | **全部保留** | 行没了 ⇒ FK 级联清理 |
 * | 事件里的正文 | 保留 | **脱敏成占位串**（兑现「遗忘」承诺） |
 * | 可撤销 | ✅ `restore()` | ❌ |
 *
 * ⚠️ **软删是幂等的，且不重写 `deleted_at`**（§4.8）：
 *   `deleted_at` 是 `sweep` 清理倒计时的**起点** ⇒ 用户反复点「忘掉」就会把倒计时一直往后推，
 *   结果是**永远清不掉**。⇒ 已软删再软删 ⇒ 直接返回（不写库、不记事件）。
 *
 * ⚠️ **硬删的三步必须同一事务**（删行 + 脱敏 + 记事件）：
 *   拆开会出现「行删了但事件没脱敏」的窗口，而那个窗口里的状态**没有任何自愈路径**。
 *
 * ⚠️ **不要手动 `DELETE FROM mem_fts`**（§4.8 常见坑）：`mem_fts` 是 FTS5 的 **external content** 表，
 *   它由触发器 `mem_ad` 跟随 `memories` 的删除自动同步；
 *   手动 DELETE 要么报错、要么把索引与主表弄成不一致（而 rank 会静默变差）。
 *
 * ⚠️ **`edges.memory_id` 是 `ON DELETE SET NULL`**：边本身**保留**（§3 的口径：
 *   「关系比单条证据更长寿」）—— 删掉记忆不等于「这两个实体之间没有关系了」。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import type { ForgetEventPayload } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import type { EventWriter } from './events.js';
import { redactEventContentText } from './redact.js';
import { runWriteTransaction } from './transaction.js';

/** `forget` 需要的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface ForgetStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（本方法当前不读参数，保留字段以与其它 store 同构）。 */
  params: Params;
  /** 事件写入器（`forget` 要记一条事件，§8.4）。 */
  events: EventWriter;
}

/** `forget()` 的选项（§6）。 */
export interface ForgetOptions {
  /** 硬删？（缺省 `false` = 软删） */
  hard?: boolean;
  /**
   * 硬删时**保留**事件里的正文（供审计）？
   *
   * ⚠️ 缺省 `false` = 脱敏。设为 `true` 意味着**放弃「遗忘」承诺**中「原文不再可读」那一半
   *   ⇒ 只应在「确有合规要求的审计留档」场景使用，且必须由调用方显式选择。
   */
  keepAuditContent?: boolean;
}

/** 查记忆是否存在的 SQL（**不筛 `deleted`**：软删的行也要能再次 `forget`，走幂等）。 */
const SELECT_MEMORY_STATE_SQL = 'SELECT deleted FROM memories WHERE id = @id';

/** 软删：只改两个状态列（正文 / 向量 / 历史一律不动，§4.8）。 */
const SOFT_DELETE_SQL = 'UPDATE memories SET deleted = 1, deleted_at = @at WHERE id = @id';

/** 硬删：删行（`mem_fts` 由触发器同步；`memory_entities` / `content_history` 由 FK 级联）。 */
const HARD_DELETE_SQL = 'DELETE FROM memories WHERE id = @id';

/**
 * 只读实例上拒绝写操作（§7.1：真正的写操作抛 `READONLY_VIOLATION`，**不短路**）。
 *
 * ⚠️ 与事件写入的差别：事件在只读实例上短路（`EventWriter.appendEvent` 内部处理），
 *   而 `forget` 本身是写操作 ⇒ 必须在**入口**就抛出，不能等写到一半才由 SQLite 报只读。
 */
function assertWritable(store: ForgetStore): void {
  if (store.events.readonly) {
    throw MemoryError.readonlyViolation(
      '只读实例上不能执行 forget（§7.1：真正的写操作一律抛 READONLY_VIOLATION，不短路）',
      { method: 'forget' },
    );
  }
}

/**
 * `forget(id, options?, now?)` —— §4.8 的软删 / 硬删。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器
 * @param id 记忆的业务 uuid
 * @param options `hard` / `keepAuditContent`
 * @param now 注入时钟（`deleted_at` 与事件时间戳，C37）
 * @throws {MemoryError} `NOT_FOUND`（不存在或已被硬删）／`READONLY_VIOLATION`（只读实例）
 */
export function forget(
  store: ForgetStore,
  id: string,
  options: ForgetOptions = {},
  now?: number,
): void {
  assertWritable(store);
  const hard = options.hard === true;
  const keepAuditContent = options.keepAuditContent === true;
  const at = resolveNow(now);
  const db = store.db;

  runWriteTransaction(db, () => {
    // ── 前置校验：不存在（含已被硬删）⇒ NOT_FOUND，且**不做任何写入** ──
    const row = db.prepare(SELECT_MEMORY_STATE_SQL).get({ id }) as { deleted: number } | undefined;
    if (row === undefined) {
      throw MemoryError.notFound(`forget 的目标记忆不存在（或已被硬删）：${id}`, { id });
    }

    // ── 软删（默认路径）──
    if (!hard) {
      // ⚠️ **幂等：已软删 ⇒ 不重写 deleted_at、不记事件**
      //   （重写会把 sweep 的清理倒计时往后推 ⇒ 用户反复点「忘掉」= 永远清不掉）
      if (row.deleted === 1) {
        return;
      }
      db.prepare(SOFT_DELETE_SQL).run({ id, at });
      // ⚠️ **软删不处置任何正文** ⇒ payload **不带** `auditContentRetained`
      //   （该字段只在 `hard: true` 时有意义；软删带它 = 记了一条没发生的事）
      const softPayload: ForgetEventPayload = { id, hard: false };
      store.events.appendEvent('forget', id, softPayload, at);
      return;
    }

    // ── 硬删：三步同一事务 ──
    // ① 删行（FTS 由触发器同步；关联表由 FK 级联；edges.memory_id 置 NULL）
    db.prepare(HARD_DELETE_SQL).run({ id });
    // ② 脱敏（**唯一一份实现**在 redact.ts）——`keepAuditContent` 是唯一豁免
    if (!keepAuditContent) {
      redactEventContentText(db, id);
    }
    // ③ 记事件（此时该记忆的行已不存在，但 `events.memory_id` 刻意无外键 ⇒ 事件比记忆活得久）
    const hardPayload: ForgetEventPayload = {
      id,
      hard: true,
      auditContentRetained: keepAuditContent,
    };
    store.events.appendEvent('forget', id, hardPayload, at);
  });
}
