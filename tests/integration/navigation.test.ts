/**
 * ★ 交互层纯函数的单测 —— 阶段 5 · T04 补遗（面板 5/6/7 的可用性缺口）。
 *
 * ⚠️ ★ **为什么这些断言必须存在**：本仓库的测试环境是 `environment: 'node'` +
 *   `pool: 'forks'`（better-sqlite3 的硬要求，不能改），**没有 DOM**
 *   ⇒ `onClick` 点下去会发生什么，`renderToStaticMarkup` **测不到**。
 *   把「点下去算出的新页码 / 新查询 / 新累积列表」抽成纯函数，就在这里逐值断言。
 *
 * ⚠️ **每条正向断言都配一条反例**，且反例都是「实现写错时会红」的那种：
 *   到边界再点必须**不越界**、`total=0` 的 `maxPage` 必须是 **0 而不是 -1**、
 *   `appendPage` 到 cap 之后必须返回**同一引用**（这才是「没有多余渲染」的可测形式）。
 */

import { describe, expect, it } from 'vitest';

import {
  appendPage,
  buildLogQuery,
  maxPage,
  nextPage,
  overlapRatio,
  prevPage,
} from '../../viewer/renderer/state/navigation.js';
import { LOG_PAGE_SIZE } from '../../viewer/shared/protocol.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、buildLogQuery：三级选择 + 页码 → LogQuery（归一化，不抛错）
// ═══════════════════════════════════════════════════════════════════════════

describe('导航纯函数 · `buildLogQuery` 正向', () => {
  it('完整的年 / 月 / 日 + 关键字 + 页码 ⇒ 逐字段正确', () => {
    const query = buildLogQuery({ year: 2024, month: 3, day: 31, keyword: ' 召回 ' }, 2, 50);
    expect(query).toEqual({
      year: 2024,
      month: 3,
      day: 31,
      keyword: '召回',
      limit: 50,
      offset: 100,
    });
  });

  it('页大小缺省是 `LOG_PAGE_SIZE`（不是写死的 50 / 200 第二份）', () => {
    const query = buildLogQuery({ year: 2024, month: 1 }, 1);
    expect(query.limit).toBe(LOG_PAGE_SIZE);
    expect(query.offset).toBe(LOG_PAGE_SIZE);
  });

  it('`day` 缺省 ⇒ **整月**（键都不出现，而不是 `day: undefined`）', () => {
    const query = buildLogQuery({ year: 2024, month: 5 }, 0, 50);
    expect('day' in query).toBe(false);
    expect(query.day).toBeUndefined();
  });
});

describe('导航纯函数 · `buildLogQuery` 反例（非法输入一律归一，绝不抛错）', () => {
  it('★ `month` 缺省 ⇒ 归一成 `1`（`LogQuery.month` 必填，不能用 undefined 表达「整年」）', () => {
    const query = buildLogQuery({ year: 2024 }, 0, 50);
    expect(query.month).toBe(1);
    expect(query.month).not.toBeUndefined();
    // 判别力：它**不能**是 NaN 或 0（两者都会让库侧拼出不存在的目录）
    expect(Number.isInteger(query.month)).toBe(true);
    expect(query.month).toBeGreaterThanOrEqual(1);
  });

  it('★ `month` 越界（`0` / `13` / `NaN`）⇒ 归一成 `1`，而不是抛错或原样传下去', () => {
    expect(buildLogQuery({ year: 2024, month: 0 }, 0, 50).month).toBe(1);
    expect(buildLogQuery({ year: 2024, month: 13 }, 0, 50).month).toBe(1);
    expect(buildLogQuery({ year: 2024, month: Number.NaN }, 0, 50).month).toBe(1);
  });

  it('★ `day` 越界（`0` / `32` / `NaN`）⇒ 丢掉 day（整月），不是夹到 1 或 31', () => {
    for (const day of [0, 32, Number.NaN]) {
      const query = buildLogQuery({ year: 2024, month: 2, day }, 0, 50);
      expect('day' in query, `day=${String(day)} 不该出现`).toBe(false);
    }
  });

  it('`year` 越界 ⇒ 夹到 `[1970, 9999]`；非有限 ⇒ 落回 1970', () => {
    expect(buildLogQuery({ year: 1900 }, 0, 50).year).toBe(1970);
    expect(buildLogQuery({ year: 99999 }, 0, 50).year).toBe(9999);
    expect(buildLogQuery({ year: Number.NaN }, 0, 50).year).toBe(1970);
  });

  it('`keyword` 只有空白 ⇒ **不传该键**（不是传空串）', () => {
    expect('keyword' in buildLogQuery({ year: 2024, keyword: '   ' }, 0, 50)).toBe(false);
  });

  it('负页码 ⇒ `offset` 夹到 0（负 `OFFSET` 在 SQLite 里是**静默**当 0，不能靠它兜底）', () => {
    expect(buildLogQuery({ year: 2024, month: 1 }, -3, 50).offset).toBe(0);
  });

  it('`pageSize = 0` ⇒ 夹到 1（除零会让 `offset` 变 NaN）', () => {
    const query = buildLogQuery({ year: 2024, month: 1 }, 2, 0);
    expect(query.limit).toBe(1);
    expect(Number.isFinite(query.offset)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、maxPage / nextPage / prevPage：夹紧，不越界
// ═══════════════════════════════════════════════════════════════════════════

describe('导航纯函数 · 页号算式在边界上不越界', () => {
  it('★ `total = 0` ⇒ `maxPage` 是 **0**（不是 -1）', () => {
    expect(maxPage(0, 50)).toBe(0);
    expect(maxPage(0, 50)).not.toBe(-1);
  });

  it('整除 / 不整除两种最后一页', () => {
    expect(maxPage(50, 50)).toBe(0);
    expect(maxPage(51, 50)).toBe(1);
    expect(maxPage(100, 50)).toBe(1);
    expect(maxPage(137, 50)).toBe(2);
  });

  it('负 total / NaN total ⇒ 0（不产生负数页号）', () => {
    expect(maxPage(-5, 50)).toBe(0);
    expect(maxPage(Number.NaN, 50)).toBe(0);
  });

  it('★ 到最后一页再 `nextPage` ⇒ **返回同一页号**（不是 max+1、不是 NaN）', () => {
    const last = maxPage(137, 50);
    expect(nextPage(last, 137, 50)).toBe(last);
    expect(nextPage(last, 137, 50)).not.toBe(last + 1);
  });

  it('★ 在第 0 页 `prevPage` ⇒ 仍是 0（不是 -1）', () => {
    expect(prevPage(0, 137, 50)).toBe(0);
    expect(prevPage(-4, 137, 50)).toBe(0);
  });

  it('中间页的两个方向都 +1 / −1', () => {
    expect(nextPage(0, 137, 50)).toBe(1);
    expect(prevPage(1, 137, 50)).toBe(0);
  });

  it('★ 越界页号先被夹紧：`nextPage(99, 137, 50)` ⇒ 停在最后一页（2）', () => {
    expect(nextPage(99, 137, 50)).toBe(2);
  });

  it('空结果集上的两向都不动（第 1 页 = 第 0 页）', () => {
    expect(nextPage(0, 0, 50)).toBe(0);
    expect(prevPage(0, 0, 50)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、appendPage：累积加载（到 cap 之后不再增长，且返回同一引用）
// ═══════════════════════════════════════════════════════════════════════════

describe('导航纯函数 · `appendPage` 累积加载', () => {
  it('正向：把新一页追加到尾部（**顺序保留**：先加载的在前面 = 更新的版本）', () => {
    expect(appendPage(['a', 'b'], ['c', 'd'], 10)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('恰好填满 cap ⇒ 内容正确且长度 == cap', () => {
    expect(appendPage(['a', 'b'], ['c'], 3)).toEqual(['a', 'b', 'c']);
  });

  it('超过 cap ⇒ 从**尾部**截断（保留先加载的那些）', () => {
    expect(appendPage(['a', 'b'], ['c', 'd', 'e'], 3)).toEqual(['a', 'b', 'c']);
  });

  it('★ 已加载数达到 cap ⇒ 返回**同一引用**（`toBe`，不是 `toEqual`）', () => {
    const loaded = ['a', 'b', 'c'];
    expect(appendPage(loaded, ['d'], 3)).toBe(loaded);
  });

  it('★ 新到的一页为空 ⇒ 返回**同一引用**（空结果不该触发重渲染）', () => {
    const loaded = ['a'];
    expect(appendPage(loaded, [], 10)).toBe(loaded);
  });

  it('反例：`cap = 0` 时**永远**返回同一引用（空列表也有「第 1 页」，但不能塞东西）', () => {
    const empty: readonly string[] = [];
    expect(appendPage(empty, ['a'], 0)).toBe(empty);
  });

  it('反例：真正追加时必须返回**新数组**（否则 React 看不到变化）', () => {
    const loaded = ['a'];
    const next = appendPage(loaded, ['b'], 10);
    expect(next).not.toBe(loaded);
    expect(next).toEqual(['a', 'b']);
    // 不改入参（只读视图）
    expect(loaded).toEqual(['a']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、overlapRatio：成员重叠度（不是 key 比对）
// ═══════════════════════════════════════════════════════════════════════════

describe('导航纯函数 · `overlapRatio` 用成员集合，不用簇的 key', () => {
  it('完全相同 ⇒ 1', () => {
    expect(overlapRatio(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('完全无关 ⇒ 0', () => {
    expect(overlapRatio(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('★ 任一侧为空 ⇒ 0（不是 NaN、不是 1）', () => {
    expect(overlapRatio([], ['a'])).toBe(0);
    expect(overlapRatio(['a'], [])).toBe(0);
    expect(overlapRatio([], [])).toBe(0);
  });

  it('★ 包含关系（簇长大）⇒ 1（按**较小集合**归一，用并集会算成 0.33）', () => {
    expect(overlapRatio(['a'], ['a', 'b', 'c'])).toBe(1);
    expect(overlapRatio(['a', 'b', 'c'], ['a'])).toBe(1);
  });

  it('部分重叠 ⇒ 交 / 较小集合大小', () => {
    expect(overlapRatio(['a', 'b', 'c', 'd'], ['a', 'b'])).toBe(1);
    expect(overlapRatio(['a', 'b'], ['a', 'x'])).toBe(0.5);
    expect(overlapRatio(['a', 'b', 'c'], ['a', 'x', 'y'])).toBeCloseTo(1 / 3, 10);
  });

  it('顺序无关（集合语义）', () => {
    expect(overlapRatio(['a', 'b'], ['b', 'a'])).toBe(1);
  });

  it('★ 反例：成员变了但「key 相同」⇒ 重叠度 != 1（key 相同不能推出同一个簇）', () => {
    // 两次快照里同一个 key（= 簇内最小成员 id 都是 'm-1'），但成员集合不同
    const before = ['m-1', 'm-2'];
    const after = ['m-1', 'm-7'];
    expect(overlapRatio(before, after)).toBe(0.5);
    expect(overlapRatio(before, after)).not.toBe(1);
  });
});
