# 阶段 0 / 阶段 1 交付进度与遗留清单

> **记录时点**：2026-10-31 12:05（Asia/Shanghai）
> **基线 commit**：`66826ff`（`origin/main`）
> **本文件是交接文档**：任何接手者读完它，应当能直接开工，不需要回放对话。
>
> ⚠️ **本文件每轮刷新**：阶段 1 的收官工作并行推进中（多条开发线同时在跑），
> 下面的「⏳ 进行中」一节会随合并推进而变。**最新状态以文件末尾的「本轮更新日志」为准。**

---

## 一、一句话状态

**阶段 0 全完成**（6 个任务 + 收尾修复 + 设计稿回写，且经 QA **四轮独立复核**）；
**阶段 1 的 9 个既有任务全部落地**，新增 **P1-T10（门面 + 导出面）已交付并合并**；
**阶段 1 收官的其余 5 项并行补齐工作在进行中**（基线等价验收 / recall 打分层收尾 / 六条口径落地 / 静态守卫 / ADR 回写）。
门禁全绿：`pnpm run verify` 退出码 0，**28 个测试文件 / 569 条测试**。

---

## 二、任务完成度总表

图例：✅ 完成 · 🟡 进行中 · ❌ 未开始

### 阶段 0（骨架与不变量）

| 阶段 | 任务 | 状态 | 落点 commit | 备注 |
|---|---|---|---|---|
| 0 | P0-T01 工程基线与脚手架 | ✅ | `32fa697` | |
| 0 | P0-T02 参数表与跨参数校验 | ✅ | `3e8086c` | 60 项 / 8 条跨参数校验 |
| 0 | P0-T03 五个机制开关与基线不变量 | ✅ | `8b234b2` | |
| 0 | P0-T04 事件流扩展（扩 payload 键） | ✅ | `963b2e0` | 不新增 `type` |
| 0 | P0-T05 错误类型体系与时钟注入 | ✅ | `698094d` | 封闭五码 |
| 0 | P0-T06 CI 契约断言脚本骨架 | ✅ | `811258f` | 5 条契约脚本 |
| 0 | P0-T07 收尾（门禁可见性 + 脚本补强） | ✅ | `e174fb4` `4e5cfb3` `07e7924` `7c98987` | 门禁入口守卫 + CI 工作流 + QA F-01~F-03 修复 |

### 阶段 1（存储与基础运算）

| 阶段 | 任务 | 状态 | 落点 | 关键文件 |
|---|---|---|---|---|
| 1 | P1-T01 Schema 建库脚本与连接初始化 | ✅ | `32fa697` 起 | `src/core/schema.ts`、`src/db/schema.sql.ts`、`src/db/connection.ts` |
| 1 | P1-T02 v1 → v2 迁移（纯增量） | ✅ | 同上 | `src/db/migrate.ts`（阶段 A/B 两步，可重入） |
| 1 | P1-T03 文本路：中文 Bigram 分词与 FTS5 查询构造 | ✅ | `acaaf24` | `src/core/tokenize.ts`（6 个纯函数，零依赖） |
| 1 | P1-T04 纯函数算法模块（衰减 / 强度 / 层级 / 边权） | ✅ | `a1cf013` 前 | `src/core/decay.ts`、`stability.ts`、`graph.ts`、`entities.ts` |
| 1 | P1-T05 图谱维护：link / linkByIds / setAlias / mergeEntities | ✅ | `6c42af3` `e1b1eef` `67ef84e` | `src/store/link.ts`、`src/store/entities.ts` |
| 1 | P1-T06 growStability 与 touch（唯一 stability 写入点） | ✅ | `d3a19e1` | `src/core/stability.ts`、`src/store/touch.ts` |
| 1 | P1-T07 write 写入路径（去重与合并） | ✅ | `6989fdb` `0d626d2` `7f78d45` | `src/store/write.ts`（977 行）、`src/store/merge.ts`（359 行） |
| 1 | P1-T08 recall：三路召回与融合打分 | ✅ 代码已合并 | `5f42889` `0d3bb1e` `dcc35bb` `74a7402` | `src/store/recall.ts`、`src/core/scoring.ts`—— 打分层收尾（归档分支删除）在跑 |
| 1 | P1-T09 get() 与阶段 1 基线不变量验收 | 🟡 | `e58384f` `ea875f2` | `src/store/get.ts` 已完成；**基线等价测试在建** |
| 1 | **P1-T10 门面 `MemoryStore` + 导出面收口** | ✅ **已合并** | `dd5ea79` | 新建 `src/store/MemoryStore.ts`（364 行）+ `src/index.ts` 导出面 + 461 行测试 |
| 1 | P1-T07 收尾项：六条口径签字落地 | 🟡 | `0169767` `5f65bbc` | C 口径三版收敛后已终裁，在改 |

### 阶段 2 ~ 5（28 个任务）

❌ **未开始**（阶段 2 向量分桶与路由 / 阶段 3 神经元交互 / 阶段 4 召回质量回归 / 阶段 5 前台与导出）。

---

## 三、门禁与工程现状

| 项 | 状态 |
|---|---|
| **真实门禁入口** | **`pnpm run verify`**（`pnpm run ci` 是它的别名）。⛔ **`pnpm ci` / `npm ci` 是包管理器内建命令（clean install），会遮蔽同名 script ⇒ 假绿** |
| 门禁链 | `typecheck` → `lint`(biome) → `test`(vitest) → `check:params` → `check:payload-keys` → `check:clock` → `check:anchor` → `check:contract-ids` → `check:doc-counts` |
| 测试规模 | **28 个测试文件 / 569 条测试**，全通过，无 `Errors` 行 |
| 源码规模 | `src/` 29 个源文件 / 9070 行（不含测试） |
| 测试规模 | `tests/` 31 个文件 / 10506 行 |
| 契约脚本 | 6 条（`check:params` / `check:payload-keys` / `check:clock` / `check:anchor` / `check:contract-ids` / `check:doc-counts`）+ `check-gate-entry.ts` |
| CI | `.github/workflows/ci.yml`：Node 22 + pnpm 12.16.1，`pnpm install --frozen-lockfile` + `pnpm run verify` + build 两个 job |
| 构建 | `pnpm build` 通过（tsup：CJS + ESM + d.ts） |
| 运行时 | better-sqlite3 v13（Node-API v10 ⇒ **必须 Node ≥ 22**）；vitest 4.1.12（`pool: 'forks'` 是硬性要求，原生模块在 threads 池会段错误） |

---

## 四、阶段 0 独立复核结论（QA 四轮）

报告：`docs/quality/stage0-recheck.md`（1021+ 行）· `docs/quality/stage0-verification.md`

- **第一轮（基线 `a1cf013`）**：判定 **PASS_WITH_FINDINGS**，运行时 **NoOne**（源码无 Bug）。
  **33 组破坏性负控**（改真实设计稿 / 源码，不是喂假值）全部按预期报红。
- **第二轮（`7c98987`）**：QA 的 F-01 ~ F-03 已修，且**修复本身经负控实测是真守卫**。
- **第三 / 四轮**：QA **推翻了自己第二轮的错误证据**（第二轮那份 `min(1,…)` 负控是真空的），
  把 F-08 拆成 ①②③④ 并给出**最小探针 2**（`τ<0 且 Δt<0`）——这是本库负控方法论的一次重要修正。

**P0 期间确认修好的三个同族缺陷**：
① CRLF 抽取失配 · ② npm script 名拼文件名 · ③ 守卫只断言「文件存在」而不验行为。

---

## 五、阶段 1 的关键设计裁决（ADR）

| 文件 | 内容 |
|---|---|
| `docs/design/adr-p1-conflicts.md` | P1-T05/T06 暴露的 **7 条冲突 + 6 条额外发现（F-1~F-6）** 的逐条裁决 |
| `docs/design/adr-p1-round2.md` | **第二轮 10 条裁决**（别名隐含关联 / `confidence` 与 `emotion` 的不对称 / `link` 校验次序 …） |
| `docs/design/adr-p1-t08-gaps.md` | P1-T08 的两处设计稿缺口 + 三条小口径（`entityNames` 入口、归档模式、`Hit.from*`） |

**最要紧的三条**（都写进了 `DEVELOPMENT-PLAN.md`，不只是 ADR）：

1. **§9.3.0.1「唯一合并写入点」**：不是「步骤 3c」，而是「**步骤 2 / 3c 的合并写入序列**」
   ⇒ 步骤 2 的向量回填也在同一条路径上（全库仅一处 `UPDATE memories SET embedding`）。
2. **归档模式**：`includeArchived=true` 时**强度精筛整体不执行**（不是「阈值改成 0.0」）
   ⇒ 原文的 0.0 阈值会把「intensity 因 exp 下溢成恰好 0.0」的行挡掉 ⇒「显式查询归档层」名存实亡。
3. **库内不得做实体抽取**：`RecallOptions.entityNames` 显式入口 + 与 `entityIds` **互斥**
   ⇒ 两者都不传 ⇒ 图谱路为空（ADR-2 明写并接受的代价）。

---

## 六、⏳ 进行中（阶段 1 收官，5 条线并行）

| # | 事项 | 负责人 | 文件域 | 状态 |
|---|---|---|---|---|
| 1 | P1-T07 六条口径落地（C 终裁 + 新增 warning `ALIAS_TARGET_NOT_LINKED`） | 工程师-4 | `write.ts` `merge.ts` `entities.ts` | 进行中 |
| 2 | recall 打分层收尾（删 `archiveFilterThreshold` 的归档分支 + 归档跨度 import） | 工程师-5 | `scoring.ts` | 进行中 |
| 3 | `MS_PER_DAY` 定义下沉 + F-08 ③ 静态守卫（`scripts/check-clamp.ts`） | 工程师-3 | `decay.ts` `util/time.ts` `log.ts` `package.json` | 进行中 |
| 4 | P1-T09 基线等价验收 | QA | `tests/baseline/ref-v1.ts` `v1-equivalence.test.ts`（新） | 进行中 |
| 5 | ADR-P1-T07-DEC 的 D-3 改写 + `ALIAS_TARGET_NOT_LINKED` 三处同步 + `MS_PER_DAY` 分层裁决 | 架构师 | `docs/design/**` `scripts/check-contract-ids.ts` | 进行中 |
| — | `extractEntityNames` 纳入导出面 | 工程师（线A） | `src/index.ts` | 进行中 |

---

## 七、已知边界与欠账（**必须随阶段 2 一起消化**）

| # | 欠账 | 性质 | 归属 |
|---|---|---|---|
| 1 | **阶段 1 不写桶归属**：有向量但无桶归属的记忆必然存在（阶段 1 没有细桶，桶行会被 FK 直接拒绝） | 阶段间交接 | P2-T03 的**集合相等硬断言**（左侧口径：**全库** `embedding IS NOT NULL AND deleted = 0`）+ 启动对账 + 首次重训 |
| 2 | **静态断言只保证「阶段 1 不写桶」，不保证「阶段 2 写了桶」** | ⚠️ 静默失效点 | 必须靠 P2-T03 自己的集合相等断言兜底 |
| 3 | `alias` 事件的 `aliasAdded` = **布尔**，源主名本体记在 `alias` 键（C36：同一件事不得有两套词） | 已裁决 | 已落地 |
| 4 | `entityAliases[].name` 目标不存在 ⇒ **建但不隐含关联** ⇒ 只声明别名、不在 `entities` 点名的调用方**静默达不到召回目的** | ⚠️ 明写的代价 | 文档已写明；若要加 `warnings` 需同步改 `EXPECTED_WARNING_ONLY_CASES` 白名单 |
| 5 | 库未校验 `stability > 0`（F-08 ④） | 独立问题 | 阶段 2 的参数/校验面 |
| 6 | `intensity()` 两道钳制在正常输入下**行为等价** ⇒ 行为层无解 | 已知方法论边界 | F-08 ③ 的**静态扫描**守卫（工程师-3 落地中） |
| 7 | `LIMIT 100` / `slice(0,20)` / `topN ∈ 1~8` **刻意硬编码**，不进参数表 | 设计决定 | 改它们是设计变更，走 ADR |
| 8 | `stats()` **不在阶段 1 的 10 个方法内**且未实现 ⇒ 基线断言顺延 | 计划口径 | 已收敛进 `DEVELOPMENT-PLAN.md` |

---

## 八、环境与并行纪律（本轮踩过的坑，务必读）

1. **`pnpm ci` / `npm ci` 是包管理器内建命令（clean install）**，会遮蔽同名 script ⇒ **永远用 `pnpm run verify`**。
2. **不要在主工作树 `D:/Git/repo` 跑 `pnpm install` / `pnpm ci`**：
   它会重写 `node_modules/.bin` 的 shim，把**同时在跑的其他人的门禁打断**
   （本轮实测：`vitest` 启动路径被冲成 `p0\..\vitest\vitest.mjs` ⇒ 报「系统找不到指定的路径」⇒ 一次**假失败**）。
   ⇒ **每条线一个 worktree，门禁只在自己的 worktree 跑**；主工作树只用于合并与合并态验证。
3. **worktree 隔离**：`git worktree add <路径> -b <分支> origin/main` + `pnpm install --frozen-lockfile`（pnpm store 命中，**实测 6.4s**）。
4. **主工作树里的 `git status` 不能作为「谁在改什么」的判据** —— 提交归属一律以 `git log` / `git show --name-only` 为准
   （本轮出现过架构师把别人的提交记到自己名下的情况）。

---

## 九、接手者的开工顺序（阶段 1 收官 → 阶段 2）

1. 等 §六 的 6 条线合并到 `main`，跑一次**合并态** `pnpm run verify`（退出码 0 + 测试计数），
   并把计数写回本文件「本轮更新日志」。
2. 按 `DEVELOPMENT-PLAN.md` 的 **P2-T01** 开工：向量分桶与路由。
   ⚠️ P2-T03 的两条硬断言（集合相等 + 先对账后开路）是阶段 1 欠账的**唯一清偿口**，不要漏。
3. 设计权威永远是 `docs/design/DESIGN-v2.md`；`DEVELOPMENT-PLAN.md` 是任务分解；
   ADR 文件是裁决记录。**三处冲突时以 DESIGN-v2 为准，并补 ADR。**

---

## 本轮更新日志

- **11:40** —— 合并 `e1b1eef`（link 自校验补 `deleted = 0`）、`f2d1b1d`+`32fdb38`（粗筛窗口上提 scoring）、
  `0d626d2`+`dcc35bb`+`7f78d45`（步骤 3a 候选口径断言 + recall 复用 scoring 唯一实现）；
  架构师两轮 ADR（`fed2796` `20bfc4f` `8e7ba39`）；本人落 `651dac8`（计划稿收口）。
- **12:05** —— 合并 `74a7402`（recall 契约：entityNames 入口 + 归档模式不判强度 + from* 标记）、
  `77eacc0`（归档跨度收敛到 decay.ts 唯一实现）、`dd5ea79`（**P1-T10 门面 + 导出面**）、
  `9b82e54`（只读错误码映射 + reinforce 守卫 + F-01 残余「计划稿副本纳入门禁」）；
  计划稿与 ADR 收口 `651dac8`/`2d85753`/交付文档刷新 `205e6a1`。
  **门禁：28 文件 / 569 测试，退出码 0**。
- **C 口径三版收敛（值得单独记）**：① 我签的「同等待遇都关联」⇒ 否（关联有两处表达，违 §14.3）；
  ② 架构师 D-3 的「新建关联、既有不关联」⇒ 否（**历史依赖**：同输入不同结果 = 静默漂移）；
  ③ **终裁：命中与新建都不关联**，但写路径返回一条 **warning `ALIAS_TARGET_NOT_LINKED`**
  ⇒ **边界可以存在，但必须可观测。**
</content>
