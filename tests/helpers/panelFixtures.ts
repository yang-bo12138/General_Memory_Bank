/**
 * ★ 面板测试的**夹具工厂** —— 阶段 5 · T03/T04。
 *
 * ⚠️ **为什么要工厂而不是在测试里写对象字面量**：
 *   `MemoryView` 有 20 个字段、`MemoryStats` 有 20 个、`ClustersResult` 有 14 个 ——
 *   每处都写全量字面量的后果是：**加一个字段就要改 30 处**，
 *   而改漏一处不会报错（`Partial` 会让它悄悄变成 `undefined`）。
 *   ⇒ 缺省值集中在 `BASE_*` 里，测试只写**本例关心的那几个字段**。
 *
 * ⚠️ **全部时间量都相对 `FIXED_NOW`**（写死的 epoch）⇒ 渲染结果与机器时钟无关
 *   ⇒ 快照不会因为「今天是几号」而变。
 *
 * ⚠️ 本文件**不 import** `viewer/main/index.ts` / `viewer/preload/index.ts`
 *   （那两个会 `require('electron')` 并在测试环境抛 *failed to install correctly*）。
 */

import type { MemoryLayer } from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import type { ClusterView, ClustersResult } from '../../src/store/clusters.js';
import type { MemoryView } from '../../src/store/get.js';
import type {
  Hit,
  RecallBreakdown,
  RecallResult,
  RecallSuppressed,
} from '../../src/store/recall.js';
import type { MemoryStats, VectorBackendStats } from '../../src/store/stats.js';
import type {
  LogPage,
  MemoryDetail,
  RecallSimResult,
  SqlRow,
} from '../../viewer/shared/protocol.js';

/** 一天的毫秒数（测试内常量；与 `src/util/time.ts` 同值，但测试不依赖实现）。 */
export const DAY = 86_400_000;

/** ★ 写死的「现在」（2024-01-31T12:00:00Z）—— 所有夹具的时刻都相对它。 */
export const FIXED_NOW = 1_706_702_400_000;

// ═══════════════════════════════════════════════════════════════════════════
// 一、错误夹具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个带 `details` 的 `MemoryError`（**不是** `WorkspaceError`）。
 *
 * ⚠️ 刻意造真的 `MemoryError` 再交给 `asWorkspaceError()`：
 *   这正是面板真实收到的东西（库线程抛 `MemoryError` → 序列化 → 面板还原）
 *   ⇒ 顺带钉住「`details` 会活下来」这件事。
 */
export function makeMemoryError(
  code:
    | 'NOT_FOUND'
    | 'INVALID_INPUT'
    | 'CONFLICT'
    | 'DATABASE_BUSY'
    | 'READONLY_VIOLATION' = 'NOT_FOUND',
  details: Record<string, unknown> = { query: 'contentHistoryPage', memoryId: 'm-404' },
): MemoryError {
  return new MemoryError(code, `夹具错误：${code}`, details);
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、面板 1：MemoryStats
// ═══════════════════════════════════════════════════════════════════════════

/** 造一个 `vectorBackend` 观测块（缺省 `flat_auto`：**正常的小库**）。 */
export function makeVectorBackend(overrides: Partial<VectorBackendStats> = {}): VectorBackendStats {
  const base: VectorBackendStats = {
    mode: 'flat_auto',
    inRetrain: false,
    coarseCells: 0,
    fineCells: 0,
    members: 0,
    maxBucketSize: 0,
    p95BucketSize: 0,
    centroidsUpdatedAt: 0,
    count: 0,
    dimensions: 8,
  };
  return { ...base, ...overrides };
}

/** 造一份 20 字段的 `MemoryStats`。 */
export function makeStats(overrides: Partial<MemoryStats> = {}): MemoryStats {
  const base: MemoryStats = {
    total: 100,
    l3Count: 40,
    l2Count: 30,
    l1Count: 20,
    archivedCount: 10,
    deletedCount: 3,
    edgeCount: 57,
    entityCount: 19,
    vectorBackend: makeVectorBackend(),
    avgStability: 12.5,
    medianStability: 10,
    touchRate7d: 0.25,
    mergeRate: 0.05,
    graphDensity: 0.13,
    adoptedMemories: 61,
    embeddedRatio: 0.4312,
    archivalOrphans: 0,
    archivalMismatch: 0,
    archivalMissing: null,
    coactWriteDrops: 0,
  };
  return { ...base, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、面板 2：MemoryView / MemoryDetail
// ═══════════════════════════════════════════════════════════════════════════

/** 造一条 `MemoryView`（缺省：`stability=10`、`pinFactor=2.5` ⇒ 有效 τ = 25 天）。 */
export function makeMemoryView(overrides: Partial<MemoryView> = {}): MemoryView {
  const base: MemoryView = {
    id: 'm-1',
    content: '张三喜欢猫',
    hasEmbedding: true,
    kind: 'fact',
    layer: 'L3',
    intensity: 0.82,
    stability: 10,
    difficulty: 0.4,
    effectiveStability: 25,
    entities: ['张三', '猫'],
    mediaRef: null,
    mediaType: null,
    createdAt: FIXED_NOW - 40 * DAY,
    lastAccess: FIXED_NOW - 2 * DAY,
    accessCount: 7,
    pinFactor: 2.5,
    confidence: 0.9,
    source: null,
    deleted: false,
    deletedAt: null,
  };
  return { ...base, ...overrides };
}

/**
 * 造一份 `MemoryDetail`（曲线 3 点，够画）。
 *
 * ⚠️ `curve` 的 `t` 是既有 `lastAccess` 到 `archiveAt` 之后的绝对时刻（库线程的算法），
 *   本夹具只是手写 3 点 —— 面板**不做时间计算**，所以点数不影响断言的判别力。
 */
export function makeMemoryDetail(overrides: Partial<MemoryDetail> = {}): MemoryDetail {
  const view = makeMemoryView();
  const start = view.lastAccess;
  const base: MemoryDetail = {
    view,
    curve: [
      { t: start, intensity: 1, layer: 'L3' },
      { t: start + 20 * DAY, intensity: 0.45, layer: 'L2' },
      { t: start + 60 * DAY, intensity: 0.05, layer: 'archived' },
    ],
    layerMarks: { l3: 0.7, l2: 0.4, archived: 0.15 },
    archiveAt: FIXED_NOW + 30 * DAY,
    dropOutL3At: FIXED_NOW + 3 * DAY,
  };
  return { ...base, ...overrides };
}

/** 四层分布的一个 `layer` 字面量（测试里少打几个引号）。 */
export const LAYERS: readonly MemoryLayer[] = ['L3', 'L2', 'L1', 'archived'];

// ═══════════════════════════════════════════════════════════════════════════
// 四、面板 3：RecallSimResult
// ═══════════════════════════════════════════════════════════════════════════

/** 造一份 `Hit.breakdown`；缺省五柱之和 = `0.75`（与 `score` 对齐）。 */
export function makeBreakdown(overrides: Partial<RecallBreakdown> = {}): RecallBreakdown {
  const base: RecallBreakdown = {
    intensityPart: 0.3,
    vectorPart: 0,
    textPart: 0.2,
    graphPart: 0.15,
    recencyPart: 0.1,
    rawBm25: -3.5,
    cos: null,
  };
  return { ...base, ...overrides };
}

/** 五根柱之和（测试里多处要用，收一处）。 */
export function breakdownSum(breakdown: RecallBreakdown): number {
  return (
    breakdown.intensityPart +
    breakdown.vectorPart +
    breakdown.textPart +
    breakdown.graphPart +
    breakdown.recencyPart
  );
}

/** 造一条 `RecallSimResult['hits'][number]`。 */
export function makeRecallHit(
  id: string,
  overrides: Partial<
    Pick<
      Hit,
      | 'content'
      | 'layer'
      | 'intensity'
      | 'score'
      | 'fromText'
      | 'fromVector'
      | 'fromGraph'
      | 'breakdown'
    >
  > = {},
): RecallSimResult['hits'][number] {
  const base = {
    id,
    content: `记忆 ${id} 的正文`,
    layer: 'L3' as MemoryLayer,
    intensity: 0.8,
    score: 0.75,
    fromText: true,
    fromVector: false,
    fromGraph: false,
    breakdown: makeBreakdown(),
  };
  return { ...base, ...overrides };
}

/** 造一条被抑制的候选。 */
export function makeSuppressed(
  id: string,
  overrides: Partial<RecallSuppressed> = {},
): RecallSuppressed {
  const base: RecallSuppressed = {
    id,
    content: `被抑制的 ${id}`,
    score: 0.6,
    layer: 'L2',
    reason: 'redundant',
  };
  return { ...base, ...overrides };
}

/** 造一份面板 3 的结果（缺省：**没有 embedder** ⇒ 本次没走向量路）。 */
export function makeRecallSimResult(overrides: Partial<RecallSimResult> = {}): RecallSimResult {
  const base: RecallSimResult = {
    hits: [makeRecallHit('m-1'), makeRecallHit('m-2', { score: 0.5 })],
    vectorRouteRan: false,
    hasEmbedder: false,
    suppressed: [makeSuppressed('m-3', { redundantWith: 'm-1', redundancySim: 0.93 })],
  };
  return { ...base, ...overrides };
}

/** 一份完整的 `RecallResult`（**库侧**的形状）——用来验证面板只投影它需要的字段。 */
export function makeRecallResult(hits: RecallResult['hits'] = []): RecallResult {
  return { hits, suppressed: [], diffused: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、面板 4 / 6：SQL 行
// ═══════════════════════════════════════════════════════════════════════════

/** 造一条 `graphTwoHop` 的行。 */
export function makeGraphRow(
  hop: 1 | 2,
  subjectName: string,
  predicate: string,
  objectName: string,
  weight = 1,
): SqlRow {
  return {
    hop,
    edge_id: `e-${subjectName}-${objectName}`,
    subject_id: `ent-${subjectName}`,
    subject_name: subjectName,
    predicate,
    object_id: `ent-${objectName}`,
    object_name: objectName,
    weight,
    last_active: FIXED_NOW - DAY,
  };
}

/** 造一条 `content_history` 的行。 */
export function makeHistoryRow(
  id: string,
  content: string,
  reason: 'merge' | 'manual_fix',
  replacedAt: number,
): SqlRow {
  return { id, memory_id: 'm-1', content, reason, replaced_at: replacedAt };
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、面板 5：LogPage
// ═══════════════════════════════════════════════════════════════════════════

/** 造一页日志。 */
export function makeLogPage(
  lines: ReadonlyArray<{ no: number; raw: string; level: 'info' | 'warn' | 'error' }> = [
    { no: 1, raw: '2024-01-31 12:00:00  info  写入  id=m-1', level: 'info' },
    {
      no: 2,
      raw: '2024-01-31 12:00:01  warn  错误  op=recall err=只读模式下事件未落库',
      level: 'warn',
    },
  ],
  total = 2,
): LogPage {
  return { lines, total };
}

// ═══════════════════════════════════════════════════════════════════════════
// 七、面板 7：ClustersResult / ClusterView
// ═══════════════════════════════════════════════════════════════════════════

/** 造一个簇。 */
export function makeClusterView(overrides: Partial<ClusterView> = {}): ClusterView {
  const memberIds = overrides.memberIds ?? ['m-1', 'm-2', 'm-3'];
  const base: ClusterView = {
    key: memberIds[0] ?? 'm-1',
    clusterId: 'c-1',
    label: '张三 / 猫',
    size: memberIds.length,
    memberIds,
    representativeId: memberIds[0] ?? 'm-1',
    entities: ['张三', '猫', '投喂'],
    meanAffinity: 0.7,
    maxAffinity: 0.95,
    strength: 4.2,
    lastActive: FIXED_NOW - DAY,
  };
  return { ...base, ...overrides };
}

/** 造一份 `ClustersResult`（缺省：1 个簇、覆盖率 0.5、最大簇占比 0.3、不 stale）。 */
export function makeClustersResult(overrides: Partial<ClustersResult> = {}): ClustersResult {
  const base: ClustersResult = {
    largestClusterRatio: 0.3,
    maxRawComponentRatio: 0.35,
    clusters: [makeClusterView()],
    asOf: FIXED_NOW - 2 * 3_600_000,
    computedAt: FIXED_NOW - 2 * 3_600_000,
    algoVersion: 1,
    stale: false,
    totalClusters: 1,
    coveredMemories: 50,
    adoptedMemories: 60,
    totalMemories: 100,
    totalMembers: 3,
    seedOnlyMemories: 8,
    coverage: 0.5,
    coverageOverAdopted: 0.7,
  };
  return { ...base, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════
// 八、HTML 断言工具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把一段文本按 React 的转义规则转成它在 markup 里的样子。
 *
 * ⚠️ **为什么必须有它**：`renderToStaticMarkup` 会把文本里的 `<` `>` `&` `"` `'` 转义，
 *   而设计里「库规模 < 1 万条」这条措辞**带 `<`** ⇒ 直接 `toContain('库规模 < 1 万条')`
 *   会**恒红**（不是实现错了，是断言写错了）。
 *   ⇒ 期望值一律先过 `escapeHtml()` 再比对；这样「期望值是独立手写的」这条依然成立。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** 抽出所有匹配某个 `data-*` 属性的值（按出现顺序）。 */
export function attributeValues(html: string, attribute: string): string[] {
  const pattern = new RegExp(`${attribute}="([^"]*)"`, 'g');
  const out: string[] = [];
  for (const match of html.matchAll(pattern)) {
    out.push(match[1] ?? '');
  }
  return out;
}

/**
 * 抽出「柱状图容器」的 `data-memory-id`（按出现顺序）。
 *
 * ⚠️ 判据绑在 `data-chart="score-bars"` 上，**不是**「页面里所有 `data-memory-id`」：
 *   被抑制的行用的是 `data-suppressed-id`，两者必须能被分开数，
 *   否则「被抑制项有没有混进柱状图」这条断言本身就分不清两边。
 */
export function scoreBarMemoryIds(html: string): string[] {
  return attributeValues(html, 'data-chart="score-bars"\\s+data-memory-id');
}

/** 抽出五根柱的 `[factor, 原始值, 展示串]`。 */
export function scoreBarRows(html: string): Array<[string, number, string]> {
  const pattern = /data-factor="([a-zA-Z]+)"\s+data-value="([^"]*)"\s+data-value-text="([^"]*)"/g;
  const out: Array<[string, number, string]> = [];
  for (const match of html.matchAll(pattern)) {
    out.push([match[1] ?? '', Number(match[2] ?? 'NaN'), match[3] ?? '']);
  }
  return out;
}
