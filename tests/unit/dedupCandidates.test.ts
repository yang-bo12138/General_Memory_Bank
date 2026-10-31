/**
 * 写入路径的**去重候选收窄**（§4.9 步骤 3a2）—— DEVELOPMENT-PLAN.md **P2-T07** 的硬断言。
 *
 * ★ 本文件的断言纪律（沿用阶段 0~2 的口径）：
 *   · **硬断言逐条对应计划稿**，每条都能被变异打红；
 *   · **参考实现自己手写**（flat 侧的候选全集自己查，不抄生产代码的 SQL）；
 *   · **夹具用的是 §3 的权威 DDL**（真库 ⇒ 外键 / 唯一索引这些约束验得了）。
 *
 * ⚠️ **本测试文件是 `vector_cell_members` 的「第二写点」**（测试夹具要手工造数据）：
 *   它在 `tests/` 下，**不在 `src/` 下** ⇒ 不违反 §9.3.0 的「唯一写入点」
 *   （那条铁律的管辖范围是生产代码；静态扫描断言只扫 `src/**`）。
 *   ⇒ 凡是能靠 `assignBucket` 造出来的数据，本文件都**不**手工 INSERT。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { EVENT_PAYLOAD_VARIANTS } from '../../src/core/events.types.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import {
  type DedupCandidateContext,
  collectDedupCandidates,
  collectVectorCandidates,
} from '../../src/store/dedupCandidates.js';
import { EventWriter } from '../../src/store/events.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { type WriteStore, write } from '../../src/store/write.js';
import { MemoryLogger } from '../../src/util/log.js';
import { type BucketAssignContext, assignBucket } from '../../src/vector/bucketAssign.js';
import { CentroidCache, type IvfCentroidModel } from '../../src/vector/centroids.js';
import {
  buildBucketCandidateSql,
  routeFineBuckets,
  scanBucketCandidates,
  trainCentroids,
} from '../../src/vector/ivf.js';
import { readEvents } from '../fixtures/graph-store.js';
import { createTestDb, insertMemory, pseudoUnitVector } from '../fixtures/vector.js';

/** 一个固定的时间基准（毫秒）。 */
const T0 = 1_700_000_000_000;

/** 训练与运行期（归桶）共用的探针数（§4.15.3：训练期与运行期必须一致）。 */
const NPROBE = 2;

/**
 * 夹具的默认条数（**大夹具**用）。
 *
 * ⚠️ **必须 > 2000**：只有当「全表扫的条数」比 2000 大时，
 *   「候选 ≤ 2000」这条断言**才对「改回全表扫」这个变异有牙**。
 */
const BIG_COUNT = 2500;

/** §4.9 步骤 3a2 的候选池上限（`ROUTER_NPROBE_WRITE_FINE` × 每桶约 100 条 = 2000）。 */
const CANDIDATE_POOL_LIMIT = 2000;

/** §4.9 步骤 3c 的 merge 事件字段集（权威出处：`src/core/events.types.ts`）。 */
const MERGE_3C_KEYS: readonly string[] = EVENT_PAYLOAD_VARIANTS.merge?.merge_3c ?? [];

/** 夹具。 */
interface Fixture {
  db: Database.Database;
  params: Params;
  buckets: BucketAssignContext;
  store: WriteStore;
  model: IvfCentroidModel;
  /** 种子记忆的 id（顺序即向量顺序）。 */
  ids: string[];
  /** 种子记忆的向量（顺序即 id 顺序）。 */
  vectors: Float32Array[];
  /** 候选收集的上下文。 */
  context: DedupCandidateContext;
}

/** 造一个写入上下文（库句柄 + 参数 + 事件写入器 + 日志器 + 桶归属上下文）。 */
function createWriteStore(
  db: Database.Database,
  params: Params,
  buckets: BucketAssignContext,
): WriteStore {
  const logger = new MemoryLogger();
  const events = new EventWriter(db, { readonly: false, logger, now: () => 0 });
  return { db, params, events, logger, buckets };
}

/**
 * 造一个「已训练 + 种子已入桶」的夹具。
 *
 * ⚠️ **种子必须走 `assignBucket` 入桶**（不手工 INSERT 桶表）：
 *   §9.3.0 的「唯一写入点」在 `src/` 里是铁律 ⇒ 测试里的「第二写点」也该走同一套机制
 *   ⇒ 否则测试验的是一个**与生产不同的**桶侧形状。
 */
function createFixture(options: {
  count: number;
  coarseCenters: number;
  fineCenters: number;
  /** 种子的 `last_access`（毫秒；不给 = `T0`）。 */
  lastAccess?: number;
  /** 种子的正文（不给 = `内容 ${id}`）。 */
  contentOf?: (id: string) => string;
}): Fixture {
  const db = createTestDb();
  const params = DEFAULT_PARAMS;
  const vectors: Float32Array[] = [];
  for (let index = 0; index < options.count; index += 1) {
    vectors.push(pseudoUnitVector(index + 1));
  }

  const ids: string[] = [];
  vectors.forEach((vector, index) => {
    const id = `m-${String(index).padStart(4, '0')}`;
    ids.push(id);
    insertMemory(db, id, vector, { lastAccess: options.lastAccess ?? T0 });
    // ⚠️ **正文要各不相同**：文本路是 bigram 检索 ⇒ 正文全同会让它变成「万能候选」。
    if (options.contentOf !== undefined) {
      db.prepare('UPDATE memories SET content = ?, content_tokens = ? WHERE id = ?').run(
        options.contentOf(id),
        options.contentOf(id),
        id,
      );
    }
  });

  const result = trainCentroids(db, {
    coarseCenters: options.coarseCenters,
    fineCenters: options.fineCenters,
    maxIterations: 5,
    nprobeCoarse: NPROBE,
    now: T0,
  });

  const cache = new CentroidCache(db);
  const buckets: BucketAssignContext = {
    db,
    centroids: () => cache.model(),
    nprobeCoarse: NPROBE,
  };

  // ⚠️ **种子入桶走 `assignBucket`（唯一写入点）** ⇒ 必须在事务内（它自己不开事务）。
  runWriteTransaction(db, () => {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const vector = vectors[index];
      if (id === undefined || vector === undefined) {
        throw new Error('夹具越界');
      }
      assignBucket(buckets, id, vector);
    }
  });

  const store = createWriteStore(db, params, buckets);
  const context: DedupCandidateContext = { db, params, buckets };
  return { db, params, buckets, store, model: result.model, ids, vectors, context };
}

/** 库里「有向量且未删」的记忆条数（= flat 后端的候选全集条数）。 */
function countFlatCandidates(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL')
    .get() as { n: number };
  return row.n;
}

/** flat 后端的候选**全集**（id 集合）—— C29 的**分母**。 */
function flatCandidateIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare('SELECT id FROM memories WHERE deleted = 0 AND embedding IS NOT NULL')
    .all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** 库里最大的桶成员数。 */
function maxBucketSize(db: Database.Database): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(c), 0) AS m FROM (SELECT COUNT(*) AS c FROM vector_cell_members GROUP BY fine_id)',
    )
    .get() as { m: number };
  return row.m;
}

/** 给一个向量加一点扰动（制造「近重复但不是同一向量」）。 */
function perturb(vector: Float32Array, epsilon: number): Float32Array {
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    out[index] = value + epsilon * ((index % 3) - 1);
  }
  let norm = 0;
  for (let index = 0; index < out.length; index += 1) {
    const value = out[index] ?? 0;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (out[index] ?? 0) / norm;
  }
  return out;
}

// ─────────────────────────── 大夹具（只建一次） ───────────────────────────

/** 大夹具（2500 条）—— 建一次、全文件复用（建它要几秒）。 */
let bigFixture: Fixture | undefined;

/** 取大夹具（懒建 + 记忆化）。 */
function getBigFixture(): Fixture {
  if (bigFixture === undefined) {
    bigFixture = createFixture({
      count: BIG_COUNT,
      coarseCenters: 8,
      fineCenters: 120,
    });
  }
  return bigFixture;
}

// ─────────────────────────── 硬断言 ───────────────────────────

describe('P2-T07 · 写入路径的去重候选收窄（§4.9 步骤 3a2）', () => {
  describe('硬断言：候选扫描量 ≤ 2000，且不做全表扫', () => {
    it('★ 写入路径的向量候选扫描量 ≤ 2000（顶格 = 探针数 × 每桶成员数）', () => {
      const fixture = getBigFixture();
      const query = pseudoUnitVector(999_999);

      const result = collectDedupCandidates(fixture.context, {
        content: '甲乙丙丁戊己庚辛',
        vector: query,
      });

      // 性质：**扫描量 ≤ 2000**
      expect(result.vectorScanned).toBeLessThanOrEqual(CANDIDATE_POOL_LIMIT);
      // 性质：**扫描量 ≥ 1**（不是「什么都没扫到」的真空通过）
      expect(result.vectorScanned).toBeGreaterThan(0);
    });

    it('★ 扫描量 **远小于**全库条数 ⇒ 不是全表扫（变异「改回全表扫」⇒ 本条会红）', () => {
      const fixture = getBigFixture();
      const query = pseudoUnitVector(999_999);
      const total = countFlatCandidates(fixture.db);

      // 性质：全库条数 > 2000（否则「≤ 2000」这条断言对全表扫没有牙）
      expect(total).toBeGreaterThan(CANDIDATE_POOL_LIMIT);

      const result = collectDedupCandidates(fixture.context, {
        content: '甲乙丙丁戊己庚辛',
        vector: query,
      });

      // 性质：扫描量 **小于**全库条数（收窄真的发生了）
      expect(result.vectorScanned).toBeLessThan(total);
    });

    it('★ 扫描量 ≤ 探针数 × **最大桶成员数**（结构上界：只扫命中桶）', () => {
      const fixture = getBigFixture();
      const query = pseudoUnitVector(999_999);

      const result = collectDedupCandidates(fixture.context, {
        content: '甲乙丙丁戊己庚辛',
        vector: query,
      });

      const upperBound = DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE * maxBucketSize(fixture.db);
      expect(result.vectorScanned).toBeLessThanOrEqual(upperBound);
      // 性质：命中桶数不超过细层探针数
      expect(result.vectorFineIds.length).toBeLessThanOrEqual(
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE,
      );
    });

    it('★ 命中桶数 = 细层探针数（用**写入专用**探针数，不是召回那套）', () => {
      const fixture = getBigFixture();
      const query = pseudoUnitVector(999_999);

      const fineIds = routeFineBuckets(
        fixture.model,
        query,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE,
      );

      // 性质：命中的是 `ROUTER_NPROBE_WRITE_FINE`（20）个细桶，**不是**召回的 50
      expect(fineIds).toHaveLength(DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE);
      // 性质：命中桶**互不相同**（同一个桶不会被探两次）
      expect(new Set(fineIds).size).toBe(fineIds.length);
    });
  });

  describe('硬断言：EXPLAIN QUERY PLAN（不做全表扫的可观测证据）', () => {
    it('★ 候选 SQL 的执行计划里**没有 SCAN**（两个表都是索引查找）', () => {
      const fixture = getBigFixture();
      const query = pseudoUnitVector(999_999);
      const fineIds = routeFineBuckets(
        fixture.model,
        query,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE,
      );

      // ⚠️ **用生产代码真正执行的那条 SQL**（`buildBucketCandidateSql()` 的产物）
      //   ⇒ 断言的不是测试自己抄的一份。
      const sql = buildBucketCandidateSql(fineIds);
      const plan = db_plan(fixture.db, sql, fineIds);

      // 性质：计划非空
      expect(plan.length).toBeGreaterThan(0);
      // 性质：**没有任何一条是全表扫**
      for (const detail of plan) {
        expect(detail.startsWith('SCAN')).toBe(false);
      }
      // 性质：桶侧走 `fine_id` 索引（`SEARCH vcm ...`）
      expect(plan.some((detail) => detail.startsWith('SEARCH vcm'))).toBe(true);
      // 性质：记忆侧走 `id` 索引（`SEARCH m ...`）
      expect(plan.some((detail) => detail.startsWith('SEARCH m'))).toBe(true);
    });

    it('★ 负控：全表扫那条 SQL 的计划里**有 SCAN** ⇒ 上一条断言分得清两者', () => {
      const fixture = getBigFixture();

      // ⚠️ **这就是 v1.0 的写法**（`WHERE deleted = 0 AND embedding IS NOT NULL`，无 LIMIT）
      //   ⇒ 它的计划里有 SCAN ⇒ 上一条断言若恒绿，说明它根本没在比对计划。
      const fullScanSql =
        'SELECT m.id, m.embedding FROM memories m WHERE m.deleted = 0 AND m.embedding IS NOT NULL';
      const plan = db_plan(fixture.db, fullScanSql, []);

      expect(plan.some((detail) => detail.startsWith('SCAN'))).toBe(true);
    });
  });

  describe('硬断言：不加时间窗（半年前的近重复仍进候选）', () => {
    it('★ 一条**半年前**访问过的近重复**仍然进候选**（没有 @coarseCutoff）', () => {
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
        // ⚠️ **半年前**：任何「最近 N 天」的时间窗都会把它挡掉
        //   ⇒ 这条断言对「加一个 @coarseCutoff」的变异有牙。
        lastAccess: T0 - 180 * MS_PER_DAY,
      });
      const old = fixture.vectors[0];
      const query = perturb(old ?? pseudoUnitVector(1), 0.01);

      const result = collectDedupCandidates(fixture.context, {
        content: '庚辛壬癸子丑寅卯',
        vector: query,
      });

      const candidateIds = result.candidates.map((candidate) => candidate.id);
      // 性质：**那条老记忆在候选里**
      expect(candidateIds).toContain(fixture.ids[0]);
      // 性质：它确实是很久没被访问过的
      const row = fixture.db
        .prepare('SELECT last_access FROM memories WHERE id = ?')
        .get(fixture.ids[0] ?? '') as { last_access: number };
      expect(T0 - row.last_access).toBeGreaterThanOrEqual(180 * MS_PER_DAY);
    });

    it('★ 一条**半年前**写入的近重复**仍然会被合并**（注入时钟 ⇒ 没有 @coarseCutoff）', () => {
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
      });
      const oldVector = pseudoUnitVector(555_555);

      // ── 半年前写入的那一条（`now` 是**注入时钟**）──
      const first = write(fixture.store, {
        content: '甲乙丙丁戊己庚辛',
        embedding: Array.from(oldVector),
        now: T0 - 180 * MS_PER_DAY,
      });
      expect(first.merged).toBe(false);

      // 性质：那条老记忆**确实是半年前**写的、且**半年前**才被访问过
      //   ⚠️ **必须在合并之前取**（合并会把 `last_access` 推到本次的 `now`）。
      const before = fixture.db
        .prepare('SELECT created_at, last_access FROM memories WHERE id = ?')
        .get(first.id) as { created_at: number; last_access: number };
      expect(T0 - before.created_at).toBeGreaterThanOrEqual(180 * MS_PER_DAY);
      expect(T0 - before.last_access).toBeGreaterThanOrEqual(180 * MS_PER_DAY);

      // ── 现在写入的**同义改写**（两条正文没有任何共享 bigram ⇒ 文本路找不到）──
      const second = write(fixture.store, {
        content: '壬癸子丑寅卯辰巳',
        embedding: Array.from(perturb(oldVector, 0.01)),
        now: T0,
      });

      // 性质：**合并了**（⇒ 半年前那条**没有被时间窗挡掉**）
      //   ⚠️ 这条断言对「加一个 @coarseCutoff 时间窗（30 天）」的变异有牙：
      //   一旦加了窗口，这条（`last_access` 在半年前）就进不了候选 ⇒ 不会合并。
      expect(second.merged).toBe(true);
      expect(second.id).toBe(first.id);

      // 性质：合并**没有**把它「变年轻」（`created_at` 仍是半年前）
      const after = fixture.db
        .prepare('SELECT created_at FROM memories WHERE id = ?')
        .get(first.id) as { created_at: number };
      expect(T0 - after.created_at).toBeGreaterThanOrEqual(180 * MS_PER_DAY);
    });

    it('★ 候选 SQL 里**不含**任何时间窗条件（静态断言：没有 last_access 过滤）', () => {
      const fixture = getBigFixture();
      const query = pseudoUnitVector(999_999);
      const fineIds = routeFineBuckets(
        fixture.model,
        query,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE,
      );
      const sql = buildBucketCandidateSql(fineIds);

      // 性质：**没有** `last_access` 的比较（`>=` / `<=` / `BETWEEN` 一律不许出现）
      expect(sql).not.toMatch(/last_access\s*(>=|<=|>|<|BETWEEN)/i);
      // 性质：候选宇宙只有两条过滤：`deleted = 0` 与 `embedding IS NOT NULL`
      expect(sql).toContain('m.deleted = 0');
      expect(sql).toContain('m.embedding IS NOT NULL');
    });
  });

  describe('硬断言：与实时层同一合并路径（§4.9 步骤 3c）', () => {
    it('★ 向量路命中 ⇒ 走步骤 3c ⇒ 记 `merge` 事件（payload 键集 = 3c 字段集）', () => {
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
        contentOf: (id) => `种子正文 ${id}`,
      });
      // ⚠️ **这个向量刻意不在种子集里** ⇒ 第一条写入**不会**与任何种子合并
      //   （否则验的就不是「向量路发现同义改写」，而是「文本路也能发现的那条」）。
      const oldVector = pseudoUnitVector(555_555);
      const newVector = perturb(oldVector, 0.01);

      // ⚠️ **两条正文没有任何共享 bigram** ⇒ 文本路**一条都找不到**
      //   （「她不吃猫粮」vs「她对猫粮过敏」的形状 ⇒ §4.9 步骤 3a2 的原文）
      const first = write(fixture.store, {
        content: '甲乙丙丁戊己庚辛',
        embedding: Array.from(oldVector),
        now: T0,
      });
      expect(first.merged).toBe(false);

      const second = write(fixture.store, {
        content: '壬癸子丑寅卯辰巳',
        embedding: Array.from(newVector),
        now: T0,
      });

      // 性质：**合并了**（只有向量路能发现它）
      expect(second.merged).toBe(true);
      expect(second.exact).toBe(false);
      expect(second.id).toBe(first.id);

      // 性质：记的是 `merge` 事件（**不是** `write`）
      const mergeEvents = readEvents(fixture.db, 'merge');
      expect(mergeEvents).toHaveLength(1);
      const payload = mergeEvents[0]?.payload ?? {};
      // 性质：**payload 键集 = §4.9 步骤 3c 的字段集**
      expect(Object.keys(payload).sort()).toEqual([...MERGE_3C_KEYS].sort());
      // 性质：正文被新文本**无条件采纳**（ADR-9）
      expect(payload.contentText).toBe('壬癸子丑寅卯辰巳');
      expect(payload.targetId).toBe(first.id);
    });

    it('★ 文本路命中与向量路命中的 `merge` 事件**payload 键集完全一致**', () => {
      // ── 文本路 ──
      const textFixture = createFixture({
        count: 20,
        coarseCenters: 2,
        fineCenters: 4,
        contentOf: (id) => `文本种子 ${id}`,
      });
      write(textFixture.store, {
        content: '我爱北京天安门',
        entities: ['张三', '李四'],
        now: T0,
      });
      const textSecond = write(textFixture.store, {
        content: '我爱北京上海故宫',
        entities: ['张三', '李四'],
        now: T0 + MS_PER_DAY,
      });
      expect(textSecond.merged).toBe(true);

      // ── 向量路 ──
      const vectorFixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
        contentOf: (id) => `向量种子 ${id}`,
      });
      const oldVector = pseudoUnitVector(555_555);
      write(vectorFixture.store, {
        content: '甲乙丙丁戊己庚辛',
        embedding: Array.from(oldVector),
        now: T0,
      });
      const vectorSecond = write(vectorFixture.store, {
        content: '壬癸子丑寅卯辰巳',
        embedding: Array.from(perturb(oldVector, 0.01)),
        now: T0,
      });
      expect(vectorSecond.merged).toBe(true);

      const textKeys = Object.keys(readEvents(textFixture.db, 'merge')[0]?.payload ?? {}).sort();
      const vectorKeys = Object.keys(
        readEvents(vectorFixture.db, 'merge')[0]?.payload ?? {},
      ).sort();

      // 性质：**两条路的 payload 键集逐字一致**
      expect(vectorKeys).toEqual(textKeys);
      // 性质：且**就是** §4.9 步骤 3c 的字段集（不是某个子集）
      expect(vectorKeys).toEqual([...MERGE_3C_KEYS].sort());
    });
  });

  describe('硬断言：C29 的分母纪律（分桶 ⊆ flat）', () => {
    it('★ 分桶候选 ⊆ **flat 的候选全集**（分母是全集，**不是** flat 的 top-N）', () => {
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
      });
      const query = pseudoUnitVector(999_999);

      const scan = scanBucketCandidates(
        fixture.db,
        fixture.model,
        query,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE,
      );
      const bucketIds = new Set(scan.rows.map((row) => row.id));
      const flatIds = flatCandidateIds(fixture.db);

      // 性质：分桶候选**非空**（不是真空通过）
      expect(bucketIds.size).toBeGreaterThan(0);
      // 性质：**每一个**分桶候选都在 flat 的候选全集里
      for (const id of bucketIds) {
        expect(flatIds.has(id)).toBe(true);
      }
    });

    it('★ 负控：把分母换成「flat 的 top-N」⇒ 子集关系**不成立**（⇒ C29 的纪律有牙）', () => {
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
      });
      const query = pseudoUnitVector(999_999);

      const scan = scanBucketCandidates(
        fixture.db,
        fixture.model,
        query,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE,
      );
      const bucketIds = new Set(scan.rows.map((row) => row.id));

      // ⚠️ **flat 的 top-N**（按余弦取前 `VECTOR_TOPK` 条）——**错误的分母**
      const flatRows = fixture.db
        .prepare('SELECT id, embedding FROM memories WHERE deleted = 0 AND embedding IS NOT NULL')
        .all() as Array<{ id: string; embedding: Buffer }>;
      const scored = flatRows
        .map((row) => ({ id: row.id, cos: cosineWith(query, row.embedding) }))
        .sort((left, right) => right.cos - left.cos);
      const flatTopN = new Set(
        scored.slice(0, DEFAULT_PARAMS.VECTOR_TOPK).map((entry) => entry.id),
      );

      // 性质：**确实有分桶候选不在 flat 的 top-N 里**
      //   ⇒ 用 top-N 当分母时，「分桶 ⊆ flat」会**假失败**
      //   ⇒ ⇒ C29 的分母纪律（分母 = flat 的候选**全集**）不是空话。
      const outside = [...bucketIds].filter((id) => !flatTopN.has(id));
      expect(outside.length).toBeGreaterThan(0);
    });

    it('★ 说明：「取子集后再取 top-K」**不保序**（被移除的高分元素会让位）', () => {
      // ⚠️ **这条测的是「为什么分母不能用 top-N」**（QA 实测结论）：
      //   先按余弦取 top-K、再取子集 ⇒ 被移除的高分元素会让**后面**的元素挤进 top-K
      //   ⇒ 「分桶 ⊆ flat 的 top-N」这种断言会**假失败**。
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
      });
      const query = pseudoUnitVector(999_999);

      const scan = scanBucketCandidates(
        fixture.db,
        fixture.model,
        query,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_WRITE_FINE,
      );
      const bucketIds = new Set(scan.rows.map((row) => row.id));

      // 性质：分桶候选的条数 **> flat 的 top-N 条数**
      //   ⇒ 「分桶 ⊆ flat 的 top-N」在**这个夹具上**必然不成立
      //   ⇒ 用 top-N 当分母 ⇒ 必然假失败。
      expect(bucketIds.size).toBeGreaterThan(DEFAULT_PARAMS.VECTOR_TOPK);
    });
  });

  describe('退化：模型未训练 / 本次无向量', () => {
    it('★ 分桶尚未训练 ⇒ 向量路整体缺席（**不是**降级报错）', () => {
      const db = createTestDb();
      const params = DEFAULT_PARAMS;
      const buckets: BucketAssignContext = {
        db,
        centroids: () => ({ coarse: [], fine: [] }),
      };
      const store = createWriteStore(db, params, buckets);
      const context: DedupCandidateContext = { db, params, buckets };

      const result = collectDedupCandidates(context, {
        content: '甲乙丙丁戊己庚辛',
        vector: pseudoUnitVector(1),
      });

      // 性质：向量路**一条都没扫**（不是「扫了但没命中」）
      expect(result.vectorScanned).toBe(0);
      expect(result.vectorFineIds).toHaveLength(0);
      expect(result.candidates).toHaveLength(0);

      // 性质：**写入仍然成功**（不抛错、不报错）⇒ 退回纯文本路
      const written = write(store, {
        content: '甲乙丙丁戊己庚辛',
        embedding: Array.from(pseudoUnitVector(1)),
        now: T0,
      });
      expect(written.merged).toBe(false);
      expect(written.id).toBeTruthy();
    });

    it('★ 本次没有向量 ⇒ 向量路整条跳过（回到纯文本路，**不是**降级报错）', () => {
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
        contentOf: (id) => `种子正文 ${id}`,
      });

      const result = collectDedupCandidates(fixture.context, {
        content: '甲乙丙丁戊己庚辛',
        vector: null,
      });

      // 性质：向量路**完全没跑**
      expect(result.vectorScanned).toBe(0);
      expect(result.vectorFineIds).toHaveLength(0);

      // 性质：**文本路照常跑**（⇒ 「无向量」不是「没有候选」）
      const written = write(fixture.store, {
        content: '甲乙丙丁戊己庚辛',
        now: T0,
      });
      expect(written.merged).toBe(false);
      expect(written.id).toBeTruthy();
    });

    it('★ 负控：模型已训练 + 本次有向量 ⇒ 向量路**真的跑起来了**（上面两条不是真空）', () => {
      const fixture = createFixture({
        count: 40,
        coarseCenters: 2,
        fineCenters: 4,
      });
      const result = collectVectorCandidates(fixture.context, pseudoUnitVector(999_999));

      // 性质：扫描量 > 0（分桶训练了 ⇒ 向量路有东西可扫）
      expect(result.scanned).toBeGreaterThan(0);
      expect(result.fineIds.length).toBeGreaterThan(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 静态断言：写入路径的候选收集**不得**退化成全表扫
// ─────────────────────────────────────────────────────────────

describe('P2-T07 · 静态断言：候选收集不做全表扫', () => {
  /** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  /** 仓库的 `src/` 目录。 */
  const SRC_ROOT = resolve(HERE, '../../src');

  it('★ `dedupCandidates.ts` 里**没有**「全表扫」那条 SQL 的形状', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'dedupCandidates.ts'), 'utf8');

    // ⚠️ **只查代码、不查注释**（注释里会讨论「v1.0 的写法是全表扫」⇒ 会被误伤）
    const code = stripComments(source);

    // 性质：**没有**「直接从 memories 取全部有向量的行」那种 SQL
    expect(code).not.toMatch(
      /FROM\s+memories\s+m?\s*WHERE\s+m?\.?deleted\s*=\s*0\s+AND\s+m?\.?embedding\s+IS\s+NOT\s+NULL/i,
    );
    // 性质：**没有**「无 LIMIT 的 memories 全表扫」
    expect(code).not.toMatch(/SELECT[\s\S]{0,200}FROM\s+memories(?![\s\S]{0,400}JOIN\s+memories)/i);
  });

  it('★ 桶表名**不出现在**存储层（§4.6 步骤 2c：流水线不得直接引用分桶表名）', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'dedupCandidates.ts'), 'utf8');
    const code = stripComments(source);

    // 性质：存储层**不**出现桶表名（读与写都不出现）
    expect(code).not.toContain('vector_cell_members');
    expect(code).not.toContain('vector_fine_cells');
    expect(code).not.toContain('vector_coarse_cells');
  });
});

// ─────────────────────────── 小工具 ───────────────────────────

/** 跑一条 `EXPLAIN QUERY PLAN` 并取回每一条的 `detail`。 */
function db_plan(db: Database.Database, sql: string, params: readonly string[]): string[] {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail);
}

/** 余弦（测试侧自己手写一份 ⇒ 参考实现不抄生产代码）。 */
function cosineWith(query: Float32Array, blob: Buffer): number {
  const other = new Float32Array(blob.byteLength / 4);
  for (let index = 0; index < other.length; index += 1) {
    other[index] = blob.readFloatLE(index * 4);
  }
  let dot = 0;
  for (let index = 0; index < query.length; index += 1) {
    dot += (query[index] ?? 0) * (other[index] ?? 0);
  }
  return dot;
}

/** 把源码里的注释挖空（长度不变 ⇒ 下标仍对齐）。 */
function stripComments(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') {
        out[index] = ' ';
      }
    }
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    index += 1;
  }
  return out.join('');
}
