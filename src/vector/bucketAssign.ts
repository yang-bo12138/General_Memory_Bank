/**
 * 桶归属的**唯一写入点** —— P2-T03-a（DESIGN-v2.md §9.3.0 / §4.15.5；
 * DEVELOPMENT-PLAN.md P2-T03 的「关键实现要点」）。
 *
 * ⚠️ **本模块是 P2 的第三块砖**，也是「桶归属唯一写入点」这条铁律的落地：
 *   §9.3.0 的架构裁决原文是「桶归属的写入**只允许出现在一个内部函数里**」，
 *   而「为什么用函数而不是注释提醒」的理由（同 §4.2 `growStability` 的先例）是：
 *   「注释提醒会漏读、后续新增路径又会忘；单一函数则让『漏』变成**编译不过**。」
 *   ⇒ 本模块提供 `assignBucket` / `unassignBucket` 两个函数，
 *     **全库写 `vector_cell_members` 的地方只有这里**
 *     （由 `tests/unit/bucketAssign.test.ts` 的静态扫描断言守着
 *     ⇒ T04 的 lint 规则照这条形状落地即可，不用返工）。
 *
 * ⚠️ ★ **换桶必须「先 DELETE 旧归属行、再 INSERT 新行」**（§4.15.5）：
 *   `INSERT OR REPLACE` 只按 `(fine_id, memory_id)` 复合主键覆盖
 *   ⇒ **换桶（`fine_id` 变了）不会删掉旧行** ⇒ 一条记忆同时挂在两个桶上
 *   ⇒ 候选集里出现重复，且桶计数偏大。
 *   ⇒ **这是本机制唯一的静默失效点**（§4.15.5）。
 *   ⚠️ 唯一索引 `idx_vcm_memory_unique` 只保证「写不进去」，**保证不了「不重复」**：
 *     换桶场景下它直接抛 `UNIQUE constraint failed` ⇒ 迁移步骤 ② 本身跑不通。
 *
 * ⚠️ **本模块不开事务**（§4.15.5 / §9.3.2 ①）：
 *   better-sqlite3 的事务**不能嵌套** ⇒ 若本模块自己 `db.transaction(...)`，
 *     调用方再包一层就会炸（"cannot start a transaction within a transaction"）。
 *   ⇒ 两个函数**必须在调用方的事务内**执行；
 *     并且**主动检查 `db.inTransaction`** ⇒ 事务外调用会**抛错**，
 *     而不是静默留下「记忆在、桶不在」的孤儿（§9.3.2 ① 点名的静默失效点）。
 *
 * ⚠️ **桶计数是「现算」的，不是某个计数器列**：
 *   `vector_cell_members` **没有 `member_count` 列**（§3 的 DDL）
 *   ⇒ 加列要改 schema、要走迁移 ⇒ 本模块**不改 schema**（零迁移风险），
 *     改用 `countBucketMembers` / `listBucketMemberCounts` 作为**计数的唯一口径**
 *     （C36：同一件事不得有两套词）——
 *     `p95BucketSize` / `maxBucketSize` / 兜底切分判定量一律走这两个函数。
 *
 * ⚠️ **表名不外泄**：本模块是 `vector_cell_members` 的**唯一写入点**；
 *   读取点只有两处 —— 本模块（计数 / 归属查询）与 `src/vector/ivf.ts`（桶内检索）
 *   ⇒ 流水线永远不引用表名（§4.6 步骤 2c）。
 */

import type Database from 'better-sqlite3';

import { MemoryError, translateSqliteError } from '../core/errors.js';
import { DEFAULT_PARAMS } from '../core/params.js';
import type { IvfCentroidModel } from './centroids.js';
import { assertValidEmbedding } from './dot.js';
import { assignFineBucket } from './ivf.js';

/**
 * 桶归属写入所需的**上下文**（事务由调用方开）。
 *
 * ⚠️ **为什么用「上下文对象」而不是裸参数**（同 §4.2 `growStability(store, …)` 的先例）：
 *   本模块需要三样东西——`db`（写归属）、中心模型（算归属）、探针数（算归属）——
 *   ⇒ 打包成一个对象传，调用点读起来是 `assignBucket(store.buckets, id, vector)`，
 *     **将来加第四样东西不必改所有调用点的参数表**。
 *   ⚠️ **不自带 `db`**：库里可能有多份库（不同的 `db` 句柄），
 *     把句柄藏在模块级变量里会让「写的是哪个库」变成隐式的 ⇒ 不可测。
 */
export interface BucketAssignContext {
  /** 库句柄（写 `vector_cell_members`）。 */
  db: Database.Database;
  /**
   * 中心模型提供者（通常传 `() => cache.model()`）。
   *
   * ⚠️ **每次调用都会取一次**（命中与否由提供者自己负责）——
   *   重训之后必须让缓存失效（`CentroidCache.reload()`），
   *   否则会拿**旧中心**算归属（§4.15.5：重训后必须让中心缓存失效）。
   */
  centroids: () => IvfCentroidModel;
  /**
   * 粗层探针数（缺省 `ROUTER_NPROBE_COARSE`）。
   *
   * ⚠️ **必须与训练时用的探针数一致**（§4.15.3）：
   *   训练期与运行期用同一套规则 ⇒ 训练算出的归属与写入算出的归属一致
   *   ⇒ 否则一条记忆会在下次写入时被**重新归桶**（无谓的桶 churn）。
   */
  nprobeCoarse?: number;
}

/** 一次归属写入的**结果**（把「有没有入桶」显式交出去，不让它静默）。 */
export interface BucketAssignmentResult {
  /** 归属的细桶 id；`null` = **分桶尚未训练**（模型为空）⇒ 没有归属。 */
  fineId: string | null;
  /** 是否真的写进了归属（`false` = 模型为空 ⇒ 一条都没写）。 */
  assigned: boolean;
  /** 写入前的旧归属（`null` = 此前没有归属）。 */
  previousFineId: string | null;
  /** 归属是否**换**了桶（换桶 = `true`；原地覆盖 = `false`）。 */
  changed: boolean;
}

/**
 * 把一条记忆归入**最近的细桶** —— 桶归属的**唯一写入点**（§9.3.0）。
 *
 * ⚠️ **内部固定四步，顺序不可换**（§9.3.0 的原文形状）：
 *   ① 算最近细桶（复用 `assignFineBucket`）；
 *   ② **DELETE 旧归属**（换桶不残留的唯一保障，§4.15.5）；
 *   ③ INSERT 新归属；
 *   ④ 桶计数（**现算** ⇒ ①②③ 天然正确，不需要「−1/+1」这种手工记账）。
 *
 * ⚠️ **「先 DELETE 再 INSERT」不能换成 `INSERT OR REPLACE`**（§4.15.5）：
 *   复合主键是 `(fine_id, memory_id)` ⇒ 换桶时旧行的 `fine_id` 不同 ⇒ 不会被覆盖
 *   ⇒ 一条记忆同时挂在两个桶上（候选集重复 + 桶计数偏大）。
 *   ⚠️ 而唯一索引 `idx_vcm_memory_unique` 只保证「写不进去」——
 *     **保证不了「不重复」**（它会让上面的写法直接抛 `UNIQUE constraint failed`）。
 *
 * ⚠️ **必须在调用方的事务内调用**（§9.3.2 ①：桶归属与 `memories` 同事务写）：
 *   事务外调用 ⇒ 抛 `INVALID_INPUT`（不静默留孤儿归属）。
 *
 * ⚠️ **「没传向量」不是本函数的职责**：置 `NULL` 的路径必须调 `unassignBucket`
 *   （§4.15.3 的增量归桶规则第三条）——桶里留一条没有向量的行
 *   ⇒ 桶计数偏大 ⇒ `p95BucketSize` / `maxBucketSize` / 兜底切分判定量**全部偏**。
 *
 * ⚠️ **分桶尚未训练时（模型为空）不抛错、也不写归属**：
 *   抛错会让整个库不可写（写路径是主 API）；
 *   而「静默不写」就是 §9.3.2 ① 点名的那个静默失效点
 *   ⇒ 折中：**返回值显式交出「没入桶」**（`assigned: false`），
 *     调用方可以记日志，启动对账（§9.3.2 ③）会清偿这笔欠账。
 *
 * @param context 上下文（`db` + 中心模型提供者 + 探针数）
 * @param memoryId 记忆 id（必须已存在于 `memories`——外键会兜住）
 * @param vector 该记忆的向量（**已 L2 归一化**；与 `memories.embedding` 同构）
 * @returns 归属写入的结果（`fineId` / `assigned` / `previousFineId` / `changed`）
 * @throws {MemoryError} `INVALID_INPUT`（事务外调用 / 向量不合法）；FK 违规 ⇒ `NOT_FOUND`
 */
export function assignBucket(
  context: BucketAssignContext,
  memoryId: string,
  vector: Float32Array,
): BucketAssignmentResult {
  const db = context.db;
  assertInWriteTransaction(db, 'assignBucket');
  assertMemoryId(memoryId);
  // ⚠️ **向量校验走 `dot.ts` 的唯一权威**（§4.9 写入口径：维度 / NaN / 零向量一条都不放宽）。
  //   维度取 `DEFAULT_PARAMS.EMBED_DIM`：向量层与 `ivf.ts` / `centroids.ts` 同口径
  //   （`EMBED_DIM` 是只读参数，§6）。
  assertValidEmbedding(vector, DEFAULT_PARAMS.EMBED_DIM);

  const model = context.centroids();
  const nprobeCoarse = context.nprobeCoarse ?? DEFAULT_PARAMS.ROUTER_NPROBE_COARSE;
  // ⚠️ ★ **复用 `assignFineBucket`**（§4.15.3 的增量归桶规则）：
  //   同一件事不得有两套词（C36）——自己再实现一遍「最近细桶」⇒ 训练期与运行期会漂移
  //   ⇒ 训练算出的归属与写入算出的归属不一致 ⇒ 一条记忆在下次写入时被无谓地重新归桶。
  const fineId = assignFineBucket(model, vector, nprobeCoarse);

  const previousFineId = readMembership(db, memoryId);

  if (fineId === null) {
    // ⚠️ **分桶尚未训练 ⇒ 没有可归属的桶**（§4.15.3：「模型为空 ⇒ 向量路整体缺席」）。
    //   这里**不写**归属，也**不抛错**；但也**不是静默**——
    //   返回值把「没入桶」显式交出去（`assigned: false`）。
    return { fineId: null, assigned: false, previousFineId, changed: false };
  }

  try {
    // ⚠️ ★★★ **换桶的唯一正确形状**（§4.15.5）：先 DELETE 旧归属行、再 INSERT 新行。
    //   ⇒ 唯一索引在**任何时刻**都不被违反，
    //   ⇒ 「一条记忆同时挂两个桶」的状态**根本不存在**（而不是「存在但会被索引挡下」）。
    db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run(memoryId);
    db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
      fineId,
      memoryId,
    );
  } catch (error) {
    // ⚠️ **裸的 SQLite 错误码绝不能抛给调用方**（§11.2）：
    //   外键违规（记忆不存在）⇒ `NOT_FOUND`；唯一性冲突 ⇒ `CONFLICT`。
    //   ⚠️ **转译只有一份实现**：`src/core/errors.ts` 的 `translateSqliteError`
    //   （§14.3 边界原则 1：每个承诺指到唯一代码路径）。
    throw translateSqliteError(error, { path: db.name });
  }

  return {
    fineId,
    assigned: true,
    previousFineId,
    changed: previousFineId !== fineId,
  };
}

/**
 * 把一条记忆从所有桶里摘出来 —— 桶归属的**唯一写入点**（§9.3.0）。
 *
 * ⚠️ **什么时候必须调它**：§4.15.3 的增量归桶规则第三条——
 *   「**没传向量（置 NULL）⇒ 必须 `unassignBucket(id)`**」。
 *   桶里留一条没有向量的行 ⇒ 桶计数偏大 ⇒
 *   `p95BucketSize` / `maxBucketSize` / 兜底切分判定量**全部偏**。
 *   ⇒ 这一行不能省，**也不能「保留旧向量」**。
 *
 * ⚠️ **与 §9.3.2 ② 不冲突**：那条说的是「**软删**不删桶归属」
 *   （软删记忆仍可 `restore`，§8.2 也要求软删保留向量）——
 *   本函数管的是「**向量没了**」，两件事的触发条件不同。
 *
 * ⚠️ **幂等**：对没有归属的 id 调用不报错（删 0 行是合法的）。
 *
 * ⚠️ **必须在调用方的事务内调用**（与 `memories.embedding = NULL` 同事务，§9.3.2 ①）。
 *
 * @param context 上下文（`db`）
 * @param memoryId 记忆 id
 * @throws {MemoryError} `INVALID_INPUT`（事务外调用 / id 非法）
 */
export function unassignBucket(context: BucketAssignContext, memoryId: string): void {
  const db = context.db;
  assertInWriteTransaction(db, 'unassignBucket');
  assertMemoryId(memoryId);
  try {
    db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run(memoryId);
  } catch (error) {
    throw translateSqliteError(error, { path: db.name });
  }
}

/**
 * 算**一个细桶的成员数**（现算）—— 桶计数的**唯一口径**之一。
 *
 * ⚠️ **为什么现算而不加 `member_count` 列**：
 *   §3 的 DDL 里 `vector_cell_members` **没有**计数列 ⇒ 加列要改 schema、要走迁移
 *   ⇒ 零迁移风险的现算口径是：计数 = `COUNT(*)`（永远与行一致，**不可能漂移**）。
 *   ⇒ 换桶时的「−1/+1」不是两次记账，而是 **DELETE 少一行、INSERT 多一行**的自然结果。
 *
 * @param db 库句柄
 * @param fineId 细桶 id
 * @returns 桶内成员数
 */
export function countBucketMembers(db: Database.Database, fineId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM vector_cell_members WHERE fine_id = ?')
    .get(fineId) as { count: number };
  return row.count;
}

/**
 * 算**所有细桶的成员数**（现算）—— 桶计数的**唯一口径**之一。
 *
 * ⚠️ **给 `p95BucketSize` / `maxBucketSize` / 兜底切分判定量用**（§4.15.5）：
 *   这三个量都依赖桶计数 ⇒ 它们必须走这一个函数，
 *   否则「同一个量有两份算法」必然漂移（C36）。
 *   ⚠️ **不在结果里的桶 = 成员数为 0**（本函数只列出**有成员**的桶）。
 *
 * @param db 库句柄
 * @returns `fineId` → 成员数的映射
 */
export function listBucketMemberCounts(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare('SELECT fine_id, COUNT(*) AS count FROM vector_cell_members GROUP BY fine_id')
    .all() as Array<{ fine_id: string; count: number }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.fine_id, row.count);
  }
  return counts;
}

/**
 * 读一条记忆当前的桶归属（`null` = 没有归属）。
 *
 * ⚠️ **只读**：本函数是 `vector_cell_members` 的**读取**点之一
 *   （另一个是 `src/vector/ivf.ts` 的桶内检索）⇒ **不写** ⇒ 不违反「唯一写入点」。
 */
function readMembership(db: Database.Database, memoryId: string): string | null {
  const row = db
    .prepare('SELECT fine_id FROM vector_cell_members WHERE memory_id = ?')
    .get(memoryId) as { fine_id: string } | undefined;
  return row?.fine_id ?? null;
}

/**
 * 守卫：**必须在写事务内调用**。
 *
 * ⚠️ **为什么把「事务外调用」变成抛错而不是注释提醒**：
 *   §4.15.5 / §9.3.2 ① 的要求是「桶归属与 `memories` 的写入**必须同事务**」。
 *   若本模块自己开事务 ⇒ 与调用方的事务**嵌套** ⇒ better-sqlite3 直接炸
 *   （"cannot start a transaction within a transaction"）
 *   ⇒ 本模块**不开**事务，但也不靠自觉：**主动检查**。
 *   ⇒ 事务外调用 ⇒ 抛错 ⇒ 「漏」从「静默」变成「响亮」
 *   （同 §9.3.0 的原话：单一函数则让『漏』变成**编译不过**）。
 */
function assertInWriteTransaction(db: Database.Database, fn: string): void {
  if (!db.inTransaction) {
    throw MemoryError.invalidInput(
      `${fn} 必须在写事务内调用：桶归属与 memories 的写入必须同事务（§9.3.2 ①）`,
      { reason: 'not-in-transaction', fn },
    );
  }
}

/** 守卫：记忆 id 不得为空（空 id 会撞外键，报错信息很难读）。 */
function assertMemoryId(memoryId: string): void {
  if (typeof memoryId !== 'string' || memoryId.length === 0) {
    throw MemoryError.invalidInput('记忆 id 不得为空串', {
      reason: 'id',
      expected: '非空字符串',
      actual: String(memoryId),
    });
  }
}
