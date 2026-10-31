/**
 * 「桶归属唯一写入点」的**静态扫描**（共享测试工具） —— §9.3.0 / P2-T03-a / P2-T03-b。
 *
 * ⚠️ **为什么抽成共享工具**（C36：同一件事不得有两套词 / 两份实现）：
 *   这条闸门要在**两个地方**用：
 *   ① `tests/unit/bucketAssign.test.ts`：全仓扫 ⇒ 写 `vector_cell_members` 的地方
 *      **只有** `vector/bucketAssign.ts`；
 *   ② `tests/unit/merge.test.ts`：`write.ts` / `merge.ts` 的代码里**不得**出现裸的桶表 SQL
 *      （桶归属只能经 `assignBucket` / `unassignBucket` 走）。
 *   ⇒ 造两份 ⇒ 两份正则会漂移 ⇒ 闸门静默失效（**这种错不报任何错**）。
 *
 * ⚠️ **扫描纪律（沿用本仓库的既有口径**，`tests/unit/touch.test.ts` / `merge.test.ts`）**：
 *   · **先剥注释**：源码的说明文字里大量出现 `INSERT INTO vector_cell_members`
 *     这些词（它们是「唯一写入点」的**说明**）⇒ 不剥注释的话扫描器把说明文字当实现
 *     ⇒ 既误报、又测不出真问题；
 *   · **保留行结构**（用空行替换而不是删行）：否则行号会漂移 ⇒ 报错定位不到位置；
 *   · **只认写、不认读**：`SELECT ... FROM vector_cell_members` 是合法的
 *     （`src/vector/ivf.ts` 的桶内检索就在读它）⇒ 正则只匹配三种写动词。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 一处「裸的桶表写入」。 */
export interface BucketWriteHit {
  /** 相对 `src/` 的路径（用 `/` 分隔，跨平台一致）。 */
  file: string;
  /** 行号（**1 起**）。 */
  line: number;
}

/**
 * 剥掉**整行注释**，保留行结构（行号才对得上）。
 *
 * ⚠️ **只处理整行注释**：本项目的 `src/` 里没有「代码后面跟注释再跟代码」这种需要
 *   精细解析的形态（`//` 出现在字符串里的地方极少，且都不在桶表 SQL 附近）。
 *   ⇒ 宁可漏也不误报：误报会把闸门变成噪声 ⇒ 大家开始忽略它。
 */
export function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .map((rawLine) => {
      const trimmed = rawLine.trim();
      const isComment =
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.endsWith('*/');
      return isComment ? '' : rawLine;
    })
    .join('\n');
}

/**
 * 扫出**真正写** `vector_cell_members` 的位置（裸 `INSERT` / `UPDATE` / `DELETE FROM`）。
 *
 * ⚠️ **只认写、不认读**：`SELECT ... FROM vector_cell_members` 是合法的。
 * ⚠️ **认 `INSERT OR REPLACE`**：那也是裸写（§4.15.5 明写它**不能**替代
 *   「先 DELETE 再 INSERT」⇒ 写点必须被扫出来）。
 *
 * @param source 源码文本
 * @returns 命中的行号列表（**1 起**，升序）
 */
export function findMembershipWriteSites(source: string): number[] {
  const code = stripCommentLines(source);
  const pattern =
    /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+vector_cell_members\b/gi;
  const sites: number[] = [];
  let match = pattern.exec(code);
  while (match !== null) {
    sites.push(code.slice(0, match.index).split('\n').length);
    match = pattern.exec(code);
  }
  return sites;
}

/**
 * 递归列出目录下的 `.ts` 实现文件（排除测试与声明）。
 *
 * @param root 目录
 * @returns 绝对路径列表
 */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 扫一整棵源码树，返回**所有**裸写桶表的位置。
 *
 * @param root 源码根目录（通常是 `src/`）
 * @returns 命中列表（按文件路径、再按行号排序）
 */
export function scanSourceTree(root: string): BucketWriteHit[] {
  const hits: BucketWriteHit[] = [];
  for (const file of listSourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    for (const line of findMembershipWriteSites(source)) {
      hits.push({ file: relative(root, file).split(sep).join('/'), line });
    }
  }
  return hits;
}
