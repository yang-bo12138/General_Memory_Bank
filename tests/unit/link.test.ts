/**
 * P1-T05 · 图谱写入：`link` / `linkByIds` 的端到端断言 —— DESIGN-v2.md §4.5。
 *
 * ★ 断言纪律：
 *   · **写性质，不写当次的形状**：断言一律引用 `params` 里的参数值
 *     （如 `INITIAL_EDGE_WEIGHT + EDGE_REINFORCE_STEP`），不写死字面数字；
 *   · **每条关键断言配一条反例**：故意写出那个会错的写法，断言它确实会错、而实现不会错。
 *
 * ⚠️ 本文件测的是**真实 SQLite**（内存库）：「事务回滚」「UPSERT 语义」
 *   「外键级联」这三类只有真库才验得了（见 `tests/fixtures/graph-store.ts`）。
 */

import { describe, expect, it } from 'vitest';

import { resolveEntity } from '../../src/core/entities.js';
import { MemoryError } from '../../src/core/errors.js';
import { setAlias } from '../../src/store/entities.js';
import { link, linkByIds } from '../../src/store/link.js';
import {
  countRows,
  createTestStore,
  insertEntity,
  insertMemory,
  readEdge,
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

describe('P1-T05 · link（§4.5 的四步）', () => {
  it('★ 重复同一三元组 ⇒ 不产生重复边，而是强化（weight 按 EDGE_REINFORCE_STEP 增长）', () => {
    const { db, store, params } = createTestStore();

    const first = link(store, '张三', '关联', '李四');
    const second = link(store, '张三', '关联', '李四');

    // 性质：边只有一条（不是每次 link 插一条新的）
    expect(countRows(db, 'edges')).toBe(1);
    // 性质：权重按强化步长增长，且**取回的是实际落库值**
    expect(second.weightAfter).toBeCloseTo(first.weightAfter + params.EDGE_REINFORCE_STEP, 12);
    expect(first.weightAfter).toBeCloseTo(params.INITIAL_EDGE_WEIGHT, 12);

    const edge = readEdge(db, second.subjectId, second.predicate, second.objectId);
    expect(edge).toBeDefined();
    expect(edge?.weight).toBeCloseTo(second.weightAfter, 12);
  });

  it('★ 权重按 MAX_EDGE_WEIGHT 截断；封顶后 last_active 仍无条件刷新', () => {
    const { db, store, params } = createTestStore();

    let last = link(store, '张三', '关联', '李四');
    // 反复强化直到封顶
    for (let i = 0; i < 20; i += 1) {
      last = link(store, '张三', '关联', '李四', null, i + 1);
    }

    // 性质：封顶后不再增长
    expect(last.weightAfter).toBe(params.MAX_EDGE_WEIGHT);
    expect(last.weightAfter).toBeLessThanOrEqual(params.MAX_EDGE_WEIGHT);
    // 性质：**已封顶的边仍然刷新 last_active**（否则「用得越多死得越快」）
    const edge = readEdge(db, last.subjectId, last.predicate, last.objectId);
    expect(edge?.weight).toBe(params.MAX_EDGE_WEIGHT);
    expect(edge?.last_active).toBe(20);

    // ⚠️ 反例：若实现按「weight 已满格就跳过整条 UPDATE」，
    //   last_active 会停在旧值 ⇒ 下面的断言失败（它失败的原因就是这条）。
    expect(edge?.last_active).not.toBe(1);
  });

  it('★ link("张三","关联","张三") ⇒ INVALID_INPUT，且库里没有留下任何实体行（回滚生效）', () => {
    const { db, store } = createTestStore();

    const error = expectMemoryError(() => link(store, '张三', '关联', '张三'));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toHaveProperty('subjectId');
    expect(error.details).toHaveProperty('predicate');

    // ★ **零写入**：自环抛错时，步骤 2 建出来的实体必须被回滚掉
    //   （否则库里会多一批永远没人引用的孤儿实体）。
    expect(countRows(db, 'entities')).toBe(0);
    expect(countRows(db, 'edges')).toBe(0);
    expect(countRows(db, 'events')).toBe(0);

    // ⚠️ 反例：若建实体与写边**不在同一事务**（为了拿 id 提前 COMMIT），
    //   上面三行会看到 entities = 1 ⇒ 断言失败（失败原因就是「回滚没生效」）。
  });

  it('★ link("张三","关联","老张")（老张是张三的别名）⇒ INVALID_INPUT（按 id 判自环，不是按名）', () => {
    const { db, store } = createTestStore();

    // 先把「老张」设成「张三」的别名
    const created = link(store, '张三', '关联', '李四');
    setAlias(store, '老张', created.subjectId);
    const entitiesBefore = countRows(db, 'entities');

    const error = expectMemoryError(() => link(store, '张三', '关联', '老张'));
    expect(error.code).toBe('INVALID_INPUT');
    // 性质：两个**名字**不同（张三 ≠ 老张），但解析到同一个 entity_id ⇒ 仍是自环。
    const subjectName: string = '张三';
    const objectName: string = '老张';
    expect(subjectName === objectName).toBe(false);
    expect(countRows(db, 'entities')).toBe(entitiesBefore);

    // ⚠️ 反例：若按**名称**比较自环，`'张三' === '老张'` 为 false ⇒ 不抛错 ⇒ 上面变红。
  });

  it('★ createMissing:false 对不存在的实体 ⇒ NOT_FOUND 且零写入', () => {
    const { db, store } = createTestStore();

    const error = expectMemoryError(() =>
      link(store, '不存在甲', '关联', '不存在乙', null, undefined, { createMissing: false }),
    );
    expect(error.code).toBe('NOT_FOUND');
    // 性质：差集装的是缺失的端点名
    expect(error.details.missingIds).toEqual(['不存在甲', '不存在乙']);

    // ★ **零写入**：禁止「一边自动建、一边抛错」的混合策略
    expect(countRows(db, 'entities')).toBe(0);
    expect(countRows(db, 'edges')).toBe(0);
    expect(countRows(db, 'events')).toBe(0);
  });

  it('★ linkByIds 对不存在的 entityId ⇒ NOT_FOUND（不是裸的 FK 错误码）', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-existing', '张三');

    const error = expectMemoryError(() => linkByIds(store, 'e-existing', '关联', 'e-missing'));
    expect(error.code).toBe('NOT_FOUND');
    // ⚠️ **不是**未类型化的 SQLite 错误码（`SQLITE_CONSTRAINT_FOREIGNKEY`）
    expect(error.code).not.toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    expect(error.details.missingIds).toEqual(['e-missing']);
    expect(countRows(db, 'edges')).toBe(0);
    expect(countRows(db, 'events')).toBe(0);
  });

  it('★ 每次 link 都产生一条 link 事件（含 weightAfter 与 autoCreatedEntities）', () => {
    const { db, store } = createTestStore();

    link(store, '张三', '关联', '李四');
    link(store, '张三', '关联', '李四');

    const events = readEvents(db, 'link');
    // 性质：**每次** link 都有事件（不能只在「自动建了实体」的分支里记，
    //   否则「重复 link 强化了权重」完全不留痕）
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.payload).toHaveProperty('weightAfter');
      expect(event.payload).toHaveProperty('autoCreatedEntities');
      expect(event.payload).toHaveProperty('subjectId');
      expect(event.payload).toHaveProperty('predicate');
      expect(event.payload).toHaveProperty('objectId');
    }
    // 性质：第二条事件的 weightAfter 更大（强化被记下来了）
    const first = events[0]?.payload.weightAfter as number;
    const second = events[1]?.payload.weightAfter as number;
    expect(second).toBeGreaterThan(first);
  });

  it('★ autoCreatedEntities 只含本次**真正新建**的实体（既有实体与别名命中都不算）', () => {
    const { db, store } = createTestStore();

    // 两个全新端点 ⇒ 两个都是本次新建的
    const first = link(store, '新甲', '关联', '新乙');
    expect(first.autoCreatedEntities).toHaveLength(2);
    expect(first.autoCreatedEntities).toContain('新甲');
    expect(first.autoCreatedEntities).toContain('新乙');

    // 一个既有端点 ⇒ 它**不算**本次新建的
    const second = link(store, '新甲', '关联', '新丙');
    expect(second.autoCreatedEntities).not.toContain('新甲');
    expect(second.autoCreatedEntities).toHaveLength(1);
    expect(second.autoCreatedEntities).toContain('新丙');

    // 别名命中 ⇒ 解析得到既有实体 ⇒ 也**不算**新建
    setAlias(store, '老甲', first.subjectId);
    const third = link(store, '老甲', '关联', '新丁');
    expect(third.autoCreatedEntities).not.toContain('老甲');
    expect(third.autoCreatedEntities).toHaveLength(1);
    expect(third.autoCreatedEntities).toContain('新丁');

    // 事件里带的也是同一份名单
    const events = readEvents(db, 'link');
    expect(events[0]?.payload.autoCreatedEntities).toEqual(first.autoCreatedEntities);
  });

  it('★ 反例：先建实体、再 resolveEntity 查 ⇒ autoCreatedEntities 恒为空（缺陷复现）', () => {
    const { db, store } = createTestStore();

    link(store, '新甲', '关联', '新乙');

    // ⚠️ **旧实现（缺陷版）的判定方式**：建完之后再查「这个名字还解析不到吗」
    //   ⇒ 实体**必然**就在库里 ⇒ 判定恒为「不是新建」⇒ 名单恒为空。
    const buggy = ['新甲', '新乙'].filter((name) => resolveEntity(db, name) === null);
    expect(buggy).toEqual([]);

    // 正确实现：**建之前**记 null ⇒ 只有原本解析不到的端点才算新建
    const correct = link(store, '新丙', '关联', '新丁').autoCreatedEntities;
    expect(correct).toHaveLength(2);
  });

  it('★ linkByIds 跳过建实体（autoCreatedEntities 恒为 []），但照常强化 / 记事件', () => {
    const { db, store, params } = createTestStore();
    insertEntity(db, 'e-a', '甲');
    insertEntity(db, 'e-b', '乙');

    const first = linkByIds(store, 'e-a', '关联', 'e-b');
    const second = linkByIds(store, 'e-a', '关联', 'e-b');

    expect(first.autoCreatedEntities).toEqual([]);
    expect(second.autoCreatedEntities).toEqual([]);
    expect(countRows(db, 'entities')).toBe(2);
    expect(countRows(db, 'edges')).toBe(1);
    expect(second.weightAfter).toBeCloseTo(first.weightAfter + params.EDGE_REINFORCE_STEP, 12);
    expect(readEvents(db, 'link')).toHaveLength(2);
  });

  it('★ linkByIds 对自环（同一个 entityId）⇒ INVALID_INPUT 且零写入', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-a', '甲');

    const error = expectMemoryError(() => linkByIds(store, 'e-a', '关联', 'e-a'));
    expect(error.code).toBe('INVALID_INPUT');
    expect(countRows(db, 'edges')).toBe(0);
    expect(countRows(db, 'events')).toBe(0);
  });

  it('★ 带 memoryId 的 link ⇒ 事件带上 memoryId，且边记住了证据记忆', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');

    const result = link(store, '张三', '关联', '李四', 'm-1');
    const edge = readEdge(db, result.subjectId, result.predicate, result.objectId);
    expect(edge?.memory_id).toBe('m-1');

    const events = readEvents(db, 'link');
    expect(events).toHaveLength(1);
    expect(events[0]?.memory_id).toBe('m-1');
    expect(events[0]?.payload.memoryId).toBe('m-1');
  });

  it('★ 无证据边（memoryId 缺省）⇒ memory_id 为 NULL（它是「断言」不是「记忆」）', () => {
    const { db, store } = createTestStore();

    const result = link(store, '张三', '关联', '李四');
    const edge = readEdge(db, result.subjectId, result.predicate, result.objectId);
    expect(edge?.memory_id).toBeNull();

    // 事件里 memory_id 传 null（§8.4 硬规则 6：必传实参、值可为 null）
    const events = readEvents(db, 'link');
    expect(events[0]?.memory_id).toBeNull();
  });

  it('★ 证据记忆不存在 ⇒ 外键错误已被**转译**成 NOT_FOUND（不穿裸 SQLite 错误码）', () => {
    const { db, store } = createTestStore();

    const error = expectMemoryError(() => link(store, '张三', '关联', '李四', 'm-missing'));

    // ⚠️ §11.2：「客户端只应看到本类，裸的 SQLite 错误码不得穿到调用方」。
    //   `edges.memory_id` 有外键 ⇒ 不存在的记忆 id 会撞 FK；
    //   `runWriteTransaction` 把它转成 `NOT_FOUND`（语义 =「被引用的行不存在」）。
    expect(error.code).toBe('NOT_FOUND');
    expect(error.code).not.toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    // 性质：撞 FK 的那一次**零写入**
    expect(countRows(db, 'entities')).toBe(0);
    expect(countRows(db, 'edges')).toBe(0);
  });
});
