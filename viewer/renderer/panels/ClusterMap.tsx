/**
 * ★ 面板 7 · **主题簇导航（礁石图）** —— 阶段 5 · T04（设计 §7.2 面板 7 / §4.12.4）。
 *
 * 六个硬点：
 *   ① ★ **成员顺序与 `clusters().memberIds` 完全一致**（`ClusterBubble` 不排序，本文件也不排序）；
 *   ② ★ **快照新鲜度常驻可见**（`computedAt` 相对时间 + `stale` 措辞）：
 *      不显示的话，用户会把一份**可能过期的划分**当成当前事实；
 *   ③ ★ **同时显示 `coverage` 与 `largestClusterRatio`**：
 *      前者回答「簇覆盖了多少记忆」，后者回答「有没有一个簇吞掉了半个库」——
 *      合并成一个数就同时失去了这两个答案；
 *   ④ ★ **巨型簇不隐藏**：本文件**没有**任何按 `size` / 占比过滤的分支；
 *   ⑤ ★ **成员列表带 `LIMIT`**（在 `ClusterBubble` 里，`CLUSTER_MEMBER_SAMPLE_MAX`）；
 *   ⑥ ★ **「最近两次快照对比」用成员重叠度，不用簇的 `key`**：
 *      簇的 `key` = 簇内最小成员 id ⇒ 成员会随时间增减 ⇒ **key 会变**
 *      ⇒ 拿 key 做对比，得到的是「这两个 key 一不一样」，与「是不是同一个簇」无关。
 *      本文件里**根本不出现**簇的 `key` 字段（只用 `clusterId` 做 DOM key，它也不是持久标识）。
 *
 * ★ **本文件含交互层**（阶段 5 · T04 补遗）：
 *   「本次会话内上一次结果」由本面板的 `useState` 持有 —— **不是** localStorage、
 *   **不是**已发布快照表（§3：跨快照比较只在进程内做）。
 *   每次拿到**新的** `computedAt` 就把上一份快照存进 `previous`，供「对比上次」使用。
 *   ⚠️ 存的是**快照对象本身**，不是 `computedAt`：对比要算**成员集合**的重叠度，
 *     光有时间戳算不出任何东西。
 *
 * ⚠️ **「上次结果」的基准说明常驻**（`LAST_SNAPSHOT_BASELINE`）：
 *   这里的「上次」是**本次会话内上次打开面板时的结果**，
 *   **不是**「上一版已发布快照」。不说清楚，用户会拿它去跟一个它并不是的东西比。
 *
 * ⚠️ 本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`，也不写 `try/catch`。
 */

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ClustersResult } from '../../../src/store/clusters.js';
import type { ReadPort } from '../../shared/protocol.js';
import { StatusBlock } from '../state/StatusBlock.js';
import { overlapRatio } from '../state/navigation.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
  BUTTON_COMPARE_PREVIOUS,
  CLUSTER_COMPARISON_HEADING,
  CLUSTER_COVERAGE_LABEL,
  CLUSTER_EMPTY_TEXT,
  CLUSTER_LARGEST_RATIO_LABEL,
  CLUSTER_NO_PREVIOUS_TEXT,
  CLUSTER_RATIO_HINT,
  LAST_SNAPSHOT_BASELINE,
  NOT_AVAILABLE,
  PANEL_TITLES,
  clusterFreshnessText,
  clusterOverlapText,
  formatPercent,
} from '../texts.js';
import { ClusterBubble } from './ClusterBubble.js';

/**
 * ★ 成员重叠度 —— **唯一实现在 `state/navigation.ts`**，这里只做**别名再导出**。
 *
 * ⚠️ 为什么保留这个别名：既有测试与 `compareSnapshots` 都在用 `memberOverlapRatio` 这个名字
 *   （它是面板 7 的术语）。别名不是第二份定义（与 `decay.ts` 里 `MS_PER_DAY` 的做法同款），
 *   值恒等于 `navigation.ts` 里那一份。
 */
export { overlapRatio as memberOverlapRatio } from '../state/navigation.js';

/** 面板 7 的读调用。 */
export async function loadClusters(port: ReadPort, now: number): Promise<ClustersResult> {
  return port.clusters(now);
}

/** 一次「本次簇 → 上次最相似的簇」的对照行。 */
export interface ClusterOverlapRow {
  /** 本次的簇。 */
  readonly clusterId: string;
  /** 上次最相似的那个簇（上次没有簇 ⇒ `null`）。 */
  readonly partnerClusterId: string | null;
  /** 重叠度。 */
  readonly overlap: number;
}

/**
 * 把「本次快照」逐个簇对到「上次快照」里**成员重叠度最高**的那一个。
 *
 * ⚠️ **并列时取上次列表里靠前的那个**（不比较 `key`、不比较 `clusterId`）：
 *   并列是常态（两个簇都只有 1 条共同成员），需要一个**确定性**的裁决规则，
 *   而「列表顺序」是唯一不需要再引入第二个语义的规则。
 */
export function compareSnapshots(
  previous: ClustersResult | null,
  current: ClustersResult,
): ReadonlyArray<ClusterOverlapRow> {
  if (previous === null) {
    return [];
  }

  return current.clusters.map((cluster) => {
    let bestId: string | null = null;
    let bestOverlap = 0;
    for (const candidate of previous.clusters) {
      const overlap = overlapRatio(candidate.memberIds, cluster.memberIds);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestId = candidate.clusterId;
      }
    }
    return { clusterId: cluster.clusterId, partnerClusterId: bestId, overlap: bestOverlap };
  });
}

/** `ClusterMapView`（纯展示）的入参。 */
export interface ClusterMapViewProps {
  /** 本次 `clusters()` 的读状态。 */
  readonly state: ReadState<ClustersResult>;
  /** 本次会话内**上一次**打开面板时的快照（没有 ⇒ `null`）。 */
  readonly previous: ClustersResult | null;
  /** 注入的当前时刻（新鲜度文案要用它）。 */
  readonly now: number;
  /** 「对比上次」—— 不传 ⇒ 按钮 disabled（没有可对比的基准）。 */
  readonly onComparePrevious?: (() => void) | undefined;
  /** 用户是否**显式**按过「对比上次」（对比区据此标注来源）。 */
  readonly comparisonRequested?: boolean | undefined;
}

/** 一个什么都不做的回调（只读渲染时的缺省值）。 */
function noop(): void {
  /* 对比算式在被单测的纯函数（`overlapRatio` / `compareSnapshots`）里 */
}

/** 面板 7 的**纯展示层**。 */
export function ClusterMapView({
  state,
  previous,
  now,
  onComparePrevious,
  comparisonRequested = false,
}: ClusterMapViewProps): ReactElement {
  return (
    <StatusBlock state={state} what={PANEL_TITLES.clusterMap}>
      {(snapshot: ClustersResult) => {
        const overlaps = compareSnapshots(previous, snapshot);
        return (
          <div className="panel panel--cluster" data-panel-body="clusterMap" data-now={now}>
            <h2 className="panel__title">{PANEL_TITLES.clusterMap}</h2>

            <p className="overview__hint" data-snapshot-freshness="">
              {clusterFreshnessText(snapshot.computedAt, now, snapshot.stale)}
            </p>

            <section className="cluster-map__ratios" data-chart="cluster-ratios">
              <span data-field="coverage" data-value={snapshot.coverage}>
                {`${CLUSTER_COVERAGE_LABEL} ${formatPercent(snapshot.coverage)}`}
              </span>
              <span data-field="largest-cluster-ratio" data-value={snapshot.largestClusterRatio}>
                {`${CLUSTER_LARGEST_RATIO_LABEL} ${formatPercent(snapshot.largestClusterRatio)}`}
              </span>
            </section>
            <p className="overview__hint" data-ratio-hint="">
              {CLUSTER_RATIO_HINT}
            </p>

            <p className="cluster-map__baseline" data-snapshot-baseline="">
              {LAST_SNAPSHOT_BASELINE}
            </p>

            {snapshot.clusters.length === 0 ? (
              <p className="panel__empty" data-cluster-empty="">
                {CLUSTER_EMPTY_TEXT}
              </p>
            ) : (
              <ul className="cluster-map__bubbles" data-chart="cluster-bubbles">
                {snapshot.clusters.map((cluster) => (
                  <li key={cluster.clusterId}>
                    <ClusterBubble
                      cluster={cluster}
                      totalMemories={snapshot.totalMemories}
                      now={now}
                    />
                  </li>
                ))}
              </ul>
            )}

            <section className="cluster-map__comparison" data-chart="cluster-comparison">
              <h3 className="memory__heading">{CLUSTER_COMPARISON_HEADING}</h3>
              <button
                type="button"
                data-action="compare-previous"
                disabled={previous === null}
                onClick={() => {
                  (onComparePrevious ?? noop)();
                }}
              >
                {BUTTON_COMPARE_PREVIOUS}
              </button>
              {previous === null ? (
                <p className="panel__empty" data-comparison-empty="">
                  {CLUSTER_NO_PREVIOUS_TEXT}
                </p>
              ) : (
                <ul
                  className="cluster-map__comparison-list"
                  data-comparison-source={comparisonRequested ? 'explicit' : 'auto'}
                >
                  {overlaps.map((row) => (
                    <li key={row.clusterId} data-overlap-cluster={row.clusterId}>
                      <span data-field="overlap-cluster">{row.clusterId}</span>
                      <span data-field="overlap-partner">
                        {row.partnerClusterId ?? NOT_AVAILABLE}
                      </span>
                      <span data-field="overlap-ratio" data-value={row.overlap}>
                        {clusterOverlapText(row.overlap)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        );
      }}
    </StatusBlock>
  );
}

/** `ClusterMap`（取数容器）的入参。 */
export interface ClusterMapProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** **初始**的「上次快照」（一般传 `null`；会话内由本面板自己累积）。 */
  readonly previous: ClustersResult | null;
}

/**
 * 面板 7（取数 + 展示 + 交互）。
 *
 * ⚠️ ★ **「上次结果」只在进程内**（`useState` / `useRef`），**不落盘**：
 *   设计要求是「本次会话内上次打开面板时的结果」，落盘会把它变成
 *   「上一版已发布快照」—— 那是另一件事，也正是基准说明要防的误解。
 *
 * ⚠️ 判定「是不是新快照」用的是 `computedAt`（**不是 `asOf`**）：
 *   `asOf` 是图的时间点，同一张图重算两次 `asOf` 可能相同，但 `computedAt` 一定变
 *   ⇒ 用 `asOf` 判断会漏掉「同一张图的新一次计算」。
 */
export function ClusterMap({
  port,
  now,
  previous: initialPrevious,
}: ClusterMapProps): ReactElement {
  const [previous, setPrevious] = useState<ClustersResult | null>(initialPrevious);
  const [comparisonRequested, setComparisonRequested] = useState<boolean>(false);
  /** 上一份**快照对象**（不是时间戳：对比要算成员集合的重叠度）。 */
  const lastSnapshotRef = useRef<ClustersResult | null>(initialPrevious);
  /** 已经吸收过的 `computedAt`（防止同一份快照被 effect 反复搬进 `previous`）。 */
  const absorbedAtRef = useRef<number | null>(initialPrevious?.computedAt ?? null);

  const state = useReadCall<ClustersResult>(port, `clusters:${now}`, (activePort) =>
    loadClusters(activePort, now),
  );

  const readySnapshot = state.status === 'ready' ? state.data : null;

  useEffect(() => {
    if (readySnapshot === null) {
      return;
    }
    if (absorbedAtRef.current === readySnapshot.computedAt) {
      return;
    }
    // 这一次是**新的**快照 ⇒ 把上一份存成「上次结果」，再把自己变成新的「上一份」。
    const last = lastSnapshotRef.current;
    if (last !== null) {
      setPrevious(last);
      setComparisonRequested(false);
    }
    absorbedAtRef.current = readySnapshot.computedAt;
    lastSnapshotRef.current = readySnapshot;
  }, [readySnapshot]);

  return (
    <ClusterMapView
      state={state}
      previous={previous}
      now={now}
      comparisonRequested={comparisonRequested}
      onComparePrevious={() => {
        setComparisonRequested(true);
      }}
    />
  );
}
