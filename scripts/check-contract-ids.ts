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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  METHODS_RETURNING_NULL,
  METHODS_THROWING_CONFLICT,
  METHODS_THROWING_NOT_FOUND,
  METHODS_THROWING_READONLY_VIOLATION,
  MISSING_IDS_KEY,
  MemoryErrorCode,
  NOT_FOUND_METHODS_WITH_MISSING_IDS,
  WARNING_ONLY_CASES,
} from '../src/core/errors.js';
import {
  CROSS_PARAM_VALIDATION_COUNT,
  CROSS_PARAM_VALIDATION_RULES,
  DEFAULT_PARAMS,
  VECTOR_OVERFETCH_FACTOR,
} from '../src/core/params.js';
import { stripComments } from './check-clock.js';
import { checkGateEntry, compareNameSets, readPackageJson } from './check-gate-entry.js';
import {
  extractBacktickSpans,
  extractSection,
  readDesignDoc,
  stripBlockquote,
} from './lib/design-doc.js';

/** §5 / §6 / §11.2 / §12 的标题行。 */
const SECTION_5_HEADING = '## 5. 参数表（集中配置）';
const SECTION_6_HEADING = '## 6. 接口设计（TypeScript 同步 API）';
const SECTION_4_2_HEADING = '### 4.2 稳定度增长（记忆加固）';
const SECTION_4_5_HEADING = '### 4.5 边权重衰减与强化';
const SECTION_7_1_HEADING = '### 7.1 定位与安全';
const SECTION_11_2_HEADING = '### 11.2 错误类型体系';
const SECTION_12_HEADING = '## 12. 实施路线图';

/**
 * ★ **写死的期望值**：`details.missingIds` 的**文档锚点**（§4.2 / §4.5 步骤 4）。
 *
 * ⚠️ 为什么锚在**这两节的正文**、而不是 §11.2 的对照表：
 *   §11.2 那张表**没有 `missingIds` 这一列**（它的三列是「情形 / 表达方式 / 涉及方法」），
 *   而「`details.missingIds` = 差集」这句话只出现在 §4.2（`touch`）与 §4.5 步骤 4（`linkByIds`）。
 *   ⇒ 锚点必须绑**原文出现的地方**，否则锚的是一个不存在的列。
 *
 * ⚠️ 另外：§11.2 对照表的**第 2 列绝不能**出现 `NOT_FOUND` / `null` / `CONFLICT` /
 *   `READONLY_VIOLATION` / `warnings` 这些关键字——`parseSection11_2Methods()` 会把
 *   第 3 列的反引号标识符当成**方法名**收进映射 ⇒ 新加表格会误伤既有门禁。
 */
export const EXPECTED_MISSING_IDS_ANCHORS: readonly {
  /** 该方法在设计稿里的锚点小节（用于核对「锚点原文确实写着 missingIds」）。 */
  section: string;
  /** 该锚点小节的标题行。 */
  heading: string;
  /** 该方法名（必须出现在锚点小节里）。 */
  method: string;
}[] = [
  { section: '§4.2', heading: SECTION_4_2_HEADING, method: 'touch' },
  { section: '§4.5 步骤 4', heading: SECTION_4_5_HEADING, method: 'linkByIds' },
];

/**
 * ★ **写死的期望值**：§11.2「缺失的表达方式对照」表的**期望分组**。
 *
 * ⚠️ 为什么不现场解析设计稿：那张表的「涉及方法」列里，
 *   `INVALID_INPUT` 与 `READONLY_VIOLATION` 两行写的是「**全部写方法**」，
 *   不是逐个方法名 ⇒ 从设计稿解析出来的名单**不完整**，
 *   用它当分母会让「少了一个方法」看起来像「全绿」（C31 的典型症状）。
 * ⇒ 期望分组**写死在这里**，代码侧的名单必须**逐名**对上。
 *
 * ⚠️ `readonly_violation` 的 16 个写方法**逐名**列在 §7.1 的
 *   「写（16 个，一律抛 `READONLY_VIOLATION`）」清单里 —— 见 `EXPECTED_READONLY_WRITE_METHODS`。
 */
export const EXPECTED_MISSING_EXPRESSION_GROUPS: Readonly<Record<string, readonly string[]>> = {
  /** 抛 `NOT_FOUND` 的方法（§11.2 第一行）。 */
  throw_not_found: [
    'forget',
    'restore',
    'updateContent',
    'pin',
    'unpin',
    'touch',
    'link',
    'linkByIds',
    'setAlias',
    'mergeEntities',
  ],
  /** 返回 `null` 的方法（§11.2 第二行）。 */
  return_null: ['get'],
  /** 抛 `CONFLICT` 的方法（§11.2 第四行）。 */
  conflict: ['restore', 'updateContent', 'setAlias'],
};

/**
 * ★ **写死的期望值**：§7.1「写（16 个，一律抛 `READONLY_VIOLATION`）」的 16 个写方法。
 *
 * ⚠️ **逐名**断言，**不是**「数量 == 16」——
 *   数量对上了但**名字对不上**是另一种假绿（C31）。
 */
export const EXPECTED_READONLY_WRITE_METHODS: readonly string[] = [
  'write',
  'touch',
  'link',
  'linkByIds',
  'forget',
  'restore',
  'pin',
  'unpin',
  'setAlias',
  'mergeEntities',
  'updateContent',
  'sweep',
  'setParams',
  'rebuildArchivalSchedule',
  'rebuildVectorBuckets',
  'recluster',
];

/**
 * ★ **写死的期望值**：§11.2 的「**不抛错**，走 `write()` 的 `warnings`」那一种情形。
 *
 * ⚠️ `ALIAS_CONFLICT` **刻意不是异常** ⇒ 它**不在**任何抛错分组里，
 *   只出现在 `WARNING_ONLY_CASES`（§11.2 末段）。
 */
export const EXPECTED_WARNING_ONLY_CASES: readonly string[] = ['ALIAS_CONFLICT'];

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

/**
 * 从 §7.1 的「写（16 个，一律抛 `READONLY_VIOLATION`）」清单里取出**逐名**的写方法。
 *
 * ⚠️ 为什么单独解析 §7.1：§11.2 的「涉及方法」列在 `READONLY_VIOLATION` 行写的是
 *   「**全部写方法**」——不是逐个名字 ⇒ 只有 §7.1 才有那份**完整名单**。
 *
 * @param markdown 设计稿全文
 * @returns 写方法名（按 §7.1 的出现顺序）
 */
export function parseSection7_1WriteMethods(markdown: string): string[] {
  const section = extractSection(markdown, SECTION_7_1_HEADING);
  const lines = section.split('\n');
  const methods: string[] = [];
  let collecting = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // ⚠️ 先剥掉引用标记：§7.1 的清单在引用块里（`> ` 前缀）。
    const stripped = stripBlockquote(line).trim();

    if (!collecting) {
      // 清单的**起始标记**：「写（16 个，一律抛 `READONLY_VIOLATION`）」
      if (stripped.includes('写（16 个')) {
        collecting = true;
      }
      continue;
    }

    // 结束标记：清单后面紧跟「⚠️ **后三个是…维护方法**」那段说明。
    if (stripped.startsWith('⚠️')) {
      break;
    }

    for (const span of extractBacktickSpans(stripped)) {
      const name = (span.split('(')[0] ?? '').trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'READONLY_VIOLATION') {
        methods.push(name);
      }
    }
  }

  return methods;
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

  // ⚠️ 三方比对：§11.2（设计稿）↔ 写死的期望分组 ↔ 代码。
  //   期望分组写死 ⇒ 即使设计稿被改坏，闸门仍会拿**外部写死**的分母去判（§11.2 的
  //   「涉及方法」列对 `READONLY_VIOLATION` 只写「全部写方法」，不能当分母用）。
  const codeGroups: Readonly<Record<string, readonly string[]>> = {
    throw_not_found: METHODS_THROWING_NOT_FOUND,
    return_null: METHODS_RETURNING_NULL,
    conflict: METHODS_THROWING_CONFLICT,
  };
  for (const [groupName, expected] of Object.entries(EXPECTED_MISSING_EXPRESSION_GROUPS)) {
    diffs.push(
      ...compareNameSets(expected, codeGroups[groupName] ?? [], `§11.2「${groupName}」的期望分组`),
    );
  }

  compare(semantics.get('throw_not_found'), METHODS_THROWING_NOT_FOUND, 'NOT_FOUND');
  compare(semantics.get('return_null'), METHODS_RETURNING_NULL, '返回 null');
  compare(semantics.get('conflict'), METHODS_THROWING_CONFLICT, 'CONFLICT');

  // ⚠️ §11.2 的 `READONLY_VIOLATION` 行写的是「全部写方法」，**不是逐个名字** ⇒
  //   它的完整名单在 §7.1 ⇒ 从 §7.1 解析出来，**逐名**比对代码侧的 16 个写方法。
  //   （不接受「数量 == 16」这种计数式断言：数量对上了但名字对不上是另一种假绿。）
  const section7_1WriteMethods = parseSection7_1WriteMethods(markdown);
  diffs.push(
    ...compareNameSets(
      EXPECTED_READONLY_WRITE_METHODS,
      section7_1WriteMethods,
      '§7.1 的写方法清单',
    ),
  );
  diffs.push(
    ...compareNameSets(
      EXPECTED_READONLY_WRITE_METHODS,
      METHODS_THROWING_READONLY_VIOLATION,
      '只读违例的写方法',
    ),
  );

  // ⚠️ `warning_only` 组：`ALIAS_CONFLICT` **刻意不是异常** ⇒
  //   ① 它在 `WARNING_ONLY_CASES` 里；② 它**不在**任何抛错分组里；
  //   ③ §11.2 的那一行确实把它标成了「不抛错、走 warnings」。
  diffs.push(
    ...compareNameSets(EXPECTED_WARNING_ONLY_CASES, WARNING_ONLY_CASES, '只走 warnings 的情形'),
  );
  const docWarningOnly = semantics.get('warning_only') ?? [];
  for (const caseName of EXPECTED_WARNING_ONLY_CASES) {
    if (!docWarningOnly.includes(caseName)) {
      diffs.push({
        reason: `§11.2 的「不抛错，走 write() 的 warnings」那一行里找不到 ${caseName}`,
      });
    }
  }
  for (const [groupName, group] of Object.entries({
    ...codeGroups,
    readonly_violation: METHODS_THROWING_READONLY_VIOLATION,
  })) {
    for (const caseName of EXPECTED_WARNING_ONLY_CASES) {
      if (group.includes(caseName)) {
        diffs.push({
          reason: `${caseName} 刻意不是异常，却出现在「${groupName}」的代码名单里`,
        });
      }
    }
  }

  // ⚠️ `missingIds` 锚点（§4.2 / §4.5）：它是 `NOT_FOUND` 分组的**详情键**，
  //   ⇒ 承载它的方法必须**都在** `NOT_FOUND` 分组里（否则 P1-T06 会写到别的方法上）。
  for (const method of NOT_FOUND_METHODS_WITH_MISSING_IDS) {
    if (!METHODS_THROWING_NOT_FOUND.includes(method)) {
      diffs.push({
        reason: `${method} 要带 details.${MISSING_IDS_KEY}，却不在 NOT_FOUND 分组里`,
      });
    }
  }

  // ⚠️ `missingIds` 的**文档锚点**：§4.2 / §4.5 步骤 4 的原文确实写着
  //   「`details.missingIds`」，且**对应方法名**也在那一节里 ⇒
  //   设计稿若把它挪走/改写，门禁当场发现（而不是让 P1-T06 按一个不存在的约定去写）。
  for (const anchor of EXPECTED_MISSING_IDS_ANCHORS) {
    const section = extractSection(markdown, anchor.heading);
    if (!section.includes(`details.${MISSING_IDS_KEY}`)) {
      diffs.push({
        reason: `${anchor.section} 里找不到「details.${MISSING_IDS_KEY}」的原文（missingIds 的锚点不见了）`,
      });
    }
    if (!section.includes(anchor.method)) {
      diffs.push({
        reason: `${anchor.section} 里找不到 ${anchor.method}（missingIds 的锚点方法不见了）`,
      });
    }
  }

  // ⚠️ 门禁入口的可见性（防「假绿闸门」）：`scripts.ci` 必须是 `pnpm run verify` 的别名，
  //   且 `scripts.verify` 必须串起全部 10 条门禁。
  for (const diff of checkGateEntry(readPackageJson())) {
    diffs.push({ reason: diff.reason });
  }

  return diffs;
}

// ─────────────────────────── 「源码实发 ⊆ 白名单」的守卫 ───────────────────────────

/**
 * ⚠️ **这条守卫补的是一个「三方比对看不见」的方向**（实测漏洞）：
 *   既有门禁做的是**三方互相比对**（写死的期望 ↔ 代码里的常量 ↔ 设计稿的表格）。
 *   ⇒ 它们保证「白名单与文档一致」，却**从不检查「源码里实际发出的 warning code 集合」**
 *   ⇒ **新加一个 warning code 而忘了登记白名单 ⇒ 门禁全绿**。
 *   实测：`src/store/write.ts` 已经有两个 warning code
 *   （`ALIAS_CONFLICT` 与 `ALIAS_TARGET_NOT_LINKED`），而三处白名单都还只有前者
 *   ⇒ `pnpm run verify` **EXIT=0**。
 *
 * ⇒ 这是 **C36「同一件事不得有两套词」**的经典漏洞：
 *   warning code 这个「键」现在有**两处**来源（源码的判别字面量 + 白名单数组），
 *   而门禁只让它们**各自与文档一致**，不保证它们**彼此一致**。
 *
 * ★ **本段的函数是纯函数、可注入**（`source` 与白名单都是入参）
 *   ⇒ 负控可以直接喂**假源码文本**，**不必去改 `src/store/write.ts`**
 *   ⇒ 守卫既可测，又不污染源码（这是它能不能被信任的关键）。
 */

/** 扫源码目录的根。 */
const SRC_ROOT = 'src';

/**
 * 剥掉注释（复用 `check-clock.ts` 的实现——**它保留换行与字符位置**）。
 *
 * ⚠️ **必须剥注释**：源码注释里大量出现 warning code 的字面量举例
 *   （「这里回一条 `ALIAS_TARGET_NOT_LINKED`」）
 *   ⇒ 不剥注释会把**举例**当成「实发」⇒ 门禁误报。
 */
function codeOnly(source: string): string {
  return stripComments(source);
}

/**
 * 扫描源码里**实际发出**的 warning code。
 *
 * ⚠️ **判据是「`code: 'XXX'` 这个形状」**，不是「文件里出现过这个字符串」
 *   ——后者会把注释里的举例、类型文档里的引用全部算进去。
 *
 * ⚠️⚠️ **扫描范围与判据，哪一个需要维护？（下一个接手者必读）**
 *
 * · **扫描范围**：守卫扫的是**整个 `src/`**（`main()` 里 `listSourceFiles()`），
 *   **不是**只扫 `src/store/write.ts` ⇒ 将来新增产出点（`merge.ts` / `link.ts` …）
 *   **自动**被扫到 ⇒ **扫描范围本身不需要维护**。
 *   · **当前事实（已核，2026-10-31）**：全库**只有 `src/store/write.ts` 产 warnings**
 *     （`src/store/` 下其余文件只在注释/类型里提到 `warnings`，**不产生 warning code**）。
 * · **需要维护的是「判据」**：它认的是「`code: 'XXX'`」这个**形状**。
 *   ⇒ 若将来新增的产出点**不用这个形状**（例如写成 `code: someVar` 动态值、
 *     或换字段名、或用常量间接引用），守卫会**看不见**那个 code
 *     ⇒ **那时必须同步扩展本函数的判据**，否则就退化成一个「只查 write.ts」的盲区。
 *
 * @param source 源码文本
 * @returns 去重后的 code 列表（排序）
 */
export function findEmittedWarningCodes(source: string): string[] {
  const codes = new Set<string>();
  const text = codeOnly(source);
  const pattern = /\bcode\s*:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g;
  let match = pattern.exec(text);
  while (match !== null) {
    codes.add(match[1] ?? '');
    match = pattern.exec(text);
  }
  return [...codes].sort();
}

/**
 * 找出「源码实发、但白名单没登记」的 warning code。
 *
 * ⚠️ **是「⊆」不是「=」**：白名单里可以有**暂时没有实发**的 code
 *   （例如设计上允许、当前还没触发的情形）⇒ 那由既有的三方比对负责。
 *
 * @param source 源码文本
 * @param whitelist 已登记的 code 名单（`WARNING_ONLY_CASES`）
 * @returns 未登记的 code（排序）
 */
export function findUnregisteredWarningCodes(
  source: string,
  whitelist: readonly string[],
): string[] {
  return findEmittedWarningCodes(source).filter((code) => !whitelist.includes(code));
}

/**
 * 守卫：源码实发的 warning code ⊆ 白名单。
 *
 * @param source 源码文本
 * @param whitelist 已登记的 code 名单
 * @returns 不一致清单（空 = 一致）
 */
export function checkWarningCodesRegistered(
  source: string,
  whitelist: readonly string[],
): ContractDiff[] {
  return findUnregisteredWarningCodes(source, whitelist).map((code) => ({
    reason:
      `源码里实发的 warning code「${code}」没有登记进白名单（src/core/errors.ts 的 WARNING_ONLY_CASES）` +
      '——§11.2「不抛错，走 write() 的 warnings」那一行必须同步登记：' +
      '否则调用方拿到一个**没人认识的 code**，而门禁此前看不见它（实测：登记缺失时 verify 仍 EXIT=0）',
  }));
}

/**
 * 扫描源码里 `new MemoryError(...)` 用到的**字面量** code。
 *
 * ⚠️ **只认两种字面量形状**：`MemoryErrorCode.X` 与 `'X'`。
 *   动态实参（`new MemoryError(someVar, …)`）**判不了** ⇒ 跳过（不误报）。
 *
 * @param source 源码文本
 * @param closedSet 封闭集合（`MemoryErrorCode` 的五个值）
 * @returns 不在封闭集合里的 code（排序）
 */
export function findUnknownMemoryErrorCodes(
  source: string,
  closedSet: readonly string[],
): string[] {
  const text = codeOnly(source);
  const found = new Set<string>();
  const patterns = [
    /new\s+MemoryError\s*\(\s*MemoryErrorCode\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /new\s+MemoryError\s*\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match !== null) {
      const code = match[1] ?? '';
      if (!closedSet.includes(code)) {
        found.add(code);
      }
      match = pattern.exec(text);
    }
  }
  return [...found].sort();
}

/**
 * 守卫：`new MemoryError(...)` 的 code 必须落在 `MemoryErrorCode` 的**封闭集合**里。
 *
 * ⚠️ §11.2 的五个 code 是**封闭集合**：凭空造一个新错误码 =
 *   给调用方一个它没学过、也没文档可查的 code
 *   ⇒ 比「抛一个未类型化的错误」更难处置。
 *
 * @param sources 参与检查的源码（文件名 + 文本）
 * @param closedSet 封闭集合
 */
export function checkMemoryErrorCodesClosed(
  sources: ReadonlyArray<{ file: string; source: string }>,
  closedSet: readonly string[],
): ContractDiff[] {
  const diffs: ContractDiff[] = [];
  for (const { file, source } of sources) {
    for (const code of findUnknownMemoryErrorCodes(source, closedSet)) {
      diffs.push({
        reason:
          `${file} 里 new MemoryError(...) 用了封闭集合之外的 code「${code}」` +
          `——§11.2 的五个 code 是封闭集合（${closedSet.join(' / ')}），` +
          '不在集合内的语义必须用 invariantError(code, …) 那种「带 code 的原样抛出」',
      });
    }
  }
  return diffs;
}

/** 列出 `src/` 下的源文件（**排除**测试文件）。 */
function listSourceFiles(root: string = SRC_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = resolve(root, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * 对一批源码跑**源码层**的两条守卫（warning code 登记 + 错误码封闭集合）。
 *
 * ⚠️ **与源码解耦（入参是「文件名 + 文本」）** ⇒ 负控可以直接喂假源码，
 *   **不必去改 `src/store/write.ts`**（那是源码，不是测试的靶子）。
 *
 * @param sources 参与检查的源码
 * @param warningWhitelist 已登记的 warning code（`WARNING_ONLY_CASES`）
 * @param errorCodeClosedSet 错误码封闭集合（`MemoryErrorCode` 的五个值）
 */
export function checkSourceContracts(
  sources: ReadonlyArray<{ file: string; source: string }>,
  warningWhitelist: readonly string[],
  errorCodeClosedSet: readonly string[],
): ContractDiff[] {
  const diffs: ContractDiff[] = [];
  for (const { file, source } of sources) {
    diffs.push(
      ...checkWarningCodesRegistered(source, warningWhitelist).map((diff) => ({
        reason: `${file}：${diff.reason}`,
      })),
    );
  }
  diffs.push(...checkMemoryErrorCodesClosed(sources, errorCodeClosedSet));
  return diffs;
}

/** 主流程。 */
function main(): void {
  const markdown = readDesignDoc();
  const diffs = checkContracts(markdown);

  // ⚠️ **新增守卫①**：源码实发的 warning code ⊆ 白名单。
  //   扫全 `src/`（不只 `write.ts`）：将来别的文件也开始产生 warnings 时同样被守住。
  // ⚠️ **新增守卫②**：`new MemoryError(...)` 的 code 必须落在封闭集合里。
  const sources = listSourceFiles().map((file) => ({
    file,
    source: readFileSync(file, 'utf8'),
  }));
  diffs.push(...checkSourceContracts(sources, WARNING_ONLY_CASES, Object.values(MemoryErrorCode)));

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
