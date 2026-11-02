/**
 * 运行时参数覆写 —— `setParams(patch)`，DESIGN-v2.md §5 / §9.4.3（第 10 条归档路径），
 * 对应 DEVELOPMENT-PLAN.md **P4-T04**。
 *
 * ★ **实现形状是硬要求**（§5）：**先全量校验 → 再单事务写入 → 同事务记 `config` 事件**
 *   ⇒ 任一不满足即抛 `INVALID_INPUT`，且**一个参数都不落库**。
 *
 * ⚠️ **`EMBED_DIM` 两层拦截**：
 *   · 类型层 —— `ParamPatch = Partial<Omit<Params, 'EMBED_DIM'>>`（`core/params.ts` 已排掉）；
 *   · 运行期 —— `applyParamPatch()` 再兜一道（JS 调用方绕过类型）。
 *   漏了后者的后果是**全库向量静默失效**（维度变了，旧向量既不能算余弦、也无法被察觉）。
 *
 * ⚠️ ★ **`ARCHIVE_LINE` 变更是第 10 条归档路径**（§9.4.3 / ADR-30）：
 *   所有 `archive_at` 都是按**旧线**算的 ⇒ 必须**全库重算**
 *   ⇒ 由本文件直接触发 `rebuildArchivalRowsInternal()`（**同一事务内**）。
 *   ⚠️ 它不在 `reindexArchive` 的调用点里：那里按 `memoryIds` 逐条重算，而改归档线是**全库**范围。
 *
 * ⚠️ **参数落哪里**：`meta` 表的一个 `params` JSON 键（§10 待决策项建议的方案）
 *   ⇒ 格式与 `config` 事件的 `params` 快照**完全一致**（同一个 `Params` 对象的 JSON）
 *   ⇒ 「库里存的」与「事件里记的」是同一份形状，不会各写一套。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import type { ConfigEventPayload } from '../core/events.types.js';
import {
  DEFAULT_PARAMS,
  type ParamChange,
  type ParamPatch,
  type Params,
  applyParamPatch,
  diffParams,
} from '../core/params.js';
import { SCHEMA_VERSION } from '../core/version.js';
import { rebuildArchivalRowsInternal } from './archival.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

/** 参数在 `meta` 表里的键名。 */
export const PARAMS_META_KEY = 'params';

/** `setParams` 需要的上下文。 */
export interface SetParamsStore {
  /** 库句柄。 */
  db: Database.Database;
  /**
   * **当前生效参数**（一个**实例独占**的可变容器，见 `applyInPlace`）。
   *
   * ⚠️ 门面把这个对象同时交给 `#context` / `#readContext` / `#writeContext` / 维护器
   *   ⇒ 就地更新它 = 所有持有者同时看到新值（**一个真相源**，而不是各自缓存一份）。
   */
  params: Params;
  /** 事件写入器。 */
  events: EventWriter;
}

/** `setParams()` 的返回值（§6）。 */
export interface SetParamsResult {
  /** 变更后的**完整**生效参数。 */
  params: Params;
  /** 本次真正变了的键（与 `config` 事件的 `changed` 同源）。 */
  changed: ParamChange[];
}

/**
 * 读出库里存的参数（`meta.params`）。
 *
 * ⚠️ **缺键 ⇒ `undefined`**（不是 `DEFAULT_PARAMS`）：
 *   「库里没存过」与「存的是默认值」在语义上是两件事——
 *   前者需要在下次写入时**建立**这份记录，后者不需要。
 * ⚠️ **合并而不是替换**：老库可能存的是**旧版参数表**（后来新增了键）
 *   ⇒ 缺失的键从 `DEFAULT_PARAMS` 补，已有的键以库里为准。
 */
export function readStoredParams(db: Database.Database): Params | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(PARAMS_META_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return undefined;
  const parsed = JSON.parse(row.value) as Partial<Params>;
  return { ...DEFAULT_PARAMS, ...parsed };
}

/** 把参数写进 `meta.params`（调用方负责事务）。 */
export function persistParams(db: Database.Database, params: Params): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    PARAMS_META_KEY,
    JSON.stringify(params),
  );
}

/**
 * 就地更新生效参数容器（**所有持有者共享同一个对象**）。
 *
 * ⚠️ 必须**就地**：`store.params` 的引用被门面的四个上下文与维护器共享
 *   ⇒ 换成新对象会让其中一部分继续用旧值（表现是「改了参数但某条路径行为没变」，且不报错）。
 */
function applyInPlace(target: Params, next: Params): void {
  Object.assign(target, next);
}

function assertWritable(store: SetParamsStore): void {
  if (store.events.readonly) {
    throw MemoryError.readonlyViolation(
      '只读实例上不能执行 setParams（§7.1：真正的写操作一律抛 READONLY_VIOLATION，不短路）',
      { method: 'setParams' },
    );
  }
}

/**
 * 写入一条 `config` 事件（**构造期也走这里**，见 `recordInitialConfig`）。
 *
 * @param store 上下文
 * @param params 写入后的完整参数
 * @param changed 变更差异（**构造期不传** ⇒ 事件里**没有**这个键）
 */
export function appendConfigEvent(
  store: SetParamsStore,
  params: Params,
  changed: ParamChange[] | undefined,
  at?: number,
): void {
  // ⚠️ 构造期**不带** `changed`（§8.4）：只记 `changed: []` 等于把第 0 步的参数留白，
  //   重放时只能拿 DEFAULT_PARAMS 反推 ⇒ 推出来的与实际生效值可能不同，**而且不会报错**。
  const payload: ConfigEventPayload =
    changed === undefined ? { SCHEMA_VERSION, params } : { SCHEMA_VERSION, params, changed };
  store.events.appendEvent('config', null, payload, at);
}

/**
 * 构造期的「第 0 步」：把生效参数**落库**并记一条 `config` 事件。
 *
 * ⚠️ **只读实例上不落库**（事件写入器自己会短路），但仍要把参数交给调用方。
 * ⚠️ 覆盖写：构造期的 `config.params` 是**调用方显式指定**的口径 ⇒ 它应当覆盖库里存的值
 *   （否则「我传了参数却不生效」是更坏的意外）。
 */
export function recordInitialConfig(store: SetParamsStore, params: Params, now?: number): void {
  if (store.events.readonly) {
    appendConfigEvent(store, params, undefined, now);
    return;
  }
  const at = resolveNow(now);
  runWriteTransaction(store.db, () => {
    persistParams(store.db, params);
    appendConfigEvent(store, params, undefined, at);
  });
}

/**
 * `setParams(patch)` —— §5 的参数变更。
 *
 * @param store 库句柄 + 生效参数容器 + 事件写入器
 * @param patch 要改的键（**不含 `EMBED_DIM`**）
 * @param now 注入时钟（事件时间戳，C37）
 * @returns `{ params, changed }`
 * @throws {MemoryError} `INVALID_INPUT`（未知键 / 类型不符 / 跨参数校验不过 / 含 `EMBED_DIM`）／
 *                       `READONLY_VIOLATION`
 */
export function setParams(store: SetParamsStore, patch: ParamPatch, now?: number): SetParamsResult {
  assertWritable(store);
  const at = resolveNow(now);
  const current = store.params;

  // ── ① 全量校验（**发生在任何写入之前**）──
  const next = applyParamPatch(current, patch);
  const changed = diffParams(current, next);
  // ⚠️ 空补丁也要走完事务并记事件吗？§8.4 的 config 事件是「参数变更的记录」
  //   ⇒ 没有变更就不该记一条「什么都没改」的事件（那会让事件流里出现假变更）。
  if (changed.length === 0) {
    return { params: { ...current }, changed: [] };
  }

  const archiveLineChanged = next.ARCHIVE_LINE !== current.ARCHIVE_LINE;

  // ── ② + ③ 单事务：写参数 → 记事件 →（若归档线变了）重建归档缓存 ──
  runWriteTransaction(store.db, () => {
    persistParams(store.db, next);
    appendConfigEvent(store, next, changed, at);
    if (archiveLineChanged) {
      // ★ 第 10 条归档路径：全库重算（**同一事务** ⇒ 「参数改了但缓存没跟上」不会发生）
      rebuildArchivalRowsInternal(store.db, next);
    }
  });

  // ④ 让所有持有者看到新值（就地更新共享容器）
  applyInPlace(current, next);

  return { params: { ...next }, changed };
}
