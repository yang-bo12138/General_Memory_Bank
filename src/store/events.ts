/**
 * 事件流的写入 —— DESIGN-v2.md §8.4（事件类型与发射点对照表）/ §7.1 第 4 条（只读短路）/ §8.2（正文口径）。
 *
 * ⚠️ **`memory_id` 是 `appendEvent()` 的必传实参**（值可以是 `null`，但**不允许省略这个参数**）——
 *   §8.4 硬规则 5 的原话。
 *   漏写该列的后果是「用户说了忘掉，而原文静静躺在库里」——**不报错、不告警**：
 *   遗忘脱敏（§4.8 步骤 ②）是**按 `events.memory_id` 索引定位**的。
 *   「必传实参 + 显式 null」而不是「可选参数」的原因：
 *   可选参数漏传是**静默**的（TS 编译通过、运行时无异常），
 *   而显式传 `null` 会在代码审查里一眼看到「这里为什么不关联记忆」。
 *
 * ⚠️ **只读实例上必须短路而不是抛错**（§7.1 第 4 条）：
 *   §7.2 的召回模拟器会调用 `recall({ explain: true })`，按 §8.4 这条路径要写一条 `recall` 事件——
 *   在 `readonly: true` 的句柄上执行必然抛 `SQLITE_READONLY`，界面直接白屏。
 *   规则：`appendEvent()` 内部先判 `readonly`，为真则**跳过写入并记一条 warn 日志**
 *   （说明「只读模式下事件未落库」），**业务返回值照常给出**。
 *   ⚠️ 判断**必须收在 `appendEvent()` 内部**，不能让每个调用点各自记得判。
 *   与之对照：**真正的写操作**仍然抛 `MemoryError.READONLY_VIOLATION`，不短路。
 */

import { MemoryError } from '../core/errors.js';
import {
  CONTENT_TEXT_KEY,
  type EventPayload,
  type EventType,
  type MergeEventPayload,
  TYPES_ALLOWING_CONTENT_TEXT,
  isRestoreMergePayload,
} from '../core/events.types.js';
import { LOG_ACTIONS, type Logger } from '../util/log.js';

/** 预编译语句的最小结构（与 better-sqlite3 的 `Statement` 兼容）。 */
export interface EventStatement {
  run(...params: unknown[]): unknown;
}

/** 事件存储的最小结构（与 better-sqlite3 的 `Database` 兼容）。 */
export interface EventDatabase {
  prepare(sql: string): EventStatement;
}

/** 事件写入器的配置。 */
export interface EventWriterOptions {
  /** 只读实例？（§7.1：`{ readonly: true, fileMustExist: true }`） */
  readonly: boolean;
  /** 日志器（只读短路时要记一条 warn）。 */
  logger: Logger;
  /** 注入时钟（C37：实现文件里不出现 `Date.now()`）。 */
  now: () => number;
}

/** 写一条事件的 SQL。 */
const INSERT_EVENT_SQL = 'INSERT INTO events (type, memory_id, payload, at) VALUES (?, ?, ?, ?)';

/**
 * 判断一个 payload 是否**允许**携带正文（§8.2）。
 *
 * · 非 `write` / `merge` / `manual_fix` 三类 ⇒ **一律不得**含 `contentText`；
 * · `merge` 的 `restore_merge` 变体 ⇒ **不得**含 `contentText`（该路径不改写正文）。
 */
export function allowsContentText(type: EventType, payload: EventPayload): boolean {
  if (!TYPES_ALLOWING_CONTENT_TEXT.includes(type)) {
    return false;
  }
  if (type === 'merge' && isRestoreMergePayload(payload as MergeEventPayload)) {
    return false;
  }
  return true;
}

/**
 * 事件写入器。
 *
 * ⚠️ 本类**不是**公开 API：它是 `MemoryStore` 内部的依赖
 *   （阶段 1 的 P1-T05 ~ P4-T06 各方法通过它记事件）。
 */
export class EventWriter {
  readonly #db: EventDatabase;
  readonly #readonly: boolean;
  readonly #logger: Logger;
  readonly #now: () => number;
  #insert: EventStatement | undefined;

  constructor(db: EventDatabase, options: EventWriterOptions) {
    this.#db = db;
    this.#readonly = options.readonly;
    this.#logger = options.logger;
    this.#now = options.now;
  }

  /** 只读实例？ */
  get readonly(): boolean {
    return this.#readonly;
  }

  /**
   * 追加一条事件。
   *
   * @param type 13 种 `events.type` 之一
   * @param memoryId **必传**；值可以是 `null`，但**不允许省略这个参数**
   * @param payload 事件载荷
   * @param at 事件时间戳（缺省用注入时钟）
   *
   * @throws {MemoryError} code = `INVALID_INPUT`（payload 违反 §8.2 的正文口径时）
   */
  appendEvent(type: EventType, memoryId: string | null, payload: EventPayload, at?: number): void {
    // ── §8.2：正文口径在**写入前**就被守住 ──
    // ⚠️ 判据是「payload **确实带了** contentText」且「该 type 不允许带」——
    //   「不允许带」本身不是错误，不带才是常态。
    const carriesContentText = CONTENT_TEXT_KEY in payload;
    if (carriesContentText && !allowsContentText(type, payload)) {
      throw MemoryError.invalidInput(
        `events.type=${type} 的 payload 不得包含 ${CONTENT_TEXT_KEY}（§8.2：正文只在 write / merge(3c) / manual_fix 三类可写）`,
        {
          type: { current: type, reason: `payload must not contain ${CONTENT_TEXT_KEY}` },
        },
      );
    }

    // ── §7.1 第 4 条：只读实例**短路**而不是抛错 ──
    if (this.#readonly) {
      this.#logger.warn(LOG_ACTIONS.error, {
        op: LOG_ACTIONS[type],
        err: '只读模式下事件未落库',
      });
      return;
    }

    this.#statement().run(type, memoryId, JSON.stringify(payload), at ?? this.#now());
  }

  /** 取（并缓存）预编译的插入语句。 */
  #statement(): EventStatement {
    if (this.#insert === undefined) {
      this.#insert = this.#db.prepare(INSERT_EVENT_SQL);
    }
    return this.#insert;
  }
}
