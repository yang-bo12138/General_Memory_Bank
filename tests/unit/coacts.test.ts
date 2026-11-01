/**
 * §4.11.2 / §4.11.4 的共激活写入 —— DEVELOPMENT-PLAN.md **P3-T01** 的硬断言。
 *
 * ⚠️ **本文件的每条断言都必须真能失败**（否则是假绿）：
 *   · 「coacts 表没长」这类断言**必须同时断言「该发生的事确实发生了」**
 *     （加固涨了 / 边建出来了）——「什么都没发生」当然也不会让表变长。
 *   · 涉及数值的断言**全部用 `toBeCloseTo`**（浮点累加不做逐位相等）。
 *
 * ⚠️ **覆盖面按计划稿行 2186~2208 的「验收标准」逐条对应**：
 *   唯一写入入口 / 机制 A 建边 / base 只施加一次 / 饱和阻尼 / 上限钳制 /
 *   幂等分支 / 同日守卫 / `cause_flags` 只置位不清零 / 截断 / 硬拒 /
 *   无效种子 / 自共激活 / 归一。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { tokenize } from '../../src/core/tokenize.js';
import { createSchema } from '../../src/db/connection.js';
import { EventWriter } from '../../src/store/events.js';
import { recall } from '../../src/store/recall.js';
import { touch } from '../../src/store/touch.js';
import { write } from '../../src/store/write.js';
import { MemoryLogger } from '../../src/util/log.js';
import { vectorToBlob } from '../../src/vector/centroids.js';
import { normalizeNumbers } from '../../src/vector/dot.js';
import { createUntrainedBucketContext } from '../fixtures/bucket-store.js';
import {
  countRows,
  createTestStore,
  insertEntity,
  insertMemory,
  readEvents,
} from '../fixtures/graph-store.js';

/** 固定的「现在」（epoch 毫秒）——全部时间从它推导。 */
const NOW = 1_700_000_000_000;

/** `coacts` 表的一行。 */
interface CoactRow {
  memory_a: string;
  memory_b: string;
  affinity: number;
  coact_count: number;
  cause_flags: number;
  last_active: number;
}

/** 建一个带参数覆盖的 store（机制开关 / 上界这类需要改参数的用例）。 */
function createStoreWithParams(patch: Partial<Params>): {
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

/**
 * 造一条**能被文本路召回**的记忆。
 *
 * ⚠️ **必须自己算 `content_tokens`**：通用夹具的 `insertMemory()` 写的是
 *   `内容 <id>` 这样的占位 token ⇒ FTS 索引里没有正文 ⇒ `recall()` 命中不到
 *   ⇒ 「召回没让 coacts 变长」就成了**空洞断言**（什么都没发生当然不变）。
 */
function seedMemory(db: Database.Database, id: string, content: string): void {
  insertMemory(db, id, {
    content,
    // ⚠️ **稳定度与时间戳必须像「刚被用过」**：默认夹具给的 `stability=1` / `lastAccess=0`
    //   ⇒ 到 `NOW` 时强度已衰减到归档线以下 ⇒ **被强度精筛挡掉** ⇒ 召回恒为空
    //   ⇒ 「召回没让 coacts 变长」就又成了空洞断言。
    stability: 10,
    lastAccess: NOW - 2 * MS_PER_DAY,
    createdAt: NOW - 10 * MS_PER_DAY,
    accessCount: 1,
  });
  db.prepare('UPDATE memories SET content_tokens = @tokens WHERE id = @id').run({
    tokens: tokenize(content),
    id,
  });
}

/** 一个能调 `write()` 的 store 上下文（写入路径需要 logger 与桶归属上下文）。 */
function createWriteStore(): {
  db: Database.Database;
  store: {
    db: Database.Database;
    params: Params;
    events: EventWriter;
    logger: MemoryLogger;
    buckets: ReturnType<typeof createUntrainedBucketContext>;
  };
  params: Params;
} {
  const { db, store, params } = createTestStore();
  return {
    db,
    store: {
      ...store,
      logger: new MemoryLogger(),
      // ⚠️ 「桶尚未训练」⇒ 写入路径不落桶归属（与写入路径的共激活断言无关）
      buckets: createUntrainedBucketContext(db),
    },
    params,
  };
}

/** 把一条记忆挂到实体上（`memory_entities`）。 */
function linkEntity(db: Database.Database, memoryId: string, entityId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (@memoryId, @entityId)',
  ).run({ memoryId, entityId });
}

/** 给一条记忆写向量（**L2 归一化后**入库，与 §3 的列语义一致）。 */
function setEmbedding(db: Database.Database, id: string, raw: number[]): void {
  db.prepare('UPDATE memories SET embedding = @embedding WHERE id = @id').run({
    embedding: vectorToBlob(normalizeNumbers(raw)),
    id,
  });
}

/** 读一对记忆的共激活行（**自动归一** `(a,b)` 的顺序）。 */
function readCoact(db: Database.Database, x: string, y: string): CoactRow | undefined {
  const a = x < y ? x : y;
  const b = x < y ? y : x;
  return db
    .prepare(
      `SELECT memory_a, memory_b, affinity, coact_count, cause_flags, last_active
         FROM coacts WHERE memory_a = @a AND memory_b = @b`,
    )
    .get({ a, b }) as CoactRow | undefined;
}

/** 读 `touch` 事件里的第一个 payload。 */
function firstTouchPayload(db: Database.Database): Record<string, unknown> {
  const events = readEvents(db, 'touch');
  return events[0]?.payload ?? {};
}

/**
 * 读**最后一次** `touch` 的 payload。
 *
 * ⚠️ **必须看清是哪一次**：同一次 `touch(ids)` 会为**每条**记忆记一条事件
 *   ⇒ 事件是「逐条」的，而共激活回执是「整批」的 ⇒ **同一批的所有事件带着同一份回执**。
 */
function lastTouchPayload(db: Database.Database): Record<string, unknown> {
  const events = readEvents(db, 'touch');
  return events[events.length - 1]?.payload ?? {};
}

// ═══════════════════════════════════════════════════════════════════════
// 一、唯一写入入口：只有 `touch()` 能写 coacts（§4.11.2 / ADR-19）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · 唯一写入入口：只有 touch() 写 coacts', () => {
  it('★ recall()（不带 reinforce）之后 coacts 表行数不变（而召回确实命中了东西）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, 'm-1', '张三喜欢猫粮');
    seedMemory(db, 'm-2', '张三在买猫粮');

    const before = countRows(db, 'coacts');
    const result = recall(store, { context: '猫粮', now: NOW });

    // 性质（非空洞性）：召回到了东西 ⇒「表没长」不是因为「什么都没发生」
    expect(result.hits.length).toBeGreaterThan(0);
    expect(countRows(db, 'coacts')).toBe(before);
  });

  it('★ recall({reinforce:true}) 之后 coacts 表行数不变（而加固确实发生了）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, 'm-1', '张三喜欢猫粮');
    seedMemory(db, 'm-2', '张三在买猫粮');

    const before = countRows(db, 'coacts');
    const result = recall(store, { context: '猫粮', reinforce: true, now: NOW });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(countRows(db, 'coacts')).toBe(before);

    // 性质：加固确实发生了 ⇒ 上面那条不是空洞断言
    const hit = result.hits[0];
    expect(hit).toBeDefined();
    const row = db
      .prepare('SELECT stability, access_count FROM memories WHERE id = @id')
      .get({ id: hit?.id ?? '' }) as { stability: number; access_count: number };
    expect(row.access_count).toBeGreaterThan(0);
  });

  it('★ recall({explain:true}) 与 recall({diagnostics:true}) 之后 coacts 表行数也不变', () => {
    const { db, store } = createTestStore();
    seedMemory(db, 'm-1', '张三喜欢猫粮');

    const before = countRows(db, 'coacts');
    recall(store, { context: '猫粮', explain: true, now: NOW });
    expect(countRows(db, 'coacts')).toBe(before);

    recall(store, { context: '猫粮', diagnostics: true, now: NOW });
    expect(countRows(db, 'coacts')).toBe(before);
  });

  it('★ write() 之后 coacts 表行数不变（§4.11.2：第三种写入源明确不实现）', () => {
    const { db, store } = createWriteStore();

    const before = countRows(db, 'coacts');
    const result = write(store, { content: '张三喜欢猫粮', entities: ['张三'], now: NOW });

    // 性质：记忆确实写进去了 ⇒ 不是「什么都没发生」
    expect(result.id).not.toBe('');
    expect(countRows(db, 'coacts')).toBe(before);
  });

  it('★ write() 的完全重复路径（exact_repeat）之后 coacts 表行数也不变', () => {
    const { db, store } = createWriteStore();
    write(store, { content: '张三喜欢猫粮', entities: ['张三'], now: NOW });

    const before = countRows(db, 'coacts');
    const repeat = write(store, { content: '张三喜欢猫粮', entities: ['张三'], now: NOW });

    expect(repeat.exact).toBe(true);
    expect(countRows(db, 'coacts')).toBe(before);
  });

  it('★ 机制开关 coactivation=false ⇒ touch 也不写 coacts（§5 的开关语义）', () => {
    const { db, store } = createStoreWithParams({ coactivation: false });
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    const outcome = touch(store, ['m-1', 'm-2'], NOW);

    expect(outcome[0]?.accepted).toBe(0);
    expect(countRows(db, 'coacts')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 二、机制 A（批内自动）：§4.11.4 ① 的两条证据路径
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · 机制 A（批内自动建边）', () => {
  it('★ 同一批里共享 >= COACT_MIN_ENTITIES 个实体的两条 ⇒ 建边（affinity = 基础增量）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    const outcome = touch(store, ['m-1', 'm-2'], NOW);

    expect(outcome[0]?.accepted).toBe(1);
    expect(countRows(db, 'coacts')).toBe(1);
    const row = readCoact(db, 'm-1', 'm-2');
    expect(row?.affinity).toBeCloseTo(params.COACT_REINFORCE_STEP, 10);
    // ★ bit0 = 机制 A（§3 的位掩码）
    expect(row?.cause_flags).toBe(1);
    expect(row?.coact_count).toBe(1);
    expect(row?.last_active).toBe(NOW);
  });

  it('★ 共享实体不足但余弦 >= COACT_MIN_COS ⇒ 仍建边（两条证据路径各自独立成立）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    // 只共享 1 个实体 ⇒ 低于 COACT_MIN_ENTITIES（默认 2）⇒ 实体路径不成立
    insertEntity(db, 'e-1', '张三');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-2', 'e-1');
    setEmbedding(db, 'm-1', [1, 0]);
    setEmbedding(db, 'm-2', [0.9, 0.43589]);

    touch(store, ['m-1', 'm-2'], NOW);

    expect(countRows(db, 'coacts')).toBe(1);
    expect(readCoact(db, 'm-1', 'm-2')?.affinity).toBeCloseTo(params.COACT_REINFORCE_STEP, 10);
    expect(params.COACT_MIN_COS).toBeLessThanOrEqual(0.9);
  });

  it('★ 两条证据都不满足（共享实体不足 + 余弦不够）⇒ 不建边', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-2', 'e-1');
    setEmbedding(db, 'm-1', [1, 0]);
    setEmbedding(db, 'm-2', [0, 1]);

    const outcome = touch(store, ['m-1', 'm-2'], NOW);

    expect(outcome[0]?.accepted).toBe(0);
    expect(countRows(db, 'coacts')).toBe(0);
  });

  it('★ 实体路径不要求 embedding：两条没有向量的记忆靠共享实体也能建边', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    // 性质：两条记忆**都没有向量** ⇒ 余弦路径根本不存在
    const embedded = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL')
      .get() as { n: number };
    expect(embedded.n).toBe(0);

    touch(store, ['m-1', 'm-2'], NOW);

    expect(countRows(db, 'coacts')).toBe(1);
  });

  it('★ 机制 A 的作用域天然是批内：跨批次的两条**不**自动建边', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    // 第一批：只有 m-1
    touch(store, ['m-1'], NOW);
    expect(countRows(db, 'coacts')).toBe(0);

    // 第二批：只有 m-2 ⇒ 与 m-1 从未出现在同一批 ⇒ 不建边
    touch(store, ['m-2'], NOW + MS_PER_DAY);
    expect(countRows(db, 'coacts')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 三、机制 B（调用方显式声明）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · 机制 B（调用方显式声明）', () => {
  it('★ 显式声明 ⇒ 建边，且因果加成只加一次（affinity = 基础增量 + 因果加成）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');

    // ⚠️ 两条**不共享实体** ⇒ 机制 A 不成立 ⇒ 只有机制 B 命中
    const outcome = touch(store, ['m-1', 'm-2'], NOW, {
      coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
    });

    expect(outcome[0]?.accepted).toBe(1);
    const row = readCoact(db, 'm-1', 'm-2');
    expect(row?.affinity).toBeCloseTo(params.COACT_REINFORCE_STEP + params.COACT_CAUSAL_BONUS, 10);
    // ★ bit1 = 机制 B（bit0 未置位 ⇒ 机制 A 从未建过这条边）
    expect(row?.cause_flags).toBe(2);

    // 事件里必须有因果写入（§8.4 硬规则 3 的四个键之一）
    const payload = firstTouchPayload(db);
    const activationWrites = payload.activationWrites as Array<{
      diffusedId: string;
      seedId: string;
      affinityAfter: number;
      activatedAt: number;
    }>;
    expect(activationWrites).toHaveLength(1);
    expect(activationWrites[0]?.diffusedId).toBe('m-2');
    expect(activationWrites[0]?.seedId).toBe('m-1');
    expect(activationWrites[0]?.activatedAt).toBe(NOW);
  });

  it('★ coActivateWith 的 memoryId 必须是 ids 的成员 ⇒ 否则 INVALID_INPUT', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');

    expect(() =>
      touch(store, ['m-1'], NOW, {
        coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
      }),
    ).toThrowError(MemoryError);

    try {
      touch(store, ['m-1'], NOW, {
        coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
      });
    } catch (error) {
      expect((error as MemoryError).code).toBe('INVALID_INPUT');
    }
    // 性质：抛错 ⇒ 整批不写（事务回滚）
    expect(countRows(db, 'coacts')).toBe(0);
  });

  it('★ seedIds 含自己那条 ⇒ INVALID_INPUT（自共激活）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');

    try {
      touch(store, ['m-1'], NOW, {
        coActivateWith: [{ memoryId: 'm-1', seedIds: ['m-1'] }],
      });
      throw new Error('本该抛 INVALID_INPUT');
    } catch (error) {
      expect((error as MemoryError).code).toBe('INVALID_INPUT');
    }
    expect(countRows(db, 'coacts')).toBe(0);
  });

  it('★ seedIds 与 ids 的其他成员相交是合法的（「A 唤起 B，A 与 B 也一并被采纳」）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');

    const outcome = touch(store, ['m-1', 'm-2'], NOW, {
      coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
    });

    expect(outcome[0]?.accepted).toBe(1);
    expect(countRows(db, 'coacts')).toBe(1);
  });

  it('★ 种子已软删 ⇒ 跳过该种子、不抛错、skippedInvalidSeed 正确、事件记 invalid_seed', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-dead', { deleted: true });

    const outcome = touch(store, ['m-1'], NOW, {
      coActivateWith: [{ memoryId: 'm-1', seedIds: ['m-dead'] }],
    });

    expect(outcome[0]?.skippedInvalidSeed).toBe(1);
    expect(outcome[0]?.accepted).toBe(0);
    expect(countRows(db, 'coacts')).toBe(0);

    const payload = firstTouchPayload(db);
    const skipped = payload.coactSkipped as Array<{
      a: string;
      b: string;
      reason: string;
      hadActivationEvidence: boolean;
    }>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('invalid_seed');
  });

  it('★ 条目数超 COACT_BATCH_MAX ⇒ 硬拒 INVALID_INPUT（不是截断、不是静默）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1');

    const declarations = Array.from({ length: params.COACT_BATCH_MAX + 1 }, (_, index) => ({
      memoryId: 'm-1',
      seedIds: [`m-seed-${index}`],
    }));

    try {
      touch(store, ['m-1'], NOW, { coActivateWith: declarations });
      throw new Error('本该抛 INVALID_INPUT');
    } catch (error) {
      expect((error as MemoryError).code).toBe('INVALID_INPUT');
    }
    expect(countRows(db, 'coacts')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 四、base 的合成与强化公式（§4.11.4 ②）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · base 只施加一次 + 强化公式', () => {
  it('★ 机制 A 与 B 同时命中 ⇒ 增量 = STEP + BONUS（不是 2×STEP、也不是 max）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    // 共享 2 个实体 ⇒ 机制 A 成立
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    touch(store, ['m-1', 'm-2'], NOW, {
      coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
    });

    const row = readCoact(db, 'm-1', 'm-2');
    const expected = params.COACT_REINFORCE_STEP + params.COACT_CAUSAL_BONUS;
    expect(row?.affinity).toBeCloseTo(expected, 10);
    // ★ 反面：不是 2×STEP + BONUS（那会重复计入 0.20）
    expect(row?.affinity).not.toBeCloseTo(
      params.COACT_REINFORCE_STEP * 2 + params.COACT_CAUSAL_BONUS,
      6,
    );
    // ★ 反面：不是 max（取 max 会丢掉因果加成）
    expect(row?.affinity).not.toBeCloseTo(
      Math.max(params.COACT_REINFORCE_STEP, params.COACT_CAUSAL_BONUS),
      6,
    );
    // ★ 两者都建过 ⇒ cause_flags == 3（位掩码能表达「两者都建过」，枚举做不到）
    expect(row?.cause_flags).toBe(3);
  });

  it('★ 饱和阻尼：Δ = base × (1 - affinity_old / MAX)，且 affinity_old 是**存储值**', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    touch(store, ['m-1', 'm-2'], NOW);
    const first = readCoact(db, 'm-1', 'm-2');
    expect(first?.affinity).toBeCloseTo(params.COACT_REINFORCE_STEP, 10);

    // ★ 「衰减很久后再次共现」：40 天后（远超 24h 守卫窗口）
    const later = NOW + 40 * MS_PER_DAY;
    touch(store, ['m-1', 'm-2'], later);

    const second = readCoact(db, 'm-1', 'm-2');
    // ★ 存储值口径：Δ = base × (1 - 0.20 / 1.0) = 0.16 ⇒ affinity = 0.36
    const expectedDelta =
      params.COACT_REINFORCE_STEP * (1 - params.COACT_REINFORCE_STEP / params.COACT_AFFINITY_MAX);
    expect(second?.affinity).toBeCloseTo(params.COACT_REINFORCE_STEP + expectedDelta, 10);

    // ★ 反面：若拿**衰减后的有效值**当 affinity_old ⇒ 增量几乎是全额 base ⇒ affinity ≈ 0.394
    const decayed = params.COACT_REINFORCE_STEP * Math.exp(-40 / params.COACT_STABILITY);
    const wrongAffinity =
      params.COACT_REINFORCE_STEP +
      params.COACT_REINFORCE_STEP * (1 - decayed / params.COACT_AFFINITY_MAX);
    expect(second?.affinity).not.toBeCloseTo(wrongAffinity, 3);
    expect(second?.affinity).toBeLessThan(wrongAffinity);
  });

  it('★ 上限钳制：affinity_new <= COACT_AFFINITY_MAX 恒成立', () => {
    // ⚠️ 把上界调低（默认 1.0）才看得出钳制：默认参数下永远碰不到上限
    const { db, store, params } = createStoreWithParams({ COACT_AFFINITY_MAX: 0.5 });
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    for (let index = 0; index < 20; index += 1) {
      touch(store, ['m-1', 'm-2'], NOW + index * 2 * MS_PER_DAY);
      const row = readCoact(db, 'm-1', 'm-2');
      expect(row?.affinity).toBeLessThanOrEqual(params.COACT_AFFINITY_MAX);
    }
    expect(readCoact(db, 'm-1', 'm-2')?.affinity).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 五、幂等分支（§4.11.4 ③）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · 幂等分支（已存在 ⇒ 只 UPDATE）', () => {
  it('★ 第二次 touch 同一对 ⇒ 不抛 UNIQUE 错误、行数仍为 1、coact_count +1、affinity 按阻尼增长', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');

    touch(store, ['m-1', 'm-2'], NOW);
    const first = readCoact(db, 'm-1', 'm-2');

    // ⚠️ 第二次：**不抛错**（裸 INSERT 会撞 UNIQUE ⇒ SQLITE_CONSTRAINT 穿给调用方）
    const secondOutcome = touch(store, ['m-1', 'm-2'], NOW + 2 * MS_PER_DAY);

    expect(secondOutcome[0]?.accepted).toBe(1);
    expect(countRows(db, 'coacts')).toBe(1);
    const second = readCoact(db, 'm-1', 'm-2');
    expect(second?.coact_count).toBe((first?.coact_count ?? 0) + 1);
    // ★ affinity 按**阻尼**增长（不是全额 base）
    const expectedDelta =
      params.COACT_REINFORCE_STEP * (1 - (first?.affinity ?? 0) / params.COACT_AFFINITY_MAX);
    expect(second?.affinity).toBeCloseTo((first?.affinity ?? 0) + expectedDelta, 10);
    expect(second?.affinity).toBeLessThan((first?.affinity ?? 0) + params.COACT_REINFORCE_STEP);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 六、同日守卫（§4.11.4 的 v2.1 裁决：按「(记忆对, 证据来源)」分别计数）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · 同日守卫（24h 内至多记一次，两类证据互不豁免）', () => {
  /** 造一对共享 2 个实体的记忆（机制 A 的证据成立）。 */
  function seedPair(db: Database.Database): void {
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');
  }

  it('★ 24h 内重复机制 A ⇒ 不增长（并记 coactSkipped）', () => {
    const { db, store } = createTestStore();
    seedPair(db);

    touch(store, ['m-1', 'm-2'], NOW);
    const before = readCoact(db, 'm-1', 'm-2');

    const outcome = touch(store, ['m-1', 'm-2'], NOW + 60 * 60 * 1000);

    const after = readCoact(db, 'm-1', 'm-2');
    expect(after?.affinity).toBeCloseTo(before?.affinity ?? 0, 10);
    expect(after?.coact_count).toBe(before?.coact_count);
    expect(outcome[0]?.accepted).toBe(0);

    // ★ 跳过必须**可观测**（§8.4 硬规则 3）：一条关联要么在 affinity 上，要么在 coactSkipped 里
    const payload = lastTouchPayload(db);
    const skipped = payload.coactSkipped as Array<{
      a: string;
      b: string;
      reason: string;
      hadActivationEvidence: boolean;
    }>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('same_day_guard');
    expect(skipped[0]?.hadActivationEvidence).toBe(false);
  });

  it('★ 24h 内机制 B ⇒ 仍增长（两类证据互不豁免：守卫针对的是同类证据的重复）', () => {
    const { db, store, params } = createTestStore();
    seedPair(db);

    touch(store, ['m-1', 'm-2'], NOW);
    const before = readCoact(db, 'm-1', 'm-2');
    expect(before?.cause_flags).toBe(1);

    // ★ 当天再声明一次因果关联（机制 B）⇒ **必须增长**
    const outcome = touch(store, ['m-1', 'm-2'], NOW + 60 * 60 * 1000, {
      coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
    });

    const after = readCoact(db, 'm-1', 'm-2');
    expect(outcome[0]?.accepted).toBe(1);
    expect(after?.affinity).toBeGreaterThan(before?.affinity ?? 0);
    // ★ 增量 = 因果加成 × (1 - affinity_old / MAX)（基础增量被同类守卫挡下）
    const expectedDelta =
      params.COACT_CAUSAL_BONUS * (1 - (before?.affinity ?? 0) / params.COACT_AFFINITY_MAX);
    expect(after?.affinity).toBeCloseTo((before?.affinity ?? 0) + expectedDelta, 10);
    // ★ 两类证据都建过 ⇒ cause_flags == 3
    expect(after?.cause_flags).toBe(3);
  });

  it('★ cause_flags 只置位不清零：先 A 后 B ⇒ 3；再 A ⇒ 仍为 3', () => {
    const { db, store } = createTestStore();
    seedPair(db);

    touch(store, ['m-1', 'm-2'], NOW);
    expect(readCoact(db, 'm-1', 'm-2')?.cause_flags).toBe(1);

    touch(store, ['m-1', 'm-2'], NOW + 2 * MS_PER_DAY, {
      coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
    });
    expect(readCoact(db, 'm-1', 'm-2')?.cause_flags).toBe(3);

    touch(store, ['m-1', 'm-2'], NOW + 4 * MS_PER_DAY);
    expect(readCoact(db, 'm-1', 'm-2')?.cause_flags).toBe(3);
  });

  it('★ 已知边界：当天先被机制 B 建边、之后当天才出现机制 A 的证据 ⇒ A 的基础增量被挡下（但**不静默丢失**）', () => {
    // ⚠️ **这条钉的是「已知边界」**（`coacts` 表只有一个时间戳 ⇒ 守卫状态无法分源持久化）：
    //   机制 B 的写入刷新了 `last_active` ⇒ 当天再来机制 A ⇒ 基础增量被 24h 守卫挡下。
    //   ⇒ 该 A 证据进 `coactSkipped`（**可观测**）⇒ 24h 之后再来一次即可补上。
    //   ⚠️ 若将来给 `coacts` 加了两个独立的时间戳列 ⇒ **这条断言必须改**（那时它就该成立）。
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');

    // 第一步：只有机制 B（两条不共享实体 ⇒ 机制 A 不成立）
    touch(store, ['m-1', 'm-2'], NOW, {
      coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
    });
    const first = readCoact(db, 'm-1', 'm-2');
    expect(first?.cause_flags).toBe(2);

    // 第二步（同一天）：让机制 A 的证据成立（补上两个共享实体）
    insertEntity(db, 'e-1', '张三');
    insertEntity(db, 'e-2', '猫粮');
    linkEntity(db, 'm-1', 'e-1');
    linkEntity(db, 'm-1', 'e-2');
    linkEntity(db, 'm-2', 'e-1');
    linkEntity(db, 'm-2', 'e-2');
    const outcome = touch(store, ['m-1', 'm-2'], NOW + 60 * 60 * 1000);

    // ★ 基础增量被挡下 ⇒ affinity 没变
    expect(outcome[0]?.accepted).toBe(0);
    expect(readCoact(db, 'm-1', 'm-2')?.affinity).toBeCloseTo(first?.affinity ?? 0, 10);
    // ★ **但它没有静默丢失**：进了 `coactSkipped`
    const skipped = lastTouchPayload(db).coactSkipped as Array<{ reason: string }>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('same_day_guard');

    // 第三步（24h 之后）：机制 A 的证据补上 ⇒ 这次它被记录
    touch(store, ['m-1', 'm-2'], NOW + 2 * MS_PER_DAY);
    const third = readCoact(db, 'm-1', 'm-2');
    expect(third?.cause_flags).toBe(3);
    expect(third?.affinity).toBeGreaterThan(first?.affinity ?? 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 七、上界与归一
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · 上界截断与同源归一', () => {
  it('★ 超 COACT_MAX_PAIRS_PER_TOUCH ⇒ 按数组顺序截断，truncated 正确，事件 coactPairsTruncated 一致', () => {
    const { db, store, params } = createTestStore();
    const seedCount = params.COACT_MAX_PAIRS_PER_TOUCH + 5;
    insertMemory(db, 'm-target');
    const declarations = Array.from({ length: seedCount }, (_, index) => {
      const seedId = `m-seed-${index}`;
      insertMemory(db, seedId);
      return { memoryId: 'm-target', seedIds: [seedId] };
    });

    const outcome = touch(store, ['m-target'], NOW, { coActivateWith: declarations });

    expect(outcome[0]?.accepted).toBe(params.COACT_MAX_PAIRS_PER_TOUCH);
    expect(outcome[0]?.truncated).toBe(5);
    expect(countRows(db, 'coacts')).toBe(params.COACT_MAX_PAIRS_PER_TOUCH);

    // ★ 事件里的截断数与返回值一致
    const payload = firstTouchPayload(db);
    expect(payload.coactPairsTruncated).toBe(outcome[0]?.truncated);

    // ★ 按数组顺序截断 ⇒ 保留的是**前 N 条**声明
    const written = db
      .prepare('SELECT memory_a, memory_b FROM coacts ORDER BY memory_a, memory_b')
      .all() as Array<{ memory_a: string; memory_b: string }>;
    for (let index = 0; index < params.COACT_MAX_PAIRS_PER_TOUCH; index += 1) {
      const seedId = `m-seed-${index}`;
      expect(written.some((row) => row.memory_a === seedId || row.memory_b === seedId)).toBe(true);
    }
    expect(
      written.some((row) => row.memory_a === 'm-seed-24' || row.memory_b === 'm-seed-24'),
    ).toBe(false);
  });

  it('★ 归一：(b,a) 与 (a,b) 归一后是**同一行**（memory_a < memory_b）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-a');
    insertMemory(db, 'm-b');

    touch(store, ['m-a', 'm-b'], NOW, {
      coActivateWith: [{ memoryId: 'm-b', seedIds: ['m-a'] }],
    });
    expect(countRows(db, 'coacts')).toBe(1);
    expect(readCoact(db, 'm-b', 'm-a')?.memory_a).toBe('m-a');
    expect(readCoact(db, 'm-b', 'm-a')?.memory_b).toBe('m-b');

    // ★ 反向声明 ⇒ 落在**同一行**（不是第二行）
    touch(store, ['m-a', 'm-b'], NOW + 2 * MS_PER_DAY, {
      coActivateWith: [{ memoryId: 'm-a', seedIds: ['m-b'] }],
    });
    expect(countRows(db, 'coacts')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 八、库内无跨调用状态（ADR-31：因果判断归调用方）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T01 · 库内不维护任何跨调用的状态', () => {
  it('★ 库里没有任何 ledger / LRU / 召回缓存之类的状态表', () => {
    const { db } = createTestStore();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    const suspicious = tables.filter((name) =>
      /ledger|lru|cache|recall|seed|activation|coact_?log|touch_?log/i.test(name),
    );
    expect(suspicious).toEqual([]);
    // 性质：共激活状态**只**存在 `coacts` 这一张表里（没有第二份副本）
    expect(tables.filter((name) => name.includes('coact'))).toEqual(['coacts']);
  });

  it('★ 两次独立的 touch 之间不共享因果状态：后来 touch 种子**不会**被推断成共激活', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');

    // 第一次：只 touch m-1（库**不记**「谁唤起了谁」）
    touch(store, ['m-1'], NOW);
    expect(countRows(db, 'coacts')).toBe(0);

    // 第二次：只 touch m-2 ⇒ 库**不得**推断「m-1 唤起了 m-2」⇒ 不建边
    touch(store, ['m-2'], NOW + MS_PER_DAY);
    expect(countRows(db, 'coacts')).toBe(0);
  });
});
