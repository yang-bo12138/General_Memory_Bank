/**
 * `scripts/audit-tier-qualifiers.negative-control.ts` 的单测 —— **负控台的负控**。
 *
 * ★ 这一层的必要性（它是「验证工具自己会不会失手」那条纪律的落点）：
 *   负控台说「审计脚本不是恒绿守卫」⇒ 但**负控台自己也可能恒绿**
 *   （比如它把所有异常都吞掉、只打印不累加 ⇒ ⇒ 永远 exit 0）。
 *   ⇒ ⇒ 故本文件做两件负控台做不了的事：
 *     ① **注入一个「恒绿审计」**（永远说 missing = 0）⇒ **负控台必须报失败**；
 *     ② **把目标文档换成「没有那张表」的文本** ⇒ **负控台必须报定位失败**，而不是静默通过。
 *   ⇒ ⇒ 两条合起来 ⇒ **「负控台通过」这句话本身才是可被反证的**。
 *
 * ⚠️ **为什么断言「失败数 > 0」而不是「某一条特定用例失败」**：
 *   那是**性质**（负控台有牙），不是实现细节（哪一条先红）。
 *   写死具体用例名会把这条测试变成「实现快照」⇒ 改用例顺序就红 ⇒ 没人敢动。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AuditResult } from '../../scripts/audit-tier-qualifiers.js';
import {
  CONTROLS,
  renderNegativeControlReport,
  runNegativeControls,
} from '../../scripts/audit-tier-qualifiers.negative-control.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const README_PATH = join(REPO_ROOT, 'docs/baseline/README.md');

/** 仓库里真实的基线 README（负控台平时跑的就是它）。 */
function realReadmeLines(): string[] {
  return readFileSync(README_PATH, 'utf8').split(/\r?\n/);
}

/**
 * ★ **一个「恒绿审计」**：不论输入是什么，永远说「零真缺、零提示」。
 *
 * ⚠️ **它就是要骗过负控台的那一面**：负控台 B/C 断言「真缺必须 > 0」
 *   ⇒ ⇒ 面对恒绿审计 ⇒ **必须报失败** ⇒ 否则负控台自己就是摆设。
 */
function alwaysGreenAudit(_lines: readonly string[]): AuditResult {
  return {
    counts: { scanned: 0, adjudicated: 0, missing: 0, advisories: 0 },
    gaps: [],
    advisories: [],
  };
}

describe('负控台的负控（scripts/audit-tier-qualifiers.negative-control.ts）', () => {
  it('★ 分母写死：四个用例一个不多一个不少，且名字逐个点名', () => {
    // ★ 纪律 1「期望值必须外部写死」：这里的 4 是**写死的期望值**，不是 CONTROLS.length
    //   ⇒ 若有人删掉一个用例（比如把「全文件抹」删了）⇒ 本断言红 ⇒ 覆盖面缩水会被发现。
    expect(CONTROLS).toHaveLength(4);
    const names = CONTROLS.map((control) => control.name);
    expect(names[0]).toContain('原始');
    expect(names[1]).toContain('负控 A');
    expect(names[2]).toContain('负控 B');
    expect(names[3]).toContain('负控 C');
    // ⇒ 每条用例都必须**写明为什么**（否则它变成一条没人懂的魔法）
    for (const control of CONTROLS) {
      expect(control.why.length).toBeGreaterThan(0);
    }
  });

  it('正向：真实 README 上跑一遍 ⇒ 零失败', () => {
    const report = runNegativeControls(realReadmeLines());
    expect(report.failures).toBe(0);
    expect(report.outcomes).toHaveLength(4);
    for (const outcome of report.outcomes) {
      expect(outcome.ok, `${outcome.name} 不符合预期`).toBe(true);
    }
  });

  it('★ 断言加强：「变异生效」必须为真（否则 A/B/C 是在空跑）', () => {
    const report = runNegativeControls(realReadmeLines());
    for (const outcome of report.outcomes) {
      // ⇒ 基线用例本来不带变异 ⇒ 它是唯一允许 `applied === false` 的一条
      const isBaseline = outcome.name.includes('原始');
      expect(outcome.applied, `${outcome.name} 的变异没有生效`).toBe(!isBaseline);
    }
  });

  it('★ 反例①：注入「恒绿审计」⇒ 负控台必须报失败（它不是恒绿守卫）', () => {
    const report = runNegativeControls(realReadmeLines(), alwaysGreenAudit);
    expect(report.failures).toBeGreaterThan(0);
    // ⇒ 失败原因必须写清「断言不符合预期」或「变异未生效」，不能是一句空话
    const reasons = report.outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => outcome.failureReason ?? '');
    expect(reasons.join(' ')).toMatch(/断言不符合预期|变异未生效/);
  });

  it('★ 反例②：目标表定位失败 ⇒ 必须报「定位失败」，不许静默通过', () => {
    // ⇒ 一份**没有那张表**的文档（内容锚点找不到）
    const lines = ['# 空文档', '', '这里没有「100 万条实测（」那张表。'];
    const report = runNegativeControls(lines);
    expect(report.failures).toBeGreaterThan(0);
    const failures = report.outcomes.filter((outcome) => !outcome.ok);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.map((outcome) => outcome.failureReason ?? '').join(' ')).toContain(
      '负控定位失败',
    );
  });

  it('幂等：同一输入跑两次 ⇒ 渲染逐字相同（无时间戳、无随机）', () => {
    const lines = realReadmeLines();
    const first = renderNegativeControlReport(runNegativeControls(lines));
    const second = renderNegativeControlReport(runNegativeControls(lines));
    expect(first).toBe(second);
    expect(first).toContain('负控台');
  });
});
