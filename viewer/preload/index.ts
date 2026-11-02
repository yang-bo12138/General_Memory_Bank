/**
 * ★ **preload 桥** —— 阶段 5 · P5-T01（设计 §3.3 第 14 项 / §1.1 架构图第二层）。
 *
 * 职责**只有转发**：把 renderer 的 `window.gmb.read.<method>(…)` 变成
 * `ipcRenderer.invoke('mem:<name>', …)`，再把主进程回来的**信封**变回一个 Promise。
 * 组装逻辑在 `./bridge.js`（纯逻辑、零 electron 依赖 ⇒ 可被 vitest 直接测），
 * 本文件只留「接线」三行。
 *
 * ⚠️ **本文件不 import `better-sqlite3`、不碰文件、不碰 SQL** —— 它连 `fs` 都没有。
 *
 * ⚠️ ★ **它必须 `import 'electron'`**（`contextBridge` / `ipcRenderer` 只能从那里来）。
 *   设计 §2.5 第 2 条写的是「**只有** `viewer/main/index.ts` 允许 import electron」——
 *   那条**在物理上做不到**（preload 不 import electron 就什么也做不了）。
 *   ⇒ 本轮把那条纪律落成它的**真实形态**：允许 import electron 的文件恰好是
 *     `viewer/main/index.ts` 与 `viewer/preload/index.ts` **两个**，且**任何测试都不 import 它们**
 *     （`tests/integration/viewer-worker.test.ts` 用写死的白名单扫，多一个就红）。
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { ReadChannel } from '../shared/channels.js';
import type { ReadEnvelope } from '../shared/protocol.js';
import { buildBridge } from './bridge.js';

contextBridge.exposeInMainWorld(
  'gmb',
  buildBridge(
    async (channel: ReadChannel, ...args: unknown[]): Promise<ReadEnvelope<unknown>> =>
      (await ipcRenderer.invoke(channel, ...args)) as ReadEnvelope<unknown>,
  ),
);
