/**
 * ★ 面板的**全部固定文案与格式化函数** —— 阶段 5 · T03（设计 §7.2 / §7.3）。
 *
 * ⚠️ **为什么文案要单独一个文件**（而不是散在 7 个面板里）：
 *   设计 §7.2 对「向量路块」的五条措辞写的是「**逐条固定（不得自行归并或另造措辞）**」。
 *   散在面板里 ⇒ 下一个人改一处措辞没有任何东西会红。
 *   收在一处之后，「措辞」变成**可被测试逐字断言**的东西
 *   （`tests/integration/viewer-panels-text.test.ts` 里另写一份独立副本比对，
 *   **不从本文件 import 期望值** —— 从本文件 import 会让「改了文案」这件事自动通过）。
 *
 * ⚠️ 本文件**只依赖类型**（`MemoryLayer` / `VectorBackendMode`），不 import 任何 React、
 *   不 import `better-sqlite3`、不 import `viewer/main/**`。它是纯函数层，可在 node 里直测。
 *
 * ⚠️ **本文件里不许出现「向量索引损坏」这句措辞**：
 *   面板 3 在无 embedder 时**必须**只标注「本次未执行向量路」，
 *   而「向量索引损坏」会把「没配 embedder」误诊成「库坏了」（PLAN P5-T02 常见坑）。
 *   ⇒ 最省事的守法是**库里根本没有这句话**（谁想写也拼不出来）。
 */

import type { MemoryLayer } from '../../src/core/decay.js';
import type { VectorBackendMode } from '../../src/store/stats.js';
import { MS_PER_DAY } from '../../src/util/time.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、七个面板
// ═══════════════════════════════════════════════════════════════════════════

/** 面板 id（**七个，顺序即导航顺序**）。 */
export type PanelId =
  | 'overview'
  | 'memoryList'
  | 'recallSimulator'
  | 'graphView'
  | 'logViewer'
  | 'versionHistory'
  | 'clusterMap';

/** ★ 七个面板的 id 清单（导航与测试的**唯一分母**）。 */
export const PANEL_ORDER: readonly PanelId[] = [
  'overview',
  'memoryList',
  'recallSimulator',
  'graphView',
  'logViewer',
  'versionHistory',
  'clusterMap',
];

/** 面板标题（逐条对应设计 §7.2 的七个编号）。 */
export const PANEL_TITLES: Readonly<Record<PanelId, string>> = {
  overview: '总览与层级分布',
  memoryList: '记忆列表与详情',
  recallSimulator: '召回模拟器',
  graphView: '图谱可视化',
  logViewer: '只读日志',
  versionHistory: '版本历史',
  clusterMap: '主题簇导航（礁石图）',
};

/** 查看器标题（顶栏）。 */
export const APP_TITLE = '记忆库只读观察器';

// ═══════════════════════════════════════════════════════════════════════════
// 二、§7.3 的共用状态文案
// ═══════════════════════════════════════════════════════════════════════════

/** 只读徽标（顶栏常驻，§7.3「只读模式」一行）。 */
export const READONLY_BADGE = '只读观察器';

/** 加载中的文字（§7.3：骨架屏 + 「计算中」—— `clusters()` 现场重算是几百毫秒量级）。 */
export const LOADING_TEXT = '计算中';

/**
 * 错误态标题。
 *
 * ⚠️ **刻意不是「加载失败」**：设计 §7.3 明写面板不得把库的错误翻译成一句「加载失败」——
 *   必须显示**错误码 + `details`**，否则用户无法区分「库里没有」与「查询错了」。
 */
export const ERROR_HEADING = '库调用失败';

/** 错误码标签。 */
export const ERROR_CODE_LABEL = '错误码';

/** `details` 标签（原样 JSON）。 */
export const ERROR_DETAILS_LABEL = 'details';

/** 错误说明标签。 */
export const ERROR_MESSAGE_LABEL = '说明';

// ═══════════════════════════════════════════════════════════════════════════
// 三、面板 1：向量路块（★ 五条措辞一律不得改写）
// ═══════════════════════════════════════════════════════════════════════════

/** 「向量路」块的标题。 */
export const VECTOR_ROUTE_HEADING = '向量路';

/**
 * ★ **五条固定措辞**（设计 §7.2 面板 1 的表，逐字）。
 *
 * ⚠️ 五种状态而不是四个：`absent` 按 `inRetrain` 分成两条，
 *   因为「分桶未训练」与「分桶重训中」对用户意味着**完全不同**的下一步
 *   （前者去建桶、后者等它跑完）。合并成一句就等于把可观测性又抹掉一半。
 */
export const VECTOR_ROUTE_TEXTS = {
  /** `mode === 'flat_explicit'`。 */
  flat_explicit: '向量路：flat 模式（已显式选择 flat）',
  /** `mode === 'flat_auto'`。 */
  flat_auto: '向量路：flat 模式（库规模 < 1 万条，未建分桶）',
  /** `mode === 'ivf'`。 */
  ivf: '向量路：ivf 模式（两级分桶）',
  /** `mode === 'absent'` 且 `inRetrain === false`。 */
  absent_not_retraining: '向量路不可用（分桶未训练）',
  /** `mode === 'absent'` 且 `inRetrain === true`。 */
  absent_retraining: '向量路不可用（分桶重训中）',
} as const;

/**
 * 按四值枚举给出向量路措辞。
 *
 * ⚠️ ★ **`inRetrain` 只对 `absent` 生效**：`flat_explicit` / `flat_auto` / `ivf` 三个分支
 *   **完全不看** `inRetrain`。
 *   理由（设计 §7.2）：`flat_auto` 时 `inRetrain` **恒为 false**（flat 不建桶 ⇒ 没有重训这件事），
 *   若面板「顺手」用它来分支，就会把一个**完全正常的小库**标成「正在重训」——
 *   而这正是 PLAN P5-T02 的第一条常见坑。
 *   ⇒ 分支形状**先按 mode**，`inRetrain` 只在 `absent` 里出现，
 *     这样「flat 模式下出现重训措辞」在结构上就写不出来。
 */
export function vectorRouteText(mode: VectorBackendMode, inRetrain: boolean): string {
  switch (mode) {
    case 'flat_explicit':
      return VECTOR_ROUTE_TEXTS.flat_explicit;
    case 'flat_auto':
      return VECTOR_ROUTE_TEXTS.flat_auto;
    case 'ivf':
      return VECTOR_ROUTE_TEXTS.ivf;
    case 'absent':
      return inRetrain
        ? VECTOR_ROUTE_TEXTS.absent_retraining
        : VECTOR_ROUTE_TEXTS.absent_not_retraining;
  }
}

/**
 * 该模式下**是否显示「向量索引占用」**。
 *
 * ⚠️ 设计 §7.2：`mode === 'flat'` 模式下**不得显示「向量索引占用」**——
 *   两个 flat 模式（`flat_explicit` / `flat_auto`）**都没有分桶索引**
 *   ⇒ `indexBytes` 即便给了也是无意义的数，显示出来就是一个**假指标**。
 */
export function showsVectorIndexBytes(mode: VectorBackendMode): boolean {
  return mode === 'ivf' || mode === 'absent';
}

/** 「向量索引占用」标签。 */
export const VECTOR_INDEX_BYTES_LABEL = '向量索引占用';

/** 「向量覆盖率」标签（设计 §7.2 面板 1：**必须摆在总览上**）。 */
export const EMBEDDED_RATIO_LABEL = '向量覆盖率';

/** 向量覆盖率偏低时的说明（那是个**看不见的降权**：无向量记忆最高只能得 0.75 分）。 */
export const EMBEDDED_RATIO_HINT =
  '无向量的记忆在召回里最高只能得 0.75 分：覆盖率长期偏低时，「召回不准」其实是根本没走向量路。';

/** 层级分布的标题。 */
export const LAYER_HEADING = '层级分布（按当前时刻现算）';

/** §4.4 的四个层级（顺序 = 从活到死）。 */
export const LAYER_ORDER: readonly MemoryLayer[] = ['L3', 'L2', 'L1', 'archived'];

/** 四个层级的展示名。 */
export const LAYER_LABELS: Readonly<Record<MemoryLayer, string>> = {
  L3: 'L3（高度活跃）',
  L2: 'L2（活跃）',
  L1: 'L1（低活跃）',
  archived: '归档',
};

// ═══════════════════════════════════════════════════════════════════════════
// 四、面板 2：记忆详情与衰减曲线
// ═══════════════════════════════════════════════════════════════════════════

/** 记忆正文标签。 */
export const CONTENT_LABEL = '正文';

/** 关联实体标签。 */
export const ENTITIES_LABEL = '关联实体';

/** 当前强度标签。 */
export const INTENSITY_LABEL = '当前强度';

/** 稳定度标签。 */
export const STABILITY_LABEL = '稳定度 τ（天）';

/** 衰减曲线标题。 */
export const DECAY_HEADING = '强度衰减曲线';

/**
 * 曲线的 τ 说明。
 *
 * ⚠️ **τ 不是半衰期**（§4.1 量纲口径）：`intensity = exp(-t/τ)` 在 `t = τ` 时衰减到 `1/e ≈ 36.8%`。
 *   面板把这个换算直接写在旁边，免得有人把 τ 当半衰期读。
 */
export function decayTauText(tauDays: number): string {
  return `τ = ${formatNumber(tauDays)} 天（时间常数，不是半衰期：半衰期 ≈ ${formatNumber(tauDays * Math.LN2)} 天）`;
}

/** 「距跌出 L3」的文案（已跌出 ⇒ 另一句）。 */
export function dropOutL3Text(remainingMs: number | null): string {
  return remainingMs === null ? '已跌出 L3' : `距跌出 L3 还有 ${formatDuration(remainingMs)}`;
}

/** 「距跌入归档」的文案（已归档 ⇒ 另一句）。 */
export function archiveText(remainingMs: number): string {
  return remainingMs <= 0 ? '已跌入归档' : `距跌入归档还有 ${formatDuration(remainingMs)}`;
}

/** 库里没有这条记忆（`get()` 返回 `null`，**不是**抛错）。 */
export const MISSING_MEMORY_TEXT = '库里没有这条记忆';

// ═══════════════════════════════════════════════════════════════════════════
// 五、面板 3：召回模拟器
// ═══════════════════════════════════════════════════════════════════════════

/** 模拟输入框的占位文字。 */
export const RECALL_PLACEHOLDER = '输入模拟对话文本…';

/**
 * ★ 「本次未执行向量路」 —— 面板 3 在**没有 embedder** 时必须显式标注的那一句。
 *
 * ⚠️ 不标注的后果（PLAN P5-T02）：用户看到 `vectorPart = 0` 会以为**向量检索坏了**，
 *   实际是只读查看器**没有给它算向量的能力**（ADR-10：库内不接模型、不发网络请求）。
 */
export const NO_VECTOR_ROUTE_RAN = '本次未执行向量路';

/** 没有 embedder 时的补充说明（与上一句**同时**出现，不是二选一）。 */
export const NO_EMBEDDER_TEXT =
  '只读查看器未配置 embedder：本次明细里的 vectorPart 恒为 0（这不代表向量索引有问题）。';

/** 打分柱状图的标题。 */
export const SCORE_BARS_HEADING = '打分明细（五项加权分项）';

/** 五项分项的标签（**顺序 = 权重从大到小**，与 §4.6 公式一致）。 */
export const SCORE_FACTOR_LABELS: ReadonlyArray<{
  readonly factor: 'intensityPart' | 'vectorPart' | 'textPart' | 'graphPart' | 'recencyPart';
  readonly label: string;
}> = [
  { factor: 'intensityPart', label: '活跃度' },
  { factor: 'vectorPart', label: '语义' },
  { factor: 'textPart', label: '文本' },
  { factor: 'graphPart', label: '图谱' },
  { factor: 'recencyPart', label: '新近' },
];

/** 原始证据的标签（**并列显示**，不能只看加权后的分项）。 */
export const RAW_BM25_LABEL = 'rawBm25';
/** 原始证据的标签（语义余弦）。 */
export const COS_LABEL = 'cos';

/** 缺失值的占位（**不是 `0`**：`null` 表示「压根没走这条路」，`0` 表示「走了但得 0 分」）。 */
export const NOT_AVAILABLE = '—';

/** 被抑制栏的标题。 */
export const SUPPRESSED_HEADING = '被抑制（未进 topN；抑制不改分数）';

/** 被抑制栏的四列。 */
export const SUPPRESSED_COLUMNS = ['id', '原始 score', 'redundantWith', 'redundancySim'] as const;

/** 没有命中时的空态。 */
export const RECALL_EMPTY_TEXT = '本次召回一条都没有命中';

/** 没有明细（未开启 explain）时的提示。 */
export const NO_BREAKDOWN_TEXT = '本次没有分项明细（库侧未开启 explain）';

// ═══════════════════════════════════════════════════════════════════════════
// 六、面板 4：图谱
// ═══════════════════════════════════════════════════════════════════════════

/** 图谱为空时的提示。 */
export const GRAPH_EMPTY_TEXT = '这条记忆没有关联实体，取不到两跳子图';

/** 抽样说明（**必须显式**：不然用户会以为图就是全部）。 */
export function graphSampleText(edgeCount: number, limit: number): string {
  return `仅显示前 ${limit} 条边（本次取到 ${edgeCount} 条；两跳以内）`;
}

/** 边的表头。 */
export const GRAPH_EDGE_COLUMNS = ['跳跃', '主语', '谓词', '宾语', '权重'] as const;

/** 谓词缺失时的占位。 */
export const GRAPH_PREDICATE_EMPTY = '(无谓词)';

// ═══════════════════════════════════════════════════════════════════════════
// 七、面板 5：只读日志
// ═══════════════════════════════════════════════════════════════════════════

/** 日志为空时的提示。 */
export const LOG_EMPTY_TEXT = '这一天没有匹配的日志';

/** 日志命中行数的说明。 */
export function logTotalText(total: number, offset: number, count: number): string {
  return `命中 ${total} 行，本页第 ${offset + 1}~${offset + count} 行`;
}

/** 日志面板的只读提示（§8.2：日志从不写正文 ⇒ 面板不需要做脱敏）。 */
export const LOG_READONLY_HINT = '日志正文永不包含记忆原文（§8.2），此处不需要脱敏。';

// ═══════════════════════════════════════════════════════════════════════════
// 八、面板 6：版本历史
// ═══════════════════════════════════════════════════════════════════════════

/** 版本历史的标题。 */
export const HISTORY_HEADING = '版本历史（replaced_at 逆序，最新在前）';

/**
 * ★ 软删记忆在版本历史里的标注（设计 §7.2 面板 6 的逐字措辞）。
 *
 * ⚠️ 缺了这句，用户会以为「它已经忘了，怎么正文还在」——
 *   而 `get()` 对软删记录**照常返回**是**有意的**（§8.2：软删后旧正文仍需可查）。
 */
export function softDeletedNotice(deletedAt: number | null): string {
  const at = deletedAt === null ? NOT_AVAILABLE : formatTimestamp(deletedAt);
  return `已遗忘（软删于 ${at}），此处仍可见旧正文`;
}

/** 两种 `content_history.reason` 的说明（设计 §7.2 面板 6 的逐字定义）。 */
export const HISTORY_REASON_TEXTS = {
  merge: 'merge（被 write() 采纳的新文本顶掉）',
  manual_fix: 'manual_fix（被 updateContent() 人工改正）',
} as const;

/** 按 `reason` 给出说明；未知取值原样显示（不隐藏，否则以后加了新 reason 会静默空白）。 */
export function historyReasonText(reason: string): string {
  if (reason === 'merge') return HISTORY_REASON_TEXTS.merge;
  if (reason === 'manual_fix') return HISTORY_REASON_TEXTS.manual_fix;
  return reason;
}

/** 没有历史版本时的空态。 */
export const HISTORY_EMPTY_TEXT = '这条记忆还没有被覆写过，没有历史版本';

/** 分页信息。 */
export function historyPageText(page: number, pageSize: number, total: number): string {
  const pages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return `共 ${total} 版，第 ${page + 1}/${pages} 页（本页 ${from}~${to}）`;
}

/** 当前正文的标签（与历史版本**并列对比**用）。 */
export const CURRENT_CONTENT_LABEL = '当前正文';

/** 历史版本一行的标签。 */
export const HISTORY_REASON_LABEL = '来源';

/** 历史版本替换时间的标签。 */
export const HISTORY_REPLACED_AT_LABEL = '替换时间';

// ═══════════════════════════════════════════════════════════════════════════
// 九、面板 7：礁石图
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ 「上次结果」的基准说明 —— **常驻**（不是折叠在帮助里）。
 *
 * ⚠️ 设计 §7.2 面板 7：跨快照比较**只在进程内做**（§3）⇒ 面板的「上次结果」
 *   是**本次会话内上次打开面板时的结果**，**不是**「上一版已发布快照」。
 *   不说清楚，用户会把它当成「跟上一次落库的快照比」——那是另一个问题、另一个答案。
 */
export const LAST_SNAPSHOT_BASELINE =
  '「上次结果」= 本次会话内上次打开本面板时的结果，不是上一版已发布快照。';

/** 「簇快照」标签。 */
export const CLUSTER_SNAPSHOT_LABEL = '簇快照';

/**
 * ★ 快照新鲜度（设计 §7.2 面板 7：**必须显示**）。
 *
 * ⚠️ 缺了它，用户会把一份**可能过期的划分**当成当前事实。
 *   `computedAt`（生成时刻）与 `asOf`（图的时间点）**不是同一个东西**，
 *   本句只用 `computedAt` —— 「这个快照算出来多久了」才是用户要判断的那件事。
 */
export function clusterFreshnessText(computedAt: number, now: number, stale: boolean): string {
  const relative = formatDuration(Math.max(0, now - computedAt));
  return stale
    ? `${CLUSTER_SNAPSHOT_LABEL}：已过期（最后计算于 ${relative}前）`
    : `${CLUSTER_SNAPSHOT_LABEL}：${relative}前更新`;
}

/** `coverage` 标签。 */
export const CLUSTER_COVERAGE_LABEL = '簇覆盖率';

/** `largestClusterRatio` 标签。 */
export const CLUSTER_LARGEST_RATIO_LABEL = '最大簇占比';

/** 覆盖率的解释（两个数回答的是不同问题，不能合并）。 */
export const CLUSTER_RATIO_HINT =
  '覆盖率回答「簇覆盖了多少记忆」；最大簇占比回答「有没有一个簇吞掉了半个库」。巨型簇不隐藏——它是事实，藏起来比展示它更危险。';

/** 成员列表的抽样说明。 */
export function clusterMemberCapText(rendered: number, total: number): string {
  return `仅显示前 ${rendered} 条成员（该簇共 ${total} 条）`;
}

/** 「展开成员」的字样（放在 `<summary>` 里，**不是按钮**）。 */
export const CLUSTER_MEMBERS_SUMMARY = '成员列表';

/** 「最近两次快照对比」的标题。 */
export const CLUSTER_COMPARISON_HEADING = '最近两次快照对比（按成员重叠度）';

/** 没有上次结果时的提示。 */
export const CLUSTER_NO_PREVIOUS_TEXT = '本次会话内还没有上一次结果，暂无可对比的基准。';

/** 两个簇的重叠度说明。 */
export function clusterOverlapText(overlap: number): string {
  return `成员重叠度 ${formatPercent(overlap)}`;
}

/** 空簇集时的提示。 */
export const CLUSTER_EMPTY_TEXT = '当前没有任何簇（还没有共激活边）';

// ═══════════════════════════════════════════════════════════════════════════
// 十、按钮白名单（★ 三层「无写入口」断言里的第 ② 层）
// ═══════════════════════════════════════════════════════════════════════════

/** 「上一页」。 */
export const BUTTON_PREV = '上一页';
/** 「下一页」。 */
export const BUTTON_NEXT = '下一页';
/** 「模拟召回」（**读**动作：只调 `recall()`，`reinforce` 恒 `false`）。 */
export const BUTTON_RUN_RECALL = '模拟召回';
/** 「刷新快照」（**读**动作：重新调 `clusters()`）。 */
export const BUTTON_REFRESH = '刷新快照';

/**
 * ★ **渲染树里允许出现的 `<button>` 文案白名单**。
 *
 * ⚠️ 为什么要有它：设计 §7.1 第 1、2 条把查看器钉成纯观察器，
 *   而「加一个按钮」是最容易的破口 —— 尤其是「回滚」（面板 7 明令禁止）
 *   与「恢复」（`restore()` 是写方法）。
 *   ⇒ 白名单里**没有**「回滚」「恢复」「删除」「加固」任何一个；
 *     任何新按钮的文案不在这四个里，断言就红。
 *
 * ⚠️ 白名单本身是**可腐化**的（下一个人往数组里加一条就过了）
 *   ⇒ `viewer-panels-structure.test.ts` 里另有一条**写死的反向断言**：
 *     「白名单里不含回滚/恢复/删除/加固」，以及一条**负控**
 *     （拿一段含 `<button>回滚</button>` 的假 markup 过同一个判据，必须命中）。
 */
export const BUTTON_LABELS = [BUTTON_PREV, BUTTON_NEXT, BUTTON_RUN_RECALL, BUTTON_REFRESH] as const;

/** 按钮文案是不是白名单里的一个（运行期守卫，测试与面板共用同一份判据）。 */
export function isButtonLabelAllowed(text: string): boolean {
  return (BUTTON_LABELS as readonly string[]).includes(text.trim());
}

// ═══════════════════════════════════════════════════════════════════════════
// 十一、格式化（★ 全部**确定性**：不接受「今天」这类相对基准，时间一律由调用方注入）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一小时的毫秒数。
 *
 * ⚠️ 这个本地常量**只用于格式化**（不是业务参数），且它是 `MS_PER_DAY / 24`
 *   ⇒ 不构成「第二个时间单位定义」。而 `MS_PER_DAY` 刻意**从 `src/util/time.ts` 导入**
 *   （那里是它的唯一定义，`src/core/decay.ts` 只是 re-export）：格式化器里再写一遍
 *   `86_400_000` 就是第二份定义，改起来必然只改一处。
 */
const MS_PER_HOUR = MS_PER_DAY / 24;

/**
 * 百分比（**一位小数**）。
 *
 * ⚠️ 一位小数是刻意的：`embeddedRatio = 0.4312 ⇒ '43.1%'`，
 *   面板要能把它**原样**显示出来（两位小数会让 43.12% 看起来像精确值，
 *   而这个数本身是 `已嵌向量数 / 未删记忆数`，精度就到不了两位）。
 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return NOT_AVAILABLE;
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 分数（**三位小数**，与 `Hit.score` 的可比精度一致）。 */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return NOT_AVAILABLE;
  return value.toFixed(3);
}

/** 一般数值（去掉无意义的尾零，最多两位小数）。 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return NOT_AVAILABLE;
  return String(Math.round(value * 100) / 100);
}

/** 字节数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NOT_AVAILABLE;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 一段时长（人类可读）。
 *
 * ⚠️ **必须传入差值**（`now - computedAt`），本函数**不读时钟** ⇒ 可在测试里逐字断言。
 */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 60_000) return `${Math.round(value / 1000)} 秒`;
  if (value < MS_PER_HOUR) return `${Math.round(value / 60_000)} 分钟`;
  if (value < MS_PER_DAY) return `${Math.round(value / MS_PER_HOUR)} 小时`;
  return `${(value / MS_PER_DAY).toFixed(1)} 天`;
}

/**
 * 绝对时刻（**UTC**，`YYYY-MM-DD HH:mm:ss UTC`）。
 *
 * ⚠️ 用 UTC 而不是本地时区：面板的快照与本地时区无关，
 *   而本地时区会让同一条历史在两台机器上渲染出不同字符串 ⇒ 快照测试永远飘。
 */
export function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return NOT_AVAILABLE;
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
