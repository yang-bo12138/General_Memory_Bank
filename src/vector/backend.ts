/**
 * 向量检索后端的**接口契约** —— DESIGN-v2.md §4.15.2（**逐字搬入，不改一字**）。
 *
 * ⚠️ **本文件只放类型**（接口与类型别名），**不放任何实现逻辑**：
 *   · `src/vector/flat.ts` —— flat 全表精确扫描后端（**基线 / 参照实现**，P2-T01）
 *   · `src/vector/ivf.ts`  —— 两级 k-means 分桶后端（P2-T02）
 *   ⇒ 契约与实现**分家** ⇒ 换实现时**不必**动这个文件（ADR-16「替换点收敛在一处」）。
 *
 * ── 两条硬边界（本文件存在的全部理由）────────────────────────────────────
 *
 * ★ **边界 ①：`route` 与 `search` 必须是两个方法** ——
 *   合成一个方法 ⇒ 调用方无法在「路由结果」与「最终候选」之间插入自己的处理
 *   ⇒ §4.6 步骤 2c 的**时间窗过滤**与**强度精筛**就无处安放。
 *   ⇒ 契约一旦定下就不该再改：P2-T02~T06 全部建立在这四个接口之上。
 *
 * ★ **边界 ②：本模块只负责「取候选 + 排序」，不参与任何打分决策** ——
 *   实现**不得**返回归一化相似度之外的任何东西、
 *   **不得**决定哪些候选有资格（那是 §4.6 准入闸门的职责）、
 *   **不得**读写除向量索引与分桶元数据之外的数据。
 *   ⇒ 越界的实现会让「向量只参与排序不参与准入」这条铁律失效。
 *
 * ⚠️ **「应用调用方给定的闸门条件」≠「决定闸门条件」**（边界 ② 的精确读法）：
 *   §4.6 步骤 2c 原文：「`filter` 承载**准入闸门条件**（`deleted = 0` + 粗筛窗口），
 *   由 §4.6 步骤 2 统一构造后传入 —— 后端**不决定**谁有资格」。
 *   ⇒ 后端**应用** `filter` 里给定的边界值（时间窗下界、排除集），
 *     但**不推导**它们（不自己算窗口、不自己设阈值、不自己挑候选）。
 *   ⇒ `filter` 之所以**没有** `deleted` 字段（§4.15.2 的形状里就没有）：
 *     「候选宇宙里只含未删行」是**候选来源**的口径（由取行的一方保证），不是**过滤条件**。
 */

/** 后端配置。维度必须与 `EMBED_DIM` 一致；`EMBED_DIM` 本身**只读**（§6）。 */
export interface VectorBackendConfig {
  dimensions: number; // = EMBED_DIM
  coarseCenters: number; // 粗桶中心数（§4.15.3）
  fineCenters: number; // 细桶中心数
  storagePath?: string; // 派生索引的落盘位置（纯 TS + SQLite 实现可为空）
}

/** 检索过滤条件。★ **不接受 id 白名单**（§4.6 步骤 0 的硬边界）：
 *  一旦允许传 id 集合，将来一定会有人把它接到文本路上——
 *  那正是「几何邻近否决词法精确」那件事。 */
export interface VectorFilter {
  timeFloor?: number; // last_access 下界（毫秒）
  pinnedTimeFloor?: number; // pinned 记忆的 last_access 下界
  excludeIds?: string[]; // ★ **只用于「排除本次已入 topN 的记忆」**（§4.7 的扩散语义），
  //   **不是**「只在这批 id 里找」—— 方向相反，语义不可混用
}

/** 一条近邻命中。 */
export interface VectorHit {
  id: string;
  score: number; // 余弦（已 L2 归一化 ⇒ 点积）；**不由后端做归一化或重标定**
}

export interface VectorBackend {
  init(config: VectorBackendConfig): void; // 必须幂等

  /**
   * **只路由、不取候选**：算新向量落在哪些桶里。
   * @returns 命中的细桶 id 列表（有序，按中心距离升序）
   * ★ 这与 `search()` **必须是两个方法**——「路由」与「取候选」是两件事，
   *   合成一个方法会导致调用方无法在「路由结果」与「最终候选」之间插入自己的处理
   *   （§4.6 步骤 2c 的时间窗过滤与强度精筛就无处安放）。
   */
  route(query: Float32Array, nprobeCoarse: number, nprobeFine: number): string[];

  /**
   * 检索近邻。
   * @param query  已 L2 归一化的查询向量
   * @param k      返回条数
   * @param filter 候选过滤（时间窗下界、层等——**不是** id 白名单）
   * @returns      按相似度降序的候选（id + 余弦）。
   *               **不足 k 条时返回实际条数，不补齐**——
   *               补齐会引入不存在的相似度值，污染归一化。
   */
  search(query: Float32Array, k: number, filter?: VectorFilter): VectorHit[];

  upsert(id: string, vector: Float32Array): void; // upsert 语义：同 id 覆盖
  remove(id: string): void; // 硬删时调用；软删**不删**
  /**
   * 全量重建**索引侧**。
   *
   * ⚠️ **边界（P2-T02 裁决，ADR-P1-T07-DEC D-13 同型纪律）**：
   *   本方法只负责「**丢弃索引侧的增量状态**、让缓存失效」，
   *   **不负责「重训中心 + 重分配桶归属」**——
   *   那两件事会改写 `vector_coarse_cells` / `vector_fine_cells` / `vector_cell_members`
   *   ⇒ 属于**主库写路径** ⇒ 归 store 层的 `rebuildVectorBuckets()`（§4.15.5），
   *   且**必须与桶归属的重分配放在同一事务**（否则重训后 `vector_cell_members`
   *   被外键 `ON DELETE CASCADE` 连带清空 ⇒ **向量路候选集瞬间为空且不报错**）。
   */
  rebuild(): void;
  stats(): { count: number; dimensions: number; backend: string; indexBytes: number };
}
