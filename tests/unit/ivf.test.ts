/**
 * 两级 k-means 分桶后端（IVF）的单测 —— DEVELOPMENT-PLAN.md **P2-T02** 的硬断言
 * （§4.15.3 / §4.6 步骤 0）。
 *
 * ★ 本文件的断言纪律（沿用阶段 0~2 的口径）：
 *   · **硬断言逐条对应计划稿**，每条都能被变异打红；
 *   · **逐位一致用 `Object.is`**，不用 `toBeCloseTo`；
 *   · **参考实现自己手写**（不复用被测模块的 `dot()`）；
 *   · **夹具用的是 §3 的权威 DDL**（真库 ⇒ 外键 / 唯一索引这些约束验得了）。
 *
 * ⚠️ **桶归属（`vector_cell_members`）由本测试写入**：
 *   生产代码里它**只由 P2-T03 的 `assignBucket` 写**（§9.3.0 的单一写入点）
 *   ⇒ T02 的生产代码**不写**这张表 ⇒ 测试代劳（模拟 T03 的落库）。
 */

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { cosineOf } from '../../src/store/dedupCandidates.js';
import {
  type IvfCentroidModel,
  blobToVector,
  loadCentroidModel,
} from '../../src/vector/centroids.js';
import { normalize } from '../../src/vector/dot.js';
import { FlatVectorBackend, type VectorCandidateRow } from '../../src/vector/flat.js';
import {
  IvfVectorBackend,
  assignFineBucket,
  buildCentroidModel,
  countUncodedCandidates,
  readCodes,
  scanBucketCandidates,
  trainCentroids,
} from '../../src/vector/ivf.js';
import { sphericalKmeans } from '../../src/vector/kmeans.js';
import {
  type CodeWidth,
  codeToBlob,
  codeToBlobWithWidth,
  encodeVector,
  encodeVectorWithWidth,
} from '../../src/vector/quantize.js';
import {
  EMBED_DIM,
  createTestDb,
  insertMemories,
  insertMemory,
  pseudoUnitVector,
} from '../fixtures/vector.js';

/** 一个固定的时间基准。 */
const T0 = 1_700_000_000_000;

/** 后端配置（维度必须 == `EMBED_DIM`）。 */
const CONFIG = {
  dimensions: EMBED_DIM,
  coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
  fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
};

/** 训练夹具的形状。 */
interface Fixture {
  db: Database.Database;
  ids: string[];
  vectors: Float32Array[];
  model: IvfCentroidModel;
  fineBucketIds: Array<string | null>;
}

/**
 * 建一个训练好的夹具（真库 + 训练 + **代 T03 落桶归属**）。
 */
function trainFixture(options?: {
  count?: number;
  coarseCenters?: number;
  fineCenters?: number;
  maxIterations?: number;
  nprobeCoarse?: number;
}): Fixture {
  const db = createTestDb();
  const count = options?.count ?? 40;
  const vectors: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    vectors.push(pseudoUnitVector(index + 1));
  }
  const ids = insertMemories(db, vectors);

  const result = trainCentroids(db, {
    coarseCenters: options?.coarseCenters ?? 4,
    fineCenters: options?.fineCenters ?? 12,
    maxIterations: options?.maxIterations ?? 5,
    nprobeCoarse: options?.nprobeCoarse ?? 2,
    now: T0,
  });

  // ⚠️ **代 T03 的 `assignBucket` 落桶归属**（T02 的生产代码不写这张表）。
  const insert = db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)');
  result.fineBucketIds.forEach((fineId, index) => {
    const memoryId = ids[index];
    if (fineId !== null && memoryId !== undefined) {
      insert.run(fineId, memoryId);
    }
  });

  return { db, ids, vectors, model: result.model, fineBucketIds: result.fineBucketIds };
}

/** 造一个 IVF 后端（中心模型从库里加载 ⇒ 走真实的加载路径）。 */
function makeIvfBackend(
  fixture: Fixture,
  nprobeCoarse: number,
  nprobeFine: number,
): IvfVectorBackend {
  const backend = new IvfVectorBackend({
    db: fixture.db,
    centroids: () => loadCentroidModel(fixture.db),
    nprobeCoarse,
    nprobeFine,
  });
  backend.init(CONFIG);
  return backend;
}

/** 读出库里的候选行（flat 后端的取行来源）。 */
function readRows(db: Database.Database): VectorCandidateRow[] {
  const rows = db
    .prepare(
      'SELECT id, embedding, last_access, pin_factor FROM memories ' +
        'WHERE embedding IS NOT NULL AND deleted = 0 ORDER BY rowid',
    )
    .all() as Array<{
    id: string;
    embedding: Buffer;
    last_access: number;
    pin_factor: number;
  }>;
  // ⚠️ **自己解码 BLOB**（不复用被测模块的 `blobToVector`）⇒ 参考路径与生产路径独立。
  return rows.map((row) => {
    const bytes = Buffer.from(row.embedding);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = Math.floor(bytes.byteLength / 4);
    const vector = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      vector[index] = dataView.getFloat32(index * 4, true);
    }
    return {
      id: row.id,
      vector,
      lastAccess: row.last_access,
      pinFactor: row.pin_factor,
    };
  });
}

/** 手写的点积（不复用被测模块）。 */
function referenceDot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

/** 手写的「全量精确扫描」参考实现（排序口径与被测实现同规则）。 */
function referenceScan(
  rows: readonly VectorCandidateRow[],
  query: Float32Array,
  k: number,
): Array<{ id: string; score: number }> {
  const scored = rows.map((row) => ({
    id: row.id,
    score: Math.min(1, Math.max(0, referenceDot(query, row.vector))),
  }));
  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return scored.slice(0, k);
}

describe('P2-T02 · 两级 k-means 分桶后端（IVF）', () => {
  describe('硬断言：确定性（同一份数据两次训练 ⇒ 桶归属逐条相同）', () => {
    it('两次训练的归属逐条相同、中心 id 集合与中心值逐位相同', () => {
      const first = trainFixture();
      const second = trainFixture();

      expect(second.fineBucketIds).toEqual(first.fineBucketIds);
      expect(second.model.coarse.map((cell) => cell.coarseId)).toEqual(
        first.model.coarse.map((cell) => cell.coarseId),
      );
      expect(second.model.fine.map((cell) => cell.fineId)).toEqual(
        first.model.fine.map((cell) => cell.fineId),
      );
      for (let index = 0; index < first.model.fine.length; index += 1) {
        expect(Array.from(second.model.fine[index]?.centroid ?? [])).toEqual(
          Array.from(first.model.fine[index]?.centroid ?? []),
        );
      }
    });

    it('中心 id 是索引派生的（同一份数据 ⇒ 同一套 id）', () => {
      const fixture = trainFixture({ coarseCenters: 3, fineCenters: 6 });
      const coarseIds = fixture.model.coarse.map((cell) => cell.coarseId);
      expect(coarseIds).toEqual(['c-000', 'c-001', 'c-002']);
      // ⚠️ **细中心数按公式算**：floor(细总数 / 粗总数) = floor(6/3) = 2（不是硬写的 50）。
      expect(fixture.model.fine.length).toBeLessThanOrEqual(6);
      for (const cell of fixture.model.fine) {
        expect(coarseIds).toContain(cell.coarseId);
      }
    });
  });

  describe('硬断言：细桶必属粗桶（外键保证）', () => {
    it('全部 vector_fine_cells 行都能在 vector_coarse_cells 找到父行', () => {
      const fixture = trainFixture();
      const coarseIds = new Set(
        (
          fixture.db.prepare('SELECT coarse_id FROM vector_coarse_cells').all() as Array<{
            coarse_id: string;
          }>
        ).map((row) => row.coarse_id),
      );
      const fineRows = fixture.db
        .prepare('SELECT fine_id, coarse_id FROM vector_fine_cells')
        .all() as Array<{ fine_id: string; coarse_id: string }>;

      expect(fineRows.length).toBeGreaterThan(0);
      for (const row of fineRows) {
        expect(coarseIds.has(row.coarse_id)).toBe(true);
      }
    });

    it('`PRAGMA foreign_key_check` 为空（外键真的兜住了）', () => {
      const fixture = trainFixture();
      const violations = fixture.db.pragma('foreign_key_check') as unknown[];
      expect(violations).toEqual([]);
    });
  });

  describe('硬断言：一条记忆只属一个细桶', () => {
    it('COUNT(*) == COUNT(DISTINCT memory_id)', () => {
      const fixture = trainFixture();
      const row = fixture.db
        .prepare(
          'SELECT COUNT(*) AS total, COUNT(DISTINCT memory_id) AS distinctCount FROM vector_cell_members',
        )
        .get() as { total: number; distinctCount: number };
      expect(row.total).toBe(row.distinctCount);
      expect(row.total).toBe(fixture.ids.length);
    });

    it('同一个记忆挂到第二个细桶 ⇒ 唯一索引挡住（不写进去）', () => {
      const fixture = trainFixture();
      const rows = fixture.db
        .prepare('SELECT fine_id, memory_id FROM vector_cell_members LIMIT 1')
        .all() as Array<{ fine_id: string; memory_id: string }>;
      const first = rows[0];
      expect(first).toBeDefined();
      const otherFine = fixture.model.fine.find((cell) => cell.fineId !== first?.fine_id);
      expect(otherFine).toBeDefined();
      expect(() =>
        fixture.db
          .prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)')
          .run(otherFine?.fineId, first?.memory_id),
      ).toThrow();
    });
  });

  describe('硬断言：路由桶数（C32 —— 能用结构判定的，不用统计阈值判定）', () => {
    it('命中的是「细桶数」，不是「粗桶数 × 细桶数」', () => {
      const fixture = trainFixture({ coarseCenters: 4, fineCenters: 12 });
      const totalFine = fixture.model.fine.length;

      for (let nprobeCoarse = 1; nprobeCoarse <= 4; nprobeCoarse += 1) {
        for (let nprobeFine = 1; nprobeFine <= 12; nprobeFine += 1) {
          const backend = makeIvfBackend(fixture, nprobeCoarse, nprobeFine);
          const hits = backend.route(pseudoUnitVector(7), nprobeCoarse, nprobeFine);
          // ⚠️ **命中数 ≤ 探针数**：若写成「粗 × 细」，这里会爆 ⇒ 断言能红。
          expect(hits.length).toBeLessThanOrEqual(nprobeFine);
          expect(new Set(hits).size).toBe(hits.length);
          for (const id of hits) {
            expect(fixture.model.fine.some((cell) => cell.fineId === id)).toBe(true);
          }
        }
      }

      // ⚠️ 探针数覆盖全部细桶时 ⇒ 命中数 == min(探针数, 可用细桶数)。
      const backend = makeIvfBackend(fixture, 4, 12);
      const all = backend.route(pseudoUnitVector(7), 4, 12);
      expect(all.length).toBe(Math.min(12, totalFine));
    });

    it('路由结果有序（按中心距离升序 = 点积降序）', () => {
      const fixture = trainFixture({ coarseCenters: 4, fineCenters: 12 });
      const backend = makeIvfBackend(fixture, 4, 12);
      const query = pseudoUnitVector(7);
      const hits = backend.route(query, 4, 12);

      const scores = hits.map((id) => {
        const cell = fixture.model.fine.find((item) => item.fineId === id);
        return referenceDot(query, cell?.centroid ?? new Float32Array(EMBED_DIM));
      });
      for (let index = 1; index < scores.length; index += 1) {
        expect(scores[index - 1] ?? 0).toBeGreaterThanOrEqual(scores[index] ?? 0);
      }
    });
  });

  describe('硬断言：桶内是全量精确点积（不是近似召回）', () => {
    it('命中桶内的 top-K 与「对该桶做全量精确扫描」的 top-K 逐位一致', () => {
      // ⚠️ **桶要够大**（200 条 / 4 个细桶 ⇒ 每桶 ~50 条）⇒ 「只扫前 N 条」的实现会被抓出来。
      const fixture = trainFixture({ count: 200, coarseCenters: 2, fineCenters: 4 });
      const backend = makeIvfBackend(fixture, 2, 1);
      const query = pseudoUnitVector(11);

      const hits = backend.route(query, 2, 1);
      expect(hits).toHaveLength(1);
      const fineId = hits[0];
      expect(fineId).toBeDefined();

      const members = (
        fixture.db
          .prepare('SELECT memory_id FROM vector_cell_members WHERE fine_id = ?')
          .all(fineId) as Array<{ memory_id: string }>
      ).map((row) => row.memory_id);
      expect(members.length).toBeGreaterThan(20);

      const rows = readRows(fixture.db).filter((row) => members.includes(row.id));
      const expected = referenceScan(rows, query, 10);
      const actual = backend.search(query, 10);

      expect(actual.length).toBe(expected.length);
      for (let index = 0; index < expected.length; index += 1) {
        expect(actual[index]?.id).toBe(expected[index]?.id);
        expect(Object.is(actual[index]?.score, expected[index]?.score)).toBe(true);
      }
    });
  });

  describe('硬断言：探针覆盖充分时，IVF 与 flat 逐位一致', () => {
    it('同样的候选、同样排序 ⇒ id 与每个 score 都逐位相同', () => {
      const fixture = trainFixture({ count: 60, coarseCenters: 4, fineCenters: 12 });
      const query = pseudoUnitVector(13);

      // ⚠️ **探针覆盖全部细桶** ⇒ 候选集 == 全库 ⇒ 必须与 flat 一致。
      const ivf = makeIvfBackend(fixture, 4, fixture.model.fine.length);
      const flat = new FlatVectorBackend({ rows: () => readRows(fixture.db) });
      flat.init(CONFIG);

      const ivfHits = ivf.search(query, 20);
      const flatHits = flat.search(query, 20);

      // ⚠️ **非空断言**（否则「两边都空」会让这条断言变成真空负控）。
      expect(flatHits.length).toBeGreaterThan(0);
      expect(ivfHits.length).toBe(flatHits.length);
      for (let index = 0; index < flatHits.length; index += 1) {
        expect(ivfHits[index]?.id).toBe(flatHits[index]?.id);
        expect(Object.is(ivfHits[index]?.score, flatHits[index]?.score)).toBe(true);
      }
    });
  });

  describe('契约：route / search / filter / stats', () => {
    it('search() 的 score 全部 ∈ [0,1]，且不足 k 时返回实际条数', () => {
      const fixture = trainFixture({ count: 30 });
      const backend = makeIvfBackend(fixture, 4, 12);
      const query = pseudoUnitVector(17);

      const hits = backend.search(query, 1000);
      expect(hits.length).toBe(fixture.ids.length);
      for (const hit of hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
        expect(Number.isFinite(hit.score)).toBe(true);
      }
    });

    it('时间窗与排除集生效（后端只「应用」调用方给的值）', () => {
      const fixture = trainFixture({ count: 30 });
      const backend = makeIvfBackend(fixture, 4, 12);
      const query = pseudoUnitVector(17);

      const all = backend.search(query, 100);
      const excluded = backend.search(query, 100, { excludeIds: [all[0]?.id ?? ''] });
      expect(excluded.length).toBe(all.length - 1);
      expect(excluded.map((hit) => hit.id)).not.toContain(all[0]?.id);

      // ⚠️ **粗筛窗口**：把所有行的 `last_access` 推到窗口之外 ⇒ 候选全空。
      fixture.db.prepare('UPDATE memories SET last_access = 1').run();
      const windowed = backend.search(query, 100, { timeFloor: T0 });
      expect(windowed).toEqual([]);
    });

    it('分桶未训练 ⇒ 向量路整体缺席（route 返回空，不是阻塞、也不静默回落 flat）', () => {
      const db = createTestDb();
      const backend = new IvfVectorBackend({
        db,
        centroids: () => loadCentroidModel(db),
        nprobeCoarse: 4,
        nprobeFine: 12,
      });
      backend.init(CONFIG);
      expect(backend.route(pseudoUnitVector(3), 4, 12)).toEqual([]);
      expect(backend.search(pseudoUnitVector(3), 10)).toEqual([]);
    });

    it('stats() 报告成员数、维度、后端名与中心字节数', () => {
      const fixture = trainFixture({ count: 30 });
      const backend = makeIvfBackend(fixture, 4, 12);
      const stats = backend.stats();
      expect(stats.count).toBe(fixture.ids.length);
      expect(stats.dimensions).toBe(EMBED_DIM);
      expect(stats.backend).toBe('ivf');
      const centerCount = fixture.model.coarse.length + fixture.model.fine.length;
      expect(stats.indexBytes).toBe(centerCount * EMBED_DIM * 4);
    });

    it('init() 幂等（连续调用两次不报错、不改变状态）', () => {
      const fixture = trainFixture({ count: 20 });
      const backend = makeIvfBackend(fixture, 4, 12);
      const before = backend.stats();
      expect(() => backend.init(CONFIG)).not.toThrow();
      expect(backend.stats()).toEqual(before);
    });

    it('upsert() 覆盖索引侧的向量与归属；remove() 让它不再出现', () => {
      const fixture = trainFixture({ count: 20 });
      const backend = makeIvfBackend(fixture, 4, 12);
      const query = pseudoUnitVector(19);

      const target = fixture.ids[0] ?? '';
      backend.upsert(target, pseudoUnitVector(999));
      const afterUpsert = backend.search(query, 100).find((hit) => hit.id === target);
      expect(afterUpsert).toBeDefined();
      // ⚠️ 覆盖后的分数 = **upsert 进来的那个向量**算出来的。
      expect(
        Object.is(
          afterUpsert?.score,
          Math.min(1, Math.max(0, referenceDot(query, pseudoUnitVector(999)))),
        ),
      ).toBe(true);

      backend.remove(target);
      expect(backend.search(query, 100).map((hit) => hit.id)).not.toContain(target);
    });

    it('assignFineBucket() 是纯函数：同一向量 ⇒ 同一细桶；空模型 ⇒ null', () => {
      const fixture = trainFixture({ count: 20 });
      const vector = pseudoUnitVector(23);
      const first = assignFineBucket(fixture.model, vector, 2);
      const second = assignFineBucket(fixture.model, vector, 2);
      expect(first).toBe(second);
      expect(first).not.toBeNull();

      const empty = buildCentroidModel([], { coarseCenters: 2, fineCenters: 4 });
      expect(assignFineBucket(empty, vector, 2)).toBeNull();
    });

    it('归属规则用的是「nprobeCoarse 个粗桶」，而不是「只看最近的那 1 个」', () => {
      // ⚠️ **手搭一个模型**，让「最近的细中心」落在**不是最近的那个粗桶**里：
      //   · c-0 的中心 = e0、其细中心 = 0.5·e0（点积 0.5）
      //   · c-1 的中心 = e1、其细中心 = e0（点积 1.0）⇒ 但 c-1 **不是**最近的粗桶
      // ⇒ 只探 1 个粗桶 ⇒ 只能看到 c-0 的细中心；探 2 个 ⇒ 能看到 c-1 的那个 ⇒ 答案不同。
      const e0 = new Float32Array(EMBED_DIM);
      e0[0] = 1;
      const e1 = new Float32Array(EMBED_DIM);
      e1[1] = 1;
      const half = new Float32Array(EMBED_DIM);
      half[0] = 0.5;
      const model: IvfCentroidModel = {
        coarse: [
          { coarseId: 'c-000', centroid: e0 },
          { coarseId: 'c-001', centroid: e1 },
        ],
        fine: [
          { fineId: 'f-000-000', coarseId: 'c-000', centroid: half },
          { fineId: 'f-001-000', coarseId: 'c-001', centroid: e0 },
        ],
      };

      expect(assignFineBucket(model, e0, 1)).toBe('f-000-000');
      expect(assignFineBucket(model, e0, 2)).toBe('f-001-000');
    });

    it('upsert() 的归属用「nprobeCoarse 个粗桶」（不是只看最近的那 1 个）', () => {
      // ⚠️ 同一个手搭模型（见上一条）⇒ 用**探针数 = 2** 的后端 upsert
      //   ⇒ 归属必须是邻桶的那个细桶（若只探 1 个 ⇒ 会归到 f-000-000 ⇒ 断言能红）。
      const db = createTestDb();
      const e0 = new Float32Array(EMBED_DIM);
      e0[0] = 1;
      const e1 = new Float32Array(EMBED_DIM);
      e1[1] = 1;
      const half = new Float32Array(EMBED_DIM);
      half[0] = 0.5;
      const model: IvfCentroidModel = {
        coarse: [
          { coarseId: 'c-000', centroid: e0 },
          { coarseId: 'c-001', centroid: e1 },
        ],
        fine: [
          { fineId: 'f-000-000', coarseId: 'c-000', centroid: half },
          { fineId: 'f-001-000', coarseId: 'c-001', centroid: e0 },
        ],
      };
      const backend = new IvfVectorBackend({
        db,
        centroids: () => model,
        nprobeCoarse: 2,
        nprobeFine: 1,
      });
      backend.init(CONFIG);
      backend.upsert('m-x', e0);
      expect(backend.pendingAssignments().get('m-x')).toBe('f-001-000');
    });

    it('训练算出的归属 == 运行期 `assignFineBucket()` 算出的归属（同一套规则）', () => {
      const fixture = trainFixture({ count: 20, nprobeCoarse: 2 });
      fixture.vectors.forEach((vector, index) => {
        expect(fixture.fineBucketIds[index]).toBe(assignFineBucket(fixture.model, vector, 2));
      });
    });
  });
});

/**
 * ★ **性能轮（2026-11-02）**：`buildCentroidModel` 的两处改动。
 *
 * 背景（缺陷②/①，见 `docs/progress/stage3-progress.md` §3.1）：
 *   · 旧实现「**每个粗桶都从头遍历一遍全部向量**」再按归属过滤 ⇒ `O(粗桶数 × N)`
 *     （默认 200 × 100 万 = 2 亿次比较），而这件事本身只需要 `O(N)`；
 *   · `BucketRebuildOptions` 没有 `maxIterations` 字段 ⇒ 百万级重训没法降迭代换内存。
 *
 * ★ **本组断言的判别力从哪来**（这类「性能改写」最容易写成恒绿）：
 *   ① 不复用被测实现的分堆逻辑 —— 上面 `referenceFineCentroids()` 把**旧的 O(K×N) 写法**
 *      原样重写一遍当参照 ⇒ 两边中心**逐位相同**才通过；
 *   ② 再配一条**负控**：把参照里的成员顺序**故意打乱**，必须**不再相等**
 *      ⇒ 证明「逐位相同」这个判据真的对顺序敏感（否则它只是「两边都跑了同一个函数」）；
 *   ③ `maxIterations` 的透传**不靠「结果不同」**（这份夹具在 1 轮就收敛，结果本来就相同），
 *      而是靠 **`sphericalKmeans` 对非法值的守卫**：值只有真的到达了 kmeans 才会抛
 *      `maxIterations 必须是 ≥ 1 的整数`。这是一条不会因数据而飘的判据。
 */
describe('性能轮 · 单遍分堆必须与旧双层扫描逐位等价', () => {
  /** 旧的 O(粗桶数 × N) 写法（**参照实现**，刻意不用被测代码的分堆）。 */
  function referenceFineCentroids(
    vectors: readonly Float32Array[],
    coarseCenters: number,
    fineCenters: number,
  ): Float32Array[] {
    const coarseResult = sphericalKmeans(vectors, coarseCenters, {});
    const finePerCoarse = Math.max(1, Math.floor(fineCenters / coarseCenters));
    const fine: Float32Array[] = [];
    for (let coarseIndex = 0; coarseIndex < coarseResult.centers.length; coarseIndex += 1) {
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
      for (const centroid of sphericalKmeans(bucketVectors, finePerCoarse, {}).centers) {
        fine.push(centroid);
      }
    }
    return fine;
  }

  it('细中心逐位相同（顺序也相同）⇒ 分堆方式的改写没有改变训练结果', () => {
    const vectors = Array.from({ length: 60 }, (_, index) => pseudoUnitVector(index + 1));
    const model = buildCentroidModel(vectors, { coarseCenters: 4, fineCenters: 40 });
    const reference = referenceFineCentroids(vectors, 4, 40);

    expect(model.fine.length).toBe(reference.length);
    for (let index = 0; index < reference.length; index += 1) {
      const actual = model.fine[index]?.centroid;
      const expected = reference[index];
      expect(actual).toBeDefined();
      expect(expected).toBeDefined();
      if (actual === undefined || expected === undefined) {
        continue;
      }
      // ⚠️ **逐位比较**（不是 `toBeCloseTo`）：分堆顺序一变，细层的初始中心就变
      //   ⇒ 浮点结果会有差异 ⇒ 这正是本用例要抓的东西。
      expect(Array.from(actual)).toEqual(Array.from(expected));
    }
  });

  it('★ 负控：把参照里的成员顺序打乱 ⇒ 中心必须不再相同（证明上一条对顺序敏感）', () => {
    const vectors = Array.from({ length: 60 }, (_, index) => pseudoUnitVector(index + 1));
    const balanced = referenceFineCentroids(vectors, 4, 40);
    // 打乱输入顺序（同一批向量，只是顺序不同）⇒ 初始中心取自「前 K 条」⇒ 结果应当不同
    const shuffled = [...vectors].reverse();
    const shuffledCentroids = referenceFineCentroids(shuffled, 4, 40);
    const identical =
      balanced.length === shuffledCentroids.length &&
      balanced.every((centroid, index) => {
        const other = shuffledCentroids[index];
        return (
          other !== undefined && Array.from(centroid).join(',') === Array.from(other).join(',')
        );
      });
    expect(identical).toBe(false);
  });
});

describe('性能轮 · `maxIterations` 真的到达了 k-means', () => {
  const vectors = Array.from({ length: 30 }, (_, index) => pseudoUnitVector(index + 1));

  it('非法值（0）⇒ 抛 k-means 的守卫错误（值没传到就不会抛）', () => {
    // ⚠️ 这条是**透传的判据**：`buildCentroidModel` 只是把 `maxIterations` 交给
    //   `sphericalKmeans` ⇒ 只有真的交过去了，这个守卫才会响。
    expect(() =>
      buildCentroidModel(vectors, { coarseCenters: 2, fineCenters: 2, maxIterations: 0 }),
    ).toThrowError(/maxIterations 必须是 ≥ 1 的整数/);
  });

  it('★ 负控：不传 `maxIterations` 时**不应该**抛（默认值 25 是合法值）', () => {
    // 与上一条成对 —— 否则「抛错」可能只是「这个函数本来就会抛」。
    expect(() => buildCentroidModel(vectors, { coarseCenters: 2, fineCenters: 2 })).not.toThrow();
  });

  it('合法值（3）⇒ 能跑通，且与默认值的结果一致（这份夹具 1 轮就收敛 ⇒ 结果本就相同）', () => {
    const withThree = buildCentroidModel(vectors, {
      coarseCenters: 4,
      fineCenters: 40,
      maxIterations: 3,
    });
    const withDefault = buildCentroidModel(vectors, { coarseCenters: 4, fineCenters: 40 });
    expect(withThree.fine.map((cell) => cell.fineId)).toEqual(
      withDefault.fine.map((cell) => cell.fineId),
    );
    expect(withThree.fine.length).toBe(withDefault.fine.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  C′ 档 **T04**：两段式可证剪枝（规格 §5.1 / §6 的 A1 · A1′ · A2 · A7 · A8）
// ═══════════════════════════════════════════════════════════════════════════

/** 一天的毫秒数（时间窗夹具用）。 */
const DAY = 24 * 60 * 60 * 1000;

/** 夹具的时间基准。 */
const T04_NOW = 1_700_000_000_000;

/**
 * 造一条与 `base` 余弦**恰好（浮点精度内）等于 `target`** 的单位向量。
 *
 * 用途：把「近重复」钉在 `DEDUP_COS_MIN`（0.92）两侧 —— 一条 0.925、一条 0.915
 * ⇒ 前者该合并、后者不该 ⇒ 剪枝若丢行，边界上的那一条会立刻现形。
 *
 * @param base 基准单位向量
 * @param target 目标余弦（`[-1, 1]`）
 * @param seed 造正交分量的伪随机种子
 * @returns 单位向量
 */
function withCos(base: Float32Array, target: number, seed: number): Float32Array {
  const raw = pseudoUnitVector(seed);
  let projection = 0;
  for (let index = 0; index < raw.length; index += 1) {
    projection += (raw[index] as number) * (base[index] as number);
  }
  const orthogonal = new Float32Array(raw.length);
  let squared = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const value = (raw[index] as number) - projection * (base[index] as number);
    orthogonal[index] = value;
    squared += value * value;
  }
  const inverse = 1 / Math.sqrt(squared);
  const scale = Math.sqrt(Math.max(0, 1 - target * target));
  const result = new Float32Array(base.length);
  for (let index = 0; index < base.length; index += 1) {
    result[index] =
      target * (base[index] as number) + scale * (orthogonal[index] as number) * inverse;
  }
  return normalize(result);
}

/** T04 夹具的一行。 */
interface T04Row {
  /** 记忆 id。 */
  id: string;
  /** 向量（已 L2 归一化）。 */
  vector: Float32Array;
  /** 上次访问时刻（毫秒）。 */
  lastAccess?: number;
  /** pin 倍率（> 1 即被 pin）。 */
  pinFactor?: number;
  /** 是否给它写码（缺省 `true`；`false` ⇒ 造「无码行」，A8 的夹具）。 */
  coded?: boolean;
}

/** T04 的夹具（真库 + 训练 + 落归属 + **落码**）。 */
interface T04Fixture {
  /** 库句柄。 */
  db: Database.Database;
  /** 中心模型。 */
  model: IvfCentroidModel;
  /** 活行 id（升序）。 */
  liveIds: string[];
  /** 无码的活行 id（A8 的判据）。 */
  uncodedIds: string[];
  /** 软删行 id（A1′ 的判据）。 */
  softDeletedIds: string[];
  /** 向量（按 id 索引，含软删行）。 */
  vectors: Map<string, Float32Array>;
}

/**
 * 建 T04 的夹具。
 *
 * 边界（**刻意都要有**，见 §5.1.8 的夹具要求）：
 * · **近重复**：`m-01`/`m-02` 与 `m-00` 的余弦分别是 0.925 / 0.915（`DEDUP_COS_MIN` 两侧）；
 * · **同分不同 id**：`m-00` 与 `m-03` 向量**完全相同** ⇒ 余弦逐位相同 ⇒ 定序只能靠 id；
 * · **无码行**：`m-05` / `m-12` **没有码行**（模拟回填未完成 ⇒ 精确兜底）；
 * · **时间窗**：`m-06` 太旧（不 pin）、`m-07` 太旧但被 pin（走 `pinnedTimeFloor` 那半边）；
 * · **软删**：可选（A1′ 才需要 3 条）—— 软删**保留**桶归属（`forget()` 不调 `unassignBucket`）。
 *
 * ⚠️ **规模刻意小**（50 条活行 + ≤3 条软删）：这几条断言比的是「同一份数据、两条实现的输出
 *   是否逐位相同」⇒ 与规模无关；用大库只会让「哪一位不同」变成灾难（§5.1.8 的结论）。
 * ⚠️ 但**必须多于 `VECTOR_TOPK`（20）**，否则「剪枝」与「全量」天然相等 ⇒ A1 会变成真空断言。
 *
 * @param options 软删行数 + 码宽（★ 码宽缺省 `int8` = 生产写路径的档 ⇒ 既有夹具的字节**一字不变**）
 * @returns 夹具
 */
function t04Fixture(options: { softDeleted?: number; codeWidth?: CodeWidth } = {}): T04Fixture {
  const db = createTestDb();
  const base = pseudoUnitVector(1);

  const rows: T04Row[] = [
    { id: 'm-00', vector: base },
    { id: 'm-01', vector: withCos(base, 0.925, 2) },
    { id: 'm-02', vector: withCos(base, 0.915, 3) },
    { id: 'm-03', vector: base },
    { id: 'm-04', vector: pseudoUnitVector(101) },
    { id: 'm-05', vector: pseudoUnitVector(102), coded: false },
    { id: 'm-06', vector: withCos(base, 0.99, 4), lastAccess: T04_NOW - 400 * DAY },
    { id: 'm-07', vector: withCos(base, 0.98, 5), lastAccess: T04_NOW - 400 * DAY, pinFactor: 2 },
    { id: 'm-08', vector: pseudoUnitVector(103) },
    { id: 'm-09', vector: pseudoUnitVector(104) },
    { id: 'm-10', vector: withCos(base, 0.96, 6) },
    { id: 'm-11', vector: withCos(base, 0.94, 7) },
    { id: 'm-12', vector: pseudoUnitVector(200), coded: false },
    { id: 'm-13', vector: pseudoUnitVector(200) },
    { id: 'm-14', vector: pseudoUnitVector(301) },
    { id: 'm-15', vector: pseudoUnitVector(302) },
    { id: 'm-16', vector: withCos(base, 0.93, 8) },
    { id: 'm-17', vector: pseudoUnitVector(303) },
    { id: 'm-18', vector: withCos(base, 0.921, 9) },
    { id: 'm-19', vector: withCos(base, 0.919, 10) },
  ];
  // 30 条普通行（把候选宇宙撑到 50 条 > `VECTOR_TOPK` ⇒ 剪枝才有东西可剪）
  for (let index = 0; index < 30; index += 1) {
    rows.push({
      id: `m-${String(20 + index).padStart(2, '0')}`,
      vector: pseudoUnitVector(1000 + index),
    });
  }

  const vectors = new Map<string, Float32Array>();
  const liveIds: string[] = [];
  for (const row of rows) {
    insertMemory(db, row.id, row.vector, {
      lastAccess: row.lastAccess ?? T04_NOW,
      pinFactor: row.pinFactor ?? 1,
    });
    vectors.set(row.id, row.vector);
    liveIds.push(row.id);
  }

  // ⚠️ **软删行**：`forget()` 只改 `deleted = 1`、**不调** `unassignBucket`
  //   ⇒ 它们**仍然在桶里**（A1′ 的 `scanned` 偏差就是它们）。
  const softDeletedIds: string[] = [];
  const softDeletedCount = options.softDeleted ?? 0;
  for (let index = 0; index < softDeletedCount; index += 1) {
    const id = `m-9${String(index)}`;
    const vector = withCos(base, 0.97, 20 + index);
    insertMemory(db, id, vector, { deleted: true, lastAccess: T04_NOW });
    vectors.set(id, vector);
    softDeletedIds.push(id);
  }

  // 训练（`trainCentroids()` 只看活行 —— 软删行不进训练集，这是既有口径）
  const trained = trainCentroids(db, {
    coarseCenters: 2,
    fineCenters: 4,
    maxIterations: 5,
    nprobeCoarse: 2,
    now: T04_NOW,
  });

  // 代 T03 落归属：活行用训练算出来的归属；软删行**在训练集之外** ⇒ 现场算一次
  const insertMember = db.prepare(
    'INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)',
  );
  trained.fineBucketIds.forEach((fineId, index) => {
    const id = liveIds[index];
    if (fineId !== null && id !== undefined) {
      insertMember.run(fineId, id);
    }
  });
  for (const id of softDeletedIds) {
    const vector = vectors.get(id);
    if (vector === undefined) {
      continue;
    }
    const fineId = assignFineBucket(trained.model, vector, 2);
    if (fineId !== null) {
      insertMember.run(fineId, id);
    }
  }

  // 落码（只给活行 + `coded !== false` 的行；软删行**永远没有码** —— 回填只扫活行）
  const insertCode = db.prepare(
    'INSERT INTO vector_codes (fine_id, memory_id, code, scale, eps) VALUES (?, ?, ?, ?, ?)',
  );
  const fineIdOf = db.prepare('SELECT fine_id FROM vector_cell_members WHERE memory_id = ?');
  const uncodedIds: string[] = [];
  // ★ **码宽**（T08）：缺省 `int8` ⇒ **走生产写路径的编码器** ⇒ 既有夹具的字节**一字不变**；
  //   传 `int4` / `binary` ⇒ 走 `encodeVectorWithWidth()` ⇒ ⇒ 离线重编码出来的那种库。
  const codeWidth = options.codeWidth ?? 'int8';
  for (const row of rows) {
    if (row.coded === false) {
      uncodedIds.push(row.id);
      continue;
    }
    const fineId = (fineIdOf.get(row.id) as { fine_id: string } | undefined)?.fine_id;
    if (fineId === undefined) {
      continue;
    }
    if (codeWidth === 'int8') {
      const encoded = encodeVector(row.vector);
      insertCode.run(fineId, row.id, codeToBlob(encoded.code), encoded.scale, encoded.eps);
    } else {
      const encoded = encodeVectorWithWidth(row.vector, codeWidth);
      insertCode.run(fineId, row.id, codeToBlobWithWidth(encoded.code), encoded.scale, encoded.eps);
    }
  }

  return { db, model: trained.model, liveIds, uncodedIds, softDeletedIds, vectors };
}

/** 造一个 T04 后端（中心模型从库里加载 ⇒ 走真实的加载路径）。 */
function makeT04Backend(
  fixture: T04Fixture,
  options: { prune: boolean; nprobeFine?: number },
): IvfVectorBackend {
  const backend = new IvfVectorBackend({
    db: fixture.db,
    centroids: () => loadCentroidModel(fixture.db),
    nprobeCoarse: 2,
    nprobeFine: options.nprobeFine ?? fixture.model.fine.length,
    prune: options.prune,
  });
  backend.init(CONFIG);
  return backend;
}

/**
 * 写路径的 `scoreOf`（**照抄** `dedupCandidates.ts` 的注入形状：同一条 SQL、同一个 `cosineOf`）。
 *
 * ⚠️ 由**调用方**注入是 §5.1.1 纪律②：余弦只有一份实现（`dedupCandidates.ts` 的 `cosineOf`），
 *   剪枝原语不自己算点积。
 */
function writeScoreOf(db: Database.Database, query: Float32Array): (id: string) => number | null {
  const one = db.prepare(
    'SELECT embedding FROM memories WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL',
  );
  return (id: string): number | null => {
    const row = one.get(id) as { embedding: Buffer } | undefined;
    return row === undefined ? null : cosineOf(query, blobToVector(row.embedding));
  };
}

/** 写路径的扫描选项（**照抄** `dedupCandidates.ts` 传的三个口径：threshold / k / scoreOf）。 */
function writeScanOptions(
  db: Database.Database,
  query: Float32Array,
): { threshold: number; k: number; scoreOf: (id: string) => number | null } {
  return {
    threshold: DEFAULT_PARAMS.DEDUP_COS_MIN,
    k: DEFAULT_PARAMS.VECTOR_TOPK,
    scoreOf: writeScoreOf(db, query),
  };
}

/** 一条「下游会留下」的候选（写路径 `collectVectorCandidates()` 的等价物）。 */
interface ExpectedCandidate {
  /** 记忆 id。 */
  id: string;
  /** 余弦。 */
  cos: number;
}

/**
 * 从**全量候选行**独立算一遍「下游会留在候选集里的东西」（§4.9 步骤 3a2 的口径）：
 * `cos ≥ DEDUP_COS_MIN` ⇒ 按 (cos 降序, id 升序) 排 ⇒ 取前 `VECTOR_TOPK`。
 *
 * ⚠️ **排序与过滤在这里是手写的**（不复用被测模块的 `pruneTopK`）——
 *   但**余弦公式必须是同一份**（C36）：换一份实现测出来的只是「两份实现之差」。
 *
 * @param query 查询向量
 * @param rows 全量候选行（每个 id 的 `embedding` BLOB）
 * @returns 期望的候选序列
 */
function referenceWriteCandidates(
  query: Float32Array,
  rows: readonly { id: string; embedding: Buffer }[],
): ExpectedCandidate[] {
  const scored: ExpectedCandidate[] = [];
  for (const row of rows) {
    const cos = cosineOf(query, blobToVector(row.embedding));
    if (cos === null || cos < DEFAULT_PARAMS.DEDUP_COS_MIN) {
      continue;
    }
    scored.push({ id: row.id, cos });
  }
  scored.sort((left, right) => {
    if (left.cos !== right.cos) {
      return right.cos - left.cos;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
  return scored.slice(0, DEFAULT_PARAMS.VECTOR_TOPK);
}

/**
 * 把一个 `BucketCandidateScan.rows` 过一遍**下游的**口径（cos 门槛 + 排序 + top-K）
 * —— 因为 `prune` 的 survivors 里可能含「上界够但精确分不够」的占位行（§5.1.6 的推导）。
 *
 * @param query 查询向量
 * @param rows 扫描产物
 * @returns 候选序列
 */
function downstreamCandidates(
  query: Float32Array,
  rows: readonly { id: string; embedding: Buffer }[],
): ExpectedCandidate[] {
  return referenceWriteCandidates(query, rows);
}

/**
 * **HEAD 的候选 SQL**（从 `ivf.ts` 的 `buildBucketCandidateSql()` **手工抄一份**）。
 *
 * ⚠️ **刻意抄而不 import**：A7 要证明的是「`prune = false` 与 **HEAD 的行为**逐位一致」，
 *   如果参照复用生产代码里的构造函数，那测的就是「生产代码 == 生产代码」。
 */
function headCandidateSql(fineIds: readonly string[]): string {
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

describe('T04 · 两段式可证剪枝（A1 / A1′ / A2 / A7 / A8）', () => {
  /** 写路径的探针数（用写入专用的那套）。 */
  const WRITE_COARSE = DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_COARSE;
  const WRITE_FINE = DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE;

  it('★ A1 · 写路径等价：`collectVectorCandidates()` 的候选 **id 序列 + cos + scanned** 逐位相同', () => {
    const fixture = t04Fixture();
    const query = pseudoUnitVector(1); // == `m-00` 的向量 ⇒ 近重复落在阈值两侧

    const all = scanBucketCandidates(fixture.db, fixture.model, query, WRITE_COARSE, WRITE_FINE, {
      prune: false,
    });
    const pruned = scanBucketCandidates(
      fixture.db,
      fixture.model,
      query,
      WRITE_COARSE,
      WRITE_FINE,
      {
        ...writeScanOptions(fixture.db, query),
      },
    );

    // ── 参照：从**全量**候选行手算下游会留下的东西 ──
    const expected = downstreamCandidates(query, all.rows);
    // ── 被测：剪枝后的 survivors 过**同一道**下游口径 ──
    const actual = downstreamCandidates(query, pruned.rows);

    expect(expected.length).toBeGreaterThan(0); // 不是真空通过

    // ① id **序列**（含顺序）逐位相同
    expect(actual.map((item) => item.id)).toEqual(expected.map((item) => item.id));
    // ② cos **逐位**相同（`Object.is`，禁止 `toBeCloseTo`）
    for (let index = 0; index < expected.length; index += 1) {
      expect(Object.is(actual[index]?.cos, expected[index]?.cos)).toBe(true);
    }

    // ③ embedding **字节**逐位相同（同一个 id 的两条路读到的是同一份 BLOB）
    const bytesOf = (
      rows: readonly { id: string; embedding: Buffer }[],
      id: string,
    ): string | undefined => {
      const row = rows.find((item) => item.id === id);
      return row === undefined ? undefined : Buffer.from(row.embedding).toString('hex');
    };
    for (const item of expected) {
      expect(bytesOf(pruned.rows, item.id)).toBe(bytesOf(all.rows, item.id));
    }

    // ④ `scanned` **逐位相同**（本夹具**没有软删成员** ⇒ 两个口径重合；A1′ 才拉开）
    expect(pruned.scanned).toBe(all.scanned);
    // ⑤ 负控：剪枝**真的剪了**（否则上面四条会退化成「全量 == 全量」）
    expect(pruned.exactReads).toBeLessThan(all.rows.length);
    // ⑥ `uncoded` 如实反映「无码行数」（本夹具 2 条 ⇒ 每次都进 survivors）
    expect(pruned.uncoded).toBeGreaterThanOrEqual(fixture.uncodedIds.length);

    fixture.db.close();
  });

  it('★ A1′（负控）· 3 条**软删但保留桶归属**的行 ⇒ `scanned` 偏大 3，而候选仍逐位相同', () => {
    const withSoftDeleted = t04Fixture({ softDeleted: 3 });
    const query = pseudoUnitVector(1);

    // 前置：这 3 条确实「软删 + 有归属」（否则本用例测不到东西）
    expect(withSoftDeleted.softDeletedIds).toHaveLength(3);
    const membership = withSoftDeleted.db
      .prepare(
        `SELECT count(*) AS n FROM vector_cell_members vcm
           JOIN memories m ON m.id = vcm.memory_id
          WHERE m.deleted = 1`,
      )
      .get() as { n: number };
    expect(membership.n).toBe(3);

    const all = scanBucketCandidates(
      withSoftDeleted.db,
      withSoftDeleted.model,
      query,
      WRITE_COARSE,
      WRITE_FINE,
      { prune: false },
    );
    const pruned = scanBucketCandidates(
      withSoftDeleted.db,
      withSoftDeleted.model,
      query,
      WRITE_COARSE,
      WRITE_FINE,
      writeScanOptions(withSoftDeleted.db, query),
    );

    // ★ **偏差是「可预期的算式」，不是免责声明**（§5.1.3）：
    //   软删保留桶归属 ⇒ `scanned`（成员数）比 HEAD 的「活行数」多 3
    expect(pruned.scanned).toBe(all.scanned + 3);

    // 而**结果**一位都不差（软删行走 `scoreOf → null` ⇒ 不进 survivors）
    const expected = downstreamCandidates(query, all.rows);
    const actual = downstreamCandidates(query, pruned.rows);
    expect(actual.map((item) => item.id)).toEqual(expected.map((item) => item.id));
    for (let index = 0; index < expected.length; index += 1) {
      expect(Object.is(actual[index]?.cos, expected[index]?.cos)).toBe(true);
    }
    // 软删行绝不出现在 survivors 里（`deleted = 0` 是候选宇宙的口径）
    for (const id of withSoftDeleted.softDeletedIds) {
      expect(pruned.rows.some((row) => row.id === id)).toBe(false);
    }

    withSoftDeleted.db.close();
  });

  it('★ A2 · 读路径等价：50 条查询（含**带时间窗**与 `{}` 两类 filter）的 `{id, score}` 逐位相同', () => {
    const fixture = t04Fixture();
    const pruning = makeT04Backend(fixture, { prune: true });
    const exact = makeT04Backend(fixture, { prune: false });
    // ⚠️ **两个 k 都要跑**：
    //   · `60` > 成员数（50）⇒ 堆**永远不满** ⇒ 早停不触发（覆盖「不早停」的形状）；
    //   · `40` < 成员数 ⇒ 堆会满 ⇒ 早停真的触发。而这一档**必然踩到「第 K 名的分 = 0」**
    //     （50 条里约一半的余弦为负 ⇒ 被 `clampCos` 钳成 0 ⇒ 大量同分）
    //     ⇒ 只有这一档能验出「`upper` 对**钳制后**的结果键不再成立」那条（`scoreFloor`）。
    const kValues = [DEFAULT_PARAMS.VECTOR_TOPK * 3, 40];

    const filters: Array<{
      name: string;
      filter: { timeFloor?: number; pinnedTimeFloor?: number };
    }> = [
      // ① `{}` ⇒ **不发** Q3 窄列 gate
      { name: '无时间窗（{}）', filter: {} },
      // ② 带窗 ⇒ 走 Q3（`m-06` 被挡、`m-07` 靠 pinned 窗留下）
      {
        name: '带时间窗（30 天 / pinned 800 天）',
        filter: { timeFloor: T04_NOW - 30 * DAY, pinnedTimeFloor: T04_NOW - 800 * DAY },
      },
    ];

    let compared = 0;
    let nonEmpty = 0;
    for (const { name, filter } of filters) {
      for (const k of kValues) {
        for (let seed = 1; seed <= 50; seed += 1) {
          const query = pseudoUnitVector(seed);
          const a = pruning.search(query, k, filter);
          const b = exact.search(query, k, filter);
          if (b.length > 0) {
            nonEmpty += 1;
          }

          expect(a.length, `${name} · k=${String(k)} · seed=${String(seed)} 的条数`).toBe(b.length);
          for (let index = 0; index < b.length; index += 1) {
            // ⚠️ **`Object.is`**：`toBeCloseTo` 会把「浮点求和顺序变了」这类真回归吃掉
            expect(
              Object.is(a[index]?.score, b[index]?.score),
              `${name} · k=${String(k)} · seed=${String(seed)} · 第 ${String(index)} 条 score`,
            ).toBe(true);
            expect(
              a[index]?.id,
              `${name} · k=${String(k)} · seed=${String(seed)} · 第 ${String(index)} 条 id`,
            ).toBe(b[index]?.id);
          }
          compared += 1;
        }
      }
    }
    // 负控：真的比了 200 组（50 查询 × 2 种 filter × 2 个 k）
    expect(compared).toBe(200);
    // ⚠️ 负控之二：**不能「两边都空」**（那会让上面所有逐位比较变成真空通过）
    expect(nonEmpty).toBeGreaterThanOrEqual(190);

    fixture.db.close();
  });

  it('★ A7 · 零影响：`prune = false` 与**手写参照**（照抄 HEAD 的 SQL 与循环）逐位一致', () => {
    const fixture = t04Fixture({ softDeleted: 1 });
    const query = pseudoUnitVector(1);

    // ── ① 手写参照：HEAD 的 SQL + HEAD 的循环 ──
    const fineIds = makeT04Backend(fixture, { prune: false }).route(
      query,
      2,
      fixture.model.fine.length,
    );
    const headRows = fixture.db.prepare(headCandidateSql(fineIds)).all(...fineIds) as Array<{
      id: string;
      content: string;
      content_tokens: string;
      stability: number;
      last_access: number;
      access_count: number;
      difficulty: number;
      embedding: Buffer;
    }>;
    const headHits = headRows
      .map((row) => ({
        id: row.id,
        score: Math.min(1, Math.max(0, referenceDot(query, blobToVector(row.embedding)))),
      }))
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .slice(0, 20);

    // ── ② 被测：写路径 `prune = false` ──
    const scan = scanBucketCandidates(
      fixture.db,
      fixture.model,
      query,
      2,
      fixture.model.fine.length,
      {
        prune: false,
      },
    );
    expect(scan.scanned).toBe(headRows.length);
    expect(scan.rows.map((row) => row.id)).toEqual(headRows.map((row) => row.id));
    for (let index = 0; index < headRows.length; index += 1) {
      expect(Buffer.from(scan.rows[index]?.embedding ?? Buffer.alloc(0)).toString('hex')).toBe(
        Buffer.from(headRows[index]?.embedding ?? Buffer.alloc(0)).toString('hex'),
      );
      expect(scan.rows[index]?.content).toBe(headRows[index]?.content);
    }

    // ── ③ 被测：读路径 `prune = false` ──
    const backend = makeT04Backend(fixture, { prune: false });
    const hits = backend.search(query, 20);
    expect(hits.map((hit) => hit.id)).toEqual(headHits.map((hit) => hit.id));
    for (let index = 0; index < headHits.length; index += 1) {
      expect(Object.is(hits[index]?.score, headHits[index]?.score)).toBe(true);
    }
    // ④ 且 `searchExact()`（同一段代码的显式入口）给的是同一份东西
    expect(backend.searchExact(query, 20).map((hit) => hit.id)).toEqual(hits.map((hit) => hit.id));

    fixture.db.close();
  });

  it('★ A8 · 无码兜底：删掉若干码行 ⇒ 结果与「全码」**逐位相同**，且 `uncoded` 如实计数', () => {
    const fixture = t04Fixture();
    const query = pseudoUnitVector(1);

    const before = {
      write: scanBucketCandidates(fixture.db, fixture.model, query, WRITE_COARSE, WRITE_FINE, {
        ...writeScanOptions(fixture.db, query),
      }),
      read: makeT04Backend(fixture, { prune: true }).search(query, 30),
    };

    // 再删 4 条码行（模拟「回填只做了一半」）。
    // ⚠️ **必须删「本来会被选中」的那几条**（余弦 > 0.92 的近重复）：
    //   若只删几条「反正也进不了候选」的行，本用例连「无码行真的进了 survivors」都没验证到
    //   ⇒ 断言会退化成「两边都空/都没含它」的真空形状。
    // ⚠️ ★ **诚实记（T04 收尾 · 本轮实测，2026-11-05）**：本条**不是**「`upper` 写成 `0`」这个
    //   变异的牙 —— 实测把 `prune.ts` 里无码行的 `upper` 改成 `0` 之后，**本条仍然通过**：
    //   写路径的剪枝队列长度 < `k`（夹具 50 条活行、删 4 条码行之后仍远少于
    //   `VECTOR_TOPK = 20`，且写路径还带 `DEDUP_COS_MIN` 的**上界**门槛 ⇒ 入队只有几条）
    //   ⇒ 堆**永远不会填满** ⇒ 早停判据一次都不执行 ⇒ `upper` 写什么都丢不了行。
    //   （变异实测红的是：下方那条小 `k` 用例 + 同文件两条「命中桶内 top-K 与全量精确扫描
    //     逐位一致」的用例 —— 也就是说该变异**不是全绿**，只是**本条**抓不到它。）
    //   ⇒ 本条守的是「无码行 ⇒ 精确兜底 ⇒ 结果不变」，**真正的牙在下面那条小 `k` 用例**
    //     （`★★ 无码行的上界必须是 +∞：k 小于队列长度时…`）—— 那条才钉「`upper = 0` 会丢行」。
    const removed = ['m-01', 'm-03', 'm-16', 'm-18'];
    fixture.db
      .prepare(`DELETE FROM vector_codes WHERE memory_id IN (${removed.map(() => '?').join(', ')})`)
      .run(...removed);

    const after = {
      write: scanBucketCandidates(fixture.db, fixture.model, query, WRITE_COARSE, WRITE_FINE, {
        ...writeScanOptions(fixture.db, query),
      }),
      read: makeT04Backend(fixture, { prune: true }).search(query, 30),
    };

    // ① 写路径：候选序列与 cos 逐位相同
    const beforeCandidates = downstreamCandidates(query, before.write.rows);
    const afterCandidates = downstreamCandidates(query, after.write.rows);
    expect(afterCandidates.map((item) => item.id)).toEqual(beforeCandidates.map((item) => item.id));
    for (let index = 0; index < beforeCandidates.length; index += 1) {
      expect(Object.is(afterCandidates[index]?.cos, beforeCandidates[index]?.cos)).toBe(true);
    }
    // ② 读路径：`{id, score}` 逐位相同
    expect(before.read.length).toBeGreaterThan(0); // 负控：不是「两边都空」
    expect(after.read.length).toBe(before.read.length);
    for (let index = 0; index < before.read.length; index += 1) {
      expect(after.read[index]?.id).toBe(before.read[index]?.id);
      expect(Object.is(after.read[index]?.score, before.read[index]?.score)).toBe(true);
    }
    // ③ `uncoded` 增长 = 被删的条数（原本 2 条无码 → 6 条）
    expect(after.write.uncoded).toBe(before.write.uncoded + removed.length);
    // ④ `scanned` 不变（它数的是成员数，与码表状态无关 —— §5.1.3 的理由）
    expect(after.write.scanned).toBe(before.write.scanned);

    fixture.db.close();
  });

  it('`countUncodedCandidates()`：数「有成员、无码」的行（**含软删成员**），且**不是**错误/门槛', () => {
    const fixture = t04Fixture({ softDeleted: 2 });

    // 先算一遍命中桶集（把探针吃满 ⇒ 桶集 = 全部细桶）
    const backend = makeT04Backend(fixture, { prune: true });
    const fineIds = backend.route(pseudoUnitVector(1), 2, fixture.model.fine.length);

    // 本夹具：2 条活行无码 + 2 条软删成员无码 = 4
    expect(countUncodedCandidates(fixture.db, fineIds)).toBe(4);
    // 桶集为空 ⇒ 0（不是抛错）
    expect(countUncodedCandidates(fixture.db, [])).toBe(0);
    // 给其中一条补上码 ⇒ 立刻少 1（这是 A8 的「运行时伴生读数」）
    const fineId = (
      fixture.db
        .prepare('SELECT fine_id FROM vector_cell_members WHERE memory_id = ?')
        .get('m-05') as { fine_id: string }
    ).fine_id;
    const encoded = encodeVector(fixture.vectors.get('m-05') ?? new Float32Array(EMBED_DIM));
    fixture.db
      .prepare(
        'INSERT INTO vector_codes (fine_id, memory_id, code, scale, eps) VALUES (?, ?, ?, ?, ?)',
      )
      .run(fineId, 'm-05', codeToBlob(encoded.code), encoded.scale, encoded.eps);
    expect(countUncodedCandidates(fixture.db, fineIds)).toBe(3);
  });

  it('`prune = true` 但调用方**没注入** `scoreOf` ⇒ 响亮失败（不静默退化成「不剪」）', () => {
    const fixture = t04Fixture();
    expect(() =>
      scanBucketCandidates(
        fixture.db,
        fixture.model,
        pseudoUnitVector(1),
        WRITE_COARSE,
        WRITE_FINE,
      ),
    ).toThrowError(/scoreOf/);
    fixture.db.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // T04 补强（追加于本轮 · 2026-11-05）
  //   这两条补的是**变异实验打出来的缺口**：缺的不是「行为」，而是
  //   「**`prune` 的默认值**」与「**无码行在队列里的位次**」这两件事**没有被任何断言看过**。
  //   ⚠️ 订正：这里原先写着「复核人：严过关 / 全量 1,899 条仍然全绿」——
  //     那两处**引用的复核结论与计数本轮无法核实**（复核报告尚未归档），故按实情删掉；
  //     本文件只对**能自己复现的读数**负责（下面两条各自的注释里写的都是可复现的观测面）。
  // ═══════════════════════════════════════════════════════════════════════════

  it('★★ 生产默认 `prune = true`：不传选项 ⇒ 走两段式（**真的读码表**）；显式 `false` ⇒ 老路', () => {
    // ⚠️ 为什么必须单独钉这一条：T04 的**全部收益**都挂在「默认是 true」这一行
    //   （`this.prune = options.prune ?? true`）。它翻转成 `false` 时**结果完全不变**
    //   （A1/A2/A7 都在证明「两条路逐位相同」）⇒ 任何「比结果」的断言都抓不住它
    //   ⇒ 只能观测「**走了哪条路**」：`prune = true` 必须发 `FROM vector_codes`（第一段读码），
    //     `prune = false` 必须不发、且必须发 HEAD 那条 `JOIN` 候选 SQL。
    const fixture = t04Fixture();
    const query = pseudoUnitVector(1);

    /**
     * 跑一次 `search()` 并录下它 prepare 过的全部 SQL。
     *
     * ⚠️ 就地替换 `db.prepare`（与 `bench/lib/harness.ts` 的 `installRowReadCounter()` 同一手法）
     *   ⇒ 用完**逐位还原**。
     *
     * @param prune `undefined` = 不传该选项（测默认值）
     * @returns 这次检索发过的 SQL 文本
     */
    const sqlOfSearch = (prune: boolean | undefined): string[] => {
      const seen: string[] = [];
      const handle = fixture.db as unknown as { prepare: (source: string) => unknown };
      const originalPrepare = handle.prepare;
      handle.prepare = (source: string): unknown => {
        seen.push(source);
        return originalPrepare.call(fixture.db, source);
      };
      try {
        const backend = new IvfVectorBackend({
          db: fixture.db,
          centroids: () => loadCentroidModel(fixture.db),
          nprobeCoarse: 2,
          nprobeFine: fixture.model.fine.length,
          ...(prune === undefined ? {} : { prune }),
        });
        backend.init(CONFIG);
        backend.search(query, 5);
      } finally {
        handle.prepare = originalPrepare;
      }
      return seen;
    };

    const readsCodes = (sqls: readonly string[]): boolean =>
      sqls.some((sql) => /FROM\s+vector_codes\b/i.test(sql));
    /**
     * HEAD 老路**独有的**那条取行 SQL（`readCandidateRows()`：一次把**全部成员**的整行取回来，
     * 含 3KB 的 `embedding`）—— 两段式**不会**发它（它只对 survivors 逐条点查）。
     */
    const readsAllMemberRows = (sqls: readonly string[]): boolean =>
      sqls.some((sql) => /FROM\s+memories\s+WHERE\s+id\s+IN/i.test(sql));

    const defaultSql = sqlOfSearch(undefined);
    // ★ 缺省 ⇒ 两段式：**读码**（第一段），且**不**发「一次取全部成员整行」的老 SQL
    expect(readsCodes(defaultSql)).toBe(true);
    expect(readsAllMemberRows(defaultSql)).toBe(false);

    const legacySql = sqlOfSearch(false);
    // ★ 显式关掉 ⇒ HEAD 老路：**不读码**，且**发**那条「一次取全部成员整行」的 SQL
    expect(readsCodes(legacySql)).toBe(false);
    expect(readsAllMemberRows(legacySql)).toBe(true);

    fixture.db.close();
  });

  it('★★ 无码行的上界必须是 `+∞`：k 小于队列长度时，**本该进 top-k 的无码行不能被早停跳过**', () => {
    // ⚠️ 本条的来历（**不是**重复 prune.test.ts 的同名用例）：
    //   `t04Fixture()` 有 50 条活行，写路径 `k = VECTOR_TOPK = 20`
    //   ⇒ 删掉几条码行之后**队列长度仍 < 20 ⇒ 堆永不填满 ⇒ 早停压根不触发**
    //   ⇒ 「无码行的 `upper` 写成 `0` 而不是 `+∞`」这个变异在 A8 里**打不红**（复核实测：全绿）。
    //   ⇒ 这里用**读路径 + 小 k**（k ≤ 5，堆 3 步就满）把它变成可观测的：
    //     先把「同分不同 id」那两条（余弦 = 1.0）的码行删掉 ⇒ 它们变成**无码且必须进 top-3**，
    //     若 `upper` 不是 `+∞`，它们在按上界排的队列里会沉到最后 ⇒ 早停直接把它们跳掉
    //     ⇒ survivors 变成 m-06/m-07/m-10（0.99/0.98/0.96）⇒ 本条红。
    const fixture = t04Fixture();
    const query = pseudoUnitVector(1);

    // 前提自检：这两条确实**没有码了**（否则本用例测不到「无码」这条路）
    fixture.db.prepare("DELETE FROM vector_codes WHERE memory_id IN ('m-00', 'm-03')").run();
    const stillCoded = fixture.db
      .prepare("SELECT count(*) AS n FROM vector_codes WHERE memory_id IN ('m-00', 'm-03')")
      .get() as { n: number };
    expect(stillCoded.n).toBe(0);

    const pruned = makeT04Backend(fixture, { prune: true });
    const head = makeT04Backend(fixture, { prune: false });

    // ① 与「全量精确」逐位相同（含 k = 1/2/3/5 ⇒ 堆在 3 次读之后就满）
    for (const k of [1, 2, 3, 5]) {
      expect(pruned.search(query, k)).toEqual(head.search(query, k));
    }
    // ② 具体形状（负控：确认 top-3 里**真的**有无码行 —— 否则①可能是「两边都把它们丢了」）
    expect(pruned.search(query, 3).map((hit) => hit.id)).toEqual(['m-00', 'm-03', 'm-06']);

    fixture.db.close();
  });
});

/**
 * ★★★ **T08 · A4 / A5：读路径接线的两条验收**
 * （规格 `docs/design/perf-c2-codewidth-int4-wiring.md` §6 的 A4 / A5）。
 *
 * ★ **A4 守的是「int4 库能跑读路径」**：★ 接线前 `readCodes()` 只认「1 字节/维」
 *   ⇒ ⇒ int4 的 384 B 码行**全被当成坏维度跳过** ⇒ ⇒ 候选宇宙里一条码都没有
 *   ⇒ ⇒ **新码宽的库根本跑不了召回**。
 * ★ **A5 守的是「坏码行 fail-open 不破」**：★ 接线前后的判据从「码长 ≠ 维度」改成
 *   「码长不属于任何已知码宽」⇒ ⇒ **坏码行仍然只是被跳过**（不抛错）⇒ ⇒ 精确兜底。
 */
describe('T08 · 读路径接线（A4 · A5）', () => {
  it('★ A4 · int4 码行能跑读路径：码池认得出 int4 · 结果与「精确路径」逐位相同', () => {
    const fixture = t04Fixture({ codeWidth: 'int4' });
    const pruning = makeT04Backend(fixture, { prune: true });
    const exact = makeT04Backend(fixture, { prune: false });
    const query = pseudoUnitVector(1);

    // ── ① 码池真的认出了 int4（★ 不是「全被当成坏码行跳过了」）──
    const fineIds = pruning.route(query, 2, fixture.model.fine.length);
    const pool = readCodes(fixture.db, fineIds);
    expect(pool.size).toBeGreaterThan(0);
    for (const row of pool.values()) {
      expect(row.codeWidth).toBe('int4');
      expect(row.code.length).toBe(384); // ★ int4 = 384 B（768 维）
    }

    // ── ② 结果与「精确路径」逐位相同 ──
    //   ⚠️ **`scanned`（候选宇宙）与 `exactReads`（进精排行数）会变**（★ 那是**正常的**：
    //   int4 的 ε 约为 int8 的 18 倍 ⇒ 上界更松 ⇒ 剪得更少）⇒ ⇒ 只比**结果集**。
    //   ⇒ ⇒ 而「结果集相同」正是「上界是**可证**上界」的机器背书（★ 剪枝不改变结果集）。
    const pruned = pruning.search(query, 30);
    const head = exact.search(query, 30);
    expect(pruned.length).toBeGreaterThan(0); // 负控：不是「两边都空」
    expect(pruned.length).toBe(head.length);
    for (let index = 0; index < head.length; index += 1) {
      expect(pruned[index]?.id).toBe(head[index]?.id);
      expect(Object.is(pruned[index]?.score, head[index]?.score)).toBe(true);
    }

    fixture.db.close();
  });

  it('★ A5 · 坏码行 fail-open：长度不属于任何档 ⇒ 不抛错 · 该行按「无码」处理（精确兜底）', () => {
    const fixture = t04Fixture();
    const query = pseudoUnitVector(1);

    // ── ① 改坏之前的结果（作为参照）──
    const before = makeT04Backend(fixture, { prune: true }).search(query, 30);
    expect(before.length).toBeGreaterThan(0);
    // ⚠️ 负控：被改坏的那条**本来就会入选**（★ 否则「结果不变」可能是真空通过）
    expect(before.some((hit) => hit.id === 'm-01')).toBe(true);

    // ── ② 把一行码改成「长度不属于任何已知码宽」（★ 100 B：768 / 384 / 96 都不是它）──
    const badId = 'm-01';
    fixture.db
      .prepare('UPDATE vector_codes SET code = ? WHERE memory_id = ?')
      .run(Buffer.alloc(100, 7), badId);

    // ── ③ ★ `readCodes()` **不抛错**，且那一行**不进码池** ──
    const fineIds = makeT04Backend(fixture, { prune: false }).route(
      query,
      2,
      fixture.model.fine.length,
    );
    let pool: Map<string, { codeWidth: CodeWidth }> = new Map();
    expect(() => {
      pool = readCodes(fixture.db, fineIds);
    }).not.toThrow();
    expect(pool.has(badId)).toBe(false);
    // ⚠️ **其余行不受影响**（★ 坏的是**一行**，不是**一列**）
    expect(pool.size).toBeGreaterThan(0);

    // ── ④ ★ 该行按「无码」处理 ⇒ 结果与「把这条码行删掉」**逐位相同** ──
    //   （★ 这就是「fail-open ⇒ 精确兜底」的机器背书：**不抛错、不错召回**）
    const afterBad = makeT04Backend(fixture, { prune: true }).search(query, 30);
    fixture.db.prepare('DELETE FROM vector_codes WHERE memory_id = ?').run(badId);
    const afterDeleted = makeT04Backend(fixture, { prune: true }).search(query, 30);
    expect(afterBad.length).toBe(afterDeleted.length);
    for (let index = 0; index < afterDeleted.length; index += 1) {
      expect(afterBad[index]?.id).toBe(afterDeleted[index]?.id);
      expect(Object.is(afterBad[index]?.score, afterDeleted[index]?.score)).toBe(true);
    }
    // ★ 而且与「改坏之前」也**逐位相同**（★ 坏码行退化成精确兜底 ⇒ 结果不受影响）
    expect(afterBad.length).toBe(before.length);
    for (let index = 0; index < before.length; index += 1) {
      expect(afterBad[index]?.id).toBe(before[index]?.id);
      expect(Object.is(afterBad[index]?.score, before[index]?.score)).toBe(true);
    }

    // ── ⑤ 写路径的 `uncoded` 伴生读数：如实 +1（★ 用**全部细桶** ⇒ 不依赖探针）──
    const writeScan = scanBucketCandidates(
      fixture.db,
      fixture.model,
      query,
      2,
      fixture.model.fine.length,
      {
        ...writeScanOptions(fixture.db, query),
      },
    );
    expect(writeScan.uncoded).toBe(fixture.uncodedIds.length + 1);

    fixture.db.close();
  });

  /**
   * ★★★ **QA 补强 · 「零拷贝视图必须带 `byteOffset`」的机器背书**
   * （★ **本轮 QA 实测发现的假绿盲区**：★ 去掉 `byteOffset` ⇒ **全量 2003 个用例照样全绿**）。
   *
   * ★★ **为什么这条重要**：
   *   `readCodes()` 返回的 `code` 必须是**源 BLOB 的视图**（不是拷贝）
   *   ⇒ ⇒ `new Uint8Array(row.code.buffer, row.code.byteOffset, row.code.byteLength)`
   *   ⇒ ⇒ **三个参数缺一不可**（★ `Buffer` 的 `byteOffset` **不保证为 0**）。
   *
   * ⚠️ ★ **为什么既有测试抓不住**：★ 既有夹具的 BLOB 全部来自 better-sqlite3
   *   ⇒ ⇒ 实测它的 `byteOffset` **恒为 0**（★ QA 已用 `.tmp/bench/*.db` 逐库核过）
   *   ⇒ ⇒ **丢掉 `byteOffset` 结果一模一样** ⇒ ⇒ 既有 2003 个用例**全绿**（★ 实测过）。
   *   ⇒ ⇒ ⇒ 本条**故意造一个 `byteOffset ≠ 0` 的 BLOB** ⇒ ⇒ 丢掉偏移就必须变红。
   *
   * ⚠️ ★ **注意**（★ **设计稿与现实的一处出入 · QA 只报告、不擅自改设计**）：
   *   设计稿 §6 T08 的「实现要点 ①」说「不许写 `new Uint8Array(row.code)`（★ 那会按「元素值」转换
   *   ⇒ 静默算错）」⇒ ★ **对 `Buffer` 源而言这句不准确**：`new Uint8Array(buffer)` 是**按元素值拷贝**
   *   ⇒ ⇒ 字节值**相同**（★ 不算错）⇒ ⇒ 真实后果是「**零拷贝退化成逐行拷贝**」（★ 热读路径上的性能回归）
   *   ⇒ ⇒ 而**真正会「静默算错」**的是 `prune.ts` 的 `signedViewOf()` 丢掉 `byteOffset`
   *   （★ 那才是**重解释** ⇒ 读到另一段字节 ⇒ 上界算错 ⇒ 静默漏检）
   *   ⇒ ⇒ ⇒ 本条断言守的是「**必须零拷贝**」（★ 契约层面），
   *   ⇒ ⇒ ⇒ 而 `tests/unit/prune.test.ts` 里那条守的是「**重解释不许错位**」（★ 值层面）。
   */
  it('★ QA 补强 · `readCodes()` 的 `code` 必须是源 BLOB 的**零拷贝视图**（★ 带 `byteOffset`）', () => {
    // ── 夹具：一块**大缓冲**里切出一段 BLOB ⇒ ★ 它的 `byteOffset ≠ 0` ──
    const backing = Buffer.alloc(EMBED_DIM + 16);
    const blob = backing.subarray(16, 16 + EMBED_DIM);
    // ⚠️ **负控**：夹具真的带非零偏移（★ 否则下面两条是恒绿）
    expect(blob.byteOffset).toBe(16);
    expect(blob.byteLength).toBe(EMBED_DIM);

    // ★ 一个**只认这一行**的假库（★ `readCodes()` 只用到 `prepare().all()`）
    const fakeDb = {
      prepare: () => ({
        all: () => [{ id: 'm-1', code: blob, scale: 1, eps: 0 }],
      }),
    } as unknown as Database.Database;

    const pool = readCodes(fakeDb, ['f-1']);
    const row = pool.get('m-1');
    expect(row).toBeDefined();
    // ★ 码宽自识别：768 B ⇒ int8（★ 这一条说明「行确实进了码池」）
    expect(row?.codeWidth).toBe('int8');

    // ── ★★★ 核心：**零拷贝视图**的三条契约 ──
    // ① 底层 ArrayBuffer 必须是**同一个对象**（⇒ 真的零拷贝，不是拷贝）
    expect(row?.code.buffer).toBe(backing.buffer);
    // ② 偏移必须**原样带过来**（★ 丢了 ⇒ 从第 0 段读起 ⇒ 错位）
    expect(row?.code.byteOffset).toBe(blob.byteOffset);
    // ③ 长度必须原样
    expect(row?.code.byteLength).toBe(blob.byteLength);
    // ④ 字节内容逐位相同（★ 视图与源必须是同一批字节）
    expect([...(row?.code ?? new Uint8Array())]).toEqual([...blob]);
  });
});
