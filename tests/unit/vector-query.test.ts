/**
 * ★ 查询向量**归一化口径**的守卫 —— 阶段 5 · P2-T09（设计 §3 / D2 / RK-3）。
 *
 * ⚠️ **本文件守护的是「查询向量与库内向量在同一个浮点口径上」这件事**：
 *   · 写入路径走 `normalizeNumbers(raw: number[])`（**double 域归一化、之后**才截断成 float32）；
 *   · 若查询侧误用 `normalize(v: Float32Array)`（**先**截断、**再**在 float32 域归一化）
 *     ⇒ 两边逐位不同（`src/vector/dot.ts` 的文件头：768 维样例里 **196/768** 个分量不同）
 *     ⇒ cos 的最后几位与写入路径不同源 ⇒ 排序与写入期的几何判定轻微错位，
 *     **而没有任何东西能发现**（余弦仍是合法数字）。
 *   ⇒ 所以这里的第一条断言是**逐字节**比对（不是 `toBeCloseTo`），
 *     并且配一条**负控**：换成另一个口径 ⇒ 必须逐位不同（否则断言是真空的）。
 *
 * ⚠️ **四条拒绝口径各一条断言**（Q2 的默认假设：维度不符就抛，不静默不走向量路）：
 *   维度不对 ⇒ `reason='dim'`；含 NaN / Inf ⇒ `reason='nan'`；零向量 ⇒ `reason='zero'`。
 *   ⚠️ **判据是 `details.reason` 而不是错误文案**：文案会改，`reason` 是契约
 *     （与 `dot.ts` / `assertValidEmbedding` 同一套字面量）。
 */

import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { normalize, normalizeNumbers } from '../../src/vector/dot.js';
import { normalizeQueryEmbedding } from '../../src/vector/query.js';

const DIM = DEFAULT_PARAMS.EMBED_DIM;

/**
 * 造一个**含丰富小数成分**的向量（与 `tests/unit/write.test.ts` 的 `fractionalVector()` 同一个公式）。
 *
 * ⚠️ **必须含小数**：基向量 / 全 1 向量在两种归一化口径下**逐位相同**
 *   ⇒ 那样第 5 条断言会变成**真空的**（红不起来）。
 */
function fractionalVector(dim: number): number[] {
  const vector = new Array<number>(dim);
  for (let index = 0; index < dim; index += 1) {
    vector[index] = ((index * 37) % 1000) / 1000 + 0.001;
  }
  return vector;
}

/** 断言某次调用抛出 `INVALID_INPUT` 且 `details.reason` 是给定值。 */
function expectInvalidInput(run: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, '这里必须抛错（不是静默不走向量路）').toBeInstanceOf(MemoryError);
  const error = caught as MemoryError;
  expect(error.code).toBe(MemoryError.INVALID_INPUT);
  expect(error.details.reason).toBe(reason);
}

describe('P2-T09 · `normalizeQueryEmbedding` 的拒绝口径（四条，各自一码）', () => {
  it('★ 长度 ≠ EMBED_DIM ⇒ `INVALID_INPUT` / `reason=dim`（不截断、不补零）', () => {
    const short = fractionalVector(DIM - 1);
    expectInvalidInput(() => normalizeQueryEmbedding(short, DIM), 'dim');

    // ── 负控：维度**对**的同一批数据 ⇒ 不抛错（证明上一条不是因为「任何输入都抛」）──
    expect(() => normalizeQueryEmbedding(fractionalVector(DIM), DIM)).not.toThrow();
  });

  it('★ 含 NaN ⇒ `INVALID_INPUT` / `reason=nan`', () => {
    const raw = fractionalVector(DIM);
    raw[17] = Number.NaN;
    expectInvalidInput(() => normalizeQueryEmbedding(raw, DIM), 'nan');
  });

  it('★ 含 Inf ⇒ `INVALID_INPUT` / `reason=nan`（非有限值与 NaN 同一码）', () => {
    const raw = fractionalVector(DIM);
    raw[0] = Number.POSITIVE_INFINITY;
    expectInvalidInput(() => normalizeQueryEmbedding(raw, DIM), 'nan');
  });

  it('★ 零向量 ⇒ `INVALID_INPUT` / `reason=zero`（零向量没有方向，余弦无定义）', () => {
    expectInvalidInput(() => normalizeQueryEmbedding(new Array<number>(DIM).fill(0), DIM), 'zero');
  });
});

describe('P2-T09 · `normalizeQueryEmbedding` 的归一化口径（与写入路径同源）', () => {
  it('★ 输出与写入路径 `normalizeNumbers(同一数组)` **每个 float32 分量逐位相同**（+ 逐字节相同）', () => {
    const raw = fractionalVector(DIM);
    const fromQueryPath = normalizeQueryEmbedding(raw, DIM);
    const fromWritePath = normalizeNumbers(raw);

    expect(fromQueryPath.length).toBe(DIM);
    // ── ① 逐位：`toBe` 是全等比较（不是 `toBeCloseTo`）⇒ 差一个 ULP 就红 ──
    for (let index = 0; index < DIM; index += 1) {
      expect(fromQueryPath[index]).toBe(fromWritePath[index]);
    }
    // ── ② 逐字节：BLOB 层面的同一口径（与落库比较的方式一致）──
    expect(Buffer.from(fromQueryPath.buffer)).toEqual(Buffer.from(fromWritePath.buffer));
  });

  it('★ 负控：换成 `normalize(Float32Array)`（float32 入口）⇒ **逐位不同**（证明上一条不是真空）', () => {
    const raw = fractionalVector(DIM);
    const fromQueryPath = normalizeQueryEmbedding(raw, DIM);
    // ⚠️ 另一个口径：**先**截断成 float32、**再**在 float32 域归一化
    const float32First = new Float32Array(raw);
    const fromFloat32Path = normalize(float32First);

    let differing = 0;
    for (let index = 0; index < DIM; index += 1) {
      if (fromQueryPath[index] !== fromFloat32Path[index]) {
        differing += 1;
      }
    }
    // ⚠️ 断言「**至少一个**分量不同」而不是写死 196：那个数字强依赖样例
    //   （`dot.ts` 的文件头写明了这一点）⇒ 写死它会让这条断言对未来改样例过敏。
    expect(differing).toBeGreaterThan(0);
  });

  it('★ 输出是单位向量（模长 1，误差 ≤ 1e-6）且**不改入参**', () => {
    const raw = fractionalVector(DIM);
    const snapshot = [...raw];
    const normalized = normalizeQueryEmbedding(raw, DIM);

    let sumSquares = 0;
    for (const value of normalized) {
      sumSquares += value * value;
    }
    expect(Math.abs(Math.sqrt(sumSquares) - 1)).toBeLessThanOrEqual(1e-6);
    // ⚠️ 「不改入参」是 `dot.ts` 的既有纪律：调用方的数组可能被别的代码持有
    expect(raw).toEqual(snapshot);
  });

  it('★ 已归一化的向量再走一遍 ⇒ 仍在 1e-6 以内（幂等性；不放大也不缩小）', () => {
    const once = normalizeQueryEmbedding(fractionalVector(DIM), DIM);
    const twice = normalizeQueryEmbedding([...once], DIM);
    for (let index = 0; index < DIM; index += 1) {
      expect(Math.abs((twice[index] as number) - (once[index] as number))).toBeLessThanOrEqual(
        1e-6,
      );
    }
  });
});
