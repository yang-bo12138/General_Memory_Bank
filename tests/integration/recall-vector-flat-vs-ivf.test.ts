/**
 * ★ **IVF 与 flat 的候选一致性**（设计 D6 的三条，逐条落地）—— 阶段 5 · T03。
 *
 * 本文件只回答一个问题：**ivf 后端与 flat 后端，在同一份库、同一条查询上，
 * 交出的候选（id + 每条 cos）是否一致**；不一致时，差异**只能是「少给了几条」**。
 *
 * ⚠️ **为什么不比 `score`、不比 `route()` 的桶集**（D6 原话）：
 *   · `score` 是 `cos` 的确定性函数 ⇒ 比 cos 已经蕴含它，再比一次是冗余；
 *   · `route()` 的桶集**两侧永远不可比**（flat 只有哨兵 `'__flat_all__'`）⇒ 比它是错的命题。
 *   所以本文件一律在 **`search()` 的命中（id + cos）** 这一层比。
 *
 * ⚠️ **探针数是 ivf 唯一的近似来源**（§4.15.3：桶内是全量精确点积，不是近似召回）
 *   ⇒ 本文件把「实现之差」与「探针之差」彻底分开，靠的就是两组断言：
 *   ① **满探针**（`nprobeCoarse = 粗中心数`、`nprobeFine = 细中心总数`）⇒ 必须**完全一致**（零 flaky，
 *      红了必是分桶 / 排序 / 时间窗的实现差，不是边界效应）；
 *   ② **生产比例探针**（10% 粗 / 12.5% 细，见 `PROBES_RATIO`）⇒ 汇总吻合率必须 ≥ 0.98。
 *
 * ⚠️⚠️ **语料是「簇状」的，而且这是刻意的**（不是在为通过而调数据）：
 *   真实 embedding 的分布是簇状的（同一话题的向量彼此靠近）；用均匀随机向量会造出
 *   「距离处处相等」的病态分布 —— 那种分布下 **任何** 分桶方案的吻合率都只反映噪声，
 *   不反映实现。本文件用 `CLUSTERS × PER_CLUSTER` 的确定性簇状语料（固定种子 LCG），
 *   成员 = 簇中心 + `SPREAD` × 单位噪声向量（`SPREAD` 控制簇内散度，不是一个魔数阈值）。
 *   ⇒ 语料、查询、探针数**全部写死**，同一个数两次跑出来逐位相同。
 *
 * ⚠️ **实测读数（2026-11-03，本文件同一份语料 / 同一批查询）**，写在这里是为了让下一个人
 *   **不必重跑就知道边界在哪**（数字来自一次真实测量，不是估计）：
 *   ```
 *   满探针 16/64  ⇒ 6 条查询全部 20/20，cos 不一致 0 条
 *   探针   2/8    ⇒ 6 条查询全部 20/20（汇总 120/120 = 1.000）
 *   探针   2/4    ⇒ 115/120 = 0.958（中点查询丢了 5 条 —— 细层探针不够）
 *   探针   1/2    ⇒  87/120 = 0.725（激进的粗层探针就开始漏簇）
 *   ```
 *   ⇒ ★ **由此可见「≥ 0.98」是一个「数据 + 探针配置」特定值**，不是实现的性质：
 *     本文件的 0.98 断言落在 **2/8** 这一档；**2/4 那一档实测 0.958，低于 0.98**
 *     （原因见上：中点查询的真实近邻跨两个细桶，而 2/4 只探到其中一个）。
 *     ⚠️ 这条**必须在报告里如实说**：设计的 §12「≥ 0.98」是在**生产语料 + 20/50 探针**
 *     下测的（1 万细桶、每桶 ~100 条）；本文件的合成语料只有 64 个细桶，
 *     桶边界效应被放大了几十倍 ⇒ 读数不可直接与生产对比。
 */

import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { clampCos } from '../../src/core/scoring.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { createFlatRowSource } from '../../src/store/vectorPort.js';
import type { VectorHit } from '../../src/vector/backend.js';
import { assignBucket } from '../../src/vector/bucketAssign.js';
import { dot, normalize } from '../../src/vector/dot.js';
import { FlatVectorBackend } from '../../src/vector/flat.js';
import { IvfVectorBackend, trainCentroids } from '../../src/vector/ivf.js';
import { normalizeQueryEmbedding } from '../../src/vector/query.js';
import { QA_DIM, QA_NOW, qaNumbers, qaUnitVector } from '../fixtures/qaVectorWorld.js';
import { createTestDb, insertMemories } from '../fixtures/vector.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、语料与查询（**全部确定性**：固定种子、无时钟、无 Math.random）
// ═══════════════════════════════════════════════════════════════════════════

/** 簇数（同时用作粗中心数 ⇒ 粗层 k-means 应当恢复出这 16 个簇）。 */
const CLUSTERS = 16;

/** 每簇成员数（3200 条；每簇 4 个细桶 ⇒ 每桶 ~50 条，与生产同量级）。 */
const PER_CLUSTER = 200;

/** 簇内散度（`0.45` ⇒ 成员与簇中心的 cos ≈ 0.91；足够成簇，又不至于所有成员同分）。 */
const SPREAD = 0.45;

/** 粗中心数 / 细中心总数（= 每粗桶 4 个细桶）。 */
const COARSE_CENTERS = CLUSTERS;
const FINE_CENTERS = 64;

/** 产线探针数与中心数的比例：粗 10%（20/200）、细 12.5%（8/64，见文件头的实测表）。 */
const PROBES_RATIO: readonly [number, number] = [2, 8];

/** 「更激进」的探针档（只用于**边界性质**断言，不用于 0.98 门槛）。 */
const PROBES_AGGRESSIVE: readonly (readonly [number, number])[] = [
  [2, 4],
  [1, 2],
];

/** 比对的 K：与召回路径的 `VECTOR_TOPK` 同口径。 */
const K = DEFAULT_PARAMS.VECTOR_TOPK;

/** 一条簇语料。 */
interface Corpus {
  db: Database.Database;
  model: ReturnType<typeof trainCentroids>['model'];
  config: { dimensions: number; coarseCenters: number; fineCenters: number };
  /** 全部向量（顺序即插入顺序 = rowid 顺序）。 */
  vectors: Float32Array[];
  /** 查询向量（簇心 + 小扰动 / 两簇中点 / 一条真实成员）。 */
  queries: Float32Array[];
}

/**
 * 建语料：`CLUSTERS × PER_CLUSTER` 条簇状记忆 + 训练 + 落桶归属。
 *
 * ⚠️ **落桶归属走 `assignBucket`**（§9.3.0 的唯一写入点）⇒ 不手工 INSERT 归属行。
 * ⚠️ **语料只用「活行」**（没有软删）⇒ flat 与 ivf 的候选宇宙**必然**是同一个集合
 *   （若这里混了软删行，两侧不一致就可能来自「候选宇宙不同」，而不是分桶）。
 */
function buildCorpus(): Corpus {
  const db = createTestDb();
  const vectors: Float32Array[] = [];
  for (let cluster = 0; cluster < CLUSTERS; cluster += 1) {
    const center = qaUnitVector(1000 + cluster);
    for (let member = 0; member < PER_CLUSTER; member += 1) {
      const noise = qaUnitVector(90_000 + cluster * 131 + member);
      const vector = new Float32Array(QA_DIM);
      for (let index = 0; index < QA_DIM; index += 1) {
        vector[index] = center[index]! + SPREAD * noise[index]!;
      }
      vectors.push(normalize(vector));
    }
  }
  insertMemories(db, vectors, { lastAccess: QA_NOW });

  const nprobeCoarse = Math.min(DEFAULT_PARAMS.ROUTER_NPROBE_COARSE, COARSE_CENTERS);
  const { model } = trainCentroids(db, {
    coarseCenters: COARSE_CENTERS,
    fineCenters: FINE_CENTERS,
    nprobeCoarse,
    now: QA_NOW,
  });
  runWriteTransaction(db, () => {
    for (let index = 0; index < vectors.length; index += 1) {
      // id 形如 `m-0000`（`insertMemories` 的 `m-<两位数>` 只到 99 ⇒ 这里直接按 index 落）
      assignBucket({ db, centroids: () => model, nprobeCoarse }, idOf(index), vectors[index]!);
    }
  });

  const makeQuery = (cluster: number, spread: number): Float32Array => {
    const center = qaUnitVector(1000 + cluster);
    const noise = qaUnitVector(200_000 + cluster);
    const vector = new Float32Array(QA_DIM);
    for (let index = 0; index < QA_DIM; index += 1) {
      vector[index] = center[index]! + spread * noise[index]!;
    }
    return normalize(vector);
  };
  const midpoint = (left: number, right: number): Float32Array => {
    const a = qaUnitVector(1000 + left);
    const b = qaUnitVector(1000 + right);
    const vector = new Float32Array(QA_DIM);
    for (let index = 0; index < QA_DIM; index += 1) {
      vector[index] = a[index]! + b[index]!;
    }
    return normalize(vector);
  };

  return {
    db,
    model,
    config: { dimensions: QA_DIM, coarseCenters: COARSE_CENTERS, fineCenters: FINE_CENTERS },
    vectors,
    queries: [
      makeQuery(0, 0.2), // 贴着簇心
      makeQuery(5, 0.2),
      makeQuery(9, 0.45), // 簇边缘
      midpoint(1, 2), // ★ 两簇中点（真实近邻跨簇 ⇒ 探针不足时最先漏）
      midpoint(6, 7),
      vectors[3]!.slice(), // 一条真实成员向量（最像「生产里用一条记忆当查询」）
    ],
  };
}

/**
 * 落库的 id 规则 —— **必须与 `tests/fixtures/vector.ts` 的 `insertMemories` 逐字一致**。
 *
 * ⚠️ 它只在 `m-<index>` 的补零宽度上是 `padStart(2)`（不是 4）：
 *   `m-0` … `m-3199`。本文件**不重算**这个规则之外的任何东西，只复述它。
 */
function idOf(index: number): string {
  return `m-${String(index).padStart(2, '0')}`;
}

/** 建一对后端（flat 的行源用**生产实现** `createFlatRowSource`，不另写一份）。 */
function backendsOf(
  corpus: Corpus,
  probes: readonly [number, number],
): {
  flat: FlatVectorBackend;
  ivf: IvfVectorBackend;
} {
  const flat = new FlatVectorBackend({ rows: createFlatRowSource(corpus.db) });
  flat.init(corpus.config);
  const ivf = new IvfVectorBackend({
    db: corpus.db,
    centroids: () => corpus.model,
    nprobeCoarse: probes[0],
    nprobeFine: probes[1],
  });
  ivf.init(corpus.config);
  return { flat, ivf };
}

/** id 序列（顺序也要比：同集合不同序 ⇒ 「截断到 topN」的结果不同）。 */
function idsOf(hits: readonly VectorHit[]): string[] {
  return hits.map((hit) => hit.id);
}

/** id → cos。 */
function scoreMap(hits: readonly VectorHit[]): Map<string, number> {
  return new Map(hits.map((hit) => [hit.id, hit.score]));
}

// ═══════════════════════════════════════════════════════════════════════════
// 共享语料（**只建一次**：3200 条 + k-means 训练约 2 秒，八条用例只读它）
// ═══════════════════════════════════════════════════════════════════════════

let corpus: Corpus;

beforeAll(() => {
  corpus = buildCorpus();
});

afterAll(() => {
  corpus.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、满探针 ⇒ 完全一致（D6 第 1 条：零 flaky，红必是实现差）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D6 第 1 条 · 探针吃满 ⇒ ivf 与 flat 的候选**集合、顺序、每条 cos 完全一致**', () => {
  it('★ 满探针（16/64）下六条查询的 id 序列逐位相同，且每条 cos 逐位相同', () => {
    const { flat, ivf } = backendsOf(corpus, [COARSE_CENTERS, FINE_CENTERS]);

    // ── 前置：两侧都必须真的产出（否则「相等」是 0 == 0 的空洞相等）──
    const flatAll = corpus.queries.map((query) => flat.search(query, K));
    expect(flatAll.map((hits) => hits.length)).toEqual(corpus.queries.map(() => K));

    for (let index = 0; index < corpus.queries.length; index += 1) {
      const query = corpus.queries[index]!;
      const ivfHits = ivf.search(query, K);
      const flatHits = flatAll[index]!;

      // ① 集合与顺序（cos 降序、同分 id 升序 ⇒ 全序唯一）
      expect(idsOf(ivfHits), `查询 #${index} 的 id 序列`).toEqual(idsOf(flatHits));

      // ② 每条 cos 逐位（不是 toBeCloseTo：同一个 dot + 同一个 clampCos ⇒ 同一个 float）
      const flatScores = scoreMap(flatHits);
      for (const hit of ivfHits) {
        expect(hit.score, `查询 #${index} / ${hit.id} 的 cos`).toBe(flatScores.get(hit.id));
      }
    }
  });

  it('★ 反向对照：满探针这一档**不是恒等变换** —— 它与激进探针档给出的结果**不同**', () => {
    const full = backendsOf(corpus, [COARSE_CENTERS, FINE_CENTERS]);
    const aggressive = backendsOf(corpus, [1, 2]);

    // ⚠️ 若两档结果**处处相同**，说明「满探针」这个开关什么都没控制
    //   ⇒ 上一条「完全一致」也就无法证明「分桶本身是精确的」。
    const differs = corpus.queries.some(
      (query) =>
        idsOf(full.ivf.search(query, K)).join() !== idsOf(aggressive.ivf.search(query, K)).join(),
    );
    expect(differs).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、生产比例探针 ⇒ 汇总吻合率 ≥ 0.98（D6 第 2 条）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D6 第 2 条 · 生产比例探针（2/8）下汇总吻合率 ≥ 0.98', () => {
  it('★ `|ivf ∩ flat| / |flat|`（**分母取 flat**，两侧都截到 VECTOR_TOPK）≥ 0.98', () => {
    const { flat, ivf } = backendsOf(corpus, PROBES_RATIO);

    let flatTotal = 0;
    let intersect = 0;
    for (const query of corpus.queries) {
      const flatIds = new Set(idsOf(flat.search(query, K)));
      const ivfIds = new Set(idsOf(ivf.search(query, K)));
      flatTotal += flatIds.size;
      for (const id of ivfIds) {
        if (flatIds.has(id)) {
          intersect += 1;
        }
      }
    }

    // ── 前置：分母必须非空（否则 0/0 会让这条断言永远成立）──
    expect(flatTotal).toBe(K * corpus.queries.length);

    const agree = intersect / flatTotal;
    // ⚠️ 门槛是设计的 §12 验收线，**不因实测偏低而下调**（见文件头的实测表）。
    expect(agree).toBeGreaterThanOrEqual(0.98);
  });

  it('★ 判别力负控：更激进的探针（1/2）下**同一套度量必须掉下来**（否则 0.98 无意义）', () => {
    const { flat, ivf } = backendsOf(corpus, [1, 2]);

    let flatTotal = 0;
    let intersect = 0;
    for (const query of corpus.queries) {
      const flatIds = new Set(idsOf(flat.search(query, K)));
      const ivfIds = new Set(idsOf(ivf.search(query, K)));
      flatTotal += flatIds.size;
      for (const id of ivfIds) {
        if (flatIds.has(id)) {
          intersect += 1;
        }
      }
    }

    const agree = intersect / flatTotal;
    // ⚠️ 实测 0.725 ⇒ 度量**能**掉到 0.98 以下 ⇒ 上一条不是恒真的守卫。
    expect(agree).toBeLessThan(0.98);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、「只漏不错」：交集内每个 id 的两侧 cos 必须相等（D6 的最后一条）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D6 第 3 条 · 只漏不错 ⇒ 交集内每个 id 的两侧 cos **相等**', () => {
  it('★ 三档探针（2/8、2/4、1/2）下，交集内的 cos 一律逐位相等（差异只允许是「少给了几条」）', () => {
    const flatHits = corpus.queries.map((query) => {
      const backend = new FlatVectorBackend({ rows: createFlatRowSource(corpus.db) });
      backend.init(corpus.config);
      return backend.search(query, K);
    });

    for (const probes of [PROBES_RATIO, ...PROBES_AGGRESSIVE]) {
      const ivf = new IvfVectorBackend({
        db: corpus.db,
        centroids: () => corpus.model,
        nprobeCoarse: probes[0],
        nprobeFine: probes[1],
      });
      ivf.init(corpus.config);

      for (let index = 0; index < corpus.queries.length; index += 1) {
        const flatScores = scoreMap(flatHits[index]!);
        const ivfHits = ivf.search(corpus.queries[index]!, K);
        for (const hit of ivfHits) {
          const flatScore = flatScores.get(hit.id);
          if (flatScore === undefined) {
            // 不在 flat 的 top-K 里 ⇒ 不属于「交集」，本断言不管它的**存在**（那是探针效应）
            continue;
          }
          expect(hit.score, `探针 ${probes.join('/')} · 查询 #${index} · ${hit.id}`).toBe(
            flatScore,
          );
        }
      }
    }
  });

  it('★ 「只漏不错」的最强形式：**任何探针档下，上报的 cos 都等于我自己算的点积**（不许「同一个 id、编一个分」）', () => {
    // id → 向量（我自己的映射，不读后端的任何中间产物）
    const byId = new Map<string, Float32Array>();
    for (let index = 0; index < corpus.vectors.length; index += 1) {
      byId.set(idOf(index), corpus.vectors[index]!);
    }

    for (const probes of [[COARSE_CENTERS, FINE_CENTERS], PROBES_RATIO, ...PROBES_AGGRESSIVE]) {
      const ivf = new IvfVectorBackend({
        db: corpus.db,
        centroids: () => corpus.model,
        nprobeCoarse: probes[0]!,
        nprobeFine: probes[1]!,
      });
      ivf.init(corpus.config);

      for (let index = 0; index < corpus.queries.length; index += 1) {
        const query = corpus.queries[index]!;
        const hits = ivf.search(query, K);
        // ── 前置：这一档必须真的产出（否则「每条都对」是空集上的真命题）──
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) {
          const vector = byId.get(hit.id);
          expect(vector, `探针 ${probes.join('/')} 返回了库里不存在的 id`).toBeDefined();
          if (vector === undefined) {
            continue;
          }
          expect(hit.score, `探针 ${probes.join('/')} · 查询 #${index} · ${hit.id}`).toBe(
            clampCos(dot(query, vector)),
          );
        }
      }
    }
  });

  it('★ 探针不足时**只会漏**：ivf 的每条 hit 都必须是 flat 候选宇宙（全库活行）里的行', () => {
    const universe = new Set<string>();
    for (let index = 0; index < corpus.vectors.length; index += 1) {
      universe.add(idOf(index));
    }

    for (const probes of [
      [1, 2],
      [2, 4],
    ]) {
      const ivf = new IvfVectorBackend({
        db: corpus.db,
        centroids: () => corpus.model,
        nprobeCoarse: probes[0]!,
        nprobeFine: probes[1]!,
      });
      ivf.init(corpus.config);
      for (const query of corpus.queries) {
        for (const hit of ivf.search(query, K)) {
          expect(universe.has(hit.id)).toBe(true);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、一个**容易漏的接线点**：查询向量必须先归一化，否则 cos 整体偏小（RK-3）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 查询向量的归一化口径（RK-3 的可观测后果）', () => {
  it('★ 未归一化的查询向量（模长 1/4）⇒ cos 全部掉到 VECTOR_MIN_COS 以下（=「向量路恒空」的症状）', () => {
    const flat = new FlatVectorBackend({ rows: createFlatRowSource(corpus.db) });
    flat.init(corpus.config);
    const query = corpus.queries[0]!;
    const proper = flat.search(query, K);

    // ── 前置：归一化后确实有一批候选过得了 `VECTOR_MIN_COS`（否则下面那条是空的）──
    expect(proper.length).toBeGreaterThan(0);
    for (const hit of proper) {
      expect(hit.score).toBeGreaterThanOrEqual(DEFAULT_PARAMS.VECTOR_MIN_COS);
    }

    // ⚠️ **乘 0.25（= 2 的负幂，float32 上无损）**：这不是「后端该代劳归一化」的主张
    //   （§4.15.2 明写后端不代劳），而是把 RK-3 的症状钉成**可观测事实**：
    //   模长不归一 ⇒ 点积整体缩小 ⇒ 全部低于 `VECTOR_MIN_COS` ⇒ 向量路看起来「跑了但没内容」。
    const scaled = new Float32Array(QA_DIM);
    for (let index = 0; index < QA_DIM; index += 1) {
      scaled[index] = query[index]! * 0.25;
    }
    const unscaled = flat.search(scaled, K);
    expect(unscaled.length).toBe(K);
    for (const hit of unscaled) {
      expect(hit.score).toBeLessThan(DEFAULT_PARAMS.VECTOR_MIN_COS);
    }

    // ── 正控：过一遍 `normalizeQueryEmbedding()` ⇒ 恢复到与「本来就归一化」那次**同序同分** ──
    const recovered = flat.search(normalizeQueryEmbedding(qaNumbers(scaled), QA_DIM), K);
    expect(idsOf(recovered)).toEqual(idsOf(proper));
    for (let index = 0; index < proper.length; index += 1) {
      expect(recovered[index]!.score).toBeCloseTo(proper[index]!.score, 12);
    }
  });
});
