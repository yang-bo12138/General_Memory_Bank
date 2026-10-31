/**
 * 分词与查询构造的单测 —— DESIGN-v2.md §10.2，对应 DEVELOPMENT-PLAN.md **P1-T03**。
 *
 * ★ 本文件的断言纪律（沿用阶段 0 确立的口径）：
 *   · **每条硬断言配一条反例**：反例不是「换个输入再看一遍」，而是**故意写出那个会错的写法**，
 *     断言「它会错、而实现不会错」⇒ 证明断言**真能发现不一致**（否则断言只是装饰）。
 *   · **不写死「本次跑出来几条」**：性质类断言用**网格遍历**（输入数组 + 循环），
 *     加一个用例不会让断言失效，删一个也不会被掩盖。
 *   · **数值用例手算可复算**：期望值写成 `Math.exp(-1)` 这类**与公式同源的闭式表达式**，
 *     不写「跑出来是多少就是多少」的快照数字。
 *
 * ⚠️ **一条已知的「设计稿 vs 断言」落差**（不改实现，只把断言写成**性质**）：
 *   DEVELOPMENT-PLAN.md P1-T03 的硬断言写着「`buildMatchQuery("猫粮")` ⇒ `matchSql` 含 `AND`」，
 *   而 §10.2 的实现里**单 token 的 AND 支会退化成「只有一个条件」**（`"猫粮"`）——
 *   `AND` 连接符只在**两个及以上**条件时才会出现在串里。
 *   ⇒ 这里断言的是**分支语义**（「≤3 个 token ⇒ AND 支；>3 ⇒ OR 支」），
 *     并用 `countConditions()` 数条件个数，而不是去匹配连接符的字面量。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  MAX_MATCH_TOKENS,
  buildMatchQuery,
  escapeFts5,
  escapeLike,
  normalize,
  toHalfWidth,
  tokenize,
} from '../../src/core/tokenize.js';

/** 切出 token 数组（测试里的「参考切分」，与实现同源但独立写法）。 */
function tokensOf(text: string): string[] {
  return tokenize(text).split(' ').filter(Boolean);
}

/** 数一数 `matchSql` 里的**条件个数**（按 ` AND ` / ` OR ` 切分）。 */
function countConditions(matchSql: string | null): number {
  if (matchSql === null || matchSql === '') {
    return 0;
  }
  return matchSql
    .split(' AND ')
    .flatMap((part) => part.split(' OR '))
    .filter((condition) => condition !== '').length;
}

// ─────────────────────────────────────────────────────────────
// toHalfWidth
// ─────────────────────────────────────────────────────────────

describe('toHalfWidth（§10.2）', () => {
  it('全角 ASCII 区间 U+FF01–U+FF5E → U+0021–U+007E（**整段**逐码点核对）', () => {
    // ⚠️ 不用几个样例「抽查」，而是把**整段区间**都走一遍：
    //   少转一个码点 ⇒ 那个字符被静默丢弃 ⇒ 不报错、只是搜不到。
    for (let code = 0xff01; code <= 0xff5e; code += 1) {
      const full = String.fromCharCode(code);
      const half = String.fromCharCode(code - 0xfee0);
      expect(toHalfWidth(full)).toBe(half);
    }
  });

  it('U+3000（全角空格）→ 普通空格', () => {
    expect(toHalfWidth('　')).toBe(' ');
  });

  it('普通空格、半角字符与中文**原样保留**', () => {
    expect(toHalfWidth('a b')).toBe('a b');
    expect(toHalfWidth('abc')).toBe('abc');
    expect(toHalfWidth('猫粮')).toBe('猫粮');
  });

  it('★ 反例：不转半角的实现会把全角字母**静默丢弃**（本函数必须改变它）', () => {
    // 错的实现：原样返回
    const wrongToHalfWidth = (text: string): string => text;
    expect(wrongToHalfWidth('ＡＢＣ')).toBe('ＡＢＣ');
    expect(toHalfWidth('ＡＢＣ')).toBe('ABC');
    expect(toHalfWidth('ＡＢＣ')).not.toBe(wrongToHalfWidth('ＡＢＣ'));
  });
});

// ─────────────────────────────────────────────────────────────
// normalize
// ─────────────────────────────────────────────────────────────

describe('normalize（§10.2 · 只用于算 content_hash）', () => {
  it('去首尾空白 → 全角转半角 → 小写', () => {
    expect(normalize('  ＡＢＣ  ')).toBe('abc');
  });

  it('等价的写法归一化到**同一个**结果（这正是「完全重复」判定的前提）', () => {
    const equivalents = ['abc', 'ABC', 'ＡＢＣ', '  abc  ', '　abc　', 'Abc'];
    for (const text of equivalents) {
      expect(normalize(text)).toBe('abc');
    }
  });

  it('不改动内容**中间**的空白（只去首尾）', () => {
    expect(normalize('a b')).toBe('a b');
    expect(normalize('猫 粮')).toBe('猫 粮');
  });

  it('★ 反例：不转半角的实现会让全角与半角算出**不同的 hash**', () => {
    const wrongNormalize = (text: string): string => text.trim().toLowerCase();
    expect(wrongNormalize('ＡＢＣ')).not.toBe(wrongNormalize('abc'));
    expect(normalize('ＡＢＣ')).toBe(normalize('abc'));
  });
});

// ─────────────────────────────────────────────────────────────
// tokenize
// ─────────────────────────────────────────────────────────────

describe('tokenize（§10.2）', () => {
  it('中文 2 字滑窗（bigram）', () => {
    expect(tokenize('猫粮')).toBe('猫粮');
    expect(tokenize('猫粮很香')).toBe('猫粮 粮很 很香');
  });

  it('单个汉字**原样保留**（它构不成 bigram，但丢掉它会让「搜一个字」彻底无候选）', () => {
    expect(tokenize('猫')).toBe('猫');
  });

  it('英文 / 数字**保留整词**（不参与 bigram）', () => {
    expect(tokenize('config')).toBe('config');
    expect(tokenize('PG15')).toBe('pg15');
  });

  it('数字串被逐段切碎（§10.3 的已知限制：不是 bug）', () => {
    expect(tokenize('1.2.3')).toBe('1 2 3');
  });

  it('全角转半角 + 转小写', () => {
    expect(tokenize('ＡＢＣ')).toBe('abc');
    expect(tokenize('Config')).toBe('config');
  });

  it('中英混合：中文段走 bigram、拉丁段走整词', () => {
    expect(tokenize('猫粮config')).toBe('猫粮 config');
  });

  it('标点被丢弃，而且它会把汉字段**切断**（bigram 不跨标点）', () => {
    // ⚠️ 「猫，粮。」切成两个汉字段 ⇒ 每段长度 1 ⇒ 各留一个单字 token
    expect(tokenize('猫，粮。')).toBe('猫 粮');
    // 对照：没有标点时同两个字构成一个 bigram
    expect(tokenize('猫粮')).toBe('猫粮');
  });

  it('性质：长度 n 的纯汉字串 ⇒ n-1 个 bigram（n=1 时保留 1 个单字），相邻 token 重叠 1 字', () => {
    for (let length = 1; length <= 12; length += 1) {
      const text = '猫'.repeat(length);
      const tokens = tokensOf(text);
      expect(tokens.length).toBe(length === 1 ? 1 : length - 1);
      for (let index = 1; index < tokens.length; index += 1) {
        const previous = tokens[index - 1] ?? '';
        const current = tokens[index] ?? '';
        // 相邻两个 bigram 恰好重叠 1 个字
        expect(previous.slice(1)).toBe(current.slice(0, 1));
      }
    }
  });

  it('性质：全角写法与半角写法的切分结果**完全相同**（否则同一条记忆会有两种可检索形态）', () => {
    const halfWidthSamples = ['abc', 'ABC', 'cat food', 'PG15', 'a1_b2', 'cat', 'x'];
    for (const sample of halfWidthSamples) {
      const fullWidth = sample.replace(/[\x21-\x7e]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) + 0xfee0),
      );
      expect(tokenize(fullWidth)).toBe(tokenize(sample));
    }
  });

  it('★ 反例：不做 `toHalfWidth` 的实现会把全角字母数字**静默丢弃**（返回空串）', () => {
    const wrongTokenize = (text: string): string => {
      const parts = text.match(/[\u4e00-\u9fa5]+|[a-zA-Z0-9_]+/g) ?? [];
      return parts.join(' ');
    };
    expect(wrongTokenize('ＡＢＣ')).toBe('');
    expect(tokenize('ＡＢＣ')).toBe('abc');
    expect(tokenize('ＡＢＣ')).not.toBe(wrongTokenize('ＡＢＣ'));
  });
});

// ─────────────────────────────────────────────────────────────
// escapeFts5
// ─────────────────────────────────────────────────────────────

describe('escapeFts5（§10.2）', () => {
  it('内部双引号转义 + **整体包裹**双引号', () => {
    expect(escapeFts5('a"b')).toBe('"a""b"');
  });

  it('不含双引号的 token 也会被包裹（包裹是「当一个词」而不是「当一串词」）', () => {
    expect(escapeFts5('猫粮')).toBe('"猫粮"');
    expect(escapeFts5('config')).toBe('"config"');
  });

  it('性质：结果总是以双引号开头结尾，且内部双引号数**成对翻倍**', () => {
    const samples = ['猫粮', 'a"b', '""', 'a""b', 'plain'];
    for (const sample of samples) {
      const escaped = escapeFts5(sample);
      expect(escaped.startsWith('"')).toBe(true);
      expect(escaped.endsWith('"')).toBe(true);
      const inner = escaped.slice(1, -1);
      const innerQuotes = (inner.match(/"/g) ?? []).length;
      const sourceQuotes = (sample.match(/"/g) ?? []).length;
      expect(innerQuotes).toBe(sourceQuotes * 2);
    }
  });

  it('★ 反例（真 FTS5）：**只转义不包裹** ⇒ FTS5 把 token 当作多个词（短语变成隐式 AND）', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61 remove_diacritics 0');");
      db.prepare('INSERT INTO t(rowid, x) VALUES (1, ?)').run('猫 狗');
      db.prepare('INSERT INTO t(rowid, x) VALUES (2, ?)').run('猫 很远 狗');

      // 错的实现：只转义、不包裹
      const wrongEscape = (token: string): string => token.replace(/"/g, '""');
      const wrongHits = db
        .prepare('SELECT rowid FROM t WHERE t MATCH ?')
        .all(wrongEscape('猫 狗')) as Array<{ rowid: number }>;
      // 正确的实现：包裹 + 转义 ⇒ 短语匹配
      const rightHits = db
        .prepare('SELECT rowid FROM t WHERE t MATCH ?')
        .all(escapeFts5('猫 狗')) as Array<{ rowid: number }>;

      // 错实现把「猫 狗」当成两个词 ⇒ 命中了不相邻的文档
      expect(wrongHits.map((row) => row.rowid)).toEqual([1, 2]);
      // 正确实现只命中短语本身
      expect(rightHits.map((row) => row.rowid)).toEqual([1]);
      expect(rightHits.length).toBeLessThan(wrongHits.length);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// escapeLike
// ─────────────────────────────────────────────────────────────

describe('escapeLike（§10.2）', () => {
  it('LIKE 通配符被转义', () => {
    expect(escapeLike('50%')).toBe('50\\%');
  });

  it('性质：`%` / `_` / `\\` 三个字符都被转义，其余字符**原样保留**', () => {
    const samples = ['50%', 'a_b', 'c\\d', '猫粮', 'plain text', '%_%'];
    for (const sample of samples) {
      const escaped = escapeLike(sample);
      // 逐字符核对：只有那三个字符被加了反斜杠
      for (let index = 0; index < sample.length; index += 1) {
        const char = sample.charAt(index);
        if (char === '%' || char === '_' || char === '\\') {
          expect(escaped).toContain(`\\${char}`);
        }
      }
      expect(escaped.replace(/\\([%_\\])/g, '$1')).toBe(sample);
    }
  });

  it('★ 反例（真 SQLite）：不转义 ⇒ LIKE 的 `%` 变成通配符 ⇒ 命中数变多', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE docs (x TEXT NOT NULL);');
      db.prepare('INSERT INTO docs (x) VALUES (?)').run('50% 的折扣');
      db.prepare('INSERT INTO docs (x) VALUES (?)').run('50 元起');

      const escaped = db
        .prepare("SELECT COUNT(*) AS n FROM docs WHERE x LIKE ('%' || ? || '%') ESCAPE '\\'")
        .get(escapeLike('50%')) as { n: number };
      const unescaped = db
        .prepare("SELECT COUNT(*) AS n FROM docs WHERE x LIKE ('%' || ? || '%') ESCAPE '\\'")
        .get('50%') as { n: number };

      expect(escaped.n).toBe(1);
      expect(unescaped.n).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// buildMatchQuery
// ─────────────────────────────────────────────────────────────

describe('buildMatchQuery（§10.2）', () => {
  it('分支 ①：切不出 token ⇒ 双 `null`（文本路整体不执行）', () => {
    for (const empty of ['', '   ', '，。！？', '\u3000']) {
      expect(buildMatchQuery(empty)).toEqual({ matchSql: null, fallbackLike: null });
    }
  });

  it('分支 ②a：单个**汉字** ⇒ LIKE 兜底（FTS 条件为 null）', () => {
    expect(buildMatchQuery('猫')).toEqual({ matchSql: null, fallbackLike: '猫' });
  });

  it('分支 ②b：单个**拉丁字母 / 数字** ⇒ 双 `null`（LIKE 会扫全表且区分度为零）', () => {
    expect(buildMatchQuery('a')).toEqual({ matchSql: null, fallbackLike: null });
    expect(buildMatchQuery('5')).toEqual({ matchSql: null, fallbackLike: null });
  });

  it('分支 ③a：≤3 个 bigram ⇒ AND 精确收敛', () => {
    const result = buildMatchQuery('猫粮很香');
    expect(result.fallbackLike).toBeNull();
    expect(result.matchSql).not.toBeNull();
    expect(result.matchSql).toContain(' AND ');
    expect(result.matchSql).not.toContain(' OR ');
    // 条件个数 == token 个数
    expect(countConditions(result.matchSql)).toBe(tokensOf('猫粮很香').length);
  });

  it('分支 ③b：>3 个 bigram ⇒ OR 宽松召回（交给 BM25 排位）', () => {
    const result = buildMatchQuery('她喜欢猫粮并且用PG15');
    expect(result.fallbackLike).toBeNull();
    expect(result.matchSql).not.toBeNull();
    expect(result.matchSql).toContain(' OR ');
    expect(result.matchSql).not.toContain(' AND ');
  });

  it('性质：AND / OR 的分界**恰好**在 3 个 token（≤3 用 AND，>3 用 OR）', () => {
    for (let length = 2; length <= 12; length += 1) {
      const query = '猫'.repeat(length);
      const tokens = tokensOf(query);
      const result = buildMatchQuery(query);
      expect(result.matchSql).not.toBeNull();
      const usesOr = (result.matchSql ?? '').includes(' OR ');
      expect(usesOr).toBe(tokens.length > 3);
      expect(countConditions(result.matchSql)).toBe(Math.min(tokens.length, MAX_MATCH_TOKENS));
    }
  });

  it('性质：单 token 时 AND 支退化成「一个条件」（不是 OR、也不走 LIKE 兜底）', () => {
    const result = buildMatchQuery('猫粮');
    expect(result.fallbackLike).toBeNull();
    expect(result.matchSql).not.toBeNull();
    expect(result.matchSql).not.toContain(' OR ');
    expect(countConditions(result.matchSql)).toBe(1);
  });

  it('性质：token 数超过上限时只取**前** MAX_MATCH_TOKENS 个（SQLite 上限防护）', () => {
    const query = '猫'.repeat(MAX_MATCH_TOKENS + 10);
    const result = buildMatchQuery(query);
    expect(countConditions(result.matchSql)).toBe(MAX_MATCH_TOKENS);
    // 取的是**前** N 个 ⇒ 第一个条件仍是原文的第一个 bigram
    const firstToken = tokensOf(query)[0] ?? '';
    expect(result.matchSql?.startsWith(escapeFts5(firstToken))).toBe(true);
  });

  it('★ 反例：把「单 token 长度 1」的判定放到「≤3 个 token」之后 ⇒ 单字汉字会走 FTS 而不是 LIKE 兜底', () => {
    // 错的实现：先判 AND / OR 支
    const wrongBuild = (q: string): { matchSql: string | null; fallbackLike: string | null } => {
      const tokens = tokensOf(q);
      if (tokens.length === 0) {
        return { matchSql: null, fallbackLike: null };
      }
      if (tokens.length <= 3) {
        return { matchSql: tokens.map(escapeFts5).join(' AND '), fallbackLike: null };
      }
      return { matchSql: tokens.map(escapeFts5).join(' OR '), fallbackLike: null };
    };

    expect(wrongBuild('猫').matchSql).not.toBeNull(); // 错的实现给出了 FTS 条件
    expect(buildMatchQuery('猫').matchSql).toBeNull(); // 正确实现走 LIKE 兜底
    expect(buildMatchQuery('猫').fallbackLike).toBe('猫');
  });

  it('★ 反例：把「单个拉丁字母」也放进 LIKE 兜底 ⇒ 文本路会被噪声淹没', () => {
    // 错的实现：单 token 长度 1 一律走 LIKE
    const wrongBuild = (q: string): { matchSql: string | null; fallbackLike: string | null } => {
      const tokens = tokensOf(q);
      if (tokens.length === 0) {
        return { matchSql: null, fallbackLike: null };
      }
      if (tokens.length === 1 && tokens[0]?.length === 1) {
        return { matchSql: null, fallbackLike: escapeLike(tokens[0] ?? '') };
      }
      return { matchSql: null, fallbackLike: null };
    };

    expect(wrongBuild('a').fallbackLike).toBe('a');
    expect(buildMatchQuery('a').fallbackLike).toBeNull();
  });

  it('§4.9 步骤 3a 的去重查询串**不经过** buildMatchQuery（它自己 tokenize + 取前 3 个 + AND 连接）', () => {
    const text = '她喜欢猫粮并且用PG15';
    // 去重路（§4.9 步骤 3a 的写法）：自己切、自己取前 3 个、自己 AND 连接
    const dedupSql = tokensOf(text).slice(0, 3).map(escapeFts5).join(' AND ');
    expect(countConditions(dedupSql)).toBe(3);
    expect(dedupSql).toContain(' AND ');

    // ⚠️ 复用 buildMatchQuery 会得到**另一个**东西（>3 个 token ⇒ OR 支、取前 30 个）：
    //   这就是「不得复用」的可观测后果。
    const reused = buildMatchQuery(text);
    expect(reused.matchSql).toContain(' OR ');
    expect(countConditions(reused.matchSql)).not.toBe(countConditions(dedupSql));
  });
});
