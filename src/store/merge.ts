/**
 * 合并写入点 —— DESIGN-v2.md §4.9 步骤 3c（§9.3.0.1「全库唯一的合并写入点」），
 * 对应 DEVELOPMENT-PLAN.md **P1-T07**。
 *
 * ★ **为什么单独抽一个文件**（§9.3.0.1）：
 *   「**同一件事有两份实现 ⇒ 必然漂移，而漂移不报错。**」
 *   ⇒ `UPDATE memories SET content` / `SET content_hash` / `SET embedding`
 *     **只允许出现在本文件里**，由 `tests/unit/merge.test.ts` 的静态扫描守住。
 *   ⇒ 写成独立文件而不是塞进 `write.ts` 的一个函数，是因为**闸门要能「按文件」定位**：
 *     同一文件里塞两处实现，扫描器只能靠函数名定位（本仓库 `touch.test.ts` 就是这么做的）；
 *     独立文件让「唯一写入点」变成**一条可机械判定的事实**。
 *
 * ⚠️ **本文件也是 `stability` 的间接写入方，但只经 `growStability`**（§4.2）：
 *   全库唯一的 `stability` 写入点是 `src/store/touch.ts` 的 `growStability`
 *   （那里封着三个约束：同日守卫 / `MAX_STABILITY` 上限 / `last_access`+`access_count` 同步）。
 *   ⇒ 本文件**绝不许**自己写 `UPDATE memories SET stability`。
 *
 * ⚠️ **本文件同时拥有「实体关联补齐」的唯一实现**（`computeAddedEntities` + `linkEntities`）：
 *   §4.9 步骤 2（完全重复）与步骤 3c ⑤（合并）**必须用同一套算法**
 *   ——「不要各写一份」（两处各写一份 ⇒ 差集算法漂移 ⇒ 事件 payload 里的
 *   `addedEntities` 与实际入库的行对不上，**且不报错**）。
 *   ⇒ 抽成本文件的两个导出函数，`src/store/write.ts` 直接复用（单向依赖，无循环导入）。
 *
 * ⚠️ **依赖方向是单向的**：`write.ts` → `merge.ts` → `touch.ts` / `core/*`。
 *   `merge.ts` **不 import `write.ts`** ⇒ 没有循环导入。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import type { MergeEventPayload3c } from '../core/events.types.js';
import type { Params } from '../core/params.js';
import { tokenize } from '../core/tokenize.js';
import type { EventWriter } from './events.js';
import { growStability } from './touch.js';

/** 合并写入所需的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface MergeStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（`DEDUP_BOOST` / `MAX_STABILITY` 等的界都在参数表里 ⇒ **必传**）。 */
  params: Params;
  /** 事件写入器（合并要记一条 `merge` 事件，§8.4）。 */
  events: EventWriter;
}

/** 参与合并的旧记忆的字段子集（`memories` 行的相关列）。 */
export interface MergeMemoryState {
  /** 记忆 id。 */
  id: string;
  /** 库内当前正文（合并前）。 */
  content: string;
  /** 库内当前分词快照（归档进 `content_history` 用）。 */
  content_tokens: string;
  /** 当前稳定度（天）。 */
  stability: number;
  /** 上次访问时刻。 */
  last_access: number;
  /** 累计访问次数。 */
  access_count: number;
  /** 难度 `0~1`。 */
  difficulty: number;
  /** 当前向量（`null` = 无向量）。 */
  embedding: Buffer | null;
}

/** 合并所需的新值（由 §4.9 的步骤 2 / 3c 提供，**不得在这里重算**）。 */
export interface MergeInput {
  /** 新正文（**无条件采纳**，ADR-9：长度启发式已废弃）。 */
  content: string;
  /**
   * 新正文的 `content_hash` —— **必须是步骤 2 算出的那一个**。
   *
   * ⚠️ **不要在这里重算**：步骤 2 已验证「该 hash 在未删记录中不存在」，
   *   重算等于丢掉这个前置保证 —— 而它正是「合并后不撞 `idx_mem_hash` 唯一约束」的依据。
   */
  contentHash: string;
  /** 本次写入使用的向量（`null` = 合并后该记忆的向量置 `NULL`）。 */
  vector: Float32Array | null;
  /** 本次写入解析出的 canonical `entity_id` 列表。 */
  linkedEntityIds: readonly string[];
  /** 注入时钟（C37）。 */
  now?: number;
}

/** 合并的结果（同时是 `merge` 事件 payload 的来源）。 */
export interface MergeOutcome {
  /** 被合并的目标记忆 id（合并**不新建**记忆 ⇒ id 不变）。 */
  id: string;
  /** 合并后的正文（= 本次传入的新正文）。 */
  content: string;
  /** 合并后落库的 `content_hash`。 */
  contentHash: string;
  /** 合并后正文的长度。 */
  contentLength: number;
  /** 合并前正文的长度（供「覆写是否在丢信息」的观测，§4.9 的代价段）。 */
  prevContentLength: number;
  /** 本次**新增**的实体关联（已关联的不重复计入）。 */
  addedEntities: string[];
  /** 合并后该记忆是否仍有向量。 */
  hasEmbedding: boolean;
  /** 距上次访问的天数。 */
  intervalDays: number;
  /** 是否真的涨了稳定度。 */
  boostApplied: boolean;
  /** 稳定度的实际增量（天）。 */
  stabilityDelta: number;
}

// ─────────────────────────── 向量的 BLOB 编解码 ───────────────────────────

/**
 * 把 `Float32Array` 编成可入库的 BLOB（**Float32 小端**，§3 的 `embedding` 列）。
 *
 * ⚠️ **v2.1（P2-T02 后）：本文件不再持有实现，改为 re-export 向量层的唯一权威**。
 *   权威实现 = `src/vector/centroids.ts` 的 `vectorToBlob` / `blobToVector`
 *   （`memories.embedding` 与桶中心 `centroid` 是**同一格式** ⇒ 编解码必须**同源**）。
 *   ⇒ 原来这里有一份**逐字节相同**的副本 ⇒ 改一处不改另一处 ⇒
 *     「写入路径的向量」与「桶中心的向量」**字节序可能分叉**（一端小端、一端平台序）
 *     ⇒ 而库里没有任何东西能发现它（余弦值看起来仍是合法数字）⇒ **静默劣化**。
 *   ⇒ 保留本文件的这**两个导出名**（`src/store/write.ts` 从这里 import），
 *     但**实现只有一份**（C36：同一件事不得有两套词）。
 */
import { blobToVector, vectorToBlob } from '../vector/centroids.js';

export { blobToVector, vectorToBlob };

// ─────────────────────────── 实体关联补齐（步骤 2 与 3c ⑤ 共用） ───────────────────────────

/**
 * 算出「本次要补、但该记忆**尚未**关联」的实体 id 列表。
 *
 * ⚠️ **必须先算差集再 INSERT**（顺序不能反）：下面的 `touch` / `merge` 事件要记
 *   `addedEntities` —— 若先 INSERT 再算差集，算出来永远是空数组，
 *   事件里就**看不出这条记忆多了哪些实体关联**（`memory_entities` 本身不在事件流里，
 *   没有第二处能追溯这件事，**且不报错**）。
 *
 * @param db 库句柄
 * @param memoryId 目标记忆 id
 * @param linkedEntityIds 本次写入解析出的 canonical 实体 id 列表
 * @returns 需要新增关联的实体 id（保持入参顺序、已去重）
 */
export function computeAddedEntities(
  db: Database.Database,
  memoryId: string,
  linkedEntityIds: readonly string[],
): string[] {
  if (linkedEntityIds.length === 0) {
    return [];
  }
  const placeholders = linkedEntityIds.map((_, index) => `@e${index}`).join(', ');
  const bindings: Record<string, string> = {};
  linkedEntityIds.forEach((id, index) => {
    bindings[`e${index}`] = id;
  });
  const rows = db
    .prepare(
      `SELECT entity_id FROM memory_entities
        WHERE memory_id = @memoryId AND entity_id IN (${placeholders})`,
    )
    .all({ ...bindings, memoryId }) as Array<{ entity_id: string }>;
  const existing = new Set(rows.map((row) => row.entity_id));
  return linkedEntityIds.filter((id) => !existing.has(id));
}

/**
 * 把实体补挂到记忆上（步骤 2 与步骤 3c ⑤ **共用**的实现）。
 *
 * ⚠️ **空数组直接返回**：把空数组拼进 SQL 会得到 `VALUES (@memoryId)` 这样的
 *   语法错误片段 ⇒ 整条写入失败。**空集合是常态**（本次没带任何实体名）。
 *
 * ⚠️ **用 `INSERT OR IGNORE`**：PK 是 `(memory_id, entity_id)` ⇒ 重复插入会撞主键。
 *   差集已经算过，理论上不会重复；`OR IGNORE` 只是兜底（并发下别人可能先插了同一行）。
 *
 * @param db 库句柄
 * @param memoryId 目标记忆 id
 * @param entityIds 要新增的实体 id 列表
 */
export function linkEntities(
  db: Database.Database,
  memoryId: string,
  entityIds: readonly string[],
): void {
  if (entityIds.length === 0) {
    return;
  }
  const groups = entityIds.map((_, index) => `(@memoryId, @e${index})`).join(', ');
  const bindings: Record<string, string> = { memoryId };
  entityIds.forEach((id, index) => {
    bindings[`e${index}`] = id;
  });
  db.prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES ${groups}`).run(
    bindings,
  );
}

// ─────────────────────────── 向量补写（§4.9 步骤 2 的回填通道） ───────────────────────────

/**
 * 向量补写：**仅当库内 `embedding IS NULL` 时**写入（§4.9 步骤 2）。
 *
 * ⚠️ **带 `embedding IS NULL` 是必须的**：已有向量时不得覆盖——
 *   同一段正文在不同模型下算出的向量**不可比**（维度可能恰好相同，库无法检测），
 *   一旦允许覆盖，同一张表里就会混着两代向量 ⇒ 余弦值失去意义，**且没有任何报错**。
 *   换模型 = 全库重算（§11.3 快照导出后重建），不是「就地补写」。
 *
 * ⚠️ **本函数与合并序列放在同一个文件**：§9.3.0.1 说「能改变 `embedding` 的代码路径唯一」。
 *   §4.9 步骤 2 的回填是那条路径上的一个例外分支（它只补空值、不覆盖），
 *   把它放在同一个文件里，静态扫描「`SET embedding` 只出现在 `store/merge.ts`」才成立。
 *
 * ⚠️ **阶段 1 不入桶**（ADR《P1 冲突裁决》冲突 7 的裁决）：
 *   §4.9 步骤 2 要求回填向量时同步桶归属（`assignBucket`），
 *   而桶归属是**阶段 2**（P2-T03 + 桶训练）的活 ⇒ 阶段 1 **只补 `memories.embedding`、不写桶**。
 *   ⇒ 阶段 2 必须补桶（启动对账 / 首次重训）。
 *
 * @param db 库句柄
 * @param memoryId 目标记忆 id
 * @param vector 本次写入使用的向量（`null` = 本次没有向量 ⇒ 不补写）
 * @returns 是否真的写了（供事件 payload 的 `embeddingAdded` 用 0/1）
 */
export function backfillEmbeddingIfMissing(
  db: Database.Database,
  memoryId: string,
  vector: Float32Array | null,
): boolean {
  if (vector === null) {
    return false;
  }
  const result = db
    .prepare('UPDATE memories SET embedding = @embedding WHERE id = @id AND embedding IS NULL')
    .run({ embedding: vectorToBlob(vector), id: memoryId });
  return result.changes > 0;
}

// ─────────────────────────── §4.9 步骤 3c：原子合并序列 ───────────────────────────

/**
 * `mergeMemory(store, m, input)` —— §4.9 步骤 3c 的**原子合并序列**。
 *
 * ⚠️ **七步的顺序不可换**（设计稿逐步给出伪代码）：
 *   ① 旧正文归档进 `content_history`（`reason='merge'`）——**唯一的版本兜底**，
 *      必须与下面的 UPDATE **同事务**（否则「归档成功但正文没换」⇒ 兜底失效且无从恢复）；
 *   ② 正文**无条件采纳新文本** + 重切 `content_tokens` + `content_hash = @newHash`；
 *   ③ `growStability` 加固（`useSpacing=false`）；
 *   ④ `last_access` / `access_count` 已由 ③ 一并更新，此处不再重复赋值；
 *   ⑤ 补充新实体到 `memory_entities`（与步骤 2 同一套算法）；
 *   ⑥ FTS 索引由触发器 `mem_au` 自动同步（**禁止 `DELETE FROM mem_fts`**）；
 *   ⑦ 记 `merge` 事件。
 *
 * ⚠️ **② 里 `embedding = @newVec`，没传就置 `NULL`**：
 *   **不保留旧向量**——旧向量描述的是旧正文，留着它等于造出一条
 *   「语义指向已不存在的内容」的记录：向量路会把它捞出来，正文却是另一句话，
 *   **不会报任何错**。置 `NULL` 的代价只是这条记忆暂时退出向量路
 *   （文本路与图谱路仍可召回），下次 write 带上向量时按步骤 2 的规则补回。
 *
 * ⚠️ **② 里不做长度比较**（ADR-9：「保留更长版本」的长度启发式已被废弃）：
 *   长度不是信息量的代理；且调用方是 LLM 抽提、提炼天然精简 ⇒ 长度规则会**稳定地**
 *   让旧版本获胜，再叠加每次合并都按 `DEDUP_BOOST` 加固 ⇒ **过期的正文越错越牢**。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器
 * @param m 被合并的旧记忆的当前状态
 * @param input 本次的新正文 / 新 hash / 新向量 / 实体 id 列表
 * @returns 合并结果（同时是 `merge` 事件 payload 的来源）
 */
export function mergeMemory(
  store: MergeStore,
  m: MergeMemoryState,
  input: MergeInput,
): MergeOutcome {
  const at = resolveNow(input.now);
  const db = store.db;

  // ── ① 归档旧正文 ──
  // ⚠️ **不写 `id` 列**：它是 `INTEGER PRIMARY KEY AUTOINCREMENT` ⇒ 手写值会与自增序列抢号，
  //   后续自增撞上历史手写值时直接 UNIQUE 报错（§4.9 步骤 3c ①）。
  db.prepare(
    `INSERT INTO content_history (memory_id, content, content_tokens, replaced_at, reason)
     VALUES (@memoryId, @content, @contentTokens, @now, 'merge')`,
  ).run({
    memoryId: m.id,
    content: m.content,
    contentTokens: m.content_tokens,
    now: at,
  });

  // ── ② 正文无条件采纳新文本（★ 全库唯一的 `UPDATE memories SET content`）──
  // ⚠️ **不重算 hash**：用步骤 2 算出的 `@newHash`（理由见 `MergeInput.contentHash`）。
  // ⚠️ **同时改 `content_tokens`** ⇒ 触发器 `mem_au` 才会同步 FTS 索引（步骤 ⑥）。
  // ⚠️ **阶段 1 不入桶**（ADR《P1 冲突裁决》冲突 7 的裁决）：
  //   §4.9 步骤 3c ② 要求「改了 embedding 就必须同步桶归属：同事务内调 `assignBucket(id, @newVec)`」，
  //   而 `assignBucket` / `unassignBucket` 属于**阶段 2**（P2-T03 + 桶训练）
  //   ⇒ 阶段 1 **只写 `memories.embedding`、不写桶**；
  //   ⇒ `unassignBucket` 在阶段 1 **不存在**，而阶段 1 库里**一条桶行都没有**
  //     ⇒ 无「桶归属被删除」这件事 ⇒ 无矛盾、无需补偿。
  //   ⇒ 阶段 2 必须补桶（启动对账 / 首次重训），并新增硬断言：
  //     「`embedding IS NOT NULL` 且 `deleted = 0` 的记忆 id 集合 == `vector_cell_members.memory_id` 集合」
  //     （**集合相等**，不是条数相等——§9.3.2 ③ 的三条判据）。
  db.prepare(
    `UPDATE memories
        SET content       = @content,
            content_tokens = @contentTokens,
            content_hash   = @contentHash,
            embedding      = @embedding
      WHERE id = @id`,
  ).run({
    content: input.content,
    contentTokens: tokenize(input.content),
    contentHash: input.contentHash,
    embedding: input.vector === null ? null : vectorToBlob(input.vector),
    id: m.id,
  });

  // ── ③ 稳定度加固（统一走 §4.2 的 `growStability`：守卫与上限都在里面）──
  // ⚠️ `useSpacing=false`：合并不是「间隔重复」，不该拿间隔加成。
  const growth = growStability(store, m, store.params.DEDUP_BOOST, false, at);

  // ── ⑤ 补充新实体（与步骤 2 同一套算法 ⇒ 两处不会漂移）──
  const addedEntities = computeAddedEntities(db, m.id, input.linkedEntityIds);
  linkEntities(db, m.id, addedEntities);

  // ── ⑥ FTS 索引由触发器 `mem_au` 自动同步（**禁止 `DELETE FROM mem_fts`**）──

  // ── ⑦ 记事件（§8.4 的 merge 行 / `merge_3c` 字段集）──
  const payload: MergeEventPayload3c = {
    targetId: m.id,
    intervalDays: growth.intervalDays,
    // ⚠️ **字段名是 `boostApplied`，取的是 `boosted`**（直接写 `boosted` 会得到一个不存在的键）。
    boostApplied: growth.boosted,
    contentText: input.content,
    contentLength: input.content.length,
    // ⚠️ 用步骤 2 的 hash，**不在这里重算**。
    contentHash: input.contentHash,
    prevContentLength: m.content.length,
    addedEntities,
    hasEmbedding: input.vector !== null,
    stabilityDelta: growth.stabilityDelta,
  };
  store.events.appendEvent('merge', m.id, payload, at);

  return {
    id: m.id,
    content: input.content,
    contentHash: input.contentHash,
    contentLength: input.content.length,
    prevContentLength: m.content.length,
    addedEntities,
    hasEmbedding: input.vector !== null,
    intervalDays: growth.intervalDays,
    boostApplied: growth.boosted,
    stabilityDelta: growth.stabilityDelta,
  };
}
