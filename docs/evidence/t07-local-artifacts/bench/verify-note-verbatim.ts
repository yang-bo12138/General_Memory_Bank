/**
 * ⚠️⚠️ ★★ **本脚本已被取代 ⇒ 只作历史留档 ⇒ 不要再拿它当「更强的判据」** ★★
 *
 * ★ **现状（2026-11-05 · 已核）**：仓库内的 `scripts/check-json-note-fidelity.ts`
 *   （链外入口 = `pnpm run check:json-note`）**已经把判据升级成【逐字节相等】** ⇒ ⇒
 *   ⇒ ⇒ **它比本脚本强**：★ 多出「长度也须相等」· ★ 「仅空白/格式差异」辅助诊断
 *   · ★ 负控 F（截断必红）· ★ 10 项自测（正控 + 反向对照 + 负控 + 根因断言）· ★ 路径相对脚本自身（从 `/tmp` 跑也过）。
 *   ⇒ ⇒ ★ **本脚本现在是它的【弱化版】**（★ 一次性脚本 · 无负控 · 无自测 · 判红只写 stdout、**不设退出码**）。
 * ⇒ ⇒ ⇒ **要跑逐字节校验 ⇒ ⇒ 跑 `pnpm run check:json-note`（★ 仓库内那份）**。
 *
 * ★ **本脚本保留的原因**：它是「2026-11-05 逐字节判据升级」这一步的**过程留档**
 *   （★ 升级前仓库内那份还是「归一化比较」⇒ ⇒ 那时靠它才判得出「真零差异」）⇒ ⇒ **别删、也别当现行判据**。
 *
 * ⚠️ ★ **历史**：本脚本原为一次性脚本 ⇒ 用法行曾写 `.tmp/bench/verify-note-verbatim.ts`（★ 迁移后已过时 ⇒ 位置见下）。
 *
 * 用法（★ **在仓库根跑** ⇒ ⇒ 它读的是**仓库根相对路径**）：
 *   pnpm exec tsx ../handover/bench/verify-note-verbatim.ts
 */
import { readFileSync } from 'node:fs';

const notesPath = process.argv[2] ?? 'docs/design/perf-c2-t06-byte-metering-impl-notes.md';
const perfPath = process.argv[3] ?? 'bench/perf.ts';

const notes = readFileSync(notesPath, 'utf8');
const perf = readFileSync(perfPath, 'utf8');

/* ── 文档侧：抽两段 note（JSON 字符串体 → 解转义） ── */
const NOTE_RE = /"note":\s*"((?:[^"\\]|\\.)*)"/gu;
const unescapeJson = (raw: string): string =>
  raw.replace(/\\(u[0-9a-fA-F]{4}|.)/gu, (_whole, seq: string) => {
    if (seq.startsWith('u')) {
      return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
    }
    switch (seq) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return seq;
    }
  });

const docNotes = [...notes.matchAll(NOTE_RE)].map((match) => unescapeJson(match[1] ?? ''));

/* ── 实现侧：抽 `buildVectorByteReads(...)` 的第三个参数（note） ── */
const unescapeTs = (raw: string): string =>
  raw.replace(/\\(u[0-9a-fA-F]{4}|.)/gu, (_whole, seq: string) => {
    if (seq.startsWith('u')) {
      return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
    }
    switch (seq) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return seq;
    }
  });

const TS_LITERAL_RE = /'((?:[^'\\]|\\.)*)'/gu;

function extractPerfNote(startIndex: number): string {
  const end = perf.indexOf('\n  );', startIndex);
  if (end === -1) {
    throw new Error('找不到 buildVectorByteReads(...) 的收尾');
  }
  const region = perf.slice(startIndex, end);
  let out = '';
  for (const match of region.matchAll(TS_LITERAL_RE)) {
    out += unescapeTs(match[1] ?? '');
  }
  return out;
}

const perfNotes: string[] = [];
let cursor = 0;
while (true) {
  const at = perf.indexOf("'① ★ **口径**：`bytesRead`", cursor);
  if (at === -1) {
    break;
  }
  perfNotes.push(extractPerfNote(at));
  cursor = at + 1;
}

console.log(`文档侧 note 段数：${docNotes.length}`);
console.log(`实现侧 note 段数：${perfNotes.length}`);

let allEqual = true;
for (let index = 0; index < Math.max(docNotes.length, perfNotes.length); index += 1) {
  const doc = docNotes[index] ?? '';
  const impl = perfNotes[index] ?? '';
  const equal = doc === impl;
  allEqual &&= equal;
  console.log(
    `note[${index}]：文档侧 ${doc.length} 字 / 实现侧 ${impl.length} 字 ⇒ **逐字节相等：${equal}**`,
  );
  if (!equal) {
    let at = 0;
    while (at < doc.length && at < impl.length && doc[at] === impl[at]) {
      at += 1;
    }
    console.log(`  第一处差异在第 ${at} 字：`);
    console.log(`  文档侧：…${doc.slice(Math.max(0, at - 20), at + 40)}…`);
    console.log(`  实现侧：…${impl.slice(Math.max(0, at - 20), at + 40)}…`);
  }
}

process.stdout.write(allEqual ? '\n✅ 两段 note 真零差异（逐字节相等）\n' : '\n✗ 有差异\n');
process.exitCode = allEqual ? 0 : 1;
