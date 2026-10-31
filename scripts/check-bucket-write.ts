#!/usr/bin/env tsx
/**
 * 「桶归属唯一写入点」的 lint 门禁 —— P2-T04（DESIGN-v2.md §9.3.0）。
 *
 * ⚠️ **守的是 §9.3.0 的架构裁决**：
 *   「桶归属的写入**只允许出现在一个内部函数里**」
 *   ⇒ 配套 lint 规则：**§4.9 里不得出现裸的
 *   `INSERT INTO vector_cell_members` / `UPDATE vector_cell_members`**。
 *
 * ⚠️ ★ **白名单必须显式写出、且路径写死为常量**（C31 的纪律：
 *   「N/N 全绿」里的 N 必须是**外部写死的期望值**）：
 *   唯一合法的写入点是 `src/vector/bucketAssign.ts`
 *   ⇒ 它的**每一个**桶表写入都要经过 `assignBucket` / `unassignBucket`。
 *
 * ⚠️ ★ **「命中数 > 0」这条判据不能省**：
 *   若白名单被写成空集、而源码里也没有任何裸写 ⇒ 「每一处都在白名单内」**恒真**
 *   ⇒ 闸门变成**真空守卫**（正是 C31 警告的症状）。
 *   ⇒ 本门禁**同时**断言：① 全仓至少扫到一处裸写；② 白名单里的那个文件**真的**被扫到。
 *
 * ⚠️ **为什么不是 biome 的自定义规则**：biome 的自定义规则要么写成插件（要引依赖），
 *   要么用 `noRestrictedSyntax` 之类的通用规则硬凑（⇒ 正则写不进去「剥注释 + 逐行定位」）
 *   ⇒ 而本仓库的既有静态守卫（`check-clock.ts` / `check-clamp.ts`）**全部**是
 *   `scripts/check-*.ts` 形态 ⇒ 与它们同构才是本仓库的纪律（C36：同一件事一套做法）。
 *
 * 用法：`pnpm run check:bucket-write`
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type BucketWriteHit, scanSourceTree } from './lib/bucket-write-scan.js';

/**
 * ★ **写死的期望值**：唯一合法的桶表写入点（相对 `src/` 的路径）。
 *
 * ⚠️ **只有这一个文件**（§9.3.0）：`assignBucket` / `unassignBucket` 是**全库唯一**
 *   会写 `vector_cell_members` 的地方 ⇒ 别的文件里出现裸写 = 开了第二个后门。
 * ⚠️ **路径写死为常量**（C31）⇒ 白名单被改宽必须是**一次显式**的改动。
 */
export const ALLOWED_BUCKET_WRITE_FILES: readonly string[] = ['vector/bucketAssign.ts'];

/** 一处不一致。 */
export interface BucketWriteDiff {
  /** 差异说明。 */
  reason: string;
}

/**
 * 判定「裸写桶表」这件事是否合规。
 *
 * @param hits `scanSourceTree()` 的结果
 * @returns 不一致清单（空数组 = 全部合规）
 */
export function checkBucketWriteSites(hits: readonly BucketWriteHit[]): BucketWriteDiff[] {
  const diffs: BucketWriteDiff[] = [];

  // ── ① 命中数 > 0（否则白名单写错成空集 ⇒ 真空守卫）──
  if (hits.length === 0) {
    diffs.push({
      reason:
        '全仓一处裸的桶表写入都没扫到 ⇒ 白名单（或源码）出了问题：' +
        '「每一处都在白名单内」会恒真 ⇒ 闸门变成真空守卫（C31）',
    });
  }

  // ── ② 每一处裸写都必须在白名单里 ──
  for (const hit of hits) {
    if (!ALLOWED_BUCKET_WRITE_FILES.includes(hit.file)) {
      diffs.push({
        reason:
          `${hit.file}:${hit.line} 出现了裸的桶表写入` +
          `（唯一合法的写入点是 ${ALLOWED_BUCKET_WRITE_FILES.join(' / ')}，§9.3.0：` +
          '桶归属的写入只允许出现在一个内部函数里）',
      });
    }
  }

  // ── ③ 白名单里的那个文件**真的**被扫到（否则白名单陈旧 / 那个文件被删了）──
  for (const allowed of ALLOWED_BUCKET_WRITE_FILES) {
    if (!hits.some((hit) => hit.file === allowed)) {
      diffs.push({
        reason: `白名单里的 ${allowed} 一处写入都没扫到 ⇒ 白名单陈旧（或那个文件被删了）`,
      });
    }
  }

  return diffs;
}

/** 主流程。 */
function main(): void {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const srcRoot = resolve(repoRoot, 'src');
  const hits = scanSourceTree(srcRoot);

  process.stdout.write('桶归属唯一写入点的 lint 门禁（§9.3.0）\n');
  process.stdout.write(`  白名单（写死的期望值）：${ALLOWED_BUCKET_WRITE_FILES.join(' / ')}\n`);
  process.stdout.write(`  扫到的裸写处数：${hits.length}\n`);

  const diffs = checkBucketWriteSites(hits);
  if (diffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${diffs.length} 处不一致：\n`);
    for (const diff of diffs) {
      process.stderr.write(`    ${diff.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ 桶归属的写入只出现在唯一写入点（src/vector/bucketAssign.ts）\n');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  main();
}
