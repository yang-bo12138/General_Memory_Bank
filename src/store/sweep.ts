/**
 * 维护清扫 —— `sweep(options?, now?)`，DESIGN-v2.md §4.10 / §9.2 / §9.4，对应 **P4-T06**。
 *
 * ★ **`sweep` 是唯一「多事务」的写操作**（§9.2）：
 *   每条记忆的「删除 + 脱敏 + 记事件」是**一个独立事务**，而不是把整次 sweep 包成一个大事务。
 *   ⚠️ **两个不能混的地方**：
 *   ① 整包成大事务 ⇒ 清理 10 万条软删记录时**持写锁数分钟**；
 *   ② `VACUUM` **必须在事务外**（SQLite 硬性要求，事务内执行直接报错）。
 *   ⇒ 代价：「sweep 中途崩溃」会留下「已清理一部分」的状态 —— **可接受**：
 *     每条记录的处理本身是原子的，残留的软删记录只是留到下次 sweep，**不产生半删状态**。
 *
 * ⚠️ **任一条抛错即中止整个 sweep 并上抛**（不要 try-catch 之后继续下一批）：
 *   删不掉的行不会被 DELETE 移除 ⇒ 下一轮 SELECT 仍会选中它
 *   ⇒ 「循环直至本批为空」在这种情形下是**死循环**，而且每轮都在写事件，库会持续膨胀。
 *
 * ⚠️ **`vacuumed` 字段是「实际是否执行」而不是「入参回显」**：
 *   传了 `vacuum: true` 但 `purged = 0` 时**实际没执行**（VACUUM 会全量重写库文件并独占写锁，
 *   没有页可回收时只有代价没有收益）⇒ 回显入参会让人以为「执行过 VACUUM」。
 *
 * ⚠️ **只读实例上一律抛 `READONLY_VIOLATION`，即使不传任何参数**：
 *   按入参动态决定「这次算不算写操作」会让同一方法的行为随参数跳变，
 *   调用方无法从签名判断安全性 ⇒ 想要纯读统计请调 `stats()`。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import type { SweepItemEventPayload, SweepSummaryEventPayload } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import { effectiveAffinity } from '../neuron/cluster.js';
import { countArchived } from './archival.js';
import type { EventWriter } from './events.js';
import { redactEventContentText } from './redact.js';
import { runWriteTransaction } from './transaction.js';

/** `sweep` 需要的上下文。 */
export interface SweepStore {
  db: Database.Database;
  params: Params;
  events: EventWriter;
}

/** `sweep()` 的选项（§6）。 */
export interface SweepOptions {
  /**
   * 物理清理「软删超过多少天」的记录。
   *
   * ⚠️ `0` / 不传 ⇒ **不清任何东西**（这不是「清 0 天前的」）。
   */
  purgeDeletedDays?: number;
  /** 是否在**真的删掉了行**之后回收空间（`VACUUM` + FTS 重建）。 */
  vacuum?: boolean;
}

/** `sweep()` 的返回值（§6 / §8.4 的 sweep 事件 payload 口径一致）。 */
export interface SweepResult {
  /** 本次物理清理的软删记录数。 */
  purged: number;
  /** **当时的库状态快照**（不是「本次动作的结果」）。 */
  archivedCount: number;
  /** 本次淘汰的共激活对数（阈值淘汰 + 度数上限淘汰）。 */
  coactPairsPurged: number;
}

/** 簇快照摘要（汇总事件的四个字段；表里没有的派生量现算）。 */
interface ClusterSnapshotSummary {
  clusterCount: number;
  largestClusterRatio: number;
  largestClusterRatioBeforeSplit: number;
  blocksAfterSplit: number;
}

function assertWritable(store: SweepStore): void {
  if (store.events.readonly) {
    throw MemoryError.readonlyViolation(
      '只读实例上不能执行 sweep（§4.10：sweep 整体归入写操作范畴，「不删任何记忆行」不等于「它变成只读方法」）',
      { method: 'sweep' },
    );
  }
}

/**
 * 步骤 1：物理清理软删记录（**每条一个事务**）。
 *
 * ⚠️ **必须一并取出 `deleted_at`**：删除之后回查只会得到空行
 *   ⇒ 事件 payload 的 `deletedAt` 会变成 `null` 或直接抛错。
 * ⚠️ **只选 `deleted_at IS NOT NULL`**：脏数据（`deleted = 1` 但时间为空）**保守跳过**，
 *   否则 `cutoff` 比较对它恒假 ⇒ 每轮都被选中 ⇒ 死循环。
 */
function purgeDeleted(store: SweepStore, purgeDeletedDays: number, now: number): number {
  const db = store.db;
  const cutoff = now - purgeDeletedDays * 86_400_000;
  const batch = store.params.SWEEP_BATCH_SIZE;
  const select = db.prepare(
    `SELECT id, deleted_at AS deletedAt FROM memories
      WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < @cutoff
      LIMIT @batch`,
  );

  let purged = 0;
  for (;;) {
    const rows = select.all({ cutoff, batch }) as Array<{ id: string; deletedAt: number }>;
    if (rows.length === 0) break;

    for (const row of rows) {
      // ⚠️ **每条一个事务**（不与整次 sweep 同事务）：持锁时间 = 一条记录的时间
      runWriteTransaction(db, () => {
        db.prepare('DELETE FROM memories WHERE id = @id').run({ id: row.id });
        // ★ 与 forget(hard) 共用**全库唯一一份**脱敏 SQL
        redactEventContentText(db, row.id);
        const payload: SweepItemEventPayload = {
          id: row.id,
          reason: 'purge_deleted',
          deletedAt: row.deletedAt,
        };
        store.events.appendEvent('sweep', row.id, payload, now);
      });
      purged += 1;
    }
  }
  return purged;
}

/** 读簇快照摘要（表里没有的派生量现算；没有快照 ⇒ 全 0）。 */
function readClusterSummary(db: Database.Database): ClusterSnapshotSummary {
  const meta = db
    .prepare(
      'SELECT max_raw_ratio AS maxRawRatio, last_split_blocks AS blocks FROM cluster_snapshot_meta WHERE id = 1',
    )
    .get() as { maxRawRatio: number | null; blocks: number | null } | undefined;
  const clusterCount = (
    db.prepare('SELECT count(*) AS n FROM theme_clusters').get() as { n: number }
  ).n;
  const total = (
    db.prepare('SELECT count(*) AS n FROM memories WHERE deleted = 0').get() as { n: number }
  ).n;
  const largest = (
    db
      .prepare(
        'SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT count(*) AS n FROM theme_cluster_members GROUP BY cluster_id)',
      )
      .get() as { n: number }
  ).n;
  return {
    clusterCount,
    // ⚠️ 分母用「未删记忆数」（与 `clusters().largestClusterRatio` 同口径：块 / 未删记忆）
    largestClusterRatio: total === 0 ? 0 : largest / total,
    largestClusterRatioBeforeSplit: meta?.maxRawRatio ?? 0,
    blocksAfterSplit: meta?.blocks ?? 0,
  };
}

/**
 * 步骤 1b：共激活淘汰（阈值 + 度数上限）。
 *
 * ⚠️ **`COACT_DEGREE_MAX` 是度数爆炸的唯一闸门**：没有它，一条被反复 touch 的枢纽记忆
 *   会连出上万条边，簇跳与聚类都会被它拖垮。
 * ⚠️ **淘汰判据用 `effectiveAffinity()`**（§4.11.3 的**全库唯一一份**衰减公式）——
 *   不要在这里另写一份 `exp()`（两份公式必然漂移）。
 */
function evictCoacts(store: SweepStore, now: number): { active: number; purged: number } {
  const db = store.db;
  const params = store.params;
  const rows = db
    .prepare('SELECT memory_a AS a, memory_b AS b, affinity, last_active AS lastActive FROM coacts')
    .all() as Array<{ a: string; b: string; affinity: number; lastActive: number }>;
  const active = rows.length;

  const withEff = rows.map((row) => ({
    ...row,
    eff: effectiveAffinity(row.affinity, row.lastActive, now, params),
  }));

  let purged = 0;
  runWriteTransaction(db, () => {
    const del = db.prepare('DELETE FROM coacts WHERE memory_a = @a AND memory_b = @b');

    // ── ① 阈值淘汰：`affinity_eff < COACT_AFFINITY_MIN` ──
    const belowThreshold = new Set<string>();
    for (const row of withEff) {
      if (row.eff < params.COACT_AFFINITY_MIN) {
        del.run({ a: row.a, b: row.b });
        belowThreshold.add(`${row.a}\u0000${row.b}`);
        purged += 1;
      }
    }

    // ── ② 度数上限：超过 `COACT_DEGREE_MAX` 的节点只保留最强的前 N 条 ──
    const survivors = withEff.filter((row) => !belowThreshold.has(`${row.a}\u0000${row.b}`));
    const byNode = new Map<string, Array<{ a: string; b: string; eff: number }>>();
    for (const row of survivors) {
      for (const node of [row.a, row.b]) {
        const list = byNode.get(node) ?? [];
        list.push(row);
        byNode.set(node, list);
      }
    }
    const dropped = new Set<string>();
    for (const [, list] of byNode) {
      if (list.length <= params.COACT_DEGREE_MAX) continue;
      list.sort((left, right) => right.eff - left.eff || (left.b < right.b ? -1 : 1));
      for (const row of list.slice(params.COACT_DEGREE_MAX)) {
        const key = `${row.a}\u0000${row.b}`;
        if (dropped.has(key)) continue;
        dropped.add(key);
        del.run({ a: row.a, b: row.b });
        purged += 1;
      }
    }
  });

  return { active, purged };
}

/**
 * `sweep(options?, now?)` —— §4.10 的多动作维护。
 *
 * @param store 库句柄 + 参数 + 事件写入器
 * @param options `purgeDeletedDays` / `vacuum`
 * @param now 注入时钟（`cutoff` 与事件时间戳，C37）
 * @returns `{ purged, archivedCount, coactPairsPurged }`
 * @throws {MemoryError} `READONLY_VIOLATION`（只读实例，**即使不传任何参数**）
 */
export function sweep(store: SweepStore, options: SweepOptions = {}, now?: number): SweepResult {
  assertWritable(store);
  const at = resolveNow(now);
  const db = store.db;

  // ── 步骤 1：物理清理（仅当 `purgeDeletedDays > 0`）──
  const purgeDeletedDays = options.purgeDeletedDays ?? 0;
  const purged = purgeDeletedDays > 0 ? purgeDeleted(store, purgeDeletedDays, at) : 0;

  // ── 步骤 1b：共激活淘汰（与清理无关，每次都做）──
  const coact = evictCoacts(store, at);

  // ── 步骤 2：统计归档数（**只读，不删除**；与 `stats()` / `sweep()` 共用实现）──
  const archivedCount = countArchived(db, store.params, at);

  // ── 步骤 3：可选空间回收（`vacuum === true` **且** `purged > 0`）──
  let vacuumed = false;
  if (options.vacuum === true && purged > 0) {
    // ① FTS 重建：**单独一个事务**（它是写操作，中途失败会让索引停在与主表不一致的状态）
    runWriteTransaction(db, () => {
      db.prepare(`INSERT INTO mem_fts(mem_fts) VALUES('rebuild')`).run();
    });
    // ② VACUUM：**必须在事务外**（SQLite 硬性要求）
    db.exec('VACUUM');
    vacuumed = true;
  }

  // ── 步骤 4：汇总事件（无论步骤 1 是否执行都要记）──
  const summary = readClusterSummary(db);
  const payload: SweepSummaryEventPayload = {
    action: 'purge',
    purged,
    archivedCount,
    vacuumed,
    coactPairsActive: coact.active,
    coactPairsPurged: coact.purged,
    clusterCount: summary.clusterCount,
    largestClusterRatio: summary.largestClusterRatio,
    largestClusterRatioBeforeSplit: summary.largestClusterRatioBeforeSplit,
    blocksAfterSplit: summary.blocksAfterSplit,
  };
  // ⚠️ **`memory_id` 必须是显式 null**：这是整次 sweep 的汇总，
  //   挂到某个 id 上会让该记忆的脱敏范围**莫名覆盖这条汇总**。
  store.events.appendEvent('sweep', null, payload, at);

  return { purged, archivedCount, coactPairsPurged: coact.purged };
}
