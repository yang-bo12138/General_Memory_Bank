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
 * ⚠️ ★ **「上次结果」的基准说明常驻**（`LAST_SNAPSHOT_BASELINE`）：
 *   跨快照比较**只在进程内做**（§3）⇒ 这里的「上次」是
 *   **本次会话内上次打开面板时的结果**，**不是**「上一版已发布快照」。
 *   不说清楚，用户会拿它去跟一个它并不是的东西比。
 *
 * ⚠️ 本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`，也不写 `try/catch`。
 */

import type { ReactElement } from 'react';

import type { ClustersResult } from '../../../src/store/clusters.js';
import type { ReadPort } from '../../shared/protocol.js';
import { StatusBlock } from '../state/StatusBlock.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
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

/** 面板 7 的读调用。 */
export async function loadClusters(port: ReadPort, now: number): Promise<ClustersResult> {
  return port.clusters(now);
}

/**
 * ★ **两个成员集合的重叠度**（Jaccard 的「按较小集合归一」变体）。
 *
 * ⚠️ 为什么按 `min(|A|,|B|)` 而不是并集：
 *   簇会长大（今天 10 条、明天 60 条且包含原来那 10 条）——
 *   用并集归一会让「完全包含」只得到 0.17，看起来像「几乎不是同一个簇」；
 *   而它其实是**同一个簇变大了**。按较小集合归一后，完全包含 = 1.0。
 *
 * ⚠️ 这是**纯函数**（不读 `now`、不读库）⇒ 单测可以逐值断言，
 *   也是「快照对比不用 `key`」那条的**判别力所在**：
 *   两次快照里同名簇的 `key` 相同但成员不同 ⇒ 重叠度 != 1。
 *
 * @param previous 上次快照的成员 id
 * @param next 本次快照的成员 id（**顺序不参与计算**，只做集合语义）
 * @returns `[0, 1]`；任一侧为空 ⇒ 0
 */
export function memberOverlapRatio(
  previous: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): number {
  if (previous.length === 0 || next.length === 0) {
    return 0;
  }
  const previousSet = new Set(previous);
  let shared = 0;
  for (const id of next) {
    if (previousSet.has(id)) {
      shared += 1;
    }
  }
  return shared / Math.min(previous.length, next.length);
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
      const overlap = memberOverlapRatio(candidate.memberIds, cluster.memberIds);
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
}

/** 面板 7 的**纯展示层**。 */
export function ClusterMapView({ state, previous, now }: ClusterMapViewProps): ReactElement {
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
              {previous === null ? (
                <p className="panel__empty" data-comparison-empty="">
                  {CLUSTER_NO_PREVIOUS_TEXT}
                </p>
              ) : (
                <ul className="cluster-map__comparison-list">
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
  /** 本次会话内上一次的快照。 */
  readonly previous: ClustersResult | null;
}

/** 面板 7（取数 + 展示）。 */
export function ClusterMap({ port, now, previous }: ClusterMapProps): ReactElement {
  const state = useReadCall<ClustersResult>(port, `clusters:${now}`, (activePort) =>
    loadClusters(activePort, now),
  );
  return <ClusterMapView state={state} previous={previous} now={now} />;
}
