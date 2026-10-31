/**
 * 纯函数算法模块的单测 —— DESIGN-v2.md §4.1 / §4.4 / §4.5 / §9.4.1，
 * 对应 DEVELOPMENT-PLAN.md **P1-T04**。
 *
 * ★ 本文件的断言纪律（沿用阶段 0 确立的口径）：
 *   · **每条硬断言配一条反例**：反例不是「换个输入再看一遍」，而是**故意写出那个会错的写法**，
 *     断言「它会错、而实现不会错」⇒ 证明断言**真能发现不一致**（否则断言只是装饰）。
 *   · **不写死「本次跑出来几条」**：性质类断言用**网格遍历**（输入数组 + 循环），
 *     加一个用例不会让断言失效，删一个也不会被掩盖。
 *   · **数值用例手算可复算**：期望值写成 `Math.exp(-1)` / `Math.log(20)` 这类
 *     **与公式同源的闭式表达式**，不写「跑出来是多少就是多少」的快照数字。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  type DecayEdgeInput,
  type DecayMemoryInput,
  MS_PER_DAY,
  type MemoryLayer,
  archiveAt,
  edgeWeight,
  effectiveStability,
  intensity,
  layerOf,
} from '../../src/core/decay.js';
import {
  type EntityDatabase,
  type EntityStatement,
  RESOLVE_ENTITY_BY_ALIAS_SQL,
  RESOLVE_ENTITY_BY_NAME_SQL,
  resolveEntity,
} from '../../src/core/entities.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';

/** 生效参数（默认表）。 */
const P: Params = DEFAULT_PARAMS;

/** 构造一个手算用的记忆输入（默认 τ = 1 天、`last_access = 0`）。 */
function memory(overrides: Partial<DecayMemoryInput> = {}): DecayMemoryInput {
  return { stability: 1, pin_factor: 1, last_access: 0, ...overrides };
}

/** 构造一个手算用的边输入（默认 weight = 1、`last_active = 0`）。 */
function edge(overrides: Partial<DecayEdgeInput> = {}): DecayEdgeInput {
  return { weight: 1, last_active: 0, ...overrides };
}

/** 天 → 毫秒。 */
const days = (n: number): number => n * MS_PER_DAY;

/**
 * 双精度下溢的边界：`exp(-x)` 在 `x ≳ 745` 时下溢为 **0**。
 *
 * ⚠️ 这不是公式的问题，是 IEEE-754 的问题：数学上 `intensity ∈ (0, 1]` 恒成立，
 *   但 `Δt/τ > 745` 时双精度只能表示成 0。
 *   ⇒ 断言「恒 ∈ (0,1]」时**必须**把这段区间排除，否则断言会在一个无害的下溢上假红；
 *     而「恒 ≤ 1」那半边**不受影响**，全部区间都要断言。
 */
const NO_UNDERFLOW_RATIO = 100;

// ─────────────────────────────────────────────────────────────
// effectiveStability
// ─────────────────────────────────────────────────────────────

describe('effectiveStability（§4.1）', () => {
  it('= stability × pin_factor（手算：1×1=1、30×1=30、180×5=900）', () => {
    expect(effectiveStability(memory({ stability: 1, pin_factor: 1 }))).toBe(1);
    expect(effectiveStability(memory({ stability: 30, pin_factor: 1 }))).toBe(30);
    expect(effectiveStability(memory({ stability: 180, pin_factor: 5 }))).toBe(900);
  });

  it('pin_factor 在**分母内**（拉长 τ ⇒ 衰减更慢），不是压低强度', () => {
    // τ 越大 ⇒ 同一 Δt 下 exp(-Δt/τ) 越接近 1 ⇒ intensity 越高。
    const base = memory({ stability: 10, pin_factor: 1, last_access: 0 });
    const pinned = memory({ stability: 10, pin_factor: 5, last_access: 0 });
    expect(effectiveStability(pinned)).toBeGreaterThan(effectiveStability(base));
    expect(intensity(pinned, days(5))).toBeGreaterThan(intensity(base, days(5)));
  });

  it('★ 反例：把 pin_factor 乘到分子上（τ = stability / pin_factor）会被这条断言抓住', () => {
    const m = memory({ stability: 10, pin_factor: 5 });
    const wrong = m.stability / m.pin_factor;
    expect(effectiveStability(m)).toBe(50); // 实现：10 × 5
    expect(wrong).toBe(2); // 错的实现：10 ÷ 5
    expect(effectiveStability(m)).not.toBe(wrong);
  });
});

// ─────────────────────────────────────────────────────────────
// intensity
// ─────────────────────────────────────────────────────────────

describe('intensity（§4.1）', () => {
  it('Δt = 0 ⇒ 1；Δt = 一个 τ ⇒ 1/e；Δt = τ×ln2 ⇒ 0.5', () => {
    const m = memory({ stability: 1, pin_factor: 1, last_access: 0 });
    expect(intensity(m, 0)).toBe(1);
    expect(intensity(m, days(1))).toBeCloseTo(Math.exp(-1), 12); // 1/e ≈ 0.36787944117144233
    // ★ 半衰期手算：t = τ × ln2 ⇒ exp(-ln2) = 0.5（τ=1 天 ⇒ 半衰期 ≈ 0.693 天 ≈ 16.6 小时）
    expect(intensity(m, days(Math.LN2))).toBeCloseTo(0.5, 12);
  });

  it('★ τ 是时间常数不是半衰期：t = τ 时是 1/e（≈0.368），**不是** 0.5', () => {
    const m = memory({ stability: 30, pin_factor: 1, last_access: 0 });
    expect(intensity(m, days(30))).toBeCloseTo(Math.exp(-1), 12);
    expect(intensity(m, days(30))).not.toBeCloseTo(0.5, 6);
    // 半衰期 = 30 × ln2 ≈ 20.79 天（§4.1 的量纲换算）
    expect(intensity(m, days(30 * Math.LN2))).toBeCloseTo(0.5, 12);
  });

  it('单调性：now 越大强度越低（且不反弹）', () => {
    const m = memory({ stability: 7, pin_factor: 1, last_access: 1000 });
    let previous = Number.POSITIVE_INFINITY;
    for (const offsetDays of [0, 1, 3, 7, 14, 30, 90, 180]) {
      const value = intensity(m, 1000 + days(offsetDays));
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('恒 ∈ [0, 1]：网格遍历（注入过去时刻也成立）；下溢区间内严格 > 0', () => {
    const stabilities = [0.5, 1, 7, 30, 180];
    const pinFactors = [1, 2, 3, 5];
    const offsetsDays = [-365, -30, -1, 0, 0.5, 1, 30, 365, 2696];

    for (const stability of stabilities) {
      for (const pinFactor of pinFactors) {
        for (const offsetDays of offsetsDays) {
          const value = intensity(memory({ stability, pin_factor: pinFactor }), days(offsetDays));
          // 上界：全区间成立（这是 §4.1 要求的两重防护里最要紧的一半）
          expect(value).toBeLessThanOrEqual(1);
          expect(value).toBeGreaterThanOrEqual(0);
          // 下界：只在不会下溢的区间里断言「严格 > 0」（见 NO_UNDERFLOW_RATIO 的说明）
          const ratio = offsetDays / (stability * pinFactor);
          if (ratio <= NO_UNDERFLOW_RATIO) {
            expect(value).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('★ 反例：漏掉 `max(0, Δt)` ⇒ 时钟回拨时 intensity 爆到 e^30（实现必须恒为 1）', () => {
    const m = memory({ stability: 1, pin_factor: 1, last_access: days(30) });
    const nowInThePast = 0; // 注入 / 回拨到 last_access 之前 30 天

    expect(intensity(m, nowInThePast)).toBe(1);

    // 漏掉钳制的写法：exp(+30) ≈ 1.07e13 ⇒ 直接污染 §4.6 的 0.30 × intensity 与层级判定
    const noDeltaClamp = Math.exp(-(nowInThePast - m.last_access) / days(1));
    expect(noDeltaClamp).toBeGreaterThan(1);
    expect(noDeltaClamp).toBeCloseTo(Math.exp(30), 6);
  });

  it('第二道 `min(1, ...)` 也在：τ 退化到极小时仍恒 ≤ 1（不出现 >1 的毛刺）', () => {
    // τ = 1e-9 天（≈ 0.0864 ms）：Δt = 0 ⇒ 0/τ = 0 ⇒ exp(0) = 1，仍被 min(1,·) 夹住。
    const degenerate = memory({ stability: 1e-9, pin_factor: 1, last_access: 0 });
    expect(intensity(degenerate, 0)).toBeLessThanOrEqual(1);
    expect(intensity(degenerate, 0)).toBe(1);
    expect(intensity(degenerate, days(1))).toBeLessThanOrEqual(1);
  });

  it('★ 反例：漏掉 `min(1, ...)` ⇒ 负的 τ 会让 intensity > 1（钳制必须真的在起作用）', () => {
    // ⚠️ 上一条用例是**真空负控**：删掉 `min(1, ...)` 它仍然通过
    //   （因为 `max(0, Δt)` 已保证 Δt ≥ 0 ⇒ exp(-Δt/τ) ≤ 1 ⇒ min 永远夹不到东西）
    //   ⇒ QA 复核 F-08 指出它「证明不了 min(1,…) 的存在」——**本条才是能抓住它的断言**。
    //
    // ⚠️ 为什么 `max(0, Δt)` 拦不住这一条：Δt 被钳到 0 了，但 **τ 为负**
    //   ⇒ -Δt/τ = -0/负 = **NaN 或 +∞** ⇒ exp(∞) = ∞ ⇒ min(1, ∞) 才是 1。
    //   没有 min(1,·) 时返回的就是 Infinity ⇒ 直接污染 §4.6 的 0.30 × intensity 与层级判定。
    const negativeTau = memory({ stability: -1, pin_factor: 1, last_access: 0 });
    const value = intensity(negativeTau, 0);

    // 性质：无论输入多离谱，intensity 恒 ∈ (0, 1]
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(1);

    // ★ 负控：漏掉 `min(1, ...)` 的写法会返回 Infinity ⇒ 上面两条会失败
    //   （Δt = max(0, 0 - 0) = 0；-0 / -1 = 0 ⇒ exp(0) = 1 本身不越界，
    //     故这里改用「τ 为负且 Δt 为正」的情形：-Δt/τ = 正数 ⇒ exp 正数 > 1）
    const negativeTauWithElapsed = memory({ stability: -1, pin_factor: 1, last_access: 0 });
    const elapsedMs = days(1);
    const withoutClamp = Math.exp(-elapsedMs / (negativeTauWithElapsed.stability * days(1)));
    expect(withoutClamp).toBeGreaterThan(1);
    // 而实现（带 min(1,·)）必须把它夹回 1
    expect(intensity(negativeTauWithElapsed, elapsedMs)).toBe(1);
  });

  it('★ 反例：漏掉 `max(0, Δt)` ⇒ τ<0 且 Δt<0 时会算出 exp(负数) ≈ 0.368（钳制必须真的在起作用）', () => {
    // ⚠️ 上一条只覆盖了「τ<0 且 Δt=0」与「τ<0 且 Δt>0」两格；
    //   这里补上**两个都为负**的那一格（now 早于 last_access ⇒ 时钟回拨）。
    //
    // ⚠️ **必须用越界输入（τ<0）是故意的**：生产域里 `stability` 恒 ≥ 0，
    //   而在生产域内两道钳制**互为冗余** ⇒ 根本不存在能区分它们的输入
    //   ⇒ 越界输入是这条探针的**必要条件**，不是「不严谨的取值」。
    //   （推导来自 engineer 的转交；数值取 1 天 ⇒ 负控值恰好是 exp(-1) ≈ 0.36787944117144233。）
    const negativeTau = memory({ stability: -1, pin_factor: 1, last_access: days(1) });
    const nowInThePast = 0; // Δt = 0 - 1 天 = -1 天 < 0

    const value = intensity(negativeTau, nowInThePast);

    // 性质：无论输入多离谱，intensity 恒有限且 ∈ (0, 1]
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(1);

    // ⚠️ 手算闭合：Δt 被 `max(0, ·)` 钳到 0 ⇒ -0 / (-1 天) = 0 ⇒ exp(0) = 1 ⇒ min(1, 1) = 1
    expect(value).toBe(1);

    // ★ 负控：若「Δt 下钳」被删 ⇒ Δt = -1 天 ⇒ -Δt/τ = -(-1 天) / (-1 天) = -1
    //   ⇒ exp(-1) ≈ 0.36787944117144233 ⇒ **不是** 1（且 `min(1, ·)` 夹不住它 —— 它在 1 以下）
    //   ⇒ 上面那条 `toBe(1)` 会失败 ⇒ 这条断言对「下钳在不在」有分辨力。
    const withoutDeltaClamp = Math.exp(-(nowInThePast - negativeTau.last_access) / days(-1));
    expect(withoutDeltaClamp).toBeCloseTo(Math.exp(-1), 12);
    expect(withoutDeltaClamp).not.toBe(1);
    expect(withoutDeltaClamp).toBeLessThan(1);
  });
});

// ─────────────────────────────────────────────────────────────
// layerOf
// ─────────────────────────────────────────────────────────────

describe('layerOf（§4.4）', () => {
  it('四段取值（默认阈值 0.7 / 0.3 / 0.05）', () => {
    expect(layerOf(1, P)).toBe('L3');
    expect(layerOf(0.9, P)).toBe('L3');
    expect(layerOf(0.3, P)).toBe('L1');
    expect(layerOf(0.1, P)).toBe('L1');
    expect(layerOf(0.05, P)).toBe('archived');
    expect(layerOf(0, P)).toBe('archived');
  });

  it('★ 边界是**严格大于**：恰好等于阈值时落进**更低**一层', () => {
    expect(layerOf(P.THRESHOLD_L3, P)).toBe('L2');
    expect(layerOf(P.THRESHOLD_L2, P)).toBe('L1');
    expect(layerOf(P.ARCHIVE_LINE, P)).toBe('archived');
  });

  it('层级随强度单调不降（网格遍历）', () => {
    const rank: Readonly<Record<MemoryLayer, number>> = { archived: 0, L1: 1, L2: 2, L3: 3 };
    const samples = [0, 0.01, 0.05, 0.0501, 0.1, 0.3, 0.3001, 0.5, 0.7, 0.7001, 0.9, 1];
    let previousRank = -1;
    for (const value of samples) {
      const currentRank = rank[layerOf(value, P)];
      expect(currentRank).toBeGreaterThanOrEqual(previousRank);
      previousRank = currentRank;
    }
  });

  it('阈值是**可调参数**：改参数表就改分层（证明 0.7/0.3/0.05 没被写死在函数里）', () => {
    const loose: Params = { ...P, THRESHOLD_L3: 0.2, THRESHOLD_L2: 0.1, ARCHIVE_LINE: 0.01 };
    expect(layerOf(0.5, P)).toBe('L2');
    expect(layerOf(0.5, loose)).toBe('L3');
    expect(layerOf(0.05, P)).toBe('archived');
    expect(layerOf(0.05, loose)).toBe('L1');
  });

  it('★ 反例：把 `>` 写成 `>=` 会在阈值点抬升一层，这条断言必须变红', () => {
    const wrongLayerOf = (value: number, params: Params): MemoryLayer => {
      if (value >= params.THRESHOLD_L3) return 'L3';
      if (value >= params.THRESHOLD_L2) return 'L2';
      if (value >= params.ARCHIVE_LINE) return 'L1';
      return 'archived';
    };
    expect(wrongLayerOf(P.THRESHOLD_L3, P)).toBe('L3'); // 错的实现：0.7 ⇒ L3
    expect(layerOf(P.THRESHOLD_L3, P)).toBe('L2'); // 实现：0.7 ⇒ L2
    expect(wrongLayerOf(P.ARCHIVE_LINE, P)).toBe('L1');
    expect(layerOf(P.ARCHIVE_LINE, P)).toBe('archived');
  });
});

// ─────────────────────────────────────────────────────────────
// edgeWeight
// ─────────────────────────────────────────────────────────────

describe('edgeWeight（§4.5）', () => {
  it('Δt = 0 ⇒ 原权重；Δt = 一个 τ（30 天）⇒ weight/e（对 weight 是线性的）', () => {
    const e = edge({ weight: 1, last_active: 0 });
    expect(edgeWeight(e, P, 0)).toBe(1);
    expect(edgeWeight(e, P, days(30))).toBeCloseTo(Math.exp(-1), 12);
    expect(edgeWeight(edge({ weight: 0.8 }), P, days(30))).toBeCloseTo(0.8 * Math.exp(-1), 12);
    // 半个 τ（15 天）⇒ exp(-0.5) ≈ 0.6065
    expect(edgeWeight(e, P, days(15))).toBeCloseTo(Math.exp(-0.5), 12);
  });

  it('★ EDGE_STABILITY=30 天是 τ：**实际半衰期 ≈ 20.8 天**（不是 15 天）', () => {
    const e = edge({ weight: 1, last_active: 0 });
    const halfLifeDays = P.EDGE_STABILITY * Math.LN2; // 30 × 0.6931 ≈ 20.79
    expect(halfLifeDays).toBeCloseTo(20.8, 1);
    expect(edgeWeight(e, P, days(halfLifeDays))).toBeCloseTo(0.5, 12);
  });

  it('时钟回拨不产生加成（Δt 被钳到 0 ⇒ 不高于原权重）', () => {
    const e = edge({ weight: 3, last_active: days(100) });
    expect(edgeWeight(e, P, 0)).toBe(3);
    expect(edgeWeight(e, P, 0)).toBeLessThanOrEqual(e.weight);
  });

  it('★ 反例：把 τ 当半衰期用（额外乘 ln2）会让衰减速率差 1/ln2 ≈ 1.44 倍', () => {
    const e = edge({ weight: 1, last_active: 0 });
    const correct = edgeWeight(e, P, days(30)); // exp(-1) ≈ 0.3679
    const wrong = e.weight * Math.exp((-Math.LN2 * days(30)) / days(P.EDGE_STABILITY)); // 0.5

    expect(correct).toBeCloseTo(Math.exp(-1), 12);
    expect(wrong).toBeCloseTo(0.5, 12);
    // §4.1 原话「衰减速率差 1.44 倍」：速率之比 = 1 / ln2 = log2(e)
    // ⚠️ 期望值写成闭式常量而不是手抄的 1.4427——手抄近似值本身就是一类漂移源。
    expect(1 / Math.LN2).toBeCloseTo(Math.LOG2E, 10);
    // 同一时刻两者取值明显不同 ⇒ 任何一处混用都会被抓住
    expect(correct).not.toBeCloseTo(wrong, 2);
  });
});

// ─────────────────────────────────────────────────────────────
// archiveAt
// ─────────────────────────────────────────────────────────────

describe('archiveAt（§9.4.1）', () => {
  it('= last_access + τ × ln(1/ARCHIVE_LINE) × 86400000（手算闭合）', () => {
    const m = memory({ stability: 1, pin_factor: 1, last_access: 1000 });
    const expected = 1000 + 1 * 1 * Math.log(1 / P.ARCHIVE_LINE) * MS_PER_DAY;
    expect(archiveAt(m, P)).toBe(expected);
    // ARCHIVE_LINE = 0.05 ⇒ ln(1/0.05) = ln(20) ≈ 2.9957 天
    expect((archiveAt(m, P) - 1000) / MS_PER_DAY).toBeCloseTo(Math.log(20), 12);
  });

  it('★ 自洽校验：archive_at 那一刻的强度**恰好**落在 ARCHIVE_LINE 上（ADR-18：公式是精确的）', () => {
    const stabilities = [1, 7, 30, 180];
    const pinFactors = [1, 2, 5];

    for (const stability of stabilities) {
      for (const pinFactor of pinFactors) {
        const m = memory({ stability, pin_factor: pinFactor, last_access: 1000 });
        const at = archiveAt(m, P);
        expect(intensity(m, at)).toBeCloseTo(P.ARCHIVE_LINE, 12);
        // 归档时刻：恰好在线上 ⇒ 判 archived；早 1ms：仍在线之上 ⇒ 判 L1
        expect(layerOf(intensity(m, at), P)).toBe('archived');
        expect(intensity(m, at - 1)).toBeGreaterThan(P.ARCHIVE_LINE);
        expect(layerOf(intensity(m, at - 1), P)).toBe('L1');
      }
    }
  });

  it('最远归档时刻 = 180×5×ln(20) 天 ⇒ 与 §4.6 的 @coarseCutoffPinned（2696 天）同源', () => {
    const m = memory({ stability: P.MAX_STABILITY, pin_factor: P.MAX_PIN_FACTOR, last_access: 0 });
    const daysOut = (archiveAt(m, P) - m.last_access) / MS_PER_DAY;
    // 精确值 900 × ln(20) = 2696.159… 天；设计稿记作「2696 天」（取整表述，§9.4.1 / §4.6）
    expect(daysOut).toBeCloseTo(900 * Math.log(20), 9);
    expect(Math.round(daysOut)).toBe(2696);
  });

  it('★ 反例：漏掉 pin_factor ⇒ 归档时刻早 5 倍（2696 → 539 天），这条断言必须变红', () => {
    const m = memory({ stability: P.MAX_STABILITY, pin_factor: P.MAX_PIN_FACTOR, last_access: 0 });
    const withoutPin = m.stability * Math.log(1 / P.ARCHIVE_LINE) * MS_PER_DAY;
    const withPin = archiveAt(m, P) - m.last_access;

    expect(withPin / withoutPin).toBeCloseTo(P.MAX_PIN_FACTOR, 12);
    expect(Math.round(withoutPin / MS_PER_DAY)).toBe(539); // 与 2696 差 5 倍
    expect(Math.round(withPin / MS_PER_DAY)).toBe(2696);
  });
});

// ─────────────────────────────────────────────────────────────
// resolveEntity（§4.5 末尾）
// ─────────────────────────────────────────────────────────────

/** 一次 `prepare().get()` 的调用记录。 */
interface StubCall {
  sql: string;
  params: unknown[];
}

/** 写语句的判定（用于「不写库」这条硬断言）。 */
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

/**
 * 建一个记下全部 SQL 的桩数据库。
 *
 * ⚠️ 用桩而不是真库来判「不写库」的理由：
 *   「调用前后行数不变」拦不住 `INSERT ... ON CONFLICT DO NOTHING`——
 *   它不改变任何行，但它**仍然是写库**（且会写 WAL、会占用自增序列）。
 *   ⇒ 这里断言得更严：**一条写语句都没发出**。
 */
function makeStub(options: {
  entities?: Readonly<Record<string, string>>;
  aliases?: Readonly<Record<string, string>>;
}): { db: EntityDatabase; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const db: EntityDatabase = {
    prepare(sql: string): EntityStatement {
      return {
        get(...params: unknown[]): unknown {
          calls.push({ sql, params });
          const name = String(params[0] ?? '');
          if (sql.includes('FROM entities')) {
            const id = options.entities?.[name];
            return id === undefined ? undefined : { id };
          }
          if (sql.includes('FROM entity_aliases')) {
            const entityId = options.aliases?.[name];
            return entityId === undefined ? undefined : { entity_id: entityId };
          }
          return undefined;
        },
      };
    },
  };
  return { db, calls };
}

describe('resolveEntity（§4.5）', () => {
  it('① 主名命中 ⇒ 返回该实体的 id', () => {
    const { db } = makeStub({ entities: { 张三: 'e1' } });
    expect(resolveEntity(db, '张三')).toBe('e1');
  });

  it('② 别名命中 ⇒ 返回 entity_id', () => {
    const { db } = makeStub({ aliases: { 老张: 'e1' } });
    expect(resolveEntity(db, '老张')).toBe('e1');
  });

  it('① 优先于 ②：一个名字同时是 A 的主名和 B 的别名 ⇒ 返回**主名**那个', () => {
    const { db } = makeStub({ entities: { 老张: 'e2' }, aliases: { 老张: 'e1' } });
    expect(resolveEntity(db, '老张')).toBe('e2');
  });

  it('③ 均未命中 ⇒ 返回 null（不建实体、不抛错）', () => {
    const { db, calls } = makeStub({ entities: { 张三: 'e1' } });
    expect(resolveEntity(db, '李四')).toBeNull();
    expect(() => resolveEntity(db, '李四')).not.toThrow();
    expect(calls.filter((call) => WRITE_SQL.test(call.sql))).toHaveLength(0);
  });

  it('★ 「不写库」：命中与未命中两条路径都只发 SELECT（比「行数不变」更强）', () => {
    const hit = makeStub({ entities: { 张三: 'e1' } });
    resolveEntity(hit.db, '张三');
    const miss = makeStub({ entities: { 张三: 'e1' } });
    resolveEntity(miss.db, '李四');

    for (const calls of [hit.calls, miss.calls]) {
      expect(calls.filter((call) => WRITE_SQL.test(call.sql))).toHaveLength(0);
      for (const call of calls) {
        expect(call.sql.toUpperCase().startsWith('SELECT')).toBe(true);
      }
    }
  });

  it('★ 反例：一个「未命中就建实体」的实现会发出 INSERT —— 断言必须能把它抓出来', () => {
    const badCalls: StubCall[] = [];
    const bad: EntityDatabase = {
      prepare(sql: string): EntityStatement {
        return {
          get(...params: unknown[]): unknown {
            badCalls.push({ sql, params });
            // 桩把 INSERT 也算作「成功返回一行」
            return WRITE_SQL.test(sql) ? { id: 'e-new' } : undefined;
          },
        };
      },
    };
    const badResolve = (db: EntityDatabase, name: string): string | null => {
      const found = db.prepare(RESOLVE_ENTITY_BY_NAME_SQL).get(name) as { id?: string } | undefined;
      if (found?.id !== undefined) {
        return found.id;
      }
      const created = db.prepare('INSERT INTO entities (name) VALUES (?)').get(name) as {
        id?: string;
      };
      return created.id ?? null;
    };

    // 错的实现「成功」了，但它写了库
    expect(badResolve(bad, '李四')).toBe('e-new');
    expect(badCalls.filter((call) => WRITE_SQL.test(call.sql)).length).toBeGreaterThan(0);

    // 正确的实现在同一输入下：null + 零写入
    const good = makeStub({});
    expect(resolveEntity(good.db, '李四')).toBeNull();
    expect(good.calls.filter((call) => WRITE_SQL.test(call.sql))).toHaveLength(0);
  });

  it('两条 SQL 的形状与 §4.5 原文一致（列名写错会被这条抓住）', () => {
    expect(RESOLVE_ENTITY_BY_NAME_SQL).toBe('SELECT id FROM entities WHERE name = ?');
    expect(RESOLVE_ENTITY_BY_ALIAS_SQL).toBe(
      'SELECT entity_id FROM entity_aliases WHERE alias = ?',
    );
  });

  it('真实 better-sqlite3 的 Database 在结构上满足 EntityDatabase（类型层 + 运行层）', () => {
    // ⚠️ 这条断言保证「最小结构接口」不是自嗨：真库必须能直接传进来。
    const db: EntityDatabase = new Database(':memory:');
    expect(typeof db.prepare).toBe('function');
  });

  it('端到端（真 SQLite 最小夹具）：主名 / 别名 / 未命中 / 行数不变', () => {
    // ⚠️ **最小测试夹具，不是 §3 的建库脚本**——只建 `resolveEntity` 要用到的两张表的两张皮。
    //    权威 DDL 是 P1-T01 的 `schema/001_schema_v2.sql`，这里刻意不复刻它。
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE entity_aliases (alias TEXT PRIMARY KEY, entity_id TEXT NOT NULL);
      INSERT INTO entities (id, name) VALUES ('e1', '张三'), ('e2', '李四');
      INSERT INTO entity_aliases (alias, entity_id) VALUES ('老张', 'e1');
    `);

    const countRows = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    const before = countRows();

    expect(resolveEntity(db, '张三')).toBe('e1');
    expect(resolveEntity(db, '李四')).toBe('e2');
    expect(resolveEntity(db, '老张')).toBe('e1');
    expect(resolveEntity(db, '不存在的人')).toBeNull();

    expect(countRows()).toBe(before);
  });
});
