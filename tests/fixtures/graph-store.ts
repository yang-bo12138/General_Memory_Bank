/**
 * store 层测试的公共夹具 —— **真实的 SQLite 库**（内存库）+ store 上下文。
 *
 * ⚠️ **为什么用内存库而不是 mock**：`link` / `touch` / `mergeEntities` 的硬断言
 *   大多是「**事务回滚**」「**UPSERT 语义**」「**外键级联**」——
 *   这些只有真库才验得了（mock 库不实现事务，也不校验约束）。
 *
 * ⚠️ **内存库不落盘 ⇒ 不污染仓库**（`pnpm run verify` 跑完不留任何临时文件）。
 *   `PRAGMA foreign_keys = ON` 由 `createSchema()` 里的建库脚本打开（§9.1：
 *   外键是**每连接**开关，默认关闭）。
 */

import Database from 'better-sqlite3';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { createSchema } from '../../src/db/connection.js';
import { EventWriter } from '../../src/store/events.js';
import type { GraphStore } from '../../src/store/link.js';
import { MemoryLogger } from '../../src/util/log.js';

/** 一条事件的落库形状（只取测试要断言的字段）。 */
export interface StoredEvent {
  type: string;
  memory_id: string | null;
  payload: Record<string, unknown>;
  at: number;
}

/** 插入记忆时的可选覆盖项。 */
export interface MemoryOverrides {
  stability?: number;
  difficulty?: number;
  lastAccess?: number;
  accessCount?: number;
  /** 软删（`deleted = 1`）——用来验「软删的 id 也算缺失」。 */
  deleted?: boolean;
  createdAt?: number;
  content?: string;
}

/** 测试用的 store 上下文（`GraphStore` / `EntityStore` / `TouchStore` 的共同形状）。 */
export interface TestStore {
  db: Database.Database;
  /** 传给 `link` / `linkByIds` / `setAlias` / `mergeEntities` / `touch` 的上下文。 */
  store: GraphStore;
  /** 生效参数（断言一律引用它，不写死数字）。 */
  params: Params;
}

/** 建一个全新的内存库 + store 上下文。 */
export function createTestStore(): TestStore {
  const db = new Database(':memory:');
  createSchema(db);
  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => 0,
  });
  const params = DEFAULT_PARAMS;
  return { db, store: { db, params, events }, params };
}

/** 统计某张表的行数。 */
export function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** 建一个实体（返回它的 id）。 */
export function insertEntity(
  db: Database.Database,
  id: string,
  name: string,
  createdAt = 0,
): string {
  db.prepare('INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    'concept',
    createdAt,
  );
  return id;
}

/** 建一条记忆。 */
export function insertMemory(
  db: Database.Database,
  id: string,
  overrides: MemoryOverrides = {},
): void {
  const deleted = overrides.deleted === true;
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                           stability, difficulty, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @stability, @difficulty,
             @createdAt, @lastAccess, @accessCount, @deleted, @deletedAt)`,
  ).run({
    id,
    content: overrides.content ?? `内容 ${id}`,
    tokens: `内容 ${id}`,
    // ⚠️ `content_hash` 在 `deleted = 0` 上有 UNIQUE 部分索引 ⇒ 每个 id 一个独立哈希。
    hash: `hash-${id}`,
    stability: overrides.stability ?? 1,
    difficulty: overrides.difficulty ?? 0.5,
    createdAt: overrides.createdAt ?? 0,
    lastAccess: overrides.lastAccess ?? 0,
    accessCount: overrides.accessCount ?? 0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? 1 : null,
  });
}

/** 直接插一条边（自环没法用 `link` 建——它按设计拒绝自环）。 */
export function insertEdge(
  db: Database.Database,
  id: string,
  subjectId: string,
  predicate: string,
  objectId: string,
  weight: number,
  lastActive = 0,
  memoryId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, subjectId, predicate, objectId, memoryId, weight, lastActive, lastActive);
}

/** 读一条记忆的加固相关字段。 */
export function readMemory(
  db: Database.Database,
  id: string,
): { stability: number; last_access: number; access_count: number; difficulty: number } {
  return db
    .prepare('SELECT stability, last_access, access_count, difficulty FROM memories WHERE id = ?')
    .get(id) as {
    stability: number;
    last_access: number;
    access_count: number;
    difficulty: number;
  };
}

/** 读一条边。 */
export function readEdge(
  db: Database.Database,
  subjectId: string,
  predicate: string,
  objectId: string,
): { id: string; weight: number; last_active: number; memory_id: string | null } | undefined {
  return db
    .prepare(
      'SELECT id, weight, last_active, memory_id FROM edges WHERE subject_id = ? AND predicate = ? AND object_id = ?',
    )
    .get(subjectId, predicate, objectId) as
    | { id: string; weight: number; last_active: number; memory_id: string | null }
    | undefined;
}

/** 读全部边（按 id 排序，便于稳定断言）。 */
export function readAllEdges(db: Database.Database): Array<{
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string;
  weight: number;
  last_active: number;
  memory_id: string | null;
}> {
  return db
    .prepare(
      `SELECT id, subject_id, predicate, object_id, weight, last_active, memory_id
       FROM edges ORDER BY id`,
    )
    .all() as Array<{
    id: string;
    subject_id: string;
    predicate: string;
    object_id: string;
    weight: number;
    last_active: number;
    memory_id: string | null;
  }>;
}

/** 读事件（可按 type 过滤）。 */
export function readEvents(db: Database.Database, type?: string): StoredEvent[] {
  const rows = (
    type === undefined
      ? db.prepare('SELECT type, memory_id, payload, at FROM events ORDER BY id').all()
      : db
          .prepare('SELECT type, memory_id, payload, at FROM events WHERE type = ? ORDER BY id')
          .all(type)
  ) as Array<{ type: string; memory_id: string | null; payload: string; at: number }>;
  return rows.map((row) => ({
    type: row.type,
    memory_id: row.memory_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    at: row.at,
  }));
}

/** 读一条记忆的正文（用来断言「合并不动正文」）。 */
export function readContent(db: Database.Database, id: string): string | undefined {
  const row = db.prepare('SELECT content FROM memories WHERE id = ?').get(id) as
    | { content: string }
    | undefined;
  return row?.content;
}
