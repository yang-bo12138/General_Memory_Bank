/**
 * 稳定度增长（记忆加固）—— DESIGN-v2.md §4.2，对应 DEVELOPMENT-PLAN.md **P1-T06**。
 *
 * ★ **全库唯一的 `stability` 写入点**（§4.2 原话）：
 *   本库有两条路径会增长稳定度——`touch` 与去重合并。它们最初各写各的公式，
 *   接连出过三次同类事故：
 *     ① 合并路径漏套 `MAX_STABILITY` ⇒ 成了绕过上限的后门；
 *     ② 合并路径绕过同日守卫 ⇒ webhook 重投 10 次能涨 13.8 倍；
 *     ③ 两条路径的间隔语义不一致 ⇒ 同一行为有两种结果。
 *   ⇒ 收拢后这**三个约束结构上不可能漏**：调用方只能传倍率，改不了守卫。
 *
 * ⚠️ 本文件是**纯计算**，`src/store/touch.ts` 负责在**单事务内**执行写回
 *   （§4.2：「数据库写回也在函数内完成 ⇒ 调用方不会漏 UPDATE」——
 *    漏写不报错，只会让加固**静默失效**，那是最难查的一类 bug）。
 *   ⇒ 把计算与写回分成两个文件，是为了让「三个约束」能被纯单测守住；
 *     公开的 `growStability`（在 store 层）仍然是**唯一**会写 `stability` 的函数，
 *     由静态扫描断言盯着（`tests/unit/touch.test.ts` 会扫 `UPDATE memories SET stability`）。
 *
 * ⚠️ **C37**：所有函数签名含 `now?`；真实时钟只经 `resolveNow()`（唯一入口 `src/core/clock.ts`）。
 */

import { resolveNow } from './clock.js';
import { MS_PER_DAY } from './decay.js';
import type { Params } from './params.js';

/** 加固所需的记忆字段（§4.2）。 */
export interface StabilityInput {
  /** 当前稳定度（天）。 */
  stability: number;
  /** 最近一次访问时刻（epoch 毫秒）。 */
  last_access: number;
  /** 访问次数。 */
  access_count: number;
  /** 难度（`[0, 1]`，越低越容易强化）。 */
  difficulty: number;
}

/** 一次加固的完整结果：**新行状态** + §4.2 要求返回的三个值。 */
export interface StabilityGrowth {
  /** 新稳定度（已被 `MAX_STABILITY` 钳制）。 */
  stability: number;
  /** 新 `last_access`（= `now`）。 */
  last_access: number;
  /** 新 `access_count`（+1）。 */
  access_count: number;
  /** 距上次访问的天数（记进 `touch` 事件的 `intervalDays`）。 */
  intervalDays: number;
  /** 是否真的涨了（记进事件的 `boostApplied`）。 */
  boosted: boolean;
  /**
   * 稳定度的增量（v2.1 裁决：必须返回）。
   *
   * ⚠️ 调用点算不出 `before`（它是函数内局部变量）⇒ 不返回它，事件流就会缺这个键
   *   ⇒ §8.4 规则 5 的对账恒等式（Σ 库内变化 == Σ 事件里的 delta）恒不成立。
   *   ⚠️ **调用方不得用 `boosted` 反推 delta**（一个是布尔、一个是数值）。
   *   ★ 未增长时为 **0**，**键恒在**。
   */
  stabilityDelta: number;
}

/**
 * 难度加成（§4.2 touch 路径）：`DIFFICULTY_BASE + DIFFICULTY_SCALE × (1 - difficulty)`。
 *
 * ⚠️ **必须在逐条循环内按各自的 `m.difficulty` 算**：
 *   批量 touch 的每一条难度不同（首因 / 常规 / 置信度惩罚，见 §4.3），
 *   在循环外算一次再复用 = 给整批套同一个倍率 ⇒ **静默算错，结果仍像正常值**。
 */
export function difficultyBonus(difficulty: number, params: Params): number {
  return params.DIFFICULTY_BASE + params.DIFFICULTY_SCALE * (1 - difficulty);
}

/**
 * 间隔重复加成（§4.2）：`useSpacing ? min(SPACING_CAP, 1 + log2(intervalDays)) : 1`。
 *
 * ⚠️ `useSpacing` 的语义：`touch = true`；**合并 = false**——
 *   合并只是「又提了一次」，不是一次间隔重复，不该拿间隔加成。
 *
 * ⚠️ `intervalDays` 必须已经过 `max(0, ·)`：直接对负数取 `log2` 得 `NaN`，
 *   会让 `stability` 变成 `NaN` 且**不报错**（NaN 的比较恒为 false ⇒ 同日守卫也拦不住）。
 */
export function spacingFactor(intervalDays: number, useSpacing: boolean, params: Params): number {
  return useSpacing ? Math.min(params.SPACING_CAP, 1 + Math.log2(intervalDays)) : 1;
}

/**
 * §4.2 的三个约束 + 增长公式，**纯计算**（不写库）。
 *
 * ```
 * intervalDays = max(0, now - last_access) / 86400000
 * last_access  = now
 * access_count += 1
 * if (intervalDays >= 1.0):                       // 同日守卫
 *   spacing   = useSpacing ? min(SPACING_CAP, 1 + log2(intervalDays)) : 1
 *   stability = min(MAX_STABILITY, stability × baseGrowth × spacing)
 *   boosted   = stability > before
 * stabilityDelta = stability - before             // 未增长时为 0，键恒在
 * ```
 *
 * ⚠️ **`stability` 是乘性的**（`× baseGrowth × spacing`），不是加性的。
 *
 * @param memory 记忆的当前状态
 * @param baseGrowth 基础倍率：touch 传「难度加成」；去重合并传 `DEDUP_BOOST`
 * @param useSpacing 是否叠加间隔加成：touch = true；合并 = **false**
 * @param params 生效参数（**必传**：三个约束的界都在参数表里）
 * @param now 注入时钟（C37）
 */
export function computeStabilityGrowth(
  memory: StabilityInput,
  baseGrowth: number,
  useSpacing: boolean,
  params: Params,
  now?: number,
): StabilityGrowth {
  const at = resolveNow(now);
  const before = memory.stability;

  // ⚠️ ① 防时钟回拨：注入过去时刻时 intervalDays 为负 ⇒ log2(负数) = NaN ⇒ 静默污染 stability。
  const intervalDays = Math.max(0, at - memory.last_access) / MS_PER_DAY;

  let stability = before;
  let boosted = false;

  // ⚠️ ② 同日守卫：同一场对话 / 同一天内的重复提及不属于间隔重复，不增长。
  if (intervalDays >= 1.0) {
    const spacing = spacingFactor(intervalDays, useSpacing, params);
    // ⚠️ ③ MAX_STABILITY 上限钳制（这是绕过上限的后门被堵住的地方）。
    stability = Math.min(params.MAX_STABILITY, before * baseGrowth * spacing);
    boosted = stability > before;
  }

  return {
    stability,
    last_access: at,
    access_count: memory.access_count + 1,
    intervalDays,
    boosted,
    stabilityDelta: stability - before,
  };
}
