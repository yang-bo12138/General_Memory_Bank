/**
 * `scripts/audit-tier-qualifiers.mjs` 的单测 —— 档位限定一致性审计。
 *
 * ★ 本文件的断言纪律（沿用仓库惯例）：
 *   · **每条正向断言都配一条反例**：反例不是「换个输入再看一遍」，而是**故意写出那个会错的写法**
 *     （把档位限定词删掉 / 把档位限定词换成只说明「哪一次」的弱词），
 *     断言「守卫会红」⇒ 证明守卫**真的能发现不一致**（否则守卫只是装饰）。
 *   · 反例一律用**合成输入**（不动仓库里的真实文件）⇒ 测试可重复、且不会污染工作树。
 *   · **不写死快照数字**：期望值写成「真缺数 > 0」「自带档位数下降」这类**性质**。
 *   · ★ **额外守一条「白名单漂移」**：档位词表若被改坏（把弱词塞回强词表）⇒ 本文件立刻红。
 *   · ★ **额外守一条「声明漂移」**：`scripts/audit-tier-qualifiers.d.mts` 若漏声明了某个导出
 *     ⇒ 本文件立刻红 ⇒ ⇒ **类型声明与实现不会各走各的**。
 *   · ★ **所有变异都走 `mustReplace`** ⇒ **变异若没生效就直接抛错**
 *     ⇒ ⇒ **「变异没生效 ⇒ 断言是空的」这种假绿被从根上堵死**
 *     （★ 主理人那封里「我第一次的变异无效、第二次才有效 ⇒ 这一步不能省」⇒ ⇒ **把它固化进测试**）。
 *
 * ⚠️ **为什么这个守卫必须带反例**：本审计脚本的第一版**恒绿**——
 *   它的档位词表里混进了「本次 / 上一轮」这类**只说明「是哪一次」的代词**，
 *   于是「这一段谈过档位 ⇒ 这一行的数就都算有档位限定」⇒ **作用域被几个代词撑起来**
 *   ⇒ ⇒ **任何变异都打不红它** ⇒ ⇒ **只测「通过」的话，那时的它照样全绿**。
 *
 * ⚠️ **断言必须与脚本的两级判定对齐**（本文件第一版在这里栽过 ⇒ 记下来）：
 *   脚本的判定是**两级**的 ⇒ 「真缺」要求**片段 ∪ 表头 ∪ 上下文 ∪ 小节标题全无强档位词**；
 *   ⇒ **只把行内 / 表头的强词换成弱词，而上下文仍有强词** ⇒ 正确结果是「提示」（不判红），
 *   ⇒ **不是「真缺」** ⇒ ⇒ 断言必须写成「自带档位的数变少了」（**性质**），
 *   ⇒ 而不是硬写「真缺数 > 0」（**那是对两级判定的误读** ⇒ ⇒ 会逼着人改对的东西）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  STRONG_TIER_WORDS,
  WEAK_TIER_WORDS,
  auditTierQualifiers,
  hasTier,
  renderAudit,
} from '../../scripts/audit-tier-qualifiers.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const README_PATH = join(REPO_ROOT, 'docs/baseline/README.md');
const IMPL_PATH = join(REPO_ROOT, 'scripts/audit-tier-qualifiers.mjs');
const DECL_PATH = join(REPO_ROOT, 'scripts/audit-tier-qualifiers.d.mts');

/**
 * 替换并**断言变异真的生效**。
 *
 * ⚠️ **为什么必须有这个断言**：若搜索串写错（与实际文本不一致），
 * `String.replace` 会**静默不改** ⇒ ⇒ **反例就等于没变异** ⇒ ⇒ **那条断言变成空的、恒为真** ⇒ ⇒ **假绿**。
 * ⇒ ⇒ 本项目已经真踩过一次（合成输入里的表头文字与替换串不一致 ⇒ 变异静默失效）。
 *
 * @param text 原文本
 * @param from 搜索串（必须存在）
 * @param to 替换成
 * @returns 替换后的文本
 */
function mustReplace(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`★ 变异未生效：文本里找不到 ${JSON.stringify(from)}`);
  }
  return text.replace(from, to);
}

/** 表头单元格：含**强档位词**（`冷盘档`）＋ **弱指示词**（`本次`）。 */
const HEADER_CELL = '**本次 · 冷盘档**';
/**
 * 本行片段：含**强档位词**（`冷盘档`）＋ 同行另一个数带**弱指示词**（`上一轮`）。
 *
 * ⚠️ **为什么这一格里有两个数**：这是「**同一格里两个数分属不同档位**」的最小样本
 *   ⇒ ⇒ 判定必须落到**片段**级才分得开 ⇒ ⇒ 也让「自带档位的数」有了一个可数的基数。
 */
const ROW_CELL = '**1199.99 ms**（**冷盘档**；样本 500；⚠️ **热盘档上一轮 = 644.06ms**）';
/** 上下文行：只含**强档位词**（`冷盘档`）⇒ 它是「宽作用域」那一层。 */
const CONTEXT_LINE = '> ⚠️ 以下三行都是**冷盘档**的数 ⇒ 上下文层能给出档位。';

/**
 * 合成输入：一段最小 README，**四层作用域都存在**（本行片段 / 表头 / 上下文 / 小节标题）。
 */
const SYNTHETIC_README = [
  '# 合成基线',
  '',
  CONTEXT_LINE,
  '',
  `| 指标 | 100 万条实测（${HEADER_CELL}） | 门槛 | 判定 |`,
  '|---|---|---|---|',
  `| 写入 P99 | ${ROW_CELL} | ≤ 5 ms | ❌ |`,
  '',
].join('\n');

/** 变体 A：删掉**本行片段**与**表头**里的强档位词** ⇒ 上下文仍能给出档位 ⇒ 应变成「提示」。 */
const SYNTHETIC_NO_LOCAL_TIER = mustReplace(
  mustReplace(SYNTHETIC_README, ROW_CELL, ROW_CELL.replace('**冷盘档**；', '档位未标；')),
  HEADER_CELL,
  '**本次 · 档位未标**',
);

/** 变体 B：再删掉**上下文**里的强档位词 ⇒ 四层都没有 ⇒ 应判「真缺」。 */
const SYNTHETIC_NO_TIER_AT_ALL = mustReplace(
  SYNTHETIC_NO_LOCAL_TIER,
  '**冷盘档**的数',
  '档位未标的数',
);

/**
 * 变体 C：把本行片段里的强档位词换成**弱指示词**（`上一轮`）⇒ **弱词撑不起作用域**。
 *
 * ⚠️ **上下文那一行仍留着强词** ⇒ ⇒ 按脚本的**两级**判定，正确结果是「提示」而不是「真缺」
 *   ⇒ ⇒ 这条反例断言的是**性质**（「自带档位的数变少了」），不是硬写「真缺数 > 0」。
 */
const SYNTHETIC_WEAK_TIER_ONLY = mustReplace(
  mustReplace(SYNTHETIC_README, ROW_CELL, ROW_CELL.replace('**冷盘档**；', '上一轮；')),
  HEADER_CELL,
  '**上一轮 · 档位未标**',
);

/** 变体 D：变体 C **再把上下文里的强词也换成弱词** ⇒ 四层都没有强词 ⇒ 这才是「真缺」。 */
const SYNTHETIC_WEAK_TIER_NO_CONTEXT = mustReplace(
  SYNTHETIC_WEAK_TIER_ONLY,
  '**冷盘档**的数',
  '上一轮的数',
);

/**
 * 一次审计里「**自带档位**」的处数。
 *
 * ⚠️ **为什么单独抽出来**：脚本的判定分两级 ⇒ 「真缺」与「提示」都不是「自带档位」
 *   ⇒ ⇒ 「自带档位」= 判定了 − 真缺 − 提示 ⇒ ⇒ **这是「档位限定还剩多少」的真正读数**。
 *
 * @param result 审计结果
 * @returns 自带档位的处数
 */
function selfQualifiedCount(result: {
  counts: { adjudicated: number; missing: number; advisories: number };
}): number {
  return result.counts.adjudicated - result.counts.missing - result.counts.advisories;
}

describe('档位限定一致性审计（scripts/audit-tier-qualifiers.mjs）', () => {
  it('★ 白名单自检：弱词不得进强词表（漂移守卫）', () => {
    const overlap = STRONG_TIER_WORDS.filter((word) => WEAK_TIER_WORDS.includes(word));
    expect(overlap).toEqual([]);
  });

  it('★ 白名单自检：那几个「只说明哪一次 / 比几个档位」的词必须留在弱词表里', () => {
    for (const weak of ['本次', '上一轮', '两档', '三档', '跨档']) {
      expect(WEAK_TIER_WORDS).toContain(weak);
      expect(STRONG_TIER_WORDS).not.toContain(weak);
    }
  });

  it('★ 白名单自检：`.d.mts` 的声明必须覆盖 `.mjs` 的每一个导出（防声明漂移）', () => {
    const impl = readFileSync(IMPL_PATH, 'utf8');
    const decl = readFileSync(DECL_PATH, 'utf8');
    const exported = [...impl.matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(decl).toContain(name);
    }
  });

  it('★ 弱词单独不成立、强词单独成立（词表语义的直接断言）', () => {
    expect(hasTier('本次')).toBe(false);
    expect(hasTier('上一轮')).toBe(false);
    expect(hasTier('两档')).toBe(false);
    expect(hasTier('跨档')).toBe(false);
    expect(hasTier('冷盘档')).toBe(true);
    expect(hasTier('百万级实测（本次 · 冷盘档）')).toBe(true);
  });

  it('正向：合成输入里档位齐全 ⇒ 没有真缺', () => {
    const result = auditTierQualifiers(SYNTHETIC_README.split('\n'));
    expect(result.counts.scanned).toBeGreaterThan(0);
    expect(result.counts.missing).toBe(0);
  });

  it('★ 反例：把强档位词换成弱指示词 ⇒ 该数必须从「自带档位」降级（弱词撑不起作用域）', () => {
    const before = auditTierQualifiers(SYNTHETIC_README.split('\n'));
    const after = auditTierQualifiers(SYNTHETIC_WEAK_TIER_ONLY.split('\n'));
    // ★ 核心性质：**自带档位的处数必须变少** ⇒ 弱词没有替强词撑住作用域。
    expect(selfQualifiedCount(after)).toBeLessThan(selfQualifiedCount(before));
    // ⇒ 且它必须落进「档位标得不够近」这一级（上下文仍有强词 ⇒ 按两级判定不打红）。
    expect(after.counts.advisories).toBeGreaterThan(before.counts.advisories);
  });

  it('★ 反例：弱指示词 + 上下文也没有强词 ⇒ 四层皆无 ⇒ 必须判红', () => {
    const result = auditTierQualifiers(SYNTHETIC_WEAK_TIER_NO_CONTEXT.split('\n'));
    expect(result.counts.missing).toBeGreaterThan(0);
  });

  it('★ 反例：四层的强档位词全删 ⇒ 必须判红', () => {
    const result = auditTierQualifiers(SYNTHETIC_NO_TIER_AT_ALL.split('\n'));
    expect(result.counts.missing).toBeGreaterThan(0);
  });

  it('★ 反例：只删本行与表头的档位限定、上下文仍在 ⇒ 判定必须变（守「档位标得不够近」这件事看得见）', () => {
    const before = auditTierQualifiers(SYNTHETIC_README.split('\n'));
    const after = auditTierQualifiers(SYNTHETIC_NO_LOCAL_TIER.split('\n'));
    expect(after.counts.missing).toBe(before.counts.missing);
    expect(after.counts.advisories).toBeGreaterThan(before.counts.advisories);
  });

  it('★ 反例：变异必须**真的生效**（否则上面几条断言全是空的）', () => {
    expect(SYNTHETIC_NO_LOCAL_TIER).not.toEqual(SYNTHETIC_README);
    expect(SYNTHETIC_NO_TIER_AT_ALL).not.toEqual(SYNTHETIC_NO_LOCAL_TIER);
    expect(SYNTHETIC_NO_TIER_AT_ALL).not.toContain('冷盘档');
    expect(SYNTHETIC_WEAK_TIER_ONLY).not.toEqual(SYNTHETIC_README);
    expect(SYNTHETIC_WEAK_TIER_NO_CONTEXT).not.toEqual(SYNTHETIC_WEAK_TIER_ONLY);
    expect(SYNTHETIC_WEAK_TIER_NO_CONTEXT).not.toContain('冷盘档');
  });

  it('幂等：同一输入两次 ⇒ 判定与渲染逐字相同', () => {
    const lines = SYNTHETIC_README.split('\n');
    const first = auditTierQualifiers(lines);
    const second = auditTierQualifiers(lines);
    expect(renderAudit('synthetic', first)).toBe(renderAudit('synthetic', second));
  });

  it('正向：仓库里真实的基线 README ⇒ 没有真缺（可复跑）', () => {
    const lines = readFileSync(README_PATH, 'utf8').split(/\r?\n/);
    const result = auditTierQualifiers(lines);
    expect(result.counts.scanned).toBeGreaterThan(0);
    expect(result.counts.missing).toBe(0);
  });
});
