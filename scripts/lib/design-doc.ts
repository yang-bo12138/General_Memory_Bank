/**
 * DESIGN-v2.md 的解析工具 —— 供 `scripts/check-*.ts` 复用。
 *
 * ⚠️ **解析 Markdown 表格是件脏活**，但它是「文档与代码不一致时当场失败」的唯一办法：
 *   §5 的参数表、§8.4 的 payload 键集、§11.2 的错误语义表、§14.3.1 的锚定表
 *   都是**写给人看的表**，只有把它们机械地读出来跟代码比，「漂移」才拦得住。
 *
 * ⚠️ 解析规则必须**写死并有单测**（见 `tests/contracts/design-doc.test.ts`）——
 *   否则「解析器把某一行漏掉了」会伪装成「文档与代码一致」。
 */

import { readFileSync } from 'node:fs';

/** 设计稿的路径（相对仓库根）。 */
export const DESIGN_DOC_PATH = 'docs/design/DESIGN-v2.md';

/** 读设计稿全文。 */
export function readDesignDoc(path: string = DESIGN_DOC_PATH): string {
  return readFileSync(path, 'utf8');
}

/**
 * 取出某个小节的正文（从该标题行到**同级或更高级**标题行之前）。
 *
 * @param markdown 全文
 * @param heading 标题行（**逐字**，含井号与空格），例如 `## 5. 参数表（集中配置）`
 */
export function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading.trim());
  if (start < 0) {
    throw new Error(`设计稿里找不到标题：${heading}`);
  }
  const level = (heading.match(/^#+/) ?? ['#'])[0]?.length ?? 1;

  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(#+)\s/.exec(line);
    if (match !== null && (match[1] ?? '#').length <= level) {
      break;
    }
    collected.push(line);
  }
  return collected.join('\n');
}

/**
 * 去掉行首的引用标记（`> ` / `>> `）。
 *
 * ⚠️ §5 的「五个机制开关」表写在**引用块**里（`> | \`coactivation\` | true | ... |`），
 *   不去掉引用标记就认不出那是表格行 ⇒ 5 个机制开关会被整段漏掉。
 */
export function stripBlockquote(line: string): string {
  return line.replace(/^\s*(?:>\s?)+/, '');
}

/**
 * 取出小节里的**全部**表格行（不区分表头/表体）。
 *
 * ⚠️ 为什么不用「表头 + 表体」的结构：
 *   §5 的第二张表被中间的「五个机制开关」引用块与 CI 断言段落**打断**，
 *   后半段（分桶路由 7 项）**没有自己的表头**——
 *   若按「第一行是表头」处理，那 7 行会被当成表头丢掉，参数就只剩 53 项。
 *
 * @returns 全部表格行（已剔除分隔行）
 */
export function parseAllTableRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split('\n')) {
    const stripped = stripBlockquote(line).trim();
    if (!stripped.startsWith('|')) {
      continue;
    }
    const cells = splitTableRow(stripped);
    if (isSeparatorRow(cells)) {
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 拆一行 markdown 表格为单元格。
 *
 * ⚠️ 必须处理**转义竖线**（`\|`）——§8.4 的 sweep 行里有
 *   `action('purge'\|'rebuildArchive'\|...)`，直接按 `|` 拆会把单元格切碎。
 */
export function splitTableRow(line: string): string[] {
  // 用一个不会出现在正文里的占位符替换转义竖线，拆完再还原
  const withoutEscapes = line.replace(/\\\|/g, ESCAPED_PIPE_PLACEHOLDER);
  const trimmed = withoutEscapes.trim();
  if (!trimmed.startsWith('|')) {
    return [];
  }
  const body = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined);
  return body
    .split('|')
    .map((cell) => cell.trim().replaceAll(ESCAPED_PIPE_PLACEHOLDER, '|').trim());
}

/** 转义竖线的占位符（不会出现在正文里）。 */
const ESCAPED_PIPE_PLACEHOLDER = '\u0001';

/** 一张 markdown 表格。 */
export interface MarkdownTable {
  /** 表头单元格。 */
  header: string[];
  /** 数据行（已剔除分隔行）。 */
  rows: string[][];
}

/**
 * 解析一个小节里的**所有** markdown 表格。
 *
 * ⚠️ 只认「连续以 `|` 开头的行」构成一张表；分隔行（`|---|---|`）被剔除。
 */
export function parseMarkdownTables(section: string): MarkdownTable[] {
  const lines = section.split('\n');
  const tables: MarkdownTable[] = [];

  let current: string[][] = [];
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const [header, ...rest] = current;
    tables.push({ header: header ?? [], rows: rest });
    current = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      current.push(splitTableRow(line));
      continue;
    }
    flush();
  }
  flush();

  return tables;
}

/** 判断一行是不是表格的分隔行（`| --- | :--- |`）。 */
export function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/**
 * 解析小节里的表格，**剔除分隔行**。
 */
export function parseTablesWithoutSeparators(section: string): MarkdownTable[] {
  return parseMarkdownTables(section).map((table) => ({
    header: table.header,
    rows: table.rows.filter((row) => !isSeparatorRow(row)),
  }));
}

/**
 * 找出所有形如 `` `IDENT` `` 的**完整**反引号片段。
 *
 * ⚠️ 用正则逐个匹配而不是按反引号切分：后者会把「奇数个反引号」的段落算错。
 */
export function extractBacktickSpans(text: string): string[] {
  const spans: string[] = [];
  const regex = /`([^`\n]+)`/g;
  let match = regex.exec(text);
  while (match !== null) {
    spans.push(match[1] ?? '');
    match = regex.exec(text);
  }
  return spans;
}

/**
 * 按**括号深度**切分字符串（逗号分隔）。
 *
 * ⚠️ 不能直接 `split(',')`：`changed: Array<{ key, from, to }>` 里也有逗号。
 */
export function splitByTopLevelComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[' || char === '{' || char === '<') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}' || char === '>') {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

/** 解析一个「默认值」单元格的文本。 */
export type DefaultValue = string | number | boolean;

/**
 * 解析 §5 的「默认值」单元格。
 *
 * ⚠️ 单元格里的文本带单位（`180 天`、`1.0 天`、`3600000`）⇒ 只取数值部分。
 *   `'auto'` 是字符串（带引号），`true` / `false` 是布尔。
 *
 * @returns 解析结果；解析不出来时返回 undefined（调用方据此跳过该行）
 */
export function parseDefaultCell(cell: string): DefaultValue | undefined {
  const text = cell.trim();
  if (text === '') {
    return undefined;
  }
  const quoted = /^'(.+)'$/.exec(text);
  if (quoted !== null) {
    return quoted[1] ?? '';
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  const numeric = /^(-?\d+(?:\.\d+)?)\s*[^0-9a-zA-Z]*$/.exec(text);
  if (numeric !== null) {
    return Number(numeric[1]);
  }
  return undefined;
}

/**
 * 从一段文本里抽出「键名列表」（§8.4 的 payload 字段列）。
 *
 * 规则（写死，逐条可测）：
 * 1. 取所有反引号片段；
 * 2. 每个片段按**括号深度**切分逗号；
 * 3. 每个条目取其**前导标识符**；
 * 4. 条目若是 `IDENT: 值` 形态 ⇒ **只有**值为 `Array<...>` 时才采纳（`changed: Array<{...}>` 是键，
 *    `diagnostics: true` 不是）；否则跳过；
 * 5. 条目若是 `IDENT(...)` 形态 ⇒ 括号里必须含**带引号的字符串**才采纳
 *    （`action('set'/'merge')` 是键，`setParams()` 不是）；
 * 6. 去掉尾部的 `?` 与 `[]`。
 *
 * @param text 单元格文本
 * @param excluded 需要排除的词（§8.4 正文里出现但不是 payload 键的词）
 */
export function extractPayloadKeys(text: string, excluded: readonly string[] = []): string[] {
  const keys = new Set<string>();
  for (const span of extractBacktickSpans(text)) {
    for (const item of splitByTopLevelComma(span)) {
      if (item === '') {
        continue;
      }
      const colonIndex = item.indexOf(':');
      const parenIndex = item.indexOf('(');
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(item);
      if (nameMatch === null) {
        continue;
      }
      const name = nameMatch[1] ?? '';

      if (colonIndex >= 0 && (parenIndex < 0 || colonIndex < parenIndex)) {
        // `IDENT: 值` 形态 ⇒ 只有 `Array<...>` 才是键
        const value = item.slice(colonIndex + 1).trim();
        if (!value.startsWith('Array<')) {
          continue;
        }
      } else if (parenIndex >= 0) {
        // `IDENT(...)` 形态 ⇒ 括号里必须有带引号的字符串
        const inner = item.slice(parenIndex + 1, item.lastIndexOf(')'));
        if (!/['"]/.test(inner)) {
          continue;
        }
      }

      if (excluded.includes(name)) {
        continue;
      }
      keys.add(name);
    }
  }
  return [...keys].sort();
}
