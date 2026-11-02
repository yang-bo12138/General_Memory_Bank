/**
 * ★ 面板 4 · **图谱可视化（两跳以内）** —— 阶段 5 · T04（设计 §7.2 面板 4）。
 *
 * 三条硬约束：
 *   ① ★ **只读**：数据来自 `port.select('graphTwoHop', …)`（一条已放行的 `SELECT`），
 *      **不调 `link()`、不做任何写**。运行时那条由「渲染前后全表哈希不变」钉住
 *      （`viewer-panels-graph-history.test.ts`），静态那条由 16 个写方法名的扫描钉住。
 *   ② ★ **按 `LIMIT` 抽样**：`nodeLimit` 的**唯一来源**是 `GRAPH_NODE_LIMIT`
 *      （库线程还会把外来值再钳一次）⇒ 大图不会把 worker 钉住。
 *   ③ **边表是全量投影**（抽了多少条就列多少条），并在页面上**显式写出**
 *      「仅显示前 N 条边」—— 不写，用户会以为图就是全部。
 *
 * ⚠️ 本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`；
 *   也不写 `try/catch`（错误统一由 `useReadCall` → `StatusBlock` 处理）。
 */

import type { ReactElement } from 'react';

import { GRAPH_NODE_LIMIT } from '../../shared/limits.js';
import type { ReadPort, SqlRow } from '../../shared/protocol.js';
import { ForceGraph } from '../charts/ForceGraph.js';
import type { ForceGraphEdge, ForceGraphNode } from '../charts/ForceGraph.js';
import { StatusBlock } from '../state/StatusBlock.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
  GRAPH_EDGE_COLUMNS,
  GRAPH_EMPTY_TEXT,
  GRAPH_PREDICATE_EMPTY,
  PANEL_TITLES,
  graphSampleText,
} from '../texts.js';

/** 面板 4 的读调用（**只读 `SELECT`**，边数上界来自常量）。 */
export async function loadGraph(port: ReadPort, memoryId: string): Promise<ReadonlyArray<SqlRow>> {
  return port.select('graphTwoHop', { memoryId, nodeLimit: GRAPH_NODE_LIMIT });
}

/** 从一行里安全取一个字符串（`SqlRow` 的值是 `string | number | null`）。 */
function textOf(row: SqlRow, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

/** 从一行里安全取一个数字。 */
function numberOf(row: SqlRow, key: string, fallback: number): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 从行里安全取一个整数（`hop` 用）。 */
function hopOf(row: SqlRow): 1 | 2 {
  return numberOf(row, 'hop', 1) === 2 ? 2 : 1;
}

/** 一张从行投影出来的图。 */
export interface ProjectedGraph {
  /** 节点（**插入顺序** = 行里首次出现的顺序；布局的确定性依赖它）。 */
  readonly nodes: ReadonlyArray<ForceGraphNode>;
  /** 边（**行的原始顺序**）。 */
  readonly edges: ReadonlyArray<ForceGraphEdge>;
  /** 原始行（表格用）。 */
  readonly rows: ReadonlyArray<SqlRow>;
}

/**
 * 把 `graphTwoHop` 的行投影成节点 + 边。
 *
 * ⚠️ **节点顺序取「首次出现」**（`Map` 的插入顺序），不排序：
 *   排序会让「先出现的主体」这件事丢失，而布局的初始圆周位置正是按这个顺序摆的
 *   ⇒ 两侧各排一次序，图就会在两次渲染之间跳一下（即使输入完全一样也没用）。
 */
export function projectGraph(rows: ReadonlyArray<SqlRow>): ProjectedGraph {
  const nodes: ForceGraphNode[] = [];
  const seen = new Set<string>();
  const edges: ForceGraphEdge[] = [];

  /** 登记一个节点（首次出现时决定 `hop`）。 */
  const register = (id: string, label: string, hop: 1 | 2): void => {
    if (id === '' || seen.has(id)) {
      return;
    }
    seen.add(id);
    nodes.push({ id, label: label === '' ? id : label, hop });
  };

  for (const row of rows) {
    const hop = hopOf(row);
    const subjectId = textOf(row, 'subject_id');
    const objectId = textOf(row, 'object_id');
    register(subjectId, textOf(row, 'subject_name'), hop);
    register(objectId, textOf(row, 'object_name'), hop);
    edges.push({
      id: textOf(row, 'edge_id') || `${subjectId}->${objectId}`,
      source: subjectId,
      target: objectId,
      label: textOf(row, 'predicate'),
      weight: numberOf(row, 'weight', 1),
    });
  }

  return { nodes, edges, rows };
}

/** `GraphViewView`（纯展示）的入参。 */
export interface GraphViewViewProps {
  /** 本次 `select` 的读状态。 */
  readonly state: ReadState<ReadonlyArray<SqlRow>>;
  /** 注入的当前时刻（只用于文案）。 */
  readonly now: number;
}

/** 面板 4 的**纯展示层**。 */
export function GraphViewView({ state, now }: GraphViewViewProps): ReactElement {
  return (
    <StatusBlock state={state} what={PANEL_TITLES.graphView}>
      {(rows: ReadonlyArray<SqlRow>) => {
        const graph = projectGraph(rows);
        return (
          <div className="panel panel--graph" data-panel-body="graphView" data-now={now}>
            <h2 className="panel__title">{PANEL_TITLES.graphView}</h2>
            {rows.length === 0 ? (
              <p className="panel__empty" data-graph-empty="">
                {GRAPH_EMPTY_TEXT}
              </p>
            ) : (
              <>
                <p className="overview__hint" data-sample-note="">
                  {graphSampleText(rows.length, GRAPH_NODE_LIMIT)}
                </p>
                <ForceGraph nodes={graph.nodes} edges={graph.edges} />
                <table className="graph__table" data-chart="graph-edges">
                  <thead>
                    <tr>
                      {GRAPH_EDGE_COLUMNS.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={`${textOf(row, 'edge_id')}:${index}`} data-edge-row={index}>
                        <td data-field="hop">{hopOf(row)}</td>
                        <td data-field="subject">{textOf(row, 'subject_name')}</td>
                        <td data-field="predicate">
                          {textOf(row, 'predicate') || GRAPH_PREDICATE_EMPTY}
                        </td>
                        <td data-field="object">{textOf(row, 'object_name')}</td>
                        <td data-field="weight">{numberOf(row, 'weight', 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        );
      }}
    </StatusBlock>
  );
}

/** `GraphView`（取数容器）的入参。 */
export interface GraphViewProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** 种子记忆 id。 */
  readonly memoryId: string;
}

/** 面板 4（取数 + 展示）。 */
export function GraphView({ port, now, memoryId }: GraphViewProps): ReactElement {
  const state = useReadCall<ReadonlyArray<SqlRow>>(port, `graph:${memoryId}`, (activePort) =>
    loadGraph(activePort, memoryId),
  );
  return <GraphViewView state={state} now={now} />;
}
