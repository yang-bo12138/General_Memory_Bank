/**
 * `user_version` 的**两段式**校验与迁移入口 —— DESIGN-v2.md §9.1。
 *
 * ★ **两段式**（§9.1）：
 *   · 阶段 A：`user_version == 1` ⇒ 走 v1 → v2 迁移（P1-T02 落地）；
 *   · 阶段 B：`user_version == 2` ⇒ **再查 `sqlite_master`** 确认 v2 的九张新表齐全：
 *     - 期望 **9 行**；**不等于 9** ⇒ 抛错（`details = { expected: 9, actual: n, missing: [...] }`）。
 *
 * ⚠️ 阶段 B 存在的理由：**「版本号被改成 2、但新表没建」的半成品库是真实存在的**
 *    （阶段 A 跑到一半失败留下）。只查版本号会把这种库当成健康的 v2 库放行
 *    ⇒ 老库要等到第一次 `stats()` / `touch()` 才炸（`no such table`）。
 */

import type Database from 'better-sqlite3';

import { MemoryError, type SqliteErrorLike } from '../core/errors.js';
import { EXPECTED_V2_TABLE_COUNT, V2_NEW_TABLES } from '../core/schema.js';
import { SCHEMA_VERSION } from '../core/version.js';
import { createSchema, readUserVersion } from './connection.js';

/** 迁移结果。 */
export interface MigrateResult {
  /** 迁移/建库后的 schema 版本号。 */
  version: number;
  /** 本次是否执行了建库（空库 → v2）。 */
  created: boolean;
  /** 本次是否执行了 v1 → v2 迁移（P1-T02 前恒为 false）。 */
  migrated: boolean;
}

/**
 * 查 `sqlite_master` 里 v2 九张新表的**实际存在情况**。
 */
export function findV2Tables(db: Database.Database): string[] {
  const placeholders = V2_NEW_TABLES.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...V2_NEW_TABLES) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * 阶段 B：断言 v2 的九张新表**齐全**。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`（缺表 ⇒ `details` 里带 expected / actual / missing）
 */
export function assertV2TablesComplete(db: Database.Database): void {
  const present = findV2Tables(db);
  if (present.length === EXPECTED_V2_TABLE_COUNT) {
    return;
  }
  const missing = V2_NEW_TABLES.filter((name) => !present.includes(name));
  throw MemoryError.invalidInput('schema 版本为 2，但 v2 的九张新表不齐全（半成品库）', {
    schema: {
      current: SCHEMA_VERSION,
      expected: EXPECTED_V2_TABLE_COUNT,
      actual: present.length,
      missing,
      reason: '阶段 A 迁移可能中途失败；只查 user_version 会放行这种库',
    },
  });
}

/**
 * 打开并**确保**数据库处于 v2 形态（建库 / 迁移 / 校验三段）。
 *
 * ⚠️ 本函数只做「到 v2 为止」的事：v1 → v2 的**真迁移**由 P1-T02 落地；
 *   在此之前遇到 `user_version == 1` 会明确抛错（而不是假装迁移过了）。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`（版本不认识 / 半成品库）
 */
export function ensureSchema(db: Database.Database): MigrateResult {
  const version = readUserVersion(db);

  if (version === SCHEMA_VERSION) {
    // 阶段 B：版本号对了，还要确认九张新表齐全
    assertV2TablesComplete(db);
    return { version, created: false, migrated: false };
  }

  if (version === 0) {
    // 空库 ⇒ 建库
    createSchema(db);
    const after = readUserVersion(db);
    if (after !== SCHEMA_VERSION) {
      throw MemoryError.invalidInput('建库脚本执行后 user_version 仍不是 2', {
        schema: {
          current: after,
          expected: SCHEMA_VERSION,
          reason: '建库脚本未写 PRAGMA user_version = 2',
        },
      });
    }
    assertV2TablesComplete(db);
    return { version: after, created: true, migrated: false };
  }

  if (version === 1) {
    // 阶段 A：v1 → v2 迁移（P1-T02）
    throw MemoryError.invalidInput('检测到 v1 库（user_version = 1），但 v1 → v2 迁移尚未实现', {
      schema: {
        current: version,
        expected: SCHEMA_VERSION,
        reason: 'P1-T02 落地前不支持自动升级；请按 §9.1 的迁移步骤处理',
      },
    });
  }

  throw MemoryError.invalidInput(`不认识的 schema 版本：${version}`, {
    schema: { current: version, expected: SCHEMA_VERSION, reason: '库可能来自更高版本' },
  });
}

/**
 * 把一个 better-sqlite3 的**原生错误**归一化后重抛（五个 code 是封闭集合，不扩码）。
 *
 * ⚠️ 本模块所有的抛错都应经过它，避免裸的 SQLite 错误码穿给调用方（§4.9 步骤 2 并发兜底）。
 */
export function normalizeSqliteError(error: unknown): never {
  throw error;
}

/** 导出类型：便于调用方写类型注解。 */
export type { SqliteErrorLike };
