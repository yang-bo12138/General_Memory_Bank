/**
 * 分桶的**全量重训序列** —— P2-T05（DESIGN-v2.md §4.15.5 的三步硬约束；
 * DEVELOPMENT-PLAN.md P2-T05 的「关键实现要点」）。
 *
 * ⚠️ ★★★ **本模块是「重训三步顺序」的唯一实现**（顺序**不可颠倒**）：
 * ```
 *   ① 建新桶（新一组 coarse/fine cell，centroid 与旧桶无关）
 *   ② 迁成员：按新中心重新分配每条记忆的桶归属
 *   ③ 最后删旧桶（旧 coarse/fine cell 及其成员行随 FK CASCADE 一并消失）
 * ```
 *
 * ⚠️ **为什么不能先删旧桶**（缺了这条 ⇒ **一次重训静默清空全库桶归属**）：
 *   细桶 → 粗桶、`vector_cell_members` → 细桶 ⇒ 删旧粗桶会**级联删掉它下面全部细桶**、
 *   再级联删掉全部成员行 ⇒ **一次重训 = 全库桶归属被清空**（记忆本体不受影响）
 *   ⇒ 向量路整体消失、**不报错、不告警**。
 *   ⚠️ **CASCADE 本身是对的**（自引用链条确实成立）；**错的是没写删除顺序**，
 *     而缺这条时最自然的写法恰好是最坏的那个。
 *
 * ⚠️ **步骤 ② 必须是「逐条记忆 delete-old + insert-new」**：
 *   `idx_vcm_memory_unique`（`memory_id` 唯一，§3）⇒ 若先批量 INSERT 新桶成员行而旧行还在
 *   ⇒ 唯一索引**直接写失败** ⇒ **步骤 ② 本身跑不通**（这不是「防重复的兜底」）。
 *   ⇒ 本模块**复用** `src/vector/bucketAssign.ts` 的 `assignBucket` / `unassignBucket`
 *     （它们内部就是「先 DELETE 再 INSERT」）⇒ **不自己再写一遍**（C36）。
 *
 * ⚠️ **步骤 ③ 之前不得让新桶对外可见**：
 *   步骤 ② 与 ③ 之间旧桶仍存在（成员行已摘空）⇒ 路由若命中一个**空旧桶**
 *   ⇒ 候选集为空 ⇒ 表现为「**漏召**」而非报错。
 *   ⇒ 本模块**不碰中心缓存**（缓存由 store 层在整段重训结束后失效）
 *     ⇒ 路由在整个重训期间继续用**旧中心** ⇒ 新桶对路由不可见。
 *
 * ⚠️ **步骤 ② 分批提交**（§9.2 的反长事务哲学）：
 *   1~3 分钟的批量操作若包成一个大事务 ⇒ 持写锁数分钟、崩溃即全量回滚
 *   ⇒ 本模块**每批一个事务**（批大小 `DEFAULT_REBUILD_BATCH_SIZE`）
 *   ⇒ 崩溃点落在「② 提交了一部分」⇒ 新旧两代桶同时存在
 *   ⇒ **恢复口径**：调用方**重做一次** `rebuildBuckets()`（幂等：按当前全部向量重新分配，
 *     **不依赖上一轮的中间产物**）。
 *
 * ⚠️ **事务由调用方注入**（`runInTransaction` 参数）：
 *   事务语义（全库**唯一一份**实现）在 store 层（`src/store/transaction.ts` 的
 *   `runWriteTransaction`）⇒ **向量层不 import 存储层**（依赖方向单向：store → vector）
 *   ⇒ 本模块只声明「我需要一批一个事务」这个需求，由调用方把实现递进来。
 *
 * ⚠️ **本模块不写 `vector_cell_members`**（§9.3.0 的「桶归属唯一写入点」）：
 *   归属的写入全部走 `assignBucket` / `unassignBucket` ⇒ 本文件里**不出现**桶表的裸写 SQL。
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS } from '../core/params.js';
import {
  type BucketAssignContext,
  assignBucket,
  listBucketMemberCounts,
  unassignBucket,
} from './bucketAssign.js';
import { pruneStaleCentroidCells, upsertCentroidCells } from './centroids.js';
import { buildCentroidModel, readVectorMemories } from './ivf.js';

/**
 * 一次重训的**批次大小**（**每批一个事务**）。
 *
 * ⚠️ **为什么要有批**：见文件头的「步骤 ② 分批提交」——
 *   1~3 分钟的批量操作包成一个大事务 ⇒ 持写锁数分钟、崩溃即全量回滚。
 * ⚠️ **为什么是 500**：与 `src/vector/ivf.ts` 的 `SQL_PARAM_CHUNK` 同量级
 *   （一次事务里几百条「删旧 + 插新」⇒ 单事务耗时在毫秒级 ⇒ 写锁等待可忽略）。
 */
export const DEFAULT_REBUILD_BATCH_SIZE = 500;

/** 一次重训的入参。 */
export interface BucketRebuildOptions {
  /** 粗中心数（§5 `ROUTER_COARSE_CENTERS`）。 */
  coarseCenters: number;
  /** 细中心总数（§5 `ROUTER_FINE_CENTERS`）。 */
  fineCenters: number;
  /** 归属规则用的粗层探针数（缺省 `ROUTER_NPROBE_COARSE`）。 */
  nprobeCoarse?: number;
  /** 落库时间戳（毫秒）——写进 `vector_*_cells.updated_at`。 */
  now: number;
  /** 每批条数（缺省 `DEFAULT_REBUILD_BATCH_SIZE`）。 */
  batchSize?: number;
  /** 内部钩子（**仅供测试与观测**；公开 API 不暴露）。 */
  hooks?: BucketRebuildHooks;
}

/**
 * 重训过程的内部钩子（**仅供测试与观测**）。
 *
 * ⚠️ **为什么要有**：§4.15.5 的验收标准里有两条**只能在过程里观察**的断言：
 *   ① 「步骤 ③ 之前旧代桶仍在、步骤 ③ 之后旧代桶全部消失」
 *      ⇒ 需要在步骤之间取样；
 *   ② 「单条记忆的 DELETE + INSERT 在同一个事务内（用并发读者验证：
 *      事务外读者永不见中间态）」
 *      ⇒ 需要在**事务之内**取样。
 *   ⇒ 过程里没有取样点 ⇒ 这两条断言只能靠「变异实测」间接验 ⇒ 闸门变虚。
 */
export interface BucketRebuildHooks {
  /** 步骤 ① 完成（中心已落库；**旧桶一个都没删**）。 */
  onCentroidsWritten?: () => void;
  /**
   * 步骤 ② 的每一批**开始前**（**在事务之外**）。
   *
   * ⚠️ **在事务之外**是刻意的：钩子里抛错 ⇒ 该批**根本没执行**、之前的批**已提交**
   *   ⇒ 正好模拟「崩溃点落在『② 提交了一部分』」。
   */
  onBatchStart?: (batchIndex: number, batchSize: number) => void;
  /**
   * 步骤 ② 的每条记忆**迁完之后**（**在事务之内**）。
   *
   * ⚠️ **在事务之内**是刻意的：并发读者（另一条连接）在这里读到的必须是
   *   **该批提交之前**的状态 ⇒ 证明 DELETE + INSERT 从不暴露中间态。
   */
  onMemberAssigned?: (memoryId: string) => void;
  /**
   * 步骤 ② **整批迁完**（在步骤 ③ 之前）。
   *
   * ⚠️ **这是「旧桶仍在、新桶已生效」那个取样点**（§4.15.5 的删除顺序断言）：
   *   此刻旧代桶**一个都还没删**（成员行已摘空）⇒ 路由若命中空旧桶 ⇒ 静默漏召。
   */
  onMembersMigrated?: () => void;
  /** 步骤 ③ 完成（旧代桶已清空）。 */
  onStalePruned?: () => void;
}

/** 一次重训的结果。 */
export interface BucketRebuildResult {
  /**
   * 新一代的**细桶**数（持有成员的桶）。
   *
   * ⚠️ **口径**：`cells` 字段进事件（§8.4 的 `action='rebuildBuckets'` ⇒ `cells, members`）
   *   ⇒ 取**细桶**数（粗桶是细桶的父级，不直接持有成员）。
   */
  cells: number;
  /** 新一代的**粗桶**数。 */
  coarseCells: number;
  /** 迁完后的**桶归属条数**（`members` 字段进事件）。 */
  members: number;
  /** 步骤 ② 实际迁移的条数（含软删记忆）。 */
  migrated: number;
  /** 步骤 ② 摘掉的脏归属条数（有归属但记忆已无向量）。 */
  unassigned: number;
}

/**
 * 重训两级分桶 + 全量重分配（§4.15.5 的三步序列）。
 *
 * ⚠️ ★ **本函数是「桶归属怎么写」的唯一实现**（§9.3.0）：
 *   归属的写入全部走 `assignBucket` / `unassignBucket`（`src/vector/bucketAssign.ts`）
 *   ⇒ 本文件里**不出现**桶表的裸写 SQL ⇒ 静态扫描（`scripts/check-bucket-write.ts`）守得住。
 *
 * ⚠️ **幂等**：连做两次 ⇒ 结果**逐条相同**。
 *   依据：① 桶 id 是**索引派生**的（`c-000` / `f-000-000`，§4.15.3）⇒ 同一份数据两次训练
 *   得到**同一套 id**；② 归属按「当前全部向量」重算 ⇒ 与上一轮的中间产物无关。
 *   ⚠️ **这也是「不引入代际标记」的理由**：代际 token 会让「连做两次结果逐条相同」失效。
 *
 * ⚠️ **崩溃可恢复**：步骤 ② 分批提交 ⇒ 崩溃点落在「提交了一部分」时，
 *   库里是「部分迁移」的中间态（**每条记忆仍有且仅有一个归属** ⇒ 库仍可用）
 *   ⇒ **重做一次**即可回到完整状态（幂等）。
 *
 * @param db 库句柄
 * @param runInTransaction 事务包装（**由调用方注入**：事务语义只有 store 层那一份实现）
 * @param options 重训参数
 * @returns 重训结果（桶数 / 归属条数 / 迁移条数）
 */
export function rebuildBuckets(
  db: Database.Database,
  runInTransaction: <T>(body: () => T) => T,
  options: BucketRebuildOptions,
): BucketRebuildResult {
  const nprobeCoarse = options.nprobeCoarse ?? DEFAULT_PARAMS.ROUTER_NPROBE_COARSE;
  const batchSize = options.batchSize ?? DEFAULT_REBUILD_BATCH_SIZE;
  const hooks = options.hooks ?? {};

  // ── 准备：读「全部有向量的记忆」+ 训练新一代中心（**纯计算，不落库**）──
  // ⚠️ **训练用活记忆、迁移用全部有向量的记忆**（含软删）：
  //   软删记忆**保留向量**（§8.2）⇒ 它在桶里也有一席之地（§9.3.2 ②：软删不删桶归属）
  //   ⇒ 不迁移它 ⇒ 它的归属挂在旧代桶上 ⇒ 旧代桶被清空时被级联删掉
  //   ⇒ `restore()` 之后它**永久进不了向量路**（静默、永久、不报错）。
  const memories = readVectorMemories(db);
  const trainingVectors = memories.filter((row) => !row.deleted).map((row) => row.vector);
  const model = buildCentroidModel(trainingVectors, {
    coarseCenters: options.coarseCenters,
    fineCenters: options.fineCenters,
  });

  // ⚠️ **归属上下文指向「新模型」**（不是缓存里的旧模型）：
  //   步骤 ② 必须按**新中心**重新分配 ⇒ 缓存里的旧中心在这一步是错的。
  const context: BucketAssignContext = {
    db,
    centroids: () => model,
    nprobeCoarse,
  };

  // ══════════════════ 步骤 ① ：建新桶（**只写不删**） ══════════════════
  // ⚠️ **只写不删**：`upsertCentroidCells` 用 `ON CONFLICT DO UPDATE`（纯 UPDATE）
  //   ⇒ **不触发 FK CASCADE** ⇒ 旧归属**一条都没少**。
  //   ⚠️ **这里绝不能调 `saveCentroidModel`**（它先删陈旧行 ⇒ 级联清空归属 ⇒ 向量路瞬间消失）。
  runInTransaction(() => {
    upsertCentroidCells(db, model, options.now);
  });
  hooks.onCentroidsWritten?.();

  // ══════════════════ 步骤 ② ：迁成员（逐条 delete-old + insert-new） ══════════════════
  let migrated = 0;
  let batchIndex = 0;
  for (let offset = 0; offset < memories.length; offset += batchSize) {
    const batch = memories.slice(offset, offset + batchSize);
    // ⚠️ **钩子在事务之外** ⇒ 钩子里抛错 = 模拟「崩在这一批之前」（之前的批已提交）。
    hooks.onBatchStart?.(batchIndex, batch.length);
    runInTransaction(() => {
      for (const member of batch) {
        // ⚠️ **`assignBucket` 内部就是「先 DELETE 旧归属、再 INSERT 新归属」**
        //   （§4.15.5 的唯一正确形状）⇒ 唯一索引在**任何时刻**都不被违反。
        assignBucket(context, member.id, member.vector);
        migrated += 1;
        hooks.onMemberAssigned?.(member.id);
      }
    });
    batchIndex += 1;
  }

  // ── 步骤 ② 补：摘掉「有归属、但记忆已无向量」的脏行 ──
  // ⚠️ **为什么必须摘**：§4.15.3 第三条「没向量 ⇒ 桶里不该有它」
  //   ⇒ 它占着桶的成员名额 ⇒ 桶计数偏大 ⇒ `p95BucketSize` / `maxBucketSize` 全部偏
  //   ⇒ 而且它会让「桶归属 ↔ 活记忆」的集合相等断言**永远不成立**（§9.3.2 ③ 的第三分支）。
  const vectorIds = new Set(memories.map((row) => row.id));
  const staleMemberships = listMembershipIds(db).filter((id) => !vectorIds.has(id));
  if (staleMemberships.length > 0) {
    runInTransaction(() => {
      for (const memoryId of staleMemberships) {
        unassignBucket(context, memoryId);
      }
    });
  }

  // ⚠️ **取样点**：此刻旧代桶**一个都还没删**（成员行已摘空）
  //   ⇒ 路由若命中一个**空旧桶** ⇒ 候选集为空 ⇒ 表现为「**漏召**」而非报错（§4.15.5）。
  hooks.onMembersMigrated?.();

  // ══════════════════ 步骤 ③ ：最后删旧桶 ══════════════════
  // ⚠️ **必须最后**：删桶会**级联删归属** ⇒ 步骤 ② 没迁完就删 ⇒ 那些记忆**永久没有归属**
  //   ⇒ 向量路召不回它们、**不报错、不告警**。
  //
  // ⚠️ ★ **「新代桶」与「空的旧代桶」的判据**（§4.15.5 的崩溃恢复推论所必需）——
  //   **判据 = 「该 fine_id / coarse_id 不在新模型里」**：
  //   · **在新模型里** ⇒ **新代桶**（哪怕成员数为 0 也是合法的 ⇒ **不删**）：
  //     `assignFineBucket()` 仍可能返回它 ⇒ 删了会让后续 `assignBucket()` 撞外键
  //     ⇒ **写入路径直接崩**（`NOT_FOUND`）；
  //   · **不在新模型里** ⇒ **旧代桶**（陈旧行）⇒ **必须删**（就是这一步）：
  //     否则路由可能命中一个空旧桶 ⇒ 候选集为空 ⇒ **静默漏召**。
  //   ⚠️ **为什么不用 `updated_at` 判代**：桶 id 是**索引派生**的（`c-000` / `f-000-000`）
  //     ⇒ 两代**同形**时 id **完全相同** ⇒ `updated_at` 只会显示「中心被重写过」，
  //     **区分不出两代** ⇒ 用它判代会把**新代桶**误判成旧代桶 ⇒ 这一步会把新代桶删光。
  //   ⚠️ **为什么不用「成员数为 0」单独判**：新模型里**合法存在**成员数为 0 的细桶
  //     （k-means 的空簇、或探针规则下没人落进去的簇）⇒ 按成员数删会**删掉新代桶**
  //     ⇒ 同上 ⇒ 写入路径崩。
  //   ⚠️ **推论（桶 id 是索引派生的）**：两代**同形**时「建新桶」= **重写中心**
  //     （`ON CONFLICT DO UPDATE` ⇒ 纯 UPDATE ⇒ 不触发级联 ⇒ 旧归属一条不少），
  //     「删旧桶」= 删掉**形状变化后残留**的桶
  //     ⇒ 崩溃恢复时「新旧两代桶同时存在」的实际形态是
  //     **「中心已换、归属只迁了一半」** ⇒ 重做一次即可（幂等）。
  //   ⚠️ **判据的落点**：`src/vector/centroids.ts` 的 `pruneStaleCentroidCells()`
  //     （它删的就是「不在模型里」的桶）⇒ 判据只有**一份**实现（C36）。
  runInTransaction(() => {
    pruneStaleCentroidCells(db, model);
  });
  hooks.onStalePruned?.();

  // ── 结果 ──
  // ⚠️ **桶计数走 `listBucketMemberCounts`**（桶计数的唯一口径，§4.15.5）
  //   ⇒ 不另写一份 `COUNT(*)`。
  let members = 0;
  for (const count of listBucketMemberCounts(db).values()) {
    members += count;
  }

  return {
    cells: model.fine.length,
    coarseCells: model.coarse.length,
    members,
    migrated,
    unassigned: staleMemberships.length,
  };
}

/**
 * 读出**全部**桶归属的记忆 id（`vector_cell_members` 的读取点之一）。
 *
 * ⚠️ **这是读、不是写** ⇒ 不违反 §9.3.0 的「桶归属唯一写入点」。
 */
function listMembershipIds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT memory_id FROM vector_cell_members').all() as Array<{
    memory_id: string;
  }>;
  return rows.map((row) => row.memory_id);
}
