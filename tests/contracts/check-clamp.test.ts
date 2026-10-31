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
