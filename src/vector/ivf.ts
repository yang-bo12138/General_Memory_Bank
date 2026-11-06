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
import { type PruneEntry, WRITE_EXACT_RESCORE_BUDGET, pruneTopK } from './prune.js';
import { type CodeWidth, detectCodeWidth } from './quantize.js';

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
 * ⚠️ ★★★ **流式读取**（P2 收官 · Q-06：**训练峰值内存**）：
 *   **曾经**用 `.all()` ⇒ **一次性物化 100 万行**（id + 3KB BLOB ≈ **3.3GB**）
 *   ⇒ 随后 `blobToVector` 再分配 **3.07GB** 的 `Float32Array`
 *   ⇒ **两者同时存活** ⇒ 峰值 ≈ **6.4GB**（+ Node/SQLite ⇒ 实测 **8.47GB**）
 *   ⇒ **8GB 机器建库直接 OOM**。
 *   ⇒ **现在用 `.iterate()` 逐行读、逐行 decode** ⇒ **原始 BLOB 不再全量留在内存**
 *     ⇒ 内存里只剩**一份** 3.07GB 的 `Float32Array`（= 向量本体，= 设计稿的必要量）
 *     ⇒ 峰值内存 **∝ 一条向量**（而不是 ∝ 扫描量）⇒ 实测降到 **~3.2GB**。
 *   ⚠️ **返回值的形状刻意不变**（仍是 `VectorMemoryRow[]`）⇒
 *     **调用方（`trainCentroids` / `rebuildBuckets`）一行都不用改**
 *     ⇒ 「训练用的向量集合」与「迁移用的向量集合」**仍是同一批行、同一顺序**
 *       （两条路都走这一个函数 ⇒ 口径只有一份 ⇒ 顺序只有一种）。
 *
 * @param db 库句柄
 * @returns 有向量的记忆（**含软删**；顺序即 rowid 顺序）
 */
export function readVectorMemories(db: Database.Database): VectorMemoryRow[] {
  // ⚠️ **必须用 `iterate()` 而不是 `all()`**（见文件头的「流式读取」）：
  //   `all()` 会把 100 万行的 BLOB **一次性**物化成数组 ⇒ 与解码出来的
  //   `Float32Array` **同时存活** ⇒ 峰值内存翻倍。
  const rows = db
    .prepare<[], { id: string; embedding: Buffer; deleted: number }>(
      'SELECT id, embedding, deleted FROM memories WHERE embedding IS NOT NULL ORDER BY rowid',
    )
    .iterate();

  const result: VectorMemoryRow[] = [];
  for (const row of rows) {
    // ⚠️ **逐行解码**：解码完这一行，那一行的原始 BLOB 就可以被回收
    //   ⇒ 内存里同时只存在**一条**原始 BLOB。
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

  // ⚠️★ **一次遍历分堆**（2026-11-02 性能轮改）—— 旧写法是双层循环：
  //   外层遍历粗桶、内层**每次都从 0 遍历全部 `vectors`** 再按归属过滤
  //   ⇒ 复杂度 `O(粗桶数 × N)`。默认 200 个粗桶 × 100 万条 ⇒ **2 亿次比较**，
  //     而这件事本身只是「把向量按归属分成几堆」⇒ 本来 `O(N)` 就够。
  //   ⇒ 现在先一次性分堆（`O(N)`），再按粗桶顺序训练细层。
  //   ⚠️ **结果必须与旧写法完全相同**：每个桶内仍然是**按输入顺序**收集的
  //     （细层的初始中心 = 该桶前 `finePerCoarse` 条 ⇒ 顺序变了结果就变）。
  //     这条由 `tests/unit/ivf.test.ts` 的「单遍分堆 ≡ 双层扫描」用例钉住。
  const bucketMembers: Float32Array[][] = coarse.map(() => []);
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];
    const assigned = coarseResult.assignments[index];
    if (vector === undefined || assigned === undefined) {
      continue;
    }
    const member = bucketMembers[assigned];
    // ⚠️ 归属越界只可能来自「`assignments` 与 `coarse` 不同长」这种内部不一致
    //   （`coarse` 会跳过取值 `undefined` 的中心）⇒ 跳过该向量，与旧写法一致
    //   （旧写法里 `assignments[index] === coarseIndex` 同样选不中它）。
    if (member === undefined) {
      continue;
    }
    member.push(vector);
  }

  const fine: IvfCentroidModel['fine'][number][] = [];
  for (let coarseIndex = 0; coarseIndex < coarse.length; coarseIndex += 1) {
    const coarseCell = coarse[coarseIndex];
    if (coarseCell === undefined) {
      continue;
    }
    // ⚠️ **按输入顺序**的成员（分堆时逐条 push ⇒ 顺序即输入顺序）⇒ 细层初始中心是确定的。
    const bucketVectors = bucketMembers[coarseIndex] ?? [];
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
  /**
   * 该记忆的向量（**原始 BLOB**；行内一定是 `embedding IS NOT NULL` 的行）。
   *
   * ⚠️ **刻意保留 BLOB 而不是解成 `Float32Array`**：
   *   命中桶里可能有上千行 ⇒ 一次性全解 ⇒ **峰值内存 = 扫描量 × 3KB**（2500 行 ⇒ 7.5MB）
   *   ⇒ 而 better-sqlite3 反正已经把 BLOB 全读出来了（那部分内存躲不掉）
   *   ⇒ 解码**挪到用的时候逐条做** ⇒ 峰值只多一条向量（3KB）。
   */
  embedding: Buffer;
}

/** 桶内候选扫描的结果（§4.9 步骤 3a2 ② / C′ 档 T04）。 */
export interface BucketCandidateScan {
  /** 命中的细桶 id（**按中心距离升序** = 点积降序）。 */
  fineIds: string[];
  /**
   * **被扫描的候选行数** = **命中桶的成员行数**（`vector_cell_members` 去重后）。
   *
   * ⚠️ ★ **口径在 T04 变了「来源」、没变「语义」**（规格 §5.1.3）：
   *   · HEAD：= 那次 JOIN 查询返回的行数（桶内 `deleted = 0` 且有向量的行数）；
   *   · T04：= `readMembers()` 得到的成员 id 去重个数（**只依赖桶表**，与码表状态无关）。
   *   ⇒ 它仍然是「**候选宇宙**大小」，**不是**「返回的候选数」、**更不是** survivors 的个数
   *     （改成 survivors 就是 `scanned` 与 `exactReads` 混成一个 ⇒ 「剪枝率」这个出关条件消失）。
   *   ⇒ 与 HEAD 的差 = **命中桶内的软删成员数**（软删**保留**桶归属，`forget.ts` 不调
   *     `unassignBucket`）⇒ 方向**恒为偏大**（H1 看起来更差，不会假绿），
   *     且由 `A1'` 负控钉死（`scanned(prune=true) === scanned(prune=false) + 软删成员数`）。
   *
   * ⚠️ **这才是「候选扫描量」**（不是「返回的候选数」）：
   *   §4.9 步骤 3a2 的「候选 ≤ 2000」指的是**扫描量**
   *   （= `ROUTER_NPROBE_WRITE_FINE` × 每桶成员数 ≈ 20 × 100 = 2000），
   *   而返回给去重判定的候选还要再过一道 `cos ≥ DEDUP_COS_MIN` 与 `VECTOR_TOPK`。
   */
  scanned: number;
  /** 候选行（**按 `fineIds` 的命中顺序**，桶内按 `memory_id` 升序）。 */
  rows: BucketCandidateRow[];
  /**
   * 走**精确兜底**的条数（命中桶内「有成员、无可用码」的行数，规格 §5.1.5）。
   *
   * ⚠️ **必填**（不是可选）：TS 逼每个实现填上 ⇒ 「有码 / 无码」这个区分不会在某条路径上消失。
   *   `dedupCandidates.ts` **不读它** ⇒ 存储层仍然零改动。
   */
  uncoded: number;
  /**
   * **为精确分付了代价的行数**（`scoreOf` 的调用次数，规格 §5.1.10）。
   *
   * ⚠️ 它是**剪枝率**的分子（`exactReads / scanned` ⇒ 出关条件①的「≤ 15%」）：
   *   若 `exactReads ≈ scanned` ⇒ **剪枝没生效**（`eps` 太大 / 码坏了）**而结果仍然全对**
   *   ⇒ 只有这个数能发现它。
   */
  exactReads: number;
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
 * 读命中桶的**成员 id 并集**（Q1，C′ 档 §5.1.2）。
 *
 * ⚠️ **这是 `vector_cell_members` 的唯一读取口径**（两段式读路径与写路径共用）：
 *   过去它是 `IvfVectorBackend#readMembers()` 的私有实现，T04 起提到模块级 ——
 *   因为「按桶扫成员」现在有**两个**调用方（`search()` 与 `scanBucketCandidates()`），
 *   两份实现会让「候选宇宙」的口径分叉（C36）。
 *
 * ⚠️ **不碰 `memories`**（写路径 H1′ 的硬约束：判 `deleted` 与搬运 3KB 向量是同一笔页读）。
 * ⚠️ **软删成员仍然在这里**（桶表**故意**保留软删归属，`forget.ts` 不调 `unassignBucket`）
 *   ⇒ 它们是 `scanned` 与 HEAD 的差（方向恒为偏大，见 `BucketCandidateScan.scanned`）。
 *
 * @param db 库句柄
 * @param fineIds 命中的细桶 id（按路由顺序）
 * @returns 成员 id 集合（**去重**；迭代顺序 = 桶顺序 → 桶内 rowid 顺序 ⇒ 确定性）
 */
function readMemberIds(db: Database.Database, fineIds: readonly string[]): Set<string> {
  const ids = new Set<string>();
  const statement = db.prepare(
    'SELECT fine_id, memory_id FROM vector_cell_members WHERE fine_id = ?',
  );
  for (const fineId of fineIds) {
    const rows = statement.all(fineId) as Array<{ fine_id: string; memory_id: string }>;
    for (const row of rows) {
      ids.add(row.memory_id);
    }
  }
  return ids;
}

/** 一条**可用**的码行（`readCodes()` 的产物）。 */
export interface CodedVectorRow {
  /**
   * ★ **打包后的码字节**（★ **零拷贝视图** · 长度由 `codeWidth` 决定：768 / 384 / 96 B）。
   *
   * ⚠️ 之所以是 `Uint8Array`（而不是 `Int8Array`）：三档码宽的**存储形状**不同
   *   ⇒ ⇒ 统一用「打包字节」表示 ⇒ ⇒ **int4 的内存占用真的只有一半**。
   */
  readonly code: Uint8Array;
  /**
   * ★ 这一行的**码宽**（★ 由 BLOB 长度自识别 ⇒ **混档库天然可分辨**）。
   *
   * ⚠️ **必填**：码宽是**数据属性**（由这一行的 blob 长度决定），不是调用方的选择
   *   ⇒ ⇒ 忘了传 ⇒ 上界会按错误的码宽算 ⇒ ⇒ **静默漏检**。
   */
  readonly codeWidth: CodeWidth;
  /** 还原标量（`x̂ = scale × code`）。 */
  readonly scale: number;
  /** 编码期实算的 `‖x − x̂‖₂`（已含安全余量）。 */
  readonly eps: number;
}

/**
 * 读命中桶的**码池**（Q2，C′ 档 §5.1.2 / §5.1.5 的 fail-open 判定）。
 *
 * ★ **不碰 `memories`**（这是 H1′ 成立的前提，规格 §5.1.0 的硬约束）：
 *   若这里 `JOIN memories`（哪怕只 `SELECT m.deleted`），`bench` 的 `classifyReadKind()`
 *   会把这条读认成 `candidate` ⇒ T06 的 `codeRowsRead` 永远 0、`memoryRowsRead` 永远满额
 *   ⇒ **H1′ 的账从根上算错，而报表看起来很正常**。
 *
 * ★ **「无码」的五种形状在这里一次判完**（§5.1.5 的表）：
 *   · 码行不存在（池里没这个 id）；
 *   · `code` 的长度**不属于该维度下任何已知码宽**（768 / 384 / 96 B）；
 *   · `scale` 非有限；
 *   · `eps` 非有限或为负；
 *   · 码行的 `fine_id` 漂移 / 成为孤儿码（`WHERE vc.fine_id IN (...)` 天然把它排除）。
 *   ⇒ 前四种在下面**直接不放进池**；第五种由 SQL 的 `fine_id` 条件排除
 *   ⇒ 五种都落进调用方的 `uncoded` ⇒ `upper = +∞` ⇒ 精确兜底 ⇒ **迟一步、但不错**。
 *
 * ★★ **码宽按 BLOB 长度自识别**（T08 · 规格 `docs/design/perf-c2-codewidth-int4-wiring.md` §3.3）：
 *   · **零配置、零 schema 改动**（★ 码宽是**数据属性**：由这一行的 blob 长度决定）；
 *   · **混档库天然可分辨**（★ 每行只看**自己那一行**的长度 ⇒ 同一张表里可以混着三档）；
 *   · ⚠️ **坏码行仍然 fail-open**（★ 不抛错）：长度不属于任何已知码宽 ⇒ `continue`
 *     ⇒ ⇒ **一条坏码行不能让整条召回不可用**（响亮失败会让整条召回挂掉）
 *     ⇒ ⇒ 该行按「无码」处理 ⇒ 进 survivors（精确兜底）。
 *
 * @param db 库句柄
 * @param fineIds 命中的细桶 id
 * @returns `memory_id → 码行`（**不含**坏行：坏行 = 无码）
 */
export function readCodes(
  db: Database.Database,
  fineIds: readonly string[],
): Map<string, CodedVectorRow> {
  const pool = new Map<string, CodedVectorRow>();
  if (fineIds.length === 0) {
    return pool;
  }
  const dimensions = DEFAULT_PARAMS.EMBED_DIM;
  for (const chunk of chunkIds(fineIds, SQL_PARAM_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        'SELECT vc.memory_id AS id, vc.code AS code, vc.scale AS scale, vc.eps AS eps ' +
          `FROM vector_codes vc WHERE vc.fine_id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ id: string; code: Buffer; scale: number; eps: number }>;
    for (const row of rows) {
      // ★ **码宽自识别**（★ 判据从「码长 ≠ 维度」改成「码长不属于任何已知码宽」）：
      //   回填按 `length(embedding) = @bytes` 分类，所以「坏维度 + 有码」只可能来自手工改库
      //   ⇒ ⇒ fail-open 比响亮失败更安全（响亮失败会让整条召回不可用；fail-open 只是多读 3KB）。
      const codeWidth = detectCodeWidth(row.code.byteLength, dimensions);
      if (codeWidth === null) {
        // ★ **坏码行 ⇒ 跳过（不抛错）** ⇒ ⇒ 该行按「无码」处理 ⇒ 精确兜底 ⇒ **不漏召回**。
        continue;
      }
      if (!Number.isFinite(row.scale)) {
        continue;
      }
      if (!Number.isFinite(row.eps) || row.eps < 0) {
        continue;
      }
      pool.set(row.id, {
        // ⚠️ ★★ **零拷贝视图必须带 `byteOffset`**：★ `Buffer` 的 `byteOffset` **不保证为 0**
        //   ⇒ ⇒ **不许写 `new Uint8Array(row.code)`**（那会按「元素值」转换 ⇒ 静默算错）。
        code: new Uint8Array(row.code.buffer, row.code.byteOffset, row.code.byteLength),
        codeWidth,
        scale: row.scale,
        eps: row.eps,
      });
    }
  }
  return pool;
}

/**
 * 读「行级谓词」需要的**窄列**（Q3，C′ 档 §5.1.2 / §5.1.6 ②）。
 *
 * ⚠️ **只读三列**（`id` / `last_access` / `pin_factor`）：剪枝前把它当**筛子**用
 *   ⇒ 注定被时间窗挡掉的行**不会**被读 3KB 向量。
 * ⚠️ **刻意不带 `deleted = 0`**：软删行由 `scoreOf` 的 `null` 兜底
 *   （它的 `SELECT` 带 `deleted = 0`）⇒「候选宇宙」的口径**只有一处**（不在两个地方各写一遍）。
 * ⚠️ **只在 filter 带时间窗时才发**（两个键都 `undefined` ⇒ 整步跳过，见 `search()`）。
 *
 * @param db 库句柄
 * @param memoryIds 待判的行 id
 * @returns `id → { lastAccess, pinFactor }`（库里没有的 id 不在结果里）
 */
export function readGateColumns(
  db: Database.Database,
  memoryIds: readonly string[],
): Map<string, { lastAccess: number; pinFactor: number }> {
  const gate = new Map<string, { lastAccess: number; pinFactor: number }>();
  if (memoryIds.length === 0) {
    return gate;
  }
  for (const chunk of chunkIds(memoryIds, SQL_PARAM_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        'SELECT id, last_access, pin_factor FROM memories ' + `WHERE id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ id: string; last_access: number; pin_factor: number }>;
    for (const row of rows) {
      gate.set(row.id, { lastAccess: row.last_access, pinFactor: row.pin_factor });
    }
  }
  return gate;
}

/**
 * 构造「只读 survivors 整行」的 SQL（Q4，C′ 档 §5.1.2）。
 *
 * ⚠️ **为什么要一条新 SQL、而不是给 `buildBucketCandidateSql()` 加 `AND m.id IN (...)`**
 *   （两条原因，缺一条就踩坑）：
 *   ① `prune = false` 路径**必须**用旧 SQL —— 那是 A7「与 HEAD 逐位一致」的唯一依据；
 *   ② `tests/**` 里那条 `EXPLAIN QUERY PLAN` 断言（P2-T07：两张表都得是 `SEARCH`）
 *      钉的就是**旧 SQL 的文本** ⇒ 改它等于「测试跟着实现走」。
 * ⚠️ **单表 + 主键 `id IN`** ⇒ 执行计划是主键 `SEARCH`（不是全表扫）
 *   ⇒ 只对 survivors（≈ K 条）付 3KB/行。
 *
 * @param memoryIds survivors 的 id（**必须非空**：`IN ()` 是语法错误）
 * @returns 可直接 `prepare()` 的 SQL（占位符与 `memoryIds` 一一对应）
 * @throws {MemoryError} `INVALID_INPUT`（`memoryIds` 为空）
 */
export function buildSurvivorSql(memoryIds: readonly string[]): string {
  if (memoryIds.length === 0) {
    throw MemoryError.invalidInput('survivor SQL 需要至少一个 id（空列表会生成非法的 IN ()）', {
      reason: 'empty-ids',
      expected: '>= 1 个 id',
      actual: '0',
    });
  }
  const placeholders = memoryIds.map(() => '?').join(', ');
  return `SELECT m.id AS id, m.content AS content, m.content_tokens AS content_tokens,
            m.stability AS stability, m.last_access AS last_access, m.access_count AS access_count,
            m.difficulty AS difficulty, m.embedding AS embedding
       FROM memories m
      WHERE m.id IN (${placeholders})
        AND m.deleted = 0
        AND m.embedding IS NOT NULL`;
}

/**
 * 命中桶内「**有成员、无码**」的条数（`explain.routes.vector.codesMissing`，C′ 档 §5.1.9）。
 *
 * ⚠️ **它是「上界」，不是精确值**：数的是「桶里有成员、没有码行」的行，
 *   **不施加**任何行级谓词（`excludeIds` / 时间窗 / 软删）。
 *   真要精确，得再读一遍 `memories` —— 而 `codesMissing` **不该为了一次诊断去读上千行向量字节**。
 *   ⇒ 文档里写「上界」，比写一个「看起来精确」的数诚实。
 * ⚠️ **不碰 `memories`**：成本 = 桶表区间扫 + 每行一次 `idx_vcode_memory_unique` 探针。
 * ⚠️ **它不是错误、不是门槛**（§7.1.2 ④）：`> 0` = **码没铺满**（回填未完成 / 某条路径漏了维护）。
 *   做成阈值/告警 ⇒「回填还没跑完的库」直接不可用，而那正是本档要支持的处境。
 *
 * @param db 库句柄
 * @param fineIds 命中的细桶 id
 * @returns 无码成员行数（桶集为空 ⇒ 0）
 */
export function countUncodedCandidates(db: Database.Database, fineIds: readonly string[]): number {
  if (fineIds.length === 0) {
    return 0;
  }
  let total = 0;
  for (const chunk of chunkIds(fineIds, SQL_PARAM_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const row = db
      .prepare(
        'SELECT count(*) AS n FROM vector_cell_members vcm ' +
          `WHERE vcm.fine_id IN (${placeholders}) ` +
          'AND NOT EXISTS (SELECT 1 FROM vector_codes vc WHERE vc.memory_id = vcm.memory_id)',
      )
      .get(...chunk) as { n: number };
    total += row.n;
  }
  return total;
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
 * ★ **两条分支各自完整**（`prune = false` **不是**「`threshold = -Infinity` 的退化」）：
 *   · `prune = true`（缺省，两段式）：Q1 成员 → Q2 码池 → 剪枝 → Q4 survivors 整行；
 *     `scanned = 成员数`（**不调** `buildBucketCandidateSql()`）；
 *   · `prune = false`（**仅供对照**，A1 / A7）：HEAD 的 `buildBucketCandidateSql()` 一字不改，
 *     `scanned = rows.length`（**不调** `readMemberIds()`）。
 *   ⇒ 退化成「剪枝实现的参数化版本」会让 A7 测的不再是 HEAD 行为
 *     （旧 SQL 没人执行 ⇒ `EXPLAIN QUERY PLAN` 那条断言变成对死代码的断言）。
 *
 * @param db 库句柄
 * @param model 中心模型
 * @param query 查询向量（**已 L2 归一化**）
 * @param nprobeCoarse 粗层探针数（写入路径用 `ROUTER_NPROBE_WRITE_COARSE`）
 * @param nprobeFine 细层探针数（写入路径用 `ROUTER_NPROBE_WRITE_FINE`）
 * @param options 剪枝开关 + 上界门槛 + K + 精确分口径（见 `BucketScanOptions`）
 * @returns 命中桶 + 扫描量 + 候选行（+ 两个诊断计数）
 */
export function scanBucketCandidates(
  db: Database.Database,
  model: IvfCentroidModel,
  query: Float32Array,
  nprobeCoarse: number,
  nprobeFine: number,
  options: BucketScanOptions = {},
): BucketCandidateScan {
  const fineIds = routeFineBuckets(model, query, nprobeCoarse, nprobeFine);
  if (fineIds.length === 0) {
    return { fineIds: [], scanned: 0, rows: [], uncoded: 0, exactReads: 0 };
  }

  if (!(options.prune ?? true)) {
    // ── 分支 A：HEAD 的原路（`buildBucketCandidateSql()` + `rows.length` 当扫描量）──
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

    const headRows: BucketCandidateRow[] = raw.map((row) => ({
      id: row.id,
      content: row.content,
      content_tokens: row.content_tokens,
      stability: row.stability,
      last_access: row.last_access,
      access_count: row.access_count,
      difficulty: row.difficulty,
      embedding: row.embedding,
    }));

    // ⚠️ `uncoded: 0` / `exactReads: rows.length` 是**如实陈述**：
    //   这条路上「有码 / 无码」这个区分**没有被使用**（一条码都没读），
    //   而每一行的 `embedding` 都被读出来算了精确分 ⇒ 精确代价 = 行数。
    return {
      fineIds,
      scanned: headRows.length,
      rows: headRows,
      uncoded: 0,
      exactReads: headRows.length,
    };
  }

  // ── 分支 B：两段式（§5.1.0 ①~⑦）──
  const scoreOf = options.scoreOf;
  if (scoreOf === undefined) {
    // ⚠️ **响亮失败**：没有精确分口径 ⇒ 剪枝无从谈起。
    //   `scoreOf` 由调用方注入是**刻意的**（§5.1.1 纪律②）：cos 口径只有一份，
    //   而它在存储层（`cosineOf`）—— 放进本模块就成了第二份，且 A1 会因此偶发红。
    throw MemoryError.invalidInput('两段式扫描需要调用方注入 scoreOf（精确分口径）', {
      reason: 'scoreOf',
      expected: '由调用方提供（写路径 = cosineOf）',
      actual: 'undefined',
    });
  }

  // ① 成员（Q1）② 码池（Q2）③ 交集 / ④ 差集（无码 ⇒ 精确兜底）
  const memberIds = readMemberIds(db, fineIds);
  const codePool = readCodes(db, fineIds);
  const entries: PruneEntry[] = [];
  for (const id of memberIds) {
    const coded = codePool.get(id);
    if (coded === undefined) {
      entries.push({ kind: 'uncoded', id });
      continue;
    }
    entries.push({
      kind: 'coded',
      id,
      code: coded.code,
      // ★ 码宽**必须带过来**（★ 它决定剪枝时怎么解包 ⇒ 漏了就会按 int8 口径算上界 ⇒ 静默漏检）
      codeWidth: coded.codeWidth,
      scale: coded.scale,
      eps: coded.eps,
    });
  }

  // ⑤ 剪枝（阈值 + top-K；两条路只差这里传的 threshold / k）
  const outcome = pruneTopK(entries, {
    query,
    k: options.k ?? DEFAULT_PARAMS.VECTOR_TOPK,
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    // ⚠️ 写路径的结果键是 `cosineOf()`（同样钳进 `[0, 1]`）⇒ 同一条理由，下界为 `0`。
    scoreFloor: 0,
    // ★ **写路径显式带预算**（`WRITE_EXACT_RESCORE_BUDGET` = 64；见 `prune.ts` 的常量注释）：
    //   写路径 `k = VECTOR_TOPK`（20）⇒ 正常早停只付 ~20 次 ⇒ 64 是 3 倍余量，永远碰不到它。
    //   ⚠️ 读路径**不传**（`k = 60`，64 会让剪枝名存实亡）⇒ 见 `searchPruned()`。
    exactRescoreBudget: WRITE_EXACT_RESCORE_BUDGET,
    scoreOf,
  });

  // ⑥ survivors 整行（Q4）—— 只对入选的行付 3KB/行
  const rowsById = new Map<string, BucketCandidateRow>();
  const survivorIds = outcome.survivors.map((hit) => hit.id);
  for (const chunk of chunkIds(survivorIds, SQL_PARAM_CHUNK)) {
    const raw = db.prepare(buildSurvivorSql(chunk)).all(...chunk) as Array<{
      id: string;
      content: string;
      content_tokens: string;
      stability: number;
      last_access: number;
      access_count: number;
      difficulty: number;
      embedding: Buffer;
    }>;
    for (const row of raw) {
      rowsById.set(row.id, {
        id: row.id,
        content: row.content,
        content_tokens: row.content_tokens,
        stability: row.stability,
        last_access: row.last_access,
        access_count: row.access_count,
        difficulty: row.difficulty,
        embedding: row.embedding,
      });
    }
  }
  // ⚠️ **按 survivors 的顺序出队**（精确分降序、同分 id 升序）：`id IN (...)` 的返回顺序
  //   是执行计划的副产品，不能当契约 ⇒ 这里**只信 `pruneTopK()` 定的序**。
  const rows: BucketCandidateRow[] = [];
  for (const id of survivorIds) {
    const row = rowsById.get(id);
    if (row !== undefined) {
      rows.push(row);
    }
  }

  // ⑦ scanned = **候选宇宙**（成员数），不是 survivors、也不是码行数（§5.1.3）
  return {
    fineIds,
    scanned: memberIds.size,
    rows,
    uncoded: outcome.uncoded,
    exactReads: outcome.exactReads,
  };
}

/** 写路径的扫描选项（C′ 档 §5.1.4；**构造参数，不是 `Params` 键**）。 */
export interface BucketScanOptions {
  /** 是否走两段式剪枝（缺省 `true`）。`false` ⇒ **逐位回到 HEAD 行为**（A7）。**仅供对照**。 */
  prune?: boolean;
  /**
   * **上界门槛**；**必须**由调用方传 `params.DEDUP_COS_MIN`（`setParams()` 可改它，
   * 不许用 `DEFAULT_PARAMS` 顶）。缺省 ⇒ 不设门槛（结果同样正确，只是少剪一刀）。
   */
  threshold?: number;
  /** 取前 K 条（缺省 `DEFAULT_PARAMS.VECTOR_TOPK`）；**必须**由调用方传 `params.VECTOR_TOPK`。 */
  k?: number;
  /**
   * **精确分口径**（必填，当 `prune !== false`）：写路径 = `cosineOf(query, embedding)`
   * （`dedupCandidates.ts` 的余弦唯一实现），`null` = 维度不符。
   */
  scoreOf?: (id: string) => number | null;
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
  /**
   * 读路径是否做两段式剪枝（缺省 `true`）。`false` ⇒ **逐位回到 HEAD 行为**（A7）。
   *
   * ⚠️ **这是构造选项，不是 `Params` 键**（§5 末：参数表 60 项被三处副本 + 一条门禁守着，
   *   为「运行时可关」加第 61 项要同步四处文档，而对照用的开关不需要进参数表）。
   * ⚠️ 写路径**没有**对应的配置来源（`collectVectorCandidates()` 手上只有 `params` 与 `buckets`）
   *   ⇒ 写路径要关只能**代码回退**。这是刻意的：给写路径加一个配置来源
   *   = 第二个「后端行为由谁决定」的答案。
   *
   * ★ **码行必须是按当前 `memories.embedding` 编的**（T04 的正确性前提）。
   *   T05（在 `assignBucket` 里重编码）落地前，这个前提由「改向量的路径**让码失效**」维持：
   *   `updateContent()` 传新向量时会在同一事务里调 `clearCodeRow()`
   *   （`src/vector/bucketAssign.ts` 的 fail-open 降级：删掉该行的码行
   *   ⇒ 该行变「无码」⇒ 精确兜底 ⇒ **不漏召回**，`codesMissing` 可见）。
   *   ⇒ 详见 `src/vector/prune.ts` 的文件头「前提：码行必须按当前向量编」。
   */
  prune?: boolean;
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

  /** 读路径是否做两段式剪枝（`false` ⇒ 逐位回到 HEAD 行为；A7 的对照开关）。 */
  private readonly prune: boolean;

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
    this.prune = options.prune ?? true;
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
   * 检索近邻（§4.15.3：「桶内是全量精确点积，不是近似召回」）—— 两条路，**结果逐位相同**。
   *
   * ★ **两段式（C′ 档 T04）**：先读**打包的码**算**可证上界**（★ 码宽由 BLOB 长度自识别：
   *   int8 = 768 B · int4 = 384 B · 二值 = 96 B），只对「可能入选」的行
   *   读 3KB 原向量精确重排（`prune = true`，缺省）。`prune = false` ⇒ **HEAD 的原路**
   *   （全量精确点积），仅用于对照（A7）。
   *
   * ⚠️ **桶内不设 LIMIT**：命中桶内的成员**全部**参与竞争
   *   ⇒ 「桶内 top-K」与「对该桶做全量精确扫描的 top-K」逐位一致。
   *   ★ **剪枝不是 `LIMIT`**（本档 §8 第 2 条）：它跳过的是**可证不会入选**的行
   *     （`upper = q·x̂ + eps` 已经低于第 K 名的精确分），不是「前 N 行」。
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
    if (!this.prune) {
      // ⚠️ **独立的代码分支**（不是「把剪枝调成不剪」）：见 `IvfVectorBackendOptions.prune`。
      return this.searchExactBuckets(query, k, effectiveFilter, fineIds);
    }
    return this.searchPruned(query, k, effectiveFilter, fineIds);
  }

  /**
   * **HEAD 的原路**：全量精确点积 + `compareHits` + `slice(0, k)`（A7 的参照物）。
   *
   * ⚠️ **公开**是为了让 A7 能直接对「手写参照」比对：`prune = false` 的 `search()` 走的就是它
   *   ⇒ 「新路径可关」不是一句空话，而是**旧路上真的有流量**。
   *
   * @param query 查询向量（**已 L2 归一化**）
   * @param k 返回条数
   * @param filter 候选过滤（**已解析**：`{}` 或带时间窗 / 排除集）
   * @returns 按相似度降序的候选
   */
  searchExact(query: Float32Array, k: number, filter?: VectorFilter): VectorHit[] {
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
    return this.searchExactBuckets(query, k, filter ?? {}, fineIds);
  }

  /**
   * 「全量精确点积」的实现体（`fineIds` 已算好）。
   *
   * ⚠️ **逐行与 HEAD 同形**（取行 → 排除集 → overlay 覆盖 → 维度校验 → 时间窗 → 打分
   *   → `compareHits` → `slice`）：这几步的**顺序**是行为的一部分
   *   （维度校验先于时间窗 ⇒ 坏维度行会抛错而不是被窗口悄悄滤掉）。
   *
   * @param query 查询向量
   * @param k 返回条数
   * @param effectiveFilter 已解析的过滤器
   * @param fineIds 命中的细桶
   * @returns 按相似度降序的候选
   */
  private searchExactBuckets(
    query: Float32Array,
    k: number,
    effectiveFilter: VectorFilter,
    fineIds: readonly string[],
  ): VectorHit[] {
    const config = this.assertInitialized();
    const excluded = new Set(effectiveFilter.excludeIds ?? []);
    const memberIds = this.collectMemberIds(fineIds);
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
   * **两段式**（C′ 档 §5.1.0 的读路径 ①~⑦）：码算上界 → 精确重排 + 早停。
   *
   * ★ **过滤的先后写死**（§5.1.6）：① id 级谓词 → ② 行级谓词（窄列 gate）→ ③ 上界剪枝
   *   → ④ 精确重排。①② 前置的理由不是「惯例」：
   *   · 把行级谓词塞进 `scoreOf`（返回 `null`）**结果仍然对**，但会为注定被剔掉的行付 3KB/行；
   *   · 写成「先入堆、事后再 filter」**会真的坏**（被剔掉的行占住 K 个名额 ⇒ survivors 不足 k
   *     ⇒ `hits` 比 HEAD 少 ⇒ A2 红，且 `fuseScore` 下游全变）。
   *
   * @param query 查询向量（**已 L2 归一化**）
   * @param k 返回条数
   * @param effectiveFilter 已解析的过滤器
   * @param fineIds 命中的细桶
   * @returns 按相似度降序的候选（**与 `searchExact()` 逐位相同**）
   */
  private searchPruned(
    query: Float32Array,
    k: number,
    effectiveFilter: VectorFilter,
    fineIds: readonly string[],
  ): VectorHit[] {
    const config = this.assertInitialized();
    const excluded = new Set(effectiveFilter.excludeIds ?? []);

    // ── ① 成员 + overlay（与 `searchExact()` 同源）──
    const memberIds = this.collectMemberIds(fineIds);

    // ── ① id 级谓词：**在池上直接剔**（零成本、零数据依赖 ⇒ 可以前移）──
    for (const id of [...memberIds]) {
      if (excluded.has(id) || this.removed.has(id)) {
        memberIds.delete(id);
      }
    }

    // ── ② 行级谓词：窄列 gate（只在 filter 带时间窗时才发 SQL）──
    //   ⚠️ 两个键都 `undefined` ⇒ **整步跳过**（`vectorFilterOf()` 的 `{}` 分支）。
    const hasWindow =
      effectiveFilter.timeFloor !== undefined || effectiveFilter.pinnedTimeFloor !== undefined;
    const gate = hasWindow ? readGateColumns(this.db, [...memberIds]) : null;
    if (gate !== null) {
      for (const id of [...memberIds]) {
        const columns = gate.get(id);
        if (columns === undefined) {
          // 库里没有这一行（刚硬删 / overlay 里还没落库的记忆）⇒ 不在候选宇宙里。
          memberIds.delete(id);
          continue;
        }
        if (!passesTimeWindow(windowProbe(id, columns), effectiveFilter)) {
          memberIds.delete(id);
        }
      }
    }

    // ── ③ 码池 → 有码 / 无码（无码 ⇒ `upper = +∞` ⇒ 必进 survivors）──
    const codePool = readCodes(this.db, fineIds);
    const entries: PruneEntry[] = [];
    for (const id of memberIds) {
      // ⚠️ **overlay 命中的 id 一律当「无码」**：它的向量是**索引侧**的新值，
      //   而码行是按**库里的旧向量**编的 ⇒ 用旧码算出的"上界"对新向量**不再是上界**
      //   ⇒ 那是本档唯一能产生**静默漏检**的形状（§5.1.5 的 fail-open 纪律）。
      const coded = this.overlay.has(id) ? undefined : codePool.get(id);
      if (coded === undefined) {
        entries.push({ kind: 'uncoded', id });
        continue;
      }
      entries.push({
        kind: 'coded',
        id,
        code: coded.code,
        // ★ 码宽**必须带过来**（★ 它决定剪枝时怎么解包 ⇒ 漏了就会按 int8 口径算上界 ⇒ 静默漏检）
        codeWidth: coded.codeWidth,
        scale: coded.scale,
        eps: coded.eps,
      });
    }

    // ── ④ 精确重排 + 早停（读路径**不传** `threshold`：没有上界门槛）──
    const out = pruneTopK(entries, {
      query,
      k,
      // ⚠️ **`scoreFloor: 0`**：结果键是 `clampCos(dot(...))`（下界 `0`）⇒ 早停判据必须抬到
      //   `max(upper, 0)`，否则「第 K 名 = 0（被钳制的负余弦）」时会把同分且 id 更小的行跳掉
      //   —— 那是**静默丢行**（条数、分数都一样，只有 id 不同）。见 `PruneOptions.scoreFloor`。
      scoreFloor: 0,
      // ★ **读路径刻意不传 `exactRescoreBudget`**（= 无预算）：`k = VECTOR_TOPK × 3 = 60`
      //   ⇒ 写路径那个 64 只留 4 次早停机会 ⇒ 剪枝在读路径上等于不存在
      //   ⚠️ 这不是估计：本轮实测（300 行夹具 / 探针吃满 12 个细桶 / `k = 60`）——
      //     不带预算 ⇒ `exactReads = 67`（早停正常）；把 64 硬塞回读路径 ⇒ `exactReads = 300`
      //     = `scanned`（预算用尽 ⇒ 撤回剪枝 ⇒ 扫完整个桶，剪枝归零）。
      //   ⇒ 早停只由「剩余 `upper` 最大值 < 第 K 名」判定 —— 这是**证明**过的判据，
      //     不需要保险丝兜底（无预算 = 不撤回剪枝，也就不会多读）。
      scoreOf: this.makeScoreOf(query, config.dimensions),
    });

    // ⚠️ `survivors` 已经按 `compareHits` 定序；这里再排一次是**幂等**的
    //   （§5.1.0 ⑦：去掉省不下什么，留着让「谁定序」只有一处疑问）。
    const hits: VectorHit[] = [...out.survivors];
    hits.sort(compareHits);
    return hits.slice(0, k);
  }

  /**
   * 造读路径的**精确分函数**（逐条 prepared statement，**不做批量预取**）。
   *
   * ⚠️ **不做批量预取**（§5.1.10）：预取就是在**猜** survivors —— 猜大了白读 3KB、
   *   猜小了要多一轮 IO；而早停的正确性依赖「按需、按 upper 降序」。
   * ⚠️ **必须先用库里的行确认「在候选宇宙里」**（`deleted = 0` 且有向量），
   *   再考虑 overlay 覆盖：只存在于 overlay 的 id（刚 upsert、还没落库）**不进结果**
   *   —— 与 `searchExact()` 同口径（它压根取不到这种行）。
   */
  private makeScoreOf(query: Float32Array, dimensions: number): (id: string) => number | null {
    const one = this.db.prepare(
      'SELECT embedding FROM memories WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL',
    );
    return (id: string): number | null => {
      const row = one.get(id) as { embedding: Buffer } | undefined;
      if (row === undefined) {
        // 软删 / 无向量 / 已硬删 ⇒ **不在候选宇宙里**（不入堆、不占 K 名额）
        return null;
      }
      const vector = this.overlay.get(id)?.vector ?? blobToVector(row.embedding);
      if (vector.length !== dimensions) {
        throw MemoryError.invalidInput('候选行的向量维度与后端配置不符', {
          reason: 'dim',
          expected: dimensions,
          actual: vector.length,
        });
      }
      return clampCos(dot(query, vector));
    };
  }

  /**
   * 收集命中桶的**成员 id**（库里的桶归属 ∪ overlay 里落在这些桶的 id）。
   *
   * ⚠️ overlay 的归属**仍以库里的 `vector_cell_members` 为准**（落库是 `assignBucket`
   *   的唯一职责）⇒ 它只影响「取行名单」，不影响归属。
   *
   * @param fineIds 命中的细桶
   * @returns 成员 id 集合（迭代顺序 = 桶顺序 → 桶内 rowid 顺序，随后是 overlay 顺序）
   */
  private collectMemberIds(fineIds: readonly string[]): Set<string> {
    const memberIds = readMemberIds(this.db, fineIds);
    for (const [id, entry] of this.overlay) {
      if (entry.fineId !== null && fineIds.includes(entry.fineId)) {
        memberIds.add(id);
      }
    }
    return memberIds;
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
   * 读 **survivors** 的行（`memories`）—— **live 数据**（`last_access` 会被 `touch()` 改动）。
   *
   * ⚠️ ★★ **入参只能是 survivors 的 id**（C′ 档 T04，§5.1.2）：
   *   本方法一次就把 3KB 的 `embedding` 全取回来 ⇒ 在 T04 之后它**只对 survivors 调用**
   *   （典型 ~60 行，而不是**候选宇宙那几仟行**）——**这正是收益的来源**。
   *   ⚠️ ★ **2026-11-05 订正（★ 原先这里写死了「~5,521 行」）**：
   *     · `5,521` 是**旧行数口径**下 H1 的判据量（写入路径候选读取行数 max · **冷盘档**那次采集）
   *       ⇒ ⇒ **现行判据已改为字节口径**（H1′ = `bytesRead.max ≤ 6,144,000 B`）
   *       ⇒ ⇒ **它【不是】现行判据、也不再参与红绿**（★ 旧 H1 / H2 降级为**并列观测**）；
   *     · ★ **同期实测（1M · 热档 · 2026-11-05）同口径的数是 `5,286` 行**
   *       （`candidateUniverse.max`）⇒ ⇒ **两个数不是同一批采集**（★ 冷盘档 vs 热档）⇒ ⇒ **别混用**；
   *     · ⇒ ★ **所以这里不再写死任何行数** ⇒ ⇒ 只说「候选宇宙那几仟行」⇒ ⇒
   *       **下一个口径变更时，这行注释不必再改**（★ 这正是「别写死会漂的数字」）。
   *   ⚠️ 若下一个人把它当「全量候选读」继续用，收益会**静默消失而所有测试都绿**
   *     （A1/A2 只测「结果对不对」，不测「读了多少行」；后者是 T06 的 `memoryRowsRead`）。
   *   ⚠️ 写路径的对应物是 `buildSurvivorSql()`（**另一条** SQL：`prune = false` 那条路必须留着旧 SQL）。
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
 * `passesTimeWindow()` 的**探针向量**（空数组：那个函数只读 `lastAccess` / `pinFactor`）。
 *
 * ⚠️ 为什么不自己写一遍窗口判定：`passesTimeWindow()` 是「粗筛窗口」的**唯一实现**
 *   （`flat.ts`，与 `recall.ts` 的 `COARSE_WINDOW_SQL` 逐字一致）⇒ 在本模块抄一遍
 *   就是第二份口径，而两份口径哪怕只差一个 `>=` 与 `>` 也会让**两后端不再逐位一致**。
 */
const WINDOW_PROBE_VECTOR = new Float32Array(0);

/**
 * 造一个只带「窗口判据」两列的探针行（供 `passesTimeWindow()` 复用）。
 *
 * @param id 记忆 id
 * @param columns 窄列 gate 读到的两列
 * @returns 形状合法的候选行（`vector` 是空数组 —— 窗口判定不读它）
 */
function windowProbe(
  id: string,
  columns: { lastAccess: number; pinFactor: number },
): VectorCandidateRow {
  return {
    id,
    vector: WINDOW_PROBE_VECTOR,
    lastAccess: columns.lastAccess,
    pinFactor: columns.pinFactor,
  };
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
