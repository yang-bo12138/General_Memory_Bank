/**
 * `recluster()` 的集成断言 —— DESIGN-v2.md §4.12（簇的定义 / 物化 / 可复现性 /
 * 超大簇的三层防护），对应 DEVELOPMENT-PLAN.md **P3-T03**。
 *
 * ⚠️ **本文件打的是真库**（内存 SQLite）：事务回滚、外键级联、单行表的 `CHECK (id = 1)`
 *   这些只有真库才验得了。
 *
 * ⚠️ **断言必须真能失败**：涉及快照的断言都**逐行比对**（不只是行数）。
 */

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { recluster } from '../../src/store/clusters.js';
import { countRows, createTestStore, insertMemory, readEvents } from '../fixtures/graph-store.js';

/** 固定的「现在」（epoch 毫秒）。 */
const NOW = 1_700_000_000_000;

/**
 * 造一条共激活边（**自动按 `a < b` 归一** —— `coacts` 的 `CHECK (memory_a < memory_b)`）。
 */
function seedEdge(
  db: Database.Database,
  x: string,
  y: string,
  affinity: number,
  lastActive: number = NOW,
): void {
  const a = x < y ? x : y;
  const b = x < y ? y : x;
  db.prepare(
    `INSERT OR REPLACE INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
     VALUES (@a, @b, @affinity, 1, 1, @lastActive)`,
  ).run({ a, b, affinity, lastActive });
}

/**
 * 造一批**孤岛**记忆（没有任何共激活边）⇒ 把库撑大。
 *
 * ⚠️ **为什么需要它**：兜底切分的触发量是「**原始分量占全库多少**」⇒
 *   在只有 3 条记忆的小库里，**一个分量就占了 100%** ⇒ 切分必然触发
 *   ⇒ 「不切分」的用例必须先把分母撑大（否则断言的是「切了」而不是「没切」）。
 */
function seedFillers(db: Database.Database, count: number, prefix = 'f'): void {
  for (let index = 0; index < count; index += 1) {
    insertMemory(db, `${prefix}-${index}`);
  }
}

/** 读当前快照的簇（`cluster_id` ⇒ 成员 id 列表，按簇 id 升序）。 */
function readSnapshot(db: Database.Database): Array<{ clusterId: string; memberIds: string[] }> {
  const clusters = db
    .prepare('SELECT cluster_id FROM theme_clusters ORDER BY cluster_id')
    .all() as Array<{ cluster_id: string }>;
  return clusters.map((cluster) => ({
    clusterId: cluster.cluster_id,
    memberIds: (
      db
        .prepare(
          'SELECT memory_id FROM theme_cluster_members WHERE cluster_id = ? ORDER BY memory_id',
        )
        .all(cluster.cluster_id) as Array<{ memory_id: string }>
    ).map((row) => row.memory_id),
  }));
}

/** 读快照元信息（单行表）。 */
function readMeta(db: Database.Database): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM cluster_snapshot_meta WHERE id = 1').get() as
    | Record<string, unknown>
    | undefined;
}

describe('P3-T03 · recluster（快照发布）', () => {
  it('★ 第一次重算 ⇒ 发布快照（簇表 + 成员表 + 单行元信息表）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertMemory(db, 'm-3');
    seedFillers(db, 7);
    seedEdge(db, 'm-1', 'm-2', 0.5);
    seedEdge(db, 'm-2', 'm-3', 0.4);

    const result = recluster(store, NOW);

    expect(result.computed).toBe(true);
    expect(result.skipped).toBe(null);
    expect(result.clusterCount).toBe(1);

    const snapshot = readSnapshot(db);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.memberIds).toEqual(['m-1', 'm-2', 'm-3']);

    // ★ **单行表**（`CHECK (id = 1)`）：`SELECT count(*)` 必须 == 1
    expect(countRows(db, 'cluster_snapshot_meta')).toBe(1);
    const meta = readMeta(db);
    expect(meta?.version).toBe(1);
    expect(meta?.cluster_count).toBe(1);
    expect(meta?.member_count).toBe(3);
    expect(meta?.min_affinity).toBe(DEFAULT_PARAMS.COACT_AFFINITY_MIN);
    expect(meta?.computed_at).toBe(NOW);
  });

  it('★ 不变量：删掉两张簇表后重建 ⇒ 簇集合与成员划分**逐条相同**', () => {
    const { db, store } = createTestStore();
    for (let index = 1; index <= 6; index += 1) {
      insertMemory(db, `m-${index}`);
    }
    seedEdge(db, 'm-1', 'm-2', 0.5);
    seedEdge(db, 'm-2', 'm-3', 0.5);
    seedEdge(db, 'm-4', 'm-5', 0.5);
    seedEdge(db, 'm-5', 'm-6', 0.5);

    recluster(store, NOW);
    const first = readSnapshot(db);

    // ⚠️ **删掉两张簇表**（簇本体是缓存 ⇒ 定义永远是纯函数 ⇒ 重建必须一模一样）
    db.prepare('DELETE FROM theme_cluster_members').run();
    db.prepare('DELETE FROM theme_clusters').run();
    expect(readSnapshot(db)).toEqual([]);

    recluster(store, NOW + 2 * DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS);
    const second = readSnapshot(db);

    expect(second).toEqual(first);
  });

  it('★ 软删记忆**不是**簇成员；它与活跃记忆之间的边**不计入**连通性', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertMemory(db, 'm-dead', { deleted: true });
    seedFillers(db, 7);
    seedEdge(db, 'm-1', 'm-2', 0.5);
    // ⚠️ 这条边的一端被软删 ⇒ **不计入簇**
    seedEdge(db, 'm-dead', 'm-2', 0.9);

    recluster(store, NOW);

    const snapshot = readSnapshot(db);
    expect(snapshot).toHaveLength(1);
    // ★ 软删记忆**不在**任何簇里
    expect(snapshot[0]?.memberIds).toEqual(['m-1', 'm-2']);
    expect(snapshot.flatMap((cluster) => cluster.memberIds)).not.toContain('m-dead');
  });

  it('★ `size` 口径 = **当前活跃成员数**（快照里就是活跃成员）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertMemory(db, 'm-3');
    seedFillers(db, 7);
    seedEdge(db, 'm-1', 'm-2', 0.5);
    seedEdge(db, 'm-2', 'm-3', 0.5);

    recluster(store, NOW);
    const size = (
      db.prepare('SELECT member_count FROM theme_clusters').get() as { member_count: number }
    ).member_count;
    expect(size).toBe(3);

    // ⚠️ **软删一条** ⇒ 重算后该簇的活跃成员数变成 2（快照是整表替换 ⇒ 不会残留旧的 3）
    db.prepare("UPDATE memories SET deleted = 1, deleted_at = 1 WHERE id = 'm-3'").run();
    recluster(store, NOW + 2 * DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS);
    const after = (
      db.prepare('SELECT member_count FROM theme_clusters').get() as { member_count: number }
    ).member_count;
    expect(after).toBe(2);
  });

  it('★ 事件：type=sweep、action=recluster，`memory_id` 为 null，payload 只有两个字段', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    seedFillers(db, 7);
    seedEdge(db, 'm-1', 'm-2', 0.5);

    const result = recluster(store, NOW);

    const events = readEvents(db, 'sweep');
    expect(events).toHaveLength(1);
    expect(events[0]?.memory_id).toBeNull();
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.action).toBe('recluster');
    expect(payload.clusterCount).toBe(result.clusterCount);
    expect(payload.largestClusterRatio).toBeCloseTo(result.largestClusterRatio, 12);
    // ⚠️ **字段集只有这两个**（§8.4 硬规则 4）：填 0 就是在伪造「本次没发生的事实」
    expect(Object.keys(payload).sort()).toEqual(['action', 'clusterCount', 'largestClusterRatio']);
  });

  it('★ 整表替换在**同一事务内**：发布中途抛错 ⇒ **旧快照完好**（不是半张表）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    seedEdge(db, 'm-1', 'm-2', 0.5);

    recluster(store, NOW);
    const before = readSnapshot(db);
    const beforeMeta = readMeta(db);

    // ⚠️ **在发布中途制造失败**：触发器在插入簇时 ABORT ⇒ 事务必须整体回滚
    db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON theme_clusters
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );

    expect(() => recluster(store, NOW + 2 * DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS)).toThrow();

    // ★ **旧快照完好**（不是半张表）
    expect(readSnapshot(db)).toEqual(before);
    expect(readMeta(db)).toEqual(beforeMeta);

    db.exec('DROP TRIGGER boom');
  });

  it('★ 跳过语义：连续两次调用 ⇒ 第二次 computed=false、skipped=too_soon、clusterCount 相同', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    seedEdge(db, 'm-1', 'm-2', 0.5);

    const first = recluster(store, NOW);
    const second = recluster(store, NOW + 1000);

    expect(first.computed).toBe(true);
    expect(first.skipped).toBe(null);

    expect(second.computed).toBe(false);
    expect(second.skipped).toBe('too_soon');
    // ★ **跳过时 clusterCount 与真算出来「长得一样」** ⇒ 宿主必须看 computed / skipped
    expect(second.clusterCount).toBe(first.clusterCount);
    expect(second.largestClusterRatio).toBeCloseTo(first.largestClusterRatio, 12);

    // ⚠️ **跳过时不得写事件**（本次什么都没发生）
    expect(readEvents(db, 'sweep')).toHaveLength(1);
  });

  it('★ 超过间隔 ⇒ 又能重算（版本号递增）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    seedEdge(db, 'm-1', 'm-2', 0.5);

    recluster(store, NOW);
    const later = recluster(store, NOW + DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS + 1);

    expect(later.computed).toBe(true);
    expect(readMeta(db)?.version).toBe(2);
  });

  it('★ 兜底切分：原始分量占比 > MAX_CLUSTER_SHARE ⇒ 切分；且**第二次重算仍触发**（幂等 ⇒ 同样的块）', () => {
    const { db, store } = createTestStore();
    for (let index = 0; index <= 6; index += 1) {
      insertMemory(db, `m-${index}`);
    }
    // ⚠️ **撑大分母到 10** ⇒ 原始分量占比 = 7/10 = 0.7（而不是 7/7 = 1.0）
    seedFillers(db, 3);
    for (let index = 1; index <= 6; index += 1) {
      seedEdge(db, 'm-0', `m-${index}`, 0.5);
    }

    const first = recluster(store, NOW);
    expect(first.computed).toBe(true);
    // ★ 7/10 = 0.7 > 0.5 ⇒ 触发切分；目标上限 = 2 ⇒ k = 4
    const firstSnapshot = readSnapshot(db);
    expect(firstSnapshot).toHaveLength(4);

    // ★ **切前**的原始占比落在单行表里，**切后**的最大块占比是返回值 ⇒ 两个口径不同值
    expect(readMeta(db)?.max_raw_ratio).toBeCloseTo(0.7, 12);
    expect(first.largestClusterRatio).toBeCloseTo(0.2, 12);
    expect(readMeta(db)?.max_raw_ratio).not.toBeCloseTo(first.largestClusterRatio, 6);

    // ★ **第二次重算仍触发切分**（读的是**切前**的原始占比，不是切后的）⇒ 同样的块
    const second = recluster(store, NOW + 2 * DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS);
    expect(second.computed).toBe(true);
    expect(readSnapshot(db)).toEqual(firstSnapshot);
    expect(readMeta(db)?.max_raw_ratio).toBeCloseTo(0.7, 12);
  });

  it('★ 切分后新簇的 id **沿用原簇 id 的一半 + 新后缀**（不与原 id 相同 ⇒ 不复用）', () => {
    const { db, store } = createTestStore();
    for (let index = 0; index <= 6; index += 1) {
      insertMemory(db, `m-${index}`);
    }
    for (let index = 1; index <= 6; index += 1) {
      seedEdge(db, 'm-0', `m-${index}`, 0.5);
    }

    recluster(store, NOW);
    const snapshot = readSnapshot(db);

    expect(snapshot).toHaveLength(4);
    // ★ 四块的 id **共享同一个前缀**（同源）且**互不相同**
    const prefixes = snapshot.map((cluster) =>
      cluster.clusterId.slice(0, cluster.clusterId.lastIndexOf('.')),
    );
    expect(new Set(prefixes).size).toBe(1);
    expect(new Set(snapshot.map((cluster) => cluster.clusterId)).size).toBe(4);
    // ★ 派生 id 带后缀 `.1` … `.4`
    expect(snapshot.map((cluster) => cluster.clusterId.split('.').pop()).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('★ 衰减到门槛下的边**不计入簇**（簇随共激活衰减而变化）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertMemory(db, 'm-3');
    seedFillers(db, 7);
    seedEdge(db, 'm-1', 'm-2', 0.5, NOW);
    // ⚠️ 这条边很久没共现 ⇒ 衰减到门槛以下 ⇒ 不构成连通
    seedEdge(db, 'm-2', 'm-3', 0.5, NOW - 100 * MS_PER_DAY);

    recluster(store, NOW);

    const snapshot = readSnapshot(db);
    // ★ m-3 的那条边衰减到门槛下 ⇒ 它**没有任何有效边** ⇒ 它是**孤岛** ⇒ **不进任何簇**
    //   （§4.12.5：「从未被 touch 过的记忆没有任何共激活边，是孤岛」⇒ 孤岛**不属于**任何簇）
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.memberIds).toEqual(['m-1', 'm-2']);
    expect(snapshot.flatMap((cluster) => cluster.memberIds)).not.toContain('m-3');
  });

  it('★ 没有任何共激活边的记忆是**孤岛**（不进任何簇）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertMemory(db, 'm-lonely');

    const result = recluster(store, NOW);

    expect(result.clusterCount).toBe(0);
    expect(readSnapshot(db)).toEqual([]);
  });
});
