/**
 * `scripts/check-clamp.ts` 的单测 —— F-08 ③ 的静态守卫。
 *
 * ★ 本文件的断言纪律（沿用仓库惯例）：
 *   · **每条正向断言都配一条反例**：反例不是「换个输入再看一遍」，而是**故意写出那个会错的写法**
 *     （删掉钳制 / 把钳制挪出函数体 / 把钳制写进注释 / 把实参改掉），
 *     断言「守卫会红」⇒ 证明守卫**真的能发现不一致**（否则守卫只是装饰）。
 *   · 反例一律用**合成源码**（不动仓库里的真实文件）⇒ 测试可重复、且不会污染工作树。
 *   · **不写死快照数字**：期望值写成「缺哪一道 / 判据命中与否」这类**性质**。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_REQUIRED_CLAMP_COUNT,
  REQUIRED_CLAMPS,
  TARGET_FILE,
  TARGET_FUNCTION,
  findFunctionBody,
  scanClamps,
} from '../../scripts/check-clamp.js';

/** 两道钳制齐全的合成源码（函数体内**故意**放了一条提到钳制的注释）。 */
const WITH_BOTH = `
export function intensity(memory: { last_access: number }, now?: number): number {
  // ⚠️ 这行注释里写着 Math.max(0, ...) 与 Math.min(1, ...) —— 守卫必须**无视注释**。
  const elapsedMs = Math.max(0, now - memory.last_access);
  return Math.min(1, Math.exp(-elapsedMs / 1000));
}
`;

/** 删掉「强度上钳」的变体。 */
const WITHOUT_MIN = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = Math.max(0, now - memory.last_access);
  return Math.exp(-elapsedMs / 1000);
}
`;

/** 删掉「Δt 下钳」的变体。 */
const WITHOUT_MAX = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = now - memory.last_access;
  return Math.min(1, Math.exp(-elapsedMs / 1000));
}
`;

/** 两道都删掉的变体。 */
const WITHOUT_BOTH = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = now - memory.last_access;
  return Math.exp(-elapsedMs / 1000);
}
`;

/** 把钳制挪到**别的函数**里（文件里仍然有 `Math.max(0, …)` / `Math.min(1, …)`）。 */
const OUTSIDE_THE_BODY = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = now - memory.last_access;
  return Math.exp(-elapsedMs / 1000);
}

export function unrelated(): number {
  return Math.max(0, Math.min(1, 0.5));
}
`;

/** 把钳制写进**注释**里（函数体内，但不在代码里）。 */
const INSIDE_A_COMMENT = `
export function intensity(memory: { last_access: number }, now?: number): number {
  // Math.max(0, ...) 与 Math.min(1, ...) 只是说明文字
  const elapsedMs = now - memory.last_access;
  return Math.exp(-elapsedMs / 1000);
}
`;

/**
 * 把钳制挪到**模块顶层常量**里（文件里仍然有 `Math.max(0, …)` / `Math.min(1, …)`）。
 *
 * ⚠️ 这一条是最阴的一种漂移：钳制**还在文件里**，只是搬到了 `intensity()` 外面
 *   ⇒ 「全文件 grep 式的存在性扫描」照样通过 ⇒ 守卫就松了。
 */
const AT_MODULE_TOP_LEVEL = `
const CLAMPED = Math.max(0, Math.min(1, 0.5));

export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = now - memory.last_access;
  return Math.exp(-elapsedMs / 1000);
}
`;

/** 实参被改掉的变体（`Math.min(1, …)` ⇒ `Math.min(0.5, …)`）。 */
const WRONG_ARGUMENT = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = Math.max(0, now - memory.last_access);
  return Math.min(0.5, Math.exp(-elapsedMs / 1000));
}
`;

/** 目标函数根本不存在的变体。 */
const NO_SUCH_FUNCTION = `
export function somethingElse(): number {
  return Math.max(0, Math.min(1, 0.5));
}
`;

/**
 * ★ **绕过变体**：删掉 Δt 钳制，再补一个**无关的** `Math.max(0, …)`。
 *
 * ⚠️ 这是「只验模式存在」的那条守卫**堵不住**的洞：
 *   函数体内**确实**有 `Math.max(0, …)` ⇒ 存在性检查通过，
 *   但那道钳制**根本没夹 Δt** ⇒ Δt 钳制事实上已经没了。
 */
const UNRELATED_MAX = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = now - memory.last_access;
  const unrelated = Math.max(0, 42);
  return Math.min(1, Math.exp(-elapsedMs / 1000));
}
`;

/**
 * ★ **绕过变体**：`Math.min(1, …)` 夹的是**无关的**东西，返回值根本没被夹。
 */
const UNRELATED_MIN = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = Math.max(0, now - memory.last_access);
  const unrelated = Math.min(1, 42);
  return Math.exp(-elapsedMs / 1000);
}
`;

/**
 * **中间变量写法**（等价、合法）⇒ 守卫必须**放行**。
 *
 * ⚠️ 这是「不误报」的守卫：`Math.max(0, deltaMs)` 的第二个实参里**没有** `last_access`
 *   ⇒ 「第二个实参必须含 last_access」那种 token 判据会**误报**；
 *   ⇒ 数据流判据（exp 的实参引用了被 max(0,·) 赋值的 `elapsedMs`）才放得过。
 */
const INTERMEDIATE_VARIABLE = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const deltaMs = now - memory.last_access;
  const elapsedMs = Math.max(0, deltaMs);
  return Math.min(1, Math.exp(-elapsedMs / 1000));
}
`;

/** **内联写法**（等价、合法）⇒ 守卫必须**放行**。 */
const INLINE_MAX = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const delta = now - memory.last_access;
  return Math.min(1, Math.exp(-Math.max(0, delta) / 1000));
}
`;

/**
 * **`Math.exp` 被提取成中间变量**（等价、合法）⇒ 守卫必须**放行**。
 *
 * ⚠️ 这是 **min 侧**的对称缺口（与 `INTERMEDIATE_VARIABLE` 互为镜像）：
 *   max 侧认得中间变量（`elapsedMs`），min 侧若只认 `Math.exp(` 的**字面**，
 *   则 `Math.min(1, decay)` 的实参里没有 `exp(` ⇒ **误报**。
 *   ⇒ 「守卫不误伤好的」这条契约，必须**两侧对称**才成立。
 */
const EXP_EXTRACTED = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = Math.max(0, now - memory.last_access);
  const decay = Math.exp(-elapsedMs / 1000);
  return Math.min(1, decay);
}
`;

/**
 * ★ **绕过变体 + `Math.exp` 被提取成中间变量** ⇒ 必须判「Δt 下钳没生效」。
 *
 * ⚠️ 关键：**判红的理由必须是对的那条**（max 没生效），
 *   而不是「找不到 exp」这种**顺带**结论（那会把 min 一起误报）。
 */
const BYPASS_WITH_EXP_EXTRACTED = `
export function intensity(memory: { last_access: number }, now?: number): number {
  const elapsedMs = now - memory.last_access;
  const unrelated = Math.max(0, 42);
  const decay = Math.exp(-elapsedMs / 1000);
  return Math.min(1, decay);
}
`;

/** 缺哪一道（返回规格里的 `method`）。 */
function missingMethods(source: string): string[] {
  return scanClamps(source).missing.map((spec) => spec.method);
}

describe('F-08 ③ · check-clamp（intensity() 的两道钳制）', () => {
  it('真实文件通过：两道钳制都在 intensity() 的函数体里', () => {
    const source = readFileSync(
      fileURLToPath(new URL(`../../${TARGET_FILE}`, import.meta.url)),
      'utf8',
    );
    const result = scanClamps(source);

    expect(result.functionFound).toBe(true);
    expect(result.missing).toEqual([]);
    // ⚠️ 判据落在**函数体**上 ⇒ 两道钳制的行号必须落在 bodyLines 之内
    const body = result.bodyLines;
    expect(body).not.toBeNull();
    for (const method of ['max', 'min'] as const) {
      for (const hit of result.hits[method]) {
        expect(hit.line).toBeGreaterThanOrEqual(body?.start ?? 0);
        expect(hit.line).toBeLessThanOrEqual(body?.end ?? 0);
      }
    }
  });

  it('★ 反例：删掉「强度上钳」⇒ 守卫必须判缺 min', () => {
    expect(missingMethods(WITHOUT_MIN)).toEqual(['min']);
    // ⚠️ 同时确认：另一道**还在**（守卫是逐道判的，不是「整体有无」）
    expect(missingMethods(WITHOUT_MIN)).not.toContain('max');
  });

  it('★ 反例：删掉「Δt 下钳」⇒ 守卫必须判缺 max', () => {
    expect(missingMethods(WITHOUT_MAX)).toEqual(['max']);
    expect(missingMethods(WITHOUT_MAX)).not.toContain('min');
  });

  it('★ 反例：两道都删 ⇒ 守卫必须判缺两道', () => {
    expect(missingMethods(WITHOUT_BOTH).sort()).toEqual(['max', 'min']);
  });

  it('★ 反例：把钳制挪到**别的函数**里 ⇒ 守卫仍判缺（证明是按函数体定位，不是全文件 grep）', () => {
    // ⚠️ 全文件 grep 的写法在这里会「通过」（文件里确实有 Math.max(0, …)）⇒ 守卫就松了
    expect(missingMethods(OUTSIDE_THE_BODY).sort()).toEqual(['max', 'min']);
    // ⚠️ 而全文件里**确实**存在这两道钳制 —— 这正是「必须按函数体定位」的理由
    expect(OUTSIDE_THE_BODY).toContain('Math.max(0,');
    expect(OUTSIDE_THE_BODY).toContain('Math.min(1,');
  });

  it('★ 反例：把钳制写进**注释**里 ⇒ 守卫仍判缺（证明先剥注释再扫）', () => {
    expect(missingMethods(INSIDE_A_COMMENT).sort()).toEqual(['max', 'min']);
    expect(INSIDE_A_COMMENT).toContain('Math.max(0,');
    expect(INSIDE_A_COMMENT).toContain('Math.min(1,');
  });

  it('★ 反例：把钳制挪到**模块顶层常量**里 ⇒ 守卫仍判缺（钳制还在文件里，但不在 intensity 里）', () => {
    // ⚠️ 这是最阴的一种漂移：文件里确实还有两道钳制，只是搬到了 `intensity()` 外面
    //   ⇒ 「全文件 grep 式的存在性扫描」照样通过 ⇒ 守卫就松了
    expect(missingMethods(AT_MODULE_TOP_LEVEL).sort()).toEqual(['max', 'min']);
    expect(AT_MODULE_TOP_LEVEL).toContain('Math.max(0,');
    expect(AT_MODULE_TOP_LEVEL).toContain('Math.min(1,');
  });

  it('★ 反例：实参被改掉（min(1, …) ⇒ min(0.5, …)）⇒ 守卫判缺（证明判据是实参不是字符串）', () => {
    expect(missingMethods(WRONG_ARGUMENT)).toEqual(['min']);
    expect(missingMethods(WRONG_ARGUMENT)).not.toContain('max');
  });

  it('★ 反例：目标函数不存在 ⇒ 守卫判「没扫到」（绝不能当成通过）', () => {
    const result = scanClamps(NO_SUCH_FUNCTION);
    expect(result.functionFound).toBe(false);
    expect(result.bodyLines).toBeNull();
    // ⚠️ 「没扫到」必须等于「全部缺失」⇒ 否则删掉整个函数也会显示全绿
    expect(result.missing).toHaveLength(EXPECTED_REQUIRED_CLAMP_COUNT);
  });

  it('★ 反例：删掉 Δt 钳制、补一个**无关的** `Math.max(0, …)` ⇒ 守卫必须判「存在但没生效」', () => {
    // ⚠️ 这是「只验模式存在」的那条守卫堵不住的洞：
    //   函数体内**确实**有 `Math.max(0, …)` ⇒ 存在性检查会通过
    //   ⇒ 但那道钳制根本没夹 Δt ⇒ 事实上等于把 Δt 钳制删了
    const result = scanClamps(UNRELATED_MAX);
    // ⚠️ 它**不是**「缺失」（调用确实在）⇒ 必须落在 `unguarded` 而不是 `missing`
    expect(result.missing).toEqual([]);
    expect(result.unguarded.map((spec) => spec.method)).toContain('max');
  });

  it('★ 反例：`Math.min(1, …)` 夹的是无关的东西 ⇒ 守卫必须判「存在但没生效」', () => {
    const result = scanClamps(UNRELATED_MIN);
    expect(result.missing).toEqual([]);
    expect(result.unguarded.map((spec) => spec.method)).toContain('min');
  });

  it('★ 不误报：中间变量写法（`Math.max(0, deltaMs)`）必须**放行**', () => {
    // ⚠️ 「第二个实参里必须含 last_access」那种 token 判据会在这里**误报**
    //   ⇒ 数据流判据才放得过 ⇒ 这条是「守卫别过紧」的保证
    const result = scanClamps(INTERMEDIATE_VARIABLE);
    expect(result.missing).toEqual([]);
    expect(result.unguarded).toEqual([]);
  });

  it('★ 不误报：内联写法（`Math.exp(-Math.max(0, delta) / tau)`）必须**放行**', () => {
    const result = scanClamps(INLINE_MAX);
    expect(result.missing).toEqual([]);
    expect(result.unguarded).toEqual([]);
  });

  it('★ 不误报：`Math.exp` 被提取成中间变量（`const decay = Math.exp(…)`）必须**放行**', () => {
    // ⚠️ 这是 min 侧的对称缺口：`Math.min(1, decay)` 的实参里**没有** `Math.exp(` 的字面
    //   ⇒ 只认字面就会**误报** ⇒ max 侧放行、min 侧误杀 ⇒ 契约只兑现了一半
    const result = scanClamps(EXP_EXTRACTED);
    expect(result.missing).toEqual([]);
    expect(result.unguarded).toEqual([]);
  });

  it('★ 绕过 + `Math.exp` 被提取成中间变量 ⇒ 判「Δt 下钳没生效」，且**不**顺带误报 min', () => {
    const result = scanClamps(BYPASS_WITH_EXP_EXTRACTED);
    // ⚠️ 判红的**理由**必须是对的那条：max 没生效
    expect(result.unguarded.map((spec) => spec.method)).toEqual(['max']);
    // ⚠️ min 侧此时是**真的**在夹 exp ⇒ 不得被顺带误报
    expect(result.unguarded.map((spec) => spec.method)).not.toContain('min');
    expect(result.missing).toEqual([]);
  });

  it('C31 自洽：规格表的条数与写死的期望一致（守卫的「分母」不许漂）', () => {
    expect(REQUIRED_CLAMPS).toHaveLength(EXPECTED_REQUIRED_CLAMP_COUNT);
    expect(REQUIRED_CLAMPS.map((spec) => spec.method)).toEqual(['max', 'min']);
    expect(REQUIRED_CLAMPS.map((spec) => spec.expectedArgument)).toEqual([0, 1]);
  });

  it('定位到的是 intensity() 本身（不是别的同名片段）', () => {
    const body = findFunctionBody(WITH_BOTH, TARGET_FUNCTION);
    expect(body).not.toBeNull();
    expect(body?.bodyStart).toBeGreaterThan(body?.signatureStart ?? 0);
    expect(WITH_BOTH.slice(body?.bodyStart ?? 0, (body?.bodyEnd ?? 0) + 1)).toContain(
      'Math.max(0,',
    );
    expect(WITH_BOTH.slice(body?.bodyStart ?? 0, (body?.bodyEnd ?? 0) + 1)).toContain(
      'Math.min(1,',
    );
  });
});
