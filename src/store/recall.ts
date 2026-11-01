/**
 * 召回流水线 —— DESIGN-v2.md §4.6（对应 DEVELOPMENT-PLAN.md **P1-T08**）。
 *
 * ★ **本文件是「取候选 + 排序截断」的唯一实现**：
 *   分数一律由 `src/core/scoring.ts` 独家提供（五因子加权和 / `normBm25` 三分支 /
 *   `graphProximity` / `recency`），与 §4.2 把 `growStability` 收成「唯一写入点」是同一条纪律：
 *   「五条路各写各的公式」必然漂移，而漂移**极难在实现期被发现**
 *   （两边的数都像正常值，测试也照样绿）。
 *   ⇒ 本文件**不实现任何打分公式**，也**不另算粗筛窗口**
 *     （两档窗口由 `scoring.ts` 的 `coarseGateWindow()` 独家提供 —— 「三路共用的唯一计算处」），
 *     只做：步骤 1 实体名**归一** → 步骤 2 三路候选 → 步骤 2.5 去重
 *     → 步骤 3 调打分 → 步骤 4 排序截断 + 事件。
 *
 * ⚠️ **库不抽取实体**（ADR-2 / ADR-P1-T08-GAP 缺口①）：
 *   「上下文 → 实体名」由**调用方**完成；调用方把名字放进 `RecallOptions.entityNames`，
 *   库只做「名字 → `entity_id`」的归一（逐名 `resolveEntity`，主名优先于别名）。
 *   ⇒ `entityIds` 与 `entityNames` **互斥**（同传 ⇒ `INVALID_INPUT`）；
 *     两者都不传 ⇒ 图谱路为空（退化为「文本路 + 向量路」）。
 *   ⚠️ **本文件不提供「按上下文匹配已知实体名」的便利函数**：
 *     那种查询的成本是 **O(#实体 + #别名) 的行扫描**（10 万级实体上就是几十~几百毫秒），
 *     ⇒ 绝不能进每次 recall 都付的路径；ADR-2 把实体抽取划给调用方，
 *     便利函数若要提供，应作为**调用方显式调用的独立 API**（§12 阶段 1 的方法清单里没有它）。
 *
 * ⚠️ **流水线顺序不可换**（§4.6 首段）：
 *   路由（步骤 0，阶段 2 补）→ 三路候选（步骤 2）→ 融合打分（步骤 3）
 *   → 侧抑制后置（步骤 4.5）→ 联想路 / 激活扩散（步骤 4.6）→ 排序截断（步骤 4）。
 *   ⇒ **侧抑制是后置的，不进五因子公式**（§4.11.3）——这是「五项权重恒和为 1.0」得以保留的前提。
 *   ⇒ **激活扩散是后置的，不进五因子公式**（§4.7）：`diffusionScore` **只用于 diffused 内部排序**，
 *     **不是 0~1 的置信度**（它的上界 = `MAX_DIFFUSED_VISITS × ACTIVATION_DECAY`）。
 *   ⇒ **抑制不作用于 diffused**（§4.13.1 硬约束③）⇒ `diffused` 的内容与 `inhibition` 开关**无关**
 *     （扩散的种子取的是**抑制前**的 topN）。
 *
 * ⚠️ **两条铁律**（§4.6，比任何权重都重要）：
 *   ① **三路只回答「谁可能是候选」，不回答「谁配被想起」**：
 *      准入闸门（`deleted = 0` / `last_access` 粗筛窗口 / `intensity > ARCHIVE_LINE` 精筛）
 *      对**所有路一视同仁**。
 *      ⇒ 向量路若绕过闸门，一条早已淡忘（intensity 0.01）的记忆会因「语义很像」被拉回 topN
 *        ⇒ **用相似度废掉了遗忘曲线**（本库两个核心卖点互相抵消）。
 *   ② **向量只进入 `score`，不改变任何准入判定**：它排的是名次，不是资格。
 *
 * ⚠️ **本阶段向量路「整路缺席」，不是「向量分全 0」那种降级**（§4.6 步骤 2c 原话）：
 *   阶段 2 才有向量后端与两级分桶 ⇒ 本文件**整路不执行**，
 *   `explain.routes.vector.ran` 恒为 `false`，事件里的 `vectorUsed` 恒为 `false`。
 *   ⚠️ 这与「向量路跑了、但某条候选没有向量」是**两种不同的处境**：
 *     前者是**缺项**，后者是**真实的 0 分**。
 *     ⇒ 缺项判定必须靠 `fromVector`（per-hit）+ `routes.vector.ran`（call 级），
 *       **不能靠 `cos`**（`cos` 把三种语义压成一个值，单看它判定不了缺项）。
 *   ⚠️ 因此本文件**不引用任何分桶相关的表名** —— 守住 ADR-16 的「替换点收敛在一处」承诺：
 *     换向量后端实现时不必重写整段流水线。
 *
 * ⚠️ **参数纪律**：所有阈值与上限一律取自 `DEFAULT_PARAMS`（60 项，不增不删）。
 *   唯三处**刻意硬编码**的量写在下面的「字面量」块里 —— 它们是 §4.6 / §6 的**设计稿字面量**，
 *   参数表 60 项里**没有**对应项（与 `scoring.ts` 里的五项权重、sigmoid 斜率同一类处理）。
 *
 * ⚠️ **查询路径禁止写库**（§4.6 步骤 1）：名字不认识**不得**就建实体
 *   ⇒ 本文件全程只发 `SELECT`；唯一的写发生在 `reinforce === true` 时的加固（§4.2）。
 *
 * ⚠️ **归档模式不做强度精筛**（ADR-P1-T08-GAP 小口径③）：
 *   `includeArchived === true` ⇒ 应用层**不判强度**（只保留 `deleted = 0`）——
 *   不是「阈值改成 0」（那是**严格大于** ⇒ 强度下溢成恰好 0.0 的记忆仍会被挡掉，
 *   而它们**已经被 SQL 捞进来了** ⇒ 「显式查询归档层」名存实亡）。
 *
 * ⚠️ **C37 时钟注入**：真实时钟只经 `resolveNow()`（唯一入口 `src/core/clock.ts`）；
 *   本文件**不得**出现直接读真实时钟的写法 ⇒ 否则 `scripts/check-clock.ts` 判红。
 */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { intensity } from '../core/decay.js';
import { resolveEntity } from '../core/entities.js';
import { MemoryError } from '../core/errors.js';
import type { RecallEventPayload } from '../core/events.types.js';
import { resolveFlags } from '../core/flags.js';
import type { Params } from '../core/params.js';
import {
  type Bm25Candidate,
  type CoarseGateWindow,
  SCORE_WEIGHTS,
  type TextRouteMode,
  archiveFilterThreshold,
  assignGraphProximity,
  coarseGateWindow,
  fuseScore,
  normalizeBm25,
  passesIntensityFilter,
  recency,
} from '../core/scoring.js';
import { buildMatchQuery } from '../core/tokenize.js';
import { inhibitCandidates, loadInhibitionFacts } from '../neuron/inhibit.js';
import { type DiffusedItem, diffuse } from './diffuse.js';
import type { EventWriter } from './events.js';
import { type MemoryView, get } from './get.js';
import { touch } from './touch.js';

// ═══════════════════════════════════════════════════════════════════════════
// 〇、§4.6 / §6 的设计稿字面量（**刻意不进参数表**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 每条路的 SQL 预取上限（§4.6 步骤 2a / 2b 的 `LIMIT 100`）。
 *
 * ⚠️ **为什么是放大预取而不是「只取要的那几条」**：SQL 层先按相关度截断，
 *   应用层才做**强度精筛**（`intensity > ARCHIVE_LINE`）。
 *   若 SQL 层就只取 20 条，而其中 15 条被判归档 ⇒ 精筛后只剩 5 条，
 *   而真正该被召回的那条排在第 21 名 —— **被静默丢掉**。
 *
 * ⚠️ **为什么不是参数**：§5 的参数表 60 项里**没有**这一项，
 *   而它与「可调业务参数」性质不同（改它会让「精筛余量」这个概念消失）。
 *   ⇒ 与 `scoring.ts` 的五项权重、sigmoid 斜率同一处理：**刻意硬编码 + 在本文件声明**。
 */
const CANDIDATE_FETCH_LIMIT = 100;

/**
 * 每条路**精筛之后**的候选上限（§4.6 步骤 2a / 2b 的 `slice(0, 20)`）。
 *
 * ⚠️ **为什么文本路与图谱路用同一个数**：两者是同一量级的证据源，
 *   而 §5 的 `VECTOR_TOPK`（默认 20）的注释明写「与文本路 slice(0, 20) 对齐」
 *   ⇒ 三条路保持同一量级，融合打分才有可比性。
 *
 * ⚠️ **为什么不是参数**：同 `CANDIDATE_FETCH_LIMIT`，参数表 60 项里没有对应项。
 */
const ROUTE_CANDIDATE_LIMIT = 20;

/**
 * `topN` 的上界（§6：「默认 5，内部限制 1~8」）。
 *
 * ⚠️ **是钳制不是报错**：§6 的原文是「内部限制」⇒ 传 100 会被钳到 8，而不是抛 `INVALID_INPUT`
 *   （抛错会让「调用方不小心传了个大数」变成一次调用失败，而它本意只是「多要点」）。
 */
const MAX_TOP_N = 8;

// ═══════════════════════════════════════════════════════════════════════════
// 一、对外类型
// ═══════════════════════════════════════════════════════════════════════════

/** `recall` 所需的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface RecallStore {
  /** 库句柄。 */
  db: Database.Database;
  /** 生效参数（阈值与上限的可调项都在这里 ⇒ **必传**）。 */
  params: Params;
  /** 事件写入器（`explain === true` 时记一条 `recall` 事件）。 */
  events: EventWriter;
}

/**
 * `recall` 的入参（字段集以 §6 的 `RecallOptions` 为准）。
 *
 * ⚠️ **刻意不提供 `source` 过滤**（§6 明写）：
 *   记忆库的核心价值是「跨来源统一召回」，按来源过滤会与其定位冲突。
 */
export interface RecallOptions {
  /** 召回上下文（必传）。 */
  context: string;
  /** 取前 N 条（默认 `RECALL_TOP_N`，内部限制 `1~8`）。 */
  topN?: number;
  /**
   * 查询向量。
   *
   * ⚠️ **本阶段整条向量路缺席**（阶段 2 才有向量后端）⇒ 本字段**当前不产生任何效果**，
   *   `explain.routes.vector.ran` 恒为 `false`、事件的 `vectorUsed` 恒为 `false`。
   *   ⚠️ **这不是「降级成向量分全 0」**：整路缺席与「跑了但没命中」是两种处境，
   *     缺项判定必须靠 `fromVector` + `routes.vector.ran`，**不能靠 `cos`**。
   */
  queryEmbedding?: number[];
  /**
   * 已解析好的 canonical `entity_id` 列表。
   *
   * ⚠️ **传入即完全跳过 §4.6 步骤 1 的名称解析**（不再逐名 `resolveEntity`）；
   *   传入空数组 `[]` 等价于「明确表示无实体」⇒ 图谱路转空。
   * ⚠️ **与 `entityNames` 互斥**（ADR-P1-T08-GAP 缺口①）：同传 ⇒ 抛 `INVALID_INPUT`。
   */
  entityIds?: string[];
  /**
   * 调用方抽好的实体**名**列表。
   *
   * ⚠️ **库不抽取实体**（ADR-2 / ADR-P1-T08-GAP 缺口①）：
   *   「上下文 → 名字」由**调用方**完成；库只做「名字 → `entity_id`」的归一
   *   （逐名 `resolveEntity`，主名优先于别名）。
   *   ⇒ 调用方想要「按库里已知的实体名做字典匹配」时，**自己查**（app 侧有句柄）
   *     或显式调一个**独立于召回流水线**的辅助 API；本文件**不提供**它。
   * ⚠️ **与 `entityIds` 互斥**：同传 ⇒ 抛 `INVALID_INPUT`。
   * ⚠️ 解析不到的名字（`resolveEntity` 返回 `null`）**不进图谱路**，
   *   但**仍参与文本路检索**（文本路检索的是正文，不需要实体表里有它）。
   * ⚠️ **与 `entityIds` 都不传** ⇒ 图谱路为空（退化为「文本路 + 向量路」）。
   */
  entityNames?: string[];
  /**
   * 是否显式查询归档层（默认 `false`；这是「显式查询归档层」的**唯一代码路径**）。
   *
   * ⚠️ **归档模式下不做强度精筛**（ADR-P1-T08-GAP 小口径③）：
   *   原稿的「阈值 = 0.0」与「只过滤 `deleted = 0`」**在数值上不等价** ——
   *   精筛是**严格大于**，`intensity` 因 `exp` 下溢成**恰好 0.0** 的记忆
   *   （Δt/τ > 745 天；schema 只要求 `stability > 0` ⇒ 常见）仍会被挡掉；
   *   而那些行**已经被 SQL 捞进来了**（归档模式无时间窗）却在应用层被悄悄丢掉
   *   ⇒ 「显式查询归档层」名存实亡。
   *   ⇒ 本实现：**归档模式跳过强度精筛**（三路一致，铁律①）。
   */
  includeArchived?: boolean;
  /**
   * 扩散是否也过滤归档（默认 `true`）。
   *
   * ⚠️ **这是 §4.7 规则 R-ARCH-DIFF 的唯一例外通道**（§7 边界约束③）：
   *   `true` ⇒ 扩散**可以**捞出归档记忆（带 `layer: 'archived'` 标记）；
   *   `false` ⇒ 扩散候选**同样**要过 `intensity > ARCHIVE_LINE` 的精筛，与主召回口径一致。
   * ⚠️ **两腿共用同一套归档口径**（§4.14.5）：实体跳与簇跳**都**受这个开关约束。
   */
  diffuseArchived?: boolean;
  /**
   * 是否同步加固本次 topN（默认 `false`）。
   *
   * ⚠️ **只加固、不建共激活边**（§4.11.2 裁决）：
   *   否则每次 reinforce 都把本次 top-N 焊成一个团 ⇒ 触发 §0.2 明令禁止的「topN 自我强化」。
   */
  reinforce?: boolean;
  /**
   * 是否附带分值明细**并**记一条 `recall` 事件（§4.6 步骤 4）。
   *
   * ⚠️ **写放大**：常开 `explain` = 最高频操作每次写一条事件 ⇒ 默认关闭。
   */
  explain?: boolean;
  /**
   * 只要诊断数据、**不要事件**（v2.1 新增）。
   *
   * ⚠️ `diagnostics === true` ⇒ 返回 `explain` 块但**不写** `recall` 事件；
   *   与 `explain` 同为 `true` 时**以 `explain` 为准**（含事件）。
   */
  diagnostics?: boolean;
  /** 注入时钟（C37）。 */
  now?: number;
}

/** 一条命中的分值明细（§6 的 `Hit.breakdown`）。 */
export interface RecallBreakdown {
  /** `0.30 × intensity`。 */
  intensityPart: number;
  /** `0.25 × vectorSim`；本阶段向量路缺席 ⇒ 恒为 0。 */
  vectorPart: number;
  /** `0.20 × normBm25`。 */
  textPart: number;
  /** `0.15 × graphProximity`。 */
  graphPart: number;
  /** `0.10 × recency`。 */
  recencyPart: number;
  /**
   * FTS5 的原始 BM25（**负值，越负越相关**）。
   *
   * ⚠️ LIKE 单字兜底路、纯图谱命中、纯向量命中时恒为 `null`
   *   （**不使用 `-1.0` 哨兵值**：哨兵值与真实 bm25 负值混在一起就分不清「命中得弱」与「压根没走文本路」）。
   */
  rawBm25: number | null;
  /**
   * 本次的语义余弦（**原始证据**，不是加权后的分项）。
   *
   * ⚠️ 本阶段向量路缺席 ⇒ 恒为 `null`。
   */
  cos: number | null;
}

/**
 * 一条命中（§6 的 `Hit`：静态视图 + 本次检索的评分）。
 *
 * ⚠️ **`fromText` / `fromVector` / `fromGraph` 是 §4.6 步骤 2.5 的三个来源标记**：
 *   它们**只为排障与 `explain` 展示，不参与任何计算**（尤其不参与 `graphProximity`）。
 *   ⚠️ **放在顶层（而不是 `breakdown` 里）**（ADR-P1-T08-GAP 缺口②）：
 *     它们的语义是「**这一条**是从哪几路来的」，
 *     与「本次这一路跑没跑」（`explain.routes`）分属**两个层级**，不能混在一起；
 *     且 `breakdown` 装的是「本次检索的**分项**」，塞来源会破坏语义单一性。
 */
export interface Hit extends MemoryView {
  /** 本次的融合总分（= 五个分项之和，误差 ≤ 1e-9）。 */
  score: number;
  /** 分值明细（仅 `explain` / `diagnostics` 时给出）。 */
  breakdown?: RecallBreakdown;
  /** 本条是否由**文本路**召回。 */
  fromText: boolean;
  /** 本条是否由**向量路**召回（本阶段恒为 `false`）。 */
  fromVector: boolean;
  /** 本条是否由**图谱路**召回。 */
  fromGraph: boolean;
}

/**
 * ⚠️ **弃用别名**：§6 的公开契约叫 **`Hit`**（C36：同一件事不得有两套词），
 *   `RecallHit` 是本实现早期的命名 ⇒ 保留为别名，避免下游 import 断裂。
 *   ⚠️ **不要删**：删了会打断已经 import 它的调用方。
 *   ⚠️ **公共入口（`src/index.ts`）上两者都在，但 `Hit` 才是规范名**：
 *   新代码一律写 `Hit`；`RecallHit` 只是为了让旧代码继续编译。
 */
export type RecallHit = Hit;

/** 单条路的运行情况（§6 的 `explain.routes`）。 */
export interface RecallRouteInfo {
  /** 本次这一路**跑没跑**。 */
  ran: boolean;
  /**
   * 本次这一路产出的候选条数。
   *
   * ⚠️ **口径写死**：**精筛 + slice 之后**、**去重之前**的条数。
   */
  candidates: number;
}

/** 一次调用的**级**诊断（§6 的 `explain`）。 */
export interface RecallExplain {
  /** 三条路各自的运行情况。 */
  routes: {
    text: RecallRouteInfo;
    vector: RecallRouteInfo;
    graph: RecallRouteInfo;
  };
  /**
   * 激活扩散的诊断（§4.7）。
   *
   * ⚠️ **`scanned` 是两腿合计**（§4.14.1：两条腿共享同一份 `MAX_DIFFUSED_VISITS` 预算）
   *   ⇒ 它**恒 ≤ `MAX_DIFFUSED_VISITS`**。
   */
  diffusion: {
    /** 本次处理的边数（两腿合计）。 */
    scanned: number;
    /** 因 bonus < `ACTIVATION_MIN` 而未产出候选的边数。 */
    belowThreshold: number;
    /** 因「种子不带实体」而被跳过的扩散次数。 */
    skippedNoEntity: number;
    /** 是否因预算耗尽而提前停止。 */
    budgetExhausted: boolean;
  };
}

/** 被侧抑制挤掉、但仍可查的候选（§6）。 */
export interface RecallSuppressed {
  id: string;
  content: string;
  score: number;
  layer: MemoryView['layer'];
  redundantWith?: string;
  redundancySim?: number;
  reason: 'redundant';
}

/**
 * ⚠️ **弃用别名**：扩散唤起的记忆（§6）。
 *
 * ⚠️ **本类型不在本文件定义**（C36：同一件事不得有两套词）：
 *   真正的定义在 `src/store/diffuse.ts`（`DiffusedItem`）⇒ 本文件只做**重导出**，
 *   对外的名字 `RecallDiffused` **不变**（`src/index.ts` 的导出不破）。
 */
export type RecallDiffused = DiffusedItem;

/** `recall` 的返回值（§6 的 `RecallResult`）。 */
export interface RecallResult {
  /** 本次命中（按分数降序）。 */
  hits: Hit[];
  /** 调用级诊断（仅 `explain` / `diagnostics` 时给出）。 */
  explain?: RecallExplain;
  /** 被侧抑制挤掉的候选（字段**恒在**，不省略）。 */
  suppressed: RecallSuppressed[];
  /**
   * 扩散唤起的记忆（字段**恒在**，不省略）。
   *
   * ⚠️ **默认可以包含归档记忆**（§4.7 的 R-ARCH-DIFF）⇒ 带 `layer: 'archived'` 标记。
   * ⚠️ **不参与 hits 排序、不占 topN 名额**（§4.14）。
   */
  diffused: RecallDiffused[];
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、内部类型与 SQL
// ═══════════════════════════════════════════════════════════════════════════

/** 一条候选的最小字段集（打分只需要这五个 + 词法证据）。 */
interface CandidateRow {
  id: string;
  stability: number;
  pin_factor: number;
  last_access: number;
  created_at: number;
  /** FTS5 的原始 BM25（**负值**）；非文本路命中时为 `null`。 */
  raw_bm25: number | null;
}

/** 去重合并后的一条候选（步骤 2.5 的产物）。 */
interface MergedCandidate {
  id: string;
  stability: number;
  pin_factor: number;
  last_access: number;
  created_at: number;
  /** 词法分（文本路命中时非空）。 */
  rawBm25: number | null;
  /** 语义分（向量路缺席 ⇒ 恒为 `null`）。 */
  cos: number | null;
  fromText: boolean;
  fromVector: boolean;
  fromGraph: boolean;
}

/** 打分后的候选（步骤 3 的产物）。 */
export interface ScoredCandidate extends MergedCandidate {
  score: number;
  intensityValue: number;
  normBm25Value: number;
  graphProximityValue: number;
  recencyValue: number;
}

/**
 * 粗筛窗口的 SQL 片段（§4.6 步骤 2）。
 *
 * ⚠️ **为什么被 pin 的记忆不是「一律豁免」**：
 *   豁免意味着被 pin 的条目**无论多旧**都进候选集 ⇒ pin 数量一多粗筛就退化成全表扫，
 *   再叠加 `LIMIT 100` 就会挤掉真正新鲜的匹配。
 *   ⇒ 两档窗口既保证不漏召（被 pin 的窗口足够宽），又让索引照常生效。
 */
const COARSE_WINDOW_SQL = `AND (m.last_access >= @coarseCutoff
         OR (m.pin_factor > 1.0 AND m.last_access >= @coarseCutoffPinned))`;

/** 粗筛片段在 SQL 模板里的占位符。 */
const COARSE_PLACEHOLDER = '{COARSE_WINDOW}';

/**
 * 文本路 · FTS 分支的 SQL（§4.6 步骤 2a 逐字）。
 *
 * ⚠️ **FTS5 的 `bm25()` 返回负值，越负越相关** ⇒ `ORDER BY bm25(mem_fts) ASC` 即最相关在前
 *   （**显式写出**，不依赖默认排序）。
 * ⚠️ **不给 `mem_fts` 起别名**：FTS5 的辅助函数与 `MATCH` 必须引用**可用表名**
 *   （有别名时用别名），否则报 `no such column`。
 * ⚠️ **只 SELECT 需要的列**（不是 `m.*`）：`m.*` 会把 768 维的 `embedding` BLOB 一起拖出来，
 *   100 条候选 ⇒ 约 300KB 的无用搬运。
 */
const TEXT_FTS_SQL = `SELECT m.id AS id,
       m.stability AS stability,
       m.pin_factor AS pin_factor,
       m.last_access AS last_access,
       m.created_at AS created_at,
       bm25(mem_fts) AS raw_bm25
  FROM mem_fts JOIN memories m ON mem_fts.rowid = m.rowid
 WHERE mem_fts MATCH @matchSql
   AND m.deleted = 0
   ${COARSE_PLACEHOLDER}
 ORDER BY bm25(mem_fts) ASC
 LIMIT ${CANDIDATE_FETCH_LIMIT}`;

/**
 * 文本路 · LIKE 单字兜底分支的 SQL（§4.6 步骤 2a 逐字）。
 *
 * ⚠️ **`raw_bm25` 置 `null`**（不是 `-1.0` 哨兵值）：哨兵值与真实 bm25 负值混在一起，
 *   谁也分不清「命中得弱」与「压根没走文本路」——而这两者的归一化规则完全不同。
 * ⚠️ **`ESCAPE '\'` 必须配**：没有 `ESCAPE` 子句时 `\` 只是普通字符、转义**不生效**
 *   ⇒ `'50\%'` 会被当成字面量匹配。
 */
const TEXT_LIKE_SQL = `SELECT m.id AS id,
       m.stability AS stability,
       m.pin_factor AS pin_factor,
       m.last_access AS last_access,
       m.created_at AS created_at,
       NULL AS raw_bm25
  FROM memories m
 WHERE m.content LIKE ('%' || @fallbackLike || '%') ESCAPE '\\'
   AND m.deleted = 0
   ${COARSE_PLACEHOLDER}
 ORDER BY m.last_access DESC
 LIMIT ${CANDIDATE_FETCH_LIMIT}`;

/**
 * 图谱路的 SQL（§4.6 步骤 2b 逐字）。
 *
 * ⚠️ **`entity_id IN (...)` 用 `json_each` 而不是展开成一串 `?`**：
 *   `IN (?, ?, …, ?)` 要把实体数个绑定变量一次性塞进去，
 *   而 SQLite 的绑定变量上限**历史上是 999** ⇒ 实体一多就是运行时炸裂，
 *   且**炸的时刻取决于库的大小**（最难查的一类故障）。
 *   ⇒ 与 `scoring.ts` 的 `GRAPH_PROXIMITY_SQL` 同一处理。
 */
const GRAPH_SQL = `SELECT m.id AS id,
       m.stability AS stability,
       m.pin_factor AS pin_factor,
       m.last_access AS last_access,
       m.created_at AS created_at,
       NULL AS raw_bm25
  FROM memory_entities me JOIN memories m ON me.memory_id = m.id
 WHERE me.entity_id IN (SELECT value FROM json_each(@entityIds))
   AND m.deleted = 0
   ${COARSE_PLACEHOLDER}
 ORDER BY m.last_access DESC
 LIMIT ${CANDIDATE_FETCH_LIMIT}`;

// ═══════════════════════════════════════════════════════════════════════════
// 三、步骤 1：实体名的**归一**（库不抽取，ADR-P1-T08-GAP 缺口①）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 步骤 1：把调用方给的名字**归一**成 `entity_id` 集合（§4.6 步骤 1）。
 *
 * ⚠️ **库不抽取实体**（ADR-P1-T08-GAP 缺口① / ADR-2）：
 *   「上下文 → 名字」由**调用方**完成；库只做「名字 → id」的归一。
 *   ⇒ 四个分支（**互斥**，不静默取舍）：
 *     ① `entityIds` 与 `entityNames` **同传** ⇒ 抛 `INVALID_INPUT`
 *        （两者装的是**同一件事的两个阶段**；取舍 = 静默丢弃调用方的一半意图）。
 *     ② 只传 `entityIds` ⇒ **完全跳过**名称解析（现状不变）；`[]` = 「明确表示无实体」。
 *     ③ 只传 `entityNames` ⇒ 逐名 `resolveEntity`；解析不到的名字**跳过**
 *        （它仍参与**文本路**检索 —— 文本路检索的是正文，不需要实体表里有它）。
 *     ④ **都不传** ⇒ 图谱路为空（退化为「文本路 + 向量路」；
 *        ADR-2 明写并接受这个代价：「调用方不传就退化为纯文本检索，功能仍完整」）。
 *
 * ⚠️ **名称 → id 的解析一律走 `resolveEntity`**（§4.5 末尾的**唯一实现**）：
 *   主名优先于别名 ⇒ 同一个字符串不会给出两个答案。
 *   ⚠️ **不得**给 `resolveEntity` 加「不存在就建」的开关：查询路径禁止写库。
 *
 * @param db 数据库句柄
 * @param explicitIds 调用方直接传入的 `entity_id` 列表（`undefined` = 未传）
 * @param explicitNames 调用方抽好的实体名列表（`undefined` = 未传）
 * @returns 去重后的 `entity_id` 列表
 * @throws {MemoryError} code = `INVALID_INPUT`（`entityIds` 与 `entityNames` 同传）
 */
function resolveContextEntityIds(
  db: Database.Database,
  explicitIds: readonly string[] | undefined,
  explicitNames: readonly string[] | undefined,
): string[] {
  // ⚠️ **互斥**（ADR-P1-T08-GAP 缺口①）：同传 ⇒ `INVALID_INPUT`（五码封闭，不扩错误码）。
  if (explicitIds !== undefined && explicitNames !== undefined) {
    throw MemoryError.invalidInput(
      'recall 的 entityIds 与 entityNames 互斥：两者装的是同一件事的两个阶段',
      {
        entityIds: {
          current: String(explicitIds.length),
          reason:
            '两个都传就必须有一个被静默丢弃（= 丢弃调用方一半意图）；' +
            '要已解析的 id 就只传 entityIds，要名字就只传 entityNames',
        },
        entityNames: {
          current: String(explicitNames.length),
          reason: '与 entityIds 互斥（见上）',
        },
      },
    );
  }

  if (explicitIds !== undefined) {
    return [...new Set(explicitIds.filter((id) => id !== ''))];
  }

  if (explicitNames === undefined) {
    // ⚠️ **都不传 ⇒ 图谱路为空**（ADR-2：「调用方不传就退化为纯文本检索，功能仍完整」）。
    return [];
  }

  const ids: string[] = [];
  for (const name of explicitNames) {
    if (name === '') {
      continue;
    }
    // ⚠️ 解析不到就**跳过**（不建实体）：该名称仍会参与**文本路**检索
    //   （文本路检索的是正文，不需要实体表里有它）。
    const entityId = resolveEntity(db, name);
    if (entityId !== null) {
      ids.push(entityId);
    }
  }
  return [...new Set(ids)];
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、步骤 2：三路候选
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把 SQL 模板里的粗筛占位符换成真正的片段（或换成空串）。
 *
 * ⚠️ **判据取自 `coarseGateWindow(...).enabled`，而不是另写一份 `includeArchived`**：
 *   「粗筛是否生效」这件事**只有一个出处**（`scoring.ts`）。
 *   ⇒ 本文件不再自己判断一次 —— 否则阶段 2 的向量路（按 `enabled` 判）与
 *     文本路 / 图谱路（按 `includeArchived` 判）一旦漂移，
 *     **三路的闸门就不再是一视同仁**（铁律①），而且**不报错**（两个数都像正常值）。
 */
function buildSql(template: string, coarse: CoarseGateWindow): string {
  return template.replace(COARSE_PLACEHOLDER, coarse.enabled ? COARSE_WINDOW_SQL : '');
}

/**
 * 粗筛窗口的 SQL 绑定参数（§4.6 步骤 2 的两档窗口）。
 *
 * ⚠️ **窗口本身由 `scoring.ts` 的 `coarseGateWindow()` 独家计算**
 *   （§4.6 步骤 2：「三路共用的唯一计算处」）——本文件**不重复实现**那个公式：
 *   两份公式会漂移，而漂移**不报错**（两个数都像正常值），
 *   只会让某一路的闸门悄悄变宽 ⇒ **用相似度废掉遗忘曲线**（铁律①要防的那件事）。
 * ⚠️ **字段名与 SQL 的绑定名逐字相同**（`@coarseCutoff` / `@coarseCutoffPinned`）：
 *   「名字即契约」⇒「把 pin 档绑成普通档」这类接错线在读代码时就看得出来。
 * ⚠️ **`includeArchived === true` ⇒ 粗筛整体取消**（§4.6 步骤 2：
 *   「令 `@coarseCutoff = 0`（不设 last_access 粗筛）」）——
 *   本实现**把粗筛片段从 SQL 里去掉**，而不是把阈值设成 0
 *   （设成 0 仍会留下 `last_access >= 0` 这个下界，对负值时间戳仍是筛子）。
 *
 * @param coarse `coarseGateWindow()` 的返回值
 * @returns SQL 绑定参数（粗筛取消时为空 ⇒ 一个键都不绑）
 */
function coarseBindingsOf(coarse: CoarseGateWindow): {
  coarseCutoff?: number;
  coarseCutoffPinned?: number;
} {
  if (!coarse.enabled) {
    return {};
  }
  return {
    coarseCutoff: coarse.coarseCutoff,
    coarseCutoffPinned: coarse.coarseCutoffPinned,
  };
}

/**
 * 应用层精筛 + 截断（§4.6 步骤 2 的「应用层精筛」）。
 *
 * ⚠️ **精筛用 §4.1 的完整公式**（`intensity()` 内含两重钳制：
 *   `Δt = max(0, now - last_access)` 与 `min(1, ·)`）——
 *   ⚠️ **本文件不复制那道公式**：它**直接调用** `src/core/decay.ts` 的 `intensity()` 纯函数
 *   （见本文件的 `import { intensity } from '../core/decay.js'`）
 *   ⇒ 召回侧的强度安全性 **100% 继承**自那个纯函数 ⇒ **不存在「召回侧另有钳制副本」的漂移风险**
 *   （C36：同一件事不得有两套实现）。
 *   ⚠️ **为什么这道钳制是承重的**（ADR-P1-T07-DEC §12.1）：
 *   在**越界输入域**（`τ < 0`，即 `stability` 为负）`min(1, ·)` 是**唯一**拦住 `intensity > 1` 的那道
 *   （`max(0, Δt)` 归零的是 `Δt`、不是 `τ` ⇒ 拦不住）
 *   ⇒ 漏掉它 ⇒ 时钟回拨或注入过去时刻会让 `intensity > 1`，
 *   直接污染 `0.30 × intensity` 与 §4.4 的层级判定。
 *   ⚠️ **而在生产域（`τ ≥ 0`）两道钳制互为冗余** ⇒ 那是**防御性 + 可读性**的选择，不是正确性依赖
 *   ⇒ **不要把「两道都必须存在」写成正确性论证**（详见 `decay.ts` 文件头与 §4.1 的 v2.1 勘误）。
 * ⚠️ **精筛在截断之前**：先按强度剔除归档，再取前 N ⇒ 名额留给还活着的记忆。
 *
 * ⚠️ **归档模式下本精筛整体不执行**（ADR-P1-T08-GAP 小口径③）：
 *   `archiveLine === null` ⇒ **不调用** `passesIntensityFilter`。
 *   ⇒ 原稿的「阈值 = 0.0」与「只过滤 `deleted = 0`」**在数值上不等价**：
 *     精筛是**严格大于**，而 `intensity` 会因 `exp` **下溢成恰好 0.0**
 *     （下溢条件 `Δt / τ > 745 天`；schema 只要求 `stability > 0` ⇒ 常见）
 *     ⇒ 那些行**已经被 SQL 捞进来了**（归档模式无时间窗）却在应用层被悄悄丢掉
 *     ⇒ 「显式查询归档层」**名存实亡**，而且**不报错**。
 *   ⇒ 裁决：**归档模式不做强度精筛**（三路一致，铁律①）。
 *
 * @param rows 该路的原始候选
 * @param archiveLine 精筛阈值（`null` = **不做这个判定**，归档模式）
 * @param now 注入时钟
 * @returns 精筛 + 截断后的候选
 */
function filterAndSlice(
  rows: readonly CandidateRow[],
  archiveLine: number | null,
  now: number,
): CandidateRow[] {
  const kept: CandidateRow[] = [];
  for (const row of rows) {
    // ⚠️ **归档模式直接跳过强度判定**（`archiveLine === null`）——
    //   被放行的记忆照常参与打分与排序（`intensity` 分项照常算，可能接近 0 ⇒ 自然沉底）。
    if (archiveLine !== null) {
      const intensityValue = intensity(
        { stability: row.stability, pin_factor: row.pin_factor, last_access: row.last_access },
        now,
      );
      if (!passesIntensityFilter(intensityValue, archiveLine)) {
        continue;
      }
    }
    kept.push(row);
  }
  return kept.slice(0, ROUTE_CANDIDATE_LIMIT);
}

/** 文本路的结果（候选 + 走了哪条分支）。 */
export interface TextRouteResult {
  rows: CandidateRow[];
  /** 本次文本路走的分支（`none` = 整路没执行）。 */
  route: TextRouteMode;
}

/**
 * 步骤 2a：文本路（FTS5 bigram 检索 + 单字防御）。
 *
 * ⚠️ **判定顺序必须固定**：`matchSql` 非空 → 走 FTS；否则 `fallbackLike` 非空 → 走 LIKE；
 *   否则文本路候选 = `[]`。
 *   ⚠️ **不要写成「先判一个再无条件拼第二个」**——把 null 绑进 `MATCH`
 *   或 `LIKE ('%' || null || '%')`：前者行为依赖 FTS5 版本、后者恒不命中，
 *   **两种都是没法测的静默错误**。
 *
 * @param db 数据库句柄
 * @param context 上下文原文
 * @param includeArchived 是否显式查询归档层
 * @param archiveLine 精筛阈值（`null` = 不做这个判定，归档模式）
 * @param now 注入时钟
 * @returns 文本路候选与分支
 */
function collectTextCandidates(
  db: Database.Database,
  context: string,
  params: Params,
  includeArchived: boolean,
  archiveLine: number | null,
  now: number,
): TextRouteResult {
  const { matchSql, fallbackLike } = buildMatchQuery(context);
  const coarse = coarseGateWindow(params, now, includeArchived);
  const coarseBindings = coarseBindingsOf(coarse);

  // ── 分支 ①：FTS（`matchSql` 非空）──
  if (matchSql !== null && matchSql !== '') {
    const rows = db
      .prepare(buildSql(TEXT_FTS_SQL, coarse))
      .all({ matchSql, ...coarseBindings }) as CandidateRow[];
    return { rows: filterAndSlice(rows, archiveLine, now), route: 'fts' };
  }

  // ── 分支 ②：LIKE 单字兜底（`fallbackLike` 非空）──
  if (fallbackLike !== null && fallbackLike !== '') {
    const rows = db
      .prepare(buildSql(TEXT_LIKE_SQL, coarse))
      .all({ fallbackLike, ...coarseBindings }) as CandidateRow[];
    return { rows: filterAndSlice(rows, archiveLine, now), route: 'like' };
  }

  // ── 分支 ③：两个都为空（单个拉丁字母/数字，§10.2 分支 1b）⇒ 文本路整体不执行 ──
  return { rows: [], route: 'none' };
}

/**
 * 步骤 2b：图谱路（1 跳实体关联）。
 *
 * ⚠️ **实体列表为空 ⇒ 直接跳过这条查询**（不建 SQL）：`IN ()` 是语法错误，
 *   而且语义上「没有上下文实体」就等于「没有任何记忆与上下文有交集」。
 * ⚠️ **无文本相关度可用 ⇒ 按最近使用优先**（`ORDER BY m.last_access DESC`）。
 *
 * @param db 数据库句柄
 * @param entityIds 上下文的 `entity_id` 列表
 * @param includeArchived 是否显式查询归档层
 * @param archiveLine 精筛阈值（`null` = 不做这个判定，归档模式）
 * @param now 注入时钟
 * @returns 图谱路候选
 */
function collectGraphCandidates(
  db: Database.Database,
  entityIds: readonly string[],
  params: Params,
  includeArchived: boolean,
  archiveLine: number | null,
  now: number,
): CandidateRow[] {
  if (entityIds.length === 0) {
    return [];
  }
  const coarse = coarseGateWindow(params, now, includeArchived);
  const coarseBindings = coarseBindingsOf(coarse);
  const rows = db
    .prepare(buildSql(GRAPH_SQL, coarse))
    .all({ entityIds: JSON.stringify(entityIds), ...coarseBindings }) as CandidateRow[];
  return filterAndSlice(rows, archiveLine, now);
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、步骤 2.5：候选去重合并
// ═══════════════════════════════════════════════════════════════════════════

// TODO(P2): 候选去重本该是「三路共用」的共享点（向量路接上后同一 id 会被三路各捞一次），
// 应收敛到公共层（如 `src/core/scoring.ts`）；阶段 1 向量路整路缺席、只有两路 ⇒ 本阶段结构不动，只留欠账。
/**
 * 步骤 2.5：按 `memory_id` 去重，同一个 id 只留一条。
 *
 * ⚠️ **各路分数各自独立保留，不合并、不取平均**（§4.6 步骤 2.5）：
 *   `raw_bm25` 记词法分、`cos` 记语义分——它们是两个不同维度的证据，
 *   合并成一个数就再也拆不开了（`breakdown` 也就没法解释）。
 * ⚠️ **三个来源标记都保留**（`fromText` / `fromVector` / `fromGraph`）：
 *   它们**只为排障与 `explain` 展示，不参与任何计算**。
 * ⚠️ **`graphProximity` 不在本步判定**：统一在步骤 3 按「实体交集」计算
 *   （在本步打标 ⇒ 一条「只被文本路召回但实体确实相交」的候选拿不到 1.0）。
 *
 * @param textRows 文本路候选
 * @param graphRows 图谱路候选
 * @returns 去重后的候选列表（**保持首次出现顺序**，便于断言与排障）
 */
function mergeCandidates(
  textRows: readonly CandidateRow[],
  graphRows: readonly CandidateRow[],
): MergedCandidate[] {
  const byId = new Map<string, MergedCandidate>();

  const upsert = (row: CandidateRow, source: 'text' | 'graph'): void => {
    const existing = byId.get(row.id);
    if (existing === undefined) {
      byId.set(row.id, {
        id: row.id,
        stability: row.stability,
        pin_factor: row.pin_factor,
        last_access: row.last_access,
        created_at: row.created_at,
        rawBm25: row.raw_bm25,
        cos: null,
        fromText: source === 'text',
        fromVector: false,
        fromGraph: source === 'graph',
      });
      return;
    }
    if (source === 'text') {
      existing.fromText = true;
      // ⚠️ **只补不覆盖**：文本路的 `raw_bm25` 是唯一的词法证据来源，
      //   图谱路的 `raw_bm25` 是 `null` ⇒ 用它覆盖会把词法证据抹掉。
      if (existing.rawBm25 === null && row.raw_bm25 !== null) {
        existing.rawBm25 = row.raw_bm25;
      }
      return;
    }
    existing.fromGraph = true;
  };

  for (const row of textRows) {
    upsert(row, 'text');
  }
  for (const row of graphRows) {
    upsert(row, 'graph');
  }
  return [...byId.values()];
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、步骤 3：融合打分（**公式一律来自 `src/core/scoring.ts`**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 步骤 3：对去重后的候选集做五因子融合打分。
 *
 * ⚠️ **五项权重与 sigmoid 斜率一律来自 `scoring.ts`**：本文件**不重复实现**任何打分公式
 *   （重复实现 = 两份规则会漂移）。
 * ⚠️ **`vectorSim` 本阶段恒为 0**：向量路**整路缺席** ⇒ §4.6 步骤 3 的
 *   「无 queryVec ⇒ 全体候选一律 0」生效；**缺项**记 0，**不重算分母**。
 * ⚠️ **`graphProximity` 按「实体交集」判定，不按「候选来自哪条路」判定**：
 *   图路候选有 `LIMIT 100`，一条记忆完全可能与上下文实体有交集、
 *   却因最近使用排在第 100 名之外而没进图路候选——它同时是文本路的高相关命中，
 *   若按「来自哪条路」判，它的 `intensity` 与 `graph` 两项会被判 0 ⇒ **直接被挤出 topN**。
 *
 * @param db 数据库句柄
 * @param candidates 去重后的候选
 * @param entityIds 上下文的 `entity_id` 列表
 * @param textRoute 本次文本路走的分支
 * @param params 生效参数
 * @param now 注入时钟
 * @returns 打分后的候选
 */
function scoreCandidates(
  db: Database.Database,
  candidates: readonly MergedCandidate[],
  entityIds: readonly string[],
  textRoute: TextRouteMode,
  params: Params,
  now: number,
): ScoredCandidate[] {
  const memoryIds = candidates.map((candidate) => candidate.id);

  // ── 词法分：`normBm25` 的三条规则（先命中先返回）──
  const bm25Candidates: Bm25Candidate[] = candidates.map((candidate) => ({
    memoryId: candidate.id,
    rawBm25: candidate.rawBm25,
  }));
  const { normBm25 } = normalizeBm25(bm25Candidates, textRoute);

  // ── 图谱分：一次批量查询（`O(候选数)` 的打标成本，不是 `O(候选数)` 次 IO）──
  const graphProximity = assignGraphProximity(db, memoryIds, entityIds);

  const scored: ScoredCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const intensityValue = intensity(
      {
        stability: candidate.stability,
        pin_factor: candidate.pin_factor,
        last_access: candidate.last_access,
      },
      now,
    );
    const normBm25Value = normBm25[index] ?? 0;
    const graphProximityValue = graphProximity.get(candidate.id) ?? 0;
    const recencyValue = recency(candidate.created_at, params, now);

    // ⚠️ **向量路整路缺席 ⇒ `vectorSim` 恒为 0**（§4.6 步骤 3 的缺项规则）。
    const { score } = fuseScore({
      intensity: intensityValue,
      vectorSim: 0,
      normBm25: normBm25Value,
      graphProximity: graphProximityValue,
      recency: recencyValue,
    });

    scored.push({
      ...candidate,
      score,
      intensityValue,
      normBm25Value,
      graphProximityValue,
      recencyValue,
    });
  }
  return scored;
}

// ═══════════════════════════════════════════════════════════════════════════
// 七、主流程
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `topN` 的钳制（§6：「默认 5，内部限制 1~8」）。
 *
 * ⚠️ **钳制不是报错**：传 0 ⇒ 1；传 100 ⇒ 8。
 *
 * ⚠️ **导出给 `inhibitionTrace` 用**（§6：trace 的 `selected` 必须与 `recall` 的 hits 同口径）
 *   ⇒ 两边各写一份钳制 ⇒ 参数被调大时两边会给出**不同的名额** ⇒ 诊断输出失去意义。
 *
 * @param value 调用方传入的 `topN`
 * @param fallback 缺省值（`RECALL_TOP_N`，来自参数表）
 * @returns 落在 `[1, 8]` 的整数
 */
export function clampTopN(value: number | undefined, fallback: number): number {
  const base = value === undefined || !Number.isFinite(value) ? fallback : Math.trunc(value);
  return Math.min(MAX_TOP_N, Math.max(1, base));
}

/** `context` 的 sha1 哈希（§4.6 步骤 4：**只存哈希不存原文**）。 */
function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════
// 七之二、步骤 1~3 的**共用流水线**（`recall` 与 `inhibitionTrace` 走同一段打分代码）
// ═══════════════════════════════════════════════════════════════════════════

/** 共用流水线的入参（步骤 1~3 需要的全部东西）。 */
export interface CandidatePipelineInput {
  /** 上下文原文（文本路与事件哈希用）。 */
  context: string;
  /** 已解析好的 canonical entity_id 列表（`undefined` = 不传 ⇒ 走名称解析）。 */
  entityIds: string[] | undefined;
  /** 调用方抽好的实体名列表（与 `entityIds` 互斥，§4.6 步骤 1）。 */
  entityNames: string[] | undefined;
  /** 是否显式查询归档层。 */
  includeArchived: boolean;
  /** 注入时钟（C37）。 */
  now: number;
}

/** 共用流水线的产物（步骤 3 的候选 + 诊断所需的计数）。 */
export interface CandidatePipeline {
  /** 步骤 3 的产物：**打分后、未截断**的候选集（§4.13.3 的输入 C）。 */
  scored: ScoredCandidate[];
  /** 归一后的上下文实体 id（`explain` 的图谱路判据）。 */
  contextEntityIds: string[];
  /** 文本路的运行模式与原始行（`explain` 的判据）。 */
  text: TextRouteResult;
  /** 图谱路的候选条数（`explain` 的判据）。 */
  graphCount: number;
}

/**
 * 步骤 1~3 的**共用流水线**（实体名归一 → 三路候选 → 去重合并 → 融合打分）。
 *
 * ★ **为什么抽出来**（§6 的 `inhibitionTrace` 明写「**必须与 recall 走同一段打分代码**——
 *   否则「trace 看到的」和「recall 实际发生的」会漂移」）：
 *   `recall` 与 `inhibitionTrace` 各写一遍打分 ⇒ 两边的候选集与分数会**各自漂移**
 *   ⇒ 「trace 说这条是 0.83、recall 给它 0.81」⇒ 诊断输出失去意义。
 *   ⇒ **只有一处实现**，两边都调它 ⇒ 逐位相同是**结构上**保证的。
 *
 * ⚠️ **纯读**：本函数只发 `SELECT`（**不写库**）⇒ 抑制前后库内容不变（§4.13.1 硬约束②）。
 *
 * @param store 库句柄 + 生效参数
 * @param input 步骤 1~3 的入参
 * @returns 打分后的候选集与诊断计数
 */
export function collectScoredCandidates(
  store: RecallStore,
  input: CandidatePipelineInput,
): CandidatePipeline {
  const db = store.db;
  const params = store.params;
  const archiveLine = input.includeArchived ? null : archiveFilterThreshold(params, false);

  // ── 步骤 1：实体名的**归一**（库不抽取；ADR-P1-T08-GAP 缺口①）──
  const contextEntityIds = resolveContextEntityIds(db, input.entityIds, input.entityNames);

  // ── 步骤 2：三路候选 ──
  const text = collectTextCandidates(
    db,
    input.context,
    params,
    input.includeArchived,
    archiveLine,
    input.now,
  );
  const graph = collectGraphCandidates(
    db,
    contextEntityIds,
    params,
    input.includeArchived,
    archiveLine,
    input.now,
  );
  // ⚠️ 步骤 2c（向量路）：**本阶段整路缺席** —— 不是「向量分全 0」那种降级。

  // ── 步骤 2.5：候选去重合并 ──
  const candidates = mergeCandidates(text.rows, graph);

  // ── 步骤 3：融合打分 ──
  const scored = scoreCandidates(db, candidates, contextEntityIds, text.route, params, input.now);

  return { scored, contextEntityIds, text, graphCount: graph.length };
}

/**
 * `recall(store, options)` —— §4.6 的完整流水线（阶段 1 版）。
 *
 * ⚠️ **本函数默认不写库**（§8.4：「召回是最高频操作，逐次写事件会造成写放大」）：
 *   · `explain === true` ⇒ 记**恰好一条** `recall` 事件；
 *   · `diagnostics === true` ⇒ **不记**事件（只要诊断数据）；
 *   · `explain` 与 `diagnostics` 同为 `true` ⇒ **以 `explain` 为准**（含事件）。
 * ⚠️ **`recall` 绝不写共激活边**（§2 原则⑤ / ADR-19）：
 *   recall 参与共激活 ⇒ topN 自我强化 ⇒ 库锁死在早期话题上。
 * ⚠️ **`recall` 不写 `memories`**（除 `reinforce === true` 的加固）：
 *   加固走 §4.2 的「touch 加固形状」，`reason` 记 `'reinforce'`（不是 `'explicit'`），
 *   且**只加固、不建共激活边**。
 *
 * @param store 库句柄 + 生效参数 + 事件写入器
 * @param options 召回入参（§6 的 `RecallOptions`）
 * @returns 命中 + （可选）诊断
 * @throws {MemoryError} code = `INVALID_INPUT`（`context` 类型不对）
 * @throws {MemoryError} code = `READONLY_VIOLATION`（只读实例上要求 `reinforce`）
 */
export function recall(store: RecallStore, options: RecallOptions): RecallResult {
  const db = store.db;
  const params = store.params;

  // ── 入参校验 ──
  if (typeof options.context !== 'string') {
    throw MemoryError.invalidInput('recall 的 context 必须是字符串', {
      context: {
        current: String(options.context),
        reason: 'context 是召回的唯一文本入口；类型不对会让分词与哈希同时静默失效',
      },
    });
  }
  const context = options.context;

  // ⚠️ **时钟只解析一次**：强度、recency、粗筛窗口、事件时间戳必须基于**同一个时刻**算，
  //   否则两次取值落在毫秒边界两侧会算出「强度属于 t、recency 属于 t+1ms」的视图。
  const at = resolveNow(options.now);
  const topN = clampTopN(options.topN, params.RECALL_TOP_N);
  const includeArchived = options.includeArchived === true;
  const diffuseArchived = options.diffuseArchived !== false;
  // ⚠️ **归档模式下「不做强度精筛」**（ADR-P1-T08-GAP 小口径③）⇒ 阈值取 `null`。
  //   阈值本身仍由 `scoring.ts` 的 `archiveFilterThreshold()` 独家提供（非归档模式）。
  //   ⚠️ **本处不再取阈值**：它已下沉进共用流水线 `collectScoredCandidates()`
  //   （`recall` 与 `inhibitionTrace` 走同一段代码 ⇒ 同一套门槛，§6）。
  const withBreakdown = options.explain === true || options.diagnostics === true;

  // ── 步骤 1~3：实体名归一 + 三路候选 + 去重合并 + 融合打分 ──
  // ⚠️ **走共用流水线**（`inhibitionTrace` 走的是同一段代码 ⇒ 分数逐位相同，§6）。
  const pipeline = collectScoredCandidates(store, {
    context,
    entityIds: options.entityIds,
    entityNames: options.entityNames,
    includeArchived,
    now: at,
  });
  const scored = pipeline.scored;
  const contextEntityIds = pipeline.contextEntityIds;
  const text = pipeline.text;

  // ── 步骤 4.5：侧抑制后置筛选（§4.13 / §4.6 步骤 4.5）──
  // ⚠️ ★ **抑制不进 score**（§4.13.1 硬约束①）：本步骤**只改「谁进 hits」**，
  //   `candidate.score` 一个字节都不动 ⇒ `Hit.score` 恒等于五项加权和。
  // ⚠️ ★ **机制开关**（§5 的 `inhibition`）：关 ⇒ 候选带**不重排**，
  //   直接按 base 分取 topN ⇒ **与 v1.0 逐位一致**（基线条件：四个开关全关）。
  //   ⚠️ **开关是参数表里的机制开关**（`DEFAULT_PARAMS.inhibition`），
  //   **不是** `RecallOptions` 的字段——§6 的 `RecallOptions` 里没有它，
  //   而 §6 是公开契约 ⇒ **不新增第二套开关**（C36：同一件事不得有两套词）。
  const inhibitionEnabled = resolveFlags(params).inhibition;
  const inhibition = inhibitionEnabled
    ? inhibitCandidates(loadInhibitionFacts(db, scored), topN, params)
    : null;

  // ── 步骤 4：排序取 topN ──
  // ⚠️ **排序键带 id**：分数相同者按 id 字典序排 ⇒ 同分时的顺序**可复现**
  //   （否则「同一查询两次结果不同」且无法复现）。
  const ordered = [...scored].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  // ⚠️ **抑制开启时，hits = R 桶**（异质代表集，**已按同一全序排好**）
  //   ⇒ 「宁少不冗余」：R 桶不足 topN 时**不补位**（补位会把刚挤掉的近义内容又塞回来）。
  const keptIds = new Set(inhibition?.kept.map((kept) => kept.id) ?? []);
  const top =
    inhibition === null
      ? ordered.slice(0, topN)
      : ordered.filter((candidate) => keptIds.has(candidate.id));

  // ── 步骤 4.6：联想路 / 激活扩散（§4.7 实体跳 + §4.14 簇跳）──
  // ⚠️ ★ **种子取「抑制前」的 topN**（§4.14.2 + §4.13.1 硬约束③）：
  //   抑制**只作用于 hits** ⇒ 若种子取抑制后的 hits，抑制就会**间接**改变 diffused
  //   ⇒ 「想不起名字但看到照片就想起来」这条通道（§4.7 的 R-ARCH-DIFF）会被抑制关掉。
  //   ⇒ 攻击面 E（抑制开 / 关 ⇒ diffused 逐条相同）**因此才真正可执行**。
  // ⚠️ **种子数 ≤ topN ≤ 8 ≤ MAX_DIFFUSED_NODES(20)**（§4.14.2 的唯一约束 ⇒ 恒满足）。
  const diffusionSeeds = ordered.slice(0, topN).map((candidate) => candidate.id);
  // ⚠️ **机制开关**（§5 的 `coactivation`）：关 ⇒ **联想路与簇跳都不执行**（由 `diffuse()` 内部判定）。
  const diffusion = diffuse({
    db,
    params,
    seedIds: diffusionSeeds,
    now: at,
    diffuseArchived,
  });

  // ── 组装命中（复用 `get()` 的视图映射 ⇒ 与 §6 的 `MemoryView` 逐字一致）──
  const hits: Hit[] = [];
  for (const candidate of top) {
    const view = get(store, candidate.id, at);
    if (view === null) {
      // ⚠️ 理论上不可达（候选都来自 `deleted = 0` 的行）：但仍必须给一个**有类型**的跳过，
      //   而不是让下游拿到 `undefined`（未类型化的崩溃）。
      continue;
    }
    const hit: Hit = {
      ...view,
      score: candidate.score,
      fromText: candidate.fromText,
      fromVector: candidate.fromVector,
      fromGraph: candidate.fromGraph,
    };
    if (withBreakdown) {
      hit.breakdown = {
        // ⚠️ **权重一律取自 `scoring.ts`**（本文件不持有第二份权重表：
        //   两份权重必然漂移，而漂移不会报错、只会让排序静默变形）。
        intensityPart: SCORE_WEIGHTS.intensity * candidate.intensityValue,
        vectorPart: SCORE_WEIGHTS.vectorSim * 0,
        textPart: SCORE_WEIGHTS.normBm25 * candidate.normBm25Value,
        graphPart: SCORE_WEIGHTS.graphProximity * candidate.graphProximityValue,
        recencyPart: SCORE_WEIGHTS.recency * candidate.recencyValue,
        rawBm25: candidate.rawBm25,
        cos: candidate.cos,
      };
    }
    hits.push(hit);
  }

  // ── 组装被抑制的候选（D 桶，§4.13.3）──
  // ⚠️ **只收 D 桶，不收 O 桶**（§4.13.3）：O 桶（溢出）**根本没参与评估** ⇒
  //   它们没有合法的 `redundantWith` ⇒ 标成「被抑制」是**语义污染**。
  const suppressed: RecallSuppressed[] = [];
  for (const entry of inhibition?.redundant ?? []) {
    const view = get(store, entry.candidate.id, at);
    if (view === null) {
      // ⚠️ 理论上不可达（候选都来自 `deleted = 0` 的行）：但仍必须给一个**有类型**的跳过。
      continue;
    }
    const item: RecallSuppressed = {
      id: entry.candidate.id,
      content: view.content,
      // ⚠️ **被抑制前的 score**（抑制不改分数，§4.13.1 硬约束①）。
      score: entry.candidate.score,
      layer: view.layer,
      redundantWith: entry.redundantWith,
      // ⚠️ **reason 只有 `'redundant'` 一种**（§6）：溢出候选不收进 suppressed。
      reason: 'redundant',
    };
    // ⚠️ **`redundancySim` 只在「该对可比」时给出**（双方缺向量 ⇒ 没有可比的相似度）。
    if (entry.redundancySim !== null) {
      item.redundancySim = entry.redundancySim;
    }
    suppressed.push(item);
  }

  // ── 步骤 4 的加固分支（§4.2 的加固形状；只加固、不建共激活边）──
  if (options.reinforce === true && hits.length > 0) {
    if (store.events.readonly) {
      // ⚠️ **只读实例上的真正写操作必须抛 `READONLY_VIOLATION`**（§7.1）：
      //   `appendEvent()` 的短路只覆盖**事件写入**，加固是货真价实的写库。
      throw MemoryError.readonlyViolation(
        'recall({ reinforce: true }) 在只读实例上不可用（加固要写 memories / edges）',
        { operation: 'recall.reinforce' },
      );
    }
    // ⚠️ **reason = 'reinforce'**（不是 `'explicit'`）：调用方只是开了 reinforce 开关，
    //   与「调用方真的确认采纳了这批记忆」是**两件事**⇒ 事后复盘必须能区分。
    touch(
      store,
      hits.map((hit) => hit.id),
      at,
      { reason: 'reinforce' },
    );
  }

  // ── 步骤 4 的事件分支（仅 `explain === true`）──
  if (options.explain === true) {
    const payload: RecallEventPayload = {
      contextHash: sha1Hex(context),
      topN,
      hitIds: hits.map((hit) => hit.id),
      scores: hits.map((hit) => hit.score),
      includeArchived,
      diffuseArchived,
      // ⚠️ **恒带该键**（§4.6 步骤 4）：事后复盘「这次为什么没命中」时，
      //   第一个要排除的就是「向量路根本没跑」——而这个事实在正文与 `scores` 里都看不出来。
      vectorUsed: false,
      // ⚠️ **键恒在**（不省略）：抑制挤掉的候选 id（D 桶）⇒ 事后可对账「谁被挤掉了」。
      //   ⚠️ **溢出候选不在这里**（它们根本没参与评估，§4.13.3）。
      suppressedIds: suppressed.map((item) => item.id),
      // ⚠️ **恒带该键**（§4.6 步骤 4）：`diffusedSeeds` = **真正贡献了扩散结果的种子**。
      //   ⚠️ **不是抑制后的 hits**（§4.13.1 硬约束③：抑制不作用于 diffused）。
      diffusedSeeds: diffusion.seeds,
    };
    // ⚠️ **`memory_id` 传 `null`**（§8.4 的 recall 行：「无（涉及多条记忆，无法单值）」）。
    store.events.appendEvent('recall', null, payload, at);
  }

  const result: RecallResult = {
    hits,
    // ⚠️ **两个字段恒在**（不省略）：调用方需要知道「有 N 条被挤掉了」才能区分
    //   「库里只有 3 条相关」与「有 5 条但 2 条被挤掉」——这是两个不同的产品事实。
    //   ⚠️ **抑制关闭时恒为空**（机制关 ⇒ 候选带不重排，§5）。
    suppressed,
    // ⚠️ **扩散结果恒在**（不省略）：§7 的 R-ARCH-DIFF 规定它是**独立字段**
    //   ⇒ 调用方可整体丢弃，不会污染 hits 的排序与 Token 预算。
    // ⚠️ **抑制不作用于 diffused**（§4.13.1 硬约束③）⇒ 它的内容与 `inhibition` 开关无关。
    diffused: diffusion.items,
  };
  if (withBreakdown) {
    result.explain = {
      routes: {
        // ⚠️ `ran=false` = 本次文本路**整体不执行**（单字拉丁字母分支）。
        text: { ran: text.route !== 'none', candidates: text.rows.length },
        // ⚠️ 本阶段向量路**整路缺席** ⇒ `ran=false`、`candidates=0`。
        vector: { ran: false, candidates: 0 },
        // ⚠️ `ran=false` = 本次没有解析出任何实体。
        graph: { ran: contextEntityIds.length > 0, candidates: pipeline.graphCount },
      },
      // ⚠️ **扩散诊断**（§4.7）：`scanned` = 两腿**合计**处理的边数（§4.14.1 的共享预算）。
      diffusion: {
        scanned: diffusion.scanned,
        belowThreshold: diffusion.belowThreshold,
        skippedNoEntity: diffusion.skippedNoEntity,
        budgetExhausted: diffusion.budgetExhausted,
      },
    };
  }
  return result;
}
