/**
 * 事件流的类型定义 —— DESIGN-v2.md §8.4。
 *
 * ⚠️ **13 种 `events.type` 是固定枚举，新增能力只能扩 payload 键**（ADR-15）：
 * SQLite 的 `CHECK` 约束**无法 ALTER** ⇒ 加新 type 要重建 `events` 表 + 重建全部索引与触发器。
 * ⇒ §3 已写明：加新 type 必须同改三处（本文件的枚举 / §3 的 CHECK / §8.4 的对照表）。
 *
 * ⚠️ **正文只在 `events.payload.contentText` 一个键**（§8.2）：
 *   仅 `write` / `merge`(3c) / `manual_fix` 三类可写；其余 10 类**不得**包含 `contentText`。
 */

import type { Params } from './params.js';

/**
 * `events.type` 的 13 种取值（§3 的 CHECK 约束，与 §8.4 的对照表**逐字一致**）。
 *
 * ⚠️ 顺序即 §3 CHECK 约束里的书写顺序，便于逐字比对。
 */
export const EVENT_TYPES = [
  'write',
  'merge',
  'restore',
  'manual_fix',
  'alias',
  'touch',
  'recall',
  'link',
  'pin',
  'unpin',
  'forget',
  'sweep',
  'config',
] as const;

/** `events.type` 的联合类型。 */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * §8.2 的硬规则：**正文只在 `events.payload.contentText` 一个键**。
 *
 * 仅 `write` / `merge` / `manual_fix` 三类可写；其余 10 类**不得**包含 `contentText`。
 */
export const CONTENT_TEXT_KEY = 'contentText';

/** 允许在 payload 里写正文的 3 种 type（§8.2）。 */
export const TYPES_ALLOWING_CONTENT_TEXT: readonly EventType[] = ['write', 'merge', 'manual_fix'];

// ─────────────────────────── 各 type 的 payload ───────────────────────────

/** `write` 事件（§8.4 的 write 行）。 */
export interface WriteEventPayload {
  id: string;
  kind: string;
  /** 正文（仅 write / merge(3c) / manual_fix 三类可写，§8.2）。 */
  contentText: string;
  contentLength: number;
  contentHash: string;
  entityIds: string[];
  emotion: number;
  confidence: number;
  hasEmbedding: boolean;
  initialStability: number;
  initialDifficulty: number;
}

/** `merge` 事件的 **3c 全量**字段集（§8.4 的 merge 行）。 */
export interface MergeEventPayload3c {
  targetId: string;
  intervalDays: number;
  boostApplied: boolean;
  contentText: string;
  contentLength: number;
  contentHash: string;
  prevContentLength: number;
  addedEntities: string[];
  hasEmbedding: boolean;
  stabilityDelta: number;
}

/**
 * `merge` 事件的 **`restore_merge` 子集**字段集（§8.4 的 merge 行）。
 *
 * ⚠️ **刻意少四项**（`intervalDays` / `boostApplied` / 正文四项），不是漏写——
 *   该路径不调 `growStability`、不改写正文 ⇒ 填 `0`/`false` 等于伪造一条
 *   「发生过间隔重复」的假记录，重放会据此算错衰减（§4.8.1 4e）。
 */
export interface MergeEventPayloadRestoreMerge {
  targetId: string;
  addedEntities: string[];
  mergedFrom: string;
  reason: 'restore_merge';
}

/** `merge` 事件的 payload（两套字段集的并集）。 */
export type MergeEventPayload = MergeEventPayload3c | MergeEventPayloadRestoreMerge;

/** 判断一个 merge payload 是不是 `restore_merge` 变体。 */
export function isRestoreMergePayload(
  payload: MergeEventPayload,
): payload is MergeEventPayloadRestoreMerge {
  return (payload as MergeEventPayloadRestoreMerge).reason === 'restore_merge';
}

/** `restore` 事件（§8.4 的 restore 行）。 */
export interface RestoreEventPayload {
  id: string;
}

/** `manual_fix` 事件（§8.4 的 manual_fix 行）。 */
export interface ManualFixEventPayload {
  id: string;
  contentText: string;
  contentLength: number;
  contentHash: string;
  prevContentLength: number;
  hasEmbedding: boolean;
}

/**
 * `alias` 事件（§8.4 的 alias 行 + 表后的「alias 行的字段类型约定」）。
 *
 * ⚠️ **`aliasAdded` 是布尔，不是被降级的主名**（v2.1 勘误）：
 *   设计稿 §4.9.2 步骤 5 原稿写的是 `aliasAdded: sourceName`（字符串），
 *   与本文件原先的 `aliasAdded?: boolean` **直接冲突**——同一个键名两处两套语义。
 *   ⇒ **裁决：`aliasAdded` = 布尔**（本次是否新增/改写了一条「别名 → 实体」映射），
 *     **被降级的源实体主名本体记在 `alias` 键上**。
 *   ⇒ 为什么不反过来（让 `aliasAdded` 装名字）：那样 `alias` 与 `aliasAdded` 会在
 *     `action='set'` / `action='merge'` 两个子变体下**各表示一件事**
 *     （`set` 时 `alias` 是被设置的别名、`merge` 时 `aliasAdded` 是被降级的主名）
 *     ⇒ 一个事件类型两套词，违反 §14.3.1 的 C36。
 *   ⇒ 现在的口径：`alias` 在**两个 action 下都是「本次涉及的别名名」**，语义统一。
 *   ⚠️ **信息一条不丢**：合并会删掉源实体行（§4.9.2 步骤 4）⇒ 它的主名在库里
 *     只剩「别名表」与「事件」两处；`alias` 键保住了名字，`aliasAdded` 键说明了「确实动过别名映射」。
 */
export interface AliasEventPayload {
  action: 'set' | 'merge';
  /**
   * 本次涉及的**别名名**。
   *
   * · `action='set'` ⇒ 被设置的别名（§4.9.2 步骤 4）；
   * · `action='merge'` ⇒ **被降级为别名的源实体主名**（§4.9.2 步骤 5）。
   */
  alias?: string;
  /** `setAlias` 的目标实体 id。 */
  entityId?: string;
  /** `setAlias` 覆盖前的映射目标实体 id（无覆盖则不出现）。 */
  prevEntityId?: string;
  /** `mergeEntities` 的源实体 id（合并后该实体行被删）。 */
  sourceId?: string;
  /** `mergeEntities` 的目标实体 id。 */
  targetId?: string;
  /** 迁移的记忆关联条数（**全部**迁走的行，含目标本来就有的那些）。 */
  movedMemories?: number;
  /**
   * **因三元组冲突而被折叠掉的边数**（§4.9.2 步骤 2）。
   *
   * ⚠️ **只数冲突那一支**：仅改指（无冲突）的边**不计入**——它们是「搬迁」，不是「合并」。
   * ⇒ 可对账恒等式：`合并前的边数 − 合并后的边数 == mergedEdges + droppedSelfLoops`。
   */
  mergedEdges?: number;
  /** 合并后被清掉的自环条数（§4.9.2 步骤 2b）。 */
  droppedSelfLoops?: number;
  /**
   * 本次是否新增/改写了一条「别名 → 实体」映射。
   *
   * ⚠️ **布尔**（不是被降级的主名——主名在 `alias` 键上）。
   * `action='merge'` 恒为 `true`（源主名必然被降级为目标的别名）；
   * `action='set'` **不带**此键。
   */
  aliasAdded?: boolean;
}

/** 共激活对（§8.4 硬规则 3）。 */
export interface CoactPair {
  a: string;
  b: string;
  affinityAfter: number;
}

/** 扩散唤起且被采纳的因果写入（§8.4 硬规则 3）。 */
export interface ActivationWrite {
  diffusedId: string;
  seedId: string;
  affinityAfter: number;
  activatedAt: number;
}

/** 因日守卫或种子无效而**未写入**的关联（§8.4 硬规则 3）。 */
export interface CoactSkipped {
  a: string;
  b: string;
  reason: string;
  hadActivationEvidence: boolean;
}

/**
 * `touch` 事件（§8.4 的 touch 行）。
 *
 * ⚠️ **键的有无就是「这次有没有真的加固」的标志**（§8.4 硬规则 5）：
 * · `stabilityDelta` —— **两个发射点都有**，未增长时为 0，**键恒在**；
 * · `addedEntities` / `embeddingAdded` —— **只在 `exact_repeat` 发射点出现**；
 * · `coactPairs` / `coactPairsTruncated` / `activationWrites` / `coactSkipped`
 *   —— **只在 `explicit` 发射点出现**（§8.4 硬规则 3）。
 *
 * ⚠️ **旧事件重放**：v1.0 的历史事件里后四个键**不存在** ⇒ 重放器一律取 `?? []` / `?? 0`。
 */
export interface TouchEventPayload {
  id: string;
  reason: 'exact_repeat' | 'explicit' | 'reinforce';
  intervalDays: number;
  boostApplied: boolean;
  /** 该记忆作为证据被强化的边数，无则记 0（§4.5 规则 R-EDGE-TOUCH）。 */
  edgesReinforced: number;
  /** 仅 `exact_repeat` 恒有；无新增记 `[]`。 */
  addedEntities?: string[];
  /** 仅 `exact_repeat` 出现，取值 0/1。 */
  embeddingAdded?: number;
  /** 本次 stability 的实际增量（天，`after − before`）；未增长时为 0，**键恒在**。 */
  stabilityDelta: number;
  /** 本次写入的共激活对（仅显式发射点）。 */
  coactPairs?: CoactPair[];
  /** 因上界被丢弃的对数（0 = 没截断；仅显式发射点）。 */
  coactPairsTruncated?: number;
  /** 扩散唤起且被采纳的因果写入（仅显式发射点）。 */
  activationWrites?: ActivationWrite[];
  /** 因日守卫或种子无效而未写入的关联（仅显式发射点）。 */
  coactSkipped?: CoactSkipped[];
}

/** `recall` 事件（§8.4 的 recall 行）。 */
export interface RecallEventPayload {
  contextHash: string;
  topN: number;
  hitIds: string[];
  scores: number[];
  includeArchived: boolean;
  diffuseArchived: boolean;
  vectorUsed: boolean;
  suppressedIds: string[];
  diffusedSeeds: string[];
}

/** `link` 事件（§8.4 的 link 行）。 */
export interface LinkEventPayload {
  subjectId: string;
  predicate: string;
  objectId: string;
  memoryId?: string;
  weightAfter: number;
  autoCreatedEntities: string[];
}

/** `pin` 事件（§8.4 的 pin 行）。 */
export interface PinEventPayload {
  id: string;
  factor: number;
  prevFactor: number;
}

/** `unpin` 事件（§8.4 的 unpin 行）。 */
export interface UnpinEventPayload {
  id: string;
  prevFactor: number;
}

/** `forget` 事件（§8.4 的 forget 行）。 */
export interface ForgetEventPayload {
  id: string;
  hard: boolean;
  /** 仅硬删时有（软删**不带**此键）。 */
  auditContentRetained?: boolean;
}

/**
 * `sweep` 事件的**汇总**字段集（§8.4 的 sweep 行 + 硬规则 4）。
 *
 * ⚠️ `action` 用**同一个 `events.type`** 区分四个维护动作（**不新增 events.type**）。
 */
export interface SweepSummaryEventPayload {
  action: 'purge' | 'rebuildArchive' | 'rebuildBuckets' | 'recluster';
  purged: number;
  archivedCount: number;
  /** = 实际是否执行了 VACUUM，**不是入参回显**（`purged = 0` 时会跳过）。 */
  vacuumed: boolean;
  coactPairsActive: number;
  coactPairsPurged: number;
  clusterCount: number;
  largestClusterRatio: number;
  largestClusterRatioBeforeSplit: number;
  blocksAfterSplit: number;
  /** `action='rebuildArchive'` 的字段集。 */
  scanned?: number;
  repaired?: number;
  /** `action='rebuildBuckets'` 的字段集。 */
  cells?: number;
  members?: number;
}

/**
 * `sweep` 事件的 **`action='rebuildBuckets'`** 字段集（§8.4 硬规则 4）。
 *
 * ⚠️ **为什么单列一个接口**（而不是复用 `SweepSummaryEventPayload`）：
 *   §8.4 硬规则 4 明写「**payload 按 `action` 分组写清字段集**」
 *   ——`action='rebuildBuckets'` 的字段集就是 `cells, members` 两个。
 *   ⇒ 而 `SweepSummaryEventPayload` 把四个 action 的字段**并在一个接口里、且全部必填**
 *   ⇒ 用它写 `rebuildBuckets` 就得**把 `purged` / `vacuumed` / `coactPairsActive` 一并填上**
 *   ⇒ 那等于**伪造**本次重训「清理了 0 条、淘汰了 0 条共激活边」这些**根本没发生**的事实
 *   ⇒ 消费方按 `type='sweep'` 推断「数据被销毁」时会被误导（硬规则 4 的前半段）。
 *   ⇒ 本接口把「按 action 分组」这条规则落到**类型**上。
 */
export interface SweepRebuildBucketsEventPayload {
  /** 维护动作（§8.4：四个维护动作共用同一个 `events.type`）。 */
  action: 'rebuildBuckets';
  /** 新一代的**细桶**数（持有成员的桶）。 */
  cells: number;
  /** 重分配后的**桶归属条数**。 */
  members: number;
}

/**
 * `sweep` 事件的 **`action='recluster'`** 字段集（§8.4 硬规则 4）。
 *
 * ⚠️ **为什么要单列一个接口**（与 `SweepRebuildBucketsEventPayload` 同款理由）：
 *   §8.4 硬规则 4 规定 `action='recluster'` 的字段集**只有**
 *   `clusterCount` 与 `largestClusterRatio` ⇒ 若用 `SweepSummaryEventPayload`，
 *   就得**把 `purged` / `vacuumed` / `coactPairsActive` 一并填上**
 *   ⇒ 那等于**伪造**本次重算「清理了 0 条、淘汰了 0 条共激活边」这些**根本没发生**的事实
 *   ⇒ 消费方按 `type='sweep'` 推断「数据被销毁」时会被误导（硬规则 4 的前半段）。
 * ⇒ 本接口把「按 action 分组」这条规则落到**类型**上。
 */
export interface SweepReclusterEventPayload {
  /** 维护动作（§8.4：四个维护动作共用同一个 `events.type`）。 */
  action: 'recluster';
  /** 本次发布的簇数。 */
  clusterCount: number;
  /** 切分后的最大块占比（「现在有没有大簇」）。 */
  largestClusterRatio: number;
}

/** `sweep` 事件的**逐条**字段集（§8.4 的 sweep 行）。 */
export interface SweepItemEventPayload {
  id: string;
  reason: 'purge_deleted';
  deletedAt: number;
}

/** `sweep` 事件的 payload（逐条 / 汇总两套）。 */
export type SweepEventPayload =
  | SweepItemEventPayload
  | SweepSummaryEventPayload
  | SweepRebuildBucketsEventPayload
  | SweepReclusterEventPayload;

/**
 * `config` 事件的 payload（§8.4 的 config 行）。
 *
 * ⚠️ **构造时与 `setParams()` 时都必须带 `SCHEMA_VERSION` 与 `params`**
 * （`params` = **变更后的完整生效参数**）。
 * · `params` **恒有** —— 它是完整快照；
 * · `changed` **只在 `setParams()` 时有** —— 构造那一刻「没有变更」，
 *   只记 `changed: []` 等于把第 0 步的参数留白，重放时只能拿 `DEFAULT_PARAMS` 反推，
 *   推出来的与实际生效值可能不同，而且不会报错（§8.4 硬规则 2）。
 */
export interface ConfigEventPayload {
  /** schema 版本号（写入 `PRAGMA user_version` 的那个常量，§9.1）——**不是**文档版本号。 */
  SCHEMA_VERSION: number;
  /** 变更后的**完整**生效参数快照。 */
  params: Params;
  /** 本次变更的差异（仅 `setParams()` 事件带；构造事件不带）。 */
  changed?: Array<{ key: string; from: unknown; to: unknown }>;
}

/** 全部事件 payload 的联合类型。 */
export type EventPayload =
  | WriteEventPayload
  | MergeEventPayload
  | RestoreEventPayload
  | ManualFixEventPayload
  | AliasEventPayload
  | TouchEventPayload
  | RecallEventPayload
  | LinkEventPayload
  | PinEventPayload
  | UnpinEventPayload
  | ForgetEventPayload
  | SweepEventPayload
  | ConfigEventPayload;

// ─────────────────────────── payload 键集（§8.4 的逐行声明） ───────────────────────────

/**
 * 每个 `events.type` 的 payload **键集**（§8.4 对照表逐行抄）。
 *
 * ⚠️ 这是「§8.4 声明了、实现点没有」这一整类缺陷的**机械对照物**——
 *   `scripts/check-payload-keys.ts` 会把它与 DESIGN-v2.md §8.4 的表逐键比对（G26 同源纪律）。
 *
 * ⚠️ `merge` 与 `sweep` 有**多套**字段集 ⇒ 键集取**并集**，
 *   分套的字段集见 `EVENT_PAYLOAD_VARIANTS`。
 */
export const EVENT_PAYLOAD_KEYS: Readonly<Record<EventType, readonly string[]>> = {
  write: [
    'id',
    'kind',
    'contentText',
    'contentLength',
    'contentHash',
    'entityIds',
    'emotion',
    'confidence',
    'hasEmbedding',
    'initialStability',
    'initialDifficulty',
  ],
  merge: [
    'targetId',
    'intervalDays',
    'boostApplied',
    'contentText',
    'contentLength',
    'contentHash',
    'prevContentLength',
    'addedEntities',
    'hasEmbedding',
    'stabilityDelta',
    'mergedFrom',
    'reason',
  ],
  restore: ['id'],
  manual_fix: [
    'id',
    'contentText',
    'contentLength',
    'contentHash',
    'prevContentLength',
    'hasEmbedding',
  ],
  alias: [
    'action',
    'alias',
    'entityId',
    'prevEntityId',
    'sourceId',
    'targetId',
    'movedMemories',
    'mergedEdges',
    'droppedSelfLoops',
    'aliasAdded',
  ],
  touch: [
    'id',
    'reason',
    'intervalDays',
    'boostApplied',
    'edgesReinforced',
    'addedEntities',
    'embeddingAdded',
    'stabilityDelta',
    'coactPairs',
    'coactPairsTruncated',
    'activationWrites',
    'coactSkipped',
  ],
  recall: [
    'contextHash',
    'topN',
    'hitIds',
    'scores',
    'includeArchived',
    'diffuseArchived',
    'vectorUsed',
    'suppressedIds',
    'diffusedSeeds',
  ],
  link: ['subjectId', 'predicate', 'objectId', 'memoryId', 'weightAfter', 'autoCreatedEntities'],
  pin: ['id', 'factor', 'prevFactor'],
  unpin: ['id', 'prevFactor'],
  forget: ['id', 'hard', 'auditContentRetained'],
  sweep: [
    'id',
    'reason',
    'deletedAt',
    'action',
    'purged',
    'archivedCount',
    'vacuumed',
    'coactPairsActive',
    'coactPairsPurged',
    'clusterCount',
    'largestClusterRatio',
    'largestClusterRatioBeforeSplit',
    'blocksAfterSplit',
    'scanned',
    'repaired',
    'cells',
    'members',
  ],
  config: ['SCHEMA_VERSION', 'params', 'changed'],
};

/**
 * 多套字段集的分套声明（§8.4 的 merge 行 / sweep 行 / forget 行 / config 行）。
 *
 * ⚠️ **缺键即报错**——「§8.4 声明了、实现点没有」是这一整类缺陷的名字。
 */
export const EVENT_PAYLOAD_VARIANTS: Readonly<
  Partial<Record<EventType, Readonly<Record<string, readonly string[]>>>>
> = {
  merge: {
    // §4.9 步骤 3c 的完整字段集
    merge_3c: [
      'targetId',
      'intervalDays',
      'boostApplied',
      'contentText',
      'contentLength',
      'contentHash',
      'prevContentLength',
      'addedEntities',
      'hasEmbedding',
      'stabilityDelta',
    ],
    // §4.8.1 步骤 4e 的 restore_merge 子集（**无** intervalDays / boostApplied / 正文四项）
    restore_merge: ['targetId', 'addedEntities', 'mergedFrom', 'reason'],
  },
  touch: {
    // §4.2 的 touch() 显式发射点（reason='explicit'；'reinforce' 同此字段集）
    touch_explicit: [
      'id',
      'reason',
      'intervalDays',
      'boostApplied',
      'edgesReinforced',
      'stabilityDelta',
      'coactPairs',
      'coactPairsTruncated',
      'activationWrites',
      'coactSkipped',
    ],
    // §4.9 步骤 2 的完全重复发射点（reason='exact_repeat'）
    touch_exact_repeat: [
      'id',
      'reason',
      'intervalDays',
      'boostApplied',
      'edgesReinforced',
      'addedEntities',
      'embeddingAdded',
      'stabilityDelta',
    ],
  },
  sweep: {
    // 逐条清理
    purge_deleted: ['id', 'reason', 'deletedAt'],
    // 整次汇总（★ 全库唯一权威口径，§4.10 步骤 4 与 §4.12.4 ② 都以它为准）
    summary: [
      'action',
      'purged',
      'archivedCount',
      'vacuumed',
      'coactPairsActive',
      'coactPairsPurged',
      'clusterCount',
      'largestClusterRatio',
      'largestClusterRatioBeforeSplit',
      'blocksAfterSplit',
    ],
    // 硬规则 4：payload 按 action 分组写清字段集
    action_purge: ['purged', 'archivedCount', 'vacuumed', 'coactPairsActive', 'coactPairsPurged'],
    action_rebuildArchive: ['scanned', 'repaired'],
    action_rebuildBuckets: ['cells', 'members'],
    action_recluster: ['clusterCount', 'largestClusterRatio'],
  },
  forget: {
    // 软删**不带** auditContentRetained
    soft: ['id', 'hard'],
    // 硬删才有
    hard: ['id', 'hard', 'auditContentRetained'],
  },
  config: {
    // 构造时的 config 事件：不带 changed
    construct: ['SCHEMA_VERSION', 'params'],
    // setParams() 的 config 事件：带 changed
    set_params: ['SCHEMA_VERSION', 'params', 'changed'],
  },
};

/**
 * `touch` 事件里**只在显式发射点出现**的四个键（§8.4 硬规则 3）。
 *
 * ⚠️ `exact_repeat` 路径**不出现**这四个键；`stabilityDelta` 则**两个发射点都有**。
 */
export const TOUCH_EXPLICIT_ONLY_KEYS: readonly string[] = [
  'coactPairs',
  'coactPairsTruncated',
  'activationWrites',
  'coactSkipped',
];

/**
 * `touch` 事件里**两个发射点都有**的键（§8.4 硬规则 5：「键的有无」就是「有没有真的加固」的标志）。
 */
export const TOUCH_ALWAYS_KEYS: readonly string[] = ['stabilityDelta'];

/**
 * 事件 payload 的键集（运行时取键用）。
 *
 * ⚠️ 未知键不在声明里 ⇒ 那是实现点与 §8.4 漂移的信号。
 */
export function payloadKeysOf(payload: EventPayload): string[] {
  return Object.keys(payload);
}
