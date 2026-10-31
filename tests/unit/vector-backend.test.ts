/**
 * P2-T01 的单测 —— `VectorBackend` 契约与 flat 基线后端
 * （对应 DEVELOPMENT-PLAN.md **P2-T01** 的六条硬断言）。
 *
 * ★ **本文件的断言纪律**（沿用阶段 0~1 确立的口径）：
 *   · **六条硬断言逐条对应计划稿**；每条都写成**能被变异打红**的形状
 *     （断言「值」而不是「跑出来是几」：期望值一律写成与公式同源的闭式表达式
 *     或与**手写参考实现**逐位比较）。
 *   · **逐位一致用 `Object.is`**，不用 `toBeCloseTo`——
 *     后者允许 1e-6 级偏差 ⇒ 「浮点顺序不同」这类漂移根本抓不到。
 *   · **参考实现自己手写**（不复用被测的 `dot()`）⇒ 才算「另一条独立路径」。
 *   · **类型层断言用 `@ts-expect-error`**：它同时是「类型层守住了」的证明
 *     ——若哪天 `VectorFilter` 多了 id 白名单字段，这条指令会**编译失败**
 *     （TS 会报「unused '@ts-expect-error' directive」）⇒ 守门是自动的。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import type { VectorBackendConfig, VectorFilter, VectorHit } from '../../src/vector/backend.js';
import { assertValidEmbedding, dot, l2Norm, normalize } from '../../src/vector/dot.js';
import {
  FLAT_ALL_BUCKETS,
  FLAT_BACKEND_NAME,
  FlatVectorBackend,
  type FlatVectorRow,
} from '../../src/vector/flat.js';

// ─────────────────────────── 测试夹具 ───────────────────────────

/** 向量维度（`EMBED_DIM` 是**只读**参数，§6）。 */
const DIM = DEFAULT_PARAMS.EMBED_DIM;

/** 后端配置（维度必须 == `EMBED_DIM`）。 */
const CONFIG: VectorBackendConfig = {
  dimensions: DIM,
  coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
  fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
};

/** 轴向量：第 `axis` 个分量为 1，其余为 0（模长**恰好** = 1）。 */
function axisVector(axis: number): Float32Array {
  const vector = new Float32Array(DIM);
  vector[axis] = 1;
  return vector;
}

/**
 * 确定性伪随机单位向量（线性同余发生器 ⇒ 每次跑出来一模一样）。
 *
 * ⚠️ **不用随机数**：随机向量会让「同分时的次序」不可复现 ⇒ 断言变成 flaky。
 */
function pseudoUnitVector(seed: number): Float32Array {
  const raw = new Float32Array(DIM);
  let state = (seed * 9301 + 49297) % 233280;
  for (let index = 0; index < DIM; index += 1) {
    state = (state * 9301 + 49297) % 233280;
    raw[index] = (state / 233280) * 2 - 1;
  }
  return normalize(raw);
}

/** 一行候选。 */
function row(id: string, vector: Float32Array, lastAccess = 1000, pinFactor = 1): FlatVectorRow {
  return { id, vector, lastAccess, pinFactor };
}

/** 夹具：候选行 + 两个查询向量。 */
interface Fixture {
  rows: FlatVectorRow[];
  /** 轴查询（`e0`）：能构造出**精确可算**的余弦（0.5 / 0 / -1）。 */
  axisQuery: Float32Array;
  /** 伪随机查询：各候选的分数**互不相同** ⇒ 能验排序。 */
  randomQuery: Float32Array;
}

function buildFixture(): Fixture {
  const e0 = axisVector(0);
  const e1 = axisVector(1);

  // ⚠️ **60° 向量直接构造、不过 `normalize()`**：
  //   归一化会把 `b[0]` 从「恰好 0.5」改成 0.49999999 ⇒ 「精确余弦」这条断言就没了。
  //   它的模长在 float32 精度内等于 1（0.5² + 0.75 ≈ 1）⇒ 点积即余弦。
  const sixty = new Float32Array(DIM);
  sixty[0] = 0.5;
  sixty[1] = Math.sqrt(0.75);

  const oneTwenty = new Float32Array(DIM);
  oneTwenty[0] = -0.5;
  oneTwenty[1] = Math.sqrt(0.75);

  const anti = new Float32Array(DIM);
  anti[0] = -1;

  const rows: FlatVectorRow[] = [
    row('m-axis0', e0),
    row('m-60deg', sixty),
    row('m-120deg', oneTwenty),
    row('m-antiparallel', anti),
    row('m-orthogonal', e1),
    row('m-rand-1', pseudoUnitVector(1)),
    row('m-rand-2', pseudoUnitVector(2)),
    row('m-rand-3', pseudoUnitVector(3)),
  ];

  return { rows, axisQuery: e0, randomQuery: pseudoUnitVector(7) };
}

// ─────────────────────────── 手写参考实现 ───────────────────────────

/**
 * 参考实现：手写点积（**不复用** `src/vector/dot.ts` 的 `dot`）。
 *
 * ⚠️ 必须是**另一条独立路径**，否则「逐位一致」只是在验「自己等于自己」。
 */
function referenceDot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) {
      throw new Error('参考实现的越界取值（理论上不可达）');
    }
    sum += left * right;
  }
  return sum;
}

/**
 * 参考实现：手写全表扫描 + 排序 + 取前 k。
 *
 * ⚠️ 排序口径与被测实现**同规则**（相似度降序；同分按 id 升序）——
 *   排序规则是**契约的一部分**（不定死次序 ⇒ 两次检索顺序可能不同 ⇒ 不可复现）。
 */
function referenceSearch(
  rows: readonly FlatVectorRow[],
  query: Float32Array,
  k: number,
): VectorHit[] {
  const scored = rows.map((candidate) => ({
    id: candidate.id,
    score: Math.min(1, Math.max(0, referenceDot(query, candidate.vector))),
  }));
  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.id < right.id) {
      return -1;
    }
    return left.id > right.id ? 1 : 0;
  });
  return scored.slice(0, k);
}

/** 造一个已初始化、候选来源为 `rows` 的 flat 后端。 */
function makeBackend(rows: readonly FlatVectorRow[]): FlatVectorBackend {
  const backend = new FlatVectorBackend({ rows: () => rows });
  backend.init(CONFIG);
  return backend;
}

/** 在候选行里按 id 取一行（取不到就抛错，不静默给 `undefined`）。 */
function findRow(rows: readonly FlatVectorRow[], id: string): FlatVectorRow {
  const found = rows.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`夹具里没有 id = ${id} 的行`);
  }
  return found;
}

/** 参考实现里的分数口径（与 `core/scoring.ts` 的 `clampCos` 同公式）。 */
function referenceScore(query: Float32Array, vector: Float32Array): number {
  return Math.min(1, Math.max(0, referenceDot(query, vector)));
}

// ─────────────────────────── 六条硬断言 ───────────────────────────

describe('P2-T01 · VectorBackend 契约与 flat 基线后端', () => {
  describe('硬断言 ①：init() 连续调用两次不报错、不改变任何状态（幂等）', () => {
    it('第二次 init() 不抛错，且不改变 stats() 与 search() 的结果', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);

      // ⚠️ 先写进一条「索引侧增量」：若 init 不是幂等的（重置了状态），
      //   这条增量就会消失 ⇒ 断言能红。
      const upserted = pseudoUnitVector(11);
      backend.upsert('m-axis0', upserted);

      const statsBefore = backend.stats();
      const hitsBefore = backend.search(randomQuery, 10);

      expect(() => backend.init(CONFIG)).not.toThrow();

      const statsAfter = backend.stats();
      const hitsAfter = backend.search(randomQuery, 10);

      expect(statsAfter).toEqual(statsBefore);
      expect(hitsAfter).toEqual(hitsBefore);
      // ★ 索引侧增量必须还在（init 不得重置它）：
      //   `m-axis0` 的分数仍应是**upsert 进来的那个向量**算出来的。
      const hit = hitsAfter.find((item) => item.id === 'm-axis0');
      expect(Object.is(hit?.score, referenceScore(randomQuery, upserted))).toBe(true);
    });

    it('已初始化后不得改维度（改维度等于全库旧向量作废）', () => {
      const { rows } = buildFixture();
      const backend = makeBackend(rows);
      expect(() => backend.init({ ...CONFIG, dimensions: CONFIG.dimensions - 1 })).toThrowError(
        /维度/,
      );
    });

    it('未 init() 就使用后端 ⇒ 抛错（维度未知会让维度错误静默失效）', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = new FlatVectorBackend({ rows: () => rows });
      expect(() => backend.search(randomQuery, 5)).toThrowError(/初始化/);
    });
  });

  describe('硬断言 ②：search() 返回的 score 全部 ∈ [0,1]', () => {
    it('所有命中的分数都落在 [0,1]，且负余弦被钳到 0', () => {
      const { rows, axisQuery } = buildFixture();
      const backend = makeBackend(rows);
      const hits = backend.search(axisQuery, 100);

      expect(hits.length).toBe(rows.length);
      for (const hit of hits) {
        expect(Number.isFinite(hit.score)).toBe(true);
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
      // ⚠️ 原始余弦为 -1 / -0.5 ⇒ 钳制后必须**恰好**是 0（不是 -0、不是别的）。
      const anti = hits.find((hit) => hit.id === 'm-antiparallel');
      const oneTwenty = hits.find((hit) => hit.id === 'm-120deg');
      expect(anti?.score).toBe(0);
      expect(oneTwenty?.score).toBe(0);
    });
  });

  describe('硬断言 ③：候选不足 k 时返回实际条数（不补齐、不返回 undefined 分数）', () => {
    it('k 大于候选数时，返回条数 == 候选数，且每条都有合法分数', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      const hits = backend.search(randomQuery, 1000);

      expect(hits.length).toBe(rows.length);
      expect(hits.length).toBeLessThan(1000);
      for (const hit of hits) {
        expect(typeof hit.score).toBe('number');
        expect(Number.isNaN(hit.score)).toBe(false);
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
      // ⚠️ **不得出现占位行**（补齐 ⇒ 引入不存在的相似度值 ⇒ 污染归一化）。
      expect(hits.every((hit) => typeof hit.id === 'string' && hit.id.length > 0)).toBe(true);
    });

    it('k = 0 ⇒ 返回空数组', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      expect(backend.search(randomQuery, 0)).toEqual([]);
    });
  });

  describe('硬断言 ④：VectorFilter 类型不含 id 白名单字段（类型层守）', () => {
    it('传 id 白名单编译不过（@ts-expect-error 就是这道守卫）', () => {
      // @ts-expect-error —— `ids` 不在 `VectorFilter` 里：§4.6 步骤 0 的硬边界
      //   「路由只作用于向量路，文本路与图谱路不接受任何 id 白名单过滤」。
      //   ⚠️ 若哪天有人给 `VectorFilter` 加了 id 白名单字段，这条指令会**编译失败**
      //   （TS 报 unused '@ts-expect-error' directive）⇒ 守门是自动的。
      const illegalFilter: VectorFilter = { ids: ['m-axis0'] };
      expect(illegalFilter).toBeDefined();
    });

    it('正向：`timeFloor` / `pinnedTimeFloor` / `excludeIds` 都是合法字段', () => {
      const legalFilter: VectorFilter = {
        timeFloor: 1,
        pinnedTimeFloor: 2,
        excludeIds: ['m-axis0'],
      };
      expect(legalFilter.excludeIds).toEqual(['m-axis0']);
    });

    it('`excludeIds` 只用于「排除本次已入 topN 的记忆」（扩散语义），不是「只在这批 id 里找」', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);

      const excluded = backend.search(randomQuery, 10, { excludeIds: ['m-rand-1'] });
      expect(excluded.map((hit) => hit.id)).not.toContain('m-rand-1');
      // ⚠️ 其余候选**照常**返回（排除不是收窄成「只在这批 id 里」）。
      expect(excluded.length).toBe(rows.length - 1);
    });
  });

  describe('硬断言 ⑤：flat 后端与手写全表点积的参考实现逐位一致', () => {
    it('同一批向量、同一 query ⇒ id 顺序与每个 score 都逐位相同', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);

      const actual = backend.search(randomQuery, 100);
      const expected = referenceSearch(rows, randomQuery, 100);

      expect(actual.length).toBe(expected.length);
      for (let index = 0; index < expected.length; index += 1) {
        expect(actual[index]?.id).toBe(expected[index]?.id);
        // ⚠️ **逐位**（`Object.is`），不用 `toBeCloseTo`。
        expect(Object.is(actual[index]?.score, expected[index]?.score)).toBe(true);
      }
    });

    it('同分时按 id 升序（次序必须可复现）', () => {
      const { rows, axisQuery } = buildFixture();
      const backend = makeBackend(rows);
      const hits = backend.search(axisQuery, 100);

      const zeroScores = hits.filter((hit) => hit.score === 0).map((hit) => hit.id);
      const sorted = [...zeroScores].sort();
      expect(zeroScores).toEqual(sorted);
    });
  });

  describe('硬断言 ⑥：VectorHit.score 是原始余弦（后端不做任何再归一化或重标定）', () => {
    it('分数就是点积本身：60° 向量的分数恰好是 0.5', () => {
      const { rows, axisQuery } = buildFixture();
      const backend = makeBackend(rows);
      const hits = backend.search(axisQuery, 100);

      const sixty = hits.find((hit) => hit.id === 'm-60deg');
      expect(sixty).toBeDefined();
      // ⚠️ `e0 · b = b[0] = 0.5`（float64 精确）⇒ 分数必须**恰好**是 0.5。
      expect(Object.is(sixty?.score, 0.5)).toBe(true);
      expect(Object.is(hits[0]?.score, 1)).toBe(true);
    });

    it('不得按本次最高分归一化（那会把最高分变成 1）', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      const hits = backend.search(randomQuery, 100);

      const top = hits[0];
      expect(top).toBeDefined();
      const raw = referenceDot(
        randomQuery,
        rows.find((item) => item.id === top?.id)?.vector ?? new Float32Array(DIM),
      );
      expect(Object.is(top?.score, raw)).toBe(true);
      // ⚠️ 原始余弦本就 < 1 ⇒ 若被「按最高分归一化」会变成 1。
      expect(raw).toBeLessThan(1);
      expect(top?.score).toBeLessThan(1);
    });
  });

  // ─────────────────── 契约的其余部分（支撑性断言）───────────────────

  describe('契约的其余部分', () => {
    it('route() 返回「全库」标记（flat 没有桶）', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      expect(backend.route(randomQuery, 20, 50)).toEqual([FLAT_ALL_BUCKETS]);
    });

    it('upsert() 是「同 id 覆盖」语义', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      const before = backend.search(randomQuery, 100).find((hit) => hit.id === 'm-axis0');

      backend.upsert('m-axis0', pseudoUnitVector(3));
      const after = backend.search(randomQuery, 100).find((hit) => hit.id === 'm-axis0');

      expect(after).toBeDefined();
      expect(Object.is(after?.score, before?.score)).toBe(false);
      // ⚠️ 覆盖后仍只有**一条** `m-axis0`（不是两条）。
      expect(backend.search(randomQuery, 100).filter((hit) => hit.id === 'm-axis0')).toHaveLength(
        1,
      );
    });

    it('remove() 之后该 id 不再出现（硬删语义）', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      backend.remove('m-rand-2');
      expect(backend.search(randomQuery, 100).map((hit) => hit.id)).not.toContain('m-rand-2');
    });

    it('时间窗：只保留 last_access >= timeFloor 的行（pinned 走宽松窗口）', () => {
      const rows: FlatVectorRow[] = [
        row('m-fresh', pseudoUnitVector(1), 5000, 1),
        row('m-old', pseudoUnitVector(2), 1000, 1),
        row('m-old-pinned', pseudoUnitVector(3), 1000, 2),
      ];
      const backend = makeBackend(rows);
      const hits = backend.search(pseudoUnitVector(7), 100, {
        timeFloor: 4000,
        pinnedTimeFloor: 500,
      });
      const ids = hits.map((hit) => hit.id);
      expect(ids).toContain('m-fresh');
      expect(ids).toContain('m-old-pinned');
      expect(ids).not.toContain('m-old');
    });

    it('stats() 报告条数、维度、后端名与索引字节数', () => {
      const { rows } = buildFixture();
      const backend = makeBackend(rows);
      const stats = backend.stats();
      expect(stats.count).toBe(rows.length);
      expect(stats.dimensions).toBe(DIM);
      expect(stats.backend).toBe(FLAT_BACKEND_NAME);
      expect(stats.indexBytes).toBe(rows.length * DIM * 4);
    });

    it('rebuild() 丢弃索引侧增量，回到「以候选来源为准」', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      const upserted = pseudoUnitVector(11);

      backend.upsert('m-axis0', upserted);
      const during = backend.search(randomQuery, 100).find((hit) => hit.id === 'm-axis0');
      expect(Object.is(during?.score, referenceScore(randomQuery, upserted))).toBe(true);

      backend.rebuild();
      const after = backend.search(randomQuery, 100).find((hit) => hit.id === 'm-axis0');
      // ⚠️ 重建后回到**候选来源里那个向量**算出的分数。
      expect(
        Object.is(after?.score, referenceScore(randomQuery, findRow(rows, 'm-axis0').vector)),
      ).toBe(true);
    });

    it('upsert 一个「尚未落库」的 id ⇒ 不进入结果（候选宇宙以取行来源为准）', () => {
      const { rows, randomQuery } = buildFixture();
      const backend = makeBackend(rows);
      // ⚠️ 该 id **不在**候选来源里 ⇒ 它还不是一条记忆（没有 last_access / pin_factor）
      //   ⇒ 后端不得替它决定「有资格」⇒ 不进结果（§4.15.2：后端不决定候选资格）。
      backend.upsert('m-not-in-source', pseudoUnitVector(11));
      expect(backend.search(randomQuery, 100).map((hit) => hit.id)).not.toContain(
        'm-not-in-source',
      );
    });
  });

  // ─────────────────── `dot.ts` 的工具函数 ───────────────────

  describe('dot.ts：点积与归一化工具', () => {
    it('dot() 长度不等 ⇒ 抛错（不静默取短的那个）', () => {
      expect(() => dot(new Float32Array(3), new Float32Array(4))).toThrowError(/维度/);
    });

    it('dot() 与手写参考实现逐位一致', () => {
      const left = pseudoUnitVector(5);
      const right = pseudoUnitVector(6);
      expect(Object.is(dot(left, right), referenceDot(left, right))).toBe(true);
    });

    it('normalize() 返回新数组且不改入参', () => {
      const source = new Float32Array([3, 4, 0, 0]);
      const normalized = normalize(source);
      expect(normalized).not.toBe(source);
      expect(Array.from(source)).toEqual([3, 4, 0, 0]);
      expect(Math.abs(l2Norm(normalized) - 1)).toBeLessThan(1e-6);
    });

    it('normalize() 拒绝零向量与含 NaN 的向量', () => {
      expect(() => normalize(new Float32Array([0, 0, 0, 0]))).toThrowError(/模长/);
      expect(() => normalize(new Float32Array([Number.NaN, 1, 2, 3]))).toThrowError(/NaN/);
    });

    it('assertValidEmbedding() 拒绝维度不符 / NaN / 零向量', () => {
      expect(() => assertValidEmbedding(new Float32Array(3), DIM)).toThrowError(/维度/);
      const withNan = new Float32Array(DIM);
      withNan[0] = Number.NaN;
      expect(() => assertValidEmbedding(withNan, DIM)).toThrowError(/NaN/);
      expect(() => assertValidEmbedding(new Float32Array(DIM), DIM)).toThrowError(/模长/);
    });
  });
});
