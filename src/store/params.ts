/**
 * 参数的落库形状 —— DESIGN-v2.md §5。
 *
 * ⚠️ §5 明写实现形状必须是：
 *   **先全量校验 → 再单事务写入 → 同事务记 `config` 事件**
 *   ⇒ 任一不满足即抛 `INVALID_INPUT` 且**一个参数都不落库**。
 *
 * ⚠️ 为什么「同事务」不可拆：`events` 表是「可完整重放」的唯一依据（§9.2）——
 *   参数改了但事件没记（或反之），重放出来的库与实际生效的库不是同一个。
 *   §8.4 硬规则 2：`config` **必须记录**，否则「可完整重放」在第 0 步就断了。
 *
 * 本模块只负责**形状**；真正的 SQLite 绑定由阶段 1（P1-T01 建连接 / P4-T04 公开 `setParams`）提供，
 * 阶段 0 用内存后端把这条形状钉死。
 */

import type { EventPayload, EventType } from '../core/events.types.js';
import {
  type ParamChange,
  type ParamPatch,
  type Params,
  applyParamPatch,
  diffParams,
} from '../core/params.js';
import { SCHEMA_VERSION } from '../core/version.js';

/**
 * 参数存储的后端端口（阶段 1 起由真实的 SQLite 连接实现）。
 *
 * ⚠️ `transaction()` 的语义必须与 SQLite 一致：**抛错 ⇒ 回滚**。
 *   这是「一个参数都不落库」这条不变量的落点。
 */
export interface ParamsBackend {
  /** 读取当前生效的全量参数。 */
  readParams(): Params;
  /** 在**当前事务内**写入全量参数。 */
  writeParams(params: Params): void;
  /** 在**当前事务内**追加一条事件（`memory_id` 必传，值可为 `null`）。 */
  appendEvent(type: EventType, memoryId: string | null, payload: EventPayload): void;
  /** 单事务包装：回调抛错 ⇒ 回滚。 */
  transaction<T>(fn: () => T): T;
}

/** `setParams()` 的返回值。 */
export interface SetParamsResult {
  /** 变更后的**完整**生效参数。 */
  params: Params;
  /** 本次变更的差异（同时写进 `config` 事件的 `changed`）。 */
  changed: ParamChange[];
}

/**
 * 参数仓库 —— 对外只暴露「读取当前参数」与「按补丁改参数」。
 *
 * ⚠️ **本类不是公开 API**：`setParams()` 是 `MemoryStore` 的 23 个公开方法之一，
 *   归**阶段 4**（P4-T04）落地。本类在阶段 0 只把**形状**与**不变量**钉死。
 */
export class ParamStore {
  readonly #backend: ParamsBackend;

  constructor(backend: ParamsBackend) {
    this.#backend = backend;
  }

  /** 当前生效的全量参数。 */
  get params(): Params {
    return this.#backend.readParams();
  }

  /**
   * 按补丁改参数。
   *
   * 形状：**先全量校验 → 再单事务写入 → 同事务记 `config` 事件**。
   *
   * @throws {MemoryError} code = `INVALID_INPUT`；此时**一个参数都不落库**、**一条事件都不写**。
   */
  setParams(patch: ParamPatch): SetParamsResult {
    const current = this.#backend.readParams();

    // ① 全量校验（失败即抛，尚未发生任何写入）
    const next = applyParamPatch(current, patch);
    const changed = diffParams(current, next);

    // ② + ③ 单事务：写参数 + 同事务记 `config` 事件
    this.#backend.transaction(() => {
      this.#backend.writeParams(next);
      this.#backend.appendEvent('config', null, {
        SCHEMA_VERSION,
        params: next,
        changed,
      });
    });

    return { params: next, changed };
  }
}
