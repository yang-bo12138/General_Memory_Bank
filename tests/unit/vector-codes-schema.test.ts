/**
 * 增量表 `vector_codes` 的建表口径（2026-11-04 · ADR-PERF-01 §8 · C′ 档）——
 * 钉死四件事，每件都对应一个**真实会踩的坑**：
 *
 * ① **它不在 `V2_NEW_TABLES` 里**：那是「这个库是不是 v2」的**指纹**
 *    ⇒ 加进去 ⇒ **全部存量库**在 `assertV2TablesComplete()` 上抛错（数据其实完好）；
 * ② **存量 v2 库能被补建**：`ensureSchema()` 在 `user_version === 2` 时**早退、不重跑建库脚本**
 *    ⇒ 建库脚本里那行对存量库**永远不执行** ⇒ 必须有 `ensureVectorCodesTable()`；
 * ③ **两处 DDL 不许漂移**：`src/core/schema.ts` 的常量 与 `schema/*.sql` 里那段
 *    ⇒ 用「去注释 + 压平空白后逐字相等」来钉；
 * ④ **只读实例不建表、也不要求它存在**：只读句柄执行 DDL 必然 `SQLITE_READONLY`
 *    ⇒ 只读侧必须能打开一张「还没有码表」的库（读取路径遇到无码行走精确兜底）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXPECTED_V2_TABLE_COUNT, V2_NEW_TABLES, VECTOR_CODES_SQL } from '../../src/core/schema.js';
import { openDatabase } from '../../src/db/connection.js';
import { ensureSchema, ensureVectorCodesTable } from '../../src/db/migrate.js';
import { MIGRATION_V1_TO_V2_SQL, SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';

/** 去掉 `--` 行注释、压掉行尾空白、丢掉空行 —— 只留下**可执行的那部分**。 */
function executableOnly(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const commentAt = line.indexOf('--');
      return (commentAt < 0 ? line : line.slice(0, commentAt)).replace(/\s+$/, '');
    })
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

/** 从一段完整 DDL 里切出 `vector_codes` 那两条语句（表 + 索引）。 */
function vectorCodesBlock(sql: string): string {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS vector_codes');
  expect(start).toBeGreaterThanOrEqual(0);
  const indexEnd = sql.indexOf('ON vector_codes(memory_id);', start);
  expect(indexEnd).toBeGreaterThan(start);
  return sql.slice(start, indexEnd + 'ON vector_codes(memory_id);'.length);
}

describe('增量表 `vector_codes` 的建表口径', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gmb-vcodes-'));
  });

  afterEach(() => {
    // ⚠️ Windows：`MemoryStore` **没有 `close()`**（§6 的公开面里没有它）
    //   ⇒ 只读实例的句柄会一直开到进程结束 ⇒ 删目录必然 `EBUSY`
    //   ⇒ 这里**允许失败**（临时目录留着不影响任何断言，删不掉只是占几百 KB）
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // 故意吞掉：清理失败不是测试失败
    }
  });

  /** 建一张全新的 v2 库（可写打开 ⇒ `ensureSchema` 建齐 + 补建增量表）。 */
  function freshDatabase(name = 'memory.db'): Database.Database {
    const db = openDatabase({ dbPath: join(dir, name) });
    ensureSchema(db);
    return db;
  }

  it('① 它**不是** v2 指纹表：指纹仍是 9 张，且不包含它', () => {
    expect(EXPECTED_V2_TABLE_COUNT).toBe(9);
    expect([...V2_NEW_TABLES]).not.toContain('vector_codes');
  });

  it('② 新建库建齐后，表与索引都在，形状是 `WITHOUT ROWID` + 复合主键', () => {
    const db = freshDatabase();
    const table = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vector_codes'")
      .get() as { sql: string } | undefined;
    expect(table).toBeDefined();
    expect(table?.sql).toMatch(/WITHOUT ROWID/);
    expect(table?.sql).toMatch(/PRIMARY KEY \(fine_id, memory_id\)/);

    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_vcode_memory_unique'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/UNIQUE INDEX/);
    db.close();
  });

  it('③ 两处 DDL 不许漂移：`.sql` 里那段（去注释压平后）== 常量', () => {
    const expected = executableOnly(VECTOR_CODES_SQL);
    expect(executableOnly(vectorCodesBlock(readFileSync('schema/001_schema_v2.sql', 'utf8')))).toBe(
      expected,
    );
    expect(
      executableOnly(vectorCodesBlock(readFileSync('schema/002_migration_v1_to_v2.sql', 'utf8'))),
    ).toBe(expected);
    // 运行时副本（`schema.sql.ts`）里的两段同样要对得上
    expect(executableOnly(vectorCodesBlock(SCHEMA_SQL))).toBe(expected);
    expect(executableOnly(vectorCodesBlock(MIGRATION_V1_TO_V2_SQL))).toBe(expected);
  });

  it('④ 存量 v2 库：表被删掉后，下一次可写打开会被补建（且不动已有数据）', () => {
    const db = freshDatabase();
    try {
      db.prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                               stability, difficulty, created_at, last_access, access_count,
                               deleted, deleted_at)
         VALUES ('m-1', 'fact', '存量行', '存/量/行', 'h-1', 1, 0.5, 1, 1, 0, 0, NULL)`,
      ).run();
      db.exec('DROP INDEX idx_vcode_memory_unique;');
      db.exec('DROP TABLE vector_codes;');
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vector_codes'").get(),
      ).toEqual({ n: 0 });

      // 模拟「下一次可写打开」（`ensureSchema` 在 user_version = 2 时早退，只有这一句会补建）
      ensureSchema(db);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vector_codes'").get(),
      ).toEqual({ n: 1 });
      // ⚠️ 补建**不改数据**：既有行还在
      expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('⑤ 幂等：连调两次不抛错（每次可写打开都会调它）', () => {
    const db = freshDatabase();
    expect(() => {
      ensureVectorCodesTable(db);
      ensureVectorCodesTable(db);
    }).not.toThrow();
    db.close();
  });

  it('⑥ 只读实例可以打开「还没有码表」的库（只读侧不建表、也不要求它存在）', () => {
    const dbPath = join(dir, 'old.db');
    const writable = openDatabase({ dbPath });
    ensureSchema(writable);
    writable.exec('DROP INDEX idx_vcode_memory_unique;');
    writable.exec('DROP TABLE vector_codes;');
    writable.close();

    // ⚠️ 这条是唯一能证明「只读路径不会因为缺表而炸」的断言：
    //   `ensureSchemaForMode()` 对 readonly 只校验版本 + 九张指纹表 ⇒ 不该碰码表。
    expect(() => new MemoryStore({ dbPath, readonly: true })).not.toThrow();
    // 而且它**没有偷偷建表**（只读句柄没有任何写入）
    const reopened = openDatabase({ dbPath, readonly: true });
    expect(
      reopened.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vector_codes'").get(),
    ).toEqual({ n: 0 });
    reopened.close();
  });
});
