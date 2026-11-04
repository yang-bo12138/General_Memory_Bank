/**
 * ★ **IVF 端到端召回链**（门面 → ivf 端口 → `CentroidCache` → `search()`）—— 阶段 5 · T03 补课。
 *
 * ⚠️ **为什么这个文件必须存在**：小库走 `flat` 是**设计内的退化路径**，
 *   而这条接线的存在理由是**大库走 ivf**。`recall-vector-path.test.ts` 与
 *   `recall-vector-four-states.test.ts` 里所有「门面 + 真端口」的用例都是 `VECTOR_ROUTER='flat'`
 *   ⇒ 「过门槛 + 已训练 + 真的走 ivf」这条链**只被间接覆盖**。
 *   而 `CentroidCache` 有一个已知的坑（`src/vector/centroids.ts:294-307`：
 *   `model()` 首次加载后**永远走缓存**，重训后必须显式 `reload()`）——
 *   这条链正是那个坑的落点 ⇒ 必须有一条**端到端**用例站在它上面。
 *
 * 三条用例各守一件事：
 * 1. **链路能通**：`ROUTER_MIN_TRAINING` 压低 ⇒ 越过门槛 ⇒ `rebuildVectorBuckets()` 真训练出细桶
 *    ⇒ `stats().vectorBackend.mode === 'ivf'`（**先断言这个，否则后面全是假的**）
 *    ⇒ 门面 `recall({queryEmbedding})` 的 `ran` / `candidates` / `fromVector` / `cos` / `vectorPart` / 五柱之和。
 * 2. **`reload()` 的坑**（成对反例 ①）：越界重训后**不** `reload()` ⇒ 路由用旧中心 ⇒
 *    召回**静默给出更差的答案**；同一库上**新开一个实例**（= 缓存为空 = 相当于 reloaded）给出正确答案。
 * 3. **ivf ≡ flat**（成对反例 ②）：探针吃满时，同一世界分别以 `ivf` 与 `flat` 跑门面召回
 *    ⇒ `hits` 的 id 序列与每条 `cos` **完全一致**。这条是「0.98 是数据特定值」的正确栏杆：
 *    **探针吃满时必须 1.0**（`recall-vector-flat-vs-ivf.test.ts` 里那 0.958 的读数只属于「探针不足」）。
 *
 * ⚠️ **所有断言都走门面（`MemoryStore`）**，除了第 2 条里「越界重训」那一步必须自己开一条连接
 *   （那正是「重训发生在门面之外」的现实形状：`MemoryMaintainer.reloadCentroids`
 *   是唯一的 `reload()` 调用点，`MemoryStore.ts:347`）。
 * ⚠️ **本文件不改产品代码**：第 2 条用「新实例」代表「reloaded」，不碰任何私有字段。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCORE_WEIGHTS } from '../../src/core/scoring.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { assignBucket } from '../../src/vector/bucketAssign.js';
import {
  type IvfCentroidModel,
  loadCentroidModel,
  saveCentroidModel,
} from '../../src/vector/centroids.js';
import { dot } from '../../src/vector/dot.js';
import { normalizeQueryEmbedding } from '../../src/vector/query.js';
import { QA_DIM, QA_NOW, QA_PARAMS, qaNumbers, qaUnitVector } from '../fixtures/qaVectorWorld.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、世界与参数
// ═══════════════════════════════════════════════════════════════════════════

/** 与语料正文**汉字集不相交**的上下文（⇒ 文本路必然为空，命中只能来自向量路）。 */
const BLIND_CONTEXT = '子丑寅卯辰巳午未';

/** 每簇条数（两簇共 40 条 ⇒ 足够训练 20 粗 / 40 细）。 */
const PER_CLUSTER = 20;

/**
 * 簇内散度 `0.55` ⇒ 成员与簇心的 cos ≈ 0.876。
 *
 * ⚠️ 这个值**不是随手取的**：写入路径的近似去重阈值是 `DEDUP_COS_MIN = 0.92`
 *   ⇒ 散度必须让「同簇成员之间的 cos」掉到 0.92 以下，否则 40 条会被**合并**成几条
 *   （夹具就凑不出 40 个成员，而「桶里有东西」正是本文件的前提）。
 */
const SPREAD = 0.55;

/**
 * 训练用的中心数。
 *
 * ⚠️ **不能更小**：`validateParams` 要求 `ROUTER_COARSE_CENTERS ≥ ROUTER_NPROBE_WRITE_COARSE(8)`、
 *   `ROUTER_FINE_CENTERS ≥ ROUTER_NPROBE_WRITE_FINE(20)`（`src/core/params.ts:403-420`）
 *   ⇒ 20/40 是最小的合法训练规模（每粗桶 2 个细桶）。
 */
const COARSE = 20;
const FINE = 40;

/** 「越过门槛」的参数：`ROUTER_MIN_TRAINING = 1` ⇒ 40 条的库必然过门槛。 */
const IVF_PARAMS: Params = {
  ...QA_PARAMS,
  VECTOR_ROUTER: 'auto',
  ROUTER_MIN_TRAINING: 1,
  ROUTER_COARSE_CENTERS: COARSE,
  ROUTER_FINE_CENTERS: FINE,
  // 探针吃满（= 全部桶）⇒ ivf 退化成「对全库做精确点积」= 与 flat 逐位一致
  ROUTER_NPROBE_COARSE: COARSE,
  ROUTER_NPROBE_FINE: FINE,
};

/**
 * 只探 1 粗 / 1 细 的参数 —— **只给第 2 条（`reload()` 的坑）用**。
 *
 * ⚠️ 为什么必须少探：探针吃满时「路由选哪个桶」不影响结果（全部都选）
 *   ⇒ 旧中心与新中心的差异**观测不到**，那条反例就会变成恒绿的空断言。
 */
const NARROW_PROBE_PARAMS: Params = {
  ...IVF_PARAMS,
  ROUTER_NPROBE_COARSE: 1,
  ROUTER_NPROBE_FINE: 1,
};

/** 一个「已训练、已入桶」的世界。 */
interface IvfWorld {
  store: MemoryStore;
  dir: string;
  dbPath: string;
  /** id → 写入时用的向量（断言「cos == 我算的点积」要用它）。 */
  vectors: Map<string, Float32Array>;
  /** 查询向量（= 簇 A 的中心）。 */
  query: Float32Array;
}

/** 造一条簇成员：`normalize(中心 + spread × 单位噪声)`。 */
function member(center: Float32Array, seed: number): Float32Array {
  const noise = qaUnitVector(seed);
  const raw = new Float32Array(QA_DIM);
  for (let index = 0; index < QA_DIM; index += 1) {
    raw[index] = center[index]! + SPREAD * noise[index]!;
  }
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  for (let index = 0; index < QA_DIM; index += 1) {
    raw[index] = raw[index]! / norm;
  }
  return raw;
}

/**
 * 建世界：40 条带向量的记忆（两簇）→ **真的训练**（`rebuildVectorBuckets()`）。
 *
 * ⚠️ **不用 `store.write()` 之外的任何写法**：`write()` 是唯一会「同事务落桶归属」的入口
 *   （§9.3.2 ①）⇒ 这样建出来的世界与生产同形。
 */
function buildWorld(params: Params): IvfWorld {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ivf-path-'));
  const dbPath = join(dir, 'memory.db');
  const store = new MemoryStore({ dbPath, params });

  const centerA = qaUnitVector(1);
  const centerB = qaUnitVector(2);
  const vectors = new Map<string, Float32Array>();

  for (let index = 0; index < PER_CLUSTER; index += 1) {
    const vector = member(centerA, 500 + index);
    const result = store.write({
      content: `甲方记忆第${index}条内容`,
      embedding: qaNumbers(vector),
      now: QA_NOW,
    });
    vectors.set(result.id, vector);
  }
  for (let index = 0; index < PER_CLUSTER; index += 1) {
    const vector = member(centerB, 900 + index);
    const result = store.write({
      content: `乙方记录第${index}条内容`,
      embedding: qaNumbers(vector),
      now: QA_NOW,
    });
    vectors.set(result.id, vector);
  }

  // ── ★ 真的训练（这一步不成立，后面所有断言都是假的）──
  store.rebuildVectorBuckets({ reason: 'qa-ivf-path' });

  return { store, dir, dbPath, vectors, query: centerA };
}

/** 关掉世界（库文件一起删）。 */
function closeWorld(world: IvfWorld): void {
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
}

/** 我按向量自己算的余弦（与后端同一条公式：`clampCos(dot(查询, 行向量))`）。 */
function expectedCos(query: Float32Array, vector: Float32Array): number {
  // 查询向量走**生产同一个入口**归一化（否则比的是两个不同的查询向量）
  return Math.max(-1, Math.min(1, dot(normalizeQueryEmbedding(qaNumbers(query), QA_DIM), vector)));
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、链路能通（本文件的主体）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · IVF 端到端 · 门面 → ivf 端口 → CentroidCache → search()', () => {
  const world = buildWorld(IVF_PARAMS);

  afterAll(() => {
    closeWorld(world);
  });

  it('★ **前提**：越过门槛 + 真的训练出细桶 ⇒ `stats().vectorBackend.mode === "ivf"`', () => {
    const stats = world.store.stats();
    // ⚠️ 这三条是整条链的**地基**：不成立就说明「训练没发生 / 门槛没过」，
    //   那么后面「ran=true」只可能来自 flat_auto（另一条路径，不是本文件要证的）。
    expect(stats.vectorBackend.mode).toBe('ivf');
    expect(stats.vectorBackend.coarseCells).toBe(COARSE);
    expect(stats.vectorBackend.fineCells).toBeGreaterThan(0);
    expect(stats.vectorBackend.members).toBe(PER_CLUSTER * 2);
  });

  it('★ 门面召回：`ran=true` / `candidates=20` / 命中者 `fromVector` / `cos` == 我算的点积 / `vectorPart == 0.25×cos` / 五柱之和 == `score`', () => {
    const result = world.store.recall({
      context: BLIND_CONTEXT,
      queryEmbedding: qaNumbers(world.query),
      explain: true,
      now: QA_NOW,
    });

    // ── call 级：向量路真的跑了，且产出了 `VECTOR_TOPK` 条候选 ──
    // ⚠️ **T04（C′ 档 §5.1.9）**：`routes.vector` 多了第三个字段 `codesMissing`
    //   （命中桶内「有成员、无码」的行数）。本夹具**没有任何码行**（T05 未落地）
    //   ⇒ 它是**真值 > 0**，**不能**钉 0（钉 0 就是拿一个假的期望值把断言弄红）。
    //   ⇒ `ran` / `candidates` 两个数逐字段钉死；第三个数**单独**钉在一个**可独立推导**的值上。
    expect(result.explain?.routes.vector).toMatchObject({
      ran: true,
      candidates: DEFAULT_PARAMS.VECTOR_TOPK,
    });
    // ★ `codesMissing` 的真值 = **命中桶的成员行数**。
    //   本夹具的探针吃满（`ROUTER_NPROBE_COARSE = 20` / `ROUTER_NPROBE_FINE = 40` ⇒ 全部细桶）
    //   ⇒ 「命中桶」= 全库的桶 ⇒ 成员行数 = `PER_CLUSTER × 2`（与上面那条前提用例
    //   `stats().vectorBackend.members` 断言的是同一个数，这里用字面量冻结，不拿被测函数当分母）。
    expect(result.explain?.routes.vector?.codesMissing).toBe(PER_CLUSTER * 2);
    // ── 文本路为空（上下文与正文汉字集不相交）⇒ 每条 hit 都只能来自向量路 ──
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.fromText === false)).toBe(true);

    for (const hit of result.hits) {
      const vector = world.vectors.get(hit.id);
      expect(vector, `hit ${hit.id} 必须来自本世界`).toBeDefined();
      if (vector === undefined) {
        continue;
      }
      const cos = expectedCos(world.query, vector);
      // ① per-hit 来源标记
      expect(hit.fromVector, `hit ${hit.id} 必须来自向量路`).toBe(true);
      // ② `cos` 逐位等于我自己算的余弦（不是「差不多」）
      expect(hit.breakdown?.cos, `hit ${hit.id} 的 cos`).toBe(cos);
      // ③ 加权分项
      expect(hit.breakdown?.vectorPart, `hit ${hit.id} 的 vectorPart`).toBe(
        SCORE_WEIGHTS.vectorSim * cos,
      );
      // ④ 五柱之和 == score（误差 ≤ 1e-9）
      const breakdown = hit.breakdown!;
      const sum =
        breakdown.intensityPart +
        breakdown.vectorPart +
        breakdown.textPart +
        breakdown.graphPart +
        breakdown.recencyPart;
      expect(Math.abs(sum - hit.score)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('★ 正控：`cos` 确实是「按库里那条向量算的」—— 换成另一簇的查询，命中的是另一批 id', () => {
    const resultB = world.store.recall({
      context: BLIND_CONTEXT,
      queryEmbedding: qaNumbers(qaUnitVector(2)),
      explain: true,
      now: QA_NOW,
    });
    const idsA = world.store
      .recall({ context: BLIND_CONTEXT, queryEmbedding: qaNumbers(world.query), now: QA_NOW })
      .hits.map((hit) => hit.id)
      .sort();
    const idsB = resultB.hits.map((hit) => hit.id).sort();

    // ⚠️ 若 backend 忽略了查询向量（或恒用同一条），这两批会相同 ⇒ 本断言红。
    expect(idsB).not.toEqual(idsA);
    // ── 且 B 的 cos 用的是 B 的查询向量 ──
    for (const hit of resultB.hits) {
      const vector = world.vectors.get(hit.id);
      if (vector === undefined) {
        continue;
      }
      expect(hit.breakdown?.cos).toBe(expectedCos(qaUnitVector(2), vector));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、成对反例 ①：`CentroidCache` 不自动失效（`reload()` 是承重的）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 成对反例 ① · 越界重训后不 `reload()` ⇒ 路由用旧中心 ⇒ 召回静默变差', () => {
  it('★ 构造成功：同一库上「陈旧实例」给出更差的答案，「新实例（= reloaded）」给出正确答案', () => {
    const world = buildWorld(NARROW_PROBE_PARAMS);
    try {
      // ── ① 先跑一次 ⇒ 让门面的 `CentroidCache` **加载并缓存**当前中心 ──
      const before = world.store.recall({
        context: BLIND_CONTEXT,
        queryEmbedding: qaNumbers(world.query),
        explain: true,
        now: QA_NOW,
      });
      expect(before.explain?.routes.vector.ran).toBe(true);
      const topBefore = before.hits[0];
      expect(topBefore).toBeDefined();

      // ── ② **越界重训**：把每个中心/细中心的几何**轮转一位**（id 不动），
      //        并按新几何重算桶归属。这正是「重训发生在门面之外」的形状
      //        （`MemoryMaintainer` 重训后会调 `reloadCentroids`；此处**故意不调**）。
      //    ⚠️ 中心 id 是**索引派生**的（`c-000` / `f-000-000`）⇒ 只换几何不换 id
      //      就能造出「同一个 id 指向不同几何」⇒ 旧缓存的路由结论与新几何的桶归属**不一致**。
      const db = new Database(world.dbPath);
      try {
        const old = loadCentroidModel(db);
        expect(old.coarse.length).toBeGreaterThan(1);
        const rotated: IvfCentroidModel = {
          coarse: old.coarse.map((cell, index) => ({
            coarseId: cell.coarseId,
            centroid: old.coarse[(index + 1) % old.coarse.length]!.centroid,
          })),
          fine: old.fine.map((cell) => {
            const siblings = old.fine.filter((fine) => fine.coarseId === cell.coarseId);
            const position = siblings.findIndex((fine) => fine.fineId === cell.fineId);
            const next = siblings[(position + 1) % siblings.length]!;
            return { fineId: cell.fineId, coarseId: cell.coarseId, centroid: next.centroid };
          }),
        };
        saveCentroidModel(db, rotated, QA_NOW + 1000);
        runWriteTransaction(db, () => {
          for (const [id, vector] of world.vectors) {
            assignBucket({ db, centroids: () => rotated, nprobeCoarse: COARSE }, id, vector);
          }
        });
      } finally {
        db.close();
      }

      // ── ③ **陈旧实例**（缓存里还是旧中心）──
      const stale = world.store.recall({
        context: BLIND_CONTEXT,
        queryEmbedding: qaNumbers(world.query),
        explain: true,
        now: QA_NOW,
      });
      expect(stale.explain?.routes.vector.ran).toBe(true);

      // ── ④ **新实例**（缓存为空 ⇒ 加载新中心 = 与「reload() 之后」等价，不碰私有字段）──
      const reloaded = new MemoryStore({ dbPath: world.dbPath, params: NARROW_PROBE_PARAMS });
      try {
        const fresh = reloaded.recall({
          context: BLIND_CONTEXT,
          queryEmbedding: qaNumbers(world.query),
          explain: true,
          now: QA_NOW,
        });
        expect(fresh.explain?.routes.vector.ran).toBe(true);

        // ★ 断言①：两者**不一样**（这就是「不 reload ⇒ 结果变差」的可观测形式）
        expect(stale.hits[0]?.id).not.toBe(fresh.hits[0]?.id);

        // ★ 断言②：新实例给的确实是**全库最像**的那条（= 正确）
        let bestId = '';
        let bestCos = Number.NEGATIVE_INFINITY;
        for (const [id, vector] of world.vectors) {
          const cos = expectedCos(world.query, vector);
          if (cos > bestCos) {
            bestCos = cos;
            bestId = id;
          }
        }
        expect(fresh.hits[0]?.id).toBe(bestId);
        expect(fresh.hits[0]?.breakdown?.cos).toBe(bestCos);

        // ★ 断言③：陈旧实例给的**不是**最像的那条，且分数**更低**（= 静默变差，不是报错）
        expect(stale.hits[0]?.breakdown?.cos).toBeLessThan(bestCos);
      } finally {
        reloaded.close();
      }
    } finally {
      closeWorld(world);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、成对反例 ②：探针吃满时 ivf ≡ flat（端到端，不是后端层）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 成对反例 ② · 同一世界：`ivf`（已训练、探针吃满）与 `flat` 的门面召回给出同一批 hit', () => {
  it('★ `hits` 的 id **序列**与每条 `cos` 完全一致（这条把「0.98 是数据特定值」钉回正确口径）', () => {
    const world = buildWorld(IVF_PARAMS);
    const flatStore = new MemoryStore({
      dbPath: world.dbPath,
      params: { ...IVF_PARAMS, VECTOR_ROUTER: 'flat' },
    });
    try {
      // ── 前置：一个真的走 ivf，一个真的走 flat ──
      expect(world.store.stats().vectorBackend.mode).toBe('ivf');
      expect(flatStore.stats().vectorBackend.mode).toBe('flat_explicit');

      const query = qaNumbers(world.query);
      const viaIvf = world.store.recall({
        context: BLIND_CONTEXT,
        queryEmbedding: query,
        explain: true,
        now: QA_NOW,
      });
      const viaFlat = flatStore.recall({
        context: BLIND_CONTEXT,
        queryEmbedding: query,
        explain: true,
        now: QA_NOW,
      });

      // ── 两边的 `candidates` 也必须相同（探针吃满 ⇒ 桶覆盖 = 全库）──
      // ⚠️ **T04**：`routes.vector` 多了 `codesMissing`，它是**桶**的概念 ——
      //   `flat` 没有桶（`route()` 只回 `__flat_all__`）⇒ 它恒为 0，而 ivf 的数 > 0
      //   ⇒ 「两个后端的 explain 逐字段相等」不再成立。这里比对**共有的两个字段**。
      const routeOf = (value: {
        explain?: { routes: { vector: { ran: boolean; candidates: number } } };
      }) => ({
        ran: value.explain?.routes.vector.ran ?? false,
        candidates: value.explain?.routes.vector.candidates ?? -1,
      });
      expect(routeOf(viaIvf)).toEqual(routeOf(viaFlat));
      expect(viaIvf.explain?.routes.vector.ran).toBe(true);
      // ★ **第三个字段不能就这么被丢掉**（T04 收尾）：它不是「两边相同」，而是
      //   「**两边各有确定值**」—— 本夹具**没有任何码行**（T05 未落地），探针吃满
      //   ⇒ ivf 的命中桶 = 全部细桶 ⇒ 它 = 成员数 = `PER_CLUSTER × 2`；
      //   而 flat 的路由只回 `__flat_all__`（没有桶的概念）⇒ 恒 0。
      //   ⇒ 逐字钉死；否则这个字段在本文件里等于**没人看**（放宽成 `routeOf` 就把它丢了）。
      expect(viaIvf.explain?.routes.vector.codesMissing).toBe(PER_CLUSTER * 2);
      expect(viaFlat.explain?.routes.vector.codesMissing).toBe(0);

      // ── ① id 序列逐位相同（顺序也一致：同一个 compareHits 全序）──
      expect(viaIvf.hits.map((hit) => hit.id)).toEqual(viaFlat.hits.map((hit) => hit.id));
      // ── ② 每条 cos 逐位相同 ──
      for (let index = 0; index < viaIvf.hits.length; index += 1) {
        expect(viaIvf.hits[index]?.breakdown?.cos).toBe(viaFlat.hits[index]?.breakdown?.cos);
        // ── ③ score 也该逐位相同（同样的候选 + 同样的四柱）──
        expect(viaIvf.hits[index]?.score).toBe(viaFlat.hits[index]?.score);
      }
      // ★ **反向对照**：同一世界、只探 1 粗/1 细（探针不足）⇒ 与 flat **必须不同**。
      //   ⚠️ 没有这条，上面「满探针一致」可能只是「ivf 压根没分桶、两边都走了同一段代码」。
      const narrowStore = new MemoryStore({
        dbPath: world.dbPath,
        params: NARROW_PROBE_PARAMS,
      });
      try {
        const viaNarrow = narrowStore.recall({
          context: BLIND_CONTEXT,
          queryEmbedding: query,
          explain: true,
          now: QA_NOW,
        });
        expect(viaNarrow.explain?.routes.vector.ran).toBe(true);
        expect(viaNarrow.hits.map((hit) => hit.id)).not.toEqual(viaFlat.hits.map((hit) => hit.id));
        // ── 探针不足 ⇒ 候选面也真的更小（1 个细桶 vs 全库）──
        expect(viaNarrow.explain?.routes.vector.candidates).toBeLessThan(
          viaFlat.explain?.routes.vector.candidates as number,
        );
      } finally {
        narrowStore.close();
      }
    } finally {
      flatStore.close();
      closeWorld(world);
    }
  });
});
