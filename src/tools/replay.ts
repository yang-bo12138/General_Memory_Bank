/**
 * 事件重放 —— DESIGN-v2.md §8.3 / §8.4 的硬规则 1~3、5，对应 DEVELOPMENT-PLAN.md **P4-T07**。
 *
 * ★ **重放以 `events` 为准，`logs/` 只作人类排障**（§8.3）：
 *   `events` 在事务内 COMMIT（不受日志缓冲影响）⇒ 日志可能缺行，但**事件流永远完整**。
 *
 * ⚠️ **旧事件必须能重放**（§8.4 硬规则 3）：
 *   v1.0 的历史事件里 `coactPairs` / `activationWrites` / `coactSkipped` /
 *   `coactPairsTruncated` **不存在** ⇒ 重放器一律 `?? []` / `?? 0`
 *   （**不能**直接读 `undefined` 再抛错，那会让老库迁移后根本无法重放）。
 *   ⚠️ **旧 `sweep` 事件缺 `action` ⇒ 默认 `'purge'`**。
 *
 * ⚠️ **`stabilityDelta` 的「键的有无」就是「这次有没有真的加固」**：
 *   · 有键、值为 0 ⇒ 加固路径跑了但没涨（例如被 `MAX_STABILITY` 封顶）；
 *   · **没有键** ⇒ 这条事件根本不在加固路径上（`restore_merge` 就是这样）。
 *   ⇒ 对账时**不能**把「没有键」当成「delta = 0 并计入」——那会把恒等式的分母搞错。
 */

import type Database from 'better-sqlite3';

import { DEFAULT_PARAMS, type Params } from '../core/params.js';
import { SCHEMA_VERSION } from '../core/version.js';

/** 一条被重放的事件（**结构宽松**：历史事件可能有缺键）。 */
export interface ReplayEvent {
  id: number;
  type: string;
  memoryId: string | null;
  payload: Record<string, unknown>;
  at: number;
}

/** 重放得到的「某个记忆的视图」。 */
export interface ReplayMemoryState {
  /** 最后一次已知的删除状态。 */
  deleted: boolean;
  /** Σ 带 `stabilityDelta` 的事件的增量（天）。 */
  stabilityDeltaSum: number;
  /** 首次写入时的初始稳定度（来自 `write` 事件；缺 ⇒ `undefined`）。 */
  initialStability?: number;
}

/** 重放的完整结果（**纯数据** ⇒ 可逐位比较「两次重放是否一致」）。 */
export interface ReplayState {
  /** 最后一个 `config` 事件的完整参数快照；没有 config ⇒ `null`。 */
  params: Params | null;
  /** 出现过的 `SCHEMA_VERSION`（按事件顺序去重）。 */
  schemaVersions: number[];
  /** 记忆 id → 视图（**按 id 升序**，便于逐位比较）。 */
  memories: Array<{ id: string; state: ReplayMemoryState }>;
  /** 被 `sweep` 物理清理掉的 id（按出现顺序）。 */
  purgedIds: string[];
  /** 处理过的事件条数。 */
  eventsProcessed: number;
  /** 认不出的 `type`（**不抛错**：重放要能面对未来版本写下的未知事件）。 */
  unknownTypes: string[];
}

/** 读事件流（`upTo` 含端点：`at <= upTo`）。 */
export function readEvents(db: Database.Database, upTo?: number): ReplayEvent[] {
  const sql =
    upTo === undefined
      ? 'SELECT id, type, memory_id AS memoryId, payload, at FROM events ORDER BY id'
      : 'SELECT id, type, memory_id AS memoryId, payload, at FROM events WHERE at <= @upTo ORDER BY id';
  const rows = (
    upTo === undefined ? db.prepare(sql).all() : db.prepare(sql).all({ upTo })
  ) as Array<{ id: number; type: string; memoryId: string | null; payload: string; at: number }>;
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    memoryId: row.memoryId,
    payload: safeParse(row.payload),
    at: row.at,
  }));
}

/** 坏 JSON 的 payload **不该让重放中断**（与遗忘路径同一条纪律）。 */
function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 取一个可能是 `undefined` 的数组字段（旧事件缺键 ⇒ `[]`）。 */
function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 取一个可能是 `undefined` 的数字字段（旧事件缺键 ⇒ 0）。 */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * **纯函数**：把一串事件重放成状态。
 *
 * ⚠️ **无 IO、无随机、无时间依赖** ⇒ 同一串事件重放两次，结果**逐位相同**。
 *
 * @param events 事件流（按 `id` 升序；乱序会得到不同结果 ⇒ 调用方负责顺序）
 * @param options.upTo 只重放到某个时刻（含端点）
 * @returns 重放状态
 */
export function replayEvents(
  events: readonly ReplayEvent[],
  options: { upTo?: number } = {},
): ReplayState {
  const upTo = options.upTo;
  const memories = new Map<string, ReplayMemoryState>();
  const purgedIds: string[] = [];
  const unknownTypes = new Set<string>();
  const schemaVersions: number[] = [];
  let params: Params | null = null;

  const touchMemory = (id: string): ReplayMemoryState => {
    const existing = memories.get(id);
    if (existing !== undefined) return existing;
    const created: ReplayMemoryState = { deleted: false, stabilityDeltaSum: 0 };
    memories.set(id, created);
    return created;
  };

  let processed = 0;
  for (const event of events) {
    if (upTo !== undefined && event.at > upTo) continue;
    processed += 1;

    switch (event.type) {
      case 'write': {
        if (event.memoryId !== null) {
          const state = touchMemory(event.memoryId);
          const initial = event.payload.initialStability;
          if (typeof initial === 'number') state.initialStability = initial;
        }
        break;
      }
      case 'touch': {
        if (event.memoryId !== null) {
          const state = touchMemory(event.memoryId);
          // ⚠️ **只加「有键」的**（旧事件可能没这个键 ⇒ 那说明它不是加固路径写的）
          if (Object.prototype.hasOwnProperty.call(event.payload, 'stabilityDelta')) {
            state.stabilityDeltaSum += numberOrZero(event.payload.stabilityDelta);
          }
          // 旧事件里这四个键不存在 ⇒ `?? []` / `?? 0`（**读一次即证明兼容**）
          void arrayOrEmpty(event.payload.coactPairs);
          void arrayOrEmpty(event.payload.activationWrites);
          void arrayOrEmpty(event.payload.coactSkipped);
          void numberOrZero(event.payload.coactPairsTruncated);
        }
        break;
      }
      case 'merge': {
        const targetId = typeof event.payload.targetId === 'string' ? event.payload.targetId : null;
        if (event.memoryId !== null) touchMemory(event.memoryId);
        if (targetId !== null) {
          const state = touchMemory(targetId);
          // ⚠️ **`restore_merge` 没有这个键** ⇒ 不参与对账（不是「delta = 0」）
          if (Object.prototype.hasOwnProperty.call(event.payload, 'stabilityDelta')) {
            state.stabilityDeltaSum += numberOrZero(event.payload.stabilityDelta);
          }
          // 合并后源记忆不再独立存在
          const mergedFrom = event.payload.mergedFrom;
          if (typeof mergedFrom === 'string') {
            const source = touchMemory(mergedFrom);
            source.deleted = true;
          }
        }
        break;
      }
      case 'forget': {
        if (event.memoryId !== null) {
          touchMemory(event.memoryId).deleted = true;
        }
        break;
      }
      case 'restore': {
        if (event.memoryId !== null) {
          touchMemory(event.memoryId).deleted = false;
        }
        break;
      }
      case 'sweep': {
        const payload = event.payload;
        // ⚠️ **旧事件缺 `action` ⇒ 默认 `'purge'`**（§8.4 硬规则 3）
        const action = typeof payload.action === 'string' ? payload.action : 'purge';
        if (action === 'purge' && event.memoryId !== null) {
          purgedIds.push(event.memoryId);
          memories.delete(event.memoryId);
        }
        break;
      }
      case 'config': {
        const snapshot = event.payload.params;
        if (typeof snapshot === 'object' && snapshot !== null) {
          params = { ...DEFAULT_PARAMS, ...(snapshot as Partial<Params>) };
        }
        const version = event.payload.SCHEMA_VERSION;
        if (typeof version === 'number' && !schemaVersions.includes(version)) {
          schemaVersions.push(version);
        } else if (typeof version !== 'number' && !schemaVersions.includes(SCHEMA_VERSION)) {
          // 连版本号都没记的老事件：按当前版本兜底（**不抛错**）
          schemaVersions.push(SCHEMA_VERSION);
        }
        break;
      }
      case 'recall':
      case 'link':
      case 'pin':
      case 'unpin':
      case 'alias':
      case 'manual_fix':
        break;
      default:
        // 认不出的 type：**记下来但不中断**（重放要能面对未来版本写下的未知事件）
        unknownTypes.add(event.type);
        break;
    }
  }

  return {
    params,
    schemaVersions,
    memories: [...memories.entries()]
      .map(([id, state]) => ({ id, state }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    purgedIds,
    eventsProcessed: processed,
    unknownTypes: [...unknownTypes].sort(),
  };
}

/**
 * 从库里读事件并重放（便捷入口）。
 *
 * @param db 库句柄
 * @param upTo 只重放到某个时刻（含端点）
 */
export function replayFromDb(db: Database.Database, upTo?: number): ReplayState {
  return replayEvents(readEvents(db, upTo), upTo === undefined ? {} : { upTo });
}
