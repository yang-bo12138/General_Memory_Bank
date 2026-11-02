/**
 * `scripts/audit-tier-qualifiers.ts` 的**负控台** —— 证明那个审计脚本**不是恒绿守卫**。
 *
 * ⚠️ **本文件不带 `#!/usr/bin/env node` shebang**（原因与被测脚本**完全一样**）：
 *   vitest 把模块**转译后内联**执行（不走 Node 的加载器）⇒ ⇒ shebang 会让 `import` 直接抛
 *   `SyntaxError: Invalid or unexpected token` ⇒ ⇒ **凡是「要被单测 import 的脚本」都不能带 shebang**。
 *   ⇒ ⇒ 调用方式一律写 `pnpm run audit:negative-control`。
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
 * · **变异后判定必须变** ⇒ ⇒ **⇒ 它有判别力**；
 * · **变异后仍须「无假阳性」**：只抹掉局部档位时**不该**出现真缺（只该多出提示）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【★ 它为什么必须是「内容锚定」而不是「行号锚定」】★ 这是本文件最重要的一处设计
 *
 * ⚠️ **踩坑记录（本文件的第一版就是这么错的）**：
 *   第一版用**行号**锚定变异（`stripTier(lines, 20, 28)` = 「现状声明」那一段）。
 *   ⇒ ⇒ 那个范围**依赖行号** ⇒ ⇒ **README 一改行号就漂移** ⇒ ⇒ **变异会打在别的地方**
 *     ⇒ ⇒ **负控会「因为打空了而通过」** ⇒ ⇒ **它自己变成恒绿守卫**。
 *   ⇒ ⇒ **更糟的是**：那一段的档位**其实是被第 21 行的「跨档」「三档」撑住的**
 *     ⇒ ⇒ 而「跨档 / 三档 / 两档」**恰恰是「在比几个档位」、不是「这个数属于哪一档」**
 *     ⇒ ⇒ **第一版负控是在给「弱词撑作用域」这个 bug 背书** ⇒ ⇒ **它测的不是它声称测的东西**
 *       （★ 实测证据：把「两档 / 三档 / 跨档」降为弱词后，同一处变异立刻变成「真缺 10」⇒
 *         **同一个变异、两个版本、两个结论** ⇒ ⇒ 旧负控的「通过」是偶然的，不是判据）。
 *
 * ⇒ ⇒ **所以本版改成内容锚定**：**按内容找那张表**（找表头里写着「100 万条实测（」的那一行），
 *   再**按内容**圈出它的数据行 ⇒ ⇒ **README 怎么改行号都不影响它**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【它断言什么】★ 三个断言分别对应三件事（**不是一件事拆成三句**）
 *
 *   负控 A（只抹那张表的**数据行**，**保留表头**）
 *     ⇒ 断言 ①：**真缺必须仍是 0**
 *       （⇒ **表头那一层真的在用** ⇒ 读者看表头就知道这一列是冷盘档 ⇒ **不许误报**）
 *     ⇒ 断言 ②：**自带档位的处数必须不变**
 *       （⇒ 表头在 ⇒ 表里的数**本来就靠表头拿档位** ⇒ 抹掉行内标注**不该改变任何判定**
 *         ⇒ ⇒ **这正是「表头层在起作用」的可观测证据**）
 *   负控 B（连**表头**一起抹掉 ⇒ 那张表的档位**真的全丢了**）
 *     ⇒ 断言 ③：**真缺必须 > 0**，且**每一处真缺都落在那张表内**
 *       （⇒ ⇒ **判别力成立**：表头一没，档位就真的找不到了 ⇒ **脚本能打红**）
 *   负控 C（全文件抹掉）⇒ **真缺必须远多于负控 B** ⇒ ⇒ **局部丢 ≠ 全丢 ⇒ 判定有分辨力**
 *
 * ⚠️ **注意负控 A 与 B 的关系**：A 断言「表头在 ⇒ 不判红」，B 断言「表头没了 ⇒ 判红」
 *   ⇒ ⇒ **它们合起来才证明「表头层」这一层是真的在参与判定**
 *   ⇒ ⇒ **只留一个 ⇒ 就只是「脚本没反应」或「脚本乱反应」，分不出来**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【它自己怎么被反证】★ 2026-11-02 接门禁时补的一条
 *
 *   「负控台全绿」也可能是**负控台自己坏了**（比如它把所有异常都吞掉、只打印不累加）。
 *   ⇒ ⇒ 故本文件把**执行体抽成纯函数** `runNegativeControls(lines, audit, controls)`
 *   ⇒ ⇒ 单测可以**注入一个「恒绿审计」（永远说 missing = 0）**
 *     ⇒ ⇒ **此时负控台必须报失败** ⇒ ⇒ **它是能被反证的**（不是恒绿守卫的第二层）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【怎么用】
 *
 * ```bash
 * pnpm run audit:negative-control
 * ```
 *
 * **退出码**：`0` = 全部负控符合预期；`1` = 有负控不符合预期（⇒ **审计脚本失去判别力或出现假阳性**）。
 *
 * ⚠️ **它只读 `docs/baseline/README.md`、只在内存里做变异** ⇒ **不改磁盘上的任何文件**。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type AuditResult, auditTierQualifiers } from './audit-tier-qualifiers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(REPO_ROOT, 'docs', 'baseline', 'README.md');

/** 所有档位词（强词）⇒ 变异时要把它们替换成「无档位」的占位。 */
const ALL_TIER_WORDS = /冷盘档|部分热档|部分预热档|热盘档|全热档/g;

/** 目标表的内容锚点：那张「现状声明」表的表头里写着这几个字。 */
const TARGET_TABLE_HEADER_NEEDLE = '100 万条实测（';

/** 一次变异的结果：变异后的文档 + 被变异的行下标。 */
export interface Mutation {
  readonly lines: string[];
  readonly indexes: ReadonlySet<number>;
}

/** 一个负控用例。 */
export interface NegativeControl {
  readonly name: string;
  readonly mutate: (lines: readonly string[]) => Mutation;
  /**
   * @param result 变异后的审计结果
   * @param baseline 基线（无变异）的审计结果
   * @param baselineSelfQualified 基线的「自带档位」处数
   * @param mutatedIndexes 被变异的行下标
   */
  readonly expect: (
    result: AuditResult,
    baseline: AuditResult,
    baselineSelfQualified: number,
    mutatedIndexes: ReadonlySet<number>,
  ) => boolean;
  readonly why: string;
  /** 该用例是否**本来就不带变异**（基线用例 ⇒ 不要求「变异生效」）。 */
  readonly expectApplied?: boolean;
}

/**
 * 判定某一行是不是 Markdown 表格的**分隔行**（`|---|---|`）。
 *
 * ⚠️ **必须同时认得 blockquote 里的表格**（`> |---|---|`）—— README 的「现状声明」表就在引用块里。
 */
function isSeparatorRow(line: string): boolean {
  return /^(?:>\s*)*\|[\s|:-]+\|$/.test(line.trim());
}

/**
 * 「自带档位」的处数（判定 − 真缺 − 提示）。
 *
 * ⚠️ **为什么单独算它**：它是「**这一处自带档位限定**」的真正读数
 *   ⇒ ⇒ 局部变异若生效 ⇒ **它必须减少**（那些数不再自带档位了）
 *   ⇒ ⇒ **这是「变异确实打在判据真正在读的那一层」的证据**。
 */
export function selfQualifiedCount(r: {
  counts: { adjudicated: number; missing: number; advisories: number };
}): number {
  return r.counts.adjudicated - r.counts.missing - r.counts.advisories;
}

/**
 * **按内容**找到目标表（表头行 + 它的数据行）。
 *
 * ⚠️ **为什么必须按内容**：行号会随 README 的任何改动漂移 ⇒ ⇒ 负控会打空 ⇒ ⇒ 恒绿。
 *
 * @throws 找不到目标表时抛出（⇒ **绝不允许「打空」变成「通过」**）
 */
function findTargetTable(lines: readonly string[]): { headerIndex: number; rowIndexes: number[] } {
  const headerIndex = lines.findIndex(
    (line) =>
      line.includes(TARGET_TABLE_HEADER_NEEDLE) &&
      /^\s*>?\s*\|/.test(line) &&
      !isSeparatorRow(line),
  );
  if (headerIndex < 0) {
    throw new Error(
      `★ 负控定位失败：找不到表头含「${TARGET_TABLE_HEADER_NEEDLE}」的表格 ⇒ ⇒ **拒绝在「变异打空」的情况下判通过**`,
    );
  }
  const rowIndexes: number[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\s*>?\s*\|/.test(line)) break;
    if (isSeparatorRow(line)) continue;
    rowIndexes.push(i);
  }
  if (rowIndexes.length === 0) {
    throw new Error('★ 负控定位失败：目标表没有数据行 ⇒ ⇒ **拒绝在「变异打空」的情况下判通过**');
  }
  return { headerIndex, rowIndexes };
}

/**
 * 把指定行里的所有档位词抹掉（模拟「档位真丢了」）。
 */
function stripTierAt(lines: readonly string[], indexes: readonly number[]): Mutation {
  const out = lines.slice();
  for (const index of indexes) {
    out[index] = (out[index] ?? '').replace(ALL_TIER_WORDS, '档位未标');
  }
  return { lines: out, indexes: new Set(indexes) };
}

/** 负控用例表（**写死为常量** ⇒ 纪律 1「分母写死」）。 */
export const CONTROLS: readonly NegativeControl[] = [
  {
    name: '原始（无变异）',
    mutate: (lines) => ({ lines: lines.slice(), indexes: new Set<number>() }),
    expect: (r) => r.counts.missing === 0,
    why: '基线：当前文档没有「档位真丢了」的数 ⇒ 真缺必须是 0',
    // ★ 基线用例**本来就不带变异** ⇒ 不要求「变异生效」
    expectApplied: false,
  },
  {
    name: '负控 A：只抹掉「现状声明」那张表的**数据行**（表头留着）',
    mutate: (lines) => {
      const { rowIndexes } = findTargetTable(lines);
      return stripTierAt(lines, rowIndexes);
    },
    expect: (r, _baseline, baselineSelfQualified) =>
      // ★ 断言 ①：表头还在 ⇒ **不许出现真缺**（⇒ 表头层在用 ⇒ 不误报）
      r.counts.missing === 0 &&
      // ★ 断言 ②：表头在 ⇒ 表里的数**本来就靠表头拿档位** ⇒ **自带档位的处数必须不变**
      //   （⇒ 若它变了 ⇒ 说明那些数其实是靠**行内标注**撑着的 ⇒ **表头层根本没生效**）
      selfQualifiedCount(r) === baselineSelfQualified,
    why:
      '只抹行内标注、**表头留着** ⇒ **真缺必须仍是 0**（读者看表头就知道这一列是冷盘档）' +
      '⇒ 且**自带档位的处数必须不变**（那些数本来就靠表头拿档位 ⇒ 抹掉行内标注不该改变判定）' +
      '⇒ ⇒ ⇒ **⇒ 这证明「表头层」真的在参与判定，且不误报**',
  },
  {
    name: '负控 B：连「现状声明」那张表的**表头**一起抹掉（那张表的档位全丢）',
    mutate: (lines) => {
      const { headerIndex, rowIndexes } = findTargetTable(lines);
      return stripTierAt(lines, [headerIndex, ...rowIndexes]);
    },
    expect: (r, _baseline, _baselineSelfQualified, mutatedIndexes) =>
      // ★ 断言 ③：**真缺必须 > 0**（⇒ 表头一没，档位就真的找不到了 ⇒ **脚本能打红**）
      r.counts.missing > 0 &&
      // ⇒ 且**每一处真缺都落在被变异的那几行里**（⇒ 不是「到处乱判红」）
      r.gaps.every((gap) => mutatedIndexes.has(gap.line - 1)),
    why:
      '表头 + 数据行的档位**全丢** ⇒ **必须出现真缺**（⇒ ⇒ **脚本能打红，不是恒绿守卫**）' +
      '⇒ 且真缺必须**只落在被变异的那几行里**（⇒ ⇒ 不是「到处乱判红」）',
  },
  {
    name: '负控 C：全文件抹掉所有档位词',
    mutate: (lines) => ({
      lines: lines.map((line) => line.replace(ALL_TIER_WORDS, '档位未标')),
      indexes: new Set(lines.map((_line, index) => index)),
    }),
    expect: (r, baseline) => r.counts.missing > baseline.counts.missing,
    why:
      '全文件都丢 ⇒ **真缺必须远多于负控 B**（局部丢 ≠ 全丢）' +
      '⇒ ⇒ ⇒ **⇒ 这证明判定有分辨力，不是「非红即绿」**',
  },
];

/** 单个负控用例的执行结果。 */
export interface ControlOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly applied: boolean;
  /** 该用例失败时的原因（定位失败 ⇒ 带异常文本）；成功时为 `null`。 */
  readonly failureReason: string | null;
  /** 变异后的读数（一行，供人核对）。 */
  readonly observed: string;
  readonly why: string;
}

/** 一次负控台执行的完整结果（**纯数据** ⇒ 便于单测断言）。 */
export interface NegativeControlReport {
  readonly target: string;
  readonly baselineLine: string;
  readonly outcomes: readonly ControlOutcome[];
  readonly failures: number;
}

/**
 * **纯函数**：跑一遍全部负控用例。
 *
 * ⚠️ **审计函数与用例表都可注入** —— 单测用「恒绿审计」注入 ⇒ 证明**负控台自己能打红**。
 *
 * @param lines 目标文档按行切分
 * @param audit 被测审计函数
 * @param controls 负控用例表
 * @param target 目标路径（只用于报告）
 */
export function runNegativeControls(
  lines: readonly string[],
  audit: (lines: readonly string[]) => AuditResult = auditTierQualifiers,
  controls: readonly NegativeControl[] = CONTROLS,
  target: string = TARGET,
): NegativeControlReport {
  const base = lines.slice();
  const baseline = audit(base);
  const baselineSelfQualified = selfQualifiedCount(baseline);
  const outcomes: ControlOutcome[] = [];

  for (const control of controls) {
    let mutated: Mutation;
    try {
      mutated = control.mutate(base);
    } catch (error) {
      outcomes.push({
        name: control.name,
        ok: false,
        applied: false,
        failureReason: `★ 变异定位失败：${error instanceof Error ? error.message : String(error)}`,
        observed: '——（变异未执行）',
        why: control.why,
      });
      continue;
    }
    const applied = mutated.lines.join('\n') !== base.join('\n');
    const result = audit(mutated.lines);
    const appliedOk = control.expectApplied === false ? true : applied;
    const ok =
      appliedOk && control.expect(result, baseline, baselineSelfQualified, mutated.indexes);
    outcomes.push({
      name: control.name,
      ok,
      applied,
      failureReason: ok ? null : appliedOk ? '断言不符合预期' : '★ 变异未生效（断言等于空跑）',
      observed:
        `变异生效=${applied ? '是' : '★否'} · 扫 ${result.counts.scanned}` +
        ` · 自带档位 ${selfQualifiedCount(result)} · 真缺 ${result.counts.missing}` +
        ` · 提示 ${result.counts.advisories} · 退出码 ${result.counts.missing === 0 ? 0 : 1}`,
      why: control.why,
    });
  }

  return {
    target,
    baselineLine:
      `基线：扫 ${baseline.counts.scanned} · 自带档位 ${baselineSelfQualified}` +
      ` · 真缺 ${baseline.counts.missing} · 提示 ${baseline.counts.advisories}`,
    outcomes,
    failures: outcomes.filter((outcome) => !outcome.ok).length,
  };
}

/** **纯函数**：把负控台结果渲染成报告文本（**不含时间戳** ⇒ 幂等）。 */
export function renderNegativeControlReport(report: NegativeControlReport): string {
  const out: string[] = [];
  out.push('════ 档位限定审计脚本 · 负控台 ════');
  out.push(`目标：${report.target}`);
  out.push(report.baselineLine);
  out.push('');
  for (const outcome of report.outcomes) {
    out.push(`${outcome.ok ? '✅' : '❌'} ${outcome.name}`);
    out.push(`   ${outcome.observed}`);
    if (outcome.failureReason !== null) out.push(`   ${outcome.failureReason}`);
    out.push(`   预期：${outcome.why}`);
  }
  out.push('');
  out.push(
    report.failures === 0
      ? '✅ 全部负控符合预期 ⇒ 审计脚本**有判别力**（不是恒绿守卫）'
      : `❌ ${report.failures} 个负控不符合预期 ⇒ ⇒ **审计脚本失去判别力或出现假阳性 ⇒ 不可当证据用**`,
  );
  return out.join('\n');
}

/** CLI 薄壳。 */
function main(): void {
  const lines = readFileSync(TARGET, 'utf8').split(/\r?\n/);
  const report = runNegativeControls(lines, auditTierQualifiers, CONTROLS, TARGET);
  process.stdout.write(`${renderNegativeControlReport(report)}\n`);
  process.exitCode = report.failures === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
