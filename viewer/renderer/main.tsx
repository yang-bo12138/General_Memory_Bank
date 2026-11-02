/**
 * 查看器渲染进程的**浏览器入口** —— 阶段 5 · T03。
 *
 * ⚠️ ★ **本文件不 import `electron`**：它跑在渲染进程里，拿端口的唯一方式是
 *   preload 通过 `contextBridge` 暴露的 `globalThis.memoryViewer`（设计 §7.1）。
 *   直接 `require('electron')` 会拿到 `undefined`（渲染进程没有主进程模块）
 *   —— 而如果它 import 了 `viewer/preload/index.ts`，那个文件会 `require('electron')`
 *   并在测试环境抛 *failed to install correctly*。
 *
 * ⚠️ **本文件不被任何测试 import**（T02 的扫描断言要求）：
 *   它需要真的 DOM 与 `createRoot`，而测试用 `react-dom/server` 的
 *   `renderToStaticMarkup` 直测 `App` / 面板。
 */

import { createRoot } from 'react-dom/client';

import type { ReadPort } from '../shared/protocol.js';
import { App } from './App.js';

/**
 * preload 注入的端口形状（`buildBridge()` 的产物）。
 *
 * ⚠️ 类型写成 `ReadPort`，**不是** `unknown` 再断言：端口少一个方法时
 *   面板会在第一次调用处炸，而不是在构建期。
 */
interface ViewerGlobal {
  readonly memoryViewer?: ReadPort;
}

const port: ReadPort | null = (globalThis as ViewerGlobal).memoryViewer ?? null;
const container = document.getElementById('root');

if (container !== null) {
  createRoot(container).render(<App port={port} now={Date.now()} />);
}
