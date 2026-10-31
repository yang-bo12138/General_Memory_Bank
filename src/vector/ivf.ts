/**
 * 两级 k-means 分桶后端（IVF） —— P2-T02
 * （DESIGN-v2.md §4.15.3 / §4.6 步骤 0 / DEVELOPMENT-PLAN.md P2-T02）。
 *
 * ⚠️ **本模块是 P2 的第二块砖**：P2-T01 定的 `VectorBackend` 契约**一字不改**，
 *   本模块只补上它的**第二个实现**（第一个是 flat 基线）⇒ 契约的可插拔性在此得到兑现。
 *
 * ⚠️ **分桶是「精确检索」，不是近似召回**（§4.15.3 的选型理由）：
 *   命中桶内的成员**全部**参与点积 ⇒ 唯一的近似来源是**探针数**（探得少 ⇒ 只漏、不错）。
 *   ⇒ 因此「桶内 top-K」与「对该桶做全量精确扫描的 top-K」**必须逐位一致**
 *     （本模块的硬断言之一）。
 *
 * ⚠️ **本模块负责「训练 + 路由 + 桶内检索」，不负责「桶归属落库」**：
 *   §9.3.0 规定桶归属的写入只允许出现在一个内部函数里（`assignBucket` / `unassignBucket`），
 *   那是 **P2-T03** 的活 ⇒ **本模块不写 `vector_cell_members`**。
 *   ⇒ 本模块提供**返回细桶 id 的纯函数** `assignFineBucket()`，供 T03 调用。
 *
 * ⚠️ **表名的唯一出处**：`vector_cell_members`（桶成员）与 `memories`（候选行）
 *   只在本模块出现 ⇒ 流水线（`src/store/recall.ts`）**永远不引用表名**（§4.6 步骤 2c）。
 */

import type Database from 'better-sqlite3';

import { MemoryError } from '../core/errors.js';
import { DEFAULT_PARAMS } from '../core/params.js';
import { clampCos } from '../core/scoring.js';
import type { VectorBackend, VectorBackendConfig, VectorFilter, VectorHit } from './backend.js';
import { type IvfCentroidModel, blobToVector, saveCentroidModel } from './centroids.js';
import { assertValidEmbedding, dot } from './dot.js';
import { type VectorCandidateRow, compareHits, passesTimeWindow } from './flat.js';
import { DEFAULT_MAX_ITERATIONS, sphericalKmeans } from './kmeans.js';

/** IVF 后端在 `stats().backend` 里的名字。 */
export const IVF_BACKEND_NAME = 'ivf';

/** SQL 的 `IN (...)` 单次参数量上限（SQLite 默认上限是 999 ⇒ 取 500 留余量）。 */
const SQL_PARAM_CHUNK = 500;

/** 一次训练的入参。 */
export interface IvfTrainingOptions {
  /** 粗中心数（§5 `ROUTER_COARSE_CENTERS`）。 */
  coarseCenters: number;
  /** 细中心总数（§5 `ROUTER_FINE_CENTERS`）——**每个粗桶**分到 `floor(细 / 粗)` 个。 */
  fineCenters: number;
  /** k-means 最大迭代轮数。 */
  maxIterations?: number;
  /** 归属规则用的粗层探针数（缺省 `ROUTER_NPROBE_COARSE`）。 */
  nprobeCoarse?: number;
  /** 落库时间戳（毫秒）。 */
  now: number;
}

/** 一次训练的结果。 */
export interface IvfTrainingResult {
  /** 训练出的两级中心模型（**已落库**）。 */
  model: IvfCentroidModel;
  /**
   * 每条训练向量的**细桶归属**（与输入同序）。
   *
   * ⚠️ **只是算出来的，不落库**：桶归属的写入是 P2-T03 的 `assignBucket` 的唯一职责
   *   （§9.3.0）⇒ 本模块只交出结果。
   * ⚠️ `null` = **尚未训练分桶**（模型为空）⇒ 该向量没有归属。
   */
  fineBucketIds: Array<string | null>;
}

/**
 * 一条「有向量的记忆」（**含软删**）。
 *
 * ⚠️ **软删的也读**：软删记忆**保留向量**（§8.2）⇒ 它在桶里也有一席之地（§9.3.2 ②：
 *   软删不删桶归属）⇒ 重训时**必须**一并迁移，否则它的归属会挂在旧代桶上，
 *   旧代桶被清空时会被级联删掉 ⇒ `restore()` 之后它**永久进不了向量路**（静默、永久）。
 */
export interface VectorMemoryRow {
  /** 记忆 id。 */
  id: string;
  /** 向量（已从 BLOB 解码；**未做维度校验** —— 校验在 `assignBucket` 那条路上）。 */
  vector: Float32Array;
  /** 是否软删（`memories.deleted = 1`）。 */
  deleted: boolean;
}

/**
 * 读出**全部有向量的记忆**（含软删；**按 rowid 升序**）——
 * 「有向量的记忆」这件事的**唯一读取口径**。
 *
 * ⚠️ **为什么单独抽出来**（C36：同一件事不得有两份实现）：
 *   `trainCentroids()`（训练）与 `rebuild.ts` 的重训序列（迁移）都要读这批行
 *   ⇒ 两处各写一条 SQL ⇒ 哪天一边加了过滤条件、另一边没加
 *   ⇒ **训练用的向量集合与迁移用的向量集合悄悄不是同一批** ⇒ 重训的归属与训练的几何错位。
 *   ⇒ 抽成一个函数 ⇒ 口径只有一份。
 *
 * ⚠️ **按 rowid 升序**（不是按 id 排序）：初始中心 = **输入顺序的前 K 条**（§4.15.3）
 *   ⇒ 顺序就是「确定性」的依据 ⇒ 换排序方式会换掉整套桶。
 *
 * ⚠️ **不做维度校验**：`blobToVector` 只负责解码 ⇒ 维度不对的行由
 *   `assignBucket()` 那条路上的 `assertValidEmbedding` 报错（口径只有一份）。
 *
 * @param db 库句柄
 * @returns 有向量的记忆（**含软删**；顺序即 rowid 顺序）
 */
export function readVectorMemories(db: Database.Database): VectorMemoryRow[] {
  const rows = db
    .prepare(
      'SELECT id, embedding, deleted FROM memories WHERE embedding IS NOT NULL ORDER BY rowid',
    )
    .all() as Array<{ id: string; embedding: Buffer; deleted: number }>;

  const result: VectorMemoryRow[] = [];
  for (const row of rows) {
    result.push({
      id: row.id,
      vector: blobToVector(row.embedding),
      deleted: row.deleted === 1,
    });
  }
  return result;
}

/**
 * **训练两级桶中心**（粗 200 / 细 1 万，§4.15.3）——**三个触发时机共用的唯一入口**。
 *
 * ⚠️ **三个触发时机（缺一不可，§4.15.3）**：① 建库时；② 库长大成人时（过了
 *   `ROUTER_MIN_TRAINING` 门槛）；③ 分布漂移后（P95 超标）。
 *   ⇒ **三者共用本函数**，只差触发条件（触发条件是 P2-T05/T06 的活）。
 *
 * ⚠️ **确定性**（§4.15.3）：初始中心 = **按 rowid 顺序取的前 K 条**（本函数按 `ORDER BY rowid`
 *   读训练集）⇒ **不用随机采样** ⇒ 同一份数据两次训练 ⇒ **桶归属逐条相同**。
 *
 * ⚠️ **细中心数按公式算**：`floor(细中心总数 / 粗中心数)`（§4.15.3 的口径）
 *   ⇒ 参数可改而**不必**改代码（⚠️ 别硬写 50）。
 *
 * @param db 库句柄
 * @param options 训练参数
 * @returns 中心模型 + 每条向量的细桶归属
 */
export function trainCentroids(
  db: Database.Database,
  options: IvfTrainingOptions,
): IvfTrainingResult {
  const coarseCenters = options.coarseCenters;
  const fineCenters = options.fineCenters;
  if (!Number.isInteger(coarseCenters) || coarseCenters < 1) {
    throw MemoryError.invalidInput('粗中心数必须是 ≥ 1 的整数', {
      reason: 'centers',
      expected: '>= 1',
      actual: String(coarseCenters),
    });
  }
  if (!Number.isInteger(fineCenters) || fineCenters < 1) {
    throw MemoryError.invalidInput('细中心总数必须是 ≥ 1 的整数', {
      reason: 'centers',
      expected: '>= 1',
      actual: String(fineCenters),
    });
  }

  // ⚠️ **按 rowid 顺序取**（不是随机采样、也不是按 id 排序）⇒ 初始中心确定。
  //   ⚠️ **走 `readVectorMemories()`**（唯一一份「有向量的记忆」的读取口径）⇒
  //   本函数与重训序列（`src/vector/rebuild.ts`）读到的是**同一批行、同一顺序**
  //   ⇒ 训练输入逐条相同 ⇒ 两次训练的中心逐条相同。
  const rows = readVectorMemories(db).filter((row) => !row.deleted);

  const vectors: Float32Array[] = [];
  for (const row of rows) {
    vectors.push(row.vector);
  }

  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const model = buildCentroidModel(vectors, {
    coarseCenters,
    fineCenters,
    maxIterations,
  });

  const nprobeCoarse = options.nprobeCoarse ?? DEFAULT_PARAMS.ROUTER_NPROBE_COARSE;
  const fineBucketIds = vectors.map((vector) => assignFineBucket(model, vector, nprobeCoarse));

  // ⚠️ **中心落库**（归属不落库 —— 那是 P2-T03 的唯一写入点）。
  saveCentroidModel(db, model, options.now);
  return { model, fineBucketIds };
}

/**
 * 训练两级中心模型（**纯计算，不落库**）。
 *
 * ⚠️ **确定性**：粗层用全部向量训练；细层在**每个粗桶内**再分
 *   `floor(fineCenters / coarseCenters)` 个细中心（§4.15.3）。
 * ⚠️ **桶 id 是索引派生的**（`c-000` / `f-000-000`）⇒ 同一份数据两次训练 ⇒ **同一套 id**。
 */
export function buildCentroidModel(
  vectors: readonly Float32Array[],
  options: { coarseCenters: number; fineCenters: number; maxIterations?: number },
): IvfCentroidModel {
  const coarseResult = sphericalKmeans(vectors, options.coarseCenters, {
    maxIterations: options.maxIterations,
  });

  const coarse: IvfCentroidModel['coarse'][number][] = [];
  for (let index = 0; index < coarseResult.centers.length; index += 1) {
    const centroid = coarseResult.centers[index];
    if (centroid === undefined) {
      continue;
    }
    coarse.push({ coarseId: coarseCellId(index), centroid });
  }

  // ⚠️ **细中心数按公式算**（别硬写 50）：每个粗桶分到 floor(细 / 粗) 个。
  const finePerCoarse = Math.max(1, Math.floor(options.fineCenters / options.coarseCenters));

  const fine: IvfCentroidModel['fine'][number][] = [];
  for (let coarseIndex = 0; coarseIndex < coarse.length; coarseIndex += 1) {
    const coarseCell = coarse[coarseIndex];
    if (coarseCell === undefined) {
      continue;
    }
    // ⚠️ **按输入顺序**收集该粗桶的向量 ⇒ 细层的初始中心也是确定的。
    const bucketVectors: Float32Array[] = [];
    for (let index = 0; index < vectors.length; index += 1) {
      const vector = vectors[index];
      if (vector === undefined) {
        continue;
      }
      if (coarseResult.assignments[index] === coarseIndex) {
        bucketVectors.push(vector);
      }
    }
    const fineResult = sphericalKmeans(bucketVectors, finePerCoarse, {
      maxIterations: options.maxIterations,
    });
    for (let fineIndex = 0; fineIndex < fineResult.centers.length; fineIndex += 1) {
      const centroid = fineResult.centers[fineIndex];
      if (centroid === undefined) {
        continue;
      }
      fine.push({
        fineId: fineCellId(coarseIndex, fineIndex),
        coarseId: coarseCell.coarseId,
        centroid,
      });
    }
  }

  return { coarse, fine };
}

/**
 * 算出**一个向量属于哪个细桶**（§4.15.3 的增量归桶规则）——**纯函数**。
 *
 * ⚠️ **规则（逐条照抄 §4.15.3）**：
 *   ① 算新向量到**全部粗中心**的距离 ⇒ 取最近 `nprobeCoarse` 个粗桶；
 *   ② 在这些粗桶的**细中心**里取最近的一个 ⇒ 该细桶即归属。
 *   ⚠️ 这里用 `nprobeCoarse`（20）而**不是 1** —— 用 1 会让「换个粗桶看」的候选白白错过
 *     （粗桶边界附近的向量，其最近的细中心很可能在邻桶）。
 *
 * ⚠️ **训练期与运行期用同一套规则** ⇒ 训练算出的归属与 `upsert` 算出的归属一致
 *   ⇒ 否则一条记忆会在下次写入时被重新归桶（无谓的桶 churn）。
 *
 * @param model 中心模型
 * @param vector 待归桶的向量（**已 L2 归一化**）
 * @param nprobeCoarse 粗层探针数
 * @returns 细桶 id；模型为空时返回 `null`（**尚未训练分桶 ⇒ 向量路整体缺席**）
 */
export function assignFineBucket(
  model: IvfCentroidModel,
  vector: Float32Array,
  nprobeCoarse: number,
): string | null {
  if (model.coarse.length === 0 || model.fine.length === 0) {
    return null;
  }
  const coarseHits = nearestByDot(
    model.coarse.map((cell) => ({ id: cell.coarseId, centroid: cell.centroid })),
    vector,
    nprobeCoarse,
  );
  if (coarseHits.length === 0) {
    return null;
  }
  const coarseIds = new Set(coarseHits.map((hit) => hit.id));
  const fineHits = nearestByDot(
    model.fine
      .filter((cell) => coarseIds.has(cell.coarseId))
      .map((cell) => ({ id: cell.fineId, centroid: cell.centroid })),
    vector,
    1,
  );
  return fineHits[0]?.id ?? null;
}

/**
 * 两级路由（**纯函数**）—— 算出查询向量落在哪些**细桶**里。
 *
 * ⚠️ **这是 `IvfVectorBackend.route()` 的唯一实现**（它转调本函数）⇒
 *   召回路径与写入路径**共用同一套路由规则**（C36：同一件事不得有两套词）
 *   ⇒ 两者**只差探针数**（召回 20/50，写入 8/20 —— §4.9 步骤 3a2）。
 *
 * ⚠️ **粗桶是细桶的父级，不参与乘法**（§4.6 步骤 0）：
 *   ① 粗层：与**全部**粗中心算点积 ⇒ 取最近 `nprobeCoarse` 个**粗桶**；
 *   ② 细层：**只在这 `nprobeCoarse` 个粗桶下的细中心**里算点积
 *      ⇒ 取最近 `nprobeFine` 个**细桶**。
 *   ⇒ 命中的是 **`nprobeFine` 个细桶**（不是 `nprobeCoarse × nprobeFine` 个）。
 *
 * ⚠️ **分桶尚未训练 ⇒ 返回空数组**（不是抛错、也不是静默回落 flat）：
 *   §4.15.3：「模型为空 ⇒ 向量路整体缺席」。
 *
 * @param model 中心模型
 * @param query 查询向量（**已 L2 归一化**）
 * @param nprobeCoarse 粗层探针数
 * @param nprobeFine 细层探针数
 * @returns 命中的细桶 id 列表（**按中心距离升序** = 点积降序）
 */
export function routeFineBuckets(
  model: IvfCentroidModel,
  query: Float32Array,
  nprobeCoarse: number,
  nprobeFine: number,
): string[] {
  if (model.coarse.length === 0 || model.fine.length === 0) {
    // ⚠️ **分桶尚未训练 ⇒ 向量路整体缺席**（不是「阻塞」，也不是静默回落 flat）。
    return [];
  }

  const coarseHits = nearestByDot(
    model.coarse.map((cell) => ({ id: cell.coarseId, centroid: cell.centroid })),
    query,
    nprobeCoarse,
  );
  const coarseIds = new Set(coarseHits.map((hit) => hit.id));
  const fineCandidates = model.fine
    .filter((cell) => coarseIds.has(cell.coarseId))
    .map((cell) => ({ id: cell.fineId, centroid: cell.centroid }));
  const fineHits = nearestByDot(fineCandidates, query, nprobeFine);
  return fineHits.map((hit) => hit.id);
}

// ─────────────────── 写入路径的分桶候选扫描（§4.9 步骤 3a2） ───────────────────

/**
 * 桶内候选行（`memories` 的相关列）—— 写入路径向量路的**扫描产物**。
 *
 * ⚠️ **形状与 `VectorCandidateRow` 不同**（那是召回路径的形状）：
 *   这里要带**正文四件套**（`content` / `content_tokens` / `stability` / `difficulty`），
 *   因为命中后的候选要**直接进 §4.9 步骤 3c 的合并序列**（`mergeMemory` 要这些字段）。
 *   ⇒ 向量本体**不留在行里**（余弦在扫描时就算掉了 ⇒ 不必把 2000 份 3KB 的向量
 *     全留在内存里 ⇒ 峰值内存只与「最终入选的候选数」成正比）。
 */
export interface BucketCandidateRow {
  /** 记忆 id。 */
  id: string;
  /** 库内当前正文。 */
  content: string;
  /** 库内当前分词快照。 */
  content_tokens: string;
  /** 当前稳定度（天）。 */
  stability: number;
  /** 上次访问时刻（毫秒）。 */
  last_access: number;
  /** 累计访问次数。 */
  access_count: number;
  /** 难度 `0~1`。 */
  difficulty: number;
  /** 该记忆的向量（**已从 BLOB 解码**；行内一定是 `embedding IS NOT NULL` 的行）。 */
  embedding: Float32Array;
}

/** 桶内候选扫描的结果（§4.9 步骤 3a2 ②）。 */
export interface BucketCandidateScan {
  /** 命中的细桶 id（**按中心距离升序** = 点积降序）。 */
  fineIds: string[];
  /**
   * **被扫描的候选行数**（= 命中桶里 `deleted = 0` 且有向量的行数）。
   *
   * ⚠️ **这才是「候选扫描量」**（不是「返回的候选数」）：
   *   §4.9 步骤 3a2 的「候选 ≤ 2000」指的是**扫描量**
   *   （= `ROUTER_NPROBE_WRITE_FINE` × 每桶成员数 ≈ 20 × 100 = 2000），
   *   而返回给去重判定的候选还要再过一道 `cos ≥ DEDUP_COS_MIN` 与 `VECTOR_TOPK`。
   */
  scanned: number;
  /** 候选行（**按 `fineIds` 的命中顺序**，桶内按 `memory_id` 升序）。 */
  rows: BucketCandidateRow[];
}

/**
 * 构造「命中桶内取候选」的 SQL（§4.9 步骤 3a2 ② 的参考 SQL）。
 *
 * ⚠️ **刻意与设计稿的参考 SQL 逐字同形**（多取了几列正文相关字段）：
 *   ```sql
 *   SELECT m.id, m.embedding
 *     FROM vector_cell_members vcm JOIN memories m ON vcm.memory_id = m.id
 *    WHERE vcm.fine_id IN (@writeHitCells) AND m.deleted = 0 AND m.embedding IS NOT NULL;
 *   ```
 *   ⇒ **JOIN 的方向是「桶 → 记忆」**（桶侧走 `fine_id` 索引、记忆侧走 `id` 索引）
 *     ⇒ 执行计划里**两个表都是 `SEARCH`**（不是 `SCAN`）
 *     ⇒ 这条「不做全表扫」的性质**可被 `EXPLAIN QUERY PLAN` 观测**
 *     （P2-T07 的硬断言之一）。
 *
 * ⚠️ **刻意不加时间窗**（`@coarseCutoff`）：
 *   重复项完全可能是半年前写的那条 ⇒ 加了窗口就等于「只和最近用过的记忆去重」
 *   ⇒ **这正是老库越用越脏的成因**（§4.9 步骤 3a2 的原文）。
 *   ⇒ **不加时间窗 ≠ 不加空间窗**：分桶收窄的是**空间**（几何邻近），
 *     不影响「半年前写的那条」是否进候选。
 *
 * ⚠️ **导出这个构造器**（而不是把 SQL 藏成模块常量）：
 *   测试要用**同一份 SQL** 跑 `EXPLAIN QUERY PLAN`
 *   ⇒ 断言的是**生产代码真正执行的那条语句**，不是测试自己抄的一份。
 *
 * @param fineIds 命中的细桶 id（**必须非空**——`IN ()` 是语法错误）
 * @returns 可直接 `prepare()` 的 SQL（占位符与 `fineIds` 一一对应）
 * @throws {MemoryError} `INVALID_INPUT`（`fineIds` 为空）
 */
export function buildBucketCandidateSql(fineIds: readonly string[]): string {
  if (fineIds.length === 0) {
    throw MemoryError.invalidInput('桶候选 SQL 需要至少一个细桶 id（空列表会生成非法的 IN ()）', {
      reason: 'empty-buckets',
      expected: '>= 1 个细桶 id',
      actual: '0',
    });
  }
  const placeholders = fineIds.map(() => '?').join(', ');
  return `SELECT m.id AS id, m.content AS content, m.content_tokens AS content_tokens,
            m.stability AS stability, m.last_access AS last_access, m.access_count AS access_count,
            m.difficulty AS difficulty, m.embedding AS embedding
       FROM vector_cell_members vcm
       JOIN memories m ON m.id = vcm.memory_id
      WHERE vcm.fine_id IN (${placeholders})
        AND m.deleted = 0
        AND m.embedding IS NOT NULL`;
}

/**
 * 扫命中桶取候选（§4.9 步骤 3a2 ②）—— **写入路径的向量路候选的唯一扫描点**。
 *
 * ⚠️ **为什么放在向量层**（§4.6 步骤 2c 的硬边界）：
 *   「流水线**不得**直接引用 `vector_cell_members` 的表名」
 *   ⇒ 桶表名只出现在向量层内部（本模块 + `bucketAssign.ts`）
 *   ⇒ 存储层只调本函数 ⇒ 换后端实现时存储层不必重写。
 *
 * ⚠️ **为什么「桶侧扫描」在这里而不是在 `bucketAssign.ts`**：
 *   `bucketAssign.ts` 的 `scanBucketSide()` 是**全表**扫桶侧（对账与 P95 用，
 *   它必须看到**每一行**才能分出「真孤儿 / 软删 / 无向量」三分支）
 *   ⇒ 而本函数要的是「**只扫命中桶**」⇒ 两者是**不同的口径**，
 *     共用同一个函数只会把「全扫」与「收窄」混成一件 ⇒ **刻意不复用**。
 *   ⇒ 复用的是**路由规则**（`routeFineBuckets()`）与**桶归属表**本身。
 *
 * ⚠️ **不加时间窗**（见 `buildBucketCandidateSql()` 的说明）。
 *
 * ⚠️ **分桶尚未训练 ⇒ 扫描量为 0**（不是抛错、也不是静默回落 flat）：
 *   §4.15.3：「模型为空 ⇒ 向量路整体缺席」⇒ 写入路径退回纯文本路（**不是降级报错**）。
 *
 * @param db 库句柄
 * @param model 中心模型
 * @param query 查询向量（**已 L2 归一化**）
 * @param nprobeCoarse 粗层探针数（写入路径用 `ROUTER_NPROBE_WRITE_COARSE`）
 * @param nprobeFine 细层探针数（写入路径用 `ROUTER_NPROBE_WRITE_FINE`）
 * @returns 命中桶 + 扫描量 + 候选行
 */
export function scanBucketCandidates(
  db: Database.Database,
  model: IvfCentroidModel,
  query: Float32Array,
  nprobeCoarse: number,
  nprobeFine: number,
): BucketCandidateScan {
  const fineIds = routeFineBuckets(model, query, nprobeCoarse, nprobeFine);
  if (fineIds.length === 0) {
    return { fineIds: [], scanned: 0, rows: [] };
  }

  const raw = db.prepare(buildBucketCandidateSql(fineIds)).all(...fineIds) as Array<{
    id: string;
    content: string;
    content_tokens: string;
    stability: number;
    last_access: number;
    access_count: number;
    difficulty: number;
    embedding: Buffer;
  }>;

  const rows: BucketCandidateRow[] = raw.map((row) => ({
    id: row.id,
    content: row.content,
    content_tokens: row.content_tokens,
    stability: row.stability,
    last_access: row.last_access,
    access_count: row.access_count,
    difficulty: row.difficulty,
    embedding: blobToVector(row.embedding),
  }));

  return { fineIds, scanned: rows.length, rows };
}

/** IVF 后端的构造选项。 */
export interface IvfVectorBackendOptions {
  /** 库句柄（读桶成员与候选行）。 */
  db: Database.Database;
  /** 中心模型提供者（通常传 `() => cache.model()`；**每次路由都会取一次**）。 */
  centroids: () => IvfCentroidModel;
  /** 粗层探针数（缺省 `ROUTER_NPROBE_COARSE`）。 */
  nprobeCoarse?: number;
  /** 细层探针数（缺省 `ROUTER_NPROBE_FINE`）。 */
  nprobeFine?: number;
  /** 重训后让中心提供方失效缓存（可选）。 */
  invalidateCentroids?: () => void;
}

/**
 * 两级分桶后端（生产实现）。
 *
 * ⚠️ **与 flat 基线的两处口径必须一致**（否则「IVF 与 flat 逐位一致」这条断言没有意义）：
 * · 窗口过滤与命中排序**共用同一份实现**（`flat.ts` 的共享口径）；
 * · 分数同样是**原始余弦**（只做一次 `min(1, max(0, dot))` 钳制）。
 */
export class IvfVectorBackend implements VectorBackend {
  /** 库句柄。 */
  private readonly db: Database.Database;

  /** 中心模型提供者。 */
  private readonly centroidsProvider: () => IvfCentroidModel;

  /** 粗层探针数（`search()` 用；`route()` 用调用方传入的值）。 */
  private readonly nprobeCoarse: number;

  /** 细层探针数（`search()` 用）。 */
  private readonly nprobeFine: number;

  /** 重训后的缓存失效钩子。 */
  private readonly invalidateCentroids: (() => void) | undefined;

  /** 生效配置（`init` 之后才有）。 */
  private config: VectorBackendConfig | undefined;

  /** 索引侧增量：`upsert` 进来的向量与归属（**不落库**）。 */
  private readonly overlay = new Map<string, { fineId: string | null; vector: Float32Array }>();

  /** 索引侧增量：被 `remove` 掉的 id（硬删；软删不走这里）。 */
  private readonly removed = new Set<string>();

  /**
   * @param options 构造选项
   */
  constructor(options: IvfVectorBackendOptions) {
    this.db = options.db;
    this.centroidsProvider = options.centroids;
    this.nprobeCoarse = options.nprobeCoarse ?? DEFAULT_PARAMS.ROUTER_NPROBE_COARSE;
    this.nprobeFine = options.nprobeFine ?? DEFAULT_PARAMS.ROUTER_NPROBE_FINE;
    this.invalidateCentroids = options.invalidateCentroids;
  }

  /**
   * 初始化后端（**必须幂等**；口径与 flat 后端一致）。
   *
   * @param config 后端配置（`dimensions` 必须 == `EMBED_DIM`，§6：它只读）
   */
  init(config: VectorBackendConfig): void {
    assertBackendConfig(config);
    const current = this.config;
    if (current !== undefined) {
      if (current.dimensions !== config.dimensions) {
        throw MemoryError.invalidInput('后端已初始化：不得改维度（改维度等于全库旧向量作废）', {
          reason: 'dim',
          expected: current.dimensions,
          actual: config.dimensions,
        });
      }
      // ⚠️ **幂等 ⇒ 一个字节的状态都不改**（含 `overlay` / `removed`）。
      return;
    }
    this.config = { ...config };
  }

  /**
   * **只路由、不取候选**（§4.6 步骤 0）：算查询向量落在哪些细桶里。
   *
   * ⚠️ **粗桶是细桶的父级，不参与乘法**：
   *   ① 粗层：与**全部**粗中心算点积 ⇒ 取最近 `nprobeCoarse` 个**粗桶**；
   *   ② 细层：**只在这 `nprobeCoarse` 个粗桶下的细中心**里算点积
   *      ⇒ 取最近 `nprobeFine` 个**细桶**。
   *   ⇒ 命中的是 **`nprobeFine` 个细桶**（不是 `nprobeCoarse × nprobeFine` 个）。
   *
   * @param query 查询向量（**已 L2 归一化**——由调用方归一化，后端不代劳）
   * @param nprobeCoarse 粗层探针数
   * @param nprobeFine 细层探针数
   * @returns 命中的细桶 id 列表（**按中心距离升序** = 点积降序）
   */
  route(query: Float32Array, nprobeCoarse: number, nprobeFine: number): string[] {
    const config = this.assertInitialized();
    assertValidEmbedding(query, config.dimensions);
    // ⚠️ **转调 `routeFineBuckets()`**（唯一实现）⇒ 召回路径与写入路径共用同一套路由规则
    //   （C36：同一件事不得有两套词）⇒ 两者只差探针数。
    return routeFineBuckets(this.centroidsProvider(), query, nprobeCoarse, nprobeFine);
  }

  /**
   * 检索近邻：**命中桶内做全量精确点积**（§4.15.3：「桶内是全量精确点积，不是近似召回」）。
   *
   * ⚠️ **桶内不设 LIMIT**：命中桶内的成员**全部**参与点积
   *   ⇒ 「桶内 top-K」与「对该桶做全量精确扫描的 top-K」逐位一致。
   * ⚠️ **候选宇宙**：`deleted = 0` 且 `embedding IS NOT NULL`（§4.6 步骤 2c 的参考 SQL）
   *   ——`embedding IS NOT NULL` **必须有**：桶里可能有向量已被置 NULL 的行，
   *   对它算点积会得到 NaN，而 NaN 进排序会让**整条查询的排序失效**（不报错）。
   * ⚠️ **时间窗与排除集只被「应用」**（调用方给什么就用什么，不自己推导）。
   *
   * @param query 查询向量（**已 L2 归一化**）
   * @param k 返回条数
   * @param filter 候选过滤（时间窗下界 / 排除集——**不是** id 白名单）
   * @returns 按相似度降序的候选
   */
  search(query: Float32Array, k: number, filter?: VectorFilter): VectorHit[] {
    const config = this.assertInitialized();
    assertValidEmbedding(query, config.dimensions);
    if (!Number.isInteger(k) || k < 0) {
      throw MemoryError.invalidInput('k 必须是非负整数', {
        reason: 'k',
        expected: '>= 0 的整数',
        actual: String(k),
      });
    }
    if (k === 0) {
      return [];
    }

    const fineIds = this.route(query, this.nprobeCoarse, this.nprobeFine);
    if (fineIds.length === 0) {
      return [];
    }

    const effectiveFilter: VectorFilter = filter ?? {};
    const excluded = new Set(effectiveFilter.excludeIds ?? []);

    // ⚠️ **桶成员（库里的归属）+ 索引侧增量（`upsert` 进来的）**。
    const members = this.readMembers(fineIds);
    const memberIds = new Set<string>();
    for (const ids of members.values()) {
      for (const id of ids) {
        memberIds.add(id);
      }
    }
    // ⚠️ **索引侧增量（`upsert` 进来的）**：它的向量覆盖库里的向量，
    //   但**归属仍以库里的 `vector_cell_members` 为准**（落库是 T03 的唯一写入点）
    //   ⇒ 这里只把它的 id 加进取行名单（取行是为了拿 `last_access` / `pin_factor`）。
    for (const [id, entry] of this.overlay) {
      if (entry.fineId !== null && fineIds.includes(entry.fineId)) {
        memberIds.add(id);
      }
    }

    const rows = this.readCandidateRows([...memberIds]);
    const hits: VectorHit[] = [];

    for (const row of rows) {
      if (excluded.has(row.id) || this.removed.has(row.id)) {
        continue;
      }
      const vector = this.overlay.get(row.id)?.vector ?? row.vector;
      if (vector.length !== config.dimensions) {
        throw MemoryError.invalidInput('候选行的向量维度与后端配置不符', {
          reason: 'dim',
          expected: config.dimensions,
          actual: vector.length,
        });
      }
      if (!passesTimeWindow(row, effectiveFilter)) {
        continue;
      }
      hits.push({ id: row.id, score: clampCos(dot(query, vector)) });
    }

    // ⚠️ **索引侧增量里、但候选行不在库里的**（刚 upsert、还没落库的记忆）**不进结果**：
    //   「候选宇宙 = 库里的活行」是**来源**的口径（§4.15.2：`VectorFilter` 没有 `deleted` 字段）
    //   ⇒ 它还没有 `last_access` / `pin_factor` ⇒ 后端不得替它决定「有资格」⇒ 不进结果。
    //   ⇒ 与 flat 后端**同口径**（flat 的候选来源也是外部注入的活行集合）。

    hits.sort(compareHits);
    return hits.slice(0, k);
  }

  /**
   * 写入索引侧的向量与归属（**同 id 覆盖**）。
   *
   * ⚠️ **不落库**（§9.3.0：桶归属的实际写入由主库路径在同一事务里完成，
   *   后端接口的 `upsert` 是**索引侧**的抽象）⇒ 归属只存在本进程的内存里，
   *   真正的落库是 P2-T03 的 `assignBucket` 的唯一职责。
   *
   * @param id 记忆 id
   * @param vector 向量（**已 L2 归一化**）
   */
  upsert(id: string, vector: Float32Array): void {
    const config = this.assertInitialized();
    assertValidEmbedding(vector, config.dimensions);
    const model = this.centroidsProvider();
    const fineId = assignFineBucket(model, vector, this.nprobeCoarse);
    this.overlay.set(id, { fineId, vector: new Float32Array(vector) });
    this.removed.delete(id);
  }

  /**
   * 取**索引侧算出的桶归属**（`upsert` 累积的；`null` = 尚未训练分桶）。
   *
   * ⚠️ **这是给 P2-T03 的 `assignBucket` 用的**：归属的**落库**是 §9.3.0 的单一写入点
   *   （T03 的职责）⇒ 本模块只负责**算**，并把结果交出来。
   * ⚠️ **不落库 ⇒ 进程重启即丢** ⇒ 调用方必须在**同一事务**里把它写进
   *   `vector_cell_members`（§9.3.2 ①：桶归属与主表同事务写）。
   */
  pendingAssignments(): ReadonlyMap<string, string | null> {
    const result = new Map<string, string | null>();
    for (const [id, entry] of this.overlay) {
      result.set(id, entry.fineId);
    }
    return result;
  }

  /**
   * 移除一条 id（**硬删**时调用；软删**不删**）。
   *
   * @param id 记忆 id
   */
  remove(id: string): void {
    this.assertInitialized();
    this.overlay.delete(id);
    this.removed.add(id);
  }

  /**
   * 全量重建。
   *
   * ⚠️ **本方法只重建「索引侧」**：丢弃索引侧增量 + 让中心缓存失效。
   *   ⚠️ **真正的重训入口是 `trainCentroids()`**（§4.15.3 的三个触发时机共用它）——
   *     而**重训必须与「重分配桶归属」在同一个事务里**（§4.15.5）
   *     ⇒ 归属的重分配是 P2-T03 的 `assignBucket` 的职责，**本方法不做**。
   */
  rebuild(): void {
    this.assertInitialized();
    this.overlay.clear();
    this.removed.clear();
    this.invalidateCentroids?.();
  }

  /**
   * 后端状态。
   *
   * ⚠️ `count` = **桶成员总数**（`vector_cell_members` 的行数）。
   *   ⚠️ **它不等于「一次桶内检索会扫到多少条」** —— 桶内检索只扫**被探针命中的那些桶**的成员
   *   （典型 50 个细桶 ⇒ 远小于全库）⇒ 别把这两个数混为一谈。
   *   ⚠️ 也**不等于** flat 后端的 `count`：flat 的 `count` 是「会被全表扫描到的向量条数」
   *   ⇒ 在「阶段 1 欠账」状态下（库侧有向量、桶侧无归属）两者本来就不等。
   * ⚠️ `indexBytes` = **中心向量占用的字节数**（分桶索引本体；
   *   成员表的大小随语料变化，不计入「索引字节数」）。
   */
  stats(): { count: number; dimensions: number; backend: string; indexBytes: number } {
    const config = this.assertInitialized();
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM vector_cell_members').get() as {
      count: number;
    };
    const model = this.centroidsProvider();
    const centerCount = model.coarse.length + model.fine.length;
    return {
      count: row.count,
      dimensions: config.dimensions,
      backend: IVF_BACKEND_NAME,
      indexBytes: centerCount * config.dimensions * 4,
    };
  }

  /** 取生效配置；未 `init` ⇒ 抛错。 */
  private assertInitialized(): VectorBackendConfig {
    const config = this.config;
    if (config === undefined) {
      throw MemoryError.invalidInput('后端尚未初始化：先调用 init(config)', {
        reason: 'not-initialized',
      });
    }
    return config;
  }

  /**
   * 读命中细桶的成员（`vector_cell_members`）。
   *
   * ⚠️ **本模块是 `vector_cell_members` 的唯一读取点** ⇒ 表名不外泄。
   */
  private readMembers(fineIds: readonly string[]): Map<string, string[]> {
    const members = new Map<string, string[]>();
    const statement = this.db.prepare(
      'SELECT fine_id, memory_id FROM vector_cell_members WHERE fine_id = ?',
    );
    for (const fineId of fineIds) {
      const rows = statement.all(fineId) as Array<{ fine_id: string; memory_id: string }>;
      members.set(
        fineId,
        rows.map((row) => row.memory_id),
      );
    }
    return members;
  }

  /**
   * 读候选行（`memories`）—— **live 数据**（`last_access` 会被 `touch()` 改动）。
   *
   * ⚠️ `deleted = 0` 是**候选宇宙**的口径（不是 filter 字段，§4.15.2 的 `VectorFilter` 没有它）。
   */
  private readCandidateRows(memoryIds: readonly string[]): VectorCandidateRow[] {
    if (memoryIds.length === 0) {
      return [];
    }
    const rows: VectorCandidateRow[] = [];
    for (const chunk of chunkIds(memoryIds, SQL_PARAM_CHUNK)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const statement = this.db.prepare(
        'SELECT id, embedding, last_access, pin_factor FROM memories ' +
          `WHERE id IN (${placeholders}) AND deleted = 0 AND embedding IS NOT NULL`,
      );
      const result = statement.all(...chunk) as Array<{
        id: string;
        embedding: Buffer;
        last_access: number;
        pin_factor: number;
      }>;
      for (const row of result) {
        rows.push({
          id: row.id,
          vector: blobToVector(row.embedding),
          lastAccess: row.last_access,
          pinFactor: row.pin_factor,
        });
      }
    }
    return rows;
  }
}

/** 一个候选中心（用于「按点积取最近」的统一实现）。 */
interface ScoredCenter {
  /** 中心 id（粗桶 id 或细桶 id）。 */
  id: string;
  /** 中心向量。 */
  centroid: Float32Array;
}

/**
 * 按**点积降序**取最近的 `limit` 个中心。
 *
 * ⚠️ **平局按 id 升序** ⇒ 路由结果**可复现**（浮点同分是常态）。
 * ⚠️ **点积降序 == 中心距离升序**（中心与查询向量都 L2 归一化 ⇒
 *   距离² = 2 - 2·点积）⇒ 契约要求的「按中心距离升序」即此顺序 ✓。
 */
function nearestByDot(
  centers: readonly ScoredCenter[],
  query: Float32Array,
  limit: number,
): Array<{ id: string; score: number }> {
  if (limit <= 0 || centers.length === 0) {
    return [];
  }
  const scored = centers.map((center) => ({ id: center.id, score: dot(query, center.centroid) }));
  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return scored.slice(0, Math.min(limit, scored.length));
}

/** 粗桶 id（**索引派生 ⇒ 确定性**）。 */
function coarseCellId(index: number): string {
  return `c-${String(index).padStart(3, '0')}`;
}

/** 细桶 id（**索引派生 ⇒ 确定性**；前段是父粗桶的序号）。 */
function fineCellId(coarseIndex: number, fineIndex: number): string {
  return `f-${String(coarseIndex).padStart(3, '0')}-${String(fineIndex).padStart(3, '0')}`;
}

/** 把 id 列表切成若干块（SQLite 的参数个数有上限）。 */
function chunkIds(ids: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

/**
 * 校验后端配置（口径与 flat 后端一致）。
 *
 * ⚠️ **维度必须 == `EMBED_DIM`**（§6：它是**只读**参数）。
 */
function assertBackendConfig(config: VectorBackendConfig): void {
  if (config.dimensions !== DEFAULT_PARAMS.EMBED_DIM) {
    throw MemoryError.invalidInput(
      `后端的维度必须是 ${DEFAULT_PARAMS.EMBED_DIM}（EMBED_DIM 是只读参数）`,
      { reason: 'dim', expected: DEFAULT_PARAMS.EMBED_DIM, actual: config.dimensions },
    );
  }
  if (config.coarseCenters < 1 || config.fineCenters < 1) {
    throw MemoryError.invalidInput('粗/细中心数必须 >= 1', {
      reason: 'centers',
      expected: '>= 1',
      actual: `${config.coarseCenters}/${config.fineCenters}`,
    });
  }
}
