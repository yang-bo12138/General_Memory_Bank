#!/usr/bin/env tsx
/**
 * §5 ↔ `DEFAULT_PARAMS` 的逐键逐值比对 —— DESIGN-v2.md §5 的 **G26 验收断言**。
 *
 * > 「§5 表与 `DEFAULT_PARAMS` 必须**逐键逐值相等**（键集合相同、值相同、默认值相同）。」
 * > 「⇒ 「§5 是写给人看的表、`DEFAULT_PARAMS` 是代码里的真相」——
 * > 两边不一致时**实现者照哪边写都行**，而这类漂移**极难在实现期被发现**
 * > （参数名对、值不同 ⇒ 行为不同但无报错）。」
 *
 * ⚠️ 本脚本**从 DESIGN-v2.md 的 §5 表里自动解析**出 60 项的默认值，
 *   再与 `src/core/params.ts` 的 `DEFAULT_PARAMS` 比对——
 *   它与 `src/core/params.test.ts` 里的「§6 代码块独立副本」互为**两份独立证据**。
 *
 * 用法：`pnpm exec tsx scripts/check-params.ts`
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_PARAMS, PARAM_KEYS } from '../src/core/params.js';
import {
  type DefaultValue,
  extractSection,
  parseAllTableRows,
  parseDefaultCell,
  readDesignDoc,
} from './lib/design-doc.js';

/** §5 的标题行。 */
const SECTION_5_HEADING = '## 5. 参数表（集中配置）';

/** 从 §5 的两张表里解析出「参数名 → 默认值」。 */
/**
 * §5 参数表 → 参数名 → 默认值，**外加「解析不出来」的名单**。
 *
 * ⚠️⚠️ **v2.1（P2 QA 第二轮 F1 修正）——「静默跳过」是这里最危险的写法**：
 *   原实现遇到 `parseDefaultCell` 返回 `undefined` 就 `continue` ⇒
 *   ⇒ **整行被静默跳过** ⇒ 而 §5 是参数的**权威表**（G26 原话）
 *   ⇒ ⇒ 「设计稿承诺了、代码没做」这一整类在 §5 上**隐形**
 *   ⇒   （QA 实测：§5 加一行默认值 `1e-8` ⇒ `check:params` / `check:doc-counts` / 单测 **全绿**）
 *   ⇒ ⇒ 而且这个盲区是**单向的**（代码加键 ⇒ 红；§5 加行 ⇒ 可能绿）⇒ 最坏的那种。
 *   ⇒ ⇒ 现在：**解析不出来的参数名进 `unparsed` 名单** ⇒ 由 `check:params` **显式报错**。
 *   ⇒   （第一道防线是 `parseDefaultCell` 认得更多写法；第二道防线是这份名单 ⇒ 双保险。）
 */
export function parseSection5ParamsWithUnparsed(markdown: string): {
  params: Map<string, DefaultValue>;
  /** 认不出来的参数名（默认值那格无法解析）⇒ **必须**报出来，不许静默跳过。 */
  unparsed: string[];
} {
  const section = extractSection(markdown, SECTION_5_HEADING);
  const result = new Map<string, DefaultValue>();
  const unparsed: string[] = [];

  for (const row of parseAllTableRows(section)) {
    {
      // 规则：第一个**整格**形如 `` `IDENT` `` 的单元格是参数名，它后面一格是默认值
      const nameIndex = row.findIndex(
        (cell) => /^`[A-Za-z_][A-Za-z0-9_]*`$/.test(cell) && !cell.includes(' '),
      );
      if (nameIndex < 0) {
        continue;
      }
      const name = (row[nameIndex] ?? '').replace(/`/g, '');
      const defaultCell = row[nameIndex + 1];
      if (defaultCell === undefined) {
        continue;
      }
      const value = parseDefaultCell(defaultCell);
      if (value === undefined) {
        // ⚠️ **不静默跳过** ⇒ 记下来 ⇒ 由门禁报错。
        unparsed.push(`${name}（默认值那格写的是「${defaultCell.trim()}」）`);
        continue;
      }
      result.set(name, value);
    }
  }

  return { params: result, unparsed };
}

/** §5 参数表 → 参数名 → 默认值（**只取能解析出来的**；解析不出来的见 `parseSection5ParamsWithUnparsed`）。 */
export function parseSection5Params(markdown: string): Map<string, DefaultValue> {
  return parseSection5ParamsWithUnparsed(markdown).params;
}

/** 一处差异。 */
export interface ParamDiff {
  key: string;
  /** §5 表里的值（缺失时为 undefined）。 */
  doc: DefaultValue | undefined;
  /** 代码里的值（缺失时为 undefined）。 */
  code: DefaultValue | undefined;
  /** 差异说明。 */
  reason: string;
}

/** 比对 §5 与 `DEFAULT_PARAMS`，返回全部差异。 */
export function compareParams(
  docParams: Map<string, DefaultValue>,
  codeParams: Record<string, DefaultValue>,
): ParamDiff[] {
  const diffs: ParamDiff[] = [];

  for (const [key, docValue] of docParams) {
    if (!(key in codeParams)) {
      diffs.push({
        key,
        doc: docValue,
        code: undefined,
        reason: '§5 表里有这个键，但 DEFAULT_PARAMS 里没有',
      });
      continue;
    }
    const codeValue = codeParams[key];
    if (codeValue !== docValue) {
      diffs.push({
        key,
        doc: docValue,
        code: codeValue,
        reason: `默认值不一致：§5 = ${JSON.stringify(docValue)}，DEFAULT_PARAMS = ${JSON.stringify(codeValue)}`,
      });
    }
  }

  // ⚠️ 遍历**传入的** codeParams 的键（不是 DEFAULT_PARAMS 的键）——
  //   否则「代码里多了一个键」这件事根本不会被发现。
  for (const key of Object.keys(codeParams)) {
    if (!docParams.has(key)) {
      diffs.push({
        key,
        doc: undefined,
        code: codeParams[key],
        reason: 'DEFAULT_PARAMS 里有这个键，但 §5 表里没有',
      });
    }
  }

  return diffs;
}

/** 主流程。 */
function main(): void {
  const markdown = readDesignDoc();
  const { params: docParams, unparsed } = parseSection5ParamsWithUnparsed(markdown);
  const codeParams = DEFAULT_PARAMS as unknown as Record<string, DefaultValue>;

  process.stdout.write('G26 · §5 表 ↔ DEFAULT_PARAMS 逐键逐值比对\n');
  process.stdout.write(`  §5 解析出的参数条数：${docParams.size}\n`);
  process.stdout.write(`  DEFAULT_PARAMS 的键数：${PARAM_KEYS.length}\n`);

  // ⚠️⚠️ **F1 的第二道防线**：§5 里有**认不出来的默认值写法** ⇒ **必须报红**。
  //   （第一道防线：`parseDefaultCell` 认得更多写法 ⇒ 常见的写法正常参与比对。
  //     第二道防线：这一条 ⇒ 将来出现新写法时，**绝不静默跳过整行**。）
  if (unparsed.length > 0) {
    process.stderr.write(
      `\n✗ §5 表里有 ${unparsed.length} 个参数的默认值**无法解析**（不许静默跳过）：\n`,
    );
    for (const item of unparsed) {
      process.stderr.write(`    ${item}\n`);
    }
    process.stderr.write(
      '  ⇒ 这些参数**没有参与**逐键逐值比对 ⇒ 门禁对它们**完全失明**。\n' +
        '  ⇒ 请把默认值写成可解析的形式（字符串用单引号 / true / false / 数字 / 科学计数法），\n' +
        '  ⇒ 或在 `scripts/lib/design-doc.ts` 的 `parseDefaultCell` 里补上该写法的解析。\n',
    );
    process.exit(1);
  }

  const diffs = compareParams(docParams, codeParams);

  if (diffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${diffs.length} 处不一致：\n`);
    for (const diff of diffs) {
      process.stderr.write(`    ${diff.key}：${diff.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (docParams.size !== PARAM_KEYS.length) {
    process.stderr.write(
      `\n✗ 条数不一致：§5 解析出 ${docParams.size} 项，DEFAULT_PARAMS 有 ${PARAM_KEYS.length} 项（§5 声明共 60 项）\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ §5 表与 DEFAULT_PARAMS 逐键逐值相等\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
