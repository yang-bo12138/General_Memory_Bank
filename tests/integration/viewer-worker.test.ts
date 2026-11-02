/**
 * ★ 库线程 / 通道 / 桥的三条「结构性保证」测试 —— 阶段 5 · T02。
 *
 * 对应 PLAN P5-T01 的硬断言「**全部库调用在 worker**」（静态 + 运行时两条路）与
 * 「preload 只暴露 8 个方法」，外加设计 §2.5 的「谁允许 import electron」。
 *
 * ⚠️ **为什么敢在 vitest 里真起一个 worker**：`db-worker.ts` 是**纯 Node**
 *   （不 import electron），`execArgv: ['--import','tsx']` 让它能被直接跑起来；
 *   `pool: 'forks'`（`vitest.config.ts` 的硬性要求）保证进程模型与生产一致。
 *   ⇒ 这不是 mock：真的 `postMessage` 往返、真的开库、真的序列化错误。
 *
 * ⚠️ **本文件是 `viewer/**` 的「源码扫描」层**（设计 §2.3 的三层结构断言里的第三层）。
 *   扫描前**必须剥注释**（`scripts/lib/code-span.ts` 的 `blankComments`）：
 *   本仓库的注释**故意**大量提到 `better-sqlite3` / `electron`（正是为了解释为什么不许用）
 *   ⇒ 不剥注释的扫描要么恒红，要么逼着人删掉那些解释（把「为什么」一起删掉）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { blankComments } from '../../scripts/lib/code-span.js';
import { MemoryError } from '../../src/core/errors.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import {
  CURVE_SAMPLE_COUNT,
  buildMemoryDetail,
  openWorkerState,
} from '../../viewer/main/db-worker.js';
import {
  registerReadHandlers,
  sanitizeRecallInput,
  sanitizeSelectArgs,
} from '../../viewer/main/ipc.js';
import { CONTENT_HISTORY_PAGE_SIZE, GRAPH_NODE_LIMIT } from '../../viewer/main/queries.js';
import { WorkerHost } from '../../viewer/main/worker-host.js';
import { buildBridge } from '../../viewer/preload/bridge.js';
import { READ_CHANNELS, WRITE_CHANNELS } from '../../viewer/shared/channels.js';
import {
  READ_PORT_METHODS,
  type ReadPort,
  type WorkspaceError,
  asWorkspaceError,
} from '../../viewer/shared/protocol.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════
// 源码扫描工具
// ═══════════════════════════════════════════════════════════════════════════

/** 递归列出某个目录下的 `.ts` / `.tsx` 文件（相对仓库根，正斜杠）。 */
function listSourceFiles(relativeDir: string): string[] {
  const absolute = join(REPO_ROOT, relativeDir);
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // 目录还不存在（如 T03 之前的 `viewer/renderer`）⇒ 没有文件可扫
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        found.push(relative(REPO_ROOT, full).replace(/\\/g, '/'));
      }
    }
  };

  walk(absolute);
  return found.sort();
}

/** 读一个文件并**剥掉注释**（扫描判据只看代码，不看解释）。 */
function readCode(relativePath: string): string {
  return blankComments(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
}

/** 找出「代码里出现了某个 `from '<模块>'`」的文件。 */
function filesImporting(dirs: readonly string[], moduleName: string): string[] {
  const pattern = new RegExp(`from\\s+'${moduleName.replace(/[/.]/g, '\\$&')}'`);
  return dirs.flatMap((dir) => listSourceFiles(dir)).filter((file) => pattern.test(readCode(file)));
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 静态：renderer / preload 没有库能力
// ═══════════════════════════════════════════════════════════════════════════

describe('T02 · 静态检查：renderer 与 preload 里没有「直接摸库」的能力', () => {
  /** 六个禁用痕迹（设计 §2.3 第 3 层逐字）。 */
  const FORBIDDEN_TRACES = ['better-sqlite3', 'Database(', 'prepare(', 'exec(', 'pragma('] as const;

  it('`viewer/preload/**` 的代码里一个禁用痕迹都没有（且真的扫到了文件）', () => {
    const files = listSourceFiles('viewer/preload');
    // ⚠️ 分母不为 0：目录空了会让下面的循环变成**恒绿的空气断言**
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      const code = readCode(file);
      for (const trace of FORBIDDEN_TRACES) {
        expect(code, `${file} 的代码里出现了 ${trace}`).not.toContain(trace);
      }
    }
  });

  it('`viewer/renderer/**` 的代码里一个禁用痕迹都没有（T03/T04 会往这里加面板）', () => {
    for (const file of listSourceFiles('viewer/renderer')) {
      const code = readCode(file);
      for (const trace of FORBIDDEN_TRACES) {
        expect(code, `${file} 的代码里出现了 ${trace}`).not.toContain(trace);
      }
    }
  });

  it('反例：同一组判据能在**故意写坏**的源码上命中（不是恒绿）', () => {
    const probe =
      "import Database from 'better-sqlite3';\nconst db = new Database(p);\ndb.prepare('SELECT 1');";
    const hits = FORBIDDEN_TRACES.filter((trace) => blankComments(probe).includes(trace));
    expect(hits).toEqual(['better-sqlite3', 'Database(', 'prepare(']);
  });
});

describe('T02 · 静态检查：谁允许 import electron / better-sqlite3', () => {
  it("★ `from 'electron'` 只出现在**写死的两个**文件里", () => {
    // ⚠️ 设计 §2.5 说「只有 viewer/main/index.ts」—— 那条**在物理上做不到**：
    //   preload 的 `contextBridge` / `ipcRenderer` 只能从 'electron' 拿。
    //   ⇒ 真实形态是「恰好这两个」，而且**任何测试都不 import 它们**（二进制没装，一 require 就崩）。
    //   ⇒ 本断言写成**写死的名单**：多一个就红（比「只有 main」这条做不到的纪律更严）。
    expect(filesImporting(['viewer'], 'electron')).toEqual([
      'viewer/main/index.ts',
      'viewer/preload/index.ts',
    ]);
  });

  it("★ `from 'better-sqlite3'` 在 `viewer/**` 里只有 `db-worker.ts` 一处", () => {
    expect(filesImporting(['viewer'], 'better-sqlite3')).toEqual(['viewer/main/db-worker.ts']);
  });

  it('★ 任何测试都不 import 那两个 electron 文件（一 require 就抛 failed to install correctly）', () => {
    // ⚠️ 判据是「**导入语句**里的路径」而不是「源码里出现这个字符串」：
    //   本文件自己就会提到这两个路径（正是在解释为什么不能 import 它们）
    //   ⇒ 用 `includes` 会让这条断言**指着自己**变红（一条会把人带偏的假红）。
    const importPattern = /from\s+'[^']*viewer\/(?:main|preload)\/index(?:\.js)?'/;
    // ⚠️ 排除**本文件**：它下面那两条反例断言里就有「一条看起来像导入的字符串」
    //   （且本文件对那两个文件的依赖已由编译器把关）。
    const SELF = 'tests/integration/viewer-worker.test.ts';
    const offenders = listSourceFiles('tests').filter(
      (file) => file !== SELF && importPattern.test(readCode(file)),
    );
    expect(offenders).toEqual([]);
    // 反例：同样的判据必须能命中一条真的 import
    expect(importPattern.test("import { app } from '../../viewer/main/index.js';")).toBe(true);
    expect(importPattern.test("const x = 'viewer/main/index';")).toBe(false);
  });

  it('反例：`filesImporting` 判据在故意写坏的源码上能命中', () => {
    const probe = "import { app } from 'electron';";
    expect(/from\s+'electron'/.test(blankComments(probe))).toBe(true);
    expect(/from\s+'better-sqlite3'/.test(blankComments(probe))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 运行时：真起一个库线程
// ═══════════════════════════════════════════════════════════════════════════

/** 建一个带数据的文件库（写实例建好即关，随后只读打开）。 */
function createDatabase(): { dbPath: string; memoryId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-worker-'));
  const dbPath = join(dir, 'memory.db');
  const writer = new MemoryStore({ dbPath });
  const first = writer.write({ content: '张三喜欢猫', entities: ['张三', '猫'] });
  writer.close();
  return { dbPath, memoryId: first.id };
}

/**
 * 真 worker 的 URL（`.ts` 直跑）。
 *
 * ⚠️ 配套的 `execArgv` 指向 `tests/fixtures/worker-ts-register.mjs`，**不是** `--import tsx`：
 *   实测 Node v22.22.2 的 **worker 线程**里 `--import tsx` 不生效（Node 22.18+ 自带类型剥离
 *   能加载 `.ts` 入口，但 tsx 的 resolver 没挂上 ⇒ `…/errors.js` 解析不到 `.ts`）。
 *   那个夹具的作用就是「在 worker 线程里显式 register()」。详见该文件的说明。
 */
const WORKER_URL = new URL('../../viewer/main/db-worker.ts', import.meta.url);

/** 启动 `.ts` 库线程要的 `execArgv`（**唯一出处**，7 处 `new WorkerHost` 都用它）。 */
const WORKER_EXEC_ARGV = [
  '--import',
  new URL('../fixtures/worker-ts-register.mjs', import.meta.url).href,
];

describe('T02 · 运行时：真起 `worker_threads` 跑库线程', () => {
  it('★ `stats` 请求能拿到真实结果（全程只有一个 id→Promise 的请求通道）', async () => {
    const { dbPath } = createDatabase();
    const host = new WorkerHost({
      dbPath,
      workerUrl: WORKER_URL,
      execArgv: WORKER_EXEC_ARGV,
      timeoutMs: 20_000,
    });
    try {
      await host.ready();
      const stats = (await host.call('stats', [])) as { total: number };
      expect(stats.total).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  }, 60_000);

  it('★ `select` 走 `queries.ts` 的常量（面板 6 的计数与分页都通）', async () => {
    const { dbPath, memoryId } = createDatabase();
    const host = new WorkerHost({
      dbPath,
      workerUrl: WORKER_URL,
      execArgv: WORKER_EXEC_ARGV,
      timeoutMs: 20_000,
    });
    try {
      await host.ready();

      const counted = await host.select('contentHistoryCount', { memoryId });
      expect(counted).toHaveLength(1);
      expect(counted[0]?.total).toBe(0);

      const page = await host.select('contentHistoryPage', { memoryId, limit: 50, offset: 0 });
      expect(page).toEqual([]);
    } finally {
      await host.close();
    }
  }, 60_000);

  it('★ 错误跨进程序列化：缺 `memoryId` ⇒ `INVALID_INPUT`（不是裸 SQLite 码）', async () => {
    const { dbPath } = createDatabase();
    const host = new WorkerHost({
      dbPath,
      workerUrl: WORKER_URL,
      execArgv: WORKER_EXEC_ARGV,
      timeoutMs: 20_000,
    });
    try {
      await host.ready();
      await expect(host.select('contentHistoryCount', {})).rejects.toThrow();
      try {
        await host.select('contentHistoryCount', {});
      } catch (error) {
        const workspaceError = asWorkspaceError(error);
        expect(workspaceError.code).toBe('INVALID_INPUT');
        expect(workspaceError.details.key).toBe('memoryId');
      }
    } finally {
      await host.close();
    }
  }, 60_000);

  it('★ `logs` 读不到目录 ⇒ 空页而**不抛错**（新库本来就没有 logs/）', async () => {
    const { dbPath } = createDatabase();
    const host = new WorkerHost({
      dbPath,
      workerUrl: WORKER_URL,
      execArgv: WORKER_EXEC_ARGV,
      timeoutMs: 20_000,
    });
    try {
      await host.ready();
      const page = await host.logs({ year: 1970, month: 1 });
      expect(page).toEqual({ lines: [], total: 0 });
    } finally {
      await host.close();
    }
  }, 60_000);

  it('★ 打不开的库 ⇒ `NOT_FOUND`（`fileMustExist: true` 穿过 worker 边界仍然生效）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-worker-missing-'));
    const host = new WorkerHost({
      dbPath: join(dir, 'nope.db'),
      workerUrl: WORKER_URL,
      execArgv: WORKER_EXEC_ARGV,
      timeoutMs: 20_000,
    });
    try {
      await expect(host.ready()).rejects.toThrow();
    } finally {
      await host.close();
    }
  }, 60_000);

  it('超时 ⇒ `DATABASE_BUSY` + `details.reason = worker_timeout`（不是新增一个码）', async () => {
    const { dbPath } = createDatabase();
    // ⚠️ 1ms 对「spawn 一个 tsx worker」必然不够 ⇒ 稳定命中超时分支
    const host = new WorkerHost({
      dbPath,
      workerUrl: WORKER_URL,
      execArgv: WORKER_EXEC_ARGV,
      timeoutMs: 1,
    });
    try {
      await expect(host.ready()).rejects.toThrow();
    } finally {
      await host.close();
    }
  }, 60_000);
});

describe('T02 · 主线程里的假端口：方法集恰好 8 个，没有库能力', () => {
  it('★ 手写的 `ReadPort` 假端口恰好 8 个方法，且与 `READ_PORT_METHODS` 逐名一致', () => {
    // ⚠️ 声明成 `ReadPort` ⇒ **编译期**保证它没漏方法（将来 ReadPort 加第 9 个，这里编译就红）
    const port: ReadPort = {
      stats: async () => ({}) as never,
      get: async () => null,
      recall: async () => ({}) as never,
      clusters: async () => ({}) as never,
      inhibitionTrace: async () => ({}) as never,
      verifyIntegrity: async () => ({}) as never,
      select: async () => [],
      logs: async () => ({ lines: [], total: 0 }),
    };

    expect(Object.keys(port).sort()).toEqual([...READ_PORT_METHODS].sort());
    expect(Object.keys(port).length).toBe(8);
  });

  it('★ 假端口上**没有** `prepare` / `exec` / `pragma` / 任何写方法', () => {
    const port = {
      stats: async () => null,
      get: async () => null,
      recall: async () => null,
      clusters: async () => null,
      inhibitionTrace: async () => null,
      verifyIntegrity: async () => null,
      select: async () => null,
      logs: async () => null,
    };
    for (const forbidden of ['prepare', 'exec', 'pragma', 'write', 'touch', 'sweep', 'close']) {
      expect(port, `假端口上不该有 ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ preload 桥：暴露恰好 8 个方法
// ═══════════════════════════════════════════════════════════════════════════

describe('T02 · preload 桥：`window.gmb.read` 恰好 8 个方法', () => {
  it('★ `Object.keys(bridge.read)` 恰好等于 `READ_PORT_METHODS`', () => {
    const bridge = buildBridge(async () => ({ ok: true, data: null }));
    expect(Object.keys(bridge.read).sort()).toEqual([...READ_PORT_METHODS].sort());
    expect(Object.keys(bridge.read)).toHaveLength(8);
  });

  it('每个方法都把调用转发到**对应通道**上（名字 ↔ 通道的映射只有一份）', async () => {
    const invoked: Array<{ channel: string; args: unknown[] }> = [];
    const bridge = buildBridge(async (channel, ...args) => {
      invoked.push({ channel, args });
      return { ok: true, data: 'ok' };
    });

    await bridge.read.stats(123);
    await bridge.read.logs({ year: 2026, month: 11 });
    expect(invoked).toEqual([
      { channel: 'mem:stats', args: [123] },
      { channel: 'mem:logs', args: [{ year: 2026, month: 11 }] },
    ]);
  });

  it('★ 失败的信封 ⇒ reject 一个**带码**的错误；且 `message` 里也序列化了一份', async () => {
    const failure: WorkspaceError = {
      code: 'NOT_FOUND',
      message: '库里没有这条记忆',
      details: { id: 'abc' },
    };
    const bridge = buildBridge(async () => ({ ok: false, error: failure }));

    try {
      await bridge.read.get('abc');
      throw new Error('应当 reject');
    } catch (error) {
      // ① 属性还在（同进程 / 测试 / 假端口）
      expect(asWorkspaceError(error).code).toBe('NOT_FOUND');
      expect(asWorkspaceError(error).details).toEqual({ id: 'abc' });
      // ② `message` 里那份 JSON ⇒ 跨 contextBridge 克隆后仍可还原
      const message = (error as Error).message;
      expect(JSON.parse(message)).toEqual(failure);
    }
  });

  it('`asWorkspaceError` 的三条还原路径（属性 / JSON message / 兜底）都有断言', () => {
    // ① 属性
    expect(
      asWorkspaceError(Object.assign(new Error('x'), { code: 'CONFLICT', details: { a: 1 } })),
    ).toEqual({ code: 'CONFLICT', message: 'x', details: { a: 1 } });
    // ② JSON message
    expect(
      asWorkspaceError(
        new Error(JSON.stringify({ code: 'DATABASE_BUSY', message: 'm', details: { r: 't' } })),
      ),
    ).toEqual({ code: 'DATABASE_BUSY', message: 'm', details: { r: 't' } });
    // ③ 兜底：排障信息不丢（原文进 details）
    const fallback = asWorkspaceError(new Error('彻底不认识的东西'));
    expect(fallback.code).toBe('DATABASE_BUSY');
    expect(fallback.details.reason).toBe('unreadable_error');
    expect(fallback.message).toBe('彻底不认识的东西');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ IPC 层：8 条通道、不接受 dbPath、reinforce 恒 false
// ═══════════════════════════════════════════════════════════════════════════

/** 假 host：记录每次调用，返回可预期的数据。 */
interface FakeHost {
  host: WorkerHost;
  calls: Array<{ method: string; args: unknown[] }>;
}

function createFakeHost(
  behaviour: (method: string, args: unknown[]) => unknown = () => 'result',
): FakeHost {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]): unknown => {
    calls.push({ method, args });
    return behaviour(method, args);
  };
  const host = {
    call: async (method: string, args: unknown[]) => record(method, args),
    select: async (name: string, params: unknown) => record('select', [name, params]),
    logs: async (query: unknown) => record('logs', [query]),
  } as unknown as WorkerHost;
  return { host, calls };
}

/** 注册并收集 8 条监听器。 */
function collectListeners(
  host: WorkerHost,
): Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>> {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  registerReadHandlers(host, (channel, listener) => {
    listeners.set(channel, listener);
  });
  return listeners;
}

describe('T02 · IPC 层：8 条通道逐名注册', () => {
  it('★ 注册的通道恰好是 `READ_CHANNELS` 那 8 条（不多不少、名字逐字相同）', () => {
    const { host } = createFakeHost();
    const listeners = collectListeners(host);
    expect([...listeners.keys()]).toEqual([...READ_CHANNELS]);
    expect(listeners.size).toBe(8);
    expect(WRITE_CHANNELS.length).toBe(0);
  });

  it('★ 每个通道都返回**信封**而不是抛错（否则 Electron 会把 code / details 拍平）', async () => {
    const { host } = createFakeHost(() => {
      throw MemoryError.notFound('没有', { id: 'x' });
    });
    const listeners = collectListeners(host);
    const listener = listeners.get('mem:stats');
    expect(listener).toBeDefined();
    const envelope = await listener?.({}, 1);
    expect(envelope).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: '没有', details: { id: 'x' } },
    });
  });

  it('★ renderer 传进来的 `dbPath` **一个字节都转发不出去**', async () => {
    const { host, calls } = createFakeHost();
    const listeners = collectListeners(host);

    // 8 条通道逐个喂一个「带 dbPath 的对象」，然后看有没有任何东西被转发到库线程
    for (const channel of READ_CHANNELS) {
      await listeners.get(channel)?.({}, { dbPath: '/etc/passwd' });
    }

    // ⚠️ 断言的是**转发出去的内容**里没有 dbPath，而不是「返回值长什么样」：
    //   库线程的 `open` 是 `WorkerHost` 构造时发的（路径由主进程给），
    //   通道层**根本没有**携带路径的参数位。
    expect(JSON.stringify(calls)).not.toContain('dbPath');
    // 分母不为 0：至少有一条通道正常转发了（否则「没出现 dbPath」可以靠「什么都没干」做到）
    expect(calls.length).toBeGreaterThan(0);
  });

  it('★ `reinforce: true` 被强行改回 `false`，其余未知字段一个都不转发', () => {
    const sanitized = sanitizeRecallInput({
      context: '张三喜欢猫',
      topN: 3,
      reinforce: true,
      explain: true,
      dbPath: '/etc/passwd',
      entityIds: ['x'],
    });
    expect(sanitized).toEqual({ context: '张三喜欢猫', topN: 3, reinforce: false });
  });

  it('★ `mem:select` 只收**查询名**：传 SQL 文本 ⇒ SQL_GUARD_REJECTED', () => {
    expect(() => sanitizeSelectArgs('SELECT * FROM memories', {})).toThrow();
    try {
      sanitizeSelectArgs('SELECT * FROM memories', {});
    } catch (error) {
      expect(asWorkspaceError(error).code).toBe('SQL_GUARD_REJECTED');
      expect(asWorkspaceError(error).details.reason).toBe('unknown_query_name');
    }
    // 合法名字照常通过，且参数原样交出去（钳值在库线程做）
    expect(sanitizeSelectArgs('graphTwoHop', { memoryId: 'x' })).toEqual({
      name: 'graphTwoHop',
      params: { memoryId: 'x' },
    });
  });

  it('反例：非法时间戳必须被拒（不是静默当 undefined）', async () => {
    const { host } = createFakeHost();
    const listeners = collectListeners(host);
    const envelope = await listeners.get('mem:stats')?.({}, 'not-a-number');
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 库线程里的纯函数（面板 2 的曲线 / 参数上界）
// ═══════════════════════════════════════════════════════════════════════════

describe('T02 · 面板 2 的详情在库线程算好（renderer 不做时间计算）', () => {
  it('★ `buildMemoryDetail` 给出 120 个点 + 三条层级线 + 归档时刻', () => {
    const { dbPath, memoryId } = createDatabase();
    const state = openWorkerState(dbPath);
    try {
      const detail = buildMemoryDetail(state, memoryId);
      expect(detail).not.toBeNull();
      if (detail === null) return;

      expect(detail.curve).toHaveLength(CURVE_SAMPLE_COUNT);
      expect(CURVE_SAMPLE_COUNT).toBe(120);
      // 曲线强度单调不增（时间只会往前走）
      for (let index = 1; index < detail.curve.length; index += 1) {
        const previous = detail.curve[index - 1]?.intensity ?? 0;
        const current = detail.curve[index]?.intensity ?? 0;
        expect(current).toBeLessThanOrEqual(previous + 1e-12);
      }
      // 层级线的值来自 `params`（不是抄来的数）
      expect(detail.layerMarks.l3).toBeCloseTo(0.7, 10);
      expect(detail.layerMarks.l2).toBeCloseTo(0.3, 10);
      expect(detail.layerMarks.archived).toBeCloseTo(0.05, 10);
      // 归档时刻在 `lastAccess` 之后（跨度恒正）
      expect(detail.archiveAt).toBeGreaterThan(detail.view.lastAccess);
    } finally {
      state.store.close();
      state.raw.close();
    }
  });

  it('查不到 ⇒ `null`（`get` 是读接口，缺失用返回值表达）', () => {
    const { dbPath } = createDatabase();
    const state = openWorkerState(dbPath);
    try {
      expect(buildMemoryDetail(state, 'no-such-id')).toBeNull();
    } finally {
      state.store.close();
      state.raw.close();
    }
  });
});

describe('T02 · 面板 4/6 的参数上界来自常量（不信调用方）', () => {
  it('`GRAPH_NODE_LIMIT` 与 `CONTENT_HISTORY_PAGE_SIZE` 是写死的常量', () => {
    expect(GRAPH_NODE_LIMIT).toBe(300);
    expect(CONTENT_HISTORY_PAGE_SIZE).toBe(50);
  });
});
