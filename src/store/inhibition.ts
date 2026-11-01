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
  inhibitCandidates,
  loadClusterIds,
  loadInhibitionFacts,
} from '../neuron/inhibit.js';
import { type RecallStore, clampTopN, collectScoredCandidates } from './recall.js';

/** `inhibitionTrace` 的入参（§6：`options?: { now?: number }`）。 */
export interface InhibitionTraceOptions {
  /** 注入时钟（C37）。 */
  now?: number;
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
 * @param store 库句柄 + 生效参数
 * @param context 召回上下文（与 `recall` 完全相同的入参）
 * @param options 可选（注入时钟）
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
  const pipeline = collectScoredCandidates(store, {
    context,
    entityIds: undefined,
    entityNames: undefined,
    includeArchived: false,
    now: at,
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

  const candidates: InhibitionTraceCandidate[] = facts.map((fact) => {
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
