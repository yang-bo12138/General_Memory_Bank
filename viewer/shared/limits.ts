/**
 * ★ 查看器的**限额常量**的唯一出处 —— 阶段 5 · T03/T04（设计 §7.2 面板 4/6/7）。
 *
 * ⚠️ **为什么这三个数要单独成文件**（而不是留在 `viewer/main/queries.ts` 里）：
 *   面板（`viewer/renderer/**`）**必须**知道它们——
 *     · 面板 6 要算分页的 `offset = 页号 × 页大小`；
 *     · 面板 4 要把边数上界显式画成「仅显示前 N 条边」；
 *     · 面板 7 要把成员列表截到 `CLUSTER_MEMBER_SAMPLE_MAX` 并标注「仅显示前 N 条」。
 *   而 `viewer/renderer/**` **不许 import `viewer/main/**`**（分层：`shared` 最左，
 *   `main` 与 `renderer` 是**兄弟**，兄弟之间不互相 import）。
 *   更硬的一条：`queries.ts` 里是 **SQL 常量**，设计明写「SQL 常量不该出现在 renderer 的产物里
 *   （哪怕它只是字符串）」⇒ 让面板为了一个数字把 SQL 表拖进渲染进程，正好把那条边界拆掉。
 *   ⇒ 三个数搬到 `shared/`，`queries.ts` 改成 **re-export**（不是第二份定义）。
 *
 * ⚠️ **本文件必须零依赖 `viewer/main/**` 与 `viewer/renderer/**`**
 *   （`shared` 是最左端，见 `channels.ts` 文件头的同一条纪律）。
 *   它唯一的 import 是 `src/core/params.ts` —— 那是**参数表的唯一真相**，
 *   本文件只从中**派生**一个只读别名，不另存一份数字。
 */

import { DEFAULT_PARAMS } from '../../src/core/params.js';

/**
 * 面板 4 的**边数硬上界**（`graphTwoHop` 的 `@nodeLimit`）。
 *
 * ⚠️ 它是该参数的**唯一来源**：库线程的 `bindQueryParams` 会把外来值**钳**在它以内，
 *   面板也只是把它**照着显示**（「仅显示前 N 条边」），不参与任何放大。
 */
export const GRAPH_NODE_LIMIT = 300;

/**
 * 面板 6 的**页大小**（设计 §7.2 面板 6：「分页取最近 50 版」）。
 *
 * ⚠️ 与 `GRAPH_NODE_LIMIT` 同理：它是 `contentHistoryPage` 的 `@limit` 的唯一来源。
 *   `content_history` 的上限**不受控**（§4.9：它会单调增长）⇒ 一次性全取会在
 *   被反复提及的记忆上**卡住界面**，所以页大小必须是常量而不是「想取多少取多少」。
 */
export const CONTENT_HISTORY_PAGE_SIZE = 50;

/**
 * 面板 7 的**簇成员样本上限** —— 与 §4.12.4 的枚举上限一致。
 *
 * ⚠️ ★ 这是一条**派生别名**，不是第二份定义（与 `src/core/decay.ts` 里 `MS_PER_DAY` 的
 *   re-export 同款理由）：数字的唯一出处是 `DEFAULT_PARAMS.CLUSTER_MEMBER_SAMPLE_MAX`
 *   ⇒ 有人调参数时本值自动跟随，**不可能漂移**。
 *   ⚠️ 这里**不写 `50` 字面量**：仓库里「50」只允许出现在两处定义点
 *   （`src/core/params.ts` 的那一项、以及上面的 `CONTENT_HISTORY_PAGE_SIZE`），
 *   面板源码里出现第三份就会被 `viewer-panels-*.test.ts` 的扫描判红。
 */
export const CLUSTER_MEMBER_SAMPLE_MAX: number = DEFAULT_PARAMS.CLUSTER_MEMBER_SAMPLE_MAX;
