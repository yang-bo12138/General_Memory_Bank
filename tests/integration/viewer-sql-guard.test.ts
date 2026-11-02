/**
 * ★ SQL 防护层的单测 —— 阶段 5 · T02（设计 §4.3 / PLAN P5-T01 的硬断言）。
 *
 * 三条验收线：
 *   ① **放行** `SELECT` / `PRAGMA`(白名单内且非赋值形态) / `EXPLAIN [QUERY PLAN] SELECT`；
 *   ② **拒绝** 11 个 DML/DDL 首关键字 + `WITH … INSERT/UPDATE/DELETE` + PRAGMA 赋值形态
 *      + 多语句 + 注释绕过；
 *   ③ **判据顺序有负控**：把「先剥字符串/注释」这一步**去掉** ⇒ 至少 1 条断言变红。
 *
 * ⚠️ ③ 不是口头承诺：本文件里那个 `naiveGuard`（去掉剥壳的版本）就是**可执行的负控**
 *   —— 它在两条真正有判别力的用例上给出**与 `guard` 相反**的结论。
 *   如果哪天有人把 `stripCommentsAndLiterals` 从 `guard` 里摘掉，`guard` 就会退化成
 *   `naiveGuard`，而断言会立刻指着这两条说「它变了」。
 */

import { describe, expect, it } from 'vitest';

import { SQL_QUERIES } from '../../viewer/main/queries.js';
import {
  ALLOWED_PRAGMAS,
  ALLOWED_VERBS,
  PRAGMA_ARG_FORM_ALLOWED,
  guard,
  stripCommentsAndLiterals,
} from '../../viewer/main/sql-guard.js';

/** 断言「被放行」，并返回命中的 verb。 */
function expectAllowed(sql: string): string {
  const verdict = guard(sql);
  if (!verdict.ok) {
    throw new Error(`期望放行，实际被拒：${sql}\n  理由：${verdict.reason}`);
  }
  return verdict.verb;
}

/** 断言「被拒绝」，返回拒绝理由（供进一步断言用）。 */
function expectRejected(sql: string): string {
  const verdict = guard(sql);
  if (verdict.ok) {
    throw new Error(`期望拒绝，实际被放行：${sql}`);
  }
  expect(verdict.code).toBe('SQL_GUARD_REJECTED');
  return verdict.reason;
}

describe('T02 · SQL 防护层：放行的三类（正例）', () => {
  it('`SELECT` 放行，verb = SELECT', () => {
    expect(expectAllowed('SELECT 1')).toBe('SELECT');
    expect(expectAllowed('  select id from memories limit 10  ')).toBe('SELECT');
    expect(expectAllowed('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('SELECT');
  });

  it('`PRAGMA` 的**读形态**放行', () => {
    expect(expectAllowed('PRAGMA user_version')).toBe('PRAGMA');
    expect(expectAllowed('PRAGMA journal_mode')).toBe('PRAGMA');
    expect(expectAllowed('PRAGMA page_count')).toBe('PRAGMA');
    // 表 / 索引自省：参数是**被查对象的名字**，不改库状态
    expect(expectAllowed('PRAGMA table_info(memories)')).toBe('PRAGMA');
    expect(expectAllowed('PRAGMA index_list(memories)')).toBe('PRAGMA');
    expect(expectAllowed('PRAGMA main.table_info(memories)')).toBe('PRAGMA');
  });

  it('`EXPLAIN [QUERY PLAN] SELECT` 放行（内部语句被递归判定）', () => {
    expect(expectAllowed('EXPLAIN SELECT 1')).toBe('EXPLAIN');
    expect(expectAllowed('EXPLAIN QUERY PLAN SELECT * FROM memories')).toBe('EXPLAIN');
  });

  it('结尾分号是允许的（只允许**一个**，且在结尾）', () => {
    expect(expectAllowed('SELECT 1;')).toBe('SELECT');
    expect(expectAllowed('SELECT 1 ;  ')).toBe('SELECT');
  });

  it('字符串字面量里的分号与写关键字**不影响**判定（剥壳之后的判据）', () => {
    // ⚠️ 这条是本文件最重要的正例：它同时在验「先剥壳」这一步真的有效
    expect(expectAllowed("SELECT 'a; DROP TABLE x' AS v")).toBe('SELECT');
    expect(expectAllowed("SELECT * FROM content_history WHERE content = 'update me'")).toBe(
      'SELECT',
    );
  });

  it('白名单常量本身：3 个 verb、12 个 pragma、5 个允许参数形态的 pragma', () => {
    // ⚠️ 分母写死（设计 §4.3 逐字给出的那张表）
    expect([...ALLOWED_VERBS]).toEqual(['SELECT', 'PRAGMA', 'EXPLAIN']);
    expect(ALLOWED_PRAGMAS.length).toBe(12);
    expect(PRAGMA_ARG_FORM_ALLOWED.length).toBe(5);
    // ⚠️ 允许参数形态的那 5 个必须是白名单的**子集**（否则就是一条永远不生效的规则）
    expect(PRAGMA_ARG_FORM_ALLOWED.every((name) => ALLOWED_PRAGMAS.includes(name))).toBe(true);
  });
});

describe('T02 · SQL 防护层：拒绝清单（逐条，设计 §4.3 逐字）', () => {
  it.each([
    ['INSERT', 'INSERT INTO memories (id) VALUES (?)'],
    ['UPDATE', 'UPDATE memories SET deleted = 1'],
    ['DELETE', 'DELETE FROM memories'],
    ['DROP', 'DROP TABLE memories'],
    ['ALTER', 'ALTER TABLE memories ADD COLUMN x TEXT'],
    ['CREATE', 'CREATE TABLE x (id TEXT)'],
    ['ATTACH', "ATTACH DATABASE 'x.db' AS x"],
    ['DETACH', 'DETACH DATABASE x'],
    ['VACUUM', 'VACUUM'],
    ['REINDEX', 'REINDEX'],
    ['ANALYZE', 'ANALYZE'],
  ])('首关键字 %s 被拒', (_label, sql) => {
    expectRejected(sql);
  });

  it('★ `WITH … <写操作>` 被拒（只按首关键字会让它整类通过）', () => {
    expectRejected('WITH c AS (SELECT 1) INSERT INTO memories (id) SELECT * FROM c');
    expectRejected('WITH RECURSIVE c AS (SELECT 1) UPDATE memories SET deleted = 1');
    expectRejected('WITH c AS (SELECT 1) DELETE FROM memories');
    // ⚠️ 反向对照：同样的 CTE 形状，收在 SELECT 上就**必须放行**
    expect(expectAllowed('WITH c AS (SELECT 1) SELECT * FROM c')).toBe('SELECT');
  });

  it('`WITH` 之后没有 SELECT ⇒ 不是一条读语句', () => {
    expectRejected('WITH c AS (VALUES (1)) c');
  });

  it('★ `PRAGMA` 的赋值形态被拒（`=` 与 `(值)` 都拒）', () => {
    expectRejected('PRAGMA journal_mode = WAL');
    expectRejected('PRAGMA journal_mode=WAL');
    expectRejected('PRAGMA user_version = 5');
    // ⚠️ `(值)` 形态与 `= 值` 在 SQLite 里等价 ⇒ 只拦 `=` 等于只拦一半
    expectRejected('PRAGMA journal_mode(WAL)');
    expectRejected('PRAGMA user_version(5)');
    expectRejected('PRAGMA page_size(4096)');
    // 自省类也不许写成 `= `
    expectRejected('PRAGMA table_info = memories');
    // 不在白名单里的 PRAGMA（`foreign_keys` 是**连接级写**）
    expectRejected('PRAGMA foreign_keys = ON');
    expectRejected('PRAGMA cache_size = -64000');
  });

  it('多语句被拒（第二个分号）', () => {
    expectRejected('SELECT 1; DROP TABLE memories');
    expectRejected('SELECT 1;;');
  });

  it('★ 注释绕过被拒（`select … -- ;⏎drop …`）', () => {
    expectRejected('select * from memories -- ;\ndrop table x');
    // 块注释同理
    expectRejected('select * from memories /* ; */ ; drop table x');
  });

  it('空 SQL 与无首关键字被拒', () => {
    expectRejected('');
    expectRejected('   ');
    expectRejected('-- 只有注释');
    expectRejected('(SELECT 1)');
  });

  it('`EXPLAIN` 里的语句同样过判据（`EXPLAIN INSERT` 也拒）', () => {
    expectRejected('EXPLAIN INSERT INTO memories (id) VALUES (?)');
    expectRejected('EXPLAIN DELETE FROM memories');
  });

  it('拒绝时 verb 字段有值（诊断用），且 code 恒为 SQL_GUARD_REJECTED', () => {
    const verdict = guard('DROP TABLE memories');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.verb).toBe('DROP');
      expect(verdict.code).toBe('SQL_GUARD_REJECTED');
      expect(verdict.reason).toContain('DROP');
    }
  });
});

describe('T02 · ★ 判据顺序的负控：去掉「先剥壳」必须让至少一条断言变红', () => {
  /**
   * **故意写坏的判据 A**：只看首关键字，**不扫 token 集**、不判分号。
   *
   * ⚠️ 它**不是**被测对象，是**反例的生成器**：`WITH … INSERT` 与
   *   「注释把两行粘在一起」这两类，它一律放行 —— 证明「扫 token 集」不是装饰。
   */
  function verbOnly(sql: string): 'allow' | 'reject' {
    return /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) ? 'allow' : 'reject';
  }

  /**
   * **故意写坏的判据 B**：**不剥壳**就在原始文本上判「单语句」与写关键字。
   *
   * ⚠️ 证明「先剥字符串/注释」不是装饰：它在**合法**语句上误拒（分号在字符串里）。
   */
  function rawTextOnly(sql: string): 'allow' | 'reject' {
    const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'ATTACH'];
    const upper = sql.toUpperCase();
    const body = upper.trimEnd().replace(/;$/, '');
    if (body.includes(';')) return 'reject';
    if (forbidden.some((word) => upper.includes(word))) return 'reject';
    return /^\s*SELECT/.test(upper) ? 'allow' : 'reject';
  }

  it('① 字面量里的分号：判据 B 误拒，guard 放行（⇒ 剥壳不可省）', () => {
    const sql = "SELECT 'a; DROP TABLE x' AS v";
    expect(rawTextOnly(sql)).toBe('reject'); // ← 去掉剥壳就是这个结果
    expect(guard(sql).ok).toBe(true);
  });

  it('② 注释把两行粘在一起：判据 A 放行，guard 拒绝（⇒ 扫 token 集不可省）', () => {
    const sql = 'select * from memories -- ;\ndrop table x';
    expect(verbOnly(sql)).toBe('allow'); // ← 只看首关键字就是这个结果
    expect(guard(sql).ok).toBe(false);
  });

  it('③ `WITH … INSERT`：判据 A 放行，guard 拒绝（⇒ 白名单必须落到 token 层）', () => {
    const sql = 'WITH c AS (SELECT 1) INSERT INTO memories (id) SELECT * FROM c';
    expect(verbOnly(sql)).toBe('allow');
    expect(guard(sql).ok).toBe(false);
  });

  it('④ 剥壳函数本身：注释与字面量的内容必须被抹掉，但结构留着', () => {
    expect(stripCommentsAndLiterals("SELECT 'DROP' AS v")).not.toContain('DROP');
    // ⚠️ 占位符保留（`''`）：`SELECT ''` 与 `SELECT` 仍是两条不同的语句形状
    expect(stripCommentsAndLiterals("SELECT '' AS v")).toContain("''");
    // 行注释**不吃换行**（否则两行会被粘成一行，绕过就看不见了）
    expect(stripCommentsAndLiterals('select 1 -- x\ndrop table t')).toContain('\n');
    expect(stripCommentsAndLiterals('select 1 -- x\ndrop table t')).not.toContain('-- x');
    // 块注释整段抹掉
    expect(stripCommentsAndLiterals('select /* DROP */ 1')).not.toContain('DROP');
    // 双写转义：`''` 不会被当成字符串结束
    expect(stripCommentsAndLiterals("select 'it''s DROP' , 2")).not.toContain('DROP');
  });
});

describe('T02 · 面板 4/6 的 SQL 常量自证清白', () => {
  it('每条 SQL 都被防护层放行（否则面板一打开就是 SQL_GUARD_REJECTED）', () => {
    for (const [name, sql] of Object.entries(SQL_QUERIES)) {
      expect(guard(sql).ok, `SQL_QUERIES.${name} 被防护层拒了`).toBe(true);
    }
  });

  it('★ 每条 SQL 都带 `LIMIT`（本文件的唯一不变量，连标量聚合也不例外）', () => {
    const hasLimit = (sql: string): boolean => /\bLIMIT\b/i.test(sql);
    for (const [name, sql] of Object.entries(SQL_QUERIES)) {
      expect(hasLimit(sql), `SQL_QUERIES.${name} 没有 LIMIT`).toBe(true);
    }
  });

  it('反例：把 LIMIT 全部摘掉的那份常量必须被同一条判据抓到', () => {
    const hasLimit = (sql: string): boolean => /\bLIMIT\b/i.test(sql);
    expect(hasLimit(SQL_QUERIES.graphTwoHop)).toBe(true);
    expect(hasLimit(SQL_QUERIES.graphTwoHop.replace(/LIMIT @nodeLimit/g, ''))).toBe(false);
  });
});
