/**
 * P1-T02 · v1 → v2 迁移（集成测试）—— DESIGN-v2.md §9.1。
 *
 * 覆盖的验收硬断言（DEVELOPMENT-PLAN.md P1-T02）：
 * · 构造 v1 库（`user_version=1`、无九张新表、无 `embedding` 列）⇒ `open()` 成功迁移
 *   ⇒ `user_version == 2`、九张新表齐全、`memories.embedding` 的 CHECK 与 §3 **逐字一致**
 * · 迁移后 `events` 恰好 **+1 条**（`type='config'`，含 `SCHEMA_VERSION` 与完整 `params`）—— §12.1 ③
 * · 迁移后 `memories` 全字段、`edges` 权重、行数 **零差异**；`coacts` **0 行**
 * · **可重复执行**（跑两次不炸第二次）⇒ `IF NOT EXISTS` + `table_info` 守卫生效
 * · 迁移中断后重跑 ⇒ 结果与一次跑完**一致**（阶段 B 可重入）
 * · `user_version = 99` ⇒ 抛 `INVALID_INPUT`，`details.expected/actual` 正确
 * · `user_version = 2` 但**缺一张新表** ⇒ 抛错，且**不自动补建**（断言表仍缺）
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { EXPECTED_V2_TABLE_COUNT, V2_NEW_TABLES } from '../../src/core/schema.js';
import { SCHEMA_VERSION } from '../../src/core/version.js';
import { openDatabase } from '../../src/db/connection.js';
import {
  archiveAtFactor,
  assertV2TablesComplete,
  ensureSchema,
  findV2Tables,
  hasColumn,
  migratePhaseA,
  migratePhaseB,
} from '../../src/db/migrate.js';
import { MIGRATION_V1_TO_V2_SQL, SCHEMA_SQL } from '../../src/db/schema.sql.js';

/** 临时目录与句柄登记。 */
let dir: string;
let openDbs: Database.Database[] = [];

/** 打开并登记句柄，便于统一关闭。 */
function open(path: string, readonly = false): Database.Database {
  const db = openDatabase({ dbPath: path, readonly });
  openDbs.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-ocean-migrate-'));
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    if (db.open) {
      db.close();
    }
  }
  openDbs = [];
});

/**
 * ★ **v1 形态**的 `memories`（= §3 的 v2 定义**去掉** `embedding` 那一列）。
 *
 * ⚠️ 这里**手写**而不是从 v2 的建库脚本里删：SQLite 的 `ALTER TABLE DROP COLUMN` 在带 CHECK 的
 *    列上不可靠，而测试要的是「一个确定的 v1 库」，不是「v2 库减一列」。
 */
const V1_DDL = `
CREATE TABLE memories (
  rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('fact','event','preference','thought','topic')),
  content        TEXT NOT NULL,
  content_tokens TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  media_ref      TEXT,
  media_type     TEXT CHECK (media_type IS NULL OR media_type IN ('image','audio','video')),
  source         TEXT,
  confidence     REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  stability      REAL NOT NULL CHECK (stability > 0),
  difficulty     REAL NOT NULL CHECK (difficulty >= 0.0 AND difficulty <= 1.0),
  pin_factor     REAL NOT NULL DEFAULT 1.0 CHECK (pin_factor >= 1.0 AND pin_factor <= 5.0),
  created_at     INTEGER NOT NULL,
  last_access    INTEGER NOT NULL,
  access_count   INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  deleted        INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  deleted_at     INTEGER,
  CHECK ((deleted = 0 AND deleted_at IS NULL) OR (deleted = 1 AND deleted_at IS NOT NULL)),
  CHECK ((media_ref IS NULL AND media_type IS NULL) OR (media_ref IS NOT NULL AND media_type IS NOT NULL))
);
CREATE UNIQUE INDEX idx_mem_hash ON memories(content_hash) WHERE deleted = 0;
CREATE INDEX idx_mem_last_access ON memories(last_access) WHERE deleted = 0;
CREATE INDEX idx_mem_kind ON memories(kind) WHERE deleted = 0;
CREATE INDEX idx_mem_created_at ON memories(created_at) WHERE deleted = 0;
CREATE INDEX idx_mem_deleted_at ON memories(deleted_at) WHERE deleted = 1;

CREATE TABLE entities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL DEFAULT 'concept'
             CHECK (type IN ('person','thing','place','concept','media')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_entity_type ON entities(type);

CREATE TABLE entity_aliases (
  alias     TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX idx_alias_entity ON entity_aliases(entity_id);

CREATE TABLE memory_entities (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX idx_me_entity ON memory_entities(entity_id);
CREATE INDEX idx_me_memory ON memory_entities(memory_id);

CREATE TABLE edges (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate   TEXT NOT NULL,
  object_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  memory_id   TEXT REFERENCES memories(id) ON DELETE SET NULL,
  weight      REAL NOT NULL DEFAULT 0.8,
  last_active INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_edge_spo ON edges(subject_id, predicate, object_id);
CREATE INDEX idx_edge_subj ON edges(subject_id);
CREATE INDEX idx_edge_obj ON edges(object_id);
CREATE INDEX idx_edge_mem ON edges(memory_id);

CREATE TABLE content_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content        TEXT NOT NULL,
  content_tokens TEXT,
  reason         TEXT NOT NULL CHECK (reason IN ('merge','manual_fix')),
  replaced_at    INTEGER NOT NULL
);
CREATE INDEX idx_ch_memory ON content_history(memory_id, replaced_at);

CREATE TABLE events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type      TEXT NOT NULL
            CHECK (type IN ('write','merge','restore','manual_fix','alias','touch',
                            'recall','link','pin','unpin','forget','sweep','config')),
  memory_id TEXT,
  payload   TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_memory ON events(memory_id) WHERE memory_id IS NOT NULL;

CREATE VIRTUAL TABLE mem_fts USING fts5(
  content_tokens,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0'
);
CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO mem_fts(rowid, content_tokens) VALUES (new.rowid, new.content_tokens);
END;
CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content_tokens) VALUES('delete', old.rowid, old.content_tokens);
END;
CREATE TRIGGER mem_au AFTER UPDATE OF content_tokens ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content_tokens) VALUES('delete', old.rowid, old.content_tokens);
  INSERT INTO mem_fts(rowid, content_tokens) VALUES (new.rowid, new.content_tokens);
END;
`;

/** 造一个 v1 库（含若干业务数据），返回它的路径。 */
function createV1Database(path: string, memoryCount = 3): Database.Database {
  const db = new Database(path);
  db.exec(V1_DDL);
  db.pragma('user_version = 1');

  db.prepare('INSERT INTO entities (id, name, created_at) VALUES (?, ?, ?)').run('e1', '张三', 1);
  db.prepare('INSERT INTO entities (id, name, created_at) VALUES (?, ?, ?)').run('e2', '北京', 1);
  db.prepare('INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run('老张', 'e1');

  const insertMemory = db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash, stability, difficulty,
                           pin_factor, created_at, last_access, access_count, deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @stability, 0.5, @pin, 1000, 2000, 3, 0, NULL)`,
  );
  for (let index = 0; index < memoryCount; index += 1) {
    const content = `第${index + 1}条记忆`;
    insertMemory.run({
      id: `m${index + 1}`,
      content,
      tokens: content,
      hash: `h${index + 1}`,
      stability: 1 + index,
      pin: 1 + index * 0.5,
    });
    db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
      `m${index + 1}`,
      index % 2 === 0 ? 'e1' : 'e2',
    );
  }

  db.prepare(
    `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('g1', 'e1', '住在', 'e2', 'm1', 1.5, 2000, 1000);

  // 两条 v1 时期的事件（用于验证「迁移后 events 恰好 +1」）
  const insertEvent = db.prepare(
    'INSERT INTO events (type, memory_id, payload, at) VALUES (?, ?, ?, ?)',
  );
  insertEvent.run('write', 'm1', '{"id":"m1"}', 1000);
  insertEvent.run('touch', 'm1', '{"id":"m1"}', 1000);

  return db;
}

describe('P1-T02 · v1 → v2 迁移', () => {
  it('v1 库 ⇒ open() 迁移 ⇒ user_version == 2、九张新表齐全、embedding 列出现', () => {
    const dbPath = join(dir, 'memory.db');
    const v1 = createV1Database(dbPath);
    expect(readUserVersionOf(v1)).toBe(1);
    expect(hasColumn(v1, 'memories', 'embedding')).toBe(false);
    expect(findV2Tables(v1)).toHaveLength(0);
    v1.close();

    const db = open(dbPath);
    const result = ensureSchema(db);
    expect(result.migrated).toBe(true);
    expect(result.version).toBe(SCHEMA_VERSION);
    expect(readUserVersionOf(db)).toBe(2);
    expect(hasColumn(db, 'memories', 'embedding')).toBe(true);
    expect(findV2Tables(db)).toHaveLength(EXPECTED_V2_TABLE_COUNT);
    expect(() => assertV2TablesComplete(db)).not.toThrow();
  });

  it('★ 迁移后 memories.embedding 的 CHECK 与 §3 逐字一致（查 sqlite_master 的 SQL 文本）', () => {
    const dbPath = join(dir, 'memory.db');
    createV1Database(dbPath).close();

    const migrated = open(dbPath);
    ensureSchema(migrated);

    // 参照物：一份**新建**的 v2 库
    const freshPath = join(dir, 'fresh.db');
    const fresh = open(freshPath);
    ensureSchema(fresh);

    const checkText = 'CHECK (embedding IS NULL OR length(embedding) % 4 = 0)';
    expect(memorySqlOf(migrated)).toContain(checkText);
    expect(memorySqlOf(fresh)).toContain(checkText);

    // 更强：两处对 embedding 列的**约束文本**必须逐字相同（不分叉）
    expect(embeddingConstraintOf(migrated)).toBe(embeddingConstraintOf(fresh));
  });

  it('★ 迁移后 events 恰好 +1 条（type=config，含 SCHEMA_VERSION 与完整 params）', () => {
    const dbPath = join(dir, 'memory.db');
    const v1 = createV1Database(dbPath);
    const before = (v1.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
    v1.close();

    const db = open(dbPath);
    ensureSchema(db);
    const after = (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
    expect(after).toBe(before + 1);

    const row = db
      .prepare('SELECT type, memory_id, payload FROM events ORDER BY id DESC LIMIT 1')
      .get() as { type: string; memory_id: string | null; payload: string };
    expect(row.type).toBe('config');
    expect(row.memory_id).toBeNull();
    const payload = JSON.parse(row.payload) as {
      SCHEMA_VERSION: number;
      params: Record<string, unknown>;
    };
    expect(payload.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
    // 完整生效参数（60 项）
    expect(Object.keys(payload.params)).toHaveLength(60);
    expect(payload.params.ARCHIVE_LINE).toBe(DEFAULT_PARAMS.ARCHIVE_LINE);
  });

  it('★ 迁移前后 memories 全字段 / edges 权重 / 行数 零差异；coacts 0 行', () => {
    const dbPath = join(dir, 'memory.db');
    const v1 = createV1Database(dbPath, 4);
    const memoriesBefore = v1.prepare('SELECT * FROM memories ORDER BY id').all();
    const edgesBefore = v1.prepare('SELECT * FROM edges ORDER BY id').all();
    const countsBefore = {
      memories: (v1.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n,
      entities: (v1.prepare('SELECT count(*) AS n FROM entities').get() as { n: number }).n,
      aliases: (v1.prepare('SELECT count(*) AS n FROM entity_aliases').get() as { n: number }).n,
      me: (v1.prepare('SELECT count(*) AS n FROM memory_entities').get() as { n: number }).n,
      history: (v1.prepare('SELECT count(*) AS n FROM content_history').get() as { n: number }).n,
    };
    v1.close();

    const db = open(dbPath);
    ensureSchema(db);

    const memoriesAfter = db.prepare('SELECT * FROM memories ORDER BY id').all();
    const edgesAfter = db.prepare('SELECT * FROM edges ORDER BY id').all();
    // 逐行逐字段比对（embedding 是新列 ⇒ 只比 v1 就有的那些字段）
    for (let index = 0; index < memoriesBefore.length; index += 1) {
      const b = memoriesBefore[index] as Record<string, unknown>;
      const a = memoriesAfter[index] as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        expect(a[key]).toBe(b[key]);
      }
    }
    expect(edgesAfter).toEqual(edgesBefore);
    expect((db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n).toBe(
      countsBefore.memories,
    );
    expect((db.prepare('SELECT count(*) AS n FROM entities').get() as { n: number }).n).toBe(
      countsBefore.entities,
    );
    expect((db.prepare('SELECT count(*) AS n FROM entity_aliases').get() as { n: number }).n).toBe(
      countsBefore.aliases,
    );
    expect((db.prepare('SELECT count(*) AS n FROM memory_entities').get() as { n: number }).n).toBe(
      countsBefore.me,
    );
    expect((db.prepare('SELECT count(*) AS n FROM content_history').get() as { n: number }).n).toBe(
      countsBefore.history,
    );
    // ★ 共激活是**观测**，不回填 ⇒ 迁移后 0 行
    expect((db.prepare('SELECT count(*) AS n FROM coacts').get() as { n: number }).n).toBe(0);
  });

  it('★ 迁移可重复执行（跑两次不炸第二次）⇒ IF NOT EXISTS + table_info 守卫生效', () => {
    const dbPath = join(dir, 'memory.db');
    createV1Database(dbPath).close();

    const first = open(dbPath);
    ensureSchema(first);
    first.close();

    // 第二次打开：版本已是 2 ⇒ 走阶段 B 校验，不重跑迁移
    const second = open(dbPath);
    expect(() => ensureSchema(second)).not.toThrow();
    expect(readUserVersionOf(second)).toBe(2);

    // 更强的验证：**手工**再跑一次阶段 A（模拟重跑迁移）⇒ 不炸
    expect(() => migratePhaseA(second)).not.toThrow();
    expect(readUserVersionOf(second)).toBe(2);
  });

  it('★ 阶段 B 可重入：中断后重跑 ⇒ 结果与一次跑完一致', () => {
    const dbPath = join(dir, 'memory.db');
    createV1Database(dbPath, 5).close();

    const db = open(dbPath);
    // 先只跑阶段 A（阶段 B 未跑 ⇒ archival_schedule 为空）
    migratePhaseA(db);
    expect(
      (db.prepare('SELECT count(*) AS n FROM archival_schedule').get() as { n: number }).n,
    ).toBe(0);

    // 第一次阶段 B：小批次（模拟中断）
    migratePhaseB(db, { batchSize: 2 });
    const partial = db.prepare('SELECT * FROM archival_schedule ORDER BY memory_id').all();

    // 第二次阶段 B：整批重跑
    migratePhaseB(db);
    const full = db.prepare('SELECT * FROM archival_schedule ORDER BY memory_id').all();

    // 可重入 ⇒ 值完全一致（INSERT OR REPLACE，不重复、不翻倍）
    expect(full).toEqual(partial);
    expect(full.length).toBe(5);
  });

  it('★ 阶段 B 回填的 archive_at 用的是 §9.4.1 的公式（且只装 deleted = 0 的行）', () => {
    const dbPath = join(dir, 'memory.db');
    const v1 = createV1Database(dbPath, 2);
    // 把 m2 软删
    v1.prepare('UPDATE memories SET deleted = 1, deleted_at = 3000 WHERE id = ?').run('m2');
    v1.close();

    const db = open(dbPath);
    ensureSchema(db);

    const rows = db
      .prepare('SELECT memory_id, archive_at FROM archival_schedule ORDER BY memory_id')
      .all() as Array<{ memory_id: string; archive_at: number }>;
    // ★ 只装 deleted = 0 的行 ⇒ m2 不在表里
    expect(rows.map((r) => r.memory_id)).toEqual(['m1']);

    const m1 = db
      .prepare('SELECT last_access, stability, pin_factor FROM memories WHERE id = ?')
      .get('m1') as { last_access: number; stability: number; pin_factor: number };
    const expected = Math.trunc(m1.last_access + m1.stability * m1.pin_factor * archiveAtFactor());
    expect(rows[0]?.archive_at).toBe(expected);
  });

  it('★ 阶段 B 跑完后 meta 的 archival_schedule_ready == 1', () => {
    const dbPath = join(dir, 'memory.db');
    createV1Database(dbPath).close();
    const db = open(dbPath);
    ensureSchema(db);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('archival_schedule_ready') as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('1');
  });

  it('user_version = 99 ⇒ 抛 INVALID_INPUT，details.expected/actual 正确', () => {
    const dbPath = join(dir, 'memory.db');
    const v1 = createV1Database(dbPath);
    v1.pragma('user_version = 99');
    v1.close();

    const db = open(dbPath);
    let caught: unknown;
    try {
      ensureSchema(db);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as {
      code?: string;
      details?: { schema?: { expected: number; actual: number } };
    };
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.details?.schema?.expected).toBe(SCHEMA_VERSION);
    expect(err.details?.schema?.actual).toBe(99);
  });

  it('★ user_version = 2 但缺一张新表 ⇒ 抛错，且**不自动补建**（断言表仍缺）', () => {
    const dbPath = join(dir, 'memory.db');
    createV1Database(dbPath).close();
    const db = open(dbPath);
    ensureSchema(db);

    const victim = V2_NEW_TABLES[0] ?? 'coacts';
    db.exec(`DROP TABLE ${victim};`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);

    expect(() => ensureSchema(db)).toThrow(/九张新表不齐全/);
    // ★ 不补建：表仍然缺失
    expect(findV2Tables(db)).not.toContain(victim);
  });

  it('★ 迁移脚本全部用 IF NOT EXISTS（否则重跑会炸）', () => {
    const disk = readFileSync('schema/002_migration_v1_to_v2.sql', 'utf8');
    const creates = disk.match(/^CREATE (TABLE|INDEX|UNIQUE INDEX)/gm) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const line of disk.split('\n')) {
      if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(line)) {
        expect(line).toContain('IF NOT EXISTS');
      }
    }
    // 运行时副本与磁盘逐字相等
    expect(MIGRATION_V1_TO_V2_SQL).toBe(disk);
    // 建库脚本仍然逐字相等（P1-T01 的守卫没被这次改动破坏）
    expect(SCHEMA_SQL).toBe(readFileSync('schema/001_schema_v2.sql', 'utf8'));
  });

  it('★ 迁移不可降级：迁移成功后版本就是 2，不会再退回 1', () => {
    const dbPath = join(dir, 'memory.db');
    createV1Database(dbPath).close();
    const db = open(dbPath);
    const r1 = ensureSchema(db);
    expect(r1.version).toBe(2);
    const r2 = ensureSchema(db);
    expect(r2.version).toBe(2);
    expect(r2.migrated).toBe(false); // 第二次不是迁移，只是校验
  });
});

/** 读 `user_version`。 */
function readUserVersionOf(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** 取 sqlite_master 里 memories 的建表 SQL。 */
function memorySqlOf(db: Database.Database): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
    .get() as { sql: string } | undefined;
  return row?.sql ?? '';
}

/**
 * 从建表 SQL 里抽出 embedding 列的**约束文本**（用于「迁移库 vs 新建库」不分叉的比对）。
 *
 * ⚠️ **必须先归一化空白**：两份 SQL 的**排版不同**（建库脚本里 embedding 的 CHECK 另起一行且缩进，
 *   而 `ALTER TABLE ADD COLUMN` 会把列定义拼成一行）⇒ 直接按字面找会一边命中、一边落空。
 *   ⇒ 归一化 `\s+ ⇒ ' '` 之后，两份文本里的约束**必须逐字相同**。
 */
function embeddingConstraintOf(db: Database.Database): string {
  const sql = memorySqlOf(db).replace(/\s+/g, ' ');
  const match = /embedding BLOB\s+CHECK \(embedding IS NULL OR length\(embedding\) % 4 = 0\)/.exec(
    sql,
  );
  return match === null ? '' : match[0];
}
