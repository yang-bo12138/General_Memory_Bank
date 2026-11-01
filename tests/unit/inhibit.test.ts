/**
 * §4.13 的侧抑制 —— DEVELOPMENT-PLAN.md **P3-T02** 的硬断言。
 *
 * ⚠️ **本文件分两层**：
 *   ① **纯算法层**（`src/neuron/inhibit.ts`）：三桶模型、逐对判据、池级前置判定、全序稳定性；
 *   ② **集成层**（`src/store/recall.ts` + `src/store/inhibition.ts`）：
 *      抑制不进 score、不写库、`inhibitionTrace` 与 `recall` 同源、开关语义。
 *
 * ⚠️ **断言必须真能失败**：
 *   · 「抑制没让结果变少」这类断言**必须同时断言「该发生的确实发生了」**；
 *   · 涉及浮点的断言用 `toBeCloseTo`（逐位相等的场合用 `toBe`）；
 *   · 随机用例用**确定性伪随机**（LCG）⇒ 失败可复现。
 */

import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { tokenize } from '../../src/core/tokenize.js';
import { createSchema } from '../../src/db/connection.js';
import {
  type InhibitionCandidate,
  inhibitCandidates,
  isRedundant,
  redundancyEvidence,
} from '../../src/neuron/inhibit.js';
import { EventWriter } from '../../src/store/events.js';
import { inhibitionTrace } from '../../src/store/inhibition.js';
import { recall } from '../../src/store/recall.js';
import { MemoryLogger } from '../../src/util/log.js';
import { normalizeNumbers } from '../../src/vector/dot.js';
import {
  countRows,
  createTestStore,
  insertEntity,
  insertMemory,
  readEvents,
} from '../fixtures/graph-store.js';

/** 固定的「现在」（epoch 毫秒）——全部时间从它推导。 */
const NOW = 1_700_000_000_000;

/** 建一个带参数覆盖的 store（机制开关这类需要改参数的用例）。 */
function createStoreWithParams(patch: Partial<Params>): {
  db: Database.Database;
  store: { db: Database.Database; params: Params; events: EventWriter };
  params: Params;
} {
  const db = new Database(':memory:');
  createSchema(db);
  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => 0,
  });
  const params: Params = { ...DEFAULT_PARAMS, ...patch };
  return { db, store: { db, params, events }, params };
}

/**
 * 确保实体行存在（`memory_entities.entity_id` 有外键 ⇒ 引用前必须先有实体）。
 *
 * ⚠️ **名字直接用 id**：测试里的实体 id 本身就是唯一名字 ⇒ 不必另起一套命名。
 */
function ensureEntity(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO entities (id, name, type, created_at)
     VALUES (@id, @name, 'concept', @createdAt)`,
  ).run({ id, name: id, createdAt: NOW });
}

/** 把一条记忆挂到实体上（`memory_entities`）。 */
function linkEntity(db: Database.Database, memoryId: string, entityId: string): void {
  ensureEntity(db, entityId);
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (@memoryId, @entityId)',
  ).run({ memoryId, entityId });
}

/** 给一条记忆写向量（**L2 归一化后**入库，与 §3 的列语义一致）。 */
function setEmbedding(db: Database.Database, id: string, raw: number[]): void {
  db.prepare('UPDATE memories SET embedding = @embedding WHERE id = @id').run({
    embedding: Buffer.from(new Float32Array(normalizeNumbers(raw)).buffer),
    id,
  });
}

/**
 * 造一条**能被文本路召回**的记忆（`content_tokens` 必须自己算，否则 FTS 命中不到）。
 *
 * ⚠️ **`rank` 用来控制分数顺序**（0 = 分最高）：
 *   分数由五项构成（强度 / 向量 / 词法 / 图谱 / 新近度）⇒ 想让某几条**确定地排在前面**
 *   就得让它们的 `last_access` / `created_at` **更新**（强度与新近度都随「刚被用过」上升）。
 *   ⚠️ **词法分必须相同**（⇒ 正文用同一段文本）⇒ 否则 BM25 的差异会盖过新近度的差异，
 *   顺序就不可控 ⇒ 依赖顺序的断言会变成**随机断言**。
 */
function seedMemory(
  db: Database.Database,
  id: string,
  content: string,
  options: {
    entityIds?: string[];
    embedding?: number[];
    /** 0 = 分最高（最新被访问）；越大越旧。 */
    rank?: number;
    stability?: number;
  } = {},
): void {
  const rank = options.rank ?? 0;
  const lastAccess = NOW - (rank + 1) * 60 * 60 * 1000;
  insertMemory(db, id, {
    content,
    stability: options.stability ?? 10,
    lastAccess,
    createdAt: NOW - (rank + 1) * MS_PER_DAY,
    accessCount: 1,
  });
  db.prepare('UPDATE memories SET content_tokens = @tokens WHERE id = @id').run({
    tokens: tokenize(content),
    id,
  });
  for (const entityId of options.entityIds ?? []) {
    linkEntity(db, id, entityId);
  }
  if (options.embedding !== undefined) {
    setEmbedding(db, id, options.embedding);
  }
}

/** 造一条纯算法用的候选（**不碰数据库**）。 */
function candidate(
  id: string,
  score: number,
  entityIds: string[] = [],
  vector: number[] | null = null,
): InhibitionCandidate {
  return {
    id,
    score,
    vector: vector === null ? null : normalizeNumbers(vector),
    entityIds: new Set(entityIds),
  };
}

/** `memories` 表的内容哈希（**抑制不写库**这条断言的探针）。 */
function memoriesHash(db: Database.Database): string {
  const rows = db.prepare('SELECT * FROM memories ORDER BY id').all() as unknown[];
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex');
}

/** 确定性伪随机（LCG）——失败可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 一、判据（§4.13.2）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T02 · 逐对判据 isRedundant（§4.13.2）', () => {
  it('★ 语义路径：双方都有向量且 cos >= REDUNDANCY_COS ⇒ 冗余', () => {
    const params = DEFAULT_PARAMS;
    const a = candidate('a', 1, [], [1, 0]);
    const b = candidate('b', 0.9, [], [0.95, 0.3122]);

    const evidence = redundancyEvidence(a, b);
    expect(evidence.cosine).not.toBeNull();
    expect(evidence.cosine ?? 0).toBeGreaterThanOrEqual(params.REDUNDANCY_COS);
    expect(isRedundant(evidence, params)).toBe(true);
  });

  it('★ 实体路径：共享实体数 >= DEDUP_ENTITY_MIN ⇒ 冗余（**与向量无关**）', () => {
    const params = DEFAULT_PARAMS;
    const a = candidate('a', 1, ['e1', 'e2']);
    const b = candidate('b', 0.9, ['e1', 'e2']);

    const evidence = redundancyEvidence(a, b);
    expect(evidence.sharedEntities).toBe(params.DEDUP_ENTITY_MIN);
    expect(evidence.cosine).toBeNull();
    expect(isRedundant(evidence, params)).toBe(true);
  });

  it('★ 两条路径都不满足 ⇒ 不冗余', () => {
    const params = DEFAULT_PARAMS;
    const a = candidate('a', 1, ['e1'], [1, 0]);
    const b = candidate('b', 0.9, ['e2'], [0, 1]);

    const evidence = redundancyEvidence(a, b);
    expect(evidence.sharedEntities).toBe(0);
    expect(evidence.cosine ?? 0).toBeLessThan(params.REDUNDANCY_COS);
    expect(isRedundant(evidence, params)).toBe(false);
  });

  it('★ 缺向量 ⇒ 语义路径**不参与**（cos = null，不是 0）', () => {
    const params = DEFAULT_PARAMS;
    const a = candidate('a', 1, [], null);
    const b = candidate('b', 0.9, [], [1, 0]);

    const evidence = redundancyEvidence(a, b);
    // ⚠️ **不是 0**（0 会被误读成「余弦算出来是 0」⇒ 「不相似的证据」看起来像「没证据」）
    expect(evidence.cosine).toBeNull();
    expect(isRedundant(evidence, params)).toBe(false);
  });

  it('★ 实体交集差一个就不算冗余（门槛是 >= DEDUP_ENTITY_MIN，不是 >）', () => {
    const params = DEFAULT_PARAMS;
    const a = candidate('a', 1, ['e1', 'e2']);
    const b = candidate('b', 0.9, ['e1']);

    expect(redundancyEvidence(a, b).sharedEntities).toBe(params.DEDUP_ENTITY_MIN - 1);
    expect(isRedundant(redundancyEvidence(a, b), params)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 二、三桶模型（§4.13.3）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T02 · 三桶模型（R / D / overflow）', () => {
  /** 造 10 个候选：c1 与 c0 冗余，其余互不冗余。 */
  function buildPool(): InhibitionCandidate[] {
    const pool: InhibitionCandidate[] = [candidate('c0', 1.0, ['e1', 'e2'])];
    pool.push(candidate('c1', 0.9, ['e1', 'e2']));
    for (let index = 2; index < 10; index += 1) {
      pool.push(candidate(`c${index}`, 1 - index / 20, [`x${index}`]));
    }
    return pool;
  }

  it('★ 三桶分离：|C| = 10、topN = 2 ⇒ 溢出候选**不**进 suppressed，且**没有** redundantWith', () => {
    const pool = buildPool();
    const outcome = inhibitCandidates(pool, 2, DEFAULT_PARAMS);

    // 性质：三个桶各自非空 ⇒ 断言真的在检验「分离」
    expect(outcome.kept).toHaveLength(2);
    expect(outcome.redundant).toHaveLength(1);
    expect(outcome.overflow).toHaveLength(7);

    // ★ 溢出候选**不在** redundant 桶里 ⇒ 不会被标成「被挤掉的」
    const overflowIds = outcome.overflow.map((item) => item.id);
    expect(outcome.redundant.map((entry) => entry.candidate.id)).not.toContain('c9');
    // ★ 溢出候选**没有**合法的 `redundantWith`（它们根本没参与评估）
    for (const entry of outcome.redundant) {
      expect(outcome.overflow.map((item) => item.id)).not.toContain(entry.redundantWith);
    }
    expect(overflowIds).toHaveLength(7);
  });

  it('★ D 桶里的那条**有**合法的 redundantWith（指向留在 R 桶里的那条）', () => {
    const outcome = inhibitCandidates(buildPool(), 2, DEFAULT_PARAMS);
    const entry = outcome.redundant[0];
    expect(entry?.redundantWith).toBe('c0');
    expect(outcome.kept.map((item) => item.id)).toContain('c0');
  });

  it('★ 不变式：多组候选 ⇒ hits.length >= min(topN, min(2,|C|)) 且 <= min(topN,|C|)', () => {
    const random = makeRandom(20260901);
    for (let round = 0; round < 200; round += 1) {
      const size = 1 + Math.floor(random() * 12);
      const topN = 1 + Math.floor(random() * 8);
      const pool: InhibitionCandidate[] = [];
      for (let index = 0; index < size; index += 1) {
        // 随机实体：偶尔共享 ⇒ 制造冗余；分数带随机扰动 ⇒ 制造同分边界
        const shared = random() < 0.4 ? ['shared'] : [];
        const unique = random() < 0.5 ? [`u${index}`] : [];
        pool.push(candidate(`m${index}`, Math.round(random() * 10) / 10, [...shared, ...unique]));
      }
      const outcome = inhibitCandidates(pool, topN, DEFAULT_PARAMS);
      const hits = outcome.kept.length;

      expect(hits).toBeGreaterThanOrEqual(Math.min(topN, Math.min(2, size)));
      expect(hits).toBeLessThanOrEqual(Math.min(topN, size));
      // 三个桶合起来恰好是全部候选（**没有候选被弄丢**）
      expect(hits + outcome.redundant.length + outcome.overflow.length).toBe(size);
    }
  });

  it('★ poolHomogeneous 是**池级**的：整池同质 ⇒ hits = min(topN,|C|) 条、suppressed 为空', () => {
    // 三条互相冗余（共享同两个实体）⇒ 整池同质 ⇒ **没有替代品** ⇒ 不抑制
    const pool = [
      candidate('c0', 1.0, ['e1', 'e2']),
      candidate('c1', 0.9, ['e1', 'e2']),
      candidate('c2', 0.8, ['e1', 'e2']),
    ];
    const outcome = inhibitCandidates(pool, 2, DEFAULT_PARAMS);

    expect(outcome.poolHomogeneous).toBe(true);
    expect(outcome.kept).toHaveLength(2);
    expect(outcome.redundant).toHaveLength(0);
  });

  it('★ poolHomogeneous **不随 R 的增长重算**（进入遍历前算一次并固定）', () => {
    // c0 与 c1 冗余、c2 与 c0 **不**冗余 ⇒ 池级判定为**假**
    // ⇒ 遍历时 c1 进 D 桶、c2 进 R 桶 ⇒ **不**因为「R 里只剩 c2 与 c1 不冗余」而改判。
    const pool = [
      candidate('c0', 1.0, ['e1', 'e2']),
      candidate('c1', 0.9, ['e1', 'e2']),
      candidate('c2', 0.8, ['other']),
    ];
    const outcome = inhibitCandidates(pool, 5, DEFAULT_PARAMS);

    expect(outcome.poolHomogeneous).toBe(false);
    expect(outcome.kept.map((item) => item.id)).toEqual(['c0', 'c2']);
    expect(outcome.redundant.map((entry) => entry.candidate.id)).toEqual(['c1']);
  });

  it('★ 全序稳定：同一候选集用**不同插入顺序**喂入 ⇒ 输出完全相同', () => {
    const base = [
      candidate('m1', 0.5, ['e1']),
      candidate('m2', 0.5, ['e2']),
      candidate('m3', 0.5, ['e3']),
      candidate('m4', 0.9, ['e4']),
    ];
    // ⚠️ `!` 是安全的：`base` 是**字面量数组**（长度固定 4）⇒ 下标必然存在
    const shuffled = [base[2]!, base[0]!, base[3]!, base[1]!];

    const first = inhibitCandidates(base, 3, DEFAULT_PARAMS);
    const second = inhibitCandidates(shuffled, 3, DEFAULT_PARAMS);

    expect(second.kept.map((item) => item.id)).toEqual(first.kept.map((item) => item.id));
    expect(second.redundant.map((entry) => entry.candidate.id)).toEqual(
      first.redundant.map((entry) => entry.candidate.id),
    );
    expect(second.overflow.map((item) => item.id)).toEqual(first.overflow.map((item) => item.id));
    // ★ 同分候选的顺序由 **id** 决定（不是插入顺序）
    expect(first.kept.map((item) => item.id)).toEqual(['m4', 'm1', 'm2']);
  });

  it('★ 候选池为空 ⇒ poolHomogeneous 为真、hits 为空（不变式的下界是 0）', () => {
    const outcome = inhibitCandidates([], 5, DEFAULT_PARAMS);
    expect(outcome.poolHomogeneous).toBe(true);
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.redundant).toHaveLength(0);
    expect(outcome.overflow).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 三、集成：抑制接进召回流水线（§4.6 步骤 4.5）
// ═══════════════════════════════════════════════════════════════════════

/** 造一个「三条候选、其中两条冗余」的库（**集成层**用）。 */
function seedInhibitionWorld(
  db: Database.Database,
  options: { withEmbedding?: boolean } = {},
): void {
  // c-a 与 c-b 共享两个实体 ⇒ 冗余（实体路径）；c-c 与前两条**没有**共享实体 ⇒ 不冗余
  seedMemory(db, 'c-a', '猫粮品牌偏好记录', {
    entityIds: ['e-1', 'e-2'],
    rank: 0,
  });
  seedMemory(db, 'c-b', '猫粮品牌偏好记录', {
    entityIds: ['e-1', 'e-2'],
    rank: 1,
  });
  seedMemory(db, 'c-c', '猫粮品牌偏好记录', {
    entityIds: ['e-3', 'e-4'],
    rank: 2,
  });

  if (options.withEmbedding === true) {
    // ⚠️ 三条互不相似（余弦 < REDUNDANCY_COS）⇒ 冗余**只**可能来自实体路径
    setEmbedding(db, 'c-a', [1, 0]);
    setEmbedding(db, 'c-b', [0, 1]);
    setEmbedding(db, 'c-c', [0, 0, 1]);
  }
}

/** 召回一次（默认参数 ⇒ 抑制开启）。 */
function recallOnce(
  store: { db: Database.Database; params: Params; events: EventWriter },
  context = '猫粮品牌',
): ReturnType<typeof recall> {
  return recall(store, { context, now: NOW });
}

describe('P3-T02 · 集成：抑制接进召回流水线', () => {
  it('★ 抑制**不进 score**：Hit.score 恒等于五项加权和（误差 <= 1e-9）', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    // ⚠️ **必须带 `explain`** 才有 `breakdown`（否则断言无从下手）
    const result = recall(store, { context: '猫粮品牌', explain: true, now: NOW });

    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      const breakdown = hit.breakdown;
      if (breakdown === undefined) {
        throw new Error('本用例必须带 explain 才有 breakdown');
      }
      const sum =
        breakdown.intensityPart +
        breakdown.vectorPart +
        breakdown.textPart +
        breakdown.graphPart +
        breakdown.recencyPart;
      expect(hit.score).toBeCloseTo(sum, 9);
      // ⚠️ **排名分与命中分是同一个数**（§4.13.1 硬约束①：抑制不引入第二个分）
      //   ⇒ hits 严格按 `score` 降序 ⇒ 排序用的就是 `Hit.score` 本身。
      expect(hit.score).toBe(result.hits.find((item) => item.id === hit.id)?.score);
    }
    const scores = result.hits.map((hit) => hit.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it('★ 抑制**不改任何候选的分数**（与「开关关闭」那一次逐位相同）', () => {
    const withInhibition = createTestStore();
    seedInhibitionWorld(withInhibition.db);
    const withoutInhibition = createStoreWithParams({ inhibition: false });
    seedInhibitionWorld(withoutInhibition.db);

    const on = recallOnce(withInhibition.store);
    const off = recallOnce(withoutInhibition.store);

    // ★ 逐位比较**每一条候选**的分数（hits + suppressed 都要比）
    const scoresOn = new Map<string, number>([
      ...on.hits.map((hit) => [hit.id, hit.score] as const),
      ...on.suppressed.map((item) => [item.id, item.score] as const),
    ]);
    const scoresOff = new Map<string, number>([
      ...off.hits.map((hit) => [hit.id, hit.score] as const),
      ...off.suppressed.map((item) => [item.id, item.score] as const),
    ]);
    expect(scoresOn.size).toBe(scoresOff.size);
    for (const [id, score] of scoresOff) {
      expect(scoresOn.get(id)).toBe(score);
    }
    // 性质：抑制**确实**改变了结果（否则上面那条断言是空洞的）
    expect(on.hits.length).toBeLessThan(off.hits.length);
  });

  it('★ 抑制**不写库**：抑制前后 memories 表的内容哈希完全相同', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    const before = memoriesHash(db);
    const result = recallOnce(store);
    const after = memoriesHash(db);

    // 性质：抑制确实发生了（否则「哈希没变」是空洞的）
    expect(result.suppressed.length).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it('★ 机制：共享实体的两条被挤进 suppressed，且带 redundantWith', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    const result = recallOnce(store);

    expect(result.suppressed).toHaveLength(1);
    const suppressed = result.suppressed[0];
    expect(suppressed?.reason).toBe('redundant');
    // ★ `redundantWith` 必须指向**留在 hits 里**的那条
    expect(result.hits.map((hit) => hit.id)).toContain(suppressed?.redundantWith);
    // ⚠️ **reason 只有 'redundant' 一种**（溢出候选不收进 suppressed）
    expect(result.suppressed.every((item) => item.reason === 'redundant')).toBe(true);
  });

  it('★ 溢出候选**不出现在** suppressed 里（|C| > topN 时）', () => {
    const { db, store } = createTestStore();
    // ★ **冗余对排在最前**（rank 0/1）⇒ 断言不是随机的：
    //   R = [c-a]、c-b 进 D 桶、R 再收一条 ⇒ 其余四条**溢出**。
    seedMemory(db, 'c-a', '猫粮品牌偏好记录', { entityIds: ['e-1', 'e-2'], rank: 0 });
    seedMemory(db, 'c-b', '猫粮品牌偏好记录', { entityIds: ['e-1', 'e-2'], rank: 1 });
    for (let index = 0; index < 4; index += 1) {
      seedMemory(db, `c-x${index}`, '猫粮品牌偏好记录', {
        entityIds: [`u-${index}`],
        rank: 2 + index,
      });
    }

    const result = recall(store, { context: '猫粮品牌', topN: 2, now: NOW });

    expect(result.hits).toHaveLength(2);
    expect(result.suppressed).toHaveLength(1);
    // ★ 被抑制的**有**合法的 redundantWith（它确实参与过评估）
    expect(result.suppressed[0]?.redundantWith).toBeDefined();
    expect(result.hits.map((hit) => hit.id)).toContain(result.suppressed[0]?.redundantWith);
    // ★ 溢出候选（4 条）**不在** suppressed 里
    expect(result.suppressed).toHaveLength(1);
  });

  it('★ 实体路径**不依赖 embedding**：一条向量都没有的库里侧抑制**仍然生效**', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    // 性质：库里**一条向量都没有** ⇒ 语义路径整条不可用
    const embedded = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL')
      .get() as { n: number };
    expect(embedded.n).toBe(0);

    const result = recallOnce(store);

    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.redundantWith).toBeDefined();
  });

  it('★ 语义路径：cos >= REDUNDANCY_COS 的两条（**没有**共享实体）也判冗余', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-3', '李四');
    seedMemory(db, 'c-a', '猫粮品牌张三的偏好记录', {
      entityIds: ['e-1'],
      embedding: [1, 0],
    });
    seedMemory(db, 'c-b', '猫粮品牌李四的采购清单', {
      entityIds: ['e-3'],
      embedding: [0.95, 0.3122],
    });
    seedMemory(db, 'c-c', '猫粮品牌王五的囤货记录', {
      entityIds: ['e-9'],
      embedding: [0, 1],
    });

    const result = recallOnce(store);

    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.redundantWith).toBeDefined();
    // ★ 语义路径触发 ⇒ `redundancySim`（该对的余弦）有值
    expect(result.suppressed[0]?.redundancySim).toBeGreaterThanOrEqual(
      DEFAULT_PARAMS.REDUNDANCY_COS,
    );
  });

  it('★ 簇**不参与判定**：同簇但实体交集不足、cos 不足 ⇒ 不判冗余', () => {
    const { db, store } = createTestStore();
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-3', '李四');
    seedMemory(db, 'c-a', '猫粮品牌张三的偏好记录', {
      entityIds: ['e-1'],
      embedding: [1, 0],
    });
    seedMemory(db, 'c-b', '猫粮品牌李四的采购清单', {
      entityIds: ['e-3'],
      embedding: [0, 1],
    });
    // ⚠️ **把两条放进同一个主题簇**（诊断上下文）⇒ 判定**不得**因此改变
    db.prepare(
      'INSERT INTO theme_clusters (cluster_id, cluster_version, computed_at, member_count) VALUES (?, 1, ?, 2)',
    ).run('cluster-1', NOW);
    db.prepare('INSERT INTO theme_cluster_members (cluster_id, memory_id) VALUES (?, ?)').run(
      'cluster-1',
      'c-a',
    );
    db.prepare('INSERT INTO theme_cluster_members (cluster_id, memory_id) VALUES (?, ?)').run(
      'cluster-1',
      'c-b',
    );

    const result = recallOnce(store);

    // ★ 同簇但**不冗余** ⇒ 两条都该留下（没有 suppressed）
    expect(result.suppressed).toHaveLength(0);
  });

  it('★ `inhibition` 开关关闭时：候选带**不重排**，直接按 base 分取 topN', () => {
    const { db, store } = createStoreWithParams({ inhibition: false });
    seedInhibitionWorld(db);

    const result = recall(store, { context: '猫粮品牌', now: NOW });

    // ★ 开关关 ⇒ 没有任何候选被抑制 ⇒ hits = 全部候选（topN 默认 5）
    expect(result.suppressed).toHaveLength(0);
    expect(result.hits).toHaveLength(3);
    // ★ 顺序**纯按分数降序**（不重排）
    const scores = result.hits.map((hit) => hit.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it('★ 抑制**不作用于 diffused**：diffused 的条数与 inhibition 开关无关', () => {
    const on = createTestStore();
    seedInhibitionWorld(on.db);
    const off = createStoreWithParams({ inhibition: false });
    seedInhibitionWorld(off.db);

    const withInhibition = recallOnce(on.store);
    const withoutInhibition = recallOnce(off.store);

    expect(withInhibition.diffused.length).toBe(withoutInhibition.diffused.length);
  });

  it('★ 抑制只在 `explicit` 的语义下改「谁进 hits」，**不改事件的 scores**', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    const result = recall(store, { context: '猫粮品牌', explain: true, now: NOW });
    const events = readEvents(db, 'recall');

    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as {
      hitIds: string[];
      scores: number[];
      suppressedIds: string[];
    };
    // ★ 事件里的分数与返回的分数**逐位相同**（抑制没改分）
    expect(payload.scores).toEqual(result.hits.map((hit) => hit.score));
    // ★ 事件里的 suppressedIds 与返回的 suppressed **一致**
    expect(payload.suppressedIds).toEqual(result.suppressed.map((item) => item.id));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 四、inhibitionTrace（§6）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T02 · inhibitionTrace（§6）', () => {
  it('★ trace 的 baseScore 与 recall 的 Hit.score **逐位相同**（同一段打分代码）', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    const result = recallOnce(store);
    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    const hitScores = new Map(result.hits.map((hit) => [hit.id, hit.score]));
    expect(trace.candidates.length).toBeGreaterThan(0);
    for (const candidateRow of trace.candidates) {
      const hitScore = hitScores.get(candidateRow.id);
      if (hitScore !== undefined) {
        // ★ **逐位**（不是 toBeCloseTo）：同一段代码 ⇒ 同一个浮点数
        expect(candidateRow.baseScore).toBe(hitScore);
      }
    }
  });

  it('★ trace 的 selected 与 recall 的 hits 同口径（同样的 id、同样的分数）', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    const result = recallOnce(store);
    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    expect(trace.selected.map((item) => item.id)).toEqual(result.hits.map((hit) => hit.id));
    expect(trace.selected.map((item) => item.baseScore)).toEqual(
      result.hits.map((hit) => hit.score),
    );
  });

  it('★ trace 的 inhibited 只标 D 桶；溢出候选**不**被标成「被抑制」', () => {
    const { db, store } = createTestStore();
    // ★ **冗余对排在最前**（rank 0/1）⇒ D 桶与 O 桶都非空 ⇒ 断言不是随机的
    //   （候选数 7 > `RECALL_TOP_N`(5) ⇒ 必有溢出候选）
    seedMemory(db, 'c-a', '猫粮品牌偏好记录', { entityIds: ['e-1', 'e-2'], rank: 0 });
    seedMemory(db, 'c-b', '猫粮品牌偏好记录', { entityIds: ['e-1', 'e-2'], rank: 1 });
    for (let index = 0; index < 5; index += 1) {
      seedMemory(db, `c-x${index}`, '猫粮品牌偏好记录', {
        entityIds: [`u-${index}`],
        rank: 2 + index,
      });
    }

    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    const inhibited = trace.candidates.filter((item) => item.inhibited);
    expect(inhibited).toHaveLength(1);
    // ★ 被抑制的那条**有** redundantWith
    expect(inhibited[0]?.redundantWith).toBeDefined();
    // ★ 其余候选（保留 + 溢出）都**不是** inhibited
    expect(trace.candidates.filter((item) => !item.inhibited)).toHaveLength(
      trace.candidates.length - 1,
    );
    // ★ 溢出候选（**既没被选中、也没被抑制**）**没有** redundantWith
    //   （它们根本没参与评估 ⇒ 没有合法的 redundantWith）
    const overflow = trace.candidates.filter(
      (item) => !item.inhibited && !trace.selected.some((selected) => selected.id === item.id),
    );
    expect(overflow.length).toBeGreaterThan(0);
    for (const item of overflow) {
      expect(item.redundantWith).toBeUndefined();
      expect(item.inhibited).toBe(false);
    }
  });

  it('★ trace **纯读**：不写库、不写事件', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);

    const before = memoriesHash(db);
    inhibitionTrace(store, '猫粮品牌', { now: NOW });

    expect(memoriesHash(db)).toBe(before);
    expect(readEvents(db, 'recall')).toHaveLength(0);
    expect(countRows(db, 'events')).toBe(0);
  });

  it('★ trace 的 clusterId 是**诊断上下文**（不参与判定）', () => {
    const { db, store } = createTestStore();
    seedInhibitionWorld(db);
    db.prepare(
      'INSERT INTO theme_clusters (cluster_id, cluster_version, computed_at, member_count) VALUES (?, 1, ?, 2)',
    ).run('cluster-1', NOW);
    db.prepare('INSERT INTO theme_cluster_members (cluster_id, memory_id) VALUES (?, ?)').run(
      'cluster-1',
      'c-a',
    );
    db.prepare('INSERT INTO theme_cluster_members (cluster_id, memory_id) VALUES (?, ?)').run(
      'cluster-1',
      'c-b',
    );

    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });
    const withCluster = trace.candidates.filter((item) => item.clusterId !== null);

    expect(withCluster.length).toBeGreaterThan(0);
    expect(withCluster[0]?.clusterId).toBe('cluster-1');
    // ★ 判定**不受**簇影响：c-a 与 c-b 仍然被判冗余（它们共享两个实体）
    expect(trace.candidates.filter((item) => item.inhibited)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 五、§4.6 步骤 4.5 与 §4.13.3 的**一致性**（QA 的 G11 闸门）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T02 · §4.6 步骤 4.5 与 §4.13.3 必须给出同一个结果', () => {
  /**
   * §4.6 步骤 4.5 的**独立转写**（**不调 `src/neuron/inhibit.ts` 的任何函数**）。
   *
   * ⚠️ **为什么要独立转写**：若直接调用被测实现，两边写错同一个地方就一起错 ⇒ 断言恒绿。
   * ⇒ 这里连**判据**都自己写一遍（余弦阈值 + 实体交集），只共用「候选的纯数据」。
   */
  function section46Reading(
    pool: readonly InhibitionCandidate[],
    topN: number,
  ): { hits: string[]; suppressed: string[] } {
    const params = DEFAULT_PARAMS;
    const redundant = (left: InhibitionCandidate, right: InhibitionCandidate): boolean => {
      let cosine: number | null = null;
      if (
        left.vector !== null &&
        right.vector !== null &&
        left.vector.length === right.vector.length
      ) {
        let dot = 0;
        let normLeft = 0;
        let normRight = 0;
        for (let index = 0; index < left.vector.length; index += 1) {
          const a = left.vector[index] ?? 0;
          const b = right.vector[index] ?? 0;
          dot += a * b;
          normLeft += a * a;
          normRight += b * b;
        }
        cosine = normLeft > 0 && normRight > 0 ? dot / Math.sqrt(normLeft * normRight) : null;
      }
      const shared = [...left.entityIds].filter((id) => right.entityIds.has(id)).length;
      return (
        (cosine !== null && cosine >= params.REDUNDANCY_COS) || shared >= params.DEDUP_ENTITY_MIN
      );
    };

    const ordered = [...pool].sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    );

    // ② 前置判定（池级）
    const c0 = ordered[0];
    const poolHomogeneous =
      c0 === undefined ? true : ordered.slice(1).every((candidate) => redundant(candidate, c0));

    const kept: InhibitionCandidate[] = [];
    const suppressed: string[] = [];
    for (const candidate of ordered) {
      if (kept.length >= topN) {
        continue;
      }
      if (poolHomogeneous) {
        kept.push(candidate);
        continue;
      }
      const match = kept.find((retained) => redundant(candidate, retained));
      if (match === undefined) {
        kept.push(candidate);
        continue;
      }
      suppressed.push(candidate.id);
    }
    return { hits: kept.map((item) => item.id), suppressed };
  }

  it('★ 多组候选下，两处写法给出**完全相同**的 hits 与 suppressed', () => {
    const random = makeRandom(20260902);
    for (let round = 0; round < 100; round += 1) {
      const size = 1 + Math.floor(random() * 10);
      const topN = 1 + Math.floor(random() * 5);
      const pool: InhibitionCandidate[] = [];
      for (let index = 0; index < size; index += 1) {
        const entityIds: string[] = [];
        if (random() < 0.5) {
          entityIds.push('shared');
        }
        if (random() < 0.5) {
          entityIds.push(`u${index}`);
        }
        pool.push(candidate(`m${index}`, Math.round(random() * 10) / 10, entityIds));
      }

      const outcome = inhibitCandidates(pool, topN, DEFAULT_PARAMS);
      const reading = section46Reading(pool, topN);

      expect(outcome.kept.map((item) => item.id)).toEqual(reading.hits);
      expect(outcome.redundant.map((entry) => entry.candidate.id)).toEqual(reading.suppressed);
    }
  });

  it('★ 「整池同质」这一组：两处都给出 hits = min(topN,|C|) 条、suppressed 为空', () => {
    const pool = [
      candidate('c0', 1.0, ['e1', 'e2']),
      candidate('c1', 0.9, ['e1', 'e2']),
      candidate('c2', 0.8, ['e1', 'e2']),
    ];
    const outcome = inhibitCandidates(pool, 2, DEFAULT_PARAMS);
    const reading = section46Reading(pool, 2);

    expect(outcome.kept.map((item) => item.id)).toEqual(reading.hits);
    expect(reading.hits).toHaveLength(2);
    expect(reading.suppressed).toHaveLength(0);
    expect(outcome.redundant).toHaveLength(0);
  });
});
