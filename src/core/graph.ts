/**
 * 图谱维护的**纯决策层** —— DESIGN-v2.md §4.5 / §4.9.2，对应 DEVELOPMENT-PLAN.md **P1-T05**。
 *
 * ★ 为什么把决策先从 SQL 里抽出来：
 *   P1-T05 的硬断言里**大部分是决策**（自环按 id 判、合并取和、别名撞主名要抛、
 *   `linkByIds` 的存在性要自己校验），它们与「SQL 怎么写」**正交**。
 *   把决策塞进 SQL 字符串里 ⇒ 只能靠端到端测，而端到端测**无法区分**
 *   「SQL 写错了」与「决策写错了」这两种失败。
 *   ⇒ 决策抽成纯函数后：P1-T01 的库表还没落地，这些决策就已经能被单测守住
 *     （DEVELOPMENT-PLAN 的指示：「先在内存结构上把纯逻辑写完并单测，等地基好了再接 DB」）。
 *
 * ⚠️ 本文件**不碰数据库**：所有入参都是内存结构，所有出参都是「该怎么做」的结论。
 *   落地时 `src/store/link.ts` / `src/store/entities.ts` 只负责
 *   「按这个结论去执行 SQL」，不再自己做判断。
 */

import type { Params } from './params.js';

/**
 * 一条边的最小字段（§3 的 `edges` 行的子集）。
 *
 * ⚠️ **刻意只声明决策要用到的字段**（结构化 / 鸭子类型）：
 *   阶段 1 的 `edges` 行、合并时的临时结构、测试里的手算输入都能直接传进来。
 */
export interface GraphEdgeInput {
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string;
  weight: number;
  last_active: number;
  /** 证据记忆 id；`null` = 无证据边（§4.5：这类边永不被 touch 强化）。 */
  memory_id: string | null;
}

/** §4.9.2 步骤 2 的一次边合并结果（三条赋值规则）。 */
export interface MergedEdge {
  weight: number;
  last_active: number;
  memory_id: string | null;
}

/**
 * 自环判定（§4.5 步骤 3）：**必须按 entity_id 比，不能按名称比**。
 *
 * ⚠️ `link('张三', '关联', '老张')` 两个名字不同，但解析后可能是**同一个** entity_id
 *   （老张是张三的别名）⇒ 按名称判会**永远漏**，库里留下一条自环边。
 *   ⇒ 判定时机也写死在步骤 2（建实体/回填 id）**之后**、步骤 3（写边）**之前**：
 *     早了 id 还没回填，晚了边已经写进去了。
 */
export function isSelfLoop(subjectId: string, objectId: string): boolean {
  return subjectId === objectId;
}

/**
 * 边的强化（§4.5）：`min(MAX_EDGE_WEIGHT, weight + EDGE_REINFORCE_STEP)`。
 *
 * ⚠️ **必须取回实际落库值，不要在外面再算一遍 `min()`**——算错一处，
 *   事件里的 `weightAfter` 就与实际权重不符（§4.5 步骤 3 的原话）。
 *   ⇒ 本函数是这个「实际值」的**唯一**算法声明点：SQL 侧与 JS 侧都用它。
 *
 * ⚠️ `last_active` 的刷新**不在**这里：它是**无条件**的，
 *   不能因为 `weight` 已满格就跳过（已封顶的边不刷新 `last_active` ⇒
 *   仍会随时间跌回阈值以下 ⇒「用得越多死得越快」，与规则意图相反）。
 */
export function reinforceWeight(weight: number, params: Params): number {
  return Math.min(params.MAX_EDGE_WEIGHT, weight + params.EDGE_REINFORCE_STEP);
}

/**
 * `linkByIds` / `touch` 的存在性校验用的**差集**（§4.5 步骤 4 + §11.2）。
 *
 * ⚠️ **必须自己校验，不能指望外键**：
 *   · FK 报的是未类型化的 `SQLITE_CONSTRAINT_FOREIGNKEY`，会**原样穿给调用方**；
 *   · `PRAGMA foreign_keys` 是**每连接**开关，漏开时**不报错也不告警** ⇒ 静默写入悬空边。
 *
 * @param requested 调用方传入的 id（**顺序与重复都保留**到结果里，便于人对账）
 * @param existing 库里真实存在的 id
 * @returns 差集（保持 `requested` 的顺序、去重）；为空表示全部存在
 */
export function missingIds(requested: readonly string[], existing: readonly string[]): string[] {
  const present = new Set(existing);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of requested) {
    if (present.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * §4.9.2 步骤 2 的一次边合并：**取和，不取大**。
 *
 * ⚠️ 取和的理由（§4.9.2 原话）：取大等于**凭空砍掉一半关系强度**——
 *   两条各 0.8 的边合并后应得 1.6；若取大只剩 0.8。
 *   这不是「数值偏好」而是功能正确性：合并后强度被砍会让扩散激活
 *   （§4.7 的 `w × e^(-Δt/30) ≥ ACTIVATION_MIN` 窗口）**永久失效**——
 *   一种**沉默的功能消失**（不报错、不告警，只是「联想不出来了」）。
 *
 * 三条赋值规则（顺序无关）：
 *   · `weight = min(MAX_EDGE_WEIGHT, e2.weight + e.weight)`
 *   · `last_active = max(e2.last_active, e.last_active)`（不引入当前时刻 ⇒ `mergeEntities` 在 §11.1 豁免清单里）
 *   · `memory_id = COALESCE(e2.memory_id, e.memory_id)`（保留已有证据，不覆盖）
 *
 * @param target 保留下来的那条边（`e2`）
 * @param source 被合并进来的那条边（`e`）
 */
export function mergeEdges(
  target: GraphEdgeInput,
  source: GraphEdgeInput,
  params: Params,
): MergedEdge {
  return {
    weight: Math.min(params.MAX_EDGE_WEIGHT, target.weight + source.weight),
    last_active: Math.max(target.last_active, source.last_active),
    memory_id: target.memory_id ?? source.memory_id,
  };
}

/**
 * §4.9.2 步骤 2b：挑出合并后**仅目标实体身上**的自环。
 *
 * ⚠️ **不要写成 `WHERE subject_id = object_id`**——那会把**全库所有自环**清掉
 *   （包括与本次合并完全无关的），属误伤；而误伤在测试里很难发现，
 *   因为「别人的自环」通常是测试数据里不存在的东西。
 *
 * @param edges 候选边集合（通常是目标实体相关的边）
 * @param targetId 合并后保留的实体 id
 */
export function selectMergeSelfLoops(
  edges: readonly GraphEdgeInput[],
  targetId: string,
): GraphEdgeInput[] {
  return edges.filter((edge) => edge.subject_id === targetId && edge.object_id === targetId);
}

/**
 * §4.9.2 `setAlias` 的冲突检测：alias **不得是任何既有主名**。
 *
 * ⚠️ **这一处刻意不用 `resolveEntity()`**（§4.9.2 原话）：
 *   `resolveEntity` 的三处语义是「解析成 id」，这里要的是「**检测冲突并抛错**」——
 *   语义恰好相反。若误收拢，`setAlias` 会把「命中」当成成功返回，
 *   冲突检测**静默失效**（不报错、不告警，只是别名表里多了一行指向别人的映射）。
 *
 * @param alias 待设置的别名
 * @param primaryNames 主名 → entity_id 的映射
 * @returns 冲突的 `entity_id`；无冲突返回 `null`
 */
export function findPrimaryNameConflict(
  alias: string,
  primaryNames: Readonly<Record<string, string>>,
): string | null {
  return Object.prototype.hasOwnProperty.call(primaryNames, alias)
    ? (primaryNames[alias] ?? null)
    : null;
}
