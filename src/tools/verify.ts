/**
 * 对账与自检 —— DESIGN-v2.md §8.4 硬规则 5（对账恒等式）+ §9.3.2 ③ / §9.4.4（护栏），
 * 对应 DEVELOPMENT-PLAN.md **P4-T07**（对账）与 **P4-T08**（恢复后的自检三项）。
 *
 * ★ **对账恒等式**（§8.4 硬规则 5）：
 * ```
 * Σ(全库 stability 变化) == Σ over events{有 stabilityDelta 键的事件} of payload.stabilityDelta
 * ```
 * 误差 ≤ `1e-9`。
 *
 * ⚠️ **对账路径实际是**：`touch(explicit)` + `touch(exact_repeat)` + `merge(带 stabilityDelta)`。
 *   §4.8.1 4e 的 `restore_merge` 路径**刻意省略**了 `intervalDays` / `boostApplied`
 *   ⇒ 它也不会有 `stabilityDelta` ⇒ **对账代码不需要特判任何事件类型**
 *   （但必须按「**有没有这个键**」来筛，不能按事件类型白名单）。
 *
 * ⚠️ **「没有键」≠「delta = 0」**：
 *   把缺键的事件当成 0 计入，恒等式左边的分母不变、右边多了一堆 0 ——
 *   看起来还成立，但一旦某条缺键事件其实是加固路径写的（写漏了键），
 *   这条恒等式就再也发现不了它。⇒ **筛条件是「键存在」，不是「值是数字」**。
 */

import type Database from 'better-sqlite3';

import type { Params } from '../core/params.js';
import {
  type ArchivalSelfCheck,
  checkArchivalSchedule,
  isArchivalReady,
} from '../store/archival.js';
import { type ReplayEvent, readEvents } from './replay.js';

/** 对账结论（**带量级**，不是布尔：差了多少才是排障线索）。 */
export interface StabilityBalance {
  /** Σ 事件流里的 `stabilityDelta`。 */
  eventDeltaSum: number;
  /** Σ 库里「当前 stability − 初始 stability」的差（**只算能对上账的记忆**）。 */
  dbDeltaSum: number;
  /** `dbDeltaSum − eventDeltaSum`（期望 `|差| ≤ 1e-9`）。 */
  difference: number;
  /** 带 `stabilityDelta` 键的事件条数。 */
  eventsWithDelta: number;
  /** 没有 `write` 事件（拿不到初始稳定度）⇒ **不参与对账**的记忆数。 */
  unverifiableMemories: number;
}

/** 逐条记忆的对账明细（排障用）。 */
export interface StabilityMismatch {
  id: string;
  /** `write` 事件里的初始稳定度。 */
  initialStability: number;
  /** 事件流里的增量之和。 */
  eventDeltaSum: number;
  /** 库里当前的 `stability`。 */
  actualStability: number;
  difference: number;
}

/**
 * 对账：事件流 vs 库内 `stability`。
 *
 * @param db 库句柄
 * @param events 可注入的事件流（缺省从库里读）——**注入是为了让单测能构造旧格式事件**
 * @returns 汇总对账 + 超差明细
 */
export function checkStabilityBalance(
  db: Database.Database,
  events?: readonly ReplayEvent[],
): { balance: StabilityBalance; mismatches: StabilityMismatch[] } {
  const stream = events ?? readEvents(db);

  const initialById = new Map<string, number>();
  const deltaById = new Map<string, number>();
  let eventDeltaSum = 0;
  let eventsWithDelta = 0;

  for (const event of stream) {
    if (event.type === 'write' && event.memoryId !== null) {
      const initial = event.payload.initialStability;
      if (typeof initial === 'number') initialById.set(event.memoryId, initial);
    }
    // ⚠️ **按「键存在」筛**（不是按事件类型，也不是按「值是数字」）
    if (Object.prototype.hasOwnProperty.call(event.payload, 'stabilityDelta')) {
      const delta = event.payload.stabilityDelta;
      if (typeof delta === 'number' && Number.isFinite(delta)) {
        eventsWithDelta += 1;
        eventDeltaSum += delta;
        if (event.memoryId !== null) {
          deltaById.set(event.memoryId, (deltaById.get(event.memoryId) ?? 0) + delta);
        }
      }
    }
  }

  const rows = db.prepare('SELECT id, stability FROM memories WHERE deleted = 0').all() as Array<{
    id: string;
    stability: number;
  }>;

  let dbDeltaSum = 0;
  let unverifiable = 0;
  const mismatches: StabilityMismatch[] = [];
  for (const row of rows) {
    const initial = initialById.get(row.id);
    if (initial === undefined) {
      // 没有 `write` 事件（迁移来的 / 事件流被截断）⇒ 无从对账，**如实计数**而不是按 0 处理
      unverifiable += 1;
      continue;
    }
    const expectedDelta = deltaById.get(row.id) ?? 0;
    dbDeltaSum += row.stability - initial;
    const difference = row.stability - initial - expectedDelta;
    if (Math.abs(difference) > 1e-9) {
      mismatches.push({
        id: row.id,
        initialStability: initial,
        eventDeltaSum: expectedDelta,
        actualStability: row.stability,
        difference,
      });
    }
  }

  return {
    balance: {
      eventDeltaSum,
      dbDeltaSum,
      difference: dbDeltaSum - eventDeltaSum,
      eventsWithDelta,
      unverifiableMemories: unverifiable,
    },
    mismatches,
  };
}

/** 桶归属覆盖率（§9.3.2 ③）。 */
export interface BucketCoverage {
  /** 有向量且未删的记忆数。 */
  embeddedMemories: number;
  /** 已入桶的记忆数。 */
  bucketMembers: number;
  /** `bucketMembers / embeddedMemories`（无向量时记 1 ⇒ 「没有欠账」）。 */
  ratio: number;
}

/** 完整性自检的完整结论（**恢复 runbook 的第 4 步就调它**）。 */
export interface IntegrityReport {
  /** `PRAGMA integrity_check` 是否 `ok`。 */
  integrityOk: boolean;
  /** `PRAGMA foreign_key_check` 的违规条数（期望 0）。 */
  foreignKeyViolations: number;
  /** 桶归属覆盖率。 */
  bucketCoverage: BucketCoverage;
  /** 归档缓存自检三项（与 `stats()` **共用实现**）。 */
  archival: ArchivalSelfCheck;
  /** 稳定性对账汇总。 */
  stability: StabilityBalance;
  /** 整体是否通过（**不含对账的 unverifiable**：那是数据缺失，不是不一致）。 */
  ok: boolean;
}

/**
 * 完整性自检 —— 恢复后的第 4 步（§11.3.1）。
 *
 * ⚠️ **不重建任何东西**：它只回答「现在这个库一致吗」。
 *   可重建性（`rebuildVectorBuckets()` / `rebuildArchivalSchedule()`）是调用方的动作。
 *
 * @param db 库句柄
 * @param params 生效参数（归档自检要用 `ARCHIVE_LINE`）
 */
export function verifyIntegrity(db: Database.Database, params: Params): IntegrityReport {
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const integrityOk = integrity.length === 1 && integrity[0]?.integrity_check === 'ok';
  const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length;

  const embeddedMemories = (
    db
      .prepare('SELECT count(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL')
      .get() as { n: number }
  ).n;
  const bucketMembers = (
    db.prepare('SELECT count(*) AS n FROM vector_cell_members').get() as { n: number }
  ).n;

  const archival = checkArchivalSchedule(db, params);
  const archivalReady = isArchivalReady(db);
  const { balance } = checkStabilityBalance(db);

  const bucketCoverage: BucketCoverage = {
    embeddedMemories,
    bucketMembers,
    ratio: embeddedMemories === 0 ? 1 : bucketMembers / embeddedMemories,
  };

  return {
    integrityOk,
    foreignKeyViolations,
    bucketCoverage,
    archival,
    stability: balance,
    // ⚠️ **`missing` 只在缓存自称就绪时才算问题**：
    //   新建库 / 参数变更后 `ready = 0` ⇒ 缓存本来就允许是空的（走逐行精筛，结果仍正确）
    //   ⇒ 把它判成「不完整」会让**每个新库**都自检失败，护栏立刻变成噪音。
    ok:
      integrityOk &&
      foreignKeyViolations === 0 &&
      Math.abs(bucketCoverage.ratio - 1) <= 1e-9 &&
      archival.orphans === 0 &&
      archival.mismatch === 0 &&
      (!archivalReady || archival.missing === 0),
  };
}
