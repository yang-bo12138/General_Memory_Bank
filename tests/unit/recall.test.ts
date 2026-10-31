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
import { SCORE_WEIGHTS, SCORE_WEIGHT_SUM, clampCos } from '../../src/core/scoring.js';
import { tokenize } from '../../src/core/tokenize.js';
import { recall } from '../../src/store/recall.js';
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
    // ⚠️ 用 700 天而不是 1000 天：Δt/τ = 700 ⇒ `exp(-700) ≈ 9.9e-305`（仍 > 0）；
    //   再老下去 `exp` 会**下溢成 0**（IEEE754 的下溢边界在 ≈745 个时间常数），
    //   而归档层的精筛阈值是 `0.0` 且判定是**严格大于** ⇒ 强度恰为 0 的那条会被挡掉。
    //   （这是一个**浮点边界**而非语义边界，本用例刻意避开它，详见交付报告。）
    seedMemory(db, {
      id: 'm-deep-archived',
      content: '张三喜欢猫',
      stability: 1,
      lastAccess: NOW - 700 * MS_PER_DAY,
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

    // 性质：归档层的精筛阈值是 `0.0` ⇒ 召回出来的每一条 intensity 都**严格大于 0**
    //   （仍不是「什么都能回来」：`deleted = 1` 的依然进不来）。
    for (const hit of withArchived.hits) {
      const row = readRow(db, hit.id);
      const value = intensity(
        { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
        NOW,
      );
      expect(value).toBeGreaterThan(0);
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

    // ⚠️ 负控：把粗筛改成「一档窗口」或「给 pin 一律豁免」⇒ 这条会红。
    //   「一档窗口」⇒ `m-pinned` 被粗筛挡掉；「一律豁免」⇒ `m-plain` 混进来。
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
    // 第二次：**不传** `entityIds` ⇒ 上下文里没有已知的实体名 ⇒ 图谱路不执行 ⇒ 候选集只有三条文本命中。
    const withoutGraph = recall(store, {
      context: '张三住哪里',
      topN: 8,
      explain: true,
      now: NOW,
    });

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

    const result = recall(store, { context: '王五喜欢狗', topN: 8, explain: true, now: NOW });

    const target = result.hits.find((hit) => hit.id === 'm-target');
    expect(target).toBeDefined();
    // 性质：它**没有**进图谱路候选（图谱路的前 100 名被挡道者占满）。
    expect(target?.fromGraph).toBe(false);
    expect(target?.fromText).toBe(true);
    // ★ **核心断言**：按「实体交集」判定 ⇒ 它的 graphProximity 必须是 1.0。
    // ⚠️ 负控：若按「来自哪条路」判定 ⇒ 这里会得到 0 ⇒ 它的 graph 项被抹掉。
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

describe('P1-T08 · 步骤 1 的实体抽取与别名消解（§4.6 步骤 1）', () => {
  it('★ 上下文里出现的已知实体名 ⇒ 进图谱路；别名也能解析', () => {
    const { db, store } = createTestStore();
    seedEntity(db, 'e-zhang', '张三');
    db.prepare('INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run(
      '老张',
      'e-zhang',
    );
    seedMemory(db, { id: 'm-zhang', content: '张三住在北京' });
    linkEntity(db, 'm-zhang', 'e-zhang');

    const byPrimary = recall(store, { context: '张三住在哪里', topN: 8, explain: true, now: NOW });
    expect(byPrimary.explain?.routes.graph.ran).toBe(true);
    expect(byPrimary.explain?.routes.graph.candidates).toBeGreaterThan(0);
    expect(byPrimary.hits.find((hit) => hit.id === 'm-zhang')?.fromGraph).toBe(true);

    // 性质：别名同样能解析到**同一个** entity_id（§4.5 的唯一实现，主名优先于别名）。
    const byAlias = recall(store, { context: '老张住在哪里', topN: 8, explain: true, now: NOW });
    expect(byAlias.explain?.routes.graph.ran).toBe(true);
    expect(byAlias.explain?.routes.graph.candidates).toBeGreaterThan(0);
  });

  it('★ 查询路径**禁止写库**：不认识的名字**不得**建实体', () => {
    const { db, store } = createTestStore();
    seedMemory(db, { id: 'm-x', content: '查无此人喜欢狗' });

    const before = countRows(db, 'entities');
    const result = recall(store, { context: '查无此人喜欢狗', topN: 8, explain: true, now: NOW });

    expect(countRows(db, 'entities')).toBe(before);
    // 性质：不认识的名字 ⇒ 图谱路**不跑**（`ran=false`），但文本路照常。
    expect(result.explain?.routes.graph.ran).toBe(false);
    expect(result.explain?.routes.text.ran).toBe(true);
  });

  it('★ 调用方直接传 entityIds ⇒ 完全跳过名称匹配；传空数组 ⇒ 图谱路转空', () => {
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
    // ⚠️ 负控：把「空数组」当成「未传」⇒ 会去跑名称匹配 ⇒ `ran` 变成 true。
    expect(withEmpty.explain?.routes.graph.ran).toBe(false);
    expect(withEmpty.explain?.routes.graph.candidates).toBe(0);
    expect(withEmpty.hits).toHaveLength(0);
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
