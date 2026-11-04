/**
 * 观测接口 —— `stats()`，DESIGN-v2.md §6 的 `MemoryStats`（**20 个字段**）+ §11.4，
 * 对应 DEVELOPMENT-PLAN.md **P4-T05**。
 *
 * ★ **20 个字段 = 8 项计数 + 1 个观测块 + 11 项指标**（§6 的注释原文）。
 *   ⚠️ 「20」是**字段数**，与 §11.4 的「9 项」（指标**分组**）**不是同一口径**——
 *   两者都对，但**不可互相换算**。
 *
 * ⚠️ ★ **`stats()` 不得扫 `coacts`**（§11.4 观测纪律）：
 *   它回答的是「**当前状态**」，而簇是带 `computedAt` 的**派生快照**
 *   ⇒ `clusters()` 的三个覆盖率**不出现在这里**，本文件也**不新增** `largestClusterRatio`。
 *   ⚠️ **但 `coactWriteDrops` 可以**：它是**累计状态计数**（不是派生快照）
 *   ⇒ 实现必须是「写入时累加到一个 `meta` 计数器」，**不是**「统计时扫表」。
 *
 * ⚠️ **`archivalMissing` 的 `null` 语义**：`ready = 0`（重索引进行中）时返回 `null`
 *   ⇒ 此时该值**无意义**，调用方**不得据此判故障**（返回 0 会被读成「一切正常」）。
 *
 * ⚠️ **三个归档自检字段与 `verifyIntegrity()` 同名字段共用同一个实现**（`archival.ts`）
 *   ⇒ 口径不得分叉：两处各算一遍，迟早会一个说 0 一个说 3。
 */

import type Database from 'better-sqlite3';

import { type MemoryLayer, intensity, layerOf } from '../core/decay.js';
import type { Params } from '../core/params.js';
import { COACT_WRITE_DROPS_KEY } from '../neuron/coacts.js';
import { checkArchivalSchedule, countArchived, isArchivalReady } from './archival.js';

/** 向量路后端的四种**实际状态**（C36：与配置侧的 `VECTOR_ROUTER` 用互不相同的字面量）。 */
export type VectorBackendMode = 'flat_explicit' | 'flat_auto' | 'ivf' | 'absent';

/** `stats().vectorBackend` 观测块（§6 的字段集）。 */
export interface VectorBackendStats {
  mode: VectorBackendMode;
  inRetrain: boolean;
  coarseCells: number;
  fineCells: number;
  members: number;
  maxBucketSize: number;
  p95BucketSize: number;
  centroidsUpdatedAt: number;
  count: number;
  dimensions: number;
  indexBytes?: number;
}

/** `stats()` 的完整返回（20 个字段，顺序照 §6）。 */
export interface MemoryStats {
  total: number;
  l3Count: number;
  l2Count: number;
  l1Count: number;
  archivedCount: number;
  deletedCount: number;
  edgeCount: number;
  entityCount: number;
  vectorBackend: VectorBackendStats;
  avgStability: number;
  medianStability: number;
  touchRate7d: number;
  mergeRate: number;
  graphDensity: number;
  adoptedMemories: number;
  embeddedRatio: number;
  archivalOrphans: number;
  archivalMismatch: number;
  archivalMissing: number | null;
  coactWriteDrops: number;
}

/** `stats()` 需要的上下文。 */
export interface StatsStore {
  db: Database.Database;
  params: Params;
  /** 维护器当前是否在重训（**进程内状态**，不是库里的列）。 */
  inRetrain: () => boolean;
}

/** 7 天（毫秒）——`touchRate7d` / `mergeRate` 的窗口。 */
const SEVEN_DAYS_MS = 7 * 86_400_000;

/**
 * ★ **四值状态的唯一判定函数**（§4.6 步骤 2c 的「缺席」判定与 `stats()` 共用）。
 *
 * 判据顺序**不可换**：
 * 1. 调用方**显式**选了 flat ⇒ `flat_explicit`（那是**要求**，不是降级）；
 * 2. 库太小（已嵌向量数 < `ROUTER_MIN_TRAINING`）⇒ `flat_auto`（**自动降级**）；
 * 3. **存在可用的细桶** ⇒ `ivf`；
 * 4. 否则 ⇒ `absent`（过了门槛但桶不可用 ⇒ 需要 `rebuildVectorBuckets()`）。
 *
 * ⚠️ ★ 第 3 条的判据是「**存在可用的细桶**」，**不是**「曾经调用过 `rebuildVectorBuckets()`」——
 *   后者在训练失败时会**说谎**（调用过、桶是空的）。
 *
 * @param db 库句柄
 * @param params 生效参数（`VECTOR_ROUTER` / `ROUTER_MIN_TRAINING`）
 * @param known 可选：调用方**已确认**「已删且有向量的行数 ≥ `ROUTER_MIN_TRAINING`」
 *              ⇒ **跳过那次 COUNT**。不传 ⇒ 与引入该参数之前的行为**完全一致**（逐字相同）。
 *              ⚠️ **只允许「已过门槛」这一个方向的记忆**：反向（记住「没过」）会让
 *                 一个长大后的库**永远**留在 flat ⇒ 每次召回全表精确点积
 *                 ⇒ 延迟门槛被静默击穿（而且「库大了反而更慢」这个症状
 *                    会被误读成「数据分布变了」）。
 *              ⚠️ **为什么需要它**：召回路径每次都要判一次四态 ⇒ 不跳过一次 COUNT 的代价是
 *                 `deleted = 0 AND embedding IS NOT NULL` 的**全表计数**（百万级就是几十毫秒）
 *                 ⇒ 而「过了门槛」这件事一旦成立就**不会回头**（除非调用方删库重写）
 *                 ⇒ 记一个 sticky 位是安全的；记「没过」则不安全（见上一条）。
 */
export function resolveVectorBackendMode(
  db: Database.Database,
  params: Params,
  known?: { readonly embeddedAtLeastThreshold?: boolean },
): VectorBackendMode {
  if (params.VECTOR_ROUTER === 'flat') {
    return 'flat_explicit';
  }
  // ⚠️ **两个方向的判据都必须落在同一个变量上**（`embedded < ROUTER_MIN_TRAINING`）：
  //   跳过 COUNT 时直接给一个「必然 ≥ 门槛」的值（门槛本身），而不是把后面的分支
  //   另写一遍 ⇒ 两个分支的结论不可能分叉。
  const embedded =
    known?.embeddedAtLeastThreshold === true
      ? params.ROUTER_MIN_TRAINING
      : (
          db
            .prepare(
              'SELECT count(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL',
            )
            .get() as { n: number }
        ).n;
  if (embedded < params.ROUTER_MIN_TRAINING) {
    return 'flat_auto';
  }
  const fineCells = (
    db.prepare('SELECT count(*) AS n FROM vector_fine_cells').get() as { n: number }
  ).n;
  return fineCells > 0 ? 'ivf' : 'absent';
}

/** 读 `meta` 里的累计丢弃数（一行，点查）。 */
function readCoactWriteDrops(db: Database.Database): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(COACT_WRITE_DROPS_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return 0;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 分位数（线性插值；输入为空 ⇒ 0）。 */
function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

/** 中位数（偶数个取中间两个的平均）。 */
function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;
  return (left + right) / 2;
}

/**
 * 算 `stats()`。
 *
 * @param store 库句柄 + 参数 + 重训状态提供者
 * @param now 判定基准（层级 / 归档 / 7 天窗口，C37）
 *
 * ⚠️ **本方法不抛错**：统计接口不该因为库有点脏就打不开
 *   ⇒ 归档自检发现的问题以**三个计数字段**如实返回（`archivalOrphans` 等），
 *     处置权交给调用方（面板展示 / `verifyIntegrity()` 判红）。
 */
export function stats(store: StatsStore, now: number): MemoryStats {
  const db = store.db;
  const params = store.params;

  const total = (
    db.prepare('SELECT count(*) AS n FROM memories WHERE deleted = 0').get() as {
      n: number;
    }
  ).n;
  const deletedCount = (
    db.prepare('SELECT count(*) AS n FROM memories WHERE deleted = 1').get() as {
      n: number;
    }
  ).n;
  const edgeCount = (db.prepare('SELECT count(*) AS n FROM edges').get() as { n: number }).n;
  const entityCount = (db.prepare('SELECT count(*) AS n FROM entities').get() as { n: number }).n;

  // ── 一次遍历算：层级分布 / 稳定性分位 / 采纳面 / 向量覆盖率 ──
  const rows = db
    .prepare(
      `SELECT stability, pin_factor, last_access, access_count, (embedding IS NOT NULL) AS hasEmbedding
         FROM memories WHERE deleted = 0`,
    )
    .all() as Array<{
    stability: number;
    pin_factor: number;
    last_access: number;
    access_count: number;
    hasEmbedding: number;
  }>;

  const stabilities: number[] = [];
  let l3 = 0;
  let l2 = 0;
  let l1 = 0;
  let adopted = 0;
  let embedded = 0;
  for (const row of rows) {
    stabilities.push(row.stability);
    const value = intensity(row, now);
    const layer: MemoryLayer = layerOf(value, params);
    if (layer === 'L3') l3 += 1;
    else if (layer === 'L2') l2 += 1;
    else if (layer === 'L1') l1 += 1;
    // `archived` 不在这里数：归档计数必须走 `countArchived()`（与 sweep 共用实现）
    if (row.access_count > 0) adopted += 1;
    if (row.hasEmbedding === 1) embedded += 1;
  }
  stabilities.sort((a, b) => a - b);

  // ── 归档：三个自检字段 + 归档数（**共用实现**，口径不分叉） ──
  const archival = checkArchivalSchedule(db, params);
  const archivedCount = countArchived(db, params, now);
  const archivalReady = isArchivalReady(db);

  // ── 近 7 天的事件窗口（`touch` / `merge` / `write`）──
  const since = now - SEVEN_DAYS_MS;
  const countEvents = (type: string): number =>
    (
      db
        .prepare('SELECT count(*) AS n FROM events WHERE type = ? AND at >= ?')
        .get(type, since) as {
        n: number;
      }
    ).n;
  const touchEvents = countEvents('touch');
  const mergeEvents = countEvents('merge');
  const writeEvents = countEvents('write');

  // ── 向量后端观测块 ──
  const mode = resolveVectorBackendMode(db, params);
  const bucketSizes = (
    db.prepare('SELECT count(*) AS n FROM vector_cell_members GROUP BY fine_id').all() as Array<{
      n: number;
    }>
  )
    .map((row) => row.n)
    .sort((a, b) => a - b);
  const members = bucketSizes.reduce((sum, size) => sum + size, 0);
  const coarseCells = (
    db.prepare('SELECT count(*) AS n FROM vector_coarse_cells').get() as { n: number }
  ).n;
  const fineCells = (
    db.prepare('SELECT count(*) AS n FROM vector_fine_cells').get() as { n: number }
  ).n;
  const centroidRow = db
    .prepare('SELECT COALESCE(MAX(updated_at), 0) AS updatedAt FROM vector_fine_cells')
    .get() as { updatedAt: number };
  const centroidBytes = (
    db
      .prepare(
        `SELECT COALESCE((SELECT SUM(length(centroid)) FROM vector_coarse_cells), 0)
              + COALESCE((SELECT SUM(length(centroid)) FROM vector_fine_cells), 0) AS bytes`,
      )
      .get() as { bytes: number }
  ).bytes;

  const vectorBackend: VectorBackendStats = {
    mode,
    // ⚠️ **作用域写死**：只有 `absent` 时 inRetrain 才有意义；其余三态恒 false
    //   （`flat_auto` 不建桶 ⇒ 根本没有「重训」这件事）
    inRetrain: mode === 'absent' ? store.inRetrain() : false,
    coarseCells,
    fineCells,
    members,
    maxBucketSize: bucketSizes[bucketSizes.length - 1] ?? 0,
    p95BucketSize: percentile(bucketSizes, 0.95),
    centroidsUpdatedAt: centroidRow.updatedAt,
    count: embedded,
    dimensions: params.EMBED_DIM,
    // ⚠️ **flat 模式下 `indexBytes` 无意义**（没有独立索引文件）⇒ 只给「有桶」的两种状态
    ...(mode === 'ivf' || mode === 'absent' ? { indexBytes: centroidBytes } : {}),
  };

  return {
    total,
    l3Count: l3,
    l2Count: l2,
    l1Count: l1,
    archivedCount,
    deletedCount,
    edgeCount,
    entityCount,
    vectorBackend,
    avgStability:
      stabilities.length === 0
        ? 0
        : stabilities.reduce((sum, value) => sum + value, 0) / stabilities.length,
    medianStability: median(stabilities),
    touchRate7d: total === 0 ? 0 : touchEvents / total,
    mergeRate: writeEvents === 0 ? 0 : mergeEvents / writeEvents,
    graphDensity: entityCount === 0 ? 0 : edgeCount / entityCount,
    adoptedMemories: adopted,
    embeddedRatio: total === 0 ? 0 : embedded / total,
    archivalOrphans: archival.orphans,
    archivalMismatch: archival.mismatch,
    // ⚠️ **ready = 0 ⇒ null**（不是 0）：此时该值无意义，调用方不得据此判故障
    archivalMissing: archivalReady ? archival.missing : null,
    coactWriteDrops: readCoactWriteDrops(db),
  };
}
