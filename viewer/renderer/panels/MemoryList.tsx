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
 */

import type { ReactElement } from 'react';

import type { MemoryDetail, ReadPort } from '../../shared/protocol.js';
import { DecayCurve } from '../charts/DecayCurve.js';
import { StatusBlock } from '../state/StatusBlock.js';
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
  /** 被查看的记忆 id（`missing` 空态要显示它）。 */
  readonly memoryId: string;
}

/**
 * 面板 2 的**纯展示层**。
 *
 * ⚠️ 曲线的时间常数取 `detail.view.effectiveStability` —— **不是** `view.stability`。
 *   这一行就是「置顶是否真的生效」在界面上唯一的证据。
 */
export function MemoryListView({ state, now, memoryId }: MemoryListViewProps): ReactElement {
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
  /** 要看的记忆 id。 */
  readonly memoryId: string;
}

/** 面板 2（取数 + 展示）。 */
export function MemoryList({ port, now, memoryId }: MemoryListProps): ReactElement {
  const state = useReadCall<MemoryDetail | null>(port, `get:${memoryId}:${now}`, (activePort) =>
    loadMemoryDetail(activePort, memoryId, now),
  );
  return <MemoryListView state={state} now={now} memoryId={memoryId} />;
}
