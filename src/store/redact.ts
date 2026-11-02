/**
 * 正文脱敏 —— DESIGN-v2.md §8.2 / §4.8 步骤 ②。
 *
 * ★ **本文件是全库唯一的脱敏 SQL 出处**（§14.3 边界原则 1：每个承诺都要能指到唯一代码路径）：
 *   `forget(hard)` 与 `sweep` 的清理动作都**只调用这里**的 `redactEventContentText()`，
 *   **不得各写一份**。两份脱敏 SQL 必然漂移，而漂移的表现是
 *   「用户说了忘掉，某条事件里的原文还静静躺着」——**不报错、不告警**。
 *
 * ⚠️ **三个要点，缺一即出事故**（§4.8 步骤 ② 的 a/b/c）：
 *   a. **走 `memory_id` 索引定位**（O(log n)），不用 `payload LIKE '%"id"%'` 全表扫；
 *   b. **不用 `json_extract(payload,'$.id')` 反查** —— 它对每行都要解一次 JSON，等于全表 O(n) 解析；
 *   c. **必须先 `json_valid` 兜住非法 JSON** —— `json_extract` 遇到坏 payload 会直接抛
 *      “malformed JSON”，把「遗忘」这个**必须成功**的操作整个中断。
 *      ⇒ 一条历史脏数据不该让用户「点不动忘掉」。
 *
 * ⚠️ **只改 `payload.contentText` 一个键**（§3 的 events 表注释）：
 *   `events` 是**只追加**的，唯一的例外就是本函数。
 *   ⇒ 不要「顺手」清掉 `contentHash` / `contentLength`：那两个是**判据性**的统计量
 *     （重放对账要用 `stabilityDelta`、脱敏审计要能看到「这条曾经有多长」），
 *     而 `contentText` 才是**承诺要忘掉的那份原文**。
 */

import type Database from 'better-sqlite3';

/**
 * 脱敏后的占位串（**判据量**：验收断言 `payload.contentText == REDACTION_PLACEHOLDER`）。
 *
 * ⚠️ 它是**产品语义**的一部分（用户能看出「这里被清理过」），
 *   不是一个实现细节 ⇒ 所以有名字、可被引用，而不是散落的字面量。
 */
export const REDACTION_PLACEHOLDER = '[redacted]';

/**
 * 脱敏 SQL —— ★ **全库唯一一份**（有静态扫描守卫：`tests/unit/forget.test.ts`）。
 *
 * ⚠️ **`CASE WHEN json_valid(payload)`** 放在前面是**短路**：
 *   SQLite 的 `AND` 不保证短路顺序 ⇒ 只用 `AND json_valid(...) AND json_extract(...) IS NOT NULL`
 *   仍可能先算 `json_extract` ⇒ 坏 payload 照样抛错。
 *   ⇒ 用 `CASE` 把「解析」这件事包在一个**条件分支**里，坏 JSON 走 `ELSE 0` ⇒ 该行被跳过。
 */
const REDACT_SQL = `UPDATE events
   SET payload = json_set(payload, '$.contentText', @placeholder)
 WHERE memory_id = @memoryId
   AND CASE WHEN json_valid(payload)
            THEN json_extract(payload, '$.contentText') IS NOT NULL
            ELSE 0 END`;

/**
 * 把某条记忆关联的全部事件里的正文替换成占位串。
 *
 * @param db 数据库句柄（调用方负责事务；本函数**不开事务**——它总是与「删行 / 记事件」同事务）
 * @param memoryId 记忆的 uuid（走 `idx_events_memory` 索引）
 * @returns 实际被改写的事件条数（0 表示这条记忆没有带正文的事件）
 */
export function redactEventContentText(db: Database.Database, memoryId: string): number {
  const result = db.prepare(REDACT_SQL).run({
    memoryId,
    placeholder: REDACTION_PLACEHOLDER,
  });
  return result.changes;
}
