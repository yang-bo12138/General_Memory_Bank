/**
 * 事件流的单测 —— DESIGN-v2.md §8.4 / §7.1 / §8.2。
 *
 * 覆盖的验收硬断言（DEVELOPMENT-PLAN.md P0-T04）：
 * · `events.type` 的取值集合**恰好**是 §3 的 13 种
 * · `touch` 事件的 payload **键集**与 §8.4 的 touch 行一致
 * · `merge` 事件按来源分两套字段集：3c 全量 / `restore_merge` 子集
 * · `appendEvent` 的 `memory_id` 参数在 TypeScript 层是**必传**（值可为 `null`）⇒ 编译期可检
 * · 只读句柄上调用 `appendEvent` ⇒ **不抛错**、**不写库**、产生一条 warn 日志
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import {
  CONTENT_TEXT_KEY,
  EVENT_PAYLOAD_KEYS,
  EVENT_PAYLOAD_VARIANTS,
  EVENT_TYPES,
  type EventPayload,
  type EventType,
  TOUCH_ALWAYS_KEYS,
  TOUCH_EXPLICIT_ONLY_KEYS,
} from '../../src/core/events.types.js';
import { EventWriter, allowsContentText } from '../../src/store/events.js';
import { LOG_ACTIONS, MemoryLogger } from '../../src/util/log.js';
import { createEventsTable } from '../fixtures/events-table.js';

/** 建一个带 `events` 表的内存库。 */
function openFixture(): Database.Database {
  const db = new Database(':memory:');
  createEventsTable(db);
  return db;
}

/** 每种 type 的最小合法 payload（够写进库即可）。 */
const MINIMAL_PAYLOADS: Readonly<Record<EventType, EventPayload>> = {
  write: {
    id: 'm1',
    kind: 'fact',
    contentText: '张三住在北京',
    contentLength: 6,
    contentHash: 'h1',
    entityIds: ['e1'],
    emotion: 0,
    confidence: 0.7,
    hasEmbedding: false,
    initialStability: 1,
    initialDifficulty: 0.5,
  },
  merge: {
    targetId: 'm1',
    intervalDays: 3,
    boostApplied: true,
    contentText: '张三住在北京',
    contentLength: 6,
    contentHash: 'h1',
    prevContentLength: 5,
    addedEntities: ['e1'],
    hasEmbedding: false,
    stabilityDelta: 0.4,
  },
  restore: { id: 'm1' },
  manual_fix: {
    id: 'm1',
    contentText: '张三住在上海',
    contentLength: 6,
    contentHash: 'h2',
    prevContentLength: 6,
    hasEmbedding: false,
  },
  alias: { action: 'set', alias: '小张', entityId: 'e1' },
  touch: {
    id: 'm1',
    reason: 'explicit',
    intervalDays: 0,
    boostApplied: false,
    edgesReinforced: 0,
    stabilityDelta: 0,
    coactPairs: [],
    coactPairsTruncated: 0,
    activationWrites: [],
    coactSkipped: [],
  },
  recall: {
    contextHash: 'c1',
    topN: 5,
    hitIds: ['m1'],
    scores: [0.9],
    includeArchived: false,
    diffuseArchived: true,
    vectorUsed: false,
    suppressedIds: [],
    diffusedSeeds: [],
  },
  link: {
    subjectId: 'e1',
    predicate: '住在',
    objectId: 'e2',
    weightAfter: 0.8,
    autoCreatedEntities: [],
  },
  pin: { id: 'm1', factor: 2, prevFactor: 1 },
  unpin: { id: 'm1', prevFactor: 2 },
  forget: { id: 'm1', hard: false },
  sweep: {
    action: 'purge',
    purged: 0,
    archivedCount: 0,
    vacuumed: false,
    coactPairsActive: 0,
    coactPairsPurged: 0,
    clusterCount: 0,
    largestClusterRatio: 0,
    largestClusterRatioBeforeSplit: 0,
    blocksAfterSplit: 0,
  },
  config: { SCHEMA_VERSION: 2, params: {} as never },
};

/**
 * 编译期断言：§8.4 硬规则 5 —— `memory_id` 是**必传实参**。
 *
 * ⚠️ 本函数**永不执行**；它的唯一作用是让 `tsc --noEmit` 检查下面两处 `@ts-expect-error`。
 *   （若哪天有人把 `memoryId` 改成可选参数，`@ts-expect-error` 会因「没有错误」而让编译失败。）
 */
function compileTimeOnly(writer: EventWriter): void {
  // @ts-expect-error memory_id 不可省略（值可为 null，但不允许省略这个参数）
  writer.appendEvent('write', { id: 'x' });
  // @ts-expect-error memory_id 不可省略（只给了 type 一个实参）
  writer.appendEvent('write');
}
// 让 lint / tsc 不抱怨「未使用的函数」
void compileTimeOnly;

describe('P0-T04 · events.type 恰好 13 种（不新增 type）', () => {
  it('EVENT_TYPES 常量是 §3 的 13 个，逐字一致', () => {
    expect(EVENT_TYPES).toHaveLength(13);
    expect([...EVENT_TYPES]).toEqual([
      'write',
      'merge',
      'restore',
      'manual_fix',
      'alias',
      'touch',
      'recall',
      'link',
      'pin',
      'unpin',
      'forget',
      'sweep',
      'config',
    ]);
  });

  it('SELECT DISTINCT type FROM events 与常量表相等', () => {
    const db = openFixture();
    try {
      const logger = new MemoryLogger();
      const writer = new EventWriter(db, { readonly: false, logger, now: () => 1_700_000_000_000 });
      for (const type of EVENT_TYPES) {
        writer.appendEvent(type, type === 'config' ? null : 'm1', MINIMAL_PAYLOADS[type]);
      }
      const rows = db.prepare('SELECT DISTINCT type FROM events ORDER BY type').all() as Array<{
        type: string;
      }>;
      const actual = rows.map((row) => row.type).sort();
      const expected = [...EVENT_TYPES].sort();
      expect(actual).toEqual(expected);
      expect(actual).toHaveLength(13);
    } finally {
      db.close();
    }
  });

  it('拼错的 type 被库层 CHECK 挡住（§3 的枚举由 CHECK 强制，非法值无法落库）', () => {
    const db = openFixture();
    try {
      expect(() =>
        db
          .prepare('INSERT INTO events (type, memory_id, payload, at) VALUES (?, ?, ?, ?)')
          .run('Write', null, '{}', 1),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('P0-T04 · touch 事件的 payload 键集', () => {
  it('显式发射点的 touch payload 键集与 §8.4 的 touch 变体一致', () => {
    const payload = MINIMAL_PAYLOADS.touch as unknown as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [...(EVENT_PAYLOAD_VARIANTS.touch?.touch_explicit ?? [])].sort(),
    );
  });

  it('两个发射点的并集 = §8.4 touch 行的全部键（缺键即报错）', () => {
    const variants = EVENT_PAYLOAD_VARIANTS.touch ?? {};
    const union = new Set<string>([
      ...(variants.touch_explicit ?? []),
      ...(variants.touch_exact_repeat ?? []),
    ]);
    expect([...union].sort()).toEqual([...EVENT_PAYLOAD_KEYS.touch].sort());
  });

  it('5 个新键齐备：stabilityDelta / coactPairs / coactPairsTruncated / activationWrites / coactSkipped', () => {
    const payload = MINIMAL_PAYLOADS.touch as unknown as Record<string, unknown>;
    for (const key of [
      'stabilityDelta',
      'coactPairs',
      'coactPairsTruncated',
      'activationWrites',
      'coactSkipped',
    ]) {
      expect(payload).toHaveProperty(key);
    }
  });

  it('exact_repeat 路径**不出现**那 4 个键，但 stabilityDelta 恒在', () => {
    const exactRepeat: Record<string, unknown> = {
      id: 'm1',
      reason: 'exact_repeat',
      intervalDays: 0,
      boostApplied: false,
      edgesReinforced: 0,
      addedEntities: [],
      embeddingAdded: 0,
      stabilityDelta: 0,
    };
    for (const key of TOUCH_EXPLICIT_ONLY_KEYS) {
      expect(exactRepeat).not.toHaveProperty(key);
    }
    for (const key of TOUCH_ALWAYS_KEYS) {
      expect(exactRepeat).toHaveProperty(key);
    }
    expect(Object.keys(exactRepeat).sort()).toEqual(
      [...(EVENT_PAYLOAD_VARIANTS.touch?.touch_exact_repeat ?? [])].sort(),
    );
  });
});

describe('P0-T04 · merge 事件的两套字段集', () => {
  it('3c 全量字段集与 §8.4 一致', () => {
    const payload = MINIMAL_PAYLOADS.merge as unknown as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [...(EVENT_PAYLOAD_VARIANTS.merge?.merge_3c ?? [])].sort(),
    );
  });

  it('restore_merge 子集**没有** intervalDays / boostApplied / 正文四项', () => {
    const restoreMerge = {
      targetId: 'm1',
      addedEntities: ['e1'],
      mergedFrom: 'm2',
      reason: 'restore_merge' as const,
    };
    expect(Object.keys(restoreMerge).sort()).toEqual(
      [...(EVENT_PAYLOAD_VARIANTS.merge?.restore_merge ?? [])].sort(),
    );
    expect(restoreMerge).not.toHaveProperty('intervalDays');
    expect(restoreMerge).not.toHaveProperty('boostApplied');
    expect(restoreMerge).not.toHaveProperty(CONTENT_TEXT_KEY);
    expect(restoreMerge).not.toHaveProperty('contentLength');
    expect(restoreMerge).not.toHaveProperty('contentHash');
    expect(restoreMerge).not.toHaveProperty('prevContentLength');
  });
});

describe('P0-T04 · §8.2 的正文口径', () => {
  it('只有 write / merge(3c) / manual_fix 允许带 contentText', () => {
    expect(allowsContentText('write', MINIMAL_PAYLOADS.write)).toBe(true);
    expect(allowsContentText('merge', MINIMAL_PAYLOADS.merge)).toBe(true);
    expect(allowsContentText('manual_fix', MINIMAL_PAYLOADS.manual_fix)).toBe(true);
    for (const type of EVENT_TYPES) {
      if (type === 'write' || type === 'merge' || type === 'manual_fix') {
        continue;
      }
      expect(allowsContentText(type, MINIMAL_PAYLOADS[type])).toBe(false);
    }
  });

  it('merge 的 restore_merge 变体**不得**带 contentText', () => {
    const restoreMerge = {
      targetId: 'm1',
      addedEntities: [],
      mergedFrom: 'm2',
      reason: 'restore_merge' as const,
    };
    expect(allowsContentText('merge', restoreMerge)).toBe(false);
  });

  it('违规携带正文 ⇒ 抛 INVALID_INPUT 且不落库', () => {
    const db = openFixture();
    try {
      const logger = new MemoryLogger();
      const writer = new EventWriter(db, { readonly: false, logger, now: () => 1 });
      expect(() =>
        writer.appendEvent('recall', null, {
          ...MINIMAL_PAYLOADS.recall,
          [CONTENT_TEXT_KEY]: '不该出现',
        } as never),
      ).toThrow(MemoryError);
      const count = db.prepare('SELECT count(*) AS n FROM events').get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('P0-T04 · 只读实例上 appendEvent 短路而不抛错', () => {
  it('不抛错、不写库、产生一条 warn 日志', () => {
    const db = openFixture();
    try {
      const logger = new MemoryLogger();
      const writer = new EventWriter(db, { readonly: true, logger, now: () => 1 });
      expect(() => writer.appendEvent('write', 'm1', MINIMAL_PAYLOADS.write)).not.toThrow();

      const count = db.prepare('SELECT count(*) AS n FROM events').get() as { n: number };
      expect(count.n).toBe(0);

      const warns = logger.ofLevel('warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.action).toBe(LOG_ACTIONS.error);
      expect(warns[0]?.fields.err).toBe('只读模式下事件未落库');
      expect(warns[0]?.fields.op).toBe(LOG_ACTIONS.write);
    } finally {
      db.close();
    }
  });

  it('只读判断收在 appendEvent 内部（调用点不需要各自判）', () => {
    const db = openFixture();
    try {
      const logger = new MemoryLogger();
      const writer = new EventWriter(db, { readonly: true, logger, now: () => 1 });
      writer.appendEvent('write', 'm1', MINIMAL_PAYLOADS.write);
      writer.appendEvent('recall', null, MINIMAL_PAYLOADS.recall);
      expect(logger.ofLevel('warn')).toHaveLength(2);
      expect(logger.ofLevel('error')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('P0-T04 · appendEvent 的落库形状', () => {
  it('memory_id 为 null 时显式写 null（汇总事件不挂某条记忆）', () => {
    const db = openFixture();
    try {
      const logger = new MemoryLogger();
      const writer = new EventWriter(db, { readonly: false, logger, now: () => 42 });
      writer.appendEvent('sweep', null, MINIMAL_PAYLOADS.sweep);
      const row = db.prepare('SELECT type, memory_id, payload, at FROM events').get() as {
        type: string;
        memory_id: string | null;
        payload: string;
        at: number;
      };
      expect(row.type).toBe('sweep');
      expect(row.memory_id).toBeNull();
      expect(row.at).toBe(42);
      expect(JSON.parse(row.payload)).toMatchObject({ action: 'purge' });
    } finally {
      db.close();
    }
  });

  it('payload 以 JSON 落库，键不被改写', () => {
    const db = openFixture();
    try {
      const logger = new MemoryLogger();
      const writer = new EventWriter(db, { readonly: false, logger, now: () => 1 });
      writer.appendEvent('touch', 'm1', MINIMAL_PAYLOADS.touch);
      const row = db.prepare('SELECT payload FROM events').get() as { payload: string };
      const parsed = JSON.parse(row.payload) as unknown as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(
        [...(EVENT_PAYLOAD_VARIANTS.touch?.touch_explicit ?? [])].sort(),
      );
    } finally {
      db.close();
    }
  });
});
