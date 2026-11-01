#!/usr/bin/env node
/**
 * `scripts/audit-tier-qualifiers.mjs` 的**负控台** —— 证明那个审计脚本**不是恒绿守卫**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【为什么需要它】
 *
 * 一个只会输出「通过」的审计脚本**等于没有**：它既可能真的没问题，也可能是**判据坏了**。
 * ⇒ ⇒ **仓库的「新增门禁的做法」第 3 条就写着：「单测**必须包含一个反例**（证明它真的能发现不一致）」**
 * ⇒ ⇒ **本脚本就是那个反例的可执行版本**（且**不依赖 `tests/**`** ⇒ 可单独跑）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【它做什么】
 *
 * 对 `docs/baseline/README.md` 依次施加若干**人为变异**，每个变异都**确实生效**（脚本会核对），
 * 然后比对审计脚本的判定：
 * · **变异后判定必须变**（真缺数 / 提示数 / 退出码至少有一项变）⇒ ⇒ **⇒ 它有判别力**；
 * · **变异后仍须「无假阳性」**：只抹掉局部档位时**不该**出现真缺（只该多出提示）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【怎么用】
 *
 * ```bash
 * node scripts/audit-tier-qualifiers.negative-control.mjs
 * ```
 *
 * **退出码**：`0` = 全部负控符合预期；`1` = 有负控不符合预期（⇒ **审计脚本失去判别力或出现假阳性**）。
 *
 * ⚠️ **它只读 `docs/baseline/README.md`、只在内存里做变异** ⇒ **不改磁盘上的任何文件**。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { auditTierQualifiers } from './audit-tier-qualifiers.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(REPO_ROOT, 'docs', 'baseline', 'README.md');

/** 所有档位词（强词）⇒ 变异时要把它们替换成「无档位」的占位。 */
const ALL_TIER_WORDS = /冷盘档|部分热档|部分预热档|热盘档|全热档/g;

/**
 * 把指定行区间里的所有档位词抹掉（模拟「档位真丢了」）。
 *
 * @param {readonly string[]} lines
 * @param {number} from 行号（1 起，含）
 * @param {number} to 行号（含）
 * @returns {string[]}
 */
function stripTier(lines, from, to) {
  const out = lines.slice();
  for (let i = from - 1; i < to && i < out.length; i += 1) {
    out[i] = (out[i] ?? '').replace(ALL_TIER_WORDS, '档位未标');
  }
  return out;
}

/**
 * 一个负控用例。
 *
 * @typedef {{
 *   name: string,
 *   mutate: (lines: readonly string[]) => string[],
 *   expect: (r: { counts: { missing: number, advisories: number } }) => boolean,
 *   why: string,
 *   expectApplied?: boolean,
 * }} NegativeControl
 */

/** @type {readonly NegativeControl[]} */
const CONTROLS = [
  {
    name: '原始（无变异）',
    mutate: (lines) => lines.slice(),
    expect: (r) => r.counts.missing === 0,
    why: '基线：当前文档没有「档位真丢了」的数 ⇒ 真缺必须是 0',
    // ★ 基线用例**本来就不带变异** ⇒ 不要求「变异生效」
    expectApplied: false,
  },
  {
    name: '负控 A：只抹掉「现状声明」表那一段的档位（局部）',
    mutate: (lines) => stripTier(lines, 20, 28),
    expect: (r) => r.counts.missing === 0 && r.counts.advisories > 26,
    why:
      '局部抹掉 ⇒ **不该**出现真缺（上下文与小节标题仍能给出档位）' +
      '⇒ 但**提示数必须增加** ⇒ ⇒ ⇒ **⇒ 这证明脚本看得见「档位标得不够近」**',
  },
  {
    name: '负控 B：全文件抹掉所有档位词',
    mutate: (lines) => stripTier(lines, 1, lines.length),
    expect: (r) => r.counts.missing > 0,
    why: '⇒ **必须出现真缺且退出码非 0** ⇒ ⇒ ⇒ **⇒ 这证明脚本能打红，不是恒绿守卫**',
  },
];

/** CLI 薄壳。 */
function main() {
  const base = readFileSync(TARGET, 'utf8').split(/\r?\n/);
  const baseline = auditTierQualifiers(base);

  console.log('════ 档位限定审计脚本 · 负控台 ════');
  console.log(`目标：${TARGET}`);
  console.log(
    `基线：扫 ${baseline.counts.scanned} · 真缺 ${baseline.counts.missing} · 提示 ${baseline.counts.advisories}`,
  );
  console.log('');

  let failures = 0;
  for (const control of CONTROLS) {
    const mutated = control.mutate(base);
    const applied = mutated.join('\n') !== base.join('\n');
    const result = auditTierQualifiers(mutated);
    const appliedOk = control.expectApplied === false ? true : applied;
    const ok = appliedOk && control.expect(result);
    if (!ok) failures += 1;
    console.log(`${ok ? '✅' : '❌'} ${control.name}`);
    console.log(
      `   变异生效=${applied ? '是' : '★否'} · 扫 ${result.counts.scanned} · 真缺 ${result.counts.missing} · 提示 ${result.counts.advisories} · 退出码 ${result.counts.missing === 0 ? 0 : 1}`,
    );
    console.log(`   预期：${control.why}`);
  }

  console.log('');
  console.log(
    failures === 0
      ? '✅ 全部负控符合预期 ⇒ 审计脚本**有判别力**（不是恒绿守卫）'
      : `❌ ${failures} 个负控不符合预期 ⇒ ⇒ **审计脚本失去判别力或出现假阳性 ⇒ 不可当证据用**`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
