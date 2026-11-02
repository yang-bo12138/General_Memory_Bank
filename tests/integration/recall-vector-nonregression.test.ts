/**
 * ★ **零影响回归验收**（D2 的第 2 层）+ 三条独立证伪 —— 阶段 5 · T03。
 *
 * 本文件回答四个问题，**每个都用与写手不同的手段**：
 *
 * ① **不传 `queryEmbedding` 的 `recall` 是否与「接线前口径」逐字段相同**：
 *    用**冻结的字面量期望值**（`id` 序列 + `score` + 五柱 + `rawBm25` + `cos` + 三个 `from*`）
 *    与此刻的真实输出比 —— 不是「与另一个实现比」。
 *    配套**判别力负控**：同一个世界**带**向量时，同一批断言**必须变**（否则上一条是空洞的）。
 * ② **「零影响」是不是真空的**：用**只读连接**直接读 `memories` 表，确认向量**真的在库里**；
 *    再把两次 `recall`（不传 / 传）的 `hits` **逐字段 diff**。
 * ③ **「零成本」是否成立**：用 `Database.prototype.prepare` 拦截**数 SQL**，
 *    证明不传向量时「`embedding IS NOT NULL` 全表 COUNT」出现 **0 次**、传了才 ≥1 次
 *    （后者是**正控**：证明计数装置本身看得见那条 SQL，否则「0 次」可能只是装置失灵）。
 * ④ **结果可复现**（RK-2）：同一查询连跑 5 次 `id` 序列逐次相同；
 *    并进一步钉住「遍历顺序取自 `hits`」—— 造 25 条**同分**候选且**落库顺序与 id 序相反**，
 *    断言留下的是**按 id 升序的前 20 条**（若实现按回表 SQL 的返回顺序遍历，留下的会是另外 20 条）。
 *
 * ⚠️ **为什么用两套世界**：
 *   · **手建世界**（固定 id、精确控制 cos / 时间 / 实体）：冻结字面量期望值需要**稳定的 id**，
 *     而 `write()` 生成的 id 是随机 UUID（不可冻结）；
 *   · **门面世界**（真临时库 + `write()`）：只读连接必须开在**文件库**上，
 *     而「门面装配」那一段也只有真门面才走得到。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCORE_WEIGHTS } from '../../src/core/scoring.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { type RecallStore, collectScoredCandidates, recall } from '../../src/store/recall.js';
import { resolveRecallVectorPort } from '../../src/store/vectorPort.js';
import {
  QA_DIM,
  QA_NOW,
  QA_PARAMS,
  type QaSeedRow,
  qaAxisVector,
  qaCreateWorld,
  qaNumbers,
  qaReadVectorUsed,
  qaVectorAtCos,
} from '../fixtures/qaVectorWorld.js';

/** 「文本路会命中」的上下文（> 3 个 bigram ⇒ `match` 走 `OR`）。 */
const TEXT_CONTEXT = '王五住在哪个城市';

/** 与 `TEXT_CONTEXT` **汉字集不相交**的上下文（文本路必然为空）。 */
const BLIND_CONTEXT = '子丑寅卯辰巳午未';

/** 世界里的五条记忆（**id 固定** ⇒ 可以冻结成字面量）。 */
const FROZEN_ROWS: readonly QaSeedRow[] = [
  {
    id: 'm-a',
    content: '王五住在成都老家',
    vector: qaVectorAtCos(0.95),
    entityNames: ['王五', '成都'],
  },
  {
    id: 'm-b',
    content: '王五住在重庆老家',
    vector: qaVectorAtCos(0.6),
    entityNames: ['王五', '重庆'],
  },
  { id: 'm-c', content: '王五爱吃鱼', vector: qaVectorAtCos(0.3), entityNames: ['王五', '鱼'] },
  // ⚠️ 这条是**判别力的关键**：向量与查询极像（cos 0.99），但正文与上下文**没有一个共享 bigram**
  //   ⇒ 它**只能**从向量路进来 ⇒ 「向量路跑没跑」在这里是可观测的（不是靠推理）。
  { id: 'm-d', content: '喵咪咪鱼儿朵拉', vector: qaVectorAtCos(0.99), entityNames: [] },
  // ⚠️ 这条是**图谱路单一来源**的证据：正文不命中、没有向量，只有实体相交。
  { id: 'm-e', content: '喵咪咪鱼儿朵拉二', vector: null, entityNames: ['王五'] },
];

/**
 * ★ **冻结的期望值**（2026-11-03 取自 HEAD `96568eb` 的真实输出，**不是**计划值）。
 *
 * ⚠️ **它冻结的是「行为产物」，不是「代码路径」**：`vectorPart` / `cos` / `fromVector`
 *   是向量路**跑没跑**留下的痕迹 ⇒ 若接线把向量路接到了缺省路径上，这些字面量**必然**对不上。
 * ⚠️ **不要为了让它变绿而改这些数字**。它们若变了，正确动作是
 *   **先弄清「哪一处打分/加权/截断真的变了」**，再决定这是「本次接线的预期结果」还是「回归」。
 *   ⚠️ 唯一允许的例外是 `QA_PARAMS` 里的机制开关被有意改动（那会同时改变多个分项）。
 */
const FROZEN_HITS: ReadonlyArray<{
  id: string;
  score: number;
  intensityPart: number;
  vectorPart: number;
  textPart: number;
  graphPart: number;
  recencyPart: number;
  rawBm25: number | null;
  cos: number | null;
  fromText: boolean;
  fromVector: boolean;
  fromGraph: boolean;
}> = [
  {
    id: 'm-a',
    score: 0.6198422797755632,
    intensityPart: 0.2998750260380501,
    vectorPart: 0,
    textPart: 0.1,
    graphPart: 0.15,
    recencyPart: 0.06996725373751303,
    rawBm25: -0.6392044745840313,
    cos: null,
    fromText: true,
    fromVector: false,
    fromGraph: true,
  },
  {
    id: 'm-b',
    score: 0.6198422797755632,
    intensityPart: 0.2998750260380501,
    vectorPart: 0,
    textPart: 0.1,
    graphPart: 0.15,
    recencyPart: 0.06996725373751303,
    rawBm25: -0.6392044745840313,
    cos: null,
    fromText: true,
    fromVector: false,
    fromGraph: true,
  },
  {
    id: 'm-c',
    score: 0.6134589380649584,
    intensityPart: 0.2998750260380501,
    vectorPart: 0,
    textPart: 0.09361665828939533,
    graphPart: 0.15,
    recencyPart: 0.06996725373751303,
    rawBm25: -0.0000011698113207547171,
    cos: null,
    fromText: true,
    fromVector: false,
    fromGraph: true,
  },
  {
    id: 'm-e',
    score: 0.5198422797755631,
    intensityPart: 0.2998750260380501,
    vectorPart: 0,
    textPart: 0,
    graphPart: 0.15,
    recencyPart: 0.06996725373751303,
    rawBm25: null,
    cos: null,
    fromText: false,
    fromVector: false,
    fromGraph: true,
  },
];

/** 冻结的三路计数（与上面同一时刻的真实输出）。 */
const FROZEN_ROUTES = {
  text: { ran: true, candidates: 3 },
  vector: { ran: false, candidates: 0 },
  graph: { ran: true, candidates: 4 },
} as const;

/**
 * 每次调用都新建一个世界（用例之间不共享状态），并**装配端口**。
 *
 * ⚠️ **必须装端口**：`queryEmbedding` 是开关，但「有开关」还不够 —— 没有端口时
 *   步骤 2c 也不执行（`src/store/recall.ts` 的入口条件是两个都为真）。
 *   本文件的负控要证明「向量路真的会改变结果」，所以端口必须在场。
 */
function worldWithPort(rows: readonly QaSeedRow[]): RecallStore {
  const world = qaCreateWorld(QA_PARAMS, rows);
  const port = resolveRecallVectorPort(world.db, QA_PARAMS, {
    centroids: () => ({ coarse: [], fine: [] }),
    embeddedAtLeastThreshold: () => false,
    markEmbeddedAtLeastThreshold: () => undefined,
  });
  if (port === null) {
    throw new Error('夹具异常：显式 flat 的端口不该是 null');
  }
  return { ...world.context, vector: port };
}

/** 冻结世界（五条固定记忆 + 平面端口）。 */
function freshWorld(): RecallStore {
  return worldWithPort(FROZEN_ROWS);
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、零影响：冻结的字面量期望值
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D2 第 2 层 · 不传 `queryEmbedding` ⇒ 与**冻结的字面量**逐字段相等', () => {
  it('★ `id` 序列 / `score` / 五柱 / `rawBm25` / `cos` / 三个 `from*` 全部符合冻结值', () => {
    const store = freshWorld();
    const result = recall(store, {
      context: TEXT_CONTEXT,
      entityNames: ['王五'],
      now: QA_NOW,
      explain: true,
    });

    // ── ① id 序列（顺序也是断言的一部分：截断到 topN 后顺序会影响调用方）──
    expect(result.hits.map((hit) => hit.id)).toEqual(FROZEN_HITS.map((frozen) => frozen.id));

    // ── ② 逐条逐字段 ──
    for (let index = 0; index < FROZEN_HITS.length; index += 1) {
      const frozen = FROZEN_HITS[index]!;
      const hit = result.hits[index]!;
      const breakdown = hit.breakdown;
      expect(breakdown, `id=${frozen.id} 必须有 breakdown`).toBeDefined();
      if (breakdown === undefined) {
        continue;
      }
      expect(hit.score, `id=${frozen.id} 的 score`).toBe(frozen.score);
      expect(breakdown.intensityPart, `id=${frozen.id} 的 intensityPart`).toBe(
        frozen.intensityPart,
      );
      expect(breakdown.vectorPart, `id=${frozen.id} 的 vectorPart`).toBe(frozen.vectorPart);
      expect(breakdown.textPart, `id=${frozen.id} 的 textPart`).toBe(frozen.textPart);
      expect(breakdown.graphPart, `id=${frozen.id} 的 graphPart`).toBe(frozen.graphPart);
      expect(breakdown.recencyPart, `id=${frozen.id} 的 recencyPart`).toBe(frozen.recencyPart);
      expect(breakdown.rawBm25, `id=${frozen.id} 的 rawBm25`).toBe(frozen.rawBm25);
      expect(breakdown.cos, `id=${frozen.id} 的 cos`).toBe(frozen.cos);
      expect(hit.fromText, `id=${frozen.id} 的 fromText`).toBe(frozen.fromText);
      expect(hit.fromVector, `id=${frozen.id} 的 fromVector`).toBe(frozen.fromVector);
      expect(hit.fromGraph, `id=${frozen.id} 的 fromGraph`).toBe(frozen.fromGraph);
    }

    // ── ③ 三路计数 + 两个诊断数组 ──
    expect(result.explain?.routes).toEqual(FROZEN_ROUTES);
    expect(result.suppressed).toEqual([]);
    expect(result.diffused).toEqual([]);

    // ── ④ 事件里的 `vectorUsed`（= `routes.vector.ran` 的同一个事实）──
    expect(qaReadVectorUsed(store.db)).toEqual([false]);

    store.db.close();
  });

  it('★ 接线前口径的**结构判据**：`score` 恰好等于「另外四柱之和」（= `vectorPart` 真的没参与）', () => {
    const store = freshWorld();
    const result = recall(store, {
      context: TEXT_CONTEXT,
      entityNames: ['王五'],
      now: QA_NOW,
      explain: true,
    });

    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      const breakdown = hit.breakdown!;
      const fourPillars =
        breakdown.intensityPart + breakdown.textPart + breakdown.graphPart + breakdown.recencyPart;
      // ⚠️ 这条比「vectorPart === 0」更强：它同时排除了「加了分但记在别的柱上」这种接错位置。
      expect(Math.abs(fourPillars - hit.score)).toBeLessThanOrEqual(1e-12);
      expect(breakdown.vectorPart).toBe(0);
    }

    // ── `m-d`（cos 0.99 的纯向量记忆）**不该**出现：它没有任何别的来源 ──
    expect(result.hits.some((hit) => hit.id === 'm-d')).toBe(false);

    store.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、判别力负控：同一个世界**带**向量 ⇒ 同一批断言**必须变**
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · D2 第 2 层的负控 · 带 `queryEmbedding` 时同一批断言**必须变**', () => {
  it('★ id 序列变长（`m-d` 进来）、分数变大、`vectorPart` / `cos` / `fromVector` 全部生效', () => {
    const store = freshWorld();
    const result = recall(store, {
      context: TEXT_CONTEXT,
      entityNames: ['王五'],
      now: QA_NOW,
      explain: true,
      queryEmbedding: qaNumbers(qaAxisVector(0)),
    });

    // ── ① id 序列与冻结值**不同**（`m-d` 只能从向量路进来）──
    const ids = result.hits.map((hit) => hit.id);
    expect(ids).not.toEqual(FROZEN_HITS.map((frozen) => frozen.id));
    expect(ids).toContain('m-d');

    // ── ② 同一条记忆的分数**变了**，且方向正确（只加不减）──
    const before = new Map(FROZEN_HITS.map((frozen) => [frozen.id, frozen.score]));
    let changed = 0;
    for (const hit of result.hits) {
      const old = before.get(hit.id);
      if (old === undefined) {
        continue; // `m-d` 是新增的，不存在「变没变」
      }
      // ⚠️ `m-e` **没有向量** ⇒ 它只能从图谱路来 ⇒ 分数**不该**变（这一条也是判别力的一部分：
      //   若它也变了，说明「传了向量」影响了不该被影响的候选）。
      if (hit.breakdown?.cos === null) {
        expect(hit.score, `id=${hit.id} 没有向量 ⇒ 分数不该变`).toBe(old);
        continue;
      }
      expect(hit.score, `id=${hit.id}`).toBeGreaterThan(old);
      changed += 1;
    }
    // 三条带向量的记忆（cos 0.95 / 0.6 / 0.3）都必须加分
    expect(changed).toBe(3);

    // ── ③ 三个标志 + cos 都真的生效（不是「加了分但标志没动」）──
    const nd = result.hits.find((hit) => hit.id === 'm-d');
    expect(nd?.fromVector).toBe(true);
    expect(nd?.breakdown?.cos).toBeCloseTo(0.99, 6);
    // ⚠️ 精度取 6 位：cos 本身是 float32（0.99 → 0.9900000095367432），加权后差值 ~2.4e-9
    expect(nd?.breakdown?.vectorPart).toBeCloseTo(SCORE_WEIGHTS.vectorSim * 0.99, 6);
    expect(result.explain?.routes.vector.ran).toBe(true);
    expect(result.explain?.routes.vector.candidates).toBe(4);

    store.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、零影响不是真空的：只读连接直读 `memories` + 逐字段 diff
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 「零影响」的前提检查 · 用**只读连接**证明向量真的在库里，并逐字段 diff 两次召回', () => {
  /** 一条要从外面核对的特征：正文 → 期望的 cos（与写入时一致）。 */
  const EXPECTED: ReadonlyArray<readonly [string, number]> = [
    ['王五住在成都老家', 0.95],
    ['王五住在重庆老家', 0.6],
    ['王五爱吃鱼', 0.3],
    ['喵咪咪鱼儿朵拉', 0.99],
  ];

  it('★ 只读连接里 `embedding` 的字节数 == `EMBED_DIM × 4`，且 Blob 解出的第 0 分量 == 写入值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-vec-readonly-'));
    const dbPath = join(dir, 'memory.db');
    const store = new MemoryStore({ dbPath, params: QA_PARAMS });
    try {
      for (const [content, cos] of EXPECTED) {
        store.write({ content, embedding: qaNumbers(qaVectorAtCos(cos)), now: QA_NOW });
      }

      // ⚠️ **另开一条只读连接**（不是从门面里掏 `#db`）：这既验证「向量真的落库」，
      //   也保证判据来自**库文件本身**（门面的内存状态不参与）。
      const reader = new Database(dbPath, { readonly: true });
      try {
        const rows = reader
          .prepare('SELECT content, embedding FROM memories WHERE deleted = 0 ORDER BY rowid')
          .all() as Array<{ content: string; embedding: Buffer | null }>;
        expect(rows.length).toBe(EXPECTED.length);

        for (let index = 0; index < rows.length; index += 1) {
          const [content, cos] = EXPECTED[index]!;
          const row = rows[index]!;
          expect(row.content, '行序必须与写入序一致（rowid 顺序）').toBe(content);
          expect(row.embedding, `${content} 必须有向量`).not.toBeNull();
          const buffer = row.embedding!;
          expect(buffer.byteLength, `${content} 的向量字节数`).toBe(QA_DIM * 4);
          const vector = new Float32Array(buffer.buffer, buffer.byteOffset, QA_DIM);
          expect(vector[0], `${content} 的第 0 分量`).toBe(Math.fround(cos));
        }
      } finally {
        reader.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('★ 同一世界的两次召回（不传 / 传）**逐字段 diff**：不传那次四柱之和 == score，传那次多出 0.25×cos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-vec-diff-'));
    const dbPath = join(dir, 'memory.db');
    const store = new MemoryStore({ dbPath, params: QA_PARAMS });
    try {
      for (const [content, cos] of EXPECTED) {
        store.write({ content, embedding: qaNumbers(qaVectorAtCos(cos)), now: QA_NOW });
      }

      // 同一个门面、同一个库、同一个 `now`，**唯一的差别**是 `queryEmbedding`。
      const plain = store.recall({ context: TEXT_CONTEXT, now: QA_NOW, explain: true });
      const vector = store.recall({
        context: TEXT_CONTEXT,
        now: QA_NOW,
        explain: true,
        queryEmbedding: qaNumbers(qaAxisVector(0)),
      });

      // ── 不传那次：五柱之和 == score，且 vectorPart/cos 是缺项值 ──
      for (const hit of plain.hits) {
        const breakdown = hit.breakdown!;
        expect(breakdown.vectorPart).toBe(0);
        expect(breakdown.cos).toBeNull();
        expect(hit.fromVector).toBe(false);
        const four =
          breakdown.intensityPart +
          breakdown.textPart +
          breakdown.graphPart +
          breakdown.recencyPart;
        expect(Math.abs(four - hit.score)).toBeLessThanOrEqual(1e-12);
      }
      // ── 传那次：**至少一条**真的变了，且每条 `Hit.score - 不传的同一 id` ∈ (0, 0.25] ──
      const before = new Map(plain.hits.map((hit) => [hit.id, hit.score]));
      const common = vector.hits.filter((hit) => before.has(hit.id));
      expect(common.length).toBeGreaterThan(0);
      for (const hit of common) {
        const delta = hit.score - (before.get(hit.id) as number);
        expect(delta).toBeGreaterThan(0);
        expect(delta).toBeLessThanOrEqual(SCORE_WEIGHTS.vectorSim + 1e-12);
      }
      // ── `suppressed` / `diffused` 两次都为空（本参数组下抑制与扩散都关掉）──
      expect(plain.suppressed).toEqual(vector.suppressed);
      expect(plain.diffused).toEqual(vector.diffused);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、零成本：数 SQL（拦截 `Database.prototype.prepare`）
// ═══════════════════════════════════════════════════════════════════════════

/** 「四态判定」那条全表计数的特征（`src/store/stats.ts` 的 `resolveVectorBackendMode`）。 */
const MODE_COUNT_PATTERN = /count\(\*\)[\s\S]*embedding IS NOT NULL/i;

/** 在 `fn` 执行期间记录所有被 `prepare()` 的 SQL（结束后**必定**还原原型）。 */
function withSqlRecorder<T>(fn: () => T): { result: T; sql: readonly string[] } {
  const proto = Database.prototype as unknown as {
    prepare: (sql: string, ...rest: unknown[]) => unknown;
  };
  const original = proto.prepare;
  const seen: string[] = [];
  proto.prepare = function patched(this: unknown, sql: string, ...rest: unknown[]): unknown {
    seen.push(sql);
    return original.call(this, sql, ...rest);
  };
  try {
    return { result: fn(), sql: seen };
  } finally {
    proto.prepare = original;
  }
}

describe('T03 · 零成本 · 不传 `queryEmbedding` ⇒ 全表 COUNT 出现 **0 次**（传了才 ≥1 次）', () => {
  /**
   * ⚠️ **必须用 `VECTOR_ROUTER='auto'`**：`'flat'`（显式）会让四态判定**提前返回**、
   *   连 COUNT 都不做 ⇒ 那样测出来的「0 次」不说明任何事（装置没有可观测对象）。
   *   `'auto'` + 库小于建桶门槛 ⇒ 每次调用都要数一次 ⇒ 条件装配省下的正是这一条。
   */
  const AUTO_PARAMS: Params = { ...QA_PARAMS, VECTOR_ROUTER: 'auto' };

  it('★ 不传向量：`embedding IS NOT NULL` 的 COUNT **0 次**；传了：**≥1 次**（正控）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-vec-sql-'));
    const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), params: AUTO_PARAMS });
    try {
      store.write({
        content: '王五住在成都老家',
        embedding: qaNumbers(qaVectorAtCos(0.95)),
        now: QA_NOW,
      });
      store.write({
        content: '王五住在重庆老家',
        embedding: qaNumbers(qaVectorAtCos(0.6)),
        now: QA_NOW,
      });

      // ── 不传向量 ──
      const without = withSqlRecorder(() => store.recall({ context: TEXT_CONTEXT, now: QA_NOW }));
      const withoutCounts = without.sql.filter((sql) => MODE_COUNT_PATTERN.test(sql));
      // ⚠️ 这一条就是「每次召回多一次全表 COUNT」的**否证**：0 次，不是「少一次」。
      expect(withoutCounts).toEqual([]);
      expect(without.result.hits.length).toBeGreaterThan(0);

      // ── 传了向量（= 计数装置的**正控**：它必须看得见那条 SQL）──
      const withVec = withSqlRecorder(() =>
        store.recall({
          context: TEXT_CONTEXT,
          now: QA_NOW,
          queryEmbedding: qaNumbers(qaAxisVector(0)),
        }),
      );
      const withCounts = withVec.sql.filter((sql) => MODE_COUNT_PATTERN.test(sql));
      expect(withCounts.length).toBeGreaterThanOrEqual(1);
      // ── 命中的那一条必须是 `count(*)` 而不是别的（把特征打印在断言消息里，便于复盘）──
      expect(withCounts[0]?.replace(/\s+/g, ' ')).toContain('count(*)');
      // ── 且那条召回的向量路**确实跑了**（证明「传了向量」这条路径被真正执行到）──
      expect(withVec.result.hits.length).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('★ 计数装置的**灵敏度**：同一段代码里 `write()` 的 SQL 能被同一装置数到（否则上面那条不可信）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-vec-sql2-'));
    const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), params: AUTO_PARAMS });
    try {
      const recorded = withSqlRecorder(() =>
        store.write({
          content: '王五住在成都老家',
          embedding: qaNumbers(qaVectorAtCos(0.95)),
          now: QA_NOW,
        }),
      );
      expect(recorded.sql.length).toBeGreaterThan(0);
      expect(recorded.sql.some((sql) => /INSERT INTO memories/i.test(sql))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、可复现（RK-2）：连跑 5 次同序 + 「遍历顺序取自 hits」的硬性质
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · RK-2 · 结果可复现，且截断顺序取自 `hits` 而非回表 SQL 的返回顺序', () => {
  it('★ 同一查询连跑 5 次：`hits` 的 id 序列逐次相同', () => {
    const store = freshWorld();
    const sequences: string[][] = [];
    const scores: number[][] = [];
    for (let round = 0; round < 5; round += 1) {
      const result = recall(store, {
        context: TEXT_CONTEXT,
        entityNames: ['王五'],
        now: QA_NOW,
        queryEmbedding: qaNumbers(qaAxisVector(0)),
      });
      sequences.push(result.hits.map((hit) => hit.id));
      scores.push(result.hits.map((hit) => hit.score));
    }
    for (let round = 1; round < 5; round += 1) {
      expect(sequences[round]).toEqual(sequences[0]);
      expect(scores[round]).toEqual(scores[0]);
    }
    // ── 前置：这次调用**真的**走向量路了（否则「五次都一样」与向量路无关）──
    expect(sequences[0]).toContain('m-d');

    store.db.close();
  });

  it('★ 25 条**同分**候选 + 落库顺序与 id 序**相反** ⇒ 留下的是按 id 升序的前 20 条', () => {
    // ⚠️ 25 条向量完全相同（cos 恒为 1）⇒ `search()` 的次序只剩「同分按 id 升序」这一条规则
    //   ⇒ 若实现按**回表 SQL 的 `IN (…)` 返回顺序**遍历再截断，留下的会是另外一批 id
    //     （`IN` 的返回次序未定义，在本库里表现为 rowid 顺序 = 我**故意反过来**的插入序）。
    const ids = Array.from({ length: 25 }, (_, index) => `v-${String(index).padStart(2, '0')}`);
    const rows: QaSeedRow[] = [...ids].reverse().map((id) => ({
      id,
      content: `庚辛壬癸${id}`,
      vector: qaAxisVector(0),
    }));
    const store = worldWithPort(rows);

    const pipeline = collectScoredCandidates(store, {
      context: BLIND_CONTEXT,
      entityIds: [],
      entityNames: undefined,
      includeArchived: false,
      now: QA_NOW,
      queryEmbedding: qaNumbers(qaAxisVector(0)),
    });

    // ── 前置：只走了向量路（文本路与图谱路都为空），候选宇宙 = 25 条 ──
    expect(pipeline.text.rows).toEqual([]);
    expect(pipeline.graphCount).toBe(0);
    expect(pipeline.vector.ran).toBe(true);

    // ── 截断到 `VECTOR_TOPK` 之后，留下的必须是**按 id 升序**的前 20 条 ──
    const kept = pipeline.vector.rows.map((row) => row.id);
    expect(kept).toEqual(ids.slice(0, DEFAULT_PARAMS.VECTOR_TOPK));

    // ── 反面证据：按 rowid 顺序（= 插入序，被我反过来）留下的会是另外 20 条 ──
    const rowidOrder = (
      store.db.prepare('SELECT id FROM memories ORDER BY rowid').all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(rowidOrder.slice(0, DEFAULT_PARAMS.VECTOR_TOPK)).not.toEqual(kept);

    store.db.close();
  });
});
