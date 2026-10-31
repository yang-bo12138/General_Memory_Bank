/**
 * §7.1 / §11.2：只读实例上的写操作 ⇒ `READONLY_VIOLATION`。
 *
 * ⚠️ **这条断言存在的理由（实测缺口）**：
 *   `translateSqliteError` 原本只映射三类（UNIQUE→CONFLICT、FOREIGNKEY→NOT_FOUND、
 *   BUSY/LOCKED→DATABASE_BUSY），**其余原样抛出**
 *   ⇒ 在只读实例上做写操作，**裸的 SQLite 错误码会漏到调用方**
 *   ⇒ 违反 §11.2「客户端只应看到本类（一个规范化的错误结构）」。
 *
 * ⚠️ **用真实 SQLite 库**（临时文件 + `readonly: true` 打开）：
 *   「只读」是**连接属性**上的事实，mock 库验不了。
 *
 * ★ **断言纪律**：断言**性质**（错误码、details 的内容），不写死当次的形状；
 *   每条关键断言都配**负控**（把映射分支去掉 ⇒ 这条必须变红 —— 见交付报告的实测记录）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryError, translateSqliteError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { createSchema } from '../../src/db/connection.js';
import { EventWriter } from '../../src/store/events.js';
import { touch } from '../../src/store/touch.js';
import { write } from '../../src/store/write.js';
import { MemoryLogger } from '../../src/util/log.js';
import type { BucketAssignContext } from '../../src/vector/bucketAssign.js';
import { createUntrainedBucketContext } from '../fixtures/bucket-store.js';
import { insertMemory } from '../fixtures/graph-store.js';

/** 临时目录（每次用例一个，跑完清掉 ⇒ 不污染仓库）。 */
let workDir = '';
/** 库文件路径。 */
let dbPath = '';
/** 本次用例打开的句柄（Windows 上文件被打开时删不掉 ⇒ 必须先关）。 */
const opened: Database.Database[] = [];

/** 造一个可写的库，塞一条记忆，然后关掉（只读句柄需要真实文件）。 */
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'memory-ocean-readonly-'));
  dbPath = join(workDir, 'readonly.db');
  const rw = new Database(dbPath);
  createSchema(rw);
  insertMemory(rw, 'm-1');
  rw.close();
});

afterEach(() => {
  // ⚠️ **必须先关句柄再删目录**（Windows 上打开的文件删不掉 ⇒ EBUSY）。
  for (const db of opened) {
    db.close();
  }
  opened.length = 0;
  rmSync(workDir, { recursive: true, force: true });
});

/** 打开只读句柄。 */
function openReadonly(): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  opened.push(db);
  return db;
}

/**
 * 造一个 store 上下文。
 *
 * ⚠️ **事件写入器刻意不给 `readonly: true`**：
 *   那会让 `appendEvent` 走「只读短路」分支 ⇒ 失败来自事件写入器而不是 SQLite，
 *   ⇒ 测的就不是「SQLite 的只读错误码有没有被规范化」了。
 */
function storeOf(db: Database.Database): {
  db: Database.Database;
  params: typeof DEFAULT_PARAMS;
  events: EventWriter;
  logger: MemoryLogger;
  buckets: BucketAssignContext;
} {
  return {
    db,
    params: DEFAULT_PARAMS,
    events: new EventWriter(db, { readonly: false, logger: new MemoryLogger(), now: () => 0 }),
    // ⚠️ `write()` 的 `WriteStore` 还要一个日志器（§8.1：别名冲突要同时记一条磁盘日志）。
    logger: new MemoryLogger(),
    // ⚠️ `buckets` 是桶归属上下文（§9.3.0 的唯一写入点）：只读实例上根本写不进去
    //   ⇒ 给「尚未训练」的即可（断言的是 READONLY_VOLATION，不是桶归属）。
    buckets: createUntrainedBucketContext(db),
  };
}

/** 捕获一次调用抛出的错误（失败时给出可读的原因）。 */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误，但没有抛');
}

describe('§7.1 · 只读实例上的写操作 ⇒ READONLY_VIOLATION', () => {
  it('★ touch 在只读实例上 ⇒ MemoryError(READONLY_VIOLATION)，不是裸 SQLite 错误码', () => {
    const db = openReadonly();
    const error = catchError(() => touch(storeOf(db), ['m-1']));

    // 性质：抛的是**库的错误类型**（客户端只应看到本类）
    expect(error).toBeInstanceOf(MemoryError);
    const memoryError = error as MemoryError;
    expect(memoryError.code).toBe('READONLY_VIOLATION');
    // ★ 负控：不是未类型化的 SQLite 错误码、也不是「没有 code 的裸 Error」
    expect(memoryError.code).not.toBe('SQLITE_READONLY');
    expect(memoryError.code).not.toBeUndefined();
    // 性质：details 指出**是哪个库**只读（调用方据此换实例 / 改配置）
    expect(String(memoryError.details.path)).toContain('readonly.db');
    expect(memoryError.details.sqliteCode).toBe('SQLITE_READONLY');
  });

  it('★ write 在只读实例上 ⇒ 同样是 READONLY_VIOLATION（同一个出口，不是各写各的）', () => {
    const db = openReadonly();
    const error = catchError(() => write(storeOf(db), { content: '一条新记忆' }));

    expect(error).toBeInstanceOf(MemoryError);
    const memoryError = error as MemoryError;
    expect(memoryError.code).toBe('READONLY_VIOLATION');
    expect(memoryError.code).not.toBe('SQLITE_READONLY');
    expect(String(memoryError.details.path)).toContain('readonly.db');
  });

  it('★ 五个只读码全部归一到同一个 code（SQLite 把「只读」拆成了五个结果码）', () => {
    const codes = [
      'SQLITE_READONLY',
      'SQLITE_READONLY_DBMOVED',
      'SQLITE_READONLY_DIRECTORY',
      'SQLITE_READONLY_RECOVERY',
      'SQLITE_READONLY_CANTINIT',
    ];
    for (const code of codes) {
      // ⚠️ `translateSqliteError` 是**返回**规范化错误（只有清单外的码才抛）
      const translated = translateSqliteError({ code });
      expect(translated).toBeInstanceOf(MemoryError);
      expect(translated.code).toBe('READONLY_VIOLATION');
    }
    // ⚠️ 负控：清单外的码**不得**被误判成只读（它有自己的出口）
    expect(translateSqliteError({ code: 'SQLITE_BUSY' }).code).toBe('DATABASE_BUSY');
    expect(translateSqliteError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }).code).toBe('NOT_FOUND');
  });

  it('★ 清单外的错误码仍然**原样抛出**（不硬塞进某个 code：语义错误的 code 比未类型化更难排查）', () => {
    const raw = { code: 'SQLITE_CANTOPEN' };
    const error = catchError(() => translateSqliteError(raw));
    // 原样抛出的不是 MemoryError ⇒ 调用方能看见原始细节
    expect(error).not.toBeInstanceOf(MemoryError);
    expect(error).toBe(raw);
  });

  it('★ 事务包装器**不自带**第二份 SQLite 映射表（否则两份必然漂移）', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'store', 'transaction.ts'), 'utf8');
    // 性质：store 层的事务包装里**没有**任何 SQLite 错误码字面量
    //   ⇒ 它只是**调用** core/errors.ts 的 `translateSqliteError`。
    expect(source).not.toMatch(/SQLITE_[A-Z_]+/);
    expect(source).toContain('translateSqliteError');
    // ⚠️ 负控：若有人在事务包装里自己加了一张映射表 ⇒ 上面那行会红
    //   （而「两份映射表」正是本库反复修的那类缺陷）。
  });
});
