/**
 * ★ 库线程测试用的 **TS 注册钩子**（阶段 5 · T02）。
 *
 * 用途：`WorkerHost` 起 `db-worker.ts` 时把本文件交给 `execArgv: ['--import', <本文件 URL>]`。
 *
 * ⚠️ **为什么不是 `execArgv: ['--import', 'tsx']`**（设计 §3.7 的写法）：
 *   实测（Node v22.22.2 / tsx 4.23.15）在 **worker 线程**里，`--import tsx` **不生效**：
 *   Node 22.18+ 自带类型剥离 ⇒ `.ts` 入口能被加载，但 tsx 的 resolver 没挂上
 *   ⇒ 仓库里那句 `import … from '../../src/core/errors.js'`（指向 `.ts` 文件）
 *   直接报 `Cannot find module ... errors.js`。
 *   而同一个 `--import tsx` 在**主线程**（`node --import tsx -e`）是好的
 *   ⇒ 这是 worker 线程独有的问题，不是配置写错。
 *   ⇒ 改成「显式注册」：本文件在 worker 线程里调 `tsx` 的 `register()`，
 *     把 resolver 挂到**那个线程**上。这一改动只影响测试的启动方式，
 *     产品代码（`db-worker.ts`）一行没动。
 *
 * ⚠️ 本文件是 `.mjs`（不是 `.ts`）：它必须在**任何 TS 支持挂上之前**就能跑
 *   —— 它是「挂 TS 支持」这件事本身。
 */

import { register } from 'tsx/esm/api';

register();
