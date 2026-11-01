/**
 * §4.7 / §4.14 的激活扩散与簇跳 —— DEVELOPMENT-PLAN.md **P3-T04** 的硬断言。
 *
 * ⚠️ **覆盖面按计划稿 §P3-T04「验收标准」逐条对应**：
 *   驱动方式（只扫 `coacts`）/ 多簇 / 双向 JOIN 不重复 / 截断位置 / 两腿合并取 max /
 *   归档过滤在合并之后 / 软删过滤 / 共享预算 / `diffusionScore` 上界 /
 *   多路径累加生效 / `viaEntity` 与 `viaClusterId` 二选一
 *   —— 外加 P3-T02 留下的那条账：**「抑制不作用于 diffused」在本阶段才真正可执行**。
 *
 * ⚠️ **断言必须真能失败**（否则是假绿）：
 *   · 「 diffused 为空」这类断言**必须同时断言「该发生的事确实发生了」**
 *     （前提自检写在同一条用例里）。
 *   · 涉及浮点的断言**全部用 `toBeCloseTo`**（累加不做逐位相等）。
 *   · **每条「不发生」型断言都要有对应的「发生」型断言配对**。
 *
 * ⚠️ **本文件用真实的内存库**（不是 mock）：查询计划、行数计数器、CHECK 约束
 *   都只有真库才验得了。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { tokenize } from '../../src/core/tokenize.js';
import { createSchema } from '../../src/db/connection.js';
import {
  CLUSTER_NEIGHBOR_COACTS_SQL,
  CLUSTER_NEIGHBOR_MEMBERSHIPS_SQL,
  CLUSTER_SEED_CLUSTERS_SQL,
  type ClusterHopOutcome,
  clusterHop,
} from '../../src/neuron/clusterhop.js';
import { type DiffuseOutcome, diffuse } from '../../src/store/diffuse.js';
import { EventWriter } from '../../src/store/events.js';
import { recall } from '../../src/store/recall.js';
import { MemoryLogger } from '../../src/util/log.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 固定的「现在」（epoch 毫秒）——全部时间从它推导。 */
const NOW = 1_700_000_000_000;

/** 建一个内存库（**不建事件写入器** ⇒ 纯扩散用例够用）。 */
function createDb(): Database.Database {
  const db = new Database(':memory:');
  createSchema(db);
  return db;
}

/** 建一个带事件写入器的 store 上下文（`recall` 用例需要）。 */
function createStore(patch: Partial<Params> = {}): {
  db: Database.Database;
  store: { db: Database.Database; params: Params; events: EventWriter };
  params: Params;
} {
  const db = createDb();
  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => 0,
  });
  const params: Params = { ...DEFAULT_PARAMS, ...patch };
  return { db, store: { db, params, events }, params };
}

/** 造一条记忆的可选覆盖项。 */
interface MemorySpec {
  /** 正文（**默认会算出对应的 `content_tokens`** ⇒ 能被文本路召回）。 */
  content?: string;
  /** 关联的实体 id 列表。 */
  entities?: readonly string[];
  /** 稳定度（天）。 */
  stability?: number;
  /** 最近访问时刻（毫秒）。 */
  lastAccess?: number;
  /** 创建时刻（毫秒）。 */
  createdAt?: number;
  /** 软删。 */
  deleted?: boolean;
  /** 记忆类型。 */
  kind?: string;
}

/** 造一条记忆（**`content_tokens` 必须自己算**，否则 FTS 命中不到）。 */
function insertMemory(db: Database.Database, id: string, spec: MemorySpec = {}): void {
  const content = spec.content ?? `内容 ${id}`;
  const deleted = spec.deleted === true;
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                           stability, difficulty, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, @kind, @content, @tokens, @hash, @stability, @difficulty,
             @createdAt, @lastAccess, @accessCount, @deleted, @deletedAt)`,
  ).run({
    id,
    kind: spec.kind ?? 'fact',
    content,
    tokens: tokenize(content),
    hash: `hash-${id}`,
    stability: spec.stability ?? 10,
    difficulty: 0.5,
    createdAt: spec.createdAt ?? NOW - 10 * MS_PER_DAY,
    lastAccess: spec.lastAccess ?? NOW - 2 * MS_PER_DAY,
    accessCount: 1,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? NOW : null,
  });
  // ⚠️ **实体关联必须在这里挂上**（`memory_entities` 有外键 ⇒ 实体行要先存在）
  for (const entityId of spec.entities ?? []) {
    linkEntity(db, id, entityId);
  }
}

/** 造一个实体（**id 与 name 同值** ⇒ 测试里不必维护两套词）。 */
function insertEntity(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO entities (id, name, type, created_at) VALUES (@id, @name, 'concept', @at)`,
  ).run({ id, name: id, at: NOW });
}

/** 把一条记忆挂到实体上（`memory_entities`）。 */
function linkEntity(db: Database.Database, memoryId: string, entityId: string): void {
  insertEntity(db, entityId);
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (@memoryId, @entityId)',
  ).run({ memoryId, entityId });
}

/** 造一条边（`edges` 表：实体↔实体）。 */
function insertEdge(
  db: Database.Database,
  id: string,
  subjectId: string,
  objectId: string,
  weight: number,
  lastActive = NOW,
): void {
  insertEntity(db, subjectId);
  insertEntity(db, objectId);
  db.prepare(
    `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
     VALUES (@id, @subjectId, @predicate, @objectId, NULL, @weight, @lastActive, @lastActive)`,
  ).run({ id, subjectId, predicate: `p-${id}`, objectId, weight, lastActive });
}

/** 造一条共激活边（`coacts`：**必须 a < b**，与 CHECK 一致）。 */
function insertCoact(
  db: Database.Database,
  memoryA: string,
  memoryB: string,
  affinity: number,
  lastActive = NOW,
): void {
  const a = memoryA < memoryB ? memoryA : memoryB;
  const b = memoryA < memoryB ? memoryB : memoryA;
  db.prepare(
    `INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
     VALUES (@a, @b, @affinity, 1, 1, @lastActive)`,
  ).run({ a, b, affinity, lastActive });
}

/** 造一个主题簇（**快照的两张表**）。 */
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

/** 跑一次扩散（**默认参数 + 默认归档口径**）。 */
function runDiffusion(
  db: Database.Database,
  params: Params,
  seedIds: readonly string[],
  options: { diffuseArchived?: boolean } = {},
): DiffuseOutcome {
  return diffuse({
    db,
    params,
    seedIds,
    now: NOW,
    diffuseArchived: options.diffuseArchived ?? true,
  });
}

/** 读一条 diffued 的分数（找不到 ⇒ `undefined`）。 */
function scoreOf(outcome: DiffuseOutcome, id: string): number | undefined {
  return outcome.items.find((item) => item.id === id)?.diffusionScore;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、簇跳算法（§4.14.3）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T04 · 簇跳的驱动方式（§4.14.3 首段 · 硬约束）', () => {
  it('★ 簇跳的三条查询**都不全量扫 `theme_cluster_members`**（`EXPLAIN QUERY PLAN`）', () => {
    const db = createDb();
    const planOf = (sql: string, params: object): string[] => {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>;
      return rows.map((row) => row.detail);
    };

    // ⚠️ **两条读 `theme_cluster_members` 的查询** ⇒ 必须走 `idx_tcm_memory` 点查
    for (const sql of [CLUSTER_SEED_CLUSTERS_SQL, CLUSTER_NEIGHBOR_MEMBERSHIPS_SQL]) {
      const plan = planOf(sql, { seedId: 'm-1', memoryIds: JSON.stringify(['m-1']) }).join(' | ');
      // ⚠️ **禁止 `SCAN theme_cluster_members`**（那正是「从簇成员表驱动」的实现形态）
      expect(plan).not.toContain('SCAN theme_cluster_members');
      expect(plan).toContain('idx_tcm_memory');
    }

    // ⚠️ **读共激活的那条查询** ⇒ 必须走 `coacts` 的两个索引（`idx_coacts_pair` / `idx_coacts_b`）
    const coactsPlan = planOf(CLUSTER_NEIGHBOR_COACTS_SQL, { seedId: 'm-1' }).join(' | ');
    expect(coactsPlan).not.toContain('SCAN coacts');
    expect(coactsPlan).toContain('idx_coacts_pair');
    expect(coactsPlan).toContain('idx_coacts_b');
  });

  it('★ 簇跳的**处理量与簇大小无关**（3000 成员的巨型簇 ⇒ 读到的成员行仍是常数级）', () => {
    const db = createDb();
    const { params } = createStore();
    // ── 一个 3000 成员的巨型簇（§4.12.4 ② 的量级）──
    insertMemory(db, 'm-seed');
    const members = ['m-seed'];
    for (let index = 0; index < 3000; index += 1) {
      const id = `m-filler-${String(index).padStart(4, '0')}`;
      insertMemory(db, id);
      members.push(id);
    }
    insertCluster(db, 'c-giant', members);
    // ── 种子只有一个共激活邻居 ──
    insertMemory(db, 'm-nbr');
    insertCoact(db, 'm-seed', 'm-nbr', 0.8);
    insertCluster(db, 'c-small', ['m-seed', 'm-nbr']);

    const outcome = clusterHop({
      db,
      params,
      seedIds: ['m-seed'],
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    // ── 前提自检：簇真的有 3000 个成员 ──
    const size = db
      .prepare('SELECT COUNT(*) AS n FROM theme_cluster_members WHERE cluster_id = ?')
      .get('c-giant') as { n: number };
    expect(size.n).toBe(3001);

    // ⚠️ ★ **读到的成员行数是常数级**（种子 1 行 + 邻居 1 行）⇒ **不是 3001 行**
    expect(outcome.memberRowsRead).toBeLessThanOrEqual(4);
    // ⚠️ **驱动源是 `coacts`**：只读了 1 行共激活
    expect(outcome.coactsRowsRead).toBe(1);
  });

  it('★ 种子同属**两个簇** ⇒ 两个簇的全部邻居都被捞出（约束①「多簇」）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-seed');
    insertMemory(db, 'm-in-c1');
    insertMemory(db, 'm-in-c2');
    insertCluster(db, 'c-1', ['m-seed', 'm-in-c1']);
    insertCluster(db, 'c-2', ['m-seed', 'm-in-c2']);
    insertCoact(db, 'm-seed', 'm-in-c1', 0.8);
    insertCoact(db, 'm-seed', 'm-in-c2', 0.6);

    const outcome = clusterHop({
      db,
      params,
      seedIds: ['m-seed'],
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    // ⚠️ **两个簇的邻居都在**（单簇写法会漏掉 `m-in-c2`）
    expect(outcome.candidates.map((candidate) => candidate.memoryId).sort()).toEqual([
      'm-in-c1',
      'm-in-c2',
    ]);
  });

  it('★ 双向 JOIN **不重复**：同一对 (seed, nbr) 只计一次（依赖 `CHECK (memory_a < memory_b)`）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-a');
    insertMemory(db, 'm-b');
    insertCluster(db, 'c-1', ['m-a', 'm-b']);
    insertCoact(db, 'm-a', 'm-b', 0.8);

    // ⚠️ **前提自检**：`coacts` 表的 CHECK 让同一对只有一行
    const rows = db.prepare('SELECT COUNT(*) AS n FROM coacts').get() as { n: number };
    expect(rows.n).toBe(1);

    const outcome = clusterHop({
      db,
      params,
      seedIds: ['m-a'],
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    // ⚠️ **只一条候选**（`UNION ALL` 的两支互斥 ⇒ 不会把同一对计两次）
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]?.memoryId).toBe('m-b');
    // ⚠️ **只读了一行共激活**（两支各读半边 ⇒ 合起来一行）
    expect(outcome.coactsRowsRead).toBe(1);
  });

  it('★ 种子**无簇** ⇒ 跳过簇跳（不是报错、不是特殊分支）（约束④）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-lonely');
    insertMemory(db, 'm-other');
    insertCoact(db, 'm-lonely', 'm-other', 0.8);

    const outcome = clusterHop({
      db,
      params,
      seedIds: ['m-lonely'],
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.skippedNoCluster).toBe(1);
  });

  it('★ 软删成员**不出现在**簇跳候选里（约束②「软删过滤」）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-seed');
    insertMemory(db, 'm-deleted', { deleted: true });
    insertMemory(db, 'm-alive');
    insertCluster(db, 'c-1', ['m-seed', 'm-deleted', 'm-alive']);
    insertCoact(db, 'm-deleted', 'm-seed', 0.9);
    insertCoact(db, 'm-alive', 'm-seed', 0.8);

    const outcome = clusterHop({
      db,
      params,
      seedIds: ['m-seed'],
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    expect(outcome.candidates.map((candidate) => candidate.memoryId)).toEqual(['m-alive']);
  });

  it('★ `affinity_eff` **衰减生效**（复用 `effectiveAffinity`；陈旧的边不进 diffused）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-seed');
    insertMemory(db, 'm-fresh');
    insertMemory(db, 'm-stale');
    insertCluster(db, 'c-1', ['m-seed', 'm-fresh', 'm-stale']);
    insertCoact(db, 'm-fresh', 'm-seed', 0.9);
    // ⚠️ **陈旧**：200 天没共现 ⇒ affinity_eff 衰减到门槛下
    insertCoact(db, 'm-seed', 'm-stale', 0.9, NOW - 200 * MS_PER_DAY);

    const outcome = clusterHop({
      db,
      params,
      seedIds: ['m-seed'],
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    const ids = outcome.candidates.map((candidate) => candidate.memoryId);
    expect(ids).toContain('m-fresh');
    // ⚠️ **衰减后的值**（不是存储值）
    const fresh = outcome.candidates.find((candidate) => candidate.memoryId === 'm-fresh');
    expect(fresh?.affinityEff).toBeCloseTo(0.9, 12);
    const stale = outcome.candidates.find((candidate) => candidate.memoryId === 'm-stale');
    expect(stale).toBeDefined();
    // ⚠️ ★ **衰减后远小于存储值**（0.9 ⇒ ~6.6e-5）
    expect(stale?.affinityEff ?? 1).toBeLessThan(0.001);

    // ⚠️ ★ **陈旧的那条进不了 diffused**（`bonus < ACTIVATION_MIN` ⇒ 被阈值挡下）
    const diffused = runDiffusion(db, params, ['m-seed']);
    expect(diffused.items.map((item) => item.id)).toEqual(['m-fresh']);
  });

  it('★ 截断位置：**每条种子各取 `CLUSTER_TOPK`** ⇒ 总量 = 种子数 × `CLUSTER_TOPK`', () => {
    const db = createDb();
    const { params } = createStore();
    const seedIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const seedId = `m-seed-${index}`;
      seedIds.push(seedId);
      insertMemory(db, seedId);
      const members = [seedId];
      for (let neighbor = 0; neighbor < 6; neighbor += 1) {
        const neighborId = `m-n-${index}-${neighbor}`;
        insertMemory(db, neighborId);
        members.push(neighborId);
        insertCoact(db, neighborId, seedId, 0.5 + neighbor * 0.05);
      }
      insertCluster(db, `c-${index}`, members);
    }

    const outcome = clusterHop({
      db,
      params,
      seedIds,
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    // ⚠️ **5 条种子 × CLUSTER_TOPK(3) = 15 条**（不是「全局取前 3」，也不是「全局取前 15」）
    expect(params.CLUSTER_TOPK).toBe(3);
    expect(outcome.candidates).toHaveLength(15);
    // ⚠️ **每条种子恰好 3 条**
    for (const seedId of seedIds) {
      expect(outcome.candidates.filter((candidate) => candidate.seedId === seedId)).toHaveLength(3);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、实体跳（§4.7）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T04 · 实体跳与累积表（§4.7）', () => {
  it('★ ★ **多路径累加生效**：同一记忆经**不同实体**被访问 ⇒ `diffusionScore` 累加', () => {
    const db = createDb();
    const { params } = createStore();
    // ── 目标记忆 m 挂在**两个不同的邻居实体**上（e-8 / e-9）──
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-8');
    linkEntity(db, 'm-target', 'e-9');
    // ── 两条种子，各走一条边到不同的邻居实体 ──
    insertMemory(db, 'm-s1');
    linkEntity(db, 'm-s1', 'e-1');
    insertMemory(db, 'm-s2');
    linkEntity(db, 'm-s2', 'e-2');
    insertEdge(db, 'ed-1', 'e-1', 'e-8', 0.8);
    insertEdge(db, 'ed-2', 'e-2', 'e-9', 0.8);

    const outcome = runDiffusion(db, params, ['m-s1', 'm-s2']);

    // ⚠️ **前提自检**：确实产出了候选
    expect(outcome.items).toHaveLength(1);
    // ⚠️ ★ **两条路径各加 0.2 ⇒ 0.4**（不是「取最后一次」的 0.2）
    expect(scoreOf(outcome, 'm-target')).toBeCloseTo(0.4, 12);
  });

  it('★ 同一 `(记忆, 实体)` 组合**只加一次**（去重键含 entityId）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-8');
    insertMemory(db, 'm-s1');
    linkEntity(db, 'm-s1', 'e-1');
    // ⚠️ **两条不同的边**指向**同一个**邻居实体 ⇒ 键相同 ⇒ 只加一次
    insertEdge(db, 'ed-1', 'e-1', 'e-8', 0.8);
    insertEdge(db, 'ed-2', 'e-1', 'e-8', 0.8);

    const outcome = runDiffusion(db, params, ['m-s1']);

    expect(scoreOf(outcome, 'm-target')).toBeCloseTo(0.2, 12);
  });

  it('★ `viaEntity` 给的是**实体名**（§6：调用方要的是「沿哪条路」）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-8');
    insertMemory(db, 'm-s1');
    linkEntity(db, 'm-s1', 'e-1');
    insertEdge(db, 'ed-1', 'e-1', 'e-8', 0.8);

    const outcome = runDiffusion(db, params, ['m-s1']);

    const item = outcome.items[0];
    expect(item?.viaEntity).toBe('e-8');
    expect(item?.viaClusterId).toBeUndefined();
  });

  it('★ 种子**不带实体** ⇒ 记进 `skippedNoEntity`（诊断口径）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-no-entity');

    const outcome = runDiffusion(db, params, ['m-no-entity']);

    expect(outcome.skippedNoEntity).toBe(1);
    expect(outcome.items).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、预算（§4.7 / §4.14.1）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T04 · 预算必须记在「边」上（§4.7 的硬约束）', () => {
  /**
   * 造一个「枢纽实体」世界：
   *   种子 s1 → 枢纽实体 E；E 有 **10 条边**全部指向**同一个**邻居实体 N；N ↔ 记忆 m。
   *   ⇒ 每条边都产出**同一个 `(m, N)` 键** ⇒ `visited` **一个都不增**（饱和在 1）
   *   ⇒ 用 `visited.size` 当预算 ⇒ 挡不住任何东西；用 `scanned` 当预算 ⇒ 挡得住。
   */
  function seedHubWorld(db: Database.Database, edgeCount: number): void {
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-n');
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-hub');
    for (let index = 0; index < edgeCount; index += 1) {
      insertEdge(db, `ed-${index}`, 'e-hub', 'e-n', 0.8);
    }
  }

  it('★ `visited.size` **挡不住**枢纽实体的重复遍历 ⇒ 预算必须记在边上', () => {
    const db = createDb();
    const { params } = createStore({ MAX_DIFFUSED_VISITS: 3 });
    seedHubWorld(db, 10);

    const outcome = runDiffusion(db, params, ['m-seed']);

    // ⚠️ **前提自检**：这个世界的边数远大于预算（10 > 3）
    expect(params.MAX_DIFFUSED_VISITS).toBe(3);
    // ★ **处理的边数恰好卡在预算上**（`visited.size` 的话会是 10）
    expect(outcome.scanned).toBe(3);
    expect(outcome.budgetExhausted).toBe(true);
  });

  it('★ **共享预算**：两腿合计处理的边数 ≤ `MAX_DIFFUSED_VISITS`（§4.14.1）', () => {
    const db = createDb();
    const { params } = createStore({ MAX_DIFFUSED_VISITS: 5 });
    // ── 实体跳的世界：3 条边 ──
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-n');
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-hub');
    for (let index = 0; index < 3; index += 1) {
      insertEdge(db, `ed-${index}`, 'e-hub', 'e-n', 0.8);
    }
    // ── 簇跳的世界：再给 4 条共激活行（簇跳的「边」）──
    insertCluster(db, 'c-1', ['m-seed', 'm-target']);
    for (let index = 0; index < 4; index += 1) {
      insertMemory(db, `m-n-${index}`);
      insertCoact(db, `m-n-${index}`, 'm-seed', 0.9);
    }

    const outcome = runDiffusion(db, params, ['m-seed']);

    // ⚠️ **两腿合计** ≤ 预算（若各给一份 ⇒ 最多能处理 5 + 5 = 10 条）
    expect(outcome.scanned).toBeLessThanOrEqual(params.MAX_DIFFUSED_VISITS);
    expect(outcome.scanned).toBe(5);
  });

  it('★ `diffusionScore` 的**上界** ≤ `MAX_DIFFUSED_VISITS × ACTIVATION_DECAY`', () => {
    const db = createDb();
    const { params } = createStore();
    // ── 一条记忆经**很多条路径**被访问（每条路径 0.2）──
    insertMemory(db, 'm-target');
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-hub');
    const pathCount = 20;
    for (let index = 0; index < pathCount; index += 1) {
      const entityId = `e-${index}`;
      linkEntity(db, 'm-target', entityId);
      insertEdge(db, `ed-${index}`, 'e-hub', entityId, 0.8);
    }

    const outcome = runDiffusion(db, params, ['m-seed']);

    const score = scoreOf(outcome, 'm-target');
    expect(score).toBeDefined();
    const upperBound = params.MAX_DIFFUSED_VISITS * params.ACTIVATION_DECAY;
    expect(score ?? 0).toBeLessThanOrEqual(upperBound + 1e-12);
    // ⚠️ **实际值确实可以超过 1**（⇒ 它**不是** 0~1 的置信度）
    expect(score ?? 0).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、两腿合并（§4.14.4）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T04 · 两腿合并取 max（§4.14.4）', () => {
  /** 造一个「两条腿都命中同一条记忆」的世界。 */
  function seedBothLegsWorld(
    db: Database.Database,
    edgeWeight: number,
    coactAffinity: number,
  ): void {
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-a');
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-b');
    // ── 实体跳那条腿：边权 `edgeWeight` ⇒ bonus = 0.2 × (w / 0.8) ──
    insertEdge(db, 'ed-1', 'e-a', 'e-b', edgeWeight);
    // ── 簇跳那条腿：affinity `coactAffinity` ⇒ bonus = 0.4 × affinity_eff ──
    insertCluster(db, 'c-1', ['m-seed', 'm-target']);
    insertCoact(db, 'm-seed', 'm-target', coactAffinity);
  }

  it('★ 「实体跳 0.2 / 簇跳 0.3」⇒ 合并分 **0.3**（不是 0.5）', () => {
    const db = createDb();
    const { params } = createStore();
    seedBothLegsWorld(db, 0.8, 0.75);

    const outcome = runDiffusion(db, params, ['m-seed']);

    // ⚠️ **前提自检**：确实产出了一条
    expect(outcome.items).toHaveLength(1);
    // ★ **取 max**（累加会是 0.5）
    expect(scoreOf(outcome, 'm-target')).toBeCloseTo(0.3, 12);
  });

  it('★ 「簇跳 0.2 / 实体跳 0.3」⇒ 合并分 **0.3**（不是 0.5）', () => {
    const db = createDb();
    const { params } = createStore();
    // 实体跳：w = 1.2 ⇒ 0.2 × (1.2 / 0.8) = 0.3；簇跳：0.4 × 0.5 = 0.2
    seedBothLegsWorld(db, 1.2, 0.5);

    const outcome = runDiffusion(db, params, ['m-seed']);

    expect(scoreOf(outcome, 'm-target')).toBeCloseTo(0.3, 12);
  });

  it('★ `viaEntity` / `viaClusterId` **恰有一个有值**（§6）', () => {
    const db = createDb();
    const { params } = createStore();
    seedBothLegsWorld(db, 0.8, 0.75);

    const outcome = runDiffusion(db, params, ['m-seed']);

    const item = outcome.items[0];
    expect(item).toBeDefined();
    // ⚠️ **簇跳赢了** ⇒ `viaClusterId` 有值、`viaEntity` 没有
    expect(item?.viaClusterId).toBe('c-1');
    expect(item?.viaEntity).toBeUndefined();
    // ⚠️ **结构上**：两者**不可能同时有值**
    expect((item?.viaEntity !== undefined) !== (item?.viaClusterId !== undefined)).toBe(true);
  });

  it('★ 实体跳单独命中 ⇒ `viaEntity` 有值、`viaClusterId` 没有', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-a');
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-b');
    insertEdge(db, 'ed-1', 'e-a', 'e-b', 0.8);

    const outcome = runDiffusion(db, params, ['m-seed']);

    const item = outcome.items[0];
    expect(item?.viaEntity).toBe('e-b');
    expect(item?.viaClusterId).toBeUndefined();
  });

  it('★ 簇跳单独命中 ⇒ `viaClusterId` 有值、`viaEntity` 没有', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-seed');
    insertMemory(db, 'm-target');
    insertCluster(db, 'c-1', ['m-seed', 'm-target']);
    insertCoact(db, 'm-seed', 'm-target', 0.9);

    const outcome = runDiffusion(db, params, ['m-seed']);

    const item = outcome.items[0];
    expect(item?.viaClusterId).toBe('c-1');
    expect(item?.viaEntity).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、归档口径（§4.7 R-ARCH-DIFF / §4.14.5）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T04 · 归档口径两腿一致（§4.14.5）', () => {
  /** 造一条**已归档**的记忆（强度 ≤ `ARCHIVE_LINE`）。 */
  function insertArchivedMemory(db: Database.Database, id: string): void {
    // ⚠️ `stability = 1` 天、`lastAccess = 30` 天前 ⇒ intensity = exp(-30) ≈ 9.4e-14 ≤ 0.05
    insertMemory(db, id, { stability: 1, lastAccess: NOW - 30 * MS_PER_DAY });
  }

  it('★ `diffuseArchived: false` ⇒ **两腿都过滤**归档', () => {
    const db = createDb();
    const { params } = createStore();
    // ── 实体跳那条腿产出归档记忆 ──
    insertArchivedMemory(db, 'm-arch');
    linkEntity(db, 'm-arch', 'e-b');
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-a');
    insertEdge(db, 'ed-1', 'e-a', 'e-b', 0.8);
    // ── 簇跳那条腿产出**另一条**归档记忆 ──
    insertArchivedMemory(db, 'm-arch2');
    insertCluster(db, 'c-1', ['m-seed', 'm-arch2']);
    insertCoact(db, 'm-seed', 'm-arch2', 0.9);

    const outcome = runDiffusion(db, params, ['m-seed'], { diffuseArchived: false });

    // ⚠️ **两腿的归档记忆都被过滤掉了**
    expect(outcome.items.map((item) => item.id)).not.toContain('m-arch');
    expect(outcome.items.map((item) => item.id)).not.toContain('m-arch2');
  });

  it('★ `diffuseArchived: true`（默认）⇒ 归档记忆**可以出现**，且带 `archived` 层标记', () => {
    const db = createDb();
    const { params } = createStore();
    insertArchivedMemory(db, 'm-arch');
    linkEntity(db, 'm-arch', 'e-b');
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-a');
    insertEdge(db, 'ed-1', 'e-a', 'e-b', 0.8);

    const outcome = runDiffusion(db, params, ['m-seed']);

    const item = outcome.items.find((entry) => entry.id === 'm-arch');
    expect(item).toBeDefined();
    expect(item?.layer).toBe('archived');
  });

  it('★ 归档过滤**发生在两腿合并之后** ⇒ 存活项的 `layer` 标记与强度一致', () => {
    const db = createDb();
    const { params } = createStore();
    // ── 一条**生效**的记忆（实体跳产出）──
    insertMemory(db, 'm-live', { stability: 10, lastAccess: NOW - 2 * MS_PER_DAY });
    linkEntity(db, 'm-live', 'e-b');
    insertMemory(db, 'm-seed');
    linkEntity(db, 'm-seed', 'e-a');
    insertEdge(db, 'ed-1', 'e-a', 'e-b', 0.8);
    // ── 一条**归档**的记忆（簇跳产出）──
    insertArchivedMemory(db, 'm-arch');
    insertCluster(db, 'c-1', ['m-seed', 'm-arch']);
    insertCoact(db, 'm-seed', 'm-arch', 0.9);

    const outcome = runDiffusion(db, params, ['m-seed'], { diffuseArchived: false });

    // ⚠️ **归档的那条被过滤**，生效的那条留下
    expect(outcome.items.map((item) => item.id)).toEqual(['m-live']);
    // ⚠️ **layer 标记一致**（不是 `archived` ⇒ 也不是被误标）
    expect(outcome.items[0]?.layer).not.toBe('archived');
    expect(outcome.items[0]?.intensity).toBeGreaterThan(params.ARCHIVE_LINE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、截断与开关
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T04 · 截断与机制开关', () => {
  it('★ 两腿合计**至多 `MAX_DIFFUSED_NODES`(20) 条**', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-seed');
    // ── 30 个不同的目标（每条走一条不同的边 ⇒ 30 条候选）──
    for (let index = 0; index < 30; index += 1) {
      const targetId = `m-t-${index}`;
      const entityId = `e-${index}`;
      insertMemory(db, targetId);
      linkEntity(db, targetId, entityId);
      insertEdge(db, `ed-${index}`, 'e-hub', entityId, 0.8);
    }
    linkEntity(db, 'm-seed', 'e-hub');

    const outcome = runDiffusion(db, params, ['m-seed']);

    expect(params.MAX_DIFFUSED_NODES).toBe(20);
    expect(outcome.items.length).toBeLessThanOrEqual(params.MAX_DIFFUSED_NODES);
    // ⚠️ **前提自检**：候选确实多于上限（否则这条断言是空的）
    expect(outcome.scanned).toBe(30);
  });

  it('★ 机制开关 `coactivation: false` ⇒ **联想路与簇跳都不执行**（§5）', () => {
    const db = createDb();
    const { params } = createStore({ coactivation: false });
    insertMemory(db, 'm-seed');
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-b');
    linkEntity(db, 'm-seed', 'e-a');
    insertEdge(db, 'ed-1', 'e-a', 'e-b', 0.8);
    insertCluster(db, 'c-1', ['m-seed', 'm-target']);
    insertCoact(db, 'm-seed', 'm-target', 0.9);

    const outcome = runDiffusion(db, params, ['m-seed']);

    expect(outcome.items).toHaveLength(0);
    expect(outcome.scanned).toBe(0);
  });

  it('★ 扩散**不写库**（只读路径）', () => {
    const db = createDb();
    const { params } = createStore();
    insertMemory(db, 'm-seed');
    insertMemory(db, 'm-target');
    linkEntity(db, 'm-target', 'e-b');
    linkEntity(db, 'm-seed', 'e-a');
    insertEdge(db, 'ed-1', 'e-a', 'e-b', 0.8);

    const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    const outcome = runDiffusion(db, params, ['m-seed']);
    const after = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };

    expect(outcome.items).toHaveLength(1);
    expect(after.n).toBe(before.n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 八、集成：召回流水线里的扩散
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 造一个「**抑制确实发生** + **扩散确实产出**」的世界。
 *
 * ⚠️ **两条事实同时成立** ⇒ 「抑制开 / 关 ⇒ diffused 逐条相同」这条断言**不是空洞的**。
 */
function seedRecallWorld(db: Database.Database): void {
  // ── m-a / m-b 共享两个实体 ⇒ 冗余（实体路径）⇒ 抑制会把 m-b 挤掉 ──
  insertMemory(db, 'm-a', {
    content: '猫粮品牌偏好记录',
    entities: ['e-1', 'e-2'],
    lastAccess: NOW - 1 * 60 * 60 * 1000,
  });
  insertMemory(db, 'm-b', {
    content: '猫粮品牌采购记录',
    entities: ['e-1', 'e-2', 'e-5'],
    lastAccess: NOW - 2 * 60 * 60 * 1000,
  });
  insertMemory(db, 'm-c', {
    content: '猫粮品牌厂商名单',
    entities: ['e-3'],
    lastAccess: NOW - 3 * 60 * 60 * 1000,
  });
  // ── m-d：**文本路召不到**（正文不含「猫粮品牌」）⇒ 只能靠扩散被捞出来 ──
  insertMemory(db, 'm-d', {
    content: '仓库盘点清单',
    entities: ['e-4'],
    lastAccess: NOW - 2 * MS_PER_DAY,
  });
  // ── 边：m-a / m-b 的实体 e-1 → e-4 ⇒ 实体跳能捞到 m-d ──
  insertEdge(db, 'ed-1', 'e-1', 'e-4', 0.8);
  // ── 共激活 + 簇：簇跳也能捞到 m-d ──
  insertCoact(db, 'm-a', 'm-d', 0.75);
  insertCluster(db, 'c-1', ['m-a', 'm-d']);
  // ⚠️ ★ **m-b 有自己的「专属路径」**（实体 e-5 → e-6 ⇒ m-e）。
  //   ⚠️ **为什么必须有这一段**：若 m-a / m-b / m-c 触达的扩散结果**完全一样**，
  //   那「种子取抑制前 topN」与「种子取抑制后 hits」就**不可区分**
  //   ⇒ 「抑制不作用于 diffused」那条断言会退化成**恒绿守卫**。
  //   ⇒ m-e **只**能由 m-b 触达 ⇒ 抑制把 m-b 挤掉之后，种子若取抑制后的 hits，
  //   m-e 就会消失 ⇒ 两腿的种子口径一旦漂移，这条断言立刻变红。
  insertMemory(db, 'm-e', {
    content: '货架清单',
    entities: ['e-6'],
    lastAccess: NOW - 2 * MS_PER_DAY,
  });
  insertEdge(db, 'ed-2', 'e-5', 'e-6', 0.8);
}

describe('P3-T04 · 集成：扩散接进召回流水线', () => {
  it('★ ★ **抑制不作用于 diffused**（§4.13.1 硬约束③）—— 抑制开 / 关 ⇒ `diffused` 逐条相同', () => {
    const on = createStore();
    seedRecallWorld(on.db);
    const off = createStore({ inhibition: false });
    seedRecallWorld(off.db);

    const withInhibition = recall(on.store, { context: '猫粮品牌', now: NOW });
    const withoutInhibition = recall(off.store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检①：**抑制确实发生了**（否则这条对比是空洞的）──
    expect(withInhibition.suppressed).toHaveLength(1);
    expect(withInhibition.hits.length).toBeLessThan(withoutInhibition.hits.length);
    // ── 前提自检②：**扩散确实产出了东西**（这正是 P3-T02 留的那条账）──
    expect(withInhibition.diffused.length).toBeGreaterThan(0);
    expect(withoutInhibition.diffused.length).toBeGreaterThan(0);
    // ⚠️ ★ **前提自检③：扩散结果里有一条「只有被抑制的那条种子才触达得到」的**
    //   （`m-e` 只能由 `m-b` 触达）⇒ 种子口径一旦从「抑制前 topN」漂移到「抑制后 hits」，
    //   `m-e` 就会消失 ⇒ 这条断言**不是恒绿守卫**。
    expect(withInhibition.diffused.map((item) => item.id).sort()).toEqual(['m-d', 'm-e']);
    expect(withoutInhibition.diffused.map((item) => item.id).sort()).toEqual(['m-d', 'm-e']);

    // ★ **逐条相同**（抑制没有碰 diffused）
    expect(withInhibition.diffused).toEqual(withoutInhibition.diffused);
  });

  it('★ `diffusionScore` **不参与五项公式**：`Hit.score` 恒等于五项加权和、`breakdown` 里没有扩散项', () => {
    const { db, store } = createStore();
    seedRecallWorld(db);

    const result = recall(store, { context: '猫粮品牌', now: NOW, explain: true });

    // ⚠️ **前提自检**：扩散确实产出了东西（否则这条断言是空的）
    expect(result.diffused.length).toBeGreaterThan(0);
    const hit = result.hits[0];
    expect(hit).toBeDefined();
    expect(hit?.breakdown).toBeDefined();
    const breakdown = hit?.breakdown;
    // ⚠️ **五项之和 == score**（≤ 1e-9）
    const sum =
      (breakdown?.intensityPart ?? 0) +
      (breakdown?.vectorPart ?? 0) +
      (breakdown?.textPart ?? 0) +
      (breakdown?.graphPart ?? 0) +
      (breakdown?.recencyPart ?? 0);
    expect(Math.abs(sum - (hit?.score ?? 0))).toBeLessThanOrEqual(1e-9);
    // ⚠️ **`breakdown` 里没有任何扩散项**（§4.13.1①：抑制信息不进 breakdown，扩散同理）
    expect(Object.keys(breakdown ?? {}).sort()).toEqual([
      'cos',
      'graphPart',
      'intensityPart',
      'rawBm25',
      'recencyPart',
      'textPart',
      'vectorPart',
    ]);
    // ⚠️ **扩散结果不进 hits**
    const hitIds = result.hits.map((item) => item.id);
    for (const item of result.diffused) {
      expect(hitIds).not.toContain(item.id);
    }
  });

  it('★ `explain.diffusion` 给出**真实**的诊断计数（不再是恒零）', () => {
    const { db, store } = createStore();
    seedRecallWorld(db);

    const result = recall(store, { context: '猫粮品牌', now: NOW, explain: true });

    expect(result.explain?.diffusion.scanned).toBeGreaterThan(0);
    expect(result.explain?.diffusion.scanned).toBeLessThanOrEqual(
      DEFAULT_PARAMS.MAX_DIFFUSED_VISITS,
    );
  });

  it('★ 事件里的 `diffusedSeeds` **恒带该键**且内容是真正贡献了扩散的种子', () => {
    const { db, store } = createStore();
    seedRecallWorld(db);

    recall(store, { context: '猫粮品牌', now: NOW, explain: true });

    const row = db
      .prepare("SELECT payload FROM events WHERE type = 'recall' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string };
    const payload = JSON.parse(row.payload) as { diffusedSeeds: string[] };
    // ⚠️ **键恒在**（§4.6 步骤 4）
    expect(payload.diffusedSeeds).toBeDefined();
    expect(payload.diffusedSeeds.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 九、负控（证明上面的断言不是恒真）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T04 · 负控', () => {
  it('★ 簇跳的候选数**受 `CLUSTER_TOPK` 约束**（把 topK 改成 1 ⇒ 候选变少）', () => {
    const db = createDb();
    const { params } = createStore({ CLUSTER_TOPK: 1 });
    insertMemory(db, 'm-seed');
    const members = ['m-seed'];
    for (let index = 0; index < 4; index += 1) {
      const id = `m-n-${index}`;
      insertMemory(db, id);
      members.push(id);
      insertCoact(db, id, 'm-seed', 0.5 + index * 0.1);
    }
    insertCluster(db, 'c-1', members);

    const outcome: ClusterHopOutcome = clusterHop({
      db,
      params,
      seedIds: ['m-seed'],
      now: NOW,
      budget: params.MAX_DIFFUSED_VISITS,
    });

    expect(outcome.candidates).toHaveLength(1);
  });

  it('★ 同一份世界，`CLUSTER_BONUS` 改成 0 ⇒ 簇跳**不再产出**（加成系数真的在起作用）', () => {
    const db = createDb();
    const { params } = createStore({ CLUSTER_BONUS: 0 });
    insertMemory(db, 'm-seed');
    insertMemory(db, 'm-target');
    insertCluster(db, 'c-1', ['m-seed', 'm-target']);
    insertCoact(db, 'm-seed', 'm-target', 0.9);

    const outcome = runDiffusion(db, params, ['m-seed']);

    expect(outcome.items).toHaveLength(0);
  });
});
