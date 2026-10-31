#!/usr/bin/env tsx
/**
 * 门禁入口的可见性检查 —— 防「**假绿闸门**」。
 *
 * ⚠️ **为什么必须有这个检查**（QA 报告 §三·1 的 [高] 项）：
 *   `pnpm ci` / `npm ci` 是**包管理器的内建命令**（clean install），
 *   它会**遮蔽同名 script** ⇒ `pnpm ci` 退出码 0，但**一条契约脚本都没跑**。
 *   这正是设计稿 C31 警告的症状：「一个从不失败的闸门，看起来在把关」。
 *
 * ⇒ 因此，门禁的形状被钉死成：
 *   1. **规范入口叫 `verify`** —— 它**不是**任何包管理器的内建命令名
 *      ⇒ `pnpm run verify`（以及裸 `pnpm verify`）都只会跑我们的脚本；
 *   2. **`scripts.ci` 只是别名**，内容**恰好**等于 `pnpm run verify`；
 *      ⚠️ 裸 `pnpm ci` / `npm ci` 走的是内建 clean-install，**不做任何校验**；
 *   3. `scripts.verify` 的每一段都必须写成 `pnpm run <名>` —— 写成裸 `pnpm ci`
 *      会再次被内建命令遮蔽（所以本模块逐段校验**写法**）。
 *
 * ⚠️ **分母必须是写死的期望值**（C31）：
 *   `EXPECTED_GATE_COMMANDS`（10 条门禁）是本模块里的**常量数组**，
 *   **不是**「本次解析出来有几条」——后者会让「少了一条」看起来像「全绿」。
 *
 * ⚠️ 本模块既可被 `scripts/check-contract-ids.ts` 内联调用（⇒ 每跑一次
 *   `pnpm run verify` 都会验一遍），也可单独运行：
 *   `pnpm run check:gate-entry`
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ★ **写死的期望值**：门禁必须串起的 **10 条子命令**（C31 的分母）。
 *
 * ⚠️ 这 10 条是「阶段 0 的全部验收门禁 + F-08 ③ 的静态守卫」：
 *   类型检查 → 代码风格 → 单元测试 → 7 条契约脚本。
 *   改这个数组等于改「门禁是什么」，必须是一次**显式**的改动。
 *
 * ⚠️ **加一条门禁就必须同步改这个数组**（否则 `check:contract-ids` 内联调用本模块时
 *   会以「多出 / 缺少」的形式把门禁链卡红）⇒ 这是 C31「分母写死」的必然代价，
 *   不是本模块在阻碍变化。
 */
export const EXPECTED_GATE_COMMANDS: readonly string[] = [
  'typecheck',
  'lint',
  'test',
  'check:params',
  'check:payload-keys',
  'check:clock',
  'check:anchor',
  'check:contract-ids',
  'check:doc-counts',
  'check:clamp',
];

/**
 * ★ **写死的期望值**：`scripts.ci` 的内容必须**恰好**等于这个字符串。
 *
 * ⚠️ `ci` 只能当**别名**用：它是包管理器的内建命令名，
 *   裸 `pnpm ci` / `npm ci` 永远走 clean install，**不做任何校验**。
 */
export const EXPECTED_CI_ALIAS = 'pnpm run verify';

/**
 * ★ **写死的期望值**：pnpm 的**内建命令名**（pnpm 12.16.1 的 `pnpm --help` 全量）。
 *
 * ⚠️ `pnpm <名>` 优先走内建命令，**同名 script 不会被执行** ⇒
 *   内建命令名**不能**用作门禁入口名（`ci` 就是现成的例子）。
 * ⚠️ 这张表是「假绿闸门」的**根因表**，也是本模块存在的原因。
 */
export const PNPM_BUILTIN_COMMANDS: readonly string[] = [
  'access',
  'add',
  'audit',
  'bugs',
  'cache',
  'ci',
  'completion',
  'config',
  'create',
  'dedupe',
  'deploy',
  'deprecate',
  'dist-tag',
  'dlx',
  'docs',
  'doctor',
  'edit',
  'exec',
  'fetch',
  'help',
  'home',
  'i',
  'import',
  'info',
  'init',
  'install',
  'link',
  'list',
  'login',
  'logout',
  'ls',
  'outdated',
  'owner',
  'pack',
  'publish',
  'prune',
  'rebuild',
  'remove',
  'repo',
  'root',
  'run',
  'run-script',
  'self-update',
  'setup',
  'start',
  'stop',
  'store',
  'test',
  'uninstall',
  'unlink',
  'unpublish',
  'update',
  'version',
  'view',
  'whoami',
  'why',
];

/** `package.json` 里本模块用得到的部分。 */
export interface PackageJsonLike {
  scripts?: Record<string, string | undefined>;
}

/** 一处不一致。 */
export interface GateEntryDiff {
  reason: string;
}

/**
 * 把 `scripts.verify` 拆成「调用了哪些脚本」。
 *
 * ⚠️ **同时校验每一段的写法**：必须是 `pnpm run <名>`。
 *   写成裸 `pnpm ci` / `npm ci` 会被包管理器的内建命令遮蔽 ⇒ 假绿。
 *
 * @param scriptBody `scripts.verify` 的原文
 * @returns 逐段解析结果（`malformed` 里是被遮蔽/写法不对的段）
 */
export function parseVerifyChain(scriptBody: string): {
  names: string[];
  malformed: string[];
} {
  const names: string[] = [];
  const malformed: string[] = [];

  for (const rawSegment of scriptBody.split('&&')) {
    const segment = rawSegment.trim();
    if (segment === '') {
      continue;
    }
    const match = /^pnpm run ([A-Za-z][A-Za-z0-9:._-]*)$/.exec(segment);
    if (match === null) {
      malformed.push(segment);
      continue;
    }
    names.push(match[1] ?? '');
  }

  return { names, malformed };
}

/**
 * 比对两个名字集合（**逐名**比对，不是比数量）。
 *
 * ⚠️ C31：只比「数量 == N」是另一种假绿 —— 数量对上了但**名字对不上**，
 *   闸门照样显示全绿。
 *
 * @param expected 写死的期望名单
 * @param actual 实际解析出来的名单
 * @param label 差异说明里的分组名
 */
export function compareNameSets(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): GateEntryDiff[] {
  const diffs: GateEntryDiff[] = [];
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  const duplicated = actual.filter((name, index) => actual.indexOf(name) !== index);

  if (missing.length > 0) {
    diffs.push({ reason: `${label}：缺少 ${missing.join(' / ')}` });
  }
  if (extra.length > 0) {
    diffs.push({ reason: `${label}：多出 ${extra.join(' / ')}` });
  }
  if (duplicated.length > 0) {
    diffs.push({ reason: `${label}：重复 ${[...new Set(duplicated)].join(' / ')}` });
  }
  return diffs;
}

/**
 * 检查门禁入口的可见性。
 *
 * @param pkg `package.json` 的内容
 * @returns 不一致清单（空数组 = 全部合规）
 */
export function checkGateEntry(pkg: PackageJsonLike): GateEntryDiff[] {
  const diffs: GateEntryDiff[] = [];
  const scripts = pkg.scripts ?? {};

  // ── ① `scripts.ci` 只能是转发别名 ──
  const ci = scripts.ci;
  if (ci !== EXPECTED_CI_ALIAS) {
    diffs.push({
      reason: `scripts.ci 必须是「${EXPECTED_CI_ALIAS}」，实际是「${ci ?? '(不存在)'}」`,
    });
  }

  // ── ② 规范入口名不得被包管理器遮蔽 ──
  // ⚠️ `ci` 确实在内建命令表里（这正是「裸 pnpm ci 不跑门禁」的原因），
  //   而规范入口 `verify` **必须不在**表里，否则 `pnpm verify` 也会被遮蔽。
  if (PNPM_BUILTIN_COMMANDS.includes('verify')) {
    diffs.push({
      reason: '规范入口名 verify 是 pnpm 的内建命令名 ⇒ 裸 pnpm verify 不会跑门禁',
    });
  }
  if (!PNPM_BUILTIN_COMMANDS.includes('ci')) {
    diffs.push({
      reason:
        'ci 不再是 pnpm 的内建命令名 ⇒「裸 pnpm ci 不做校验」的前提已变，README 的警告需要更新',
    });
  }

  // ── ③ `scripts.verify` 的链：写法 + 名单 + 每条都真的存在 ──
  const verify = scripts.verify;
  if (verify === undefined) {
    diffs.push({ reason: 'scripts 里没有 verify' });
    return diffs;
  }

  const { names, malformed } = parseVerifyChain(verify);
  for (const segment of malformed) {
    diffs.push({
      reason: `scripts.verify 里的「${segment}」不是「pnpm run <脚本名>」的写法（裸 pnpm ci 会被内建命令遮蔽 ⇒ 假绿）`,
    });
  }
  diffs.push(...compareNameSets(EXPECTED_GATE_COMMANDS, names, 'scripts.verify 的门禁链'));

  // ⚠️ 名单齐了还不够：每个名字都必须**真的**是一个可执行的 script，
  //   否则 `pnpm run <名>` 会直接失败（那时是「报错」而不是「假绿」，但仍要拦）。
  for (const name of names) {
    if (scripts[name] === undefined) {
      diffs.push({ reason: `scripts.verify 引用了 scripts 里不存在的 ${name}` });
    }
  }

  return diffs;
}

/**
 * 读仓库根的 `package.json`。
 *
 * ⚠️ 路径相对**本文件**解析（而不是 cwd）⇒ 在任何工作目录下跑都读得到同一个文件。
 */
export function readPackageJson(): PackageJsonLike {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJsonLike;
}

/** 主流程（仅供单独运行时使用；被 `check-contract-ids.ts` 内联调用时不走这里）。 */
function main(): void {
  const diffs = checkGateEntry(readPackageJson());

  process.stdout.write('门禁入口可见性检查（`pnpm run verify` / `pnpm run ci`）\n');
  process.stdout.write(`  期望链：${EXPECTED_GATE_COMMANDS.join(' → ')}\n`);
  process.stdout.write(`  scripts.ci 必须是：${EXPECTED_CI_ALIAS}\n`);

  if (diffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${diffs.length} 处不一致：\n`);
    for (const diff of diffs) {
      process.stderr.write(`    ${diff.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ 门禁入口可见，且 `scripts.ci` 只是 `pnpm run verify` 的别名\n');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  main();
}
