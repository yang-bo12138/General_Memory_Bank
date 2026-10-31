#!/usr/bin/env tsx
/**
 * §8.4 的 payload 键集 ↔ 代码的 payload 键集 —— DESIGN-v2.md §5 的 CI 断言（形态：payload 键集断言）。
 *
 * > 「**payload 键集断言**：解析 §8.4 的 touch / merge 字段表 ⇒ 比对 §4.2 / §4.9 三处
 * > payload 字面量的键集 ⇒ **缺键即报错**」
 * > 「⇒ ★ **这一条能一次性堵住『§8.4 声明了、实现点没有』这一整类缺陷**」
 *
 * 用法：`pnpm exec tsx scripts/check-payload-keys.ts`
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EVENT_PAYLOAD_KEYS,
  EVENT_PAYLOAD_VARIANTS,
  EVENT_TYPES,
  type EventType,
} from '../src/core/events.types.js';
import {
  extractPayloadKeys,
  extractSection,
  parseAllTableRows,
  readDesignDoc,
} from './lib/design-doc.js';

/** §8.4 的标题行。 */
const SECTION_8_4_HEADING = '### 8.4 事件类型与发射点对照表（枚举必须逐个落地）';

/**
 * §8.4 正文里出现、但**不是** payload 键的词。
 *
 * ⚠️ sweep 行的说明文字里有「`memory_id` 一律填 null」——那是**列**的说明，不是 payload 键。
 *   不排除它，sweep 的键集就会多出一个键 ⇒ 每次跑都误报。
 */
export const NON_PAYLOAD_TOKENS: readonly string[] = ['memory_id', 'events'];

/** 从 §8.4 的正文里解析出「action 分组」的字段集（硬规则 4）。 */
export function parseSweepActionGroups(section: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const regex = /`action='([A-Za-z]+)'`\s*→\s*`([^`]+)`/g;
  let match = regex.exec(section);
  while (match !== null) {
    const action = match[1] ?? '';
    const keys = (match[2] ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '');
    groups[action] = keys;
    match = regex.exec(section);
  }
  return groups;
}

/** 从 §8.4 的表里解析出「type → payload 键集」。 */
export function parseSection8_4PayloadKeys(markdown: string): Map<EventType, string[]> {
  const section = extractSection(markdown, SECTION_8_4_HEADING);
  const result = new Map<EventType, string[]>();

  for (const row of parseAllTableRows(section)) {
    const typeCell = row[0] ?? '';
    const typeMatch = /^`([a-z_]+)`$/.exec(typeCell);
    if (typeMatch === null) {
      continue;
    }
    const type = typeMatch[1] as EventType;
    if (!EVENT_TYPES.includes(type)) {
      continue;
    }
    const payloadCell = row[3] ?? '';
    const keys = extractPayloadKeys(payloadCell, NON_PAYLOAD_TOKENS);
    result.set(type, keys);
  }

  // 硬规则 4：sweep 的 payload 按 action 分组写清字段集 ⇒ 把这些键并进 sweep 的键集
  const sweepKeys = result.get('sweep') ?? [];
  const actionGroups = parseSweepActionGroups(section);
  for (const keys of Object.values(actionGroups)) {
    for (const key of keys) {
      if (!sweepKeys.includes(key)) {
        sweepKeys.push(key);
      }
    }
  }
  result.set('sweep', sweepKeys.sort());

  return result;
}

/** 一处差异。 */
export interface PayloadKeyDiff {
  type: EventType;
  /** §8.4 声明的键（缺失时为 undefined）。 */
  doc: string[] | undefined;
  /** 代码声明的键（缺失时为 undefined）。 */
  code: string[] | undefined;
  reason: string;
}

/** 比对 §8.4 与代码的 payload 键集。 */
export function comparePayloadKeys(
  docKeys: Map<EventType, string[]>,
  codeKeys: Readonly<Record<EventType, readonly string[]>>,
): PayloadKeyDiff[] {
  const diffs: PayloadKeyDiff[] = [];

  for (const type of EVENT_TYPES) {
    const doc = docKeys.get(type);
    const code = codeKeys[type];
    if (doc === undefined) {
      diffs.push({ type, doc: undefined, code: [...code], reason: '§8.4 的表里没有这一行' });
      continue;
    }
    const missing = doc.filter((key) => !code.includes(key));
    const extra = code.filter((key) => !doc.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      diffs.push({
        type,
        doc,
        code: [...code],
        reason:
          missing.length > 0 || extra.length > 0
            ? `键集不一致：§8.4 有而代码没有 [${missing.join(', ')}]；代码有而 §8.4 没有 [${extra.join(', ')}]`
            : '键集不一致',
      });
    }
  }

  return diffs;
}

/** 检查「各变体的键集并集 == 该 type 的键集」。 */
export function compareVariants(): PayloadKeyDiff[] {
  const diffs: PayloadKeyDiff[] = [];
  for (const [type, variants] of Object.entries(EVENT_PAYLOAD_VARIANTS)) {
    const eventType = type as EventType;
    const union = new Set<string>();
    for (const keys of Object.values(variants ?? {})) {
      for (const key of keys) {
        union.add(key);
      }
    }
    const declared = new Set(EVENT_PAYLOAD_KEYS[eventType]);
    const missing = [...union].filter((key) => !declared.has(key));
    const extra = [...declared].filter((key) => !union.has(key));
    if (missing.length > 0 || extra.length > 0) {
      diffs.push({
        type: eventType,
        doc: [...union].sort(),
        code: [...declared].sort(),
        reason: `变体键集的并集与该 type 的键集不一致：变体多出 [${missing.join(', ')}]；键集多出 [${extra.join(', ')}]`,
      });
    }
  }
  return diffs;
}

/**
 * ★ **硬规则 4 的 action 级比对**（v2.1 / P2-T05 收口时补上）。
 *
 * ⚠️ **为什么必须补这条**（这是「门禁只比对了一部分」的典型盲区）：
 *   `parseSweepActionGroups()` 早就能从 §8.4 解析出「每个 action 各自的字段集」，
 *   但它此前**只被用来把这些键并进 sweep 的总键集** ⇒
 *   ⇒ **action 级字段集本身零比对** ⇒ 硬规则 4（「payload 按 action 分组写清字段集」）
 *     **只靠自觉**：代码里把 `action='rebuildBuckets'` 的字段集改成任意字段集，
 *     只要**并集**仍覆盖 sweep 的总键集 ⇒ 门禁**照样全绿**。
 *   ⇒ 后果：写 `rebuildBuckets` 事件时可以填**本次根本没发生的事实**（= 伪造）
 *     ⇒ 而事件是审计依据 ⇒ 审计记录会撒谎且**无人发现**。
 *
 * ⇒ 本函数做**双向**比对：§8.4 的每个 action ⇒ 代码里必须存在、且字段集**恰好相等**。
 *
 * @param docGroups §8.4 解析出的 `action → 字段集`
 * @param codeVariants 代码侧的变体键集（`EVENT_PAYLOAD_VARIANTS['sweep']`）
 * @returns 每一处差异
 */
export function compareActionGroups(
  docGroups: Record<string, string[]>,
  codeVariants: Record<string, readonly string[]> | undefined,
): PayloadKeyDiff[] {
  const diffs: PayloadKeyDiff[] = [];
  const variants = codeVariants ?? {};
  for (const [action, docKeys] of Object.entries(docGroups)) {
    const codeKeys = variants[`action_${action}`];
    if (codeKeys === undefined) {
      diffs.push({
        type: 'sweep',
        doc: docKeys,
        code: undefined,
        reason: `§8.4 规定了 action='${action}' 的字段集，但代码里没有 \`action_${action}\` 这个变体`,
      });
      continue;
    }
    const docSet = new Set(docKeys);
    const codeSet = new Set(codeKeys);
    const missing = [...docSet].filter((key) => !codeSet.has(key));
    const extra = [...codeSet].filter((key) => !docSet.has(key));
    if (missing.length > 0 || extra.length > 0) {
      diffs.push({
        type: 'sweep',
        doc: [...docSet].sort(),
        code: [...codeSet].sort(),
        reason: `action='${action}' 的字段集与 §8.4 不一致：代码缺少 [${missing.join(', ')}]；代码多出 [${extra.join(', ')}]`,
      });
    }
  }
  // 反向：代码里存在、但 §8.4 没规定的 action ⇒ 报出来（不许「偷偷加一个 action」）
  for (const key of Object.keys(variants)) {
    if (!key.startsWith('action_')) {
      continue;
    }
    const action = key.slice('action_'.length);
    if (docGroups[action] === undefined) {
      diffs.push({
        type: 'sweep',
        doc: undefined,
        code: [...(variants[key] ?? [])].sort(),
        reason: `代码里有 action='${action}' 这个变体，但 §8.4 没有规定它的字段集`,
      });
    }
  }
  return diffs;
}

/** 主流程。 */
function main(): void {
  const markdown = readDesignDoc();
  const docKeys = parseSection8_4PayloadKeys(markdown);

  process.stdout.write('§8.4 payload 键集断言\n');
  process.stdout.write(`  §8.4 解析出的 type 数：${docKeys.size}\n`);

  const sweepSection = extractSection(markdown, SECTION_8_4_HEADING);
  const actionGroups = parseSweepActionGroups(sweepSection);
  const diffs = [
    ...comparePayloadKeys(docKeys, EVENT_PAYLOAD_KEYS),
    ...compareVariants(),
    ...compareActionGroups(actionGroups, EVENT_PAYLOAD_VARIANTS.sweep),
  ];

  if (diffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${diffs.length} 处 payload 键集不一致：\n`);
    for (const diff of diffs) {
      process.stderr.write(`    ${diff.type}：${diff.reason}\n`);
      process.stderr.write(`      §8.4：${(diff.doc ?? []).join(', ')}\n`);
      process.stderr.write(`      代码：${(diff.code ?? []).join(', ')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ §8.4 的 payload 键集与代码逐键一致\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
