import { defineConfig } from 'vitest/config';

/**
 * vitest 配置。
 *
 * ⚠️ `pool: 'forks'` 是**硬性要求**，不是偏好：
 * better-sqlite3 是同步原生模块（`.node` 扩展），在 vitest 默认的 `threads` 池下
 * 会偶发 `ERR_DLOPEN_FAILED` / 段错误——表现是「本地过、CI 挂」，且极难定位。
 * ⇒ 锁死 `forks`（DEVELOPMENT-PLAN.md P0-T01 常见坑第 1 条）。
 */
export default defineConfig({
  /**
   * ⚠️ **必须与 `tsconfig.json` 的 `"jsx": "react-jsx"` 同批保持一致**（p5-t01-t05-design.md §8 R3）：
   * · `automatic`（= react-jsx）⇒ esbuild 自动注入 `react/jsx-runtime`，源码里**不用**写 `import React`；
   * · 两者一个 automatic、一个 classic ⇒ 症状是 `React is not defined`，
   *   而且它往往在**第 17 个**面板文件里才炸，最费时间。
   * ⚠️ **不装 `@vitejs/plugin-react`**：它会顺带改 `jsxDev` 与 Fast Refresh，
   *   而门禁不需要这两个能力（渲染测试走 `react-dom/server` 的 `renderToStaticMarkup`）。
   */
  esbuild: { jsx: 'automatic' },
  test: {
    pool: 'forks',
    environment: 'node',
    /**
     * ⚠️ `'mcp/**\/*.test.ts'` 这条 glob 不是「顺手加的」：
     * DEVELOPMENT-PLAN.md 的 P5-T05 把测试路径**逐字**指定为 `mcp/tools.test.ts`。
     * 不收集 ⇒ 那个文件**根本不会跑**（不是「跑过了」，是「没跑」，而且**不报错**）。
     * ⚠️ `viewer/**` 的测试**一律放 `tests/integration/`**（纯 `.ts` import `.tsx`），
     * 不在 `viewer/` 下放 `.test.tsx` —— 与「测试集中在 `tests/`」的既有布局一致
     * （`src/**\/*.test.ts` 是纯函数同桌单测的唯一例外）。
     */
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'mcp/**/*.test.ts'],
    exclude: ['tests/**/node_modules/**', 'tests/golden/__captured__/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
