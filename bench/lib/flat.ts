/**
 * **flat 全表扫描参照实现**（bench 侧）—— P2-T08 的「用 flat 全表扫描作参照」。
 *
 * ⚠️ **为什么 bench 侧另写一份，而不用 `src/vector/flat.ts` 的 `FlatVectorBackend`**：
 *   ① **内存**：`FlatVectorBackend` 的候选来源是「**全部**候选行的数组」
 *      ⇒ 100 万条 × 768 维 × 4 字节 = **3.07GB** 的 Float32Array 一次性物化
 *      ⇒ 本机（16GB、其它进程已占约 11.6GB）**直接 OOM**；
 *      ⇒ bench 侧改成**流式扫**（`statement.iterate()`）⇒ 峰值内存 ≈ 一行向量。
 *   ② **口径必须一致**：流式版**复用生产的 `dot()` / `clampCos()` / `passesTimeWindow()`
 *      / `compareHits()`** ⇒ 分数与排序**逐位相同**。
 *   ⇒ **等价性由断言保证**：`flatStreamMismatches()` 在小规模上
 *      把流式版与**生产的 `FlatVectorBackend`** 逐条比对（id 顺序 + 分数逐位相同）
 *      ⇒ 它在冒烟门禁里（`tests/bench/bench-smoke.test.ts`）。
 *
 * ⚠️ **C29 的分母纪律**：flat 的**候选全集** = 「未删 且 有向量」的行
 *   （**不是** flat 的 top-N）⇒ 分桶 ⊆ flat 的断言用**这个全集**当分母。
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { clampCos } from '../../src/core/scoring.js';
import { blobToVector } from '../../src/vector/centroids.js';
import { dot } from '../../src/vector/dot.js';
import {
  FlatVectorBackend,
  type VectorCandidateRow,
  compareHits,
  passesTimeWindow,
} from '../../src/vector/flat.js';
import { EMBED_DIM } from '../embedder.js';

/**
 * 解码用的 **scratch 缓冲**（**模块级、复用**）。
 *
 * ⚠️ **为什么不能每行调生产的 `blobToVector()`**：它每次都
 *   `Buffer.from(blob)`（**整份拷贝**）+ `new Float32Array(768)`（**再分配**）
 *   ⇒ 100 万行 = 每查询 3GB 的垃圾 ⇒ GC 成为主要耗时，**测出来的是 GC 不是扫描**。
 *   ⇒ 这里改成「**读进复用的缓冲**」⇒ 峰值内存 ∝ 一条向量。
 *
 * ⚠️ **口径与生产一致**：生产的 `blobToVector()` 是
 *   `DataView.getFloat32(index * 4, true)` ⇒ **小端 float32**
 *   ⇒ 这里用 `Buffer.readFloatLE()`（**同一种字节序**）⇒ 数值逐位相同。
 */
const DECODE_SCRATCH = new Float32Array(EMBED_DIM);

/**
 * 把 BLOB 解进**复用的缓冲**（小端 float32 ⇒ 与生产 `blobToVector()` 逐位相同）。
 *
 * @param blob BLOB
 * @returns 解码后的向量（**复用缓冲 ⇒ 调用方只许读，不许留引用**）
 */
function decodeInto(blob: Buffer): Float32Array {
  const count = Math.min(EMBED_DIM, Math.floor(blob.byteLength / 4));
  for (let index = 0; index < count; index += 1) {
    DECODE_SCRATCH[index] = blob.readFloatLE(index * 4);
  }
  for (let index = count; index < EMBED_DIM; index += 1) {
    DECODE_SCRATCH[index] = 0;
  }
  return DECODE_SCRATCH;
}

/** 一条命中（**与 `VectorHit` 同构**：id + 余弦）。 */
export interface FlatHit {
  /** 记忆 id。 */
  readonly id: string;
  /** 余弦（**已钳制到 [0,1]**）。 */
  readonly score: number;
}

/**
 * flat 的**候选全集**（id 集合）—— **C29 的分母**。
 *
 * ⚠️ **不是 flat 的 top-N**：用 top-N 当分母 ⇒ 探针不足会被误判成算法错误（假失败）。
 *
 * @param db 库句柄
 * @returns 候选全集（id 集合）
 */
export function flatCandidateUniverse(db: Database.Database): Set<string> {
  const rows = db
    .prepare('SELECT id FROM memories WHERE deleted = 0 AND embedding IS NOT NULL')
    .all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * flat 的**候选全集条数**（C29 的分母大小）。
 *
 * @param db 库句柄
 * @returns 条数
 */
export function flatCandidateCount(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL')
    .get() as { n: number };
  return row.n;
}

/**
 * 流式 flat 扫描，取**精确 top-K**。
 *
 * ⚠️ **流式**：`statement.iterate()` 一次只持有一行 ⇒ 峰值内存与语料规模**脱钩**。
 * ⚠️ **分数口径与生产一致**：`dot()`（float64 累加）+ `clampCos()`（钳到 [0,1]）。
 * ⚠️ **排序口径与生产一致**：`compareHits()`（分数降序；同分按 id 升序）。
 *
 * @param db 库句柄
 * @param query 查询向量（**已 L2 归一化**）
 * @param k 取前 K 条
 * @param filter 候选过滤（时间窗；**缺省 = 不施加**）
 * @param restrict 可选的候选白名单（**桶内精确性断言**用：只扫命中桶的成员）
 * @returns 精确 top-K（**按生产排序**）
 */
export function flatTopK(
  db: Database.Database,
  query: Float32Array,
  k: number,
  filter?: { timeFloor?: number; pinnedTimeFloor?: number },
  restrict?: ReadonlySet<string>,
): FlatHit[] {
  if (k <= 0) {
    return [];
  }
  const best: FlatHit[] = [];
  // ⚠️ **有 `restrict` 时直接按 id 取行**（不全表扫描）：
  //   「对同一个桶集合做全量精确扫描」的**候选集合**就是那些 id
  //   ⇒ 按 id 取行与「全表扫描后过滤」**结果完全一致**，但**不用扫 100 万行**
  //   ⇒ 否则每个查询都要重扫一遍 4.4GB 的库（磁盘受限 ≈ 20 分钟/次）。
  const rows = restrict === undefined ? scanAll(db) : scanByIds(db, restrict);
  for (const row of rows) {
    const candidate: VectorCandidateRow = {
      id: row.id,
      vector: decodeInto(row.embedding),
      lastAccess: row.last_access,
      pinFactor: row.pin_factor,
    };
    if (filter !== undefined && !passesTimeWindow(candidate, filter)) {
      continue;
    }
    insertTopK(best, { id: row.id, score: clampCos(dot(query, candidate.vector)) }, k);
  }
  return best;
}

/**
 * 一行候选（与生产 `VectorCandidateRow` 同形）。
 */
interface CandidateRow {
  /** 记忆 id。 */
  readonly id: string;
  /** 向量 BLOB。 */
  readonly embedding: Buffer;
  /** 最后访问时间。 */
  readonly last_access: number;
  /** 钉固因子。 */
  readonly pin_factor: number;
}

/**
 * 扫**全表**（候选集合 = 未删 且 有向量）。
 *
 * @param db 库句柄
 * @returns 候选行（流式）
 */
function scanAll(db: Database.Database): IterableIterator<CandidateRow> {
  const statement = db.prepare(
    'SELECT id, embedding, last_access, pin_factor FROM memories ' +
      'WHERE deleted = 0 AND embedding IS NOT NULL',
  );
  return statement.iterate() as IterableIterator<CandidateRow>;
}

/**
 * 按 **id 白名单**取行（分块，避免参数上限）。
 *
 * ⚠️ **语义与「全表扫描 + 过滤」完全一致**：
 *   同一个 `WHERE deleted = 0 AND embedding IS NOT NULL` 条件 ⇒ 同一批行。
 *
 * @param db 库句柄
 * @param ids id 白名单
 * @returns 候选行
 */
function scanByIds(
  db: Database.Database,
  ids: ReadonlySet<string>,
): IterableIterator<CandidateRow> {
  const rows: CandidateRow[] = [];
  // ⚠️ ★ **一条一个 id 地请求**（**不用** `id IN (500 个值)`）：
  //   SQLite 的估算在 `IN` 列表很长时会**改用全表扫描**（而不是主键索引）
  //   ⇒ 桶内核对一次就能把 **2.17GB 的库整个重读一遍**。
  //   ⇒ 改成 `id = ?`（必走主键索引）⇒ 每条只读自己那一页。
  const statement = db.prepare(
    'SELECT id, embedding, last_access, pin_factor FROM memories ' +
      'WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL',
  );
  for (const id of ids) {
    const row = statement.get(id) as CandidateRow | undefined;
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return rows[Symbol.iterator]() as IterableIterator<CandidateRow>;
}

/**
 * **一遍全表，同时算多条查询的精确 top-K**（flat 参照的批量版）。
 *
 * ⚠️ **为什么要批量版**：百万条下 flat 参照是**磁盘受限**（本机 ~2.4MB/s）
 *   ⇒ 每个查询单独扫一遍 2.17GB 的库 ≈ **15 分钟**；
 *   ⇒ 而「同一个候选集合」的 top-K 只依赖**候选集合**，不依赖查询的顺序
 *   ⇒ 把 N 条查询**合成一遍扫描**时，每条查询仍是**全表精确 top-K**（**口径不变**）
 *   ⇒ 而磁盘 I/O 从 N 遍降到 1 遍。
 *
 * ⚠️ **分数与顺序与单查询版逐位相同**（同一个 `dot()` + `clampCos()` + `compareHits()`）。
 *
 * @param db 库句柄
 * @param queries 查询向量列表
 * @param k 每条查询取前 K 条
 * @returns 每条查询的精确 top-K（与查询同序）
 */
export function flatTopKMulti(
  db: Database.Database,
  queries: readonly Float32Array[],
  k: number,
): FlatHit[][] {
  const best: FlatHit[][] = queries.map(() => []);
  if (k <= 0 || queries.length === 0) {
    return best;
  }
  for (const row of scanAll(db)) {
    const vector = decodeInto(row.embedding);
    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index];
      if (query === undefined) {
        continue;
      }
      insertTopK(best[index] as FlatHit[], { id: row.id, score: clampCos(dot(query, vector)) }, k);
    }
  }
  return best;
}

/**
 * 把一条命中插进「已排序的前 K 名」数组（**保持生产排序**：分数降序、同分 id 升序）。
 *
 * ⚠️ **为什么要维护有序数组而不是「收集完再排序」**：流式扫 100 万行时
 *   全收集 = 100 万个对象 ⇒ 内存暴涨 ⇒ 而前 K 名只有 20 个 ⇒ 有序数组即可。
 *
 * ⚠️ ★ **`compareHits` 的符号约定（这里最容易搞反）**：
 *   生产的 `compareHits(left, right)` 在分数不同时返回 `right.score - left.score`
 *   ⇒ **正值 ⇒ `left` 更差**；分数相同时按 id 升序（`left.id < right.id` ⇒ `-1`）。
 *   ⇒ 于是：
 *   · 「这条比当前第 K 名还差 ⇒ 不进前 K」⇒ `compareHits(hit, worst) > 0`；
 *   · 「前一条已经比这条好 ⇒ 停在这里」⇒ `compareHits(previous, hit) <= 0`。
 *   ⚠️ **这两个符号写反 ⇒ 返回的正好是「最差的前 K 条」**（实测踩过：
 *     平分时保留的是 id 最大的那批 ⇒ 与 flat 参照完全不重合 ⇒ 吻合率恒为 0）。
 *
 * @param best 已排序的数组（**最好的在前**）
 * @param hit 新命中
 * @param k 保留条数
 */
function insertTopK(best: FlatHit[], hit: FlatHit, k: number): void {
  if (best.length >= k) {
    const worst = best[k - 1];
    if (worst !== undefined && compareHits(hit, worst) > 0) {
      return;
    }
  }
  let index = best.length;
  while (index > 0) {
    const previous = best[index - 1];
    if (previous === undefined || compareHits(previous, hit) <= 0) {
      break;
    }
    best[index] = previous;
    index -= 1;
  }
  best[index] = hit;
  if (best.length > k) {
    best.length = k;
  }
}

/**
 * ★ **等价性断言**：bench 的流式 flat 扫描 ≡ 生产的 `FlatVectorBackend`。
 *
 * ⚠️ **为什么必须有这条**：bench 侧另写了一份 flat 扫描（为了**流式、不爆内存**）
 *   ⇒ 两份实现一旦漂移 ⇒ **吻合率的分母/分子都是错的** ⇒ 整个结论无效
 *   ⇒ 必须在**小规模**上把两者**逐条比对**（id 顺序 + 分数逐位相同）。
 *
 * ⚠️ **为什么只能在小规模做**：生产的 `FlatVectorBackend` 的候选来源是
 *   「**全部**候选行的数组」⇒ 100 万条 = 3GB ⇒ 只能在几千条上做这个比对。
 *   ⇒ 这正是「小规模冒烟」存在的意义（见 `tests/bench/bench-smoke.test.ts`）。
 *
 * @param db 库句柄
 * @param query 查询向量
 * @param k 取前 K 条
 * @returns 不一致清单（**空数组 = 逐条相同**）
 */
export function flatStreamMismatches(
  db: Database.Database,
  query: Float32Array,
  k: number,
): string[] {
  const production = new FlatVectorBackend({
    rows: () => {
      const rows = db
        .prepare(
          'SELECT id, embedding, last_access, pin_factor FROM memories ' +
            'WHERE deleted = 0 AND embedding IS NOT NULL',
        )
        .all() as Array<{
        id: string;
        embedding: Buffer;
        last_access: number;
        pin_factor: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        vector: blobToVector(row.embedding),
        lastAccess: row.last_access,
        pinFactor: row.pin_factor,
      }));
    },
  });
  production.init({
    dimensions: DEFAULT_PARAMS.EMBED_DIM,
    coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
    fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
  });
  const expected = production.search(query, k);
  const actual = flatTopK(db, query, k);
  const mismatches: string[] = [];
  if (expected.length !== actual.length) {
    mismatches.push(`条数不同：生产 ${expected.length} 条 vs 流式 ${actual.length} 条`);
  }
  const limit = Math.min(expected.length, actual.length);
  for (let index = 0; index < limit; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left === undefined || right === undefined) {
      break;
    }
    if (left.id !== right.id) {
      mismatches.push(`第 ${index + 1} 名 id 不同：生产 ${left.id} vs 流式 ${right.id}`);
      break;
    }
    if (left.score !== right.score) {
      mismatches.push(
        `第 ${index + 1} 名分数不同：生产 ${left.score} vs 流式 ${right.score}（${left.id}）`,
      );
      break;
    }
  }
  return mismatches;
}
