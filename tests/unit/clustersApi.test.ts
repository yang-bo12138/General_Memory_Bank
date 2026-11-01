/**
 * §6 的 `clusters()` 只读导航接口 —— DEVELOPMENT-PLAN.md **P3-T05** 的硬断言。
 *
 * ⚠️ **覆盖面按计划稿 P3-T05「验收标准」逐条对应**：
 *   分流正确（缺省 ⇒ 快照 / 给了别的值 ⇒ 现场重算）/ `asOf` 与 `computedAt` 不是同一个东西 /
 *   两个覆盖率同刻 / `adoptedMemories` 的口径 / 成员排序键 / LIMIT 生效 /
 *   `key` 不是稳定标识 / `minSize`·`limit` 不触发重算 / **只读性**（不写库、不记事件）。
 *
 * ⚠️ ★ **额外钉住的三条语义**（主理人点名的「设计要点」）：
 *   ① **`size` 是活跃成员的实时 COUNT**（软删一条 ⇒ size 减一 ⇒ **不是**快照里的存储值）；
 *   ② **`clusterId`（持久簇 id）与 `key`（簇内最小成员 id）是两回事**（key 会变、clusterId 不会）；
 *   ③ **快照之间不保证连续**（同一条记忆在相邻两个快照里可能属于不同簇 ⇒ **这不是 bug**）。
 *
 * ⚠️ **断言必须真能失败**（否则是假绿）：
 *   · 「不写库」用**全库内容哈希**（逐表逐行）+ **events 行数**双保险；
 *   · 「size 是实时 COUNT」同时断言**快照里的存储值没变**（否则「改成存储值」也能绿）；
 *   · 每条「不发生」型断言都配一条对应的「发生」型断言。
 *
 * ⚠️ **本文件用真实的内存库**（不是 mock）：CHECK 约束、FTS5、事务与快照的冻结语义
 *   都只有真库才验得了。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { createSchema } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import {
  CLUSTER_ALGO_VERSION,
  type ClustersOptions,
  type ClustersResult,
  clusters,
  countAdoptedMemories,
  recluster,
} from '../../src/store/clusters.js';
import { EventWriter } from '../../src/store/events.js';
import { MemoryLogger } from '../../src/util/log.js';
import { insertEntity, insertMemory } from '../fixtures/graph-store.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 固定的「现在」（epoch 毫秒，2023-11-14）——**刻意是过去** ⇒ 「慢算」场景可构造。 */
const NOW = 1_700_000_000_000;

/** 超过一次重算的最小间隔（`CLUSTER_RECALC_INTERVAL_MS` 默认 1 小时）。 */
const AFTER_INTERVAL = DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS + 1;

/**
 * 建一个内存库 + store 上下文（`recluster` 需要事件写入器；`clusters` 不需要）。
 *
 * ⚠️ ★ **默认覆盖两个簇参数**（`MAX_CLUSTER_SHARE = 1` / `CLUSTER_MAX_FRACTION = 1`）：
 *   **本文件测的是 `clusters()` 的呈现层**，不是 P3-T03 的聚类算法。
 *   ⚠️ 默认参数下 `targetMax = max(2, floor(0.02 × 总数))` ⇒ **小库里这个上限就是 2**
 *     ⇒ 任何超过 2 个成员的连通分量都会被**兜底切分** ⇒ 本文件的断言会变成「在测切分」。
 *   ⇒ 关掉切分 ⇒ 簇 = 自然的连通分量 ⇒ 断言的是 `clusters()` 自己。
 *   （切分算法本身由 `tests/unit/cluster.test.ts` 负责。）
 */
function createStore(patch: Partial<Params> = {}): {
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
  const params: Params = {
    ...DEFAULT_PARAMS,
    MAX_CLUSTER_SHARE: 1,
    CLUSTER_MAX_FRACTION: 1,
    ...patch,
  };
  return { db, store: { db, params, events }, params };
}

/** 插一条共激活边（`CHECK (memory_a < memory_b)` ⇒ 内部归一）。 */
function insertCoact(
  db: Database.Database,
  left: string,
  right: string,
  affinity: number,
  lastActive = NOW,
): void {
  const [a, b] = left < right ? [left, right] : [right, left];
  db.prepare(
    `INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
     VALUES (?, ?, ?, 1, 0, ?)`,
  ).run(a, b, affinity, lastActive);
}

/** 把一条记忆挂到一个实体上。 */
function linkEntity(db: Database.Database, memoryId: string, entityId: string): void {
  db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
    memoryId,
    entityId,
  );
}

/** 软删一条记忆（模拟「被遗忘」）。 */
function softDelete(db: Database.Database, id: string): void {
  db.prepare('UPDATE memories SET deleted = 1, deleted_at = ? WHERE id = ?').run(NOW, id);
}

/**
 * 基础夹具（**每次用例重建** ⇒ 用例之间零耦合）：
 *
 * ```
 *   m-1 ──0.5── m-2 ──0.3── m-3      ┐ 簇 A：四个人
 *                   └──0.2── m-4      ┘
 *   m-9 ──0.4── m-10                   簇 B：两个人
 *   m-7                                孤岛（无任何共激活边 ⇒ 不在任何簇里）
 * ```
 *
 * 实体分布：`张三` × 3（m-1/m-2/m-3）、`李四` × 2（m-1/m-2）、`王五` × 1（m-4）
 * ⇒ 簇 A 的 `entities` 应该是 `['张三', '李四', '王五']`（频次降序）。
 */
function seedBasicGraph(db: Database.Database): void {
  insertMemory(db, 'm-1', { accessCount: 1 });
  insertMemory(db, 'm-2', { accessCount: 1 });
  insertMemory(db, 'm-3', { accessCount: 1 });
  insertMemory(db, 'm-4', { accessCount: 0 });
  insertMemory(db, 'm-7', { accessCount: 1 });
  insertMemory(db, 'm-9', { accessCount: 1 });
  insertMemory(db, 'm-10', { accessCount: 0 });

  insertCoact(db, 'm-1', 'm-2', 0.5);
  insertCoact(db, 'm-2', 'm-3', 0.3);
  insertCoact(db, 'm-2', 'm-4', 0.2);
  insertCoact(db, 'm-9', 'm-10', 0.4);

  insertEntity(db, 'e-zhang', '张三');
  insertEntity(db, 'e-li', '李四');
  insertEntity(db, 'e-wang', '王五');
  linkEntity(db, 'm-1', 'e-zhang');
  linkEntity(db, 'm-2', 'e-zhang');
  linkEntity(db, 'm-3', 'e-zhang');
  linkEntity(db, 'm-1', 'e-li');
  linkEntity(db, 'm-2', 'e-li');
  linkEntity(db, 'm-4', 'e-wang');
}

/** 找出包含某个成员的簇（簇 id 是哈希 ⇒ **不能靠下标**）。 */
function clusterOf(result: ClustersResult, memberId: string): ClustersResult['clusters'][number] {
  const found = result.clusters.find((cluster) => cluster.memberIds.includes(memberId));
  if (found === undefined) {
    throw new Error(`没有簇包含 ${memberId}`);
  }
  return found;
}

/**
 * ★ **全库内容哈希**（逐表逐行 ⇒ 任何写入都会改变它）。
 *
 * ⚠️ **刻意只哈希业务表**（不含 FTS5 的影子表）：影子表的内部页与读操作无关，
 *   而业务表才是「库的业务状态」⇒ 哈希稳定才有断言价值。
 */
function dbContentHash(db: Database.Database): string {
  const hash = createHash('sha1');
  const tables = [
    'memories',
    'entities',
    'entity_aliases',
    'memory_entities',
    'edges',
    'content_history',
    'events',
    'coacts',
    'theme_clusters',
    'theme_cluster_members',
    'cluster_snapshot_meta',
    'meta',
    'archival_schedule',
  ];
  for (const table of tables) {
    hash.update(`--${table}\n`);
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    // ⚠️ **排序后再哈希** ⇒ 与插入顺序无关（断言的是「内容没变」，不是「顺序没变」）。
    for (const line of rows.map((row) => JSON.stringify(row)).sort()) {
      hash.update(`${line}\n`);
    }
  }
  return hash.digest('hex');
}

/** 读事件行数。 */
function countEvents(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
  return row.n;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、只读性（§6 / §7.1：不写库、不写 events、不更新 last_access）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · `clusters()` 是**纯读**（§6 的只读导航）', () => {
  it('★ 调用前后**全库内容哈希相同**且 **events 行数不变**', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const hashBefore = dbContentHash(db);
    const eventsBefore = countEvents(db);
    // ⚠️ **前提自检**：确实有事件（`recluster` 记了一条）⇒ 「事件数不变」不是恒真。
    expect(eventsBefore).toBeGreaterThan(0);

    clusters({ db, params }, undefined, NOW);

    expect(dbContentHash(db)).toBe(hashBefore);
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it('★ 调用前后**记忆的 `last_access` / `access_count` 不变**（不碰任何时间派生字段）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const before = db
      .prepare('SELECT id, last_access, access_count FROM memories ORDER BY id')
      .all();
    clusters({ db, params }, { minAffinity: 0.9 }, NOW);
    const after = db
      .prepare('SELECT id, last_access, access_count FROM memories ORDER BY id')
      .all();

    expect(after).toEqual(before);
  });

  it('★ **只读实例上可直接调用**（§7.1 的「7 个允许读的方法」之一）⇒ 不抛 `READONLY_VIOLATION`', () => {
    // ⚠️ **临时目录不清理**：门面**刻意没有 `close()`**（§6 的公开面里没有它）
    //   ⇒ 句柄要到进程退出才释放；Windows 上此时删不掉那个目录。
    //   与仓库既有测试（`tests/unit/memory-store.test.ts` 等）同一口径：**临时目录留在系统 temp 下**。
    const workDir = mkdtempSync(join(tmpdir(), 'memory-ocean-clusters-ro-'));
    const dbPath = join(workDir, 'clusters.db');

    // ── 先用可写句柄造数据（只读句柄需要真实文件）──
    const rw = new Database(dbPath);
    createSchema(rw);
    seedBasicGraph(rw);
    recluster(
      {
        db: rw,
        params: DEFAULT_PARAMS,
        events: new EventWriter(rw, {
          readonly: false,
          logger: new MemoryLogger(),
          now: () => 0,
        }),
      },
      NOW,
    );
    rw.close();

    // ⚠️ **文件哈希**：只读句柄上的读取**不得**改动库文件。
    const hashBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex');

    const readonlyStore = new MemoryStore({ dbPath, readonly: true });
    const result = readonlyStore.clusters();

    expect(result.clusters.length).toBeGreaterThan(0);
    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(hashBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、分流（§6 的物化 / 现场重算规则）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 物化 / 现场重算的分流（按 `minAffinity` 判）', () => {
  it('★ `minAffinity` 缺省 ⇒ 读**已发布快照**（`computedAt` 与上次 `recluster` 一致）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    const published = recluster(store, NOW);
    expect(published.computed).toBe(true);

    // ⚠️ **传入一个不同的 `now`** ⇒ 快照路径上 `now` **不参与 `asOf`**
    const result = clusters({ db, params }, undefined, NOW + 999);

    expect(result.computedAt).toBe(NOW);
    expect(result.asOf).toBe(NOW);
    expect(result.algoVersion).toBe(CLUSTER_ALGO_VERSION);
  });

  it('★ `minAffinity` 显式给了**别的值** ⇒ **现场重算**（`asOf == 传入的 now`）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const at = NOW + 999;
    const result = clusters({ db, params }, { minAffinity: params.COACT_AFFINITY_MIN + 0.01 }, at);

    expect(result.asOf).toBe(at);
    // ⚠️ **前提自检**：现场重算出来的簇**与快照**不是同一份（`computedAt` 变成真实时钟）
    expect(result.computedAt).not.toBe(NOW);
  });

  it('★ ★ **分流比对的是「快照自己记录的阈值」**，不是常量 `COACT_AFFINITY_MIN`', () => {
    // ⚠️ 快照用阈值 **0.20** 发布，而**参数表**里的阈值是 0.15
    const { db, store, params } = createStore({ COACT_AFFINITY_MIN: 0.2 });
    seedBasicGraph(db);
    recluster(store, NOW);
    const meta = db
      .prepare('SELECT min_affinity FROM cluster_snapshot_meta WHERE id = 1')
      .get() as {
      min_affinity: number;
    };
    expect(meta.min_affinity).toBe(0.2);

    // ⚠️ 调用的阈值 = **参数表里的那个**（0.15）⇒ **≠ 快照阈值**（0.2）⇒ **必须现场重算**
    const at = NOW + 999;
    const result = clusters({ db, params }, { minAffinity: 0.15 }, at);
    expect(result.asOf).toBe(at);

    // ⚠️ 负控：调用的阈值 **等于快照阈值** ⇒ 走快照路径（`asOf` = 快照的 asOf，不是传入的 now）
    const snapshotResult = clusters({ db, params }, { minAffinity: 0.2 }, at);
    expect(snapshotResult.asOf).toBe(NOW);
  });

  it('★ **还没有发布过快照** ⇒ 没有快照可读 ⇒ 现场重算（`asOf` = 传入的 `now`）', () => {
    const { db, params } = createStore();
    seedBasicGraph(db);
    const meta = db.prepare('SELECT COUNT(*) AS n FROM cluster_snapshot_meta').get() as {
      n: number;
    };
    expect(meta.n).toBe(0);

    const result = clusters({ db, params }, undefined, NOW);
    expect(result.asOf).toBe(NOW);
    expect(result.clusters.length).toBeGreaterThan(0);
  });

  it('★ ★ **`asOf` 与 `computedAt` 不是同一个东西**（慢算场景 ⇒ 两者不等）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    // ⚠️ **注入一个过去的 `now`** ⇒ 簇划分依据的是那个时刻（T），
    //   而本次快照的**生成时刻**是真实时钟（远晚于 T）⇒ 两者不等。
    const result = clusters({ db, params }, { minAffinity: 0.9 }, NOW);

    expect(result.asOf).toBe(NOW);
    expect(result.computedAt).toBeGreaterThan(result.asOf);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、`size` 是活跃成员的实时 COUNT（★ 存储值 ≠ 实时值）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · `size` = **活跃成员**的实时 COUNT（`deleted = 0`）', () => {
  it('★ 软删一条 ⇒ `size` 立刻减一（而**快照里的存储值不变** ⇒ 证明它不是存储值）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const before = clusters({ db, params }, undefined, NOW);
    const clusterBefore = clusterOf(before, 'm-1');
    expect(clusterBefore.size).toBe(4);

    // ⚠️ **快照里的存储值**（`theme_clusters.member_count`）此刻仍是 4
    const stored = db
      .prepare('SELECT member_count FROM theme_clusters WHERE cluster_id = ?')
      .get(clusterBefore.clusterId) as { member_count: number };
    expect(stored.member_count).toBe(4);

    softDelete(db, 'm-1');

    const after = clusters({ db, params }, undefined, NOW);
    const clusterAfter = clusterOf(after, 'm-2');
    expect(clusterAfter.size).toBe(3);

    // ⚠️ **存储值没变** ⇒ 「size 是实时 COUNT」这件事有了牙齿
    const storedAfter = db
      .prepare('SELECT member_count FROM theme_clusters WHERE cluster_id = ?')
      .get(clusterBefore.clusterId) as { member_count: number };
    expect(storedAfter.member_count).toBe(4);
  });

  it('★ 软删一条 ⇒ `key`（簇内最小**活跃**成员 id）跟着变', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const before = clusters({ db, params }, undefined, NOW);
    expect(clusterOf(before, 'm-1').key).toBe('m-1');

    softDelete(db, 'm-1');

    const after = clusters({ db, params }, undefined, NOW);
    expect(clusterOf(after, 'm-2').key).toBe('m-2');
  });

  it('★ `memberIds` 里**不含已软删的成员**', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);
    softDelete(db, 'm-1');

    const result = clusters({ db, params }, undefined, NOW);
    expect(clusterOf(result, 'm-2').memberIds).not.toContain('m-1');
  });

  it('★ `totalMembers` 随软删而变（**不是快照存储成员数之和**）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const before = clusters({ db, params }, undefined, NOW);
    expect(before.totalMembers).toBe(6);

    softDelete(db, 'm-1');

    const after = clusters({ db, params }, undefined, NOW);
    // ⚠️ **活跃成员数之和** 6 → 5（软删那条退出）
    expect(after.totalMembers).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、`clusterId`（持久簇 id）与 `key`（簇内最小成员 id）是两回事
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · `clusterId` ≠ `key`', () => {
  it('★ `key` = **簇内最小成员 id**；`clusterId` = **持久簇 id**（两者不是一回事）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    const cluster = clusterOf(result, 'm-1');

    expect(cluster.key).toBe('m-1');
    expect(cluster.clusterId).not.toBe('m-1');
    expect(cluster.clusterId).toMatch(/^c-/);
  });

  it('★ ★ **`key` 不是稳定标识**（成员变化 ⇒ key 变），但 **`clusterId` 不变**', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const before = clusters({ db, params }, undefined, NOW);
    const clusterBefore = clusterOf(before, 'm-1');

    softDelete(db, 'm-1');

    const after = clusters({ db, params }, undefined, NOW);
    const clusterAfter = clusterOf(after, 'm-2');

    expect(clusterAfter.key).not.toBe(clusterBefore.key);
    // ⚠️ **持久簇 id 不变** ⇒ 持有旧 id 的调用方仍能认出「还是那个簇」
    expect(clusterAfter.clusterId).toBe(clusterBefore.clusterId);
  });

  it('★ `originComponentId`（簇级分组键）= 簇 id 的血缘前缀', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    for (const cluster of result.clusters) {
      expect(cluster.originComponentId).toBeDefined();
      expect(cluster.clusterId.startsWith(cluster.originComponentId ?? '')).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、快照之间不保证连续（★ 这不是 bug）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 快照之间**不保证连续**（§4.12.3：「这不是 bug」）', () => {
  it('★ 同一条记忆在相邻两个快照里可能属于**不同的簇**', () => {
    const { db, store, params } = createStore();
    // 链式图：m-1 — m-2 — m-3 — m-4 ⇒ 一个簇
    insertMemory(db, 'm-1', { accessCount: 1 });
    insertMemory(db, 'm-2', { accessCount: 1 });
    insertMemory(db, 'm-3', { accessCount: 1 });
    insertMemory(db, 'm-4', { accessCount: 1 });
    insertCoact(db, 'm-1', 'm-2', 0.5);
    insertCoact(db, 'm-2', 'm-3', 0.4);
    insertCoact(db, 'm-3', 'm-4', 0.3);
    recluster(store, NOW);

    const first = clusters({ db, params }, undefined, NOW);
    const clusterOfM3First = clusterOf(first, 'm-3').clusterId;
    expect(first.clusters).toHaveLength(1);

    // ⚠️ **断开中间那条边** ⇒ 连通分量分裂 ⇒ m-3 换了一个簇
    db.prepare('DELETE FROM coacts WHERE memory_a = ? AND memory_b = ?').run('m-2', 'm-3');
    recluster(store, NOW + AFTER_INTERVAL);

    const second = clusters({ db, params }, undefined, NOW + AFTER_INTERVAL);
    const clusterOfM3Second = clusterOf(second, 'm-3').clusterId;

    expect(clusterOfM3Second).not.toBe(clusterOfM3First);
    // ⚠️ **前提自检**：分裂后确实有两个簇（⇒ 上面的差异不是「簇没了」造成的）
    expect(second.clusters).toHaveLength(2);
    expect(second.totalClusters).toBe(2);
  });

  it('★ 两次快照的**簇 id 集合没有交集**（簇本身变了，不是「同一个簇换了成员」）', () => {
    const { db, store, params } = createStore();
    insertMemory(db, 'm-1', { accessCount: 1 });
    insertMemory(db, 'm-2', { accessCount: 1 });
    insertMemory(db, 'm-3', { accessCount: 1 });
    insertCoact(db, 'm-1', 'm-2', 0.5);
    insertCoact(db, 'm-2', 'm-3', 0.4);
    recluster(store, NOW);
    const firstIds = clusters({ db, params }, undefined, NOW).clusters.map((c) => c.clusterId);

    db.prepare('DELETE FROM coacts WHERE memory_a = ? AND memory_b = ?').run('m-1', 'm-2');
    recluster(store, NOW + AFTER_INTERVAL);
    const secondIds = clusters({ db, params }, undefined, NOW + AFTER_INTERVAL).clusters.map(
      (c) => c.clusterId,
    );

    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、空快照的返回形态
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 空快照的返回形态（**不是抛错**）', () => {
  it('★ 从未发布过快照 + 没有任何共激活边 ⇒ 空数组 + 覆盖率 0', () => {
    const { db, params } = createStore();
    insertMemory(db, 'm-1', { accessCount: 1 });

    const result = clusters({ db, params }, undefined, NOW);

    expect(result.clusters).toEqual([]);
    expect(result.totalClusters).toBe(0);
    expect(result.totalMembers).toBe(0);
    expect(result.coveredMemories).toBe(0);
    expect(result.seedOnlyMemories).toBe(0);
    expect(result.coverage).toBe(0);
    expect(result.coverageOverAdopted).toBe(0);
    expect(result.largestClusterRatio).toBe(0);
    expect(result.maxRawComponentRatio).toBe(0);
    // ⚠️ **分母仍是真的**（全库未删记忆数 / 被采纳数）
    expect(result.totalMemories).toBe(1);
    expect(result.adoptedMemories).toBe(1);
  });

  it('★ 发布过一份**空快照**（零簇）⇒ 走快照路径，返回同样的空形态', () => {
    const { db, store, params } = createStore();
    insertMemory(db, 'm-1', { accessCount: 1 });
    const published = recluster(store, NOW);
    expect(published.computed).toBe(true);
    expect(published.clusterCount).toBe(0);

    const result = clusters({ db, params }, undefined, NOW + 5);

    expect(result.clusters).toEqual([]);
    expect(result.totalClusters).toBe(0);
    expect(result.coverage).toBe(0);
    // ⚠️ **走的是快照路径**（`computedAt` = 快照的生成时刻）
    expect(result.computedAt).toBe(NOW);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 八、覆盖率与采纳口径（§0.2.2：两个覆盖率必须同刻取数）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 覆盖率 / 采纳口径', () => {
  it('★ 两个覆盖率与它们的分子分母**同刻**（恒等式逐位成立）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);

    expect(result.coverage).toBeCloseTo(result.coveredMemories / result.totalMemories, 12);
    expect(result.coverageOverAdopted).toBeCloseTo(
      (result.coveredMemories - result.seedOnlyMemories) / result.adoptedMemories,
      12,
    );
    // ⚠️ 派生恒等式：covered == (covered − seedOnly) + seedOnly
    expect(result.coveredMemories).toBe(
      result.coveredMemories - result.seedOnlyMemories + result.seedOnlyMemories,
    );
  });

  it('★ `adoptedMemories` = 未删且 `access_count > 0` 的记忆数（**与 `stats()` 同一实现**）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);

    expect(result.adoptedMemories).toBe(countAdoptedMemories(db));
    // ⚠️ **前提自检**：夹具里确实混着「被采纳过」与「没被采纳过」的记忆
    //   （m-1/m-2/m-3/m-7/m-9 被采纳过；m-4/m-10 没有；m-7 是孤岛不在任何簇里）
    expect(result.adoptedMemories).toBe(5);
    expect(result.totalMemories).toBe(7);
  });

  it('★ `seedOnlyMemories` = covered 里**没被采纳过**的那部分（**唤起者**，不是「被召回但没被用上」）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);

    // ⚠️ 覆盖的记忆：m-1..m-4 与 m-9/m-10（共 6 个）
    //   ⇒ 其中**没被采纳过**的是 m-4 与 m-10 ⇒ seedOnly = 2
    expect(result.coveredMemories).toBe(6);
    expect(result.seedOnlyMemories).toBe(2);
  });

  it('★ `coveredMemories` = **出现在共激活边上的**记忆数（孤岛不计入）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);

    // ⚠️ **m-7 是孤岛**（没有任何共激活边）⇒ 不计入 covered
    expect(result.coveredMemories).toBe(6);
    expect(result.totalMemories).toBe(7);
    expect(result.coverage).toBeCloseTo(6 / 7, 12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 九、成员列表：排序键与 LIMIT
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 成员列表（排序键 + LIMIT）', () => {
  it('★ 排序键 = **按有效 affinity 降序**、同值按 id 字典序升序', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    const cluster = clusterOf(result, 'm-1');

    // ⚠️ 簇 A 里：m-1 的最大边权 0.5、m-2 的 0.5、m-3 的 0.3、m-4 的 0.2
    //   ⇒ 降序后 m-1 / m-2 同值 ⇒ **按 id 升序**排在前两位
    expect(cluster.memberIds).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
  });

  it('★ 两次调用 `memberIds` 顺序**完全一致**（可复现）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const first = clusters({ db, params }, undefined, NOW);
    const second = clusters({ db, params }, undefined, NOW);
    expect(second.clusters.map((cluster) => cluster.memberIds)).toEqual(
      first.clusters.map((cluster) => cluster.memberIds),
    );
  });

  it('★ **同值按 id 字典序升序**（两条边权相同 ⇒ 不靠遍历顺序决定）', () => {
    const { db, store, params } = createStore();
    insertMemory(db, 'm-1', { accessCount: 1 });
    insertMemory(db, 'm-2', { accessCount: 1 });
    insertMemory(db, 'm-3', { accessCount: 1 });
    // ⚠️ m-1—m-2 与 m-1—m-3 的权**相同**（0.5）⇒ m-2 / m-3 的有效 affinity 相同
    insertCoact(db, 'm-1', 'm-2', 0.5);
    insertCoact(db, 'm-1', 'm-3', 0.5);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    const cluster = clusterOf(result, 'm-1');
    // ⚠️ 三个成员的**有效 affinity 全是 0.5**（m-1 连 m-2 与 m-3）⇒ 顺序**只**由 id 决定
    expect(cluster.memberIds).toEqual(['m-1', 'm-2', 'm-3']);
  });

  it('★ ★ **成员列表带 LIMIT**：1000 成员的巨型簇 ⇒ `memberIds.length == CLUSTER_MEMBER_SAMPLE_MAX`', () => {
    // ⚠️ **参数覆盖**：让兜底切分不触发（`MAX_CLUSTER_SHARE = 1` ⇒ 占比 ≤ 1 永不超限）
    //   ⇒ 1000 个成员能留在**同一个簇**里（否则会被切成 50 块，测不到 LIMIT）。
    const { db, store, params } = createStore({ MAX_CLUSTER_SHARE: 1, CLUSTER_MAX_FRACTION: 1 });
    const size = 1000;
    for (let index = 0; index < size; index += 1) {
      insertMemory(db, `g-${String(index).padStart(4, '0')}`, { accessCount: 1 });
    }
    for (let index = 1; index < size; index += 1) {
      insertCoact(db, 'g-0000', `g-${String(index).padStart(4, '0')}`, 0.5);
    }
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);

    expect(result.clusters).toHaveLength(1);
    const cluster = result.clusters[0];
    expect(cluster?.size).toBe(size);
    // ⚠️ **成员列表被截断**（但 `size` **不截断、不隐藏**：§4.12.4 ②）
    expect(cluster?.memberIds).toHaveLength(DEFAULT_PARAMS.CLUSTER_MEMBER_SAMPLE_MAX);
    expect(cluster?.memberIds.length).toBeLessThan(size);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 十、展示侧过滤（`minSize` / `limit`）与 id 白名单边界
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 展示侧过滤与硬边界', () => {
  it('★ `minSize` / `limit` **不触发重算**（仍是快照路径：`computedAt` 与上次 `recluster` 一致）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, { minSize: 1, limit: 1 }, NOW + 999);

    // ⚠️ **前提自检**：如果触发了重算，`computedAt` 会变成真实时钟（不是 NOW）
    expect(result.computedAt).toBe(NOW);
    expect(result.asOf).toBe(NOW);
    expect(result.clusters).toHaveLength(1);
  });

  it('★ `totalClusters` / `totalMembers` **未受 `limit` 截断**', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, { limit: 1 }, NOW);

    expect(result.clusters).toHaveLength(1);
    expect(result.totalClusters).toBe(2);
    // ⚠️ 两个簇的活跃成员数之和 = 4 + 2 = 6
    expect(result.totalMembers).toBe(6);
  });

  it('★ `minSize` 按**活跃成员数**过滤', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, { minSize: 3 }, NOW);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.size).toBe(4);
    expect(result.totalClusters).toBe(1);
  });

  it('★ ★ **`options` 不接受 id 白名单**：多传 `ids` **不产生任何过滤效果**', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const before = clusters({ db, params }, undefined, NOW);
    const after = clusters({ db, params }, { ids: ['m-1'] } as unknown as ClustersOptions, NOW);

    expect(after.clusters.map((cluster) => cluster.clusterId)).toEqual(
      before.clusters.map((cluster) => cluster.clusterId),
    );
    expect(after.clusters.map((cluster) => cluster.size)).toEqual(
      before.clusters.map((cluster) => cluster.size),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 十一、簇级字段（代表记忆 / 实体 / 统计量 / 切分来路）
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 簇级字段', () => {
  it('★ `entities` = 簇内**高频实体**（最多 3 个，频次降序、名称升序）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    const cluster = clusterOf(result, 'm-1');

    // ⚠️ 张三 × 3、李四 × 2、王五 × 1 ⇒ 频次降序
    expect(cluster.entities).toEqual(['张三', '李四', '王五']);
    // ⚠️ **没有实体的簇** ⇒ 空数组（不是 `null`）
    expect(clusterOf(result, 'm-9').entities).toEqual([]);
  });

  it('★ `representativeId` = 簇内**共激活度数**最高的成员（并列按 id 升序）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    const cluster = clusterOf(result, 'm-1');

    // ⚠️ m-2 的簇内度数是 2（m-1、m-3、m-4 共 3 条）⇒ 它是代表记忆
    expect(cluster.representativeId).toBe('m-2');
    expect(cluster.memberIds).toContain(cluster.representativeId);
  });

  it('★ `label` = 代表记忆的正文摘要（展示用）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    const cluster = clusterOf(result, 'm-1');

    expect(cluster.label).toBe('内容 m-2');
  });

  it('★ 簇内统计量：`meanAffinity` / `maxAffinity` / `strength` / `lastActive`', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);
    const cluster = clusterOf(result, 'm-1');

    // ⚠️ 簇 A 的三条边：0.5 / 0.3 / 0.2
    expect(cluster.strength).toBeCloseTo(1.0, 12);
    expect(cluster.maxAffinity).toBeCloseTo(0.5, 12);
    expect(cluster.meanAffinity).toBeCloseTo(1.0 / 3, 12);
    expect(cluster.lastActive).toBe(NOW);
  });

  it('★ `splitInfo` **只有现场重算路径给得出**（快照路径没有它 —— §6「不落表，重算重现」）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const snapshotResult = clusters({ db, params }, undefined, NOW);
    expect(snapshotResult.clusters[0]?.splitInfo).toBeUndefined();

    // ⚠️ **阈值 0.1 ≠ 快照阈值 0.15** ⇒ 现场重算；且 0.1 < 各条边的权 ⇒ 边全部成边
    const liveResult = clusters({ db, params }, { minAffinity: 0.1 }, NOW + 1);
    const liveCluster = clusterOf(liveResult, 'm-1');
    expect(liveCluster.splitInfo).toBeDefined();
    expect(liveCluster.splitInfo?.originSize).toBe(4);
    expect(liveCluster.splitInfo?.blocksCount).toBe(1);
    expect(liveCluster.splitInfo?.at).toBe(NOW + 1);
  });

  it('★ `largestClusterRatio` / `maxRawComponentRatio` 是**两个口径**（不可互相推出）', () => {
    const { db, store, params } = createStore();
    seedBasicGraph(db);
    recluster(store, NOW);

    const result = clusters({ db, params }, undefined, NOW);

    // ⚠️ 切分后：最大块 4 / 全库 7
    expect(result.largestClusterRatio).toBeCloseTo(4 / 7, 12);
    // ⚠️ 切分前：最大原始连通分量 4 / 全库 7（本例没触发切分 ⇒ 两者同值但**不同名**）
    expect(result.maxRawComponentRatio).toBeCloseTo(4 / 7, 12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 十二、门面（`MemoryStore`）上的 `clusters()`
// ═══════════════════════════════════════════════════════════════════════════

describe('P3-T05 · 门面上的 `clusters()`', () => {
  it('★ `MemoryStore` 上存在 `clusters(options?, now?)` 且返回真实簇', () => {
    // ⚠️ **临时目录不清理**（门面没有 `close()` ⇒ 句柄要到进程退出才释放 ⇒ Windows 上删不掉）
    const workDir = mkdtempSync(join(tmpdir(), 'memory-ocean-clusters-facade-'));
    const dbPath = join(workDir, 'clusters.db');

    const rw = new Database(dbPath);
    createSchema(rw);
    seedBasicGraph(rw);
    rw.close();

    const store = new MemoryStore({ dbPath });
    // ⚠️ **必须注入 `now`**：夹具里的共激活边是 `NOW`（2023-11）建的，
    //   而门面缺省用**真实时钟** ⇒ 亲和度早已衰减到门槛下 ⇒ 一个簇都没有。
    const result = store.clusters(undefined, NOW);

    expect(result.clusters.length).toBeGreaterThan(0);
    expect(result.totalMemories).toBe(7);
    expect(typeof result.asOf).toBe('number');
    expect(typeof result.computedAt).toBe('number');
  });
});
