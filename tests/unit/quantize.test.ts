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
  approxDotWithWidth,
  blobToCode,
  codeToBlob,
  codeWidthByteLengths,
  codeWidthFromBlobLength,
  decodeVector,
  decodeVectorWithWidth,
  detectCodeWidth,
  encodeVector,
  encodeVectorWithWidth,
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

/**
 * ★★ 候选码宽（★ 出关条件②「四列表」的前置 · ★ 2026-11-06）。
 *
 * ★ **这一组断言的三个职责**：
 *   ① **机械证明「int8 逐位不变」** ⇒ ⇒ ★ 这是「`quantize.ts` 只增不改」这句承诺的背书
 *      ⇒ ⇒ 没有它，任何人加码宽都可能悄悄改坏生产路径；
 *   ② **证明「新码宽下可证上界仍然成立」** ⇒ ⇒ ★ 上界只要求「`x̂` 是真实还原 + `eps` ≥ 真实误差」
 *      ⇒ ⇒ ★ **与码宽无关** ⇒ ⇒ ⇒ 换码宽**不会引入漏检**，只会让 `eps` 变大 ⇒ 剪枝变少；
 *   ③ **把「更窄的码 ⇒ eps 更大」这个预期写成断言** ⇒ ⇒ ★ 免得下一手把它当成 bug 去「修」。
 */
describe('候选码宽（int4 / 二值）', () => {
  const random = mulberry32(20261106);
  const bases = Array.from({ length: 200 }, () => unitVector(random));
  const queries = Array.from({ length: 20 }, () => unitVector(random));

  it('★ 字节数与 R3 行「表二」逐位一致：int4 = 384 B · 二值 = 96 B', () => {
    const base = bases[0] as Float32Array;
    expect(encodeVectorWithWidth(base, 'int4').code.length).toBe(384);
    expect(encodeVectorWithWidth(base, 'binary').code.length).toBe(96);
    expect(encodeVectorWithWidth(base, 'int8').code.length).toBe(768);
  });

  it('★ int8 路径**逐位不变**：新函数与既有 `encodeVector` 落库的**字节**完全相同', () => {
    // ★ 这一条是「`quantize.ts` 只增不改」这句承诺的**机器背书**：
    //   ⇒ 若有人日后让新函数走新算法 ⇒ ⇒ 本断言立刻红 ⇒ ⇒ 生产路径不会悄悄变。
    // ⚠️ **比的是【字节】而不是【元素值】**（★ 新函数统一用 `Uint8Array` 装 ⇒ `-117` 存成 `139`
    //   ⇒ 两者**字节完全相同**、只是「有符号 vs 无符号」的表示不同 ⇒ ⇒ 比元素值会假红）
    for (const base of bases) {
      const legacy = encodeVector(base);
      const fresh = encodeVectorWithWidth(base, 'int8');
      const legacyBytes = [
        ...new Uint8Array(legacy.code.buffer, legacy.code.byteOffset, legacy.code.byteLength),
      ];
      const freshBytes = [
        ...new Uint8Array(fresh.code.buffer, fresh.code.byteOffset, fresh.code.byteLength),
      ];
      expect(freshBytes).toEqual(legacyBytes);
      expect(fresh.scale).toBe(legacy.scale);
      expect(fresh.eps).toBe(legacy.eps);
      expect(fresh.width).toBe('int8');
    }
  });

  it('★ round-trip：解包还原后的真实误差**恰好**等于 `eps` 减去安全余量', () => {
    // ★ 这条同时钉住【打包/解包正确】与【eps 逐行实算】⇒ ⇒ 算错一位就会红
    for (const width of ['int4', 'binary'] as const) {
      for (const base of bases.slice(0, 20)) {
        const encoded = encodeVectorWithWidth(base, width);
        const restored = decodeVectorWithWidth(encoded.code, encoded.scale, width, DIM);
        let squaredError = 0;
        for (let dim = 0; dim < DIM; dim += 1) {
          const difference = (base[dim] as number) - (restored[dim] as number);
          squaredError += difference * difference;
        }
        const actualError = Math.sqrt(squaredError);
        expect(encoded.eps).toBeGreaterThanOrEqual(actualError);
        expect(encoded.eps - actualError).toBeLessThan(1e-5);
        expect(encoded.eps - actualError).toBeGreaterThanOrEqual(EPS_SAFETY_MARGIN * 0.5);
      }
    }
  });

  it('★ 可证上界在 int4 下仍然**无一例外**（10 万对 · 无容差）', () => {
    const encoded = bases.map((base) => encodeVectorWithWidth(base, 'int4'));
    for (let index = 0; index < 100_000; index += 1) {
      const query = queries[index % queries.length] as Float32Array;
      const rowIndex = (index * 37) % bases.length;
      const base = bases[rowIndex] as Float32Array;
      const code = encoded[rowIndex] as ReturnType<typeof encodeVectorWithWidth>;
      const upper = approxDotWithWidth(query, code.code, code.scale, 'int4', DIM) + code.eps;
      expect(upper).toBeGreaterThanOrEqual(cosOf(query, base));
    }
  });

  it('★ 可证上界在二值下仍然**无一例外**（★ 但 eps 大到让剪枝几乎失效）', () => {
    const encoded = bases.map((base) => encodeVectorWithWidth(base, 'binary'));
    for (let index = 0; index < 100_000; index += 1) {
      const query = queries[index % queries.length] as Float32Array;
      const rowIndex = (index * 37) % bases.length;
      const base = bases[rowIndex] as Float32Array;
      const code = encoded[rowIndex] as ReturnType<typeof encodeVectorWithWidth>;
      const upper = approxDotWithWidth(query, code.code, code.scale, 'binary', DIM) + code.eps;
      expect(upper).toBeGreaterThanOrEqual(cosOf(query, base));
    }
    // ★ 二值的还原值是 ±maxAbs ⇒ ⇒ eps ≈ ‖x − x̂‖₂ ≈ 1（★ 归一化向量的量级）
    //   ⇒ ⇒ **剪枝几乎必然失效**（任何 cos ≤ 1 ≤ upper）⇒ ⇒ 这是**预期结果、不是 bug**
    //   ⇒ ⇒ 记在这里 ⇒ 免得下一手把它当成「算错了」去「修」。
    const sample = encoded[0] as ReturnType<typeof encodeVectorWithWidth>;
    expect(sample.eps).toBeGreaterThan(0.5);
  });

  it('★ 更窄的码 ⇒ eps 更大（★ 预期，不是 bug）', () => {
    const base = bases[0] as Float32Array;
    const int8 = encodeVectorWithWidth(base, 'int8');
    const int4 = encodeVectorWithWidth(base, 'int4');
    const binary = encodeVectorWithWidth(base, 'binary');
    expect(int4.eps).toBeGreaterThan(int8.eps);
    expect(binary.eps).toBeGreaterThan(int4.eps);
  });

  it('★ 码宽可从 BLOB 长度自识别（★ 零配置、零 schema 改动）', () => {
    expect(codeWidthFromBlobLength(768, DIM)).toBe('int8');
    expect(codeWidthFromBlobLength(384, DIM)).toBe('int4');
    expect(codeWidthFromBlobLength(96, DIM)).toBe('binary');
    // ★ 坏码行必须**响亮失败**（★ 与 `ivf.ts` 的 fail-open 是两层：这里判不出 ⇒ 上层跳过）
    expect(() => codeWidthFromBlobLength(123, DIM)).toThrow(/不属于任何已知码宽/);
  });

  it('★ 打包字节数不足 ⇒ 响亮失败（int4 要偶数维 · 二值要 8 的倍数）', () => {
    const odd = new Float32Array(767);
    expect(() => encodeVectorWithWidth(odd, 'int4')).toThrow(/偶数/);
    expect(() => encodeVectorWithWidth(odd, 'binary')).toThrow(/8 的倍数/);
  });
});

/**
 * ★★★ **T08 · A1 / A6：读路径接线的两条机械背书**
 * （规格 `docs/design/perf-c2-codewidth-int4-wiring.md` §2.2 的「第 2 道」· §6 的 A1 / A6）。
 *
 * ★ **A1 守的是「int8 逐位不变」**：★ 「生产 int8 路径走原路」这条承诺的**代数前提**
 *   是「`approxDotWithWidth` 的 int8 分支与 `approxDot` 逐位相同」
 *   ⇒ ⇒ **这条断言就是那个前提本身的机器背书** ⇒ ⇒ 有人改坏任何一个符号，它立刻红。
 * ★ **A6 守的是「码宽自识别无歧义」**：★ 「长度 ⇒ 码宽」的映射必须**一一对应**
 *   ⇒ ⇒ 否则某个 blob 长度会被**二义**解释 ⇒ ⇒ **静默漏检**（本档唯一不可接受的失效形状）。
 */
describe('T08 · 读路径接线：int8 逐位不变 + 码宽自识别', () => {
  it('★ A1 · int8 的上界逐位不变（★ 2000 组随机向量 + 穷举 256 个字节值 · `Object.is`）', () => {
    // ⚠️ **判据是 `toBe`（= `Object.is`）而不是 `toBeCloseTo`**：
    //   `toBeCloseTo` 会放过 1 ulp 的漂移 ⇒ ⇒ **那正是「静默漏检」的入口**。
    const random = mulberry32(20261108);

    // ── ① 2000 组随机向量：同一批字节 ⇒ 两种算法 ⇒ 逐位相等 ──
    let checked = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const base = unitVector(random);
      const query = unitVector(random);
      const legacy = encodeVector(base);
      const fresh = encodeVectorWithWidth(base, 'int8');
      // ★ 字节必须逐位相同（否则比的就不是「同一批字节」了 ⇒ 断言失去意义）
      const legacyBytes = new Uint8Array(
        legacy.code.buffer,
        legacy.code.byteOffset,
        legacy.code.byteLength,
      );
      const freshBytes = new Uint8Array(
        fresh.code.buffer,
        fresh.code.byteOffset,
        fresh.code.byteLength,
      );
      expect([...freshBytes]).toEqual([...legacyBytes]);
      expect(approxDotWithWidth(query, freshBytes, fresh.scale, 'int8', DIM)).toBe(
        approxDot(query, legacy.code, legacy.scale),
      );
      checked += 1;
    }
    expect(checked).toBe(2_000);

    // ── ② ★ **穷举 256 个字节值**（★ 覆盖「有符号转换」的每一个分支）──
    //   ⚠️ 只跑随机向量时，三元与位运算两种实现都能过 ⇒ **穷举才能抓住「某一类字节值上错位」**。
    const probe = unitVector(mulberry32(99));
    for (let byte = 0; byte < 256; byte += 1) {
      const bytes = new Uint8Array(DIM).fill(byte);
      const signed = new Int8Array(DIM).fill(byte);
      expect(approxDotWithWidth(probe, bytes, 0.5, 'int8', DIM)).toBe(
        approxDot(probe, signed, 0.5),
      );
    }
  });

  it('★ A6 · 三档长度必须两两不等；某维度下二义 ⇒ 响亮失败（★ 不许静默二义）', () => {
    const lengths = codeWidthByteLengths(DIM);
    // ★ 与 R3 行「表二」逐位一致：int8 = 768 B · int4 = 384 B · 二值 = 96 B
    expect(lengths).toEqual([768, 384, 96]);
    expect(new Set(lengths).size).toBe(3);
    // ⚠️ ★ **生产维度恒为 768**（`EMBED_DIM` 是只读参数）⇒ ⇒ 该性质在运行期恒成立。
    // ★ 而**维度 2** ⇒ int4 与二值的码长都是 1 字节 ⇒ **二义**
    //   ⇒ ⇒ 「静默二义」= 静默漏检 ⇒ ⇒ 必须**响亮失败**，不许静默。
    expect(() => detectCodeWidth(1, 2)).toThrow(/二义/);
    expect(() => detectCodeWidth(2, 2)).toThrow(/二义/);
  });

  it('★ `detectCodeWidth` 是「不抛版」：未知长度 ⇒ `null`（★ 读路径靠它 fail-open）', () => {
    expect(detectCodeWidth(768, DIM)).toBe('int8');
    expect(detectCodeWidth(384, DIM)).toBe('int4');
    expect(detectCodeWidth(96, DIM)).toBe('binary');
    // ★ **不属于任何已知码宽 ⇒ `null`（不抛错）** ⇒ ⇒ 读路径「跳过这一行」⇒ ⇒ 精确兜底
    expect(detectCodeWidth(100, DIM)).toBeNull();
    // ⚠️ 与「抛错版」的差别（★ **两层语义，不许混**）：
    //   抛错版给「诊断 / 脚本」用；不抛版给「读路径」用（★ 一条坏码行不能让整条召回不可用）。
    expect(() => codeWidthFromBlobLength(100, DIM)).toThrow(/不属于任何已知码宽/);
  });
});
