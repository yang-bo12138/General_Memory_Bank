# ADR-P1-C · P1-T05 / P1-T06 实现阶段暴露的 7 条设计冲突 —— 裁决报告

> **作者**：高见远（架构师）
> **日期**：2026-10-31
> **工作树**：`D:/Git/repo`（分支 `main`，基线 HEAD = `7c98987`）
> **依据**：`docs/design/DESIGN-v2.md`（v2.1 记忆海版）、`docs/design/DEVELOPMENT-PLAN.md`、
> `src/` 已落地实现、`schema/001_schema_v2.sql`、9 条 CI 门禁脚本。
> **本报告的产出**：
> 1. 7 条冲突的**逐条裁决**（定了什么 / 为什么这么定 / 为什么不选另一边）；
> 2. 每条裁决的**「需要改动的清单」**（文件 + 位置 + 改前 → 改后）；
> 3. **已由我直接落地的改动**（仅两个文件，见 §3），并附**实测门禁结果**。
>
> ⚠️ **本报告不改 `src/store/write.ts` / `src/store/merge.ts`**（开发线 `D:/Git/wt/p1-t07t09` 的文件域），
> 也不碰 `src/store/transaction.ts`、`src/store/link.ts`、`src/store/entities.ts`、`src/core/errors.ts`
> ——这些文件的改动全部以**清单**形式交给主理人统一执行。
> ⚠️ **不扩 `MemoryErrorCode`**（五码封闭）、**不动 `src/core/params.ts` 的 60 项参数**。

---

## 0. 摘要（7 条裁决一览）

| # | 冲突 | 裁决 | 落地代价 |
|---|------|------|----------|
| 1 | `aliasAdded` 的语义（string vs boolean） | **`aliasAdded` = 布尔**（是否新增/改写了别名映射）；**被降级的源主名记在 `alias` 键** | 设计稿勘误（已落地）＋ 类型注释（已落地）＋ **`src/store/entities.ts` 注释要改口** |
| 2 | `link` 的 `NOT_FOUND` 里 `details` 装什么 | **端点缺失 ⇒ `details.missingEntityNames`（实体名）；`memoryId` 缺失 ⇒ `details.missingIds`（id）** | 新增 1 个 details 键 ＋ `link`/`linkByIds` 补 `memoryId` 自校验 |
| 3 | `mergedEdges` 的计数口径 | **只数「因三元组冲突而被折叠掉」的边**（仅改指的无冲突边不计入） | 设计稿勘误（已落地）＋ 实现**无需改** |
| 4 | `growStability` 的参数顺序 | **采纳设计稿**：`now` 在**最后**（`store, m, baseGrowth, useSpacing, now?`） | **零改动**（实现本来就符合）—— ⚠️ 冲突描述的前提有误 |
| 5 | `src/store/transaction.ts` 是否越界 | **符合设计意图，予以保留** | 零改动 |
| 6 | `mergeEntities` 要不要预校验 `memoryId` | **不加预校验**（schema **确有**外键，但迁移**逐字拷贝** `memory_id` ⇒ 不可能违反） | 设计稿勘误（已落地） |
| 7 | 阶段 1 的 `write` 补写向量但 `assignBucket` 尚不存在 | **选项 (b) 的强化版**：照写 `memories.embedding`、**不写桶**；★ 阶段 2 必须补一条「集合相等」硬断言 | 设计稿勘误（已落地）＋ 阶段 2 的验收断言 |

---

## 1. 冲突 1 · `aliasAdded` 的语义（★ 需核实并裁决）

### 1.1 冲突描述（两处原文 + 实现）

| 位置 | 原文 / 实现 | 语义 |
|------|------------|------|
| `docs/design/DESIGN-v2.md` §4.9.2 步骤 5（改前 L2214-2215） | `payload={ action: 'merge', sourceId, targetId, movedMemories, mergedEdges, droppedSelfLoops, aliasAdded: sourceName }` | **字符串** = 被降级为别名的源实体主名 |
| `docs/design/DESIGN-v2.md` §8.4 的 `alias` 行（改前 L4586） | `` `action('set'/'merge'), alias?, entityId?, prevEntityId?, sourceId?, targetId?, movedMemories?, mergedEdges?, droppedSelfLoops?, aliasAdded?` `` | **未写类型** |
| `src/core/events.types.ts` L119-131（改前） | `aliasAdded?: boolean;` | **布尔** = 是否新增了别名 |
| `src/store/entities.ts` L265-274 | `payload = { action:'merge', sourceId, targetId, movedMemories, mergedEdges, droppedSelfLoops, aliasAdded: true, alias: sourceName }` | **布尔** + 名字另存 `alias` |
| `src/store/entities.ts` L46 | `MergeEntitiesResult.aliasAdded: string`（**函数返回值**） | **字符串** = 源主名 |

⇒ **同一个键名 `aliasAdded`，在仓库里同时存在「布尔」与「字符串」两种语义**，
且**返回值与事件 payload 内部也不一致**（`string` vs `boolean`）。
`src/store/entities.ts` L261-264 的注释已**自行承认**了这个漂移并选了「以类型声明为准」，
但**没有回改设计稿** ⇒ 漂移被固化下来了。

### 1.2 裁决

> **`aliasAdded` = 布尔**（本次是否新增/改写了一条「别名 → 实体」映射）；
> **被降级为别名的源实体主名本体，记在 `alias` 键上。**
>
> - `action='merge'` ⇒ `aliasAdded: true`（源主名必然被降级为目标的别名）；
> - `action='set'` ⇒ **不带** `aliasAdded` 键；
> - `alias` 在**两个 action 下都是「本次涉及的别名名」**：
>   `set` ⇒ 被设置的别名；`merge` ⇒ 被降级的源主名。

### 1.3 理由（以及为什么不选另一边）

**为什么不选「`aliasAdded` 装名字（字符串）」：**

1. **会让同一个事件类型出现两套词。** 若 `merge` 用 `aliasAdded` 装名字、`set` 用 `alias` 装别名，
   那么「别名名」这件事在 `alias` 与 `aliasAdded` 两个键之间被劈成两半，
   读事件的人必须先看 `action` 才知道该读哪个键 ⇒ 违反 §14.3.1 的 **C36**
   （同一件事不得有两套词）。现在 `alias` 一键贯穿两个 action，语义统一。
2. **信息并没有因此增加。** 合并会 `DELETE FROM entities WHERE id = @sourceId`（§4.9.2 步骤 4）
   ⇒ **源实体的主名在库里只剩「别名表」与「事件」两处**。
   `alias` 键保住了名字、`aliasAdded` 键说明了「确实动过别名映射」⇒ **一条不丢**。
3. **类型即契约。** `AliasEventPayload.aliasAdded?: boolean` 已经落地、已被 `EVENT_PAYLOAD_KEYS`
   登记、已被 427 条测试覆盖；改它的类型要连带改 `src/store/entities.ts`（**本次不在授权编辑范围**），
   会直接让 `tsc --noEmit` 变红。⇒ 选「布尔」这一边，**代码零改动**、设计稿单方面勘误即可闭环。

**为什么不是「两边都改」**：让 `aliasAdded` 变成字符串必须同步改 `src/store/entities.ts` 的
payload 构造（L272）与返回值类型（L46），那会把「事件 payload 的语义裁决」与
「函数返回值的字段命名」两件事捆在一起改，扩大改动面而**不换来任何额外信息**。

**返回值那处不一致怎么处理**：`MergeEntitiesResult.aliasAdded: string`（返回值）与
payload 的 `aliasAdded: boolean` 仍然同名不同义。**本报告不在授权编辑范围内改 `src/store/entities.ts`**，
⇒ 已列入 §2 的「需要改动的清单」（建议：返回值改用 `sourceName: string` + `aliasAdded: boolean`，
或至少在注释里写明「返回值的 `aliasAdded` 是被降级的主名，与事件 payload 的同名键不同义」）。

### 1.4 需要改动的清单

| 文件 | 位置 | 改动 | 谁执行 |
|------|------|------|--------|
| `docs/design/DESIGN-v2.md` | §4.9.2 步骤 5（改前 L2214-2215 → **现 L2289-2305**） | 改 `aliasAdded: sourceName` ⇒ `aliasAdded: true, alias: sourceName` ＋ 口径说明 | **我已落地** |
| `docs/design/DESIGN-v2.md` | §8.4 表后（**现 L4686-4700**） | 新增「`alias` 行的字段类型约定」块（⚠️ **必须放在表外**，见 §9 门禁说明） | **我已落地** |
| `src/core/events.types.ts` | `AliasEventPayload`（**现 L119-171**） | **类型不变**（`aliasAdded?: boolean`）；补齐逐字段 JSDoc ＋ 口径说明 | **我已落地** |
| `src/store/entities.ts` | L261-264 的注释 | 注释里「以类型声明为准」的口径**已由本裁决正式确认** ⇒ 改为引用 §4.9.2 步骤 5 的新原文，并补一句「返回值 `aliasAdded` 是源主名，与 payload 同名键不同义（待改名）」 | 主理人 |
| `src/store/entities.ts` | L46 `MergeEntitiesResult.aliasAdded: string` | 建议改名 `sourceName: string`（或加注释显式声明「与 payload 同名键不同义」） | 主理人 |
| `tests/unit/entities.test.ts` | L220-221 | 已断言 `payload.alias === '张三'` ⇒ **与本裁决一致，无需改**；建议补一条 `expect(payload.aliasAdded).toBe(true)` 固化布尔口径 | 主理人 |

---

## 2. 冲突 2 · `link` 的 `NOT_FOUND` 里 `details` 装什么

### 2.1 冲突描述

| 位置 | 原文 / 实现 | 说明 |
|------|------------|------|
| `DEVELOPMENT-PLAN.md` P1-T05 L872 | `payload={ action:'merge', ..., aliasAdded }` | 未写 `aliasAdded` 取值（见冲突 1） |
| `DEVELOPMENT-PLAN.md` P1-T05 L880 | 「`link(..., { createMissing: false })` 对不存在的实体 ⇒ 抛 `NOT_FOUND` 且**零写入**」 | **没说 `details` 装什么** |
| `src/core/errors.ts` L192 | `export const MISSING_IDS_KEY = 'missingIds';`（注释：「承载『**缺失 id 差集**』的键名」） | 键名语义 = **id** |
| `src/core/errors.ts` L200 | `export const NOT_FOUND_METHODS_WITH_MISSING_IDS = ['touch', 'linkByIds'];` | **`link` 不在其中** |
| `src/store/link.ts` L182-186 | `throw MemoryError.notFound(..., { missingIds: missingNames })` | ⚠️ **键名是 `missingIds`，内容是实体名** |
| `src/store/link.ts` L294-299（`linkByIds`） | `{ missingIds: missing }`（内容是**实体 id**） | 与 `link` 同键、不同内容类型 |
| `DESIGN-v2.md` §11.2（改前 L5245-5246 / L5301-5305） | 「**`link` / `linkByIds` 的 `memoryId`（记忆）同样必须自校验**」；自校验清单：「· `link` ⇒ **`memoryId`（记忆）**（两端实体由 `resolveEntity` 保证）」 | ⚠️ **`link` 的 `missingIds` 按设计稿本意是给 `memoryId` 用的** |

### 2.2 裁决

> **`link` 的 `details` 按「装的是 id 还是名字」分成两个键：**
>
> | 情形 | 键 | 内容 |
> |------|-----|------|
> | 端点实体缺失（`createMissing: false`） | **`details.missingEntityNames`** | 缺失的端点**实体名**（`link` 的入参是名字） |
> | `memoryId` 缺失 | **`details.missingIds`** | 缺失的**记忆 id** |
>
> ⇒ **`link` 应当被加入 `NOT_FOUND_METHODS_WITH_MISSING_IDS`**（它确实有一条「带 `missingIds`」的路径）。
> ⇒ **`link` / `linkByIds` 必须自己校验 `memoryId`**（§11.2 的自校验清单已明写，当前实现**缺**这一步）。

### 2.3 理由（以及为什么不选另一边）

1. **`missingIds` 的键名语义是「行 id 差集」，不是「入参差集」。**
   `src/core/errors.ts` L192 的注释、§11.2 的 FK 兜底句（「本库所有 FK 列都是 **id 引用**
   ⇒ FK 违规 ⇒ `NOT_FOUND`（带 `details.missingIds`）」）都把它绑在 **id** 上。
   让它装**实体名**，等于同一个键在 `touch`/`linkByIds`（装 id）与 `link`（装名字）下表达两件事
   ⇒ 与 C36 同源。
2. **为什么不选「干脆不给 `details`」**：调用方传了两个端点名，
   **不告诉它是哪一个缺失**，调用方就得自己再查一次库才能决定重试还是改参 ⇒ 把成本推给调用方。
3. **为什么不选「沿用 `missingIds` 装名字，只在注释里说明」**：这就是现状，
   而现状正是**本次冲突的成因**——一个键名两套内容类型，下一个实现者必然再踩一次。
   ⇒ 「注释说明」治不了「键名不匹配」这个结构性问题（§4.2 的 `growStability` 收拢就是同一条纪律：
   **注释提醒会漏读，单一函数才让「漏」变成编译不过**）。
4. **为什么键名取 `missingEntityNames` 而不是 `missingNames`**：
   与仓库既有词汇一致（`entityNames`，§4.9 步骤 4 的 write 事件 payload；`autoCreatedEntities`，§4.5 步骤 2）
   ⇒ C36「同一套词」。备选 `missingNames` 亦可，但前者更明确地表示「是实体名、不是记忆名」。

### 2.4 需要改动的清单

| 文件 | 位置 | 改动 | 谁执行 |
|------|------|------|--------|
| `docs/design/DESIGN-v2.md` | §4.5 步骤 2（**现 L985-997**） | 新增「`details` 的键名按内容分族」说明（已落地） | **我已落地** |
| `src/core/errors.ts` | L192 附近 | 新增 `export const MISSING_ENTITY_NAMES_KEY = 'missingEntityNames';`（附注释说明与 `MISSING_IDS_KEY` 的分工） | 主理人 |
| `src/core/errors.ts` | L200 | `NOT_FOUND_METHODS_WITH_MISSING_IDS` ⇒ 追加 `'link'`（⚠️ 门禁不会因此变红：`check-contract-ids.ts` 只断言「名单里的方法必须在 `METHODS_THROWING_NOT_FOUND` 里」，`link` 在其中） | 主理人 |
| `src/store/link.ts` | L175-187 | 端点缺失分支 ⇒ `{ missingEntityNames: missingNames }`（**不再用 `missingIds`**） | 主理人 |
| `src/store/link.ts` | 步骤 1 之前 | 新增 **`memoryId` 存在性自校验**：不存在 ⇒ `NOT_FOUND` + `{ missingIds: [memoryId] }` | 主理人 |
| `src/store/link.ts` | `linkByIds`（L278-345） | 同样新增 **`memoryId` 存在性自校验**（§11.2 明写 `linkByIds` 也要自校验 `memoryId`） | 主理人 |
| `scripts/check-contract-ids.ts` | `EXPECTED_MISSING_IDS_ANCHORS`（L63-73） | 建议加一条锚点：`{ section: '§4.5 步骤 2', heading: SECTION_4_5_HEADING, method: 'link' }`（§4.5 已含 `details.missingIds`，加不加都不红；加了能挡住「把 `link` 的 memoryId 校验删掉」） | 主理人 |

### 2.5 ⚠️ 附带发现（**不在 7 条之内，但必须处理**）

**`link` / `linkByIds` 目前没有校验 `memoryId` 是否存在。**
⇒ 传一个不存在的 `memoryId` 会撞 `edges.memory_id` 的外键
⇒ 在 `PRAGMA foreign_keys = ON`（§9.1，每连接都开，`src/db/connection.ts` L70/L88）下
抛 `SQLITE_CONSTRAINT_FOREIGNKEY` ⇒ 被 `translateSqliteError` 转成 `NOT_FOUND`，
**但 `details` 里没有 `missingIds`** ⇒ **违反 §11.2 的自校验清单**
（「`link` ⇒ `memoryId`（记忆）」「`linkByIds` ⇒ `subjectId`/`objectId` 与 `memoryId`」）。
⇒ 这是 **P1-T05 的实现缺口**，请软件工程师-2 补上（见 §6 的协作消息）。

---

## 3. 冲突 3 · `mergedEdges` 的计数口径

### 3.1 冲突描述

| 位置 | 内容 |
|------|------|
| `DESIGN-v2.md` §4.9.2 步骤 2（改前 L2184-2201） | 冲突分支：`e2.weight = …; e2.last_active = …; e2.memory_id = …;` ＋ **`DELETE FROM edges WHERE id = e.id;`**；<br>无冲突分支：**`UPDATE edges SET subject_id = CASE …, object_id = CASE …`**（**只改指，不删**） |
| `src/store/entities.ts` L202 / L234 | `let mergedEdges = 0;` … **`mergedEdges += 1` 只在冲突分支**（`deleteEdge.run(...)` 之后） |
| `DEVELOPMENT-PLAN.md` P1-T05 L863-865 | 只写了「冲突时取和…然后 `DELETE FROM edges WHERE id = e.id`」，**未说计数口径** |
| `tests/unit/entities.test.ts` L198-223 | 断言 `payload.mergedEdges === 1`——该用例里「冲突合并数」与「迁移边总数」**恰好都等于 1** ⇒ **这条断言不区分两种口径** |

### 3.2 裁决

> **`mergedEdges` = 本次因三元组冲突而被折叠（合并）掉的边数**，
> 即 §4.9.2 步骤 2 里 `DELETE FROM edges WHERE id = e.id` 那一支的执行次数。
> **仅改指、无冲突的边不计入。**
> ⇒ **实现（`src/store/entities.ts`）正确，无需改动**。

### 3.3 理由

1. **§4.9.2 步骤 2 的伪代码里，「合并」这个动作只发生在冲突那一支。**
   无冲突的边走 `UPDATE`（**改指**）——它的三元组没变、边没消失、数量没变。
   把这种边算进 `mergedEdges` ＝ 把「搬迁」叫成「合并」。
2. **命名上的刻意对照。** payload 里与它并列的是 **`movedMemories`** = 迁移的记忆关联条数
   （**全部**迁走的行，含目标本来就有的那些）。若 `mergedEdges` 也表示「迁移了几条边」，
   两个键就同义了 ⇒ 一个 payload 里两个键表达同一件事。**现状是刻意不同义的**：
   `moved*` = 迁移，`merged*` = 合并。
3. **★ 决定性理由：口径一选定，就得到一条可对账的恒等式。**
   ```
   合并前的边数 − 合并后的边数 == mergedEdges + droppedSelfLoops
   ```
   （每次冲突合并净删一条边；每次自环清理净删一条边；这两者之外边数不变）
   ⇒ 计数一旦漂移（例如改成「迁移的边总数」），这条恒等式立刻不成立 ⇒ **可被当场抓住**。
   「迁移边总数」口径**没有**任何类似的恒等式可依 ⇒ 它是一个无法核对的数字。
4. **实现侧证据**：`src/core/graph.ts` 的 `mergeEdges(target, source, params)` 是**两条撞三元组的边**的合并算子
   （取和不取大）⇒ 「merge」这个词在本模块里**专指冲突合并**，不含改指。

### 3.4 需要改动的清单

| 文件 | 位置 | 改动 | 谁执行 |
|------|------|------|--------|
| `docs/design/DESIGN-v2.md` | §4.9.2 步骤 2（**现 L2267-2276**） | 补口径说明 + 可对账恒等式 | **我已落地** |
| `docs/design/DESIGN-v2.md` | §8.4 表后（现 L4690-4693） | 三个计数的口径各一句 | **我已落地** |
| `src/core/events.types.ts` | `AliasEventPayload.mergedEdges`（现 L150-156） | 补 JSDoc 口径 + 恒等式 | **我已落地** |
| `src/store/entities.ts` | L234 | **不改**（口径正确） | — |
| `tests/unit/entities.test.ts` | 建议新增 | 一条**能区分两种口径**的用例：源实体有 2 条边、其中 1 条与目标撞三元组 ⇒ 断言 `mergedEdges === 1`（迁移边总数会是 2） | 主理人 |
| `DEVELOPMENT-PLAN.md` | P1-T05 L872 | 在步骤 5 的要点里补一句「`mergedEdges` = 冲突合并掉的边数（不含仅改指的边）」 | 主理人 |

---

## 4. 冲突 4 · `growStability` 的参数顺序与返回形状

### 4.1 冲突描述（⚠️ **冲突描述的前提与仓库现状不符**）

| 冲突描述的说法 | 仓库实测 |
|--------------|---------|
| 「线 B 的实现（`src/store/touch.ts`）把 `now` 放在**第二个位置**（`growStability(db, m, now, baseGrowth, useSpacing)`）」 | ❌ **不成立**。`src/store/touch.ts` L117-123 实测为<br>`growStability(store, m, baseGrowth, useSpacing, now?)` —— **`now` 在最后** |
| 「返回 `{ intervalDays, boosted, stabilityDelta }`」 | ✅ 成立（L140-144） |
| `DESIGN-v2.md` §4.2 L723-725 | `function growStability(db, m, baseGrowth, useSpacing, now = Date.now()): { intervalDays; boosted; stabilityDelta }` |

⇒ **主线 `main`（HEAD `7c98987`）的实现已经与设计稿一致**（`now` 最后、返回三字段）。
`git grep growStability feat/p1-t05t06` 亦确认**分支上也是同一形状**。
⇒ **本条冲突无需任何改动。**

### 4.2 裁决

> **采纳设计稿的形状：`now` 在最后**（`growStability(store, m, baseGrowth, useSpacing, now?)`），
> 返回 `{ intervalDays, boosted, stabilityDelta }`。
> **当前实现已经符合 ⇒ 零改动。**
>
> ★ 唯一的字面差异是**第一个参数**：设计稿写 `db`，实现写 `store`（= 库句柄 + 生效参数）。
> 这是**必要且正确**的适配——§4.2 的三个约束（`MAX_STABILITY` 上限、`SPACING_CAP`）的界都在
> `DEFAULT_PARAMS` 里 ⇒ 函数必须拿得到生效参数。
> ⇒ **建议**在 §4.2 的签名旁补一行注释说明「第一个参数实际是「库句柄 + 生效参数」」，
> 避免后来者按 `db` 去写调用点（§4.2 原文把 `db` 当成含参数表的句柄）。

### 4.3 理由（为什么不选「把 `now` 提前」）

- **契约稳定性优先**：`growStability` 是 §4.2 明写的**全库唯一 stability 写入点**，
  阶段 2~5 的每一条路径（去重合并、`updateContent`、未来的召回强化）都要调它
  ⇒ 它的签名是**跨阶段的公开契约**，不是「当前这一批调用点怎么方便」。
- **`now` 在最后是 TS 的默认参数惯例**：可省略 ⇒ `growStability(store, m, bonus, true)` 就是「用真实时钟」；
  把 `now` 放第二个 ⇒ 省略它就必须写 `undefined` 占位（`growStability(store, m, undefined, bonus, true)`），
  反而更容易漏。
- **「需要注入时钟的调用一眼看得出」这个理由不成立**：注入时钟的惯例在 §11.1 与 `src/core/clock.ts`
  的 `resolveNow(now?)`——**时钟是可选尾参**，不是第二个必位参数。
  `touch(ids, now?)`、`link(…, now?, options?)`、`sweep(…, now?)` 全部是尾参 ⇒ 全库口径一致。
- **改签名的代价不对称**：改一次签名要动 §4.2、§4.9 步骤 2、§4.9 步骤 3c、
  `DEVELOPMENT-PLAN.md` 的 P1-T06/P1-T07、以及所有调用点；**不改**则零成本。

### 4.4 需要改动的清单

| 文件 | 位置 | 改动 | 谁执行 |
|------|------|------|--------|
| — | — | **无改动**（实现已符合） | — |
| `docs/design/DESIGN-v2.md` | §4.2 签名（L723-725） | *（可选）* 补一句「第一个参数实际是「库句柄 + 生效参数」」 | 主理人 |
| 开发线 `src/store/write.ts` / `merge.ts` | 调用点 | ⚠️ **若开发线按「`now` 在第二位」写了调用点，必须改回尾参**，否则与主线 API 不兼容 | 开发线 |

---

## 5. 冲突 5 · `src/store/transaction.ts` 是否越界（确认项）

### 5.1 冲突描述

线 B 抽出 `src/store/transaction.ts`（`runWriteTransaction(db, body)`），
理由是 §4.5（`link`）、§4.2（`touch`）、§4.9.2（`mergeEntities`）三处都要求「多步写入必须同事务」，
各自写一份 `try/catch + db.transaction` 会让 §11.2 的错误转译规则漂移出三份。

### 5.2 裁决

> **确认：符合设计意图，予以保留。它不但不违反 §14.3 的边界原则 1，反而是它的正面实现。**

### 5.3 理由

1. **§14.3 边界原则 1 是「每个承诺都要能指到**唯一**代码路径」**——
   抽出一个 `runWriteTransaction` 恰恰把「多步写入必须同事务」这一条承诺
   从**三份副本**收拢成**一条路径** ⇒ 这是原则 1 的**加强**，不是违反。
   （对照 §4.2 的 `growStability` 收拢、§9.3.0 的 `assignBucket` 收拢：**同一纪律的第三次应用**。）
2. **三处的需求确实同构**：回滚语义一致（回调抛错 ⇒ 整体回滚）、错误转译规则一致
   （已是 `MemoryError` 的原样抛出；SQLite 原生码按 §11.2 转译；清单外的码原样抛出）。
   `src/store/transaction.ts` L12-19 的注释**逐条抄了 §11.2**，可核对。
3. **它没有引入新的抽象层**：只有一个 9 行的函数、一个 `try/catch`、没有状态、没有策略参数
   ⇒ 不违反 §14.3 的「简单优先」。
4. **一个必须留意的实现细节（已满足）**：`db.transaction(body)()` 要求回调**同步**
   （better-sqlite3 的事务不支持 async 回调）⇒ `runWriteTransaction` 的注释已写明这一点，
   且 `src/store/transaction.ts` L32-34 明确标注。**后续 P1-T07 的 `write`/`merge` 必须遵守**
   （它们若是 async 路径，**不得**直接把 async 回调塞进 `runWriteTransaction`）。
5. **附带收益**：它让「回滚不留孤儿」这三条不变量的**落点唯一**
   （`link` 自环不留孤儿实体、`touch` 一条都不加固、`mergeEntities` 不留悬空边），
   而这三条**恰好是 §11.2/§9.2 的硬承诺**。

### 5.4 需要改动的清单

| 文件 | 位置 | 改动 | 谁执行 |
|------|------|------|--------|
| — | — | **无改动** | — |
| `docs/design/DESIGN-v2.md` | §14.3 附近 | *（可选）* 在「边界原则 1」处加一句实例，指名 `src/store/transaction.ts` 是该原则的一次落地 | 主理人 |

---

## 6. 冲突 6 · `mergeEntities` 的 `memoryId` 存在性预校验（★ 明确裁决）

### 6.1 冲突描述（含 schema 核实结果）

| 位置 | 内容 | 核实结论 |
|------|------|---------|
| `DESIGN-v2.md` §4.9.2 步骤 1（改前 L2180-2183） | `INSERT OR IGNORE INTO memory_entities(memory_id, entity_id) SELECT memory_id, @targetId FROM memory_entities WHERE entity_id = @sourceId;` ＋ `DELETE …` | — |
| 线 B 的判断 | 「当前 schema 的 `memory_entities` **没有外键**」 | ❌ **不成立**。`schema/001_schema_v2.sql` L121-125：<br>`memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,`<br>`entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,` ⇒ **两个外键都有** |
| 冲突描述里的担忧 | 「若 `memory_entities` 表上有指向 `memories` 的外键，则迁到 `targetId` 的行可能违反外键（若 `targetId` 对应的记忆已不存在）」 | ⚠️ **前提混淆**：`targetId` 是**实体 id**，不是记忆 id；`memory_id` 外键指向的是 `memories(id)` |

### 6.2 裁决

> **现在不加 `memoryId` 存在性预校验。**
> 理由：**迁移是逐字拷贝 `memory_id`** ⇒ **不引入任何新的记忆引用** ⇒ `memories(id)` 外键不可能被违反；
> 而 `entity_id` 外键由**步骤 0 的存在性校验**（`sourceId`/`targetId` 都在 `entities` 表里）保证 ⇒ 也不会被违反。
>
> ⇒ **真正要防的不是 FK，而是 `PRAGMA foreign_keys` 漏开**（§9.1 的**每连接**开关，R-08）——
> 但本步骤**不依赖 CASCADE**（它自己把源实体的行显式搬走、再显式删掉）
> ⇒ 漏开 FK 也不会留下「指向已删实体的孤儿关联行」。
>
> ⇒ **将来若 `memory_entities` 的外键语义变化**（例如改成 `ON DELETE RESTRICT` 或加新约束），
> **届时**再补预校验，并同步 §4.9.2 与 §11.2 的自校验清单。

### 6.3 理由（逐条驳「要加预校验」）

1. **预校验挡不住任何真实故障。** 被搬的行本来就满足外键（它们是既有行）⇒ 校验必然全过
   ⇒ 是「为一个不可能发生的错误加一次全表扫描」。
2. **预校验的成本不是零。** `SELECT 1 FROM memories WHERE id IN (…)` 对**源实体的全部关联记忆**逐条查
   ⇒ 源实体关联 10 万条记忆时，合并要多扫 10 万行。
3. **FK 违规的真实现象不是「targetId 的记忆不存在」，而是「`memory_id` 指向的硬删记忆残留行」**
   （`PRAGMA foreign_keys` 漏开时 `forget({hard:true})` 留下的孤儿行）。
   而这种孤儿行**本来就存在**（不是合并造成的）⇒ 预校验会把它变成**合并的失败原因**，
   而它与合并无关 ⇒ 反而制造了一条「无关的错误阻断合法操作」的路径。
4. **与 §14.3 边界原则 1 对齐**：承诺（「迁记忆关联」）指到**唯一代码路径**（§4.9.2 步骤 1 的两句 SQL），
   不额外挂一个「预校验」承诺。

### 6.4 需要改动的清单

| 文件 | 位置 | 改动 | 谁执行 |
|------|------|------|--------|
| `docs/design/DESIGN-v2.md` | §4.9.2 步骤 1（**现 L2235-2248**） | 写明「**有**外键」这一事实 + 为什么迁移不可能违反它 + 为什么不加预校验 | **我已落地** |
| `src/store/entities.ts` | L169-180 | **不改**（实现本来就正确） | — |
| `docs/design/DESIGN-v2.md` §3 | `memory_entities` 的表定义 | *（可选）* 若 §3 未写明这两个外键，补上（我**未核实** §3 的表述，见 §7） | 主理人 |

---

## 7. 冲突 7 · 阶段 1 的分桶状态与 `vector_cell_members` 的引用（★）

### 7.1 冲突描述

- §4.9 步骤 3c ② 要求「改了 embedding 就必须同步更新桶归属（§9.3.0）：同事务内调用 `assignBucket(id, @newVec)`」；
  §4.9 步骤 2 要求「★ 同事务内更新 `vector_cell_members` —— 调 `assignBucket(...)`」；
  §4.9 步骤 4 要求「★ **同事务内更新 `vector_cell_members` —— 调 `assignBucket(newId, @newVec)`**」；
  §9.3.2 ① 明写「这一步**不能省**：省了它，那条记忆将永远不进任何桶 ⇒ 向量路永远召不回它，
  且**没有任何报错**。这是本机制唯一的静默失效点」。
- **但 `assignBucket` / `unassignBucket` 属于阶段 2**（`DEVELOPMENT-PLAN.md` P2-T03，
  文件 `src/vector/bucketAssign.ts`；§9.3.0 的架构裁决；开发线在阶段 1 写 `write.ts`/`merge.ts`）。
- ⇒ 阶段 1 的 `write` 若照抄 §4.9，就要去调一个**还不存在**的函数。

### 7.2 裁决

> **采纳选项 (b) 的强化版：**
>
> 1. **阶段 1 的 `write()` 照写 `memories.embedding`**（步骤 2 的老库回填、步骤 3c ② 的合并写回、
>    步骤 4 的新建，**全部保留**），**但不写 `vector_cell_members`**。
> 2. **阶段 1 不得实现「空壳 `assignBucket`」**（没有细桶可分配的空函数 = **死函数 = 假绿**）。
> 3. **必须在 `write.ts` / `merge.ts` 的代码注释里写明**「阶段 1 不入桶」+「阶段 2 必须补桶」。
> 4. **阶段 2（P2-T03 + 桶训练）必须新增一条硬断言**：
>    「库内所有 `embedding IS NOT NULL` 且 `deleted = 0` 的记忆，其 id 集合
>    与 `vector_cell_members` 的 `memory_id` 集合**相等**」
>    （**集合相等，不是条数相等**——§9.3.2 ③ 的三条判据）⇒ 把阶段 1 的欠账变成阶段 2 的**可检断言**。
> 5. **阶段 2 必须在「启动对账 / 首次重训」完成之前，不得对外提供 IVF 向量路**
>    ⇒ 否则那才是设计稿点名的「静默、永久、不报错」窗口。
> 6. **阶段 1 另有两处同源豁免**（一并写明，避免被当成漏实现）：
>    · §4.9 步骤 3a2 的**向量路候选**（两级路由 + 桶内检索）需要桶中心 ⇒ 阶段 1 **跳过**，
>      近似去重退回纯文本路（步骤 3a）——代价是**少一条去重证据**，不是「去重失效」；
>    · §4.9 步骤 3c ② 的 `unassignBucket` 在阶段 1 **不存在** ⇒ 阶段 1 根本没有桶行可删 ⇒ 无矛盾。

### 7.3 理由（逐条驳另外两个选项）

**为什么不选 (a)「阶段 1 暂不补写向量（`embedding` 恒 NULL）」：**

1. **它会让事件流撒谎。** §4.9 步骤 4 的 write 事件 payload 里 `hasEmbedding` **恒带**，
   记的是「本次是否带向量」。若库里没写向量而事件记 `hasEmbedding: true`
   ⇒ **重放器会重建出一条库里没有的向量** ⇒ §9.2 的「可完整重放」当场破。
2. **它会让「老库回填的唯一机会」（§4.9 步骤 2）这个承诺落空**
   ⇒ §14.3 边界原则 1：承诺指不到代码路径。
3. **它会让 P1-T07 的既有断言失真**：「写一条新事实 ⇒ payload 含 `hasEmbedding`（恒带）」这条
   本来是好事（事后能判断「这条为什么没进向量路」），若 `hasEmbedding` 恒为 `false`，
   它就退化成一个**恒定值** ⇒ 失去全部信息量。

**为什么不选 (c)「现在就实现 `assignBucket`」：**

1. **没有细桶可分配。** `assignBucket` 的内部动作是「算最近细桶 → DELETE 旧归属 → INSERT 新归属」，
   而「最近细桶」需要 `vector_fine_cells` 里的中心向量 —— 那些中心由**两级 k-means 训练**产生
   （§4.15.3，阶段 2 的桶训练任务）。阶段 1 库里**一条细桶都没有**
   ⇒ `assignBucket` 只能是一个**永远什么都不做的空函数** = **死函数 = 假绿**
   （比「不写」更危险：它让「四条路径都调了 `assignBucket`」这条静态断言**假通过**）。
2. **要造出真正的 `assignBucket`，就必须先做两级 k-means 训练** ⇒ 那是**阶段 2 的核心工作**，
   提前做等于把阶段 2 的 P2-T03 / 桶训练任务整个塞进 P1-T07 ⇒ 违反任务边界。

**为什么 (b) 在阶段 1 是安全的（驳「补了向量不入桶 ⇒ 永久召不回」）：**

1. **阶段 1 物理上写不了桶行。** `vector_cell_members.fine_id` 有 FK 指向 `vector_fine_cells`
   （`schema/001_schema_v2.sql` L330），而阶段 1 库里**一条细桶都没有**
   ⇒ 任何桶行都会被外键**直接拒绝**（FK 在每连接都开，`src/db/connection.ts` L70/L88）。
   ⇒ 「写桶」不是一个选择，是一个**做不到**的动作。
2. **阶段 1 没有向量路 ⇒ 没有受害者。** 三路召回的流水线（§4.6）与 flat/IVF 后端（§4.15.2）
   都是**阶段 2**（P1-T08 只交付了 `src/core/scoring.ts` 的融合打分，主线至今无 `src/store/recall.ts`）
   ⇒ 阶段 1 **根本不存在「向量路召不回」这回事**。
3. **★ 阶段 2 有两条自动修复路径**（都已在设计稿里，不是新发明）：
   - §9.3.2 ③ 的**启动对账**：「库侧有、桶侧无 ⇒ 补（归入最近的细桶）」；
   - §4.15.5 重建步骤 ② 的**全量重分配**：「按新中心重新分配**每条**记忆的桶归属」
     ⇒ 首次重训会把阶段 1 写入的无桶记忆**全部**重新分配。
   ⇒ 所以欠账是**有期限的、可自动清偿的**，不是「永久、不可发现」。
4. **风险窗口可控**：唯一的风险窗口是「阶段 2 的 IVF 后端已上线、但对账/重训还没跑完」。
   ⇒ 裁决第 5 条（先对账、后开路）就是关掉这个窗口的**具体动作**。

### 7.4 ⚠️ 对阶段 1 验收断言的影响（DEVELOPMENT-PLAN.md P1-T07）

| P1-T07 硬断言 | 是否受影响 | 说明 |
|---------------|-----------|------|
| 「合并时未传向量 ⇒ 该条 `embedding` 变 NULL（**不是保留旧向量**）」 | **❌ 不受影响** | 该断言针对 **`memories.embedding` 这一列**，与桶归属无关。阶段 1 的合并路径照常把 `embedding` 置 NULL。 |
| 「`write` 传维度错的 embedding / NaN / 全零 ⇒ 抛 `INVALID_INPUT`，`details.reason` 分别为 `'dim'`/`'nan'`/`'zero'`；**库内无该条记录**」 | **❌ 不受影响** | 那是**入参校验**，发生在写库之前，与桶无关。 |
| 「写一条新事实 ⇒ `events(type='write')`，payload 含 `hasEmbedding`（恒带）」 | **❌ 不受影响** | `hasEmbedding` 描述的是 `memories.embedding` 是否为 NULL，阶段 1 照常写真值（这也正是**不选 (a)** 的理由）。 |
| 「合并时未传向量 ⇒ 该条的桶归属被删除（`unassignBucket` 被调用），桶计数相应 -1」 | ⚠️ **这是 P2-T03 的断言**，不是 P1-T07 的 | 阶段 1 库里没有桶行 ⇒ 阶段 1 无 `unassignBucket` 可调 ⇒ 该断言**在阶段 2 才有意义**。P1-T07 **没有**这条断言。 |
| 「静态断言：`UPDATE memories SET content` / `SET embedding` / `SET content_hash` 只出现在 `merge.ts` 的合并序列内」 | ❌ 不受影响 | 与桶无关。 |

⇒ **结论：裁决 7 不会让 P1-T07 的任何一条硬断言无法通过。**
⚠️ **唯一需要开发者注意的是**：P1-T07 的实现**不得**在阶段 1 里**自己写**
`INSERT INTO vector_cell_members`（P2-T04 的 lint 规则本来就要禁它），
也**不得**为此造一个空的 `assignBucket`。

### 7.5 需要改动的清单

| 文件 | 位置 | 改动 | 谁执行 |
|------|------|------|--------|
| `docs/design/DESIGN-v2.md` | §4.9 开头（**现 L1766-1797**） | 新增「阶段 1（P1）的桶归属阶段性豁免」说明块 | **我已落地** |
| `docs/design/DESIGN-v2.md` | §4.9 步骤 2 / 3c ② / 步骤 4（**现 L1897-1898 / L2030-2031 / L2081-2082**） | 三处各加一行「阶段 1 暂缓」指引（**保留** `assignBucket`/`unassignBucket`/`vector_cell_members` 关键词，§14.3.1 的跨节锚定检查要它们） | **我已落地** |
| `src/store/write.ts` / `src/store/merge.ts` | 相关分支的注释 | 写明「阶段 1 不入桶 + 阶段 2 必须补桶（启动对账 / 首次重训）」 | 开发线 |
| `DEVELOPMENT-PLAN.md` | P1-T07「关键实现要点」 | 补一条「阶段 1 不调 `assignBucket` / `unassignBucket`（阶段 2 才挂）」＋「⚠️ 不得实现空壳 `assignBucket`」 | 主理人 |
| `DEVELOPMENT-PLAN.md` | **P2-T03 验收标准** | **新增硬断言**：「库内所有 `embedding IS NOT NULL` 且 `deleted = 0` 的记忆，与 `vector_cell_members` 的 `memory_id` **集合相等**」 | 主理人 |
| `DEVELOPMENT-PLAN.md` | P2-T03 验收标准 | 新增「**在启动对账 / 首次重训完成前不得对外提供 IVF 向量路**」 | 主理人 |
| `docs/design/DESIGN-v2.md` §4.15.5 | — | *（可选）* 明确「首次重训的全量重分配**自动清偿**阶段 1 的无桶记忆」 | 主理人 |

---

## 8. 额外发现（**不在 7 条之内，但必须报告**）

| # | 发现 | 位置 | 建议 |
|---|------|------|------|
| **F-1** | ⚠️ **`link` / `linkByIds` 没有校验 `memoryId` 是否存在** ⇒ 撞 FK ⇒ 转成 `NOT_FOUND` 但 **`details` 里没有 `missingIds`** ⇒ 违反 §11.2 的自校验清单 | `src/store/link.ts`（全函数） | 软件工程师-2 补（见 §2.5） |
| **F-2** | ⚠️ **§4.9 步骤 4 的 write 事件 payload 里有 `entityNames: [...]`，但 §8.4 的 write 行与 `EVENT_PAYLOAD_KEYS.write` 都**没有**这个键** ⇒ 设计稿两处不一致（且 `DEVELOPMENT-PLAN.md` P1-T07 也抄了 `entityNames`） | `DESIGN-v2.md` **现 L2085**（§4.9 步骤 4）vs §8.4 的 write 行 | 二选一：① §4.9 删掉 `entityNames`；② §8.4 补上 `entityNames` **并**给 `EVENT_PAYLOAD_KEYS.write` 加键（**会动 `check-payload-keys.ts` 的分母**）。**建议 ①**（少一个键、少一份冗余） |
| **F-3** | ⚠️ **`MergeEntitiesResult.aliasAdded: string`（返回值）与 payload 的 `aliasAdded: boolean` 同名不同义** | `src/store/entities.ts` L46 vs `src/core/events.types.ts` | 见 §1.4 |
| **F-4** | ⚠️ **§4.9 步骤 2 的并发兜底需要「带 `details.conflictingId` 的 `CONFLICT`」，而 `runWriteTransaction` 的通用转译器给不出 `conflictingId`**（它只知道「有唯一约束冲突」，不知道冲突的是谁） | `src/store/transaction.ts` L41-48 vs `DESIGN-v2.md` §4.9 步骤 2 | **`write.ts` 必须自己 catch `SQLITE_CONSTRAINT_UNIQUE` 并带上 `conflictingId`**，不能指望事务包装器 |
| **F-5** | ⚠️ **`runWriteTransaction` 的回调必须同步**（better-sqlite3 的事务不支持 async 回调） | `src/store/transaction.ts` L32-34 | 开发线的 `write.ts`/`merge.ts` 若是 async 路径，**不得**把 async 回调直接塞进去 |
| **F-6** | ⚠️ **环境层：`pnpm run verify` 在本机存在偶发失败**（`node_modules/.bin` 的 shim 被并发运行的 `pnpm install` 重写 ⇒ `tsc`/`tsx` 的解析被抢走 ⇒ `系统找不到指定的路径`）。**与本次改动无关**（基线跑过一次即绿；同一命令重试即绿） | 环境 | 多人同时在同一工作树跑 `pnpm` 时会互相踩；建议**串行**跑门禁 |

---

## 9. 我直接落地的改动 + 门禁实测

### 9.1 改动文件（**仅两个，均在授权范围内**）

| 文件 | 改动 | 对应裁决 |
|------|------|---------|
| `docs/design/DESIGN-v2.md` | §4.9 开头新增「阶段 1 桶归属豁免」块；§4.9 步骤 2/3c ②/步骤 4 各加「阶段 1 暂缓」指引；§4.5 步骤 2 新增「`details` 键名分族」说明；§4.9.2 步骤 1 新增「不需预校验 `memory_id`」说明；§4.9.2 步骤 2 新增「`mergedEdges` 口径 + 对账恒等式」；§4.9.2 步骤 5 改 `aliasAdded` 口径；§8.4 表后新增「`alias` 行的字段类型约定」 | 1 / 2 / 3 / 6 / 7 |
| `src/core/events.types.ts` | `AliasEventPayload` **类型不变**（`aliasAdded?: boolean`），补齐逐字段 JSDoc 与口径说明 | 1 / 3 |

⚠️ **未改动**：`src/store/write.ts`、`src/store/merge.ts`（开发线文件域）、
`src/store/link.ts`、`src/store/entities.ts`、`src/store/transaction.ts`、`src/core/errors.ts`、
`src/core/params.ts`、任何脚本、`DEVELOPMENT-PLAN.md`。

### 9.2 门禁实测（**`pnpm run verify`，不是 `pnpm ci` / `npm ci`**）

```
$ pnpm run verify
EXIT = 0

  Test Files  21 passed (21)
       Tests  427 passed (427)

  ✓ §5 表与 DEFAULT_PARAMS 逐键逐值相等（60 项 / 60 键）
  ✓ §8.4 的 payload 键集与代码逐键一致（13 种 type）
  ✓ C37 时钟注入契约通过（1 文件 / 1 命中点）
  ✓ 跨节锚定清单：5 行 × 3 列，且与写死的期望一致
  ✓ §8.4 硬规则条数：6 条（与写死的期望一致）
  ✓ 契约编号与引用数字全部一致
  ✓ §5 分类声明与 §8.1 的参数计数与代码一致（60 项）
```

⚠️ **§8.4 类型注记为什么必须放在表外**（一个必须记住的实现约束）：
`scripts/check-payload-keys.ts` 的 `extractPayloadKeys` 只从 §8.4 表格的**第 4 列**解析键集，
且对 `IDENT(...)` 形态**要求括号内含引号**、对 `IDENT: 值` 形态**要求值以 `Array<` 开头**，
否则**该键会被判成「不是键」而丢弃** ⇒
若把 `aliasAdded?(boolean)` 或 `aliasAdded?: boolean` 写进那一列，
`aliasAdded` 会从 §8.4 的键集里消失 ⇒ 门禁报「代码有而 §8.4 没有 `[aliasAdded]`」⇒ **变红**。
⇒ 类型注记只能写在**表外**（本报告已如此处理，门禁实测绿）。

⚠️ **行尾自检**：`docs/design/DESIGN-v2.md` 与 `src/core/events.types.ts` 的 **CR 字节数 = 0**（LF），
与仓库 `.gitattributes`（`* text=auto eol=lf`）一致。

---

## 10. 我**没有把握**、需要进一步确认的部分（不粉饰）

1. ⚠️ **`missingEntityNames` 这个键名是我提的新词**，仓库里没有先例。
   我按「与既有词汇 `entityNames` 对齐 + 与 `missingIds` 形成 id/名字的对立」选了它，
   但**主理人/调用方可能有别的偏好**（例如 `missingNames`）。
   ⇒ **若改名，§4.5 步骤 2 的正文与 `src/core/errors.ts` 的常量名要同步改**（我已把正文写成以 `missingEntityNames` 为准）。
2. ⚠️ **裁决 7 依赖「阶段 2 一定会跑启动对账 / 首次重训」这个前提**。
   §9.3.2 ③ 与 §4.15.5 都写了这条，但**它们是阶段 2 的任务**⇒
   **若阶段 2 的 P2-T03 落地时把「启动对账」做成了「可选的诊断命令」而不是「启动必跑」，
   阶段 1 的欠账就会真的变成永久漏召**。⇒ 我已在 §7.5 把「集合相等」写成阶段 2 的**硬断言**来兜底，
   但这条**必须在 P2-T03 立项时被真正写进验收标准**。
3. ⚠️ **§4.9 步骤 4 的 `entityNames`（F-2）我**没有裁决**，只报告。
   因为两条修法的影响面差别很大（改 §8.4 会动 `check-payload-keys.ts` 的分母），
   这属于**跨阶段的门禁变更**，不该由我在授权范围外单方面决定。
4. ⚠️ **裁决 4 的前提有误**（实现本来就是 `now` 在最后）。
   我核实的是**主线 `main`（HEAD `7c98987`）与分支 `feat/p1-t05t06`**；
   **开发线 `D:/Git/wt/p1-t07t09` 里尚未提交的 `write.ts`/`merge.ts` 我没有读**
   （按指示不碰那个 worktree）⇒
   **若开发线按「`now` 在第二位」写了 `growStability` 的调用点，合并时会编译不过** ⇒ 请开发线自查。
5. ⚠️ **§3 的 `memory_entities` 表定义我没有逐字核对**（我只读了 `schema/001_schema_v2.sql` 与
   `src/db/schema.sql.ts` 的存在性）⇒ 裁决 6 的「确有外键」结论**以 schema SQL 文件为准**；
   若 §3 正文与 schema 文件不一致，**以 schema 文件为准**（建库脚本才是运行时真相）。
6. ⚠️ **我没有跑「阶段 1 无桶」场景的端到端实验**（阶段 1 还没有 `write`，也没有向量路），
   裁决 7 的第 2 条（阶段 1 没有受害者）是从**阶段划分**推出来的，不是实测出来的。
   ⇒ 阶段 2 落地时必须补上那条「集合相等」硬断言来**实测**它。

---

## 11. 实施状态（2026-10-31 10:45 更新）

> ⚠️ **本报告写完后的 3 分钟内，软件工程师-2 已在同一个工作树上按本报告动手改代码了**
> （`src/core/errors.ts` / `src/store/link.ts` / `src/store/entities.ts` / `tests/unit/link.test.ts`，
> 注释里已逐条引用「ADR-P1-C 冲突 1 / 2 / 3」）。
> ⇒ **裁决 1 / 2 / 3 已被实现方采纳并落码**（`MISSING_ENTITY_NAMES_KEY = 'missingEntityNames'`、
> `NOT_FOUND_METHODS_WITH_MISSING_IDS` 追加 `'link'`、`mergedEdges` 的注释口径、`aliasAdded` 的布尔口径）。
> ⇒ **我未提交任何 commit**：工作树上同时有别人的在途改动（且 `biome check` 暂红，
> 原因是**他们的在途文件未格式化**，不是我的改动）⇒ 提交时机与提交内容由主理人统一决定。
> ⇒ **我改动的三个路径**（提交时只 add 这三个）：
> `docs/design/DESIGN-v2.md`、`src/core/events.types.ts`、`docs/design/adr-p1-conflicts.md`（新增）。
> ⚠️ 注意：`docs/design/DESIGN-v2.md` 里**含一处不是我做的改动**（§4.9 步骤 4 删除 `entityNames`，
> 即本报告的 F-2 建议①）⇒ 提交时该文件会同时包含这一处。

| 裁决 | 状态 | 说明 |
|------|------|------|
| 1 `aliasAdded` | **设计稿已勘误**（我）＋ **类型注释已补**（我）＋ **实现方已改注释与口径**（工程师-2） | 事件 payload 的键集**未变** ⇒ `check-payload-keys.ts` 不受影响 |
| 2 `link` 的 `details` | **设计稿 §4.5 已勘误**（我）＋ **`errors.ts` 已加 `MISSING_ENTITY_NAMES_KEY` 并把 `'link'` 加进名单**（工程师-2） | ⚠️ `link`/`linkByIds` 的 `memoryId` 自校验**由工程师-2 在补**（我已单独通知） |
| 3 `mergedEdges` | **设计稿已勘误**（我）＋ **实现方注释已对齐**（工程师-2） | 实现逻辑本来正确，未改 |
| 4 `growStability` | **零改动**（实现本来就符合设计稿） | 开发线的调用点需自查（见 §4.4） |
| 5 `transaction.ts` | **零改动**（确认保留） | — |
| 6 `memoryId` 预校验 | **设计稿已勘误**（我） | 结论：不加预校验 |
| 7 阶段 1 桶归属 | **设计稿已勘免**（我） | **阶段 2（P2-T03）必须补一条「集合相等」硬断言**——这是**尚未落实**的一项，见 §7.5 |

---

## 12. 给后续阶段的**一句话交接**

> 阶段 1 写 `write`/`merge` 时：**写 `memories.embedding`，不写 `vector_cell_members`，
> 不造空壳 `assignBucket`，在注释里写明「阶段 2 必须补桶」**；
> 阶段 2 落地时：**先跑启动对账/首次重训，再开 IVF 向量路，并断言「有向量的记忆 ⊆ 桶成员（集合相等）」**。
> 事件 payload 的 `aliasAdded` 是**布尔**，名字在 `alias` 键；
> `mergedEdges` 只数**冲突合并**；`link` 的端点差集用 `missingEntityNames`、记忆 id 差集用 `missingIds`。
