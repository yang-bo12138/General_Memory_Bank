/**
 * 时钟注入契约的单测 —— DESIGN-v2.md §11.1（C37）。
 *
 * 覆盖的验收硬断言（DEVELOPMENT-PLAN.md P0-T05）：
 * · 五个错误码都存在，`details` 结构符合 §11.2
 * · §11.1 豁免清单里的 6 个方法**确实不含** `now?`，且在代码里有注释写明理由
 * · `scripts/check-clock.ts` 在 CI 里运行，**分母写死**；
 *   故意在某个方法里加一行 `Date.now()` ⇒ CI 必须失败
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_CLOCK_READ_FILES,
  EXPECTED_CLOCK_READ_FILES,
  EXPECTED_CLOCK_READ_SITES,
  evaluateExpectations,
  evaluateWhitelistLength,
  scanClockReads,
  stripComments,
} from '../../scripts/check-clock.js';
import {
  CLOCK_EXEMPT_METHODS,
  CLOCK_INJECTION_METHODS,
  resolveNow,
  resolveNowStrictly,
} from '../../src/core/clock.js';
import {
  ERROR_SEMANTICS,
  METHODS_RETURNING_NULL,
  METHODS_THROWING_CONFLICT,
  METHODS_THROWING_NOT_FOUND,
  METHODS_THROWING_READONLY_VIOLATION,
  MemoryError,
  MemoryErrorCode,
  WARNING_ONLY_CASES,
  translateSqliteError,
} from '../../src/core/errors.js';

describe('P0-T05 · §11.1 的时钟注入表', () => {
  it('接收 now? 的方法恰好是 §11.1 的 11 个', () => {
    expect(Object.keys(CLOCK_INJECTION_METHODS).sort()).toEqual([
      'clusters',
      'forget',
      'get',
      'inhibitionTrace',
      'link',
      'recall',
      'stats',
      'sweep',
      'touch',
      'updateContent',
      'write',
    ]);
  });

  it('豁免清单恰好是 6 个方法，且每个都写明了理由', () => {
    const names = Object.keys(CLOCK_EXEMPT_METHODS).sort();
    expect(names).toEqual(['mergeEntities', 'pin', 'restore', 'setAlias', 'setParams', 'unpin']);
    expect(names).toHaveLength(6);
    for (const [name, reason] of Object.entries(CLOCK_EXEMPT_METHODS)) {
      expect(reason.length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('两个集合**不相交**（一个方法不能既注入又豁免）', () => {
    const injected = new Set(Object.keys(CLOCK_INJECTION_METHODS));
    for (const exempt of Object.keys(CLOCK_EXEMPT_METHODS)) {
      expect(injected.has(exempt)).toBe(false);
    }
  });

  it('resolveNow：注入优先，缺省用真实时钟', () => {
    expect(resolveNow(123)).toBe(123);
    expect(resolveNow(undefined)).toBeGreaterThan(0);
  });

  it('resolveNowStrictly：显式传 0 是合法值，不能被当成「没传」', () => {
    expect(resolveNowStrictly(0, 999)).toBe(0);
    expect(resolveNowStrictly(undefined, 999)).toBe(999);
  });
});

describe('P0-T05 · §11.2 的错误类型体系', () => {
  it('五个错误码都存在', () => {
    expect(Object.values(MemoryErrorCode).sort()).toEqual([
      'CONFLICT',
      'DATABASE_BUSY',
      'INVALID_INPUT',
      'NOT_FOUND',
      'READONLY_VIOLATION',
    ]);
  });

  it('写接口抛 NOT_FOUND、读接口返回 null（边界一眼看完）', () => {
    expect(METHODS_THROWING_NOT_FOUND).toContain('forget');
    expect(METHODS_THROWING_NOT_FOUND).toContain('touch');
    expect(METHODS_RETURNING_NULL).toEqual(['get']);
    // `get` 绝不在抛 NOT_FOUND 的名单里
    expect(METHODS_THROWING_NOT_FOUND).not.toContain('get');
  });

  it('CONFLICT 的方法带 details.conflictingId（编译期由 ConflictDetails 保证）', () => {
    expect(METHODS_THROWING_CONFLICT).toEqual(['restore', 'updateContent', 'setAlias']);
    const error = MemoryError.conflict('撞了', { conflictingId: 'm2' });
    expect(error.code).toBe('CONFLICT');
    expect(error.details.conflictingId).toBe('m2');
  });

  it('只读实例上抛 READONLY_VIOLATION 的方法恰好 16 个', () => {
    expect(METHODS_THROWING_READONLY_VIOLATION).toHaveLength(16);
  });

  it('ALIAS_CONFLICT 刻意不是异常，而是走 warnings', () => {
    expect(WARNING_ONLY_CASES).toEqual(['ALIAS_CONFLICT']);
  });

  it('ERROR_SEMANTICS 与两张名单一致', () => {
    const throwers = ERROR_SEMANTICS.filter((s) => s.missing === 'throw_not_found').map(
      (s) => s.method,
    );
    const nullers = ERROR_SEMANTICS.filter((s) => s.missing === 'return_null').map((s) => s.method);
    expect(throwers.sort()).toEqual([...METHODS_THROWING_NOT_FOUND].sort());
    expect(nullers).toEqual([...METHODS_RETURNING_NULL]);
  });

  it('裸的 SQLite 错误码不得抛给调用方：UNIQUE ⇒ CONFLICT', () => {
    const sqliteError = Object.assign(new Error('UNIQUE constraint failed'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    const translated = translateSqliteError(sqliteError, { conflictingId: 'm9' });
    expect(translated).toBeInstanceOf(MemoryError);
    expect(translated.code).toBe('CONFLICT');
    expect(translated.details.conflictingId).toBe('m9');
  });

  it('SQLITE_BUSY ⇒ DATABASE_BUSY', () => {
    const sqliteError = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(translateSqliteError(sqliteError).code).toBe('DATABASE_BUSY');
  });

  it('SQLITE_CONSTRAINT_FOREIGNKEY ⇒ NOT_FOUND（FK 违规 = 被引用的行不存在；复用，不扩码）', () => {
    const sqliteError = Object.assign(new Error('FOREIGN KEY constraint failed'), {
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
    const translated = translateSqliteError(sqliteError, { missingIds: ['e9'] });
    expect(translated).toBeInstanceOf(MemoryError);
    expect(translated.code).toBe('NOT_FOUND');
    expect(translated.details.missingIds).toEqual(['e9']);
  });

  it('★ 真实 SQLite：FK 违规确实报 SQLITE_CONSTRAINT_FOREIGNKEY ⇒ 分支可达（不是死代码）', () => {
    const db = new Database(':memory:');
    try {
      // ⚠️ 外键是**每连接**开关，且默认关闭 ⇒ 必须显式打开（§3 的建库脚本同理）
      db.pragma('foreign_keys = ON');
      db.exec(
        'CREATE TABLE parent (id TEXT PRIMARY KEY);' +
          'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));',
      );

      let caught: unknown;
      try {
        db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'no-such-parent');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');

      // 真实错误 ⇒ 规范化出口 ⇒ NOT_FOUND（复用，不扩码）
      const translated = translateSqliteError(caught);
      expect(translated.code).toBe('NOT_FOUND');
    } finally {
      db.close();
    }
  });

  it('未在 §11.2 五个 code 之内的错误原样抛出（不擅自扩 code）', () => {
    const other = Object.assign(new Error('boom'), { code: 'SQLITE_SOMETHING_ELSE' });
    expect(() => translateSqliteError(other)).toThrow(other);
  });
});

describe('P0-T05 · C37 静态扫描', () => {
  it('剥注释：注释里的 Date.now() 不算时钟读取', () => {
    const source = ['/** 文档里提到 Date.now() */', 'const a = 1;'].join('\n');
    expect(stripComments(source)).not.toContain('Date.now()');
  });

  it('剥注释：正则字面量里的引号不会让剥离器卡住', () => {
    const source = ['const re = /[="]/;', '/** 之后的注释 Date.now() */', 'const b = 2;'].join(
      '\n',
    );
    const stripped = stripComments(source);
    expect(stripped).not.toContain('Date.now()');
    expect(stripped).toContain('/[="]/');
  });

  it('真实实现目录：零违规，且命中数与写死的期望值一致', () => {
    const result = scanClockReads('src');
    expect(result.violations).toEqual([]);
    expect(result.files).toEqual([...ALLOWED_CLOCK_READ_FILES]);
    expect(evaluateExpectations(result)).toEqual([]);
  });

  it('★ 分母写死：实际命中数与期望不符 ⇒ 失败', () => {
    const result = scanClockReads('src');
    // 伪造一个「命中数对不上」的结果 ⇒ 必须报出来
    const tampered = { ...result, sites: result.sites.slice(0, 0) };
    const failures = evaluateExpectations(tampered);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join(' ')).toContain('分母写死');
    expect(EXPECTED_CLOCK_READ_FILES).toBe(ALLOWED_CLOCK_READ_FILES.length);
    expect(EXPECTED_CLOCK_READ_SITES).toBeGreaterThan(0);
  });

  it('★ 分母是字面量：白名单长度与写死的期望文件数不一致 ⇒ 失败', () => {
    // ⚠️ 这一条防的是「有人往白名单里加文件却没同步改期望值」——
    //   若期望值由白名单长度派生，这条永远不可能失败（假绿）。
    expect(evaluateWhitelistLength(ALLOWED_CLOCK_READ_FILES, EXPECTED_CLOCK_READ_FILES)).toEqual(
      [],
    );
    expect(EXPECTED_CLOCK_READ_FILES).toBe(1);
    expect(ALLOWED_CLOCK_READ_FILES).toHaveLength(EXPECTED_CLOCK_READ_FILES);

    // ★ 反例：白名单多了一个文件而期望值没同步改 ⇒ 必须报出来
    const drifted = evaluateWhitelistLength(
      [...ALLOWED_CLOCK_READ_FILES, 'src/core/params.ts'],
      EXPECTED_CLOCK_READ_FILES,
    );
    expect(drifted.length).toBeGreaterThan(0);
    expect(drifted.join(' ')).toContain('白名单长度');
  });

  it('★ 故意加一行 Date.now() ⇒ 扫描器必须报违规', () => {
    const result = scanClockReads('tests/fixtures/clock-scan');
    const badViolations = result.violations.filter((v) => v.file.includes('bad-method.ts'));
    expect(badViolations).toHaveLength(1);
    expect(badViolations[0]?.enclosing).toBe('badMethod');
    expect(badViolations[0]?.reason).toContain('now?');
  });

  it('签名含 now? 的方法放行', () => {
    const result = scanClockReads('tests/fixtures/clock-scan');
    expect(result.violations.filter((v) => v.file.includes('good-method.ts'))).toEqual([]);
  });

  it('§11.1 豁免清单里的方法 + 写明理由的注释 ⇒ 放行', () => {
    const result = scanClockReads('tests/fixtures/clock-scan');
    expect(result.violations.filter((v) => v.file.includes('exempt-method.ts'))).toEqual([]);
  });
});
