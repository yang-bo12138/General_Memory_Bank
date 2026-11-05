/**
 * `scripts/check-credential-hygiene.ts` —— 全仓「机器凭据」悬空体检（只读 · 可复跑）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【它查什么】
 * ★ 文档 / 代码注释里声称「这一条由某个脚本 / 机器凭据保证」⇒ ⇒ 而那个凭据
 *   **路径不存在**、或**不在版本控制内**（⇒ 提交态的机器够不着它）⇒ ⇒
 *   ⇒ 「说的人以为有机器守着，实际那台机器不在」。
 *
 * 【三档判据（★ 与主理人给的定义逐字对应）】
 *   A · 悬空      —— 路径在仓库根不存在，或命令在 package.json scripts 里没有
 *   B · 存在但不在版本控制内 —— 路径真实存在、也跑得起来，但它不在 git 里
 *                              ⇒ 机器守卫覆盖不到它 ⇒ 只靠人处置
 *   C · 完好      —— 路径存在 + 在版本控制内 + 入口可跑
 *   D · 非凭据声明 —— 散文 / 模板 / 版本号片段 / 提案（详见下方三条豁免）
 *
 * 【搜索式（★ 让下一个人能复核）】
 *   声明族（宽式正则，★ 不许精确串）：
 *       保证|守住|凭据|守卫|逐字|逐位|机器|有牙|对表|拦|校验|核对|判红
 *   路径族：
 *       (?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|mjs|cjs|js|md|json|sh)
 *   命令族：
 *       \b(?:pnpm|npm|yarn)\s+(?:run|exec)\b
 *
 * 【三条豁免（★ 每一条都有真实假阳性做证据 ⇒ 不是拍脑袋）】
 *   R1 · 声明同格 —— 凭据必须与声明词在【同一个 `|` 格】内
 *        （表格行里别处的文件清单不算凭据声明）
 *   R2 · 提案不算凭据 —— 格内含「建议 / 拟新增 / 待新增 / 尚未 / 要不要」
 *        ⇒ 那条路径【本就不该存在】
 *   R3 · 散文 / 模板不算 —— 裸命令后紧跟中文、或带 `<名>` 占位、或形如 `v12.16.1`
 *
 * 【★ 只读】本脚本【只读仓库】⇒ 不写任何仓库内文件；`--self-test` 的夹具写在
 *   系统临时目录、跑完即删 ⇒ ⇒ 仓库零污染。
 *
 * 【★ 不挂进 `verify` 链】挂链 = 改 CI 行为 = 判据升级 ⇒ ⇒ 要走裁决。
 *   ⇒ 手动跑：`pnpm exec tsx scripts/check-credential-hygiene.ts`
 *   ⇒ 自测 ：`pnpm exec tsx scripts/check-credential-hygiene.ts --self-test`
 *
 * 【退出码】0 = 无 A 档 · 1 = 有 A 档（悬空凭据）· 2 = 用法 / IO 错
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ── 判据常量（★ 全部导出，便于下游复用而不必重写一遍）────────────────────────

/** 三档 + D（非凭据声明）。 */
export type Verdict = 'A' | 'B' | 'C' | 'D';

/** 声明族（宽式）。 */
export const CLAIM_PATTERN = /保证|守住|凭据|守卫|逐字|逐位|机器|有牙|对表|拦|校验|核对|判红/;

/** 路径族。 */
export const PATH_PATTERN =
  /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|mjs|cjs|js|md|json|sh)(?![A-Za-z0-9_.-])/g;

/** 花括号路径族（`src/store/{a,b}.ts`）⇒ 展开后逐个判。 */
export const BRACE_PATTERN =
  /(?:[A-Za-z0-9_.-]+\/)*\{[A-Za-z0-9_.,-]+\}\.(?:ts|mjs|cjs|js|md|json|sh)\b/g;

/** 绝对路径族（带盘符 / 根斜杠）⇒ ★ 必须【原样】判存在性，不能剥掉盘符当仓库相对路径。 */
export const ABSOLUTE_PATTERN = /[A-Za-z]:[\\/](?:[^\s`|"']+)/g;
/** 命令族。 */
export const COMMAND_PATTERN = /\b(?:pnpm|npm|yarn)\s+(?:run|exec)\b/;

/** R2 · 提案词。 */
const PROPOSAL_PATTERN = /建议|拟新增|待新增|尚未|要不要|可否/;

/** 仓库外、但【有意为之】的过程留档目录（★ 报 B 档，不报 A 档）。 */
const EXTERNAL_ARCHIVE_DIRS = ['handover'] as const;

/** 散文载体（设计稿 / ADR / 交接稿 / README / 各类 notes）。 */
const PROSE_DIRS = ['docs'] as const;

/** 代码载体（注释 / JSDoc）。 */
const CODE_DIRS = ['src', 'bench', 'scripts', 'tests', 'viewer', 'mcp'] as const;

/** 一条凭据候选。 */
export interface Credential {
  /** 原文里的字面量。 */
  readonly raw: string;
  /** 判定用：路径 / run / exec / bare。 */
  readonly kind: 'path' | 'run' | 'exec' | 'bare' | 'template' | 'absolute';
  /** kind 为 run / bare 时的 script 名。 */
  readonly scriptName?: string;
  /** kind 为 exec 时的参数串。 */
  readonly args?: string;
}

/** 文件系统探针（★ 抽出来是为了让 `--self-test` 能注入合成探针 ⇒ 不许空转）。 */
export interface Probe {
  exists(relPath: string): boolean;
  tracked(relPath: string): boolean;
  hasScript(name: string): boolean;
  /** ★ D1 · 路径简写：仓库里是否有以 `/<relPath>` 结尾的真实路径（例：`store/merge.ts` ⇒ `src/store/merge.ts`）。 */
  shorthandOf?(relPath: string): string | undefined;
  /** ★ 绝对路径的存在性（默认用 fs；自测可注入）。 */
  absoluteExists?(absPath: string): boolean;
}

/** 一条体检结果。 */
export interface Finding {
  /** 仓库相对路径（用 `/`）。 */
  readonly file: string;
  /** 行号（1 起）。 */
  readonly line: number;
  readonly verdict: Verdict;
  readonly credential: string;
  readonly reason: string;
  /** 声明所在格（或该行）的原文节选。 */
  readonly excerpt: string;
}

// ── 工具 ───────────────────────────────────────────────────────────────────

/** 把 `src/store/{a,b}.ts` 展开成两条。 */
export function expandBrace(text: string): string[] {
  const out: string[] = [];
  for (const match of text.match(BRACE_PATTERN) ?? []) {
    const parts = match.split(/[{}]/);
    if (parts.length < 3) continue;
    for (const option of (parts[1] ?? '').split(',')) {
      out.push(`${parts[0] ?? ''}${option}${parts[2] ?? ''}`);
    }
  }
  return out;
}

/** 是不是中文（★ 用于 R3：裸命令后紧跟中文 ⇒ 是散文不是命令）。 */
function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

/**
 * 从一个「格」里抽出凭据候选。
 *
 * ★ R1 在【调用方】生效（本函数只看格内内容）；本函数负责 R3 的散文过滤。
 */
export function extractCredentials(cell: string): Credential[] {
  const out: Credential[] = [];
  const execMatches = [...cell.matchAll(/\b(?:pnpm|npm|yarn)\s+exec\s+([^|`]+)/g)];
  const runMatches = [...cell.matchAll(/\b(?:pnpm|npm|yarn)\s+run\s+([A-Za-z0-9:_-]+)/g)];

  for (const match of execMatches) {
    out.push({ raw: match[0].trim(), kind: 'exec', args: (match[1] ?? '').trim() });
  }
  for (const match of runMatches) {
    out.push({ raw: match[0].trim(), kind: 'run', scriptName: match[1] ?? '' });
  }
  // ★ R3b · 模板命令：`pnpm run <名>` ⇒ 占位符 ⇒ 不是可执行凭据
  for (const match of cell.matchAll(/\b(?:pnpm|npm|yarn)\s+(?:run|exec)\s+<[^>]+>/g)) {
    out.push({ raw: match[0].trim(), kind: 'template' });
  }

  const consumed = [...execMatches, ...runMatches].map((m) => m[0]);
  for (const match of cell.matchAll(/\b(?:pnpm|npm|yarn)\s+([A-Za-z0-9:_-]+)/g)) {
    if (consumed.some((c) => c.includes(match[0]))) continue;
    const after = cell.slice(match.index + match[0].length);
    // R3：散文（「npm script 名拼文件名」）、版本号片段（「using pnpm v12.16.1」）
    if (hasChinese(after.trimStart().slice(0, 1))) continue;
    if (/^v\d/.test(match[1] ?? '')) continue;
    out.push({ raw: match[0].trim(), kind: 'bare', scriptName: match[1] ?? '' });
  }

  // ★ 绝对路径（含盘符）⇒ 原样保留（★ 必须在 PATH_PATTERN 之前算好：它会覆盖相对片段）
  const absoluteMatches = cell.match(ABSOLUTE_PATTERN) ?? [];

  for (const match of cell.match(PATH_PATTERN) ?? []) {
    if (consumed.some((c) => c.includes(match))) continue;
    // ★ 已被绝对路径覆盖的相对片段 ⇒ 不重复报（否则会把仓外绝对路径误判成「仓库根不存在」）
    if (absoluteMatches.some((abs) => abs.includes(match))) continue;
    out.push({ raw: match, kind: 'path' });
  }
  for (const match of absoluteMatches) {
    out.push({ raw: match, kind: 'absolute' });
  }
  for (const expanded of expandBrace(cell)) {
    out.push({ raw: expanded, kind: 'path' });
  }
  return out;
}

// ── 分类 ───────────────────────────────────────────────────────────────────

/** 把仓库相对路径规范化成 `/` 分隔。 */
function toPosix(relPath: string): string {
  return relPath.split(sep).join('/');
}

/** 判断某路径是不是「仓库外 · 过程留档 · 有意为之」的那类。 */
function externalArchiveHit(root: string, relPath: string): string | undefined {
  const first = relPath.split('/')[0] ?? '';
  if (!(EXTERNAL_ARCHIVE_DIRS as readonly string[]).includes(first)) return undefined;
  const candidate = resolve(root, '..', relPath);
  return existsSync(candidate) ? relPath : undefined;
}

/**
 * 三档判定。
 *
 * ★ `probe` 可注入 ⇒ `--self-test` 能用合成探针机械证明「三档真的分得开」。
 */
export function classify(
  credential: Credential,
  probe: Probe,
  context: { readonly root: string; readonly isProposal: boolean },
): { readonly verdict: Verdict; readonly reason: string } {
  // ★ R3b · 模板命令（`pnpm run <名>`）⇒ 不是凭据
  if (credential.kind === 'template') {
    return { verdict: 'D', reason: 'R3b · 占位符模板命令 ⇒ 不是可执行凭据' };
  }

  if (credential.kind === 'absolute') {
    const abs = credential.raw;
    const there = probe.absoluteExists?.(abs) ?? existsSync(abs);
    if (there) {
      return {
        verdict: 'B',
        reason: `仓库外的绝对路径（${abs}）· 真实存在 · 不在版本控制内 ⇒ 机器够不着`,
      };
    }
    return { verdict: 'A', reason: `绝对路径不存在（${abs}）` };
  }

  if (credential.kind === 'run' || credential.kind === 'bare') {
    const name = credential.scriptName ?? '';
    if (probe.hasScript(name)) {
      return { verdict: 'C', reason: `package.json scripts 有 "${name}" ⇒ 入口可跑` };
    }
    if (credential.kind === 'bare' && ['exec', 'dlx', 'install', 'i', 'add'].includes(name)) {
      return { verdict: 'C', reason: `"pnpm ${name}" 是 pnpm 合法子命令（无需登记进 scripts）` };
    }
    // ★ R3c · 裸 `pnpm run` / `npm script`（无脚本名）⇒ 列出脚本的子命令 / 散文，不是凭据
    if (credential.kind === 'bare' && ['run', 'script', 'scripts', 'test'].includes(name)) {
      return { verdict: 'D', reason: `R3c · 裸 "${name}" 没有具体脚本名 ⇒ 不是可执行凭据` };
    }
    if (context.isProposal) {
      return { verdict: 'D', reason: 'R2 · 提案句 ⇒ 这条命令本就不该存在' };
    }
    return { verdict: 'A', reason: `package.json scripts 无 "${name}" ⇒ 入口跑不到` };
  }

  if (credential.kind === 'exec') {
    const args = credential.args ?? '';
    const pathInArgs = (args.match(PATH_PATTERN) ?? [])[0];
    if (pathInArgs !== undefined) {
      return classify({ raw: pathInArgs, kind: 'path' }, probe, context);
    }
    const binary = args.split(/\s+/)[0] ?? '';
    if (existsSync(join(context.root, 'node_modules', '.bin', binary))) {
      return { verdict: 'C', reason: `node_modules/.bin/${binary} 存在 ⇒ 入口可跑` };
    }
    return {
      verdict: 'A',
      reason: `pnpm exec 的 "${binary}" 不在 scripts、也不在 node_modules/.bin ⇒ 跑不到`,
    };
  }

  const relPath = toPosix(credential.raw).replace(/^\.\//, '');

  // ★ 仓库外 · 过程留档（★ 主理人明确要求：报 B 档、且注明「有意为之」）
  const external = externalArchiveHit(context.root, relPath);
  if (external !== undefined) {
    return { verdict: 'B', reason: '仓库外 · 过程留档 · 有意为之（不在版本控制内 ⇒ 机器够不着）' };
  }

  if (!probe.exists(relPath)) {
    if (context.isProposal) {
      return { verdict: 'D', reason: 'R2 · 提案句 ⇒ 这条路径本就不该存在' };
    }
    // ★ D1 · 路径简写（文档省了目录前缀）
    const shorthand = probe.shorthandOf?.(relPath);
    if (shorthand !== undefined) {
      return {
        verdict: 'D',
        reason: `R-D1 · 路径简写：仓库里真实路径是 "${shorthand}"（文档省了前缀）`,
      };
    }
    return { verdict: 'A', reason: `路径在仓库根不存在（${relPath}）` };
  }
  if (!probe.tracked(relPath)) {
    return { verdict: 'B', reason: `路径存在但不在版本控制内（git ls-files 无 ${relPath}）` };
  }
  return { verdict: 'C', reason: `路径存在 + 在版本控制内 + 入口可跑（${relPath}）` };
}

// ── 扫描 ───────────────────────────────────────────────────────────────────

/** 递归列目录下的文件。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 扫一个文件：按 `|` 切格 ⇒ 只在【含声明词且含凭据】的格里判定（R1）。 */
export function scanText(text: string, file: string, probe: Probe, root: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!CLAIM_PATTERN.test(line)) continue;
    const cells = line.split('|');
    for (const cell of cells) {
      if (!CLAIM_PATTERN.test(cell)) continue;
      const isProposal = PROPOSAL_PATTERN.test(cell);
      for (const credential of extractCredentials(cell)) {
        const { verdict, reason } = classify(credential, probe, { root, isProposal });
        findings.push({
          file,
          line: index + 1,
          verdict,
          credential: credential.raw,
          reason,
          excerpt: cell.trim().slice(0, 120),
        });
      }
    }
  }
  return findings;
}

/** 建默认探针（真文件系统 + 真 git + 真 package.json）。 */
export function makeProbe(root: string): Probe {
  let trackedSet: Set<string>;
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files'], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    trackedSet = new Set(
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => toPosix(line.trim())),
    );
  } catch {
    trackedSet = new Set();
  }

  let scriptNames: Set<string>;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    scriptNames = new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    scriptNames = new Set();
  }

  return {
    exists: (relPath) => existsSync(join(root, relPath)),
    tracked: (relPath) => trackedSet.has(toPosix(relPath)),
    hasScript: (name) => scriptNames.has(name),
    shorthandOf: (relPath) => {
      const suffix = `/${toPosix(relPath)}`;
      for (const tracked of trackedSet) {
        if (tracked.endsWith(suffix)) return tracked;
      }
      return undefined;
    },
  };
}

/** 扫整棵树。 */
export function scanTree(root: string, probe: Probe): Finding[] {
  const findings: Finding[] = [];
  const proseFiles = PROSE_DIRS.flatMap((dir) => {
    const full = join(root, dir);
    if (!existsSync(full)) return [];
    return walk(full).filter((file) => file.endsWith('.md'));
  });
  const codeFiles = CODE_DIRS.flatMap((dir) => {
    const full = join(root, dir);
    if (!existsSync(full)) return [];
    return walk(full).filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));
  });

  for (const file of [...proseFiles, ...codeFiles]) {
    const relFile = toPosix(relative(root, file));
    // ★ 跳过本脚本自己 ⇒ 它的自测夹具路径是故意【不存在】的 ⇒ 否则会把自己报成 A
    if (relFile === 'scripts/check-credential-hygiene.ts') continue;
    findings.push(...scanText(readFileSync(file, 'utf8'), relFile, probe, root));
  }
  return findings;
}

// ── 报告 ───────────────────────────────────────────────────────────────────

/** 打印报告。 */
export function printReport(findings: Finding[], root: string): void {
  const byVerdict = (verdict: Verdict): Finding[] => findings.filter((f) => f.verdict === verdict);
  const a = byVerdict('A');
  const b = byVerdict('B');
  const c = byVerdict('C');
  const d = byVerdict('D');

  process.stdout.write(`仓库根：${root}\n`);
  process.stdout.write(`凭据条目总数：${findings.length}\n`);
  process.stdout.write(
    `  A(悬空 · 路径不存在或跑不到)=${a.length}  B(存在但不在版本控制内)=${b.length}  ` +
      `C(完好)=${c.length}  D(非凭据声明)=${d.length}\n\n`,
  );

  const dump = (title: string, items: Finding[]): void => {
    if (items.length === 0) return;
    process.stdout.write(`── ${title}（${items.length}）──\n`);
    for (const item of items) {
      process.stdout.write(`  ${item.file}:${item.line}  凭据=${item.credential}\n`);
      process.stdout.write(`      原文：${item.excerpt}\n`);
      process.stdout.write(`      判定：${item.verdict} · ${item.reason}\n`);
    }
    process.stdout.write('\n');
  };

  dump('A · 悬空（★ 说的人以为有机器守、实际没有）', a);
  dump('B · 存在但不在版本控制内（★ 提交态的机器够不着）', b);
  dump('D · 非凭据声明（★ 散文 / 模板 / 提案）', d);
  process.stdout.write(`C · 完好 ${c.length} 条（不逐条打印；抽样见下）\n`);
  for (const item of c.slice(0, 10)) {
    process.stdout.write(`  ${item.file}:${item.line}  ${item.credential}  ← ${item.reason}\n`);
  }
}

// ── 自测（★ 必须有负控 ⇒ 不许是恒绿守卫）─────────────────────────────────

/** 断言。 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`✗ ${message}`);
  process.stdout.write(`  ✓ ${message}\n`);
}

/** 合成探针（★ 不碰真文件系统 ⇒ 三档可机械分离）。 */
function syntheticProbe(): Probe {
  const existing = new Set(['scripts/exists-tracked.ts', 'scripts/exists-untracked.ts']);
  const tracked = new Set(['scripts/exists-tracked.ts']);
  return {
    exists: (relPath) => existing.has(relPath),
    tracked: (relPath) => tracked.has(relPath),
    hasScript: (name) => name === 'script-exists',
  };
}

/** 自测主体。 */
export function runSelfTest(root: string): number {
  process.stdout.write('── check-credential-hygiene · 自测 ──\n');
  try {
    // ① 正控：存在 + 已入版本控制 ⇒ C
    {
      const probe = syntheticProbe();
      const result = classify({ raw: 'scripts/exists-tracked.ts', kind: 'path' }, probe, {
        root,
        isProposal: false,
      });
      assert(result.verdict === 'C', `正控 · 存在且已跟踪 ⇒ 判 C（实测 ${result.verdict}）`);
    }
    // ② 负控 A：路径不存在 ⇒ A
    {
      const probe = syntheticProbe();
      const fake = `scripts/__qa-must-not-exist-${'a'.repeat(6)}.ts`;
      const result = classify({ raw: fake, kind: 'path' }, probe, {
        root,
        isProposal: false,
      });
      assert(result.verdict === 'A', `负控 A · 假路径 ⇒ 判 A（实测 ${result.verdict}）`);
    }
    // ③ 负控 B：存在但不在版本控制内 ⇒ B
    {
      const probe = syntheticProbe();
      const result = classify({ raw: 'scripts/exists-untracked.ts', kind: 'path' }, probe, {
        root,
        isProposal: false,
      });
      assert(result.verdict === 'B', `负控 B · 存在但未跟踪 ⇒ 判 B（实测 ${result.verdict}）`);
    }
    // ④ 负控 · 命令：scripts 里没有 ⇒ A
    {
      const probe = syntheticProbe();
      const result = classify(
        { raw: 'pnpm run no-such-script', kind: 'run', scriptName: 'no-such-script' },
        probe,
        {
          root,
          isProposal: false,
        },
      );
      assert(result.verdict === 'A', `负控 · 不存在的 script 名 ⇒ 判 A（实测 ${result.verdict}）`);
    }
    // ⑤ 负控 · 命令：存在 ⇒ C
    {
      const probe = syntheticProbe();
      const result = classify(
        { raw: 'pnpm run script-exists', kind: 'run', scriptName: 'script-exists' },
        probe,
        {
          root,
          isProposal: false,
        },
      );
      assert(result.verdict === 'C', `正控 · 存在的 script 名 ⇒ 判 C（实测 ${result.verdict}）`);
    }
    // ⑤ 负控 · 绝对路径：存在 ⇒ B（仓外 · 不在版本控制内）
    {
      const probe = syntheticProbe();
      const abs = `D:/qa-mut-${'f'.repeat(8)}.mjs`;
      const result = classify({ raw: abs, kind: 'absolute' }, probe, {
        root,
        isProposal: false,
      });
      assert(result.verdict === 'A', `负控 · 不存在的绝对路径 ⇒ 判 A（实测 ${result.verdict}）`);
    }
    // ⑥ 正控 · 绝对路径：真实存在 ⇒ B（仓外 · 机器够不着）
    {
      const probe = syntheticProbe();
      const abs = `D:/qa-mut-${'f'.repeat(8)}.mjs`;
      const probeWithAbs: Probe = { ...probe, absoluteExists: (p) => p === abs };
      const result = classify({ raw: abs, kind: 'absolute' }, probeWithAbs, {
        root,
        isProposal: false,
      });
      assert(result.verdict === 'B', `正控 · 存在的绝对路径 ⇒ 判 B（实测 ${result.verdict}）`);
    }
    // ⑦ 端到端负控：同一句话，只换路径 ⇒ 判定必须【跟着变】（★ 这一条证明它不是恒绿）
    {
      const probe = syntheticProbe();
      const sentence = '这条纪律由 `scripts/PLACEHOLDER.ts` 逐字守卫。';
      const withFake = scanText(
        sentence.replace('PLACEHOLDER', '__qa-must-not-exist-bbbbbb'),
        'fixture.md',
        probe,
        root,
      );
      const withReal = scanText(
        sentence.replace('PLACEHOLDER', 'exists-tracked'),
        'fixture.md',
        probe,
        root,
      );
      assert(
        withFake.some((f) => f.verdict === 'A') && !withReal.some((f) => f.verdict === 'A'),
        '端到端负控 · 只换路径 ⇒ 判定从 A 变 C ⇒ 内容真的在驱动判定（不是恒绿）',
      );
    }
    // ⑦ 提案豁免：同一句「建议加一条」⇒ 判 D 而非 A
    {
      const probe = syntheticProbe();
      const result = scanText(
        '建议比照加一条生产侧守卫（`scripts/__qa-must-not-exist-cccccc.ts`）。',
        'fixture.md',
        probe,
        root,
      );
      assert(
        result.some((f) => f.verdict === 'D') && !result.some((f) => f.verdict === 'A'),
        '豁免 R2 · 提案句 ⇒ 判 D 而非 A',
      );
    }
    // ⑧ 声明同格豁免：声明词在别的格 ⇒ 不算凭据声明
    {
      const probe = syntheticProbe();
      const result = scanText(
        '| `scripts/__qa-must-not-exist-dddddd.ts` | 这条纪律由脚本逐字守卫 |',
        'fixture.md',
        probe,
        root,
      );
      assert(!result.some((f) => f.verdict === 'A'), '豁免 R1 · 声明词不在同一格 ⇒ 不判 A');
    }
    // ⑨ 真仓库扫描非空（★ 证明抽取器不是空转）
    {
      const probe = makeProbe(root);
      const findings = scanTree(root, probe);
      assert(findings.length > 0, `真仓库扫描抽出 ${findings.length} 条凭据（> 0 ⇒ 抽取器在工作）`);
      assert(
        findings.some((f) => f.verdict === 'C'),
        '真仓库扫描里存在 C 档 ⇒ 判定链能走到「完好」这一档（不是只会判红）',
      );
    }
    // ⑩ 端到端：把夹具写进临时目录、跑真实扫描管线、再删掉（★ 仓库零污染）
    {
      const tempRoot = join(root, '..', `.qa-credential-hygiene-selftest-${process.pid}`);
      rmSync(tempRoot, { recursive: true, force: true });
      mkdirSync(join(tempRoot, 'docs'), { recursive: true });
      const fixturePath = join(tempRoot, 'docs', 'fixture.md');
      const fakeName = `__qa-must-not-exist-${'e'.repeat(7)}.ts`;
      writeFileSync(fixturePath, `这条纪律由 \`scripts/${fakeName}\` 逐字守卫。\n`, 'utf8');
      try {
        const probe = makeProbe(tempRoot);
        const findings = scanTree(tempRoot, probe);
        const hit = findings.find((f) => f.credential.includes(fakeName));
        assert(hit !== undefined && hit.verdict === 'A', '端到端 · 临时夹具里的假路径被报成 A');
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
      assert(!existsSync(tempRoot), '端到端 · 临时夹具已删除（仓库零污染）');
    }

    process.stdout.write('\n✓ 自测全部通过\n');
    return 0;
  } catch (error) {
    process.stderr.write(
      `\n✗ 自测失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** CLI 入口。 */
export function runCli(argv: readonly string[]): number {
  if (argv.includes('--self-test')) {
    return runSelfTest(REPO_ROOT);
  }

  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1] ?? REPO_ROOT);

  const probe = makeProbe(root);
  const findings = scanTree(root, probe);
  printReport(findings, root);

  const aCount = findings.filter((f) => f.verdict === 'A').length;
  if (aCount > 0) {
    process.stderr.write(`\n✗ 发现 ${aCount} 处 A 档（悬空机器凭据）\n`);
    return 1;
  }
  process.stdout.write('\n✓ 未发现 A 档悬空机器凭据\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
