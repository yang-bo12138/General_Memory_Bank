/**
 * `content_history` 保留策略的守卫 —— 对应 **P4-T01**（取舍前置）的验收标准。
 *
 * ★ 决策是「**选 1：不裁剪**」⇒ 本文件守两件事：
 *   ① **决策记录存在**且写明了选哪条、理由、以及「若选 2 要同步改哪几处」的清单；
 *   ② **代码里没有任何裁剪逻辑**（`content_history` 只追加）。
 *
 * ⚠️ **「只追加」的判据不能写成「全仓搜不到 DELETE FROM content_history」**：
 *   那只覆盖一种写法（`DELETE`），而裁剪也可以用 `DELETE ... WHERE id IN (SELECT ... LIMIT)` /
 *   `TRUNCATE`-式重建（先建新表再改名）实现。
 *   ⇒ 本文件用**两条互补的判据**：
 *     · 源码里**没有任何** `DELETE FROM content_history` / `DROP TABLE content_history`；
 *     · 且**归档路径只有两个写入点**（`write` 的合并 / `updateContent` 的修正）——
 *       用「谁 INSERT 它」的白名单来守：新增第三个写入点 ⇒ 红（那正是「裁剪」会引入的东西）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DECISION_DOC = join(REPO_ROOT, 'docs/decisions/content-history-retention.md');

/** 递归收集 `src/**\/*.ts`（不读测试）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectSources(full, out);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('P4-T01 · content_history 保留策略', () => {
  it('★ 决策记录存在，且写明「选 1 / 不裁剪」与理由', () => {
    const doc = readFileSync(DECISION_DOC, 'utf8');
    expect(doc).toContain('选 1');
    expect(doc).toContain('不裁剪');
    // 理由必须落在「兜底承诺」这一层，而不是「省空间」一句带过
    expect(doc).toContain('兜底');
    // 「若选 2 要改哪几处」的清单必须在（否则决策记录只是表态）
    expect(doc).toContain('若日后改成选 2');
  });

  it('★ 代码里没有任何裁剪逻辑（`content_history` 只追加）', () => {
    const offenders: string[] = [];
    for (const file of collectSources(join(REPO_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      // ⚠️ 两种「裁剪」的写法都要覆盖：直接删 + 整表重建
      if (/DELETE\s+FROM\s+content_history/i.test(source)) offenders.push(`${file}（DELETE）`);
      if (/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?content_history/i.test(source))
        offenders.push(`${file}（DROP）`);
    }
    expect(offenders).toEqual([]);
  });

  it('★ 归档路径的写入点只有两处（新增第三处 ⇒ 那正是裁剪会引入的东西）', () => {
    const writers: string[] = [];
    for (const file of collectSources(join(REPO_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (/INSERT\s+INTO\s+content_history/i.test(source)) writers.push(file.replace(/\\/g, '/'));
    }
    const basenames = writers.map((file) => file.split('/').pop() ?? file).sort();
    // ⇒ `merge.ts`（`write` 的合并路径，reason='merge'）/
    //    `updateContent.ts`（修正路径，reason='manual_fix'）
    //   ⚠️ 两处都在**同一件事**上：把「被替换掉的旧正文」归档 ⇒ 这正是「只追加」的两个入口。
    expect(basenames).toEqual(['merge.ts', 'updateContent.ts']);
  });
});
