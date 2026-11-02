/**
 * ★ **QA 独立验收的公共夹具** —— 阶段 5 · P3 独立验收（T03 的三个测试文件共用）。
 *
 * ⚠️ **本文件只放「建造世界」的工具，一条断言都不放**：
 *   断言全部写在各 `*.test.ts` 里，且**刻意不复用写手（`tests/integration/recall-vector-path.test.ts`）
 *   的断言、常量与工具函数** —— QA 的价值在于「不信写手的自述」，包括它的测试。
 *
 * ⚠️ **为什么不用 `tests/fixtures/vector.ts` 的 `insertMemory`**：
 *   它把 `content` 写死成 `内容 ${id}`、`stability` 写死成 100 ⇒
 *   造不出「文本路能命中」与「已归档」这两类世界（而 T03 的四种处境与闸门顺序都要它们）。
 *   本文件因此自带一份可控制正文 / 稳定度 / 时间 / 实体的插入函数。
 *   ⚠️ 但它**仍然复用** `tests/fixtures/vector.ts` 的 `createTestDb`（§3 的权威 DDL）
 *     与 `pseudoUnitVector` 的口径 —— 那是**夹具**，不是断言，复用不会污染结论。
 *
 * ⚠️ **确定性**：本文件没有任何 `Math.random()` / `Date.now()` / 真实时钟
 *   ⇒ 同一份入参两次跑出**逐位相同**的世界（C37 的注入时钟口径）。
 */

import Database from 'better-sqlite3';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { tokenize } from '../../src/core/tokenize.js';
import { createSchema } from '../../src/db/connection.js';
import { EventWriter } from '../../src/store/events.js';
import type { RecallStore } from '../../src/store/recall.js';
import { MemoryLogger } from '../../src/util/log.js';
import { vectorToBlob } from '../../src/vector/centroids.js';
import { normalize } from '../../src/vector/dot.js';

/** 向量维度（`EMBED_DIM` 是只读参数）。 */
export const QA_DIM = DEFAULT_PARAMS.EMBED_DIM;

/** 一天的毫秒数（时间窗断言全用它换算）。 */
export const QA_DAY = 86_400_000;

/** 固定的注入时钟（C37）。 */
export const QA_NOW = 1_700_000_000_000;

/**
 * 本组测试统一用的参数：**显式 flat**（后端确定、无中心模型）+ 关掉抑制与共激活。
 *
 * ⚠️ 为什么关掉后两个机制：本组验的是**向量路**，而抑制会重排 hits、扩散会填 `diffused`
 *   ⇒ 打开它们会让「某条 hit 在不在」变成多个机制叠加的结果，断言不再指向单一原因。
 *   ⚠️ 它们各自有专门的测试文件（`inhibit-acceptance` / `neuro`），覆盖不会因此变窄。
 */
export const QA_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  VECTOR_ROUTER: 'flat',
  inhibition: false,
  coactivation: false,
};

/** 确定性伪随机数发生器（线性同余；**不用 `Math.random()`**）。 */
export function qaLcg(seed: number): () => number {
  let state = seed % 233280;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

/** 确定性单位向量（`seed` 相同 ⇒ 逐位相同）。 */
export function qaUnitVector(seed: number): Float32Array {
  const next = qaLcg(seed);
  const raw = new Float32Array(QA_DIM);
  for (let index = 0; index < QA_DIM; index += 1) {
    raw[index] = next() * 2 - 1;
  }
  return normalize(raw);
}

/** 第 `axis` 个分量为 1 的单位向量（模长恰好 1）。 */
export function qaAxisVector(axis: number): Float32Array {
  const vector = new Float32Array(QA_DIM);
  vector[axis] = 1;
  return vector;
}

/**
 * 与 `qaAxisVector(0)` 的余弦**恰好等于** `Math.fround(cos)` 的向量。
 *
 * ⚠️ `dot()` 是「float64 累加 float32 分量之积」⇒ `unit(0) · v = v[0]`（一个 float32 值）
 *   ⇒ 「期望的 cos」就是 `Math.fround(cos)`，可以写 `toBe` 而不是 `toBeCloseTo`。
 */
export function qaVectorAtCos(cos: number): Float32Array {
  const vector = new Float32Array(QA_DIM);
  vector[0] = cos;
  vector[1] = Math.sqrt(1 - cos * cos);
  return vector;
}

/** `Float32Array` → `number[]`（`RecallOptions.queryEmbedding` 的口径）。 */
export function qaNumbers(vector: Float32Array): number[] {
  return [...vector];
}

/** 一条要落进手建世界的记忆。 */
export interface QaSeedRow {
  /** 记忆 id（也是排序与断言的锚）。 */
  id: string;
  /** 正文（**默认 `内容 ${id}`**）。 */
  content?: string;
  /** 向量：`null` = 没有向量；`undefined` = `qaAxisVector(0)`。 */
  vector?: Float32Array | null;
  /** 上次访问时刻（默认 `QA_NOW - 1 小时`）。 */
  lastAccess?: number;
  /** 稳定度（天，默认 100）。 */
  stability?: number;
  /** pin 倍率（默认 1）。 */
  pinFactor?: number;
  /** 实体名（同时用作 `entities.id`）。 */
  entityNames?: readonly string[];
}

/** 手建世界的产物（`db` 是自查 `events` / `memories` 用的）。 */
export interface QaWorld {
  db: Database.Database;
  /** 基础上下文（**不带**向量端口；要端口的用例自己条件展开，见 `qaStoreWithVector`）。 */
  context: RecallStore;
}

/**
 * 建一个手建世界：内存库 + 权威 DDL + 若干记忆（可带实体）。
 *
 * @param params 生效参数
 * @param rows 要落的记忆
 * @returns 库句柄与不带端口的基础上下文
 */
export function qaCreateWorld(params: Params, rows: readonly QaSeedRow[]): QaWorld {
  const db = new Database(':memory:');
  createSchema(db);

  const insertMemory = db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding,
                           stability, difficulty, pin_factor, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @embedding,
             @stability, 0.5, @pinFactor, @createdAt, @lastAccess, 0, 0, NULL)`,
  );
  const insertEntity = db.prepare(
    "INSERT OR IGNORE INTO entities (id, name, type, created_at) VALUES (?, ?, 'concept', ?)",
  );
  const linkEntity = db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)',
  );

  for (const row of rows) {
    const content = row.content ?? `内容 ${row.id}`;
    const vector = row.vector === undefined ? qaAxisVector(0) : row.vector;
    insertMemory.run({
      id: row.id,
      content,
      tokens: tokenize(content),
      hash: `hash-${row.id}`,
      embedding: vector === null ? null : vectorToBlob(vector),
      stability: row.stability ?? 100,
      pinFactor: row.pinFactor ?? 1,
      createdAt: QA_NOW - 5 * QA_DAY,
      lastAccess: row.lastAccess ?? QA_NOW - 3_600_000,
    });
    for (const entityName of row.entityNames ?? []) {
      insertEntity.run(entityName, entityName, QA_NOW);
      linkEntity.run(row.id, entityName);
    }
  }

  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => QA_NOW,
  });

  return { db, context: { db, params, events } };
}

/** 读 `recall` 事件里记的 `vectorUsed`（按事件 id 升序）。 */
export function qaReadVectorUsed(db: Database.Database): boolean[] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE type = 'recall' ORDER BY id")
    .all() as Array<{ payload: string }>;
  return rows.map((row) => (JSON.parse(row.payload) as { vectorUsed: boolean }).vectorUsed);
}

/** 读库里一条记忆的向量 BLOB 长度（`null` = 没有向量行）。 */
export function qaEmbeddingBytes(db: Database.Database, id: string): number | null {
  const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as
    | { embedding: Buffer | null }
    | undefined;
  if (row === undefined || row.embedding === null) {
    return null;
  }
  return row.embedding.byteLength;
}
