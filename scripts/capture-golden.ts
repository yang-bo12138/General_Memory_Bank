#!/usr/bin/env tsx
/**
 * golden 集采集 CLI —— DEVELOPMENT-PLAN.md P0-T03。
 *
 * ⚠️ **本脚本只负责「采集」**，不负责「判定」——
 *   判定由 `tests/baseline/compare.ts`（逐位比对）与 CI 断言脚本负责。
 *
 * 用法：
 * ```
 * pnpm exec tsx scripts/capture-golden.ts \
 *   --out tests/golden/__captured__/baseline.jsonl \
 *   --adapter tests/fixtures/adapters/deterministic.ts \
 *   --flags baseline
 *
 * pnpm exec tsx scripts/capture-golden.ts ... --flags baseline --on coactivation
 * ```
 *
 * · `--out`     golden 文件的输出路径（JSONL，D-08）
 * · `--adapter` 适配器模块路径；该模块必须导出 `createAdapter(): RefV1Adapter`
 * · `--flags`   `baseline`（四个布尔开关全关 + `VECTOR_ROUTER='flat'`）| `default`
 * · `--on`      在 `--flags` 的基础上**额外打开**某一个开关（可重复）
 * · `--label`   本次运行的标识（写进 meta 行）
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { BASELINE_FLAGS, type FeatureFlags, resolveFlags } from '../src/core/flags.js';
import { DEFAULT_PARAMS, type Params } from '../src/core/params.js';
import { type RefV1Adapter, captureRefV1Run } from '../tests/baseline/ref-v1.js';
import { captureToFile } from '../tests/golden/capture.js';
import type { GoldenLine, GoldenRecord } from '../tests/golden/golden-format.js';

/** 解析命令行参数。 */
function parseCliArgs(argv: string[]): {
  out: string;
  adapter: string;
  flags: 'baseline' | 'default';
  on: string[];
  label: string;
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      adapter: { type: 'string' },
      flags: { type: 'string' },
      on: { type: 'string', multiple: true },
      label: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.out === undefined || values.adapter === undefined) {
    throw new Error('必须提供 --out 与 --adapter');
  }
  const flags = values.flags ?? 'baseline';
  if (flags !== 'baseline' && flags !== 'default') {
    throw new Error(`--flags 只能是 baseline 或 default，收到：${flags}`);
  }

  return {
    out: values.out,
    adapter: values.adapter,
    flags,
    on: values.on ?? [],
    label: values.label ?? `${flags}${values.on?.length ? `+${values.on.join('+')}` : ''}`,
  };
}

/** 按 `--flags` / `--on` 算出本次运行生效的参数与开关。 */
function resolveRunConfig(
  mode: 'baseline' | 'default',
  on: string[],
): { params: Params; flags: FeatureFlags } {
  const params: Params =
    mode === 'baseline'
      ? {
          ...DEFAULT_PARAMS,
          coactivation: BASELINE_FLAGS.coactivation,
          inhibition: BASELINE_FLAGS.inhibition,
          writeBack: BASELINE_FLAGS.writeBack,
          ARCHIVAL_CACHE: BASELINE_FLAGS.ARCHIVAL_CACHE,
          VECTOR_ROUTER: BASELINE_FLAGS.VECTOR_ROUTER,
        }
      : { ...DEFAULT_PARAMS };

  for (const key of on) {
    if (key === 'VECTOR_ROUTER') {
      throw new Error('--on VECTOR_ROUTER 不是布尔开关；请直接用 --flags 选基线或用适配器传入三值');
    }
    if (!(key in params)) {
      throw new Error(`未知开关：${key}`);
    }
    (params as unknown as Record<string, boolean>)[key] = true;
  }

  return { params, flags: resolveFlags(params) };
}

/** 主流程。 */
async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const { params, flags } = resolveRunConfig(args.flags, args.on);

  const adapterPath = resolve(process.cwd(), args.adapter);
  const module = (await import(pathToFileURL(adapterPath).href)) as {
    createAdapter?: () => RefV1Adapter;
  };
  if (typeof module.createAdapter !== 'function') {
    throw new Error(`适配器模块必须导出 createAdapter(): ${adapterPath}`);
  }
  const adapter = module.createAdapter();

  const lines: GoldenLine[] = captureRefV1Run(adapter, {
    label: args.label,
    flags: flags as unknown as Record<string, unknown>,
    params: params as unknown as Record<string, unknown>,
  });

  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  captureToFile(
    outPath,
    {
      label: args.label,
      flags: flags as unknown as Record<string, unknown>,
      params: params as unknown as Record<string, unknown>,
    },
    lines.filter((line): line is GoldenRecord => line.kind === 'record'),
  );

  process.stdout.write(`golden 已写入：${outPath}（${lines.length - 1} 条记录）\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`capture-golden 失败：${String(error)}\n`);
  process.exitCode = 1;
});
