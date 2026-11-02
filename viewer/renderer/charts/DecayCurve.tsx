/**
 * ★ 面板 2 的**强度衰减曲线** —— 阶段 5 · T03（设计 §7.2 面板 2）。
 *
 * ⚠️ ★ **曲线的时间常数取 `effectiveStability`（= `stability × pin_factor`）**，
 *   不是 `stability`（§4.1：`pin_factor` 在**分母内**，拉长 τ ⇒ 衰减更慢）。
 *   写成 `stability` 的症状是：置顶过的记忆在图上以**正常速度**衰减，
 *   而真实库里它慢 2.5 倍 ⇒ 用户会认为「置顶没生效」。
 *   ⇒ 判别力落在 `data-tau-days` 上：注入 `stability=10, pinFactor=2.5` ⇒ 必须渲染 `25`。
 *     实现若用 `stability`，这里会是 `10`（测试会红）。
 *
 * ⚠️ ★ **renderer 不做任何时间计算**（§7.6 / `MemoryDetail` 的注释）：
 *   `curve[].t` / `layerMarks` / `archiveAt` / `dropOutL3At` 全部是**库线程算好的**，
 *   本文件只做「坐标 → SVG 点」的线性映射与文案。
 *   ⇒ 「核心计算复用纯函数算法模块」（§7.1 保证 ③）因此是**结构性事实**：
 *     渲染进程手上根本没有 `exp(-t/τ)` 这个公式。
 */

import type { ReactElement } from 'react';

import type { MemoryLayer } from '../../../src/core/decay.js';
import {
  DECAY_HEADING,
  archiveText,
  decayTauText,
  dropOutL3Text,
  formatDuration,
  formatScore,
} from '../texts.js';

/** 曲线上的一个采样点（与 `MemoryDetail.curve` 的元素同形）。 */
export interface DecayPoint {
  readonly t: number;
  readonly intensity: number;
  readonly layer: MemoryLayer;
}

/** `DecayCurve` 的入参。 */
export interface DecayCurveProps {
  /** 库线程采好的点（120 个左右）。 */
  readonly curve: ReadonlyArray<DecayPoint>;
  /** 三条层级分界线（画横线用）。 */
  readonly layerMarks: { readonly l3: number; readonly l2: number; readonly archived: number };
  /** ★ **有效**稳定度（天）= `stability × pin_factor`；**不是** `stability`。 */
  readonly tauDays: number;
  /** 当前强度（用于文案，不参与曲线形状）。 */
  readonly currentIntensity: number;
  /** 注入的当前时刻（epoch 毫秒）。 */
  readonly now: number;
  /** 跌入归档的时刻（epoch 毫秒）。 */
  readonly archiveAt: number;
  /** 跌出 L3 的时刻（`null` = 已经跌出）。 */
  readonly dropOutL3At: number | null;
}

/** 画布尺寸（固定值 ⇒ 快照稳定）。 */
const WIDTH = 640;
/** 画布尺寸（固定值 ⇒ 快照稳定）。 */
const HEIGHT = 240;

/** 内边距（左侧留给纵轴刻度）。 */
const PAD_LEFT = 44;
/** 内边距。 */
const PAD_RIGHT = 12;
/** 内边距（顶部留给标题线）。 */
const PAD_TOP = 12;
/** 内边距（底部留给横轴）。 */
const PAD_BOTTOM = 24;

/** 把一个值钳到 `[low, high]`。 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * 画衰减曲线。
 *
 * ⚠️ **横轴不是「天数」而是绝对时刻的线性映射**：`t` 可能跨几十年（一条极老的记忆），
 *   直接按天数画会把「最近这一周」压成一条竖线。
 */
export function DecayCurve({
  curve,
  layerMarks,
  tauDays,
  currentIntensity,
  now,
  archiveAt,
  dropOutL3At,
}: DecayCurveProps): ReactElement {
  const first = curve[0];
  const last = curve[curve.length - 1];
  const startT = first === undefined ? now : first.t;
  const endT = last === undefined ? now : last.t;
  const span = endT - startT === 0 ? 1 : endT - startT;

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const toX = (t: number): number => PAD_LEFT + ((t - startT) / span) * plotWidth;
  const toY = (value: number): number => PAD_TOP + (1 - clamp(value, 0, 1)) * plotHeight;

  const points = curve.map(
    (point) => `${toX(point.t).toFixed(2)},${toY(point.intensity).toFixed(2)}`,
  );

  /** 三条层级分界线的 y 坐标。 */
  const marks: ReadonlyArray<{ key: string; y: number; label: string }> = [
    { key: 'l3', y: toY(layerMarks.l3), label: `L3 线 ${formatScore(layerMarks.l3)}` },
    { key: 'l2', y: toY(layerMarks.l2), label: `L2 线 ${formatScore(layerMarks.l2)}` },
    {
      key: 'archived',
      y: toY(layerMarks.archived),
      label: `归档线 ${formatScore(layerMarks.archived)}`,
    },
  ];

  const l3Remaining = dropOutL3At === null ? null : dropOutL3At - now;
  const archiveRemaining = archiveAt - now;

  return (
    <section
      className="decay"
      data-chart="decay-curve"
      data-tau-days={tauDays}
      data-point-count={curve.length}
    >
      <h3 className="decay__heading">{DECAY_HEADING}</h3>
      <p className="decay__tau" data-tau-text="">
        {decayTauText(tauDays)}
      </p>

      <svg
        className="decay__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={DECAY_HEADING}
      >
        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={plotWidth}
          height={plotHeight}
          className="decay__plot"
        />
        {marks.map((mark) => (
          <g key={mark.key}>
            <line
              x1={PAD_LEFT}
              y1={mark.y}
              x2={PAD_LEFT + plotWidth}
              y2={mark.y}
              className={`decay__mark decay__mark--${mark.key}`}
            />
            <text x={PAD_LEFT + 2} y={mark.y - 3} className="decay__mark-label">
              {mark.label}
            </text>
          </g>
        ))}
        <polyline className="decay__line" points={points.join(' ')} />
      </svg>

      <ul className="decay__legend">
        <li data-legend="current">当前强度 {formatScore(currentIntensity)}</li>
        <li data-legend="drop-out-l3">{dropOutL3Text(l3Remaining)}</li>
        <li data-legend="archive">{archiveText(archiveRemaining)}</li>
        <li data-legend="archive-at">
          跌入归档时刻 {formatDuration(Math.max(0, archiveRemaining))}后
        </li>
      </ul>
    </section>
  );
}
