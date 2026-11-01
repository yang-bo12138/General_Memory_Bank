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
import { resolveFlags } from '../core/flags.js';
import type { Params } from '../core/params.js';
import {
  type ClusterComputation,
  type CoactGraphEdge,
  computeClusters,
  filterEffectiveEdges,
  originIdOf,
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
  /**
   * 本次**是否真的重算了**。
   *
   * ⚠️ ★ **它是派生量**：`computed === (skipped === null)`
   *   ⇒ 保留它只是为了 §6 的**向后兼容**（宿主可以只读 `computed`）
   *   ⇒ **宿主的读法**：先看 `computed`（有没有算）→ 再看 `skipped`（为什么没算）。
   */
  computed: boolean;
  /**
   * ★ **没重算的原因**（`null` ⇒ 没有跳过）。
   *
   * ⚠️ **三个取值**（2026-11-02 架构师裁决 · v2.1 勘误）：
   *   · `'too_soon'` ⇒ 因距上次发布不足 `CLUSTER_RECALC_INTERVAL_MS` 而跳过；
   *   · `'disabled'` ⇒ 因机制开关 `coactivation` 关闭而**没算**；
   *   · `null`      ⇒ 没有跳过（此时 `computed` 恒为 `true`）。
   *
   * ⚠️ ★ **不变式**：`computed === (skipped === null)`。
   * ⚠️ ⚠️ **不要靠 `clusterCount` 的值判断有没有重算**（跳过的返回值见下）。
   */
  skipped: 'too_soon' | 'disabled' | null;
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
 * ⚠️ **机制开关 `coactivation` 关 ⇒ 也没算**（幂等返回，`skipped = 'disabled'`）。
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

  // ⚠️ ★ **机制开关 `coactivation`**（§5 机制开关表）：
  //   关 ⇒「**主题簇不计算也不使用**」
  //   ⇒ **不读共激活图、不算簇、不写快照、不写事件** ⇒ 直接返回「没算」。
  //   ⚠️ **为什么放在只读守卫之后**：§6 把 `recluster` 列为**三个写方法**之一
  //   ⇒ 「在只读实例上调写方法」是**契约违规**，**与开关无关**
  //   ⇒ §7.1 的守卫**不得随开关变化**（否则「关掉开关就绕过了只读守卫」）。
  //   ⚠️ ★ **`skipped = 'disabled'`**（2026-11-02 架构师裁决 · v2.1 勘误）：
  //   「没重算」的**原因**必须被说出来 ⇒ 旧宿主若写「`skipped === 'too_soon'` ⇒ 跳过，
  //   否则 ⇒ 算了」会把 `'disabled'` **误判成「算了」** ⇒ 这是**破坏性变更**
  //   （见 `docs/DELIVERY.md` 的破坏性变更清单）。
  //   ⇒ 返回口径与 `'too_soon'` **不同**：`clusterCount = 0`、`largestClusterRatio = 0`
  //     （因为「簇」这件事**根本不存在**，不是「存在但为空」）。
  if (!resolveFlags(params).coactivation) {
    return { clusterCount: 0, largestClusterRatio: 0, computed: false, skipped: 'disabled' };
  }

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
    // ⚠️ ★ **不变式 `computed === (skipped === null)`**（2026-11-02 架构师裁决）：
    //   三个取值下都必须成立 ⇒ 这里「算了」⇒ `computed: true` + `skipped: null`。
    computed: true,
    skipped: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、只读导航：`clusters()`（§6 / §4.12.4）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `clusters()` 需要的上下文（**纯读**：只要库句柄 + 生效参数）。
 *
 * ⚠️ **刻意不要 `events`**：本方法**不记事件**（§6 的「只读导航」/ §7.1 的「7 个允许读的方法」）
 *   ⇒ 上下文里连事件写入器的位置都不留 ⇒ **结构上**杜绝了「顺手记一条」的写法。
 */
export interface ClusterQueryStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（阈值与上限都是可调项 ⇒ **必传**）。 */
  params: Params;
}

/**
 * `clusters()` 的入参（§6：`options?: { minAffinity?: number; minSize?: number; limit?: number }`）。
 *
 * ⚠️ ★ **刻意没有 id 白名单**（§6 的「`filter` 不接受 id 白名单」，§4.15.2 同款硬边界）：
 *   一旦允许传 id 集合，将来一定会有人把它接到文本路上——
 *   那正是「几何邻近否决词法精确」那件事。
 *   ⇒ **多传 `ids` 之类的键不产生任何过滤效果**（本方法只看下面三个键）。
 */
export interface ClustersOptions {
  /**
   * 调用方此刻要的**边阈值**（§6 的分流依据）。
   *
   * ⚠️ **缺省 ⇒ 读已发布快照**；**显式给了别的值 ⇒ 现场重算**（§6 的分流规则）。
   * ⚠️ **两处阈值不是同一个语义**：快照的 `min_affinity` = 该快照生成时用的边阈值；
   *   调用的 `minAffinity` = 调用方此刻要的边阈值。
   */
  minAffinity?: number;
  /** 展示侧过滤：只返回**活跃成员数 ≥ 它**的簇（**不触发重算**）。 */
  minSize?: number;
  /** 展示侧过滤：最多返回几个簇（**不触发重算**）。 */
  limit?: number;
}

/** 簇级切分来路（§6 的 `splitInfo`）。 */
export interface ClusterSplitInfo {
  /** 那个原始分量的占比（切前）。 */
  originRatio: number;
  /** 那个原始分量的成员数（**含已软删**）。 */
  originSize: number;
  /** 那次切分把它切成了几块。 */
  blocksCount: number;
  /** 那次切分的时刻（毫秒）。 */
  at: number;
}

/** 一个簇的呈现视图（§6 的 `clusters[]` 元素）。 */
export interface ClusterView {
  /**
   * 快照内标识 = **簇内最小成员 id**（确定性，但**不是稳定标识**）。
   *
   * ⚠️ **它不是稳定标识**：成员会随时间增减 ⇒ `key` 会变
   *   ⇒ 面板的「最近两次快照对比」必须用**成员重叠度**，不能用 `key`（§7.2 面板 7）。
   */
  key: string;
  /** 持久簇 id（**`key` 会变，它不会**）。 */
  clusterId: string;
  /**
   * 簇级分组键（快照内）：「它们是不是同一块切出来的」。
   *
   * ⚠️ **不跨快照持久**（不是簇的持久标识）⇒ 未被切分的簇**也有**它。
   */
  originComponentId?: string;
  /**
   * 展示用代表词（可为 `null`）。
   *
   * ⚠️ **本字段的口径由实现定义**（§6 只给了名字与「可为 null」）：
   *   取**代表记忆的正文摘要**（超长截断）⇒ 面板可以直接拿它当气泡标题，
   *   不用再为每个簇发一次 `get()`。
   */
  label: string | null;
  /**
   * ★ **块级**：本块**当前活跃**成员数（`deleted = 0`，**实时 COUNT**）。
   *
   * ⚠️ **不是快照里的存储值**（`theme_clusters.member_count` 记的是发布时刻的规模，
   *   含其后被软删的成员）⇒ **软删一条 ⇒ `size` 立刻减一**。
   */
  size: number;
  /**
   * 成员样本（**必须带 LIMIT** ⇒ ≤ `CLUSTER_MEMBER_SAMPLE_MAX`，默认 50）。
   *
   * ⚠️ **排序键**：**按有效 affinity 降序，同值按 id 字典序升序**
   *   （§6 / §4.12.4 ① 的**同一个键** ⇒ 两次调用顺序完全一致）。
   */
  memberIds: string[];
  /** 代表记忆 = 簇内**共激活度数**最高的成员（并列按 id 升序）。 */
  representativeId: string;
  /** 簇内高频实体（最多 3 个）：频次降序、名称升序。 */
  entities: string[];
  /** 簇内边的**有效亲和度**均值。 */
  meanAffinity: number;
  /** 簇内边的**有效亲和度**最大值。 */
  maxAffinity: number;
  /** 簇内边权之和（礁石高度）。 */
  strength: number;
  /** 簇内边最近一次共现的时刻（毫秒）。 */
  lastActive: number;
  /**
   * 簇级切分来路（**不落表** ⇒ 只有**现场重算路径**给得出）。
   *
   * ⚠️ 快照路径上**没有**这个字段：§6 明写它「**不落表**，重算重现」
   *   ⇒ 读已发布快照时**拿不到**它 ⇒ 需要它就用现场重算路径。
   */
  splitInfo?: ClusterSplitInfo;
}

/** `clusters()` 的返回值（§6）。 */
export interface ClustersResult {
  /** 切分后：当前最大块占比（「现在有没有大簇」）。 */
  largestClusterRatio: number;
  /** 切分前：**当前图**最大原始连通分量占比（「内容有多重复」）。 */
  maxRawComponentRatio: number;
  /** 簇列表（**按 `clusterId` 升序**，确定性）。 */
  clusters: ClusterView[];
  /**
   * ★ **簇划分所依据的共激活图的时间点**（两条路径下语义不同）：
   * · **快照路径** ⇒ = **已发布快照的 asOf**，**不是**传入的 `now`
   *   （⚠️ 传入的 `now` 在这条路径上**不参与 `asOf`**）；
   * · **现场重算路径** ⇒ = 传入的 `now`（⚠️ 此时 `clusterId` **不保证持久**）。
   */
  asOf: number;
  /**
   * 本次快照的生成时刻。
   *
   * ⚠️ **它与 `asOf` 不是同一个东西**：`asOf` = 簇划分所依据的图的时间点（T 时刻）；
   *   `computedAt` = 本次快照的生成时刻（**可能远晚于 T** ⇒ 算得慢的库两者相差很大）。
   */
  computedAt: number;
  /** 聚类算法版本（换算法必须递增）。 */
  algoVersion: number;
  /** 本快照是否已超过 `CLUSTER_RECALC_INTERVAL_MS` 未更新。 */
  stale: boolean;
  /** 满足条件的簇总数（**未受 `limit` 截断**）。 */
  totalClusters: number;
  /** **参与过共激活的记忆数**（出现在共激活边上的）。 */
  coveredMemories: number;
  /**
   * ★ **被采纳过**的未删记忆数（`access_count > 0`）。
   *
   * ⚠️ 与 `stats().adoptedMemories` 是**同一个数、同一口径、同一实现** ⇒ **必须恒等**
   *   ⇒ 本文件导出的 `countAdoptedMemories()` 就是那份**唯一实现**
   *   （阶段 4 的 `stats()` 必须复用它，**不得另写一份**）。
   */
  adoptedMemories: number;
  /** 全库未删记忆数。 */
  totalMemories: number;
  /** 满足条件的簇的**活跃成员数之和**（**未受 `limit` 截断**）。 */
  totalMembers: number;
  /**
   * ★ **只当过唤起者、从未被采纳**的记忆数 = `coveredMemories` 中不属于 `adoptedMemories` 的部分。
   *
   * ⚠️ **措辞要准**：它是**唤起者**，自己却从未被采纳（**不是**「它被召回了但没被用上」）。
   * ⚠️ **它不是健康分**：调用方可能正当地把召回结果当上下文用 ⇒ 这个数高**不必然是坏事**。
   */
  seedOnlyMemories: number;
  /** ① `coveredMemories / totalMemories`（**全库口径**）。 */
  coverage: number;
  /** ② `(coveredMemories − seedOnlyMemories) / adoptedMemories`（分子是**派生量**，必须现算）。 */
  coverageOverAdopted: number;
}

// ─────────────────────────── SQL ───────────────────────────

/**
 * 快照里**仍然活跃**的成员（**实时 COUNT 的来源**，§6 的 `size`）。
 *
 * ⚠️ **必须 `JOIN memories ... deleted = 0`**：快照是**冻结**的（§3：成员表刻意不设外键）
 *   ⇒ 软删**不会**级联改写快照 ⇒ 快照里的成员行**可能**指向已软删的记忆。
 */
const SNAPSHOT_LIVE_MEMBERS_SQL = `
  SELECT tcm.cluster_id AS cluster_id, tcm.memory_id AS memory_id
    FROM theme_cluster_members tcm
    JOIN memories m ON m.id = tcm.memory_id
   WHERE m.deleted = 0
   ORDER BY tcm.cluster_id, tcm.memory_id`;

/**
 * 快照里**两端都属于同一簇**的共激活边（带簇 id）。
 *
 * ⚠️ **驱动表是 `theme_cluster_members`**（不是 `coacts`）：
 *   `idx_tcm_memory` 上是点查 + `idx_coacts_pair` 上是探测 ⇒ 成本 O(覆盖成员数 × 度数)，
 *   **不是** O(全表 coacts) ⇒ 快照路径才可能是「瞬时返回」。
 */
const SNAPSHOT_INTRA_EDGES_SQL = `
  SELECT m1.cluster_id AS cluster_id, c.memory_a AS a, c.memory_b AS b,
         c.affinity AS affinity, c.last_active AS last_active
    FROM coacts c
    JOIN theme_cluster_members m1 ON m1.memory_id = c.memory_a
    JOIN theme_cluster_members m2 ON m2.memory_id = c.memory_b AND m2.cluster_id = m1.cluster_id
    JOIN memories ma ON ma.id = c.memory_a AND ma.deleted = 0
    JOIN memories mb ON mb.id = c.memory_b AND mb.deleted = 0
   ORDER BY m1.cluster_id, c.memory_a, c.memory_b`;

/** 批量取一批记忆的正文（`label` 用）。 */
const LOAD_CONTENTS_SQL = `
  SELECT id, content FROM memories
   WHERE id IN (SELECT value FROM json_each(@memoryIds))`;

/** 批量取一批记忆的实体**名称**（`entities` 用）。 */
const LOAD_ENTITY_NAMES_SQL = `
  SELECT me.memory_id AS memory_id, e.name AS name
    FROM memory_entities me
    JOIN entities e ON e.id = me.entity_id
   WHERE me.memory_id IN (SELECT value FROM json_each(@memoryIds))
   ORDER BY me.memory_id, e.name`;

/** 批量数「这一批里有多少条**被采纳过**」（`seedOnlyMemories` 的分子用）。 */
const COUNT_ADOPTED_AMONG_SQL = `
  SELECT COUNT(*) AS n FROM memories
   WHERE deleted = 0 AND access_count > 0
     AND id IN (SELECT value FROM json_each(@memoryIds))`;

/**
 * ★ **批量查询的批大小**（SQLite 绑定变量上限历史上是 999 ⇒ 用 `json_each` 展开，
 *   但 `json_each` 的参数本身是一整串 JSON ⇒ 批太大也会撑爆内存）。
 */
const QUERY_CHUNK_SIZE = 500;

/** `label` 的最大长度（超长截断并加省略号）。 */
const CLUSTER_LABEL_MAX_CHARS = 40;

// ─────────────────────────── 计数（与 `stats()` 共用的唯一实现） ───────────────────────────

/**
 * ★ **被采纳过的未删记忆数**（`access_count > 0`）—— §6 的 `clusters().adoptedMemories`
 * 与 `stats().adoptedMemories` 的**唯一实现**。
 *
 * ⚠️ **阶段 4 的 `stats()` 必须复用本函数**（§6：「同一个数、同一口径、同一实现 ⇒ 必须恒等」）
 *   ⇒ **不得另写一份 SQL**（C36：同一件事不得有两套实现）。
 *
 * @param db 库句柄
 * @returns 未删且 `access_count > 0` 的记忆数
 */
export function countAdoptedMemories(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted = 0 AND access_count > 0')
    .get() as { n: number };
  return row.n;
}

// ─────────────────────────── 小工具 ───────────────────────────

/**
 * 把一批 id 切成**不超过 `size` 的批**（避免绑定变量上限与超大 JSON）。
 *
 * @param ids id 列表
 * @param size 每批的最大条数
 * @returns 批次列表
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * 批量读一批记忆的**实体名称**（`memory_entities JOIN entities`）。
 *
 * ⚠️ **用 `json_each` 展开 id 列表**（与 `src/neuron/clusterhop.ts` 同一处理）：
 *   展开成一串 `?` 会撞 SQLite 的绑定变量上限 ⇒ 邻居一多就是运行时炸裂。
 *
 * @param db 库句柄
 * @param memoryIds 记忆 id 列表
 * @returns 记忆 id ⇒ 实体名称列表
 */
function loadEntityNamesByMemory(
  db: Database.Database,
  memoryIds: readonly string[],
): Map<string, string[]> {
  const names = new Map<string, string[]>();
  if (memoryIds.length === 0) {
    return names;
  }
  const statement = db.prepare(LOAD_ENTITY_NAMES_SQL);
  for (const batch of chunk(memoryIds, QUERY_CHUNK_SIZE)) {
    const rows = statement.all({ memoryIds: JSON.stringify(batch) }) as Array<{
      memory_id: string;
      name: string;
    }>;
    for (const row of rows) {
      const bucket = names.get(row.memory_id);
      if (bucket === undefined) {
        names.set(row.memory_id, [row.name]);
      } else {
        bucket.push(row.name);
      }
    }
  }
  return names;
}

/**
 * 数「这一批记忆里有多少条**被采纳过**」。
 *
 * @param db 库句柄
 * @param memoryIds 记忆 id 列表
 * @returns 其中 `deleted = 0 AND access_count > 0` 的条数
 */
function countAdoptedAmong(db: Database.Database, memoryIds: readonly string[]): number {
  if (memoryIds.length === 0) {
    return 0;
  }
  const statement = db.prepare(COUNT_ADOPTED_AMONG_SQL);
  let total = 0;
  for (const batch of chunk(memoryIds, QUERY_CHUNK_SIZE)) {
    const row = statement.get({ memoryIds: JSON.stringify(batch) }) as { n: number };
    total += row.n;
  }
  return total;
}

/**
 * 批量读一批记忆的**正文**（`label` 用）。
 *
 * @param db 库句柄
 * @param memoryIds 记忆 id 列表
 * @returns 记忆 id ⇒ 正文（缺失的记忆**不出现**在结果里）
 */
function loadContents(db: Database.Database, memoryIds: readonly string[]): Map<string, string> {
  const contents = new Map<string, string>();
  if (memoryIds.length === 0) {
    return contents;
  }
  const statement = db.prepare(LOAD_CONTENTS_SQL);
  for (const batch of chunk(memoryIds, QUERY_CHUNK_SIZE)) {
    const rows = statement.all({ memoryIds: JSON.stringify(batch) }) as Array<{
      id: string;
      content: string;
    }>;
    for (const row of rows) {
      contents.set(row.id, row.content);
    }
  }
  return contents;
}

/**
 * 截断成**展示用代表词**（`label`）。
 *
 * @param content 正文
 * @returns 截断后的标签（正文为空 ⇒ `null`）
 */
function toLabel(content: string | undefined): string | null {
  if (content === undefined || content.length === 0) {
    return null;
  }
  if (content.length <= CLUSTER_LABEL_MAX_CHARS) {
    return content;
  }
  return `${content.slice(0, CLUSTER_LABEL_MAX_CHARS)}…`;
}

/**
 * 取簇内**高频实体**（最多 3 个）：频次降序、名称升序。
 *
 * @param memberIds 簇的**活跃**成员 id
 * @param namesByMemory 记忆 id ⇒ 实体名称列表
 * @returns 至多 3 个实体名称
 */
function pickTopEntities(
  memberIds: readonly string[],
  namesByMemory: ReadonlyMap<string, readonly string[]>,
): string[] {
  const counts = new Map<string, number>();
  for (const memberId of memberIds) {
    const names = namesByMemory.get(memberId);
    if (names === undefined) {
      continue;
    }
    for (const name of names) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .slice(0, 3)
    .map((entry) => entry[0]);
}

// ─────────────────────────── 簇的呈现 ───────────────────────────

/**
 * 一个待呈现的簇（两条取数路径共用的中间形态）。
 *
 * ⚠️ **成员一律是「当前活跃」的**（`deleted = 0`）⇒ 两条路径的 `size` / `key` / `memberIds`
 *   口径完全一致（只有 `splitInfo` 与 `asOf` / `computedAt` 不同）。
 */
interface ClusterWork {
  /** 持久簇 id。 */
  clusterId: string;
  /** **活跃**成员 id（**升序** ⇒ `memberIds[0]` 就是 `key`）。 */
  memberIds: string[];
  /** 所属原始分量的分组键。 */
  originComponentId: string;
  /** 簇级切分来路（**只有现场重算路径给得出** ⇒ 快照路径为 `undefined`）。 */
  splitInfo: ClusterSplitInfo | undefined;
}

/**
 * 一个簇的**统计量**（呈现之前先算好 ⇒ **代表记忆**先于 `label` 定下来）。
 *
 * ⚠️ **成员一律是「当前活跃」的** ⇒ 两条路径的 `size` / `key` / `memberIds` 口径完全一致
 *   （只有 `splitInfo` 与 `asOf` / `computedAt` 不同）。
 */
interface ClusterStats {
  /** 持久簇 id。 */
  clusterId: string;
  /** **活跃**成员 id（**升序** ⇒ `memberIds[0]` 就是 `key`）。 */
  memberIds: string[];
  /** 所属原始分量的分组键。 */
  originComponentId: string;
  /** 簇级切分来路（**只有现场重算路径给得出** ⇒ 快照路径为 `undefined`）。 */
  splitInfo: ClusterSplitInfo | undefined;
  /** 快照内标识 = 簇内最小成员 id。 */
  key: string;
  /** 当前活跃成员数（**实时 COUNT**）。 */
  size: number;
  /** 代表记忆 = 簇内**共激活度数**最高的成员（并列按 id 升序）。 */
  representativeId: string;
  /** 簇内边的有效亲和度均值。 */
  meanAffinity: number;
  /** 簇内边的有效亲和度最大值。 */
  maxAffinity: number;
  /** 簇内边权之和（礁石高度）。 */
  strength: number;
  /** 簇内边最近一次共现的时刻（毫秒）。 */
  lastActive: number;
  /** 成员样本（排序键 = 有效 affinity 降序，同值按 id 升序）。 */
  memberIdsSample: string[];
}

/**
 * 把「簇 + 簇内边」算成**统计量**。
 *
 * ⚠️ **成员样本的排序键**（§6 / §4.12.4 ①）：**按有效 affinity 降序，同值按 id 字典序升序**
 *   ⇒ 这里的「成员的有效 affinity」= **该成员在簇内的最大有效亲和度**
 *   （一个成员有多条边 ⇒ 取最强的那条；「节点强度（权之和）」是**另一个**量，
 *   §4.12.4 的均衡分块用它，**这里不用它** ⇒ 两处口径必须分清）。
 *
 * @param work 簇的中间形态
 * @param intraEdges 簇 id ⇒ 簇内边（带**有效**亲和度）
 * @param params 生效参数（`CLUSTER_MEMBER_SAMPLE_MAX`）
 * @returns 统计量（**顺序 = `work` 的顺序** = 簇 id 升序）
 */
function computeClusterStats(
  work: readonly ClusterWork[],
  intraEdges: ReadonlyMap<string, CoactGraphEdge[]>,
  params: Params,
): ClusterStats[] {
  const stats: ClusterStats[] = [];
  for (const item of work) {
    const edges = intraEdges.get(item.clusterId) ?? [];

    // ── 簇内的边统计（强度 / 均值 / 最大值 / 最近活跃）──
    let affinitySum = 0;
    let maxAffinity = 0;
    let lastActive = 0;
    const maxAffinityByMember = new Map<string, number>();
    const degreeByMember = new Map<string, number>();
    for (const edge of edges) {
      affinitySum += edge.affinity;
      if (edge.affinity > maxAffinity) {
        maxAffinity = edge.affinity;
      }
      if (edge.lastActive > lastActive) {
        lastActive = edge.lastActive;
      }
      for (const endpoint of [edge.a, edge.b]) {
        degreeByMember.set(endpoint, (degreeByMember.get(endpoint) ?? 0) + 1);
        const current = maxAffinityByMember.get(endpoint) ?? 0;
        if (edge.affinity > current) {
          maxAffinityByMember.set(endpoint, edge.affinity);
        }
      }
    }

    // ── 代表记忆：簇内**共激活度数**最高（并列按 id 升序）──
    // ⚠️ `memberIds` 已升序 ⇒ 严格 `>` 比较 ⇒ 并列时保留**较小**的 id ✓
    let representativeId = item.memberIds[0] ?? '';
    let bestDegree = -1;
    for (const memberId of item.memberIds) {
      const degree = degreeByMember.get(memberId) ?? 0;
      if (degree > bestDegree) {
        bestDegree = degree;
        representativeId = memberId;
      }
    }

    // ── 成员样本（排序键 = 有效 affinity 降序，同值按 id 升序）──
    const ordered = [...item.memberIds].sort((left, right) => {
      const leftAffinity = maxAffinityByMember.get(left) ?? 0;
      const rightAffinity = maxAffinityByMember.get(right) ?? 0;
      if (leftAffinity !== rightAffinity) {
        return rightAffinity - leftAffinity;
      }
      return left < right ? -1 : left > right ? 1 : 0;
    });

    stats.push({
      clusterId: item.clusterId,
      memberIds: item.memberIds,
      originComponentId: item.originComponentId,
      splitInfo: item.splitInfo,
      // ⚠️ `key` = **簇内最小成员 id**（`memberIds` 升序 ⇒ 第一个就是它）
      key: item.memberIds[0] ?? '',
      size: item.memberIds.length,
      representativeId,
      meanAffinity: edges.length > 0 ? affinitySum / edges.length : 0,
      maxAffinity,
      strength: affinitySum,
      lastActive,
      memberIdsSample: ordered.slice(0, Math.max(0, params.CLUSTER_MEMBER_SAMPLE_MAX)),
    });
  }
  return stats;
}

/**
 * 把统计量组装成**呈现视图**（`ClusterView[]`）。
 *
 * @param stats 簇的统计量
 * @param namesByMemory 记忆 id ⇒ 实体名称列表
 * @param contents 记忆 id ⇒ 正文（`label` 用）
 * @returns 呈现视图（**顺序 = `stats` 的顺序** = 簇 id 升序）
 */
function buildClusterViews(
  stats: readonly ClusterStats[],
  namesByMemory: ReadonlyMap<string, readonly string[]>,
  contents: ReadonlyMap<string, string>,
): ClusterView[] {
  const views: ClusterView[] = [];
  for (const item of stats) {
    const view: ClusterView = {
      key: item.key,
      clusterId: item.clusterId,
      originComponentId: item.originComponentId,
      label: toLabel(contents.get(item.representativeId)),
      size: item.size,
      memberIds: item.memberIdsSample,
      representativeId: item.representativeId,
      entities: pickTopEntities(item.memberIds, namesByMemory),
      meanAffinity: item.meanAffinity,
      maxAffinity: item.maxAffinity,
      strength: item.strength,
      lastActive: item.lastActive,
    };
    if (item.splitInfo !== undefined) {
      view.splitInfo = item.splitInfo;
    }
    views.push(view);
  }
  return views;
}

/**
 * 应用**展示侧过滤**（`minSize` / `limit`）。
 *
 * ⚠️ ★ **这两个参数不得触发重算**（§6 / 计划稿 P3-T05）：
 *   ⇒ 它们**只在结果算完之后**做过滤 ⇒ 走的是快照路径还是现场重算路径，
 *   **由 `minAffinity` 单独决定**（§6 的分流规则）。
 *
 * @param views 已算好的簇视图
 * @param options 调用方选项
 * @returns 过滤后的簇 + `totalClusters`（未受 `limit` 截断）+ `totalMembers`
 */
function applyDisplayFilters(
  views: readonly ClusterView[],
  options: ClustersOptions | undefined,
): { clusters: ClusterView[]; totalClusters: number; totalMembers: number } {
  const minSize = options?.minSize;
  const limit = options?.limit;
  const matching = minSize === undefined ? views : views.filter((view) => view.size >= minSize);
  const totalClusters = matching.length;
  const totalMembers = matching.reduce((sum, view) => sum + view.size, 0);
  const limited =
    limit === undefined ? matching : matching.slice(0, Math.max(0, Math.trunc(limit)));
  return { clusters: [...limited], totalClusters, totalMembers };
}

// ─────────────────────────── 两条取数路径 ───────────────────────────

/**
 * ★ **快照路径**：读**已发布快照**（瞬时返回，但可能是旧的）。
 *
 * ⚠️ **`now` 在这条路径上不参与 `asOf`**（§6 的原文）：
 *   `asOf` = 已发布快照的 asOf ⇒ **传入的 `now` 被完全忽略且不报错**
 *   （静默失效——但这是**刻意**的：`now` 在这条路径上本来就没有意义，
 *   报错会打断正常的只读查询）。
 *   ⇒ **唯一**用到 `now` 的地方是 `stale`（它必须有一个时间参照 ⇒ §11.1 的 C37）。
 *
 * @param db 库句柄
 * @param params 生效参数
 * @param meta 快照元信息
 * @param options 调用方选项
 * @param at 注入时钟（**只用于 `stale`**）
 * @returns §6 的 `ClustersResult`
 */
function buildFromSnapshot(
  db: Database.Database,
  params: Params,
  meta: SnapshotMeta,
  options: ClustersOptions | undefined,
  at: number,
): ClustersResult {
  // ★ **簇划分所依据的图时刻 = 快照的生成时刻**（当前 `recluster()` 用同一个时间戳
  //   既做图基准又做发布时间 ⇒ 快照路径上 `asOf === computedAt`）。
  const graphAt = meta.computed_at;
  // ⚠️ **阈值取「快照自己记录的」**（`meta.min_affinity`），**不是**常量 `COACT_AFFINITY_MIN`
  //   （§6：「否则『重算换了阈值而快照没换』时，分流会走错路径」）。
  const threshold = meta.min_affinity;

  // ── 簇的**活跃**成员（实时 COUNT 的来源）──
  const memberRows = db.prepare(SNAPSHOT_LIVE_MEMBERS_SQL).all() as Array<{
    cluster_id: string;
    memory_id: string;
  }>;
  const membersByCluster = new Map<string, string[]>();
  for (const row of memberRows) {
    const bucket = membersByCluster.get(row.cluster_id);
    if (bucket === undefined) {
      membersByCluster.set(row.cluster_id, [row.memory_id]);
    } else {
      bucket.push(row.memory_id);
    }
  }

  // ── 簇内边（带有效亲和度）──
  const rawEdgesByCluster = new Map<string, CoactGraphEdge[]>();
  const edgeRows = db.prepare(SNAPSHOT_INTRA_EDGES_SQL).all() as Array<{
    cluster_id: string;
    a: string;
    b: string;
    affinity: number;
    last_active: number;
  }>;
  for (const row of edgeRows) {
    const bucket = rawEdgesByCluster.get(row.cluster_id);
    const edge: CoactGraphEdge = {
      a: row.a,
      b: row.b,
      affinity: row.affinity,
      lastActive: row.last_active,
    };
    if (bucket === undefined) {
      rawEdgesByCluster.set(row.cluster_id, [edge]);
    } else {
      bucket.push(edge);
    }
  }
  // ⚠️ **门槛过滤与衰减只有这一份实现**（`filterEffectiveEdges()`，§4.11.3 原则 3）
  //   ⇒ 阈值用**快照自己的**那个（覆盖 `params.COACT_AFFINITY_MIN`）。
  const thresholdParams: Params = { ...params, COACT_AFFINITY_MIN: threshold };
  const intraEdges = new Map<string, CoactGraphEdge[]>();
  for (const [clusterId, edges] of rawEdgesByCluster) {
    intraEdges.set(clusterId, filterEffectiveEdges(edges, graphAt, thresholdParams));
  }

  // ── 簇的中间形态（★ **空的簇不出现**：没有活跃成员 ⇒ 没有代表记忆 ⇒ 无法导航）──
  const work: ClusterWork[] = [];
  // ⚠️ **用 `Set` 去重**：快照的簇**理应**互斥（连通分量是划分）⇒ 但 `coveredMemories`
  //   的口径是「**参与过共激活的记忆数**」= **去重后**的条数
  //   ⇒ 一旦快照里出现重复成员（畸形快照），去重后才是对的数
  //   （否则 `seedOnlyMemories = covered − 已采纳` 会算歪）。
  const coveredIdSet = new Set<string>();
  for (const [clusterId, memberIds] of membersByCluster) {
    if (memberIds.length === 0) {
      continue;
    }
    work.push({
      clusterId,
      memberIds,
      originComponentId: originIdOf(clusterId),
      // ⚠️ **快照路径没有 `splitInfo`**：§6 明写它「**不落表**，重算重现」
      //   ⇒ 读已发布快照时拿不到它 ⇒ 需要它就用现场重算路径。
      splitInfo: undefined,
    });
    for (const memberId of memberIds) {
      coveredIdSet.add(memberId);
    }
  }
  work.sort((left, right) =>
    left.clusterId < right.clusterId ? -1 : left.clusterId > right.clusterId ? 1 : 0,
  );
  const coveredIds = [...coveredIdSet];

  // ── 同刻取数（§0.2.2：两个覆盖率必须同刻）──
  const totalMemories = countLiveMemories(db);
  const adoptedMemories = countAdoptedMemories(db);
  const coveredMemories = coveredIds.length;
  const seedOnlyMemories = coveredMemories - countAdoptedAmong(db, coveredIds);

  // ── 呈现 ──
  const namesByMemory = loadEntityNamesByMemory(db, coveredIds);
  const stats = computeClusterStats(work, intraEdges, params);
  const views = buildClusterViews(
    stats,
    namesByMemory,
    loadContents(db, collectRepresentativeIds(stats)),
  );

  // ⚠️ **`largestClusterRatio` 是快照的属性**（不是展示过滤的结果）
  //   ⇒ 在 `minSize` / `limit` 之前算 ⇒ 「现在有没有大簇」不受展示选项影响。
  let largestBlockSize = 0;
  for (const view of views) {
    if (view.size > largestBlockSize) {
      largestBlockSize = view.size;
    }
  }
  const filtered = applyDisplayFilters(views, options);

  return {
    largestClusterRatio: totalMemories > 0 ? largestBlockSize / totalMemories : 0,
    // ⚠️ `max_raw_ratio` 是**快照落表的那个中间量**（§3 的 `cluster_snapshot_meta`）
    maxRawComponentRatio: meta.max_raw_ratio ?? 0,
    clusters: filtered.clusters,
    // ★ 快照路径：`asOf` = **已发布快照的 asOf**（**不是**传入的 `now`）
    asOf: graphAt,
    computedAt: meta.computed_at,
    algoVersion: meta.algo_version,
    // ⚠️ **`stale` 需要一个时间参照** ⇒ 用注入的 `now`（没注入则真实时钟）
    stale: at - meta.computed_at > params.CLUSTER_RECALC_INTERVAL_MS,
    totalClusters: filtered.totalClusters,
    coveredMemories,
    adoptedMemories,
    totalMemories,
    totalMembers: filtered.totalMembers,
    seedOnlyMemories,
    coverage: totalMemories > 0 ? coveredMemories / totalMemories : 0,
    coverageOverAdopted:
      adoptedMemories > 0 ? (coveredMemories - seedOnlyMemories) / adoptedMemories : 0,
  };
}

/**
 * ★ **现场重算路径**：`minAffinity` 显式给了别的值 ⇒ 现算一份（**不发布**）。
 *
 * ⚠️ **返回的一定是当前值，但 `clusterId` 不保证持久**（§6 的原文）
 *   ⇒ 调用方自己认 `key`。
 * ⚠️ **本路径**：
 *   · `asOf` = 传入的 `now`（簇划分所依据的图时刻）；
 *   · `computedAt` = **本次算完的时刻**（真实时钟）⇒ 两者**可以不同**
 *     （注入一个过去的 `now` ⇒ 「慢算」场景 ⇒ `computedAt` 远晚于 `asOf`）。
 *
 * @param db 库句柄
 * @param params 生效参数
 * @param options 调用方选项
 * @param at 注入时钟（图时刻 = `asOf`）
 * @param requestedMinAffinity 调用方要的边阈值（`undefined` ⇒ 用参数表里的默认）
 * @returns §6 的 `ClustersResult`
 */
function buildFromLive(
  db: Database.Database,
  params: Params,
  options: ClustersOptions | undefined,
  at: number,
  requestedMinAffinity: number | undefined,
): ClustersResult {
  const threshold = requestedMinAffinity ?? params.COACT_AFFINITY_MIN;
  const totalMemories = countLiveMemories(db);

  // ── 算（纯计算，只读）──
  const liveEdges = readLiveEdges(db);
  // ⚠️ **阈值来自调用方**（`options.minAffinity`），不是 `params.COACT_AFFINITY_MIN`
  //   ⇒ 这里**不改** `src/neuron/cluster.ts` 的 `filterEffectiveEdges()`（P3-T03 的成果），
  //   而是**传一份改了阈值的 params** ⇒ 衰减公式与门槛判定**仍然只有一份实现**（C36）。
  const thresholdParams: Params = { ...params, COACT_AFFINITY_MIN: threshold };
  const effectiveEdges = filterEffectiveEdges(liveEdges, at, thresholdParams);
  const computation = computeClusters({
    edges: effectiveEdges,
    totalMemories,
    now: at,
    params,
  });

  // ── 簇的中间形态 ──
  const memberToCluster = new Map<string, string>();
  const work: ClusterWork[] = [];
  const coveredIds: string[] = [];
  for (const cluster of computation.clusters) {
    work.push({
      clusterId: cluster.clusterId,
      memberIds: cluster.memberIds,
      originComponentId: cluster.originComponentId,
      // ★ 现场重算路径**给得出** `splitInfo`（§6：「不落表，重算重现」）
      splitInfo: {
        originRatio: cluster.originRatio,
        originSize: cluster.originSize,
        blocksCount: cluster.blocksCount,
        at: cluster.splitAt,
      },
    });
    for (const memberId of cluster.memberIds) {
      memberToCluster.set(memberId, cluster.clusterId);
    }
    coveredIds.push(...cluster.memberIds);
  }

  // ── 簇内边（两端属于同一簇的那些）──
  const intraEdges = new Map<string, CoactGraphEdge[]>();
  for (const edge of effectiveEdges) {
    const clusterA = memberToCluster.get(edge.a);
    if (clusterA === undefined || clusterA !== memberToCluster.get(edge.b)) {
      continue;
    }
    const bucket = intraEdges.get(clusterA);
    if (bucket === undefined) {
      intraEdges.set(clusterA, [edge]);
    } else {
      bucket.push(edge);
    }
  }

  // ── 同刻取数（§0.2.2）──
  const adoptedMemories = countAdoptedMemories(db);
  // ⚠️ **`computation.coveredMemories` 与 `coveredIds.length` 是同一个数**：
  //   连通分量是**划分** ⇒ 每个节点恰在一个簇里 ⇒ 簇成员的去重并集 = 边端点的去重并集。
  const coveredMemories = computation.coveredMemories;
  const seedOnlyMemories = coveredMemories - countAdoptedAmong(db, coveredIds);

  // ── 呈现 ──
  const namesByMemory = loadEntityNamesByMemory(db, coveredIds);
  const stats = computeClusterStats(work, intraEdges, params);
  const views = buildClusterViews(
    stats,
    namesByMemory,
    loadContents(db, collectRepresentativeIds(stats)),
  );
  const filtered = applyDisplayFilters(views, options);

  return {
    largestClusterRatio: computation.largestClusterRatio,
    maxRawComponentRatio: computation.rawComponentShare,
    clusters: filtered.clusters,
    // ★ 现场重算路径：`asOf` = **传入的 `now`**
    asOf: at,
    // ⚠️ **生成时刻 = 本次算完的时刻**（真实时钟）⇒ 与 `asOf` **不是同一个东西**
    computedAt: resolveNow(),
    algoVersion: CLUSTER_ALGO_VERSION,
    // ⚠️ 现场算出来的结果**永远是新鲜的** ⇒ 不可能 stale
    stale: false,
    totalClusters: filtered.totalClusters,
    coveredMemories,
    adoptedMemories,
    totalMemories,
    totalMembers: filtered.totalMembers,
    seedOnlyMemories,
    coverage: totalMemories > 0 ? coveredMemories / totalMemories : 0,
    coverageOverAdopted:
      adoptedMemories > 0 ? (coveredMemories - seedOnlyMemories) / adoptedMemories : 0,
  };
}

/**
 * 收集**代表记忆**的 id（用于取正文做 `label`）。
 *
 * @param stats 簇的统计量
 * @returns 需要正文的记忆 id 列表（**去重**）
 */
function collectRepresentativeIds(stats: readonly ClusterStats[]): string[] {
  return [...new Set(stats.map((item) => item.representativeId))];
}

// ═══════════════════════════════════════════════════════════════════════════
// 七、公开入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **「主题簇机制被关掉」时的空结果**（§5：`coactivation` 关 ⇒「主题簇不计算也不使用」）。
 *
 * ⚠️ **簇相关的一切都是 0 / 空**（簇数、覆盖数、成员数、两个覆盖率、两个占比）
 *   ⇒ 因为「簇」这件事**根本不存在**（不是「存在但为空」）。
 * ⚠️ ★ **`adoptedMemories` / `totalMemories` 仍取真值**（**这是本函数唯一需要斟酌的一处**）：
 *   它们是**库级事实**（`access_count > 0` 的未删记忆数 / 未删记忆数），
 *   **不是簇的事实** ⇒ §6 明写 `clusters().adoptedMemories` 与 `stats().adoptedMemories`
 *   是「同一个数、同一口径、同一实现」⇒ **必须恒等**
 *   ⇒ 这里填 `0` 会**直接破坏那条恒等式**（`stats()` 报真值、`clusters()` 报 0）
 *   ⇒ ⇒ **留真值**（它们**不读簇表** ⇒ 也不违反「不计算也不使用」）。
 *
 * @param db 库句柄（**只读** ⇒ 只数两个库级计数，不碰簇表）
 * @param at 注入时钟（**两条时刻都取它** ⇒ 「没有快照」时不给出假的历史时刻）
 * @returns §6 的 `ClustersResult`（簇相关字段全 0 / 空）
 */
function emptyClustersResult(db: Database.Database, at: number): ClustersResult {
  return {
    largestClusterRatio: 0,
    maxRawComponentRatio: 0,
    clusters: [],
    // ⚠️ **没有快照 ⇒ 这两个时刻都取「本次查询时刻」**（不填 0 ⇒ 0 是「假的历史时刻」）
    asOf: at,
    computedAt: at,
    algoVersion: CLUSTER_ALGO_VERSION,
    stale: false,
    totalClusters: 0,
    coveredMemories: 0,
    adoptedMemories: countAdoptedMemories(db),
    totalMemories: countLiveMemories(db),
    totalMembers: 0,
    seedOnlyMemories: 0,
    coverage: 0,
    coverageOverAdopted: 0,
  };
}

/**
 * `clusters(options?, now?)` —— §6 的**只读导航**接口。
 *
 * ⚠️ ★ **纯读**：不写库、不写 events、不更新 `last_access`（§6 / §7.1 的「7 个允许读的方法」之一）
 *   ⇒ 只读实例上可直接调用。
 *
 * ⚠️ ★ **物化 / 现场重算的分流规则**（§6，按 `minAffinity` 判）：
 * | 情形                                                | 走哪条路       | `asOf`               |
 * | --------------------------------------------------- | -------------- | -------------------- |
 * | `minAffinity` 缺省 / 等于**快照自己记录的**阈值       | **读已发布快照** | 快照的 asOf          |
 * | `minAffinity` 显式给了**别的**值                       | **现场重算**   | 传入的 `now`        |
 * | **还没有发布过任何快照**（`cluster_snapshot_meta` 无行） | **现场重算**   | 传入的 `now`        |
 * ⚠️ **比对的是「快照自己记录的阈值」**（`cluster_snapshot_meta.min_affinity`），
 *   **不是常量 `COACT_AFFINITY_MIN`**——否则「重算换了阈值而快照没换」时，分流会走错路径。
 * ⚠️ **`minSize` / `limit` 不得触发重算**（纯展示侧过滤，在结果上做即可）。
 *
 * ⚠️ **成本**：现场重算路径 = 全表扫 `coacts` + union-find ⇒ **几百毫秒量级的显式调用**，
 *   **不是 recall 的热路径组件**。
 *
 * @param store 库句柄 + 生效参数（**纯读** ⇒ 不含事件写入器）
 * @param options 可选（`minAffinity` / `minSize` / `limit`）
 * @param now 注入时钟（C37）
 * @returns §6 的 `ClustersResult`
 */
export function clusters(
  store: ClusterQueryStore,
  options?: ClustersOptions,
  now?: number,
): ClustersResult {
  const { db, params } = store;
  const at = resolveNow(now);

  // ⚠️ ★ **机制开关 `coactivation`**（§5 机制开关表）：
  //   关 ⇒「**主题簇不计算也不使用**」
  //   ⇒ **不读簇表、不现场重算**（⇒ 连 `coacts` 都不读）⇒ 直接返回空结果。
  //   ⚠️ **它在本方法的最前面**（本方法**纯读** ⇒ 没有只读守卫要挡）
  //   ⇒ 「机制关着还去读簇表」= 白做功 + 给了「簇还在」的错觉。
  if (!resolveFlags(params).coactivation) {
    return emptyClustersResult(db, at);
  }

  const meta = readSnapshotMeta(db);
  const requested = options?.minAffinity;

  // ⚠️ **分流**（§6）：与**快照自己记录的阈值**比，不是与常量比。
  if (meta !== undefined && (requested === undefined || requested === meta.min_affinity)) {
    return buildFromSnapshot(db, params, meta, options, at);
  }
  // ⚠️ **还没有发布过快照** ⇒ 没有快照可读 ⇒ 现场重算（`asOf` = 传入的 `now`）。
  return buildFromLive(db, params, options, at, requested);
}
