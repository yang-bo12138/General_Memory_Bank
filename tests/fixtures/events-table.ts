/**
 * `events` 表的 DDL —— DESIGN-v2.md §3（逐字抄）。
 *
 * ⚠️ **本文件是测试夹具**，不是建库脚本：
 *   权威 DDL 属阶段 1（P1-T01 的 `schema/001_schema_v2.sql`）。
 *   阶段 0 只需要 `events` 这一张表来验证两件事：
 *   ① `events.type` 的 CHECK 约束**恰好**是 §3 的 13 种；
 *   ② `appendEvent()` 的落库形状（含 `memory_id` 必传、只读短路）。
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
