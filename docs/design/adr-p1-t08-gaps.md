# ADR-P1-T08-GAP · P1-T08（`recall` 流水线）暴露的两处设计稿缺口 + 三条小口径的裁决

> **状态**：已裁决（架构师 高见远），2026-10-30
> **触发**：`software-engineer-5` 交付 P1-T08（提交 `5f42889`，已合入主线 `0d3bb1e`）时，
> 在实现 §4.6 步骤 1 时撞到**设计稿没有可实现契约**的地方，报给 team-lead 并请我裁决。
> **权威**：`docs/design/DESIGN-v2.md`（§4.6 / §6）+ 本文件。
> **工程边界**：本文件只裁决**设计**，不替任何工程师改代码；代码改动以「清单」形式交回本人。

---

## 0. 摘要（一屏读完）

| # | 争点 | 裁决 | 一句话理由 |
|---|---|---|---|
| **GAP-①** | §4.6 步骤 1 要求「对上下文中抽取到的每个实体名称 n 调 `resolveEntity`」，但 §6 的 `RecallOptions` 只有 `entityIds`（已解析好的 id），**没有放「抽出来的名字」的入口** | **(a) 给 `RecallOptions` 加可选 `entityNames?: string[]`**；库**只**做「名字 → id」的归一，**不**做「上下文 → 名字」的抽取；`entityIds` 与 `entityNames` **互斥**（同传 ⇒ `INVALID_INPUT`）；两者都不传 ⇒ 图谱路为空 | ADR-2 明写「**实体抽取由调用方提供，库不内置 NER**」「调用方不传就退化为纯文本检索，功能仍完整」；选项 (b) 与 §4.6 步骤 0「**路由只约束向量路**」直接冲突（会让「向量路缺席」连带「图谱路消失」） |
| **GAP-②** | §4.6 步骤 2.5 要求记 `fromText` / `fromVector` / `fromGraph`，§6 的 `cos` 注释也引用了 `fromVector`，但 §6 的 `Hit` **没声明这三个字段** | **确认放在 `Hit` 顶层**（不放 `breakdown` 里），并在 §6 正式声明 | 它们是「来源标记」不是「分项」；`breakdown` 装的是「本次检索的分项」，装来源会破坏语义单一性；§6 自己的注释早就按「per-hit 层」在用它 |
| **小口径①** | `LIMIT 100` / `slice(0, 20)` / `topN ≤ 8` 在 §5 的 60 项参数表里无对应项 | **认可刻意硬编码、不进参数表**；但设计稿必须补「为什么不是参数」的理由段（C26） | 三者在设计稿正文里**本来就是字面量**（§4.6 步骤 2a/2b、§6），不入表是**与现状一致**而非新增例外；理由段是缺的 ⇒ 补 |
| **小口径②** | §4.6 步骤 2a/2b 写 `SELECT m.*`，会把 768 维 `embedding` BLOB 拖出来 | **认可只 SELECT 用到的六列**；`m.*` 是**伪代码**，设计稿补一句写死 | `embedding` 是 768×4B = **3KB/行** 的 BLOB，100 行/路 ⇒ **≈300KB/路/次**（三路近 1MB/次），而召回链路里没有一处需要向量本身 |
| **小口径③** | `includeArchived=true` ⇒ 阈值 `0.0`，而精筛是**严格大于** ⇒ 强度因 `exp` 下溢成**恰好 0** 的记忆仍被挡掉 | **归档模式下强度精筛整体不执行**（不是「阈值改成 0」，是**不做这个判定**） | §4.6 步骤 2 原文自己写的是「**即只过滤 deleted = 0**」——「阈值 0.0」与「只过滤 deleted = 0」在数值上**不等价**；下溢条件 `Δt/τ > 745 天`，而 schema 只要求 `stability > 0` ⇒ 小 stability 的记忆几十小时就能下溢到 0 ⇒ 这些行**已被 SQL 粗筛放进来**（归档模式无时间窗）却在应用层被悄悄丢掉 |

---

## 1. GAP-①：「实体名」没有入口 —— 裁决 **(a)**

### 1.1 冲突描述（工程师原话 + 我的复核）

- §4.6 步骤 1 原文：「对**上下文中抽取到的**每个实体名称 n，调 `resolveEntity(db, n)`」。
- §6 的 `RecallOptions` 只有 `entityIds?: string[]`（**已解析好的 id**），**没有**放名字的入口。
- 本库**不做 NER**（§0.2 / ADR-2）⇒ 库里没有「抽取」这一步的权威实现。
- 工程师的实现口径：在 `src/store/recall.ts` 的 `extractContextEntityNames()` 里用**只读 SQL 全表扫**
  `entities` + `entity_aliases`（`instr(@context, name) > 0`），再逐名调 `resolveEntity`；
  **不传 `entityIds` 时每次 recall 都要付 O(#实体) 的全表扫**，§12 的 P99 ≤ 200ms 没有预算。
- 两个选项：(a) 给 `RecallOptions` 加可选 `entityNames?: string[]`；(b) 阶段 2 的路由侧统一产出 entity id。

### 1.2 裁决

**(a)**。具体契约（已落进 §4.6 步骤 1 与 §6）：

1. `RecallOptions` 新增 **`entityNames?: string[]`**：调用方抽好的实体**名**列表。
2. 库**只**做「名字 → `entity_id`」的归一（逐名 `resolveEntity`，§4.5 末尾的**唯一实现**）；
   **不**做「上下文 → 名字」的抽取。
   - 解析不到的名字（`resolveEntity` 返回 `null`）⇒ **不进图谱路**，但仍参与文本路检索
     （文本路检索的是正文，不需要实体表里有它）——与 §4.6 步骤 1 原文一致。
   - 解析全程**只读**，**不得**因「名字不认识」就建实体（原文「查询路径禁止写库」）。
3. **`entityIds` 与 `entityNames` 互斥**：同时传 ⇒ 抛 `INVALID_INPUT`（五码封闭，不扩 `MemoryErrorCode`）。
   - 传 `entityIds` ⇒ 完全跳过步骤 1 的名称解析（现状不变）。
   - 传 `entityNames` ⇒ 走名称解析。
   - 两者**都不传** ⇒ **图谱路为空**（退化为「文本路 + 向量路」）。
   - `[]` 语义保持不变：**空数组 = 「明确表示无实体」**，图谱路转空。
4. **库内不得出现「扫全表找名字」的隐式路径**（详见 §1.3 的三条理由）。

### 1.3 理由（为什么不选 (b)，以及为什么否掉「库内全表扫」）

**为什么 (b) 不成立**：§4.6 步骤 0 白纸黑字：「**路由只约束向量路；文本路与图谱路不经过路由。**」
把「实体抽取」挂到路由侧，会造成**两条路被另一条路的前置条件绑死**：

> 没配 `embedder`（向量路整条缺席）**或**分桶未训练 ⇒ **图谱路跟着一起消失**。

这在本库是最坏的一种耦合：语义召回缺席不该连累**结构**召回。
且路由的产物是**记忆 id**（`routedIds`），不是实体 id；(b) 实际上是把「实体抽取」改头换面塞进路由，
既没有契约也没有成本模型。

**为什么否掉「库内全表扫」（即工程师当前的实现作为默认路径）**：

| 维度 | 证据 | 结论 |
|---|---|---|
| **归属** | ADR-2：「**实体抽取归属：由调用方提供，库不内置 NER**……`write(input.entities)` 与 `recall(options.entityIds)` 都接受外部结果，库只负责归一（别名）与存储。**调用方不传就退化为纯文本检索，功能仍完整**」 | 库内抽取 = 把抽取归属搬回库里。哪怕实现成「对着自己的实体表做字典匹配」，**「哪些词算实体」的控制权也回到了库里**——那正是 ADR-2 要挡的事 |
| **成本模型** | §4.6 步骤 1 第三条：「`entity_aliases.alias` 为 PRIMARY KEY，`name` 与 `alias` **两次查询均为 O(log n) 索引查找**」 | 本步声明的成本模型是「**按名字索引查**」，不是「扫全表找名字」。库内抽取把成本变成 **O(#实体 + #别名) 的行扫描**；10 万级实体上就是几十~几百毫秒，**一次调用吃掉 §12 的整个 P99 ≤ 200ms 预算**——而这是**每次 recall** 都要付的 |
| **耦合** | §4.6 步骤 0：「路由只约束向量路」 | 同上 |

**但这段代码不必扔**：裁决给出**不返工的两条出路**（见 §1.4 的 C-1.3）——
`extractContextEntityNames` 改造成**独立的公开辅助函数**，由**调用方显式调用**，
调用方自己决定要不要用、用完把结果作为 `entityNames` 传回来。
⇒ ADR-2 不变（是**调用方**在调用它），但便利性保留。

### 1.4 需要的改动清单

**C-1.1（software-engineer-5，`src/store/recall.ts`）**
- `RecallOptions`（当前 L131-178）新增 `entityNames?: string[]`（注释按 §6 的口径抄）。
- `resolveContextEntityIds()`（当前 L477-497）改造为按 §1.2 的 4 条分支：
  `entityIds` 与 `entityNames` 同传 ⇒ 抛 `INVALID_INPUT`；`entityIds` 优先且跳过名称解析；
  只有 `entityNames` ⇒ 逐名 `resolveEntity`（**不建实体**）；都没有 ⇒ 返回 `[]`（图谱路空）。
- **删除** recall 流水线对 `extractContextEntityNames()` 的调用。

**C-1.2（software-engineer-5）** 与 `src/core/errors.ts` 的既有语义对齐：
`INVALID_INPUT` 已在五码封闭集合内，**不需要**扩 `MemoryErrorCode`，
也**不需要**动 `src/core/errors.ts` 的方法级语义表（`recall` 不是 `NOT_FOUND`/`CONFLICT` 类方法）。

**C-1.3（software-engineer-5，二选一，我推荐 A）**
- **A（推荐）**：把 `extractContextEntityNames` + `CONTEXT_ENTITY_NAMES_SQL` 改造成**独立的公开辅助函数**
  `extractEntityNames(db, context): string[]`（导出到 `src/index.ts`），
  文档写明：① **不在召回流水线内**；② 成本 = 每次调用 **O(#实体 + #别名) 行扫描**；
  ③ `instr` 是**子串匹配**，短名/英文短词会误命中（无词边界）。
  ⇒ 调用方想要「用库里已知的实体名做字典匹配」时，自己调它、再把结果塞进 `entityNames`。
- **B**：直接删除；若 app 侧需要字典匹配，由 app 直接查 SQL（库是本地 SQLite，app 有句柄）。

**C-1.4（team-lead，`docs/design/DEVELOPMENT-PLAN.md`）**
- P1-T08 的「关键实现要点」补一条：**实体名由调用方提供**（`entityNames`），库不抽取；
  验收标准补一条 `entityIds` 与 `entityNames` 同传 ⇒ `INVALID_INPUT`。
- P1-T08 验收标准现有的 `graphProximity` / `from*` 用例**不受影响**（测试直接传 `entityIds` 即可）。

---

## 2. GAP-②：§6 的 `Hit` 漏了三个来源标记 —— 裁决「放 `Hit` 顶层」

### 2.1 冲突描述

- §4.6 步骤 2.5 要求「分别记 `fromText` / `fromVector` / `fromGraph` 三个来源标记——**只为排障与 `explain` 展示**，不参与任何计算」。
- §6 的 `Hit` 接口**没有声明**这三个字段；但 §6 的 `breakdown.cos` 注释已经写着
  「⇒ **缺项判定必须靠 `fromVector`（per-hit）** + `explain.routes.vector.ran`（call 级）」——
  **设计稿自己已经在用一个没被声明的字段**。
- 工程师的实现：三个字段放在 **`RecallHit` 顶层**（不放 `breakdown` 里）。

### 2.2 裁决

**确认放在 `Hit` 顶层**，并在 §6 正式声明（已落地）：

```ts
export interface Hit extends MemoryView {
  score: number;
  fromText: boolean;      // 本条是否由文本路命中
  fromVector: boolean;    // 本条是否由向量路命中
  fromGraph: boolean;     // 本条是否由图谱路命中
  breakdown?: { … };
}
```

口径一并写死：
- 三个都是**布尔**，**不参与任何计算**——尤其**不参与 `graphProximity`**
  （那是 §4.6 步骤 3 按「实体交集」现算的，不是「被哪条路召回的」）。
- **至少有一个为 `true`**（能进候选集必然来自某一路）。
- **per-hit 层 ≠ call 级层**：`fromVector`（这一条来自向量路吗）与 `explain.routes.vector.ran`
  （整条向量路本次跑没跑）是**两个层级**——单看 `from*` 区分不了
  「整条路缺席」与「这条路跑了但这条没进它的候选」（§6 `cos` 的缺项规则）。

### 2.3 理由

1. **`breakdown` 的语义是「分项」**（`intensityPart` / `vectorPart` / `textPart` / `graphPart` / `recencyPart` /
   `rawBm25` / `cos`），装进去会变成「分项 + 来源」两套东西混装（§6 注释里
   「与 `raw_bm25` 一样是**原始证据**，不是加权后的分项」就是在守这条线）。
2. §4.6 步骤 2.5 明写它们**不参与计算**——放进 `breakdown` 会诱导下游把它们当分项加总。
3. §6 的 `cos` 注释与 `RecallResult.explain` 注释**已经**按「per-hit 层」在用 `from*`，
   与工程师的放置位置**一致** ⇒ 这是**补齐声明**，不是改设计。

### 2.4 需要的改动清单

- **C-2.1（我已落地）**：§6 的 `Hit` 补三字段 + 口径注释（`docs/design/DESIGN-v2.md` L3937-3946）。
- **C-2.2（software-engineer-5）**：
  - `RecallHit`（`src/store/recall.ts` L217+）的三个字段**位置正确，不用动**；
  - 但**类型名**要对齐 §6：§6 的公开契约叫 **`Hit`**，实现叫 `RecallHit` ⇒
    **以 §6 为准**（对外导出 `Hit`；若要保留 `RecallHit`，只能作为别名并标注弃用）。
    理由：C36「同一件事不得有两套词」；且 §4.13.1 的硬约束在正文里写的是 `Hit.score` / `Hit.breakdown`。

---

## 3. 小口径①：三个字面量不入参数表 —— 认可，但要补理由段

### 3.1 裁决

**认可刻意硬编码、不进 §5 参数表**（`CANDIDATE_FETCH_LIMIT=100` / `ROUTE_CANDIDATE_LIMIT=20` / `MAX_TOP_N=8`）。
**代码不用改**（工程师已在常量旁写了「为什么不是参数」的注释 ✓，C26 已满足一半）。

**但设计稿要补**：这三个数字在正文里**本来就没有「为什么不是参数」的理由**
（对照：五项权重有「必须和为 1 + 调它没有指标能验证」的完整理由段，`normBm25` 斜率 0.2 也有）
⇒ 按 C26「硬编码须在正文写明」，这是**设计稿的欠账**，不是工程师的错。

### 3.2 理由（三条，逐条对应设计稿原文）

| 字面量 | 设计稿原文位置 | 为什么不是参数 |
|---|---|---|
| `LIMIT 100` | §4.6 步骤 2a / 2b / 2c 的预取上限 | 它决定「**候选池有多大**」，不决定「谁有资格」；改它没有可验证的指标（改成 200 只会让精筛后的候选更多，不会让 topN 更准）；且与同为硬编码的 `VECTOR_TOPK × VECTOR_OVERFETCH_FACTOR` 耦合 ⇒ 改一个必须改另一个 |
| `slice(0, 20)` | §4.6 步骤 2a / 2b 的每路候选上限 | 它是「每路送进融合打分多少条」的**形状**参数，不是语义阈值；改它改的是「哪几条能参与排名」，无法用单一指标验证好坏 |
| `topN ∈ 1~8` | §6 `RecallOptions.topN` | 它是**公开 API 的取值域**，不是运行时旋钮：调小改的是「这次给你看几条」，与召回质量无关；放开上限会直接放大「向量只进 score」带来的 topN 自我强化风险（§0.2） |

⇒ 三者与「五项权重」「normBm25 斜率 0.2」**同构** ⇒ 改它们是一次**设计变更**，走 §13 的 ADR，不是运行时配置。
（工程师原话「若要进表需走 ADR，两个脚本期望值要同步改」——**同意**，但本次**不进表**。）

### 3.3 需要的改动清单

- **C-3.1（我已落地）**：§4.6 步骤 2 新增「★ 三个字面量的归属（刻意硬编码，不进 §5 参数表）」段 + 对照表 + 「实现时必须在代码里写明」的提醒。
- **C-3.2（software-engineer-5）**：无需改代码；把「为什么不是参数」注释与 §4.6 新增段的措辞对齐即可（可选）。

---

## 4. 小口径②：`SELECT m.*` 只选六列 —— 认可

### 4.1 裁决

**认可只 SELECT 用到的列**（当前实现：`id` / `stability` / `pin_factor` / `last_access` / `created_at` + `raw_bm25`）。
§4.6 步骤 2a/2b/2c 里的 `SELECT m.*` 是**伪代码**（示意「取这条记忆」），**不得**照抄。

### 4.2 理由（把量级算清楚）

- `memories.embedding` 的 schema 定义：`embedding BLOB CHECK (embedding IS NULL OR length(embedding) % 4 = 0)`
  ⇒ float32 ⇒ **768 × 4 = 3KB/行**。
- 每路预取 **100 行** ⇒ `m.*` 会把 **≈300KB/路/次** 的向量原样搬进 JS 侧；
  **三路合计近 1MB/次**（`better-sqlite3` 每次都分配一份 Buffer）。
- 而召回链路里**没有一处需要向量本身**：向量路的 `cos` 由**桶内点积**算出（§4.6 步骤 2c），
  §6 的 `MemoryView` 也「**刻意不返回向量本身**」（理由同源：768 维 × topN=5 ≈ 15KB）。
- ⇒ 这是**同一条取舍的三个面**：向量不该在只读路径上流动。

### 4.3 需要的改动清单

- **C-4.1（我已落地）**：§4.6 步骤 2 新增「★ `SELECT m.*` 是伪代码：只 SELECT 用到的列」段（含 3KB/300KB 的量级与理由）。
- **C-4.2（software-engineer-5）**：无需改代码（实现已经是显式列 ✓，注释里已写明「只 SELECT 需要的列（不是 `m.*`）」）。

---

## 5. 小口径③：归档模式要不要跳过强度精筛 —— 裁决「**整体不执行**」

### 5.1 冲突描述

- §4.6 步骤 2 原文（**两句话互相打架**）：
  「includeArchived = true：令 @coarseCutoff = 0（不设 last_access 粗筛），
  **精筛阈值 @archiveLine = 0.0，即只过滤 deleted = 0**，归档记忆照常参与打分与排序。」
- 精筛是**严格大于**（§4.6 步骤 2 / `passesIntensityFilter` 的注释明写「严格大于：设计稿原文是 `intensity > ARCHIVE_LINE`（不是 `≥`）」）。
- ⇒ 「阈值 0.0」与「只过滤 deleted = 0」**在数值上不等价**：
  一条 `intensity` 因 `exp` **下溢成恰好 0.0** 的记忆仍会被挡掉。
- 工程师的现状：**不跳过**，并在测试里刻意用 700 天避开下溢边界。

### 5.2 裁决

**归档模式下强度精筛整体不执行**（不是「阈值改成 0」，是**不做这个判定**）：

- `includeArchived = true` ⇒ `@coarseCutoff = 0`（无时间窗）+ **不判强度** + 只保留 `deleted = 0`。
- 三路一致（铁律①：准入闸门对三路一视同仁——归档模式下三路都**不**做强度精筛）。
- 被放行的记忆**照常参与打分与排序**（`intensity` 分项照常算，可能接近 0 ⇒ 自然沉底，不会霸榜）。

### 5.3 理由

1. **设计稿自己的意图是「只过滤 deleted = 0」**——那句「即只过滤 deleted = 0」是**意图**，
   「阈值 = 0.0」是**实现草稿**，两者冲突时以意图为准（本设计一贯：意图写进正文，实现草稿是可改的）。
2. **下溢不是理论边角**：`intensity = min(1, exp(-Δt / (τ × 86400000)))`，
   IEEE-754 双精度下 `exp(-745)` 就已经贴到最小非规格化数、`exp(-746)` 直接变 **0.0**
   ⇒ **下溢条件是 `Δt / τ > 745 天`**。
   - `τ = stability × pin_factor`，而 schema 对 `stability` 的约束只有 **`CHECK (stability > 0)`**（**没有下界**）
     ⇒ 一个 `stability = 0.001 天`（≈86 秒）的记忆，**不到一天**就会下溢到 0。
   - 即便按常规 `stability = 1 天` 算，**两年多**没被访问的记忆也会正好下溢——归档层里**非常常见**。
3. **被挡掉的方式最坏**：归档模式下 `@coarseCutoff = 0` ⇒ SQL **没有时间窗** ⇒ 这些行**已经被捞进来了**，
   却在应用层被悄悄丢掉 ⇒ 「显式查询归档层」**名存实亡**，而且**不报错**（最坏的一类缺陷）。
4. **不跳过会破坏 `includeArchived` 的可观测性**：调用方明确点名要归档层，却拿到一条不完整的结果，
   且**无从得知**（没有日志、没有告警）。

### 5.4 需要的改动清单

- **C-5.1（我已落地）**：
  - §4.6 步骤 2 的 `includeArchived` 参数化段改写为「**精筛阈值不参与判定**」+ 勘误说明（两句不等价 + 下溢条件 + 「已被捞进来却丢掉」的后果）；
  - §4.6 步骤 2a / 2b / 2c 三处「应用层精筛」各加一句「**归档模式下本精筛整体不执行**」（三路一致）；
  - §6 的 `includeArchived` 字段注释同步（C25：同一规则几处描述值须一致）。
- **C-5.2（software-engineer-5）**：
  - `filterAndSlice()`（`src/store/recall.ts` 约 L557-577）改成：`includeArchived === true` 时**不调用**
    `passesIntensityFilter`；`false` 时行为不变。
  - `archiveFilterThreshold(params, includeArchived)`（`src/core/scoring.ts` L644）——
    归档分支返回 `0` 会留下「阈值 0 可用」的陷阱。建议二选一：
    - **(i) 推荐**：调用点分支（`if (!includeArchived && !passesIntensityFilter(v, line)) continue;`），
      并把 `archiveFilterThreshold` 的归档分支**删掉**（或改成返回 `null` 并在 doc 里写明「归档模式下无阈值」）；
    - **(ii)**：保留函数但把 doc 改成「归档模式下**本阈值不参与判定**」，调用点仍然要分支。
    ⇒ **不要**用 `-Infinity` 之类的魔法值绕过（设计稿里没有这个数，会变成新的 C36 隐患）。
  - **补一条边界测试**：一条 `intensity` 恰好下溢到 `0.0` 的记忆（例：`stability = 0.001` 天、
    `last_access = now - 200 天` ⇒ `Δt/τ = 200000` ⇒ `exp(-200000) = 0`）
    ⇒ `includeArchived: true` 时**必须出现在结果里**；`includeArchived: false` 时**必须不出现**。
    （工程师当前「刻意用 700 天避开下溢边界」的做法可以保留为**正向用例**，但**边界用例必须补上**。）

---

## 6. 额外发现（F 系列）

| # | 发现 | 处置 |
|---|---|---|
| **F-1** | 实现里的类型名是 `RecallHit`（`src/store/recall.ts` L217），§6 的公开契约叫 `Hit` | **以 §6 为准**（见 C-2.2）。不反过来改 §6：§4.13.1 的正文写的是 `Hit.score` / `Hit.breakdown`，改 §6 反而要动更多锚点 |
| **F-2** | §6 原注释写「`entityIds`……传入则跳过 §4.6 步骤 1 的**实体抽取**」——库里根本不抽取，措辞会误导实现者以为库里有抽取步骤 | 已随 C-1 一并改为「跳过 §4.6 步骤 1 的**名称解析**」 |
| **F-3** | 实现里 `src/store/recall.ts` 的 `RecallOptions` 是**本地副本**，不是从 §6 同步的 | 代码侧改（与 C-1.1 同批）；**新增字段必须两边同步**，否则又是 C36 |
| **F-4** | `explain.routes.graph.ran` 的定义是「本次没有解析出任何实体」⇒ 与新语义（都不传 ⇒ 图谱路空）**天然一致**，无需改 | 保持；但 `ran=false` 的**原因**在调用方侧（没给实体）⇒ 查看器面板文案将来要能区分「没给实体」与「给了但都没解析到」——**阶段 3 的查看器任务再处理**，本轮不动 |
| **F-5** | `graphProximity` 按「实体交集」现算，与「这条是不是被图路召回的」无关 ⇒ 归档模式与新语义**都不影响它** | 无需改动 |

---

## 7. 我直接落地的改动（`docs/design/DESIGN-v2.md`）+ 门禁实测

### 7.1 改动清单（全部在 `docs/design/DESIGN-v2.md`，8 处）

| # | 位置（改后行号） | 改前 → 改后 |
|---|---|---|
| E-1 | §4.6 输入行（L1129-1132） | `entityIds?、queryEmbedding?` ⇒ `entityIds?、entityNames?、queryEmbedding?`；并加「两者互斥 ⇒ `INVALID_INPUT`」一行 |
| E-2 | §4.6 步骤 1（L1134-1169） | 整段重写：写死「名字由调用方提供、库不抽取」「`entityNames` 入口」「互斥规则」「都不传 ⇒ 图谱路空」「★ 为什么库内抽取不算数（三条理由）」 |
| E-3 | §4.6 步骤 2 的 `includeArchived` 参数化（L1251-1266） | 「精筛阈值 @archiveLine = 0.0，即只过滤 deleted = 0」⇒「**精筛阈值不参与判定**——归档模式下**不做强度精筛**」+ 勘误说明（下溢条件 / 已被捞进来却丢掉） |
| E-4 | §4.6 步骤 2 新增段（L1267-1275） | ★「三个字面量的归属（刻意硬编码，不进 §5 参数表）」+ 对照表 + C26 提醒 |
| E-5 | §4.6 步骤 2 新增段（L1276-1284） | ★「`SELECT m.*` 是伪代码：只 SELECT 用到的列」+ 3KB/300KB 量级 |
| E-6 | §4.6 步骤 2a（L1322-1325）/ 2b（L1339-1342）/ 2c（L1388-1392）的「应用层精筛」 | 三处各加一句「**归档模式下本精筛整体不执行**」（2c 的 ①③ 与归档无关，② 归档时不执行） |
| E-7 | §6 `RecallOptions`（L3856 起；`entityIds` L3862、`entityNames` L3865-3870、`includeArchived` L3871-3872） | 新增 `entityNames?: string[]`；改 `entityIds` 注释（互斥 + `[]` 语义 + 「名称解析」措辞）；`includeArchived` 注释补「归档模式不做强度精筛」 |
| E-8 | §6 `Hit`（L3935-3946；注释 L3937-3943、三字段 L3944-3946） | 新增 `fromText` / `fromVector` / `fromGraph` + 口径注释（布尔、不参与计算、至少一个为 true、per-hit ≠ call 级） |

### 7.2 门禁实测

- `pnpm run verify` ⇒ **EXIT = 0**
  （typecheck ✓ / lint ✓ / **vitest：24 个测试文件 / 498 条测试全绿** /
  `check:params`（§5 表 60 项 ↔ `DEFAULT_PARAMS` 60 键逐键逐值相等）✓ /
  `check:payload-keys`（§8.4 13 个 type）✓ / `check:clock` ✓ / `check:anchor` ✓ /
  `check:contract-ids` ✓ / `check:doc-counts`（60 项）✓）。
- 行尾自检：`docs/design/DESIGN-v2.md` 与本文件 **CR = 0**（纯 LF，`LC_ALL=C tr -cd '\r' < f | wc -c`）。
- 未触碰：`src/store/write.ts`、`src/store/merge.ts`、`src/core/params.ts`（60 项未动）、
  `src/core/errors.ts`（五码未扩）、§8.4 事件 payload 表（门禁解析面未动）、
  `docs/design/DEVELOPMENT-PLAN.md`（改动清单交回 team-lead）。

---

## 8. 我没有把握、需要进一步确认的部分

1. **GAP-① 的「调用方要不要便利函数」是产品取舍，不是纯技术判断。**
   我的裁决是「库**可以**提供独立辅助函数，但必须在召回流水线之外、由调用方显式调用」。
   如果产品侧认为「让 app 自己做字典匹配」成本更高（即更希望库把这个便利做进 `recall`），
   那就是**改 ADR-2 的边界**，要走 §13 的 ADR 流程，而不是我在这里改一行字。
   ⇒ **需要 team-lead 确认：阶段 2 的 app 层是否愿意自己做实体抽取。**
2. **互斥 vs 并集**：我选了「同传 ⇒ `INVALID_INPUT`」，理由是「取舍 = 静默丢弃调用方的一半意图」。
   但「并集」也是确定性语义，且对迁移期更友好。**如果产品更看重平滑迁移**，
   可以改成并集——但那样 `[]` 的「明确无实体」语义要重新写（`[]` + 非空 names ⇒ 并集含 names）。
   ⇒ 需要 team-lead 拍一个偏好（我给默认值：互斥）。
3. **`entityNames` 是否要接受「主名 + 别名」两种形态**：现在 `resolveEntity` 对两者都能解析（主名优先），
   所以**不用**额外设计；但如果将来要求调用方只给主名，那是 `resolveEntity` 的语义问题，不在本次范围。
4. **归档模式不判强度 ⇒ 候选池可能显著变大**：归档层里可能有大量 `intensity≈0` 的行，
   它们会占满三路各 20 条的名额，**把新鲜记忆挤出 topN**。
   设计稿没写这一点。**我在本轮没有加限制**（因为 §4.6 只写了「归档记忆照常参与打分与排序」）。
   ⇒ **建议在阶段 2 的性能回归里盯一眼 `includeArchived: true` 时的 topN 质量**；
   若确实挤占严重，正确做法是**排序层面的配额**，不是**把归档记忆加回精筛**（那会重犯本条裁决的错）。
5. **`SELECT m.*` 只选六列**：当前实现选的是 `id / stability / pin_factor / last_access / created_at` + `raw_bm25`。
   §6 的 `MemoryView` 还有 `content / kind / layer / difficulty / accessCount / confidence / source / deleted / deletedAt / mediaRef / mediaType / entities`。
   **本轮 recall 的打分不需要它们**（`layer` 是现算的、`entities` 要另查、`content` 只在展示层要），
   所以「六列」是**对的**；但**查看器的「召回模拟器」要展示命中内容**，届时需要再查一次或加列。
   ⇒ 需要在 P1-T09/阶段 3 的查看器任务里确认一次「命中详情怎么取 `content`」。

---

## 9. 一句话交接

> **两处缺口都已补齐**：实体名入口落在 `RecallOptions.entityNames`（库只归一、不抽取，
> 与 `entityIds` 互斥，都不传则图谱路空——ADR-2 的「调用方不传就退化为纯文本检索」就是它）；
> `fromText/fromVector/fromGraph` 落在 §6 的 `Hit` 顶层（来源标记，不是分项）。
> **三条小口径全部认可**，其中归档模式那条是**设计稿自相矛盾**（「阈值 0.0」≠「只过滤 deleted = 0」），
> 裁决为**归档模式不做强度精筛**——否则强度下溢成 0 的归档记忆会被静默丢掉。
> 代码改动清单见 §1.4 / §2.4 / §5.4，由 software-engineer-5 在其分支一次带完；
> DEVELOPMENT-PLAN.md 的两条验收标准由 team-lead 统一补。
