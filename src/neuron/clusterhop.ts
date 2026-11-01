/**
 * 簇跳（联想路的第二条腿）—— DESIGN-v2.md §4.14.3（算法）/ §4.14.5（归档口径），
 * 对应 DEVELOPMENT-PLAN.md **P3-T04**。
 *
 * ★ ★ **驱动顺序是硬约束：必须从 `coacts` 驱动，禁止从 `theme_cluster_members` 驱动**（§4.14.3 首段）。
 *   理由：巨型簇在 100 万条库下可达 **50,000 个成员**（§4.12.4 ② 的实测）
 *   ⇒ 从簇成员表驱动 ⇒ 单条种子扫 5 万行；`topN = 5` ⇒ **25 万次索引探测**
 *   ⇒ 而这是**每次 recall 都跑**的热路径 ⇒ 粗估 200~500ms，**直接冲掉 P99 ≤ 200ms 门槛**。
 *   ⚠️ **加 `LIMIT` 救不了** —— LIMIT 作用在 JOIN 之后，外层表照扫不误。
 *   ⇒ 正确形态（成本 **O(度数)**，三个数量级的差）：
 *   ```
 *   ① 种子所属的全部簇
 *      SELECT cluster_id FROM theme_cluster_members WHERE memory_id = @seedId
 *   ② 种子的全部共激活邻居（两个方向）
 *      SELECT memory_b AS nid, affinity, last_active FROM coacts WHERE memory_a = @seedId
 *      UNION ALL
 *      SELECT memory_a AS nid, affinity, last_active FROM coacts WHERE memory_b = @seedId
 *   ③ 应用层：与 ① 的簇集合求交 → 算 affinity_eff → 降序 → 取 CLUSTER_TOPK
 *   ```
 *   ⚠️ ① 与 ③ 都要读 `theme_cluster_members`，但**都是按 `memory_id` 的点查**（`idx_tcm_memory`）
 *   ⇒ 行数是 **O(度数)**，**不是 O(簇大小)** ⇒ 本文件把这两个行数**显式计数**（`memberRowsRead`）
 *   ⇒ 单测可以直接断言「簇有 3000 个成员时，`memberRowsRead` 仍然是常数级」。
 *
 * ★ **七条约束（§4.14.3，成段写死，拆开就会写错）**：
 *   | # | 约束                  | 本实现的落点                                                              |
 *   | - | ------------------- | --------------------------------------------------------------------- |
 *   | 1 | **多簇**              | `CLUSTER_SEED_CLUSTERS_SQL` 取**全部**行（不是 `LIMIT 1`）              |
 *   | 2 | **软删过滤**            | ② 的两支都 `JOIN memories ... AND m.deleted = 0`                      |
 *   | 3 | **双向 JOIN**         | 两支 `UNION ALL`；互斥性依赖 `CHECK (memory_a < memory_b)`             |
 *   | 4 | **种子无簇 ⇒ 跳过簇跳** | `seedClusters` 为空 ⇒ `continue`（不是报错、不是特殊分支）                |
 *   | 5 | **affinity_eff 钳制** | 复用 `effectiveAffinity()`（§4.11.3 原则 3 的**全库唯一一份**）        |
 *   | 6 | **截断位置**            | **每条种子各取 `CLUSTER_TOPK`**（不是全局取前 N）                        |
 *   | 7 | **归档过滤时序**          | 归档过滤**不在本文件**做（统一在两腿合并之后，`src/store/diffuse.ts`） |
 *
 * ⚠️ **`UNION ALL` 的互斥性完全依赖 `CHECK (memory_a < memory_b)`**（§4.14.3 约束③）：
 *   支① 要求 `seed < nbr`、支② 要求 `nbr < seed` ⇒ 互斥且完备 ⇒ 同一对**只计一次**。
 *   ⚠️ **若将来放宽该 CHECK，必须从 `UNION ALL` 改回 `UNION`**，否则同一对被计两次。
 *
 * ⚠️ **簇跳与实体跳共用同一套归档口径**（§4.14.5）：
 *   `diffuseArchived: false` 时**两腿都过滤**。
 *   ⚠️ **簇跳是新增的归档例外通道**（v1.0 只有实体跳一条）——
 *   必须写明，否则查看器会把簇跳捞出的归档记忆当成漏过滤的 bug。
 *
 * ⚠️ **本模块只发 `SELECT`**（§4.13.1 硬约束②的同一条纪律：召回路径不写库）。
 */

import type Database from 'better-sqlite3';

import type { Params } from '../core/params.js';
import { effectiveAffinity } from './cluster.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、SQL（**逐条导出** ⇒ 单测可以对它们跑 `EXPLAIN QUERY PLAN`）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ① 种子所属的**全部**簇（§4.14.3 ①）。
 *
 * ⚠️ **必须取全部行**（约束①「多簇」）：一条记忆可能同时属于两个簇
 *   （连通分量是互斥的，但**衰减后**的边会分裂，同一记忆可能短暂属于两个簇）
 *   ⇒ 单数写法（`LIMIT 1`）会漏掉第二个簇的全部邻居。
 *
 * ⚠️ **走 `idx_tcm_memory` 点查**（不是扫簇成员表）⇒ 行数是 O(种子数)，不是 O(簇大小)。
 */
export const CLUSTER_SEED_CLUSTERS_SQL =
  'SELECT cluster_id FROM theme_cluster_members WHERE memory_id = @seedId';

/**
 * ② 种子的**全部**共激活邻居（两个方向，§4.14.3 ②）。
 *
 * ⚠️ **两支 `UNION ALL`**（约束③）：互斥且完备**完全依赖** `CHECK (memory_a < memory_b)`。
 * ⚠️ **两支都 `JOIN memories` 并过滤 `deleted = 0`**（约束②「软删过滤」）：
 *   软删记忆**保留**共激活边（restore 后要能回到原状），但**不参与簇跳**。
 * ⚠️ **只 SELECT 用得上的列**（不是 `c.*`）。
 */
export const CLUSTER_NEIGHBOR_COACTS_SQL = `SELECT c.memory_b AS neighbor_id, c.affinity AS affinity, c.last_active AS last_active
  FROM coacts c JOIN memories m ON m.id = c.memory_b
 WHERE c.memory_a = @seedId AND m.deleted = 0
UNION ALL
SELECT c.memory_a AS neighbor_id, c.affinity AS affinity, c.last_active AS last_active
  FROM coacts c JOIN memories m ON m.id = c.memory_a
 WHERE c.memory_b = @seedId AND m.deleted = 0`;

/**
 * ③ 邻居所属的**全部**簇（§4.14.3 ③ 的求交用）。
 *
 * ⚠️ **按 `memory_id IN (json_each(...))` 批量点查**（不是「按 cluster_id 扫成员表」）：
 *   `idx_tcm_memory` 上是 O(度数) 次索引探测 ⇒ **与簇大小无关**。
 * ⚠️ **用 `json_each` 展开 id 列表**（与 `src/neuron/inhibit.ts` 同一处理）：
 *   展开成一串 `?` 会撞 SQLite 的绑定变量上限（历史上 999）⇒ 邻居一多就是运行时炸裂，
 *   而且**炸的时刻取决于库的大小**（最难查的一类故障）。
 */
export const CLUSTER_NEIGHBOR_MEMBERSHIPS_SQL = `SELECT memory_id, cluster_id
  FROM theme_cluster_members
 WHERE memory_id IN (SELECT value FROM json_each(@memoryIds))`;

// ═══════════════════════════════════════════════════════════════════════════
// 二、类型
// ═══════════════════════════════════════════════════════════════════════════

/** 一条簇跳候选（**一条路径**，不是一个记忆）。 */
export interface ClusterHopCandidate {
  /** 候选记忆 id（邻居）。 */
  memoryId: string;
  /** 触发它的簇 id（种子与邻居的**公共簇**）。 */
  clusterId: string;
  /** 触发它的种子 id。 */
  seedId: string;
  /** 有效亲和度（衰减后，§4.14.3 约束⑤）。 */
  affinityEff: number;
  /** 本次的加成（= `CLUSTER_BONUS × affinityEff`）。 */
  bonus: number;
}

/** 簇跳的入参。 */
export interface ClusterHopInput {
  /** 库句柄（**只读**）。 */
  db: Database.Database;
  /** 生效参数（`CLUSTER_TOPK` / `CLUSTER_BONUS` / `COACT_*` 都可调 ⇒ **必传**）。 */
  params: Params;
  /** 种子（§4.14.2：种子不额外筛选）。 */
  seedIds: readonly string[];
  /** 计算时刻（毫秒，C37）。 */
  now: number;
  /**
   * **剩余预算**（本次最多可处理的 `coacts` 行数）。
   *
   * ⚠️ **由调用方持有唯一的预算计数器**（§4.14.1：两条腿**共享**同一份预算）
   *   ⇒ 本模块**不自己记账**，只把「本次消耗了几格」如实返回 ⇒ 调用方加到总数上。
   */
  budget: number;
  /**
   * 需要排除的记忆 id（种子本身等）。
   *
   * ⚠️ **排除发生在取 topK 之前** ⇒ 排除掉的不占用 `CLUSTER_TOPK` 的名额
   *   （否则「topK 里有一条是种子」⇒ 少产出一条，白白浪费名额）。
   */
  excludeIds?: ReadonlySet<string>;
}

/** 簇跳的产物（含**可观测的行数计数器**——这是「不由簇成员表驱动」的结构性证据）。 */
export interface ClusterHopOutcome {
  /** 候选（**已按每种子的 `CLUSTER_TOPK` 截断**，且已按 `affinityEff` 降序排好）。 */
  candidates: ClusterHopCandidate[];
  /** 本次处理的 `coacts` 行数（= 消耗的预算格数）。 */
  consumed: number;
  /** **没有簇**而跳过簇跳的种子数（约束④）。 */
  skippedNoCluster: number;
  /** 读过的 `theme_cluster_members` 行数（**诊断**：证明它与簇大小无关）。 */
  memberRowsRead: number;
  /** 读过的 `coacts` 行数（**诊断**：它才是驱动源）。 */
  coactsRowsRead: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、算法
// ═══════════════════════════════════════════════════════════════════════════

/** `coacts` 的一行（簇跳要用的三个字段）。 */
interface CoactNeighborRow {
  neighbor_id: string;
  affinity: number;
  last_active: number;
}

/** 读一个种子的全部簇（①）。 */
function readSeedClusters(db: Database.Database, seedId: string): string[] {
  const rows = db.prepare(CLUSTER_SEED_CLUSTERS_SQL).all({ seedId }) as Array<{
    cluster_id: string;
  }>;
  return rows.map((row) => row.cluster_id);
}

/** 读一个种子的全部共激活邻居（②，两个方向）。 */
function readSeedNeighbors(db: Database.Database, seedId: string): CoactNeighborRow[] {
  return db.prepare(CLUSTER_NEIGHBOR_COACTS_SQL).all({ seedId }) as CoactNeighborRow[];
}

/** 读一批邻居各自的簇（③）。 */
function readNeighborMemberships(
  db: Database.Database,
  memoryIds: readonly string[],
): Map<string, string[]> {
  const memberships = new Map<string, string[]>();
  if (memoryIds.length === 0) {
    return memberships;
  }
  const rows = db
    .prepare(CLUSTER_NEIGHBOR_MEMBERSHIPS_SQL)
    .all({ memoryIds: JSON.stringify(memoryIds) }) as Array<{
    memory_id: string;
    cluster_id: string;
  }>;
  for (const row of rows) {
    const bucket = memberships.get(row.memory_id);
    if (bucket === undefined) {
      memberships.set(row.memory_id, [row.cluster_id]);
    } else {
      bucket.push(row.cluster_id);
    }
  }
  return memberships;
}

/**
 * 簇跳（§4.14.3 的完整算法）。
 *
 * ⚠️ **本函数不写库**（只发 `SELECT`）⇒ 召回路径不产生任何副作用。
 * ⚠️ **本函数不做归档过滤**（约束⑦：归档过滤统一在两腿合并之后做）
 *   ⇒ 这样两腿的 `layer` 标记口径一致，不会出现「一条腿过滤了、另一腿没过滤」。
 *
 * @param input 种子 / 参数 / 时刻 / 剩余预算
 * @returns 候选 + 行数计数器 + 消耗的预算格数
 */
export function clusterHop(input: ClusterHopInput): ClusterHopOutcome {
  const { db, params, now } = input;
  const excludeIds = input.excludeIds ?? new Set<string>();

  const candidates: ClusterHopCandidate[] = [];
  let consumed = 0;
  let skippedNoCluster = 0;
  let memberRowsRead = 0;
  let coactsRowsRead = 0;

  for (const seedId of input.seedIds) {
    // ⚠️ **外层的预算闸门**（§4.7 的 `if (scanned >= MAX) break`）：
    //   预算耗尽 ⇒ **不再取下一条种子的邻居**（连一次查询都不做）。
    if (consumed >= input.budget) {
      break;
    }
    // ── ① 种子所属的全部簇（约束①「多簇」：取**全部**行）──
    const seedClusters = readSeedClusters(db, seedId);
    memberRowsRead += seedClusters.length;
    // ── 约束④：种子无簇 ⇒ 跳过簇跳（不是报错、不是特殊分支）──
    if (seedClusters.length === 0) {
      skippedNoCluster += 1;
      continue;
    }
    const seedClusterSet = new Set(seedClusters);

    // ── ② 种子的全部共激活邻居（两个方向）──
    // ⚠️ **预算在这里逐行扣**（§4.7 的「预算记在边上」纪律对簇跳同样成立）：
    //   簇跳处理的「边」就是 `coacts` 的行 ⇒ 它与实体跳**共享同一个预算计数器**。
    const neighborRows = readSeedNeighbors(db, seedId);
    coactsRowsRead += neighborRows.length;
    const usableRows: CoactNeighborRow[] = [];
    for (const row of neighborRows) {
      if (consumed >= input.budget) {
        break;
      }
      consumed += 1;
      usableRows.push(row);
    }
    if (usableRows.length === 0) {
      continue;
    }

    // ── ③ 应用层求交：邻居的簇 ∩ 种子的簇 ──
    const neighborIds = [...new Set(usableRows.map((row) => row.neighbor_id))];
    const memberships = readNeighborMemberships(db, neighborIds);
    for (const clusterIds of memberships.values()) {
      memberRowsRead += clusterIds.length;
    }

    // ⚠️ **同一条邻居在两个公共簇里 ⇒ 只保留一条候选**（约束⑥：取的是「其他**成员**」）
    //   ⇒ 分保留 `affinityEff` 最大的那个公共簇作为 `viaClusterId`。
    const bestByNeighbor = new Map<string, ClusterHopCandidate>();
    for (const row of usableRows) {
      if (excludeIds.has(row.neighbor_id)) {
        continue;
      }
      const neighborClusters = memberships.get(row.neighbor_id);
      if (neighborClusters === undefined) {
        continue;
      }
      const affinityEff = effectiveAffinity(row.affinity, row.last_active, now, params);
      for (const clusterId of neighborClusters) {
        if (!seedClusterSet.has(clusterId)) {
          continue;
        }
        const candidate: ClusterHopCandidate = {
          memoryId: row.neighbor_id,
          clusterId,
          seedId,
          affinityEff,
          bonus: params.CLUSTER_BONUS * affinityEff,
        };
        const existing = bestByNeighbor.get(row.neighbor_id);
        if (existing === undefined || candidate.affinityEff > existing.affinityEff) {
          bestByNeighbor.set(row.neighbor_id, candidate);
        }
      }
    }

    // ── 约束⑥：截断位置 = **每条种子各取 `CLUSTER_TOPK`**（不是全局取前 N）──
    const ordered = [...bestByNeighbor.values()].sort((left, right) => {
      if (right.affinityEff !== left.affinityEff) {
        return right.affinityEff - left.affinityEff;
      }
      if (left.memoryId !== right.memoryId) {
        return left.memoryId < right.memoryId ? -1 : 1;
      }
      return left.clusterId < right.clusterId ? -1 : left.clusterId > right.clusterId ? 1 : 0;
    });
    for (const candidate of ordered.slice(0, Math.max(0, params.CLUSTER_TOPK))) {
      candidates.push(candidate);
    }
  }

  return { candidates, consumed, skippedNoCluster, memberRowsRead, coactsRowsRead };
}
