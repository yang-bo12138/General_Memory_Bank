/**
 * 向量层测试的**公共夹具** —— 确定性向量 + 真实内存库 + 落库辅助。
 *
 * ⚠️ **为什么用真库而不是 mock**：P2-T02 的硬断言大半是「**外键约束**」
 *   （细桶必属粗桶）、「**唯一索引**」（一条记忆只属一个细桶）、
 *   「**行级集合相等**」（对账口径）——这些只有真库才验得了。
 *
 * ⚠️ **夹具用的是 §3 的权威 DDL**（`src/db/schema.sql.ts` 的运行时副本），
 *   不是手抄的最小表 ⇒ 断言跑在**与生产同一套约束**上。
 *
 * ⚠️ **向量必须确定性**：随机向量会让「同分时的次序」不可复现 ⇒ 断言变成 flaky。
 */

import Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { vectorToBlob } from '../../src/vector/centroids.js';
import { normalize } from '../../src/vector/dot.js';

/** 向量维度（`EMBED_DIM` 是**只读**参数，§6）。 */
export const EMBED_DIM = DEFAULT_PARAMS.EMBED_DIM;

/** 建一个**空的**内存库（已执行 §3 的权威 DDL）。 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

/** 轴向量：第 `axis` 个分量为 1，其余为 0（模长**恰好** = 1）。 */
export function axisVector(axis: number): Float32Array {
  const vector = new Float32Array(EMBED_DIM);
  vector[axis] = 1;
  return vector;
}

/**
 * 确定性伪随机单位向量（线性同余发生器 ⇒ 每次跑出来一模一样）。
 *
 * ⚠️ **不用随机数**：随机向量会让「同分时的次序」不可复现 ⇒ 断言变成 flaky。
 */
export function pseudoUnitVector(seed: number): Float32Array {
  const raw = new Float32Array(EMBED_DIM);
  let state = (seed * 9301 + 49297) % 233280;
  for (let index = 0; index < EMBED_DIM; index += 1) {
    state = (state * 9301 + 49297) % 233280;
    raw[index] = (state / 233280) * 2 - 1;
  }
  return normalize(raw);
}

/** 落一条记忆的参数。 */
export interface InsertMemoryOptions {
  /** 上次访问时间（毫秒）。 */
  lastAccess?: number;
  /** pin 倍率（> 1 即被 pin）。 */
  pinFactor?: number;
  /** 是否软删（默认否）。 */
  deleted?: boolean;
}

/**
 * 往库里落一条带向量的记忆（**只落测试需要的最小列集**）。
 *
 * @param db 库句柄
 * @param id 记忆 id
 * @param vector 向量（**已 L2 归一化**）
 * @param options 其余字段
 */
export function insertMemory(
  db: Database.Database,
  id: string,
  vector: Float32Array,
  options: InsertMemoryOptions = {},
): void {
  const now = options.lastAccess ?? 1_700_000_000_000;
  const deleted = options.deleted === true ? 1 : 0;
  db.prepare(
    'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
      'stability, difficulty, pin_factor, created_at, last_access, deleted, deleted_at) ' +
      'VALUES (@id, @kind, @content, @contentTokens, @contentHash, @embedding, ' +
      '@stability, @difficulty, @pinFactor, @now, @now, @deleted, @deletedAt)',
  ).run({
    id,
    kind: 'fact',
    content: `内容 ${id}`,
    contentTokens: `内容 ${id}`,
    contentHash: `hash-${id}`,
    embedding: vectorToBlob(vector),
    stability: 100,
    difficulty: 0.5,
    pinFactor: options.pinFactor ?? 1,
    now,
    deleted,
    deletedAt: deleted === 1 ? now : null,
  });
}

/**
 * 落一批带向量的记忆（id 形如 `m-00`、`m-01`…）。
 *
 * @param db 库句柄
 * @param vectors 向量（**顺序即 id 顺序** ⇒ 也就是 rowid 顺序）
 * @param options 其余字段
 * @returns 落库的 id 列表
 */
export function insertMemories(
  db: Database.Database,
  vectors: readonly Float32Array[],
  options: InsertMemoryOptions = {},
): string[] {
  const ids: string[] = [];
  vectors.forEach((vector, index) => {
    const id = `m-${String(index).padStart(2, '0')}`;
    insertMemory(db, id, vector, options);
    ids.push(id);
  });
  return ids;
}
