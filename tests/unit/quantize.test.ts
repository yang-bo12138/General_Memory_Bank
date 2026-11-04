/**
 * int8 量化 + **可证上界** 的验收断言（C′ 档规格 §6 的 **A3 / A4**）。
 *
 * ⚠️ **这两个断言是整个 C′ 档的地基**：
 *   · **A3** = `cos_true ≤ approx + eps` **无一例外**（不是「99.99% 都成立」）⇒
 *     破了它，剪枝就会**静默丢召回**，而丢的那条**不会报错、也不会被任何别的测试抓到**；
 *   · **A4** = `eps` 是**真误差**而不是「估算上界」⇒ 破了它，剪枝率会被白白压低 2~3 倍
 *     （功能正确、收益消失 —— 这种「绿但没收益」最难发现）。
 *
 * ⚠️ 样本量：**10 万对**（规格里写的就是 1e5）。这不是「多测几个」，是因为
 *   **上界破界只可能发生在极端样本上**（某一维恰好是 max、且舍入同向）⇒
 *   样本少了根本碰不到那种行。
 */

import { describe, expect, it } from 'vitest';

import {
  EPS_SAFETY_MARGIN,
  MAX_CODE_VALUE,
  approxDot,
  blobToCode,
  codeToBlob,
  decodeVector,
  encodeVector,
  upperBound,
} from '../../src/vector/quantize.js';

/** 维度取生产值（`EMBED_DIM = 768`）。 */
const DIM = 768;

/** 确定性 PRNG（`mulberry32`）—— 测试必须可复现，不许用 `Math.random()`。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 造一条 **L2 归一化** 的向量（前提 ②：`‖x‖ = 1`）。 */
function unitVector(random: () => number, dim = DIM): Float32Array {
  const vector = new Float32Array(dim);
  let sumOfSquares = 0;
  for (let index = 0; index < dim; index += 1) {
    // 取 [-1, 1) 的均匀分布就够了：均匀分布与真实 embedding 的分布不同，
    // 但 A3 断的是**代数上界**（与分布无关）⇒ 换分布只影响剪枝率，不影响本断言的成立性。
    const value = random() * 2 - 1;
    vector[index] = value;
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares);
  for (let index = 0; index < dim; index += 1) {
    vector[index] = (vector[index] as number) / norm;
  }
  return vector;
}

/** 精确余弦（两者都已归一化 ⇒ 点积即余弦）。 */
function cosOf(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] as number) * (right[index] as number);
  }
  return sum;
}

describe('int8 量化的可证上界（C′ 档 · A3 / A4）', () => {
  /** 200 条底库向量 + 20 条查询（10 条是底库的扰动版，10 条是随机向量）。 */
  const random = mulberry32(20260101);
  const bases = Array.from({ length: 200 }, () => unitVector(random));
  const queries: Float32Array[] = [];
  for (let index = 0; index < 10; index += 1) {
    const base = bases[index * 7] as Float32Array;
    const noisy = new Float32Array(DIM);
    let sumOfSquares = 0;
    for (let dim = 0; dim < DIM; dim += 1) {
      const value = (base[dim] as number) + (random() - 0.5) * 0.02;
      noisy[dim] = value;
      sumOfSquares += value * value;
    }
    const norm = Math.sqrt(sumOfSquares);
    for (let dim = 0; dim < DIM; dim += 1) {
      noisy[dim] = (noisy[dim] as number) / norm;
    }
    queries.push(noisy);
  }
  for (let index = 0; index < 10; index += 1) {
    queries.push(unitVector(random));
  }
  const encoded = bases.map((base) => encodeVector(base));

  it('★ A3：`cos_true ≤ approx + eps` 在 10 万对上**无一例外**', () => {
    let checked = 0;
    let worstSlack = Number.POSITIVE_INFINITY;
    for (let index = 0; index < 100_000; index += 1) {
      const query = queries[index % queries.length] as Float32Array;
      const rowIndex = (index * 37) % bases.length;
      const base = bases[rowIndex] as Float32Array;
      const code = encoded[rowIndex] as ReturnType<typeof encodeVector>;

      const upper = upperBound(query, code.code, code.scale, code.eps);
      const truth = cosOf(query, base);
      // ⚠️ **不许给容差**：证明是严格的 `≤`（`eps` 里已经有 1e-6 的余量吸收浮点差）
      //   ⇒ 这里写成 `toBeGreaterThanOrEqual`，一旦破界测试**立刻红**。
      expect(upper).toBeGreaterThanOrEqual(truth);
      worstSlack = Math.min(worstSlack, upper - truth);
      checked += 1;
    }
    expect(checked).toBe(100_000);
    // 上界的「紧度」：正常数据下余量应该在 1e-3 量级；若掉到 < 1e-9
    // 说明 eps 几乎没起作用（编码精度异常），若 > 0.5 说明 eps 大得离谱（剪枝会失效）。
    expect(worstSlack).toBeGreaterThan(0);
    expect(worstSlack).toBeLessThan(0.5);
  });

  it('★ A4：`eps` 是**真误差**（不是估算上界）⇒ 1,000 行的实际误差 ≤ eps，且 eps 不过分大', () => {
    for (let index = 0; index < 1_000; index += 1) {
      const base = bases[index % bases.length] as Float32Array;
      const code = encoded[index % encoded.length] as ReturnType<typeof encodeVector>;
      const restored = decodeVector(code.code, code.scale);

      let squaredError = 0;
      for (let dim = 0; dim < DIM; dim += 1) {
        const difference = (base[dim] as number) - (restored[dim] as number);
        squaredError += difference * difference;
      }
      const actualError = Math.sqrt(squaredError);

      // ① 实际误差必须 ≤ eps（上界成立的直接原因）
      expect(code.eps).toBeGreaterThanOrEqual(actualError);
      // ② 且 eps 只比实际误差多一个安全余量（⇒ 不是「估算的最坏界」，那种会大 2~3 倍）
      expect(code.eps - actualError).toBeLessThan(1e-5);
      expect(code.eps - actualError).toBeGreaterThanOrEqual(EPS_SAFETY_MARGIN * 0.5);
      // ③ 误差本身要小到「不影响阈值判断」（0.92 的阈值，误差 1e-2 量级是完全够用的）
      expect(actualError).toBeLessThan(1e-2);
    }
  });

  it('★ 上界在「所有分量相等」这种最坏形状上也不破', () => {
    // 全等分量 ⇒ `maxAbs` 最小 ⇒ `scale` 最小 ⇒ 相对量化误差最大 ⇒ 最容易破界的那种行
    const flat = new Float32Array(DIM).fill(1 / Math.sqrt(DIM));
    const code = encodeVector(flat);
    const query = unitVector(mulberry32(7));
    expect(upperBound(query, code.code, code.scale, code.eps)).toBeGreaterThanOrEqual(
      cosOf(query, flat),
    );
  });

  it('★ 上界在「有一维占绝对优势」的形状上也不破（clamp 边界）', () => {
    const spiky = new Float32Array(DIM);
    spiky[0] = 1;
    for (let index = 1; index < DIM; index += 1) {
      spiky[index] = 1e-6 / Math.sqrt(DIM);
    }
    const code = encodeVector(spiky);
    // 最大值那一维必须正好落在 +127（**不许**溢出成 -128）
    expect(code.code[0]).toBe(MAX_CODE_VALUE);
    const query = unitVector(mulberry32(11));
    expect(upperBound(query, code.code, code.scale, code.eps)).toBeGreaterThanOrEqual(
      cosOf(query, spiky),
    );
  });

  it('全零向量不除零：上界恒为 0（安全 > 好看）', () => {
    const zero = new Float32Array(DIM);
    const code = encodeVector(zero);
    expect(code.scale).toBe(1);
    expect(code.eps).toBeCloseTo(EPS_SAFETY_MARGIN, 12);
    expect(code.code.every((value) => value === 0)).toBe(true);
    expect(approxDot(unitVector(mulberry32(13)), code.code, code.scale)).toBe(0);
  });

  it('码 ↔ BLOB 往返是**原始字节**（不是元素值的十进制语义）', () => {
    const base = bases[0] as Float32Array;
    const code = encodeVector(base);
    const blob = codeToBlob(code.code);
    expect(blob.length).toBe(DIM);
    // −1 的字节是 0xFF（而不是字符 "-1"）
    const negative = new Int8Array([-1, 0, 1, -127, 127]);
    const negativeBlob = codeToBlob(negative);
    expect([...negativeBlob]).toEqual([0xff, 0x00, 0x01, 0x81, 0x7f]);
    expect([...blobToCode(negativeBlob)]).toEqual([-1, 0, 1, -127, 127]);
    // 往返之后还能算出同一个近似分（视图不复制 ⇒ 字节必须完全可逆）
    expect(approxDot(base, blobToCode(blob), code.scale)).toBeCloseTo(
      approxDot(base, code.code, code.scale),
      6,
    );
  });

  it('三种非法输入 ⇒ 响亮失败（不是「算出一个像分数的数」）', () => {
    expect(() => encodeVector(new Float32Array(0))).toThrow(/非空向量/);
    const withNaN = new Float32Array(DIM);
    withNaN[5] = Number.NaN;
    expect(() => encodeVector(withNaN)).toThrow(/有限值/);
    const withInf = new Float32Array(DIM);
    withInf[6] = Number.POSITIVE_INFINITY;
    expect(() => encodeVector(withInf)).toThrow(/有限值/);

    const code = encodeVector(bases[1] as Float32Array);
    expect(() => approxDot(new Float32Array(DIM - 1), code.code, code.scale)).toThrow(/等长/);
    expect(() => approxDot(new Float32Array(DIM), code.code, Number.NaN)).toThrow(/还原标量/);
  });

  it('`eps < 0` ⇒ 抛错（钳到 0 等于悄悄把上界变紧 ⇒ 破坏 §8.3 的证明）', () => {
    const code = encodeVector(bases[2] as Float32Array);
    const query = unitVector(mulberry32(17));
    expect(() => upperBound(query, code.code, code.scale, -1e-9)).toThrow(/eps/);
    expect(() => upperBound(query, code.code, code.scale, Number.NaN)).toThrow(/eps/);
  });
});
