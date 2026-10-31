/**
 * `user_version` 的**两段式**判定与 v1 → v2 迁移 —— DESIGN-v2.md §9.1。
 *
 * ★ **两段式**（§9.1）：每次 `open()` 后读 `PRAGMA user_version`
 *   · `== 0` ⇒ 空库，建库（P1-T01 的 `schema/001_schema_v2.sql`）；
 *   · `== 1` ⇒ **阶段 A + 阶段 B**：v1 → v2 迁移（本文件）；
 *   · `== 2` ⇒ **阶段 B 校验**：**再查 `sqlite_master`** 确认 v2 的九张新表齐全
 *     （期望 **9 行**；不等于 9 ⇒ 抛错，`details = { expected: 9, actual: n, missing: [...] }`，
 *     错误信息须写明「这是 v2.0 草案库，需重建或手工迁移」）；
 *   · 其余 ⇒ 抛 `INVALID_INPUT`。
 *
 * ⚠️ **不得用「少建几张就补建」自愈**（§9.1 禁止「猜测式兼容」）：
 *   v2.0 草案库的结构与 v2.1 不同（草案是 `vector_cells` **单表**）⇒ **补建也补不对**。
 *
 * ⚠️ **迁移成功之后按 v2 继续工作，不要抛错** —— 迁移成功还报错等于逼调用方手工改库。
 */

import type Database from 'better-sqlite3';

import { archiveSpanMs } from '../core/decay.js';
import { MemoryError } from '../core/errors.js';
import { DEFAULT_PARAMS } from '../core/params.js';
import { EXPECTED_V2_TABLE_COUNT, V2_NEW_TABLES } from '../core/schema.js';
import { SCHEMA_VERSION } from '../core/version.js';
import { EventWriter } from '../store/events.js';
import { type Logger, MemoryLogger } from '../util/log.js';
import { createSchema, readUserVersion } from './connection.js';
import { MIGRATION_V1_TO_V2_SQL } from './schema.sql.js';

/**
 * §9.4.1：`archive_at` 公式里的常数项 `ln(1 / ARCHIVE_LINE) × 86400000`（毫秒 / 天）。
 *
 * ```
 * intensity ≤ ARCHIVE_LINE
 *  ⟺ exp(-Δt / (stability × pin_factor × 86400000)) ≤ ARCHIVE_LINE
 *  ⟺ Δt  ≥ stability × pin_factor × ln(1/ARCHIVE_LINE) × 86400000
 * ⇒ archive_at = last_access + stability × pin_factor × ln(1/ARCHIVE_LINE) × 86400000
 * ```
 *
 * ⚠️ 从 `DEFAULT_PARAMS.ARCHIVE_LINE` **派生**（不在本文件写死 0.05）⇒ 改参数时这里跟着变。
 * ⚠️ 在 JS 里算而**不用 SQL 的 `ln()`**：避免依赖 SQLite 的 `SQLITE_ENABLE_MATH_FUNCTIONS` 编译开关。
 *
 * ★ **本函数不再自带公式**（C36：两份副本可能不一致）：
 *   归档跨度的**唯一权威**是 `src/core/decay.ts` 的 `archiveSpanMs`
 *   （它又只依赖 `archiveSpanFactor` 与 `MS_PER_DAY`）。
 *   ⇒ 本文件**不再出现** `86_400_000` / `Math.log(1 / archiveLine)` 这两样东西。
 *   ⚠️ 为什么必须收敛：迁移回填的 `archival_schedule.archive_at` 与运行时
 *     `src/core/decay.ts` 的 `archiveAt` **必须逐位相同**——
 *     否则同一条记忆在「迁移回填的归档表」与「运行时现算的归档时刻」上给出两个答案
 *     ⇒ 归档判定随数据来源而变（**不报错**，只是有的库归档早、有的库归档晚）。
 *   ⇒ 本函数保留原有签名与默认参数（对外 API 不变），只是**转发**给唯一权威。
 */
export function archiveAtFactor(archiveLine: number = DEFAULT_PARAMS.ARCHIVE_LINE): number {
  return archiveSpanMs(archiveLine);
}

/** 迁移的入参。 */
export interface MigrateOptions {
  /**
   * 注入时钟（C37）：迁移会写 `events.at`。
   * 缺省由调用方注入的时钟决定 —— 本模块自身**不**读真实时钟。
   */
  now?: () => number;
  /** 日志器（`EventWriter` 在只读实例短路时会记一条 warn）。 */
  logger?: Logger;
  /** 阶段 B 的批次大小（§9.1：分批而非单事务 ⇒ 100 万行单事务会 WAL 暴涨 + 持写锁数分钟）。 */
  batchSize?: number;
}

/** 迁移 / 建库的结果。 */
export interface MigrateResult {
  /** 迁移/建库后的 schema 版本号。 */
  version: number;
  /** 本次是否执行了建库（空库 → v2）。 */
  created: boolean;
  /** 本次是否执行了 v1 → v2 迁移。 */
  migrated: boolean;
  /** 阶段 B 回填 `archival_schedule` 的行数。 */
  backfilled: number;
}

/** 查 `sqlite_master` 里 v2 九张新表的实际存在情况。 */
export function findV2Tables(db: Database.Database): string[] {
  const placeholders = V2_NEW_TABLES.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...V2_NEW_TABLES) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * 阶段 B 校验：断言 v2 的九张新表**齐全**。
 *
 * ⚠️ 只断言，**不补建**（§9.1 禁止猜测式兼容）。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`
 */
export function assertV2TablesComplete(db: Database.Database): void {
  const present = findV2Tables(db);
  if (present.length === EXPECTED_V2_TABLE_COUNT) {
    return;
  }
  const missing = V2_NEW_TABLES.filter((name) => !present.includes(name));
  throw MemoryError.invalidInput(
    `schema 版本号是 ${SCHEMA_VERSION}，但 v2 的九张新表不齐全（这是 v2.0 草案库，需重建或手工迁移）`,
    {
      schema: {
        current: SCHEMA_VERSION,
        expected: EXPECTED_V2_TABLE_COUNT,
        actual: present.length,
        missing,
        reason:
          'v2.0 草案库用的是 vector_cells 单表，补建也补不对；故不自动补建（§9.1 禁止猜测式兼容）',
      },
    },
  );
}

/** 表里是否已有某一列（`PRAGMA table_info`）。 */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/**
 * ★ **阶段 A**：v1 → v2 的 DDL 变更，**全部在同一个事务内**。
 *
 * 顺序（§9.1）：
 * 1. `ALTER TABLE memories ADD COLUMN embedding BLOB CHECK (...)` —— **用 `table_info` 守卫**：
 *    SQLite 的 `ADD COLUMN` **没有 `IF NOT EXISTS`** ⇒ 重跑迁移会炸 `duplicate column name: embedding`。
 *    ⚠️ CHECK 必须与 §3 **逐字一致**：否则新建库与迁移库的 schema **分叉**
 *    （同样的列名、不同的约束），而运行时按 schema 版本号放行 ⇒ 分叉不会被发现，只在脏数据写入时才暴露。
 * 2. 建齐九张新表 + 全部索引（`schema/002_migration_v1_to_v2.sql`，全部 `IF NOT EXISTS` ⇒ 可重复执行）。
 *    ⚠️ 建表带 FK **不需要**先开 `PRAGMA foreign_keys`（CASCADE 写在 schema 里）；
 *    受开关影响的是**执行 DML 的那条连接**，而阶段 B 是纯 INSERT ⇒ 安全。
 * 3. 追加**恰好 1 条** `config` 事件（§12.1 ③：`events` 恰好 +1 条，含 `SCHEMA_VERSION` 与完整 `params`）。
 * 4. `PRAGMA user_version = 2`。
 *
 * @throws 失败时事务回滚 ⇒ 库**留在 v1**（不会变成半吊子 v2）
 */
export function migratePhaseA(db: Database.Database, options: MigrateOptions = {}): void {
  const logger = options.logger ?? new MemoryLogger();

  db.exec('BEGIN IMMEDIATE;');
  try {
    // ① ALTER（守卫：重跑不炸）
    if (!hasColumn(db, 'memories', 'embedding')) {
      db.exec(
        'ALTER TABLE memories ADD COLUMN embedding BLOB ' +
          'CHECK (embedding IS NULL OR length(embedding) % 4 = 0);',
      );
    }

    // ② 建齐九张新表 + 索引（全部 IF NOT EXISTS）
    db.exec(MIGRATION_V1_TO_V2_SQL);

    // ③ 恰好 1 条 config 事件（§12.1 ③）
    const writer = new EventWriter(db, {
      readonly: false,
      logger,
      now: options.now ?? (() => 0),
    });
    writer.appendEvent(
      'config',
      null, // 迁移事件不关联某条记忆 ⇒ 显式 null（§8.4 硬规则 6：值可为 null，参数不可省略）
      {
        SCHEMA_VERSION,
        params: DEFAULT_PARAMS,
        changed: [{ key: 'schema', from: 1, to: SCHEMA_VERSION }],
      },
      options.now === undefined ? undefined : options.now(),
    );

    // ④ 版本号
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

/**
 * ★ **阶段 B**：分批回填 `archival_schedule`（**rowid 游标**，可中断、可重跑）。
 *
 * ⚠️ **不写任何 events** ⇒ §12.1 ③「events 恰好 +1 条」仍成立。
 * ⚠️ **纯 INSERT，不依赖 `ON DELETE CASCADE`**；**分批而非单事务**（100 万行单事务 ⇒ WAL 暴涨 + 持写锁数分钟）。
 * ⚠️ **必须用 rowid 游标而不是 `LIMIT/OFFSET`**：OFFSET 是 O(n) 扫描，翻到第 100 页要重扫前 100 页。
 *
 * ⇒ 中断后重跑 ⇒ 结果与一次跑完**一致**（可重入：`INSERT OR REPLACE` + 游标按已扫描的最大 rowid 推进）。
 *
 * @returns 本次回填的行数
 */
export function migratePhaseB(db: Database.Database, options: MigrateOptions = {}): number {
  const batchSize = options.batchSize ?? DEFAULT_PARAMS.SWEEP_BATCH_SIZE;
  const factor = archiveAtFactor();

  const maxRowid = (
    db
      .prepare('SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM memories WHERE deleted = 0')
      .get() as {
      maxRowid: number;
    }
  ).maxRowid;

  const scan = db.prepare(
    'SELECT rowid FROM memories WHERE deleted = 0 AND rowid > ? ORDER BY rowid LIMIT ?',
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO archival_schedule (memory_id, archive_at)
     SELECT id, CAST(last_access + stability * pin_factor * ? AS INTEGER)
       FROM memories
      WHERE deleted = 0 AND rowid > ? AND rowid <= ?`,
  );

  let backfilled = 0;
  let cursor = 0;
  while (cursor < maxRowid) {
    const rows = scan.all(cursor, batchSize) as Array<{ rowid: number }>;
    if (rows.length === 0) {
      break;
    }
    const batchEnd = rows[rows.length - 1]?.rowid ?? cursor;
    backfilled += insert.run(factor, cursor, batchEnd).changes;
    cursor = batchEnd;
  }

  // 就绪标记：回填跑完才置 1 ⇒ 正确性**从不依赖**回填是否跑完
  //   （ready=0 ⇒ countArchived() 走逐行精筛，慢但正确，§9.4.5 降级路径）
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'archival_schedule_ready',
    '1',
  );

  return backfilled;
}

/**
 * 完整迁移 v1 → v2（阶段 A + 阶段 B）。
 *
 * ⚠️ 迁移**不可逆**：v1 的代码打开 v2 的库会因版本不符抛错 —— 这是**正确行为**（§9.1）。
 */
export function migrateV1ToV2(db: Database.Database, options: MigrateOptions = {}): MigrateResult {
  migratePhaseA(db, options);
  const backfilled = migratePhaseB(db, options);
  return { version: readUserVersion(db), created: false, migrated: true, backfilled };
}

/**
 * 打开并**确保**数据库处于 v2 形态（建库 / 迁移 / 校验三段）。
 *
 * ⚠️ **旧数据不回填 `embedding`**：`embedding IS NULL` 是合法状态（§9.1）。
 *    不做一次性全量回填 —— 它需要 embedder，构造期未必配置；强做会把 `open()` 变成几万次模型调用，
 *    启动时间不可控，中途失败后的状态也难描述 ⇒ 宁可就地降级。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`（版本不认识 / 半成品库）
 */
export function ensureSchema(db: Database.Database, options: MigrateOptions = {}): MigrateResult {
  const version = readUserVersion(db);

  if (version === SCHEMA_VERSION) {
    // 阶段 B 校验：版本号对了，还要确认九张新表齐全
    assertV2TablesComplete(db);
    return { version, created: false, migrated: false, backfilled: 0 };
  }

  if (version === 0) {
    createSchema(db);
    const after = readUserVersion(db);
    if (after !== SCHEMA_VERSION) {
      throw MemoryError.invalidInput('建库脚本执行后 user_version 仍不是 2', {
        schema: {
          expected: SCHEMA_VERSION,
          actual: after,
          reason: '建库脚本未写 PRAGMA user_version = 2',
        },
      });
    }
    assertV2TablesComplete(db);
    return { version: after, created: true, migrated: false, backfilled: 0 };
  }

  if (version === 1) {
    return migrateV1ToV2(db, options);
  }

  throw MemoryError.invalidInput(`不认识的 schema 版本：${version}`, {
    schema: {
      expected: SCHEMA_VERSION,
      actual: version,
      reason: '库可能来自更高版本（§9.1：不认识的版本一律抛错，不做猜测式兼容）',
    },
  });
}
