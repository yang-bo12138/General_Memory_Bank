/**
 * ⚠️⚠️ ★★ **本脚本已被取代 ⇒ 只作历史留档** ★★
 *
 * ★ **现状（2026-11-05 · 已核）**：仓库内的 `scripts/check-json-note-fidelity.ts`
 *   （链外入口 = `pnpm run check:json-note`）是本脚本的**超集** ⇒ ⇒
 *   ⇒ ⇒ **判据已从【归一化比较】升级成【逐字节相等】**（★ 比本脚本**更强**）
 *   ⇒ ⇒ ⇒ 多出：「长度也须相等」· 「仅空白/格式差异」辅助诊断 · 负控 F（截断必红）· 10 项自测
 *   ⇒ ⇒ ⇒ 且**路径相对脚本自身** ⇒ ⇒ 从任何目录跑都过（★ 本脚本读的是**仓库根相对路径** ⇒ 必须在仓库根跑）。
 * ⇒ ⇒ ⇒ **要跑现行的逐字节保真校验 ⇒ ⇒ 跑 `pnpm run check:json-note`（★ 仓库内那份）**。
 *
 * ★ **本脚本保留的原因**：它是「判据从归一化升级到逐字节」这一步的**过程留档**
 *   ⇒ ⇒ **它的归一化规则只作对照阅读**（★ 那条规则现在**不参与判绿**）⇒ ⇒ **别删、也别当现行判据**。
 *
 * ⚠️ ★ **历史**：本脚本原为一次性脚本 ⇒ 用法行曾写 `.tmp/bench/check-json-note-fidelity.ts`（★ 迁移后已过时）。
 *
 * 用法（★ **在仓库根跑**）：
 *   pnpm exec tsx ../handover/bench/check-json-note-fidelity.ts
 *
 * ⚠️ ★ **归一化规则**（★ **历史口径 · 现在只作对照 · 不参与判绿**；两边必须对称，否则会假阴性）：
 *   去掉**所有空白** + **引号**（单双）+ **反斜杠** + **反引号**
 *   ⇒ ⇒ 只比「实义字符」⇒ ⇒ TS 源码的 `'…' +` 拼接与 JSON 的转义写法都能对上。
 */
import { readFileSync } from 'node:fs';

const notes = readFileSync('docs/design/perf-c2-t06-byte-metering-impl-notes.md', 'utf8');
const perf = readFileSync('bench/lib/../perf.ts', 'utf8');

/**
 * 归一化：只留实义字符。
 *
 * ⚠️ ★ **为什么 `+` 也要去掉**（对称归一化的必然结果）：
 *   TS 源码里 note 是 `'…' + '…'` 拼的 ⇒ 拼接符 `+` 会出现在**实义文本中间**
 *   （`；+**恒等式**`）⇒ ⇒ 两边**对称**地去掉 `+` ⇒ ⇒ 只剩实义字符可比。
 *   ⚠️ 代价：`bytesRead = codeBytes + embeddingBytes` 里的 `+` 也被去掉
 *   ⇒ ⇒ 这个探针**对 `+` 不敏感**（其余字符全部敏感 ⇒ 仍然够灵敏）。
 */
const norm = (text: string): string =>
  text
    .replace(/\s+/gu, '')
    .replace(/['"`\\+]/gu, '');

const perfNorm = norm(perf);
const blocks = [...notes.matchAll(/"note":\s*"((?:[^"\\]|\\.)*)"/gu)].map((m) => m[1]);
console.log(`JSON note 块数量：${blocks.length}`);

let allHit = true;
blocks.forEach((block, index) => {
  const raw = block.replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
  const probe = norm(raw);
  const hit = perfNorm.includes(probe);
  allHit = allHit && hit;
  console.log(`  note[${index}]（${probe.length} 字）在 bench/perf.ts 中逐字命中：${hit}`);
  if (!hit) {
    // ⚠️ 报告**最长公共前缀**长度（定位漂移点）。
    let common = 0;
    while (common < probe.length && perfNorm.includes(probe.slice(0, common + 1))) {
      common += 1;
    }
    console.log(`    ⇒ 最长命中前缀：${common} 字`);
    const anchor = probe.slice(0, Math.max(1, common - 10));
    const at = perfNorm.indexOf(anchor);
    console.log(`    ⇒ perf.ts 侧：…${perfNorm.slice(at + anchor.length, at + anchor.length + 60)}…`);
    console.log(`    ⇒ 探针  侧：…${probe.slice(anchor.length, anchor.length + 60)}…`);
  }
});
console.log(allHit ? 'WRITE: true  READ: true' : 'WRITE: false  READ: false');
