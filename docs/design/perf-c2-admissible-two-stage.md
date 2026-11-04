# C′ 档设计：两段式 + **可证上界剪枝**（零漏检）

> **归属**：`docs/decisions/adr-perf-recall-vs-h1.md` **§8 裁决**（2026-11-04）的施工落点。
> **一句话**：把「桶内全量精确点积」换成「**先读 768B 的 int8 码算上界，只对可能入选的行读 3KB 原向量精确重排**」，
> 用 Cauchy–Schwarz 给每一行一个**可证上界** ⇒ **结果与全量扫描逐位相同**，而字节量降到 1/4。
> **状态**：**T01 / T02 已落地（2026-11-04）**，其余未开工。
> **验收断言 A1~A8 一条都没跑过之前，本档的收益数字全部是 ⚠️推断。**
> ⚠️ **T01 的落地形状与原计划不同**（更省一步），差异与理由见 §5 的 T01 行注。

---

## §1 为什么是「可证上界」而不是「近似分」

裁决 ② = **不接受漏检率上升（一点不降）** ⇒ 「近似分淘汰」这条路**在语义上就被禁了**：
近似分的误差**方向不确定** ⇒ 必然存在「真实分高于阈值、近似分低于阈值」的行 ⇒ 那就是漏检。

唯一的出路是：**让被跳过的行「可以被证明不会入选」**。

```
cos_true = q·x = q·x̂ + q·(x − x̂) ≤ q·x̂ + ‖q‖·‖x − x̂‖ = q·x̂ + ε     （‖q‖ = 1）
```

⇒ `upper := q·x̂ + ε` 是**上界**，且**可以由码算出**。
- 写路径（阈值语义）：只跳过 `upper < DEDUP_COS_MIN` 的行。
- 读路径（top-K 语义）：按 `upper` 降序精确重排，**剩余 `upper` 最大值 `<` 当前第 K 名精确分** 时停止。

⇒ 两条都**不丢任何一行本可入选的候选** ⇒ 与全量精确扫描**逐位相同**（证明见 ADR §8.3）。

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
堆候选 按 upper 降序
exact = 小顶堆（容量 k，序 = cos 降序、同分 id 升序）
for item in 堆候选:
    if exact.size == k and item.upper < exact.第k名.cos: break   ← ★ 严格小于（同分必须继续）
    x = 读 memories.embedding(item.id)               ← 3,072B/行，只对 survivors
    exact.push({id: item.id, cos: dot(q, x)})
return exact 转数组（cos 降序、同分 id 升序）
```

- **读路径**（`IvfVectorBackend.search()`）：`k = VECTOR_TOPK * VECTOR_OVERFETCH_FACTOR`，阈值 = `null`。
- **写路径**（`scanBucketCandidates()`）：`k = VECTOR_TOPK`，阈值 = `DEDUP_COS_MIN`
  ⇒ 早停条件同样成立（它要的就是 top-K，不是「全部过阈的」）。
  ⚠️ **但 `scanned` 的语义要保住**：它现在是「命中桶内的候选行数」（候选宇宙大小），
  **这个数必须继续等于 `候选` 的长度**（由码行数得出），**不能**变成 survivors 的个数
  —— 否则 R6 与 H1 的历史读数**不可比**，且「候选宇宙有没有变小」这件事变得看不出来。

**精确兜底**：`向量层` 里任何「码行缺失 / `code` 长度 ≠ `EMBED_DIM` / `scale` 或 `eps` 非有限数」的行，
一律**并入 survivors**（当作 `upper = +∞`）⇒ 它会走精确读 ⇒ 迟一步、但**不错**。
⚠️ 这条兜底是 A8 断言的落点，也是「回填未完成时能不能上线」的唯一依据。

---

## §5 任务列表（**7 个任务 / 5~6 轮**，依赖已标）

| # | 任务 | 改哪里 | 依赖 | 完成判据 |
|---|---|---|---|---|
| **T01** | 码表 DDL（**增量表**） | ✅ **已落地**：`schema/001_schema_v2.sql` + `schema/002_migration_v1_to_v2.sql` 各一段（带 `IF NOT EXISTS`）；运行时副本 `src/db/schema.sql.ts` 同步生成；`src/core/schema.ts` 加 `VECTOR_CODES_SQL`；`src/db/migrate.ts` 加 `ensureVectorCodesTable()` 并挂进 `ensureSchema()` 的三个分支 | — | `tests/unit/vector-codes-schema.test.ts` **6 条**：不在指纹表 / 形状对 / 两处 DDL 不漂移 / 存量库可补建 / 幂等 / 只读侧容忍缺表 |
| **T02** | 编码器 + 上界单测 | ✅ **已落地**：`src/vector/quantize.ts`（`encodeVector` / `approxDot` / `upperBound` / `decodeVector` / `codeToBlob` / `blobToCode`）；`tests/unit/quantize.test.ts` **8 条** | — | **A3 / A4 绿**（10 万对零破界；eps 是真误差） |
| **T03** | 回填脚本（分批、可断点） | ✅ **已落地（2026-11-04）**：`scripts/backfill-codes.ts`（`pnpm codes:backfill`）；`tests/integration/backfill-codes.test.ts`（**26 条**） | T01 T02 | 1M 回填完成（**1,000,000 / 73.42s / 库 +944.2 MB**）；**A6** 绿；中断后重跑幂等（`encoded=0`） |
| **T04** | 读取路径两段化 | `src/vector/ivf.ts`（`search()` / `scanBucketCandidates()`）；`src/vector/prune.ts`（新）；`IvfVectorBackendOptions.prune?: boolean`（缺省 `true`） | T01 T02 | **A1 / A2 / A7** 绿（`prune=false` 与 HEAD 逐位一致） |
| **T05** | 写入路径维护码行（同事务） | `src/vector/bucketAssign.ts`（`assignBucket` / `unassignBucket` 里 delete+insert 码行）；`src/store/write.ts` 的调用点 | T01 T02 | **A6** 绿（换桶后 `fine_id` 集合相等） |
| **T06** | bench 计数口径 + H1′ 判据 | `bench/lib/harness.ts:977 classifyReadKind()`（认 `vector_codes`，并**按 SQL 分别累计字节**）；`bench/perf.ts`（落盘 `bytesRead` / `codeRowsRead` / `memoryRowsRead` / `candidateUniverse`；H1′ 判字节） | T04 T05 | **A5** 绿；三读数并列落盘 |
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

## §6 验收断言（**这是本档的核心交付物，比代码重要**）

| # | 断言 | 为什么它必须存在 |
|---|---|---|
| **A1** | **写路径等价**：同一批 500 条写入，`prune=true` 与 `prune=false` 的候选 id 序列**逐位相同** | 「可证剪枝」的全部价值都在这条；它一旦不成立，②(a) 的裁决就被违反了 |
| **A2** | **读路径等价**：1,000 条查询，`search()` 返回的 `(id, score)` **逐位相同** | 同上；且 `score` 逐位相同才能保证 `fuseScore` 下游不变 |
| **A3** | **上界可靠性**：随机 `1e5` 对（查询, 行），断言 `cos_true ≤ approx + eps` **无一例外**（用 `assert` 而不是统计） | 上界破了 = 剪枝开始丢行 = 静默漏检。**这是唯一能防住「偶发漏检」的断言** |
| **A4** | **`eps` 是真误差**：对 1,000 行，`|cos_true − approx| ≤ eps` 且 `eps` 与实算误差之差 `< 1e-5` | 防「eps 写成估算上界」导致剪枝率虚低（A4 不红但收益消失） |
| **A5** | **字节读数**：`bytesRead ≤ 6,144,000`（H1′），且四个读数**并列落盘** | H1′ 的判定本身；并列是为了防「绿得没道理」 |
| **A6** | **三表一致性**：`vector_codes` 行数 == `vector_cell_members` 行数 == `memories(deleted=0 AND embedding IS NOT NULL)` 行数；换桶后 `fine_id` **集合相等** | 双表一致性是本设计**唯一新增的漂移面**（`vector_cell_members` 与 `vector_codes` 各存一份 `fine_id`） |
| **A7** | **零影响**：`prune=false` ⇒ 与 HEAD 的行为**逐位一致**（含 `scanned` 计数） | 保证「新路径可关」不是一句空话 |
| **A8** | **无码兜底**：删掉若干行的码（模拟回填未完成）⇒ 结果与「全码」时**完全相同** | 回填可以分批上线的前提 |

---

## §7 风险登记 + 出关条件

| # | 风险 | 处置 |
|---|---|---|
| **R1** | 浮点求和顺序打破上界（A3 偶发红） | `eps` 落库前 `+1e-6`；A3 用 1e5 样本 |
| **R2** | **剪枝率未测** ⇒ `bytesRead` 可能达不到预估的 4.44MB | 出关条件①：1M 实测 `bytesRead` ≤ 6.14MB **且** 剪枝率（survivors / 候选宇宙）**≤ 15%** |
| **R3** | **码宽未选**：int8（768B）只到约 8~14 倍，瓶颈从 IO 转到 CPU；更窄的码（PQ/二值）`eps` 更大 ⇒ 剪枝率更差 | 出关条件②：先出「码宽 ↔ ε ↔ 剪枝率 ↔ 延迟」四列表（这是选码宽的唯一依据，**不许拍脑袋**） |
| **R4** | 重编码时长未测 | 出关条件③：1M 重编码实测 < 5 分钟（否则重训反馈环从 111 分钟变成 ≈116 分钟） |
| **R5** | 存储 +784 MB | 已知、接受（`memories.embedding` 的 3 GB 仍在，暂不删 —— 删了就产生不可逆点） |
| **R6** | 双表一致性（码表 vs 桶表） | A6 + 「同事务写」；`bucketAssign` 已是 delete+insert 形状，码行跟着搬 |
| **R7** | 中位延迟变好但**尾延迟**变差（survivors 分布的长尾） | 出关条件④：报告 `bytesRead` 与 `survivors` 的 p50/**p99/max**，不只看 mean |
| **R8** | ★ **`embedding` 被改而码没重编 ⇒ 上界在代数上不再成立**（`eps` 是「旧向量」的误差）⇒ 剪枝会**真的漏召回**，而且**任何 SQL 自检都查不出**（码表与桶表可以对得整整齐齐） | ⚠️ **T04 之前必须定**。**现状（实测，2026-11-04）**：`grep "SET embedding" src/` **为空** ⇒ **没有任何生产路径会改 `embedding`** ⇒ 今天这件事只可能由**人手工改库**造成。<br>⚠️ **本轮没有加任何 DB 层守卫**（没加触发器、没加写路径检查）⇒ 一旦将来有人加一条 `updateEmbedding`，码会**静默过期**。<br>⇒ 定策略时二选一：**①** 明文禁止改 `embedding`（要改 = 重编该行码，同事务）；**②** 加触发器 `AFTER UPDATE OF embedding … RAISE(ABORT)` 逼调用方走显式重编接口。<br>⇒ **`--force` 重跑一次回填就能修复整库**（码只由 `embedding` 决定）⇒ 这是本档唯一「坏了也能自愈」的性质。 |
| **R9** | ★ **换桶不同步码行 ⇒ T04 静默漏召回**（`fine_id` 留在旧桶 ⇒ 按桶取码取不到） | ⚠️ **这是 T05 的验收判据**（不是「顺手做的事」）。**T03 已把检测落地**：`snapshotConsistency()` 现在数 `lonelyCodes` 与 `fineIdDrift`，A6 判定 = `mismatch===0 && lonelyCodes===0 && fineIdDrift===0`，不一致**非零退出**。<br>⚠️ **QA 实测把它抓出来过一次**：`--force` 走 `INSERT OR REPLACE`、而 `members.fine_id` 已被改 ⇒ 码行留在旧桶，**而当时的自检 exit 0 并打印「码表 == 桶表」** ⇒ 片上有洞的绿。已修（自检补齐 A6 后半句）。 |
| **R10** | `INSERT OR REPLACE` 在 `vector_cell_members` 上触发 `memories` 的 `ON DELETE CASCADE`（REPLACE = delete + insert）⇒ **误用 REPLACE 会静默删掉码行与桶归属** | 既有行为，不是本档引入。**已实测**（QA 造夹具时踩到：6 行 → 0 行）。⇒ 纪律：**改桶只能用 `UPDATE` 或「先 DELETE 再 INSERT」的显式形状**（`bucketAssign` 就是这么写的），**禁止** `INSERT OR REPLACE`。 |

> ⚠️ **★ 2026-11-04 09:2x 全量重采后的基线订正（只改「倍数」，不改「方向」）**：
> 本档所有收益估算原先按 `perRowReadCostUs = 35.491 µs/行`（`unknown` 档）推出；
> 同介质同档两次重采后是 **16.034 / 16.005 µs/行**（`docs/baseline/perf-1000000-vector-wired-nvme-warm.json`）⇒
> ⇒ **当前要压的那一段变小了**：写路径向量扫描段 mean 从 **39.12 ms** 降到 **27.534 / 29.739 ms**；
> ⇒ ⇒ 所以「改善 8~14 倍」要改读成 **「把 27~30 ms 压到个位数毫秒」**（倍数 ≈ 3~10，取决于剪枝率，**未测**）；
> ⇒ ⚠️ **`H1′ ≤ 6,144,000 B` 的预算与结论完全不变**（字节口径与单价无关）⇒ **出关条件① 一个字不用改**。

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
