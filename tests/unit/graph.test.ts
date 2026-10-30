/**
 * 图谱维护纯决策层的单测 —— DESIGN-v2.md §4.5 / §4.9.2，
 * 对应 DEVELOPMENT-PLAN.md **P1-T05**。
 *
 * ★ 断言纪律（与 P1-T04 同一套）：
 *   · **每条断言配一条反例**：故意写出那个会错的写法，断言它确实会错、而实现不会错；
 *   · **不写死「本次跑出来几条」**：性质类断言用网格遍历；
 *   · **数值用例手算可复算**（0.8 + 0.8 = 1.6、min(3.0, 3.2) = 3.0 这类）。
 *
 * ⚠️ 本文件测的是**决策**，不是 SQL：
 *   P1-T01 的库表落地后，`src/store/link.ts` / `src/store/entities.ts` 只负责按这里的
 *   结论去执行 SQL。⇒ 决策错了这里变红，SQL 错了那里的端到端测变红，两者不会互相掩盖。
 */

import { describe, expect, it } from 'vitest';

import {
  type GraphEdgeInput,
  findPrimaryNameConflict,
  isSelfLoop,
  mergeEdges,
  missingIds,
  reinforceWeight,
  selectMergeSelfLoops,
} from '../../src/core/graph.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';

/** 生效参数（默认表）。 */
const P: Params = DEFAULT_PARAMS;

/** 构造一条手算用的边。 */
function edge(overrides: Partial<GraphEdgeInput> = {}): GraphEdgeInput {
  return {
    id: 'e',
    subject_id: 'A',
    predicate: '关联',
    object_id: 'B',
    weight: 0.8,
    last_active: 0,
    memory_id: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// isSelfLoop
// ─────────────────────────────────────────────────────────────

describe('isSelfLoop（§4.5 步骤 3）', () => {
  it('同一个 entity_id ⇒ 自环；不同 ⇒ 不是', () => {
    expect(isSelfLoop('e1', 'e1')).toBe(true);
    expect(isSelfLoop('e1', 'e2')).toBe(false);
  });

  it('★ 反例：按**名称**比较会漏掉「名字不同但同一个实体」的自环', () => {
    // link('张三', '关联', '老张')：老张是张三的别名 ⇒ 两端解析后都是 e1。
    const subjectName = '张三';
    const objectName = '老张';
    const subjectId = 'e1';
    const objectId = 'e1'; // 别名解析后指向同一个实体

    const byName = (a: string, b: string): boolean => a === b;
    expect(byName(subjectName, objectName)).toBe(false); // 错的实现：漏判 ⇒ 库里留下自环
    expect(isSelfLoop(subjectId, objectId)).toBe(true); // 实现：抓到
  });
});

// ─────────────────────────────────────────────────────────────
// reinforceWeight
// ─────────────────────────────────────────────────────────────

describe('reinforceWeight（§4.5）', () => {
  it('= min(MAX_EDGE_WEIGHT, weight + EDGE_REINFORCE_STEP)（手算：0.8+0.3=1.1）', () => {
    expect(reinforceWeight(0.8, P)).toBeCloseTo(1.1, 12);
    expect(reinforceWeight(0, P)).toBeCloseTo(P.EDGE_REINFORCE_STEP, 12);
  });

  it('封顶：2.9 + 0.3 = 3.2 ⇒ 被 MAX_EDGE_WEIGHT 夹到 3.0（已满格仍是 3.0）', () => {
    expect(reinforceWeight(2.9, P)).toBe(P.MAX_EDGE_WEIGHT);
    expect(reinforceWeight(P.MAX_EDGE_WEIGHT, P)).toBe(P.MAX_EDGE_WEIGHT);
  });

  it('★ 反例：不取 `min` ⇒ 权重越过 MAX_EDGE_WEIGHT（事件里的 weightAfter 与库内不符）', () => {
    const withoutClamp = 2.9 + P.EDGE_REINFORCE_STEP; // 3.2
    expect(withoutClamp).toBeGreaterThan(P.MAX_EDGE_WEIGHT);
    expect(reinforceWeight(2.9, P)).toBe(P.MAX_EDGE_WEIGHT);
    expect(reinforceWeight(2.9, P)).not.toBe(withoutClamp);
  });

  it('★ 反例：拿「强化后权重没变」当跳过理由 ⇒ 会跳过已满格边的 last_active 刷新', () => {
    // §4.5 原话：`last_active` 必须**无条件**刷新。
    // 已满格的边：weight 前后都是 3.0 ⇒ 「没变」这个判据**恰好**会把它挑出来跳过。
    const capped = P.MAX_EDGE_WEIGHT;
    expect(reinforceWeight(capped, P) === capped).toBe(true); // 权重确实没变…
    // …但「没变」并不意味着不该刷新 last_active：衰减读的就是 last_active。
    // ⇒ 这里断言的是「本函数只负责算权重，不提供任何『是否可以跳过』的信号」：
    expect(reinforceWeight(capped, P)).toBe(capped);
    // 而正确的调用侧行为是：无论返回值是否变化，都要 `last_active = now`。
  });
});

// ─────────────────────────────────────────────────────────────
// missingIds
// ─────────────────────────────────────────────────────────────

describe('missingIds（§4.5 步骤 4 / §11.2）', () => {
  it('差集 = 请求里有、库里没有的（保持请求顺序、去重）', () => {
    expect(missingIds(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    expect(missingIds(['c', 'b', 'a'], ['a'])).toEqual(['c', 'b']);
    expect(missingIds(['a', 'a', 'b'], ['a'])).toEqual(['b']);
  });

  it('全部存在 ⇒ 空数组（不是 undefined / null）', () => {
    expect(missingIds(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(missingIds([], ['a'])).toEqual([]);
  });

  it('★ 反例：返回**交集**或**恒空**都会被这条断言抓住', () => {
    const requested = ['a', 'b', 'c'];
    const existing = ['a', 'c'];
    const intersection = requested.filter((id) => existing.includes(id)); // 错的实现
    expect(intersection).toEqual(['a', 'c']);
    expect(missingIds(requested, existing)).toEqual(['b']);
    expect(missingIds(requested, existing)).not.toEqual(intersection);
    expect(missingIds(requested, existing)).not.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// mergeEdges
// ─────────────────────────────────────────────────────────────

describe('mergeEdges（§4.9.2 步骤 2）', () => {
  it('★ 权重**取和**：两条各 0.8 ⇒ 1.6（不取大）', () => {
    const merged = mergeEdges(edge({ id: 'e2', weight: 0.8 }), edge({ id: 'e1', weight: 0.8 }), P);
    expect(merged.weight).toBeCloseTo(1.6, 12);
  });

  it('取和仍受 MAX_EDGE_WEIGHT 封顶（2.0 + 1.5 = 3.5 ⇒ 3.0）', () => {
    const merged = mergeEdges(edge({ weight: 2.0 }), edge({ weight: 1.5 }), P);
    expect(merged.weight).toBe(P.MAX_EDGE_WEIGHT);
  });

  it('last_active 取**较大者**（不引入当前时刻 ⇒ mergeEntities 在 §11.1 豁免清单里）', () => {
    const merged = mergeEdges(edge({ last_active: 100 }), edge({ last_active: 200 }), P);
    expect(merged.last_active).toBe(200);
    const reversed = mergeEdges(edge({ last_active: 200 }), edge({ last_active: 100 }), P);
    expect(reversed.last_active).toBe(200); // 与顺序无关
  });

  it('memory_id = COALESCE(目标, 来源)：已有证据不被覆盖', () => {
    expect(mergeEdges(edge({ memory_id: 'm2' }), edge({ memory_id: 'm1' }), P).memory_id).toBe(
      'm2',
    );
    expect(mergeEdges(edge({ memory_id: null }), edge({ memory_id: 'm1' }), P).memory_id).toBe(
      'm1',
    );
    expect(mergeEdges(edge({ memory_id: 'm2' }), edge({ memory_id: null }), P).memory_id).toBe(
      'm2',
    );
    expect(
      mergeEdges(edge({ memory_id: null }), edge({ memory_id: null }), P).memory_id,
    ).toBeNull();
  });

  it('★ 反例：取**大**会凭空砍掉一半关系强度（0.8 + 0.8 ⇒ 只剩 0.8）', () => {
    const target = edge({ weight: 0.8 });
    const source = edge({ weight: 0.8 });
    const wrongTakeMax = Math.max(target.weight, source.weight);
    expect(wrongTakeMax).toBeCloseTo(0.8, 12);
    expect(mergeEdges(target, source, P).weight).toBeCloseTo(1.6, 12);
    expect(mergeEdges(target, source, P).weight).not.toBeCloseTo(wrongTakeMax, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// selectMergeSelfLoops
// ─────────────────────────────────────────────────────────────

describe('selectMergeSelfLoops（§4.9.2 步骤 2b）', () => {
  /** 一批候选边：T 是合并后的目标，X 是与本次合并**无关**的实体。 */
  const candidates: GraphEdgeInput[] = [
    edge({ id: '1', subject_id: 'T', object_id: 'T' }), // 目标身上的自环 ⇒ 该清
    edge({ id: '2', subject_id: 'T', object_id: 'X' }), // 正常边 ⇒ 不动
    edge({ id: '3', subject_id: 'X', object_id: 'T' }), // 正常边 ⇒ 不动
    edge({ id: '4', subject_id: 'X', object_id: 'X' }), // **别人**的自环 ⇒ 绝不能动
  ];

  it('只挑出目标身上的自环', () => {
    expect(selectMergeSelfLoops(candidates, 'T').map((e) => e.id)).toEqual(['1']);
  });

  it('★ 反例：写成 `subject_id === object_id` 会把**全库**自环都清掉（误伤与本次无关的）', () => {
    const wrongFilter = candidates.filter((e) => e.subject_id === e.object_id);
    expect(wrongFilter.map((e) => e.id)).toEqual(['1', '4']); // 多清了 '4'
    expect(selectMergeSelfLoops(candidates, 'T').map((e) => e.id)).toEqual(['1']);
    expect(selectMergeSelfLoops(candidates, 'T').length).toBeLessThan(wrongFilter.length);
  });
});

// ─────────────────────────────────────────────────────────────
// findPrimaryNameConflict
// ─────────────────────────────────────────────────────────────

describe('findPrimaryNameConflict（§4.9.2 setAlias）', () => {
  const primaryNames: Readonly<Record<string, string>> = { 张三: 'e1', 李四: 'e2' };

  it('alias 撞既有主名 ⇒ 返回该主名的 entity_id（调用方据此抛 CONFLICT）', () => {
    expect(findPrimaryNameConflict('张三', primaryNames)).toBe('e1');
  });

  it('不撞 ⇒ null（可以写入）', () => {
    expect(findPrimaryNameConflict('老张', primaryNames)).toBeNull();
    expect(findPrimaryNameConflict('', primaryNames)).toBeNull();
  });

  it('原型链上的键不算命中（`constructor` / `toString` 不能被当成主名）', () => {
    expect(findPrimaryNameConflict('constructor', primaryNames)).toBeNull();
    expect(findPrimaryNameConflict('toString', primaryNames)).toBeNull();
  });

  it('★ 反例：误用 `resolveEntity` 的语义（命中即成功返回）⇒ 冲突检测静默失效', () => {
    // `resolveEntity` 的三处语义是「解析成 id」：命中就当成功、返回 id。
    // setAlias 若照搬 ⇒ 撞主名时拿到 'e1' 就返回，别名表里多一行指向别人的映射，不报错。
    const resolveEntityLike = (name: string): string | null => primaryNames[name] ?? null;
    const wrongResult = resolveEntityLike('张三');
    expect(wrongResult).toBe('e1'); // 错的实现：当成「成功」
    // 实现：同一个返回值是**冲突信号** ⇒ 调用方必须抛 CONFLICT
    expect(findPrimaryNameConflict('张三', primaryNames)).not.toBeNull();
  });
});
