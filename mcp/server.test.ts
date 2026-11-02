/**
 * ★ `mcp/server.ts` 的**协议层**覆盖 —— 阶段 5 · T05 的补测（新建文件，不改产品代码）。
 *
 * 【为什么需要这个文件】
 *   `mcp/tools.ts` 的断言全部跑在**纯函数**上（这是它与 SDK 解耦的代价：它压根不 import SDK）。
 *   ⇒ `mcp/server.ts` 那 133 行（`tools/list` 的转换、`tools/call` 的 try/catch、
 *     `{code, message, details}` 的结构化回执、异步包装）**一行都没被执行过**。
 *   ⇒ 本文件用 SDK 自带的**进程内传输**（`InMemoryTransport.createLinkedPair()`，实测存在于
 *     `@modelcontextprotocol/sdk/inMemory.js`）把 `Server` 连到一个真 `Client`，
 *     **真的走 JSON-RPC 请求-响应**，而不是直接调 `dispatchTool()`。
 *
 * 【它断言的是「线上形状」，不是「我们以为的形状」】
 *   四个只有协议层才能验的东西：
 *   ① `inputSchema` 里的 `additionalProperties: false` **没有被 SDK 的 zod 校验吃掉**
 *      （`ToolSchema.inputSchema` 是 `$catchall` 才保得住它 —— 换成严格的 schema 就会静默丢字段）；
 *   ② 成功返回体是 MCP 的 `content[]` 形状，**不是**把库的返回对象摊在顶层；
 *   ③ 业务失败走 `isError: true` 的**结果**（不是 JSON-RPC error）⇒ 客户端 `await` 不会 reject；
 *   ④ `code` + `details` 的**具体值**穿过协议后仍然在（§11.2 的要求）。
 *
 * ⚠️ **一条「差点写成的恒绿断言」记在这里**（留给下一个人）：
 *   SDK 的 `setRequestHandler()` 内部会把处理器包成 `Promise.resolve(handler(...))`
 *   ⇒ **断言「注册进去的那个函数返回 Promise」永远为真**，与我们的 `async` 无关。
 *   所以第 ⑥ 组改为：拦下**我传给 `setRequestHandler` 的那个原始函数**，断言它是
 *   `AsyncFunction`，而 `tools/list` 的那个**不是** —— 一正一反才有判别力。
 *
 * ⚠️ **未覆盖的分支**：`runStdioServer()`（它会去抢真实 stdin/stdout，测试里跑等于把进程挂住）。
 *   它是 3 行薄壳（`connect(new StdioServerTransport())`），如实报在交付说明里，不假装覆盖到了。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from '../src/core/params.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import type { RecallResult } from '../src/store/recall.js';
import type { WriteResult } from '../src/store/write.js';
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from './server.js';
import { BLOCKED_MAINTENANCE_METHODS, TOOL_NAMES, dispatchTool } from './tools.js';

// ═══════════════════════════════════════════════════════════════════════════
// 〇、夹具：真库 + 真 Server + 真 Client + 进程内传输
// ═══════════════════════════════════════════════════════════════════════════

/** 工具名总数（与 `tools.test.ts` 同一个写死分母：加工具必须有人来改这个数）。 */
const EXPECTED_TOOL_COUNT = 10;

/** 协议层的 `tools/call` 结果形状（SDK 的 `CallToolResult`；这里只取用得到的字段）。 */
interface WireCallResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

/** 一次用例的完整夹具。 */
interface Harness {
  readonly store: MemoryStore;
  readonly dbPath: string;
  readonly client: Client;
  /** 关时按 client → store 顺序（client 先断，否则 close 会等一个已经没了的对端）。 */
  readonly close: () => Promise<void>;
}

/** 起一套「真协议」的夹具。 */
async function createHarness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-mcp-server-'));
  const dbPath = join(dataDir, 'memory.db');
  const store = new MemoryStore({ dbPath });

  const server = createMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'mcp-server-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    store,
    dbPath,
    client,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

/** 当前用例的夹具（`beforeEach` 建、`afterEach` 关）。 */
let harness: Harness;

/** 走协议调一次工具（**不**直接碰 `dispatchTool`）。 */
async function wireCall(name: string, args: Record<string, unknown>): Promise<WireCallResult> {
  return (await harness.client.callTool({ name, arguments: args })) as WireCallResult;
}

/** 取结果里唯一那条文本内容（本服务的所有工具都只回一条 `text`）。 */
function textOf(result: WireCallResult): string {
  expect(result.content.length, '本服务的工具应当只回一条 text 内容').toBe(1);
  const block = result.content[0];
  expect(block?.type, `内容块类型是 ${String(block?.type)}，不是 text`).toBe('text');
  if (typeof block?.text !== 'string') {
    throw new Error('内容块没有 text 字段（不是纯文本结果）');
  }
  return block.text;
}

/** 把 `isError: true` 的内容解析成 `{ code, message, details }` 并断言三个键都在。 */
function errorPayloadOf(result: WireCallResult): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  expect(result.isError, '业务失败必须以 isError: true 的结果回来，而不是异常').toBe(true);
  const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
  expect(Object.keys(payload).sort()).toEqual(['code', 'details', 'message']);
  return payload as { code: string; message: string; details: Record<string, unknown> };
}

/** 旁路连接（门面不暴露 `db`；数 `events` 行只能另开一条连接）。 */
function withDb<T>(dbPath: string, run: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 数某类事件的行数。 */
function countEvents(type: string): number {
  return withDb(harness.dbPath, (db) => {
    const row = db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as {
      n: number;
    };
    return row.n;
  });
}

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 一、`tools/list`（协议层）
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 协议层 `tools/list`', () => {
  it('★ 返回 **10 个**工具，名字与 `TOOL_NAMES` 逐项相同（顺序也相同）', async () => {
    const listed = await harness.client.listTools();
    expect(listed.tools.length, '协议层的工具数与写死的分母不一致').toBe(EXPECTED_TOOL_COUNT);
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    // 非空分母：确认真的拿到了名字（别让一条空数组的比较蒙过去）
    expect(listed.tools[0]?.name).toBe('write');
  });

  it('★ 每个工具都带 `inputSchema`，且 `additionalProperties: false` **没被 SDK 吃掉**', async () => {
    const listed = await harness.client.listTools();
    for (const tool of listed.tools) {
      expect(tool.inputSchema, `${tool.name} 没有 inputSchema`).toBeDefined();
      expect(tool.inputSchema.type, `${tool.name} 的 inputSchema.type`).toBe('object');
      // ⚠️ 这条只有协议层能验：SDK 的 `ToolSchema.inputSchema` 是 `$catchall` 才会保留它
      expect(
        tool.inputSchema.additionalProperties,
        `${tool.name} 的 additionalProperties 在线上丢了（客户端将无法据此拒未知键）`,
      ).toBe(false);
      expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
      expect(
        (tool.description ?? '').length,
        `${tool.name} 的 description 在线上为空`,
      ).toBeGreaterThan(0);
    }
  });

  it('★ 三个阻塞维护方法**不在协议层列表里**（不是只断那个常量）', async () => {
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    expect(BLOCKED_MAINTENANCE_METHODS.length).toBe(3);
    for (const blocked of BLOCKED_MAINTENANCE_METHODS) {
      expect(
        names,
        `${blocked} 出现在 tools/list 里（宿主会把它做成工具，一次调用阻塞 1~3 分钟）`,
      ).not.toContain(blocked);
    }
    // 反例配对：同一份 names 里必须有东西在场，否则上面的 not.toContain 可以靠空数组通过
    expect(names).toContain('write');
    expect(names).toContain('sweep');
  });

  it('服务身份与 `createMcpServer` 的声明一致（`SERVER_NAME` / `SERVER_VERSION`）', async () => {
    const version = harness.client.getServerVersion();
    expect(version?.name).toBe(SERVER_NAME);
    expect(version?.version).toBe(SERVER_VERSION);
    // 能力声明：tools 必须在（否则客户端不会发 tools/* 请求）
    expect(harness.client.getServerCapabilities()?.tools).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、`tools/call` 成功路径（线上形状）
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 协议层 `tools/call` 成功路径', () => {
  it('★ `write` ⇒ 返回 MCP 的 content 形状，**不是**把库的返回对象摊在顶层', async () => {
    const result = await wireCall('write', { content: '张三喜欢猫', entities: ['张三'] });

    // ① 不是错误
    expect(result.isError).toBeUndefined();
    // ② 是「一条 text 内容块」，而不是裸 JS 对象
    expect(Array.isArray(result.content)).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
    const payload = JSON.parse(textOf(result)) as WriteResult;
    expect(typeof payload.id).toBe('string');
    expect(payload.merged).toBe(false);
    // ③ ★ 判别式：库的字段**不在顶层**
    expect((result as unknown as Record<string, unknown>).id).toBeUndefined();
  });

  it('★ `recall` ⇒ 命中刚通过协议写进去的那条', async () => {
    const written = JSON.parse(
      textOf(await wireCall('write', { content: '李四养狗' })),
    ) as WriteResult;
    const recalled = JSON.parse(
      textOf(await wireCall('recall', { context: '李四养狗' })),
    ) as RecallResult;
    expect(recalled.hits.length).toBeGreaterThan(0);
    expect(recalled.hits.map((hit) => hit.id)).toContain(written.id);
  });

  it('`tools/call` 是 `await` 得到的（一次真实往返），不是本地直调', async () => {
    // 断言返回值是 Promise（协议层天生异步）；再断言它**真的**经传输层往返过：
    // 用一个库侧观察不到、但协议侧必然发生的顺序来验 —— 写完之后才可能召回。
    const pending = harness.client.callTool({ name: 'write', arguments: { content: '往返证据' } });
    expect(pending, 'callTool 没有返回 Promise').toBeInstanceOf(Promise);
    const result = (await pending) as WireCallResult;
    expect(result.isError).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、业务失败：`isError: true` 的**结果**（不是 JSON-RPC error）
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 协议层错误形状（§11.2：code + details 必须过线）', () => {
  it('★ 未知工具名 ⇒ `isError: true` 的**结果**（客户端不 reject），带 `reason` 与可用清单', async () => {
    // ⚠️ 用 resolves 而不是 rejects：**业务失败不是协议失败**。
    //   谁把这里改成 `throw new McpError(...)`，客户端就会 reject ⇒ 这条断言当场红。
    const result = await wireCall('recluster', {});
    const payload = errorPayloadOf(result);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.details.reason).toBe('unknown_tool');
    expect(payload.details.tool).toBe('recluster');
    expect((payload.details.available as string[]).length).toBe(EXPECTED_TOOL_COUNT);
  });

  it('★ 库抛 `NOT_FOUND` ⇒ `isError: true` 且 `details.id` 是**那个具体值**', async () => {
    const result = await wireCall('forget', { id: '没有这条记忆' });
    const payload = errorPayloadOf(result);
    expect(payload.code).toBe('NOT_FOUND');
    expect(payload.details.id).toBe('没有这条记忆');
    expect(typeof payload.message).toBe('string');
    // 反例配对：`details` 不是空的（否则「有 details」可以靠 `{}` 混过去）
    expect(Object.keys(payload.details).length).toBeGreaterThan(0);
  });

  it('★ `touch` 超 `COACT_BATCH_MAX` ⇒ 库的校验没被协议层吞掉（`details.max` 过线）', async () => {
    const written = JSON.parse(
      textOf(await wireCall('write', { content: '共激活上限的陪跑数据' })),
    ) as WriteResult;
    const tooMany = Array.from({ length: DEFAULT_PARAMS.COACT_BATCH_MAX + 1 }, () => ({
      memoryId: written.id,
      seedIds: [] as string[],
    }));
    const payload = errorPayloadOf(
      await wireCall('touch', { ids: [written.id], coActivateWith: tooMany }),
    );
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.details.reason).toBe('coact_batch_max');
    expect(payload.details.max).toBe(DEFAULT_PARAMS.COACT_BATCH_MAX);
  });

  it('参数校验也在协议层生效（客户端传的未知键不会被 `properties` 之外悄悄吃下）', async () => {
    const payload = errorPayloadOf(
      await wireCall('recall', { context: '合法上下文', sourceFilter: 'cli' }),
    );
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.details.reason).toBe('invalid_arguments');
    expect(payload.details.unknownKeys).toEqual(['sourceFilter']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、`recall.explain` 的写放大（协议层复验）
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 协议层 `recall` 的事件写放大', () => {
  it('★ 分母非空：库里有记忆、`events` 表能读出配置事件', async () => {
    await wireCall('write', { content: '事件表的分母数据' });
    expect(
      countEvents('write'),
      '`events` 表里连 write 都没有 ⇒ 后面的「行数不变」毫无意义',
    ).toBeGreaterThan(0);
    expect(countEvents('config'), '构造期那条 config 事件不在 ⇒ 事件流本身没工作').toBeGreaterThan(
      0,
    );
  });

  it('★ 不传 `explain` ⇒ `recall` 事件行数不变；`explain: true` ⇒ 恰好 +1（成对）', async () => {
    await wireCall('write', { content: '协议层的召回写放大' });
    const before = countEvents('recall');

    const plain = JSON.parse(
      textOf(await wireCall('recall', { context: '协议层的召回写放大' })),
    ) as RecallResult;
    expect(plain.hits.length).toBeGreaterThan(0);
    expect(plain.explain).toBeUndefined();
    expect(countEvents('recall'), 'MCP 的 recall 默认把事件写上去了（写放大过线）').toBe(before);

    const explained = JSON.parse(
      textOf(await wireCall('recall', { context: '协议层的召回写放大', explain: true })),
    ) as RecallResult;
    expect(explained.explain).toBeDefined();
    expect(countEvents('recall')).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、异步在最外层 / 库是全同步
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 异步只在协议层，库仍全同步', () => {
  it('★ `tools/call` 的处理器是 `async`，而 `tools/list` 的不是（一正一反）', async () => {
    // ⚠️ **为什么拦住 `setRequestHandler` 的入参**：SDK 内部把处理器包成
    //   `Promise.resolve(handler(...))` ⇒ 断言「注册进去的那个函数返回 Promise」**永远为真**
    //   （见文件头「恒绿断言」那段）。只有拦**原始函数**才验得到我们自己写的东西。
    const captured: { method: string; handler: unknown }[] = [];
    const original = Server.prototype.setRequestHandler;
    Server.prototype.setRequestHandler = function patched(this: Server, schema, handler) {
      captured.push({
        method: (schema as unknown as { shape?: { method?: { value?: string } } }).shape?.method
          ?.value as string,
        handler,
      });
      return original.call(this, schema, handler);
    } as typeof Server.prototype.setRequestHandler;

    try {
      const store = new MemoryStore({
        dbPath: join(mkdtempSync(join(tmpdir(), 'mcp-async-')), 'db'),
      });
      try {
        createMcpServer(store);
      } finally {
        store.close();
      }
    } finally {
      Server.prototype.setRequestHandler = original;
    }

    const callHandler = captured.find((item) => item.method === 'tools/call')?.handler;
    const listHandler = captured.find((item) => item.method === 'tools/list')?.handler;
    expect(callHandler, '没有注册 tools/call 的处理器').toBeDefined();
    expect(listHandler, '没有注册 tools/list 的处理器').toBeDefined();

    // 正：tools/call 的处理器是 AsyncFunction（把 async 去掉 ⇒ 红）
    expect((callHandler as object).constructor.name).toBe('AsyncFunction');
    // 反：tools/list 的处理器**不是** async（证明这条断言真的在读函数种类，不是恒真）
    expect((listHandler as object).constructor.name).not.toBe('AsyncFunction');
  });

  it('★ `dispatchTool` 仍然同步返回（库没有因为 MCP 而被 async 化）', async () => {
    await wireCall('write', { content: '同步性证据' });
    const raw: unknown = dispatchTool(harness.store, 'recall', { context: '同步性证据' });
    expect(raw instanceof Promise).toBe(false);
    expect((raw as { then?: unknown }).then).toBeUndefined();
  });
});
