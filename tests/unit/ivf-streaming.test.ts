/**
 * ★ **流式读取的回归测试** —— P2 收官 · Q-06（训练峰值内存）。
 *
 * ⚠️ **这个文件测的是「改成流式之后，语义一点没变」**：
 *   `src/vector/ivf.ts` 的 `readVectorMemories()` 从 `.all()`（一次性物化 100 万行）
 *   改成了 `.iterate()`（逐行读、逐行解码）⇒ **返回值形状刻意不变**（仍是数组）
 *   ⇒ 「训练用的向量集合」与「迁移用的向量集合」**仍是同一批行、同一顺序**
 *   ⇒ 但**「改成流式」本身是有风险的**（BLOB 别名、顺序漂移、软删漏读）⇒
 *     ⇒ 这里用**三条独立断言**把那三个风险各钉死一条。
 *
 * ⚠️ ★ **三条断言分别对应三个真实风险**：
 *   ① **BLOB 别名**（流式读最典型的坑）：若 better-sqlite3 在迭代中**复用同一个
 *     Buffer**，那么 `.all()` 时代（物化 ⇒ 每行一份拷贝）看不出来，
 *     而 `.iterate()` 会让**所有行指向同一块内存** ⇒ 向量全错 ⇒ **静默**。
 *     ⇒ 断言：**每一行的向量都必须与它自己的 id 一一对应**。
 *   ② **顺序漂移**：初始中心 = **输入顺序的前 K 条**（§4.15.3 的确定性依据）
 *     ⇒ 顺序变了 ⇒ 整套桶变了 ⇒ 必须断言**按 rowid 升序**。
 *   ③ **软删漏读**：`readVectorMemories()` **含软删**（§8.2：软删保留向量）
 *     ⇒ 断言软删的行**也在**结果里、且 `deleted` 标记正确。
 *
 * ⚠️ **参考实现自己手写**（沿用本仓库的纪律：不复用被测模块的解码路径）。
 */

import { describe, expect, it } from 'vitest';

import { blobToVector, vectorToBlob } from '../../src/vector/centroids.js';
import { readVectorMemories } from '../../src/vector/ivf.js';
import { EMBED_DIM, createTestDb, pseudoUnitVector } from '../fixtures/vector.js';

/**
 * 参考解码（**独立于生产实现**）：`.all()` + 逐行读。
 *
 * ⚠️ **为什么参考实现用 `.all()`**：那正是**改动前**的实现形态 ⇒
 *   拿它当参考 ⇒ 断言就是「流式版 == 旧版」。
 *
 * @param db 库句柄
 * @returns 参考结果
 */
function readReference(db: ReturnType<typeof createTestDb>): Array<{
  id: string;
  values: number[];
  deleted: boolean;
}> {
  const rows = db
    .prepare(
      'SELECT id, embedding, deleted FROM memories WHERE embedding IS NOT NULL ORDER BY rowid',
    )
    .all() as Array<{ id: string; embedding: Buffer; deleted: number }>;
  return rows.map((row) => {
    const bytes = Buffer.from(row.embedding);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = Math.floor(bytes.byteLength / 4);
    const values: number[] = [];
    for (let index = 0; index < count; index += 1) {
      values.push(view.getFloat32(index * 4, true));
    }
    return { id: row.id, values, deleted: row.deleted === 1 };
  });
}

describe('P2 收官 · Q-06 · 流式读取的回归测试（语义一点没变）', () => {
  it('★ 流式版与 `.all()` 参考版**逐行逐位相同**（id / 向量值 / 软删标记）', () => {
    const db = createTestDb();
    try {
      const insert = db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
          'source, confidence, stability, difficulty, pin_factor, created_at, last_access, access_count) ' +
          'VALUES (@id, @kind, @content, @contentTokens, @contentHash, @embedding, ' +
          '@source, @confidence, @stability, @difficulty, @pinFactor, @createdAt, @lastAccess, @accessCount)',
      );
      // ⚠️ **故意乱序 id**（`m-07` 排在 `m-03` 前面）⇒ 若实现按 id 排序就会被抓住。
      const ids = ['m-07', 'm-03', 'm-11', 'm-01', 'm-09'];
      ids.forEach((id, index) => {
        insert.run({
          id,
          kind: 'fact',
          content: `内容 ${id}`,
          contentTokens: `内容 ${id}`,
          contentHash: `hash-${id}`,
          embedding: vectorToBlob(pseudoUnitVector(index + 1)),
          source: 'test',
          confidence: 0.7,
          stability: 30,
          difficulty: 0.5,
          pinFactor: 1,
          createdAt: 1_700_000_000_000,
          lastAccess: 1_700_000_000_000,
          accessCount: 1,
        });
      });

      const reference = readReference(db);
      const streamed = readVectorMemories(db);

      expect(streamed.length).toBe(reference.length);
      for (let index = 0; index < reference.length; index += 1) {
        const expected = reference[index];
        const actual = streamed[index];
        expect(actual).toBeDefined();
        expect(actual?.id).toBe(expected?.id);
        expect(actual?.deleted).toBe(expected?.deleted);
        expect(Array.from(actual?.vector ?? [])).toEqual(expected?.values);
      }
    } finally {
      db.close();
    }
  });

  it('★ **顺序按 rowid 升序**（不是按 id 排序）—— 初始中心 = 前 K 条 ⇒ 顺序即确定性', () => {
    const db = createTestDb();
    try {
      const insert = db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
          'source, confidence, stability, difficulty, pin_factor, created_at, last_access, access_count) ' +
          'VALUES (@id, @kind, @content, @contentTokens, @contentHash, @embedding, ' +
          '@source, @confidence, @stability, @difficulty, @pinFactor, @createdAt, @lastAccess, @accessCount)',
      );
      for (const id of ['z-01', 'a-02', 'm-03']) {
        insert.run({
          id,
          kind: 'fact',
          content: `内容 ${id}`,
          contentTokens: `内容 ${id}`,
          contentHash: `hash-${id}`,
          embedding: vectorToBlob(pseudoUnitVector(7)),
          source: 'test',
          confidence: 0.7,
          stability: 30,
          difficulty: 0.5,
          pinFactor: 1,
          createdAt: 1_700_000_000_000,
          lastAccess: 1_700_000_000_000,
          accessCount: 1,
        });
      }

      // ⚠️ **id 的字典序 ≠ rowid 顺序**（`z-01` < `a-02` < `m-03`，而 rowid 相反）。
      expect(readVectorMemories(db).map((row) => row.id)).toEqual(['z-01', 'a-02', 'm-03']);
    } finally {
      db.close();
    }
  });

  it('★ **软删的行也在**（软删保留向量，§8.2）且 `deleted` 标记正确', () => {
    const db = createTestDb();
    try {
      const insert = db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
          'source, confidence, stability, difficulty, pin_factor, created_at, last_access, access_count, deleted, deleted_at) ' +
          'VALUES (@id, @kind, @content, @contentTokens, @contentHash, @embedding, ' +
          '@source, @confidence, @stability, @difficulty, @pinFactor, @createdAt, @lastAccess, @accessCount, @deleted, @deletedAt)',
      );
      insert.run({
        id: 'live-1',
        kind: 'fact',
        content: '活着的',
        contentTokens: '活着的',
        contentHash: 'hash-live-1',
        embedding: vectorToBlob(pseudoUnitVector(1)),
        source: 'test',
        confidence: 0.7,
        stability: 30,
        difficulty: 0.5,
        pinFactor: 1,
        createdAt: 1_700_000_000_000,
        lastAccess: 1_700_000_000_000,
        accessCount: 1,
        deleted: 0,
        // ⚠️ **活着的行 `deleted_at` 必须是 NULL**（§3 的 CHECK 约束）。
        deletedAt: null,
      });
      insert.run({
        id: 'soft-1',
        kind: 'fact',
        content: '软删的',
        contentTokens: '软删的',
        contentHash: 'hash-soft-1',
        embedding: vectorToBlob(pseudoUnitVector(2)),
        source: 'test',
        confidence: 0.7,
        stability: 30,
        difficulty: 0.5,
        pinFactor: 1,
        createdAt: 1_700_000_000_000,
        lastAccess: 1_700_000_000_000,
        accessCount: 1,
        deleted: 1,
        // ⚠️ **软删必须同时给 `deleted_at`**（§3 的 CHECK 约束）。
        deletedAt: 1_700_000_000_001,
      });

      const rows = readVectorMemories(db);
      expect(rows.length).toBe(2);
      expect(rows.map((row) => [row.id, row.deleted])).toEqual([
        ['live-1', false],
        ['soft-1', true],
      ]);
    } finally {
      db.close();
    }
  });

  it('★ **每行的向量互不别名**（流式读最典型的坑：迭代器复用同一个 Buffer）', () => {
    const db = createTestDb();
    try {
      const insert = db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
          'source, confidence, stability, difficulty, pin_factor, created_at, last_access, access_count) ' +
          'VALUES (@id, @kind, @content, @contentTokens, @contentHash, @embedding, ' +
          '@source, @confidence, @stability, @difficulty, @pinFactor, @createdAt, @lastAccess, @accessCount)',
      );
      // ⚠️ **每行一个可区分的向量**（第 0 维 = 行号）⇒ 若 Buffer 被复用，
      //   所有行都会变成「最后一行」⇒ 断言立刻红。
      const count = 64;
      for (let index = 0; index < count; index += 1) {
        const vector = pseudoUnitVector(index + 1);
        vector[0] = index;
        insert.run({
          id: `m-${String(index).padStart(3, '0')}`,
          kind: 'fact',
          content: `内容 ${index}`,
          contentTokens: `内容 ${index}`,
          contentHash: `hash-${index}`,
          embedding: vectorToBlob(vector),
          source: 'test',
          confidence: 0.7,
          stability: 30,
          difficulty: 0.5,
          pinFactor: 1,
          createdAt: 1_700_000_000_000,
          lastAccess: 1_700_000_000_000,
          accessCount: 1,
        });
      }

      const rows = readVectorMemories(db);
      expect(rows.length).toBe(count);
      for (let index = 0; index < count; index += 1) {
        // ⚠️ **逐行核对第 0 维**（别名 ⇒ 全部等于 `count - 1`）。
        expect(rows[index]?.vector[0], `第 ${index} 行`).toBe(index);
      }
      // ⚠️ **每个向量是独立的存储**（不是同一块内存的两个视图）。
      const first = rows[0]?.vector;
      const second = rows[1]?.vector;
      expect(first?.buffer).not.toBe(second?.buffer);
    } finally {
      db.close();
    }
  });
});

describe('P2 收官 · Q-06 · `blobToVector` 不再整份拷贝（但结果逐位相同）', () => {
  it('★ 与「先拷贝再解码」的参考实现**逐位相同**', () => {
    const source = pseudoUnitVector(3);
    const blob = vectorToBlob(source);

    // ⚠️ **参考实现 = 旧写法**（`Buffer.from(blob)` 整份拷贝 + DataView 读）。
    const bytes = Buffer.from(blob);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expected = new Float32Array(Math.floor(bytes.byteLength / 4));
    for (let index = 0; index < expected.length; index += 1) {
      expected[index] = view.getFloat32(index * 4, true);
    }

    const actual = blobToVector(blob);
    expect(actual.length).toBe(expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      expect(Object.is(actual[index], expected[index]), `第 ${index} 维`).toBe(true);
    }
  });

  it('★ **不与源 Buffer 别名**（源 Buffer 后续被改动 ⇒ 解码结果不变）', () => {
    const blob = vectorToBlob(pseudoUnitVector(5));
    const decoded = blobToVector(blob);
    const before = decoded[0];

    // ⚠️ **把源 Buffer 全部改掉** ⇒ 若解码结果与源别名 ⇒ 这里会变。
    blob.fill(0);
    expect(decoded[0]).toBe(before);
  });

  it('★ **非对齐的 byteOffset 也能正确解码**（`DataView` 不要求对齐）', () => {
    const source = pseudoUnitVector(9);
    const blob = vectorToBlob(source);
    // ⚠️ **故意造一个 byteOffset 不对齐的视图**（偏移 1 字节 ⇒ 不是 4 的倍数）。
    const misaligned = Buffer.concat([Buffer.from([0]), blob]).subarray(1);
    expect(misaligned.byteOffset % 4).not.toBe(0);

    const decoded = blobToVector(misaligned);
    expect(decoded.length).toBe(source.length);
    for (let index = 0; index < source.length; index += 1) {
      expect(Object.is(decoded[index], source[index]), `第 ${index} 维`).toBe(true);
    }
  });

  it('★ 维度与 `EMBED_DIM` 一致（生产口径：768 维）', () => {
    const decoded = blobToVector(vectorToBlob(pseudoUnitVector(11)));
    expect(decoded.length).toBe(EMBED_DIM);
  });
});
