/**
 * `pin()` / `unpin()` 的单测 —— DESIGN-v2.md §4.1 末（强调与取消强调的完整行为），
 * 对应 DEVELOPMENT-PLAN.md **P1-T09**。
 *
 * ★ 本文件的断言纪律（沿用阶段 0 确立的口径）：
 *   · **每条硬断言配一条反例**：反例是**故意写出那个会错的写法**，
 *     断言「它会错、而实现不会错」⇒ 证明断言**真能发现不一致**。
 *   · **不写死「本次跑出来几条」**：性质类断言用**网格遍历**。
 *   · **数值用例手算可复算**：期望值写成闭式表达式（`MAX_PIN_FACTOR` 取自参数表）。
 *
 * ⚠️ **夹具用的是 §3 的权威 DDL**（`src/db/schema.sql.ts` 的运行时副本）：
 *   `memories.pin_factor` 的 CHECK（`>= 1.0 AND <= 5.0`）在**库层**兜底，
 *   所以「应用层校验」这条断言才有意义——否则库层会替应用层挡掉非法值，
 *   断言就变成在测 SQLite 的 CHECK 而不是测我们的校验。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { EventWriter } from '../../src/store/events.js';
import { DEFAULT_PIN_FACTOR, type PinStore, pin, unpin } from '../../src/store/pin.js';
import { MemoryLogger } from '../../src/util/log.js';

/** 生效参数（默认表）。 */
const P: Params = DEFAULT_PARAMS;

/** 事件写入器使用的注入时钟（`pin` / `unpin` 本身**不接收** `now`）。 */
const FIXED_NOW = 1_700_000_000_000;

/** 一个固定的时间基准。 */
const T0 = 1_700_000_000_000;

/** `memories` 行的关键列。 */
interface MemoryRow {
  pin_factor: number;
  stability: number;
  last_access: number;
  access_count: number;
  deleted: number;
}

/** 一条事件。 */
interface EventRow {
  type: string;
  memory_id: string | null;
  payload: string;
  at: number;
}

/** 建库 + 写入一条记忆 + 返回 store。 */
function makeStore(
  seed: { id?: string; stability?: number; deleted?: boolean; deletedAt?: number | null } = {},
): { db: Database.Database; store: PinStore; id: string } {
  const id = seed.id ?? 'm1';
  const deleted = seed.deleted === true;
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO memories (
       id, kind, content, content_tokens, content_hash, stability, difficulty, pin_factor,
       created_at, last_access, access_count, deleted, deleted_at
     ) VALUES (
       @id, 'fact', @content, @contentTokens, @hash, @stability, 0.5, 1.0,
       @createdAt, @lastAccess, 0, @deleted, @deletedAt
     )`,
  ).run({
    id,
    content: `内容 ${id}`,
    contentTokens: '内容',
    hash: `hash-${id}`,
    stability: seed.stability ?? 1,
    createdAt: T0,
    lastAccess: T0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? (seed.deletedAt ?? T0) : null,
  });

  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => FIXED_NOW,
  });
  return { db, store: { db, params: P, events }, id };
}

/** 读出记忆的关键列。 */
function readRow(db: Database.Database, id: string): MemoryRow {
  return db
    .prepare(
      'SELECT pin_factor, stability, last_access, access_count, deleted FROM memories WHERE id = ?',
    )
    .get(id) as MemoryRow;
}

/** 读出全部事件（按写入顺序）。 */
function readEvents(db: Database.Database): EventRow[] {
  return db
    .prepare('SELECT type, memory_id, payload, at FROM events ORDER BY id')
    .all() as EventRow[];
}

/** 读出某一类事件的 payload（已解析 JSON）。 */
function readEventPayloads(db: Database.Database, type: string): Array<Record<string, unknown>> {
  return readEvents(db)
    .filter((event) => event.type === type)
    .map((event) => JSON.parse(event.payload) as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────
// pin
// ─────────────────────────────────────────────────────────────

describe('pin（§4.1 末）', () => {
  it('缺省 factor = 2.0：只改 pin_factor，并记一条 `pin` 事件', () => {
    const { db, store, id } = makeStore();
    try {
      pin(store, id);
      expect(readRow(db, id).pin_factor).toBe(DEFAULT_PIN_FACTOR);

      const payloads = readEventPayloads(db, 'pin');
      expect(payloads.length).toBe(1);
      expect(payloads[0]).toEqual({ id, factor: DEFAULT_PIN_FACTOR, prevFactor: 1 });

      const events = readEvents(db);
      expect(events[0]?.type).toBe('pin');
      expect(events[0]?.memory_id).toBe(id);
      // ⚠️ 事件时间戳用事件写入器的注入时钟（`pin` 本身**不接收** `now`）
      expect(events[0]?.at).toBe(FIXED_NOW);
    } finally {
      db.close();
    }
  });

  it('显式 factor 生效', () => {
    const { db, store, id } = makeStore();
    try {
      pin(store, id, 3.5);
      expect(readRow(db, id).pin_factor).toBe(3.5);
      expect(readEventPayloads(db, 'pin')[0]).toEqual({ id, factor: 3.5, prevFactor: 1 });
    } finally {
      db.close();
    }
  });

  it('连续 pin：第二个事件的 `prevFactor` 记的是**改之前**的值', () => {
    const { db, store, id } = makeStore();
    try {
      pin(store, id, 2);
      pin(store, id, 4);
      const payloads = readEventPayloads(db, 'pin');
      expect(payloads.length).toBe(2);
      expect(payloads[0]?.prevFactor).toBe(1);
      expect(payloads[1]?.prevFactor).toBe(2);
      expect(payloads[1]?.factor).toBe(4);
      expect(readRow(db, id).pin_factor).toBe(4);
    } finally {
      db.close();
    }
  });

  it('**绝不**同步写 stability / last_access / access_count（§4.1）', () => {
    const { db, store, id } = makeStore({ stability: 12.5 });
    try {
      const before = readRow(db, id);
      pin(store, id, 3);
      const after = readRow(db, id);
      expect(after.pin_factor).toBe(3);
      expect(after.stability).toBe(before.stability);
      expect(after.last_access).toBe(before.last_access);
      expect(after.access_count).toBe(before.access_count);
    } finally {
      db.close();
    }
  });

  it('非法 factor ⇒ `INVALID_INPUT` 且**零写入**（不改库、不记事件）', () => {
    const invalidFactors = [
      0,
      0.99,
      -1,
      P.MAX_PIN_FACTOR + 0.01,
      6,
      1e9,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const factor of invalidFactors) {
      const { db, store, id } = makeStore();
      try {
        expect(() => pin(store, id, factor)).toThrowError(MemoryError);
        try {
          pin(store, id, factor);
        } catch (error) {
          expect((error as MemoryError).code).toBe(MemoryError.INVALID_INPUT);
        }
        // 零写入：pin_factor 未变、一条事件都没有
        expect(readRow(db, id).pin_factor).toBe(1);
        expect(readEvents(db)).toHaveLength(0);
      } finally {
        db.close();
      }
    }
  });

  it('边界值：1.0 与 MAX_PIN_FACTOR **合法**（区间是闭区间）', () => {
    for (const factor of [1, P.MAX_PIN_FACTOR]) {
      const { db, store, id } = makeStore();
      try {
        pin(store, id, factor);
        expect(readRow(db, id).pin_factor).toBe(factor);
      } finally {
        db.close();
      }
    }
  });

  it('目标不存在 ⇒ `NOT_FOUND`（不写库、不记事件）', () => {
    const { db, store } = makeStore();
    try {
      expect(() => pin(store, 'not-exist')).toThrowError(MemoryError);
      try {
        pin(store, 'not-exist');
      } catch (error) {
        expect((error as MemoryError).code).toBe(MemoryError.NOT_FOUND);
      }
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('软删的记忆**不接受 pin** ⇒ `NOT_FOUND`', () => {
    const { db, store, id } = makeStore({ deleted: true, deletedAt: T0 });
    try {
      expect(() => pin(store, id)).toThrowError(MemoryError);
      try {
        pin(store, id);
      } catch (error) {
        expect((error as MemoryError).code).toBe(MemoryError.NOT_FOUND);
      }
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('★ 反例：一个「pin 时同步把 stability 乘上 factor」的实现会让强调**无法撤销**', () => {
    const { db, store, id } = makeStore({ stability: 10 });
    try {
      // 错的实现：同时改 stability
      const wrongPin = (s: PinStore, target: string, factor: number): void => {
        s.db
          .prepare('UPDATE memories SET pin_factor = ?, stability = stability * ? WHERE id = ?')
          .run(factor, factor, target);
      };
      const before = readRow(db, id).stability;
      wrongPin(store, id, 3);
      expect(readRow(db, id).stability).toBe(before * 3);

      // 正确实现：stability 一行不动
      const { db: db2, store: store2, id: id2 } = makeStore({ stability: 10 });
      try {
        pin(store2, id2, 3);
        expect(readRow(db2, id2).stability).toBe(10);
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });

  it('★ 反例：一个**静默钳制**非法 factor 的实现会让调用方以为「我传 6 被接受了」', () => {
    const { db, store, id } = makeStore();
    try {
      const clampingPin = (s: PinStore, target: string, factor: number): void => {
        const clamped = Math.min(Math.max(factor, 1), s.params.MAX_PIN_FACTOR);
        s.db.prepare('UPDATE memories SET pin_factor = ? WHERE id = ?').run(clamped, target);
      };
      clampingPin(store, id, 6);
      expect(readRow(db, id).pin_factor).toBe(P.MAX_PIN_FACTOR);

      // 正确实现：抛错，且库里**什么都没变**
      const { db: db2, store: store2, id: id2 } = makeStore();
      try {
        expect(() => pin(store2, id2, 6)).toThrowError(MemoryError);
        expect(readRow(db2, id2).pin_factor).toBe(1);
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// unpin
// ─────────────────────────────────────────────────────────────

describe('unpin（§4.1 末）', () => {
  it('把 pin_factor 复原为 1.0，并记一条 `unpin` 事件（记的是**改前**的值）', () => {
    const { db, store, id } = makeStore();
    try {
      pin(store, id, 4);
      unpin(store, id);
      expect(readRow(db, id).pin_factor).toBe(1);

      const payloads = readEventPayloads(db, 'unpin');
      expect(payloads.length).toBe(1);
      // ⚠️ unpin 后 factor 恒为 1.0 ⇒ 记 `factor: 1` 等于没记任何信息 ⇒ 必须记 prevFactor
      expect(payloads[0]).toEqual({ id, prevFactor: 4 });
      expect(payloads[0]?.factor).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('记忆的历史稳定度增长**完整保留**（stability 全程未被触碰）', () => {
    const { db, store, id } = makeStore({ stability: 37.5 });
    try {
      const before = readRow(db, id).stability;
      pin(store, id, 5);
      unpin(store, id);
      const after = readRow(db, id);
      expect(after.stability).toBe(before);
      expect(after.pin_factor).toBe(1);
      expect(after.access_count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('幂等：本就未强调（`pin_factor == 1.0`）⇒ **不写库、不记事件**', () => {
    const { db, store, id } = makeStore();
    try {
      unpin(store, id);
      unpin(store, id);
      expect(readRow(db, id).pin_factor).toBe(1);
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('目标不存在 ⇒ `NOT_FOUND`', () => {
    const { db, store } = makeStore();
    try {
      expect(() => unpin(store, 'not-exist')).toThrowError(MemoryError);
      try {
        unpin(store, 'not-exist');
      } catch (error) {
        expect((error as MemoryError).code).toBe(MemoryError.NOT_FOUND);
      }
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('软删的记忆**不接受 unpin** ⇒ `NOT_FOUND`', () => {
    const { db, store, id } = makeStore({ deleted: true, deletedAt: T0 });
    try {
      expect(() => unpin(store, id)).toThrowError(MemoryError);
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('★ 反例：一个「unpin 把 stability 复原成初始值」的实现会**抹掉历史增长**', () => {
    const { db, store, id } = makeStore({ stability: 37.5 });
    try {
      // 错的实现：顺手把 stability 写回 1
      const wrongUnpin = (s: PinStore, target: string): void => {
        s.db
          .prepare('UPDATE memories SET pin_factor = 1.0, stability = 1.0 WHERE id = ?')
          .run(target);
      };
      wrongUnpin(store, id);
      expect(readRow(db, id).stability).toBe(1);

      // 正确实现：stability 一行不动
      const { db: db2, store: store2, id: id2 } = makeStore({ stability: 37.5 });
      try {
        pin(store2, id2, 3);
        unpin(store2, id2);
        expect(readRow(db2, id2).stability).toBe(37.5);
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 只读实例
// ─────────────────────────────────────────────────────────────

describe('只读实例上的 pin / unpin（§7.1）', () => {
  it('真正的写操作一律抛 `READONLY_VIOLATION`，且库**未变**', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.prepare(
        `INSERT INTO memories (
           id, kind, content, content_tokens, content_hash, stability, difficulty, pin_factor,
           created_at, last_access, access_count, deleted, deleted_at
         ) VALUES ('m1', 'fact', 'c', 'c', 'h', 1, 0.5, 1.0, @t, @t, 0, 0, NULL)`,
      ).run({ t: T0 });
      const events = new EventWriter(db, {
        readonly: true,
        logger: new MemoryLogger(),
        now: () => FIXED_NOW,
      });
      const store: PinStore = { db, params: P, events };

      for (const call of [(): void => pin(store, 'm1'), (): void => unpin(store, 'm1')]) {
        expect(call).toThrowError(MemoryError);
        try {
          call();
        } catch (error) {
          expect((error as MemoryError).code).toBe(MemoryError.READONLY_VIOLATION);
        }
      }
      const row = readRow(db, 'm1');
      expect(row.pin_factor).toBe(1);
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
