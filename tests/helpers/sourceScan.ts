/**
 * ★ 源码扫描工具（`viewer/**` 的结构性断言用）—— 阶段 5 · T03/T04。
 *
 * ⚠️ **仓库里已有一份内联实现**（`viewer-worker.test.ts` 的 `listSourceFiles` / `readCode`）。
 *   本轮**不动那个文件**（它属于已提交的 T02，改它会把 T03 的 diff 搅浑），
 *   新建面板测试一律用本文件 ⇒ 新代码只有一份实现。
 *
 * ⚠️ **扫描前必须剥注释**（`scripts/lib/code-span.ts` 的 `blankComments`）：
 *   本仓库的注释**故意**大量提到 `better-sqlite3` / `electron` / `restore()` 这些词
 *   （正是在解释为什么不许用）⇒ 不剥注释的扫描要么恒红，
 *   要么逼着人删掉那些解释（把「为什么」一起删掉）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from '../../scripts/lib/code-span.js';

/** 仓库根（绝对路径）。 */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 递归列出某个目录下的 `.ts` / `.tsx` 文件（相对仓库根，正斜杠，升序）。 */
export function listSourceFiles(relativeDir: string): string[] {
  const absolute = join(REPO_ROOT, relativeDir);
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // 目录还不存在（如 T03 之前的 `viewer/renderer`）⇒ 没有文件可扫。
      // ⚠️ 调用方必须自己断言「分母不为 0」，否则这里会变成恒绿的空气断言。
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        found.push(relative(REPO_ROOT, full).replace(/\\/g, '/'));
      }
    }
  };

  walk(absolute);
  return found.sort();
}

/** 读一个文件并**剥掉注释**（扫描判据只看代码，不看解释）。 */
export function readCode(relativePath: string): string {
  return blankComments(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
}

/** 读一个文件的原文（**不剥注释**；只用于「注释里提到了什么」这类断言）。 */
export function readRaw(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * ★ **16 个写方法**的名字（设计 §7.1 的完整清单，逐字）。
 *
 * ⚠️ 它们用来断言「渲染层一个写方法都没调」：
 *   匹配形状是 **`.方法名(`**（带点），不是「出现这个词」——
 *   否则 `pin` 会命中 `pinFactor`、`link` 会命中注释里的 `linking`。
 *   ⚠️ `linkByIds` 排在 `link` 前面：交替分支按书写顺序尝试，
 *     反过来会先匹配到 `link` 再因「后面不是括号」整体失败回退（结果对，但读起来容易误会）。
 */
export const WRITE_METHOD_NAMES = [
  'write',
  'touch',
  'link',
  'linkByIds',
  'forget',
  'restore',
  'pin',
  'unpin',
  'setAlias',
  'mergeEntities',
  'updateContent',
  'sweep',
  'setParams',
  'rebuildArchivalSchedule',
  'rebuildVectorBuckets',
  'recluster',
] as const;

/** 找出某个源码文本里出现的写方法调用（返回方法名清单，去重升序）。 */
export function findWriteMethodCalls(code: string): string[] {
  const pattern = new RegExp(
    `\\.\\s*(${WRITE_METHOD_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`,
    'g',
  );
  const hits = new Set<string>();
  for (const match of code.matchAll(pattern)) {
    hits.add(match[1] ?? '');
  }
  return [...hits].sort();
}

/** 某个目录下「调用了写方法」的文件（相对路径 → 命中的方法名）。 */
export function filesCallingWriteMethods(relativeDir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of listSourceFiles(relativeDir)) {
    const hits = findWriteMethodCalls(readCode(file));
    if (hits.length > 0) {
      out[file] = hits;
    }
  }
  return out;
}
