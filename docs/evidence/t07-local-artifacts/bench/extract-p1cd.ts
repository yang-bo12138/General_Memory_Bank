/**
 * 一次性只读抽数脚本（P1-d · 出关条件④）—— 从落盘 JSON 里把要报告的量抽出来。
 *
 * ⚠️ ★ **路径说明（2026-11-05 · 迁移后更正）**：
 *   · ★ **本脚本自己**已从 `.tmp/bench/` 迁到 `handover/bench/` ⇒ ⇒ 用法行已改（★ 见下）。
 *   · ★ **它读的数据** = `.tmp/bench/t07-warm.json` ⇒ ⇒ **那是仓库内的 `.tmp/` 路径、**被 gitignore**
 *     ⇒ ⇒ ⇒ **换一个克隆的机器就跑不了** ⇒ ⇒ ⇒ ⇒ 等价副本在 **`../handover/bench/t07-warm.json`**
 *     ⇒ ⇒ ⇒ ⇒ （★ **已实测 md5 一致**：`951c49ddb50ae58a9f53c2bb37832252`）⇒ ⇒ ⇒ ⇒ **两个路径任选，但只有后者能跨机器存活**。
 *
 * 用法（★ **在仓库根跑** ⇒ ⇒ 数据路径是仓库根相对的）：
 *   pnpm exec tsx ../handover/bench/extract-p1cd.ts
 */
import { readFileSync } from 'node:fs';

const path = '.tmp/bench/t07-warm.json';
const text = readFileSync(path, 'utf8');
const data = JSON.parse(text) as Record<string, unknown>;

/** 递归找出所有「看起来像分布」的对象（含 count/min/max）。 */
function findSummaries(node: unknown, path: string, out: string[]): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => findSummaries(item, `${path}[${index}]`, out));
    return;
  }
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  const isSummary =
    keys.includes('count') && keys.includes('min') && keys.includes('max') && keys.includes('mean');
  if (isSummary) {
    out.push(`${path} = ${JSON.stringify(record)}`);
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    findSummaries(value, `${path}.${key}`, out);
  }
}

const summaries: string[] = [];
findSummaries(data, '', summaries);
process.stdout.write(`=== 全部分布块（${summaries.length} 个）===\n`);
for (const line of summaries) {
  process.stdout.write(`${line}\n`);
}

process.stdout.write('\n=== 顶层标量 / 小对象 ===\n');
for (const [key, value] of Object.entries(data)) {
  if (value === null || typeof value !== 'object') {
    process.stdout.write(`${key} = ${String(value)}\n`);
  }
}

/** 递归找字段名里带 survivor / hit / return 的键（⇒ 「survivors」到底有没有落盘）。 */
function findNamed(node: unknown, path: string, out: string[]): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => findNamed(item, `${path}[${index}]`, out));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const next = `${path}.${key}`;
    if (/survivor|hit|return/i.test(key)) {
      out.push(`${next} = ${JSON.stringify(value)}`);
    }
    findNamed(value, next, out);
  }
}

const named: string[] = [];
findNamed(data, '', named);
process.stdout.write(`\n=== 名字里带 survivor/hit/return 的字段（${named.length} 个）===\n`);
for (const line of named) {
  process.stdout.write(`${line}\n`);
}
