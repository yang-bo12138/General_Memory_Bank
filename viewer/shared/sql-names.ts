/**
 * ★ SQL 查询的**名字表**（阶段 5 · P5-T01，§3.2 / §4.1）—— **没有一行 SQL 文本**。
 *
 * ⚠️ **为什么 renderer 只能拿名字、不能拿 SQL**：
 *   如果 `select(sqlText, params)` 收的是 SQL 字符串，那「只读」就退化成「SQL 防护层看着办」——
 *   而防护层是**文本判据**，文本判据总有绕过面。收名字则不同：
 *   renderer 能执行的语句集合 = `SQL_QUERIES` 里那几条**编译期就固定**的常量
 *   ⇒ 攻击面从「任意 SQL」缩到「这几条 SQL 的绑定参数」。
 *
 * ⚠️ **SQL 文本放在 `viewer/main/queries.ts`**（库线程侧），本文件只有名字与参数形状。
 *   分两个文件的理由：`protocol.ts` 要被 renderer 打包进去，
 *   而 SQL 常量不该出现在 renderer 的产物里（哪怕它只是字符串）。
 */

/**
 * ★ 面板 4/6 用的原始 `SELECT` 的**名字**（写死）。
 *
 * ⚠️ 「加一条查询」必须同时改三处：本数组、`SqlQueryParams`、`viewer/main/queries.ts`
 *   的 `SQL_QUERIES`（后者用 `satisfies Record<SqlQueryName, string>` ⇒ **漏一条就编译不过**）。
 */
export const SQL_QUERY_NAMES = [
  /** 面板 4：一条记忆的实体做种子，取两跳内的边（带实体名，`LIMIT` 抽样）。 */
  'graphTwoHop',
  /** 面板 6：一条记忆的正文历史，一页（`replaced_at` 逆序，`LIMIT ... OFFSET ...`）。 */
  'contentHistoryPage',
  /** 面板 6：一条记忆的正文历史**总版本数**（分页控件要分母）。 */
  'contentHistoryCount',
  /**
   * ★ 面板 2：**最近访问过的记忆**（`last_access` 逆序，`LIMIT` 抽样）—— P5-T04 新增。
   *
   * ⚠️ **它是「选择记忆」这件事的取数口**：在它之前 renderer 里没有任何东西能决定
   *   「看哪一条」，而 `memoryId` 是面板 2 / 4 / 6 的唯一取数键
   *   ⇒ 面板 6 永远空表、翻页按钮永久 disabled。
   * ⚠️ 它**不带 `memoryId` 参数**（列表就是「所有未软删记忆」的头部）——
   *   所以库线程的 `bindQueryParams` 对它是**先于** `memoryId` 校验处理的（见那里）。
   */
  'recentMemories',
] as const;

/** 一条原始查询的名字。 */
export type SqlQueryName = (typeof SQL_QUERY_NAMES)[number];

/**
 * ★ 每条查询的**绑定参数形状**。
 *
 * ⚠️ **全部用命名参数**（`@name`），不用位置参数 `?`：
 *   位置参数的绑定顺序是「调用点与 SQL 之间的隐形契约」——
 *   中间插一个参数，错位是**静默**的（类型都是 string/number，谁也拦不住）。
 *   命名参数让「多绑 / 漏绑」由 better-sqlite3 自己报错。
 *
 * ⚠️ **每个参数形状里都有一个 `limit` 字段**（含 `contentHistoryCount` 这个标量聚合）。
 *   这不是笔误：本文件的**唯一不变量**是「**`SQL_QUERIES` 里每一条 SQL 都带 `LIMIT`**」，
 *   聚合那条绑 `LIMIT 1`（聚合恒定一行，`LIMIT 1` 不改变结果）。
 *   ⇒ 代价是多一个恒为 1 的参数；收益是那条不变量可以**一条测试**断言到底，
 *     不需要维护「哪些查询算例外」的第二份名单（第二份名单必然漂移）。
 */
export interface SqlQueryParams {
  /** 面板 4：`memoryId` 做种子，`nodeLimit` 是边数的**硬上界**。 */
  graphTwoHop: { memoryId: string; nodeLimit: number };
  /** 面板 6：`limit` = 页大小，`offset` = 页码 × 页大小。 */
  contentHistoryPage: { memoryId: string; limit: number; offset: number };
  /** 面板 6：聚合恒一行 ⇒ `limit` 传 `1`（见接口上的说明）。 */
  contentHistoryCount: { memoryId: string; limit: number };
  /**
   * ★ 面板 2：`limit` 是**列表条数**的硬上界（唯一来源 `RECENT_MEMORY_LIMIT`）。
   *
   * ⚠️ 与面板 6 的两条不同，它**没有 `memoryId`**：列表的语义是「库里最近的若干条」，
   *   不是「某一条的历史」⇒ 参数形状不同是**语义不同**，不是遗漏。
   * ⚠️ 它照样带 `limit` —— 「`SQL_QUERIES` 里每一条 SQL 都带 `LIMIT`」这条不变量
   *   **没有例外名单**（见上面的接口说明）。
   */
  recentMemories: { limit: number };
}

/**
 * ★ 类型守卫：判断一个 `unknown` 是不是合法的查询名。
 *
 * ⚠️ 它放在这里（而不是 `viewer/main/db-worker.ts`）的理由是**进程边界**：
 *   `ipc.ts` 也要判它（IPC 收的是 `unknown`），而 `ipc.ts` **不能 import `db-worker.ts`**
 *   —— 后者 import 了 `better-sqlite3` 且会在模块顶层挂 `parentPort` 监听
 *   ⇒ 主进程顺着这个 import 把原生模块也加载进来了（「库句柄只在库线程」这条当场破功）。
 *   ⇒ 判据跟着名字表走，跟着 SQL 文本留在 `viewer/main/` 那边。
 *
 * ⚠️ 它是**运行期**守卫，不是类型：IPC 没有类型，`unknown` 必须在边界上被真的检查。
 */
export function isSqlQueryName(value: unknown): value is SqlQueryName {
  return typeof value === 'string' && (SQL_QUERY_NAMES as readonly string[]).includes(value);
}
