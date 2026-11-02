/**
 * ★ 查看器的**交互层纯逻辑** —— 阶段 5 · T04 补遗（设计 §7.2 面板 5/6/7 的可用性缺口）。
 *
 * ⚠️ ★ **为什么这些算式要从组件里抽出来**：
 *   本仓库**没有 DOM 测试环境**（`vitest.config.ts` 锁死 `environment: 'node'` +
 *   `pool: 'forks'`，那是 better-sqlite3 的硬要求，不能为测试改）⇒ 组件里的
 *   `onClick` 只能靠 `renderToStaticMarkup` 看到「按钮在不在」，
 *   点下去会发生什么**测不到**。
 *   ⇒ 把「点下去算出的新页码 / 新查询」抽成纯函数，就能在 node 里逐值断言；
 *     组件只负责把回调接到这些函数上（那部分由源码扫描断言「必须调用它们」）。
 *   ⚠️ 这条正是「静态渲染的断言不够」的落点：按钮在场 ≠ 按钮有用。
 *
 * ⚠️ 本文件**零依赖**（不 import React、不 import `viewer/main/**`、不读时钟）
 *   ⇒ 可以单测、可以在任何进程里跑。
 */

import { LOG_PAGE_SIZE } from '../../shared/protocol.js';
import type { LogQuery } from '../../shared/protocol.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、面板 5：年 / 月 / 日三级选择 → LogQuery
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 面板 5 的三级选择（**月份可以被清空**，见下面的归一化规则）。
 *
 * ⚠️ ★ **与 PLAN 措辞的一处偏差（如实记）**：PLAN 的面板 5 写「按年/月/日浏览」，
 *   字面上「只选年 = 看整年」。但 `ReadPort.logs()` 的入参 `LogQuery.month` 是
 *   **必填**（`viewer/main/db-worker.ts` 的 `readLogPage` 按 `<dataDir>/logs/<年>/<月>/`
 *   目录读文件）⇒ **「整年」在一次查询里不可表达**。
 *   ⇒ 本函数的归一化规则是：`month` 缺省 / 非法 ⇒ **归一到 `1`**（从 1 月开始看），
 *     并在界面上如实显示「1 月」，**不**把 1 月的数据标成「整年」
 *     （标成整年就是**界面撒谎**，比不支持更糟）。
 *   跨月阅读靠「月」下拉逐月前进 —— 这也正是 `prevPage` / `nextPage` 之外不需要
 *   再引入第二套「整年」分页逻辑的原因。
 */
export interface LogSelection {
  /** 年（四位数）。 */
  readonly year: number;
  /** 月（`1~12`）；缺省 / 非法 ⇒ 归一成 `1`（理由见上面的偏差说明）。 */
  readonly month?: number | undefined;
  /** 日（`1~31`）；缺省 ⇒ **整月**；非法 ⇒ 归一成整月。 */
  readonly day?: number | undefined;
  /** 关键字（空白 ⇒ 不过滤）。 */
  readonly keyword?: string | undefined;
}

/** 年份的合法区间（**归一化用**，不是校验：越界不抛错，夹到边界）。 */
const MIN_YEAR = 1970;
/** 年份的合法区间。 */
const MAX_YEAR = 9999;

/** 把任意数夹成整数（非有限值 ⇒ 落回 `fallback`）。 */
function toInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * ★ 三级选择 + 页码 → `LogQuery`（**纯函数，绝不抛错**）。
 *
 * ★ **归一化规则（缺省 / 非法一律归一，不抛错）**：
 *   1. `year` 非有限值 ⇒ 落回 `MIN_YEAR`；越界 ⇒ 夹到 `[1970, 9999]`；
 *   2. `month` 非有限值或不在 `1~12` ⇒ **归一成 `1`**
 *      （`LogQuery.month` 必填 ⇒ 「整年」不可表达，理由见 `LogSelection` 的偏差说明）；
 *   3. `day` 非有限值或不在 `1~31` ⇒ **当作「整月」**（丢掉 day，键都不传）；
 *   4. `keyword` 去空白后为空 ⇒ 不传该键（**不传 `keyword: ''`**：
 *      空串在库侧是「过滤空串」，虽然结果一样，但语义上是两件事）；
 *   5. `page` 与 `pageSize` 一律先夹成非负整数，`offset = page × pageSize`。
 *
 * ⚠️ **为什么不抛错**：面板的输入来自界面控件（`<select>` / `<input>`），
 *   用户清空数字框、或把月份改成 `0`，都会造出「不合法的选择」。
 *   在渲染期间抛错 = 整页白屏，而正确行为显然是「按最接近的合法值显示」。
 *   ⇒ 归一化规则写在这里（一处），而不是散在 `onChange` 里各写一遍。
 *
 * @param selection 三级选择
 * @param page 页号（0 起；越界夹到 0）
 * @param pageSize 页大小（缺省 `LOG_PAGE_SIZE`）
 */
export function buildLogQuery(
  selection: LogSelection,
  page: number,
  pageSize: number = LOG_PAGE_SIZE,
): LogQuery {
  const size = Math.max(1, toInt(pageSize, LOG_PAGE_SIZE));
  const safePage = Math.max(0, toInt(page, 0));

  const rawYear = toInt(selection.year, MIN_YEAR);
  const year = Math.min(MAX_YEAR, Math.max(MIN_YEAR, rawYear));

  const rawMonth = toInt(selection.month, Number.NaN);
  const month = rawMonth >= 1 && rawMonth <= 12 ? rawMonth : 1;

  const rawDay = toInt(selection.day, Number.NaN);
  const day = rawDay >= 1 && rawDay <= 31 ? rawDay : undefined;

  const keyword = (selection.keyword ?? '').trim();

  // ⚠️ `exactOptionalPropertyTypes`：可选的键**只在有值时才写**，
  //   不写 `day: undefined`（那在类型上就是另一个东西）。
  const query: LogQuery = {
    year,
    month,
    limit: size,
    offset: safePage * size,
    ...(day === undefined ? {} : { day }),
    ...(keyword === '' ? {} : { keyword }),
  };
  return query;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、面板 5 / 6：翻页（夹紧，不越界、不返回 -1 / NaN）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 最大页号（0 起）。
 *
 * ⚠️ `total = 0` ⇒ **0**（不是 `-1`）：空结果集也有「第 1 页」，
 *   返回 `-1` 会让「上一页」在空结果上算出更离谱的负数，
 *   而 `offset` 变负在 SQL 里是**静默**的（SQLite 把负 OFFSET 当 0）。
 */
export function maxPage(total: number, pageSize: number): number {
  const size = Math.max(1, toInt(pageSize, LOG_PAGE_SIZE));
  const count = Math.max(0, toInt(total, 0));
  if (count === 0) {
    return 0;
  }
  // 等价于 `ceil(count / size) - 1`，写成 `floor((count-1)/size)` 是为了让「最后一页不满」这件事一眼可见
  return Math.max(0, Math.floor((count - 1) / size));
}

/** 把页号夹进 `[0, maxPage]`。 */
function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(maxPage(total, pageSize), Math.max(0, toInt(page, 0)));
}

/**
 * 下一页。
 *
 * ⚠️ **到最后一页再点 ⇒ 返回同一页号**（不是 `max + 1`、不是 `undefined`）：
 *   调用方会把它直接塞进 `useState`，返回一个越界值就意味着「点一下变成空白页」。
 */
export function nextPage(page: number, total: number, pageSize: number): number {
  const current = clampPage(page, total, pageSize);
  return Math.min(maxPage(total, pageSize), current + 1);
}

/** 上一页（**到第 0 页再点 ⇒ 仍是 0**）。 */
export function prevPage(page: number, total: number, pageSize: number): number {
  const current = clampPage(page, total, pageSize);
  return Math.max(0, current - 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、面板 6：累积加载（「更早的按需加载」）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把新到的一页**追加**到已加载列表，并截到 `cap`。
 *
 * ★ **返回同一引用**的两种情况（这是「没有多余渲染」的可断言形式）：
 *   ① 已加载数已达 `cap`（再追加也不会变长）；
 *   ② 新到的一页是空的（没有新东西）。
 *   ⇒ 组件里 `setLoaded(prev => appendPage(prev, incoming, cap))` 在 ①② 下
 *     拿到的是**同一个**引用，React 因此**不会**重渲染。
 *   ⚠️ 返回新数组时若超 `cap`，**从尾部截断**（保留先加载的 = 更新的版本，
 *     因为面板 6 是 `replaced_at` 逆序，先加载的才是最新的）。
 *
 * @param loaded 已加载（**只读视图**，本函数不改它）
 * @param incoming 新到的一页
 * @param cap 上限（= `total`，见面板 6 的用法）
 */
export function appendPage<T>(
  loaded: readonly T[],
  incoming: readonly T[],
  cap: number,
): readonly T[] {
  const limit = Math.max(0, toInt(cap, 0));
  if (loaded.length >= limit) {
    return loaded;
  }
  if (incoming.length === 0) {
    return loaded;
  }
  const merged = [...loaded, ...incoming];
  return merged.length > limit ? merged.slice(0, limit) : merged;
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、面板 7：两次快照的成员重叠度（**唯一的实现**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **两个成员集合的重叠度** —— 面板 7「最近两次快照对比」的唯一算法。
 *
 * ⚠️ 为什么按 `min(|A|,|B|)` 而不是并集：
 *   簇会长大（今天 10 条、明天 60 条且包含原来那 10 条）——
 *   用并集归一会让「完全包含」只得到 0.17，看起来像「几乎不是同一个簇」；
 *   而它其实是**同一个簇变大了**。按较小集合归一后，完全包含 = 1.0。
 *
 * ⚠️ ★ **本函数只看成员 id，不看簇的 `key`**：`key` = 簇内最小成员 id，
 *   成员一变它就变 ⇒ 拿 `key` 做对比得到的是「这两个 key 一不一样」，
 *   与「是不是同一个簇」无关（设计 §7.2 面板 7）。
 *
 * @param previous 上次快照的成员 id
 * @param next 本次快照的成员 id（**顺序不参与计算**，只做集合语义）
 * @returns `[0, 1]`；任一侧为空 ⇒ 0
 */
export function overlapRatio(previous: ReadonlyArray<string>, next: ReadonlyArray<string>): number {
  if (previous.length === 0 || next.length === 0) {
    return 0;
  }
  const previousSet = new Set(previous);
  let shared = 0;
  for (const id of next) {
    if (previousSet.has(id)) {
      shared += 1;
    }
  }
  return shared / Math.min(previous.length, next.length);
}
