/**
 * ★ **preload 的桥体（纯逻辑，不 import `electron`）** —— 阶段 5 · P5-T01。
 *
 * ⚠️ **为什么单独一个文件**：设计 §3.3 只列了 `viewer/preload/index.ts`，
 *   而「preload 恰好暴露 8 个方法」这条验收项**无法**在那个文件上做运行时断言
 *   —— 它一到顶层就 `contextBridge.exposeInMainWorld(...)`，一 import 就需要真的 Electron
 *   （而任何测试都不得 `require('electron')`：二进制没装，会抛 *failed to install correctly*）。
 *   ⇒ 把「怎么组出 8 个方法」抽到这里（**零 electron 依赖**），`index.ts` 只留三行接线。
 *   收益：「只暴露 8 个方法」从「读源码数一数」变成「`Object.keys()` 真的数一遍」。
 *
 * ⚠️ **本文件不碰库、不碰文件、不碰 SQL**：它只会把方法名映射成通道名再交出去。
 */

import { READ_CHANNELS, READ_CHANNEL_METHODS, type ReadChannel } from '../shared/channels.js';
import type { ReadEnvelope } from '../shared/protocol.js';

/**
 * 把信封变成「resolve 数据 / reject 带码的错误」。
 *
 * ⚠️ 错误对象上**既**挂 `code` / `details`（同进程可读）**又**把三者序列化进 `message`
 *   （跨 `contextBridge` 克隆之后 `code` / `details` 会没，`message` 还在）
 *   ⇒ 两条件同时满足，`asWorkspaceError()` 两侧都能还原。
 */
export function unwrapEnvelope<T>(envelope: ReadEnvelope<T>): T {
  if (envelope.ok) {
    return envelope.data;
  }
  const serialized = JSON.stringify(envelope.error);
  const error = new Error(serialized);
  Object.assign(error, {
    name: 'WorkspaceError',
    code: envelope.error.code,
    details: envelope.error.details,
  });
  throw error;
}

/**
 * 桥上的方法名（**`ReadPort` 的方法名，不是通道名**）。
 *
 * ⚠️ 从 `READ_CHANNEL_METHODS` 的**值**取 ⇒ 加了通道却忘了加方法名会编译红；
 *   反过来把键写成通道名（`read['mem:stats']`）也会编译红。
 */
export type ReadMethodName = (typeof READ_CHANNEL_METHODS)[ReadChannel];

/** `window.gmb` 的形状：`read` 上**恰好** 8 个方法。 */
export interface GmbBridge {
  /** 8 个只读方法（键是方法名：`stats` / `get` / …）。 */
  read: Readonly<Record<ReadMethodName, (...args: unknown[]) => Promise<unknown>>>;
}

/**
 * 组装桥体。
 *
 * @param invoke 真正发 IPC 的函数（Electron 下是 `(channel, ...args) => ipcRenderer.invoke(...)`）
 * @returns `{ read: { stats, get, recall, clusters, inhibitionTrace, verifyIntegrity, select, logs } }`
 */
export function buildBridge(
  invoke: (channel: ReadChannel, ...args: unknown[]) => Promise<ReadEnvelope<unknown>>,
): GmbBridge {
  const read: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const channel of READ_CHANNELS) {
    // ⚠️ renderer 看到的键是**方法名**（`read.stats`），不是通道名（`read['mem:stats']`）⇒
    //   映射只从 `READ_CHANNEL_METHODS` 取，不在这里手抄第二份。
    const method = READ_CHANNEL_METHODS[channel];
    read[method] = async (...args: unknown[]): Promise<unknown> => {
      const envelope = await invoke(channel, ...args);
      return unwrapEnvelope(envelope);
    };
  }

  return { read: read as GmbBridge['read'] };
}
