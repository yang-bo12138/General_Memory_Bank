/**
 * ★ 面板 5 · **只读日志查看（二级面板）** —— 阶段 5 · T04（设计 §7.2 面板 5 / §8.1）。
 *
 * 三条硬约束：
 *   ① ★ **只调 `port.logs`**：日志**不经数据库**（§8.3：`logs/` 只作人类排障，重放以 `events` 为准）
 *      ⇒ 本面板的取数函数只碰 `port.logs`，一次 `select` 都不发。
 *      实现侧（库线程的 `readLogPage`）只用 `readFileSync` / `readdirSync` / `existsSync`，
 *      **不含任何写文件调用**（源码断言在 `viewer-panels-log-cluster.test.ts`）。
 *   ② **按年 / 月 / 日浏览**：三级选择都由 `buildLogQuery()` 归一化（见 `state/navigation.ts`），
 *      **组件里不写第二套查询拼装**。
 *   ③ **关键字高亮 + 分页**：高亮只改渲染，**不改过滤**（过滤在库线程做，`total` 是过滤后的分母）。
 *
 * ★ **本文件含交互层**（阶段 5 · T04 补遗）：`useState` 持有「三级选择 + 页码 + 关键字输入」，
 *   任何一个变 ⇒ `useReadCall` 的依赖键变 ⇒ **自动重发一次 `port.logs`**。
 *   ⚠️ 页面算式一律走 `nextPage()` / `prevPage()`（**组件里不许自己写 `page ± 1` 的夹紧**）：
 *     两处各写一遍，就会有一处在第 0 页算出 `-1`，而负 `offset` 在 SQL 里是**静默**的
 *     （SQLite 把负 `OFFSET` 当 0 ⇒ 界面显示第 1 页，页码却写着 -1）。
 *
 * ⚠️ **面板不做脱敏**：§8.2 已保证「日志正文永不包含记忆原文」⇒ 这里再脱敏一遍
 *   只会让人以为「日志里有敏感内容所以被处理过」，那是错的印象。
 */

import type { ChangeEvent, ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import type { LogPage, LogQuery, ReadPort } from '../../shared/protocol.js';
import { LOG_PAGE_SIZE } from '../../shared/protocol.js';
import { StatusBlock } from '../state/StatusBlock.js';
import type { LogSelection } from '../state/navigation.js';
import { buildLogQuery, maxPage, nextPage, prevPage } from '../state/navigation.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
  BUTTON_NEXT,
  BUTTON_PREV,
  DAY_OPTIONS,
  LOG_ALL_DAYS,
  LOG_DAY_LABEL,
  LOG_EMPTY_TEXT,
  LOG_KEYWORD_LABEL,
  LOG_MONTH_LABEL,
  LOG_READONLY_HINT,
  LOG_YEAR_LABEL,
  MONTH_OPTIONS,
  PANEL_TITLES,
  logTotalText,
} from '../texts.js';

/** 面板 5 的读调用（**只碰 `port.logs`**）。 */
export async function loadLogPage(port: ReadPort, query: LogQuery): Promise<LogPage> {
  return port.logs(query);
}

/**
 * 把一行日志里的关键字包成 `<mark>`（**大小写不敏感，但原样保留大小写**）。
 *
 * ⚠️ 用 `indexOf` 循环而不是正则：关键字来自用户输入，
 *   里面出现 `(` `[` `.` 之类会让 `new RegExp()` 抛错或误匹配
 *   —— 而这里只是想「找到子串然后包一层」，不需要正则。
 */
export function highlightKeyword(raw: string, keyword: string): ReactNode {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') {
    return raw;
  }

  const lower = raw.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;

  for (;;) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) {
      break;
    }
    if (at > cursor) {
      parts.push(raw.slice(cursor, at));
    }
    parts.push(<mark key={`mark-${at}`}>{raw.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
  }

  if (parts.length === 0) {
    return raw;
  }
  if (cursor < raw.length) {
    parts.push(raw.slice(cursor));
  }
  return parts;
}

/** 从 `query` 里还原三级选择（「外部只给了 query」时受控控件也要显示对）。 */
function selectionOf(query: LogQuery): LogSelection {
  return {
    year: query.year,
    month: query.month,
    day: query.day,
    keyword: query.keyword,
  };
}

/** `LogViewerView`（纯展示）的入参。 */
export interface LogViewerViewProps {
  /** 本次 `logs()` 的读状态。 */
  readonly state: ReadState<LogPage>;
  /** **这一次**真正发给库线程的查询（面板要把年月日与偏移显示出来）。 */
  readonly query: LogQuery;
  /** 注入的当前时刻（只用于文案）。 */
  readonly now: number;
  /** 三级选择（缺省 ⇒ 从 `query` 还原）。 */
  readonly selection?: LogSelection | undefined;
  /** 关键字输入框的当前文本（缺省 ⇒ 用 `query.keyword`）。 */
  readonly keyword?: string | undefined;
  /** 当前页号（0 起）。 */
  readonly page?: number | undefined;
  /** 页大小。 */
  readonly pageSize?: number | undefined;
  /** 年变化。 */
  readonly onYearChange?: ((year: number) => void) | undefined;
  /** 月变化（`undefined` = 整年）。 */
  readonly onMonthChange?: ((month: number | undefined) => void) | undefined;
  /** 日变化（`undefined` = 整月）。 */
  readonly onDayChange?: ((day: number | undefined) => void) | undefined;
  /** 关键字变化。 */
  readonly onKeywordChange?: ((keyword: string) => void) | undefined;
  /** 上一页。 */
  readonly onPrev?: (() => void) | undefined;
  /** 下一页。 */
  readonly onNext?: (() => void) | undefined;
}

/**
 * 一个什么都不做的回调（受控控件在「只读渲染」场景下的缺省值）。
 *
 * ⚠️ 空实现是**有意的**：`renderToStaticMarkup` 只关心 markup 形状，
 *   而真正的事件处理逻辑在被单测的纯函数（`nextPage` / `buildLogQuery`）里。
 */
function noop(): void {
  /* 见上面的说明 */
}

/** 面板 5 的**纯展示层**。 */
export function LogViewerView({
  state,
  query,
  now,
  selection = selectionOf(query),
  keyword = query.keyword ?? '',
  page = 0,
  pageSize = query.limit ?? LOG_PAGE_SIZE,
  onYearChange,
  onMonthChange,
  onDayChange,
  onKeywordChange,
  onPrev,
  onNext,
}: LogViewerViewProps): ReactElement {
  const offset = query.offset ?? 0;

  /** 把 `<select>` 的值转成「数字或 undefined」（空串 = 更粗的那一级）。 */
  const toOptionalNumber = (event: ChangeEvent<HTMLSelectElement>): number | undefined => {
    const raw = event.target.value;
    if (raw === '') {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return (
    <StatusBlock state={state} what={PANEL_TITLES.logViewer}>
      {(logPage: LogPage) => {
        const lastPage = maxPage(logPage.total, pageSize);
        return (
          <div
            className="panel panel--log"
            data-panel-body="logViewer"
            data-now={now}
            data-log-total={logPage.total}
            data-log-offset={offset}
          >
            <h2 className="panel__title">{PANEL_TITLES.logViewer}</h2>
            <p className="overview__hint" data-log-hint="">
              {LOG_READONLY_HINT}
            </p>

            <section className="log__filters" data-chart="log-filters">
              <label className="log__filter">
                <span className="status__label">{LOG_YEAR_LABEL}</span>
                <input
                  className="log__filter-input"
                  type="number"
                  min={1970}
                  max={9999}
                  value={selection.year}
                  data-filter="year"
                  onChange={(event) => {
                    (onYearChange ?? noop)(Number(event.target.value));
                  }}
                />
              </label>
              <label className="log__filter">
                <span className="status__label">{LOG_MONTH_LABEL}</span>
                <select
                  className="log__filter-input"
                  value={String(selection.month ?? 1)}
                  data-filter="month"
                  onChange={(event) => {
                    (onMonthChange ?? noop)(toOptionalNumber(event));
                  }}
                >
                  {MONTH_OPTIONS.map((month) => (
                    <option key={month} value={month}>
                      {month}
                    </option>
                  ))}
                </select>
              </label>
              <label className="log__filter">
                <span className="status__label">{LOG_DAY_LABEL}</span>
                <select
                  className="log__filter-input"
                  value={selection.day === undefined ? '' : String(selection.day)}
                  data-filter="day"
                  onChange={(event) => {
                    (onDayChange ?? noop)(toOptionalNumber(event));
                  }}
                >
                  <option value="">{LOG_ALL_DAYS}</option>
                  {DAY_OPTIONS.map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
              <label className="log__filter">
                <span className="status__label">{LOG_KEYWORD_LABEL}</span>
                <input
                  className="log__filter-input"
                  type="search"
                  value={keyword}
                  data-filter="keyword"
                  onChange={(event) => {
                    (onKeywordChange ?? noop)(event.target.value);
                  }}
                />
              </label>
            </section>

            <p className="overview__hint" data-log-range="">
              {`${query.year} 年 ${query.month} 月`}
              {query.day === undefined ? '' : ` ${query.day} 日`}
              {keyword === '' ? '' : `　关键字：${keyword}`}
            </p>
            <p className="overview__hint" data-log-total-text="">
              {logTotalText(logPage.total, offset, logPage.lines.length)}
            </p>

            {logPage.lines.length === 0 ? (
              <p className="panel__empty" data-log-empty="">
                {LOG_EMPTY_TEXT}
              </p>
            ) : (
              <div className="log__lines" data-chart="log-lines">
                {logPage.lines.map((line) => (
                  <p
                    key={`line-${line.no}`}
                    className="log__line"
                    data-log-line={line.no}
                    data-level={line.level}
                  >
                    <span className="log__line-no" data-field="no">
                      {line.no}
                    </span>
                    <span className="log__line-raw" data-field="raw">
                      {highlightKeyword(line.raw, keyword)}
                    </span>
                  </p>
                ))}
              </div>
            )}

            <div
              className="panel__pager"
              data-chart="log-pager"
              data-offset={offset}
              data-page={page}
            >
              <button
                type="button"
                data-pager="prev"
                disabled={page <= 0}
                onClick={() => {
                  (onPrev ?? noop)();
                }}
              >
                {BUTTON_PREV}
              </button>
              <button
                type="button"
                data-pager="next"
                data-last-page={lastPage}
                disabled={page >= lastPage}
                onClick={() => {
                  (onNext ?? noop)();
                }}
              >
                {BUTTON_NEXT}
              </button>
              <span data-pager-info="">
                {`偏移 ${offset}　本页 ${logPage.lines.length} 行　共 ${logPage.total} 行`}
              </span>
            </div>
          </div>
        );
      }}
    </StatusBlock>
  );
}

/** `LogViewer`（取数容器）的入参。 */
export interface LogViewerProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** **初始**查询条件（之后的变更由本面板自己的 `useState` 持有）。 */
  readonly query: LogQuery;
}

/**
 * 面板 5（取数 + 展示 + 交互）。
 *
 * ⚠️ ★ **重发请求靠「依赖键变化」，不手写请求**：
 *   `useReadCall(port, key, run)` 的 `key` 由 `builtQuery` 拼出来 ⇒
 *   选年 / 选月 / 选日 / 改关键字 / 翻页，任何一项变都会换一个 `key`
 *   ⇒ hook 自己去重发（含取消上一次未完成的结果）。
 *   这里**没有**第二个发起请求的入口 —— 那会绕过取消逻辑，症状是「快速翻页后显示的是上一页的内容」。
 */
export function LogViewer({ port, now, query }: LogViewerProps): ReactElement {
  const [selection, setSelection] = useState<LogSelection>(() => selectionOf(query));
  const [keyword, setKeyword] = useState<string>(() => query.keyword ?? '');
  const [page, setPage] = useState<number>(0);

  const pageSize = query.limit ?? LOG_PAGE_SIZE;
  /** ★ **唯一**的查询拼装点：三级选择 + 页码 → `LogQuery`（归一化也在里面）。 */
  const builtQuery = buildLogQuery({ ...selection, keyword }, page, pageSize);
  const key = [
    'logs',
    builtQuery.year,
    builtQuery.month ?? 'all',
    builtQuery.day ?? 'all',
    builtQuery.offset ?? 0,
    builtQuery.keyword ?? '',
  ].join(':');

  const state = useReadCall<LogPage>(port, key, (activePort) =>
    loadLogPage(activePort, builtQuery),
  );
  const total = state.status === 'ready' ? state.data.total : 0;

  return (
    <LogViewerView
      state={state}
      query={builtQuery}
      now={now}
      selection={{ ...selection, keyword }}
      keyword={keyword}
      page={page}
      pageSize={pageSize}
      onYearChange={(year) => {
        setSelection((current) => ({ ...current, year }));
        setPage(0);
      }}
      onMonthChange={(month) => {
        // ⚠️ 换月份必须把「日」清掉：否则会拿旧日号去查新月份（3 月 31 日 → 2 月 31 日 ⇒ 空页）
        setSelection((current) => ({ ...current, month, day: undefined }));
        setPage(0);
      }}
      onDayChange={(day) => {
        setSelection((current) => ({ ...current, day }));
        setPage(0);
      }}
      onKeywordChange={(next) => {
        setKeyword(next);
        setPage(0);
      }}
      onPrev={() => {
        setPage((current) => prevPage(current, total, pageSize));
      }}
      onNext={() => {
        setPage((current) => nextPage(current, total, pageSize));
      }}
    />
  );
}
