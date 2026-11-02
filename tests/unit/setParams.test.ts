/**
 * `setParams()` 的单测 —— DESIGN-v2.md §5 / §9.4.3（第 10 条归档路径），对应 **P4-T04**。
 *
 * ★ 本文件重点守四件事：
 *   ① **原子性**：非法 patch ⇒ `INVALID_INPUT`，**一个参数都不落库**、**没有 `config` 事件**；
 *   ② **`EMBED_DIM` 两层拦截**：JS 调用方绕过类型时，运行期仍要拦住；
 *   ③ **`ARCHIVE_LINE` ⇒ 归档缓存全量重建**：快路径与逐行精筛**逐位相等**；
 *   ④ **`changed` 只列真的变了的键**（`params` 是完整快照，`changed` 只供人看「动了哪几个」）。
 *
 * ⚠️ **夹具必须用 `{ ...DEFAULT_PARAMS }` 而不是 `DEFAULT_PARAMS` 本身**：
 *   `setParams()` 会**就地更新**生效参数容器（所有持有者共享同一个对象）
 *   ⇒ 直接传默认表会把「测试里的改动」漏进别的测试（而且是**跨文件**的静默污染）。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type ParamPatch, type Params } from '../../src/core/params.js';
import { SCHEMA_VERSION } from '../../src/core/version.js';
import { SCHEMA_SQL } from '../../src/db/schema.sql.js';
import {
  countArchived,
  countArchivedPrecise,
  isArchivalReady,
  rebuildArchivalScheduleInternal,
} from '../../src/store/archival.js';
import { EventWriter } from '../../src/store/events.js';
import {
  type SetParamsStore,
  readStoredParams,
  recordInitialConfig,
  setParams,
} from '../../src/store/setParams.js';
import { MemoryLogger } from '../../src/util/log.js';

const T0 = 1_700_000_000_000;
const NOW = T0 + 30 * 86_400_000;

interface Fixture {
  db: Database.Database;
  store: SetParamsStore;
}

/** 建库 + 三条稳定性不同的记忆（用于归档计算）。 */
function makeStore(seed: { memories?: boolean; readonly?: boolean } = {}): Fixture {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  if (seed.memories !== false) {
    const insert = db.prepare(
      `INSERT INTO memories (id, kind, content, content_tokens, content_hash, stability, difficulty,
                             pin_factor, created_at, last_access, access_count, deleted, deleted_at)
       VALUES (@id, 'fact', @content, 'x', @hash, @stability, 0.5, 1.0, @t0, @t0, 0, 0, NULL)`,
    );
    // ⚠️ 三条稳定性刻意跨过「0.05 与 0.5 两条归档线之间」：
    //   b（τ=20 天）在 now = +30 天时强度 ≈ 0.223 ⇒ **只在高归档线下才算归档**
    //   ⇒ 改归档线后 `archivedCount` 必须变多（否则这条断言恒绿）。
    insert.run({ id: 'a', content: 'a', hash: 'ha', stability: 1, t0: T0 });
    insert.run({ id: 'b', content: 'b', hash: 'hb', stability: 20, t0: T0 });
    insert.run({ id: 'c', content: 'c', hash: 'hc', stability: 100, t0: T0 });
  }

  const params: Params = { ...DEFAULT_PARAMS };
  const events = new EventWriter(db, {
    readonly: seed.readonly === true,
    logger: new MemoryLogger(),
    now: () => NOW,
  });
  return { db, store: { db, params, events } };
}

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

describe('setParams · 合法补丁', () => {
  it('生效 + 落库 + `config` 事件的 `params` 是**完整快照**、`changed` 精确', () => {
    const { db, store } = makeStore();
    try {
      const before = store.params.ARCHIVE_LINE;
      const result = setParams(store, { ARCHIVE_LINE: before / 2 }, NOW);

      expect(result.params.ARCHIVE_LINE).toBe(before / 2);
      // 共享容器被就地更新（门面的四个上下文与维护器看到的是同一个对象）
      expect(store.params.ARCHIVE_LINE).toBe(before / 2);

      const event = readEvents(db).find((item) => item.type === 'config');
      expect(event?.payload.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
      const params = event?.payload.params as Params;
      // ★ 是完整快照（键数 == 参数表键数），不是只记改过的那几个
      expect(Object.keys(params).sort()).toEqual(Object.keys(DEFAULT_PARAMS).sort());
      expect(params.ARCHIVE_LINE).toBe(before / 2);
      expect(event?.payload.changed).toEqual([
        { key: 'ARCHIVE_LINE', from: before, to: before / 2 },
      ]);

      // 落库（`meta.params`）
      expect(readStoredParams(db)?.ARCHIVE_LINE).toBe(before / 2);
    } finally {
      db.close();
    }
  });

  it('★ `changed` 只列真的变了的键（传了一个等值键 ⇒ 不进 changed）', () => {
    const { db, store } = makeStore();
    try {
      const result = setParams(store, { ARCHIVE_LINE: store.params.ARCHIVE_LINE }, NOW);
      expect(result.changed).toEqual([]);
      // 空补丁不记事件（一条「什么都没改」的 config 事件是假变更）
      expect(readEvents(db).filter((item) => item.type === 'config')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('setParams · 原子性（一个参数都不落库）', () => {
  it('★ 跨参数校验不过 ⇒ INVALID_INPUT，参数未变、无事件、未落库', () => {
    const { db, store } = makeStore();
    try {
      const before = { ...store.params };
      // 跨参数校验的反例：抑制不得比合并更严（§5 第 1 条：`REDUNDANCY_COS <= DEDUP_COS_MIN`）
      let caught: MemoryError | undefined;
      try {
        setParams(store, { REDUNDANCY_COS: 0.99 }, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.INVALID_INPUT);
      expect(store.params).toEqual(before);
      expect(readEvents(db)).toHaveLength(0);
      expect(readStoredParams(db)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('★ 未知键 ⇒ INVALID_INPUT', () => {
    const { db, store } = makeStore();
    try {
      let caught: MemoryError | undefined;
      try {
        setParams(store, { NOT_A_PARAM: 1 } as unknown as ParamPatch, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.INVALID_INPUT);
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('★ `EMBED_DIM`：JS 调用方绕过类型也拦得住（运行期第二道）', () => {
    const { db, store } = makeStore();
    try {
      let caught: MemoryError | undefined;
      try {
        setParams(store, { EMBED_DIM: 384 } as unknown as ParamPatch, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.INVALID_INPUT);
      expect(store.params.EMBED_DIM).toBe(DEFAULT_PARAMS.EMBED_DIM);
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('只读实例 ⇒ READONLY_VIOLATION', () => {
    const { db, store } = makeStore({ readonly: true });
    try {
      let caught: MemoryError | undefined;
      try {
        setParams(store, { ARCHIVE_LINE: 0.1 }, NOW);
      } catch (error) {
        caught = error as MemoryError;
      }
      expect(caught?.code).toBe(MemoryError.READONLY_VIOLATION);
      expect(readEvents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('setParams · 第 10 条归档路径（ARCHIVE_LINE ⇒ 全量重建）', () => {
  it('★ 改归档线后：快路径与逐行精筛**逐位相等**，且 `archive_at` 真的变了', () => {
    const { db, store } = makeStore();
    try {
      // 先按当前参数把缓存建好
      rebuildArchivalScheduleInternal(db, store.params, NOW);
      expect(isArchivalReady(db)).toBe(true);
      const archiveAtBefore = db
        .prepare(
          'SELECT memory_id AS id, archive_at AS at FROM archival_schedule ORDER BY memory_id',
        )
        .all() as Array<{ id: string; at: number }>;
      const fastBefore = countArchived(db, store.params, NOW);
      expect(fastBefore).toBe(countArchivedPrecise(db, store.params, NOW));

      // 把归档线抬高（更容易归档 ⇒ 归档数必须变多）
      setParams(store, { ARCHIVE_LINE: 0.5 }, NOW);

      const archiveAtAfter = db
        .prepare(
          'SELECT memory_id AS id, archive_at AS at FROM archival_schedule ORDER BY memory_id',
        )
        .all() as Array<{ id: string; at: number }>;
      // ★ `archive_at` 全变（按旧线算的值必须被整表换掉）
      expect(archiveAtAfter.map((row) => row.at)).not.toEqual(archiveAtBefore.map((row) => row.at));

      // ★ 两条路径逐位相等（缓存没有落后于参数）
      expect(countArchived(db, store.params, NOW)).toBe(
        countArchivedPrecise(db, store.params, NOW),
      );
      expect(countArchived(db, store.params, NOW)).toBeGreaterThan(fastBefore);
    } finally {
      db.close();
    }
  });

  it('★ 反例：不重建缓存会怎样 —— 这里证明「重建确实改变了结果」', () => {
    const { db, store } = makeStore();
    try {
      rebuildArchivalScheduleInternal(db, store.params, NOW);
      const beforeAt = (
        db
          .prepare(`SELECT archive_at AS at FROM archival_schedule WHERE memory_id = 'a'`)
          .get() as {
          at: number;
        }
      ).at;

      setParams(store, { ARCHIVE_LINE: 0.2 }, NOW);
      const afterAt = (
        db
          .prepare(`SELECT archive_at AS at FROM archival_schedule WHERE memory_id = 'a'`)
          .get() as {
          at: number;
        }
      ).at;
      expect(afterAt).not.toBe(beforeAt);
      // 不重建的话 a 的 archive_at 会停在旧线上 ⇒ 这个差值是「重建生效」的可观测证据
      expect(Math.abs(afterAt - beforeAt)).toBeGreaterThan(1);
    } finally {
      db.close();
    }
  });
});

describe('setParams · 构造期的第 0 步', () => {
  it('构造期记一条 `config`：带 SCHEMA_VERSION 与完整 params，**不带** `changed`', () => {
    const { db, store } = makeStore({ memories: false });
    try {
      // 构造期路径 = `recordInitialConfig`（门面构造函数里调用）
      recordInitialConfig(store, store.params, NOW);

      const event = readEvents(db).find((item) => item.type === 'config');
      expect(event?.payload.SCHEMA_VERSION).toBe(2);
      expect(Object.keys(event?.payload.params as Params).length).toBe(
        Object.keys(DEFAULT_PARAMS).length,
      );
      // ★ 构造期没有 `changed`（不是空数组，是**没有这个键**）
      expect(Object.prototype.hasOwnProperty.call(event?.payload, 'changed')).toBe(false);
      expect(readStoredParams(db)?.ARCHIVE_LINE).toBe(DEFAULT_PARAMS.ARCHIVE_LINE);
    } finally {
      db.close();
    }
  });
});
