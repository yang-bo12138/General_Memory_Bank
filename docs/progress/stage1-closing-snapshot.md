# 阶段 1（P1）收官进度快照

> 时点：2026-10-31 约 12:05（Asia/Shanghai）
> 仓库：`General_Memory_Bank` · 分支 `main` · 远端 `origin/main` = `f5d3a2e`（+1 条待推）
> 合并态门禁：**30 个测试文件 / 615 条测试，EXIT=0**（`pnpm run verify`）

---

## 一、TL;DR

阶段 1 的**九个原始任务 + 一个新增任务（P1-T10 门面与导出面）全部落地并合并**；
本轮主理人收敛了三处 ADR/文档冲突、修复了一个**此前无人察觉的门禁盲区**、
并把「静默失效点」从 8 条降到了 3 条（其余 10 条已闭环）。

---

## 二、本轮（收官轮）主理人裁决记录

| # | 冲突 | 裁决 | 依据 |
|---|---|---|---|
| 1 | `extractEntityNames` 的阶段归属：ADR-P1-T08-GAP C-1.3「推荐 A 导出」**vs** ADR-P1-T07-DEC D-1「阶段 1 不实现」 | **阶段 1 不实现、不进导出面** | C-1.3 是「二选一，我推荐 A」⇒ 建议；D-1（更晚）是正式裁决；且 **DESIGN-v2.md §4.6 步骤 1 正文已按 D-1 落笔**（:1185「⚠️ **阶段 1 不实现它**……⇒ **本节只留口子**」）⇒ 正文即权威 |
| 2 | 基线参考实现的 `REF_MS_PER_DAY` 是否 import 库的 `MS_PER_DAY` | **不 import**（参考实现必须独立于被审对象） | 若 import，将来 `MS_PER_DAY` 改错 ⇒ 参考实现跟着一起错 ⇒ 基线**静默**退化成「当前实现的语义」⇒ 循环论证。改为加一条**漂移可见**的断言 |
| 3 | `ALIAS_TARGET_NOT_LINKED` 的白名单同步范围 | **三处全改**（`errors.ts` + `check-contract-ids.ts` + DESIGN §11.2 反引号） | 门禁 `compareNameSets` 做三方比对 ⇒ 少一处即红 |

---

## 三、★ 本轮新发现并修复的门禁盲区

**现象**：合并「C 终裁」后，`src/store/write.ts` 已发出**两个** warning code，
而三处白名单**全都还只有 `ALIAS_CONFLICT`** ⇒ **门禁仍全绿（EXIT=0）**。

**根因**：`scripts/check-contract-ids.ts` 只做**三方互相比对**（白名单 ↔ 源码常量 ↔ 文档表格），
**从不去检查「源码里实际发出的 warning code 集合」** ⇒ 新加一个 code 而忘了登记 ⇒ 门禁完全看不见。
这是 **C36「同一件事不得有两套词」的经典漏洞**：warning code 有**两处**来源，
门禁只保证它们**各自与文档一致**，不保证**彼此一致**。

**修复**：新增守卫「源码实发 warning code ⊆ 白名单」⇒
**合并当日即在实战中生效**（登记缺失 ⇒ `verify` EXIT=1，指名报红 `ALIAS_TARGET_NOT_LINKED`）。

---

## 四、阶段 1 任务完成度

| 任务 | 状态 | 关键交付 |
|---|---|---|
| P1-T01 Schema / 连接 | ✅ | v2 schema + 迁移可重入 + CHECK 与 §3 逐字一致 |
| P1-T02 v1→v2 迁移 | ✅ | 迁移前后全字段零差异；阶段 B 可重入 |
| P1-T03 中文 Bigram + FTS5 | ✅ | `buildMatchQuery` 三分支；单 token 不产生 `AND` 字面量（永久口径已写进注释） |
| P1-T04 纯函数算法 | ✅ | 归档跨度收敛为 `decay.ts` 唯一实现 |
| P1-T05 图谱维护 | ✅ | `aliasAdded` 一名两义已消除（改名 `sourceName`）；软删自校验补 `AND deleted = 0` |
| P1-T06 growStability + touch | ✅ | reinforce 不写共激活边（行数前后不变，有断言） |
| P1-T07 write 写入路径 | ✅ | **D-3 终裁落地**（别名目标建但不隐含关联）+ `ALIAS_TARGET_NOT_LINKED` 边界可观测 |
| P1-T08 recall 三路召回 | ✅ | `entityNames` 入口（与 `entityIds` 互斥）+ 归档模式**整体不判强度** + `from*` 三标记 + 显式列名 |
| P1-T09 get() + 基线验收 | ✅ | **v1.0 基线等价**（独立重算的参考实现 + 四方法 `toEqual` 逐位比 + 反真空守卫） |
| P1-T10 门面 + 导出面 | ✅ | `MemoryStore`（10 个方法，零业务逻辑）+ `src/index.ts` 导出面收口 + **「导出面不越出 §12 清单」守卫** |

---

## 五、门禁现状（10 条）

`pnpm run verify` = typecheck → lint(biome) → test(vitest) → `check:params` / `check:payload-keys` /
`check:clock` / `check:anchor` / `check:contract-ids` / `check:doc-counts` / **`check:clamp`**（新增）

其中 **`check:clamp`** 是本轮新增的第 10 条 ⇒ 它守的是 **F-08 ③**：
`intensity()` 的两道钳制在正常输入下**行为等价** ⇒ 行为层**无解**（任何「删掉一道」的断言都是真空负控）
⇒ 只能用**静态扫描** ⇒ 且判据升级为**数据流**（堵住「补一个无关的同形态调用」的绕过），
同时带**「不误报」**用例（中间变量写法 / 内联写法必须放行）。

---

## 六、剩余欠账（**11 条**，已从 8 条扩展；10 条已闭环）

| 类别 | 条数 | 说明 |
|---|---|---|
| ✅ **已闭环** | 10 | 含门禁盲区、钳制守卫、别名边界可观测、`extractEntityNames` 阶段归属 |
| ⏳ **阶段 2 消化** | 8 | 桶归属欠账（集合相等断言 + 启动对账）、`stability > 0` 校验、错误码类型层加固、归档模式候选池放大等 |
| ⚠️ **静默失效点** | 3 | 静态断言不保证阶段 2 写了桶 / 归档粗筛取 0 放大候选池 / 0.0 阈值（已改抛错） |

> ⚠️ **v2.1（P2 QA 第二轮 D4 修正）**：原标题写「13 条」⇒ 与表内对不上
>   （表内 10 / 8 / 3 ⇒ 剩余 = 8 + 3 = **11**）⇒ 那是**笔误** ⇒ 已改正。
>
> ⚠️⚠️ **本节是「阶段 1 收官时（`e7abf39`）」的快照** ⇒ 上表的数字是**当时**的数字
>   ⇒ **不代表当前状态** ⇒ 阶段 2 已消化其中若干条（桶归属欠账、错误码类型层加固等）
>   ⇒ **当前状态见 `docs/progress/stage2-progress.md`**（阶段 2 的进度与欠账）。

---

## 七、下一阶段开工顺序（阶段 2）

1. **P2-T03 集合相等硬断言**（左侧口径必须是**全库** `SELECT id FROM memories WHERE embedding IS NOT NULL AND deleted = 0`）
2. **启动对账 + 首次重训**（桶归属欠账的兑现机制）
3. **向量路的两级分桶路由**（§4.15.2 / §4.15.3）
4. **分桶吻合率验收**（`flat` 作参照，**吻合率 ≥ 0.98**，不是「完全相同」）

---

## 八、环境与并行纪律（本轮踩过的坑）

1. **`pnpm ci` / `npm ci` 是包管理器内建命令（clean install）**，会遮蔽同名 script ⇒ **永远用 `pnpm run verify`**。
2. **主工作树 `D:/Git/repo` 只归主理人**（合并 + 合并态门禁）⇒ 并行线一律用独立 worktree。
3. **推之前先确认** `git log --oneline -1 origin/main` 与本地 HEAD 一致 ⇒ 否则会出现「push 说 up-to-date 但远端没动」。
4. **一条开发线一个 worktree**；提交归属以 `git log` / `git show --name-only` 为准。
5. **加一条门禁，必然连带改四处**（`check-gate-entry.ts` 的写死分母 / `check-contract-ids.ts` 的注释 /
   `scripts/README.md` / `tests/contracts/scripts.test.ts`）⇒ 这不是越界，是同一件事的四个面。
