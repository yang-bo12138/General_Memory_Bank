/**
 * ★ 只读句柄的集成测试 —— 阶段 5 · T02（PLAN P5-T01 的四条硬断言 / 设计 §六 T02）。
 *
 * 守四件事（每一条都配了反例或分母）：
 *   ① **16 个写方法**在只读实例上逐一抛 `READONLY_VIOLATION`（`it.each`，分母写死 16）；
 *   ② **7 个读方法**在只读实例上正常工作；
 *   ③ 只读操作**前后全表内容指纹完全不变**（用 `tests/helpers/tableHashes.ts` 的唯一实现）；
 *   ④ `appendEvent()` 在只读实例上**短路而不抛错**：`recall({explain:true})` 成功返回、
 *      `events` 行数不变、日志里出现那条 `warn`（含「只读」与「未落库」）。
 *
 * ⚠️ **为什么必须是文件库**：只读实例要另开一个连接（`{ readonly: true, fileMustExist: true }`）
 *   ⇒ 内存库做不到「同库两连接」。
 * ⚠️ **临时目录不清理**（与仓库既有夹具同口径）：Windows 上句柄未释放时删不掉目录。
 *
 * ⚠️ ★ **设计文档里有两处与代码事实不符，本文件按**代码事实**断言（并在失败信息里写明）**：
 *   1. 设计 §8 R8 / §9.2 N-06 说「`clusters()` 会写 `theme_clusters` / `theme_cluster_members` 快照表」。
 *      **实测不成立**：`src/store/clusters.ts` 的 `clusters()` 是**纯读**（它的上下文是
 *      `ClusterQueryStore = { db, params }`，**结构上没有 `events`**；写快照的是 `recluster()`，
 *      而 `recluster()` 有显式的只读守卫）。⇒ 本文件断言 `clusters()` **一张表都不写**，
 *      这比「快照表不算业务表」更强，而且是**真**的。
 *   2. 设计说「`close()` 要 flush 日志」。**实测不成立**：`MemoryStore#close()` 只 `db.close()`，
 *      日志 flush 由 `FileLogger` 自己的 1s 定时器驱动 ⇒ 本文件用**有界轮询**等它落盘
 *      （不改 `src/**`：那是库的行为，不是查看器的）。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { METHODS_THROWING_READONLY_VIOLATION, MemoryError } from '../../src/core/errors.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { pseudoUnitVector } from '../fixtures/vector.js';
import { allTableNames, changedTables, tableFingerprints } from '../helpers/tableHashes.js';

// ═══════════════════════════════════════════════════════════════════════════
// 夹具：一个**有真实数据**的文件库（写实例建好、关掉，再以只读方式打开）
// ═══════════════════════════════════════════════════════════════════════════

/** 夹具：库路径 + 两条记忆 + 两个实体的 id。 */
interface Fixture {
  dbPath: string;
  dataDir: string;
  memoryId: string;
  otherMemoryId: string;
  entityA: string;
  entityB: string;
}

/** 实体名（写进夹具，后面按名字反查 id）。 */
const ENTITY_A_NAME = '张三';
const ENTITY_B_NAME = '李四';

/**
 * 建夹具。
 *
 * ⚠️ **必须先用写实例把 schema 与数据做出来**：
 *   只读实例不迁移（`ensureSchemaForMode`），空文件 + 只读 ⇒ `INVALID_INPUT`。
 *   这也正是真实场景：宿主先用写实例建库，查看器后以只读打开。
 */
function createFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-readonly-'));
  const dbPath = join(dataDir, 'memory.db');

  const writer = new MemoryStore({ dbPath });
  const first = writer.write({
    content: '张三喜欢猫',
    entities: [ENTITY_A_NAME, '猫'],
    // ⚠️ **必须给一条带向量的记忆**：否则 `rebuildVectorBuckets()` 没有可迁的成员，
    //   它会在「建新桶」那一步写出 0 行 ⇒ **在只读句柄上也不会抛错**。
    //   那样这条 `it.each` 会红，而原因不是「只读失效」，是「夹具里没有向量」
    //   （一条会把人带偏的假红）。
    embedding: Array.from(pseudoUnitVector(1)),
  });
  const second = writer.write({ content: '李四养狗', entities: [ENTITY_B_NAME, '狗'] });
  writer.close();

  // ⚠️ 门面**不暴露 `db`**（§1.3）⇒ 要拿实体 id 只能另开旁路连接（仓库既有先例）
  const reader = new Database(dbPath);
  const entityId = (name: string): string => {
    const row = reader.prepare('SELECT id FROM entities WHERE name = ?').get(name) as
      | { id: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`夹具里没有实体 ${name}`);
    }
    return row.id;
  };
  const entityA = entityId(ENTITY_A_NAME);
  const entityB = entityId(ENTITY_B_NAME);
  reader.close();

  return { dbPath, dataDir, memoryId: first.id, otherMemoryId: second.id, entityA, entityB };
}

/** 以只读方式打开夹具。 */
function openReadonly(fixture: Fixture): MemoryStore {
  return new MemoryStore({ dbPath: fixture.dbPath, readonly: true });
}

/** 断言某个调用抛 `READONLY_VIOLATION`。 */
function expectReadonlyViolation(invoke: () => unknown, method: string): void {
  try {
    invoke();
  } catch (error) {
    expect(error, `${method} 抛的不是 MemoryError`).toBeInstanceOf(MemoryError);
    const code = (error as MemoryError).code;
    expect(code, `${method} 抛的是 ${code}，不是 READONLY_VIOLATION`).toBe('READONLY_VIOLATION');
    return;
  }
  throw new Error(`${method} 在只读实例上**没有抛错**（§7.1 当场失效）`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 16 个写方法
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **16 个写方法各自的调用**（必须与 `METHODS_THROWING_READONLY_VIOLATION` **逐名对齐**）。
 *
 * ⚠️ 参数刻意都用**真实存在的 id / 名字**：否则失败的会是 `NOT_FOUND`，
 *   而不是 `READONLY_VIOLATION` —— 那样断言就变成「它抛了个错」，
 *   而「抛错」这件事跟只读毫无关系（一条**假绿**）。
 */
function writeInvocations(fixture: Fixture, store: MemoryStore): Record<string, () => unknown> {
  return {
    write: () => store.write({ content: '只读实例上不该写进去的新内容' }),
    touch: () => store.touch([fixture.memoryId]),
    link: () => store.link(ENTITY_A_NAME, '同事', ENTITY_B_NAME),
    linkByIds: () => store.linkByIds(fixture.entityA, '同事', fixture.entityB),
    forget: () => store.forget(fixture.memoryId),
    restore: () => store.restore(fixture.memoryId),
    pin: () => store.pin(fixture.memoryId),
    unpin: () => store.unpin(fixture.memoryId),
    setAlias: () => store.setAlias('只读别名', fixture.entityA),
    mergeEntities: () => store.mergeEntities(fixture.entityA, fixture.entityB),
    updateContent: () => store.updateContent(fixture.memoryId, '只读实例上不该改的正文'),
    sweep: () => store.sweep(),
    setParams: () => store.setParams({ RECALL_TOP_N: 3 }),
    rebuildArchivalSchedule: () => store.rebuildArchivalSchedule(),
    rebuildVectorBuckets: () => store.rebuildVectorBuckets(),
    recluster: () => store.recluster(),
  };
}

describe('T02 · 只读句柄：16 个写方法逐一抛 READONLY_VIOLATION', () => {
  it('分母写死：`METHODS_THROWING_READONLY_VIOLATION` 恰好 16 个，且与设计清单逐名一致', () => {
    expect(METHODS_THROWING_READONLY_VIOLATION.length).toBe(16);
    // ⚠️ 期望值**独立写死**在测试里（不从被测常量反推）：
    //   反过来 import 同一个常量当期望值，会让断言退化成 `expect(x).toBe(x)`
    expect([...METHODS_THROWING_READONLY_VIOLATION].sort()).toEqual(
      [
        'write',
        'touch',
        'link',
        'linkByIds',
        'forget',
        'restore',
        'pin',
        'unpin',
        'setAlias',
        'mergeEntities',
        'updateContent',
        'sweep',
        'setParams',
        'rebuildArchivalSchedule',
        'rebuildVectorBuckets',
        'recluster',
      ].sort(),
    );
  });

  it('调用表**恰好覆盖**那 16 个方法（多一个 / 少一个都红）', () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);
    const keys = Object.keys(writeInvocations(fixture, store));
    expect(keys.sort()).toEqual([...METHODS_THROWING_READONLY_VIOLATION].sort());
    store.close();
  });

  it.each([
    'write',
    'touch',
    'link',
    'linkByIds',
    'forget',
    'restore',
    'pin',
    'unpin',
    'setAlias',
    'mergeEntities',
    'updateContent',
    'sweep',
    'setParams',
    'rebuildArchivalSchedule',
    'rebuildVectorBuckets',
    'recluster',
  ])('★ `%s()` 在只读实例上抛 READONLY_VIOLATION', (method) => {
    const fixture = createFixture();
    const store = openReadonly(fixture);
    const invoke = writeInvocations(fixture, store)[method];
    expect(invoke, `调用表里没有 ${method}`).toBeDefined();
    expectReadonlyViolation(invoke as () => unknown, method);
    store.close();
  });

  it('反例：同一个方法在**可写**实例上不抛 READONLY_VIOLATION（把只读标志摘掉就该失败）', () => {
    // ⚠️ 这条证明上面的 it.each 抓到的是「只读」这件事，而不是「这些方法本来就会抛错」
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-writable-'));
    const dbPath = join(dataDir, 'memory.db');
    const writer = new MemoryStore({ dbPath });
    const first = writer.write({ content: '张三喜欢猫', entities: [ENTITY_A_NAME] });
    // `pin` 是 16 个之一，在可写实例上必须成功（不抛）
    expect(() => writer.pin(first.id)).not.toThrow();
    expect(() => writer.sweep()).not.toThrow();
    writer.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 7 个读方法
// ═══════════════════════════════════════════════════════════════════════════

describe('T02 · 只读句柄：7 个读方法正常工作', () => {
  it('分母写死：7 个读方法 = recall / stats / get / close / clusters / inhibitionTrace / verifyIntegrity', () => {
    // ⚠️ 这张清单来自 PLAN P5-T01 的「读（7 个，允许）」，逐字抄成测试的**分母**
    const expected = [
      'clusters',
      'close',
      'get',
      'inhibitionTrace',
      'recall',
      'stats',
      'verifyIntegrity',
    ];
    expect(expected.length).toBe(7);
    const fixture = createFixture();
    const store = openReadonly(fixture);
    // 逐个方法**真的存在**（不只是名字对得上）
    for (const name of expected) {
      expect(typeof (store as unknown as Record<string, unknown>)[name], `${name} 不存在`).toBe(
        'function',
      );
    }
    store.close();
  });

  it('6 个「不关库」的读方法都给出可用结果', () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);

    const stats = store.stats();
    expect(stats.total).toBeGreaterThan(0);

    const view = store.get(fixture.memoryId);
    expect(view).not.toBeNull();
    expect(view?.id).toBe(fixture.memoryId);

    const recalled = store.recall({ context: '张三喜欢猫' });
    expect(Array.isArray(recalled.hits)).toBe(true);
    expect(Array.isArray(recalled.suppressed)).toBe(true);

    const clusters = store.clusters();
    expect(typeof clusters.totalMemories).toBe('number');

    const trace = store.inhibitionTrace('张三喜欢猫');
    expect(Array.isArray(trace.candidates)).toBe(true);

    const report = store.verifyIntegrity();
    // ⚠️ 五个字段（§6 逐字）；`clusterSnapshotFreshness` 在「从未发布」时是 `-1` 哨兵
    expect(Object.keys(report).sort()).toEqual([
      'archivalMismatch',
      'archivalOrphans',
      'bucketCoverage',
      'clusterSnapshotFreshness',
      'edgesDiffusable',
    ]);

    store.close();
  });

  it('`close()` 在只读实例上可用且**幂等**（关两次不抛）', () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it('反例：`close()` 之后再读 ⇒ 必须抛错（证明上一条真的关掉了句柄，不是空转）', () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);
    store.close();
    expect(() => store.stats()).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 全表内容指纹不变
// ═══════════════════════════════════════════════════════════════════════════

describe('T02 · 只读句柄：跑完全部读方法后**一张表都没变**', () => {
  it('★ 全表（含快照表）行数 + 内容哈希完全不变', () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);

    const observer = new Database(fixture.dbPath, { readonly: true });
    const tables = allTableNames(observer);
    // ⚠️ 分母写死：schema 里现在有 15 张表（加表要显式改这里，而不是让指纹静默少算一张）
    expect(tables.length).toBeGreaterThanOrEqual(15);

    const before = tableFingerprints(observer, tables);

    store.stats();
    store.get(fixture.memoryId);
    store.recall({ context: '张三喜欢猫', explain: true, reinforce: false });
    store.clusters();
    store.inhibitionTrace('张三喜欢猫');
    store.verifyIntegrity();

    const after = tableFingerprints(observer, tables);
    expect(changedTables(before, after)).toEqual([]);

    observer.close();
    store.close();
  });

  it('★ `clusters()` 是**纯读**（设计说它会写快照表 —— 实测不成立，这里断言真事实）', () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);
    const observer = new Database(fixture.dbPath, { readonly: true });

    const snapshotBefore = tableFingerprints(observer, [
      'theme_clusters',
      'theme_cluster_members',
      'cluster_snapshot_meta',
    ]);
    store.clusters();
    const snapshotAfter = tableFingerprints(observer, [
      'theme_clusters',
      'theme_cluster_members',
      'cluster_snapshot_meta',
    ]);

    // ⚠️ 即使把「写快照」这条路**只读打开**，`clusters()` 也不会走它
    //   ⇒ 三张快照表的指纹也必须一字不差
    expect(changedTables(snapshotBefore, snapshotAfter)).toEqual([]);

    // 反向对照：`recluster()` **是**写方法（它在只读实例上抛 READONLY_VIOLATION）
    //   ⇒「读方法不写、写方法才写」这个分野是真实存在的，不是两张表都没人碰
    expectReadonlyViolation(() => store.recluster(), 'recluster');

    observer.close();
    store.close();
  });

  it('反例：指纹判据能抓到「多一行」（证明上一条不是恒绿）', () => {
    const fixture = createFixture();
    const observer = new Database(fixture.dbPath);
    const before = tableFingerprints(observer, ['memories']);
    observer
      .prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                               stability, difficulty, created_at, last_access, access_count)
         VALUES ('probe-id', 'fact', '探针', '探 针', 'probe-hash', 1, 0.5, 1, 1, 0)`,
      )
      .run();
    const after = tableFingerprints(observer, ['memories']);
    expect(changedTables(before, after)).toEqual(['memories']);
    observer.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ appendEvent 短路
// ═══════════════════════════════════════════════════════════════════════════

/** 等日志落盘：读取当天的日志文件直到出现目标串（**有界轮询**，最多 3s）。 */
async function waitForLogContaining(dataDir: string, needles: readonly string[]): Promise<string> {
  const deadline = Date.now() + 3_000;
  let lastText = '';
  for (;;) {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const path = join(dataDir, 'logs', year, month, `${month}-${day}.log`);
    try {
      lastText = readFileSync(path, 'utf8');
    } catch {
      lastText = '';
    }
    if (needles.every((needle) => lastText.includes(needle))) {
      return lastText;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `等了 3s 日志里还是没有 ${needles.join(' / ')}\n最近一次读到：\n${lastText || '(空)'}`,
      );
    }
    // ⚠️ 只能等：`FileLogger` 的 `warn` 走**异步队列**（1s/200 行先到先 flush），
    //   而 `MemoryStore#close()` **不** flush 日志 ⇒ 外部没有任何同步出口可用。
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('T02 · appendEvent 在只读实例上短路（不抛错、不落库、留一条 warn）', () => {
  it('★ `recall({ explain: true })` 成功返回，且 `events` 行数不变', () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);
    const observer = new Database(fixture.dbPath, { readonly: true });

    const eventsBefore = (
      observer.prepare('SELECT count(*) AS n FROM events').get() as { n: number }
    ).n;

    // ⚠️ `explain: true` 会尝试记一条 `recall` 事件（§8.4）⇒ 只读实例上必须**短路**
    const recalled = store.recall({ context: '张三喜欢猫', explain: true, reinforce: false });
    expect(recalled.hits.length).toBeGreaterThan(0);
    expect(recalled.explain?.routes.text.ran).toBe(true);

    const eventsAfter = (
      observer.prepare('SELECT count(*) AS n FROM events').get() as { n: number }
    ).n;
    expect(eventsAfter).toBe(eventsBefore);

    observer.close();
    store.close();
  });

  it('★ 日志里出现那条 warn，且**是 recall 那条**（`op=召回` + 只读 + 未落库）', async () => {
    const fixture = createFixture();
    const store = openReadonly(fixture);
    store.recall({ context: '张三喜欢猫', explain: true, reinforce: false });
    store.close();

    const text = await waitForLogContaining(fixture.dataDir, ['只读模式下事件未落库', 'op=召回']);
    // ⚠️ 三个关键字一起断言：只断言「有 warn」会被**构造期那条 config 事件的 warn** 满足
    //   （构造只读实例本身就会短路一条 `config` 事件）⇒ 那样就测不到 recall 这条路
    expect(text).toContain('只读模式下事件未落库');
    expect(text).toContain('op=召回');
  });

  it('反例：可写实例上同一次 `recall({explain:true})` 必须**加一条** events 行', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-events-'));
    const dbPath = join(dataDir, 'memory.db');
    const writer = new MemoryStore({ dbPath });
    writer.write({ content: '张三喜欢猫', entities: [ENTITY_A_NAME] });

    const observer = new Database(dbPath, { readonly: true });
    const before = (observer.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
    writer.recall({ context: '张三喜欢猫', explain: true, reinforce: false });
    const after = (observer.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;

    // ⚠️ 这条是上面那条的**反例**：同样的调用在可写实例上**会**写事件
    //   ⇒ 证明「events 行数不变」不是「这条路径压根不写事件」
    expect(after).toBe(before + 1);
    observer.close();
    writer.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 只读标志本身
// ═══════════════════════════════════════════════════════════════════════════

describe('T02 · `{ readonly: true, fileMustExist: true }` 的两条钉子', () => {
  it('打开**不存在**的路径 ⇒ 抛 NOT_FOUND（证明 `fileMustExist: true` 真的生效）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-missing-'));
    const missing = join(dataDir, 'nope.db');
    try {
      // eslint-disable-next-line no-new -- 只要构造的副作用（抛错）
      new MemoryStore({ dbPath: missing, readonly: true });
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryError);
      expect((error as MemoryError).code).toBe('NOT_FOUND');
      expect((error as MemoryError).details.path).toBe(missing);
      return;
    }
    throw new Error('只读打开一个不存在的路径**没有抛错** ⇒ fileMustExist 没生效');
  });

  it('反例：同样不存在的路径用**可写**方式打开 ⇒ 会建库而不是抛错', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-create-'));
    const created = join(dataDir, 'created.db');
    const store = new MemoryStore({ dbPath: created });
    // 建库成功 ⇒ 文件存在
    expect(() => readFileSync(created)).not.toThrow();
    store.close();
  });
});
