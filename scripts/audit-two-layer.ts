/**
 * 「两个层次必须分开列」的**可复跑审计** —— 防止一句「逐位相同」把两个层次糊在一起。
 *
 * ⚠️ **本文件不带 `#!/usr/bin/env node` shebang**（★ 与它的 `.mjs` 前身不同 ⇒ 记下原因）：
 *   接进 `pnpm run verify` 之后，它**必须能被 `tests/contracts/two-layer-audit.test.ts` import**
 *   ⇒ ⇒ 而 vitest **不走 Node 的加载器**（转译后内联执行）⇒ ⇒ **shebang 会让 `import` 直接抛
 *   `SyntaxError: Invalid or unexpected token`** ⇒ ⇒ **故去掉** ⇒ ⇒ 调用方式写 `pnpm run audit:two-layer`。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【它守的是哪条纪律】
 *
 * `docs/design/DEVELOPMENT-PLAN.md` §2.4 **纪律第 4 条**的「写法要求」：
 *   **★「不可变的东西」和「会变的东西」必须分开列** ⇒ 否则**一句「逐位相同」会把两个层次糊在一起**
 *   ⇒ **落到写法上**：**凡要写「A 与 B 逐位相同」，必须紧跟一句「那是指【哪个量】逐位相同；【另一个量】会变」**
 *   ⇒ **判据**：**若一句话只说了「逐位相同」而没说是哪个量 ⇒ 那就是在糊 ⇒ 不可发。**
 *
 * ⇒ 它的**原型事故**（`docs/progress/stage3-progress.md` §13.9.2 的实例 ⑤）：
 * 「`vectorCandidateRows` 两档逐位相同」⇒ 被推成「『文本路 87.9% / 向量 12.1%』在两档里都不因 I/O 快慢而改变」
 * ⇒ ⇒ **实测两档是 12.1% vs 21.6%** ⇒ ⇒ **行数（不变量）被当成了毫秒占比（变量）**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【它第一版踩过的坑】（留给后人 —— ★ 与 `audit-tier-qualifiers.ts` 的同名小节同一用途）
 *
 * · **坑①：判定范围太宽 ⇒ 假阳性泛滥**
 *   第一版规格是「**凡是**出现『逐位相同』就要求点名量」
 *   ⇒ ⇒ 实测：裸触发词在 `docs/` 里有 **98 行**，其中 **76 行在【同一行】里没有点名量**
 *   ⇒ ⇒ **但那 76 行绝大多数是合法的**（衰减公式两种写法结果相同、`top-K` 逐位相等、embedder 确定性……）
 *   ⇒ ⇒ **若照第一版去判 ⇒ 会产出 ~76 个假阳性**
 *   ⇒ ⇒ **⇒ 一个假阳性泛滥的检查会被大家加白名单绕过 ⇒ ⇒ 那就等于没有检查**
 *   ⇒ ⇒ **⇒ 处置：把范围收窄到【跨档对照语境】**（触发行 + 相邻句里出现档位词才判）⇒ ⇒ **假阳性 76 → 0**。
 *
 * · **坑②：白名单靠印象填 ⇒ 产出假阳性**
 *   收窄后第一版跑出 **4 个「真缺」** ⇒ ⇒ 逐处核 ⇒ ⇒ **全是假阳性**：那 4 处写的都是「**行数**」逐位相同
 *   ⇒ ⇒ **白名单漏了「行数」这个规范中文写法**（我列了 `候选读取行数` / `行数测量`，却漏了 `行数`）
 *   ⇒ ⇒ **⇒ 这就是纪律 4 的实例 ⑨ 的同形态**：**白名单靠印象填 ⇒ 产出假阳性**
 *   ⇒ ⇒ **⇒ 处置：补上 `行数` ⇒ ⇒ 真缺归 0** ⇒ ⇒ **并把「代码字段名必须逐个出现在 `bench/perf.ts`」做成启动自检**
 *   ⇒ ⇒ ⇒ **⇒ 白名单里【可机器核】的那部分（代码字段名）不许靠印象；【不可机器核】的那部分（中文别名）必须被显眼地标出来。**
 *
 * · **坑③：把登记行插进错的表**
 *   往 `scripts/README.md` 登记时，插进了 C25~C37 对照表（5 列）而不是「可复跑的审计」表（3 列）
 *   ⇒ ⇒ **被「表格列数自检」当场抓住**（4 列塞进 5 列表 ⇒ 列数对不上）
 *   ⇒ ⇒ **⇒ 这又是同一个家族：「我以为插对了」⇒ 机制自己的读法（列数检查）救了它。**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【怎么用】
 *
 * ```bash
 * # 审计默认目标（仓库根 docs/ 下的全部 .md，排除 docs/qa/）
 * pnpm run audit:two-layer
 *
 * # 审计指定文件或目录（CLI 仍接受的参数形式）
 * node --import tsx scripts/audit-two-layer.ts docs/design/DEVELOPMENT-PLAN.md docs/baseline
 * ```
 *
 * **退出码**：`0` = 无真缺；`1` = 有真缺（⇒ **可直接当门禁用**）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【它现在是不是门禁】★ 是。`pnpm run verify` 的第 13 段（`audit:two-layer`）
 *   ⇒ 「新增门禁的做法」四条全部到位：① 导出纯函数（`auditTwoLayers` / `renderAudit`）
 *   ② 串进 `verify` ③ `tests/contracts/two-layer-audit.test.ts` 的**含反例单测** ④ 门禁表登记。
 *   ⇒ ⇒ 交付形态随之从 `.mjs` 改回 `.ts`（⇒ **进 `tsc --noEmit`**）。
 *
 * ⚠️ **它仍然只判「跨档语境」里的「逐位相同」** ⇒ 这条收窄**不是妥协，是判据的一部分**
 *   （⇒ 放宽会产出 ~76 个假阳性 ⇒ 假阳性泛滥的检查会被绕过 ⇒ **等于没有检查**）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认扫描根。 */
const DEFAULT_SCAN_ROOT = join(REPO_ROOT, 'docs');

/**
 * ⚠️ **默认排除的目录**（**写死为常量** ⇒ 纪律 1「分母写死」）。
 *
 * `docs/qa/` 是**历史验收报告** ⇒ 它**按当时的口径记录**旧措辞是它的本职
 * ⇒ ⇒ **把它算进「真缺」⇒ 会把历史记录误判成现行违规** ⇒ ⇒ **故排除**。
 */
const EXCLUDED_DIRS: readonly string[] = ['docs/qa'];

/** **上下文窗口**（写死 ⇒ 纪律 1）：触发行**及其前后各 1 行**。 */
const CONTEXT_LINES_BEFORE = 1;
const CONTEXT_LINES_AFTER = 1;

/** 触发词：**「逐位相同」类**必须点名量**的说法。 */
const TRIGGER_PATTERN = /逐位相同|逐位完全相同/;

/**
 * 档位词：**出现它们 ⇒ 这句话在谈「跨档 / 多档对照」** ⇒ ⇒ 此时才要求点名量。
 *
 * ⚠️ **这份词表是「适用范围」的定义** ⇒ ⇒ **它一旦写定，判定范围就定了**
 * ⇒ ⇒ **所以它必须写死、可见、可被质疑**（⇒ ⇒ **它也是「靠印象填」的重灾区** ⇒ ⇒ 故在此显式列出）。
 */
const TIER_PATTERN =
  /冷盘档|部分热档|部分预热档|热盘档|全热档|两档|三档|跨档|两次采集|两次独立采集|重采/;

/**
 * **白名单 · 代码字段名部分**（**可机器核** ⇒ 启动时自检 ⇒ 不许靠印象填）。
 *
 * ⇒ 每一项都必须逐个出现在 `bench/perf.ts` 里 ⇒ ⇒ **白名单漂移 ⇒ 判红**。
 */
export const CODE_FIELD_NAMES: readonly string[] = [
  'candidateReadRows',
  'hitFineBuckets',
  'vectorCandidateRows',
];

/**
 * **白名单 · 文档中文写法部分**（⚠️ **不可机器核** —— 中文别名没有单一权威出处）。
 *
 * ⇒ ⇒ **故它只作「判定用」，不作「自检用」** ⇒ ⇒ **这本身是纪律 1 的诚实版用法**。
 *
 * ⚠️ ★ **「行数」是本仓库这个量的规范中文写法** ⇒ ⇒ **它必须在白名单里**
 * ⚠️ ★ **（第一版漏了它 ⇒ 产出 4 个假阳性 ⇒ ⇒ 见上面「坑②」）**
 */
export const DOC_QUANTITY_NAMES: readonly string[] = [
  '行数',
  '候选读取行数',
  '写入侧候选扫描行数',
  '命中细桶数',
  '桶成员数',
  '行数测量',
  '三个行数测量',
  '候选行数',
  '候选面',
  'H1',
  'H2',
];

/** **白名单的并集**（判定用）。 */
export const QUANTITY_NAMES: readonly string[] = [...CODE_FIELD_NAMES, ...DOC_QUANTITY_NAMES];

/** 一处「真缺」的定位信息。 */
export interface LayerGap {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

/** 一个被审计的文件。 */
export interface AuditedFile {
  readonly path: string;
  readonly content: string;
}

/** 一次审计的完整结果。 */
export interface TwoLayerAudit {
  readonly triggerLines: number;
  readonly judgedLines: number;
  readonly realGaps: number;
  readonly gaps: LayerGap[];
  readonly whitelistSelfCheck: string[];
}

/** 构造一处「真缺」。 */
export function makeGap(path: string, line: number, text: string, reason: string): LayerGap {
  return { path, line, text, reason };
}

/** 取「本行 + 相邻句」作为语境（**读者读 Markdown 的方式**）。 */
export function contextOf(lines: readonly string[], index: number): string {
  const from = Math.max(0, index - CONTEXT_LINES_BEFORE);
  const to = Math.min(lines.length, index + CONTEXT_LINES_AFTER + 1);
  return lines.slice(from, to).join('\n');
}

/**
 * **纯函数**：审计一批文件。
 *
 * ⚠️ **无 IO、无随机、无时间依赖** ⇒ ⇒ 连跑两次输出逐字相同。
 *
 * @param files 待审计的文件（路径 + 全文）
 * @param auditSource 可选的 `bench/perf.ts` 源码覆盖（**只给单测做漂移反例用**）
 */
export function auditTwoLayers(files: readonly AuditedFile[], auditSource?: string): TwoLayerAudit {
  const gaps: LayerGap[] = [];
  let triggerLines = 0;
  let judgedLines = 0;

  // ⚠️ **按路径排序** ⇒ 输出与输入顺序无关 ⇒ ⇒ **幂等**。
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const file of sorted) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!TRIGGER_PATTERN.test(line)) continue;
      triggerLines += 1;

      const context = contextOf(lines, i);
      // ⚠️ **不在跨档语境 ⇒ 不判**（⇒ 避免把「衰减公式两种写法相同」之类误判成违规）。
      if (!TIER_PATTERN.test(context)) continue;

      judgedLines += 1;
      // ⇒ ⇒ **点名了量 ⇒ 通过**（⇒ 「不可变 / 会变」两个层次里，这一处至少点清了「哪个量不变」）。
      if (QUANTITY_NAMES.some((name) => context.includes(name))) continue;

      gaps.push(
        makeGap(
          file.path,
          i + 1,
          line.trim().slice(0, 160),
          '该行（或其相邻句）出现「逐位相同」且处于跨档对照语境，但【没有点名被比较的量】' +
            ' ⇒ 按 §2.4 纪律 4 的写法要求 ⇒ 不可发 ⇒ 请补一句「那是指【哪个量】逐位相同；【另一个量】会变」',
        ),
      );
    }
  }

  return {
    triggerLines,
    judgedLines,
    realGaps: gaps.length,
    gaps,
    whitelistSelfCheck: checkWhitelistAgainstCode(auditSource),
  };
}

/**
 * **白名单自检**：**代码字段名必须逐个出现在代码里** ⇒ ⇒ 白名单不可靠印象填。
 *
 * ⚠️ **这是纪律 4 的实例 ⑨ 的教训**：白名单若靠印象填 ⇒ 它自己就是一个「无效的检查」。
 *
 * @param source 可选的源码覆盖（**单测用它注入「已漂移」的源码** ⇒ 证明这条自检能打红）
 */
export function checkWhitelistAgainstCode(source?: string): string[] {
  const problems: string[] = [];
  let bench = '';
  if (source !== undefined) {
    bench = source;
  } else {
    try {
      bench = readFileSync(join(REPO_ROOT, 'bench', 'perf.ts'), 'utf8');
    } catch {
      return ['✗ 读不到 bench/perf.ts ⇒ 白名单自检无法进行（⇒ 检查项自己失效了 ⇒ 判红）'];
    }
  }
  for (const field of CODE_FIELD_NAMES) {
    if (!bench.includes(field)) {
      problems.push(`✗ 代码字段名「${field}」在 bench/perf.ts 里找不到 ⇒ 白名单已漂移`);
    }
  }
  return problems;
}

/** 渲染审计报告（**纯函数** ⇒ 且**不含时间戳** ⇒ 幂等）。 */
export function renderAudit(audit: TwoLayerAudit): string {
  const lines: string[] = [];
  lines.push('两层次分离审计（§2.4 纪律 4 的写法要求）');
  lines.push('');
  lines.push(`  触发行数（凡「逐位相同」）：${audit.triggerLines}`);
  lines.push(`  判定数（其中落在跨档语境）：${audit.judgedLines}`);
  lines.push(`  真缺数（跨档语境内未点名量）：${audit.realGaps}`);
  lines.push('');
  if (audit.whitelistSelfCheck.length === 0) {
    lines.push('  白名单自检：✓ 代码字段名逐个存在于 bench/perf.ts');
  } else {
    lines.push('  白名单自检：');
    for (const p of audit.whitelistSelfCheck) lines.push(`    ${p}`);
  }
  if (audit.realGaps === 0) {
    lines.push('');
    lines.push('  ✓ 无真缺');
  } else {
    lines.push('');
    lines.push('  ✗ 真缺明细：');
    for (const gap of audit.gaps) {
      lines.push(`    ${gap.path}:${gap.line}`);
      lines.push(`      ${gap.text}`);
      lines.push(`      ⇒ ${gap.reason}`);
    }
  }
  return lines.join('\n');
}

/** 递归收集目标文件（**按路径排序** ⇒ 幂等）。 */
export function collectFiles(target: string): AuditedFile[] {
  const out: AuditedFile[] = [];
  const walk = (p: string): void => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name));
      return;
    }
    if (!p.endsWith('.md')) return;
    const rel = relative(REPO_ROOT, p).replace(/\\/g, '/');
    if (EXCLUDED_DIRS.some((excluded) => rel === excluded || rel.startsWith(`${excluded}/`)))
      return;
    out.push({ path: rel, content: readFileSync(p, 'utf8') });
  };
  walk(target);
  return out;
}

/** CLI 薄壳。 */
function main(): void {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : [DEFAULT_SCAN_ROOT];
  const files = targets.flatMap((t) => collectFiles(resolve(REPO_ROOT, t)));
  const audit = auditTwoLayers(files);
  process.stdout.write(`${renderAudit(audit)}\n`);
  const selfCheckFailed = audit.whitelistSelfCheck.length > 0;
  process.exitCode = audit.realGaps > 0 || selfCheckFailed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
