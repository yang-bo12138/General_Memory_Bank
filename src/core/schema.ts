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

/** 建库脚本的路径（相对仓库根；仅供文档/诊断，运行时用的是 `src/db/schema.sql.ts` 的内联副本）。 */
export const SCHEMA_SQL_PATH = 'schema/001_schema_v2.sql';
