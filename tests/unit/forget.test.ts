/**
 * `forget()` 的单测 —— DESIGN-v2.md §4.8（软删 / 硬删 / 正文脱敏），对应 **P4-T02**。
 *
 * ★ 断言纪律（沿用仓库惯例）：
 *   · 每条硬断言配一条**反例**：反例是「故意造出那个会错的状态」，
 *     断言实现**不让它发生**（例：坏 JSON 的 payload 会让朴素的脱敏 SQL 抛错 ⇒ 断言遗忘仍成功）。
 *   · 静态扫描类的断言**不能自匹配**（脚本里出现的串会让「只出现一次」永远为假）
 *     ⇒ 用拼接构造 needle，并在注释里写明为什么。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import { EventWriter } from '../../src/store/events.js';
import { type ForgetStore, forget } from '../../src/store/forget.js';
import { REDACTION_PLACEHOLDER } from '../../src/store/redact.js';
import { MemoryLogger } from '../../src/util/log.js';

const P: Params = DEFAULT_PARAMS;
const T0 = 1_700_000_000_000;
const NOW = T0 + 86_400_000;

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Fixture {
  db: Database.Database;
  store: ForgetStore;
  id: string;
}

/**
 * 建库 + 一条记忆 + 关联实体 / 正文历史 / 一条边 + 两条带正文的事件。
 */
function makeStore(seed: { deleted?: boolean; readonly?: boolean } = {}): Fixture {
  const id = 'm1';
  const deleted = seed.deleted === true;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare(
    `INSERT INTO memories (
       id, kind, content, content_tokens, content_hash, stability, difficulty, pin_factor,
       created_at, last_access, access_count, deleted, deleted_at
     ) VALUES (
       @id, 'fact', @content, @tokens, @hash, 2.0, 0.5, 1.0, @t0, @t0, 3, @deleted, @deletedAt
     )`,
  ).run({
    id,
    content: '她不喜欢猫粮',
    tokens: '她不 不喜 喜欢 欢猫 猫粮',
    hash: 'hash-m1',
    t0: T0,
    deleted: deleted ? 1 : 0,
    deletedAt: deleted ? T0 : null,
  });

  // 实体 + 关联
  db.prepare(
    `INSERT INTO entities (id, name, type, created_at) VALUES ('e1', '她', 'person', @t0)`,
  ).run({ t0: T0 });
  db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES (@id, 'e1')`).run({ id });

  // 正文历史
  db.prepare(
    `INSERT INTO content_history (memory_id, content, content_tokens, reason, replaced_at)
     VALUES (@id, '她喜欢猫粮', '她喜 喜欢 欢猫 猫粮', 'merge', @t0)`,
  ).run({ id, t0: T0 });

  // 一条边（证据指向这条记忆）
  db.prepare(
    `INSERT INTO entities (id, name, type, created_at) VALUES ('e2', '猫粮', 'thing', @t0)`,
  ).run({ t0: T0 });
  db.prepare(
    `INSERT INTO edges (id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
     VALUES ('edge1', 'e1', '不喜欢', 'e2', @id, 0.8, @t0, @t0)`,
  ).run({ id, t0: T0 });

  // 两条带正文的事件（write / manual_fix）
  db.prepare(
    `INSERT INTO events (type, memory_id, payload, at)
     VALUES ('write', @id, json_object('id', @id, 'contentText', '她喜欢猫粮'), @t0)`,
  ).run({ id, t0: T0 });
  db.prepare(
    `INSERT INTO events (type, memory_id, payload, at)
     VALUES ('manual_fix', @id, json_object('id', @id, 'contentText', '她不喜欢猫粮'), @t0)`,
  ).run({ id, t0: T0 });

  const events = new EventWriter(db, {
    readonly: seed.readonly === true,
    logger: new MemoryLogger(),
    now: () => NOW,
  });
  return { db, store: { db, params: P, events }, id };
}

/** 记忆行还在吗？ */
function memoryExists(db: Database.Database, id: string): boolean {
  return db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id) !== undefined;
}

/** 读出某列（行不存在则抛）。 */
function readState(
  db: Database.Database,
  id: string,
): { deleted: number; deletedAt: number | null; content: string } {
  return db
    .prepare('SELECT deleted, deleted_at AS deletedAt, content FROM memories WHERE id = ?')
    .get(id) as { deleted: number; deletedAt: number | null; content: string };
}

/** 读出全部事件 payload（已解析）。 */
function readEvents(
  db: Database.Database,
): Array<{ type: string; payload: Record<string, unknown> }> {
  return (
    db.prepare('SELECT type, payload FROM events ORDER BY id').all() as Array<{
      type: string;
      payload: string;
    }>
  ).map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

describe('forget · 软删（默认路径）', () => {
  it('软删：deleted=1 / deleted_at 落库，**正文与历史全部保留**', () => {
    const { db, store, id } = makeStore();
    try {
      forget(store, id, {}, NOW);

      const state = readState(db, id);
      expect(state.deleted).toBe(1);
      expect(state.deletedAt).toBe(NOW);
      // ★ 正文仍在（「软删不处置任何正文」）
      expect(state.content).toBe('她不喜欢猫粮');
      expect(
        db.prepare('SELECT count(*) AS n FROM content_history WHERE memory_id = ?').get(id),
      ).toEqual({ n: 1 });
      expect(
        db.prepare('SELECT count(*) AS n FROM memory_entities WHERE memory_id = ?').get(id),
      ).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  it('★ 软删事件 payload：`hard: false` 且**不带** `auditContentRetained`', () => {
    const { db, store, id } = makeStore();
    try {
      forget(store, id, {}, NOW);
      const forgetEvents = readEvents(db).filter((event) => event.type === 'forget');
      expect(forgetEvents).toHaveLength(1);
      expect(forgetEvents[0]?.payload).toEqual({ id, hard: false });
      // ★ 反例：带了这个键就等于「记了一条没发生的事」（软删不处置正文）
      expect(
        Object.prototype.hasOwnProperty.call(forgetEvents[0]?.payload, 'auditContentRetained'),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it('★ 软删幂等：重复软删 ⇒ `deleted_at` **不被推后**，且不再记事件', () => {
    const { db, store, id } = makeStore();
    try {
      forget(store, id, {}, NOW);
      // 第二天用户又点了一次「忘掉」
      forget(store, id, {}, NOW + 10 * 86_400_000);

      expect(readState(db, id).deletedAt).toBe(NOW);
      expect(readEvents(db).filter((event) => event.type === 'forget')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('不存在 ⇒ NOT_FOUND（且不写任何东西）', () => {
    const { db, store } = makeStore();
    try {
      let caught: MemoryError | undefined;
      try {
        forget(store, 'nope', {}, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.NOT_FOUND);
      expect(readEvents(db)).toHaveLength(2); // 只有夹具的两条
    } finally {
      db.close();
    }
  });

  it('只读实例 ⇒ READONLY_VIOLATION（即使只是一次软删）', () => {
    const { db, store, id } = makeStore({ readonly: true });
    try {
      let caught: MemoryError | undefined;
      try {
        forget(store, id, {}, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.READONLY_VIOLATION);
      expect(readState(db, id).deleted).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('forget · 硬删', () => {
  it('硬删：行没了；关联 / 历史由 FK 级联清理；FTS 由触发器同步；边保留但 memory_id 变 NULL', () => {
    const { db, store, id } = makeStore();
    try {
      forget(store, id, { hard: true }, NOW);

      expect(memoryExists(db, id)).toBe(false);
      expect(
        db.prepare('SELECT count(*) AS n FROM memory_entities WHERE memory_id = ?').get(id),
      ).toEqual({
        n: 0,
      });
      expect(
        db.prepare('SELECT count(*) AS n FROM content_history WHERE memory_id = ?').get(id),
      ).toEqual({
        n: 0,
      });
      // ★ FTS 同步（触发器 mem_ad）——**不是**手动 DELETE 的结果
      expect(db.prepare('SELECT count(*) AS n FROM mem_fts').get()).toEqual({ n: 0 });
      // ★ 边保留、证据指针置空（关系比单条证据更长寿）
      expect(
        db.prepare(`SELECT memory_id AS memoryId FROM edges WHERE id = 'edge1'`).get(),
      ).toEqual({
        memoryId: null,
      });
      // ★ 外键真的一直开着
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('★ 硬删脱敏：事件里的正文变占位串，**结构性字段保留**', () => {
    const { db, store, id } = makeStore();
    try {
      forget(store, id, { hard: true }, NOW);

      const withContent = readEvents(db).filter(
        (event) => typeof event.payload.contentText === 'string',
      );
      // 两条旧事件 + 一条 forget（forget 不带 contentText）⇒ 两条被脱敏
      expect(withContent).toHaveLength(2);
      for (const event of withContent) {
        expect(event.payload.contentText).toBe(REDACTION_PLACEHOLDER);
        // ★ `id` 这类结构性字段不能被「顺手」清掉（重放要按它归位）
        expect(event.payload.id).toBe(id);
      }
    } finally {
      db.close();
    }
  });

  it('keepAuditContent: true ⇒ 保留原文，并在事件里记 `auditContentRetained: true`', () => {
    const { db, store, id } = makeStore();
    try {
      forget(store, id, { hard: true, keepAuditContent: true }, NOW);

      const kept = readEvents(db).filter((event) => typeof event.payload.contentText === 'string');
      expect(kept.map((event) => event.payload.contentText)).toEqual([
        '她喜欢猫粮',
        '她不喜欢猫粮',
      ]);
      const forgetEvent = readEvents(db).find((event) => event.type === 'forget');
      expect(forgetEvent?.payload).toEqual({ id, hard: true, auditContentRetained: true });
    } finally {
      db.close();
    }
  });

  it('★ 反例：坏 JSON 的 payload 不许让「遗忘」中断', () => {
    const { db, store, id } = makeStore();
    try {
      // 一条人为的坏 payload（历史脏数据）
      db.prepare(
        `INSERT INTO events (type, memory_id, payload, at) VALUES ('write', @id, '{not json', @t0)`,
      ).run({ id, t0: T0 });

      // 朴素实现（不带 json_valid 兜底）会在这里抛 "malformed JSON"
      expect(() => forget(store, id, { hard: true }, NOW)).not.toThrow();
      expect(memoryExists(db, id)).toBe(false);
      // 坏行原样留着（不能因为解析不了就删掉审计记录）
      expect(db.prepare(`SELECT payload FROM events WHERE payload = '{not json'`).get()).toEqual({
        payload: '{not json',
      });
    } finally {
      db.close();
    }
  });

  it('硬删之后再硬删 ⇒ NOT_FOUND（行已不存在）', () => {
    const { db, store, id } = makeStore();
    try {
      forget(store, id, { hard: true }, NOW);
      let caught: MemoryError | undefined;
      try {
        forget(store, id, { hard: true }, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.NOT_FOUND);
    } finally {
      db.close();
    }
  });
});

describe('forget · 脱敏 SQL 的唯一性（静态扫描）', () => {
  it('★ 生产代码里「脱敏 SQL」只出现一次（在 `redact.ts`）', () => {
    // ⚠️ **扫描范围刻意是「生产代码」**（`src` / `scripts` / `bench`），不含 `tests`：
    //   ① 这条判据要守的是「**实现**只有一份」，测试不是实现；
    //   ② 更实际的理由：**测试文件里一旦出现这个串，扫描会命中它自己**
    //      ⇒ 「只出现一次」永远为假 ⇒ 一条恒红的守卫（比恒绿更难被发现，因为它看起来在报错）。
    //   ⚠️ 本轮就真踩到过：把 needle 用模板拼接藏起来是对的，但**用例标题**里又写了一遍原文
    //     ⇒ 换个引号就被抓成第二处 ⇒ ⇒ **守卫的判据要落在外面的对象上，不是靠「我怎么写它」。**
    const needle = `json_${'set'}(payload, '$.contentText'`;
    const hits: string[] = [];
    for (const root of ['src', 'scripts', 'bench']) {
      walkFiles(join(REPO_ROOT, root), (full) => {
        if (readFileSync(full, 'utf8').includes(needle)) hits.push(full);
      });
    }

    // ★ 反例（自检）：把 needle 换个写法就找不到 ⇒ 说明这条扫描真的在读文件内容
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.replace(/\\/g, '/').split('/').pop())).toEqual(['redact.ts']);
  });
});

/** 递归遍历（只挑 `.ts` / `.mjs` / `.sql`）。 */
function walkFiles(dir: string, onFile: (full: string) => void): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkFiles(full, onFile);
      continue;
    }
    if (!/\.(ts|mjs|sql)$/.test(name)) continue;
    onFile(full);
  }
}
