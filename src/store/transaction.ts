/**
 * 写路径的事务包装 —— 全库 store 层的**统一**事务入口。
 *
 * ⚠️ **为什么单独抽一个文件**：§4.5（link）、§4.2（touch）、§4.9.2（mergeEntities）
 *   三处都要求「**多步写入必须同事务**」：
 *   · `link`：建实体与写边同事务 ⇒ 自环抛错能回滚已建实体；
 *   · `touch`：加固 + 强化边 + 记事件同事务 ⇒ 校验失败时「一条都不加固」；
 *   · `mergeEntities`：迁移记忆关联 / 迁移边 / 降级别名 / 删源实体同事务。
 *   ⇒ 这三处若各写各的 `try { db.transaction(...) } catch { ... }`，
 *     转译规则（**已经是 `MemoryError` 的原样抛出**）就会漂移出三份。
 *
 * ⚠️ **转译规则（§11.2）**：
 *   · 已经是 `MemoryError` 的 ⇒ **原样抛出**。转译器只看 SQLite 错误码，
 *     把一个 `NOT_FOUND` 再转一次会变成 `CONFLICT` 或 `INVALID_INPUT` ⇒ 语义被覆盖，
 *     调用方会走向错误的处置（重试 / 改参数 / 查重）。
 *   · 不是的 ⇒ 交给 `translateSqliteError`：唯一性冲突 ⇒ `CONFLICT`、
 *     外键违规 ⇒ `NOT_FOUND`、忙 ⇒ `DATABASE_BUSY`；
 *     **清单之外的错误码原样抛出**（§11.2：把未知错误硬塞进某个 code
 *     只会让调用方拿到一个**语义错误**的 code，比未类型化的错误更难排查）。
 *
 * ⚠️ **`db.transaction(body)()` 的回滚语义**：回调抛错 ⇒ 整个事务回滚。
 *   这是「一条都不加固」「自环不留孤儿实体」这些不变量的落点。
 */

import type Database from 'better-sqlite3';

import { MemoryError, translateSqliteError } from '../core/errors.js';

/**
 * 在一个事务里执行一段写操作；把 SQLite 原生错误转译成 §11.2 的语义错误。
 *
 * ⚠️ **回调必须是同步的**（better-sqlite3 的事务不支持 async 回调：
 *   Promise 一返回事务就提交了 ⇒ 后续的 await 全部落在事务之外 ⇒ 回滚失效）。
 *
 * @param db 数据库句柄
 * @param body 事务体（抛错 ⇒ 整体回滚）
 * @returns `body` 的返回值
 * @throws {MemoryError} 语义错误原样抛出；SQLite 原生错误按 §11.2 转译
 */
export function runWriteTransaction<T>(db: Database.Database, body: () => T): T {
  try {
    return db.transaction(body)();
  } catch (error) {
    if (error instanceof MemoryError) {
      throw error;
    }
    // ⚠️ **转译只有一份实现**：`src/core/errors.ts` 的 `translateSqliteError`。
    //   本文件**刻意不自带映射表**（§14.3 边界原则 1：每个承诺指到唯一代码路径）——
    //   两份映射表必然漂移，而这正是本库反复修的那类缺陷（ADR-P1-C 冲突 5）。
    // ⚠️ **带上库路径**：`db.name` 是 better-sqlite3 暴露的库文件名
    //   ⇒ 只读错误（§7.1）的 `details.path` 能指出「**是哪个**库只读」，
    //   而不是只给一句 “attempt to write a readonly database”。
    throw translateSqliteError(error, { path: db.name });
  }
}
