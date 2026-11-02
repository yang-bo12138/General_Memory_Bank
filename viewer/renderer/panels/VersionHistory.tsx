/**
 * ★ 面板 6 · **版本历史（`content_history`）** —— 阶段 5 · T04（设计 §7.2 面板 6 / §4.9）。
 *
 * ★ **这是 §4.9「无条件采纳新文本」之后旧版本的唯一查看入口**：
 *   `content_history` 不参与召回，§6 也刻意不提供读历史正文的公开方法
 *   ⇒ **面板缺了，那份兜底就不可达**。所以它不是「查看器的锦上添花」，
 *     而是「每次合并都会走一次的那条路径」的配套。
 *
 * 五个硬点：
 *   ① ★ **软删记忆在此面板仍可见旧正文**，且**必须**标注
 *      「已遗忘（软删于 X），此处仍可见旧正文」——
 *      否则用户会以为「它已经忘了，怎么正文还在」（`get()` 对软删照常返回是**有意的**）。
 *   ② **按 `replaced_at` 逆序**（最新在前）：排序在 SQL 里做（`ORDER BY replaced_at DESC, id DESC`），
 *      面板**不再排一遍** —— 两处各排一次，第二处迟早会漏掉 `id DESC` 这个全序键，
 *      而后果是**分页在页边重复 / 漏行**。
 *   ③ **分页取最近 50 版**：`content_history` 的上限**不受控**（§4.9：它单调增长）
 *      ⇒ 一次性全取会在被反复提及的记忆上**卡住界面**。页大小来自 `CONTENT_HISTORY_PAGE_SIZE`。
 *   ④ 每版显示 `reason`（`merge` = 被 `write()` 采纳的新文本顶掉 / `manual_fix` = 被
 *      `updateContent()` 人工改正）与替换时间。
 *   ⑤ **不放「回滚」按钮**：还原由人复制旧正文后**显式**调 `updateContent()` 完成。
 *      面板若能一键回滚，就等于在只读观察器里开了一个写入口（§7.1 第 1、2 条）。
 *
 * ★ **本文件含交互层**（阶段 5 · T04 补遗）：「更早的按需加载」是 PLAN 面板 6 的原文要求，
 *   呈现层只渲染按钮是不够的 —— 按钮必须真的取下一页。
 *   两种动作**语义不同**，代码里也分开：
 *     · 「上一页 / 下一页」= **移窗口**（只显示那一页，`loaded` 被替换）；
 *     · 「加载更早的版本」= **累积**（`appendPage` 往已加载列表尾部追加，**不替换**）。
 *   ⚠️ 累积上限是 `total`（不是页数）：到了就**不再渲染**这个按钮，
 *     而不是渲染一个点了没用的按钮（那是更坏的默认）。
 *
 * ⚠️ 本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`，也不写 `try/catch`。
 */

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { MemoryView } from '../../../src/store/get.js';
import { CONTENT_HISTORY_PAGE_SIZE } from '../../shared/limits.js';
import type { MemoryDetail, ReadPort, SqlRow } from '../../shared/protocol.js';
import { NoSelectionPanel } from '../state/Selection.js';
import { StatusBlock } from '../state/StatusBlock.js';
import { appendPage, isMemorySelected, nextPage, prevPage } from '../state/navigation.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
  BUTTON_LOAD_OLDER,
  BUTTON_NEXT,
  BUTTON_PREV,
  CURRENT_CONTENT_LABEL,
  HISTORY_EMPTY_TEXT,
  HISTORY_HEADING,
  HISTORY_LOADED_ALL,
  HISTORY_REASON_LABEL,
  HISTORY_REPLACED_AT_LABEL,
  PANEL_TITLES,
  formatTimestamp,
  historyLoadedText,
  historyPageText,
  historyReasonText,
  softDeletedNotice,
} from '../texts.js';

/** 面板 6 的一页历史。 */
export interface HistoryPage {
  /** 本页的行（**库侧已按 `replaced_at` 逆序**，面板不再排序）。 */
  readonly rows: ReadonlyArray<SqlRow>;
  /** 总版本数（分页控件要分母）。 */
  readonly total: number;
  /** 当前页号（0 起）。 */
  readonly page: number;
}

/**
 * 面板 6 的读调用：**一次取一页 + 一次取总数**。
 *
 * ⚠️ 两条查询都带 `LIMIT`（本仓库「每一条 SQL 都带 LIMIT」的不变量）：
 *   分页那条绑 `CONTENT_HISTORY_PAGE_SIZE`（= 50），聚合那条绑 `1`。
 * ⚠️ `limit` 由**本文件**显式传 50，而不是指望库线程的缺省值：
 *   调用点看不见的缺省值是「改常量也不会有人重读」的那种契约。
 */
export async function loadHistoryPage(
  port: ReadPort,
  memoryId: string,
  page: number,
): Promise<HistoryPage> {
  const rows = await port.select('contentHistoryPage', {
    memoryId,
    limit: CONTENT_HISTORY_PAGE_SIZE,
    offset: page * CONTENT_HISTORY_PAGE_SIZE,
  });
  const counted = await port.select('contentHistoryCount', { memoryId, limit: 1 });
  const firstCount = counted[0];
  const total = firstCount === undefined ? rows.length : Number(firstCount.total ?? rows.length);
  return { rows, total: Number.isFinite(total) ? total : rows.length, page };
}

/** 从一行历史里取字段。 */
function textOf(row: SqlRow, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

/** 替换时刻（非数值 ⇒ 0，渲染时显示占位）。 */
function replacedAtOf(row: SqlRow): number {
  const value = row.replaced_at;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `VersionHistoryView`（纯展示）的入参。 */
export interface VersionHistoryViewProps {
  /** 本页历史的读状态（`rows` 可能是**累积后**的列表）。 */
  readonly state: ReadState<HistoryPage>;
  /** 当前记忆视图（`null` = 库里没有这条）；**软删标注靠它**。 */
  readonly current: MemoryView | null;
  /** 注入的当前时刻（只用于文案）。 */
  readonly now: number;
  /** 「加载更早的版本」—— 不传 ⇒ 不渲染该按钮。 */
  readonly onLoadOlder?: (() => void) | undefined;
  /** 上一页（移窗口）。 */
  readonly onPrev?: (() => void) | undefined;
  /** 下一页（移窗口）。 */
  readonly onNext?: (() => void) | undefined;
  /**
   * ★ **尚未选择记忆**（P5-T04）—— 不传 ⇒ 照旧渲染历史（既有调用点全部不受影响）。
   *
   * ⚠️ 为什么它必须是一个**独立开关**而不是「`memoryId` 为空就切换」：
   *   `*View` 是纯展示层，它拿不到也不该拿「选中项」这个概念（那是 `App` 的状态）；
   *   由容器算好 `isMemorySelected(memoryId)` 再传下来，这一层的入参就只有布尔。
   */
  readonly noSelection?: boolean | undefined;
}

/** 一个什么都不做的回调（只读渲染时的缺省值）。 */
function noop(): void {
  /* 逻辑在被单测的纯函数（`appendPage` / `nextPage` / `prevPage`）里 */
}

/** 面板 6 的**纯展示层**。 */
export function VersionHistoryView({
  state,
  current,
  now,
  onLoadOlder,
  onPrev,
  onNext,
  noSelection,
}: VersionHistoryViewProps): ReactElement {
  // ★ 「还没选记忆」在这里就短路掉（不进 `StatusBlock`）：
  //   此时 `state` 只会是 `loading`（容器把 `port` 换成了 `null`，一次都不发），
  //   渲染「计算中」等于告诉用户「马上就有一条历史了」—— 而其实一条都没选过。
  if (noSelection === true) {
    return (
      <NoSelectionPanel title={PANEL_TITLES.versionHistory} bodyId="versionHistory" inertPager />
    );
  }

  return (
    <StatusBlock state={state} what={PANEL_TITLES.versionHistory}>
      {(history: HistoryPage) => {
        // ⚠️ `current?.deleted === true` 而不是 `current !== null && current.deleted`：
        //   后者触发生物学上等价的 optional-chain 提示（`useOptionalChain`），
        //   而这里本来就要在「软删」时重新拼一次文案 ⇒ 直接算出 `deletedNotice` 更直白。
        const deletedNotice =
          current?.deleted === true ? softDeletedNotice(current.deletedAt) : null;
        const loaded = history.rows.length;
        /** ★ 全部加载完 ⇒ **不渲染**「加载更早的版本」（而不是渲染一个 disabled 的死按钮）。 */
        const canLoadOlder = loaded < history.total;
        return (
          <div
            className="panel panel--history"
            data-panel-body="versionHistory"
            data-now={now}
            data-history-total={history.total}
            data-history-page={history.page}
            data-history-loaded={loaded}
          >
            <h2 className="panel__title">{PANEL_TITLES.versionHistory}</h2>

            {deletedNotice === null ? null : (
              <p className="history__deleted-notice" data-deleted-notice="">
                {deletedNotice}
              </p>
            )}

            {current === null ? null : (
              <section className="history__current-block">
                <h3 className="memory__heading">{CURRENT_CONTENT_LABEL}</h3>
                <p className="history__current" data-field="current-content">
                  {current.content}
                </p>
              </section>
            )}

            <h3 className="memory__heading">{HISTORY_HEADING}</h3>
            <p className="overview__hint" data-history-page-text="">
              {historyPageText(history.page, CONTENT_HISTORY_PAGE_SIZE, history.total)}
            </p>

            {history.rows.length === 0 ? (
              <p className="panel__empty" data-history-empty="">
                {HISTORY_EMPTY_TEXT}
              </p>
            ) : (
              <ol className="history__versions" data-chart="history-versions">
                {history.rows.map((row, index) => (
                  <li
                    key={`${textOf(row, 'id')}:${index}`}
                    className="history__version"
                    data-history-id={textOf(row, 'id')}
                    data-replaced-at={replacedAtOf(row)}
                    data-history-index={index}
                  >
                    <p className="history__version-meta">
                      <span className="status__label">{HISTORY_REPLACED_AT_LABEL}</span>
                      <span data-field="replaced-at">{formatTimestamp(replacedAtOf(row))}</span>
                      <span className="status__label">{HISTORY_REASON_LABEL}</span>
                      <span data-field="reason" data-reason={textOf(row, 'reason')}>
                        {historyReasonText(textOf(row, 'reason'))}
                      </span>
                    </p>
                    <p className="history__version-content" data-field="content">
                      {textOf(row, 'content')}
                    </p>
                  </li>
                ))}
              </ol>
            )}

            <p className="overview__hint" data-history-loaded-text="">
              {canLoadOlder
                ? historyLoadedText(loaded, history.total)
                : `${historyLoadedText(loaded, history.total)}　${HISTORY_LOADED_ALL}`}
            </p>

            <div className="panel__pager" data-chart="history-pager" data-page={history.page}>
              <button
                type="button"
                data-pager="prev"
                disabled={history.page === 0}
                onClick={() => {
                  (onPrev ?? noop)();
                }}
              >
                {BUTTON_PREV}
              </button>
              <button
                type="button"
                data-pager="next"
                disabled={(history.page + 1) * CONTENT_HISTORY_PAGE_SIZE >= history.total}
                onClick={() => {
                  (onNext ?? noop)();
                }}
              >
                {BUTTON_NEXT}
              </button>
              {canLoadOlder ? (
                <button
                  type="button"
                  data-pager="older"
                  onClick={() => {
                    (onLoadOlder ?? noop)();
                  }}
                >
                  {BUTTON_LOAD_OLDER}
                </button>
              ) : null}
            </div>
          </div>
        );
      }}
    </StatusBlock>
  );
}

/** `VersionHistory`（取数容器）的入参。 */
export interface VersionHistoryProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** 要看的记忆 id（`''` ⇒ **尚未选择记忆**）。 */
  readonly memoryId: string;
  /** **初始**页号（之后的翻页由本面板自己的 `useState` 持有）。 */
  readonly page: number;
}

/**
 * 面板 6（取数 + 展示 + 交互）。
 *
 * ⚠️ 它发**两个**读调用：一个 `get()`（拿当前正文与软删标记）、一个 `select()`（拿一页历史）。
 *   两者都是**读**，且都是 `ReadPort` 上已有的方法。
 *   ⚠️ 软删标记必须来自 `get()`：只有它知道 `deleted` / `deletedAt`
 *     （`content_history` 里没有这两列 —— 历史行不谈「这条记忆现在死没死」）。
 *
 * ⚠️ ★ **「移窗口」与「累积」靠一个 ref 区分**：
 *   effect 无法从「page 变了」本身判断用户是按了「下一页」还是「加载更早」——
 *   两者都会改 `page`。⇒ 在按钮回调里先把模式写进 `modeRef`，effect 再按模式决定
 *   「替换 `loaded`」还是 `appendPage(loaded, …)`。
 *   不这么做的话，「加载更早」会退化成「跳到第 2 页、只看到 50 条」——
 *   而那正好是 PLAN 要修的那个毛病。
 */
export function VersionHistory({
  port,
  now,
  memoryId,
  page: initialPage,
}: VersionHistoryProps): ReactElement {
  const [page, setPage] = useState<number>(initialPage);
  const [loaded, setLoaded] = useState<ReadonlyArray<SqlRow>>([]);
  const [total, setTotal] = useState<number>(0);
  /** `'window'` = 替换（上一页 / 下一页）；`'append'` = 累积（加载更早）。 */
  const modeRef = useRef<'window' | 'append'>('window');
  /** 已经吸收过的页号，避免同一次结果被 effect 追加两遍。 */
  const absorbedRef = useRef<number | null>(null);

  /**
   * ★ **是否已经选了一条记忆**（P5-T04）。
   *
   * ⚠️ 未选中时把 `port` 换成 `null` ⇒ `useReadCall` **一次都不发**：
   *   改之前两个读调用（`get` 与 `contentHistory*`）无条件用 `memoryId=''` 发出去，
   *   `contentHistoryCount` 恒 0 ⇒ 「上一页 / 下一页」**永久 disabled**，
   *   而界面上看起来只是「这条记忆没有历史版本」（一句假结论）。
   */
  const selected = isMemorySelected(memoryId);

  const detailState = useReadCall<MemoryDetail | null>(
    selected ? port : null,
    `get:${memoryId}:${now}`,
    (activePort) => activePort.get(memoryId, now),
  );
  const state = useReadCall<HistoryPage>(
    selected ? port : null,
    `history:${memoryId}:${page}`,
    (activePort) => loadHistoryPage(activePort, memoryId, page),
  );

  const readyPage = state.status === 'ready' ? state.data : null;

  useEffect(() => {
    if (readyPage === null) {
      return;
    }
    // ⚠️ 同一次结果只吸收一次：`readyPage` 是每次渲染都可能换引用的对象，
    //   不设这道闸，`setLoaded` 会让 effect 再跑一遍 ⇒ 无限追加。
    if (absorbedRef.current === readyPage.page) {
      return;
    }
    absorbedRef.current = readyPage.page;
    setTotal(readyPage.total);
    if (modeRef.current === 'append') {
      setLoaded((current) => appendPage(current, readyPage.rows, readyPage.total));
    } else {
      setLoaded(() => readyPage.rows);
    }
  }, [readyPage]);

  const current = detailState.status === 'ready' ? (detailState.data?.view ?? null) : null;
  /** 展示用的是**累积后**的列表（`window` 模式下它就是那一页）。 */
  const viewState: ReadState<HistoryPage> =
    state.status === 'ready' ? { status: 'ready', data: { rows: loaded, total, page } } : state;

  return (
    <VersionHistoryView
      state={viewState}
      current={current}
      now={now}
      noSelection={!selected}
      onPrev={() => {
        modeRef.current = 'window';
        setPage((currentPage) => prevPage(currentPage, total, CONTENT_HISTORY_PAGE_SIZE));
      }}
      onNext={() => {
        modeRef.current = 'window';
        setPage((currentPage) => nextPage(currentPage, total, CONTENT_HISTORY_PAGE_SIZE));
      }}
      onLoadOlder={() => {
        modeRef.current = 'append';
        setPage((currentPage) => nextPage(currentPage, total, CONTENT_HISTORY_PAGE_SIZE));
      }}
    />
  );
}
