/**
 * `sweep()` 的集成测试 —— DESIGN-v2.md §4.10 / §9.2，对应 **P4-T06**。
 *
 * ★ 本文件重点守六件事（都是「看起来成功、其实做错」的一类）：
 *   ① 只清**超期的软删**行，未软删的一个都不动；
 *   ② `deleted_at IS NULL` 的脏行**跳过**且**不死循环**；
 *   ③ 任一条抛错 ⇒ **整次 sweep 中止并上抛**（不是「跳过坏的继续做」）；
 *   ④ `vacuumed` 是**实际执行**而不是入参回显；
 *   ⑤ 汇总事件的 `memory_id` 必须是**显式 null**；
 *   ⑥ 共激活淘汰（阈值 + 度数上限）真的删对了边。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { countArchived } from '../../src/store/archival.js';
import { EventWriter } from '../../src/store/events.js';
import { type SweepStore, sweep } from '../../src/store/sweep.js';
import { MemoryLogger } from '../../src/util/log.js';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const NOW = T0 + 100 * DAY;

interface Fixture {
  db: Database.Database;
  store: SweepStore;
  params: Params;
}

/** 建库（`memories` 行由各用例自己插）。 */
function makeStore(seed: { readonly?: boolean; params?: Partial<Params> } = {}): Fixture {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const params: Params = { ...DEFAULT_PARAMS, ...seed.params };
  const events = new EventWriter(db, {
    readonly: seed.readonly === true,
    logger: new MemoryLogger(),
    now: () => NOW,
  });
  return { db, store: { db, params, events }, params };
}

/** 插一条记忆（可指定软删时刻；`null` = 脏数据）。 */
function insertMemory(
  db: Database.Database,
  seed: {
    id: string;
    deleted?: boolean;
    deletedAt?: number | null;
    lastAccess?: number;
    stability?: number;
  },
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
    stability: seed.stability ?? 10,
    t0: T0,
    lastAccess: seed.lastAccess ?? T0,
    deleted: deleted ? 1 : 0,
    // ⚠️ 不能用 `??`：`deletedAt: null` 是**脏数据用例**，必须真的落成 NULL
    //   （`null ?? T0` 会得到 T0 ⇒ 那个用例测的就不是脏数据了）
    deletedAt: deleted ? (seed.deletedAt === undefined ? T0 : seed.deletedAt) : null,
  });
}

describe('sweep · 物理清理', () => {
  it('★ 只清「软删超过期限」的行；未软删的一个都不动', () => {
    const { db, store } = makeStore();
    try {
      insertMemory(db, { id: 'live' });
      insertMemory(db, { id: 'old', deleted: true, deletedAt: T0 }); // 100 天前
      insertMemory(db, { id: 'fresh', deleted: true, deletedAt: NOW - DAY }); // 1 天前

      const result = sweep(store, { purgeDeletedDays: 30 }, NOW);

      expect(result.purged).toBe(1);
      const ids = (
        db.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(ids).toEqual(['fresh', 'live']);
    } finally {
      db.close();
    }
  });

  it('★ `deleted_at IS NULL` 的脏行被跳过，且**不会死循环**', () => {
    const { db, store } = makeStore();
    try {
      // ⚠️ **DDL 的 CHECK 本来就禁止这种脏行**（`deleted=1 ⇒ deleted_at NOT NULL`）
      //   ⇒ 要构造它必须临时关掉 CHECK —— 这正是「脏数据只可能来自库外/旧版本」的模拟方式。
      db.pragma('ignore_check_constraints = ON');
      insertMemory(db, { id: 'dirty', deleted: true, deletedAt: null });
      db.pragma('ignore_check_constraints = OFF');
      const result = sweep(store, { purgeDeletedDays: 1 }, NOW);
      // 没有被清（`deleted_at IS NOT NULL` 不成立）⇒ 也没被反复选中（否则这个用例会超时）
      expect(result.purged).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM memories WHERE id = ?').get('dirty')).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  it('★ 任一条抛错 ⇒ **整次 sweep 中止并上抛**（后续批次不再处理）', () => {
    const { db, store } = makeStore({ params: { SWEEP_BATCH_SIZE: 1 } });
    try {
      insertMemory(db, { id: 'a-old', deleted: true, deletedAt: T0 });
      insertMemory(db, { id: 'b-old', deleted: true, deletedAt: T0 + DAY });
      // 让「删 a-old」必然失败（够狠但可控：一个只对它生效的触发器）
      db.exec(
        `CREATE TRIGGER boom BEFORE DELETE ON memories WHEN old.id = 'a-old'
         BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
      );

      expect(() => sweep(store, { purgeDeletedDays: 1 }, NOW)).toThrow();
      // ★ 中止 ⇒ 第二条**没被处理**（不是「跳过坏的继续做」）
      expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 2 });
      db.exec('DROP TRIGGER boom');
    } finally {
      db.close();
    }
  });

  it('清理时会脱敏该记忆的旧事件（与 forget 共用同一份脱敏 SQL）', () => {
    const { db, store } = makeStore();
    try {
      insertMemory(db, { id: 'gone', deleted: true, deletedAt: T0 });
      db.prepare(
        `INSERT INTO events (type, memory_id, payload, at)
         VALUES ('write', 'gone', json_object('id', 'gone', 'contentText', '原文'), @t0)`,
      ).run({ t0: T0 });

      sweep(store, { purgeDeletedDays: 1 }, NOW);
      const row = db.prepare(`SELECT payload FROM events WHERE type = 'write'`).get() as {
        payload: string;
      };
      expect((JSON.parse(row.payload) as { contentText: string }).contentText).toBe('[redacted]');
    } finally {
      db.close();
    }
  });
});

describe('sweep · 汇总事件与空间回收', () => {
  it('★ 汇总事件：`memory_id` 为 null，`vacuumed=false`（`purged=0` 时 VACUUM 被跳过）', () => {
    const { db, store } = makeStore();
    try {
      insertMemory(db, { id: 'live' });
      const result = sweep(store, { vacuum: true }, NOW); // 不传 purgeDeletedDays ⇒ 不清任何东西
      expect(result.purged).toBe(0);

      const event = db
        .prepare(`SELECT memory_id AS memoryId, payload FROM events WHERE type = 'sweep'`)
        .get() as {
        memoryId: string | null;
        payload: string;
      };
      expect(event.memoryId).toBeNull();
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      // ★ 传了 vacuum: true 但没删任何行 ⇒ **实际没执行**
      expect(payload.vacuumed).toBe(false);
      expect(payload.action).toBe('purge');
      expect(payload.purged).toBe(0);
      // §8.4 的汇总字段集必须齐全
      for (const key of [
        'action',
        'purged',
        'archivedCount',
        'vacuumed',
        'coactPairsActive',
        'coactPairsPurged',
        'clusterCount',
        'largestClusterRatio',
        'largestClusterRatioBeforeSplit',
        'blocksAfterSplit',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(payload, key), key).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('★ 真删了行之后 `vacuumed=true`，且 VACUUM 没在事务里执行（否则 SQLite 会直接报错）', () => {
    const { db, store } = makeStore();
    try {
      insertMemory(db, { id: 'old', deleted: true, deletedAt: T0 });
      const result = sweep(store, { purgeDeletedDays: 1, vacuum: true }, NOW);
      expect(result.purged).toBe(1);

      const payload = JSON.parse(
        (
          db
            .prepare(`SELECT payload FROM events WHERE type = 'sweep' AND memory_id IS NULL`)
            .get() as {
            payload: string;
          }
        ).payload,
      ) as { vacuumed: boolean };
      expect(payload.vacuumed).toBe(true);
      // FTS 重建后索引仍与主表一致
      expect(db.prepare('SELECT count(*) AS n FROM mem_fts').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('★ `archivedCount` 与 `stats()` 是**同一个数**（共用实现）', () => {
    const { db, store, params } = makeStore();
    try {
      insertMemory(db, { id: 'm1', stability: 1000, lastAccess: NOW });
      insertMemory(db, { id: 'm2', stability: 0.1, lastAccess: T0 }); // 早已归档
      const result = sweep(store, {}, NOW);

      // 与 `countArchived()` 的直接调用比对（`stats()` 内部就是它）
      expect(result.archivedCount).toBe(countArchived(db, params, NOW));
      expect(result.archivedCount).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('sweep · 共激活淘汰', () => {
  /** 插 `count` 条记忆（id = m0, m1, ...）。 */
  function insertMemories(db: Database.Database, count: number): void {
    for (let index = 0; index < count; index += 1) insertMemory(db, { id: `m${index}` });
  }

  it('★ 阈值淘汰：`affinity_eff < COACT_AFFINITY_MIN` 的边被删，`coactPairsPurged` 正确', () => {
    const { db, store, params } = makeStore();
    try {
      insertMemories(db, 4);
      const insertCoact = db.prepare(
        'INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active) VALUES (?, ?, ?, 1, 0, ?)',
      );
      // m0-m1：很久以前（衰减后远低于 0.15）
      insertCoact.run('m0', 'm1', 0.9, T0);
      // m2-m3：刚刚（衰减后可忽略）
      insertCoact.run('m2', 'm3', 0.9, NOW);

      expect(params.COACT_AFFINITY_MIN).toBe(0.15);
      const result = sweep(store, {}, NOW);

      expect(result.coactPairsPurged).toBe(1);
      expect(db.prepare('SELECT memory_a AS a, memory_b AS b FROM coacts').all()).toEqual([
        { a: 'm2', b: 'm3' },
      ]);
    } finally {
      db.close();
    }
  });

  it('★ 度数上限：一条记忆 40 个邻居 ⇒ 淘汰后它的度数 ≤ `COACT_DEGREE_MAX`（保留最强的）', () => {
    const { db, store, params } = makeStore();
    try {
      insertMemories(db, 41);
      const insertCoact = db.prepare(
        'INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active) VALUES (?, ?, ?, 1, 0, ?)',
      );
      // hub = m0，与 m1..m40 各一条边；亲和度递增（便于验证「保留最强的」）
      for (let index = 1; index <= 40; index += 1) {
        const partner = `m${index}`;
        const low = index < 40;
        const a = 'm0' < partner ? 'm0' : partner;
        const b = 'm0' < partner ? partner : 'm0';
        insertCoact.run(a, b, low ? 0.2 : 0.9, NOW);
      }

      const result = sweep(store, {}, NOW);
      // 40 - 32 = 8 条被删
      expect(result.coactPairsPurged).toBe(8);
      expect(params.COACT_DEGREE_MAX).toBe(32);

      const hubDegree = (
        db
          .prepare('SELECT count(*) AS n FROM coacts WHERE memory_a = ? OR memory_b = ?')
          .get('m0', 'm0') as { n: number }
      ).n;
      expect(hubDegree).toBe(32);
      // ★ 保留的是**最强的那 32 条**：唯一 affinity = 0.9 的那条（m0-m40）一定还在
      expect(
        db.prepare(`SELECT affinity FROM coacts WHERE memory_a = 'm0' AND memory_b = 'm40'`).get(),
      ).toEqual({ affinity: 0.9 });
    } finally {
      db.close();
    }
  });

  it('无共激活边时：`coactPairsActive=0` / `coactPairsPurged=0`（不报错）', () => {
    const { db, store } = makeStore();
    try {
      const result = sweep(store, {}, NOW);
      expect(result.coactPairsPurged).toBe(0);
      const payload = JSON.parse(
        (db.prepare(`SELECT payload FROM events WHERE type = 'sweep'`).get() as { payload: string })
          .payload,
      ) as { coactPairsActive: number };
      expect(payload.coactPairsActive).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('sweep · 只读与返回值', () => {
  it('★ 只读句柄 ⇒ `READONLY_VIOLATION`（**即使不传任何参数**）', () => {
    const { db, store } = makeStore({ readonly: true });
    try {
      let caught: MemoryError | undefined;
      try {
        sweep(store, {}, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.READONLY_VIOLATION);
      // 一张事件都没写（只读实例上事件是短路的，但这里连短路都不该走到）
      expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('返回值形状 = `{ purged, archivedCount, coactPairsPurged }`', () => {
    const { db, store } = makeStore();
    try {
      const result = sweep(store, {}, NOW);
      expect(Object.keys(result).sort()).toEqual(['archivedCount', 'coactPairsPurged', 'purged']);
    } finally {
      db.close();
    }
  });
});
