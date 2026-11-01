# P3-T02 侧抑制 · 对抗式验收计划（**尚未验收**）

> 验收人：software-qa-engineer-2｜计划制定：2026-11-01
> ⚠️ **状态：计划，未验收。** ⇒ **本文件不含任何验收结论**。
> ⚠️ **时点更正（2026-11-01 12:0x 实测）**：本计划初稿写于「T02 未合入 main」时；
> 但**期间 `origin/main` 已推进到 `5905ccb`「merge(P3-T02): 侧抑制三桶算法（R / D / O）与逐对判据」**
> ⇒ **T02 现在已经在 main 上** ⇒ **本计划的前提已满足、可立即执行**
> ⇒ 且**本分支已含 T02**（`daeb33d` 合入了 `origin/main`）⇒ 验收**不必等任何合并**。
> 工作树：`D:/Git/wt/qa-p3`（分支 `qa/p2-baseline-merge`，**独立** ⇒ 不与 P3 工程师共用 `D:/Git/wt/p2-t01`）。

## 范围（已实测存在）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/neuron/inhibit.ts` | 399 | 三桶算法 + 冗余证据的批量取回（只读） |
| `src/store/inhibition.ts` | 137 | `inhibitionTrace()`（§6 的诊断接口） |
| `src/store/recall.ts` | +181 | §4.6 **步骤 4.5** 接入（抑制后置） |
| `tests/unit/inhibit.test.ts` | 837 | 单测 |

**设计依据**：`DESIGN-v2.md` §4.13（§4.13.1 三条硬约束 / §4.13.2 判据 / §4.13.3 三桶算法 /
§4.13.4 参数硬约束 / §4.13.5 失败模式表）、§4.6 步骤 4.5、§12 阶段 3 清单（「侧抑制的纯筛选三桶算法与逐对判据」）。

---

## 攻击面 A · `poolHomogeneous` 必须**池级前置固定**

**设计**（§4.13.3）：
「**必须在遍历前算完**，不能随 R 的增长而重算——若随 R 重算，行为就依赖遍历顺序」；
「**C0 不与自己比**（那恒为真 ⇒ poolHomogeneous 永远为真）」；「|C| = 0 时恒为真」。

**实现位置**：`src/neuron/inhibit.ts:214`（排序）→ `:216-226`（`c0 = ordered[0]`；`poolHomogeneous`
在 `for` **之外**算一次；`ordered.slice(1).every(...)` ⇒ C0 不与自己比）→ `:230`（遍历开始）。

**要查**：
1. `poolHomogeneous` 的赋值**在遍历之外**（结构上已对 ⇒ **但结构对 ≠ 有守卫** ⇒ 靠变异打红）；
2. `ordered.slice(1)` ⇒ C0 不与自己比；
3. `c0 === undefined`（|C|=0）⇒ 恒为 `true`。

**变异**：
- **M-A1** `poolHomogeneous` 改成**在遍历内按当前 `kept` 重算** ⇒ 必须红；
- **M-A2** `ordered.slice(1)` → `ordered`（C0 与自己比）⇒ `poolHomogeneous` 恒为真 ⇒ 必须红；
- **M-A3** |C|=0 分支 `true` → `false` ⇒ 必须红（不变式 `hits.length ≥ min(2, |C|)`）。

**断言形态要求**：
- 必须有一条断言在 **poolHomogeneous = true** 的场景下检查「结果条数 == min(topN, |C|)」（整池同质 ⇒ 全部让位、**不抑制**）；
- **必须有一条断言区分「poolHomogeneous 路径」与「逐对判冗余 路径」**（设计明写：两者「不是同一件事」）：
  构造「**C0 与其余每一条都冗余、但其余彼此不冗余**」⇒ poolHomogeneous=true ⇒ **全部进 hits**；
  ⇒ 若实现误走逐对路径 ⇒ 其余会被误杀 ⇒ hits 变短 ⇒ 变红。
- ⚠️ **要防的恒绿**：只断言「hits 里没有两条冗余」**分不出**这两条路径 ⇒ 那样的断言抓不到 M-A1。

---

## 攻击面 B · 排序键必须带 id（全序）

**设计**（§4.13.3 遍历「按 (score DESC, id ASC) 全序」＋ §4.13.5 失败模式「同分导致的非确定性 → 已修：全序 (score DESC, id ASC)」）。

**实现位置**：
- `src/neuron/inhibit.ts:175-183`（`compareInhibitionCandidates`）；
- ⚠️ **`src/store/recall.ts:1074-1080` 把同一段比较逻辑**又抄了一份**。

**要查**：
1. tiebreak 是 `left.id < right.id ? -1 : left.id > right.id ? 1 : 0`（**字典序**，不是数值序 / 不是 rowid 序）；
2. ⚠️ **两份拷贝必须逐位等价** ⇒ 否则 `inhibitionTrace` 的 `selected` 与 `recall` 的 `hits` 会漂移；
3. `score` 比较用**精确相等**（`!==`）⇒ 浮点全序的确定性来源。

**变异**：
- **M-B1** `compareInhibitionCandidates` 去掉 id tiebreak（只按 score）⇒ 必须红；
- **M-B2** 把 `recall.ts:1074-1080` 那份的 tiebreak 改成**相反方向**（id DESC）⇒ 必须红 ⇒ **这条专门抓「两份拷贝漂移」**。

**断言形态要求**：
- 必须有一条断言比较「**同分**候选的相对顺序」在两次独立调用之间一致；
- **必须用「同分、且 id 字典序与插入序相反」的候选**（否则 id tiebreak 可能恰好同序而测不出来）。

---

## 攻击面 C · O 桶不得混进 D 桶

**设计**（§4.13.3「把 O 混进 D，会让『根本没参与评估的候选』被误标成『被挤掉的』——它们没有合法的
`redundantWith`（没跟谁比过），标注是假的」；§4.13.5 失败模式「溢出候选被误标为被抑制 → 已修：三桶分离」）。

**实现位置**：`src/neuron/inhibit.ts:229-236`（`overflow: InhibitionCandidate[]`，**无** `redundantWith` 字段）
vs `:244-257`（`redundant: InhibitionRedundant[]`，**有** `redundantWith`）
＋ `src/store/recall.ts:1124-1140`（`suppressed` **只收 D 桶**；`reason` 恒为 `'redundant'`）。

**要查**：
1. **类型层面已分离**（`overflow` 里根本没有 `redundantWith` 字段 ⇒ **编译期挡住**）⇒ 好设计；
   ⇒ 但要确认 `InhibitionOutcome` 的三个桶字段类型（若 `overflow` 被改成 `InhibitionRedundant[]` ⇒ 守卫失效）；
2. `recall.ts` 的 `for (const entry of inhibition?.redundant ?? [])` ⇒ **只收 D**；
3. `suppressed` 的条数 == **D 桶**条数（不是 O 桶、不是 R 桶）。

**变异**：
- **M-C1** `overflow.push(candidate)` → `redundant.push({ candidate, redundantWith: kept[0]!.id, ... })` ⇒ 必须红；
- **M-C2** `recall.ts` 的 `inhibition?.redundant` → `inhibition?.overflow`（或 `kept`）⇒ 必须红。

**断言形态要求**：
- 必须用「**候选数 > topN**」的场景（⇒ 必然产生 O 桶），断言：
  **① `suppressed.length` == 真正冗余的条数**；**② `suppressed` 里每一条的 `redundantWith` 都在 `hits` 里**
  （O 桶的候选**根本没有** `redundantWith` ⇒ 这是最直接、也最难被绕过的判据）。
- ⚠️ **要防的恒绿**：只断言「`suppressed.length >= 0`」或「`suppressed` 里 id 不重复」⇒ O 桶混进去也测不出来。

---

## 攻击面 D · 两条硬约束（§4.13.1）

### D1 抑制不进 score
- 设计：「`Hit.score` **恒等于五项加权和**（误差 ≤ 1e-9）；`Hit.score` 与 `rankScore` 是同一个数」。
- 实现位置：`src/store/recall.ts:1060-1062`（注释「一个字节都不动」）＋ `:1096`（`score: candidate.score`）＋ `:1099-1108`（breakdown）。
- **变异 M-D1**：在抑制路径里改 `candidate.score`（例如 `* 0.9`）⇒ 必须红。
- **断言形态要求**：**把「同一批候选在抑制开 / 抑制关两次召回下的 `score` 逐位比对」**（不是比 hits 的条数）。
  ⚠️ **`breakdown.vectorPart` 恒为 0**（`SCORE_WEIGHTS.vectorSim * 0`）⇒ 那是**阶段 1 向量路整路缺席**的既成事实，**别把它算到抑制头上**。

### D2 抑制不写库
- 设计：「本节全程只读。抑制前后 `memories` 表哈希必须完全相同。」
- **要查**：抑制路径**有没有任何 `INSERT`/`UPDATE`/`DELETE`**（静态扫 `src/neuron/inhibit.ts` + `src/store/inhibition.ts`）。
- **变异 M-D2**：在抑制路径里插一条 `UPDATE memories SET last_access = …` ⇒ 必须红。
- **断言形态要求**：**必须有一条「抑制前后 `memories` 表哈希相同」的断言**，且哈希口径要写死（行数 + 主键 + 关键列的内容哈希）。
  ⚠️ **只断言「行数不变」是不够的**（行数不变、内容被改 ⇒ 测不出来）⇒ **这就是 Q-01 的同型陷阱**。
- **附带要查**：`events` 表（抑制结果**不产生任何持久状态** ⇒ 不该写 events）。

---

## 攻击面 E · 抑制只作用于 hits，不作用于 diffused（§4.13.1③）

- **要查**：`diffused` 是否**先算后过滤** ⇒ 抑制结果**不得**过滤 diffused。
- **变异 M-E1**：把抑制的 `keptIds` 过滤也套到 diffused 上 ⇒ 必须红。
- **断言形态要求**：**抑制开启时 `diffused` 与抑制关闭时逐条相同**。

---

## 攻击面 F · 机制开关与 v1.0 逐位一致

- 设计（§5 基线条件 + §12 阶段 3「抑制关闭后与 v1.0 逐位一致」）。
- 实现位置：`src/store/recall.ts:1067-1070`（`resolveFlags(params).inhibition`）＋ `:1082-1088`
  （关 ⇒ `ordered.slice(0, topN)`，且设计明写「关 ⇒ 候选带**不重排**」）。
- **变异 M-F1**：开关关时**仍调用** `inhibitCandidates`（只忽略结果）⇒ hits 会变 ⇒ 必须红；
- **变异 M-F2**：开关关时**仍重排**（把 `ordered` 换成抑制后的顺序）⇒ 必须红。
- **断言形态要求**：**走 v1.0 基线那套**（`tests/baseline/v1-equivalence.test.ts` 的形状），
  **不要**自己写一个「大概一致」的断言。

---

## 攻击面 G · 判据是纯逐对，**簇不参与**（§4.13.2）

- 设计：「簇是**话题级**，冗余是**事实级**…用它判事实冗余会**误杀「张三住上海 / 张三喜欢猫」**」。
- 实现位置：`src/neuron/inhibit.ts:156-164`（`redundancyEvidence` **只有** `cosine` + `sharedEntities`）
  ＋ ⚠️ `:378` `loadClusterIds` **存在但未被 `redundancyEvidence` 使用** ⇒ 要查它被谁调用。
- **变异 M-G1**：在 `redundancyEvidence` 里加一条「同簇 ⇒ 冗余」⇒ 必须红。
- **断言形态要求**：**必须有一条断言用「同簇、但逐对判据不冗余」的候选对**（实体交集 < 2 且 cos < 0.9）
  ⇒ 必须**不被**判冗余 ⇒ 这是设计点名的「主题级冗余被误杀」失败模式。

---

## 攻击面 H · `isRedundant` 的两条路径（§4.13.2）

```
isRedundant(A, B) = (双方都有 embedding 且 cos(A,B) ≥ REDUNDANCY_COS) OR (|E(A) ∩ E(B)| ≥ DEDUP_ENTITY_MIN)
```

- **要查**：① cos 路径要求**双方都有 embedding**（一方没有 ⇒ 该路径不成立）；② **实体路径始终可用**
  （`embeddedRatio = 0` 时抑制**仍然工作**）；③ 阈值取自 `params`（`REDUNDANCY_COS` / `DEDUP_ENTITY_MIN`），**不写死**。
- **变异 M-H1**：把 `REDUNDANCY_COS` 写死成 0.9（不读 params）⇒ 必须红；
- **变异 M-H2**：让实体路径也要求双方都有 embedding ⇒ 必须红。
- **断言形态要求**：**必须有一条断言在「全部无向量」（`embeddedRatio = 0`）时抑制仍然工作**。

---

## 攻击面 I · 参数硬约束（§4.13.4）

- `0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN`（默认 0.90 ≤ 0.92）⇒ `setParams()` **必须在写入前**校验并抛
  `INVALID_INPUT`，**且一个参数都不落库**。
- **要查**：这条跨参数校验在不在 `src/core/params.ts` 的 8 条里？`REDUNDANCY_COS > DEDUP_COS_MIN` ⇒ 抛错？
- **变异 M-I1**：去掉这条校验 ⇒ 必须红。
- ⚠️ 顺带看门禁：`check:params` 是 `pnpm run verify` 链的一环 ⇒ **门禁脚本本身是否覆盖这条约束**。

---

## 攻击面 J · 不变式与 trace 同口径

- `hits.length ≥ min(2, |C|)`（抑制**永不**把结果压到 1 条以下）；`hits.length ≤ min(topN, |C|)`。
- §6：`inhibitionTrace` 的 `selected` **必须与 `recall` 的 hits 同口径** ⇒ **必须走同一段打分代码**
  （`src/store/recall.ts:949` 的注释称已抽公共流水线 ⇒ **要查它是否真的共用**）。
- **变异 M-J1**：让 `inhibitionTrace` 走自己的一份打分 ⇒ 必须红。
- **断言形态要求**：**比较 `inhibitionTrace(...).selected` 与 `recall(...)` 的 hits id 序列**。

---

## 执行纪律（照上一轮的教训，逐条来自实测）

1. **每条变异必须自带负控** ⇒ 先确认「**原实现绿、变异红**」再记进报告。
   ⚠️ **Q-01 的教训**：断言**存在**但**前提不成立** ⇒ 恒绿守卫 ⇒ 本轮每条断言都要先问「它的前提在我的夹具里真的成立吗」。
2. **断言要能失败** ⇒ 变异打不红 ⇒ 那条断言就是恒绿守卫 ⇒ **记为缺陷**，不记为「通过」。
3. **不合并两份实现** ⇒ `recall.ts` 与 `inhibit.ts` 的两份排序拷贝：**要么断言等价，要么抽公共函数**。
4. **独立 worktree**：`D:/Git/wt/qa-p3`（已建）⇒ 不与 P3 工程师共用 `D:/Git/wt/p2-t01`。
5. **「实测 vs 读码推断」分开标注**（上一轮新增的纪律）。
6. **每个结论都要能指到 `文件:行` + 可复制的命令**；数字必须**从落盘物复核**，不许从文档誊抄。

## 交付物

- `docs/qa/p3-t02-acceptance.md`（验收报告）
- 变异表（M-A1…M-J1）：每条 = 变异描述 → 红了哪几条断言 → 代表性断言原文
- 三条硬约束的**实测证据**：score 逐位相同（≤1e-9）、`memories` 表哈希相同、`diffused` 不受影响
