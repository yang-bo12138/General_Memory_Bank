/**
 * ★ 面板 2 · **记忆列表与单条详情** —— 阶段 5 · T03（设计 §7.2 面板 2 / PLAN P5-T02）。
 *
 * 要看的四样东西：正文、关联实体、当前强度、**强度衰减曲线**。
 *
 * ★ **曲线基于 `effectiveStability`（含 `pin_factor`）**（§4.1）：
 *   置顶（`pin_factor > 1`）的记忆衰减更慢，而库里**只有** `stability` 与 `pin_factor` 两列
 *   ⇒ 「有效 τ」是 `get()` 现算的派生值（`MemoryView.effectiveStability`）。
 *   面板**必须**用它（`data-tau-days` 断言：`stability=10, pinFactor=2.5 ⇒ 25`，不是 10）。
 *
 * ⚠️ `get()` 查不到时返回 **`null`**（不抛错）⇒ 本面板有一条 `missing` 空态，
 *   它与 `error` 是两件事：「库里没有这条」vs「查询错了」（§7.2 末的排障要求）。
 *
 * ★ **P5-T04 的两个修复（本文件是主要落点）**：
 *   ① **顶部加了「选择哪一条记忆」的入口**（`MemoryPicker`：最近记忆列表 + 按 id 查看）
 *      —— 改之前 `memoryId` 恒为 `''` 且**没有任何入口能改它**，
 *      而它正是本面板的**唯一取数键** ⇒ 打开永远是「库里没有这条记忆」；
 *   ② **`memoryId` 为空时不再假装「查不到」**：改走「尚未选择记忆 + 去哪选」的引导。
 *      这是**第三种**空态（既不是 `missing` 也不是 `error`）：它说的是「还没选」，
 *      而「库里没有这条」说的是「选了一条但查不到」——
 *      两者共用一句话，就会出现「一打开就像报了错，其实只是没人给你入口」。
 */

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { MemoryDetail, ReadPort, SqlRow } from '../../shared/protocol.js';
import { DecayCurve } from '../charts/DecayCurve.js';
import { MemoryPicker, NoSelectionPanel, loadRecentMemories } from '../state/Selection.js';
import { StatusBlock } from '../state/StatusBlock.js';
import { isMemorySelected, nextMemoryId } from '../state/navigation.js';
import { useReadCall } from '../state/useReadCall.js';
import type { ReadState } from '../state/useReadCall.js';
import {
  CONTENT_LABEL,
  ENTITIES_LABEL,
  INTENSITY_LABEL,
  LAYER_LABELS,
  MISSING_MEMORY_TEXT,
  PANEL_TITLES,
  STABILITY_LABEL,
  formatNumber,
  formatScore,
} from '../texts.js';

/**
 * 「最近记忆」为空时的缺省读状态（`MemoryListView` 的 `recent` 缺省值）。
 *
 * ⚠️ 缺省是**就绪的空列表**而不是 `loading`：
 *   缺省若渲染「计算中」，`renderToStaticMarkup` 出来的就绪态面板里会多出那句加载文案
 *   （「就绪态不出现『计算中』」那条断言当场变红），而真正的原因只是「没传这个 prop」。
 *   ⇒ 空列表 + **明确的空态文案**（不是一块无解释的空白）。
 */
const EMPTY_RECENT: ReadState<ReadonlyArray<SqlRow>> = { status: 'ready', data: [] };

/** 面板 2 的读调用（`get()` 查不到返回 `null`）。 */
export async function loadMemoryDetail(
  port: ReadPort,
  memoryId: string,
  now: number,
): Promise<MemoryDetail | null> {
  return port.get(memoryId, now);
}

/** `MemoryListView`（纯展示）的入参。 */
export interface MemoryListViewProps {
  /** 本次详情的读状态。 */
  readonly state: ReadState<MemoryDetail | null>;
  /** 注入的当前时刻（曲线文案要用）。 */
  readonly now: number;
  /** 被查看的记忆 id（`''` ⇒ **尚未选择记忆**）。 */
  readonly memoryId: string;
  /** 「最近记忆」的读状态（缺省 = 空列表 ⇒ 渲染空态文案）。 */
  readonly recent?: ReadState<ReadonlyArray<SqlRow>> | undefined;
  /** 「按 id 查看」输入框的内容（受控；缺省空串）。 */
  readonly idDraft?: string | undefined;
  /** 输入框变更（不传 ⇒ 输入框只读）。 */
  readonly onIdDraftChange?: ((value: string) => void) | undefined;
  /** 提交输入框里的 id（不传 ⇒ 按钮仍渲染但点了没动作）。 */
  readonly onSubmitId?: (() => void) | undefined;
  /** 点「最近记忆」的一行。 */
  readonly onPickMemory?: ((id: string) => void) | undefined;
}

/**
 * 面板 2 的**纯展示层**。
 *
 * ⚠️ 曲线的时间常数取 `detail.view.effectiveStability` —— **不是** `view.stability`。
 *   这一行就是「置顶是否真的生效」在界面上唯一的证据。
 */
export function MemoryListView({
  state,
  now,
  memoryId,
  recent = EMPTY_RECENT,
  idDraft = '',
  onIdDraftChange,
  onSubmitId,
  onPickMemory,
}: MemoryListViewProps): ReactElement {
  /** 选择器本身（三种分支里都要在场：它才是「怎么选」的答案）。 */
  const picker = (
    <MemoryPicker
      recent={recent}
      currentId={memoryId}
      draft={idDraft}
      onDraftChange={onIdDraftChange}
      onSubmitId={onSubmitId}
      onPick={onPickMemory}
    />
  );

  // ★ 第三种空态：「还没选」。它与「库里没有这条」（`missing`）是**两件事**。
  if (!isMemorySelected(memoryId)) {
    return (
      <NoSelectionPanel title={PANEL_TITLES.memoryList} bodyId="memoryList">
        {picker}
      </NoSelectionPanel>
    );
  }

  return (
    <StatusBlock state={state} what={PANEL_TITLES.memoryList}>
      {(detail: MemoryDetail | null) => {
        if (detail === null) {
          return (
            <div className="panel panel--memory" data-panel-body="memoryList" data-state="missing">
              <h2 className="panel__title">{PANEL_TITLES.memoryList}</h2>
              <p className="panel__empty" data-missing-id={memoryId}>
                {MISSING_MEMORY_TEXT}：{memoryId}
              </p>
              {picker}
            </div>
          );
        }

        const view = detail.view;
        return (
          <div
            className="panel panel--memory"
            data-panel-body="memoryList"
            data-state="ready"
            data-memory-id={view.id}
            data-layer={view.layer}
            data-deleted={view.deleted ? 'true' : 'false'}
          >
            <h2 className="panel__title">{PANEL_TITLES.memoryList}</h2>

            {picker}

            <section className="memory__content-block">
              <h3 className="memory__heading">{CONTENT_LABEL}</h3>
              <p className="memory__content" data-field="content">
                {view.content}
              </p>
            </section>

            <dl className="memory__facts">
              <dt>{ENTITIES_LABEL}</dt>
              <dd data-field="entities">
                {view.entities.length === 0 ? '（无）' : view.entities.join('、')}
              </dd>
              <dt>{INTENSITY_LABEL}</dt>
              <dd data-field="intensity" data-value={view.intensity}>
                {formatScore(view.intensity)}（{LAYER_LABELS[view.layer]}）
              </dd>
              <dt>{STABILITY_LABEL}</dt>
              <dd data-field="stability" data-value={view.stability}>
                {formatNumber(view.stability)}
              </dd>
              <dt>有效 τ（stability × pin_factor）</dt>
              <dd data-field="effective-stability" data-value={view.effectiveStability}>
                {formatNumber(view.effectiveStability)}
              </dd>
            </dl>

            <DecayCurve
              curve={detail.curve}
              layerMarks={detail.layerMarks}
              tauDays={view.effectiveStability}
              currentIntensity={view.intensity}
              now={now}
              archiveAt={detail.archiveAt}
              dropOutL3At={detail.dropOutL3At}
            />
          </div>
        );
      }}
    </StatusBlock>
  );
}

/** `MemoryList`（取数容器）的入参。 */
export interface MemoryListProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** 要看的记忆 id（`''` ⇒ 尚未选择）。 */
  readonly memoryId: string;
  /**
   * 「选中了一条记忆」—— **由 `App` 的 `setMemoryId` 接管**。
   *
   * ⚠️ 不传 ⇒ 选择器照样渲染，但点了不改任何东西（这是 SSR 与既有测试要的形态：
   *   `renderToStaticMarkup` 本来也不会跑 `onClick`）。
   */
  readonly onSelectMemory?: ((picked: string) => void) | undefined;
}

/**
 * 面板 2（取数 + 展示 + 选择）。
 *
 * ⚠️ ★ **两个读调用，各自独立**：
 *   ① `get(memoryId, now)` —— 详情（**未选中时 `port` 传 `null` ⇒ 一次都不发**：
 *      拿空 id 去查会撞库侧的 `INVALID_INPUT`，那是把「还没选」误报成「查询出错」）；
 *   ② `select('recentMemories')` —— 列表（**未选中时也要发**：它就是「怎么选」的答案）。
 * ⚠️ 输入框的内容是本地的 `useState`（受控），提交时才经 `nextMemoryId()` 决定新选中项：
 *   空输入**不清空**当前选中项、重复点同一条返回同一引用（不多余重渲染）。
 */
export function MemoryList({ port, now, memoryId, onSelectMemory }: MemoryListProps): ReactElement {
  const selected = isMemorySelected(memoryId);
  const state = useReadCall<MemoryDetail | null>(
    selected ? port : null,
    `get:${memoryId}:${now}`,
    (activePort) => loadMemoryDetail(activePort, memoryId, now),
  );
  /** ★ 「最近记忆」：与选中项**无关**的一次取数（列表本身就是选择入口）。 */
  const recent = useReadCall<ReadonlyArray<SqlRow>>(port, 'recentMemories', loadRecentMemories);
  const [draft, setDraft] = useState<string>('');

  return (
    <MemoryListView
      state={state}
      now={now}
      memoryId={memoryId}
      recent={recent}
      idDraft={draft}
      onIdDraftChange={setDraft}
      onSubmitId={() => {
        onSelectMemory?.(nextMemoryId(memoryId, draft));
      }}
      onPickMemory={(picked) => {
        onSelectMemory?.(nextMemoryId(memoryId, picked));
      }}
    />
  );
}
