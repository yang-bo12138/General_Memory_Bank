/**
 * 启动对账与桶质量退化检测的**集成测试** —— P2-T06
 * （DESIGN-v2.md §9.3.2 ③ 的三条判据 / ④ 的 P95 退化检测）。
 *
 * ⚠️ **本文件的断言纪律**（沿用阶段 0~2 的口径）：
 *   · **硬断言逐条对应设计稿的验收标准**，每条都能被变异打红；
 *   · **集合相等的口径复用 `src/vector/bucketAssign.ts` 的
 *     `diffBucketMembership()` / `isBucketMembershipConsistent()`** ⇒ **不写第二份**；
 *   · **桶表可以直接读写**（本文件在 `tests/` 下 ⇒ 不在 §9.3.0「唯一写入点」的管辖范围内）；
 *     但**归属的写入一律走 `assignBucket`** ⇒ 不手工 INSERT 归属行
 *     （**唯一例外**：「真孤儿」与「重复归属」两条断言**必须**手工造 ⇒ 那是脏数据，
 *     正常路径根本写不出来）。
 *
 * ⚠️ **为什么「真孤儿」与「重复归属」要手工造**：
 *   · 真孤儿 ⇒ 外键 `ON DELETE CASCADE` 兜底 ⇒ 正常路径**造不出来**
 *     ⇒ 必须临时关掉 `foreign_keys`（这正是「硬删且 FK 未开」的形状）；
 *   · 重复归属 ⇒ 唯一索引 `idx_vcm_memory_unique` 兜底 ⇒ 正常路径**造不出来**
 *     ⇒ 必须临时删掉那个索引。
 */

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { EventWriter } from '../../src/store/events.js';
import { MemoryMaintainer, computeBucketCoverage } from '../../src/store/maintain.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { MemoryLogger } from '../../src/util/log.js';
import {
  type BucketAssignContext,
  assignBucket,
  diffBucketMembership,
  isBucketMembershipConsistent,
  listBucketMemberCounts,
  scanBucketSide,
} from '../../src/vector/bucketAssign.js';
import {
  bucketQualityOf,
  measureBucketQuality,
  percentile95,
} from '../../src/vector/bucketQuality.js';
import { CentroidCache } from '../../src/vector/centroids.js';
import { trainCentroids } from '../../src/vector/ivf.js';
import { reconcileBuckets } from '../../src/vector/reconcile.js';
import { createTestDb, insertMemories, pseudoUnitVector } from '../fixtures/vector.js';

/** 一个固定的时间基准。 */
const T0 = 1_700_000_000_000;

/** 训练与运行期共用的探针数（**必须一致**，§4.15.3）。 */
const NPROBE = 2;

/** 桶形状（粗 4 / 细 40 ⇒ 每个粗桶 10 个细桶 ⇒ 至少两个细桶，够造重复归属）。 */
const COARSE = 4;
const FINE = 40;

/** 夹具。 */
interface Fixture {
  db: Database.Database;
  maintainer: MemoryMaintainer;
  logger: MemoryLogger;
  centroids: CentroidCache;
  /** 活记忆（带向量、未删）的 id。 */
  liveIds: string[];
}

/**
 * 建一个夹具：40 条带向量的活记忆 + 已训练的第一代桶 + 全量入桶。
 *
 * ⚠️ **入桶走 `assignBucket`**（§9.3.0 的唯一写入点）⇒ 本文件不手工 INSERT 归属行
 *   （「真孤儿」/「重复归属」两条脏数据断言除外）。
 */
function createFixture(): Fixture {
  const db = createTestDb();
  const vectors: Float32Array[] = [];
  for (let index = 0; index < 40; index += 1) {
    vectors.push(pseudoUnitVector(index + 1));
  }
  const liveIds = insertMemories(db, vectors);

  const logger = new MemoryLogger();
  const events = new EventWriter(db, { readonly: false, logger, now: () => T0 });
  const centroids = new CentroidCache(db);
  const buckets: BucketAssignContext = {
    db,
    centroids: () => centroids.model(),
    nprobeCoarse: NPROBE,
  };

  const maintainer = new MemoryMaintainer({
    db,
    params: {
      ...DEFAULT_PARAMS,
      ROUTER_COARSE_CENTERS: COARSE,
      ROUTER_FINE_CENTERS: FINE,
      ROUTER_NPROBE_COARSE: NPROBE,
    },
    events,
    logger,
    buckets,
    reloadCentroids: () => centroids.reload(),
  });

  return { db, maintainer, logger, centroids, liveIds };
}

/** 训练第一代桶并把全部活记忆入桶（模拟「写路径已经跑过」的库）。 */
function seedBuckets(fixture: Fixture): void {
  const { db, liveIds } = fixture;
  const { model } = trainCentroids(db, {
    coarseCenters: COARSE,
    fineCenters: FINE,
    nprobeCoarse: NPROBE,
    now: T0,
  });
  runWriteTransaction(db, () => {
    for (const id of liveIds) {
      const vector = pseudoUnitVector(Number(id.slice(2)) + 1);
      assignBucket({ db, centroids: () => model, nprobeCoarse: NPROBE }, id, vector);
    }
  });
}

/** 造一条「没有向量」的记忆（`embedding IS NULL`）。 */
function insertVectorlessMemory(db: Database.Database, id: string): void {
  db.prepare(
    'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
      'stability, difficulty, pin_factor, created_at, last_access, deleted, deleted_at) ' +
      'VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'fact', `内容 ${id}`, `内容 ${id}`, `hash-${id}`, 100, 0.5, 1, T0, T0, 0, null);
}

/** 造一条「真孤儿」归属（指向不存在的记忆）—— 必须临时关掉外键。 */
function insertOrphanMembership(db: Database.Database, fineId: string, memoryId: string): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
      fineId,
      memoryId,
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** 造一条「重复归属」—— 必须先删掉唯一索引（源头堵的第 ③ 条判据）。 */
function insertDuplicateMembership(db: Database.Database, fineId: string, memoryId: string): void {
  db.exec('DROP INDEX IF EXISTS idx_vcm_memory_unique');
  db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
    fineId,
    memoryId,
  );
}

/** 读某个记忆当前的桶归属（`null` = 没有归属）。 */
function fineIdOf(db: Database.Database, memoryId: string): string | null {
  const row = db
    .prepare('SELECT fine_id FROM vector_cell_members WHERE memory_id = ?')
    .get(memoryId) as { fine_id: string } | undefined;
  return row?.fine_id ?? null;
}

/** 读出全部细桶 id（升序）。 */
function listFineIds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT fine_id FROM vector_fine_cells ORDER BY fine_id').all() as Array<{
    fine_id: string;
  }>;
  return rows.map((row) => row.fine_id);
}

describe('P2-T06 · 启动对账与桶质量退化检测', () => {
  it('缺失补齐：人为删掉一条归属 ⇒ 对账后它被补回（进最近的当前代细桶）', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    const victim = fixture.liveIds[0] as string;

    // ⚠️ **人为制造「缺失」**：删掉那条归属行。
    fixture.db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run(victim);
    expect(fineIdOf(fixture.db, victim)).toBeNull();

    const outcome = fixture.maintainer.reconcileBuckets();
    expect(outcome.report.missing).toBe(1);
    expect(outcome.report.assigned).toBe(1);

    // ⚠️ **补回来了** ⇒ 而且落在一个**存在**的当前代细桶里。
    const fineId = fineIdOf(fixture.db, victim);
    expect(fineId).not.toBeNull();
    expect(listFineIds(fixture.db)).toContain(fineId as string);
    expect(outcome.report.consistentAfterRepair).toBe(true);
  });

  it('脏行清理：给一条 embedding IS NULL 的记忆加桶归属 ⇒ 对账后被删', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    insertVectorlessMemory(fixture.db, 'm-novector');
    const someFineId = listFineIds(fixture.db)[0] as string;

    // ⚠️ **人为制造「脏行」**：无向量的记忆却占着桶。
    fixture.db
      .prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)')
      .run(someFineId, 'm-novector');

    const outcome = fixture.maintainer.reconcileBuckets();
    expect(outcome.report.vectorless).toBe(1);
    expect(outcome.report.dirty).toBe(1);
    expect(outcome.report.unassigned).toBe(1);
    expect(fineIdOf(fixture.db, 'm-novector')).toBeNull();
  });

  it('软删保留：软删一条有向量的记忆 ⇒ 对账后它的桶归属仍在（不被删）', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    const victim = fixture.liveIds[1] as string;
    const before = fineIdOf(fixture.db, victim);

    // ⚠️ **人为软删**（软删**保留向量**，§8.2）。
    //   ⚠️ `deleted_at` 必须同时置上（§3 的 CHECK：`deleted = 1` ⇒ `deleted_at IS NOT NULL`）。
    fixture.db
      .prepare('UPDATE memories SET deleted = 1, deleted_at = ? WHERE id = ?')
      .run(T0, victim);

    const outcome = fixture.maintainer.reconcileBuckets();
    // ⚠️ **软删走「跳过、不删」那一支**（§9.3.2 ②）。
    expect(outcome.report.softDeleted).toBe(1);
    expect(outcome.report.dirty).toBe(0);
    expect(outcome.report.unassigned).toBe(0);
    // ⚠️ ★ **归属仍在** ⇒ `restore()` 之后它还能进向量路
    //   （一刀切删掉就是「永久漏召」，§9.3.2 ② 的静默失效点）。
    expect(fineIdOf(fixture.db, victim)).toBe(before);
  });

  it('真孤儿删除：人为插一条指向不存在 memory 的桶行 ⇒ 对账后被删', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    const someFineId = listFineIds(fixture.db)[0] as string;

    insertOrphanMembership(fixture.db, someFineId, 'm-ghost');

    const outcome = fixture.maintainer.reconcileBuckets();
    expect(outcome.report.orphans).toBe(1);
    expect(outcome.report.dirty).toBe(1);
    expect(outcome.report.unassigned).toBe(1);
    expect(fineIdOf(fixture.db, 'm-ghost')).toBeNull();
  });

  it('重复归属检出：绕过唯一索引造出重复 ⇒ 判据 ② 检出（报告而不静默放过）', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    const victim = fixture.liveIds[2] as string;
    const otherFineId = (listFineIds(fixture.db).find(
      (id) => id !== fineIdOf(fixture.db, victim),
    ) ?? '') as string;

    insertDuplicateMembership(fixture.db, otherFineId, victim);

    const outcome = fixture.maintainer.reconcileBuckets();
    // ⚠️ ★ **判据 ② 检出**（`COUNT(*) == COUNT(DISTINCT memory_id)`）。
    expect(outcome.report.duplicates).toBe(1);
    // ⚠️ ★ **任一非零 ⇒ 不得报告「对账通过」**。
    expect(outcome.report.consistent).toBe(false);
    // ⚠️ **重复归属不自动修**（哪条该留无法判定 ⇒ 猜错 = 挂到错误的桶）
    //   ⇒ 修复后**仍然**不一致 ⇒ 调用方据此知道「必须显式重训才能修好」。
    expect(outcome.report.consistentAfterRepair).toBe(false);
    // ⚠️ **也不静默放过** ⇒ 记了告警。
    expect(fixture.logger.lines.some((line) => line.level === 'warn')).toBe(true);
  });

  it('三条判据齐过：返回值分别报告「缺失数」「脏行数」「重复数」', () => {
    const fixture = createFixture();
    seedBuckets(fixture);

    // ⚠️ **干净库**：三条判据**全过** ⇒ 报告「对账通过」。
    const clean = fixture.maintainer.reconcileBuckets();
    expect(clean.report.missing).toBe(0);
    expect(clean.report.dirty).toBe(0);
    expect(clean.report.duplicates).toBe(0);
    expect(clean.report.consistent).toBe(true);
    expect(clean.report.consistentAfterRepair).toBe(true);

    // ⚠️ **造一处「缺失」** ⇒ 只报缺失、脏行与重复仍是 0 ⇒ 但**不报告通过**。
    fixture.db
      .prepare('DELETE FROM vector_cell_members WHERE memory_id = ?')
      .run(fixture.liveIds[3] as string);
    const dirty = fixture.maintainer.reconcileBuckets();
    expect(dirty.report.missing).toBe(1);
    expect(dirty.report.dirty).toBe(0);
    expect(dirty.report.duplicates).toBe(0);
    expect(dirty.report.consistent).toBe(false);
  });

  it('★ 集合比较而不是 COUNT 比较：条数相同但成员不同 ⇒ 必须查出来', () => {
    const fixture = createFixture();
    seedBuckets(fixture);

    // ⚠️ ★ **两侧条数相同、成员不同**：删掉 A 的归属、给 B 造一条多余的归属
    //   （B 本来就有一条 ⇒ 变重复 ⇒ 条数 +1 ⇒ 用「删一条、补一条」把总数拉回相同）。
    const victim = fixture.liveIds[4] as string;
    const other = fixture.liveIds[5] as string;
    fixture.db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run(victim);
    insertDuplicateMembership(
      fixture.db,
      (listFineIds(fixture.db).find((id) => id !== fineIdOf(fixture.db, other)) ?? '') as string,
      other,
    );

    const liveCount = fixture.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL AND deleted = 0')
      .get() as { n: number };
    const bucketCount = fixture.db
      .prepare('SELECT COUNT(*) AS n FROM vector_cell_members')
      .get() as { n: number };
    // ⚠️ **条数确实相同**（各删一条、各加一条）⇒ 用 COUNT 比较会**假通过**。
    expect(bucketCount.n).toBe(liveCount.n);

    const outcome = fixture.maintainer.reconcileBuckets();
    // ⚠️ ★ **集合比较把它查出来了**。
    expect(outcome.report.missing).toBe(1);
    expect(outcome.report.duplicates).toBe(1);
    expect(outcome.report.consistent).toBe(false);
  });

  it('P95 计算与手算一致（构造已知分布的桶）', () => {
    // ⚠️ **手算**：升序 [1,2,3,4,5,6,7,8,9,10] ⇒ N=10 ⇒ 名次 = ceil(0.95×10) = 10
    //   ⇒ 第 10 个（1 起）= **10**（最近秩法）。
    expect(percentile95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
    // ⚠️ **手算**：N=20 ⇒ 名次 = ceil(0.95×20) = 19 ⇒ 第 19 个（1 起）。
    expect(percentile95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
    // ⚠️ **N=1 ⇒ 就是那一个**。
    expect(percentile95([7])).toBe(7);
    // ⚠️ **空分布 ⇒ 0**（库里一个成员都没有）。
    expect(percentile95([])).toBe(0);

    // ⚠️ **用「每桶成员数」这个口径算**（P95 是**分位数**、max 是**极值** ⇒ 两者不可互换）。
    const counts = new Map([
      ['f-000', 1],
      ['f-001', 2],
      ['f-002', 3],
      ['f-003', 4],
      ['f-004', 5],
      ['f-005', 6],
      ['f-006', 7],
      ['f-007', 8],
      ['f-008', 9],
      ['f-009', 10],
    ]);
    const quality = measureBucketQuality(counts, 300);
    expect(quality.p95BucketSize).toBe(10);
    expect(quality.maxBucketSize).toBe(10);
    expect(quality.members).toBe(55);
    expect(quality.fineCells).toBe(10);
    expect(quality.degraded).toBe(false);
  });

  it('P95 与对账共用一次扫描：桶计数与桶侧行同源（成员总数 == 归属行数）', () => {
    const fixture = createFixture();
    seedBuckets(fixture);

    const outcome = fixture.maintainer.reconcileBuckets();
    const rowCount = fixture.db.prepare('SELECT COUNT(*) AS n FROM vector_cell_members').get() as {
      n: number;
    };

    // ⚠️ ★ **计数与行来自同一次扫描** ⇒ 两者的总数必须相等。
    expect(outcome.quality.members).toBe(rowCount.n);
    // ⚠️ **桶计数与 `listBucketMemberCounts()` 逐条相同**（同一份实现的两个出口，C36）。
    const counts = listBucketMemberCounts(fixture.db);
    expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(rowCount.n);
    expect(outcome.quality.fineCells).toBe(counts.size);
  });

  it('P95 > ROUTER_BUCKET_MAX ⇒ 建议重训（degraded=true），但库不自动重训', () => {
    const fixture = createFixture();
    seedBuckets(fixture);

    // ⚠️ **把上限压到 1** ⇒ 正常分布（每桶 1~10 个成员）的 P95 必然超标。
    const outcome = reconcileBuckets(
      fixture.db,
      <T>(body: () => T): T => runWriteTransaction(fixture.db, body),
      {
        centroids: () => fixture.centroids.model(),
        nprobeCoarse: NPROBE,
        maxBucketSize: 1,
        detectOnly: true,
      },
    );

    expect(outcome.quality.degraded).toBe(true);
    expect(outcome.quality.p95BucketSize).toBeGreaterThan(1);

    // ⚠️ ★ **库不自动重训** ⇒ 桶表**一个字节都没变**。
    const before = listFineIds(fixture.db);
    const membersBefore = fixture.db
      .prepare('SELECT COUNT(*) AS n FROM vector_cell_members')
      .get() as { n: number };
    expect(listFineIds(fixture.db)).toEqual(before);
    expect(
      (fixture.db.prepare('SELECT COUNT(*) AS n FROM vector_cell_members').get() as { n: number })
        .n,
    ).toBe(membersBefore.n);
  });

  it('inRetrain 边界：重训进行中 ⇒ 对账整体跳过（不检测、不修复）并报告', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    // ⚠️ **人为制造一处缺失** ⇒ 若对账照常跑，它会被补回来。
    const victim = fixture.liveIds[6] as string;
    fixture.db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run(victim);

    const outcome = reconcileBuckets(
      fixture.db,
      <T>(body: () => T): T => runWriteTransaction(fixture.db, body),
      {
        centroids: () => fixture.centroids.model(),
        nprobeCoarse: NPROBE,
        isRetraining: () => true,
      },
    );

    // ⚠️ ★ **跳过必须被显式报告**（不静默）⇒ 否则调用方会把「没查」当成「查过了、没问题」。
    expect(outcome.report.skipReason).toBe('retrain-in-progress');
    expect(outcome.report.consistent).toBe(false);
    // ⚠️ **一个字节都没动**（缺失还在 ⇒ 没补）。
    expect(fineIdOf(fixture.db, victim)).toBeNull();
    expect(outcome.report.assigned).toBe(0);
  });

  it('桶覆盖率（§6 的 bucketCoverage）：有向量但没入桶 ⇒ 覆盖率 < 1', () => {
    const fixture = createFixture();
    seedBuckets(fixture);

    // ⚠️ **干净库 ⇒ 覆盖率 1**（全部已入桶）。
    expect(computeBucketCoverage(fixture.db)).toBe(1);

    // ⚠️ **删掉一条归属 ⇒ 覆盖率掉下来**（它是**健康度**指标 ⇒ 测的是修复**前**的状态）。
    fixture.db
      .prepare('DELETE FROM vector_cell_members WHERE memory_id = ?')
      .run(fixture.liveIds[7] as string);
    expect(computeBucketCoverage(fixture.db)).toBeLessThan(1);
  });

  it('对账后的库仍与既有口径一致（集合相等），且没有残留脏行', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    insertVectorlessMemory(fixture.db, 'm-novector');
    const someFineId = listFineIds(fixture.db)[0] as string;
    fixture.db
      .prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)')
      .run(someFineId, 'm-novector');
    fixture.db
      .prepare('DELETE FROM vector_cell_members WHERE memory_id = ?')
      .run(fixture.liveIds[8] as string);

    const outcome = fixture.maintainer.reconcileBuckets();
    expect(outcome.report.consistentAfterRepair).toBe(true);

    // ⚠️ **既有口径**（T03-b 的 `diffBucketMembership` / `isBucketMembershipConsistent`）也一致。
    const diff = diffBucketMembership(fixture.db);
    expect(isBucketMembershipConsistent(diff)).toBe(true);
    expect(diff.missing).toEqual([]);
    expect(diff.orphans).toEqual([]);
    expect(diff.vectorless).toEqual([]);
    expect(diff.duplicates).toEqual([]);
  });

  it('桶计数与桶侧扫描同源：scanBucketSide 的计数 == listBucketMemberCounts', () => {
    const fixture = createFixture();
    seedBuckets(fixture);
    const scan = scanBucketSide(fixture.db);
    const counts = listBucketMemberCounts(fixture.db);
    expect([...scan.counts.entries()].sort()).toEqual([...counts.entries()].sort());
    // ⚠️ **独立算一次质量**（不与对账共用扫描）⇒ 结果必须与对账那次**逐条相同**。
    const standalone = bucketQualityOf(fixture.db, DEFAULT_PARAMS.ROUTER_BUCKET_MAX);
    const outcome = fixture.maintainer.reconcileBuckets();
    expect(standalone.p95BucketSize).toBe(outcome.quality.p95BucketSize);
    expect(standalone.maxBucketSize).toBe(outcome.quality.maxBucketSize);
    expect(standalone.members).toBe(outcome.quality.members);
  });
});
