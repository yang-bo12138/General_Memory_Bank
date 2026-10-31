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
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { resolveEntity } from '../core/entities.js';
import { MemoryError } from '../core/errors.js';
import type { LinkEventPayload } from '../core/events.types.js';
import { isSelfLoop } from '../core/graph.js';
import type { Params } from '../core/params.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

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
   * 本次**自动新建**的实体**名称**列表（§4.5 步骤 2：`@autoCreatedEntities`）。
   *
   * ⚠️ **元素是实体名（`entities.name`），不是 entity_id**（§4.5 步骤 2 原文：
   *   「`@autoCreatedEntities = [本次实际新建的实体名, ...]`」）。
   *   ⇒ 用**名**而不是 id 的理由（不是偏好，是必需）：`link` 事件的 payload 里
   *   **没有任何实体名**（只有 `subjectId` / `objectId`），
   *   若这里记 id，重放器（§9.2「可完整重放」）就永远不知道
   *   那个被自动建出来的实体**叫什么** ⇒ 图谱重建时建不出同名的实体。
   *
   * ⚠️ **只有「本次真的新建」的端点才进来**：
   *   · 走 `ON CONFLICT(name) DO UPDATE` 分支拿到的**既有**实体**不算**
   *     （它本来就在，不是本次创建的）；
   *   · 解析得到既有实体（主名或别名命中）的端点也**不算**。
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

  return runWriteTransaction(db, () => {
    // ── 步骤 1：两端各解析一次，结果先落在「可能为 null」的变量里 ──
    // ⚠️ 不要写成 `subjectId = resolveEntity(...) ?? 步骤2建出的id`——
    //    步骤 1 就引用步骤 2 的产物，而步骤 2 此时还没执行。
    let subjectId = resolveEntity(db, subject);
    let objectId = resolveEntity(db, object);

    // ⚠️ ★ **步骤 1 尾部：memoryId 的存在性自校验**（§11.2 的自校验清单明写
    //   「`link` ⇒ `memoryId`（记忆）」；§4.5 步骤 4 给了这一句的**逐字 SQL**：
    //   「传了 @memoryId 时必须先 `SELECT 1 FROM memories WHERE id = @x AND deleted = 0`」）。
    //   不自校验的后果：传一个不存在的 memoryId ⇒ 撞 `edges.memory_id` 的外键
    //   ⇒ 在 `PRAGMA foreign_keys = ON`（§9.1，每连接都开）下抛
    //   `SQLITE_CONSTRAINT_FOREIGNKEY` ⇒ 被转译成 `NOT_FOUND`，
    //   **但 `details` 里没有 `missingIds`** ⇒ 违反 §11.2 的自校验清单。
    //   ⚠️ **必须带 `AND deleted = 0`**（§4.5 步骤 4 的逐字要求，不是可选项）：
    //   外键只管「这行在不在」，**不管「这行是不是已被软删」**
    //   ⇒ 漏掉这个条件 ⇒ 一条**已被遗忘**的记忆仍能当「边的证据」
    //   ⇒ 用户已经忘了它，它却还在给图谱供能（静默地与遗忘的意图相反）。
    //   这与 `touch` 把软删 id 当缺失（§4.2 的 `AND deleted = 0`）是同一条语义：
    //   **软删的记忆不是有效记忆**（§4.6 的准入闸门一律 `deleted = 0`）。
    //   ⚠️ 自校验必须在**事务内**做（否则并发删除会漏判）。
    if (memoryId !== undefined && memoryId !== null) {
      const memoryExists = db
        .prepare('SELECT 1 AS ok FROM memories WHERE id = ? AND deleted = 0')
        .get(memoryId);
      if (memoryExists === undefined) {
        throw MemoryError.notFound(`link 的 memoryId 不存在（含软删）：${memoryId}`, {
          missingIds: [memoryId],
        });
      }
    }

    // ⚠️ ★ **必须在建实体之前**记下「哪些端点原本解析不到」。
    //   之前的实现是「先建实体、再回头 `resolveEntity` 查」——
    //   建完之后实体**必然查得到** ⇒ 判定恒为「不是新建」
    //   ⇒ `autoCreatedEntities` **恒为空** ⇒ 「这次 link 自动建了哪些实体」完全不留痕
    //   （§8.4 硬规则 2：状态变了就必须有记录）。
    //   ⇒ 现在改成：**先记 null，再建**；只有原本为 null 的端点才计入。
    const subjectWasMissing = subjectId === null;
    const objectWasMissing = objectId === null;

    // ── 步骤 2：缺失实体处理 ──
    if (subjectId === null || objectId === null) {
      // ⚠️ **先判两端再建**：`createMissing === false` 时必须**零写入**，
      //    禁止「建了一个端点、另一个端点缺失才抛错」的混合策略。
      if (!createMissing) {
        const missingNames: string[] = [];
        if (subjectWasMissing) missingNames.push(subject);
        if (objectWasMissing) missingNames.push(object);
        throw MemoryError.notFound(
          `link 的端点实体不存在，且 createMissing = false（未产生任何写入）：${missingNames.join(', ')}`,
          // ⚠️ v2.1 勘误（ADR-P1-C 冲突 2）：这个差集装的是「缺失的**端点实体名**」
          //   （`link` 的入参是名字，不是 id）⇒ 用 `missingEntityNames`，
          //   **不再用 `missingIds`** —— 后者的语义是「行 id 差集」
          //   （§11.2 的 FK 兜底句把它绑在 id 上），装名字会让同一个键表达两件事
          //   ⇒ 违反 §14.3.1 的 C36。
          { missingEntityNames: missingNames },
        );
      }

      if (subjectId === null) {
        subjectId = upsertEntity(db, subject, at);
      }
      if (objectId === null) {
        objectId = upsertEntity(db, object, at);
      }
    }

    // ⚠️ **只把「原本解析不到」的端点记进来**：
    //   · 原本就解析得到（主名或别名命中）的端点 ⇒ **不是**本次新建的；
    //   · 走 `ON CONFLICT(name) DO UPDATE` 分支拿到的**既有**实体 ⇒ **不是**本次新建的。
    const autoCreatedEntities: string[] = [];
    if (subjectWasMissing) {
      autoCreatedEntities.push(subject);
    }
    if (objectWasMissing && !autoCreatedEntities.includes(object)) {
      // ⚠️ 两端同名时（`link('张三','关联','张三')`）第二个 INSERT 走
      //   `ON CONFLICT(name) DO UPDATE` 分支拿回**同一个** id ⇒ 那个实体只建了一次
      //   ⇒ 名字只应记一次。
      autoCreatedEntities.push(object);
    }

    // ── 步骤 3：自环校验（id 已回填 ⇒ 按 id 判）──
    if (isSelfLoop(subjectId, objectId)) {
      // ⚠️ 抛错会回滚步骤 2 已建的实体——前提是**同一事务**（本函数整体在 runWriteTransaction 里）。
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
 *   · `PRAGMA foreign_keys` 是**每连接**开关，漏开时**静默写入悬空边**
 *     （之后扩散永远查不到邻居，且不报任何错）。
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

  return runWriteTransaction(db, () => {
    const existsStatement = db.prepare('SELECT 1 AS ok FROM entities WHERE id = ?');
    const present = [subjectId, objectId].filter((id) => existsStatement.get(id) !== undefined);
    const missing = [subjectId, objectId].filter((id) => !present.includes(id));

    if (missing.length > 0) {
      throw MemoryError.notFound(
        `linkByIds 的实体不存在（已自行校验，未依赖外键）：${missing.join(', ')}`,
        { missingIds: missing },
      );
    }

    // ⚠️ ★ **memoryId 的存在性自校验**（§11.2 的自校验清单明写
    //   「`linkByIds` ⇒ `subjectId`/`objectId` 与 `memoryId`」；
    //   §4.5 步骤 4 给了逐字 SQL：`SELECT 1 FROM memories WHERE id = @x AND deleted = 0`）。
    //   与 `link` 同理：不自校验 ⇒ 撞 `edges.memory_id` 的外键 ⇒ 转译成 `NOT_FOUND`
    //   但 `details` 里没有 `missingIds` ⇒ 违反 §11.2 的自校验清单。
    //   ⚠️ **同样必须带 `AND deleted = 0`**：软删的记忆不是有效记忆，
    //   不能继续当边的证据（否则「忘了它」之后图谱强度仍在涨）。
    if (memoryId !== undefined && memoryId !== null) {
      const memoryExists = db
        .prepare('SELECT 1 AS ok FROM memories WHERE id = ? AND deleted = 0')
        .get(memoryId);
      if (memoryExists === undefined) {
        throw MemoryError.notFound(`linkByIds 的 memoryId 不存在（含软删）：${memoryId}`, {
          missingIds: [memoryId],
        });
      }
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
