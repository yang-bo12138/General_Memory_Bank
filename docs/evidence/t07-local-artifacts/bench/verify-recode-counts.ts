/**
 * 一次性只读核对（P1-c · ③ 回填后的行数核对）—— 只查副本，不写一个字节。
 *
 * ⚠️ ★★ **默认库路径已失效（2026-11-05）**：默认的 `.tmp/bench/perf-1000000-recode.db`
 *   （★ 5.5 GB 的重编码**副本**）**已被删除**（★ 省 8 GB）⇒ ⇒ ⇒ **本脚本现在必须显式传库路径**。
 *   ⇒ ⇒ ★ **手上有的是【原始语料库】** `gmb/.tmp/bench/perf-1000000.db`（5.2 GB）⇒ ⇒
 *   ⇒ ⇒ ⇒ ★ **但那不是重编码后的库** ⇒ ⇒ ⇒ ⇒ 本脚本要核对的是【重编码后】的行数
 *   ⇒ ⇒ ⇒ ⇒ ⇒ **要重跑 ⇒ ⇒ 需先再做一次副本**（★ 做法见 `handover/bench/t07-recode-dryrun-baseline.txt`）。
 *
 * ⚠️ ★ **本脚本自己**已从 `.tmp/bench/` 迁到 `handover/bench/` ⇒ ⇒ 用法行已改（★ 见下）。
 *
 * 用法（★ **在仓库根跑**）：
 *   pnpm exec tsx ../handover/bench/verify-recode-counts.ts <库路径>
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] ?? '.tmp/bench/perf-1000000-recode.db';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const scalar = (sql: string): number => {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? -1;
};

const lines: [string, string][] = [
  ['vector_codes 总行数（原始）', 'SELECT count(*) AS n FROM vector_codes'],
  ['memories 总行数（原始）', 'SELECT count(*) AS n FROM memories'],
  ['memories 活行（deleted = 0）', 'SELECT count(*) AS n FROM memories WHERE deleted = 0'],
  ['memories 活行且有 embedding（R11 的 memories 口径）', 'SELECT count(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL'],
  ['vector_cell_members 总行数', 'SELECT count(*) AS n FROM vector_cell_members'],
  [
    'A6 codes（码 ∩ 活记忆）',
    'SELECT count(*) AS n FROM vector_codes vc JOIN memories m ON m.id = vc.memory_id WHERE m.deleted = 0',
  ],
  [
    'A6 members（归属 ∩ 活记忆）',
    'SELECT count(*) AS n FROM vector_cell_members vcm JOIN memories m ON m.id = vcm.memory_id WHERE m.deleted = 0',
  ],
  ['distinct memory_id（码表里）', 'SELECT count(DISTINCT memory_id) AS n FROM vector_codes'],
  ['码表里 code 字节非空的行数', 'SELECT count(*) AS n FROM vector_codes WHERE code IS NOT NULL'],
  ['码表里 scale 非空的行数', 'SELECT count(*) AS n FROM vector_codes WHERE scale IS NOT NULL'],
];

process.stdout.write(`库：${dbPath}\n\n`);
for (const [label, sql] of lines) {
  process.stdout.write(`${label.padEnd(44, ' ')} = ${String(scalar(sql))}\n`);
}

db.close();
