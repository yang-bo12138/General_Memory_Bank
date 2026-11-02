/**
 * ★ **原生模块加载探针（子进程脚本）** —— QA 独立验收探针的运行时那一半。
 *
 * 用法（由 `tests/integration/qa-p5-independent-probe.test.ts` 起子进程调用）：
 *
 * ```
 * node --import tsx tests/helpers/nativeLoadProbe.ts ./viewer/renderer/App.tsx
 * ```
 *
 * 做什么：**在导入目标模块之前**钩住 `Module._load`，记录被 `require()` 进来的
 * 「原生/库」模块；导入完成后打印一行 `PROBE_RESULT {…}`。
 *
 * ⚠️ **为什么必须在子进程里做**：vitest 的测试进程本身已经 `import` 过
 *   `MemoryStore`（探针 ① 要用），better-sqlite3 早已在进程里 ⇒ 同进程内
 *   「有没有被拉进来」这件事**无法区分**。
 *
 * ⚠️ **钩 `Module._load` 而不是 `process.dlopen`**：实测（v22 / better-sqlite3 13）
 *   `.node` 绑定**不走** `process.dlopen` 之外的路径可观测，但 `bindings` 包解析后是
 *   通过 `require('better-sqlite3')` 这一层进入的 ⇒ 钩 `Module._load` 既能命中
 *   「包被 require」也能命中 `.node` 文件，覆盖面更大。
 *
 * ⚠️ **必须有正控**：只断言「renderer 没加载 better-sqlite3」是可能恒真的
 *   （探针写错了也过）。测试里会先跑一次 `./viewer/main/db-worker.ts`
 *   ——它**必须**被检出，否则检测法本身无效。
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 命中的模块 id（`require` 的入参）。 */
const loaded: string[] = [];

const nodeModule = createRequire(import.meta.url)('node:module') as {
  _load?: (...args: unknown[]) => unknown;
};

const originalLoad = nodeModule._load;

if (typeof originalLoad === 'function') {
  nodeModule._load = function patched(this: unknown, ...args: unknown[]): unknown {
    const id = args[0];
    if (
      typeof id === 'string' &&
      (id.includes('better') || id.includes('sqlite') || id.endsWith('.node'))
    ) {
      loaded.push(`require:${id}`);
    }
    return (originalLoad as (...a: unknown[]) => unknown).apply(this, args);
  };
}

// ⚠️ 目标按**仓库根（cwd）**解析，不是按本文件解析：
//   测试传的是 `./viewer/renderer/App.tsx` 这种「相对仓库根」的路径。
const target = pathToFileURL(join(process.cwd(), process.argv[2] as string)).href;

await import(target);

console.log(`PROBE_RESULT ${JSON.stringify({ target, loaded })}`);
