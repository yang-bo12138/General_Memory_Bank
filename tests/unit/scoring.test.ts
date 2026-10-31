/**
 * 融合打分的单测 —— DESIGN-v2.md §4.6 步骤 3 / §4.13.1 硬约束①，
 * 对应 DEVELOPMENT-PLAN.md **P1-T08**。
 *
 * ★ 本文件的断言纪律（沿用阶段 0 确立的口径）：
 *   · **每条硬断言配一条反例**：反例不是「换个输入再看一遍」，而是**故意写出那个会错的写法**，
 *     断言「它会错、而实现不会错」⇒ 证明断言**真能发现不一致**（否则断言只是装饰）。
 *   · **不写死「本次跑出来几条」**：性质类断言用**网格遍历**（输入数组 + 循环），
 *     加一个用例不会让断言失效，删一个也不会被掩盖。
 *   · **数值用例手算可复算**：期望值写成 `Math.exp(-1)` / `1 / (1 + Math.exp(...))` 这类
 *     **与公式同源的闭式表达式**，不写「跑出来是多少就是多少」的快照数字。
 *   · **断言写性质，不写当次的形状**：例如「中位数处 sigmoid 恰为 0.5」是性质，
 *     「第 3 个候选的 normBm25 等于 0.4321」是快照——后者换一个输入就假红。
 */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  MS_PER_DAY,
  archiveAt,
  archiveSpanFactor,
  archiveSpanMs,
  intensity,
} from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import {
  type Bm25Candidate,
  GRAPH_PROXIMITY_SQL,
  NORM_BM25_SLOPE,
  SCORE_FACTOR_NAMES,
  SCORE_WEIGHTS,
  SCORE_WEIGHT_SUM,
  type ScoreFactors,
  type ScoreParts,
  type ScoringDatabase,
  type TextRouteMode,
  archiveFilterThreshold,
  assignGraphProximity,
  clampCos,
  coarseGateWindow,
  cosineSimilarity,
  findMemoriesWithEntityIntersection,
  fuseScore,
  graphProximityOf,
  median,
  normBm25Sigmoid,
  normalizeBm25,
  passesIntensityFilter,
  recency,
} from '../../src/core/scoring.js';
import { archiveAtFactor } from '../../src/db/migrate.js';

/** 生效参数（默认表）。 */
const P: Params = DEFAULT_PARAMS;

/** 天 → 毫秒。 */
const days = (n: number): number => n * MS_PER_DAY;

/** 五项分项之和（用来核对 `score` 与 `breakdown` 的一致性）。 */
function sumParts(parts: ScoreParts): number {
  return (
    parts.intensityPart + parts.vectorPart + parts.textPart + parts.graphPart + parts.recencyPart
  );
}

/**
 * ★ **反例实现**：按「缺项重算分母」的写法算分（**这是被禁止的写法**）。
 *
 * ⚠️ 它存在的唯一目的：让「不重算分母」这条断言**可被证伪**——
 *   一条只会「断言实现 == 期望」的测试，证明不了期望本身是对的。
 */
function renormalizedScore(factors: Partial<ScoreFactors>): number {
  const present = SCORE_FACTOR_NAMES.filter((name) => factors[name] !== undefined);
  const numerator = present.reduce(
    (sum, name) => sum + (factors[name] ?? 0) * SCORE_WEIGHTS[name],
    0,
  );
  const denominator = present.reduce((sum, name) => sum + SCORE_WEIGHTS[name], 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

// ═══════════════════════════════════════════════════════════════════════════
// 五项权重
// ═══════════════════════════════════════════════════════════════════════════

describe('SCORE_WEIGHTS（五项权重）', () => {
  it('权重和恒为 1.0（由权重算出，不是写死的字面量）', () => {
    const sum = SCORE_FACTOR_NAMES.reduce((total, name) => total + SCORE_WEIGHTS[name], 0);
    expect(sum).toBeCloseTo(1, 12);
    // ⚠️ 导出常量必须与「现算」一致 ⇒ 有人改了权重却没同步导出常量时，这条会变红。
    expect(SCORE_WEIGHT_SUM).toBeCloseTo(sum, 12);
  });

  it('五项权重都 > 0 且 < 1（没有一项被「悄悄归零」）', () => {
    for (const name of SCORE_FACTOR_NAMES) {
      expect(SCORE_WEIGHTS[name]).toBeGreaterThan(0);
      expect(SCORE_WEIGHTS[name]).toBeLessThan(1);
    }
  });

  it('★ 反例：改动任一权重 ⇒ 权重和不再为 1 ⇒ 这条断言必须变红', () => {
    const drifted = { ...SCORE_WEIGHTS, intensity: 0.35 };
    const driftedSum = SCORE_FACTOR_NAMES.reduce((total, name) => total + drifted[name], 0);
    expect(driftedSum).not.toBeCloseTo(1, 12);
    // 实现的权重没被动过 ⇒ 仍然是 1
    expect(SCORE_WEIGHT_SUM).toBeCloseTo(1, 12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五因子融合打分
// ═══════════════════════════════════════════════════════════════════════════

describe('fuseScore（五项加权和 == Hit.score）', () => {
  it('★ 恒等式：`score` == 五项加权和 == 五个分项之和（误差 ≤ 1e-9，网格遍历）', () => {
    const values = [0, 0.13, 0.5, 0.8, 1];

    for (const intensity of values) {
      for (const vectorSim of values) {
        for (const normBm25 of values) {
          for (const graphProximity of values) {
            for (const recencyValue of values) {
              const factors: Partial<ScoreFactors> = {
                intensity,
                vectorSim,
                normBm25,
                graphProximity,
                recency: recencyValue,
              };
              const result = fuseScore(factors);

              const expected =
                SCORE_WEIGHTS.intensity * intensity +
                SCORE_WEIGHTS.vectorSim * vectorSim +
                SCORE_WEIGHTS.normBm25 * normBm25 +
                SCORE_WEIGHTS.graphProximity * graphProximity +
                SCORE_WEIGHTS.recency * recencyValue;

              expect(Math.abs(result.score - expected)).toBeLessThanOrEqual(1e-9);
              // 分项之和也必须等于总分（否则 `breakdown` 与 `score` 会各说各话）
              expect(Math.abs(result.score - sumParts(result.breakdown))).toBeLessThanOrEqual(1e-9);
              expect(result.score).toBeGreaterThanOrEqual(0);
              expect(result.score).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it('缺项一律记 0（分项为 0，且分数只由已有项贡献）', () => {
    const result = fuseScore({ intensity: 0.5 });
    expect(result.breakdown.intensityPart).toBeCloseTo(SCORE_WEIGHTS.intensity * 0.5, 12);
    expect(result.breakdown.vectorPart).toBe(0);
    expect(result.breakdown.textPart).toBe(0);
    expect(result.breakdown.graphPart).toBe(0);
    expect(result.breakdown.recencyPart).toBe(0);
    expect(result.score).toBeCloseTo(SCORE_WEIGHTS.intensity * 0.5, 12);
  });

  it('★ **不按缺项重算分母**：缺项的候选拿不到「补偿分」', () => {
    // ⚠️ 设计稿原文（§4.6 步骤 3）：
    //   「**五项权重恒和为 1.0；缺项一律记 0，不重算分母。**」
    //   「⚠️ **为什么不按缺项重算分母**：分母一旦随候选而变，分数就失去可比性——
    //     一条「只有三路命中、且三路都满分」的候选会算出 1.0，压过「五路命中、每路 0.8」的候选（0.8）。
    //     这正是「补偿稀疏候选」的经典翻车现场，而且它在测试里极难被抓到。」
    //
    // ⇒ 「三路命中且都满分」但**另两项真的缺**（没有 embedding / 不在图谱路）时，
    //   它的分只能是「已有三项的权重之和」，**不是** 1.0。
    const sparse: Partial<ScoreFactors> = { intensity: 1, vectorSim: 1, normBm25: 1 };
    const dense: Partial<ScoreFactors> = {
      intensity: 0.8,
      vectorSim: 0.8,
      normBm25: 0.8,
      graphProximity: 0.8,
      recency: 0.8,
    };

    const sparseScore = fuseScore(sparse).score;
    const denseScore = fuseScore(dense).score;

    // 期望值写成「三项权重之和」这个**与公式同源的表达式**，不写死 0.75。
    const expectedSparse =
      SCORE_WEIGHTS.intensity + SCORE_WEIGHTS.vectorSim + SCORE_WEIGHTS.normBm25;
    expect(sparseScore).toBeCloseTo(expectedSparse, 12);
    expect(sparseScore).not.toBeCloseTo(1, 9); // 缺项没被补偿成满分

    // 「五路命中、每路 0.8」= 0.8（权重和为 1 ⇒ 直接就是 0.8）
    expect(denseScore).toBeCloseTo(0.8, 12);

    // ★ 可比性：五路各 0.8 必须**压过**「三路满分但两项真缺」的候选
    expect(denseScore).toBeGreaterThan(sparseScore);
  });

  it('★ 反例：按缺项重算分母 ⇒ 稀疏候选被折算成 1.0 ⇒ 反而压过五路 0.8（必须被抓住）', () => {
    const sparse: Partial<ScoreFactors> = { intensity: 1, vectorSim: 1, normBm25: 1 };
    const dense: Partial<ScoreFactors> = {
      intensity: 0.8,
      vectorSim: 0.8,
      normBm25: 0.8,
      graphProximity: 0.8,
      recency: 0.8,
    };

    // 错的写法：分母随候选而变 ⇒ 稀疏候选折算成满分
    expect(renormalizedScore(sparse)).toBeCloseTo(1, 12);
    expect(renormalizedScore(sparse)).toBeGreaterThan(renormalizedScore(dense));

    // 正确的写法：缺项记 0 ⇒ 稀疏候选拿不到补偿分
    expect(fuseScore(sparse).score).not.toBeCloseTo(renormalizedScore(sparse), 9);
    expect(fuseScore(dense).score).toBeGreaterThan(fuseScore(sparse).score);
  });

  it('★ 「三路命中且各项满分」⇒ 五项齐全 ⇒ score == 1.0（权重和为 1 的直接推论）', () => {
    // ⚠️ 这里与上一条**不矛盾**：上一条里缺的两项是**真的缺**（没有 embedding / 不在图谱路），
    //   而这一条里文本路、向量路、图谱路**都命中且都满分** ⇒ 五项因子全部齐备且为 1
    //   ⇒ score = 权重和 = 1.0。
    // ⇒ 「三路满分压过五路各 0.8」在**没有补偿**的前提下依然成立：
    //   它靠的是「各项都更优」，不是「把缺项折算成分」。
    const threeRoutesFull: Partial<ScoreFactors> = {
      intensity: 1,
      vectorSim: 1,
      normBm25: 1,
      graphProximity: 1,
      recency: 1,
    };
    const dense: Partial<ScoreFactors> = {
      intensity: 0.8,
      vectorSim: 0.8,
      normBm25: 0.8,
      graphProximity: 0.8,
      recency: 0.8,
    };

    expect(fuseScore(threeRoutesFull).score).toBeCloseTo(1, 12);
    expect(fuseScore(dense).score).toBeCloseTo(0.8, 12);
    expect(fuseScore(threeRoutesFull).score).toBeGreaterThan(fuseScore(dense).score);
    // ⇒ 且「五项齐全且全满分 == 1.0」这条**与权重取值无关**（只要权重和为 1）
    expect(SCORE_WEIGHT_SUM).toBeCloseTo(1, 12);
  });

  it('全部缺项 ⇒ score == 0（不是 NaN、不是 undefined）', () => {
    const result = fuseScore({});
    expect(result.score).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });

  it('非法因子（越界 / NaN / Infinity）⇒ INVALID_INPUT（错误码是封闭五码之一）', () => {
    for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        fuseScore({ intensity: bad });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MemoryError);
      expect((caught as MemoryError).code).toBe('INVALID_INPUT');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// normBm25 的三条规则
// ═══════════════════════════════════════════════════════════════════════════

/** 构造一条带原始 BM25 的候选。 */
function candidate(memoryId: string, rawBm25: number | null): Bm25Candidate {
  return { memoryId, rawBm25 };
}

describe('normalizeBm25（§4.6 步骤 3 的三条规则）', () => {
  it('① LIKE 兜底路 ⇒ 全部 normBm25 = 1.0（`raw_bm25` 置 null，不参与中位数）', () => {
    const candidates = [candidate('m1', null), candidate('m2', null), candidate('m3', null)];
    const result = normalizeBm25(candidates, 'like');
    expect(result.normBm25).toHaveLength(candidates.length);
    for (const value of result.normBm25) {
      expect(value).toBe(1);
    }
    // 兜底路没有中位数可言（`raw_bm25` 全是 null）
    expect(result.medianBm25).toBeNull();
  });

  it('② FTS 命中 ⇒ sigmoid 形状正确（中位数处恰为 0.5，越负越接近 1）', () => {
    // ⚠️ FTS5 的 `bm25()` 返回**负值**，越负越相关。
    const candidates = [
      candidate('m1', -12),
      candidate('m2', -8),
      candidate('m3', -4),
      candidate('m4', -6),
    ];
    const result = normalizeBm25(candidates, 'fts');

    expect(result.medianBm25).not.toBeNull();
    const mid = result.medianBm25 as number;

    // 中位数上 sigmoid 恰为 0.5（`1 / (1 + exp(0))`）
    const atMedian = normBm25Sigmoid(mid, mid);
    expect(atMedian).toBeCloseTo(0.5, 12);

    // 方向校验：raw 越负（越相关）⇒ normBm25 越接近 1
    for (const value of result.normBm25) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
    const byId = new Map(candidates.map((c, index) => [c.memoryId, result.normBm25[index] ?? 0]));
    expect(byId.get('m1')).toBeGreaterThan(byId.get('m2') as number); // -12 比 -8 更相关
    expect(byId.get('m2')).toBeGreaterThan(byId.get('m4') as number); // -8 比 -6 更相关
    expect(byId.get('m4')).toBeGreaterThan(byId.get('m3') as number); // -6 比 -4 更相关
  });

  it('② 单调性：raw 越大（越不相关）⇒ normBm25 单调不增（网格遍历）', () => {
    const raws = [-30, -20, -12, -6, -3, -1, 0, 2];
    const candidates = raws.map((raw, index) => candidate(`m${index}`, raw));
    const result = normalizeBm25(candidates, 'fts');

    let previous = Number.POSITIVE_INFINITY;
    for (const value of result.normBm25) {
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('② 未走文本路的条目**严格置 0.0**（混在 FTS 候选里也不给分）', () => {
    const candidates = [
      candidate('m1', -10),
      candidate('m2', null), // 纯图谱 / 纯向量命中
      candidate('m3', -6),
    ];
    const result = normalizeBm25(candidates, 'fts');
    expect(result.normBm25[1]).toBe(0);
    expect(result.normBm25[0]).toBeGreaterThan(0);
    expect(result.normBm25[2]).toBeGreaterThan(0);
  });

  it('③ 整批都没走文本路 ⇒ 全部 0.0（`none` 分支与「FTS 查了却零命中」都算）', () => {
    const allNull = [candidate('m1', null), candidate('m2', null)];

    const noneRoute = normalizeBm25(allNull, 'none');
    for (const value of noneRoute.normBm25) {
      expect(value).toBe(0);
    }
    expect(noneRoute.medianBm25).toBeNull();

    const ftsButEmpty = normalizeBm25(allNull, 'fts');
    for (const value of ftsButEmpty.normBm25) {
      expect(value).toBe(0);
    }
    expect(ftsButEmpty.medianBm25).toBeNull();
  });

  it('★ 纯向量命中的候选（`raw_bm25` 为 null）**不参与中位数** ⇒ median 逐位不变', () => {
    const textHits = [candidate('t1', -12), candidate('t2', -8), candidate('t3', -4)];
    const withVectorOnly = [...textHits, candidate('v1', null)];

    const base = normalizeBm25(textHits, 'fts');
    const extended = normalizeBm25(withVectorOnly, 'fts');

    // 中位数逐位不变（不是「差不多」）
    expect(extended.medianBm25).toBe(base.medianBm25);
    // 文本路命中的三条候选的归一化值也逐位不变
    for (let index = 0; index < textHits.length; index += 1) {
      expect(extended.normBm25[index]).toBe(base.normBm25[index]);
    }
    // 多出来的那条是 0
    expect(extended.normBm25[3]).toBe(0);
  });

  it('★ 反例：把 null 当 0 参与中位数 ⇒ median 被拉偏 ⇒ 文本路命中的分全被改写', () => {
    const textHits = [candidate('t1', -12), candidate('t2', -8), candidate('t3', -4)];
    const wrongMedian = median([...textHits.map((c) => c.rawBm25 ?? 0), 0]);
    const correctMedian = median(textHits.map((c) => c.rawBm25 ?? 0));

    expect(wrongMedian).not.toBe(correctMedian);
    // 正确实现的 median 不受那条 null 候选影响
    const base = normalizeBm25(textHits, 'fts');
    const extended = normalizeBm25([...textHits, candidate('v1', null)], 'fts');
    expect(extended.medianBm25).toBe(base.medianBm25);
    expect(base.medianBm25).toBe(correctMedian);
  });

  it('三条分支互斥且顺序固定（网格遍历：分支 → 期望的整批取值）', () => {
    // ⚠️ 判据是「本次文本路到底走没走 FTS」，**不是**「bm25List 是否为空」
    //   （LIKE 路的 raw_bm25 全是 null ⇒ 用空判据会让兜底路永远落进「全 0」分支）。
    const cases: ReadonlyArray<{ route: TextRouteMode; expected: number }> = [
      { route: 'like', expected: 1 },
      { route: 'fts', expected: -1 }, // FTS 分支逐条算（下面单独断言形状）
      { route: 'none', expected: 0 },
    ];

    for (const { route, expected } of cases) {
      const result = normalizeBm25([candidate('m1', null)], route);
      expect(result.normBm25).toHaveLength(1);
      if (expected >= 0) {
        expect(result.normBm25[0]).toBe(expected);
      }
    }
  });

  it('非法 `raw_bm25`（NaN / Infinity）⇒ INVALID_INPUT（否则整批归一化静默变 NaN）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        normalizeBm25([candidate('m1', bad)], 'fts');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MemoryError);
      expect((caught as MemoryError).code).toBe('INVALID_INPUT');
    }
  });

  it('sigmoid 斜率 0.2 是**刻意硬编码**的（不是参数表里的可调项）', () => {
    expect(NORM_BM25_SLOPE).toBe(0.2);
    // 期望值写成与公式同源的闭式表达式
    expect(normBm25Sigmoid(-5, 0)).toBeCloseTo(1 / (1 + Math.exp(0.2 * -5)), 12);
  });
});

describe('median（中位数）', () => {
  it('奇数个取中间；偶数个取中间两个的平均（网格遍历）', () => {
    expect(median([-3])).toBe(-3);
    expect(median([-3, -1, 5])).toBe(-1);
    expect(median([-3, -1, 5, 9])).toBe(2); // (-1 + 5) / 2
    expect(median([2, 2, 2])).toBe(2);
  });

  it('不改动入参（原数组保持不变）', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('空样本 ⇒ INVALID_INPUT（返回 0 会让归一化基准静默塌成常数）', () => {
    let caught: unknown;
    try {
      median([]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect((caught as MemoryError).code).toBe('INVALID_INPUT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// graphProximity
// ═══════════════════════════════════════════════════════════════════════════

/** 一条 `memory_entities` 行。 */
type EntityRow = readonly [memoryId: string, entityId: string];

/**
 * 最小测试夹具（**不是 §3 的建库脚本**）——只建 `graphProximity` 要用到的一张表。
 */
function makeFixtureDb(rows: readonly EntityRow[]): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE memory_entities (memory_id TEXT NOT NULL, entity_id TEXT NOT NULL);');
  const insert = db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)');
  for (const [memoryId, entityId] of rows) {
    insert.run(memoryId, entityId);
  }
  return db;
}

/** 一次 `prepare` 的调用记录。 */
interface StubCall {
  sql: string;
  params: unknown[];
}

/** 记下全部 SQL 的桩数据库（用来断言「批量查询」与「不写库」）。 */
function makeStubDb(rows: readonly EntityRow[]): { db: ScoringDatabase; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const db: ScoringDatabase = {
    prepare(sql: string) {
      return {
        all(...params: unknown[]): unknown[] {
          calls.push({ sql, params });
          const memoryIds = new Set(JSON.parse(String(params[0] ?? '[]')) as string[]);
          const entityIds = new Set(JSON.parse(String(params[1] ?? '[]')) as string[]);
          return rows
            .filter(([memoryId, entityId]) => memoryIds.has(memoryId) && entityIds.has(entityId))
            .map(([memoryId]) => ({ memory_id: memoryId }));
        },
      };
    },
  };
  return { db, calls };
}

describe('graphProximity（§4.6 步骤 3，全库唯一判定处）', () => {
  it('★ 「只被文本路召回但实体确实相交」的候选 ⇒ graphProximity == 1.0', () => {
    // ⚠️ 设计稿原话：「**不能用「是否由图路召回」代替**」——
    //   图路候选有 LIMIT 100，一条记忆完全可能与上下文实体有交集、
    //   却因为最近使用时间排在第 100 名之外而没进图路候选。
    //   若按「来自哪条路」判，它的 intensity 与 graph 两项会被判 0，直接被挤出 topN。
    const db = makeFixtureDb([
      ['m-text-only', 'e-ctx'], // 只被文本路召回，但实体确实相交
      ['m-unrelated', 'e-other'], // 实体不相交
    ]);

    // 候选集里只有 m-text-only 是文本路命中（**它没进图路候选**）
    const candidates = ['m-text-only', 'm-unrelated'];
    const assigned = assignGraphProximity(db, candidates, ['e-ctx']);

    expect(assigned.get('m-text-only')).toBe(1);
    expect(assigned.get('m-unrelated')).toBe(0);
  });

  it('★ 反例：按「来自哪条路」判定 ⇒ 该候选拿不到 1.0（必须被抓住）', () => {
    const db = makeFixtureDb([['m-text-only', 'e-ctx']]);

    // 错的实现：只认「图路召回过的候选」
    const byRoute = (_memoryId: string, fromGraphRoute: boolean): number =>
      fromGraphRoute ? 1 : 0;
    expect(byRoute('m-text-only', false)).toBe(0);

    // 正确的实现：只看实体交集
    const assigned = assignGraphProximity(db, ['m-text-only'], ['e-ctx']);
    expect(assigned.get('m-text-only')).toBe(1);
  });

  it('实体不相交 ⇒ 0.0；`entityIds` 为空 ⇒ 全部 0.0', () => {
    const db = makeFixtureDb([['m1', 'e1']]);
    expect(graphProximityOf('m1', new Set(['m2']))).toBe(0);
    expect(graphProximityOf('m1', new Set(['m1']))).toBe(1);

    const assigned = assignGraphProximity(db, ['m1'], []);
    expect(assigned.get('m1')).toBe(0);
  });

  it('一次批量查询（不是逐条查）：候选数增加时查询次数不变', () => {
    const { db, calls } = makeStubDb([['m1', 'e1']]);
    const memoryIds = Array.from({ length: 50 }, (_, index) => `m${index}`);

    assignGraphProximity(db, memoryIds, ['e1']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(GRAPH_PROXIMITY_SQL);
  });

  it('`entityIds` 为空 ⇒ **一条查询都不发**（避免 `IN ()` 的语法错误）', () => {
    const { db, calls } = makeStubDb([['m1', 'e1']]);
    const result = assignGraphProximity(db, ['m1'], []);
    expect(calls).toHaveLength(0);
    expect(result.get('m1')).toBe(0);
  });

  it('只发 SELECT（**不写库**）', () => {
    const { db, calls } = makeStubDb([['m1', 'e1']]);
    assignGraphProximity(db, ['m1'], ['e1']);
    for (const call of calls) {
      expect(call.sql.trimStart().toUpperCase().startsWith('SELECT')).toBe(true);
    }
  });

  it('候选 id 去重后传参（同一 id 不会占两个名额）', () => {
    const { db, calls } = makeStubDb([['m1', 'e1']]);
    assignGraphProximity(db, ['m1', 'm1', 'm1'], ['e1', 'e1']);
    const params = calls[0]?.params ?? [];
    expect(JSON.parse(String(params[0] ?? '[]'))).toEqual(['m1']);
    expect(JSON.parse(String(params[1] ?? '[]'))).toEqual(['e1']);
  });

  it('真实 SQLite：批量查询返回的交集集合正确（端到端，不是桩）', () => {
    const db = makeFixtureDb([
      ['m1', 'e1'],
      ['m1', 'e2'],
      ['m2', 'e2'],
      ['m3', 'e3'],
    ]);
    try {
      const intersecting = findMemoriesWithEntityIntersection(db, ['m1', 'm2', 'm3'], ['e1', 'e2']);
      expect([...intersecting].sort()).toEqual(['m1', 'm2']);
    } finally {
      db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// recency
// ═══════════════════════════════════════════════════════════════════════════

describe('recency（§4.6 步骤 3）', () => {
  it('Δt = 0 ⇒ 1；Δt = 一个 τ（RECENCY_DECAY_DAYS 天）⇒ 1/e', () => {
    expect(recency(0, P, 0)).toBe(1);
    expect(recency(0, P, days(P.RECENCY_DECAY_DAYS))).toBeCloseTo(Math.exp(-1), 12);
  });

  it('★ τ 是时间常数不是半衰期：半衰期 = τ × ln2', () => {
    const halfLifeDays = P.RECENCY_DECAY_DAYS * Math.LN2;
    expect(recency(0, P, days(halfLifeDays))).toBeCloseTo(0.5, 12);
    // ⚠️ 若把 τ 当半衰期（直接乘 0.5 天数口径），衰减速率会差 1/ln2 ≈ 1.44 倍
    expect(recency(0, P, days(P.RECENCY_DECAY_DAYS))).not.toBeCloseTo(0.5, 6);
  });

  it('时钟回拨（注入过去时刻）⇒ 恒为 1（`Δt = max(0, ·)`）', () => {
    expect(recency(days(30), P, 0)).toBe(1);
  });

  it('单调不增：now 越大 ⇒ recency 越小，且恒 ∈ (0, 1]', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const offset of [0, 1, 7, 14, 30, 90, 365, 2696]) {
      const value = recency(0, P, days(offset));
      expect(value).toBeLessThanOrEqual(previous);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it('`RECENCY_DECAY_DAYS` 来自参数表（改参数 ⇒ 值跟着变，没被写死）', () => {
    const slower: Params = { ...P, RECENCY_DECAY_DAYS: P.RECENCY_DECAY_DAYS * 2 };
    expect(recency(0, slower, days(P.RECENCY_DECAY_DAYS))).toBeCloseTo(Math.exp(-0.5), 12);
    expect(recency(0, slower, days(P.RECENCY_DECAY_DAYS))).not.toBeCloseTo(
      recency(0, P, days(P.RECENCY_DECAY_DAYS)),
      6,
    );
  });

  it('★ 公式里**没有 confidence**（confidence 走写入侧的 initialDifficulty）', () => {
    // ⚠️ §4.6 步骤 3：「为什么公式里没有 confidence（与 §3 schema 注释一致，避免两处口径冲突）」
    //   · 五项权重之和恰为 1.0，再插一项会破坏这一整洁性；
    //   · confidence 与 intensity 高度相关，再计分等于重复加权。
    // ⇒ confidence 通过**写入侧**的 `initialDifficulty`（§4.3）生效。
    //
    // ⚠️ 这里断言的是**结构**：五个因子里没有 confidence ⇒ 打分侧**不可能**把它算进去。
    expect(SCORE_FACTOR_NAMES).not.toContain('confidence');
    const factors: ScoreFactors = {
      intensity: 1,
      vectorSim: 1,
      normBm25: 1,
      graphProximity: 1,
      recency: 1,
    };
    expect(Object.keys(factors)).not.toContain('confidence');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// cos 的钳制
// ═══════════════════════════════════════════════════════════════════════════

describe('clampCos / cosineSimilarity（§4.6 步骤 2c）', () => {
  it('钳制到 [0, 1]：浮点误差给出的 1.0000001 ⇒ 1；负余弦 ⇒ 0', () => {
    expect(clampCos(1.0000001)).toBe(1);
    expect(clampCos(-0.2)).toBe(0);
    expect(clampCos(0)).toBe(0);
    expect(clampCos(0.5)).toBe(0.5);
    expect(clampCos(1)).toBe(1);
  });

  it('★ 反例：不钳制 ⇒ `cos ≥ VECTOR_MIN_COS` 在边界上不稳定（浮点误差能翻面）', () => {
    const rawDot = 1.0000001;
    expect(rawDot).toBeGreaterThan(1); // 未钳制时它越界了
    expect(clampCos(rawDot)).toBe(1);
    // 另一个方向：负余弦在「相似度」语义下应归 0（语义相反的记忆不该被召回）
    expect(clampCos(-0.999)).toBe(0);
  });

  it('NaN / Infinity ⇒ INVALID_INPUT（否则 score 会变成 NaN 且排序静默失效）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let caught: unknown;
      try {
        clampCos(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MemoryError);
      expect((caught as MemoryError).code).toBe('INVALID_INPUT');
    }
  });

  it('点积：同向 ⇒ 1；反向 ⇒ 0；维度不一致 ⇒ INVALID_INPUT', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);

    let caught: unknown;
    try {
      cosineSimilarity([1, 0], [1, 0, 0]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect((caught as MemoryError).code).toBe('INVALID_INPUT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 准入闸门里的强度精筛（§4.6 步骤 2）
// ═══════════════════════════════════════════════════════════════════════════

describe('archiveFilterThreshold / passesIntensityFilter（§4.6 步骤 2）', () => {
  it('`includeArchived = false` ⇒ 阈值取参数表的 ARCHIVE_LINE', () => {
    expect(archiveFilterThreshold(P, false)).toBe(P.ARCHIVE_LINE);
  });

  it('`includeArchived = true` ⇒ 阈值 0.0（归档记忆照常参与打分与排序）', () => {
    expect(archiveFilterThreshold(P, true)).toBe(0);
  });

  it('精筛是**严格大于**（恰好等于归档线的记忆不进候选）', () => {
    const threshold = archiveFilterThreshold(P, false);
    expect(passesIntensityFilter(threshold, threshold)).toBe(false);
    expect(passesIntensityFilter(threshold + 1e-9, threshold)).toBe(true);
    expect(passesIntensityFilter(threshold / 2, threshold)).toBe(false);
  });

  it('★ 反例：写成 `>=` 会让「恰好落在归档线上」的记忆留在候选集里（边界行为反向）', () => {
    const threshold = archiveFilterThreshold(P, false);
    const wrong = (value: number, limit: number): boolean => value >= limit;
    expect(wrong(threshold, threshold)).toBe(true);
    expect(passesIntensityFilter(threshold, threshold)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 粗筛窗口（§4.6 步骤 2 的两档窗口）—— 三路共用的唯一计算处
// ═══════════════════════════════════════════════════════════════════════════

describe('coarseGateWindow（§4.6 步骤 2 的两档窗口）', () => {
  it('窗口跨度与 §4.6 的推导一致（普通 ≈539 天 / 被 pin ≈2696 天）', () => {
    const now = 1_700_000_000_000;
    const window = coarseGateWindow(P, now, false);

    // ⚠️ 期望值写成**与公式同源的表达式**（不写死 539 / 2696）。
    const plainSpanDays = P.MAX_STABILITY * Math.log(1 / P.ARCHIVE_LINE);
    const pinnedSpanDays = P.MAX_STABILITY * P.MAX_PIN_FACTOR * Math.log(1 / P.ARCHIVE_LINE);

    expect((now - window.coarseCutoff) / MS_PER_DAY).toBeCloseTo(plainSpanDays, 9);
    expect((now - window.coarseCutoffPinned) / MS_PER_DAY).toBeCloseTo(pinnedSpanDays, 9);

    // 与设计稿记的量级一致（539 / 2696 天）
    expect(Math.round((now - window.coarseCutoff) / MS_PER_DAY)).toBe(539);
    expect(Math.round((now - window.coarseCutoffPinned) / MS_PER_DAY)).toBe(2696);
  });

  it('被 pin 的窗口**更宽**（是普通窗口的 MAX_PIN_FACTOR 倍）', () => {
    const now = 1_700_000_000_000;
    const window = coarseGateWindow(P, now, false);
    const plainSpan = now - window.coarseCutoff;
    const pinnedSpan = now - window.coarseCutoffPinned;
    expect(pinnedSpan / plainSpan).toBeCloseTo(P.MAX_PIN_FACTOR, 9);
  });

  it('★ `includeArchived = true` ⇒ 粗筛整体取消（enabled=false 且两个下界都是 0）', () => {
    // ⚠️ §4.6 步骤 2 原话：「令 `@coarseCutoff = 0`（不设 last_access 粗筛）」。
    const window = coarseGateWindow(P, 1_700_000_000_000, true);
    expect(window.enabled).toBe(false);
    expect(window.coarseCutoff).toBe(0);
    expect(window.coarseCutoffPinned).toBe(0);
  });

  it('★ 形状恒定：两种模式的字段集完全相同（防止「有时多一个键」的副本漂移）', () => {
    const withGate = coarseGateWindow(P, 1_700_000_000_000, false);
    const withoutGate = coarseGateWindow(P, 1_700_000_000_000, true);
    expect(Object.keys(withGate).sort()).toEqual(Object.keys(withoutGate).sort());
    // ⚠️ 两个下界的**名字**与 SQL 的绑定名逐字相同 ⇒ 「名字即契约」，接错线一眼看得见。
    expect(Object.keys(withGate).sort()).toEqual(['coarseCutoff', 'coarseCutoffPinned', 'enabled']);
  });

  it('★ 参数可调：改 `MAX_STABILITY` / `ARCHIVE_LINE` ⇒ 窗口跟着变（没被写死成 539/2696）', () => {
    const now = 1_700_000_000_000;
    const base = coarseGateWindow(P, now, false);

    const weaker: Params = { ...P, MAX_STABILITY: P.MAX_STABILITY / 2 };
    const weakerWindow = coarseGateWindow(weaker, now, false);
    expect(now - weakerWindow.coarseCutoff).toBeLessThan(now - base.coarseCutoff);

    const stricter: Params = { ...P, ARCHIVE_LINE: P.ARCHIVE_LINE / 2 };
    const stricterWindow = coarseGateWindow(stricter, now, false);
    // 归档线更低 ⇒ 归档得更早 ⇒ 粗筛窗口必须**更宽**（否则会误杀没到归档线的记忆）
    expect(now - stricterWindow.coarseCutoff).toBeGreaterThan(now - base.coarseCutoff);
  });

  it('★ 同源自洽：窗口下界与 `archiveAt`（τ = MAX_STABILITY）关于 now 互为镜像', () => {
    // ⚠️ 这是「闸门与衰减公式同源」的可测断言：
    //   `archiveAt` = last_access + τ × ln(1/ARCHIVE_LINE) × 86400000（decay.ts）
    //   `coarseCutoff` = now - τ_max × ln(1/ARCHIVE_LINE) × 86400000（本文件）
    //   ⇒ 同一套公式 ⇒ 两者的跨度必须相等（用相对误差断言，避免大数相减的绝对误差）。
    const now = 1_700_000_000_000;
    const window = coarseGateWindow(P, now, false);

    const spanFromArchiveAt =
      archiveAt({ stability: P.MAX_STABILITY, pin_factor: 1, last_access: now }, P) - now;
    const spanFromWindow = now - window.coarseCutoff;

    expect(Math.abs(spanFromArchiveAt - spanFromWindow) / Math.abs(spanFromWindow)).toBeLessThan(
      1e-12,
    );

    // ★ 扩展到**第三处**：`src/db/migrate.ts` 的 `archiveAtFactor`
    //   （迁移回填 `archival_schedule.archive_at` 用它算常数项）。
    //   ⇒ 三个口径（运行时归档时刻 / 迁移回填归档时刻 / 粗筛窗口）必须指向**同一个**归档跨度。
    //   ⚠️ 这三处以前各写一遍 `ln(1/ARCHIVE_LINE)` ⇒ 漂移不会报错，只会「有的记忆早归档、有的晚归档」。
    const spanFromMigrate = P.MAX_STABILITY * archiveAtFactor();
    expect(Math.abs(spanFromMigrate - spanFromWindow) / Math.abs(spanFromWindow)).toBeLessThan(
      1e-12,
    );
  });

  it('★ 粗筛是「粗」的上界：它**不会**挡掉精筛本该放行的记忆（两个口径不打架）', () => {
    // ⚠️ 粗筛用 τ_max（普通 = MAX_STABILITY，被 pin = MAX_STABILITY × MAX_PIN_FACTOR），
    //   精筛用每行自己的 τ ⇒ 粗筛的下界**永远不晚于**精筛的下界
    //   ⇒ 粗筛挡掉的条目，精筛一定也挡 ⇒ 绝不会出现「明明没过归档线却召不回」。
    const now = 1_700_000_000_000;
    const window = coarseGateWindow(P, now, false);

    const stabilities = [1, 7, 30, P.MAX_STABILITY];
    const pinFactors = [1, 2, P.MAX_PIN_FACTOR];
    const agesDays = [1, 100, 539, 540, 2696, 3000];

    for (const stability of stabilities) {
      for (const pinFactor of pinFactors) {
        for (const ageDays of agesDays) {
          const memory = {
            stability,
            pin_factor: pinFactor,
            last_access: now - ageDays * MS_PER_DAY,
          };
          const passesCoarse =
            pinFactor > 1.0
              ? memory.last_access >= window.coarseCutoffPinned
              : memory.last_access >= window.coarseCutoff;
          if (!passesCoarse) {
            // 粗筛挡掉 ⇒ 精筛（intensity ≤ 归档线）也一定挡掉
            expect(intensity(memory, now)).toBeLessThanOrEqual(P.ARCHIVE_LINE);
          }
        }
      }
    }
  });

  it('★ 反例：另写一份窗口（用固定的 539 天）⇒ 改参数后与本函数不一致（必须被抓住）', () => {
    const now = 1_700_000_000_000;
    const window = coarseGateWindow(P, now, false);

    // 错的实现：把 539 天写死（改参数表后不跟着变）
    const hardcoded = now - 539 * MS_PER_DAY;
    expect(hardcoded).not.toBeCloseTo(window.coarseCutoff, 0);

    // 改参数后差距更明显（这才是「漂移」的真正危害：它悄悄变了）
    const drifted = coarseGateWindow({ ...P, MAX_STABILITY: 90 }, now, false);
    const driftedHardcoded = now - 539 * MS_PER_DAY;
    expect(driftedHardcoded).not.toBeCloseTo(drifted.coarseCutoff, 0);
  });
});

// ─────────────────────────────────────────────────────────────
// 归档跨度唯一实现（src/core/decay.ts 是唯一权威）
// ─────────────────────────────────────────────────────────────

describe('归档跨度唯一实现（src/core/decay.ts 是唯一权威）', () => {
  const NOW = 1_700_000_000_000;

  it('★ 三处逐位相同：decay 的唯一实现 / migrate 的 archiveAtFactor / scoring 的粗筛窗口', () => {
    // ① 唯一权威（decay.ts）
    const factor = archiveSpanFactor(P.ARCHIVE_LINE);
    const spanMs = archiveSpanMs(P.ARCHIVE_LINE);

    // ⚠️ 毫秒形态**就是**「因子 × MS_PER_DAY」，不是第二份公式
    expect(spanMs).toBe(factor * MS_PER_DAY);

    // ② migrate.ts：已改为**转发** decay.ts ⇒ 必须**逐位相同**（不是「接近」）
    expect(archiveAtFactor()).toBe(spanMs);
    expect(archiveAtFactor(P.ARCHIVE_LINE)).toBe(spanMs);

    // ③ scoring.ts 的粗筛窗口（τ = MAX_STABILITY ⇒ 窗口跨度 ≡ τ × 归档跨度）
    //    ⚠️ 这里断言的是**下界本身**（不是「now − 下界」）：
    //       后者会把「毫秒级大数相减」的舍入误差混进来 ⇒ 不可能是逐位相同。
    const window = coarseGateWindow(P, NOW, false);
    expect(window.coarseCutoff).toBe(NOW - P.MAX_STABILITY * factor * MS_PER_DAY);
    expect(window.coarseCutoffPinned).toBe(
      NOW - P.MAX_STABILITY * P.MAX_PIN_FACTOR * factor * MS_PER_DAY,
    );
  });

  it('★ 绝对值锚点：归档跨度 = ln(1/ARCHIVE_LINE) 天（权威实现被改成 ×2 ⇒ 这条必须变红）', () => {
    // ⚠️ 期望值**独立重算**（不引用被测导出）⇒ 导出被篡改时这条立刻变红。
    const expectedFactor = Math.log(1 / P.ARCHIVE_LINE);
    const expectedSpanMs = expectedFactor * MS_PER_DAY;

    expect(archiveSpanFactor(P.ARCHIVE_LINE)).toBe(expectedFactor);
    expect(archiveSpanMs(P.ARCHIVE_LINE)).toBe(expectedSpanMs);

    // decay.ts 的 `archiveAt`：τ = 1 天 ⇒ 跨度就是「一天衰减到归档线」的毫秒数
    const oneDay = archiveAt({ stability: 1, pin_factor: 1, last_access: 0 }, P);
    expect(oneDay).toBe(expectedSpanMs);
    expect(oneDay / MS_PER_DAY).toBeCloseTo(Math.log(20), 12);

    // migrate.ts 的 `archiveAtFactor`（迁移回填 `archival_schedule.archive_at` 用它）
    expect(archiveAtFactor()).toBe(expectedSpanMs);
    expect(archiveAtFactor() / MS_PER_DAY).toBeCloseTo(Math.log(20), 12);
  });

  it('★ 负控：把权威实现改成 ×2 ⇒ 依赖它的两处（migrate / scoring 粗筛）必须同时分家', () => {
    // 模拟「decay.ts 的唯一实现被改成 ×2」这一**实际会发生**的漂移（C36）。
    const authoritySpanMs = archiveSpanMs(P.ARCHIVE_LINE);
    const tamperedFactor = archiveSpanFactor(P.ARCHIVE_LINE) * 2;
    const tamperedSpanMs = tamperedFactor * MS_PER_DAY;

    // ① 迁移侧（转发 decay.ts）：权威 ×2 ⇒ 迁移侧**跟着** ×2
    //    ⇒ 「绝对值锚点」那条（`archiveAtFactor()` 对 `ln(1/L) × MS_PER_DAY`）会红。
    expect(archiveAtFactor()).toBe(authoritySpanMs); // 现在：迁移侧 = 权威
    expect(tamperedSpanMs).not.toBe(authoritySpanMs); // 篡改后：分家
    expect(tamperedSpanMs / authoritySpanMs).toBeCloseTo(2, 12);

    // ② 粗筛窗口侧：它用的是**自己那份**副本 ⇒ 权威 ×2 而窗口没变 ⇒ 两者分家
    //    ⇒ 「三处逐位相同」那条断言会红。
    const windowCutoff = coarseGateWindow(P, NOW, false).coarseCutoff;
    expect(windowCutoff).not.toBe(NOW - P.MAX_STABILITY * tamperedFactor * MS_PER_DAY);
    expect(windowCutoff).toBe(
      NOW - P.MAX_STABILITY * archiveSpanFactor(P.ARCHIVE_LINE) * MS_PER_DAY,
    );
  });

  it('★ 结构护栏：`src/db/migrate.ts` 不得再自带「天→毫秒」的字面量（副本漂移的结构性禁令）', () => {
    // ⚠️ 为什么要读源码：上面的数值断言只能证明「**此刻**相等」，
    //   证明不了「以后没人再抄一份」⇒ 这里把「不得出现副本」这条纪律**钉死**。
    const source = readFileSync(new URL('../../src/db/migrate.ts', import.meta.url), 'utf8');

    // ⚠️ 只查代码行：注释里允许引用设计稿原文（§9.4.1 的公式就写着 86400000）。
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
    const code = codeLines.join('\n');
    const literalLines = codeLines.filter((line) => /86_400_000|86400000/.test(line));
    expect(literalLines).toEqual([]);

    // 且它必须**转发**唯一权威（而不是自己再算一遍）
    expect(code).toContain('archiveSpanMs');
    expect(code).not.toContain('Math.log(1 / archiveLine)');
  });
});
