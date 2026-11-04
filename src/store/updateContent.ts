/**
 * 正文修正 —— `updateContent(id, newContent, now?, embedding?)`，DESIGN-v2.md §4.9.1，
 * 对应 DEVELOPMENT-PLAN.md **P4-T03**。
 *
 * ★ **它同时解决两件事**（§4.9.1）：
 *   ① **人工纠错** —— 抽提本身错了（把「她不喜欢猫粮」记成「她喜欢猫粮」），
 *      不需要相似度检测，需要「**照我说的改**」；
 *   ② **只改正文、不加固** —— `write()` 命中合并会按 `DEDUP_BOOST` 抬 `stability`，
 *      而「修正一处记错的字」**不该让这条记忆变得更牢固**。
 *
 * ⚠️ **必须过 `normalize()` 再算 hash**（§4.9 步骤 2 的同一套）：
 *   `updateContent` 与 `write` 对同一段文本必须算出**同一个** `content_hash`
 *   ⇒ 否则 `idx_mem_hash` 的唯一性约束与幂等判断**同时失效**
 *   （表现是：同一条正文能存成两条，而两边都「看起来正确」）。
 *
 * ⚠️ **不传向量时置 `NULL` 是正确降级，不是丢数据**（§4.9.1 步骤 4）：
 *   旧向量描述的正文**已经不存在了**，留着它才是错 ——
 *   那会造出一条「语义指向已消失内容」的记录，召回结果与正文对不上**且不报任何错**。
 *   ⇒ 置 NULL 的同时必须 `unassignBucket`（桶里留一条没有向量的行 ⇒ 桶计数偏大）。
 *
 * ⚠️ **`stability` / `last_access` / `access_count` 一个都不动**：
 *   修正的是「记的内容」，不是「记得多牢」。若确实要顺带加固，调用方显式调 `touch()`。
 *
 * ⚠️ **幂等返回时不校验也不更新 embedding**：正文没变 ⇒ 向量就不需要变
 *   ⇒ 此时覆盖向量等于让调用方误以为「传了向量就等于改了正文」。
 *
 * ★★ **改向量 ⇒ 必须让该行的码行失效**（C′ 档 T04 收尾）：
 *   两段式剪枝（`src/vector/prune.ts`）的**全部正确性**建立在
 *   「码行是按 `memories.embedding` 的**当前值**编的」上（`eps` 是**这一条向量**的误差）。
 *   而本函数会把向量**就地换成另一个值**（`旧值 → 新值`）⇒ 码、`fine_id`、`eps`
 *   全都还是**旧向量**的 ⇒ `upper = q·x̂ + eps` **不再是上界**。
 *
 *   两种命运（**只有第二种是事故**）：
 *   · 新向量落到**别的细桶** ⇒ 码行的 `fine_id` 是旧的 ⇒ `readCodes(fine_id IN …)` 取不到它
 *     ⇒ 该行变成「无码」⇒ 精确兜底 ⇒ **安全**（且 A6 的 `fineIdDrift` 会红，可观测）；
 *   · ★ 新向量落到**同一个细桶** ⇒ 码行仍被取到、`fine_id` 也对得上
 *     ⇒ `upper` 不再是上界 ⇒ **静默漏召回**，而 A6 与 `codesMissing` **都查不出来**
 *     （前者只看归属对不对得上，后者只数「没有码」的行）。
 *     细桶数只有 4~9966 量级 ⇒ 「改完还在同一个桶」是**常见**结果，不是边角。
 *
 *   ⇒ **T05 起的处置：重编码，且只有一份实现**。
 *     本函数**只调** `assignBucket()`（有向量）/ `unassignBucket()`（置 NULL）——
 *     这两个函数现在会在**同一个事务**里把码行也换掉（`src/vector/bucketAssign.ts`
 *     的 `writeCodeRow()` / `clearCodeRows()`）。
 *     ⇒ 「码怎么维持」只有**一份**实现，且它在**唯一收敛点**上（6 处生产调用点全走它：
 *       `write.ts:775/:930`、`merge.ts:343/:345`、本文件、`rebuild.ts:228/:245`、`reconcile.ts:251/:255`）。
 *
 *   ⚠️ **为什么不在本文件里编码/删码**：码表属于向量层，**表名只在向量层出现**
 *     （§4.6 步骤 2c；`tests/contracts/table-name-boundary.test.ts` 静态守着）。
 *     本文件只决定「**什么时候**要维护」，不管「**怎么**维护」。
 *
 *   ⚠️ **T04 收尾时的临时方案（先删码让码过期）已撤销**：
 *     那时 `assignBucket()` 还不碰码，删码只能把「静默漏召回」降级成「多读 3KB」——
 *     **安全但不是最优**（该行要等下一次 `pnpm codes:backfill` 才重新用上剪枝）。
 *     T05 之后没有必要再留这个中间态。
 *
 *   ⚠️ **必须与 `assignBucket` 在同一个事务里**（`runWriteTransaction`）：
 *     事务外做 ⇒ 崩在中间时「向量已换、码还是旧的」⇒ 正是上面那种**静默漏召回**的形状。
 *
 *   ⚠️ **`vector === null` 的分支**：`unassignBucket()` 现在**同一事务里也删码行**
 *     （码与成员「同生同死」）⇒ 不会再有 T04 收尾时那种「孤儿码行」。
 */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import type { ManualFixEventPayload } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import { normalize, tokenize } from '../core/tokenize.js';
import { type BucketAssignContext, assignBucket, unassignBucket } from '../vector/bucketAssign.js';
import { vectorToBlob } from '../vector/centroids.js';
import { normalizeNumbers } from '../vector/dot.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

/** `updateContent` 需要的上下文（比其它写方法多一个桶归属上下文）。 */
export interface UpdateContentStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（`EMBED_DIM` 校验要用）。 */
  params: Params;
  /** 事件写入器。 */
  events: EventWriter;
  /** 桶归属上下文（正文换了向量必须同步换桶，§9.3.2 ④）。 */
  buckets: BucketAssignContext;
}

/** 归一化正文的 sha1 —— **与 `write()` 同一口径**（`write.ts` 的 `sha1(normalize(content))`）。 */
function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 读目标记忆（**软删的不接受修正**）。 */
const SELECT_TARGET_SQL = `SELECT id, content, content_hash AS contentHash, content_tokens AS contentTokens
   FROM memories WHERE id = @id AND deleted = 0`;

/** 查「新正文是否已被另一条未删记忆占用」。 */
const SELECT_HASH_OWNER_SQL = `SELECT id FROM memories
   WHERE content_hash = @hash AND deleted = 0 AND id <> @id`;

/** 归档旧正文（`reason='manual_fix'`）。 */
const INSERT_HISTORY_SQL = `INSERT INTO content_history (memory_id, content, content_tokens, reason, replaced_at)
   VALUES (@id, @content, @tokens, 'manual_fix', @at)`;

/** 写回新正文（`content_tokens` 变化会触发 `mem_au` 同步 FTS）。 */
const UPDATE_CONTENT_SQL = `UPDATE memories
   SET content = @content,
       content_tokens = @tokens,
       content_hash = @hash,
       embedding = @embedding
 WHERE id = @id`;

// ★ **码行/桶归属的维护调用点在本文件末尾**（步骤 4 续），实现不在本文件：
//   调 `assignBucket()` / `unassignBucket()`（`src/vector/bucketAssign.ts`，**唯一收敛点**）。
//   ⚠️ 本文件**不写码表的 SQL、也不出现码表名**（§4.6 步骤 2c：表名只在向量层）——
//     这里只决定「**什么时候**要维护」（向量真的换了、且新向量已落库），
//     「**怎么**维护」归向量层（`tests/contracts/table-name-boundary.test.ts` 静态守着）。
//   ⚠️ 必须与那一次调用同一个事务：`assignBucket()` / `unassignBucket()` 自己会断言
//     「在事务里」，事务外调会**抛错**而不是静默漏写。
//   ⚠️ 刻意**不导出**任何东西：「什么时候维护」不该成为调用方可选的第二个开关。

function assertWritable(store: UpdateContentStore): void {
  if (store.events.readonly) {
    throw MemoryError.readonlyViolation(
      '只读实例上不能执行 updateContent（§7.1：真正的写操作一律抛 READONLY_VIOLATION，不短路）',
      { method: 'updateContent' },
    );
  }
}

/**
 * 校验并归一化调用方给的向量（与 `write()` 的 `resolveVector` 同一套规则）。
 *
 * @throws {MemoryError} `INVALID_INPUT`（维度不符 / NaN / 零向量）
 */
function resolveVector(store: UpdateContentStore, embedding: number[]): Float32Array {
  const dim = store.params.EMBED_DIM;
  if (!Array.isArray(embedding) || embedding.length !== dim) {
    throw MemoryError.invalidInput(
      `embedding 的维度必须是 ${dim}（§4.9.1 步骤 2：与 write 同一套校验，不截断、不补零）`,
      { reason: 'dim', expected: dim, actual: Array.isArray(embedding) ? embedding.length : null },
    );
  }
  // ⚠️ 归一化只有一份实现（向量层）⇒ 这里只调用，不自己算
  return normalizeNumbers(embedding);
}

/**
 * `updateContent(id, newContent, now?, embedding?)` —— §4.9.1 的六步流程。
 *
 * @param store 库句柄 + 参数 + 事件 + 桶归属上下文
 * @param id 记忆 id
 * @param newContent 新正文（**原文**，内部会 `normalize` 后再算 hash）
 * @param now 注入时钟（`content_history.replaced_at` 与事件时间戳，C37）
 * @param embedding 新向量（**不传 = 置 NULL**，不是「保持旧向量」）
 * @throws {MemoryError} `NOT_FOUND`／`CONFLICT`（带 `conflictingId`）／`INVALID_INPUT`／`READONLY_VIOLATION`
 */
export function updateContent(
  store: UpdateContentStore,
  id: string,
  newContent: string,
  now?: number,
  embedding?: number[],
): void {
  assertWritable(store);
  const at = resolveNow(now);
  const db = store.db;

  runWriteTransaction(db, () => {
    // ── 步骤 1：查目标（软删的不接受修正）──
    const target = db.prepare(SELECT_TARGET_SQL).get({ id }) as
      | { id: string; content: string; contentHash: string; contentTokens: string }
      | undefined;
    if (target === undefined) {
      throw MemoryError.notFound(
        `updateContent 的目标记忆不存在或已被软删（软删的记忆不接受正文修正）：${id}`,
        { id },
      );
    }

    // ── 步骤 2：归一化 + 算 hash（与 write 同一口径）──
    const newHash = sha1(normalize(newContent));

    // 2a. 幂等：正文没变 ⇒ 直接返回（**不写 content_history、不校验也不更新 embedding**）
    if (newHash === target.contentHash) {
      return;
    }

    // 2b. 新正文撞另一条未删记忆 ⇒ CONFLICT（调用方应改走 write() 或先清理重复项）
    const owner = db.prepare(SELECT_HASH_OWNER_SQL).get({ hash: newHash, id }) as
      | { id: string }
      | undefined;
    if (owner !== undefined) {
      throw MemoryError.conflict(
        `updateContent 的新正文与另一条未删记忆完全重复（${owner.id}）：应改走 write() 做去重合并，或先清理重复项`,
        { conflictingId: owner.id },
      );
    }

    // ── 向量：传了就用（校验 + 归一化），没传就置 NULL（**不留旧向量**）──
    const vector = embedding === undefined ? null : resolveVector(store, embedding);

    // ── 步骤 3：归档旧正文 ──
    db.prepare(INSERT_HISTORY_SQL).run({
      id,
      content: target.content,
      tokens: target.contentTokens,
      at,
    });

    // ── 步骤 4：写回新正文 + 同步向量（FTS 由触发器 mem_au 同步）──
    db.prepare(UPDATE_CONTENT_SQL).run({
      id,
      content: newContent,
      tokens: tokenize(newContent),
      hash: newHash,
      embedding: vector === null ? null : vectorToBlob(vector),
    });

    // ── 步骤 4 续：桶归属 + 码行同步（§9.3.2 ④：改 embedding 必须同事务改归属/码）──
    // ⚠️ ★ **T05 起这里只调一个函数**：`assignBucket()` 现在**自己会把码行一起重编码**
    //   （`src/vector/bucketAssign.ts` 的 `writeCodeRow()`）。
    //   ⇒ 本文件既不需要删码、也不需要（更不该）自己编码：
    //     「码怎么维持」只有一份实现在向量层，这里只决定**什么时候**要它。
    //   ⇒ 这也把 T04 收尾时那个临时方案（先 `clearCodeRow` 再 `assignBucket`）收敛掉了：
    //     那时 `assignBucket` 不碰码 ⇒ 只能删掉让码过期；**过期是安全的（走精确兜底）但不是最优**。
    if (vector === null) {
      // 没有向量 ⇒ 退桶；`unassignBucket()` 同一事务里也会删掉码行（码与成员同生同死）。
      unassignBucket(store.buckets, id);
    } else {
      // 有向量 ⇒ 落新归属，并按**这个新向量**重编码（桶可能没变，码必须换）。
      assignBucket(store.buckets, id, vector);
    }

    // ── 步骤 5：记事件 ──
    const payload: ManualFixEventPayload = {
      id,
      contentText: newContent,
      contentLength: newContent.length,
      contentHash: newHash,
      prevContentLength: target.content.length,
      hasEmbedding: vector !== null,
    };
    store.events.appendEvent('manual_fix', id, payload, at);

    // ── 步骤 6：**不动 stability / last_access / access_count**（刻意的）──
  });
}
