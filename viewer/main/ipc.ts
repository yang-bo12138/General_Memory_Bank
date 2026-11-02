/**
 * ★ **IPC 注册层** —— 阶段 5 · P5-T01（设计 §3.3 第 13 项 / §4.4）。
 *
 * 8 条通道，逐条写死（`READ_CHANNELS`）。**不做 SQL 透传、不接受 `dbPath`**：
 *   · `mem:select` 只收**查询名**与绑定参数（SQL 文本在 `queries.ts` 的常量里）；
 *   · 库文件路径在 `WorkerHost` 的**构造参数**里（由 `viewer/main/index.ts` 从
 *     `argv` / `app.getPath` 取）⇒ renderer 没有任何一条通道能把路径塞进来。
 *
 * ⚠️ ★ **本文件刻意 `import 'electron'` 的次数是 0**（设计 §2.5 第 2 条只允许
 *   `viewer/main/index.ts` 与 `viewer/preload/index.ts` 各 import 一次）。
 *   做法是把「注册动作」**注入**进来：`register(channel, listener)`。
 *   收益不只是「少一个 import」——
 *   它让**这一层可以在 vitest 里被直接测**（设计要求的「通道白名单 8 条」、
 *   「8 个方法名恰好 8 个」、「不接受 renderer 传 dbPath」三条断言，
 *   原先只能靠读源码，现在可以真的调一遍）。
 *
 * ⚠️ **失败一律返回信封、不抛错**（见 `ReadEnvelope` 的说明）：Electron 会把
 *   `handle` 里抛出的 `Error` 拍平成一个字符串，`code` / `details` 全丢。
 */

import { MemoryError } from '../../src/core/errors.js';
import { READ_CHANNELS, type ReadChannel } from '../shared/channels.js';
import type { LogQuery, ReadEnvelope, RecallSimInput } from '../shared/protocol.js';
import { LOG_PAGE_SIZE } from '../shared/protocol.js';
import { type SqlQueryName, isSqlQueryName } from '../shared/sql-names.js';
import { type WorkerHost, WorkspaceFailure } from './worker-host.js';

/**
 * 注册函数（就是 `ipcMain.handle` 的**形状**，但由调用方注入）。
 *
 * @param channel 通道名
 * @param listener Electron 的 `handle` 监听器形状：`(event, ...args) => Promise<...>`
 */
export type IpcRegistrar = (
  channel: string,
  listener: (event: unknown, ...args: unknown[]) => Promise<ReadEnvelope<unknown>>,
) => void;

/** 一条通道的处理函数：只收**位置参数**，返回该通道的数据。 */
type ChannelHandler = (args: readonly unknown[]) => Promise<unknown>;

// ─────────────────────────── 入参清洗（IPC 来的都是 unknown）───────────────────────────

/** 取一个可选的时间戳（毫秒）。非法 ⇒ 抛 `INVALID_INPUT`（**不静默当 undefined**）。 */
function optionalTimestamp(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw MemoryError.invalidInput(`${key} 必须是有限数值（epoch 毫秒）`, { key });
  }
  return value;
}

/** 取一个必填的非空字符串。 */
function requiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw MemoryError.invalidInput(`${key} 必须是非空字符串`, { key });
  }
  return value;
}

/** 取一个可选的整数值（带上下界）。 */
function optionalInteger(
  value: unknown,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw MemoryError.invalidInput(`${key} 必须是 [${min}, ${max}] 区间内的整数`, {
      key,
      min,
      max,
    });
  }
  return value;
}

/** 取一个可选的字符串数组（元素非空）。 */
function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw MemoryError.invalidInput(`${key} 必须是非空字符串组成的数组`, { key });
  }
  return value as string[];
}

/**
 * ★ 清洗面板 3 的入参：**只认白名单字段**。
 *
 * ⚠️ `reinforce` **不进白名单**（它是「采纳」，属于宿主，不属于只读观察器）
 *   ⇒ 即使 renderer 传 `{ reinforce: true }`，它也**根本不会被抄进**返回对象。
 *   这是「`reinforce` 恒 false」的第三道防线（另两道：`RecallSimInput` 的类型、
 *   `db-worker.ts` 的 `runRecallSimulation`）。
 */
export function sanitizeRecallInput(value: unknown): RecallSimInput {
  const source = (value ?? {}) as Record<string, unknown>;
  const context = requiredString(source.context, 'context');
  const topN = optionalInteger(source.topN, 'topN', 1, 8);
  const entityNames = optionalStringArray(source.entityNames, 'entityNames');
  return {
    context,
    ...(topN === undefined ? {} : { topN }),
    ...(entityNames === undefined ? {} : { entityNames }),
    reinforce: false,
  };
}

/** 清洗面板 5 的查询。 */
export function sanitizeLogQuery(value: unknown): LogQuery {
  const source = (value ?? {}) as Record<string, unknown>;
  const year = optionalInteger(source.year, 'year', 1970, 9999);
  const month = optionalInteger(source.month, 'month', 1, 12);
  if (year === undefined || month === undefined) {
    throw MemoryError.invalidInput('logs 查询必须给 year 与 month', { keys: ['year', 'month'] });
  }
  const day = optionalInteger(source.day, 'day', 1, 31);
  const offset = optionalInteger(source.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = optionalInteger(source.limit, 'limit', 1, LOG_PAGE_SIZE);
  const keyword = source.keyword === undefined ? undefined : String(source.keyword);
  return {
    year,
    month,
    ...(day === undefined ? {} : { day }),
    ...(keyword === undefined ? {} : { keyword }),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * ★ 清洗 `mem:select` 的入参：**只认查询名**。
 *
 * ⚠️ 查询名不在 `SQL_QUERY_NAMES` 里 ⇒ 直接拒。**没有**「把 SQL 文本当名字传」的路径：
 *   返回的对象里只有 `name` / `params`，而 `params` 到库线程还要按名字逐个钳值。
 */
export function sanitizeSelectArgs(
  nameValue: unknown,
  params: unknown,
): { name: SqlQueryName; params: unknown } {
  if (!isSqlQueryName(nameValue)) {
    throw new WorkspaceFailure({
      code: 'SQL_GUARD_REJECTED',
      message: `未知的查询名：${String(nameValue)}（renderer 只能传 SQL_QUERY_NAMES 里的名字）`,
      details: { reason: 'unknown_query_name', name: String(nameValue) },
    });
  }
  return { name: nameValue, params: params ?? {} };
}

/** 把任意异常变成信封里的 `WorkspaceError`。 */
function toEnvelopeError(error: unknown): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  if (error instanceof WorkspaceFailure) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof MemoryError) {
    return { code: error.code, message: error.message, details: { ...error.details } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'DATABASE_BUSY', message, details: { reason: 'ipc_unexpected_error' } };
}

/**
 * 构造 8 条通道的处理函数表。
 *
 * ⚠️ 键的集合**恰好**是 `READ_CHANNELS`（`Record<ReadChannel, …>` 是编译期的分母，
 *   运行期再用 `READ_CHANNELS` 逐条注册）。
 */
export function buildChannelHandlers(
  host: WorkerHost,
): Readonly<Record<ReadChannel, ChannelHandler>> {
  return {
    'mem:stats': async (args) => host.call('stats', [optionalTimestamp(args[0], 'now')]),
    'mem:get': async (args) =>
      host.call('get', [requiredString(args[0], 'id'), optionalTimestamp(args[1], 'now')]),
    'mem:recall': async (args) => host.call('recall', [sanitizeRecallInput(args[0])]),
    'mem:clusters': async (args) => host.call('clusters', [optionalTimestamp(args[0], 'now')]),
    'mem:inhibition-trace': async (args) =>
      host.call('inhibitionTrace', [requiredString(args[0], 'context')]),
    // ⚠️ `verifyIntegrity` **不收任何参数**：设计 §6 的公开签名是 `{ deep?: boolean }`，
    //   而深度自检（`integrity_check` 整库逐页）是**维护动作**，只读观察器不该触发它
    //   ⇒ 这里固定调 `verifyIntegrity()`（5 个字段、纯读）。
    'mem:verify-integrity': async () => host.call('verifyIntegrity', []),
    'mem:select': async (args) => {
      const sanitized = sanitizeSelectArgs(args[0], args[1]);
      return host.select(sanitized.name, sanitized.params);
    },
    'mem:logs': async (args) => host.logs(sanitizeLogQuery(args[0])),
  };
}

/**
 * ★ 注册 8 条读通道（**白名单，逐条来自 `READ_CHANNELS`**）。
 *
 * @param host 库线程客户端（**已经带着 dbPath 构造好了**）
 * @param register 注册动作（Electron 下传 `ipcMain.handle` 的包装）
 */
export function registerReadHandlers(host: WorkerHost, register: IpcRegistrar): void {
  const handlers = buildChannelHandlers(host);

  for (const channel of READ_CHANNELS) {
    register(channel, async (_event, ...args) => {
      try {
        return { ok: true, data: await handlers[channel](args) };
      } catch (error) {
        // ⚠️ **不抛**：一抛就会被 Electron 拍平成字符串，`code` / `details` 全丢
        return { ok: false, error: toEnvelopeError(error) };
      }
    });
  }
}
