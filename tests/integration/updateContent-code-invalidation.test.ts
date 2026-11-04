/**
 * ★ `updateContent()` **改向量** ⇒ 该行的**码行必须失效**（C′ 档 T04 收尾 · 集成层）。
 *
 * ## 这条用例守的是什么（一个**静默**漏召回）
 *
 * 两段式剪枝（`src/vector/prune.ts`）的**全部正确性**建立在
 * 「码行是按 `memories.embedding` 的**当前值**编的」上（`eps` 是**这一条向量**的误差）：
 * `upper = q·x̂ + eps ≥ q·x`。
 *
 * `updateContent(id, content, now, embedding)` 会把向量**就地换成另一个值**
 * ⇒ 若码行留着，它描述的是**旧**向量 ⇒ `upper` **不再是**新向量的上界。
 * 两种命运：
 * · 新向量落到**别的细桶** ⇒ 码行 `fine_id` 是旧的 ⇒ `readCodes(fine_id IN …)` 取不到
 *   ⇒ 该行变「无码」⇒ 精确兜底 ⇒ **安全**（且 A6 的 `fineIdDrift` 会红）；
 * · ★ 新向量落到**同一个细桶** ⇒ 码行仍被取到、`fine_id` 也对得上
 *   ⇒ 剪枝按**过期的上界**跳过它 ⇒ **静默漏召回**（A6 / `codesMissing` 都查不出来）。
 *
 * ⇒ 本轮的修法（T04 收尾）：`updateContent()` 在**同一事务**里调
 *   `clearCodeRow()`（`src/vector/bucketAssign.ts`，**码表的唯一写入点**）—— **fail-open 降级**：
 *   立刻变「无码」⇒ 精确兜底（多读 3KB，**不漏召回**），`codesMissing` +1（可见）。
 *   ⚠️ **为什么删码在向量层、调用在存储层**：表名只在向量层出现（§4.6 步骤 2c）；
 *     `src/store/**` 里一个码表名都不许有（`tests/contracts/table-name-boundary.test.ts` 静态守着）。
 *     第一版把 SQL 直接写在 `updateContent.ts` 里 —— 那是**越界**，已改掉。
 *   ⚠️ **不做重编码**：码行的维护是 **T05** 的交付（收在 `assignBucket()` 这个唯一写入点里），
 *     在这里再写一份「编码 + 落码」就是第二份实现（`EPS_SAFETY_MARGIN` 只在一处生效
 *     ⇒ 上界在其中一条路上不再是上界）。
 *
 * ## ③ 反证（⚠️ **不是**断言，是实测记录 —— 变异实验的读数，2026-11-05）
 *
 * 把 `src/vector/bucketAssign.ts` 的 `clearCodeRow()` 里那条 `DELETE` **改成 no-op** 再跑
 * 同一个夹具（探针脚本读数，两种状态各跑一次）：
 *
 * ```
 * 带 DELETE（正确）：codes left = 0 | codesMissing = 1
 *                   pruned top-1 = [ 'm-00@1' ]   exact top-1 = [ 'm-00@1' ]   identical = true
 *                   k=1/3/20 逐位差异条数 = 0 / 0 / 0
 * 不删（变异）  ：codes left = 1 | codesMissing = 0
 *                   pruned top-1 = [ 'm-37@0.05962926149368286' ]   ← **漏掉了真第 1 名**
 *                   exact  top-1 = [ 'm-00@1' ]                    ← 全量精确参照
 *                   identical = false
 *                   k=1/3/20 逐位差异条数 = 1 / 3 / 0
 * ```
 * ⇒ 「① 码行被删 / ② 结果逐位相同」这两条断言在**没删码**时都会红（k = 1 / 3 会红）。
 *
 * ⚠️ **诚实记**：`k = 20` 那一档**抓不到**这个变异 —— 堆要 20 次读才满，
 *   而目标行的过期上界排在队尾，等到它有资格被早停跳过时，第 20 名的分已经低到
 *   `upper ≥ 第 20 名` ⇒ 它还是被读了 ⇒ 结果侥幸正确。
 *   ⇒ 本用例刻意钉 `k = 1 / 3 / 20` **三档**：抓变异的是前两档，
 *     第三档守的是「大 k 下也不许变」（顺带说明**为什么**「静默漏召回」难被发现：
 *     换个 `k` 就看不到了）。
 *
 * ⚠️ 夹具是**手写几何**（2 个细桶）：本文件测的不是「训练质量」，
 *   而是「改向量之后码行还在不在、结果还对不对」⇒ 用真训练反而让「哪一位不同」变成灾难。
 */

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { cosineOf } from '../../src/store/dedupCandidates.js';
import { EventWriter } from '../../src/store/events.js';
import { type UpdateContentStore, updateContent } from '../../src/store/updateContent.js';
import { MemoryLogger } from '../../src/util/log.js';
import { CentroidCache, type IvfCentroidModel, vectorToBlob } from '../../src/vector/centroids.js';
import { normalizeNumbers } from '../../src/vector/dot.js';
import {
  IvfVectorBackend,
  assignFineBucket,
  countUncodedCandidates,
  routeFineBuckets,
  scanBucketCandidates,
} from '../../src/vector/ivf.js';
import { codeToBlob, encodeVector } from '../../src/vector/quantize.js';
import {
  EMBED_DIM,
  axisVector,
  createTestDb,
  insertMemories,
  pseudoUnitVector,
} from '../fixtures/vector.js';

/** 生效参数（本文件不改参数，只用缺省值）。 */
const P: Params = DEFAULT_PARAMS;

/** 库内的时间基准（`content_history.replaced_at` 与事件时间戳）。 */
const T0 = 1_700_000_000_000;
const NOW = T0 + 86_400_000;

/** 目标记忆 id（`insertMemories()` 的第一条）。 */
const TARGET = 'm-00';

/** 除了目标行之外的条数（一次命中桶里 40 条 ⇒ `k = 1` 的堆必然在读到目标行之前就满）。 */
const OTHERS = 39;

/** 两个细桶（手工落库；生产是 `trainCentroids()` 派生的 `f-###-###` 形状）。 */
const FINE_PRIMARY = 'f-000-000';
const FINE_OTHER = 'f-000-001';
const COARSE = 'c-000';

/** 写路径的探针数（用**写入专用**的那一套，与 `dedupCandidates.ts` 一致）。 */
const WRITE_COARSE = P.ROUTER_NPROBE_WRITE_COARSE;
const WRITE_FINE = P.ROUTER_NPROBE_WRITE_FINE;

/** 一个「已训练 + 已落桶 + 已落码」的世界。 */
interface World {
  /** 库句柄。 */
  db: Database.Database;
  /** `updateContent()` 需要的上下文（库 + 参数 + 事件 + 桶归属）。 */
  store: UpdateContentStore;
  /** 中心模型（从库里加载 ⇒ 走真实加载路径）。 */
  model: IvfCentroidModel;
  /** 每条记忆的**当前**向量（与库里 `embedding` 同值；改向量后由调用方同步）。 */
  vectors: Map<string, Float32Array>;
  /** 目标行改向量**之前**的细桶（= 新向量也会落到的那个桶 ⇒ 危险形状）。 */
  fineId: string;
  /** 全部记忆 id。 */
  ids: string[];
}

/** 读某个 id 的码行数（`vector_codes` 对 `memory_id` 有唯一索引 ⇒ 只可能是 0 / 1）。 */
function countCodes(db: Database.Database, id: string): number {
  const row = db.prepare('SELECT count(*) AS n FROM vector_codes WHERE memory_id = ?').get(id) as {
    n: number;
  };
  return row.n;
}

/** 读某个 id 的桶归属（`null` = 不在桶里）。 */
function memberBucketOf(db: Database.Database, id: string): string | null {
  const row = db.prepare('SELECT fine_id FROM vector_cell_members WHERE memory_id = ?').get(id) as
    | { fine_id: string }
    | undefined;
  return row?.fine_id ?? null;
}

/**
 * 建世界。
 *
 * 几何（**刻意做成「新旧向量同桶」**）：
 * · 目标行的**旧**向量 = `e0`、**新**向量 = `e1` ⇒ 两者余弦 = 0（差得足够远，
 *   过期上界一定**不再是**上界），而两个细中心是 `normalize(e0+e1)` 与 `normalize(e2+e3)`
 *   ⇒ `e0` 与 `e1` 到前者的点积**都是 0.707** ⇒ **落到同一个细桶**（这就是危险形状）；
 * · 其余 39 条是确定性伪随机单位向量（`pseudoUnitVector`）⇒ 与 `e1` 的余弦不可能是 1
 *   ⇒ 全量精确参照的第 1 名**必然**是目标行 ⇒ 「逐位相同」不是空转。
 *
 * @returns 世界
 */
function buildWorld(): World {
  const db = createTestDb();

  // ── 向量：第 0 条是目标（旧向量 e0），其余确定性伪随机 ──
  const vectors: Float32Array[] = [axisVector(0)];
  for (let index = 0; index < OTHERS; index += 1) {
    vectors.push(pseudoUnitVector(index + 1));
  }
  const ids = insertMemories(db, vectors);
  const targetId = ids[0] as string;
  if (targetId !== TARGET) {
    throw new Error(`夹具假设第 0 条是 ${TARGET}，实际是 ${targetId}`);
  }

  // ── 中心（手工落库：粗 1 / 细 2）──
  const primary = normalizeNumbers(combine(axisVector(0), axisVector(1)));
  const other = normalizeNumbers(combine(axisVector(2), axisVector(3)));
  db.prepare(
    'INSERT INTO vector_coarse_cells (coarse_id, centroid, updated_at) VALUES (?, ?, ?)',
  ).run(COARSE, vectorToBlob(primary), T0);
  const insertFine = db.prepare(
    'INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at) VALUES (?, ?, ?, ?)',
  );
  insertFine.run(FINE_PRIMARY, COARSE, vectorToBlob(primary), T0);
  insertFine.run(FINE_OTHER, COARSE, vectorToBlob(other), T0);

  const cache = new CentroidCache(db);
  const model = cache.model();

  // ── 桶归属 + 码行（**按生产同一套归桶规则**算归属，不手写桶 id）──
  const insertMember = db.prepare(
    'INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)',
  );
  const insertCode = db.prepare(
    'INSERT INTO vector_codes (fine_id, memory_id, code, scale, eps) VALUES (?, ?, ?, ?, ?)',
  );
  const vectorById = new Map<string, Float32Array>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index] as string;
    const vector = vectors[index] as Float32Array;
    vectorById.set(id, vector);
    const fineId = assignFineBucket(model, vector, P.ROUTER_NPROBE_COARSE) ?? FINE_PRIMARY;
    insertMember.run(fineId, id);
    const encoded = encodeVector(vector);
    insertCode.run(fineId, id, codeToBlob(encoded.code), encoded.scale, encoded.eps);
  }

  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => NOW,
  });
  const fineId = memberBucketOf(db, TARGET);
  if (fineId === null) {
    throw new Error('夹具自检失败：目标行没有桶归属');
  }
  return {
    db,
    store: {
      db,
      params: P,
      events,
      buckets: { db, centroids: () => cache.model(), nprobeCoarse: P.ROUTER_NPROBE_COARSE },
    },
    model,
    vectors: vectorById,
    fineId,
    ids,
  };
}

/** 把两条 one-hot 向量加起来（模长 `√2`，由调用方归一化）。 */
function combine(left: Float32Array, right: Float32Array): number[] {
  const out = new Array<number>(left.length).fill(0);
  for (let index = 0; index < left.length; index += 1) {
    out[index] = (left[index] as number) + (right[index] as number);
  }
  return out;
}

/** 造一个 IVF 后端（`prune = false` ⇒ HEAD 的全量精确点积，本文件的参照物）。 */
function makeBackend(world: World, prune: boolean): IvfVectorBackend {
  const backend = new IvfVectorBackend({
    db: world.db,
    centroids: () => world.model,
    nprobeCoarse: 1,
    // 探针吃满（2 个细桶）⇒ 命中桶 = 全部桶 ⇒ 参照与剪枝看的是**同一批成员**
    nprobeFine: 2,
    prune,
  });
  backend.init({ dimensions: EMBED_DIM, coarseCenters: 1, fineCenters: 2 });
  return backend;
}

/** 一条「下游会留下」的候选（写路径 `collectVectorCandidates()` 的口径）。 */
interface ExpectedCandidate {
  /** 记忆 id。 */
  id: string;
  /** 余弦。 */
  cos: number;
}

/**
 * 从**全量候选行**独立算一遍「下游会留在候选集里的东西」
 * （§4.9 步骤 3a2：`cos ≥ DEDUP_COS_MIN` ⇒ (cos 降序, id 升序) ⇒ 前 `VECTOR_TOPK`）。
 *
 * ⚠️ **排序与过滤手写**（不复用 `pruneTopK`）：否则测的是「生产代码 == 生产代码」。
 * ⚠️ 但余弦**必须**用同一份实现（`cosineOf`，C36）。
 *
 * @param query 查询向量
 * @param rows 全量候选行（含 `embedding` BLOB）
 * @returns 期望的候选序列
 */
function referenceWriteCandidates(
  query: Float32Array,
  rows: readonly { id: string; embedding: Buffer }[],
): ExpectedCandidate[] {
  const scored: ExpectedCandidate[] = [];
  for (const row of rows) {
    const vector = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    const cos = cosineOf(query, vector);
    if (cos === null || cos < P.DEDUP_COS_MIN) {
      continue;
    }
    scored.push({ id: row.id, cos });
  }
  scored.sort((left, right) => {
    if (left.cos !== right.cos) {
      return right.cos - left.cos;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return scored.slice(0, P.VECTOR_TOPK);
}

/**
 * 把目标行的正文改掉、并把向量换成 `query`（= `e1`，与旧向量 `e0` 余弦 = 0、但**同一个细桶**）。
 *
 * @param world 世界（会同步更新 `world.vectors` 里目标行的当前向量）
 * @param query 新向量
 * @returns 命中桶集（`routeFineBuckets()` 的产物，`codesMissing` 要用它）
 */
function changeTargetVector(world: World, query: Float32Array): readonly string[] {
  updateContent(world.store, TARGET, '她把猫粮记成了狗粮（已人工改正）', NOW, [...query]);
  world.vectors.set(TARGET, query);
  return routeFineBuckets(world.model, query, 1, 2);
}

describe('T04 收尾 · `updateContent()` 改向量 ⇒ 码行失效（同桶 ⇒ 过期上界）', () => {
  it('★ ① 新向量落在**同一个细桶**时：该行的码行必须被删掉（fail-open 降级）', () => {
    const world = buildWorld();
    const query = axisVector(1); // = 目标行的**新**向量

    // ══════════ 前提自检（这几条不成立，本用例测的就不是那个危险形状）══════════
    // ① 旧向量与新向量**落到同一个细桶**（同桶 ⇒ 码行仍会被 `readCodes()` 取到）
    expect(assignFineBucket(world.model, axisVector(0), P.ROUTER_NPROBE_COARSE)).toBe(world.fineId);
    expect(assignFineBucket(world.model, query, P.ROUTER_NPROBE_COARSE)).toBe(world.fineId);
    // ② 目标行此刻**有码**（码是按旧向量编的 ⇒ 一旦留着就是过期上界）
    expect(countCodes(world.db, TARGET)).toBe(1);
    // ③ 目标行在桶里 ⇒ 它是候选宇宙的成员（不是「反正也不会被扫到」）
    expect(memberBucketOf(world.db, TARGET)).toBe(world.fineId);
    // ④ 命中桶里此刻**一条无码行都没有**（改完之后 `codesMissing` 从 0 变 1 ⇒ 可见）
    const before = routeFineBuckets(world.model, query, 1, 2);
    expect(before).toContain(world.fineId);
    expect(countUncodedCandidates(world.db, before)).toBe(0);

    // ══════════ 改正文 + 换向量（新旧向量余弦 = 0，但同桶）══════════
    const hitBuckets = changeTargetVector(world, query);

    // ★ ① 码行**被删掉**（本轮的修法：fail-open 降级，不重编码）
    expect(countCodes(world.db, TARGET)).toBe(0);
    // ★ 桶归属**没变**（同桶）⇒ 「靠 `fine_id` 漂移兜底」这条路在这里根本不存在，
    //   也就是说：**只有删码**才能让该行退出剪枝（这正是本用例存在的理由）
    expect(memberBucketOf(world.db, TARGET)).toBe(world.fineId);
    // ★ 该行变成「无码」⇒ `codesMissing` 从 0 变 1（**可观测**：降级不是静默的）
    expect(countUncodedCandidates(world.db, hitBuckets)).toBe(1);
    // ★ 其余行的码**一行都没被误删**
    let codedOthers = 0;
    for (const id of world.ids) {
      if (id !== TARGET) {
        codedOthers += countCodes(world.db, id);
      }
    }
    expect(codedOthers).toBe(world.ids.length - 1);

    world.db.close();
  });

  it('★ ② 删码之后：读路径 / 写路径与「全量精确参照」**逐位相同**（无码 ⇒ 兜底 ⇒ 不漏）', () => {
    const world = buildWorld();
    const query = axisVector(1);
    changeTargetVector(world, query);

    // ══════════ ★ ② 读路径：`prune = true` vs `prune = false`（全量精确参照）══════════
    const pruned = makeBackend(world, true);
    const exact = makeBackend(world, false);
    for (const k of [1, 3, 20]) {
      const prunedHits = pruned.search(query, k);
      const exactHits = exact.search(query, k);
      // 逐位（id 序列 + 每一个 score 的 `Object.is`）
      expect(prunedHits.map((hit) => hit.id)).toEqual(exactHits.map((hit) => hit.id));
      for (let index = 0; index < exactHits.length; index += 1) {
        expect(Object.is(prunedHits[index]?.score, exactHits[index]?.score)).toBe(true);
      }
    }
    // ── 负控：参照里**真的有**目标行，且它就是第 1 名 —— 否则上面那组「逐位相同」是空转 ──
    const reference = exact.search(query, 1);
    expect(reference.map((hit) => hit.id)).toEqual([TARGET]);
    expect(reference[0]?.score).toBe(1);

    // ══════════ ★ 写路径同样逐位相同（`collectVectorCandidates()` 的引擎）══════════
    const scoreOf = (id: string): number | null => cosineOf(query, world.vectors.get(id) ?? null);
    const writePruned = scanBucketCandidates(
      world.db,
      world.model,
      query,
      WRITE_COARSE,
      WRITE_FINE,
      {
        threshold: P.DEDUP_COS_MIN,
        k: P.VECTOR_TOPK,
        scoreOf,
      },
    );
    const writeHead = scanBucketCandidates(world.db, world.model, query, WRITE_COARSE, WRITE_FINE, {
      prune: false,
    });
    // ⚠️ `prune = false` 返回的是**全部成员行**（HEAD 行为：门槛与 top-K 归下游）
    //   ⇒ 两边都必须过一遍**下游口径**才可比（与 `dedupCandidates.ts` 的职责划分一致）。
    expect(referenceWriteCandidates(query, writePruned.rows)).toEqual(
      referenceWriteCandidates(query, writeHead.rows),
    );
    // ── 负控：下游候选里**真的有**目标行（否则上面那条比的可能是「两边都空」）──
    expect(referenceWriteCandidates(query, writePruned.rows).map((item) => item.id)).toEqual([
      TARGET,
    ]);
    // ── `scanned` = 候选宇宙（成员数），与码表状态无关 ⇒ 两边相同 ──
    expect(writePruned.scanned).toBe(writeHead.scanned);
    // ── `uncoded` 如实 +1（目标行现在是唯一一条无码行）──
    expect(writePruned.uncoded).toBe(1);

    world.db.close();
  });
});
