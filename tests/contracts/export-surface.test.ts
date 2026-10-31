import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as publicApi from '../../src/index.js';

/**
 * ★ **导出面的守卫**（P2 QA 第二轮 ②-1 建议）。
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
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INDEX_PATH = join(REPO_ROOT, 'src/index.ts');

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

  it('★ 导出面里**只有这 5 个类**（防止悄悄多导出一个类）', () => {
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
