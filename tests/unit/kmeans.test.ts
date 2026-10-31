/**
 * 确定性 k-means 的单测 —— DEVELOPMENT-PLAN.md **P2-T02** 的硬断言之一
 * （§4.15.3：「确定性初始化：按 rowid 顺序取前 K 条作为初始中心，**不用随机采样**」）。
 *
 * ★ 本文件的断言纪律（沿用阶段 0~2 的口径）：
 *   · **断言「机制」而不只是「结果」**：确定性不只是「两次跑一样」，
 *     还要钉住「初始中心 = 输入顺序的前 K 条」这条**机制**（否则换个初始化方式也可能照样确定）。
 *   · **数值用例手算可复算**：期望值写成与公式同源的闭式表达式 / 手算簇均值。
 *   · **每条硬断言配一条反例**：故意写出「会错的做法」，断言实现不会错。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_ITERATIONS, sphericalKmeans } from '../../src/vector/kmeans.js';

/** 二维单位向量（k-means **与维度无关** ⇒ 这里用 2/3 维即可手算）。 */
function axis(dimensions: number, index: number): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[index] = 1;
  return vector;
}

/** 两个向量的点积（手算用，不依赖被测模块）。 */
function dotOf(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

describe('P2-T02 · 确定性 k-means', () => {
  describe('硬断言：确定性（同一份数据两次训练 ⇒ 结果逐条相同）', () => {
    it('两次训练的归属逐条相同、中心逐位相同', () => {
      const vectors = [
        axis(3, 0),
        axis(3, 1),
        axis(3, 2),
        axis(3, 0),
        axis(3, 1),
        axis(3, 2),
        axis(3, 0),
      ];
      const first = sphericalKmeans(vectors, 3);
      const second = sphericalKmeans(vectors, 3);

      expect(second.assignments).toEqual(first.assignments);
      expect(second.centers).toHaveLength(first.centers.length);
      for (let index = 0; index < first.centers.length; index += 1) {
        // ⚠️ **逐位**（`Object.is`）：中心是 Float32Array ⇒ 逐元素比。
        expect(Array.from(second.centers[index] ?? [])).toEqual(
          Array.from(first.centers[index] ?? []),
        );
      }
      expect(second.iterations).toBe(first.iterations);
    });

    it('初始中心 = 输入顺序的前 K 条（不是随机、也不是「后 K 条」）', () => {
      // ⚠️ **手算**：初始中心 = [e0, e1] ⇒ 归属按「点积最大、平局取下标小者」判定
      //   ⇒ e0→0、e1→1、e2→0（e2 与两个中心的点积都是 0 ⇒ 平局 ⇒ 取 0）
      //   ⇒ 簇 0 = {e0, e2}、簇 1 = {e1}
      //   ⇒ 中心 0 = normalize((e0+e2)/2)、中心 1 = e1
      const vectors = [axis(3, 0), axis(3, 1), axis(3, 2)];
      const result = sphericalKmeans(vectors, 2, { maxIterations: 1 });

      expect(result.assignments).toEqual([0, 1, 0]);

      const expectedFirst = new Float32Array(3);
      expectedFirst[0] = Math.SQRT1_2;
      expectedFirst[2] = Math.SQRT1_2;
      expect(Array.from(result.centers[0] ?? [])).toEqual(Array.from(expectedFirst));
      expect(Array.from(result.centers[1] ?? [])).toEqual([0, 1, 0]);
    });

    it('归属恒等于「点积最大的中心」（训练结束后重新验证）', () => {
      const vectors = [axis(3, 0), axis(3, 1), axis(3, 2), axis(3, 0)];
      const result = sphericalKmeans(vectors, 2);
      for (let index = 0; index < vectors.length; index += 1) {
        const vector = vectors[index];
        if (vector === undefined) {
          continue;
        }
        let bestIndex = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let center = 0; center < result.centers.length; center += 1) {
          const centerVector = result.centers[center];
          if (centerVector === undefined) {
            continue;
          }
          const score = dotOf(vector, centerVector);
          if (score > bestScore) {
            bestScore = score;
            bestIndex = center;
          }
        }
        expect(result.assignments[index]).toBe(bestIndex);
      }
    });
  });

  describe('硬断言：迭代必须设上限（不收敛 ⇒ 不得无限循环）', () => {
    it('实际迭代轮数 ≤ maxIterations，且默认上限是有限的', () => {
      const vectors = [axis(3, 0), axis(3, 1), axis(3, 2)];
      const result = sphericalKmeans(vectors, 2, { maxIterations: 3 });
      expect(result.iterations).toBeLessThanOrEqual(3);
      expect(Number.isFinite(DEFAULT_MAX_ITERATIONS)).toBe(true);
    });

    it('maxIterations 非正 ⇒ 抛错（不是「当成 0 轮」静默跑）', () => {
      const vectors = [axis(3, 0)];
      expect(() => sphericalKmeans(vectors, 1, { maxIterations: 0 })).toThrowError(/maxIterations/);
    });
  });

  describe('边界：空簇 / 零均值簇 / 中心数被向量数夹住', () => {
    it('重复向量 ⇒ 出现空簇，但中心数不减、不抛错（不随机补位 ⇒ 保持确定性）', () => {
      const vectors = [axis(3, 0), axis(3, 0), axis(3, 0)];
      const result = sphericalKmeans(vectors, 3);
      expect(result.centers).toHaveLength(3);
      expect(result.assignments).toHaveLength(3);
      // ⚠️ 空簇的中心保留它原来的位置（这里三个初始中心都是 e0）。
      for (const center of result.centers) {
        expect(Array.from(center)).toEqual([1, 0, 0]);
      }
    });

    it('零均值簇（成员互相抵消）⇒ 保留上一轮的中心（零向量没有方向）', () => {
      const vectors = [axis(3, 0), axis(3, 0).map((value) => -value)];
      const result = sphericalKmeans(vectors, 1);
      expect(result.centers).toHaveLength(1);
      // ⚠️ 簇均值是零向量 ⇒ 中心必须**保留** e0，而不是变成 NaN。
      expect(Array.from(result.centers[0] ?? [])).toEqual([1, 0, 0]);
    });

    it('k > 向量数 ⇒ 实际中心数 = 向量数（不可能有比点还多的簇）', () => {
      const vectors = [axis(3, 0), axis(3, 1)];
      const result = sphericalKmeans(vectors, 10);
      expect(result.centers).toHaveLength(2);
      expect(result.assignments).toHaveLength(2);
    });

    it('空输入 ⇒ 空结果（不抛错）', () => {
      const result = sphericalKmeans([], 5);
      expect(result.centers).toHaveLength(0);
      expect(result.assignments).toHaveLength(0);
    });
  });
});
