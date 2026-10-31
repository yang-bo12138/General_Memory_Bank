/**
 * 桶质量的度量 —— P2-T06（DESIGN-v2.md §9.3.2 ④ 的「桶质量退化检测」；
 * DEVELOPMENT-PLAN.md P2-T06 的「关键实现要点」）。
 *
 * ⚠️ ★ **P95 是「重训触发量」，不是展示量**（§6）：
 *   `stats().vectorBackend.p95BucketSize` 明确标注「**面板不展示**」
 *   ⇒ 面板展示的是 `maxBucketSize`（极值）⇒ **P95 是分位数、max 是极值**
 *   ⇒ 两者**不可互换**（「P95 是典型的桶大小」是错的说法）。
 *
 * ⚠️ ★ **刻意不落 `member_count` 列**（§9.3.2 ④）：
 *   落列就多出 3 个维护点（换桶 ±1 / 硬删 −1 / 重训批量赋值）
 *   ⇒ **漏一条就永久漂移 ⇒ 重训触发被静默焊死**
 *   ⇒ 本模块**只做聚合口径**（每次现算）⇒ 永远与行一致、**不可能漂**。
 *
 * ⚠️ **口径：含软删记忆**（软删不删桶归属，§9.3.2 ②）
 *   ⇒ 与 `clusters[].size`（**活跃**成员数）**口径不同** ⇒ 两个数**不可相减**。
 *
 * ⚠️ ★ **P95 只在启动时算一次**（§9.3.2 ④）：
 *   运行期桶退化**不会**即时触发重训 ⇒ 这是**刻意的**
 *   ⇒ 运行期重训要 1~3 分钟阻塞，不能由库自作主张（ADR-5）
 *   ⇒ 由调用方显式调 `rebuildVectorBuckets()`。
 */

import type Database from 'better-sqlite3';

import { listBucketMemberCounts } from './bucketAssign.js';

/** 桶质量的度量（§6 的 `stats().vectorBackend` 那几个量）。 */
export interface BucketQuality {
  /** **有成员**的细桶数（不在这里的桶 = 成员数 0）。 */
  fineCells: number;
  /** 桶成员总数（**含软删记忆**的归属）。 */
  members: number;
  /** 最大桶的成员数（**展示量**：直接可比 `ROUTER_BUCKET_MAX`）。 */
  maxBucketSize: number;
  /**
   * P95 桶成员数（**重训触发量**；面板**不展示**）。
   *
   * ⚠️ **口径**：细桶粒度（粗桶计数 = 其下细桶之和）。
   */
  p95BucketSize: number;
  /**
   * 是否**超过**上限（`ROUTER_BUCKET_MAX`）⇒ **建议**调用方重训。
   *
   * ⚠️ ★ **库不自动重训**（§9.3.2 ④）：
   *   重训是 1~3 分钟的阻塞操作 ⇒ 由**调用方**显式调 `rebuildVectorBuckets()`
   *   ⇒ 本模块**只给结论**，**不触发任何动作**。
   */
  degraded: boolean;
}

/**
 * 算 P95（**最近秩法**）。
 *
 * ⚠️ **为什么是「最近秩」而不是「线性插值」**：
 *   插值法会算出**一个根本不存在的桶大小**（两个桶大小之间的虚构值）
 *   ⇒ 而「P95 超过 `ROUTER_BUCKET_MAX`」这个判断的**含义**是
 *   「**真的有一个桶**超过了这个上限」⇒ 必须是**某个真实桶的大小**
 *   ⇒ 最近秩法天然满足（它取的是排序后的第 k 个**实测值**）。
 *
 * ⚠️ **定义**（最近秩 / inverse empirical CDF）：
 *   把 N 个桶大小**升序**排列 ⇒ 取第 `ceil(0.95 × N)` 个（1 起）
 *   ⇒ 即「至少有 95% 的桶不大于它」的**最小实测值**。
 *   ⇒ N = 0 ⇒ 0（库里一个成员都没有 ⇒ 没有桶 ⇒ P95 = 0）。
 *
 * @param ascending 已升序排列的桶大小
 * @returns P95（最近秩）
 */
export function percentile95(ascending: readonly number[]): number {
  if (ascending.length === 0) {
    return 0;
  }
  // ⚠️ **1 起的名次** ⇒ 下标要减一 ⇒ 别写成 `ceil(0.95 * N) - 1` 的**值**当**下标**。
  const rank = Math.ceil(0.95 * ascending.length);
  return ascending[rank - 1] ?? 0;
}

/**
 * 由「每桶成员数」算出桶质量（**纯函数**）。
 *
 * ⚠️ **纯函数**（不读库）⇒ 可以被单测直接用手算的分布验证
 *   ⇒ 也让「对账 + P95」能在**同一次扫描**上算完（对账拿行、P95 拿计数）。
 *
 * @param counts `fineId` → 成员数（**只列有成员的桶**）
 * @param maxBucketSize 上限（§5 的 `ROUTER_BUCKET_MAX`）
 * @returns 桶质量
 */
export function measureBucketQuality(
  counts: ReadonlyMap<string, number>,
  maxBucketSize: number,
): BucketQuality {
  const sizes: number[] = [];
  let members = 0;
  let max = 0;
  for (const count of counts.values()) {
    sizes.push(count);
    members += count;
    if (count > max) {
      max = count;
    }
  }
  sizes.sort((left, right) => left - right);

  const p95 = percentile95(sizes);
  return {
    fineCells: sizes.length,
    members,
    maxBucketSize: max,
    p95BucketSize: p95,
    // ⚠️ **严格大于**：等于上限不算退化（上限是「超过才触发」的口径）。
    degraded: p95 > maxBucketSize,
  };
}

/**
 * 算桶质量（**独立的一次桶侧扫描**）。
 *
 * ⚠️ **什么时候用这个**：只需要质量、不需要对账时（例如调用方只想知道「要不要重训」）。
 *   ⚠️ **与对账一起用时不要用这个** ⇒ 用 `scanBucketSide()` 的 `counts`
 *   ⇒ 那样**桶表只扫一遍**（§9.3.2 ④：「这一遍可与启动对账合并成同一次扫描」）。
 *
 * @param db 库句柄
 * @param maxBucketSize 上限（§5 的 `ROUTER_BUCKET_MAX`）
 * @returns 桶质量
 */
export function bucketQualityOf(db: Database.Database, maxBucketSize: number): BucketQuality {
  return measureBucketQuality(listBucketMemberCounts(db), maxBucketSize);
}
