/**
 * 事件重放与对账的集成测试 —— DESIGN-v2.md §8.3 / §8.4 硬规则 3·5，对应 **P4-T07**。
 *
 * ★ 本文件重点守五件事：
 *   ① **对账恒等式**（`|Σ库内变化 − Σ事件 delta| ≤ 1e-9`）；
 *   ② **旧事件可重放**（缺 4 个新键 / 缺 `action`）；
 *   ③ **`restore_merge` 没有 `stabilityDelta` ⇒ 不参与对账**（不是「delta = 0」）；
 *   ④ **重放可复现**（同一串事件两次 ⇒ 逐位相同）；
 *   ⑤ **`config` 事件能恢复参数快照**（构造时传的非默认值）。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { type ReplayEvent, replayEvents, replayFromDb } from '../../src/tools/replay.js';
import { checkStabilityBalance, verifyIntegrity } from '../../src/tools/verify.js';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function insertMemory(
  db: Database.Database,
  seed: { id: string; stability: number; lastAccess?: number; deleted?: boolean },
): void {
  const deleted = seed.deleted === true;
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash, stability, difficulty,
                           pin_factor, created_at, last_access, access_count, deleted, deleted_at)
     VALUES (@id, 'fact', @content, 'x', @hash, @stability, 0.5, 1.0, @t0, @lastAccess, 0, @deleted, @deletedAt)`,
  ).run({
    id: seed.id,
    content: seed.id,
    hash: `hash-${seed.id}`,
    stability: seed.stability,
    t0: T0,
    lastAccess: seed.lastAccess ?? T0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? T0 : null,
  });
}

function appendEvent(
  db: Database.Database,
  type: string,
  memoryId: string | null,
  payload: Record<string, unknown>,
  at: number,
): void {
  db.prepare('INSERT INTO events (type, memory_id, payload, at) VALUES (?, ?, ?, ?)').run(
    type,
    memoryId,
    JSON.stringify(payload),
    at,
  );
}

describe('replay · 对账恒等式', () => {
  it('★ `|Σ库内变化 − Σ事件 delta| ≤ 1e-9`', () => {
    const db = makeDb();
    try {
      // 初始 1.0 天，两次加固 +0.45 / +0.2 ⇒ 库里 1.65
      insertMemory(db, { id: 'm1', stability: 1.65 });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      appendEvent(
        db,
        'touch',
        'm1',
        { id: 'm1', reason: 'explicit', stabilityDelta: 0.45 },
        T0 + DAY,
      );
      appendEvent(
        db,
        'touch',
        'm1',
        { id: 'm1', reason: 'exact_repeat', stabilityDelta: 0.2 },
        T0 + 2 * DAY,
      );

      const { balance, mismatches } = checkStabilityBalance(db);
      expect(mismatches).toEqual([]);
      expect(Math.abs(balance.difference)).toBeLessThanOrEqual(1e-9);
      expect(balance.eventsWithDelta).toBe(2);
      expect(balance.eventDeltaSum).toBeCloseTo(0.65, 12);
    } finally {
      db.close();
    }
  });

  it('★ 反例：库里偷偷多涨了 ⇒ 对账必须发现（差值与明细都要给出来）', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 2.0 }); // 库内比事件流多 0.35
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      appendEvent(db, 'touch', 'm1', { id: 'm1', stabilityDelta: 0.65 }, T0 + DAY);

      const { balance, mismatches } = checkStabilityBalance(db);
      expect(balance.difference).toBeCloseTo(0.35, 12);
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]?.id).toBe('m1');
    } finally {
      db.close();
    }
  });

  it('★ `stabilityDelta` 值为 0 的事件**也要计入**（键恒在 ⇒ 它确实走了加固路径）', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 1.0 });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      // 封顶导致没涨，但键还在
      appendEvent(db, 'touch', 'm1', { id: 'm1', stabilityDelta: 0 }, T0 + DAY);

      const { balance } = checkStabilityBalance(db);
      expect(balance.eventsWithDelta).toBe(1);
      expect(Math.abs(balance.difference)).toBeLessThanOrEqual(1e-9);
    } finally {
      db.close();
    }
  });

  it('★ `restore_merge` 的 merge 事件**没有** `stabilityDelta` ⇒ 不参与对账（不是 delta=0）', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 1.0 });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      appendEvent(
        db,
        'merge',
        'm1',
        { targetId: 'm1', addedEntities: [], mergedFrom: 'm2', reason: 'restore_merge' },
        T0 + DAY,
      );

      const { balance } = checkStabilityBalance(db);
      // 一条带 delta 的事件都没有
      expect(balance.eventsWithDelta).toBe(0);
      expect(Math.abs(balance.difference)).toBeLessThanOrEqual(1e-9);
    } finally {
      db.close();
    }
  });
});

describe('replay · 旧事件与可复现', () => {
  it('★ 旧格式 touch（缺 4 个新键）⇒ 不抛错，按 `[]` / `0` 兜底', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 1.0 });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      // v1.0 形态：没有 coactPairs / activationWrites / coactSkipped / coactPairsTruncated
      appendEvent(db, 'touch', 'm1', { id: 'm1', reason: 'explicit', stabilityDelta: 0 }, T0 + DAY);

      expect(() => replayFromDb(db)).not.toThrow();
      const state = replayFromDb(db);
      expect(state.unknownTypes).toEqual([]);
      expect(state.eventsProcessed).toBe(2);
    } finally {
      db.close();
    }
  });

  it('★ 旧 `sweep` 事件缺 `action` ⇒ 按 `purge` 处理（清理态可被重放出来）', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 1.0, deleted: true });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      // 旧格式：只有 level / bytes 之类的统计，没有 action
      appendEvent(db, 'sweep', 'm1', { level: 'debug' }, T0 + DAY);

      const state = replayFromDb(db);
      expect(state.purgedIds).toEqual(['m1']);
      // 被 purge 的记忆不出现在重放状态里
      expect(state.memories.find((item) => item.id === 'm1')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('★ 重放可复现：同一串事件两次 ⇒ 结果逐位相同', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 1.5 });
      insertMemory(db, { id: 'm2', stability: 1.0 });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      appendEvent(db, 'write', 'm2', { id: 'm2', initialStability: 1.0 }, T0 + 1);
      appendEvent(db, 'touch', 'm1', { id: 'm1', stabilityDelta: 0.5 }, T0 + DAY);
      appendEvent(db, 'forget', 'm2', { id: 'm2', hard: false }, T0 + 2 * DAY);
      appendEvent(db, 'restore', 'm2', { id: 'm2' }, T0 + 3 * DAY);

      const first = replayFromDb(db);
      const second = replayFromDb(db);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      // 语义也对：m2 最终是「未删」
      expect(first.memories.find((item) => item.id === 'm2')?.state.deleted).toBe(false);
    } finally {
      db.close();
    }
  });

  it('★ `upTo` 只重放到某个时刻（含端点）', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 1.0 });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);
      appendEvent(db, 'forget', 'm1', { id: 'm1', hard: false }, T0 + DAY);

      expect(replayEvents(readAll(db), { upTo: T0 }).memories[0]?.state.deleted).toBe(false);
      expect(replayEvents(readAll(db), { upTo: T0 + DAY }).memories[0]?.state.deleted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('★ `config` 事件重放 ⇒ 参数快照恢复（构造成员传的非默认值）', () => {
    const db = makeDb();
    try {
      const custom: Params = { ...DEFAULT_PARAMS, ARCHIVE_LINE: 0.31, COACT_DEGREE_MAX: 7 };
      appendEvent(db, 'config', null, { SCHEMA_VERSION: 2, params: custom }, T0);

      const state = replayFromDb(db);
      expect(state.params?.ARCHIVE_LINE).toBe(0.31);
      expect(state.params?.COACT_DEGREE_MAX).toBe(7);
      expect(state.schemaVersions).toEqual([2]);
    } finally {
      db.close();
    }
  });
});

describe('verify · 完整性自检', () => {
  it('★ 健康库 ⇒ `ok = true`；自检三项与 `stats()` 同口径', () => {
    const db = makeDb();
    try {
      insertMemory(db, { id: 'm1', stability: 1.0, lastAccess: T0 });
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);

      const report = verifyIntegrity(db, DEFAULT_PARAMS);
      expect(report.integrityOk).toBe(true);
      expect(report.foreignKeyViolations).toBe(0);
      // 没有向量 ⇒ 覆盖率记 1（「没有欠账」，不是 0/0）
      expect(report.bucketCoverage.ratio).toBe(1);
      expect(report.archival.orphans).toBe(0);
      expect(report.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it('★ 反例：有向量但没入桶 ⇒ 覆盖率 < 1 ⇒ `ok = false`', () => {
    const db = makeDb();
    try {
      const blob = Buffer.alloc(DEFAULT_PARAMS.EMBED_DIM * 4);
      db.prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, stability,
                               difficulty, pin_factor, created_at, last_access, access_count, deleted, deleted_at)
         VALUES ('m1', 'fact', 'm1', 'x', 'h1', ?, 1.0, 0.5, 1.0, ?, ?, 0, 0, NULL)`,
      ).run(blob, T0, T0);
      appendEvent(db, 'write', 'm1', { id: 'm1', initialStability: 1.0 }, T0);

      const report = verifyIntegrity(db, DEFAULT_PARAMS);
      expect(report.bucketCoverage.embeddedMemories).toBe(1);
      expect(report.bucketCoverage.bucketMembers).toBe(0);
      expect(report.bucketCoverage.ratio).toBe(0);
      expect(report.ok).toBe(false);
    } finally {
      db.close();
    }
  });
});

/** 读全部事件（重放用）。 */
function readAll(db: Database.Database): ReplayEvent[] {
  const rows = db
    .prepare('SELECT id, type, memory_id AS memoryId, payload, at FROM events ORDER BY id')
    .all() as Array<{
    id: number;
    type: string;
    memoryId: string | null;
    payload: string;
    at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    memoryId: row.memoryId,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    at: row.at,
  }));
}
