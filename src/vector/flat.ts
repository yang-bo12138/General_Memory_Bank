/**
 * flat 全表精确扫描后端 —— P2-T01（DESIGN-v2.md §4.15.2 / DEVELOPMENT-PLAN.md P2-T01）。
 *
 * ⚠️ **本后端是「基线 / 参照实现」**：它的价值在于**没有近似、没有桶、没有第二套口径**——
 *   探针覆盖充分时，两级分桶后端的结果必须与它**逐位一致**（P2-T02 的硬断言之一）。
 *   ⇒ 因此它**不碰** `vector_coarse_cells` / `vector_fine_cells` / `vector_cell_members`
 *     三张分桶表里的任何一张（这正是它作为参照的价值所在）。
 *
 * ── 三个设计裁决（本次实现自行拍板的部分）─────────────────────────────────
 *
 * ★ **裁决 ①：候选来源由调用方注入（构造函数注入一个「取行」回调）**，
 *   而**不是**注入 `Database` 句柄、由本后端自己写 SQL。
 *   理由：
 *   · **向量层不含任何表名** ⇒ §4.6 步骤 2c 的硬边界（「流水线不得直接引用分桶表名」）
 *     在**结构上**就成立，而不是靠自觉；
 *   · 「候选宇宙」的口径（`deleted = 0`、`embedding IS NOT NULL`）由**取行的一方**统一保证，
 *     文本路 / 图谱路 / 向量路**三路共用同一口径**（口径只写一处 ⇒ 不会各路漂移）；
 *   · 本模块因此**不依赖 SQLite**，单元测试可以拿纯内存的行集驱动它，
 *     而「与手写全表点积逐位一致」这条断言也就能在**没有库**的情况下精确验证。
 *   ⚠️ 代价：真正接线时（store 层）需要有人提供这个回调 —— 那是**存储层**的活
 *     （`src/store/` 不在 P2-T01 的文件域内）。
 *
 * ★ **裁决 ②：`route()` 返回「全库」标记** —— 常量 `FLAT_ALL_BUCKETS = '__flat_all__'`。
 *   理由：契约要求 `route()` 返回 `string[]`（细桶 id 列表），
 *   而 flat **没有桶** ⇒ 用**唯一一个**哨兵 id 表示「全库都算命中」。
 *   ⚠️ 它必须是一个**不可能与真实桶 id 撞车**的串（桶 id 由本库生成 uuid）⇒ 用双下划线包起来。
 *   ⚠️ 它的语义是「**整库**」，不是「某一个桶」⇒ 调用方不得拿它去做分桶相关的推断。
 *
 * ★ **裁决 ③：`upsert` / `remove` 作用在「索引侧增量」上**（同 id 覆盖 / 硬删），
 *   而**候选宇宙**永远以注入的取行回调为准。
 *   理由：契约里 `upsert` / `remove` 是**索引侧**的抽象（§9.3.0：桶归属的实际写入
 *   由主库路径在同一事务里完成）⇒ 若 flat 把它们实现成「改候选宇宙」，
 *   就与「主库是唯一真相」这条纪律冲突。
 *   ⚠️ 因此：`upsert` 覆盖的是**该 id 的向量**；`remove` 标记该 id **不再参与检索**。
 *   ⚠️ 一个**尚未落库**的 id（取行回调里没有它）**不会**因 `upsert` 而出现在结果里 ——
 *     因为它**还不是一条记忆**（没有 `last_access` / `pin_factor`，无法过闸门）。
 *
 * ⚠️ **本模块同时是「两后端共享口径」的所在地**（P2-T02 起）：
 *   候选行的形状（`VectorCandidateRow`）、粗筛窗口的判定（`passesTimeWindow`）、
 *   命中项的排序（`compareHits`）**都只有这一份实现**，
 *   `src/vector/ivf.ts` 直接复用它们
 *   ⇒ flat 与 IVF 的候选口径**同源** ⇒ 「IVF 与 flat 逐位一致」才有意义。
 *
 * ── 契约边界的落法（§4.15.2）──────────────────────────────────────── * · **只取候选 + 排序，不参与打分决策**：本后端不设任何相似度阈值
 *   （`VECTOR_MIN_COS` 是 §4.6 准入闸门的事，不在这里）；
 * · **`filter` 只被「应用」，不被「推导」**：时间窗下界由 §4.6 步骤 2 统一构造后传入，
 *   本后端**照用**，不自己算窗口、不自己设阈值；
 * · **`excludeIds` 只用于排除本次已入 topN 的记忆**（扩散语义），
 *   **不是**「只在这批 id 里找」—— 方向相反，语义不可混用；
 * · **不足 k 条返回实际条数，不补齐**（补齐会引入不存在的相似度值，污染归一化）。
 */

import { MemoryError } from '../core/errors.js';
import { DEFAULT_PARAMS } from '../core/params.js';
import { clampCos } from '../core/scoring.js';
import type { VectorBackend, VectorBackendConfig, VectorFilter, VectorHit } from './backend.js';
import { assertValidEmbedding, dot } from './dot.js';

/** flat 后端在 `stats().backend` 里的名字。 */
export const FLAT_BACKEND_NAME = 'flat';

/**
 * 「全库」标记 —— flat 后端 `route()` 的**唯一**返回值。
 *
 * ⚠️ flat **没有桶**：契约要求 `route()` 返回细桶 id 列表，
 *   而 flat 的「命中集合」就是**整库** ⇒ 用唯一一个哨兵串表示。
 * ⚠️ 它**不可能**与真实桶 id 撞车（真实桶 id 由本库生成 uuid）。
 */
export const FLAT_ALL_BUCKETS = '__flat_all__';

/**
 * 候选来源的一行（**两后端共享的候选行形状**）。
 *
 * ⚠️ **本模块同时是「两后端共享口径」的所在地**（P2-T02 起）：
 *   · `VectorCandidateRow` —— 候选行的形状（flat 与 IVF **同构**）；
 *   · `passesTimeWindow()` —— 粗筛窗口的判定（**应用**调用方给的下界，不推导）；
 *   · `compareHits()` —— 命中项的排序（相似度降序；同分按 id 升序）。
 *   ⇒ 为什么放在**基线模块**里：flat 是**参照系** ⇒ 两后端的口径**必须同源**
 *     ⇒ 否则「IVF 与 flat 逐位一致」这条断言本身就没有意义
 *     （两套实现哪怕只差一个 `>=` 与 `>`，比对也会变成「实现之差」而不是「分桶之差」）。
 *   ⚠️ **只有这一份实现**（C36：同一件事不得有两套词/两份实现）。
 *
 * ⚠️ **口径由取行的一方保证**（本后端不推导、也不重算）：
 * · `vector` **非空** ⇒ 取行方已过滤掉 `embedding IS NULL` 的行
 *   （§4.6 步骤 2c 的参考 SQL 里那条 `AND m.embedding IS NOT NULL`
 *    是**必须**的：桶里可能有向量已被置 NULL 的行，对它算点积会得到 NaN，
 *    NaN 进排序会让**整条查询的排序失效**，而 SQLite 对 NaN 的比较是未定义行为）；
 * · 只含**未删**（`deleted = 0`）的行 —— `VectorFilter` 里**没有** `deleted` 字段
 *   （§4.15.2 的形状就是那样），所以「候选宇宙里只有活着的记忆」是**来源**的义务；
 * · `vector` 的维度必须等于 `config.dimensions`（否则是**接线错误**，本后端会抛错）。
 */
export interface VectorCandidateRow {
  /** 记忆 id。 */
  id: string;
  /** 该记忆的向量（**已 L2 归一化**，与 `memories.embedding` 的存储口径一致）。 */
  vector: Float32Array;
  /** `memories.last_access`（毫秒）—— 粗筛窗口的判据。 */
  lastAccess: number;
  /** `memories.pin_factor`（≥ 1；> 1 即被 pin）—— pinned 的宽松窗口的判据。 */
  pinFactor: number;
}

/**
 * 候选来源：返回**当前**的全部候选行。
 *
 * ⚠️ 每次 `search()` / `stats()` 都会**重新调用**它 ⇒ 取行方拿到的必须是**活数据**
 *   （`last_access` 会被 `touch()` 改 ⇒ 快照会让粗筛窗口按旧时间判）。
 */
export type FlatVectorRowSource = () => readonly VectorCandidateRow[];

/** flat 后端的构造选项。 */
export interface FlatVectorBackendOptions {
  /** 候选来源（见 `FlatVectorRowSource`）。 */
  rows: FlatVectorRowSource;
}

/**
 * flat 全表精确扫描后端（基线 / 参照实现）。
 *
 * ⚠️ **本类不缓存向量**：每次 `search()` 都重新扫一遍候选来源。
 *   理由：`last_access` 会被 `touch()` 改动 ⇒ 缓存会让粗筛窗口按旧时间判
 *   （而两级分桶后端是从 `memories` **实时**读 `last_access` 的 ⇒ 两者会漂移）。
 *   ⇒ 「索引」在本后端里 = **候选来源本身**；`upsert` / `remove` 只维护**索引侧增量**。
 */
export class FlatVectorBackend implements VectorBackend {
  /** 候选来源。 */
  private readonly source: FlatVectorRowSource;

  /** 索引侧增量：`upsert` 进来的向量（同 id 覆盖）。 */
  private readonly overlay = new Map<string, Float32Array>();

  /** 索引侧增量：被 `remove` 掉的 id（硬删；软删不走这里）。 */
  private readonly removed = new Set<string>();

  /** 生效配置（`init` 之后才有）。 */
  private config: VectorBackendConfig | undefined;

  /**
   * @param options 构造选项（候选来源）
   */
  constructor(options: FlatVectorBackendOptions) {
    this.source = options.rows;
  }

  /**
   * 初始化后端（**必须幂等**）。
   *
   * ⚠️ **幂等的确切含义**：
   * · 第一次调用：记录配置（`dimensions` 必须 == `EMBED_DIM`，§6：它只读）；
   * · 之后的调用：**什么都不做**（不重置索引侧增量、不重建任何东西）；
   * · 若之后的调用带了**不同的维度** ⇒ 抛 `INVALID_INPUT`
   *   （改维度等于全库旧向量作废，**不得**在运行期悄悄换掉）。
   *
   * @param config 后端配置
   * @throws {MemoryError} code = `INVALID_INPUT`（维度非法 / 已初始化后改维度）
   */
  init(config: VectorBackendConfig): void {
    assertBackendConfig(config);
    const current = this.config;
    if (current !== undefined) {
      if (current.dimensions !== config.dimensions) {
        throw MemoryError.invalidInput('后端已初始化：不得改维度（改维度等于全库旧向量作废）', {
          reason: 'dim',
          expected: current.dimensions,
          actual: config.dimensions,
        });
      }
      // ⚠️ **幂等 ⇒ 一个字节的状态都不改**（含 `overlay` / `removed`）。
      return;
    }
    this.config = { ...config };
  }

  /**
   * **只路由、不取候选**：flat 没有桶 ⇒ 返回「全库」标记。
   *
   * ⚠️ 两个探针数**被忽略**（flat 无桶可探）——这是**设计内行为**，不是静默失效：
   *   探针数只对两级分桶后端有意义。
   *
   * @param query 查询向量（已 L2 归一化）
   * @param _nprobeCoarse 粗层探针数（**忽略**：flat 无桶）
   * @param _nprobeFine 细层探针数（**忽略**：flat 无桶）
   * @returns `['__flat_all__']`
   */
  route(query: Float32Array, _nprobeCoarse: number, _nprobeFine: number): string[] {
    const config = this.assertInitialized();
    assertValidEmbedding(query, config.dimensions);
    return [FLAT_ALL_BUCKETS];
  }

  /**
   * 检索近邻：全表精确点积。
   *
   * ⚠️ **score 是原始余弦**（向量已 L2 归一化 ⇒ 余弦 = 点积），
   *   只做**一次**区间钳制 `min(1, max(0, dot))`（复用 `core/scoring.ts` 的 `clampCos`），
   *   **不做**任何再归一化 / 重标定（z-score、min-max、按本次最高分归一化一律不做）。
   * ⚠️ **排序**：按相似度**降序**；**同分时按 id 升序**（保证结果**可复现**——
   *   浮点同分是常态，不定死次序 ⇒ 同一批数据两次检索给出不同顺序 ⇒ 「逐位一致」无从谈起）。
   * ⚠️ **不足 k 条返回实际条数，不补齐**。
   *
   * @param query 查询向量（已 L2 归一化）
   * @param k 返回条数
   * @param filter 候选过滤（时间窗下界 / 排除集——**不是** id 白名单）
   * @returns 按相似度降序的候选
   */
  search(query: Float32Array, k: number, filter?: VectorFilter): VectorHit[] {
    const config = this.assertInitialized();
    assertValidEmbedding(query, config.dimensions);
    if (!Number.isInteger(k) || k < 0) {
      throw MemoryError.invalidInput('k 必须是非负整数', {
        reason: 'k',
        expected: '>= 0 的整数',
        actual: String(k),
      });
    }
    if (k === 0) {
      return [];
    }

    const effectiveFilter: VectorFilter = filter ?? {};
    const excluded = new Set(effectiveFilter.excludeIds ?? []);
    const hits: VectorHit[] = [];

    for (const row of this.source()) {
      if (excluded.has(row.id)) {
        continue;
      }
      if (this.removed.has(row.id)) {
        continue;
      }
      const vector = this.overlay.get(row.id) ?? row.vector;
      if (vector.length !== config.dimensions) {
        // ⚠️ **接线错误**（换了 embedding 模型 / 维度对不上）⇒ 立刻炸，不静默跳过。
        throw MemoryError.invalidInput('候选行的向量维度与后端配置不符', {
          reason: 'dim',
          expected: config.dimensions,
          actual: vector.length,
        });
      }
      if (!passesTimeWindow(row, effectiveFilter)) {
        continue;
      }
      hits.push({ id: row.id, score: clampCos(dot(query, vector)) });
    }

    hits.sort(compareHits);
    return hits.slice(0, k);
  }

  /**
   * 写入索引侧的向量（**同 id 覆盖**）。
   *
   * ⚠️ **不落库**（§9.3.0：真正的写入由主库路径在同一事务里完成，
   *   后端接口的 `upsert` 是**索引侧**的抽象）。
   * ⚠️ 写入前**必须**过一遍写入口径的校验（维度 / NaN / Inf / 模长），
   *   不满足就抛错（不截断、不补零、不静默降级）。
   *
   * @param id 记忆 id
   * @param vector 向量（已 L2 归一化）
   */
  upsert(id: string, vector: Float32Array): void {
    const config = this.assertInitialized();
    assertValidEmbedding(vector, config.dimensions);
    // ⚠️ **存一份拷贝**：调用方持有的 `Float32Array` 之后可能被改
    //   （索引不该被外部的赋值悄悄改掉）。
    this.overlay.set(id, new Float32Array(vector));
    // ⚠️ 同 id 覆盖 ⇒ 先前的「已删除」标记必须清掉（否则这条永远召不回）。
    this.removed.delete(id);
  }

  /**
   * 移除一条 id（**硬删**时调用；软删**不删**）。
   *
   * ⚠️ 软删（`deleted = 1`）的行由**候选来源**过滤掉，不走这里——
   *   走这里等于告诉索引「这条 id 彻底没了」，与软删的语义不同。
   *
   * @param id 记忆 id
   */
  remove(id: string): void {
    this.assertInitialized();
    this.overlay.delete(id);
    this.removed.add(id);
  }

  /**
   * 全量重建。
   *
   * ⚠️ flat 的「索引」= 候选来源 ⇒ 重建 = **丢弃索引侧增量**，
   *   回到「完全以候选来源为准」的纯扫描状态。
   *   （两级分桶后端的 `rebuild()` 是重训中心 + 重分桶，那是 P2-T02 的事。）
   */
  rebuild(): void {
    this.assertInitialized();
    this.overlay.clear();
    this.removed.clear();
  }

  /**
   * 后端状态。
   *
   * ⚠️ `count` = **会被扫描的向量条数**（= 候选来源里未删且有向量的行数）；
   *   `indexBytes` = 这些向量占用的字节数（`维度 × 4`，Float32 小端）。
   *   ⚠️ 这两个数**实时**取自候选来源 ⇒ 与「此刻库里的样子」一致。
   */
  stats(): { count: number; dimensions: number; backend: string; indexBytes: number } {
    const config = this.assertInitialized();
    let count = 0;
    for (const row of this.source()) {
      if (this.removed.has(row.id)) {
        continue;
      }
      count += 1;
    }
    return {
      count,
      dimensions: config.dimensions,
      backend: FLAT_BACKEND_NAME,
      indexBytes: count * config.dimensions * 4,
    };
  }

  /**
   * 取生效配置；未 `init` ⇒ 抛错。
   *
   * ⚠️ **必须先 `init`**：维度未知 ⇒ 无法校验向量维度
   *   （而维度错误是**静默失效**的一类：算出来的余弦全是合法数字）。
   */
  private assertInitialized(): VectorBackendConfig {
    const config = this.config;
    if (config === undefined) {
      throw MemoryError.invalidInput('后端尚未初始化：先调用 init(config)', {
        reason: 'not-initialized',
      });
    }
    return config;
  }
}

/**
 * 候选行是否通过**粗筛窗口**。
 *
 * ⚠️ 口径与 §4.6 步骤 2 的粗筛窗口**逐字一致**（`src/store/recall.ts` 的 `COARSE_WINDOW_SQL`）：
 * ```
 * (last_access >= @coarseCutoff OR (pin_factor > 1.0 AND last_access >= @coarseCutoffPinned))
 * ```
 * ⚠️ **本函数只「应用」调用方给定的下界，不「推导」它**：
 *   窗口由 §4.6 步骤 2 统一构造后传入（§4.15.2 契约：后端不决定谁有资格）。
 * ⚠️ `timeFloor` 缺省 ⇒ **不施加时间窗**（全量候选都算数）。
 */
export function passesTimeWindow(row: VectorCandidateRow, filter: VectorFilter): boolean {
  const timeFloor = filter.timeFloor;
  if (timeFloor === undefined) {
    return true;
  }
  if (row.lastAccess >= timeFloor) {
    return true;
  }
  const pinnedTimeFloor = filter.pinnedTimeFloor;
  if (row.pinFactor > 1.0 && pinnedTimeFloor !== undefined && row.lastAccess >= pinnedTimeFloor) {
    return true;
  }
  return false;
}

/**
 * 命中项的排序：**相似度降序**；同分时 **id 升序**。
 *
 * ⚠️ **同分必须定死次序**：浮点同分是常态（尤其是被钳制到 0 的负余弦），
 *   不定次 ⇒ 同一批数据两次检索给出不同顺序 ⇒ 「逐位一致」这条断言无从谈起。
 */
export function compareHits(left: VectorHit, right: VectorHit): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

/**
 * 校验后端配置。
 *
 * ⚠️ **维度必须 == `EMBED_DIM`**（§6：它是**只读**参数，只在构造时生效）。
 * ⚠️ 两个中心数对 flat 无意义，但**必须 ≥ 1**（配错成 0 是接线错误，
 *   而 flat 照跑不误 ⇒ 只有在这里拦一次）。
 */
function assertBackendConfig(config: VectorBackendConfig): void {
  if (config.dimensions !== DEFAULT_PARAMS.EMBED_DIM) {
    throw MemoryError.invalidInput(
      `后端的维度必须是 ${DEFAULT_PARAMS.EMBED_DIM}（EMBED_DIM 是只读参数）`,
      { reason: 'dim', expected: DEFAULT_PARAMS.EMBED_DIM, actual: config.dimensions },
    );
  }
  if (config.coarseCenters < 1 || config.fineCenters < 1) {
    throw MemoryError.invalidInput('粗/细中心数必须 >= 1', {
      reason: 'centers',
      expected: '>= 1',
      actual: `${config.coarseCenters}/${config.fineCenters}`,
    });
  }
}
