/**
 * 桶归属的**测试夹具** —— 桶归属上下文（中心模型 + 写入上下文）。
 *
 * ⚠️ **为什么单独一个文件**：四条 embedding 赋值路径的夹具都要「桶归属上下文」，
 *   而它的形状只有一份 ⇒ 造多份必然漂移（C36：同一件事不得有两套词）。
 *   ⇒ 「**未训练**」（模型为空）与「**已训练**」两种各一个入口。
 *
 * ⚠️ **两种上下文的区别（决定断言怎么写）**：
 *   · `createUntrainedBucketContext()` ⇒ 库里**没有桶** ⇒ `assignBucket` 返回
 *     `assigned: false`（**不写任何桶行**，也不抛错）⇒ 「库里有向量、桶侧无归属」
 *     ——这正是 §9.3.2 ① 点名的静默失效点，由**启动对账**（T06）清偿。
 *   · `createTrainedBucketContext()` ⇒ 库里**有桶** ⇒ 写入路径真的会落桶归属
 *     ⇒ 四条路径的同步断言必须用它（否则断言的是「没入桶」的分支）。
 */

import type Database from 'better-sqlite3';

import type { BucketAssignContext } from '../../src/vector/bucketAssign.js';
import {
  CentroidCache,
  type IvfCentroidModel,
  loadCentroidModel,
} from '../../src/vector/centroids.js';
import { trainCentroids } from '../../src/vector/ivf.js';
import { insertMemory, pseudoUnitVector } from './vector.js';

/** 训练夹具的默认时间基准。 */
const T0 = 1_700_000_000_000;

/**
 * 造一个「桶**尚未训练**」的桶归属上下文。
 *
 * ⚠️ **不建缓存**（每次现读）：这个上下文对应的是「库里没有桶」的库
 *   ⇒ 中心模型恒为空 ⇒ `assignFineBucket` 返回 `null` ⇒ `assignBucket` 不写任何行。
 *   ⇒ **不建缓存**是为了「库后来被训练了」时这个上下文也能立刻看到新模型
 *   （测试里「先写、后训练、再写」这种顺序必须能观察到真实变化）。
 *
 * @param db 库句柄
 * @returns 桶归属上下文（模型为空）
 */
export function createUntrainedBucketContext(db: Database.Database): BucketAssignContext {
  return { db, centroids: () => loadCentroidModel(db) };
}

/**
 * 造一个「桶**已训练**」的桶归属上下文（先训练、再建缓存 ⇒ 缓存里就是新模型）。
 *
 * ⚠️ **训练需要样本**：库里得有带向量的记忆（`trainCentroids` 读
 *   `memories.embedding IS NOT NULL` 的行）⇒ 本函数自己落一批种子记忆。
 *   ⇒ 种子记忆**不入桶**（它们是「阶段 1 的欠账」样本）——
 *   正是它们让「集合相等」断言**能红**（见 `tests/unit/bucketSync.test.ts`）。
 *
 * @param db 库句柄
 * @param options 训练参数
 * @returns 桶归属上下文 + 训练出的中心模型
 */
export function createTrainedBucketContext(
  db: Database.Database,
  options?: { count?: number; coarseCenters?: number; fineCenters?: number },
): { buckets: BucketAssignContext; model: IvfCentroidModel } {
  const count = options?.count ?? 40;
  for (let index = 0; index < count; index += 1) {
    // ⚠️ **复用向量的公共夹具**（`tests/fixtures/vector.ts` 的 `insertMemory`）
    //   ⇒ 「落一条带向量的记忆」只有一份实现（C36：同一件事不得有两套词）。
    insertMemory(db, `seed-${String(index).padStart(3, '0')}`, pseudoUnitVector(index + 1));
  }

  const result = trainCentroids(db, {
    coarseCenters: options?.coarseCenters ?? 4,
    fineCenters: options?.fineCenters ?? 12,
    maxIterations: 5,
    now: T0,
  });

  // ⚠️ **缓存建在训练之后** ⇒ 缓存里就是刚训练出来的模型（建在训练之前会缓存到空模型）。
  const cache = new CentroidCache(db);
  const buckets: BucketAssignContext = {
    db,
    centroids: () => cache.model(),
    // ⚠️ **探针数留空** ⇒ 用缺省 `ROUTER_NPROBE_COARSE`（§5），
    //   它与训练时用的探针数**同源**（§4.15.3：训练期与运行期用同一套规则
    //   ⇒ 训练算出的归属与写入算出的归属一致 ⇒ 不会产生无谓的桶 churn）。
  };
  return { buckets, model: result.model };
}
