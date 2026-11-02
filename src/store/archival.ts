/**
 * 归档缓存（`archival_schedule`）—— DESIGN-v2.md §9.4 / §9.4.3 / §9.4.5，
 * 对应 DEVELOPMENT-PLAN.md **P4-T04**（第 10 条归档路径）与 **P4-T05**（`countArchived`）。
 *
 * ★ **缓存解决的问题**：`countArchived` 要回答「现在有多少条已归档」，
 *   而「归档」= `intensity <= ARCHIVE_LINE`，是**时间派生量**
 *   ⇒ 逐行算 = 全表 O(n) 次 `exp()`
 *   ⇒ 于是把「何时归档」**一次算好**（`last_access + stability × pin_factor × ln(1/线) × 86400000`），
 *     查询退化成 `archive_at <= now` 的**纯索引扫描**。
 *
 * ⚠️ **正确性从不依赖缓存是否就绪**（§9.4.5 的降级路径）：
 *   `meta.archival_schedule_ready = 0` ⇒ `countArchived()` **退回逐行精筛**（慢但正确）。
 *   这就是为什么 `setParams({ARCHIVE_LINE})` 可以「先置 0、后台重建、再置 1」——
 *   参数变更从**阻塞操作**降级为**后台修复**，且**不需要加列**。
 *
 * ⚠️ **缓存只装 `deleted = 0` 的行**（DDL 注释）：软删的行必须被清出去，
 *   否则 `countArchived` 会把「用户已忘掉的东西」算进归档数。
 *
 * ⚠️ **分页用 rowid 游标，不用 `LIMIT/OFFSET`**：OFFSET 是 O(n) 扫描，
 *   翻到第 100 页要把前 100 页重扫一遍 ⇒ 百万级上是「翻页越翻越慢」的经典坑。
 */

import type Database from 'better-sqlite3';

import { type DecayMemoryInput, archiveSpanMs, intensity } from '../core/decay.js';
import { MemoryError } from '../core/errors.js';
import type { Params } from '../core/params.js';

/** 就绪标记在 `meta` 表里的键（与 `migratePhaseB` **同一个键**）。 */
export const ARCHIVAL_READY_KEY = 'archival_schedule_ready';

/** 重建默认的批大小（与 sweep 的批大小无关：这里是**写**缓存，那里是**删**行）。 */
export const ARCHIVAL_REBUILD_BATCH = 1000;

/** 归档自检的三项（`stats()` 与 `verifyIntegrity()` **共用**，口径不得分叉）。 */
export interface ArchivalSelfCheck {
  /** 孤儿：缓存里有、但主表里没有（或已软删）。 */
  orphans: number;
  /**
   * 不一致：`archive_at` 与按当前参数重算的值差超过 1ms。
   *
   * ⚠️ 容差 1ms 是**取整**造成的（DDL 里 `archive_at` 是 INTEGER，`archiveAt()` 返回浮点）
   *   ⇒ 用 0 容差会把每条记录都判成不一致。
   */
  mismatch: number;
  /** 缺失：主表里有（未删）、缓存里没有。 */
  missing: number;
}

/** 缓存是否就绪（`meta` 里那个标记；缺省视作未就绪 ⇒ 走慢路径）。 */
export function isArchivalReady(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(ARCHIVAL_READY_KEY) as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

/** 写就绪标记（`ready` 为 false 时**不删行**：慢路径照样正确，行留着给后台重建用）。 */
export function setArchivalReady(db: Database.Database, ready: boolean): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    ARCHIVAL_READY_KEY,
    ready ? '1' : '0',
  );
}

/**
 * 全量重建归档缓存 —— **唯一实现**（`setParams({ARCHIVE_LINE})` 与 `rebuildArchivalSchedule()`
 * 与迁移回填三处共用同一套公式）。
 *
 * ⚠️ **必须是「整表替换」而不是「增量补齐」**：改归档线会让**所有** `archive_at` 变
 *   （旧值是按旧线算的）⇒ 增量补只能补新增行，旧行的值全错。
 *
 * ⚠️ **按批提交**：百万级一次写会让 `db.transaction` 持写锁很久
 *   （§9.4 的运维口径：宁可分段，也不要一次锁死）。
 *
 * @param db 库句柄
 * @param params 生效参数（`ARCHIVE_LINE` 是这条缓存的**唯一变量**）
 * @param now 注入时钟（写进日志/返回值不需要它，但公式不需要「现在」——
 *             `archive_at` 是**绝对时刻**，与 `now` 无关 ⇒ 保留参数是为了调用点签名一致）
 * @returns 重建的行数
 */
export function rebuildArchivalScheduleInternal(
  db: Database.Database,
  params: Params,
  now?: number,
): number {
  void now; // ⚠️ `archive_at` 是绝对时刻，不依赖「现在」；签名保留是为了与调用点统一。
  // ⚠️ 整表替换（不是增量补齐）：改归档线会让**每一行**的 `archive_at` 都变
  //   ⇒ 「只补新增行」的写法在这里是错的。
  db.transaction(() => {
    rebuildArchivalRowsInternal(db, params);
  })();
  const row = db.prepare('SELECT count(*) AS n FROM archival_schedule').get() as { n: number };
  return row.n;
}

/**
 * 重建的**事务内部分**（不自己开事务）—— 供 `setParams()` 在自己的事务里复用。
 *
 * ⚠️ 拆出来的理由：`setParams({ARCHIVE_LINE})` 要求「写参数 + 记事件 + 重建缓存」**同一事务**
 *   （§5 的「先全量校验 → 再单事务写入 → 同事务记事件」）
 *   ⇒ 若重建自己去 `db.transaction()`，那条路径就变成嵌套事务的语义依赖
 *   （better-sqlite3 用 savepoint 实现，能跑，但「回滚到哪一层」变得难以推理）。
 */
export function rebuildArchivalRowsInternal(db: Database.Database, params: Params): void {
  const factor = archiveSpanMs(params.ARCHIVE_LINE);
  db.prepare('DELETE FROM archival_schedule').run();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO archival_schedule (memory_id, archive_at)
     SELECT id, CAST(last_access + stability * pin_factor * ? AS INTEGER)
       FROM memories
      WHERE deleted = 0 AND rowid > ? AND rowid <= ?`,
  );
  const scan = db.prepare(
    'SELECT rowid FROM memories WHERE deleted = 0 AND rowid > ? ORDER BY rowid LIMIT ?',
  );
  let cursor = 0;
  for (;;) {
    const rows = scan.all(cursor, ARCHIVAL_REBUILD_BATCH) as Array<{ rowid: number }>;
    if (rows.length === 0) break;
    const batchEnd = rows[rows.length - 1]?.rowid ?? cursor;
    insert.run(factor, cursor, batchEnd);
    cursor = batchEnd;
  }
  setArchivalReady(db, true);
}

/**
 * 逐行精筛（**参考实现**，慢但永远正确）—— §9.4.5 的降级路径。
 *
 * ⚠️ **它也是「缓存对不对」的判据**：`countArchived()` 的快路径结果必须与它**逐位相等**
 *   （P4-T04 的硬断言）。⇒ 两条路径不能各写一套「归档」的定义。
 */
export function countArchivedPrecise(db: Database.Database, params: Params, now: number): number {
  const scan = db.prepare(
    `SELECT rowid, stability, pin_factor, last_access FROM memories
      WHERE deleted = 0 AND rowid > ? ORDER BY rowid LIMIT ?`,
  );
  let archived = 0;
  let cursor = 0;
  for (;;) {
    const rows = scan.all(cursor, ARCHIVAL_REBUILD_BATCH) as Array<
      DecayMemoryInput & { rowid: number }
    >;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (intensity(row, now) <= params.ARCHIVE_LINE) archived += 1;
    }
    cursor = rows[rows.length - 1]?.rowid ?? cursor;
  }
  return archived;
}

/**
 * 归档计数 —— `stats().archivedCount` 与 `sweep().archivedCount` 的**唯一实现**。
 *
 * 两条路径（§9.4.5）：
 * 1. **快路径**：缓存就绪 **且** `ARCHIVAL_CACHE` 开着 ⇒ `archive_at <= now` 的索引计数；
 * 2. **慢路径**：否则逐行精筛。
 *
 * ⚠️ **结果必须一致**：调用方（`stats` / `sweep` / 自检）都依赖「同一个数」这件事。
 *
 * @param db 库句柄
 * @param params 生效参数（`ARCHIVE_LINE` + `ARCHIVAL_CACHE` 开关）
 * @param now 判定基准（C37）
 */
export function countArchived(db: Database.Database, params: Params, now: number): number {
  if (params.ARCHIVAL_CACHE && isArchivalReady(db)) {
    const row = db
      .prepare('SELECT count(*) AS n FROM archival_schedule WHERE archive_at <= ?')
      .get(now) as { n: number };
    return row.n;
  }
  return countArchivedPrecise(db, params, now);
}

/**
 * 归档缓存自检（`stats()` 与 `verifyIntegrity()` **共用**，§9.4.4 的护栏）。
 *
 * @param db 库句柄
 * @param params 生效参数
 * @returns `{ orphans, mismatch, missing }`（三个计数，**不是布尔**：护栏要可观测的量级）
 */
export function checkArchivalSchedule(db: Database.Database, params: Params): ArchivalSelfCheck {
  // 孤儿：缓存里有、主表里不存在或已软删
  const orphans = (
    db
      .prepare(
        `SELECT count(*) AS n FROM archival_schedule s
          WHERE NOT EXISTS (
            SELECT 1 FROM memories m WHERE m.id = s.memory_id AND m.deleted = 0
          )`,
      )
      .get() as { n: number }
  ).n;

  // 缺失：主表里有（未删）、缓存里没有
  const missing = (
    db
      .prepare(
        `SELECT count(*) AS n FROM memories m
          WHERE m.deleted = 0
            AND NOT EXISTS (SELECT 1 FROM archival_schedule s WHERE s.memory_id = m.id)`,
      )
      .get() as { n: number }
  ).n;

  // 不一致：按当前参数重算，与落库值差 > 1ms（取整容差）
  const rows = db
    .prepare(
      `SELECT s.archive_at AS archiveAt, m.stability, m.pin_factor, m.last_access
         FROM archival_schedule s
         JOIN memories m ON m.id = s.memory_id
        WHERE m.deleted = 0`,
    )
    .all() as Array<DecayMemoryInput & { archiveAt: number }>;
  const factor = archiveSpanMs(params.ARCHIVE_LINE);
  let mismatch = 0;
  for (const row of rows) {
    const expected = row.last_access + row.stability * row.pin_factor * factor;
    if (Math.abs(expected - row.archiveAt) > 1) mismatch += 1;
  }

  return { orphans, mismatch, missing };
}

/**
 * 只补跑「缺失的那部分」缓存行（**不去动已有行**）。
 *
 * ⚠️ 它是缺陷③（「没有只补跑迁移段的运维入口」）在归档这一侧的对应能力：
 *   全量重建的代价与库规模成正比，而「只是缺了几行」时不该重算全库。
 */
export function backfillMissingArchivalRows(db: Database.Database, params: Params): number {
  const factor = archiveSpanMs(params.ARCHIVE_LINE);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO archival_schedule (memory_id, archive_at)
       SELECT id, CAST(last_access + stability * pin_factor * ? AS INTEGER)
         FROM memories
        WHERE deleted = 0
          AND NOT EXISTS (SELECT 1 FROM archival_schedule s WHERE s.memory_id = memories.id)`,
    )
    .run(factor);
  return result.changes;
}

/**
 * 断言「归档缓存处于可用状态」（运维入口用）。
 *
 * @throws {MemoryError} `INVALID_INPUT`（自检不通过时带上三项计数，便于定位）
 */
export function assertArchivalHealthy(db: Database.Database, params: Params): void {
  const selfCheck = checkArchivalSchedule(db, params);
  if (selfCheck.orphans === 0 && selfCheck.missing === 0 && selfCheck.mismatch === 0) {
    return;
  }
  throw MemoryError.invalidInput('归档缓存自检未通过（§9.4.4 护栏）', {
    archival: selfCheck,
    reason: 'orphans / missing / mismatch 必须全为 0；先跑 rebuildArchivalSchedule() 再复查',
  });
}
