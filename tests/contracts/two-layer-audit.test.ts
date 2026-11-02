/**
 * `scripts/audit-two-layer.ts` 的单测 —— 「两个层次必须分开列」的审计。
 *
 * ★ 为什么它必须存在（这是它接门禁的第 3 步）：
 *   `scripts/README.md` §「新增门禁的做法」第 3 条 ⇒ **`tests/contracts/` 里必须有含反例的单测**。
 *   没有反例的门禁 = **一个永远说「通过」的函数** ⇒ 它的绿不是证据（C31 / 纪律 2）。
 *
 * ★ 本文件的四条反例分别打**四个不同的面**（不是同一件事换四个输入）：
 *   ① **漏点名量** ⇒ 必须判红（真缺 > 0）——**判别力**；
 *   ② **不在跨档语境** ⇒ **必须不判** ——**防假阳性**（否则 76 个假阳性会把检查逼成白名单绕过）；
 *   ③ **白名单漂移** ⇒ 必须判红 ——**白名单不能靠印象填**（纪律 4 实例 ⑨）；
 *   ④ **变异必须真的生效** ⇒ 否则上面三条全是空跑。
 *
 * ⚠️ **第 ② 条容易被误当成「宽松」**：它其实是最重要的一条 ——
 *   一个假阳性泛滥的检查**一定会被绕过** ⇒ ⇒ 绕过之后**等于没有检查**。
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CODE_FIELD_NAMES,
  QUANTITY_NAMES,
  auditTwoLayers,
  checkWhitelistAgainstCode,
  collectFiles,
  contextOf,
  renderAudit,
} from '../../scripts/audit-two-layer.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 变异必须**真的生效** ⇒ 否则那条断言是空的（本项目真踩过）。 */
function mustContain(text: string, needle: string): void {
  if (!text.includes(needle)) {
    throw new Error(`★ 合成输入里找不到 ${JSON.stringify(needle)} ⇒ 变异会静默失效`);
  }
}

/** 一行「合规」的句子：有「逐位相同」 + 跨档语境 + **点名了量**（`行数`）。 */
const GOOD_LINE =
  '⇒ **冷盘档与部分热档的 H1 候选读取行数逐位相同**（均为 12,782 行），而毫秒字段会变。';

/** 一行「违规」的句子：同样的语境，但**没有点名量**。 */
const BAD_LINE = '⇒ **冷盘档与部分热档的结果逐位相同**，两个档位看起来一模一样。';

/** 一行**不该被判**的句子：有「逐位相同」，但**不在跨档语境**（没有任何档位词）。 */
const NON_TIER_LINE = '⇒ 衰减公式的两种写法结果逐位相同（都等于 e^(-Δt/S)）。';

/** 构造一个「文件」。 */
function fileOf(path: string, body: string): { path: string; content: string } {
  return { path, content: body };
}

describe('两层次分离审计（scripts/audit-two-layer.ts）', () => {
  it('★ 分母写死：白名单里那几个代码字段名必须在场（它们可机器核）', () => {
    // ★ 为什么断言「在场」而不是「有 3 个」：数量会变，但**这三个是本仓库真实存在的量**
    //   ⇒ ⇒ 少一个 ⇒ 判定会失明 ⇒ ⇒ 故逐个点名（分母写死的一种形态）。
    for (const field of ['candidateReadRows', 'hitFineBuckets', 'vectorCandidateRows']) {
      expect(CODE_FIELD_NAMES).toContain(field);
      expect(QUANTITY_NAMES).toContain(field);
    }
    // ⇒ 中文规范写法「行数」必须在场（第一版漏了它 ⇒ 4 个假阳性）
    expect(QUANTITY_NAMES).toContain('行数');
  });

  it('正向：点名了量 ⇒ 不算真缺', () => {
    mustContain(GOOD_LINE, '逐位相同');
    const audit = auditTwoLayers([fileOf('docs/x.md', GOOD_LINE)]);
    expect(audit.triggerLines).toBe(1);
    expect(audit.judgedLines).toBe(1);
    expect(audit.realGaps).toBe(0);
  });

  it('★ 反例①：跨档语境里没点名量 ⇒ 必须判真缺', () => {
    mustContain(BAD_LINE, '逐位相同');
    mustContain(BAD_LINE, '冷盘档');
    mustContain(BAD_LINE, '部分热档');
    const audit = auditTwoLayers([fileOf('docs/x.md', BAD_LINE)]);
    expect(audit.triggerLines).toBe(1);
    expect(audit.judgedLines).toBe(1);
    expect(audit.realGaps).toBeGreaterThan(0);
    expect(audit.gaps[0]?.path).toBe('docs/x.md');
    expect(audit.gaps[0]?.line).toBe(1);
  });

  it('★ 反例②（防假阳性）：不在跨档语境 ⇒ 必须**不判**', () => {
    mustContain(NON_TIER_LINE, '逐位相同');
    // ⇒ 先证明这一行**没有**档位词（否则下面那条断言会因为「语境里有档位」而变成另一件事）
    expect(/冷盘档|热盘档|两档|三档|跨档/.test(NON_TIER_LINE)).toBe(false);
    const audit = auditTwoLayers([fileOf('docs/x.md', NON_TIER_LINE)]);
    expect(audit.triggerLines).toBe(1);
    // ★ 核心：**触发了，但没被判** ⇒ ⇒ 这就是「范围收窄」，不是「漏判」
    expect(audit.judgedLines).toBe(0);
    expect(audit.realGaps).toBe(0);
  });

  it('★ 反例③：白名单漂移（代码里没有那个字段）⇒ 自检必须判红', () => {
    // ⇒ 注入一份**缺 `candidateReadRows`** 的「假 bench 源码」
    const drifted = 'const hitFineBuckets = 1;\nconst vectorCandidateRows = 2;\n';
    expect(drifted.includes('candidateReadRows')).toBe(false);
    const problems = checkWhitelistAgainstCode(drifted);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('candidateReadRows');
    // ⇒ 并且它必须把**整条审计**判红（不是只打印一行提示）
    const audit = auditTwoLayers([fileOf('docs/x.md', GOOD_LINE)], drifted);
    expect(audit.whitelistSelfCheck.length).toBeGreaterThan(0);
  });

  it('正向：真实 `bench/perf.ts` 里的字段名整齐 ⇒ 自检通过', () => {
    expect(checkWhitelistAgainstCode()).toEqual([]);
  });

  it('★ 反例④：变异必须真的生效（否则上面几条断言是空的）', () => {
    const good = auditTwoLayers([fileOf('docs/x.md', GOOD_LINE)]);
    const bad = auditTwoLayers([fileOf('docs/x.md', BAD_LINE)]);
    // ⇒ 两段文本必须**真的不同**，且差别恰好是「量名」
    expect(GOOD_LINE).not.toBe(BAD_LINE);
    expect(good.realGaps).toBe(0);
    expect(bad.realGaps).toBeGreaterThan(0);
  });

  it('幂等 + 与输入顺序无关（按路径排序）', () => {
    const a = fileOf('docs/a.md', BAD_LINE);
    const b = fileOf('docs/b.md', GOOD_LINE);
    const first = auditTwoLayers([a, b]);
    const second = auditTwoLayers([b, a]);
    expect(renderAudit(first)).toBe(renderAudit(second));
    expect(renderAudit(first)).toBe(renderAudit(auditTwoLayers([a, b])));
    // ⇒ 且**不含时间戳**（两次渲染逐字相同 ⇒ 渲染函数里没有 new Date）
    expect(renderAudit(first)).toBe(renderAudit(first));
  });

  it('上下文是「本行 ± 1 行」（写死的窗口）', () => {
    const lines = ['甲', '乙', '丙', '丁', '戊'];
    expect(contextOf(lines, 2)).toBe('乙\n丙\n丁');
    expect(contextOf(lines, 0)).toBe('甲\n乙');
    expect(contextOf(lines, 4)).toBe('丁\n戊');
  });

  it('正向：仓库真实 `docs/**` ⇒ 零真缺、自检通过（可复跑）', () => {
    // ⚠️ 刻意**不写死**「触发行 101 / 判定数 32」这类读数
    //   ⇒ 它们是「文档改了多少行」的函数 ⇒ 写死会把门禁变成「不许改文档」
    //   ⇒ ⇒ 写死的只能是**性质**：收得到文件、真缺为 0、自检为空。
    const realDocs = collectFiles(join(REPO_ROOT, 'docs'));
    expect(realDocs.length).toBeGreaterThan(0);
    const audit = auditTwoLayers(realDocs);
    expect(audit.triggerLines).toBeGreaterThan(0);
    expect(audit.realGaps).toBe(0);
    expect(audit.whitelistSelfCheck).toEqual([]);
  });

  it('★ CLI 薄壳：退出码为 0（接线正确，不是只算了不返回）', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'audit-two-layer.ts')],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('两层次分离审计');
  });
});
