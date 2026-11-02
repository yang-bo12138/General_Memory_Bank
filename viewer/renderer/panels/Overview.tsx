/**
 * ★ 面板 1 · **总览与层级分布** —— 阶段 5 · T03（设计 §7.2 面板 1 / PLAN P5-T02）。
 *
 * 三件**不可省略**的事：
 *   ① ★ **向量路块**（`VectorRouteBlock`）：四值枚举、五条措辞逐字。
 *      「向量路静默缺席不可观测」是本库明令禁止的失效模式，本块就是它的可观测落点；
 *   ② ★ **`embeddedRatio`（向量覆盖率）摆在总览上**：
 *      「无向量记忆最高只能得 0.75 分」是个**看不见的降权**——
 *      覆盖率长期偏低时用户会以为「召回不准」，实际是根本没走向量路；
 *   ③ **层级分布按当前 `now` 现算**（`stats()` 已经在库线程按 `now` 算好了四层计数，
 *      本文件只负责显示，**不重算**：两处各算一遍迟早会一个说 3 一个说 4）。
 *
 * ⚠️ **本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`**：
 *   它只吃一个 `ReadPort`（真跑时由 preload 注入，测试里传假端口）。
 * ⚠️ **本文件没有 `try/catch`**：错误统一由 `useReadCall` → `StatusBlock` 处理
 *   （§7.3「错误只在一处实现」；断言扫 `panels/*.tsx` 里 `catch (` 的出现次数为 0）。
 */

import type { ReactElement } from 'react';

import type { MemoryStats } from '../../../src/store/stats.js';
import type { ReadPort } from '../../shared/protocol.js';
import { StatusBlock, VectorRouteBlock } from '../state/StatusBlock.js';
import { useReadCall } from '../state/useReadCall.js';
import type { ReadState } from '../state/useReadCall.js';
import {
  EMBEDDED_RATIO_HINT,
  EMBEDDED_RATIO_LABEL,
  LAYER_HEADING,
  LAYER_LABELS,
  LAYER_ORDER,
  PANEL_TITLES,
  formatPercent,
} from '../texts.js';

/** 面板 1 的读调用（单独导出 ⇒ 测试可以只测「调了哪个方法、带了什么参数」）。 */
export async function loadStats(port: ReadPort, now: number): Promise<MemoryStats> {
  return port.stats(now);
}

/** 四层计数从 `MemoryStats` 的哪一个字段来（**映射写死**，不按名字猜）。 */
function layerCount(data: MemoryStats, layer: 'L3' | 'L2' | 'L1' | 'archived'): number {
  switch (layer) {
    case 'L3':
      return data.l3Count;
    case 'L2':
      return data.l2Count;
    case 'L1':
      return data.l1Count;
    case 'archived':
      return data.archivedCount;
  }
}

/** `OverviewView`（纯展示）的入参。 */
export interface OverviewViewProps {
  /** 本次 `stats()` 的读状态。 */
  readonly state: ReadState<MemoryStats>;
  /** 注入的当前时刻（只用于文案，不参与任何计算）。 */
  readonly now: number;
}

/**
 * 面板 1 的**纯展示层**（`renderToStaticMarkup` 直测这一层）。
 *
 * ⚠️ 把「取数」与「画」拆成两个组件不是洁癖：
 *   面板的核心断言（措辞、覆盖率、柱状图构成）都要能在**没有 Electron、没有库**的情况下跑，
 *   否则它们就只能靠人眼看 —— 而人眼看不出的正是「`flat_auto` 被标成正在重训」这类错。
 */
export function OverviewView({ state, now }: OverviewViewProps): ReactElement {
  return (
    <StatusBlock state={state} what={PANEL_TITLES.overview}>
      {(data: MemoryStats) => {
        const total = data.total;
        return (
          <div className="panel panel--overview" data-panel-body="overview">
            <h2 className="panel__title">{PANEL_TITLES.overview}</h2>

            <section className="overview__layers" data-chart="layer-distribution">
              <h3 className="overview__heading">{LAYER_HEADING}</h3>
              <ul className="overview__layer-list">
                {LAYER_ORDER.map((layer) => {
                  const count = layerCount(data, layer);
                  const share = total > 0 ? count / total : 0;
                  return (
                    <li
                      key={layer}
                      className="overview__layer"
                      data-layer={layer}
                      data-count={count}
                    >
                      <span className="overview__layer-label">{LAYER_LABELS[layer]}</span>
                      <span className="overview__layer-value">
                        {count}（{formatPercent(share)}）
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="overview__total" data-total={total}>
                未删记忆共 {total} 条（已遗忘 {data.deletedCount} 条；实体 {data.entityCount} 个；边{' '}
                {data.edgeCount} 条）
              </p>
            </section>

            <section
              className="overview__embedded"
              data-chart="embedded-ratio"
              data-embedded-ratio={data.embeddedRatio}
            >
              <h3 className="overview__heading">{EMBEDDED_RATIO_LABEL}</h3>
              <p className="overview__embedded-value" data-embedded-ratio-text="">
                {formatPercent(data.embeddedRatio)}
              </p>
              <p className="overview__hint">{EMBEDDED_RATIO_HINT}</p>
            </section>

            <VectorRouteBlock
              mode={data.vectorBackend.mode}
              inRetrain={data.vectorBackend.inRetrain}
              indexBytes={data.vectorBackend.indexBytes}
            />

            <p className="overview__now" data-now={now}>
              全部层级与强度均以此刻（{new Date(now).toISOString()}）为基准现算
            </p>
          </div>
        );
      }}
    </StatusBlock>
  );
}

/** `Overview`（取数容器）的入参。 */
export interface OverviewProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
}

/** 面板 1（取数 + 展示）。 */
export function Overview({ port, now }: OverviewProps): ReactElement {
  const state = useReadCall<MemoryStats>(port, `stats:${now}`, (activePort) =>
    loadStats(activePort, now),
  );
  return <OverviewView state={state} now={now} />;
}
