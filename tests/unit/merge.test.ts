/**
 * P1-T07 · §4.9 步骤 3c 的**原子合并序列** —— DESIGN-v2.md §4.9 / §9.3.0.1（唯一合并写入点）。
 *
 * ★ 断言纪律：
 *   · **写性质，不写当次的形状**：数值一律引用 `params`（或由 `params` 推导）；
 *   · **关键断言配反例**：故意写出那个会错的写法，断言它确实会错、而实现不会错；
 *   · **静态扫描类断言必须带负控**：把断言的目标临时改掉 ⇒ 扫描必须报出来。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { EVENT_PAYLOAD_VARIANTS } from '../../src/core/events.types.js';
import { normalize } from '../../src/core/tokenize.js';
import { blobToVector } from '../../src/store/merge.js';
import { type WriteStore, write } from '../../src/store/write.js';
import { MemoryLogger } from '../../src/util/log.js';
import { createUntrainedBucketContext } from '../fixtures/bucket-store.js';
import { countRows, createTestStore, readEvents } from '../fixtures/graph-store.js';
import { findMembershipWriteSites, stripCommentLines } from '../helpers/bucketWriteScan.js';

/** 测试用的库句柄类型（内存 SQLite）。 */
type TestDb = ReturnType<typeof createTestStore>['db'];

/** 建一个带日志器的写入上下文（真实 SQLite 内存库）。 */
function createWriteContext(): {
  db: TestDb;
  store: WriteStore;
  params: ReturnType<typeof createTestStore>['params'];
  logger: MemoryLogger;
} {
  const { db, store, params } = createTestStore();
  const logger = new MemoryLogger();
  return {
    db,
    // ⚠️ `buckets` 是桶归属上下文（§9.3.0 的唯一写入点）：这里给「**尚未训练**」的
    //   ⇒ 写入路径不会落桶归属（对应「分桶尚未训练 ⇒ 向量路整体缺席」）。
    store: { ...store, logger, buckets: createUntrainedBucketContext(db) },
    params,
    logger,
  };
}

/** 造一个单位向量（第 `index` 个分量为 1）。 */
function unitVector(dim: number, index: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  vector[index] = 1;
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
  last_access: number;
  access_count: number;
} {
  return db
    .prepare(
      `SELECT content, content_tokens, content_hash, embedding, stability, last_access, access_count
         FROM memories WHERE id = ?`,
    )
    .get(id) as {
    content: string;
    content_tokens: string;
    content_hash: string;
    embedding: Buffer | null;
    stability: number;
    last_access: number;
    access_count: number;
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

/** 独立实现一遍「归一化正文的 sha1」（测试不复用实现里的私有函数）。 */
function expectedHash(content: string): string {
  return createHash('sha1').update(normalize(content), 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────
// 静态审计的公共工具（判据②：调用点必须在事务内）
// ─────────────────────────────────────────────────────────────

/**
 * 只保留「代码字符」：**注释与字符串内容**一律替换成空格。
 *
 * ⚠️ **长度不变**（只把非换行字符替成空格）⇒ 替换后的下标仍与原文一一对应
 *   ⇒ 可以拿它做「下标落在某个区间内」的判断（区间来自原文的括号配对）。
 *
 * ⚠️ **为什么连字符串一起剥**：SQL 是模板字符串，里面有 `{` / `}`；
 *   不剥的话花括号配对会数到 SQL 里的括号 ⇒ 区间算错 ⇒ 判据静默失效
 *   （**这种错不会报任何错**，只会让闸门永远绿）。
 *
 * ⚠️ **本项目的 `src/` 里没有正则字面量**（已核）⇒ 扫描器不必处理「正则里的引号」这一族歧义。
 */
function codeOnly(source: string): string {
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
      blank(index, Math.min(cursor + 1, source.length));
      index = Math.min(cursor + 1, source.length);
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * 在「代码文本」里找某个标识符的**调用点**下标。
 *
 * ⚠️ **必须排除定义处**（`function <name>(` / `const <name> =`）——
 *   否则「定义」会被当成「调用」，唯一性判据（只有一个调用点）就永远不成立。
 * ⚠️ **import 不必特判**：`import { a, b } from '…'` 里没有 `(` ⇒ 天然不匹配。
 */
function findCallSites(code: string, name: string): number[] {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  const sites: number[] = [];
  let match = pattern.exec(code);
  while (match !== null) {
    const before = code.slice(Math.max(0, match.index - 40), match.index);
    const isDefinition = /\b(?:function|const|let|var)\s+$/.test(before);
    if (!isDefinition) {
      sites.push(match.index);
    }
    match = pattern.exec(code);
  }
  return sites;
}

/** 从某个 `{` 开始做花括号配对，返回闭合 `}` 的下标（找不到返回 -1）。 */
function matchBrace(code: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** 找出 `function <name>(` 的函数体范围（开/闭大括号下标）；找不到返回 `undefined`。 */
function functionBodyRange(code: string, name: string): { start: number; end: number } | undefined {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(code);
  if (match === null) {
    return undefined;
  }
  const braceIndex = code.indexOf('{', match.index);
  if (braceIndex === -1) {
    return undefined;
  }
  const end = matchBrace(code, braceIndex);
  return end === -1 ? undefined : { start: braceIndex, end };
}

/** 找出 `runWriteTransaction(` 的**回调体**范围（开/闭大括号下标）。 */
function transactionCallbackRange(code: string): { start: number; end: number } | undefined {
  const match = /runWriteTransaction\s*\(/.exec(code);
  if (match === null) {
    return undefined;
  }
  const braceIndex = code.indexOf('{', match.index);
  if (braceIndex === -1) {
    return undefined;
  }
  const end = matchBrace(code, braceIndex);
  return end === -1 ? undefined : { start: braceIndex, end };
}

/** 一处调用点（文件用仓库相对路径）。 */
interface CallSite {
  /** 仓库相对路径（如 `store/write.ts`）。 */
  file: string;
  /** 在「代码文本」里的下标。 */
  index: number;
}

/** 判据②的审计结论。 */
interface BackfillAudit {
  /** 全 `src/` 树里 `backfillEmbeddingIfMissing(...)` 的调用点。 */
  callSites: CallSite[];
  /** 唯一调用点是否落在 `handleExactRepeat` 的函数体内。 */
  insideHandler: boolean;
  /** 全 `src/` 树里 `handleExactRepeat(...)` 的调用点。 */
  handlerCallSites: CallSite[];
  /** `handleExactRepeat` 的调用点是否落在 `runWriteTransaction` 的回调体内。 */
  handlerInsideTransaction: boolean;
}

/**
 * 审计「向量回填是否与 write 在同一事务内」。
 *
 * ⚠️ **为什么是两跳**：`backfillEmbeddingIfMissing(...)` 的**词法位置**在
 *   `handleExactRepeat` 这个**函数体内**（不在 `runWriteTransaction` 的回调体内）
 *   —— 但它在**运行期**是由事务回调调用的 ⇒ 事务性成立。
 *   ⇒ 只做一跳（问「调用点是否在事务体里」）会得到**假红**；
 *     只做零跳（问「调用点是否在 write.ts 里」）又太弱（事务外也能调）。
 *   ⇒ 正确口径是：**调用点 → 所在函数 → 该函数的调用点 → 是否在事务回调体内**。
 *
 * @param sources 仓库相对路径 → 源码全文
 */
function auditBackfill(sources: ReadonlyMap<string, string>): BackfillAudit {
  const codeByFile = new Map<string, string>();
  const callSites: CallSite[] = [];
  const handlerCallSites: CallSite[] = [];

  for (const [file, source] of sources) {
    const code = codeOnly(source);
    codeByFile.set(file, code);
    for (const index of findCallSites(code, 'backfillEmbeddingIfMissing')) {
      callSites.push({ file, index });
    }
    for (const index of findCallSites(code, 'handleExactRepeat')) {
      handlerCallSites.push({ file, index });
    }
  }

  const writeCode = codeByFile.get('store/write.ts') ?? '';
  const handlerRange = functionBodyRange(writeCode, 'handleExactRepeat');
  const txRange = transactionCallbackRange(writeCode);

  const insideHandler =
    callSites.length === 1 &&
    callSites[0]?.file === 'store/write.ts' &&
    handlerRange !== undefined &&
    (callSites[0]?.index ?? -1) > handlerRange.start &&
    (callSites[0]?.index ?? -1) < handlerRange.end;

  const handlerInsideTransaction =
    handlerCallSites.length === 1 &&
    handlerCallSites[0]?.file === 'store/write.ts' &&
    txRange !== undefined &&
    (handlerCallSites[0]?.index ?? -1) > txRange.start &&
    (handlerCallSites[0]?.index ?? -1) < txRange.end;

  return { callSites, insideHandler, handlerCallSites, handlerInsideTransaction };
}

// ─────────────────────────────────────────────────────────────
// §4.9 步骤 3c：合并序列
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 合并序列（§4.9 步骤 3c）', () => {
  it('★ 合并后 content_hash 用步骤 2 的值（**不重算**）⇒ 不撞 idx_mem_hash 唯一约束', () => {
    const { db, store } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: 0,
    });
    const second = write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    // 性质：合并**不新建**记忆（id 不变、行数不变）
    expect(second.id).toBe(first.id);
    expect(countRows(db, 'memories')).toBe(1);

    // 性质：落库的 hash 就是「**新正文归一化后**的 sha1」
    const stored = readMemoryRow(db, first.id);
    expect(stored.content_hash).toBe(expectedHash('李四喜欢猫粮以及狗粮'));
    // ⚠️ 反例：若实现从**原文**（不归一化）重算 hash，这个断言会变红。
    expect(stored.content_hash).not.toBe(expectedHash('李四喜欢猫粮和狗粮'));

    // 性质：合并**没有撞**唯一索引（`idx_mem_hash` 是活的约束，不是摆设）
    const indexRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mem_hash'")
      .get();
    expect(indexRow).toBeDefined();
    let conflicted = false;
    try {
      db.prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash, stability, difficulty, created_at, last_access)
         VALUES ('m-dup', 'fact', 'x', 'x', @hash, 1, 0.5, 0, 0)`,
      ).run({ hash: stored.content_hash });
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
  });

  it('★ 合并时**未传向量** ⇒ 该条 embedding 变 NULL（不是保留旧向量）', () => {
    const { db, store, params } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 0,
    });
    // 性质：合并前确实有向量
    expect(readMemoryRow(db, first.id).embedding).not.toBeNull();

    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    // 性质：合并后向量被**置空**
    // ⚠️ 保留旧向量 = 造出一条「语义指向已不存在的内容」的记录：
    //   向量路会把它捞出来，正文却是另一句话，**不会报任何错**。
    expect(readMemoryRow(db, first.id).embedding).toBeNull();

    // 性质：事件里如实记录「合并后没有向量」
    expect(readEvents(db, 'merge')[0]?.payload.hasEmbedding).toBe(false);
  });

  it('★ 合并时**传了向量** ⇒ 落库的是**新**向量', () => {
    const { db, store, params } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 0,
    });
    const newVector = unitVector(params.EMBED_DIM, 3);
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      embedding: newVector,
      now: MS_PER_DAY,
    });

    const stored = readMemoryRow(db, first.id).embedding;
    expect(stored).not.toBeNull();
    expect(Array.from(blobToVector(stored as Buffer))).toEqual(newVector);
    expect(readEvents(db, 'merge')[0]?.payload.hasEmbedding).toBe(true);
  });

  it('★ 合并后 stability 按 DEDUP_BOOST 增长（useSpacing=false），且被 MAX_STABILITY 截断', () => {
    const { db, store, params } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: 0,
    });
    // 性质：增长倍率**只有** `DEDUP_BOOST`（`useSpacing=false` ⇒ 不叠间隔加成）
    //   ⚠️ 若错用 `useSpacing=true`，这里会多乘一个 `1 + log2(intervalDays)` ⇒ 断言变红。
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY * 3,
    });

    const stored = readMemoryRow(db, first.id);
    expect(stored.stability).toBeCloseTo(params.INITIAL_STABILITY * params.DEDUP_BOOST, 12);
    expect(stored.stability).toBeLessThanOrEqual(params.MAX_STABILITY);

    // 性质：事件里的 `intervalDays` / `boostApplied` / `stabilityDelta` 与库内一致
    const payload = readEvents(db, 'merge')[0]?.payload ?? {};
    expect(payload.intervalDays).toBeCloseTo(3, 12);
    expect(payload.boostApplied).toBe(true);
    expect(payload.stabilityDelta).toBeCloseTo(stored.stability - params.INITIAL_STABILITY, 12);

    // ── 截断：把稳定度顶到上限附近 ⇒ 合并后必须被钳住 ──
    db.prepare('UPDATE memories SET stability = ? WHERE id = ?').run(
      params.MAX_STABILITY - 1,
      first.id,
    );
    write(store, {
      content: '李四喜欢猫粮以及狗粮再来一次',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY * 10,
    });
    expect(readMemoryRow(db, first.id).stability).toBe(params.MAX_STABILITY);
  });

  it('★ 旧正文进 content_history（reason=merge），且归档的是**旧**正文与**旧**分词', () => {
    const { db, store } = createWriteContext();

    const oldContent = '李四喜欢猫粮和狗粮';
    const newContent = '李四喜欢猫粮以及狗粮';
    const first = write(store, {
      content: oldContent,
      entities: ['李四', '猫粮', '狗粮'],
      now: 0,
    });
    write(store, {
      content: newContent,
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    const history = db
      .prepare(
        'SELECT memory_id, content, content_tokens, reason, replaced_at FROM content_history',
      )
      .all() as Array<{
      memory_id: string;
      content: string;
      content_tokens: string;
      reason: string;
      replaced_at: number;
    }>;

    expect(history).toHaveLength(1);
    expect(history[0]?.memory_id).toBe(first.id);
    expect(history[0]?.content).toBe(oldContent);
    expect(history[0]?.reason).toBe('merge');
    // 性质：分词快照也归档了（便于回溯旧版本的可检索性）
    expect(history[0]?.content_tokens).toContain('粮和');
    expect(history[0]?.content_tokens).not.toContain('粮以');
    // 性质：新正文已成为库内正文
    expect(readMemoryRow(db, first.id).content).toBe(newContent);
  });

  it('★ 合并事件 payload 的键集与 §8.4 的 merge_3c 字段集**逐键一致**', () => {
    const { db, store } = createWriteContext();

    write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: 0,
    });
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    const events = readEvents(db, 'merge');
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual(
      [...(EVENT_PAYLOAD_VARIANTS.merge?.merge_3c ?? [])].sort(),
    );
    // 性质：`memory_id` 指向被合并的目标
    expect(events[0]?.memory_id).toBe(events[0]?.payload.targetId);
  });

  it('★ 合并**补齐新实体**（与步骤 2 同一套算法）', () => {
    const { db, store } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮'],
      now: 0,
    });
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    const dogFoodId = entityIdOf(db, '狗粮');
    // 性质：新实体被补挂上
    expect(linkedEntityIdsOf(db, first.id)).toContain(dogFoodId);
    expect(linkedEntityIdsOf(db, first.id)).toHaveLength(3);

    // 性质：事件里的 `addedEntities` 与**实际新增**的行一致（不是重新算一遍）
    expect(readEvents(db, 'merge')[0]?.payload.addedEntities).toEqual([dogFoodId]);
  });

  it('★ FTS 索引由触发器自动同步（合并后搜得到新正文、搜不到旧正文）', () => {
    const { db, store } = createWriteContext();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: 0,
    });
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    // 性质：索引行数与主表行数一致（触发器链可用）
    const ftsCount = (db.prepare('SELECT COUNT(*) AS n FROM mem_fts').get() as { n: number }).n;
    expect(ftsCount).toBe(countRows(db, 'memories'));

    // 性质：新正文的 token 命中，旧正文的 token **不再**命中
    const hitNew = (
      db.prepare('SELECT COUNT(*) AS n FROM mem_fts WHERE mem_fts MATCH ?').get('"粮以"') as {
        n: number;
      }
    ).n;
    const hitOld = (
      db.prepare('SELECT COUNT(*) AS n FROM mem_fts WHERE mem_fts MATCH ?').get('"粮和"') as {
        n: number;
      }
    ).n;
    expect(hitNew).toBe(1);
    expect(hitOld).toBe(0);
    expect(readMemoryRow(db, first.id).content_tokens).toContain('粮以');
  });
});

// ─────────────────────────────────────────────────────────────
// 静态断言：唯一合并写入点（§9.3.0.1）
// ─────────────────────────────────────────────────────────────

describe('P1-T07 · 唯一合并写入点（§9.3.0.1）', () => {
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
   * 扫出「改写 `content` / `content_hash` / `embedding`」的写入点（剥掉注释行）。
   *
   * ⚠️ **必须先剥注释**：正文与代码注释里大量出现这些语句的字面量
   *   （例如「`SET embedding` 只出现在 `merge.ts`」这句话本身），
   *   不剥注释的话扫描器会把**说明文字**当成写入点 ⇒ 误报满天飞，闸门就废了。
   *
   * ⚠️ **`SET content` 的正则不能误伤 `SET content_tokens`**：
   *   `content` 后面必须紧跟（可选空白 + `=`），`content_tokens` 的是 `_` ⇒ 不匹配。
   */
  function findContentWriteSites(source: string): number[] {
    const patterns = [
      /UPDATE\s+memories\s+SET\s+content\s*=/i,
      /UPDATE\s+memories\s+SET\s+content_hash\s*=/i,
      /UPDATE\s+memories\s+SET\s+embedding\s*=/i,
    ];
    const sites: number[] = [];
    source.split('\n').forEach((rawLine, index) => {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return;
      }
      if (patterns.some((pattern) => pattern.test(rawLine))) {
        sites.push(index);
      }
    });
    return sites;
  }

  it('★ 改写 content / content_hash / embedding 的写入点**只在** store/merge.ts', () => {
    const files: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (findContentWriteSites(source).length > 0) {
        files.push(relative(SRC_ROOT, file).split(sep).join('/'));
      }
    }

    // 性质：**唯一**一个文件（§9.3.0.1「全库唯一的合并写入点」）
    expect(files).toEqual(['store/merge.ts']);
  });

  it('★ 负控：把写入点挪到 write.ts ⇒ 扫描必须报出来（闸门不是摆设）', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'write.ts'), 'utf8');

    // ① 注入一个写入点 ⇒ write.ts 也会被扫出来 ⇒ 闸门会判红
    const injected = `${source}\nexport function rogue(): void {\n  db.prepare('UPDATE memories SET content = @c WHERE id = @id');\n}\n`;
    const injectedFiles = listSourceFiles(SRC_ROOT)
      .filter((file) => {
        const text = file.endsWith('write.ts') ? injected : readFileSync(file, 'utf8');
        return findContentWriteSites(text).length > 0;
      })
      .map((file) => relative(SRC_ROOT, file).split(sep).join('/'));
    expect(injectedFiles).toContain('store/write.ts');

    // ② 反过来：把 merge.ts 里的写入点删掉 ⇒ 扫描一个都找不到 ⇒ 闸门也会判红
    const mergeSource = readFileSync(join(SRC_ROOT, 'store', 'merge.ts'), 'utf8');
    const stripped = mergeSource
      .split('\n')
      .filter(
        (line) => !/UPDATE\s+memories\s+SET\s+(content|content_hash|embedding)\s*=/i.test(line),
      )
      .join('\n');
    expect(findContentWriteSites(stripped)).toHaveLength(0);
  });

  it('★ content_history 的 INSERT **不写 id 列**（它是 INTEGER PK AUTOINCREMENT）', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'merge.ts'), 'utf8');

    const match = /INSERT\s+INTO\s+content_history\s*\(([^)]*)\)/i.exec(source);
    expect(match).not.toBeNull();
    const columns = (match?.[1] ?? '')
      .split(',')
      .map((column) => column.trim().toLowerCase())
      .filter((column) => column !== '');

    // 性质：列清单里**没有** `id`
    //   ⚠️ 手写 id 会与自增序列抢号 ⇒ 后续自增撞上历史手写值时直接 UNIQUE 报错。
    expect(columns).not.toContain('id');
    // 性质：确实归档了正文与分词快照
    expect(columns).toEqual(['memory_id', 'content', 'content_tokens', 'replaced_at', 'reason']);
  });

  it('★ 负控：给 content_history 的 INSERT 加上 id 列 ⇒ 检查必须报出来', () => {
    const source = 'INSERT INTO content_history (id, memory_id, content) VALUES (1, 2, 3)';
    const match = /INSERT\s+INTO\s+content_history\s*\(([^)]*)\)/i.exec(source);
    const columns = (match?.[1] ?? '').split(',').map((column) => column.trim().toLowerCase());
    expect(columns).toContain('id');
  });

  it('★ 归档行的 id 是 SQLite 自增出来的（不是手写值）', () => {
    const { db, store } = createWriteContext();

    write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: 0,
    });
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    const row = db.prepare('SELECT id FROM content_history').get() as { id: number };
    // 性质：id 是正整数（自增序列的第一个值 = 1）
    expect(Number.isInteger(row.id)).toBe(true);
    expect(row.id).toBeGreaterThan(0);
    // 性质：自增序列已被使用（`sqlite_sequence` 有该表的记录 ⇒ 不是手写 id）
    const sequence = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'content_history'")
      .get() as { seq: number } | undefined;
    expect(sequence?.seq).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-T03-b · 桶归属纪律（**取代** P1-T07 的「阶段 1 不入桶」豁免）
// ─────────────────────────────────────────────────────────────

/**
 * P2-T03-b · 桶归属**只能**经 `assignBucket` / `unassignBucket` 走（§9.3.0）。
 *
 * ⚠️ **为什么这条断言要「反转」而不是删掉**：P1-T07 的 ADR 冲突 7 裁决是
 *   「阶段 1 照写 `memories.embedding`、**不写** `vector_cell_members`」——
 *   那条豁免**只对阶段 1 有效**；阶段 2 挂接后**豁免本身失效**
 *   ⇒ 断言必须改成守**新**的纪律。
 *   ⚠️ **删掉 = 闸门消失 = 后门无阻力**（这正是 §9.3.0 说的
 *   「注释提醒会漏读、后续新增路径又会忘」的反面教材）。
 *
 * ⚠️ **新纪律是两条，合起来才完整**：
 *   ① **不许写裸的桶表 SQL**（`INSERT INTO` / `UPDATE` / `DELETE FROM vector_cell_members`）
 *      ⇒ 哪怕是 `INSERT OR REPLACE` 也不行（§4.15.5 明写它**不能**替代
 *        「先 DELETE 旧归属、再 INSERT 新归属」）；
 *   ② **必须调 `assignBucket` / `unassignBucket`**（四条路径一条都不能漏）
 *      ⇒ 只守 ① 的话，「谁都不调」也能过闸门。
 */
describe('P2-T03-b · 桶归属只能经 assignBucket / unassignBucket 走', () => {
  /** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  /** 仓库的 `src/store/` 目录。 */
  const STORE_ROOT = resolve(HERE, '../../src/store');
  /** 仓库的 `src/` 目录（对照用）。 */
  const SRC_ROOT = resolve(HERE, '../../src');

  it('★ 静态：write.ts / merge.ts 的**代码**里没有裸的桶表 SQL', () => {
    for (const name of ['write.ts', 'merge.ts']) {
      const source = readFileSync(join(STORE_ROOT, name), 'utf8');

      // 性质：**一条裸写都没有**（写入只允许经 `src/vector/bucketAssign.ts`）
      expect(findMembershipWriteSites(source)).toEqual([]);
    }
  });

  it('★ 静态：write.ts / merge.ts 的**代码**里确实调了 assignBucket / unassignBucket', () => {
    for (const name of ['write.ts', 'merge.ts']) {
      const source = readFileSync(join(STORE_ROOT, name), 'utf8');
      const code = stripCommentLines(source);

      // 性质：**确实调了**（只守「没有裸 SQL」的话，「谁都不调」也能过闸门）
      //   ⚠️ **要求带括号**（`assignBucket(`）：import 行里也有这个词
      //     ⇒ 不带括号会把「只是 import 了」当成「调用了」⇒ 断言假绿。
      expect(code).toMatch(/\bassignBucket\s*\(/);
      expect(code).toMatch(/\bunassignBucket\s*\(/);
    }
  });

  it('★ 负控：注入一个裸 INSERT ⇒ 扫描必须报出来（闸门不是摆设）', () => {
    const source = readFileSync(join(STORE_ROOT, 'write.ts'), 'utf8');

    // ① 注入 ⇒ 剥完注释仍能扫到 ⇒ 闸门会判红
    const injected = `${source}\nexport function rogue(db: Database.Database): void {\n  db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run('a', 'b');\n}\n`;
    expect(findMembershipWriteSites(injected).length).toBeGreaterThan(0);

    // ② 对照：**未注入**的原文扫不到 ⇒ 说明上面命中的确是「注入的那一处」
    expect(findMembershipWriteSites(source)).toEqual([]);
  });

  it('★ 对照：「剥注释」这一步是有效的（说明上面那条不是因为「源码里没这个词」）', () => {
    // ⚠️ `src/vector/ivf.ts` 的**注释**里大量出现 `vector_cell_members`，
    //   而它的**代码**里只有 `SELECT`（合法）⇒ 剥完注释后扫不到。
    const source = readFileSync(join(SRC_ROOT, 'vector', 'ivf.ts'), 'utf8');
    expect(source).toContain('vector_cell_members');
    expect(findMembershipWriteSites(source)).toEqual([]);
  });

  it('★ 分桶**尚未训练**时：向量写进库了、桶表一条不写，**而且写路径记了日志**', () => {
    const { db, store, params, logger } = createWriteContext();

    write(store, {
      content: '李四喜欢猫粮',
      entities: ['李四', '猫粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 0,
    });

    // 性质：向量**真的落库了**（不是「不写向量」）
    const withVector = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL AND deleted = 0')
      .get() as { n: number };
    expect(withVector.n).toBe(1);

    // 性质：桶表**一条都没有**
    //   ⚠️ **原因变了**：不是「阶段 1 不入桶」（那条豁免已退役），
    //   而是「**分桶尚未训练**」⇒ 没有可归属的桶（§4.15.3）。
    expect(countRows(db, 'vector_cell_members')).toBe(0);

    // 性质：★ **可观测**（§9.3.2 ① 的静默失效点不能静默）
    //   ⇒ 「库里有向量、桶侧无归属」这件事必须留下一条日志
    //     ⇒ 否则它就是那个「静默、永久、不报错」的失效点。
    const warns = logger.ofLevel('warn');
    expect(warns.some((line) => line.fields.reason === 'bucket-not-trained')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 判据②（QA 复核 P1-T07 收窄）：向量回填的调用点必须在 write 的**同一事务内**
// ─────────────────────────────────────────────────────────────

/**
 * P1-T07 · 判据②（可机器检）。
 *
 * ⚠️ **为什么要有这条**：§4.9 步骤 2 的向量回填「必须与本次写入同事务」
 *   —— 若它在事务外执行，则「回填成功但本次写入回滚」⇒ 库里留下一条
 *   **不属于任何一次成功写入**的向量（且不报任何错）。
 *   ⇒ 这条判据从「口头约定」升级为「扫描器守着的断言」。
 *
 * ⚠️ **判据是两跳的**（理由见 `auditBackfill` 的注释）：
 *   `backfillEmbeddingIfMissing(...)` 的词法位置在 `handleExactRepeat` 函数体内，
 *   而 `handleExactRepeat(...)` 由 `write()` 的 `runWriteTransaction` 回调调用
 *   ⇒ 运行期在同一事务内。
 */
describe('P1-T07 · 判据②：向量回填与 write 在同一事务内', () => {
  /** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  /** 仓库的 `src/` 目录。 */
  const SRC_ROOT = resolve(HERE, '../../src');

  /**
   * 收集 `src/` 下**全部实现文件**（排除测试与声明）⇒ 相对路径 → 源码全文。
   *
   * ⚠️ **必须排除 `*.test.ts`**：`src/` 里有 `params.test.ts` / `flags.test.ts`
   *   等测试文件，它们会直接调用被审计的函数 ⇒ 混进来会把「唯一调用点」判据弄假红。
   */
  function collectSources(): Map<string, string> {
    const sources = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts') || full.endsWith('.test.ts') || full.endsWith('.d.ts')) {
          continue;
        }
        sources.set(relative(SRC_ROOT, full).split(sep).join('/'), readFileSync(full, 'utf8'));
      }
    };
    walk(SRC_ROOT);
    return sources;
  }

  it('★ 回填的**唯一**调用点在 handleExactRepeat 内，而它由事务回调调用', () => {
    const audit = auditBackfill(collectSources());

    // 性质：全 `src/` 树里 `backfillEmbeddingIfMissing(...)` **只有一个调用点**
    //   （定义处不算；import 不算）⇒ 不会出现「事务外也有一处在调」的漏网。
    expect(audit.callSites).toHaveLength(1);
    expect(audit.callSites[0]?.file).toBe('store/write.ts');

    // 性质：它在 `handleExactRepeat` 的函数体内
    expect(audit.insideHandler).toBe(true);

    // 性质：`handleExactRepeat(...)` 也**只有一个**调用点，且落在 `runWriteTransaction` 的回调体内
    //   ⇒ 运行期：回填与本次写入同事务。
    expect(audit.handlerCallSites).toHaveLength(1);
    expect(audit.handlerInsideTransaction).toBe(true);
  });

  it('★ 负控：把回填调用挪到事务外 ⇒ 判据②必须报出来（闸门不是摆设）', () => {
    const sources = collectSources();
    const original = sources.get('store/write.ts') ?? '';

    // 注入一个模块顶层的调用（不在任何事务内）
    const injected = `${original}\nexport function rogue(): void {\n  backfillEmbeddingIfMissing(db, 'id', null);\n}\n`;
    const audit = auditBackfill(new Map(sources).set('store/write.ts', injected));

    // 性质：「唯一调用点」不再成立 ⇒ 判据会红
    expect(audit.callSites).toHaveLength(2);
    // 性质：注入的那个不在 `handleExactRepeat` 体内 ⇒ 事务性判据也会红
    expect(audit.insideHandler).toBe(false);
  });

  it('★ 负控：把 handleExactRepeat 的调用挪到事务外 ⇒ 判据②必须报出来', () => {
    const sources = collectSources();
    const original = sources.get('store/write.ts') ?? '';

    // 注入一个模块顶层的 `handleExactRepeat(...)` 调用（绕过事务回调）
    const injected = `${original}\nexport function rogue(): void {\n  handleExactRepeat(store, m, ctx);\n}\n`;
    const audit = auditBackfill(new Map(sources).set('store/write.ts', injected));

    // 性质：`handleExactRepeat` 的调用点不再唯一
    expect(audit.handlerCallSites).toHaveLength(2);
    // 性质：事务性判据判红
    expect(audit.handlerInsideTransaction).toBe(false);
  });

  it('★ 工具自检：注释与字符串被正确剥离（否则整套静态判据都是假绿）', () => {
    const sample = [
      "const sql = 'SELECT {a} FROM t';",
      '// 注释里的 handleExactRepeat( 应当被剥掉',
      '/* 块注释里的 backfillEmbeddingIfMissing( 也应当被剥掉 */',
      'const real = handleExactRepeat(store, m, ctx);',
    ].join('\n');

    const code = codeOnly(sample);
    // 性质：字符串内容没了
    expect(code).not.toContain('SELECT');
    // 性质：注释里的字面量没了
    expect(code).not.toContain('注释里的');
    expect(code).not.toContain('块注释里的');
    // 性质：只出现在注释里的那个名字也没了（它只写在注释里）
    expect(code).not.toContain('backfillEmbeddingIfMissing');
    // 性质：**代码**里的那一个还在，且**只有一个**调用点
    expect(findCallSites(code, 'handleExactRepeat')).toHaveLength(1);
    // 性质：长度不变（下标仍与原文对齐）
    expect(code).toHaveLength(sample.length);
  });
});

// ─────────────────────────────────────────────────────────────
// §4.9 步骤 3a：候选查询的口径（前 3 个 bigram + `bm25 ASC LIMIT 3`）
// ─────────────────────────────────────────────────────────────

/** 候选查询 SQL 的审计结论。 */
interface CandidateSqlVerdict {
  /** 是否走 FTS 全文检索（`MATCH @dedupSql`），而不是 `LIKE` 扫描。 */
  usesMatch: boolean;
  /** 是否显式 `ORDER BY bm25(mem_fts) ASC`（BM25 升序 = 最相关的在前）。 */
  bm25Asc: boolean;
  /** 是否 `LIMIT 3`（候选面固定为 3，§4.9 的「代价段」）。 */
  limitThree: boolean;
}

/** 审计一段候选查询 SQL 是否符合 §4.9 步骤 3a 的口径。 */
function auditCandidateSql(sql: string): CandidateSqlVerdict {
  return {
    usesMatch: /MATCH\s+@dedupSql/i.test(sql),
    bm25Asc: /ORDER\s+BY\s+bm25\(\s*mem_fts\s*\)\s+ASC/i.test(sql),
    limitThree: /LIMIT\s+3\b/i.test(sql),
  };
}

/**
 * 从 `write.ts` 里抠出 `FIND_CANDIDATES_SQL` 的模板字面量内容。
 *
 * ⚠️ **必须抠出字面量再判**：直接对整份源码做正则，会被**注释里的话**满足
 *   （例如「不要写 `ORDER BY bm25(mem_fts) ASC`」这句话本身就是那个形状）
 *   ⇒ 断言会永远绿，却什么都没守住。
 */
function extractCandidateSql(source: string): string {
  const match = /const\s+FIND_CANDIDATES_SQL\s*=\s*`([\s\S]*?)`;/.exec(source);
  return match?.[1] ?? '';
}

describe('P1-T07 · 步骤 3a 的候选查询口径', () => {
  /** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  /** 仓库的 `src/` 目录。 */
  const SRC_ROOT = resolve(HERE, '../../src');

  it('★ 候选只取**前 3 个 bigram**：后段 bigram 相同的两条**不合并**', () => {
    const { db, store } = createWriteContext();

    // 第一条：bigram = 我爱 / 爱北 / 北京 / 京天 / 天安 / 安门
    const first = write(store, {
      content: '我爱北京天安门',
      entities: ['张三', '李四'],
      now: 0,
    });
    // 第二条：bigram = 我们 / 们去 / 去看 / 看北 / 北京 / 京天 / 天安 / 安门
    //   ⇒ 它与第一条**共享后段**（北京/京天/天安/安门），
    //     但**前 3 个 bigram 一条都不在第一条里** ⇒ 不是候选 ⇒ 不该合并。
    const second = write(store, {
      content: '我们去看北京天安门',
      entities: ['张三', '李四'],
      now: MS_PER_DAY,
    });

    // 性质：**没有合并**（否则说明查询用的是后段 bigram 或全量 bigram）
    expect(second.merged).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(countRows(db, 'memories')).toBe(2);
  });

  it('★ 前 3 个 bigram **全中** ⇒ 成为候选 ⇒ 合并（窗口不是更宽的）', () => {
    const { db, store } = createWriteContext();

    // 第一条：bigram = 我爱 / 爱北 / 北京 / 京天 / 天安 / 安门
    const first = write(store, {
      content: '我爱北京天安门',
      entities: ['张三', '李四'],
      now: 0,
    });
    // 第二条：bigram = 我爱 / 爱北 / 北京 / 京上 / 上海 / 海故 / 故宫
    //   ⇒ **前 3 个全在第一条里** ⇒ 第一条是候选 ⇒ 合并。
    //   ⇒ 这条断言同时钉住了「窗口 ≤ 3」：若查询要求第 4 个及以后的 bigram，
    //     第一条就不该是候选 ⇒ 不会合并 ⇒ 本条会红。
    const second = write(store, {
      content: '我爱北京上海故宫',
      entities: ['张三', '李四'],
      now: MS_PER_DAY,
    });

    // 性质：合并（实体重叠数 ≥ `DEDUP_ENTITY_MIN` ⇒ 证据成立）
    expect(second.merged).toBe(true);
    expect(second.exact).toBe(false);
    expect(second.id).toBe(first.id);
    expect(countRows(db, 'memories')).toBe(1);
  });

  it('★ 静态：候选 SQL 写死 `MATCH` + `bm25 ASC` + `LIMIT 3`，且**不复用** buildMatchQuery', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'write.ts'), 'utf8');

    const verdict = auditCandidateSql(extractCandidateSql(source));
    // 性质：走 FTS 全文检索
    expect(verdict.usesMatch).toBe(true);
    // 性质：显式按 BM25 升序（**不是**隐式的 rowid 顺序）
    expect(verdict.bm25Asc).toBe(true);
    // 性质：候选面固定为 3
    expect(verdict.limitThree).toBe(true);

    // 性质：**不复用** `buildMatchQuery`
    //   （它内部会再 tokenize 一次 ⇒ 把已切好的 bigram 串当输入是「二次分词」
    //     ⇒ 去重条件变成不可预测的东西，且不报错）
    expect(codeOnly(source)).not.toContain('buildMatchQuery');
  });

  it('★ 负控：把 LIMIT / bm25 排序 / buildMatchQuery 改掉 ⇒ 检查必须报出来', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'write.ts'), 'utf8');
    const sql = extractCandidateSql(source);

    // ① 候选面放大到 50 ⇒ 必须被抓
    //   ⚠️ **改的是抠出来的 SQL，不是整份源码**：源码里 `ORDER BY bm25(mem_fts) ASC`
    //     这个形状**先出现在注释里**（`String.replace` 只换第一处）⇒ 改注释等于没改。
    expect(auditCandidateSql(sql.replace('LIMIT 3', 'LIMIT 50')).limitThree).toBe(false);

    // ② 排序改成 rowid（等价于没有 BM25 排序）⇒ 必须被抓
    expect(
      auditCandidateSql(sql.replace('ORDER BY bm25(mem_fts) ASC', 'ORDER BY m.rowid')).bm25Asc,
    ).toBe(false);

    // ③ 复用 `buildMatchQuery` ⇒ 必须被抓
    const reused = `${source}\nconst q = buildMatchQuery(tokens);\n`;
    expect(codeOnly(reused)).toContain('buildMatchQuery');
  });
});
