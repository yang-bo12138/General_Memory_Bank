/**
 * 启动对账 —— P2-T06（DESIGN-v2.md §9.3.2 ③ 的三条判据 + 三分支处置）。
 *
 * ⚠️ ★ **对账是防御，不是常态**（§9.3.2 ③）：
 *   桶归属与主表**同事务写** ⇒ 正常路径**不可能**不一致
 *   ⇒ **若对账每次都发现差异 ⇒ 说明同事务写入被漏实现了 —— 那是 bug，不是数据问题。**
 *
 * ⚠️ ★ **必须用集合比较，不能用 COUNT 比较**（§9.3.2 ③）：
 *   COUNT 相同但**成员不同**（一条漏了、另一条多了）完全可能
 *   ⇒ 「条数对得上」会让人以为对账通过 ⇒ **漏召永久存在且无人发现**。
 *   ⇒ 本模块**不自己写集合比较** ⇒ 复用 `src/vector/bucketAssign.ts` 的
 *     `diffBucketMembership()`（T03-b 的既有口径）⇒ **同一件事只有一份实现**（C36）。
 *
 * ⚠️ ★ **三条判据必须齐过**（§9.3.2 ③ 的实测结论）：
 *   ① **双向集合比较** → 抓「少」（缺失）与「脏行」（桶里有不该有的）；
 *   ② **`COUNT(*) == COUNT(DISTINCT memory_id)`** → 抓「多」（重复归属）；
 *   ③ **源头堵**：`idx_vcm_memory_unique` 唯一索引 ⇒ 让重复**根本写不进去**。
 *   ★ 只做 ① 不够（重复在两侧都出现 ⇒ 差集查不出）；只做 ② 会漏「少」；
 *     ③ 是唯一的根治手段，但 ①② 仍需保留
 *     —— **唯一索引能挡「写进去」，挡不住「历史脏数据」**。
 *
 * ⚠️ ★ **桶侧有、库侧无的三分支处置**（§9.3.2 ③，不再一刀切）：
 *   · **JOIN 不到 `memories` 行**（硬删且 FK 未开 ⇒ **真孤儿**）⇒ **删**；
 *   · **`m.deleted = 1`（软删）** ⇒ **跳过，不删**
 *     ⚠️ §9.3.2 ② 明写「软删不删桶归属」（软删仍可 `restore`、§8.2 要求软删保留向量）
 *     ⇒ 若一刀切删掉 ⇒ `forget(soft)` → 桶行被删 → `restore()` 回来
 *     ⇒ 那条记忆**永久进不了向量路** ⇒ **静默、永久、不报错**；
 *   · **`m.embedding IS NULL`** ⇒ **删**（无向量记忆不该在桶里）。
 *
 * ⚠️ ★ **重复归属只「检出」不「修复」**（§9.3.2 ③ 的验收标准）：
 *   哪一条重复行是「该留的那条」**无法判定**（两条都合法、桶 id 语义不明）
 *   ⇒ 自动删一条 = 猜 ⇒ 猜错 = 把记忆挂到**错误的桶**里 ⇒ 召回静默变差
 *   ⇒ ⇒ **报告而不静默放过**（调用方可据此显式重训 —— 重训是幂等的、必然修好）。
 *
 * ⚠️ ★ **重训进行中 ⇒ 整体跳过**（见 `ReconcileSkipReason`）：
 *   重训期间「中心已换、归属只迁了一半」⇒ 此刻的对账结论**不可信**
 *   ⇒ 而且**修复会用旧中心**（缓存直到重训结束才失效）把缺失的记忆挂到**旧代桶**上
 *   ⇒ 重训的步骤 ③ 会把它们**级联删掉** ⇒ 那批记忆**永久没有归属**（静默、永久）
 *   ⇒ ⇒ 宁可**跳过并报告**，也不在半路修。
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../core/params.js';
import {
  type BucketAssignContext,
  assignBucket,
  diffBucketMembership,
  scanBucketSide,
  unassignBucket,
} from './bucketAssign.js';
import { type BucketQuality, measureBucketQuality } from './bucketQuality.js';
import { type IvfCentroidModel, blobToVector } from './centroids.js';

/**
 * 对账被**整体跳过**的原因。
 *
 * ⚠️ **跳过时所有计数恒为 0** ⇒ **不得**据此判断「桶是健康的」
 *   ⇒ 必须看 `skipReason` 才知道「这次根本没查」。
 */
export type ReconcileSkipReason =
  /** **正在重训** ⇒ 结论不可信 ⇒ 整体跳过（不检测、不修复）。 */
  | 'retrain-in-progress'
  /** **中心模型为空**（尚未训练分桶）⇒ 没有「当前代细桶」可归 ⇒ 不修复。 */
  | 'no-centroid-model';

/** 对账的结果（**三条判据 + 处置计数**）。 */
export interface ReconcileReport {
  /**
   * ★ 判据 ①：「**缺失**」条数（库侧有向量、桶侧无归属）。
   *
   * ⚠️ **这是「检测到的」条数**（修复**前**）⇒ 与 `assigned`（修复了多少）不是一回事。
   */
  missing: number;
  /**
   * ★ 判据 ①：「**脏行**」条数（桶侧有归属、但库侧对不上）= `orphans` + `vectorless`。
   *
   * ⚠️ **软删记忆不算脏行**（它们保留归属是对的 ⇒ §9.3.2 ②）⇒ 那部分在 `softDeleted` 里。
   */
  dirty: number;
  /** 判据 ① 的分支明细：**真孤儿**（JOIN 不到 `memories` 行）条数。 */
  orphans: number;
  /** 判据 ① 的分支明细：**无向量却占着桶**的条数。 */
  vectorless: number;
  /**
   * ★ 判据 ②：「**重复归属**」条数（一条记忆挂了多于一个桶）。
   *
   * ⚠️ **只检出、不修复**（见文件头）⇒ 非零 ⇒ 对账**不通过**。
   */
  duplicates: number;
  /** 三分支里的「**软删跳过**」条数（**它们是对的**，不算脏行）。 */
  softDeleted: number;
  /**
   * ★ 三条判据**齐过** ⇒ **对账通过**（**检测时**的结论）。
   *
   * ⚠️ **任一非零 ⇒ 不得报告「对账通过」**：
   *   `missing` / `dirty` / `duplicates` 任一非零 ⇒ `false`。
   */
  consistent: boolean;
  /**
   * ★ **修复后**是否一致（`detectOnly` ⇒ 与 `consistent` 相同）。
   *
   * ⚠️ **重复归属不会被修复** ⇒ 它非零 ⇒ 这里**永远**是 `false`
   *   ⇒ 调用方据此知道「必须显式重训才能修好」。
   */
  consistentAfterRepair: boolean;
  /**
   * 桶覆盖率（§6 的 `bucketCoverage`：已有向量且已入桶的记忆占比）。
   *
   * ⚠️ **修复前**测的（它是**健康度**指标 ⇒ 修复后就恒为 1 ⇒ 没有信息量了）。
   * ⚠️ 库里**没有向量**时 ⇒ 取 **1**（没有欠账 ⇒ 不是「覆盖率 0%」）。
   */
  coverage: number;
  /** 实际**补齐**的条数（`detectOnly` ⇒ 0）。 */
  assigned: number;
  /** 实际**清理**的条数（`detectOnly` ⇒ 0）。 */
  unassigned: number;
  /** 跳过的原因（`null` = 没跳过 ⇒ 正常走完了检测与处置）。 */
  skipReason: ReconcileSkipReason | null;
}

/** 对账 + 桶质量的**一次扫描**产物。 */
export interface ReconcileOutcome {
  /** 对账报告（三条判据 + 处置计数）。 */
  report: ReconcileReport;
  /**
   * 桶质量（**与对账同一次扫描** ⇒ 不额外扫全表，§9.3.2 ④）。
   *
   * ⚠️ **它是「建议」不是「动作」**：`degraded = true` ⇒ **建议**调用方调
   *   `rebuildVectorBuckets()` ⇒ **库不自动重训**（重训是 1~3 分钟的阻塞操作）。
   */
  quality: BucketQuality;
}

/** 对账的入参。 */
export interface ReconcileOptions {
  /**
   * 中心模型提供者（**修复时必需**：缺失的记忆要归入最近的**当前代**细桶）。
   *
   * ⚠️ **不传 ⇒ 不修复**（只检测）⇒ 报告里 `skipReason = 'no-centroid-model'`。
   */
  centroids?: () => IvfCentroidModel;
  /** 粗层探针数（缺省 `ROUTER_NPROBE_COARSE`）—— **必须与训练时一致**（§4.15.3）。 */
  nprobeCoarse?: number;
  /** 桶成员数上限（缺省 `ROUTER_BUCKET_MAX`）—— 判定 `quality.degraded` 用。 */
  maxBucketSize?: number;
  /**
   * **正在重训？**（**注入** ⇒ 向量层不依赖存储层，依赖方向单向：store → vector）。
   *
   * ⚠️ **为真 ⇒ 整体跳过**（不检测、不修复）⇒ 结论不可信时宁可不说。
   */
  isRetraining?: () => boolean;
  /** **只检测不修复**？（健康度测量用 ⇒ `verifyIntegrity` 的 `bucketCoverage`） */
  detectOnly?: boolean;
}

/**
 * 启动对账（**检测 + 处置**）—— §9.3.2 ③。
 *
 * ⚠️ ★ **桶表只扫一遍**（P2-T06 的核心设计）：
 *   对账要的「桶侧行」与 P95 要的「每桶成员数」**来自同一次** `scanBucketSide()`
 *   ⇒ §9.3.2 ④ 的「这一遍可与启动对账合并成同一次扫描」**已落实**。
 *
 * ⚠️ **事务由调用方注入**：桶归属的写入（`assignBucket` / `unassignBucket`）
 *   必须在事务内（§9.3.0 的唯一写入点自带这个守卫）⇒ 事务实现**只有 store 层那一份**。
 *
 * @param db 库句柄
 * @param runInTransaction 事务包装（由调用方注入）
 * @param options 对账入参
 * @returns 对账报告 + 桶质量
 */
export function reconcileBuckets(
  db: Database.Database,
  runInTransaction: <T>(body: () => T) => T,
  options: ReconcileOptions,
): ReconcileOutcome {
  // ── 边界 ①：正在重训 ⇒ 整体跳过（结论不可信）──
  if (options.isRetraining?.() === true) {
    return skippedOutcome('retrain-in-progress');
  }

  // ── 边界 ②：中心模型为空 ⇒ 没有「当前代细桶」可归 ⇒ 只检测不修复 ──
  const model = options.centroids?.();
  const hasModel = model !== undefined && model.fine.length > 0;

  // ⚠️ ★ **桶表只扫一遍**：对账的行 + P95 的计数同源。
  const scan = scanBucketSide(db);
  const diff = diffBucketMembership(db, scan);
  const quality = measureBucketQuality(
    scan.counts,
    options.maxBucketSize ?? DEFAULT_PARAMS.ROUTER_BUCKET_MAX,
  );

  const missing = diff.missing.length;
  const orphans = diff.orphans.length;
  const vectorless = diff.vectorless.length;
  const dirty = orphans + vectorless;
  const duplicates = diff.duplicates.length;
  const softDeleted = diff.softDeleted.length;

  const coverage = diff.liveCount === 0 ? 1 : (diff.liveCount - missing) / diff.liveCount;

  const report: ReconcileReport = {
    missing,
    dirty,
    orphans,
    vectorless,
    duplicates,
    softDeleted,
    consistent: missing === 0 && dirty === 0 && duplicates === 0,
    consistentAfterRepair: missing === 0 && dirty === 0 && duplicates === 0,
    coverage,
    assigned: 0,
    unassigned: 0,
    skipReason: null,
  };

  // ── 只检测不修复 ──
  if (options.detectOnly === true) {
    return { report, quality };
  }

  // ── 没有中心模型 ⇒ 不修复（缺失的记忆无处可归）──
  if (!hasModel || model === undefined) {
    report.skipReason = 'no-centroid-model';
    return { report, quality };
  }

  // ══════════════ 处置（一个事务 ⇒ 要么全做、要么全不做）══════════════
  const context: BucketAssignContext = {
    db,
    centroids: () => model,
    nprobeCoarse: options.nprobeCoarse ?? DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
  };

  // ⚠️ **缺失补齐**：按**新中心**重新分配（进最近的**当前代**细桶，§9.3.2 ③）。
  //   ⚠️ **只取缺失的那些记忆的向量**（不是全库）⇒ 正常情况下**一条都不用取**。
  const missingRows = fetchMissingVectors(db);
  const missingIds = new Set(diff.missing);

  // ⚠️ **脏行清理**：真孤儿 + 无向量 ⇒ 摘掉桶归属（**软删不动**）。
  const dirtyIds = [...diff.orphans, ...diff.vectorless];

  runInTransaction(() => {
    for (const row of missingRows) {
      // ⚠️ **只修「差异报告里的那条」**：抓取集合与差异集合若有出入（并发写）
      //   ⇒ 以**差异口径**为准 ⇒ 多出来的那条下一轮再修（幂等 ⇒ 无所谓）。
      if (!missingIds.has(row.id)) {
        continue;
      }
      assignBucket(context, row.id, blobToVector(row.embedding));
      report.assigned += 1;
    }
    for (const memoryId of dirtyIds) {
      unassignBucket(context, memoryId);
      report.unassigned += 1;
    }
  });

  report.consistentAfterRepair =
    Math.max(0, report.missing - report.assigned) === 0 &&
    Math.max(0, report.dirty - report.unassigned) === 0 &&
    report.duplicates === 0;

  return { report, quality };
}

/**
 * 取「缺失」的那些记忆的向量（**只取缺失的**，不是全库）。
 *
 * ⚠️ **口径与 `diffBucketMembership()` 的 `missing` 相同**：
 *   库侧 = `embedding IS NOT NULL AND deleted = 0`；桶侧 = 有归属
 *   ⇒ `NOT IN (SELECT memory_id FROM vector_cell_members)` 就是同一个集合。
 *   ⚠️ **单条 SQL、不带参数** ⇒ 没有 SQLite 的参数个数上限问题。
 *
 * @param db 库句柄
 * @returns 缺失记忆的 id 与向量 BLOB
 */
function fetchMissingVectors(db: Database.Database): Array<{ id: string; embedding: Buffer }> {
  return db
    .prepare(
      'SELECT id, embedding FROM memories ' +
        'WHERE embedding IS NOT NULL AND deleted = 0 ' +
        'AND id NOT IN (SELECT memory_id FROM vector_cell_members)',
    )
    .all() as Array<{ id: string; embedding: Buffer }>;
}

/**
 * 构造「被跳过」的结果（**所有计数恒为 0**）。
 *
 * ⚠️ **必须显式说明「没查」**：计数恒 0 看起来像「一切正常」
 *   ⇒ 调用方**必须**看 `skipReason` 才知道这次根本没查。
 */
function skippedOutcome(reason: ReconcileSkipReason): ReconcileOutcome {
  return {
    report: {
      missing: 0,
      dirty: 0,
      orphans: 0,
      vectorless: 0,
      duplicates: 0,
      softDeleted: 0,
      // ⚠️ **跳过 ≠ 一致** ⇒ 一律 `false`（不得让调用方误以为「对账通过」）。
      consistent: false,
      consistentAfterRepair: false,
      coverage: 0,
      assigned: 0,
      unassigned: 0,
      skipReason: reason,
    },
    quality: {
      fineCells: 0,
      members: 0,
      maxBucketSize: 0,
      p95BucketSize: 0,
      // ⚠️ **跳过时质量未知** ⇒ 一律 `false`（不得据此说「质量没问题」）。
      degraded: false,
    },
  };
}
