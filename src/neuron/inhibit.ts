/**
 * 侧抑制：三桶算法（R / D / O）与逐对判据 —— DESIGN-v2.md §4.13
 * （对应 DEVELOPMENT-PLAN.md **P3-T02**）。
 *
 * ★ **三条硬约束（§4.13.1）—— 本模块的结构必须让它们「不可能违反」**：
 *   ① **抑制不进 score**：本模块**只读**候选的 `score`（从不改它），
 *     也不引入第二个分 ⇒ `Hit.score` 恒等于五项加权和、`Hit.score === Hit.rankScore`。
 *     「谁挤掉了谁、冗余度多少」是 `inhibitionTrace` 的**诊断输出**，不进 `Hit.breakdown`。
 *   ② **抑制不写库**：本模块只发 `SELECT`（实体集合 + 向量两条批量查询）⇒
 *     抑制前后 `memories` 表哈希完全相同。
 *   ③ **抑制只作用于 hits，不作用于 diffused**（由调用方保证：本模块只处理候选集 C）。
 *
 * ★ **判据是纯逐对（§4.13.2），不用分组、不用簇、不用传递闭包**：
 *   ```
 *   isRedundant(A, B) =
 *       (双方都有 embedding 且 cos(A,B) ≥ REDUNDANCY_COS)   ← 语义路径
 *       OR (|E(A) ∩ E(B)| ≥ DEDUP_ENTITY_MIN)               ← 实体路径，**始终可用**
 *   ```
 *   ⚠️ **为什么用「实体交集」而不是「簇成员关系」**（设计点名的判断）：
 *     ① 它是**事实级**的（共享 ≥ 2 实体的两条记忆大概率讲同一件事），
 *        而「同簇」只保证「相关」⇒ 用簇判事实冗余会误杀「张三住上海 / 张三喜欢猫」；
 *     ② **复用 §4.9 步骤 3c 的同一谓词** ⇒ 写入侧认为「同一事实」的，
 *        召回侧也认为「冗余」⇒ 两个口径不会打架；
 *     ③ **不依赖 embedding** ⇒ `embeddedRatio = 0` 时侧抑制**仍然工作**。
 *   ⚠️ **本版刻意不做词面（bigram Jaccard）冗余判定**：
 *     「她**不**喜欢猫粮」与「她喜欢猫粮」bigram 高度重合但语义**相反**；
 *     实测「否定翻转」落在 [0.200, 0.400]、「同义改写」落在 [0.143, 0.444]
 *     ⇒ **不存在任何阈值 T 能同时抓住前者且放过后者**
 *     ⇒ 词面相似**只用于写入去重**（§4.9），**不用于召回侧抑制**。
 *
 * ★ **三桶模型（§4.13.3）—— 三个桶必须分开，这是实现最容易错的一处**：
 *   ```
 *   R = 异质代表集（进 hits）
 *   D = 冗余池（确实冗余 → 进 suppressed，有合法的 redundantWith）
 *   O = 溢出桶（因 R 已满而【未参与评估】→ **没有**合法的 redundantWith）
 *   ```
 *   ⚠️ 把 O 混进 D ⇒ 「**根本没参与评估**的候选」被误标成「被挤掉的」
 *     ⇒ 它们的 `redundantWith` 是**假的**（没跟谁比过）⇒ **标注是假的**。
 *
 * ⚠️ **抑制从不做传递闭包**（§4.13.2 的量化依据）：
 *   连通性 ≠ 同质性（`A~B, B~C, A≁C` 是**链**不是**团**）⇒
 *   「巨型簇会让抑制退化成整个库只留 1 条」这个顾虑**在结构上不成立**。
 */

import type Database from 'better-sqlite3';

import type { Params } from '../core/params.js';
import { cosineOf } from '../store/dedupCandidates.js';
import { blobToVector } from '../vector/centroids.js';

/**
 * 一条候选在抑制判定里需要的全部事实（**纯数据**，不含 IO）。
 *
 * ⚠️ **只有 `id` 与 `score` 是「候选本身」的属性**；
 *   `vector` 与 `entityIds` 是**判据需要的证据**（由 `loadInhibitionFacts()` 一次性批量取回）。
 */
export interface InhibitionCandidate {
  /** 候选 id。 */
  id: string;
  /** 该候选的融合总分（§4.6 步骤 3 的五因子加权和）——**本模块只读它，绝不改它**。 */
  score: number;
  /** 该候选的向量（`null` = 没有向量 ⇒ 语义路径不可用）。 */
  vector: Float32Array | null;
  /** 该候选挂着的实体 id 集合（**始终可用**，不依赖 embedding）。 */
  entityIds: Set<string>;
}

/**
 * 一对候选的**冗余证据**（判据的输入）。
 *
 * ⚠️ **两个分量各自独立**（§4.13.2）：
 *   `cosine` 为 `null` 表示「**没有余弦这个事实**」（双方缺向量 / 维度不一致）
 *   —— **不是 0**（0 会被误读成「余弦算出来是 0」）。
 */
export interface RedundancyEvidence {
  /** 该对的余弦（`null` = 不可比）。 */
  cosine: number | null;
  /** 该对共享的实体数。 */
  sharedEntities: number;
}

/** D 桶里的一条（**确实冗余** ⇒ 有合法的 `redundantWith`）。 */
export interface InhibitionRedundant {
  /** 被挤掉的候选。 */
  candidate: InhibitionCandidate;
  /** 挤掉它的那条（**留在 R 桶里的**）。 */
  redundantWith: string;
  /** 该对的余弦（`null` = 双方不可比 ⇒ 没有可比的相似度）。 */
  redundancySim: number | null;
}

/** 三桶算法的结果。 */
export interface InhibitionOutcome {
  /** R 桶：异质代表集（进 hits），**已按 `(score DESC, id ASC)` 全序排好**。 */
  kept: InhibitionCandidate[];
  /** D 桶：冗余池（进 suppressed）。 */
  redundant: InhibitionRedundant[];
  /** O 桶：溢出候选（**两者都不进**）。 */
  overflow: InhibitionCandidate[];
  /** 前置判定的取值（池级，**与遍历顺序无关**）——诊断用。 */
  poolHomogeneous: boolean;
}

// ─────────────────────────── 判据 ───────────────────────────

/**
 * 冗余判据（§4.13.2，**纯函数**）。
 *
 * ⚠️ **两条路径各自独立成立**：
 *   语义路径要求**双方都有向量**；实体路径**不依赖向量** ⇒
 *   `embeddedRatio = 0` 的库里侧抑制**仍然工作**（第五概念在最需要它的场景里整个不工作
 *   是设计明令禁止的失败模式）。
 *
 * @param evidence 该对的冗余证据
 * @param params 生效参数（`REDUNDANCY_COS` / `DEDUP_ENTITY_MIN`）
 * @returns 是否冗余
 */
export function isRedundant(evidence: RedundancyEvidence, params: Params): boolean {
  // ⚠️ **语义路径**：`cosine !== null` 是「有这条证据」的前提 ⇒ 缺向量时**不参与**，而不是「余弦为 0」。
  if (evidence.cosine !== null && evidence.cosine >= params.REDUNDANCY_COS) {
    return true;
  }
  // ⚠️ **实体路径**：始终可用（复用 §4.9 步骤 3c 的同一谓词）。
  return evidence.sharedEntities >= params.DEDUP_ENTITY_MIN;
}

/** 一对候选的余弦（`null` = 不可比：缺向量 / 维度不一致 / 零向量）。 */
export function cosineBetween(
  left: InhibitionCandidate,
  right: InhibitionCandidate,
): number | null {
  if (left.vector === null || right.vector === null) {
    return null;
  }
  // ⚠️ **复用全库唯一的余弦实现**（C36：同一件事不得有两套实现）。
  return cosineOf(left.vector, right.vector);
}

/** 一对候选共享的实体数。 */
export function sharedEntityCount(left: InhibitionCandidate, right: InhibitionCandidate): number {
  // ⚠️ **遍历小的那一边**（交集的代价取决于小集的大小）。
  const [small, large] =
    left.entityIds.size <= right.entityIds.size
      ? [left.entityIds, right.entityIds]
      : [right.entityIds, left.entityIds];
  let count = 0;
  for (const entityId of small) {
    if (large.has(entityId)) {
      count += 1;
    }
  }
  return count;
}

/** 一对候选的冗余证据（两条路径的原始输入）。 */
export function redundancyEvidence(
  left: InhibitionCandidate,
  right: InhibitionCandidate,
): RedundancyEvidence {
  return {
    cosine: cosineBetween(left, right),
    sharedEntities: sharedEntityCount(left, right),
  };
}

// ─────────────────────────── 全序与三桶算法 ───────────────────────────

/**
 * 候选的全序比较（`(score DESC, id ASC)`）。
 *
 * ⚠️ **排序键必须带 id**（§4.6 步骤 4.5 / §4.13.3）：
 *   score 相同者按 id 字典序排。不加这条，抑制边界会随 SQLite 的返回顺序漂移
 *   ⇒「同一查询两次结果不同」，且**无法复现**。
 */
export function compareInhibitionCandidates(
  left: InhibitionCandidate,
  right: InhibitionCandidate,
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 三桶算法（§4.13.3，**纯函数**：不碰数据库、不改 score）。
 *
 * ```
 * poolHomogeneous = 「候选集里除最高分那条 C0 外，是否每一条都与 C0 冗余」
 *   ⚠️ 进入遍历前算一次并固定（不能随 R 的增长而重算 ⇒ 否则行为依赖遍历顺序）
 *   ⚠️ C0 不与自己比（「C0 与 C0」**不是恒为真**：它为真当且仅当 C0 自己就冗余
 *     —— 它有向量 ⇒ cos = 1；或它挂了 ≥ DEDUP_ENTITY_MIN 个实体）
 *     ⇒ 把自己算进去只是给那个合取式**多加一项** ⇒ 不会让 poolHomogeneous **永远**为真
 *     ⇒ 两种写法只差一个角落：「池里只有 C0 一条、而 C0 自己不冗余」时，含自己的写法会翻成假
 *       （那一条的语义是「没有替代品 ⇒ 不抑制」⇒ 本实现按「不与自己比」写）
 *   ⚠️ |C| = 0 时恒为真，但遍历不执行 ⇒ hits = [] ⇒ 不变式仍成立
 *
 * for c of C（按 (score DESC, id ASC) 全序）:
 *   if R.length >= topN:  O.push(c); continue    ← 停止评估，不再判冗余
 *   if poolHomogeneous:    R.push(c); continue    ← 整池同质：全部让位（无替代品）
 *   if ∃ r ∈ R 使 isRedundant(c, r):  D.push(c)   ← 冗余：让位给已保留的
 *   else:                            R.push(c)   ← 异质：进 R
 * ```
 *
 * ⚠️ **不做全局补位**（§4.6 步骤 4.5 ④）：
 *   补位会把刚挤掉的近义内容又塞回上下文 ⇒ **抑制的目的被自己抵消**。
 *
 * @param candidates 步骤 3 打分后的**完整**候选集（未截断）
 * @param topN 名额上限（§6 的 `topN`，内部已钳制到 1~8）
 * @param params 生效参数
 * @returns 三个桶
 */
export function inhibitCandidates(
  candidates: readonly InhibitionCandidate[],
  topN: number,
  params: Params,
): InhibitionOutcome {
  const ordered = [...candidates].sort(compareInhibitionCandidates);

  // ── 前置判定（池级，**进入遍历前算一次并固定**）──
  const c0 = ordered[0];
  const poolHomogeneous =
    c0 === undefined
      ? // ⚠️ |C| = 0 ⇒ 恒为真（无候选可判）；此时遍历不执行 ⇒ hits = [] ⇒ 不变式仍成立。
        true
      : // ⚠️ **C0 不与自己比** ⇒ 判断对象是「其余候选 c 与 C0 是否冗余」
        //   （「C0 与 C0」不是恒为真 ⇒ 把自己算进去只会给合取式多加一项 ⇒ 见函数头的说明）。
        ordered
          .slice(1)
          .every((candidate) => isRedundant(redundancyEvidence(candidate, c0), params));

  const kept: InhibitionCandidate[] = [];
  const redundant: InhibitionRedundant[] = [];
  const overflow: InhibitionCandidate[] = [];

  for (const candidate of ordered) {
    if (kept.length >= topN) {
      // ⚠️ **停止评估，不再判冗余** ⇒ 溢出候选**没有**合法的 `redundantWith`。
      overflow.push(candidate);
      continue;
    }
    if (poolHomogeneous) {
      // ⚠️ **整池同质 ⇒ 全部让位**（没有替代品 ⇒ 抑制只会让结果变少而不变得更好）。
      kept.push(candidate);
      continue;
    }
    // ⚠️ **与已保留集 R 中的某条冗余** ⇒ 进 D 桶（让位给已保留的）。
    //   `find` 命中的第一条即**分数最高**的那条（R 桶本身按分数降序）⇒ 语义最自然。
    const match = kept.find((retained) =>
      isRedundant(redundancyEvidence(candidate, retained), params),
    );
    if (match === undefined) {
      kept.push(candidate);
      continue;
    }
    redundant.push({
      candidate,
      redundantWith: match.id,
      redundancySim: cosineBetween(candidate, match),
    });
  }

  return { kept, redundant, overflow, poolHomogeneous };
}

// ─────────────────────────── 证据的批量取回（只读） ───────────────────────────

/**
 * 取一批记忆的**实体集合**的 SQL（**一次批量查询**）。
 *
 * ⚠️ **用 `json_each` 展开 id 列表**（与 `src/core/scoring.ts` 的 `GRAPH_PROXIMITY_SQL` 同一处理）：
 *   展开成一串 `?` 会撞 SQLite 的绑定变量上限（历史上 999）⇒ 实体一多就是运行时炸裂。
 * ⚠️ **只读**：本模块不发任何写语句（§4.13.1 硬约束②）。
 */
export const MEMORY_ENTITY_SETS_SQL =
  'SELECT memory_id, entity_id FROM memory_entities WHERE memory_id IN (SELECT value FROM json_each(?))';

/**
 * 取一批记忆的**向量**的 SQL（**一次批量查询**）。
 *
 * ⚠️ **只要有向量的行**：`embedding IS NULL` 的记忆**照样能靠实体路径判冗余**
 *   （§4.13.2 的路径④：实体路径不依赖 embedding）。
 */
export const MEMORY_VECTORS_SQL =
  'SELECT id, embedding FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND embedding IS NOT NULL';

/**
 * 取一批记忆的实体集合（`memoryId → entity_id 集合`）。
 *
 * @param db 数据库句柄
 * @param memoryIds 候选记忆 id（可重复，内部去重）
 * @returns 每个有实体的记忆 id ⇒ 它的实体集合
 */
export function loadEntitySets(
  db: Database.Database,
  memoryIds: readonly string[],
): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  const ids = [...new Set(memoryIds)].filter((id) => id !== '');
  if (ids.length === 0) {
    return sets;
  }
  const rows = db.prepare(MEMORY_ENTITY_SETS_SQL).all(JSON.stringify(ids)) as Array<{
    memory_id: string;
    entity_id: string;
  }>;
  for (const row of rows) {
    let bucket = sets.get(row.memory_id);
    if (bucket === undefined) {
      bucket = new Set<string>();
      sets.set(row.memory_id, bucket);
    }
    bucket.add(row.entity_id);
  }
  return sets;
}

/**
 * 取一批记忆的向量（`memoryId → 向量`；**没有向量的记忆不在结果里**）。
 *
 * @param db 数据库句柄
 * @param memoryIds 候选记忆 id（可重复，内部去重）
 * @returns 每个有向量的记忆 id ⇒ 它的向量
 */
export function loadVectors(
  db: Database.Database,
  memoryIds: readonly string[],
): Map<string, Float32Array> {
  const vectors = new Map<string, Float32Array>();
  const ids = [...new Set(memoryIds)].filter((id) => id !== '');
  if (ids.length === 0) {
    return vectors;
  }
  const rows = db.prepare(MEMORY_VECTORS_SQL).all(JSON.stringify(ids)) as Array<{
    id: string;
    embedding: Buffer;
  }>;
  for (const row of rows) {
    vectors.set(row.id, blobToVector(row.embedding));
  }
  return vectors;
}

/**
 * 给一批候选补齐抑制判定需要的**事实**（向量 + 实体集合）。
 *
 * ⚠️ **两条批量查询，不是 `O(候选数²)` 次 IO**：
 *   实体集合一条、向量一条 ⇒ 与候选数成正比的**行数**，**查询条数是常数**。
 * ⚠️ **只读**（§4.13.1 硬约束②）。
 *
 * @param db 数据库句柄
 * @param candidates 步骤 3 的候选（`id` + `score`）
 * @returns 补齐事实后的候选（**顺序与入参一致**）
 */
export function loadInhibitionFacts(
  db: Database.Database,
  candidates: ReadonlyArray<{ id: string; score: number }>,
): InhibitionCandidate[] {
  const memoryIds = candidates.map((candidate) => candidate.id);
  const entitySets = loadEntitySets(db, memoryIds);
  const vectors = loadVectors(db, memoryIds);
  return candidates.map((candidate) => ({
    id: candidate.id,
    score: candidate.score,
    vector: vectors.get(candidate.id) ?? null,
    entityIds: entitySets.get(candidate.id) ?? new Set<string>(),
  }));
}

/**
 * 取一批记忆的**主题簇 id**（诊断上下文，**不参与判定**）。
 *
 * ⚠️ **簇不参与抑制判定**（§4.13.2）：判据是纯逐对的（余弦 OR 实体交集）
 *   ⇒ 即使某条记忆真的在某个簇里，**也不会**因此被判冗余。
 *   ⇒ 本函数只给 `inhibitionTrace` 提供「上下文」这一个用途。
 * ⚠️ **一条记忆可能同时属于多个簇**（簇快照是某一时刻的划分）⇒ 取**字典序最小**的簇 id
 *   ⇒ 结果可复现（不依赖数据库返回顺序）。
 *
 * @param db 数据库句柄
 * @param memoryIds 候选记忆 id
 * @returns `memoryId → clusterId`（没有簇的记忆不在结果里）
 */
export function loadClusterIds(
  db: Database.Database,
  memoryIds: readonly string[],
): Map<string, string> {
  const clusters = new Map<string, string>();
  const ids = [...new Set(memoryIds)].filter((id) => id !== '');
  if (ids.length === 0) {
    return clusters;
  }
  const rows = db
    .prepare(
      'SELECT memory_id, cluster_id FROM theme_cluster_members WHERE memory_id IN (SELECT value FROM json_each(?))',
    )
    .all(JSON.stringify(ids)) as Array<{ memory_id: string; cluster_id: string }>;
  for (const row of rows) {
    const existing = clusters.get(row.memory_id);
    if (existing === undefined || row.cluster_id < existing) {
      clusters.set(row.memory_id, row.cluster_id);
    }
  }
  return clusters;
}
