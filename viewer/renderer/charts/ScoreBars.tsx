/**
 * ★ 面板 3 的**打分明细柱状图** —— 阶段 5 · T03（设计 §7.2 面板 3）。
 *
 * 三个「不得」都落在本文件上：
 *   ① **只有五根柱**（活跃度 0.30 / 语义 0.25 / 文本 0.20 / 图谱 0.15 / 新近 0.10），
 *      且五根柱的**加权值之和 == `Hit.score`**（§4.13.1 硬约束①的可视化对应物）；
 *   ② ★ **被抑制的条目不进柱状图**（它们在 `RecallSimulator` 里单列一栏）——
 *      混进来会让人以为「五项加起来不等于 score」（抑制**不改分数**，它只回答「谁没进 topN」）；
 *   ③ **原始证据 `rawBm25` 与 `cos` 并列显示**，`null` 显示为 `—` 而**不是 `0`**
 *      （`0` 是「走了这条路但得 0 分」，`null` 是「压根没走这条路」，两者混同会误导排障方向）。
 *
 * ⚠️ **每根柱同时给两个读数**：
 *   `data-value`（**原始数字**，供断言「五柱之和 == score」用浮点精确比较）
 *   `data-value-text`（**三位小数的展示串**，供用户读）。
 *   只给展示串会让「五柱之和」被三次四舍五入污染；只给原始数字则用户读到 `0.29999999999999993`。
 */

import type { ReactElement } from 'react';

import type { RecallBreakdown } from '../../../src/store/recall.js';
import {
  COS_LABEL,
  NOT_AVAILABLE,
  RAW_BM25_LABEL,
  SCORE_BARS_HEADING,
  SCORE_FACTOR_LABELS,
  formatScore,
} from '../texts.js';

/** `ScoreBars` 的入参。 */
export interface ScoreBarsProps {
  /** 命中的记忆 id（挂在本节的 `data-memory-id` 上，供「柱状图里有没有被抑制项」的集合断言用）。 */
  readonly memoryId: string;
  /** 本次融合总分（五柱之和必须等于它，误差 ≤ 1e-9）。 */
  readonly score: number;
  /** 五项的加权值 + 两条原始证据。 */
  readonly breakdown: RecallBreakdown;
}

/** 把 `[0,1]` 之外的值钳进来（柱宽用）。 */
function barWidth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value)) * 100;
}

/**
 * 一条命中的五根柱 + 两条原始证据。
 *
 * ⚠️ `data-chart="score-bars"` 与 `data-memory-id` 写在**同一个 `<section>` 上**：
 *   「柱状图容器里的 id 集合」这个断言需要一个**唯一的、可正则匹配的**锚点，
 *   否则「被抑制项有没有混进柱状图」只能靠肉眼看 markup。
 */
export function ScoreBars({ memoryId, score, breakdown }: ScoreBarsProps): ReactElement {
  return (
    <section
      className="score-bars"
      data-chart="score-bars"
      data-memory-id={memoryId}
      data-score={score}
    >
      <h4 className="score-bars__heading">{SCORE_BARS_HEADING}</h4>
      <ul className="score-bars__list">
        {SCORE_FACTOR_LABELS.map(({ factor, label }) => {
          const value = breakdown[factor];
          return (
            <li
              key={factor}
              className="score-bars__row"
              data-factor={factor}
              data-value={value}
              data-value-text={formatScore(value)}
            >
              <span className="score-bars__label">{label}</span>
              <span className="score-bars__track">
                <span className="score-bars__bar" style={{ width: `${barWidth(value)}%` }} />
              </span>
              <span className="score-bars__value">{formatScore(value)}</span>
            </li>
          );
        })}
      </ul>
      <p className="score-bars__evidence">
        <span className="score-bars__evidence-item" data-evidence="rawBm25">
          {`${RAW_BM25_LABEL}=${breakdown.rawBm25 === null ? NOT_AVAILABLE : String(breakdown.rawBm25)}`}
        </span>
        <span className="score-bars__evidence-item" data-evidence="cos">
          {`${COS_LABEL}=${breakdown.cos === null ? NOT_AVAILABLE : String(breakdown.cos)}`}
        </span>
      </p>
    </section>
  );
}
