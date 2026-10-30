/**
 * 连接初始化 —— DESIGN-v2.md §9.1（PRAGMA 规范与崩溃一致性）。
 *
 * ⚠️ **PRAGMA 必须分两套，不能合成一套**（§9.1）：两类连接能执行的 PRAGMA 不同。
 *   · 只读句柄上执行 `journal_mode` ⇒ 抛 `SQLITE_READONLY` ⇒ 查看器（§7.1）完全打不开。
 *   · 凡是**会写库**的 PRAGMA，都不得出现在「每次 open 都无条件执行」的位置上
 *     —— 这与「禁止在初始化块里写 `user_version`」是**同一个病根**。
 *
 * ⚠️ **`page_size` 不在本文件**：它只能在建库前设一次（对已有库无效），
 *   所以它属于**建库脚本**（`schema/001_schema_v2.sql`），不属于 `open()`。
 *   放进初始化块是「设了但没生效」的假动作。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { MemoryError } from '../core/errors.js';
import { SCHEMA_SQL } from './schema.sql.js';

/** 连接模式：写连接 / 只读连接（§7.1 的查看器用只读）。 */
export type ConnectionMode = 'write' | 'readonly';

/** 一条 PRAGMA 设置。 */
export interface PragmaSetting {
  name: string;
  value: number | string;
}

/**
 * ★ **建库时的页大小**（§9.1）：`PRAGMA page_size = 8192`。
 *
 * 选 8192 的理由：embedding 行 768 维 float32 ≈ 3KB，默认 4096 字节页下约 1 行/页，打包差。
 *
 * ⚠️ **为什么它必须是一个常量、并在两处出现**：
 *   · 权威声明在 `schema/001_schema_v2.sql`（建库脚本）里；
 *   · 但**生效**要靠 `openDatabase()` 在**文件还是空的时候**先设一次（见下）。
 *   ⇒ 两处都从**本常量**派生 / 被单测比对，避免「脚本写 8192、代码设 4096」这种漂移。
 */
export const PAGE_SIZE = 8192;

/**
 * ★ **建库时刻**才需要套用的 PRAGMA（**只有 `page_size` 一条**）。
 *
 * ⚠️ 为什么它**不能**只留在建库脚本里（实测得出的结论，与 §9.1 的字面安排不同）：
 *   ```
 *   new Database(path)            ⇒ 文件**已**被创建，page_size 是默认的 4096
 *   PRAGMA journal_mode = WAL     ⇒ 写数据库头 ⇒ 页被按 4096 固化
 *   PRAGMA page_size = 8192       ⇒ 此时**已无效**（对已有库无效，需 VACUUM 重建）
 *   ```
 *   实测：先 page_size 再 journal_mode ⇒ 8192 ✅；先 journal_mode 再 page_size ⇒ 4096 ❌。
 *   ⇒ 正确做法是：文件**不存在时**（即本次 open 会建库），把 page_size 作为**第一条** PRAGMA 套上，
 *      然后再套写连接的其余 PRAGMA。此时文件虽已被 `new Database()` 创建，但**数据库头尚未写入** ⇒ 仍生效。
 *
 * ⚠️ 它**不属于**连接初始化：对**已存在**的库，本集合**一律不套**（设了也不会生效 ⇒ 假动作）。
 */
export const CREATION_PRAGMAS: readonly PragmaSetting[] = [{ name: 'page_size', value: PAGE_SIZE }];

/**
 * ★ **A. 写连接**的 PRAGMA 集合（§9.1 逐条）。
 *
 * ⚠️ `cache_size` 是**负数 = KB**：`-64000` = 64MB。写正数是「页数」，极易写错量级
 *    （`-64` 是 64**KB**，不是 64MB）。默认仅 ~2MB，对 100 万条 / ~4GB 的库严重欠缓存
 *    ⇒ 每次查询都可能落盘，直接对冲 P99 ≤ 200ms 门槛。
 */
export const WRITE_PRAGMAS: readonly PragmaSetting[] = [
  { name: 'journal_mode', value: 'WAL' }, // 会改数据库头并创建 -wal/-shm ⇒ 只读句柄上必然抛 SQLITE_READONLY
  { name: 'synchronous', value: 'NORMAL' }, // WAL 下只在 checkpoint 时 fsync（崩溃一致性代价见 §9.1）
  { name: 'busy_timeout', value: 5000 },
  { name: 'foreign_keys', value: 'ON' }, // ★ 每连接开关、默认关闭；漏开时不报错不告警
  { name: 'cache_size', value: -64000 }, // 64MB 页缓存
  { name: 'wal_autocheckpoint', value: 1000 }, // WAL 累积 1000 页自动 checkpoint
  { name: 'mmap_size', value: 268435456 }, // 256MB 内存映射读：向量点积这类顺序扫少一次拷贝
  { name: 'temp_store', value: 'MEMORY' }, // 重训/对账的排序与临时表放内存
];

/**
 * ★ **B. 只读连接**的 PRAGMA 集合（§7.1 桌面查看器）。
 *
 * ⚠️ **`journal_mode` / `synchronous` 一律不设**，两个理由（§9.1）：
 *   ① `journal_mode` 是**写库**的 PRAGMA，在 `readonly: true` 句柄上执行会抛 `SQLITE_READONLY`；
 *   ② WAL 是**持久化在库文件里**的属性，写连接设过一次之后一直有效（只读连接本来也不需要再设）。
 *      `synchronous` 是每连接的内存设置，只读连接不写盘，设了无效——不会报错，但别写，
 *      免得让人以为只读连接也参与了持久化策略。
 */
export const READONLY_PRAGMAS: readonly PragmaSetting[] = [
  { name: 'busy_timeout', value: 5000 },
  { name: 'foreign_keys', value: 'ON' },
  { name: 'cache_size', value: -16000 }, // 只读连接给 16MB 即可（§7.1 只做展示性查询）
];

/** 取某个模式的 PRAGMA 集合。 */
export function pragmasFor(mode: ConnectionMode): readonly PragmaSetting[] {
  return mode === 'readonly' ? READONLY_PRAGMAS : WRITE_PRAGMAS;
}

/**
 * 在一条连接上套用 PRAGMA。
 *
 * ⚠️ **不**在这里写 `user_version`（§9.1 明令禁止）：只读连接执行写 PRAGMA 会失败，
 *   且每次 open 都重置版本号会永久覆盖已升级的版本号。版本号只在建库脚本里写一次。
 */
export function applyPragmas(db: Database.Database, mode: ConnectionMode): void {
  for (const pragma of pragmasFor(mode)) {
    db.pragma(`${pragma.name} = ${String(pragma.value)}`);
  }
}

/** 打开连接的入参。 */
export interface OpenDatabaseOptions {
  /** 数据库文件路径。 */
  dbPath: string;
  /** 只读？（§7.1 的查看器用只读句柄：`{ readonly: true, fileMustExist: true }`） */
  readonly?: boolean;
}

/**
 * 读库里的 schema 版本号（`PRAGMA user_version`）。
 *
 * `0` = 空库 / 尚未初始化（建库脚本还没跑过）。
 */
export function readUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version', { simple: true }) as number | undefined;
  return typeof row === 'number' ? row : 0;
}

/**
 * 打开一个数据库句柄并完成**连接初始化**（不含建库与迁移）。
 *
 * - 写连接：父目录不存在时自动创建；跑 **A 套** PRAGMA。
 *   ⚠️ 若文件**原本不存在**（本次 open 会建库），额外先跑 `CREATION_PRAGMAS`（`page_size`）——
 *     它是唯一必须在「数据库头被写入之前」设的 PRAGMA，晚了就无效（见 `CREATION_PRAGMAS` 的注释）。
 * - 只读连接：**必须**文件已存在（§7.1：`fileMustExist: true`）⇒ 不存在就抛 `NOT_FOUND`；跑 **B 套** PRAGMA。
 *
 * ⚠️ 本函数**不建表**：建库 / 校验 / 迁移由 `src/db/migrate.ts` 的 `ensureSchema()` 负责。
 *
 * @throws {MemoryError} code = `NOT_FOUND`（只读模式下文件不存在）
 */
export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  const readonly = options.readonly === true;

  if (readonly) {
    if (!existsSync(options.dbPath)) {
      throw MemoryError.notFound(`只读模式下数据库文件不存在：${options.dbPath}`, {
        path: options.dbPath,
      });
    }
    const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
    applyPragmas(db, 'readonly');
    return db;
  }

  const parent = dirname(options.dbPath);
  if (parent !== '' && parent !== '.' && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  // ⚠️ 必须在 `new Database()` **之前**判断文件是否存在：它一打开就会把文件建出来
  const isNewFile = !existsSync(options.dbPath);
  const db = new Database(options.dbPath);

  if (isNewFile) {
    // ★ page_size 必须是**第一条** PRAGMA（早于 journal_mode 写数据库头）
    for (const pragma of CREATION_PRAGMAS) {
      db.pragma(`${pragma.name} = ${String(pragma.value)}`);
    }
  }
  applyPragmas(db, 'write');
  return db;
}

/**
 * 在一条**已初始化**的写连接上执行建库 DDL。
 *
 * ⚠️ 只应在「空库」（`user_version == 0`）上调用。是否已建库由 `src/db/migrate.ts` 判断。
 * ⚠️ 建库脚本**不包事务**：事务内 `PRAGMA foreign_keys = ON` 静默无效（SQLite 不报错、不生效）
 *    ⇒ 包了会让后续 `forget(hard)` 留下孤儿行且不报错。
 */
export function createSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}
