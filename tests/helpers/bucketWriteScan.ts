/**
 * 「桶归属唯一写入点」静态扫描的**测试侧入口** —— **re-export**，不持有实现。
 *
 * ⚠️ **实现只有一份**（`scripts/lib/bucket-write-scan.ts`，生产侧）：
 *   lint 门禁是**生产侧**的门禁（`scripts/` 才是门禁的家）
 *   ⇒ 它**不能 import 测试目录的模块**（测试目录不是生产产物）
 *   ⇒ 所以实现必须住在 `scripts/lib/` 下，测试侧**改为 re-export**
 *   ⇒ 两处共用一份正则 ⇒ 不会漂移（C36：同一件事不得有两套词）。
 *
 * ⚠️ **本文件只做 re-export**：任何实现都不许写在这里
 *   （写在这里 ⇒ 门禁与测试各扫各的 ⇒ 两份正则迟早漂移）。
 */

export {
  type BucketWriteHit,
  findMembershipWriteSites,
  listSourceFiles,
  scanSourceTree,
  stripCommentLines,
} from '../../scripts/lib/bucket-write-scan.js';
