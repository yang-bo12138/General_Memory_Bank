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
import { type IvfCentroidModel, loadCentroidModel } from '../../src/vector/centroids.js';
import { FlatVectorBackend, type VectorCandidateRow } from '../../src/vector/flat.js';
import {
  IvfVectorBackend,
  assignFineBucket,
  buildCentroidModel,
  trainCentroids,
} from '../../src/vector/ivf.js';
import { EMBED_DIM, createTestDb, insertMemories, pseudoUnitVector } from '../fixtures/vector.js';

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
