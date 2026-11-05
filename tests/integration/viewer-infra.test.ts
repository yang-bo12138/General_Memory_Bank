/**
 * T01 · 工程基础设施的**契约测试**（阶段 5 · `docs/design/p5-t01-t05-design.md` §六 T01 的验收项）。
 *
 * ⚠️ **本文件在设计的文件清单之外**（设计 §3.7 只列了 T02~T05 的 6 个测试文件）。
 *   增加它的理由：T01 的验收项（依赖归属 / 门禁链不变 / `include` 覆盖 / `jsx` 两处一致 /
 *   通道白名单）**全部是机器可判的**，却只落在「设计文档的勾选框」里没人执行
 *   ⇒ 那等于「基础设施轮没有任何门禁」。⇒ 本文件把它们变成断言。
 *   ⚠️ 它**不新增门禁段**（只是 `pnpm test` 里的一个文件），符合设计 §9.2 的 N-04 裁决。
 *
 * ⚠️ **本仓库铁律：每条断言都配反例**。本文件的反例分两类：
 *   ① 把**判据**抽成纯函数，喂一份「故意改坏」的输入，断言同一判据**必须报错**（变异生效）；
 *   ② 真跑一次外部命令（biome），同时断言「被扫到的文件 = 1」与「被忽略的路径 = 0」
 *      —— 后者是前者的反例：证明「Checked 1 file」不是恒真的字符串。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  EXPECTED_GATE_COMMANDS,
  checkGateEntry,
  parseVerifyChain,
} from '../../scripts/check-gate-entry.js';
import { blankComments } from '../../scripts/lib/code-span.js';
import { METHODS_THROWING_READONLY_VIOLATION } from '../../src/core/errors.js';
import {
  READ_CHANNELS,
  READ_CHANNEL_METHODS,
  WRITE_CHANNELS,
} from '../../viewer/shared/channels.js';
import { READ_PORT_METHODS } from '../../viewer/shared/protocol.js';
import { SQL_QUERY_NAMES } from '../../viewer/shared/sql-names.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 把绝对路径变成仓库内相对路径（统一正斜杠，Windows 下也稳定）。 */
function toRepoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).replace(/\\/g, '/');
}

function readText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** `package.json` 里本文件用得到的部分。 */
interface PackageJsonShape {
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** 读 `package.json`。 */
function readPackageJson(): PackageJsonShape {
  return JSON.parse(readText('package.json')) as PackageJsonShape;
}

// ═══════════════════════════════════════════════════════════════════════════
// D-P5-Q03 · 依赖归属
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **写死的 6 个新包与它们的 major**（设计 §2.2 / §2.6）。
 *
 * ⚠️ 只锁 major（与仓库既有依赖 `^` 的口径一致），minor/patch 随解析 ⇒
 *   `pnpm-lock.yaml` 才是逐字钉住的那一层。这里断言的是「**归属**与 **major**」，
 *   而**不是**「装到了哪个 patch」（后者每次 `pnpm add` 都可能变，钉它只会制造无意义的红）。
 */
const EXPECTED_DEV_DEPENDENCY_MAJORS: ReadonlyArray<readonly [string, number]> = [
  ['react', 19],
  ['react-dom', 19],
  ['@types/react', 19],
  ['@types/react-dom', 19],
  ['electron', 38],
  ['@modelcontextprotocol/sdk', 1],
];

/** 从 `^x.y.z` 里取 major；不是 caret 区间 ⇒ `null`（判据自己会拒绝）。 */
function caretMajor(version: string | undefined): number | null {
  if (version === undefined) return null;
  const match = /^\^(\d+)\.\d+\.\d+$/.exec(version);
  return match === null ? null : Number(match[1]);
}

describe('T01 · 依赖归属（D-P5-Q03：6 个包一律 devDependencies）', () => {
  it('`dependencies` 仍然只有 `better-sqlite3`（运行时依赖面不许变胖）', () => {
    expect(Object.keys(readPackageJson().dependencies ?? {})).toEqual(['better-sqlite3']);
  });

  it('6 个新包全部落在 `devDependencies`，且 major 与设计一致', () => {
    const pkg = readPackageJson();
    const dev = pkg.devDependencies ?? {};
    const deps = pkg.dependencies ?? {};

    for (const [name, major] of EXPECTED_DEV_DEPENDENCY_MAJORS) {
      // 归属：必须在 devDependencies、**不许**出现在 dependencies
      expect(dev[name], `${name} 必须在 devDependencies`).toBeDefined();
      expect(deps[name], `${name} 不许出现在 dependencies`).toBeUndefined();
      // 版本区间：caret + major 与设计一致
      expect(caretMajor(dev[name]), `${name} 的版本必须是 ^${major}.x.y`).toBe(major);
    }
  });

  it('反例：非 caret 区间必须被判据拒绝（证明上面那条不是恒真）', () => {
    expect(caretMajor('~19.1.0')).toBeNull();
    expect(caretMajor('19.1.0')).toBeNull();
    expect(caretMajor('^19.1.0-beta.1')).toBeNull();
    expect(caretMajor(undefined)).toBeNull();
  });

  it('electron 只要类型不要二进制：`electron.d.ts` 在、`dist/` 与 `path.txt` 不在', () => {
    const electronDir = join(REPO_ROOT, 'node_modules', 'electron');
    // ① 类型在（tarball 自带 ⇒ 不跑 install 脚本也有）
    expect(() => readFileSync(join(electronDir, 'electron.d.ts'), 'utf8')).not.toThrow();
    // ② 二进制不在（`dist/` 是 install.js 的产物）
    expect(existsSync(join(electronDir, 'dist'))).toBe(false);
    // ③ `path.txt` 不在 ⇒ `require('electron')` 会抛 "failed to install correctly"
    //    ⇒ 任何测试都不得 require 它（这条断言本身就是在提醒下一个人）
    expect(existsSync(join(electronDir, 'path.txt'))).toBe(false);
  });
});

/**
 * 解析 `pnpm-workspace.yaml` 的 `allowBuilds` 块里的**键名**。
 *
 * ⚠️ **必须按块解析，不能全文 `includes('electron')`**：
 *   那个文件的注释里**大量提到** electron（正是为了说「不许把它加进来」）
 *   ⇒ 全文匹配会让这条断言**恒红**（或者反过来：注释一删就「变绿」而实际状态没变）。
 *   ⇒ 只读 `allowBuilds:` 之下、**缩进**的键行；注释与空行跳过，缩进消失即结束。
 */
function parseAllowBuildsKeys(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === 'allowBuilds:');
  if (start < 0) return [];

  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) break; // 缩进消失 ⇒ 块结束
    const match = /^\s+['"]?([^'":]+)['"]?:/.exec(line);
    if (match?.[1] !== undefined) keys.push(match[1].trim());
  }
  return keys;
}

describe('T01 · electron 不进 allowBuilds（结构性防线，而非纪律）', () => {
  it('`allowBuilds` 里没有 electron，且那三个该在的都在', () => {
    const keys = parseAllowBuildsKeys(readText('pnpm-workspace.yaml'));
    expect(keys).not.toContain('electron');
    // ⚠️ 分母写死：这三个是本仓库**必须**跑构建脚本的包，漏一个就等于「本地能装、CI 装不出二进制」
    expect(keys).toEqual(['better-sqlite3', 'esbuild', '@biomejs/biome']);
  });

  it('反例：把 electron 加进 allowBuilds 的文本必须被同一解析器命中', () => {
    const mutated = ['allowBuilds:', '  better-sqlite3: true', '  electron: true', ''].join('\n');
    expect(parseAllowBuildsKeys(mutated)).toContain('electron');
    // ⚠️ 同时证明「注释里提到 electron」**不算**（否则上面的断言会被注释的增删左右）
    const commented = ['allowBuilds:', '  # electron 不许加进来', '  esbuild: true', ''].join('\n');
    expect(parseAllowBuildsKeys(commented)).toEqual(['esbuild']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 门禁链形状（N-04：本轮**不许**新增/删除门禁段）
// ═══════════════════════════════════════════════════════════════════════════

describe('T01 · 门禁链形状不变（16 段逐名）', () => {
  it('`scripts.verify` 与 `scripts.ci` 完全合规（16 段逐名 + ci 是别名）', () => {
    // ⚠️ ★ **分母写死**（C31）⇒ 段数变了这里必须同批改 ⇒ 14 → 16 → **18**（★ T07 阶段 3 / 阶段 4）
    expect(EXPECTED_GATE_COMMANDS.length).toBe(18);
    expect(checkGateEntry(readPackageJson())).toEqual([]);
    expect(readPackageJson().scripts?.ci).toBe('pnpm run verify');
  });

  it('反例：从 verify 里删一段 ⇒ 门禁入口检查必须报差异', () => {
    const pkg = readPackageJson();
    const verify = pkg.scripts?.verify ?? '';
    const broken = verify
      .split('&&')
      .filter((segment) => segment.trim() !== 'pnpm run check:clamp')
      .join('&&');
    const diffs = checkGateEntry({ ...pkg, scripts: { ...pkg.scripts, verify: broken } });
    expect(diffs.map((diff) => diff.reason).join('\n')).toContain('缺少 check:clamp');
  });

  it('反例：把某一段写成裸 `pnpm ci` ⇒ 必须被判为「写法不对」而不是通过', () => {
    expect(parseVerifyChain('pnpm run typecheck && pnpm ci').malformed).toEqual(['pnpm ci']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三处配置（tsconfig / vitest / biome）
// ═══════════════════════════════════════════════════════════════════════════

/** 用 TypeScript 自己的解析器读 `tsconfig.json` 的原始对象（它天生支持注释，不必自写 JSONC 解析）。 */
function readRawTsConfig(): {
  include?: string[];
  compilerOptions?: { jsx?: string; lib?: string[] };
} {
  const read = ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, ' '));
  }
  return read.config as { include?: string[]; compilerOptions?: { jsx?: string; lib?: string[] } };
}

/** 按同一份 tsconfig 算出「`tsc` 会编译哪些文件」（相对路径）。 */
function programFilesOf(config: unknown): string[] {
  return ts.parseJsonConfigFileContent(config, ts.sys, REPO_ROOT).fileNames.map(toRepoRelative);
}

describe('T01 · tsconfig 覆盖 `viewer` / `mcp`（否则 1000+ 行新代码脱离类型检查）', () => {
  it('`include` 恰好是那 8 项（写死分母）', () => {
    expect(readRawTsConfig().include).toEqual([
      'src',
      'tests',
      'scripts',
      'bench',
      'viewer',
      'mcp',
      'vitest.config.ts',
      'tsup.config.ts',
    ]);
  });

  it('`tsc` 的 program **真的**包含 `viewer/shared/*.ts`', () => {
    const files = programFilesOf(readRawTsConfig());
    expect(files).toContain('viewer/shared/channels.ts');
    expect(files).toContain('viewer/shared/protocol.ts');
    expect(files).toContain('viewer/shared/sql-names.ts');
  });

  it('反例：把 `viewer` 从 include 里摘掉 ⇒ 同一段计算必须**不再**包含它', () => {
    const raw = readRawTsConfig();
    const mutated = programFilesOf({
      ...raw,
      include: (raw.include ?? []).filter((entry) => entry !== 'viewer'),
    });
    expect(mutated).not.toContain('viewer/shared/channels.ts');
    // ⚠️ 对照组：`src` 仍在 include 里 ⇒ 它还在。证明上面那条不是「program 变空了」造成的
    expect(mutated).toContain('src/index.ts');
  });

  it('`jsx: react-jsx` 与 `esbuild.jsx: automatic` **两处同批一致**（设计 §8 R3）', () => {
    const raw = readRawTsConfig();
    expect(raw.compilerOptions?.jsx).toBe('react-jsx');
    expect(raw.compilerOptions?.lib).toEqual(['ES2023', 'DOM']);

    const vitestConfig = readText('vitest.config.ts');
    // ⚠️ 断言的是**配置值的写法**而不是「跑起来不报错」：两者不一致的症状
    //   （`React is not defined`）只在面板文件里才炸，等到那时才发现太贵
    expect(vitestConfig).toMatch(/esbuild:\s*\{\s*jsx:\s*'automatic'\s*\}/);
    expect(vitestConfig).toContain("'mcp/**/*.test.ts'");
  });

  it('反例：`jsx` 与 `esbuild.jsx` 不配对的组合必须被判据判为不一致', () => {
    /** 判据：tsconfig 的 `jsx` 与 esbuild 的 `jsx` 是否指向同一个 JSX 运行时。 */
    const consistent = (tscJsx: string, esbuildJsx: string): boolean =>
      (tscJsx === 'react-jsx' && esbuildJsx === 'automatic') ||
      (tscJsx === 'react' && esbuildJsx === 'transform');
    expect(consistent('react-jsx', 'automatic')).toBe(true);
    expect(consistent('react-jsx', 'transform')).toBe(false);
    expect(consistent('react', 'automatic')).toBe(false);
  });
});

describe('T01 · `biome check` 真的扫到 `viewer/**`（真跑一次）', () => {
  /** biome 的 JS 入口（`bin/biome` 是 node 脚本 ⇒ 任何平台都能用 `process.execPath` 起它）。 */
  const BIOME_BIN = join(REPO_ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

  /** 跑一次 `biome check <path>`，返回它自称处理了几个文件。 */
  function checkedFileCount(target: string): number {
    const result = spawnSync(process.execPath, [BIOME_BIN, 'check', target], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const match = /Checked (\d+) files?/.exec(output);
    if (match?.[1] === undefined) {
      throw new Error(`biome 的输出里没有 "Checked N files"：\n${output}`);
    }
    return Number(match[1]);
  }

  it('`viewer/shared/channels.ts` 被处理（1 个文件）', () => {
    expect(checkedFileCount('viewer/shared/channels.ts')).toBe(1);
  });

  it('反例：`node_modules/**`（在 `files.ignore` 里）被处理 **0** 个文件', () => {
    // ⚠️ 这一条同时证明上一行不是「恒为 1」：同一段解析逻辑在被忽略的路径上得到 0。
    //   选 `node_modules` 而不是 `dist`：CI 的 verify job **不先构建** ⇒ `dist/` 可能不存在。
    expect(checkedFileCount('node_modules/vitest/package.json')).toBe(0);
  });
});

describe('T01 · 构建产物面不变（`viewer` / `mcp` 不进 npm 包）', () => {
  it('`tsup` 的 entry 只有 `src/index.ts`，`files` 只有 `dist`', () => {
    const pkg = readPackageJson();
    expect(pkg.files).toEqual(['dist']);
    expect(readText('tsup.config.ts')).toMatch(/entry:\s*\['src\/index\.ts'\]/);

    const buildConfig = JSON.parse(readText('tsconfig.build.json')) as {
      include?: string[];
      compilerOptions?: { rootDir?: string };
    };
    expect(buildConfig.include).toEqual(['src']);
    expect(buildConfig.compilerOptions?.rootDir).toBe('src');
  });

  it('反例：把 entry 换成 viewer 的那份配置必须匹配不上', () => {
    const pattern = /entry:\s*\['src\/index\.ts'\]/;
    expect(pattern.test("entry: ['src/index.ts'],")).toBe(true);
    expect(pattern.test("entry: ['viewer/main/index.ts'],")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 共享契约：通道 / 端口 / 查询名
// ═══════════════════════════════════════════════════════════════════════════

describe('T01 · 通道白名单（只读保证的「通道层」）', () => {
  it('`READ_CHANNELS` 恰好 8 条，`WRITE_CHANNELS` 是空数组', () => {
    expect(READ_CHANNELS.length).toBe(8);
    expect(WRITE_CHANNELS.length).toBe(0);
    expect(READ_PORT_METHODS.length).toBe(8);
  });

  it('8 条通道 ↔ 8 个 `ReadPort` 方法**逐名对应**（双向差集为空）', () => {
    const mapped: readonly string[] = READ_CHANNELS.map((channel) => READ_CHANNEL_METHODS[channel]);
    const portMethods: readonly string[] = [...READ_PORT_METHODS];

    expect(portMethods.filter((method) => !mapped.includes(method))).toEqual([]);
    expect(mapped.filter((method) => !portMethods.includes(method))).toEqual([]);
    // 映射表不许有「通道名之外的键」（否则它就不是 READ_CHANNELS 的映射）
    expect(Object.keys(READ_CHANNEL_METHODS).sort()).toEqual([...READ_CHANNELS].sort());
  });

  it('反例：双向差集的判据能抓到「少一个 / 多一个」', () => {
    const diff = (
      mapped: readonly string[],
      port: readonly string[],
    ): { missing: string[]; extra: string[] } => ({
      missing: port.filter((method) => !mapped.includes(method)),
      extra: mapped.filter((method) => !port.includes(method)),
    });

    const good: readonly string[] = READ_CHANNELS.map((channel) => READ_CHANNEL_METHODS[channel]);
    expect(diff(good, [...READ_PORT_METHODS])).toEqual({ missing: [], extra: [] });
    // 少一个方法（`READ_CHANNELS[0]` 对应的那个）
    expect(diff(good.slice(1), [...READ_PORT_METHODS]).missing).toEqual([
      READ_CHANNEL_METHODS[READ_CHANNELS[0]],
    ]);
    // 多一个方法
    expect(diff([...good, 'write'], [...READ_PORT_METHODS]).extra).toEqual(['write']);
  });

  it('★ 8 个读方法名与 16 个写方法名**零交集**（分母写死 16）', () => {
    // ⚠️ 「`READ_CHANNELS` 与 16 个写方法交集为空」这句是**平凡真**的
    //   （通道名带 `mem:` 前缀，永远不会等于方法名）⇒ 写成断言就是一条恒绿断言。
    //   ⇒ 真正有判别力的是「**映射后的方法名**与 16 个写方法名零交集」：
    //     它管的是「`mem:stats` 被悄悄映射到 `sweep` 上」这一类改写。
    expect(METHODS_THROWING_READONLY_VIOLATION.length).toBe(16);
    const readMethods: readonly string[] = READ_CHANNELS.map(
      (channel) => READ_CHANNEL_METHODS[channel],
    );
    expect(
      readMethods.filter((method) => METHODS_THROWING_READONLY_VIOLATION.includes(method)),
    ).toEqual([]);
  });

  it('反例：把一条通道映射到写方法上，上面那条交集断言必须变红', () => {
    const overlap = (methods: readonly string[]): string[] =>
      methods.filter((method) => METHODS_THROWING_READONLY_VIOLATION.includes(method));
    expect(overlap(['stats', 'get', 'logs'])).toEqual([]);
    expect(overlap(['stats', 'sweep'])).toEqual(['sweep']);
  });
});

describe('T01 · 查询名表（renderer 只能拿名字，拿不到 SQL 文本）', () => {
  it('`SQL_QUERY_NAMES` 恰好 4 条，且逐字写死', () => {
    // ⚠️ 期望值**独立写死**在测试里（不从 `sql-names.ts` 的常量反推）：
    //   import 同一个常量来当期望值，会让断言退化成 `expect(x).toBe(x)`
    // ⚠️ ★ **P5-T04 同步（3 → 4）**：第 4 条 `recentMemories` 是「选哪一条记忆」的取数口
    //   （`memoryId` 是面板 2 / 4 / 6 的唯一取数键，而原先 renderer 里没有入口能设它）。
    //   ⇒ 这里改的是**期望值**（跟着新增的具名查询走），断言的**判据**没变：
    //     仍然要求「清单与这里逐字相等」——多一条、少一条、换个顺序都红。
    expect([...SQL_QUERY_NAMES]).toEqual([
      'graphTwoHop',
      'contentHistoryPage',
      'contentHistoryCount',
      'recentMemories',
    ]);
    expect([...SQL_QUERY_NAMES]).toHaveLength(4);
  });

  it('`sql-names.ts` 里没有任何 SQL 文本（只有名字与参数形状）', () => {
    // ⚠️ **必须先剥注释**（`scripts/lib/code-span.ts` 的 `blankComments`，仓库现成的实现）：
    //   本文件的注释**故意**提到 `LIMIT`（它在解释「每条 SQL 都带 LIMIT」这条不变量）
    //   ⇒ 不剥注释会让这条断言**恒红**，而「把注释删掉就变绿」等于断言在管注释而不是管代码。
    const code = blankComments(readText('viewer/shared/sql-names.ts'));
    for (const keyword of ['SELECT', 'FROM', 'WHERE', 'INSERT', 'PRAGMA', 'LIMIT']) {
      expect(code, `sql-names.ts 的**代码**里不许出现 SQL 关键字 ${keyword}`).not.toContain(
        keyword,
      );
    }
  });

  it('反例：把 SQL 文本写进代码（而不是注释）必须被同一条判据命中', () => {
    const probe =
      "// 注释里提 LIMIT 不算\nexport const SQL_QUERIES = { graphTwoHop: 'SELECT 1 FROM memories LIMIT 1' };";
    const code = blankComments(probe);
    expect(['SELECT', 'FROM', 'LIMIT'].filter((keyword) => code.includes(keyword))).toEqual([
      'SELECT',
      'FROM',
      'LIMIT',
    ]);
    expect(code).not.toContain('注释里提 LIMIT 不算');
  });
});
