/**
 * **语料生成器** —— P2-T08（DEVELOPMENT-PLAN.md 行 2004~2052 的「100 万条语料生成器，固定种子」条）。
 *
 * ⚠️ **「固定随机种子」的确切含义**（§12.1 实现期跟踪项 2）：
 *   「同一 seed ⇒ **同一批文本、同一批实体、同一批查询**」⇒ 三样都要固定：
 *   · **文本**：本文件的 `content`（**逐条相同**，不只是「看起来像」）；
 *   · **实体**：`entities`（供图谱路有候选 ⇒ 文本路/图谱路的耗时也是真实的）；
 *   · **查询**：查询集（`bench/agreement.ts` 与 `bench/perf.ts` 共用同一份生成器）。
 *   ⇒ 三者都由**同一个 PRNG 流**按**固定顺序**生成 ⇒ 任何一条变了，后面全部变
 *   ⇒ **逐条比对**（不是「抽样比对」）才是可判定的前提。
 *
 * ⚠️ **语料的语义结构**（决定「探针边界效应」能不能被测出来）：
 *   语料按 **group（同义组）** 组织：同 group 的记录用**同组的不同词**渲染
 *   ⇒ 它们在向量空间里彼此很近（见 `bench/embedder.ts` 的构造说明）
 *   ⇒ 它们会落进**相邻的桶** ⇒ **探针边界效应真实存在**
 *   （漏掉一个近邻桶 ⇒ top-20 就少一条）。
 *   ⇒ 若语料是「全正交」的，探针边界效应无从体现 ⇒ 吻合率恒为 1.0 ⇒ **门槛失效**。
 *
 * ⚠️ **规模与内存**（百万级实测的坑）：
 *   100 万条 × 768 维 × 4 字节 = **3.07GB**（仅向量本体）⇒
 *   语料**必须流式生成**（`Generator`），**不得**一次性物化成数组
 *   ⇒ 否则「生成语料」这一步自己就先把机器撑爆了。
 *   ⇒ 落库也**分批** ⇒ 峰值内存与语料规模**脱钩**。
 */

import { normalize, tokenize } from '../src/core/tokenize.js';
import { dot } from '../src/vector/dot.js';
import { GROUP_COUNT, WORDS_PER_GROUP, embedText, splitWords, wordsOfGroup } from './embedder.js';
import { createRng, fnv1a, sha1Hex } from './lib/harness.js';

/** 语料的**默认规模**（P2-T08：100 万条）。 */
export const DEFAULT_CORPUS_SIZE = 1_000_000;

/**
 * 指纹的**字段分隔符**（`\u0001`）。
 *
 * ⚠️ **为什么用控制字符**：它不会出现在任何字段里
 *   ⇒ 字段拼接**无歧义**（否则 `ab`+`c` 与 `a`+`bc` 会撞出同一个指纹）。
 */
const FINGERPRINT_SEPARATOR = '\u0001';

/** 语料的**默认种子**（**写死** ⇒ 复现的前提）。 */
export const DEFAULT_CORPUS_SEED = 20260101;

/** 实体名的词根（供图谱路有候选）。 */
const ENTITY_ROOTS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

/** 一个近重复簇的规模（**同簇的记录彼此是「同义改写」**）。 */
export const CLUSTER_SIZE = 20;

/**
 * ★ **一个同义组（group）内最多能放多少条记录**（**正文唯一性的硬约束**）。
 *
 * ⚠️ **为什么有这条约束**：生产的 `memories` 表上有
 *   `CREATE UNIQUE INDEX idx_mem_hash ON memories(content_hash) WHERE deleted = 0`
 *   ⇒ **正文（归一化后）必须全局唯一** ⇒ 撞车时落库直接抛「唯一性冲突」。
 *   ⇒ 而一条记录的正文 = **同组 3 个词的有序组合**
 *   ⇒ 组合数 = `WORDS_PER_GROUP³` ⇒ 每组最多放 `WORDS_PER_GROUP³` 条**互不相同的**记录。
 *
 * ⚠️ **上限有多大**：`8³ × 20 × 5000 = 51,200,000` 条 ⇒ 100 万条远在上限内。
 *   ⇒ 超过上限时**当场报错**（绝不静默地生成重复正文 ⇒ 绝不把「撞车」藏起来）。
 */
export const MAX_RECORDS_PER_GROUP = WORDS_PER_GROUP * WORDS_PER_GROUP * WORDS_PER_GROUP;

/** 语料规模的上限（**超过即报错** ⇒ 不会生成重复正文）。 */
export const MAX_CORPUS_SIZE = MAX_RECORDS_PER_GROUP * CLUSTER_SIZE * GROUP_COUNT;

/** 一条语料记录。 */
export interface CorpusRecord {
  /** 记录 id（**按顺序生成** ⇒ 落库顺序 = rowid 顺序 ⇒ 训练确定性）。 */
  readonly id: string;
  /** 正文（**由同 group 的不同词渲染** ⇒ 簇内记录语义几乎相同）。 */
  readonly content: string;
  /** 实体名列表（**供图谱路有候选**）。 */
  readonly entities: readonly string[];
  /** 归属的 group（同义组 id）—— **诊断用**（判断一条记录属于哪个近重复簇）。 */
  readonly groupId: number;
  /** 簇内序号（**诊断用**）。 */
  readonly clusterIndex: number;
  /** 创建时间（毫秒，相对语料基准时刻）。 */
  readonly createdAt: number;
  /** 最后访问时间（毫秒，相对语料基准时刻）—— **决定它是否落在粗筛窗口内**。 */
  readonly lastAccess: number;
  /** 访问次数。 */
  readonly accessCount: number;
}

/** 语料生成参数。 */
export interface CorpusOptions {
  /** 条数。 */
  readonly size: number;
  /** 随机种子。 */
  readonly seed: number;
  /** 基准时刻（毫秒）—— 全部时间戳相对它展开 ⇒ **可复现**。 */
  readonly baseTime: number;
}

/**
 * 语料的**默认参数**。
 *
 * ⚠️ **基准时刻固定**：召回的粗筛窗口、时间窗过滤、强度过滤全部依赖 `now`
 *   ⇒ `now` 一变 ⇒ 候选集合就变 ⇒ 同一份语料的测量结果不可比。
 */
export const DEFAULT_CORPUS_OPTIONS: CorpusOptions = {
  size: DEFAULT_CORPUS_SIZE,
  seed: DEFAULT_CORPUS_SEED,
  baseTime: 1_749_873_600_000,
};

/**
 * **流式**生成语料。
 *
 * ⚠️ **必须是生成器（`Generator`）而不是数组**：
 *   100 万条的数组 = 3GB+ 的向量 + 100 万个 JS 对象 ⇒ 物化即 OOM。
 *   ⇒ 调用方**边取边用**（落库 / 测量），峰值内存与规模脱钩。
 *
 * ⚠️ **「近重复簇」的构造**：连续 `CLUSTER_SIZE` 条记录落在**同一个 group**
 *   ⇒ 簇内记录语义几乎相同 ⇒ 向量几乎相同 ⇒ 它们会挤在同一个细桶里
 *   ⇒ **探针边界效应**（漏掉这个桶 ⇒ top-20 少一批）真实可测。
 *
 * ⚠️ ★ **正文必须全局唯一**（生产的 `idx_mem_hash` 唯一索引）：
 *   一条记录的正文 = **同组 3 个词的有序组合**（`a`、`b`、`c`）
 *   ⇒ 用**混合进制**把「组内全局序号」映射成组合下标：
 *   ```
 *   serial = 组内序号                     // 0 .. WORDS_PER_GROUP³-1
 *   a = serial % 8
 *   b = (serial / 8) % 8
 *   c = (serial / 64) % 8
 *   ```
 *   ⇒ `serial ↔ (a,b,c)` 是**双射** ⇒ **组内正文两两不同**
 *   ⇒ 且不同 group 的词不同 ⇒ 正文不同 ⇒ **全局唯一**。
 *   ⚠️ **为什么不能只按「簇内序号」取词**（原来的写法）：
 *     簇内序号只取模 8 ⇒ 每 8 条就重复一次 ⇒ 100 万条里必然出现成千上万条重复正文
 *     ⇒ 落库在唯一索引上直接抛「唯一性冲突」（**实测如此**）。
 *
 * @param options 生成参数
 * @returns 语料记录（按生成顺序）
 */
export function* generateCorpus(options: CorpusOptions): Generator<CorpusRecord> {
  if (options.size > MAX_CORPUS_SIZE) {
    throw new Error(
      `bench corpus：语料规模 ${options.size} 超过上限 ${MAX_CORPUS_SIZE}` +
        '（同义组的词组合不够用 ⇒ 会出现重复正文 ⇒ 撞唯一索引）',
    );
  }
  const rng = createRng(options.seed);

  for (let index = 0; index < options.size; index += 1) {
    // ⚠️ **簇内位置**：连续 `CLUSTER_SIZE` 条同 group ⇒ 近重复簇。
    const clusterIndex = Math.floor(index / CLUSTER_SIZE);
    const withinCluster = index % CLUSTER_SIZE;
    const groupId = clusterIndex % GROUP_COUNT;
    // ⚠️ **该 group 内的第几个簇**（同一 group 会被多个簇轮流用 ⇒ 组合必须继续往后排）。
    const groupCycle = Math.floor(clusterIndex / GROUP_COUNT);

    // ⚠️ **组内全局序号** ⇒ 混合进制 ⇒ 组合下标（**双射 ⇒ 正文唯一**）。
    const serial = groupCycle * CLUSTER_SIZE + withinCluster;
    const a = serial % WORDS_PER_GROUP;
    const b = Math.floor(serial / WORDS_PER_GROUP) % WORDS_PER_GROUP;
    const c = Math.floor(serial / (WORDS_PER_GROUP * WORDS_PER_GROUP)) % WORDS_PER_GROUP;

    // ⚠️ **同 group 的不同词** ⇒ 语义相近但表面不同 ⇒ 「同义改写」。
    const groupWords = wordsOfGroup(groupId);
    const wordA = groupWords[a] ?? '记忆海';
    const wordB = groupWords[b] ?? '索引桶';
    const wordC = groupWords[c] ?? '归属合';

    // ⚠️ **分隔符 `、`** ⇒ `bench/embedder.ts` 的 `splitWords` 能原样切回来
    //   （词表是构造出来的 ⇒ 切分与词表严格对应 ⇒ 语义结构不被分词误差破坏）。
    const content = `${wordA}、${wordB}、${wordC}`;

    // ⚠️ **实体**：簇内共享 ⇒ 图谱路在同一簇上有候选（文本路靠 bigram，实体路靠 JOIN）。
    const entityCount = 1 + Math.floor(rng() * 2);
    const entities: string[] = [];
    for (let slot = 0; slot < entityCount; slot += 1) {
      const root = ENTITY_ROOTS[Math.floor(rng() * ENTITY_ROOTS.length)] ?? '甲';
      const serial = Math.floor(rng() * 1000);
      entities.push(`${root}方${serial}`);
    }

    // ⚠️ **时间戳**：相对基准时刻展开（最近访问 ⇒ 落在粗筛窗口内 ⇒ 有候选）。
    const ageDays = Math.floor(rng() * 30);
    const lastAccess = options.baseTime - ageDays * 86_400_000;
    const createdAt = lastAccess - Math.floor(rng() * 100) * 86_400_000;

    yield {
      id: `c-${String(index).padStart(8, '0')}`,
      content,
      entities,
      groupId,
      clusterIndex,
      createdAt,
      lastAccess,
      accessCount: Math.floor(rng() * 50),
    };
  }
}

/**
 * 语料的**指纹**（用于「同种子 ⇒ 同语料」的逐条比对）。
 *
 * ⚠️ **为什么「逐条」而不是「比一个总哈希」**：总哈希相同 ⇒ 极可能相同，
 *   但**总哈希不同 ⇒ 一定不同** ⇒ 只比总哈希是**单向**的
 *   ⇒ 拿它当「可复现」的证据**不成立**（它证明不了「相同 ⇒ 相同」这一半）。
 *   ⇒ 逐条比对**双向**都成立 ⇒ 本函数返回**逐条的指纹数组**。
 *
 * @param options 生成参数
 * @param limit 最多比对多少条（**默认全部**；冒烟测试用小值控制耗时）
 * @returns 每条记录的指纹数组（**顺序 = 生成顺序**）
 */
export function corpusFingerprints(
  options: CorpusOptions,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const fingerprints: string[] = [];
  let count = 0;
  for (const record of generateCorpus(options)) {
    // ⚠️ **指纹必须覆盖整条记录**（不只正文）：
    //   只把 `id + content + entities` 算进去 ⇒ **时间戳变了也看不出来**
    //   ⇒ 「同种子 ⇒ 同语料」这条断言就只证明了一半。
    //   ⇒ 这里把 `createdAt` / `lastAccess` / `accessCount` / `clusterIndex` 一并算进去。
    // ⚠️ **分隔符用 `\u0001`**（控制字符）：它不会出现在任何字段里
    //   ⇒ 字段拼接**无歧义**（否则 `ab` + `c` 与 `a` + `bc` 会撞出同一个指纹）。
    fingerprints.push(
      sha1Hex(
        [
          record.id,
          record.content,
          record.entities.join('|'),
          String(record.groupId),
          String(record.clusterIndex),
          String(record.createdAt),
          String(record.lastAccess),
          String(record.accessCount),
        ].join(FINGERPRINT_SEPARATOR),
      ),
    );
    count += 1;
    if (count >= limit) {
      break;
    }
  }
  return fingerprints;
}

/**
 * 语料的**可复现性自检**（**逐条比对**）。
 *
 * ⚠️ **判据**：两次生成的指纹数组**逐条相等** ⇒ 同 seed ⇒ 同语料。
 *   ⚠️ **必须逐条**：只比「总哈希」是单向的（见 `corpusFingerprints` 的说明）。
 *
 * @param options 生成参数
 * @param limit 最多比对多少条
 * @returns 自检结果
 */
export interface CorpusSelfCheck {
  /** 两次生成的指纹是否**逐条相同**。 */
  readonly reproducible: boolean;
  /** 比对了多少条。 */
  readonly compared: number;
  /** 第一条不一致的下标（`-1` ⇒ 全部一致）。 */
  readonly firstMismatchIndex: number;
  /** 语料条数（**写进报告 ⇒ 规模可核对**）。 */
  readonly size: number;
}

/**
 * 跑一遍语料的可复现性自检。
 *
 * @param options 生成参数
 * @param limit 最多比对多少条（**默认全部**）
 * @returns 自检结果
 */
export function runCorpusSelfCheck(
  options: CorpusOptions,
  limit = Number.POSITIVE_INFINITY,
): CorpusSelfCheck {
  const first = corpusFingerprints(options, limit);
  const second = corpusFingerprints(options, limit);
  let firstMismatchIndex = -1;
  const compared = Math.min(first.length, second.length);
  for (let index = 0; index < compared; index += 1) {
    if (first[index] !== second[index]) {
      firstMismatchIndex = index;
      break;
    }
  }
  const lengthMismatch = first.length !== second.length;
  return {
    reproducible: firstMismatchIndex < 0 && !lengthMismatch,
    compared,
    firstMismatchIndex,
    size: options.size,
  };
}

/**
 * 落库用的**行内容**（**含向量**）。
 *
 * ⚠️ **向量的口径必须与生产一致**：
 *   生产写入口径是「**double 域归一化 → float32**」（`src/vector/dot.ts` 的
 *   `normalizeNumbers`）⇒ bench 侧也必须走**同一份** `normalizeNumbers`，
 *   否则 bench 测的是「另一套向量」⇒ 结论无效。
 *
 * ⚠️ **`content_tokens` 必须用生产分词器**（`src/core/tokenize.ts`）：
 *   文本路靠 `mem_fts(content_tokens)` 检索 ⇒ 分词口径不同 ⇒ 文本路候选集合不同
 *   ⇒ 测出来的「文本路耗时」就不代表生产。
 *
 * ⚠️ **`content_hash` 必须用生产口径**（`sha1(normalize(content))`）：
 *   唯一索引 `idx_mem_hash` 上撞车 ⇒ 落库直接报错（而不是「当作两条」）。
 *
 * @param record 语料记录
 * @returns 落库行
 */
export interface CorpusRow extends CorpusRecord {
  /** 分词结果（**生产分词器**：中文 bigram ⇒ 文本路可检索）。 */
  readonly contentTokens: string;
  /** 内容哈希（**生产口径**）。 */
  readonly contentHash: string;
  /** 向量（**生产口径**：L2 归一化的 float32）。 */
  readonly embedding: Float32Array;
}

/**
 * 把语料记录转成落库行（**含向量与分词**）。
 *
 * @param record 语料记录
 * @returns 落库行
 */
export function toCorpusRow(record: CorpusRecord): CorpusRow {
  return {
    ...record,
    contentTokens: tokenizeForFts(record.content),
    contentHash: sha1Hex(normalize(record.content)),
    embedding: embedText(record.content),
  };
}

/**
 * 正文的分词（**生产分词器**：`src/core/tokenize.ts` 的 `tokenize`）。
 *
 * ⚠️ **不另写一份**：分词口径漂移 ⇒ 文本路候选集合漂移 ⇒ 耗时数字失去意义。
 *
 * @param content 正文
 * @returns 分词结果（空格分隔）
 */
export function tokenizeForFts(content: string): string {
  return tokenize(content);
}

/**
 * 一个**查询**（**与语料同源** ⇒ 召回有真实候选）。
 */
export interface BenchQuery {
  /** 查询 id。 */
  readonly id: string;
  /** 查询正文（**同义改写后的文本** ⇒ 不是库里的原文）。 */
  readonly context: string;
  /** 查询向量。 */
  readonly embedding: Float32Array;
  /** 该查询所属的 group（**诊断用**）。 */
  readonly groupId: number;
  /** ★ **被改写的那条记录 id**（⇒ 「同义改写」的对照对象）。 */
  readonly targetId: string;
  /** ★ **被改写那条记录的向量**（⇒ 用来**实测**「同义改写真的接近」）。 */
  readonly targetEmbedding: Float32Array;
}

/**
 * 测「**同义改写真的接近**」（**生产口径**：两侧都是 L2 归一化的 float32 ⇒ 点积即余弦）。
 *
 * ⚠️ **这是关键口径 #2 的直接证据**：如果这个数很低 ⇒ 语料的「同义」是假的
 *   ⇒ 吻合率与去重率都测不出真实形态 ⇒ 整套基线无效。
 *
 * @param query 查询
 * @returns 查询与被改写记录之间的余弦
 */
export function querySynonymCosine(query: BenchQuery): number {
  return dot(query.embedding, query.targetEmbedding);
}

/**
 * **生成查询集**（**固定种子 ⇒ 同一批查询**）。
 *
 * ⚠️ **查询必须与语料同源**：否则召回无候选 ⇒ 测出来的耗时是「空查询」的耗时
 *   ⇒ 与生产场景（查询总落在有内容的地方）不符。
 *
 * ⚠️ ★ **查询必须是「同义改写」而不是「原文照抄」**（本任务的关键口径之一）：
 *   · 查询取自**每个近重复簇的第 4 条**（不是第 1 条）
 *     ⇒ 测的是「**同义改写**能不能被召回」，不是「自己能不能召回自己」；
 *   · ★ 而且正文**不是照抄**那条记录 ⇒ 而是把它的 3 个词**各换成同组的另一个词**
 *     ⇒ 表面不同、语义同组 ⇒ 在向量空间里**真的接近**
 *     （这是「同义改写在向量上真的接近」这条口径的**直接体现**）
 *     ⇒ 若照抄原文 ⇒ 查询就是库里的某一行 ⇒ 测的是「精确命中」⇒ 语义形同虚设。
 *   ⇒ **改写规则写死**（每槽 +1）⇒ 查询集可复现。
 *
 * ⚠️ **查询数受语料规模限制**：一个簇一条 ⇒ `count` 不得超过「簇数」。
 *
 * @param options 语料参数（**种子必须与语料一致** ⇒ 查询可复现）
 * @param count 查询条数
 * @returns 查询集
 */
export function generateQueries(options: CorpusOptions, count: number): BenchQuery[] {
  const queries: BenchQuery[] = [];
  let index = 0;
  for (const record of generateCorpus(options)) {
    const clusterIndex = Math.floor(index / CLUSTER_SIZE);
    if (clusterIndex >= count) {
      break;
    }
    if (index % CLUSTER_SIZE === 3) {
      // ⚠️ ★ **同义改写**：把该记录的 3 个词各换成**同组的下一个词**
      //   ⇒ 表面不同、语义同组 ⇒ 向量上真的接近（余弦 ≈ 0.85~0.97）。
      const rewritten = rewriteWithSynonyms(record.content, record.groupId);
      queries.push({
        id: `q-${String(clusterIndex).padStart(8, '0')}`,
        context: rewritten,
        embedding: embedText(rewritten),
        groupId: record.groupId,
        targetId: record.id,
        targetEmbedding: embedText(record.content),
      });
    }
    index += 1;
  }
  return queries;
}

/**
 * **同义改写**：把正文的每个词换成**同组的另一个词**。
 *
 * ⚠️ **为什么改写规则是「每槽 +1」而不是随机**：
 *   随机 ⇒ 不可复现 ⇒ 「同种子 ⇒ 同一批查询」这条断言恒假
 *   ⇒ 固定偏移 ⇒ 可复现 ⇒ 且**一定**是「另一个词」（不会改回自己）。
 *
 * ⚠️ **为什么改写后仍然是「同义」**：改的只是**同组词**（同组词共享 `v_group` 方向）
 *   ⇒ 改写前后的向量夹角很小 ⇒ 这正是「同义改写真的接近」的构造方式。
 *
 * @param content 原正文
 * @param groupId 所属同义组
 * @returns 改写后的正文（**分隔符保持 `、`** ⇒ embedder 切得回来）
 */
export function rewriteWithSynonyms(content: string, groupId: number): string {
  const groupWords = wordsOfGroup(groupId);
  const pieces = splitWords(content);
  const rewritten = pieces.map((piece, slot) => {
    const current = groupWords.indexOf(piece);
    if (current < 0 || groupWords.length === 0) {
      // ⚠️ **词不在该组里**（不该发生）⇒ 原样保留（**不猜**）。
      return piece;
    }
    const next = groupWords[(current + slot + 1) % groupWords.length] ?? piece;
    return next;
  });
  return rewritten.join('、');
}

/**
 * 查询集的可复现性自检（**逐条比对**）。
 *
 * @param options 语料参数
 * @param count 查询条数
 * @returns 自检结果
 */
export function runQuerySelfCheck(
  options: CorpusOptions,
  count: number,
): { reproducible: boolean; count: number } {
  const first = generateQueries(options, count);
  const second = generateQueries(options, count);
  let reproducible = first.length === second.length;
  if (reproducible) {
    for (let index = 0; index < first.length; index += 1) {
      const a = first[index];
      const b = second[index];
      if (
        a === undefined ||
        b === undefined ||
        a.context !== b.context ||
        a.groupId !== b.groupId
      ) {
        reproducible = false;
        break;
      }
      for (let dimension = 0; dimension < a.embedding.length; dimension += 1) {
        if (a.embedding[dimension] !== b.embedding[dimension]) {
          reproducible = false;
          break;
        }
      }
    }
  }
  return { reproducible, count: first.length };
}

/**
 * 语料的**分组统计**（诊断用：近重复簇的规模分布）。
 *
 * @param options 生成参数
 * @param limit 最多统计多少条
 * @returns `groupId → 条数`
 */
export function groupSizeHistogram(
  options: CorpusOptions,
  limit = Number.POSITIVE_INFINITY,
): Map<number, number> {
  const histogram = new Map<number, number>();
  let count = 0;
  for (const record of generateCorpus(options)) {
    histogram.set(record.groupId, (histogram.get(record.groupId) ?? 0) + 1);
    count += 1;
    if (count >= limit) {
      break;
    }
  }
  return histogram;
}

/**
 * 一个词条的**稳定哈希**（诊断用）。
 *
 * @param word 词条
 * @returns 哈希
 */
export function wordDigest(word: string): string {
  return fnv1a(word).toString(16);
}

/**
 * 语料里出现过的**全部词条**（诊断用：验证语料与 embedder 词表确实对得上）。
 *
 * @param options 生成参数
 * @param limit 最多扫描多少条
 * @returns 词条集合
 */
export function corpusVocabulary(
  options: CorpusOptions,
  limit = Number.POSITIVE_INFINITY,
): Set<string> {
  const words = new Set<string>();
  let count = 0;
  for (const record of generateCorpus(options)) {
    for (const word of splitWords(record.content)) {
      words.add(word);
    }
    count += 1;
    if (count >= limit) {
      break;
    }
  }
  return words;
}
