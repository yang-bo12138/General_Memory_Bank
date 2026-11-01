/**
 * ★ **导出面的守卫**（P2 QA 第二轮 ②-1 建议）+ **§6 公开方法逐阶段核对**（P3 收尾）。
 *
 * ⚠️ **为什么需要它**：此前导出面只有**点式**断言（`tests/unit/memory-store.test.ts` 里
 *   「含 `MemoryStore`」「不含 `extractEntityNames`」）⇒ **没有「集合相等」的守卫**
 *   ⇒ ⇒ 任何人往 `src/index.ts` 里**加一个导出**（比如把向量层泄漏出去）⇒ **门禁看不见**。
 *   ⇒ 而 P1 的 F6 裁决明确写着「**T01/T02 的向量层不导出**」
 *   ⇒ 那条裁决此前**只靠自觉**。
 *
 * ⚠️ **本守卫不写死全部导出名**（那有 157 个 ⇒ 每次正常的类型导出都要改名单 ⇒ 成本高、易失效）
 *   ⇒ 改为守**两条真正的不变量**：
 *   ① **导出面里没有任何 `src/vector/**` 的东西**（向量层是**内部实现**，不是公共 API）；
 *   ② **导出面里只有 `MemoryStore` 与 `MemoryMaintainer` 两个类**（其余都是函数/常量/类型）
 *      ⇒ 防止「悄悄多导出一个类」（QA 正是这么发现 `MemoryMaintainer` 的）。
 *
 * ⚠️ **第三条不变量（本文件后段）**：`MemoryStore` 的**公开方法集合**
 *   必须与 §6 的**已落地阶段**的方法集合**逐个相等**。
 *   ⇒ **它治的是「方法漏挂」**——此前门禁只守导出面（`src/index.ts`），
 *     而 §6 的方法**挂在类上** ⇒ 「实现了却没挂到 `MemoryStore`」这件事**没有任何门禁看得见**
 *     （实测：`inhibitionTrace` / `recluster` 的实现早就存在，却一直**没挂上**，
 *      而 `pnpm run verify` 全绿 ⇒ **假绿**）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractSection, parseTablesWithoutSeparators } from '../../scripts/lib/design-doc.js';
import * as publicApi from '../../src/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INDEX_PATH = join(REPO_ROOT, 'src/index.ts');
const PLAN_DOC_PATH = join(REPO_ROOT, 'docs/design/DEVELOPMENT-PLAN.md');

/** 允许出现在导出面上的**类**（写死）。 */
const EXPECTED_EXPORTED_CLASSES: readonly string[] = [
  'EventWriter',
  'FileLogger',
  'MemoryError',
  'MemoryLogger',
  'MemoryMaintainer',
  'MemoryStore',
];

/**
 * 允许从 `src/vector/**` 导出的名字。
 *
 * ⚠️ **当前是空的**：P1 的 F6 裁决「**T01/T02 的向量层不导出**」。
 * ⇒ 将来若某个向量层的东西**确实**该公开 ⇒ 在这里**显式**加一个名字并写明理由
 * ⇒ 而**不是**直接改 `src/index.ts` 就完事（那样就没有守卫了）。
 */
const ALLOWED_VECTOR_EXPORTS: readonly string[] = [];

/** 解析 `src/index.ts` 里的 `export ... from '<模块>'` ⇒ 返回 `[导出的名字, 模块路径][]`。 */
function parseExportStatements(source: string): Array<{ names: string[]; module: string }> {
  const results: Array<{ names: string[]; module: string }> = [];
  const pattern = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const names = (match[1] ?? '')
      .split(',')
      .map(
        (part) =>
          part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            ?.trim() ?? '',
      )
      .filter((name) => name !== '' && !name.startsWith('//'));
    results.push({ names, module: match[2] ?? '' });
    match = pattern.exec(source);
  }
  return results;
}

describe('P2 · 导出面守卫（§6 公共 API 入口）', () => {
  const source = readFileSync(INDEX_PATH, 'utf8');

  it('★ 导出面里**没有任何 `src/vector/**` 的东西**（F6 裁决：向量层不导出）', () => {
    const statements = parseExportStatements(source);
    const vectorExports = statements
      .filter((statement) => statement.module.includes('/vector/'))
      .flatMap((statement) => statement.names);

    expect(vectorExports).toEqual([...ALLOWED_VECTOR_EXPORTS].sort());
  });

  it('★ 导出面里**只有这 6 个类**（防止悄悄多导出一个类）', () => {
    // ⚠️ **运行时判定「什么是类」**：**ES class** 的源码以 `class` 开头
    //   ⇒ 箭头函数、普通函数声明、对象字面量都**不算**
    //   ⇒ ⚠️ **不靠「首字母大写」猜**（那会把 40 个大写常量算成类 ⇒ 判据失真）
    //   ⇒ ⚠️ **不靠「有 prototype」判**（普通函数声明也有 prototype ⇒ 会多算 30 个）。
    const exportedClasses = Object.entries(publicApi)
      .filter(([, value]) => typeof value === 'function')
      .filter(([, value]) => Function.prototype.toString.call(value).startsWith('class '))
      .map(([name]) => name)
      .sort();

    // ⚠️ 期望值**写死**（C31）⇒ 导出面多一个类 / 少一个类 ⇒ 都红。
    expect(exportedClasses).toEqual([...EXPECTED_EXPORTED_CLASSES].sort());
  });

  it('★ 负控：注入一个从 `src/vector/` 的导出 ⇒ 断言必须红（证明第一条不是摆设）', () => {
    const injected = `${source}\nexport { IvfVectorBackend } from './vector/ivf.js';\n`;
    const vectorExports = parseExportStatements(injected)
      .filter((statement) => statement.module.includes('/vector/'))
      .flatMap((statement) => statement.names);
    expect(vectorExports).not.toEqual([...ALLOWED_VECTOR_EXPORTS].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、§6 的公开方法**逐阶段核对**（漏挂方法 ⇒ 门禁能红）
// ═══════════════════════════════════════════════════════════════════════════

/** 计划稿里「§3.1 阶段间的方法归位核对」那一节的标题行（**逐字**）。 */
const SECTION_3_1_HEADING = '### 3.1 阶段间的方法归位核对（§12 方法覆盖表，必须逐行对齐）';

/**
 * ★ **§6 的方法清单从计划稿里解析**（DEVELOPMENT-PLAN.md §3.1 的归位表）。
 *
 * ⚠️ **为什么不把清单写死在测试里**：写死的那份会与计划稿**各走各的**
 *   ⇒ 计划稿里给某个方法改了阶段 / 加了方法 ⇒ 测试里的清单**不知道**
 *   ⇒ 门禁变成「守一份没人更新的副本」（C36：同一件事不得有两套词）。
 * ⇒ **清单的权威来源 = 计划稿**（§12 的方法覆盖表是 §6 的**归位**说明）。
 *
 * ⚠️ **解析失败 ⇒ 抛错，不静默跳过**（「漏读伪装成一致」是本仓库反复踩的坑）。
 *
 * @param planDoc 计划稿全文
 * @returns 阶段 → 方法名列表，以及计划稿自称的方法总数
 */
function parseStageMethodManifest(planDoc: string): {
  stages: Map<number, string[]>;
  total: number;
} {
  const section = extractSection(planDoc, SECTION_3_1_HEADING);
  const table = parseTablesWithoutSeparators(section)[0];
  if (table === undefined) {
    throw new Error(`计划稿 §3.1 里找不到方法归位表：${SECTION_3_1_HEADING}`);
  }

  const stages = new Map<number, string[]>();
  let total: number | null = null;

  for (const row of table.rows) {
    const stageCell = (row[0] ?? '').trim();
    const methodCell = row[1] ?? '';
    const subtotalCell = (row[2] ?? '').trim();
    const names = [...methodCell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    const subtotal = Number.parseInt(subtotalCell.replace(/\*/g, ''), 10);

    if (stageCell === '') {
      // ⚠️ 「合计」行：阶段列是空的 ⇒ 方法数由**合计格**给出。
      if (Number.isNaN(subtotal)) {
        throw new Error(`计划稿 §3.1 的合计行读不出方法总数：${row.join(' | ')}`);
      }
      total = subtotal;
      continue;
    }

    const stage = Number.parseInt(stageCell, 10);
    if (Number.isNaN(stage)) {
      throw new Error(`计划稿 §3.1 的阶段列不是数字：${stageCell}`);
    }
    // ⚠️ **小计自检**：那一行的「小计」必须等于该行列出的方法条数
    //   ⇒ 解析器漏读一个方法名 ⇒ 立刻抛错（而不是悄悄少算一个）。
    if (subtotal !== names.length) {
      throw new Error(
        `计划稿 §3.1 的阶段 ${stage} 行自相矛盾：小计 ${subtotal} ≠ 列出的方法数 ${names.length}`,
      );
    }
    stages.set(stage, names);
  }

  if (total === null) {
    throw new Error('计划稿 §3.1 里找不到「合计」行（方法总数）');
  }
  const sum = [...stages.values()].reduce((count, names) => count + names.length, 0);
  if (sum !== total) {
    throw new Error(`计划稿 §3.1 自相矛盾：各阶段之和 ${sum} ≠ 合计 ${total}`);
  }
  return { stages, total };
}

/**
 * ★ **已落地阶段**（归位表里**已经交付**的那些阶段）。
 *
 * ⚠️ **为什么不能写「必须等于 23」**：§6 的 23 个方法分属阶段 1~5
 *   ⇒ 阶段 4（`forget` / `restore` / `updateContent` / `setParams` / `stats` / `sweep` /
 *   `close` / `rebuildArchivalSchedule`）与阶段 5（`verifyIntegrity`）**还没做**
 *   ⇒ 「等于 23」会**永远红**⇒ 而**一直红的门禁会被忽略**（比没有门禁更糟）。
 * ⇒ 改为「**已落地阶段的方法集合 == 公开面**」⇒ **可逐步推进**：
 *   某个阶段落地时，把阶段号加进来 + 把方法挂上 ⇒ 这条断言**继续成立**。
 *
 * ⚠️ **阶段 0 不新增方法**（只建开关与不变量测试）⇒ 它在清单里是空集，列出来只为**对齐**。
 */
const LANDED_STAGES: readonly number[] = [0, 1, 2, 3];

/**
 * ★ **已落地阶段里、但门面上还没有的方法**（**唯一**的例外清单）。
 *
 * ⚠️ **当前是空的**：阶段 3 的三个方法（`clusters` / `inhibitionTrace` / `recluster`）
 *   **全部已挂到 `MemoryStore` 上**（`clusters` 是 P3-T05 落的）
 *   ⇒ 「簇快照的只读导航接口」已存在 ⇒ **不再有例外**。
 * ⇒ 将来某个阶段落地时：如果那个阶段的方法**还没挂上** ⇒ 把它加进这里
 *   （**刻意不造空壳方法**：导出了却没实现 = 空承诺，比不导更糟）；
 *   挂上之后 ⇒ 从这里删掉 ⇒ 本断言**继续成立**（两边同时变）。
 */
const NOT_YET_LANDED: readonly string[] = [];

/** `MemoryStore.prototype` 上的**公开方法名**（构造器与私有字段都不算）。 */
function facadeMethodNames(): string[] {
  const prototype = publicApi.MemoryStore.prototype;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      return descriptor !== undefined && typeof descriptor.value === 'function';
    })
    .sort();
}

/**
 * 清单与公开面的**双向差集**（**纯函数** ⇒ 负控可以直接调它）。
 *
 * @param required 清单里「已落地」的方法名
 * @param actual 门面上实际存在的方法名
 * @returns `missing` = 清单要求有、门面上没有（**漏挂**）；
 *          `extra` = 门面上有、清单没登记（**多挂 / 空壳**）
 */
function diffPublicMethods(
  required: readonly string[],
  actual: readonly string[],
): { missing: string[]; extra: string[] } {
  return {
    missing: required.filter((name) => !actual.includes(name)),
    extra: actual.filter((name) => !required.includes(name)),
  };
}

describe('P3 · §6 公开方法逐阶段核对（漏挂方法 ⇒ 门禁能红）', () => {
  const planDoc = readFileSync(PLAN_DOC_PATH, 'utf8');
  const manifest = parseStageMethodManifest(planDoc);
  const allManifestMethods = [...manifest.stages.values()].flat();
  const landedMethods = LANDED_STAGES.flatMap((stage) => manifest.stages.get(stage) ?? []);
  const required = landedMethods.filter((name) => !NOT_YET_LANDED.includes(name));
  const actual = facadeMethodNames();

  it('★ 计划稿 §3.1 的清单**解析出来了**（不是空解析 ⇒ 下面的断言有意义）', () => {
    // ⚠️ **前提自检**：清单必须**真的**有 23 个方法（§6 的方法总数是**被钉住的事实**）。
    expect(manifest.total).toBe(23);
    expect(allManifestMethods).toHaveLength(23);
    expect([...manifest.stages.keys()].sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    // ⚠️ **已落地阶段必须是清单里真实存在的阶段**（写错阶段号 ⇒ 下面的断言会静默变空）。
    for (const stage of LANDED_STAGES) {
      expect(manifest.stages.has(stage)).toBe(true);
    }
  });

  it('★ `MemoryStore` 的公开面 == 清单里**已落地阶段**的方法集合（漏挂 ⇒ 红；多挂 / 空壳 ⇒ 红）', () => {
    const diff = diffPublicMethods(required, actual);

    // ① **漏挂**：清单说该有的，门面上没有 ⇒ 红（附上缺哪几个）。
    expect(
      diff.missing,
      `§6 的方法漏挂到 MemoryStore 上：${diff.missing.join(' / ')}` +
        '（实现已存在却没挂 ⇒ 门禁看不见 ⇒ 这就是「假绿」）',
    ).toEqual([]);

    // ② **多挂 / 空壳**：门面上有的，清单里没有 ⇒ 红
    //   （防止「为了凑齐阶段 3 的三个方法而造一个空壳 `clusters`」）。
    expect(
      diff.extra,
      `MemoryStore 上出现了清单里没有的方法：${diff.extra.join(' / ')}` +
        '（要么在 §3.1 的归位表里登记，要么从门面上拿掉）',
    ).toEqual([]);
  });

  it('★ 负控：漏挂一个方法 ⇒ 差集必须报出来（证明上面那条断言有鉴别力）', () => {
    // ⚠️ **负控写在测试内部**：故意造一个「清单要求有、门面上没有」的形状
    //   ⇒ 差集必须把它报出来 ⇒ 证明上面那条不是恒真。
    const missing = diffPublicMethods(['write', 'recall', 'clusters'], ['write', 'recall']);
    expect(missing.missing).toEqual(['clusters']);
    expect(missing.extra).toEqual([]);

    // ⚠️ 另一侧：**多挂**（清单里没有的门面方法）也必须被报出来。
    const extra = diffPublicMethods(['write'], ['write', 'notInManifest']);
    expect(extra.extra).toEqual(['notInManifest']);
    expect(extra.missing).toEqual([]);
  });
});
