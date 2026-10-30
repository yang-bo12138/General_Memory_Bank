/**
 * 时钟注入机制 —— DESIGN-v2.md §11.1。
 *
 * ★ **机器可检约束（C37）**：**凡方法体读写时间戳或参与时间计算的，签名必须含 `now?`；
 * 不接收 `now` 的方法必须在本表显式列出并写明理由**（本文件已列全：
 * `pin` / `unpin` / `restore` / `setParams` / `setAlias` / `mergeEntities`）。
 * ⇒ 实现者新增任何方法时，若它碰时间戳而本表没有它 ⇒ **契约校验失败**——
 *   这条把「时钟注入」从实现约定升级为**可被 CI 拦住的规则**，
 *   否则新方法很容易直接写 `Date.now()`，而那种方法**在测试里无法复现**
 *   （衰减、共激活、归档三条时间相关链路会一起失真）。
 *
 * ⚠️ **本文件是「注入时钟的唯一入口」**（时钟解析器），
 *   因此它是**唯一**允许读真实时钟（`Date.now()`）的实现文件——
 *   `scripts/check-clock.ts` 的白名单里只有它一个，**且期望命中数写死**（C31）。
 */

/**
 * §11.1 时钟注入表：**接收 `now?: number`** 的方法与 `now` 的用途。
 *
 * ⚠️ 这张表是「方法 → 时间语义」的**唯一权威**；
 *   新增方法若碰时间戳而本表没有它 ⇒ C37 校验失败。
 */
export const CLOCK_INJECTION_METHODS: Readonly<Record<string, string>> = {
  write: 'created_at / last_access / 初始稳定度 / content_history.replaced_at',
  recall: '强度与 recency 的计算基准（纯读，不改数据）',
  touch: '间隔天数、last_access，以及 R-EDGE-TOUCH 强化证据边时的 edges.last_active',
  link: 'edges.created_at / last_active',
  updateContent: 'content_history.replaced_at（归档旧正文的时间戳）',
  forget: 'deleted_at（没有它就无法用注入时钟测 sweep({purgeDeletedDays}) 的截止判断）',
  sweep: 'purge 截止点 cutoff = now - purgeDeletedDays × 86400000、归档判定与统计基准',
  stats: '归档判定与统计基准（归档计数走 §9.4 的 archival_schedule 缓存，now 是判定基准）',
  get: '归档判定与统计基准',
  clusters: '有效 affinity 的计算基准（决定哪些边存在）与 asOf / computedAt 快照时刻',
  inhibitionTrace: '与 recall 同一套时间基准（强度与 recency 的计算）',
};

/**
 * §11.1 豁免清单：**不接收 `now`** 的方法与**理由**。
 *
 * ⚠️ 理由必须写明——它们不写任何时间派生字段：
 * · `pin` / `unpin` / `setParams` / `setAlias`：不写任何时间派生字段
 *   （`setParams` / `setAlias` 的 `events.at` 用真实时钟，**不参与计算**）；
 * · `restore`：只把 `deleted_at` 置 NULL；
 * · `mergeEntities`：`edges.last_active` 取两条边中的较大者，不引入当前时刻。
 */
export const CLOCK_EXEMPT_METHODS: Readonly<Record<string, string>> = {
  pin: '不写任何时间派生字段',
  unpin: '不写任何时间派生字段',
  restore: '只把 deleted_at 置 NULL，不引入当前时刻',
  setParams: '不写任何时间派生字段（events.at 用真实时钟，不参与计算）',
  setAlias: '不写任何时间派生字段（events.at 用真实时钟，不参与计算）',
  mergeEntities: 'edges.last_active 取两条边中的较大者，不引入当前时刻',
};

/** 时钟解析器：注入优先，缺省用真实时钟（§11.1「缺省 `Date.now()`」）。 */
export function resolveNow(now?: number): number {
  return now ?? Date.now();
}

/**
 * 解析一个「可注入但可能缺省」的时间参数。
 *
 * ⚠️ 显式传 `0` 必须是**合法**的（0 是一个合法的 epoch 毫秒），
 *   所以不能用 `now || Date.now()`——那会把 0 当成「没传」。
 */
export function resolveNowStrictly(now: number | undefined, fallback: number): number {
  return now === undefined ? fallback : now;
}
