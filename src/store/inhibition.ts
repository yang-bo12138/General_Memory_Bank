/**
 * 抑制诊断 —— DESIGN-v2.md §6 的 `inhibitionTrace(context, options?)`
 * （对应 DEVELOPMENT-PLAN.md **P3-T02**）。
 *
 * ★ **纯读**：不写库、不写 events、不更新 `last_access`。
 *   ⇒ 只读实例上可直接调用（§7.1 的「7 个允许读的方法」之一）。
 *
 * ★ **必须与 `recall` 走同一段打分代码**（§6 的原文）：
 *   「否则『trace 看到的』和『recall 实际发生的』会漂移。」
 *   ⇒ 本文件**不自己算分**：它调用 `recall.ts` 的共用流水线
 *   （`collectScoredCandidates()`）⇒ `baseScore` 与 `recall` 的 `Hit.score`
 *   **逐位相同**是**结构上**保证的，而不是靠「两边算得一样」这种约定。
 *
 * ⚠️ **结构刻意不含 `penalty` / `finalScore`**（§6）：
 *   抑制是候选集级后置筛选，**不改 score**（§4.13.1 硬约束①）⇒
 *   诊断里出现「最终分」会让人以为抑制改过分数。
 */

import { resolveNow } from '../core/clock.js';
import {
  type InhibitionCandidate,
  compareInhibitionCandidates,
  inhibitCandidates,
  loadClusterIds,
  loadInhibitionFacts,
} from '../neuron/inhibit.js';
import { type RecallStore, clampTopN, collectScoredCandidates } from './recall.js';

/** `inhibitionTrace` 的入参（§6 的 `options?: { now?: number }` + 阶段 5 的 `queryEmbedding`）。 */
export interface InhibitionTraceOptions {
  /** 注入时钟（C37）。 */
  now?: number;
  /**
   * 查询向量（**未归一化**，与 `RecallOptions.queryEmbedding` **同一个口径**）。
   *
   * ⚠️ ★ **必须与那一次 `recall` 传同一条**，否则本方法在 §6 的
   *   「`baseScore` 与 `Hit.score` **逐位一致**」这条承诺下**给不出可比的数**：
   *   trace 不含 `0.25 × vectorSim`、recall 含 ⇒ 差额 ∈ `[0, SCORE_WEIGHTS.vectorSim]`。
   *   ⇒ 忘记传的症状是「trace 的分数普遍略低于 recall」，**不报错**（RK-8）。
   * ⚠️ **不传 ⇒ 行为与本设计之前完全一致**（向量路整路缺席）：
   *   这正是「既有调用方零影响」的那一层，也是它可以被默认安全忽略的原因。
   * ⚠️ **为什么加在这里而不是让调用方「去掉向量再问一次」**：
   *   去掉向量之后的那次打分**对不上任何一次真实召回** ⇒ 诊断输出失去意义
   *   （那正是 §6 引入本方法时要消除的那种漂移）。
   * ⚠️ **它不破坏公开契约**：公开面的承诺是「**23 个方法**」（方法名集合），
   *   加一个**可选**字段既不改方法名、也不改方法数。
   */
  queryEmbedding?: number[];
}

/** 候选集里的一条（§6 的 `inhibitionTrace` 返回形状）。 */
export interface InhibitionTraceCandidate {
  /** 候选 id。 */
  id: string;
  /** 五因子分，**逐位等于**该候选的 `Hit.score`（§6）。 */
  baseScore: number;
  /**
   * 主题簇（**诊断上下文**，抑制**不消费**它，§4.13.2）。
   *
   * ⚠️ **簇不参与判定** ⇒ 即使某条记忆真的在某个簇里，也**不会**因此被判冗余。
   */
  clusterId: string | null;
  /** 与谁冗余（**留在 hits 里的那条**）；溢出候选**没有**这个键。 */
  redundantWith?: string;
  /** 该冗余对的余弦（`null` = 双方不可比 ⇒ 键不出现）。 */
  redundancySim?: number;
  /**
   * `true` = **被抑制机制挤掉**（D 桶：确实冗余）。
   *
   * ⚠️ **溢出候选（O 桶）恒为 `false`**：它们**根本没参与评估** ⇒
   *   没有合法的 `redundantWith` ⇒ 标成「被抑制」是**语义污染**（§6 / §4.13.3）。
   */
  inhibited: boolean;
}

/** `inhibitionTrace` 的返回值（§6）。 */
export interface InhibitionTraceResult {
  /** 全部候选（按 `(score DESC, id ASC)` 全序）。 */
  candidates: InhibitionTraceCandidate[];
  /** 实际进 hits 的那些（R 桶）。 */
  selected: Array<{ id: string; baseScore: number }>;
}

/**
 * `inhibitionTrace(context, options?)` —— §6 的抑制诊断。
 *
 * ⚠️ **与 `recall` 的差异只有一处**：`recall` 走「上下文 + 可选实体 + topN + …」，
 *   而本方法**只接 `context`**（§6 的签名如此）⇒ 它的候选集 = `recall({ context })` 的候选集
 *   （图谱路为空，因为没传实体）⇒ **两者可直接对比**。
 *
 * ⚠️ **名额用 `RECALL_TOP_N` 的默认值**（并经**同一个** `clampTopN()` 钳制）
 *   ⇒ `selected` 与 `recall({ context })` 的 hits **同口径**。
 *
 * @param store 库句柄 + 生效参数（+ 可选的向量端口，由门面装配）
 * @param context 召回上下文（与 `recall` 完全相同的入参）
 * @param options 可选（注入时钟 + 查询向量）
 * @returns 候选集的抑制诊断
 */
export function inhibitionTrace(
  store: RecallStore,
  context: string,
  options?: InhibitionTraceOptions,
): InhibitionTraceResult {
  const params = store.params;
  const at = resolveNow(options?.now);
  const topN = clampTopN(undefined, params.RECALL_TOP_N);

  // ⚠️ **走与 `recall` 同一段打分代码**（§6）⇒ `baseScore` 逐位相同。
  // ⚠️ **`queryEmbedding` 原样透传**（D8）：两边传同一条 ⇒ 逐位相等；
  //   只有 recall 传 ⇒ 差额 ∈ `[0, 0.25]`（那正是「有没有这条证据」的差）。
  // ⚠️ **`exactOptionalPropertyTypes` ⇒ 条件展开**（显式 `undefined` 与「没这个属性」不同）。
  const pipeline = collectScoredCandidates(store, {
    context,
    entityIds: undefined,
    entityNames: undefined,
    includeArchived: false,
    now: at,
    ...(options?.queryEmbedding === undefined ? {} : { queryEmbedding: options.queryEmbedding }),
  });

  const facts: InhibitionCandidate[] = loadInhibitionFacts(store.db, pipeline.scored);
  const outcome = inhibitCandidates(facts, topN, params);
  const clusterIds = loadClusterIds(
    store.db,
    facts.map((fact) => fact.id),
  );

  const redundantById = new Map(
    outcome.redundant.map((entry) => [entry.candidate.id, entry] as const),
  );

  // ⚠️ **`candidates` 与 `selected` 用同一个全序**（`(score DESC, id ASC)`）：
  //   否则 trace 里的候选顺序与排名对不上 ⇒ 读的人得自己再排一次才能对照。
  const candidates: InhibitionTraceCandidate[] = [...facts]
    .sort(compareInhibitionCandidates)
    .map((fact) => {
      const entry = redundantById.get(fact.id);
      const item: InhibitionTraceCandidate = {
        id: fact.id,
        baseScore: fact.score,
        clusterId: clusterIds.get(fact.id) ?? null,
        inhibited: entry !== undefined,
      };
      if (entry !== undefined) {
        item.redundantWith = entry.redundantWith;
        if (entry.redundancySim !== null) {
          item.redundancySim = entry.redundancySim;
        }
      }
      return item;
    });

  return {
    candidates,
    selected: outcome.kept.map((kept) => ({ id: kept.id, baseScore: kept.score })),
  };
}
