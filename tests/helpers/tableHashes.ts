/**
 * ★ 「全表行数 + 内容哈希」的**唯一实现** —— 阶段 5 · T02（设计 §3.7 第 42 项）。
 *
 * 用途：断言「只读句柄不写任何业务数据」——**操作前后每张表的内容指纹完全不变**。
 *
 * ⚠️ **表清单从 `sqlite_master` 现取**（不是写死一串表名）：写死的那份会随着
 *   「加一张表」而**静默漏检**，而漏检的表恰好就是没人盯着的那张。
 *
 * ⚠️ **不按 rowid 排序**：本断言比对的是「同一个库、同一状态」的前后指纹
 *   ⇒ 没有写入时行序天然一致；排序反而要逐表挑一个主键（挑错就静默乱序）。
 *
 * ⚠️ **仓库里还有一份内联实现**：`tests/integration/verifyIntegrity.test.ts` 的
 *   `databaseFingerprint()`。那是**已合入**的测试，本轮**不动它**（设计 §8 R9：
 *   不在这轮做重构，否则会把 T02 的 diff 搅浑）。
 *   ⇒ **新代码一律用本文件**；下一个动那一处的人把它收编进来，然后删掉内联那份。
 */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

/** 一张表的指纹：行数 + 内容哈希。 */
export interface TableFingerprint {
  /** 行数。 */
  rows: number;
  /** 全部行的 `JSON.stringify` 的 sha1。 */
  hash: string;
}

/** 「表名 → 指纹」的映射。 */
export type TableFingerprints = Record<string, TableFingerprint>;

/** 库里现有的全部表名（从 `sqlite_master` 现取，按名字升序）。 */
export function allTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * 算若干张表的指纹。
 *
 * @param db 句柄（**可以是一个只读的旁路连接**：`SELECT *` 不改任何东西）
 * @param tables 表名清单；缺省 = 库里全部表
 */
export function tableFingerprints(
  db: Database.Database,
  tables: readonly string[] = allTableNames(db),
): TableFingerprints {
  const fingerprints: TableFingerprints = {};
  for (const table of tables) {
    // ⚠️ 表名来自 `sqlite_master`（不是外部输入）⇒ 这个拼接没有注入面；
    //   双引号包起来是因为 SQLite 允许 `"select"` 这种表名。
    const rows = db.prepare(`SELECT * FROM "${table}"`).all() as unknown[];
    fingerprints[table] = {
      rows: rows.length,
      hash: createHash('sha1').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return fingerprints;
}

/**
 * 比对两份指纹，返回**变了的表名**（空数组 = 一张都没变）。
 *
 * ⚠️ 返回**表名而不是布尔**：断言失败时要能一眼看出「是哪张表动了」
 *   ——只给 `false` 的话，下一步只能手工逐表 dump 去猜。
 */
export function changedTables(before: TableFingerprints, after: TableFingerprints): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter((name) => {
    const a = before[name];
    const b = after[name];
    if (a === undefined || b === undefined) {
      return true;
    }
    return a.rows !== b.rows || a.hash !== b.hash;
  });
}
