import { defineConfig } from 'tsup';

/**
 * tsup 配置（DEVELOPMENT-PLAN.md D-02）。
 *
 * 产物：CJS + ESM + `.d.ts` 三份。
 * - `format: ['cjs', 'esm']` ⇒ 同时支持 `require()` 与 `import`。
 * - `dts: true` ⇒ 类型声明随产物一起发布（消费方 `types` 入口指到 `dist/index.d.ts`）。
 * - `clean: true` ⇒ 每次构建前清空 `dist/`，避免陈旧产物混进发布包。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
});
