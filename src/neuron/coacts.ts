/**
 * 共激活写入 —— DESIGN-v2.md §4.11.2（写入时机与两个建边机制）/ §4.11.4（强化公式），
 * 对应 DEVELOPMENT-PLAN.md **P3-T01**。
 *
 * ★ **全库唯一的 `coacts` 写入点**（§4.11.2：「**唯一写入源：touch()**」）：
 *   · `recall()` **绝不**写（ADR-19：召回参与共激活 ⇒ topN 自我强化 ⇒ 库锁死在早期话题上）；
 *   · `write()` **绝不**写（§4.11.2：「**第三种写入源明确不实现**」——一条 write 只产生一条记忆，
 *     不产生配对）。
 *   ⇒ 调用方只经 `src/store/touch.ts` 进来 ⇒ **本模块的 `INSERT INTO coacts` 是全库唯一一处**
 *     （`tests/unit/coact-guard.test.ts` 的静态扫描就指着这一处）。
 *
 * ★ **两个建边机制（§4.11.2）**：
 *   · **机制 A（批内自动）**：同一批 `touch(ids)` 内，任意两条满足 §4.11.4 ① 的证据门槛
 *     （共享实体数达标 **或** 余弦达标）即建边，**不需要调用方声明**。
 *     ⇒ **作用域天然是批内**（跨批次的关联只能由机制 B 声明）。
 *   · **机制 B（显式声明）**：`options.coActivateWith`。
 *     ⚠️ **种子必须由调用方声明，库不能自己推断**：台账是**推测**——调用方可能从别处拿到 B
 *     （比如从它自己的历史里），恰好后来 touch 了它 ⇒ 库就会把一个**从未发生的因果关系**
 *     记成事实 ⇒ **因果判断归调用方**（与 ADR-2「实体抽取归调用方」/ ADR-10「向量由调用方提供」
 *     同构）⇒ 库只做归一与存储。
 *     ⇒ ⚠️ **库内部不维护任何跨调用的状态**（无 ledger、无 LRU、无「最近一次召回」缓存）
 *     ——这是硬约束，见本文件末尾的「为什么本模块没有缓存」。
 *
 * ★ **base 的合成规则（§4.11.4 ②，只施加一次）**：
 *   ```
 *   base = COACT_REINFORCE_STEP（默认 0.20）
 *        + (机制 B 的因果增量被授予 ? COACT_CAUSAL_BONUS（默认 0.25） : 0)
 *   ```
 *   ⚠️ **机制 A / B 同时命中时只施加一次 base，不是两次**（那会重复计入 0.20）。
 *   ⚠️ **也不是「取 max」**：「共享实体 / 余弦达标」与「调用方声明 A 唤起了 B」是**两个独立事实**，
 *     取 max 会丢掉一个（尤其会丢掉因果加成，那正是「证据更强」的情形）。
 *
 * ★ **强化公式（§4.11.4）**：
 *   ```
 *   Δ            = base × (1 - affinity_old / COACT_AFFINITY_MAX)   ← 饱和阻尼
 *   affinity_new = min(COACT_AFFINITY_MAX, affinity_old + Δ)        ← ★ 钳制位置
 *   coact_count += 1
 *   last_active  = now
 *   ```
 *   ⚠️ **`affinity_old` = 该对上一次增量时写入的存储值**（**不是**衰减后的有效值）：
 *     阻尼要表达「离上限还有多远」，而**存储值单调不减**；若拿衰减后的有效值当 `affinity_old`，
 *     一条三个月没共现的 pair（有效值已衰减到 0.02）会拿到**几乎全额的 base 增量**
 *     ⇒「很久没联系了 ⇒ 重新联系给满权重」，与饱和阻尼的设计意图**相反**。
 *     ⇒ **增量用存储值，衰减只作用于读路径**。
 *
 * ★ **幂等分支（§4.11.4 ③，任何模型下都必须存在）**：
 *   这一对**已在 `coacts` 表中** ⇒ **只 UPDATE**（强化 `affinity` / `coact_count` / `last_active` /
 *   按位或上 `cause_flags`），**不 INSERT**。
 *   ⚠️ `coacts` 有 `UNIQUE idx_coacts_pair (memory_a, memory_b)` + `CHECK (memory_a < memory_b)`
 *   ⇒ **一对有且只有一行** ⇒ 不走这个分支，第二次 touch 同一对时裸 `INSERT` 会撞 UNIQUE，
 *     原始 `SQLITE_CONSTRAINT` 会**穿给调用方**（违反 §11.2「客户端只看到规范化的错误结构」）。
 *   ⚠️ 它是 **UPSERT 的另一半**，不是「建立条件」——把两者混在一起正是当初让两边读出相反答案的根源。
 */

import type Database from 'better-sqlite3';

import { MS_PER_DAY } from '../core/decay.js';
import { MemoryError } from '../core/errors.js';
import type { ActivationWrite, CoactPair, CoactSkipped } from '../core/events.types.js';
import { resolveFlags } from '../core/flags.js';
import type { Params } from '../core/params.js';
import { cosineOf } from '../store/dedupCandidates.js';
import { blobToVector } from '../vector/centroids.js';

/**
 * 机制 A 的 `cause_flags` 位（bit0，值 1）。
 *
 * ⚠️ **位掩码不是枚举**（§3 的 `coacts` 表注释）：`3` = 「两者都建过」——
 *   枚举表达不了「两者都建过」这个状态。
 */
export const CAUSE_FLAG_MECHANISM_A = 1;

/** 机制 B 的 `cause_flags` 位（bit1，值 2）。 */
export const CAUSE_FLAG_MECHANISM_B = 2;

/**
 * 同日守卫的窗口：**24 小时**（毫秒）。
 *
 * ⚠️ **按「(记忆对, 证据来源)」分别计数**（§4.11.4 的 v2.1 裁决）：
 *   · 机制 A 的**基础增量**（「被一起用过」这一类证据）：同一对 24h 内至多记一次；
 *   · 机制 B 的**因果增量**（「谁唤起了谁」这一类证据）：同一对 24h 内至多记一次；
 *   · **两者互不豁免** ⇒「A 建边 + 当天 B 声明」能同时拿到两条证据。
 *
 * ⚠️ **为什么是 24h 而不是「同一天」**：守卫针对的是「**同类证据的重复**」，
 *   而「同一天」是日历口径（跨零点就翻篇）⇒ 一个 23:59 与 00:01 的重复会被放过。
 *   ⇒ 这里取**滚动 24 小时窗口**（`now - last_active < 24h` 即「还在窗口内」）。
 *
 * ⚠️ **它就是一个 `MS_PER_DAY`**（一天 = 24 小时）——
 *   ⚠️ **不要写成 `24 * MS_PER_DAY`**：那是 **24 天**，
 *   而守卫一旦放宽到 24 天，「24h 内至多记一次」这条裁决就形同虚设
 *   （「昨天的共现今天再共现」也会被吞 ⇒ 机制 B 的因果加成在**最常见的场景**下系统性丢失）。
 */
export const COACT_SAME_DAY_WINDOW_MS = MS_PER_DAY;

/**
 * 调用方对「谁唤起了谁」的**显式声明**（机制 B，§4.11.2）。
 *
 * ⚠️ **这是调用方的断言，不是库的观测**——库没有观测能力（ADR-31）：
 *   `coacts` 表记录的是【调用方声明的关联】，不是【库观测到的关联】。
 */
export interface CoactivationDeclaration {
  /** 本次被采纳的记忆（**必须是 `ids` 的成员**，否则 `INVALID_INPUT`）。 */
  memoryId: string;
  /**
   * 唤起它的那条（或那些）记忆——**由调用方声明**。
   *
   * ⚠️ **不得包含它自己那条的 `memoryId`**（自共激活 ⇒ `INVALID_INPUT`）；
   *   ⚠️ **允许**与 `ids` 的其他成员相交（「A 唤起 B，A 与 B 也一并被采纳」完全合法）。
   */
  seedIds: string[];
  /** 唤起时刻（缺省 = 本次 touch 的 `now`）。 */
  activatedAt?: number;
}

/** 共激活写入所需的上下文（库句柄 + 生效参数）。 */
export interface CoactStore {
  db: Database.Database;
  params: Params;
}

/** 一次共激活写入的入参。 */
export interface CoactWriteInput {
  /** 本次 touch 的记忆 id（**已去重、已校验存在且未软删**）。 */
  ids: readonly string[];
  /** 调用方的显式声明（机制 B）；`undefined` = 没有机制 B。 */
  declarations: readonly CoactivationDeclaration[] | undefined;
  /** 本次 touch 的时间戳（毫秒）。 */
  now: number;
}

/** 一次共激活写入的结果（同时是 §6 `TouchResult` 的数据源）。 */
export interface CoactWriteResult {
  /** 实际写入的共激活对数。 */
  accepted: number;
  /** 因 `COACT_MAX_PAIRS_PER_TOUCH` 上界被截断的对数。 */
  truncated: number;
  /** 因种子无效 / 已软删被跳过的对数。 */
  skippedInvalidSeed: number;
  /** 本次写入的对（事件 `coactPairs`）。 */
  pairs: CoactPair[];
  /** 本次的因果写入（事件 `activationWrites`）。 */
  activationWrites: ActivationWrite[];
  /** 因守卫或种子无效而未写入的关联（事件 `coactSkipped`）。 */
  skipped: CoactSkipped[];
}

/** `coactSkipped` 的 `reason` 取值。 */
export const COACT_SKIP_REASONS = {
  /** 种子不存在或已软删（§4.11.2 的弱校验③：**不抛错**）。 */
  invalidSeed: 'invalid_seed',
  /** 被 24h 同日守卫挡下（§4.11.4 的 v2.1 裁决）。 */
  sameDayGuard: 'same_day_guard',
} as const;

/** 一次增量计算的结果（纯计算，可被单测直接守住）。 */
export interface CoactIncrement {
  /** 实际增量 `Δ`。 */
  delta: number;
  /** 写入前的存储值（**不是**衰减后的有效值）。 */
  affinityOld: number;
  /** 写入后的存储值（已钳到 `COACT_AFFINITY_MAX`）。 */
  affinityNew: number;
}

/**
 * 饱和阻尼下的增量计算（§4.11.4 的公式，**纯函数**）。
 *
 * ⚠️ **`affinityOld` 必须是存储值**（上一次增量时写进去的那个数），
 *   **不是**衰减后的有效值——理由见文件头的说明。
 * ⚠️ **钳制在这里发生**（`min(MAX, …)`）：§3 的 CHECK 写死 `affinity <= 1.0`，
 *   而 `COACT_AFFINITY_MAX` **可被调低** ⇒ 不钳就会撞库层约束。
 *   ⚠️ **被钳后本次的实际增量不再等于 base**（可能是 0）⇒
 *   凡是断言「n 次后 affinity 等于某值」的用例，必须先声明 base 恒定且 MAX 足够大。
 *
 * @param affinityOld 该对上一次增量时写入的**存储值**（无历史行时传 0）
 * @param base 本次的 base（已按 §4.11.4 ② 合成好：基础增量 +（因果增量））
 * @param max `COACT_AFFINITY_MAX`
 * @returns 增量与钳制后的新值
 */
export function computeCoactIncrement(
  affinityOld: number,
  base: number,
  max: number,
): CoactIncrement {
  const delta = base * (1 - affinityOld / max);
  const affinityNew = Math.min(max, affinityOld + delta);
  return { delta, affinityOld, affinityNew };
}

/** 一对记忆（已按 `a < b` 归一）。 */
export interface NormalizedPair {
  /** 字典序小的那个。 */
  a: string;
  /** 字典序大的那个。 */
  b: string;
}

/**
 * 同源归一（§4.11.2 / §4.11.4 的「同源归一」条）。
 *
 * ⚠️ **归一后取字典序小的那个作为 `memory_a`**（与 `a < b` 归一规则一致）——
 *   `coacts` 表有 `CHECK (memory_a < memory_b)` ⇒ 不归一会**撞约束**。
 *   ⇒ `(b, a)` 与 `(a, b)` 必须落到**同一行**。
 */
export function normalizePair(x: string, y: string): NormalizedPair {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

/** 一批记忆的「证据面」（一次性取回，避免 O(n²) 次查询）。 */
export interface BatchFacts {
  /** 记忆 id ⇒ 它挂着的实体 id 集合。 */
  entities: Map<string, Set<string>>;
  /** 记忆 id ⇒ 它的向量（**没有向量时该键不存在**）。 */
  embeddings: Map<string, Float32Array>;
}

/** 读一批记忆的实体关联与向量（**一次查询一批**，不在两两比较时反复查库）。 */
function loadBatchFacts(db: Database.Database, ids: readonly string[]): BatchFacts {
  const entities = new Map<string, Set<string>>();
  const embeddings = new Map<string, Float32Array>();
  if (ids.length === 0) {
    return { entities, embeddings };
  }

  const placeholders = ids.map((_, index) => `@id${index}`).join(', ');
  const bindings: Record<string, string> = {};
  ids.forEach((id, index) => {
    bindings[`id${index}`] = id;
  });

  const entityRows = db
    .prepare(
      `SELECT memory_id, entity_id FROM memory_entities WHERE memory_id IN (${placeholders})`,
    )
    .all(bindings) as Array<{ memory_id: string; entity_id: string }>;
  for (const row of entityRows) {
    let bucket = entities.get(row.memory_id);
    if (bucket === undefined) {
      bucket = new Set<string>();
      entities.set(row.memory_id, bucket);
    }
    bucket.add(row.entity_id);
  }

  // ⚠️ **只取有向量的行**：没有向量的记忆**照样能靠实体建边**（§4.11.4 ① 的两条路径各自独立成立）
  const vectorRows = db
    .prepare(
      `SELECT id, embedding FROM memories WHERE id IN (${placeholders}) AND embedding IS NOT NULL`,
    )
    .all(bindings) as Array<{ id: string; embedding: Buffer }>;
  for (const row of vectorRows) {
    embeddings.set(row.id, blobToVector(row.embedding));
  }

  return { entities, embeddings };
}

/** 两条记忆共享的实体数（§4.11.4 ① 的实体路径）。 */
function sharedEntityCount(facts: BatchFacts, a: string, b: string): number {
  const left = facts.entities.get(a);
  const right = facts.entities.get(b);
  if (left === undefined || right === undefined) {
    return 0;
  }
  let count = 0;
  for (const entityId of left) {
    if (right.has(entityId)) {
      count += 1;
    }
  }
  return count;
}

/**
 * 两条记忆的余弦（§4.11.4 ① 的余弦路径）。
 *
 * ⚠️ **缺向量 ⇒ `null`（不是 0）**：维度不同 / 没有向量都意味着「没有余弦这个事实」，
 *   记成 0 会让「不相似的证据」看起来像「没证据」。
 * ⇒ 复用 `cosineOf`（**全库唯一的余弦实现**，C36：同一件事不得有两套实现）。
 */
function cosineBetween(facts: BatchFacts, a: string, b: string): number | null {
  const left = facts.embeddings.get(a);
  const right = facts.embeddings.get(b);
  if (left === undefined || right === undefined) {
    return null;
  }
  return cosineOf(left, right);
}

/**
 * 机制 A 的建边证据判定（§4.11.4 ①，**满足任一即可**）。
 *
 * ⚠️ **两条路径各自独立成立**：实体路径**不要求 embedding** ⇒ `embeddedRatio` 低时
 *   它是共激活的主要供血来源（§0.2.2 路径②）⇒ 一条**没有向量**的记忆也能靠共享实体建边。
 */
export function hasActivationEvidence(
  facts: BatchFacts,
  a: string,
  b: string,
  params: Params,
): boolean {
  if (sharedEntityCount(facts, a, b) >= params.COACT_MIN_ENTITIES) {
    return true;
  }
  const cosine = cosineBetween(facts, a, b);
  return cosine !== null && cosine >= params.COACT_MIN_COS;
}

/** `coacts` 表的一行（只取用得上的列）。 */
interface CoactRow {
  affinity: number;
  coact_count: number;
  cause_flags: number;
  last_active: number;
}

/** 读一对记忆的现有共激活行（**没有则 `undefined`**）。 */
function readCoactRow(db: Database.Database, a: string, b: string): CoactRow | undefined {
  return db
    .prepare(
      `SELECT affinity, coact_count, cause_flags, last_active
         FROM coacts WHERE memory_a = @a AND memory_b = @b`,
    )
    .get({ a, b }) as CoactRow | undefined;
}

/** 候选对（归一后）+ 命中的机制。 */
interface CoactCandidate {
  /** 归一后的记忆 a（字典序小）。 */
  a: string;
  /** 归一后的记忆 b（字典序大）。 */
  b: string;
  /** 机制 A 的证据是否成立（批内自动）。 */
  hitA: boolean;
  /** 机制 B 的声明（可能多条：同一对被双向声明过）。 */
  declarations: BDeclaration[];
}

/** 机制 B 的一条声明（保留方向：谁是「被唤起者」、谁是「种子」）。 */
interface BDeclaration {
  /** 被唤起并被采纳的那条记忆（声明的 `memoryId`）。 */
  diffusedId: string;
  /** 唤起它的那条记忆（声明的种子）。 */
  seedId: string;
  /** 唤起时刻。 */
  activatedAt: number;
}

/**
 * 候选对的 Map 键。
 *
 * ⚠️ **必须用不可能出现在 id 里的分隔符**（而不是直接拼接两个 id）：
 *   拼接会让 `('ab','c')` 与 `('a','bc')` 撞成同一个键 ⇒ 两个不同的对被当成一个 ⇒ **静默丢边**。
 */
function candidateKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

/** 空结果（机制开关关闭时返回）。 */
function emptyResult(): CoactWriteResult {
  return {
    accepted: 0,
    truncated: 0,
    skippedInvalidSeed: 0,
    pairs: [],
    activationWrites: [],
    skipped: [],
  };
}

/**
 * 写入本次 touch 的共激活边（**全库唯一的 `coacts` 写入点**）。
 *
 * ⚠️ **调用方必须已经跑过 `touch()` 的前两步**（id 校验 + 加固）——
 *   本函数假定 `input.ids` 里的每条记忆都**存在且未软删**。
 * ⚠️ **必须在写事务内调用**（`src/store/touch.ts` 的 `runWriteTransaction`）⇒
 *   「写了一半」的中间态不会落库。
 *
 * @param store 库句柄 + 生效参数
 * @param input 本批 id、调用方的显式声明、时间戳
 * @returns 写入结果（同时喂给 §6 的 `TouchResult` 与 §8.4 的事件 payload）
 * @throws {MemoryError} code = `INVALID_INPUT`
 *   （① `memoryId` 不在 `ids` 内；② `seedIds` 含自己那条；④ 条目数超 `COACT_BATCH_MAX`）
 */
export function writeCoactivations(store: CoactStore, input: CoactWriteInput): CoactWriteResult {
  const params = store.params;
  const db = store.db;
  const now = input.now;

  // ── 机制开关（§5：`coactivation` 关 ⇒ touch 不写 `coacts`）──
  if (!resolveFlags(params).coactivation) {
    return emptyResult();
  }

  // ⚠️ ★ **机制开关 `writeBack`**（§5 机制开关表）：
  //   关 ⇒ 关闭「**扩散唤起 → 采纳 → 回写**」的**联动**部分
  //   ⇒ **`touch` 的 `coActivateWith` 交叉强化不发生**
  //   ⇒ **机制 B（调用方的显式声明）整条不参与**：
  //   **不产生因果增量**（`COACT_CAUSAL_BONUS`）、**不置 `cause_flags` 的 bit1**
  //   （= 2，机制 B 的那位）、**不记 `activationWrites`**。
  //   ⇒ ⚠️ **机制 A（同一批内任意两条的普通共激活）照旧**：
  //   那是 `coactivation` 管的（`touch` 的共激活写入），**不是 `writeBack` 管的**
  //   ⇒ **`writeBack` 关掉之后，`touch` 仍然会写普通的 `coacts` 行**（`cause_flags` 的 bit0）。
  //   ⚠️ ★ **弱校验也一并跳过**（与上面 `coactivation` 的短路**同一纪律**）：
  //   机制关着 ⇒ 这个入参**根本不被消费** ⇒ v1.0 里压根没有 `coActivateWith` 这个参数
  //   ⇒ 它的校验**也不该发生** ⇒ 否则「开 / 关」会给出**不同的入参校验结果**
  //   ⇒ ⇒ ADR-21 的「与 v1.0 逐位一致」会破（v1.0 压根不会因为这个入参报错）。
  const declarations = resolveFlags(params).writeBack ? (input.declarations ?? []) : [];

  const ids = input.ids;

  // ── 弱校验 ④：条目数超 `COACT_BATCH_MAX` ⇒ **硬拒**，不是截断 ──
  // ⚠️ **为什么不静默截断**：截断会让调用方以为「全写进去了」⇒ 那些没写进去的关联**静默丢失**。
  if (declarations.length > params.COACT_BATCH_MAX) {
    throw MemoryError.invalidInput(
      `coActivateWith 的条目数超上限（${declarations.length} > COACT_BATCH_MAX=${params.COACT_BATCH_MAX}）`,
      {
        reason: 'coact_batch_max',
        count: declarations.length,
        max: params.COACT_BATCH_MAX,
      },
    );
  }

  // ── 弱校验 ①：`memoryId` 必须是 `ids` 的成员 ──
  const idSet = new Set(ids);
  for (const declaration of declarations) {
    if (!idSet.has(declaration.memoryId)) {
      throw MemoryError.invalidInput(
        `coActivateWith 的 memoryId 必须是本次 touch 的 ids 成员：${declaration.memoryId}`,
        { reason: 'coact_memory_not_in_ids', memoryId: declaration.memoryId },
      );
    }
  }

  // ── 弱校验 ②：`seedIds` 不得含它自己那条（自共激活）──
  // ⚠️ **但允许** `seedIds` 与 `ids` 的其他成员相交（「A 唤起 B，A 与 B 也一并被采纳」完全合法）。
  for (const declaration of declarations) {
    if (declaration.seedIds.includes(declaration.memoryId)) {
      throw MemoryError.invalidInput(
        `coActivateWith 的 seedIds 不得包含它自己那条的 memoryId（自共激活）：${declaration.memoryId}`,
        { reason: 'coact_self_activation', memoryId: declaration.memoryId },
      );
    }
  }

  const result = emptyResult();

  // ── 候选对的收集（机制 B 在前、机制 A 在后）──
  // ⚠️ **顺序即「按数组顺序截断」的顺序**（§4.11.2 的上界①）：
  //   **调用方的显式声明排在自动证据之前**——显式声明是「意图」，自动证据是「兜底」，
  //   截断时先丢兜底的那一类 ⇒ 显式声明不会被自动证据挤掉。
  const candidates = new Map<string, CoactCandidate>();

  // ── 机制 B：调用方显式声明 ──
  for (const declaration of declarations) {
    for (const seedId of declaration.seedIds) {
      // ⚠️ **弱校验 ③：种子不存在或已软删 ⇒ 跳过该种子、记 `coactSkipped`、不抛错**
      //   （种子被遗忘不该让整个 touch 失败）。
      if (!isLiveMemory(db, seedId)) {
        result.skippedInvalidSeed += 1;
        const pair = normalizePair(declaration.memoryId, seedId);
        result.skipped.push({
          a: pair.a,
          b: pair.b,
          reason: COACT_SKIP_REASONS.invalidSeed,
          hadActivationEvidence: false,
        });
        continue;
      }
      const pair = normalizePair(declaration.memoryId, seedId);
      const key = candidateKey(pair.a, pair.b);
      const existing = candidates.get(key);
      const entry: BDeclaration = {
        diffusedId: declaration.memoryId,
        seedId,
        activatedAt: declaration.activatedAt ?? now,
      };
      if (existing === undefined) {
        candidates.set(key, { a: pair.a, b: pair.b, hitA: false, declarations: [entry] });
      } else {
        existing.declarations.push(entry);
      }
    }
  }

  // ── 机制 A：同一批内任意两条（**作用域天然是批内**）──
  const facts = loadBatchFacts(db, ids);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = ids[i];
      const right = ids[j];
      if (left === undefined || right === undefined) {
        continue;
      }
      if (!hasActivationEvidence(facts, left, right, params)) {
        continue;
      }
      const pair = normalizePair(left, right);
      const key = candidateKey(pair.a, pair.b);
      const existing = candidates.get(key);
      if (existing === undefined) {
        candidates.set(key, { a: pair.a, b: pair.b, hitA: true, declarations: [] });
      } else {
        existing.hitA = true;
      }
    }
  }

  // ── 上界①：`COACT_MAX_PAIRS_PER_TOUCH` ⇒ **按数组顺序截断**（不是抛错）──
  // ⚠️ **三个上界的语义不同，不可混谈**（§4.11.2）：
  //   ① `COACT_MAX_PAIRS_PER_TOUCH` = 单次 touch 记多少对 ⇒ **截断**（计数进事件与返回值）；
  //   ② `COACT_BATCH_MAX` = `coActivateWith` 条目数上限 ⇒ **硬拒 `INVALID_INPUT`**（见上）；
  //   ③ `COACT_AFFINITY_MIN` = 边的**有效**阈值（能不能连上）⇒ 判定有效性，**不限制记多少对**。
  const ordered = [...candidates.values()];
  const limit = params.COACT_MAX_PAIRS_PER_TOUCH;
  const processed = ordered.slice(0, limit);
  result.truncated = ordered.length - processed.length;

  // ── 逐对计算并写库 ──
  for (const candidate of processed) {
    const row = readCoactRow(db, candidate.a, candidate.b);

    // ⚠️ ★ **同日守卫按「(记忆对, 证据来源)」分别计数**（§4.11.4 的 v2.1 裁决）：
    //   · 基础增量（「被一起用过」这一类证据）⇒ 24h 内至多记一次；
    //   · 因果增量（「谁唤起了谁」这一类证据）⇒ 24h 内至多记一次；
    //   · **两者互不豁免** ⇒「A 建边 + 当天 B 声明」能同时拿到两条证据。
    //
    // ⚠️⚠️ **已知边界（`coacts` 表只有**一个**时间戳 ⇒ 守卫状态无法分源持久化）**：
    //   `coacts` 的列是 `affinity` / `coact_count` / `cause_flags` / `last_active`
    //   ⇒ **每个记忆对只有一个时刻**（`last_active`）⇒ 「基础增量的上次时刻」与
    //   「因果增量的上次时刻」**无处分别存放**。
    //   ⇒ 本实现的口径：**基础增量**用 `last_active`（该对最近一次被写入的时刻）
    //   ⇒ **因果增量**额外用 `cause_flags` 的 bit1 兜底（「这一对**从来没有过**因果写入」
    //   ⇒ 本次一定是新证据 ⇒ 放行」）。
    //   ⇒ **可观测的后果**：若某对**当天先被机制 B 建边、之后当天才第一次出现机制 A 的证据**，
    //   则那次 A 的基础增量会被这次 B 的写入挡下（`last_active` 已被 B 刷新）
    //   ⇒ 该 A 证据进 `coactSkipped`（**不静默丢失**）⇒ 24h 之后再来一次即可补上。
    //   ⚠️ **这是「表只有一个时间戳」这条约束的必然结果**，不是公式写错；
    //   若要彻底消除它，需要给 `coacts` 加两个独立的时间戳列（**属 schema 变更，超出 P3-T01 范围**）。
    const withinWindow = row !== undefined && now - row.last_active < COACT_SAME_DAY_WINDOW_MS;

    // ⚠️ **基础增量的守卫用「该对上次被写入的时刻」**（`last_active`）——
    //   每次写入都会刷新它 ⇒ 它就是「这一对最近一次被一起用过」的时刻。
    const baseAllowed = row === undefined || !withinWindow;

    // ⚠️ **因果增量的守卫独立于基础增量**：
    //   「这一对**从来没有过**因果写入」（`cause_flags` 的 bit1 从未置位）⇒ 本次是新证据 ⇒ 放行；
    //   否则只有离开 24h 窗口才放行 ⇒ **两者互不豁免**。
    const causalAllowed =
      candidate.declarations.length > 0 &&
      (row === undefined || !withinWindow || (row.cause_flags & CAUSE_FLAG_MECHANISM_B) === 0);

    // ★ **base 的合成（只施加一次）**：基础增量 +（因果增量被授予时的加成）
    const base =
      (baseAllowed ? params.COACT_REINFORCE_STEP : 0) +
      (causalAllowed ? params.COACT_CAUSAL_BONUS : 0);

    if (base <= 0) {
      // ⚠️ **整对都被守卫挡下 ⇒ 记 `coactSkipped`**（§8.4 硬规则 3：
      //   「一条关联要么体现在 `affinity` 上，要么出现在 `coactSkipped` 里——两者都没有才是 bug」）。
      result.skipped.push({
        a: candidate.a,
        b: candidate.b,
        reason: COACT_SKIP_REASONS.sameDayGuard,
        hadActivationEvidence: candidate.declarations.length > 0,
      });
      continue;
    }

    const increment = computeCoactIncrement(row?.affinity ?? 0, base, params.COACT_AFFINITY_MAX);

    // ⚠️ ★ **幂等分支**：这一对**已在 `coacts` 表中** ⇒ **只 UPDATE**，**不 INSERT**。
    //   `cause_flags` **只置位、不清零**（历史事实不可撤销）⇒ 用按位或。
    const causeFlags =
      (candidate.hitA && baseAllowed ? CAUSE_FLAG_MECHANISM_A : 0) |
      (causalAllowed ? CAUSE_FLAG_MECHANISM_B : 0);

    if (row === undefined) {
      db.prepare(
        `INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
         VALUES (@a, @b, @affinity, 1, @causeFlags, @now)`,
      ).run({
        a: candidate.a,
        b: candidate.b,
        affinity: increment.affinityNew,
        causeFlags,
        now,
      });
    } else {
      db.prepare(
        `UPDATE coacts
            SET affinity    = @affinity,
                coact_count = coact_count + 1,
                cause_flags = cause_flags | @causeFlags,
                last_active = @now
          WHERE memory_a = @a AND memory_b = @b`,
      ).run({
        a: candidate.a,
        b: candidate.b,
        affinity: increment.affinityNew,
        causeFlags,
        now,
      });
    }

    result.accepted += 1;
    result.pairs.push({ a: candidate.a, b: candidate.b, affinityAfter: increment.affinityNew });

    // ⚠️ **因果写入逐条声明记**（`activationWrites` 保留方向：谁是种子、谁被唤起）。
    if (causalAllowed) {
      for (const declaration of candidate.declarations) {
        result.activationWrites.push({
          diffusedId: declaration.diffusedId,
          seedId: declaration.seedId,
          affinityAfter: increment.affinityNew,
          activatedAt: declaration.activatedAt,
        });
      }
    } else if (candidate.declarations.length > 0) {
      // ⚠️ **因果证据被守卫吞掉 ⇒ 必须可观测**（§8.4 硬规则 3）：
      //   「一条关联要么体现在 `affinity` 上，要么出现在 `coactSkipped` 里——两者都没有才是 bug」。
      //   ⇒ 这一对的基础增量写进去了，但**因果增量没写进去** ⇒ 必须单独记一条。
      result.skipped.push({
        a: candidate.a,
        b: candidate.b,
        reason: COACT_SKIP_REASONS.sameDayGuard,
        hadActivationEvidence: true,
      });
    }
  }

  return result;
}

/** 一条记忆是否存在且**未软删**（弱校验③的判据）。 */
function isLiveMemory(db: Database.Database, id: string): boolean {
  const row = db.prepare('SELECT id FROM memories WHERE id = @id AND deleted = 0').get({ id }) as
    | { id: string }
    | undefined;
  return row !== undefined;
}
