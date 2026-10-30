/**
 * 图的写入：`link` / `linkByIds` —— DESIGN-v2.md §4.5，对应 DEVELOPMENT-PLAN.md **P1-T05**。
 *
 * ★ **步骤 1~4 的顺序不可颠倒**（§4.5）：
 *   1. 名称 → entity_id 解析（两端各一次，结果先落在**可能为 null** 的变量里）
 *   2. 缺失实体处理（`createMissing` ⇒ 建 / `false` ⇒ 抛 `NOT_FOUND`，**零写入**）
 *   3. 自环校验（**必须在 id 回填之后、写边之前**，且**按 id 判不按名判**）
 *   4. 边的 UPSERT（取回 `RETURNING weight`，不在外面重算）
 *
 * ⚠️ **步骤 2 与步骤 4 必须在同一事务里**：
 *   自环抛错要能回滚步骤 2 已建的实体。若为拿 id 而提前 COMMIT ⇒ 回滚失效 ⇒
 *   留下**孤儿实体**（不报错、不告警，只是库里多一批永远没人引用的行）。
 *
 * ⚠️ **决策一律委托给 `src/core/graph.ts`**：本文件只负责「按结论执行 SQL」，
 *   不再自己做判断 ⇒ 决策错了 `tests/unit/graph.test.ts` 变红，SQL 错了这里的端到端测变红，
 *   两者不会互相掩盖。
 *
 * ── 交付状态（截至 2026-10-31 07:45）────────────────────────────────────────
 * ⚠️ **本文件是 P1-T05「SQL 层」的在途稿**：
 *   · 已完成：`link` / `linkByIds` 的 §4.5 四步（解析 → 缺失实体处理 → 自环校验 → 边 UPSERT）
 *     与「步骤 2 与步骤 4 同事务」的编排；
 *   · **尚未接入**：`src/index.ts` 未导出本模块 ⇒ 运行时不可达；
 *   · **尚未验收**：缺端到端集成测试（重复三元组强化不产生重复边 / `createMissing=false` 零写入 /
 *     每次 link 记一条事件 / `setAlias` 撞既有别名走 DO UPDATE / `mergeEntities` 后记忆正文一行未动 /
 *     幂等返回）⇒ 这些是 P1-T05 收尾时的**必做项**，不是可选项；
 *   · 本次只修正了一处契约违例：原先自造了 `ENTITY_UPSERT_FAILED` / `EDGE_UPSERT_FAILED`
 *     两个**不属于封闭五码集合**的 `MemoryErrorCode` ⇒ 按 §11.2「语义不属于五个 code 的错误
 *     原样抛出但必须带 `code` 字段」改为 `invariantError()`。
 * ─────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { resolveEntity } from '../core/entities.js';
import { MemoryError, translateSqliteError } from '../core/errors.js';
import type { LinkEventPayload } from '../core/events.types.js';
import { isSelfLoop } from '../core/graph.js';
import type { Params } from '../core/params.js';
import type { EventWriter } from './events.js';

/** 图写入所需的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface GraphStore {
  db: Database.Database;
  params: Params;
  events: EventWriter;
}

/** `link` 的可选开关（§4.5 步骤 2）。 */
export interface LinkOptions {
  /**
   * 缺失实体时自动建（`type='concept'`）。**默认 true**（§4.5：`!== false` 即建）。
   *
   * ⚠️ **`false` 时抛 `NOT_FOUND`，且整条 link 零写入**——
   *   **禁止「一边自动建、一边抛错」的混合策略**（§4.5 原话）。
   */
  createMissing?: boolean;
}

/** 一次 `link` / `linkByIds` 的结果（同时是 `link` 事件 payload 的来源）。 */
export interface LinkResult {
  subjectId: string;
  predicate: string;
  objectId: string;
  /** **实际落库**的权重（`RETURNING weight` 取回，不在外面重算）。 */
  weightAfter: number;
  /**
   * 本次自动新建的实体 id。
   *
   * ⚠️ 走 `ON CONFLICT ... DO UPDATE` 分支拿到的**既有**实体 id **不算**进来——
   *   它本来就在，不是本次创建的（§4.5 步骤 2）。
   */
  autoCreatedEntities: string[];
}

/**
 * 建（或取回）一个实体，返回其 id。
 *
 * ⚠️ **`ON CONFLICT` 分支不是多余的**：两个端点同名、或并发下已被别人建过时，
 *   裸 `INSERT` 会撞 `entities.name` 的 UNIQUE ⇒ 整条 link 失败。
 *   这里要的是「**拿到 id**」，不是「必须新建」。
 */
const UPSERT_ENTITY_SQL = `
  INSERT INTO entities (id, name, type, created_at)
  VALUES (@id, @name, 'concept', @now)
  ON CONFLICT(name) DO UPDATE SET name = excluded.name
  RETURNING id
`;

/**
 * 边的 UPSERT（§4.5 步骤 4）。
 *
 * ⚠️ **参数一律写 `@名字`**：裸写的名字会被 SQLite 逐字当成**列名**，执行时报
 *   `no such column`（§4.5 的伪代码约定）。
 * ⚠️ **`last_active` 无条件刷新**，不因 `weight` 已满格而跳过：
 *   衰减读的是 `last_active`，已封顶的边不刷新 ⇒ 仍会跌回阈值以下
 *   ⇒「用得越多死得越快」，与规则意图相反。
 */
const UPSERT_EDGE_SQL = `
  INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
  VALUES (@id, @subjectId, @predicate, @objectId, @memoryId, @initialWeight, @now, @now)
  ON CONFLICT(subject_id, predicate, object_id) DO UPDATE SET
    weight      = min(@maxWeight, edges.weight + @reinforceStep),
    last_active = @now,
    memory_id   = COALESCE(@memoryId, edges.memory_id)
  RETURNING weight
`;

/** 判断一个错误是否已是本库的错误类型（是则原样抛出，不再转译）。 */
function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError;
}

/**
 * 执行一段图写入；把 SQLite 原生错误转译成 §11.2 的语义错误。
 *
 * ⚠️ **已经是 `MemoryError` 的原样抛出**：转译器只看 `code`，
 *   把一个 `NOT_FOUND` 再转一次会变成 `CONFLICT` 或 `INVALID_INPUT` ⇒ 语义被覆盖。
 */
function runGraphWrite<T>(db: Database.Database, body: () => T): T {
  try {
    return db.transaction(body)();
  } catch (error) {
    if (isMemoryError(error)) {
      throw error;
    }
    throw translateSqliteError(error);
  }
}

/**
 * §11.2：**语义不属于五个 code 的内部不变量违例 ⇒ 原样抛出，但必须带上 `code` 字段**。
 *
 * ⚠️ **不得硬塞进五个 code 里的任何一个**（CONFLICT / DATABASE_BUSY / INVALID_INPUT /
 * NOT_FOUND / READONLY_VIOLATION）：语义未知的错误塞进某个 code，会把调用方引向错误的
 * 处置（重试 / 改参数 / 查重），**比一个未类型化的错误更难排查**。
 *
 * 这与 §11.2 对「清单之外的 SQLite 错误码」的处理一致：原样抛出 + 带 `code` 供日志定位。
 */
function invariantError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** 建一个实体并回读 id。 */
function upsertEntity(db: Database.Database, name: string, now: number): string {
  const row = db.prepare(UPSERT_ENTITY_SQL).get({
    id: randomUUID(),
    name,
    now,
  }) as { id: string } | undefined;
  if (row === undefined || typeof row.id !== 'string') {
    throw invariantError('ENTITY_UPSERT_FAILED', `实体 UPSERT 未返回 id：${name}`);
  }
  return row.id;
}

/**
 * `link(subject, predicate, object, memoryId?, now?, options?)` —— §4.5 的完整四步。
 *
 * ⚠️ `memoryId` **可选**（§4.4：允许**无证据边**）。只有 `linkByIds` 的 `memoryId` 是必填。
 *   ⇒ `memory_id IS NULL` 的边是「断言」不是「记忆」，**永不被 touch 强化**（§4.5）。
 *
 * @throws {MemoryError} `NOT_FOUND`（`createMissing: false` 且端点缺失；整条失败、零写入）
 * @throws {MemoryError} `INVALID_INPUT`（自环：`details = { subjectId, predicate }`）
 */
export function link(
  store: GraphStore,
  subject: string,
  predicate: string,
  object: string,
  memoryId?: string | null,
  now?: number,
  options?: LinkOptions,
): LinkResult {
  const at = resolveNow(now);
  const createMissing = options?.createMissing !== false;
  const db = store.db;

  return runGraphWrite(db, () => {
    // ── 步骤 1：两端各解析一次，结果先落在「可能为 null」的变量里 ──
    // ⚠️ 不要写成 `subjectId = resolveEntity(...) ?? 步骤2建出的id`——
    //    步骤 1 就引用步骤 2 的产物，而步骤 2 此时还没执行。
    let subjectId = resolveEntity(db, subject);
    let objectId = resolveEntity(db, object);

    // ── 步骤 2：缺失实体处理 ──
    // ⚠️ **先判两端再建**：`createMissing === false` 时必须**零写入**，
    //    禁止「建了一个端点、另一个端点缺失才抛错」的混合策略。
    if (subjectId === null || objectId === null) {
      if (!createMissing) {
        const missing: string[] = [];
        if (subjectId === null) missing.push(subject);
        if (objectId === null) missing.push(object);
        throw MemoryError.notFound(
          `link 的端点实体不存在，且 createMissing = false（未产生任何写入）：${missing.join(', ')}`,
          { missingIds: missing },
        );
      }
      if (subjectId === null) {
        subjectId = upsertEntity(db, subject, at);
      }
      if (objectId === null) {
        objectId = upsertEntity(db, object, at);
      }
    }

    const autoCreatedEntities: string[] = [];
    if (resolveEntity(db, subject) === null) {
      autoCreatedEntities.push(subjectId);
    }
    if (resolveEntity(db, object) === null) {
      autoCreatedEntities.push(objectId);
    }

    // ── 步骤 3：自环校验（id 已回填 ⇒ 按 id 判）──
    if (isSelfLoop(subjectId, objectId)) {
      // ⚠️ 抛错会回滚步骤 2 已建的实体——前提是**同一事务**（本函数整体在 runGraphWrite 里）。
      throw MemoryError.invalidInput('link 的两端解析到同一个实体（自环）', {
        subjectId,
        predicate,
      });
    }

    // ── 步骤 4：边的 UPSERT，取回实际落库值 ──
    const row = db.prepare(UPSERT_EDGE_SQL).get({
      id: randomUUID(),
      subjectId,
      predicate,
      objectId,
      memoryId: memoryId ?? null,
      initialWeight: store.params.INITIAL_EDGE_WEIGHT,
      maxWeight: store.params.MAX_EDGE_WEIGHT,
      reinforceStep: store.params.EDGE_REINFORCE_STEP,
      now: at,
    }) as { weight: number } | undefined;

    if (row === undefined || typeof row.weight !== 'number') {
      throw invariantError('EDGE_UPSERT_FAILED', '边 UPSERT 未返回 weight');
    }

    const payload: LinkEventPayload = {
      subjectId,
      predicate,
      objectId,
      weightAfter: row.weight,
      autoCreatedEntities,
    };
    if (memoryId !== undefined && memoryId !== null) {
      payload.memoryId = memoryId;
    }

    // ⚠️ **每次 link 都记事件**，不能只在「自动建了实体」的分支里记——
    //    否则「重复 link 强化了权重」完全不留痕，重放时图谱强度无法复原。
    // ⚠️ `memory_id` 是必传实参（值可为 null）——§8.4 硬规则 6。
    store.events.appendEvent('link', memoryId ?? null, payload, at);

    return {
      subjectId,
      predicate,
      objectId,
      weightAfter: row.weight,
      autoCreatedEntities,
    };
  });
}

/**
 * `linkByIds(subjectId, predicate, objectId, memoryId?, now?)` —— §4.5。
 *
 * ⚠️ **跳过步骤 1 与步骤 2 的建实体**，但**照常执行**：`@now` / `@memoryId` 赋值、
 * **自环校验**、边的 UPSERT 与事件记录（`@autoCreatedEntities` 恒为 `[]`）。
 *
 * ⚠️ **实体存在性必须自己校验**（各 `SELECT 1 FROM entities WHERE id = ?`），
 *   **不能指望外键**：
 *   · FK 报的是未类型化的 `SQLITE_CONSTRAINT_FOREIGNKEY`，会原样穿给调用方；
 *   · `PRAGMA foreign_keys` 是**每连接**开关，漏开时会**静默写入悬空边**。
 *
 * @throws {MemoryError} `NOT_FOUND`（`details.missingIds = 差集`）
 * @throws {MemoryError} `INVALID_INPUT`（自环）
 */
export function linkByIds(
  store: GraphStore,
  subjectId: string,
  predicate: string,
  objectId: string,
  memoryId?: string | null,
  now?: number,
): LinkResult {
  const at = resolveNow(now);
  const db = store.db;

  return runGraphWrite(db, () => {
    const existsStatement = db.prepare('SELECT 1 AS ok FROM entities WHERE id = ?');
    const present = [subjectId, objectId].filter((id) => existsStatement.get(id) !== undefined);
    const missing = [subjectId, objectId].filter((id) => !present.includes(id));

    if (missing.length > 0) {
      throw MemoryError.notFound(
        `linkByIds 的实体不存在（已自行校验，未依赖外键）：${missing.join(', ')}`,
        { missingIds: missing },
      );
    }

    if (isSelfLoop(subjectId, objectId)) {
      throw MemoryError.invalidInput('linkByIds 的两端是同一个实体（自环）', {
        subjectId,
        predicate,
      });
    }

    const row = db.prepare(UPSERT_EDGE_SQL).get({
      id: randomUUID(),
      subjectId,
      predicate,
      objectId,
      memoryId: memoryId ?? null,
      initialWeight: store.params.INITIAL_EDGE_WEIGHT,
      maxWeight: store.params.MAX_EDGE_WEIGHT,
      reinforceStep: store.params.EDGE_REINFORCE_STEP,
      now: at,
    }) as { weight: number } | undefined;

    if (row === undefined || typeof row.weight !== 'number') {
      throw invariantError('EDGE_UPSERT_FAILED', '边 UPSERT 未返回 weight');
    }

    const payload: LinkEventPayload = {
      subjectId,
      predicate,
      objectId,
      weightAfter: row.weight,
      autoCreatedEntities: [],
    };
    if (memoryId !== undefined && memoryId !== null) {
      payload.memoryId = memoryId;
    }

    store.events.appendEvent('link', memoryId ?? null, payload, at);

    return {
      subjectId,
      predicate,
      objectId,
      weightAfter: row.weight,
      autoCreatedEntities: [],
    };
  });
}
