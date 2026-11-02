/**
 * 维护类操作 —— P2-T05（`rebuildVectorBuckets`；DESIGN-v2.md §4.15.5 / §6 / §9.3.2 ④）
 * 与 P2-T06（启动对账 / 桶质量退化检测；§9.3.2 ③ / ④）。
 *
 * ⚠️ **本文件是 §6 公开方法 `rebuildVectorBuckets` 的落点**（DEVELOPMENT-PLAN.md §3.1
 *   的方法归位表：阶段 2 新增的**唯一**公开方法就是它）。
 *
 * ⚠️ ★ **本文件也是 §6 `verifyIntegrity()` 的落点**（P5-T06）：它是**纯读**
 *   ⇒ **不属于**下面那三个「阻塞写方法」之列 ⇒ 只读实例上**必须可用**（§7.1 的查看器要能看护栏报告）。
 *   它的 `bucketCoverage` 复用同文件的 `computeBucketCoverage()`、归档两项复用
 *   `archival.ts` 的 `checkArchivalSchedule()` ⇒ **口径只有一份**（P5-T06 的常见坑）。
 *
 * ⚠️ **重训的三步序列在 `src/vector/rebuild.ts`**（向量层）：
 *   本文件只做**存储层该做的事**——取参数、记事件、管 `inRetrain`、失效中心缓存。
 *   ⇒ 桶表名**不出现**在本文件里（§4.6 步骤 2c：流水线不得引用桶表名）。
 *
 * ⚠️ ★ **启动对账与桶质量在 `src/vector/reconcile.ts` / `src/vector/bucketQuality.ts`**
 *   （向量层）⇒ 本文件只做**接线**（参数、`inRetrain`、事务包装）。
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
 *   ⇒ **对账也用这条**：重训进行中 ⇒ 对账结论不可信 ⇒ **整体跳过并报告**（§9.3.2 ③）。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { type DecayEdgeInput, edgeWeight } from '../core/decay.js';
import type { Params } from '../core/params.js';
import { LOG_ACTIONS, type Logger } from '../util/log.js';
import type { BucketAssignContext } from '../vector/bucketAssign.js';
import { type BucketRebuildHooks, rebuildBuckets } from '../vector/rebuild.js';
import {
  type ReconcileOptions,
  type ReconcileOutcome,
  reconcileBuckets,
} from '../vector/reconcile.js';
import { checkArchivalSchedule } from './archival.js';
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

  /**
   * 启动对账 + 桶质量（**同一次扫描**）—— §9.3.2 ③ / ④。
   *
   * ⚠️ ★ **这一遍同时给出「对账结论」与「要不要重训」的判据**：
   *   `outcome.quality.degraded` ⇒ **建议**调用方调 `rebuildVectorBuckets()`
   *   ⇒ **库不自动重训**（重训是 1~3 分钟的阻塞操作，ADR-5）。
   *   ⇒ 典型的启动序列：
   *   ```ts
   *   const outcome = maintainer.reconcileBuckets();
   *   maintainer.rebuildVectorBucketsOnce(() => outcome.quality.degraded, { reason: 'startup' });
   *   ```
   *   ⇒ ⚠️ **注意**：第二次调 `reconcileBuckets()` 会**再扫一遍** ⇒
   *     要省这一遍 ⇒ **把第一次的 `quality` 传进 `rebuildVectorBucketsOnce`**（如上）。
   *
   * ⚠️ ★ **重训进行中 ⇒ 整体跳过**（`outcome.report.skipReason = 'retrain-in-progress'`）：
   *   此刻「中心已换、归属只迁了一半」⇒ 结论不可信；
   *   而且修复会用**旧中心**把缺失的记忆挂到**旧代桶**上 ⇒ 重训的步骤 ③ 会**级联删掉**
   *   ⇒ 那批记忆**永久没有归属**（静默、永久）⇒ 宁可跳过并报告。
   *
   * @param options 覆盖项（一般不用传 ⇒ 参数与 `inRetrain` 都由本类接线）
   * @returns 对账报告 + 桶质量
   */
  reconcileBuckets(options?: Partial<ReconcileOptions>): ReconcileOutcome {
    const context = this.#context;
    const outcome = reconcileBuckets(
      context.db,
      // ⚠️ **事务语义只有一份实现**（`src/store/transaction.ts` 的 `runWriteTransaction`）
      //   ⇒ 向量层不自己包事务（依赖方向单向：store → vector）。
      <T>(body: () => T): T => runWriteTransaction(context.db, body),
      {
        // ⚠️ **中心模型取缓存里的那份**（= 当前代）⇒ 缺失的记忆归入**最近的当前代细桶**。
        centroids: () => context.buckets.centroids(),
        nprobeCoarse: context.params.ROUTER_NPROBE_COARSE,
        maxBucketSize: context.params.ROUTER_BUCKET_MAX,
        // ⚠️ ★ **重训进行中 ⇒ 跳过**（`inRetrain` 是本实例的真相，§4.15.5）。
        isRetraining: () => this.#inRetrain,
        ...options,
      },
    );

    const report = outcome.report;
    if (report.skipReason !== null) {
      // ⚠️ **跳过必须留痕**（不静默）：否则调用方会把「没查」当成「查过了、没问题」。
      context.logger.warn(LOG_ACTIONS.sweep, {
        reason: 'reconcile-skipped',
        detail: `启动对账被跳过：${report.skipReason}（结论不可信 ⇒ 不据此判断桶健康）`,
      });
      return outcome;
    }

    if (!report.consistent) {
      // ⚠️ **对账不通过 ⇒ 记告警**（§9.3.2 ③：「若对账每次都发现差异 ⇒ 那是 bug，不是数据问题」）。
      context.logger.warn(LOG_ACTIONS.sweep, {
        reason: 'reconcile-inconsistent',
        missing: report.missing,
        dirty: report.dirty,
        duplicates: report.duplicates,
        softDeleted: report.softDeleted,
      });
    }

    return outcome;
  }
}

/**
 * `verifyIntegrity` 的 `bucketCoverage`（§6：已有向量且已入桶的记忆占比）—— **纯读**。
 *
 * ⚠️ **「只算不修」**：它是**健康度**指标 ⇒ 必须在修复**之前**测
 *   ⇒ 所以它走「**只检测**的对账」⇒ 修复后就恒为 1 ⇒ 没有信息量了。
 *
 * ⚠️ **不额外扫全表**：覆盖率来自对账那**同一次**桶侧扫描 ⇒ §9.3.2 ④ 的
 *   「这一遍可与启动对账合并成同一次扫描」。
 *
 * @param db 库句柄
 * @returns 覆盖率（`0`~`1`；库里没有向量时取 `1` = 没有欠账）
 */
export function computeBucketCoverage(db: Database.Database): number {
  return reconcileBuckets(db, <T>(body: () => T): T => runWriteTransaction(db, body), {
    detectOnly: true,
  }).report.coverage;
}

// ═══════════════════════════════════════════════════════════════════════════
// 一致性自检 —— §6 的 `verifyIntegrity()`（P5-T06）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `verifyIntegrity()` 的返回（§6 的**五个字段**，顺序与 §6 逐字一致）。
 *
 * ⚠️ ★ **五个字段必须与 `stats()` 的同名口径共用实现**（§9.4.4「三道护栏」：
 *   ① 可观测 `stats().archivalOrphans`、② 自检、③ 重建）：
 *   · `archivalOrphans` / `archivalMismatch` ⇒ `archival.ts` 的 `checkArchivalSchedule()`；
 *   · `bucketCoverage` ⇒ 本文件的 `computeBucketCoverage()`（= 对账的 `report.coverage`）。
 *   ⇒ **两处各算一遍 = 迟早一个说 0 一个说 3，而没人知道该信哪个**（P5-T06 的常见坑）。
 */
export interface VerifyIntegrityReport {
  /** 归档缓存里的**孤儿**（缓存有、主表没有或已软删）——与 `stats().archivalOrphans` 恒等。 */
  archivalOrphans: number;
  /** 归档缓存的**不一致**（`archive_at` 与按当前参数重算的值差 > 1ms）——与 `stats()` 恒等。 */
  archivalMismatch: number;
  /** **已有向量且已入桶**的记忆占比（`0`~`1`；库里没有向量时取 `1` = 没有欠账）。 */
  bucketCoverage: number;
  /**
   * **距上次簇发布过了多久**（毫秒）。
   *
   * ⚠️ ★ **`-1` = 从未发布过快照**（**不是** `0`）——
   *   `0` 表示「刚刚发布」，两者语义相反；用一个不可能是「时长」的负数当哨兵，
   *   调用方（面板）不必再额外查一张表就知道「还没有快照这件事」。
   *   ⚠️ **待定（本次裁决，2026-11-02）**：§6 只说「距上次簇发布过了多久」，
   *     没规定「从未发布」怎么表示 ⇒ 本次定为 **`-1` 哨兵**（而不是 `null`：
   *     五个字段在 §6 里**全是 `number`**，返回 `null` 会把这个字段的类型撬开）。
   *   ⇒ 推论（调用方必读）：**判「有没有快照」用 `< 0`，判「有多旧」用具体值**；
   *     「快照很旧」与「从来没有快照」是两件事，处置也不同
   *     （前者 `recluster()` 会因间隔闸门跳过，后者会真的重算）。
   */
  clusterSnapshotFreshness: number;
  /** **联想路健康度（库级）**：当前 `bonus ≥ ACTIVATION_MIN` 的边数（见 `countDiffusableEdges()`）。 */
  edgesDiffusable: number;
}

/**
 * `verifyIntegrity()` 的入参。
 *
 * ⚠️ **公开签名是 `{ deep?: boolean }`**（§6 逐字）⇒ `now` 与 `logger` 是**内部接线**用的：
 *   · `now`：注入时钟（C37）——`clusterSnapshotFreshness` 与 `edgesDiffusable` 都要「现在」；
 *   · `logger`：`deep` 发现问题时那条告警的落点（门面把自己的日志器接进来）。
 *   ⇒ 门面**不把这两个键暴露给调用方**（§6 只承诺 `deep`；多开一个键就是多一次公开承诺）。
 */
export interface VerifyIntegrityOptions {
  /** 是否做**额外**的库级深检（见 `verifyIntegrityReport()`）。 */
  deep?: boolean;
  /** 注入时钟（C37）；缺省取真实时钟。 */
  now?: number;
  /** 日志器（`deep` 深检不通过时记一条 warn）。 */
  logger?: Logger;
}

/**
 * 一致性自检 —— §6 的 `verifyIntegrity(options?)`（§9.4.4 的护栏①②）。
 *
 * ★ **纯读**：不写任何表、不记事件 ⇒ 只读实例上也**必须**可用（§7.1：查看器要能看护栏报告）。
 *   ⚠️ 这条不是「顺便」：把自检归类成写方法 ⇒ 只读查看器调不了护栏报告
 *   ⇒ 护栏①（可观测）就退化成「只有宿主主动想起来才看得见」（P5-T06 的常见坑）。
 *
 * ⚠️ ★ **`deep` 只加检、不改口径**：
 *   · `deep: false`（缺省）⇒ 只算五个字段；
 *   · `deep: true` ⇒ 在**算完五个字段之后**额外跑 `PRAGMA integrity_check` 与
 *     `PRAGMA foreign_key_check`，不通过时记一条 warn 日志。
 *   ⇒ **五个字段的取值与 `deep` 无关**（否则「与 `stats()` 恒等」这条断言会因开关而破）。
 *   ⚠️ **待定（本次裁决，2026-11-02）**：§6 只写了 `options.deep?: boolean` 却没说它检什么；
 *     本次定为「额外两条 PRAGMA，结果只进日志、不进返回值」——
 *     理由：返回值是**五个 number**（§6 逐字），塞进布尔就会改签名；
 *     而深检的价值在「留痕可查」，不在「多一个字段」。
 *
 * ⚠️ **深检可能很慢**（`integrity_check` 是整库逐页校验），但**不阻塞写**：
 *   本库全同步、单线程 ⇒ 慢的是**调用方自己那一次调用**，不是库级锁
 *   （只读路径不持写锁，WAL 下其它连接的写照常进行）。
 *
 * @param db 库句柄
 * @param params 生效参数（归档线 / 边权衰减 / 激活阈值都从它来）
 * @param options `deep` + 内部接线（`now` / `logger`）；全可选
 * @returns §6 的五个字段
 */
export function verifyIntegrityReport(
  db: Database.Database,
  params: Params,
  options?: VerifyIntegrityOptions,
): VerifyIntegrityReport {
  const now = resolveNow(options?.now);

  // ── ① 归档自检（**与 `stats()` 同一个实现**，口径不得分叉）──
  // ⚠️ ★ **不抽样、直接全表比对**：`ARCHIVAL_ORPHAN_CHECK`（§5，默认 1000）是
  //   「宿主调度的抽样条数上限」，而 `checkArchivalSchedule()` 做的是**全表** JOIN + 逐行重算
  //   ⇒ 全表是抽样的**超集** ⇒「抽样能命中那条脏数据」这条验收标准自动成立，
  //     而且不存在「这一轮恰好没抽到」的假绿。
  //   ⇒ 代价是 O(未删记忆数) 次重算；护栏本来就是低频调用，不在这条路径上省。
  const archival = checkArchivalSchedule(db, params);

  // ── ② 桶覆盖率（**复用 `computeBucketCoverage()`**，不另写第二份）──
  // ⚠️ 它内部走 `reconcileBuckets({ detectOnly: true })` 的 `report.coverage`
  //   ⇒「已有向量且已入桶的占比」只有一处实现。
  // ⚠️ 那层 `runWriteTransaction()` 在**只读检测**里其实不做事，但它是合法的：
  //   实测 better-sqlite3 在 `readonly: true` 的连接上 `BEGIN`/`COMMIT` 正常
  //   （只有**真正写**才抛 SQLITE_READONLY）⇒ 只读实例上照常可用。
  //   ⇒ 所以这里**不**为了「绕过事务」去写第二份覆盖率 —— 那才是真正的口径分叉。
  const bucketCoverage = computeBucketCoverage(db);

  // ── ③ 簇快照新鲜度（**直接读 `cluster_snapshot_meta`**，绝不调 `clusters()`）──
  const clusterSnapshotFreshness = readClusterSnapshotFreshness(db, now);

  // ── ④ 联想路健康度（库级存量，**与 `clusters().explain.diffusion` 不同源**）──
  const edgesDiffusable = countDiffusableEdges(db, params, now);

  // ── ⑤ 可选深检（**只加检、不改上面五个字段**）──
  if (options?.deep === true) {
    checkDatabaseConsistency(db, options.logger);
  }

  return {
    archivalOrphans: archival.orphans,
    archivalMismatch: archival.mismatch,
    bucketCoverage,
    clusterSnapshotFreshness,
    edgesDiffusable,
  };
}

/**
 * 读「距上次簇发布过了多久」—— **唯一实现**（`verifyIntegrity().clusterSnapshotFreshness`）。
 *
 * ⚠️ ★ **只 `SELECT computed_at`，绝不调 `clusters()`**：
 *   后者会**写快照**、会触发重算（距上次发布足够久时）——那是写操作
 *   ⇒ 在只读句柄上直接违规，而且「自检」这个动作本身会把被检的那张表改掉（观察者效应）。
 *
 * ⚠️ **`computed_at` 是快照落表时刻**（§3 的列名，与 `publishSnapshot()` 的 INSERT 一致）
 *   ⇒ 它是**已发布快照**的时间戳，不是「本次重算开始的时间」。
 *
 * @param db 库句柄
 * @param now 判定基准（C37）
 * @returns 毫秒差；**从未发布 ⇒ `-1`**（哨兵值，不是 `0`：`0` = 刚刚发布）
 */
function readClusterSnapshotFreshness(db: Database.Database, now: number): number {
  const row = db
    .prepare('SELECT computed_at AS computedAt FROM cluster_snapshot_meta WHERE id = 1')
    .get() as { computedAt: number } | undefined;
  if (row === undefined) {
    // ⚠️ 单行表**没有行** = 从未发布过任何快照（不是「版本 0 的快照」）。
    return -1;
  }
  // ⚠️ **下界夹到 0**（不是让它变负）：`-1` 被「从未发布」占用了
  //   ⇒ 注入的「现在」早于快照时刻（时钟回拨 / 测试注入过去时刻）不得伪装成 ‑1。
  return Math.max(0, now - row.computedAt);
}

/**
 * 数「当前仍可扩散的边」—— **唯一实现**（`verifyIntegrity().edgesDiffusable`）。
 *
 * ★ **口径**（§6）：`bonus ≥ ACTIVATION_MIN` 的**库级存量**边数，其中 `bonus` 与扩散路径
 *   **逐字同一个公式**：`bonus = ACTIVATION_DECAY × edgeWeight(e, params, now) / INITIAL_EDGE_WEIGHT`
 *   （`src/store/diffuse.ts` 的实体腿就是这么算的）。
 *
 * ⚠️ ★ **必须复用 `edgeWeight()`，不在 SQL 里重写指数**：
 *   衰减公式 `w × e^(−Δt/(EDGE_STABILITY×86400000))` 一旦有第二份实现，
 *   两边就会在**参数调整**时漂移（`EDGE_STABILITY` 一改，SQL 那份不跟着变，还不报错）
 *   ⇒ 表现为「召回里一条边都不激活，自检却说边很健康」——**两个口径各有各的真相**。
 *   ⇒ 所以这里**扫边、在 JS 里用那个唯一实现判**（`SELECT weight, last_active FROM edges`）。
 *
 * ⚠️ **它与 `clusters().explain.diffusion.*` 不同源**：一个是**库级存量**、
 *   一个是**本次调用遇到的增量**（`belowThreshold`）⇒ **不能相减**（§6 原文）。
 *   两者的用法是**对照**：边总数够、但本次遇到的都过期了 ⇒ 该重新 `link()` / `touch()` 保鲜。
 *
 * ⚠️ **默认参数下的窗口 ≈ 8.6 天**：`0.2 × 0.8 / 0.8 ≥ 0.15` 要求 `exp(−Δt/30d) ≥ 0.75`
 *   ⇒ `Δt ≤ 30 × ln(1/0.75) ≈ 8.63 天`（§0.2 说的就是这条窗口）。
 *   ⇒ 断言里**不写死 8.6**：窗口随参数走，测试只断言「构造一条远超窗口的旧边 ⇒ 计数下降」。
 *
 * ⚠️ **分母 `INITIAL_EDGE_WEIGHT` 不做零值兜底**：`diffuse.ts` 的实体腿同样直接除
 *   ⇒ 这里加个 ε 兜底就会让两处**在退化参数下的行为分叉**（一处 Infinity、一处有限值）。
 *   保持一致比「看起来更稳」重要。
 *
 * @param db 库句柄
 * @param params 生效参数（`EDGE_STABILITY` / `ACTIVATION_DECAY` / `INITIAL_EDGE_WEIGHT` / `ACTIVATION_MIN`）
 * @param now 判定基准（C37）
 * @returns 仍可扩散的边数
 */
function countDiffusableEdges(db: Database.Database, params: Params, now: number): number {
  // ⚠️ 只在**边**上扫：`edges` 是实体↔实体的语义关系（§3），也就是扩散实体腿走的那张表。
  //   `coacts` 是**另一件事**（记忆↔记忆的共现，簇跳用它）⇒ 不混进来。
  const rows = db.prepare('SELECT weight, last_active FROM edges').all() as DecayEdgeInput[];
  let diffusable = 0;
  for (const row of rows) {
    const weight = edgeWeight(row, params, now);
    const bonus = params.ACTIVATION_DECAY * (weight / params.INITIAL_EDGE_WEIGHT);
    if (bonus >= params.ACTIVATION_MIN) diffusable += 1;
  }
  return diffusable;
}

/**
 * `deep: true` 的**额外**深检：`PRAGMA integrity_check` + `PRAGMA foreign_key_check`。
 *
 * ⚠️ **结果只进日志、不进返回值**（见 `verifyIntegrityReport()` 的「待定」说明）：
 *   返回值是 §6 逐字钉住的五个 number ⇒ 塞布尔就会改签名。
 *
 * ⚠️ **不调 `src/tools/verify.ts` 的 `verifyIntegrity()`**：那个是**阶段 4 的离线工具**
 *   （`IntegrityReport` 里还有稳定性对账 —— 它要把**整个事件流**读进内存，
 *   比这里的两条 PRAGMA 贵一到两个量级）⇒ 自检要的是「快而常设」，
 *   恢复 runbook 要的是「全而深」，**两个用途、两个入口**（同名不同签名是刻意的）。
 *
 * @param db 库句柄
 * @param logger 日志器（缺省不记 —— 自检**不得**因为「没人接收日志」而失败）
 */
function checkDatabaseConsistency(db: Database.Database, logger?: Logger): void {
  // ⚠️ **两条 PRAGMA 都是纯读**（SQLite 侧不写任何页）。
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const integrityOk = integrity.length === 1 && integrity[0]?.integrity_check === 'ok';
  const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length;

  if (integrityOk && foreignKeyViolations === 0) {
    return;
  }

  // ⚠️ **动作名挑 `LOG_ACTIONS.error`**：§8.1 的动作枚举是**闭合的 14 项**
  //   （每个对应 §8.4 的一种 `events.type` + 1 项「错误」）⇒
  //   为了这条告警**新增一个动作常量**会同时改动枚举与 §8.1 的表（那是文档+契约变更）；
  //   而这里的语义正是「库不干净」⇒「错误」是既有选项里最贴切的一个。
  //   ⚠️ **级别用 warn 不用 error**：`error` 级会**同步写盘并 flush**（§8.3）——
  //   自检发现库脏是**需要人看一眼**的事，不是「进程要挂了」。
  logger?.warn(LOG_ACTIONS.error, {
    reason: 'integrity-deep-check-failed',
    integrityOk,
    foreignKeyViolations,
    detail:
      'deep 自检未通过：PRAGMA integrity_check / foreign_key_check 报出问题（§11.3.1 恢复 runbook）',
  });
}
