/**
 * `rebuildVectorBuckets` 的**集成测试** —— P2-T05（DESIGN-v2.md §4.15.5 的三步硬约束；
 * DEVELOPMENT-PLAN.md P2-T05 的验收标准）。
 *
 * ⚠️ **本文件的断言纪律**（沿用阶段 0~2 的口径）：
 *   · **硬断言逐条对应设计稿的验收标准**，每条都能被变异打红；
 *   · **集合相等的口径复用 `src/vector/bucketAssign.ts` 的
 *     `diffBucketMembership()` / `isBucketMembershipConsistent()`** ⇒ **不写第二份**；
 *   · **桶表可以直接读**（本文件在 `tests/` 下 ⇒ 不在 §9.3.0「唯一写入点」的管辖范围内）；
 *     但**归属的写入一律走 `assignBucket`** ⇒ 不手工 INSERT 归属行。
 *
 * ⚠️ **为什么「并发读者」那条断言要用两个连接**（§4.15.5 的验收标准）：
 *   「单条记忆的 DELETE + INSERT 在**同一个事务**内（用并发读者验证：
 *   事务外读者永不见中间态）」⇒ 同一个连接看不到自己的未提交写入 ⇒ 必须另开一条连接。
 *   ⇒ 库必须是**文件库**（`:memory:` 库不能被第二条连接打开）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { openDatabase } from '../../src/db/connection.js';
import { ensureSchema } from '../../src/db/migrate.js';
import { EventWriter } from '../../src/store/events.js';
import { MemoryMaintainer } from '../../src/store/maintain.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { MemoryLogger } from '../../src/util/log.js';
import {
  assignBucket,
  diffBucketMembership,
  isBucketMembershipConsistent,
} from '../../src/vector/bucketAssign.js';
import { CentroidCache } from '../../src/vector/centroids.js';
import { trainCentroids } from '../../src/vector/ivf.js';
import { type BucketRebuildHooks, rebuildBuckets } from '../../src/vector/rebuild.js';
import {
  createTestDb,
  insertMemories,
  insertMemory,
  pseudoUnitVector,
} from '../fixtures/vector.js';

/** 一个固定的时间基准。 */
const T0 = 1_700_000_000_000;

/**
 * 训练与运行期共用的探针数。
 *
 * ⚠️ **必须一致**（§4.15.3）：训练期与运行期用同一套规则
 *   ⇒ 训练算出的归属与写入算出的归属一致 ⇒ 不会产生无谓的桶 churn。
 */
const NPROBE = 2;

/** 第一代桶的形状（粗 4 / 细 40 ⇒ 每个粗桶 10 个细桶）。 */
const FIRST_COARSE = 4;
const FIRST_FINE = 40;

/** 第二代桶的形状（粗 4 / 细 20 ⇒ 每个粗桶 5 个细桶 ⇒ 第一代的一部分细桶变陈旧）。 */
const SECOND_COARSE = 4;
const SECOND_FINE = 20;

/**
 * 一个**注定不在任何模型里**的细桶 id（用来造「空的旧代桶」）。
 *
 * ⚠️ **为什么它一定不在模型里**：模型的细桶 id 是**索引派生**的
 *   （`f-<粗桶序号>-<细桶序号>`，粗桶序号 < 粗中心数、细桶序号 < 细中心数）
 *   ⇒ `f-999-999` 只可能在粗中心数 > 999 且细中心数 > 999 时出现 ⇒ 本文件不可能。
 */
const STALE_FINE_ID = 'f-999-999';

/** 夹具。 */
interface Fixture {
  db: Database.Database;
  /** 记忆 id（顺序即向量顺序）。 */
  ids: string[];
  /** 向量（顺序即 id 顺序）。 */
  vectors: Float32Array[];
  /** 维护器（`rebuildVectorBuckets` 的落点）。 */
  maintainer: MemoryMaintainer;
  /** 日志器（断言「告警并放行」）。 */
  logger: MemoryLogger;
  /** 中心缓存。 */
  centroids: CentroidCache;
  /** **重训期间**观测到的 `inRetrain` 采样（由重训钩子采集）。 */
  inRetrainSamples: boolean[];
}

/**
 * 建一个夹具：40 条带向量的记忆 + 一个维护器。
 *
 * ⚠️ **`inRetrain` 的采样点挂在重训钩子上**：
 *   钩子 `onMemberAssigned` 在**步骤 ② 的事务之内**被调用
 *   ⇒ 那一刻正是「重训进行中」⇒ 采样到的 `inRetrain` 必须是 `true`。
 *   ⇒ **不需要**给公开 API 加观测成员（§6 的公开面是 23 个方法）。
 */
function createFixture(options?: { count?: number }): Fixture {
  const db = createTestDb();
  const count = options?.count ?? 40;
  const vectors: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    vectors.push(pseudoUnitVector(index + 1));
  }
  const ids = insertMemories(db, vectors);

  const logger = new MemoryLogger();
  const events = new EventWriter(db, { readonly: false, logger, now: () => T0 });
  const centroids = new CentroidCache(db);
  const inRetrainSamples: boolean[] = [];

  const buckets = {
    db,
    centroids: () => centroids.model(),
    nprobeCoarse: NPROBE,
  };

  const maintainer = new MemoryMaintainer({
    db,
    params: {
      ...DEFAULT_PARAMS,
      ROUTER_COARSE_CENTERS: FIRST_COARSE,
      ROUTER_FINE_CENTERS: FIRST_FINE,
      ROUTER_NPROBE_COARSE: NPROBE,
    },
    events,
    logger,
    buckets,
    reloadCentroids: () => centroids.reload(),
    hooks: {
      onMemberAssigned: () => {
        // ⚠️ **闭包里读 `maintainer`**：钩子在**重训过程中**才被调用
        //   ⇒ 那时 `maintainer` 已绑定 ⇒ 读到的就是**本次重训**的状态。
        inRetrainSamples.push(maintainer.inRetrain);
      },
    },
  });

  return { db, ids, vectors, maintainer, logger, centroids, inRetrainSamples };
}

/**
 * 建立「第一代桶」（训练 + 全量入桶）—— 模拟一个**写路径已经跑过**的库。
 *
 * ⚠️ **入桶走 `assignBucket`**（§9.3.0 的唯一写入点）⇒ 本文件不手工 INSERT 归属行。
 */
function seedFirstGeneration(fixture: Fixture): void {
  const { db, ids, vectors } = fixture;
  const { model } = trainCentroids(db, {
    coarseCenters: FIRST_COARSE,
    fineCenters: FIRST_FINE,
    nprobeCoarse: NPROBE,
    now: T0,
  });
  runWriteTransaction(db, () => {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const vector = vectors[index];
      if (id === undefined || vector === undefined) {
        continue;
      }
      assignBucket({ db, centroids: () => model, nprobeCoarse: NPROBE }, id, vector);
    }
  });
}

/** 造一个「空的旧代桶」（有细桶行、成员数为 0、且不在任何模型里）。 */
function insertStaleEmptyFineCell(db: Database.Database): void {
  // ⚠️ **父粗桶必须存在**（外键）⇒ 借第一代的粗桶。
  const coarse = db.prepare('SELECT coarse_id FROM vector_coarse_cells ORDER BY coarse_id').get() as
    | { coarse_id: string }
    | undefined;
  if (coarse === undefined) {
    throw new Error('夹具异常：第一代桶不存在');
  }
  const centroid = Buffer.alloc(4);
  centroid.writeFloatLE(1, 0);
  db.prepare(
    'INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at) VALUES (?, ?, ?, ?)',
  ).run(STALE_FINE_ID, coarse.coarse_id, centroid, T0);
}

/** 读出库里全部细桶 id（升序）。 */
function listFineIds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT fine_id FROM vector_fine_cells ORDER BY fine_id').all() as Array<{
    fine_id: string;
  }>;
  return rows.map((row) => row.fine_id);
}

/** 读出全部桶归属（`memory_id` → `fine_id`，按 `memory_id` 升序）。 */
function snapshotMembership(db: Database.Database): Array<[string, string]> {
  const rows = db
    .prepare('SELECT memory_id, fine_id FROM vector_cell_members ORDER BY memory_id')
    .all() as Array<{ memory_id: string; fine_id: string }>;
  return rows.map((row) => [row.memory_id, row.fine_id]);
}

describe('P2-T05 · rebuildVectorBuckets（重训、崩溃恢复、旧代桶清理）', () => {
  it('重训后桶归属完整：桶归属的 memory_id 集合 == 库侧有向量活记忆的 id 集合（集合相等）', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);

    const result = fixture.maintainer.rebuildVectorBuckets({ reason: 'test' });

    // ⚠️ **集合相等**（不是比条数）：条数相同但成员不同 ⇒ 漏召永久存在且无人发现。
    const diff = diffBucketMembership(fixture.db);
    expect(diff.missing).toEqual([]);
    expect(diff.orphans).toEqual([]);
    expect(diff.vectorless).toEqual([]);
    expect(diff.duplicates).toEqual([]);
    expect(isBucketMembershipConsistent(diff)).toBe(true);

    // ⚠️ **字面的集合相等**（本夹具没有软删记忆 ⇒ 两侧必须**完全相等**）。
    const bucketIds = new Set(snapshotMembership(fixture.db).map(([memoryId]) => memoryId));
    const liveIds = new Set(fixture.ids);
    expect([...bucketIds].sort()).toEqual([...liveIds].sort());

    // ⚠️ **归属条数 == 全库有向量记忆数**（§4.15.5 的验收标准）。
    expect(result.members).toBe(fixture.ids.length);
  });

  it('删除顺序不可颠倒：步骤 ③ 之前旧代桶仍在（且新桶已存在），步骤 ③ 之后旧代桶全部消失', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);
    insertStaleEmptyFineCell(fixture.db);

    const staleAtStep1: boolean[] = [];
    const staleAtStep2: boolean[] = [];
    const staleAtStep3: boolean[] = [];
    const newCellsAtStep1: boolean[] = [];

    const hooks: BucketRebuildHooks = {
      onCentroidsWritten: () => {
        const ids = listFineIds(fixture.db);
        staleAtStep1.push(ids.includes(STALE_FINE_ID));
        // ⚠️ **新代桶已存在**（步骤 ① 就把中心写进去了）。
        newCellsAtStep1.push(ids.some((id) => id !== STALE_FINE_ID));
      },
      onMembersMigrated: () => {
        staleAtStep2.push(listFineIds(fixture.db).includes(STALE_FINE_ID));
      },
      onStalePruned: () => {
        staleAtStep3.push(listFineIds(fixture.db).includes(STALE_FINE_ID));
      },
    };

    rebuildBuckets(fixture.db, <T>(body: () => T): T => runWriteTransaction(fixture.db, body), {
      coarseCenters: SECOND_COARSE,
      fineCenters: SECOND_FINE,
      nprobeCoarse: NPROBE,
      now: T0 + 1,
      hooks,
    });

    // ⚠️ **步骤 ① 之后**：新桶已存在，**旧代桶一个都没删**。
    expect(newCellsAtStep1).toEqual([true]);
    expect(staleAtStep1).toEqual([true]);
    // ⚠️ **步骤 ② 之后、③ 之前**：旧代桶**仍在**（成员行已摘空 ⇒ 它是「空旧桶」）。
    expect(staleAtStep2).toEqual([true]);
    // ⚠️ **步骤 ③ 之后**：旧代桶**全部消失**。
    expect(staleAtStep3).toEqual([false]);
    expect(listFineIds(fixture.db)).not.toContain(STALE_FINE_ID);
  });

  it('空的旧代桶被清理：重训后不存在「成员数为 0 的旧代细桶」', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);
    insertStaleEmptyFineCell(fixture.db);

    // ⚠️ **造桶前**：那个桶确实存在、且成员数为 0。
    expect(listFineIds(fixture.db)).toContain(STALE_FINE_ID);

    fixture.maintainer.rebuildVectorBuckets({ reason: 'test' });

    // ⚠️ **重训后**：旧代桶（不在新模型里的）全部消失。
    expect(listFineIds(fixture.db)).not.toContain(STALE_FINE_ID);
    // ⚠️ **且没有任何归属指向已删除的桶**（否则那是悬空行 ⇒ 路由命中即空候选集）。
    const fineIds = new Set(listFineIds(fixture.db));
    for (const [, fineId] of snapshotMembership(fixture.db)) {
      expect(fineIds.has(fineId)).toBe(true);
    }
  });

  it('形状变化后残留的旧代桶也被清掉（新模型里不存在的细桶一个都不留）', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);
    const firstGeneration = new Set(listFineIds(fixture.db));

    // ⚠️ **第二代用更少的细桶** ⇒ 第一代的一部分细桶不在新模型里 ⇒ 属于旧代桶。
    rebuildBuckets(fixture.db, <T>(body: () => T): T => runWriteTransaction(fixture.db, body), {
      coarseCenters: SECOND_COARSE,
      fineCenters: SECOND_FINE,
      nprobeCoarse: NPROBE,
      now: T0 + 1,
    });

    const secondGeneration = new Set(listFineIds(fixture.db));
    expect(secondGeneration.size).toBeLessThan(firstGeneration.size);
    // ⚠️ **新模型之外的细桶一个都不留**（就是「清空旧代桶」）。
    const survivors = [...secondGeneration].filter((id) => !firstGeneration.has(id));
    expect(survivors).toEqual([]);
  });

  it('重训是幂等的：连做两次 ⇒ 桶归属与桶集合逐条相同', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);

    fixture.maintainer.rebuildVectorBuckets({ reason: 'first' });
    const firstMembership = snapshotMembership(fixture.db);
    const firstCells = listFineIds(fixture.db);

    fixture.maintainer.rebuildVectorBuckets({ reason: 'second' });
    expect(snapshotMembership(fixture.db)).toEqual(firstMembership);
    expect(listFineIds(fixture.db)).toEqual(firstCells);
  });

  it('崩溃恢复：② 提交了一部分 ⇒ 旧桶仍在、库仍可用；重做一次 ⇒ 归属与一次跑完完全一致', () => {
    // ⚠️ **两个夹具、同一份数据** ⇒ 训练与归属**逐条相同** ⇒ 两个结果可以直接比。
    const crashed = createFixture();
    const clean = createFixture();
    seedFirstGeneration(crashed);
    seedFirstGeneration(clean);
    insertStaleEmptyFineCell(crashed.db);

    // ⚠️ **模拟崩溃**：第 2 批开始前抛错 ⇒ 前 2 批已提交、后面的没跑。
    expect(() =>
      rebuildBuckets(crashed.db, <T>(body: () => T): T => runWriteTransaction(crashed.db, body), {
        coarseCenters: SECOND_COARSE,
        fineCenters: SECOND_FINE,
        nprobeCoarse: NPROBE,
        now: T0 + 1,
        batchSize: 10,
        hooks: {
          onBatchStart: (batchIndex) => {
            if (batchIndex === 2) {
              throw new Error('模拟崩溃');
            }
          },
        },
      }),
    ).toThrow('模拟崩溃');

    // ⚠️ **库仍可用**（不是被 CASCADE 清空）：每条记忆仍有且仅有一个归属。
    const intermediate = diffBucketMembership(crashed.db);
    expect(intermediate.missing).toEqual([]);
    expect(intermediate.duplicates).toEqual([]);
    // ⚠️ **旧桶仍在**（步骤 ③ 没跑到 ⇒ 一个旧桶都没删）。
    expect(listFineIds(crashed.db)).toContain(STALE_FINE_ID);

    // ⚠️ **重做一次**（幂等 ⇒ 不依赖上一轮的中间产物）。
    crashed.maintainer.rebuildVectorBuckets({ reason: 'recovery' });

    const recovered = diffBucketMembership(crashed.db);
    expect(isBucketMembershipConsistent(recovered)).toBe(true);
    // ⚠️ **无空旧桶**：旧代桶被清掉了。
    expect(listFineIds(crashed.db)).not.toContain(STALE_FINE_ID);

    // ⚠️ **与一次跑完完全一致**。
    clean.maintainer.rebuildVectorBuckets({ reason: 'clean' });
    expect(snapshotMembership(crashed.db)).toEqual(snapshotMembership(clean.db));
    expect(listFineIds(crashed.db)).toEqual(listFineIds(clean.db));
  });

  it('重训事件：events(type=sweep, action=rebuildBuckets, payload={cells, members})', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);

    const result = fixture.maintainer.rebuildVectorBuckets({ reason: 'test' });

    const rows = fixture.db
      .prepare('SELECT type, memory_id, payload FROM events WHERE type = ? ORDER BY at, rowid')
      .all('sweep') as Array<{ type: string; memory_id: string | null; payload: string }>;
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.type).toBe('sweep');
    // ⚠️ **memory_id 一律填 null**（§8.4：这些动作不针对单条记忆）。
    expect(row?.memory_id).toBeNull();

    const payload = JSON.parse(row?.payload ?? '{}') as Record<string, unknown>;
    expect(payload.action).toBe('rebuildBuckets');
    expect(payload.cells).toBe(result.cells);
    expect(payload.members).toBe(result.members);
    // ⚠️ **字段集逐键等于 §8.4 硬规则 4 的 `action='rebuildBuckets'` 分组**
    //   ⇒ 不许把 `purged` / `vacuumed` 之类**本次没发生**的事实填进去。
    expect(Object.keys(payload).sort()).toEqual(['action', 'cells', 'members']);
  });

  it('重训期间 inRetrain == true（同实例内可观测），重训结束后复位为 false', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);

    expect(fixture.maintainer.inRetrain).toBe(false);
    fixture.maintainer.rebuildVectorBuckets({ reason: 'test' });

    // ⚠️ **采样点落在步骤 ② 的事务之内** ⇒ 那正是「重训进行中」。
    expect(fixture.inRetrainSamples.length).toBeGreaterThan(0);
    expect(fixture.inRetrainSamples.every((sample) => sample)).toBe(true);
    // ⚠️ **结束后必须复位**（漏复位 ⇒ 面板永远说「正在重训」⇒ 状态永久失真）。
    expect(fixture.maintainer.inRetrain).toBe(false);
  });

  it('重训后仍不达标 ⇒ 只重训一次 + 记告警放行（不抛错、不循环）', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);

    // ⚠️ **质量判据恒为「不达标」**（P95 的计算归 P2-T06 ⇒ 这里注入判据）。
    const outcome = fixture.maintainer.rebuildVectorBucketsOnce(() => true, { reason: 'startup' });
    expect(outcome.rebuilt).toBe(true);
    expect(outcome.degraded).toBe(true);

    // ⚠️ **第二次不再重训**（否则启动被拖成分钟级）。
    const second = fixture.maintainer.rebuildVectorBucketsOnce(() => true, { reason: 'startup' });
    expect(second.rebuilt).toBe(false);
    expect(second.degraded).toBe(true);

    // ⚠️ **告警被记下**（「记告警并放行」）。
    const warnings = fixture.logger.lines.filter((line) => line.level === 'warn');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('质量达标 ⇒ 不重训（重训是阻塞操作，不该无条件做）', () => {
    const fixture = createFixture();
    seedFirstGeneration(fixture);

    const outcome = fixture.maintainer.rebuildVectorBucketsOnce(() => false, { reason: 'startup' });
    expect(outcome.rebuilt).toBe(false);
    expect(outcome.degraded).toBe(false);
  });

  it('软删记忆：归属保留且迁到新代桶（restore 之后仍能进向量路）', () => {
    const fixture = createFixture({ count: 20 });
    // ⚠️ **多一条软删记忆**（软删**保留向量**，§8.2）⇒ id 必须**另起**（不与活记忆撞）。
    const softVector = pseudoUnitVector(999);
    insertMemory(fixture.db, 'm-soft', softVector, { deleted: true });
    seedFirstGeneration(fixture);

    // ⚠️ **软删之前它是活记忆 ⇒ 桶里有它**（§9.3.2 ②：软删**不删桶归属**）。
    const model = trainCentroids(fixture.db, {
      coarseCenters: FIRST_COARSE,
      fineCenters: FIRST_FINE,
      nprobeCoarse: NPROBE,
      now: T0,
    }).model;
    runWriteTransaction(fixture.db, () => {
      assignBucket(
        { db: fixture.db, centroids: () => model, nprobeCoarse: NPROBE },
        'm-soft',
        softVector,
      );
    });

    fixture.maintainer.rebuildVectorBuckets({ reason: 'test' });

    // ⚠️ **它的归属仍在**（软删不删桶归属 ⇒ `diff` 把它归到 `softDeleted` 那一支）。
    const softDeleted = diffBucketMembership(fixture.db).softDeleted;
    expect(softDeleted).toEqual(['m-soft']);

    // ⚠️ **而且迁到了新代桶**（不是挂在旧代桶上等它被级联删掉）：
    //   它的 fine_id 必须在**重训后仍存在的**细桶集合里。
    const fineIds = new Set(listFineIds(fixture.db));
    const entry = snapshotMembership(fixture.db).find(([memoryId]) => memoryId === 'm-soft');
    expect(entry).toBeDefined();
    expect(fineIds.has(entry?.[1] ?? '')).toBe(true);
  });

  it('同事务性：单条记忆的 DELETE + INSERT 在同一事务内（并发读者永不见中间态）', () => {
    // ⚠️ **必须是文件库**（`:memory:` 库不能被第二条连接打开）。
    const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-rebuild-'));
    const path = join(dir, 'rebuild.db');
    const db = openDatabase({ dbPath: path });
    ensureSchema(db);

    const vectors: Float32Array[] = [];
    for (let index = 0; index < 20; index += 1) {
      vectors.push(pseudoUnitVector(index + 1));
    }
    insertMemories(db, vectors);

    const { model } = trainCentroids(db, {
      coarseCenters: FIRST_COARSE,
      fineCenters: FIRST_FINE,
      nprobeCoarse: NPROBE,
      now: T0,
    });
    runWriteTransaction(db, () => {
      for (let index = 0; index < vectors.length; index += 1) {
        const vector = vectors[index];
        if (vector === undefined) {
          continue;
        }
        assignBucket(
          { db, centroids: () => model, nprobeCoarse: NPROBE },
          `m-${String(index).padStart(2, '0')}`,
          vector,
        );
      }
    });

    // ⚠️ **并发读者**：另开一条连接（WAL ⇒ 读不阻塞写）。
    const reader = openDatabase({ dbPath: path });
    const observedCounts: number[] = [];
    try {
      rebuildBuckets(db, <T>(body: () => T): T => runWriteTransaction(db, body), {
        coarseCenters: SECOND_COARSE,
        fineCenters: SECOND_FINE,
        nprobeCoarse: NPROBE,
        now: T0 + 1,
        hooks: {
          onMemberAssigned: (memoryId) => {
            // ⚠️ **读者只看已提交的状态** ⇒ 这一刻该记忆**必须仍有一个归属**
            //   （若是 0 ⇒ 说明 DELETE 与 INSERT 之间被暴露 ⇒ 事务边界错了）。
            const row = reader
              .prepare('SELECT COUNT(*) AS count FROM vector_cell_members WHERE memory_id = ?')
              .get(memoryId) as { count: number };
            observedCounts.push(row.count);
          },
        },
      });
    } finally {
      reader.close();
      db.close();
    }

    expect(observedCounts.length).toBeGreaterThan(0);
    // ⚠️ **永远不是 0** ⇒ 事务外读者从未见到「DELETE 已提交、INSERT 还没提交」的中间态。
    expect(observedCounts.every((count) => count === 1)).toBe(true);
  });
});
