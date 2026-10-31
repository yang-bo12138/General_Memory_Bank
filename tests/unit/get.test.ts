/**
 * 单条读取 `get()` 的单测 —— DESIGN-v2.md §4.1 末 / §6 的 `MemoryView`，
 * 对应 DEVELOPMENT-PLAN.md **P1-T09**。
 *
 * ★ 本文件的断言纪律（沿用阶段 0 确立的口径）：
 *   · **每条硬断言配一条反例**：反例是**故意写出那个会错的写法**，
 *     断言「它会错、而实现不会错」⇒ 证明断言**真能发现不一致**。
 *   · **不写死「本次跑出来几条」**：性质类断言用**网格遍历**。
 *   · **数值用例手算可复算**：期望值写成 `Math.exp(-1)` 这类**与公式同源的闭式表达式**。
 *
 * ⚠️ **夹具用的是 §3 的权威 DDL**（`src/db/schema.sql.ts` 的运行时副本），
 *   不是手抄的最小表 ⇒ 断言跑在**与生产同一套约束**上
 *   （软删必须带 `deleted_at`、媒体二元组同生同死、`pin_factor` 的 CHECK 等）。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { tokenize } from '../../src/core/tokenize.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { type MemoryReadStore, get } from '../../src/store/get.js';

/** 生效参数（默认表）。 */
const P: Params = DEFAULT_PARAMS;

/** 一个固定的时间基准（测试里所有时刻都相对它推算）。 */
const T0 = 1_700_000_000_000;

/**
 * DESIGN §6 的 `MemoryView` 字段清单（**逐字抄**，共 19 个）。
 *
 * ⚠️ **判定是「下界」（⊇）不是「等式」（===）**：§6 的原文是
 *   「这里的字段必须覆盖 memories 表里**所有对外有意义的列**。少一个是『写进去了但读不出来』」
 *   ⇒ 「多一个**派生**字段」（本实现里的 `effectiveStability`）**不违反**该约束。
 *   ⇒ 断言只写「清单里的每个字段都在」，**刻意不写 `toHaveLength(19)`**：
 *   字段集增删时这条断言应当继续成立（增字段 ⇒ 仍然 ⊇），写死个数会把它变成另一类锁死。
 */
const MEMORY_VIEW_FIELDS: readonly string[] = [
  'id',
  'content',
  'hasEmbedding',
  'kind',
  'layer',
  'intensity',
  'stability',
  'difficulty',
  'entities',
  'mediaRef',
  'mediaType',
  'createdAt',
  'lastAccess',
  'accessCount',
  'pinFactor',
  'confidence',
  'source',
  'deleted',
  'deletedAt',
];

/**
 * 各字段的期望 `typeof`（`mediaRef` / `mediaType` / `source` / `deletedAt` 允许为 `null`，
 * 所以它们只断言「非 null 时的类型」；`entities` 是数组，单独断言）。
 */
const MEMORY_VIEW_FIELD_TYPES: Readonly<Record<string, 'number' | 'string' | 'boolean'>> = {
  id: 'string',
  content: 'string',
  hasEmbedding: 'boolean',
  kind: 'string',
  layer: 'string',
  intensity: 'number',
  stability: 'number',
  difficulty: 'number',
  createdAt: 'number',
  lastAccess: 'number',
  accessCount: 'number',
  pinFactor: 'number',
  confidence: 'number',
  source: 'string',
  deleted: 'boolean',
  deletedAt: 'number',
};

/** 建库（内存库，§3 的权威 DDL）。 */
function openDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

/** 一条待写入的记忆。 */
interface MemorySeed {
  id: string;
  kind?: string;
  content?: string;
  stability?: number;
  pinFactor?: number;
  createdAt?: number;
  lastAccess?: number;
  accessCount?: number;
  confidence?: number;
  source?: string | null;
  difficulty?: number;
  deleted?: boolean;
  deletedAt?: number | null;
  embedding?: Buffer | null;
  mediaRef?: string | null;
  mediaType?: string | null;
  /** 关联实体的**名称**（按此顺序写入，写入顺序与返回顺序故意不同）。 */
  entityNames?: string[];
}

/** 写入一条记忆及其实体关联。 */
function seedMemory(db: Database.Database, seed: MemorySeed): void {
  const content = seed.content ?? `内容 ${seed.id}`;
  const deleted = seed.deleted === true;
  db.prepare(
    `INSERT INTO memories (
       id, kind, content, content_tokens, content_hash, embedding, media_ref, media_type,
       source, confidence, stability, difficulty, pin_factor, created_at, last_access,
       access_count, deleted, deleted_at
     ) VALUES (
       @id, @kind, @content, @contentTokens, @contentHash, @embedding, @mediaRef, @mediaType,
       @source, @confidence, @stability, @difficulty, @pinFactor, @createdAt, @lastAccess,
       @accessCount, @deleted, @deletedAt
     )`,
  ).run({
    id: seed.id,
    kind: seed.kind ?? 'fact',
    content,
    contentTokens: tokenize(content),
    contentHash: `hash-${seed.id}`,
    embedding: seed.embedding ?? null,
    mediaRef: seed.mediaRef ?? null,
    mediaType: seed.mediaType ?? null,
    source: seed.source ?? null,
    confidence: seed.confidence ?? 0.7,
    stability: seed.stability ?? 1,
    difficulty: seed.difficulty ?? 0.5,
    pinFactor: seed.pinFactor ?? 1,
    createdAt: seed.createdAt ?? T0,
    lastAccess: seed.lastAccess ?? T0,
    accessCount: seed.accessCount ?? 0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? (seed.deletedAt ?? T0) : null,
  });

  for (const name of seed.entityNames ?? []) {
    db.prepare('INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)').run(
      `entity-${name}`,
      name,
      'concept',
      T0,
    );
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
      seed.id,
      `entity-${name}`,
    );
  }
}

/** 建库 + 写入 + 返回 store。 */
function makeStore(seeds: MemorySeed[]): { db: Database.Database; store: MemoryReadStore } {
  const db = openDatabase();
  for (const seed of seeds) {
    seedMemory(db, seed);
  }
  return { db, store: { db, params: P } };
}

// ─────────────────────────────────────────────────────────────
// 缺失的表达方式
// ─────────────────────────────────────────────────────────────

describe('get 的「缺失」表达方式（§11.2）', () => {
  it('硬删（行不存在）⇒ 返回 `null`', () => {
    const { db, store } = makeStore([{ id: 'm1' }]);
    try {
      db.prepare('DELETE FROM memories WHERE id = ?').run('m1');
      expect(get(store, 'm1', T0)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('id 不存在 ⇒ 返回 `null` 且**不抛** NOT_FOUND', () => {
    const { db, store } = makeStore([{ id: 'm1' }]);
    try {
      expect(() => get(store, 'not-exist', T0)).not.toThrow();
      expect(get(store, 'not-exist', T0)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('★ 反例：抛 NOT_FOUND 的实现会让查看器每读一条缺失记忆都要包一层 try-catch', () => {
    const { db, store } = makeStore([{ id: 'm1' }]);
    try {
      const throwingGet = (): never => {
        throw new Error('NOT_FOUND');
      };
      expect(() => throwingGet()).toThrow();
      expect(get(store, 'not-exist', T0)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('★ 反例：加了 `AND deleted = 0` 的实现 ⇒ 软删记录读不出来（查看器列不出软删项）', () => {
    const { db, store } = makeStore([{ id: 'm1', deleted: true, deletedAt: T0 }]);
    try {
      // 错的实现：过滤掉软删
      const filteringGet = (s: MemoryReadStore, id: string): unknown =>
        s.db.prepare('SELECT * FROM memories WHERE id = @id AND deleted = 0').get({ id });

      expect(filteringGet(store, 'm1')).toBeUndefined();
      // 正确实现：软删记录照常返回
      const view = get(store, 'm1', T0);
      expect(view).not.toBeNull();
      expect(view?.deleted).toBe(true);
      expect(view?.deletedAt).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// MemoryView 的形状
// ─────────────────────────────────────────────────────────────

describe('get 的 MemoryView（§6 / §4.1 末）', () => {
  it('静态列取自该行；派生值现算', () => {
    const { db, store } = makeStore([
      {
        id: 'm1',
        kind: 'preference',
        content: '我喜欢喝美式咖啡',
        stability: 12,
        pinFactor: 2,
        createdAt: T0 - 1000,
        lastAccess: T0,
        accessCount: 7,
        confidence: 0.9,
        source: '会话-1',
        mediaRef: 'file://a.png',
        mediaType: 'image',
        embedding: Buffer.from([1, 2, 3, 4]),
      },
    ]);
    try {
      const view = get(store, 'm1', T0);
      expect(view).not.toBeNull();
      expect(view?.id).toBe('m1');
      expect(view?.kind).toBe('preference');
      expect(view?.content).toBe('我喜欢喝美式咖啡');
      expect(view?.stability).toBe(12);
      expect(view?.pinFactor).toBe(2);
      expect(view?.createdAt).toBe(T0 - 1000);
      expect(view?.lastAccess).toBe(T0);
      expect(view?.accessCount).toBe(7);
      expect(view?.confidence).toBe(0.9);
      expect(view?.source).toBe('会话-1');
      expect(view?.mediaRef).toBe('file://a.png');
      expect(view?.mediaType).toBe('image');
      expect(view?.hasEmbedding).toBe(true);
      expect(view?.deleted).toBe(false);
      expect(view?.deletedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('字段集**覆盖** §6 的 MemoryView 全部字段（下界判定：少一个 = 「写进去了但读不出来」）', () => {
    const { db, store } = makeStore([{ id: 'm1', entityNames: ['王五', '张三'] }]);
    try {
      const view = get(store, 'm1', T0);
      expect(view).not.toBeNull();
      if (view === null) {
        return;
      }

      // ① 清单里的每个字段都必须**在**（⊇ 下界，不是 == 等式）
      for (const field of MEMORY_VIEW_FIELDS) {
        expect(view).toHaveProperty(field);
      }
      // ② 派生字段 `effectiveStability` **单独**断言（**不在 §6 的 19 个之列**）：
      //    §4.1 末点名要的派生值（= stability × pin_factor），§6 未列 ⇒
      //    「§6 的 19 个」是**下界**（⊇），多这一个派生字段**不违反**该约束。
      //    ⚠️ 之所以要**单独**写一条 expect（而不是把它塞进上面的 19 个清单）：
      //    将来设计稿若把它补进 §6，这条断言会**从「多一个」变成「正好 19+1」**，
      //    一眼能看出变化；否则它会无声地变成一条没人注意的额外字段。
      expect(view).toHaveProperty('effectiveStability');

      // ③ 字段的**类型**也要对（少一个字段 / 类型错位都属于「读不出来」）
      for (const [field, expected] of Object.entries(MEMORY_VIEW_FIELD_TYPES)) {
        const value = (view as unknown as Record<string, unknown>)[field];
        if (value === null) {
          // ⚠️ `mediaRef` / `mediaType` / `source` / `deletedAt` 允许为 null（§3 的状态一致性约束）
          continue;
        }
        expect(typeof value).toBe(expected);
      }

      // ④ `entities` 是**名称数组**且升序（不是 id 数组）
      expect(Array.isArray(view.entities)).toBe(true);
      expect(view.entities).toEqual(['张三', '王五']);
    } finally {
      db.close();
    }
  });

  it('软删记录：返回对象且 `deleted === true`、`deletedAt` 非 null', () => {
    const { db, store } = makeStore([{ id: 'm1', deleted: true, deletedAt: T0 + 5 }]);
    try {
      const view = get(store, 'm1', T0);
      expect(view).not.toBeNull();
      expect(view?.deleted).toBe(true);
      expect(view?.deletedAt).toBe(T0 + 5);
    } finally {
      db.close();
    }
  });

  it('无 embedding / 无媒体 ⇒ 对应字段为 false / null', () => {
    const { db, store } = makeStore([{ id: 'm1' }]);
    try {
      const view = get(store, 'm1', T0);
      expect(view?.hasEmbedding).toBe(false);
      expect(view?.mediaRef).toBeNull();
      expect(view?.mediaType).toBeNull();
      expect(view?.source).toBeNull();
    } finally {
      db.close();
    }
  });

  it('**不返回** score / breakdown（单条读取没有「本次检索」的语境）', () => {
    const { db, store } = makeStore([{ id: 'm1' }]);
    try {
      const view = get(store, 'm1', T0);
      expect(view).not.toBeNull();
      expect('score' in (view as object)).toBe(false);
      expect('breakdown' in (view as object)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('`get` 是只读操作：一行都不改、一个事件都不写', () => {
    const { db, store } = makeStore([{ id: 'm1' }]);
    try {
      const before = db.prepare('SELECT * FROM memories WHERE id = ?').all('m1');
      const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      get(store, 'm1', T0);
      const after = db.prepare('SELECT * FROM memories WHERE id = ?').all('m1');
      const eventsAfter = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      expect(after).toEqual(before);
      expect(eventsAfter.n).toBe(eventsBefore.n);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// entities
// ─────────────────────────────────────────────────────────────

describe('get 的 entities（§4.1 末）', () => {
  it('是**名称**数组（不是 id），且按名称升序', () => {
    const { db, store } = makeStore([{ id: 'm1', entityNames: ['王五', '张三', '李四'] }]);
    try {
      const view = get(store, 'm1', T0);
      expect(view?.entities).toEqual(['张三', '李四', '王五']);
      // ★ 断言「是名称」而不是「是 id」：集合里出现的一律是**写入的名称**
      const names = new Set(['王五', '张三', '李四']);
      for (const entity of view?.entities ?? []) {
        expect(names.has(entity)).toBe(true);
        expect(entity.startsWith('entity-')).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it('性质：返回顺序**与写入顺序无关**，恒为名称升序', () => {
    const permutations = [
      ['张三', '李四', '王五'],
      ['王五', '李四', '张三'],
      ['李四', '张三', '王五'],
    ];
    for (const names of permutations) {
      const { db, store } = makeStore([{ id: 'm1', entityNames: names }]);
      try {
        const view = get(store, 'm1', T0);
        const expected = [...names].sort();
        expect(view?.entities).toEqual(expected);
      } finally {
        db.close();
      }
    }
  });

  it('没有关联实体 ⇒ 空数组（不是 null、也不是 undefined）', () => {
    const { db, store } = makeStore([{ id: 'm1' }]);
    try {
      const view = get(store, 'm1', T0);
      expect(view?.entities).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 派生值：intensity / layer / effectiveStability
// ─────────────────────────────────────────────────────────────

describe('get 的派生值（§4.1 末 · 读取时现算）', () => {
  it('intensity 与注入的 `now` 严格对应（闭式期望值）', () => {
    const { db, store } = makeStore([{ id: 'm1', stability: 1, lastAccess: T0 }]);
    try {
      expect(get(store, 'm1', T0)?.intensity).toBe(1);
      expect(get(store, 'm1', T0 + MS_PER_DAY)?.intensity).toBeCloseTo(Math.exp(-1), 12);
      expect(get(store, 'm1', T0 + 2 * MS_PER_DAY)?.intensity).toBeCloseTo(Math.exp(-2), 12);
    } finally {
      db.close();
    }
  });

  it('layer 随 `now` 变化（强度分段：L3 / L2 / L1 / archived）', () => {
    const { db, store } = makeStore([{ id: 'm1', stability: 1, lastAccess: T0 }]);
    try {
      expect(get(store, 'm1', T0)?.layer).toBe('L3');
      // exp(-1) ≈ 0.368 ⇒ 落在 (THRESHOLD_L2, THRESHOLD_L3] ⇒ L2
      expect(get(store, 'm1', T0 + MS_PER_DAY)?.layer).toBe('L2');
      // 很久以后 ⇒ 强度跌破 ARCHIVE_LINE ⇒ archived
      expect(get(store, 'm1', T0 + 30 * MS_PER_DAY)?.layer).toBe('archived');
    } finally {
      db.close();
    }
  });

  it('性质：强度随 `now` 单调不增（时钟回拨时被钳住，不反弹）', () => {
    const { db, store } = makeStore([{ id: 'm1', stability: 1, lastAccess: T0 }]);
    try {
      let previous = Number.POSITIVE_INFINITY;
      for (const offsetDays of [-1, 0, 0.5, 1, 3, 7, 30, 180]) {
        const value = get(store, 'm1', T0 + offsetDays * MS_PER_DAY)?.intensity ?? Number.NaN;
        expect(value).toBeLessThanOrEqual(previous);
        previous = value;
      }
      // 注入过去时刻 ⇒ 强度恒为 1（§4.1 的 `max(0, Δt)` 防护）
      expect(get(store, 'm1', T0 - 365 * MS_PER_DAY)?.intensity).toBe(1);
    } finally {
      db.close();
    }
  });

  it('effectiveStability = stability × pin_factor（强调只拉长 τ，不改稳定度本身）', () => {
    const { db, store } = makeStore([
      { id: 'plain', stability: 10, pinFactor: 1, lastAccess: T0 },
      { id: 'pinned', stability: 10, pinFactor: 5, lastAccess: T0 },
    ]);
    try {
      expect(get(store, 'plain', T0)?.effectiveStability).toBe(10);
      expect(get(store, 'pinned', T0)?.effectiveStability).toBe(50);
      // 同一时刻：被强调的那条**衰减更慢** ⇒ 强度更高
      const at = T0 + 5 * MS_PER_DAY;
      const plain = get(store, 'plain', at)?.intensity ?? 0;
      const pinned = get(store, 'pinned', at)?.intensity ?? 0;
      expect(pinned).toBeGreaterThan(plain);
      // τ = stability × pin_factor = 50 天；Δt = 5 天 ⇒ exp(-5/50) = exp(-0.1)
      expect(pinned).toBeCloseTo(Math.exp(-0.1), 12);
      expect(plain).toBeCloseTo(Math.exp(-0.5), 12); // 未强调：τ = 10 天 ⇒ exp(-0.5)
    } finally {
      db.close();
    }
  });

  it('★ 反例：把 `pin_factor` 乘到**分子**上（τ = stability / pin_factor）会让衰减变快', () => {
    const { db, store } = makeStore([{ id: 'm1', stability: 10, pinFactor: 5, lastAccess: T0 }]);
    try {
      const at = T0 + 5 * MS_PER_DAY;
      const correct = get(store, 'm1', at)?.intensity ?? 0;
      const wrong = Math.exp(-(at - T0) / ((10 / 5) * MS_PER_DAY));
      expect(correct).toBeCloseTo(Math.exp(-0.1), 12);
      expect(correct).toBeGreaterThan(wrong);
    } finally {
      db.close();
    }
  });

  it('★ 反例：把 layer 落库 / 固定返回一个值 ⇒ 同一行在不同时刻读出来的层级不会变', () => {
    const { db, store } = makeStore([{ id: 'm1', stability: 1, lastAccess: T0 }]);
    try {
      const early = get(store, 'm1', T0)?.layer;
      const late = get(store, 'm1', T0 + 30 * MS_PER_DAY)?.layer;
      expect(early).not.toBe(late);
    } finally {
      db.close();
    }
  });
});
