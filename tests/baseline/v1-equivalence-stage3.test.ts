/**
 * ★ **阶段 3 新增机制开关的「关掉 ⇒ 与 v1.0 逐位一致」逐开关复验**
 * —— DEVELOPMENT-PLAN.md **P3-T06**（§5 机制开关表 + §4.13.1 + §4.14.5）。
 *
 * ⚠️ **本文件回答的问题**（比「联合基线」更细）：
 *   `tests/baseline/v1-equivalence.test.ts` 已经证明了「**四个开关全关** ⇒ 与 v1.0 逐位一致」
 *   （那是 P1-T09 的第一次达成点）。
 *   ⇒ 但**联合基线**只回答「一起关掉行不行」，
 *   **回答不了**「**单独**关掉某个开关 ⇒ 那条能力**彻底不生效**吗？」
 *   ⇒ 而后者才是「每个开关都能独立当 A/B 对照的基线」的真正含义（§5 的用途栏：
 *   「**A/B 对照的基线开关**」）。
 *
 * ⚠️ ★ **「逐位一致」的口径**（主理人点名：**不是「结果看起来一样」，而是逐字节/逐字段相同**）：
 *   本文件对每个开关给出**一张表**：开关名 / 关掉后的等价对象 / 逐位比对的范围 / 结论。
 *   比对方式：**逐字段 `toBe`（不是 `toBeCloseTo`）** + **表内容哈希**（行数 + 全部列）。
 *
 * ⚠️ ★ **「等价对象」的定义必须逐开关说清**（不能笼统写「与 v1.0 一致」）：
 *   | 开关 | 关掉后**等价于 v1.0 的哪一部分** | 逐位比对的范围 |
 *   |---|---|---|
 *   | `inhibition` | v1.0 的召回：**候选带不重排**，直接按 base 分取 topN | hits 的 id 序列 + 每条的 score + breakdown 五项 + 事件的 hitIds/scores |
 *   | `coactivation` | v1.0：**没有共激活这张表** ⇒ `coacts` 表**不被写入**、联想路**不执行**、**主题簇不计算也不使用** | `coacts` 表内容哈希（前后逐位相同）+ `diffused` 恒空 + 命中序列与事件 + **簇的三张表逐位不变 + 不记 `sweep` 事件 + `clusters()` 返回空** |
 *   | `writeBack` | v1.0：**「扩散唤起 → 采纳 → 回写」的联动不存在** ⇒ `touch` 只加固不写因果边 | `coacts` 表内容哈希 + **无 `cause_flags` bit1 的行** + **普通共激活行（bit0）仍在** + `stability` 仍增长 + 事件的 `stabilityDelta` |
 *   | `ARCHIVAL_CACHE` | v1.0：`countArchived` 走**逐行精筛**（路径不同、结果相同） | **阶段 4 才实现 `countArchived`** ⇒ 本轮只登记「不可验」 |
 *   | `VECTOR_ROUTER='flat'` | v1.0 的向量路（**整路缺席**是阶段 1 的事实） | `fromVector` / `vectorPart` / `cos` |
 *   | `diffuseArchived` | **不是机制开关**（是 `RecallOptions` 字段）⇒ 在 v1.0 里**不存在** | `diffused` 恒空（因 `coactivation=false`）⇒ 逐位一致 |
 *
 * ⚠️ **本文件不碰 `src/**`**（QA 的边界）⇒ 只**观测**行为，不改行为。
 */

import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { intensity, layerOf } from '../../src/core/decay.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { tokenize } from '../../src/core/tokenize.js';
import { createSchema } from '../../src/db/connection.js';
import { clusters, recluster } from '../../src/store/clusters.js';
import { EventWriter } from '../../src/store/events.js';
import { recall } from '../../src/store/recall.js';
import { touch } from '../../src/store/touch.js';
import { MemoryLogger } from '../../src/util/log.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、基线组与「等价对象」的构造
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 基线组（**手写字面量**，不用 `toBaselineParams()`——那本身是被测代码）。
 *
 * ⚠️ **为什么手写**：用被测代码构造基线 ⇒ 基线坏了基线也跟着坏 ⇒ **循环论证**。
 */
const BASELINE_GROUP: Params = {
  ...DEFAULT_PARAMS,
  coactivation: false,
  inhibition: false,
  writeBack: false,
  ARCHIVAL_CACHE: false,
  VECTOR_ROUTER: 'flat',
};

/** 固定的「现在」（epoch 毫秒）。 */
const NOW = 1_700_000_000_000;

/** 建一个内存库 + store 上下文。 */
function makeStore(params: Params): {
  db: Database.Database;
  store: { db: Database.Database; params: Params; events: EventWriter };
} {
  const db = new Database(':memory:');
  createSchema(db);
  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => 0,
  });
  return { db, store: { db, params, events } };
}

/** 建一个实体。 */
function insertEntity(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO entities (id, name, type, created_at)
     VALUES (@id, @id, 'concept', @at)`,
  ).run({ id, at: NOW });
}

/** 把一条记忆挂到实体上。 */
function linkEntity(db: Database.Database, memoryId: string, entityId: string): void {
  insertEntity(db, entityId);
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (@memoryId, @entityId)',
  ).run({ memoryId, entityId });
}

/** 造一条记忆（`content_tokens` 必须自己算，否则 FTS 命中不到）。 */
function seedMemory(
  db: Database.Database,
  id: string,
  options: {
    content?: string;
    entityIds?: readonly string[];
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
    createdAt: NOW - (rank + 1) * 86_400_000,
    lastAccess: NOW - (rank + 1) * 60 * 60 * 1000,
  });
  for (const entityId of options.entityIds ?? []) {
    linkEntity(db, id, entityId);
  }
}

/** 造一条边（实体 ↔ 实体）——联想路实体跳的燃料。 */
function insertEdge(
  db: Database.Database,
  id: string,
  subjectId: string,
  predicate: string,
  objectId: string,
  weight: number,
): void {
  insertEntity(db, subjectId);
  insertEntity(db, objectId);
  db.prepare(
    `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
     VALUES (@id, @subjectId, @predicate, @objectId, NULL, @weight, @lastActive, @lastActive)`,
  ).run({ id, subjectId, predicate, objectId, weight, lastActive: NOW });
}

/**
 * ★ **「联想路世界」**：**有边 + 有共激活 + 有簇** ⇒ 三个新机制**都真的可能生效**。
 *
 * ⚠️ **为什么必须有它**（前提审计）：若世界里**没有**边 / 共激活 / 簇，
 *   那么「关掉 `coactivation` ⇒ 联想路不执行」这条断言**恒成立**
 *   （因为联想路本来就没东西可执行）⇒ **恒绿守卫**。
 *   ⇒ 本世界保证每个开关的「关掉」都**真的能观测到差异**。
 */
function seedAssociationWorld(db: Database.Database): void {
  // ── 三条文本路候选：v-1 / v-2 共享两个实体 ⇒ 冗余（抑制会挤掉 v-2）──
  seedMemory(db, 'v-1', { entityIds: ['e-1', 'e-2'], rank: 0 });
  seedMemory(db, 'v-2', { entityIds: ['e-1', 'e-2', 'e-5'], rank: 1 });
  seedMemory(db, 'v-3', { entityIds: ['e-3'], rank: 2 });
  // ── 边（实体跳）：v-1 的 e-1 ⇒ v-4 的 e-6 ──
  seedMemory(db, 'v-4', { content: '仓库盘点清单', entityIds: ['e-6'], rank: 3 });
  insertEdge(db, 'ed-1', 'e-1', 'p-1', 'e-6', 0.8);
  // ── 共激活 + 簇（簇跳）：v-1 ↔ v-4 同属簇 c-1 ──
  db.prepare(
    `INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
     VALUES ('v-1', 'v-4', 0.75, 1, 1, @now)`,
  ).run({ now: NOW });
  db.prepare(
    'INSERT INTO theme_clusters (cluster_id, cluster_version, computed_at, member_count) VALUES (?, 1, ?, ?)',
  ).run('c-1', NOW, 2);
  for (const memberId of ['v-1', 'v-4']) {
    db.prepare('INSERT INTO theme_cluster_members (cluster_id, memory_id) VALUES (?, ?)').run(
      'c-1',
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

/** 读一条 `recall` 事件的 payload。 */
function readRecallPayload(db: Database.Database): {
  hitIds: string[];
  scores: number[];
  suppressedIds: string[];
} {
  const rows = db.prepare("SELECT payload FROM events WHERE type = 'recall'").all() as Array<{
    payload: string;
  }>;
  const payload = JSON.parse(rows[0]?.payload ?? '{}') as {
    hitIds: string[];
    scores: number[];
    suppressedIds: string[];
  };
  return payload;
}

/** 读一条 `touch` 事件的 payload。 */
function readTouchPayload(db: Database.Database): Record<string, unknown> {
  const rows = db.prepare("SELECT payload FROM events WHERE type = 'touch'").all() as Array<{
    payload: string;
  }>;
  return JSON.parse(rows[0]?.payload ?? '{}') as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、`inhibition` · 关掉 ⇒ 候选带不重排 ⇒ 与 v1.0 逐位相同
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T06 · 开关逐条复验 ① `inhibition`（侧抑制）', () => {
  it('★ 关掉 ⇒ hits 与「全部候选按 (score DESC, id ASC) 取 topN」**逐字段全等**（v1.0 的召回规则）', () => {
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(off.db);
    // ⚠️ **对照组**：`inhibition = true` 时**确实**会挤掉一条 ⇒ 否则「关掉没变」证明不了任何事。
    const on = makeStore({ ...BASELINE_GROUP, inhibition: true });
    seedAssociationWorld(on.db);

    const withoutInhibition = recall(off.store, {
      context: '猫粮品牌',
      explain: true,
      now: NOW,
    });
    const withInhibition = recall(on.store, {
      context: '猫粮品牌',
      explain: true,
      now: NOW,
    });

    // ── 前提自检①：**抑制开时确实挤掉了一条**（D 桶非空）──
    expect(withInhibition.suppressed).toHaveLength(1);
    expect(withInhibition.suppressed[0]?.id).toBe('v-2');
    // ── 前提自检②：**抑制关时一条都没挤掉**（§5：关 ⇒ 候选带不重排）──
    expect(withoutInhibition.suppressed).toHaveLength(0);
    // ── 前提自检③：**联想路没跑**（`coactivation=false` ⇒ `diffused` 恒空）──
    //   ⚠️ **这是「关掉 `inhibition` 不影响别的开关维度」的前提**。
    expect(withoutInhibition.diffused).toEqual([]);
    expect(withInhibition.diffused).toEqual([]);

    // ── 断言①：**逐位相同**（id 序列 = 全部候选按 base 分降序取 topN）──
    //   ⚠️ **基线组下 `coactivation=false`** ⇒ 候选只有三条文本路命中的 ⇒ 全部进 hits。
    expect(withoutInhibition.hits.map((hit) => hit.id)).toEqual(['v-1', 'v-2', 'v-3']);
    // ── 断言②：**逐位相同**（每条的 score 与 breakdown 五项）──
    //   ⚠️ **不用 `toBeCloseTo`**：本要求说的是「逐位一致」。
    //   ⚠️ **「每一条候选」= hits ∪ suppressed**（抑制关时 suppressed 为空 ⇒ 就是全部 hits）。
    const scoreOn = new Map<string, number>([
      ...withInhibition.hits.map((hit) => [hit.id, hit.score] as const),
      ...withInhibition.suppressed.map((item) => [item.id, item.score] as const),
    ]);
    for (const hit of withoutInhibition.hits) {
      expect(hit.score).toBe(scoreOn.get(hit.id));
    }
    //   ⚠️ **breakdown 只在 `hits` 里比**（`RecallSuppressed` **没有** `breakdown` 字段
    //   ——它是 §6 的**抑制标注**形状，不是 `Hit`）⇒ 被挤掉那条的 breakdown 不存在可比对象。
    for (const hit of withoutInhibition.hits) {
      // ⚠️ **breakdown 必须在场**（`explain: true` 时给出）⇒ 否则这条断言是空的。
      expect(hit.breakdown).toBeDefined();
      const counterpart = withInhibition.hits.find((other) => other.id === hit.id);
      if (counterpart !== undefined) {
        expect(hit.breakdown).toEqual(counterpart.breakdown);
      } else {
        // ⚠️ **被抑制的那条**：分数逐位相同已在上面对比 ⇒ 这里只确认它的分数没被改。
        expect(hit.score).toBe(scoreOn.get(hit.id));
      }
    }
    // ⚠️ **前提自检④**：**确实有一条只在 `suppressed` 里**（否则上面那个分支永远走不到
    //   ⇒ 「抑制不改分」的证据会退化成「两边都是 hits」的平凡比较）。
    expect(withInhibition.suppressed.map((item) => item.id)).toEqual(['v-2']);
    // ── 断言③：**逐位相同**（事件的 hitIds / scores）──
    const payloadOff = readRecallPayload(off.db);
    expect(payloadOff.hitIds).toEqual(withoutInhibition.hits.map((hit) => hit.id));
    expect(payloadOff.scores).toEqual(withoutInhibition.hits.map((hit) => hit.score));
    expect(payloadOff.suppressedIds).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、`coactivation` · 关掉 ⇒ touch 不写 coacts；联想路不执行
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T06 · 开关逐条复验 ② `coactivation`（共激活 / 联想路）', () => {
  it('★ 关掉 ⇒ `touch` **完全不写** `coacts`（表内容哈希前后逐位相同）；`diffused` 恒空', () => {
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(off.db);
    // ⚠️ **对照组**：`coactivation = true` 时**确实**会写 coacts、**确实**会跑联想路。
    const on = makeStore({ ...BASELINE_GROUP, coactivation: true });
    seedAssociationWorld(on.db);

    // ── 前提自检①：**对照组真的写了 coacts**（否则「关掉没写」证明不了任何事）──
    touch(on.store, ['v-1', 'v-2'], NOW);
    const rowsOn = on.db.prepare('SELECT COUNT(*) AS n FROM coacts').get() as { n: number };
    expect(rowsOn.n).toBeGreaterThan(0);

    // ── 前提自检②：**对照组真的跑了联想路**（`diffused` 非空）──
    const recallOn = recall(on.store, { context: '猫粮品牌', now: NOW });
    expect(recallOn.diffused.length).toBeGreaterThan(0);

    // ── 断言①：**关掉 ⇒ `touch` 完全不写 `coacts`**（表内容哈希前后**逐位相同**）──
    const coactsBefore = tableHash(off.db, 'coacts', 'memory_a, memory_b');
    touch(off.store, ['v-1', 'v-2'], NOW);
    expect(tableHash(off.db, 'coacts', 'memory_a, memory_b')).toBe(coactsBefore);
    //   ⚠️ **「前后逐位相同」比「行数为 0」更强**：它不预设表本来是空的。
    const rowsOff = off.db.prepare('SELECT COUNT(*) AS n FROM coacts').get() as { n: number };
    expect(rowsOff.n).toBe(1); // ⚠️ 种子世界**预置**了 1 行（簇跳的燃料）⇒ 增量才是判据。

    // ── 断言②：**关掉 ⇒ 联想路不执行**（`diffused` 恒空）──
    const recallOff = recall(off.store, { context: '猫粮品牌', now: NOW });
    expect(recallOff.diffused).toEqual([]);
  });

  it('★ 关掉 ⇒ 主题簇**不计算也不使用**（三张簇表逐位不变、不记 `sweep` 事件、`clusters()` 返回空）', () => {
    // ⚠️ §5 机制开关表写明 `coactivation` 关 ⇒「**主题簇不计算也不使用**」
    //   ⇒ 本用例守这条：① `recluster()` **不写库、不写事件**；
    //   ② `clusters()` **返回空**（不读簇表、不现场重算）。
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(off.db);

    const before = {
      clusters: tableHash(off.db, 'theme_clusters', 'cluster_id'),
      members: tableHash(off.db, 'theme_cluster_members', 'cluster_id, memory_id'),
      meta: tableHash(off.db, 'cluster_snapshot_meta', 'id'),
      events: off.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'sweep'").get() as {
        n: number;
      },
    };

    // ── 断言①：**`recluster()` 不写库**（三张簇表逐位相同）──
    const result = recluster(off.store, NOW);
    expect(tableHash(off.db, 'theme_clusters', 'cluster_id')).toBe(before.clusters);
    expect(tableHash(off.db, 'theme_cluster_members', 'cluster_id, memory_id')).toBe(
      before.members,
    );
    expect(tableHash(off.db, 'cluster_snapshot_meta', 'id')).toBe(before.meta);

    // ── 断言②：**`recluster()` 不写事件**（一条 `sweep` 都不多）──
    //   ⚠️ **这是「不计算也不使用」的关键一半**：只断言表不变是不够的
    //   ⇒ 事件里若留了 `action='recluster'`，宿主仍会以为「簇刚重算过」。
    const eventsAfter = off.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'sweep'")
      .get() as { n: number };
    expect(eventsAfter.n).toBe(before.events.n);

    // ── 断言③：**`recluster()` 自报「没算」**（宿主靠 `computed` 区分）──
    expect(result.computed).toBe(false);
    expect(result.clusterCount).toBe(0);
    // ⚠️ ★ **`skipped` 必须说清「为什么没算」**（2026-11-02 架构师裁决 · v2.1 勘误）：
    //   机制开关 `coactivation` 关 ⇒ `skipped = 'disabled'`（**不是** `'too_soon'`、**不是** `null`）
    //   ⇒ ⚠️ 旧宿主若写「`skipped === 'too_soon'` ⇒ 跳过，否则 ⇒ 算了」
    //     ⇒ 会把 `'disabled'` **误判成「算了」** ⇒ 这是**破坏性变更**（`docs/DELIVERY.md` 有登记）。
    expect(result.skipped).toBe('disabled');
    // ⚠️ **不变式**：`computed === (skipped === null)`（三个取值下都必须成立）。
    expect(result.computed).toBe(result.skipped === null);

    // ── 断言④：**`clusters()` 返回空**（不读簇表、不现场重算）──
    const navigation = clusters({ db: off.db, params: off.store.params }, undefined, NOW);
    expect(navigation.clusters).toEqual([]);
    expect(navigation.coveredMemories).toBe(0);
    expect(navigation.totalClusters).toBe(0);
    expect(navigation.totalMembers).toBe(0);
    expect(navigation.coverage).toBe(0);
    expect(navigation.coverageOverAdopted).toBe(0);
    // ⚠️ **库级事实仍取真值**（§6：`clusters().adoptedMemories` 与 `stats().adoptedMemories`
    //   **必须恒等** ⇒ 填 0 会破坏那条恒等式）⇒ 断言它**不是** 0。
    expect(navigation.adoptedMemories).toBeGreaterThan(0);
    expect(navigation.totalMemories).toBeGreaterThan(0);

    // ── 断言⑤（**对照**）：开关**开着**时主题簇**确实**会被计算并发布
    //   ⇒ 否则上面那些断言可能只是「这个种子世界本来就没有簇」的恒绿守卫。
    const on = makeStore({ ...BASELINE_GROUP, coactivation: true });
    seedAssociationWorld(on.db);
    const onResult = recluster(on.store, NOW);
    expect(onResult.computed).toBe(true);
    expect(onResult.clusterCount).toBeGreaterThan(0);
    const onEvents = on.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'sweep'")
      .get() as { n: number };
    expect(onEvents.n).toBe(before.events.n + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三·补、`recluster()` 的 `skipped` 三值枚举（2026-11-02 架构师裁决 · v2.1 勘误）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **三张簇表 + `sweep` 事件条数**的快照（**「没写库、没记事件」的判据**）。
 *
 * ⚠️ **为什么是「表内容哈希」而不是「行数」**：行数不变**不蕴含**内容不变
 *   （改内容不改行数是可能发生的）⇒ 哈希更强。
 * ⚠️ **为什么连 `cluster_snapshot_meta` 一起断**：它是快照的**元信息**行
 *   ⇒ 重算会**整行替换**它 ⇒ 它变了就说明「真的写了库」。
 */
interface ClusterWriteFootprint {
  readonly clusters: string;
  readonly members: string;
  readonly meta: string;
  readonly sweepEvents: number;
}

/** 采一份「簇表 + sweep 事件」的写入足迹。 */
function clusterFootprint(db: Database.Database): ClusterWriteFootprint {
  return {
    clusters: tableHash(db, 'theme_clusters', 'cluster_id'),
    members: tableHash(db, 'theme_cluster_members', 'cluster_id, memory_id'),
    meta: tableHash(db, 'cluster_snapshot_meta', 'id'),
    sweepEvents: (
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'sweep'").get() as { n: number }
    ).n,
  };
}

describe('P3-T06 · 补 · `recluster()` 的 `skipped` 三值枚举（v2.1 勘误）', () => {
  it("★ 三个取值：`'too_soon'` / `'disabled'` / `null` 都能被**真实触发**（不是构造出来的）", () => {
    // ── 取值①：`'disabled'`（机制开关 `coactivation` 关）──
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(off.db);
    const disabled = recluster(off.store, NOW);
    expect(disabled.skipped).toBe('disabled');
    expect(disabled.computed).toBe(false);

    // ── 取值②：`'too_soon'`（间隔闸门：距上次发布不足 `CLUSTER_RECALC_INTERVAL_MS`）──
    const on = makeStore({ ...BASELINE_GROUP, coactivation: true });
    seedAssociationWorld(on.db);
    const first = recluster(on.store, NOW);
    expect(first.skipped).toBe(null);
    expect(first.computed).toBe(true);
    // ⚠️ **同一时刻再调一次** ⇒ `at - previous.computed_at = 0` ⇒ 间隔闸门拦下。
    const tooSoon = recluster(on.store, NOW);
    expect(tooSoon.skipped).toBe('too_soon');
    expect(tooSoon.computed).toBe(false);

    // ── 取值③：`null`（真算了）──
    // ⚠️ **跨过间隔闸门**（`NOW + CLUSTER_RECALC_INTERVAL_MS`）⇒ 真的重算并发布。
    const later = recluster(on.store, NOW + DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS);
    expect(later.skipped).toBe(null);
    expect(later.computed).toBe(true);
  });

  it('★ **不变式**：三个取值下 `computed === (skipped === null)` 都成立', () => {
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(off.db);
    const disabled = recluster(off.store, NOW);

    const on = makeStore({ ...BASELINE_GROUP, coactivation: true });
    seedAssociationWorld(on.db);
    const computed = recluster(on.store, NOW);
    const tooSoon = recluster(on.store, NOW);

    // ⚠️ **三个取值都取到了**（否则下面的断言可能是「空集恒真」）。
    expect([disabled.skipped, computed.skipped, tooSoon.skipped]).toEqual([
      'disabled',
      null,
      'too_soon',
    ]);
    // ⚠️ **不变式本体**：`computed` 是**派生量**（`skipped` 的函数）⇒ 两者必须恒等。
    expect(disabled.computed).toBe(disabled.skipped === null);
    expect(computed.computed).toBe(computed.skipped === null);
    expect(tooSoon.computed).toBe(tooSoon.skipped === null);
    // ⚠️ **方向也要对**（不只是「两者相等」）：跳过的两个取值 ⇒ `computed = false`；
    //   真算的那个 ⇒ `computed = true`。
    expect(disabled.computed).toBe(false);
    expect(tooSoon.computed).toBe(false);
    expect(computed.computed).toBe(true);
  });

  it('★ **新不变式**：`skipped !== null` ⇒ **没有写库、没有记事件**（两个跳过取值都要守）', () => {
    // ── `'disabled'`：机制开关关 ⇒ 连读共激活图都不读 ⇒ 三张簇表逐位不变 ──
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(off.db);
    const before = clusterFootprint(off.db);
    const disabled = recluster(off.store, NOW);
    expect(disabled.skipped).not.toBe(null);
    const afterDisabled = clusterFootprint(off.db);
    expect(afterDisabled.clusters).toBe(before.clusters);
    expect(afterDisabled.members).toBe(before.members);
    expect(afterDisabled.meta).toBe(before.meta);
    expect(afterDisabled.sweepEvents).toBe(before.sweepEvents);

    // ── `'too_soon'`：间隔闸门 ⇒ 幂等返回 ⇒ 三张簇表逐位不变、事件一条不多 ──
    const on = makeStore({ ...BASELINE_GROUP, coactivation: true });
    seedAssociationWorld(on.db);
    const beforeComputed = clusterFootprint(on.db);
    const computed = recluster(on.store, NOW);
    expect(computed.skipped).toBe(null);
    const afterComputed = clusterFootprint(on.db);
    // ⚠️ **前提自检**：真的算过一次 ⇒ 事件**确实多了一条**、快照元信息**确实变了**
    //   ⇒ 否则下面那些「没变」的断言可能是「本来就没东西可变」的恒绿守卫。
    expect(afterComputed.sweepEvents).toBe(beforeComputed.sweepEvents + 1);
    expect(afterComputed.meta).not.toBe(beforeComputed.meta);

    const beforeTooSoon = clusterFootprint(on.db);
    const tooSoon = recluster(on.store, NOW);
    expect(tooSoon.skipped).toBe('too_soon');
    expect(tooSoon.skipped).not.toBe(null);
    const afterTooSoon = clusterFootprint(on.db);
    expect(afterTooSoon.clusters).toBe(beforeTooSoon.clusters);
    expect(afterTooSoon.members).toBe(beforeTooSoon.members);
    expect(afterTooSoon.meta).toBe(beforeTooSoon.meta);
    expect(afterTooSoon.sweepEvents).toBe(beforeTooSoon.sweepEvents);
  });

  it("★ **两个跳过取值的返回口径不同**：`'disabled'` ⇒ 簇数与占比都是 0；`'too_soon'` ⇒ 簇数是**上次快照的**", () => {
    // ⚠️ 设计稿原文：「`'disabled'` ⇒ `clusterCount = 0`、`largestClusterRatio = 0`
    //   （因为「簇」这件事**根本不存在**，不是「存在但为空」）；
    //   `'too_soon'` ⇒ `clusterCount` = **上一次已发布快照**的簇数
    //   （`largestClusterRatio` = 现算的「最大块 / 未删记忆数」）。
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(off.db);
    const disabled = recluster(off.store, NOW);
    expect(disabled.clusterCount).toBe(0);
    expect(disabled.largestClusterRatio).toBe(0);

    const on = makeStore({ ...BASELINE_GROUP, coactivation: true });
    seedAssociationWorld(on.db);
    const computed = recluster(on.store, NOW);
    expect(computed.clusterCount).toBeGreaterThan(0);
    const tooSoon = recluster(on.store, NOW);
    // ⚠️ 「跳过时 `clusterCount` 与真算出来「长得一样」」⇒ **不能靠它判断有没有重算**。
    expect(tooSoon.clusterCount).toBe(computed.clusterCount);
    expect(tooSoon.skipped).toBe('too_soon');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、`writeBack` · 关掉 ⇒ 「扩散唤起 → 采纳 → 回写」的联动不发生，但 growStability 照常
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T06 · 开关逐条复验 ③ `writeBack`（激活回写）', () => {
  it('★ 关掉 ⇒ `touch` 的 `growStability` 加固**照常发生**（§5：「`touch` 自身的 `growStability` 加固不受影响」）', () => {
    // ⚠️ **本用例只守「加固照常发生」这一半**（当前实现满足）。
    //   ⚠️ **另一半（「不写因果边」）当前是缺陷** ⇒ 由下一条 `it.fails` 登记。
    const off = makeStore({ ...BASELINE_GROUP, writeBack: false, coactivation: true });
    seedAssociationWorld(off.db);

    const stabilityBefore = (
      off.db.prepare('SELECT stability FROM memories WHERE id = ?').get('v-2') as {
        stability: number;
      }
    ).stability;

    // ⚠️ **同日守卫**（§4.2 约束①）：`intervalDays < 1.0` ⇒ **不增长**
    //   ⇒ 必须把 `last_access` 往前推 **≥ 1 天**（否则「stability 仍增长」是假的）。
    off.db
      .prepare('UPDATE memories SET last_access = ? WHERE id = ?')
      .run(NOW - 2 * 86_400_000, 'v-2');

    touch(off.store, ['v-2'], NOW, {
      coActivateWith: [{ memoryId: 'v-2', seedIds: ['v-1'] }],
    });

    // ── 断言：**`growStability` 照常加固**（stability 仍增长）──
    //   ⚠️ 这是计划 P3-T06 明文要求的（「`touch` 自身的 `growStability` 加固**不受影响**」）。
    const stabilityAfter = (
      off.db.prepare('SELECT stability FROM memories WHERE id = ?').get('v-2') as {
        stability: number;
      }
    ).stability;
    expect(stabilityAfter).toBeGreaterThan(stabilityBefore);
    // ⚠️ **事件的 `stabilityDelta` 键恒在且非零**（§8.4 硬规则 5 的对账恒等式依赖它）。
    const payload = readTouchPayload(off.db);
    expect(payload.stabilityDelta).toBeGreaterThan(0);
  });

  it('★ 关掉 ⇒ `coActivateWith` 的**交叉强化不发生**（无 `cause_flags` bit1 的因果边），但**普通共激活行照旧**（bit0）、`growStability` 仍加固', () => {
    // ⚠️ §5 机制开关表写明 `writeBack` 关 ⇒「**`touch` 的 `coActivateWith` 交叉强化不发生**」
    //   ⇒ 本用例守三件事：
    //   ① **不写因果边**（`cause_flags` 的 bit1 = 2 那一位不置位 ⇒ 整条表逐位不变）；
    //   ② **普通共激活行照旧**（机制 A 的 bit0 = 1 仍要写 ⇒ `writeBack` **不是**「不写 coacts」）；
    //   ③ `growStability` 加固不受影响（由同 describe 的另一条用例守）。
    const off = makeStore({ ...BASELINE_GROUP, writeBack: false, coactivation: true });
    seedAssociationWorld(off.db);
    // ⚠️ **对照组**：`writeBack = true` 时**确实**写了因果边（否则「关掉没写」证明不了任何事）。
    const on = makeStore({ ...BASELINE_GROUP, writeBack: true, coactivation: true });
    seedAssociationWorld(on.db);
    touch(on.store, ['v-2'], NOW, {
      coActivateWith: [{ memoryId: 'v-2', seedIds: ['v-1'] }],
    });
    const causalOn = on.db
      .prepare('SELECT COUNT(*) AS n FROM coacts WHERE (cause_flags & 2) != 0')
      .get() as { n: number };
    expect(causalOn.n).toBe(1); // ⚠️ 机制 B 写的那一行（bit1 置位）。
    const rowsOn = on.db.prepare('SELECT COUNT(*) AS n FROM coacts').get() as { n: number };
    expect(rowsOn.n).toBe(2); // ⚠️ 种子世界**预置** 1 行（簇跳燃料）+ 机制 B 写 1 行。

    // ── 断言①：**关掉 ⇒ `coActivateWith` 的因果边整条不发生**（表内容逐位不变）──
    const coactsBefore = tableHash(off.db, 'coacts', 'memory_a, memory_b');
    touch(off.store, ['v-2'], NOW, {
      coActivateWith: [{ memoryId: 'v-2', seedIds: ['v-1'] }],
    });
    expect(tableHash(off.db, 'coacts', 'memory_a, memory_b')).toBe(coactsBefore);
    // ⚠️ **逐位比对之外再点一次名**：**没有任何一行的 `cause_flags` 置了 bit1**。
    const causalOff = off.db
      .prepare('SELECT COUNT(*) AS n FROM coacts WHERE (cause_flags & 2) != 0')
      .get() as { n: number };
    expect(causalOff.n).toBe(0);

    // ── 断言②：**普通共激活行照旧**（机制 A：两条一起 touch ⇒ 写出一行 bit0）──
    //   ⚠️ **这条是「`writeBack` ≠「不写 `coacts`」的正面证据**（§5：普通共激活由 `coactivation` 管）。
    touch(off.store, ['v-1', 'v-2'], NOW);
    const pairRow = off.db
      .prepare('SELECT cause_flags FROM coacts WHERE memory_a = ? AND memory_b = ?')
      .get('v-1', 'v-2') as { cause_flags: number } | undefined;
    expect(pairRow).toBeDefined();
    expect(pairRow?.cause_flags).toBe(1); // ⚠️ **只有 bit0**（机制 A）⇒ **没有 bit1**。

    // ── 断言③：**事件里也没有因果回写**（`activationWrites` 恒空）──
    const payload = readTouchPayload(off.db);
    expect(payload.activationWrites).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、`ARCHIVAL_CACHE` · 关掉 ⇒ `countArchived` 的**结果**逐位相同（路径不同、结果相同）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T06 · 开关逐条复验 ④ `ARCHIVAL_CACHE`（归档缓存）', () => {
  it('★ 关掉 ⇒ 归档口径的**可观测结果**与开着时**逐位相同**（路径不同、结果相同）', () => {
    // ⚠️ **阶段 4 才实现 `countArchived`（§9.4 / `src/store/archival.ts`）**
    //   ⇒ 本轮**能验的部分**是「**结果口径不依赖开关**」：
    //   归档线（`ARCHIVE_LINE`）是**参数**（不是开关）⇒ 开关关掉**不得**改变归档判定。
    //   ⇒ 用「同一批记忆在两种开关下的 `layer` 判定」作为**结果口径**的等价物。
    const on = makeStore({ ...BASELINE_GROUP, ARCHIVAL_CACHE: true });
    const off = makeStore({ ...BASELINE_GROUP, ARCHIVAL_CACHE: false });
    for (const db of [on.db, off.db]) {
      // ── 一条**很旧**的记忆（强度必然落到归档线以下 ⇒ `layer = 'archived'`）──
      //   ⚠️ **`rank` 只推进「小时」**（`last_access = NOW - (rank+1) × 1h`）
      //   ⇒ 要落到归档线以下（intensity < 0.05），必须**同时**把稳定度压到 1 天
      //   （τ = 1 天 ⇒ 40 小时 ⇒ exp(-40/24) ≈ 0.19 > 0.05 ⇒ 还不够）
      //   ⇒ 稳定度 1 天 + 推进 30 **天**（`last_access` 直接写 30 天前）⇒ exp(-30) ≈ 9.4e-14 ≤ 0.05 ✓
      seedMemory(db, 'arch-old', { rank: 0 });
      db.prepare('UPDATE memories SET stability = 1, last_access = ? WHERE id = ?').run(
        NOW - 30 * 86_400_000,
        'arch-old',
      );
      // ── 一条**很新**的记忆（强度高 ⇒ `layer = 'L3'`）──
      seedMemory(db, 'arch-new', { rank: 0 });
    }

    const layersOf = (db: Database.Database): Record<string, string> => {
      const rows = db
        .prepare('SELECT id, stability, pin_factor, last_access FROM memories ORDER BY id')
        .all() as Array<{
        id: string;
        stability: number;
        pin_factor: number;
        last_access: number;
      }>;
      const out: Record<string, string> = {};
      for (const row of rows) {
        const value = intensity(row, NOW);
        out[row.id] = layerOf(value, off.store.params);
      }
      return out;
    };

    const layersOn = layersOf(on.db);
    const layersOff = layersOf(off.db);

    // ── 前提自检：**两个世界真的有归档/非归档之分**（否则「结果相同」是空洞的）──
    expect(layersOn['arch-old']).toBe('archived');
    expect(layersOn['arch-new']).not.toBe('archived');

    // ── 断言：**逐位相同**（归档判定口径与开关无关）──
    expect(layersOff).toEqual(layersOn);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、`VECTOR_ROUTER='flat'` · 关掉 ⇒ 向量路与 v1.0 一致（整路缺席 / 精确全扫）
// ═══════════════════════════════════════════════════════════════════════════

describe("P3-T06 · 开关逐条复验 ⑤ `VECTOR_ROUTER='flat'`（向量路）", () => {
  it('★ `flat` ⇒ 向量路**不产出** `fromVector` 的候选，`cos` 恒 `null`（与 v1.0 的向量路缺席口径一致）', () => {
    const flat = makeStore({ ...BASELINE_GROUP, VECTOR_ROUTER: 'flat' });
    seedAssociationWorld(flat.db);

    const result = recall(flat.store, { context: '猫粮品牌', now: NOW });

    // ── 断言①：**没有一条候选来自向量路** ──
    for (const hit of result.hits) {
      expect(hit.fromVector).toBe(false);
    }
    // ── 断言②：**`cos` 恒 `null`**（阶段 1/2 的向量路整路缺席口径）──
    for (const hit of result.hits) {
      expect(hit.breakdown?.cos ?? null).toBeNull();
      expect(hit.breakdown?.vectorPart ?? 0).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、`diffuseArchived` · 它不是机制开关（是 `RecallOptions` 字段）⇒ 只登记「v1.0 里不存在」
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T06 · 开关逐条复验 ⑥ `diffuseArchived`（§4.7 R-ARCH-DIFF 通道）', () => {
  it('★ 它**不是机制开关**（是 `RecallOptions` 字段）⇒ 在 v1.0 里**不存在** ⇒ 基线组下两种取值**逐位相同**', () => {
    const on = makeStore({ ...BASELINE_GROUP });
    const off = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(on.db);
    seedAssociationWorld(off.db);

    const resultOn = recall(on.store, { context: '猫粮品牌', diffuseArchived: true, now: NOW });
    const resultOff = recall(off.store, { context: '猫粮品牌', diffuseArchived: false, now: NOW });

    // ── 前提自检：**基线组下联想路不执行** ⇒ `diffused` 恒空 ⇒ 这个字段**无从观测** ──
    expect(resultOn.diffused).toEqual([]);
    expect(resultOff.diffused).toEqual([]);

    // ── 断言：**两种取值下逐位相同**（基线组 ⇒ 该字段无影响 ⇒ 与 v1.0 一致）──
    expect(resultOff.diffused).toEqual(resultOn.diffused);
    expect(resultOff.hits.map((hit) => hit.id)).toEqual(resultOn.hits.map((hit) => hit.id));
    expect(resultOff.hits.map((hit) => hit.score)).toEqual(resultOn.hits.map((hit) => hit.score));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 八、汇总：联合基线（本文件的「总闸」）仍然与 v1.0 逐位一致
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T06 · 联合基线复验（第二次达成点）', () => {
  it('★ 基线组（四个布尔全关 + flat）⇒ `coacts` 表**不被写入**、`diffused` 恒空 ⇒ 与 v1.0 的可观测面逐位一致', () => {
    const base = makeStore({ ...BASELINE_GROUP });
    seedAssociationWorld(base.db);

    // ── `touch` 前后 `coacts` 表**逐位相同**（**三个模式都测**：reinforce / explain / diagnostics）──
    const before = tableHash(base.db, 'coacts', 'memory_a, memory_b');
    recall(base.store, { context: '猫粮品牌', now: NOW });
    recall(base.store, { context: '猫粮品牌', explain: true, now: NOW });
    recall(base.store, { context: '猫粮品牌', diagnostics: true, now: NOW });
    expect(tableHash(base.db, 'coacts', 'memory_a, memory_b')).toBe(before);

    // ── `diffused` 恒空（联想路不执行 ⇒ 与 v1.0 的「没有 diffused 字段」一致）──
    for (const options of [{ explain: true }, { diagnostics: true }, {}]) {
      const result = recall(base.store, { context: '猫粮品牌', now: NOW, ...options });
      expect(result.diffused).toEqual([]);
    }
  });
});
