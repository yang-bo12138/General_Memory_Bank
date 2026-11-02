/**
 * 查询向量的**归一化入口** —— 阶段 5 · P2-T09
 * （`docs/design/p5-vector-path-design.md` §3 的接口签名 + §2 的 D3 ① / RK-3）。
 *
 * ★ **本模块是「调用方给的 `queryEmbedding` → 后端要的 `Float32Array`」的唯一入口**：
 *   召回路径（`src/store/recall.ts` 步骤 2c）**只允许**通过本函数碰查询向量
 *   ⇒ 「归一化在哪儿做」这件事只有一处可改，不可能出现「文本路归一化、向量路没归一化」这种分叉。
 *
 * ⚠️⚠️ **必须走 `normalizeNumbers`（`number[]` 入口），不许走 `normalize`（`Float32Array` 入口）**：
 *   两个入口**逐位不同**（`src/vector/dot.ts` 的文件头已写明实测：768 维样例里 **196/768** 个分量不同）：
 *   · `normalizeNumbers(raw)`：在 **double 域**算模长、**之后**才截断成 float32；
 *   · `normalize(v)`：入参**已经是** float32 ⇒ 模长是「float32 值的 double 平方和」。
 *   写入路径（`src/store/write.ts:303-314`）用的是 `normalizeNumbers` ⇒ 查询向量**必须与库内向量
 *   在同一个浮点口径上**，否则「cos 的最后几位与写入路径不同源」——
 *   排序会与写入期的几何判定轻微错位，而**没有任何东西能发现**（余弦仍是合法数字）。
 *
 * ⚠️ **为什么归一化放在库里，而不是「要求宿主自己归一化」**（D 的 Q1 默认假设）：
 *   §4.15.2 的契约原话是「query 已 L2 归一化 —— 由调用方归一化，后端不代劳」，
 *   但宿主**无从知道**这件事。一次「忘了归一化」的后果是 **cos 整体偏小 ⇒ 全部低于
 *   `VECTOR_MIN_COS` ⇒ 向量路恒空**，而症状（`candidates = 0`）与「库里没有相关内容」
 *   **完全无法区分**（RK-3：看起来「跑了但没内容」）。
 *   ⇒ 代价（诚实记）：每次带向量的召回多一次 O(维度) 的归一化（768 次乘加，可忽略）。
 *   ⇒ 注意：后端**依然不代劳**（`VectorBackend` 契约不变）—— 归一化发生在**调用后端之前**，
 *     也就是「存算边界」上的那一层，而不是后端内部。
 *
 * ⚠️ **维度不符 ⇒ 抛错，不静默不走向量路**（Q2 的默认假设）：
 *   维度不同意味着两侧**不在同一个向量空间** ⇒ 算出来的 cos 是「无意义的合法数字」
 *   （与 `dot()` 的既有裁决同源：索引路径的维度错误是**接线错误**，必须炸）。
 *   ⇒ 代价（诚实记）：换了个 embedding 模型的宿主会**每次召回都失败**，
 *     而错误信息里写清了「期望维度 / 实际维度」⇒ 是可诊断的失败，不是静默劣化。
 *
 * ⚠️ **本模块不抛表名、不碰库句柄**：它是纯函数（`number[] → Float32Array`）
 *   ⇒ 与 `src/vector/dot.ts` 同一层纪律（向量层不依赖存储层）。
 */

import { MemoryError } from '../core/errors.js';
import { normalizeNumbers } from './dot.js';

/**
 * 把调用方给的查询向量归一化成后端要的形状（**已 L2 归一化**）。
 *
 * ⚠️ **返回值一定是新数组**（`normalizeNumbers` 内部新建）⇒ 调用方持有的 `number[]`
 *   之后被改动**不会**污染已经算出的查询向量（与 `dot.ts` 的「不改入参」纪律一致）。
 *
 * @param raw 查询向量原文（**未归一化**；`RecallOptions.queryEmbedding` 的原样）
 * @param dimensions 期望维度（= `params.EMBED_DIM`；**只读参数**，§6）
 * @returns 新的单位向量（`Float32Array`，与 `memories.embedding` 同口径）
 * @throws {MemoryError} code = `INVALID_INPUT`（`details.reason` = `'dim'` / `'nan'` / `'zero'`）
 */
export function normalizeQueryEmbedding(raw: readonly number[], dimensions: number): Float32Array {
  // ⚠️ **维度先判**（在 NaN / 零向量之前）：维度不对时「像不像」这个问题本身没有意义，
  //   而此时报 `'nan'` 会把调用方引向错误的方向（去查数值，而不是去查模型）。
  if (raw.length !== dimensions) {
    throw MemoryError.invalidInput(
      `queryEmbedding 的维度必须是 ${dimensions}（不截断、不补零、不静默降级）`,
      { reason: 'dim', expected: dimensions, actual: raw.length },
    );
  }
  // ⚠️ NaN / Inf / 零向量三条判定**委托给 `normalizeNumbers`**（C36：同一件事不得有两份实现）：
  //   它就是写入路径用的那一个 ⇒ 查询侧与写入侧的拒绝口径**必然一致**。
  return normalizeNumbers(raw);
}
