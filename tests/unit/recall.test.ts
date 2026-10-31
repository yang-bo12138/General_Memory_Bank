/**
 * P1-T08 · `recall` 流水线的端到端断言 —— DESIGN-v2.md §4.6（DEVELOPMENT-PLAN.md 1195~1211 行）。
 *
 * ★ 断言纪律：
 *   · **写性质，不写当次的形状/数字**：阈值一律引用 `params`（或由 `params` 推导）；
 *   · **关键断言配负控**：每条都写明「改坏成什么样 ⇒ 这条会红、为什么」；
 *   · **用真实 SQLite 库**（内存库）：FTS5 的 `bm25()`、触发器同步、外键级联都只有真库才验得了。
 *
 * ⚠️ **造数据直接写 SQL 插 `memories`**（FTS 索引由 `mem_ai` 触发器同步），
 *   **不依赖并行线的 `write.ts`**（本任务与它并发开发）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY, intensity } from '../../src/core/decay.js';
import {
  SCORE_WEIGHTS,
  SCORE_WEIGHT_SUM,
  clampCos,
  coarseGateWindow,
  fuseScore,
  normBm25Sigmoid,
  passesIntensityFilter,
} from '../../src/core/scoring.js';
import { tokenize } from '../../src/core/tokenize.js';
import { extractEntityNames, recall } from '../../src/store/recall.js';
import { countRows, createTestStore, readEvents } from '../fixtures/graph-store.js';

/** 固定的「现在」（epoch 毫秒）——**全部时间都从它推导**，不写真死的天数常量。 */
const NOW = 1_700_000_000_000;

/** 中位数（升序后取中间；偶数个取中间两个的平均）。 */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    throw new Error('medianOf 需要至少一个样本');
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1];
  if (lower === undefined) {
    throw new Error('medianOf 需要至少两个样本');
  }
  return (lower + upper) / 2;
}

/** 造一条记忆的入参。 */
interface SeedMemory {
  id: string;
  content: string;
  stability?: number;
  pinFactor?: number;
  lastAccess?: number;
  createdAt?: number;
  accessCount?: number;
  difficulty?: number;
  deleted?: boolean;
}

/**
 * 插一条记忆（`content_tokens` 由 `tokenize()` 算，**FTS 索引由触发器同步**）。
 *
 * ⚠️ **不走 `write.ts`**：那条路径由并行线开发中，且它会算初始稳定度 /
 *   写事件 ⇒ 会污染本文件要断言的「recall 不写库」这类性质。
 */
function seedMemory(db: Database.Database, seed: SeedMemory): void {
  const deleted = seed.deleted === true;
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                           stability, difficulty, pin_factor, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @stability, @difficulty, @pinFactor,
             @createdAt, @lastAccess, @accessCount, @deleted, @deletedAt)`,
  ).run({
    id: seed.id,
    content: seed.content,
    tokens: tokenize(seed.content),
    hash: `hash-${seed.id}`,
    stability: seed.stability ?? 10,
    difficulty: seed.difficulty ?? 0.5,
    pinFactor: seed.pinFactor ?? 1,
    createdAt: seed.createdAt ?? NOW,
    lastAccess: seed.lastAccess ?? NOW,
    accessCount: seed.accessCount ?? 0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? NOW : null,
  });
}

/** 建一个实体。 */
function seedEntity(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    'concept',
    NOW,
  );
}

/** 把记忆挂到实体上（`memory_entities`）。 */
function linkEntity(db: Database.Database, memoryId: string, entityId: string): void {
  db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
    memoryId,
    entityId,
  );
}

/** 读一条记忆的打分相关字段。 */
function readRow(
  db: Database.Database,
  id: string,
): {
  stability: number;
  pin_factor: number;
  last_access: number;
  created_at: number;
} {
  return db
    .prepare('SELECT stability, pin_factor, last_access, created_at FROM memories WHERE id = ?')
    .get(id) as {
    stability: number;
    pin_factor: number;
    last_access: number;
    created_at: number;
  };
}

/** 快照 `memories` 的全部「可被写路径改动」的列（用于断言「recall 不写 memories」）。 */
function snapshotMemories(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT id, content, content_tokens, stability, difficulty, pin_factor,
              created_at, last_access, access_count, deleted, deleted_at
         FROM memories ORDER BY id`,
    )
    .all();
}

/**
 * 截取源码里「从 `start` 标记到 `end` 标记」之间的片段（供源码级的负控用）。
 *
 * ⚠️ **为什么用「标记切片」而不是「正则匹配整段」**：正则一旦写得比实现还宽松，
 *   就会变成「恒真」的摆设守卫（看上去有守卫、实际什么都不挡）；
 *   而切片是**按实现的真实布局**取片段 ⇒ 实现改了布局，这条负控会**先红**（提示人同步）。
 *
 * @param source 源码全文
 * @param start 起始标记
 * @param end 结束标记
 * @returns 片段原文
 */
function sliceBlock(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error(`源码里找不到片段：${start} → ${end}`);
  }
  return source.slice(from, to);
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、融合打分的恒等式
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · recall 的融合打分恒等式（§4.6 步骤 3）', () => {
  /**
   * 一份「三路齐备」的小数据集：
   * · `m1` / `m2` / `m3` —— 文本路命中（内容里都含「张三」）；
   * · `m4` —— **只被图谱路召回**（内容与查询毫无词法重叠）。
   */
  function seedMixed(db: Database.Database): void {
    seedMemory(db, {
      id: 'm1',
      content: '张三住在北京',
      stability: 10,
      lastAccess: NOW,
      createdAt: NOW - 3 * MS_PER_DAY,
    });
    seedMemory(db, {
      id: 'm2',
      content: '张三喜欢猫',
      stability: 10,
      lastAccess: NOW - MS_PER_DAY,
      createdAt: NOW - 10 * MS_PER_DAY,
    });
    seedMemory(db, {
      id: 'm3',
      content: '张三在北京工作',
      stability: 10,
      lastAccess: NOW - 2 * MS_PER_DAY,
      createdAt: NOW - 20 * MS_PER_DAY,
    });
    seedEntity(db, 'e-li', '李四');
    seedMemory(db, { id: 'm4', content: '李四在杭州', stability: 10, lastAccess: NOW });
    linkEntity(db, 'm4', 'e-li');
  }

  it('★ 五项加权和 == Hit.score（误差 ≤ 1e-9）——§4.13.1 硬约束①的可测恒等式', () => {
    const { db, store, params } = createTestStore();
    seedMixed(db);

    const result = recall(store, {
      context: '张三住哪里',
      entityIds: ['e-li'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    // ⚠️ 负控：**改权重**（例如把 0.20 挪给 recency）⇒ 下面的期望值不再等于 score ⇒ 本条变红。
    // ⚠️ 负控：**按缺项重算分母** ⇒ 本阶段 `vectorSim` 恒缺项，重算后 score 会整体抬高 ⇒ 变红。
    expect(result.hits.length).toBe(4);

    const rawValues = result.hits
      .map((hit) => hit.breakdown?.rawBm25 ?? null)
      .filter((value): value is number => value !== null);
    expect(rawValues.length).toBe(3);
    const median = medianOf(rawValues);

    for (const hit of result.hits) {
      const breakdown = hit.breakdown;
      expect(breakdown).toBeDefined();
      if (breakdown === undefined) {
        continue;
      }
      const row = readRow(db, hit.id);

      const expectedIntensity = intensity(
        { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
        NOW,
      );
      const expectedNormBm25 =
        breakdown.rawBm25 === null ? 0 : 1 / (1 + Math.exp(0.2 * (breakdown.rawBm25 - median)));
      const expectedGraphProximity = hit.id === 'm4' ? 1 : 0;
      const expectedRecency = Math.min(
        1,
        Math.exp(-Math.max(0, NOW - row.created_at) / (params.RECENCY_DECAY_DAYS * MS_PER_DAY)),
      );

      const expected =
        0.3 * expectedIntensity +
        0.25 * 0 + // ⚠️ 本阶段向量路整路缺席 ⇒ vectorSim 恒为 0
        0.2 * expectedNormBm25 +
        0.15 * expectedGraphProximity +
        0.1 * expectedRecency;

      expect(Math.abs(hit.score - expected)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('★ 权重和恒为 1.0（参数表改动也不能破坏）', () => {
    // ⚠️ 负控：把 `SCORE_WEIGHTS` 的某一项改掉 ⇒ 这条立刻变红（它是**派生**出来的，不是写死的 1）。
    expect(SCORE_WEIGHT_SUM).toBeCloseTo(1, 12);
    const sum =
      SCORE_WEIGHTS.intensity +
      SCORE_WEIGHTS.vectorSim +
      SCORE_WEIGHTS.normBm25 +
      SCORE_WEIGHTS.graphProximity +
      SCORE_WEIGHTS.recency;
    expect(sum).toBeCloseTo(1, 12);
  });

  it('★ score 恒落在 [0, 1]（五项权重恒和为 1 ⇒ 分数不可能越界）', () => {
    const { db, store } = createTestStore();
    seedMixed(db);

    const result = recall(store, {
      context: '张三住哪里',
      entityIds: ['e-li'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    for (const hit of result.hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、准入闸门（归档层、粗筛窗口、遗忘曲线）
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · recall 的准入闸门（§4.6 步骤 2 的两条铁律）', () => {
  it('★ includeArchived=false ⇒ 结果中无 intensity ≤ ARCHIVE_LINE 的项；true ⇒ 可以有', () => {
    const { db, store, params } = createTestStore();
    // ⚠️ 这条记忆**稳得住**（τ = 10 天，10 天前访问 ⇒ intensity = e^-1 ≈ 0.368 > 归档线）
    //   ⇒ 它**过得了**闸门，两次召回都该出现 —— 这让「差别只来自 includeArchived」这件事可测。
    seedMemory(db, {
      id: 'm-live',
      content: '张三喜欢猫',
      stability: 10,
      lastAccess: NOW - 10 * MS_PER_DAY,
    });
    // ⚠️ 这条记忆**早已淡忘**（τ = 1 天，10 天前访问 ⇒ intensity = e^-10 ≈ 4.5e-5 ≤ 归档线）
    //   但它**仍在粗筛窗口内**（10 天 ≪ 539 天）⇒ 死在**精筛**而不是粗筛 ⇒ 精筛确实是活的。
    seedMemory(db, {
      id: 'm-faint',
      content: '张三喜欢猫',
      stability: 1,
      lastAccess: NOW - 10 * MS_PER_DAY,
    });
    // ⚠️ 这条在**粗筛窗口之外**（700 天 ≫ 539 天）⇒ 它能出现，
    //   **只可能**是因为 `includeArchived: true` 把粗筛窗口整体取消了。
    seedMemory(db, {
      id: 'm-deep-archived',
      content: '张三喜欢猫',
      stability: 1,
      lastAccess: NOW - 700 * MS_PER_DAY,
    });
    // ⚠️ 这条的 `intensity` **因下溢恰好等于 0.0**（τ = 0.001 天，200 天前访问
    //   ⇒ Δt/τ = 200000 ⇒ `exp(-200000) = 0`）。
    //   ⚠️ **IEEE754 的下溢边界在 ≈745 个时间常数**（`exp(-746)` 直接变 0.0），
    //   而 schema 对 `stability` 只有 `CHECK (stability > 0)` ⇒ **没有下界**
    //   ⇒ 小 `stability` 的记忆几十小时就能下溢到 0 ⇒ 归档层里**非常常见**。
    //   ⇒ 这条是 ADR-P1-T08-GAP 小口径③ 的**边界用例**：
    //     归档模式下它**必须出现**（「只过滤 deleted = 0」）；
    //     默认模式下它**必须不出现**（强度 0 ≤ 归档线）。
    seedMemory(db, {
      id: 'm-underflow',
      content: '张三喜欢猫',
      stability: 0.001,
      lastAccess: NOW - 200 * MS_PER_DAY,
    });

    const withoutArchived = recall(store, {
      context: '张三喜欢猫',
      topN: 8,
      explain: true,
      now: NOW,
    });
    expect(withoutArchived.hits.map((hit) => hit.id)).not.toContain('m-faint');
    expect(withoutArchived.hits.map((hit) => hit.id)).not.toContain('m-deep-archived');
    expect(withoutArchived.hits.map((hit) => hit.id)).toContain('m-live');
    // ⚠️ 负控：默认模式下强度下溢成 0 的那条**必须不出现**（它过不了精筛）。
    expect(withoutArchived.hits.map((hit) => hit.id)).not.toContain('m-underflow');

    // 性质：**默认路径**召回出来的每一条，其 intensity 都**严格大于**归档线。
    // ⚠️ 负控：把精筛的 `>` 写成 `>=` ⇒ 恰好落在归档线上的那条会混进来 ⇒ 这条变红。
    for (const hit of withoutArchived.hits) {
      const row = readRow(db, hit.id);
      const value = intensity(
        { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
        NOW,
      );
      expect(value).toBeGreaterThan(params.ARCHIVE_LINE);
    }

    const withArchived = recall(store, {
      context: '张三喜欢猫',
      topN: 8,
      explain: true,
      includeArchived: true,
      now: NOW,
    });
    // 性质：显式查询归档层 ⇒ 归档记忆**可以**出现。
    expect(withArchived.hits.map((hit) => hit.id)).toContain('m-faint');
    // ⚠️ 负控：`includeArchived: true` 时若**没有**取消粗筛窗口 ⇒
    //   `m-deep-archived`（在窗口之外）永远出不来 ⇒ 这条变红。
    expect(withArchived.hits.map((hit) => hit.id)).toContain('m-deep-archived');
    // ★ **归档模式的边界**：强度**恰好下溢成 0.0** 的那条**必须出现**
    //   （ADR-P1-T08-GAP 小口径③：归档模式**不做强度精筛**，只保留 `deleted = 0`）。
    // ⚠️ 负控：若仍用「阈值 = 0.0 + 严格大于」⇒ 它会被挡掉 ⇒ 这条变红。
    //   （而它**已经被 SQL 捞进来了** ⇒ 「显式查询归档层」名存实亡。）
    expect(withArchived.hits.map((hit) => hit.id)).toContain('m-underflow');

    // 性质：归档模式**不判强度** ⇒ 召回出来的每一条 intensity 都**≥ 0**
    //   （可能**恰好为 0** ⇒ 这正是上面那条；仍不是「什么都能回来」：
    //   `deleted = 1` 的依然进不来）。
    for (const hit of withArchived.hits) {
      const row = readRow(db, hit.id);
      const value = intensity(
        { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
        NOW,
      );
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('★ 早已淡忘的记忆（intensity 极低）过不了闸门 ⇒ **不得**因为词法命中就回来', () => {
    const { db, store, params } = createTestStore();
    seedMemory(db, {
      id: 'm-faint',
      content: '张三喜欢猫',
      stability: 1,
      lastAccess: NOW - 10 * MS_PER_DAY,
    });

    const result = recall(store, { context: '张三喜欢猫', topN: 8, explain: true, now: NOW });

    // ⚠️ **这条断言守的是铁律①**（闸门对所有路一视同仁）：
    //   一条 intensity ≈ 4.5e-5 的记忆若被放回 topN，
    //   等于**用词法精确废掉了遗忘曲线** ⇒ 违反「谁配被想起」的判据。
    expect(result.hits.map((hit) => hit.id)).not.toContain('m-faint');
    expect(result.hits.length).toBe(0);

    const row = readRow(db, 'm-faint');
    const value = intensity(
      { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
      NOW,
    );
    expect(value).toBeLessThanOrEqual(params.ARCHIVE_LINE);
  });

  it('★ 粗筛两档窗口：被 pin 的记忆窗口更宽（同样久远，pin 的活、没 pin 的不活）', () => {
    const { db, store, params } = createTestStore();
    const veryOld = NOW - 1500 * MS_PER_DAY;

    seedMemory(db, {
      id: 'm-pinned',
      content: '张三喜欢猫',
      stability: params.MAX_STABILITY,
      pinFactor: params.MAX_PIN_FACTOR,
      lastAccess: veryOld,
    });
    seedMemory(db, {
      id: 'm-plain',
      content: '张三喜欢猫',
      stability: params.MAX_STABILITY,
      pinFactor: 1,
      lastAccess: veryOld,
    });

    const result = recall(store, { context: '张三喜欢猫', topN: 8, explain: true, now: NOW });
    const ids = result.hits.map((hit) => hit.id);

    // ⚠️ 负控：把粗筛改成「一档窗口」⇒ 这条会红（`m-pinned` 被粗筛挡掉）。
    //   「一律豁免」的反事实**不在这里**：`m-plain` 的 τ 小（= `MAX_STABILITY`），
    //   它的强度在 1500 天前就已经低于归档线 ⇒ **它是被精筛挡掉的**，
    //   就算粗筛对它完全豁免，它也回不来 ⇒ 把「一律豁免」的负控挂在这里是**空判**。
    //   ⇒ 「一律豁免」的反事实由下面的 **NC3** 承担（那里造的行的 τ **超过**粗筛窗口的上界）。
    expect(ids).toContain('m-pinned');
    expect(ids).not.toContain('m-plain');

    // 性质：`m-pinned` 之所以活下来，是因为 **`pin_factor` 在 τ 的分母里**（拉长 τ）。
    const pinnedRow = readRow(db, 'm-pinned');
    const pinnedIntensity = intensity(
      {
        stability: pinnedRow.stability,
        pin_factor: pinnedRow.pin_factor,
        last_access: pinnedRow.last_access,
      },
      NOW,
    );
    expect(pinnedIntensity).toBeGreaterThan(params.ARCHIVE_LINE);
  });

  it('★ 软删的记忆永远不进候选（`deleted = 0` 是三路共用的闸门）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm-deleted', content: '张三喜欢猫', deleted: true });

    const result = recall(store, { context: '张三喜欢猫', topN: 8, explain: true, now: NOW });
    expect(result.hits.map((hit) => hit.id)).not.toContain('m-deleted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、`normBm25` 的三条规则
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · normBm25 的三条规则（§4.6 步骤 3）', () => {
  it('★ 分支① LIKE 单字兜底 ⇒ 全部 normBm25 = 1.0（且 rawBm25 = null）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm-cat', content: '张三喜欢猫' });
    seedMemory(db, { id: 'm-dog', content: '李四喜欢狗' });

    // ⚠️ 单个汉字 ⇒ `buildMatchQuery` 走 LIKE 兜底分支（`matchSql` 为 null）。
    const result = recall(store, { context: '猫', topN: 8, explain: true, now: NOW });

    expect(result.explain?.routes.text.ran).toBe(true);
    expect(result.hits.map((hit) => hit.id)).toEqual(['m-cat']);
    const hit = result.hits[0];
    expect(hit?.breakdown?.rawBm25).toBeNull();
    // ⚠️ 负控：把 LIKE 分支错写成「未走文本路 ⇒ 0.0」⇒ 这里会拿到 0 而不是 1.0。
    expect(hit?.breakdown?.textPart).toBeCloseTo(SCORE_WEIGHTS.normBm25 * 1.0, 12);
  });

  it('★ 分支② FTS 命中 ⇒ sigmoid 形状正确（中位数那条恰为 0.5，越相关越接近 1）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });
    seedMemory(db, { id: 'm2', content: '张三喜欢猫' });
    seedMemory(db, { id: 'm3', content: '张三在北京工作' });

    const result = recall(store, { context: '张三住哪里', topN: 8, explain: true, now: NOW });
    expect(result.hits.length).toBe(3);

    const raws = result.hits.map((hit) => hit.breakdown?.rawBm25 ?? null);
    expect(raws.every((value) => value !== null)).toBe(true);
    const median = medianOf(raws.filter((value): value is number => value !== null));

    // 性质：`sigmoid(0) = 0.5` ⇒ **恰好落在中位数上的那条**其 normBm25 必为 0.5。
    const medianHit = result.hits.find((hit) => {
      const raw = hit.breakdown?.rawBm25;
      return raw !== undefined && raw !== null && raw === median;
    });
    expect(medianHit).toBeDefined();
    expect(medianHit?.breakdown?.textPart).toBeCloseTo(SCORE_WEIGHTS.normBm25 * 0.5, 12);

    // 性质：越负（越相关）⇒ normBm25 越接近 1 ⇒ textPart 越大。
    const sorted = [...result.hits].sort(
      (left, right) => (left.breakdown?.rawBm25 ?? 0) - (right.breakdown?.rawBm25 ?? 0),
    );
    const mostRelevant = sorted[0];
    const leastRelevant = sorted[sorted.length - 1];
    expect(mostRelevant?.breakdown?.textPart).toBeGreaterThan(medianHit?.breakdown?.textPart ?? 0);
    expect(leastRelevant?.breakdown?.textPart).toBeLessThan(medianHit?.breakdown?.textPart ?? 1);
  });

  it('★ 分支③ 整批没走文本路 ⇒ 全部 normBm25 = 0.0', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-li', '李四');
    seedMemory(db, { id: 'm-li', content: '李四在杭州' });
    linkEntity(db, 'm-li', 'e-li');

    // ⚠️ 单个拉丁字母 ⇒ `buildMatchQuery` 返回两个 null ⇒ 文本路**整体不执行**。
    const result = recall(store, {
      context: 'a',
      entityIds: ['e-li'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    expect(result.explain?.routes.text.ran).toBe(false);
    expect(result.explain?.routes.text.candidates).toBe(0);
    expect(result.hits.length).toBe(1);
    const hit = result.hits[0];
    expect(hit?.fromText).toBe(false);
    expect(hit?.fromGraph).toBe(true);
    expect(hit?.breakdown?.rawBm25).toBeNull();
    // ⚠️ 负控：把「未走文本路」错判成「走了 LIKE 兜底」⇒ 这里会拿到 0.2 而不是 0。
    expect(hit?.breakdown?.textPart).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、候选去重 / 各路分数独立 / `graphProximity`
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · 候选去重与各路证据的独立性（§4.6 步骤 2.5 / 步骤 3）', () => {
  it('★ 非文本路命中的候选 rawBm25 = null，且**不参与中位数计算**（文本路全命中时 median 逐位不变）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });
    seedMemory(db, { id: 'm2', content: '张三喜欢猫' });
    seedMemory(db, { id: 'm3', content: '张三在北京工作' });
    seedEntity(db, 'e-li', '李四');
    seedMemory(db, { id: 'm4', content: '李四在杭州' });
    linkEntity(db, 'm4', 'e-li');

    // 第一次：带 `entityIds` ⇒ 图谱路会额外产出 `m4`（非文本路命中）。
    const withGraph = recall(store, {
      context: '张三住哪里',
      entityIds: ['e-li'],
      topN: 8,
      explain: true,
      now: NOW,
    });
    // 第二次：**不传** `entityIds` 也不传 `entityNames` ⇒ 图谱路为空（ADR-P1-T08-GAP 缺口①：
    //   库不抽取实体 ⇒ 调用方不点名就没有实体）⇒ 候选集只有三条文本命中。
    const withoutGraph = recall(store, {
      context: '张三住哪里',
      topN: 8,
      explain: true,
      now: NOW,
    });
    expect(withoutGraph.explain?.routes.graph.ran).toBe(false);

    const graphOnly = withGraph.hits.find((hit) => hit.id === 'm4');
    expect(graphOnly).toBeDefined();
    expect(graphOnly?.fromText).toBe(false);
    expect(graphOnly?.fromGraph).toBe(true);
    expect(graphOnly?.breakdown?.rawBm25).toBeNull();
    expect(graphOnly?.breakdown?.textPart).toBe(0);

    // ⚠️ **核心断言：median 逐位不变**。
    //   若实现把非文本路命中的候选（rawBm25 = null）以 0 或 -1 塞进中位数，
    //   中位数基准会被拉向 0 ⇒ 文本候选的 normBm25 全部抬高 ⇒ **两次调用的 textPart 不再相等**。
    const textIds = ['m1', 'm2', 'm3'];
    for (const id of textIds) {
      const left = withGraph.hits.find((hit) => hit.id === id);
      const right = withoutGraph.hits.find((hit) => hit.id === id);
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      expect(left?.breakdown?.textPart).toBe(right?.breakdown?.textPart);
      expect(left?.breakdown?.rawBm25).toBe(right?.breakdown?.rawBm25);
    }
  });

  it('★ 候选去重后同 id 只出现一次，但三个来源标记都保留', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-zhang', '张三');
    seedMemory(db, { id: 'm-both', content: '张三住在北京' });
    linkEntity(db, 'm-both', 'e-zhang');
    seedMemory(db, { id: 'm-text-only', content: '张三在北京工作' });

    const result = recall(store, {
      context: '张三住哪里',
      entityIds: ['e-zhang'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    const ids = result.hits.map((hit) => hit.id);
    // 性质：同一条记忆被多路命中**只占一个 topN 名额**（否则它会重复贡献给中位数样本）。
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'm-both')).toHaveLength(1);

    const both = result.hits.find((hit) => hit.id === 'm-both');
    expect(both?.fromText).toBe(true);
    expect(both?.fromGraph).toBe(true);
    // ⚠️ 本阶段向量路整路缺席 ⇒ `fromVector` 恒为 `false`（**不是**「进了向量路但没向量」）。
    expect(both?.fromVector).toBe(false);

    // 性质：文本路**不受路由/实体约束**（v2.0 不加 `AND m.id IN (@routedIds)`）：
    //   一条与上下文实体毫无关系的记忆，只要词法命中就该回来。
    const textOnly = result.hits.find((hit) => hit.id === 'm-text-only');
    expect(textOnly).toBeDefined();
    expect(textOnly?.fromText).toBe(true);
    expect(textOnly?.fromGraph).toBe(false);
  });

  it('★ graphProximity 对「只被文本路召回但实体确实相交」的候选 == 1.0', () => {
    const { db, store, params } = createTestStore();
    seedEntity(db, 'e-wang', '王五');

    // 目标：词法强命中、且**挂着上下文实体**，但因为 `last_access` 最旧而被图谱路的
    // `LIMIT 100` 挤出候选集 —— 这正是设计稿点名的那条场景。
    seedMemory(db, {
      id: 'm-target',
      content: '王五喜欢狗',
      stability: params.MAX_STABILITY,
      lastAccess: NOW - 300 * MS_PER_DAY,
      createdAt: NOW,
    });
    linkEntity(db, 'm-target', 'e-wang');

    // 100 个「挡道」的：同样挂在上下文实体上、但 `last_access` 更近 ⇒ 占满图谱路的前 100 名。
    for (let index = 0; index < 100; index += 1) {
      seedMemory(db, {
        id: `m-decoy-${index}`,
        content: `占位${index}`,
        stability: params.MAX_STABILITY,
        lastAccess: NOW - 200 * MS_PER_DAY,
        createdAt: NOW - 200 * MS_PER_DAY,
      });
      linkEntity(db, `m-decoy-${index}`, 'e-wang');
    }

    const result = recall(store, {
      context: '王五喜欢狗',
      // ⚠️ **实体名由调用方给**（ADR-P1-T08-GAP 缺口①：库不抽取）⇒ 图谱路与
      //   `graphProximity` 的「实体交集」才有判据（交集 = 调用方给的名字解析出的 id）。
      entityNames: ['王五'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    const target = result.hits.find((hit) => hit.id === 'm-target');
    expect(target).toBeDefined();
    // 性质：它**没有**进图谱路候选（图谱路的前 100 名被挡道者占满）。
    expect(target?.fromGraph).toBe(false);
    expect(target?.fromText).toBe(true);
    // ★ **可执行负控的前提**：直接查库证明「实体交集」**确实存在** ——
    //   没有这一步，「按交集判定」与「按来源判定」就**没有可区分的观测**
    //   （下面的断言也就成了恒真的摆设）。
    const links = db
      .prepare('SELECT entity_id FROM memory_entities WHERE memory_id = ?')
      .all('m-target') as Array<{ entity_id: string }>;
    expect(links.map((link) => link.entity_id)).toContain('e-wang');
    // ★ **核心断言**：按「实体交集」判定 ⇒ 它的 graphProximity 必须是 1.0。
    // ⚠️ 负控：若按「来自哪条路」判定 ⇒ 这里会得到 0 ⇒ 它的 graph 项被抹掉 ⇒ 变红。
    expect(target?.breakdown?.graphPart).toBeCloseTo(SCORE_WEIGHTS.graphProximity * 1.0, 12);
  });

  it('★ cos 钳制到 [0,1]；本阶段向量路缺席 ⇒ 每条命中的 cos 都是 null', () => {
    // 性质（钳制本身）：任何有限输入都被夹进 [0,1]。
    expect(clampCos(-0.5)).toBe(0);
    expect(clampCos(0.25)).toBeCloseTo(0.25, 12);
    expect(clampCos(1.5)).toBe(1);
    // ⚠️ 负控：去掉钳制 ⇒ `clampCos(1.5)` 会返回 1.5（越界）⇒ 这条变红。
    expect(clampCos(1.0000001)).toBe(1);

    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });

    const result = recall(store, { context: '张三住哪里', topN: 8, explain: true, now: NOW });
    for (const hit of result.hits) {
      // ⚠️ 「未走向量路 ⇒ cos 为 null」是**原始证据**的语义；
      //   缺项判定靠 `fromVector` + `routes.vector.ran`，**不能靠 cos**。
      expect(hit.breakdown?.cos).toBeNull();
      expect(hit.fromVector).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、步骤 1：实体抽取与别名消解（查询路径禁止写库）
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · 步骤 1 的实体名**归一**（库不抽取；ADR-P1-T08-GAP 缺口①）', () => {
  it('★ 调用方传 `entityNames` ⇒ 逐名归一进图谱路；别名也能解析', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-zhang', '张三');
    db.prepare('INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run(
      '老张',
      'e-zhang',
    );
    seedMemory(db, { id: 'm-zhang', content: '张三住在北京' });
    linkEntity(db, 'm-zhang', 'e-zhang');

    // 性质：**主名**归一 ⇒ 进图谱路。
    const byPrimary = recall(store, {
      context: '住在哪里',
      entityNames: ['张三'],
      topN: 8,
      explain: true,
      now: NOW,
    });
    expect(byPrimary.explain?.routes.graph.ran).toBe(true);
    expect(byPrimary.explain?.routes.graph.candidates).toBeGreaterThan(0);
    expect(byPrimary.hits.find((hit) => hit.id === 'm-zhang')?.fromGraph).toBe(true);

    // 性质：**别名**同样能解析到**同一个** entity_id（§4.5 的唯一实现，主名优先于别名）。
    const byAlias = recall(store, {
      context: '住在哪里',
      entityNames: ['老张'],
      topN: 8,
      explain: true,
      now: NOW,
    });
    expect(byAlias.explain?.routes.graph.ran).toBe(true);
    expect(byAlias.explain?.routes.graph.candidates).toBeGreaterThan(0);
    expect(byAlias.hits.find((hit) => hit.id === 'm-zhang')?.fromGraph).toBe(true);
  });

  it('★ 解析不到的名字**不进图谱路**，且**不得**建实体（查询路径禁止写库）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm-x', content: '查无此人喜欢狗' });

    const before = countRows(db, 'entities');
    const result = recall(store, {
      context: '查无此人喜欢狗',
      entityNames: ['查无此人'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    // ⚠️ 负控：名称解析若**顺手建了实体** ⇒ 库里多一行 ⇒ 这条变红。
    expect(countRows(db, 'entities')).toBe(before);
    // 性质：解析不到 ⇒ 图谱路**不跑**（`ran=false`），但文本路照常。
    expect(result.explain?.routes.graph.ran).toBe(false);
    expect(result.explain?.routes.text.ran).toBe(true);
  });

  it('★ 调用方传 `entityIds` ⇒ 直接用；传空数组 ⇒ 图谱路转空', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-li', '李四');
    seedMemory(db, { id: 'm-li', content: '李四在杭州' });
    linkEntity(db, 'm-li', 'e-li');

    const withIds = recall(store, {
      context: '与实体名完全无关的话',
      entityIds: ['e-li'],
      topN: 8,
      explain: true,
      now: NOW,
    });
    expect(withIds.explain?.routes.graph.ran).toBe(true);
    expect(withIds.hits.find((hit) => hit.id === 'm-li')?.fromGraph).toBe(true);

    const withEmpty = recall(store, {
      context: '与实体名完全无关的话',
      entityIds: [],
      topN: 8,
      explain: true,
      now: NOW,
    });
    // ⚠️ 负控：把「空数组」当成「未传」⇒ 会去跑名称解析 ⇒ `ran` 变成 true。
    expect(withEmpty.explain?.routes.graph.ran).toBe(false);
    expect(withEmpty.explain?.routes.graph.candidates).toBe(0);
    expect(withEmpty.hits).toHaveLength(0);
  });

  it('★ 两者都不传 ⇒ 图谱路为空（**库不抽取实体**：ADR-P1-T08-GAP 缺口① / ADR-2）', () => {
    const { db, store } = createTestStore();
    // ⚠️ **上下文里明明有一个已知实体名** —— 但库**不抽取** ⇒ 图谱路必须仍然为空。
    //   这条是「库内不得出现『扫全表找名字』的隐式路径」的**可执行守卫**：
    //   若实现又偷偷做库内抽取 ⇒ 图谱路会跑起来 ⇒ 这条变红。
    seedEntity(db, 'e-zhang', '张三');
    seedMemory(db, { id: 'm-zhang', content: '张三住在北京' });
    linkEntity(db, 'm-zhang', 'e-zhang');

    const result = recall(store, {
      context: '张三住在哪里',
      topN: 8,
      explain: true,
      now: NOW,
    });

    expect(result.explain?.routes.graph.ran).toBe(false);
    expect(result.explain?.routes.graph.candidates).toBe(0);
    // 性质：文本路照常（**「谁配被想起」由词法与闸门决定，不因没有实体而停摆**）。
    expect(result.explain?.routes.text.ran).toBe(true);
    const hit = result.hits.find((item) => item.id === 'm-zhang');
    expect(hit?.fromText).toBe(true);
    expect(hit?.fromGraph).toBe(false);
    // ⚠️ **没有实体 ⇒ `graphProximity` 恒 0**（没有交集可判）。
    expect(hit?.breakdown?.graphPart).toBe(0);
  });

  it('★ `entityIds` 与 `entityNames` 同传 ⇒ 抛 `INVALID_INPUT`（互斥，不静默取舍）', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-li', '李四');

    // ⚠️ 负控：若实现「优先取 entityIds、把 entityNames 静默丢掉」⇒ 不抛错 ⇒ 这条变红。
    expect(() =>
      recall(store, {
        context: '随便什么话',
        entityIds: ['e-li'],
        entityNames: ['李四'],
        topN: 8,
        now: NOW,
      }),
    ).toThrowError(/互斥/);
  });

  it('★ `extractEntityNames` 是**独立**辅助函数（不在流水线里）：能找到上下文里的已知实体名/别名', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-zhang', '张三');
    db.prepare('INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run(
      '老张',
      'e-zhang',
    );

    // 性质：辅助函数能找到上下文里的**主名**与**别名**（只认库里已有的名字）。
    expect(extractEntityNames(db, '张三住在哪里')).toContain('张三');
    expect(extractEntityNames(db, '老张住在哪里')).toContain('老张');
    expect(extractEntityNames(db, '查无此人')).toHaveLength(0);

    // ★ 关键性质：**它不在流水线里** —— 调用方即使不把结果塞进 `entityNames`，
    //   召回也**不会**因为「上下文里有已知实体名」而跑起图谱路。
    const result = recall(store, { context: '张三住在哪里', topN: 8, explain: true, now: NOW });
    expect(result.explain?.routes.graph.ran).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、文本路的分支判定顺序（固定顺序 + 负控）
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · 文本路的分支判定顺序（§4.6 步骤 2a）', () => {
  it('★ FTS 分支：只返回词法命中的记忆（不会把「无条件拼第二个分支」的噪声带进来）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm-hit', content: '张三住在北京' });
    seedMemory(db, { id: 'm-miss', content: '完全无关的内容' });

    const result = recall(store, { context: '张三住哪里', topN: 8, explain: true, now: NOW });

    // ⚠️ **负控**：把判定写成「先判一个再**无条件**拼第二个」——
    //   在 FTS 分支上无条件 AND 上 LIKE 条件 ⇒ `@fallbackLike` 为 null ⇒
    //   `content LIKE ('%' || null || '%')` 求值为 NULL ⇒ **整条 WHERE 恒不成立**
    //   ⇒ 文本路**一条都返回不了** ⇒ 本条断言变红（`m-hit` 消失）。
    expect(result.hits.map((hit) => hit.id)).toEqual(['m-hit']);
  });

  it('★ LIKE 兜底分支：只返回正文里真含那个字的记忆', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm-cat', content: '张三喜欢猫' });
    seedMemory(db, { id: 'm-dog', content: '李四喜欢狗' });

    const result = recall(store, { context: '猫', topN: 8, explain: true, now: NOW });

    // ⚠️ **负控**：在 LIKE 分支上无条件 AND 上 FTS 条件 ⇒ `@matchSql` 为 null ⇒
    //   `mem_fts MATCH null` 求值为 NULL ⇒ 整条 WHERE 恒不成立 ⇒ `m-cat` 消失 ⇒ 变红。
    expect(result.hits.map((hit) => hit.id)).toEqual(['m-cat']);
  });

  it('★ 两个分支都为空 ⇒ 文本路**整体不执行**（不是「跑了但没命中」）', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-li', '李四');
    seedMemory(db, { id: 'm-li', content: '李四在杭州' });
    linkEntity(db, 'm-li', 'e-li');

    const result = recall(store, {
      context: 'x',
      entityIds: ['e-li'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    // ⚠️ **负控**：把「两个都为空」当成「走 LIKE 且片段为空」⇒ 文本路会跑出一个
    //   `LIKE '%%'`（命中一切）或空结果的分支 ⇒ `ran` 不再是 false ⇒ 变红。
    expect(result.explain?.routes.text.ran).toBe(false);
    expect(result.explain?.routes.text.candidates).toBe(0);
    // 性质：文本路缺席**不影响**图谱路。
    expect(result.hits.find((hit) => hit.id === 'm-li')?.fromGraph).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、事件（§4.6 步骤 4 / §8.4）
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · 步骤 4 的事件与诊断（§4.6 步骤 4 / §8.4）', () => {
  it('★ explain=true ⇒ 恰好一条 recall 事件；diagnostics=true ⇒ 零条事件但有 explain 块', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });

    const explained = recall(store, { context: '张三住哪里', topN: 8, explain: true, now: NOW });
    expect(readEvents(db, 'recall')).toHaveLength(1);
    expect(explained.explain).toBeDefined();

    const diagnosed = recall(store, {
      context: '张三住哪里',
      topN: 8,
      diagnostics: true,
      now: NOW,
    });
    // ⚠️ **零条**新事件（`diagnostics` 只取数据不写事件）。
    expect(readEvents(db, 'recall')).toHaveLength(1);
    expect(diagnosed.explain).toBeDefined();

    // 性质：默认**不记事件**（写放大）。
    const plain = recall(store, { context: '张三住哪里', topN: 8, now: NOW });
    expect(readEvents(db, 'recall')).toHaveLength(1);
    expect(plain.explain).toBeUndefined();
  });

  it('★ explain 与 diagnostics 同为 true ⇒ 以 explain 为准（含事件）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });

    const result = recall(store, {
      context: '张三住哪里',
      topN: 8,
      explain: true,
      diagnostics: true,
      now: NOW,
    });

    expect(readEvents(db, 'recall')).toHaveLength(1);
    expect(result.explain).toBeDefined();
  });

  it('★ 事件 payload 的键集与 §8.4 逐字一致，且 contextHash 只存哈希不存原文', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });
    seedMemory(db, { id: 'm2', content: '张三喜欢猫' });

    const context = '张三住哪里';
    const result = recall(store, { context, topN: 8, explain: true, now: NOW });

    const events = readEvents(db, 'recall');
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.memory_id).toBeNull();
    const payload = event?.payload ?? {};

    // 性质：键集**逐字**等于 §8.4 的 recall 行（多一个键或少一个键都是漂移）。
    expect(Object.keys(payload).sort()).toEqual(
      [
        'contextHash',
        'topN',
        'hitIds',
        'scores',
        'includeArchived',
        'diffuseArchived',
        'vectorUsed',
        'suppressedIds',
        'diffusedSeeds',
      ].sort(),
    );

    const expectedHash = createHash('sha1').update(context, 'utf8').digest('hex');
    expect(payload.contextHash).toBe(expectedHash);
    // ⚠️ **只存哈希不存原文**（§4.6 步骤 4：避免日志侧泄露对话内容）。
    expect(JSON.stringify(payload)).not.toContain(context);

    // 性质：`hitIds` 与 `scores` 一一对应且与返回结果一致。
    expect(payload.hitIds).toEqual(result.hits.map((hit) => hit.id));
    expect(payload.scores).toEqual(result.hits.map((hit) => hit.score));
  });

  it('★ vectorUsed 恒带该键且本阶段恒为 false（向量路整路缺席）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });

    recall(store, { context: '张三住哪里', topN: 8, explain: true, now: NOW });

    const payload = readEvents(db, 'recall')[0]?.payload ?? {};
    // ⚠️ **键恒在**：事后复盘「这次为什么没命中」时，第一个要排除的就是「向量路根本没跑」，
    //   而这个事实在正文与 `scores` 里都看不出来。
    expect(Object.prototype.hasOwnProperty.call(payload, 'vectorUsed')).toBe(true);
    expect(payload.vectorUsed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 八、写路径纪律（recall 绝不写 coacts / 不写 memories）
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · recall 的写路径纪律（§2 原则⑤ / ADR-19 / §4.6 步骤 4）', () => {
  it('★ recall 不写 memories，也不写 coacts（默认路径）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });
    seedMemory(db, { id: 'm2', content: '张三喜欢猫' });

    const before = snapshotMemories(db);
    const coactsBefore = countRows(db, 'coacts');

    const result = recall(store, { context: '张三住哪里', topN: 8, explain: true, now: NOW });
    expect(result.hits.length).toBeGreaterThan(0);

    // ⚠️ **负控**：recall 里若误写了 `memories`（哪怕只改一列）⇒ 这一条变红。
    expect(snapshotMemories(db)).toEqual(before);
    // ⚠️ **负控**：recall 参与共激活 ⇒ topN 自我强化 ⇒ 库锁死在早期话题上。
    expect(countRows(db, 'coacts')).toBe(coactsBefore);
  });

  it('★ reinforce=true ⇒ 走 touch 的加固形状、reason=reinforce、且**不建共激活边**', () => {
    const { db, store, params } = createTestStore();
    seedMemory(db, {
      id: 'm1',
      content: '张三住在北京',
      stability: 10,
      difficulty: 0.5,
      lastAccess: NOW - 10 * MS_PER_DAY,
    });

    const result = recall(store, {
      context: '张三住哪里',
      topN: 1,
      reinforce: true,
      now: NOW,
    });
    expect(result.hits).toHaveLength(1);

    // 性质：稳定度**涨了**（间隔 10 天 ≥ 1 天 ⇒ 过同日守卫 ⇒ 走间隔重复加成）。
    const row = readRow(db, 'm1');
    expect(row.stability).toBeGreaterThan(10);
    expect(row.stability).toBeLessThanOrEqual(params.MAX_STABILITY);

    // 性质：事件 reason 是 `'reinforce'`（**不是** `'explicit'`）——
    //   「调用方确认采纳」与「调用方只是开了 reinforce 开关」是**两件事**。
    const touchEvents = readEvents(db, 'touch');
    expect(touchEvents).toHaveLength(1);
    expect(touchEvents[0]?.payload.reason).toBe('reinforce');

    // ⚠️ **负控**：reinforce 若顺手建了共激活边 ⇒ 这一条变红。
    expect(countRows(db, 'coacts')).toBe(0);
  });

  it('★ reinforce=false ⇒ 连一条 touch 事件都不该有', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京', stability: 1 });

    const before = snapshotMemories(db);
    recall(store, { context: '张三住哪里', topN: 8, now: NOW });

    expect(readEvents(db, 'touch')).toHaveLength(0);
    expect(snapshotMemories(db)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 九、静态扫描（守住「替换点收敛在一处」与 C37）
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T08 · 流水线的静态纪律（ADR-16 / C37）', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/store/recall.ts', import.meta.url)),
    'utf8',
  );

  it('★ 流水线**不得**直接引用向量分桶的表名（守住 ADR-16 的「替换点收敛在一处」）', () => {
    // ⚠️ 负控：一旦在 `recall.ts` 里写出这些表名 ⇒ 本条变红
    //   （换向量后端时就不必重写流水线，而那正是 ADR-16 要保住的那条承诺）。
    for (const table of ['vector_coarse_cells', 'vector_fine_cells', 'vector_cell_members']) {
      expect(source).not.toContain(table);
    }
  });

  it('★ 真实时钟只能经 `src/core/clock.ts`（C37）⇒ 本文件不出现直接读时钟的写法', () => {
    expect(source).not.toContain('Date.now(');
    expect(source).not.toContain('new Date(');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 十、可执行的负控判据（**改坏 ⇒ 必失败**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **负控的正确形态**：写在**测试文件里**的、可直接执行的判据 ——
 *   每条都写明「把它改坏成什么样 ⇒ 这条会红、为什么」，并且**当场算出反事实值**
 *   （坏掉之后实现会给出的那个数）与实现的实际值对照。
 *
 * ⚠️ **为什么不用「改源码再跑一遍」的脚本**：那种脚手架要么改工作区
 *   （污染同仓的并行开发线），要么另开一份副本（测的就不是本仓的代码了）；
 *   而**在测试里算出反事实**同样能判红，且**不需要动任何源码**。
 * ⚠️ **反事实必须与实际值「可区分」**：每条 NC 都先断言「两种口径确实不同」
 *   （否则判据恒真 = 没有判据）。
 */
describe('P1-T08 · 可执行的负控判据（改坏 ⇒ 必失败）', () => {
  it('★ NC1 粗筛窗口：两档严格有序、公式逐项对齐 params、includeArchived ⇒ 整体取消', () => {
    const { params } = createTestStore();

    const window = coarseGateWindow(params, NOW, false);
    expect(window.enabled).toBe(true);

    // ⚠️ 负控：**漏乘 `MAX_PIN_FACTOR`** ⇒ 两档相等 ⇒ 「pin 的窗口更宽」这条塌掉 ⇒ 变红。
    expect(window.coarseCutoffPinned).toBeLessThan(window.coarseCutoff);

    // ⚠️ 负控：**把 `MAX_STABILITY` 换成逐行的 `stability`**（窗口随候选变化）
    //   ⇒ 公式对不上 ⇒ 变红。
    const archiveSpanDays = Math.log(1 / params.ARCHIVE_LINE);
    expect(window.coarseCutoff).toBeCloseTo(
      NOW - params.MAX_STABILITY * archiveSpanDays * MS_PER_DAY,
      6,
    );
    expect(window.coarseCutoffPinned).toBeCloseTo(
      NOW - params.MAX_STABILITY * params.MAX_PIN_FACTOR * archiveSpanDays * MS_PER_DAY,
      6,
    );

    // ⚠️ 负控：`includeArchived` 时仍返回一档窗口 ⇒ 归档层被粗筛挡住 ⇒ 变红。
    const archived = coarseGateWindow(params, NOW, true);
    expect(archived.enabled).toBe(false);
    expect(archived.coarseCutoff).toBe(0);
    expect(archived.coarseCutoffPinned).toBe(0);
  });

  it('★ NC1b 流水线**只调用** `scoring.ts` 的现成能力，不另写公式（源码级）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/store/recall.ts', import.meta.url)),
      'utf8',
    );

    // ⚠️ 负控：在 `recall.ts` 里**另写一份**粗筛窗口公式 ⇒ 两份公式会漂移 ⇒ 变红。
    //   （漂移不报错：两个数都像正常值，只是某一路的闸门悄悄变宽 ⇒ 遗忘曲线被废掉。）
    expect(source).toContain('coarseGateWindow(');
    expect(source).not.toContain('MAX_STABILITY');
    expect(source).not.toContain('MS_PER_DAY');

    // ⚠️ 负控：把闸门 / 打分**各写一份**（自建 `intensity > ARCHIVE_LINE` 之类）⇒ 变红。
    for (const call of [
      'archiveFilterThreshold(',
      'passesIntensityFilter(',
      'normalizeBm25(',
      'assignGraphProximity(',
      'fuseScore(',
      'SCORE_WEIGHTS.',
    ]) {
      expect(source).toContain(call);
    }
    // ⚠️ 负控：绕过 `scoring.ts` 直接 `require`/内联权重表 ⇒ 变红。
    expect(source).not.toMatch(/0\.3\s*\*|0\.25\s*\*|0\.15\s*\*|0\.1\s*\*/);
  });

  it('★ NC2 行为反事实（一档窗口）：落在两档之间的 pinned 记忆若只有一档就会被挡掉（实际没被挡 ⇒ 确有两档）', () => {
    const { db, store, params } = createTestStore();
    const window = coarseGateWindow(params, NOW, false);

    // 造一条**恰好落在两档窗口之间**的 pinned 记忆：
    //   · 普通档窗口 ⇒ 它在窗口**外**；
    //   · pin 档窗口 ⇒ 它在窗口**内**。
    const plainWindowDays = (NOW - window.coarseCutoff) / MS_PER_DAY;
    const pinnedWindowDays = (NOW - window.coarseCutoffPinned) / MS_PER_DAY;
    const elapsedDays = (plainWindowDays + pinnedWindowDays) / 2;

    seedMemory(db, {
      id: 'm-pinned-between',
      content: '张三喜欢猫',
      stability: params.MAX_STABILITY,
      pinFactor: params.MAX_PIN_FACTOR,
      lastAccess: NOW - elapsedDays * MS_PER_DAY,
    });

    const result = recall(store, { context: '张三喜欢猫', topN: 8, explain: true, now: NOW });

    const row = readRow(db, 'm-pinned-between');
    // 反事实的前提①：**若只有一档窗口**（普通档），它的 `last_access` 落在窗口外 ⇒ 会被挡掉。
    expect(row.last_access).toBeLessThan(window.coarseCutoff);
    // 反事实的前提②：**两档窗口**下，它落在 pin 档窗口内 ⇒ 不该被挡掉。
    expect(row.last_access).toBeGreaterThanOrEqual(window.coarseCutoffPinned);
    // 反事实的前提③：它**过得了精筛**（否则「粗筛挡了它」这件事无从谈起）。
    const value = intensity(
      { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
      NOW,
    );
    expect(value).toBeGreaterThan(params.ARCHIVE_LINE);

    // 实际：它回来了 ⇒ 粗筛确实用的是**两档**窗口。
    // ⚠️ 负控：把粗筛改成「一档窗口」⇒ 它会被挡掉 ⇒ 这条变红。
    expect(result.hits.map((hit) => hit.id)).toContain('m-pinned-between');
  });

  it('★ NC3 行为反事实（对 pin 一律豁免）：τ 超过粗筛窗口上界的行即便过了精筛也进不了候选', () => {
    const { db, store, params } = createTestStore();
    const window = coarseGateWindow(params, NOW, false);

    // ⚠️ 这条记忆的 `stability` **超过当前生效的 `MAX_STABILITY`**
    //   （模拟「参数放宽时写入、之后又把 `MAX_STABILITY` 调小」的历史行）：
    //   ⇒ 它的 τ 超过粗筛窗口按 `MAX_STABILITY` 推出的上界
    //   ⇒ **它过得了精筛、却过不了粗筛** —— 这正是粗筛窗口存在的意义。
    // ⚠️ **为什么非要造这种「越界行」**：在契约内（τ ≤ `MAX_STABILITY × MAX_PIN_FACTOR`）
    //   粗筛窗口恒 ≥ 精筛窗口 ⇒ 「一律豁免」与「两档窗口」**观测不到差别** ⇒ 负控是空的。
    const stability = params.MAX_STABILITY * 2;
    const pinnedWindowDays = (NOW - window.coarseCutoffPinned) / MS_PER_DAY;
    const elapsedDays = pinnedWindowDays * 1.5;

    seedMemory(db, {
      id: 'm-over-stability',
      content: '张三喜欢猫',
      stability,
      pinFactor: params.MAX_PIN_FACTOR,
      lastAccess: NOW - elapsedDays * MS_PER_DAY,
    });

    const result = recall(store, { context: '张三喜欢猫', topN: 8, explain: true, now: NOW });

    // 反事实的前提：它**过得了精筛**（强度仍高于归档线）。
    const row = readRow(db, 'm-over-stability');
    const value = intensity(
      { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
      NOW,
    );
    expect(value).toBeGreaterThan(params.ARCHIVE_LINE);
    // 反事实的前提：它在**粗筛窗口之外**（两档都在它前面）。
    expect(row.last_access).toBeLessThan(window.coarseCutoffPinned);

    // 实际：粗筛把它挡在候选集之外 ⇒ 不出现。
    // ⚠️ 负控：粗筛若对 pin「一律豁免」（或整体取消）⇒ 它会混进来 ⇒ 这条变红。
    expect(result.hits.map((hit) => hit.id)).not.toContain('m-over-stability');
  });

  it('★ NC5 中位数污染的反事实：把非文本路候选按 0 塞进中位数会改变 textPart（实际没变 ⇒ 实现没被污染）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm1', content: '张三住在北京' });
    seedMemory(db, { id: 'm2', content: '张三喜欢猫' });
    seedMemory(db, { id: 'm3', content: '张三在北京工作' });
    seedEntity(db, 'e-li', '李四');
    seedMemory(db, { id: 'm4', content: '李四在杭州' });
    linkEntity(db, 'm4', 'e-li');

    const result = recall(store, {
      context: '张三住哪里',
      entityIds: ['e-li'],
      topN: 8,
      explain: true,
      now: NOW,
    });

    // 干净口径：只取 `rawBm25` **非空**的候选（文本路命中）。
    const cleanRaws = result.hits
      .map((hit) => hit.breakdown?.rawBm25 ?? null)
      .filter((value): value is number => value !== null);
    const cleanMedian = medianOf(cleanRaws);
    // 被污染的口径：把非文本路命中的候选以 `0` 塞进去。
    const pollutedMedian = medianOf(result.hits.map((hit) => hit.breakdown?.rawBm25 ?? 0));

    // ⚠️ 反事实的前提：两种口径的中位数**确实不同** ⇒ 否则「污染」不会产生可观测差异。
    expect(pollutedMedian).not.toBeCloseTo(cleanMedian, 12);

    for (const id of ['m1', 'm2', 'm3']) {
      const hit = result.hits.find((item) => item.id === id);
      const raw = hit?.breakdown?.rawBm25;
      expect(raw).not.toBeNull();
      if (raw === undefined || raw === null) {
        continue;
      }
      const cleanPart = SCORE_WEIGHTS.normBm25 * normBm25Sigmoid(raw, cleanMedian);
      const pollutedPart = SCORE_WEIGHTS.normBm25 * normBm25Sigmoid(raw, pollutedMedian);
      // 实际：实现用的是**干净口径**。
      expect(hit?.breakdown?.textPart).toBeCloseTo(cleanPart, 12);
      // ⚠️ 负控：若实现把 `null` 当 `0` 塞进中位数 ⇒ 实际值会等于 `pollutedPart` ⇒ 变红。
      expect(hit?.breakdown?.textPart).not.toBeCloseTo(pollutedPart, 12);
    }
  });

  it('★ NC6 文本路的分支顺序（源码级）：两个分支的条件不互相掺杂，且 FTS 判定排在 LIKE 判定之前', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/store/recall.ts', import.meta.url)),
      'utf8',
    );

    const ftsBlock = sliceBlock(source, 'const TEXT_FTS_SQL =', 'const TEXT_LIKE_SQL =');
    const likeBlock = sliceBlock(source, 'const TEXT_LIKE_SQL =', 'const GRAPH_SQL =');

    // ⚠️ 负控：把两个分支的条件**无条件 AND 起来** ⇒ FTS 分支里出现 `fallbackLike` ⇒ 变红。
    expect(ftsBlock).not.toContain('fallbackLike');
    // ⚠️ 负控：LIKE 分支里出现 `matchSql` ⇒ 同上。
    expect(likeBlock).not.toContain('matchSql');
    // ⚠️ 负控：**给 pin 一律豁免**（把 pin 档写成无条件分支）⇒ 这条变红。
    expect(ftsBlock).not.toContain('pin_factor > 1.0 AND');
    expect(source).toContain('m.pin_factor > 1.0 AND m.last_access >= @coarseCutoffPinned');

    // ⚠️ 负控：把判定顺序倒过来（先判 LIKE）⇒ 变红。
    const ftsCheck = source.indexOf("matchSql !== null && matchSql !== ''");
    const likeCheck = source.indexOf("fallbackLike !== null && fallbackLike !== ''");
    expect(ftsCheck).toBeGreaterThan(-1);
    expect(likeCheck).toBeGreaterThan(-1);
    expect(ftsCheck).toBeLessThan(likeCheck);
  });

  it('★ NC7 精筛是**严格大于**：恰好落在归档线上的那条过不了闸门', () => {
    const { params } = createTestStore();
    // ⚠️ 负控：把 `>` 写成 `>=` ⇒ 第一条变红。
    expect(passesIntensityFilter(params.ARCHIVE_LINE, params.ARCHIVE_LINE)).toBe(false);
    expect(passesIntensityFilter(params.ARCHIVE_LINE * (1 + 1e-9), params.ARCHIVE_LINE)).toBe(true);
    // ⚠️ 负控：归档层的阈值是 `0.0` ⇒ 强度**恰为 0** 的那条同样过不了
    //   （「显式查归档层」不是「什么都能回来」）。
    expect(passesIntensityFilter(0, 0)).toBe(false);
  });

  it('★ NC8 缺项**不重算分母**：向量路缺席时，满配候选的上限是 `1 - 0.25`（不是 1.0）', () => {
    const { score } = fuseScore({
      intensity: 1,
      vectorSim: 0,
      normBm25: 1,
      graphProximity: 1,
      recency: 1,
    });
    // ⚠️ 负控：若缺项时重算分母 ⇒ 这里会是 1.0 ⇒ 变红。
    expect(score).toBeCloseTo(1 - SCORE_WEIGHTS.vectorSim, 12);
    expect(score).toBeCloseTo(0.75, 12);
  });

  it('★ NC9 topN 被钳到 1~8（既不报错，也不照单全收）', () => {
    const { db, store } = createTestStore();
    for (let index = 0; index < 12; index += 1) {
      seedMemory(db, { id: `m-${index}`, content: '张三喜欢猫' });
    }

    const many = recall(store, { context: '张三喜欢猫', topN: 100, now: NOW });
    // ⚠️ 负控：去掉上界钳制 ⇒ 12 条全回 ⇒ 这条变红。
    expect(many.hits.length).toBeLessThanOrEqual(8);
    expect(many.hits.length).toBeGreaterThan(0);

    const zero = recall(store, { context: '张三喜欢猫', topN: 0, now: NOW });
    // ⚠️ 负控：把 `0` 当成「不要结果」⇒ 这里会是 0 条 ⇒ 变红。
    expect(zero.hits.length).toBeGreaterThanOrEqual(1);
  });
});
