/**
 * Float32 点积与 L2 归一化工具 —— P2-T01（DESIGN-v2.md §4.15.2 / §4.6 步骤 2c）。
 *
 * ⚠️ **本模块只做「算」与「验」，不做「改」**：
 *   · `normalize()` **返回新数组**，绝不改入参（调用方的向量可能被别的代码持有）。
 *   · 归一化后的向量**余弦 = 点积**，省一次除法，且杜绝「长向量占优」
 *     （§3 `memories.embedding` 列的语义：存的就是归一化后的向量）。
 *   · **不截断、不补零、不静默降级**：不合法的向量一律**抛错**
 *     （§4.9 步骤 2 的写入口径）——静默降级会让库里出现「维度对、值全错」的向量，
 *     而库里**没有任何东西**能发现它（余弦看起来仍是合法数字）。
 *
 * ⚠️ **与 `src/store/write.ts:86` 的 `MIN_VECTOR_NORM` 是同一个阈值的两处声明**：
 *   写入路径（`store/write.ts`）与本模块（向量层）都要拒绝「模长 ≤ 1e-8」的向量。
 *   ⚠️ 两处**必须同步**——一处放宽、一处不放宽 ⇒ 同一批向量在两条路径上的判定不一致。
 *   ⇒ 本模块导出该常量，供写入路径**改为引用本处**（单一真相）时直接取用。
 *   ⇒ 在那之前，改这里的值必须同时改 `src/store/write.ts`（当前无法在 P2-T01 内收敛，
 *     因为 `src/store/` 不在 P2-T01 的文件域内 —— 已上报主理人）。
 *
 * ⚠️ **本模块不依赖任何表 / 任何库句柄**：
 *   ⇒ 向量层与存储层解耦（候选来源由调用方注入，见 `src/vector/flat.ts`）。
 */

import { MemoryError } from '../core/errors.js';

/**
 * 向量模长的下界（**小于等于它即视为零向量**）。
 *
 * ⚠️ **零向量没有方向**：余弦无定义 ⇒ 必须拒绝，而不是当成「与谁都无关」。
 *   与 `src/store/write.ts` 的同名阈值同口径（见文件头注释）。
 */
export const MIN_VECTOR_NORM = 1e-8;

/**
 * 两个向量的点积（**float64 累加**，按索引升序）。
 *
 * ⚠️ **长度不等 ⇒ 抛错**（不静默取短的那个）：
 *   维度不同意味着两侧**不在同一个 embedding 空间** ⇒ 点积没有意义；
 *   静默取短的那个会算出一个「看起来正常」的数，而**没有任何东西能发现它**。
 *   （对照 `src/store/write.ts` 的 `cosineOf`：那条路径返回 `null`，本路径抛错——
 *   差别在于**那里是打分路径、这里是索引路径**，索引路径的维度错误是**接线错误**，必须炸。）
 *
 * ⚠️ **累加顺序固定为索引升序** ⇒ 同一对向量永远得到**逐位相同**的结果
 *   （浮点加法不满足结合律 ⇒ 换顺序会得到不同的最后一位）。
 *   ⇒ 这是「与手写参考实现逐位一致」这条断言（§4.15.2 验收标准）能成立的前提。
 *
 * @param a 左向量
 * @param b 右向量
 * @returns 点积
 * @throws {MemoryError} code = `INVALID_INPUT`（`details.reason` = `'dim'`）
 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw MemoryError.invalidInput('向量维度不一致（点积无意义）', {
      reason: 'dim',
      expected: a.length,
      actual: b.length,
    });
  }

  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) {
      // ⚠️ 理论上不可达（上面已校验两者等长）——但仍必须给一个**有类型**的错误，
      //   而不让 `undefined` 变成 `NaN` 静默流进排序里。
      throw MemoryError.invalidInput('向量的长度与维度不符', {
        reason: 'dim',
        expected: a.length,
        actual: index,
      });
    }
    sum += left * right;
  }
  return sum;
}

/**
 * 向量的 L2 模长（**float64** 计算）。
 *
 * ⚠️ **不抛错**：本函数只做「量」——非有限输入会让它返回 `Infinity` / `NaN`，
 *   由调用方（`normalize` / `assertValidEmbedding`）决定如何处置。
 *   ⇒ 「测量」与「校验」分家，避免同一个语义有两套判断。
 *
 * @param v 向量
 * @returns 模长（非负）
 */
export function l2Norm(v: Float32Array): number {
  let sumSquares = 0;
  for (let index = 0; index < v.length; index += 1) {
    const value = v[index];
    if (value === undefined) {
      // ⚠️ 理论上不可达（TypedArray 长度精确）——但仍不许 `?? 0` 静默补零。
      throw MemoryError.invalidInput('向量的长度与维度不符', {
        reason: 'dim',
        expected: v.length,
        actual: index,
      });
    }
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares);
}

/**
 * 把向量归一化到单位长度（**返回新数组，不改入参**）。
 *
 * ⚠️ **非法向量一律抛错**（不截断、不补零、不静默降级）：
 *   · 含 NaN / Inf ⇒ 抛 `INVALID_INPUT`（`details.reason` = `'nan'`）；
 *   · 模长溢出成 `Infinity` ⇒ 同样按「非有限」拒绝（有限但极大的分量相加会溢出，
 *     归一化后全变 0 —— 一个零向量，与真正的 NaN 一样不可用）；
 *   · 模长 ≤ `MIN_VECTOR_NORM` ⇒ 抛 `INVALID_INPUT`（`details.reason` = `'zero'`）。
 *
 * @param v 待归一化的向量
 * @returns 新的单位向量
 * @throws {MemoryError} code = `INVALID_INPUT`（`details.reason` = `'nan'` / `'zero'`）
 */
export function normalize(v: Float32Array): Float32Array {
  for (let index = 0; index < v.length; index += 1) {
    const value = v[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw MemoryError.invalidInput('向量含 NaN / Inf（拒绝而非降级）', {
        reason: 'nan',
      });
    }
  }

  const norm = l2Norm(v);
  if (!Number.isFinite(norm)) {
    throw MemoryError.invalidInput('向量的模长溢出为无穷（分量过大）', {
      reason: 'nan',
    });
  }
  if (!(norm > MIN_VECTOR_NORM)) {
    throw MemoryError.invalidInput('向量的模长为 0（零向量没有方向）', {
      reason: 'zero',
    });
  }

  const normalized = new Float32Array(v.length);
  for (let index = 0; index < v.length; index += 1) {
    const value = v[index];
    if (value === undefined) {
      throw MemoryError.invalidInput('向量的长度与维度不符', {
        reason: 'dim',
        expected: v.length,
        actual: index,
      });
    }
    normalized[index] = value / norm;
  }
  return normalized;
}

/**
 * 校验一个向量是否可以作为**向量索引的输入**（写入口径，§4.9 步骤 2）。
 *
 * ⚠️ **三条校验一个都不能放宽**（计划稿明写）：
 *   ① 维度 == 期望维度（`EMBED_DIM`；`EMBED_DIM` 本身**只读**，§6）；
 *   ② 无 NaN / Inf；
 *   ③ 模长 > `MIN_VECTOR_NORM`。
 *   ⇒ **不截断、不补零、不静默降级** —— 不满足就抛错。
 *
 * ⚠️ **本函数只验，不改**：向量是否**已 L2 归一化**由调用方保证
 *   （§3 的 `memories.embedding` 存的就是归一化后的向量）——
 *   本函数**不代为归一化**（代劳会掩盖调用方的 bug，也会让「后端不做任何再归一化」
 *   这条边界失守）。
 *
 * @param v 待校验的向量
 * @param dimensions 期望的维度
 * @throws {MemoryError} code = `INVALID_INPUT`（`details.reason` = `'dim'` / `'nan'` / `'zero'`）
 */
export function assertValidEmbedding(v: Float32Array, dimensions: number): void {
  if (v.length !== dimensions) {
    throw MemoryError.invalidInput(`向量的维度必须是 ${dimensions}（不截断、不补零、不静默降级）`, {
      reason: 'dim',
      expected: dimensions,
      actual: v.length,
    });
  }

  for (let index = 0; index < v.length; index += 1) {
    const value = v[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw MemoryError.invalidInput('向量含 NaN / Inf（拒绝而非降级）', {
        reason: 'nan',
      });
    }
  }

  const norm = l2Norm(v);
  if (!Number.isFinite(norm)) {
    throw MemoryError.invalidInput('向量的模长溢出为无穷（分量过大）', {
      reason: 'nan',
    });
  }
  if (!(norm > MIN_VECTOR_NORM)) {
    throw MemoryError.invalidInput('向量的模长为 0（零向量没有方向）', {
      reason: 'zero',
    });
  }
}
