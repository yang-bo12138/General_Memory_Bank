/**
 * 查看器根组件 —— 阶段 5 · T03/T04（设计 §7.2 / §7.3）。
 *
 * ★ 本文件承担两件「全局」的事，因此七个面板不必各做一遍：
 *   ① **只读徽标顶部常驻**（§7.3「只读模式」一行）：它是这个应用**是什么**的声明，
 *      不是某个面板的状态 ⇒ 放在 `<header>` 里，七个面板共用同一个 `ReadonlyBadge`；
 *   ② **面板导航**：七个标题一律来自 `texts.ts` 的 `PANEL_TITLES`
 *      （只此一份，免得导航与面板正文写出两个名字）。
 *
 * ★ **本文件含交互层**（阶段 5 · T04 第四批）：导航从不可点的 `<span>` 改成
 *   `<button role="tab">` + `useState<PanelId>`。
 *   ⚠️ 这不是装饰问题：改之前**七个面板里六个打不开**（只能看总览），
 *     交付物对用户来说等于「打开就是一张海报」。
 *   ⚠️ ★ **用 `role="tab"` 的 `<button>` 而不是把它塞进 `BUTTON_LABELS` 白名单**：
 *     `BUTTON_LABELS` 的语义是「**面板内的动作**白名单」（上一页 / 模拟召回 / 加载更早 …），
 *     把七个**面板标题**塞进去会让「动作白名单」失去意义（标题不是动作）。
 *     导航的可点元素由**它自己的**断言守住：`data-nav-panel` 元素数量 === `PANEL_ORDER.length`、
 *     文案逐条 === `PANEL_TITLES`、且**不得**含「回滚 / 删除 / 遗忘 / 恢复」这类写动作字样。
 *
 * ⚠️ **本文件不 import `electron`**：端口由 `main.tsx` 从 `globalThis` 取（preload 注入），
 *   以 prop 传下来。这也是面板能在 vitest（`environment: 'node'`）里直测的原因。
 */

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { ClustersResult } from '../../src/store/clusters.js';
import type { LogQuery, ReadPort } from '../shared/protocol.js';
import { ClusterMap } from './panels/ClusterMap.js';
import { GraphView } from './panels/GraphView.js';
import { LogViewer } from './panels/LogViewer.js';
import { MemoryList } from './panels/MemoryList.js';
import { Overview } from './panels/Overview.js';
import { RecallSimulator } from './panels/RecallSimulator.js';
import { VersionHistory } from './panels/VersionHistory.js';
import { ReadonlyBadge } from './state/StatusBlock.js';
import { APP_TITLE, PANEL_ORDER, PANEL_TITLES } from './texts.js';
import type { PanelId } from './texts.js';

/**
 * ★ **已接线**的面板（顺序即导航顺序）。
 *
 * ⚠️ 它必须与 `PANEL_ORDER` **逐条相等**。由 `viewer-panels-structure.test.ts` 断言
 *   「它是 `PANEL_ORDER` 的前缀」—— 写成乱序或跳过中间某个面板，
 *   都会让「七个面板」这句话在界面上不成立。
 */
export const WIRED_PANELS: readonly PanelId[] = PANEL_ORDER;

/** 当前选中项（面板 + 该面板需要的参数）。 */
export interface AppSelection {
  /** 当前面板（**初始**面板；打开后由 `useState` 接管）。 */
  readonly panel: PanelId;
  /** 面板 2 / 4 / 6 要看的记忆 id。 */
  readonly memoryId: string;
  /** 面板 3 的模拟对话文本（**初始**值；之后的编辑由面板自己持有）。 */
  readonly recallContext: string;
  /** 面板 5 的查询条件（缺省 ⇒ 按 `now` 所在的年月）。 */
  readonly logQuery?: LogQuery;
  /** 面板 6 的页号（缺省 0）。 */
  readonly historyPage?: number;
  /** 面板 7 的「上次快照」（缺省 `null` ⇒ 没有基准）。 */
  readonly previousClusters?: ClustersResult | null;
}

/** 缺省选中项（打开查看器时的第一屏）。 */
export const DEFAULT_SELECTION: AppSelection = {
  panel: 'overview',
  memoryId: '',
  recallContext: '',
};

/**
 * 面板 5 的缺省查询：`now` 所在的年 / 月。
 *
 * ⚠️ **从 `now` 推**（不是 `new Date()`）：`now` 是注入的
 *   ⇒ 同一个 `now` 渲染两次得到同一份 markup，快照不会因为「今天是几号」而变。
 */
export function defaultLogQuery(now: number): LogQuery {
  const iso = new Date(now).toISOString();
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

/** `App` 的入参。 */
export interface AppProps {
  /** 读端口（`null` ⇒ 所有面板停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻（面板的全部时间文案都以它为基准）。 */
  readonly now: number;
  /** **初始**选中项（打开后由 `useState` 接管）。 */
  readonly selection?: AppSelection;
}

/** 按选中项渲染对应面板。 */
function renderPanel(selection: AppSelection, port: ReadPort | null, now: number): ReactElement {
  switch (selection.panel) {
    case 'overview':
      return <Overview port={port} now={now} />;
    case 'memoryList':
      return <MemoryList port={port} now={now} memoryId={selection.memoryId} />;
    case 'recallSimulator':
      return <RecallSimulator port={port} now={now} context={selection.recallContext} />;
    case 'graphView':
      return <GraphView port={port} now={now} memoryId={selection.memoryId} />;
    case 'logViewer':
      return <LogViewer port={port} now={now} query={selection.logQuery ?? defaultLogQuery(now)} />;
    case 'versionHistory':
      return (
        <VersionHistory
          port={port}
          now={now}
          memoryId={selection.memoryId}
          page={selection.historyPage ?? 0}
        />
      );
    case 'clusterMap':
      return <ClusterMap port={port} now={now} previous={selection.previousClusters ?? null} />;
  }
}

/** 查看器根组件。 */
export function App({ port, now, selection = DEFAULT_SELECTION }: AppProps): ReactElement {
  /** ★ 当前面板：由导航按钮驱动（改之前它只是 prop ⇒ 六个面板打不开）。 */
  const [activePanel, setActivePanel] = useState<PanelId>(selection.panel);
  const current: AppSelection = { ...selection, panel: activePanel };

  return (
    <div className="app" data-app="memory-viewer">
      <header className="app__header" data-header="readonly">
        <h1 className="app__title">{APP_TITLE}</h1>
        <ReadonlyBadge />
      </header>
      <nav className="app__nav" data-nav-panels={WIRED_PANELS.length}>
        {WIRED_PANELS.map((panelId) => (
          <button
            key={panelId}
            type="button"
            role="tab"
            className="app__nav-item"
            data-panel-id={panelId}
            data-nav-panel={panelId}
            data-active={panelId === activePanel ? 'true' : 'false'}
            aria-selected={panelId === activePanel}
            onClick={() => {
              setActivePanel(panelId);
            }}
          >
            {PANEL_TITLES[panelId]}
          </button>
        ))}
      </nav>
      <main className="app__main" data-selected-panel={activePanel} data-now={now}>
        {renderPanel(current, port, now)}
      </main>
    </div>
  );
}
