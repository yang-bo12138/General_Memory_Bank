#!/usr/bin/env tsx
/**
 * 跨节锚定检查 —— DESIGN-v2.md §14.3.1 末的「机器可检」清单（5 行 × 3 列）。
 *
 * > 「对每一条『在 §A 声明的规则』，全文搜索它的**动作关键词**，
 * > 断言每个『该规则管辖的代码路径』都在动作关键词的**同一代码块内**出现该动作。」
 *
 * ⚠️ **这类错误比缺行更危险**：缺行会报错，而**错列会静默地校验通过**。
 * ⇒ 脚本里这五行的**路径写死为常量**，不接受配置。
 *
 * ⚠️ 本脚本在阶段 0 只做**清单自身**的校验（三列结构 + 五行内容与写死常量一致）；
 *   「动作关键词是否出现在管辖路径的代码块内」需要真实实现文件，阶段 1 起才有对象可查
 *   （届时把 `EXPECTED_ANCHOR_ROWS` 的路径映射到实际文件即可）。
 *
 * 用法：`pnpm exec tsx scripts/check-anchor.ts`
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  extractSection,
  isSeparatorRow,
  parseMarkdownTables,
  readDesignDoc,
} from './lib/design-doc.js';

/** §14.3.1 的标题行。 */
const SECTION_14_3_1_HEADING = '### 14.3.1 契约清单（本次审查沉淀）';

/** 锚定表的表头（必须恰好三列）。 */
const ANCHOR_HEADER = ['规则', '动作关键词', '管辖路径'];

/**
 * ★ **写死的**五行锚定清单（§14.3.1 末的表，逐字抄）。
 *
 * ⚠️ 路径**不接受配置**——「错列会静默地校验通过」，
 *   只有把它钉成常量，文档里改错了列才会被 CI 抓住。
 */
export const EXPECTED_ANCHOR_ROWS: readonly string[][] = [
  [
    '桶归属同步',
    '`vector_cell_members` / `assignBucket` / `unassignBucket`',
    '§4.9 步骤 2 / §4.9 步骤 3c ② / §4.9 步骤 4 / §4.9.1 步骤 4（**四条 embedding 赋值路径一条都不能漏**）',
  ],
  [
    '探针覆盖',
    '吻合率 / 只漏不错',
    '§4.15.3 选型表 / §4.15.4 ②③ / §4.6 步骤 2c / §4.9 步骤 3a2 / ADR-16 / ADR-17',
  ],
  [
    'reinforce 边界',
    "不建共激活边 / `'reinforce'` / `coacts`",
    '§4.2 / §4.6 步骤 4 / §6 / §8.4 / §0.2.2 / §0.2.3',
  ],
  [
    '向量路缺席',
    '`mode` / `absent` / `inRetrain`',
    '§4.6 步骤 0d / §4.6 步骤 2c / §4.15.6 / §6 / §7.2 面板 1 / §7.3 状态表 / §0.2.3 ④',
  ],
  [
    '切分触发量',
    '原始分量占比 / `maxRawComponentRatio`',
    '§4.12.4 ③ / §6 / §3 `cluster_snapshot_meta` / §7.2 面板 7',
  ],
];

/** 规范化单元格（去掉 markdown 粗体标记、压缩空白）——只比内容，不比排版。 */
export function normalizeCell(cell: string): string {
  return cell.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** 从 §14.3.1 里找出锚定表（表头为 `规则 / 动作关键词 / 管辖路径` 的那张）。 */
export function findAnchorTable(markdown: string): string[][] | undefined {
  const section = extractSection(markdown, SECTION_14_3_1_HEADING);
  for (const table of parseMarkdownTables(section)) {
    const header = table.header.map((cell) => normalizeCell(cell));
    if (
      header.length === ANCHOR_HEADER.length &&
      header.every((cell, i) => cell === ANCHOR_HEADER[i])
    ) {
      // ⚠️ 必须剔除分隔行（`| --- | --- | --- |`）——它会让行数多出 1，整张表错位
      return table.rows.filter((row) => !isSeparatorRow(row));
    }
  }
  return undefined;
}

/** 一处差异。 */
export interface AnchorDiff {
  /** 差异说明。 */
  reason: string;
}

/** 比对锚定表与写死的期望。 */
export function compareAnchorRows(rows: string[][]): AnchorDiff[] {
  const diffs: AnchorDiff[] = [];

  if (rows.length !== EXPECTED_ANCHOR_ROWS.length) {
    diffs.push({
      reason: `行数不一致：§14.3.1 有 ${rows.length} 行，写死的期望是 ${EXPECTED_ANCHOR_ROWS.length} 行`,
    });
  }

  const count = Math.min(rows.length, EXPECTED_ANCHOR_ROWS.length);
  for (let index = 0; index < count; index += 1) {
    const actual = rows[index] ?? [];
    const expected = EXPECTED_ANCHOR_ROWS[index] ?? [];

    if (actual.length !== ANCHOR_HEADER.length) {
      diffs.push({
        reason: `第 ${index + 1} 行有 ${actual.length} 列，**每行必须只有 3 列**（多出的列会让按列解析的校验脚本取错列）`,
      });
      continue;
    }

    for (let column = 0; column < ANCHOR_HEADER.length; column += 1) {
      const actualCell = normalizeCell(actual[column] ?? '');
      const expectedCell = normalizeCell(expected[column] ?? '');
      if (actualCell !== expectedCell) {
        diffs.push({
          reason:
            `第 ${index + 1} 行第 ${column + 1} 列（${ANCHOR_HEADER[column]}）不一致：\n` +
            `      §14.3.1：${actualCell}\n` +
            `      写死的期望：${expectedCell}`,
        });
      }
    }
  }

  return diffs;
}

/** 主流程。 */
function main(): void {
  const markdown = readDesignDoc();
  const rows = findAnchorTable(markdown);

  process.stdout.write('跨节锚定检查（5 行 × 3 列）\n');

  if (rows === undefined) {
    process.stderr.write(
      '\n✗ 在 §14.3.1 里找不到锚定表（表头应为 规则 / 动作关键词 / 管辖路径）\n',
    );
    process.exitCode = 1;
    return;
  }

  const diffs = compareAnchorRows(rows);
  if (diffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${diffs.length} 处不一致：\n`);
    for (const diff of diffs) {
      process.stderr.write(`    ${diff.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ 跨节锚定清单：5 行 × 3 列，且与写死的期望一致\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
