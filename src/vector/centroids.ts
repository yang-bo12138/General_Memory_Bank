/**
 * 两级桶中心的**模型 / 落盘格式 / 加载与缓存** —— P2-T02
 * （DESIGN-v2.md §4.15.3 / §3 的 `vector_coarse_cells` / `vector_fine_cells` DDL）。
 *
 * ⚠️ **本模块是「中心向量」的唯一格式权威**：
 *   桶中心存 **Float32 小端、L2 归一化**的向量（§4.15.3：「与 memories.embedding 同构」）
 *   ⇒ 本模块的 `vectorToBlob` / `blobToVector` **就是** `memories.embedding` 的同一个格式
 *   ⇒ 向量层与存储层共用**一份**编解码实现（C36：同一件事不得有两套词/两份实现）。
 *   ⚠️ `src/store/merge.ts` 里另有一份同格式实现（它早于向量层）——
 *     **收敛到本模块是待办**（已上报主理人，与 P2-T01 的 `MIN_VECTOR_NORM` 收敛同一批）。
 *
 * ⚠️ **本模块只管「中心」**：训练在 `src/vector/ivf.ts`（两级训练 + 赋值规则），
 *   后端也在那里 ⇒ **无循环依赖**（本模块不 import `ivf.ts`）。
 *
 * ⚠️ **表名的唯一出处就在本模块**（§4.6 步骤 2c 的硬边界：
 *   「流水线**不得**直接引用 `vector_coarse_cells` / `vector_fine_cells` /
 *   `vector_cell_members` 的表名」——流水线只允许调用 `VectorBackend`）
 *   ⇒ 表名**只出现在向量层内部**（本模块 + `ivf.ts`）⇒ 换后端实现时流水线不必重写。
 */

import type Database from 'better-sqlite3';

import { MemoryError } from '../core/errors.js';
import { DEFAULT_PARAMS } from '../core/params.js';
import { MIN_VECTOR_NORM } from './dot.js';

/** 粗桶中心（一个粗桶一条；`coarse_id` 是主键）。 */
export interface IvfCoarseCell {
  /** 粗桶 id（**确定性**生成 ⇒ 同一份数据两次训练得到同一套 id）。 */
  coarseId: string;
  /** 粗中心（Float32、**L2 归一化**）。 */
  centroid: Float32Array;
}

/** 细桶中心（**必属某个粗桶**——由外键 `vector_fine_cells.coarse_id` 保证）。 */
export interface IvfFineCell {
  /** 细桶 id（**确定性**生成）。 */
  fineId: string;
  /** 父粗桶 id。 */
  coarseId: string;
  /** 细中心（Float32、**L2 归一化**）。 */
  centroid: Float32Array;
}

/**
 * 两级中心模型（= 一份「分桶几何」的完整描述）。
 *
 * ⚠️ **中心必须是 L2 归一化的**：路由期用**点积**当相似度（归一化后余弦 = 点积）
 *   ⇒ 中心不归一化 ⇒ 路由的分与训练的分不是同一个度量 ⇒ 召回静默变差。
 */
export interface IvfCentroidModel {
  /** 粗中心（**按 `coarseId` 升序** ⇒ 遍历顺序确定）。 */
  coarse: readonly IvfCoarseCell[];
  /** 细中心（**按 `fineId` 升序**）。 */
  fine: readonly IvfFineCell[];
}

/**
 * 把向量编成可入库的 BLOB（**Float32 小端**）—— 与 `memories.embedding` **同构**。
 *
 * ⚠️ **显式按小端写**（`DataView.setFloat32(..., true)`）而不是 `Buffer.from(vec.buffer)`：
 *   后者写的是**平台字节序**，在大端平台上会写出一段「维度对、值全错」的向量
 *   ——而库里没有任何东西能发现它（余弦看起来仍是合法数字）。
 */
export function vectorToBlob(vector: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  vector.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return buffer;
}

/**
 * 把库里的向量 BLOB 读回 `Float32Array`（**小端**）。
 *
 * ⚠️ **必须显式逐个读**（而不是 `new Float32Array(buf.buffer, buf.byteOffset, n)`）：
 *   后者要求 `byteOffset` 是 4 的倍数，而 `Buffer` 的 `byteOffset` **不保证**对齐
 *   ⇒ 落在非对齐地址上会抛 `RangeError`（或在不同平台上读到错位的值）。
 */
export function blobToVector(blob: Buffer): Float32Array {
  const bytes = Buffer.from(blob);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 4);
  const vector = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  return vector;
}

/**
 * 把中心模型**落库**（`vector_coarse_cells` + `vector_fine_cells`）。
 *
 * ⚠️ **先删陈旧行、再写新行**：
 *   参数变了（粗/细中心数改了）⇒ 旧模型的桶 id 集合会与新模型不同
 *   ⇒ 陈旧的行若留着，**加载器会把它们一起读进来**（模型 ≠ 训练结果 ⇒ 路由命中空桶）。
 *
 * ⚠️ ★ **删除会级联到 `vector_cell_members`**（`ON DELETE CASCADE`）：
 *   删细桶 ⇒ 桶归属行被连带删除 ⇒ **向量路的候选集会被清空**。
 *   ⇒ 这正是 §4.15.5「重建 = 全量重分配」要处理的情形：
 *     **重训必须与「重分配归属」在同一个事务里**（归属的写入是 P2-T03 的
 *     `assignBucket` 的唯一职责 ⇒ 本模块**只管中心**，不碰归属）。
 *
 * ⚠️ ★ **事务按上下文自适应**（P2-T05 的前置）：
 *   ⚠️ **真实风险不是「事务不能嵌套」，而是「未被调用方事务包裹时会提前提交」**：
 *     better-sqlite3 的事务**可以嵌套**（内层走 SAVEPOINT，不报错；提交 / 回滚语义正常——
 *     外层回滚时内层的写入**一起回滚** ⇒ 事务对调用方是透明的），
 *     所以「不能嵌套」从来不是这里的问题。
 *     ⇒ 真正的失效形状是：**重训序列若没有被包在调用方的事务里** ⇒ 本函数会**自己提交**
 *       （中心已落库）⇒ 而旧归属已被 FK CASCADE 清空 ⇒ 重分配还没做
 *       ⇒ **向量路候选集为空，且不报错、不告警**（F8 的典型面孔）。
 *   ⇒ 所以：**已在事务里** ⇒ 直接执行（不开嵌套事务，语义与外层一致）；
 *     **不在事务里** ⇒ 自己开一个（保持对现有调用方的行为不变
 *     ⇒ **不包事务的调用方不会失去原子性**）。
 *   ⚠️ **不要**简单地把 `db.transaction(...)` 删掉 ⇒ 那会让不包事务的调用方
 *     失去原子性 ⇒ 那是另一种静默失效。
 *
 * @param db 库句柄
 * @param model 要落库的中心模型
 * @param now 更新时间戳（毫秒）
 */
export function saveCentroidModel(
  db: Database.Database,
  model: IvfCentroidModel,
  now: number,
): void {
  const write = (): void => {
    pruneStaleCentroidCells(db, model);
    upsertCentroidCells(db, model, now);
  };

  // ⚠️ **事务边界由「谁在事务里」决定，不由被调方猜**（同 `bucketAssign.ts` 的
  //   `assertInWriteTransaction` 是同一套纪律）。
  if (db.inTransaction) {
    write();
    return;
  }
  db.transaction(write)();
}

/**
 * 把中心模型**写进**桶表（**只写不删**）—— `vector_coarse_cells` + `vector_fine_cells`。
 *
 * ⚠️ ★ **必须用 `ON CONFLICT DO UPDATE`，不能用 `INSERT OR REPLACE`**：
 *   SQLite 的 `REPLACE` 冲突策略 = **DELETE + INSERT** ⇒ 而 `vector_cell_members`
 *   的外键指向 `vector_fine_cells(fine_id)`（`ON DELETE CASCADE`）
 *   ⇒ **`REPLACE` 会连带删掉桶归属行**（实测：1 行 ⇒ 0 行）
 *   ⇒ 而粗桶也一样（`vector_fine_cells.coarse_id` → `vector_coarse_cells` 级联）
 *   ⇒ **一次「重写同样的桶」就会静默清空全库桶归属**（F8 的另一副面孔）。
 *   ⇒ `ON CONFLICT DO UPDATE` 是**纯 UPDATE** ⇒ 不触发级联 ⇒ 归属行保住。
 *
 * ⚠️ **只写不删**：陈旧行的清理是**另一件事**（`pruneStaleCentroidCells`）
 *   ⇒ 因为「删陈旧行」会**级联删归属** ⇒ 重训序列必须**最后**才做那一步（§4.15.5 步骤 ③）。
 *
 * @param db 库句柄
 * @param model 要落库的中心模型
 * @param now 更新时间戳（毫秒）
 */
export function upsertCentroidCells(
  db: Database.Database,
  model: IvfCentroidModel,
  now: number,
): void {
  const insertCoarse = db.prepare(
    'INSERT INTO vector_coarse_cells (coarse_id, centroid, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(coarse_id) DO UPDATE SET centroid = excluded.centroid, updated_at = excluded.updated_at',
  );
  const insertFine = db.prepare(
    'INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(fine_id) DO UPDATE SET ' +
      'coarse_id = excluded.coarse_id, centroid = excluded.centroid, updated_at = excluded.updated_at',
  );
  for (const cell of model.coarse) {
    insertCoarse.run(cell.coarseId, vectorToBlob(cell.centroid), now);
  }
  for (const cell of model.fine) {
    insertFine.run(cell.fineId, cell.coarseId, vectorToBlob(cell.centroid), now);
  }
}

/**
 * 删掉**不在模型里**的陈旧桶行（`vector_coarse_cells` + `vector_fine_cells`）。
 *
 * ⚠️ ★ **这一步会级联删掉桶归属行**（`ON DELETE CASCADE`）：
 *   ⇒ 它**只能在**「归属已经全部迁到新桶之后」执行（§4.15.5 的步骤 ③）
 *   ⇒ 先删 ⇒ **全库桶归属被清空**（向量路整体消失、**不报错**）。
 *   ⇒ 粗桶先删还是细桶先删**都会**级联 ⇒ 但显式先删细桶 ⇒ 顺序不依赖级联行为。
 *
 * @param db 库句柄
 * @param model 当前生效的中心模型（**不在它里面的**桶行即为陈旧）
 */
export function pruneStaleCentroidCells(db: Database.Database, model: IvfCentroidModel): void {
  const keepCoarse = new Set(model.coarse.map((cell) => cell.coarseId));
  const keepFine = new Set(model.fine.map((cell) => cell.fineId));

  const staleCoarse = db.prepare('SELECT coarse_id FROM vector_coarse_cells').all() as Array<{
    coarse_id: string;
  }>;
  const staleFine = db.prepare('SELECT fine_id FROM vector_fine_cells').all() as Array<{
    fine_id: string;
  }>;

  const deleteCoarse = db.prepare('DELETE FROM vector_coarse_cells WHERE coarse_id = ?');
  const deleteFine = db.prepare('DELETE FROM vector_fine_cells WHERE fine_id = ?');

  // ⚠️ **先删细桶再删粗桶**：细桶的外键指向粗桶（删粗桶会级联删细桶，
  //   但显式先删细桶 ⇒ 顺序不依赖级联行为）。
  for (const row of staleFine) {
    if (!keepFine.has(row.fine_id)) {
      deleteFine.run(row.fine_id);
    }
  }
  for (const row of staleCoarse) {
    if (!keepCoarse.has(row.coarse_id)) {
      deleteCoarse.run(row.coarse_id);
    }
  }
}

/**
 * 从库里**加载**中心模型。
 *
 * ⚠️ **加载即校验**：维度不是 `EMBED_DIM` ⇒ 抛错（不静默丢弃那几行）
 *   ——「维度对不上却照跑」会让所有余弦变成合法但错误的数字。
 * ⚠️ **细桶的父粗桶必须存在** ⇒ 否则抛错（外键本来保证 ⇒ 出现即为库已损坏）。
 *
 * @param db 库句柄
 * @returns 中心模型（粗、细各自按 id 升序）
 */
export function loadCentroidModel(db: Database.Database): IvfCentroidModel {
  const coarseRows = db
    .prepare('SELECT coarse_id, centroid FROM vector_coarse_cells ORDER BY coarse_id')
    .all() as Array<{ coarse_id: string; centroid: Buffer }>;
  const fineRows = db
    .prepare('SELECT fine_id, coarse_id, centroid FROM vector_fine_cells ORDER BY fine_id')
    .all() as Array<{ fine_id: string; coarse_id: string; centroid: Buffer }>;

  const dimensions = DEFAULT_PARAMS.EMBED_DIM;
  const coarse: IvfCoarseCell[] = [];
  for (const row of coarseRows) {
    const centroid = blobToVector(row.centroid);
    assertCentroidDimensions(centroid, dimensions, row.coarse_id);
    coarse.push({ coarseId: row.coarse_id, centroid });
  }

  const coarseIds = new Set(coarse.map((cell) => cell.coarseId));
  const fine: IvfFineCell[] = [];
  for (const row of fineRows) {
    if (!coarseIds.has(row.coarse_id)) {
      // ⚠️ 外键本来保证「细桶必属粗桶」；走到这里 ⇒ 库已损坏 ⇒ **抛错，不静默丢弃**。
      throw new Error(
        `细桶 ${row.fine_id} 的父粗桶 ${row.coarse_id} 不存在：库已损坏（外键约束被绕过）`,
      );
    }
    const centroid = blobToVector(row.centroid);
    assertCentroidDimensions(centroid, dimensions, row.fine_id);
    fine.push({ fineId: row.fine_id, coarseId: row.coarse_id, centroid });
  }

  return { coarse, fine };
}

/**
 * 中心向量的**缓存**（§4.15.3：「桶中心常驻内存 30MB ⇒ 加载时一次性读入并缓存」）。
 *
 * ⚠️ **缓存不自动失效**：重训之后必须显式 `reload()`
 *   ⇒ 否则路由会继续用**旧中心**（而库里的中心已换）⇒ 探针命中错桶 ⇒ 召回静默变差。
 */
export class CentroidCache {
  /** 库句柄。 */
  private readonly db: Database.Database;

  /** 已加载的模型（`undefined` = 尚未加载）。 */
  private cached: IvfCentroidModel | undefined;

  /**
   * @param db 库句柄
   */
  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * 取中心模型（**首次调用时加载，之后走缓存**）。
   */
  model(): IvfCentroidModel {
    if (this.cached === undefined) {
      this.cached = loadCentroidModel(this.db);
    }
    return this.cached;
  }

  /** 强制下次 `model()` 重新加载（重训之后调用）。 */
  reload(): void {
    this.cached = undefined;
  }
}

/** 校验中心向量的维度（不合法 ⇒ 抛错，不静默丢弃）。 */
function assertCentroidDimensions(
  centroid: Float32Array,
  dimensions: number,
  cellId: string,
): void {
  if (centroid.length !== dimensions) {
    throw MemoryError.invalidInput(`桶中心 ${cellId} 的维度与 EMBED_DIM 不符`, {
      reason: 'dim',
      expected: dimensions,
      actual: centroid.length,
    });
  }
  const norm = Math.sqrt(centroid.reduce((sum, value) => sum + value * value, 0));
  if (!(norm > MIN_VECTOR_NORM)) {
    throw MemoryError.invalidInput(`桶中心 ${cellId} 的模长为 0（零向量没有方向）`, {
      reason: 'zero',
    });
  }
}
