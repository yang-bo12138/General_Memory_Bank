/**
 * P1-T05 · 别名维护与实体合并：`setAlias` / `mergeEntities` 的端到端断言 ——
 * DESIGN-v2.md §4.9.2。
 *
 * ★ 断言纪律：写性质不写形状；关键断言配反例（写出那个会错的写法，断言它确实会错）。
 */

import { describe, expect, it } from 'vitest';

import { resolveEntity } from '../../src/core/entities.js';
import { MemoryError } from '../../src/core/errors.js';
import { mergeEntities, setAlias } from '../../src/store/entities.js';
import {
  countRows,
  createTestStore,
  insertEdge,
  insertEntity,
  insertMemory,
  readAllEdges,
  readContent,
  readEvents,
} from '../fixtures/graph-store.js';

/** 取出捕获到的 `MemoryError`（失败时给出可读的原因）。 */
function expectMemoryError(fn: () => unknown): MemoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemoryError) {
      return error;
    }
    throw error;
  }
  throw new Error('期望抛出 MemoryError，但没有抛');
}

describe('P1-T05 · setAlias（§4.9.2）', () => {
  it('★ 设一个新别名 ⇒ 别名表里多一行，且名称能解析到目标实体', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-1', '张三');

    setAlias(store, '老张', 'e-1');

    expect(resolveEntity(db, '老张')).toBe('e-1');
    expect(resolveEntity(db, '张三')).toBe('e-1');
    expect(countRows(db, 'entity_aliases')).toBe(1);
  });

  it('★ alias 撞**既有主名** ⇒ CONFLICT，且 details.conflictingEntityId 指向冲突实体', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '李四');

    const error = expectMemoryError(() => setAlias(store, '张三', 'e-2'));
    expect(error.code).toBe('CONFLICT');
    expect(error.details.conflictingEntityId).toBe('e-1');
    // 性质：冲突时**零写入**（别名表里不能多出一行指向别人的映射）
    expect(countRows(db, 'entity_aliases')).toBe(0);

    // ⚠️ 反例：若这一处误用 `resolveEntity()`（那三处的语义是「解析成 id」），
    //   「命中」会被当成成功返回 ⇒ 不抛错 ⇒ 上面两行变红。
  });

  it('★ alias 撞**既有别名** ⇒ 覆盖成功（维护路径用 DO UPDATE）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '李四');

    setAlias(store, '老张', 'e-1');
    setAlias(store, '老张', 'e-2');

    // 性质：映射被改到新目标，且**只有一行**（不是两行）
    expect(resolveEntity(db, '老张')).toBe('e-2');
    expect(countRows(db, 'entity_aliases')).toBe(1);
  });

  it('★ 目标实体不存在 ⇒ NOT_FOUND（details.missingIds）且零写入', () => {
    const { db, store } = createTestStore();

    const error = expectMemoryError(() => setAlias(store, '老张', 'e-missing'));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details.missingIds).toEqual(['e-missing']);
    expect(countRows(db, 'entity_aliases')).toBe(0);
  });

  it('★ 记一条 alias 事件（action=set，带 alias / entityId / prevEntityId）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '李四');

    setAlias(store, '老张', 'e-1');
    setAlias(store, '老张', 'e-2');

    const events = readEvents(db, 'alias');
    expect(events).toHaveLength(2);
    expect(events[0]?.payload.action).toBe('set');
    expect(events[0]?.payload.alias).toBe('老张');
    expect(events[0]?.payload.entityId).toBe('e-1');
    // 性质：第二次覆盖时记下了**旧映射**
    expect(events[1]?.payload.prevEntityId).toBe('e-1');
    expect(events[1]?.payload.entityId).toBe('e-2');
    // 性质：alias 事件不挂记忆（§8.4：memory_id = null）
    expect(events[0]?.memory_id).toBeNull();
  });
});

describe('P1-T05 · mergeEntities（§4.9.2）', () => {
  it('★ 源实体的记忆全部改指目标，且**记忆正文一行未动**', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');
    insertMemory(db, 'm-1', { content: '原始正文不许动' });
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
      'm-1',
      'e-src',
    );

    mergeEntities(store, 'e-src', 'e-tgt');

    // 性质：关联改指目标，源实体身上的关联清空
    const links = db
      .prepare('SELECT memory_id, entity_id FROM memory_entities ORDER BY entity_id')
      .all() as Array<{ memory_id: string; entity_id: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]?.entity_id).toBe('e-tgt');
    expect(links[0]?.memory_id).toBe('m-1');

    // ★ **正文一行未动**（§14.3 边界原则 3：合并是图谱层的破坏性操作，不销毁记忆内容）
    expect(readContent(db, 'm-1')).toBe('原始正文不许动');
    expect(countRows(db, 'memories')).toBe(1);
  });

  it('★ 边权**取和**（不取大），且撞三元组的源边被删掉', () => {
    const { db, store, params } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');
    insertEntity(db, 'e-x', '王五');
    insertEdge(db, 'edge-src', 'e-src', 'p', 'e-x', 0.8, 100);
    insertEdge(db, 'edge-tgt', 'e-tgt', 'p', 'e-x', 0.8, 200);

    mergeEntities(store, 'e-src', 'e-tgt');

    const edges = readAllEdges(db);
    // 性质：源边被删、与目标撞三元组的那条**被合并**（不是并排两条）
    expect(edges.filter((edge) => edge.predicate === 'p')).toHaveLength(1);
    const merged = edges.find((edge) => edge.predicate === 'p');
    expect(merged?.subject_id).toBe('e-tgt');
    expect(merged?.object_id).toBe('e-x');
    // 性质：**取和** = 0.8 + 0.8（不是取大 0.8，也不是相乘）
    expect(merged?.weight).toBeCloseTo(0.8 + 0.8, 12);
    expect(merged?.weight).toBeLessThanOrEqual(params.MAX_EDGE_WEIGHT);
    // 性质：last_active 取两条的较大者
    expect(merged?.last_active).toBe(200);

    // ⚠️ 反例：取大（max）会让合并后的强度只剩 0.8 ⇒ 上面 `toBeCloseTo(1.6)` 变红。
    //   取大等于凭空砍掉一半关系强度，可能直接跌破 ACTIVATION_MIN 让扩散永久失效。
  });

  it('★ 仅**目标实体**身上的自环被清；与本次合并无关的自环必须留着', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');
    insertEntity(db, 'e-other', '王五');
    // 目标自己的自环 + 源自己的自环（迁移后也落在目标身上）+ 一个**无关**的自环
    insertEdge(db, 'edge-loop-tgt', 'e-tgt', 'q', 'e-tgt', 0.8);
    insertEdge(db, 'edge-loop-src', 'e-src', 's', 'e-src', 0.8);
    insertEdge(db, 'edge-loop-other', 'e-other', 'r', 'e-other', 0.8);

    const result = mergeEntities(store, 'e-src', 'e-tgt');

    const edges = readAllEdges(db);
    // 性质：目标身上不再有自环
    expect(
      edges.filter((edge) => edge.subject_id === 'e-tgt' && edge.object_id === 'e-tgt'),
    ).toEqual([]);
    // 性质：**无关的**自环还在（写成 `WHERE subject_id = object_id` 会把它也清掉 ⇒ 误伤）
    expect(edges.some((edge) => edge.id === 'edge-loop-other')).toBe(true);
    // 性质：被清掉的自环计数 = 目标身上的那两条（源的自环迁移后也落在这个范围内）
    expect(result.droppedSelfLoops).toBe(2);
  });

  it('★ 源实体的主名降级为目标的别名（旧名字此后仍能召回）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');
    db.prepare('INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run('老张', 'e-src');

    mergeEntities(store, 'e-src', 'e-tgt');

    // 性质：旧主名现在解析到目标
    expect(resolveEntity(db, '张三')).toBe('e-tgt');
    // 性质：源实体原有的别名也迁到了目标
    expect(resolveEntity(db, '老张')).toBe('e-tgt');
    // 性质：源实体行被删
    expect(countRows(db, 'entities')).toBe(1);
  });

  it('★ 记一条 alias 事件（action=merge，带各计数）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');
    insertEntity(db, 'e-x', '王五');
    insertMemory(db, 'm-1');
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
      'm-1',
      'e-src',
    );
    insertEdge(db, 'edge-src', 'e-src', 'p', 'e-x', 0.8);
    insertEdge(db, 'edge-tgt', 'e-tgt', 'p', 'e-x', 0.8);

    mergeEntities(store, 'e-src', 'e-tgt');

    const events = readEvents(db, 'alias');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.action).toBe('merge');
    expect(events[0]?.payload.sourceId).toBe('e-src');
    expect(events[0]?.payload.targetId).toBe('e-tgt');
    expect(events[0]?.payload.movedMemories).toBe(1);
    expect(events[0]?.payload.mergedEdges).toBe(1);
    // 性质：被降级的主名本体被记下来（名字不能随源实体的删除一起消失）
    expect(events[0]?.payload.alias).toBe('张三');
    // ⚠️ v2.1 勘误（ADR-P1-C 冲突 1）：`aliasAdded` 是**布尔**（是否动过别名映射），
    //   源主名本体在 `alias` 键上 ⇒ 一个事件类型不出现两套词（C36）。
    expect(events[0]?.payload.aliasAdded).toBe(true);
    expect(events[0]?.memory_id).toBeNull();
  });

  it('★ mergeEntities 的返回值用 sourceName 装源主名（ADR-P1-C F-3：不与布尔 aliasAdded 共名）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');

    const result = mergeEntities(store, 'e-src', 'e-tgt');

    // 性质：返回值里的 `sourceName` = 被降级的那条主名（与 payload 的 `alias` 键同源）
    expect(result.sourceName).toBe('张三');
    // ⚠️ **负控**：返回值的键名**不得**叫 `aliasAdded`——
    //   那个键名在事件 payload 里是**布尔**（ADR-P1-C 冲突 1 的裁决），
    //   同名不同义会让读代码的人以为「这里也是布尔」⇒ 断言它**不存在**。
    expect(Object.keys(result)).not.toContain('aliasAdded');
    expect(Object.keys(result)).toContain('sourceName');
  });

  it('★ mergedEdges 只数「因三元组冲突而被折叠掉」的边（不含仅改指的边）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');
    insertEntity(db, 'e-x', '王五');
    insertEntity(db, 'e-y', '赵六');
    // 源实体有 **2 条**边：其中 1 条与目标撞三元组（会被折叠），1 条不撞（仅改指）
    insertEdge(db, 'edge-src-conflict', 'e-src', 'p', 'e-x', 0.8);
    insertEdge(db, 'edge-src-keep', 'e-src', 'q', 'e-y', 0.6);
    insertEdge(db, 'edge-tgt-conflict', 'e-tgt', 'p', 'e-x', 0.8);

    const edgesBefore = countRows(db, 'edges');
    mergeEntities(store, 'e-src', 'e-tgt');
    const edgesAfter = countRows(db, 'edges');

    const payload = readEvents(db, 'alias')[0]?.payload;
    // ★ 关键：口径是「冲突折叠数」= 1；若是「迁移边总数」会是 2 ⇒ 这条断言能区分两种口径
    expect(payload?.mergedEdges).toBe(1);
    // ★ 可对账恒等式（ADR-P1-C 冲突 3 的决定性判据）：
    //   合并前的边数 − 合并后的边数 == mergedEdges + droppedSelfLoops
    //   （每次冲突合并净删一条边；每次自环清理净删一条边；这两者之外边数不变）
    // ⚠️ payload 的静态类型是 `Record<string, unknown>` ⇒ 取出后要显式收窄成 number，
    //   否则 `?? 0` 会被推成 `{}`（TS2365：Operator '+' cannot be applied to types '{}' and '{}'）。
    const mergedCount = (payload?.mergedEdges as number | undefined) ?? 0;
    const droppedCount = (payload?.droppedSelfLoops as number | undefined) ?? 0;
    expect(edgesBefore - edgesAfter).toBe(mergedCount + droppedCount);
  });

  it('★ mergeEntities(x, x) ⇒ 幂等返回（不写库、不记事件）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-1', '张三');
    const before = {
      entities: countRows(db, 'entities'),
      edges: countRows(db, 'edges'),
      events: countRows(db, 'events'),
    };

    const result = mergeEntities(store, 'e-1', 'e-1');

    expect(result.sourceId).toBe('e-1');
    expect(result.targetId).toBe('e-1');
    // 性质：幂等路径**也**返回源主名本体（不是空串）
    //   —— 空串会让调用方以为「源实体没有名字」，与真实路径的语义**相反**。
    expect(result.sourceName).toBe('张三');
    // ⚠️ 反例（负控）：若幂等路径记空串 ⇒ 上面一行失败
    //   ⇒ 这条断言守得住「幂等路径偷懒返回空串」的实现。
    expect(result.sourceName).not.toBe('');
    expect(countRows(db, 'entities')).toBe(before.entities);
    expect(countRows(db, 'edges')).toBe(before.edges);
    expect(countRows(db, 'events')).toBe(before.events);
  });

  it('★ 任一端不存在 ⇒ NOT_FOUND（details.missingIds）且零写入', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-tgt', '李四');

    const missingSource = expectMemoryError(() => mergeEntities(store, 'e-missing', 'e-tgt'));
    expect(missingSource.code).toBe('NOT_FOUND');
    expect(missingSource.details.missingIds).toEqual(['e-missing']);

    const missingTarget = expectMemoryError(() => mergeEntities(store, 'e-tgt', 'e-missing'));
    expect(missingTarget.code).toBe('NOT_FOUND');
    expect(missingTarget.details.missingIds).toEqual(['e-missing']);

    expect(countRows(db, 'entities')).toBe(1);
    expect(countRows(db, 'events')).toBe(0);
  });

  it('★ 合并**不删除任何 memories 行**（§14.3 边界原则 3）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-src', '张三');
    insertEntity(db, 'e-tgt', '李四');
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');

    mergeEntities(store, 'e-src', 'e-tgt');

    expect(countRows(db, 'memories')).toBe(2);
    expect(readContent(db, 'm-1')).toBeDefined();
    expect(readContent(db, 'm-2')).toBeDefined();
  });
});
