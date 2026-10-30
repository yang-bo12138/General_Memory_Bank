#!/usr/bin/env tsx
/**
 * 契约编号与引用数字的一致性检查 —— DESIGN-v2.md §14.3.1 的 C25 / C26 / §5 的 8 条。
 *
 * > **C25**：同一规则在几处描述、值是否一致（例：`ROUTER_NPROBE_WRITE_*` 在 §5 与 §6 必须是同一组值）。
 * > **C26**：参数名（默认值 N）必须在 §5 + `DEFAULT_PARAMS` 或显式硬编码
 *   （例：`VECTOR_OVERFETCH_FACTOR` 本版**硬编码 3**、不开放为参数 ⇒ 必须在正文写明「硬编码 3」）。
 *
 * ⚠️ **「条数」是会被交叉引用与断言的量**：清单增删必须同步改引用处的数字
 *   （与 §12 方法覆盖表同一条纪律，C25）。
 * ⇒ 本脚本做**三方比对**：§5 正文里数出来的条数 × §12 里引用的数字 × 代码里的条数。
 *
 * 用法：`pnpm exec tsx scripts/check-contract-ids.ts`
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  METHODS_RETURNING_NULL,
  METHODS_THROWING_CONFLICT,
  METHODS_THROWING_NOT_FOUND,
  METHODS_THROWING_READONLY_VIOLATION,
} from '../src/core/errors.js';
import {
  CROSS_PARAM_VALIDATION_COUNT,
  CROSS_PARAM_VALIDATION_RULES,
  DEFAULT_PARAMS,
  VECTOR_OVERFETCH_FACTOR,
} from '../src/core/params.js';
import {
  extractBacktickSpans,
  extractSection,
  readDesignDoc,
  stripBlockquote,
} from './lib/design-doc.js';

/** §5 / §6 / §11.2 / §12 的标题行。 */
const SECTION_5_HEADING = '## 5. 参数表（集中配置）';
const SECTION_6_HEADING = '## 6. 接口设计（TypeScript 同步 API）';
const SECTION_11_2_HEADING = '### 11.2 错误类型体系';
const SECTION_12_HEADING = '## 12. 实施路线图';

/** 从 §5 的「跨参数校验」块里数出条目。 */
export function parseSection5ValidationCount(markdown: string): number[] {
  const section = extractSection(markdown, SECTION_5_HEADING);
  const lines = section.split('\n');

  const start = lines.findIndex((line) => line.includes('跨参数校验'));
  const end = lines.findIndex((line, index) => index > start && line.includes('本清单共'));
  if (start < 0) {
    throw new Error('§5 里找不到「跨参数校验」块');
  }
  const stop = end < 0 ? lines.length : end;

  const numbers: number[] = [];
  for (let index = start; index < stop; index += 1) {
    const text = stripBlockquote(lines[index] ?? '').trim();
    const match = /^(\d+)\.\s/.exec(text);
    if (match !== null) {
      numbers.push(Number(match[1]));
    }
  }
  return numbers;
}

/** 从 §12 里读出「§5 的 N 条」这个引用数字。 */
export function parseSection12ValidationReference(markdown: string): number | undefined {
  const section = extractSection(markdown, SECTION_12_HEADING);
  const match = /跨参数校验（§5 的 (\d+) 条）/.exec(section);
  return match === null ? undefined : Number(match[1]);
}

/** 从 §6 的 `DEFAULT_PARAMS` 代码块里解析出参数默认值。 */
export function parseSection6Params(markdown: string): Map<string, string | number | boolean> {
  const section = extractSection(markdown, SECTION_6_HEADING);
  const result = new Map<string, string | number | boolean>();
  let inBlock = false;

  for (const rawLine of section.split('\n')) {
    // ⚠️ 必须先去掉行尾注释（`// ...`）——否则 `coactivation: true,  // 关：…` 的值会变成
    //    `true,  // 关：…`，既不等于 'true' 也不是数字 ⇒ 这 5 个机制开关会被整段漏掉。
    const line = rawLine.split('//')[0]?.trim() ?? '';
    if (line.startsWith('export const DEFAULT_PARAMS = {')) {
      inBlock = true;
      continue;
    }
    if (!inBlock) {
      continue;
    }
    if (line === '};') {
      break;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*,?\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1] ?? '';
    const rawValue = (match[2] ?? '').replace(/,$/, '').trim();
    if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
      result.set(key, rawValue.slice(1, -1));
      continue;
    }
    if (rawValue === 'true' || rawValue === 'false') {
      result.set(key, rawValue === 'true');
      continue;
    }
    const numeric = /^(-?\d+(?:\.\d+)?)/.exec(rawValue);
    if (numeric !== null) {
      result.set(key, Number(numeric[1]));
    }
  }

  return result;
}

/** 从 §11.2 的「缺失的表达方式对照」表里取出某个表达方式对应的方法。 */
export function parseSection11_2Methods(markdown: string): Map<string, string[]> {
  const section = extractSection(markdown, SECTION_11_2_HEADING);
  const result = new Map<string, string[]>();

  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 3) {
      continue;
    }
    const expression = cells[1] ?? '';
    const methodsCell = cells[2] ?? '';

    let key: string | undefined;
    if (expression.includes('NOT_FOUND')) {
      key = 'throw_not_found';
    } else if (expression.includes('null')) {
      key = 'return_null';
    } else if (expression.includes('CONFLICT')) {
      key = 'conflict';
    } else if (expression.includes('READONLY_VIOLATION')) {
      key = 'readonly_violation';
    } else if (expression.includes('warnings')) {
      key = 'warning_only';
    }
    if (key === undefined) {
      continue;
    }

    const methods = extractBacktickSpans(methodsCell)
      .map((span) => (span.split('(')[0] ?? '').trim())
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    if (methods.length === 0) {
      continue;
    }
    result.set(key, methods);
  }

  return result;
}

/** 一处不一致。 */
export interface ContractDiff {
  reason: string;
}

/** 做全部检查，返回不一致清单。 */
export function checkContracts(markdown: string): ContractDiff[] {
  const diffs: ContractDiff[] = [];

  // ── §5 的 8 条 ↔ §12 的引用 ↔ 代码里的条数 ──
  const section5Numbers = parseSection5ValidationCount(markdown);
  const section12Reference = parseSection12ValidationReference(markdown);
  const codeCount = CROSS_PARAM_VALIDATION_COUNT;

  if (section5Numbers.length !== codeCount) {
    diffs.push({
      reason: `§5 的跨参数校验条数 ${section5Numbers.length} ≠ 代码里的 ${codeCount}`,
    });
  }
  const consecutive = section5Numbers.every((value, index) => value === index + 1);
  if (!consecutive) {
    diffs.push({
      reason: `§5 的跨参数校验编号不是连续的 1~N：${section5Numbers.join(', ')}`,
    });
  }
  if (section12Reference === undefined) {
    diffs.push({ reason: '§12 里找不到「§5 的 N 条」这个引用' });
  } else if (section12Reference !== codeCount) {
    diffs.push({
      reason: `§12 引用的条数 ${section12Reference} ≠ 代码里的 ${codeCount}（C25：引用处的数字必须同步）`,
    });
  }
  const ruleIds = CROSS_PARAM_VALIDATION_RULES.map((rule) => rule.id);
  if (ruleIds.join(',') !== section5Numbers.join(',')) {
    diffs.push({
      reason: `代码里的规则编号 [${ruleIds.join(',')}] 与 §5 的 [${section5Numbers.join(',')}] 不一致`,
    });
  }

  // ── C25 的典型用例：ROUTER_NPROBE_WRITE_* 在 §5 与 §6 必须是同一组值 ──
  const section6 = parseSection6Params(markdown);
  const section5 = extractSection(markdown, SECTION_5_HEADING);
  for (const key of ['ROUTER_NPROBE_WRITE_COARSE', 'ROUTER_NPROBE_WRITE_FINE']) {
    const from6 = section6.get(key);
    const fromCode = (DEFAULT_PARAMS as Record<string, number | boolean | string>)[key];
    if (from6 === undefined) {
      diffs.push({ reason: `§6 的 DEFAULT_PARAMS 代码块里找不到 ${key}` });
      continue;
    }
    if (from6 !== fromCode) {
      diffs.push({
        reason: `${key}：§6 的代码块 = ${String(from6)}，DEFAULT_PARAMS = ${String(fromCode)}（C25）`,
      });
    }
    const rowPattern = new RegExp(`\`${key}\`\\s*\\|\\s*(\\d+)`);
    const rowMatch = rowPattern.exec(section5);
    if (rowMatch === null) {
      diffs.push({ reason: `§5 的表里找不到 ${key} 的行` });
      continue;
    }
    const from5 = Number(rowMatch[1]);
    if (from5 !== from6) {
      diffs.push({
        reason: `${key}：§5 = ${from5}，§6 = ${String(from6)}（C25：同一规则在几处描述、值必须一致）`,
      });
    }
  }

  // ── C26：VECTOR_OVERFETCH_FACTOR 硬编码 3、不开放为参数、正文写明「硬编码 3」 ──
  if (VECTOR_OVERFETCH_FACTOR !== 3) {
    diffs.push({
      reason: `VECTOR_OVERFETCH_FACTOR 必须是硬编码 3，实际是 ${VECTOR_OVERFETCH_FACTOR}`,
    });
  }
  if (Object.keys(DEFAULT_PARAMS).includes('VECTOR_OVERFETCH_FACTOR')) {
    diffs.push({ reason: 'VECTOR_OVERFETCH_FACTOR 不得作为参数出现在 DEFAULT_PARAMS 里（C26）' });
  }
  if (!/硬编码 3/.test(markdown)) {
    diffs.push({ reason: '设计稿里找不到「硬编码 3」的说明（C26 要求正文写明）' });
  }

  // ── §11.2 的「缺失的表达方式对照」↔ 代码里的契约表 ──
  const semantics = parseSection11_2Methods(markdown);
  const compare = (
    docMethods: string[] | undefined,
    codeMethods: readonly string[],
    label: string,
  ): void => {
    if (docMethods === undefined) {
      diffs.push({ reason: `§11.2 的表里找不到「${label}」那一行` });
      return;
    }
    const docSorted = [...docMethods].sort();
    const codeSorted = [...codeMethods].sort();
    if (docSorted.join(',') !== codeSorted.join(',')) {
      diffs.push({
        reason: `${label}：§11.2 = [${docSorted.join(', ')}]，代码 = [${codeSorted.join(', ')}]`,
      });
    }
  };

  compare(semantics.get('throw_not_found'), METHODS_THROWING_NOT_FOUND, 'NOT_FOUND');
  compare(semantics.get('return_null'), METHODS_RETURNING_NULL, '返回 null');
  compare(semantics.get('conflict'), METHODS_THROWING_CONFLICT, 'CONFLICT');
  if (METHODS_THROWING_READONLY_VIOLATION.length !== 16) {
    diffs.push({
      reason: `READONLY_VIOLATION 的写方法应是 16 个（§7.1），实际 ${METHODS_THROWING_READONLY_VIOLATION.length} 个`,
    });
  }

  return diffs;
}

/** 主流程。 */
function main(): void {
  const markdown = readDesignDoc();
  const diffs = checkContracts(markdown);

  process.stdout.write(
    '契约编号与引用数字一致性检查（C25 / C26 / §5 的 8 条 / §11.2 的错误语义）\n',
  );

  if (diffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${diffs.length} 处不一致：\n`);
    for (const diff of diffs) {
      process.stderr.write(`    ${diff.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ 契约编号与引用数字全部一致\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
