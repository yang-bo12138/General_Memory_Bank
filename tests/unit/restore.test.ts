/**
 * `restore()` 的单测 —— DESIGN-v2.md §4.8.1（撤销与冲突处理），对应 **P4-T02**。
 *
 * ★ 本文件重点守三件容易做错的事：
 *   ① **默认路径不删任何东西**：撞 hash 不传 `mergeInto` ⇒ 抛 `CONFLICT`，库内状态**一位不变**；
 *   ② **合并分支的差集必须先算后插**（先插再算 ⇒ 交集已并进去 ⇒ 差集恒为空 ⇒ `addedEntities` 恒 `[]`）；
 *   ③ **合并事件可以没有那六项**（`intervalDays` / `boostApplied` / 正文四项）
 *      —— 它们不是「0」而是「不存在」，硬填就是伪造一条间隔重复记录。
 */

import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { EventWriter } from '../../src/store/events.js';
import { type RestoreStore, restore } from '../../src/store/restore.js';
import { MemoryLogger } from '../../src/util/log.js';

const P: Params = DEFAULT_PARAMS;
const T0 = 1_700_000_000_000;
const NOW = T0 + 86_400_000;

interface Fixture {
  db: Database.Database;
  store: RestoreStore;
  sourceId: string;
  targetId: string;
}

/** 插一条记忆（可指定 hash / deleted）。 */
function insertMemory(
  db: Database.Database,
  seed: { id: string; hash: string; deleted?: boolean; content?: string },
): void {
  const deleted = seed.deleted === true;
  db.prepare(
    `INSERT INTO memories (
       id, kind, content, content_tokens, content_hash, stability, difficulty, pin_factor,
       created_at, last_access, access_count, deleted, deleted_at
     ) VALUES (
       @id, 'fact', @content, @tokens, @hash, 2.0, 0.5, 1.0, @t0, @t0, 0, @deleted, @deletedAt
     )`,
  ).run({
    id: seed.id,
    content: seed.content ?? `内容 ${seed.id}`,
    tokens: '内容',
    hash: seed.hash,
    t0: T0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? T0 : null,
  });
}

/**
 * 建库：
 * · `m1`（软删，hash = H）—— 待恢复的源；
 * · `m2`（未删，hash = H）—— 冲突对象（默认场景）。
 */
function makeStore(
  seed: { conflicting?: boolean; sourceDeleted?: boolean; readonly?: boolean } = {},
): Fixture {
  const conflicting = seed.conflicting !== false;
  const sourceDeleted = seed.sourceDeleted !== false;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  insertMemory(db, { id: 'm1', hash: 'H', deleted: sourceDeleted, content: '正文 v1' });
  if (conflicting) {
    insertMemory(db, { id: 'm2', hash: 'H', content: '正文 v2' });
  }

  // 源独有的实体 e1；两边共有的 e2
  db.prepare(
    `INSERT INTO entities (id, name, type, created_at) VALUES ('e1', '甲', 'person', @t0)`,
  ).run({ t0: T0 });
  db.prepare(
    `INSERT INTO entities (id, name, type, created_at) VALUES ('e2', '乙', 'person', @t0)`,
  ).run({ t0: T0 });
  db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES ('m1', 'e1')`).run();
  db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES ('m1', 'e2')`).run();
  // ⚠️ 目标行只有「有冲突」时才存在 ⇒ 它的关联也必须条件插入（否则 FK 直接不通过）
  if (conflicting) {
    db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES ('m2', 'e2')`).run();
  }

  // 源名下的一条正文历史 + 一条指向源的边
  db.prepare(
    `INSERT INTO content_history (memory_id, content, content_tokens, reason, replaced_at)
     VALUES ('m1', '正文 v0', '正文', 'merge', @t0)`,
  ).run({ t0: T0 });
  db.prepare(
    `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
     VALUES ('edge1', 'e1', '认识', 'e2', 'm1', 0.8, @t0, @t0)`,
  ).run({ t0: T0 });

  const events = new EventWriter(db, {
    readonly: seed.readonly === true,
    logger: new MemoryLogger(),
    now: () => NOW,
  });
  return { db, store: { db, params: P, events }, sourceId: 'm1', targetId: 'm2' };
}

/** 读出记忆状态（行不存在返回 undefined）。 */
function readState(
  db: Database.Database,
  id: string,
): { deleted: number; deletedAt: number | null } | undefined {
  return db.prepare('SELECT deleted, deleted_at AS deletedAt FROM memories WHERE id = ?').get(id) as
    | { deleted: number; deletedAt: number | null }
    | undefined;
}

/** 读出全部事件的 (type, payload)。 */
function readEvents(
  db: Database.Database,
): Array<{ type: string; payload: Record<string, unknown> }> {
  return (
    db.prepare('SELECT type, payload FROM events ORDER BY id').all() as Array<{
      type: string;
      payload: string;
    }>
  ).map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

describe('restore · 无冲突', () => {
  it('撤销软删：deleted=0 / deleted_at=NULL，并记一条 `restore` 事件', () => {
    const { db, store, sourceId } = makeStore({ conflicting: false });
    try {
      restore(store, sourceId, {}, NOW);
      expect(readState(db, sourceId)).toEqual({ deleted: 0, deletedAt: null });
      const restoreEvents = readEvents(db).filter((event) => event.type === 'restore');
      expect(restoreEvents).toHaveLength(1);
      expect(restoreEvents[0]?.payload).toEqual({ id: sourceId });
    } finally {
      db.close();
    }
  });

  it('★ 幂等：本来就没删 ⇒ 直接返回，**不写事件**', () => {
    const { db, store, sourceId } = makeStore({ conflicting: false, sourceDeleted: false });
    try {
      restore(store, sourceId, {}, NOW);
      expect(readState(db, sourceId)).toEqual({ deleted: 0, deletedAt: null });
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('已被硬删 ⇒ NOT_FOUND', () => {
    const { db, store } = makeStore({ conflicting: false });
    try {
      db.prepare(`DELETE FROM memories WHERE id = 'm1'`).run();
      let caught: MemoryError | undefined;
      try {
        restore(store, 'm1', {}, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.NOT_FOUND);
    } finally {
      db.close();
    }
  });

  it('只读实例 ⇒ READONLY_VIOLATION', () => {
    const { db, store, sourceId } = makeStore({ conflicting: false, readonly: true });
    try {
      let caught: MemoryError | undefined;
      try {
        restore(store, sourceId, {}, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.READONLY_VIOLATION);
      expect(readState(db, sourceId)?.deleted).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('restore · 冲突（默认路径绝不删东西）', () => {
  it('★ 有冲突且不传 mergeInto ⇒ CONFLICT（带 conflictingId），**库内状态一位不变**', () => {
    const { db, store, sourceId, targetId } = makeStore();
    try {
      const before = db.prepare('SELECT count(*) AS n FROM memories').get();
      let caught: MemoryError | undefined;
      try {
        restore(store, sourceId, {}, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.CONFLICT);
      expect(caught?.details.conflictingId).toBe(targetId);
      // ★ 状态未变：源仍是软删、目标仍在、事件一条没写
      expect(readState(db, sourceId)?.deleted).toBe(1);
      expect(readState(db, targetId)?.deleted).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual(before);
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('mergeInto 指错对象 ⇒ INVALID_INPUT（不是默默合并到别处）', () => {
    const { db, store, sourceId } = makeStore();
    try {
      db.prepare(
        `INSERT INTO entities (id, name, type, created_at) VALUES ('x', 'x', 'thing', @t0)`,
      ).run({
        t0: T0,
      });
      insertMemory(db, { id: 'm3', hash: 'other' });
      let caught: MemoryError | undefined;
      try {
        restore(store, sourceId, { mergeInto: 'm3' }, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.INVALID_INPUT);
      expect(readState(db, sourceId)?.deleted).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('restore · 合并分支', () => {
  it('★ 差集先算后插：只把源独有的实体并入目标，`addedEntities` 非空', () => {
    const { db, store, sourceId, targetId } = makeStore();
    try {
      restore(store, sourceId, { mergeInto: targetId }, NOW);

      const targetEntities = (
        db
          .prepare('SELECT entity_id FROM memory_entities WHERE memory_id = ? ORDER BY entity_id')
          .all(targetId) as Array<{
          entity_id: string;
        }>
      ).map((row) => row.entity_id);
      // 目标原有 e2；源独有 e1 被并入
      expect(targetEntities).toEqual(['e1', 'e2']);

      const mergeEvents = readEvents(db).filter((event) => event.type === 'merge');
      expect(mergeEvents).toHaveLength(1);
      expect(mergeEvents[0]?.payload.addedEntities).toEqual(['e1']);
    } finally {
      db.close();
    }
  });

  it('★ 正文历史与边都并入目标；源行被删（**不走脱敏**）', () => {
    const { db, store, sourceId, targetId } = makeStore();
    try {
      restore(store, sourceId, { mergeInto: targetId }, NOW);

      expect(db.prepare('SELECT count(*) AS n FROM memories WHERE id = ?').get(sourceId)).toEqual({
        n: 0,
      });
      expect(
        db
          .prepare('SELECT memory_id AS memoryId FROM content_history WHERE content = ?')
          .get('正文 v0'),
      ).toEqual({ memoryId: targetId });
      expect(
        db.prepare(`SELECT memory_id AS memoryId FROM edges WHERE id = 'edge1'`).get(),
      ).toEqual({
        memoryId: targetId,
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('★ 合并事件刻意**不含**那六项（不是 0，是不存在）', () => {
    const { db, store, sourceId, targetId } = makeStore();
    try {
      restore(store, sourceId, { mergeInto: targetId }, NOW);
      const payload = readEvents(db).find((event) => event.type === 'merge')?.payload ?? {};
      expect(payload.reason).toBe('restore_merge');
      expect(payload.targetId).toBe(targetId);
      expect(payload.mergedFrom).toBe(sourceId);
      for (const absent of [
        'intervalDays',
        'boostApplied',
        'contentText',
        'contentLength',
        'contentHash',
        'prevContentLength',
        'stabilityDelta',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(payload, absent), absent).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
