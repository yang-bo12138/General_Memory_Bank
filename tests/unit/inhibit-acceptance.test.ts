/**
 * P3-T02 侧抑制 · **QA 对抗式验收**（验收人：software-qa-engineer）。
 *
 * ⚠️ **本文件的定位**：它**不是** `tests/unit/inhibit.test.ts` 的补充，而是**独立复核**——
 *   工程师那份单测由实现者自己写，**它与被审实现在同一个人手里**⇒
 *   「断言存在但前提不成立 ⇒ 恒绿守卫 ⇒ 假绿」（Q-01 的教训）这条风险无法靠它自己排除。
 *   ⇒ 本文件**重新构造夹具**，并对**每一条断言**先问一句：
 *   「**它的前提在我的夹具里真的成立吗？**」⇒ 前提用**显式的断言**写在同一条用例里。
 *
 * ★ **每个用例都标了「攻击面」**（A~J，对应 `docs/qa/p3-t02-acceptance-plan.md`）
 *   ⇒ 变异打红时能直接对号入座。
 * ★ **前提不成立的用例一律不写** ⇒ 宁可少一条断言，也不要一条恒绿的。
 */

import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params, applyParamPatch } from '../../src/core/params.js';
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
import { ParamStore, type ParamsBackend } from '../../src/store/params.js';
import { recall } from '../../src/store/recall.js';
import { MemoryLogger } from '../../src/util/log.js';
import { normalizeNumbers } from '../../src/vector/dot.js';

/** 固定的「现在」（epoch 毫秒）——全部时间从它推导。 */
const NOW = 1_700_000_000_000;

// ═══════════════════════════════════════════════════════════════════════
// 夹具（**QA 自建**，不依赖工程师那份测试的任何 helper）
// ═══════════════════════════════════════════════════════════════════════

/** 一个带参数覆盖的 store（机制开关这类需要改参数的用例）。 */
function makeStore(patch: Partial<Params> = {}): {
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

/** 把一条记忆挂到实体上（先建实体行 ⇒ 满足外键）。 */
function linkEntity(db: Database.Database, memoryId: string, entityId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO entities (id, name, type, created_at)
     VALUES (@id, @name, 'concept', @createdAt)`,
  ).run({ id: entityId, name: entityId, createdAt: NOW });
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (@memoryId, @entityId)',
  ).run({ memoryId, entityId });
}

/**
 * 造一条能被文本路召回的记忆。
 *
 * ⚠️ **`rank` 越大 ⇒ 分数越低**（`last_access` / `created_at` 更旧 ⇒ 强度与新近度都更低）。
 * ⚠️ **正文必须完全相同** ⇒ BM25 相同 ⇒ 分数差异只来自 `rank` ⇒ 顺序可预期。
 */
function seedMemory(
  db: Database.Database,
  id: string,
  options: {
    content?: string;
    entityIds?: string[];
    embedding?: number[];
    /** 0 = 分最高（最新被访问）。 */
    rank?: number;
  } = {},
): void {
  const rank = options.rank ?? 0;
  const content = options.content ?? '猫粮品牌偏好记录';
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                           stability, difficulty, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, 10, 0.5,
             @createdAt, @lastAccess, 1, 0, NULL)`,
  ).run({
    id,
    content,
    tokens: tokenize(content),
    hash: `hash-${id}`,
    createdAt: NOW - (rank + 1) * MS_PER_DAY,
    lastAccess: NOW - (rank + 1) * 60 * 60 * 1000,
  });
  db.prepare('UPDATE memories SET content_tokens = @tokens WHERE id = @id').run({
    tokens: tokenize(content),
    id,
  });
  for (const entityId of options.entityIds ?? []) {
    linkEntity(db, id, entityId);
  }
  if (options.embedding !== undefined) {
    db.prepare('UPDATE memories SET embedding = @embedding WHERE id = @id').run({
      embedding: Buffer.from(normalizeNumbers(options.embedding).buffer),
      id,
    });
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

/** 造一条边（`edges` 表：实体 ↔ 实体）——**联想路实体跳的燃料**。 */
function insertEdge(
  db: Database.Database,
  id: string,
  subjectId: string,
  predicate: string,
  objectId: string,
  weight: number,
  lastActive: number = NOW,
): void {
  for (const entityId of [subjectId, objectId]) {
    db.prepare(
      `INSERT OR IGNORE INTO entities (id, name, type, created_at)
       VALUES (@id, @id, 'concept', @at)`,
    ).run({ id: entityId, at: NOW });
  }
  db.prepare(
    `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
     VALUES (@id, @subjectId, @predicate, @objectId, NULL, @weight, @lastActive, @lastActive)`,
  ).run({ id, subjectId, predicate, objectId, weight, lastActive });
}

/** 造一条共激活边（**必须 a < b**，与 `coacts` 的 CHECK 一致）——**簇跳的燃料**。 */
function insertCoact(
  db: Database.Database,
  left: string,
  right: string,
  affinity: number,
  lastActive: number = NOW,
): void {
  const [a, b] = left < right ? [left, right] : [right, left];
  db.prepare(
    `INSERT OR REPLACE INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
     VALUES (@a, @b, @affinity, 1, 1, @lastActive)`,
  ).run({ a, b, affinity, lastActive });
}

/** 造一个主题簇（**快照的两张表**）——**簇跳的燃料**。 */
function insertCluster(
  db: Database.Database,
  clusterId: string,
  memberIds: readonly string[],
): void {
  db.prepare(
    'INSERT INTO theme_clusters (cluster_id, cluster_version, computed_at, member_count) VALUES (?, 1, ?, ?)',
  ).run(clusterId, NOW, memberIds.length);
  for (const memberId of memberIds) {
    db.prepare('INSERT INTO theme_cluster_members (cluster_id, memory_id) VALUES (?, ?)').run(
      clusterId,
      memberId,
    );
  }
}

/** 一组表的**内容哈希**（行数 + 主键 + 全部列的内容 ⇒ 改内容必改哈希）。 */
function tableHash(db: Database.Database, table: string, orderBy: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as unknown[];
  return createHash('sha1')
    .update(`${rows.length}|${JSON.stringify(rows)}`)
    .digest('hex');
}

/** 「冗余对 + 一条不冗余」的集成夹具（c-a 与 c-b 共享两个实体 ⇒ 实体路径冗余）。 */
function seedRedundantPair(db: Database.Database): void {
  seedMemory(db, 'c-a', { entityIds: ['e-1', 'e-2'], rank: 0 });
  seedMemory(db, 'c-b', { entityIds: ['e-1', 'e-2'], rank: 1 });
  seedMemory(db, 'c-c', { entityIds: ['e-3', 'e-4'], rank: 2 });
}

/**
 * 同上，但 **id 字典序与分数序相反**（m-c 分最高、m-a 分最低）。
 *
 * ⚠️ **为什么需要这一份夹具**：若 id 的字典序恰好与分数序同向，
 *   则「按 id 排」与「按分数排」的结果**完全一样** ⇒
 *   「开关关时不得重排」这类断言就变成**恒绿守卫**（抓不到任何重排类变异）。
 */
function seedRedundantPairReversedIds(db: Database.Database): void {
  seedMemory(db, 'm-c', { entityIds: ['e-1', 'e-2'], rank: 0 });
  seedMemory(db, 'm-b', { entityIds: ['e-1', 'e-2'], rank: 1 });
  seedMemory(db, 'm-a', { entityIds: ['e-3', 'e-4'], rank: 2 });
}

/**
 * 五条**互不冗余**的候选（实体各不相同）⇒ R 桶 = 5 条。
 *
 * ⚠️ **用途**：验证 `inhibitionTrace` 与 `recall` **名额同源**（§6 的「同一个 `clampTopN()`」）。
 *   ⇒ 若两边的名额口径漂移，`selected.length` 与 `hits.length` 就会不等。
 */
function seedFiveDistinct(db: Database.Database): void {
  for (let index = 0; index < 5; index += 1) {
    seedMemory(db, `f-${index}`, { entityIds: [`u-${index}`], rank: index });
  }
}

/**
 * ★ **攻击面 E 的夹具（P3-T04 落地 `diffused` 非空之后重建）**：
 * **有边 + 有共激活 + 有簇** ⇒ 联想路（实体跳 + 簇跳）**真的产出东西**。
 *
 * ⚠️ ★ **为什么必须重建这个夹具**（QA 上一轮留在 `docs/qa/p3-t02-acceptance-report.md`
 *   §三·3 的那笔账）：
 *   P3-T02 写下 `E1` 时 `diffused` **恒为空数组**（联想路未实现）
 *   ⇒ 那条断言是**恒绿守卫**（什么都能通过）⇒ **证明不了**「抑制没碰 diffused」。
 *   ⇒ P3-T04 把 `diffused` 接成非空之后，这条断言**才真正可执行**。
 *
 * ⚠️ ★ **本夹具的三条腿都必须真的通**（否则「diffused 非空」这个前提仍不成立）：
 *   ① **边**（实体跳）：`e-1 → e-4` ⇒ 从 `c-a` 的实体 `e-1` 走到 `c-d` 的实体 `e-4`。
 *   ② **共激活 + 簇**（簇跳）：`c-a` 与 `c-d` 之间有共激活边、且同属簇 `c-1`
 *      ⇒ 簇跳那条腿**也能**捞到 `c-d`（⇒ 两条腿都产出 ⇒ 分数取 max）。
 *   ③ **专属路径**：`c-e` **只**能由 `c-b` 触达（`e-5 → e-6`）
 *      ⇒ 种子口径一旦从「抑制前 topN」漂移到「抑制后 hits」，
 *      `c-b` 被挤掉 ⇒ `c-e` 从 `diffused` 里消失 ⇒ **这条断言立刻变红**
 *      ⇒ **它不是恒绿守卫**。
 *
 * ⚠️ **`c-d` / `c-e` 的正文不含「猫粮品牌」** ⇒ 它们**不进候选集**
 *   ⇒ 不改变上面三条的分数与排序（⇒ 抑制行为仍由 `c-a` / `c-b` / `c-c` 决定）。
 */
function seedDiffusionWorld(db: Database.Database): void {
  // ── 三条文本路候选：c-a / c-b 共享两个实体 ⇒ 冗余（实体路径）⇒ c-b 被挤掉；
  //    c-c 与前两条没有共享实体 ⇒ 不冗余。
  seedMemory(db, 'c-a', { entityIds: ['e-1', 'e-2'], rank: 0 });
  seedMemory(db, 'c-b', { entityIds: ['e-1', 'e-2', 'e-5'], rank: 1 });
  seedMemory(db, 'c-c', { entityIds: ['e-3', 'e-4'], rank: 2 });

  // ── ① 边（实体跳）：c-a 的 e-1 ⇒ c-d 的 e-6 ──
  //    ⚠️ ★ **正文必须显式给成「不含猫粮品牌」**（本文件的 `seedMemory` 默认正文是
  //   「猫粮品牌偏好记录」⇒ 若不覆盖，c-d / c-e 会**进文本候选集**
  //   ⇒ 它们就成了候选而不是「只能靠扩散捞到」⇒ 前提自检③失效）。
  seedMemory(db, 'c-d', {
    content: '仓库盘点清单',
    entityIds: ['e-6'],
    rank: 3,
  });
  insertEdge(db, 'ed-1', 'e-1', 'p-1', 'e-6', 0.8, NOW);

  // ── ② 共激活 + 簇（簇跳）：c-a ↔ c-d 同属簇 c-1 ⇒ 簇跳那条腿也能捞到 c-d ──
  insertCoact(db, 'c-a', 'c-d', 0.75, NOW);
  insertCluster(db, 'c-1', ['c-a', 'c-d']);

  // ── ③ 专属路径：c-e 只由 c-b 触达（e-5 → e-7）⇒ 种子口径漂移 ⇒ c-e 消失 ──
  seedMemory(db, 'c-e', {
    content: '货架清单',
    entityIds: ['e-7'],
    rank: 4,
  });
  insertEdge(db, 'ed-2', 'e-5', 'p-2', 'e-7', 0.8, NOW);
}

/**
 * ★ **攻击面 E 的「深世界」夹具**：**被抑制的候选自己出现在 `diffused` 里**。
 *
 * ⚠️ ★ **为什么需要这一份夹具**（`seedDiffusionWorld` 抓不到的那一类变异）：
 *   `seedDiffusionWorld` 里，被抑制的是 `c-b`，而 `diffused` 里是 `c-d` / `c-e`
 *   ⇒ **两者不相交** ⇒ 「抑制直接过滤 diffused」这类变异**不可观测**（M-E2 打不红）。
 *   ⇒ 本夹具构造出「**同一条记忆既在 `suppressed` 里、又在 `diffused` 里**」的世界：
 *   ```
 *   A（rank 0，实体 e1/e2）── 冗余源
 *   B（rank 1，实体 e1/e2/e3）── 与 A 冗余 ⇒ **被抑制**；但它是**抑制前的种子**
 *   C（rank 2，实体 e1/e2/e8）── 与 A 冗余 ⇒ **被抑制**；**且**与 B 同簇共激活 ⇒ 由 B 触达
 *   D（rank 3，实体 e7）──── 与谁都不冗余 ⇒ 留在 hits
 *   ```
 *   · **种子取「抑制前」的 topN**（§4.14.2）⇒ `topN = 2` 时种子 = `[A, B]`
 *     ⇒ **B 虽然被抑制，仍然是种子** ⇒ B 的簇跳路径能捞到 **C**。
 *   ⇒ **C 同时出现在 `suppressed`（被抑制）与 `diffused`（扩散唤起）里**
 *     ⇒ 任何「抑制影响 diffused」的变异（无论是从**种子口径**还是从**直接过滤**）
 *     **都会立刻把这条断言打红**。
 *
 * ⚠️ **为什么这条比 `seedDiffusionWorld` 更强**：
 *   §4.13.1③ 的字面要求是「抑制只作用于 hits」⇒ **被抑制的记忆不该出现在 diffused 里**
 *   ——反过来说，**它出现了也不该被抑制机制动一下**。
 *   ⇒ 抑制开 / 关两次的 `diffused` 必须**逐条相同**，包括那条「既被抑制又被唤起」的 C。
 */
function seedSuppressedAlsoDiffusedWorld(db: Database.Database): void {
  seedMemory(db, 'w-a', { entityIds: ['e-1', 'e-2'], rank: 0 });
  // ⚠️ **w-b 多了实体 e-3** ⇒ 它有一条**别人没有**的路径（边 e-3 → e-8）⇒ C 只能由它触达。
  seedMemory(db, 'w-b', { entityIds: ['e-1', 'e-2', 'e-3'], rank: 1 });
  seedMemory(db, 'w-c', { entityIds: ['e-1', 'e-2', 'e-8'], rank: 2 });
  seedMemory(db, 'w-d', { entityIds: ['e-7'], rank: 3 });
  // ── 边（实体跳）：只有 w-b 有 e-3 ⇒ w-c 只能由 w-b 触达 ──
  insertEdge(db, 'ed-w1', 'e-3', 'p-w1', 'e-8', 0.8, NOW);
  // ── 共激活 + 簇（簇跳）：w-b ↔ w-c 同簇 ⇒ 簇跳那条腿也能捞到 w-c ──
  insertCoact(db, 'w-b', 'w-c', 0.75, NOW);
  insertCluster(db, 'c-w', ['w-b', 'w-c']);
}

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 A · `poolHomogeneous` 必须是**池级前置固定**（§4.13.3）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·A · poolHomogeneous 的池级前置语义（§4.13.3）', () => {
  it('A1 · 池级判定**不随 R 的增长重算**：C0 与 c1 冗余、c2 不冗余 ⇒ 池级为假、c1 让位、c2 进 R', () => {
    // ── 夹具 ──
    const pool = [
      candidate('c0', 1.0, ['e1', 'e2']),
      candidate('c1', 0.9, ['e1', 'e2']),
      candidate('c2', 0.8, ['other']),
    ];

    // ── 前提自检（**不成立就说明夹具废了**）──
    expect(redundancyEvidence(pool[1]!, pool[0]!).sharedEntities).toBeGreaterThanOrEqual(
      DEFAULT_PARAMS.DEDUP_ENTITY_MIN,
    );
    expect(redundancyEvidence(pool[2]!, pool[0]!).sharedEntities).toBeLessThan(
      DEFAULT_PARAMS.DEDUP_ENTITY_MIN,
    );
    expect(redundancyEvidence(pool[2]!, pool[0]!).cosine).toBeNull();

    // ── 断言 ──
    const outcome = inhibitCandidates(pool, 5, DEFAULT_PARAMS);
    expect(outcome.poolHomogeneous).toBe(false);
    expect(outcome.kept.map((item) => item.id)).toEqual(['c0', 'c2']);
    expect(outcome.redundant.map((entry) => entry.candidate.id)).toEqual(['c1']);
    expect(outcome.overflow).toHaveLength(0);
  });

  it('A2 · ★ 区分「poolHomogeneous 路径」与「逐对判冗余路径」：C0 与其余每条都冗余、但其余彼此不冗余 ⇒ 全部进 hits', () => {
    // ⚠️ **余弦构造**：c0 与 c1/c2 都高度相似（cos ≥ REDUNDANCY_COS），
    //   而 c1 与 c2 彼此**不**相似（cos < REDUNDANCY_COS）。
    //   ⇒ poolHomogeneous = 真；⇒ 若实现误走逐对路径，c1/c2 会被误杀 ⇒ hits 变短。
    const pool = [
      candidate('c0', 1.0, ['u0'], [1, 0, 0]),
      candidate('c1', 0.9, ['u1'], [0.95, 0.3, 0]),
      candidate('c2', 0.8, ['u2'], [0.95, -0.3, 0]),
    ];

    // ── 前提自检：C0↔c1、C0↔c2 冗余；c1↔c2 **不**冗余（**两条路径都判**）──
    for (const other of [pool[1]!, pool[2]!]) {
      const evidence = redundancyEvidence(other, pool[0]!);
      expect(evidence.cosine ?? 0).toBeGreaterThanOrEqual(DEFAULT_PARAMS.REDUNDANCY_COS);
      expect(evidence.sharedEntities).toBeLessThan(DEFAULT_PARAMS.DEDUP_ENTITY_MIN);
    }
    const between = redundancyEvidence(pool[1]!, pool[2]!);
    expect(between.cosine ?? 0).toBeLessThan(DEFAULT_PARAMS.REDUNDANCY_COS);
    expect(between.sharedEntities).toBeLessThan(DEFAULT_PARAMS.DEDUP_ENTITY_MIN);

    // ── 断言：整池同质 ⇒ **不抑制**（没有替代品）⇒ 全部进 hits ──
    const outcome = inhibitCandidates(pool, 3, DEFAULT_PARAMS);
    expect(outcome.poolHomogeneous).toBe(true);
    expect(outcome.kept.map((item) => item.id)).toEqual(['c0', 'c1', 'c2']);
    expect(outcome.redundant).toHaveLength(0);
    expect(outcome.overflow).toHaveLength(0);
  });

  it('A3 · 候选池为空 ⇒ poolHomogeneous 为真、三个桶都空', () => {
    const outcome = inhibitCandidates([], 5, DEFAULT_PARAMS);
    expect(outcome.poolHomogeneous).toBe(true);
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.redundant).toHaveLength(0);
    expect(outcome.overflow).toHaveLength(0);
  });

  it('A5 · ★ 候选池**只有一条** ⇒ poolHomogeneous 恒为真（「除 C0 外每一条都冗余」在空集上是**空真**）', () => {
    // ⚠️ **为什么这一条不可省**：C0 若「与自己比」，`isRedundant(C0, C0)` 的结果取决于
    //   C0 **自己**是否自冗余（向量 ⇒ cos=1；实体 ⇒ |E| 个共享实体）。
    //   ⇒ 只有当 **C0 既无向量、实体又不足 DEDUP_ENTITY_MIN** 时，「与自己比」才会把它变成**假**。
    //   ⇒ **只有本夹具**能观测到「C0 参与比较」与「C0 不参与比较」的差别。
    const outcome = inhibitCandidates([candidate('c0', 1.0, ['e1'])], 5, DEFAULT_PARAMS);

    // ── 前提自检：C0 确实**不自冗余**（无向量 + 实体不足 2）──
    const self = redundancyEvidence(candidate('c0', 1.0, ['e1']), candidate('c0', 1.0, ['e1']));
    expect(self.cosine).toBeNull();
    expect(self.sharedEntities).toBeLessThan(DEFAULT_PARAMS.DEDUP_ENTITY_MIN);
    expect(isRedundant(self, DEFAULT_PARAMS)).toBe(false);

    // ── 断言：空集上的「每一条都冗余」是**空真** ⇒ poolHomogeneous = true ──
    expect(outcome.poolHomogeneous).toBe(true);
    expect(outcome.kept.map((item) => item.id)).toEqual(['c0']);
  });

  it('A4 · 不变式：`hits.length >= min(topN, min(2,|C|))` 且 `<= min(topN,|C|)`（**逐轮显式复算前提**）', () => {
    // ⚠️ **前提**：本条断言**恒成立**（它是实现的构造性质）⇒ 它的价值在于**约束变异**，
    //   不在于「区分路径」。⇒ 下面额外断言「三桶合起来恰好是全部候选」——**这条会随分桶错误而变**。
    const pools: Array<{ pool: InhibitionCandidate[]; topN: number }> = [
      { pool: [candidate('m0', 1, ['a', 'b'])], topN: 3 },
      { pool: [candidate('m0', 1, ['a', 'b']), candidate('m1', 0.9, ['a', 'b'])], topN: 2 },
      {
        pool: [
          candidate('m0', 1, ['a', 'b']),
          candidate('m1', 0.9, ['a', 'b']),
          candidate('m2', 0.8, ['x']),
          candidate('m3', 0.7, ['y']),
        ],
        topN: 2,
      },
    ];
    for (const { pool, topN } of pools) {
      const outcome = inhibitCandidates(pool, topN, DEFAULT_PARAMS);
      expect(outcome.kept.length).toBeGreaterThanOrEqual(Math.min(topN, Math.min(2, pool.length)));
      expect(outcome.kept.length).toBeLessThanOrEqual(Math.min(topN, pool.length));
      expect(outcome.kept.length + outcome.redundant.length + outcome.overflow.length).toBe(
        pool.length,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 B · 排序键必须带 id（全序）（§4.13.3 / §4.13.5）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·B · 全序（score DESC, id ASC）与两份拷贝的等价（§4.13.3）', () => {
  it('B1 · 纯算法层：同分候选按 **id 字典序**排（**id 字典序与插入序相反** ⇒ 抓不到就会恒绿）', () => {
    // ⚠️ 插入序 z → y → x，而 id 字典序是 x < y < z ⇒ **两者相反**。
    //   ⇒ 若 tiebreak 缺失（只按 score），稳定排序会保留插入序 z,y,x ⇒ 断言变红。
    const pool = [
      candidate('m-z', 0.5, ['e1']),
      candidate('m-y', 0.5, ['e2']),
      candidate('m-x', 0.5, ['e3']),
    ];

    // ── 前提自检：三条**确实同分**（否则 tiebreak 根本不参与）──
    expect(new Set(pool.map((item) => item.score)).size).toBe(1);

    // ── 断言 ──
    const outcome = inhibitCandidates(pool, 3, DEFAULT_PARAMS);
    expect(outcome.kept.map((item) => item.id)).toEqual(['m-x', 'm-y', 'm-z']);
  });

  it('B2 · ★ 集成层：`recall` 的 hits 顺序与 `inhibitionTrace` 的 selected 顺序**逐条相同**（同分 + id 与插入序相反）', () => {
    // ⚠️ 这条断言**专门抓「两份拷贝漂移」**：
    //   `src/neuron/inhibit.ts` 与 `src/store/recall.ts` 各写了一份排序。
    //   若两份的 tiebreak 方向不一致 ⇒ recall 的 hits 顺序与 trace 的 selected 顺序会漂移。
    const { db, store } = makeStore();
    // 插入序：m-b → m-a（**与 id 字典序相反**）；正文 / 时间戳 / 实体结构完全相同 ⇒ **分数逐位相同**。
    seedMemory(db, 'm-b', { entityIds: ['e-1'], rank: 0 });
    seedMemory(db, 'm-a', { entityIds: ['e-2'], rank: 0 });

    const result = recall(store, { context: '猫粮品牌', now: NOW });
    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    // ── 前提自检：**确实同分**（否则 tiebreak 不参与 ⇒ 断言恒绿）──
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.score).toBe(result.hits[1]?.score);

    // ── 断言 ──
    expect(result.hits.map((hit) => hit.id)).toEqual(['m-a', 'm-b']);
    expect(trace.selected.map((item) => item.id)).toEqual(result.hits.map((hit) => hit.id));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 C · O 桶不得混进 D 桶（§4.13.3）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·C · 三桶分离：溢出候选不得被标成「被挤掉的」（§4.13.3）', () => {
  it('C1 · ★ 候选数 > topN 时：`suppressed` **只**含真正冗余的那条、且每条的 redundantWith 都在 hits 里', () => {
    const { db, store } = makeStore();
    // c-a / c-b 共享两个实体 ⇒ 真冗余；其余四条**不**冗余 ⇒ 必然进溢出桶（|C|=6 > topN=2）。
    seedMemory(db, 'c-a', { entityIds: ['e-1', 'e-2'], rank: 0 });
    seedMemory(db, 'c-b', { entityIds: ['e-1', 'e-2'], rank: 1 });
    for (let index = 0; index < 4; index += 1) {
      seedMemory(db, `c-x${index}`, { entityIds: [`u-${index}`], rank: 2 + index });
    }

    const result = recall(store, { context: '猫粮品牌', topN: 2, now: NOW });

    // ── 前提自检：**确实有溢出候选**（|C| = 6 > topN = 2 ⇒ 至少 3 条溢出）──
    expect(result.hits).toHaveLength(2);
    expect(result.suppressed).toHaveLength(1);
    // ⚠️ 前提：**被抑制的那条确实参与过评估** ⇒ 它有合法的 redundantWith。
    const suppressedIds = result.suppressed.map((item) => item.id);
    expect(suppressedIds).toEqual(['c-b']);

    // ── 断言 ──
    // ① 条数：只有真冗余的一条进 suppressed（若 O 桶混进来 ⇒ 变成 5 条）
    expect(result.suppressed).toHaveLength(1);
    // ② 每一条的 redundantWith 都**留在 hits 里**（O 桶根本没有合法的 redundantWith）
    for (const item of result.suppressed) {
      expect(item.redundantWith).toBeDefined();
      expect(result.hits.map((hit) => hit.id)).toContain(item.redundantWith);
    }
    // ③ reason 只有 'redundant'（溢出候选没有合法标注 ⇒ 不该进来）
    expect(result.suppressed.every((item) => item.reason === 'redundant')).toBe(true);
  });

  it('C2 · ★ `inhibitionTrace`：溢出候选**没有** redundantWith、**不**标 inhibited（候选数 > topN）', () => {
    const { db, store } = makeStore();
    seedMemory(db, 'c-a', { entityIds: ['e-1', 'e-2'], rank: 0 });
    seedMemory(db, 'c-b', { entityIds: ['e-1', 'e-2'], rank: 1 });
    for (let index = 0; index < 5; index += 1) {
      seedMemory(db, `c-x${index}`, { entityIds: [`u-${index}`], rank: 2 + index });
    }

    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    // ── 前提自检：**确实存在溢出候选**（既没被选中、也没被抑制）──
    const selectedIds = new Set(trace.selected.map((item) => item.id));
    const overflow = trace.candidates.filter(
      (item) => !item.inhibited && !selectedIds.has(item.id),
    );
    expect(overflow.length).toBeGreaterThan(0);
    expect(trace.candidates.filter((item) => item.inhibited)).toHaveLength(1);

    // ── 断言 ──
    for (const item of overflow) {
      expect(item.redundantWith).toBeUndefined();
      expect(item.inhibited).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 D · 三条硬约束里的两条：抑制不进 score / 抑制不写库（§4.13.1）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·D · 硬约束①（抑制不进 score）与②（抑制不写库）（§4.13.1）', () => {
  it('D1 · ★ 抑制开 / 抑制关两次召回：**每一条候选的分数逐位相同**（含 hits 与 suppressed）', () => {
    const on = makeStore();
    seedRedundantPair(on.db);
    const off = makeStore({ inhibition: false });
    seedRedundantPair(off.db);

    const withInhibition = recall(on.store, { context: '猫粮品牌', now: NOW });
    const withoutInhibition = recall(off.store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检：**抑制确实发生了**（否则「分数没变」是空洞的）──
    expect(withInhibition.suppressed).toHaveLength(1);
    expect(withInhibition.hits.length).toBeLessThan(withoutInhibition.hits.length);

    // ── 断言：逐位比较**每一条候选**的分数 ──
    const scoresOn = new Map<string, number>([
      ...withInhibition.hits.map((hit) => [hit.id, hit.score] as const),
      ...withInhibition.suppressed.map((item) => [item.id, item.score] as const),
    ]);
    const scoresOff = new Map<string, number>([
      ...withoutInhibition.hits.map((hit) => [hit.id, hit.score] as const),
      ...withoutInhibition.suppressed.map((item) => [item.id, item.score] as const),
    ]);
    expect(scoresOn.size).toBe(3);
    expect(scoresOff.size).toBe(3);
    for (const [id, score] of scoresOff) {
      expect(scoresOn.get(id)).toBe(score);
    }
  });

  it('D2 · ★ 抑制前后 `memories` / `memory_entities` / `events` 三张表的**内容哈希**完全相同', () => {
    const { db, store } = makeStore();
    seedRedundantPair(db);

    const before = {
      memories: tableHash(db, 'memories', 'id'),
      memoryEntities: tableHash(db, 'memory_entities', 'memory_id, entity_id'),
      events: tableHash(db, 'events', 'id'),
    };

    const result = recall(store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检：**抑制确实发生了**（否则「哈希没变」是空洞的）──
    expect(result.suppressed).toHaveLength(1);

    // ── 断言（**哈希口径含行数 + 全部列的内容** ⇒ 内容被改必被抓到）──
    expect(tableHash(db, 'memories', 'id')).toBe(before.memories);
    expect(tableHash(db, 'memory_entities', 'memory_id, entity_id')).toBe(before.memoryEntities);
    expect(tableHash(db, 'events', 'id')).toBe(before.events);
  });

  it('D3 · `inhibitionTrace` 纯读：三张表的哈希与事件条数都不变', () => {
    const { db, store } = makeStore();
    seedRedundantPair(db);

    const before = {
      memories: tableHash(db, 'memories', 'id'),
      memoryEntities: tableHash(db, 'memory_entities', 'memory_id, entity_id'),
      events: tableHash(db, 'events', 'id'),
    };

    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    // ── 前提自检：trace 真的算出了抑制诊断 ──
    expect(trace.candidates.length).toBeGreaterThan(0);
    expect(trace.candidates.filter((item) => item.inhibited)).toHaveLength(1);

    // ── 断言 ──
    expect(tableHash(db, 'memories', 'id')).toBe(before.memories);
    expect(tableHash(db, 'memory_entities', 'memory_id, entity_id')).toBe(before.memoryEntities);
    expect(tableHash(db, 'events', 'id')).toBe(before.events);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 E · 抑制只作用于 hits，不作用于 diffused（§4.13.1③）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·E · 抑制不得过滤 diffused（§4.13.1③）', () => {
  it('E1 · ★ 抑制开 / 关两次召回的 `diffused` **逐条相同**（**本轮已从恒绿守卫升级为真守卫**）', () => {
    // ⚠️ ★ **本轮（P3-T06）的关键升级**：P3-T02 写下这条时 `diffused` **恒为空数组**
    //   （联想路未实现）⇒ 它是一条**恒绿守卫**（什么都能通过）⇒ **证明不了**
    //   「抑制没碰 diffused」。
    //   ⇒ P3-T04 把 `diffused` 接成非空之后，QA 用**有边 + 有共激活 + 有簇**的
    //   夹具（`seedDiffusionWorld`）把这条断言**重新变成真守卫**。
    const on = makeStore();
    seedDiffusionWorld(on.db);
    const off = makeStore({ inhibition: false });
    seedDiffusionWorld(off.db);

    const withInhibition = recall(on.store, { context: '猫粮品牌', now: NOW });
    const withoutInhibition = recall(off.store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检①：**抑制确实发生了**（否则这条对比是空洞的）──
    expect(withInhibition.suppressed).toHaveLength(1);
    expect(withInhibition.suppressed[0]?.id).toBe('c-b');
    expect(withInhibition.hits.length).toBeLessThan(withoutInhibition.hits.length);

    // ── 前提自检② ★：**扩散确实产出了东西**（这正是 P3-T02 留的那笔账）──
    //   ⚠️ **没有这一条，E1 就是恒绿守卫** ⇒ 本条是 E1 的**存在前提**。
    expect(withInhibition.diffused.length).toBeGreaterThan(0);
    expect(withoutInhibition.diffused.length).toBeGreaterThan(0);

    // ── 前提自检③ ★：**其中有一条只由「被抑制的那条种子」（c-b）触达得到**（c-e）──
    //   ⚠️ ★ **这是「E1 不是恒绿守卫」的决定性证据**：
    //   种子口径一旦从「抑制前 topN」漂移到「抑制后 hits」，c-b 被挤掉
    //   ⇒ c-e 从 `diffused` 里消失 ⇒ **这条断言立刻变红**。
    expect(withInhibition.diffused.map((item) => item.id).sort()).toEqual(['c-d', 'c-e']);
    expect(withoutInhibition.diffused.map((item) => item.id).sort()).toEqual(['c-d', 'c-e']);

    // ── 前提自检④ ★：**两条腿都真的产出**（实体跳 + 簇跳）⇒ 夹具不是「只有一半通」──
    //   c-d **同时**被实体跳（e-1 → e-6，bonus 0.2）与簇跳（c-a ↔ c-d 同簇，
    //   bonus = CLUSTER_BONUS 0.4 × affinity_eff 0.75 = 0.3）捞到
    //   ⇒ **合并取 max** ⇒ 簇跳那条腿更强 ⇒ `viaClusterId` 有值。
    const viaDiffused = withInhibition.diffused.find((item) => item.id === 'c-d');
    expect(viaDiffused?.viaClusterId).toBe('c-1');
    expect(viaDiffused?.viaEntity).toBeUndefined();
    //   ⚠️ **分数逐位核对**：合并分 = max(0.2, 0.3) = 0.3（**不是** 0.5 的相加）
    //   ⇒ 这一条同时钉住「两腿合并取 max」（§4.14.4 约束⑥）。
    expect(viaDiffused?.diffusionScore).toBeCloseTo(0.3, 12);
    //   c-e 只被 c-b 的专属路径（e-5 → e-7）触达 ⇒ 它走的是**实体跳**那条腿。
    const viaExclusive = withInhibition.diffused.find((item) => item.id === 'c-e');
    expect(viaExclusive?.viaEntity).toBe('e-7');
    expect(viaExclusive?.viaClusterId).toBeUndefined();
    expect(viaExclusive?.diffusionScore).toBeCloseTo(0.2, 12);

    // ── 断言：**逐条相同**（不只是条数相同）—— 抑制既不改内容，也不改顺序。──
    expect(withInhibition.diffused.length).toBe(withoutInhibition.diffused.length);
    expect(withInhibition.diffused).toEqual(withoutInhibition.diffused);
  });

  it('E2 · ★ ★ **深世界**：一条**既被抑制、又被扩散唤起**的记忆 ⇒ 抑制开 / 关的 `diffused` 仍逐条相同', () => {
    // ⚠️ ★ **为什么必须有这一条**（`E1` 抓不到的那一类变异）：
    //   `E1` 的世界里被抑制的是 `c-b`，`diffused` 里是 `c-d` / `c-e` ⇒ **两者不相交**
    //   ⇒ 「抑制**直接过滤** diffused」这类变异在 `E1` 的世界里**不可观测**。
    //   ⇒ 本用例构造出「**同一条记忆既在 `suppressed` 里、又在 `diffused` 里**」的世界。
    const on = makeStore();
    seedSuppressedAlsoDiffusedWorld(on.db);
    const off = makeStore({ inhibition: false });
    seedSuppressedAlsoDiffusedWorld(off.db);

    // ⚠️ **`topN = 2`** ⇒ 抑制前的 topN = [w-a, w-b] ⇒ **w-b 是种子**
    //   （尽管它随后被抑制）⇒ w-c 能由 w-b 的簇跳路径捞到。
    const withInhibition = recall(on.store, { context: '猫粮品牌', topN: 2, now: NOW });
    const withoutInhibition = recall(off.store, { context: '猫粮品牌', topN: 2, now: NOW });

    // ── 前提自检①：**抑制确实发生了**（w-b 与 w-c 都被挤掉）──
    expect(withInhibition.suppressed.map((item) => item.id).sort()).toEqual(['w-b', 'w-c']);
    // ── 前提自检②：**抑制关时一条都没被挤掉** ──
    expect(withoutInhibition.suppressed).toHaveLength(0);

    // ── 前提自检③ ★：**被抑制的那条记忆确实出现在 `diffused` 里** ──
    //   ⚠️ ★ **这是本用例的存在前提**：若 w-c 不在 `diffused` 里，
    //   则「抑制直接过滤 diffused」这类变异**打不红** ⇒ 本用例会退化成恒绿守卫。
    const diffusedIds = withInhibition.diffused.map((item) => item.id);
    expect(diffusedIds).toContain('w-c');
    expect(withInhibition.suppressed.map((item) => item.id)).toContain('w-c');

    // ── 前提自检④：**抑制开 / 关两次的 hits 集合确实不同**（否则「没变」证明不了任何事）──
    expect(withInhibition.hits.map((hit) => hit.id).sort()).not.toEqual(
      withoutInhibition.hits.map((hit) => hit.id).sort(),
    );

    // ── 断言：**逐条相同**（含那条「既被抑制又被唤起」的 w-c）──
    expect(withInhibition.diffused).toEqual(withoutInhibition.diffused);
    // ⚠️ **逐字段**再比一次（不只看 id 序列）：分数 / viaEntity / viaClusterId 都要一样。
    expect(withInhibition.diffused.map((item) => item.diffusionScore)).toEqual(
      withoutInhibition.diffused.map((item) => item.diffusionScore),
    );
    expect(withInhibition.diffused.map((item) => item.viaClusterId ?? null)).toEqual(
      withoutInhibition.diffused.map((item) => item.viaClusterId ?? null),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 F · 机制开关与 v1.0 逐位一致（§5 / §4.13.3）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·F · `inhibition` 机制开关（§5）', () => {
  it('F1 · ★ 开关关 ⇒ 候选带**不重排**：hits 恰是全部候选按 base 分降序、suppressed 为空', () => {
    const on = makeStore();
    seedRedundantPairReversedIds(on.db);
    const off = makeStore({ inhibition: false });
    seedRedundantPairReversedIds(off.db);

    const withInhibition = recall(on.store, { context: '猫粮品牌', now: NOW });
    const withoutInhibition = recall(off.store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检：**开关开时抑制确实改变了结果**（否则「关时没变」证明不了任何事）──
    expect(withInhibition.suppressed).toHaveLength(1);
    expect(withInhibition.hits.length).toBeLessThan(withoutInhibition.hits.length);

    // ── 断言 ──
    expect(withoutInhibition.suppressed).toHaveLength(0);
    expect(withoutInhibition.hits).toHaveLength(3);
    // ★ 顺序**纯按分数降序**（不重排）
    // ⚠️ **id 字典序必须与分数序相反**（m-c 分最高、m-a 分最低）⇒
    //   「按 id 排」与「按分数排」在结果上**不可区分** ⇒ 这条断言就抓不到「关时仍重排」。
    const ids = withoutInhibition.hits.map((hit) => hit.id);
    expect(ids).toEqual(['m-c', 'm-b', 'm-a']);
    const scores = withoutInhibition.hits.map((hit) => hit.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it('F2 · 开关关 ⇒ `suppressedIds` 为空、事件里的 hitIds 就是全部候选', () => {
    const { db, store } = makeStore({ inhibition: false });
    seedRedundantPairReversedIds(db);

    const result = recall(store, { context: '猫粮品牌', explain: true, now: NOW });
    const rows = db.prepare("SELECT payload FROM events WHERE type = 'recall'").all() as Array<{
      payload: string;
    }>;
    const payload = JSON.parse(rows[0]?.payload ?? '{}') as {
      hitIds: string[];
      suppressedIds: string[];
    };

    // ── 前提自检：事件确实写了 ──
    expect(rows).toHaveLength(1);

    // ── 断言 ──
    expect(result.suppressed).toHaveLength(0);
    expect(payload.suppressedIds).toEqual([]);
    expect(payload.hitIds).toEqual(result.hits.map((hit) => hit.id));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 G · 判据是纯逐对，**簇不参与**（§4.13.2）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·G · 簇不参与判定（§4.13.2）', () => {
  it('G1 · ★ 同簇但**逐对不冗余**的一对**不得**被判冗余；且同夹具里 D 桶**非空**（前提：抑制确实在跑）', () => {
    const { db, store } = makeStore();
    // c-a 与 c-c 共享两个实体 ⇒ **真冗余**（D 桶非空 ⇒ 抑制确实在跑）。
    seedMemory(db, 'c-a', { entityIds: ['e-1', 'e-9'], embedding: [1, 0], rank: 0 });
    // c-b 与 c-a **同簇**，但实体交集为 0、余弦为 0 ⇒ **逐对不冗余**。
    seedMemory(db, 'c-b', { entityIds: ['e-2'], embedding: [0, 1], rank: 1 });
    // c-c 与 c-a 共享 e-1 + e-9 ⇒ 真冗余；与 c-b 交集为 0 ⇒ 不是被 c-b 冗余的。
    seedMemory(db, 'c-c', { entityIds: ['e-1', 'e-9'], embedding: [0, 1, 0], rank: 2 });

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

    const result = recall(store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检 ①：D 桶**非空** ⇒ 抑制确实在跑（否则「没被判冗余」是空洞的）──
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.id).toBe('c-c');

    // ── 前提自检 ②：c-a 与 c-b 确实**逐对不冗余**（实体交集 < 2 且余弦 < 阈值）──
    //   （由夹具保证：实体集合不相交、向量 [1,0] ⟂ [0,1]）

    // ── 断言：同簇的 c-b **必须留在 hits 里**（簇不参与判定）──
    expect(result.hits.map((hit) => hit.id)).toContain('c-b');
    expect(result.suppressed.map((item) => item.id)).not.toContain('c-b');
  });

  it('G2 · 纯算法层：判据的输入里**根本没有簇**（簇无法参与判定的结构性证据）', () => {
    // ⚠️ **结构性证据**：`InhibitionCandidate` 只有 `id` / `score` / `vector` / `entityIds`
    //   ⇒ 簇**在类型上**就无法进入判据 ⇒ §4.13.2 的「簇不参与判定」是**类型保证**，
    //   不是「靠实现者记得别用簇」。
    const pool = [candidate('c0', 1.0, ['e1', 'e2']), candidate('c1', 0.9, ['e3'])];
    for (const item of pool) {
      expect(Object.keys(item).sort()).toEqual(['entityIds', 'id', 'score', 'vector']);
    }
    // ── 断言：c1 与 c0 不冗余（无共享实体、无向量）──
    expect(isRedundant(redundancyEvidence(pool[1]!, pool[0]!), DEFAULT_PARAMS)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 H · `isRedundant` 的两条路径（§4.13.2）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·H · 冗余判据的两条路径（§4.13.2）', () => {
  it('H1 · ★ 语义路径的阈值**取自 params**（不是写死 0.9）：把 REDUNDANCY_COS 调高 ⇒ 原本冗余的一对不再冗余', () => {
    const left = candidate('a', 1.0, [], [1, 0]);
    const right = candidate('b', 0.9, [], [0.93, 0.36]);
    const evidence = redundancyEvidence(left, right);

    // ── 前提自检：余弦落在两个阈值**之间**（0.90 与 0.95 之间）⇒ 阈值一动结论就翻转 ──
    expect(evidence.cosine ?? 0).toBeGreaterThanOrEqual(DEFAULT_PARAMS.REDUNDANCY_COS);
    expect(evidence.cosine ?? 0).toBeLessThan(0.95);
    expect(evidence.sharedEntities).toBe(0);

    // ── 断言：阈值取自 params ──
    expect(isRedundant(evidence, DEFAULT_PARAMS)).toBe(true);
    expect(
      isRedundant(evidence, { ...DEFAULT_PARAMS, REDUNDANCY_COS: 0.95, DEDUP_COS_MIN: 0.99 }),
    ).toBe(false);
  });

  it('H2 · ★ 实体路径**不依赖 embedding**：双方都没有向量时，共享实体达阈值仍判冗余', () => {
    const left = candidate('a', 1.0, ['e1', 'e2'], null);
    const right = candidate('b', 0.9, ['e1', 'e2'], null);
    const evidence = redundancyEvidence(left, right);

    // ── 前提自检：真的**没有**余弦这个事实（不是「余弦为 0」）──
    expect(evidence.cosine).toBeNull();
    expect(evidence.sharedEntities).toBe(DEFAULT_PARAMS.DEDUP_ENTITY_MIN);

    // ── 断言 ──
    expect(isRedundant(evidence, DEFAULT_PARAMS)).toBe(true);
  });

  it('H3 · 集成层：**整库一条向量都没有**时，实体路径仍让抑制生效', () => {
    const { db, store } = makeStore();
    seedRedundantPair(db);

    // ── 前提自检：库里**确实一条向量都没有**（语义路径整条不可用）──
    const embedded = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL')
      .get() as { n: number };
    expect(embedded.n).toBe(0);

    const result = recall(store, { context: '猫粮品牌', now: NOW });

    // ── 断言 ──
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.redundantWith).toBeDefined();
  });

  it('H4 · ★（可观测性缺口·实测留证）实体路径触发的冗余对：`redundancySim` **存在但低于 REDUNDANCY_COS**', () => {
    // ⚠️ **这不是缺陷断言，是「现状留证」**：§6 的 `RecallSuppressed.redundancySim`
    //   只写「该冗余对的相似度（0~1）」，**没有 basis 字段** ⇒
    //   消费方单看这个字段**判不出**「它是被判冗余的依据」。
    const { db, store } = makeStore();
    // 双方**都有向量**，但余弦为 0（⟂）；共享实体 2 个 ⇒ 冗余**只**可能来自实体路径。
    seedMemory(db, 'c-a', { entityIds: ['e-1', 'e-2'], embedding: [1, 0], rank: 0 });
    seedMemory(db, 'c-b', { entityIds: ['e-1', 'e-2'], embedding: [0, 1], rank: 1 });
    seedMemory(db, 'c-c', { entityIds: ['e-3', 'e-4'], embedding: [0, 1, 0], rank: 2 });

    const result = recall(store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检：冗余**确实**来自实体路径（余弦远低于阈值）──
    expect(result.suppressed).toHaveLength(1);
    const suppressed = result.suppressed[0];
    expect(suppressed?.id).toBe('c-b');

    // ── 断言（现状）──
    expect(suppressed?.redundancySim).toBeDefined();
    expect(suppressed?.redundancySim ?? 1).toBeLessThan(DEFAULT_PARAMS.REDUNDANCY_COS);
    // ⚠️ **对照**：双方都无向量时，该键**整个不出现**（=「没有可比的相似度」）⇒
    //   「键缺失」是一个可用的信号；「键存在但低于阈值」才是那个歧义点。
    const noVector = makeStore();
    seedRedundantPair(noVector.db);
    const withoutVectors = recall(noVector.store, { context: '猫粮品牌', now: NOW });
    expect(withoutVectors.suppressed[0]?.redundancySim).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 I · 参数硬约束（§4.13.4）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·I · 参数硬约束 `0 < REDUNDANCY_COS <= DEDUP_COS_MIN`（§4.13.4）', () => {
  /** 内存后端：模拟**带事务**的存储（抛错 ⇒ 回滚）。 */
  class FakeBackend implements ParamsBackend {
    params: Params = DEFAULT_PARAMS;
    readonly events: unknown[] = [];
    writeCount = 0;
    readParams(): Params {
      return this.params;
    }
    writeParams(params: Params): void {
      this.params = params;
      this.writeCount += 1;
    }
    appendEvent(..._args: never[]): void {
      this.events.push(_args);
    }
    transaction<T>(fn: () => T): T {
      const snapshot = this.params;
      const eventSnapshot = [...this.events];
      const writeSnapshot = this.writeCount;
      try {
        return fn();
      } catch (error) {
        this.params = snapshot;
        this.events.length = 0;
        this.events.push(...eventSnapshot);
        this.writeCount = writeSnapshot;
        throw error;
      }
    }
  }

  it('I1 · ★ `REDUNDANCY_COS > DEDUP_COS_MIN` ⇒ 抛 INVALID_INPUT，且**一个参数都不落库**', () => {
    const backend = new FakeBackend();
    const store = new ParamStore(backend);

    // ── 前提自检：默认取值本身**合法**（0.90 ≤ 0.92）⇒ 失败确实来自这次越界写入 ──
    expect(DEFAULT_PARAMS.REDUNDANCY_COS).toBeLessThanOrEqual(DEFAULT_PARAMS.DEDUP_COS_MIN);

    // ── 断言 ──
    expect(() => store.setParams({ REDUNDANCY_COS: 0.95 })).toThrow(MemoryError);
    expect(backend.writeCount).toBe(0);
    expect(backend.events).toHaveLength(0);
    expect(backend.params).toEqual(DEFAULT_PARAMS);
    expect(backend.params.REDUNDANCY_COS).toBe(0.9);
  });

  it('I2 · 越界值的建议值是**动态上界**（`maxAllowed` = 当前的 DEDUP_COS_MIN）', () => {
    // ── 前提自检：DEDUP_COS_MIN 可调 ⇒ 上界必须跟着动（§5 的原文要求）──
    const error = (() => {
      try {
        applyParamPatch({ ...DEFAULT_PARAMS, DEDUP_COS_MIN: 0.93 }, { REDUNDANCY_COS: 0.98 });
        return undefined;
      } catch (caught) {
        return caught as MemoryError;
      }
    })();
    expect(error).toBeInstanceOf(MemoryError);
    const details = error?.details as {
      REDUNDANCY_COS: { current: number; maxAllowed?: number; reason: string };
    };
    expect(details.REDUNDANCY_COS.current).toBe(0.98);
    expect(details.REDUNDANCY_COS.maxAllowed).toBe(0.93);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 攻击面 J · 不变式与 trace 同口径（§4.6 步骤 4.5 / §6）
// ═══════════════════════════════════════════════════════════════════════

describe('QA·J · `inhibitionTrace` 与 `recall` 同口径（§6）', () => {
  it('J1 · ★ trace 的 selected 与 recall 的 hits：**同样的 id 序列、同样的 baseScore（逐位）**', () => {
    const { db, store } = makeStore();
    seedRedundantPair(db);

    const result = recall(store, { context: '猫粮品牌', now: NOW });
    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    // ── 前提自检：抑制确实发生了（否则「同口径」是空洞的）──
    expect(result.suppressed).toHaveLength(1);
    expect(trace.candidates.filter((item) => item.inhibited)).toHaveLength(1);

    // ── 断言 ──
    expect(trace.selected.map((item) => item.id)).toEqual(result.hits.map((hit) => hit.id));
    expect(trace.selected.map((item) => item.baseScore)).toEqual(
      result.hits.map((hit) => hit.score),
    );
  });

  it('J2 · ★ trace 的 baseScore 与 recall 的 Hit.score **逐位相同**（hits 与 suppressed **都要比**）', () => {
    const { db, store } = makeStore();
    seedRedundantPair(db);

    const result = recall(store, { context: '猫粮品牌', now: NOW });
    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    // ── 前提自检：trace 的候选集覆盖了 hits **与** suppressed（否则「只比 hits」是空洞的）──
    const scoreById = new Map<string, number>([
      ...result.hits.map((hit) => [hit.id, hit.score] as const),
      ...result.suppressed.map((item) => [item.id, item.score] as const),
    ]);
    expect(scoreById.size).toBe(3);
    expect(trace.candidates.length).toBe(3);

    // ── 断言：**逐位**（不是 toBeCloseTo）──
    for (const row of trace.candidates) {
      const expected = scoreById.get(row.id);
      expect(expected).toBeDefined();
      expect(row.baseScore).toBe(expected);
    }
  });

  it('J3 · trace 的 candidates 自身按 `(score DESC, id ASC)` 全序排列', () => {
    const { db, store } = makeStore();
    // m-b 先插、m-a 后插（**与 id 字典序相反**）⇒ 顺序断言才不是随机的。
    seedMemory(db, 'm-b', { entityIds: ['e-1'], rank: 0 });
    seedMemory(db, 'm-a', { entityIds: ['e-2'], rank: 0 });

    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    // ── 前提自检：两条**确实同分** ──
    expect(trace.candidates).toHaveLength(2);
    expect(trace.candidates[0]?.baseScore).toBe(trace.candidates[1]?.baseScore);

    // ── 断言 ──
    expect(trace.candidates.map((item) => item.id)).toEqual(['m-a', 'm-b']);
  });

  it('J4 · ★ trace 与 recall **名额同源**（5 条互不冗余 ⇒ 两边都必须是 5 条）', () => {
    const { db, store } = makeStore();
    seedFiveDistinct(db);

    const result = recall(store, { context: '猫粮品牌', now: NOW });
    const trace = inhibitionTrace(store, '猫粮品牌', { now: NOW });

    // ── 前提自检：R 桶确实有 5 条（|C| = 5 > 默认 topN = 5 ⇒ 恰好满额）──
    expect(result.hits).toHaveLength(5);
    expect(trace.selected).toHaveLength(5);

    // ── 断言：两边的**名额**与**内容**必须一致（§6：「经同一个 `clampTopN()` 钳制」）──
    expect(trace.selected.map((item) => item.id)).toEqual(result.hits.map((hit) => hit.id));
  });
});
