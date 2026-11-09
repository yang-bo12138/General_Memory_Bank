/**
 * ★ **「表名只在向量层」的静态断言**（C′ 档 T04 收尾 · 2026-11-05）。
 *
 * ## 它守的是哪条纪律
 *
 * §4.6 步骤 2c / `src/vector/ivf.ts` 的文件头：
 * > **表名的唯一出处**：`vector_cell_members`（桶成员）与 `memories`（候选行）只在本模块出现
 * > ⇒ 流水线（`src/store/recall.ts`）**永远不引用表名**。
 *
 * ## 它是怎么来的（**这次越界教出来的**）
 *
 * T04 收尾要修一个静默漏召回：`updateContent()` 就地换向量 ⇒ 按**旧**向量编的码行变成
 * 「过期上界」⇒ 若新向量落在**同一个细桶**，剪枝会按过期上界把该行跳掉（A6 与 `codesMissing`
 * 都查不出来）。第一版修法**图省事**，把 `DELETE FROM vector_codes …` 直接写在
 * `src/store/updateContent.ts` 里 —— 那正是这条纪律禁止的形状（**表名外泄到存储层**）。
 *
 * ⚠️ 为什么「只是一条 SQL」也不行：表名一旦在存储层出现，下一个人要「顺手再改一下码」
 *   就**不需要跨层**了 ⇒ 第二个写入点是这么长出来的（`assignBucket` 那边的静态扫描
 *   之所以有效，靠的就是「想写就得跨层，跨层就会被拦」）。
 *   ⇒ 现在的形状：SQL 在 `src/vector/bucketAssign.ts` 的 `clearCodeRow()` 里，
 *     `src/store/updateContent.ts` 只调它、**一个表名都不出现**。
 *
 * ## 两条防线，各管一件事（别把它们的职责混起来）
 *
 * | 防线 | 管什么 | 位置 |
 * |---|---|---|
 * | **写点扫描**（扫代码、剥注释） | 「裸写桶表/码表」只能出现在 `src/vector/bucketAssign.ts` | `scripts/check-bucket-write.ts`（`pnpm check:bucket-write`） |
 * | **本文这个断言**（扫原文、**含注释**） | `src/store/**` 里**一处都不许出现**码表名 | `tests/contracts/table-name-boundary.test.ts` |
 *
 * ⚠️ **为什么要单独加「含注释」这一条**：写点扫描会先剥注释 ⇒
 *   在存储层写一行注释 `// 顺便删掉 vector_codes 那一行` **不会被它抓到**，
 *   而那行注释正是「下一步就在这里写 SQL」的邀请函。本条断言的牙就在这个差别上
 *   （实测：在 `src/store/write.ts` 里加一条含码表名的**注释** ⇒ 本条立刻红，写点扫描仍绿）。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** 仓库根目录。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 受保护的码表名（只允许出现在向量层）。 */
const CODE_TABLE = 'vector_codes';

/** `src/store` 目录（**禁止出现码表名**的那一层）。 */
const STORE_ROOT = join(REPO_ROOT, 'src', 'store');

/** `src/vector` 目录（码表的家）。 */
const VECTOR_ROOT = join(REPO_ROOT, 'src', 'vector');

/**
 * 递归列出目录下的 `.ts` 文件（**含类型声明，不排除任何文件**）。
 *
 * ⚠️ 不排除 `.d.ts` / `.test.ts`：本断言关心的是「这一层里有没有这个词」，
 *   连声明文件里出现都算外泄（那同样会诱导别处照抄）。
 *
 * @param root 目录
 * @returns 绝对路径（升序，保证可复现）
 */
function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 某个目录下**原文包含** `needle` 的文件（相对路径，`/` 分隔）。
 *
 * ⚠️ **按原文（不剥注释）判**：见文件头的「为什么要单独加『含注释』这一条」。
 *
 * @param root 目录
 * @param needle 要找的子串
 * @returns 命中的相对路径（升序）
 */
function filesMentioning(root: string, needle: string): string[] {
  const hits: string[] = [];
  for (const file of listTsFiles(root)) {
    if (readFileSync(file, 'utf8').includes(needle)) {
      hits.push(relative(root, file).split(sep).join('/'));
    }
  }
  return hits.sort();
}

describe('表名边界 · `src/store/**` 一处都不许出现码表名（§4.6 步骤 2c）', () => {
  it('★ 真实的仓库：`src/store/` 下 0 个文件提到码表', () => {
    // ── 非真空自检：目录真的被走到了（否则「0 命中」可能只是路径写错）──
    expect(listTsFiles(STORE_ROOT).length).toBeGreaterThan(10);
    expect(filesMentioning(STORE_ROOT, CODE_TABLE)).toEqual([]);
  });

  it('★ 正控：同一套判据在向量层**必须能扫到**（否则「0 命中」可能只是函数坏了）', () => {
    const hits = filesMentioning(VECTOR_ROOT, CODE_TABLE);
    // 码表在向量层有合法的写入点（`clearCodeRow()`）与读取点（`readCodes()`）
    expect(hits).toContain('bucketAssign.ts');
    expect(hits).toContain('ivf.ts');
  });

  it('★ 负控：临时目录里放一个含码表名的文件 ⇒ 判据必须报出来（不是恒返回空）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'table-name-boundary-'));
    try {
      writeFileSync(join(dir, 'leak.ts'), `// 顺便删掉 ${CODE_TABLE} 那一行\n`, 'utf8');
      expect(filesMentioning(dir, CODE_TABLE)).toEqual(['leak.ts']);
      // 反向：不含它的文件不被误报
      writeFileSync(join(dir, 'clean.ts'), 'export const nothing = 1;\n', 'utf8');
      expect(filesMentioning(dir, CODE_TABLE)).toEqual(['leak.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
