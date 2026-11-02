/**
 * ★ **Electron 主进程入口** —— 阶段 5 · P5-T01（设计 §3.3 第 15 项 / §2.5 D4）。
 *
 * 这一层刻意**很薄**（设计「零、边界」那张表）：只做四件事
 *   ① 解析库路径（`argv` 或 `app.getPath('userData')`）；
 *   ② 起库线程（`WorkerHost`）；
 *   ③ 把 `ipcMain.handle` 交给 `ipc.ts` 的 `registerReadHandlers`；
 *   ④ 开一个**上下文隔离**的窗口。
 *
 * ⚠️ **本文件是整个 `viewer/**` 里唯一 import `electron` 的主进程文件**
 *   （另一个是 `viewer/preload/index.ts`，物理上必需；见那个文件的说明）。
 *   ⇒ 它**不进任何测试的依赖图**：vitest 永远不 import 它，
 *     所以「Electron 二进制没装」不会让门禁挂（设计 §2.5 第 3 条）。
 *
 * ⚠️ **它不碰库、不碰 SQL、不碰文件**：
 *   `better-sqlite3` 只在 `db-worker.ts` 里出现 ⇒ 「全部库调用在库线程」这条
 *   不是纪律，是**依赖方向**（设计 §7.1：`shared` → `main` → `preload` → `renderer`）。
 *
 * ⚠️ **本轮不打包**（无 `electron-builder`、无签名、无自动更新）：本机无显示器，
 *   而「能双击运行」这件事**一条断言都产不出来**。⇒ 打包轮必须新建
 *   `viewer/package.json`（设计 §8 R6），**不动**根 `package.json` 的 `files` / `dependencies`。
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, ipcMain } from 'electron';

import { registerReadHandlers } from './ipc.js';
import { WorkerHost } from './worker-host.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * 解析库文件路径。
 *
 * ⚠️ **只从主进程取**（设计 §4.2 硬规则 ②）：
 *   ① `--db=<路径>` 命令行参数（打包后的用户会这么指）；
 *   ② 否则 `<userData>/memory.db`（Electron 的每应用数据目录）。
 *   ⇒ renderer **没有任何通道**能把路径塞进来（`ipc.ts` 的 8 条通道都不收 `dbPath`）。
 */
function resolveDbPath(argv: readonly string[]): string {
  const explicit = argv.find((arg) => arg.startsWith('--db='));
  if (explicit !== undefined) {
    return explicit.slice('--db='.length);
  }
  return join(app.getPath('userData'), 'memory.db');
}

/** 开主窗口。 */
async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: '通用记忆库 · 只读观察器',
    webPreferences: {
      // ★ 三条一起才叫「上下文隔离」：少了任何一条，renderer 都能摸到 Node / 库
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(HERE, '..', 'preload', 'index.js'),
    },
  });

  // ⚠️ 本轮 `index.html` 由 `viewer/renderer/index.html` 提供（打包轮才真正用到）；
  //   它不在门禁的扫描面内（面板被 `renderToStaticMarkup` 直接渲染，不经浏览器）。
  await window.loadFile(join(HERE, '..', 'renderer', 'index.html'));
  return window;
}

/** 整个应用的生命周期。 */
async function main(): Promise<void> {
  await app.whenReady();

  // ⚠️ 库线程在**窗口之前**起：窗口一打开就会请求数据，
  //   晚起会让首屏必然经历一次 20s 级别的等待（`WorkerHost#ready` 才刚发出 open）。
  const host = new WorkerHost({ dbPath: resolveDbPath(process.argv) });

  // ⚠️ **注册动作注入**（而不是在 `ipc.ts` 里直接 `ipcMain.handle`）：
  //   那一层因此是纯 Node，能在 vitest 里被真的调一遍（8 条通道、不接受 dbPath）。
  registerReadHandlers(host, (channel, listener) => {
    ipcMain.handle(channel, listener);
  });

  try {
    await host.ready();
  } catch (error) {
    // ⚠️ 库打不开**不静默退出**：窗口照开，错误会在第一个 `mem:*` 请求时以
    //   「错误码 + details」的形式显示出来（这是设计 §7.2 要的形态：
    //   用户能自己区分「库里没有」与「查询错了」）。
    process.stderr.write(`库线程启动失败：${String(error)}\n`);
  }

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

void main();
