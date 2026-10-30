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
  test: {
    pool: 'forks',
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/**/node_modules/**', 'tests/golden/__captured__/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
