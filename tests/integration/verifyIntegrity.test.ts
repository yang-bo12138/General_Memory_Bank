/**
 * `verifyIntegrity()` 的集成测试 —— DESIGN-v2.md §6 / §9.4.4 的护栏①② / §7.1，
 * 对应 DEVELOPMENT-PLAN.md **P5-T06**。
 *
 * ★ 本文件重点守七件事（都是「看起来通过、其实没查」的一类）：
 *   ① 归档两项与 `stats()` 的同名字段**恒等**（口径只有一份）；
 *   ② 自检**纯读**：全表行数 + 内容哈希不变、`events` 不新增行；
 *   ③ `rebuildArchivalSchedule()` 之后两项归零，且事件字段集恰为 §8.4 的
 *      `action='rebuildArchive'` 那五个键里的 `scanned, repaired`（+ 分组键 `action`）；
 *   ④ 抽样自检**有判别力**：人为改一条 `archive_at` ⇒ 自检命中（不是恒 0）；
 *   ⑤ `bucketCoverage` 对「删掉一条桶归属」有反应，修复后回到 1；
 *   ⑥ `edgesDiffusable` 真的跟着 §0.2 的 ~8.6 天窗口走（值不是「边总数」的别名）；
 *   ⑦ `clusterSnapshotFreshness` 的 `-1` 哨兵语义（从未发布 ≠ 刚发布）。
 *
 * ⚠️ **两种夹具分工**（照仓库既有口径）：
 *   · **内存库（store 层）**：要**注入时钟**、要**手工造脏数据**（外键关掉插孤儿行）、
 *     要断言「日志里有没有那条告警」⇒ 直接调 `verifyIntegrityReport()`；
 *   · **文件库（门面）**：只读实例、事件流、以及「宿主实际会怎么调」⇒ 走 `MemoryStore`。
 *   ⚠️ 门面**不暴露 `db`** ⇒ 要核对库里发生了什么，只能另开一个「旁路」连接（`reader`）。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { EVENT_PAYLOAD_VARIANTS } from '../../src/core/events.types.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { rebuildArchivalScheduleInternal } from '../../src/store/archival.js';
import { recluster } from '../../src/store/clusters.js';
import { type VerifyIntegrityReport, verifyIntegrityReport } from '../../src/store/maintain.js';
import { stats } from '../../src/store/stats.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { MemoryLogger } from '../../src/util/log.js';
import {
  type BucketAssignContext,
  assignBucket,
  unassignBucket,
} from '../../src/vector/bucketAssign.js';
import type { IvfCentroidModel } from '../../src/vector/centroids.js';
import { trainCentroids } from '../../src/vector/ivf.js';
import { reconcileBuckets } from '../../src/vector/reconcile.js';
import {
  type TestStore,
  countRows,
  createTestStore,
  insertEdge,
  insertEntity,
  insertMemory,
} from '../fixtures/graph-store.js';
import { pseudoUnitVector } from '../fixtures/vector.js';

/** 固定的时间基准（所有时刻都相对它推算）。 */
const T0 = 1_700_000_000_000;

/** 一天（毫秒）。 */
const DAY = MS_PER_DAY;

// ═══════════════════════════════════════════════════════════════════════════
// 通用夹具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 全库指纹：**每张表的行数 + 内容哈希**（用于断言「自检什么都没改」）。
 *
 * ⚠️ **表清单从 `sqlite_master` 现取**（不是写死一串表名）：
 *   写死的那份会随着「加一张表」而**静默漏检**，而漏检的表恰好就是没人盯着的那张。
 * ⚠️ **不按 rowid 排序**：本断言比对的是「同一库、同一状态」的前后指纹 ⇒
 *   没有写入时行序天然一致；排序反而要逐表挑一个主键（挑错就静默乱序）。
 */
function databaseFingerprint(db: Database.Database): Record<string, string> {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);

  const fingerprint: Record<string, string> = {};
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all() as unknown[];
    fingerprint[table] = `${rows.length}|${createHash('sha1')
      .update(JSON.stringify(rows))
      .digest('hex')}`;
  }
  return fingerprint;
}

/** 一个门面夹具：文件库 + 门面 + 旁路连接。 */
interface FacadeHarness {
  dbPath: string;
  store: MemoryStore;
  reader: Database.Database;
}

/**
 * 建一个门面夹具。
 *
 * ⚠️ **为什么必须是文件库**：§7.1 的只读实例要**另开一个连接**
 *   （`{ readonly: true, fileMustExist: true }`）⇒ 内存库做不到「同库两连接」。
 * ⚠️ **临时目录不清理**（与 `tests/unit/memory-store.test.ts` 同口径）：
 *   Windows 上句柄未释放时删不掉目录，留在系统 temp 下即可。
 */
function createFacadeHarness(): FacadeHarness {
  const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-verify-integrity-'));
  const dbPath = join(dir, 'memory.db');
  const store = new MemoryStore({ dbPath });
  const reader = new Database(dbPath);
  reader.pragma('foreign_keys = ON');
  return { dbPath, store, reader };
}

/**
 * 断言「归档两项与 `stats()` 的同名字段**恒等**」，并把自检报告返回给调用方。
 *
 * ⚠️ **这是跨实现断言**（P5-T06 的硬断言）：两处各算一遍的后果是
 *   「一个说 0、一个说 3，而没人知道该信哪个」⇒ 所以一条用例里**同时**调两边。
 */
function expectSameAsStats(store: TestStore, now: number): VerifyIntegrityReport {
  const report = verifyIntegrityReport(store.db, store.params, { now });
  const snapshot = stats({ db: store.db, params: store.params, inRetrain: () => false }, now);
  expect(report.archivalOrphans).toBe(snapshot.archivalOrphans);
  expect(report.archivalMismatch).toBe(snapshot.archivalMismatch);
  return report;
}

/** 造一条「指向不存在记忆」的归档缓存行（= 真孤儿，必须临时关掉外键）。 */
function insertOrphanArchivalRow(db: Database.Database, memoryId: string, archiveAt: number): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare('INSERT INTO archival_schedule (memory_id, archive_at) VALUES (?, ?)').run(
      memoryId,
      archiveAt,
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、归档两项：与 stats() 共用同一个实现（口径不得分叉）
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyIntegrity · 归档自检（护栏①②）', () => {
  it('★ `archivalOrphans` / `archivalMismatch` 与 `stats()` 同名字段恒等（四种状态逐个比对）', () => {
    const store = createTestStore();
    const { db, params } = store;
    try {
      for (const id of ['m-1', 'm-2', 'm-3']) insertMemory(db, id);

      // ── 状态①：缓存**还没建**（表是空的）⇒ 两项都是 0 ──
      // ⚠️ 「没有缓存行」**不是**孤儿（孤儿 = 缓存有、主表没有），这里是「主表有、缓存没有」
      //   ⇒ 那属于 `missing`，不在 §6 的五个字段里（它由 `stats().archivalMissing` 回答）。
      let report = expectSameAsStats(store, T0);
      expect(report.archivalOrphans).toBe(0);
      expect(report.archivalMismatch).toBe(0);

      // ── 状态②：全量重建缓存 ⇒ 仍然 0 / 0（健康库不得报脏）──
      rebuildArchivalScheduleInternal(db, params, T0);
      expect(countRows(db, 'archival_schedule')).toBe(3);
      report = expectSameAsStats(store, T0);
      expect(report.archivalOrphans).toBe(0);
      expect(report.archivalMismatch).toBe(0);

      // ── 状态③：**软删**一条 ⇒ 缓存行还在 ⇒ 孤儿 1（`countArchived` 视角它是脏行）──
      db.prepare('UPDATE memories SET deleted = 1, deleted_at = ? WHERE id = ?').run(T0, 'm-3');
      report = expectSameAsStats(store, T0);
      expect(report.archivalOrphans).toBe(1);
      expect(report.archivalMismatch).toBe(0);

      // ── 状态④：**改一条 `archive_at`**（人为制造偏移）⇒ 不一致 1 ──
      // ⚠️ 这条正是 §9.4.4 护栏②「抽样自检」的判别力来源：
      //   若实现是「按缓存自己的值反算」就永远命中不了；必须**按当前参数重算**再比。
      db.prepare(
        'UPDATE archival_schedule SET archive_at = archive_at + 1000 WHERE memory_id = ?',
      ).run('m-1');
      report = expectSameAsStats(store, T0);
      expect(report.archivalMismatch).toBe(1);
      // ★ 两个字段互不串味（改一条 archive_at 不该让孤儿数变化）
      expect(report.archivalOrphans).toBe(1);
    } finally {
      db.close();
    }
  });

  it('★ 真孤儿（缓存指向不存在的记忆）⇒ `archivalOrphans` 计数，且与 stats() 一致', () => {
    const store = createTestStore();
    const { db } = store;
    try {
      insertMemory(db, 'm-1');
      rebuildArchivalScheduleInternal(db, store.params, T0);
      insertOrphanArchivalRow(db, 'ghost', T0);

      const report = expectSameAsStats(store, T0);
      expect(report.archivalOrphans).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、edgesDiffusable：库级联想路健康度（复用 edgeWeight，不另写指数）
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyIntegrity · edgesDiffusable', () => {
  /**
   * ★ **§0.2 的窗口**（天）：`bonus ≥ ACTIVATION_MIN` 的边界。
   *
   * 由 §4.5 的公式反解出来（`bonus = ACTIVATION_DECAY × weight / INITIAL_EDGE_WEIGHT`、
   * `weight = w₀ × e^(−Δt/EDGE_STABILITY)`) ⇒ `Δt ≤ EDGE_STABILITY × ln(ACTIVATION_DECAY/ACTIVATION_MIN)`。
   * ⚠️ **测试自己算这个边界**（而不是引用实现里的算式）：
   *   它才是「实现有没有走对公式」的判据——若实现把 `EDGE_STABILITY` 当半衰期 / 漏了
   *   `ACTIVATION_DECAY`，边界会挪到 30 天或 56 天，下面的断言立刻红。
   */
  const WINDOW_DAYS =
    DEFAULT_PARAMS.EDGE_STABILITY *
    Math.log(DEFAULT_PARAMS.ACTIVATION_DECAY / DEFAULT_PARAMS.ACTIVATION_MIN);

  it('★ 前提自检：默认参数下的窗口就是 §0.2 说的 ~8.6 天', () => {
    expect(WINDOW_DAYS).toBeGreaterThan(8.5);
    expect(WINDOW_DAYS).toBeLessThan(8.8);
  });

  it('★ 边「过旧」⇒ 计数下降；窗口内仍计数（不是「边总数」的别名）', () => {
    const store = createTestStore();
    const { db } = store;
    try {
      insertEntity(db, 'e-1', '张三');
      insertEntity(db, 'e-2', '猫');
      insertEntity(db, 'e-3', '狗');

      // 两条**刚刚活跃**的边（权重 = INITIAL_EDGE_WEIGHT ⇒ 窗口算得准）
      insertEdge(db, 'edge-fresh-1', 'e-1', '喜欢', 'e-2', DEFAULT_PARAMS.INITIAL_EDGE_WEIGHT, T0);
      insertEdge(db, 'edge-fresh-2', 'e-1', '喜欢', 'e-3', DEFAULT_PARAMS.INITIAL_EDGE_WEIGHT, T0);
      expect(countRows(db, 'edges')).toBe(2);

      // ── 两条都新鲜 ⇒ 都还可扩散 ──
      expect(verifyIntegrityReport(db, store.params, { now: T0 }).edgesDiffusable).toBe(2);

      // ── 把一条挪到「窗口的 2 倍」之外 ⇒ 它不再可扩散（计数下降）──
      const staleAt = Math.round(T0 - 2 * WINDOW_DAYS * DAY);
      db.prepare('UPDATE edges SET last_active = ? WHERE id = ?').run(staleAt, 'edge-fresh-2');
      expect(verifyIntegrityReport(db, store.params, { now: T0 }).edgesDiffusable).toBe(1);

      // ⚠️ **前提自检**：边还在（只是老了）⇒ 上面的「下降」不是因为行被删了
      expect(countRows(db, 'edges')).toBe(2);

      // ── 正好落在窗口内一半 ⇒ 仍然计数（边界两侧都验，才说明它真按窗口判）──
      const insideAt = Math.round(T0 - 0.5 * WINDOW_DAYS * DAY);
      db.prepare('UPDATE edges SET last_active = ? WHERE id = ?').run(insideAt, 'edge-fresh-2');
      expect(verifyIntegrityReport(db, store.params, { now: T0 }).edgesDiffusable).toBe(2);
    } finally {
      db.close();
    }
  });

  it('无边的库 ⇒ 0（不是 1、也不抛错）', () => {
    const store = createTestStore();
    try {
      expect(verifyIntegrityReport(store.db, store.params, { now: T0 }).edgesDiffusable).toBe(0);
    } finally {
      store.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、bucketCoverage：已有向量且已入桶的占比
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyIntegrity · bucketCoverage', () => {
  /** 桶形状（粗 4 / 细 40 ⇒ 40 条向量够铺开）。 */
  const COARSE = 4;
  const FINE = 40;
  const NPROBE = 2;

  /**
   * 建 40 条带向量的活记忆 + 训练第一代桶 + 全量入桶。
   *
   * ⚠️ **入桶一律走 `assignBucket()`**（§9.3.0 的唯一写入点）⇒
   *   本文件不手工 INSERT 归属行（唯一的例外是「删掉一条」这种**制造缺失**的动作）。
   */
  function seedBucketedWorld(): TestStore & { model: () => IvfCentroidModel } {
    const store = createTestStore();
    const { db } = store;
    const vectors = Array.from({ length: 40 }, (_, index) => pseudoUnitVector(index + 1));
    const ids: string[] = [];
    for (const [index, vector] of vectors.entries()) {
      const id = `m-${String(index).padStart(2, '0')}`;
      insertMemoryWithVector(db, id, vector, T0);
      ids.push(id);
    }

    const { model } = trainCentroids(db, {
      coarseCenters: COARSE,
      fineCenters: FINE,
      nprobeCoarse: NPROBE,
      now: T0,
    });
    const context: BucketAssignContext = { db, centroids: () => model, nprobeCoarse: NPROBE };
    runWriteTransaction(db, () => {
      for (const [index, id] of ids.entries()) {
        const vector = vectors[index] as Float32Array;
        assignBucket(context, id, vector);
      }
    });

    return { ...store, model: () => model };
  }

  it('★ 全量入桶 ⇒ 1；删掉一条归属 ⇒ < 1；补齐后回到 1', () => {
    const world = seedBucketedWorld();
    const { db, params } = world;
    try {
      // ── ① 健康库 ⇒ 覆盖率恰好 1 ──
      const coverageBefore = verifyIntegrityReport(db, params, { now: T0 }).bucketCoverage;
      expect(coverageBefore).toBe(1);
      expect(countRows(db, 'vector_cell_members')).toBe(40);

      // ── ② 人为删掉一条桶归属 ⇒ 覆盖率下降 ──
      // ⚠️ **`unassignBucket()` 自带「必须在事务内」的守卫**（§9.3.0 的唯一写入点）
      //   ⇒ 这里用与写路径同一个事务包装，而不是裸调。
      const victim = 'm-00';
      runWriteTransaction(db, () => {
        unassignBucket({ db, centroids: () => world.model(), nprobeCoarse: NPROBE }, victim);
      });
      const coverageMissing = verifyIntegrityReport(db, params, { now: T0 }).bucketCoverage;
      expect(coverageMissing).toBeLessThan(1);
      expect(coverageMissing).toBeCloseTo(39 / 40, 12);

      // ── ③ 补齐（走对账的修复路径）⇒ 回到 1 ──
      const repaired = reconcileBuckets(
        db,
        <T>(body: () => T): T => runWriteTransaction(db, body),
        { centroids: world.model, nprobeCoarse: NPROBE },
      );
      expect(repaired.report.assigned).toBe(1);
      expect(verifyIntegrityReport(db, params, { now: T0 }).bucketCoverage).toBe(1);
    } finally {
      db.close();
    }
  });

  it('库里没有向量 ⇒ 覆盖率取 1（「没有欠账」不是「0%」）', () => {
    const store = createTestStore();
    try {
      insertMemory(store.db, 'm-1');
      expect(verifyIntegrityReport(store.db, store.params, { now: T0 }).bucketCoverage).toBe(1);
    } finally {
      store.db.close();
    }
  });
});

/** 落一条带向量的记忆（只落测试要用的最小列集）。 */
function insertMemoryWithVector(
  db: Database.Database,
  id: string,
  vector: Float32Array,
  now: number,
): void {
  const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding,
                           stability, difficulty, pin_factor, created_at, last_access,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @embedding, 100, 0.5, 1, @now, @now, 0, NULL)`,
  ).run({
    id,
    content: `内容 ${id}`,
    tokens: `内容 ${id}`,
    hash: `hash-${id}`,
    embedding: buffer,
    now,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、clusterSnapshotFreshness：`-1` = 从未发布（0 = 刚刚发布）
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyIntegrity · clusterSnapshotFreshness', () => {
  it('★ 从未发布 ⇒ -1；发布后 ⇒ ≥ 0 且随时间增长；时钟回拨不得伪装成 -1', () => {
    const store = createTestStore();
    const { db, params } = store;
    try {
      for (let index = 1; index <= 6; index += 1) insertMemory(db, `m-${index}`);

      // ── ① 库里还没有任何快照（单行表无行）⇒ 哨兵 -1 ──
      expect(countRows(db, 'cluster_snapshot_meta')).toBe(0);
      expect(verifyIntegrityReport(db, params, { now: T0 }).clusterSnapshotFreshness).toBe(-1);

      // ── ② 发布一次快照（`computed_at = NOW`）⇒ 新鲜度 = 距它的时长 ──
      const published = recluster(store.store, T0);
      expect(published.computed).toBe(true);
      expect(countRows(db, 'cluster_snapshot_meta')).toBe(1);

      expect(verifyIntegrityReport(db, params, { now: T0 }).clusterSnapshotFreshness).toBe(0);
      // ⚠️ **0 与 -1 必须能区分**：「刚刚发布」不是「从未发布」。
      expect(verifyIntegrityReport(db, params, { now: T0 + 1000 }).clusterSnapshotFreshness).toBe(
        1000,
      );
      expect(
        verifyIntegrityReport(db, params, { now: T0 + 5 * DAY }).clusterSnapshotFreshness,
      ).toBe(5 * DAY);

      // ── ③ 注入的「现在」早于快照时刻（时钟回拨）⇒ 夹到 0，**不是** -1 ──
      // ⚠️ 若不夹，`-1` 这个哨兵就会在「时钟回拨」时出现 ⇒ 面板会把「有快照」读成「没快照」。
      expect(verifyIntegrityReport(db, params, { now: T0 - 1000 }).clusterSnapshotFreshness).toBe(
        0,
      );
    } finally {
      db.close();
    }
  });

  it('★ 新鲜度**不会因为自检而改变**（读 `cluster_snapshot_meta` 而不是调 `clusters()`）', () => {
    const store = createTestStore();
    const { db, params } = store;
    try {
      for (let index = 1; index <= 6; index += 1) insertMemory(db, `m-${index}`);
      recluster(store.store, T0);
      const computedAtBefore = (
        db
          .prepare('SELECT computed_at AS computedAt FROM cluster_snapshot_meta WHERE id = 1')
          .get() as {
          computedAt: number;
        }
      ).computedAt;

      // ⚠️ 用**远超 `CLUSTER_RECALC_INTERVAL_MS` 的 now** 调两次：
      //   若实现为了拿新鲜度去调 `clusters()`，它会**现场重算并写快照** ⇒ 下面这条会红。
      for (const now of [T0 + 10 * DAY, T0 + 20 * DAY]) {
        verifyIntegrityReport(db, params, { now });
      }

      const computedAtAfter = (
        db
          .prepare('SELECT computed_at AS computedAt FROM cluster_snapshot_meta WHERE id = 1')
          .get() as {
          computedAt: number;
        }
      ).computedAt;
      expect(computedAtAfter).toBe(computedAtBefore);
      expect(countRows(db, 'theme_clusters')).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、deep：只加检、不改口径；问题只进日志
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyIntegrity · deep', () => {
  it('★ `deep: false` 与 `deep: true` 的**五个字段完全相同**（深检不得改口径）', () => {
    const store = createTestStore();
    const { db, params } = store;
    try {
      insertMemory(db, 'm-1');
      insertMemory(db, 'm-2');
      rebuildArchivalScheduleInternal(db, params, T0);
      // 造一点脏（软删一条 ⇒ 孤儿 1）⇒ 保证两个报告都不是「全 0 的空断言」
      db.prepare('UPDATE memories SET deleted = 1, deleted_at = ? WHERE id = ?').run(T0, 'm-2');

      const shallow = verifyIntegrityReport(db, params, { now: T0, deep: false });
      const deep = verifyIntegrityReport(db, params, { now: T0, deep: true });
      expect(shallow.archivalOrphans).toBe(1);
      expect(deep).toEqual(shallow);
    } finally {
      db.close();
    }
  });

  it('★ 深检发现问题 ⇒ 记一条 warn（`deep: false` 不记）；日志不改变返回值', () => {
    const store = createTestStore();
    const { db, params } = store;
    try {
      insertMemory(db, 'm-1');
      // 外键违规（= 真实恢复场景里最容易出现的脏）：缓存指向不存在的记忆
      insertOrphanArchivalRow(db, 'ghost', T0);

      // ── ① 不深检 ⇒ 一条日志都不记（自检是纯读，不该产生噪音）──
      const shallowLogger = new MemoryLogger();
      const shallow = verifyIntegrityReport(db, params, {
        now: T0,
        logger: shallowLogger,
        deep: false,
      });
      expect(shallowLogger.lines).toHaveLength(0);

      // ── ② 深检 ⇒ 恰好一条 warn（`PRAGMA foreign_key_check` 报出 1 条违规）──
      const deepLogger = new MemoryLogger();
      const deep = verifyIntegrityReport(db, params, { now: T0, logger: deepLogger, deep: true });
      const warnings = deepLogger.ofLevel('warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.fields.reason).toBe('integrity-deep-check-failed');
      expect(warnings[0]?.fields.integrityOk).toBe(true);
      expect(warnings[0]?.fields.foreignKeyViolations).toBe(1);

      // ★ **日志不改变五个字段**（深检只是「额外看一眼」）
      expect(deep).toEqual(shallow);
    } finally {
      db.close();
    }
  });

  it('健康库深检 ⇒ **不记任何日志**（不能变成每次都喊狼来了）', () => {
    const store = createTestStore();
    const logger = new MemoryLogger();
    try {
      insertMemory(store.db, 'm-1');
      verifyIntegrityReport(store.db, store.params, { now: T0, logger, deep: true });
      expect(logger.lines).toHaveLength(0);
    } finally {
      store.db.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、门面：纯读 / 只读实例 / rebuildArchivalSchedule 的事件与修复
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyIntegrity · 门面与只读实例（§7.1）', () => {
  it('★ 纯读：全表行数 + 内容哈希不变，`events` 不新增行', () => {
    const harness = createFacadeHarness();
    try {
      harness.store.write({ content: '张三喜欢猫', entities: ['张三', '猫'], now: T0 });
      harness.store.write({ content: '李四喜欢狗', entities: ['李四', '狗'], now: T0 });
      harness.store.rebuildArchivalSchedule(T0);

      const before = databaseFingerprint(harness.reader);
      const eventsBefore = countRows(harness.reader, 'events');

      harness.store.verifyIntegrity();
      harness.store.verifyIntegrity({ deep: true });

      /// ★ **逐表指纹相同**（不只是「行数相同」：改一行的值行数不变，但哈希会变）
      expect(databaseFingerprint(harness.reader)).toEqual(before);
      expect(countRows(harness.reader, 'events')).toBe(eventsBefore);
    } finally {
      harness.reader.close();
      harness.store.close();
    }
  });

  it('★ 返回值形状 = §6 的五个字段（顺序照 §6）', () => {
    const harness = createFacadeHarness();
    try {
      const report = harness.store.verifyIntegrity();
      expect(Object.keys(report)).toEqual([
        'archivalOrphans',
        'archivalMismatch',
        'bucketCoverage',
        'clusterSnapshotFreshness',
        'edgesDiffusable',
      ]);
      for (const value of Object.values(report)) {
        expect(typeof value).toBe('number');
      }
      // 空库：没有归档缓存 ⇒ 两项 0；没有向量 ⇒ 覆盖率 1；没有快照 ⇒ -1；没有边 ⇒ 0
      expect(report.archivalOrphans).toBe(0);
      expect(report.archivalMismatch).toBe(0);
      expect(report.bucketCoverage).toBe(1);
      expect(report.clusterSnapshotFreshness).toBe(-1);
      expect(report.edgesDiffusable).toBe(0);
    } finally {
      harness.reader.close();
      harness.store.close();
    }
  });

  it('★ 只读实例上可用（不抛 READONLY_VIOLATION），且与可写实例**同值**', () => {
    const harness = createFacadeHarness();
    try {
      harness.store.write({ content: '张三喜欢猫', entities: ['张三', '猫'], now: T0 });
      harness.store.write({ content: '李四喜欢狗', entities: ['李四', '狗'], now: T0 });
      harness.store.rebuildArchivalSchedule(T0);
      harness.store.recluster(T0);

      const readonly = new MemoryStore({ dbPath: harness.dbPath, readonly: true });
      try {
        // ⚠️ **这是 P5-T06 的核心断言**：把自检归成写方法 ⇒ 只读查看器调不了护栏报告。
        const viaReadonly = readonly.verifyIntegrity();
        const viaWritable = harness.store.verifyIntegrity();
        expect(viaReadonly.archivalOrphans).toBe(viaWritable.archivalOrphans);
        expect(viaReadonly.archivalMismatch).toBe(viaWritable.archivalMismatch);
        expect(viaReadonly.bucketCoverage).toBe(viaWritable.bucketCoverage);
        expect(viaReadonly.edgesDiffusable).toBe(viaWritable.edgesDiffusable);
        // 新鲜度含「现在」⇒ 两次调用之间有毫秒级差 ⇒ 只断言**同类**（都 ≥ 0，都不是哨兵）
        expect(viaReadonly.clusterSnapshotFreshness).toBeGreaterThanOrEqual(0);
        expect(viaWritable.clusterSnapshotFreshness).toBeGreaterThanOrEqual(0);

        // ★ 只读实例上 `deep` 也照常可用（两条 PRAGMA 都是纯读）
        expect(() => readonly.verifyIntegrity({ deep: true })).not.toThrow();
      } finally {
        readonly.close();
      }
    } finally {
      harness.reader.close();
      harness.store.close();
    }
  });

  it('★ 只读实例上 `rebuildArchivalSchedule()` 抛 READONLY_VIOLATION（护栏③是写方法）', () => {
    const harness = createFacadeHarness();
    try {
      harness.store.write({ content: '张三喜欢猫', entities: ['张三', '猫'], now: T0 });
      const readonly = new MemoryStore({ dbPath: harness.dbPath, readonly: true });
      try {
        let caught: MemoryError | undefined;
        try {
          readonly.rebuildArchivalSchedule(T0);
        } catch (error) {
          caught = error as MemoryError;
        }
        expect(caught?.code).toBe(MemoryError.READONLY_VIOLATION);
        // ★ 零写入：缓存表仍是空的（守卫在**任何写**之前）
        expect(countRows(harness.reader, 'archival_schedule')).toBe(0);
      } finally {
        readonly.close();
      }
    } finally {
      harness.reader.close();
      harness.store.close();
    }
  });

  it('★ `rebuildArchivalSchedule()`：写一条 `sweep` 事件，`action=rebuildArchive`，字段集恰为 §8.4 那两个', () => {
    const harness = createFacadeHarness();
    try {
      harness.store.write({ content: '张三喜欢猫', entities: ['张三', '猫'], now: T0 });
      harness.store.write({ content: '李四喜欢狗', entities: ['李四', '狗'], now: T0 });

      const result = harness.store.rebuildArchivalSchedule(T0);
      expect(result).toEqual({ scanned: 2, repaired: 2 });

      const events = harness.reader
        .prepare(`SELECT type, memory_id AS memoryId, payload FROM events WHERE type = 'sweep'`)
        .all() as Array<{ type: string; memoryId: string | null; payload: string }>;
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.memoryId).toBeNull();

      const payload = JSON.parse(event?.payload ?? '{}') as Record<string, unknown>;
      expect(payload.action).toBe('rebuildArchive');
      // ★ **按 action 分组写清字段集**（§8.4 硬规则 4）：`scanned, repaired` 两个都在，
      //   且**不多不少**（不填 `purged` / `vacuumed` 那些本次没发生的结果）。
      const dataKeys = Object.keys(payload)
        .filter((key) => key !== 'action')
        .sort();
      // ★ **字段集逐字**（§8.4 硬规则 4：`action='rebuildArchive'` → `scanned, repaired`）
      expect(dataKeys).toEqual(['repaired', 'scanned']);
      // ⚠️ 再加一道「与运行时声明对齐」（`EVENT_PAYLOAD_VARIANTS` 是 §8.4 的机器可读副本）
      expect(dataKeys).toEqual(
        [...(EVENT_PAYLOAD_VARIANTS.sweep?.action_rebuildArchive ?? [])].sort(),
      );
      expect(payload.scanned).toBe(2);
      expect(payload.repaired).toBe(2);
    } finally {
      harness.reader.close();
      harness.store.close();
    }
  });

  it('★ 护栏③真的能修好护栏②发现的问题：重建后两项归零', () => {
    const harness = createFacadeHarness();
    try {
      const ids = ['m-1', 'm-2', 'm-3'].map(
        (content) => harness.store.write({ content, now: T0 }).id,
      );
      harness.store.rebuildArchivalSchedule(T0);

      // ── 人为弄脏：① 软删一条（⇒ 孤儿）② 改一条 `archive_at`（⇒ 不一致）──
      harness.store.forget(ids[2] as string, {}, T0);
      harness.reader
        .prepare('UPDATE archival_schedule SET archive_at = archive_at + 5000 WHERE memory_id = ?')
        .run(ids[0] as string);

      const dirty = harness.store.verifyIntegrity();
      expect(dirty.archivalOrphans).toBe(1);
      expect(dirty.archivalMismatch).toBe(1);
      // ★ 与 `stats()` 一致（跨实现断言，门面这一层也要恒等）
      const snapshot = harness.store.stats(T0);
      expect(dirty.archivalOrphans).toBe(snapshot.archivalOrphans);
      expect(dirty.archivalMismatch).toBe(snapshot.archivalMismatch);

      // ── 护栏③：重建 ⇒ 两项归零（软删行被清出缓存、`archive_at` 按当前参数重算）──
      harness.store.rebuildArchivalSchedule(T0);
      const clean = harness.store.verifyIntegrity();
      expect(clean.archivalOrphans).toBe(0);
      expect(clean.archivalMismatch).toBe(0);
      // ⚠️ **前提自检**：缓存里只剩 2 行（软删那条被清出），不是「表被清空了所以两项都是 0」
      expect(countRows(harness.reader, 'archival_schedule')).toBe(2);
    } finally {
      harness.reader.close();
      harness.store.close();
    }
  });

  it('★ 门面与 store 层实现**同值**（门面只做委托，不另算一份）', () => {
    const harness = createFacadeHarness();
    try {
      harness.store.write({ content: '张三喜欢猫', entities: ['张三', '猫'], now: T0 });
      const viaFacade = harness.store.verifyIntegrity();
      const viaImpl = verifyIntegrityReport(harness.reader, DEFAULT_PARAMS);
      // ⚠️ 只比**与时间无关**的三个字段：新鲜度 / 可扩散边数都依赖「现在」，
      //   两次调用之间真实时钟会走毫秒 ⇒ 对它们做逐位相等断言是 flaky 的。
      expect(viaFacade.bucketCoverage).toBe(viaImpl.bucketCoverage);
      expect(viaFacade.archivalOrphans).toBe(viaImpl.archivalOrphans);
      expect(viaFacade.archivalMismatch).toBe(viaImpl.archivalMismatch);
    } finally {
      harness.reader.close();
      harness.store.close();
    }
  });
});
