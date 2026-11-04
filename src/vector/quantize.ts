/**
 * int8 量化 + **可证上界**（ADR-PERF-01 §8.3 · C′ 档规格 `docs/design/perf-c2-admissible-two-stage.md` §3）。
 *
 * ## 这个模块存在的唯一理由
 *
 * 「两段式」（先读 768B 的码、只对可能入选的行读 3KB 的原向量）**只有在「跳过的行可以被证明不会入选」时才不丢召回**。
 * 本模块提供那个证明所需的两个量：
 *
 * ```
 * x̂ = scale × code                              （x 的有损还原）
 * eps = ‖x − x̂‖₂                                 （★ 编码时**实算**，不是估算上界）
 * cos_true = q·x = q·x̂ + q·(x − x̂) ≤ q·x̂ + ‖q‖·‖x − x̂‖ = q·x̂ + eps     （Cauchy–Schwarz，‖q‖ = 1）
 *                                       └─────────────── 上界 ───────────────┘
 * ```
 *
 * ⇒ 只要 `upper(x) = approxDot(q, code, scale) + eps < 阈值`，这一行**必然**低于阈值 ⇒
 * **跳过它不改变结果集**（与「对整桶做全量精确点积」逐位相同）。
 *
 * ## 三条不能破的前提（破一条，上界就不再是上界）
 *
 * ① **`‖q‖ = 1`** —— 查询向量必须已 L2 归一化（`recall.ts` 的 `normalizeQueryEmbedding()` 负责）；
 * ② **`‖x‖ = 1`** —— 写入侧的向量已 L2 归一化（§4.6 步骤 2c 的存储约定）；
 * ③ **`eps` 是真误差** —— 必须逐行实算 `‖x − x̂‖₂`，**不许**用 `scale·√d/2` 那种**最坏界**：
 *    最坏界会把剪枝率压掉 2~3 倍（它的假设是「768 维的舍入误差全部同向」，现实中不会发生）。
 *
 * ⚠️ 本模块**不做归一化**（那是调用方的事，且归一化口径在 `core/embedding` 一处）——
 * 它只承诺「按你给的向量算码、算误差」，并把**前提**写在文档里。
 */

import { MemoryError } from '../core/errors.js';

/** int8 的上界（值域 `[-127, 127]`：刻意不用 `-128` —— 对称值域让「取反」不越界）。 */
export const MAX_CODE_VALUE = 127;

/**
 * `eps` 落库前额外加的安全余量。
 *
 * ⚠️ **为什么必须有**：`eps` 在编码期按一个求和顺序算出，而线上 `q·x̂` 是**另一个**求和顺序
 * ⇒ 两者的浮点舍入不同 ⇒ 极端样本上 `approx + eps` 可能比真实 `cos` **小一个 ulp** ⇒
 * 上界破一次就是**静默漏一条召回**，且几乎不可能复现。
 * ⇒ 1e-6 相对于 0.92 这个阈值是 5 个数量级的余量，对剪枝率的影响可以忽略。
 */
export const EPS_SAFETY_MARGIN = 1e-6;

/** 一条向量的编码结果（三样都要落库：`code` / `scale` / `eps`）。 */
export interface EncodedVector {
  /** 每维 1 字节的**有符号**码；长度 == 维度。 */
  readonly code: Int8Array;
  /** 还原标量：`x̂ = scale × code`（per-vector 单一标量 ⇒ 解码零成本）。 */
  readonly scale: number;
  /** ★ 编码时实算的 `‖x − x̂‖₂`（**已加** `EPS_SAFETY_MARGIN`）。 */
  readonly eps: number;
}

/**
 * 把一条（已 L2 归一化的）向量编成 int8 码 + 误差上界。
 *
 * @param vector 向量（`Float32Array`；**必须已 L2 归一化**，本函数不校验范数）
 * @returns 编码结果
 * @throws {MemoryError} `INVALID_INPUT`（空向量 / 含 NaN·Inf）
 */
export function encodeVector(vector: Float32Array): EncodedVector {
  const dim = vector.length;
  if (dim === 0) {
    throw MemoryError.invalidInput('量化需要非空向量', {
      reason: 'dim',
      expected: '>= 1',
      actual: '0',
    });
  }

  let maxAbs = 0;
  for (let index = 0; index < dim; index += 1) {
    const value = vector[index] as number;
    if (!Number.isFinite(value)) {
      throw MemoryError.invalidInput('量化需要有限值（NaN / Infinity 无法编码）', {
        reason: 'non-finite',
        expected: '有限实数',
        actual: `第 ${String(index)} 维 = ${String(value)}`,
      });
    }
    const abs = Math.abs(value);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }

  // ⚠️ **全零向量**（维度合法但没有任何能量）⇒ 不除零：`scale = 1` ⇒ `code` 全 0 ⇒ `x̂ = 0` ⇒
  //   `eps = ‖x‖ = 0` ⇒ 上界恒为 0。这不「好看」，但**安全**：上界仍是上界（0 ≥ 0）。
  const scale = maxAbs === 0 ? 1 : maxAbs / MAX_CODE_VALUE;
  const code = new Int8Array(dim);
  let squaredError = 0;
  for (let index = 0; index < dim; index += 1) {
    const value = vector[index] as number;
    const quantized = Math.max(
      -MAX_CODE_VALUE,
      Math.min(MAX_CODE_VALUE, Math.round(value / scale)),
    );
    code[index] = quantized;
    const difference = value - quantized * scale;
    squaredError += difference * difference;
  }

  return { code, scale, eps: Math.sqrt(squaredError) + EPS_SAFETY_MARGIN };
}

/**
 * 用码算近似点积 `q·x̂`。
 *
 * ⚠️ **不校验范数**（见模块头三条前提）；只校验**长度一致**与**有限值**，
 * 因为「维度对不上」在这条路上必须是**响亮失败**而不是「算出一个像分数的数」。
 *
 * @param query 查询向量（已 L2 归一化）
 * @param code 码（`encodeVector` 的产物）
 * @param scale 还原标量
 * @returns `q·x̂`（可能为负；**不钳制** —— 钳制会破坏上界的单调性）
 * @throws {MemoryError} `INVALID_INPUT`（长度不一致 / `scale` 非有限）
 */
export function approxDot(query: Float32Array, code: Int8Array, scale: number): number {
  if (query.length !== code.length) {
    throw MemoryError.invalidInput('近似点积要求查询向量与码等长', {
      reason: 'dim',
      expected: String(code.length),
      actual: String(query.length),
    });
  }
  if (!Number.isFinite(scale)) {
    throw MemoryError.invalidInput('近似点积需要有限的还原标量', {
      reason: 'scale',
      expected: '有限实数',
      actual: String(scale),
    });
  }
  let sum = 0;
  for (let index = 0; index < code.length; index += 1) {
    sum += (query[index] as number) * (code[index] as number);
  }
  return sum * scale;
}

/**
 * **可证上界** `upper = q·x̂ + eps`。
 *
 * ⚠️ `eps` 小于 0 是**不可能的输入**（编码器永远给非负）⇒ 小于 0 ⇒ 抛错，
 * 而**不是**钳到 0：钳掉就等于「悄悄把上界变紧」，那会直接破坏 §8.3 的证明。
 *
 * @param query 查询向量（已 L2 归一化）
 * @param code 码
 * @param scale 还原标量
 * @param eps 误差上界（`encodeVector` 的产物）
 * @returns `cos_true` 的上界
 * @throws {MemoryError} `INVALID_INPUT`（长度不一致 / `scale` 非有限 / `eps < 0`）
 */
export function upperBound(
  query: Float32Array,
  code: Int8Array,
  scale: number,
  eps: number,
): number {
  if (!Number.isFinite(eps) || eps < 0) {
    throw MemoryError.invalidInput('上界需要非负有限的 eps', {
      reason: 'eps',
      expected: '>= 0 的有限实数',
      actual: String(eps),
    });
  }
  return approxDot(query, code, scale) + eps;
}

/**
 * 把码还原成向量（**仅供诊断与测试**：生产路径不需要它）。
 *
 * @param code 码
 * @param scale 还原标量
 * @returns `x̂`（新数组）
 */
export function decodeVector(code: Int8Array, scale: number): Float32Array {
  const vector = new Float32Array(code.length);
  for (let index = 0; index < code.length; index += 1) {
    vector[index] = (code[index] as number) * scale;
  }
  return vector;
}

/**
 * 把 `Int8Array` 转成**可落库的 BLOB**（`Buffer` 视图，**不复制**）。
 *
 * ⚠️ 用 `Buffer.from(code.buffer, byteOffset, length)` 而不是 `Buffer.from(code)`：
 * 后者会把 `-1` 当成「元素值」去转换（得到 `[-1]` 的**十进制字符串**语义上的错），
 * 前者是**原始字节视图**。这也是「int8 落库」最容易写错的一步。
 *
 * @param code 码
 * @returns BLOB 视图
 */
export function codeToBlob(code: Int8Array): Buffer {
  return Buffer.from(code.buffer, code.byteOffset, code.byteLength);
}

/**
 * 把落库的 BLOB 还原成 `Int8Array`（**同样不复制**：BLOB 的生命周期由调用方保证）。
 *
 * @param blob BLOB（长度 == 维度）
 * @returns 码
 */
export function blobToCode(blob: Uint8Array): Int8Array {
  return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
}
