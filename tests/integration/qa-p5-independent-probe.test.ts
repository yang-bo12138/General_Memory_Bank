/**
 * ★ **QA 独立验收探针** —— 阶段 5（P5-T01~T05）。
 *
 * 本文件**刻意不复用写手的断言与常量**，只从外部进攻。它守的 5 件事：
 *
 *   ① **只读架构**：自建 16 个写方法的调用表（分母**不**来自
 *      `METHODS_THROWING_READONLY_VIOLATION`），并要求**库文件 sha256** 前后不变 +
 *      `-wal` 里没有新帧（写手用的是「表内容指纹」，文件级判据能抓到它抓不到的那一类）；
 *   ② **SQL 防护层**：8 条指定语句 + 8 条对抗式构造（括号形态的写 PRAGMA、schema 前缀、
 *      行注释藏 DML、字符串字面量里的分号、`EXPLAIN` 递归 …）；
 *   ③ **worker 隔离**：静态扫描 + **子进程运行时钩子**（`tests/helpers/nativeLoadProbe.ts`），
 *      并带**正控**（导入 `db-worker.ts` 必须能检出 better-sqlite3，否则检测法本身无效）；
 *   ④ **面板无写入口**：自己渲染七个面板，把 markup 里**所有**可点元素收出来逐个判；
 *   ⑤ **MCP 最小集**：真 `Client` + `InMemoryTransport`，只看协议层拿到的形状。
 *
 * ⚠️ **本文件是冗余的第二视角，不是替代**：写手的文件在
 *   `viewer-readonly.test.ts` / `viewer-sql-guard.test.ts` / `viewer-worker.test.ts` /
 *   `viewer-panels-*.test.ts` / `mcp/*.test.ts`。
 *
 * ⚠️ **已知的、刻意不在此处断言的东西**：面板 2 / 4 / 6 需要的 `memoryId` 在
 *   renderer 里**没有输入入口**（`AppSelection.memoryId` 恒为 `''`，`DEFAULT_SELECTION` 写死）。
 *   那是**交付物可用性缺口**，随 P5-T03/T04 交互层补丁一起修 ⇒ 修好之后
 *   「没有入口」这条断言必然变红，所以它不该进门禁（写在这里只会制造假红）。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Database from 'better-sqlite3';
import { type ReactElement, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createMcpServer } from '../../mcp/server.js';
import { TOOL_NAMES } from '../../mcp/tools.js';
import { MemoryError } from '../../src/core/errors.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { guard } from '../../viewer/main/sql-guard.js';
import { ClusterMapView } from '../../viewer/renderer/panels/ClusterMap.js';
import { GraphViewView } from '../../viewer/renderer/panels/GraphView.js';
import { LogViewerView } from '../../viewer/renderer/panels/LogViewer.js';
import { MemoryListView } from '../../viewer/renderer/panels/MemoryList.js';
import { OverviewView } from '../../viewer/renderer/panels/Overview.js';
import { RecallSimulatorView } from '../../viewer/renderer/panels/RecallSimulator.js';
import { VersionHistoryView } from '../../viewer/renderer/panels/VersionHistory.js';
import { readyState } from '../../viewer/renderer/state/useReadCall.js';
import { READ_CHANNEL_METHODS, WRITE_CHANNELS } from '../../viewer/shared/channels.js';
import { pseudoUnitVector } from '../fixtures/vector.js';
import {
  FIXED_NOW,
  makeClustersResult,
  makeGraphRow,
  makeHistoryRow,
  makeLogPage,
  makeMemoryDetail,
  makeMemoryView,
  makeRecallSimResult,
  makeStats,
} from '../helpers/panelFixtures.js';

// ═══════════════════════════════════════════════════════════════════════════
// 公共夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 一个带真实数据的文件库（写实例建好、关掉，之后以只读方式打开）。 */
interface ReadonlyFixture {
  readonly dbPath: string;
  readonly memoryId: string;
  readonly otherMemoryId: string;
  readonly entityA: string;
  readonly entityB: string;
}

/**
 * 建夹具：两条记忆 + 两个实体（其一带向量，保证 `rebuildVectorBuckets` 有活可干）。
 *
 * ⚠️ 必须先用**写实例**把 schema 与数据做出来：只读实例不建表、不迁移。
 */
function createFixture(): ReadonlyFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'qa-p5-probe-'));
  const dbPath = join(dataDir, 'memory.db');

  const writer = new MemoryStore({ dbPath });
  const first = writer.write({
    content: '张三喜欢猫',
    entities: ['张三', '猫'],
    embedding: Array.from(pseudoUnitVector(1)),
  });
  const second = writer.write({ content: '李四养狗', entities: ['李四', '狗'] });
  writer.close();

  // 门面不暴露 db（§1.3）⇒ 拿实体 id 只能走旁路连接
  const side = new Database(dbPath, { readonly: true });
  const entityId = (name: string): string => {
    const row = side.prepare('SELECT id FROM entities WHERE name = ?').get(name) as
      | { id: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`夹具里没有实体 ${name}`);
    }
    return row.id;
  };
  const entityA = entityId('张三');
  const entityB = entityId('李四');
  side.close();

  return { dbPath, memoryId: first.id, otherMemoryId: second.id, entityA, entityB };
}

/** `.db` 主文件的 sha256。 */
function sha256OfMainDb(dbPath: string): string {
  return createHash('sha256').update(readFileSync(dbPath)).digest('hex');
}

/** 断言某个调用抛的**恰好是** `READONLY_VIOLATION`（不是别的码、也不是不抛）。 */
function expectExactlyReadonlyViolation(invoke: () => unknown, method: string): void {
  let error: unknown = null;
  try {
    invoke();
  } catch (caught) {
    error = caught;
  }
  expect(error, `${method}() 在只读句柄上**没有抛错**`).not.toBeNull();
  expect(error, `${method}() 抛的不是 MemoryError`).toBeInstanceOf(MemoryError);
  expect((error as MemoryError).code, `${method}() 抛的是别的错误码`).toBe('READONLY_VIOLATION');
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 只读架构：16 个写方法 / 6 个读方法 / 文件级不写入
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **我自己的 16 个写方法调用表**（「一个一个数公开方法哪些会改库」得来，
 *   不是从 `METHODS_THROWING_READONLY_VIOLATION` 反推）。
 *
 * ⚠️ 参数一律用**真实存在的 id / 实体名**：否则会先撞 `NOT_FOUND`，
 *   那条断言就退化成「它抛了个错」，而抛错与只读无关（一条假绿）。
 */
function myWriteInvocations(
  fixture: ReadonlyFixture,
  store: MemoryStore,
): Record<string, () => unknown> {
  return {
    write: () => store.write({ content: '探针不该写进去' }),
    touch: () => store.touch([fixture.memoryId]),
    link: () => store.link('张三', '同事', '李四'),
    linkByIds: () => store.linkByIds(fixture.entityA, '同事', fixture.entityB),
    forget: () => store.forget(fixture.memoryId),
    restore: () => store.restore(fixture.memoryId),
    pin: () => store.pin(fixture.memoryId),
    unpin: () => store.unpin(fixture.memoryId),
    setAlias: () => store.setAlias('探针别名', fixture.entityA),
    mergeEntities: () => store.mergeEntities(fixture.entityA, fixture.entityB),
    updateContent: () => store.updateContent(fixture.memoryId, '探针不该改的正文'),
    sweep: () => store.sweep(),
    setParams: () => store.setParams({ RECALL_TOP_N: 3 }),
    rebuildArchivalSchedule: () => store.rebuildArchivalSchedule(),
    rebuildVectorBuckets: () => store.rebuildVectorBuckets(),
    recluster: () => store.recluster(),
  };
}

const WRITE_METHOD_NAMES = [
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
] as const;

describe('QA 探针 ① · 只读句柄', () => {
  it('分母自查：我数出来的写方法恰好 16 个（少一个说明清单漏了，多一个说明它被错归）', () => {
    const fixture = createFixture();
    const store = new MemoryStore({ dbPath: fixture.dbPath, readonly: true });
    expect(Object.keys(myWriteInvocations(fixture, store)).sort()).toEqual(
      [...WRITE_METHOD_NAMES].sort(),
    );
    expect(WRITE_METHOD_NAMES).toHaveLength(16);
    store.close();
  });

  it.each(WRITE_METHOD_NAMES)(
    '★ 写方法 `%s()` 在只读句柄上抛的**恰好**是 READONLY_VIOLATION',
    (method) => {
      const fixture = createFixture();
      const store = new MemoryStore({ dbPath: fixture.dbPath, readonly: true });
      const invoke = myWriteInvocations(fixture, store)[method];
      expect(invoke, `调用表里没有 ${method}`).toBeDefined();
      expectExactlyReadonlyViolation(invoke as () => unknown, method);
      store.close();
    },
  );

  it('★ 6 个不关库的读方法在只读句柄上返回可用结果', () => {
    const fixture = createFixture();
    const store = new MemoryStore({ dbPath: fixture.dbPath, readonly: true });

    expect(store.stats().total).toBeGreaterThan(0);
    expect(store.get(fixture.memoryId)?.id).toBe(fixture.memoryId);
    expect(Array.isArray(store.recall({ context: '张三喜欢猫' }).hits)).toBe(true);
    expect(typeof store.clusters().totalMemories).toBe('number');
    expect(Array.isArray(store.inhibitionTrace('张三喜欢猫').candidates)).toBe(true);
    expect(typeof store.verifyIntegrity().bucketCoverage).toBe('number');

    store.close();
  });

  it('★ 库文件 sha256 在「16 次写尝试 + 6 次读」前后不变，且 -wal 里没有新帧', () => {
    const fixture = createFixture();
    const walPath = `${fixture.dbPath}-wal`;
    const before = sha256OfMainDb(fixture.dbPath);

    // ⚠️ 口径（实测得来）：只读连接**一打开**，SQLite 就会补出 `-shm`（32KB 的 WAL 索引）
    //   与一个**0 字节**的 `-wal`；只读连接关不掉它们。这是 WAL 的记账，不是业务写入。
    //   ⇒ 判据取两条：(a) `.db` 主文件字节不变；(b) `-wal` 里**没有帧**（0 字节）。
    //   (b) 才有判别力：任何一次提交都会往 `-wal` 追加帧。
    const store = new MemoryStore({ dbPath: fixture.dbPath, readonly: true });
    const table = myWriteInvocations(fixture, store);
    for (const [method, invoke] of Object.entries(table)) {
      expectExactlyReadonlyViolation(invoke, method);
    }
    store.stats();
    store.get(fixture.memoryId);
    store.recall({ context: '张三喜欢猫', explain: true, reinforce: false });
    store.clusters();
    store.inhibitionTrace('张三喜欢猫');
    store.verifyIntegrity();
    store.close();

    expect(sha256OfMainDb(fixture.dbPath), '只读句柄改了 .db 主文件').toBe(before);
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(walBytes, '-wal 里出现了帧 ⇒ 有写入被提交').toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② SQL 防护层：8 条指定 + 8 条对抗式
// ═══════════════════════════════════════════════════════════════════════════

/** 一条判据用例。 */
interface GuardCase {
  readonly sql: string;
  readonly expected: 'allow' | 'reject';
  readonly why: string;
}

/** ★ 指定清单（主理人给的 8 条）。 */
const REQUIRED_CASES: readonly GuardCase[] = [
  {
    sql: 'WITH c AS (SELECT 1) INSERT INTO t VALUES(1)',
    expected: 'reject',
    why: 'CTE 写入（首关键字是 WITH，黑名单天然漏掉它）',
  },
  { sql: 'PRAGMA journal_mode=WAL', expected: 'reject', why: '写数据库头的 PRAGMA' },
  { sql: 'PRAGMA table_info(memories)', expected: 'allow', why: '自省类 PRAGMA（读）' },
  { sql: 'EXPLAIN QUERY PLAN SELECT 1', expected: 'allow', why: 'EXPLAIN 套只读 SELECT' },
  { sql: 'SELECT 1; DROP TABLE memories', expected: 'reject', why: '多语句拼接' },
  { sql: '/*x*/ DELETE FROM memories', expected: 'reject', why: '块注释前缀 + DML' },
  { sql: 'SELECT 1', expected: 'allow', why: '基线只读' },
  { sql: 'PRAGMA journal_mode', expected: 'allow', why: '无参数形态的 journal_mode 是读' },
];

/** ★ 对抗式构造（专挑「换一种写法」）。 */
const ADVERSARIAL_CASES: readonly GuardCase[] = [
  {
    sql: 'PRAGMA journal_mode(WAL)',
    expected: 'reject',
    why: '赋值形态的另一半：括号形式与 =WAL 等价',
  },
  {
    sql: 'PRAGMA main.user_version = 7',
    expected: 'reject',
    why: '带 schema 前缀的写 PRAGMA（名字要剥前缀后再判）',
  },
  {
    sql: 'WITH c AS (SELECT 1) DELETE FROM memories',
    expected: 'reject',
    why: 'CTE + DELETE（换掉 INSERT 再试一次）',
  },
  {
    sql: 'WITH RECURSIVE c AS (SELECT 1) SELECT * FROM c',
    expected: 'allow',
    why: '真只读的递归 CTE 不该被误拒',
  },
  {
    sql: 'select * from memories -- ;\ndrop table memories',
    expected: 'reject',
    why: '行注释把 DROP 藏到第二行（判据顺序一换就会放行）',
  },
  {
    sql: "SELECT 'a; DROP TABLE x' AS v",
    expected: 'allow',
    why: '分号与 DROP 都在字符串字面量里 ⇒ 必须放行，不能被误拒',
  },
  {
    sql: 'EXPLAIN DELETE FROM memories',
    expected: 'reject',
    why: 'EXPLAIN 内部语句要递归过防护层',
  },
  {
    sql: 'pragma table_info(memories)',
    expected: 'allow',
    why: '小写关键字（大小写不敏感）',
  },
];

describe('QA 探针 ② · SQL 防护层', () => {
  it.each(REQUIRED_CASES.map((item) => [item.sql, item.expected, item.why] as const))(
    '★ 指定清单：%s ⇒ %s（%s）',
    (sql, expected, why) => {
      const verdict = guard(sql);
      expect(verdict.ok, `${why} · 实际判定=${verdict.ok ? 'allow' : verdict.reason}`).toBe(
        expected === 'allow',
      );
    },
  );

  it.each(ADVERSARIAL_CASES.map((item) => [item.sql, item.expected, item.why] as const))(
    '★ 对抗构造：%s ⇒ %s（%s）',
    (sql, expected, why) => {
      const verdict = guard(sql);
      expect(verdict.ok, `${why} · 实际判定=${verdict.ok ? 'allow' : verdict.reason}`).toBe(
        expected === 'allow',
      );
    },
  );

  it('★ 被放行的语句真交给 SQLite 执行一遍，全部表的内容指纹不变', () => {
    const fixture = createFixture();
    const db = new Database(fixture.dbPath, { readonly: true });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    const fingerprint = (): string =>
      createHash('sha256')
        .update(
          tables
            .map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all()))
            .join('|'),
        )
        .digest('hex');

    const before = fingerprint();
    for (const item of [...REQUIRED_CASES, ...ADVERSARIAL_CASES]) {
      if (item.expected !== 'allow') {
        continue;
      }
      expect(guard(item.sql).ok, `${item.sql} 应该被放行`).toBe(true);
      try {
        db.prepare(item.sql).all();
      } catch {
        // 允许语法/表不存在导致的报错：本断言只关心「有没有把库改成东西」
      }
    }
    expect(fingerprint(), '一条被放行的语句真的写库了').toBe(before);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ worker 隔离：静态扫描 + 子进程运行时钩子（带正控）
// ═══════════════════════════════════════════════════════════════════════════

/** 在**子进程**里导入目标模块，报告它有没有把 better-sqlite3 拉进进程。 */
function loadsBetterSqlite3(relativeModule: string): string[] {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', join('tests', 'helpers', 'nativeLoadProbe.ts'), relativeModule],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  const line = output.split('\n').find((text) => text.startsWith('PROBE_RESULT '));
  expect(line, `子进程没有输出 PROBE_RESULT：${output}`).toBeDefined();
  return (JSON.parse((line as string).replace('PROBE_RESULT ', '')) as { loaded: string[] }).loaded;
}

describe('QA 探针 ③ · worker 隔离（renderer 拿不到 better-sqlite3）', () => {
  it('★ 正控：导入 db-worker.ts 必须**检出** better-sqlite3（否则检测法本身无效）', () => {
    const loaded = loadsBetterSqlite3('./viewer/main/db-worker.ts');
    expect(loaded.some((path) => path.includes('better-sqlite3'))).toBe(true);
  });

  it('★ 运行时不变量：renderer 入口 / worker-host / preload 桥都不把原生库拉进进程', () => {
    for (const module of [
      './viewer/renderer/App.tsx',
      './viewer/main/worker-host.ts',
      './viewer/preload/bridge.ts',
    ]) {
      const loaded = loadsBetterSqlite3(module);
      expect(
        loaded.filter((path) => path.includes('better-sqlite3')),
        `${module} 拉进了原生库`,
      ).toEqual([]);
    }
  });

  it('★ 静态不变量：库句柄只在 db-worker.ts 里创建，别处连 import 都没有', () => {
    const files = [
      'viewer/main/index.ts',
      'viewer/main/ipc.ts',
      'viewer/main/queries.ts',
      'viewer/main/worker-host.ts',
      'viewer/preload/index.ts',
      'viewer/preload/bridge.ts',
      'viewer/renderer/App.tsx',
      'viewer/renderer/main.tsx',
    ];
    for (const file of files) {
      const offenders = readFileSync(join(process.cwd(), file), 'utf8')
        .split('\n')
        .filter((line) => line.includes('better-sqlite3') && !line.trim().startsWith('*'));
      expect(offenders, `${file} 里出现了 better-sqlite3 的代码行`).toEqual([]);
    }
    const worker = readFileSync(join(process.cwd(), 'viewer/main/db-worker.ts'), 'utf8');
    expect(worker.includes("from '../../src/store/MemoryStore.js'")).toBe(true);
  });

  it('★ 通道层：白名单里 8 条全是读方法，写通道数组长度为 0', () => {
    expect(WRITE_CHANNELS).toHaveLength(0);
    expect(Object.values(READ_CHANNEL_METHODS).sort()).toEqual(
      [
        'clusters',
        'get',
        'inhibitionTrace',
        'logs',
        'recall',
        'select',
        'stats',
        'verifyIntegrity',
      ].sort(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 面板无写入口：自己渲染七个面板，收集全部可点元素
// ═══════════════════════════════════════════════════════════════════════════

/** 七个面板的 markup（key = 面板 id）。 */
function renderAllPanels(): Map<string, string> {
  const history = {
    rows: [makeHistoryRow('h-1', '旧正文', 'merge', FIXED_NOW - 1)],
    total: 1,
    page: 0,
  };
  const panels: Record<string, ReactElement> = {
    overview: createElement(OverviewView, { state: readyState(makeStats()), now: FIXED_NOW }),
    memoryList: createElement(MemoryListView, {
      state: readyState(makeMemoryDetail()),
      now: FIXED_NOW,
      memoryId: 'm-1',
    }),
    recallSimulator: createElement(RecallSimulatorView, {
      state: readyState(makeRecallSimResult()),
      now: FIXED_NOW,
      context: '张三喜欢猫',
    }),
    graphView: createElement(GraphViewView, {
      state: readyState([makeGraphRow(1, '张三', '喜欢', '猫')]),
      now: FIXED_NOW,
    }),
    logViewer: createElement(LogViewerView, {
      state: readyState(makeLogPage()),
      query: { year: 2024, month: 1 },
      now: FIXED_NOW,
      selection: { year: 2024, month: 1, keyword: '' },
      keyword: '',
    }),
    versionHistory: createElement(VersionHistoryView, {
      state: readyState(history),
      current: makeMemoryView(),
      now: FIXED_NOW,
    }),
    clusterMap: createElement(ClusterMapView, {
      state: readyState(makeClustersResult()),
      previous: makeClustersResult({ computedAt: FIXED_NOW - 86_400_000 }),
      now: FIXED_NOW,
    }),
  };
  const out = new Map<string, string>();
  for (const [id, element] of Object.entries(panels)) {
    out.set(id, renderToStaticMarkup(element));
  }
  return out;
}

/** 一条可点元素。 */
interface Control {
  readonly panel: string;
  readonly tag: string;
  readonly label: string;
  readonly action: string;
}

/** 从 markup 里收出所有 `<button>` / `<a>`（含其文字与 `data-*` 动作标记）。 */
function collectControls(markupByPanel: Map<string, string>): Control[] {
  const controls: Control[] = [];
  for (const [panel, markup] of markupByPanel) {
    for (const match of markup.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const attrs = match[2] ?? '';
      const inner = (match[3] ?? '').replace(/<[^>]*>/g, '');
      const action =
        /data-(?:action|pager|nav-panel)="([^"]*)"/.exec(attrs)?.[1] ?? '(无 data-action)';
      controls.push({ panel, tag: match[1] ?? '?', label: inner.trim(), action });
    }
  }
  return controls;
}

describe('QA 探针 ④ · 七个面板无写入口', () => {
  it('★ markup 里**没有**内联 `onclick` 属性（SSR 若漏出内联处理器就是一整类注入面）', () => {
    for (const [panel, markup] of renderAllPanels()) {
      expect(/onclick\s*=/i.test(markup), `${panel} 的 markup 里出现了内联 onclick`).toBe(false);
    }
  });

  it('★ 七个面板**每一个**都渲染出了面板体（不是七个里只有一个能打开）', () => {
    const markupByPanel = renderAllPanels();
    expect(markupByPanel.size).toBe(7);
    for (const [panel, markup] of markupByPanel) {
      expect(markup.includes('panel__title'), `${panel} 没有渲染出标题`).toBe(true);
    }
  });

  it('★ 所有可点元素的动作名都在「读动作白名单」里，且不含写动作字样', () => {
    const allowedActions = new Set([
      'run-recall',
      'compare-previous',
      'prev',
      'next',
      'older',
      '(无 data-action)',
    ]);
    const writeWords = ['回滚', '删除', '遗忘', '恢复', '写入', '维护', '重建', '编辑', '保存'];

    const controls = collectControls(renderAllPanels());
    expect(controls.length, '一个可点元素都没收到 ⇒ 收集器本身失效').toBeGreaterThan(0);

    for (const control of controls) {
      expect(
        allowedActions.has(control.action),
        `${control.panel} 里出现了白名单外的动作 ${control.action}（文字「${control.label}」）`,
      ).toBe(true);
      for (const word of writeWords) {
        expect(
          control.label.includes(word),
          `${control.panel} 的可点元素「${control.label}」含写动作字样「${word}」`,
        ).toBe(false);
        expect(
          control.action.includes(word),
          `${control.panel} 的动作名 ${control.action} 含写动作字样「${word}」`,
        ).toBe(false);
      }
    }
  });

  it('★ renderer 代码里没有任何 `port.<写方法>(` 调用点（静态）', () => {
    const panelFiles = [
      'viewer/renderer/App.tsx',
      'viewer/renderer/panels/Overview.tsx',
      'viewer/renderer/panels/MemoryList.tsx',
      'viewer/renderer/panels/RecallSimulator.tsx',
      'viewer/renderer/panels/GraphView.tsx',
      'viewer/renderer/panels/LogViewer.tsx',
      'viewer/renderer/panels/VersionHistory.tsx',
      'viewer/renderer/panels/ClusterMap.tsx',
      'viewer/renderer/state/useReadCall.ts',
    ];
    const offenders: string[] = [];
    for (const file of panelFiles) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      for (const method of WRITE_METHOD_NAMES) {
        if (new RegExp(`port\\s*\\.\\s*${method}\\s*\\(`).test(source)) {
          offenders.push(`${file} → port.${method}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ MCP 最小集：真 Client + InMemoryTransport
// ═══════════════════════════════════════════════════════════════════════════

/** 起一个真 Client（真走 JSON-RPC 往返）。 */
async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'qa-p5-mcp-'));
  const store = new MemoryStore({ dbPath: join(dataDir, 'memory.db') });
  const server = createMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'qa-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

describe('QA 探针 ⑤ · MCP 最小集（协议层）', () => {
  it('★ listTools 的形状：10 个工具、三个阻塞维护方法不在、每个 additionalProperties=false', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();

      expect(tools).toHaveLength(10);
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          'write',
          'recall',
          'touch',
          'link',
          'forget',
          'restore',
          'updateContent',
          'setAlias',
          'mergeEntities',
          'sweep',
        ].sort(),
      );

      for (const blocked of ['rebuildArchivalSchedule', 'rebuildVectorBuckets', 'recluster']) {
        expect(
          tools.some((tool) => tool.name === blocked),
          `${blocked} 被暴露了`,
        ).toBe(false);
      }

      for (const tool of tools) {
        const schema = tool.inputSchema as { additionalProperties?: unknown };
        expect(schema.additionalProperties, `${tool.name} 的 additionalProperties 不是 false`).toBe(
          false,
        );
      }

      // 与服务端常量自洽：两边都是写死的，任一处漂移都会红
      expect([...TOOL_NAMES].sort()).toEqual(tools.map((tool) => tool.name).sort());
    } finally {
      await close();
    }
  });

  it('★ forget 不传 hard ⇒ 只软删（行仍在、deleted=1、deleted_at 非 null）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'qa-p5-mcp-forget-'));
    const dbPath = join(dataDir, 'memory.db');
    const store = new MemoryStore({ dbPath });
    const written = store.write({ content: '探针：这条会被软删' });

    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'qa-probe', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      await client.callTool({ name: 'forget', arguments: { id: written.id } });
    } finally {
      await client.close();
      await server.close();
    }

    const side = new Database(dbPath, { readonly: true });
    const row = side
      .prepare('SELECT deleted, deleted_at FROM memories WHERE id = ?')
      .get(written.id) as { deleted: number; deleted_at: number | null } | undefined;
    side.close();
    store.close();

    expect(row, 'forget 之后行不见了 ⇒ 默认不是软删').toBeDefined();
    expect(row?.deleted).toBe(1);
    expect(row?.deleted_at).not.toBeNull();
  });
});
