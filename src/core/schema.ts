/**
 * Schema 常量 —— DESIGN-v2.md §3（数据模型）/ §9.1（PRAGMA 与版本管理）。
 *
 * ⚠️ `SCHEMA_VERSION` 的**唯一定义处**是 `src/core/version.ts`（§9.1：它就是写进 `PRAGMA user_version`
 *   的那个常量）。本文件只做**再导出**，避免同一份含义出现两处定义（两份副本必然漂移）。
 */

export { SCHEMA_VERSION } from './version.js';

/**
 * §9.1：v2 相对 v1 **新增的九张表**（`user_version` 两段式校验的第一步）。
 *
 * ⚠️ 这九张表是「v2 的指纹」：`open()` 时 `user_version == 2` 还不够，
 *   必须再查 `sqlite_master` 确认这九张表齐全（见 `src/db/migrate.ts`）——
 *   因为存在「版本号被改成 2、但新表没建」的半成品库（阶段 A 失败后留下的）。
 *
 * ⚠️ `cluster_snapshot_meta`（簇快照元信息，**单行表**）与 `meta`（**通用就绪标记表**）
 *   是两张不同的表，不要混为一谈。
 */
export const V2_NEW_TABLES: readonly string[] = [
  'coacts',
  'theme_clusters',
  'theme_cluster_members',
  'cluster_snapshot_meta',
  'meta',
  'vector_coarse_cells',
  'vector_fine_cells',
  'vector_cell_members',
  'archival_schedule',
];

/** ★ **写死的期望值**（C31）：v2 新表的**张数**。不等于 9 ⇒ 抛错。 */
export const EXPECTED_V2_TABLE_COUNT = V2_NEW_TABLES.length;

/**
 * ★ **增量表 `vector_codes` 的 DDL**（2026-11-04 · ADR-PERF-01 §8 · C′ 档的两段式第一级）。
 *
 * ⚠️ **它不是 v2 的指纹表**（**不**在 `V2_NEW_TABLES` 里）：
 *   指纹表判「这个库是不是 v2」⇒ 把本表塞进去，**所有存量 v2 库**（当然没有这张表）
 *   都会在 `assertV2TablesComplete()` 上抛错 ⇒ **等于为了一个可选优化让存量库打不开**。
 *
 * ⚠️ **为什么这份 DDL 会出现两处（本常量 + `schema/*.sql`）而不违反「单一真相」**：
 *   `ensureSchema()` 在 `user_version === 2` 时**早退**（只校验、不建表）
 *   ⇒ 建库脚本里那一行**对存量库永远不执行** ⇒ 存量库只能靠本常量在「下一次可写打开」时补建
 *   ⇒ 两处**不可避免**，所以用**测试**把漂移钉死（`tests/unit/vector-codes-schema.test.ts`）：
 *   把 `.sql` 里那段 DDL **去掉注释、压平空白**后，必须与本常量**逐字相同**。
 *
 * ⚠️ **本常量刻意不带注释**（否则「可逐字比较」这件事就没了）；可读的解释在 `.sql` 与上文的文档里。
 */
export const VECTOR_CODES_SQL = [
  'CREATE TABLE IF NOT EXISTS vector_codes (',
  '  fine_id   TEXT NOT NULL REFERENCES vector_fine_cells(fine_id) ON DELETE CASCADE,',
  '  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,',
  '  code      BLOB NOT NULL,',
  '  scale     REAL NOT NULL,',
  '  eps       REAL NOT NULL,',
  '  PRIMARY KEY (fine_id, memory_id)',
  ') WITHOUT ROWID;',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_vcode_memory_unique ON vector_codes(memory_id);',
].join('\n');

/** 建库脚本的路径（相对仓库根；仅供文档/诊断，运行时用的是 `src/db/schema.sql.ts` 的内联副本）。 */
export const SCHEMA_SQL_PATH = 'schema/001_schema_v2.sql';
