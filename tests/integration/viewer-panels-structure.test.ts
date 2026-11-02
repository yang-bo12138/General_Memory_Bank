/**
 * ★ 面板 2 / 3 与**共用状态层**的结构断言 —— 阶段 5 · T03（PLAN P5-T02 + §7.3）。
 *
 * 本文件守三类事实：
 *   ① **面板 3 的诊断口径**：无 embedder ⇒ 「本次未执行向量路」+ `vectorPart` 恒 0；
 *      **被抑制条目单列一栏，不混进柱状图**；`rawBm25` / `cos` 并列且 `null` 显示 `—`；
 *   ② **面板 2 的曲线用 `effectiveStability`**（含 `pin_factor`）；
 *   ③ **无写入口**（三层钉）+ **七个面板共用同一套状态组件** + **错误码 + details**。
 *
 * ⚠️ 渲染走 `react-dom/server` 的 `renderToStaticMarkup`
 *   （`environment: 'node'` + `pool: 'forks'` 是 better-sqlite3 的硬要求 ⇒ 不装 jsdom）。
 *   ⇒ 面板必须把「取数」与「画」拆开（容器 + `*View`），测试直接喂状态给 `*View`。
 *
 * ⚠️ 本文件是 `.ts`、不写 JSX（`vitest.config.ts` 的 include 只收 `.test.ts`）。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { App, DEFAULT_SELECTION, WIRED_PANELS } from '../../viewer/renderer/App.js';
import { ClusterMapView } from '../../viewer/renderer/panels/ClusterMap.js';
import { GraphViewView } from '../../viewer/renderer/panels/GraphView.js';
import { LogViewerView } from '../../viewer/renderer/panels/LogViewer.js';
import { MemoryListView } from '../../viewer/renderer/panels/MemoryList.js';
import { OverviewView } from '../../viewer/renderer/panels/Overview.js';
import { RecallSimulatorView } from '../../viewer/renderer/panels/RecallSimulator.js';
import {
  loadRecallSim,
  nextSubmitted,
  recallRunner,
  shouldRunRecall,
} from '../../viewer/renderer/panels/RecallSimulator.js';
import { VersionHistoryView } from '../../viewer/renderer/panels/VersionHistory.js';
import { errorState, readyState } from '../../viewer/renderer/state/useReadCall.js';
import { PANEL_ORDER, PANEL_TITLES } from '../../viewer/renderer/texts.js';
import { WRITE_CHANNELS } from '../../viewer/shared/channels.js';
import {
  type ReadPort,
  type WorkspaceError,
  asWorkspaceError,
} from '../../viewer/shared/protocol.js';
import {
  FIXED_NOW,
  breakdownSum,
  makeBreakdown,
  makeClustersResult,
  makeGraphRow,
  makeHistoryRow,
  makeLogPage,
  makeMemoryDetail,
  makeMemoryError,
  makeRecallHit,
  makeRecallSimResult,
  makeStats,
  makeSuppressed,
  scoreBarMemoryIds,
  scoreBarRows,
} from '../helpers/panelFixtures.js';
import {
  filesCallingWriteMethods,
  findWriteMethodCalls,
  listSourceFiles,
  readCode,
} from '../helpers/sourceScan.js';

// ═══════════════════════════════════════════════════════════════════════════
// 渲染工具（`.ts` 里用 `createElement`，不写 JSX）
// ═══════════════════════════════════════════════════════════════════════════

/** 渲染面板 2（就绪态或其它状态）。 */
function renderMemoryList(
  state: Parameters<typeof MemoryListView>[0]['state'],
  memoryId = 'm-1',
): string {
  return renderToStaticMarkup(createElement(MemoryListView, { state, now: FIXED_NOW, memoryId }));
}

/** 渲染面板 3（给定状态）。 */
function renderRecall(state: Parameters<typeof RecallSimulatorView>[0]['state']): string {
  return renderToStaticMarkup(
    createElement(RecallSimulatorView, { state, now: FIXED_NOW, context: '张三喜欢什么' }),
  );
}

/** 渲染面板 1（就绪态）。 */
function renderOverview(stats: Parameters<typeof makeStats>[0] & object): string {
  return renderToStaticMarkup(
    createElement(OverviewView, { state: readyState(makeStats(stats)), now: FIXED_NOW }),
  );
}

/** 一个「一调用就抛」的假端口（SSR 里 `useEffect` 不跑 ⇒ 它不该被调用一次）。 */
function makeThrowingPort(): { port: ReadPort; calls: string[] } {
  const calls: string[] = [];
  const reject = (name: string) => (): Promise<never> => {
    calls.push(name);
    return Promise.reject(new Error(`假端口不该被调用：${name}`));
  };
  const port: ReadPort = {
    stats: reject('stats'),
    get: reject('get'),
    recall: reject('recall'),
    clusters: reject('clusters'),
    inhibitionTrace: reject('inhibitionTrace'),
    verifyIntegrity: reject('verifyIntegrity'),
    select: reject('select'),
    logs: reject('logs'),
  };
  return { port, calls };
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 面板 3：无 embedder 的诊断口径
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 面板 3：无 embedder 时必须显式标注「本次未执行向量路」', () => {
  it('★ 标注出现（后半句「不出现向量索引损坏」的判别力**不在**这里，见下）', () => {
    const html = renderRecall(readyState(makeRecallSimResult({ hasEmbedder: false })));
    expect(html).toContain('本次未执行向量路');
    // ⚠️ ★ **这半条本身不是守卫**（如实记）：同一文件的「渲染层没有『向量索引损坏』
    //   这句措辞」一节已断言该词在 `viewer/renderer/**` **源码里一次都不出现**
    //   ⇒ 渲染结果**永远**不可能含有它，这条 `not.toContain` 因此**恒真**。
    //   留着它只是因为「面板 3 的输出里没有这句话」读起来直观；
    //   **真正的守卫是那条源码扫描**（有人把这句写进面板时它会变红）。
    expect(html).not.toContain('向量索引损坏');
  });

  it('同时给出「未配置 embedder」的说明（不是二选一）', () => {
    const html = renderRecall(readyState(makeRecallSimResult({ hasEmbedder: false })));
    expect(html).toContain('embedder');
    expect(html).toContain('vectorPart');
  });

  it('配了 embedder 且向量路跑过 ⇒ 不出现「本次未执行向量路」（判别力）', () => {
    const html = renderRecall(
      readyState(makeRecallSimResult({ hasEmbedder: true, vectorRouteRan: true })),
    );
    expect(html).not.toContain('本次未执行向量路');
    expect(html).toContain('本次已执行向量路');
  });

  it('配了 embedder 但本次向量路没跑 ⇒ 照样标注「本次未执行向量路」', () => {
    const html = renderRecall(
      readyState(makeRecallSimResult({ hasEmbedder: true, vectorRouteRan: false })),
    );
    expect(html).toContain('本次未执行向量路');
  });
});

describe('T03 · 面板 3：无 embedder 时 `vectorPart` 恒为 0，且五柱之和 == score', () => {
  it('★ 五柱里 `vectorSim` 那一根的展示值是 `0.000`', () => {
    const hit = makeRecallHit('m-1', { breakdown: makeBreakdown({ vectorPart: 0 }) });
    const html = renderRecall(readyState(makeRecallSimResult({ hits: [hit] })));
    const rows = scoreBarRows(html);
    expect(rows.map(([factor]) => factor)).toEqual([
      'intensityPart',
      'vectorPart',
      'textPart',
      'graphPart',
      'recencyPart',
    ]);
    const vector = rows.find(([factor]) => factor === 'vectorPart');
    expect(vector?.[2]).toBe('0.000');
  });

  it('★ 五柱的**原始值之和** == `score`（误差 ≤ 1e-9）', () => {
    const breakdown = makeBreakdown({ vectorPart: 0 });
    const score = breakdownSum(breakdown);
    const hit = makeRecallHit('m-1', { breakdown, score });
    const html = renderRecall(readyState(makeRecallSimResult({ hits: [hit] })));
    const sum = scoreBarRows(html).reduce((total, [, value]) => total + value, 0);
    expect(Math.abs(sum - score)).toBeLessThanOrEqual(1e-9);
  });

  it('判别力：把 `vectorPart` 改成 0.25 ⇒ 渲染出 `0.250`（不是恒 0 的假断言）', () => {
    const hit = makeRecallHit('m-1', { breakdown: makeBreakdown({ vectorPart: 0.25 }) });
    const html = renderRecall(readyState(makeRecallSimResult({ hits: [hit] })));
    const vector = scoreBarRows(html).find(([factor]) => factor === 'vectorPart');
    expect(vector?.[2]).toBe('0.250');
  });
});

describe('T03 · 面板 3：被抑制条目单列一栏，不混进打分柱状图', () => {
  const result = makeRecallSimResult({
    hits: [makeRecallHit('m-1'), makeRecallHit('m-2')],
    suppressed: [
      makeSuppressed('m-3', { redundantWith: 'm-1', redundancySim: 0.93 }),
      makeSuppressed('m-4', { redundantWith: 'm-2', redundancySim: 0.88 }),
    ],
  });

  it('★ 柱状图容器里的 `data-memory-id` 集合 == hits 的 id 集合（**不含**被抑制项）', () => {
    const html = renderRecall(readyState(result));
    expect(scoreBarMemoryIds(html)).toEqual(['m-1', 'm-2']);
  });

  it('★ 被抑制栏里**恰好**包含全部被抑制的 id（不多不少）', () => {
    const html = renderRecall(readyState(result));
    const ids = [...html.matchAll(/data-suppressed-id="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(ids).toEqual(['m-3', 'm-4']);
  });

  it('被抑制栏四列齐全：id / 原始 score / redundantWith / redundancySim', () => {
    const html = renderRecall(readyState(result));
    expect(html).toContain('data-field="id"');
    expect(html).toContain('data-field="score"');
    expect(html).toContain('data-field="redundantWith"');
    expect(html).toContain('data-field="redundancySim"');
    expect(html).toContain('0.930');
    expect(html).toContain('0.880');
  });

  it('负控：「混进柱状图」这件事**能**被同一判据抓到', () => {
    // 手写一段「被抑制项也被画了柱」的 markup ⇒ 判据必须多出一个 id。
    const probe =
      '<section class="score-bars" data-chart="score-bars" data-memory-id="m-1"></section>' +
      '<section class="score-bars" data-chart="score-bars" data-memory-id="m-3"></section>';
    expect(scoreBarMemoryIds(probe)).toEqual(['m-1', 'm-3']);
  });
});

describe('T03 · 面板 3：`rawBm25` 与 `cos` 并列显示，`null` 显示为 `—` 而不是 `0`', () => {
  it('★ 两个标签都在场', () => {
    const html = renderRecall(readyState(makeRecallSimResult()));
    expect(html).toContain('rawBm25');
    expect(html).toContain('cos');
  });

  it('★ `cos === null` ⇒ `cos=—`（**不是** `cos=0`）', () => {
    const hit = makeRecallHit('m-1', { breakdown: makeBreakdown({ rawBm25: -3.5, cos: null }) });
    const html = renderRecall(readyState(makeRecallSimResult({ hits: [hit] })));
    expect(html).toContain('cos=—');
    expect(html).not.toContain('cos=0');
    expect(html).toContain('rawBm25=-3.5');
  });

  it('判别力：`cos = 0` 与 `cos = null` 渲染出的东西不同', () => {
    const zero = makeRecallHit('m-1', { breakdown: makeBreakdown({ cos: 0 }) });
    const nul = makeRecallHit('m-1', { breakdown: makeBreakdown({ cos: null }) });
    const htmlZero = renderRecall(readyState(makeRecallSimResult({ hits: [zero] })));
    const htmlNull = renderRecall(readyState(makeRecallSimResult({ hits: [nul] })));
    expect(htmlZero).toContain('cos=0');
    expect(htmlNull).toContain('cos=—');
    expect(htmlZero).not.toBe(htmlNull);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 面板 2：衰减曲线基于 effectiveStability
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 面板 2：衰减曲线的 τ 取 `effectiveStability`（含 `pin_factor`）', () => {
  it('★ 注入 `stability=10, pinFactor=2.5` ⇒ `data-tau-days == 25`', () => {
    const detail = makeMemoryDetail();
    const html = renderMemoryList(readyState(detail));
    expect(html).toContain('data-tau-days="25"');
  });

  it('★ 并且它**不等于** `stability`（这条是判别力：用错字段的实现会渲染 10）', () => {
    const detail = makeMemoryDetail();
    const html = renderMemoryList(readyState(detail));
    expect(html).not.toContain('data-tau-days="10"');
    expect(detail.view.stability).toBe(10);
    expect(detail.view.effectiveStability).toBe(25);
  });

  it('★ 能看出「跌出 L3」与「跌入归档」的剩余时间', () => {
    const html = renderMemoryList(readyState(makeMemoryDetail()));
    expect(html).toContain('距跌出 L3 还有');
    expect(html).toContain('距跌入归档还有');
  });

  it('已跌出 L3（`dropOutL3At === null`）⇒ 显示「已跌出 L3」而不是一个负数时长', () => {
    const html = renderMemoryList(readyState(makeMemoryDetail({ dropOutL3At: null })));
    expect(html).toContain('已跌出 L3');
    expect(html).not.toContain('距跌出 L3 还有');
  });

  it('`pinFactor = 1` 时 τ 与 stability 相等（证明差值来自 pin_factor，不是写死的 2.5 倍）', () => {
    const detail = makeMemoryDetail();
    const unpinned = {
      ...detail,
      view: { ...detail.view, pinFactor: 1, effectiveStability: 10 },
    };
    const html = renderMemoryList(readyState(unpinned));
    expect(html).toContain('data-tau-days="10"');
  });
});

describe('T03 · 面板 2：`get()` 返回 `null` 时有独立空态（与「查询错了」分开）', () => {
  it('★ 就绪但为空 ⇒ 显示「库里没有这条记忆」+ id', () => {
    const html = renderMemoryList(readyState(null), 'm-404');
    expect(html).toContain('库里没有这条记忆');
    expect(html).toContain('m-404');
    expect(html).toContain('data-state="missing"');
  });

  it('判别力：这条空态**不是**错误态（不含错误码区块）', () => {
    const html = renderMemoryList(readyState(null), 'm-404');
    expect(html).not.toContain('data-status="error"');
    expect(html).not.toContain('库调用失败');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 错误呈现：错误码 + details（**不是**一句「加载失败」）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 错误呈现：面板显示错误码 + `details`', () => {
  /** 一个带可识别 `details` 的线上错误。 */
  const wireError: WorkspaceError = asWorkspaceError(
    new MemoryError('NOT_FOUND', '库里没有这条记忆', {
      query: 'contentHistoryPage',
      memoryId: 'm-404',
    }),
  );

  it('前置：`MemoryError` 的 `code` / `details` 真的活到了线上形态（否则下面几条无意义）', () => {
    expect(wireError.code).toBe('NOT_FOUND');
    expect(wireError.details).toEqual({ query: 'contentHistoryPage', memoryId: 'm-404' });
  });

  it('★ 面板 2 的错误态：错误码 + details，且**不含**「加载失败」', () => {
    const html = renderMemoryList({ status: 'error', error: wireError });
    expect(html).toContain('NOT_FOUND');
    expect(html).toContain('contentHistoryPage');
    expect(html).toContain('m-404');
    expect(html).not.toContain('加载失败');
  });

  it('★ 面板 3 的错误态：同样给错误码 + details', () => {
    const html = renderRecall({ status: 'error', error: wireError });
    expect(html).toContain('NOT_FOUND');
    expect(html).toContain('contentHistoryPage');
    expect(html).not.toContain('加载失败');
  });

  it('换一个错误码 ⇒ 渲染出的码跟着变（不是写死的 `NOT_FOUND`）', () => {
    const html = renderMemoryList(
      errorState(makeMemoryError('DATABASE_BUSY', { reason: 'worker_timeout' })),
    );
    expect(html).toContain('DATABASE_BUSY');
    expect(html).toContain('worker_timeout');
    expect(html).not.toContain('NOT_FOUND');
  });

  it('错误码同时挂在 `data-error-code` 上（排障可机器读）', () => {
    const html = renderMemoryList(errorState(makeMemoryError()));
    expect(html).toContain('data-error-code="NOT_FOUND"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 无写入口：三层钉
// ═══════════════════════════════════════════════════════════════════════════

/** 从 markup 里抽出所有 `<button>` 的可见文案。 */
function buttonLabels(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)) {
    out.push((match[1] ?? '').replace(/<[^>]*>/g, '').trim());
  }
  return out;
}

/** 某个文案集合是否全部 ⊆ 白名单。 */
function allAllowed(labels: readonly string[], whitelist: readonly string[]): boolean {
  return labels.every((label) => whitelist.includes(label));
}

describe('T03 · 面板无任何写入口（三层钉）', () => {
  /** ★ 白名单的**测试侧副本**（不从 `texts.ts` import ⇒ 加白名单条目也要走审查）。 */
  const WHITELIST = ['上一页', '下一页', '模拟召回', '刷新快照', '加载更早的版本', '对比上次'];

  it('① `WRITE_CHANNELS` 是空数组且长度断言（通道层）', () => {
    expect(WRITE_CHANNELS).toEqual([]);
    expect(WRITE_CHANNELS.length).toBe(0);
  });

  it('② 渲染标记里的 `<button>` 文案 ⊆ 白名单（渲染层）', () => {
    const htmls = [
      renderMemoryList(readyState(makeMemoryDetail())),
      renderRecall(readyState(makeRecallSimResult())),
    ];
    const labels = htmls.flatMap((html) => buttonLabels(html));
    // ⚠️ 分母：面板 3 有「模拟召回」一个按钮 ⇒ 这条不是「空集合恒绿」
    expect(labels.length).toBeGreaterThanOrEqual(1);
    expect(allAllowed(labels, WHITELIST)).toBe(true);
  });

  it('②负控：`<button>回滚</button>` 会被同一判据拦下', () => {
    const probe = '<div><button type="button">回滚</button></div>';
    expect(allAllowed(buttonLabels(probe), WHITELIST)).toBe(false);
    expect(buttonLabels(probe)).toEqual(['回滚']);
  });

  it('②白名单里**没有**任何写动作字样（回滚 / 恢复 / 删除 / 加固 / 采纳）', () => {
    for (const forbidden of ['回滚', '恢复', '删除', '加固', '采纳', '遗忘', '置顶']) {
      expect(WHITELIST).not.toContain(forbidden);
    }
  });

  it('③ 源码扫描：16 个写方法名在 `viewer/renderer/**` 里一个都不出现（源码层）', () => {
    const files = listSourceFiles('viewer/renderer');
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(filesCallingWriteMethods('viewer/renderer')).toEqual({});
  });

  it('③负控：写方法扫描能在**故意写坏**的源码上命中（且不误伤 `pinFactor` / `fromText`）', () => {
    expect(findWriteMethodCalls('await port.link(a, b); db.restore(id);')).toEqual([
      'link',
      'restore',
    ]);
    expect(findWriteMethodCalls('const tau = view.stability * view.pinFactor;')).toEqual([]);
    expect(findWriteMethodCalls('const t = hit.fromText; const w = view.write;')).toEqual([]);
    expect(findWriteMethodCalls('store.updateContent(id, text);')).toEqual(['updateContent']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 七个面板共用同一套状态组件
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **七个面板文件的写死清单**（设计 §7.2 的七个编号）。
 *
 * ⚠️ 为什么要写死而不是「`panels/*.tsx` 全都要满足」：
 *   `panels/` 下还有一个**子组件** `ClusterBubble.tsx`（气泡本体，不是面板），
 *   它没有自己的取数，自然不 import 那个 hook。
 *   ⇒ 判据必须区分「面板」与「面板里的部件」，而**唯一可靠的区分方式是把七个面板写死**。
 *   ⚠️ T03 时后四个还不存在 ⇒ 断言写成「存在的那几个必须满足」，
 *     并在 T04 的测试里补一条「七个全都存在」。
 */
const EXPECTED_PANEL_FILES = [
  'viewer/renderer/panels/Overview.tsx',
  'viewer/renderer/panels/MemoryList.tsx',
  'viewer/renderer/panels/RecallSimulator.tsx',
  'viewer/renderer/panels/GraphView.tsx',
  'viewer/renderer/panels/LogViewer.tsx',
  'viewer/renderer/panels/VersionHistory.tsx',
  'viewer/renderer/panels/ClusterMap.tsx',
] as const;

/** `panels/` 下**允许存在**的非面板文件（面板里的部件）。 */
const PANEL_PARTS = ['viewer/renderer/panels/ClusterBubble.tsx'] as const;

/** 当前仓库里**已存在**的面板文件（T03 时是前三个）。 */
function existingPanelFiles(): string[] {
  const all = new Set(listSourceFiles('viewer/renderer/panels'));
  return EXPECTED_PANEL_FILES.filter((file) => all.has(file));
}

describe('T03 · 面板共用同一套状态组件（不各写一套）', () => {
  it('★ `panels/` 下的文件只有「七个面板 + 已登记部件」这几类（没有第 9 个来路不明的文件）', () => {
    const all = listSourceFiles('viewer/renderer/panels');
    expect(all.length).toBeGreaterThanOrEqual(3);
    const known = new Set<string>([...EXPECTED_PANEL_FILES, ...PANEL_PARTS]);
    const unknown = all.filter((file) => !known.has(file));
    expect(unknown).toEqual([]);
  });

  it('★ 每个已存在的面板文件里 `catch (` 出现次数为 0（错误只在 `state/` 里处理）', () => {
    const panels = existingPanelFiles();
    expect(panels.length).toBeGreaterThanOrEqual(3);
    for (const file of panels) {
      expect(/catch\s*\(/.test(readCode(file)), `${file} 里出现了 catch (`).toBe(false);
    }
  });

  it('★ 每个已存在的面板文件都 import `useReadCall` 与 `StatusBlock`', () => {
    const panels = existingPanelFiles();
    expect(panels.length).toBeGreaterThanOrEqual(3);
    for (const file of panels) {
      const code = readCode(file);
      expect(code, `${file} 没有 import useReadCall`).toContain('state/useReadCall.js');
      expect(code, `${file} 没有 import StatusBlock`).toContain('state/StatusBlock.js');
    }
  });

  it('★ 加载中与错误态的**实现**只在 `state/StatusBlock.tsx` 一处（面板里没有各自的措辞）', () => {
    const files = listSourceFiles('viewer/renderer');
    const panels = files.filter((file) => file.startsWith('viewer/renderer/panels/'));
    expect(panels.length).toBeGreaterThanOrEqual(3);
    // 「计算中」与错误标题这类**措辞**不许出现在面板里（它们属于共用状态层）
    for (const file of panels) {
      const code = readCode(file);
      expect(code, `${file} 自己写了加载文案`).not.toContain('计算中');
      expect(code, `${file} 自己写了错误标题`).not.toContain('库调用失败');
    }
  });

  it('就绪态不出现「计算中」，加载态只出现「计算中」（判别力）', () => {
    const loadingHtml = renderMemoryList({ status: 'loading' });
    expect(loadingHtml).toContain('计算中');
    expect(loadingHtml).toContain('data-status="loading"');
    const readyHtml = renderMemoryList(readyState(makeMemoryDetail()));
    expect(readyHtml).not.toContain('计算中');
    expect(readyHtml).not.toContain('data-status="loading"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④bis T03 断言补强：让「不咬人」的断言真的能变红
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 补强 · 面板 2 的 τ：**不一致**夹具才能区分「读字段」与「自己算」', () => {
  /**
   * ⚠️ ★ 为什么必须造「不一致」夹具：
   *   原夹具里 `effectiveStability` **恒等于** `stability × pinFactor`（25 = 10 × 2.5）
   *   ⇒ 把实现从「读 `view.effectiveStability`」改成「自己算 `stability * pinFactor`」，
   *     原来的三条断言**全绿**。`src/core/scoring.ts` 确认两者当前代数相等，
   *     所以这是**未来漂移**风险：哪天上游给「有效 τ」再加一个系数，渲染层会悄悄显示错值。
   *   ⇒ 造一个 `30 ≠ 10 × 2.5 = 25` 的夹具：读到 30 才算真读了字段。
   */
  it('★ `stability=10, pinFactor=2.5, effectiveStability=30` ⇒ `data-tau-days="30"`（不是 25）', () => {
    const base = makeMemoryDetail();
    const detail = {
      ...base,
      view: { ...base.view, stability: 10, pinFactor: 2.5, effectiveStability: 30 },
    };
    const html = renderMemoryList(readyState(detail));
    expect(html).toContain('data-tau-days="30"');
    // 判别力：自己算 `stability × pinFactor` 的实现会渲染 25
    expect(html).not.toContain('data-tau-days="25"');
  });

  it('★ 另一方向：`effectiveStability=7.5` < `stability × pinFactor` 也要如实显示', () => {
    const base = makeMemoryDetail();
    const detail = {
      ...base,
      view: { ...base.view, stability: 10, pinFactor: 2.5, effectiveStability: 7.5 },
    };
    const html = renderMemoryList(readyState(detail));
    expect(html).toContain('data-tau-days="7.5"');
    expect(html).not.toContain('data-tau-days="25"');
  });

  it('★ 源码层：renderer **不做时间计算** —— 不出现 `pinFactor` 这个标识符', () => {
    const files = listSourceFiles('viewer/renderer');
    expect(files.length).toBeGreaterThanOrEqual(16);
    // 摘掉注释后扫（注释里解释「pin_factor 在分母内」是允许的，代码里算它不允许）
    const offenders = files.filter((file) => readCode(file).includes('pinFactor'));
    expect(offenders).toEqual([]);
    // 负控：同一判据能在「自己算」的写法上命中
    expect('const tau = view.stability * view.pinFactor;'.includes('pinFactor')).toBe(true);
  });
});

describe('T03 补强 · ① `embeddedRatio` 的标签与数值**绑在一起**（两条独立 toContain 会脱钩）', () => {
  it('★ `data-embedded-ratio-text` 的**取值**就是 `43.1%`', () => {
    const html = renderOverview(makeStats({ embeddedRatio: 0.4312 }));
    expect(html).toContain('data-embedded-ratio-text="">43.1%</p>');
  });

  it('判别力：换比例 ⇒ 该属性的取值跟着变（不是别处的 43.1% 满足了断言）', () => {
    const html = renderOverview(makeStats({ embeddedRatio: 0.0875 }));
    expect(html).toContain('data-embedded-ratio-text="">8.8%</p>');
    expect(html).not.toContain('data-embedded-ratio-text="">43.1%</p>');
  });
});

describe('T03 补强 · ⑨(a) 七个面板的 `<button>` 文案一次性收齐并 ⊆ 白名单', () => {
  /** ★ 白名单的测试侧副本（不从 `texts.ts` import）。 */
  const WHITELIST = ['上一页', '下一页', '模拟召回', '刷新快照', '加载更早的版本', '对比上次'];

  /** 把七个面板各渲一遍（都喂就绪态），返回全部 markup。 */
  function renderAllSevenPanels(): string[] {
    return [
      renderToStaticMarkup(
        createElement(OverviewView, { state: readyState(makeStats()), now: FIXED_NOW }),
      ),
      renderMemoryList(readyState(makeMemoryDetail())),
      renderRecall(readyState(makeRecallSimResult())),
      renderToStaticMarkup(
        createElement(GraphViewView, {
          state: readyState([makeGraphRow(1, '张三', '养', '猫')]),
          now: FIXED_NOW,
        }),
      ),
      renderToStaticMarkup(
        createElement(LogViewerView, {
          state: readyState(makeLogPage()),
          query: { year: 2024, month: 1 },
          now: FIXED_NOW,
        }),
      ),
      // 面板 6：`loaded < total` ⇒ 「加载更早的版本」也在场（三个按钮都要被检查到）
      renderToStaticMarkup(
        createElement(VersionHistoryView, {
          state: readyState({
            rows: [makeHistoryRow('h-1', 'x', 'merge', FIXED_NOW)],
            total: 137,
            page: 0,
          }),
          current: makeMemoryDetail().view,
          now: FIXED_NOW,
        }),
      ),
      renderToStaticMarkup(
        createElement(ClusterMapView, {
          state: readyState(makeClustersResult()),
          previous: makeClustersResult(),
          now: FIXED_NOW,
        }),
      ),
    ];
  }

  it('★ 收齐后**每条**文案都在白名单里（含面板 5 的上/下页这 2 个按钮）', () => {
    const htmls = renderAllSevenPanels();
    expect(htmls.length).toBe(7);
    const labels = htmls.flatMap((html) => buttonLabels(html));

    // ⚠️ 分母：面板 3 有 1 个、面板 5 有 2 个、面板 6 有 3 个、面板 7 有 1 个 ⇒ 至少 7 条
    expect(labels.length).toBeGreaterThanOrEqual(7);
    // 面板 5 的那两个按钮必须真的被收进来（这正是原先漏掉的那一处）
    expect(labels).toContain('上一页');
    expect(labels).toContain('下一页');

    for (const label of labels) {
      expect(WHITELIST, `面板里出现了白名单外的按钮文案：${label}`).toContain(label);
    }
  });

  it('★ 这个 helper **真的能看见**面板 5 的按钮（否则上面的「收齐」是空转）', () => {
    const logHtml = renderToStaticMarkup(
      createElement(LogViewerView, {
        state: readyState(makeLogPage()),
        query: { year: 2024, month: 1 },
        now: FIXED_NOW,
      }),
    );
    expect(buttonLabels(logHtml)).toEqual(['上一页', '下一页']);
  });

  it('负控：混进一个「回滚」按钮 ⇒ 同一判据立刻红', () => {
    const polluted = renderToStaticMarkup(
      createElement(LogViewerView, {
        state: readyState(makeLogPage()),
        query: { year: 2024, month: 1 },
        now: FIXED_NOW,
      }),
    ).replace('</button>', '</button><button type="button">回滚</button>');
    const labels = buttonLabels(polluted);
    expect(labels).toContain('回滚');
    expect(labels.every((label) => WHITELIST.includes(label))).toBe(false);
  });
});

describe('T03 补强 · ⑨(b) 面板侧的 `reinforce: false`（原先只有 IPC 层断言）', () => {
  it('★ 面板发起召回时传给 `port.recall` 的 input 里 `reinforce === false`（且键存在）', async () => {
    const captured: unknown[] = [];
    const port = {
      stats: () => Promise.reject(new Error('不该调用')),
      get: () => Promise.reject(new Error('不该调用')),
      recall: (input: unknown) => {
        captured.push(input);
        return Promise.resolve(makeRecallSimResult());
      },
      clusters: () => Promise.reject(new Error('不该调用')),
      inhibitionTrace: () => Promise.reject(new Error('不该调用')),
      verifyIntegrity: () => Promise.reject(new Error('不该调用')),
      select: () => Promise.reject(new Error('不该调用')),
      logs: () => Promise.reject(new Error('不该调用')),
    } as unknown as ReadPort;

    await loadRecallSim(port, '张三喜欢什么');

    expect(captured.length).toBe(1);
    const input = captured[0] as { context?: unknown; reinforce?: unknown };
    expect(input.context).toBe('张三喜欢什么');
    // ★ 三条一起断：「键存在」+「值是 false」+「不是靠缺省糊过去」
    expect(Object.hasOwn(input, 'reinforce')).toBe(true);
    expect(input.reinforce).toBe(false);
    expect(input.reinforce).not.toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ter T04 补强 · 每个面板都**真的**过同一套状态组件（含加载态）
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 补强 · ⑥ 七个面板各自的**加载态**都由同一个 `StatusBlock` 画出', () => {
  /** `{status:'loading'}`：面板拿不到数据时唯一该走的分支。 */
  const LOADING = { status: 'loading' as const };

  /** 把七个面板各渲一遍（喂 `loading`），返回 `面板名 → markup`。 */
  function renderLoadingPanels(): ReadonlyArray<readonly [string, string]> {
    return [
      [
        'overview',
        renderToStaticMarkup(createElement(OverviewView, { state: LOADING, now: FIXED_NOW })),
      ],
      [
        'memoryList',
        renderToStaticMarkup(
          createElement(MemoryListView, { state: LOADING, now: FIXED_NOW, memoryId: 'm-1' }),
        ),
      ],
      [
        'recallSimulator',
        renderToStaticMarkup(
          createElement(RecallSimulatorView, { state: LOADING, now: FIXED_NOW, context: 'x' }),
        ),
      ],
      [
        'graphView',
        renderToStaticMarkup(createElement(GraphViewView, { state: LOADING, now: FIXED_NOW })),
      ],
      [
        'logViewer',
        renderToStaticMarkup(
          createElement(LogViewerView, {
            state: LOADING,
            query: { year: 2024, month: 1 },
            now: FIXED_NOW,
          }),
        ),
      ],
      [
        'versionHistory',
        renderToStaticMarkup(
          createElement(VersionHistoryView, { state: LOADING, current: null, now: FIXED_NOW }),
        ),
      ],
      [
        'clusterMap',
        renderToStaticMarkup(
          createElement(ClusterMapView, { state: LOADING, previous: null, now: FIXED_NOW }),
        ),
      ],
    ];
  }

  it('★ 七个面板在加载态下都渲染 `data-status="loading"` 与「计算中」', () => {
    const panels = renderLoadingPanels();
    // ⚠️ 分母：必须真的是七个（少一个就不是「七个面板共用一套」）
    expect(panels.length).toBe(7);
    for (const [name, html] of panels) {
      expect(html, `${name} 没有加载态`).toContain('data-status="loading"');
      expect(html, `${name} 没有「计算中」`).toContain('计算中');
      // 加载态不该顺带画出「库调用失败」的错误块
      expect(html, `${name} 的加载态里混进了错误块`).not.toContain('data-status="error"');
    }
  });

  it('★ 判别力：就绪态里**没有** `data-status="loading"`（否则上面那条对任何状态都成立）', () => {
    const ready = renderToStaticMarkup(
      createElement(ClusterMapView, {
        state: readyState(makeClustersResult()),
        previous: null,
        now: FIXED_NOW,
      }),
    );
    expect(ready).not.toContain('data-status="loading"');
    expect(ready).not.toContain('计算中');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤bis 交互层（T04 补遗）：按钮在场 ≠ 按钮有用
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ 为什么需要这一节：`renderToStaticMarkup` **不序列化事件处理器**，
 *   所以「按钮在场」的断言**证明不了**它能用 —— 上一轮正是这样漏掉的
 *   （`LogViewer` 渲染了上一页/下一页却没有 `onClick`）。
 *   ⇒ 判据换成**源码扫描**：带交互的面板里必须出现 `useState` 与 `onClick`/`onChange`，
 *     且页码 / 查询 / 累积必须走 `state/navigation.ts` 的纯函数（那些函数有逐值单测）。
 */
describe('T04 补遗 · 交互层：handler 真的接上了（源码层判据）', () => {
  /** 三个需要交互的面板（面板 1~4 是纯展示/导航由 `App` 的 props 驱动，不需要本地 state）。 */
  const INTERACTIVE_PANELS = [
    'viewer/renderer/panels/RecallSimulator.tsx',
    'viewer/renderer/panels/LogViewer.tsx',
    'viewer/renderer/panels/VersionHistory.tsx',
    'viewer/renderer/panels/ClusterMap.tsx',
  ];

  it('★ 每个带交互的面板源码里都出现 `useState` 与 `onClick=`/`onChange=`', () => {
    expect(INTERACTIVE_PANELS.length).toBe(4);
    for (const file of INTERACTIVE_PANELS) {
      const code = readCode(file);
      expect(code, `${file} 没有 useState`).toContain('useState');
      expect(/onClick=|onChange=/.test(code), `${file} 一个 handler 都没有`).toBe(true);
    }
  });

  it('★ 反例（判别力）：纯展示面板的源码**不该**出现 handler（否则上面的判据是恒绿）', () => {
    const code = readCode('viewer/renderer/panels/Overview.tsx');
    expect(/onClick=|onChange=/.test(code)).toBe(false);
    expect(code).not.toContain('useState');
  });

  it('★ 面板 5 的页码 / 查询**不许自己写**：必须调用 navigation 的纯函数', () => {
    const code = readCode('viewer/renderer/panels/LogViewer.tsx');
    expect(code).toContain('buildLogQuery');
    expect(code).toMatch(/nextPage\(/);
    expect(code).toMatch(/prevPage\(/);
    // 反例：组件里不许出现 `page + 1` / `page - 1` 这类自写夹紧
    expect(/page\s*[+-]\s*1/.test(code)).toBe(false);
  });

  it('★ 面板 6 的累积加载走 `appendPage`（不在组件里拼数组）', () => {
    const code = readCode('viewer/renderer/panels/VersionHistory.tsx');
    expect(code).toMatch(/appendPage\(/);
    expect(code).toContain('nextPage');
    expect(code).toContain('prevPage');
  });

  it('★ 面板 7 的重叠度来自 navigation（唯一实现），组件里没有第二份', () => {
    const code = readCode('viewer/renderer/panels/ClusterMap.tsx');
    expect(code).toContain('overlapRatio');
    // 反例：「就地算重叠度」会留下这个除法痕迹
    expect(code).not.toContain('/ Math.min(');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ App：只读徽标常驻 + 导航是 `PANEL_ORDER` 的前缀
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · App：只读徽标常驻、导航标题来自唯一一份 `PANEL_TITLES`', () => {
  it('★ 顶栏常驻「只读观察器」徽标', () => {
    const { port } = makeThrowingPort();
    const html = renderToStaticMarkup(createElement(App, { port, now: FIXED_NOW }));
    expect(html).toContain('只读观察器');
    expect(html).toContain('data-badge="readonly"');
  });

  it('★ 已接线的面板是 `PANEL_ORDER` 的**前缀**（不能跳着接）', () => {
    expect(WIRED_PANELS).toEqual(PANEL_ORDER.slice(0, WIRED_PANELS.length));
    expect(WIRED_PANELS.length).toBeGreaterThanOrEqual(3);
  });

  it('导航标题逐条等于 `PANEL_TITLES`（七个标题只此一份）', () => {
    const { port } = makeThrowingPort();
    const html = renderToStaticMarkup(createElement(App, { port, now: FIXED_NOW }));
    for (const panelId of WIRED_PANELS) {
      expect(html).toContain(PANEL_TITLES[panelId]);
      expect(html).toContain(`data-panel-id="${panelId}"`);
    }
  });

  it('SSR 期间不调任何端口方法（`useEffect` 不跑 ⇒ 端口一次都没被碰）', () => {
    const { port, calls } = makeThrowingPort();
    renderToStaticMarkup(createElement(App, { port, now: FIXED_NOW }));
    expect(calls).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ T04 第四批 · 可用性：面板 3 真的能跑一次召回、七个面板真的都能打开
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 第四批 · 面板 3 真的能跑一次召回（不再是「海报」）', () => {
  it('★ 源码层：`useState` + `onChange=` + `onClick=` 三者都在', () => {
    const code = readCode('viewer/renderer/panels/RecallSimulator.tsx');
    expect(code).toContain('useState');
    expect(/onChange=/.test(code), '输入框没有 onChange').toBe(true);
    expect(/onClick=/.test(code), '「模拟召回」没有 onClick').toBe(true);
  });

  it('★ 空态（还没提交）：有输入框与「模拟召回」，但**不画状态块、不画结果**', () => {
    // ⚠️ 这条是「不发请求」的可断言形式：空态若拿 `loading` 冒充，就会渲染出 `data-status="loading"`。
    const html = renderToStaticMarkup(
      createElement(RecallSimulatorView, {
        state: { status: 'loading' },
        now: FIXED_NOW,
        context: '',
        idle: true,
      }),
    );
    expect(html).toContain('data-recall-idle="true"');
    expect(html).toContain('data-field="context-input"');
    expect(html).toContain('模拟召回');
    expect(html).toContain('reinforce 恒为 false');
    expect(html).not.toContain('data-status="loading"');
    expect(html).not.toContain('data-suppressed-count');
  });

  it('反例：非空态才画被抑制栏与结果（否则上一条的 `not.toContain` 是恒真）', () => {
    const html = renderRecall(readyState(makeRecallSimResult()));
    expect(html).toContain('data-recall-idle="false"');
    expect(html).toContain('data-suppressed-count');
  });

  it('★ 输入框是**受控**的：渲染出的文本就是传进来的 `context`', () => {
    const html = renderToStaticMarkup(
      createElement(RecallSimulatorView, {
        state: { status: 'loading' },
        now: FIXED_NOW,
        context: '张三喜欢什么',
        idle: true,
      }),
    );
    expect(html).toContain('张三喜欢什么');
    expect(html).toContain('data-field="context-input"');
  });

  it('★ 把面板切到面板 3 且文本为空时是**空态**（不会拿空串去查一次）', () => {
    const { port } = makeThrowingPort();
    const html = renderToStaticMarkup(
      createElement(App, {
        port,
        now: FIXED_NOW,
        selection: { ...DEFAULT_SELECTION, panel: 'recallSimulator' },
      }),
    );
    expect(html).toContain('data-recall-idle="true"');
    expect(html).not.toContain('data-status="loading"');
  });
});

describe('T04 第四批 · 七个面板都能从导航打开', () => {
  it('★ 导航里恰好 `PANEL_ORDER.length` 个**可点**元素，且顺序逐条相同', () => {
    const { port } = makeThrowingPort();
    const html = renderToStaticMarkup(createElement(App, { port, now: FIXED_NOW }));

    const navIds = [...html.matchAll(/data-nav-panel="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(navIds).toEqual([...PANEL_ORDER]);
    expect(navIds.length).toBe(7);

    // ★「可点」的判据：每个 nav 元素都是 `<button>`（改之前是 `<span>` ⇒ 一个也点不了）
    const buttons = [...html.matchAll(/<button[^>]*data-nav-panel="[^"]+"/g)];
    expect(buttons.length).toBe(PANEL_ORDER.length);
  });

  it('★ 七块**各自都真的渲染出来**（逐块把 selection 指过去，面板体必须在场）', () => {
    const { port } = makeThrowingPort();
    for (const panelId of PANEL_ORDER) {
      const html = renderToStaticMarkup(
        createElement(App, {
          port,
          now: FIXED_NOW,
          selection: { ...DEFAULT_SELECTION, panel: panelId, memoryId: 'm-1' },
        }),
      );
      expect(html, `${panelId} 没有切换过去`).toContain(`data-selected-panel="${panelId}"`);
      // 面板体在场：加载态下是 `data-panel="<标题>"`，空态/就绪态下是 `data-panel-body="<id>"`
      const rendered =
        html.includes(`data-panel="${PANEL_TITLES[panelId]}"`) ||
        html.includes(`data-panel-body="${panelId}"`);
      expect(rendered, `${panelId} 的面板体没有被渲染`).toBe(true);
    }
  });

  it('★ 源码层：nav 不再是不可点的 `<span>`，且由 `useState` 驱动', () => {
    const code = readCode('viewer/renderer/App.tsx');
    expect(code).toContain('useState');
    expect(/onClick=/.test(code), 'nav 没有 onClick').toBe(true);
    expect(code).toContain('data-nav-panel');
    // 反例：本文件里不该再出现「nav-item 的 span」
    expect(/<span[^>]*app__nav-item/.test(code)).toBe(false);
  });

  it('★ 导航文案里没有任何写动作字样（回滚 / 删除 / 遗忘 / 恢复 / 加固）', () => {
    const { port } = makeThrowingPort();
    const html = renderToStaticMarkup(createElement(App, { port, now: FIXED_NOW }));
    for (const forbidden of ['回滚', '删除', '遗忘', '恢复', '加固']) {
      expect(html, `界面上出现了写动作字样：${forbidden}`).not.toContain(forbidden);
    }
  });

  it('★ 七个 nav 的文案逐条等于 `PANEL_TITLES`（不是另写一套短名）', () => {
    const { port } = makeThrowingPort();
    const html = renderToStaticMarkup(createElement(App, { port, now: FIXED_NOW }));
    for (const panelId of PANEL_ORDER) {
      expect(html).toContain(`>${PANEL_TITLES[panelId]}</button>`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑧ T04 第四批(补) · 面板 3 的「接线」证据：点一次 ⇒ 假端口收到的 context 就是输入框的值
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 第四批(补) · 面板 3：提交语义是纯函数，接线可被直接跑一次', () => {
  it('★ `nextSubmitted`：空白输入**不提交**（保持原值）', () => {
    expect(nextSubmitted(null, '')).toBeNull();
    expect(nextSubmitted(null, '   ')).toBeNull();
    // 已有值也不会被空白清掉
    expect(nextSubmitted('旧文本', '  ')).toBe('旧文本');
  });

  it('★ `nextSubmitted`：非空输入**原样提交**（不 trim，交给库侧归一）', () => {
    expect(nextSubmitted(null, '张三喜欢什么')).toBe('张三喜欢什么');
    expect(nextSubmitted('旧文本', '新文本')).toBe('新文本');
  });

  it('★★ 接线证据：`recallRunner(输入框的值)` 交给假端口 ⇒ 收到的 `context` 就是那一份', () => {
    // ⚠️ 这条才是「接上了」的证据。只断 `reinforce === false` 证明不了接线
    //   （那个常量跟输入框无关）。
    const captured: Array<{ context?: unknown; reinforce?: unknown }> = [];
    const port = {
      recall: (input: unknown) => {
        captured.push(input as { context?: unknown; reinforce?: unknown });
        return Promise.resolve(makeRecallSimResult());
      },
    } as unknown as ReadPort;

    // 用的是 `RecallSimulator` 交给 `useReadCall` 的**同一个** runner
    const run = recallRunner('张三喜欢什么');

    return run(port).then(() => {
      expect(captured.length).toBe(1);
      expect(captured[0]?.context).toBe('张三喜欢什么');
      expect(captured[0]?.reinforce).toBe(false);
    });
  });

  it('★ 换一份输入 ⇒ 送出去的也跟着换（不是写死的一句）', async () => {
    const captured: unknown[] = [];
    const port = {
      recall: (input: unknown) => {
        captured.push(input);
        return Promise.resolve(makeRecallSimResult());
      },
    } as unknown as ReadPort;

    await recallRunner('第二次的文本')(port);
    expect((captured[0] as { context?: unknown }).context).toBe('第二次的文本');
  });
});

describe('T04 第四批(补) · 面板 3：空输入时按钮 disabled（不是「点了没反应」）', () => {
  /** 渲染空态面板 3。 */
  function renderIdle(context: string): string {
    return renderToStaticMarkup(
      createElement(RecallSimulatorView, {
        state: { status: 'loading' },
        now: FIXED_NOW,
        context,
        idle: true,
      }),
    );
  }

  it('★ 空输入 ⇒ `data-action="run-recall"` 按钮带 `disabled`', () => {
    expect(renderIdle('')).toMatch(/data-action="run-recall"[^>]*disabled/);
  });

  it('★ 只有空白 ⇒ 仍然 disabled（不是「非空字符就算」）', () => {
    expect(renderIdle('   ')).toMatch(/data-action="run-recall"[^>]*disabled/);
  });

  it('反例：有内容 ⇒ **不** disabled（否则上面两条对任何输入都成立）', () => {
    expect(renderIdle('张三喜欢什么')).not.toMatch(/data-action="run-recall"[^>]*disabled/);
  });
});

describe('T04 第四批(补) · 导航：给定 activePanel 时**只渲染那一块**', () => {
  it('★ 七块逐一验证：main 里恰好一个面板体（不多渲）', () => {
    const { port } = makeThrowingPort();
    for (const panelId of PANEL_ORDER) {
      const html = renderToStaticMarkup(
        createElement(App, {
          port,
          now: FIXED_NOW,
          selection: { ...DEFAULT_SELECTION, panel: panelId, memoryId: 'm-1' },
        }),
      );
      // 面板体只有两种形态：loading/error 的 `data-panel="<标题>"`、空态/就绪态的 `data-panel-body="<id>"`
      const bodies =
        (html.match(/data-panel-body="/g) ?? []).length +
        (html.match(/data-panel="/g) ?? []).length;
      expect(bodies, `${panelId} 渲染出的面板体数量不是 1`).toBe(1);
    }
  });
});

describe('T04 第四批(补) · 面板 3：空输入**一次都不发请求**（可断言的推导）', () => {
  it('★ `shouldRunRecall(null)` false、`shouldRunRecall("")` false ⇒ 容器不会调端口', () => {
    expect(shouldRunRecall(null)).toBe(false);
    expect(shouldRunRecall('')).toBe(false);
    expect(shouldRunRecall('   ')).toBe(false);
  });

  it('反例：有内容才允许发（否则上面三条是恒绿）', () => {
    expect(shouldRunRecall('张三喜欢什么')).toBe(true);
  });

  it('★ 串联：空输入点提交 ⇒ `submitted` 仍是 null ⇒ 仍然不发', () => {
    const afterClick = nextSubmitted(null, '   ');
    expect(afterClick).toBeNull();
    expect(shouldRunRecall(afterClick)).toBe(false);
  });

  it('★ 串联：有输入点提交 ⇒ `submitted` 是那份文本 ⇒ 允许发', () => {
    const afterClick = nextSubmitted(null, '张三喜欢什么');
    expect(afterClick).toBe('张三喜欢什么');
    expect(shouldRunRecall(afterClick)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑨ T04 最终 · `nextSubmitted` 的**提交语义**（每条配反例）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ ★ **这一节承载的是「提交语义」这一段的判别力，不是端到端点击**：
 *   `environment: 'node'` + `renderToStaticMarkup` **不执行事件处理器**
 *   （不装 jsdom 是 better-sqlite3 `pool: 'forks'` 的硬约束）⇒「真的点一下」跑不了。
 *   所以链条拆成三段分别钉住：
 *     ① `onClick → setSubmitted((prev) => nextSubmitted(prev, context))`（源码层断言，上一节）
 *     ② `nextSubmitted` 的决策（**本节**）
 *     ③ `submitted → recallRunner → port.recall` 收到的 `context`（上一节，真跑一次）
 *   三段都在，唯独 React 自己的事件派发不在（框架行为，不是本仓逻辑）。
 */
describe('T04 最终 · `nextSubmitted`：空白不提交、非空原样提交', () => {
  it('★ 空串 ⇒ 返回**同一个值**（`=== current`，证明没提交）', () => {
    const current = '上一次的文本';
    expect(nextSubmitted(current, '')).toBe(current);
  });

  it('★ 纯空白（空格 + 制表符）⇒ 同样返回**同一个值**', () => {
    const current = '上一次的文本';
    expect(nextSubmitted(current, ' \t  ')).toBe(current);
  });

  it('★ 首次就是空白：`null` 进、`null` 出（不存在「空串」这个中间态）', () => {
    expect(nextSubmitted(null, '   ')).toBeNull();
  });

  it('★ 非空 ⇒ 返回 `context` **本身**（不 trim、不包装、不改写）', () => {
    const context = ' 张三喜欢什么 ';
    const result = nextSubmitted(null, context);
    expect(result).toBe(context);
    // 判别力：如果实现偷偷 trim 了，这两条会红
    expect(result).not.toBe('张三喜欢什么');
    expect(result?.length).toBe(context.length);
  });

  it('★ 连续两次：先空白后非空 ⇒ **只有第二次**产生新值', () => {
    const first = nextSubmitted(null, '   ');
    expect(first).toBeNull();

    const second = nextSubmitted(first, '张三喜欢什么');
    expect(second).toBe('张三喜欢什么');
    expect(second).not.toBe(first);
  });

  it('★ 连续两次：先非空后空白 ⇒ 值**不被清空**（提交是「覆盖」，不是「可回退」）', () => {
    const first = nextSubmitted(null, '第一版文本');
    const second = nextSubmitted(first, '  ');
    expect(second).toBe(first);
  });

  it('★ 反例（判别力）：若实现改成「总是返回 context」，第一条必须红', () => {
    // 「总是提交」是这道题最容易被写成的错误实现（省掉 trim 判断一行）
    const alwaysSubmit = (_current: string | null, context: string): string | null => context;
    const current = '上一次的文本';

    // 正确实现：空白 ⇒ 保留原值
    expect(nextSubmitted(current, '   ')).toBe(current);
    // 写坏的实现：把空白当提交 ⇒ 与正确结果**不同**（⇒ 上面那条会红）
    expect(alwaysSubmit(current, '   ')).not.toBe(current);
    expect(alwaysSubmit(current, '   ')).toBe('   ');
    // 同理：首次空白，正确实现给 null，写坏的给 '   '
    expect(nextSubmitted(null, '   ')).toBeNull();
    expect(alwaysSubmit(null, '   ')).not.toBeNull();
  });
});
