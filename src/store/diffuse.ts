/**
 * 激活扩散（联想路）的**编排与合并** —— DESIGN-v2.md §4.7（实体跳）/
 * §4.14（两条腿 + 合并 + 归档口径），对应 DEVELOPMENT-PLAN.md **P3-T04**。
 *
 * ★ **本模块是「扩散」的唯一实现**（与 §4.6 的 `recall.ts` 同一纪律：
 *   「同一个算法不得有两处实现」——两份实现必然漂移，而漂移**极难在实现期被发现**）。
 *
 * ★ ★ **七条硬约束（成段写死，拆开就会写错）**：
 *   ① **驱动顺序**：簇跳**必须从 `coacts` 驱动**，禁止从 `theme_cluster_members` 驱动
 *      （实现见 `src/neuron/clusterhop.ts`；本模块只负责**编排**）。
 *   ② **候选必须收进一个跨循环的累积表**（**不能**直接写在查询返回的对象上）：
 *      「从 `memory_entities` 找出 n」每次都返回**全新的对象**
 *      ⇒ 把 `diffusionScore` 挂在那个对象上，同一条记忆经**不同实体**被访问时拿到的是新对象、
 *      `diffusionScore` 又是 `undefined` ⇒ `?? 0` 把它重置为 0 ⇒ **多路径累加根本没发生**。
 *      ⇒ 本模块用**两张累积表**（实体跳一张、簇跳一张），键都是 `memoryId`。
 *   ③ **预算必须记在「边」上，不能记在「候选节点」上**：
 *      `visited` 的去重判断发生在查库**之后** ⇒ 用 `visited.size` 当预算挡不住它声称要挡的东西
 *      （枢纽实体最容易产生重复遍历，每轮都要先查一次库而 `visited` 一个都不增）
 *      ⇒ 每处理一条边 `scanned += 1`，与去重彻底解耦；`visited` 退化为纯去重集合。
 *   ④ **`diffusionScore` 是累加值，没有 0~1 上界**：
 *      上界 = `MAX_DIFFUSED_VISITS × ACTIVATION_DECAY`（默认 200 × 0.2 = 40）
 *      ⇒ 它**只用于 diffused 内部排序**，**不参与 §4.6 的五项公式**，
 *      **调用方不得当作 0~1 的置信度或概率使用**。
 *   ⑤ **归档口径**：簇跳与实体跳**共用同一套归档口径**；`diffuseArchived: false` 时**两腿都过滤**。
 *      ⚠️ **簇跳是新增的归档例外通道**（v1.0 只有实体跳一条）
 *      ⇒ 必须写明，否则查看器会把簇跳捞出的归档记忆当成漏过滤的 bug。
 *      ⚠️ **过滤发生在两腿合并之后**（§4.14.3 约束⑦）⇒ 两腿的 `layer` 标记口径一致。
 *   ⑥ **两腿合并取 `max`，不累加**（§4.14.4）：
 *      同一条记忆可能两条腿都命中（「既同簇又同实体」）
 *      ⇒ 累加会让它的分数凭空翻倍，而它并不比别的记忆更相关两倍——那只是它被**发现了两条路径**。
 *      ⚠️ 与 §4.6 步骤 2.5 的候选去重是**两处不同的去重**：
 *      步骤 2.5 去的是「同一条记忆被多路召回」（**保留各路原始分，不合并**）；
 *      §4.14 去的是「同一条记忆被两条腿扩散命中」（**合并扩散分，取 max**）。
 *   ⑦ **两条腿共享同一份预算**（§4.14.1）：`MAX_DIFFUSED_VISITS` 是**全局闸门**，
 *      不是各给一份——分开给等于把总上限翻倍，「有界扩散」的承诺就作废了。
 *
 * ⚠️ **两条腿的量级刻意不同（不是 bug）**：
 *   实体跳的单路径 ≤ `ACTIVATION_DECAY`(0.2)；簇跳的单路径 ≤ `CLUSTER_BONUS`(0.4) × `affinity_eff`
 *   ⇒ 合并取 max 时**簇跳在 `affinity_eff > 0.5` 时占优** ⇒ 强同簇关系优先于弱边关系。
 *   ⚠️ **不要把 `CLUSTER_BONUS` 调到 0.2「对齐量纲」**——那会把设计意图改掉。
 *
 * ⚠️ **两腿的腿内合并规则也不同（刻意）**：
 *   · **实体跳**：同一记忆经**不同实体**被访问 ⇒ `diffusionScore` **累加**（§4.7 的核心语义：
 *     「一条记忆能从 3 条不同关联路径被联想起来，确实比只有 1 条路径更相关」）。
 *   · **簇跳**：同一记忆经**不同簇**被访问 ⇒ 取**最强的那条路径**（不累加）
 *     ⇒ 这样簇跳的单条分数恒 ≤ `CLUSTER_BONUS`（「簇跳 ≤ CLUSTER_BONUS(0.4)」那条量级口径）。
 *   ⇒ 两腿的分数因此**可比**，`max` 合并才有意义（§4.14.4）。
 *
 * ⚠️ **本模块只发 `SELECT`**（§4.13.1 硬约束②的同一条纪律）⇒ 召回路径不写库。
 */

import type Database from 'better-sqlite3';

import { type MemoryLayer, edgeWeight, intensity, layerOf } from '../core/decay.js';
import { resolveFlags } from '../core/flags.js';
import type { Params } from '../core/params.js';
import { archiveFilterThreshold, passesIntensityFilter } from '../core/scoring.js';
import { clusterHop } from '../neuron/clusterhop.js';
import type { MemoryKind } from './get.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、对外类型
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 扩散唤起的一条记忆（§6 的 `RecallResult.diffused` 的元素）。
 *
 * ⚠️ **本类型是 `RecallDiffused` 的唯一权威**（C36：同一件事不得有两套词）
 *   ⇒ `src/store/recall.ts` 把它**重导出**为 `RecallDiffused`（对外名字不变）。
 *
 * ⚠️ **`viaEntity` 与 `viaClusterId` 恰有一个有值**（§6）：
 *   「调用方要的是『**沿哪条路**』，不是『它挂了哪些实体』」
 *   ⇒ 实体跳 ⇒ `viaEntity`（**实体名**，不是 id）；簇跳 ⇒ `viaClusterId`。
 */
export interface DiffusedItem {
  /** 记忆 id。 */
  id: string;
  /** 正文。 */
  content: string;
  /**
   * 扩散分（**累加值**）。
   *
   * ⚠️ **没有 0~1 上界**：上界 = `MAX_DIFFUSED_VISITS × ACTIVATION_DECAY`（默认 40）
   *   ⇒ 它**只用于 diffused 内部排序**，**不参与 §4.6 的五项公式**
   *   ⇒ **调用方不得当作置信度或概率使用**。
   */
  diffusionScore: number;
  /** 当前层级（读取时现算；扩散不过滤归档 ⇒ 可能是 `'archived'`）。 */
  layer: MemoryLayer;
  /** 实体跳 ⇒ 触发它的**实体名**（与 `viaClusterId` 二选一）。 */
  viaEntity?: string;
  /** 簇跳 ⇒ 触发它的**簇 id**（与 `viaEntity` 二选一）。 */
  viaClusterId?: string;
  /** 唤起它的种子（topN 命中）id 列表（升序）。 */
  seeds?: string[];
  /** 记忆类型（与 `MemoryView.kind` 同源）。 */
  kind: MemoryKind;
  /** 当前强度（与 `MemoryView.intensity` 同源）。 */
  intensity: number;
  /** 稳定度（天）。 */
  stability: number;
  /** 难度 `0~1`。 */
  difficulty: number;
  /** 置信度 `0~1`。 */
  confidence: number;
  /** 创建时刻（epoch 毫秒）。 */
  createdAt: number;
  /** 来源标识。 */
  source: string | null;
  /** 该条是否有向量。 */
  hasEmbedding: boolean;
}

/** 扩散的入参。 */
export interface DiffuseInput {
  /** 库句柄（**只读**）。 */
  db: Database.Database;
  /** 生效参数（阈值与上限都在这里 ⇒ **必传**）。 */
  params: Params;
  /**
   * 种子（§4.14.2：**种子不额外筛选**）。
   *
   * ⚠️ **种子必须是「抑制前」的 topN**（§4.13.1 硬约束③）：
   *   抑制**只作用于 hits** ⇒ 若种子取抑制后的 hits，抑制就会**间接**改变 diffused
   *   ⇒ 「想不起名字但看到照片就想起来」这条通道（§4.7 的 R-ARCH-DIFF）会被抑制关掉。
   */
  seedIds: readonly string[];
  /** 计算时刻（毫秒，C37）。 */
  now: number;
  /** 扩散是否也过滤归档（默认 `true`；§4.7 规则 R-ARCH-DIFF 的唯一例外通道）。 */
  diffuseArchived: boolean;
}

/** 一次扩散的产物 + 诊断。 */
export interface DiffuseOutcome {
  /** 扩散结果（已排序、已截断、已按归档口径过滤）。 */
  items: DiffusedItem[];
  /** 本次处理的**边数**（两腿合计 ⇒ §4.14.1 的共享预算）。 */
  scanned: number;
  /** 因 `bonus < ACTIVATION_MIN` 而未产出候选的边数。 */
  belowThreshold: number;
  /** 因「种子不带实体」而被跳过的扩散次数。 */
  skippedNoEntity: number;
  /** 是否因预算耗尽而提前停止。 */
  budgetExhausted: boolean;
  /** 真正贡献了扩散结果的种子 id（升序）——事件的 `diffusedSeeds`。 */
  seeds: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、内部 SQL 与行类型
// ═══════════════════════════════════════════════════════════════════════════

/** 种子关联的实体（**按 id 升序** ⇒ 遍历顺序确定）。 */
const SEED_ENTITIES_SQL =
  'SELECT entity_id FROM memory_entities WHERE memory_id = @memoryId ORDER BY entity_id ASC';

/**
 * 实体的 1 跳**出边与入边**（§4.7：「获取 m 关联实体的 1 跳出边与入边 e」）。
 *
 * ⚠️ **两支 `UNION ALL`**：同一对实体之间的多条边（不同 predicate）是**不同的边**
 *   ⇒ 必须都算 ⇒ 选出的列里带 `id` ⇒ 行互不相同 ⇒ `UNION` 也不会误合并。
 * ⚠️ **排除自环**（`subject_id <> object_id`）：自环的「另一端」就是自己
 *   ⇒ 会让种子通过自己的实体再把自己捞回来（一条废边，还白花一格预算）。
 */
const ENTITY_EDGES_SQL = `SELECT id, subject_id, object_id, weight, last_active
  FROM edges WHERE subject_id = @entityId AND subject_id <> object_id
UNION ALL
SELECT id, subject_id, object_id, weight, last_active
  FROM edges WHERE object_id = @entityId AND subject_id <> object_id`;

/**
 * 某个实体关联的**候选记忆**（§4.7：「从 `memory_entities` 找出 neighbor_entity 对应的候选记忆 n」）。
 *
 * ⚠️ **`m.deleted = 0`**（软删过滤）。
 * ⚠️ **顺带取实体名**（`e.name`）：`viaEntity` 要的是**实体名**（§6），
 *   ⇒ 一次 JOIN 就够 ⇒ **零额外查询**（§6 的成本纪律：「不要用 entities（会诱使人做一次批量查询）」）。
 */
const NEIGHBOR_MEMORIES_SQL = `SELECT me.memory_id AS id,
       m.content AS content,
       m.kind AS kind,
       m.stability AS stability,
       m.pin_factor AS pin_factor,
       m.last_access AS last_access,
       m.created_at AS created_at,
       m.difficulty AS difficulty,
       m.confidence AS confidence,
       m.source AS source,
       (m.embedding IS NOT NULL) AS has_embedding,
       e.name AS entity_name
  FROM memory_entities me
  JOIN memories m ON m.id = me.memory_id
  JOIN entities e ON e.id = me.entity_id
 WHERE me.entity_id = @entityId
   AND m.deleted = 0`;

/** 批量取一批记忆的静态列（簇跳的候选只有 id ⇒ 需要在这里补齐）。 */
const MEMORY_ROWS_SQL = `SELECT id,
       content,
       kind,
       stability,
       pin_factor,
       last_access,
       created_at,
       difficulty,
       confidence,
       source,
       (embedding IS NOT NULL) AS has_embedding
  FROM memories
 WHERE id IN (SELECT value FROM json_each(@memoryIds))`;

/** `memories` 行（扩散要用的那些列）。 */
interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  stability: number;
  pin_factor: number;
  last_access: number;
  created_at: number;
  difficulty: number;
  confidence: number;
  source: string | null;
  has_embedding: number;
}

/** `edges` 行（实体跳要用的列）。 */
interface EdgeRow {
  id: string;
  subject_id: string;
  object_id: string;
  weight: number;
  last_active: number;
}

/** 把 `memories.kind` 收窄成 §6 的枚举（脏数据不许静默通过）。 */
function toMemoryKind(value: string): MemoryKind {
  const kinds: readonly string[] = ['fact', 'event', 'preference', 'thought', 'topic'];
  if (!kinds.includes(value)) {
    throw new Error(`memories.kind 的取值不在枚举内：${value}`);
  }
  return value as MemoryKind;
}

/** 批量读一批记忆的静态列。 */
function readMemoryRows(db: Database.Database, ids: readonly string[]): Map<string, MemoryRow> {
  const rows = new Map<string, MemoryRow>();
  const unique = [...new Set(ids)].filter((id) => id !== '');
  if (unique.length === 0) {
    return rows;
  }
  const list = db
    .prepare(MEMORY_ROWS_SQL)
    .all({ memoryIds: JSON.stringify(unique) }) as MemoryRow[];
  for (const row of list) {
    rows.set(row.id, row);
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、两条腿的累积表
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 实体跳的累积表（**一张表，跨全部种子与全部实体**）。
 *
 * ⚠️ **键是 `memoryId`** ⇒ 同一条记忆经**不同实体**被访问时**累加**（约束②）。
 * ⚠️ **`viaEntity` 取「单路径 bonus 最大」的那个实体**（并列时取实体名字典序最小）
 *   ⇒ 「沿哪条路」是确定的、可复现的。
 */
interface EntityLegEntry {
  memory: MemoryRow;
  score: number;
  /** 单路径 bonus 的最大值（决定 `viaEntity`）。 */
  bestBonus: number;
  /** 触发它的实体**名**。 */
  viaEntity: string;
  /** 唤起它的种子 id 集合。 */
  seeds: Set<string>;
}

/** 簇跳的累积表（**腿内取最强路径**，不累加 ⇒ 单条分数恒 ≤ `CLUSTER_BONUS`）。 */
interface ClusterLegEntry {
  memory: MemoryRow;
  score: number;
  /** 触发它的簇 id。 */
  viaClusterId: string;
  /** 唤起它的种子 id 集合。 */
  seeds: Set<string>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、实体跳（§4.7）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 实体跳（§4.7 的伪代码逐条落成）。
 *
 * ⚠️ **预算记在「边」上**（约束③）：每处理一条边 `scanned += 1`，
 *   **与 `visited` 的去重彻底解耦** ⇒ 枢纽实体的重复遍历照样扣预算。
 * ⚠️ **`visited` 的键含 `entityId`** ⇒ 同一条记忆经**不同实体**被访问时**各加一次** `bonus`
 *   （这是**有意为之**：多路径 ⇒ 更相关）。
 *
 * @param input 库 / 参数 / 种子 / 时刻 / 排除集 / 起始预算计数
 * @returns 累积表 + 诊断计数
 */
function runEntityLeg(
  input: DiffuseInput,
  excludeIds: ReadonlySet<string>,
  scannedStart: number,
): {
  table: Map<string, EntityLegEntry>;
  scanned: number;
  belowThreshold: number;
  skippedNoEntity: number;
} {
  const { db, params, now } = input;
  const table = new Map<string, EntityLegEntry>();
  const visited = new Set<string>();
  let scanned = scannedStart;
  let belowThreshold = 0;
  let skippedNoEntity = 0;

  const limit = params.MAX_DIFFUSED_VISITS;
  const seedEntities = db.prepare(SEED_ENTITIES_SQL);
  const entityEdges = db.prepare(ENTITY_EDGES_SQL);
  const neighborMemories = db.prepare(NEIGHBOR_MEMORIES_SQL);

  for (const seedId of input.seedIds) {
    // ── 外层闸门：全局预算耗尽 ⇒ 立即停止（§4.7 伪代码的第一行）──
    if (scanned >= limit) {
      break;
    }
    const entityRows = seedEntities.all({ memoryId: seedId }) as Array<{ entity_id: string }>;
    if (entityRows.length === 0) {
      // ⚠️ **诊断口径**：「因『种子不带实体』而被跳过的扩散次数」。
      skippedNoEntity += 1;
      continue;
    }

    for (const entityRow of entityRows) {
      const entityId = entityRow.entity_id;
      const edges = entityEdges.all({ entityId }) as EdgeRow[];

      for (const edge of edges) {
        // ── 内层闸门：单条记忆的边数可能就超过整个预算（§4.7 伪代码的第二行）──
        if (scanned >= limit) {
          break;
        }
        // ★ **每处理一条边耗一格预算**（与是否产生新候选无关 ⇒ 约束③）
        scanned += 1;

        const neighborEntityId = edge.subject_id === entityId ? edge.object_id : edge.subject_id;
        const rows = neighborMemories.all({ entityId: neighborEntityId }) as Array<
          MemoryRow & { entity_name: string }
        >;

        // ⚠️ **边权衰减**（§4.5）：`edgeWeight(e, now)`；分母用 `INITIAL_EDGE_WEIGHT`
        //   ⇒ 让初始强度映射到满值（`MAX_EDGE_WEIGHT` 仅作上限）。
        const weight = edgeWeight(edge, params, now);
        const bonus = params.ACTIVATION_DECAY * (weight / params.INITIAL_EDGE_WEIGHT);
        if (bonus < params.ACTIVATION_MIN) {
          belowThreshold += 1;
        }

        for (const row of rows) {
          // ⚠️ **排除当前 topN**（§4.7：「n 不在当前 topN 且 n.deleted == 0」）
          if (excludeIds.has(row.id)) {
            continue;
          }
          // ⚠️ **去重键含 entityId** ⇒ 拦住的只是「同一记忆经**同一**实体」的重复。
          //   ⚠️ **分隔符用 NUL 而不是设计稿里的 `:`**：
          //   拼接会让 `('ab','c')` 与 `('a','bc')` 撞成同一个键 ⇒ 两个不同的对被当成一个
          //   ⇒ **静默丢边**。⇒ 与 `src/neuron/coacts.ts` 的 `candidateKey()` 同一处理。
          const key = `${row.id}\u0000${neighborEntityId}`;
          if (visited.has(key)) {
            continue;
          }
          visited.add(key);

          const existing = table.get(row.id);
          if (existing === undefined) {
            table.set(row.id, {
              memory: row,
              score: bonus,
              bestBonus: bonus,
              viaEntity: row.entity_name,
              seeds: new Set<string>([seedId]),
            });
            continue;
          }
          // ★ **累加**（约束②）：多路径 ⇒ 更相关（**不是取最后一次**）。
          existing.score += bonus;
          existing.seeds.add(seedId);
          if (bonus > existing.bestBonus) {
            existing.bestBonus = bonus;
            existing.viaEntity = row.entity_name;
          }
        }
      }
    }
  }

  return { table, scanned, belowThreshold, skippedNoEntity };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、簇跳（§4.14.3，算法在 `src/neuron/clusterhop.ts`）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 簇跳这一腿（**只做累积，不做过滤、不做截断**）。
 *
 * ⚠️ **预算与实体跳共享**（约束⑦）：`scanned` 从实体腿的结果**接着数**。
 * ⚠️ **归档过滤不在这里做**（约束⑤ + §4.14.3 约束⑦）：过滤统一在两腿合并之后。
 */
function runClusterLeg(
  input: DiffuseInput,
  excludeIds: ReadonlySet<string>,
  scannedStart: number,
): {
  table: Map<string, ClusterLegEntry>;
  scanned: number;
  belowThreshold: number;
} {
  const { db, params, now } = input;
  const table = new Map<string, ClusterLegEntry>();
  let belowThreshold = 0;

  const remaining = Math.max(0, params.MAX_DIFFUSED_VISITS - scannedStart);
  const outcome = clusterHop({
    db,
    params,
    seedIds: input.seedIds,
    now,
    budget: remaining,
    excludeIds,
  });

  const memoryRows = readMemoryRows(
    db,
    outcome.candidates.map((candidate) => candidate.memoryId),
  );

  for (const candidate of outcome.candidates) {
    const memory = memoryRows.get(candidate.memoryId);
    if (memory === undefined) {
      // ⚠️ 理论上不可达（簇跳已过滤软删）：但仍必须给一个**有类型**的跳过。
      continue;
    }
    if (candidate.bonus < params.ACTIVATION_MIN) {
      belowThreshold += 1;
    }
    const existing = table.get(candidate.memoryId);
    if (existing === undefined) {
      table.set(candidate.memoryId, {
        memory,
        score: candidate.bonus,
        viaClusterId: candidate.clusterId,
        seeds: new Set<string>([candidate.seedId]),
      });
      continue;
    }
    // ⚠️ **腿内取最强路径**（不累加）⇒ 簇跳的单条分数恒 ≤ `CLUSTER_BONUS`。
    if (candidate.bonus > existing.score) {
      existing.score = candidate.bonus;
      existing.viaClusterId = candidate.clusterId;
    }
    existing.seeds.add(candidate.seedId);
  }

  return { table, scanned: scannedStart + outcome.consumed, belowThreshold };
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、主流程：两腿 → 合并（取 max）→ 阈值 → 归档 → 排序截断
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 扩散（§4.7 + §4.14 的完整编排）。
 *
 * ⚠️ **机制开关**（§5 的 `coactivation`）：关 ⇒ **联想路与簇跳都不执行** ⇒ 恒空。
 *   （v1.0 的实体跳也是「联想路」的一部分 ⇒ 它与簇跳**一起**关掉。）
 * ⚠️ **归档过滤在合并之后**（约束⑤）：两腿的 `layer` 标记口径一致。
 *
 * @param input 种子 / 参数 / 时刻 / 归档口径
 * @returns 扩散结果 + 诊断
 */
export function diffuse(input: DiffuseInput): DiffuseOutcome {
  const { params, now } = input;

  // ── 机制开关（§5）：关 ⇒ 整个联想路不执行 ──
  if (!resolveFlags(params).coactivation) {
    return {
      items: [],
      scanned: 0,
      belowThreshold: 0,
      skippedNoEntity: 0,
      budgetExhausted: false,
      seeds: [],
    };
  }

  const seedIds = [...new Set(input.seedIds)].filter((id) => id !== '');
  if (seedIds.length === 0) {
    return {
      items: [],
      scanned: 0,
      belowThreshold: 0,
      skippedNoEntity: 0,
      budgetExhausted: false,
      seeds: [],
    };
  }

  // ⚠️ **排除集 = 种子本身**（§4.7：「n 不在当前 topN」）
  //   ⇒ 扩散结果**不重复**已经出现在排名里的那些条目。
  const excludeIds = new Set<string>(seedIds);

  // ── 腿 1：实体跳（§4.7）──
  const entityLeg = runEntityLeg(input, excludeIds, 0);

  // ── 腿 2：簇跳（§4.14.3）——**共享同一份预算**（约束⑦）──
  const clusterLeg = runClusterLeg(input, excludeIds, entityLeg.scanned);

  const scanned = clusterLeg.scanned;
  const belowThreshold = entityLeg.belowThreshold + clusterLeg.belowThreshold;
  const budgetExhausted = scanned >= params.MAX_DIFFUSED_VISITS;

  // ── 合并（§4.14.4）：按 `memoryId` 建表，**取 max**（约束⑥）──
  const merged = new Map<
    string,
    {
      memory: MemoryRow;
      entityScore: number | null;
      clusterScore: number | null;
      viaEntity: string | null;
      viaClusterId: string | null;
      seeds: Set<string>;
    }
  >();

  const merge = (
    memoryId: string,
    memory: MemoryRow,
    entityScore: number | null,
    clusterScore: number | null,
    viaEntity: string | null,
    viaClusterId: string | null,
    seeds: Set<string>,
  ): void => {
    const existing = merged.get(memoryId);
    if (existing === undefined) {
      merged.set(memoryId, {
        memory,
        entityScore,
        clusterScore,
        viaEntity,
        viaClusterId,
        seeds: new Set<string>(seeds),
      });
      return;
    }
    // ⚠️ **赋值不是相加**：每条腿的累积表**键唯一** ⇒ 同一条记忆在**同一腿**里只会进来一次
    //   ⇒ 这里只可能是「实体跳已写入、现在补簇跳」或反之 ⇒ **绝不累加**
    //   （累加发生在**腿内**：`runEntityLeg` 的 `existing.score += bonus`）。
    if (entityScore !== null) {
      existing.entityScore = entityScore;
      existing.viaEntity = viaEntity;
    }
    if (clusterScore !== null) {
      existing.clusterScore = clusterScore;
      existing.viaClusterId = viaClusterId;
    }
    for (const seed of seeds) {
      existing.seeds.add(seed);
    }
  };

  for (const [memoryId, entry] of entityLeg.table) {
    merge(memoryId, entry.memory, entry.score, null, entry.viaEntity, null, entry.seeds);
  }
  for (const [memoryId, entry] of clusterLeg.table) {
    merge(memoryId, entry.memory, null, entry.score, null, entry.viaClusterId, entry.seeds);
  }

  // ── 阈值 + 归档过滤（**在合并之后** ⇒ 两腿口径一致）──
  const archiveLine = input.diffuseArchived ? null : archiveFilterThreshold(params, false);
  const selected: Array<{
    memory: MemoryRow;
    score: number;
    viaEntity: string | null;
    viaClusterId: string | null;
    seeds: Set<string>;
    intensityValue: number;
  }> = [];

  for (const entry of merged.values()) {
    // ★ **合并取 max**（约束⑥）：同一条记忆两条腿都命中 ⇒ 取**较高者**（不累加）。
    //   ⚠️ **并列时取实体跳**（腿的固定顺序 ⇒ 结果可复现）。
    const entityScore = entry.entityScore;
    const clusterScore = entry.clusterScore;
    const useEntity =
      entityScore !== null && (clusterScore === null || entityScore >= clusterScore);
    const score = Math.max(entityScore ?? 0, clusterScore ?? 0);

    // ⚠️ **阈值**（§4.7）：`score >= ACTIVATION_MIN`。
    if (score < params.ACTIVATION_MIN) {
      continue;
    }

    const intensityValue = intensity(
      {
        stability: entry.memory.stability,
        pin_factor: entry.memory.pin_factor,
        last_access: entry.memory.last_access,
      },
      now,
    );
    // ⚠️ **归档过滤**（约束⑤）：`diffuseArchived: false` ⇒ 两腿都过滤。
    if (archiveLine !== null && !passesIntensityFilter(intensityValue, archiveLine)) {
      continue;
    }

    selected.push({
      memory: entry.memory,
      score,
      viaEntity: useEntity ? entry.viaEntity : null,
      viaClusterId: useEntity ? null : entry.viaClusterId,
      seeds: entry.seeds,
      intensityValue,
    });
  }

  // ── 排序 + 截断（§4.7：「按 score 降序排序，取前 MAX_DIFFUSED_NODES 条」）──
  // ⚠️ **排序键带 id**：同分者按 id 字典序排 ⇒ 结果可复现。
  selected.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.memory.id < right.memory.id ? -1 : left.memory.id > right.memory.id ? 1 : 0;
  });

  const items: DiffusedItem[] = [];
  const usedSeeds = new Set<string>();
  for (const entry of selected.slice(0, Math.max(0, params.MAX_DIFFUSED_NODES))) {
    const memory = entry.memory;
    const item: DiffusedItem = {
      id: memory.id,
      content: memory.content,
      diffusionScore: entry.score,
      layer: layerOf(entry.intensityValue, params),
      kind: toMemoryKind(memory.kind),
      intensity: entry.intensityValue,
      stability: memory.stability,
      difficulty: memory.difficulty,
      confidence: memory.confidence,
      createdAt: memory.created_at,
      source: memory.source,
      hasEmbedding: memory.has_embedding !== 0,
      seeds: [...entry.seeds].sort(),
    };
    // ⚠️ **恰有一个有值**（§6）：实体跳 ⇒ `viaEntity`；簇跳 ⇒ `viaClusterId`。
    //   ⚠️ 用**条件展开**而不是写 `viaEntity: null`（`exactOptionalPropertyTypes` 下
    //   「显式 undefined」与「不传」是两件事 ⇒ 调用方的 `'viaEntity' in item` 会不同）。
    if (entry.viaEntity !== null) {
      item.viaEntity = entry.viaEntity;
    }
    if (entry.viaClusterId !== null) {
      item.viaClusterId = entry.viaClusterId;
    }
    items.push(item);
    for (const seed of entry.seeds) {
      usedSeeds.add(seed);
    }
  }

  return {
    items,
    scanned,
    belowThreshold,
    skippedNoEntity: entityLeg.skippedNoEntity,
    budgetExhausted,
    seeds: [...usedSeeds].sort(),
  };
}
