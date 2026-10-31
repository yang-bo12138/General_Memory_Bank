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
 *
 * ⚠️ **T05 的硬前置（本模块的依赖，不是本模块的活）**：
 *   §4.15.5 要求「重训 + 重分配桶归属」**必须同事务**
 *   ⇒ 而 `src/vector/centroids.ts` 的 `saveCentroidModel()` **自己开事务**
 *     （`db.transaction(...)`）⇒ better-sqlite3 的事务**不能嵌套**
 *     ⇒ 它**放不进**调用方的事务 ⇒ 「重训 + 重分配同事务」当前**做不到**。
 *   ⇒ 而做不到的后果是 F8：**重训会经 `ON DELETE CASCADE` 清空全库桶归属**
 *     ⇒ 向量路候选集瞬间为空、**且不报错**。
 *   ⇒ **T05 开始前必须先把 `saveCentroidModel` 改成事务透明**（自己不开事务，由调用方开）。
 *   ⇒ 本模块**不依赖** `saveCentroidModel`（它只读中心模型）⇒ 改那处不影响本模块。
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
 * 桶侧**一次扫描**的产物（**对账与 P95 共用** ⇒ 桶表只扫一遍）。
 *
 * ⚠️ ★ **为什么要有它**（P2-T06）：
 *   §9.3.2 ③ 的启动对账与 ④ 的 P95 退化检测**都要读桶侧**：
 *   · 对账要**每一行**（要分出「真孤儿 / 软删 / 无向量」三分支 ⇒ 必须 JOIN `memories`）；
 *   · P95 要**每桶的成员数**（聚合口径）。
 *   ⇒ 两件事若各读一次 ⇒ **桶表被扫两遍**（百万行 ⇒ 白白多花一次全表扫）
 *   ⇒ 而 §9.3.2 ④ 明写「这一遍**可与启动对账合并成同一次扫描**」。
 *   ⇒ 本接口把「桶侧行 + 每桶计数」**一次扫描**同时产出 ⇒ 两边共用。
 */
export interface BucketSideScan {
  /** 桶侧**每一行**（LEFT JOIN 后的原始行）。 */
  rows: BucketSideRow[];
  /**
   * `fine_id` → 成员数（**只列有成员的桶**；不在结果里的桶 = 成员数 0）。
   *
   * ⚠️ **口径与 `listBucketMemberCounts()` 逐条相同**（同一个函数的两个出口 ⇒ C36）。
   */
  counts: Map<string, number>;
}

/**
 * 桶侧的一行（LEFT JOIN 后的原始行）。
 *
 * ⚠️ ★ **只取「有没有向量」，不取向量本体**（`m.embedding IS NULL` 而非 `m.embedding`）：
 *   百万行 × 3KB/行 = **3GB** ⇒ 取本体会让「只算计数」的调用方**平白吃掉 3GB**
 *   ⇒ 而判据只需要知道「它有没有向量」⇒ **只取标志位**。
 */
export interface BucketSideRow {
  /** 桶归属指向的记忆 id。 */
  memoryId: string;
  /** 归属所在的细桶 id。 */
  fineId: string;
  /** JOIN 到的 `memories.id`（`null` = **真孤儿**：JOIN 不到行）。 */
  foundId: string | null;
  /** `memories.deleted`（`null` = JOIN 不到行；`1` = 软删）。 */
  deleted: number | null;
  /** 该记忆**没有向量**？（`true` = `m.embedding IS NULL`）。 */
  hasNoEmbedding: boolean;
}

/**
 * 扫一遍桶侧（**对账与 P95 共用的唯一一次桶表行扫描**）。
 *
 * ⚠️ **LEFT JOIN，不丢硬删孤儿**（§9.3.2 ③）：
 *   用 INNER JOIN 的话**真孤儿**（硬删且 FK 未开）会被一并放过 ⇒ 孤儿永久滞留。
 *
 * ⚠️ **只认「有没有向量」，不取向量本体**（见 `BucketSideRow` 的说明）⇒ 内存不炸。
 *
 * @param db 库句柄
 * @returns 桶侧行 + 每桶成员数
 */
export function scanBucketSide(db: Database.Database): BucketSideScan {
  const rows = db
    .prepare(
      'SELECT vcm.memory_id AS memoryId, vcm.fine_id AS fineId, m.id AS foundId, ' +
        'm.deleted AS deleted, (m.embedding IS NULL) AS hasNoEmbedding ' +
        'FROM vector_cell_members vcm LEFT JOIN memories m ON m.id = vcm.memory_id',
    )
    .all() as Array<{
    memoryId: string;
    fineId: string;
    foundId: string | null;
    deleted: number | null;
    hasNoEmbedding: number;
  }>;

  const counts = new Map<string, number>();
  const scanned: BucketSideRow[] = [];
  for (const row of rows) {
    scanned.push({
      memoryId: row.memoryId,
      fineId: row.fineId,
      foundId: row.foundId,
      deleted: row.deleted,
      hasNoEmbedding: row.hasNoEmbedding === 1,
    });
    counts.set(row.fineId, (counts.get(row.fineId) ?? 0) + 1);
  }

  return { rows: scanned, counts };
}

/**
 * 算**所有细桶的成员数**（现算）—— 桶计数的**唯一口径**之一。
 *
 * ⚠️ **给 `p95BucketSize` / `maxBucketSize` / 兜底切分判定量用**（§4.15.5）：
 *   这三个量都依赖桶计数 ⇒ 它们必须走这一个函数，
 *   否则「同一个量有两份算法」必然漂移（C36）。
 *   ⚠️ **不在结果里的桶 = 成员数为 0**（本函数只列出**有成员**的桶）。
 *
 * ⚠️ **实现走 `scanBucketSide()`**（P2-T06）：桶计数与对账的桶侧行**同源**
 *   ⇒ 「桶计数」只有**一份**实现（C36）⇒ 不可能漂。
 *   ⚠️ **代价**：以前是 `GROUP BY`（索引唯一扫描），现在是 LEFT JOIN 的行扫描
 *   ⇒ 比以前慢 ⇒ 但它**只取标志位不取向量本体**（见 `BucketSideRow`）⇒ 内存不炸。
 *
 * @param db 库句柄
 * @returns `fineId` → 成员数的映射
 */
export function listBucketMemberCounts(db: Database.Database): Map<string, number> {
  return scanBucketSide(db).counts;
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

// ─────────────────────────── 集合相等口径（§9.3.2 ③） ───────────────────────────

/**
 * 桶归属与活记忆的**集合差异**（§9.3.2 ③ 的对账口径）。
 *
 * ⚠️ **四条判据各抓一类问题**（§9.3.2 ③ 末）：
 *   ① `missing`（库侧有向量、桶侧无归属）⇒ 抓「**少**」；
 *   ② `orphans`（桶侧有归属、记忆行已不存在）⇒ 抓「**脏行**」；
 *   ③ `vectorless`（桶侧有归属、记忆已无向量）⇒ 抓「**脏行**」；
 *   ④ `duplicates`（一条记忆挂了多个桶）⇒ 抓「**多**」。
 *   ⇒ **只做 ①是不够的**：只做 ① 会漏「多」与「脏行」；
 *     而 ④ 是**唯一索引**（`idx_vcm_memory_unique`）从**源头**堵住的那一类
 *     （索引挡得住「写进去」，挡不住「历史脏数据」）。
 */
export interface BucketMembershipDiff {
  /**
   * 库侧有向量（且未软删）、桶侧**无归属** ⇒ **该补**（§9.3.2 ③ 的「库侧有、桶侧无」）。
   *
   * ⚠️ **库侧口径是「全库」扫描**（ADR-P1-T07-DEC D-12）：
   *   `SELECT id FROM memories WHERE embedding IS NOT NULL AND deleted = 0`
   *   ⇒ **不是**「本次写入的批次」——若只取本批次，这项就退化成
   *   「本批写的东西都进桶了」⇒ **恰好放不过阶段 1 遗留的欠账**
   *   （有向量、无桶归属的旧记忆）⇒ 阶段 2 什么都没写也会**假绿**。
   */
  missing: string[];
  /**
   * 桶侧有归属、但 **JOIN 不到 `memories` 行** ⇒ **真孤儿** ⇒ **该删**（§9.3.2 ③ 三分支之一）。
   *
   * ⚠️ **桶侧必须用 LEFT JOIN**（§9.3.2 ③）：用 INNER JOIN 的话真孤儿会被一并放过
   *   ⇒ 对账永远「通过」⇒ 孤儿永久滞留。
   */
  orphans: string[];
  /**
   * 桶侧有归属、但记忆是**软删**（`deleted = 1`）⇒ **跳过，不删**（§9.3.2 ②/③）。
   *
   * ⚠️ **一刀切删掉就是永久漏召**：软删记忆仍可 `restore`（§8.2 也要求软删保留向量）
   *   ⇒ 桶行被删 ⇒ `restore()` 回来后那条记忆**永久进不了向量路**
   *   ⇒ 静默、永久、不报错——正是本库反复强调的「唯一的静默失效点」。
   */
  softDeleted: string[];
  /**
   * 桶侧有归属、但记忆的向量已置 `NULL` ⇒ **该删**（§9.3.2 ③ 三分支的第三支）。
   *
   * ⚠️ 无向量的记忆**不该在桶里**：它占着桶的成员名额 ⇒ 桶计数偏大
   *   ⇒ `p95BucketSize` / `maxBucketSize` / 兜底切分判定量**全部偏**。
   */
  vectorless: string[];
  /**
   * 一条记忆挂了**多于一个**桶 ⇒ 重复归属（§9.3.2 ③ 的判据 ②）。
   *
   * ⚠️ **集合比较单独用看不见它**：对账的键是 `memory_id`
   *   ⇒ 一条记忆同时挂两个桶时，它在**两侧都出现** ⇒ 双向差集**查不出它**
   *   ⇒ 必须另配 `COUNT(*) == COUNT(DISTINCT memory_id)`（本项就是那个判据）。
   */
  duplicates: string[];
  /**
   * ★ **库侧活记忆的条数**（`embedding IS NOT NULL AND deleted = 0`）——
   * 对账的**覆盖率分母**（§6 的 `bucketCoverage`）。
   *
   * ⚠️ **新增字段，既有调用方零改动**（老调用方不看它 ⇒ 行为不变）。
   */
  liveCount: number;
  /**
   * ★ **桶侧归属的条数**（`vector_cell_members` 的行数）。
   *
   * ⚠️ **新增字段，既有调用方零改动**。
   */
  bucketCount: number;
}

/**
 * 算「桶归属 ↔ 活记忆」的**集合差异**（§9.3.2 ③ 的对账口径）。
 *
 * ⚠️ **两侧各取 id 集合，绝不用 COUNT 比条数**：
 *   条数相同但**成员不同**（一条漏了、另一条多了）完全可能
 *   ⇒ 「条数对得上」会让人以为对账通过 ⇒ 漏召永久存在且无人发现。
 *
 * ⚠️ **本函数只算差异，不改库**（对账的「补 / 删」是调用方的事）
 *   ⇒ 启动对账（§9.3.2 ③）与本轮的硬断言**共用这一个口径**（C36：同一件事两套实现必然漂移）。
 *
 * @param db 库句柄
 * @param scan **已扫好的桶侧**（可选；不给则本函数自己扫一遍）
 *   ⇒ 启动对账要同时用桶侧行与桶计数 ⇒ 传进来 ⇒ **桶表只扫一遍**（P2-T06）。
 * @returns 集合差异（四类）
 */
export function diffBucketMembership(
  db: Database.Database,
  scan?: BucketSideScan,
): BucketMembershipDiff {
  // ⚠️ **库侧：全库扫描**（ADR-P1-T07-DEC D-12）。
  //   ⚠️ **列名是 `id`，不是 `memory_id`**：`memories` 的主键叫 `id`
  //   ⇒ 抄成 `SELECT memory_id FROM memories` 会直接 SQL 报错。
  const liveRows = db
    .prepare('SELECT id FROM memories WHERE embedding IS NOT NULL AND deleted = 0')
    .all() as Array<{ id: string }>;

  // ⚠️ **桶侧：LEFT JOIN**（不丢硬删孤儿，§9.3.2 ③）。
  //   ⚠️ **给了 `scan` 就复用它** ⇒ 桶表**只扫一遍**（对账与 P95 共用，P2-T06）。
  const bucketRows = (scan ?? scanBucketSide(db)).rows;

  // ⚠️ **判据 ②：COUNT(*) == COUNT(DISTINCT memory_id)**（抓「多」）。
  const duplicateRows = db
    .prepare('SELECT memory_id FROM vector_cell_members GROUP BY memory_id HAVING COUNT(*) > 1')
    .all() as Array<{ memory_id: string }>;

  const bucketIds = new Set(bucketRows.map((row) => row.memoryId));
  const missing = liveRows.map((row) => row.id).filter((id) => !bucketIds.has(id));

  const orphans: string[] = [];
  const softDeleted: string[] = [];
  const vectorless: string[] = [];
  for (const row of bucketRows) {
    if (row.foundId === null) {
      // ⚠️ JOIN 不到 `memories` 行 ⇒ **真孤儿**（硬删且 FK 未开）⇒ 该删。
      orphans.push(row.memoryId);
      continue;
    }
    if (row.deleted === 1) {
      // ⚠️ **软删 ⇒ 跳过，不删**（§9.3.2 ②：软删不删桶归属）。
      softDeleted.push(row.memoryId);
      continue;
    }
    if (row.hasNoEmbedding) {
      // ⚠️ 无向量却还占着桶 ⇒ 该摘掉（§9.3.2 ③ 第三支）。
      vectorless.push(row.memoryId);
    }
  }

  return {
    missing,
    orphans,
    softDeleted,
    vectorless,
    duplicates: duplicateRows.map((row) => row.memory_id),
    liveCount: liveRows.length,
    bucketCount: bucketRows.length,
  };
}

/**
 * 判断桶归属与活记忆**是否一致**（§9.3.2 ③ 的「集合相等」口径）。
 *
 * ⚠️ **软删的记忆不算「不一致」**（§9.3.2 ②：软删保留桶归属）
 *   ⇒ `softDeleted` 里有东西**是正常的**。
 * ⚠️ **其余四类任一非空 ⇒ 不一致**（少 / 脏行 / 多）。
 *
 * @param diff `diffBucketMembership()` 的结果
 * @returns 是否一致
 */
export function isBucketMembershipConsistent(diff: BucketMembershipDiff): boolean {
  return (
    diff.missing.length === 0 &&
    diff.orphans.length === 0 &&
    diff.vectorless.length === 0 &&
    diff.duplicates.length === 0
  );
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
