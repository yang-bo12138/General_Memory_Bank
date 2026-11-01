# P3-T06 · 阶段 3 单测与基线复验 · 对抗式验收报告

> 验收人：**software-qa-engineer-2（严过关 / Yan）**｜日期：2026-11-02
> 被审对象：`origin/main` = `b80cf3c`（已含 P3-T01 ~ P3-T05）
> 计划来源：`docs/design/DEVELOPMENT-PLAN.md` **P3-T06**（§12 阶段 3 的四条单测要求 + 验收标准）
> 验收分支：`qa/p3-t06-acceptance`｜工作树：`D:/Git/wt/qa-p3-t06`
> ⚠️ **本报告只含验收结论**：每条结论都指到 `文件:行` + 可复制的命令。

---

## 〇、总览与智能路由判定

| 项 | 结论 |
|---|---|
| **智能路由判定** | **🔴 `Engineer`（源码有 Bug · 2 处）** —— 见 §四。**其余全部通过**：<br>① §12 阶段 3 的**四条单测要求**逐条补齐并通过（`tests/unit/neuro.test.ts`，10 条）；<br>② 「关掉开关 ⇒ 与 v1.0 逐位一致」的**逐开关复验**完成（`tests/baseline/v1-equivalence-stage3.test.ts`，9 条）；<br>③ QA 上一轮留的账（攻击面 E 的恒绿守卫）**已关闭**（`tests/unit/inhibit-acceptance.test.ts` 的 `E1` + 新增 `E2`）。 |
| **两处源码缺陷** | **D-1** `coactivation=false` ⇒ 主题簇**仍被计算并发布**（§5 明写「簇不计算也不使用」）<br>**D-2** `writeBack=false` ⇒ `touch` 的 `coActivateWith` **仍写因果边**（§5 明写「`touch` 的 `coActivateWith` 交叉强化不发生」） |
| 变异总数 | **12**（攻击面 E 三条 + P3-T04 四条 + P3-T05 五条） |
| 变异打红率 | **11/12 = 92%**（唯一未打红的是 **M-T05-4**，经**前提审计**判定为**等价变异**，见 §三·3） |
| 还原校验 | **12/12 = `RESTORE-OK`**（`cp` + `sha256` + 逐字节比对；**未用** stash/restore/checkout） |
| 生产代码改动 | **0**（`git diff --stat HEAD -- src/` 为空 ⇒ QA 未碰 `src/**`） |
| 门禁 | `pnpm run verify` **EXIT=0**；52 测试文件 / **1041 通过** + 2 `expected fail`（基线 50 / 1023 ⇒ 本轮 **+2 文件 / +18 通过**） |
| 缺陷守门 | 两处缺陷各由**一条 `it.fails`** 登记 ⇒ **修好后它们会反过来变红**（提醒摘掉标记） |

---

## 一、§12 阶段 3 四条单测要求的覆盖对照表

> §12 阶段 3 原文：「单测覆盖：**共激活强化不震荡、侧抑制不误杀、簇分裂/合并、抑制关闭后与 v1.0 逐位一致**」。

| # | §12 的要求 | 已覆盖（原有） | **仍未覆盖** | 本轮补齐 | 落点 |
|---|---|---|---|---|---|
| ① | **共激活强化不震荡** | `tests/unit/coacts.test.ts`「饱和阻尼：Δ = base × (1 - affinity_old / MAX)」（**只验单步增量**）<br>「上限钳制：`affinity_new <= COACT_AFFINITY_MAX` 恒成立」 | ⚠️ **三条都缺**：<br>(a) **结构式恒等式** `(1 - a_new/MAX) == (1 - a_old/MAX) × (1 - base/MAX)`（误差 ≤ 1e-12）——计划 P3-T06 **明文要求**的形状<br>(b) **单调不减**（反复强化 ⇒ 不降）<br>(c) **「被钳后本次实际增量不再等于 base」**这条边界（计划 P3-T06 的警告） | ★ `N1`（结构式 + 单调 + ≤ MAX + 钳制前提自检）<br>★ `N1b`（钳制边界） | `tests/unit/neuro.test.ts` |
| ② | **侧抑制不误杀** | `tests/unit/inhibit.test.ts`「簇**不参与判定**」（**同类但不同形**：它验的是「同簇不冗余」）<br>`tests/unit/inhibit-acceptance.test.ts` `G1`（同簇但逐对不冗余） | ⚠️ **§12 点名的那个场景缺**：三条各只共享**一个**实体（「张三」）⇒ **全部保留**。<br>⚠️ 现有用例都用了**两个**共享实体 ⇒ **不覆盖「共享 1 个 ⇒ 不冗余」这条判据边界** | ★ `N2`（张三三条全部保留 + **前提自检：每对只共享 1 个实体 < `DEDUP_ENTITY_MIN`**）<br>★ `N2b`（**对照组**：共享 2 个实体的那对**确实**被挤掉 ⇒ 证明 `N2` 不是「抑制没跑」的假绿） | `tests/unit/neuro.test.ts` |
| ③ | **簇分裂 / 合并** | `tests/unit/cluster.test.ts`「分裂时新簇沿用原簇 id 的一半 + 新后缀」（**纯函数的 id 派生**）<br>「兜底切分」（**按比例切**，不是按衰减切）<br>`tests/integration/recluster.test.ts`「衰减到门槛下的边不计入簇」（**边掉出**，但结果是一段变孤岛，**不是「一簇裂成两簇」**） | ⚠️ **两个可观察行为都缺**：<br>(a) **「簇分裂」**：一条边衰减到阈值以下 ⇒ **一簇裂成两簇**（两段**都非空**）<br>(b) **「簇合并」**：构造新边连接两个簇 ⇒ **两簇并成一簇** | ★ `N3`（分裂：4 条链 `a—b—c—d` 的中间边衰减 ⇒ **裂成 `{a,b}` 与 `{c,d}` 两簇**）<br>★ `N4`（合并：新边接上 ⇒ **并成一簇**）<br>★ `N6`/`N7`（重算**真的发布了快照** + 存储成员数与成员表一致） | `tests/unit/neuro.test.ts` |
| ④ | **抑制关闭后与 v1.0 逐位一致** | `tests/unit/inhibit.test.ts`「`inhibition` 开关关闭时：候选带**不重排**，直接按 base 分取 topN」（**只验顺序**）<br>`tests/unit/inhibit-acceptance.test.ts` `F1`（顺序 + 分数单调） | ⚠️ **缺「逐字段全等」**：分数、breakdown 五项、`fromText/fromVector/fromGraph`、事件的 `hitIds`/`scores` **都没有逐位比**。<br>⚠️ 且**没有与 v1.0 参照实现比对**（现有断言比的是「抑制开 vs 抑制关」，不是「关掉 vs v1.0」） | ★ `N5`（hits 的 id 序列 + 每条 score + breakdown + 三个来源标记 **逐字段全等**）<br>★ `N5b`（抑制开 / 关 ⇒ **每一条候选**的分数逐位相同）<br>★ `tests/baseline/v1-equivalence-stage3.test.ts` ①（见 §二） | `tests/unit/neuro.test.ts` + `tests/baseline/v1-equivalence-stage3.test.ts` |

> ⚠️ **「仍未覆盖」栏为空 ⇒ 本轮把 §12 阶段 3 的四条要求全部补齐。**

---

## 二、「关掉开关 ⇒ 与 v1.0 逐位一致」的逐开关对照表

> ⚠️ **为什么要有这张表**：`tests/baseline/v1-equivalence.test.ts`（P1-T09）已证明「**四个开关全关** ⇒ 与 v1.0 逐位一致」（**联合基线**）。
> ⇒ 但联合基线**回答不了**「**单独**关掉某个开关 ⇒ 那条能力**彻底不生效**吗？」——
> 而后者才是「每个开关都能独立当 A/B 对照的基线」的真正含义（§5 用途栏：「**A/B 对照的基线开关**」）。
> ⚠️ **「逐位」的口径**：**逐字段 `toBe`（不是 `toBeCloseTo`）** + **表内容哈希**（行数 + 全部列）。

| 开关 | 关掉后的**等价对象**（v1.0 的哪一部分） | 逐位比对的范围 | 结论 |
|---|---|---|---|
| **`inhibition`**（侧抑制） | v1.0 的召回：**候选带不重排**，直接按 base 分取 topN | hits 的 **id 序列** + 每条的 **score** + **breakdown 五项** + `fromText/fromVector/fromGraph` + 事件的 `hitIds`/`scores`/`suppressedIds` | ✅ **通过**（`v1-equivalence-stage3.test.ts` ①）<br>⚠️ 前提自检：`inhibition=true` 时**确实**挤掉一条（`v-2`）⇒ 不是「两边都没变」的平凡比较 |
| **`coactivation`**（共激活 / 联想路） | v1.0：**没有共激活这张表** ⇒ `coacts` **不被写入**、联想路**不执行** | `coacts` 表**内容哈希前后逐位相同** + `diffused` **恒空** + 命中序列与事件 | ✅ **通过**（②）<br>🔴 **但「主题簇不计算也不使用」这一半失败 ⇒ 见 §四 D-1** |
| **`writeBack`**（激活回写） | v1.0：**「扩散唤起 → 采纳 → 回写」的联动不存在** ⇒ `touch` 只加固不写因果边 | `coacts` 表内容哈希**逐位不变** + `stability` **仍增长** + 事件的 `stabilityDelta` **非零** | ⚠️ **一半通过、一半失败** ⇒ 见 §四 D-2<br>✅ 通过的那一半：「`growStability` 加固照常发生」（**`it`**） |
| **`ARCHIVAL_CACHE`**（归档缓存） | v1.0：`countArchived` 走**逐行精筛**（路径不同、结果相同） | ⚠️ **本轮不可验**：`countArchived` 是 §9.4 的**阶段 4** 实现（`src/store/archival.ts`）⇒ 本轮只验**结果口径不依赖开关**（同一批记忆在两种开关下的 `layer` 判定逐位相同） | ✅ **通过**（④）<br>⚠️ **登记为「阶段 4 补验」**（`countArchived` 落地后必须加「开关开 / 关 ⇒ 返回值逐位相同」） |
| **`VECTOR_ROUTER='flat'`**（向量路） | v1.0 的向量路（**整路缺席**是阶段 1 的事实） | `fromVector` **恒 false** + `vectorPart` **恒 0** + `cos` **恒 `null`** | ✅ **通过**（⑤） |
| **`diffuseArchived`**（§4.7 R-ARCH-DIFF 通道） | ⚠️ **不是机制开关**（是 `RecallOptions` 字段）⇒ 在 v1.0 里**不存在** | 基线组下 `diffuseArchived` 取 `true` / `false` ⇒ `diffused` + hits 的 id 序列 + 分数**逐位相同** | ✅ **通过**（⑥） |
| **联合基线**（四布尔全关 + flat） | v1.0 的**全部可观测面** | `coacts` 表哈希前后逐位相同（**reinforce / explain / diagnostics 三模式都测**）+ `diffused` 恒空 | ✅ **通过**（⑦）—— **P3-T06 的第二次达成点** |

### 2.1 与 P1-T09 第一次达成点的对照

| 项 | P1-T09（第一次） | P3-T06（第二次，本轮） |
|---|---|---|
| 比较对象 | v1.0 **参考实现**（`tests/baseline/ref-v1.ts`，独立重算） | 同上（**沿用**，未改动） |
| 覆盖方法 | `write` / `recall` / `touch` / `get` | 同上 |
| 开关维度 | **联合**（四个布尔全关 + flat） | **联合 + 逐开关**（本轮新增 6 行） |
| 阶段 3 新增的可观测面 | **无**（阶段 3 还没落地） | ✔ `diffused`（联想路）<br>✔ `coacts` 表<br>✔ 主题簇三表<br>✔ `clusters()` 导航结果<br>✔ `viaEntity` / `viaClusterId` |
| 结论 | ✅ 达成 | ✅ **达成**（联合基线仍成立） |

---

## 三、变异矩阵（12 条 · 每条 = 一个攻击面的一次可执行变异）

> ⚠️ **还原纪律**：备份/还原**只用 `cp` + `sha256` + 逐字节比对**（**未用** stash / restore / checkout）。
> ⚠️ 工具：`D:/tmp/qa-mut/run-mutations-p3t06.mjs` + `D:/tmp/qa-mut/mutations-p3t06.mjs`（QA 自建，与 P3-T02 那套同源但独立）。
> ⚠️ **「红了哪几条」列的「工程」= `tests/unit/clusterhop.test.ts` / `tests/unit/clustersApi.test.ts`（工程师），「QA」= 本轮新增/修改的文件。

| # | 攻击面 | 变异（`文件:行` ⇒ 改成什么） | 红了哪几条 | 条数 | **前提是否成立** |
|---|---|---|---|---|---|
| M-E1 | E | `src/store/recall.ts:1105` 种子取「抑制后」的 hits（`ordered.slice(0, topN)` → `top`） | **QA `E1`** + **QA `E2`** + 工程「抑制不作用于 diffused」 | **3** | ✅ **成立**（`E2` 的深世界里**确实**有一条「既被抑制又被唤起」的 `w-c` ⇒ 种子口径一变它就消失） |
| M-E2 | E | `src/store/recall.ts:1226` 抑制**直接过滤** `diffused` | **仅 QA `E2`** | **1** | ✅ **成立**（`E1` 的世界里被抑制的 `c-b` 与 `diffused` 里的 `c-d`/`c-e` **不相交** ⇒ 抓不到；**`E2` 的深世界才抓得到**） |
| M-E3 | E | `src/store/recall.ts:1105` **只**改种子口径（把被抑制的候选从种子里剔掉） | **QA `E1`** + **QA `E2`** + 工程「抑制不作用于 diffused」 | **3** | ✅ **成立**（同 M-E1，但**只动种子** ⇒ 证明「种子口径」这一条路径单独就够被抓） |
| M-T04-1 | P3-T04-① | `src/store/diffuse.ts:399` 累积表失效：`existing.score += bonus` → `= bonus` | 工程「多路径累加生效」+ 工程「`diffusionScore` 上界」 | **2** | ✅ **成立**（工程师夹具里**确实**有一条记忆经**两个不同实体**被访问） |
| M-T04-2 | P3-T04-② | `src/store/diffuse.ts:353` 预算记在**节点**上：`scanned >= limit` → `visited.size >= limit` | 工程「`visited.size` 挡不住枢纽实体的重复遍历」 | **1** | ✅ **成立**（枢纽实体世界：10 条边产出**同一个** `(记忆, 实体)` 键 ⇒ `visited` 饱和在 1 ⇒ 预算形同虚设） |
| M-T-T04-3 | P3-T04-③ | `src/store/diffuse.ts:611` 两腿合并改成**相加**：`Math.max(...)` → `+` | **QA `E1`** + 工程「实体跳 0.2 / 簇跳 0.3 ⇒ 0.3」×2 | **3** | ✅ **成立**（两腿都命中的世界**确实**构造出来了 ⇒ 累加会得 0.5） |
| M-T04-4 | P3-T04-④ | `src/neuron/clusterhop.ts:76` 簇跳改从 `theme_cluster_members` 驱动（邻居查询从 `coacts` 改成扫成员表） | **QA `E1`** + 工程 7 条（`EXPLAIN QUERY PLAN` / 处理量与簇大小无关 / 衰减生效 / 共享预算 / 合并取 max ×2 / `viaEntity`·`viaClusterId` 二选一 / 簇跳单独命中） | **8** | ✅ **成立**（3000 成员巨型簇世界**确实**构造出来了 ⇒ 扫成员表 ⇒ 行数爆炸） |
| M-T05-1 | P3-T05-① | `src/store/clusters.ts:1012` `size` 改用**快照存储值**（`theme_clusters.member_count`） | 工程「软删一条 ⇒ `size` 立刻减一」+ 工程「`totalMembers` 随软删而变」 | **2** | ✅ **成立**（软删后**存储值不变**而实时 COUNT 变 ⇒ 两个口径**确实**分叉） |
| M-T05-2 | P3-T05-② | `src/store/clusters.ts:1210` `clusters()` **写库**（偷偷写 `meta` 表） | 工程「全库内容哈希相同且 events 行数不变」+ 工程「只读实例上可直接调用」 | **2** | ✅ **成立**（`meta` 表**不在**只读保护名单里 ⇒ 真的写得进去 ⇒ 哈希必变） |
| M-T05-2b | P3-T05-② | `src/store/clusters.ts:1210` `clusters()` **记事件**（偷偷 append 一条 `events`） | 同上 2 条 | **2** | ✅ **成立**（与 M-T05-2 **互补**：一个改「表内容」、一个改「行数」⇒ 两条断言都要有牙） |
| M-T05-3 | P3-T05-③ | `src/store/clusters.ts:824` `key` 改用 `clusterId` | 工程 3 条（`key` 跟着软删变 / `key` ≠ `clusterId` / `key` 不是稳定标识） | **3** | ✅ **成立**（`clusterId` 是哈希 ⇒ **恒不等于**成员 id） |
| M-T05-4 | P3-T05-④ | `src/store/clusters.ts:810` 成员排序键去掉 **id tiebreak** | **无** | **0** | 🚨 **前提不成立 ⇒ 等价变异**（见 §三·3） |
| M-T05-4b | P3-T05-④ | 同上 **+ 第二步**：把快照取数 SQL 的 `ORDER BY … memory_id` 改成 `DESC`（**打破「输入已升序」这个前提**） | 工程 5 条（`key` 跟着软删变 ×1 / `key` ≠ `clusterId` ×1 / `key` 不是稳定标识 ×1 / 排序键 = affinity 降序 + id 升序 ×1 / 同值按 id 升序 ×1） | **5** | ✅ **成立**（**必须**同时打破输入序 ⇒ tiebreak 才承重） |

### 3.1 M-T05-4 为何打不红 —— 前提审计（**这是本轮最有价值的一条**）

- **现象**：单去掉 `id` tiebreak（`src/store/clusters.ts:810`）⇒ **12 条断言全绿**。
- **根因（前提审计）**：两条取数路径喂给排序器的 `memberIds` **已经按 id 升序**：
  - 快照路径：`SNAPSHOT_LIVE_MEMBERS_SQL`（`src/store/clusters.ts:482`）带 `ORDER BY tcm.cluster_id, tcm.memory_id`；
  - 现场重算路径：`src/neuron/cluster.ts:426` 的 `memberIds: [...block].sort()`。
  - ⇒ `Array.prototype.sort` 在 V8 上**稳定** ⇒ 同 affinity 的成员**保持输入顺序** ⇒ 输入已升序 ⇒ **tiebreak 冗余** ⇒ 该变异是**等价变异**。
- **结论**：⚠️ **不是覆盖缺口，是「前提不成立」**。工程师那条「同值按 id 字典序升序」的断言**守的是输出形状**（正确），但它**抓不到**这个变异。
- **本轮的处理**：加了 **M-T05-4b**（同一条变异 **+** 打破输入升序前提）⇒ **红 5 条** ⇒ **证明 tiebreak 确实承重**，同时把「它为什么平时抓不到」钉进报告。
- ⚠️ **给工程师的建议**：若希望那条断言**直接**对 tiebreak 敏感，需要一个**输入序非升序**的夹具（当前两条路径都给不了）；否则该断言的定位应如实写成「**输出形状守卫**」。

---

## 四、🔴 两处源码缺陷（路由 = `Engineer`）

> ⚠️ **QA 未碰 `src/**`**（`git diff --stat HEAD -- src/` 为空）⇒ 修复由工程师执行。

### D-1 · `coactivation = false` ⇒ 主题簇**仍被计算并发布**（§5 明写「簇不计算也不使用」）

| 项 | 内容 |
|---|---|
| **规格依据** | `DESIGN-v2.md:3772`「`coactivation` \| true \| 不写 `coacts`；联想路与簇跳不执行；**簇不计算**」<br>`DESIGN-v2.md:3808`「…**主题簇不计算也不使用**」<br>`DEVELOPMENT-PLAN.md:303` / `:2715`（P3-T06 验收标准：「`coactivation = false` ⇒ …**主题簇不计算也不使用**」） |
| **实测** | `coactivation=false` 时：<br>· `recluster()` 返回 `computed=true`、`clusterCount=1`，**并写了 `theme_clusters` 行与一条 `sweep` 事件**；<br>· `clusters()` 返回 **1 个簇**、`coveredMemories=2`。<br>⇒ **「不计算」与「不使用」两半都违反**。 |
| **根因（源码定位）** | `src/store/clusters.ts:235` `recluster()` 与 `src/store/clusters.ts:1210` `clusters()` **都不读 `resolveFlags(params).coactivation`**（`grep -rn "coactivation" src/store/clusters.ts src/neuron/cluster.ts` ⇒ **零命中**） |
| **复现** | `tests/baseline/v1-equivalence-stage3.test.ts` 的 `it.fails` 用例（已随本轮提交）<br>最小复现：`coactivation=false` + 预置 1 条 `coacts` 行 ⇒ `recluster()` ⇒ 观察 `theme_clusters` 行数与 `clusters()` 的返回 |
| **守门** | 已用 `it.fails` 登记（`v1-equivalence-stage3.test.ts` ②）⇒ **修好后它会反过来变红** |
| **严重级** | **Major**（不破「与 v1.0 逐位一致」——联合基线里 `coactivation` 本来就关 ⇒ `coacts` 不写 ⇒ 联合基线仍成立；**但破坏了「每个开关能独立当 A/B 基线」这条承诺** ⇒ 开了 `coactivation` 再关掉的库，簇快照仍在、簇导航仍返回数据） |

### D-2 · `writeBack = false` ⇒ `touch` 的 `coActivateWith` **仍写因果边**（§5 明写「`touch` 的 `coActivateWith` 交叉强化不发生」）

| 项 | 内容 |
|---|---|
| **规格依据** | `DESIGN-v2.md:3810`「`writeBack` \| true \| 关闭「扩散唤起 → 采纳 → 回写」的**联动**部分（**`touch` 的 `coActivateWith` 交叉强化不发生**）。**`touch` 自身的 `growStability` 加固不受影响**」<br>`DESIGN-v2.md:3774`（同义）<br>`DEVELOPMENT-PLAN.md:305` / `:2717`（P3-T06 验收标准：「`writeBack = false` ⇒「扩散唤起 → 采纳 → 回写」的联动不发生，但 `touch` 自身的 `growStability` 加固**照常发生**」） |
| **实测** | `writeBack=false` + `coactivation=true` ⇒ `touch(ids, {coActivateWith})` **仍写入**一条 `cause_flags=2`（机制 B / 因果位）的 `coacts` 行 ⇒ **「交叉强化」发生了** |
| **根因（源码定位）** | `src/store/touch.ts:329` 只读 `resolveFlags(store.params).coactivation`；`src/neuron/coacts.ts:391` 也只读 `coactivation`。<br>⇒ **`writeBack` 在整个 `src/**` 里没有任何消费者**（`grep -rn "writeBack" src/` ⇒ 只命中 `src/core/flags.ts` 与 `src/core/params.ts` 的**声明**处，**零处读取**） |
| **复现** | `tests/baseline/v1-equivalence-stage3.test.ts` 的 `it.fails` 用例（已随本轮提交） |
| **守门** | 已用 `it.fails` 登记 ⇒ **修好后它会反过来变红** |
| **严重级** | **Major**（**不破**联合基线 —— 联合基线里 `coactivation=false` 已让 `coacts` 完全不写 ⇒ 联合基线仍成立；**但 `writeBack` 这个开关整体是空转的** ⇒ §5 给它写的「关闭后的行为」从未兑现） |

> ⚠️ **两处缺陷的共同形态**（**给工程师的定位提示**）：
> **两个机制开关都只被「声明」了、没有被「消费」**——`src/store/clusters.ts` 整份不读 `coactivation`，
> `src/store/touch.ts` 与 `src/neuron/coacts.ts` 整份不读 `writeBack`。
> ⇒ **修法方向**：在这三处补上对应开关的短路判定（`coactivation` ⇒ `recluster`/`clusters` 短路；`writeBack` ⇒ `coActivateWith` 的因果写入短路）。

---

## 五、QA 上一轮留的账 —— 攻击面 E 的恒绿守卫（**本轮已关闭**）

> 账的位置：`docs/qa/p3-t02-acceptance-report.md` §三·3（原文：「攻击面 E 在本阶段**不可执行**… 建议把攻击面 E 挂到 P3-T04 的验收清单里重跑」）。

| 项 | P3-T02 当时 | **P3-T06 现在** |
|---|---|---|
| `diffused` 的状态 | **恒为空数组**（联想路未实现）⇒ `E1` 是**恒绿守卫** | **非空**（P3-T04 落地了实体跳 + 簇跳）⇒ `E1` 是**真守卫** |
| `E1` 的夹具 | 无边 / 无共激活 / 无簇 | ★ **重建**：加了**边**（实体跳）+ **共激活 + 簇**（簇跳）⇒ **两条腿都产出** |
| 「抑制不作用于 diffused」的判别力 | ❌ 没有（`diffused` 里没有东西可被过滤） | ✅ **有**：<br>· 前提自检：`diffused` 非空 **且**含一条**只由被抑制那条种子触达**的 `c-e`<br>· ⇒ 种子口径一旦漂移，`c-e` 立刻消失 ⇒ 断言变红 |
| **M7 打红验证** | 只能用**代理变异**（P3-T02 的 M-E1） | ✅ **真实变异打红**（本轮 M-E1 / M-E3 各红 3 条）<br>⚠️ **M7 打红是正确行为**（它守的正是 §4.13.1 硬约束③「抑制只作用于 hits，不作用于 diffused」）⇒ **不是假阳性** |
| 追加 | — | ★ **`E2`（深世界）**：构造出「**同一条记忆既在 `suppressed` 里、又在 `diffused` 里**」⇒ **抓到了 `E1` 抓不到的变异 M-E2**（抑制**直接过滤** `diffused`） |

---

## 六、门禁与还原校验

| 项 | 结果 |
|---|---|
| `pnpm run verify` | **EXIT=0** |
| 测试规模 | **52 文件 / 1041 通过 + 2 `expected fail`**（基线 50 / 1023 ⇒ **+2 文件 / +18 通过**） |
| `biome check .` | **无错**（145 文件） |
| `tsc --noEmit` | **无错** |
| 变异还原校验 | **12/12 `RESTORE-OK`**（`cp` + `sha256` + `Buffer.equals` 逐字节） |
| **独立复核 `src/` 还原** | 6 个被变异过的文件对 `HEAD` 的 `sha256` **全部 MATCH**（`recall.ts` / `diffuse.ts` / `clusters.ts` / `clusterhop.ts` / `touch.ts` / `flags.ts`） |
| `git status` | 只有 3 个预期路径（1 改 + 2 新），**`src/` 零改动** |

---

## 七、交付物清单

| 路径 | 状态 | 内容 |
|---|---|---|
| `tests/unit/neuro.test.ts` | **新增**（10 条） | §12 阶段 3 的**四条单测要求**逐条落地（`N1`/`N1b`/`N2`/`N2b`/`N3`/`N4`/`N5`/`N5b`/`N6`/`N7`） |
| `tests/baseline/v1-equivalence-stage3.test.ts` | **新增**（9 条） | **逐开关**的「关掉 ⇒ 与 v1.0 逐位一致」复验 + 联合基线第二次达成点（含 2 条 `it.fails` 缺陷守门） |
| `tests/unit/inhibit-acceptance.test.ts` | **修改**（+1 条，E1 重建） | 攻击面 E 的**恒绿守卫 → 真守卫**；新增 `E2` 深世界 |
| `docs/qa/p3-t06-acceptance-report.md` | **新增** | 本报告 |

> ⚠️ **未碰**：`bench/**`、`docs/baseline/**`、`docs/qa/p3-t02-acceptance-report.md`、`src/**`。

---

## 八、给主理人的裁决请求

| # | 事项 | 路由 | 说明 |
|---|---|---|---|
| 1 | **D-1**：`coactivation=false` ⇒ 主题簇仍被计算并发布 | 🔴 **Engineer** | §5 两处 + 计划 P3-T06 验收标准都明写「簇不计算也不使用」。**建议修法**：`src/store/clusters.ts` 的 `recluster()` / `clusters()` 补 `resolveFlags(params).coactivation` 短路 |
| 2 | **D-2**：`writeBack=false` ⇒ `coActivateWith` 仍写因果边 | 🔴 **Engineer** | §5 两处 + 计划 P3-T06 验收标准都明写「`touch` 的 `coActivateWith` 交叉强化不发生」。**建议修法**：`src/store/touch.ts` / `src/neuron/coacts.ts` 补 `resolveFlags(params).writeBack` 短路 |
| 3 | **M-T05-4 的性质判定**：去掉 `id` tiebreak 是**等价变异**（输入已升序 + 稳定排序）⇒ 工程师那条「同值按 id 字典序升序」断言**定位应如实写成「输出形状守卫」**，否则会被误读成「它守住了 tiebreak」 | 🟡 **主理人 / 架构师**（**仅措辞**，不阻塞收官） | 本轮已用 **M-T05-4b**（+ 打破输入升序前提）证明 tiebreak **确实承重**（红 5 条）⇒ 该约束**有**牙，只是现有夹具观测不到 |
| 4 | **`ARCHIVAL_CACHE` 的行为等价性**：本轮**不可验**（`countArchived` 是 §9.4 阶段 4 实现）⇒ 已在对照表登记为「**阶段 4 补验**」 | 🟡 **主理人**（**排期**） | 建议在 P4-T05（`stats()`）的验收清单里加一条「开关开 / 关 ⇒ `countArchived` 返回值逐位相同」 |
| 5 | **阶段 3 收官建议** | 🟢 **可收官（附 2 条 Engineer 修复）** | 两处缺陷**都不破坏**「联合基线 ⇒ 与 v1.0 逐位一致」这条已达成两次的承诺（联合基线里 `coactivation=false` 已让 `coacts` 完全不写）⇒ **不阻塞阶段 3 收官**，但**必须在阶段 4 之前修掉**（否则 A/B 基线承诺兑现不了） |
