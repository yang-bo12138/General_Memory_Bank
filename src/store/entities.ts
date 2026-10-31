/**
 * 别名维护与实体合并：`setAlias` / `mergeEntities` —— DESIGN-v2.md §4.9.2，
 * 对应 DEVELOPMENT-PLAN.md **P1-T05**。
 *
 * ★ **为什么必须有这一节**（§4.9.2 原话）：
 *   §4.9 步骤 1c 写别名的两条路都是**静默跳过**——`ON CONFLICT(alias) DO NOTHING`，
 *   以及与 `entities.name` 冲突时「跳过并记 warn 日志」。
 *   而库里此前**没有任何接口能把错挂的别名改回来**：
 *   「老张」被误挂到「张山」名下 ⇒ 之后正确写入被静默丢弃 ⇒ 所有「老张」的查询永远只命中张山；
 *   「张三」与「張三」各建一个实体 ⇒ 图谱路从此分裂，两组记忆互相看不见，
 *   且**没有任何办法恢复**。
 *   ⇒ 静默失败 + 无修复入口 = **不可逆的数据损坏**。这两个显式入口是这条链路的兜底。
 *
 * ⚠️ **决策一律委托给 `src/core/graph.ts`**（`findPrimaryNameConflict` / `mergeEdges`），
 *   本文件只负责「按结论执行 SQL」⇒ 决策错了 `tests/unit/graph.test.ts` 变红，
 *   SQL 错了这里的端到端测变红，两者不会互相掩盖。
 */

import type Database from 'better-sqlite3';

import { MemoryError } from '../core/errors.js';
import type { AliasEventPayload } from '../core/events.types.js';
import { mergeEdges } from '../core/graph.js';
import type { Params } from '../core/params.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

/** 实体维护所需的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface EntityStore {
  db: Database.Database;
  params: Params;
  events: EventWriter;
}

/** `mergeEntities` 的结果（同时是 `alias` 事件 payload 的来源）。 */
export interface MergeEntitiesResult {
  sourceId: string;
  targetId: string;
  /** 改指到目标实体的记忆关联条数（§4.9.2 步骤 1）。 */
  movedMemories: number;
  /** 从源实体迁到目标实体上的**因冲突而被折叠掉**的边条数（§4.9.2 步骤 2）。 */
  mergedEdges: number;
  /** 合并后被清掉的自环条数（§4.9.2 步骤 2b）。 */
  droppedSelfLoops: number;
  /**
   * 被合并实体的主名（已降级为目标的别名）。
   *
   * ⚠️ **本字段名与事件 payload 的 `aliasAdded` 不同义**（v2.1 勘误 / ADR-P1-C 冲突 1 与 F-3）：
   *   · 本字段（**函数返回值**）= **源主名的字符串**；
   *   · `events(type='alias', payload)` 里的 `aliasAdded` = **布尔**（是否动过别名映射），
   *     而源主名本体记在 payload 的 `alias` 键上。
   *   ⇒ 裁决（ADR-P1-C 冲突 1）：payload 那一侧选「布尔」，理由是 C36
   *     （同一件事不得有两套词）——`alias` 一键贯穿 `set` / `merge` 两个 action。
   *   ⇒ **本字段已据此改名**为 `sourceName`（原名 `aliasAdded`）：
   *     否则同一个键名在「返回值」与「事件 payload」两处表达两件事，
   *     而返回值这一侧**只有源主名**、与「是否动过别名映射」无关 ⇒ 改名才能真正消歧。
   *   ⚠️ 改名只影响本接口的字段名，**不改变任何行为**；调用点只有本文件与单元测试。
   */
  sourceName: string;
}

/** `edges` 表在合并时需要的字段子集（与 `core/graph.ts` 的 `GraphEdgeInput` 对齐）。 */
interface EdgeRow {
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string;
  weight: number;
  last_active: number;
  memory_id: string | null;
}

/**
 * `setAlias(alias, entityId)` —— §4.9.2 的别名维护入口。
 *
 * ⚠️ **步骤 1 刻意不用 `resolveEntity()`**：那三处（§4.5 link / §4.6 recall / §4.9 write）
 *   的语义是「**解析成 id**」，这里要的是「**检测冲突并抛错**」——语义恰好相反。
 *   若误收拢，`setAlias` 会把「命中」当成成功返回，**冲突检测静默失效**
 *   （不报错、不告警，只是别名表里多了一行指向别人的映射）。
 *
 * ⚠️ **写入用 `DO UPDATE`，而 §4.9 步骤 1c 的写路径用 `DO NOTHING`——这个不统一是刻意的**：
 *   写路径是批量补别名，不该覆盖别人的正确映射；
 *   维护路径是**人明确要求改**，必须生效。**两处不能统一，统一哪一边都是错的。**
 *
 * @throws {MemoryError} `CONFLICT`（alias 撞既有主名；`details.conflictingEntityId`）
 * @throws {MemoryError} `NOT_FOUND`（目标实体不存在；`details.missingIds`）
 */
export function setAlias(store: EntityStore, alias: string, entityId: string): void {
  const db = store.db;

  runWriteTransaction(db, () => {
    // ── 步骤 1：alias 不得是任何既有主名 ──
    // ⚠️ 这里查的是 `entities.name`（主名），**不是**别名表：
    //   主名优先于别名（§4.5 的解析顺序 ①②）⇒ 若允许主名同时作为别名，
    //   §4.6 步骤 1 的解析会对同一字符串给出两个不同答案（① 命中 A、② 命中 B），
    //   召回结果取决于实现先查哪张表。
    const primary = db.prepare('SELECT id FROM entities WHERE name = ?').get(alias) as
      | { id: string }
      | undefined;
    if (primary !== undefined) {
      throw MemoryError.conflict(
        `别名 "${alias}" 已是既有实体的主名（§4.9.2 步骤 1：主名优先于别名）`,
        { conflictingEntityId: primary.id },
      );
    }

    // ── 步骤 2：目标实体必须存在 ──
    const target = db.prepare('SELECT 1 AS ok FROM entities WHERE id = ?').get(entityId);
    if (target === undefined) {
      throw MemoryError.notFound(`setAlias 的目标实体不存在：${entityId}`, {
        missingIds: [entityId],
      });
    }

    // ── 步骤 3：写入（维护路径 ⇒ `DO UPDATE`，覆盖既有映射）──
    const previous = db
      .prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?')
      .get(alias) as { entity_id: string } | undefined;
    db.prepare(
      `INSERT INTO entity_aliases (alias, entity_id) VALUES (@alias, @entityId)
       ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id`,
    ).run({ alias, entityId });

    // ── 步骤 4：记事件 ──
    // ⚠️ `memory_id` 传 `null`（§8.4 的 alias 行：「无（涉实体而非记忆）」）。
    const payload: AliasEventPayload = { action: 'set', alias, entityId };
    if (previous !== undefined) {
      payload.prevEntityId = previous.entity_id;
    }
    store.events.appendEvent('alias', null, payload);
  });
}

/**
 * `mergeEntities(sourceId, targetId)` —— §4.9.2 的实体合并入口。
 *
 * ⚠️ **不删除任何 `memories` 行**（§14.3 边界原则 3 已专门澄清）：
 *   它是**图谱层的破坏性操作**，但不属于「记忆内容的销毁」，**不在三处物理删除之列**。
 *   本函数只动 `memory_entities`（关联表），`memories` 一行不碰。
 *
 * ⚠️ **§11.1 豁免**：本方法**不接收 `now`**——它不写任何时间派生字段
 *   （`edges.last_active` 取两条边中的较大者，不引入当前时刻）。
 *
 * @throws {MemoryError} `NOT_FOUND`（任一端实体不存在；`details.missingIds`）
 */
export function mergeEntities(
  store: EntityStore,
  sourceId: string,
  targetId: string,
): MergeEntitiesResult {
  const db = store.db;

  return runWriteTransaction(db, () => {
    // ── 步骤 0：存在性校验 + 幂等 ──
    // ⚠️ **存在性先判**：写接口「目标必须存在才成功才有意义」⇒ 抛 `NOT_FOUND`（§11.2）。
    const existsStatement = db.prepare('SELECT 1 AS ok FROM entities WHERE id = ?');
    const missing = [sourceId, targetId].filter((id) => existsStatement.get(id) === undefined);
    if (missing.length > 0) {
      throw MemoryError.notFound(`mergeEntities 的实体不存在：${missing.join(', ')}`, {
        missingIds: missing,
      });
    }
    if (sourceId === targetId) {
      // ⚠️ **幂等返回**：合并自己没有任何事可做 ⇒ 不写库、**不记事件**
      //   （§8.4 硬规则 2 的前提是「状态变了就必须有记录」；这里状态没变）。
      return {
        sourceId,
        targetId,
        movedMemories: 0,
        mergedEdges: 0,
        droppedSelfLoops: 0,
        // ⚠️ 幂等路径：源主名没被降级（它就是源实体自己的主名，未发生任何变化）
        //   ⇒ 这里返回源实体的主名本身，而不是空串。
        //   空串会与「合并后源主名被降级」的真实路径**语义相反**
        //   ⇒ 调用方拿到空串会以为「源实体没有名字」。
        sourceName: (
          db.prepare('SELECT name FROM entities WHERE id = ?').get(sourceId) as {
            name: string;
          }
        ).name,
      };
    }

    const sourceName = (
      db.prepare('SELECT name FROM entities WHERE id = ?').get(sourceId) as {
        name: string;
      }
    ).name;

    // ── 步骤 1：迁记忆关联（先插后删）──
    // ⚠️ PK 是 `(memory_id, entity_id)` ⇒ 直接改会撞主键 ⇒ 必须「先插后删」。
    const movedMemories = (
      db
        .prepare('SELECT COUNT(*) AS n FROM memory_entities WHERE entity_id = @sourceId')
        .get({ sourceId }) as { n: number }
    ).n;
    db.prepare(
      `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id)
       SELECT memory_id, @targetId FROM memory_entities WHERE entity_id = @sourceId`,
    ).run({ sourceId, targetId });
    db.prepare('DELETE FROM memory_entities WHERE entity_id = @sourceId').run({ sourceId });

    // ── 步骤 2：迁边（逐条判冲突）──
    const sourceEdges = db
      .prepare(
        `SELECT id, subject_id, predicate, object_id, weight, last_active, memory_id
         FROM edges WHERE subject_id = @sourceId OR object_id = @sourceId`,
      )
      .all({ sourceId }) as EdgeRow[];

    const findConflict = db.prepare(
      `SELECT id, subject_id, predicate, object_id, weight, last_active, memory_id
       FROM edges WHERE subject_id = @subjectId AND predicate = @predicate AND object_id = @objectId`,
    );
    const updateMerged = db.prepare(
      'UPDATE edges SET weight = @weight, last_active = @lastActive, memory_id = @memoryId WHERE id = @id',
    );
    const deleteEdge = db.prepare('DELETE FROM edges WHERE id = @id');
    const repointEdge = db.prepare(
      'UPDATE edges SET subject_id = @subjectId, object_id = @objectId WHERE id = @id',
    );

    let mergedEdges = 0;
    for (const edge of sourceEdges) {
      // ⚠️ **必须用 CASE 分别判断两个端点**（§4.9.2 步骤 2）：
      //   一条边只有一个端点可能是 sourceId；若按字面写成 `SET subject_id = @targetId`，
      //   会把**另一端也改成 targetId** ⇒ 凭空造出一条「目标指向自己」的假关系。
      const newSubject = edge.subject_id === sourceId ? targetId : edge.subject_id;
      const newObject = edge.object_id === sourceId ? targetId : edge.object_id;

      const conflict = findConflict.get({
        subjectId: newSubject,
        predicate: edge.predicate,
        objectId: newObject,
      }) as EdgeRow | undefined;

      if (conflict === undefined) {
        // 没有撞三元组 ⇒ 直接改指（目标实体上不存在同三元组的边）。
        repointEdge.run({ subjectId: newSubject, objectId: newObject, id: edge.id });
        continue;
      }

      // ⚠️ 撞了三元组 ⇒ **取和，不取大**（`core/graph.ts` 的 `mergeEdges` 是唯一算法声明点）：
      //   取大等于凭空砍掉一半关系强度——两条各 0.8 的边合并后应得 1.6；
      //   若取大只剩 0.8，可能直接跌破 `ACTIVATION_MIN` 让扩散**永久失效**
      //   （一种**沉默的功能消失**：不报错、不告警，只是「联想不出来了」）。
      const merged = mergeEdges(conflict, edge, store.params);
      updateMerged.run({
        id: conflict.id,
        weight: merged.weight,
        lastActive: merged.last_active,
        memoryId: merged.memory_id,
      });
      deleteEdge.run({ id: edge.id });
      mergedEdges += 1;
    }

    // ── 步骤 2b：清理合并产生的自环 ──
    // ⚠️ **只删本次目标实体身上的自环**：迁移前 source 的自环（source→source）迁移后
    //   正好落在这个范围内，所以不会漏；而**与本次合并无关的**自环必须留着。
    //   ⇒ **不要写成 `WHERE subject_id = object_id`**——那会把全库所有自环清掉，属误伤。
    const droppedSelfLoops = db
      .prepare('DELETE FROM edges WHERE subject_id = @targetId AND object_id = @targetId')
      .run({ targetId }).changes;

    // ── 步骤 3：迁别名 + 把被合并实体的主名降级为别名 ──
    // ⚠️ 降级是**必需**的：不降级 ⇒ 旧名字此后**召回不到**（解析时既不是主名也不是别名）。
    db.prepare('UPDATE entity_aliases SET entity_id = @targetId WHERE entity_id = @sourceId').run({
      sourceId,
      targetId,
    });
    db.prepare(
      `INSERT INTO entity_aliases (alias, entity_id) VALUES (@alias, @entityId)
       ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id`,
    ).run({ alias: sourceName, entityId: targetId });

    // ── 步骤 4：删源实体 ──
    // ⚠️ 此时已无任何引用（记忆关联、边、别名都已迁走）⇒ 外键级联不会误删数据。
    db.prepare('DELETE FROM entities WHERE id = @sourceId').run({ sourceId });

    // ── 步骤 5：记事件 ──
    // ⚠️ `aliasAdded` 记**布尔**、被降级的主名本体记在 `alias` 键上
    //   —— 这是 **ADR-P1-C 冲突 1 的正式裁决**（不是「以类型声明为准」的临时妥协）：
    //   §4.9.2 步骤 5 的原稿写 `aliasAdded: sourceName`（字符串），
    //   与 `src/core/events.types.ts` 的 `aliasAdded?: boolean` 直接冲突
    //   ⇒ 同一个键名两处两套语义。
    //   ⇒ 裁决选「布尔」，理由是 §14.3.1 的 **C36**（同一件事不得有两套词）：
    //     若 `merge` 用 `aliasAdded` 装名字、`set` 用 `alias` 装别名，
    //     「别名名」这件事就被劈成两半，读事件的人得先看 `action` 才知道读哪个键。
    //   ⇒ 现在 `alias` 一键贯穿两个 action：`set` ⇒ 被设置的别名；
    //     `merge` ⇒ 被降级的源主名。
    //   ⇒ **信息一条不丢**：合并会删掉源实体行 ⇒ 源主名在库里只剩「别名表」与「事件」两处，
    //     `alias` 键保住名字、`aliasAdded` 键说明「确实动过别名映射」。
    const payload: AliasEventPayload = {
      action: 'merge',
      sourceId,
      targetId,
      movedMemories,
      mergedEdges,
      droppedSelfLoops,
      aliasAdded: true,
      alias: sourceName,
    };
    store.events.appendEvent('alias', null, payload);

    return {
      sourceId,
      targetId,
      movedMemories,
      mergedEdges,
      droppedSelfLoops,
      sourceName,
    };
  });
}
