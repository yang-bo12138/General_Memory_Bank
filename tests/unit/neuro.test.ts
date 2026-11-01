/**
 * §12 阶段 3 的**四条单测要求** —— DEVELOPMENT-v2.md（DESIGN-v2.md §12 阶段 3 原文）
 * 「单测覆盖：共激活强化不震荡、侧抑制不误杀、簇分裂/合并、抑制关闭后与 v1.0 逐位一致」。
 *
 * ⚠️ **本文件是 QA 自己写的**（不是工程师单测的补充）：
 *   工程师的单测与被审实现在同一个人手里 ⇒「断言存在但前提不成立 ⇒ 恒绿守卫」这条风险
 *   无法靠它自己排除 ⇒ 本文件**重新构造夹具**，并对**每一条断言**先问一句：
 *   「**它的前提在我的夹具里真的成立吗？**」⇒ 前提用**显式的断言**写在同一条用例里。
 *
 * ⚠️ **四条要求逐条对应**（§12 阶段 3 原文的「单测覆盖」那一句）：
 *   | # | 要求                        | 本文件的用例            |
 *   |---|-----------------------------|------------------------|
 *   | ① | **共激活强化不震荡**         | `N1`（结构式恒等式 + 单调） |
 *   | ② | **侧抑制不误杀**             | `N2`（张三三条全部保留）    |
 *   | ③ | **簇分裂 / 合并**            | `N3`（分裂）/ `N4`（合并） |
 *   | ④ | **抑制关闭后与 v1.0 逐位一致** | `N5`（逐字段全等）        |
 *
 * ⚠️ **要求①的结构式断言**（DEVELOPMENT-PLAN.md P3-T06 原文）：
 *   `(1 - a_new/MAX) == (1 - a_old/MAX) × (1 - base/MAX)`，误差 ≤ 1e-12。
 *   ⚠️ **任何声称「n 次后 affinity 等于某值」的断言都必须先声明 base 恒定且 MAX 足够大
 *   （本次不触发钳制）** ⇒ 本文件用**结构式**（不声称具体值）⇒ 天然免疫钳制，
 *   但**仍然显式断言「本次未触发钳制」**（前提自检）。
 *   ⚠️ **被钳后，本次实际增量不再等于 base（可能是 0）** ⇒ `N1` 另有一条用例钉住这个边界。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { tokenize } from '../../src/core/tokenize.js';
import { createSchema } from '../../src/db/connection.js';
import { recluster } from '../../src/store/clusters.js';
import { EventWriter } from '../../src/store/events.js';
import { inhibitionTrace } from '../../src/store/inhibition.js';
import { recall } from '../../src/store/recall.js';
import { touch } from '../../src/store/touch.js';
import { MemoryLogger } from '../../src/util/log.js';

// ═══════════════════════════════════════════════════════════════════════════
// 零、夹具（**QA 自建**，不依赖任何既有测试文件的 helper）
// ═══════════════════════════════════════════════════════════════════════════

/** 固定的「现在」（epoch 毫秒）——全部时间从它推导。 */
const NOW = 1_700_000_000_000;

/** 一个带参数覆盖的 store。 */
function makeStore(patch: Partial<Params> = {}): {
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
  const params: Params = { ...DEFAULT_PARAMS, ...patch };
  return { db, store: { db, params, events }, params };
}

/** 建一个实体（**id 与 name 同值** ⇒ 测试里不必维护两套词）。 */
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

/**
 * 造一条记忆（**`content_tokens` 必须自己算**，否则 FTS 命中不到）。
 *
 * ⚠️ **`rank` 控制分数顺序**（0 = 分最高）：分数由五项构成 ⇒ 想让某几条确定地排在前面
 *   就得让它们的 `last_access` / `created_at` 更新。
 * ⚠️ **正文相同 ⇒ 词法分相同** ⇒ 顺序差异只来自 `rank` ⇒ 依赖顺序的断言才可预期。
 */
function seedMemory(
  db: Database.Database,
  id: string,
  options: {
    content?: string;
    entityIds?: readonly string[];
    /** 0 = 分最高（最新被访问）；越大越旧。 */
    rank?: number;
    stability?: number;
    lastAccess?: number;
    createdAt?: number;
    accessCount?: number;
  } = {},
): void {
  const rank = options.rank ?? 0;
  const content = options.content ?? `内容 ${id}`;
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                           stability, difficulty, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @stability, 0.5,
             @createdAt, @lastAccess, @accessCount, 0, NULL)`,
  ).run({
    id,
    content,
    tokens: tokenize(content),
    hash: `hash-${id}`,
    stability: options.stability ?? 10,
    createdAt: options.createdAt ?? NOW - (rank + 1) * MS_PER_DAY,
    lastAccess: options.lastAccess ?? NOW - (rank + 1) * 60 * 60 * 1000,
    accessCount: options.accessCount ?? 1,
  });
  for (const entityId of options.entityIds ?? []) {
    linkEntity(db, id, entityId);
  }
}

/** 造一条共激活边（**必须 a < b**，与 `coacts` 的 CHECK 一致）。 */
function insertCoact(
  db: Database.Database,
  left: string,
  right: string,
  affinity: number,
  lastActive: number = NOW,
): void {
  const [a, b] = left < right ? [left, right] : [right, left];
  db.prepare(
    `INSERT OR REPLACE INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
     VALUES (@a, @b, @affinity, 1, 1, @lastActive)`,
  ).run({ a, b, affinity, lastActive });
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

/** 读 `events` 里 `action='recluster'` 的条数。 */
function countReclusterEvents(db: Database.Database): number {
  const rows = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'sweep'").all() as Array<{
    n: number;
  }>;
  return rows[0]?.n ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、要求① · 共激活强化不震荡（§4.11.4）
// ═══════════════════════════════════════════════════════════════════════════

describe('§12 阶段 3 · 要求① · 共激活强化不震荡（§4.11.4）', () => {
  it('N1 · ★ 反复强化同一对 ⇒ affinity **单调不减**且 ≤ MAX；且满足结构式恒等式 (1-a_new/MAX) == (1-a_old/MAX)×(1-base/MAX)', () => {
    const { db, store, params } = makeStore();
    seedMemory(db, 'm-seed', { entityIds: ['e-1', 'e-2'] });
    seedMemory(db, 'm-other', { entityIds: ['e-9'] });

    const max = params.COACT_AFFINITY_MAX;
    // ⚠️ **base 恒定**的前提（DEVELOPMENT-PLAN.md P3-T06 的警告）：
    //   机制 B（`coActivateWith` 显式声明）⇒ base = STEP + CAUSAL_BONUS，**恒定**。
    const base = params.COACT_REINFORCE_STEP + params.COACT_CAUSAL_BONUS;

    const observed: number[] = [];
    // ⚠️ **每次 touch 间隔 2 天** ⇒ 越过 24h 同日守卫（否则 base 会被守卫吞掉 ⇒ 观察不到增长）。
    for (let step = 1; step <= 6; step += 1) {
      touch(store, ['m-other'], NOW + step * 2 * MS_PER_DAY, {
        coActivateWith: [{ memoryId: 'm-other', seedIds: ['m-seed'] }],
      });
      const row = db.prepare('SELECT affinity FROM coacts').get() as { affinity: number };
      observed.push(row.affinity);
    }

    // ── 前提自检 ①：**确实建了边**（否则下面全是空断言）──
    const edge = db.prepare('SELECT affinity, coact_count FROM coacts').get() as {
      affinity: number;
      coact_count: number;
    };
    expect(edge).toBeDefined();
    expect(edge.coact_count).toBe(6);
    expect(observed).toHaveLength(6);

    // ── 前提自检 ②：**base 恒定**（机制 B 命中 ⇒ 每次都是 STEP + CAUSAL_BONUS）──
    expect(base).toBe(params.COACT_REINFORCE_STEP + params.COACT_CAUSAL_BONUS);

    // ── 前提自检 ③：**本次不触发钳制**（否则结构式恒等式不成立 ⇒ 必须先声明）──
    //   ⚠️ 被钳 ⇒ 本次实际增量不再等于 base（可能是 0）⇒ 恒等式的右边仍是理论值 ⇒ 不成立。
    for (const value of observed) {
      expect(value).toBeLessThan(max);
    }

    // ── 断言①：**单调不减**（这是「不震荡」的直接形式）──
    //   ⚠️ 「不出现先降后升」是「单调不减」的**弱化**表述 ⇒ 这里守更强的那个。
    for (let index = 1; index < observed.length; index += 1) {
      expect(observed[index]).toBeGreaterThanOrEqual(observed[index - 1] ?? 0);
    }

    // ── 断言②：**恒 ≤ MAX**（§4.11.4 的钳制位置）──
    for (const value of observed) {
      expect(value).toBeLessThanOrEqual(max);
    }

    // ── 断言③：**结构式恒等式**（P3-T06 明文要求的形状，误差 ≤ 1e-12）──
    let previous = 0;
    for (const value of observed) {
      const lhs = 1 - value / max;
      const rhs = (1 - previous / max) * (1 - base / max);
      expect(Math.abs(lhs - rhs)).toBeLessThanOrEqual(1e-12);
      previous = value;
    }
  });

  it('N1b · ★ **被钳后本次实际增量不再等于 base**（可能是 0）—— 计划 P3-T06 明文警告的那条边界', () => {
    // ⚠️ **本用例钉的是「钳制发生时的行为」**，不是「强化公式」本身。
    //   做法：把 MAX 压到极小 ⇒ 第一次强化就撞钳 ⇒ 后续增量为 0。
    const { db, store, params } = makeStore({ COACT_AFFINITY_MAX: 0.1 });
    seedMemory(db, 'm-seed', { entityIds: ['e-1', 'e-2'] });
    seedMemory(db, 'm-other', { entityIds: ['e-9'] });

    const max = params.COACT_AFFINITY_MAX;
    const base = params.COACT_REINFORCE_STEP + params.COACT_CAUSAL_BONUS;
    // ⚠️ **前提自检**：base **大于** MAX ⇒ 第一次就撞钳（否则本用例测不到钳制）。
    expect(base).toBeGreaterThan(max);

    touch(store, ['m-other'], NOW, {
      coActivateWith: [{ memoryId: 'm-other', seedIds: ['m-seed'] }],
    });
    const first = db.prepare('SELECT affinity FROM coacts').get() as { affinity: number };

    // ⚠️ **前提自检**：**确实撞了钳**（affinity == MAX，而不是 base）——
    //   ⚠️ 这是「本次实际增量不再等于 base」的前提 ⇒ 不成立则本用例是空的。
    expect(first.affinity).toBe(max);
    expect(first.affinity).not.toBe(base);

    // ── 断言：**被钳 ⇒ 实际增量被截断**（不是 base）──
    expect(first.affinity).toBeLessThan(base);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、要求② · 侧抑制不误杀（§4.13.2）
// ═══════════════════════════════════════════════════════════════════════════

describe('§12 阶段 3 · 要求② · 侧抑制不误杀（§4.13.2）', () => {
  it('N2 · ★ 「张三住上海 / 张三喜欢猫 / 张三在腾讯工作」三条 **全部保留**（各只共享「张三」一个实体 ⇒ 不判冗余）', () => {
    const { db, store, params } = makeStore();
    // ⚠️ **三条正文各不相同** ⇒ 词法分不同 ⇒ 分数序**不靠巧合**（下面显式断言分数互不相同）。
    seedMemory(db, 'n-shanghai', {
      content: '张三住上海',
      entityIds: ['zhang-san', 'shanghai'],
      rank: 0,
    });
    seedMemory(db, 'n-cat', {
      content: '张三喜欢猫',
      entityIds: ['zhang-san', 'cat'],
      rank: 1,
    });
    seedMemory(db, 'n-tencent', {
      content: '张三在腾讯工作',
      entityIds: ['zhang-san', 'tencent', 'work'],
      rank: 2,
    });

    const result = recall(store, { context: '张三', now: NOW });

    // ── 前提自检①：**三条都进了候选集**（否则「全部保留」是空断言）──
    expect(result.hits).toHaveLength(3);
    expect(result.hits.map((hit) => hit.id).sort()).toEqual(['n-cat', 'n-shanghai', 'n-tencent']);

    // ── 前提自检②：**分数互不相同**（否则「按分数降序」会退化成「按 id 排」）──
    const scores = result.hits.map((hit) => hit.score);
    expect(new Set(scores).size).toBe(3);

    // ── 前提自检③：**每对只共享 1 个实体 < DEDUP_ENTITY_MIN ⇒ 逐对不冗余** ──
    //   ⚠️ 这是「不误杀」的**根据**（§4.13.2 的实体路径判据）⇒ 必须显式复算。
    const entitySets = new Map<string, Set<string>>([
      ['n-shanghai', new Set(['zhang-san', 'shanghai'])],
      ['n-cat', new Set(['zhang-san', 'cat'])],
      ['n-tencent', new Set(['zhang-san', 'tencent', 'work'])],
    ]);
    const pairs: Array<[string, string]> = [
      ['n-shanghai', 'n-cat'],
      ['n-shanghai', 'n-tencent'],
      ['n-cat', 'n-tencent'],
    ];
    for (const [left, right] of pairs) {
      const shared = [...(entitySets.get(left) ?? [])].filter((id) =>
        (entitySets.get(right) ?? new Set<string>()).has(id),
      );
      expect(shared).toHaveLength(1);
      expect(shared.length).toBeLessThan(params.DEDUP_ENTITY_MIN);
    }

    // ── 断言：**一条都不被挤掉**（suppressed 恒空）──
    expect(result.suppressed).toHaveLength(0);
    expect(result.hits).toHaveLength(3);
  });

  it('N2b · ★ **对照组**：共享 ≥ DEDUP_ENTITY_MIN 个实体的两条**确实**被挤掉 ⇒ 证明 N2 不是「抑制没跑」的假绿', () => {
    const { db, store, params } = makeStore();
    // ⚠️ **与 N2 同一个词法通道**（正文相同 ⇒ 词法分相同 ⇒ 分数序只由 rank 决定）。
    seedMemory(db, 'n-redundant', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-1', 'e-2'],
      rank: 0,
    });
    seedMemory(db, 'n-other', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-1', 'e-2'],
      rank: 1,
    });
    // ⚠️ ★ **第三条（实体完全不同）**——**为什么必须要有它**：
    //   `poolHomogeneous` 的定义是「**除 C0 外每一条都与 C0 冗余**」
    //   ⇒ 若候选集只有两条（另一条与 C0 冗余）⇒ **池级同质为真** ⇒ **一条都不抑制**
    //   ⇒ 「D 桶非空」这个前提**不成立** ⇒ 本用例会变成空断言。
    //   ⇒ 加一条与 C0 **不冗余**的候选 ⇒ 池级同质为假 ⇒ 逐对判冗余才真正跑起来。
    seedMemory(db, 'n-distinct', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-3'],
      rank: 2,
    });

    const result = recall(store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检①：**D 桶非空** ⇒ 抑制确实在跑（否则 N2 的「全部保留」证明不了任何事）──
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.id).toBe('n-other');
    // ⚠️ **被挤掉的那条有合法的 `redundantWith`**（留在 hits 里）⇒ 标注是真的。
    expect(result.suppressed[0]?.redundantWith).toBe('n-redundant');
    expect(result.hits.map((hit) => hit.id)).toContain('n-redundant');
    // ⚠️ **前提自检②**：不冗余的那条**必须留下**（⇒ 抑制不是「一刀切」）。
    expect(result.hits.map((hit) => hit.id)).toContain('n-distinct');
    // ⚠️ **前提自检③**：共享实体数确实达标（否则「被挤掉」另有原因）。
    expect(params.DEDUP_ENTITY_MIN).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、要求③ · 簇分裂 / 簇合并（§4.12.3 / §4.14.3）
// ═══════════════════════════════════════════════════════════════════════════

describe('§12 阶段 3 · 要求③ · 簇分裂 / 簇合并（§4.12.3）', () => {
  /**
   * 造一条**链** `a — b — c — d`（两条有效边 ⇒ 一个连通分量）。
   *
   * ⚠️ **为什么要造「填充记忆」**：兜底切分的触发量是「**原始分量占全库多少**」
   *   ⇒ 在只有 4 条记忆的小库里，**一个分量就占了 100%** ⇒ 切分必然触发
   *   ⇒ 断言的会是「在测切分」而不是「在测分裂」。
   */
  function seedChain(db: Database.Database): void {
    seedMemory(db, 'a');
    seedMemory(db, 'b');
    seedMemory(db, 'c');
    seedMemory(db, 'd');
    // ⚠️ **7 条填充记忆** ⇒ 4/11 ≈ 36% < `MAX_CLUSTER_SHARE`(50%) ⇒ 不触发兜底切分。
    for (let index = 0; index < 7; index += 1) {
      seedMemory(db, `filler-${index}`);
    }
    insertCoact(db, 'a', 'b', 0.6);
    insertCoact(db, 'c', 'd', 0.6);
  }

  it('N3 · ★ 构造「一条边衰减到阈值以下」⇒ 一个簇**分裂成两个簇**（两段都非空）', () => {
    const { db, store } = makeStore();
    seedChain(db);
    // ⚠️ **中间那条边**（b—c）**很久没共现** ⇒ 衰减到阈值以下 ⇒ 不构成连通。
    insertCoact(db, 'b', 'c', 0.6, NOW - 100 * MS_PER_DAY);

    // ── 前提自检①：**那条边确实衰减到门槛以下**（否则「分裂」是假的）──
    const decayed = db
      .prepare("SELECT affinity, last_active FROM coacts WHERE memory_a = 'b' AND memory_b = 'c'")
      .get() as { affinity: number; last_active: number };
    expect(decayed).toBeDefined();
    expect(decayed.affinity).toBeGreaterThan(0);
    const effective = decayed.affinity * Math.exp(-(NOW - decayed.last_active) / (21 * MS_PER_DAY));
    expect(effective).toBeLessThan(DEFAULT_PARAMS.COACT_AFFINITY_MIN);

    recluster(store, NOW);

    // ── 前提自检②：**兜底切分没有触发**（否则「两个簇」可能是切出来的，不是分裂出来的）──
    const totalMemories = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted = 0')
      .get() as { n: number };
    expect(totalMemories.n).toBe(11);
    expect(2 / totalMemories.n).toBeLessThan(DEFAULT_PARAMS.MAX_CLUSTER_SHARE);

    // ── 断言：**分裂成两个簇**，且**两段都非空**（不是「一簇 + 一个孤岛」）──
    const snapshot = readSnapshot(db);
    expect(snapshot).toHaveLength(2);
    const memberSets = snapshot.map((cluster) => cluster.memberIds.join(','));
    expect(memberSets).toContain('a,b');
    expect(memberSets).toContain('c,d');
  });

  it('N4 · ★ 构造「新边连接两个簇」⇒ 两个簇**合并成一个簇**', () => {
    const { db, store } = makeStore();
    seedChain(db);
    // ⚠️ **先把两个分量算成两个簇**（此时 b—c 还没有边）。
    insertCoact(db, 'b', 'c', 0.6, NOW - 100 * MS_PER_DAY);
    recluster(store, NOW);

    // ── 前提自检①：**确实是两个簇**（否则「合并」是空的）──
    const before = readSnapshot(db);
    expect(before).toHaveLength(2);

    // ⚠️ **越过 `CLUSTER_RECALC_INTERVAL_MS` 闸门**（否则第二次 recluster 会被跳过 ⇒ 断言的是「没重算」）。
    const later = NOW + DEFAULT_PARAMS.CLUSTER_RECALC_INTERVAL_MS + 1;
    // ⚠️ **把 b—c 那条边刷新成新鲜边** ⇒ 它重新构成连通 ⇒ 两个分量合并成一个。
    db.prepare("UPDATE coacts SET last_active = @now WHERE memory_a = 'b' AND memory_b = 'c'").run({
      now: later,
    });
    insertCoact(db, 'b', 'c', 0.6, later);

    recluster(store, later);

    // ── 前提自检②：**那条边现在有效**（否则「合并」是假的）──
    const edge = db
      .prepare("SELECT affinity, last_active FROM coacts WHERE memory_a = 'b' AND memory_b = 'c'")
      .get() as { affinity: number; last_active: number };
    const effective = edge.affinity * Math.exp(-(later - edge.last_active) / (21 * MS_PER_DAY));
    expect(effective).toBeGreaterThanOrEqual(DEFAULT_PARAMS.COACT_AFFINITY_MIN);

    // ── 断言：**合并成一个簇**，成员是全部四条 ──
    const after = readSnapshot(db);
    expect(after).toHaveLength(1);
    expect(after[0]?.memberIds).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、要求④ · 抑制关闭后与 v1.0 逐位一致（§4.13.3 / §5）
// ═══════════════════════════════════════════════════════════════════════════

describe('§12 阶段 3 · 要求④ · 抑制关闭后与 v1.0 逐位一致（§4.13.3 / §5）', () => {
  it('N5 · ★ `inhibition = false` ⇒ hits **逐字段全等**于「全部候选按 (score DESC, id ASC) 取 topN」这条 v1.0 规则', () => {
    const on = makeStore();
    const off = makeStore({ inhibition: false });
    // ⚠️ **两条共享两个实体 ⇒ 抑制开启时**确实**会挤掉一条** ⇒ 否则「关时没变」证明不了任何事。
    seedMemory(on.db, 'p-first', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-1', 'e-2'],
      rank: 0,
    });
    seedMemory(on.db, 'p-second', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-1', 'e-2'],
      rank: 1,
    });
    seedMemory(on.db, 'p-third', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-3'],
      rank: 2,
    });
    seedMemory(off.db, 'p-first', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-1', 'e-2'],
      rank: 0,
    });
    seedMemory(off.db, 'p-second', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-1', 'e-2'],
      rank: 1,
    });
    seedMemory(off.db, 'p-third', {
      content: '猫粮品牌偏好记录',
      entityIds: ['e-3'],
      rank: 2,
    });

    const withInhibition = recall(on.store, { context: '猫粮品牌', now: NOW });
    const withoutInhibition = recall(off.store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检①：**抑制确实发生了**（D 桶非空）⇒ 否则下面的比对是空洞的 ──
    expect(withInhibition.suppressed).toHaveLength(1);
    expect(withInhibition.hits.length).toBeLessThan(withoutInhibition.hits.length);

    // ── 前提自检②：**抑制关时一条都没被挤掉**（§5：关 ⇒ 候选带不重排）──
    expect(withoutInhibition.suppressed).toHaveLength(0);
    expect(withoutInhibition.hits).toHaveLength(3);

    // ── 前提自检③：**trace 的候选集覆盖了全部三条**（trace 与 recall 走同一段打分代码）──
    //   ⚠️ 这是「v1.0 规则」的**输入**：全部候选按 (score DESC, id ASC) 排序取 topN。
    const trace = inhibitionTrace(off.store, '猫粮品牌', { now: NOW });
    expect(trace.candidates).toHaveLength(3);

    // ── 断言①：**顺序** = 全部候选按 (score DESC, id ASC) 的前 topN 条 ──
    const expectedOrder = [...trace.candidates]
      .sort((left, right) => {
        if (right.baseScore !== left.baseScore) {
          return right.baseScore - left.baseScore;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .map((candidate) => candidate.id);
    expect(withoutInhibition.hits.map((hit) => hit.id)).toEqual(expectedOrder);

    // ── 断言②：**逐字段全等**（不只是 id 序列）：
    //   每一条 hit 的 id / score / breakdown 五项 / fromText / fromVector / fromGraph
    //   都必须与 trace 给出的 baseScore **逐位**相同（§4.13.1 硬约束①：抑制不进 score）。
    const baseScoreById = new Map(trace.candidates.map((item) => [item.id, item.baseScore]));
    for (const hit of withoutInhibition.hits) {
      expect(hit.score).toBe(baseScoreById.get(hit.id));
    }
    // ⚠️ **score 逐位相同**（不是 toBeCloseTo）：本要求说的是「逐位一致」。
    expect(withoutInhibition.hits.map((hit) => hit.score)).toEqual(
      withoutInhibition.hits.map((hit) => baseScoreById.get(hit.id) ?? Number.NaN),
    );
  });

  it('N5b · ★ 抑制**开 / 关**两次召回 ⇒ **每一条候选**的分数逐位相同（抑制只改「谁进 hits」，不改分）', () => {
    const on = makeStore();
    const off = makeStore({ inhibition: false });
    for (const db of [on.db, off.db]) {
      seedMemory(db, 'q-first', {
        content: '猫粮品牌偏好记录',
        entityIds: ['e-1', 'e-2'],
        rank: 0,
      });
      seedMemory(db, 'q-second', {
        content: '猫粮品牌偏好记录',
        entityIds: ['e-1', 'e-2'],
        rank: 1,
      });
      seedMemory(db, 'q-third', {
        content: '猫粮品牌偏好记录',
        entityIds: ['e-3'],
        rank: 2,
      });
    }

    const withInhibition = recall(on.store, { context: '猫粮品牌', now: NOW });
    const withoutInhibition = recall(off.store, { context: '猫粮品牌', now: NOW });

    // ── 前提自检：抑制确实挤掉了一条 ──
    expect(withInhibition.suppressed).toHaveLength(1);

    // ── 断言：**分数表逐位相同**（hits + suppressed 合起来才是「每条候选各一个分数」）──
    const scoreOn = new Map<string, number>([
      ...withInhibition.hits.map((hit) => [hit.id, hit.score] as const),
      ...withInhibition.suppressed.map((item) => [item.id, item.score] as const),
    ]);
    const scoreOff = new Map<string, number>(
      withoutInhibition.hits.map((hit) => [hit.id, hit.score] as const),
    );
    expect(scoreOn.size).toBe(3);
    expect(scoreOff.size).toBe(3);
    for (const [id, score] of scoreOff) {
      expect(scoreOn.get(id)).toBe(score);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、recluster 的可观测面（要求③的配套前提：簇「不计算」时什么也不该留下）
// ═══════════════════════════════════════════════════════════════════════════

describe('§12 阶段 3 · 要求③ 的配套 · recluster 的可观测面（§4.12.3）', () => {
  it('N6 · ★ 重算**真的发布了快照**（不是空转）⇒ 前提自检：事件 + 两张表都变了', () => {
    const { db, store } = makeStore();
    seedMemory(db, 'x-1');
    seedMemory(db, 'x-2');
    insertCoact(db, 'x-1', 'x-2', 0.9);
    for (let index = 0; index < 7; index += 1) {
      seedMemory(db, `pad-${index}`);
    }

    // ── 前提自检：**重算前**簇表是空的 ──
    expect(readSnapshot(db)).toHaveLength(0);
    expect(countReclusterEvents(db)).toBe(0);

    const result = recluster(store, NOW);

    expect(result.computed).toBe(true);
    expect(result.skipped).toBeNull();
    expect(readSnapshot(db)).toHaveLength(1);
    expect(readSnapshot(db)[0]?.memberIds).toEqual(['x-1', 'x-2']);
    expect(countReclusterEvents(db)).toBe(1);
  });

  it('N7 · ★ 快照的**成员表**与 `theme_clusters` 的存储成员数**一致**（两处口径不能漂移）', () => {
    const { db, store } = makeStore();
    seedMemory(db, 'y-1');
    seedMemory(db, 'y-2');
    insertCoact(db, 'y-1', 'y-2', 0.9);
    for (let index = 0; index < 7; index += 1) {
      seedMemory(db, `pad-${index}`);
    }
    recluster(store, NOW);

    // ── 前提自检：**重算确实发布了快照**（否则「两处一致」是空的）──
    const snapshot = readSnapshot(db);
    expect(snapshot).toHaveLength(1);

    // ── 断言：**存储的 `member_count` == 成员表的实际行数** ──
    const stored = db
      .prepare('SELECT member_count FROM theme_clusters WHERE cluster_id = ?')
      .get(snapshot[0]?.clusterId) as { member_count: number };
    const actual = db
      .prepare('SELECT COUNT(*) AS n FROM theme_cluster_members WHERE cluster_id = ?')
      .get(snapshot[0]?.clusterId) as { n: number };
    expect(stored.member_count).toBe(actual.n);
  });
});
