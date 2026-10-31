# 交付总结 · 2026-10-31

**项目**：General_Memory_Bank —— 把「多模态记忆 / 多层记忆 / 图谱记忆 / 遗忘曲线 / 神经元交互」
合成一个可复用的记忆库（不是五个模块，是同一片海里的五种现象）。

**仓库**：https://github.com/yang-bo12138/General_Memory_Bank
**基线**：`651dac8`（`origin/main`）· 自 P0 基线 `a1cf013` 起 34 次提交

---

## 一、TL;DR

阶段 0（骨架与不变量）**全部完成并经 QA 四轮独立复核**；阶段 1（存储与基础运算）的
**9 个既有任务全部落地**，收官的 6 项并行补齐工作推进中（门面导出面 / 基线等价验收 /
recall 契约返工 / 静态守卫 / 六条口径 / ADR 回写）。
门禁 `pnpm run verify` **退出码 0**：**24 个测试文件 / 527 条测试全绿**。

---

## 二、交付概览

| 项 | 状态 |
|---|---|
| 阶段 0（7 任务 + 收尾 + 回写） | ✅ 全部完成 · **QA 四轮独立复核**（33 组破坏性负控） |
| 阶段 1（9 既有任务） | ✅ 代码与门禁齐备（P1-T08 / P1-T09 的收官项在跑） |
| 阶段 1 新增 P1-T10（门面 + 导出面） | 🟡 在建（F-10：阶段 1 原本**没有任何任务**产出公共入口） |
| 阶段 2~5（28 任务） | ❌ 未开始 |
| 门禁 | `pnpm run verify` **退出码 0**（9 段链：typecheck → lint → test → 6 条契约脚本） |
| 测试 | **24 个文件 / 527 条**，全通过，无 `Errors` 行 |
| 构建 | `pnpm build` 通过（CJS + ESM + d.ts，tsup） |
| CI | `.github/workflows/ci.yml`（verify + build 两个 job，Node 22 + pnpm 12.16.1） |
| 设计裁决 | 3 份 ADR（`adr-p1-conflicts` / `adr-p1-round2` / `adr-p1-t08-gaps`），共 **23 条裁决 + 6 条额外发现** |
| 独立验证 | P0 判定 **NoOne**（源码无 Bug）；P1 期间由主理人独立发现 `autoCreatedEntities` **恒为空** 的真缺陷并修复 |
| 已知边界 | 8 条（见 `docs/progress/stage0-stage1-progress.md` §七），其中 4 条必须随阶段 2 消化 |

---

## 三、文件清单

### 源码（`src/`，29 个文件 / 9070 行，不含测试）

```
src/core/     clock · decay · entities · errors · events.types · flags · graph
              params · schema · scoring · stability · tokenize · version
src/db/       connection · migrate · schema.sql
src/store/    entities · events · get · link · merge · params · pin · recall
              touch · transaction · write            （+ MemoryStore，收官中）
src/util/     log
src/index.ts  公共导出入口（阶段 0 不变量设施；阶段 1 起收口门面与方法）
```

### 测试（`tests/`，31 个文件 / 10506 行）

```
tests/unit/        write · merge · link · entities · touch · get · recall
                   scoring · params · decay · flags · …
tests/contracts/   clock · doc-counts · …
tests/baseline/    baseline（+ ref-v1 / v1-equivalence，收官中）
tests/integration/ migrate
```

### 门禁脚本（`scripts/`）

`check:params` · `check:payload-keys` · `check:clock` · `check:anchor` ·
`check:contract-ids` · `check:doc-counts` · `check-gate-entry` · `capture-golden`
（+ `check-clamp`，收官中）

### 文档（`docs/`）

```
docs/design/    DESIGN-v2.md（唯一设计权威）· DESIGN-v2-errata.md
                DEVELOPMENT-PLAN.md（任务分解）· adr-p1-conflicts.md
                adr-p1-round2.md · adr-p1-t08-gaps.md
docs/progress/  stage0-stage1-progress.md（交接文档）
docs/quality/   stage0-verification.md · stage0-recheck.md（QA 四轮复核）
```

---

## 四、本轮（P1）的主要技术产出

| 模块 | 内容 |
|---|---|
| **写入路径** | §4.9 四步写入；`merge.ts` 独立成文件以保证「**唯一合并写入点**」可被静态扫描守住；完全重复路径必须补齐实体关联 + 向量补写；步骤 3a 的 `@dedupSql` **显式构造**（不复用 `buildMatchQuery`，避免二次分词） |
| **召回路径** | §4.6 三路召回流水线；两条铁律——**三路准入闸门一视同仁**、**向量只进 `score` 不改变任何准入判定**；候选去重时各路分数**各自独立保留、不合并不取平均** |
| **打分** | 五因子融合（intensity .30 / vectorSim .25 / normBm25 .20 / graphProximity .15 / recency .10）；缺项记 0、**不重算分母**；权重与 sigmoid 斜率**刻意硬编码**（改权重要走 ADR） |
| **图谱维护** | `link` / `linkByIds` / `setAlias` / `mergeEntities`；合并实体时边权**取和不取大**；只清目标实体的自环；可对账恒等式 `合并前边数 − 合并后边数 == mergedEdges + droppedSelfLoops` |
| **稳定度** | `growStability` 是**唯一 stability 写入点**；`stabilityDelta` 对账恒等式（§8.4 规则 5） |
| **错误体系** | 封闭五码：`CONFLICT` / `DATABASE_BUSY` / `INVALID_INPUT` / `NOT_FOUND` / `READONLY_VIOLATION`；§11.2 要求**裸错误码不得穿到调用方** |
| **时钟注入** | C37：真实时钟只能经 `src/core/clock.ts` 的 `resolveNow()`，全目录扫描守死 |

---

## 五、本轮最有价值的五个发现

1. **`pnpm ci` 是一条永远为绿的假闸门** —— 它是包管理器的内建 clean-install，会遮蔽同名 script。
   真正的门禁名是 `verify`，并由 `check-gate-entry.ts` 把「门禁的形状」本身变成机器可检的不变量。
2. **`better-sqlite3@13` 要求 Node ≥ 22** —— 工程师实测 Node 20 下直接段错误（ABI 不匹配，不是缺 FTS5）。
3. **验收工具本身必须被验收** —— 三个同族缺陷：抽取正则在 CRLF 文件上匹配不到 ⇒「跑通了但什么都没验」；
   门禁脚本名与文件名映射不一致；守卫只断言「文件存在」而不验行为。每个都补了负控。
4. **门禁只读一份文档 ⇒ 它的覆盖就等于那份文档的覆盖**（F-01）——
   实测「把计划文档的参数分类改回旧口径 ⇒ **6 条门禁全部 exit 0**」。
   ⇒ 凡是「同一规则写在几份文件里」，就要给**几份文件都配守卫**；否则副本就是漂移的温床。
5. **负控自己也可能是真空的**（QA 第四轮推翻了自己第二轮的证据）——
   `intensity()` 的两道钳制在正常输入下**行为等价**，任何「删掉一道」的断言都红不起来。
   ⇒ 判据要落到「它到底是因为什么而失败」；行为层无解时，**静态扫描**才是通用解。

---

## 六、用户下一步建议

1. **拉取最新**：`git pull --ff-only`（`origin/main`）。
2. **跑门禁**：`pnpm install --frozen-lockfile && pnpm run verify`
   （⛔ **不要用 `pnpm ci` / `npm ci`** —— 那是包管理器内建命令，会遮蔽同名 script 造成假绿）。
3. **务必使用 Node ≥ 22**：`better-sqlite3@13` 按 Node-API v10 构建，Node 20 上直接段错误。
4. **看进度**：`docs/progress/stage0-stage1-progress.md`（含 8 条已知边界与阶段 2 欠账清单）。
5. **看裁决**：`docs/design/adr-p1-conflicts.md`、`adr-p1-round2.md`、`adr-p1-t08-gaps.md`。
6. **下一步开发**：按 `DEVELOPMENT-PLAN.md` 的 **P2-T01**（向量分桶与路由）开工；
   ⚠️ P2-T03 的两条硬断言（**集合相等** + **先对账后开路**）是阶段 1 欠账的唯一清偿口。

---

## 七、诚实的边界

**阶段 2~5 共 28 个任务未开始**，不是「做完了但没写文档」。
本轮（P1）把阶段 0 的骨架真正变成了**可调用、可验证**的存储与召回实现：
10 个公开方法中 8 个已落地并被测试覆盖，门面 `MemoryStore` 与导出面收口正在并行补齐。

**没有为了赶进度而降低质量**：
- 阶段 1 **不写桶归属**（有向量但无桶归属）是**明写的阶段间交接**，不是遗漏 ——
  它的清偿口（P2-T03 的集合相等硬断言 + 先对账后开路）已经写进计划稿，
  左侧口径明确到「**全库**扫描」，不会退化成「本批次都进桶了」这种放不过欠账的假断言。
- 8 条已知边界全部写进了进度文档 §七，包括「只声明别名不声明关联 ⇒ 静默达不到召回目的」这一条
  —— 它是**我们自己选的边界**，代价明写，不藏。

---

## 八、积分与执行方式说明（如实记录）

本轮**无法查询 WorkBuddy 账号积分余额**（本机无对应工具：
`~/.workbuddy/usage-log.json` 只记录 skill/mcp 使用频次、不含余额；
邮箱通道未开通），因此**无法精确读数**。
代偿策略已执行：控制并行度（每条开发线一个 worktree）、压缩轮次（每轮合并即落盘提交并推送 `origin/main`）、
优先保住「文档 + 程序一并上传」这一终态交付物。
⇒ **若接近阈值，请提前告知**，我会立即停止程序开发、转入文档收尾与上传。
</content>
