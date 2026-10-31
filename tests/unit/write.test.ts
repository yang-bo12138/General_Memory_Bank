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
import { blobToVector, vectorToBlob } from '../../src/store/merge.js';
import {
  type AliasConflictWarning,
  type WriteStore,
  type WriteWarning,
  compareMergeCandidates,
  write,
} from '../../src/store/write.js';
import { LOG_ACTIONS, MemoryLogger } from '../../src/util/log.js';
import { countRows, createTestStore, readEvents } from '../fixtures/graph-store.js';

/** 测试用的库句柄类型（内存 SQLite）。 */
type TestDb = ReturnType<typeof createTestStore>['db'];

/** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
/** 仓库的 `src/` 目录。 */
const SRC_ROOT = resolve(HERE, '../../src');

/**
 * 把源码里的**注释**与**字符串/模板字符串字面量**挖空（长度不变 ⇒ 下标仍对齐）。
 *
 * ⚠️ **为什么审计器必须先剥它们**：本文件此前踩过同一个坑——
 *   注释里出现的 `ORDER BY bm25(mem_fts) ASC` 会**抢先命中**源码里的 SQL 字面量
 *   ⇒ 断言始终为绿 ⇒ 闸门形同虚设。
 * ⇒ 任何「源码里有没有某个字面量」的判断，都必须只在**代码**上做。
 */
function stripCommentsAndStrings(source: string): string {
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
    // 行注释
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    // 块注释
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    // 字符串 / 模板字符串
    if (char === "'" || char === '"' || char === '`') {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === char) {
          break;
        }
        cursor += 1;
      }
      const stop = Math.min(cursor + 1, source.length);
      blank(index, stop);
      index = stop;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/** 取某个具名函数的**函数体范围**（`{` 到配对的 `}`）；找不到返回 `undefined`。 */
function functionBodyRangeOf(
  code: string,
  name: string,
): { start: number; end: number } | undefined {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(code);
  if (match === null) {
    return undefined;
  }
  const open = code.indexOf('{', match.index);
  if (open === -1) {
    return undefined;
  }
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start: open, end: index };
      }
    }
  }
  return undefined;
}

/** 取某个具名函数的**函数体**文本；找不到返回 `undefined`。 */
function functionBodyOf(code: string, name: string): string | undefined {
  const range = functionBodyRangeOf(code, name);
  return range === undefined ? undefined : code.slice(range.start, range.end + 1);
}

/**
 * 找出源码里**调用** `linkEntityId(...)` 的位置（**排除定义处**）。
 *
 * ⚠️ **必须排除定义处**：`function linkEntityId(` 本身也匹配这个模式
 *   ⇒ 不排除的话，「调用点数量」恒为 1 ⇒ 守卫生效不了。
 */
function findLinkEntityCallSites(source: string): number[] {
  const code = stripCommentsAndStrings(source);
  const sites: number[] = [];
  const pattern = /linkEntityId\s*\(/g;
  let match = pattern.exec(code);
  while (match !== null) {
    const before = code.slice(Math.max(0, match.index - 24), match.index);
    if (!/function\s+$/.test(before)) {
      sites.push(match.index);
    }
    match = pattern.exec(code);
  }
  return sites;
}

/**
 * 落在 `resolveEntities`（= `input.entities` 那条路径）**之外**的 `linkEntityId` 调用点。
 *
 * ⚠️ **为什么这条守的是「关联只由 `entities` 表达」**：
 *   `@linkedEntityIds` 只能由 `resolveEntities` 往里加
 *   ⇒ 别名路径（步骤 1c）一旦也调 `linkEntityId`，就会多出**第二处**能表达
 *   「这条记忆跟 X 有关」的地方 ⇒ §14.3 边界原则 1 就破了。
 */
function linkEntityCallSitesOutsideEntities(source: string): number[] {
  const code = stripCommentsAndStrings(source);
  const range = functionBodyRangeOf(code, 'resolveEntities');
  if (range === undefined) {
    return [];
  }
  return findLinkEntityCallSites(source).filter((site) => site < range.start || site > range.end);
}

/**
 * 在**内存中的源码副本**里，往别名目标解析函数里塞一次 `linkEntityId(...)` 调用。
 *
 * ⚠️ **只改内存副本，不碰磁盘上的 `src/`**：
 *   在测试里就地改源文件会让 CI 跑完之后留下**脏工作树**
 *   （后续提交会把这次变异一起带进去 ⇒ 事故）。
 *
 * ⚠️ **切片用原始源码**（不是剥过注释的副本）：
 *   `stripCommentsAndStrings` **长度不变** ⇒ 下标在原文里同样成立
 *   ⇒ 变异后的副本仍然是「原文件 + 一处改动」，而不是「原文件 + 注释被抹掉」。
 */
function injectAliasTargetLink(source: string): string {
  const code = stripCommentsAndStrings(source);
  const range = functionBodyRangeOf(code, 'resolveAliasTargetEntityId');
  if (range === undefined) {
    return source;
  }
  const body = source.slice(range.start, range.end + 1);
  const mutatedBody = body.replace(
    /\{/,
    '{\n  linkEntityId({ linkedEntityIds: [], seen: new Set<string>() }, name);',
  );
  return source.slice(0, range.start) + mutatedBody + source.slice(range.end + 1);
}

/**
 * `write()` 里 `resolveEntities(...)` 的**实参文本**。
 *
 * ⚠️ 这条守的是「**关联只由 `input.entities` 表达**」的**调用点**那一半：
 *   `resolveEntities` 是**唯一**能往 `@linkedEntityIds` 里加东西的地方
 *   ⇒ 它的实参**只能**是 `input.entities`，**不得**混进 `entityAliases[].name`。
 */
function resolveEntitiesArgs(source: string): string | undefined {
  const code = stripCommentsAndStrings(source);
  const body = functionBodyOf(code, 'write');
  if (body === undefined) {
    return undefined;
  }
  const at = body.indexOf('resolveEntities(');
  if (at === -1) {
    return undefined;
  }
  let depth = 0;
  for (let index = at + 'resolveEntities'.length; index < body.length; index += 1) {
    const char = body[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return body.slice(at + 'resolveEntities('.length, index);
      }
    }
  }
  return undefined;
}

/**
 * 在**内存中的源码副本**里，把 `entityAliases[].name` 混进 `resolveEntities` 的实参
 * （= 模拟「别名目标也算关联」的旧口径）。
 */
function injectAliasNamesIntoEntities(source: string): string {
  const code = stripCommentsAndStrings(source);
  const body = functionBodyOf(code, 'write');
  if (body === undefined) {
    return source;
  }
  const at = code.indexOf(body);
  const mutatedBody = body.replace(
    /input\.entities \?\? \[\]/,
    '[...(input.entities ?? []), ...(input.entityAliases ?? []).map((entry) => entry.name)]',
  );
  return source.slice(0, at) + mutatedBody + source.slice(at + body.length);
}

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

/**
 * 取「别名冲突」那一类 warning（`WriteWarning` 是**可辨识联合** ⇒ 这里做**显式收窄**）。
 *
 * ⚠️ 不用 `as` 断言硬转：那会把「类型收窄」变成「相信类型」⇒ 字段名写错也照样绿。
 */
function aliasConflictOf(warning: WriteWarning | undefined): AliasConflictWarning | undefined {
  return warning !== undefined && warning.code === 'ALIAS_CONFLICT' ? warning : undefined;
}

/**
 * 直接插一条**带向量**的记忆（用于构造「两个候选」的场景）。
 *
 * ⚠️ **为什么不用 `write()` 造候选**：候选的 id 必须**写死**才能比较两次运行的结果
 *   （`write()` 生成随机 UUID ⇒ 两次运行的 id 不同 ⇒ 比不了）。
 */
function insertCandidate(
  db: TestDb,
  id: string,
  content: string,
  tokens: string,
  vector: number[] | null,
): void {
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding,
                           stability, difficulty, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @embedding, 1, 0.5, 0, 0, 0, 0, NULL)`,
  ).run({
    id,
    content,
    tokens,
    hash: `hash-${id}`,
    embedding: vector === null ? null : vectorToBlob(new Float32Array(vector)),
  });
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
    expect(aliasConflictOf(result.warnings[0])?.alias).toBe('老张');
    expect(aliasConflictOf(result.warnings[0])?.currentEntityId).toBe(zhangSanId);
    expect(aliasConflictOf(result.warnings[0])?.intendedEntityId).toBe(zhangSanfengId);

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
    expect(aliasConflictOf(result.warnings[0])?.alias).toBe('张三');
    expect(aliasConflictOf(result.warnings[0])?.currentEntityId).toBe(zhangSanId);
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

// ─────────────────────────────────────────────────────────────
// 裁决 C / D / E / F / G（主理人 2026-10-31 签字）
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 裁决 C：别名目标实体「建，但不隐含关联」', () => {
  it('★ 只给 entityAliases（entities 为空）⇒ 目标实体**被建出来** + 本条记忆**不**关联它 + 回报 ALIAS_TARGET_NOT_LINKED', () => {
    const { db, store, logger } = createWriteContext();

    // ⚠️ `entities` **故意为空**：这条断言守的是「只声明别名」时目标实体仍然要被建出来、
    //   **但不得**与本条记忆建立关联（ADR-P1-T07-DEC 的 D-3/R2「建，但不隐含关联」）。
    const result = write(store, {
      content: '张三住在北京',
      entityAliases: [{ name: '张三', aliases: ['老张'] }],
    });

    const zhangSanId = entityIdOf(db, '张三');
    // 性质：实体被创建（库里只有这一个）——**显式点名的实体不许被静默丢弃**
    expect(countRows(db, 'entities')).toBe(1);
    // 性质：别名挂到了它身上
    const aliasRow = db
      .prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?')
      .get('老张') as {
      entity_id: string;
    };
    expect(aliasRow.entity_id).toBe(zhangSanId);
    // 性质：★ 本条记忆**不**关联它（关联只由 `input.entities` 表达）
    expect(linkedEntityIdsOf(db, result.id)).toEqual([]);
    // 性质：★ write 事件的 `payload.entityIds` **不含**它
    //   ⚠️ 落点是**事件 payload**，不是 `WriteResult`——`WriteResult` 里**没有** `entityIds` 字段。
    const event = readEvents(db, 'write')[0];
    expect(event?.payload.entityIds).toEqual([]);
    // 性质：★ 库里也**没有** `memory_entities` 关联行（不是「事件里没带、库里却建了」）
    expect(countRows(db, 'memory_entities')).toBe(0);

    // 性质：★ `warnings` 里出现 `ALIAS_TARGET_NOT_LINKED`
    //   （**边界可以存在，但必须可观测**：别名建好了、本条记忆却不与它关联
    //   ⇒ 图谱路查不到 ⇒ 静默达不到召回目的 ⇒ 必须回报给调用方）
    const notLinked = result.warnings.filter((w) => w.code === 'ALIAS_TARGET_NOT_LINKED');
    expect(notLinked).toHaveLength(1);
    expect(result.warnings).toContainEqual({
      code: 'ALIAS_TARGET_NOT_LINKED',
      name: '张三',
      entityId: zhangSanId,
    });
    // 性质：★ 磁盘日志里也有（§8.1：两个通道都要）
    const warns = logger.ofLevel('warn');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((line) => line.fields.name === '张三')).toBe(true);

    // ⚠️ **工具自检**：上面的「为空」断言不能是**空断言**——
    //   ⇒ 同一个库里再写一条**带 `entities`** 的记忆 ⇒ 同一个查询必须能查得出关联行。
    //   （否则「查不到」可能只是因为查询写错了，而不是因为真的没关联。）
    const linked = write(store, { content: '张三喜欢喝奶茶', entities: ['张三'] });
    expect(linkedEntityIdsOf(db, linked.id)).toEqual([zhangSanId]);
  });

  it('★ 静态守卫：`linkEntityId` 的**唯一**调用点在 `resolveEntities` 里（关联只由 `entities` 表达）', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'write.ts'), 'utf8');

    // 性质：★ 全文件**恰好一处**调用点（`@linkedEntityIds` 只能由 `entities` 那条路径往里加）
    expect(findLinkEntityCallSites(source)).toHaveLength(1);
    // 性质：★ 别名路径（步骤 1c）**没有**第二处调用点
    expect(linkEntityCallSitesOutsideEntities(source)).toEqual([]);
    // 性质：★ `resolveEntities` 的实参**只有** `input.entities`（不得混进别名目标名）
    expect(resolveEntitiesArgs(source)).toContain('input.entities');
    expect(resolveEntitiesArgs(source) ?? '').not.toContain('entityAliases');

    // ⚠️ **负控 ①**：往**被审对象本身**（`resolveAliasTargetEntityId` 的函数体）里
    //   塞一次 `linkEntityId(...)` 调用 ⇒ 守卫必须立刻改判。
    //   ⇒ 这一步只改**内存中的源码副本**，磁盘上的 `src/` 一个字都不动
    //   （就地改源码会让 CI 留下脏工作树）。
    const mutatedLink = injectAliasTargetLink(source);
    // 变异确实落到被审对象上了（否则下面那条断言就是空断言）
    expect(mutatedLink).not.toBe(source);
    // 性质：★ 守卫在变异后**改判** ⇒ 闸门不是摆设
    expect(findLinkEntityCallSites(mutatedLink)).toHaveLength(2);
    expect(linkEntityCallSitesOutsideEntities(mutatedLink)).toHaveLength(1);

    // ⚠️ **负控 ②**：把 `entityAliases[].name` 混进 `resolveEntities` 的实参
    //   （= 「别名目标也算关联」的旧口径）⇒ 实参守卫必须立刻改判。
    const mutatedArgs = injectAliasNamesIntoEntities(source);
    expect(mutatedArgs).not.toBe(source);
    expect(resolveEntitiesArgs(mutatedArgs) ?? '').toContain('entityAliases');
  });

  it('★ 反向：`entities` 里显式点名 ⇒ 该实体**被关联** + 别名挂到它身上 + **没有新建第二个实体** + **没有** ALIAS_TARGET_NOT_LINKED', () => {
    const { db, store } = createWriteContext();

    // ⚠️ 这条是上一条的**反向用例**：守住「关联**只**由 `entities` 表达」这条边界。
    //   同一个实体名同时出现在 `entities` 与 `entityAliases[].name` 里
    //   ⇒ 它**因 `entities` 而被关联**（不是因别名路径）。
    const result = write(store, {
      content: '张三住在北京',
      entities: ['张三'],
      entityAliases: [{ name: '张三', aliases: ['老张'] }],
    });

    const zhangSanId = entityIdOf(db, '张三');
    // 性质：★ 被关联（走 `input.entities` 那条路径）
    expect(linkedEntityIdsOf(db, result.id)).toEqual([zhangSanId]);
    // 性质：★ write 事件的 `payload.entityIds` 含它
    const event = readEvents(db, 'write')[0];
    expect(event?.payload.entityIds).toEqual([zhangSanId]);
    // 性质：别名挂到了**同一个**实体上
    const aliasRow = db
      .prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?')
      .get('老张') as {
      entity_id: string;
    };
    expect(aliasRow.entity_id).toBe(zhangSanId);
    // 性质：★ **没有新建第二个实体**（别名路径与 `entities` 路径解析到同一个 id）
    expect(countRows(db, 'entities')).toBe(1);
    // 性质：关联行只有一条（不会因两条路径各写一条而重复）
    expect(countRows(db, 'memory_entities')).toBe(1);
    // 性质：★ **没有** `ALIAS_TARGET_NOT_LINKED`
    //   （它**确实**被关联了 ⇒ 边界没发生 ⇒ 不该回报边界）
    expect(result.warnings.filter((w) => w.code === 'ALIAS_TARGET_NOT_LINKED')).toHaveLength(0);
    // 性质：一条 warning 都没有（别名既不冲突、边界也没发生）
    expect(result.warnings).toHaveLength(0);
  });

  it('★ 一个 name 声明多个别名 ⇒ **只产生一条** ALIAS_TARGET_NOT_LINKED（不是每个别名一条）', () => {
    const { db, store } = createWriteContext();

    const result = write(store, {
      content: '张三住在北京',
      entityAliases: [{ name: '张三', aliases: ['老张', '小张'] }],
    });

    // 性质：★ **一条**（报的是「这个实体没跟这条记忆关联」，不是「这两个别名有问题」）
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('ALIAS_TARGET_NOT_LINKED');
    // 性质：两个别名**都**挂上去了（少挂一个才是 bug）
    const zhangSanId = entityIdOf(db, '张三');
    const aliases = db
      .prepare('SELECT alias, entity_id FROM entity_aliases ORDER BY alias')
      .all() as Array<{ alias: string; entity_id: string }>;
    expect(aliases).toEqual([
      { alias: '小张', entity_id: zhangSanId },
      { alias: '老张', entity_id: zhangSanId },
    ]);
  });

  it('★ entityAliases 的 name 指向**别名** ⇒ 解析到同一个 id，不新建第二个实体', () => {
    const { db, store } = createWriteContext();

    write(store, {
      content: '张三住在北京',
      entities: ['张三'],
      entityAliases: [{ name: '张三', aliases: ['老张'] }],
    });
    const entitiesBefore = countRows(db, 'entities');

    // ⚠️ name = 「老张」是**别名** ⇒ a→b 归一必须解析到**同一个**实体（不新建）
    const second = write(store, {
      content: '张三喜欢喝奶茶',
      entities: ['张三'],
      entityAliases: [{ name: '老张', aliases: ['老张头'] }],
    });

    // 性质：「老张头」挂在**张三**这个实体上
    const aliasRow = db
      .prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?')
      .get('老张头') as {
      entity_id: string;
    };
    expect(aliasRow.entity_id).toBe(entityIdOf(db, '张三'));
    // 性质：**没有新建第二个实体**
    expect(countRows(db, 'entities')).toBe(entitiesBefore);
    // 性质：第二条记忆关联到那个实体（**因 `input.entities` 表达**，不是因别名路径）
    expect(linkedEntityIdsOf(db, second.id)).toEqual([entityIdOf(db, '张三')]);
  });
});

describe('P1-T07 · 裁决 D：候选排序是**全序**（四级 tie-break）', () => {
  it('★ 四级排序：overlap 降 → cos 降 → bm25 升 → id 升', () => {
    const base = { id: 'b', overlap: 2, cos: 0.95, bm25: -1.5 };

    // 性质：实体重叠多的优先
    expect(compareMergeCandidates({ ...base, overlap: 3 }, base)).toBeLessThan(0);
    // 性质：重叠相同 ⇒ 余弦大的优先
    expect(compareMergeCandidates({ ...base, cos: 0.99 }, base)).toBeLessThan(0);
    // 性质：余弦也相同 ⇒ BM25 小的优先（BM25 越小越相关）
    expect(compareMergeCandidates({ ...base, bm25: -2 }, base)).toBeLessThan(0);
    // 性质：★ 前三级全同 ⇒ **id 小的优先**（这一级是「可复现」的唯一保证）
    expect(compareMergeCandidates({ ...base, id: 'a' }, base)).toBeLessThan(0);
    // 性质：四键全等 ⇒ 判为「同一个候选」
    expect(compareMergeCandidates(base, { ...base })).toBe(0);
    // 性质：没有向量可比（`-Infinity`）⇒ **排最后**，而不是当成 0
    expect(
      compareMergeCandidates({ ...base, cos: Number.NEGATIVE_INFINITY }, base),
    ).toBeGreaterThan(0);
  });

  it('★ 全序性：id 不同的两个候选**必须**能定出先后（去掉 id 级就会红）', () => {
    const candidates = [
      { id: 'a', overlap: 2, cos: 0.95, bm25: -1.5 },
      { id: 'b', overlap: 2, cos: 0.95, bm25: -1.5 },
      { id: 'c', overlap: 2, cos: 0.95, bm25: -1.5 },
    ];

    for (const a of candidates) {
      for (const b of candidates) {
        if (a.id === b.id) {
          continue;
        }
        const forward = compareMergeCandidates(a, b);
        const backward = compareMergeCandidates(b, a);
        // 性质：**不能判成相同**（否则「先命中谁」取决于遍历顺序 ⇒ 不可复现）
        expect(forward).not.toBe(0);
        // 性质：反对称
        expect(Math.sign(forward)).toBe(-Math.sign(backward));
      }
    }

    // 负控：★ **去掉 id 那一级**的话，两个只有 id 不同的候选就判成「相同」——
    //   ⇒ 这就是「id 级不可省」的证明（也是这条断言会红的原因）。
    const withoutIdLevel = (
      x: (typeof candidates)[number],
      y: (typeof candidates)[number],
    ): number => {
      if (x.overlap !== y.overlap) {
        return y.overlap - x.overlap;
      }
      if (x.cos !== y.cos) {
        return y.cos - x.cos;
      }
      if (x.bm25 !== y.bm25) {
        return x.bm25 - y.bm25;
      }
      return 0;
    };
    expect(withoutIdLevel(candidates[0]!, candidates[1]!)).toBe(0);
  });

  it('★ 行为：两个同分候选（重叠数相同、余弦相同）⇒ 恒定选中同一条，连跑两次一致', () => {
    /** 造一个「两个候选 + 一个新写入」的场景（候选的 id **写死** ⇒ 两次运行完全可比）。 */
    const scenario = (): {
      db: TestDb;
      store: WriteStore;
      params: ReturnType<typeof createTestStore>['params'];
    } => {
      const context = createWriteContext();
      const { db, params } = context;
      const vector = unitVector(params.EMBED_DIM, 0);

      // 两个候选：正文不同（⇒ hash 不同），但**前 3 个 bigram 相同**、向量相同、关联同样的两个实体
      insertCandidate(
        db,
        'mem-a',
        '张三喜欢猫粮和狗粮',
        '张三 三喜 喜欢 欢猫 猫粮 粮和 和狗 狗粮',
        vector,
      );
      insertCandidate(
        db,
        'mem-b',
        '张三喜欢鱼粮和鸟粮',
        '张三 三喜 喜欢 欢鱼 鱼粮 粮和 和鸟 鸟粮',
        vector,
      );
      db.prepare('INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)').run(
        'ent-zhang',
        '张三',
        'concept',
        0,
      );
      db.prepare('INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)').run(
        'ent-li',
        '李四',
        'concept',
        0,
      );
      for (const memoryId of ['mem-a', 'mem-b']) {
        db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
          memoryId,
          'ent-zhang',
        );
        db.prepare('INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(
          memoryId,
          'ent-li',
        );
      }
      return context;
    };

    const first = scenario();
    const firstResult = write(first.store, {
      content: '张三喜欢喝茶',
      entities: ['张三', '李四'],
      embedding: unitVector(first.params.EMBED_DIM, 0),
    });
    // 性质：合并到了**某一条**候选上（不是新建）
    expect(firstResult.merged).toBe(true);
    expect(['mem-a', 'mem-b']).toContain(firstResult.id);
    // 性质：库里仍然只有两条（两条候选 + 新的那条合并进了其中一条）
    expect(countRows(first.db, 'memories')).toBe(2);

    // 性质：★ **连跑两次结果一致**（同样的输入 ⇒ 合并同一条 ⇒ 可复现）
    const second = scenario();
    const secondResult = write(second.store, {
      content: '张三喜欢喝茶',
      entities: ['张三', '李四'],
      embedding: unitVector(second.params.EMBED_DIM, 0),
    });
    expect(secondResult.id).toBe(firstResult.id);
  });
});

describe('P1-T07 · 裁决 E：alias 等于主名（含它自己那个实体的主名）⇒ 冲突', () => {
  it('★ alias 等于**它自己那个实体的主名** ⇒ 跳过 + warnings + 日志，别名表不写', () => {
    const { db, store, logger } = createWriteContext();

    write(store, { content: '张三住在北京', entities: ['张三'] });
    const zhangSanId = entityIdOf(db, '张三');

    const result = write(store, {
      content: '张三喜欢喝奶茶',
      entities: ['张三'],
      entityAliases: [{ name: '张三', aliases: ['张三'] }],
    });

    // 性质：冲突被报出来（**不是**幂等成功）
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('ALIAS_CONFLICT');
    expect(aliasConflictOf(result.warnings[0])?.alias).toBe('张三');
    expect(aliasConflictOf(result.warnings[0])?.currentEntityId).toBe(zhangSanId);
    expect(aliasConflictOf(result.warnings[0])?.intendedEntityId).toBe(zhangSanId);
    // 性质：★ 别名表**没有**写入（主名不许同时当别名）
    const row = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?').get('张三');
    expect(row).toBeUndefined();
    // 性质：记了磁盘日志
    expect(logger.ofLevel('warn').length).toBeGreaterThan(0);
  });
});

describe('P1-T07 · 裁决 F：退化情形（< 2 个 bigram）只有实体重叠能成立', () => {
  it('★ 退化：余弦够高但实体重叠 < 2 ⇒ **不合并**（候选确实被找到了）', () => {
    const { db, store, params } = createWriteContext();
    const vector = unitVector(params.EMBED_DIM, 0);

    write(store, { content: '说好的明天见', entities: ['张三'], embedding: vector, now: 0 });
    const second = write(store, {
      content: '好的',
      entities: ['李四'],
      embedding: vector,
      now: MS_PER_DAY,
    });

    // 性质：★ 候选**确实被找到了**（否则「没合并」可能只是因为压根没候选 ⇒ 测不到退化条款）
    const ftsRows = db
      .prepare('SELECT rowid FROM mem_fts WHERE mem_fts MATCH ?')
      .all('好的') as Array<{
      rowid: number;
    }>;
    expect(ftsRows.length).toBeGreaterThan(0);

    // 性质：**不合并**（退化时 cos 通道不单独成立）
    expect(second.merged).toBe(false);
    expect(countRows(db, 'memories')).toBe(2);
    expect(readEvents(db, 'merge')).toHaveLength(0);
  });

  it('★ 退化：实体重叠 ≥ 2 ⇒ 合并（这时不需要 cos）', () => {
    const { db, store, params } = createWriteContext();
    const vector = unitVector(params.EMBED_DIM, 0);

    write(store, {
      content: '说好的明天见',
      entities: ['张三', '李四'],
      embedding: vector,
      now: 0,
    });
    const second = write(store, {
      content: '好的',
      entities: ['张三', '李四'],
      embedding: vector,
      now: MS_PER_DAY,
    });

    // 性质：合并（实体重叠数达标 ⇒ 证据成立）
    expect(second.merged).toBe(true);
    expect(countRows(db, 'memories')).toBe(1);
  });
});

describe('P1-T07 · 裁决 G：入参越界一律 INVALID_INPUT（details.reason 分类）', () => {
  it('★ confidence 越界 ⇒ INVALID_INPUT，details.reason = confidence', () => {
    const { db, store } = createWriteContext();

    const error = expectMemoryError(() =>
      write(store, { content: '一个事实', entities: ['张三'], confidence: 1.5 }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.reason).toBe('confidence');
    // 性质：库内**没有**这条记录（校验在写库之前）
    expect(countRows(db, 'memories')).toBe(0);
  });

  it('★ kind 不在枚举内 ⇒ INVALID_INPUT，details.reason = kind', () => {
    const { db, store } = createWriteContext();

    const error = expectMemoryError(() =>
      write(store, { content: '一个事实', entities: ['张三'], kind: 'bogus' as never }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.reason).toBe('kind');
    expect(countRows(db, 'memories')).toBe(0);
  });

  it('★ mediaRef 单独给（不给 mediaType）⇒ INVALID_INPUT，details.reason = media', () => {
    const { db, store } = createWriteContext();

    const error = expectMemoryError(() =>
      write(store, { content: '一个事实', entities: ['张三'], mediaRef: 'photo.jpg' }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.reason).toBe('media');
    expect(countRows(db, 'memories')).toBe(0);
  });

  it('★ 负控：emotion 越界是**钳制**不是抛错（别和 confidence 写混）', () => {
    const { db, store } = createWriteContext();

    const result = write(store, { content: '一个事实', entities: ['张三'], emotion: 5 });

    // 性质：写成功了（emotion 按 §4.3 钳制，不抛错）
    expect(result.merged).toBe(false);
    expect(countRows(db, 'memories')).toBe(1);
    // 性质：emotion 被钳到 [0,1]
    const event = readEvents(db, 'write')[0];
    expect(event?.payload.emotion).toBe(1);
  });
});
