/**
 * 稳定度增长（§4.2）的单测 —— 对应 DEVELOPMENT-PLAN.md **P1-T06** 的**纯计算部分**。
 *
 * ★ 断言纪律（与 P1-T04 / P1-T05 同一套）：
 *   · **每条断言配一条反例**：故意写出那个会错的写法，断言它确实会错、而实现不会错；
 *   · **不写死「本次跑出来几条」**：性质类断言用网格遍历；
 *   · **数值用例手算可复算**：1×1.75×1 = 1.75、min(180, 170×1.75×2) = 180 这类。
 *
 * ⚠️ 本文件只测**纯计算**。`src/store/touch.ts`（真正执行 SQL + 事务 + 记事件的那层）
 *   落地后另有一组端到端断言；那里的硬断言见本文件末尾的静态扫描用例。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import {
  type StabilityInput,
  computeStabilityGrowth,
  difficultyBonus,
  spacingFactor,
} from '../../src/core/stability.js';

/** 生效参数（默认表）。 */
const P: Params = DEFAULT_PARAMS;

/** 天 → 毫秒。 */
const days = (n: number): number => n * MS_PER_DAY;

/** 构造一条手算用的记忆状态。 */
function memory(overrides: Partial<StabilityInput> = {}): StabilityInput {
  return { stability: 1, last_access: 0, access_count: 0, difficulty: 0.5, ...overrides };
}

// ─────────────────────────────────────────────────────────────
// difficultyBonus
// ─────────────────────────────────────────────────────────────

describe('difficultyBonus（§4.2）', () => {
  it('= DIFFICULTY_BASE + DIFFICULTY_SCALE × (1 - difficulty)（手算）', () => {
    expect(difficultyBonus(0.5, P)).toBeCloseTo(1.75, 12); // 1.5 + 0.5×0.5
    expect(difficultyBonus(0.3, P)).toBeCloseTo(1.85, 12); // 1.5 + 0.5×0.7（首因 0.3）
    expect(difficultyBonus(1, P)).toBeCloseTo(1.5, 12); // 最难：无加成
    expect(difficultyBonus(0, P)).toBeCloseTo(2.0, 12); // 最易
  });

  it('难度越低加成越大（单调）', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const difficulty of [1, 0.8, 0.5, 0.3, 0]) {
      const bonus = difficultyBonus(difficulty, P);
      expect(bonus).toBeGreaterThan(previous);
      previous = bonus;
    }
  });

  it('★ 反例：难度加成在**循环外**算一次再复用 ⇒ 整批套同一个倍率', () => {
    // 两条难度不同的记忆：各自的加成必须不同。
    const easy = difficultyBonus(0.3, P);
    const normal = difficultyBonus(0.5, P);
    expect(easy).not.toBeCloseTo(normal, 6);

    // 错的实现：拿第一条的倍率给整批用 ⇒ 第二条被套上别人的倍率，且**结果仍像正常值**。
    const shared = difficultyBonus(0.3, P);
    const wrongForNormal = 1 * shared * 1;
    const correctForNormal = 1 * normal * 1;
    expect(wrongForNormal).not.toBeCloseTo(correctForNormal, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// spacingFactor
// ─────────────────────────────────────────────────────────────

describe('spacingFactor（§4.2）', () => {
  it('useSpacing = true：min(SPACING_CAP, 1 + log2(intervalDays))（手算）', () => {
    expect(spacingFactor(1, true, P)).toBeCloseTo(1, 12); // 1 + log2(1) = 1
    expect(spacingFactor(2, true, P)).toBeCloseTo(2, 12); // 1 + log2(2) = 2
    expect(spacingFactor(4, true, P)).toBe(P.SPACING_CAP); // 1 + 2 = 3 ⇒ 封顶 2.0
    expect(spacingFactor(1.5, true, P)).toBeCloseTo(1 + Math.log2(1.5), 12);
  });

  it('useSpacing = false（**合并路径**）恒为 1 ⇒ 不拿间隔加成', () => {
    for (const intervalDays of [1, 2, 4, 30]) {
      expect(spacingFactor(intervalDays, false, P)).toBe(1);
    }
    // 与 touch 路径明显不同
    expect(spacingFactor(2, false, P)).not.toBe(spacingFactor(2, true, P));
  });

  it('★ 反例：对负数取 log2 ⇒ NaN，会静默污染 stability（所以 intervalDays 必须先钳 0）', () => {
    expect(Math.log2(-1)).toBeNaN();
    expect(spacingFactor(-1, true, P)).toBeNaN();
    // 实现侧：`computeStabilityGrowth` 里 intervalDays 已经 max(0, ·)，
    // 且 < 1.0 时根本不进增长分支 ⇒ 永远不会把 NaN 传进来。
  });
});

// ─────────────────────────────────────────────────────────────
// computeStabilityGrowth
// ─────────────────────────────────────────────────────────────

describe('computeStabilityGrowth（§4.2 三个约束）', () => {
  it('增长是**乘性**的：min(MAX, stability × baseGrowth × spacing)', () => {
    // intervalDays = 1 ⇒ spacing = 1 ⇒ 1 × 1.75 × 1 = 1.75
    const r1 = computeStabilityGrowth(memory(), 1.75, true, P, days(1));
    expect(r1.stability).toBeCloseTo(1.75, 12);
    expect(r1.stabilityDelta).toBeCloseTo(0.75, 12);
    expect(r1.boosted).toBe(true);

    // intervalDays = 2 ⇒ spacing = 2 ⇒ 1 × 1.75 × 2 = 3.5
    const r2 = computeStabilityGrowth(memory(), 1.75, true, P, days(2));
    expect(r2.stability).toBeCloseTo(3.5, 12);
    expect(r2.stabilityDelta).toBeCloseTo(2.5, 12);
  });

  it('① 同日守卫：intervalDays < 1.0 ⇒ 不增长，但 access_count +1 / last_access 更新 / delta = 0 且**键在**', () => {
    const first = computeStabilityGrowth(memory({ stability: 1 }), 1.75, true, P, days(0.5));
    expect(first.intervalDays).toBeCloseTo(0.5, 12);
    expect(first.stability).toBe(1);
    expect(first.boosted).toBe(false);
    expect(first.stabilityDelta).toBe(0);
    expect('stabilityDelta' in first).toBe(true); // ★ 键恒在
    expect(first.access_count).toBe(1);
    expect(first.last_access).toBe(days(0.5));

    // 第二次 touch（同一天、last_access 已被上次刷成同一个 now）⇒ 仍不增长
    const second = computeStabilityGrowth(
      memory({ stability: 1, last_access: days(0.5), access_count: 1 }),
      1.75,
      true,
      P,
      days(0.5),
    );
    expect(second.stability).toBe(1);
    expect(second.boosted).toBe(false);
    expect(second.stabilityDelta).toBe(0);
    expect(second.access_count).toBe(2);
  });

  it('① 边界：0.999 天不涨，1.0 天涨（守卫是 `>= 1.0`）', () => {
    const below = computeStabilityGrowth(memory(), 1.75, true, P, days(0.999));
    expect(below.boosted).toBe(false);
    const at = computeStabilityGrowth(memory(), 1.75, true, P, days(1));
    expect(at.boosted).toBe(true);
  });

  it('② MAX_STABILITY 钳制：170 × 1.75 × 2 = 595 ⇒ 180', () => {
    const r = computeStabilityGrowth(
      memory({ stability: 170, last_access: 0 }),
      1.75,
      true,
      P,
      days(2),
    );
    expect(r.stability).toBe(P.MAX_STABILITY);
    expect(r.stabilityDelta).toBeCloseTo(10, 12);
  });

  it('② 已在上限时：仍走钳制，delta = 0、boosted = false、键在', () => {
    const r = computeStabilityGrowth(
      memory({ stability: P.MAX_STABILITY, last_access: 0 }),
      1.75,
      true,
      P,
      days(30),
    );
    expect(r.stability).toBe(P.MAX_STABILITY);
    expect(r.stabilityDelta).toBe(0);
    expect(r.boosted).toBe(false);
    expect('stabilityDelta' in r).toBe(true);
  });

  it('③ 合并路径（useSpacing=false）不拿间隔加成', () => {
    const touchLike = computeStabilityGrowth(memory(), P.DEDUP_BOOST, true, P, days(4));
    const mergeLike = computeStabilityGrowth(memory(), P.DEDUP_BOOST, false, P, days(4));
    expect(mergeLike.stability).toBeCloseTo(1 * P.DEDUP_BOOST * 1, 12);
    expect(touchLike.stability).toBeGreaterThan(mergeLike.stability);
  });

  it('恒不越过 MAX_STABILITY、delta 恒非负、boosted 与 delta 一致（网格遍历）', () => {
    const stabilities = [1, 7, 30, 179, 180];
    const baseGrowths = [1, 1.3, 1.75, 2];
    const offsetsDays = [-30, 0, 0.5, 1, 2, 4, 30, 3650];

    for (const stability of stabilities) {
      for (const baseGrowth of baseGrowths) {
        for (const useSpacing of [true, false]) {
          for (const offsetDays of offsetsDays) {
            const r = computeStabilityGrowth(
              memory({ stability }),
              baseGrowth,
              useSpacing,
              P,
              days(offsetDays),
            );
            expect(r.stability).toBeLessThanOrEqual(P.MAX_STABILITY);
            expect(r.stability).toBeGreaterThan(0);
            expect(Number.isNaN(r.stability)).toBe(false);
            expect(r.stabilityDelta).toBeGreaterThanOrEqual(0);
            expect(r.boosted).toBe(r.stabilityDelta > 0);
            expect(r.access_count).toBe(1);
            expect(r.last_access).toBe(days(offsetDays));
          }
        }
      }
    }
  });

  it('★ 反例：漏掉 `max(0, Δt)` ⇒ 时钟回拨时 stability 变成 NaN（实现必须原样不动）', () => {
    const m = memory({ stability: 1, last_access: days(30) });
    const nowInThePast = 0;

    const r = computeStabilityGrowth(m, 1.75, true, P, nowInThePast);
    expect(r.intervalDays).toBe(0); // 被钳住
    expect(Number.isNaN(r.stability)).toBe(false);
    expect(r.stability).toBe(1);

    // 错的实现：直接用负值 ⇒ log2(负) = NaN ⇒ 一连串 NaN，且**不报错**
    const wrongInterval = (nowInThePast - m.last_access) / MS_PER_DAY;
    const wrongSpacing = Math.min(P.SPACING_CAP, 1 + Math.log2(wrongInterval));
    expect(wrongInterval).toBeLessThan(0);
    expect(wrongSpacing).toBeNaN();
  });

  it('★ 反例：把乘性写成加性（`stability + baseGrowth × spacing`）⇒ 数值完全不同', () => {
    const m = memory({ stability: 1 });
    const r = computeStabilityGrowth(m, 1.75, true, P, days(2));
    const wrong = Math.min(P.MAX_STABILITY, 1 + 1.75 * 2); // 4.5
    expect(r.stability).toBeCloseTo(3.5, 12);
    expect(wrong).toBeCloseTo(4.5, 12);
    expect(r.stability).not.toBeCloseTo(wrong, 6);
  });

  it('★ 反例：漏掉 MAX_STABILITY ⇒ 170 × 1.75 × 2 = 595 越过上限（绕过上限的后门）', () => {
    const r = computeStabilityGrowth(memory({ stability: 170 }), 1.75, true, P, days(2));
    const withoutClamp = 170 * 1.75 * 2;
    expect(withoutClamp).toBeGreaterThan(P.MAX_STABILITY);
    expect(r.stability).toBe(P.MAX_STABILITY);
  });

  it('★ 反例：用 `boosted` 反推 delta 会丢信息（两条 delta 不同的记忆都是 true）', () => {
    const a = computeStabilityGrowth(memory(), 1.75, true, P, days(1)); // delta 0.75
    const b = computeStabilityGrowth(memory(), 1.75, true, P, days(2)); // delta 2.5
    expect(a.boosted).toBe(true);
    expect(b.boosted).toBe(true);
    expect(a.stabilityDelta).not.toBeCloseTo(b.stabilityDelta, 6);
    // ⇒ 事件里必须记 stabilityDelta 本身，不能指望重放时用 boosted 反推。
  });
});

// ─────────────────────────────────────────────────────────────
// 「全库唯一的 stability 写入点」（§4.2 的收拢纪律）
// ─────────────────────────────────────────────────────────────

/** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 仓库的 `src/` 目录。 */
const SRC_ROOT = resolve(HERE, '../../src');

/** 递归列出目录下的 `.ts` 实现文件（排除测试与声明）。 */
function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('§4.2 收拢纪律：stability 的写入点', () => {
  /** ★ 写死的期望：允许写 `memories.stability` 的**函数**只有一个（P1-T06 的 growStability）。 */
  const EXPECTED_STABILITY_WRITE_OWNER = 'growStability';

  it('纯计算层**不写库**（src/core 下不得出现任何 UPDATE）', () => {
    const root = resolve(SRC_ROOT, 'core');
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const rawLine of source.split('\n')) {
        // ⚠️ 同上：注释里的 `UPDATE ... SET` 是说明文字，不是写入点。
        const line = rawLine.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
          continue;
        }
        expect(rawLine).not.toMatch(/UPDATE\s+\w+\s+SET/i);
      }
    }
  });

  it('★ 全仓 `UPDATE ... stability` 的出现次数 ≤ 1，且（一旦出现）必须只在 growStability 内', () => {
    // ⚠️ 这条断言现在是「≤ 1」（store 层尚未落地 ⇒ 实际为 0），
    //    `src/store/touch.ts` 落地后会变成恰好 1；届时若有人在第二处写 stability ⇒ 立刻变红。
    //    之所以现在就立这条闸门：它防的正是 §4.2 记的三次事故（后门 / 绕过守卫 / 语义不一致）。
    const root = SRC_ROOT;
    const hits: { file: string; line: number }[] = [];

    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      lines.forEach((rawLine, index) => {
        // ⚠️ **注释必须先剥掉**：正文与代码注释里大量出现这条 SQL 的字面量
        //   （例如「`UPDATE memories SET stability` 只出现一次」这句话本身），
        //   不剥注释的话扫描器会把**说明文字**当成写入点 ⇒ 误报满天飞，闸门就废了。
        //   （与 `scripts/check-clock.ts` 剥注释同一条理由。）
        const line = rawLine.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
          return;
        }
        if (/UPDATE\s+memories\s+SET\s+stability/i.test(rawLine)) {
          hits.push({
            file: relative(root, file).split(sep).join('/'),
            line: index + 1,
          });
        }
      });
    }

    expect(hits.length).toBeLessThanOrEqual(1);
    for (const hit of hits) {
      // 一旦出现，它必须位于 P1-T06 的 store 层文件、且由 growStability 发出。
      expect(hit.file).toBe('store/touch.ts');
      const source = readFileSync(join(root, 'store', 'touch.ts'), 'utf8');
      const ownerIndex = source.indexOf(`function ${EXPECTED_STABILITY_WRITE_OWNER}`);
      expect(ownerIndex).toBeGreaterThanOrEqual(0);
      const writeIndex = source.indexOf('UPDATE memories SET stability');
      expect(writeIndex).toBeGreaterThan(ownerIndex);
    }
  });
});
