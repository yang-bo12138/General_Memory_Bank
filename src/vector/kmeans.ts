/**
 * 确定性 k-means —— P2-T02（DESIGN-v2.md §4.15.3 / DEVELOPMENT-PLAN.md P2-T02）。
 *
 * ⚠️ **本模块是「球面 k-means」（spherical k-means）**，不是欧氏 k-means：
 *   归一化后**余弦 = 点积**，且 §3 规定桶中心存的就是 **L2 归一化**的向量
 *   ⇒ 训练期的距离度量必须与**路由期**用的度量**完全一致**
 *   ⇒ 否则「训练出来的桶」与「运行时探针找到的桶」不是同一个几何 ⇒ 召回静默变差。
 *   ⇒ 本模块的做法：每轮更新后把中心**重新 L2 归一化**，归属判定用**点积最大**。
 *
 * ⚠️ **确定性是硬要求**（§4.15.3 原文：「随机初始化会让『同一份数据两次训练得到不同的桶』，
 *   直接破坏可复现性」）：
 *   · 初始中心 = **输入顺序的前 K 条**（调用方按 rowid 顺序取 ⇒ 初始中心确定）；
 *   · 归属平局（点积相等）⇒ 取**下标更小**的中心；
 *   · 迭代**必须设上限**（防不收敛 ⇒ 无限循环）。
 *   ⇒ 同一份数据两次训练 ⇒ **中心与归属逐条相同**。
 *
 * ⚠️ **本模块是纯算法**：不读库、不写库、不碰任何表名。
 *   ⇒ 两级训练与落库在 `src/vector/centroids.ts`；后端在 `src/vector/ivf.ts`。
 */

import { MIN_VECTOR_NORM } from './dot.js';

/** k-means 的默认最大迭代轮数（**必须有限** ⇒ 防不收敛导致无限循环）。 */
export const DEFAULT_MAX_ITERATIONS = 25;

/** k-means 的入参。 */
export interface KmeansOptions {
  /** 最大迭代轮数（**必须 ≥ 1**）。 */
  maxIterations?: number | undefined;
}

/** k-means 的结果。 */
export interface KmeansResult {
  /** 中心向量（每个**已 L2 归一化**；长度 = 实际中心数）。 */
  centers: Float32Array[];
  /** 每条输入向量归属的中心下标（与输入**同序**、同长度）。 */
  assignments: number[];
  /** 实际迭代轮数（≤ `maxIterations`）。 */
  iterations: number;
  /** 是否因「归属不再变化」而提前收敛。 */
  converged: boolean;
}

/**
 * 跑一次确定性球面 k-means。
 *
 * ⚠️ **中心数会被向量数夹住**：`k > 向量数` 时，实际中心数 = 向量数
 *   （不可能有比点还多的簇）⇒ 调用方拿到的 `centers.length` 可能小于 `k`。
 *
 * ⚠️ **空簇的处理**：某个中心在本轮**没有任何成员** ⇒ **保留它上一轮的位置**
 *   （不重新随机、不删除）——随机补位会毁掉确定性；
 *   删掉它会让中心数随轮次漂移 ⇒ 细桶 id 与中心下标的对应关系会错位。
 *   ⇒ 「成员向量的和为零」导致归一化后是零向量的情形，同样**保留上一轮的中心**
 *   （零向量没有方向 ⇒ 不能当中心用）。
 *
 * @param vectors 输入向量（**已 L2 归一化**；顺序即「确定性」的依据）
 * @param k 期望的中心数
 * @param options 选项（最大迭代轮数）
 * @returns 中心、归属、迭代轮数
 */
export function sphericalKmeans(
  vectors: readonly Float32Array[],
  k: number,
  options: KmeansOptions = {},
): KmeansResult {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`k-means 的 maxIterations 必须是 ≥ 1 的整数，收到 ${maxIterations}`);
  }
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k-means 的 k 必须是 ≥ 1 的整数，收到 ${k}`);
  }
  if (vectors.length === 0) {
    return { centers: [], assignments: [], iterations: 0, converged: true };
  }

  // ⚠️ **初始中心 = 输入顺序的前 K 条**（§4.15.3：不用随机采样）。
  const centerCount = Math.min(k, vectors.length);
  let centers: Float32Array[] = [];
  for (let index = 0; index < centerCount; index += 1) {
    const seed = vectors[index];
    if (seed === undefined) {
      throw new Error('k-means 的输入向量缺失（理论上不可达）');
    }
    centers.push(new Float32Array(seed));
  }

  let assignments: number[] = new Array<number>(vectors.length).fill(-1);
  let iterations = 0;
  let converged = false;

  for (let round = 0; round < maxIterations; round += 1) {
    iterations = round + 1;
    const nextAssignments = assignToNearest(vectors, centers);
    const changed = nextAssignments.some((value, index) => value !== assignments[index]);
    assignments = nextAssignments;

    // ⚠️ **先更新中心，再判断收敛**：否则最后一轮的归属可能对应旧中心。
    const updated = recomputeCenters(vectors, assignments, centers);

    if (!changed) {
      // ⚠️ 归属不再变化 ⇒ 已收敛（Lloyd 算法在此不动点）。
      converged = true;
      centers = updated;
      break;
    }
    centers = updated;
  }

  // ⚠️ **用最终的中心再分一次**：循环退出时 `assignments` 对应的是**上一轮**的中心。
  const finalAssignments = assignToNearest(vectors, centers);
  return { centers, assignments: finalAssignments, iterations, converged };
}

/**
 * 把每条向量分给**点积最大**的中心。
 *
 * ⚠️ **平局取下标更小的中心** ⇒ 确定性。
 */
function assignToNearest(
  vectors: readonly Float32Array[],
  centers: readonly Float32Array[],
): number[] {
  const assignments: number[] = [];
  for (const vector of vectors) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < centers.length; index += 1) {
      const center = centers[index];
      if (center === undefined) {
        continue;
      }
      const score = dotOf(vector, center);
      // ⚠️ `>` 而非 `>=` ⇒ 平局时保留**先遇到**的（下标更小的）中心。
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    assignments.push(bestIndex);
  }
  return assignments;
}

/**
 * 按归属重算中心（**簇均值 → L2 归一化**）。
 *
 * ⚠️ **空簇 / 零均值簇 ⇒ 保留上一轮的中心**（见 `sphericalKmeans` 的说明）。
 */
function recomputeCenters(
  vectors: readonly Float32Array[],
  assignments: readonly number[],
  previous: readonly Float32Array[],
): Float32Array[] {
  const dimensions = vectors[0]?.length ?? 0;
  const sums = new Float64Array(previous.length * dimensions);
  const counts = new Array<number>(previous.length).fill(0);

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];
    const centerIndex = assignments[index];
    if (vector === undefined || centerIndex === undefined || centerIndex < 0) {
      continue;
    }
    counts[centerIndex] = (counts[centerIndex] ?? 0) + 1;
    const base = centerIndex * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = vector[dimension] ?? 0;
      sums[base + dimension] = (sums[base + dimension] ?? 0) + value;
    }
  }

  const centers: Float32Array[] = [];
  for (let index = 0; index < previous.length; index += 1) {
    const count = counts[index] ?? 0;
    const fallback = previous[index];
    if (count === 0 || fallback === undefined) {
      centers.push(new Float32Array(fallback ?? new Float32Array(dimensions)));
      continue;
    }
    const base = index * dimensions;
    // ⚠️ **均值在 float64 里算，最后一步才落回 float32**：
    //   中途落 float32 会引入二次舍入 ⇒ 中心值依赖「先舍入再归一化」的顺序。
    const mean = new Float64Array(dimensions);
    let norm = 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = (sums[base + dimension] ?? 0) / count;
      mean[dimension] = value;
      norm += value * value;
    }
    const length = Math.sqrt(norm);
    if (!Number.isFinite(length) || !(length > MIN_VECTOR_NORM)) {
      // ⚠️ **零均值簇**（成员互相抵消）⇒ 零向量没有方向 ⇒ 保留上一轮的中心。
      centers.push(new Float32Array(fallback));
      continue;
    }
    const normalized = new Float32Array(dimensions);
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      normalized[dimension] = (mean[dimension] ?? 0) / length;
    }
    centers.push(normalized);
  }
  return centers;
}

/**
 * 两个**等长**向量的点积（float64 累加，索引升序）。
 *
 * ⚠️ 本模块**刻意不依赖** `src/vector/dot.ts` 的 `dot()`：
 *   那是**公开契约**（长度不等 ⇒ 抛错），而这里是算法内部的热路径
 *   （中心与向量必然等长）⇒ 自己算一遍，避免每次分配都走一遍错误检查。
 *   ⚠️ 累加顺序与 `dot()` 一致（索引升序）⇒ 两者结果**逐位相同**。
 */
function dotOf(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}
