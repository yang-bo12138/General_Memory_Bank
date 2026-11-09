/**
 * ★ **只读诊断脚本**（**不碰仓库任何源文件**；落在 `.tmp/` ⇒ gitignored ⇒ 不进提交）。
 *
 * ⚠️ **为什么需要它**（口径裁决落地 #1 的经验闸门）：
 *   要报「读路径**逐样本**的『实测桶成员行』vs『route 侧推算桶成员行』」的**原始数**
 *   ⇒ ⇒ 两条路：
 *     ① 在 `bench/perf.ts` 里加临时打印 ⇒ ⇒ **会撞上「正在改文件的瞬间」**（⇒ verify 可能假红）
 *     ② **另写一个脚本、用同一套生产件复刻那个读循环** ⇒ ⇒ **仓库一个字不动** ✅
 *   ⇒ ⇒ 选 ②。
 *
 * ⚠️ ★ **它复刻的是 `bench/perf.ts` 读路径的那个循环**（逐字同形）：
 *   `route()` → `snapshot()` → `start()` → `search()` → `stop()` → `snapshot()`
 *   ⇒ ⇒ 两边的量**与 bench 里那个是同一个口径**。
 */

import { join } from 'node:path';

import { DEFAULT_CORPUS_OPTIONS, generateQueries } from '../../bench/corpus.js';
import { installRowReadCounter } from '../../bench/lib/harness.js';
import { prepareBench } from '../../bench/lib/db.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { countBucketMembers } from '../../src/vector/bucketAssign.js';
import { loadCentroidModel } from '../../src/vector/centroids.js';
import { IvfVectorBackend } from '../../src/vector/ivf.js';

const SCALE = 2000;
const QUERIES = 20;
const DB_PATH = join(process.cwd(), '.tmp', 'bench', 'perf-2000.db');

/** 读路径的候选宇宙（与 `bench/perf.ts` 的 `countDistinctMembers()` 逐字同形）。 */
function countDistinctMembers(
  db: Parameters<typeof countBucketMembers>[0],
  fineIds: readonly string[],
): number {
  if (fineIds.length === 0) {
    return 0;
  }
  const placeholders = fineIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      'SELECT COUNT(DISTINCT memory_id) AS n FROM vector_cell_members ' +
        `WHERE fine_id IN (${placeholders})`,
    )
    .get(...fineIds) as { n: number };
  return row.n;
}

const options = { ...DEFAULT_CORPUS_OPTIONS, size: SCALE };
const prepared = prepareBench({
  dbPath: DB_PATH,
  corpus: options,
  coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
  fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
  nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
  reuseExisting: true,
  forceRebuild: true,
});
const db = prepared.db;

const model = loadCentroidModel(db);
const backend = new IvfVectorBackend({
  db,
  centroids: () => model,
  nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
  nprobeFine: DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
});
backend.init({
  dimensions: DEFAULT_PARAMS.EMBED_DIM,
  coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
  fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
});

const queries = generateQueries(options, QUERIES);
const counter = installRowReadCounter(db);

/** 桶成员数的缓存（与 `bench/perf.ts` 的 `membersOf()` 同形）。 */
const cache = new Map<string, number>();
const membersOf = (fineId: string): number => {
  const hit = cache.get(fineId);
  if (hit !== undefined) {
    return hit;
  }
  const count = countBucketMembers(db, fineId);
  cache.set(fineId, count);
  return count;
};

let allEqual = true;
console.log('样本 | 实测桶成员行 | 推算桶成员行 | 相等? | 差值 | candidateUniverse');
for (const query of queries) {
  const fineIds = backend.route(
    query.embedding,
    DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
  );
  const before = counter.snapshot();
  counter.start();
  backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
  counter.stop();
  const after = counter.snapshot();

  const measured = after.bucketMemberRowsRead - before.bucketMemberRowsRead;
  let derived = 0;
  for (const fineId of fineIds) {
    derived += membersOf(fineId);
  }
  const equal = measured === derived;
  if (!equal) {
    allEqual = false;
  }
  const universe = countDistinctMembers(db, fineIds);
  console.log(
    `${String(queries.indexOf(query)).padStart(4)} | ` +
      `${String(measured).padStart(10)} | ${String(derived).padStart(10)} | ` +
      `${equal ? '  yes' : '   NO'} | ${String(measured - derived).padStart(5)} | ${universe}`,
  );
}
counter.uninstall();
console.log(`\n⇒ 逐样本全部相等？ ${allEqual ? '是' : '否'}`);
db.close();
