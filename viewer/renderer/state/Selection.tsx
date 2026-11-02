/**
 * ★ **「选哪一条记忆」这一段的三个共用件** —— 阶段 5 · P5-T04 的可用性修复。
 *
 * ★ **它修的是什么缺陷（先说清，否则看不出这几个件为什么存在）**：
 *   改之前 `viewer/renderer/App.tsx` 把 `selection.memoryId` **写死为空串**，
 *   而全 renderer **没有任何入口**能改它 —— 于是：
 *     · 面板 2（记忆详情）⇒ 永远渲染「库里没有这条记忆」，一个控件都救不了；
 *     · 面板 4（图谱）⇒ `graphTwoHop { memoryId: '' }` ⇒ 图恒空；
 *     · 面板 6（版本历史）⇒ `contentHistoryCount` 恒 0 ⇒ **上一页 / 下一页永久 disabled**。
 *   `memoryId` 是那三个面板的**唯一取数键** ⇒ 没有入口 = 那三个面板全是死页面。
 *
 * ★ 本文件提供三件东西，**面板 2 / 4 / 6 共用同一份**（不各写一套）：
 *   ① `loadRecentMemories()` —— 「最近记忆」的唯一取数（`select('recentMemories')`）；
 *   ② `projectRecentMemories()` —— 行 → 列表条目的**纯函数**投影（无 DOM 可测）；
 *   ③ `NoSelectionPanel` / `MemoryPicker` —— 「尚未选择记忆」的引导与选择器。
 *
 * ⚠️ **为什么放在 `state/` 而不是 `panels/`**：
 *   `panels/` 的文件清单被 `viewer-panels-structure.test.ts` 钉死为
 *   「七个面板 + 已登记部件」—— 放进去就要改那张清单，而本文件是**三个面板共用的部件**，
 *   它本来就不属于任何一个面板（与 `StatusBlock.tsx` 同级同理）。
 *
 * ⚠️ **本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`**，
 *   也不写 `try/catch`（错误统一由 `useReadCall` → `StatusBlock` 处理）；
 *   列表条数**只来自常量** `RECENT_MEMORY_LIMIT`（渲染层不许出现那份字面量）。
 */

import type { ReactElement, ReactNode } from 'react';

import { RECENT_MEMORY_LIMIT } from '../../shared/limits.js';
import type { ReadPort, SqlRow } from '../../shared/protocol.js';
import {
  BUTTON_NEXT,
  BUTTON_PREV,
  BUTTON_VIEW_ID,
  ERROR_DETAILS_LABEL,
  LOADING_TEXT,
  MEMORY_ID_INPUT_LABEL,
  MEMORY_ID_INPUT_PLACEHOLDER,
  NO_MEMORY_SELECTED_TEXT,
  RECENT_LAST_ACCESS_LABEL,
  RECENT_MEMORY_EMPTY_TEXT,
  RECENT_MEMORY_ERROR_TEXT,
  RECENT_MEMORY_HEADING,
  RECENT_STABILITY_LABEL,
  SELECT_MEMORY_GUIDE_TEXT,
  formatNumber,
  formatTimestamp,
} from '../texts.js';
import type { ReadState } from './useReadCall.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、取数：最近记忆（`recentMemories` 的唯一调用点）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 读「最近记忆」列表。
 *
 * ⚠️ **`limit` 由本文件显式传常量**，不指望库线程的缺省值：
 *   调用点看不见的缺省值是「改了常量也不会有人重读」的那种契约。
 * ⚠️ 它**不带 `memoryId`**：列表的语义是「库里最近的若干条」，
 *   参数形状见 `viewer/shared/sql-names.ts` 的 `recentMemories`。
 * ⚠️ 空库 ⇒ 返回 `[]`（**不抛错**）：面板据此渲染明确的空态文案。
 *
 * @param port 读端口（renderer 只拿得到它的 8 个读方法）
 * @returns `recentMemories` 的原始行（投影交给 `projectRecentMemories`）
 */
export async function loadRecentMemories(port: ReadPort): Promise<ReadonlyArray<SqlRow>> {
  return port.select('recentMemories', { limit: RECENT_MEMORY_LIMIT });
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、投影：行 → 列表条目（纯函数，无 DOM 可测）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 列表一行里正文摘要的最大字数。
 *
 * ⚠️ 截断在**渲染层**做（SQL 里不做字符串手术）：库那边只负责「取哪几行」，
 *   「一行显示多长」是界面的事。
 */
export const RECENT_SUMMARY_MAX_CHARS = 40;

/** 列表的一行（**逻辑与展示之间唯一的形状**）。 */
export interface RecentMemoryEntry {
  /** 记忆 id（选中它 ⇒ 面板 2 / 4 / 6 换到那一条）。 */
  readonly id: string;
  /** 正文摘要（过长截断并加省略号；空正文 ⇒ 空串，界面显示占位）。 */
  readonly summary: string;
  /** 上次访问时刻（epoch 毫秒；非数值 ⇒ 0，渲染时显示占位）。 */
  readonly lastAccess: number;
  /** 稳定度 τ（天；非数值 ⇒ 0）。 */
  readonly stability: number;
}

/** 从一行里安全取一个字符串（`SqlRow` 的值是 `string | number | null`）。 */
function textOf(row: SqlRow, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

/** 从一行里安全取一个数字（非有限值 ⇒ `fallback`）。 */
function numberOf(row: SqlRow, key: string, fallback: number): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 把 `recentMemories` 的行投影成列表条目。
 *
 * ⚠️ **`id` 为空的行被丢掉**：它是「点不中」的行（点了也不会换选中项），
 *   留着只会让用户点一下发现没反应。
 * ⚠️ **顺序保持 SQL 给的顺序**（`last_access DESC`）：面板**不再排一遍**——
 *   两处各排一次，第二处迟早会漏掉 `id ASC` 这个全序键。
 * ⚠️ 本函数**不读时钟、不读库**：同输入两次调用逐字段相同（可断言）。
 *
 * @param rows `select('recentMemories', …)` 的原始行
 * @returns 列表条目（只读数组）
 */
export function projectRecentMemories(
  rows: ReadonlyArray<SqlRow>,
): ReadonlyArray<RecentMemoryEntry> {
  const entries: RecentMemoryEntry[] = [];
  for (const row of rows) {
    const id = textOf(row, 'id');
    if (id === '') {
      continue;
    }
    const content = textOf(row, 'content');
    const summary =
      content.length > RECENT_SUMMARY_MAX_CHARS
        ? `${content.slice(0, RECENT_SUMMARY_MAX_CHARS)}…`
        : content;
    entries.push({
      id,
      summary,
      lastAccess: numberOf(row, 'last_access', 0),
      stability: numberOf(row, 'stability', 0),
    });
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、「尚未选择记忆」的引导（面板 2 / 4 / 6 共用）
// ═══════════════════════════════════════════════════════════════════════════

/** `NoSelectionPanel` 的入参。 */
export interface NoSelectionPanelProps {
  /** 面板标题（来自 `PANEL_TITLES`，**不另写一套短名**）。 */
  readonly title: string;
  /** 面板体标记（与就绪态的 `data-panel-body` 同名 ⇒ 「这一块渲染出来了」的判据不变）。 */
  readonly bodyId: string;
  /**
   * 是否额外画一条「两个按钮都 disabled」的分页条（**只有面板 6 用**）。
   *
   * ⚠️ ★ 为什么面板 6 要在「尚未选择记忆」时**画出**分页条：
   *   它是「版本历史不可用」这件事的**可见形态** —— 用户能看见两个按钮在那里、
   *   且**确实是灰的**（`disabled`），而不是「按钮凭空消失，不知道是坏了还是没有」。
   *   而「有记忆时它不 disabled」由 `versionHistory` 的那条成对断言钉住。
   */
  readonly inertPager?: boolean | undefined;
  /**
   * 引导文案下面**额外**渲染的东西（面板 2 用它塞「最近记忆 + 按 id 查看」选择器）。
   *
   * ⚠️ 用 `children` 而不是让面板自己再包一层 `<div data-panel-body>`：
   *   「一个面板体」这条断言数的是 `data-panel-body` 的出现次数
   *   ⇒ 多包一层就会让那个面板看起来渲染了两块。
   */
  readonly children?: ReactNode | undefined;
}

/**
 * 「尚未选择记忆」的引导块。
 *
 * ⚠️ ★ **它与「库里没有这条记忆」是两件事**（这正是本次修复的核心差异）：
 *   本块说的是「**还没选**」⇒ 必须告诉用户**去哪选**；
 *   `MISSING_MEMORY_TEXT` 说的是「选了一条，但库里没有」⇒ 那才是查不到。
 *   两者混用 ⇒ 面板一打开就像报了错，而真相是「这个应用原先没有选择入口」。
 */
export function NoSelectionPanel({
  title,
  bodyId,
  inertPager,
  children,
}: NoSelectionPanelProps): ReactElement {
  return (
    <div className="panel" data-panel-body={bodyId} data-state="no-selection">
      <h2 className="panel__title">{title}</h2>
      <p className="panel__empty" data-no-memory-selected="">
        {NO_MEMORY_SELECTED_TEXT}
      </p>
      <p className="overview__hint" data-select-guide="">
        {SELECT_MEMORY_GUIDE_TEXT}
      </p>
      {inertPager === true ? (
        <div className="panel__pager" data-pager-block="inert">
          <button type="button" data-pager="prev" disabled>
            {BUTTON_PREV}
          </button>
          <button type="button" data-pager="next" disabled>
            {BUTTON_NEXT}
          </button>
        </div>
      ) : null}
      {children === undefined ? null : children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、选择器：最近记忆列表 + 「按 id 查看」输入框（面板 2 顶部）
// ═══════════════════════════════════════════════════════════════════════════

/** `MemoryPicker` 的入参。 */
export interface MemoryPickerProps {
  /** 「最近记忆」的读状态（**只在这里读一次**，面板 1 若要用就复用同一份）。 */
  readonly recent: ReadState<ReadonlyArray<SqlRow>>;
  /** 当前选中项（用来标出「你现在看的是哪一条」）。 */
  readonly currentId: string;
  /** 「按 id 查看」输入框的内容（受控 ⇒ 由容器持有）。 */
  readonly draft: string;
  /** 输入框变更（不传 ⇒ 输入框只读，SSR 也能渲染）。 */
  readonly onDraftChange?: ((value: string) => void) | undefined;
  /** 提交输入框里的 id（不传 ⇒ 按钮仍渲染，但点了没动作）。 */
  readonly onSubmitId?: (() => void) | undefined;
  /** 点了「最近记忆」的一行（不传 ⇒ 行不可点）。 */
  readonly onPick?: ((id: string) => void) | undefined;
}

/**
 * 面板 2 顶部的**选择器**：最近记忆列表 + 「按 id 查看」。
 *
 * ★ **两个入口缺一不可**：
 *   ① 列表让用户「看见有什么」并点一条（正常路径）；
 *   ② 输入框是**兜底**：列表空了（新库 / 刚被清过）或者用户手里已经有一个 id 时，
 *      仍然能看 —— 只有列表的话，空库就成了死路。
 *
 * ⚠️ 两者的语义都收敛到 `state/navigation.ts` 的 `nextMemoryId()`（有单测）：
 *   空输入不清空当前选中项、重复点同一条返回同一引用（不多余重渲染）。
 * ⚠️ 本组件**没有任何写动作**：两个入口都只改**本地**选中项。
 */
export function MemoryPicker({
  recent,
  currentId,
  draft,
  onDraftChange,
  onSubmitId,
  onPick,
}: MemoryPickerProps): ReactElement {
  const entries = recent.status === 'ready' ? projectRecentMemories(recent.data) : [];
  const canSubmit = draft.trim() !== '';

  return (
    <section className="memory-picker" data-memory-picker="">
      <h3 className="memory__heading">{RECENT_MEMORY_HEADING}</h3>

      {recent.status === 'loading' ? (
        <p className="overview__hint" data-recent-loading="">
          {LOADING_TEXT}
        </p>
      ) : null}

      {recent.status === 'error' ? (
        <p className="panel__empty" data-recent-error="" data-error-code={recent.error.code}>
          {RECENT_MEMORY_ERROR_TEXT}（{recent.error.code}）
          <span className="status__label"> {ERROR_DETAILS_LABEL}：</span>
          {JSON.stringify(recent.error.details)}
        </p>
      ) : null}

      {recent.status === 'ready' && entries.length === 0 ? (
        <p className="panel__empty" data-recent-empty="">
          {RECENT_MEMORY_EMPTY_TEXT}
        </p>
      ) : null}

      {entries.length === 0 ? null : (
        <ol className="memory-picker__list" data-recent-list="">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="memory-picker__item"
              data-recent-id={entry.id}
              data-current={entry.id === currentId ? 'true' : 'false'}
            >
              <button
                type="button"
                className="memory-picker__pick"
                data-pick-memory={entry.id}
                aria-pressed={entry.id === currentId}
                onClick={() => {
                  (onPick ?? noop)(entry.id);
                }}
              >
                {entry.summary === '' ? entry.id : entry.summary}
              </button>
              <span className="status__label">{RECENT_STABILITY_LABEL}</span>
              <span data-field="recent-stability" data-value={entry.stability}>
                {formatNumber(entry.stability)}
              </span>
              <span className="status__label">{RECENT_LAST_ACCESS_LABEL}</span>
              <span data-field="recent-last-access" data-value={entry.lastAccess}>
                {formatTimestamp(entry.lastAccess)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <form
        className="memory-picker__form"
        data-memory-id-form=""
        onSubmit={(event) => {
          // ⚠️ 阻止整页刷新：这是个 SPA，提交只改本地选中项
          event.preventDefault();
          (onSubmitId ?? noop)();
        }}
      >
        <label className="status__label" htmlFor="memory-id-input">
          {MEMORY_ID_INPUT_LABEL}
        </label>
        <input
          id="memory-id-input"
          className="memory-picker__input"
          data-field="memory-id-input"
          type="text"
          value={draft}
          placeholder={MEMORY_ID_INPUT_PLACEHOLDER}
          onChange={(event) => {
            (onDraftChange ?? noop2)(event.target.value);
          }}
        />
        <button type="submit" data-submit-memory-id="" disabled={!canSubmit}>
          {BUTTON_VIEW_ID}
        </button>
      </form>
    </section>
  );
}

/** 什么都不做的回调（只读渲染时的缺省值）。 */
function noop(): void {
  /* 逻辑在被单测的纯函数（`nextMemoryId`）里 */
}

/** 什么都不做的「值变更」回调（形状与 `onDraftChange` 一致）。 */
function noop2(_value: string): void {
  /* 受控输入的真正实现由容器传入（`useState` 的 setter） */
}
