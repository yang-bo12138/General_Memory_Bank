/**
 * ★ **步骤 2c 接线**的验收 —— 阶段 5 · P2-T10（设计 D2 / D3 / D3-b / D4 / D5 / D7 / D8）。
 *
 * ⚠️ **本文件回答四个不同的问题，别混着读**：
 * ① **零影响**（D2 的 A 行）：不传 `queryEmbedding` ⇒ 召回行为**一位都不变**。
 *    做法不是「逻辑上不会走那条分支」，而是**两组世界的逐字段相等**：
 *    一组记忆**带向量**、一组**不带向量**，其余完全相同 ⇒ 两次 `recall` 的输出
 *    （正文集合 / score / 五柱 / 三个 `from*` / `suppressed` / `diffused`）必须**逐字段相同**。
 *    ⚠️ 「带向量的那一组」正是「如果向量路跑起来，结果一定会变」的世界（判别力负控在下一段）——
 *    否则「两组相同」可能只是因为「向量路在两组里都跑不动」，那是**空洞的绿**。
 * ② **判别力负控**：同一个世界**传**了 `queryEmbedding` ⇒ 至少一条 hit 的分数**必须变**。
 * ③ **B/C/D 三行**（D5 的处境表）：传了向量之后才可能发生的三种结果，各自逐字段断言。
 * ④ **闸门与合并**（D3 / D3-b / D4）：顺序不可换、`cos < MIN` 不进候选、三路去重、
 *    `includeArchived` 是**两件事**。
 *
 * ⚠️ **两种世界构造方式各有用处**：
 * · **手建世界**（内存库 + 直接插 `memories` + 自己装配端口）：能**精确控制余弦**
 *   （`vectorAtCos()` 让 `cos` 恰好是 `Math.fround(c)`），且不必经过写入路径的归一化
 *   ⇒ 「`vectorPart == 0.25 × cos`」这类**逐位**断言才能成立；
 *   并且**自己持有 `db`** ⇒ 能直接读 `events` 表验 `vectorUsed`。
 * · **`MemoryStore` 世界**（真临时库 + `write()`）：验**门面装配**那一段
 *   （端口在 recall 时现场装配、条件展开、sticky 位）——手建世界**绕过**了它
 *   ⇒ 两者互补，缺一不可。
 *
 * ⚠️ **中文分词的两个坑（踩过，写在这里省下一个人半小时）**：
 *   · `buildMatchQuery()` 对 **≤ 3 个 bigram** 的查询用 `AND`（要求正文含**全部** bigram），
 *     对 **> 3 个**用 `OR` ⇒ 本文件的「文本路要命中」的上下文一律写成 **4 个汉字以上**
 *     （否则「张三猫粮」要求正文含 `三猫` ⇒ 自然文本永远不命中）；
 *   · 「文本路**不要**命中」的正文与上下文必须**用完全不相交的汉字集**
 *     （否则一个共享 bigram 就够了 —— 「完全无关的查询词」与「无关正文」共享 `无关`）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCORE_WEIGHTS } from '../../src/core/scoring.js';
import { tokenize } from '../../src/core/tokenize.js';
import { createSchema } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { EventWriter } from '../../src/store/events.js';
import { inhibitionTrace } from '../../src/store/inhibition.js';
import { type RecallStore, VECTOR_ENRICH_SQL, recall } from '../../src/store/recall.js';
import {
  type RecallVectorPort,
  type VectorPortDeps,
  resolveRecallVectorPort,
} from '../../src/store/vectorPort.js';
import { MemoryLogger } from '../../src/util/log.js';
import { vectorToBlob } from '../../src/vector/centroids.js';

const DIM = DEFAULT_PARAMS.EMBED_DIM;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/**
 * `resolveVectorBackendMode()` 那次全表计数的 SQL。
 *
 * ⚠️ **逐字抄自 `src/store/stats.ts`**（去掉换行与缩进）：它是「四态判定花了多少代价」
 *   唯一可观测的地方 —— 用来证明「不传向量 ⇒ 连判定都不做」。
 *   ⚠️ 不要写成 `embedding IS NOT NULL)`（带右括号）：那会**误命中** `stats()` 里的
 *     `(embedding IS NOT NULL) AS hasEmbedding` ⇒ 计数装置变成假的。
 */
const MODE_COUNT_SQL_FEATURE =
  'count(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL';

/**
 * 本文件用的参数：**显式 flat**（后端确定）+ 关掉抑制与共激活。
 *
 * ⚠️ 为什么关掉那两个机制：本文件验的是**向量路**，而抑制会重排 hits、扩散会填 `diffused`
 *   ⇒ 打开它们会让「哪条 hit 在 hits 里」变成两个机制叠加的结果（断言不再指向单一原因）。
 *   ⚠️ 它们各自有专门的测试文件（`inhibit-acceptance` / `neuro`），覆盖不会因此变窄。
 */
const PARAMS: Params = {
  ...DEFAULT_PARAMS,
  VECTOR_ROUTER: 'flat',
  inhibition: false,
  coactivation: false,
};

/** 「文本路会命中」的上下文（4 个 bigram ⇒ 走 `OR` 分支）。 */
const TEXT_CONTEXT = '张三住在哪里';

/** 「文本路**不**命中」的上下文（与下面所有正文**汉字集不相交**）。 */
const NO_TEXT_CONTEXT = '子丑寅卯辰巳午未';

/** 只在一个轴上为 1 的单位向量。 */
function unitVector(axis: number): Float32Array {
  const vector = new Float32Array(DIM);
  vector[axis] = 1;
  return vector;
}

/** `Float32Array` → `number[]`（`RecallOptions.queryEmbedding` 的口径）。 */
function numbersOf(vector: Float32Array): number[] {
  return [...vector];
}

/**
 * 造一个与 `unitVector(0)` 的余弦**恰好等于** `Math.fround(cos)` 的向量。
 *
 * ⚠️ `dot()` 是「float64 累加 float32 分量之积」⇒ `unit(0)·v = v[0]`（float32 值）
 *   ⇒ 「期望的 cos」就是 `Math.fround(cos)`，可以写 `toBe` 而不是 `toBeCloseTo`。
 */
function vectorAtCos(cos: number): Float32Array {
  const vector = new Float32Array(DIM);
  vector[0] = cos;
  vector[1] = Math.sqrt(1 - cos * cos);
  return vector;
}

/** 一条要插进手建世界的记忆。 */
interface SeedRow {
  id: string;
  content?: string;
  /** 向量（`null` = 没有向量；`undefined` = 用 `unitVector(0)`）。 */
  vector?: Float32Array | null;
  /** 实体名（同时用作 `entities.id` ⇒ `entityNames` 也传同一批字符串）。 */
  entityNames?: readonly string[];
  lastAccess?: number;
  stability?: number;
  pinFactor?: number;
}

/** 手建世界的产物（`db` 是自查 `events` / `vector` 用的）。 */
interface World {
  db: Database.Database;
  store: RecallStore;
  port: RecallVectorPort;
}

/** 手建世界：内存库 + store 上下文（带端口）。 */
function createWorld(params: Params, rows: readonly SeedRow[]): World {
  const db = new Database(':memory:');
  createSchema(db);
  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => NOW,
  });

  const insertMemory = db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding,
                           stability, difficulty, pin_factor, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @embedding,
             @stability, 0.5, @pinFactor, @createdAt, @lastAccess, 0, 0, NULL)`,
  );
  const insertEntity = db.prepare(
    "INSERT OR IGNORE INTO entities (id, name, type, created_at) VALUES (?, ?, 'concept', ?)",
  );
  const linkEntity = db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)',
  );

  for (const row of rows) {
    const content = row.content ?? `内容 ${row.id}`;
    const vector = row.vector === undefined ? unitVector(0) : row.vector;
    insertMemory.run({
      id: row.id,
      content,
      tokens: tokenize(content),
      hash: `hash-${row.id}`,
      embedding: vector === null ? null : vectorToBlob(vector),
      stability: row.stability ?? 10,
      pinFactor: row.pinFactor ?? 1,
      createdAt: NOW - 5 * DAY,
      lastAccess: row.lastAccess ?? NOW - 3_600_000,
    });
    for (const entityName of row.entityNames ?? []) {
      insertEntity.run(entityName, entityName, NOW);
      linkEntity.run(row.id, entityName);
    }
  }

  const deps: VectorPortDeps = {
    // ⚠️ 显式 flat ⇒ 端口必然存在 ⇒ 空模型足够（`flat` 不用中心）
    centroids: () => ({ coarse: [], fine: [] }),
    embeddedAtLeastThreshold: () => false,
    markEmbeddedAtLeastThreshold: () => undefined,
  };
  const port = resolveRecallVectorPort(db, params, deps);
  if (port === null) {
    throw new Error('本文件的夹具要求端口存在（PARAMS 是显式 flat）');
  }
  return { db, store: { db, params, events, vector: port }, port };
}

/** 建一个临时库的 `MemoryStore`（真门面：验装配那一段）。 */
function createFacade(overrides: Partial<Params> = {}): { store: MemoryStore; dbPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-vecpath-'));
  const dbPath = join(dataDir, 'memory.db');
  return {
    store: new MemoryStore({ dbPath, params: { ...PARAMS, ...overrides } }),
    dbPath,
  };
}

/**
 * 用一个**独立只读连接**读 `recall` 事件的 `vectorUsed`。
 *
 * ⚠️ 为什么要另开连接：`#db` 是真正的私有字段（外面拿不到），而「事件里到底记了什么」
 *   是本文件要验的东西之一（`vectorUsed ≡ routes.vector.ran`，C36 不允许两套词）。
 */
function readVectorUsed(dbPath: string): boolean[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM events WHERE type = 'recall' ORDER BY id")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => (JSON.parse(row.payload) as { vectorUsed: boolean }).vectorUsed);
  } finally {
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、A 行：不传 `queryEmbedding` ⇒ 零影响（D2 的第 2 层）
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · A 行 · 不传 `queryEmbedding` ⇒ 召回行为**一位都不变**', () => {
  it('★ 同一世界的「带向量」与「不带向量」两组 ⇒ 输出**逐字段相同**（含 score 与五柱）', () => {
    const { store: withVectors, dbPath } = createFacade();
    const { store: withoutVectors } = createFacade();
    const seeds = [
      { content: '张三住在北京', cos: 0.95 },
      { content: '张三每天喝茶', cos: 0.8 },
      { content: '李四喜欢猫粮', cos: 0.7 },
    ];
    try {
      // ⚠️ 两组**唯一的差别**就是「有没有写入 embedding」
      for (const seed of seeds) {
        withVectors.write({
          content: seed.content,
          embedding: numbersOf(vectorAtCos(seed.cos)),
          now: NOW,
        });
        withoutVectors.write({ content: seed.content, now: NOW });
      }

      const a = withVectors.recall({ context: TEXT_CONTEXT, explain: true, now: NOW });
      const b = withoutVectors.recall({ context: TEXT_CONTEXT, explain: true, now: NOW });

      // ── 前置：分母不为 0（真的召回到了东西），且**只有**共享 bigram 的那两条 ──
      expect(a.hits.length).toBe(2);
      expect(new Set(a.hits.map((hit) => hit.content))).toEqual(
        new Set(['张三住在北京', '张三每天喝茶']),
      );

      // ── 冻结期望值（字面量）：向量路**整路缺席**（A 行的第一个字段就是它）──
      expect(a.explain?.routes.vector).toEqual({ ran: false, candidates: 0 });
      expect(b.explain?.routes.vector).toEqual({ ran: false, candidates: 0 });
      // ── 另外两路照常（证明「整路缺席」不是「三路都没跑」）──
      expect(a.explain?.routes.text).toEqual({ ran: true, candidates: 2 });

      // ── 逐字段：score / 五柱 / 三个来源标记 / 余弦 ──
      const byContent = new Map(b.hits.map((hit) => [hit.content, hit]));
      for (const hitA of a.hits) {
        const hitB = byContent.get(hitA.content);
        expect(hitB, '两组的正文集合必须相同').toBeDefined();
        if (hitB === undefined) {
          continue;
        }
        expect(hitA.score).toBe(hitB.score);
        expect(hitA.breakdown).toEqual(hitB.breakdown);
        // ── A 行的五个标志：全部是缺项值 ──
        expect(hitA.fromVector).toBe(false);
        expect(hitA.breakdown?.cos).toBeNull();
        expect(hitA.breakdown?.vectorPart).toBe(0);
        // ── 负控：`vectorPart` 不是「一个很像 0 的小数」，也不是 0.25 ──
        expect(hitA.breakdown?.vectorPart).not.toBe(SCORE_WEIGHTS.vectorSim);
      }

      // ── `suppressed` / `diffused` 也逐字段相同（本参数组下两者都为空）──
      expect(a.suppressed).toEqual(b.suppressed);
      expect(a.diffused).toEqual(b.diffused);

      // ── 事件的 `vectorUsed` 恒 `false`（= `routes.vector.ran` 的同一个事实）──
      const flags = readVectorUsed(dbPath);
      expect(flags).toEqual([false]);
    } finally {
      withVectors.close();
      withoutVectors.close();
    }
  });

  it('★ **判别力负控**：同一世界**传**了向量 ⇒ 至少一条 hit 的分数**必须变**（否则上一条是空洞的）', () => {
    const { store } = createFacade();
    try {
      // ⚠️ 两条记忆与查询向量的余弦都很高（0.95 / 0.8）⇒ 向量路只要真的跑起来，
      //   分数**必然**变化（各多出 0.25 × cos）。
      for (const [content, cos] of [
        ['张三住在北京', 0.95],
        ['张三每天喝茶', 0.8],
      ] as const) {
        store.write({ content, embedding: numbersOf(vectorAtCos(cos)), now: NOW });
      }

      const plain = store.recall({ context: TEXT_CONTEXT, explain: true, now: NOW });
      const withVector = store.recall({
        context: TEXT_CONTEXT,
        explain: true,
        now: NOW,
        queryEmbedding: numbersOf(unitVector(0)),
      });

      expect(plain.hits.length).toBe(2);
      const before = new Map(plain.hits.map((hit) => [hit.content, hit.score]));
      const changed = withVector.hits.filter((hit) => before.get(hit.content) !== hit.score);
      // ⚠️ 若接线接错了（两种情况下都没生效），这一条**必红**
      expect(changed.length).toBeGreaterThanOrEqual(1);
      // ── 且方向正确：向量路只会**加分**（缺项记 0，不是减分）──
      for (const hit of changed) {
        expect(hit.score).toBeGreaterThan(before.get(hit.content) as number);
      }
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、B 行：过门槛但分桶未训练 ⇒ 整路缺席，且与「不传」逐字段相同
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · B 行 · 传了但向量路整路缺席（`absent`）⇒ `ran=false` 且输出与不传**逐字段相同**', () => {
  it('★ 过门槛 + 无细桶 ⇒ `mode=absent` ⇒ 传了向量也**什么都没发生**', () => {
    // ⚠️ 门槛压到 2 条：`ROUTER_MIN_TRAINING` 是**参数**（§5），压它不改变被测逻辑，
    //   只是让「过门槛」这件事在测试里可行（默认 10000 条要跑很久）。
    const { store, dbPath } = createFacade({ VECTOR_ROUTER: 'auto', ROUTER_MIN_TRAINING: 2 });
    try {
      for (const content of ['张三住在北京', '张三每天喝茶', '李四喜欢猫粮']) {
        store.write({ content, embedding: numbersOf(vectorAtCos(0.9)), now: NOW });
      }
      // 前提自检：这一库确实是 `absent`（不是 flat_auto、也不是 ivf）
      expect(store.stats(NOW).vectorBackend.mode).toBe('absent');

      const plain = store.recall({ context: TEXT_CONTEXT, explain: true, now: NOW });
      const withVector = store.recall({
        context: TEXT_CONTEXT,
        explain: true,
        now: NOW,
        queryEmbedding: numbersOf(unitVector(0)),
      });

      expect(plain.hits.length).toBe(2);
      // ── 整路缺席：`ran=false` / `candidates=0` ──
      expect(withVector.explain?.routes.vector).toEqual({ ran: false, candidates: 0 });
      // ── 与「不传」逐字段相同（hits / suppressed / diffused）──
      expect(withVector.hits).toEqual(plain.hits);
      expect(withVector.suppressed).toEqual(plain.suppressed);
      expect(withVector.diffused).toEqual(plain.diffused);
      // ── 每条 hit 的缺项值 ──
      for (const hit of withVector.hits) {
        expect(hit.fromVector).toBe(false);
        expect(hit.breakdown?.cos).toBeNull();
        expect(hit.breakdown?.vectorPart).toBe(0);
      }
      // ── 事件的 `vectorUsed` 也必须是 `false`（= `ran` 的同一个事实，不是「传了就算用了」）──
      expect(readVectorUsed(dbPath)).toEqual([false, false]);
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、C 行 / D 行：跑了但零候选 / 命中 N 条
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · D 行 · 传了且命中 ⇒ `cos` / `vectorPart` / `fromVector` 三者照常', () => {
  it('★ `vectorPart === SCORE_WEIGHTS.vectorSim × cos`，且五柱之和 == `score`（误差 ≤ 1e-9）', () => {
    const cos = 0.8;
    const { store } = createWorld(PARAMS, [
      { id: 'v-hit', content: '甲乙丙丁戊己庚辛', vector: vectorAtCos(cos) },
    ]);

    const result = recall(store, {
      context: NO_TEXT_CONTEXT,
      explain: true,
      now: NOW,
      queryEmbedding: numbersOf(unitVector(0)),
    });

    expect(result.explain?.routes.vector).toEqual({ ran: true, candidates: 1 });
    const hit = result.hits.find((item) => item.id === 'v-hit');
    expect(hit, '向量路命中的那条必须进 hits').toBeDefined();
    if (hit === undefined) {
      return;
    }
    // ── `cos` 是**原始余弦**（不是加权后的分项）──
    expect(hit.breakdown?.cos).toBe(Math.fround(cos));
    expect(hit.breakdown?.vectorPart).toBe(SCORE_WEIGHTS.vectorSim * Math.fround(cos));
    expect(hit.fromVector).toBe(true);
    // ── 这条是**纯向量命中**（正文与上下文汉字集不相交 ⇒ 文本路不认它）──
    expect(hit.fromText).toBe(false);
    // ── `rawBm25` 为 `null`（不是 -1.0 哨兵：向量路不产生词法证据）──
    expect(hit.breakdown?.rawBm25).toBeNull();

    const breakdown = hit.breakdown;
    expect(breakdown).toBeDefined();
    if (breakdown === undefined) {
      return;
    }
    const sum =
      breakdown.intensityPart +
      breakdown.vectorPart +
      breakdown.textPart +
      breakdown.graphPart +
      breakdown.recencyPart;
    expect(Math.abs(sum - hit.score)).toBeLessThanOrEqual(1e-9);
  });

  it('★ `cos < VECTOR_MIN_COS` 的候选**不进候选集**（不是「得 0 分」，连 `candidates` 都不计）', () => {
    const belowMin = PARAMS.VECTOR_MIN_COS / 2;
    const aboveMin = PARAMS.VECTOR_MIN_COS + 0.3;
    const { store } = createWorld(PARAMS, [
      { id: 'v-strong', content: '甲乙丙丁戊己庚辛', vector: vectorAtCos(aboveMin) },
      { id: 'v-weak', content: '壬癸壹贰叁肆伍陆', vector: vectorAtCos(belowMin) },
    ]);

    const result = recall(store, {
      context: NO_TEXT_CONTEXT,
      explain: true,
      now: NOW,
      queryEmbedding: numbersOf(unitVector(0)),
    });

    // ── 只有 1 条：弱的**根本没进候选**（若实现「留 0 分」⇒ 这里会是 2）──
    expect(result.explain?.routes.vector).toEqual({ ran: true, candidates: 1 });
    expect(result.hits.map((hit) => hit.id)).toEqual(['v-strong']);
    expect(result.hits.some((hit) => hit.id === 'v-weak')).toBe(false);
  });

  it('★ C 行：传了、跑了，但**一条都没命中**（全部 `cos < MIN`）⇒ `ran=true` / `candidates=0` / `vectorUsed=true`', () => {
    const lowCos = PARAMS.VECTOR_MIN_COS / 2;
    const { db, store } = createWorld(PARAMS, [
      { id: 't-1', content: '张三住在北京', vector: vectorAtCos(lowCos) },
    ]);

    const result = recall(store, {
      context: TEXT_CONTEXT,
      explain: true,
      now: NOW,
      queryEmbedding: numbersOf(unitVector(0)),
    });

    // ── 文本路照常召回（分母不为 0 ⇒ 下面「全 false / 全 null」不是空转）──
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    // ── 三个标志：跑了、但零候选 ──
    expect(result.explain?.routes.vector).toEqual({ ran: true, candidates: 0 });
    for (const hit of result.hits) {
      expect(hit.fromVector).toBe(false);
      expect(hit.breakdown?.cos).toBeNull();
      expect(hit.breakdown?.vectorPart).toBe(0);
    }
    // ── 事件 `vectorUsed === true`（**这就是 C 行与 A/B 行的唯一区别**）──
    expect(readVectorUsedFromDb(db)).toEqual([true]);
  });
});

/** 直接读手建世界的 `events` 表（拿到 `db` 的那一侧不必另开连接）。 */
function readVectorUsedFromDb(db: Database.Database): boolean[] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE type = 'recall' ORDER BY id")
    .all() as Array<{ payload: string }>;
  return rows.map((row) => (JSON.parse(row.payload) as { vectorUsed: boolean }).vectorUsed);
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、闸门顺序（D3：顺序不可换）
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · D3 · 三道过滤的顺序不可换（cos 阈值 → 强度精筛 → 截断）', () => {
  it('★ 「cos 高但已归档」被剔除、「cos 次高且活着」被保留（若先截断再精筛 ⇒ 后者会被切掉）', () => {
    // ⚠️ **`VECTOR_TOPK` 必须压到 1**：否则「先截断」与「先精筛」在两条候选上没有区别
    //   （截断名额 > 候选数 ⇒ 两条都留着）⇒ 这条断言就变成空气。
    const params: Params = { ...PARAMS, VECTOR_TOPK: 1 };
    const { store } = createWorld(params, [
      {
        id: 'archived-high-cos',
        content: '甲乙丙丁戊己庚辛',
        vector: vectorAtCos(0.9),
        // ⚠️ 30 天前 + 稳定度 1 天 ⇒ intensity ≈ e^-30 ≈ 9e-14 << ARCHIVE_LINE(0.05)
        lastAccess: NOW - 30 * DAY,
        stability: 1,
      },
      { id: 'alive-lower-cos', content: '壬癸壹贰叁肆伍陆', vector: vectorAtCos(0.6) },
    ]);

    const result = recall(store, {
      context: NO_TEXT_CONTEXT,
      explain: true,
      now: NOW,
      queryEmbedding: numbersOf(unitVector(0)),
    });

    // ── 保留的是「cos 次高但活着」的那条 ──
    expect(result.explain?.routes.vector).toEqual({ ran: true, candidates: 1 });
    expect(result.hits.map((hit) => hit.id)).toEqual(['alive-lower-cos']);
    // ── 负控：cos 更高的那条**必须不在** hits 里（它已归档）──
    expect(result.hits.some((hit) => hit.id === 'archived-high-cos')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、三路合并（D4：同一个 id 三路各命中一次 ⇒ 只有一条，三个 from* 全 true）
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · D4 · 三路去重（同一条记忆不占两个 topN 名额、不重复喂给 `medianBm25`）', () => {
  it('★ 同一 id 被三路各命中一次 ⇒ 候选集里只有**一条**，三个 `from*` 全 `true`，`rawBm25` 与 `cos` 都在', () => {
    const cos = 0.9;
    const { store } = createWorld(PARAMS, [
      {
        id: 'triple',
        content: '张三住在北京',
        vector: vectorAtCos(cos),
        entityNames: ['张三'],
      },
    ]);

    // 上下文同时命中：正文（FTS）+ 实体（图谱）+ 语义（向量）
    const result = recall(store, {
      context: TEXT_CONTEXT,
      entityNames: ['张三'],
      explain: true,
      now: NOW,
      queryEmbedding: numbersOf(unitVector(0)),
    });

    // ── 只有一条（若三路各留一条 ⇒ 这里会是 3）──
    expect(result.hits.map((hit) => hit.id)).toEqual(['triple']);
    expect(result.explain?.routes.text.candidates).toBe(1);
    expect(result.explain?.routes.graph.candidates).toBe(1);
    expect(result.explain?.routes.vector.candidates).toBe(1);

    const hit = result.hits[0];
    expect(hit).toBeDefined();
    if (hit === undefined) {
      return;
    }
    // ── 三个来源标记都保留（它们只为排障，不参与计算）──
    expect(hit.fromText).toBe(true);
    expect(hit.fromGraph).toBe(true);
    expect(hit.fromVector).toBe(true);
    // ── 两种证据**并存**（不取 max、不平均、不合成）──
    expect(hit.breakdown?.rawBm25).not.toBeNull();
    expect(hit.breakdown?.cos).toBe(Math.fround(cos));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、`includeArchived` 在向量路上是**两件事**（D3 的最后一条）
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · `includeArchived:true` ⇒ 粗筛取消 **且** 强度精筛不执行（两件都要）', () => {
  it('★ 归档记忆进得了向量候选，且它的 `fromVector === true`（只做一件 ⇒ 它仍然进不来）', () => {
    const cos = 0.85;
    const { store } = createWorld(PARAMS, [
      {
        id: 'archived-vec',
        content: '甲乙丙丁戊己庚辛',
        vector: vectorAtCos(cos),
        lastAccess: NOW - 30 * DAY,
        stability: 1,
      },
    ]);

    const options = {
      context: NO_TEXT_CONTEXT,
      explain: true,
      now: NOW,
      queryEmbedding: numbersOf(unitVector(0)),
    };

    // ── 默认（不查归档层）⇒ 被强度精筛剔除 ──
    const excluded = recall(store, options);
    expect(excluded.explain?.routes.vector).toEqual({ ran: true, candidates: 0 });
    expect(excluded.hits.some((hit) => hit.id === 'archived-vec')).toBe(false);

    // ── `includeArchived:true` ⇒ 进得了候选（两件事都生效）──
    const included = recall(store, { ...options, includeArchived: true });
    expect(included.explain?.routes.vector).toEqual({ ran: true, candidates: 1 });
    const hit = included.hits.find((item) => item.id === 'archived-vec');
    expect(hit).toBeDefined();
    expect(hit?.fromVector).toBe(true);
    expect(hit?.breakdown?.cos).toBe(Math.fround(cos));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、D7：`VECTOR_ROUTER='flat'` **且传** ⇒ 必须产出（既有断言的**正控**）
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · D7 · `flat` 不是「不走向量路」的理由（开关是 `queryEmbedding`，不是 `mode`）', () => {
  it('★ 显式 `flat` + 传向量 ⇒ 产出 `fromVector` / `cos` / `vectorPart`（小库也拿得到那 0.25 权重）', () => {
    expect(PARAMS.VECTOR_ROUTER).toBe('flat');
    const cos = 0.75;
    const { store, port } = createWorld(PARAMS, [
      { id: 'flat-vec', content: '甲乙丙丁戊己庚辛', vector: vectorAtCos(cos) },
    ]);
    // 前提自检：端口确实是 flat 后端（不是 ivf）
    expect(port.mode).toBe('flat_explicit');

    const result = recall(store, {
      context: NO_TEXT_CONTEXT,
      explain: true,
      now: NOW,
      queryEmbedding: numbersOf(unitVector(0)),
    });

    expect(result.explain?.routes.vector.ran).toBe(true);
    const hit = result.hits.find((item) => item.id === 'flat-vec');
    expect(hit?.fromVector).toBe(true);
    expect(hit?.breakdown?.cos).toBe(Math.fround(cos));
    expect(hit?.breakdown?.vectorPart).toBe(SCORE_WEIGHTS.vectorSim * Math.fround(cos));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 八、D8：`inhibitionTrace` 与 `recall` 的分数一致性（三条）
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · D8 · `inhibitionTrace` 的 `queryEmbedding`（诊断必须能诊断生产）', () => {
  /** 造一个「有正文可命中 + 有向量」的小世界（trace 只接 context ⇒ 图谱路为空）。 */
  function createTraceWorld(): RecallStore {
    return createWorld(PARAMS, [
      { id: 'd8-a', content: '张三住在北京', vector: vectorAtCos(0.9) },
      { id: 'd8-b', content: '张三每天喝茶', vector: vectorAtCos(0.4) },
    ]).store;
  }

  it('★ 两边传**同一条**向量 ⇒ `baseScore` 与 `Hit.score` **逐位相等**', () => {
    const store = createTraceWorld();
    const queryEmbedding = numbersOf(unitVector(0));

    const traced = inhibitionTrace(store, TEXT_CONTEXT, { now: NOW, queryEmbedding });
    const recalled = recall(store, { context: TEXT_CONTEXT, now: NOW, queryEmbedding });

    expect(recalled.hits.length).toBe(2);
    const traceById = new Map(traced.candidates.map((item) => [item.id, item.baseScore]));
    for (const hit of recalled.hits) {
      expect(traceById.get(hit.id)).toBe(hit.score);
    }
    // ── `selected` 与 hits 同口径（同一段打分代码 + 同一个 topN 钳制）──
    expect(traced.selected.map((item) => item.id)).toEqual(recalled.hits.map((hit) => hit.id));
  });

  it('★ **负控**：只有 recall 传向量 ⇒ `baseScore ≠ Hit.score`，且差额 ∈ `[0, SCORE_WEIGHTS.vectorSim]`', () => {
    const store = createTraceWorld();
    const queryEmbedding = numbersOf(unitVector(0));

    const traced = inhibitionTrace(store, TEXT_CONTEXT, { now: NOW });
    const recalled = recall(store, { context: TEXT_CONTEXT, now: NOW, queryEmbedding });

    expect(recalled.hits.length).toBe(2);
    const traceById = new Map(traced.candidates.map((item) => [item.id, item.baseScore]));

    let sawDifference = false;
    for (const hit of recalled.hits) {
      const baseScore = traceById.get(hit.id);
      expect(baseScore, 'trace 必须覆盖 recall 的每一条候选').toBeDefined();
      if (baseScore === undefined) {
        continue;
      }
      const gap = hit.score - baseScore;
      // ⚠️ 差额**恰好**是那一条的 `0.25 × cos`（∈ [0, 0.25]）—— 这就是 RK-8 说的那个静默分叉
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(SCORE_WEIGHTS.vectorSim + 1e-12);
      if (gap > 0) {
        sawDifference = true;
      }
    }
    // ⚠️ 若 trace 也偷偷用上了向量（或两边的向量路都没生效）⇒ 这一条必红
    expect(sawDifference).toBe(true);
  });

  it('★ **零影响**：`inhibitionTrace(context)`（**不传**向量）在「有向量」与「无向量」两个世界里**逐位相同**', () => {
    const withVectors = createTraceWorld();
    const withoutVectors = createWorld(PARAMS, [
      { id: 'd8-a', content: '张三住在北京', vector: null },
      { id: 'd8-b', content: '张三每天喝茶', vector: null },
    ]).store;

    const tracedWith = inhibitionTrace(withVectors, TEXT_CONTEXT, { now: NOW });
    const tracedWithout = inhibitionTrace(withoutVectors, TEXT_CONTEXT, { now: NOW });

    expect(tracedWith.candidates.length).toBe(2);
    // ⚠️ 「库里有向量」这件事本身**不得**改变 trace 的任何数（不传向量 = 向量路整路缺席）
    expect(tracedWith.candidates).toEqual(tracedWithout.candidates);
    expect(tracedWith.selected).toEqual(tracedWithout.selected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 九、静态断言（D3-b）：回表补齐的 SQL 不得带时间窗、不得带 `embedding`
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · D3-b · 回表补齐 SQL 只做「按 id 取行」这一件事', () => {
  it('★ `WHERE` 里**没有** `last_access`（时间窗的唯一实现是 `search()` 的 `filter`）', () => {
    const whereClause = VECTOR_ENRICH_SQL.slice(VECTOR_ENRICH_SQL.indexOf('WHERE'));
    // 前提自检：真的截到了 WHERE（否则下面两条是在空串上断言 ⇒ 恒绿）
    expect(whereClause.startsWith('WHERE')).toBe(true);
    expect(whereClause).not.toContain('last_access');
    // ── 负控：`deleted = 0` 必须在（候选宇宙的口径不能一起被删掉）──
    expect(whereClause).toContain('deleted = 0');
  });

  it('★ 整条 SQL **不含** `embedding`（≤60 行 × 3KB 的纯搬运）', () => {
    expect(VECTOR_ENRICH_SQL).not.toContain('embedding');
    // ── 负控：该取的五个列都在（否则「不含 embedding」可以靠「什么都不取」达成）──
    for (const column of ['id', 'stability', 'pin_factor', 'last_access', 'created_at']) {
      expect(VECTOR_ENRICH_SQL).toContain(column);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 十、`MemoryStore` 那一侧的装配：**不传向量就不装配**（D2 的「零额外成本」）
// ═══════════════════════════════════════════════════════════════════════════

describe('P2-T10 · 门面装配：只有真的要走向量路时才做四态判定', () => {
  it('★ 不传向量 ⇒ 那一次全表 COUNT **一次都不发生**；传了向量 ⇒ 它必须发生（负控）', () => {
    const { store } = createFacade({ VECTOR_ROUTER: 'auto', ROUTER_MIN_TRAINING: 2 });
    // ⚠️ 数 SQL 用**原型级**拦截：`#db` 是真正的私有字段，外面既拿不到也包不住。
    //   判据是那段**只出现在** `resolveVectorBackendMode()` 里的 COUNT 文本。
    const proto = Database.prototype as unknown as {
      prepare: (this: Database.Database, sql: string) => unknown;
    };
    const originalPrepare = proto.prepare;
    let modeCounts = 0;
    proto.prepare = function patched(this: Database.Database, sql: string): unknown {
      if (sql.includes(MODE_COUNT_SQL_FEATURE)) {
        modeCounts += 1;
      }
      return originalPrepare.call(this, sql);
    };
    try {
      store.write({ content: '张三住在北京', embedding: numbersOf(vectorAtCos(0.9)), now: NOW });

      modeCounts = 0;
      store.recall({ context: TEXT_CONTEXT, now: NOW });
      // ⚠️ 若门面**无条件**装配端口 ⇒ 这里会是 1（每次召回一次全表计数）
      expect(modeCounts).toBe(0);

      // ── 负控：传了向量 ⇒ 这次判定必须发生（证明上面的 0 不是「拦截装置坏了」）──
      store.recall({ context: TEXT_CONTEXT, now: NOW, queryEmbedding: numbersOf(unitVector(0)) });
      expect(modeCounts).toBeGreaterThanOrEqual(1);
    } finally {
      proto.prepare = originalPrepare;
      store.close();
    }
  });

  it('★ 同一条向量连传两次 ⇒ 两次的 `explain` 与 `hits` 逐字段相同（装配无跨调用副作用）', () => {
    const { store } = createFacade({ VECTOR_ROUTER: 'flat' });
    try {
      store.write({ content: '张三住在北京', embedding: numbersOf(vectorAtCos(0.9)), now: NOW });

      const first = store.recall({
        context: TEXT_CONTEXT,
        explain: true,
        now: NOW,
        queryEmbedding: numbersOf(unitVector(0)),
      });
      const second = store.recall({
        context: TEXT_CONTEXT,
        explain: true,
        now: NOW,
        queryEmbedding: numbersOf(unitVector(0)),
      });
      expect(second.explain).toEqual(first.explain);
      expect(second.hits).toEqual(first.hits);
      // ⚠️ 前提自检：这两次真的**走向量路**了（否则「相同」是空洞的）
      expect(first.explain?.routes.vector.ran).toBe(true);
    } finally {
      store.close();
    }
  });
});
