/**
 * **固定 embedder** —— P2-T08（DEVELOPMENT-PLAN.md 行 2004~2052 的「固定 embedder」条）。
 *
 * ⚠️ **为什么不用真实 embedding 模型**：
 *   ① **不可复现**：真实模型的输出随模型版本 / 批切分 / 浮点并行序变化
 *      ⇒ 「同一 seed ⇒ 同一批向量」这条前提**当场失效** ⇒ P99 门槛不可判定
 *      （§12.1 实现期跟踪项 2：「两者任一不固定，P99 门槛就不可判定」）；
 *   ② **要网络、要 GPU** ⇒ 百万级语料的向量化不可控；
 *   ③ **测的不是模型** ⇒ P99 测的是「语料 + 模型 + 机器」的**组合**，
 *      而本任务要的是**代码**的开销（分桶扫描量、点积次数、桶大小分布）。
 *   ⇒ 故本文件实现一个**合成的确定性 embedder**：语义结构由**词表层级**显式构造。
 *
 * ⚠️ ★ **它必须让「同义改写」在向量上真的接近**（否则吻合率与去重率都测不出真实形态）：
 *   本 embedder 的向量 = **层级方向向量之和**：
 *   ```
 *   dir(word) = normalize( 0.78·v_group + 0.30·v_sub + 0.12·v_comm + 0.25·v_lex )
 *   vec(doc)  = normalize( Σ_{word ∈ doc} dir(word) )
 *   ```
 *   其中 `v_group` 是「**同组词**共享的方向」——
 *   ⇒ **同组的不同词彼此就是「同义改写」**（换词不改义）⇒ 它们的向量夹角很小；
 *   ⇒ 而**跨组**的向量近乎正交（768 维随机方向）⇒ 语义距离清晰。
 *   ⇒ 这让「同义改写 ⇒ 余弦 ≈ 0.9」成为**构造出来的性质**（而不是碰巧）。
 *
 * ⚠️ ★ **它能测出什么 / 测不出什么**（报告必须写清这一条）：
 *   · **能测**：分桶几何（探针覆盖、桶大小分布）、扫描量、点积次数、
 *     P99 延迟、训练期峰值内存、**探针边界造成的漏召**（吻合率）；
 *     以及**去重路径**在「近重复语料」上的真实命中率。
 *   · **测不出**：真实模型的**语义质量**（本 embedder 的「同义」是**人工构造**的）；
 *     真实中文长文本的**分布漂移**；**跨语言**；以及真实模型在
 *     `DEDUP_COS_MIN`(0.92) 附近的**真实判定分布**。
 *   ⇒ 本 bench 的结论**只在「本语料 + 本 embedder」这个域内成立** ⇒ 报告必须带域标注。
 *
 * ⚠️ **维度必须是 `EMBED_DIM`**（768）：向量层的写入口径会校验维度
 *   （`src/vector/dot.ts` 的 `assertValidEmbedding`）⇒ 维度写错 ⇒ 落库直接抛错。
 *   ⇒ 从 `src/core/params.js` 取（**唯一出处**，不在这里写死 768）。
 *
 * ⚠️ **性能纪律（百万级实测的坑）**：
 *   · 词 → 概念的映射**必须 O(1)**（`Map`）⇒ 否则每条语料扫一遍 4 万词表
 *     ⇒ 100 万条 = 400 亿次查表 ⇒ 跑不动；
 *   · 「group → 词」的索引**必须预建**（不能每次现扫词表）⇒ 同上；
 *   · 向量累加**必须复用一块 scratch 缓冲**（模块级）⇒ 否则每条语料分配
 *     768 个 double ⇒ 100 万条 = 6 GB 的分配抖动 ⇒ GC 变成主要耗时；
 *   · 方向向量**按需缓存且只读**（`DirectionCache`）⇒ 总量 ≈ 6300 个方向
 *     ≈ 19MB（不是 4 万个方向 ⇒ 123MB）。
 */

import { DEFAULT_PARAMS } from '../src/core/params.js';
import { normalizeNumbers } from '../src/vector/dot.js';
import { fnv1a } from './lib/harness.js';

/** 向量维度（**唯一出处**：`src/core/params.ts` 的 `EMBED_DIM`，只读参数）。 */
export const EMBED_DIM = DEFAULT_PARAMS.EMBED_DIM;

/** 词的字符表（**确定性**，用于构造词条）。 */
const CHARS =
  '记忆海索引桶归属合并衰减召回向量相似聚类候选粗筛精筛归档备份迁移调度权限加密压缩分片队列令牌会话配置路由限流采样回放快照副本集群节点容器镜像标签阈值排序打分融合探测训练维度矩阵点积归一距离哈希校验重复改写近义写入读取更新删除查询分母口径断言契约账本台账谱面';

/**
 * ★ **字符表必须去重**（这是「词表注入」的前提）。
 *
 * ⚠️ **为什么必须去重**：`CHARS` 里有**重复的字**（128 个位置、115 个不同的字）
 *   ⇒ 若直接用 `CHARS[i]` 造词，**不同的下标会造出同一个词**
 *   ⇒ `byWord` 这个 Map 会被后来的 group **覆盖**掉 ⇒
 *   **「同组词共享同一方向」这条性质被破坏**（词被别的 group 抢走了）
 *   ⇒ 「同义改写真的接近」这条**关键口径**就塌了。
 *   ⇒ 实测：不去重时 49,640 个词只落进 40,115 个不同的 key（**9,525 次撞车**）。
 *   ⇒ 去重后下标 ↔ 字**一一对应** ⇒ 下标三元组 ↔ 词**一一对应** ⇒ 词表注入。
 */
const ALPHABET: readonly string[] = [...new Set(CHARS)];

/** 字符表大小（**去重后** ⇒ 造词空间 = `ALPHABET_SIZE³`）。 */
const ALPHABET_SIZE = ALPHABET.length;

/** 每个 community 下的 sub 簇数。 */
const SUBCLUSTERS_PER_COMMUNITY = 5;

/** 每个 sub 簇下的 group 数（**一个 group = 一组「同义改写」**）。 */
const GROUPS_PER_SUBCLUSTER = 5;

/** 每个 group 拥有的词数（**同义改写时换的就是它们**）。 */
export const WORDS_PER_GROUP = 8;

/** 每个 sub 簇额外拥有的词数（跨 group 的弱关联）。 */
const WORDS_PER_SUBCLUSTER = 8;

/** 每个 community 额外拥有的词数（更弱的关联）。 */
const WORDS_PER_COMMUNITY = 8;

/** 通用词数（所有记录都可能用到的「泛用词」，极少用）。 */
const GENERIC_WORDS = 40;

/** 词级「词汇噪声」方向的数量（哈希到这么多槽 ⇒ 词与词之间有弱随机偏移）。 */
const LEXICAL_SLOTS = 4096;

/** 层级方向权（**写死在此 ⇒ 全局唯一出处**）。 */
const WEIGHT_GROUP = 0.78;
const WEIGHT_SUBCLUSTER = 0.3;
const WEIGHT_COMMUNITY = 0.12;
const WEIGHT_LEXICAL = 0.25;

/** 最大的 group 数（**1 万条语料下每 group 约 2 条；100 万条下每 group 100 条**）。 */
export const GROUP_COUNT = 5000;

/** 一个词的层级归属。 */
interface WordEntry {
  /** 所属 group（**同义改写的判定依据**）。 */
  readonly group: number;
  /** 所属 sub 簇。 */
  readonly subcluster: number;
  /** 所属 community。 */
  readonly community: number;
}

/**
 * 词表条数（**写死的期望值** ⇒ 词表被改动时能看出来）。
 *
 * ⚠️ **它是「期望值」而不是「由词表长度派生」**：派生 ⇒ 词表被改 ⇒ 断言恒过 ⇒ 假绿。
 */
export const EXPECTED_VOCABULARY_SIZE =
  GROUP_COUNT * WORDS_PER_GROUP +
  (GROUP_COUNT / GROUPS_PER_SUBCLUSTER) * WORDS_PER_SUBCLUSTER +
  (GROUP_COUNT / GROUPS_PER_SUBCLUSTER / SUBCLUSTERS_PER_COMMUNITY) * WORDS_PER_COMMUNITY +
  GENERIC_WORDS;

/**
 * 构造词表 + **group → 词**索引。
 *
 * ⚠️ **词条用「三个字符」拼成**（从**去重后**的字符表里取）⇒ 词形天然不重复
 *   （下标三元组在 `ALPHABET_SIZE³` 种组合里取前 N 个 ⇒ 互不相同）
 *   ⇒ 且**不使用随机数** ⇒ 词表在任何机器上都一样。
 *
 * ⚠️ **group → 词 的索引必须一次建好**（不能每次调用现扫词表）
 *   ⇒ 否则 100 万条语料 = 100 万 × 4 万次查表 ⇒ 跑不动。
 *
 * ⚠️ ★ **构造完必须核对条数**（`byWord.size` 必须 == `EXPECTED_VOCABULARY_SIZE`）：
 *   词表一旦撞车（同一个词被两个 group 抢），**「同组词共享方向」这条性质就没了**
 *   ⇒ 「同义改写真的接近」这条**关键口径**会静悄悄地塌掉
 *   ⇒ 撞车是**必须当场炸掉**的错误（不是 warning）⇒ 这里直接抛。
 */
function buildVocabulary(): {
  byWord: Map<string, WordEntry>;
  byGroup: Map<number, string[]>;
} {
  const byWord = new Map<string, WordEntry>();
  const byGroup = new Map<number, string[]>();
  let next = 0;

  const makeWord = (): string => {
    const a = next % ALPHABET_SIZE;
    const b = Math.floor(next / ALPHABET_SIZE) % ALPHABET_SIZE;
    const c = Math.floor(next / (ALPHABET_SIZE * ALPHABET_SIZE)) % ALPHABET_SIZE;
    next += 1;
    return `${ALPHABET[a] ?? '记'}${ALPHABET[b] ?? '忆'}${ALPHABET[c] ?? '海'}`;
  };

  // ── group 词（**同义改写的核心**：同组词共享 `v_group`）──
  for (let group = 0; group < GROUP_COUNT; group += 1) {
    const subcluster = Math.floor(group / GROUPS_PER_SUBCLUSTER);
    const community = Math.floor(subcluster / SUBCLUSTERS_PER_COMMUNITY);
    const words: string[] = [];
    for (let index = 0; index < WORDS_PER_GROUP; index += 1) {
      const word = makeWord();
      byWord.set(word, { group, subcluster, community });
      words.push(word);
    }
    byGroup.set(group, words);
  }

  // ── sub 簇词（**跨 group 的弱关联**）──
  const subclusterCount = GROUP_COUNT / GROUPS_PER_SUBCLUSTER;
  for (let subcluster = 0; subcluster < subclusterCount; subcluster += 1) {
    const community = Math.floor(subcluster / SUBCLUSTERS_PER_COMMUNITY);
    for (let index = 0; index < WORDS_PER_SUBCLUSTER; index += 1) {
      byWord.set(makeWord(), { group: -1, subcluster, community });
    }
  }

  // ── community 词（**更弱的关联**）──
  const communityCount = subclusterCount / SUBCLUSTERS_PER_COMMUNITY;
  for (let community = 0; community < communityCount; community += 1) {
    for (let index = 0; index < WORDS_PER_COMMUNITY; index += 1) {
      byWord.set(makeWord(), { group: -1, subcluster: -1, community });
    }
  }

  // ── 通用词（**不属于任何层级** ⇒ 只有词汇噪声）──
  for (let index = 0; index < GENERIC_WORDS; index += 1) {
    byWord.set(makeWord(), { group: -1, subcluster: -1, community: -1 });
  }

  // ⚠️ ★ **词表注入性自检**（当场炸，不给「静悄悄地塌掉」留机会）。
  if (byWord.size !== EXPECTED_VOCABULARY_SIZE) {
    throw new Error(
      `bench embedder：词表撞车 ⇒ 生成 ${EXPECTED_VOCABULARY_SIZE} 个词只落进 ${byWord.size} 个不同的 key` +
        `（字符表 ${ALPHABET_SIZE} 个不同的字）⇒「同组词共享方向」已失效 ⇒ 立即失败`,
    );
  }

  return { byWord, byGroup };
}

/** 词表（**模块加载时构建一次** ⇒ 全进程唯一）。 */
const VOCABULARY = buildVocabulary();

/**
 * 取某个 group 的**全部词**（**同义改写的素材**：同组词彼此等价）。
 *
 * ⚠️ **语料生成器与 embedder 必须共用这份词表** ⇒ 否则「同义改写」在向量上就不接近
 *   ⇒ 吻合率与去重率都测不出真实形态（见文件头的说明）。
 *
 * @param group group id
 * @returns 该 group 的词（**顺序固定** ⇒ 可复现）
 */
export function wordsOfGroup(group: number): string[] {
  return VOCABULARY.byGroup.get(group) ?? [];
}

// ═══════════════════════════════ 层级方向向量 ═══════════════════════════════

/**
 * 一个「伪随机单位方向」的缓存。
 *
 * ⚠️ **必须是单位向量**：否则「两个不同概念的方向夹角」会随权重漂移
 *   ⇒ 余弦分布不可控 ⇒ 语料的相似度谱系（近重复 / 弱关联 / 正交）就失真了。
 *
 * ⚠️ **返回的是共享缓冲（只读）**：调用方**只许读**、不许改
 *   ⇒ 省掉每次 768 个 float 的拷贝（百万级下这是主要分配开销）。
 */
class DirectionCache {
  /** 缓存：`key → 方向向量`（**只读共享**）。 */
  private readonly cache = new Map<number, Float32Array>();

  /**
   * 取一个方向（**共享缓冲，只读**）。
   *
   * @param key 方向键（`0x1000_0000 | index` ⇒ 与其它层不撞）
   * @param seed 方向种子（**与 key 绑定** ⇒ 同 key 恒同方向）
   * @returns 单位方向向量（Float32）
   */
  get(key: number, seed: number): Float32Array {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const direction = unitDirection(seed);
    this.cache.set(key, direction);
    return direction;
  }
}

/** 层级方向缓存（**全进程唯一** ⇒ 同一 group 恒同方向）。 */
const DIRECTIONS = new DirectionCache();

/** 方向键的命名空间（**各层不撞**）。 */
const NAMESPACE_GROUP = 0x1000_0000;
const NAMESPACE_SUBCLUSTER = 0x2000_0000;
const NAMESPACE_COMMUNITY = 0x3000_0000;
const NAMESPACE_LEXICAL = 0x4000_0000;

/**
 * 造一个确定性的**单位**方向向量。
 *
 * ⚠️ **为什么要「单位」**：两个不同概念的方向若长度不同，
 *   「点积 / 模长乘积」的分布就与权重耦合 ⇒ 余弦谱系不可控。
 *   ⇒ 归一化后，余弦 ≈ 「共享的层级权重之和 / 全部权重之和」⇒ **可解释、可预测**。
 *
 * @param seed 种子
 * @returns 单位方向（Float32）
 */
function unitDirection(seed: number): Float32Array {
  const raw = new Float32Array(EMBED_DIM);
  let state = (seed ^ 0x9e3779b9) >>> 0;
  for (let index = 0; index < EMBED_DIM; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    raw[index] = state / 0x100000000 - 0.5;
  }
  return normalizeNumbers(Array.from(raw));
}

// ═══════════════════════════════ 分词与向量化 ═══════════════════════════════

/**
 * 把正文切成**词条**（按分隔符 `、` / 逗号 / 空白）。
 *
 * ⚠️ **为什么用显式分隔符而不是中文分词**：本 embedder 的词表是**构造出来的**
 *   （每词三字）⇒ 用分隔符切分 ⇒ **切分结果与词表**严格对应
 *   ⇒ 「同义改写 = 同组不同词」这条性质**不会**被分词误差破坏。
 *   ⚠️ 真实中文没有这种分隔 ⇒ 这是**合成语料**的自觉取舍（报告里写明）。
 *
 * @param text 正文
 * @returns 词条数组（保持出现顺序 ⇒ 顺序影响不了向量 ⇒ 改写只换词不改序）
 */
export function splitWords(text: string): string[] {
  return text
    .split(/[、,，。;；\s]+/u)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * 向量累加用的 **scratch 缓冲**（模块级 ⇒ 复用 ⇒ 零分配）。
 *
 * ⚠️ **为什么是模块级**：每条语料新分配 768 个 double ⇒ 100 万条 = 6GB 分配抖动
 *   ⇒ GC 成为主要耗时（实测：分配量比计算量大两个数量级）。
 *   ⇒ bench 是**单线程、无重入**的 ⇒ 复用安全。
 */
const SCRATCH = new Float64Array(EMBED_DIM);

/**
 * 把正文向量化（**同步、确定性**）。
 *
 * ⚠️ **必须 L2 归一化**：本库的向量路假定「余弦 = 点积」
 *   （`src/vector/dot.ts` 的 `normalize`）⇒ 未归一化的向量会让所有余弦失去可比性。
 *
 * @param text 正文
 * @returns 单位向量（Float32，长度 = `EMBED_DIM`）
 */
export function embedText(text: string): Float32Array {
  SCRATCH.fill(0);
  let touched = false;

  for (const word of splitWords(text)) {
    const entry = VOCABULARY.byWord.get(word);
    if (entry !== undefined) {
      if (entry.group >= 0) {
        accumulate(
          DIRECTIONS.get(NAMESPACE_GROUP | entry.group, (NAMESPACE_GROUP ^ entry.group) >>> 0),
          WEIGHT_GROUP,
        );
      }
      if (entry.subcluster >= 0) {
        accumulate(
          DIRECTIONS.get(
            NAMESPACE_SUBCLUSTER | entry.subcluster,
            (NAMESPACE_SUBCLUSTER ^ entry.subcluster) >>> 0,
          ),
          WEIGHT_SUBCLUSTER,
        );
      }
      if (entry.community >= 0) {
        accumulate(
          DIRECTIONS.get(
            NAMESPACE_COMMUNITY | entry.community,
            (NAMESPACE_COMMUNITY ^ entry.community) >>> 0,
          ),
          WEIGHT_COMMUNITY,
        );
      }
    }
    const lexicalIndex = fnv1a(word) % LEXICAL_SLOTS;
    accumulate(
      DIRECTIONS.get(
        NAMESPACE_LEXICAL | lexicalIndex,
        (NAMESPACE_LEXICAL ^ lexicalIndex ^ 0x5bf03635) >>> 0,
      ),
      WEIGHT_LEXICAL,
    );
    touched = true;
  }

  if (!touched) {
    // ⚠️ **空正文 / 全是未知词**：给一个**确定的**非零向量（否则归一化会抛「零向量」）。
    //   ⇒ 仍然确定性（同一输入恒同输出）⇒ 确定性断言照样成立。
    SCRATCH[0] = 1;
  }
  // ⚠️ **归一化走生产那一份**（`src/vector/dot.ts` 的 `normalizeNumbers`）
  //   ⇒ bench 与生产**同一套归一化口径**（double 域归一化 → float32）。
  return normalizeNumbers(Array.from(SCRATCH));
}

/**
 * 把一个方向按权重累加进 scratch 缓冲。
 *
 * @param direction 方向（**只读**）
 * @param weight 权重
 */
function accumulate(direction: Float32Array, weight: number): void {
  for (let index = 0; index < EMBED_DIM; index += 1) {
    SCRATCH[index] = (SCRATCH[index] ?? 0) + weight * (direction[index] ?? 0);
  }
}

// ═══════════════════════════════ 自检（可被 bench 脚本与冒烟测试共用） ═══════════════════════════════

/**
 * embedder 的**自检结果**。
 */
export interface EmbedderSelfCheck {
  /** 同一输入两次调用的结果是否**逐位相同**。 */
  readonly deterministic: boolean;
  /** 词表条数（**写死的期望值** ⇒ 词表被改动时能看出来）。 */
  readonly vocabularySize: number;
  /** 同 group 两个不同词的余弦（**「同义改写真的接近」的构造证据**）。 */
  readonly synonymCosine: number;
  /** 跨 group 两个词的余弦（**「无关概念真的远」的构造证据**）。 */
  readonly unrelatedCosine: number;
}

/**
 * 算两个正文的余弦（**生产口径**：两侧都是 L2 归一化的 float32 ⇒ 点积即余弦）。
 *
 * @param left 左正文
 * @param right 右正文
 * @returns 余弦
 */
export function cosineOfTexts(left: string, right: string): number {
  const a = embedText(left);
  const b = embedText(right);
  let sum = 0;
  for (let index = 0; index < EMBED_DIM; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

/**
 * 跑一遍 embedder 的自检（**确定性 + 「同义改写真的接近」**）。
 *
 * ⚠️ **为什么这两条都要测**：
 *   · 「确定性」⇒ 缺了它，P99 的前提（同 seed ⇒ 同向量）就没了；
 *   · 「同义改写真的接近」⇒ 缺了它，**吻合率与去重率都测不出真实形态**
 *     （全语料近乎正交 ⇒ 探针边界效应无从体现 ⇒ 吻合率恒等于 1.0 ⇒ 门槛无意义）。
 *
 * @returns 自检结果
 */
export function runEmbedderSelfCheck(): EmbedderSelfCheck {
  const sample = '记忆海索引桶、向量检索召回、归档备份迁移';
  const first = embedText(sample);
  const second = embedText(sample);
  let deterministic = true;
  for (let index = 0; index < EMBED_DIM; index += 1) {
    if (first[index] !== second[index]) {
      deterministic = false;
      break;
    }
  }

  // ⚠️ **同 group 两词**（**从词表本身取，不另造数据**）。
  const groupZero = wordsOfGroup(0);
  const groupOne = wordsOfGroup(1);
  const synonymA = groupZero[0] ?? '记忆海';
  const synonymB = groupZero[1] ?? '记忆索';

  return {
    deterministic,
    vocabularySize: VOCABULARY.byWord.size,
    synonymCosine: cosineOfTexts(synonymA, synonymB),
    unrelatedCosine: cosineOfTexts(groupZero[0] ?? synonymA, groupOne[0] ?? synonymB),
  };
}
