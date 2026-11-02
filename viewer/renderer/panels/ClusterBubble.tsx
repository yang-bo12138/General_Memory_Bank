/**
 * ★ 面板 7 的一个**簇气泡** —— 阶段 5 · T04（设计 §7.2 面板 7 / §4.12.4）。
 *
 * 三条硬点：
 *   ① ★ **成员顺序与 `clusters().memberIds` 完全一致**：本文件**不排序、不去重、不重排**。
 *      `memberIds` 的口径是「按有效 affinity 降序、同值按 id 字典序升序」（§6 / §4.12.4 ①）
 *      ⇒ 面板再写一个排序键，两处必然出现「同 affinity 时顺序不同」的那一天，
 *        而那一天的表现是「成员列表不可复现」（同一份数据两次打开顺序不一样）。
 *   ② ★ **成员列表带 `LIMIT`**：`CLUSTER_MEMBER_SAMPLE_MAX`（默认 50，来自 `DEFAULT_PARAMS`）。
 *      超出部分不渲染，但**必须写出**「仅显示前 N 条成员（该簇共 M 条）」——
 *      不写，用户会以为这个簇只有 50 条。
 *   ③ **巨型簇不隐藏**（占比照实显示）：用户确实在发大量近重复内容，这是**事实**；
 *      藏起来比展示它更危险（§4.12.4）。
 *
 * ⚠️ 折叠用 `<details>` 而不是「按钮 + state」：
 *   静态渲染（`renderToStaticMarkup`）跑不了 `useState` 的交互，
 *   而 `<details>` 让「成员列表在 markup 里**总是**存在」——
 *   「渲染出的成员行数 == 50」这条断言才不需要先点一下按钮。
 */

import type { ReactElement } from 'react';

import type { ClusterView } from '../../../src/store/clusters.js';
import { CLUSTER_MEMBER_SAMPLE_MAX } from '../../shared/limits.js';
import { CLUSTER_MEMBERS_SUMMARY, clusterMemberCapText, formatPercent } from '../texts.js';

/** `ClusterBubble` 的入参。 */
export interface ClusterBubbleProps {
  /** 簇的呈现视图（`memberIds` 已由库侧排好序并截到样本上限）。 */
  readonly cluster: ClusterView;
  /** 全库未删记忆数（算占比的分母）。 */
  readonly totalMemories: number;
  /** 注入的当前时刻（只用于文案）。 */
  readonly now: number;
}

/** 簇内高频实体最多显示几个（§7.2 面板 7：「`entities` 的前 3 个」）。 */
const TOP_ENTITY_COUNT = 3;

/**
 * 一个簇气泡。
 *
 * ⚠️ **气泡大小 = `size`**（§7.2）：用 `sqrt(size)` 映射到直径，
 *   因为面积应与成员数成正比（直接按 `size` 给直径会让 100 条成员的簇看起来大 100 倍）。
 */
export function ClusterBubble({ cluster, totalMemories, now }: ClusterBubbleProps): ReactElement {
  /** 成员列表的截断上限：**唯一来源**是 `CLUSTER_MEMBER_SAMPLE_MAX`。 */
  const cap = Math.max(0, CLUSTER_MEMBER_SAMPLE_MAX);
  const shownMembers = cluster.memberIds.slice(0, cap);
  const share = totalMemories > 0 ? cluster.size / totalMemories : 0;
  const diameter = 12 + Math.sqrt(Math.max(0, cluster.size)) * 3;
  const topEntities = cluster.entities.slice(0, TOP_ENTITY_COUNT);

  return (
    <section
      className="cluster-bubble"
      data-cluster-id={cluster.clusterId}
      data-cluster-size={cluster.size}
      data-cluster-share={share.toFixed(4)}
      data-cluster-members-shown={shownMembers.length}
      data-cluster-members-total={cluster.memberIds.length}
      data-now={now}
      style={{ minWidth: `${diameter}px` }}
    >
      <h3 className="cluster-bubble__heading" data-field="label">
        {cluster.label ?? cluster.clusterId}
      </h3>
      <p className="cluster-bubble__meta" data-field="size">
        {`成员 ${cluster.size} 条（占全库 ${formatPercent(share)}）`}
      </p>
      <p className="cluster-bubble__meta" data-field="entities">
        {topEntities.length === 0 ? '（无高频实体）' : topEntities.join(' / ')}
      </p>
      <p className="cluster-bubble__meta" data-field="representative">
        {`代表记忆：${cluster.representativeId}`}
      </p>

      <details className="cluster-bubble__members">
        <summary data-field="members-summary">
          {`${CLUSTER_MEMBERS_SUMMARY}（${shownMembers.length} / ${cluster.memberIds.length}）`}
        </summary>
        <p className="cluster-bubble__meta" data-field="members-cap">
          {clusterMemberCapText(shownMembers.length, cluster.memberIds.length)}
        </p>
        <ol className="cluster-bubble__member-list" data-chart="cluster-members">
          {shownMembers.map((memberId) => (
            <li key={memberId} data-member-id={memberId}>
              {memberId}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
