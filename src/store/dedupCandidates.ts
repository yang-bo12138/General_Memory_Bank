/**
 * 写入路径的**去重候选收集** —— DESIGN-v2.md §4.9 步骤 3a（文本路）/ 步骤 3a2（向量路），
 * 对应 DEVELOPMENT-PLAN.md **P2-T07**。
 *
 * ⚠️ **本模块只管「取候选」，不管「判合并」**：
 *   取候选 = 步骤 3a / 3a2；判合并 = 步骤 3b（算两个证据）与步骤 3c（原子合并，
 *   在 `src/store/merge.ts`）⇒ 三件事各有各的地盘（§14.3 边界原则 1）。
 *
 * ⚠️ ★★ **写入路径的去重是「两层架构」（v2.1 裁决）**：
 *   · **实时层**（**本模块**）：两级分桶近似 ⇒ 命中即合并。
 *     **便宜、快、但不完备**（真近重复的命中率 ≈ **40%**，漏检 ≈ 60%）。
 *   · **宿主调度层**：由**调用方在自己的进程 / 线程里**周期性做
 *     **分片 flat 全量近重复扫描**（**不限时间窗**），补上实时层漏掉的那 ~60%。
 *     ⚠️ **库内没有定时器、没有后台线程**（ADR-5 全同步）
 *       ⇒ **这段扫描不是库的能力，调度归宿主**（ADR-5 的适用范围注记）。
 *     ⇒ 命中后走**与实时层完全相同的合并路径**（§4.9 步骤 3c）
 *       —— 同一事务、同一 payload、同一个 `merge` 事件
 *       —— 即 `src/store/merge.ts` 的 `mergeMemory()`（**全库唯一的合并写入点**）。
 *     ⚠️ **宿主必须携带「本次写入的原始文本」**：步骤 3c 的规则是「无条件采纳新文本」
 *       （ADR-9），而扫描拿到的是**库里的旧正文** ⇒ 直接走 3c 会把库里的**新正文顶掉**。
 *       ⇒ 宿主要把**原始文本**带进来，走同一条 3c 路径。
 *   ⇒ **代价（明写）**：实时层漏掉的近重复**会在库里停留一个宿主扫描周期**
 *     ⇒ 这是「快 vs 全」的取舍，**不是缺陷**。
 *
 * ⚠️ ★★ **「粗桶命中」≠「细桶命中」**（设计稿原文在这里写了「必定」，
 *   **那是未证断言，默认参数下就是错的** —— 本模块**不得**依赖它）：
 *   · 粗层：真近重复的粗桶大概率为第 1 ⇒ 粗层覆盖远高于 4%（4% 是对**随机对**的数字）；
 *   · 细层：被探到的粗桶下约 50 个细桶，探针 20 ⇒ **20/50 = 40%**。
 *   ⇒ **真近重复的命中率 ≈ 40%，漏检 ≈ 60%** ⇒ 由宿主调度层补齐。
 *
 * ⚠️ **刻意不加 `@coarseCutoff` 时间窗**（§4.9 步骤 3a2 的原文）：
 *   重复项完全可能是**半年前**写的那条 ⇒ 加了窗口就等于「只和最近用过的记忆去重」
 *   ⇒ **这正是老库越用越脏的成因**。
 *   ⇒ **不加时间窗 ≠ 不加空间窗**：分桶收窄的是**空间**（几何邻近），
 *     不影响「半年前写的那条」是否进候选。
 *
 * ⚠️ **为什么必须有向量路**（§4.9 步骤 3a2 的原文）：
 *   文本路候选靠 **bigram** ⇒ 而**同义改写恰恰没有共享 bigram**
 *   （「她不吃猫粮」vs「她对猫粮过敏」）⇒ FTS 一条都找不到 ⇒ 去重直接失效。
 *
 * ⚠️ **桶表名不外泄**（§4.6 步骤 2c 的硬边界）：
 *   本模块**不写**任何桶表 SQL（连读也不写）⇒ 桶成员由
 *   `src/vector/ivf.ts` 的 `scanBucketCandidates()` 取 ⇒
 *   「桶归属的唯一写入点」（§9.3.0）与「桶表名只在向量层」（§4.6 步骤 2c）两条都成立。
 *
 * ⚠️ **写入专用探针数是**既有参数**（§5）**：`ROUTER_NPROBE_WRITE_COARSE`（8）
 *   与 `ROUTER_NPROBE_WRITE_FINE`（20）⇒ **本模块不新增任何参数**。
 *
 * ⚠️ **写入路径用主题簇是无效的**（ADR-26）：新记忆从未被 touch 过、不属于任何主题簇
 *   ⇒ 主题簇路由救不了写入路径 ⇒ **不要**为此加「只扫最近 N 条」的参数
 *   （那会让老重复项永远查不出来，且没有任何信号告诉调用方漏了）。
 */

import type Database from 'better-sqlite3';

import type { Params } from '../core/params.js';
import { clampCos } from '../core/scoring.js';
import { escapeFts5, tokenize } from '../core/tokenize.js';
import type { BucketAssignContext } from '../vector/bucketAssign.js';
import { blobToVector } from '../vector/centroids.js';
import { type BucketCandidateRow, scanBucketCandidates } from '../vector/ivf.js';
import type { MergeMemoryState } from './merge.js';

// ─────────────────────────── 类型 ───────────────────────────

/** 候选的来源路由。 */
export type DedupCandidateSource = 'text' | 'vector';

/**
 * 一条去重候选（文本路 ∪ 向量路，**按 id 去重**）。
 *
 * ⚠️ **继承 `MergeMemoryState`**（`src/store/merge.ts`）：
 *   候选一旦被选中就要**原样**交给 §4.9 步骤 3c 的合并序列
 *   ⇒ 候选的形状必须**就是**合并序列要的形状（少一个字段就要在这里补一次查询）。
 */
export interface DedupCandidate extends MergeMemoryState {
  /**
   * 本次向量与该候选向量的余弦（`null` = 本次没有向量，或候选没有向量 / 维度对不上）。
   *
   * ⚠️ **退化态下这个值仍然要算**：「cos 通道不生效」说的是**合并资格**，
   *   不是**排序**（§4.9 步骤 3a 的裁决 D-4：tie-break 里的 `cos 降序` 照常执行）。
   */
  cos: number | null;
  /**
   * FTS 的 BM25 原始分（**只有文本路有**；向量路没有 ⇒ `null`）。
   *
   * ⚠️ **`null` 在排序里记作 `+Infinity`**（= 「没有 BM25 ⇒ 排在同分候选的最后」）
   *   ⇒ 这是**有限值**（不是 `NaN`）⇒ `compareMergeCandidates` 的
   *     「先判是否相等再算差值」写法不会算出 `NaN`。
   */
  rawBm25: number | null;
  /** 命中这条候选的路由（一条候选可能**两路都**命中）。 */
  sources: readonly DedupCandidateSource[];
}

/** 候选收集所需的上下文（库句柄 + 生效参数 + 桶归属上下文）。 */
export interface DedupCandidateContext {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（探针数 / 阈值 / `VECTOR_TOPK` 都从这里取 ⇒ **不写死数字**）。 */
  params: Params;
  /**
   * 桶归属上下文（§9.3.0 的唯一写入点所在的那个上下文）。
   *
   * ⚠️ **只借它的「读」能力**（中心模型 + 库句柄）⇒ 本模块**不写**桶表。
   */
  buckets: BucketAssignContext;
}

/** 一次候选收集的产物（候选集 + 两条路的诊断量）。 */
export interface DedupCandidateSet {
  /** 候选（文本路 ∪ 向量路，按 id 去重）。 */
  candidates: DedupCandidate[];
  /**
   * **文本路是否处于「退化态」**（新文本切出的 bigram 数 < 2）。
   *
   * ⚠️ **退化态 ⇒ 「cos 通道整条不生效」**（§4.9 步骤 3a 的裁决 D-6）：
   *   退化态下合并资格**只看实体重叠**。
   *   ⚠️ **这条判定是全局的**（不分路由）：判定式写的是「合并 ⟺ entityOverlap ≥
   *     `DEDUP_ENTITY_MIN`」，没有「只对文本路」的限定词
   *     ⇒ 向量路候选在退化态下**同样**不能只凭余弦合并。
   */
  textRouteDegenerate: boolean;
  /**
   * **向量路的扫描量**（= 命中桶里被扫过的候选行数）。
   *
   * ⚠️ **这才是「候选 ≤ 2000」要断言的量**（不是 `candidates.length`）：
   *   返回给判定的候选还要再过 `cos ≥ DEDUP_COS_MIN` 与 `VECTOR_TOPK` 两道闸
   *   ⇒ 扫描量才是**写路径要付的代价**（§4.9 步骤 3a2：「候选扫描量 ≈ 2000 条」）。
   *   ⇒ 本次没有向量时恒为 0。
   */
  vectorScanned: number;
  /** 向量路命中的细桶 id（诊断用；没有向量时为空数组）。 */
  vectorFineIds: string[];
}

// ─────────────────────────── SQL ───────────────────────────

/**
 * 相似候选的检索（§4.9 步骤 3a，**文本路**）。
 *
 * ⚠️ **`ORDER BY bm25(mem_fts) ASC` 必须显式写出**：不写的话 SQLite 按 rowid 顺序返回
 *   ⇒ 取到的是**最早写入的 3 条**而不是**最相似的 3 条** ⇒ 去重判据整个失灵。
 *
 * ⚠️ **只取前 3 条**：候选面越大，误合并的风险越高（§4.9 的代价段）。
 */
const FIND_TEXT_CANDIDATES_SQL = `
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
 * 文本路去重查询串（§4.9 步骤 3a）。
 *
 * ⚠️ **必须显式构造，绝不复用 `buildMatchQuery`**（§10.2 的原文）：
 *   `buildMatchQuery` 内部会**再 tokenize 一次** ⇒ 把已切好的 bigram 串传进去是「二次分词」
 *   ⇒ 对 2 字 token 恰好幂等、对其它长度会切出意外 token ⇒ 去重条件变成不可预测的东西。
 *
 * @param content 新正文
 * @returns 查询串；**空串** = 压根没有候选面（连候选都不取，§4.9 步骤 3a 的 n=0 分支）
 */
export function buildDedupMatchSql(content: string): string {
  const tokens = tokenize(content).split(' ').filter(Boolean);
  return tokens.slice(0, 3).map(escapeFts5).join(' AND ');
}

// ─────────────────────────── 纯计算 ───────────────────────────

/**
 * 两个向量的余弦；长度不一致 / 缺向量 / 零向量 ⇒ `null`（§4.9 步骤 3b）。
 *
 * ⚠️ **维度不同 ⇒ `null`，不是 0**：维度不同意味着两侧**不在同一个 embedding 空间**
 *   ⇒ 余弦没有意义 ⇒ 记成 0 会让「不相似的证据」看起来像「没证据」。
 *
 * ⚠️ **这是「余弦」的唯一实现**（文本路与向量路共用 ⇒ 两条路的 `cos` 可比，C36）。
 */
export function cosineOf(a: Float32Array | null, b: Float32Array | null): number | null {
  if (a === null || b === null) {
    return null;
  }
  if (a.length !== b.length || a.length === 0) {
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
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // ⚠️ **钳制进 [0, 1]**（与向量层的 `clampCos` 同一口径）：
  //   浮点误差可能算出 1.0000001 ⇒ 不钳制的话它会「大于」任何 < 1 的阈值 ⇒ 比较不稳。
  return clampCos(cosine);
}

// ─────────────────────────── 两条路的候选收集 ───────────────────────────

/**
 * 文本路候选（§4.9 步骤 3a）。
 *
 * ⚠️ **只在「有候选面」时调用**（新文本切出的 bigram 数 ≥ 1）：
 *   n = 0 ⇒ **文本路整体不执行**（连候选都不取 ⇒ 直接判「不合并」）
 *   —— 这**不是**「退化态」：退化态是「有候选、但候选面不可信」（n = 1）。
 *
 * @param db 库句柄
 * @param dedupSql 去重查询串（`buildDedupMatchSql()` 的产物）
 * @returns 候选（按 BM25 升序 ⇒ 最相似的在前）
 */
export function collectTextCandidates(db: Database.Database, dedupSql: string): DedupCandidate[] {
  if (dedupSql.length === 0) {
    return [];
  }
  const rows = db.prepare(FIND_TEXT_CANDIDATES_SQL).all({ dedupSql }) as Array<{
    id: string;
    content: string;
    content_tokens: string;
    stability: number;
    last_access: number;
    access_count: number;
    difficulty: number;
    embedding: Buffer | null;
    raw_bm25: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    content_tokens: row.content_tokens,
    stability: row.stability,
    last_access: row.last_access,
    access_count: row.access_count,
    difficulty: row.difficulty,
    embedding: row.embedding,
    cos: null,
    rawBm25: row.raw_bm25,
    sources: ['text'],
  }));
}

/** 向量路一次收集的产物（候选 + 诊断量）。 */
export interface VectorCandidateResult {
  /** 向量路候选（已按 `cos` 降序取前 `VECTOR_TOPK` 条）。 */
  candidates: DedupCandidate[];
  /** **被扫描的候选行数**（= 命中桶里的候选行总数）。 */
  scanned: number;
  /** 命中的细桶 id。 */
  fineIds: string[];
}

/**
 * 向量路候选（§4.9 步骤 3a2）。
 *
 * ⚠️ **两级分桶收窄**（与 §4.6 步骤 0 同一套桶，但用**写入专用探针数**）：
 *   `@writeHitCells = 两级路由(@newVec, ROUTER_NPROBE_WRITE_COARSE(8), ROUTER_NPROBE_WRITE_FINE(20))`
 *   ⇒ 命中 20 个细桶 ⇒ 扫描量 ≈ **20 × 每桶成员数 = 2000 条**（顶格）。
 *   ⇒ **不做全表扫**（v1.0 的 `WHERE deleted = 0 AND embedding IS NOT NULL` 无 LIMIT
 *     ⇒ 100 万条下每次 write 付 500~1500ms ⇒ **写路径比读路径更致命**）。
 *
 * ⚠️ **逐条算 cos ⇒ 取 `cos ≥ DEDUP_COS_MIN` 的按 cos 降序前 `VECTOR_TOPK` 条**
 *   （§4.9 步骤 3a2 ② 的原文）⇒ 返回的候选**至多 `VECTOR_TOPK` 条**。
 *
 * ⚠️ **分桶尚未训练 ⇒ 候选为空**（不是抛错、也不是静默回落 flat）：
 *   §4.15.3：「模型为空 ⇒ 向量路整体缺席」⇒ 写入路径退回纯文本路
 *   （**不是降级报错**，§4.9 步骤 3a2 的原文）。
 *
 * @param context 上下文（库句柄 + 参数 + 桶归属上下文）
 * @param vector 本次写入使用的向量（**已 L2 归一化**）
 * @returns 候选 + 扫描量 + 命中桶
 */
export function collectVectorCandidates(
  context: DedupCandidateContext,
  vector: Float32Array,
): VectorCandidateResult {
  const { db, params } = context;
  // ⚠️ **中心模型只从库里读**（`buckets.centroids()` ⇒ 走 `CentroidCache` 的真实加载路径）
  //   ⇒ 重训之后必须让缓存失效（那是 `MemoryStore` 的责任，§4.15.5）。
  const model = context.buckets.centroids();
  const scan = scanBucketCandidates(
    db,
    model,
    vector,
    params.ROUTER_NPROBE_WRITE_COARSE,
    params.ROUTER_NPROBE_WRITE_FINE,
  );
  if (scan.rows.length === 0) {
    return { candidates: [], scanned: scan.scanned, fineIds: scan.fineIds };
  }

  // ⚠️ **逐条算 cos**：候选的向量在这里被解出来、算完就丢
  //   ⇒ 峰值内存只与「最终入选的候选数」成正比，而不是与「扫描量」成正比。
  const scored: Array<{ row: BucketCandidateRow; cos: number }> = [];
  for (const row of scan.rows) {
    // ⚠️ **逐条解码**（不一次性全解）⇒ 峰值内存只与「一条向量」成正比。
    const cos = cosineOf(vector, blobToVector(row.embedding));
    if (cos === null) {
      // ⚠️ **维度对不上 ⇒ 没有证据**（不是「不相似的证据」）。
      continue;
    }
    if (cos < params.DEDUP_COS_MIN) {
      continue;
    }
    scored.push({ row, cos });
  }

  // ⚠️ **排序必须定死次序**：相似度降序；同分时 **id 升序**
  //   （浮点同分是常态 ⇒ 不定次 ⇒ 同一批数据两次写入可能合并到不同的记忆）。
  scored.sort((left, right) => {
    if (left.cos !== right.cos) {
      return right.cos - left.cos;
    }
    if (left.row.id === right.row.id) {
      return 0;
    }
    return left.row.id < right.row.id ? -1 : 1;
  });

  const candidates = scored.slice(0, params.VECTOR_TOPK).map(({ row, cos }) => ({
    id: row.id,
    content: row.content,
    content_tokens: row.content_tokens,
    stability: row.stability,
    last_access: row.last_access,
    access_count: row.access_count,
    difficulty: row.difficulty,
    // ⚠️ **保留真实的 embedding BLOB**（不是 `null`）：
    //   候选一旦被选中就要**原样**交给 §4.9 步骤 3c 的合并序列 ⇒ 形状必须是真的。
    embedding: row.embedding,
    cos,
    rawBm25: null,
    sources: ['vector'] as const,
  }));

  return { candidates, scanned: scan.scanned, fineIds: scan.fineIds };
}

/**
 * 候选收集（文本路 ∪ 向量路，按 id 去重）—— §4.9 步骤 3a + 3a2。
 *
 * ⚠️ **两条路是独立的**：
 *   · 文本路要「新文本切得出 bigram」（n = 0 ⇒ 整条路不执行）；
 *   · 向量路要「本次有 `@newVec`」（没有 ⇒ 整条路跳过，**不是降级报错**）。
 *   ⇒ 两条路的缺席**互不影响** ⇒ 退化态（n = 1）**不**妨碍向量路取候选
 *     （只是退化态下 cos 通道不参与**合并资格**，见 `DedupCandidateSet.textRouteDegenerate`）。
 *
 * ⚠️ **按 id 去重时保留两条路的证据**：
 *   同一条候选被两路命中 ⇒ 合并成**一条**候选，`sources` 记两条
 *   ⇒ 而 **BM25 保留文本路那个**（向量路没有 BM25 ⇒ `null` 不该覆盖真值）。
 *
 * @param context 上下文
 * @param input 本次写入的新正文与向量（`vector = null` ⇒ 无向量路）
 * @returns 候选集 + 退化态标志 + 向量路的诊断量
 */
export function collectDedupCandidates(
  context: DedupCandidateContext,
  input: { content: string; vector: Float32Array | null },
): DedupCandidateSet {
  const { db } = context;
  const dedupSql = buildDedupMatchSql(input.content);
  const tokens = tokenize(input.content).split(' ').filter(Boolean);

  const byId = new Map<string, DedupCandidate>();

  // ── 文本路（§4.9 步骤 3a）──
  // ⚠️ **n = 0 ⇒ 文本路整体不执行**（连候选都不取 ⇒ 直接判「不合并」）。
  if (tokens.length > 0) {
    for (const candidate of collectTextCandidates(db, dedupSql)) {
      byId.set(candidate.id, candidate);
    }
  }

  // ── 向量路（§4.9 步骤 3a2）──
  // ⚠️ **没有 `@newVec` ⇒ 整条路跳过**（回到纯文本路的行为，**不是降级报错**）。
  let vectorScanned = 0;
  let vectorFineIds: string[] = [];
  if (input.vector !== null) {
    const result = collectVectorCandidates(context, input.vector);
    vectorScanned = result.scanned;
    vectorFineIds = result.fineIds;
    for (const candidate of result.candidates) {
      const existing = byId.get(candidate.id);
      if (existing === undefined) {
        byId.set(candidate.id, { ...candidate, cos: candidate.cos });
        continue;
      }
      // ⚠️ **两路都命中 ⇒ 合并成一条**（按 id 去重，§4.9 步骤 3b）。
      //   BM25 **保留文本路那个**（向量路的 `rawBm25` 是 `null` ⇒ 不能覆盖真值）。
      byId.set(candidate.id, {
        ...existing,
        cos: existing.cos ?? candidate.cos,
        sources: [...existing.sources, ...candidate.sources],
      });
    }
  }

  // ⚠️ **文本路候选的 cos 在这里补算**（向量路候选的 cos 在收集时就算掉了）：
  //   两条路**共用同一个 `cosineOf`** ⇒ 两条路的 `cos` 可比（C36）。
  const candidates = [...byId.values()].map((candidate) => {
    if (candidate.cos !== null || input.vector === null) {
      return candidate;
    }
    return {
      ...candidate,
      cos: cosineOf(
        input.vector,
        candidate.embedding === null ? null : blobToVector(candidate.embedding),
      ),
    };
  });

  return {
    candidates,
    // ⚠️ **退化态 = bigram 数 < 2**（§4.9 步骤 3a 的裁决 D-6）：
    //   n = 0 是「压根没有候选面」（不是退化态）；n = 1 才是退化态。
    textRouteDegenerate: tokens.length < 2,
    vectorScanned,
    vectorFineIds,
  };
}
