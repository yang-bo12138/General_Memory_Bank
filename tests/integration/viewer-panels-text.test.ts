/**
 * ★ 面板 1 的**文案层**硬断言 —— 阶段 5 · T03（PLAN P5-T02 的硬断言逐条）。
 *
 * 本文件守的是「**措辞**」这一类事实：它们最容易在重构里被顺手改写，
 * 而改写**不报错、只是把一个正常状态标成坏了**（最典型：`flat_auto` 被标成「正在重训」）。
 *
 * ⚠️ ★ **期望值全部在测试里独立手写**，**不从 `texts.ts` import**。
 *   从 `texts.ts` import 期望值 ⇒ 「改文案」这件事会自动通过
 *   （期望值跟着实现一起变），那就不是断言，是自问自答。
 *   （唯一从 `texts.ts` import 的是**格式化函数本身**，那是在测函数而不是在抄期望值。）
 *
 * ⚠️ **字符串里的 `<`**：`renderToStaticMarkup` 会把文本转义成 `&lt;`
 *   ⇒ 期望值先过 `escapeHtml()` 再 `toContain`（见 `panelFixtures.ts` 的说明）。
 *
 * ⚠️ **本文件是 `.ts` 而不是 `.tsx`**：`vitest.config.ts` 的 `include` 只有
 *   `tests/**\/*.test.ts`，加 `.tsx` 要改门禁配置。
 *   不引入 JSX（改用 `createElement`）就不必碰配置 —— 换来的是每个用例多一层括号，
 *   比改一条门禁配置便宜。
 *
 * ⚠️ 每条正向断言都配了**判别力**：要么带一条「换成另一个输入就不该出现」的反例，
 *   要么带一条**负控**（拿故意写坏的输入过同一个判据，必须命中）。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OverviewView } from '../../viewer/renderer/panels/Overview.js';
import { readyState } from '../../viewer/renderer/state/useReadCall.js';
import {
  formatDuration,
  formatPercent,
  formatScore,
  formatTimestamp,
} from '../../viewer/renderer/texts.js';
import {
  CLUSTER_MEMBER_SAMPLE_MAX,
  CONTENT_HISTORY_PAGE_SIZE,
} from '../../viewer/shared/limits.js';
import { FIXED_NOW, escapeHtml, makeStats, makeVectorBackend } from '../helpers/panelFixtures.js';
import { listSourceFiles, readCode } from '../helpers/sourceScan.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、★ 五条向量路措辞（设计 §7.2 面板 1 的表，**独立手写**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ 五条措辞的**测试侧副本**。
 *
 * ⚠️ 「五条」不是「四条」：`absent` 按 `inRetrain` 分成两条。
 *   合并成一句就等于把「去建桶」与「等它跑完」这两种完全不同的下一步
 *   又糊成同一个界面 —— 而那正是 §7.2 禁止的「向量路静默缺席不可观测」。
 */
const EXPECTED_VECTOR_TEXTS = {
  flat_explicit: '向量路：flat 模式（已显式选择 flat）',
  flat_auto: '向量路：flat 模式（库规模 < 1 万条，未建分桶）',
  ivf: '向量路：ivf 模式（两级分桶）',
  absent_not_retraining: '向量路不可用（分桶未训练）',
  absent_retraining: '向量路不可用（分桶重训中）',
} as const;

/** 渲染面板 1（就绪态），返回静态 markup。 */
function renderOverview(stats: ReturnType<typeof makeStats>): string {
  return renderToStaticMarkup(
    createElement(OverviewView, { state: readyState(stats), now: FIXED_NOW }),
  );
}

/** 按 mode/inRetrain 渲染面板 1。 */
function renderWithVectorBackend(
  mode: 'flat_explicit' | 'flat_auto' | 'ivf' | 'absent',
  inRetrain = false,
  extra: { indexBytes?: number } = {},
): string {
  const vectorBackend = makeVectorBackend({ mode, inRetrain, ...extra });
  return renderOverview(makeStats({ vectorBackend }));
}

describe('T03 · 面板 1 的向量路块：五条措辞逐字匹配设计 §7.2 的表', () => {
  it('`flat_explicit` ⇒ 「已显式选择 flat」（那是**要求**，不是降级）', () => {
    const html = renderWithVectorBackend('flat_explicit');
    expect(html).toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.flat_explicit));
    // 判别力：它不该同时出现另外几条
    expect(html).not.toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.flat_auto));
    expect(html).not.toContain('向量路不可用');
  });

  it('`flat_auto` ⇒ 「库规模 < 1 万条，未建分桶」（**正常的小库**，不是坏了）', () => {
    const html = renderWithVectorBackend('flat_auto');
    expect(html).toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.flat_auto));
    expect(html).not.toContain('向量路不可用');
  });

  it('`ivf` ⇒ 「两级分桶」', () => {
    const html = renderWithVectorBackend('ivf');
    expect(html).toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.ivf));
    expect(html).not.toContain('向量路不可用');
  });

  it('`absent` + `inRetrain=false` ⇒ 「分桶未训练」', () => {
    const html = renderWithVectorBackend('absent', false);
    expect(html).toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.absent_not_retraining));
    expect(html).not.toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.absent_retraining));
  });

  it('`absent` + `inRetrain=true` ⇒ 「分桶重训中」', () => {
    const html = renderWithVectorBackend('absent', true);
    expect(html).toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.absent_retraining));
    expect(html).not.toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.absent_not_retraining));
  });

  it('反例：五条措辞互不相同（否则「不该出现」那些断言就没有判别力）', () => {
    const values = Object.values(EXPECTED_VECTOR_TEXTS);
    expect(new Set(values).size).toBe(5);
  });
});

describe('T03 补强 · 五条措辞逐条**取值**绑定（「整句出现过」≠「这个字段就是这句」）', () => {
  /**
   * ⚠️ ★ 为什么原来的写法不咬人：
   *   上面那五条用的是 `toContain(整句)` ⇒ 只要页面上**任何地方**出现过这句话就算过。
   *   极端反例：实现把五句**同时**渲染出来，五条断言**全绿**（而且用户看到五条互相矛盾的结论）。
   *   ⇒ 这里改成绑定 `data-vector-route-text` 那**一个节点**的**完整取值**：
   *     它必须**恰好**是这一句 —— 多一个字、少一个字、换成别的分支都算红。
   */
  const CASES: ReadonlyArray<
    readonly ['flat_explicit' | 'flat_auto' | 'ivf' | 'absent', boolean, string]
  > = [
    ['flat_explicit', false, EXPECTED_VECTOR_TEXTS.flat_explicit],
    ['flat_auto', false, EXPECTED_VECTOR_TEXTS.flat_auto],
    ['ivf', false, EXPECTED_VECTOR_TEXTS.ivf],
    ['absent', false, EXPECTED_VECTOR_TEXTS.absent_not_retraining],
    ['absent', true, EXPECTED_VECTOR_TEXTS.absent_retraining],
  ];

  for (const [mode, inRetrain, expected] of CASES) {
    it(`★ ${mode}（inRetrain=${String(inRetrain)}）⇒ 该节点的取值恰好是那一句`, () => {
      const html = renderWithVectorBackend(mode, inRetrain);
      expect(html).toContain(`data-vector-route-text="">${escapeHtml(expected)}</p>`);

      // 反向：另外四句**一句都不许**落在这个节点里（防止「五句同时渲染」那种假绿）
      for (const other of Object.values(EXPECTED_VECTOR_TEXTS)) {
        if (other === expected) {
          continue;
        }
        expect(html).not.toContain(`data-vector-route-text="">${escapeHtml(other)}</p>`);
      }
    });
  }
});

describe('T03 · 面板 1：`flat_auto` 不得被标成「正在重训」', () => {
  it('★ 注入 `flat_auto` + `inRetrain=true`（不合法的组合）⇒ 仍不出现「重训」', () => {
    // ⚠️ 设计说 `flat_auto` 时 `inRetrain` **恒为 false**（flat 不建桶 ⇒ 没有重训这件事）。
    //   面板必须是**结构性**地写不出这句话：分支先按 mode，`inRetrain` 只在 absent 里读。
    //   故意喂一个「不合法的组合」正是判别力所在 —— 顺着 inRetrain 分支的实现会当场红。
    const html = renderWithVectorBackend('flat_auto', true);
    expect(html).not.toContain('正在重训');
    expect(html).not.toContain('重训中');
    expect(html).toContain(escapeHtml(EXPECTED_VECTOR_TEXTS.flat_auto));
  });

  it('负控：「重训」这两个字**确实存在**于另一条分支（否则上一条是恒绿）', () => {
    const html = renderWithVectorBackend('absent', true);
    expect(html).toContain('重训中');
  });

  it('`flat_explicit` + `inRetrain=true` 同样不出现「重训」', () => {
    const html = renderWithVectorBackend('flat_explicit', true);
    expect(html).not.toContain('重训');
  });
});

describe('T03 · 面板 1：`absent` 的两种取值都常驻可见', () => {
  it('两种取值渲染出的 markup 不同（「常驻可见」不是靠一句通用文案糊过去的）', () => {
    expect(renderWithVectorBackend('absent', false)).not.toBe(
      renderWithVectorBackend('absent', true),
    );
  });

  it('`data-vector-in-retrain` 如实反映取值（可被机器读，不只能被眼睛读）', () => {
    expect(renderWithVectorBackend('absent', true)).toContain('data-vector-in-retrain="true"');
    expect(renderWithVectorBackend('absent', false)).toContain('data-vector-in-retrain="false"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、向量覆盖率（embeddedRatio）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 面板 1 必须显示 `embeddedRatio`', () => {
  it('★ `embeddedRatio = 0.4312` ⇒ 渲染出 `43.1%`（一位小数）', () => {
    const html = renderOverview(makeStats({ embeddedRatio: 0.4312 }));
    expect(html).toContain('43.1%');
    expect(html).toContain('向量覆盖率');
  });

  it('判别力：换一个比例数字就跟着变（不是写死的 43.1%）', () => {
    const html = renderOverview(makeStats({ embeddedRatio: 0.0875 }));
    expect(html).toContain('8.8%');
    expect(html).not.toContain('43.1%');
  });

  it('原始值也挂在 `data-embedded-ratio` 上（排障时不必从文案里抠数）', () => {
    const html = renderOverview(makeStats({ embeddedRatio: 0.4312 }));
    expect(html).toContain('data-embedded-ratio="0.4312"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、`flat` 模式下不得显示「向量索引占用」
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 面板 1：flat 模式下不得显示「向量索引占用」', () => {
  const INDEX_LABEL = '向量索引占用';

  it('★ `flat_explicit` 即便给了 `indexBytes` 也不显示', () => {
    const html = renderWithVectorBackend('flat_explicit', false, { indexBytes: 1_048_576 });
    expect(html).not.toContain(INDEX_LABEL);
    expect(html).not.toContain('data-vector-index-bytes');
  });

  it('★ `flat_auto` 即便给了 `indexBytes` 也不显示', () => {
    const html = renderWithVectorBackend('flat_auto', false, { indexBytes: 1_048_576 });
    expect(html).not.toContain(INDEX_LABEL);
    expect(html).not.toContain('data-vector-index-bytes');
  });

  it('负控：`ivf` 且给了 `indexBytes` ⇒ **必须**显示（否则上面两条是恒绿）', () => {
    const html = renderWithVectorBackend('ivf', false, { indexBytes: 1_048_576 });
    expect(html).toContain(INDEX_LABEL);
    expect(html).toContain('data-vector-index-bytes="1048576"');
  });

  it('`ivf` 但没给 `indexBytes` ⇒ 不显示（不画一个空指标）', () => {
    const html = renderWithVectorBackend('ivf');
    expect(html).not.toContain(INDEX_LABEL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、「向量索引损坏」这句话**在渲染层根本不存在**
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 渲染层没有「向量索引损坏」这句措辞', () => {
  it('★ `viewer/renderer/**` 的代码里一次都不出现', () => {
    const files = listSourceFiles('viewer/renderer');
    // ⚠️ 分母不为 0：目录空了会让下面的循环变成恒绿的空气断言
    expect(files.length).toBeGreaterThanOrEqual(8);
    const offenders = files.filter((file) => readCode(file).includes('向量索引损坏'));
    expect(offenders).toEqual([]);
  });

  it('负控：同一判据能在**故意写坏**的源码上命中', () => {
    const probe = "export const label = '向量索引损坏';";
    expect(probe.includes('向量索引损坏')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、面板 1 的渲染快照（结构漂移会被这条抓住）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 面板 1 渲染快照', () => {
  it('就绪态的整段 markup（`flat_auto` + 覆盖率 0.4312）', () => {
    const html = renderToStaticMarkup(
      createElement(OverviewView, {
        state: readyState(makeStats({ embeddedRatio: 0.4312 })),
        now: FIXED_NOW,
      }),
    );
    expect(html).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、格式化函数的确定性（面板的全部时间/比例文案都由它们产出）
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 格式化函数：确定性且不受本地时区影响', () => {
  it('`formatPercent` 一位小数、非法值显示 `—` 而不是 `NaN%`', () => {
    expect(formatPercent(0.4312)).toBe('43.1%');
    expect(formatPercent(0.5)).toBe('50.0%');
    expect(formatPercent(0.6)).toBe('60.0%');
    expect(formatPercent(Number.NaN)).toBe('—');
  });

  it('`formatScore` 三位小数（`0` 必须渲染成 `0.000`，`—` 是另一件事）', () => {
    expect(formatScore(0)).toBe('0.000');
    expect(formatScore(0.123456)).toBe('0.123');
  });

  it('`formatTimestamp` 用 **UTC**（换机器不变），而不是本地时区', () => {
    expect(formatTimestamp(0)).toBe('1970-01-01 00:00:00 UTC');
    expect(formatTimestamp(FIXED_NOW)).toBe('2024-01-31 12:00:00 UTC');
  });

  it('`formatDuration` 四档单位、负数钳到 0', () => {
    expect(formatDuration(2 * 3_600_000)).toBe('2 小时');
    expect(formatDuration(90_000)).toBe('2 分钟');
    expect(formatDuration(1.5 * 86_400_000)).toBe('1.5 天');
    expect(formatDuration(-5)).toBe('0 秒');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、两个「50」只能来自常量
// ═══════════════════════════════════════════════════════════════════════════

describe('T03 · 页大小与成员样本上限的单一出处', () => {
  it('`CONTENT_HISTORY_PAGE_SIZE === 50`（设计 §7.2 面板 6 的「最近 50 版」）', () => {
    expect(CONTENT_HISTORY_PAGE_SIZE).toBe(50);
  });

  it('`CLUSTER_MEMBER_SAMPLE_MAX === 50`（§4.12.4 的枚举上限，派生自 `DEFAULT_PARAMS`）', () => {
    expect(CLUSTER_MEMBER_SAMPLE_MAX).toBe(50);
  });

  it('★ 渲染层源码里**不出现**硬编码的 `50`（都要走常量）', () => {
    const files = listSourceFiles('viewer/renderer');
    expect(files.length).toBeGreaterThanOrEqual(8);
    const offenders = files.filter((file) => /\b50\b/.test(readCode(file)));
    expect(offenders).toEqual([]);
  });

  it('负控：同一个判据能在带 `50` 字面量的源码上命中', () => {
    expect(/\b50\b/.test('const pageSize = 50;')).toBe(true);
    expect(/\b50\b/.test('const limit = 150;')).toBe(false);
  });
});
