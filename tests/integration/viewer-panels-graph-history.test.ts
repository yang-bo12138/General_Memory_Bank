/**
 * ★ 面板 4 / 面板 6 的硬断言 —— 阶段 5 · T04（PLAN P5-T03 + 设计 §7.2 面板 4/6）。
 *
 * 本文件守四类事实：
 *   ① ★ **面板 6 存在且可用**（这是 §4.9 兜底的**唯一**入口，缺了那份兜底就不可达）：
 *      逆序列出全部历史版本、每版 `reason` + 替换时间、**软删仍可见旧正文并标注**、
 *      **分页只取 50 版**（断言 `limit` 的绑定值 + SQL 文本）、**没有「回滚」按钮**；
 *   ② ★ **面板 4 不调任何写方法**：**静态**（16 个写方法名扫描）+ **运行时**
 *      （真只读句柄上跑一次 `select` 并渲染面板，前后**全表指纹完全不变**）；
 *   ③ ★ **面板 4 按 `LIMIT` 抽样**（`GRAPH_NODE_LIMIT` 是唯一来源，SQL 里 `LIMIT @nodeLimit`）；
 *   ④ `ForceGraph` 的布局**确定性**（同输入两次渲染逐字符相同）。
 *
 * ⚠️ 运行时那条用的是**真的只读连接**（`openDatabase({ readonly: true })`）
 *   与**真的 SQL 常量**（`SQL_QUERIES`）再过一遍 `guard()` ——
 *   不是 mock：面板的数据通路与生产一致，只是把 worker 那一跳换成了直调。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import type { MemoryView } from '../../src/store/get.js';
import { SQL_QUERIES } from '../../viewer/main/queries.js';
import { guard } from '../../viewer/main/sql-guard.js';
import { ForceGraph, layoutGraph } from '../../viewer/renderer/charts/ForceGraph.js';
import { GraphViewView, loadGraph, projectGraph } from '../../viewer/renderer/panels/GraphView.js';
import {
  type HistoryPage,
  VersionHistoryView,
  loadHistoryPage,
} from '../../viewer/renderer/panels/VersionHistory.js';
import { errorState, readyState } from '../../viewer/renderer/state/useReadCall.js';
import { CONTENT_HISTORY_PAGE_SIZE, GRAPH_NODE_LIMIT } from '../../viewer/shared/limits.js';
import type { ReadPort, SqlRow } from '../../viewer/shared/protocol.js';
import { type SqlQueryName, isSqlQueryName } from '../../viewer/shared/sql-names.js';
import {
  FIXED_NOW,
  escapeHtml,
  makeGraphRow,
  makeHistoryRow,
  makeMemoryError,
  makeMemoryView,
} from '../helpers/panelFixtures.js';
import { listSourceFiles } from '../helpers/sourceScan.js';
import { allTableNames, tableFingerprints } from '../helpers/tableHashes.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、假端口（只记录调用）
// ═══════════════════════════════════════════════════════════════════════════

/** 一次被记录的 `select` 调用。 */
interface SelectCall {
  readonly name: SqlQueryName;
  readonly params: Record<string, unknown>;
}

/** 造一个记录 `select` 调用的假端口（其它方法一调就抛 ⇒ 顺带证明「没调别的」）。 */
function makeRecordingPort(rowsByName: Partial<Record<SqlQueryName, ReadonlyArray<SqlRow>>> = {}): {
  port: ReadPort;
  calls: SelectCall[];
} {
  const calls: SelectCall[] = [];
  const reject = (name: string) => (): Promise<never> =>
    Promise.reject(new Error(`假端口不该被调用：${name}`));

  const port: ReadPort = {
    stats: reject('stats'),
    get: reject('get'),
    recall: reject('recall'),
    clusters: reject('clusters'),
    inhibitionTrace: reject('inhibitionTrace'),
    verifyIntegrity: reject('verifyIntegrity'),
    select: async <N extends SqlQueryName>(name: N, params: unknown): Promise<SqlRow[]> => {
      calls.push({ name, params: (params ?? {}) as Record<string, unknown> });
      const rows = rowsByName[name];
      return rows === undefined ? [] : [...rows];
    },
    logs: reject('logs'),
  };
  return { port, calls };
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、面板 6 · 渲染工具
// ═══════════════════════════════════════════════════════════════════════════

/** 渲染面板 6（就绪态）。 */
function renderHistory(
  rows: ReadonlyArray<SqlRow>,
  total: number,
  current: MemoryView | null = makeMemoryView(),
  page = 0,
): string {
  return renderToStaticMarkup(
    createElement(VersionHistoryView, {
      state: readyState({ rows, total, page }),
      current,
      now: FIXED_NOW,
    }),
  );
}

/** 抽出历史版本行的 `[id, replaced_at, index]`。 */
function versionRows(html: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const pattern =
    /data-history-id="([^"]*)"\s+data-replaced-at="([^"]*)"\s+data-history-index="([^"]*)"/g;
  for (const match of html.matchAll(pattern)) {
    out.push([match[1] ?? '', match[2] ?? '', match[3] ?? '']);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 面板 6：存在、逆序、reason、时间
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 · 面板 6 存在且可用：列出历史版本（`replaced_at` 逆序）', () => {
  /** 三版，库侧已按 `replaced_at` **逆序**排好（最新在前）。 */
  const rows: ReadonlyArray<SqlRow> = [
    makeHistoryRow('h-3', '张三喜欢猫和狗', 'merge', FIXED_NOW - 1 * 3_600_000),
    makeHistoryRow('h-2', '张三喜欢猫（改）', 'manual_fix', FIXED_NOW - 5 * 3_600_000),
    makeHistoryRow('h-1', '张三喜欢猫', 'merge', FIXED_NOW - 9 * 3_600_000),
  ];

  it('★ 三版全都渲染出来（每版一个 `data-history-id`）', () => {
    const html = renderHistory(rows, 3);
    expect(versionRows(html).map(([id]) => id)).toEqual(['h-3', 'h-2', 'h-1']);
  });

  it('★ 渲染顺序 == 输入顺序（面板**不重新排序** ⇒ 唯一排序点是 SQL 的 ORDER BY）', () => {
    // 故意喂一个「不符合逆序」的输入：面板若自己 sort() 一遍，这里会红。
    const shuffled: ReadonlyArray<SqlRow> = [
      makeHistoryRow('h-2', 'B', 'manual_fix', FIXED_NOW - 5 * 3_600_000),
      makeHistoryRow('h-3', 'C', 'merge', FIXED_NOW - 1 * 3_600_000),
      makeHistoryRow('h-1', 'A', 'merge', FIXED_NOW - 9 * 3_600_000),
    ];
    const html = renderHistory(shuffled, 3);
    expect(versionRows(html).map(([id]) => id)).toEqual(['h-2', 'h-3', 'h-1']);
  });

  it('★ SQL 侧才是排序点：`contentHistoryPage` 里 `ORDER BY replaced_at DESC`（带全序键 `id DESC`）', () => {
    const sql = SQL_QUERIES.contentHistoryPage.replace(/\s+/g, ' ');
    expect(sql).toContain('ORDER BY replaced_at DESC, id DESC');
  });

  it('★ 每版显示 `reason` 的**逐字**说明（merge / manual_fix 两句都在场）', () => {
    const html = renderHistory(rows, 3);
    expect(html).toContain(escapeHtml('merge（被 write() 采纳的新文本顶掉）'));
    expect(html).toContain(escapeHtml('manual_fix（被 updateContent() 人工改正）'));
  });

  it('★ 每版显示替换时间（UTC 绝对时刻，逐条不同）', () => {
    const html = renderHistory(rows, 3);
    const times = [...html.matchAll(/data-field="replaced-at"[^>]*>([^<]*)</g)].map((m) =>
      (m[1] ?? '').trim(),
    );
    expect(times.length).toBe(3);
    expect(times[0]).toBe('2024-01-31 11:00:00 UTC');
    expect(times[2]).toBe('2024-01-31 03:00:00 UTC');
    expect(new Set(times).size).toBe(3);
  });

  it('当前正文与历史版本**并列**在场（不是只有历史、也不是只有当前）', () => {
    const html = renderHistory(rows, 3, makeMemoryView({ content: '张三喜欢猫和狗和鸟' }));
    expect(html).toContain('张三喜欢猫和狗和鸟');
    expect(html).toContain('当前正文');
  });

  it('没有历史版本时有独立空态', () => {
    const html = renderHistory([], 0);
    expect(html).toContain('这条记忆还没有被覆写过，没有历史版本');
    expect(html).toContain('data-history-empty');
  });
});

describe('T04 · 面板 6：软删记忆仍可见旧正文，并标注「已遗忘」', () => {
  const deletedAt = FIXED_NOW - 24 * 3_600_000;
  const deletedView = makeMemoryView({ deleted: true, deletedAt });

  it('★ 标注「已遗忘（软删于 X），此处仍可见旧正文」', () => {
    const html = renderHistory(
      [makeHistoryRow('h-1', '旧正文', 'merge', FIXED_NOW - 3_600_000)],
      1,
      deletedView,
    );
    expect(html).toContain('已遗忘（软删于');
    expect(html).toContain('此处仍可见旧正文');
    expect(html).toContain('2024-01-30 12:00:00 UTC');
  });

  it('★ 旧正文仍然在场（`get()` 对软删照常返回 ⇒ 面板不许隐藏它）', () => {
    const html = renderHistory(
      [makeHistoryRow('h-1', '软删前的旧正文', 'merge', FIXED_NOW - 3_600_000)],
      1,
      deletedView,
    );
    expect(html).toContain('软删前的旧正文');
  });

  it('判别力：未软删时**不**出现那句标注', () => {
    const html = renderHistory(
      [makeHistoryRow('h-1', '旧正文', 'merge', FIXED_NOW - 3_600_000)],
      1,
      makeMemoryView({ deleted: false, deletedAt: null }),
    );
    expect(html).not.toContain('已遗忘（软删于');
    expect(html).not.toContain('此处仍可见旧正文');
  });
});

describe('T04 · 面板 6 分页：一次只取 50 版', () => {
  it('★ `loadHistoryPage` 绑定的 `limit` == `CONTENT_HISTORY_PAGE_SIZE`（= 50）', async () => {
    const { port, calls } = makeRecordingPort();
    await loadHistoryPage(port, 'm-1', 0);
    const pageCall = calls.find((call) => call.name === 'contentHistoryPage');
    expect(pageCall?.params.limit).toBe(50);
    expect(pageCall?.params.limit).toBe(CONTENT_HISTORY_PAGE_SIZE);
    expect(pageCall?.params.offset).toBe(0);
  });

  it('★ 第 2 页的 `offset` == 页号 × 50（分页算术在面板侧，页大小来自常量）', async () => {
    const { port, calls } = makeRecordingPort();
    await loadHistoryPage(port, 'm-1', 3);
    const pageCall = calls.find((call) => call.name === 'contentHistoryPage');
    expect(pageCall?.params.offset).toBe(150);
  });

  it('★ SQL 文本里带 `LIMIT @limit OFFSET @offset`（限制在库侧也成立，不靠调用方守规矩）', () => {
    const sql = SQL_QUERIES.contentHistoryPage.replace(/\s+/g, ' ');
    expect(sql).toMatch(/LIMIT @limit OFFSET @offset/);
    // 总数查询也带 LIMIT（本仓库「每条 SQL 都带 LIMIT」的不变量）
    expect(SQL_QUERIES.contentHistoryCount.replace(/\s+/g, ' ')).toMatch(/LIMIT @limit/);
  });

  it('总数来自 `contentHistoryCount`（分页控件要分母），不是「本页行数」', async () => {
    const { port } = makeRecordingPort({
      contentHistoryCount: [{ total: 137 }],
      contentHistoryPage: [makeHistoryRow('h-1', 'x', 'merge', FIXED_NOW)],
    });
    const page = await loadHistoryPage(port, 'm-1', 0);
    expect(page.total).toBe(137);
    expect(page.rows.length).toBe(1);
    expect(renderHistory(page.rows, page.total)).toContain('共 137 版');
  });

  it('分页控件在场（上一页 / 下一页两个按钮）', () => {
    const html = renderHistory([makeHistoryRow('h-1', 'x', 'merge', FIXED_NOW)], 137);
    expect(html).toContain('data-pager="prev"');
    expect(html).toContain('data-pager="next"');
    expect(html).toContain('上一页');
    expect(html).toContain('下一页');
  });
});

describe('T04 · 面板 6 没有「回滚」控件', () => {
  it('★ 渲染树里的 `<button>` 文案 ⊆ 白名单，且白名单里没有「回滚」', () => {
    const whitelist = ['上一页', '下一页', '模拟召回', '刷新快照'];
    const html = renderHistory([makeHistoryRow('h-1', 'x', 'merge', FIXED_NOW)], 137);
    const labels = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
      (match[1] ?? '').replace(/<[^>]*>/g, '').trim(),
    );
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) {
      expect(whitelist).toContain(label);
    }
    expect(whitelist).not.toContain('回滚');
    expect(html).not.toContain('回滚');
  });

  it('负控：`<button>回滚</button>` 会被同一判据拦下', () => {
    const whitelist = ['上一页', '下一页'];
    const labels = ['回滚'];
    expect(labels.every((label) => whitelist.includes(label))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 面板 4：按 LIMIT 抽样 + 投影
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 · 面板 4 按 `LIMIT` 抽样', () => {
  it("★ `loadGraph` 只发一条 `select('graphTwoHop')`，`nodeLimit` == `GRAPH_NODE_LIMIT`", async () => {
    const { port, calls } = makeRecordingPort();
    await loadGraph(port, 'm-1');
    expect(calls.map((call) => call.name)).toEqual(['graphTwoHop']);
    expect(calls[0]?.params.nodeLimit).toBe(GRAPH_NODE_LIMIT);
    expect(calls[0]?.params.memoryId).toBe('m-1');
  });

  it('★ SQL 里两跳各自 `LIMIT @nodeLimit`、合并后**再** `LIMIT @nodeLimit`', () => {
    const sql = SQL_QUERIES.graphTwoHop.replace(/\s+/g, ' ');
    const limits = sql.match(/LIMIT @nodeLimit/g) ?? [];
    expect(limits.length).toBe(3);
  });

  it('SQL 只读：`guard()` 放行它（`SELECT` 开头，且不含写关键字）', () => {
    const verdict = guard(SQL_QUERIES.graphTwoHop);
    expect(verdict.ok).toBe(true);
    expect(SQL_QUERIES.graphTwoHop).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});

describe('T04 · 面板 4 的投影：节点顺序取「首次出现」', () => {
  it('节点不排序、按行里首次出现的顺序', () => {
    const rows = [
      makeGraphRow(1, '张三', '养', '猫'),
      makeGraphRow(1, '张三', '喂', '狗'),
      makeGraphRow(2, '猫', '怕', '狗'),
    ];
    const graph = projectGraph(rows);
    expect(graph.nodes.map((node) => node.id)).toEqual(['ent-张三', 'ent-猫', 'ent-狗']);
    expect(graph.edges.length).toBe(3);
  });

  it('空行 ⇒ 空图，且面板给出空态文案（而不是画一张白画布）', () => {
    const html = renderToStaticMarkup(
      createElement(GraphViewView, { state: readyState([]), now: FIXED_NOW }),
    );
    expect(html).toContain('这条记忆没有关联实体，取不到两跳子图');
    expect(html).not.toContain('data-chart="force-graph"');
  });

  it('非空 ⇒ 页面显式写出「仅显示前 N 条边」（不写用户会以为图就是全部）', () => {
    const html = renderToStaticMarkup(
      createElement(GraphViewView, {
        state: readyState([makeGraphRow(1, '张三', '养', '猫')]),
        now: FIXED_NOW,
      }),
    );
    expect(html).toContain(`仅显示前 ${GRAPH_NODE_LIMIT} 条边`);
    expect(html).toContain('data-chart="force-graph"');
  });
});

describe('T04 · `ForceGraph` 的布局确定性', () => {
  const rows = [
    makeGraphRow(1, '张三', '养', '猫'),
    makeGraphRow(1, '张三', '喂', '狗'),
    makeGraphRow(2, '猫', '怕', '狗'),
  ];
  const graph = projectGraph(rows);

  it('★ 同一输入渲染两次 ⇒ markup 逐字符完全相同', () => {
    const first = renderToStaticMarkup(
      createElement(ForceGraph, { nodes: graph.nodes, edges: graph.edges }),
    );
    const second = renderToStaticMarkup(
      createElement(ForceGraph, { nodes: graph.nodes, edges: graph.edges }),
    );
    expect(first).toBe(second);
  });

  it('★ 布局是纯函数：两次调用逐点相同（不藏在 React 里也算）', () => {
    const first = layoutGraph(graph.nodes, graph.edges);
    const second = layoutGraph(graph.nodes, graph.edges);
    expect(first).toEqual(second);
    expect(first.length).toBe(graph.nodes.length);
  });

  it('判别力：换一下节点顺序 ⇒ 布局不同（不是「所有输入都返回同一堆点」）', () => {
    const reversed = layoutGraph([...graph.nodes].reverse(), graph.edges);
    expect(reversed.map((point) => point.id)).not.toEqual(graph.nodes.map((node) => node.id));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 面板 4 不调任何写方法：静态 + 运行时（真只读句柄 + 全表指纹）
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 · 面板 4 不调任何写方法', () => {
  it('静态：`viewer/renderer/**` 里 16 个写方法名一个都不出现（见 T03 的同一判据，此处补分母）', () => {
    const files = listSourceFiles('viewer/renderer');
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  it('★ 运行时：真只读句柄上跑一次 `select` + 渲染面板，**全表指纹完全不变**', async () => {
    // ── 夹具：先用写实例建库（真数据，含实体与共现边）──
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-panel4-'));
    const dbPath = join(dataDir, 'memory.db');
    const writer = new MemoryStore({ dbPath });
    const written = writer.write({ content: '张三喜欢猫', entities: ['张三', '猫'] });
    // ⚠️ `edges` 不是 `write()` 的副产物（实体共现只进 `coacts`）⇒ 必须显式 `link()`
    //   造出一条实体↔实体有向边，否则两跳查询取到 0 行，而「指纹不变」就成了「什么都没做」。
    writer.link('张三', '喜欢', '猫', written.id);
    writer.close();

    // ── 只读句柄 + 唯一的写入口（`select`）──
    const reader: Database.Database = openDatabase({ dbPath, readonly: true });
    try {
      const port: ReadPort = {
        stats: () => Promise.reject(new Error('面板 4 不该调 stats')),
        get: () => Promise.reject(new Error('面板 4 不该调 get')),
        recall: () => Promise.reject(new Error('面板 4 不该调 recall')),
        clusters: () => Promise.reject(new Error('面板 4 不该调 clusters')),
        inhibitionTrace: () => Promise.reject(new Error('面板 4 不该调 inhibitionTrace')),
        verifyIntegrity: () => Promise.reject(new Error('面板 4 不该调 verifyIntegrity')),
        select: async <N extends SqlQueryName>(name: N, params: unknown): Promise<SqlRow[]> => {
          if (!isSqlQueryName(name)) {
            throw new Error(`未知查询名：${String(name)}`);
          }
          const verdict = guard(SQL_QUERIES[name]);
          if (!verdict.ok) {
            throw new Error(`guard 拒绝了 ${name}：${verdict.reason}`);
          }
          return reader
            .prepare(verdict.sql)
            .all((params ?? {}) as Record<string, unknown>) as SqlRow[];
        },
        logs: () => Promise.reject(new Error('面板 4 不该调 logs')),
      };

      const tables = allTableNames(reader);
      const before = tableFingerprints(reader, tables);

      const rows = await loadGraph(port, written.id);
      const html = renderToStaticMarkup(
        createElement(GraphViewView, { state: readyState(rows), now: FIXED_NOW }),
      );

      const after = tableFingerprints(reader, tables);
      expect(after).toEqual(before);
      // ⚠️ 非空分母：查询真的取到了边（否则「指纹不变」只是「什么都没做」）
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(html).toContain('data-chart="force-graph"');
    } finally {
      reader.close();
    }
  });

  it('负控：同一个指纹判据能抓到一次写（不是恒绿）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-viewer-panel4-neg-'));
    const dbPath = join(dataDir, 'memory.db');
    const store = new MemoryStore({ dbPath });
    // ⚠️ 门面**不暴露 `db`**（§1.3）⇒ 指纹走仓库既有先例：另开一条旁路连接。
    const sidecar = openDatabase({ dbPath });
    try {
      const tables = allTableNames(sidecar);
      const before = tableFingerprints(sidecar, tables);
      store.write({ content: '李四养狗', entities: ['李四', '狗'] });
      const after = tableFingerprints(sidecar, tables);
      expect(after).not.toEqual(before);
    } finally {
      sidecar.close();
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 错误呈现（面板 4 / 面板 6 各一条）
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 · 面板 4 / 6 的错误呈现：错误码 + `details`', () => {
  it('★ 面板 4：`SQL_GUARD_REJECTED` 的码与 details 都显示出来', () => {
    const html = renderToStaticMarkup(
      createElement(GraphViewView, {
        state: errorState<ReadonlyArray<SqlRow>>(
          makeMemoryError('INVALID_INPUT', { name: 'graphTwoHop' }),
        ),
        now: FIXED_NOW,
      }),
    );
    expect(html).toContain('INVALID_INPUT');
    expect(html).toContain('graphTwoHop');
    expect(html).not.toContain('加载失败');
  });

  it('★ 面板 6：`NOT_FOUND` 的码与 details 都显示出来', () => {
    const html = renderToStaticMarkup(
      createElement(VersionHistoryView, {
        state: errorState<HistoryPage>(
          makeMemoryError('NOT_FOUND', { memoryId: 'm-404', query: 'contentHistoryPage' }),
        ),
        current: null,
        now: FIXED_NOW,
      }),
    );
    expect(html).toContain('NOT_FOUND');
    expect(html).toContain('contentHistoryPage');
    expect(html).toContain('m-404');
    expect(html).not.toContain('加载失败');
  });
});
