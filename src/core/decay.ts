/**
 * 衰减 / 强度 / 层级 / 边权 / 归档时刻 —— DESIGN-v2.md §4.1 / §4.4 / §4.5 / §9.4.1 的**纯函数**实现。
 *
 * ★ 本文件**全是纯函数**：不碰数据库、不写任何状态、不读真实时钟。
 *   ⇒ 写入路径（§4.9）与召回路径（§4.6）共用同一套公式，
 *     避免「两条路径各写各的公式」的漂移（§4.2 把 `growStability` 收成唯一写入点是同一条纪律）。
 *
 * ⚠️ **量纲口径（§4.1）**：`effectiveStability` 是负指数衰减的**时间常数 τ**，**不是半衰期**。
 *   `intensity = exp(-t/τ)` 在 `t = τ` 时衰减到 `1/e ≈ 36.8%`；
 *   **真正的半衰期 = τ × ln2 ≈ 0.693τ**。
 *   ⇒ 凡用到「半衰期」必同时给出换算，不允许混用——
 *     把 τ 当半衰期用会让衰减速率差 **1.44 倍**（`exp(-1)=0.368` 对 `0.5`），
 *     且不报错、只是「记忆保鲜时长看起来不太对」。
 *
 * ⚠️ **`intensity` 的两重防护**：① `Δt = max(0, now - last_access)`（防时钟回拨 / 注入过去时刻）；
 *   ② 结果再 `min(1, ...)`（防 `τ → 0` 等极端输入）。
 *
 * ⚠️⚠️ **v2.1 勘误（ADR-P1-T07-DEC §12.1）：「缺一不可」这个说法**不准确**——它在**生产域不成立**：
 *   · **`τ ≥ 0` 域**（生产域，`stability ≥ 0`）：两道钳制**互为冗余**
 *     ⇒ ① 在前 ⇒ `exp(-Δt/τ) ≤ 1` ⇒ ② 恒为无操作；
 *     ⇒ ② 在前 ⇒ `Δt < 0` 时 `exp(-Δt/τ) > 1` ⇒ ② 拉回 1，与 ① 把 `Δt` 归零**逐位相同**
 *     ⇒ **任一道单独存在都足以保证 `intensity ≤ 1`** ⇒ 删掉任一道，**行为一模一样**
 *     （实测 77 组 `(Δt, τ)` 网格 ⇒ 0 处差异）。
 *   · **`τ < 0` 域**（`stability` 为负的**越界输入**）：**「缺一不可」成立**
 *     ⇒ `exp(-Δt/τ) > 1` ⇒ **`min(1, …)` 是唯一拦住越界的那道**
 *     （`max(0, Δt)` 归零的是 `Δt`、不是 `τ` ⇒ 拦不住）
 *     ⇒ 实测 `Δt=1, τ=-1` ⇒ 完整实现得 `1`、删掉 `min` 得 `2.718…`；`Δt=1e6, τ=-1` ⇒ 删掉 `min` 得 `Infinity`。
 *
 * ⇒ **所以两道都留是「防御性 + 可读性」的选择，不是生产域的正确性依赖**
 *   ⇒ **不要把「两道都必须存在」写成正确性论证**；
 *   但在**越界输入域** `min(1, …)` 是**承重的** ⇒ 它不能被删
 *   ⇒ 这正是 F-08 ② 的**负 τ 探针**（`τ < 0` 且 `Δt > 0`）能抓住「漏掉 `min`」的原因。
 *
 * ⚠️ **`scripts/check-clamp.ts` 是「形状守卫」不是「行为保证」**：
 *   它钉住源码写法（等价改写会绕过它），且按上面的冗余性，它在**生产域守不住任何行为**
 *   ⇒ 真正守住 `intensity ∈ [0,1]` 的是**行为断言**（值域 / `Δt<0 ⇒ 1` / `Δt=0 ⇒ 1` / 单调不增 / 下溢）
 *   ⇒ 静态扫描与行为断言**并存**（一个挡误改，一个挡行为回归），**不互相替代**。
 *
 * ⇒ §4.6 步骤 2 的召回 SQL **必须照抄这两重钳制**（同一条理由）。
 *
 * ⚠️ **C37 时钟注入**：`intensity` / `edgeWeight` 的签名含 `now?`，
 *   缺省时经 `resolveNow()` 取真实时钟（唯一入口是 `src/core/clock.ts`）。
 *   本文件**不得**出现 `Date.now()` / `new Date()` ⇒ 否则 C37 扫描会判为未获准的时钟读取。
 *
 * ⚠️ **前置条件**：`stability > 0` 且 `pin_factor ≥ 1.0`（§4.1 的校验规则保证）。
 *   `effectiveStability == 0` 会让除零退化（`Δt = 0` 时得 `NaN`）——
 *   这里**刻意不**偷偷加一个 ε 兜底：那会让「公式」与「实现」不再是同一个东西，
 *   而这类兜底掩盖的正是「有人传了 0 进来」这个真问题。
 */

import { MS_PER_DAY } from '../util/time.js';
import { resolveNow } from './clock.js';
import type { Params } from './params.js';

/**
 * 一天的毫秒数 —— **re-export**（**定义**在 `src/util/time.ts`）。
 *
 * ⚠️ **为什么保留这个 re-export**（而不是直接删掉这个导出）：
 *   既有代码从 `./decay.js` 导入它的地方有**一串**——
 *   `src/index.ts`（门面线，已交付）、`src/core/scoring.ts`（recall 线，正在改）、
 *   `src/core/stability.ts`，以及多个测试文件。
 *   若直接删掉，这些 import 会**同时断掉** ⇒ 而它们分属**两条正在并行改动的线**
 *   ⇒ 三方串行会让主线在中间态**编译不过**。
 *   ⇒ 本次只做「**定义下沉、导出保留**」。
 *
 * ⚠️ **re-export 不是第二份定义** ⇒ 不会漂移（C36 禁的是「同一个键名两处两套语义」，
 *   不是禁别名）：`MS_PER_DAY` 的**唯一定义**在 `src/util/time.ts`，
 *   此处只是别名，值恒等于那一份。
 *   ⇒ 待办：下一次统一收敛时，把这些 import 路径改成直接指向 `src/util/time.js`
 *     （避免三方串行打断主线，故本次刻意不做）。
 */
export { MS_PER_DAY };

/**
 * 强度衰减所需的记忆字段（§4.1）。
 *
 * ⚠️ **刻意只声明用到的三个字段**（结构化 / 鸭子类型）：
 *   阶段 1 的 `memories` 行、召回路径的投影、测试里的手算输入都能直接传进来，
 *   不必为了调一个纯函数先构造一整行。
 */
export interface DecayMemoryInput {
  /** 稳定度（天，时间常数 τ 的基数）。 */
  stability: number;
  /** 强调系数（`[1.0, MAX_PIN_FACTOR]`，默认 1.0）。 */
  pin_factor: number;
  /** 最近一次访问时刻（epoch 毫秒）。 */
  last_access: number;
}

/** 边权重衰减所需的边字段（§4.5）。 */
export interface DecayEdgeInput {
  /** 边的权重（写入侧已被 `MAX_EDGE_WEIGHT` 封顶）。 */
  weight: number;
  /** 最近一次活跃时刻（epoch 毫秒）。 */
  last_active: number;
}

/** §4.4 的四个层级。 */
export type MemoryLayer = 'L3' | 'L2' | 'L1' | 'archived';

/**
 * 有效稳定度 = `stability × pin_factor`（§4.1），单位**天**，语义是**时间常数 τ**。
 *
 * ⚠️ `pin_factor` 在**分母内**（拉长 τ ⇒ 衰减更慢），**绝不回写 `stability`**：
 *   直接改 `stability` 就无法撤销了（§4.1：这正是用 `pin_factor` 而非直接改 `stability` 的原因）。
 */
export function effectiveStability(memory: DecayMemoryInput): number {
  return memory.stability * memory.pin_factor;
}

/**
 * 当前强度（§4.1）：`min(1, exp(-Δt / (τ × 86400000)))`，`Δt = max(0, now - last_access)`。
 *
 * @param memory 记忆（只需 `stability` / `pin_factor` / `last_access`）
 * @param now 注入时钟（C37）；缺省取真实时钟
 * @returns `intensity ∈ (0, 1]`
 */
export function intensity(memory: DecayMemoryInput, now?: number): number {
  const tauMs = effectiveStability(memory) * MS_PER_DAY;
  const elapsedMs = Math.max(0, resolveNow(now) - memory.last_access);
  return Math.min(1, Math.exp(-elapsedMs / tauMs));
}

/**
 * 层级判定（§4.4）：`> THRESHOLD_L3 → L3`；`> THRESHOLD_L2 → L2`；`> ARCHIVE_LINE → L1`；否则 `archived`。
 *
 * ⚠️ **三处比较都是严格大于**（§4.4 原文是 `intensity > 0.7`，不是 `≥`）：
 *   写成 `≥` 会让「恰好落在阈值上」的记忆被抬进更高一层，
 *   而阈值本身是可调参数 ⇒ 调参时边界行为会悄悄反向。
 *
 * ⚠️ **层级不落库**，是读取时现算的派生值（§4.4 标题即写明「纯函数，不落库」）。
 *
 * @param value `intensity`
 * @param params 生效参数（阈值是可调项 ⇒ **必传**，不给默认值，见下）
 */
export function layerOf(value: number, params: Params): MemoryLayer {
  if (value > params.THRESHOLD_L3) {
    return 'L3';
  }
  if (value > params.THRESHOLD_L2) {
    return 'L2';
  }
  if (value > params.ARCHIVE_LINE) {
    return 'L1';
  }
  return 'archived';
}

/**
 * 边权重衰减（§4.5）：`weight × exp(-Δt / (EDGE_STABILITY × 86400000))`，`Δt = max(0, now - last_active)`。
 *
 * ⚠️ 这里**没有** `min(1, ...)`：§4.5 的公式就是裸的，上界由**写入侧**的
 *   `MAX_EDGE_WEIGHT` 保证（§4.5 的强化形式 `min(MAX_EDGE_WEIGHT, w + STEP)`）。
 *   在这里多夹一道会让「权重被封顶」这件事有两个权威来源。
 *
 * ⚠️ `EDGE_STABILITY`（默认 30 天）是**时间常数 τ**，实际半衰期 = `30 × ln2 ≈ 20.8 天`。
 *
 * @param edge 边（只需 `weight` / `last_active`）
 * @param params 生效参数（**必传**：`EDGE_STABILITY` 是可调项）
 * @param now 注入时钟（C37）；缺省取真实时钟
 */
export function edgeWeight(edge: DecayEdgeInput, params: Params, now?: number): number {
  const elapsedMs = Math.max(0, resolveNow(now) - edge.last_active);
  const tauMs = params.EDGE_STABILITY * MS_PER_DAY;
  return edge.weight * Math.exp(-elapsedMs / tauMs);
}

/**
 * 归档跨度因子（**唯一实现**，无量纲）：`ln(1 / ARCHIVE_LINE)`。
 *
 * ★ **为什么需要它**（C36：两份副本可能不一致）：
 *   `ln(1 / ARCHIVE_LINE)` 这个数在**三处**都要用到——
 *   ① §9.4.1 的 `archive_at`（本文件 `archiveAt`）；
 *   ② §9.4.1 迁移回填 `archival_schedule.archive_at`（`src/db/migrate.ts`）；
 *   ③ §4.6 步骤 2 的粗筛窗口（`src/core/scoring.ts` 的 `coarseGateWindow`）。
 *   三处各写一遍 `Math.log(1 / ARCHIVE_LINE)` ⇒ 改公式要改三处，
 *   **漏改一处不会报错**，只会让两个口径对不上：
 *   表现为「一条记忆按迁移回填的 `archive_at` 判定未归档、按粗筛窗口却已被挡住」
 *   ——**两个口径打架**，用户看到的是「明明没过期却召不回」。
 *
 * ⚠️ **本函数是那三处的唯一权威**；`archiveSpanMs` 只是它的毫秒形态，**不是第二份实现**。
 *
 * ⚠️ **刻意不给默认参数**：`ARCHIVE_LINE` 是**可调项**（§9.4.3 `setParams` 的第 10 条路径）。
 *   若在核心公式里藏一个 `DEFAULT_PARAMS.ARCHIVE_LINE` 默认值，
 *   「改了参数表、却忘了改那个默认」的漂移就**无从察觉**
 *   （调用点会安静地继续用旧值，且不报错）。
 *   ⇒ 调用方必须显式传 `params.ARCHIVE_LINE`（与 `layerOf` / `archiveAt` 的口径一致）。
 *
 * @param archiveLine 归档线（传 `params.ARCHIVE_LINE`）
 * @returns `ln(1 / archiveLine)`（`ARCHIVE_LINE = 0.05` ⇒ `ln(20) ≈ 2.9957`）
 */
export function archiveSpanFactor(archiveLine: number): number {
  return Math.log(1 / archiveLine);
}

/**
 * 归档跨度（**毫秒**）：`ln(1 / ARCHIVE_LINE) × MS_PER_DAY`。
 *
 * ★ 语义：**从「归档线」到「归档点」的毫秒跨度**——
 *   一条 τ = 1 天的记忆，从强度 1 衰减到 `ARCHIVE_LINE` 需要这么多个毫秒
 *   （§9.4.1：`archive_at` 那一刻的强度**恰好**等于 `ARCHIVE_LINE`，ADR-18）。
 *
 * ⚠️ **「天 → 毫秒」的换算只有一个来源**：`MS_PER_DAY`（本文件顶部）。
 *   历史上 `src/db/migrate.ts` 自己写了一份 `86_400_000` ⇒ 出现**两份**「天→毫秒」的权威
 *   ⇒ 改一处不改另一处 ⇒ 迁移回填的 `archive_at` 与运行时算的 `archive_at` 差一截
 *   ⇒ **不报错**，只是归档判定提前 / 推后（要等 §9.4.4 护栏①才抓到）。
 *   ⇒ 现在**只有本文件**能写这个换算。
 *
 * ⚠️ 本函数**不重写公式**，它就是 `archiveSpanFactor` 的毫秒形态（避免公式分叉）。
 *
 * @param archiveLine 归档线（传 `params.ARCHIVE_LINE`）
 * @returns 归档跨度（毫秒）
 */
export function archiveSpanMs(archiveLine: number): number {
  return archiveSpanFactor(archiveLine) * MS_PER_DAY;
}

/**
 * 归档时刻（§9.4.1）：`last_access + stability × pin_factor × ln(1/ARCHIVE_LINE) × 86400000`。
 *
 * ★ **它是精确的，不是近似**（ADR-18）：
 *   `intensity ≤ ARCHIVE_LINE ⟺ Δt ≥ τ × ln(1/ARCHIVE_LINE)` ⇒
 *   `archive_at` 那一刻的强度**恰好**等于 `ARCHIVE_LINE`
 *   （`tests/unit/decay.test.ts` 用这条做同源自洽校验）。
 *   ⇒ `countArchived()` 可以只查 `archive_at <= now` 而不逐行算 `exp()`。
 *
 * ⚠️ **公式里必须有 `pin_factor`**：漏掉它 ⇒ 被 pin 的记忆归档时刻算早 `pin_factor` 倍
 *   （默认 5 倍），表现为「刚强调过的记忆几天就被判归档」。
 *
 * @param memory 记忆（只需 `stability` / `pin_factor` / `last_access`）
 * @param params 生效参数（**必传**：`ARCHIVE_LINE` 是可调项）
 */
export function archiveAt(memory: DecayMemoryInput, params: Params): number {
  const tauDays = effectiveStability(memory);
  // ⚠️ 跨度只从唯一权威 `archiveSpanFactor` 取（不再就地写 `Math.log(1 / ARCHIVE_LINE)`）。
  //   乘法顺序保持 `τ × 因子 × MS_PER_DAY` ⇒ 与收敛前的数值**逐位相同**。
  return memory.last_access + tauDays * archiveSpanFactor(params.ARCHIVE_LINE) * MS_PER_DAY;
}
