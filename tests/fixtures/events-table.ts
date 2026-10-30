/**
 * `events` 表的 DDL —— DESIGN-v2.md §3（逐字抄）。
 *
 * ⚠️ **这是最小测试夹具，不是 §3 的建库脚本**：
 *   §3 的权威 DDL（`schema/001_schema_v2.sql`）属阶段 1（P1-T01），阶段 0 **不存在**该文件。
 *   本文件只抄 `events` 这一张表的最小子集，用来驱动两件事的测试：
 *   ① `events.type` 的 CHECK 约束**恰好**是 §3 的 13 种；
 *   ② `appendEvent()` 的落库形状（含 `memory_id` 必传、只读短路）。
 *
 * ⚠️ **不要**在这里加别的表：阶段 0 的门禁（`scripts/check-payload-keys.ts` 等）
 *   断言的是「实现文件集合精确等于不变量设施清单」，多余的 DDL 会让契约漂移。
 *
 * ⚠️ 这里的 CHECK 约束**逐字**来自 §3 ⇒ 任何 type 拼错都会在落库时被库层挡住，
 *   与生产环境的行为一致。
 */

import type Database from 'better-sqlite3';

/** §3 的 `events` 表定义（逐字）。 */
export const EVENTS_TABLE_DDL = `
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL
                CHECK (type IN ('write','merge','restore','manual_fix','alias','touch',
                                'recall','link','pin','unpin','forget','sweep','config')),
  memory_id     TEXT,
  payload       TEXT NOT NULL,
  at            INTEGER NOT NULL
);
CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_memory ON events(memory_id) WHERE memory_id IS NOT NULL;
`;

/** 在给定连接上建出 `events` 表（测试用）。 */
export function createEventsTable(db: Database.Database): void {
  db.exec(EVENTS_TABLE_DDL);
}
