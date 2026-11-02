/**
 * ★ SQL 防护层 —— 阶段 5 · P5-T01（设计 §4.3，DESIGN §7.1 只读保证 ②）。
 *
 * **唯一的 SQL 放行判据**：`guard(sql)`。查看器里**每一次**执行原始 SQL 之前都要过它
 * （`db-worker.ts` 的全部 `select` 分支；`queries.ts` 的常量也是靠它自证清白）。
 *
 * ⚠️ **判据是白名单，不是黑名单**：黑名单永远漏一个（`WITH … INSERT` 就是现成的例子——
 *   它的首关键字是 `WITH`，不在任何「写关键字」黑名单里）。
 *
 * ⚠️ **宁可误拒，不可误放**：面板用的 SQL 是**我们自己写的常量**（`queries.ts`），
 *   误拒会在单测里立刻暴露；误放则是「只读保证失效」——两者的代价不对称。
 *
 * ## 判据顺序（**不可换**，每一环都有对应的反例测试）
 *
 * ```
 * ① 剥注释（-- / 块注释）与字符串字面量（'…' / "…" / `…` / […]）
 * ② 单语句：去掉结尾分号之后，正文里不得再出现 `;`
 * ③ 首关键字必须在 ALLOWED_VERBS 里
 * ④ `WITH [RECURSIVE]` ⇒ 整条语句的 token 集里不得出现任何 DML/DDL 词，且必须含 SELECT
 * ⑤ `PRAGMA` ⇒ 名字在 ALLOWED_PRAGMAS 里，且**不得是赋值形态**
 * ⑥ `EXPLAIN [QUERY PLAN] <stmt>` ⇒ 对 `<stmt>` **递归**执行 ①~⑤
 * ```
 *
 * ⚠️ **为什么 ① 必须在 ② 之前**（设计 §4.3 的「负控」就是这一条）：
 *   · `SELECT 'a; DROP TABLE x' AS v` 是**合法的只读语句**（分号与 DROP 都在字符串里）
 *     ⇒ 先判 `;` / 先扫关键字会把它**误拒**；
 *   · 反过来 `select * from memories -- ;\ndrop table x` 必须**被拒**：
 *     剥掉注释之后正文变成两行，`DROP` 这个 token 才露出来。
 *   ⇒ 顺序一换，这两条断言里**必有一条**变红。`viewer-sql-guard.test.ts` 里那份
 *     `naiveGuard`（不剥壳的版本）就是这条负控的**可执行证据**。
 */

/** 放行的三类首关键字。 */
export const ALLOWED_VERBS = ['SELECT', 'PRAGMA', 'EXPLAIN'] as const;

/** 放行的首关键字之一。 */
export type AllowedVerb = (typeof ALLOWED_VERBS)[number];

/**
 * PRAGMA 白名单：**只收「读」形态**。
 *
 * ⚠️ `PRAGMA journal_mode` 不带参数是读、带 `= WAL` 是**写数据库头**
 *   ⇒ 判据不是「名字」，是「**有没有赋值形态**」（见 `PRAGMA_ARG_FORM_ALLOWED`）。
 */
export const ALLOWED_PRAGMAS = [
  'table_info',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'user_version',
  'page_count',
  'page_size',
  'journal_mode',
  'integrity_check',
  'quick_check',
  'compile_options',
] as const;

/** 放行的 PRAGMA 名之一。 */
export type AllowedPragma = (typeof ALLOWED_PRAGMAS)[number];

/**
 * ★ **允许带「参数形态」的 PRAGMA** —— 只有这 5 个「表 / 索引自省」的。
 *
 * ⚠️ 这 5 个的参数是**被查对象的名字**（`PRAGMA table_info(memories)`），
 *   语义是「查这张表」，**不改变库状态**。
 *
 * ⚠️ 反过来，`journal_mode` / `user_version` / `page_size` 这些的参数是**要写入的值**
 *   ⇒ `PRAGMA journal_mode(WAL)` 与 `PRAGMA journal_mode = WAL` **等价**（SQLite 文档里
 *     两种写法都收）⇒ 判据不能只看有没有 `=`（设计 §4.3 ⑤ 的原文只说 `=`，
 *     这里**加严了一道**：`(值)` 形态同样拒。理由：`=` 只是赋值形态的一半，
 *     只拦一半等于没拦）。
 *
 * ⚠️ **代价（诚实记）**：`PRAGMA integrity_check(10)`（带「最多报几条错」参数）会被误拒。
 *   本轮的面板不用它（`verifyIntegrity({deep:true})` 走的是库自己的 `db.pragma()`，
 *   不经过本防护层）⇒ 代价是 0，换来的是「赋值形态零放行」。
 */
export const PRAGMA_ARG_FORM_ALLOWED = [
  'table_info',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
] as const;

/**
 * ★ **DML / DDL / 事务控制的词** —— 出现在语句 token 集里就一律拒绝。
 *
 * ⚠️ 它们**不是**「首关键字黑名单」（那套做法正是 `WITH … INSERT` 能绕过的原因），
 *   而是「**任何位置**出现都不行」的词表。
 *   ⇒ 判据因此从「看第一个词」变成「看全部词」，`WITH c AS (…) INSERT INTO …` 无处可躲。
 *
 * ⚠️ 为什么连 `BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE` 也在里面：
 *   事务控制不是读。SQLite 里 `SELECT` 之外的语句在不带分号时不能拼接，
 *   但「不能拼接」是解析器的行为，不是我们该依赖的东西。
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'UPSERT',
  'DROP',
  'ALTER',
  'CREATE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
];

/** 放行结论。 */
export interface GuardOk {
  /** 恒 `true`（判别式）。 */
  ok: true;
  /** 命中的首关键字（`WITH … SELECT` 归一为 `SELECT`）。 */
  verb: AllowedVerb;
  /** 被放行的 SQL 原文（已 `trim`，**未**删注释 —— 执行的就是调用方交来的那条）。 */
  sql: string;
}

/** 拒绝结论。 */
export interface GuardRejected {
  /** 恒 `false`（判别式）。 */
  ok: false;
  /** 固定的错误码（**五个库错误码之外唯一的查看器自有码**，设计 §7.2）。 */
  code: 'SQL_GUARD_REJECTED';
  /** 人类可读的拒绝理由（进 `details.reason`）。 */
  reason: string;
  /** 判定时看到的「首关键字」（诊断用；多语句时是 `(多语句)`）。 */
  verb: string;
}

/** 防护层的判定结果（**只有这两种**）。 */
export type GuardVerdict = GuardOk | GuardRejected;

/** 造一条拒绝结论。 */
function reject(reason: string, verb: string): GuardRejected {
  return { ok: false, code: 'SQL_GUARD_REJECTED', reason, verb };
}

/**
 * ① 剥掉注释与字符串字面量（把它们的**内容**换成空白）。
 *
 * ⚠️ **保留占位符而不是删掉整段**：`SELECT ''` 与 `SELECT` 是两条不同的语句，
 *   把字面量整段删掉会让 `WHERE a = ''` 变成 `WHERE a = `（虽然我们不解析语法，
 *   但「删掉」会让 token 粘连，例如 `'x'AND` 变成 `AND` 而粘到前一个词上）。
 *   保留一对引号占位就够：它的作用只是「**让内容不参与关键字扫描**」。
 *
 * ⚠️ 支持 `''` / `""` 的双写转义（SQL 的字符串里放引号的标准写法）。
 *
 * @param sql 原始 SQL
 * @returns 注释与字面量内容被抹成空白的 SQL（**长度与换行位置不必保持**）
 */
export function stripCommentsAndLiterals(sql: string): string {
  const out: string[] = [];
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const char = sql[index];
    const next = sql[index + 1];

    // `--` 行注释：吃到行尾（**不吃换行**，否则会把两行粘成一行，
    // 而「两行」正是 `select … -- ;\ndrop table x` 这个绕过的形态）
    if (char === '-' && next === '-') {
      index += 2;
      while (index < length && sql[index] !== '\n') {
        index += 1;
      }
      out.push(' ');
      continue;
    }

    // `/* … */` 块注释
    if (char === '/' && next === '*') {
      index += 2;
      while (index < length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      out.push(' ');
      continue;
    }

    // `'…'` / `"…"` / `` `…` ``（双写转义）
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out.push(`${quote}${quote}`);
      continue;
    }

    // `[…]`（SQLite 的另一种标识符引用）
    if (char === '[') {
      index += 1;
      while (index < length && sql[index] !== ']') {
        index += 1;
      }
      index += 1;
      out.push('[]');
      continue;
    }

    out.push(char ?? '');
    index += 1;
  }

  return out.join('');
}

/** 把（已剥壳的）SQL 拆成大写词 token；数字与标点不进结果。 */
function tokenize(stripped: string): string[] {
  const tokens: string[] = [];
  for (const match of stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    tokens.push((match[0] ?? '').toUpperCase());
  }
  return tokens;
}

/** 取首个词（大写）；没有词 ⇒ `undefined`。 */
function firstWord(text: string): string | undefined {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.trim());
  return match?.[0].toUpperCase();
}

/** token 集里出现的第一批禁用词（空数组 = 干净）。 */
function forbiddenTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => FORBIDDEN_TOKENS.includes(token));
}

/**
 * ★ **唯一的 SQL 放行判据**（设计 §4.3 逐条）。
 *
 * @param sql 待执行的 SQL（**原文**，可以带结尾分号）
 * @returns 放行 / 拒绝（**永不抛错** —— 调用方据 `ok` 分流）
 */
export function guard(sql: string): GuardVerdict {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return reject('SQL 为空', '(空)');
  }

  // ── ① 先剥壳（顺序不可换，见文件头）──
  const stripped = stripCommentsAndLiterals(sql);

  // ── ② 单语句 ──
  const body = stripped.trim();
  const withoutTrailingSemicolon = body.endsWith(';') ? body.slice(0, -1) : body;
  if (withoutTrailingSemicolon.includes(';')) {
    return reject('只允许单条语句：正文里还出现了分号（去掉了结尾那一个之后）', '(多语句)');
  }

  // ── ③ 首关键字白名单 ──
  const verb = firstWord(withoutTrailingSemicolon);
  if (verb === undefined) {
    return reject('SQL 里没有可识别的首关键字', '(空)');
  }

  const tokens = tokenize(withoutTrailingSemicolon);

  // ── ④ CTE：`WITH …` 之后只能是 SELECT（靠「禁用词表」把 INSERT/UPDATE/DELETE 挡掉）──
  if (verb === 'WITH') {
    const forbidden = forbiddenTokens(tokens);
    if (forbidden.length > 0) {
      return reject(
        `CTE 写入被拒绝：语句里出现了 ${forbidden.join(' / ')}（WITH 之后只允许 SELECT）`,
        'WITH',
      );
    }
    if (!tokens.includes('SELECT')) {
      return reject('WITH 之后没有 SELECT ⇒ 不是一条读语句', 'WITH');
    }
    return { ok: true, verb: 'SELECT', sql: sql.trim() };
  }

  if (!(ALLOWED_VERBS as readonly string[]).includes(verb)) {
    return reject(`首关键字 ${verb} 不在白名单（只放行 SELECT / PRAGMA / EXPLAIN）`, verb);
  }

  // ── ⑤ PRAGMA：名字白名单 + 赋值形态零放行 ──
  if (verb === 'PRAGMA') {
    return guardPragma(withoutTrailingSemicolon, sql);
  }

  // ── ⑥ EXPLAIN：对内部语句递归 ──
  if (verb === 'EXPLAIN') {
    const inner = withoutTrailingSemicolon.replace(/^\s*EXPLAIN\s+(?:QUERY\s+PLAN\s+)?/i, '');
    const innerVerdict = guard(inner);
    if (!innerVerdict.ok) {
      return reject(`EXPLAIN 里的语句被拒绝：${innerVerdict.reason}`, 'EXPLAIN');
    }
    return { ok: true, verb: 'EXPLAIN', sql: sql.trim() };
  }

  // ── SELECT：**同样**扫禁用词表 ──
  // ⚠️ 设计 §4.3 把「扫 token 集」写在 ④（CTE）名下，但这条扫描对**所有** SELECT 都要做：
  //   `select * from memories -- ;\ndrop table x` 的首关键字是合法的 SELECT，
  //   剥掉注释后 `DROP` 才露出来 ⇒ 只在 CTE 分支扫会让它通过（而它在设计的拒绝清单里）。
  const forbidden = forbiddenTokens(tokens);
  if (forbidden.length > 0) {
    return reject(`语句里出现了写操作关键字 ${forbidden.join(' / ')}`, verb);
  }

  return { ok: true, verb: 'SELECT', sql: sql.trim() };
}

/**
 * ⑤ 的实体：PRAGMA 的名字白名单与赋值形态判定。
 *
 * @param statement 已剥壳、已去结尾分号的语句（以 `PRAGMA` 开头）
 * @param original 原始 SQL（放行时原样返回给调用方执行）
 */
function guardPragma(statement: string, original: string): GuardVerdict {
  const rest = statement.replace(/^\s*PRAGMA\s+/i, '');
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
  if (nameMatch === null) {
    return reject('PRAGMA 后面没有名字', 'PRAGMA');
  }

  const qualified = nameMatch[0];
  // `PRAGMA main.table_info(x)` 的 schema 前缀不算名字的一部分
  const name = (qualified.split('.').pop() ?? qualified).toLowerCase();

  if (!(ALLOWED_PRAGMAS as readonly string[]).includes(name)) {
    return reject(`PRAGMA ${name} 不在白名单（只放行读形态的 PRAGMA）`, 'PRAGMA');
  }

  const argumentText = rest.slice(qualified.length).trim();
  if (argumentText === '') {
    // 无参数形态：`PRAGMA journal_mode` / `PRAGMA page_count` 都是**读**
    return { ok: true, verb: 'PRAGMA', sql: original.trim() };
  }

  if (!(PRAGMA_ARG_FORM_ALLOWED as readonly string[]).includes(name)) {
    return reject(
      `PRAGMA ${name} 的赋值形态是写库操作（= 或 (值) 都不放行）⇒ 只读查看器不得改库`,
      'PRAGMA',
    );
  }

  // 自省类 PRAGMA 只接受 `(被查对象的名字)` 这一种参数形态
  if (!/^\([^)]*\)$/.test(argumentText)) {
    return reject(`PRAGMA ${name} 的参数形态不合法（只接受 (名字)）`, 'PRAGMA');
  }

  return { ok: true, verb: 'PRAGMA', sql: original.trim() };
}
