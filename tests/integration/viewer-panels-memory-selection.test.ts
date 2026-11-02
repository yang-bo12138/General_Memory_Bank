/**
 * ★ **「选哪一条记忆」这条通路的硬断言** —— 阶段 5 · P5-T04 的缺陷修复。
 *
 * ★ **它守的是什么（缺陷原话）**：
 *   改之前 `viewer/renderer/App.tsx` 把 `selection.memoryId` **写死成空串**，
 *   而全 renderer **没有任何入口**能改它 —— 而 `memoryId` 是面板 2 / 4 / 6 的
 *   **唯一取数键**：
 *     · 面板 2 ⇒ 永远渲染「库里没有这条记忆」（看起来像报错），零控件可救；
 *     · 面板 4 ⇒ `graphTwoHop { memoryId: '' }` ⇒ 图恒空；
 *     · 面板 6 ⇒ `contentHistoryCount` 恒 0 ⇒ **上一页 / 下一页永久 disabled**。
 *   ⇒ PLAN 的 `P5-T03` 第一条硬断言是「**面板 6 存在且可用**」，而现状是打开永远是一张空表。
 *
 * ★ 本文件按「通路」分五节，每节都是**成对**的（正向 + 反例/判别力）：
 *   ① 取数：`recentMemories` 真的被调用一次，且 `limit` 来自常量（空库也调用 ⇒ 列表不是假数据）；
 *   ② 投影：行 → 列表条目的纯函数（顺序、空 id、摘要截断）；
 *   ③ 面板 2：`memoryId=''` ⇒ 「尚未选择记忆」引导 **且** 列表在场；
 *      `memoryId='m-404'` ⇒ 仍是「库里没有这条记忆」（两种空态**不混用**）；
 *   ④ 面板 6：`memoryId=''` ⇒ 两个 pager **disabled**；有真实 id + 有历史 ⇒ **pager 可用**；
 *   ⑤ 面板 4 + `App` 的接线：空 id 不发那条注定空的查询；`App` 持有 `memoryId` 并接到面板 2。
 *
 * ⚠️ **本文件不删任何既有断言**：它只**新增**。既有的面板断言在
 *   `viewer-panels-structure.test.ts` / `viewer-panels-graph-history.test.ts` /
 *   `navigation.test.ts`（本文件的纯函数那几条与它同口径，不重复造第二套语义）。
 * ⚠️ **本文件是 `.ts`、不写 JSX**（`vitest.config.ts` 的 include 只收 `.test.ts`）。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App, DEFAULT_SELECTION } from '../../viewer/renderer/App.js';
import { GraphView } from '../../viewer/renderer/panels/GraphView.js';
import { MemoryListView } from '../../viewer/renderer/panels/MemoryList.js';
import { VersionHistory, VersionHistoryView } from '../../viewer/renderer/panels/VersionHistory.js';
import {
  RECENT_SUMMARY_MAX_CHARS,
  loadRecentMemories,
  projectRecentMemories,
} from '../../viewer/renderer/state/Selection.js';
import { readyState } from '../../viewer/renderer/state/useReadCall.js';
import {
  BUTTON_LABELS,
  MISSING_MEMORY_TEXT,
  NO_MEMORY_SELECTED_TEXT,
  RECENT_MEMORY_EMPTY_TEXT,
  RECENT_MEMORY_HEADING,
} from '../../viewer/renderer/texts.js';
import { CONTENT_HISTORY_PAGE_SIZE, RECENT_MEMORY_LIMIT } from '../../viewer/shared/limits.js';
import type { ReadPort, SqlRow } from '../../viewer/shared/protocol.js';
import type { SqlQueryName } from '../../viewer/shared/sql-names.js';
import {
  FIXED_NOW,
  escapeHtml,
  makeHistoryRow,
  makeMemoryDetail,
  makeMemoryView,
  makeRecentMemoryRow,
} from '../helpers/panelFixtures.js';
import { readCode } from '../helpers/sourceScan.js';

// ═══════════════════════════════════════════════════════════════════════════
// 假端口（记录 `select` 的调用）
// ═══════════════════════════════════════════════════════════════════════════

/** 一次被记录的 `select` 调用。 */
interface SelectCall {
  readonly name: SqlQueryName;
  readonly params: Record<string, unknown>;
}

/**
 * 造一个记录 `select` 调用的假端口（其它方法一调就抛 ⇒ 顺带证明「没调别的」）。
 *
 * ⚠️ 缺省返回**空数组**：这就是「空库」的形态（列表必须**仍然**被调用过一次，
 *   否则「列表靠上层假数据渲染」这件事就测不出来）。
 */
function makeRecordingPort(rows: ReadonlyArray<SqlRow> = []): {
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
      return [...rows];
    },
    logs: reject('logs'),
  };
  return { port, calls };
}

/** 渲染面板 2（可带「最近记忆」的读状态）。 */
function renderMemoryList(options: {
  readonly state?: Parameters<typeof MemoryListView>[0]['state'];
  readonly memoryId?: string;
  readonly recent?: Parameters<typeof MemoryListView>[0]['recent'];
  readonly idDraft?: string;
}): string {
  const state = options.state ?? readyState(makeMemoryDetail());
  return renderToStaticMarkup(
    createElement(MemoryListView, {
      state,
      now: FIXED_NOW,
      memoryId: options.memoryId ?? 'm-1',
      ...(options.recent === undefined ? {} : { recent: options.recent }),
      ...(options.idDraft === undefined ? {} : { idDraft: options.idDraft }),
    }),
  );
}

/** 从 markup 里抽出所有 `<button>` 的可见文案。 */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    (match[1] ?? '').replace(/<[^>]*>/g, '').trim(),
  );
}

/** 抽出所有「列表行」的 id（`data-pick-memory`）。 */
function pickTargets(html: string): string[] {
  return [...html.matchAll(/data-pick-memory="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** 两个「最近记忆」夹具行（**顺序 = 最近在前**）。 */
const RECENT_ROWS: ReadonlyArray<SqlRow> = [
  makeRecentMemoryRow('m-new', '张三昨天又喂了猫', FIXED_NOW - 3_600_000, 12.5),
  makeRecentMemoryRow('m-old', '李四养狗', FIXED_NOW - 30 * 3_600_000, 8),
];

// ═══════════════════════════════════════════════════════════════════════════
// ① 取数：`recentMemories` 真的被调用，且 limit 来自常量
// ═══════════════════════════════════════════════════════════════════════════

describe('P5-T04 · ① 「最近记忆」的取数接线（空库也真的调用过一次）', () => {
  it("★ `loadRecentMemories` 只发一条 `select('recentMemories')`，`limit` == 常量 50", async () => {
    const { port, calls } = makeRecordingPort();

    const rows = await loadRecentMemories(port);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('recentMemories');
    expect(calls[0]?.params.limit).toBe(RECENT_MEMORY_LIMIT);
    // 两条一起断：既是常量的值，也是**写死的 50**（有人改常量时这条会提醒「设计口径变了」）
    expect(calls[0]?.params.limit).toBe(50);
    // ⚠️ 空库 ⇒ 空数组，**不是** undefined / 不是抛错
    expect(rows).toEqual([]);
  });

  it('★ 空库时**依然**调用了一次（证明列表不是「靠上层假数据渲染」的）', async () => {
    const { port, calls } = makeRecordingPort([]);
    await loadRecentMemories(port);
    // ⚠️ 这条的判别力：若实现写成「没有行就不查 / 直接用上层数据」，calls 会是 0 条
    expect(calls.length).toBe(1);
  });

  it('★ 它**不带 `memoryId`**（列表的语义是「库里最近的若干条」，不是某一条的历史）', async () => {
    const { port, calls } = makeRecordingPort();
    await loadRecentMemories(port);
    expect(Object.hasOwn(calls[0]?.params ?? {}, 'memoryId')).toBe(false);
    expect(Object.keys(calls[0]?.params ?? {})).toEqual(['limit']);
  });

  it('★ 有数据时原样返回给调用方（投影在面板侧做，取数层不预加工）', async () => {
    const { port } = makeRecordingPort(RECENT_ROWS);
    const rows = await loadRecentMemories(port);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).toEqual(['m-new', 'm-old']);
  });

  it('反例：`CONTENT_HISTORY_PAGE_SIZE` 与它**不是同一个量**（数值相同只是巧合）', () => {
    // 两个常量各自独立：谁被调都不该牵动另一个
    expect(RECENT_MEMORY_LIMIT).toBe(50);
    expect(CONTENT_HISTORY_PAGE_SIZE).toBe(50);
    expect(RECENT_MEMORY_LIMIT).not.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 投影：行 → 列表条目（纯函数）
// ═══════════════════════════════════════════════════════════════════════════

describe('P5-T04 · ② `projectRecentMemories`：顺序、空 id、摘要截断', () => {
  it('★ 顺序 == SQL 给的顺序（面板**不再排一遍**：唯一排序点是 `ORDER BY last_access DESC`）', () => {
    const entries = projectRecentMemories(RECENT_ROWS);
    expect(entries.map((entry) => entry.id)).toEqual(['m-new', 'm-old']);
  });

  it('★ 四个字段都搬到条目上（`id` / 摘要 / `last_access` / `stability`）', () => {
    const [first] = projectRecentMemories(RECENT_ROWS);
    expect(first?.id).toBe('m-new');
    expect(first?.summary).toBe('张三昨天又喂了猫');
    expect(first?.lastAccess).toBe(FIXED_NOW - 3_600_000);
    expect(first?.stability).toBe(12.5);
  });

  it('★ `id` 为空的行被丢掉（点了不会换选中项 ⇒ 不留一个点了没反应的行）', () => {
    const entries = projectRecentMemories([
      makeRecentMemoryRow('', '没有 id 的脏行'),
      makeRecentMemoryRow('m-1', '正常行'),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['m-1']);
  });

  it('★ 超长正文被截断到 `RECENT_SUMMARY_MAX_CHARS` 并加省略号（列表不撑破版面）', () => {
    const long = '记'.repeat(RECENT_SUMMARY_MAX_CHARS + 10);
    const [entry] = projectRecentMemories([makeRecentMemoryRow('m-1', long)]);
    expect(entry?.summary).toBe(`${'记'.repeat(RECENT_SUMMARY_MAX_CHARS)}…`);
    expect(entry?.summary.length).toBe(RECENT_SUMMARY_MAX_CHARS + 1);
  });

  it('反例（判别力）：**没超长**的正文一个字符都不动（不是「一律截断」）', () => {
    const exact = '记'.repeat(RECENT_SUMMARY_MAX_CHARS);
    const [entry] = projectRecentMemories([makeRecentMemoryRow('m-1', exact)]);
    expect(entry?.summary).toBe(exact);
    expect(entry?.summary).not.toContain('…');
  });

  it('★ 空输入 ⇒ 空数组（不抛错），且两次调用逐字段相同（纯函数）', () => {
    expect(projectRecentMemories([])).toEqual([]);
    expect(projectRecentMemories(RECENT_ROWS)).toEqual(projectRecentMemories(RECENT_ROWS));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 面板 2：两种空态**不混用** + 列表在场
// ═══════════════════════════════════════════════════════════════════════════

describe('P5-T04 · ③ 面板 2：`memoryId` 为空 ⇒ 「尚未选择记忆」引导（不再像报错）', () => {
  it('★ 空 id ⇒ 引导句 + **去哪选** + 最近记忆列表都在场', () => {
    const html = renderMemoryList({
      memoryId: '',
      state: readyState(null),
      recent: readyState(RECENT_ROWS),
    });

    expect(html).toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    // 「去哪选」必须写出来（只写「尚未选择」等于把下一步藏起来）
    expect(html).toContain('最近记忆');
    expect(html).toContain('data-select-guide');
    // 列表本体在场：两行、id 逐条对得上
    expect(html).toContain('data-recent-list');
    expect(pickTargets(html)).toEqual(['m-new', 'm-old']);
    // 独立的空态标记（**不是** `missing`）：两者混用就又会变回「像报错」
    expect(html).toContain('data-state="no-selection"');
    expect(html).toContain('data-no-memory-selected');
  });

  it('★ 空 id ⇒ **不再**出现「库里没有这条记忆」（那条是「查不到」，不是「还没选」）', () => {
    const html = renderMemoryList({
      memoryId: '',
      state: readyState(null),
      recent: readyState(RECENT_ROWS),
    });
    expect(html).not.toContain(MISSING_MEMORY_TEXT);
    expect(html).not.toContain('data-state="missing"');
  });

  it('★ 反例（成对）：有 id 但查不到 ⇒ 仍然是「库里没有这条记忆」+ 那个 id', () => {
    const html = renderMemoryList({
      memoryId: 'm-404',
      state: readyState(null),
      recent: readyState(RECENT_ROWS),
    });
    expect(html).toContain(MISSING_MEMORY_TEXT);
    expect(html).toContain('m-404');
    expect(html).toContain('data-state="missing"');
    // 反方向：**不许**退化成「尚未选择记忆」
    expect(html).not.toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
  });

  it('★ 列表为空 ⇒ 明确的空态文案（不是一块空白）', () => {
    const html = renderMemoryList({
      memoryId: '',
      state: readyState(null),
      recent: readyState([]),
    });
    expect(html).toContain('data-recent-empty');
    expect(html).toContain(escapeHtml(RECENT_MEMORY_EMPTY_TEXT));
    // 空列表也得留下「按 id 查看」这条兜底
    expect(html).toContain('data-field="memory-id-input"');
  });

  it('★ 列表标题与「按 id 查看」输入框在**就绪态**也在场（选择入口常驻，不是只在空态出现）', () => {
    const html = renderMemoryList({ memoryId: 'm-new', recent: readyState(RECENT_ROWS) });
    expect(html).toContain(escapeHtml(RECENT_MEMORY_HEADING));
    expect(html).toContain('data-field="memory-id-input"');
    // 当前选中项被标出来（否则用户不知道「我现在看的是哪一条」）
    expect(html).toContain('data-current="true"');
  });

  it('★ 「按 id 查看」按钮：空输入 ⇒ disabled；有输入 ⇒ 不 disabled（成对）', () => {
    const blank = renderMemoryList({ memoryId: '', recent: readyState([]), idDraft: '   ' });
    expect(blank).toMatch(/data-submit-memory-id=""[^>]*disabled/);

    const filled = renderMemoryList({ memoryId: '', recent: readyState([]), idDraft: 'm-1' });
    expect(filled).not.toMatch(/data-submit-memory-id=""[^>]*disabled/);
  });

  it('★ 面板 2 的按钮只有两类：N 个「最近记忆」行 + 1 个「按 id 查看」', () => {
    const html = renderMemoryList({ memoryId: '', recent: readyState(RECENT_ROWS) });
    const labels = buttonLabels(html);
    expect(labels).toEqual(['张三昨天又喂了猫', '李四养狗', '按 id 查看']);
    // 提交按钮的文案是**写死**的那一条（与 `BUTTON_LABELS` 里的白名单条目一致）
    expect(labels).toContain('按 id 查看');
    expect(BUTTON_LABELS).toContain('按 id 查看');
  });

  it('★ 「最近记忆」的行是**另一种可点元素**：没有 `data-action` / `data-pager` / `data-nav-panel`', () => {
    // ⚠️ 它们是「选中项」而不是「面板动作」⇒ 走 `data-pick-memory` 这条独立判据
    //   （与 `App` 的导航按钮用 `data-nav-panel` 同一思路，见 `App.tsx` 文件头）。
    const html = renderMemoryList({ memoryId: '', recent: readyState(RECENT_ROWS) });
    const pickButtons = [...html.matchAll(/<button[^>]*data-pick-memory="[^"]*"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(pickButtons).toHaveLength(2);
    for (const tag of pickButtons) {
      expect(tag).not.toContain('data-action=');
      expect(tag).not.toContain('data-pager=');
      expect(tag).not.toContain('data-nav-panel=');
    }
  });

  it('★ 新增的可点元素里**没有任何写动作字样**（回滚/删除/遗忘/恢复/写入/维护/重建/编辑/保存）', () => {
    const html = renderMemoryList({ memoryId: '', recent: readyState(RECENT_ROWS) });
    for (const label of buttonLabels(html)) {
      for (const word of ['回滚', '删除', '遗忘', '恢复', '写入', '维护', '重建', '编辑', '保存']) {
        expect(label, `可点元素「${label}」含写动作字样「${word}」`).not.toContain(word);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 面板 6：pager 在空 id 时 disabled、有 id 时可用（成对 —— 这就是原缺陷的靶心）
// ═══════════════════════════════════════════════════════════════════════════

describe('P5-T04 · ④ 面板 6：`memoryId` 为空 ⇒ 两个 pager **disabled**', () => {
  /** 渲染面板 6 的**容器**（`memoryId` 走真实入参 ⇒ 与 `App` 传下来的一致）。 */
  function renderHistoryContainer(memoryId: string): string {
    const { port } = makeRecordingPort();
    return renderToStaticMarkup(
      createElement(VersionHistory, { port, now: FIXED_NOW, memoryId, page: 0 }),
    );
  }

  it('★ 空 id ⇒ 「尚未选择记忆」+ 上一页 / 下一页都带 `disabled`', () => {
    const html = renderHistoryContainer('');
    expect(html).toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    expect(html).toMatch(/data-pager="prev"[^>]*disabled/);
    expect(html).toMatch(/data-pager="next"[^>]*disabled/);
    // 也不该画「加载更早的版本」（没东西可加载）
    expect(html).not.toContain('data-pager="older"');
  });

  it('★ 空 id ⇒ 不画「这条记忆还没有被覆写过」那种**像结论**的空表文案', () => {
    const html = renderHistoryContainer('');
    expect(html).not.toContain('这条记忆还没有被覆写过');
    expect(html).not.toContain('data-history-empty');
  });

  it('★ 反例（成对）：有 id ⇒ **不出现**「尚未选择记忆」，也不画那条 inert pager', () => {
    const html = renderHistoryContainer('m-1');
    expect(html).not.toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    expect(html).not.toContain('data-pager-block="inert"');
  });
});

describe('P5-T04 · ④ 面板 6：选中记忆且**有历史** ⇒ pager 真的可用', () => {
  /** 一页历史（`total` 远大于页大小 ⇒ 还存在下一页）。 */
  const rows: ReadonlyArray<SqlRow> = [
    makeHistoryRow('h-1', '旧正文', 'merge', FIXED_NOW - 3_600_000),
  ];

  /** 渲染面板 6 的展示层（就绪态）。 */
  function renderHistory(page: number, total: number): string {
    return renderToStaticMarkup(
      createElement(VersionHistoryView, {
        state: readyState({ rows, total, page }),
        current: makeMemoryView(),
        now: FIXED_NOW,
      }),
    );
  }

  it('★ 第 1 页 + total > 50 ⇒ 「下一页」**不** disabled（原缺陷里它永久 disabled）', () => {
    const html = renderHistory(0, 137);
    expect(html).not.toMatch(/data-pager="next"[^>]*disabled/);
    // 分母：分页真的配了「多页」（total 超过页大小一页）
    expect(137).toBeGreaterThan(CONTENT_HISTORY_PAGE_SIZE);
    expect(html).toContain('共 137 版');
  });

  it('★ 第 2 页 ⇒ 「上一页」也**不** disabled（两头都要能走）', () => {
    const html = renderHistory(1, 137);
    expect(html).not.toMatch(/data-pager="prev"[^>]*disabled/);
    expect(html).not.toMatch(/data-pager="next"[^>]*disabled/);
  });

  it('★ 反例（成对）：第 1 页时「上一页」**仍然** disabled（不是「两个都恒不 disabled」）', () => {
    const html = renderHistory(0, 137);
    expect(html).toMatch(/data-pager="prev"[^>]*disabled/);
  });

  it('★ 反例（成对）：`total` 只有一页 ⇒ 「下一页」disabled（边界仍是 `page+1 * 页大小 >= total`）', () => {
    const html = renderHistory(0, 3);
    expect(html).toMatch(/data-pager="next"[^>]*disabled/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 面板 4 与 `App` 的接线
// ═══════════════════════════════════════════════════════════════════════════

describe('P5-T04 · ⑤ 面板 4：空 id ⇒ 引导，而不是「这条记忆没有关联实体」这种假结论', () => {
  it('★ 空 id ⇒ 「尚未选择记忆」+ 不出现那句「没有关联实体」', () => {
    const { port } = makeRecordingPort();
    const html = renderToStaticMarkup(
      createElement(GraphView, { port, now: FIXED_NOW, memoryId: '' }),
    );
    expect(html).toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    expect(html).not.toContain('这条记忆没有关联实体');
    expect(html).toContain('data-panel-body="graphView"');
  });

  it('★ 源码层：空 id 时 `port` 被换成 `null`（⇒ 一次查询都不发）', () => {
    // ⚠️ SSR 里 `useEffect` 不跑 ⇒ 「有没有发请求」在渲染层测不到，
    //   只能读源码：guard 的形态必须是 `selected ? port : null`。
    const code = readCode('viewer/renderer/panels/GraphView.tsx');
    expect(code).toContain('isMemorySelected');
    expect(code).toMatch(/selected \? port : null/);
  });

  it("★ 反例（判别力）：面板 6 / 面板 2 也必须用同一个判据（不许各写 `memoryId === ''`）", () => {
    for (const file of [
      'viewer/renderer/panels/VersionHistory.tsx',
      'viewer/renderer/panels/MemoryList.tsx',
    ]) {
      const code = readCode(file);
      expect(code, `${file} 没有用 isMemorySelected`).toContain('isMemorySelected');
      expect(code, `${file} 自己写了一遍空串判据`).not.toMatch(/memoryId === ''/);
    }
  });
});

describe('P5-T04 · ⑤ `App`：`memoryId` 是一等状态，且接到了面板 2 的入口上', () => {
  it('★ 默认打开（总览）时不出现「尚未选择记忆」（第一屏不是一块引导）', () => {
    const { port } = makeRecordingPort();
    const html = renderToStaticMarkup(createElement(App, { port, now: FIXED_NOW }));
    expect(html).not.toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    expect(html).toContain('data-selected-memory=""');
  });

  it('★ 切到面板 2 且**缺省未选** ⇒ 引导 + 选择器（这就是「有入口」的可渲染证据）', () => {
    const { port } = makeRecordingPort();
    const html = renderToStaticMarkup(
      createElement(App, {
        port,
        now: FIXED_NOW,
        selection: { ...DEFAULT_SELECTION, panel: 'memoryList' },
      }),
    );
    expect(html).toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    expect(html).toContain('data-field="memory-id-input"');
    expect(html).toContain('按 id 查看');
  });

  it('★ 反例（成对）：同样在面板 2，但注入真实 id ⇒ 不再是引导', () => {
    const { port } = makeRecordingPort();
    const html = renderToStaticMarkup(
      createElement(App, {
        port,
        now: FIXED_NOW,
        selection: { ...DEFAULT_SELECTION, panel: 'memoryList', memoryId: 'm-1' },
      }),
    );
    expect(html).not.toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    expect(html).toContain('data-selected-memory="m-1"');
  });

  it('★ 源码层：`App` 用 `useState` 持有 `memoryId`，选中走 `nextMemoryId`（不是直接 setState(picked)）', () => {
    const code = readCode('viewer/renderer/App.tsx');
    expect(code).toContain('useState<string>(selection.memoryId)');
    expect(code).toContain('nextMemoryId');
    expect(code).toContain('onSelectMemory');
    // 反例：「直接 setMemoryId(picked)」是省掉 trim 判断的一行版实现
    expect(code).not.toMatch(/setMemoryId\(picked\)/);
  });

  it('★ 源码层：renderer 里**没有**任何 `port.<写方法>(` 调用点（选择入口不含写动作）', () => {
    const code = readCode('viewer/renderer/state/Selection.tsx');
    expect(code).not.toMatch(
      /port\s*\.\s*(write|touch|link|forget|restore|pin|updateContent)\s*\(/,
    );
    // 它只调这一个读方法
    expect(code).toContain("select('recentMemories'");
  });

  it('★ 面板 6 也是「同一个选中项」驱动的：`App` 把 `memoryId` 传给 `VersionHistory`', () => {
    const { port } = makeRecordingPort();
    const html = renderToStaticMarkup(
      createElement(App, {
        port,
        now: FIXED_NOW,
        selection: { ...DEFAULT_SELECTION, panel: 'versionHistory' },
      }),
    );
    // 空 id ⇒ 面板 6 走引导分支（pager 全 disabled）—— 这条把「App 的状态」与
    // 「面板 6 的可用性」接在同一根线上
    expect(html).toContain(escapeHtml(NO_MEMORY_SELECTED_TEXT));
    expect(html).toMatch(/data-pager="prev"[^>]*disabled/);
    expect(html).toMatch(/data-pager="next"[^>]*disabled/);
  });
});
