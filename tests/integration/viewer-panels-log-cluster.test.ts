/**
 * ★ 面板 5 / 面板 7 的硬断言 —— 阶段 5 · T04（PLAN P5-T03 面板 5 + P5-T04 面板 7）。
 *
 * 面板 5（只读日志）守三条：
 *   ① ★ **只调 `port.logs`**：调用序列里没有别的库方法（一次 `select` 都没有）；
 *   ② **`logs` 的实现只用 `readFileSync`**（源码断言：不含 `writeFile` / `appendFile` / `mkdir`）；
 *   ③ 按年 / 月 / 日 + 关键字高亮 + 分页。
 *
 * 面板 7（礁石图）守六条：
 *   ① ★ **成员顺序与 `clusters().memberIds` 完全一致**（面板**不重新排序**，这是判别力所在）；
 *   ② ★ **快照新鲜度常驻**（`computedAt` 相对时间 + `stale` 措辞）；
 *   ③ ★ **`coverage` 与 `largestClusterRatio` 同时显示**；
 *   ④ ★ **巨型簇不隐藏**（占 60% 的簇必须显示并标注占比）；
 *   ⑤ ★ **成员列表带 LIMIT**（1000 成员的簇只渲染 ≤ 50 条，且写出「仅显示前 N 条」）；
 *   ⑥ ★ **「最近两次快照对比」用成员重叠度，不用 `key`**（源码里不出现簇的 `key` 字段）；
 *   ⑦ **「上次结果」基准说明常驻**（「本次会话内」逐字）。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClustersResult } from '../../src/store/clusters.js';
import {
  ClusterMapView,
  compareSnapshots,
  loadClusters,
  memberOverlapRatio,
} from '../../viewer/renderer/panels/ClusterMap.js';
import { LogViewerView, loadLogPage } from '../../viewer/renderer/panels/LogViewer.js';
import { errorState, readyState } from '../../viewer/renderer/state/useReadCall.js';
import { CLUSTER_MEMBER_SAMPLE_MAX } from '../../viewer/shared/limits.js';
import type { LogPage, ReadPort } from '../../viewer/shared/protocol.js';
import {
  FIXED_NOW,
  escapeHtml,
  makeClusterView,
  makeClustersResult,
  makeLogPage,
  makeMemoryError,
} from '../helpers/panelFixtures.js';
import { listSourceFiles, readCode } from '../helpers/sourceScan.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、面板 5 · 只读日志
// ═══════════════════════════════════════════════════════════════════════════

/** 记录**所有**被调用的端口方法（不只是 select）。 */
function makeMethodRecordingPort(methodNames: ReadonlyArray<string>): {
  port: ReadPort;
  called: string[];
} {
  const called: string[] = [];
  const make = (name: string) => (): Promise<never> => {
    called.push(name);
    return Promise.reject(new Error(`假端口不该被调用：${name}`));
  };
  const port: ReadPort = {
    stats: make('stats'),
    get: make('get'),
    recall: make('recall'),
    clusters: make('clusters'),
    inhibitionTrace: make('inhibitionTrace'),
    verifyIntegrity: make('verifyIntegrity'),
    select: (() => {
      called.push('select');
      return Promise.reject(new Error('面板 5 不该调 select'));
    }) as unknown as ReadPort['select'],
    logs: (() => {
      called.push('logs');
      return Promise.resolve(makeLogPage());
    }) as unknown as ReadPort['logs'],
  };
  // ⚠️ 分母：至少要有一个方法真的会被调（否则「调用序列 = ['logs']」是恒绿）
  expect(methodNames).toContain('logs');
  return { port, called };
}

const LOG_QUERY = { year: 2024, month: 1, day: 31, offset: 0 } as const;

describe('T04 · 面板 5 只读：调用序列里只有 `logs`', () => {
  it('★ `loadLogPage` 只调 `port.logs`（没有 `select`、没有别的库方法）', async () => {
    const { port, called } = makeMethodRecordingPort(['logs', 'select']);
    await loadLogPage(port, LOG_QUERY);
    expect(called).toEqual(['logs']);
  });

  it('★ `logs` 的实现只用 `readFileSync`：源码里没有 `writeFile` / `appendFile` / `mkdir`', () => {
    const code = readCode('viewer/main/db-worker.ts');
    expect(code).toContain('readFileSync');
    expect(code).not.toContain('writeFile');
    expect(code).not.toContain('appendFile');
    expect(code).not.toContain('mkdir');
  });

  it('负控：同一组判据能在**故意写坏**的源码上命中', () => {
    const probe = "import { writeFileSync } from 'node:fs';\nwriteFileSync(p, t);";
    expect(probe.includes('writeFile')).toBe(true);
  });

  it('渲染面板 5 不发任何端口调用（状态是喂进去的 ⇒ 渲染是纯的）', () => {
    const { port, called } = makeMethodRecordingPort(['logs']);
    renderToStaticMarkup(
      createElement(LogViewerView, {
        state: readyState(makeLogPage()),
        query: LOG_QUERY,
        now: FIXED_NOW,
      }),
    );
    expect(called).toEqual([]);
    expect(port).toBeDefined();
  });
});

describe('T04 · 面板 5：按年月日浏览 + 关键字高亮 + 分页', () => {
  const page = makeLogPage(
    [
      { no: 7, raw: '2024-01-31 12:00:00  info  召回  id=m-1 reason=wake', level: 'info' },
      { no: 8, raw: '2024-01-31 12:00:01  error  错误  op=recall err=boom', level: 'error' },
    ],
    240,
  );

  it('★ 年月日与命中总数都在页面上（用户知道自己看的是哪一天、还有多少）', () => {
    const html = renderToStaticMarkup(
      createElement(LogViewerView, { state: readyState(page), query: LOG_QUERY, now: FIXED_NOW }),
    );
    expect(html).toContain('2024');
    expect(html).toContain('1');
    expect(html).toContain('31');
    expect(html).toContain('命中 240 行');
  });

  it('★ 关键字高亮：包成 `<mark>`，且**原样保留大小写与整行**', () => {
    const html = renderToStaticMarkup(
      createElement(LogViewerView, {
        state: readyState(page),
        query: { ...LOG_QUERY, keyword: 'RECALL' },
        now: FIXED_NOW,
      }),
    );
    // 原行里是小写 `recall`，高亮后仍是小写（高亮不改大小写）
    expect(html).toContain('<mark>recall</mark>');
    expect(html).toContain('错误');
    expect(html).not.toContain('<mark>RECALL</mark>');
  });

  it('判别力：没有关键字时**不**出现任何 `<mark>`', () => {
    const html = renderToStaticMarkup(
      createElement(LogViewerView, { state: readyState(page), query: LOG_QUERY, now: FIXED_NOW }),
    );
    expect(html).not.toContain('<mark');
  });

  it('★ 分页控件：上一页 / 下一页，偏移挂在容器上', () => {
    const html = renderToStaticMarkup(
      createElement(LogViewerView, {
        state: readyState(page),
        query: { ...LOG_QUERY, offset: 10 },
        now: FIXED_NOW,
      }),
    );
    expect(html).toContain('data-pager="prev"');
    expect(html).toContain('data-pager="next"');
    expect(html).toContain('data-log-offset="10"');
    expect(html).toContain('偏移 10');
  });

  it('日志行的级别如实反映到 `data-level`（`error` 行要能被单独高亮）', () => {
    const html = renderToStaticMarkup(
      createElement(LogViewerView, { state: readyState(page), query: LOG_QUERY, now: FIXED_NOW }),
    );
    expect(html).toContain('data-level="info"');
    expect(html).toContain('data-level="error"');
  });

  it('空页有独立空态', () => {
    const html = renderToStaticMarkup(
      createElement(LogViewerView, {
        state: readyState(makeLogPage([], 0)),
        query: LOG_QUERY,
        now: FIXED_NOW,
      }),
    );
    expect(html).toContain('这一天没有匹配的日志');
  });
});

describe('T04 · 面板 5 的错误呈现', () => {
  it('★ 显示错误码 + details，不含「加载失败」', () => {
    const html = renderToStaticMarkup(
      createElement(LogViewerView, {
        state: errorState<LogPage>(makeMemoryError('INVALID_INPUT', { year: 2024, month: 13 })),
        query: LOG_QUERY,
        now: FIXED_NOW,
      }),
    );
    expect(html).toContain('INVALID_INPUT');
    expect(html).toContain('2024');
    expect(html).not.toContain('加载失败');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、面板 7 · 礁石图
// ═══════════════════════════════════════════════════════════════════════════

/** 渲染面板 7。 */
function renderClusters(
  snapshot: ReturnType<typeof makeClustersResult>,
  previous: ReturnType<typeof makeClustersResult> | null = null,
): string {
  return renderToStaticMarkup(
    createElement(ClusterMapView, { state: readyState(snapshot), previous, now: FIXED_NOW }),
  );
}

/** 抽出成员列表里的 `data-member-id`（按渲染顺序）。 */
function memberIds(html: string): string[] {
  return [...html.matchAll(/data-member-id="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('T04 · 面板 7：成员顺序与 `clusters().memberIds` 完全一致', () => {
  it('★ 喂一个**乱序**的 `memberIds` ⇒ 渲染顺序**仍是输入顺序**（面板不重新排序）', () => {
    // 若面板自己 sort() 一遍，这条会红 —— 这就是判别力所在。
    const unsorted = ['m-9', 'm-2', 'm-7', 'm-1'];
    const snapshot = makeClustersResult({
      clusters: [makeClusterView({ clusterId: 'c-1', memberIds: unsorted })],
    });
    const html = renderClusters(snapshot);
    expect(memberIds(html)).toEqual(unsorted);
    expect(memberIds(html)).not.toEqual([...unsorted].sort());
  });

  it('两个簇的成员按簇的顺序拼接，互不交叉', () => {
    const snapshot = makeClustersResult({
      clusters: [
        makeClusterView({ clusterId: 'c-1', memberIds: ['m-3', 'm-1'] }),
        makeClusterView({ clusterId: 'c-2', memberIds: ['m-9', 'm-5'] }),
      ],
    });
    expect(memberIds(renderClusters(snapshot))).toEqual(['m-3', 'm-1', 'm-9', 'm-5']);
  });

  it('源码里没有对 `memberIds` 排序的调用（`slice` 之外不动它）', () => {
    const bubble = readCode('viewer/renderer/panels/ClusterBubble.tsx');
    expect(bubble).toContain('cluster.memberIds.slice(');
    expect(bubble).not.toMatch(/memberIds[^;]*\.sort\(/);
  });
});

describe('T04 · 面板 7：快照新鲜度常驻可见', () => {
  it('★ 新鲜快照 ⇒ 相对时间 + 「前更新」', () => {
    const snapshot = makeClustersResult({ computedAt: FIXED_NOW - 2 * 3_600_000, stale: false });
    const html = renderClusters(snapshot);
    expect(html).toContain('簇快照');
    expect(html).toContain('2 小时前更新');
  });

  it('★ 过期快照 ⇒ 「已过期」措辞（与「前更新」互斥）', () => {
    const snapshot = makeClustersResult({ computedAt: FIXED_NOW - 2 * 3_600_000, stale: true });
    const html = renderClusters(snapshot);
    expect(html).toContain('簇快照');
    expect(html).toContain('已过期');
    expect(html).not.toContain('前更新');
  });

  it('判别力：不同的 `computedAt` ⇒ 不同的相对时间文案', () => {
    const recent = renderClusters(makeClustersResult({ computedAt: FIXED_NOW - 30_000 }));
    expect(recent).toContain('30 秒前更新');
  });
});

describe('T04 · 面板 7：`coverage` 与 `largestClusterRatio` 同时显示', () => {
  it('★ 两个数都在场，且各自带标签', () => {
    const html = renderClusters(makeClustersResult({ coverage: 0.5, largestClusterRatio: 0.3 }));
    expect(html).toContain('簇覆盖率');
    expect(html).toContain('最大簇占比');
    expect(html).toContain('50.0%');
    expect(html).toContain('30.0%');
  });

  it('判别力：换一组比例 ⇒ 两个数都跟着变（不是写死的 50% / 30%）', () => {
    const html = renderClusters(
      makeClustersResult({ coverage: 0.125, largestClusterRatio: 0.875 }),
    );
    expect(html).toContain('12.5%');
    expect(html).toContain('87.5%');
    expect(html).not.toContain('50.0%');
  });
});

describe('T04 · 面板 7：巨型簇不隐藏', () => {
  it('★ 一个占 60% 的簇必须**显示**出来，并标注 `60.0%`', () => {
    const giant = makeClusterView({
      clusterId: 'c-giant',
      memberIds: Array.from({ length: 60 }, (_, index) => `m-${index + 1}`),
      size: 60,
    });
    const snapshot = makeClustersResult({
      totalMemories: 100,
      largestClusterRatio: 0.6,
      clusters: [giant, makeClusterView({ clusterId: 'c-small', memberIds: ['m-99'], size: 1 })],
    });
    const html = renderClusters(snapshot);
    expect(html).toContain('c-giant');
    expect(html).toContain('60.0%');
    expect(html).toContain('最大簇占比 60.0%');
  });

  it('★ 空簇集才走空态（巨型簇不会因为「太大」被过滤成空态）', () => {
    const onlyGiant = makeClustersResult({
      totalMemories: 100,
      largestClusterRatio: 0.6,
      clusters: [makeClusterView({ clusterId: 'c-giant', memberIds: ['m-1'], size: 60 })],
    });
    const html = renderClusters(onlyGiant);
    expect(html).not.toContain('当前没有任何簇');
    expect(html).toContain('c-giant');
  });
});

describe('T04 · 面板 7：成员列表带 LIMIT（1000 成员的簇只渲染 50 条）', () => {
  it('★ 渲染出的成员行数 == `CLUSTER_MEMBER_SAMPLE_MAX`（= 50），不是 1000', () => {
    const huge = makeClusterView({
      clusterId: 'c-huge',
      memberIds: Array.from({ length: 1000 }, (_, index) => `m-${index + 1}`),
      size: 1000,
    });
    const html = renderClusters(makeClustersResult({ clusters: [huge] }));
    expect(memberIds(html).length).toBe(CLUSTER_MEMBER_SAMPLE_MAX);
    expect(memberIds(html).length).toBe(50);
    expect(memberIds(html)).not.toContain('m-51');
  });

  it('★ 并且写出「仅显示前 50 条成员（该簇共 1000 条）」', () => {
    const huge = makeClusterView({
      clusterId: 'c-huge',
      memberIds: Array.from({ length: 1000 }, (_, index) => `m-${index + 1}`),
      size: 1000,
    });
    const html = renderClusters(makeClustersResult({ clusters: [huge] }));
    expect(html).toContain('仅显示前 50 条成员');
    expect(html).toContain('1000');
  });

  it('判别力：40 个成员的簇渲染 40 条（上限只在超出时生效，不是恒 50）', () => {
    const cluster = makeClusterView({
      memberIds: Array.from({ length: 40 }, (_, index) => `m-${index + 1}`),
      size: 40,
    });
    expect(memberIds(renderClusters(makeClustersResult({ clusters: [cluster] }))).length).toBe(40);
  });
});

describe('T04 · 面板 7：「最近两次快照对比」用成员重叠度，不用 `key`', () => {
  it('★ 源码里**不出现**簇的 `key` 字段（`.key` 一次都没有）', () => {
    const code = readCode('viewer/renderer/panels/ClusterMap.tsx');
    expect(/\.key\b/.test(code)).toBe(false);
  });

  it('★ 同名簇的 `key` 相同但成员不同 ⇒ 重叠度 != 1（这正是 key 不能用作对比依据的原因）', () => {
    const previous = makeClustersResult({
      clusters: [makeClusterView({ key: 'm-1', clusterId: 'c-1', memberIds: ['m-1', 'm-2'] })],
    });
    const current = makeClustersResult({
      clusters: [makeClusterView({ key: 'm-1', clusterId: 'c-9', memberIds: ['m-1', 'm-7'] })],
    });
    // key 相同（都是 m-1）⇒ 若拿 key 比，结论会是「1.0 = 完全一样」
    expect(previous.clusters[0]?.key).toBe(current.clusters[0]?.key);
    const ratio = memberOverlapRatio(
      previous.clusters[0]?.memberIds ?? [],
      current.clusters[0]?.memberIds ?? [],
    );
    expect(ratio).toBe(0.5);
    expect(ratio).not.toBe(1);
  });

  it('重叠度是纯函数：完全相同 ⇒ 1、完全无关 ⇒ 0、一侧为空 ⇒ 0、包含关系 ⇒ 1', () => {
    expect(memberOverlapRatio(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(memberOverlapRatio(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(memberOverlapRatio([], ['a'])).toBe(0);
    expect(memberOverlapRatio(['a'], [])).toBe(0);
    // 包含关系（簇长大）：按较小集合归一 ⇒ 1.0，而不是 1/3
    expect(memberOverlapRatio(['a'], ['a', 'b', 'c'])).toBe(1);
  });

  it('`compareSnapshots` 给每个本次簇找到**重叠度最高**的上次簇', () => {
    const previous = makeClustersResult({
      clusters: [
        makeClusterView({ clusterId: 'p-1', memberIds: ['m-1', 'm-2', 'm-3'] }),
        makeClusterView({ clusterId: 'p-2', memberIds: ['m-8', 'm-9'] }),
      ],
    });
    const current = makeClustersResult({
      clusters: [makeClusterView({ clusterId: 'c-1', memberIds: ['m-8', 'm-9'] })],
    });
    const rows = compareSnapshots(previous, current);
    expect(rows.length).toBe(1);
    expect(rows[0]?.partnerClusterId).toBe('p-2');
    expect(rows[0]?.overlap).toBe(1);
  });

  it('没有上次快照 ⇒ 对比区给出「还没有上一次结果」的空态', () => {
    const html = renderClusters(makeClustersResult(), null);
    expect(html).toContain('本次会话内还没有上一次结果');
  });

  it('有上次快照 ⇒ 对比区列出重叠度（不是列 key）', () => {
    const previous = makeClustersResult({
      clusters: [makeClusterView({ clusterId: 'p-1', memberIds: ['m-1', 'm-2'] })],
    });
    const current = makeClustersResult({
      clusters: [makeClusterView({ clusterId: 'c-1', memberIds: ['m-1', 'm-2'] })],
    });
    const html = renderClusters(current, previous);
    expect(html).toContain('最近两次快照对比');
    expect(html).toContain('成员重叠度 100.0%');
  });
});

describe('T04 · 面板 7：「上次结果」的基准说明常驻', () => {
  /** ★ 测试侧**独立手写**的基准说明（不从 `texts.ts` import）。 */
  const EXPECTED_BASELINE =
    '「上次结果」= 本次会话内上次打开本面板时的结果，不是上一版已发布快照。';

  it('★ 渲染结果含基准说明的**逐字**文本', () => {
    expect(renderClusters(makeClustersResult(), null)).toContain(escapeHtml(EXPECTED_BASELINE));
  });

  it('★ 并且含「本次会话内」这个词（判据不依赖整句一字不差）', () => {
    expect(renderClusters(makeClustersResult(), null)).toContain('本次会话内');
  });

  it('有上次快照时它**仍然**在场（常驻，不是只在空态出现）', () => {
    const html = renderClusters(makeClustersResult(), makeClustersResult());
    expect(html).toContain(escapeHtml(EXPECTED_BASELINE));
  });
});

describe('T04 · 面板 7：无写入口 + 错误呈现', () => {
  it('★ 渲染树里的 `<button>` 文案 ⊆ 白名单（本面板一个按钮都不需要）', () => {
    const whitelist = ['上一页', '下一页', '模拟召回', '刷新快照'];
    const html = renderClusters(makeClustersResult());
    const labels = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
      (match[1] ?? '').replace(/<[^>]*>/g, '').trim(),
    );
    for (const label of labels) {
      expect(whitelist).toContain(label);
    }
    expect(html).not.toContain('回滚');
  });

  it('★ 错误呈现：错误码 + details，不含「加载失败」', () => {
    const html = renderToStaticMarkup(
      createElement(ClusterMapView, {
        state: errorState<ClustersResult>(
          makeMemoryError('DATABASE_BUSY', { reason: 'worker_timeout' }),
        ),
        previous: null,
        now: FIXED_NOW,
      }),
    );
    expect(html).toContain('DATABASE_BUSY');
    expect(html).toContain('worker_timeout');
    expect(html).not.toContain('加载失败');
  });

  it('`loadClusters` 只调 `port.clusters`', async () => {
    const called: string[] = [];
    const port = {
      clusters: (() => {
        called.push('clusters');
        return Promise.resolve(makeClustersResult());
      }) as unknown as ReadPort['clusters'],
    } as unknown as ReadPort;
    await loadClusters(port, FIXED_NOW);
    expect(called).toEqual(['clusters']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、七个面板文件全都在场（T04 补齐）
// ═══════════════════════════════════════════════════════════════════════════

describe('T04 · 七个面板文件全部存在，且共用同一套状态组件', () => {
  /** ★ 七个面板的写死清单（与 T03 的 `EXPECTED_PANEL_FILES` 同源，此处独立再写一遍）。 */
  const SEVEN = [
    'viewer/renderer/panels/Overview.tsx',
    'viewer/renderer/panels/MemoryList.tsx',
    'viewer/renderer/panels/RecallSimulator.tsx',
    'viewer/renderer/panels/GraphView.tsx',
    'viewer/renderer/panels/LogViewer.tsx',
    'viewer/renderer/panels/VersionHistory.tsx',
    'viewer/renderer/panels/ClusterMap.tsx',
  ];

  it('★ 七个面板文件一个不缺', () => {
    const all = new Set(listSourceFiles('viewer/renderer/panels'));
    const missing = SEVEN.filter((file) => !all.has(file));
    expect(missing).toEqual([]);
  });

  it('★ 每个面板都 import `useReadCall` 与 `StatusBlock`、且都没有 `catch (`', () => {
    for (const file of SEVEN) {
      const code = readCode(file);
      expect(code, `${file} 没有 import useReadCall`).toContain('state/useReadCall.js');
      expect(code, `${file} 没有 import StatusBlock`).toContain('state/StatusBlock.js');
      expect(/catch\s*\(/.test(code), `${file} 里出现了 catch (`).toBe(false);
    }
  });

  it('★ 每个面板都同时导出一个 `*View` 纯展示组件（测试与快照都靠它）', () => {
    for (const file of SEVEN) {
      expect(readCode(file), `${file} 没有 View 组件`).toMatch(/export function \w+View\(/);
    }
  });
});
