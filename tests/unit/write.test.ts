/**
 * P1-T07 · `write()` 的端到端断言 —— DESIGN-v2.md §4.9（四步写入流程）/ §4.3（初始稳定度与难度）。
 *
 * ★ 断言纪律（沿用本仓库的口径）：
 *   · **写性质，不写当次的形状**：数值一律引用 `params`（或由 `params` 推导）；
 *   · **关键断言配反例**：故意写出那个会错的写法，断言它确实会错、而实现不会错；
 *   · **静态扫描类断言必须带负控**：把断言的目标临时改掉 ⇒ 扫描必须报出来。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { EVENT_PAYLOAD_VARIANTS } from '../../src/core/events.types.js';
import { blobToVector } from '../../src/store/merge.js';
import { type WriteStore, write } from '../../src/store/write.js';
import { LOG_ACTIONS, MemoryLogger } from '../../src/util/log.js';
import { countRows, createTestStore, readEvents } from '../fixtures/graph-store.js';

/** 测试用的库句柄类型（内存 SQLite）。 */
type TestDb = ReturnType<typeof createTestStore>['db'];

/** 取出捕获到的 `MemoryError`（失败时给出可读的原因）。 */
function expectMemoryError(fn: () => unknown): MemoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemoryError) {
      return error;
    }
    throw error;
  }
  throw new Error('期望抛出 MemoryError，但没有抛');
}

/** 建一个带日志器的写入上下文（真实 SQLite 内存库）。 */
function createWriteContext(): {
  db: TestDb;
  store: WriteStore;
  params: ReturnType<typeof createTestStore>['params'];
  logger: MemoryLogger;
} {
  const { db, store, params } = createTestStore();
  const logger = new MemoryLogger();
  // ⚠️ `logger` 是 `WriteStore` 的必需成员（§8.1：别名冲突要**同时**记一条磁盘日志）。
  return { db, store: { ...store, logger }, params, logger };
}

/** 造一个单位向量（第 `index` 个分量为 1）。 */
function unitVector(dim: number, index: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  vector[index] = 1;
  return vector;
}

/** 造一个与 `unitVector(dim, 0)` 几乎平行的向量（余弦 ≈ 1）。 */
function nearParallelVector(dim: number, epsilon: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  vector[0] = 1;
  vector[1] = epsilon;
  return vector;
}

/** 读一条记忆的关键列。 */
function readMemoryRow(
  db: TestDb,
  id: string,
): {
  content: string;
  content_tokens: string;
  content_hash: string;
  embedding: Buffer | null;
  stability: number;
  difficulty: number;
  confidence: number;
} {
  return db
    .prepare(
      `SELECT content, content_tokens, content_hash, embedding, stability, difficulty, confidence
         FROM memories WHERE id = ?`,
    )
    .get(id) as {
    content: string;
    content_tokens: string;
    content_hash: string;
    embedding: Buffer | null;
    stability: number;
    difficulty: number;
    confidence: number;
  };
}

/** 读某个实体名对应的 id。 */
function entityIdOf(db: TestDb, name: string): string {
  const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`实体不存在：${name}`);
  }
  return row.id;
}

/** 读某条记忆已关联的实体 id 集合（按 id 升序）。 */
function linkedEntityIdsOf(db: TestDb, memoryId: string): string[] {
  const rows = db
    .prepare('SELECT entity_id FROM memory_entities WHERE memory_id = ? ORDER BY entity_id')
    .all(memoryId) as Array<{ entity_id: string }>;
  return rows.map((row) => row.entity_id);
}

// ─────────────────────────────────────────────────────────────
// §4.9 步骤 2：完全重复
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 完全重复路径（§4.9 步骤 2）', () => {
  it('★ 写相同归一化文本 ⇒ exact === true、库内只有一条、返回的 content 是**库内版本**', () => {
    const { db, store } = createWriteContext();

    // ⚠️ 「ＡＢＣ」（全角）与「abc」（半角）**归一化后同 hash**，但字面不同。
    const first = write(store, { content: 'ＡＢＣ' });
    const second = write(store, { content: 'abc' });

    // 性质：判定为完全重复
    expect(first.exact).toBe(false);
    expect(second.exact).toBe(true);
    expect(second.merged).toBe(true);
    expect(second.id).toBe(first.id);

    // 性质：库内**只有一条**
    expect(countRows(db, 'memories')).toBe(1);

    // 性质：返回的 `content` 是**库内版本**，不是入参
    expect(second.content).toBe('ＡＢＣ');
    expect(second.content).not.toBe('abc');
    expect(readMemoryRow(db, first.id).content).toBe('ＡＢＣ');
  });

  it('★ 完全重复路径**不改写正文**，记的是 touch(exact_repeat) 而不是 write 事件', () => {
    const { db, store } = createWriteContext();

    write(store, { content: '李四养了一只猫', now: 0 });
    write(store, { content: '李四养了一只猫', now: MS_PER_DAY });

    // 性质：正文没被改写（`content_history` 里没有归档 ⇒ 走的是「不改正文」的那条路）
    expect(countRows(db, 'memories')).toBe(1);
    expect(countRows(db, 'content_history')).toBe(0);

    // 性质：事件类型是 `touch`（§8.4 的 touch 行明写它有**两个**发射点），**不是** `write`
    const touchEvents = readEvents(db, 'touch');
    expect(touchEvents).toHaveLength(1);
    expect(touchEvents[0]?.payload.reason).toBe('exact_repeat');
    expect(touchEvents[0]?.payload.id).toBe(touchEvents[0]?.memory_id);

    // 性质：`write` 事件只有第一次写入那一条
    expect(readEvents(db, 'write')).toHaveLength(1);

    // 性质：payload 的键集 = §8.4 的 touch_exact_repeat 字段集
    expect(Object.keys(touchEvents[0]?.payload ?? {}).sort()).toEqual(
      [...(EVENT_PAYLOAD_VARIANTS.touch?.touch_exact_repeat ?? [])].sort(),
    );
  });

  it('★ 完全重复路径**补齐实体关联**并**补写向量**（库内此前无向量）', () => {
    const { db, store, params } = createWriteContext();

    write(store, { content: '李四养了一只猫', entities: ['李四'], now: 0 });
    const repeat = write(store, {
      content: '李四养了一只猫',
      entities: ['李四', '猫粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: MS_PER_DAY,
    });

    // 性质：新实体被补挂上（否则图谱路查不到这层关系：正文没变、强度也加了）
    const catFoodId = entityIdOf(db, '猫粮');
    expect(linkedEntityIdsOf(db, repeat.id)).toContain(catFoodId);
    expect(linkedEntityIdsOf(db, repeat.id)).toHaveLength(2);

    // 性质：向量被补写（此前是 NULL）
    expect(readMemoryRow(db, repeat.id).embedding).not.toBeNull();

    // 性质：事件里如实记录（`addedEntities` / `embeddingAdded` **恒带**）
    const payload = readEvents(db, 'touch')[0]?.payload ?? {};
    expect(payload.addedEntities).toEqual([catFoodId]);
    expect(payload.embeddingAdded).toBe(1);
  });

  it('★ 已有向量时**不覆盖**（跨模型的向量不可比，覆盖后余弦失去意义且不报错）', () => {
    const { db, store, params } = createWriteContext();

    const first = write(store, {
      content: '李四养了一只猫',
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 0,
    });
    write(store, {
      content: '李四养了一只猫',
      embedding: nearParallelVector(params.EMBED_DIM, 0.5),
      now: MS_PER_DAY,
    });

    // 性质：库里仍是**第一次**那个向量（不是第二次那个）
    const stored = readMemoryRow(db, first.id).embedding;
    expect(stored).not.toBeNull();
    expect(Array.from(blobToVector(stored as Buffer))).toEqual(unitVector(params.EMBED_DIM, 0));

    // 性质：事件如实记录「没补写」
    expect(readEvents(db, 'touch')[0]?.payload.embeddingAdded).toBe(0);
  });

  it('★ 完全重复路径按 DEDUP_BOOST 加固，且受 MAX_STABILITY 钳制', () => {
    const { db, store, params } = createWriteContext();

    const first = write(store, { content: '李四养了一只猫', now: 0 });
    // ⚠️ 先把稳定度顶到上限附近 ⇒ 一次合并就该被截断（不许突破上限）。
    db.prepare('UPDATE memories SET stability = ? WHERE id = ?').run(
      params.MAX_STABILITY - 1,
      first.id,
    );

    write(store, { content: '李四养了一只猫', now: MS_PER_DAY * 3 });

    // 性质：被 `MAX_STABILITY` 截断
    expect(readMemoryRow(db, first.id).stability).toBe(params.MAX_STABILITY);
  });
});

// ─────────────────────────────────────────────────────────────
// §4.9 步骤 3：相似检测与合并
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 近似合并（§4.9 步骤 3）', () => {
  it('★ 同义改写（共享实体 ≥ 2）⇒ exact === false 的合并；库内只有一条；旧正文进 content_history', () => {
    const { db, store } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
    });
    const second = write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
    });

    // 性质：判为「合并」而不是「完全重复」
    expect(second.exact).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.id).toBe(first.id);

    // 性质：库内**只有一条**（合并不新建记忆）
    expect(countRows(db, 'memories')).toBe(1);

    // 性质：旧正文进了 `content_history`，`reason = 'merge'`
    const history = db
      .prepare('SELECT memory_id, content, content_tokens, reason FROM content_history')
      .all() as Array<{
      memory_id: string;
      content: string;
      content_tokens: string;
      reason: string;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]?.memory_id).toBe(first.id);
    expect(history[0]?.content).toBe('李四喜欢猫粮和狗粮');
    expect(history[0]?.reason).toBe('merge');
    // 性质：归档的是**旧正文**（新的已成为库内正文）
    expect(readMemoryRow(db, first.id).content).toBe('李四喜欢猫粮以及狗粮');
  });

  it('★ 合并事件是 type=merge，payload 键集与 §8.4 的 merge_3c 字段集逐键一致', () => {
    const { db, store } = createWriteContext();

    write(store, { content: '李四喜欢猫粮和狗粮', entities: ['李四', '猫粮', '狗粮'] });
    write(store, { content: '李四喜欢猫粮以及狗粮', entities: ['李四', '猫粮', '狗粮'] });

    const mergeEvents = readEvents(db, 'merge');
    expect(mergeEvents).toHaveLength(1);
    const payload = mergeEvents[0]?.payload ?? {};

    // 性质：键集**完全等于** §8.4 声明的 `merge_3c` 字段集（不多不少 ⇒ 没有实现点漂移）
    expect(Object.keys(payload).sort()).toEqual(
      [...(EVENT_PAYLOAD_VARIANTS.merge?.merge_3c ?? [])].sort(),
    );

    // 性质：关键字段的值也对
    expect(payload.targetId).toBe(mergeEvents[0]?.memory_id);
    expect(payload.contentText).toBe('李四喜欢猫粮以及狗粮');
    expect(payload.prevContentLength).toBe('李四喜欢猫粮和狗粮'.length);
    expect(payload.contentLength).toBe('李四喜欢猫粮以及狗粮'.length);
    expect(payload.hasEmbedding).toBe(false);
    expect(Array.isArray(payload.addedEntities)).toBe(true);
  });

  it('★ 余弦 ≥ DEDUP_COS_MIN 时也能合并（实体证据不足 ⇒ 向量证据顶上）', () => {
    const { db, store, params } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮',
      entities: ['李四'],
      embedding: unitVector(params.EMBED_DIM, 0),
    });
    const second = write(store, {
      content: '李四喜欢猫粮口味',
      entities: ['李四'],
      embedding: nearParallelVector(params.EMBED_DIM, 0.001),
    });

    // 性质：实体重叠只有 1 个（< DEDUP_ENTITY_MIN），靠余弦判合并
    expect(second.exact).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.id).toBe(first.id);
    expect(countRows(db, 'memories')).toBe(1);
  });

  it('★ 两个证据都不够 ⇒ **不合并**（新建第二条，而不是硬凑）', () => {
    const { db, store } = createWriteContext();

    write(store, { content: '李四喜欢猫粮', entities: ['李四', '猫粮'] });
    const second = write(store, { content: '李四喜欢狗粮', entities: ['李四', '狗粮'] });

    // 性质：实体重叠只有「李四」1 个（< DEDUP_ENTITY_MIN），又没有向量 ⇒ 不合并
    expect(second.merged).toBe(false);
    expect(second.exact).toBe(false);
    expect(countRows(db, 'memories')).toBe(2);
    expect(countRows(db, 'content_history')).toBe(0);
    expect(readEvents(db, 'merge')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// §4.9 步骤 1c：别名同步
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · entityAliases 同步（§4.9 步骤 1c）', () => {
  it('★ 撞已有映射 ⇒ warnings 含 ALIAS_CONFLICT、**不覆盖**已有映射、且记一条磁盘日志', () => {
    const { db, store, logger } = createWriteContext();

    write(store, { content: '张三住在北京', entities: ['张三'] });
    write(store, { content: '张三丰住在北京', entities: ['张三丰'] });
    const zhangSanId = entityIdOf(db, '张三');
    const zhangSanfengId = entityIdOf(db, '张三丰');

    // 把「老张」挂到「张三」名下
    db.prepare('INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run(
      '老张',
      zhangSanId,
    );

    const result = write(store, {
      content: '张三丰喜欢喝奶茶',
      entities: ['张三丰'],
      entityAliases: [{ name: '张三丰', aliases: ['老张'] }],
    });

    // 性质：**调用方看得见**（warnings 是「调用方能看见的通道」）
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('ALIAS_CONFLICT');
    expect(result.warnings[0]?.alias).toBe('老张');
    expect(result.warnings[0]?.currentEntityId).toBe(zhangSanId);
    expect(result.warnings[0]?.intendedEntityId).toBe(zhangSanfengId);

    // 性质：**既有映射没有被覆盖**（覆盖是 `setAlias` 的职责，两处不能统一）
    const row = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?').get('老张') as {
      entity_id: string;
    };
    expect(row.entity_id).toBe(zhangSanId);

    // 性质：**同时**记了一条磁盘日志（只记日志等于静默 ⇒ 两个通道都要）
    const warns = logger.ofLevel('warn');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]?.fields.alias).toBe('老张');
    // 性质：日志里带上了「**本来想挂到谁**」（`want`）——
    //   只有 alias 名字的话，运维看到「老张」不知道该改哪一条 ⇒ 日志等于没用。
    expect(warns[0]?.fields.want).toBe(zhangSanfengId);
    // 性质：日志的 action 是写入（§8.1 的动作词）
    expect(warns[0]?.action).toBe(LOG_ACTIONS.write);
  });

  it('★ 没有别名冲突 ⇒ **一条 warn 都不记**（日志通道不能被噪声淹没）', () => {
    const { db, store, logger } = createWriteContext();

    write(store, { content: '张三住在北京', entities: ['张三'] });
    write(store, { content: '李四住在北京', entities: ['李四'] });

    // 「老张」是**新**别名（库里还没有）⇒ 无冲突 ⇒ 不该报冲突、也不该记日志
    const result = write(store, {
      content: '张三丰喜欢喝奶茶',
      entities: ['张三丰'],
      entityAliases: [{ name: '张三丰', aliases: ['老张'] }],
    });

    // 性质：没有告警
    expect(result.warnings).toHaveLength(0);
    // 性质：**一条 warn 都没有**（否则排障时日志里全是无关噪声）
    expect(logger.ofLevel('warn')).toHaveLength(0);
    // 性质：新别名真的挂上了（挂对了目标实体）
    const row = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?').get('老张') as {
      entity_id: string;
    };
    expect(row.entity_id).toBe(entityIdOf(db, '张三丰'));
  });

  it('★ alias 撞**主名** ⇒ 同样走「跳过 + warnings + 日志」，不静默', () => {
    const { db, store, logger } = createWriteContext();

    write(store, { content: '张三住在北京', entities: ['张三'] });
    write(store, { content: '李四住在北京', entities: ['李四'] });
    const zhangSanId = entityIdOf(db, '张三');

    const result = write(store, {
      content: '李四喜欢喝奶茶',
      entities: ['李四'],
      entityAliases: [{ name: '李四', aliases: ['张三'] }],
    });

    // 性质：主名优先 ⇒ 冲突被报出来
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('ALIAS_CONFLICT');
    expect(result.warnings[0]?.alias).toBe('张三');
    expect(result.warnings[0]?.currentEntityId).toBe(zhangSanId);
    expect(logger.ofLevel('warn').length).toBeGreaterThan(0);

    // 性质：没有把主名写进别名表（那会让 §4.5 的解析顺序出现两个答案）
    const row = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?').get('张三');
    expect(row).toBeUndefined();
  });

  it('★ 无冲突时别名写入成功；同一条再写一次是**幂等**（不报冲突）', () => {
    const { db, store } = createWriteContext();

    write(store, { content: '张三住在北京', entities: ['张三'] });
    const first = write(store, {
      content: '张三喜欢喝奶茶',
      entities: ['张三'],
      entityAliases: [{ name: '张三', aliases: ['老张'] }],
    });
    expect(first.warnings).toHaveLength(0);

    const zhangSanId = entityIdOf(db, '张三');
    const row = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?').get('老张') as {
      entity_id: string;
    };
    expect(row.entity_id).toBe(zhangSanId);

    // 幂等：再写一次同样的别名 ⇒ 指向同一个实体 ⇒ 不算冲突
    const second = write(store, {
      content: '张三喜欢喝咖啡',
      entities: ['张三'],
      entityAliases: [{ name: '张三', aliases: ['老张'] }],
    });
    expect(second.warnings).toHaveLength(0);
  });

  it('★ 别名归一生效：命中别名表的实体名**不会**新建出第二个实体', () => {
    const { db, store } = createWriteContext();

    write(store, {
      content: '张三住在北京',
      entities: ['张三'],
      entityAliases: [{ name: '张三', aliases: ['老张'] }],
    });

    // ⚠️ 「老张」是别名 ⇒ 归一到**同一个**实体（否则图谱路从此分裂）
    const entities = db.prepare('SELECT name FROM entities ORDER BY name').all() as Array<{
      name: string;
    }>;
    expect(entities.map((row) => row.name)).toEqual(['张三']);
    expect(countRows(db, 'entities')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// §4.9 步骤 2：向量校验
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 向量校验（§4.9 步骤 2）', () => {
  it('★ 维度错 / NaN / 全零 ⇒ INVALID_INPUT，details.reason 分别是 dim / nan / zero，**库内无该条记录**', () => {
    const { db, store, params } = createWriteContext();

    const dimError = expectMemoryError(() =>
      write(store, { content: '一个事实', embedding: [1, 2, 3] }),
    );
    expect(dimError.code).toBe('INVALID_INPUT');
    expect(dimError.details.reason).toBe('dim');

    const nanVector = unitVector(params.EMBED_DIM, 0);
    nanVector[0] = Number.NaN;
    const nanError = expectMemoryError(() =>
      write(store, { content: '一个事实', embedding: nanVector }),
    );
    expect(nanError.code).toBe('INVALID_INPUT');
    expect(nanError.details.reason).toBe('nan');

    const zeroError = expectMemoryError(() =>
      write(store, { content: '一个事实', embedding: unitVector(params.EMBED_DIM, 0).fill(0) }),
    );
    expect(zeroError.code).toBe('INVALID_INPUT');
    expect(zeroError.details.reason).toBe('zero');

    // 性质：**库里没有这条记录**（静默降级成 null 会让它此后一直搜不到）
    expect(countRows(db, 'memories')).toBe(0);
    expect(countRows(db, 'events')).toBe(0);
  });

  it('★ 校验失败时**连实体都不建**（整条写入零副作用）', () => {
    const { db, store } = createWriteContext();

    expectMemoryError(() =>
      write(store, { content: '一个事实', entities: ['李四'], embedding: [1] }),
    );

    expect(countRows(db, 'memories')).toBe(0);
    expect(countRows(db, 'entities')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// §4.3：初始稳定度与难度
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 初始稳定度与难度（§4.3）', () => {
  it('★ 初次写入的情绪加成受 MAX_STABILITY 约束（emotion 越界也被钳制）', () => {
    const { db, store, params } = createWriteContext();

    const result = write(store, { content: '一条情绪很强烈的事实', emotion: 100 });

    const stability = readMemoryRow(db, result.id).stability;
    // 性质：情绪**先钳制进 [0,1]**（§4.3：不能假定调用方守规矩），再套上限
    const clampedEmotion = Math.min(1, Math.max(0, 100));
    expect(stability).toBeCloseTo(
      Math.min(
        params.MAX_STABILITY,
        params.INITIAL_STABILITY * (1 + params.EMOTION_WEIGHT * clampedEmotion),
      ),
      12,
    );
    expect(stability).toBeLessThanOrEqual(params.MAX_STABILITY);
  });

  it('★ 「关于李四这是第一条」⇒ DIFFICULTY_FIRST；「李四已有关联记忆」⇒ DIFFICULTY_NORMAL', () => {
    const { db, store, params } = createWriteContext();

    // ⚠️ `confidence = 1` ⇒ 置信度惩罚为 0 ⇒ 难度就是 baseDifficulty 本身
    //   （默认值 0.7 会加上 0.2×(1-0.7) 的惩罚，断言就得写成推导式）。
    const first = write(store, {
      content: '李四养了一只猫',
      entities: ['李四'],
      confidence: 1,
    });
    expect(readMemoryRow(db, first.id).difficulty).toBe(params.DIFFICULTY_FIRST);

    // 性质：李四**已有关联记忆** ⇒ 不再享受首因优待
    const second = write(store, {
      content: '李四喜欢喝奶茶',
      entities: ['李四'],
      confidence: 1,
    });
    expect(readMemoryRow(db, second.id).difficulty).toBe(params.DIFFICULTY_NORMAL);
  });

  it('★ 「新人 + 老友」的记忆**也能**享受首因优待（任一实体首次即可）', () => {
    const { db, store, params } = createWriteContext();

    // 先让「李四」有了一条记忆
    write(store, { content: '李四养了一只猫', entities: ['李四'], confidence: 1 });

    // 这条记忆关于「李四 + 王五」⇒ 王五是新人 ⇒ 仍应享受首因优待
    const mixed = write(store, {
      content: '王五和李四一起去爬山',
      entities: ['李四', '王五'],
      confidence: 1,
    });
    expect(readMemoryRow(db, mixed.id).difficulty).toBe(params.DIFFICULTY_FIRST);

    // ⚠️ 反例：若把判据写成「这些实体**总共**关联 0 条记忆」，
    //   这条记忆会拿到 DIFFICULTY_NORMAL（李四已有记忆）⇒ 上面那行断言变红。
    //   正确判据是「**任一**实体尚无关联记忆」。
  });

  it('★ 低置信度抬高难度（confidence 是它唯一的作用点）', () => {
    const { db, store, params } = createWriteContext();

    const high = write(store, { content: '李四养了一只猫甲', entities: ['李四甲'], confidence: 1 });
    const low = write(store, { content: '李四养了一只猫乙', entities: ['李四乙'], confidence: 0 });

    const highDifficulty = readMemoryRow(db, high.id).difficulty;
    const lowDifficulty = readMemoryRow(db, low.id).difficulty;
    // 性质：置信度越低 ⇒ 难度越高（且上抬量就是 0.2×(1-confidence)）
    expect(lowDifficulty).toBeCloseTo(highDifficulty + 0.2, 12);
    expect(lowDifficulty).toBeGreaterThan(highDifficulty);
    expect(lowDifficulty).toBeLessThanOrEqual(params.DIFFICULTY_NORMAL + 0.2);
  });
});

// ─────────────────────────────────────────────────────────────
// §8.4：write 事件
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 新建事实的事件（§8.4 的 write 行）', () => {
  it('★ 写一条新事实 ⇒ events(type=write)，payload 含 hasEmbedding（**恒带**）', () => {
    const { db, store, params } = createWriteContext();

    const result = write(store, {
      content: '王五养了一只狗',
      entities: ['王五'],
      embedding: unitVector(params.EMBED_DIM, 0),
    });

    const events = readEvents(db, 'write');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload ?? {};

    // 性质：`hasEmbedding` **恒带**（事后能判断「这条为什么没进向量路」）
    expect(Object.prototype.hasOwnProperty.call(payload, 'hasEmbedding')).toBe(true);
    expect(payload.hasEmbedding).toBe(true);
    expect(payload.id).toBe(result.id);
    expect(payload.memory_id).toBeUndefined();
    expect(events[0]?.memory_id).toBe(result.id);

    // 性质：没传向量时也**带**这个键（值是 false）
    write(store, { content: '赵六养了一只兔子' });
    const payloads = readEvents(db, 'write').map((event) => event.payload);
    expect(payloads.every((payload) => 'hasEmbedding' in payload)).toBe(true);
    expect(payloads[1]?.hasEmbedding).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 静态断言：stability 的唯一写入点
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · growStability 仍是全库唯一的 stability 写入点', () => {
  /** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  /** 仓库的 `src/` 目录。 */
  const SRC_ROOT = resolve(HERE, '../../src');

  /** 递归列出目录下的 `.ts` 实现文件（排除测试与声明）。 */
  function listSourceFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
          out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  /**
   * 扫出源码里**真正写 `stability`** 的位置（剥掉注释行）。
   *
   * ⚠️ **必须先剥注释**：正文与代码注释里大量出现这条语句的字面量
   *   （例如「只出现在 growStability 内」这句话本身），
   *   不剥注释的话扫描器会把**说明文字**当成写入点 ⇒ 误报满天飞，闸门就废了。
   */
  function findStabilityWriteSites(source: string): number[] {
    const sites: number[] = [];
    source.split('\n').forEach((rawLine, index) => {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return;
      }
      if (/UPDATE\s+memories\s+SET\s+stability\s*=/i.test(rawLine)) {
        sites.push(index);
      }
    });
    return sites;
  }

  it('★ 写入路径**没有**新增任何一处 stability 写入点（写库的两条路都只经 growStability）', () => {
    const hits: Array<{ file: string; line: number }> = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const index of findStabilityWriteSites(source)) {
        hits.push({
          file: relative(SRC_ROOT, file).split(sep).join('/'),
          line: index + 1,
        });
      }
    }

    // 性质：全仓**恰好一处**（§4.2 的 `growStability`）
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe('store/touch.ts');

    // 性质：写入路径的两个文件**一处都没有**
    expect(hits.some((hit) => hit.file === 'store/write.ts')).toBe(false);
    expect(hits.some((hit) => hit.file === 'store/merge.ts')).toBe(false);
  });

  it('★ 负控：往写入路径里塞一处 stability 写入 ⇒ 扫描必须报出来（闸门不是摆设）', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'write.ts'), 'utf8');

    // ① 注入一个写入点 ⇒ 命中数从 1 变 2
    const injected = `${source}\nexport function anotherWriter(): void {\n  db.prepare('UPDATE memories SET stability = 1 WHERE id = ?');\n}\n`;
    expect(findStabilityWriteSites(injected).length).toBe(
      findStabilityWriteSites(source).length + 1,
    );

    // ② 反过来：把 growStability 里的写入点删掉 ⇒ 命中数变 0 ⇒ 闸门也会判红
    const touchSource = readFileSync(join(SRC_ROOT, 'store', 'touch.ts'), 'utf8');
    const withoutWrite = touchSource
      .split('\n')
      .filter((line) => !/UPDATE\s+memories\s+SET\s+stability\s*=/i.test(line))
      .join('\n');
    expect(findStabilityWriteSites(withoutWrite)).toHaveLength(0);
  });
});
