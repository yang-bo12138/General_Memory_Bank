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
 * ⚠️ 本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`，也不写 `try/catch`。
 */

import type { ReactElement } from 'react';

import type { MemoryView } from '../../../src/store/get.js';
import { CONTENT_HISTORY_PAGE_SIZE } from '../../shared/limits.js';
import type { MemoryDetail, ReadPort, SqlRow } from '../../shared/protocol.js';
import { StatusBlock } from '../state/StatusBlock.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
  BUTTON_NEXT,
  BUTTON_PREV,
  CURRENT_CONTENT_LABEL,
  HISTORY_EMPTY_TEXT,
  HISTORY_HEADING,
  HISTORY_REASON_LABEL,
  HISTORY_REPLACED_AT_LABEL,
  PANEL_TITLES,
  formatTimestamp,
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
  /** 本页历史的读状态。 */
  readonly state: ReadState<HistoryPage>;
  /** 当前记忆视图（`null` = 库里没有这条）；**软删标注靠它**。 */
  readonly current: MemoryView | null;
  /** 注入的当前时刻（只用于文案）。 */
  readonly now: number;
}

/** 面板 6 的**纯展示层**。 */
export function VersionHistoryView({ state, current, now }: VersionHistoryViewProps): ReactElement {
  return (
    <StatusBlock state={state} what={PANEL_TITLES.versionHistory}>
      {(history: HistoryPage) => (
        <div
          className="panel panel--history"
          data-panel-body="versionHistory"
          data-now={now}
          data-history-total={history.total}
          data-history-page={history.page}
        >
          <h2 className="panel__title">{PANEL_TITLES.versionHistory}</h2>

          {current?.deleted ? (
            <p className="history__deleted-notice" data-deleted-notice="">
              {softDeletedNotice(current.deletedAt)}
            </p>
          ) : null}

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

          <div className="panel__pager" data-chart="history-pager" data-page={history.page}>
            <button type="button" data-pager="prev" disabled={history.page === 0}>
              {BUTTON_PREV}
            </button>
            <button
              type="button"
              data-pager="next"
              disabled={(history.page + 1) * CONTENT_HISTORY_PAGE_SIZE >= history.total}
            >
              {BUTTON_NEXT}
            </button>
          </div>
        </div>
      )}
    </StatusBlock>
  );
}

/** `VersionHistory`（取数容器）的入参。 */
export interface VersionHistoryProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** 要看的记忆 id。 */
  readonly memoryId: string;
  /** 页号（0 起）。 */
  readonly page: number;
}

/**
 * 面板 6（取数 + 展示）。
 *
 * ⚠️ 它发**两个**读调用：一个 `get()`（拿当前正文与软删标记）、一个 `select()`（拿一页历史）。
 *   两者都是**读**，且都是 `ReadPort` 上已有的方法。
 *   ⚠️ 软删标记必须来自 `get()`：只有它知道 `deleted` / `deletedAt`
 *     （`content_history` 里没有这两列——历史行不谈「这条记忆现在死没死」）。
 */
export function VersionHistory({ port, now, memoryId, page }: VersionHistoryProps): ReactElement {
  const detailState = useReadCall<MemoryDetail | null>(
    port,
    `get:${memoryId}:${now}`,
    (activePort) => activePort.get(memoryId, now),
  );
  const state = useReadCall<HistoryPage>(port, `history:${memoryId}:${page}`, (activePort) =>
    loadHistoryPage(activePort, memoryId, page),
  );
  const current = detailState.status === 'ready' ? (detailState.data?.view ?? null) : null;
  return <VersionHistoryView state={state} current={current} now={now} />;
}
