import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

/**
 * FTS5 smoke test —— **P0-T01 的硬断言**（DEVELOPMENT-PLAN.md P0-T01 验收标准）：
 *
 * > smoke test 断言 `SELECT count(*) FROM mem_fts` 与 `memories` 行数一致（FTS5 触发器链可用）。
 *
 * 目的（D-06）：在写任何业务代码之前，先确认 better-sqlite3 的预编译包**自带 FTS5**。
 * ⚠️ 这一步必须在动手写依赖它的代码之前做——
 *   否则整周都在错误的依赖上写代码（若无 FTS5 ⇒ 建库直接失败 `no such module: fts5`）。
 *
 * ⚠️ 本文件**不是**建库脚本：完整的 `schema/001_schema_v2.sql` 属阶段 1（P1-T01）。
 *   这里只复刻 §3 的「memories + mem_fts + 三触发器」这一段，
 *   因为它正是 D-06 要验证的那一段（触发器链是否可用）。
 *
 * ⚠️ `content_tokens` 填的是 **§10.2 的大gram 预切分结果**（空格分隔），不是原文：
 *   '张三住在北京' ⇒ '张三 三住 住在 在北 北京'
 *   ⚠️ `unicode61` 会把连续 CJK 串当成**一个** token ⇒ 若直接塞原文 '北京'，
 *      就能命中；但真实库里 `content_tokens` 是 bigram 串，
 *      切分粒度与原文不一致 ⇒ 检索行为会与生产环境**不同**（假绿）。
 *   ⇒ smoke test 必须用**真实切分形态**的数据，否则它测的是一个不存在的系统。
 */

/** §3 的 `mem_fts` 虚拟表定义（external content 挂载显式 rowid）。 */
const CREATE_FTS = `
CREATE VIRTUAL TABLE mem_fts USING fts5(
  content_tokens,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0'
);
`;

/** §3 的三个触发器：insert / delete / update 三条路径都必须同步 FTS 索引。 */
const CREATE_TRIGGERS = `
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

/** §3 的 `memories` 表中与 FTS5 相关的那几列。 */
const CREATE_MEMORIES = `
CREATE TABLE memories (
  rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('fact','event','preference','thought','topic')),
  content        TEXT NOT NULL,
  content_tokens TEXT NOT NULL,
  content_hash   TEXT NOT NULL
);
`;

/** 建库（内存库，测试用）。 */
function openFixture(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_MEMORIES);
  db.exec(CREATE_FTS);
  db.exec(CREATE_TRIGGERS);
  return db;
}

/** 读 FTS5 索引行数与主表行数（断言二者必须相等）。 */
function readCounts(db: Database.Database): { fts: number; memories: number } {
  const fts = db.prepare('SELECT count(*) AS n FROM mem_fts').get() as { n: number };
  const memories = db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number };
  return { fts: fts.n, memories: memories.n };
}

describe('P0-T01 · FTS5 smoke test（better-sqlite3 预编译包自带 FTS5）', () => {
  it('建表成功：FTS5 虚拟表与三个触发器都能建起来', () => {
    const db = openFixture();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((row) => row.name);

      expect(names).toContain('mem_fts');
      expect(names).toContain('mem_ai');
      expect(names).toContain('mem_ad');
      expect(names).toContain('mem_au');
    } finally {
      db.close();
    }
  });

  it('插入后 FTS5 行数与 memories 行数一致', () => {
    const db = openFixture();
    try {
      const insert = db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('m1', 'fact', '张三住在北京', '张三 三住 住在 在北 北京', 'h1');
      insert.run('m2', 'event', '昨天去上海开会', '昨天 天去 去上 上海 海开 开会', 'h2');

      const counts = readCounts(db);
      expect(counts.memories).toBe(2);
      expect(counts.fts).toBe(counts.memories);
    } finally {
      db.close();
    }
  });

  it('全文检索命中：FTS5 external content 查询能取到正文', () => {
    const db = openFixture();
    try {
      db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash) VALUES (?, ?, ?, ?, ?)',
      ).run('m1', 'fact', '张三住在北京', '张三 三住 住在 在北 北京', 'h1');
      db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash) VALUES (?, ?, ?, ?, ?)',
      ).run('m2', 'event', '昨天去上海开会', '昨天 天去 去上 上海 海开 开会', 'h2');

      const rows = db
        .prepare(
          `SELECT m.id, m.content
             FROM mem_fts f
             JOIN memories m ON m.rowid = f.rowid
            WHERE mem_fts MATCH ?
            ORDER BY m.id`,
        )
        .all('北京') as Array<{ id: string; content: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe('m1');
      expect(rows[0]?.content).toBe('张三住在北京');
    } finally {
      db.close();
    }
  });

  it('更新后 FTS5 行数与 memories 行数仍然一致，且检索反映新正文', () => {
    const db = openFixture();
    try {
      db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash) VALUES (?, ?, ?, ?, ?)',
      ).run('m1', 'fact', '张三住在北京', '张三 三住 住在 在北 北京', 'h1');

      db.prepare('UPDATE memories SET content_tokens = ? WHERE id = ?').run(
        '张三 三住 住在 在广 广州',
        'm1',
      );

      const counts = readCounts(db);
      expect(counts.fts).toBe(counts.memories);

      const hitOld = db
        .prepare('SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH ?')
        .get('北京') as { n: number };
      const hitNew = db
        .prepare('SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH ?')
        .get('广州') as { n: number };

      expect(hitOld.n).toBe(0);
      expect(hitNew.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('删除后 FTS5 行数与 memories 行数仍然一致（delete 触发器链可用）', () => {
    const db = openFixture();
    try {
      const insert = db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('m1', 'fact', '张三住在北京', '张三 三住 住在 在北 北京', 'h1');
      insert.run('m2', 'event', '昨天去上海开会', '昨天 天去 去上 上海 海开 开会', 'h2');

      db.prepare('DELETE FROM memories WHERE id = ?').run('m1');

      const counts = readCounts(db);
      expect(counts.memories).toBe(1);
      expect(counts.fts).toBe(counts.memories);

      const hit = db
        .prepare('SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH ?')
        .get('北京') as { n: number };
      expect(hit.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
