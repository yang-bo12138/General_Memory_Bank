/**
 * ★ 面板 4 / 面板 6 用的**原始 SQL 常量** —— 阶段 5 · T02（设计 §3.3 第 10 项）。
 *
 * ⚠️ **为什么这两块要绕过 `MemoryStore` 的公开面**（设计 §1.3）：
 *   §6 刻意**不提供**「读边图」与「读历史正文」的公开方法
 *   （图数据量随库规模增长；`content_history` 不参与召回），
 *   而 `MemoryStore` **不暴露 `db`**（`#db` 是私有字段）、公开面被
 *   `tests/contracts/export-surface.test.ts` 钉死为 **23 个方法**。
 *   ⇒ 查看器走仓库**已有的先例**（`verifyIntegrity.test.ts` 里那句
 *     「门面不暴露 `db` ⇒ 只能另开一个旁路连接」）：这里就是那条旁路连接，
 *     只不过它是**产品代码**而不是测试代码，且每一条 SQL 都要先过 `sql-guard.ts`。
 *
 * ⚠️ **本文件是 SQL 文本的唯一出处**：`viewer/shared/sql-names.ts` 只有**名字**，
 *   renderer 只能拿名字 ⇒ 它能执行的语句集合在这里**编译期就固定**。
 *
 * ⚠️ ★ **每一条 SQL 都必须带 `LIMIT`**（本文件的唯一不变量，由
 *   `viewer-worker.test.ts` 逐条断言）。理由是这类查询的结果集**随库规模增长**：
 *   · `graphTwoHop`：一条记忆挂的实体可能连着上千条边；
 *   · `contentHistoryPage`：一条记忆可以被合并几十上百次。
 *   没有 `LIMIT` 的「查看器查询」在真实库上会把 worker 线程钉住，而 UI 只会显示「计算中」。
 *   ⚠️ 连 `contentHistoryCount` 这个**标量聚合**也带 `LIMIT`：它恒定一行，
 *     `LIMIT 1` 不改变结果，但换来的是「**没有例外名单**」——
 *     一旦允许例外，就得维护第二份「哪些查询可以没有 LIMIT」的名单，而第二份名单必然漂移。
 */

import type { SqlQueryName } from '../shared/sql-names.js';

/**
 * ★ **两个限额常量已搬到 `viewer/shared/limits.ts`**（阶段 5 · T03 的搬动，**不是**新增第二份）。
 *
 * ⚠️ **为什么搬**：面板（`viewer/renderer/**`）也必须知道这两个数
 *   （面板 6 算 `offset = 页号 × 页大小`；面板 4 要显示「仅显示前 N 条边」），
 *   而设计明写「SQL 常量不该出现在 renderer 的产物里（哪怕它只是字符串）」，
 *   且 `renderer` 与 `main` 是**兄弟层**、不互相 import
 *   ⇒ 数字下沉到最左层的 `shared/`，本文件改成 **re-export**。
 *
 * ⚠️ **re-export 不是第二份定义**（与 `src/core/decay.ts` 里 `MS_PER_DAY` 的做法同款）：
 *   `GRAPH_NODE_LIMIT` / `CONTENT_HISTORY_PAGE_SIZE` 的**唯一定义**在 `shared/limits.ts`，
 *   这里只是把旧路径保住，免得 `db-worker.ts` 与既有测试的 import 同时断掉。
 */
export {
  CONTENT_HISTORY_PAGE_SIZE,
  GRAPH_NODE_LIMIT,
  RECENT_MEMORY_LIMIT,
} from '../shared/limits.js';

/**
 * ★ 三条查询的 SQL 常量。
 *
 * `satisfies Record<SqlQueryName, string>` ⇒ **漏一条、多一条、拼错名字都编译不过**
 * （这就是「名字表」与「SQL 表」之间那条唯一的编译期契约，不另立第二张对照表）。
 *
 * ⚠️ **命名参数**（`@name`）而不是位置参数 `?`：位置参数的绑定顺序是「调用点与 SQL 之间的
 *   隐形契约」，中间插一个参数，错位是**静默**的（都是 string/number）。
 *
 * ⚠️ **刻意不选 `embedding` 之类的 BLOB 列**：`SqlRow` 只允许
 *   `string | number | null`（BLOB 是 `Buffer`）⇒ 选进结果集就等于把一个
 *   不可 JSON 序列化的值塞进 IPC。面板也用不到向量本身。
 */
export const SQL_QUERIES = {
  /**
   * 面板 4：以一条记忆挂的实体为种子，取**两跳**内的边（**带实体名**，边数受限）。
   *
   * 结构：`seed`（种子实体）→ `hop1`（一跳边）→ `hop1_node`（一跳用到的实体）
   *   → `hop2`（二跳边，剔除已在一跳里的边）→ 合并输出，`hop` 列标注是第几跳。
   * ⚠️ 两个分支各自 `LIMIT @nodeLimit`，最后整条语句再 `LIMIT @nodeLimit`：
   *   前者防「单跳扫出十万条」，后者防「两跳合起来翻倍」。
   */
  graphTwoHop: `
WITH seed AS (
  SELECT entity_id FROM memory_entities WHERE memory_id = @memoryId
),
hop1 AS (
  SELECT e.id AS edge_id,
         e.subject_id, s.name AS subject_name,
         e.predicate,
         e.object_id, o.name AS object_name,
         e.weight, e.last_active
  FROM edges e
  JOIN entities s ON s.id = e.subject_id
  JOIN entities o ON o.id = e.object_id
  WHERE e.subject_id IN (SELECT entity_id FROM seed)
     OR e.object_id IN (SELECT entity_id FROM seed)
  ORDER BY e.weight DESC, e.id ASC
  LIMIT @nodeLimit
),
hop1_node AS (
  SELECT subject_id AS entity_id FROM hop1
  UNION
  SELECT object_id AS entity_id FROM hop1
),
hop2 AS (
  SELECT e.id AS edge_id,
         e.subject_id, s.name AS subject_name,
         e.predicate,
         e.object_id, o.name AS object_name,
         e.weight, e.last_active
  FROM edges e
  JOIN entities s ON s.id = e.subject_id
  JOIN entities o ON o.id = e.object_id
  WHERE (e.subject_id IN (SELECT entity_id FROM hop1_node)
      OR e.object_id IN (SELECT entity_id FROM hop1_node))
    AND e.id NOT IN (SELECT edge_id FROM hop1)
  ORDER BY e.weight DESC, e.id ASC
  LIMIT @nodeLimit
)
SELECT 1 AS hop, edge_id, subject_id, subject_name, predicate, object_id, object_name,
       weight, last_active
FROM hop1
UNION ALL
SELECT 2 AS hop, edge_id, subject_id, subject_name, predicate, object_id, object_name,
       weight, last_active
FROM hop2
ORDER BY hop ASC, weight DESC, edge_id ASC
LIMIT @nodeLimit
`,

  /**
   * 面板 6：一条记忆的正文历史，**一页**（`replaced_at` 逆序 = 最新在前）。
   *
   * ⚠️ 第二排序键是 `id DESC`：`replaced_at` 相同的两版（同一次合并写两行）必须有**全序**，
   *   否则分页会在页边重复 / 漏行（SQLite 对 ORDER BY 相同值的相对顺序不作保证）。
   */
  contentHistoryPage: `
SELECT id, memory_id, content, reason, replaced_at
FROM content_history
WHERE memory_id = @memoryId
ORDER BY replaced_at DESC, id DESC
LIMIT @limit OFFSET @offset
`,

  /**
   * 面板 6：一条记忆的正文历史**总版本数**（分页控件要分母）。
   *
   * ⚠️ 末尾那个 `LIMIT @limit`（恒绑 1）是「**每一条 SQL 都带 LIMIT**」这条不变量的代价，
   *   不是笔误：聚合恒定一行，`LIMIT 1` 不改变结果（理由见文件头）。
   */
  contentHistoryCount: `
SELECT count(*) AS total
FROM content_history
WHERE memory_id = @memoryId
LIMIT @limit
`,

  /**
   * ★ 面板 2 的**「最近记忆」列表**（P5-T04 新增）—— 「选哪一条记忆来看」的唯一取数口。
   *
   * 为什么需要它：`memoryId` 是面板 2 / 4 / 6 的**唯一取数键**，而 renderer 里原先
   * **没有任何入口**能设它（`AppSelection.memoryId` 恒为 `''`）
   * ⇒ 面板 6 的 `total` 恒为 0、两个翻页按钮永久 disabled。
   * 列表是那条通路的入口 ⇒ 它必须真的从库里来（不能靠上层假数据渲染）。
   *
   * 三条硬约束：
   *   · **`WHERE deleted = 0`**：软删的记忆不进列表（§8.2：软删 = 不参与任何召回与扩散，
   *     用户也不该被引导去看它；要按 id 直接看仍可以，面板 6 会如实标注「已遗忘」）；
   *   · **`ORDER BY last_access DESC`**：「最近」= 最近被用过（§4.4 的 `last_access`），
   *     第二排序键 `id ASC` 只是给同毫秒的行一个**全序**（否则同一次查询两次执行可能换序，
   *     而在界面上表现为「列表莫名其妙跳了一下」）；
   *   · **`LIMIT @limit`**：行数随库规模增长 ⇒ 没有 LIMIT 的列表查询会把 worker 钉住
   *     （本文件的不变量，`viewer-sql-guard.test.ts` 逐条断言，**没有例外名单**）。
   *
   * ⚠️ **选进结果集的列 = 面板列表要显示的四样东西**
   *   （`id` / 正文摘要 / `last_access` / `stability`），一个都不多：
   *   `embedding` 之类的 BLOB 列不选（`SqlRow` 只允许 `string | number | null`），
   *   `content` 本身就是要显示的正文摘要来源（面板负责截断，SQL 不做字符串手术）。
   */
  recentMemories: `
SELECT id, content, last_access, stability
FROM memories
WHERE deleted = 0
ORDER BY last_access DESC, id ASC
LIMIT @limit
`,
} as const satisfies Record<SqlQueryName, string>;
