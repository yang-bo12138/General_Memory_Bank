/**
 * 写入路径 —— DESIGN-v2.md §4.9（去重与合并的四步流程），对应 DEVELOPMENT-PLAN.md **P1-T07**。
 *
 * ★ **全库唯一能改变正文 / 向量 / 稳定度 / 历史的代码路径**（§9.3.0.1）：
 *   写入分四步：
 *   ① **实体别名归一与 UPSERT**：`resolveEntity` 命中别名 ⇒ 直接采用那个实体的 id
 *      （**不新建、不改主名**）；未命中 ⇒ 用该名称作主名走 `ON CONFLICT(name)` UPSERT；
 *   ② **归一化 + 完全重复检测**：hash 命中 ⇒ 加固 + 补实体 + 补向量，**不改写正文**；
 *   ③ **相似检测**（两个证据：实体重叠 / 余弦）⇒ 命中则走 §4.9 步骤 3c 的**原子合并**；
 *   ④ **全新事实创建**：INSERT + 关联实体 + 记 `write` 事件。
 *
 * ⚠️ **步骤 3c 的合并序列在 `src/store/merge.ts`**（独立文件 ⇒「唯一合并写入点」可被静态扫描守住）：
 *   `UPDATE memories SET content` / `SET content_hash` / `SET embedding` **只出现在那一个文件里**。
 *   本文件**不写 `stability`**：稳定度一律经 `growStability`（`src/store/touch.ts`），
 *   那是全库唯一的 `stability` 写入点（§4.2）。
 *
 * ⚠️ **`@newVec` 是本次写入使用的向量的唯一产生处**（§4.9 步骤 2）：
 *   `input.embedding` 直接给 → 校验 → L2 归一化；没给但配了 `embedder` → 现算 → 同一套校验；
 *   都没有 → `null`。
 *   **校验失败一律抛 `INVALID_INPUT` 并在 `details` 带 `reason`**（`'dim'` / `'nan'` / `'zero'`）——
 *   **不截断、不补零、不静默降级为 `null`**：静默降级会让这条记忆此后**一直搜不到**
 *   （向量路捞不到它），而调用方以为写成功了（§4.6 步骤 2c「拒绝而非截断」同一口径）。
 *
 * ⚠️ **C37**：真实时钟只经 `src/core/clock.ts` 的 `resolveNow()`；本文件里不出现 `Date.now()`。
 */

import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { resolveEntity } from '../core/entities.js';
import { MemoryError } from '../core/errors.js';
import type { TouchEventPayload, WriteEventPayload } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import { escapeFts5, normalize, tokenize } from '../core/tokenize.js';
import { LOG_ACTIONS, type Logger } from '../util/log.js';
import { MEDIA_TYPES, MEMORY_KINDS, type MediaType, type MemoryKind } from './get.js';
import {
  type MergeMemoryState,
  type MergeStore,
  backfillEmbeddingIfMissing,
  blobToVector,
  computeAddedEntities,
  linkEntities,
  mergeMemory,
  vectorToBlob,
} from './merge.js';
import { growStability } from './touch.js';
import { runWriteTransaction } from './transaction.js';

// ─────────────────────────── 常量（**不是**可调参数） ───────────────────────────

/**
 * `confidence` 的缺省值（§4.3 / §6：「confidence ∈ [0,1]，缺省 0.7」）。
 *
 * ⚠️ **刻意不是 `DEFAULT_PARAMS` 的一项**：它不在 60 项参数表里 ⇒ 它不是可调旋钮，
 *   而是「调用方不传时用哪个值」的固定缺省（与 §3 的 DDL 默认值 `DEFAULT 0.7` 同源）。
 */
const DEFAULT_CONFIDENCE = 0.7;

/**
 * §4.3 的**置信度惩罚系数**：`0.2 × (1 - confidence)`。
 *
 * ⚠️ `confidence = 1` 时无惩罚、`= 0` 时难度上抬 0.2。
 *   它是 §4.3 正文里的**公式常量**，不在参数表里（改它会改变全部历史记忆的难度语义）。
 */
const CONFIDENCE_PENALTY = 0.2;

/**
 * §4.3 的**难度上限**（`min(0.95, …)`）。
 *
 * ⚠️ **当前参数下不可达**（`baseDifficulty ≤ 0.5`，上抬最多 0.2 ⇒ 最大 0.7），
 *   是给「将来上调 `DIFFICULTY_NORMAL`」预留的兜底。
 *   ⇒ **不要因为「算不出来」就删掉**：删掉的那天参数一上调，难度就会越过 1.0，
 *   而库层 CHECK 会拒绝写入 ⇒ 写入失败（而不是「难度略高一点」）。
 */
const DIFFICULTY_CEILING = 0.95;

/**
 * §4.9 步骤 2 的**零向量判据**：`模长 > 1e-8`。
 *
 * ⚠️ 零向量没有方向 ⇒ 归一化会除零 ⇒ `NaN` 会一路写进库里
 *   （而 `NaN` 的比较恒为 false ⇒ 后面所有阈值判断对它都不生效，**不报错**）。
 */
const MIN_VECTOR_NORM = 1e-8;

// ─────────────────────────── 对外类型 ───────────────────────────

/** §6 的 `WriteInput`。 */
export interface WriteInput {
  /** 正文（**落库用原文**：保留大小写与全角，只有 hash 用归一化形式）。 */
  content: string;
  /** 语义向量；长度必须 == `EMBED_DIM`。不传则用 `embedder` 现算，两者都没有 ⇒ 向量为 `NULL`。 */
  embedding?: number[];
  /** 记忆类型（缺省 `'fact'`）。 */
  kind?: MemoryKind;
  /** 实体名列表（可为主名或别名，内部按 §4.9 步骤 1 归一到 canonical）。 */
  entities?: string[];
  /** 显式声明「某个实体有哪些别名」（§4.9 步骤 1c）。 */
  entityAliases?: Array<{ name: string; aliases: string[] }>;
  /** 情绪强度 `0~1`；**越界值在入口钳制**（§4.3：不能假定调用方守规矩）。 */
  emotion?: number;
  /** 原始多模态文件指针。 */
  mediaRef?: string;
  /** 多模态类型（与 `mediaRef` 必须同时给或同时不给，§3 的 CHECK）。 */
  mediaType?: MediaType;
  /** 溯源元数据（仅存储与展示，不参与召回）。 */
  source?: string;
  /** 置信度 `0~1`（缺省 0.7；通过 §4.3 影响 `initialDifficulty`）。 */
  confidence?: number;
  /** 可注入测试时钟（C37）。 */
  now?: number;
}

/**
 * §6 的 `WriteWarning` —— 「本次**想写但没写成**」的结构化回执。
 *
 * ⚠️ **刻意不是异常**（§11.2 末）：别名冲突时**记忆本身已经写成功**，
 *   只有附属的别名映射没落库。抛异常会让调用方重试 `write()` ⇒ 同一事实被写两遍。
 */
export interface WriteWarning {
  /** 目前唯一来源是 §4.9 步骤 1c 的别名冲突。 */
  code: 'ALIAS_CONFLICT';
  /** 冲突的别名。 */
  alias: string;
  /** 库里现在指向谁。 */
  currentEntityId: string;
  /** 本次想指向谁（调用方若要改，请显式调 `setAlias`）。 */
  intendedEntityId: string;
}

/** §6 的 `write()` 返回值。 */
export interface WriteResult {
  /** 记忆的业务 uuid。 */
  id: string;
  /** 是否命中已有记忆（完全重复或近似合并）。 */
  merged: boolean;
  /**
   * 是否完全重复（`content_hash` 相同）。
   *
   * ⚠️ **这一个字段就够判断「我的输入入库了吗」**（§6）：
   *   `exact === true` ⟺ 库内正文未被改写，调用方传的 `content` 没有入库；
   *   `exact === false` ⟺ 本次文本已成为库内正文（新建 / 近似合并）。
   */
  exact: boolean;
  /** 写入后库内该记忆的**实际正文**（**可能与 `input.content` 不同**）。 */
  content: string;
  /** 本次「想写但没写成」的事；**恒存在**（无冲突时为空数组）。 */
  warnings: WriteWarning[];
}

/** 写入所需的上下文（库句柄 + 生效参数 + 事件写入器 + 日志器 + 可选 embedder）。 */
export interface WriteStore extends MergeStore {
  /** 日志器（§8.1：别名冲突要**同时**记一条磁盘日志）。 */
  logger: Logger;
  /**
   * 可选的**同步**向量函数（§6 的 `MemoryConfig.embedder`）。
   *
   * ⚠️ 没给 `input.embedding` 时用它现算；**返回值的校验与归一化由本库统一做**。
   */
  embedder?: (text: string) => number[];
}

// ─────────────────────────── SQL ───────────────────────────

/**
 * 实体 UPSERT（§4.9 步骤 1b）。
 *
 * ⚠️ **四列全部显式给出**：`id` 是 TEXT PRIMARY KEY（无自增兜底）、
 *   `type` 当前恒为 `'concept'`（§3 已注明现状）、`created_at` 直接取 `@now`。
 *
 * ⚠️ **`ON CONFLICT(name)` 只在「该名称已是某个 `entities.name`」时才复用既有行**：
 *   若该名称命中的是**别名表**（它不是任何实体的主名），直接 UPSERT 会插入一条新实体
 *   ⇒ **别名归一当场失效**（正是 §4.9.2 开头说的那种静默错挂）。
 *   ⇒ 所以调用方**必须先 `resolveEntity`**（见 `resolveEntities`），本 SQL 只处理「确实要新建」的名字。
 */
const UPSERT_ENTITY_SQL = `
  INSERT INTO entities (id, name, type, created_at)
  VALUES (@id, @name, 'concept', @now)
  ON CONFLICT(name) DO UPDATE SET name = excluded.name
  RETURNING id
`;

/**
 * 相似候选的检索（§4.9 步骤 3a）。
 *
 * ⚠️ **`ORDER BY bm25(mem_fts) ASC` 必须显式写出**：不写的话 SQLite 按 rowid 顺序返回
 *   ⇒ 取到的是**最早写入的 3 条**而不是**最相似的 3 条** ⇒ 去重判据整个失灵。
 *
 * ⚠️ **只取前 3 条**：候选面越大，误合并的风险越高（§4.9 的代价段）。
 */
const FIND_CANDIDATES_SQL = `
  SELECT m.id             AS id,
         m.content        AS content,
         m.content_tokens AS content_tokens,
         m.stability      AS stability,
         m.last_access    AS last_access,
         m.access_count   AS access_count,
         m.difficulty     AS difficulty,
         m.embedding      AS embedding,
         bm25(mem_fts)    AS raw_bm25
    FROM mem_fts
    JOIN memories m ON mem_fts.rowid = m.rowid
   WHERE mem_fts MATCH @dedupSql
     AND m.deleted = 0
   ORDER BY bm25(mem_fts) ASC
   LIMIT 3
`;

/**
 * 新建记忆的 INSERT（§4.9 步骤 4）。
 *
 * ⚠️ **`embedding` 在向量为 `null` 时显式写 `NULL`**（不是省略该列）：
 *   省略会落到 DDL 的缺省值（也是 NULL），但**显式写出来**才能让读者看出
 *   「本次没有向量」是一件被显式决定的事，而不是「忘了填」。
 *
 * ⚠️ `pin_factor` / `access_count` / `deleted` / `deleted_at` 交给 DDL 的 DEFAULT：
 *   这四列与本次写入无关，写死它们只会多一处可能写错的常量。
 */
const INSERT_MEMORY_SQL = `
  INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding,
                        media_ref, media_type, source, confidence,
                        stability, difficulty, created_at, last_access)
  VALUES (@id, @kind, @content, @contentTokens, @contentHash, @embedding,
          @mediaRef, @mediaType, @source, @confidence,
          @stability, @difficulty, @now, @now)
`;

/** 按 `content_hash` 找未删记忆（步骤 2 的完全重复检测）。 */
const SELECT_BY_HASH_SQL = `
  SELECT id, content, content_tokens, stability, last_access, access_count, difficulty, embedding
    FROM memories
   WHERE content_hash = @hash AND deleted = 0
`;

/** §11.2：**语义不属于五个 code 的内部不变量违例 ⇒ 原样抛出，但必须带上 `code` 字段。 */
function invariantError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// ─────────────────────────── 纯计算部分 ───────────────────────────

/** 归一化正文的 sha1（§4.9 步骤 2）。 */
function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 把 `emotion` 钳制进 `[0, 1]`（§4.3：不能假定调用方守规矩）。 */
function clampEmotion(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * 算出本次写入使用的向量（**唯一产生处**，§4.9 步骤 2）。
 *
 * @throws {MemoryError} `INVALID_INPUT`（`details.reason` = `'dim'` / `'nan'` / `'zero'`）
 */
function resolveVector(store: WriteStore, input: WriteInput): Float32Array | null {
  let raw: number[] | undefined = input.embedding;
  if (raw === undefined && store.embedder !== undefined) {
    raw = store.embedder(input.content);
  }
  if (raw === undefined) {
    return null;
  }

  const dim = store.params.EMBED_DIM;
  if (!Array.isArray(raw) || raw.length !== dim) {
    throw MemoryError.invalidInput(
      `embedding 的维度必须是 ${dim}（§4.9 步骤 2：不截断、不补零、不静默降级为 null）`,
      { reason: 'dim', expected: dim, actual: Array.isArray(raw) ? raw.length : null },
    );
  }

  let sumSquares = 0;
  for (const value of raw) {
    if (!Number.isFinite(value)) {
      throw MemoryError.invalidInput('embedding 含 NaN / Inf（§4.9 步骤 2：拒绝而非降级）', {
        reason: 'nan',
      });
    }
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm)) {
    // ⚠️ 有限但极大的分量相加会溢出成 `Infinity` ⇒ 归一化后全变 0（一个零向量）。
    //   与真正的 NaN 一样不可用 ⇒ 同样按「非有限」拒绝。
    throw MemoryError.invalidInput('embedding 的模长溢出为无穷（分量过大）', { reason: 'nan' });
  }
  if (!(norm > MIN_VECTOR_NORM)) {
    throw MemoryError.invalidInput('embedding 的模长为 0（零向量没有方向）', { reason: 'zero' });
  }

  const normalized = new Float32Array(dim);
  for (let index = 0; index < dim; index += 1) {
    const value = raw[index];
    if (value === undefined) {
      // ⚠️ 理论上不可达（长度已校验）——但仍必须给一个**有类型**的错误，
      //   而不是让 `undefined / norm` 变成 `NaN` 静默写进库里。
      throw MemoryError.invalidInput('embedding 的长度与维度不符', {
        reason: 'dim',
        expected: dim,
        actual: raw.length,
      });
    }
    normalized[index] = value / norm;
  }
  return normalized;
}

/** 两个向量的余弦；长度不一致 / 缺向量 / 零向量 ⇒ `null`（§4.9 步骤 3b）。 */
function cosineOf(a: Float32Array | null, b: Float32Array | null): number | null {
  if (a === null || b === null) {
    return null;
  }
  if (a.length !== b.length || a.length === 0) {
    // ⚠️ 维度不同 ⇒ **不可比**（§4.9 步骤 2 的「换模型 = 全库重算」那条边界）
    //   ⇒ 返回 `null`，**不要**当成 0（当成 0 会让「不相似的证据」看起来像「没证据」）。
    return null;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) {
      // ⚠️ 理论上不可达（上面已校验两者等长）——但**不许**用 `?? 0` 静默补零：
      //   补零会算出一个「看起来正常」的余弦，而库里没有第二处能发现它。
      return null;
    }
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA <= 0 || normB <= 0) {
    return null;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─────────────────────────── 步骤 1：实体别名归一与 UPSERT ───────────────────────────

/** 步骤 1a / 1b 的结果。 */
interface ResolvedEntities {
  /** 本次写入关联的 canonical `entity_id` 列表（按 id 去重）。 */
  linkedEntityIds: string[];
  /** 名称 → id 的映射（供步骤 1c 解析 `entityAliases[].name`）。 */
  byName: Map<string, string>;
}

/**
 * 建（或取回）一个实体，返回它的 id（§4.9 步骤 1b）。
 *
 * ⚠️ `ON CONFLICT(name) DO UPDATE ... RETURNING id` 的存在不是多余的：
 *   并发下另一个写者可能刚好建了同名实体 ⇒ 裸 `INSERT` 会撞 `entities.name` 的 UNIQUE
 *   ⇒ 整条写入失败。这里要的是「**拿到 id**」，不是「必须新建」。
 */
function upsertEntity(db: Database.Database, name: string, now: number): string {
  const row = db.prepare(UPSERT_ENTITY_SQL).get({ id: randomUUID(), name, now }) as
    | { id: string }
    | undefined;
  if (row === undefined || typeof row.id !== 'string') {
    throw invariantError('ENTITY_UPSERT_FAILED', `实体 UPSERT 未返回 id：${name}`);
  }
  return row.id;
}

/**
 * 步骤 1a / 1b：把调用方给的实体名归一到 canonical `entity_id`。
 *
 * ⚠️ **必须先 `resolveEntity` 再决定要不要新建**：
 *   `resolveEntity` 命中**别名表**时返回的是那个实体的 id ⇒ 直接采用
 *   ⇒ **别名归一当场生效**（这正是 §4.9.2 开头说的「静默错挂」的反面）。
 *   跳过这一步直接 UPSERT（`ON CONFLICT(name)` 只认主名）⇒ 会插入一条**新实体**
 *   ⇒ 「老张」与「张三」从此是两条记录 ⇒ 召回图谱路查不到这层关系。
 *
 * ⚠️ **命中既有实体时「不新建、不改主名」**（§4.9 步骤 1a 原文）。
 */
function resolveEntities(
  db: Database.Database,
  names: readonly string[],
  now: number,
): ResolvedEntities {
  const linkedEntityIds: string[] = [];
  const seen = new Set<string>();
  const byName = new Map<string, string>();

  for (const name of names) {
    const existingId = resolveEntity(db, name);
    const entityId = existingId === null ? upsertEntity(db, name, now) : existingId;
    byName.set(name, entityId);
    if (!seen.has(entityId)) {
      seen.add(entityId);
      linkedEntityIds.push(entityId);
    }
  }
  return { linkedEntityIds, byName };
}

/**
 * 步骤 1c：解析 `entityAliases[].name` 指向的 `entity_id`。
 *
 * ⚠️ **一项只描述一个实体** ⇒ `@thisEntityId` 是**单个**值；
 *   不要拿 `@linkedEntityIds` 当它用（那是步骤 1 全部名称的汇总，可能多个）。
 */
function resolveAliasTargetEntityId(
  db: Database.Database,
  name: string,
  resolved: ResolvedEntities,
  now: number,
): string {
  const mapped = resolved.byName.get(name);
  if (mapped !== undefined) {
    return mapped;
  }
  const existing = resolveEntity(db, name);
  if (existing !== null) {
    return existing;
  }
  // ⚠️ 该名字既不在本次 `input.entities` 里、也不是任何既有实体 ⇒ 按步骤 1b 建一个。
  //   否则这次声明的别名会**无处可挂**（静默丢弃）。
  return upsertEntity(db, name, now);
}

/**
 * 步骤 1c 的冲突检测：返回「当前占着这个名字的实体 id」，没有冲突则返回 `null`。
 *
 * ⚠️ **必须先查再插，不能只靠 `ON CONFLICT(alias) DO NOTHING`**：
 *   `DO NOTHING` 会把两种完全不同的情况一起吞掉——
 *   ① alias 已存在且**指向本实体** ⇒ 幂等跳过，正确；
 *   ② alias 已存在但**指向另一个 entity_id** ⇒ 本次「老张→张三」的归一**根本没生效**，
 *      调用方却以为成功了。这正是 §4.9.2 开头说的「静默错挂」。
 *
 * ⚠️ **还要校验 alias 不等于任何已有 `entities.name`**（主名优先，§4.5 的解析顺序）：
 *   允许主名同时作为别名 ⇒ §4.6 步骤 1 的解析会对同一字符串给出两个不同答案
 *   （① 命中 A、② 命中 B）⇒ 召回结果取决于实现先查哪张表。
 */
function detectAliasConflict(
  db: Database.Database,
  alias: string,
  intendedEntityId: string,
): string | null {
  const primary = db.prepare('SELECT id FROM entities WHERE name = @alias').get({ alias }) as
    | { id: string }
    | undefined;
  if (primary !== undefined) {
    // ⚠️ 主名优先：alias 撞主名 ⇒ 冲突（**即使撞的是它自己**——
    //   `setAlias` 也不允许把主名写进别名表，这里必须与它保持同一口径）。
    return primary.id;
  }

  const owner = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = @alias').get({
    alias,
  }) as { entity_id: string } | undefined;
  if (owner !== undefined && owner.entity_id !== intendedEntityId) {
    return owner.entity_id;
  }
  return null;
}

/**
 * 步骤 1c：同步 `input.entityAliases` 到别名表。
 *
 * ⚠️ **冲突时两个通道都要**（§4.9 步骤 1c）：
 *   · 返回值 `warnings` 追加 `ALIAS_CONFLICT` ⇒ **调用方能看见**；
 *   · 按 §8.1 记一条磁盘日志 ⇒ **人可排障**。
 *   ⇒ **只记日志等于静默**，而这一整节的目的就是「不要静默」。
 *
 * ⚠️ **写入用 `ON CONFLICT(alias) DO NOTHING`**（与 `setAlias` 的 `DO UPDATE` **不统一是刻意的**）：
 *   写路径是批量补别名，不该覆盖别人的正确映射；覆盖是 `setAlias` 的职责（§4.9.2）。
 */
function syncEntityAliases(
  store: WriteStore,
  entries: ReadonlyArray<{ name: string; aliases: string[] }>,
  resolved: ResolvedEntities,
  now: number,
): WriteWarning[] {
  const warnings: WriteWarning[] = [];
  const db = store.db;

  for (const entry of entries) {
    const intendedEntityId = resolveAliasTargetEntityId(db, entry.name, resolved, now);
    for (const alias of entry.aliases) {
      const currentEntityId = detectAliasConflict(db, alias, intendedEntityId);
      if (currentEntityId !== null) {
        // ⚠️ **跳过、不覆盖**（覆盖是 `setAlias` 的职责，§4.9.2「两处不能统一」）。
        warnings.push({ code: 'ALIAS_CONFLICT', alias, currentEntityId, intendedEntityId });
        store.logger.warn(LOG_ACTIONS.write, { alias, now, want: intendedEntityId });
        continue;
      }
      db.prepare(
        `INSERT INTO entity_aliases (alias, entity_id) VALUES (@alias, @entityId)
         ON CONFLICT(alias) DO NOTHING`,
      ).run({ alias, entityId: intendedEntityId });
    }
  }
  return warnings;
}

// ─────────────────────────── 步骤 2 / 3：读取与判定 ───────────────────────────

/** `memories` 行的相关列（步骤 2 / 3 用）。 */
interface MemoryStateRow {
  id: string;
  content: string;
  content_tokens: string;
  stability: number;
  last_access: number;
  access_count: number;
  difficulty: number;
  embedding: Buffer | null;
}

/** 按 hash 找未删记忆（完全重复检测）。 */
function findByHash(db: Database.Database, hash: string): MemoryStateRow | undefined {
  return db.prepare(SELECT_BY_HASH_SQL).get({ hash }) as MemoryStateRow | undefined;
}

/** 计算「传入实体集合 ∩ 候选已关联实体集合」的大小（§4.9 步骤 3b）。 */
function computeEntityOverlap(
  db: Database.Database,
  memoryId: string,
  linkedEntityIds: readonly string[],
): number {
  if (linkedEntityIds.length === 0) {
    return 0;
  }
  const placeholders = linkedEntityIds.map((_, index) => `@e${index}`).join(', ');
  const bindings: Record<string, string> = { memoryId };
  linkedEntityIds.forEach((id, index) => {
    bindings[`e${index}`] = id;
  });
  const rows = db
    .prepare(
      `SELECT entity_id FROM memory_entities
        WHERE memory_id = @memoryId AND entity_id IN (${placeholders})`,
    )
    .all(bindings) as Array<{ entity_id: string }>;
  const linked = new Set(rows.map((row) => row.entity_id));
  return linkedEntityIds.filter((id) => linked.has(id)).length;
}

/**
 * 步骤 3a / 3b / 3c 的前半：找候选并判定是否该合并。
 *
 * ⚠️ **`@dedupSql` 必须显式构造，绝不复用 `buildMatchQuery`**：
 *   `buildMatchQuery` 内部会**再 tokenize 一次** ⇒ 把已切好的 bigram 串传进去是「二次分词」
 *   ⇒ 对 2 字 token 恰好幂等、对其它长度会切出意外 token
 *   ⇒ **去重条件变成不可预测的东西**（且不报错）。
 *
 * ⚠️ **向量路候选本阶段不做**（§4.9 步骤 3a2 的两级分桶属于阶段 2 的 `VectorBackend`）：
 *   ⇒ 候选**只来自文本路**。这是**阶段边界，不是缺陷**。
 *   ⇒ 但「候选自身带向量时的余弦」仍按 §4.9 步骤 3b 计算（候选的向量就在库里）。
 *
 * ⚠️ **阶段 1 不入桶**（ADR《P1 冲突裁决》冲突 7 的裁决）：
 *   §4.9 步骤 3a2 的**向量路候选**（两级路由 + 桶内检索）需要**桶中心**，
 *   而桶中心由阶段 2 的两级 k-means 训练产出（§4.15.3）⇒ 阶段 1 **跳过向量路候选**，
 *   近似去重**退回纯文本路**（步骤 3a）。
 *   ⇒ 代价是**少一条去重证据**（候选少了一半），**不是「去重失效」**
 *     —— 实体重叠与余弦这两条证据仍在（§4.9 步骤 3b 的两条判据照常生效）。
 *   ⇒ 阶段 2（P2-T03 + 桶训练）必须补齐，并在「启动对账 / 首次重训」完成前
 *     **不得对外提供 IVF 向量路**（否则就是 §9.3.2 ① 点名的「静默、永久、不报错」窗口）。
 *
 * @returns 判定成立时返回被合并的旧记忆；不成立返回 `undefined`
 */
function findMergeCandidate(
  db: Database.Database,
  params: Params,
  content: string,
  linkedEntityIds: readonly string[],
  vector: Float32Array | null,
): MergeMemoryState | undefined {
  const tokens = tokenize(content).split(' ').filter(Boolean);
  if (tokens.length === 0) {
    // ⚠️ 没有 token ⇒ 构造不出查询串 ⇒ 文本路整体不执行（§4.6 步骤 2a 的同一口径）。
    return undefined;
  }

  const dedupSql = tokens.slice(0, 3).map(escapeFts5).join(' AND ');
  // ⚠️ **候选不足 2 个 bigram 时**（如「好的」）`AND` 退化为单条件、候选相关性骤降
  //   ⇒ 此时**要求实体重叠数达标**才允许合并（§4.9 步骤 3a 的退化条款），**不要放宽**。
  const textRouteDegenerate = tokens.length < 2;

  const rows = db.prepare(FIND_CANDIDATES_SQL).all({ dedupSql }) as Array<
    MemoryStateRow & { raw_bm25: number }
  >;

  let best: { state: MergeMemoryState; overlap: number; cos: number } | undefined;
  for (const row of rows) {
    const overlap = computeEntityOverlap(db, row.id, linkedEntityIds);
    const cos = cosineOf(vector, row.embedding === null ? null : blobToVector(row.embedding));
    const entityOk = overlap >= params.DEDUP_ENTITY_MIN;
    const cosOk = cos !== null && cos >= params.DEDUP_COS_MIN && !textRouteDegenerate;
    if (!entityOk && !cosOk) {
      continue;
    }
    const cosValue = cos ?? Number.NEGATIVE_INFINITY;
    if (
      best === undefined ||
      overlap > best.overlap ||
      (overlap === best.overlap && cosValue > best.cos)
    ) {
      best = { state: row, overlap, cos: cosValue };
    }
  }
  // ⚠️ **多个候选同时达标时的选取规则**（设计稿未规定 ⇒ 这里定死并写明）：
  //   「实体重叠数多者优先；重叠数相同则余弦大者优先；再相同则取 FTS 排序靠前者」。
  //   ⇒ 规则**确定**（同样的输入永远合并同一条）⇒ 重放与复现不会漂移。
  //   ⚠️ **不要改成「取第一条达标的就合并」**：那会让「先命中哪个候选」取决于 BM25 抖动，
  //   而合并是**不可逆**的正文改写（只能靠 `content_history` 兜底）。
  return best?.state;
}

/** 是否存在「尚无任何关联记忆」的实体（§4.3 的 `existsEntityWithoutMemory`）。 */
function existsEntityWithoutMemory(db: Database.Database, entityIds: readonly string[]): boolean {
  if (entityIds.length === 0) {
    return false;
  }
  const placeholders = entityIds.map((_, index) => `@e${index}`).join(', ');
  const bindings: Record<string, string> = {};
  entityIds.forEach((id, index) => {
    bindings[`e${index}`] = id;
  });
  const row = db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM entities e
          WHERE e.id IN (${placeholders})
            AND NOT EXISTS(SELECT 1 FROM memory_entities me WHERE me.entity_id = e.id)
       ) AS found`,
    )
    .get(bindings) as { found: number };
  return row.found === 1;
}

// ─────────────────────────── 步骤 2 的完全重复路径 ───────────────────────────

/** 完全重复路径的上下文。 */
interface ExactRepeatContext {
  /** 本次写入解析出的 canonical 实体 id 列表。 */
  linkedEntityIds: readonly string[];
  /** 本次写入使用的向量（`null` = 本次没有向量）。 */
  vector: Float32Array | null;
  /** 注入时钟。 */
  now: number;
  /** 步骤 1c 收集到的告警。 */
  warnings: WriteWarning[];
}

/**
 * §4.9 步骤 2：**完全重复**路径（库内已存在同 `content_hash` 且 `deleted = 0` 的记录）。
 *
 * ⚠️ **本路径不改写库内正文**：只动 `stability` / `last_access` / `access_count` 与证据边。
 *   归一化后 hash 相同不代表字面相同（`"ＡＢＣ"` 与 `"abc"` 同 hash）
 *   ⇒ 返回的 `content` 是**库内版本**，调用方据此展示，**不要**用 `input.content`。
 *
 * ⚠️ **必须补齐实体关联**：本路径虽不改写正文，但调用方这次可能带了新实体名；
 *   若不补，这些实体会**丢失与该记忆的关联**——正文没变、强度也加了，
 *   但图谱路查不到这层关系（对比步骤 3c ⑤ 的同一动作）。
 */
function handleExactRepeat(
  store: WriteStore,
  m: MemoryStateRow,
  ctx: ExactRepeatContext,
): WriteResult {
  const db = store.db;

  // ── 加固（统一走 §4.2 的 `growStability`：三个守卫都在里面）──
  // ⚠️ `useSpacing=false`：完全重复不是「间隔重复」。
  const growth = growStability(store, m, store.params.DEDUP_BOOST, false, ctx.now);

  // ── 补齐实体关联（与步骤 3c ⑤ 同一套算法）──
  const addedEntities = computeAddedEntities(db, m.id, ctx.linkedEntityIds);
  linkEntities(db, m.id, addedEntities);

  // ── 向量补写（仅当库内 `embedding IS NULL`；已有向量不得覆盖）──
  // ⚠️ **阶段 1 不入桶**（ADR《P1 冲突裁决》冲突 7 的裁决）：
  //   §4.9 步骤 2 要求「同事务内更新 `vector_cell_members` —— 调 `assignBucket(...)`」，
  //   但 `assignBucket` / `vector_cell_members` 属于**阶段 2**（P2-T03 + 桶训练）
  //   ⇒ 阶段 1 **只写 `memories.embedding`、不写桶**。
  //   ⇒ ⚠️ **不得为此造一个空的 `assignBucket`**：空壳函数 = 死函数 = 假绿，
  //     还会让「四条路径都调了 `assignBucket`」这类静态断言**假通过**。
  //   ⇒ 阶段 2 必须补桶（启动对账 / 首次重训），并新增硬断言：
  //     「`embedding IS NOT NULL` 且 `deleted = 0` 的记忆 id 集合 == `vector_cell_members.memory_id` 集合」
  //     （**集合相等**，不是条数相等——§9.3.2 ③ 的三条判据）。
  const embeddingAdded = backfillEmbeddingIfMissing(db, m.id, ctx.vector) ? 1 : 0;

  // ── 边强化（§4.5 规则 R-EDGE-TOUCH）：**先取计数再 UPDATE** ──
  // ⚠️ 顺序写死：事件里记的 `edgesReinforced` 必须等于**实际**被强化的条数；
  //   顺序反了就会让 payload 与实际对不上（且不报错）。
  const edgesReinforced = (
    db.prepare('SELECT COUNT(*) AS n FROM edges WHERE memory_id = @id').get({ id: m.id }) as {
      n: number;
    }
  ).n;
  db.prepare(
    `UPDATE edges
        SET weight      = min(@maxWeight, weight + @reinforceStep),
            last_active = @now
      WHERE memory_id = @id`,
  ).run({
    maxWeight: store.params.MAX_EDGE_WEIGHT,
    reinforceStep: store.params.EDGE_REINFORCE_STEP,
    now: ctx.now,
    id: m.id,
  });

  // ⚠️ **记的是 `type='touch'`（`reason='exact_repeat'`），不是 `type='write'`**——
  //   §8.4 的 touch 行明写它有**两个**发射点（§4.9 步骤 2 与 §4.2 的 `touch()`）。
  const payload: TouchEventPayload = {
    id: m.id,
    reason: 'exact_repeat',
    intervalDays: growth.intervalDays,
    boostApplied: growth.boosted,
    edgesReinforced,
    embeddingAdded,
    addedEntities,
    stabilityDelta: growth.stabilityDelta,
  };
  store.events.appendEvent('touch', m.id, payload, ctx.now);

  return {
    id: m.id,
    merged: true,
    exact: true,
    content: m.content,
    warnings: ctx.warnings,
  };
}

// ─────────────────────────── 步骤 4：全新事实创建 ───────────────────────────

/** 新建路径的上下文。 */
interface CreateContext {
  /** 步骤 2 算出的 `content_hash`（**不重算**）。 */
  hash: string;
  /** 本次写入使用的向量（`null` = 无向量）。 */
  vector: Float32Array | null;
  /** 本次写入解析出的 canonical 实体 id 列表。 */
  linkedEntityIds: readonly string[];
  /** 注入时钟。 */
  now: number;
  /** 步骤 1c 收集到的告警。 */
  warnings: WriteWarning[];
}

/** 判断一个错误是不是 SQLite 的唯一性约束冲突。 */
function isUniqueConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * §4.9 步骤 4：**全新事实**创建。
 *
 * ⚠️ **并发兜底**：上面「查 `@newHash` 是否已存在」是 SELECT-then-INSERT，
 *   在**单写进程**下安全（§9.1 的单写者约束）；但两个进程同时写同一正文时，
 *   二者都可能 SELECT 到「不存在」⇒ 后者撞 `idx_mem_hash`
 *   ⇒ 得到裸的 `SQLITE_CONSTRAINT_UNIQUE`。
 *   ⇒ **绝不能把裸的 SQLite 错误码抛给调用方**（§11.2）：
 *   它既不说明「冲突了」，也不告诉调用方「哪一条冲突了」⇒ 调用方无法决定是重试还是查重。
 */
function createMemory(store: WriteStore, input: WriteInput, ctx: CreateContext): WriteResult {
  const db = store.db;
  const id = randomUUID();
  const kind = input.kind ?? 'fact';
  const emotion = clampEmotion(input.emotion ?? 0);
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE;

  // ── 初始稳定度（§4.3）──
  // ⚠️ **必须再套 `MAX_STABILITY`**：这是**第三个**能绕过稳定度上限的入口
  //   （前两个是合并路径漏钳制、以及 touch 的 `baseGrowth` 未封顶）。
  const initialStability = Math.min(
    store.params.MAX_STABILITY,
    store.params.INITIAL_STABILITY * (1 + store.params.EMOTION_WEIGHT * emotion),
  );

  // ── 初始难度（§4.3）──
  // ⚠️ **用 `existsEntityWithoutMemory`，不要用 `queryRelatedMemoryCount(...) === 0`**：
  //   后者是「这些实体**总共**关联 0 条记忆」⇒ 等于要求**全部**实体都是首次
  //   ⇒「新人 + 老友」的记忆拿不到首因优待，而它恰恰是最该拿的那一类。
  const isFirstAboutEntity =
    ctx.linkedEntityIds.length > 0 && existsEntityWithoutMemory(db, ctx.linkedEntityIds);
  const baseDifficulty = isFirstAboutEntity
    ? store.params.DIFFICULTY_FIRST
    : store.params.DIFFICULTY_NORMAL;
  const initialDifficulty = Math.min(
    DIFFICULTY_CEILING,
    baseDifficulty + CONFIDENCE_PENALTY * (1 - confidence),
  );

  // ⚠️ **阶段 1 不入桶**（ADR《P1 冲突裁决》冲突 7 的裁决）：
  //   §4.9 步骤 4 要求「同事务内更新 `vector_cell_members` —— 调 `assignBucket(newId, @newVec)`」，
  //   但桶归属是**阶段 2** 的活 ⇒ 阶段 1 **只写 `memories.embedding`、不写桶**。
  //   ⇒ 阶段 2 必须补桶（启动对账 / 首次重训）；同源豁免的完整说明见 `handleExactRepeat` 里那一段。
  try {
    db.prepare(INSERT_MEMORY_SQL).run({
      id,
      kind,
      content: input.content,
      contentTokens: tokenize(input.content),
      contentHash: ctx.hash,
      embedding: ctx.vector === null ? null : vectorToBlob(ctx.vector),
      mediaRef: input.mediaRef ?? null,
      mediaType: input.mediaType ?? null,
      source: input.source ?? null,
      confidence,
      stability: initialStability,
      difficulty: initialDifficulty,
      now: ctx.now,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const conflicting = findByHash(db, ctx.hash);
      throw MemoryError.conflict(
        'write 撞上 content_hash 唯一索引（§4.9 步骤 2 的并发兜底：不得把裸 SQLite 错误码抛给调用方）',
        { conflictingId: conflicting?.id ?? id },
      );
    }
    throw error;
  }

  // ── 关联实体 ──
  linkEntities(db, id, ctx.linkedEntityIds);

  // ── 记事件（§8.4 的 write 行）──
  const payload: WriteEventPayload = {
    id,
    kind,
    contentText: input.content,
    contentLength: input.content.length,
    contentHash: ctx.hash,
    entityIds: [...ctx.linkedEntityIds],
    emotion,
    confidence,
    // ⚠️ **键恒带**：事后能判断「这条为什么没进向量路」。
    hasEmbedding: ctx.vector !== null,
    initialStability,
    initialDifficulty,
  };
  store.events.appendEvent('write', id, payload, ctx.now);

  return {
    id,
    merged: false,
    exact: false,
    content: input.content,
    warnings: ctx.warnings,
  };
}

// ─────────────────────────── 门面 ───────────────────────────

/**
 * `write(input)` —— §4.9 的完整四步写入流程。
 *
 * ⚠️ **四步的顺序不可换**：
 *   ① 实体落库（否则步骤 3b 算不出实体重叠、步骤 4 也无从关联）；
 *   ② 完全重复检测（hash 命中 ⇒ 走加固路径，**不进**相似检测）；
 *   ③ 相似检测（未命中完全重复才走）；
 *   ④ 新建。
 *
 * ⚠️ **整条流程在**`runWriteTransaction`**里**（§9.2 的事务粒度）：
 *   任何一步失败 ⇒ 整体回滚 ⇒ **不留半截状态**（例如「实体建了但记忆没写」）。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器 + 日志器（+ 可选 `embedder`）
 * @param input 本次写入的内容与元数据
 * @returns 写入结果（`warnings` 恒存在；无冲突时为空数组）
 * @throws {MemoryError} `INVALID_INPUT`（向量校验失败 / 入参非法）
 * @throws {MemoryError} `CONFLICT`（并发下撞 `content_hash` 唯一索引；带 `details.conflictingId`）
 */
export function write(store: WriteStore, input: WriteInput): WriteResult {
  const at = resolveNow(input.now);
  const db = store.db;

  // ⚠️ **入参校验放最前面**：不合法的 `kind` / `mediaRef`+`mediaType` 组合 / `confidence`
  //   会撞库层 CHECK ⇒ 裸的 SQLite 错误码穿给调用方（§11.2 禁止）。
  assertWriteInputValid(input);

  // ⚠️ **向量校验放在最前面**：失败要抛 `INVALID_INPUT`，
  //   而**不做截断、不补零、不静默降级为 null**（静默降级会让这条记忆此后一直搜不到，
  //   而调用方以为写成功了）。
  //   放在事务外 ⇒ 失败时**连实体都不会建**（无谓的副作用也没有）。
  const vector = resolveVector(store, input);
  const newHash = sha1(normalize(input.content));

  return runWriteTransaction(db, () => {
    // ── 步骤 1a / 1b：实体别名归一与 UPSERT ──
    const resolved = resolveEntities(db, input.entities ?? [], at);

    // ── 步骤 1c：`entityAliases` 同步 ──
    const warnings = syncEntityAliases(store, input.entityAliases ?? [], resolved, at);

    // ── 步骤 2：完全重复检测 ──
    const existing = findByHash(db, newHash);
    if (existing !== undefined) {
      return handleExactRepeat(store, existing, {
        linkedEntityIds: resolved.linkedEntityIds,
        vector,
        now: at,
        warnings,
      });
    }

    // ── 步骤 3a / 3b：相似检测 ──
    const candidate = findMergeCandidate(
      db,
      store.params,
      input.content,
      resolved.linkedEntityIds,
      vector,
    );
    if (candidate !== undefined) {
      // ── 步骤 3c：原子合并序列（★ 全库唯一 ⇒ 在 `src/store/merge.ts`）──
      const outcome = mergeMemory(store, candidate, {
        content: input.content,
        contentHash: newHash,
        vector,
        linkedEntityIds: resolved.linkedEntityIds,
        now: at,
      });
      return {
        id: outcome.id,
        merged: true,
        exact: false,
        content: outcome.content,
        warnings,
      };
    }

    // ── 步骤 4：全新事实创建 ──
    return createMemory(store, input, {
      hash: newHash,
      vector,
      linkedEntityIds: resolved.linkedEntityIds,
      now: at,
      warnings,
    });
  });
}

/**
 * 校验 `kind` / `mediaRef` + `mediaType` 的组合（§3 的库层 CHECK 的应用层前置）。
 *
 * ⚠️ **不校验就会让裸的 SQLite 错误码穿给调用方**（§11.2）：
 *   `memories.media_type` 与 `media_ref` 必须同生同死（库层 CHECK），
 *   `kind` 必须在枚举内（库层 CHECK）⇒ 这两处的 CHECK 违规都会被
 *   `translateSqliteError` **原样抛出**（清单之外的错误码不转译），
 *   调用方拿到的是一个未类型化的错误 ⇒ 比一个 `INVALID_INPUT` 难处理得多。
 *
 * @throws {MemoryError} `INVALID_INPUT`
 */
export function assertWriteInputValid(input: WriteInput): void {
  if (!MEMORY_KINDS.includes(input.kind ?? 'fact')) {
    throw MemoryError.invalidInput(
      `kind 必须是 ${MEMORY_KINDS.join(' / ')} 之一（§3 的 memories.kind CHECK 约束）`,
      { kind: { current: input.kind, reason: 'not in enum' } },
    );
  }
  const { mediaRef, mediaType } = input;
  if (mediaRef !== undefined && mediaType === undefined) {
    throw MemoryError.invalidInput(
      'mediaRef 与 mediaType 必须同时给或同时不给（§3：二者同生同死，由库层 CHECK 强制）',
      { media: { current: mediaRef, reason: 'mediaRef 与 mediaType 必须成对出现' } },
    );
  }
  if (mediaRef === undefined && mediaType !== undefined) {
    throw MemoryError.invalidInput(
      'mediaRef 与 mediaType 必须同时给或同时不给（§3：二者同生同死，由库层 CHECK 强制）',
      { media: { current: mediaType, reason: 'mediaRef 与 mediaType 必须成对出现' } },
    );
  }
  if (mediaType !== undefined && !MEDIA_TYPES.includes(mediaType)) {
    throw MemoryError.invalidInput(
      `mediaType 必须是 ${MEDIA_TYPES.join(' / ')} 之一（§3 的 media_type CHECK 约束）`,
      { mediaType: { current: mediaType, reason: 'not in enum' } },
    );
  }
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw MemoryError.invalidInput('confidence 必须落在 [0, 1]（§3 的 CHECK 约束）', {
      confidence: { current: input.confidence, reason: 'out of range' },
    });
  }
}
