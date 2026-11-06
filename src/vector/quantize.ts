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

// ═══════════════════════════════════════════════════════════════════════════
// ★★ 候选码宽（★ 2026-11-06 · 出关条件②「四列表」的前置 · ★ 阶段 1）
//   ★ **本段全部是【新增导出】** ⇒ ⇒ **上面那些既有导出一个字节都没改**
//     ⇒ ⇒ ★ **生产路径（int8）行为逐位不变**（★ 由既有 1984 个用例背书）
//   ★ 目标：让**离线重编码**能产出 int4 / 二值两档的码 ⇒ ⇒ 从而拿到它们的
//     **ε 分布**（★ ε 是码表实算 ⇒ ⇒ **只重编码、不重采**就能填掉四列表的一整列）
//   ★ ★ **口径（★ 与 `docs/design/perf-c2-admissible-two-stage.md` 的 R3 行「表二」一致）**：
//     · **int4** = 对称量化 · 值域 `[-7, 7]`（★ 刻意不用 `-8` ⇒ 对称）· 每维 4 bit
//       ⇒ **384 B/行**（768 维）⇒ ⇒ 与表二的「384 B」逐位一致
//     · **二值** = 每维 1 bit（★ sign(x)）⇒ **96 B/行**（768 维）⇒ ⇒ 与表二的「96 B」一致
//   ★ ★ **安全前提（本段存在的全部理由）**：**ε 仍是逐行实算的 `‖x − x̂‖₂`**
//     ⇒ ⇒ ★ **可证上界不依赖码宽**（★ §8.3 的证明只要求 `x̂` 是真实还原、`eps` ≥ 真实误差）
//     ⇒ ⇒ ★ **换码宽只会让 `eps` 变大 ⇒ 剪枝更少 ⇒ 【不漏检、只是更慢】** ⇒ ⇒ ★ 安全
//   ⚠️ **本段【不接线读路径】**（★ 阶段 1 的边界）：★ `src/vector/ivf.ts:580` 现在写的是
//     `row.code.byteLength !== dimensions ⇒ continue`（★ fail-open）⇒ ⇒ **非 1 字节/维的码行
//     会被当成「坏维度」跳过** ⇒ ⇒ ★ **所以新码宽的库【当前不能跑召回/剪枝测试】**
//     ⇒ ⇒ ★ **阶段 1 的产物只用于测 ε**（★ 阶段 2 才把读路径接上）
// ═══════════════════════════════════════════════════════════════════════════

/** 候选码宽。★ `int8` 是生产现状；`int4` / `binary` 是出关条件② 的候选档。 */
export type CodeWidth = 'int8' | 'int4' | 'binary';

/** 全部候选码宽（★ 顺序 = 由宽到窄 ⇒ ★ 便于「取最宽的合法档」这类比较）。 */
export const CODE_WIDTHS: readonly CodeWidth[] = ['int8', 'int4', 'binary'];

/**
 * 每维占用的**字节数**（★ 二值是 1/8 字节 ⇒ ★ 用分数表示、避免浮点陷阱：
 * ★ 打包时一律用 `dim × bits / 8` 的整数运算）。
 */
export const CODE_BITS_PER_DIM: Record<CodeWidth, number> = {
  int8: 8,
  int4: 4,
  binary: 1,
};

/**
 * int4 的值域上界（★ 对称：`[-7, 7]` —— 刻意不用 `-8` ⇒ ⇒ 「取反」不越界）。
 * ★ 打包用 4 bit **补码** ⇒ ⇒ 值域正好是 `[-8, 7]` ⇒ ⇒ 取 `[-7, 7]` ⇒ 永不触及 `-8`。
 */
export const MAX_INT4_VALUE = 7;

/** 一条向量的编码结果（★ 候选码宽版：★ `code` 的类型随宽度变 ⇒ ★ 打包后统一是 `Uint8Array`）。 */
export interface EncodedVectorWidth {
  /** 打包后的码（★ int8 = 每维 1 B；int4 = 每 2 维 1 B；二值 = 每 8 维 1 B）。 */
  readonly code: Uint8Array;
  /** 还原标量：`x̂ = scale × code`（★ 二值档是 `x̂ = ±scale`）。 */
  readonly scale: number;
  /** ★ 编码时实算的 `‖x − x̂‖₂`（★ **已加** `EPS_SAFETY_MARGIN`）。 */
  readonly eps: number;
  /** 这一档的码宽（★ 随码一起落库 ⇒ ⇒ 解码端不需要猜）。 */
  readonly width: CodeWidth;
}

/**
 * 把一条（已 L2 归一化的）向量编成**指定码宽**的码 + 误差上界。
 *
 * ⚠️ **与 `encodeVector` 的关系**：`encodeVector` = `encodeVectorWithWidth(v, 'int8')`
 *   （★ 但**函数体不共用** ⇒ ⇒ ★ int8 路径**逐位不变** ⇒ ⇒ ★ 由既有用例背书）
 *
 * @param vector 向量（`Float32Array`；**必须已 L2 归一化**，本函数不校验范数）
 * @param width 码宽
 * @returns 编码结果
 * @throws {MemoryError} `INVALID_INPUT`（空向量 / 含 NaN·Inf）
 */
export function encodeVectorWithWidth(vector: Float32Array, width: CodeWidth): EncodedVectorWidth {
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

  // ⚠️ **全零向量** ⇒ 不除零（同 `encodeVector` 的处置 ⇒ ★ 上界仍是上界）
  if (width === 'int8') {
    const scale = maxAbs === 0 ? 1 : maxAbs / MAX_CODE_VALUE;
    const code = new Uint8Array(dim);
    let squaredError = 0;
    for (let index = 0; index < dim; index += 1) {
      const value = vector[index] as number;
      const quantized = Math.max(
        -MAX_CODE_VALUE,
        Math.min(MAX_CODE_VALUE, Math.round(value / scale)),
      );
      code[index] = quantized & 0xff;
      const difference = value - quantized * scale;
      squaredError += difference * difference;
    }
    return { code, scale, eps: Math.sqrt(squaredError) + EPS_SAFETY_MARGIN, width };
  }

  if (width === 'int4') {
    // ★ 对称量化：值域 [-7, 7] ⇒ scale = maxAbs / 7
    const scale = maxAbs === 0 ? 1 : maxAbs / MAX_INT4_VALUE;
    if (dim % 2 !== 0) {
      throw MemoryError.invalidInput('int4 码宽要求维度是偶数（★ 两维打包 1 字节）', {
        reason: 'dim',
        expected: '偶数',
        actual: String(dim),
      });
    }
    const code = new Uint8Array(dim / 2);
    let squaredError = 0;
    for (let index = 0; index < dim; index += 1) {
      const value = vector[index] as number;
      const quantized = Math.max(
        -MAX_INT4_VALUE,
        Math.min(MAX_INT4_VALUE, Math.round(value / scale)),
      );
      // ★ 4 bit 补码打包：低 4 位 = 偶数维、高 4 位 = 奇数维
      const nibble = quantized & 0x0f;
      const byteIndex = Math.floor(index / 2);
      const current = code[byteIndex] as number;
      code[byteIndex] = index % 2 === 0 ? current | nibble : current | (nibble * 16);
      const difference = value - quantized * scale;
      squaredError += difference * difference;
    }
    return { code, scale, eps: Math.sqrt(squaredError) + EPS_SAFETY_MARGIN, width };
  }

  // ★ 二值：每维 1 bit（sign）⇒ scale = maxAbs（★ 还原值是 ±maxAbs）
  //   ⚠️ 与 int4 的 scale 口径**不同**（★ int4 是 maxAbs/7 ⇒ 二值是 maxAbs/1）
  //   ⇒ ⇒ ★ **二值的 ε 必然显著更大**（★ 这是预期结果、不是 bug）
  if (dim % 8 !== 0) {
    throw MemoryError.invalidInput('二值码宽要求维度是 8 的倍数（★ 八维打包 1 字节）', {
      reason: 'dim',
      expected: '8 的倍数',
      actual: String(dim),
    });
  }
  const scale = maxAbs === 0 ? 1 : maxAbs;
  const code = new Uint8Array(dim / 8);
  let squaredError = 0;
  for (let index = 0; index < dim; index += 1) {
    const value = vector[index] as number;
    // ★ bit = 1 ⇒ +scale；bit = 0 ⇒ −scale（★ `value >= 0` ⇒ 0 归到正侧）
    const bit = value >= 0 ? 1 : 0;
    const byteIndex = Math.floor(index / 8);
    const current = code[byteIndex] as number;
    code[byteIndex] = current | (bit * 2 ** (index % 8));
    const reconstructed = bit === 1 ? scale : -scale;
    const difference = value - reconstructed;
    squaredError += difference * difference;
  }
  return { code, scale, eps: Math.sqrt(squaredError) + EPS_SAFETY_MARGIN, width };
}

/**
 * 解包一个 4 bit 码字（★ 补码：`-8..7` ⇒ ★ 值域取 `[-7, 7]` ⇒ `-8` 永不出现）。
 */
function unpackInt4(nibble: number): number {
  return nibble > MAX_INT4_VALUE ? nibble - 16 : nibble;
}

/**
 * 把一个字节读成**有符号** int8（★ 不用移位 —— ★ biome 禁位运算 ⇒ ★ 用数值判断）。
 */
function toSignedInt8(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}

/**
 * 按码宽解包成**每维一个数**的还原值（★ 供近似点积与诊断解码共用）。
 *
 * @param code 打包后的码
 * @param width 码宽
 * @param dim 维度
 * @returns 每维的码值（★ int4 是有符号；★ 二值是 `±1`）
 */
export function unpackCode(
  code: Uint8Array,
  width: CodeWidth,
  dim: number,
): Int8Array | Float32Array {
  if (width === 'int8') {
    const out = new Int8Array(dim);
    for (let index = 0; index < dim; index += 1) {
      out[index] = toSignedInt8(code[index] as number); // ★ 有符号还原
    }
    return out;
  }
  if (width === 'int4') {
    const out = new Int8Array(dim);
    for (let index = 0; index < dim; index += 1) {
      const byte = code[Math.floor(index / 2)] as number;
      const nibble = index % 2 === 0 ? byte % 16 : Math.floor(byte / 16) % 16;
      out[index] = unpackInt4(nibble);
    }
    return out;
  }
  const out = new Float32Array(dim);
  for (let index = 0; index < dim; index += 1) {
    const byte = code[Math.floor(index / 8)] as number;
    const bit = Math.floor(byte / 2 ** (index % 8)) % 2;
    out[index] = bit === 1 ? 1 : -1;
  }
  return out;
}

/**
 * 用**指定码宽**的码算近似点积 `q·x̂`。
 *
 * ⚠️ **与 `approxDot` 的关系**：int8 走**同一套算法**（★ 但本函数**不复用** `approxDot`
 *   ⇒ ⇒ ★ int8 的行为逐位不变 ⇒ ⇒ ★ 由既有用例背书）
 *
 * @param query 查询向量（已 L2 归一化）
 * @param code 打包后的码
 * @param scale 还原标量
 * @param width 码宽
 * @param dim 维度
 * @returns `q·x̂`（可能为负；**不钳制**）
 * @throws {MemoryError} `INVALID_INPUT`（长度不一致 / `scale` 非有限）
 */
export function approxDotWithWidth(
  query: Float32Array,
  code: Uint8Array,
  scale: number,
  width: CodeWidth,
  dim: number,
): number {
  if (query.length !== dim) {
    throw MemoryError.invalidInput('近似点积要求查询向量与码等长', {
      reason: 'dim',
      expected: String(dim),
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
  if (width === 'int8') {
    for (let index = 0; index < dim; index += 1) {
      sum += (query[index] as number) * toSignedInt8(code[index] as number);
    }
    return sum * scale;
  }
  if (width === 'int4') {
    for (let index = 0; index < dim; index += 1) {
      const byte = code[Math.floor(index / 2)] as number;
      const nibble = index % 2 === 0 ? byte % 16 : Math.floor(byte / 16) % 16;
      sum += (query[index] as number) * unpackInt4(nibble);
    }
    return sum * scale;
  }
  for (let index = 0; index < dim; index += 1) {
    const byte = code[Math.floor(index / 8)] as number;
    const bit = Math.floor(byte / 2 ** (index % 8)) % 2;
    sum += (query[index] as number) * (bit === 1 ? 1 : -1);
  }
  return sum * scale;
}

/**
 * 把**指定码宽**的码还原成向量（★ 仅供诊断与测试）。
 */
export function decodeVectorWithWidth(
  code: Uint8Array,
  scale: number,
  width: CodeWidth,
  dim: number,
): Float32Array {
  const unpacked = unpackCode(code, width, dim);
  const vector = new Float32Array(dim);
  for (let index = 0; index < dim; index += 1) {
    vector[index] = (unpacked[index] as number) * scale;
  }
  return vector;
}

/**
 * 把打包后的码转成**可落库的 BLOB**（★ `Buffer` 视图，**不复制**）。
 *
 * @param code 打包后的码
 * @returns BLOB 视图
 */
export function codeToBlobWithWidth(code: Uint8Array): Buffer {
  return Buffer.from(code.buffer, code.byteOffset, code.byteLength);
}

/**
 * 从 BLOB 长度**反推**码宽（★ 「长度自识别」⇒ ⇒ **零配置、零 schema 改动**）。
 *
 * ⚠️ **为什么可以靠长度**：★ 768 维 ⇒ int8 = **768 B** · int4 = **384 B** · 二值 = **96 B**
 *   ⇒ ⇒ 三个长度**互不相同** ⇒ ⇒ **无歧义**（★ 且 `EMBED_DIM` 是**只读参数** ⇒ 运行期不变）
 * ⚠️ **前提**：维度必须是 8 的倍数（★ 二值打包要求）⇒ ⇒ 三个长度仍然互不相同
 *
 * @param blobLength BLOB 字节数
 * @param dim 维度
 * @returns 码宽
 * @throws {MemoryError} `INVALID_INPUT`（长度不属于任何合法档）
 */
export function codeWidthFromBlobLength(blobLength: number, dim: number): CodeWidth {
  for (const width of CODE_WIDTHS) {
    if (blobLength === Math.ceil((dim * CODE_BITS_PER_DIM[width]) / 8)) {
      return width;
    }
  }
  throw MemoryError.invalidInput('码 BLOB 长度不属于任何已知码宽（★ 坏码行）', {
    reason: 'blobLength',
    expected: CODE_WIDTHS.map(
      (width) => `${width}=${String(Math.ceil((dim * CODE_BITS_PER_DIM[width]) / 8))}`,
    ).join(' / '),
    actual: String(blobLength),
  });
}
