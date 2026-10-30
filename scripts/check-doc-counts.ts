/**
 * §5 分类声明 与 §8.1 参数计数 的**性质型**断言 —— 补 `scripts/check-params.ts` 的覆盖面缺口。
 *
 * ⚠️ **本脚本必须与「勘误回写」同批落地**（依据：docs/design/DESIGN-v2-errata.md 勘误 ② 与 ③）。
 *   在回写落地**之前**，它**必然报红**：
 *   · §8.1 现在写「**53** 项参数」（应是 60）；
 *   · §5 末尾的分类声明相加 **61**（`VECTOR_ROUTER` 被两个轴各数一次）。
 *   ⇒ 先落断言 ⇒ CI 立刻红 ⇒ 极易被误读成「回写做坏了」⇒ 回写被叫停。
 *
 * ## 为什么这些断言值得存在（实测缺口）
 *
 * `scripts/check-params.ts` 只比对「§5 **表格体** ↔ `DEFAULT_PARAMS`」。
 * 实测：把 §8.1 的「53 项」改成「45 项」、把 §5 分类声明的「共激活 10 项」改成「9 项」，
 * **门禁报出 0 处差异** ⇒ 静默通过。
 * （§5 表格体本身没坏 ⇒ 比对逻辑有效，缺的只是**覆盖面**。）
 *
 * ## 三条设计纪律（都来自真实踩过的坑）
 *
 * ① **不锚具体措辞**：勘误 ② 把「向量路**开关** 2 项」改成「向量路**阈值** 1 项 = `ROUTER_MIN_TRAINING` = **9**」
 *    ⇒ 任何锚在「向量路开关」上的正则都会**失配** ⇒ 解析器抛错 ⇒ 断言在**改好之后**反而失败。
 *    ⇒ 本实现只取该 bullet 括号段里的**全部** `N 项`，与措辞无关。
 * ② **不锚粗体标记**：现行的「机制开关」那一行的 `**` **没有闭合**
 *    （只有一个 `**`，且「选择器」后有**三个**右括号）⇒ 锚在 `**…**` 上的提取会**静默漏掉这一组**
 *    ⇒ 那正是「解析器漏读伪装成一致」这一类假绿。
 *    ⇒ 本实现按**结构**取组名（去掉 bullet 前缀 ⇒ 切到第一个括号/冒号前 ⇒ 去掉星号）。
 * ③ **找不到 ⇒ 抛错，不静默跳过**：「跳过」就是「解析器漏读伪装成一致」这一类假绿。
 *
 * ## 断言的是**性质**，不是「当次的数字」
 *
 * 只断言三条性质（**不**硬编码逐组小计 ⇒ 对勘误选哪种合法拆法不敏感）：
 * ① 四组之和 + v1.0 继承 == 代码里的参数键数；
 * ② 每组**自己声明的组总数**（若写了）== 它的子项数之和；
 * ③ §8.1 自称的参数项数 == 代码里的参数键数。
 *
 * ⚠️ 「只比总和够不够？」**回写之后够**：回写把「性能」改成 9 之后，
 *   「共激活 10→9」这个负控会让总和变成 **59 ≠ 60** ⇒ 被①抓住。
 *   （在**回写前**抓不住，因为那时性能是 10 ⇒ 总和恰好仍是 60 —— 这也正是必须同批落地的另一个理由。）
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PARAM_KEYS } from '../src/core/params.js';
import { extractSection, readDesignDoc } from './lib/design-doc.js';

/** §5 的标题行。 */
const SECTION_5_HEADING = '## 5. 参数表（集中配置）';
/** §8.1 的标题行。 */
const SECTION_8_1_HEADING = '### 8.1 文本日志规范';

/** §5 分类声明的四个组（**性质分类**轴，与 §5 表格的「分组」轴不同 —— 见勘误 ② §2.3）。 */
const GROUP_NAMES = ['行为语义参数', '性能参数', '运维参数', '机制开关'] as const;

/** 一个组的解析结果。 */
export interface ParsedGroup {
  /** 该组括号段里出现的全部「N 项」（**含粗体包裹的数字**）。 */
  subs: number[];
  /** 该组**自己声明的组总数**（形如「= **9**」）；未声明则为 undefined。 */
  stated?: number;
}

/**
 * 解析 §5 分类声明的四个组。
 *
 * ⚠️ **措辞宽容 + 不锚粗体**（理由见文件头纪律 ①②）。
 *
 * @throws 找不到任何一个组 ⇒ 抛错（**不**当作「一致」）
 */
export function parseSection5Classification(markdown: string): Record<string, ParsedGroup> {
  const section = extractSection(markdown, SECTION_5_HEADING);
  const groups: Record<string, ParsedGroup> = {};

  for (const line of section.split('\n')) {
    if (!line.startsWith('> - ')) {
      continue;
    }
    // 按结构取组名：去掉 bullet 前缀 ⇒ 切到第一个括号/冒号前 ⇒ 去掉粗体星号
    const head = line.slice('> - '.length);
    const name = (head.split(/[（(:：]/)[0] ?? '').replace(/\*/g, '').trim();
    if (!GROUP_NAMES.includes(name as (typeof GROUP_NAMES)[number])) {
      continue;
    }
    // ⚠️ 文档用的是**全角**括号（`（` `）`），ASCII 括号也兼容
    const paren = /[（(]([^）)]*)[）)]/.exec(line)?.[1] ?? '';
    // 「N 项」里的 N 可能是粗体的（`**10** 项`）⇒ 先剥粗体再取数字
    const subs = [...paren.replace(/\*/g, '').matchAll(/(\d+)\s*项/g)].map((m) => Number(m[1]));
    const statedMatch = /=\s*\*{0,2}(\d+)/.exec(line);
    groups[name] = statedMatch === null ? { subs } : { subs, stated: Number(statedMatch[1]) };
  }

  for (const name of GROUP_NAMES) {
    if (groups[name] === undefined) {
      throw new Error(`§5 分类声明里找不到「${name}」这一组 ⇒ 解析失败（不能当作「一致」）`);
    }
  }

  return groups;
}

/**
 * 解析「v1.0 继承」项数（§5 末尾「参数总数：29（v1.0）→ 60（v2.1）」）。
 *
 * @throws 找不到 ⇒ 抛错
 */
export function parseInheritedCount(markdown: string): number {
  const section = extractSection(markdown, SECTION_5_HEADING);
  const match = /参数总数：(\d+)（v1\.0）/.exec(section);
  if (match === null) {
    throw new Error('§5 里找不到「参数总数：N（v1.0）」⇒ 解析失败（不能当作「一致」）');
  }
  return Number(match[1]);
}

/**
 * 解析 §8.1「config 事件的 `params` 是 N 项参数的完整生效快照」里的 N。
 *
 * ⚠️ **不要求 N 不带粗体**：勘误 ③ 的改后文本是「它是 **60** 项参数的**完整生效快照**」
 * ⇒ 严格正则在**改好之后**反而失配。
 *
 * @throws 找不到 ⇒ 抛错
 */
export function parseSection81ParamCount(markdown: string): number {
  const section = extractSection(markdown, SECTION_8_1_HEADING);
  const match = /它是 \*{0,2}(\d+)\*{0,2} 项参数的\*\*完整生效快照\*\*/.exec(section);
  if (match === null) {
    throw new Error('§8.1 里找不到「N 项参数的完整生效快照」⇒ 解析失败（不能当作「一致」）');
  }
  return Number(match[1]);
}

/** 一处不一致。 */
export interface DocCountDiff {
  reason: string;
}

/**
 * 断言「文档里自称的参数计数」与代码里的真实键数一致。
 *
 * @param markdown 设计稿全文
 * @param expectedKeyCount 代码里的参数键数（= `PARAM_KEYS.length`）
 */
export function checkDocCounts(markdown: string, expectedKeyCount: number): DocCountDiff[] {
  const diffs: DocCountDiff[] = [];

  const groups = parseSection5Classification(markdown);
  const inherited = parseInheritedCount(markdown);

  // ① 四组之和 + v1.0 继承 == 真实键数（**性质**：不依赖任何一种具体拆法）
  let sum = inherited;
  for (const name of GROUP_NAMES) {
    const group = groups[name];
    const groupSum = (group?.subs ?? []).reduce((a, b) => a + b, 0);
    sum += groupSum;
    // ② 每组**自己声明的组总数**（若写了）== 它的子项数之和
    if (group?.stated !== undefined && group.stated !== groupSum) {
      diffs.push({
        reason: `§5「${name}」声明的组总数 ${group.stated} ≠ 它的子项数之和 ${groupSum}`,
      });
    }
  }
  if (sum !== expectedKeyCount) {
    diffs.push({
      reason: `§5 分类声明的四组之和 + v1.0 继承 = ${sum} ≠ 代码里的参数键数 ${expectedKeyCount}`,
    });
  }

  // ③ §8.1 自称的参数项数 == 真实键数
  const section81Count = parseSection81ParamCount(markdown);
  if (section81Count !== expectedKeyCount) {
    diffs.push({
      reason: `§8.1 称 params 是 ${section81Count} 项参数的完整生效快照 ≠ 代码里的 ${expectedKeyCount} 项`,
    });
  }

  return diffs;
}

/**
 * 打印报告并返回**不一致的条数**（0 = 一致）。
 *
 * ⚠️ 返回值而不是直接 `process.exit` ⇒ 便于单测断言（纯函数 + 可测的 CLI）。
 */
export function reportDocCounts(markdown: string, expectedKeyCount: number): number {
  const diffs = checkDocCounts(markdown, expectedKeyCount);
  if (diffs.length === 0) {
    process.stdout.write(`✓ §5 分类声明与 §8.1 的参数计数与代码一致（${expectedKeyCount} 项）\n`);
    return 0;
  }
  process.stderr.write(`✗ 发现 ${diffs.length} 处参数计数不一致：\n`);
  for (const diff of diffs) {
    process.stderr.write(`    ${diff.reason}\n`);
  }
  return diffs.length;
}

/**
 * CLI 入口：读设计稿 → 断言 → 返回**退出码**。
 *
 * ⚠️ `--doc <path>` 只为**测试**能指向别的文档（真实运行用默认路径）。
 */
export function runCli(argv: readonly string[] = []): number {
  const docIndex = argv.indexOf('--doc');
  const docPath = docIndex >= 0 ? (argv[docIndex + 1] ?? '') : '';
  const markdown = docPath === '' ? readDesignDoc() : readFileSync(resolve(docPath), 'utf8');
  const diffs = reportDocCounts(markdown, PARAM_KEYS.length);
  return diffs === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
