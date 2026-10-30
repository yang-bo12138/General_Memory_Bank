/**
 * golden 集的格式 —— DEVELOPMENT-PLAN.md D-08（**JSONL**）。
 *
 * ⚠️ 为什么是 JSONL（不是 JSON / snapshot）：
 *   「每行一条 query→id 序列，便于 diff 与增量追加」——
 *   一行一条 ⇒ 两次运行之间只改动的那一行，在 diff 里一眼可见；
 *   而整份 JSON 重新序列化后键序可能变化 ⇒ diff 全红 ⇒ 噪声淹没信号。
 *
 * ## 文件结构
 *
 * ```
 * {"kind":"meta","label":"<本次运行的标识>","flags":{...},"params":{...}}
 * {"kind":"record","op":"write","args":{...},"output":{...}}
 * {"kind":"record","op":"recall","args":{...},"output":{...}}
 * ...
 * ```
 *
 * · 第一行固定是 `kind="meta"` 的**元信息行**（记录本次运行用的开关与参数）。
 * · 其后每一行是一条 `kind="record"` 的**观测记录**。
 *
 * ⚠️ **比对时只比对 `record` 行**——两次运行的 `meta` 行**本来就该不同**
 *   （这正是「四开关全关 + `VECTOR_ROUTER='flat'`」与「单开一个开关」的差别所在）。
 *   ⇒ 把 `meta` 一起比对，会让「开关不同」这件事掩盖「输出是否相同」这个真问题。
 *
 * ⚠️ 记录一律用**规范化 JSON**（键排序、无空白）⇒ 比对是**逐位**的，
 *   且与对象字面量的书写顺序无关。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** golden 文件里的记录类型。 */
export type GoldenLineKind = 'meta' | 'record';

/** 元信息行（每次运行的第一行）。 */
export interface GoldenMeta {
  kind: 'meta';
  /** 本次运行的标识（用于人工辨认两套基线）。 */
  label: string;
  /** 本次运行生效的机制开关。 */
  flags: Record<string, unknown>;
  /** 本次运行生效的全量参数。 */
  params: Record<string, unknown>;
}

/** 一条观测记录。 */
export interface GoldenRecord {
  kind: 'record';
  /** 操作名（`write` / `recall` / `touch` / `get` / `stats`）。 */
  op: string;
  /** 入参（参与比对——调用方改了参数，输出当然可以变）。 */
  args: unknown;
  /** 输出（**逐位比对的对象**）。 */
  output: unknown;
}

/** golden 文件里的一行。 */
export type GoldenLine = GoldenMeta | GoldenRecord;

/** 是否是元信息行。 */
export function isMeta(line: GoldenLine): line is GoldenMeta {
  return line.kind === 'meta';
}

/** 是否是观测记录行。 */
export function isRecord(line: GoldenLine): line is GoldenRecord {
  return line.kind === 'record';
}

/**
 * 规范化 JSON 序列化：**键排序 + 无空白**。
 *
 * ⚠️ 为什么不能直接用 `JSON.stringify`：它的键序取决于**对象字面量的书写顺序**，
 *   同一份逻辑数据在两处写法不同 ⇒ 序列化结果不同 ⇒ 「逐位一致」变成假失败（C30 的反面）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

/** 把若干行序列化成 golden 文件的文本（JSONL）。 */
export function serializeGolden(lines: GoldenLine[]): string {
  return lines.map((line) => canonicalJson(line)).join('\n') + (lines.length > 0 ? '\n' : '');
}

/** 解析 golden 文件的文本（JSONL）。 */
export function parseGolden(text: string): GoldenLine[] {
  const lines: GoldenLine[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`golden 第 ${index + 1} 行不是合法 JSON：${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
      throw new Error(`golden 第 ${index + 1} 行缺少 kind 字段`);
    }
    lines.push(parsed as GoldenLine);
  }
  return lines;
}

/** 读一个 golden 文件。 */
export function readGoldenFile(path: string): GoldenLine[] {
  return parseGolden(readFileSync(path, 'utf8'));
}

/** 写一个 golden 文件（目录不存在时自动创建）。 */
export function writeGoldenFile(path: string, lines: GoldenLine[]): void {
  writeFileSync(path, serializeGolden(lines), 'utf8');
}

/** 取一个 golden 文件里的观测记录（**剔除 meta 行**）。 */
export function recordsOf(lines: GoldenLine[]): GoldenRecord[] {
  return lines.filter(isRecord);
}

/** 取一个 golden 文件里的元信息（没有则返回 undefined）。 */
export function metaOf(lines: GoldenLine[]): GoldenMeta | undefined {
  return lines.find(isMeta);
}
