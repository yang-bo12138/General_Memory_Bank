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

## 六、⏳ 进行中（阶段 1 收官，6 条线并行）

| # | 事项 | 负责人 | 文件域 | 状态 |
|---|---|---|---|---|
| 1 | P1-T07 六条口径落地（C 终裁 + 新增 warning `ALIAS_TARGET_NOT_LINKED`） | 工程师-4 | `write.ts` `merge.ts` `entities.ts` `errors.ts` | **已合并**（`90fec7c`）⇒ 剩 `errors.ts` 白名单 + `scoring.ts` 副本 |
| 2 | recall 打分层收尾（删 `extractEntityNames` + 归档跨度 import + 负控②） | 工程师-5 | `recall.ts` `scoring.ts` `tests/unit/recall.test.ts` | 进行中（**主理人已终裁删除方向**） |
| 3 | `MS_PER_DAY` 定义下沉 + F-08 ③ 静态守卫（`scripts/check-clamp.ts`） | 工程师-3 | `decay.ts` `util/time.ts` `log.ts` `package.json` | **已合并**（`b2281da` + `a00d944`） |
| 4 | P1-T09 基线等价验收 | QA | `tests/baseline/ref-v1.ts` `v1-equivalence.test.ts`（新） | **已交付**（`6196a15`）⇒ 剩改名 + 四组实测 |
| 5 | ADR-P1-T07-DEC 的 D-3 改写 + `ALIAS_TARGET_NOT_LINKED` 三处同步 + `MS_PER_DAY` 分层裁决 + `extractEntityNames` 阶段归属终裁 | 架构师 | `docs/design/**` `scripts/check-contract-ids.ts` | 进行中 |
| 6 | **门禁盲区守卫**：源码实发 warning code ⊆ 白名单 | 工程师-2 | `scripts/check-contract-ids.ts` | 进行中（**主理人本轮新发现**） |
| — | `extractEntityNames` 纳入导出面 | 工程师（线A） | `src/index.ts` | **已撤回**（`fc44abe`）⇒ 终裁：阶段 1 不实现 |

### 6.1 ★ 本轮主理人裁决记录（三处 ADR/文档冲突的收敛）

| # | 冲突 | 裁决 | 依据 |
|---|---|---|---|
| 1 | `extractEntityNames` 的阶段归属：ADR-P1-T08-GAP C-1.3「推荐 A 导出」**vs** ADR-P1-T07-DEC D-1「阶段 1 不实现」 | **阶段 1 不实现、不进导出面** | C-1.3 写的是「二选一，我推荐 A」⇒ 是**建议**；D-1（`2d85753`，**更晚**）是**正式裁决**；且 **DESIGN-v2.md §4.6 步骤 1 正文（:1185）已按 D-1 落笔**「⚠️ **阶段 1 不实现它**……⇒ **本节只留口子**」⇒ 正文即权威（C36：两份 ADR 口径相反本身就是缺陷） |
| 2 | `ALIAS_TARGET_NOT_LINKED` 的三处同步 | **必须三处全改**：`src/core/errors.ts` 的 `WARNING_ONLY_CASES` + `scripts/check-contract-ids.ts` 的 `EXPECTED_WARNING_ONLY_CASES` + DESIGN §11.2 表格（**反引号包住**） | 门禁 `compareNameSets` 做三方比对 ⇒ 少一处即红 |
| 3 | 基线参考实现的 `REF_MS_PER_DAY` 是否 import 库的 `MS_PER_DAY` | **不 import**（参考实现必须独立于被审对象） | 若 import，将来 `MS_PER_DAY` 改错 ⇒ 参考实现**跟着一起错** ⇒ 基线**静默**退化成「当前实现的语义」⇒ 循环论证。⇒ 改为加一条**漂移可见**的断言（两侧当前相等，但漂移会让基线立刻红） |

### 6.2 ★ 本轮主理人新发现的门禁盲区（已派单修）

**现象**：合并「工程师-4 的 C 终裁」后，`src/store/write.ts` 已发出**两个** warning code（`ALIAS_CONFLICT` + `ALIAS_TARGET_NOT_LINKED`），而三处白名单**全都还只有 `ALIAS_CONFLICT`** ⇒ **门禁仍全绿**。

**根因**：`scripts/check-contract-ids.ts` 只做**三方互相比对**（白名单 ↔ 源码常量 ↔ 文档表格）⇒ **从不去检查「源码里实际发出的 warning code 集合」** ⇒ 新加一个 code 而忘了登记 ⇒ **门禁完全看不见**。

⇒ 这是 **C36「同一件事不得有两套词」的经典漏洞**：warning code 这个「键」有**两处**来源（`src/store/write.ts` 的判别字面量 + `src/core/errors.ts` 的白名单数组），门禁只保证它们**各自与文档一致**，不保证它们**彼此一致**。
⇒ **已派单**：补一条「源码实发 warning code ⊆ 白名单」的守卫 + **负控**（塞入未登记 code ⇒ 守卫必须报红）。

---

## 七、已知边界与欠账（**必须随阶段 2 一起消化**）

| # | 欠账 | 性质 | 归属 |
|---|---|---|---|
| 1 | **阶段 1 不写桶归属**：有向量但无桶归属的记忆必然存在（阶段 1 没有细桶，桶行会被 FK 直接拒绝） | 阶段间交接 | ✅ **已闭环**（阶段 2 消化）：P2-T03 的**集合相等硬断言**（左侧口径：**全库** `embedding IS NOT NULL AND deleted = 0`）+ P2-T05 的 `rebuildVectorBuckets`（重训 + 全量重分配）+ P2-T06 的启动对账 |
| 2 | **静态断言只保证「阶段 1 不写桶」，不保证「阶段 2 写了桶」** | ⚠️ 静默失效点 | ✅ **已闭环**（阶段 2 消化）：`tests/unit/bucketSync.test.ts`（四条 embedding 赋值路径**逐条**断言桶归属同步）+ `tests/unit/bucketAssign.test.ts`（换桶不残留 / 未传向量删归属）+ `check:bucket-write` 门禁（裸桶表 SQL 只许出现在唯一写入点） |
| 3 | `alias` 事件的 `aliasAdded` = **布尔**，源主名本体记在 `alias` 键（C36：同一件事不得有两套词） | 已裁决 | 已落地 |
| 4 | `entityAliases[].name` 目标不存在 ⇒ **建但不隐含关联** ⇒ 只声明别名、不在 `entities` 点名的调用方**静默达不到召回目的** | ⚠️ 明写的代价 | ✅ **已闭环**：新增 warning `ALIAS_TARGET_NOT_LINKED`（一个 `name` 一条）⇒ 边界可观测；**四处**白名单/镜像同步中（`errors.ts` + `check-contract-ids.ts` + DESIGN §11.2 + 两处测试镜像） |
| 5 | 库未校验 `stability > 0`（F-08 ④） | 独立问题 | ⚠️ **措辞订正**（阶段 2 核对）：**库层其实有校验** —— `src/db/schema.sql.ts:78` 是 `stability REAL NOT NULL CHECK (stability > 0)` ⇒ 真正缺的是**应用层**的校验（写路径是否在入库前就拦住 ≤ 0）。**既有问题，未扩大** |
| 6 | `intensity()` 两道钳制在正常输入下**行为等价** ⇒ 行为层无解 | 已知方法论边界 | ✅ **已闭环**：`scripts/check-clamp.ts`（**数据流判据**，堵住「补无关同形态调用」的绕过）+ 行为层探针（负 τ + 1 天偏移，分辨力 0.63） |
| 7 | `LIMIT 100` / `slice(0,20)` / `topN ∈ 1~8` **刻意硬编码**，不进参数表 | 设计决定 | 改它们是设计变更，走 ADR |
| 8 | `stats()` **不在阶段 1 的 10 个方法内**且未实现 ⇒ 基线断言顺延 | 计划口径 | 已收敛进 `DEVELOPMENT-PLAN.md` |
| 9 | **`extractEntityNames` 阶段 1 不实现**（ADR-P1-T07-DEC D-1）⇒ 设计稿 §4.6 只留口子 | 已裁决 | ✅ 已落地（删除函数 + 删除导出 + 导出面守卫） |
| 10 | 门禁**曾经**看不见「新增 warning code 未登记白名单」 | ⚠️ **静默失效点** | ✅ **已闭环**：`scripts/check-contract-ids.ts` 补「源码实发 warning code ⊆ 白名单」守卫 ⇒ **已在实战中生效**（登记缺失 ⇒ verify EXIT=1） |
| 11 | 门禁只认 `code: 'XXX'` **字面量** ⇒ 动态实参（`code: someVar`）判不了 | 类型层加固 | ✅ **类型层已收紧**（阶段 2 核对）：`src/core/errors.ts:71` 的构造签名**已经是** `constructor(code: MemoryErrorCode, ...)`，且 `MemoryErrorCode` 是**封闭的 5 值联合类型** ⇒ 「指定治法」已完成。**剩余的只是门禁的判据还是形状匹配**（`check-contract-ids.ts` 扫源码里的字面量）⇒ 那不是类型层的事 ⇒ 归入「门禁盲区」类 |
| 12 | `archiveFilterThreshold(params, true)` 在归档模式下返回 `0.0` | ⚠️ **静默失效点** | ✅ **已改**：改为抛 `INVALID_INPUT`（0.0 仍是阈值 ⇒ 会把 `intensity === 0` 的归档记忆挡掉 ⇒ 静默少召回） |
| 13 | 归档模式下**粗筛窗口取 0** ⇒ 候选池放大 | 性能 | **阶段 2**（向量路范畴）；阶段 1 的 `topN ∈ 1~8` + `LIMIT 100` 已兜住上限 |

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

1. ~~等 §六 的 6 条线合并到 `main`~~ ⇒ **已完成**（8 条线全部合并，合并态门禁 **31 文件 / 634 测试，EXIT=0**）。
2. 按 `DEVELOPMENT-PLAN.md` 的 **P2-T01** 开工：向量分桶与路由。
   ⚠️ P2-T03 的两条硬断言（集合相等 + 先对账后开路）是阶段 1 欠账的**唯一清偿口**，不要漏。
3. 设计权威永远是 `docs/design/DESIGN-v2.md`；`DEVELOPMENT-PLAN.md` 是任务分解；
   ADR 文件是裁决记录。**三处冲突时以 DESIGN-v2 为准，并补 ADR。**

### 9.1 阶段 2 开工前必须先落地的四条接口派单（工程师-5 提出，主理人已裁决采纳）

⚠️ 这四条是**阶段 1 留下的、阶段 2 必须接上的接口边界** ⇒ **P2-T01 开工前就要定好**，否则向量路接进来时会撞车。

| # | 派单 | 为什么现在就要定 | 归属 |
|---|---|---|---|
| 1 | **`coarseGateWindow()` 的返回值形状扩展** ⇒ 增加 `coarseFilterSql` / `coarseFilterParams` / `coarseFilterEnabled` 三个字段 | 阶段 2 的向量路要**复用同一对窗口值**（§4.15.2 的 `VectorFilter.timeFloor` / `pinnedTimeFloor`）⇒ 若向量路自己拼一份过滤条件 ⇒ **铁律①（三路一视同仁）就破了**⇒ 窗口**必须**是同一个出处 ⇒ 扩展形状时**必须**同时给出「SQL 侧片段」与「向量后端侧的等价谓词」，**两份表述必须逐位对应** | P2-T01 |
| 2 | **`coarseGateWindow()` 的 `now` 改成必传** | 现在 `now` 可选 ⇒ 缺省取真实时钟 ⇒ **两个不同调用点可能落在毫秒边界两侧** ⇒ 粗筛窗口不一致 ⇒ **三路的准入闸门不再一视同仁**（且不报错）⇒ 阶段 2 的向量路与文本路若一个显式传、一个缺省 ⇒ **同一批候选在两路被不同判定** | P2-T01 |
| 3 | **`mergeCandidates()` 收进公共层** | 阶段 1 已有 `TODO(P2)` 标注（`src/store/recall.ts`）⇒ 阶段 2 向量路接上后**同一个 id 会被三路各捞一次** ⇒ 必须有**唯一**的去重点 ⇒ 否则「向量路那条被保留、文本路那条被丢」⇒ **分数与来源标记会自相矛盾**（同一条记忆两个来源标记） | P2-T01 |
| 4 | **三道闸门（`deleted` / 粗筛窗口 / 强度精筛）的编排固化到 `scoring.ts`** | 现在三道闸门**分散**在 `recall.ts`（粗筛 SQL 片段）与 `scoring.ts`（强度阈值）⇒ 向量路接进来时**必然要在第三处再写一遍** ⇒ 而那第三处**没有任何守卫** ⇒ 「向量路绕过闸门」这个最坏故障就会**静默**发生 | P2-T01 |

⇒ **判据**：这四条都不是「优化」，而是**「同一件事只能有一处」**（C36）在阶段 2 的延伸 ⇒
⇒ 阶段 2 的向量路**只允许**读 `scoring.ts` 提供的那一份，**不得**自己算窗口 / 自己拼过滤条件。

### 9.2 阶段 2 顺带清掉的同类漂移（低风险，但现在记下免得忘）

| # | 欠账 | 说明 |
|---|---|---|
| 1 | **源码注释里还有 8 处写死「60 项」**（`src/store/pin.ts:33`、`src/store/recall.ts:49/51/105/118`、`src/store/write.ts:57` 等） | 那是「参数个数」的**第二份定义**（C36）⇒ **参数表在阶段 2 会增长** ⇒ 那时这些注释**必须**改 ⇒ 阶段 2 顺带清掉。⚠️ 面门面 `MemoryStore.ts` 的两处**已在阶段 1 清掉**（`dc4dbcb`）⇒ 只给指针（`PARAM_COUNT` 那个符号） |

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
