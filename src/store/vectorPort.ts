/**
 * 召回路径的**向量端口装配点** —— 阶段 5 · P2-T09
 * （`docs/design/p5-vector-path-design.md` §3 的接口签名 + §2 的 D1 / D2 / RK-1 / RK-9）。
 *
 * ★ **本模块是「四态模式 → 后端对象」的唯一装配点**（C36：同一件事不得有两份实现）：
 *   `stats()` 用 `resolveVectorBackendMode()` 报**状态**，召回用同一个函数**选后端**
 *   ⇒ 「面板说 `ivf`、召回却走了 flat」这类漂移在结构上不可能出现。
 *
 * ★★ **D1 裁决：每次调用都新造一个后端对象（不缓存 port）**。
 *   为什么不是「每个实例缓存一个」——探针数来自 `store.params`，而 `setParams()` 是**就地更新**
 *   同一个 params 容器的（`src/store/setParams.ts` 的 `applyInPlace`）⇒ 缓存 port 就等于
 *   缓存了**构造时**的探针数；一旦 `setParams({ ROUTER_NPROBE_FINE })` 之后
 *   **路由用新值、`search()` 内部用旧值**（`IvfVectorBackend.search()` 用的是 `this.nprobeFine`）
 *   ⇒ 桶集分叉 ⇒ **召回悄悄少一批候选，不报错**（RK-1）。
 *   每次现场装配 ⇒ 探针数与模式**必然**是本次调用读到的 params ⇒ **没有失效点可忘**。
 *   ⚠️ 代价（诚实记）：每次带向量的召回新建一个后端对象（纯分配、无 I/O、无表读）。
 *   ⚠️ 另一条**想要**的副作用：`overlay`（`upsert` 增量）随之丢弃 —— 召回只该看见
 *     **已提交的库状态**，不带未提交的索引侧增量。
 *
 * ⚠️ **本模块不 new 任何缓存**：中心模型仍由 `MemoryStore` 唯一的 `CentroidCache` 提供
 *   （30MB 常驻，`reload()` 是它唯一的失效点）⇒ 本设计**不新增失效点**（RK-5）。
 *   ⚠️ 若在这里自己 `loadCentroidModel()` ⇒ 每次召回重读 200 + 10,000 行 × 3KB ≈ 30MB
 *     ⇒ 单这一项就把 P99 预算烧光，**且绕过了 `reload()`**（重训后到底用新中心还是旧中心没人说得清）。
 *
 * ⚠️ **本模块不含任何分桶表名**（表名只在 `src/vector/{centroids,ivf}.ts` 里）：
 *   守住 ADR-16 的「替换点收敛在一处」——换后端实现不必改这里，也不必改流水线
 *   （`tests/unit/recall.test.ts:1281` 的静态断言守的是流水线那一侧）。
 */

import type Database from 'better-sqlite3';

import type { Params } from '../core/params.js';
import type { VectorBackend, VectorBackendConfig } from '../vector/backend.js';
import { type IvfCentroidModel, blobToVector } from '../vector/centroids.js';
import {
  FlatVectorBackend,
  type FlatVectorRowSource,
  type VectorCandidateRow,
} from '../vector/flat.js';
import { IvfVectorBackend } from '../vector/ivf.js';
import { type VectorBackendMode, resolveVectorBackendMode } from './stats.js';

/**
 * 召回路径拿到的向量端口：「一个后端 + 它的四态模式」。
 *
 * ⚠️ **`mode` 里没有 `'absent'`**：缺席**不是**一种端口（缺席就是 `null`）
 *   ⇒ 「拿到 port 但它是缺席的」这种自相矛盾的状态在类型上就不存在（D5 的 B 行）。
 */
export interface RecallVectorPort {
  /** 后端实例（**每次装配都是新的**，见文件头 D1）。 */
  readonly backend: VectorBackend;
  /** 本次实际走的模式（`absent` 已被排除）——`explain` 之外的第二份词只有 `stats()` 用，见 Q6。 */
  readonly mode: Exclude<VectorBackendMode, 'absent'>;
}

/**
 * 装配端口需要的外部依赖（**都由 `MemoryStore` 提供**；本模块不持有任何缓存）。
 */
export interface VectorPortDeps {
  /** 中心模型提供者（= `() => this.#centroids.model()`）。 */
  readonly centroids: () => IvfCentroidModel;
  /** 「本实例已确认过建桶门槛」的记忆（**只有一个方向**，见下）。 */
  readonly embeddedAtLeastThreshold: () => boolean;
  /** 本次判定为「已过门槛」时回报，供 `MemoryStore` 置位。 */
  readonly markEmbeddedAtLeastThreshold: () => void;
}

/**
 * 解析召回用的向量端口。
 *
 * @param db 库句柄（只用于四态判定；**不在这里读中心模型**）
 * @param params 本次调用的生效参数（探针数 / 中心数 / `VECTOR_ROUTER` 都取自它）
 * @param deps 外部依赖（中心模型提供者 + 门槛 sticky 位）
 * @returns 端口；`null` = 本次向量路**整路缺席**（`mode === 'absent'`，D5 的 B 行）
 */
export function resolveRecallVectorPort(
  db: Database.Database,
  params: Params,
  deps: VectorPortDeps,
): RecallVectorPort | null {
  const mode = resolveVectorBackendMode(db, params, {
    embeddedAtLeastThreshold: deps.embeddedAtLeastThreshold(),
  });

  // ⚠️ **`absent` ⇒ 整路缺席**（不是降级成 flat、也不是「跑了但没命中」）：
  //   过了建桶门槛但细桶还没有 ⇒ 走 ivf 会是「桶表为空 ⇒ 候选恒空」，
  //   静默回落 flat 又会改写调用方显式指定的 `'ivf'`（`src/core/flags.ts` 的第三分支裁决）。
  //   ⇒ 召回侧的正确动作是**什么都不做**（D5 的 B 行：`ran=false`）。
  //   ⚠️ 不记 warn（Q3 的默认假设）：召回路每次记一条 = 写放大，而
  //     `routes.vector.ran === false` + `stats().vectorBackend.mode === 'absent'` 已足够可观测。
  if (mode === 'absent') {
    return null;
  }

  const config = backendConfigOf(params);

  if (mode === 'ivf') {
    // ⚠️ **只有这一支能确认「已过门槛」**：`flat_explicit` 提前返回、没数过 count ⇒ 无从得知；
    //   `flat_auto` 明确是**没过**门槛。反之记住「没过」是**禁止**的（见 `resolveVectorBackendMode`）：
    //   那样一个长大后的库会**永远**留在 flat ⇒ 每次召回全表点积 ⇒ 延迟门槛被静默击穿。
    deps.markEmbeddedAtLeastThreshold();
    const backend = new IvfVectorBackend({
      db,
      // ⚠️ **传闭包而不是模型**：`IvfVectorBackend` 每次路由都会取一次 ⇒
      //   重训后的 `reload()` 对新生效的后端**立刻**可见（本设计不新增缓存）。
      centroids: deps.centroids,
      nprobeCoarse: params.ROUTER_NPROBE_COARSE,
      nprobeFine: params.ROUTER_NPROBE_FINE,
    });
    backend.init(config);
    return { backend, mode };
  }

  // ── `flat_explicit` / `flat_auto`：两种都算「能跑」（D5 / D7）──
  //   ⚠️ **小库走 flat 是设计内行为，不是故障**（§5：`ROUTER_MIN_TRAINING` 之下「向量路走 flat」）
  //     ⇒ 它同样产出 `fromVector` / `cos` / `vectorPart`，只是慢（全表精确点积）。
  const backend = new FlatVectorBackend({ rows: createFlatRowSource(db) });
  backend.init(config);
  return { backend, mode };
}

/**
 * 后端的构造配置（两个后端**同一套**口径）。
 *
 * ⚠️ **`dimensions` 取 `params.EMBED_DIM`**（调用方在 `MemoryConfig` 里能覆盖它）
 *   ⇒ 正常情况下它就是默认的 768。
 *   ⚠️ 已知的既有约束（**本任务不改它**）：`src/vector/flat.ts` 的 `assertBackendConfig()`
 *     把维度与 `DEFAULT_PARAMS.EMBED_DIM` 硬比较 ⇒ 覆盖了 `EMBED_DIM` 的宿主走到这里会抛
 *     `INVALID_INPUT`（**响亮地失败**，不是静默算错）——那是向量层既有的硬编码，
 *     与本次接线无关；此处如实传 `params.EMBED_DIM`，不替它掩盖。
 */
function backendConfigOf(params: Params): VectorBackendConfig {
  return {
    dimensions: params.EMBED_DIM,
    coarseCenters: params.ROUTER_COARSE_CENTERS,
    fineCenters: params.ROUTER_FINE_CENTERS,
  };
}

/**
 * flat 后端的候选来源（**活数据**，每次 `search()` / `stats()` 都重读）。
 *
 * ★ **口径写死在这里，而且只在这里**（F9 / §4.15.2）：`deleted = 0` 且 `embedding IS NOT NULL`。
 *   `VectorFilter` 里**没有** `deleted` 字段 ⇒「候选宇宙只含活行」是**取行方**的义务。
 *   ⚠️ 桶里可能留着「向量已被置 NULL」的行，对它算点积会得到 `NaN`，
 *     而 `NaN` 进排序会让**整条查询的排序失效**（不报错）⇒ 这个 `IS NOT NULL` 是承重的。
 *
 * ⚠️ **为什么是闭包而不是快照**：`last_access` 会被 `touch()` 改
 *   ⇒ 快照会让粗筛窗口按**旧时间**判（而 ivf 后端是从 `memories` 实时读的 ⇒ 两者会漂移）。
 *
 * ⚠️ **不 SELECT `content` / `content_tokens`**：flat 只需要「向量 + 时间窗判据」
 *   ⇒ 把 100 万行的正文拖出来是纯搬运（与 `recall.ts` 的既有纪律同源）。
 *   ⚠️ 但**必须** SELECT `embedding`（不 SELECT 就没法算点积）—— 这是 flat 的固有成本：
 *     全表精确扫描，`N × 3KB` 的 BLOB 读（设计内行为，仅 `N < ROUTER_MIN_TRAINING` 时启用）。
 *
 * @param db 库句柄
 * @returns 候选来源（每次调用**重新查库**）
 */
export function createFlatRowSource(db: Database.Database): FlatVectorRowSource {
  return (): readonly VectorCandidateRow[] => {
    const rows = db
      .prepare(
        `SELECT id, embedding, last_access, pin_factor
           FROM memories
          WHERE deleted = 0 AND embedding IS NOT NULL`,
      )
      .all() as Array<{
      id: string;
      embedding: Buffer;
      last_access: number;
      pin_factor: number;
    }>;
    // ⚠️ **逐行解码**（`blobToVector` 每次新建 `Float32Array`，不与源 Buffer 别名）。
    //   ⚠️ 顺序不排序：flat 的 `search()` 会按（cos 降序, id 升序）重排 ⇒ 源顺序不可观测。
    return rows.map((row) => ({
      id: row.id,
      vector: blobToVector(row.embedding),
      lastAccess: row.last_access,
      pinFactor: row.pin_factor,
    }));
  };
}
