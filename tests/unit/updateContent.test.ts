/**
 * `updateContent()` 的单测 —— DESIGN-v2.md §4.9.1（显式修正正文），对应 **P4-T03**。
 *
 * ★ 本文件重点守四件事（都是「不报错但结论错」的那一类）：
 *   ① **不加固**：`stability` / `last_access` / `access_count` 一个都不许动；
 *   ② **不传向量 ⇒ 置 NULL**（不是「留着旧向量」）：旧向量指向的正文已经不存在了；
 *   ③ **hash 与 `write()` 同口径**：用「`write(同一段文本)` 会命中合并」来**间接证明**；
 *   ④ **桶归属跟着向量走**：传了向量 ⇒ 入桶；不传 ⇒ 退桶。
 */

import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { normalize } from '../../src/core/tokenize.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { EventWriter } from '../../src/store/events.js';
import { type UpdateContentStore, updateContent } from '../../src/store/updateContent.js';
import { write } from '../../src/store/write.js';
import { MemoryLogger } from '../../src/util/log.js';
import { CentroidCache } from '../../src/vector/centroids.js';
import { vectorToBlob } from '../../src/vector/centroids.js';
import { normalizeNumbers } from '../../src/vector/dot.js';

const P: Params = DEFAULT_PARAMS;
const T0 = 1_700_000_000_000;
const NOW = T0 + 86_400_000;
const DIM = P.EMBED_DIM;

/** 与实现同口径的 hash（`sha1(normalize(text))`）—— 冲突用例必须**真的撞上**。 */
function hashOf(text: string): string {
  return createHash('sha1').update(normalize(text), 'utf8').digest('hex');
}

/** 一维 one-hot 向量（第 `slot` 位为 1，其余 0）⇒ 归一化后仍是它自己。 */
function oneHot(slot: number): number[] {
  const values = new Array<number>(DIM).fill(0);
  values[slot] = 1;
  return values;
}

interface Fixture {
  db: Database.Database;
  store: UpdateContentStore;
  id: string;
}

/**
 * 建库 + 一个粗桶 + 一个细桶（中心 = e0）+ 一条**已在桶里**的记忆。
 */
function makeStore(
  seed: { deleted?: boolean; withEmbedding?: boolean; readonly?: boolean; content?: string } = {},
): Fixture {
  const id = 'm1';
  const content = seed.content ?? '她把猫粮记错了';
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // 中心：粗 / 细各一条，中心都是 e0
  const centroid = vectorToBlob(normalizeNumbers(oneHot(0)));
  db.prepare(
    'INSERT INTO vector_coarse_cells (coarse_id, centroid, updated_at) VALUES (?, ?, ?)',
  ).run('c1', centroid, T0);
  db.prepare(
    'INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at) VALUES (?, ?, ?, ?)',
  ).run('f1', 'c1', centroid, T0);

  const deleted = seed.deleted === true;
  db.prepare(
    `INSERT INTO memories (
       id, kind, content, content_tokens, content_hash, embedding, stability, difficulty, pin_factor,
       created_at, last_access, access_count, deleted, deleted_at
     ) VALUES (
       @id, 'fact', @content, @tokens, @hash, @embedding, 2.0, 0.5, 1.0, @t0, @t0, 7, @deleted, @deletedAt
     )`,
  ).run({
    id,
    content,
    tokens: '她把 把猫 猫粮 粮记 记错 错了',
    hash: 'old-hash',
    embedding: seed.withEmbedding === false ? null : centroid,
    t0: T0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? T0 : null,
  });
  if (seed.withEmbedding !== false) {
    db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run('f1', id);
  }

  const cache = new CentroidCache(db);
  const events = new EventWriter(db, {
    readonly: seed.readonly === true,
    logger: new MemoryLogger(),
    now: () => NOW,
  });
  return {
    db,
    store: {
      db,
      params: P,
      events,
      buckets: { db, centroids: () => cache.model(), nprobeCoarse: P.ROUTER_NPROBE_COARSE },
    },
    id,
  };
}

interface Row {
  content: string;
  content_tokens: string;
  content_hash: string;
  stability: number;
  last_access: number;
  access_count: number;
  embedding: Buffer | null;
}

function readRow(db: Database.Database, id: string): Row {
  return db
    .prepare(
      `SELECT content, content_tokens, content_hash, stability, last_access, access_count, embedding
         FROM memories WHERE id = ?`,
    )
    .get(id) as Row;
}

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

describe('updateContent · 正常修正', () => {
  it('正文 / tokens / hash 全部更新；旧正文进 `content_history`（reason=manual_fix）', () => {
    const { db, store, id } = makeStore();
    try {
      updateContent(store, id, '她不喜欢猫粮', NOW, oneHot(0));

      const row = readRow(db, id);
      expect(row.content).toBe('她不喜欢猫粮');
      expect(row.content_tokens).toContain('不喜'); // 分词结果真的换了（不是照抄）
      expect(row.content_hash).not.toBe('old-hash');

      const history = db
        .prepare('SELECT content, reason FROM content_history WHERE memory_id = ?')
        .all(id) as Array<{ content: string; reason: string }>;
      expect(history).toEqual([{ content: '她把猫粮记错了', reason: 'manual_fix' }]);
    } finally {
      db.close();
    }
  });

  it('★ 不加固：`stability` / `last_access` / `access_count` 一个都不动', () => {
    const { db, store, id } = makeStore();
    try {
      const before = readRow(db, id);
      updateContent(store, id, '她不喜欢猫粮', NOW, oneHot(0));
      const after = readRow(db, id);

      expect(after.stability).toBe(before.stability);
      expect(after.last_access).toBe(before.last_access);
      expect(after.access_count).toBe(before.access_count);
    } finally {
      db.close();
    }
  });

  it('事件 `manual_fix`：含 `hasEmbedding` 与 `prevContentLength`', () => {
    const { db, store, id } = makeStore();
    try {
      const prevLength = readRow(db, id).content.length;
      updateContent(store, id, '她不喜欢猫粮', NOW, oneHot(0));

      const event = readEvents(db).find((item) => item.type === 'manual_fix');
      expect(event?.payload).toMatchObject({
        id,
        contentText: '她不喜欢猫粮',
        contentLength: '她不喜欢猫粮'.length,
        prevContentLength: prevLength,
        hasEmbedding: true,
      });
    } finally {
      db.close();
    }
  });
});

describe('updateContent · 幂等与冲突', () => {
  it('★ 幂等：同一段文本再调一次 ⇒ 直接返回，`content_history` 行数不变、不再记事件', () => {
    const { db, store, id } = makeStore();
    try {
      updateContent(store, id, '她不喜欢猫粮', NOW, oneHot(0));
      const historyCount = db.prepare('SELECT count(*) AS n FROM content_history').get();
      const eventCount = readEvents(db).length;

      // 第二次（甚至可以故意传个更长的向量：幂等返回时**不该**校验或更新向量）
      updateContent(store, id, '她不喜欢猫粮', NOW, oneHot(1));

      expect(db.prepare('SELECT count(*) AS n FROM content_history').get()).toEqual(historyCount);
      expect(readEvents(db)).toHaveLength(eventCount);
      // 向量**没被覆盖**（幂等返回不碰 embedding）
      expect(readRow(db, id).embedding?.equals(vectorToBlob(normalizeNumbers(oneHot(0))))).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  it('★ 冲突：改成另一条未删记忆的正文 ⇒ CONFLICT（带 conflictingId），库内状态未变', () => {
    const { db, store, id } = makeStore();
    try {
      db.prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash, stability, difficulty,
                               pin_factor, created_at, last_access, access_count, deleted, deleted_at)
         VALUES ('m2', 'fact', '另一条', '另一 一条', @hash, 1.0, 0.5, 1.0, @t0, @t0, 0, 0, NULL)`,
      ).run({ hash: hashOf('另一条'), t0: T0 });

      const before = readRow(db, id);
      let caught: MemoryError | undefined;
      try {
        updateContent(store, id, '另一条', NOW, oneHot(0));
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.CONFLICT);
      expect(caught?.details.conflictingId).toBe('m2');
      expect(readRow(db, id)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('软删的记忆不接受修正 ⇒ NOT_FOUND', () => {
    const { db, store, id } = makeStore({ deleted: true });
    try {
      let caught: MemoryError | undefined;
      try {
        updateContent(store, id, '随便', NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.NOT_FOUND);
    } finally {
      db.close();
    }
  });

  it('向量维度不对 ⇒ INVALID_INPUT，且**事务回滚**（正文没被改）', () => {
    const { db, store, id } = makeStore();
    try {
      const before = readRow(db, id);
      let caught: MemoryError | undefined;
      try {
        updateContent(store, id, '新正文', NOW, [1, 2, 3]);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.INVALID_INPUT);
      expect(readRow(db, id)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe('updateContent · 向量与桶归属', () => {
  it('★ 不传向量 ⇒ 置 NULL **且退桶**（桶里留一条无向量的行会让桶计数偏大）', () => {
    const { db, store, id } = makeStore();
    try {
      updateContent(store, id, '她不喜欢猫粮', NOW);

      expect(readRow(db, id).embedding).toBeNull();
      expect(
        db.prepare('SELECT count(*) AS n FROM vector_cell_members WHERE memory_id = ?').get(id),
      ).toEqual({
        n: 0,
      });
      // 反例：事件里也必须说「没有向量了」
      expect(readEvents(db).find((item) => item.type === 'manual_fix')?.payload.hasEmbedding).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });

  it('★ 传新向量 ⇒ 向量更新 **且桶归属同步**（换桶不残留）', () => {
    const { db, store, id } = makeStore();
    try {
      updateContent(store, id, '她不喜欢猫粮', NOW, oneHot(0));

      const row = readRow(db, id);
      expect(row.embedding).not.toBeNull();
      expect(
        db.prepare('SELECT fine_id AS fineId FROM vector_cell_members WHERE memory_id = ?').all(id),
      ).toEqual([{ fineId: 'f1' }]);
    } finally {
      db.close();
    }
  });

  it('★ hash 与 `write()` 同口径：`write(同一段文本)` 会命中合并（id 不变）', () => {
    const { db, store, id } = makeStore();
    try {
      updateContent(store, id, '她不喜欢猫粮', NOW, oneHot(0));

      // `write()` 走完整去重：若两者算出的 hash 不同，这里会**新建一条**而不是合并
      const result = write(
        { db, params: P, events: store.events, logger: new MemoryLogger(), buckets: store.buckets },
        { content: '她不喜欢猫粮' },
      );
      expect(result.merged).toBe(true);
      expect(result.id).toBe(id);
      expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
