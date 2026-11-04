/**
 * **T06 ·「登记 1」接线守卫 —— 剪枝率（PRUNE_RATE）的分子必须是「调用次数」。**
 *
 * ⚠️ ★ **这条守卫要防的是什么**（T06 独立验证时登记的「登记 1」）：
 *   `bench/perf.ts` 的落盘处把剪枝率算成
 *   `sample.embeddingCalls / sample.candidateUniverse`
 *   ⇒ **分子是「`scoreOf` 的 `get()` 调用次数」**（**无条件**计数 ⇒ 返回 `undefined` 也计）
 *   ⇒ ⇒ 它**定义上**等于 `prune` 的 `exactReads`（`src/vector/prune.ts:289-290`）。
 *
 * ⚠️ ★★ **为什么「43 条已有断言」抓不住它**（本文件存在的唯一理由）：
 *   `embeddingCalls`（调用次数）与 `embeddingExactRows`（**返回行数**）在**健康场景下相等**
 *   ⇒ ⇒ **把分子换成 `embeddingExactRows`，落盘数值一模一样** ⇒ ⇒ 43 条断言**全绿**
 *   ⇒ ⇒ **守卫没有牙**。
 *   ⇒ ⇒ 本文件先**造一个「白调用」场景**（`scoreOf` 返回 `null` ⇒ 消耗了一次调用却没产生行）
 *   ⇒ ⇒ **两个候选分子在每个样本上都不相等** ⇒ ⇒ 断言才有牙。
 *
 * ⚠️ ★★★ **方向纪律（为什么必须是「调用次数」而不是「返回行数」）**：
 *   门槛是「**≤**」⇒ **分子偏小 = 更容易过 = 偏松 = 假绿**。
 *   最坏情形：**命中桶内全是软删成员** ⇒ 「返回行数」= 0 ⇒ 剪枝率 0% ⇒ **假绿**。
 *   ⇒ ⇒ 分子必须取**偏大**的那一个（调用次数）⇒ 门槛才是**严**的。
 *
 * ⚠️ ★★★★ **本文件只新增、不改任何既有文件**：
 *   · `src/**` **零改动**（硬边界）；
 *   · `bench/**` **零改动**（工程师地盘）；
 *   · 白调用场景**只动本文件自己新建的临时库**（`mkdtempSync` ⇒ 零并发风险）。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CORPUS_OPTIONS } from '../../bench/corpus.js';
import { prepareBench } from '../../bench/lib/db.js';
import { BENCH_NOW, installRowReadCounter, openBenchDatabase } from '../../bench/lib/harness.js';
import {
  type CountSummary,
  type PerfResult,
  type VectorByteReads,
  measurePerf,
  toCountSummary,
} from '../../bench/perf.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';

/** 冒烟语料规模（**故意很小** ⇒ 门禁秒级完成）。 */
const SMOKE_SIZE = 1500;
/** 粗中心数（**比生产小** ⇒ 训练秒级完成）。 */
const SMOKE_COARSE = 8;
/**
 * 细中心数。
 *
 * ⚠️ ★ **为什么必须是 20（⇒ 细桶数 ≤ 探针数 20）**：
 *   读路径探针 `ROUTER_NPROBE_FINE = 50`、写路径探针 `ROUTER_NPROBE_WRITE_FINE = 20`
 *   ⇒ 细桶数 ≤ 20 ⇒ **每次扫描都命中全部细桶** ⇒ **候选宇宙在采样窗口内逐样本恒定**
 *   ⇒ ⇒ 落盘的 `pruneRate` 与 `embeddingCalls` 之间存在**同一个分母 U**
 *   ⇒ ⇒ 断言可以**逐位相等**（不是近似）。
 *   ⚠️ 若细桶数 > 20 ⇒ 每次命中不同子集 ⇒ 分母逐样本变化 ⇒ 该等式不再成立
 *   ⇒ ⇒ 本文件**把「候选宇宙恒定」写成显式前提断言**（前提破了 ⇒ 门禁红 ⇒ 不会悄悄变成恒绿）。
 */
const SMOKE_FINE = 20;
/** 查询数（读路径样本数）。 */
const SMOKE_QUERIES = 3;
/** 写入数（写路径样本数）。 */
const SMOKE_WRITES = 3;

/**
 * ★ **`scoreOf` 的真实 SQL**（逐字取自生产的两处调用点）：
 *   · `src/vector/ivf.ts:1244`（读路径 `makeScoreOf`）；
 *   · `src/store/dedupCandidates.ts:310`（写路径 `scoreOf`）。
 *
 * ⚠️ **为什么必须逐字一致**：bench 的行读计数器按**形状**（表集合 + 源列名集合）认领来源
 *   ⇒ 这条 SQL 命中登记形状 `scoreOf` ⇒ 它的 `.get()` 才会被记进 `embeddingCalls`。
 *   ⇒ 一旦生产改了这条 SQL 的形状 ⇒ 计数口径就变了 ⇒ **本文件必须红**（而不是悄悄失明）。
 */
const SCORE_OF_SQL =
  'SELECT embedding FROM memories WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL';

/** 一条「剪枝率样本」：某一次扫描的三个计数。 */
interface PruneRateSample {
  /** `scoreOf` 的 `get()` **调用次数**（无条件计数）。 */
  readonly calls: number;
  /** `scoreOf` 的 `get()` **返回了行**的次数。 */
  readonly rows: number;
  /** 候选宇宙（分母）。 */
  readonly universe: number;
}

/**
 * ★ **剪枝率分子口径的判别器（纯函数 · 喂数据）**。
 *
 * ⚠️ **它复刻的是 `bench/perf.ts` 的落盘口径**：
 *   `sample.candidateUniverse > 0 ? <分子> / sample.candidateUniverse : 0`
 *   ⇒ ⇒ 分母规则、聚合函数（`toCountSummary`）**都用生产的那一份**（不是重写一遍）。
 *
 * @param samples 逐样本的三个计数
 * @param numerator 分子取哪一个（`calls` = 调用次数 / `rows` = 返回行数）
 * @returns 剪枝率的分布（`CountSummary`）
 */
function pruneRateDistribution(
  samples: readonly PruneRateSample[],
  numerator: 'calls' | 'rows',
): CountSummary {
  return toCountSummary(
    samples.map((sample) => {
      const value = numerator === 'calls' ? sample.calls : sample.rows;
      return sample.universe > 0 ? value / sample.universe : 0;
    }),
  );
}

/** 把源码里的空白折叠成单空格（⇒ 比对 SQL 时不因换行而误报）。 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// §A · 地基：harness 侧的「无条件计数」
// ═══════════════════════════════════════════════════════════════════════════

describe('§A · 地基：`embeddingCalls` 数的是「调用次数」（返回 `undefined` 也计）', () => {
  it('★ 白调用（`get()` 返回 `undefined`）**照样**计入 `embeddingCalls`，但不进 `embeddingExactRows`', () => {
    // ⚠️ **前提：这条 SQL 必须是生产真正在跑的那一条**（否则计数口径已经漂移 ⇒ 本守卫失明）。
    const ivfSource = readFileSync(new URL('../../src/vector/ivf.ts', import.meta.url), 'utf8');
    const dedupSource = readFileSync(
      new URL('../../src/store/dedupCandidates.ts', import.meta.url),
      'utf8',
    );
    expect(collapseWhitespace(ivfSource)).toContain(collapseWhitespace(SCORE_OF_SQL));
    expect(collapseWhitespace(dedupSource)).toContain(collapseWhitespace(SCORE_OF_SQL));

    const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-t06-prune-wiring-a-'));
    const db = openBenchDatabase(join(dir, 'harness.db'));
    try {
      // 一条「活且有向量」的行（⇒ `get()` 返回行）。
      db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, source, ' +
          'confidence, stability, difficulty, pin_factor, created_at, last_access, access_count) ' +
          "VALUES ('live','fact','a','a','h-live',@embedding,'bench',0.7,30,0.5,1,@now,@now,0)",
      ).run({ embedding: Buffer.alloc(3072), now: BENCH_NOW });
      // 一条「软删」的行（⇒ `deleted = 1` ⇒ `get()` 返回 `undefined` ⇒ **白调用**）。
      db.prepare(
        'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, source, ' +
          'confidence, stability, difficulty, pin_factor, created_at, last_access, access_count, deleted, deleted_at) ' +
          "VALUES ('deleted','fact','b','b','h-deleted',@embedding,'bench',0.7,30,0.5,1,@now,@now,0,1,@now)",
      ).run({ embedding: Buffer.alloc(3072), now: BENCH_NOW });

      // ⚠️ **装计数器必须在备语句之前**（`installRowReadCounter` 接管 `db.prepare`）。
      const counter = installRowReadCounter(db);
      try {
        counter.start();
        const statement = db.prepare(SCORE_OF_SQL);
        const live = statement.get('live');
        const deleted = statement.get('deleted');
        const missing = statement.get('missing');
        counter.stop();

        // ⚠️ ★ **前提**：三个 `.get()` 的结果形态（一条行 + 两条 `undefined`）。
        expect(live).toBeDefined();
        expect(deleted).toBeUndefined();
        expect(missing).toBeUndefined();

        const snapshot = counter.snapshot();
        // ★ **「调用次数」无条件计数** ⇒ 三次调用**全部**计入。
        expect(snapshot.embeddingCalls).toBe(3);
        // ★ **「返回行数」只数返回了的** ⇒ 只有一次。
        expect(snapshot.embeddingExactRows).toBe(1);
        expect(snapshot.embeddingRowsRead).toBe(1);
        // ⚠️ **零命中零来源**（⇒ SQL 命中登记形状 `scoreOf` ⇒ 计数口径没漂）。
        expect(snapshot.unclassifiedRows).toBe(0);
        expect(Object.keys(snapshot.bySource)).toEqual(['exactEmbedding']);
      } finally {
        counter.uninstall();
      }
    } finally {
      db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §B · 接线：落盘的 `pruneRate` 分子必须是「调用次数」
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **接线断言**：`pruneRate` 的分布逐位等于「调用次数」口径，且**逐位不等于**「返回行数」口径。
 *
 * @param label 路径名（用于断言消息）
 * @param block 该路径的字节读数落盘结构
 */
function assertPruneRateUsesCallsBasis(label: string, block: VectorByteReads): void {
  const universe = block.candidateUniverse;
  const calls = block.breakdown.embeddingCalls;
  const rows = block.breakdown.embeddingExactRows;
  const rate = block.breakdown.pruneRate;

  // ── 前提 ①：候选宇宙**逐样本恒定**（⇒ 分子/分母映射里分母是同一个 U）。
  expect(universe.min, `${label} 候选宇宙必须逐样本恒定`).toBe(universe.max);
  const u = universe.max;
  expect(u).toBeGreaterThan(0);

  // ── 前提 ②：三个分布**样本数一致**（⇒ 它们描述的是同一批样本）。
  expect(rate.count).toBe(calls.count);
  expect(calls.count).toBe(rows.count);

  // ── ★ 前提 ③：**每个样本**的「调用次数」都严格大于「返回行数」。
  //   ⇒ ⇒ 两个候选分子在**每一个样本上**都不可区分地不同 ⇒ ⇒ 本守卫**不是恒绿的**。
  expect(calls.min, `${label} 必须存在白调用（调用次数 > 返回行数）`).toBeGreaterThan(rows.max);

  // ── ★★ 接线：**逐位**等于「调用次数 ÷ 候选宇宙」。
  //   ⚠️ `min`/`max`/`p50`/`p99` 都是「某一个具体样本的比值」⇒ 逐位相等（不是近似）。
  for (const stat of ['min', 'max', 'p50', 'p99'] as const) {
    expect(rate[stat], `${label} pruneRate.${stat} 必须逐位等于「调用次数」口径`).toBe(
      calls[stat] / u,
    );
    // ★ **反向**：同一个统计量**不得**等于「返回行数」口径（⇒ 换分子必红）。
    expect(
      rate[stat],
      `${label} pruneRate.${stat} 不得等于「返回行数」口径（换分子必红）`,
    ).not.toBe(rows[stat] / u);
  }

  // ⚠️ `mean` 是「逐样本比值的均值」⇒ 与「calls 的均值 ÷ U」**可能差 1 ULP**（求和顺序）。
  expect(rate.mean).toBeCloseTo(calls.mean / u, 12);
  expect(rate.mean).not.toBeCloseTo(rows.mean / u, 6);
}

describe('§B · 接线：落盘的 `pruneRate` 分子 =「调用次数」（不是「返回行数」）', () => {
  /** `measurePerf` 的结果（§B 的断言共用同一份 ⇒ 跑一次就够）。 */
  let measured: PerfResult | null = null;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-t06-prune-wiring-b-'));
    const dbPath = join(dir, 'bench.db');
    const prepared = prepareBench({
      dbPath,
      corpus: { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE },
      coarseCenters: SMOKE_COARSE,
      fineCenters: SMOKE_FINE,
      nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    });
    const db = prepared.db;

    // ⚠️ ★★ **造「白调用」场景**（这是本守卫有牙的**唯一**原因）：
    //   ① 软删**一半**桶成员（`deleted = 1` ⇒ `scoreOf` 的 `deleted = 0` 过滤命中 ⇒ 返回 `null`）；
    //   ② **删掉这些成员的码行** ⇒ 它们变成「无码」成员 ⇒ `upper = +∞`（`src/vector/prune.ts`）
    //      ⇒ **必被精确重排** ⇒ **必被 `scoreOf` 调一次** ⇒ ⇒ **白调用必然发生**（不靠运气）。
    //   ⇒ ⇒ 落盘的 `embeddingCalls`（调用次数）**严格大于** `embeddingExactRows`（返回行数）。
    const members = db
      .prepare('SELECT fine_id, memory_id FROM vector_cell_members ORDER BY fine_id, rowid')
      .all() as Array<{ fine_id: string; memory_id: string }>;
    const perBucket = new Map<string, string[]>();
    for (const row of members) {
      const list = perBucket.get(row.fine_id) ?? [];
      list.push(row.memory_id);
      perBucket.set(row.fine_id, list);
    }
    const victims: string[] = [];
    for (const list of perBucket.values()) {
      for (let index = 0; index < Math.floor(list.length / 2); index += 1) {
        const id = list[index];
        if (id !== undefined) {
          victims.push(id);
        }
      }
    }
    db.transaction(() => {
      const softDelete = db.prepare(
        'UPDATE memories SET deleted = 1, deleted_at = @at WHERE id = @id',
      );
      const dropCode = db.prepare('DELETE FROM vector_codes WHERE memory_id = ?');
      for (const id of victims) {
        softDelete.run({ at: BENCH_NOW, id });
        dropCode.run(id);
      }
    })();

    const store = new MemoryStore({ dbPath });
    measured = measurePerf(
      db,
      store,
      { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE },
      SMOKE_QUERIES,
      SMOKE_WRITES,
    );
    db.close();
  });

  /** 取测量结果（`beforeAll` 没跑成功 ⇒ 直接抛 ⇒ 不会静默跳过断言）。 */
  function measuredResult(): PerfResult {
    if (measured === null) {
      throw new Error('measurePerf 的结果缺失 ⇒ beforeAll 未跑成功');
    }
    return measured;
  }

  it('★ 读路径（`vectorRouteByteReads`）：`pruneRate` 逐位等于「调用次数」口径', () => {
    assertPruneRateUsesCallsBasis('读路径', measuredResult().vectorRouteByteReads);
  });

  it('★ 写路径（`writeSegments.vectorByteReads`）：`pruneRate` 逐位等于「调用次数」口径', () => {
    assertPruneRateUsesCallsBasis('写路径', measuredResult().writeSegments.vectorByteReads);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §C · 负控：证明上面的断言**不是恒绿守卫**
// ═══════════════════════════════════════════════════════════════════════════

describe('§C · 负控：断言的鉴别力（纯函数 · 喂两组不同数据）', () => {
  it('★ 「一个样本不等、其它相等」⇒ 只钉 `max` 会漏 ⇒ 必须钉整个分布', () => {
    // ⚠️ 三个样本里**只有第 3 个**在两个口径下不同（⇒ 总量会变，但 `max`/`p50`/`p99` 不变）。
    const samples: PruneRateSample[] = [
      { calls: 50, rows: 50, universe: 100 },
      { calls: 25, rows: 25, universe: 100 },
      { calls: 25, rows: 5, universe: 100 },
    ];
    const byCalls = pruneRateDistribution(samples, 'calls');
    const byRows = pruneRateDistribution(samples, 'rows');

    // ⚠️ ★ **`max` / `p50` / `p99` 恰好相同** ⇒ 只断言 `max` 的守卫**抓不住**换分子。
    expect(byCalls.max).toBe(byRows.max);
    expect(byCalls.p50).toBe(byRows.p50);
    expect(byCalls.p99).toBe(byRows.p99);
    // ⚠️ ★ **`min` / `mean` 不同** ⇒ 断言覆盖 `min`/`mean` 才有鉴别力（§B 就是这么钉的）。
    expect(byCalls.min).not.toBe(byRows.min);
    expect(byCalls.mean).not.toBe(byRows.mean);
  });

  it('★ 没有白调用时两个口径**完全相同** ⇒ 这正是「43 条断言抓不住」的根因', () => {
    // ⚠️ **健康场景**：每次 `scoreOf` 都返回了行 ⇒ 调用次数 == 返回行数。
    const healthy: PruneRateSample[] = [
      { calls: 50, rows: 50, universe: 100 },
      { calls: 25, rows: 25, universe: 100 },
      { calls: 25, rows: 25, universe: 100 },
    ];
    // ⇒ ⇒ **换分子不改变任何落盘数值** ⇒ ⇒ 43 条断言全绿 ⇒ ⇒ **守卫没有牙**。
    expect(pruneRateDistribution(healthy, 'calls')).toEqual(pruneRateDistribution(healthy, 'rows'));
    // ⇒ ⇒ 本文件的白调用夹具（§B）就是**唯一的解药**。
    const withWhiteCall: PruneRateSample[] = [
      { calls: 50, rows: 50, universe: 100 },
      { calls: 25, rows: 25, universe: 100 },
      { calls: 25, rows: 5, universe: 100 },
    ];
    expect(pruneRateDistribution(withWhiteCall, 'calls')).not.toEqual(
      pruneRateDistribution(withWhiteCall, 'rows'),
    );
  });
});
