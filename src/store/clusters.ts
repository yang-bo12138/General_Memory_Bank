/**
 * 主题簇的重算与**快照发布** —— DESIGN-v2.md §4.12.3（簇的变更比合并更难）/
 * §4.12.4（超大簇的三层防护），对应 DEVELOPMENT-PLAN.md **P3-T03** 的 `recluster`。
 *
 * ★ **库内无定时器**（ADR-5）：`recluster()` 是**由调用方调度的同步操作** ⇒
 *   `CLUSTER_RECALC_INTERVAL_MS` 是「**两次发布之间的最小间隔**」，
 *   **不是调度承诺**（不需要定时器，不违反全同步）。
 *
 * ★ **快照是「当前快照」，每次重算**整表替换**（**同一事务内**）：
 *   ⇒ 中途失败 ⇒ **旧快照完好**（不是半张表）。
 *
 * ⚠️ **簇本体是缓存，定义永远是纯函数**（§4.12.2）：
 *   ⇒ 删掉 `theme_clusters` + `theme_cluster_members` 两张表重建一次，**结果必须完全一致**。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import type { SweepReclusterEventPayload } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import {
  type ClusterComputation,
  type CoactGraphEdge,
  computeClusters,
  filterEffectiveEdges,
} from '../neuron/cluster.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

/**
 * 聚类算法版本（**换算法必须递增**，§6 的 `algoVersion`）。
 *
 * ⚠️ **为什么要有它**：快照是缓存 ⇒ 换算法后旧快照与新算法**语义不同** ⇒
 *   消费方要能判断「这份快照是哪个算法产的」。
 */
export const CLUSTER_ALGO_VERSION = 1;

/** `recluster` 的返回值（§6 的签名）。 */
export interface ReclusterResult {
  /** 簇数（**跳过时与真算出来「长得一样」** ⇒ 宿主必须看 `computed` / `skipped`）。 */
  clusterCount: number;
  /** 切分后的最大块占比（「现在有没有大簇」）。 */
  largestClusterRatio: number;
  /** 本次**是否真的重算了**。 */
  computed: boolean;
  /** 非 `null` ⇒ 因距上次发布不足 `CLUSTER_RECALC_INTERVAL_MS` 而跳过。 */
  skipped: 'too_soon' | null;
}

/** `recluster` 需要的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface ClusterStore {
  db: Database.Database;
  params: Params;
  events: EventWriter;
}

/** 快照元信息（`cluster_snapshot_meta` 的单行）。 */
interface SnapshotMeta {
  version: number;
  computed_at: number;
  algo_version: number;
  min_affinity: number;
  max_raw_ratio: number | null;
  last_split_at: number | null;
  last_split_reason: string | null;
  last_split_threshold: number | null;
  last_split_blocks: number | null;
  cluster_count: number;
  member_count: number;
}

/** 读快照元信息（**没有快照 ⇒ `undefined`**）。 */
function readSnapshotMeta(db: Database.Database): SnapshotMeta | undefined {
  return db
    .prepare(
      `SELECT version, computed_at, algo_version, min_affinity, max_raw_ratio,
              last_split_at, last_split_reason, last_split_threshold, last_split_blocks,
              cluster_count, member_count
         FROM cluster_snapshot_meta WHERE id = 1`,
    )
    .get() as SnapshotMeta | undefined;
}

/**
 * 读**两端都活跃**的共激活边（§4.12.1：软删端点的边**不计入簇**）。
 *
 * ⚠️ **用 JOIN 而不是查完再筛**：软删端点的边**连查都不查**
 *   ⇒ 软删记忆**不会**被拉进任何簇（§4.12.1 ②）。
 */
function readLiveEdges(db: Database.Database): CoactGraphEdge[] {
  const rows = db
    .prepare(
      `SELECT c.memory_a AS a, c.memory_b AS b, c.affinity AS affinity, c.last_active AS last_active
         FROM coacts c
         JOIN memories ma ON ma.id = c.memory_a
         JOIN memories mb ON mb.id = c.memory_b
        WHERE ma.deleted = 0 AND mb.deleted = 0
        ORDER BY c.memory_a, c.memory_b`,
    )
    .all() as Array<{ a: string; b: string; affinity: number; last_active: number }>;
  return rows.map((row) => ({
    a: row.a,
    b: row.b,
    affinity: row.affinity,
    lastActive: row.last_active,
  }));
}

/** 库内**活跃**记忆数（占比的分母）。 */
function countLiveMemories(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted = 0').get() as {
    n: number;
  };
  return row.n;
}

/** 当前快照里的**最大块**规模（跳过时用来还原 `largestClusterRatio`）。 */
function maxPublishedBlockSize(db: Database.Database): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(member_count), 0) AS n FROM theme_clusters')
    .get() as { n: number };
  return row.n;
}

/**
 * 把一次重算的产物**整表替换**进快照（**同一事务内**）。
 *
 * ⚠️ **先删后插**（不是 UPSERT）：快照是「**当前快照**」⇒ 上一版的簇**整体作废**
 *   ⇒ 留在库里就成了「幽灵簇」。
 * ⚠️ **删 `theme_clusters` 会级联删 `theme_cluster_members`**（`ON DELETE CASCADE`）
 *   ⇒ 但仍**显式**删一次成员表：让「删了什么」在代码里是明写的，不依赖级联语义。
 */
function publishSnapshot(
  db: Database.Database,
  computation: ClusterComputation,
  meta: {
    version: number;
    computedAt: number;
    minAffinity: number;
    rawComponentShare: number;
    splitTriggered: boolean;
    splitBlocks: number;
    previous: SnapshotMeta | undefined;
    params: Params;
  },
): void {
  db.prepare('DELETE FROM theme_cluster_members').run();
  db.prepare('DELETE FROM theme_clusters').run();

  const insertCluster = db.prepare(
    `INSERT INTO theme_clusters (cluster_id, cluster_version, computed_at, member_count)
     VALUES (@clusterId, @version, @computedAt, @memberCount)`,
  );
  const insertMember = db.prepare(
    'INSERT INTO theme_cluster_members (cluster_id, memory_id) VALUES (@clusterId, @memoryId)',
  );
  for (const cluster of computation.clusters) {
    insertCluster.run({
      clusterId: cluster.clusterId,
      version: meta.version,
      computedAt: meta.computedAt,
      memberCount: cluster.memberIds.length,
    });
    for (const memberId of cluster.memberIds) {
      insertMember.run({ clusterId: cluster.clusterId, memoryId: memberId });
    }
  }

  // ⚠️ **单行表**（`CHECK (id = 1)`）：每次重算整行替换 ⇒ 永远只有一行。
  // ⚠️ **`last_split_*` 四列只记「最近一次」**（语义纯净，**不记历史峰值**）：
  //   本次没切分 ⇒ **保留上一次的值**（它们回答的是「最近一次切分是什么时候」）。
  const lastSplitAt = meta.splitTriggered
    ? meta.computedAt
    : (meta.previous?.last_split_at ?? null);
  const lastSplitReason = meta.splitTriggered
    ? 'max_share_exceeded'
    : (meta.previous?.last_split_reason ?? null);
  const lastSplitThreshold = meta.splitTriggered
    ? meta.params.MAX_CLUSTER_SHARE
    : (meta.previous?.last_split_threshold ?? null);
  const lastSplitBlocks = meta.splitTriggered
    ? meta.splitBlocks
    : (meta.previous?.last_split_blocks ?? null);

  db.prepare(
    `INSERT INTO cluster_snapshot_meta
       (id, version, computed_at, algo_version, min_affinity, max_raw_ratio,
        last_split_at, last_split_reason, last_split_threshold, last_split_blocks,
        cluster_count, member_count)
     VALUES (1, @version, @computedAt, @algoVersion, @minAffinity, @maxRawRatio,
             @lastSplitAt, @lastSplitReason, @lastSplitThreshold, @lastSplitBlocks,
             @clusterCount, @memberCount)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       computed_at = excluded.computed_at,
       algo_version = excluded.algo_version,
       min_affinity = excluded.min_affinity,
       max_raw_ratio = excluded.max_raw_ratio,
       last_split_at = excluded.last_split_at,
       last_split_reason = excluded.last_split_reason,
       last_split_threshold = excluded.last_split_threshold,
       last_split_blocks = excluded.last_split_blocks,
       cluster_count = excluded.cluster_count,
       member_count = excluded.member_count`,
  ).run({
    version: meta.version,
    computedAt: meta.computedAt,
    algoVersion: CLUSTER_ALGO_VERSION,
    minAffinity: meta.minAffinity,
    maxRawRatio: meta.rawComponentShare,
    lastSplitAt,
    lastSplitReason,
    lastSplitThreshold,
    lastSplitBlocks,
    clusterCount: computation.clusters.length,
    memberCount: computation.clusters.reduce((sum, cluster) => sum + cluster.memberIds.length, 0),
  });
}

/**
 * `recluster(now?)` —— §6 的**重算主题簇并发布快照**。
 *
 * ⚠️ **距上次发布不足 `CLUSTER_RECALC_INTERVAL_MS` ⇒ 跳过**（幂等返回，`skipped = 'too_soon'`）
 *   ⇒ 宿主任意频繁调用都不会触发阻塞。
 * ⚠️ **跳过时 `clusterCount` 与真算出来「长得一样」** ⇒ 宿主必须靠 `computed` / `skipped` 区分，
 *   **不能靠 `clusterCount` 的值判断有没有重算**。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器
 * @param now 注入时钟（C37）
 * @returns §6 的 `ReclusterResult`
 * @throws {MemoryError} 只读实例上抛 `READONLY_VIOLATION`（写方法）
 */
export function recluster(store: ClusterStore, now?: number): ReclusterResult {
  if (store.events.readonly) {
    // ⚠️ **只读实例上的真正写操作必须抛 `READONLY_VIOLATION`**（§7.1）：
    //   `appendEvent()` 的短路只覆盖**事件写入**，发布快照是货真价实的写库。
    throw MemoryError.readonlyViolation(
      'recluster() 在只读实例上不可用（发布簇快照要写 theme_clusters / theme_cluster_members）',
      { operation: 'recluster' },
    );
  }

  const at = resolveNow(now);
  const db = store.db;
  const params = store.params;

  const previous = readSnapshotMeta(db);

  // ── 间隔闸门（幂等跳过）──
  if (previous !== undefined && at - previous.computed_at < params.CLUSTER_RECALC_INTERVAL_MS) {
    const totalMemories = countLiveMemories(db);
    const largestClusterRatio = totalMemories > 0 ? maxPublishedBlockSize(db) / totalMemories : 0;
    return {
      clusterCount: previous.cluster_count,
      largestClusterRatio,
      computed: false,
      skipped: 'too_soon',
    };
  }

  // ── 算（纯计算，只读）──
  const totalMemories = countLiveMemories(db);
  const liveEdges = readLiveEdges(db);
  const effectiveEdges = filterEffectiveEdges(liveEdges, at, params);
  const computation = computeClusters({
    edges: effectiveEdges,
    totalMemories,
    now: at,
    params,
  });

  // ── 发布（**整表替换，同一事务内**）──
  runWriteTransaction(db, () => {
    publishSnapshot(db, computation, {
      version: (previous?.version ?? 0) + 1,
      computedAt: at,
      minAffinity: params.COACT_AFFINITY_MIN,
      rawComponentShare: computation.rawComponentShare,
      splitTriggered: computation.splitTriggered,
      splitBlocks: computation.splitBlocks,
      previous,
      params,
    });

    // ⚠️ **事件**（§8.4 的 sweep 行）：`action='recluster'` ⇒ 字段集**只有**
    //   `clusterCount` 与 `largestClusterRatio` ⇒ **不写** `purged` / `vacuumed` /
    //   `coactPairsActive`（那些字段本次**没发生**，填 0 就是在**伪造事实**）。
    // ⚠️ **`memory_id` 一律填 `null`**（§8.4：这些动作不针对单条记忆）。
    const payload: SweepReclusterEventPayload = {
      action: 'recluster',
      clusterCount: computation.clusters.length,
      largestClusterRatio: computation.largestClusterRatio,
    };
    store.events.appendEvent('sweep', null, payload, at);
  });

  return {
    clusterCount: computation.clusters.length,
    largestClusterRatio: computation.largestClusterRatio,
    computed: true,
    skipped: null,
  };
}
