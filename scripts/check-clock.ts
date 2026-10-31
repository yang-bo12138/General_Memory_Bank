#!/usr/bin/env tsx
/**
 * C37 静态扫描 —— DESIGN-v2.md §11.1 / §14.3.1 C37。
 *
 * > **C37**：凡方法体读写时间戳或参与时间计算的，签名必须含 `now?`；
 * > 不接收 `now` 的方法必须显式列出并写明理由。
 *
 * ⇒ **CI 静态扫描**：命中 `Date.now()` / `new Date()` / `performance.now()` 的实现文件，
 * 若所在方法签名无 `now?` 且该方法未在 §11.1 豁免清单里 ⇒ **失败**。
 *
 * ⚠️ ★ **分母必须是写死的期望值**（C31 的同一条纪律在扫描场景的翻版）：
 *   「允许 `Date.now()` 的文件数」与「允许的命中点数」都是**脚本里的常量**，
 *   **不能用「本次实际命中几个」当分母**——
 *   否则闸门脚本误删 5 个函数仍会显示「35/35 全绿」，缺口被自动掩盖。
 *
 * 用法：
 * ```
 * pnpm exec tsx scripts/check-clock.ts            # 扫描 src/
 * pnpm exec tsx scripts/check-clock.ts --root src
 * ```
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLOCK_EXEMPT_METHODS } from '../src/core/clock.js';
import { extractSection, readDesignDoc } from './lib/design-doc.js';

/** §11.1 的标题（**逐字**）。 */
const SECTION_11_1_HEADING = '### 11.1 时钟注入机制（Testing & Simulation）';

/**
 * ★ **写死的期望值**（C31）：允许读真实时钟的文件白名单。
 *
 * ⚠️ 目前**只有** `src/core/clock.ts` —— 它是「注入时钟的唯一入口」（§11.1 的 now 解析器）。
 *   阶段 1 起若某个方法确实需要真实时钟，**必须**先把它列进来并写明理由，
 *   而不是让扫描悄悄放行。
 */
export const ALLOWED_CLOCK_READ_FILES: readonly string[] = ['src/core/clock.ts'];

/**
 * ★ **写死的期望值**：允许读真实时钟的**文件数**。
 *
 * ⚠️ **为什么是字面量、不是 `ALLOWED_CLOCK_READ_FILES.length`**：
 *   若期望值由白名单长度派生，白名单一改，期望值就跟着改 ⇒
 *   「多放了一个文件进白名单」永远不会被发现（C31 的典型症状：
 *   闸门脚本误删 5 条函数仍显示「35/35 全绿」）。
 * ⇒ 期望值**独立写死**；白名单长度与它的一致性由下面那条独立断言把关。
 */
export const EXPECTED_CLOCK_READ_FILES = 1;

/**
 * ★ **写死的期望值**：允许读真实时钟的**命中点数**。
 */
export const EXPECTED_CLOCK_READ_SITES = 1;

/** 时钟读取的三种形态。 */
export const CLOCK_READ_PATTERNS: readonly { name: string; regex: RegExp }[] = [
  { name: 'Date.now()', regex: /\bDate\s*\.\s*now\s*\(\s*\)/g },
  { name: 'new Date()', regex: /\bnew\s+Date\s*\(\s*\)/g },
  { name: 'performance.now()', regex: /\bperformance\s*\.\s*now\s*\(\s*\)/g },
];

/**
 * 关键字之后出现的 `/` 是**正则字面量**的开始（而不是除号）。
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'do',
  'else',
  'await',
  'yield',
  'delete',
  'void',
  'instanceof',
]);

/** 这些字符之后出现的 `/` 是正则字面量（而不是除号）。 */
const REGEX_PRECEDING_CHARS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/**
 * 把源码里的**注释**抹掉（保留换行与字符位置）。
 *
 * ⚠️ **必须先剥注释再扫描**：设计稿与代码注释里大量出现 `Date.now()` 这三个字
 *   （例如「实现文件里不出现 `Date.now()`」这句话本身），
 *   不剥注释的话扫描器会把**说明文字**当成时钟读取 ⇒ 误报满天飞，闸门就废了。
 *
 * ⚠️ **必须认识正则字面量**：正则里可以出现引号（`/[="]/`），
 *   若把正则里的 `"` 当成字符串的开始，剥离器会卡在「字符串」状态里，
 *   后面的注释就再也剥不掉了。
 *
 * ⚠️ 字符串字面量里的内容**保留**（它们不是注释）。
 */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;
  const length = source.length;
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let state: State = 'code';
  /** 最近的非空白代码字符。 */
  let lastChar = '';
  /** 最近的标识符 / 关键字。 */
  let lastWord = '';

  const track = (char: string): void => {
    if (/\s/.test(char)) {
      return;
    }
    lastChar = char;
    lastWord = /[A-Za-z_$]/.test(char) ? lastWord + char : '';
    if (!/[A-Za-z0-9_$]/.test(char)) {
      lastWord = '';
    }
  };

  while (index < length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        out += '  ';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        out += '  ';
        index += 2;
        continue;
      }
      // 正则字面量：内部可以出现引号，必须整体跳过
      if (
        char === '/' &&
        (REGEX_PRECEDING_CHARS.has(lastChar) || REGEX_PRECEDING_KEYWORDS.has(lastWord))
      ) {
        out += char;
        index += 1;
        let inClass = false;
        while (index < length) {
          const inner = source[index] ?? '';
          if (inner === '\\') {
            out += inner + (source[index + 1] ?? '');
            index += 2;
            continue;
          }
          if (inner === '[') {
            inClass = true;
          } else if (inner === ']') {
            inClass = false;
          } else if (inner === '/' && !inClass) {
            out += inner;
            index += 1;
            break;
          } else if (inner === '\n') {
            out += inner;
            index += 1;
            break;
          }
          out += inner;
          index += 1;
        }
        lastChar = '/';
        lastWord = '';
        continue;
      }
      if (char === "'") {
        state = 'sq';
      } else if (char === '"') {
        state = 'dq';
      } else if (char === '`') {
        state = 'tpl';
      }
      out += char;
      track(char);
      index += 1;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        index += 2;
        continue;
      }
      out += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    // 字符串字面量
    if (char === '\\') {
      out += char + next;
      index += 2;
      continue;
    }
    if (
      (state === 'sq' && char === "'") ||
      (state === 'dq' && char === '"') ||
      (state === 'tpl' && char === '`')
    ) {
      state = 'code';
    }
    out += char;
    index += 1;
  }

  return out;
}

/** 一个时钟读取点。 */
export interface ClockReadSite {
  /** 相对仓库根的文件路径（用 `/` 分隔）。 */
  file: string;
  /** 行号（1 起）。 */
  line: number;
  /** 命中的形态名。 */
  pattern: string;
  /** 所在声明的名字（找不到时为 undefined）。 */
  enclosing?: string;
  /** 所在声明的完整签名文本。 */
  signature?: string;
}

/** 一条违规。 */
export interface ClockViolation {
  file: string;
  line: number;
  pattern: string;
  enclosing: string | undefined;
  reason: string;
}

/** 扫描结果。 */
export interface ClockScanResult {
  /** 所有时钟读取点。 */
  sites: ClockReadSite[];
  /** 违规点。 */
  violations: ClockViolation[];
  /** 命中时钟读取的文件（相对路径）。 */
  files: string[];
}

/** 递归列出目录下的 `.ts` 文件（排除测试文件）。 */
export function listImplementationFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts') || full.endsWith('.test.ts') || full.endsWith('.d.ts')) {
        continue;
      }
      out.push(full);
    }
  };
  walk(root);
  return out;
}

/** 不是函数声明的关键词（避免把 `if (` 当成方法）。 */
const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'await',
  'new',
  'typeof',
  'do',
  'else',
  'try',
  'finally',
  'yield',
  'throw',
  'case',
  'with',
  'super',
  'this',
  'import',
  'export',
]);

/** 声明行的识别：形如 `name(` / `function name(` / `const name = (`。 */
const DECLARATION_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/;

/**
 * 从第 `lineIndex` 行开始取出完整的参数列表文本（从 `(` 到配对的 `)`）。
 *
 * ⚠️ 必须跨行取：`appendEvent(\n  type: EventType,\n  ...\n): void {`
 *   的 `now?` 可能写在第 3 行。
 */
export function extractSignature(lines: string[], lineIndex: number): string {
  let depth = 0;
  let started = false;
  const parts: string[] = [];
  for (let index = lineIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    parts.push(line);
    for (const char of line) {
      if (char === '(') {
        depth += 1;
        started = true;
      } else if (char === ')') {
        depth -= 1;
        if (started && depth === 0) {
          return parts.join('\n');
        }
      }
    }
    if (started && depth === 0) {
      return parts.join('\n');
    }
    if (parts.length > 40) {
      break;
    }
  }
  return parts.join('\n');
}

/** 找出某一行所在的最内层声明（向上回溯）。 */
export function findEnclosingDeclaration(
  lines: string[],
  lineIndex: number,
): { name: string; lineIndex: number; signature: string } | undefined {
  for (let index = Math.min(lineIndex, lines.length - 1); index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const match = DECLARATION_RE.exec(line);
    if (match === null) {
      continue;
    }
    const name = match[1] ?? '';
    if (CONTROL_KEYWORDS.has(name)) {
      continue;
    }
    // 必须像函数声明：含 `=>` 或以 `{` 收尾
    const looksLikeFunction = line.includes('=>') || /\{\s*$/.test(line) || line.includes('):');
    if (!looksLikeFunction) {
      continue;
    }
    return { name, lineIndex: index, signature: extractSignature(lines, index) };
  }
  return undefined;
}

/** 声明上方 `lookback` 行内是否有提到 `now` 的注释。 */
function hasNowComment(lines: string[], declarationLineIndex: number, lookback = 8): boolean {
  const from = Math.max(0, declarationLineIndex - lookback);
  for (let index = from; index < declarationLineIndex; index += 1) {
    const line = lines[index] ?? '';
    if ((line.includes('//') || line.includes('*')) && line.includes('now')) {
      return true;
    }
  }
  return false;
}

/** 把绝对路径转成相对仓库根、且用 `/` 分隔的路径。 */
function toRepoRelative(root: string, file: string): string {
  const rel = relative(resolve(root), resolve(file));
  return rel.split(sep).join('/');
}

/**
 * 扫描一个目录，返回时钟读取点与违规点。
 *
 * @param root 实现文件的根目录（通常是 `src/`）
 * @param repoRoot 用于计算相对路径的仓库根
 */
export function scanClockReads(root: string, repoRoot = process.cwd()): ClockScanResult {
  const sites: ClockReadSite[] = [];
  const violations: ClockViolation[] = [];
  const filesWithReads = new Set<string>();

  for (const file of listImplementationFiles(root)) {
    const rel = toRepoRelative(repoRoot, file);
    const rawText = readFileSync(file, 'utf8');
    // ⚠️ 扫描**剥掉注释后**的代码（注释里的 `Date.now()` 是说明文字，不是时钟读取）
    const codeText = stripComments(rawText);
    const lines = codeText.split('\n');
    const rawLines = rawText.split('\n');
    const fileAllowed = ALLOWED_CLOCK_READ_FILES.includes(rel);

    for (const [index, line] of lines.entries()) {
      for (const pattern of CLOCK_READ_PATTERNS) {
        pattern.regex.lastIndex = 0;
        if (!pattern.regex.test(line)) {
          continue;
        }
        const declaration = findEnclosingDeclaration(lines, index);
        const site: ClockReadSite = {
          file: rel,
          line: index + 1,
          pattern: pattern.name,
          ...(declaration === undefined ? {} : { enclosing: declaration.name }),
          ...(declaration === undefined ? {} : { signature: declaration.signature }),
        };
        sites.push(site);
        filesWithReads.add(rel);

        if (fileAllowed) {
          continue;
        }

        // ① 所在声明的签名含 `now?` ⇒ 合规（它接收注入时钟）
        if (declaration !== undefined && /\bnow\s*\?/.test(declaration.signature)) {
          continue;
        }

        // ② 所在声明在 §11.1 豁免清单里，且代码里有注释写明理由 ⇒ 合规
        if (
          declaration !== undefined &&
          CLOCK_EXEMPT_METHODS[declaration.name] !== undefined &&
          hasNowComment(rawLines, declaration.lineIndex)
        ) {
          continue;
        }

        violations.push({
          file: rel,
          line: index + 1,
          pattern: pattern.name,
          enclosing: declaration?.name,
          reason:
            declaration === undefined
              ? '无法定位所在声明：读时钟的代码必须在一个签名含 `now?` 的方法里，或在 §11.1 豁免清单内'
              : `方法 ${declaration.name} 的签名不含 \`now?\`，且它不在 §11.1 的豁免清单里`,
        });
      }
    }
  }

  return { sites, violations, files: [...filesWithReads].sort() };
}

/**
 * 校验「命中数」与**写死的期望值**是否一致（C31）。
 *
 * ⚠️ ★ 分母必须是**外部写死的期望值**，不是「本次实际命中几个」——
 *   闸门脚本误删 5 条函数仍显示「35/35 全绿」是它的典型症状。
 *   ⇒ 「实际比期望多」= 有人偷偷加了时钟读取；
 *     「实际比期望少」= 有人删了代码（缺口被自动掩盖）。
 *
 * @returns 不满足的期望（空数组 = 全部满足）
 */
/**
 * ★ **独立断言**：白名单的长度必须与**写死的**期望文件数一致。
 *
 * ⚠️ 这一条与「本次实际命中了几个文件」**无关** ⇒ 它防的是
 *   「有人往白名单里加了一个文件，却没同步改写死的期望值」这种漂移。
 *   若期望值由白名单长度派生（`ALLOWED_CLOCK_READ_FILES.length`），
 *   这条断言就**永远不可能失败** ⇒ 假绿。
 *
 * @param whitelist 白名单（长度）
 * @param expected 写死的期望文件数
 * @returns 不满足的期望（空数组 = 满足）
 */
export function evaluateWhitelistLength(whitelist: readonly string[], expected: number): string[] {
  if (whitelist.length === expected) {
    return [];
  }
  return [
    `时钟白名单长度 ${whitelist.length} ≠ 期望 ${expected}（白名单改动必须同步改写死的期望值，C31）`,
  ];
}

/**
 * 校验「命中数」与**写死的期望值**是否一致（C31）。
 *
 * ⚠️ ★ 分母必须是**外部写死的期望值**，不是「本次实际命中几个」——
 *   闸门脚本误删 5 条函数仍显示「35/35 全绿」是它的典型症状。
 * ⇒ 「实际比期望多」= 有人偷偷加了时钟读取；
 *   「实际比期望少」= 有人删了代码（缺口被自动掩盖）。
 *
 * @returns 不满足的期望（空数组 = 全部满足）
 */
export function evaluateExpectations(result: ClockScanResult): string[] {
  const failures: string[] = [];

  // ⚠️ **独立断言**：白名单的长度必须与**写死的**期望文件数一致（见上面的说明）。
  failures.push(...evaluateWhitelistLength(ALLOWED_CLOCK_READ_FILES, EXPECTED_CLOCK_READ_FILES));

  if (result.files.length !== EXPECTED_CLOCK_READ_FILES) {
    failures.push(
      `命中时钟读取的文件数 ${result.files.length} ≠ 期望 ${EXPECTED_CLOCK_READ_FILES}（分母写死，C31）`,
    );
  }
  if (result.sites.length !== EXPECTED_CLOCK_READ_SITES) {
    failures.push(
      `时钟读取命中点数 ${result.sites.length} ≠ 期望 ${EXPECTED_CLOCK_READ_SITES}（分母写死，C31）`,
    );
  }
  return failures;
}

/**
 * ★ **§11.1 的豁免清单 ↔ 代码清单的双向比对**（v2.1 / P2 QA 第二轮 F2 修正）。
 *
 * ⚠️ **为什么必须补这条**（「门禁只做了一半」的典型盲区）：
 *   §11.1 是 C37 的**权威清单**（「不接收 `now` 的方法必须在本表显式列出并写明理由」
 *   ⇒ 设计稿写着「**本节已列全**」）。
 *   ⇒ 但此前 `check-clock.ts` **只扫代码**（谁读了 `Date.now()`）⇒
 *   ⇒ **设计稿那一侧零比对** ⇒ 把 §11.1 的清单改错（漏一个 / 多一个 / 换成别的名字）
 *   ⇒ **三门全绿**（QA 实测：§11.1 换成 `qaBogus` ⇒ check:clock / check:contract-ids /
 *     clock.test.ts **全部绿**）。
 *   ⇒ ⇒ 后果：C37 的「**本表已列全**」这句话**无人守** ⇒ 文档级契约可被无声破坏。
 *
 * ⇒ 本函数做**双向**比对：§11.1 列出的每个方法 ⇒ 代码里必须存在；
 *   代码里的每个豁免方法 ⇒ §11.1 必须列出。
 *
 * @param designMarkdown 设计稿全文
 * @returns 每一处差异（空数组 = 一致）
 */
export function compareClockExemptLists(designMarkdown: string): string[] {
  const diffs: string[] = [];
  const section = extractSection(designMarkdown, SECTION_11_1_HEADING);
  // ⚠️ 清单出现在「（本节已列全：`a` / `b` / `c`）」这一句里。
  //   ⇒ **只取「本节已列全：」之后、到「——」或「）」之前**的那一段
  //   （理由写在「——」之后 ⇒ 不能把它当成方法名 ⇒ 否则会把理由里的
  //   `updated_at` 之类也当成方法名 ⇒ 误报）。
  const listedMatch = /本节已列全[：:]([^）]*)/u.exec(section);
  if (listedMatch === null) {
    diffs.push('§11.1 里找不到「本节已列全：…」那句 ⇒ 权威清单无法解析');
    return diffs;
  }
  const listPart = (listedMatch[1] ?? '').split('——')[0] ?? '';
  const docNames = [
    ...new Set(
      [...listPart.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((match) => match[1] ?? ''),
    ),
  ]
    .filter((name) => name !== '')
    .sort();
  const codeNames = Object.keys(CLOCK_EXEMPT_METHODS).sort();

  for (const name of docNames) {
    if (!codeNames.includes(name)) {
      diffs.push(`§11.1 列了 \`${name}\`，但代码的 CLOCK_EXEMPT_METHODS 里没有它`);
    }
  }
  for (const name of codeNames) {
    if (!docNames.includes(name)) {
      diffs.push(`代码的 CLOCK_EXEMPT_METHODS 里有 \`${name}\`，但 §11.1 的清单里没列`);
    }
  }
  return diffs;
}

/** 主流程：扫描并按写死的期望值校验。 */
function main(): void {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? (process.argv[rootIndex + 1] ?? 'src') : 'src';
  const repoRoot = process.cwd();

  const result = scanClockReads(root, repoRoot);

  process.stdout.write(`C37 时钟扫描：目录 ${root}\n`);
  process.stdout.write(
    `  命中时钟读取的文件数：${result.files.length}（期望 ${EXPECTED_CLOCK_READ_FILES}）\n`,
  );
  process.stdout.write(`  命中点数：${result.sites.length}（期望 ${EXPECTED_CLOCK_READ_SITES}）\n`);
  for (const site of result.sites) {
    process.stdout.write(
      `    ${site.file}:${site.line}  ${site.pattern}  ${site.enclosing ?? '(顶层)'}\n`,
    );
  }

  let failed = false;

  // ⚠️ **F2**：§11.1 的权威清单 ↔ 代码清单**双向**比对（设计稿那一侧此前无人守）
  const exemptDiffs = compareClockExemptLists(readDesignDoc());
  if (exemptDiffs.length > 0) {
    failed = true;
    process.stderr.write(`\n✗ §11.1 的豁免清单与代码不一致（${exemptDiffs.length} 处）：\n`);
    for (const reason of exemptDiffs) {
      process.stderr.write(`    ${reason}\n`);
    }
    process.stderr.write('  ⇒ §11.1 是 C37 的权威清单（「本节已列全」）⇒ 两边必须逐名一致。\n');
  }

  if (result.violations.length > 0) {
    failed = true;
    process.stderr.write(`\n✗ 发现 ${result.violations.length} 处未获准的时钟读取：\n`);
    for (const violation of result.violations) {
      process.stderr.write(
        `    ${violation.file}:${violation.line}  ${violation.pattern}  ${violation.reason}\n`,
      );
    }
  }

  const expectationFailures = evaluateExpectations(result);
  if (expectationFailures.length > 0) {
    failed = true;
    for (const failure of expectationFailures) {
      process.stderr.write(`\n✗ ${failure}\n`);
    }
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✓ C37 时钟注入契约通过\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
