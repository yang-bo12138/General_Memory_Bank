# P3-T02 侧抑制 · 对抗式验收报告

> 验收人：**software-qa-engineer（严过关 / Yan）**｜日期：2026-11-01
> 被审对象：`origin/main` = `3835337`（已含 P3-T02 + P3-T03）
> 计划来源：`docs/qa/p3-t02-acceptance-plan.md`（十个攻击面 A~J）
> 验收分支：`qa/p3-t02-acceptance`｜工作树：`D:/Git/wt/qa-p3`
> ⚠️ **本报告只含验收结论**，不含任何「看起来绿」的推断：每条结论都指到 `文件:行` + 可复制的命令。

---

## 〇、总览与智能路由判定

| 项 | 结论 |
|---|---|
| **智能路由判定** | **`NoOne`（源码无 Bug）** —— 但**不是「全部通过」**：<br>① **测试覆盖缺口 4 处（计划明文要求、工程师单测未覆盖）** ⇒ 路由 **`QA`**，已由本轮新增 `tests/unit/inhibit-acceptance.test.ts` 补齐；<br>② **设计稿内部矛盾 1 处 + 可观测性缺口 1 处 + 已知导出面缺口 1 处** ⇒ 路由**主理人**（设计/排期决策，非 P3-T02 实现缺陷）。 |
| 变异总数 | **22**（计划原文 17 + QA 补充 5） |
| 变异打红率 | **22/22 = 100%**（每条变异至少红 1 条断言） |
| 还原校验 | **22/22 = `RESTORE-OK`**（`sha256` 逐字节一致；备份用 `cp` + `sha256`，**未用** stash/restore/checkout） |
| 生产代码改动 | **0**（`git diff --stat HEAD -- src/` 为空 ⇒ QA 未碰 `src/**`） |
| 门禁 | `pnpm run verify` **EXIT=0**；48 测试文件 / **946** 通过（基线 47 / 919 ⇒ 本轮 +1 文件 / +27 用例） |
| 工程师自报 4 处变异 | **全部复核为真**（M-A1 21 红 / M-B1 4 红 / M-C1 8 红 / M-F1 5 红） |

---

## 一、变异矩阵（22 条 · 每条 = 一个攻击面的一次可执行变异）

> **「红了哪几条」**列的「工程」= `tests/unit/inhibit.test.ts`（工程师），「QA」= `tests/unit/inhibit-acceptance.test.ts`（本轮新增）。
> **还原校验**全部为 `RESTORE-OK`（sha256 逐字节一致），下表不再重复列。

| # | 攻击面 | 变异（`文件:行` ⇒ 改成什么） | 红了哪几条 | 条数 | 前提是否成立 |
|---|---|---|---|---|---|
| M-A1 | A | `src/neuron/inhibit.ts:231-241` 遍历内按「已处理前缀」重算 `poolHomogeneous` | 工程 11 条 + QA 10 条 | **21** | ✅ 成立（工程「poolHomogeneous 不随 R 增长重算」直接红） |
| M-A2 | A | `inhibit.ts:223-225` `ordered.slice(1)` → `ordered`（C0 与自己比） | **仅 QA `A5`** | **1** | ⚠️ **计划此变异「几乎不可观测」**（见 §三·1）⇒ **必须**用「\|C\|=1 且 C0 不自冗余」的夹具才抓得到 |
| M-A3 | A | `inhibit.ts:218-221` `\|C\|=0` 分支 `true` → `false` | 工程「候选池为空」+ QA `A3` | **2** | ✅ 成立 |
| M-A4 | A |【计划外·QA】`inhibit.ts:237` 去掉 `poolHomogeneous` 短路（误走逐对路径） | 工程 2 条 + QA `A2`/`A4` | **4** | ✅ 成立 |
| M-A5 | A |【计划外·QA】`inhibit.ts:225` 池级判定基准从 C0 换成「最后一条」（锚点漂移） | 仅 QA `A2` | **1** | ✅ 成立（工程单测**抓不到**⇒ 覆盖缺口） |
| M-A6 | A |【计划外·QA】`inhibit.ts:224` `slice(1)` → `slice(2)`（C0 与 C1 都不参与判定） | 仅 QA `G1` | **1** | ✅ 成立（工程单测**抓不到**⇒ 覆盖缺口） |
| M-B1 | B | `inhibit.ts:179-182` `compareInhibitionCandidates` 去掉 id tiebreak | 工程「全序稳定」+ QA `B1`/`B2`/`J3` | **4** | ✅ 成立 |
| M-B2 | B | `src/store/recall.ts:1079` 那份拷贝的 tiebreak 反向（id DESC）⇒ **两份拷贝漂移** | **仅 QA `B2`** | **1** | ✅ 成立（工程单测**抓不到**⇒ **计划明文要求的覆盖缺口**） |
| M-B3 | B |【计划外·QA】`recall.ts:1075-1080` 那份拷贝丢掉分数比较（只按 id 排） | QA `F1` + `tests/baseline/v1-equivalence.test.ts` | **2** | ✅ 成立 |
| M-C1 | C | `inhibit.ts:234` `overflow.push(candidate)` → 推进 D 桶 | 工程 6 条 + QA 2 条 | **8** | ✅ 成立 |
| M-C2 | C | `recall.ts:1125` `suppressed` 同时收 D 桶与 O 桶 | 工程「溢出候选不出现在 suppressed」+ QA `C1` | **2** | ✅ 成立 |
| M-D1 | D | `inhibit.ts:359` 抑制路径把 `candidate.score` 改成 `× 0.9`（抑制进 score） | 工程 3 条 + QA 3 条 | **6** | ✅ 成立 |
| M-D2 | D | `inhibit.ts:355` 抑制路径插 `UPDATE memories SET last_access`（抑制写库） | 工程 3 条 + QA 6 条 | **9** | ✅ 成立 |
| M-E1 | E | **【代理变异】** `recall.ts:1195` 让 `diffused` 依赖抑制结果 | 工程「抑制不作用于 diffused」+ QA `E1` | **2** | ⚠️ **本阶段 `diffused` 恒为 `[]`**（`recall.ts:1195`）⇒ 真实攻击面**推迟到 P3-T04**（见 §三·3） |
| M-F1 | F | `recall.ts:1067-1070` 机制开关失效（无论开关都跑抑制） | 工程 2 条 + QA 3 条 | **5** | ✅ 成立 |
| M-F2 | F | `recall.ts:1084-1087` 开关关时**仍重排**（hits 改成 id 升序） | **仅** QA `F1` + `tests/baseline/v1-equivalence.test.ts` | **2** | ⚠️ **工程师的「开关关闭」用例抓不到**（其夹具的 id 序恰好与分数序同向 ⇒ **恒绿守卫**，见 §三·2） |
| M-G1 | G | `recall.ts:1068-1070` 同簇 ⇒ 冗余（误杀「同簇但不同事实」） | 工程「簇不参与判定」+ QA `G1` | **2** | ⚠️ 工程师那条**偶然敏感**（其 D 桶为空 ⇒ 抓不抓得到取决于「簇首条是否恰好最高分」）；QA `G1` 用**非空 D 桶** ⇒ **构造性敏感** |
| M-H1 | H | `inhibit.ts:120` 语义路径把 `REDUNDANCY_COS` 写死成 `0.9`（不读 params） | **仅** QA `H1` | **1** | ⚠️ **工程师单测抓不到** ⇒ **计划明文要求的覆盖缺口**（工程用例的余弦 0.95 与阈值 0.90 太近） |
| M-H2 | H | `inhibit.ts:124` 实体路径也要求双方都有 embedding | 工程 12 条 + QA 12 条 | **24** | ✅ 成立 |
| M-I1 | I | `src/core/params.ts:293` 去掉 `REDUNDANCY_COS <= DEDUP_COS_MIN` 跨参数校验 | `src/core/params.test.ts` 3 条 + `src/store/params.test.ts` 1 条 + QA `I1`/`I2` | **6** | ✅ 成立（**该约束已有既有覆盖** ⇒ 非缺口） |
| M-J1 | J | `src/store/inhibition.ts:101` trace 走自己的一份分数（`baseScore × 0.99`） | 工程 2 条 + QA 2 条 | **4** | ✅ 成立 |
| M-J2 | J |【计划外·QA】`inhibition.ts:90` trace 走自己的一份名额（写死 `topN = 3`） | 仅 QA `J4` | **1** | ✅ 成立 |

### 代表性断言原文（红了的那些）

| 变异 | 代表性断言原文 |
|---|---|
| M-B2 | `expect(result.hits.map((hit) => hit.id)).toEqual(['m-a', 'm-b'])` ⇒ 实得 `['m-b','m-a']`（**AssertionError: expected [ 'm-b', 'm-a' ] to deeply equal [ 'm-a', 'm-b' ]**） |
| M-H1 | `expect(isRedundant(evidence, { ...DEFAULT_PARAMS, REDUNDANCY_COS: 0.95, DEDUP_COS_MIN: 0.99 })).toBe(false)` ⇒ 实得 `true` |
| M-F2 | `expect(ids).toEqual(['m-c','m-b','m-a'])` ⇒ 实得 `['m-a','m-b','m-c']`；基线侧报 `recall 的逐位差异（参考实现 vs 真实实现）` |
| M-A2 | `expect(outcome.poolHomogeneous).toBe(true)`（\|C\|=1 夹具）⇒ 实得 `false` |
| M-C2 | `expect(result.suppressed).toHaveLength(1)` ⇒ 实得 `length of 1 but got 4` |
| M-I1 | `expect(() => store.setParams({ REDUNDANCY_COS: 0.95 })).toThrow(MemoryError)` ⇒ `expected function to throw an error, but it didn't` |

---

## 二、⚠️ 前提审计（本轮最重要的增量 · 逐条判定「前提在夹具里真的成立吗」）

> 判据：**「断言存在」≠「断言有效」**。若一条断言在**所有 22 条变异**下都绿 ⇒ 它是**恒绿守卫**（或**特性刻画**，二者必须区分）。

### 2.1 工程师单测（`tests/unit/inhibit.test.ts`，30 条）的敏感性矩阵

| 工程师用例 | 被哪些变异抓到 | 判定 |
|---|---|---|
| ★ 不变式：多组候选 ⇒ `hits.length >= min(topN, min(2,|C|))` 且 `<= min(topN,|C|)` | **无（22 条变异一条没抓）** | 🚨 **恒绿守卫**。计划第 49 行已明文警告过这一条；**实测确认它抓不到 M-A1**（poolHomogeneous 重算）⇒ **它不是不变式的守卫，只是一条重言式** |
| ★ 抑制**不进 score**：`Hit.score` 恒等于五项加权和（误差 ≤ 1e-9） | **无** | 🚨 **恒绿守卫（针对 D1）**。它是**同一次调用内**的 `score` vs `breakdown` 求和比对 ⇒ 对「抑制路径改了 score」不敏感（M-D1 变红的是**另一条**用例）⇒ **计划 D1 要求的「抑制开/关两次召回逐位比对」在这条里没有落实** |
| ★ 抑制只在 `explicit` 的语义下改「谁进 hits」，**不改事件的 scores** | **无** | 🚨 **恒绿守卫（针对 D1）**。事件的 `scores` 取自 `hits` 的 `candidate.score`（未被抑制路径改写）⇒ M-D1 不影响它 |
| ★ 语义路径：双方都有向量且 cos ≥ REDUNDANCY_COS ⇒ 冗余 | **无** | ⚪ **特性刻画**（合法，不是守卫）：余弦 0.95 vs 阈值 0.90 ⇒ M-H1 不可观测 |
| ★ 两条路径都不满足 ⇒ 不冗余 | **无** | ⚪ 特性刻画 |
| ★ 缺向量 ⇒ 语义路径**不参与**（cos = null，不是 0） | **无** | ⚪ 特性刻画（**但它守住了「cos 必须是 null 而不是 0」这条设计要点**，只是没有变异能打红） |
| ★ 实体交集差一个就不算冗余 | **无** | ⚪ 特性刻画 |
| ★ 三桶分离 / D 桶有合法 redundantWith / poolHomogeneous 池级 / 不随 R 重算 / 全序稳定 / 空池 / 抑制不进分(另一条) / 不写库 / 机制 / 溢出 / 实体路径不依赖 embedding / 语义路径 / 簇不参与 / 开关关闭 / 抑制不作用于 diffused / trace 四条 / §4.6 独立转写两条 | 1~4 条 | ✅ **前提成立**，可作守卫 |

### 2.2 QA 单测（`tests/unit/inhibit-acceptance.test.ts`，27 条）的敏感性矩阵

| QA 用例 | 被哪些变异抓到 | 判定 |
|---|---|---|
| `A1` 池级判定不随 R 重算 | M-A1, M-H2 | ✅ |
| `A2` **区分「poolHomogeneous 路径」与「逐对判冗余路径」** | M-A4, M-A5 | ✅ **计划第 46~48 行明文要求的「区分两条路径」断言**（用余弦构造：C0↔c1/c2 冗余、c1↔c2 不冗余） |
| `A3` 空池 | M-A3 | ✅ |
| `A4` 三桶守恒 + 不变式 | M-A4 | ✅（比工程师那条多守「三桶合起来 == \|C\|」） |
| `A5` **\|C\|=1 ⇒ `poolHomogeneous` 恒为真** | M-A2 | ✅ **本轮唯一能抓 M-A2 的断言**（前提：C0 无向量 + 实体 < `DEDUP_ENTITY_MIN` ⇒ C0 不自冗余 ⇒ 断言前已显式复算） |
| `B1` 纯算法层 id 字典序（**id 序与插入序相反**） | M-B1 | ✅ |
| `B2` 集成层 hits 顺序 == trace.selected 顺序（**id 序与插入序相反**） | M-B1, M-B2, M-D2 | ✅ **本轮唯一能抓 M-B2 的断言** |
| `C1` suppressed 只含真冗余 + 每条 `redundantWith` ∈ hits | M-A1, M-C1, M-C2, M-H2 | ✅ 计划第 96~99 行要求的「最难被绕过的判据」 |
| `C2` trace 的溢出候选无 `redundantWith`、不 inhibited | M-A1, M-C1, M-H2 | ✅ |
| `D1` 抑制开/关**逐位**比分数（含 suppressed） | M-A1, M-D1, M-F1, M-H2 | ✅ 计划 D1 要求的「跨两次召回逐位比对」 |
| `D2` 三张表内容哈希不变 | M-A1, M-D2, M-H2 | ✅ 哈希口径 = **行数 + 全部列内容**（不只行数） |
| `D3` trace 纯读 | M-A1, M-D2, M-H2 | ✅ |
| `E1` diffused 不受影响 | M-A1, M-E1, M-H2 | ⚠️ **对 M-E1 有效，但真实攻击面本阶段不可执行**（见 §三·3） |
| `F1` 开关关 ⇒ 不重排 | M-A1, **M-B3**, **M-F2**, M-F1, M-H2 | ✅ **本轮唯一能抓 M-F2 的断言**（夹具的 id 序与分数序**相反**） |
| `F2` 开关关 ⇒ `suppressedIds` 空 | M-F1 | ✅ |
| `G1` 同簇但逐对不冗余 ⇒ 不判冗余（**D 桶非空**） | M-A6, M-G1, M-H2 | ✅ **构造性敏感**（D 桶非空 ⇒ 证明抑制确实在跑） |
| `G2` 判据输入里**根本没有簇**（`Object.keys` 全集断言） | **无** | ⚪ **刻意标注为「结构性证据」**（类型层面 ⇒ 簇无法进入判据）⇒ **不是变异守卫**，报告中已明示 |
| `H1` 阈值取自 params | M-H1 | ✅ **本轮唯一能抓 M-H1 的断言** |
| `H2` 实体路径不依赖 embedding（纯算法层） | M-H2 | ✅ |
| `H3` 整库无向量时抑制仍生效 | M-A1, M-H2 | ✅ |
| `H4` 实体路径触发的冗余对：`redundancySim` 存在但 < 阈值 | **无** | ⚪ **现状留证**（不是守卫）⇒ 见 §四·2 |
| `I1` 参数硬约束：一个参数都不落库 | M-I1 | ✅ |
| `I2` 建议值是**动态上界** | M-I1 | ✅ |
| `J1` trace.selected == recall.hits（id 序列 + baseScore 逐位） | M-A1, M-D1, M-D2, M-H2, M-J1 | ✅ |
| `J2` trace.baseScore == Hit.score（hits **与** suppressed 都比） | M-D1, M-D2, M-J1 | ✅ |
| `J3` trace.candidates 自身全序 | M-B1 | ✅ |
| `J4` trace 与 recall **名额同源** | M-D2, M-J2 | ✅ |

### 2.3 夹具层面的「前提陷阱」清单（本轮实测踩到并修掉的）

| # | 陷阱 | 现象 | 处理 |
|---|---|---|---|
| T1 | **id 字典序与分数序同向** | 夹具 `c-a`(最高分) / `c-b` / `c-c`(最低分) ⇒ 「按 id 排」与「按分数排」结果**完全一样** ⇒ 「关时不得重排」类断言**恒绿** | 新增 `seedRedundantPairReversedIds()`（`m-c` 最高分、`m-a` 最低分）⇒ F1 立刻能抓 M-F2/M-B3 |
| T2 | **D 桶为空 ⇒「没被判冗余」是空洞的** | 工程师的「簇不参与判定」用例 D 桶为空 ⇒ 只能证明「抑制没挤掉东西」，不能证明「抑制在跑且没误杀」 | QA `G1` 用**非空 D 桶**（c-c 与 c-a 真冗余）+ c-b 与 c-a 同簇但不冗余 |
| T3 | **同分候选的 id 序与插入序同向** | 工程师「全序稳定」用例的 `base` 数组里 m1<m2<m3 恰与插入序同向 ⇒ 单看 `base` 抓不到 M-B1（靠 `shuffled` 才抓到） | QA `B1`/`B2`/`J3` 全部用**插入序与 id 序相反**的夹具 |
| T4 | **计划 M-A2 的变异在绝大多数夹具下不可观测** | 见 §三·1 | 新增 `A5`（\|C\|=1 + C0 不自冗余）⇒ 唯一可观测点被钉住 |
| T5 | **「不变式」类断言恒成立** | `hits.length >= min(topN, min(2,\|C\|))` 在**任何**正确实现下都成立 ⇒ 它是重言式 | QA `A4` 追加「三桶合起来 == \|C\|」这条**会随分桶错误而变**的断言 |

---

## 三、计划之外 / 计划本身有问题的攻击面（QA 独立判断）

### 3.1 🚩 计划 M-A2 是一条**近乎不可观测的变异**（重要发现）

计划说：`ordered.slice(1)` → `ordered` ⇒「C0 与自己比 ⇒ `poolHomogeneous` 恒为真 ⇒ 必须红」。

**实测：工程师单测一条都没红（0/30）。** 原因不是「守卫缺失」，而是**这条变异在语义上几乎等价**：

> 设 `evidence(C0,C0)`：
> - `cosine = cosineOf(v,v)`：若 `v` 非零 ⇒ **恰为 1.0** ⇒ `≥ REDUNDANCY_COS` ⇒ **C0 自冗余**；
>   若 `v` 为零向量 ⇒ `cosineOf` 返回 `null`（`dedupCandidates.ts:212`）⇒ 语义路径不可用；
> - `sharedEntities = |E(C0) ∩ E(C0)| = |E(C0)|`。
>
> ⇒ **情况 1（C0 有可用向量）**：C0 自冗余 ⇒ `every` 多一个**恒真**的合取项 ⇒ 结果**不变**。
> ⇒ **情况 2（C0 无可用向量）**：C0 只能靠实体路径与他人冗余 ⇒ 需 `|E(C0)| ≥ 2` ⇒ 此时 `|E(C0)| ≥ 2` ⇒ C0 **也**自冗余 ⇒ 结果**不变**。
> ⇒ **唯一的可观测缝隙**：`C0` 无可用向量 **且** `|E(C0)| < DEDUP_ENTITY_MIN` **且** `|C| = 1`。
>   此时「除 C0 外每一条都冗余」在**空集**上应是**空真（true）**，而变异给出 `false`。

⇒ **裁决**：实现的 `.slice(1)` **是对的**；但**计划把它当成可观测的变异是错的**。QA 用 `A5` 补上了唯一可观测缝隙。**同时建议**：设计稿 §4.13.3 那句「C0 不与自己比（那恒为真 ⇒ poolHomogeneous 永远为真）」的措辞**不准确**——把自己算进去只会多一个**恒真的合取项**，**不会**让 `poolHomogeneous` 变成「永远为真」。⇒ 建议主理人在 errata 里改成「C0 参与比较 ⇒ 多一个恒真合取项（多数情形下无害），但会破坏「\|C\|=1 ⇒ 空真」的语义」。

### 3.2 🚩 计划 M-F2 在**工程师的夹具**下不可观测（恒绿守卫的教科书案例）

计划明写「M-F2：开关关时仍重排 ⇒ 必须红」。**实测：工程师单测 0 红。**
根因：工程师「开关关闭时：候选带不重排」用例的夹具是 `c-a`(最高分) / `c-b` / `c-c`(最低分) ⇒ **id 字典序恰好与分数序同向** ⇒「按 id 排」与「按分数排」产出的序列**一模一样** ⇒ 该断言**恒绿**。
⇒ QA 用 `m-c`(最高分) / `m-b` / `m-a`(最低分) 的反向夹具补上 ⇒ M-F2 / M-B3 立刻打红。

### 3.3 ⚠️ 攻击面 E 在本阶段**不可执行**（真实风险推迟到 P3-T04）

- 实测：`src/store/recall.ts:1195` 硬编码 `diffused: []`，`diffusedSeeds: []` ⇒ **本阶段 `diffused` 恒为空数组**。
- ⇒ 计划 E 的断言（`diffused.length` 开关前后相等）**在真实语义下恒成立** ⇒ 它**证明不了**「抑制没碰 diffused」。
- ⇒ 本轮用**代理变异**（让 `diffused` 依赖抑制结果）验证「这条断言**能不能**抓到泄漏」⇒ **能**（工程 + QA 各红 1 条）。
- ⇒ **但真实风险要到 P3-T04（簇跳扩散）落地 `diffused` 非空之后才成立** ⇒ **建议把攻击面 E 挂到 P3-T04 的验收清单里重跑**（QA 已在 `E1` 的注释里写明这一点）。

### 3.4 ⚠️ 攻击面 G 的「簇不参与判定」在**类型层面**已经成立（计划假设偏保守）

实测：`InhibitionCandidate` 只有 `id` / `score` / `vector` / `entityIds` 四个字段（`inhibit.ts:57-66`）⇒ **簇在类型上就无法进入判据**；`inhibit.ts` / `recall.ts` 的判定路径**没有任何一处读 `theme_cluster_members`**（唯一的簇读取是 `inhibit.ts:378 loadClusterIds`，只供 `inhibitionTrace` 的诊断上下文，且**在 `inhibitCandidates` 之后**调用）。
⇒ **结论**：§4.13.2 的「簇不参与判定」是**类型保证 + 调用顺序保证**，不是「靠实现者记得别用簇」。QA 用 `G2`（`Object.keys` 全集断言）把这条结构性证据固化，并补 `G1` 作为**回归防线**（若将来有人把簇塞进判定链，`G1` 立刻红）。

### 3.5 ⚠️ `inhibitionTrace` **不在公开导出面上**（**已排期**，非 P3-T02 缺陷）

- §6（`DESIGN-v2.md:4631`）把 `inhibitionTrace(context, options?)` 列为 **`MemoryStore` 的方法**。
- 实测：`src/store/MemoryStore.ts` **没有**该方法；`src/index.ts` **没有**导出 `inhibitionTrace`；实现只有 `src/store/inhibition.ts` 里的**自由函数** `inhibitionTrace(store, context, options?)`。
- ⇒ **这是已知排期项**（任务列表 #3「补齐阶段3三方法的导出面与契约守卫」：阶段 3 的三个方法 `clusters` / `recluster` / `inhibitionTrace` 一起补）⇒ **不判 P3-T02 FAIL**，但**必须在阶段 3 收官前闭环**，否则 §6 的公开契约无法兑现。

---

## 四、给主理人的两个裁决请求（团队-lead 点名要 QA 独立判断的）

### 4.1 ✅ 裁决一：`inhibition` 开关用 `DEFAULT_PARAMS.inhibition` ⇒ **工程师的读法正确，不判 FAIL**

| 核查项 | 实测事实 | 出处 |
|---|---|---|
| `DEFAULT_PARAMS.inhibition` **存在**吗？ | **存在**：`inhibition: true, // 关：无侧抑制，直接按 base 分取 topN` | 设计 `docs/design/DESIGN-v2.md:3956`（§6 的 `DEFAULT_PARAMS` 代码块）＋ 实现 `src/core/params.ts:147` |
| §6 的 `RecallOptions` **有没有** `inhibition` 字段？ | **没有**。§6 `RecallOptions`（`DESIGN-v2.md:4022-4062`）的字段全集 = `context` / `topN` / `queryEmbedding` / `entityIds` / `entityNames` / `includeArchived` / `diffuseArchived` / `reinforce` / `explain` / `diagnostics` / `now` | `DESIGN-v2.md:4022-4062` |
| 实现怎么读？ | `resolveFlags(params).inhibition`（**每次调用时**读，不在 `open()` 时快照 ⇒ 满足 §5「开关的读取时机：必须在每次调用时读」） | `src/store/recall.ts:1067`；`src/core/flags.ts:98-106` |
| 开关可运行时切换吗？ | 可以：`setParams(patch: Partial<Omit<typeof DEFAULT_PARAMS,'EMBED_DIM'>>)` ⇒ `inhibition` 是 `DEFAULT_PARAMS` 的键 ⇒ 可经参数表切换 | `DESIGN-v2.md` §6 `MemoryStore.setParams`；`src/store/params.ts:76` |

⇒ **裁决：工程师的读法正确，实现正确。** 理由链：
① §6 是公开契约，其 `RecallOptions` **没有** `inhibition`；
② `inhibition` 是 §5/§6 的**机制开关**（与 `coactivation` / `writeBack` / `ARCHIVAL_CACHE` / `VECTOR_ROUTER` 同列），**在参数表里**；
③ 往 `RecallOptions` 加 `inhibition` ⇒ 同一件事两套开关 ⇒ **违反 C36（同一件事不得有两套词）**；
④ 实现处 `recall.ts:1064-1066` 的注释已把这条推理**写进代码** ✔。
⇒ **判定：PASS，不派回工程师。**（若主理人希望「每次调用可临时关抑制」成为公开能力，那是**新增契约**，须走设计变更 + errata，不是 P3-T02 的实现缺陷。）

### 4.2 ⚠️ 裁决二：`redundancySim` 的口径 —— **可接受（不是缺陷），但属可观测性缺口**

工程师自曝：「实体路径触发的冗余对，其 `redundancySim` 可能低于 `REDUNDANCY_COS` ⇒ 消费方单看这个字段判不出为什么被判冗余」。

**QA 实测留证**（`tests/unit/inhibit-acceptance.test.ts` 的 `H4`）：
- 双方**都有向量**、余弦 = 0（正交）、共享实体 2 个 ⇒ **实体路径**判冗余 ⇒ 该条进 `suppressed`，且 `redundancySim = 0`（**存在但 < 0.90**）⇒ **消费方单看它判不出依据** ⇒ **工程师的自曝属实**。
- **对照**：双方**都无向量** ⇒ `redundancySim` **整个键不出现** ⇒ 「键缺失」是一个**可用**的信号。

⇒ **判定：可接受。** 三条理由：
① **不违反 §6 契约**：§6 的 `RecallResult.suppressed[].redundancySim?: number` 原文就是「**该冗余对的相似度（0~1）**」——它描述的是**这一对**，**不是**「判定依据」；契约里**本来就没有** basis 字段。实现与 §6 **逐字一致**。
② §4.13.2 的判据本就是 **OR**（余弦 **或** 实体交集）⇒ 任何单值摘要都无法完整表达「哪一条路径起了作用」⇒ **这是判据形态的固有性质**，不是实现取舍。
③ §4.13.1① 已把「谁挤掉了谁」指定为 `inhibitionTrace` 的**诊断输出**职责 ⇒ 消费方要拿「依据」应当走诊断通道。

⇒ **但建议（不阻塞 P3-T02）**：
- 在 `RecallSuppressed` 与 `InhibitionTraceCandidate` 上补一个 `basis?: 'cosine' | 'entity'`（**或**在 `inhibitionTrace` 里补 `sharedEntities`）；
- 该字段会让「`redundancySim` 低于阈值却被抑制」这一情形**自解释**；
- 归属：**设计契约变更** ⇒ 路由主理人排期（建议并入任务 #3「阶段3导出面与契约守卫」一起做）。

---

## 五、其余发现（不属于 P3-T02 实现缺陷，但需要主理人知道）

| # | 级别 | 发现 | 证据 | 归属 |
|---|---|---|---|---|
| F-1 | 🟡 **设计稿内部矛盾** | §6 的 `Hit.breakdown.suppression?: { clusterId, rankInCluster, basis: 'cluster' \| 'cluster-or-cosine' }`（`DESIGN-v2.md:4119-4124`）**与** §4.13.1①「『谁挤掉了谁、冗余度多少』……**不进入 `Hit.breakdown`**」（`DESIGN-v2.md:3078`）**直接冲突**；且 `basis: 'cluster'` 蕴含「簇参与判定」，**与 §4.13.2「簇不参与判定」冲突** | 设计稿两处逐字 | **设计稿缺陷**（`DESIGN-v2.md`）⇒ 主理人出 errata。**实现跟随 §4.13（不提供 `suppression`）是正确取舍**，**不判 P3-T02 FAIL** |
| F-2 | 🟡 设计稿措辞不准 | §4.13.3「C0 不与自己比（那恒为真 ⇒ `poolHomogeneous` **永远为真**）」——把自己算进去只多一个**恒真合取项**，**不会**让 `poolHomogeneous` 变成永远为真（见 §三·1 的三段论证） | 本报告 §三·1 | 设计稿措辞 ⇒ errata |
| F-3 | 🟡 覆盖缺口 | 计划**明文要求**、但**工程师单测未覆盖**的 4 处：<br>① **M-B2 两份拷贝漂移**（计划第 63 行「两份拷贝必须逐位等价」）；<br>② **M-F2 开关关时仍重排**（计划第 136 行）；<br>③ **M-H1 阈值取自 params**（计划第 161 行）；<br>④ **M-A2 C0 不与自己比**（计划第 41 行） | §一 的 M-A2 / M-B2 / M-F2 / M-H1 行 | **QA** ⇒ 已由 `tests/unit/inhibit-acceptance.test.ts` 补齐（`A5` / `B2` / `F1` / `H1`） |
| F-4 | 🟡 恒绿守卫 | 工程师单测里 3 条**在 22 条变异下全绿**且**不是**特性刻画的断言：「不变式…」「抑制不进 score：Hit.score 恒等于五项加权和」「抑制只在 explicit 的语义下…不改事件的 scores」 | §二·2.1 | **QA** ⇒ 建议工程师（或由 QA 代劳）把「抑制不进 score」改成**跨两次召回的逐位比对**（QA `D1` 已是这个形状，可直接复用） |
| F-5 | 🟢 既有覆盖（**非缺口**） | 攻击面 I 的跨参数约束**已有**既有覆盖：`src/core/params.test.ts:155`「第 1 条：0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN（方向是 ≤ 不是 <）」与 `src/store/params.test.ts:75`「校验失败 ⇒ 抛 INVALID_INPUT，且库内参数一个都没变」⇒ M-I1 红了 4 条既有断言 | 本报告 §一 M-I1 行 | ✅ 无需动作 |
| F-6 | 🟢 门禁覆盖 | `pnpm run check:params` **只**做「§5 表 ↔ `DEFAULT_PARAMS` 逐键逐值比对」，**不**覆盖跨参数约束；跨参数约束由 `validateParams()` + 上述单测覆盖 ⇒ **门禁链无缺口**（但门禁与单测职责不同，别混为一谈） | `scripts/check-params.ts` | ✅ 无需动作 |

---

## 六、自检（交付前逐条核对）

| 自检项 | 结果 | 复现命令 |
|---|---|---|
| `pnpm run verify` | **EXIT=0** | `cd /d/Git/wt/qa-p3 && pnpm run verify` |
| 测试规模 | **48 文件 / 946 用例全绿**（基线 47 / 919 ⇒ 本轮 +1 / +27） | `npx vitest run` |
| `git status` | **干净**（仅新增 `tests/unit/inhibit-acceptance.test.ts` 与本报告两个未跟踪路径） | `git status --short` |
| **生产代码零改动** | ✅ `git diff --stat HEAD -- src/` **为空** | `git diff --stat HEAD -- src/` |
| 变异还原 | **22/22 `RESTORE-OK`**（`sha256` 逐字节一致；用 `cp` + `sha256` 校验，**未用** stash/restore/checkout） | 见 §一 |
| 变异工具位置 | **仓库外**（`D:/tmp/qa-mut/`）⇒ 不污染工作区、不与工程师的 `bench/` `docs/baseline/` 冲突 | `ls D:/tmp/qa-mut/` |
| 提交内容 | 仅 `tests/unit/inhibit-acceptance.test.ts` + `docs/qa/p3-t02-acceptance-report.md` | `git show --stat HEAD` |
| **未推 main** | ✅ 分支 `qa/p3-t02-acceptance`，未 push | `git branch --show-current` |

### 复现命令（最小）

```bash
# 1) 新增验收单测全绿
cd /d/Git/wt/qa-p3 && npx vitest run tests/unit/inhibit-acceptance.test.ts

# 2) 门禁全绿
pnpm run verify

# 3) 变异矩阵复跑（工具在仓库外）
node "D:/tmp/qa-mut/run-mutations.mjs"          # 22 条全跑
node "D:/tmp/qa-mut/run-mutations.mjs" M-B2     # 单跑一条
node "D:/tmp/qa-mut/analyze.mjs"                # 敏感性矩阵（恒绿守卫清单）

# 4) 生产代码零改动
git diff --stat HEAD -- src/     # 必须为空
```

---

## 七、结论（一句话版）

**P3-T02 的实现（`src/neuron/inhibit.ts` / `src/store/inhibition.ts` / `src/store/recall.ts` 的步骤 4.5）经 22 条对抗式变异全部被打红、且工作区逐字节还原干净 ⇒ 未发现源码缺陷 ⇒ 源码路由判定 `NoOne`。**
**但「绿」有两处必须记账**：① 计划明文要求的 4 个变异（M-A2 / M-B2 / M-F2 / M-H1）**工程师单测一条都抓不到**，其中 3 条属于 Q-01 同型的「恒绿守卫」⇒ 路由 `QA`，已由本轮 `tests/unit/inhibit-acceptance.test.ts`（27 条，每条带显式前提自检）补齐；② 攻击面 E 本阶段**不可执行**、`inhibitionTrace` **不在公开导出面上**（已排期 #3）、设计稿 §6 的 `breakdown.suppression` 与 §4.13.1① **自相矛盾** ⇒ 路由主理人。
**建议：P3-T02 可进阶段 3 收官，但「阶段 3 的导出面 + 契约一致性」必须在收官前闭环（任务 #3），否则 §6 的公开契约仍然兑现不了。**
