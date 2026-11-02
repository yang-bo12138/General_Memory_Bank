/**
 * ★ 面板 5 · **只读日志查看（二级面板）** —— 阶段 5 · T04（设计 §7.2 面板 5 / §8.1）。
 *
 * 三条硬约束：
 *   ① ★ **只调 `port.logs`**：日志**不经数据库**（§8.3：`logs/` 只作人类排障，重放以 `events` 为准）
 *      ⇒ 本面板的取数函数只碰 `port.logs`，一次 `select` 都不发。
 *      实现侧（库线程的 `readLogPage`）只用 `readFileSync` / `readdirSync` / `existsSync`，
 *      **不含任何写文件调用**（源码断言在 `viewer-panels-log-cluster.test.ts`）。
 *   ② **按年 / 月 / 日浏览**：`LogQuery` 的 `year` / `month` / `day` 原样传下去，
 *      `day` 缺省 = 整月。
 *   ③ **关键字高亮 + 分页**：高亮只改渲染，**不改过滤**（过滤在库线程做，`total` 是过滤后的分母）。
 *
 * ⚠️ **面板不做脱敏**：§8.2 已保证「日志正文永不包含记忆原文」⇒ 这里再脱敏一遍
 *   只会让人以为「日志里有敏感内容所以被处理过」，那是错的印象。
 */

import type { ReactElement, ReactNode } from 'react';

import type { LogPage, LogQuery, ReadPort } from '../../shared/protocol.js';
import { StatusBlock } from '../state/StatusBlock.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
  BUTTON_NEXT,
  BUTTON_PREV,
  LOG_EMPTY_TEXT,
  LOG_READONLY_HINT,
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

/** 当前页的偏移（`query.offset` 缺省 0）。 */
function offsetOf(query: LogQuery): number {
  return query.offset ?? 0;
}

/** `LogViewerView`（纯展示）的入参。 */
export interface LogViewerViewProps {
  /** 本次 `logs()` 的读状态。 */
  readonly state: ReadState<LogPage>;
  /** 本次查询（面板要把年月日与偏移显示出来）。 */
  readonly query: LogQuery;
  /** 注入的当前时刻（只用于文案）。 */
  readonly now: number;
}

/** 面板 5 的**纯展示层**。 */
export function LogViewerView({ state, query, now }: LogViewerViewProps): ReactElement {
  const offset = offsetOf(query);
  const keyword = query.keyword ?? '';

  return (
    <StatusBlock state={state} what={PANEL_TITLES.logViewer}>
      {(page: LogPage) => (
        <div
          className="panel panel--log"
          data-panel-body="logViewer"
          data-now={now}
          data-log-total={page.total}
          data-log-offset={offset}
        >
          <h2 className="panel__title">{PANEL_TITLES.logViewer}</h2>
          <p className="overview__hint" data-log-hint="">
            {LOG_READONLY_HINT}
          </p>
          <p className="overview__hint" data-log-range="">
            {`${query.year} 年 ${query.month} 月`}
            {query.day === undefined ? '' : ` ${query.day} 日`}
            {keyword === '' ? '' : `　关键字：${keyword}`}
          </p>
          <p className="overview__hint" data-log-total-text="">
            {logTotalText(page.total, offset, page.lines.length)}
          </p>

          {page.lines.length === 0 ? (
            <p className="panel__empty" data-log-empty="">
              {LOG_EMPTY_TEXT}
            </p>
          ) : (
            <div className="log__lines" data-chart="log-lines">
              {page.lines.map((line) => (
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

          <div className="panel__pager" data-chart="log-pager" data-offset={offset}>
            <button type="button" data-pager="prev" disabled={offset === 0}>
              {BUTTON_PREV}
            </button>
            <button
              type="button"
              data-pager="next"
              disabled={offset + page.lines.length >= page.total}
            >
              {BUTTON_NEXT}
            </button>
            <span data-pager-info="">
              {`偏移 ${offset}　本页 ${page.lines.length} 行　共 ${page.total} 行`}
            </span>
          </div>
        </div>
      )}
    </StatusBlock>
  );
}

/** `LogViewer`（取数容器）的入参。 */
export interface LogViewerProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** 查询条件（年月日 + 关键字 + 偏移）。 */
  readonly query: LogQuery;
}

/** 面板 5（取数 + 展示）。 */
export function LogViewer({ port, now, query }: LogViewerProps): ReactElement {
  const offset = offsetOf(query);
  const keyword = query.keyword ?? '';
  const key = `logs:${query.year}-${query.month}-${query.day ?? 'all'}:${offset}:${keyword}`;
  const state = useReadCall<LogPage>(port, key, (activePort) => loadLogPage(activePort, query));
  return <LogViewerView state={state} query={query} now={now} />;
}
