/**
 * P1-T09 的四组**破坏性负控** —— 「基线会因为实现漂移而红」的**实测**。
 *
 * ⚠️ **为什么负控必须改「被审对象本身」**：
 *   负控只改**参考实现**（`tests/baseline/ref-v1.ts`）只能证明「参考公式是承重的」，
 *   **证明不了「真实现被守着」** ⇒ 这里的四组负控改的都是 `src/**` 里的**库实现**：
 *   ① `src/core/scoring.ts` 的五项权重之一；
 *   ② `src/core/decay.ts` 的 `intensity` 时间公式；
 *   ③ `src/core/tokenize.ts` 的 bigram 切法；
 *   ④ `src/store/write.ts` 的 `confidence` 缺省值。
 *   ⇒ 每组都必须让 `tests/baseline/v1-equivalence.test.ts` **变红**，
 *     且**红的原因**必须是目标差异（不是「随便哪条红了就行」）。
 *
 * ⚠️ **为什么在沙箱里改**（而不是在仓库里就地改）：
 *   就地改一旦中途被杀（Ctrl-C / 断电 / 测试崩溃），**污染会留给下一组**，
 *   叠加污染会让结论不可信（QA 之前踩过这个坑）。
 *   ⇒ 本脚本把仓库**整份复制**到 `.tmp/qa/nc-sandbox/`，在**副本**里改、
 *     在**副本**里跑 ⇒ 主工作树**一个字节都不会被改**。
 *   ⇒ 每组跑完仍会**逐字节还原**沙箱里的目标文件并校验（`Buffer.equals`），
 *     保证「还原」这件事本身也被守着。
 *
 * ⚠️ **每组之前先跑一次「未变异的对照组」**：若对照组就不绿 ⇒ 是环境问题，不是变异的效果
 *   ⇒ 脚本会直接判失败（避免把环境噪声当成「负控生效」）。
 *
 * ⚠️ **本脚本**不**进 `pnpm run verify` 链**（它会改文件、跑 5 遍测试，很慢）
 *   ⇒ 手工跑：
 *   ```
 *   node ./node_modules/tsx/dist/cli.mjs tests/baseline/negative-controls/run-negative-controls.ts
 *   ```
 *   ⇒ 产物：`.tmp/qa/negative-controls/report.md`（不入库）。
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════════════════════════════════════════════
// 一、配置
// ═══════════════════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SANDBOX = join(REPO_ROOT, '.tmp', 'qa', 'nc-sandbox');
const REPORT_DIR = join(REPO_ROOT, '.tmp', 'qa', 'negative-controls');
const REPORT_FILE = join(REPORT_DIR, 'report.md');

/** 一组破坏性负控。 */
interface Mutation {
  /** 编号（NC-1 ~ NC-4）。 */
  id: string;
  /** 一句话说明「改了什么」。 */
  title: string;
  /** 被改的文件（相对仓库根）。 */
  file: string;
  /** 原文片段（**必须恰好出现一次** —— 否则说明源码已经变了，负控该更新了）。 */
  from: string;
  /** 变异后的片段。 */
  to: string;
  /** 期望变红的用例**标题**里**必须出现的词（如 `recall` / `get`）。 */
  expectFailing: string[];
  /**
   * 期望「红的理由」里**至少命中一个**的词（差分里的字段名）。
   *
   * ⚠️ **为什么是「至少一个」而不是「全部」**：不同变异落在不同的可观测字段上
   *   （例如权重变异落在 `score` / `intensityPart`，τ 变异落在 `intensity` / `layer`）
   *   ⇒ 写死「全部」会把「变异确实生效」和「变异恰好落在某个字段」耦在一起。
   */
  expectReason: string[];
}

/**
 * 四组负控。
 *
 * ⚠️ **`from` 必须恰好出现一次**：脚本会断言这一点 ⇒ 源码一旦演化，
 *   负控会**响亮地失败**（而不是「悄悄变异了别的地方」）。
 */
const MUTATIONS: Mutation[] = [
  {
    id: 'NC-1',
    title: '改召回打分权重（src/core/scoring.ts 的 `SCORE_WEIGHTS.intensity`：0.3 → 0.35）',
    file: 'src/core/scoring.ts',
    from: '  intensity: 0.3,\n  vectorSim: 0.25,',
    to: '  intensity: 0.35,\n  vectorSim: 0.25,',
    expectFailing: ['recall'],
    expectReason: ['intensityPart', 'score'],
  },
  {
    id: 'NC-2',
    title: '改 intensity 的时间公式（src/core/decay.ts 的 τ：× 1 天 → × 2 天）',
    file: 'src/core/decay.ts',
    from: 'const tauMs = effectiveStability(memory) * MS_PER_DAY;',
    to: 'const tauMs = effectiveStability(memory) * MS_PER_DAY * 2;',
    expectFailing: ['recall', 'get'],
    expectReason: ['intensityPart', 'intensity', 'layer'],
  },
  {
    id: 'NC-3',
    title: '改分词的 bigram 切法（src/core/tokenize.ts 的滑窗：2 字 → 3 字）',
    file: 'src/core/tokenize.ts',
    from: 'out.push(part.slice(index, index + 2));',
    to: 'out.push(part.slice(index, index + 3));',
    expectFailing: ['recall'],
    expectReason: ['hits', 'textPart', 'rawBm25', 'score', 'merged'],
  },
  {
    id: 'NC-4',
    title: '改 write 的默认值（src/store/write.ts 的 `DEFAULT_CONFIDENCE`：0.7 → 0.5)',
    file: 'src/store/write.ts',
    from: 'const DEFAULT_CONFIDENCE = 0.7;',
    to: 'const DEFAULT_CONFIDENCE = 0.5;',
    expectFailing: ['write', 'touch', 'get'],
    expectReason: ['difficulty', 'stabilityDelta', 'initialDifficulty'],
  },
];

/** 被跑的基线测试文件（相对仓库根）。 */
const BASELINE_TEST = 'tests/baseline/v1-equivalence.test.ts';

// ═══════════════════════════════════════════════════════════════════════════
// 二、沙箱
// ═══════════════════════════════════════════════════════════════════════════

/** 需要复制进沙箱的目录 / 文件（够跑基线测试即可）。 */
const SANDBOX_CONTENT = [
  'src',
  'tests',
  'scripts',
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'tsup.config.ts',
];

/**
 * 重建沙箱（**整份复制** + `node_modules` 目录联接）。
 *
 * ⚠️ **为什么用联接而不是再装一次依赖**：`pnpm install` 会写穿主工作树的
 *   `node_modules`（pnpm 的内容寻址存储是全局的）⇒ 联接是唯一安全做法。
 */
function buildSandbox(): void {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  for (const entry of SANDBOX_CONTENT) {
    const source = join(REPO_ROOT, entry);
    if (!existsSync(source)) {
      continue;
    }
    cpSync(source, join(SANDBOX, entry), { recursive: true });
  }
  const realModules = join(REPO_ROOT, 'node_modules');
  const sandboxModules = join(SANDBOX, 'node_modules');
  rmSync(sandboxModules, { recursive: true, force: true });
  symlinkSync(realModules, sandboxModules, 'junction');
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、跑一次基线测试（并解析结果）
// ═══════════════════════════════════════════════════════════════════════════

/** 一次测试运行的解析结果。 */
interface RunResult {
  exitCode: number;
  /** 变红的用例名（含 describe 前缀；只用于报告展示）。 */
  failed: string[];
  /** 变红的用例**标题**（不含 describe 前缀；判定「哪条红了」只用它）。 */
  titles: string[];
  /** 变红的用例的失败信息（拼在一起）。 */
  messages: string;
  /** 原始输出（解析失败时的兜底证据）。 */
  raw: string;
}

/** 在沙箱里跑一次基线测试。 */
function runBaseline(): RunResult {
  const outputFile = join(SANDBOX, '.nc-result.json');
  rmSync(outputFile, { force: true });
  const vitestBin = join(SANDBOX, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(
    process.execPath,
    [vitestBin, 'run', BASELINE_TEST, '--reporter=json', `--outputFile=${outputFile}`],
    { cwd: SANDBOX, encoding: 'utf8' },
  );
  const raw = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  if (!existsSync(outputFile)) {
    return { exitCode: run.status ?? -1, failed: [], titles: [], messages: '', raw };
  }
  const parsed = JSON.parse(readFileSync(outputFile, 'utf8')) as {
    testResults?: Array<{
      assertionResults?: Array<{
        fullName?: string;
        title?: string;
        status?: string;
        failureMessages?: string[];
      }>;
    }>;
  };
  const failed: string[] = [];
  const titles: string[] = [];
  const messages: string[] = [];
  for (const file of parsed.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') {
        // ⚠️ **只记「用例标题」**：`fullName` 含 describe 前缀，而前缀里恰好有
        //   `write / recall / touch / get` 四个词 ⇒ 用 fullName 判「哪条红了」
        //   会**恒真**（每条用例都「包含 recall」）⇒ 负控就变成了摆设。
        titles.push(assertion.title ?? '(未命名)');
        failed.push(assertion.fullName ?? assertion.title ?? '(未命名)');
        messages.push(...(assertion.failureMessages ?? []));
      }
    }
  }
  return { exitCode: run.status ?? -1, failed, titles, messages: messages.join('\n'), raw };
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、变异 + 还原
// ═══════════════════════════════════════════════════════════════════════════

/** 把目标文件恢复成仓库里的原样（**逐字节**）。 */
function restoreTarget(mutation: Mutation): void {
  copyFileSync(join(REPO_ROOT, mutation.file), join(SANDBOX, mutation.file));
}

/** 校验沙箱里的目标文件与仓库里的**逐字节相同**。 */
function verifyRestored(mutation: Mutation): boolean {
  const pristine = readFileSync(join(REPO_ROOT, mutation.file));
  const current = readFileSync(join(SANDBOX, mutation.file));
  return pristine.equals(current);
}

/** 在沙箱里施加变异（并断言「确实只改了这一处、且字节真的变了」）。 */
function applyMutation(mutation: Mutation): void {
  const target = join(SANDBOX, mutation.file);
  const before = readFileSync(target, 'utf8');
  const occurrences = before.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${mutation.id}：变异片段在 ${mutation.file} 里出现 ${occurrences} 次（必须恰好 1 次）` +
        ' ⇒ 源码已经演化，负控需要更新。',
    );
  }
  const after = before.replace(mutation.from, mutation.to);
  if (after === before) {
    throw new Error(`${mutation.id}：变异没有改变任何字节（变异无效 ⇒ 负控是假的）`);
  }
  writeFileSync(target, after, 'utf8');
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、主流程
// ═══════════════════════════════════════════════════════════════════════════

/** 一组负控的实测结果。 */
interface MutationReport {
  mutation: Mutation;
  exitCode: number;
  failed: string[];
  /** 红的理由是否命中目标（用例名 + 差分字段）。 */
  reasonOk: boolean;
  missingReason: string[];
  restored: boolean;
  excerpt: string;
}

function main(): number {
  console.log('▶ 重建沙箱 …');
  buildSandbox();

  console.log('▶ 对照组（未变异）必须全绿 …');
  const control = runBaseline();
  if (control.exitCode !== 0 || control.failed.length > 0) {
    console.error('✗ 对照组不绿 ⇒ 环境问题（不是变异的效果）');
    console.error(control.raw.slice(-4000));
    return 2;
  }
  console.log('  ✔ 对照组全绿');

  const reports: MutationReport[] = [];
  for (const mutation of MUTATIONS) {
    // ── 还原（保证每组都从「干净」开始）──
    restoreTarget(mutation);
    // ── 变异 ──
    applyMutation(mutation);
    // ── 跑（**还原必须保证一定发生**：哪怕跑测试抛异常，污染也不能留给下一组）──
    let result: RunResult;
    try {
      result = runBaseline();
    } finally {
      restoreTarget(mutation);
    }
    // ── 还原校验（**必须逐字节**）──
    const restored = verifyRestored(mutation);

    const missingReason: string[] = [];
    for (const keyword of mutation.expectFailing) {
      if (!result.titles.some((title) => title.includes(keyword))) {
        missingReason.push(`变红的用例标题里没有含「${keyword}」的`);
      }
    }
    if (!mutation.expectReason.some((keyword) => result.messages.includes(keyword))) {
      missingReason.push(
        `失败信息里没有出现任何一个预期关键词（${mutation.expectReason.join(' / ')}）`,
      );
    }
    const reasonOk = missingReason.length === 0 && result.failed.length > 0;
    reports.push({
      mutation,
      exitCode: result.exitCode,
      failed: result.failed,
      reasonOk,
      missingReason,
      restored,
      excerpt: result.messages.slice(0, 1200),
    });
    console.log(
      `  ${reasonOk && restored ? '✔' : '✗'} ${mutation.id}：红 ${result.failed.length} 条` +
        `（退出码 ${result.exitCode}）还原=${restored ? '逐字节一致' : '不一致'}`,
    );
  }

  // ── 报告 ──
  mkdirSync(REPORT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('# P1-T09 · 四组破坏性负控（实测报告）');
  lines.push('');
  lines.push(`- 仓库根：\`${REPO_ROOT}\``);
  lines.push(`- 沙箱：\`${SANDBOX}\`（整份复制 + \`node_modules\` 目录联接）`);
  lines.push(`- 被跑的基线测试：\`${BASELINE_TEST}\``);
  lines.push('- 对照组（未变异）：**全绿**（否则后面的红就没有意义）');
  lines.push('');
  for (const report of reports) {
    lines.push(`## ${report.mutation.id} · ${report.mutation.title}`);
    lines.push('');
    lines.push(`- 改动文件：\`${report.mutation.file}\``);
    lines.push(`- 改动内容：\`${report.mutation.from}\` ⇒ \`${report.mutation.to}\``);
    lines.push(`- 退出码：${report.exitCode}（期望 ≠ 0）`);
    lines.push(`- 变红的用例（${report.failed.length} 条）：`);
    for (const name of report.failed) {
      lines.push(`  - ${name}`);
    }
    lines.push(`- 红的理由是否命中目标：**${report.reasonOk ? '是' : '否'}**`);
    if (report.missingReason.length > 0) {
      lines.push(`  - 未命中：${report.missingReason.join('；')}`);
    }
    lines.push(`- 还原校验（逐字节）：**${report.restored ? '一致' : '不一致'}**`);
    lines.push('');
    lines.push('```');
    lines.push(report.excerpt);
    lines.push('```');
    lines.push('');
  }
  writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8');
  console.log(`▶ 报告：${REPORT_FILE}`);

  const allOk = reports.every((report) => report.reasonOk && report.restored);
  console.log(allOk ? '✔ 四组负控全部符合预期' : '✗ 有负控不符合预期');
  return allOk ? 0 : 1;
}

process.exit(main());
