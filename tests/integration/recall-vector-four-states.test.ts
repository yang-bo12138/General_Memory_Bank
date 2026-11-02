/**
 * ★ **D5 的四种处境 × 五个标志，逐格断言** —— 阶段 5 · T03。
 *
 * 设计 §2 D5 的那张表有 4 行 × 5 列。本文件**一格一条断言**，并且：
 * · **A 行（不传 `queryEmbedding`）单独一组**：它承担 D2 的整个「零影响」论证，
 *   不是四种处境里的一档 —— 其余三行（B/C/D）**无论怎么错都不该影响它**；
 * · **B 行与 C 行必须能被区分**（D5 的 ⚠️ 第三条）：两者在 `cos` 上**都表现为 `null`**，
 *   唯一的分辨手段是 `routes.vector.ran`（call 级）+ `fromVector`（per-hit）⇒ 本文件把这两个量
 *   放在同一组断言里对照，证明它们真的能分开（而不是「两个都是 null 就算通过」）。
 *
 * 另外本文件承担两条**最容易静默坏掉**的性质：
 * · **闸门顺序不可换**（D3 ⑥ 的三道：cos → 强度 → 截断）；
 * · **时间窗没有被绕过**（铁律①：「不许用相似度废掉遗忘曲线」）。
 *   后者带**正控**（`includeArchived: true` 时那条旧记忆必须回来）——
 *   否则「它没出现」可能只是因为「它压根没有向量」。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { resolveVectorBackendState } from '../../src/core/flags.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCORE_WEIGHTS, coarseGateWindow } from '../../src/core/scoring.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { type Hit, type RecallStore, recall } from '../../src/store/recall.js';
import { resolveVectorBackendMode } from '../../src/store/stats.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { type RecallVectorPort, resolveRecallVectorPort } from '../../src/store/vectorPort.js';
import { assignBucket } from '../../src/vector/bucketAssign.js';
import { IvfVectorBackend, trainCentroids } from '../../src/vector/ivf.js';
import {
  QA_DAY,
  QA_DIM,
  QA_NOW,
  QA_PARAMS,
  type QaSeedRow,
  qaAxisVector,
  qaCreateWorld,
  qaEmbeddingBytes,
  qaNumbers,
  qaReadVectorUsed,
  qaVectorAtCos,
} from '../fixtures/qaVectorWorld.js';
import { createTestDb, insertMemories } from '../fixtures/vector.js';

/** 「文本路会命中」的上下文（> 3 个 bigram ⇒ `buildMatchQuery` 走 `OR`）。 */
const TEXT_CONTEXT = '王五住在哪个城市';

/** 与 `TEXT_CONTEXT` **汉字集不相交**的正文（⇒ 文本路永不命中它）。 */
const BLIND_CONTENT = '喵咪咪鱼儿朵拉';

/** 文本路能命中的正文。 */
const HIT_CONTENT = '王五住在成都';

/** 空中心模型（`route()` 对它返回空数组 ⇒ D5 的 B 行第二支）。 */
const EMPTY_MODEL = { coarse: [], fine: [] } as const;

/** 建一个显式 flat 的端口（`QA_PARAMS` 的 `VECTOR_ROUTER='flat'` ⇒ 端口一定存在）。 */
function flatPortOf(db: Database.Database, params: Params): RecallVectorPort {
  const port = resolveRecallVectorPort(db, params, {
    centroids: () => ({ coarse: [], fine: [] }),
    embeddedAtLeastThreshold: () => false,
    markEmbeddedAtLeastThreshold: () => undefined,
  });
  if (port === null) {
    throw new Error('夹具异常：显式 flat 的端口不该是 null');
  }
  return port;
}

/** 建一个「分桶未训练」的 ivf 端口（`route()` 返回空 ⇒ `ran=false`）。 */
function untrainedIvfPortOf(db: Database.Database): RecallVectorPort {
  const backend = new IvfVectorBackend({
    db,
    centroids: () => EMPTY_MODEL,
    nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    nprobeFine: DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
  });
  backend.init({
    dimensions: QA_DIM,
    coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
    fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
  });
  return { backend, mode: 'ivf' };
}

/** 一次调用的可观测产物（**五个标志全部在这里**）。 */
interface Outcome {
  db: Database.Database;
  hits: Hit[];
  /** `explain.routes.vector`（**call 级**）。 */
  vectorRoute: { ran: boolean; candidates: number };
  /** 事件的 `vectorUsed`（= `routes.vector.ran` 的同一个事实）。 */
  vectorUsed: boolean[];
}

/**
 * 跑一行处境。
 *
 * @param rows 世界里的记忆
 * @param options 本次调用的选项（`queryEmbedding` 传 `undefined` = A 行）
 */
function runOutcome(
  rows: readonly QaSeedRow[],
  options: {
    params?: Params;
    queryEmbedding?: number[];
    port?: (db: Database.Database, params: Params) => RecallVectorPort | undefined;
    includeArchived?: boolean;
  } = {},
): Outcome {
  const params = options.params ?? QA_PARAMS;
  const world = qaCreateWorld(params, rows);

  const port = options.port === undefined ? undefined : options.port(world.db, params);
  const store: RecallStore =
    port === undefined ? world.context : { ...world.context, vector: port };

  const result = recall(store, {
    context: TEXT_CONTEXT,
    now: QA_NOW,
    explain: true,
    ...(options.includeArchived === true ? { includeArchived: true } : {}),
    ...(options.queryEmbedding === undefined ? {} : { queryEmbedding: options.queryEmbedding }),
  });

  const explain = result.explain;
  if (explain === undefined) {
    throw new Error('夹具异常：explain: true 必须带回 explain');
  }
  return {
    db: world.db,
    hits: result.hits,
    vectorRoute: explain.routes.vector,
    vectorUsed: qaReadVectorUsed(world.db),
  };
}

/** 五个标志的紧凑投影（逐格断言的载体）。 */
function cellsOf(outcome: Outcome): {
  ran: boolean;
  candidates: number;
  vectorUsed: boolean;
  fromVector: boolean[];
  cos: Array<number | null>;
} {
  return {
    ran: outcome.vectorRoute.ran,
    candidates: outcome.vectorRoute.candidates,
    vectorUsed: outcome.vectorUsed.length === 0 ? false : outcome.vectorUsed[0] === true,
    fromVector: outcome.hits.map((hit) => hit.fromVector),
    cos: outcome.hits.map((hit) => hit.breakdown?.cos ?? null),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、A 行：不传 `queryEmbedding`（**单独一组** —— 它是「零影响」的前提）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D5 的 A 行（**零影响的前提**，不是四档之一）· 不传 `queryEmbedding` ⇒ 五个标志全是缺项值', () => {
  it('★ 即便端口**已装配**且库里有高相似度向量，五个标志仍是 `false/false/0/false/null`', () => {
    const outcome = runOutcome(
      [
        // ⚠️ 这两条的向量与「如果向量路跑起来会用的那条查询向量」高度相似（cos 0.97）
        //   ⇒ 本行**不是**因为「没有可比向量」才恒 false 的（这是判别力的关键）。
        { id: 'm-a', content: HIT_CONTENT, vector: qaVectorAtCos(0.97) },
        { id: 'm-b', content: BLIND_CONTENT, vector: qaAxisVector(0) },
      ],
      { port: flatPortOf },
    );

    // ── 前置：真的召回到了东西（否则下面「全 false」是空集上的真命题）──
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits.some((hit) => hit.fromText)).toBe(true);

    expect(cellsOf(outcome)).toEqual({
      ran: false, // ← 这一路**没跑**（不是「跑了没命中」）
      candidates: 0,
      vectorUsed: false,
      fromVector: outcome.hits.map(() => false),
      cos: outcome.hits.map(() => null),
    });

    // ── 逐条再断言一次 `vectorPart === 0`（`vectorSim` 缺项记 0，不是减分）──
    for (const hit of outcome.hits) {
      expect(hit.breakdown?.vectorPart).toBe(0);
      // ── 负控：它不是「一个非常小的小数」，也不是满分 0.25 ──
      expect(hit.breakdown?.vectorPart).not.toBe(SCORE_WEIGHTS.vectorSim);
    }

    outcome.db.close();
  });

  it('★ A 行**与端口在不在无关**：端口缺席时五个标志**逐字段相同**（`vectorUsed` 仍是 false）', () => {
    const rows: QaSeedRow[] = [
      { id: 'm-a', content: HIT_CONTENT, vector: qaVectorAtCos(0.97) },
      { id: 'm-b', content: BLIND_CONTENT, vector: qaAxisVector(0) },
    ];
    const withPort = runOutcome(rows, { port: flatPortOf });
    const withoutPort = runOutcome(rows, {});

    expect(cellsOf(withPort)).toEqual(cellsOf(withoutPort));
    expect(withPort.vectorUsed).toEqual(withoutPort.vectorUsed);

    withPort.db.close();
    withoutPort.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、B 行：传了，但向量路**整路缺席**（两支：`mode='absent'` / `route()` 空）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D5 的 B 行 · 传了但整路缺席 ⇒ `ran=false`（且输出与不传**逐字段相同**）', () => {
  it('★ B 支一：`mode === "absent"`（过门槛、分桶未训练）⇒ 端口是 `null`，`ran=false`', () => {
    // ⚠️ 把建桶门槛压到 1（`ROUTER_MIN_TRAINING`）：本夹具只有 3 条记忆
    //   ⇒ 「过门槛」在**判定层**成立，而 `vector_fine_cells` 为空 ⇒ 四态判定给 `absent`。
    const params: Params = {
      ...QA_PARAMS,
      VECTOR_ROUTER: 'auto',
      ROUTER_MIN_TRAINING: 1,
    };
    const world = qaCreateWorld(params, [
      { id: 'm-a', content: HIT_CONTENT, vector: qaVectorAtCos(0.97) },
      { id: 'm-b', content: BLIND_CONTENT, vector: qaAxisVector(0) },
    ]);

    // ── 前置：四态判定确实是 `absent`，且装配点确实返回 `null` ──
    expect(resolveVectorBackendMode(world.db, params, { embeddedAtLeastThreshold: true })).toBe(
      'absent',
    );
    expect(
      resolveRecallVectorPort(world.db, params, {
        centroids: () => EMPTY_MODEL,
        embeddedAtLeastThreshold: () => true,
        markEmbeddedAtLeastThreshold: () => undefined,
      }),
    ).toBeNull();

    const result = recall(world.context, {
      context: TEXT_CONTEXT,
      now: QA_NOW,
      explain: true,
      queryEmbedding: qaNumbers(qaAxisVector(0)),
    });

    // ── B 行的五个标志：全部是缺项值 ──
    expect(result.explain?.routes.vector).toEqual({ ran: false, candidates: 0 });
    expect(qaReadVectorUsed(world.db)).toEqual([false]);
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.fromVector).toBe(false);
      expect(hit.breakdown?.cos).toBeNull();
    }

    world.db.close();
  });

  it('★ B 支二：端口存在但 `route()` 返回空桶集 ⇒ `ran=false`（**不是**「跑了但没命中」）', () => {
    const outcome = runOutcome(
      [
        { id: 'm-a', content: HIT_CONTENT, vector: qaVectorAtCos(0.97) },
        { id: 'm-b', content: BLIND_CONTENT, vector: qaAxisVector(0) },
      ],
      // ⚠️ 端口**在**（`mode='ivf'`），但中心模型为空 ⇒ `route()` 空 ⇒ 整路缺席
      { port: (db) => untrainedIvfPortOf(db), queryEmbedding: qaNumbers(qaAxisVector(0)) },
    );

    expect(cellsOf(outcome)).toEqual({
      ran: false,
      candidates: 0,
      vectorUsed: false,
      fromVector: outcome.hits.map(() => false),
      cos: outcome.hits.map(() => null),
    });

    outcome.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、C 行：传了、跑了，但**一条都没进候选**（全部 `cos < VECTOR_MIN_COS`）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D5 的 C 行 · 跑了但一条没进候选 ⇒ `ran=true` 且 `candidates=0`（与 B 行**必须能区分**）', () => {
  it('★ 查询向量与库内向量正交（cos 0 < `VECTOR_MIN_COS`）⇒ `ran=true` / `candidates=0` / `vectorUsed=true`', () => {
    const outcome = runOutcome(
      [
        // 向量都在第 0 轴附近，而查询用第 400 轴 ⇒ 全部 cos ≈ 0
        { id: 'm-a', content: HIT_CONTENT, vector: qaAxisVector(0) },
        { id: 'm-b', content: BLIND_CONTENT, vector: qaVectorAtCos(0.99) },
      ],
      { port: flatPortOf, queryEmbedding: qaNumbers(qaAxisVector(400)) },
    );

    expect(cellsOf(outcome)).toEqual({
      ran: true, // ← 与 B 行的**唯一**区别之一
      candidates: 0, // ← 走了、但没有候选过得了闸
      vectorUsed: true, // ← 与 B 行的**另一个**区别（事件里也必须是 true）
      fromVector: outcome.hits.map(() => false),
      cos: outcome.hits.map(() => null),
    });

    // ⚠️ 文本路照常命中 ⇒ `ran=false` 不代表「三路都没跑」
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits.some((hit) => hit.fromText)).toBe(true);

    outcome.db.close();
  });

  it('★ B 行 vs C 行**可区分**：`cos` 与 `fromVector` 在两者上完全一样，唯一的分辨手段是 `ran`', () => {
    const rows: QaSeedRow[] = [
      { id: 'm-a', content: HIT_CONTENT, vector: qaAxisVector(0) },
      { id: 'm-b', content: BLIND_CONTENT, vector: qaVectorAtCos(0.99) },
    ];
    const rowB = runOutcome(rows, {
      port: (db) => untrainedIvfPortOf(db),
      queryEmbedding: qaNumbers(qaAxisVector(400)),
    });
    const rowC = runOutcome(rows, {
      port: flatPortOf,
      queryEmbedding: qaNumbers(qaAxisVector(400)),
    });

    const b = cellsOf(rowB);
    const c = cellsOf(rowC);

    // ── 这两个量在两行上一模一样（⇒ 用它们**判定不了**缺项，D5 的 ⚠️）──
    expect(b.cos).toEqual(c.cos);
    expect(b.fromVector).toEqual(c.fromVector);
    expect(b.candidates).toBe(c.candidates);
    // ── 只有 `ran` / `vectorUsed` 把它们分开了 ──
    expect(b.ran).toBe(false);
    expect(c.ran).toBe(true);
    expect(rowB.vectorUsed).toEqual([false]);
    expect(rowC.vectorUsed).toEqual([true]);

    rowB.db.close();
    rowC.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、D 行：命中 N > 0 ⇒ 命中那几条 `fromVector=true` 且 `cos` = 余弦
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D5 的 D 行 · 命中 N 条 ⇒ `candidates === N`，命中者 `fromVector`/`cos` 逐条正确', () => {
  it('★ 逐条断言：纯文本命中 / 三路（文本+向量）命中 / 纯向量命中 各自的两个标志', () => {
    const outcome = runOutcome(
      [
        // ① 纯文本命中：正文命中，但向量与查询正交（cos 0 < MIN）
        { id: 'm-text', content: HIT_CONTENT, vector: qaAxisVector(400) },
        // ② 三路（本夹具只有两路：文本 + 向量）都命中
        { id: 'm-both', content: HIT_CONTENT, vector: qaVectorAtCos(0.6) },
        // ③ 纯向量命中：正文与上下文汉字集不相交
        { id: 'm-vec', content: BLIND_CONTENT, vector: qaVectorAtCos(0.9) },
      ],
      { port: flatPortOf, queryEmbedding: qaNumbers(qaAxisVector(0)) },
    );

    // ── call 级：跑了，且过了闸的候选恰好两条（0.9 / 0.6；正交那条不进候选）──
    expect(outcome.vectorRoute).toEqual({ ran: true, candidates: 2 });
    expect(outcome.vectorUsed).toEqual([true]);

    const byId = new Map(outcome.hits.map((hit) => [hit.id, hit]));

    // ── per-hit 逐格 ──
    const text = byId.get('m-text');
    expect(text, '纯文本命中必须出现').toBeDefined();
    expect(text?.fromText).toBe(true);
    expect(text?.fromVector).toBe(false);
    expect(text?.breakdown?.cos).toBeNull();

    const both = byId.get('m-both');
    expect(both, '两路都命中必须有且只有一条').toBeDefined();
    expect(both?.fromText).toBe(true);
    expect(both?.fromVector).toBe(true);
    expect(both?.breakdown?.cos).toBe(Math.fround(0.6));
    // ── 加权分项：`vectorPart === 0.25 × cos`（缺项记 0 的规则在命中时不适用）──
    expect(both?.breakdown?.vectorPart).toBe(SCORE_WEIGHTS.vectorSim * Math.fround(0.6));

    const vectorOnly = byId.get('m-vec');
    expect(vectorOnly, '纯向量命中必须出现（否则「向量路真的产出」就没被证明）').toBeDefined();
    expect(vectorOnly?.fromText).toBe(false);
    expect(vectorOnly?.fromVector).toBe(true);
    expect(vectorOnly?.breakdown?.cos).toBe(Math.fround(0.9));

    // ── 五柱之和 == score（D 行的打分一致性）──
    for (const hit of outcome.hits) {
      const breakdown = hit.breakdown;
      expect(breakdown).toBeDefined();
      if (breakdown === undefined) {
        continue;
      }
      const sum =
        breakdown.intensityPart +
        breakdown.vectorPart +
        breakdown.textPart +
        breakdown.graphPart +
        breakdown.recencyPart;
      expect(Math.abs(sum - hit.score)).toBeLessThanOrEqual(1e-9);
    }

    outcome.db.close();
  });

  it('★ 三个标志的**层级不同**：`ran`（call 级）为 true 时，仍可以有 hit 的 `fromVector` 为 false', () => {
    const outcome = runOutcome(
      [
        { id: 'm-text', content: HIT_CONTENT, vector: qaAxisVector(400) },
        { id: 'm-vec', content: BLIND_CONTENT, vector: qaVectorAtCos(0.9) },
      ],
      { port: flatPortOf, queryEmbedding: qaNumbers(qaAxisVector(0)) },
    );

    expect(outcome.vectorRoute.ran).toBe(true);
    const text = outcome.hits.find((hit) => hit.id === 'm-text');
    expect(text?.fromVector).toBe(false);
    // ⚠️ 这正是 D5 那句「`fromVector` 与 `ran` 分属两个层级」的可观测形式：
    //   把两者当成同一件事的实现在这里必红（它会让 ran=true ⇒ 所有 hit 都 fromVector=true）。
    expect(outcome.hits.some((hit) => hit.fromVector)).toBe(true);
    expect(outcome.hits.some((hit) => !hit.fromVector)).toBe(true);

    outcome.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、闸门顺序不可换（D3 ⑥：cos → 强度 → 截断）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D3 ⑥ · 三道闸门的顺序**不可换**（先截断再精筛会挤掉本该保留的次优项）', () => {
  it('★ 25 条 cos 更高但**已归档** + 1 条 cos 次高但活着 ⇒ 留下的必须是后者', () => {
    const gate = coarseGateWindow(QA_PARAMS, QA_NOW, false);
    expect(gate.enabled).toBe(true);

    // ⚠️ 这 25 条要满足两个条件（缺一条这条测试就变成空测试）：
    //   ① `last_access` **在时间窗之内**（否则它们被 `search()` 的 filter 挡掉，
    //      「先截断再精筛」就不会产生任何差异 ⇒ 测不到顺序）；
    //   ② `intensity <= ARCHIVE_LINE`（否则它们本来就该留下）。
    //   `stability=100` 天、`last_access = 窗内第 1 天` ⇒ intensity ≈ exp(-538/100) ≈ 0.0046 ≪ 0.05。
    const archivedAt = gate.coarseCutoff + QA_DAY;
    const rows: QaSeedRow[] = [];
    for (let index = 0; index < 25; index += 1) {
      rows.push({
        id: `m-arch-${String(index).padStart(2, '0')}`,
        content: BLIND_CONTENT,
        // cos 从 0.99 递减 ⇒ 全部**高于**下面那条活着的 0.5
        vector: qaVectorAtCos(0.99 - index * 0.001),
        stability: 100,
        lastAccess: archivedAt,
      });
    }
    rows.push({
      id: 'm-alive',
      content: BLIND_CONTENT,
      vector: qaVectorAtCos(0.5),
      stability: 100,
      lastAccess: QA_NOW - 3_600_000,
    });

    const outcome = runOutcome(rows, {
      port: flatPortOf,
      queryEmbedding: qaNumbers(qaAxisVector(0)),
    });

    // ── 正确顺序下：25 条归档全被强度精筛剔掉，剩下 1 条活着的 ──
    expect(outcome.vectorRoute).toEqual({ ran: true, candidates: 1 });
    expect(outcome.hits.map((hit) => hit.id)).toEqual(['m-alive']);
    expect(outcome.hits[0]?.breakdown?.cos).toBe(Math.fround(0.5));

    // ── 反证：若实现改成「先 slice(0, TOPK) 再精筛」⇒ 取到的是 20 条归档 ⇒ 精筛后一条不剩 ──
    //   ⇒ `candidates` 会变 0、`hits` 会空 ⇒ 上两条断言必红。
    //   （这条反证由 QA 手工变异验证过，见报告；不写进断言，因为那需要改产品代码。）
    expect(outcome.vectorRoute.candidates).toBeLessThan(20);

    outcome.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、时间窗没有被绕过（**铁律①的具体化**：不许用相似度废掉遗忘曲线）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 铁律① · 时间窗外的记忆不因**语义极近**被拉回（含正控）', () => {
  /**
   * ★ **为什么这条测试必须造 65 条旧记忆（> `VECTOR_TOPK × VECTOR_OVERFETCH_FACTOR` = 60）**：
   *
   * ⚠️ **本测试的第一版没有判别力**（QA 用「把 filter 传成 `{}`」的变异发现的）：
   *   只放 1 条旧 + 1 条新时，把时间窗整段去掉，结果**一模一样** —— 因为
   *   「时间窗外」与「`intensity <= ARCHIVE_LINE`」在这套参数下**是同一个边界**
   *   （`coarseGateWindow()` 的窗口宽度就是 `MAX_STABILITY × ln(1/ARCHIVE_LINE)`）
   *   ⇒ 即使后端不过时间窗，那条旧记忆也会被 ⑥② 的强度精筛剔掉 ⇒ 断言仍然成立。
   *
   * ⇒ 唯一能让时间窗**单独**可观测的形状是「**过取（over-fetch）被旧记忆塞满**」：
   *   让 65 条旧记忆的 cos **全部高于**唯一那条新记忆（新的是 0.5，旧的是 0.99 递减到 0.925）。
   *   · **时间窗生效**（正确实现）⇒ `search()` 只回那条新的 ⇒ `candidates = 1`；
   *   · **时间窗被绕过**（变异）⇒ `search()` 返回 cos 最高的 60 条 = 全是旧的
   *     ⇒ 它们随后被强度精筛全部剔掉 ⇒ `candidates = 0`，那条新记忆**根本进不了视野**。
   *   ⇒ 这两种结果的差别是 1 vs 0，**不是**「一个数字差一点」。
   */
  const OLD_COUNT = 65;

  it('★ 65 条 cos 更高的旧记忆 + 1 条 cos 0.5 的新记忆 ⇒ 只留下新那条（正控：`includeArchived` 时旧的回得来）', () => {
    const gate = coarseGateWindow(QA_PARAMS, QA_NOW, false);
    expect(gate.enabled).toBe(true);
    const outside = gate.coarseCutoff - QA_DAY;

    const rows: QaSeedRow[] = [];
    for (let index = 0; index < OLD_COUNT; index += 1) {
      rows.push({
        id: `m-old-${String(index).padStart(2, '0')}`,
        content: BLIND_CONTENT,
        // 0.99 递减 ⇒ 每一条都比下面那条新的（0.5）更像
        vector: qaVectorAtCos(0.99 - index * 0.001),
        stability: 100,
        lastAccess: outside,
      });
    }
    rows.push({
      id: 'm-fresh',
      content: BLIND_CONTENT,
      vector: qaVectorAtCos(0.5),
      stability: 100,
      lastAccess: QA_NOW - 3_600_000,
    });

    const normal = runOutcome(rows, {
      port: flatPortOf,
      queryEmbedding: qaNumbers(qaAxisVector(0)),
    });

    // ── 前置：那条最像的旧记忆**真的在库里、真的有向量**（否则「没出现」是空洞的）──
    expect(qaEmbeddingBytes(normal.db, 'm-old-00')).toBe(QA_DIM * 4);
    expect(qaEmbeddingBytes(normal.db, 'm-fresh')).toBe(QA_DIM * 4);

    // ── 向量路跑了 ⇒ 「没出现」不是因为整路缺席 ──
    expect(normal.vectorRoute.ran).toBe(true);
    // ★ 铁律①：语义最像的那 65 条**一条都没有**被拉回
    expect(normal.vectorRoute.candidates).toBe(1);
    expect(normal.hits.map((hit) => hit.id)).toEqual(['m-fresh']);

    // ── 正控：`includeArchived: true` ⇒ 粗筛整体取消 ⇒ 旧的那批**必须**回来 ──
    //   ⚠️ 没有这条正控，上一条无法排除「它们本来就没有向量 / 后端不认识它们」这类假绿。
    const archived = runOutcome(rows, {
      port: flatPortOf,
      queryEmbedding: qaNumbers(qaAxisVector(0)),
      includeArchived: true,
    });
    expect(archived.vectorRoute.candidates).toBe(DEFAULT_PARAMS.VECTOR_TOPK);
    // 最像的那条（cos 0.99）必须出现，且它的 cos 就是 0.99
    const most = archived.hits.find((hit) => hit.id === 'm-old-00');
    expect(most, '`includeArchived` 下最像的旧记忆必须回来').toBeDefined();
    expect(most?.fromVector).toBe(true);
    expect(most?.breakdown?.cos).toBe(Math.fround(0.99));

    normal.db.close();
    archived.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、D8：`inhibitionTrace` 与 `recall` 的分数一致性（三条成对）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D8 · `inhibitionTrace` 与 `recall` 的 `baseScore` 一致性（含**负控**）', () => {
  /** 建一个真门面（真临时库 + `write()`）：D8 要验的是**门面装配 + 同一段打分代码**。 */
  function facade(): { store: MemoryStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'qa-vec-d8-'));
    const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), params: QA_PARAMS });
    return { store, dir };
  }

  /** 落三条与查询语义高度相关的记忆（cos 0.95 / 0.8 / 0.6）。 */
  function seed(store: MemoryStore): void {
    for (const [content, cos] of [
      [HIT_CONTENT, 0.95],
      ['王五住在重庆', 0.8],
      ['王五住在昆明', 0.6],
    ] as const) {
      store.write({ content, embedding: qaNumbers(qaVectorAtCos(cos)), now: QA_NOW });
    }
  }

  /** `recall` 的 id → score；`inhibitionTrace` 的 id → baseScore。 */
  function pairsOf(
    store: MemoryStore,
    queryEmbedding?: number[],
  ): { hit: Map<string, number>; base: Map<string, number> } {
    const hits = store.recall({
      context: TEXT_CONTEXT,
      now: QA_NOW,
      ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
    });
    const trace = store.inhibitionTrace(TEXT_CONTEXT, {
      now: QA_NOW,
      ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
    });
    return {
      hit: new Map(hits.hits.map((hit) => [hit.id, hit.score])),
      base: new Map(trace.candidates.map((candidate) => [candidate.id, candidate.baseScore])),
    };
  }

  it('① 两边都不传 ⇒ `baseScore` 与 `Hit.score` **逐位相等**', () => {
    const { store, dir } = facade();
    try {
      seed(store);
      const { hit, base } = pairsOf(store);
      expect(base.size).toBeGreaterThan(0);
      for (const [id, score] of hit) {
        expect(base.get(id), `id=${id}`).toBe(score);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('② 两边传**同一条**向量 ⇒ 仍逐位相等（且分数确实比①高，否则「传了没生效」）', () => {
    const { store, dir } = facade();
    try {
      seed(store);
      const plain = pairsOf(store);
      const both = pairsOf(store, qaNumbers(qaAxisVector(0)));

      expect(both.base.size).toBeGreaterThan(0);
      for (const [id, score] of both.hit) {
        expect(both.base.get(id), `id=${id}`).toBe(score);
      }

      // ── 前置：这一组确实「向量路生效了」（否则①②会因为同一个空洞原因而相等）──
      const changed = [...both.hit].filter(([id, score]) => plain.hit.get(id) !== score);
      expect(changed.length).toBeGreaterThan(0);
      for (const [id, score] of changed) {
        expect(score).toBeGreaterThan(plain.hit.get(id) as number);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('③ **负控**：只有 recall 传 ⇒ 允许不等，且差额 ∈ (0, `SCORE_WEIGHTS.vectorSim`]', () => {
    const { store, dir } = facade();
    try {
      seed(store);
      // recall 传，trace 不传
      const hits = store.recall({
        context: TEXT_CONTEXT,
        now: QA_NOW,
        queryEmbedding: qaNumbers(qaAxisVector(0)),
      });
      const trace = store.inhibitionTrace(TEXT_CONTEXT, { now: QA_NOW });
      const base = new Map(
        trace.candidates.map((candidate) => [candidate.id, candidate.baseScore]),
      );

      const deltas = hits.hits.map((hit) => hit.score - (base.get(hit.id) as number));
      expect(deltas.length).toBeGreaterThan(0);

      // ── 差额必须 **严格大于 0**（= 向量路真的加了分）且 **不超过 0.25**（= 恰是那一个分项）──
      for (const delta of deltas) {
        expect(delta).toBeGreaterThan(0);
        expect(delta).toBeLessThanOrEqual(SCORE_WEIGHTS.vectorSim + 1e-12);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 八、主理人「拍」的两处偏离：验它没有副作用
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 偏离① · 端口「只在传了 `queryEmbedding` 时才装配」是否会造成静默不走向量路', () => {
  it('★ 只要四态判定不是 `absent`，装配点**必返回端口** ⇒ 「传了向量却没端口」只可能发生在 `absent`（B 行，可由 `stats().mode` 观测）', () => {
    // 造一个**真的有细桶**的库（`mode` 才会是 `ivf`）：2 条向量 + 训练 2 粗 / 4 细。
    const db = createTestDb();
    const vectors = [qaAxisVector(0), qaVectorAtCos(0.5)];
    const ids = insertMemories(db, vectors, { lastAccess: QA_NOW });
    const { model } = trainCentroids(db, {
      coarseCenters: 2,
      fineCenters: 4,
      nprobeCoarse: 2,
      now: QA_NOW,
    });
    runWriteTransaction(db, () => {
      for (let index = 0; index < ids.length; index += 1) {
        assignBucket({ db, centroids: () => model, nprobeCoarse: 2 }, ids[index]!, vectors[index]!);
      }
    });

    const params: Params = {
      ...QA_PARAMS,
      VECTOR_ROUTER: 'auto',
      ROUTER_MIN_TRAINING: 1,
      ROUTER_COARSE_CENTERS: 2,
      ROUTER_FINE_CENTERS: 4,
    };
    expect(resolveVectorBackendMode(db, params, { embeddedAtLeastThreshold: true })).toBe('ivf');

    const port = resolveRecallVectorPort(db, params, {
      centroids: () => model,
      embeddedAtLeastThreshold: () => true,
      markEmbeddedAtLeastThreshold: () => undefined,
    });
    expect(port, '`ivf` ⇒ 装配点必须给出端口').not.toBeNull();
    expect(port?.mode).toBe('ivf');

    // ── 端到端：这条端口真的能用（`route()` 非空 ⇒ `ran` 会是 true）──
    if (port !== null) {
      const fineIds = port.backend.route(qaAxisVector(0), 2, 4);
      expect(fineIds.length).toBeGreaterThan(0);
      const hits = port.backend.search(qaAxisVector(0), DEFAULT_PARAMS.VECTOR_TOPK);
      expect(hits.length).toBe(2);
      expect(hits[0]?.id).toBe(ids[0]);
    }

    db.close();
  });
});

describe('T03 · 偏离② · 「显式 `ivf` + 低于门槛」的两套词（`flags` 给 `ivf`、`stats` 给 `flat_auto`）', () => {
  it('★ 这个组合下 `recall` 传向量**不崩、结果正确**（走 flat 精确扫描），只是与 host 的显式请求不一致', () => {
    // 库只有 2 条向量、**没有**细桶 ⇒ 若真的按 `ivf` 走，`route()` 会返回空 ⇒ `ran=false`。
    const world = qaCreateWorld({ ...QA_PARAMS, VECTOR_ROUTER: 'ivf' }, [
      { id: 'm-a', content: HIT_CONTENT, vector: qaVectorAtCos(0.95) },
      { id: 'm-b', content: BLIND_CONTENT, vector: qaVectorAtCos(0.6) },
    ]);
    const params: Params = { ...QA_PARAMS, VECTOR_ROUTER: 'ivf' };

    // ── 两套词先在**判定层**被钉住（这是主理人明知且接受的分歧）──
    const flags = resolveVectorBackendState(params, {
      embeddedCount: 2,
      hasTrainedBuckets: false,
      inRetrain: false,
    });
    const statsMode = resolveVectorBackendMode(world.db, params, {
      embeddedAtLeastThreshold: false,
    });
    expect(flags.mode).toBe('ivf'); // host 显式请求的那个词
    expect(statsMode).toBe('flat_auto'); // 召回实际选后端用的那个词

    // ── 召回侧：不崩，且**真的产出了**（⇒ 它必然走的是 flat；ivf 在空桶下会 `ran=false`）──
    const port = resolveRecallVectorPort(world.db, params, {
      centroids: () => EMPTY_MODEL,
      embeddedAtLeastThreshold: () => false,
      markEmbeddedAtLeastThreshold: () => undefined,
    });
    expect(port?.mode).toBe('flat_auto');

    const result = recall(port === null ? world.context : { ...world.context, vector: port }, {
      context: TEXT_CONTEXT,
      now: QA_NOW,
      explain: true,
      queryEmbedding: qaNumbers(qaAxisVector(0)),
    });
    expect(result.explain?.routes.vector).toEqual({ ran: true, candidates: 2 });
    // ── 结果正确：cos 就是 0.95 / 0.6 两个精确值（flat 是全表精确点积）──
    const cosById = new Map(result.hits.map((hit) => [hit.id, hit.breakdown?.cos]));
    expect(cosById.get('m-a')).toBe(Math.fround(0.95));
    expect(cosById.get('m-b')).toBe(Math.fround(0.6));

    world.db.close();
  });
});
