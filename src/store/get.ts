/**
 * 单条读取：`get(id, now?)` —— DESIGN-v2.md §4.1 末 / §6 的 `MemoryView`，
 * 对应 DEVELOPMENT-PLAN.md **P1-T09**。
 *
 * ★ **门面签名是 `get(id, now?)`；store 层多带一个 `store`**（库句柄 + 生效参数）——
 *   与 `src/store/link.ts` 的 `link(store, ...)` 同一形态（阶段 4 的门面负责收口）。
 *
 * ⚠️ **三条不可省的语义**（§4.1 末 / §11.2）：
 *   ① **不过滤 `deleted`**：软删记录照常返回（`deleted = true`、`deletedAt` 非 null）——
 *      查看器要列软删项、`restore` 之前要确认状态；**硬删**的行才返回 `null`。
 *   ② **刻意不抛 `NOT_FOUND`**：单条读取是查看器与调试的高频操作，
 *      「查不到」是常态而不是异常（§11.2：读接口用返回值表达缺失）。
 *   ③ **不返回 `score` / `breakdown`**：那两个字段只在「某一次 recall」的语境里有意义。
 *
 * ⚠️ **`layer` 与 `intensity` 是读取时现算的派生值**，库里**没有**这两列：
 *   同一行记忆在不同时刻读出来的层级可以不同（这正是「这条记忆此刻算不算归档」的判据）。
 *   ⇒ 它们的计算基准是**注入的 `now`**（C37），真实时钟只经 `src/core/clock.ts`。
 *
 * ⚠️ **`entities` 是**名称**数组，不是 id 数组**：
 *   `entities` 不在 `memories` 表里 ⇒ 必须另查 `memory_entities JOIN entities`。
 *   `MemoryView` 是给人看的视图（§6），调用方拿名字就能直接用。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { type MemoryLayer, effectiveStability, intensity, layerOf } from '../core/decay.js';
import type { Params } from '../core/params.js';

/**
 * §6：`MemoryView` 的 `kind` 取值（与 §3 的 `memories.kind` CHECK 约束一致）。
 */
export const MEMORY_KINDS = ['fact', 'event', 'preference', 'thought', 'topic'] as const;

/** `MemoryView.kind` 的类型。 */
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** §6：`MemoryView` 的 `mediaType` 取值（与 §3 的 `media_type` CHECK 约束一致）。 */
export const MEDIA_TYPES = ['image', 'audio', 'video'] as const;

/** `MemoryView.mediaType` 的类型。 */
export type MediaType = (typeof MEDIA_TYPES)[number];

/**
 * §6 的 `MemoryView` —— 「记忆的静态视图」：只描述「这条记忆现在是什么样」，与任何一次检索无关。
 *
 * ⚠️ **刻意没有 `score` / `breakdown`**（§4.1 末 / §6）：
 *   它们只对「某一次 recall」有意义，不属于记忆本身的属性。
 */
export interface MemoryView {
  /** 业务 uuid（对外只暴露它，不暴露 `rowid`）。 */
  id: string;
  /** 原文（可能含全角 / 大写，与 `content_tokens` 不同构，见 §3）。 */
  content: string;
  /** 该记忆是否已有语义向量（**刻意不返回向量本身**，见 §6）。 */
  hasEmbedding: boolean;
  /** 记忆类型。 */
  kind: MemoryKind;
  /** 当前层级（读取时现算）。 */
  layer: MemoryLayer;
  /** 当前强度（读取时现算，`∈ (0, 1]`）。 */
  intensity: number;
  /** 稳定度（天，时间常数 τ 的基数）。 */
  stability: number;
  /** 难度 `0~1`，越低越容易强化。 */
  difficulty: number;
  /**
   * 有效稳定度 = `stability × pin_factor`（§4.1），单位**天**，语义是**时间常数 τ**。
   *
   * ⚠️ **这是读取时现算的派生值**（库里只有 `stability` 与 `pin_factor` 两列）。
   *   它**不是**半衰期：真正的半衰期 = `τ × ln2 ≈ 0.693τ`（§4.1 的量纲说明）。
   */
  effectiveStability: number;
  /** **canonical 实体名称**（不是 `entity_id`），按名称升序。 */
  entities: string[];
  /** 原始多模态文件指针（与 `mediaType` 同生同死）。 */
  mediaRef: string | null;
  /** 多模态类型（与 `mediaRef` 同生同死）。 */
  mediaType: MediaType | null;
  /** 创建时刻（epoch 毫秒）。 */
  createdAt: number;
  /** 最近一次访问时刻（epoch 毫秒）。 */
  lastAccess: number;
  /** 累计被使用次数。 */
  accessCount: number;
  /** 强调倍率（`[1.0, MAX_PIN_FACTOR]`，默认 1.0）。 */
  pinFactor: number;
  /** 置信度 `0~1`。 */
  confidence: number;
  /** 来源标识（仅供溯源展示，不参与召回过滤）。 */
  source: string | null;
  /** 软删标记（`get` 对软删记录**照常返回**，靠此字段区分状态）。 */
  deleted: boolean;
  /** 软删时间戳（`deleted = false` 时恒为 null）。 */
  deletedAt: number | null;
}

/** `get` 需要的上下文（库句柄 + 生效参数）。 */
export interface MemoryReadStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（层级阈值是可调项 ⇒ **必传**，见 `layerOf` 的说明）。 */
  params: Params;
}

/**
 * 读取单条记忆的 SQL。
 *
 * ⚠️ **不过滤 `deleted`**（§4.1 末的原文就是 `SELECT * FROM memories WHERE id = @id`）：
 *   软删记录必须照常返回——查看器要列软删项、`restore` 之前要确认状态。
 *   加了 `AND deleted = 0` ⇒ 查看器列不出软删项、restore 前无法确认状态（§11.2 常见坑）。
 */
const SELECT_MEMORY_SQL = 'SELECT * FROM memories WHERE id = @id';

/**
 * 读取关联实体**名称**的 SQL（§4.1 末原文）。
 *
 * ⚠️ **必须 `ORDER BY e.name`**：返回的是给人看的名称数组，顺序必须稳定可预期。
 */
const SELECT_ENTITY_NAMES_SQL = `
  SELECT e.name AS name
    FROM memory_entities me
    JOIN entities e ON e.id = me.entity_id
   WHERE me.memory_id = @id
   ORDER BY e.name ASC
`;

/** `memories` 行的形状（`SELECT *` 的结果）。 */
interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  content_tokens: string;
  content_hash: string;
  embedding: Buffer | null;
  media_ref: string | null;
  media_type: string | null;
  source: string | null;
  confidence: number;
  stability: number;
  difficulty: number;
  pin_factor: number;
  created_at: number;
  last_access: number;
  access_count: number;
  deleted: number;
  deleted_at: number | null;
}

/**
 * §11.2：**语义不属于五个 code 的内部不变量违例 ⇒ 原样抛出，但必须带上 `code` 字段**。
 *
 * ⚠️ **不得硬塞进五个 code 里的任何一个**：语义未知的错误塞进某个 code，
 *   会把调用方引向错误的处置（重试 / 改参数 / 查重），比一个未类型化的错误更难排查。
 */
function invariantError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** 把库里的 `kind` 收窄成 §6 的枚举（脏数据不许静默通过）。 */
function toMemoryKind(value: string): MemoryKind {
  const kinds: readonly string[] = MEMORY_KINDS;
  if (!kinds.includes(value)) {
    throw invariantError('MEMORY_KIND_INVALID', `memories.kind 的取值不在枚举内：${value}`);
  }
  return value as MemoryKind;
}

/** 把库里的 `media_type` 收窄成 §6 的枚举（`null` 合法）。 */
function toMediaType(value: string | null): MediaType | null {
  if (value === null) {
    return null;
  }
  const types: readonly string[] = MEDIA_TYPES;
  if (!types.includes(value)) {
    throw invariantError('MEDIA_TYPE_INVALID', `memories.media_type 的取值不在枚举内：${value}`);
  }
  return value as MediaType;
}

/** 读出关联实体的**名称**数组（升序）。 */
function readEntityNames(db: Database.Database, id: string): string[] {
  const rows = db.prepare(SELECT_ENTITY_NAMES_SQL).all({ id }) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * `get(id, now?)` —— §4.1 末的完整行为。
 *
 * ⚠️ **本函数只读不写**：不记事件、不改任何列（§8.4：`recall` 默认不记事件，同理 `get`）。
 *
 * @param store 库句柄 + 生效参数
 * @param id 记忆的业务 uuid
 * @param now 注入时钟（C37）；缺省取真实时钟（经 `resolveNow`）
 * @returns `MemoryView`；**硬删**（行不存在）或 id 不存在时返回 `null`（**不抛 `NOT_FOUND`**）
 */
export function get(store: MemoryReadStore, id: string, now?: number): MemoryView | null {
  const row = store.db.prepare(SELECT_MEMORY_SQL).get({ id }) as MemoryRow | undefined;
  if (row === undefined) {
    // ⚠️ **返回 null 而不是抛 NOT_FOUND**（§11.2：读接口用返回值表达缺失）。
    return null;
  }

  // ⚠️ **时钟只解析一次**：强度与层级必须基于**同一个时刻**算，
  //   否则两次 `resolveNow` 落在毫秒边界两侧会算出「强度属于 t、层级属于 t+1ms」的视图。
  const at = resolveNow(now);

  const decayInput = {
    stability: row.stability,
    pin_factor: row.pin_factor,
    last_access: row.last_access,
  };
  const intensityValue = intensity(decayInput, at);

  return {
    id: row.id,
    content: row.content,
    hasEmbedding: row.embedding !== null,
    kind: toMemoryKind(row.kind),
    layer: layerOf(intensityValue, store.params),
    intensity: intensityValue,
    stability: row.stability,
    difficulty: row.difficulty,
    effectiveStability: effectiveStability(decayInput),
    entities: readEntityNames(store.db, id),
    mediaRef: row.media_ref,
    mediaType: toMediaType(row.media_type),
    createdAt: row.created_at,
    lastAccess: row.last_access,
    accessCount: row.access_count,
    pinFactor: row.pin_factor,
    confidence: row.confidence,
    source: row.source,
    deleted: row.deleted !== 0,
    deletedAt: row.deleted_at,
  };
}
