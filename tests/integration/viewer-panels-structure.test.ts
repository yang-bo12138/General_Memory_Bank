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
import { App, WIRED_PANELS } from '../../viewer/renderer/App.js';
import { MemoryListView } from '../../viewer/renderer/panels/MemoryList.js';
import { RecallSimulatorView } from '../../viewer/renderer/panels/RecallSimulator.js';
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
  makeMemoryDetail,
  makeMemoryError,
  makeRecallHit,
  makeRecallSimResult,
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
  it('★ 标注出现，且**不出现**「向量索引损坏」', () => {
    const html = renderRecall(readyState(makeRecallSimResult({ hasEmbedder: false })));
    expect(html).toContain('本次未执行向量路');
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
  const WHITELIST = ['上一页', '下一页', '模拟召回', '刷新快照'];

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

describe('T03 · 面板共用同一套状态组件（不各写一套）', () => {
  it('★ `panels/*.tsx` 里 `catch (` 出现次数为 0（错误只在 `state/` 里处理）', () => {
    const panels = listSourceFiles('viewer/renderer/panels').filter((file) =>
      file.endsWith('.tsx'),
    );
    expect(panels.length).toBeGreaterThanOrEqual(3);
    for (const file of panels) {
      expect(/catch\s*\(/.test(readCode(file)), `${file} 里出现了 catch (`).toBe(false);
    }
  });

  it('★ 每个面板文件都 import `useReadCall` 与 `StatusBlock`', () => {
    const panels = listSourceFiles('viewer/renderer/panels').filter((file) =>
      file.endsWith('.tsx'),
    );
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
