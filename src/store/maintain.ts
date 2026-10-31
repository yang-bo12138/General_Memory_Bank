/**
 * 维护类操作 —— P2-T05（`rebuildVectorBuckets`；DESIGN-v2.md §4.15.5 / §6 / §9.3.2 ④）。
 *
 * ⚠️ **本文件是 §6 公开方法 `rebuildVectorBuckets` 的落点**（DEVELOPMENT-PLAN.md §3.1
 *   的方法归位表：阶段 2 新增的**唯一**公开方法就是它）。
 *
 * ⚠️ **重训的三步序列在 `src/vector/rebuild.ts`**（向量层）：
 *   本文件只做**存储层该做的事**——取参数、记事件、管 `inRetrain`、失效中心缓存。
 *   ⇒ 桶表名**不出现**在本文件里（§4.6 步骤 2c：流水线不得引用桶表名）。
 *
 * ⚠️ ★ **并发口径**（§4.15.5 的 v2.1 裁决，与 ADR-5 一致）：
 *   · **库内没有定时器、没有后台线程** ⇒ 重训由**调用方显式调用**本文件暴露的方法触发；
 *   · 库是**全同步 API** ⇒ 同一线程调用会**阻塞 1~3 分钟**（同步模型的必然结果，不是缺陷）；
 *   · 要不阻塞请求 ⇒ 调用方须在**自己的另一个线程**里调用、并使用**独立的数据库连接**
 *     ⇒ 此时 **WAL 保证「读不阻塞写」** ⇒ `recall` / `stats` 照常工作
 *     ⇒ ⚠️ **写仍然互斥**（重训期间其它**写**调用会等锁，`busy_timeout`）。
 *
 * ⚠️ ★ **`inRetrain` 的可观测性有前提**（§4.15.5）：
 *   它是**进程内的实例字段** ⇒ 只有当重训与查询发生在**同一个实例**时，
 *   查询侧才可能观察到 `inRetrain = true`。
 *   ⇒ **推论：面板不得把「`inRetrain=false`」解读成「没在重训」**——
 *     它只说明「**本实例看不到**重训」；**库级真相看 `vector_fine_cells.updated_at`**。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import type { Params } from '../core/params.js';
import { LOG_ACTIONS, type Logger } from '../util/log.js';
import type { BucketAssignContext } from '../vector/bucketAssign.js';
import { type BucketRebuildHooks, rebuildBuckets } from '../vector/rebuild.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

/**
 * 维护操作的上下文（`rebuildVectorBuckets` 需要的东西）。
 *
 * ⚠️ **用上下文对象而不是裸参数**（同 §4.2 `growStability(store, …)` 的先例）：
 *   这里需要六样东西——库句柄 / 参数 / 事件写入器 / 日志器 / 桶上下文 / 缓存失效钩子
 *   ⇒ 打包成一个对象传 ⇒ **将来加第七样不必改所有调用点的参数表**。
 */
export interface MaintainContext {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（训练用的粗 / 细中心数与探针数）。 */
  params: Params;
  /** 事件写入器（重训要记一条 `sweep` 事件，§8.4）。 */
  events: EventWriter;
  /** 日志器（「只重训一次」那条告警要落日志）。 */
  logger: Logger;
  /**
   * 桶归属上下文（写路径与重训**共用同一套探针数与中心提供者**）。
   *
   * ⚠️ **必须与写路径同一份**：训练期与运行期用同一套规则
   *   ⇒ 训练算出的归属与写入算出的归属一致 ⇒ 不会产生无谓的桶 churn（§4.15.3）。
   */
  buckets: BucketAssignContext;
  /**
   * 让中心缓存失效（重训**之后**必须调用）。
   *
   * ⚠️ **不调用 ⇒ 路由继续用旧中心**（而库里的中心已换）
   *   ⇒ 探针命中错桶 ⇒ **召回静默变差**（§4.15.5）。
   */
  reloadCentroids: () => void;
  /**
   * 内部钩子（**仅供测试与观测**；公开 API 不暴露）。
   *
   * ⚠️ **为什么维护层也要有**：§4.15.5 的验收标准里有两条**只能在过程里观察**的断言
   *   （「重训期间 `inRetrain == true`」与「单条记忆的 DELETE + INSERT 同事务」）
   *   ⇒ 而重训是**同步阻塞**的 ⇒ 同一线程里没法在过程中间取样
   *   ⇒ 必须有一个**过程内的取样点** ⇒ 钩子就是那个取样点。
   *   ⚠️ **钩子抛错 ⇒ 整段重训抛错** ⇒ 这也是「崩溃恢复」那条断言的模拟手段。
   */
  hooks?: BucketRebuildHooks;
}

/** `rebuildVectorBuckets()` 的返回值（§6 的签名逐字一致）。 */
export interface RebuildBucketsResult {
  /**
   * 新一代的**细桶**数（持有成员的桶）。
   *
   * ⚠️ **口径**：§6 只说 `cells: number`，没说是粗桶还是细桶
   *   ⇒ 本实现取**细桶**数（粗桶是细桶的父级、不直接持有成员）
   *   ⇒ 与 `stats().vectorBackend.fineCells` 同口径。
   */
  cells: number;
  /** 重分配后的**桶归属条数**（`members`）。 */
  members: number;
}

/** `rebuildVectorBuckets()` 的入参（§6 的签名逐字一致）。 */
export interface RebuildBucketsOptions {
  /**
   * 触发原因（只进**日志**）。
   *
   * ⚠️ **不进事件 payload**：§8.4 硬规则 4 写死 `action='rebuildBuckets'` 的字段集是
   *   `cells, members` 两个 ⇒ 多塞一个键就是**违反 §8.4 的 payload 键集断言**
   *   （`scripts/check-payload-keys.ts` 会红）。
   */
  reason?: string;
}

/** 「只重训一次」闸门的结果。 */
export interface RebuildOnceOutcome extends RebuildBucketsResult {
  /** 本次**是否真的重训了**。 */
  rebuilt: boolean;
  /**
   * 重训后**是否仍不达标**。
   *
   * ⚠️ `true` ⇒ **向量路质量降级**（**不是启动失败**）⇒ 调用方**放行**即可（§4.15.5）。
   */
  degraded: boolean;
}

/**
 * 维护器 —— 阶段 2 的维护操作（当前只有 `rebuildVectorBuckets`）。
 *
 * ⚠️ **为什么是类而不是裸函数**：`inRetrain` 与「自动重训次数」都是
 *   **进程内的实例状态**（§4.15.5 明确指出 `inRetrain` 重启即失）
 *   ⇒ 必须挂在**实例**上 ⇒ 挂在模块级变量上会让**两个库实例互相干扰**
 *   （一个库在重训，另一个库的 `inRetrain` 也变成 true ⇒ 面板说谎）。
 */
export class MemoryMaintainer {
  /** 上下文。 */
  readonly #context: MaintainContext;

  /** 重训进行中？（**进程内的实例字段** ⇒ §4.15.5 的可观测性有前提）。 */
  #inRetrain = false;

  /** **自动**重训的次数（只由 `rebuildVectorBucketsOnce()` 递增）。 */
  #autoRebuildCount = 0;

  /**
   * @param context 维护上下文
   */
  constructor(context: MaintainContext) {
    this.#context = context;
  }

  /**
   * **重训进行中？**（§6 的 `stats().vectorBackend.inRetrain` 的数据源）
   *
   * ⚠️ ★ **作用域**：仅在 `mode === 'absent'` 时有意义（§6）；
   *   `mode === 'flat_auto'` 时恒为 `false`（flat 不建桶 ⇒ 没有重训这件事）。
   * ⚠️ ★ **它只说明「本实例看不到重训」**（§4.15.5）：
   *   重训跑在**另一个进程 / 另一个实例**里时，本实例的 `inRetrain` **恒为 false**
   *   —— 这不是 bug，是**跨实例不可观测**的必然结果。
   */
  get inRetrain(): boolean {
    return this.#inRetrain;
  }

  /**
   * 重训两级分桶 + 全量重分配 —— §6 的 `rebuildVectorBuckets()`（§4.15.5 的三步序列）。
   *
   * ⚠️ **阻塞 1~3 分钟**（§4.15.5）：这是同步 API 的必然结果，**不是缺陷**；
   *   要不阻塞请求 ⇒ 调用方须在**自己的另一个线程**里调用、并用**独立的数据库连接**。
   *
   * ⚠️ **幂等**（§4.15.5）：连做两次 ⇒ 结果**逐条相同**
   *   （桶 id 是索引派生的 + 归属按当前全部向量重算）。
   *
   * ⚠️ **崩溃可恢复**：步骤 ② 分批提交 ⇒ 崩在「提交了一部分」时，库里是「部分迁移」的
   *   中间态（每条记忆仍有且仅有一个归属 ⇒ 库仍可用）⇒ **重做一次**即可回到完整状态。
   *
   * @param options 触发原因（只进日志）
   * @returns 桶数与归属条数
   */
  rebuildVectorBuckets(options?: RebuildBucketsOptions): RebuildBucketsResult {
    const context = this.#context;
    const reason = options?.reason ?? 'explicit';

    // ⚠️ **`inRetrain` 必须在整段重训期间为 true** ⇒ 用 `try/finally` 保证
    //   **异常路径也会复位**（漏复位 ⇒ 面板永远说「正在重训」⇒ 状态永久失真）。
    this.#inRetrain = true;
    try {
      const result = rebuildBuckets(
        context.db,
        // ⚠️ **事务语义只有一份实现**（`src/store/transaction.ts` 的 `runWriteTransaction`）
        //   ⇒ 向量层不自己包事务（依赖方向单向：store → vector）。
        <T>(body: () => T): T => runWriteTransaction(context.db, body),
        {
          coarseCenters: context.params.ROUTER_COARSE_CENTERS,
          fineCenters: context.params.ROUTER_FINE_CENTERS,
          nprobeCoarse: context.params.ROUTER_NPROBE_COARSE,
          // ⚠️ **`updated_at` 用真实时钟**（§11.1 豁免，同 `setParams` 的 `events.at`）：
          //   它**只用于观测**（库级真相看 `vector_fine_cells.updated_at`）、**不参与任何计算**。
          now: resolveNow(),
          // ⚠️ **条件展开**（`exactOptionalPropertyTypes`）：显式写 `hooks: undefined`
          //   与「不传」是**两件事** ⇒ 钩子不存在时**根本不带上这个键**。
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        },
      );

      // ⚠️ **重训之后必须让中心缓存失效**（§4.15.5）：
      //   否则路由继续用**旧中心**（而库里的中心已换）⇒ 探针命中错桶 ⇒ 召回静默变差。
      context.reloadCentroids();

      // ⚠️ **事件在重训完成之后单独记**（§8.4）：
      //   `type='sweep'`、`action='rebuildBuckets'`、payload 只有 `cells` 与 `members`
      //   ⇒ **不写** `purged` / `vacuumed` / `coactPairsActive`（那些字段本次**没发生**，
      //     填 0 就是在**伪造事实** ⇒ 消费方按 `type='sweep'` 推断「数据被销毁」时会被误导）。
      //   ⚠️ `memory_id` 一律填 `null`（§8.4：这些动作不针对单条记忆）。
      runWriteTransaction(context.db, () => {
        context.events.appendEvent('sweep', null, {
          action: 'rebuildBuckets',
          cells: result.cells,
          members: result.members,
        });
      });

      context.logger.info(LOG_ACTIONS.sweep, {
        reason,
        cells: result.cells,
        members: result.members,
        migrated: result.migrated,
      });

      return { cells: result.cells, members: result.members };
    } finally {
      this.#inRetrain = false;
    }
  }

  /**
   * 启动期的「**只重训一次**」闸门（§4.15.5）。
   *
   * ⚠️ **为什么要有这道闸门**：若重训一次后 P95 仍超 `ROUTER_BUCKET_MAX`，
   *   **不得在启动阶段反复重训**（会把启动拖成分钟级）
   *   ⇒ **只重训一次，仍不达标则记告警并放行**（向量路质量降级，**不是启动失败**）。
   *
   * ⚠️ **质量判据由调用方注入**（`isDegraded`）：
   *   P95 的计算归 **P2-T06** 的 `src/vector/bucketQuality.ts`
   *   ⇒ 本模块**不自己算第二份**（C36：同一件事不得有两套实现）
   *   ⇒ 判据以**注入的函数**为准 ⇒ 阶段 2 落地时只需把 T06 的实现接进来。
   *
   * ⚠️ **「一次」的作用域是本进程实例**：第二次调用**不再重训**
   *   （只记一条告警）⇒ 启动流程不会因为「重训也不达标」而死循环。
   *
   * @param isDegraded 质量判据（`true` = 仍不达标）
   * @param options 触发原因（只进日志）
   * @returns 是否真的重训了 + 是否仍不达标
   */
  rebuildVectorBucketsOnce(
    isDegraded: () => boolean,
    options?: RebuildBucketsOptions,
  ): RebuildOnceOutcome {
    if (this.#autoRebuildCount > 0) {
      // ⚠️ **已经重训过一次 ⇒ 不再重训**（§4.15.5：不得在启动阶段反复重训）。
      this.#context.logger.warn(LOG_ACTIONS.sweep, {
        reason: 'rebuild-once-already-done',
        detail: '本进程已重训过一次；不再重复重训（否则启动被拖成分钟级）',
      });
      return { rebuilt: false, degraded: true, cells: 0, members: 0 };
    }

    if (!isDegraded()) {
      // ⚠️ **质量达标 ⇒ 不重训**（重训是 1~3 分钟的阻塞操作 ⇒ 不该无条件做）。
      return { rebuilt: false, degraded: false, cells: 0, members: 0 };
    }

    this.#autoRebuildCount += 1;
    const result = this.rebuildVectorBuckets(options);

    // ⚠️ **重训后仍不达标 ⇒ 记告警并放行**（**不抛错**）：
    //   向量路质量降级（召回变差）**不是启动失败** ⇒ 库必须照常可用。
    const degraded = isDegraded();
    if (degraded) {
      this.#context.logger.warn(LOG_ACTIONS.sweep, {
        reason: 'rebuild-still-degraded',
        detail: '重训后桶质量仍不达标：记告警并放行（向量路质量降级，不是启动失败）',
        cells: result.cells,
        members: result.members,
      });
    }

    return { rebuilt: true, degraded, cells: result.cells, members: result.members };
  }
}
