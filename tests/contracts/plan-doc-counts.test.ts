/**
 * F-01 残余②：`scripts/check-doc-counts.ts` 对**计划稿里那份副本**的断言。
 *
 * ⚠️ **这条断言存在的理由（实测缺口，不是假想）**：
 *   §5 的分类声明在**三处**有副本 —— 设计稿 §5、`docs/design/DEVELOPMENT-PLAN.md`
 *   的「项的构成」那一段、以及（**已删**）`src/core/params.ts` 的注释。
 *   实测：把计划稿里那份改回旧口径（照抄相加得 61）⇒
 *   **6 条门禁全部 exit 0** ⇒ **假绿**——因为所有门禁只读 DESIGN-v2.md 一份。
 *   ⇒ 现在计划稿这份副本**也在门禁里**：漂了就红。
 *
 * ★ **断言纪律**：每条关键断言都配**负控**（把文档改成会错的样子 ⇒ 这条必须变红），
 *   并且负控**先断言「变异真的生效了」**（否则「变异没生效 ⇒ 断言通过」是个假绿）。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkPlanDocCounts,
  parsePlanComposition,
  readPlanDoc,
  runCli,
} from '../../scripts/check-doc-counts.js';
import { readDesignDoc } from '../../scripts/lib/design-doc.js';
import { PARAM_KEYS } from '../../src/core/params.js';

/** 真实的设计稿全文（§5 的分类声明在这里）。 */
const DESIGN = readDesignDoc();

/** 真实的计划稿全文（「项的构成」那一段在这里）。 */
const PLAN = readPlanDoc();

/** 计划稿里「共激活 10 项」这句话（用来做变异）。 */
const PLAN_COACT_TEN = '共激活 **10** 项';

describe('F-01 残余② · 计划稿里的分类构成副本也要被门禁守住', () => {
  it('★ 真实的两份文档 ⇒ 零不一致（门禁的「真判据」通过态）', () => {
    expect(checkPlanDocCounts(PLAN, DESIGN, PARAM_KEYS.length)).toEqual([]);
  });

  it('★ 计划稿的构成之和 == §5 的参数总数（构成本身被解析出来了，不是空解析）', () => {
    const parsed = parsePlanComposition(PLAN);
    // 性质：四组 + v1.0 继承之和 == 代码里的键数
    const sum =
      parsed.inherited +
      Object.values(parsed.groups)
        .map((subs) => subs.reduce((a, b) => a + b, 0))
        .reduce((a, b) => a + b, 0);
    expect(sum).toBe(PARAM_KEYS.length);
    // 性质：另一条轴（按生效阶段拆）的阶段项数之和也等于总数
    expect(parsed.stageCounts.reduce((a, b) => a + b, 0)).toBe(PARAM_KEYS.length);
    // ⚠️ 反例：若解析器漏读某一组（那正是「漏读伪装成一致」那一类假绿）
    //   ⇒ 上面的和会偏小 ⇒ 这条断言变红。
    expect(Object.keys(parsed.groups).sort()).toEqual(
      ['机制开关', '性能参数', '行为语义参数', '运维参数'].sort(),
    );
  });

  it('★ 负控：把计划稿里的「共激活 10」改成 11（构成之和 60 → 61）⇒ 被抓住', () => {
    const broken = PLAN.replace(PLAN_COACT_TEN, '共激活 **11** 项');
    // ⚠️ **先断言变异真的生效了**（否则下面的断言可能是「因为没变异所以没红」）
    expect(broken).not.toBe(PLAN);

    const diffs = checkPlanDocCounts(broken, DESIGN, PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
    const reasons = diffs.map((diff) => diff.reason).join('\n');
    // 性质：报错要指出**在哪一节**、**期望多少**、**实际多少**
    expect(reasons).toContain('DEVELOPMENT-PLAN.md');
    expect(reasons).toContain('项的构成');
    expect(reasons).toContain(String(PARAM_KEYS.length));
    expect(reasons).toContain('61');
  });

  it('★ 负控：把计划稿自称的「合计 60」改成 59 ⇒ 被抓住', () => {
    const broken = PLAN.replace('合计 60。', '合计 59。');
    expect(broken).not.toBe(PLAN);

    const diffs = checkPlanDocCounts(broken, DESIGN, PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((diff) => diff.reason).join('\n')).toContain('自称的合计');
  });

  it('★ 负控：只改 §5（设计稿）那一侧 ⇒ 计划稿与 §5 逐组不一致 ⇒ 被抓住', () => {
    const brokenDesign = DESIGN.replace(PLAN_COACT_TEN, '共激活 **9** 项');
    expect(brokenDesign).not.toBe(DESIGN);

    const diffs = checkPlanDocCounts(PLAN, brokenDesign, PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
    const reasons = diffs.map((diff) => diff.reason).join('\n');
    expect(reasons).toContain('行为语义参数');
    // ⚠️ 报错要同时给出两边的数：**期望** = §5 的（被改过的那一侧 = 15）、
    //   **实际** = 计划稿的（没改的那一侧 = 16）
    expect(reasons).toContain('15');
    expect(reasons).toContain('16');
  });

  it('★ 负控：计划稿里的 v1.0 继承数被改 ⇒ 被抓住', () => {
    const broken = PLAN.replace('v1.0 继承 = **29** 项', 'v1.0 继承 = **28** 项');
    expect(broken).not.toBe(PLAN);

    const diffs = checkPlanDocCounts(broken, DESIGN, PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((diff) => diff.reason).join('\n')).toContain('v1.0 继承');
  });

  it('★ 负控：阶段分布之和被改 ⇒ 被抓住（另一条轴也要守）', () => {
    const broken = PLAN.replace('阶段 5 = **0** 项', '阶段 5 = **1** 项');
    expect(broken).not.toBe(PLAN);

    const diffs = checkPlanDocCounts(broken, DESIGN, PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((diff) => diff.reason).join('\n')).toContain('阶段项数之和');
  });

  it('★ 找不到「项的构成」那一段 ⇒ 抛错（不静默跳过：跳过 = 解析器漏读伪装成一致）', () => {
    expect(() => parsePlanComposition('这里根本没有那段话')).toThrow(/找不到/);
  });

  it('★ CLI：真实文档 ⇒ 退出码 0；变异过的计划稿 ⇒ 退出码非 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-plan-counts-'));
    const brokenPath = join(dir, 'plan.md');
    writeFileSync(brokenPath, PLAN.replace(PLAN_COACT_TEN, '共激活 **11** 项'), 'utf8');

    // 真判据：真实的两份文档一致 ⇒ 0
    expect(runCli([])).toBe(0);
    // 变异过的计划稿 ⇒ 非 0
    expect(runCli(['--plan', brokenPath])).not.toBe(0);
  });
});
