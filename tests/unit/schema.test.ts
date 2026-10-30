/**
 * P1-T01 · Schema 建库脚本与连接初始化 —— DESIGN-v2.md §3 / §9.1。
 *
 * 覆盖的验收硬断言（DEVELOPMENT-PLAN.md P1-T01）：
 * · 空目录 `open()` ⇒ 建库成功；`PRAGMA user_version` == 2
 * · `PRAGMA foreign_keys` 在**写连接与只读连接**上都返回 1
 * · `PRAGMA journal_mode` 在写连接上 == wal；只读连接**不执行**该 PRAGMA
 * · `PRAGMA cache_size` 在写连接上 == -64000（负数 = KB）
 * · 建库后 v2 的九张新表齐全（期望 9 行）
 * · mem_fts 三触发器存在；插入后 `count(*) FROM mem_fts` == 1；UPDATE content_tokens 后 FTS 同步
 * · `integrity_check` == ok；`foreign_key_check` 为空
 * · `page_size` == 8192（建库时设一次，对已有库无效 ⇒ 只能在这里断言）
 *
 * 额外（本轮为防漂移而加）：
 * · `src/db/schema.sql.ts` 的内联副本 与 磁盘上的 `schema/001_schema_v2.sql` **逐字相等**
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXPECTED_V2_TABLE_COUNT, V2_NEW_TABLES } from '../../src/core/schema.js';
import { SCHEMA_VERSION } from '../../src/core/version.js';
import {
  CREATION_PRAGMAS,
  PAGE_SIZE,
  READONLY_PRAGMAS,
  WRITE_PRAGMAS,
  applyPragmas,
  createSchema,
  openDatabase,
  readUserVersion,
} from '../../src/db/connection.js';
import { assertV2TablesComplete, ensureSchema, findV2Tables } from '../../src/db/migrate.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';

/** 一个临时数据目录（对应 `<数据目录>` 的根）。 */
let dir: string;
/** 本次打开的句柄（统一在 afterEach 关闭，避免泄漏）。 */
let openDbs: Database.Database[] = [];

/** 打开一个句柄并登记，便于统一关闭。 */
function open(path: string, readonly = false): Database.Database {
  const db = openDatabase({ dbPath: path, readonly });
  openDbs.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-ocean-schema-'));
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

describe('P1-T01 · 建库脚本与 schema 版本', () => {
  it('空目录 open() ⇒ 建库成功；PRAGMA user_version == 2', () => {
    const dbPath = join(dir, 'nested', 'deep', 'memory.db');
    const db = open(dbPath);
    const result = ensureSchema(db);
    expect(result.created).toBe(true);
    expect(readUserVersion(db)).toBe(SCHEMA_VERSION);
    expect(readUserVersion(db)).toBe(2);
    // 父目录不存在时应自动创建
    expect(existsSync(dirname(dbPath))).toBe(true);
  });

  it('★ 新库：page_size == 8192（page_size 必须先于 journal_mode 写库头）', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    expect(db.pragma('page_size', { simple: true })).toBe(PAGE_SIZE);
    expect(PAGE_SIZE).toBe(8192);
  });

  it('★ page_size 的常量 与 建库脚本里的声明 一致（防两处漂移）', () => {
    const disk = readFileSync('schema/001_schema_v2.sql', 'utf8');
    expect(disk).toContain(`PRAGMA page_size = ${PAGE_SIZE};`);
    expect(CREATION_PRAGMAS).toEqual([{ name: 'page_size', value: PAGE_SIZE }]);
  });

  it('★ 已存在的库：不套 CREATION_PRAGMAS（对已有库设 page_size 是假动作）', () => {
    const dbPath = join(dir, 'memory.db');
    const first = open(dbPath);
    ensureSchema(first);
    first.close();
    // 重开（文件已存在）⇒ 不应再套 page_size；但已有库的页大小本就是 8192 ⇒ 断言仍是 8192
    const second = open(dbPath);
    expect(second.pragma('page_size', { simple: true })).toBe(PAGE_SIZE);
    ensureSchema(second);
    expect(second.pragma('page_size', { simple: true })).toBe(PAGE_SIZE);
  });

  it('建库后 v2 的九张新表齐全（期望 9 行，不等于 9 ⇒ 抛错）', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    expect(findV2Tables(db)).toHaveLength(EXPECTED_V2_TABLE_COUNT);
    expect(EXPECTED_V2_TABLE_COUNT).toBe(9);
    expect([...V2_NEW_TABLES].sort()).toEqual([...findV2Tables(db)].sort());
    // 阶段 B 的断言本身不抛
    expect(() => assertV2TablesComplete(db)).not.toThrow();
  });

  it('★ 阶段 B：版本号对了但新表不全 ⇒ 抛错（半成品库不放行）', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    // 人为制造「版本号是 2、但缺表」的半成品库
    db.exec(`DROP TABLE ${V2_NEW_TABLES[0] ?? 'coacts'};`);
    db.pragma('user_version = 2');
    expect(() => ensureSchema(db)).toThrow(/九张新表不齐全/);
  });

  it('★ DDL 的运行时副本 与 磁盘上的 .sql 逐字相等（防两份副本漂移）', () => {
    const disk = readFileSync('schema/001_schema_v2.sql', 'utf8');
    expect(SCHEMA_SQL).toBe(disk);
  });

  it('建库脚本不包事务（否则 PRAGMA foreign_keys 静默无效）', () => {
    const disk = readFileSync('schema/001_schema_v2.sql', 'utf8');
    expect(disk).not.toMatch(/BEGIN\s*;|BEGIN\s+TRANSACTION/i);
    expect(disk).not.toMatch(/COMMIT\s*;/i);
    expect(disk).toContain('PRAGMA user_version = 2;');
    expect(disk).toContain('PRAGMA page_size = 8192;');
  });

  it('未认识的版本号 ⇒ 抛错（不放行更高版本的库）', () => {
    const db = open(join(dir, 'memory.db'));
    createSchema(db);
    db.pragma('user_version = 99');
    expect(() => ensureSchema(db)).toThrow(/不认识的 schema 版本/);
  });

  it('user_version = 1 ⇒ 走 v1 → v2 迁移（P1-T02 已支持）⇒ 结束后版本为 2', () => {
    const db = open(join(dir, 'memory.db'));
    createSchema(db);
    db.pragma('user_version = 1');
    const result = ensureSchema(db);
    expect(result.migrated).toBe(true);
    expect(result.version).toBe(SCHEMA_VERSION);
    expect(findV2Tables(db)).toHaveLength(EXPECTED_V2_TABLE_COUNT);
  });
});

describe('P1-T01 · PRAGMA A/B 两套', () => {
  it('写连接：journal_mode == wal、cache_size == -64000、foreign_keys == 1', () => {
    const db = open(join(dir, 'memory.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('cache_size', { simple: true })).toBe(-64000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // 1 = NORMAL
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000);
    expect(db.pragma('temp_store', { simple: true })).toBe(2); // 2 = MEMORY
  });

  it('只读连接：不设 journal_mode / synchronous（否则 open() 当场抛 SQLITE_READONLY）', () => {
    const names = READONLY_PRAGMAS.map((p) => p.name);
    expect(names).not.toContain('journal_mode');
    expect(names).not.toContain('synchronous');
    // 但必须设 foreign_keys 与 busy_timeout
    expect(names).toContain('foreign_keys');
    expect(names).toContain('busy_timeout');
    expect(names).toContain('cache_size');
  });

  it('★ 只读连接上 foreign_keys 仍为 1（§9.1 最容易出事的一条）', () => {
    const dbPath = join(dir, 'memory.db');
    const w = open(dbPath);
    ensureSchema(w);
    w.close();

    const r = openDatabase({ dbPath, readonly: true });
    openDbs.push(r);
    expect(r.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(r.pragma('cache_size', { simple: true })).toBe(-16000);
    expect(r.pragma('busy_timeout', { simple: true })).toBe(5000);
    // WAL 是持久化在库文件里的属性 ⇒ 只读连接读到的仍是 wal（但**不是它设的**）
    expect(r.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('只读模式下文件不存在 ⇒ 抛 NOT_FOUND（fileMustExist 语义）', () => {
    expect(() => openDatabase({ dbPath: join(dir, 'nope.db'), readonly: true })).toThrow(/不存在/);
  });

  it('PRAGMA 集合本身：cache_size 是负数 = KB（不是页数）', () => {
    const write = WRITE_PRAGMAS.find((p) => p.name === 'cache_size');
    const readonly = READONLY_PRAGMAS.find((p) => p.name === 'cache_size');
    expect(write?.value).toBe(-64000);
    expect(readonly?.value).toBe(-16000);
  });

  it('applyPragmas 可重复调用且幂等（不会因重复设 journal_mode 抛错）', () => {
    const db = open(join(dir, 'memory.db'));
    expect(() => {
      applyPragmas(db, 'write');
      applyPragmas(db, 'write');
    }).not.toThrow();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });
});

describe('P1-T01 · FTS5 触发器链', () => {
  it('三个触发器存在', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(['mem_ad', 'mem_ai', 'mem_au']);
  });

  it('插入一条记忆 ⇒ count(*) FROM mem_fts == 1', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    db.prepare(
      `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                             stability, difficulty, created_at, last_access)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'fact', '张三住在北京', '张三 三住 住在 在北 北京', 'h1', 1, 0.5, 1, 1);
    const n = db.prepare('SELECT count(*) AS n FROM mem_fts').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('★ UPDATE content_tokens ⇒ FTS 同步（旧 token 查不到、新 token 查到）', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    db.prepare(
      `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                             stability, difficulty, created_at, last_access)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'fact', '张三住在北京', '张三 三住 住在 在北 北京', 'h1', 1, 0.5, 1, 1);
    db.prepare('UPDATE memories SET content_tokens = ? WHERE id = ?').run(
      '张三 三住 住在 在广 广州',
      'm1',
    );
    const hitOld = db
      .prepare('SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH ?')
      .get('北京') as { n: number };
    const hitNew = db
      .prepare('SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH ?')
      .get('广州') as { n: number };
    expect(hitOld.n).toBe(0);
    expect(hitNew.n).toBe(1);
    // 条数仍然一致（update 触发器是 delete + insert）
    const n = db.prepare('SELECT count(*) AS n FROM mem_fts').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('DELETE ⇒ FTS 同步（count 归零）', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    db.prepare(
      `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                             stability, difficulty, created_at, last_access)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'fact', '张三住在北京', '张三 三住 住在 在北 北京', 'h1', 1, 0.5, 1, 1);
    db.prepare('DELETE FROM memories WHERE id = ?').run('m1');
    const n = db.prepare('SELECT count(*) AS n FROM mem_fts').get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('P1-T01 · 建库后的一致性检查', () => {
  it('integrity_check == ok；foreign_key_check 为空', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    const integrity = db.pragma('integrity_check', { simple: true });
    expect(integrity).toBe('ok');
    const fk = db.pragma('foreign_key_check') as unknown[];
    expect(fk).toEqual([]);
  });

  it('★ 外键级联真的生效（foreign_keys 开了的证据）', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    db.prepare('INSERT INTO entities (id, name, created_at) VALUES (?, ?, ?)').run('e1', '张三', 1);
    db.prepare('INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run('老张', 'e1');
    db.prepare('DELETE FROM entities WHERE id = ?').run('e1');
    const left = db
      .prepare('SELECT count(*) AS n FROM entity_aliases WHERE entity_id = ?')
      .get('e1') as { n: number };
    // 开了 foreign_keys ⇒ ON DELETE CASCADE 生效 ⇒ 别名被级联删除
    expect(left.n).toBe(0);
  });

  it('★ 给 embedding 没有建任何索引（§3 明令禁止）', () => {
    const db = open(join(dir, 'memory.db'));
    ensureSchema(db);
    const sqlRows = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ sql: string | null }>;
    const withEmbedding = sqlRows.filter((row) =>
      (row.sql ?? '').toLowerCase().includes('embedding'),
    );
    expect(withEmbedding).toEqual([]);
  });
});
