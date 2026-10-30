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

/** 主流程。 */
function main(): void {
  const markdown = readDesignDoc();
  const docKeys = parseSection8_4PayloadKeys(markdown);

  process.stdout.write('§8.4 payload 键集断言\n');
  process.stdout.write(`  §8.4 解析出的 type 数：${docKeys.size}\n`);

  const diffs = [...comparePayloadKeys(docKeys, EVENT_PAYLOAD_KEYS), ...compareVariants()];

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
