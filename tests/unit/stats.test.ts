/**
 * `stats()` 的单测 —— DESIGN-v2.md §6 的 `MemoryStats`（20 字段）+ §11.4，对应 **P4-T05**。
 *
 * ★ 本文件重点守五件事：
 *   ① **20 个字段全在**（在类型层由 `MemoryStats` 保证；这里再在**运行时**逐键点一遍——
 *      类型只在编译期有效，而「实现漏填一个字段」在 JS 调用方那里是 `undefined`）；
 *   ② **不扫 `coacts`**（§11.4 的观测纪律）—— 用**源码静态扫描**守：本模块里不得出现对它的查询；
 *   ③ **`archivalMissing` 的 null 语义**（`ready=0` ⇒ `null`，不是 0）；
 *   ④ **`mode` 四值互斥**（C36 的核心断言）；
 *   ⑤ **`inRetrain` 的作用域**（`flat_auto` 恒 false，即使维护器说它在重训）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { COACT_WRITE_DROPS_KEY, addCoactWriteDrops } from '../../src/neuron/coacts.js';
import { setArchivalReady } from '../../src/store/archival.js';
import { clusters } from '../../src/store/clusters.js';
import { type StatsStore, resolveVectorBackendMode, stats } from '../../src/store/stats.js';

const T0 = 1_700_000_000_000;
const NOW = T0 + 30 * 86_400_000;
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 20 个字段（**写死的期望值**：缺一个就该红，而不是「实现有几个就算几个」）。 */
const EXPECTED_FIELDS = [
  'total',
  'l3Count',
  'l2Count',
  'l1Count',
  'archivedCount',
  'deletedCount',
  'edgeCount',
  'entityCount',
  'vectorBackend',
  'avgStability',
  'medianStability',
  'touchRate7d',
  'mergeRate',
  'graphDensity',
  'adoptedMemories',
  'embeddedRatio',
  'archivalOrphans',
  'archivalMismatch',
  'archivalMissing',
  'coactWriteDrops',
] as const;

interface Fixture {
  db: Database.Database;
  store: StatsStore;
  params: Params;
  setRetrain: (value: boolean) => void;
}

/** 建库 + 若干记忆（可指定稳定性 / 是否带向量 / access_count）。 */
function makeStore(
  seed: { memories?: boolean; inRetrain?: boolean; params?: Partial<Params> } = {},
): Fixture {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const params: Params = { ...DEFAULT_PARAMS, ...seed.params };
  // 中文注释：固定 embedder 维度用参数表的 EMBED_DIM（默认 768），这里只造「非 null」的 BLOB
  const blob = Buffer.alloc(params.EMBED_DIM * 4);

  if (seed.memories !== false) {
    const insert = db.prepare(
      `INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, stability,
                             difficulty, pin_factor, created_at, last_access, access_count, deleted, deleted_at)
       VALUES (@id, 'fact', @content, 'x', @hash, @embedding, @stability, 0.5, 1.0, @t0, @lastAccess,
               @accessCount, @deleted, @deletedAt)`,
    );
    // 三条未删：L3（刚访问）/ L1（久未访问）/ archived（极久未访问）
    insert.run({
      id: 'm1',
      content: 'm1',
      hash: 'h1',
      embedding: blob,
      stability: 100,
      t0: T0,
      lastAccess: NOW,
      accessCount: 2,
      deleted: 0,
      deletedAt: null,
    });
    insert.run({
      id: 'm2',
      content: 'm2',
      hash: 'h2',
      embedding: null,
      stability: 2,
      t0: T0,
      lastAccess: T0,
      accessCount: 0,
      deleted: 0,
      deletedAt: null,
    });
    insert.run({
      id: 'm3',
      content: 'm3',
      hash: 'h3',
      embedding: null,
      stability: 0.5,
      t0: T0,
      lastAccess: T0,
      accessCount: 0,
      deleted: 0,
      deletedAt: null,
    });
    // 一条软删
    insert.run({
      id: 'm4',
      content: 'm4',
      hash: 'h4',
      embedding: null,
      stability: 1,
      t0: T0,
      lastAccess: T0,
      accessCount: 0,
      deleted: 1,
      deletedAt: T0,
    });
  }

  // 两个实体 + 一条边（`graphDensity` 用得上）
  // ⚠️ 空库用例要**真的空**：否则 `graphDensity` 会是 0.5 而不是 0
  //   （那会让「除以 0 个实体 ⇒ 不能变成 NaN」这条断言测的不是它想测的东西）
  if (seed.memories !== false) {
    db.prepare(
      `INSERT INTO entities (id, name, type, created_at) VALUES ('e1', '甲', 'person', ?)`,
    ).run(T0);
    db.prepare(
      `INSERT INTO entities (id, name, type, created_at) VALUES ('e2', '乙', 'person', ?)`,
    ).run(T0);
    db.prepare(
      `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
       VALUES ('edge1', 'e1', '认识', 'e2', NULL, 0.8, ?, ?)`,
    ).run(T0, T0);
  }

  let retrain = seed.inRetrain === true;
  return {
    db,
    params,
    store: { db, params, inRetrain: () => retrain },
    setRetrain: (value: boolean) => {
      retrain = value;
    },
  };
}

describe('stats · 字段与计数', () => {
  it('★ 20 个字段全在（写死的分母 + 运行时逐键点一遍）', () => {
    const { db, store } = makeStore();
    try {
      const result = stats(store, NOW);
      expect(Object.keys(result).sort()).toEqual([...EXPECTED_FIELDS].sort());
      expect(EXPECTED_FIELDS).toHaveLength(20);
      // vectorBackend 内部的 10~11 个键也在
      for (const key of [
        'mode',
        'inRetrain',
        'coarseCells',
        'fineCells',
        'members',
        'maxBucketSize',
        'p95BucketSize',
        'centroidsUpdatedAt',
        'count',
        'dimensions',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(result.vectorBackend, key), key).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('计数：total / deletedCount / edgeCount / entityCount 与库里的行数一致', () => {
    const { db, store } = makeStore();
    try {
      const result = stats(store, NOW);
      expect(result.total).toBe(3);
      expect(result.deletedCount).toBe(1);
      expect(result.edgeCount).toBe(1);
      expect(result.entityCount).toBe(2);
      expect(result.l3Count + result.l2Count + result.l1Count + result.archivedCount).toBe(3);
    } finally {
      db.close();
    }
  });

  it('指标：avg/medianStability / adoptedMemories / embeddedRatio / graphDensity', () => {
    const { db, store } = makeStore();
    try {
      const result = stats(store, NOW);
      // 稳定性 100 / 2 / 0.5 ⇒ 均值 34.1666…、中位数 2
      expect(result.avgStability).toBeCloseTo((100 + 2 + 0.5) / 3, 10);
      expect(result.medianStability).toBe(2);
      expect(result.adoptedMemories).toBe(1); // 只有 m1 的 access_count > 0
      expect(result.embeddedRatio).toBeCloseTo(1 / 3, 10);
      expect(result.graphDensity).toBe(0.5); // 1 边 / 2 实体
    } finally {
      db.close();
    }
  });

  it('★ 空库：所有计数为 0、比值为 0（**不是 NaN**）', () => {
    const { db, store } = makeStore({ memories: false });
    try {
      const result = stats(store, NOW);
      expect(result.total).toBe(0);
      expect(result.avgStability).toBe(0);
      expect(result.medianStability).toBe(0);
      expect(result.touchRate7d).toBe(0);
      expect(result.mergeRate).toBe(0);
      expect(result.embeddedRatio).toBe(0);
      // 空库的 graphDensity 也要是 0（除以 0 个实体 ⇒ 不能变成 NaN）
      expect(result.graphDensity).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('stats · 观测纪律（不探派生快照）', () => {
  it('★ 源码里没有对 `coacts` 的查询（不扫共激活表算统计）', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/store/stats.ts'), 'utf8');
    // ⚠️ 判据是「有没有把 coacts 写进 SQL」，不是「有没有提到这个词」：
    //   注释里可以提到它（本文件的头注释就在解释「为什么不许扫」）。
    for (const pattern of [/FROM\s+coacts/i, /JOIN\s+coacts/i, /INTO\s+coacts/i]) {
      expect(pattern.test(source), String(pattern)).toBe(false);
    }
  });

  it('★ `coactWriteDrops` 是**累计计数器**（读 meta 一行，不扫表）', () => {
    const { db, store } = makeStore();
    try {
      expect(stats(store, NOW).coactWriteDrops).toBe(0);
      // 写入侧累加（`writeCoactivations` 收尾处唯一调用点）
      addCoactWriteDrops(db, 2);
      addCoactWriteDrops(db, 3);
      // ⚠️ 比**数值**而不是字符串：SQLite 的 REAL→TEXT 会写成 `5.0`
      //   （实现里已显式整数化，但这条断言不该依赖存储形态）
      const stored = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(COACT_WRITE_DROPS_KEY) as {
        value: string;
      };
      expect(Number(stored.value)).toBe(5);
      expect(stats(store, NOW).coactWriteDrops).toBe(5);
    } finally {
      db.close();
    }
  });

  it('★ 累计计数器的**唯一调用点**用的是「与 touch 返回值同源」的口径', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/neuron/coacts.ts'), 'utf8');
    // ⇒ 若有人把它改成 `result.pairs.length` 或只取 `truncated`，这条会红
    expect(source).toContain(
      'addCoactWriteDrops(db, result.truncated + result.skippedInvalidSeed)',
    );
  });

  it('`adoptedMemories` 与 `clusters()` 的采纳面口径一致（同一个定义）', () => {
    const { db, store, params } = makeStore();
    try {
      const result = stats(store, NOW);
      const clusterView = clusters({ db, params }, undefined, NOW);
      expect(result.adoptedMemories).toBe(clusterView.adoptedMemories);
    } finally {
      db.close();
    }
  });
});

describe('stats · 归档自检', () => {
  it('★ `archivalMissing`：ready=0 时返回 **null**（不是 0）', () => {
    const { db, store, params } = makeStore();
    try {
      // 新建库里没有 archival_schedule 的行，且 ready 标记不存在 ⇒ 未就绪
      setArchivalReady(db, false);
      expect(stats(store, NOW).archivalMissing).toBeNull();
      // 反例：置就绪后它是一个数字（此时缺 3 行）
      setArchivalReady(db, true);
      const ready = stats(store, NOW);
      expect(ready.archivalMissing).toBe(3);
      void params;
    } finally {
      db.close();
    }
  });

  it('`archivalOrphans`：正常库为 0；人为造孤儿 ⇒ 非 0（护栏可观测）', () => {
    const { db, store } = makeStore();
    try {
      expect(stats(store, NOW).archivalOrphans).toBe(0);
      db.prepare('INSERT INTO archival_schedule (memory_id, archive_at) VALUES (?, ?)').run(
        'm4', // 已软删 ⇒ 缓存里不该有它
        NOW,
      );
      expect(stats(store, NOW).archivalOrphans).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('stats · vectorBackend 的四态', () => {
  it('★ `flat_explicit`：调用方显式选了 flat（那是**要求**，不是降级）', () => {
    const { db, store } = makeStore({ params: { VECTOR_ROUTER: 'flat' } });
    try {
      expect(stats(store, NOW).vectorBackend.mode).toBe('flat_explicit');
      // flat 模式下 indexBytes 必须**缺席**（没有独立索引文件）
      expect('indexBytes' in stats(store, NOW).vectorBackend).toBe(false);
    } finally {
      db.close();
    }
  });

  it('★ `flat_auto`：库太小（已嵌向量数 < ROUTER_MIN_TRAINING）', () => {
    const { db, store } = makeStore();
    try {
      expect(stats(store, NOW).vectorBackend.mode).toBe('flat_auto');
    } finally {
      db.close();
    }
  });

  it('★ `absent`：过了门槛但没有可用细桶（**不是**「曾经调用过重训」）', () => {
    const { db, store, params } = makeStore({ params: { ROUTER_MIN_TRAINING: 1 } });
    try {
      // 有一条带向量的记忆 ⇒ 过了门槛；但没有细桶 ⇒ absent
      expect(params.ROUTER_MIN_TRAINING).toBe(1);
      expect(stats(store, NOW).vectorBackend.mode).toBe('absent');
    } finally {
      db.close();
    }
  });

  it('★ `ivf`：存在可用细桶', () => {
    const { db, store } = makeStore({ params: { ROUTER_MIN_TRAINING: 1 } });
    try {
      const blob = Buffer.alloc(DEFAULT_PARAMS.EMBED_DIM * 4);
      db.prepare(
        'INSERT INTO vector_coarse_cells (coarse_id, centroid, updated_at) VALUES (?, ?, ?)',
      ).run('c1', blob, T0);
      db.prepare(
        'INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at) VALUES (?, ?, ?, ?)',
      ).run('f1', 'c1', blob, T0);
      db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
        'f1',
        'm1',
      );

      const backend = stats(store, NOW).vectorBackend;
      expect(backend.mode).toBe('ivf');
      expect(backend.coarseCells).toBe(1);
      expect(backend.fineCells).toBe(1);
      expect(backend.members).toBe(1);
      expect(backend.maxBucketSize).toBe(1);
      expect(backend.centroidsUpdatedAt).toBe(T0);
      expect(backend.dimensions).toBe(DEFAULT_PARAMS.EMBED_DIM);
      expect(typeof backend.indexBytes).toBe('number');
    } finally {
      db.close();
    }
  });

  it('★ `inRetrain` 的作用域：`flat_auto` 时**恒 false**（即使维护器在重训）', () => {
    const { db, store, setRetrain } = makeStore({ inRetrain: true });
    try {
      // 维护器说「在重训」
      expect(store.inRetrain()).toBe(true);
      // 但 flat_auto 根本没建桶 ⇒ 没有「重训」这件事 ⇒ 必须是 false
      expect(stats(store, NOW).vectorBackend.inRetrain).toBe(false);
      setRetrain(false);
    } finally {
      db.close();
    }
  });

  it('`resolveVectorBackendMode` 与 `stats()` 用的是**同一个函数**（不各算一套）', () => {
    const { db, store, params } = makeStore({ params: { ROUTER_MIN_TRAINING: 1 } });
    try {
      expect(stats(store, NOW).vectorBackend.mode).toBe(resolveVectorBackendMode(db, params));
    } finally {
      db.close();
    }
  });
});
