/**
 * ★ 面板 4 的**轻量力导向布局** —— 阶段 5 · T04（设计 §7.2 面板 4）。
 *
 * ★ **本文件的布局是确定性的**（同输入 ⇒ 同输出，逐字符相同）：
 *   ① 初始位置按**输入顺序**排在圆周上（不用随机数 ⇒ 不用 `Math.random`）；
 *   ② **固定迭代次数**（`ITERATIONS`），不按「合力小于阈值就停」收敛
 *      （那种停止条件会让结果依赖浮点累加的顺序细节，换一台机器就可能差一位）；
 *   ③ 每个循环的遍历顺序**写死**（`i` 从 0 到 n、`j` 从 `i+1` 到 n），不遍历 `Map` / `Set`
 *      （它们的迭代顺序取决于插入顺序，插一次就可能变）。
 *
 * ⚠️ 缺了这三条，快照会**永远飘**：今天绿、明天红，而根因只是「浮点相加顺序变了」。
 *   `viewer-panels-graph-history.test.ts` 有一条「渲染两次逐字符相同」的断言钉住它。
 *
 * ⚠️ 本文件不读时钟、不读随机数、不 import `electron` / `better-sqlite3` / `viewer/main/**`。
 */

import type { ReactElement } from 'react';

/** 图上的一个节点。 */
export interface ForceGraphNode {
  /** 实体 id。 */
  readonly id: string;
  /** 展示名。 */
  readonly label: string;
  /** 第几跳（1 = 种子的一跳邻居，2 = 二跳）。 */
  readonly hop: number;
}

/** 图上的一条有向边。 */
export interface ForceGraphEdge {
  /** 边 id。 */
  readonly id: string;
  /** 起点实体 id。 */
  readonly source: string;
  /** 终点实体 id。 */
  readonly target: string;
  /** 谓词（边上没有谓词时由调用方给占位）。 */
  readonly label: string;
  /** 边权（只用于线宽）。 */
  readonly weight: number;
}

/** 布局算出来的一个点。 */
export interface GraphPoint {
  /** 实体 id。 */
  readonly id: string;
  /** 横坐标。 */
  readonly x: number;
  /** 纵坐标。 */
  readonly y: number;
}

/** 画布宽（固定 ⇒ 快照稳定）。 */
const WIDTH = 640;

/** 画布高（固定 ⇒ 快照稳定）。 */
const HEIGHT = 300;

/** ★ **固定迭代次数**（不是「收敛即停」，见文件头第 ②条）。 */
const ITERATIONS = 60;

/** 节点斥力系数。 */
const REPULSION = 6000;

/** 边的弹簧系数。 */
const SPRING = 0.02;

/** 每步速度保留比例（阻尼）。 */
const DAMPING = 0.85;

/** 边权的展示上限（线宽用，避免一条权重 100 的边画成一条黑带）。 */
const MAX_DISPLAY_WEIGHT = 5;

/**
 * 参与布局的节点上限。
 *
 * ⚠️ 布局是 `O(n² × ITERATIONS)`：600 个节点要算 1000 万次，面板打开就会卡一下。
 *   超出上限的节点**不进画布**（但它们**仍在边表里**——表格是全量投影，不抽样，
 *   抽样只发生在这里，且调用方会在 `graphSampleText()` 里把「仅显示前 N 条边」写出来）。
 *   ⚠️ 这里刻意不用 `GraphView` 的 `GRAPH_NODE_LIMIT`：一个是**查询**上限、一个是**布局**上限，
 *     两者混用会让「改了查询上限 ⇒ 布局突然变慢」这件事毫无提示。
 */
export const FORCE_GRAPH_MAX_NODES = 120;

/** 把值钳到 `[low, high]`。 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * 算布局（**纯函数、确定性**）。
 *
 * @param nodes 节点（**顺序即初始圆周位置**）
 * @param edges 边（端点不在 `nodes` 里的边**被忽略**，不抛错）
 * @param width 画布宽
 * @param height 画布高
 * @returns 与 `nodes` **同序**的点数组
 */
export function layoutGraph(
  nodes: ReadonlyArray<ForceGraphNode>,
  edges: ReadonlyArray<ForceGraphEdge>,
  width: number = WIDTH,
  height: number = HEIGHT,
): ReadonlyArray<GraphPoint> {
  const count = Math.min(nodes.length, FORCE_GRAPH_MAX_NODES);
  if (count === 0) {
    return [];
  }

  const centreX = width / 2;
  const centreY = height / 2;
  const radius = Math.min(width, height) * 0.35;

  // ① 初始位置：按输入顺序排在圆周上（确定性，无随机数）
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (2 * Math.PI * index) / count;
    xs.push(centreX + radius * Math.cos(angle));
    ys.push(centreY + radius * Math.sin(angle));
  }

  // 端点 → 下标的映射（**只用查表，不迭代** ⇒ 不代入 Map 的迭代顺序）
  const indexById = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    if (node !== undefined) {
      indexById.set(node.id, index);
    }
  }

  const dxs = new Array<number>(count).fill(0);
  const dys = new Array<number>(count).fill(0);

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    // ② 斥力：写死的 i < j 双循环
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const xi = xs[i] ?? 0;
        const yi = ys[i] ?? 0;
        const xj = xs[j] ?? 0;
        const yj = ys[j] ?? 0;
        let dx = xi - xj;
        let dy = yi - yj;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 1e-6) {
          // 重合点：给一个**写死的**小位移（不是随机抖动）
          dx = (i - j) * 0.01;
          dy = 0.01;
          distanceSquared = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSquared);
        const force = REPULSION / distanceSquared;
        const unitX = dx / distance;
        const unitY = dy / distance;
        dxs[i] = (dxs[i] ?? 0) + unitX * force;
        dys[i] = (dys[i] ?? 0) + unitY * force;
        dxs[j] = (dxs[j] ?? 0) - unitX * force;
        dys[j] = (dys[j] ?? 0) - unitY * force;
      }
    }

    // ③ 引力：按 edges 的**输入顺序**遍历
    for (const edge of edges) {
      const sourceIndex = indexById.get(edge.source);
      const targetIndex = indexById.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) {
        continue;
      }
      const dx = (xs[targetIndex] ?? 0) - (xs[sourceIndex] ?? 0);
      const dy = (ys[targetIndex] ?? 0) - (ys[sourceIndex] ?? 0);
      dxs[sourceIndex] = (dxs[sourceIndex] ?? 0) + dx * SPRING;
      dys[sourceIndex] = (dys[sourceIndex] ?? 0) + dy * SPRING;
      dxs[targetIndex] = (dxs[targetIndex] ?? 0) - dx * SPRING;
      dys[targetIndex] = (dys[targetIndex] ?? 0) - dy * SPRING;
    }

    // ④ 积分 + 阻尼 + 收进画布
    for (let index = 0; index < count; index += 1) {
      const dampedX = (dxs[index] ?? 0) * DAMPING;
      const dampedY = (dys[index] ?? 0) * DAMPING;
      dxs[index] = dampedX;
      dys[index] = dampedY;
      xs[index] = clamp((xs[index] ?? centreX) + dampedX, 12, width - 12);
      ys[index] = clamp((ys[index] ?? centreY) + dampedY, 12, height - 12);
    }
  }

  const points: GraphPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    if (node !== undefined) {
      // ⚠️ 保留 2 位小数：不多不少，正好让快照字符串稳定且肉眼看得出位置
      points.push({
        id: node.id,
        x: Math.round((xs[index] ?? centreX) * 100) / 100,
        y: Math.round((ys[index] ?? centreY) * 100) / 100,
      });
    }
  }
  return points;
}

/** `ForceGraph` 的入参。 */
export interface ForceGraphProps {
  /** 节点（同序决定初始布局）。 */
  readonly nodes: ReadonlyArray<ForceGraphNode>;
  /** 边。 */
  readonly edges: ReadonlyArray<ForceGraphEdge>;
  /** 画布宽（缺省 640）。 */
  readonly width?: number;
  /** 画布高（缺省 300）。 */
  readonly height?: number;
}

/**
 * 画一张两跳子图。
 *
 * ⚠️ 布局结果**没有**被缓存：同输入两次渲染算两遍、结果逐字符相同（这就是确定性断言的内容）。
 *   缓存反而会掩盖「布局里混进了随机数 / 时钟」这件事。
 */
export function ForceGraph({
  nodes,
  edges,
  width = WIDTH,
  height = HEIGHT,
}: ForceGraphProps): ReactElement {
  const points = layoutGraph(nodes, edges, width, height);
  const positionById = new Map<string, GraphPoint>();
  for (const point of points) {
    positionById.set(point.id, point);
  }

  const drawnEdges = edges.filter(
    (edge) => positionById.has(edge.source) && positionById.has(edge.target),
  );

  return (
    <svg
      className="graph__svg"
      data-chart="force-graph"
      data-node-count={nodes.length}
      data-laid-out-count={points.length}
      data-edge-count={drawnEdges.length}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="两跳关联图"
    >
      {drawnEdges.map((edge) => {
        const from = positionById.get(edge.source);
        const to = positionById.get(edge.target);
        if (from === undefined || to === undefined) {
          return null;
        }
        return (
          <line
            key={edge.id}
            className="graph__edge"
            data-edge-id={edge.id}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            strokeWidth={clamp(edge.weight, 1, MAX_DISPLAY_WEIGHT)}
          />
        );
      })}
      {points.map((point, index) => {
        const node = nodes[index];
        return (
          <g key={point.id} data-node-entity-id={point.id}>
            <circle
              className={`graph__node${node !== undefined && node.hop === 2 ? ' graph__node--hop2' : ''}`}
              cx={point.x}
              cy={point.y}
              r={node !== undefined && node.hop === 1 ? 6 : 4}
            />
            <text className="graph__node-label" x={point.x + 7} y={point.y + 3}>
              {node?.label ?? point.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
