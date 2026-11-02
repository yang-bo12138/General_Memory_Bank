/**
 * MCP Server 的 **SDK 薄适配层** —— 阶段 5 · T05（PLAN P5-T05 / 设计 §3.6）。
 *
 * ⚠️ ★ **本文件是全仓库唯一 import MCP 官方 SDK（`@modelcontextprotocol` 的 `sdk` 包）的地方**
 *   （机器可检：`mcp/tools.test.ts` 扫 `src/` + `mcp/` 全树，断言命中文件只有本文件）。
 *   理由（设计 §8 的 R2，发生概率「高」）：SDK 的小版本间改过 API
 *   （`server.tool()` → `server.registerTool()`、`inputSchema` 收 zod 还是收 JSON Schema）
 *   ⇒ 把耦合面压到这一个文件 ⇒ **升级 SDK 只改这里**，`mcp/tools.ts` 的接口与它的断言一行不动。
 *
 * 【为什么用低层的 `Server` 而不是 `McpServer`】
 *   `McpServer.registerTool()` 的 `inputSchema` 要的是 **zod raw shape**
 *   ⇒ 那会逼着 `mcp/tools.ts` 的 JSON Schema 声明改成 zod（多两个依赖 + 版本三角耦合，
 *   设计 §9.2 的 N-05 已裁「用 JSON Schema 字面量」）。
 *   ⇒ 这里直接处理 `tools/list` 与 `tools/call` 两个请求
 *   ⇒ **工具表只有一份（`TOOL_DEFINITIONS`）**，SDK 只是把它原样搬到协议上。
 *
 * 【异步在哪】
 *   库是**全同步** API（ADR-5）。异步**只在最外层**出现：`setRequestHandler` 的处理器是
 *   `async`（协议要求返回 Promise），而它内部调的 `dispatchTool()` **同步返回**
 *   ⇒ 「异步包装」这件事被压在这一层的一句话里，库本体一行 async 都没有。
 *
 * 【错误怎么出去】
 *   §11.2 要求调用方拿到**错误码 + details**，不是裸文本 ⇒ `callTool()` 捕获后把
 *   `{ code, message, details }` 序列化进 `isError: true` 的内容里
 *   （**不吞错、不改写 message / details**）。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { MemoryStore } from '../src/store/MemoryStore.js';
import {
  TOOL_DEFINITIONS,
  type ToolDefinition,
  dispatchTool,
  toToolErrorPayload,
} from './tools.js';

/** `initialize` 握手时报告的服务名。 */
export const SERVER_NAME = 'memory-ocean';

/** 服务版本（与 `package.json` 的 `version` 同源语义；改版本时同步这一处）。 */
export const SERVER_VERSION = '2.1.0';

/**
 * `tools/call` 的返回形状（**故意收窄成纯文本**）：
 * 本服务的每个工具都返回一个 JSON 对象，序列化进一条 `text` 内容
 * ⇒ 调用方 `JSON.parse(content[0].text)` 即可（协议层不需要 `structuredContent`）。
 */
export interface ToolCallResult {
  readonly isError?: boolean;
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
}

/** 把工具声明转成 SDK 的 `Tool`（唯一一处类型断言，见文件头）。 */
function toSdkTool(definition: ToolDefinition): Tool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    // ⚠️ `as unknown as`：SDK 的 `inputSchema.properties` 是「每个值都是 object」的 Record，
    //   而 `ToolDefinition` 用的是 `Record<string, unknown>`（JSON Schema 子树本来就可以是任意 JSON）
    //   ⇒ 这是**一处**结构性断言，而不是宽松的 `any`（其余行仍然逐字受类型检查）。
    inputSchema: definition.inputSchema as unknown as Tool['inputSchema'],
  };
}

/**
 * 执行一次工具调用并**把失败也变成结果**（MCP 的 `isError` 语义，不是 JSON-RPC error）。
 *
 * ⚠️ 为什么不用 JSON-RPC 层的 error：那是「协议坏了」的表达
 *   （未知方法、非法 params）。工具的业务失败（`NOT_FOUND` / `CONFLICT`）是**正常业务结果**
 *   ⇒ 必须以 `isError: true` + 结构化内容回去，否则调用方只看得到一句 message。
 *
 * ⚠️ **同步**：库是同步的，这里不加 `async`（异步在 `createMcpServer` 的处理器上）。
 */
export function callTool(store: MemoryStore, name: string, args: unknown): ToolCallResult {
  try {
    const result = dispatchTool(store, name, args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(toToolErrorPayload(error)) }],
    };
  }
}

/**
 * 造一个注册好 `tools/list` 与 `tools/call` 的 MCP server（**不连接传输层**）。
 *
 * ⚠️ 不在这里 `connect()`：测试要能在**没有 stdin/stdout** 的环境里拿到这个对象
 *   （连接是 `runStdioServer()` 的事）。
 */
export function createMcpServer(store: MemoryStore): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map(toSdkTool),
  }));

  // ★ 异步**只**在这里（协议要求处理器返回 Promise），库与 `dispatchTool()` 全同步。
  // ⚠️ 返回类型标注成 SDK 的 `CallToolResult`：SDK 的处理器签名接受一个**宽**的 ServerResult 联合
  //   （含实验性的 task 变体）⇒ 不标的话 TS 会拿最不相干的那个成员来比。
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = callTool(store, request.params.name, request.params.arguments);
    // ⚠️ 本文件第 2 处、也是最后一处断言：SDK 的 `CallToolResult` 带 `[x: string]: unknown`
    //   的 catchall 索引签名，而 `ToolCallResult` 是**窄**的纯文本形状 ⇒ 结构上不等价。
    //   （代价说明：这两处断言都不改行为，只是把 SDK 的类型噪声挡在本文件内。）
    return result as unknown as CallToolResult;
  });

  return server;
}

/**
 * 以 stdio 传输启动服务（宿主进程里 `await` 它）。
 *
 * ⚠️ stdio 是**本阶段唯一的传输方式**：HTTP/SSE 会把「谁能调这个库」变成一个网络暴露面，
 *   而本库没有认证模型（阶段 5 的 MCP 是**本机宿主**接的）⇒ 不提供。
 */
export async function runStdioServer(store: MemoryStore): Promise<void> {
  await createMcpServer(store).connect(new StdioServerTransport());
}
