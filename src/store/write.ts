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
import { LOG_ACTIONS } from '../util/log.js';
import { assignBucket, unassignBucket } from '../vector/bucketAssign.js';
import { normalizeNumbers } from '../vector/dot.js';
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
 *
 * ⚠️ **v2.1（P2-T01 后）：这个阈值的唯一权威声明在 `src/vector/dot.ts`**
 *   （导出为 `MIN_VECTOR_NORM`）⇒ 本文件**引用**它，**不再本地声明一份**
 *   ⇒ 否则「同一件事两处定义」⇒ 改一处不改另一处 ⇒ 写入路径与向量层的零向量判据**静默分叉**
 *   （C36：同一件事不得有两套词）。
 */

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
 *
 * ⚠️ **做成可辨识联合（discriminated union）而不是「一堆可选字段」**：
 *   两个变体的字段集**互不重叠**（`alias` vs `name`）⇒
 *   写成可选字段的话，调用方得自己记住「哪个 code 能读哪个键」⇒ 两套取值逻辑（C36）。
 */
export type WriteWarning = AliasConflictWarning | AliasTargetNotLinkedWarning;

/**
 * `ALIAS_CONFLICT`：别名已存在且指向**别的**实体 ⇒ 跳过、不覆盖（§4.9 步骤 1c）。
 */
export interface AliasConflictWarning {
  /** 警告码（可辨识联合的判别键）。 */
  code: 'ALIAS_CONFLICT';
  /** 冲突的别名。 */
  alias: string;
  /** 库里现在指向谁。 */
  currentEntityId: string;
  /** 本次想指向谁（调用方若要改，请显式调 `setAlias`）。 */
  intendedEntityId: string;
}

/**
 * `ALIAS_TARGET_NOT_LINKED`：别名目标实体**建好了**，但**没有**跟本条记忆建立关联。
 *
 * ⚠️ **为什么需要这条 warning**（ADR-P1-T07-DEC 的 D-3/R2）：
 *   「建但不隐含关联」是**有意**的边界（关联只由 `input.entities` 表达 ⇒ §14.3 边界原则 1），
 *   但它有代价：调用方只声明 `entityAliases`、不点名实体 ⇒
 *   **别名建好了、本条记忆却不与该实体关联** ⇒ 图谱路查不到它 ⇒ **静默达不到召回目的**。
 *   ⇒ **边界可以存在，但必须可观测** ⇒ 这里回一条 warning（并按 §8.1 记一条磁盘日志）。
 *
 * ⚠️ **一个 `name` 一条**（不是每个别名一条）：
 *   报的是「**这个实体**没跟这条记忆关联」，不是「这两个别名有问题」。
 */
export interface AliasTargetNotLinkedWarning {
  /** 边界提示码。 */
  code: 'ALIAS_TARGET_NOT_LINKED';
  /** 调用方在 `entityAliases[].name` 里写的那个实体名。 */
  name: string;
  /** 该实体的 id（**已经建出来了**——它确实存在，只是没跟本条记忆关联）。 */
  entityId: string;
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

/**
 * 写入所需的上下文（库句柄 + 生效参数 + 事件写入器 + 日志器 + 桶归属上下文 + 可选 embedder）。
 *
 * ⚠️ **日志器与桶归属上下文都继承自 `MergeStore`**：
 *   · 日志器（§8.1：别名冲突要**同时**记一条磁盘日志）；
 *   · 桶归属上下文（§9.3.0 的唯一写入点——写入路径改 `embedding` 时同事务同步桶归属）。
 */
export interface WriteStore extends MergeStore {
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

  // ⚠️ **归一化走向量层的唯一权威**（`src/vector/dot.ts` 的 `normalizeNumbers`）。
  //   ⚠️⚠️ **必须用 `normalizeNumbers`（`number[]` 入口）而不是 `normalize`（`Float32Array` 入口）**：
  //     本路径的入参是**原始 double** ⇒ 归一化必须在 **double 域**里算、**之后**才截断成 float32；
  //     而 `normalize` 的入参已经是 float32 ⇒ 两者**逐位不同**（实测 6 个分量全部不同）。
  //     ⇒ 换成 `normalize` 会**逐位改变落库值** ⇒ **P1-T09 的基线逐位一致会红**。
  //   ⇒ 归一化的校验（NaN/Inf、模长溢出、零向量）与实现**只有一份**，在向量层。
  return normalizeNumbers(raw);
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
  /** 已进 `linkedEntityIds` 的 id 集合（去重用）。 */
  seen: Set<string>;
}

/**
 * 把一个实体 id 计入「本次写入关联的实体」（按 id 去重）。
 *
 * ⚠️ **只有 `input.entities` 走这个函数**（ADR-P1-T07-DEC 的 D-3/R2「建，但不隐含关联」）：
 *   `@linkedEntityIds` 的定义是「a 步与 b 步的结果汇总」⇒ **只来自 `input.entities`**。
 *   ⇒ `entityAliases` 只声明**命名**（谁是谁的别名），**不声明关联**（这条记忆关于谁）。
 *   ⇒ 别名目标实体走 `resolveAliasTargetEntityId`（**建，但不进这里**）。
 *
 * ⚠️ **不要**为了「让别名也对召回生效」而在这里把别名目标也塞进来：
 *   那样就有**两处**能表达「这条记忆跟 X 有关」⇒ §14.3 边界原则 1（每个承诺都要能指到唯一代码路径）就破了。
 *   ⇒ 想让别名对召回生效，**必须把实体名同时写进 `input.entities`**。
 */
function linkEntityId(resolved: ResolvedEntities, entityId: string): void {
  if (resolved.seen.has(entityId)) {
    return;
  }
  resolved.seen.add(entityId);
  resolved.linkedEntityIds.push(entityId);
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
  const resolved: ResolvedEntities = { linkedEntityIds: [], seen: new Set<string>() };

  for (const name of names) {
    const existingId = resolveEntity(db, name);
    const entityId = existingId === null ? upsertEntity(db, name, now) : existingId;
    linkEntityId(resolved, entityId);
  }
  return resolved;
}

/**
 * 步骤 1c：解析 `entityAliases[].name` 指向的 `entity_id`。
 *
 * ⚠️ **建，但不隐含关联**（口径出处：**ADR-P1-T07-DEC 的 D-3/R2**；
 *   主理人 2026-10-31 改判，历史引用「ADR-P1-R2 裁决 ①」指向同一条现行口径）：
 *   · **建**：`entityAliases[].name` 是调用方**显式点名**的实体，
 *     而写路径的既定语义就是「写入路径负责建实体」（步骤 1b 对 `input.entities` 里的未知名字也是建）
 *     ⇒ **同一个调用方语义在两个字段上必须表现一致**。
 *     ⇒ 不建 ⇒ 这次声明的别名**无处可挂**（`entity_aliases.entity_id` 无处指）
 *     ⇒ **静默丢弃** ⇒ 违背 §4.9 步骤 1c「不要静默」的总原则。
 *   · **不关联**：**无论命中既有实体还是新建，都不进 `@linkedEntityIds`**
 *     ⇒ 不与本条记忆建立 `memory_entities` 关联，也不出现在 write 事件的 `entityIds` 里。
 *     ⇒ 理由：**`entities` 是「这条记忆跟 X 有关」的**唯一**表达机制**
 *     ⇒ 若 `entityAliases` 也能顺带建立关联，就有**两处**能表达同一件事
 *     ⇒ §14.3 边界原则 1（每个承诺都要能指到唯一代码路径）就破了。
 *
 * ⚠️ **代价（明写在这里，别让它变成静默）**：调用方若**只**声明 `entityAliases`、
 *   却没把该实体名放进 `input.entities` ⇒ 别名映射建好了，
 *   但**本条记忆不与该实体关联** ⇒ 图谱路查不到它 ⇒ **静默达不到召回目的**。
 *   ⇒ 想让别名对召回生效，**必须把实体名同时写进 `input.entities`**。
 *   ⇒ **代价必须可观测** ⇒ 由 `syncEntityAliases` 回一条 `ALIAS_TARGET_NOT_LINKED`
 *     （**边界可以存在，但必须可观测**；主理人 2026-10-31 终裁）。
 *
 * ⚠️ **若「新建实体」与 `input.entities` 里的同名实体是同一个** ⇒ 那时它**因 `input.entities`
 *   而被关联**（走 `entities` 那条路径）⇒ 这是对的，
 *   **不要因此把别名路径的关联也打开**（那正是本函数**不**做 `linkEntityId` 的原因）。
 *
 * ⚠️ **与 `input.entities` 走同一套 a→b 归一**：
 *   先 `resolveEntity`（**主名或别名都算命中**——它内部就是先查主名表、再查别名表）
 *   ⇒ 命中就用该 id；未命中 ⇒ 按 b 步 UPSERT 新建实体。
 *
 * ⚠️ **一项只描述一个实体** ⇒ 返回值是**单个** id；
 *   不要拿 `@linkedEntityIds` 当它用（那是汇总，可能多个）。
 */
function resolveAliasTargetEntityId(db: Database.Database, name: string, now: number): string {
  const existing = resolveEntity(db, name);
  return existing === null ? upsertEntity(db, name, now) : existing;
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
 *
 * ⚠️ **`linkedEntityIds` 只用来判断「要不要回报边界」**（`ALIAS_TARGET_NOT_LINKED`）：
 *   别名目标**绝不**因此进关联（关联只由 `input.entities` 表达 ⇒ D-3/R2），
 *   但「没关联」这件事**必须可观测**（否则调用方以为「声明了别名 = 这条记忆关于这个人」）。
 */
function syncEntityAliases(
  store: WriteStore,
  entries: ReadonlyArray<{ name: string; aliases: string[] }>,
  linkedEntityIds: readonly string[],
  now: number,
): WriteWarning[] {
  const warnings: WriteWarning[] = [];
  const db = store.db;

  for (const entry of entries) {
    // ⚠️ 这里**不**把 `intendedEntityId` 计入 `@linkedEntityIds`：
    //   关联只由 `input.entities` 表达（ADR-P1-T07-DEC 的 D-3/R2「建，但不隐含关联」）。
    const intendedEntityId = resolveAliasTargetEntityId(db, entry.name, now);
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

    // ⚠️ **边界必须可观测**（D-3/R2 的代价明写）：
    //   别名目标实体**建好了**，但本条记忆**没有**跟它关联 ⇒ 图谱路（§4.6 步骤 2b）查不到它
    //   ⇒ 调用方若以为「声明了别名就等于这条记忆关于这个人」，就会**静默达不到召回目的**。
    //   ⇒ 这里回一条 `ALIAS_TARGET_NOT_LINKED`（并按 §8.1 记一条磁盘日志）。
    //
    // ⚠️ **判定按实体 id，不按名字**：调用方可能用**别名**点名同一个实体
    //   （`entities: ['老张']` + `entityAliases: [{ name: '张三', ... }]`）
    //   ⇒ 那个实体**确实**被关联了 ⇒ **不该**报这条 warning。
    //
    // ⚠️ **一个 `name` 一条**（不是每个别名一条）：
    //   报的是「**这个实体**没跟这条记忆关联」，不是「这两个别名有问题」⇒
    //   `{ name:'张三', aliases:['老张','小张'] }` ⇒ **1 条**，不是 2 条。
    if (!linkedEntityIds.includes(intendedEntityId)) {
      warnings.push({
        code: 'ALIAS_TARGET_NOT_LINKED',
        name: entry.name,
        entityId: intendedEntityId,
      });
      store.logger.warn(LOG_ACTIONS.write, {
        name: entry.name,
        now,
        entityId: intendedEntityId,
        linked: false,
      });
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
 * 候选排序用的键（裁决 D）。
 *
 * ⚠️ **四个键缺一不可**：前三个都是「浮点 / 计数」，两个候选完全同分是常事；
 *   没有第四级（`id`）⇒ 选中谁取决于**遍历顺序**（FTS 的物理行序）
 *   ⇒ 同样输入不可复现 ⇒ 重放会得到不同结果（§12：排序必须有全序 tie-break）。
 */
export interface MergeCandidateKey {
  /** 候选记忆 id（最后一级 tie-break：升序）。 */
  id: string;
  /** 实体重叠数（**降序**：越大越优先）。 */
  overlap: number;
  /** 余弦相似度（**降序**；`-Infinity` = 没有向量可比 ⇒ 排最后）。 */
  cos: number;
  /** FTS 的 BM25 原始分（**升序**：越小越相关）。 */
  bm25: number;
}

/**
 * 候选排序（裁决 D）：**entityOverlap 降序 → cos 降序（null 排最后）→ raw_bm25 升序 → id 升序**。
 *
 * ⚠️ **为什么最后一级必须是 `id`**：前三级全同分时，若不定序
 *   ⇒ 「选中谁」取决于 BM25 结果的**物理顺序**（不保证稳定）
 *   ⇒ 同一份输入两次运行可能合并到不同记忆 ⇒ 合并是**不可逆的正文改写**
 *   （只能靠 `content_history` 兜底）⇒ 这不是「小瑕疵」，是「行为不可复现」。
 *
 * ⚠️ **`-Infinity` 的处理**：`cos` 为 `null`（没有向量可比）时记 `-Infinity`；
 *   比较时**先判「是否相等」再算差值** ⇒ 两个 `-Infinity` 不会算出 `NaN`
 *   （`NaN` 会让所有比较都为 false ⇒ 排序静默退化）。
 *
 * @returns `< 0` 表示 `a` 优先；`> 0` 表示 `b` 优先；`0` 表示**四键全等**（同一个候选）。
 */
export function compareMergeCandidates(a: MergeCandidateKey, b: MergeCandidateKey): number {
  if (a.overlap !== b.overlap) {
    return b.overlap - a.overlap;
  }
  if (a.cos !== b.cos) {
    return b.cos - a.cos;
  }
  if (a.bm25 !== b.bm25) {
    return a.bm25 - b.bm25;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * 步骤 3a / 3b / 3c 的前半：找候选并判定是否该合并。
 *
 * ⚠️ **`@dedupSql` 必须显式构造，绝不复用 `buildMatchQuery`**：
 *   `buildMatchQuery` 内部会**再 tokenize 一次** ⇒ 把已切好的 bigram 串传进去是「二次分词」
 *   ⇒ 对 2 字 token 恰好幂等、对其它长度会切出意外 token
 *   ⇒ **去重条件变成不可预测的东西**（且不报错）。
 *
 * ⚠️ **向量路候选本阶段不做**（§4.9 步骤 3a2 的两级路由 + 桶内检索属于**阶段 2 的向量路**，
 *   由 T05 / T06 接通）：
 *   ⇒ 候选**只来自文本路**。这是**阶段边界，不是缺陷**。
 *   ⇒ 但「候选自身带向量时的余弦」仍按 §4.9 步骤 3b 计算（候选的向量就在库里）。
 *
 * ⚠️ **但「桶归属」已经接了**（P2-T03-b）：
 *   写入路径改 `memories.embedding` 时**同事务**同步桶归属（§9.3.0 / §9.3.2 ①）
 *   ⇒ 「有向量 ⇒ 有桶归属」这条不变式**从现在起成立**
 *   ⇒ 而「按桶找候选」（步骤 3a2 的向量路）**仍然缺席**
 *     ⇒ 近似去重**暂时**退回纯文本路（步骤 3a）。
 *   ⇒ 代价是**少一条去重证据**（候选少了一半），**不是「去重失效」**
 *     —— 实体重叠与余弦这两条证据仍在（§4.9 步骤 3b 的两条判据照常生效）。
 *   ⇒ ⚠️ 在「启动对账 / 首次重训」完成前**不得对外提供 IVF 向量路**
 *     （否则就是 §9.3.2 ① 点名的「静默、永久、不报错」窗口）。
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
  // ⚠️ **裁决 F 的精确口径**：退化时合并判定**收敛为** `entityOverlap ≥ DEDUP_ENTITY_MIN`，
  //   **cos 通道不单独成立**（非退化时仍是「entityOverlap ≥ N **或** cos ≥ DEDUP_COS_MIN」）。
  //   口径出处：ADR-P1-R2 裁决 ①（待架构师最终措辞确认）。
  //   ⚠️ **架构师已出终稿**（ADR-P1-T07-DEC 的 D-6，三分支）：
  //     `n=0`（0 个 bigram）⇒ **文本路整体不执行**（无候选 ⇒ 不合并，**不是**退化态）——
  //     上面 `tokens.length === 0` 时直接 `return undefined` 就是这一支；
  //     `n=1`（退化态）⇒ **只认实体重叠**，cos 通道（**合并资格**）整条不生效；
  //     `n≥2` ⇒ 「实体重叠达标 **或** cos 达标」。
  //   ⚠️ 补充一句容易写反的地方：退化态**不是**「两条判据里有一条成立就合并」，
  //   而是「**只认实体重叠**」——候选面已不可信 ⇒ 不能拿余弦去合并。
  //   ⚠️ 「cos 通道不生效」说的是**合并资格**，**不是排序**：
  //   退化态下 cos 仍然参与 tie-break 的第二级（见 `compareMergeCandidates`）。
  //   ⚠️ 阈值用**参数** `DEDUP_ENTITY_MIN`（默认 2）而不是写死 2：
  //   设计稿的字面「≥ 2」只是这个参数的**默认值**，判据本身应当与步骤 c 的实体判据同源。
  const textRouteDegenerate = tokens.length < 2;

  const rows = db.prepare(FIND_CANDIDATES_SQL).all({ dedupSql }) as Array<
    MemoryStateRow & { raw_bm25: number }
  >;

  let best: { state: MergeMemoryState; key: MergeCandidateKey } | undefined;
  for (const row of rows) {
    const overlap = computeEntityOverlap(db, row.id, linkedEntityIds);
    const cos = cosineOf(vector, row.embedding === null ? null : blobToVector(row.embedding));
    const entityOk = overlap >= params.DEDUP_ENTITY_MIN;
    const cosOk = cos !== null && cos >= params.DEDUP_COS_MIN && !textRouteDegenerate;
    if (!entityOk && !cosOk) {
      continue;
    }
    const key: MergeCandidateKey = {
      id: row.id,
      overlap,
      // ⚠️ 没有向量可比 ⇒ 记 `-Infinity` ⇒ **排在最后**（而不是当成 0）。
      cos: cos ?? Number.NEGATIVE_INFINITY,
      bm25: row.raw_bm25,
    };
    if (best === undefined || compareMergeCandidates(key, best.key) < 0) {
      best = { state: row, key };
    }
  }
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
  const embeddingAdded = backfillEmbeddingIfMissing(db, m.id, ctx.vector) ? 1 : 0;

  // ── 桶归属同步（§4.9 步骤 2 / §9.3.0 / §9.3.2 ①）──
  // ⚠️ **「补了向量就必须入桶」**：补写成功后这条记忆**现在有向量了**
  //   ⇒ 必须有桶归属，否则它**永远不进任何桶** ⇒ 向量路永远召不回它，
  //     而 `embeddedRatio` 却在涨 ⇒ **静默、永久、不报错**（§9.3.2 ① 点名的失效点）。
  // ⚠️ **只在「真的补写了」时同步**：
  //   · 已有向量 ⇒ 本次**没改**向量 ⇒ 桶归属不该动（改它等于无谓的桶 churn）；
  //   · 没传向量 ⇒ 本次**没动**向量（库里那份原样保留）⇒ 桶归属也不该动。
  if (embeddingAdded === 1 && ctx.vector !== null) {
    const assignment = assignBucket(store.buckets, m.id, ctx.vector);
    if (!assignment.assigned) {
      // ⚠️ **中心模型尚未训练 ⇒ 没有可归属的桶**（`assignBucket` 不抛错，否则整个库不可写）。
      //   ⇒ 记进日志让它可观测（静默吞掉就是上面说的那个静默失效点）。
      store.logger.warn(LOG_ACTIONS.write, {
        reason: 'bucket-not-trained',
        memoryId: m.id,
      });
    }
  }

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

  // ── 桶归属同步（§4.9 步骤 4 / §9.3.0 / §9.3.2 ①）──
  // ⚠️ **必须在上面那条 INSERT 之后**：桶归属行的外键指向 `memories(id)`
  //   ⇒ 记忆行还没落库时插桶行会被外键挡下（`NOT_FOUND`）。
  // ⚠️ **与 INSERT 同事务**（本函数整体在调用方的 `runWriteTransaction` 里）
  //   ⇒ 失败即整体回滚 ⇒ 不会出现「记忆在、桶不在」的孤儿。
  if (ctx.vector === null) {
    // ⚠️ **「没传向量 ⇒ 桶里不该有它」**（§4.15.3 第三条）：
    //   无向量的记忆占着桶的成员名额 ⇒ 桶计数偏大
    //   ⇒ `p95BucketSize` / `maxBucketSize` / 兜底切分判定量**全部偏**。
    //   ⇒ 新记忆本无归属，这里仍走 `unassignBucket` 是为了守住
    //     「**桶归属状态 == 向量状态**」这条不变式（不靠「这个状态不可达」当理由，§14.3 C28）。
    unassignBucket(store.buckets, id);
  } else {
    const assignment = assignBucket(store.buckets, id, ctx.vector);
    if (!assignment.assigned) {
      // ⚠️ **中心模型尚未训练 ⇒ 没有可归属的桶**（`assignBucket` 不抛错，否则整个库不可写）。
      //   ⇒ 记进日志让它可观测（静默吞掉就是 §9.3.2 ① 点名的静默失效点）。
      store.logger.warn(LOG_ACTIONS.write, {
        reason: 'bucket-not-trained',
        memoryId: id,
      });
    }
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
 * ⚠️ **TODO（P2-T03-b · 阶段 4 接手）：§4.9.1 步骤 4 的 `updateContent` 路径。**
 *
 * ⚠️ **本轮刻意不建 `src/store/updateContent.ts`**（阶段 4 才建）：
 *   §4.9.1 步骤 4「显式改正文」是一条**独立的 embedding 赋值路径**
 *   ⇒ 它建起来时**必须**同事务调用 `assignBucket` / `unassignBucket`（§9.3.0）
 *   ⇒ 若先建一个「只改正文、不管桶」的空壳 ⇒ 那就是「阶段 1 不入桶」的翻版
 *   ⇒ 而「四条路径都调了 `assignBucket`」这类静态断言会**假通过**。
 *   ⇒ 所以：**要么一次做对，要么先别建**（同 P1-T07 对空壳 `assignBucket` 的处理）。
 *
 * ⚠️ **建的时候别忘了**：
 *   ① 它落在**写事务内**（`runWriteTransaction`）⇒ 桶归属与正文同事务（§9.3.2 ①）；
 *   ② 改了 `embedding` ⇒ 同步桶归属（§4.9.1 步骤 4）；
 *   ③ 置 `NULL` ⇒ `unassignBucket`（§4.15.3 第三条）。
 */

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
    // ⚠️ `linkedEntityIds` 只用来判断「别名目标有没有被关联」⇒ 回报 `ALIAS_TARGET_NOT_LINKED`；
    //   **绝不**因此把别名目标加进关联（关联只由 `input.entities` 表达）。
    const warnings = syncEntityAliases(
      store,
      input.entityAliases ?? [],
      resolved.linkedEntityIds,
      at,
    );

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
 * 校验 `kind` / `confidence` / `mediaRef` + `mediaType`（§3 的库层 CHECK 的应用层前置）。
 *
 * ⚠️ **不校验就会让裸的 SQLite 错误码穿给调用方**（§11.2）：
 *   `memories.media_type` 与 `media_ref` 必须同生同死（库层 CHECK），
 *   `kind` 必须在枚举内、`confidence` 必须落在 [0,1]（都是库层 CHECK）
 *   ⇒ 这些 CHECK 违规都会被 `translateSqliteError` **原样抛出**（清单之外的错误码不转译），
 *   调用方拿到的是一个未类型化的错误 ⇒ 比一个 `INVALID_INPUT` 难处理得多。
 *
 * ⚠️ **裁决 G：`details` 用扁平的 `reason` 键**（`'kind'` / `'confidence'` / `'media'`），
 *   与向量校验那三处（`'dim'` / `'nan'` / `'zero'`）**同一族词**——
 *   ⇒ 调用方可以只认 `details.reason` 一个键就分清是哪一类入参问题。
 *
 * ⚠️ **别和 `emotion` 写混**：`emotion` 按 §4.3 **钳制**（不抛错）；
 *   `confidence` **不钳制**——越界就是**调用方的 bug**，静默改写等于替调用方撒谎。
 *
 * @throws {MemoryError} `INVALID_INPUT`
 */
export function assertWriteInputValid(input: WriteInput): void {
  if (!MEMORY_KINDS.includes(input.kind ?? 'fact')) {
    throw MemoryError.invalidInput(
      `kind 必须是 ${MEMORY_KINDS.join(' / ')} 之一（§3 的 memories.kind CHECK 约束）`,
      { reason: 'kind', current: input.kind ?? null },
    );
  }
  const { mediaRef, mediaType } = input;
  if (mediaRef !== undefined && mediaType === undefined) {
    throw MemoryError.invalidInput(
      'mediaRef 与 mediaType 必须同时给或同时不给（§3：二者同生同死，由库层 CHECK 强制）',
      { reason: 'media', current: mediaRef },
    );
  }
  if (mediaRef === undefined && mediaType !== undefined) {
    throw MemoryError.invalidInput(
      'mediaRef 与 mediaType 必须同时给或同时不给（§3：二者同生同死，由库层 CHECK 强制）',
      { reason: 'media', current: mediaType },
    );
  }
  if (mediaType !== undefined && !MEDIA_TYPES.includes(mediaType)) {
    throw MemoryError.invalidInput(
      `mediaType 必须是 ${MEDIA_TYPES.join(' / ')} 之一（§3 的 media_type CHECK 约束）`,
      { reason: 'media', current: mediaType },
    );
  }
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw MemoryError.invalidInput('confidence 必须落在 [0, 1]（§3 的 CHECK 约束）', {
      reason: 'confidence',
      current: input.confidence ?? null,
    });
  }
}
