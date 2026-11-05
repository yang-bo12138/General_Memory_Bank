# C′ 档设计：两段式 + **可证上界剪枝**（零漏检）

> **归属**：`docs/decisions/adr-perf-recall-vs-h1.md` **§8 裁决**（2026-11-04）的施工落点。
> **一句话**：把「桶内全量精确点积」换成「**先读 768B 的 int8 码算上界，只对可能入选的行读 3KB 原向量精确重排**」，
> 用 Cauchy–Schwarz 给每一行一个**可证上界** ⇒ **结果与全量扫描逐位相同**，而字节量降到 1/4。
> **状态**：**T01 / T02 / T03 已落地（2026-11-04）**；**T04 已落地（2026-11-05，提交 `f9c966f` —— 差异台账见 §5.1.11，裁决见 §5.1.12「已裁」）**；**T05 已落地（2026-11-04 · 提交 `4637d38`）**；**T06 已落地（2026-11-05，提交 `b339534` + `58bde37`）**；**R8 已裁 · 部分落地（§7.1）**；**R11 已裁（§6）**。
> **验收断言 A1~A8 一条都没跑过之前，本档的收益数字全部是 ⚠️推断。**
> ⚠️ **T01 的落地形状与原计划不同**（更省一步），差异与理由见 §5 的 T01 行注。
> ⚠️ **R8 的事实底座与原稿不同**（今天有 2 条合法写 `embedding` 的路径，不是 0 条），订正见 §7.1.1。

---

## §1 为什么是「可证上界」而不是「近似分」

裁决 ② = **不接受漏检率上升（一点不降）** ⇒ 「近似分淘汰」这条路**在语义上就被禁了**：
近似分的误差**方向不确定** ⇒ 必然存在「真实分高于阈值、近似分低于阈值」的行 ⇒ 那就是漏检。

唯一的出路是：**让被跳过的行「可以被证明不会入选」**。

```
cos_true = q·x = q·x̂ + q·(x − x̂) ≤ q·x̂ + ‖q‖·‖x − x̂‖ = q·x̂ + ε     （‖q‖ = 1）
```

⇒ `upper := q·x̂ + ε` 是**裸余弦 `q·x` 的上界**，且**可以由码算出**。

### ★ 但上界要对着**结果键**证，不是对着裸余弦（2026-11-05 订正，证明原来有个洞）

**两条路存进结果里的分数都不是裸余弦**：

| 路 | 结果键 | 出处 |
|---|---|---|
| 读路径 | `clampCos(dot(q, x))` = `min(1, max(0, cos))` | `src/vector/ivf.ts:1247`（`makeScoreOf`） |
| 写路径 | `clampCos(cosine)`（**同一口径**，`cosineOf()` 内部就钳了） | `src/store/dedupCandidates.ts:216-218` |

⇒ 记结果键 `score := max(0, cos)`，则 **`score ≥ cos`**，于是 `upper` **不再是 `score` 的上界**：

```
cos < 0  时：  score = 0  >  upper = cos + ε        （ε 通常 ≪ |cos|）
```

**失效的确切形状**（不是罕见情形）：第 K 名的分**恰好是 0**（被钳出来的），而队列里剩下的行 `upper < 0`
⇒ 它们的**精确分也是 0**（同样被钳）⇒ 与第 K 名**同分** ⇒ 按 `compareHits` 的「**同分 → id 升序**」，
其中 **id 更小的那些本该入选** ⇒ 用裸 `upper < 第 K 名` 判早停就会把它们**静默跳掉**
（条数一样、分数一样，**只有 id 不同**）。而「被钳到 0 的负余弦大量同分」正是 `compareHits` 注释里的原话。

**改正后的判据**（`PruneOptions.scoreFloor`，两条路都传 `0`）：

```
跳过剩余行  ⟺  max(upper, scoreFloor) < 当前第 K 名的结果键        （scoreFloor = 结果键的下界 = 0）
```

**为什么这样就对**（一行不等式，是原证明的加强版）：

```
cos ≤ upper                        （Cauchy–Schwarz，原证明）
⇒ max(0, cos) ≤ max(0, upper)      （max(0, ·) 单调不减）
⇒ score ≤ max(upper, 0)  = max(upper, scoreFloor)
```

- 写路径（阈值语义）：只跳过 `max(upper, 0) < DEDUP_COS_MIN` 的行（阈值 ≥ 0 ⇒ 与 `upper < θ` 等价）。
- 读路径（top-K 语义）：按 `upper` 降序精确重排，**剩余 `max(upper, 0)` 最大值 `<` 当前第 K 名的结果键** 时停止。

⇒ 两条都**不丢任何一行本可入选的候选** ⇒ 与全量精确扫描**逐位相同**（证明见 ADR §8.3）。

⚠️ **代价（诚实记）**：当第 K 名**正好是 0 分**时，`max(upper,0) < 0` 恒假 ⇒ **早停永远不会触发**
⇒ 该次查询退化成「扫完整个桶」。这不是缺陷，是**正确性**的价钱：
同分只能靠 id 定序，而 `upper` 推不出 id 的大小。**弱查询（正余弦不足 K 条）必然全额付费。**

★ **附带收益**：这**不破 ADR-33**。ADR-33 的实质是「桶内的**结果**精确」，
而不是「必须物理扫完桶内每一行」。剪枝是索引式优化，结果集不变 ⇒
ADR-33 只需加一条勘误（§8 本节），**不需要被推翻**。

---

## §2 数据模型

新增一张**只存码**的表（**不**动 `vector_cell_members` 的语义，也不动 `memories.embedding` 的「唯一真相」地位）：

```sql
-- schema/002_vector_codes.sql
CREATE TABLE vector_codes (
  fine_id   TEXT NOT NULL REFERENCES vector_fine_cells(fine_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  code      BLOB NOT NULL,   -- 768 个 int8（小端有符号），长度必须 == EMBED_DIM
  scale     REAL NOT NULL,   -- x̂ = scale × code；per-vector 单一标量 = max|x| / 127
  eps       REAL NOT NULL,   -- ★ 编码时**实算**的 ‖x − x̂‖₂（不是估算上界）
  PRIMARY KEY (fine_id, memory_id)
) WITHOUT ROWID;             -- ★ 关键：按 (fine_id, memory_id) 聚簇 ⇒ 读一个桶 = 连续几页
```

**为什么是「每码 1 行」而不是「每桶打包 1 行」（ADR 原文形态 (c) 的缺陷）**：

| 形态 | 读 | 写 |
|---|---|---|
| 每桶打包 1 行（ADR (c)） | 顺 | ❌ **每次 insert 重写整块 ≈ `109 × 768B ≈ 84KB`** ⇒ 写放大爆炸 |
| **每码 1 行 + 按 `fine_id` 聚簇（本设计）** | ✅ 顺（聚簇） | ✅ 只追加 `768 + 16 ≈ 784B` |

⇒ 写入路径本来就是被考核方（H1）⇒ **不能把放大从读搬到写**。

**尺寸**：`1,000,000 × (768 + 16) ≈ 784 MB`（`code` 768B + `scale/eps` 8B + 行头 8B）。
⚠️ 页大小是 8192（`schema/001_schema_v2.sql:16`）⇒ **每页约 10 行** ⇒ 读 5,521 行 ≈ **552 页 ≈ 4.2 MB 顺序读**。

**无码行 = 精确兜底**：`code IS NULL` 或该行在 `vector_codes` 里不存在 ⇒ **该行走现状的精确路径**（读 `memories.embedding`）。
⇒ 回填可以分批、可以中断；**任何时刻都不会因为「码没填完」而丢候选**。

---

## §3 编码器（`src/vector/quantize.ts`，新文件）

```ts
export interface EncodedVector { code: Uint8Array; scale: number; eps: number }

/** int8 量化 + 实算误差。x 必须是**已 L2 归一化**的 768 维向量。 */
export function encodeVector(vector: Float32Array): EncodedVector;
/** q·x̂ = scale × Σ q_j · int8_j（q 为已归一化的查询向量） */
export function approxDot(query: Float32Array, code: Uint8Array, scale: number): number;
```

- `scale = max(|x_j|) / 127`（per-vector 单一标量 ⇒ 解码零成本：一个乘法）
- `code_j = round(x_j / scale)`，**clamp 到 [-127, 127]**（防浮点越界）
- `x̂_j = scale × code_j`；`eps = sqrt(Σ (x_j − x̂_j)²)` —— **逐行实算**
- ⚠️ `eps` 落库时**加 `1e-6` 安全余量**（吸收「实算 eps 的和式顺序」与「线上算 `q·x̂` 的和式顺序」之间的浮点差）
  —— 少了这 1e-6，A3 会在极端样本上偶发破界，而那**正是最难查的一类红**

**为什么不估算 `eps ≤ scale·√d/2`**：那是**最坏界**（假设 768 个维度的舍入误差全部同向），
比真实误差大 2~3 倍 ⇒ 剪枝率会显著变差。代价是编码期多算一次 `O(d)` 的平方和 —— 一次性。

---

## §4 两条路的算法

**共用原语**（`src/vector/prune.ts`）：给定「码行列表 + 查询 + k + 阈值（可选）」，产出精确 top-K。

```
候选 = 逐桶读 (memory_id, code, scale, eps)          ← 只有这一步是新 IO，784B/行
for row in 候选:
    approx = approxDot(q, row.code, row.scale)
    upper  = approx + row.eps                        ← 可证上界
    if 阈值 != null and upper < 阈值: continue        ← ★ 唯一允许跳过的条件（写路径）
    堆候选.push({id: row.id, upper})
堆候选 按 upper 降序（同 upper 按 id 升序 ⇒ 完全定序）
exact = 小顶堆（容量 k，序 = 结果键降序、同分 id 升序）
for item in 堆候选:
    if exact.size == k and max(item.upper, scoreFloor) < exact.第k名.score: break
                                                  ↑ ★ 严格小于（同分必须继续）
                                                  ↑ ★ scoreFloor = 结果键的下界 = 0（见 §1 的订正）
    x = 读 memories.embedding(item.id)               ← 3,072B/行，只对 survivors
    exact.push({id: item.id, score: clampCos(dot(q, x))})   ← 结果键是**钳制后**的余弦
return exact 转数组（结果键降序、同分 id 升序）
```

⚠️ **上面那行 `max(item.upper, scoreFloor)` 不是可选的**：不写它，早停就会在「第 K 名恰好 0 分」时
跳过「同分（0 分）但 id 更小」的行 —— **静默丢行**，且条数与分数都看不出来（只有 id 不同）。
推导见 §1，实现见 `prune.ts` 的 `PruneOptions.scoreFloor`。

- **读路径**（`IvfVectorBackend.search()`）：`k = VECTOR_TOPK * VECTOR_OVERFETCH_FACTOR`，阈值 = `null`。
- **写路径**（`scanBucketCandidates()`）：`k = VECTOR_TOPK`，阈值 = `DEDUP_COS_MIN`
  ⇒ 早停条件同样成立（它要的就是 top-K，不是「全部过阈的」）。
  ⚠️ **但 `scanned` 的语义要保住**：它现在是「命中桶内的候选行数」（候选宇宙大小），
  **这个数必须继续等于 `候选` 的长度**（由码行数得出），**不能**变成 survivors 的个数
  —— 否则 R6 与 H1 的历史读数**不可比**，且「候选宇宙有没有变小」这件事变得看不出来。

**精确兜底**：`向量层` 里任何「码行缺失 / `code` 长度 ≠ `EMBED_DIM` / `scale` 或 `eps` 非有限数」的行，
一律**并入 survivors**（当作 `upper = +∞`）⇒ 它会走精确读 ⇒ 迟一步、但**不错**。
⚠️ 这条兜底是 A8 断言的落点，也是「回填未完成时能不能上线」的唯一依据。

⇒ ★ **施工定稿见 §5.1**：候选宇宙怎么拼、三条 SQL 各自碰哪张表、行级谓词放哪一步、
早停的确切形状、`scanned` 从哪来 —— 本节只给算法意图，**§5.1 才是可执行形状**（冲突以 §5.1 为准）。

---

## §5 任务列表（**7 个任务 / 5~6 轮**，依赖已标）

| # | 任务 | 改哪里 | 依赖 | 完成判据 |
|---|---|---|---|---|
| **T01** | 码表 DDL（**增量表**） | ✅ **已落地**：`schema/001_schema_v2.sql` + `schema/002_migration_v1_to_v2.sql` 各一段（带 `IF NOT EXISTS`）；运行时副本 `src/db/schema.sql.ts` 同步生成；`src/core/schema.ts` 加 `VECTOR_CODES_SQL`；`src/db/migrate.ts` 加 `ensureVectorCodesTable()` 并挂进 `ensureSchema()` 的三个分支 | — | `tests/unit/vector-codes-schema.test.ts` **6 条**：不在指纹表 / 形状对 / 两处 DDL 不漂移 / 存量库可补建 / 幂等 / 只读侧容忍缺表 |
| **T02** | 编码器 + 上界单测 | ✅ **已落地**：`src/vector/quantize.ts`（`encodeVector` / `approxDot` / `upperBound` / `decodeVector` / `codeToBlob` / `blobToCode`）；`tests/unit/quantize.test.ts` **8 条** | — | **A3 / A4 绿**（10 万对零破界；eps 是真误差） |
| **T03** | 回填脚本（分批、可断点） | ✅ **已落地（2026-11-04）**：`scripts/backfill-codes.ts`（`pnpm codes:backfill`）；`tests/integration/backfill-codes.test.ts`（**26 条**） | T01 T02 | 1M 回填完成（**1,000,000 / 73.42s / 库 +944.2 MB**）；**A6** 绿；中断后重跑幂等（`encoded=0`） |
| **T04** | 读取路径两段化 | ✅ **已落地（2026-11-05 · 提交 `f9c966f`）** —— 契约见 **§5.1**、差异台账见 **§5.1.11**、裁决见 **§5.1.12（已裁）**。改哪里：`src/vector/prune.ts`（新）；`src/vector/ivf.ts`（`search()` / `scanBucketCandidates()` / 新增 `readCodes()`·`buildSurvivorSql()`·`countUncodedCandidates()`）；`IvfVectorBackendOptions.prune?: boolean`（缺省 `true`）；**`src/store/dedupCandidates.ts:303` 加一个 options 实参（唯一一行非向量层改动）**；`src/store/recall.ts` 两行（`explain.routes.vector.codesMissing` 接线） | T01 T02 | **A1 / A2 / A7 / A8** 绿（`prune=false` 与 HEAD 逐位一致） |
| **T05** | 写入路径维护码行（同事务） | ✅ **已落地（2026-11-04）**：`src/vector/bucketAssign.ts` 的 `assignBucket()` 现在在**同一事务**里 `writeCodeRow()`（先删旧码行 → 按**本次**向量重编码 → 插新行），`unassignBucket()` 里 `clearCodeRows()`；`fineId === null` 早退分支**删码行**（fail-open）。`src/store/updateContent.ts` 收敛成只调这两个函数（**不再删码**，因为 `assignBucket` 会重编码）。 | T01 T02 | ✅ A6 活域相等；✅ `grep -c vector_codes src/store/write.ts` == 0；✅ `check:bucket-write` 扫到 `bucketAssign.ts` 的码行写入（4 处）；✅ 6 条新断言（换桶跟随 / 重编码 / 退桶删码 / 未训练早退删码 / updateContent 同桶重编码 / 旧码反证） |
| **T06** | bench 计数口径 + H1′ 判据 | ✅ **已落地（2026-11-05 · 提交 `b339534` + `58bde37`）**：① `bench/lib/harness.ts` —— `classifyReadKind()` **两个结论**（legacy 行读**逐位复现** + 字节来源**形状登记表**）、快照加 `calls`（`get()` **调用次数**）、字节**当场累加标量**（O(1) 内存）；② **`bench/lib/byteSources.ts`（新增 · 纯函数解析，无 db 依赖）**；③ `bench/perf.ts` —— **四读数并列落盘**（`bytesRead` / `codeRowsRead` / `memoryRowsRead` / `candidateUniverse`，`CountSummary` 分布、**判定取 `max`**）+ `breakdown`（含 `contentBytes`）⇒ **H1′ 判字节** | T04 T05 | **A5** 绿；**四读数并列落盘**（旧 H1 行数判据**降级为并列观测**，常量 `candidateReadRowsMax` / `candidateReadRowsRatioMax` **保留不删**）<br>⚠️ **本轮硬边界：零 `src/**` 改动**（含注释）⇒ 剪枝率分子改由 bench 侧 `get()` **调用次数**取得（定义上 ≡ `prune` 的 `exactReads`，等价性由 `tests/unit/prune.test.ts` 单测钉住）<br>⇒ **口径定稿**：`docs/design/perf-c2-t06-byte-metering.md`（**唯一权威**）＋ `docs/design/perf-c2-t06-byte-metering-spec.md`（施工规格）<br>⇒ ★ **独立验证**：QA 判定 `NoOne` · 11 条断言全通 · **34/34 打红实验全打红**（零恒绿守卫）⇒ ⇒ **实测值已于 2026-11-05 回填**（1M · 热档 · HDD：`bytesRead.max` = **4,065,792 B** ⇒ ≤ 6,144,000 B ⇒ **绿**，余量 33.8%；剪枝率 3.70% ⇒ **绿**）⇒ ⇒ **出关条件① 达成** |
| **T07** | 冷/热两档重采 + 质量曲线 | 只跑，不改码 | T06 | 见 §7「出关条件」 |

⚠️ **T04 与 T05 可以并行**（都只依赖 T01/T02），但 **T06 必须等两者都完** —— 否则采到的字节数缺一半。

> ⚠️ ★ **T01 落地时的形状变更（比原计划省掉一步，理由两条）**：
> 原计划是「新建 `schema/002_vector_codes.sql` + 给 `scripts/migrate.ts` 加 `--phase codes-ddl`」。
> 实际改成一件事：**DDL 直接进 001/002 两个脚本 + `ensureSchema()` 里幂等补建**。为什么更好：
> ① **`ensureSchema()` 在 `user_version === 2` 时早退**（只校验、不重跑建库脚本）
>   ⇒ 建库脚本里那行对**存量库**永远不执行 ⇒ 必须有一步「补建」，而它天然属于 `ensureSchema()`，
>   不该让运维记着去跑一条 `--phase codes-ddl`（**忘了跑 ⇒ 码表不存在 ⇒ 读取路径静默走精确兜底 ⇒ 优化没生效而没人知道**）；
> ② **`vector_codes` 刻意不进 `V2_NEW_TABLES`**（那张表是「这个库是不是 v2」的指纹）
>   ⇒ 加进去会让**全部存量库**在 `assertV2TablesComplete()` 上抛错，而它们的数据其实完好。
>   ⇒ 于是「建库 / 迁移 / 存量补建」三条路都通向同一张表，且**指纹仍是 9 张**。
>   ⚠️ 代价（诚实记）：DDL 现在有**两份文字**（`schema/*.sql` 与 `src/core/schema.ts` 的 `VECTOR_CODES_SQL`）
>   ⇒ 用一条测试钉死漂移：「去注释 + 压平空白后逐字相等」（`tests/unit/vector-codes-schema.test.ts` ③）。

⚠️ **不加 `Params` 开关**：`params` 现在是 **60 项且被三处副本 + 一条门禁守着**（`check:params` / `params.test.ts` / DESIGN §5）。
为了「运行时可关」加第 61 项，成本是同步四处文档；而**构造选项 `prune` 已经够用**（A1/A2/A7 的对照就靠它）。
⇒ 生产环境的回滚手段 = `VECTOR_ROUTER='flat'`（已有）或代码回退，**不新增参数**。

---

## §5.1 T04 实施规格（两段式可证剪枝）—— 施工定稿

> **状态：已按本节实现并提交（2026-11-05 · `f9c966f`）。** 本节仍是契约的**权威文本**；实现与契约的 6 条差异见 **§5.1.11**。
> 与 §4 冲突处以本节为准（§4 是算法意图 + 证明，本节是代码形状 + 代价）。
> 每条「不这么定会怎样」**不是修辞**：那是我在写这一节时实际推出来的失效模式。

### 5.1.0 一句话形状 + 两条路的分叉点

**写路径**（`scanBucketCandidates()`，`src/vector/ivf.ts:499`，**H1′ 的被考核方**）：

```
① memberIds = readMembers(fineIds) 并集                    ← 桶表区间扫（今天就有，ivf.ts:824）
② codePool  = SELECT memory_id, code, scale, eps
                 FROM vector_codes WHERE fine_id IN (...)   ← ★ 不碰 memories（这是 H1′ 成立的前提）
③ usable    = codePool ∩ memberIds（内存交集）               ← 剔「孤儿码」「fineId 漂移的码」
④ uncoded   = memberIds − usable                            ← 无码 = 精确兜底（写路径无 overlay）
⑤ out = pruneTopK(entries = usable(有码) ∪ uncoded(无码),
                  { query, k: VECTOR_TOPK, threshold: params.DEDUP_COS_MIN,
                    scoreOf: (id) => cosineOf(query, 该行 embedding) })   ← ★ 只在 survivors 上被调用
⑥ rows = 读整行（buildSurvivorSql(out.survivors 的 id)：正文四件套 + embedding）
⑦ return { fineIds, scanned: memberIds.size, rows, uncoded: out.uncoded, exactReads: out.exactReads }
```

**读路径**（`IvfVectorBackend.search()`，`src/vector/ivf.ts:652`）：

```
① fineIds    = route(...)                                   ← 不变（ivf.ts:666）
② memberIds  = readMembers(fineIds) ∪ overlay 命中本桶的 id   ← 不变（ivf.ts:675-689）
③ 码池 / usable / uncoded 同上（overlay 的 id 一定落在 uncoded 里：它**从来没有码行**）
④ ★ id 级谓词先做：excludeIds / this.removed 直接从池里剔   ← 零成本、零数据依赖（可前移）
⑤ ★ 行级谓词：filter 带 timeFloor 或 pinnedTimeFloor ⇒ 先发一条窄列 gate 查询
      （SELECT id, last_access, pin_factor FROM memories WHERE id IN (...)），剔掉不过窗的行；
      两个键都 undefined（`vectorFilterOf()` 的 `{}` 分支，recall.ts:852-861）⇒ **整步跳过**
⑥ out = pruneTopK(entries, { query, k, scoreOf })            ← 读路径**不传 threshold**（不设上界门槛）
⑦ hits = out.survivors; hits.sort(compareHits); return hits.slice(0, k)   ← 保留 sort（幂等，去掉省不下什么）
```

**两条路的差别只有三处**（写进代码注释，别再增加）：`threshold`（写路径有）、
`k`（写路径 `VECTOR_TOPK`，读路径 `VECTOR_TOPK × VECTOR_OVERFETCH_FACTOR`）、
以及 ⑤ 的窄列 gate（写路径**没有时间窗**，`buildBucketCandidateSql()` 的注释已写明「刻意不加时间窗」）。

⚠️ **不这么定会怎样（两条路各一条）**：
- 写路径若在 ② 里 `JOIN memories` 判 `deleted = 0`，**H1′ 当场不成立**：`memories` 行 payload ≈ 3.2KB
  （`embedding` 3,072B 内联，页大小 8192 ⇒ 整行 ≈ 一页）⇒ 「判 `deleted`」和「搬运向量字节」**是同一笔页读**
  ⇒ `bytesRead` 回到 17MB 量级。⇒ **②不许碰 `memories`** 是硬约束，不是优化建议。
- 读路径若把 ⑤ 省掉、把时间窗放进 `scoreOf`（返回 `null`），**结果仍然对**（`null` 不占 K 名额），
  但会为「注定被时间窗挡掉的行」付 3KB/行 ⇒ R1 的收益被吃掉一部分。⇒ ⑤ 是**便宜的**做法，不是**正确的**做法；
  两者都正确，别把「省 ⑤」当成「会漏检」。

### 5.1.1 新文件 `src/vector/prune.ts` 的接口（**纯剪枝，不带分数公式**）

```ts
/** 「有码」候选：上界可由码算出。 */
export interface CodedEntry {
  readonly kind: 'coded';
  readonly id: string;
  /** 768 个 int8。**长度校验在调用方**（`readCodes()` 里已判，见 5.1.5）。 */
  readonly code: Int8Array;
  /** x̂ = scale × code；必须有限。 */
  readonly scale: number;
  /** 编码期实算的 ‖x − x̂‖₂（已含 +1e-6）；必须非负有限。 */
  readonly eps: number;
}

/** 「无码」候选：上界按 `+∞` 处理 ⇒ 一律并入 survivors。 */
export interface UncodedEntry {
  readonly kind: 'uncoded';
  readonly id: string;
}

export type PruneEntry = CodedEntry | UncodedEntry;

/** 一条入选行（形状与 `VectorHit` 逐字段相同 ⇒ 可直接交给 `compareHits`）。 */
export interface PruneHit {
  readonly id: string;
  readonly score: number;
}

export interface PruneOptions {
  /** 查询向量（**已 L2 归一化**；长度必须 == 每个 `code.length`）。 */
  readonly query: Float32Array;
  /** 取前 `k` 条（非负整数；`0` ⇒ 返回空 survivors，但 `candidates` 仍如实计数）。 */
  readonly k: number;
  /**
   * **上界门槛**（写路径 = `params.DEDUP_COS_MIN`；读路径**不传**）。
   * ⚠️ 它作用在 `upper = approxDot + eps` 上，**不是**作用在精确分上（见 5.1.6 的推导）。
   */
  readonly threshold?: number;
  /**
   * ★ **结果键的下界**（缺省 `-Infinity` = 无下界）。**两条路都必须传 `0`**（见 §1 的订正 / ADR §8.3.1）。
   *
   * 判据用 `max(upper, scoreFloor) < 第 K 名的 score`，**不是**裸 `upper`：
   * 结果键是 `clampCos(...)`（`score = max(0, cos)` ≥ `cos`）⇒ 当 `cos < 0` 时 `upper` **不是**
   * `score` 的上界 ⇒ 裸 `upper` 会把「同分（0 分）但 id 更小」的行静默跳掉（条数、分数都一样，只有 id 不同）。
   * ⚠️ 代价：第 K 名正好 `0` 分时 `max(upper,0) < 0` 恒假 ⇒ **早停不触发**（弱查询全额付费）。
   */
  readonly scoreFloor?: number;
  /**
   * **算一条的精确分**（读原向量 + 点积 + 结果键的变换，口径由调用方持有 ⇒ C36）。
   * · 返回 `number` ⇒ 该行参与 K 竞争；
   * · 返回 `null` ⇒ **该行不在候选宇宙里**（软删 / 不过时间窗 / 无向量 / 维度不符），
   *   **不入堆、不占 K 名额**（但仍计入 `exactReads`：那一次调用可能已经读了整行）；
   * · 抛错 ⇒ 原样透传（**不许吞**）。
   * ⚠️ `null` **不表达**「分数不够」：分数门槛归调用方（见 5.1.6）。
   */
  readonly scoreOf: (id: string) => number | null;
}

export interface PruneOutcome {
  /** 入选行，**已按 `compareHits` 定序**（精确分降序、同分 id 升序）。 */
  readonly survivors: readonly PruneHit[];
  /** **候选宇宙条数 = entries.length**（★ 不是 survivors.length，见 5.1.3）。 */
  readonly candidates: number;
  /** 走精确兜底的条数（`entries` 里 `kind === 'uncoded'` 的个数）。 */
  readonly uncoded: number;
  /**
   * `scoreOf` 被调用的**次数**（返回 `null` 也算 —— 那一次同样可能已经读了整行）。
   * ⇒ 它是「为精确分付了代价的行数」的**上界**，不是 survivors 的条数。
   */
  readonly exactReads: number;
}

/**
 * 按可证上界降序取 top-k，**精确重排 + 严格小于早停**。
 * @throws {MemoryError} `INVALID_INPUT`：`k` 非非负整数 / `query.length` 与某条 `code.length` 不等 /
 *         `scale`·`eps` 非有限 / `eps < 0` / `threshold` 为 NaN
 */
export function pruneTopK(entries: readonly PruneEntry[], options: PruneOptions): PruneOutcome;
```

**四条接口纪律**（每条都对应一个具体后果）：

| # | 纪律 | 不这么定会怎样 |
|---|---|---|
| ① | **不导出**「谁是第几名」的中间态，只给 `survivors` + 三个计数 | 导出堆 ⇒ 调用方会顺手拿堆内元素自己排序 ⇒ 定序出现第二份实现 |
| ② | **不自己算点积 / 不自己钳制**：`scoreOf` 由调用方注入 | 写路径用 `cosineOf()`、读路径用 `clampCos(dot())` —— 两套既有口径（★ 两者**都钳进 `[0,1]`**，见 §1 的订正）。放进 `prune.ts` 就成了**第三套**，且 `fuseScore` 下游会看到不同的 `score`（A2 红） |
| ③ | 排序**复用** `compareHits`（`src/vector/flat.ts:377`，直接 `import`） | 自己写一个 `(a,b)=>b.score-a.score` 就是漏掉「同分 id 升序」⇒ 同分跨越 K 边界时 A1/A2 会**偶发**红（最难查的一类） |
| ④ | `prune.ts` **不 import `better-sqlite3`、不写 SQL** | 一旦它能读库，`scanned`/`bytesRead` 的口径就会被撕成两处，T06 的账没法归因 |

**两条路怎么共用同一个原语**（这是「一个原语」的全部含义）：

| 语义 | 写路径（阈值 + top-K） | 读路径（纯 top-K） |
|---|---|---|
| `threshold` | `params.DEDUP_COS_MIN`（只剪上界） | 不传 |
| `k` | `VECTOR_TOPK`（= 20） | `VECTOR_TOPK × VECTOR_OVERFETCH_FACTOR`（= 60） |
| `scoreFloor` | **`0`**（结果键 = `cosineOf()` = `clampCos` ⇒ 下界 `0`） | **`0`**（结果键 = `clampCos(dot())` ⇒ 下界 `0`） |
| `scoreOf` | `cosineOf(query, blobToVector(embedding))`（`dedupCandidates.ts:190`，**内部 `clampCos`**，`:216-218`）—— **`null` = 软删 / 无向量** | `clampCos(dot(query, vector))`（`ivf.ts:1247` 的 `makeScoreOf()`）—— **`null` = 软删 / 不过窗 / 无向量 / 不在库** |
| 下游再做什么 | `collectVectorCandidates()` 仍按 `cos < DEDUP_COS_MIN` 过一遍（**幂等**，见 5.1.6） | `hits.sort(compareHits)` 再排一次（**幂等**） |

### 5.1.2 五条 SQL（3 新增 / 2 复用）+ `readCandidateRows()` 的去留

| # | 归属 | SQL 形状 | 碰 `memories`？ | 谁用 |
|---|---|---|---|---|
| **Q1 成员** | 不变（`readMembers()`，`ivf.ts:824`） | `SELECT fine_id, memory_id FROM vector_cell_members WHERE fine_id = ?` | ❌ | 两路都要（`scanned` 与差集的分母） |
| **Q2 码池** | 新增 `readCodes(db, fineIds)` | `SELECT vc.memory_id AS id, vc.code, vc.scale, vc.eps FROM vector_codes vc WHERE vc.fine_id IN (...)` | ❌ ★ | 两路都吃它做剪枝 |
| **Q3 窄列 gate** | 新增 `readGateColumns(db, ids)` | `SELECT id, last_access, pin_factor FROM memories WHERE id IN (...)` | ✅（窄列） | **只有读路径、且只在不带窗口时跳过** |
| **Q4 survivors 整行（写）** | 新增 `buildSurvivorSql(ids)` | `SELECT m.id, m.content, m.content_tokens, m.stability, m.last_access, m.access_count, m.difficulty, m.embedding FROM memories m WHERE m.id IN (...) AND m.deleted = 0 AND m.embedding IS NOT NULL` | ✅（整行） | 写路径 survivors（~K 条） |
| **Q5 survivors 整行（读）** | **复用** `readCandidateRows(ids)`（`ivf.ts:844`） | 原样（`id, embedding, last_access, pin_factor`，带 `deleted = 0 AND embedding IS NOT NULL`） | ✅（整行） | ⚠️ **生产读路径不使用；仅 `prune=false` 对照分支用** —— `readCandidateRows()` 的**唯一**调用点是 `ivf.ts:1110` 的 `searchExactBuckets()` ⇒ `searchPruned()` **不发这条 SQL** ⇒ 读路径 survivors 的 `embedding` **只读一次**（`scoreOf` 那次）⇒ **不补 Q5**（`pruneTopK()` 的 `out.survivors` 已带 `score`，`searchPruned()` 不消费 `embedding`/正文 ⇒ 补它是**无消费者的白读** `k × 3,072 B`） |

⚠️ ★ **限定：下面这三句只对【写路径】成立**（**读路径无 Q5** ⇒ `readCandidateRows()` 只被 `prune=false` 对照分支用 ⇒ 读路径 survivors 的 `embedding` **只读一次**（`scoreOf` 那次）⇒ **没有第二次读、也没有那 `0.20MB`**）：

★ **两条 SQL 的分工不许混**：`scoreOf` 逐条读 `embedding`（5.1.10），**Q4/Q5 又为 survivors 批量读一次整行**
⇒ survivors 的 `embedding` 被读**两次**。这是**刻意**的（不缓存 ⇒ 峰值内存只与一条向量成正比，与 HEAD 的内存纪律一致），
代价是 `k × 3,072B ≈ 0.20MB` —— **ADR §8.6 里那 0.20MB 就是这一项，不是别的**。

> **H1′ 预算复算（★ 订正 ADR §8.6 的一个漏项）**：ADR 的估算写的是「`2,184 × 768B` + `64 × 3,072B`」，
> 它**没有算 Q1 的桶成员扫**（T04 新增，HEAD 的写路径没有这一步）。
> 按 1M 实测的 `max`（5,521 行）重算：
> `5,521 × 784B`（码行，含行头/scale/eps）`= 4.33MB` + `5,521 × ~50B`（成员行）`= 0.28MB` + `64 × 3,072B = 0.20MB`
> ⇒ **≈ 4.81MB vs 门槛 6.14MB ⇒ 余量 22%**（ADR 写的 28% 偏乐观 6 个点，结论不变）。
> ⚠️ 这仍是**推断**：Q1 的 50B/行 是按 `(fine_id, memory_id)` 两个 UUID 级字符串估的，**T06 必须实测**。

**`readCandidateRows()` 保留**，但**语义从「全部候选」变成「survivors」**：
- 它一次就把 3KB 全取回来 —— 在 T04 之后**只对 survivors 调用**（~60 行而不是 ~5,521 行）⇒ 这正是收益的来源。
- ⚠️ **必须改它的 JSDoc**（`ivf.ts:839-843`），写死「入参只能是 survivors 的 id」。不改 ⇒ 下一个人会把它当「全量候选读」继续用，**收益静默消失而所有测试都绿**。

**`buildBucketCandidateSql()` 保留原样**（`ivf.ts:453`），原因两条，缺一条就会踩坑：
1. `prune = false` 路径必须用它 —— 那是 A7「与 HEAD 逐位一致」的唯一依据；
2. `tests/**` 里那条 `EXPLAIN QUERY PLAN` 断言（P2-T07：两张表都得是 `SEARCH`）钉的就是**这条 SQL 的文本**。
   ⇒ 给它加 `AND m.id IN (...)` 会**改掉被断言的语句** ⇒ 得同时改测试 ⇒ 「用测试钉住的形状」变成了「测试跟着实现走」。
   ⇒ 所以 survivors 走**新**的 `buildSurvivorSql()`（单表 `id IN` + 主键 `SEARCH`），旧 SQL 一个字不动。

⚠️ **不这么定会怎样**：若把 Q2 写成 `JOIN memories`（哪怕只 `SELECT m.deleted`），`bench/lib/harness.ts:980`
的 `classifyReadKind()` 会把它认成 `candidate`（它的正则**先**匹配 `FROM|JOIN memories`），
⇒ T06 的 `codeRowsRead` 永远是 0、`memoryRowsRead` 永远是满额 ⇒ **H1′ 的账从根上算错，而报表看起来很正常**。

### 5.1.3 ★ `scanned` 的口径（**语义不变，来源换了**）

**今天**（写路径唯一出口，`ivf.ts:533`）：`scanned = 那次 JOIN 查询返回的行数` = 命中桶内 `deleted = 0` 且有向量的行数。
**它被三处当契约用**：`VectorCandidateResult.scanned`（`dedupCandidates.ts:270`）、
bench 的 `writeSegments.vectorCandidateRows`（`perf.ts:951` 取 `scan.scanned`，`:1041` 落盘，
**它本身就是 H1/H2 的判据量**）、以及 R6 的历史读数。

**T04 之后**：

```
scanned := memberIds.size          // 命中桶的**成员行数**（Q1 的结果，去重后）
```

| 问题 | 答案 | 理由 |
|---|---|---|
| 是数码行还是数成员？ | **数成员**（`memberIds.size`） | 码池是成员的**子集**，且可能含孤儿码 / 漂移码（`lonelyCodes` / `fineIdDrift`）⇒ 数码行会把「码表脏」算成「候选宇宙变了」，两件事混成一件。成员数**只依赖桶表**，与码表状态无关 ⇒ 在回填未完成 / 码表脏时**读数仍然稳定** |
| 为什么不数 survivors？ | 那正是**禁止**的 | survivors 是「剪枝之后」的数。改成它就是 `scanned`（候选宇宙）与 `exactReads`（真读了几条）混成一个 ⇒ **「剪枝率」这个出关条件①要看的量消失**，R6/H1 的历史读数不可比 |
| 与 HEAD 的 `scanned` 逐位相同吗？ | **只在「命中桶内没有软删成员」时相同** | HEAD 的口径里排除了软删（`m.deleted = 0`），而成员表**故意保留软删归属**（§9.3.2 ②，`src/store/forget.ts:65` 只改 `deleted = 1`，**不调 `unassignBucket`**）⇒ 差 = 命中桶内软删成员数 |
| 这个差危险吗？ | ❌ 不危险，**方向恒为偏大** | 偏大 ⇒ H1 看起来**更差**，不会假绿。且它在 T06 有**独立并列读数**可见：`softDeletedInBuckets = COUNT(members) − COUNT(codes)`（两个都是 COUNT，免费） |
| 怎么防止「我们觉得差不多」？ | **用定向断言钉死** | A1' 负控（见 5.1.8）：造 3 条软删成员 ⇒ 断言 `scanned(prune=true) == scanned(prune=false) + 3`。**偏差变成一个可预期的算式，而不是一句免责声明** |

**`bytesRead` / `codeRowsRead` / `memoryRowsRead` / `candidateUniverse`：T04 不落，留 T06。**
T04 只做两件「替 T06 留结构」的事（都不产生读数）：
1. **每条 SQL 各自 `db.prepare()` 成独立语句**、文本互不相同（不拼多语句字符串）⇒ T06 的 `classifyReadKind()` 才能逐条认领；
2. `PruneOutcome` 交出 `candidates` / `uncoded` / `exactReads` 三个数，`BucketCandidateScan` 把它们原样带出去
   （`BucketCandidateScan` 新增两个**必填**只读字段 `uncoded` / `exactReads` —— 必填是为了让 TS 逼实现填上，
   **`dedupCandidates.ts` 不读它们 ⇒ 该文件仍然零改动**）。

⚠️ **不这么定会怎样**：T04 若顺手在 `ivf.ts` 里数 `bytesRead`（`rows.length * 768`），
T06 就得在**两处**维护字节口径，而 T06 还要按 SQL 分别累计（Q3 与 Q4 都碰 `memories`，但一个读 3 列、一个读 8 列）
⇒ 两套账必然漂移，且漂移时**没人能判断哪个对**。

### 5.1.4 `prune` 开关（**不加 `Params` 键**，理由见 §5 末）

```ts
export interface IvfVectorBackendOptions {
  // …既有字段不动…
  /** 读路径是否做两段式剪枝（缺省 `true`）。`false` ⇒ **逐位回到 HEAD 行为**（A7）。 */
  prune?: boolean;
}
```

写路径的对应开关是**函数参数**（`scanBucketCandidates` 第 6 个可选参数），不是配置：

```ts
export interface BucketScanOptions {
  /** 缺省 `true`。**仅供对照**（A1 / A7）。 */
  prune?: boolean;
  /** 上界门槛；**必须**由调用方传 `params.DEDUP_COS_MIN`（`setParams()` 可改它，不许用 `DEFAULT_PARAMS` 顶）。 */
  threshold?: number;
}
export function scanBucketCandidates(
  db, model, query, nprobeCoarse, nprobeFine,
  options?: BucketScanOptions,
): BucketCandidateScan
```

**`prune = false` 必须逐位等同于 HEAD 的什么**（三条，缺一条 A7 就是假的）：

| 量 | `prune = false` 必须等于 |
|---|---|
| 写路径 `rows` | HEAD 的 `buildBucketCandidateSql(fineIds)` 结果逐行（`id` 序列、`embedding` **字节**、正文四件套） |
| 写路径 `scanned` | HEAD 的 `rows.length`（**不是** `memberIds.size` ⇒ `prune=false` 路径**不许**调 `readMembers`） |
| 读路径 `hits` | HEAD 的 `readCandidateRows([...memberIds])` + 原有循环 + `sort(compareHits)` + `slice(0,k)` |

⇒ 因此 `prune = false` **是一条独立的代码分支**（不是「`threshold = -Infinity` 的退化」）：
退化写法会改变 `scanned` 的来源、并让 Q3 仍被发出。**两条分支各自完整**，共用的只有 `route()` 与 `readMembers()`。

⚠️ **不这么定会怎样**：若 T04 只留「剪枝」一条实现、用参数把它调成「不剪」，
那 A7 测的就不是「HEAD 行为」而是「剪枝实现的退化版」——**HEAD 的 SQL 已经没人执行了**，
`EXPLAIN QUERY PLAN` 那条断言会变成对一个死代码的断言。**A7 的全部价值 = 旧路上真的有流量。**

⚠️ **诚实记（回滚手段的不对称）**：读路径可以靠构造选项关（`new IvfVectorBackend({..., prune:false})`），
写路径**没有** options 来源（`collectVectorCandidates()` 手上只有 `params` 与 `buckets`）⇒
写路径要关只能**代码回退**。**这是刻意的**：给写路径加一个配置来源 = 第二个「后端行为由谁决定」的答案。

### 5.1.5 无码行（A8）的判定与「fail-open」

**判定在 `readCodes()` 里一次做完**（池构造阶段，不在 `prune` 里）：

| 情形 | 判据 | 处置 |
|---|---|---|
| 码行不存在 | `codePool` 里没这个 id | ⇒ 进 `uncoded` ⇒ `upper = +∞` ⇒ 精确兜底 |
| `code` 长度 ≠ `EMBED_DIM` | `code.length !== config.dimensions`（`blobToCode()` 之后判） | 同上 |
| `scale` 非有限 | `!Number.isFinite(scale)` | 同上 |
| `eps` 非有限或为负 | `!Number.isFinite(eps) \|\| eps < 0` | 同上 |
| 码行的 `fine_id` 漂移 / 成为孤儿码 | `codePool ∩ memberIds` 时被剔 | ⇒ 该成员落进 `uncoded` ⇒ 精确兜底（`fineIdDrift` / `lonelyCodes` 是 A6 的红项 ⇒ 有信号灯） |

**为什么这样仍然正确**（三层，逐层收紧）：
1. `upper = +∞` ⇒ 它在「按 upper 降序」的序列里**排最前** ⇒ 一定在早停之前被读到；
2. 早停判据要求「剩余 upper 最大值 **<** 第 k 名」，而 `+∞` 永远不小于任何有限分 ⇒
   **只要还有无码行没读，早停就不可能触发** ⇒ 不会被跳过；
3. ★ 它读的是 `memories.embedding` 的**当前值**，即 `cos_true` 的定义本身 ⇒ 不存在「上界过期」问题。

★ **由此得一条通用纪律（也是 T05 的验收原则）**：
> **码行的失效策略必须是 `fail-open`（删码 / 走兜底），绝不允许 `fail-stale`（留旧码）。**
> 旧码会给出**错误且看起来正常**的上界 —— 这是本档唯一能产生**静默漏检**的形状。

**坏维度的行为差（记录在案，不是 bug）**：HEAD 对**任何**候选行做维度校验（`ivf.ts:699-705`，不匹配就抛 `INVALID_INPUT`）；
T04 只对 **survivors** 校验 ⇒ 不进 survivors 的坏维度行不再抛错。
**为什么可以接受**：坏维度的 `embedding` 在**回填时就被跳过了**（`scripts/backfill-codes.ts:429-438` 的 `SCAN_SQL`
按 `length(embedding) = @bytes` 分类，坏的进 `skippedBadEmbedding` 而不写码）⇒ 它**一定没有码**
⇒ 一定落进 `uncoded` ⇒ 一定进 survivors ⇒ **校验仍然会触发**。
唯一能造出「坏维度 + 有码」的是**手工改库**（`updateContent()` 有维度校验，`write()` 有 `assertValidEmbedding`）
⇒ 与 R8 是同一个前提，同一节处置。

### 5.1.6 过滤与剪枝的先后（**顺序写死**）

```
① id 级谓词（excludeIds / removed）：在「池」上直接剔 —— **必须在进 prune 之前**
② 行级谓词（时间窗）：先发 Q3 窄列 gate，剔掉不过窗的行 —— **必须在进 prune 之前**
③ 上界剪枝（threshold）
④ 精确重排 + 早停（scoreOf）
```

**①② 为什么必须前置**（精确理由，不是「惯例」）：

| 若后置 | 后果 |
|---|---|
| 把行级谓词放在 `scoreOf` 里返回 `null` | **结果仍然正确**（`null` 不入堆、不占 K 名额），但**为注定被剔掉的行付 3KB/行**，且 `exactReads` 这个数**失去意义**（它不再等于「真读了几条」的有意义的量） |
| 把行级谓词写成「先算分入堆、最后再 filter」 | ★ **会真的坏**：被剔掉的行占住 K 个名额 ⇒ survivors 不足 k ⇒ 返回条数比 HEAD 少 ⇒ **A2 红**（且 `hits` 少了以后 `fuseScore` 下游全变） |
| 把 id 级谓词后置 | 白白为这些 id 付 3KB（它们连 SQL 都不该被查） |

⇒ **规则**：行级谓词只有两种合法位置 —— **前移到 SQL（Q3）** 或 **在 `scoreOf` 里返回 `null`**。
**禁止的第三种形状是「先入堆、事后再 filter」**。

★ **`null` 的语义边界（最容易写错的一处）**：`scoreOf` 返回 `null` 只表达「这一行**不在候选宇宙里**」，
**不表达「分数不够」**。理由：分数门槛（`cos < DEDUP_COS_MIN`）属于**下游**（`dedupCandidates.ts:324`）；
如果 `prune` 也按精确分剔，就等于**同上界一起把结果门槛也实现了**（第二份口径）。

**那「cos 不够但 upper 够」的行占了 K 名额怎么办？** —— 数学上**不会挤掉该入选的行**，证明：
> 设 θ = 结果门槛，池 = `{upper ≥ θ}` ⊇ `{cos ≥ θ}`（因为 `cos ≤ upper`）。
> 池里每个 `cos ≥ θ` 的行的精确分 **严格 ≥ θ**，而每个 `cos < θ` 的行的精确分 **< θ**。
> ⇒ 按精确分降序排，**所有「该入选的行」都排在所有「凑数的行」之前** ⇒
> 取 top-K 时凑数行**只能填不满 K 的空位**，永远挤不掉一条 `cos ≥ θ` 的行。
> ⇒ 于是 survivors 经下游 θ 过滤后 = `min(K, |{cos ≥ θ}|)` 条 = **HEAD 的结果，逐位相同** ✓

（这条推导是 5.1.7「早停」与 A1 的对齐依据。**它也是「`threshold` 只作用在 `upper` 上」这个决定的全部理由** ——
若把 `threshold` 作用在精确分上，上面这段就变成「两份 θ 实现」，且二者对 `clampCos` 边界的行为未必一致。）

### 5.1.7 早停条件的精确形状

```ts
// heap = 小顶堆，容量 k，**根 = 当前第 k 名（最差的那一个）**
// 「更差」的定义（与 compareHits 对偶）：a 比 b 差 ⟺ a.score < b.score ∨ (score 同 ∧ a.id > b.id)
while (有序条目里还有剩余) {
  const 剩余上界最大 = max(队列头的 upper, scoreFloor);   // 队列按 upper 降序、同 upper 按 id 升序
  if (heap.size === k && 剩余上界最大 < heap根.score) break;   // ★ 严格小于 + ★ 必须带 scoreFloor
  …
}
```

⚠️ **`max(upper, scoreFloor)` 这一层不能省**（2026-11-05 订正，详见 §1 与 ADR §8.3.1）：
结果键是 `clampCos(...)`，`cos < 0` 的行结果键是 `0`，而它们的 `upper` 可能是负数
⇒ 裸 `upper < 第 K 名` 会把「同分（0）但 id 更小」的行**静默跳掉**（条数、分数都一样，只有 id 不同）。
`scoreFloor` 取结果键的下界（两条路都是 `0`）。

| 细节 | 定死为 | 不这么定会怎样 |
|---|---|---|
| 比较符 | **`<`**（严格小于） | 用 `≤`：`upper` 恰好等于第 k 名时会把该行跳过，而该行可能**真实分等于第 k 名且 id 更小** ⇒ 破坏 `compareHits` 的「同分 id 升序」定序 ⇒ **A2 偶发红** |
| 判据用哪个量 | **`max(upper, scoreFloor)`**，`scoreFloor = 0` | 用裸 `upper`：`cos<0` 的行结果键被钳成 `0` ⇒ `0 > upper` ⇒ **`upper` 不是结果键的上界** ⇒ 第 K 名恰好 0 分时静默丢行（**只有 id 不同**，任何「分数差不多」的抽查都抓不住） |
| 精确重排的预算 | **写路径**传 `WRITE_EXACT_RESCORE_BUDGET`（`prune.ts`，= 64）；**读路径不传** = 无预算（`PruneOptions.exactRescoreBudget?: number`，缺省 `undefined`）。用尽后**撤回剪枝**（不再早停、逐行精确）⇒ **结果不变**（`upper` 是上界 ⇒ 比第 K 名差的行进不了堆），只多付 IO | ⚠️ 见 §5.1.11 偏离 #6：两条路共用一个 64 时，**读路径**（`k = 60`）只剩 4 次早停机会 ⇒ 实际等同于「不剪枝」。它是**退化下限**，不是正确性机制。<br>✅ **已按 §5.1.12 的选项 (a) 修（T04 收尾 · 2026-11-05）** |
| 队列排序 | `upper` **降序**；**同 `upper` 按 `id` 升序** | 同 `upper` 不定序 ⇒ 哪些行被读、被跳在两次运行间不同 ⇒ `exactReads` 抖、事故复盘对不上（结果集仍对，但**没法自证**） |
| 无码条目的 `upper` | `+∞` ⇒ 排**最前** | 若排在后面，早停会被「还没读的无码行」无限推迟；排最前 = 把不确定的那部分**先付掉**，之后才可能早停 |
| 堆未满时 | **不许早停** | 第 k 名不存在 ⇒ 无可比对象 ⇒ 停就是丢行 |
| 同分定序 | **复用 `compareHits`**（`flat.ts:377`） | 另立一份 ⇒ 见 5.1.1 纪律 ③ |
| 返回前 | 按 `compareHits` 排一次（堆是无序的） | 直接返回堆数组 ⇒ 顺序随机 |

### 5.1.8 四条断言的**比较对象** + 测试落点

| # | 比什么（**逐位**，不是集合相等） | 落点 | 夹具 | 要 1M 库？ |
|---|---|---|---|---|
| **A1** | `BucketCandidateScan`：① `fineIds` 序列；② `rows[].id` **序列**；③ `rows[].embedding` **Buffer 字节**；④ `scanned`。四项 `prune=true` vs `prune=false` 全部 `Object.is` 级相同 | `tests/unit/ivf.test.ts`（新增 `describe('T04 · 两段式可证剪枝')`，沿用本文件既有的 `trainFixture()`） | `trainFixture({ count: 300, coarseCenters: 4, fineCenters: 12 })`；查询向量用 `pseudoUnitVector(seed)` 造 20 条 | ❌ |
| **A1'**（新增，负控） | 造 3 条**软删但有桶归属**的行 ⇒ `scanned(prune=true) === scanned(prune=false) + 3`，**且** `rows[].id` 仍逐位相同（软删行不进 survivors） | 同上 | 同上 + 3 行 | ❌ |
| **A2** | `search()` 返回的 `{id, score}` **数组**（含顺序）逐位相同；`score` 用 `Object.is`，**禁止 `toBeCloseTo`** | `tests/unit/ivf.test.ts`（后端层，50 条查询）+ `tests/integration/recall-vector-ivf-path.test.ts`（端到端：`recall()` 的 `hits[].id` 序列） | 同上 + 一份「带 `timeFloor` 的 filter」用例（走 Q3 那条分支）与一份 `{}` filter（不走 Q3） | ❌ |
| **A7** | `prune=false` vs **手写参照**（照抄 HEAD 的 SQL 与循环）逐位一致：`scanned` / `rows[].id` 序列 / `rows[].embedding` 字节 / `hits` 顺序 | `tests/unit/ivf.test.ts` | 同上 | ❌ |
| **A8** | `DELETE FROM vector_codes WHERE memory_id IN (若干)` 之后，`search()` 与 `scanBucketCandidates()` 的结果与「全码」**逐位相同**（同 A1/A2 口径），且 `uncoded` == 被删条数 | `tests/unit/ivf.test.ts`（删码写法直接抄 `tests/integration/backfill-codes.test.ts` 的「第二条码行删一半」用例） | 同上（A8 是**语义**断言，不是规模断言） | ❌ |

⇒ **A1/A2/A7/A8 一条都不需要 1M 库**：它们的判据全是「同一份数据、两条实现的输出是否逐位相同」，
与规模无关；用大库只会让「哪一位不同」变成灾难。**1M 只服务于 T07 的 A5 / H1′ 读数。**

⚠️ **不这么定会怎样**：A1 写成「集合相等」（`expect(new Set(a)).toEqual(new Set(b))`）⇒
**同分跨越 K 边界时的那一位不同会被吃掉** —— 而「同分」在这套系统里是**常态**
（`compareHits` 的注释原话：被钳制到 0 的负余弦大量同分）⇒ 这条断言会长期假绿。

### 5.1.9 `codesMissing`（R8 的运行时计数）在 T04 的落点

```ts
/** 命中桶内「有成员、无码」的条数 —— **上界**（含软删成员；行级谓词未施加）。 */
export function countUncodedCandidates(db: Database.Database, fineIds: readonly string[]): number;
```

- **SQL**：`SELECT count(*) FROM vector_cell_members vcm WHERE vcm.fine_id IN (...) AND NOT EXISTS (SELECT 1 FROM vector_codes vc WHERE vc.memory_id = vcm.memory_id)`
  ⇒ **不碰 `memories`**，成本 = 桶表区间扫 + 每行一次 `idx_vcode_memory_unique` 探针（5521 行 ≈ 0.3MB ≈ 亚毫秒）。
- **为什么放在 `ivf.ts` 而不是 `recall.ts`**：§4.6 步骤 2c 的硬边界 —— **表名不许出向量层**。
- **接线**：`recall.ts` 在 `explain` 里加一个字段（该字段只在 `withBreakdown === true` 时计算 ⇒ **正常召回零成本**）：
  ```ts
  export interface RecallVectorRouteInfo extends RecallRouteInfo {
    /** 本次命中桶内「无码 ⇒ 走了精确兜底」的行数（上界；`> 0` = 码没铺满）。 */
    readonly codesMissing: number;
  }
  // Explain: routes: { text: RecallRouteInfo; vector: RecallVectorRouteInfo; graph: RecallRouteInfo }
  ```
  ⚠️ 用**子接口**而不是给 `RecallRouteInfo` 加可选字段：加可选字段会污染 `text` / `graph`（它们不产这个数，
  却会被允许存在 ⇒ 下一个人会去填它，填什么都是编的）。
  ⚠️ 这一改会让 `tests/**` 里对 `explain.routes.vector` 做**严格相等**（`toEqual({ran, candidates})`）的断言变红
  ⇒ 预期内的**加法式破缺**，改成 `toMatchObject` 或补字段即可，**不是回归**。

详见 **§7.1**（R8 的完整口径）。

### 5.1.10 `scoreOf` 的 IO 形状（**逐条 prepared statement，不做批量预取**）

`scoreOf` 在 prune 的流式循环里被调用 ⇒ 它只能**一次读一条**：

```ts
// 写路径：复用同一条 statement（better-sqlite3 的 prepare 只做一次）
const one = db.prepare('SELECT embedding FROM memories WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL');
const scoreOf = (id: string): number | null => {
  const row = one.get(id) as { embedding: Buffer } | undefined;
  if (row === undefined) return null;                       // 软删 / 无向量 ⇒ 不在候选宇宙
  return cosineOf(query, blobToVector(row.embedding));       // ★ 既有口径（dedupCandidates.ts:190）
};
// 读路径：同形，但要用 overlay 覆盖 + clampCos，见 5.1.1 的 scoreOf 表
```

| 决策 | 定死为 | 不这么定会怎样 |
|---|---|---|
| 批量预取 survivors？ | ❌ **不做** | 预取就是在**猜** survivors：猜大了白读 3KB，猜小了要多一轮 IO ⇒ 而早停的正确性依赖「按需、按 upper 降序」。预取等于把「猜」写进算法 |
| 每条一次 `get()` 的开销 | **可接受**（`exactReads ≈ k` ≈ 20~64 次；statement 已 prepare，每次 ≈ 十微秒级） | 若为了省开销改成「按 chunk 批量读」⇒ 早停的边界会变成「chunk 边界」，`exactReads` 与 A1 的 `scanned` 语义都对不齐 |
| 期望的调用次数 | **≈ `k`**（剪枝率的定义就在这：`exactReads / candidates`）。出关条件① 的「剪枝率 ≤ 15%」= `exactReads ≤ 0.15 × candidates` | 若 `exactReads ≈ candidates` ⇒ **剪枝没生效**（`eps` 太大 / 码坏了）而结果仍然全对 ⇒ **只有这个数能发现它** |

⚠️ **不这么定会怎样**：若把 `scoreOf` 写成「先 `SELECT embedding ... WHERE id IN (全部候选)` 再在内存里算」，
那 T04 就退化成 HEAD（读 5,521 行的 3KB）⇒ **H1′ 直接红，而所有等价性断言全绿** ——
这是本档最容易犯的错：**「结果对」与「收益在」是两件事，A1/A2 只测前者。**

### 5.1.11 ★ T04 落地状态与 6 条偏离（2026-11-05，**代码已实现并提交 · `f9c966f`**）

**状态**：`prune.ts` + `ivf.ts` 两段式 + 写路径接线 + `codesMissing` 已实现，**已 commit（`f9c966f` · 2026-11-04 18:30）**。
改动面：**15 个代码/测试文件**（2 新增：`src/vector/prune.ts`(477 行)、`tests/unit/prune.test.ts`；
13 修改：`src/vector/ivf.ts`、`src/store/dedupCandidates.ts`、`src/store/recall.ts`、`scripts/backfill-codes.ts` + 9 个测试）。
⇒ **本节 = 契约与实现的差异台账**。凡「实现比契约弱」的，都写在这里，**不许只活在提交 message 里**。

| # | 偏离 | 为什么可接受 / 影响面 | 后续动作 |
|---|---|---|---|
| **1** | **`scanned` 允许比实际物化的 `memories` 行数偏大**：`scanned = memberIds.size`（成员行数），而软删行仍在桶里 ⇒ 它比「真正被读的行」多 | ✅ **方向恒为保守**：只会让 H1/R6 的读数**更差**，不可能更好 ⇒ 不会假绿（§5.1.3）。⚠️ 但由此**不能**用 `scanned` 反推 `bytesRead` | **T06 必须并列落盘 `memoryRowsRead`**（真读了几行）+ `softDeletedInBuckets`；用 A1' 负控钉住偏差算式（`+软删成员数`） |
| **2** | `readCandidateRows()` **保留**，但**只对 survivors 调用**；不再用于「取全部候选」 | ✅ 这正是收益来源（~60 行而不是 ~5,521 行） | 已在该函数的 JSDoc 里写死「入参只能是 survivors」（§5.1.2 的要求） |
| **3** | `prune=false` 走**新方法 `searchExact()`**（`ivf.ts:1062`，逐行精确）；`prune=true` 是**新默认** | ✅ A7 的落点：`searchExact()` 与 HEAD 的 `search()` 逐位一致（含 `scanned`/顺序）。⚠️ 它不是「剪枝的退化版」，是**一份独立的精确实现**（§5.1.4 的要求：旧路上必须真有流量） | QA 复核：A7 必须**比 `searchExact()` vs 手写 HEAD 参照**，不能比「`pruneTopK` 关掉早停」 |
| **4** | 写路径**没有生产级 `prune` 开关**（只有 `BucketScanOptions.prune`，构造选项只管读路径） | ✅ 符合既定纪律（不加第 61 个 `Params` 键，§5 末）。⚠️ **代价**：写路径今天**只有剪枝形态，没有运行时回退开关** —— 生产要关只能代码回退 | 若运维确需运行时开关 ⇒ 先裁「`params` 三处副本 + `check:params` 的同步成本」由谁承担 |
| **5** | `codesMissing` 用**子接口 + 必填字段**：`RecallVectorRouteInfo extends RecallRouteInfo { codesMissing: number }`（`recall.ts:365`）；**内部** `VectorRouteResult.codesMissing?` 才是可选（`undefined` = 没算） | ✅ 公开契约上**恒在**（消费方不用判 `undefined`）；可选性只留在内部（`withVectorDiagnostics` 才计算 ⇒ 正常召回零成本）。⚠️ 与「给共用 `RecallRouteInfo` 加可选字段」的区别就在这：加可选字段会**污染 `text`/`graph`** | 已预告**加法式破缺**：对 `routes.vector` 做严格相等的断言要改 `toMatchObject`（`recall.ts:1617` 有注释说明） |
| **6** | ★ **精确重排预算（曾名 `MAX_EXACT_RESCORE = 64`，两条路共用）：用尽后「撤回剪枝」⇒ 剩余行逐行精确（结果不变、IO 退化成全扫）** | ✅ **正确性无影响**（`upper` 是上界 ⇒ 比第 K 名差的行进不了堆 ⇒ 结果集相同；`prune.test.ts` 有「结果与全量精确参照逐位相同」的用例）。<br>⚠️ ★ **但读路径的收益会归零**：读路径 `k = 60` ⇒ 堆要 60 次精确读才满，而预算只有 64 ⇒ **只剩 4 次早停机会**；一旦这 4 次没停住，预算锁死 ⇒ **扫完整个桶**（还额外多读了约 5,521 行码）⇒ 读路径反而**比 HEAD 慢**。<br>⚠️ 叠加 `scoreFloor=0`：第 K 名是 0 分的弱查询本来就永不早停 ⇒ 两条叠加后**读路径大概率不剪枝** | ✅ **已裁并已修（T04 收尾 · 2026-11-05）**：见 §5.1.12 —— 预算做成**选项**，写路径显式传 64、**读路径不传**（无预算）。实测（300 行夹具 / `k = 60`）：读路径 `exactReads` **67**（> 64，早停照常工作）；把 64 硬塞回读路径 ⇒ **300**（= 扫完整个桶，剪枝归零） |

> ⚠️ **诚实记（我上一轮写错、实现继承了它）**：§5.1.1 原稿写「写路径用 `cosineOf()`（**未钳制**）」—— **错**：
> `cosineOf()` 在 `dedupCandidates.ts:216-218` 就 `return clampCos(cosine)`，**两条路都钳进 `[0,1]`**（HEAD 起就是这样）。
> 这个错字被抄进了 `src/vector/prune.ts` 的文件头注释（第 17 行）。
> ⇒ **代码注释里那一句建议顺手改掉**（不影响行为，但它是「两套口径」这个论断的**依据**，写反了会让下一个人以为写路径真的没钳制）。
> ⇒ 也正是这个错，让「`upper` 是不是结果键的上界」这个问题一开始没被问出来（§1 / ADR §8.3.1 的洞）。

### 5.1.12 ✅ **已裁（2026-11-05 · T04 收尾）**：`PruneOptions.exactRescoreBudget?: number`

**裁决：选项 (a)**，两处措辞与本文最初的草案不同（都是刻意的）：

| 项 | 裁决 |
|---|---|
| 缺省值 | **`undefined` = 无预算**（⚠️ **不是 `Infinity`**：「不传」与「传 `Infinity`」表达同一件事 ⇒ 两种写法必然漂移；校验只接受「有限非负整数」或 `undefined`，`Infinity` 被**拒**） |
| 写路径 | `scanBucketCandidates()` **显式传** `WRITE_EXACT_RESCORE_BUDGET`（= 64） |
| 读路径 | `search()` **不传**（无预算） |

**实测（同一 300 行夹具、`k = VECTOR_TOPK × 3 = 60`、探针吃满 12 个细桶）**：

| 路 | 预算 | `exactReads` |
|---|---|---|
| 写路径 | 64 | **1**（`DEDUP_COS_MIN` 的上界门槛先剪掉了，预算根本碰不到） |
| 读路径（现行） | 无 | **67**（> 64 ⇒ 早停真的在 64 之后发生过一次） |
| 读路径（把 64 硬塞回去的变异） | 64 | **300** = `scanned`（**剪枝归零**：预算用尽后逐行精确） |

⇒ 原始问题（「读路径 4 次早停机会」）**已消失**；`prune.test.ts` 另有一条单测专门钉
「不传 ⇒ 早停可以撑到 64 之后才停 / 传 64 ⇒ 同一夹具扫完」，以及「`Infinity` 被拒」。

**原始讨论（保留）**：两条路曾共用一个模块常量，读路径 `k = 60` ⇒ 只剩 4 次早停机会 ⇒ 形同不剪枝。

| 路 | `k` | 预算 64 − k = 早停机会 | 后果 |
|---|---|---|---|
| 写路径 | `VECTOR_TOPK` = 20 | **44** | 可用（正常早停只付 ~20 次） |
| 读路径 | `VECTOR_TOPK × 3` = **60** | **4** | ★ **形同不剪枝**（4 次没停住 ⇒ 锁死 ⇒ 全扫） |

**三个选项**（我倾向 (a)）：

| # | 改法 | 代价 |
|---|---|---|
| **(a)** | `PruneOptions.exactRescoreBudget?: number`（缺省 `Infinity`）；**写路径显式传 64**、读路径不传 | 契约多一个键（不是 `Params`，不受 61 项门禁约束）；`prune.test.ts` 已有用例要改成「显式传 64 时结果不变」 |
| (b) | 预算改成 `k * 3` | 读路径 180 次仍可能锁死；且「3 倍」这个数没有依据（写路径的 64 也不是 3 倍） |
| (c) | 直接删掉这个保险丝 | 循环本来就受 `candidates` 上界约束，**不存在无上限循环** ⇒ 保险丝不是必需的；删掉后「码坏了」只会表现为 `exactReads` 高（读数已经在） |

⚠️ **为什么现在必须定**：T06 要在 1M 库上采 `bytesRead` 与剪枝率（出关条件①）。若带着这个 64 去采，
**读路径的读数会是「不剪枝」的数** —— 那等于用一次昂贵采集去测一个「我们其实还没实现」的功能。

---

## §6 验收断言（**这是本档的核心交付物，比代码重要**）

| # | 断言 | 为什么它必须存在 |
|---|---|---|
| **A1** | **写路径等价**：300 行的夹具上批量比对，`prune=true` 与 `prune=false` 的候选 id 序列**逐位相同** | 「可证剪枝」的全部价值都在这条；它一旦不成立，②(a) 的裁决就被违反了 |
| **A2** | **读路径等价**：≥50 条查询（含「带时间窗」与「不带」两类 filter），`search()` 返回的 `(id, score)` **逐位相同** | 同上；且 `score` 逐位相同才能保证 `fuseScore` 下游不变 |
| **A3** | **上界可靠性**：随机 `1e5` 对（查询, 行），断言 `cos_true ≤ approx + eps` **无一例外**（用 `assert` 而不是统计） | 上界破了 = 剪枝开始丢行 = 静默漏检。**这是唯一能防住「偶发漏检」的断言** |
| **A4** | **`eps` 是真误差**：对 1,000 行，`\|cos_true − approx\| ≤ eps` 且 `eps` 与实算误差之差 `< 1e-5` | 防「eps 写成估算上界」导致剪枝率虚低（A4 不红但收益消失） |
| **A5** | **字节读数**：`bytesRead ≤ 6,144,000`（H1′），且四个读数**并列落盘** | H1′ 的判定本身；并列是为了防「绿得没道理」 |
| **A6** | **三表一致性（★ 在「活记忆域」内）**：`vector_codes` / `vector_cell_members` / `memories` 三个数**都先过 `deleted = 0`** 再比；`lonelyCodes` / `fineIdDrift` 也**只在活记忆域内**判；换桶后 `fine_id` **集合相等** | 双表一致性是本设计**唯一新增的漂移面**（`vector_cell_members` 与 `vector_codes` 各存一份 `fine_id`）。★ **「在哪个域内一致」不是废话**：不写域 ⇒ A6 会把「软删机制在工作」报成「码表坏了」（R11） |
| **A7** | **零影响**：`prune=false` ⇒ 与 HEAD 的行为**逐位一致**（含 `scanned` 计数） | 保证「新路径可关」不是一句空话 |
| **A8** | **无码兜底**：删掉若干行的码（模拟回填未完成）⇒ 结果与「全码」时**完全相同** | 回填可以分批上线的前提 |

> ★ **「逐位相同」的确切含义**（本表里 A1/A2/A7/A8 四条都是这个意思，**不是集合相等**）：
> · A1：`candidates[].id` **序列** + `cos`（`Object.is`）+ `scanned`，三者 `prune=true` 与 `prune=false` 逐位相同；
> · A2：`search()` 返回的 `{id, score}` **数组（含顺序）**逐位相同，`score` **禁止 `toBeCloseTo`**；
> · A7：`prune=false` 与 **HEAD 的 SQL + 循环**（手写参照）逐位一致，含 `scanned`；
> · A8：删码后与「全码」逐位相同。
> ⇒ 逐条的**测试落点 / 夹具规模 / 是否需要 1M 库**见 **§5.1.8**（结论：四条**都不需要** 1M 库）。

#### ★ A6 的口径定义（R11 已裁 · 2026-11-05）

**A6 判的是「码表与桶表在*活记忆域*里对不对齐」**，三个数**同一个域**：

```sql
codes    = count(vector_codes vc        JOIN memories m ON m.id = vc.memory_id  WHERE m.deleted = 0)
members  = count(vector_cell_members vcm JOIN memories m ON m.id = vcm.memory_id WHERE m.deleted = 0)
memories = count(memories WHERE deleted = 0 AND embedding IS NOT NULL)          -- 不动
lonelyCodes / fineIdDrift 同样 JOIN memories 且 m.deleted = 0
```
⇒ 实现见 `scripts/backfill-codes.ts` 的 `snapshotConsistency()`（R11 已落地）。

**为什么必须是「活记忆域」**（改前的三个数各说各话）：

| 数 | 改前口径 | 不相容之处 |
|---|---|---|
| `codes` | `count(vector_codes)` | 回填**只扫活行**（`SCAN_SQL` 的 `WHERE m.deleted = 0`，`backfill-codes.ts:437`）⇒ 只有活行有码 |
| `members` | `count(vector_cell_members)` | ★ **含软删行的归属** —— `forget.ts:65` 只改 `deleted = 1`，**不调 `unassignBucket`**（§9.3.2 ②：`restore()` 要能把它放回向量路） |
| `memories` | `... WHERE deleted = 0 ...` | 只有活行 |

⇒ 库里只要有一条「软删 + 有向量 + 有桶归属」的记忆 ⇒ `members > codes` ⇒ **A6 恒红**，
而它红得**没有信息量**（报的是「软删机制在工作」，不是「码表坏了」）。

⚠️ **禁止的修法**：为让 A6 绿去**删掉软删行的桶归属 / 码行** —— 那会破「软删可恢复」
（`restore()` 之后这条记忆**永久进不了向量路**，静默、永久）。
**该改的是读数口径，不是数据。**

⚠️ **一句要写进注释的话**：**软删行的 `fine_id` 漂移不计入 A6 —— 这是刻意的，因为软删行不参与检索**
（`search()` 的候选宇宙是 `deleted = 0`）⇒ 它漂不漂移不影响任何召回结果，只影响「恢复后是否还落在对的桶里」，
而那由 `restore()` + 启动对账负责。

⚠️ **A6 与 T04 的 `scanned` 是两件事，别合并**：A6 在活记忆域里查「对齐」；
`scanned` 数**成员行**（含软删）⇒ 它会偏大（§5.1.3 偏离 #1）。

---

## §7 风险登记 + 出关条件

| # | 风险 | 处置 |
|---|---|---|
| **R1** | 浮点求和顺序打破上界（A3 偶发红） | `eps` 落库前 `+1e-6`；A3 用 1e5 样本 |
| **R2** | **剪枝率未测** ⇒ `bytesRead` 可能达不到预估的 ≈4.8MB（订正后，见 §5.1.2 的预算复算） | 出关条件①：1M 实测 **`bytesRead.max` ≤ 6,144,000 B**（= 原 2,000 行 × 3,072 B；**判定取 `max`**；**只计向量载荷** = 码 BLOB + embedding BLOB 的实测 `byteLength` ⇒ 是真实搬运量的**下界** ⇒ 判据偏严、不会假绿）**且** 剪枝率 **≤ 15%**（分母 = `candidateUniverse`；★ 分子 = **`embeddingCalls`（bench 侧 `get()` 调用次数）= 定义上等于 `prune` 的 `exactReads`** ⇒ ⚠️ **不许用「返回行数」**——偏小 = 偏松 = 假绿；口径见 §5.1.10 与 `docs/design/perf-c2-t06-byte-metering.md` §1.7）<br>✅ 2026-11-05 实测（1M · 热档 · HDD）：`bytesRead.max` = **4,065,792 B**（≤ 6,144,000 B ⇒ **绿**，余量 33.8%）；剪枝率 = **3.70%**（≤ 15% ⇒ **绿**，分子 = `embeddingCalls`、白调用 = 0）；候选宇宙 max = **5,286 行** ⇒ 破点 7,838/7,960 **未触及**（余量 1.48×/1.51×）；前提未违例（`unclassifiedRows`=0、`badCodeRows`=0、`samplesAligned`=true）⇒ ⇒ **出关条件① 达成**（★ 毫秒参考线 4 条红是介质/机器所致） |
| **R3** | **码宽未选**：int8（768B）只到约 8~14 倍，瓶颈从 IO 转到 CPU；更窄的码（PQ/二值）`eps` 更大 ⇒ 剪枝率更差 | 出关条件②：先出「码宽 ↔ ε ↔ 剪枝率 ↔ 延迟」四列表（这是选码宽的唯一依据，**不许拍脑袋**） |
| **R4** | 重编码时长未测 | 出关条件③：1M 重编码实测 < 5 分钟（否则重训反馈环从 111 分钟变成 ≈116 分钟） |
| **R5** | 存储 +784 MB | 已知、接受（`memories.embedding` 的 3 GB 仍在，暂不删 —— 删了就产生不可逆点） |
| **R6** | 双表一致性（码表 vs 桶表） | A6 + 「同事务写」；`bucketAssign` 已是 delete+insert 形状，码行跟着搬 |
| **R7** | 中位延迟变好但**尾延迟**变差（survivors 分布的长尾） | 出关条件④：报告 `bytesRead` 与 `survivors` 的 p50/**p99/max**，不只看 mean<br>✅ **2026-11-05 实测（1M · 热档 · HDD · 200 样本 · 落盘 JSON `.tmp/bench/t07-warm.json`）**：<br>⚠️ ★★★ **【口径订正 · 2026-11-05 · 源码级】`embeddingExactRows` 【不是】survivors** ⇒ ⇒ 它是「**精确分**（`scoreOf` 的逐条 `get()`）**返回了行**的次数」⇒ ⇒ ★ **survivors（Q4/Q5 的整行 survivors）逐样本 = `embeddingRowsRead` − `embeddingExactRows`** ⇒ ⇒ ★ **源码出处（★ 口径的权威出处是【源码】、不是文档）**：`bench/lib/byteSources.ts:37-38`（`exactEmbedding` = 逐条精确分）· `:39-40`（`survivorRow` = 整行 survivors）· `bench/lib/harness.ts:1228-1229`（`embeddingExactRows = state.rows`（`exactEmbedding` 来源）· `embeddingCalls = state.calls`）· `bench/lib/harness.ts:1085`（★ 「返回行数 ≠ 调用次数」的机制：无 `embedding` 的行**不计入 rows、但仍计 calls**）· `bench/perf.ts:1675`（落盘值 = 快照差值）· `bench/perf.ts:1873`（分布 = `toCountSummary(...)`）⇒ ⇒ ★ ⇒ **逐样本联合分布未落盘 ⇒ ⇒ `survivors` 的【精确 p50/p99/max】不可从 JSON 复算**（⇒ ⇒ 下面只给**可复算**的部分）<br>· ★ **写路径**（`writeSegments.vectorByteReads`）：`bytesRead` **p50 = 1,549,824 B / p99 = 3,998,976 B / max = 4,065,792 B**（mean 1,623,229.44 B）⇒ ⇒ ★ **精确分返回行数**（`breakdown.embeddingExactRows`）**p50 = 1 / p99 = 1 / max = 1**（mean 0.545）⇒ ⇒ ⇒ ★ ⇒ ★★ **精确分返回行数【没有长尾】**（三个分位全等 1）⇒ ⇒ ⇒ ★ ⇒ ⇒ 该分布是**二值**的（**54.5% 的样本 = 1、45.5% = 0**）⇒ ⇒ ★ ⇒ **这正是「不只看 mean」的最好例证**：mean 0.545 看着像「平均半条」，真相是「**每次扫描要么 0 条、要么 1 条**」⇒ ⇒ ⇒ ⇒ ★ ⇒ ★ **survivors（写路径）**：★ **均值可复算 = 1.09 − 0.545 = 0.545**；★ **逐样本分布未落盘 ⇒ ⇒ p50/p99/max 不可复算** ⇒ ⇒ ★ ⇒ ⇒ **上界 max ≤ 2**（`survivors ≤ embeddingRowsRead ≤ 2`）⇒ ⇒ ⇒ ⇒ ⇒ ★ ⇒ ⇒ **⇒ 写路径的「survivors 有无长尾」【既未证实、也未证伪】⇒ ⇒ ⇒ 不许下结论**（★ ⇒ ⇒ ★ **且不许拿「精确分无长尾」当「survivors 无长尾」的证据** ⇒ ⇒ ⇒ **那是【两个量】**）⇒ ⇒ ⇒<br>· ★ **读路径**（顶层 `vectorRouteByteReads`）：`bytesRead` **p50 = 2,586,624 B / p99 = 6,273,024 B / max = 7,233,792 B**（mean 2,743,833.6 B）⇒ ⇒ ★ **精确分返回行数** **p50 = 42 / p99 = 57 / max = 85**（mean 42.475）⇒ ⇒ ★ **有分位差**（**max/p50 = 2.02×**、p99/p50 = 1.36×）⇒ ⇒ ⇒ ★ ⇒ ★★ **survivors（读路径）= 0（精确）**：★ 读路径无 Q4/Q5 ⇒ ⇒ `embeddingRowsRead` 与 `embeddingExactRows` **逐位相等**（42 / 42.475 / 42 / 57 / 85 完全一致）⇒ ⇒ ⇒ 逐样本差 = **0** ⇒ ⇒ ⇒ ⇒ **⇒ 「survivors 分布的长尾」在【读路径】上【不成立】**（恒 0）⇒ ⇒ ⇒<br>· ★★★ **⇒ 结论（★ 已按源码口径订正）**：★ **R7 的【现象】（中位好、尾差）在两条路径的延迟上都成立**（写路径 `writeLatency` p99/p50 = 1800.45/306.57 = **5.9×**；读路径 `recallLatency` p99/p50 = 1150.00/70.71 = **16.3×**）⇒ ⇒ ★★ **但 R7 括号里那个【归因（survivors 分布的长尾）】：读路径【被证伪】**（survivors 恒 0）、**写路径【无证据】**（逐样本联合分布未落盘 ⇒ ⇒ 既未证实也未证伪）⇒ ⇒ ⇒ ⇒ ⇒ ★ ⇒ **⇒ ⇒ 那个「中位好、尾差」的成因【尚未定位】⇒ ⇒ ⇒ ★ ⇒ ⇒ 【不许把它记到 survivors 头上】**（★ 读路径那个分位差 42/57/85 属于【**精确分返回行数**】、**不属于** survivors）⇒ ⇒ ⇒ ⇒ ★ ⇒ ⇒ **⇒ 出关条件④ 达成（带限定：① 两路径的 `bytesRead` p50/p99/max 已报；② `survivors` 的分位已报 —— 读路径恒 0、写路径【不可复算】⇒ ⇒ **两边都没有【可证成的】长尾**；③ ⇒ ⇒ 「尾差成因」这一问【仍未答】、不许记到 survivors 头上）** ⇒ ⇒ ★ ⚠️ **读路径的字节数不判门槛**（① §4 盲区登记：读路径 `bytesRead.max` = 7,233,792 B 已超 H1′ 门槛、而 H1′ **只判写路径** ⇒ ⇒ 读路径这三个数**只作观测值**、不是红绿依据）⇒ ⇒ ★ 口径与恒等式见 `docs/design/perf-c2-t06-byte-metering.md`（§1.7 / §4 盲区登记 / §6.12 留痕 B） |
| **R8** | ★ **`embedding` 被改而码没重编 ⇒ 上界在代数上不再成立**（`eps` 是「旧向量」的误差）⇒ 剪枝会**真的漏召回**，而且**任何 SQL 自检都查不出**（码表与桶表可以对得整整齐齐） | ✅ **已裁（B 档）**，施工口径见 **§7.1**。一句话：**不建触发器**；把码行的维护点收进 `assignBucket` / `unassignBucket`（T05）⇒ 6 个调用点零改动全覆盖；用**静态门禁**（`check:bucket-write` 扩表）+ **运行时计数**（`codesMissing`，§5.1.9）代替触发器。<br>⚠️ **现状订正（2026-11-05 实测，见 §7.1.1）**：`grep "SET embedding" src/` **并非空** —— 今天有 **2 条**合法写 `embedding` 的路径（`merge.ts:253` 的 `NULL → 有值`，`updateContent.ts:73-78` 的 `有值 → 另一个值`）。<br>⇒ 坏消息：设计稿原以为「有值→另一个值」不存在，**它存在且已在生产**；<br>⇒ 好消息：**两条都在同一事务里紧跟 `assignBucket`/`unassignBucket`** ⇒ 维护点仍然只有一个地方。 |
| **R9** | ★ **换桶不同步码行 ⇒ T04 静默漏召回**（`fine_id` 留在旧桶 ⇒ 按桶取码取不到） | ✅ **已关闭（T05 · 2026-11-04）**：`assignBucket()` 在同一事务里重编码 + 搬码 ⇒ 换桶与码行**不可能**分开。<br>检测手段（T03 落地、仍然保留）：`snapshotConsistency()` 数 `lonelyCodes` 与 `fineIdDrift`，A6 = `mismatch===0 && lonelyCodes===0 && fineIdDrift===0`，不一致**非零退出**。<br>⚠️ 曾实测抓到过一次假绿：`--force` 走 `INSERT OR REPLACE` 而 `members.fine_id` 已被改 ⇒ 码行留在旧桶，**当时自检 exit 0 并打印「码表 == 桶表」**。 |
| **R10** | `INSERT OR REPLACE` 在 `vector_cell_members` 上触发 `memories` 的 `ON DELETE CASCADE`（REPLACE = delete + insert）⇒ **误用 REPLACE 会静默删掉码行与桶归属** | 既有行为，不是本档引入。**已实测**（QA 造夹具时踩到：6 行 → 0 行）。⇒ 纪律：**改桶只能用 `UPDATE` 或「先 DELETE 再 INSERT」的显式形状**（`bucketAssign` 就是这么写的），**禁止** `INSERT OR REPLACE`。 |
| **R11** | ★ **A6 的行数口径与「软删保留桶归属」这条既有裁决不相容**：A6 第三项是 `memories(deleted = 0 AND embedding IS NOT NULL)`，而**软删行保留桶归属**（§9.3.2 ②，`forget.ts:65` 只改 `deleted = 1`、**不调 `unassignBucket`**）、又**永远不会被回填**（`backfill-codes.ts` 的 `SCAN_SQL` 带 `WHERE m.deleted = 0`，`:437`）⇒ 只要库里有 ≥1 条「软删 + 有向量 + 有桶归属」的记忆，`members > codes` ⇒ **A6 恒红，且红得没有信息量** | ✅ **已裁（2026-11-05）：三个数统一到「活记忆域」** —— `codes` / `members` 都 `JOIN memories` 加 `deleted = 0`，`lonelyCodes` / `fineIdDrift` 同域判定；**禁止**为让 A6 绿去删软删行的桶归属/码行（会破「软删可恢复」）。口径定义见 **§6 的「A6 的口径定义」**，实现已在 `snapshotConsistency()` 落地。<br>⚠️ **残留（T04 侧，不属 A6）**：`scanned` 数成员行、含软删 ⇒ 与 A6 的「同源偏差」仍在 ⇒ 归 §5.1.3 的 A1' 负控管。 |

> ⚠️ **★ 2026-11-04 09:2x 全量重采后的基线订正（只改「倍数」，不改「方向」）**：
> 本档所有收益估算原先按 `perRowReadCostUs = 35.491 µs/行`（`unknown` 档）推出；
> 同介质同档两次重采后是 **16.034 / 16.005 µs/行**（`docs/baseline/perf-1000000-vector-wired-nvme-warm.json`）⇒
> ⇒ **当前要压的那一段变小了**：写路径向量扫描段 mean 从 **39.12 ms** 降到 **27.534 / 29.739 ms**；
> ⇒ ⇒ 所以「改善 8~14 倍」要改读成 **「把 27~30 ms 压到个位数毫秒」**（倍数 ≈ 3~10，取决于剪枝率，**未测**）；
> ⇒ ⚠️ **`H1′ ≤ 6,144,000 B` 的预算与结论完全不变**（字节口径与单价无关）⇒ **出关条件① 一个字不用改**。

---

## §7.1 R8 施工口径（**B 档 · 已裁决 2026-11-05**）

> **裁决**：**允许改 `embedding`，但只允许经「同事务重编」的入口；不建数据库触发器；用运行时计数代替触发器。**
> 本节是 R8 那一行的展开。**它同时是 T05 的接口契约来源**（码行的维护点在哪、怎么保证不漏）。

### 7.1.1 事实层（2026-11-05 自己复核过，**订正原稿**）

| # | 事实 | 出处（行号已核） |
|---|---|---|
| ① | **`merge.ts:253` 的补写**：`UPDATE memories SET embedding = @embedding WHERE id = @id AND embedding IS NULL` | `src/store/merge.ts:253`（函数 `backfillEmbeddingIfMissing`，`:244-256`） |
| ② | 它由 `write.ts` 的「完全重复」分支调用，**紧跟着**同事务入桶 | `src/store/write.ts:765`（调用）、`:775`（`assignBucket`，且 `:774` 的 `if` 只在 `embeddingAdded === 1` 时才进） |
| ③ | ★ **原稿说「有值 → 另一个值不存在」是错的**：`updateContent()` 用**无 `IS NULL` 守卫**的 UPDATE 就地换 `embedding` | `src/store/updateContent.ts:73-78`（`UPDATE_CONTENT_SQL`，`:170-176` 执行）；`:159` 决定用新向量还是 `NULL`；`:179-183` **同事务**调 `unassignBucket` / `assignBucket` |
| ④ | **桶归属的写入只有一个地方**，且**有静态门禁守着** | `src/vector/bucketAssign.ts:169-173`（`assignBucket`）、`:216`（`unassignBucket`）；`scripts/check-bucket-write.ts:40` 的 `ALLOWED_BUCKET_WRITE_FILES` 写死为 `['vector/bucketAssign.ts']`；门禁在 `pnpm verify` 里（`package.json:40`） |
| ⑤ | 这两个函数一共被 **6 处生产代码**调用 ⇒ 「收进它们」= 6 处零改动全覆盖 | `merge.ts:343,345` · `updateContent.ts:180,182` · `write.ts:775,928,930` · `rebuild.ts:228,245` · `reconcile.ts:251,255` |
| ⑥ | `assignBucket` **在算不出桶时提前返回**（`fineId === null`），**在 DELETE 旧归属之前** | `src/vector/bucketAssign.ts:158-163`（早退） vs `:169`（DELETE） |
| ⑦ | 软删**保留** `embedding` 与桶归属（只改 `deleted = 1`） | `src/store/forget.ts:65` |
| ⑧ | 回填**只扫活行** ⇒ **码表里只有活行** | `scripts/backfill-codes.ts:429-438`（`SCAN_SQL` 的 `WHERE m.deleted = 0`） |

⇒ ★ **真正的不变量不是「没人改 `embedding`」，而是**：
> **`embedding` 的每一次合法改动，都在同一事务里紧跟一次 `assignBucket` / `unassignBucket`。**
> ⇒ 于是「码行跟着搬」这件事只需要在一个地方做（那两个函数），而**它们本来就是唯一写入点**。

★ 这个订正**没有推翻裁决**，反而让裁决更便宜：原稿以为要新造一个 `updateEmbedding` 入口，
实际今天已经有 2 个合法入口，而且**都已经把向量交到 `assignBucket` 手上了**（它签名里就有 `vector`）。

### 7.1.2 四条约束（B 档的全部内容）

#### ① 唯一允许的「**收敛点**」= `assignBucket` / `unassignBucket`（**不新造 `updateEmbedding`**）

> ★ **用「收敛点」而不是「入口」**：`embedding` 的写入口有 **2 个**（`merge.ts:253`、`updateContent.ts:73-78`），
> 而**桶归属/码行的收敛点只有 1 对函数**。凡是「改向量必然会走到哪里」这个问题，答案必须是**可指向的函数**，
> 否则实现者拿不到可执行的信息。**生产调用点共 6 处，全部经过这两个函数**：
> `write.ts:775` / `:930` · `merge.ts:343` / `:345` · `updateContent.ts:180` / `:182` ·
> `rebuild.ts:228` / `:245` · `reconcile.ts:251` / `:255`（用 `check:bucket-write` 的白名单守着，
> `scripts/check-bucket-write.ts:40`）。

- **今天的两条写向量路径不改**（`merge.ts:253` 那条保持「只在 `IS NULL` 时补」；`updateContent` 保持「不传 => 置 `NULL`」）。
- **码行的维护信号只有一种**：调了 `assignBucket` / `unassignBucket`。
  ⇒ 这两个函数内部：**先 DELETE 该 `memory_id` 的码行，再按传入的 `vector` 重新编码并 INSERT**（与成员行同形，§4.15.5 的「先删再插」）。
- **为什么不新造 `updateEmbedding`**：它是**第 7 个调用点**，而前 6 个已经全在 `assignBucket` 后面排队。
  多加一层 API 只会让「改了 `embedding` 但没调它」成为**新的一种可能**。
- ⚠️ **不这么定会怎样**：如果 T05 改成「在 `write.ts:775` 后面补一句 upsert 码行」，
  那么 `updateContent` / `rebuild` / `reconcile` 三条路**各自再补一句**（或干脆忘掉）⇒
  `code == members` 这件事就变成**4 处手工记账**，而 `check:bucket-write` 只守一张表 ⇒ **守不住**。

#### ② 「补空值」路径**不需要在 `write.ts` 加第二处调用** —— 它已经在那了

> ★ 这一条是**对原任务书的订正**（原任务书要求「`write.ts` 步骤 2 分支必须同时 upsert 码行」）。
> **不要那么做**：`write.ts:775` 已经在同一 `if (embeddingAdded === 1)` 分支里调了 `assignBucket(store.buckets, m.id, ctx.vector)`
> ⇒ 只要 ① 落地，**码行自动被写**。在 `write.ts` 里再写一次 = 开第二个写入点 = R10 那一类事故的温床。

- **硬要求写在这里**：T05 的完成判据包含一条**反向断言** ——
  `grep -c "vector_codes" src/store/write.ts` **必须为 0**（存储层不认识码表）。
- ⚠️ **不这么定会怎样**：在存储层写码行 ⇒ 那一刻起「码由谁维护」有两个答案 ⇒
  `updateContent` 那条路会**漏**（它不走 `write.ts`），而 A6 只在**换正文并换向量**时才红 ⇒
  平时全绿，某天一条记忆的码过期 ⇒ 静默漏召回。

#### ③ **不建触发器**，四条理由

| # | 理由 |
|---|---|
| 1 | **它会打死今天的两条合法路径**：`AFTER UPDATE OF embedding ... RAISE(ABORT)` 会同时拦下 `merge.ts:253` 与 `updateContent.ts:73`。要豁免就得写 `WHEN OLD.embedding IS NOT NULL` 之类 ⇒ **等于在 SQL 里重写一遍业务规则的第二份副本**（而第一份在 TypeScript 里） |
| 2 | **触发器是 schema 的第四份副本**：本仓 DDL 已经在 `schema/001` / `schema/002` / `src/db/schema.sql.ts` / `src/core/schema.ts`（`VECTOR_CODES_SQL`）四处存在，`tests/unit/vector-codes-schema.test.ts` ③ 用「去注释后逐字相等」钉漂移。再加一段触发器 SQL ⇒ **那个测试要么失效、要么变成四向比对**，而它对 `vector_codes` 的漂移防守是本档唯一的一道 |
| 3 | **它是迁移**：存量库要走 `ensureSchema()` 的补建分支，而**只读打开**（`ensureSchemaForMode()` 的只读侧）碰不到它 ⇒ 会出现「有的库有守卫、有的没有，而 `user_version` 一样」⇒ **同一个 schema 版本两种行为** |
| 4 | **它防的那条路今天不存在，且已被设计禁止**：唯一的「改了 `embedding` 又不调 `assignBucket`」的形状是**手工改库**（`sqlite3` 直连）。触发器对「人手工改库」的价值 = 把一个可自愈的漂移（`pnpm codes:backfill --force`）变成**一个打不开的库** |

#### ④ **用运行时计数代替触发器**：`codesMissing`

| 项 | 定死为 |
|---|---|
| **语义** | **一次向量检索里，命中桶内有多少行因为「没有码」而走了精确兜底**（= 本次多读了 3KB 而不是 768B） |
| **形状** | `explain.routes.vector.codesMissing: number`（**恒在**，与既有的 `ran` / `candidates` 并列）。类型上新增子接口 `RecallVectorRouteInfo`，**不给 `RecallRouteInfo` 加可选字段**（理由见 §5.1.9） |
| **实现** | `countUncodedCandidates(db, fineIds)`（`src/vector/ivf.ts` 导出，**表名不外泄**）：`SELECT count(*) FROM vector_cell_members vcm WHERE vcm.fine_id IN (...) AND NOT EXISTS (SELECT 1 FROM vector_codes vc WHERE vc.memory_id = vcm.memory_id)`。**只在 `withBreakdown === true` 时执行** ⇒ 正常召回零成本 |
| **口径** | ⚠️ 它是**上界**：数的是「桶内有成员、无码」的行，**不施加**行级谓词（`excludeIds` / 时间窗 / 软删）。真要精确，得再读一遍 `memories` —— 而 `codesMissing` **不该为了一次诊断去读 5,521 行向量字节**。文档里写「上界」，比写一个「看起来精确」的数诚实 |
| **`> 0` 代表什么** | **码没铺满**（回填未完成 / 某条路径漏了维护）。**不是故障**，是**可见性**。软删成员也会让它 `> 0`（见 R11） |
| **谁该关心** | ① 运维：**回填跑完没有**（终态应为 0，除软删）；② 工程师：**T05 装错了吗**（若 T05 漏了某条路径，`codesMissing` 会随写入**单调上涨**）；③ QA：A8 的运行时伴生读数 —— 删一部分码行之后它必须**立刻**等于删掉的行数 |
| ⚠️ **不许**做成门槛/错误 | 它**不是故障**。做成阈值/告警/抛错 ⇒ 「回填还没跑完的库」直接不可用，而那正是本档要支持的处境（§2「回填可以分批、可以中断」） |

**与两个既有自检的分工（三者查的不是同一件事，别合并）**：

| 自检 | 时机 | 查什么 | 谁的红 |
|---|---|---|---|
| **`codesMissing`**（本条） | **每次查询**（`withBreakdown` 时） | 「**这次检索**有多少行没用上码」（性能事实） | 不红，只是数 |
| **`snapshotConsistency()`**（`scripts/backfill-codes.ts` 的 A6） | **回填 / 自检时**（运维动作） | 「码表与桶表**对不对齐**」（结构事实） | 红 = 退出码 1 |
| **`MemoryStore.verifyIntegrity()`**（阶段 5，`src/tools/verify.ts`） | **常设护栏**（五个数、纯读、快） | 「库整体健康度」 | 红 = 报告 |

⇒ **`codesMissing > 0` 而 A6 全绿是完全可以同时成立的**：A6 查的是「对齐」，`codesMissing` 查的是「多读了多少 3KB」。
把两者混成一个数 ⇒ 「码表脏」和「码表空」这两个**处置完全相反**的状态会打同一个红灯。

### 7.1.3 升级条件（**什么时候该回头加触发器或换方案**）

≥2 条**可观测**的触发条件，**任一条成立就该重开这个裁决**（不是「感觉不对时」）：

| # | 触发条件 | 怎么观测 |
|---|---|---|
| **U1** | **出现「换模型就地重算」的需求**（不重建快照、把 1M 行的 `embedding` 原地换成新模型的输出） | 需求单 / `docs/decisions/` 出现此类决议。⚠️ 这是**唯一**会绕过 `assignBucket` 的合法需求形状：它改向量但**不改桶**（几何变了却不想重训）⇒ 那时 `assignBucket` 的「先删再插」会把它搬去别的桶 ⇒ **必须新造入口**，触发器才有存在理由 |
| **U2** | 代码里出现**不带 `IS NULL` 守卫**的 `UPDATE ... SET embedding`，**且**它不在 `assignBucket` 之前 | 静态扫描：把 `check:bucket-write` 的正则扩一行（见 7.1.4），扫到白名单外的命中即打红。**今天有 2 处**（§7.1.1 ③），都在白名单内 |
| **U3** | T04/T05 上线后 **`codesMissing` 的长尾降不到 0**（稳定状态下 `> 0` 且不随时间收敛） | `explain.routes.vector.codesMissing` 的 p99（**T06 落盘**，不靠人肉看）。⚠️ 先排除软删（R11）再判 |
| **U4** | `assignBucket` 的 `fineId === null` 早退分支真的被触发过（日志里有 `bucket-not-trained` 且库里已有桶） | `store.logger.warn` 的 `reason: 'bucket-not-trained'`（`write.ts:780` / `:935` / `merge.ts:352`）。见 7.1.5 |

### 7.1.4 配套的**静态**守卫（便宜，且是「代替触发器」的另一半）

**把 `check:bucket-write` 的门禁扩成两张表**（零新增脚本、一行正则）：
- `scripts/lib/bucket-write-scan.ts:58-59` 的正则加上 `vector_codes`；
- 白名单**不加文件**（`ALLOWED_BUCKET_WRITE_FILES` 仍是 `['vector/bucketAssign.ts']`）⇒
  `scripts/backfill-codes.ts` 在 `scripts/` 下，`scanSourceTree(srcRoot)` 扫不到 ⇒ **不用改白名单**。
- ⇒ 效果：**任何 `src/` 下的文件（除 `bucketAssign.ts`）写码行 = 门禁红**；而 `bucketAssign.ts` 里
  「码行写入」与「成员行写入」同生同死 ⇒ 「谁维护码」这个问题**在 CI 里只有一个答案**。

⚠️ **不这么定会怎样**：T05 之后 `vector_codes` 的写入点在物理上仍可能散落 4 处（`write` / `merge` / `rebuild` / `reconcile`），
而**没有任何自动化手段**能发现它 ⇒ 与 R8 原稿的处境一样：只能靠人读代码。

### 7.1.5 一个**必须补的洞**：`assignBucket` 的 `fineId === null` 早退

⚠️ **这是本轮复核发现的、B 档自身的一个漏**（原稿与裁决都没提）：

```
bucketAssign.ts:158-163   if (fineId === null) return { assigned: false, ... };   ← 早退
bucketAssign.ts:169-173   DELETE + INSERT 成员行                                  ← 在早退之后
```
⇒ 若模型为空（未训练 / 被清空）时对一条**已有成员 + 已有码**的行调 `assignBucket(新向量)`：
成员行不动、码行不动 ⇒ **`memories.embedding` = 新，`vector_codes.code` = 旧** ⇒
⇒ 上界用旧向量的 `eps` 与旧码算出 ⇒ **不再是上界** ⇒ 剪枝**真的漏召回**，
而 `members` 与 `codes` 的 `fine_id` **完全一致** ⇒ **A6 全绿** ⇒ **R8 的那张脸又回来了**。

**处置（写进 T05 的判据）**：
> `assignBucket` 在 `fineId === null` 的分支里，**必须 DELETE 该 `memory_id` 的码行**（fail-open），并保留既有的 `assigned: false` 返回值。
> `unassignBucket` 同样必须 DELETE 码行。
> ⇒ 语义：**码算不出来 ⇒ 删码 ⇒ 走精确兜底**（§5.1.5）；**绝不允许「留旧码」**。

- 代价：模型为空期间写入的行没有码 ⇒ 下次 `codesMissing > 0` 可见；重训后走 `reconcile`/`rebuild`
  调 `assignBucket`（那时模型非空）⇒ 码自动补回（`reconcile.ts:251` / `rebuild.ts:228` 都传了向量）✓
- ⚠️ **副作用要预告**：该分支删码后 `codes < members` ⇒ **A6 会红**。**这是期望的信号，不要去消掉它**：
  在这种库上「码表缺行」是事实，A6 报出来才对。**不要**为了让它变绿去顺手删成员行 ——
  那会改变 `assigned: false` 的既有语义（§4.15.3「模型为空 ⇒ 向量路整体缺席」≠「把所有行退出桶」），
  并让 `diffBucketMembership().missing` 多出一批假欠账。
- ⚠️ **不这么定会怎样**：这条漏**没有任何读数能发现**（A6 绿、`codesMissing` 为 0、召回不报错），
  它是本档唯一「三个自检同时沉默」的失效形状。

### 7.1.6 别把没做的事写成做了（**事实边界 · 2026-11-05 复核**）

| 说法 | 事实 |
|---|---|
| 「加了 DB 层守卫」 | ❌ **没有**。一条 DDL、一个触发器都没加（`vector_codes` 的 DDL 与 T01 落地时**逐字相同**） |
| 「`updateEmbedding` 已存在」 | ❌ **不存在**，也**不打算加**（7.1.2 ①） |
| 「码行维护已落地」 | ❌ **尚未落地**（T05 未开工）。⇒ 由此产生一条**必须明说的前置条件**，见 §7.1.7 |
| 「`codesMissing` 已可见」 | ✅ **已接线**（T04）：`countUncodedCandidates()`（`ivf.ts:664` 附近）+ `explain.routes.vector.codesMissing`（`recall.ts:365`／`:1624`），**只在 `withBreakdown` 时算** |
| 「`check:bucket-write` 已守码表」 | ❌ **只守 `vector_cell_members`**。扩到 `vector_codes` 是 **T05 的动作**（7.1.4） |
| 「A6 已能报出软删造成的偏差」 | ❌ **不报，也不该报**（R11 已裁）：A6 现在在**活记忆域**内比三个数 ⇒ 软删成员**不计入**。这是刻意的（§6） |
| 「R8 因此关闭」 | ⚠️ **没有关闭**。7.1.2 的四条里只有 ④（运行时计数）落地；①②（收敛点）③（不加触发器）是**纪律**，随 T05 一起验。<br>★ **而在 T05 落地之前，T04 的 `prune` 带着一条前置条件**（§7.1.7） |

### 7.1.7 ★★ T04 的前置条件（**如实写，不许美化**）

> **T05（码行维护）落地之前，`prune` 的正确性依赖「运行期没有人用 `updateContent()` 改向量」。**

**为什么**（`prune.ts` 文件头也写了同一段，两处必须一致）：

| 路径 | 改 `embedding` 吗 | 有没有码 | 对 `prune` 有害吗 |
|---|---|---|---|
| `merge.ts:253`（`NULL → 有值`） | ✅ | 改之前 `embedding` 是 `NULL` ⇒ **本来就没有码** | ❌ **无害**（旧状态没有码可比） |
| `updateContent.ts:73-78`（`有值 → 另一个值`） | ✅ | ★ 码是**旧向量**编的 ⇒ `code`/`scale`/`eps`/`fine_id` **全是旧的** | ✅ **有害**：`upper` 不再是上界 ⇒ **静默漏召回** |

**这条漏的三个自检同时沉默**：
- **A6 查不出来** —— `vector_codes.fine_id` 与 `vector_cell_members.fine_id` **仍然一致**（`assignBucket` 同事务搬了桶）；
- **`codesMissing` 数不出来** —— 它只数「**没码**」，数不出「**码过期**」；
- **召回不报错** —— 少几条结果，条数与分数都「正常」。

**今天的处置（三选一，按优先级）**：
1. **T05 尽快落地**（正解：`assignBucket` / `unassignBucket` 里重编码，§7.1.2 ①）；
2. 用了 `updateContent()` 改向量的宿主 ⇒ **`prune: false`**（读路径构造选项）；
3. 代码回退。

⚠️ **它的量化边界**：只影响「调用过 `updateContent(..., 新向量)` 的那几条记忆」，
不是全库 —— 但那几条**会永久坏着**（直到 `pnpm codes:backfill --force` 重跑一遍）。
⇒ **不许**把它写成「已知限制，影响可忽略」：它影响的是**召回完整性**，而本档的裁决 ② 是「一点不降」。

---

## §8 要同步改的既有文档（漏一处就是文档说谎）

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `DESIGN-v2.md:6292`（ADR-33） | 「桶内是全量精确点积」⇒ 加半句「**结果精确**由可证上界剪枝保证，不要求物理扫完桶内每一行」 |
| 2 | `src/vector/ivf.ts:640` 的注释 | 「⚠️ **桶内不设 LIMIT**」⇒ 补「剪枝不是 `LIMIT`：它跳过的是**可证不会入选**的行，不是『前 N 行』」 |
| 3 | `DEVELOPMENT-PLAN.md` 的 H1/H2 行（约 `:2290-2291`） | 判据量从「行」改成「字节」+ 保留行数作旁证；门槛 `6,144,000 B` / `0.2%` |
| 4 | `docs/progress/vector-round-progress.md` §四.A | A3 一行改指向本文件与 ADR §8 |
| 5 | `DESIGN-v2-errata.md` | 新增一条勘误：ADR-33 的「精确」从「扫完」改为「可证」 |

---

## §9 明确不做

- ❌ **不给桶内 SQL 加 `LIMIT`**（ADR §6 P1：`LIMIT` 是未定序的截断）
- ❌ **不改 H1 的判定方式为 `mean`**（那是放宽 2.6 倍；④ 已裁维持 `max`）
- ❌ **不在「码宽-剪枝率」曲线出来之前定码宽**（R3）
- ❌ **不删 `memories.embedding`**（删了就产生不可逆点：恢复要重算 embedding，而原模型/原文本不一定还在）
- ❌ **不做「近似分淘汰」**（哪怕剪枝率更高）—— 裁决 ②(a) 已经禁了它
- ❌ **不加 DB 触发器 / 不建第二道 DDL 守卫**（R8 · §7.1.2 ③ 四条理由）
- ❌ **不新造 `updateEmbedding` 入口**（R8 · §7.1.2 ①：码行的维护信号只有 `assignBucket`/`unassignBucket`）
- ❌ **不在 `src/store/**` 里出现 `vector_codes`**（码表属于向量层；`write.ts` / `updateContent.ts` 里出现它就是「第二写入点」）
  - ✅ **这条禁令仍然完整成立（2026-11-05 · T04 收尾后复核：`grep -rn "vector_codes" src/store/` = 0 行）**。
  - 修法落地在**向量层**：`src/vector/bucketAssign.ts` 的 `writeCodeRow()` / `clearCodeRows()` 是码表的唯一写入点（与成员行同事务、同一对函数）；`src/store/updateContent.ts` 只**调用** `assignBucket()` / `unassignBucket()`、不出现任何表名。⚠️ **T05 起 `clearCodeRow()` 已删除**（它的职责被 `unassignBucket()` 吸收，且 `assignBucket()` 现在会**重编码**而不是让码过期）。
  - ★ **新增一条静态断言守着这条禁令**：`tests/contracts/table-name-boundary.test.ts`（扫**原文、含注释** ⇒ 在 `src/store/**` 里写一行带码表名的注释也会红）。它与 `pnpm check:bucket-write` 是**两条不同的防线**：后者剥注释、只管「裸写落在哪个文件」，前者管「这一层有没有这个词」——后者抓不到注释里的邀请函，前者抓得到。
- ❌ **不把 `codesMissing` 做成门槛 / 告警 / 抛错**（R8 · §7.1.2 ④：它是可见性，不是故障）
- ❌ **不在 `prune.ts` 里写 SQL、也不在里面算点积/钳制**（§5.1.1 纪律 ②④）
- ❌ **不许省掉 `scoreFloor`**（结果键被 `clampCos` 钳过 ⇒ 裸 `upper` **不是**结果键的上界 ⇒ 静默丢行；§1 / ADR §8.3.1）
- ❌ **不许把精确重排预算（`WRITE_EXACT_RESCORE_BUDGET` / `PruneOptions.exactRescoreBudget`）当成正确性机制**（它是退化下限；读路径**不传**它 = 无预算，见 §5.1.12）
