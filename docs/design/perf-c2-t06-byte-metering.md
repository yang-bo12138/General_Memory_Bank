# T06 · 字节口径决策备忘（C′ 档 · H1′）—— **唯一权威版本**

> **⚠️ 本文件是 T06 字节口径的【唯一权威版本】。**
> **合并自两份设计（主理人 2026-11-05 裁决）**：① `software-architect-2` 的《字节口径决策备忘》§1~§5；② `software-architect` 的《T06 增量设计 + 二审修正》§6~§12（其中 **§7~§12 = 施工规格，已搬到 ②**）。
> ⇒ **以本文件为准**；两份来源稿的任何后续改动**必须先落到本文件**（否则又是「两套口径并行」）。
> **合并记账**：来源稿 A（architect-2）的独有内容 = §1.3 的「下界 ⇒ 偏严」论证、§1.5 的「两笔」分析（`store.write()` 内部那一笔）、§1.6 的 Q5 订正、§3.1 的 legacy 口径表、§3.3 第 5 条的 `uninstall()` 理由、§4 的容器命名与 note；来源稿 B（architect）的独有内容 = §2 的断言体系、§6 的风险清单、§7~§12 的施工计划（**已搬到 ②**）。**冲突 3 处，已按主理人裁决消解**（见 §6.9 与 §14）。
> **同源旁文件（不是口径来源）**：`docs/design/perf-c2-t06-byte-metering-impl-notes.md` = **工程师的施工记录**（第一段已完成 + 第二段框架）。
>
> **⚠️ T06 口径的唯一权威版本在 ①（本文件）** ⇒ **② `docs/design/perf-c2-t06-byte-metering-spec.md` 是【施工规格】、不是第二权威**（内容 = §7 文件列表 / §8 任务列表 / §9 依赖包 / §10 共享知识 / §12 类图与时序图）⇒ **两处冲突时一律以 ① 为准**；② **不许**在那里维护任何口径（口径一律回 ① 改）。
> **章节索引**：§1 字节算法 · §2 钉死口径的断言 · §3 分类器扩展方案 · §4 落盘结构 · §5 H1′/H2′ 判据处置 · §6 口径与风险（8 条修正 + §6.9 / §6.10 / §6.11 / §6.12 裁决落点）· §11 待明确事项 · §13 待办清单 · §14 合并消解记录。
>
> **版本 / 时间戳**：`v1.0 · 2026-11-05（口径定稿：主理人拍板【写路径两轮制】· 读路径单轮不动 + 6 条定稿裁决全部落定）` ⇒ ★ **口径变更只能回本文件改**；② `…-spec.md` 只放**施工清单与对照视图**，**不许**在那里维护可独立生效的口径句 ⇒ **两处冲突一律以本文件为准**。
> **本文件由 `software-architect` 独家维护**（主理人 2026-11-05 指令：①② 只由一人写；`software-architect-2` 只做只读核查）。

> **身份**：**决策备忘**（口径钉死 + 裁决），不是代码（**施工计划在 ② §8**）。
> **上游**：`docs/decisions/adr-perf-recall-vs-h1.md` §8.5（字节口径裁决）＋ `docs/design/perf-c2-admissible-two-stage.md` §5.1.2 / §5.1.10。
> **下游**：`bench/lib/harness.ts`（取数装置）＋ `bench/lib/byteSources.ts`（**新增** · 字节来源解析）＋ `bench/perf.ts`（落盘 / 判定）＋ `tests/bench/{t06-byte-metering,h1-measurement}.test.ts`（断言）。
> **边界（本轮硬边界 · 主理人裁决 ②）**：**`src/**` 零改动** ⇒ 本轮结束时 `git diff --stat src/` **必须为空** ⇒ 这是一条**可验证的 QA 断言**（见 §2 断言 4 / ② §8 T06-5）；bench 侧**只读观测**；**不加 `Params` 键**（恒 60 项）；**`src/store/**` 不出现 `vector_codes`**；**`src/vector/prune.ts` 不写 SQL**（字节口径**不落**它）。
> **施工顺序**：**② §8**（T06-1 ~ T06-5）。
---

## 1. 字节算法

### 1.1 一行公式（H1′ 判据量）

```
bytesRead = codeBytes + embeddingBytes
  codeBytes      = Σ row.code.byteLength        （Q2 每行码 BLOB 的**实际**字节）
  embeddingBytes = Σ row.embedding.byteLength  （每个物化出 embedding 的行的**实际**字节）
```

* `codeRowsRead` = **Q2**（`readCodes()`）返回的**行数**（每行 1 个 int8 码 BLOB，**健康库下精确 768 B** —— `codeToBlob` 原样拷贝 `Int8Array`，`src/vector/quantize.ts` `codeToBlob()` = `Buffer.from(code.buffer, code.byteOffset, code.byteLength)`）。
* `memoryRowsRead` = **物化的 `memories` 行数**（ADR §8.5 的**「原口径」** ＝ 窄读行 + 带向量的行）。
* `embeddingRowsRead` = **其中带 `embedding` 列的行数**（**字节账的分子**；⚠️ **写路径下它 == `memoryRowsRead`** ⇒ 落盘数字不变，零迁移成本）。

⇒ **写路径与读路径同一条公式**（构成项不同，见 §1.5）⇒ **H1′ = `bytesRead.max ≤ 6,144,000 B`**（= 原 2,000 行 × 3,072 B）；**判定只看 `bytesRead`**。
⇒ ⚠️ **为什么恒等式不用「行数 × 常数」**：`readCodes()` 会**丢弃**长度 ≠ 768 的坏码行（`src/vector/ivf.ts:578-586`：`if (row.code.byteLength !== dimensions) { continue; }`）⇒ **那行已被物化（`code` 列在 SELECT 列表里）、字节已经搬过**，只是**不进码池** ⇒ 「行数 × 768」与实测会差 ⇒ 恒等式必须用**实测 `byteLength` 之和** ⇒ **任何时候都能判绿/判红**；而「`codeBytes === codeRowsRead × 768`」降为**健康库检查**（`badCodeRows === 0` 时成立）。
⇒ ⚠️ **★ 但 `memories` 侧恰好相反**：`scoreOf` 的 SQL 带 `deleted = 0 AND embedding IS NOT NULL`（`src/vector/ivf.ts:1244-1250`）⇒ **软删行被 SQL 条件挡住、返回 `undefined` ⇒ `embedding` 从未被物化 ⇒ 那 3 KB 根本没读** ⇒ ⇒ **「返回行数」与「字节」在 `memories` 侧是一致的**（不像码行那样有「读了又丢」）⇒ ⇒ **坏码行是码侧唯一的「白读」**（读它的字节是白读：fail-open 丢弃 ⇒ 对剪枝毫无贡献）。

### 1.2 逐类 SQL 的字节构成

| 类 | SQL（归一化后） | 位置（逐字原文见下方代码块） | 计入哪个读数 | 向量字节/行 | 进 `bytesRead`？ |
|---|---|---|---|---|---|
| **Q1 成员** | `SELECT fine_id, memory_id FROM vector_cell_members WHERE fine_id = ?` | `ivf.ts:517` | `bucketMemberRows`（旁证） | **0** | ❌ |
| **Q2 码池** | `SELECT vc.memory_id AS id, vc.code AS code, vc.scale AS scale, vc.eps AS eps FROM vector_codes vc WHERE vc.fine_id IN (...)` | `ivf.ts:572-574` | `codeRowsRead` | **768**（实测 `byteLength`） | ✅ |
| **Q3 窄列 gate** | `SELECT id, last_access, pin_factor FROM memories WHERE id IN (...)` | `ivf.ts:620` | `narrowRowsRead`（旁证） | **0**（无 `embedding`） | ❌ |
| **Q4 survivors 整行（写）** | `SELECT m.id AS id, m.content AS content, m.content_tokens AS content_tokens, m.stability AS stability, m.last_access AS last_access, m.access_count AS access_count, m.difficulty AS difficulty, m.embedding AS embedding FROM memories m WHERE m.id IN (...) AND m.deleted = 0 AND m.embedding IS NOT NULL` | `ivf.ts:654-657`（`buildSurvivorSql`） | `memoryRowsRead` | **3,072**（实测） | ✅ |
| **`scoreOf` 逐条** | `SELECT embedding FROM memories WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL` | 读路径 `ivf.ts:1244` / 写路径 `dedupCandidates.ts:310` | `memoryRowsRead` | **3,072**（实测） | ✅ |
| （对照分支 `readCandidateRows` = Q5） | `SELECT id, embedding, last_access, pin_factor FROM memories WHERE id IN (...) AND deleted = 0 AND embedding IS NOT NULL` | `ivf.ts:1401` | `memoryRowsRead` | **3,072** | ✅（本轮 bench 不触发） |
| （对照分支 `buildBucketCandidateSql` = **bucketCandidate**） | `SELECT m.id AS id, m.content AS content, m.content_tokens AS content_tokens, m.stability AS stability, m.last_access AS last_access, m.access_count AS access_count, m.difficulty AS difficulty, m.embedding AS embedding FROM vector_cell_members vcm JOIN memories m ON m.id = vcm.memory_id WHERE vcm.fine_id IN (...) AND m.deleted = 0 AND m.embedding IS NOT NULL` | `ivf.ts:482-497` | `memoryRowsRead` + `bucketMemberRows` | **3,072** | ✅（**仅 `prune = false` 对照分支** ⇒ 本轮 bench **不触发**） |

★ **逐字原文（裁决 5 · 读者会照抄 ⇒ 以本块为准）**：

```sql
-- Q1 成员（ivf.ts:517）
SELECT fine_id, memory_id FROM vector_cell_members WHERE fine_id = ?

-- Q2 码池（ivf.ts:572-574）★ 无 deleted = 0；带 vc. 别名 ⇒ 归一化必须去限定符
SELECT vc.memory_id AS id, vc.code AS code, vc.scale AS scale, vc.eps AS eps
  FROM vector_codes vc WHERE vc.fine_id IN (...)

-- Q3 窄列（ivf.ts:620）★ 无 deleted = 0
SELECT id, last_access, pin_factor FROM memories WHERE id IN (...)

-- Q4 survivors 整行（ivf.ts:654-657 · buildSurvivorSql）★ 跨多行 + m. 前缀 + AS 别名
SELECT m.id AS id, m.content AS content, m.content_tokens AS content_tokens,
       m.stability AS stability, m.last_access AS last_access, m.access_count AS access_count,
       m.difficulty AS difficulty, m.embedding AS embedding
  FROM memories m
 WHERE m.id IN (...)
   AND m.deleted = 0
   AND m.embedding IS NOT NULL

-- scoreOf（读路径 ivf.ts:1244 / 写路径 dedupCandidates.ts:310）
SELECT embedding FROM memories WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL

-- Q5 整行（ivf.ts:1401 · readCandidateRows）★ 4 列（不是 8 列）
SELECT id, embedding, last_access, pin_factor FROM memories
 WHERE id IN (...) AND deleted = 0 AND embedding IS NOT NULL

-- bucketCandidate（ivf.ts:482-497 · buildBucketCandidateSql）★ 仅 prune = false 对照分支
SELECT m.id AS id, m.content AS content, m.content_tokens AS content_tokens,
       m.stability AS stability, m.last_access AS last_access, m.access_count AS access_count,
       m.difficulty AS difficulty, m.embedding AS embedding
  FROM vector_cell_members vcm
  JOIN memories m ON m.id = vcm.memory_id
 WHERE vcm.fine_id IN (...) AND m.deleted = 0 AND m.embedding IS NOT NULL
```

⇒ ★ **归一化三步（必须按这个顺序）**：**① 折叠空白（跨多行 ⇒ 单空格）→ ② 取 `AS` 之前的部分 → ③ 去表限定符（`m.` / `vc.`）** ⇒ ⇒ Q4 / Q5 / bucketCandidate 三条**必须走完三步**才等于登记表里的集合。
⇒ ⚠️ **WHERE 条件不进形状键** ⇒ `deleted = 0` 的有无**不影响判定**；但**原文引用要写对**（读者会照抄）。

⇒ ⚠️ **`memoryRowsRead` 是「物化了几行 `memories`」**：Q3 的 3 列窄读**不带 `embedding`** ⇒ 不贡献字节、但**计入行数** ⇒ **正因如此 Q3 必须能单独认领**，否则窄读被算成向量行 ⇒ §1.1 的字节账当场虚高。
⇒ ⚠️ **一条 SQL 可同时命中多个来源**（字节 = 各来源之和）⇒ 「Q2 若写成 `JOIN memories`」的护栏见 §3.3 第 2 条。
⇒ ★ **Q3 只在读路径发**（`searchPruned()` 里「filter 带时间窗时才发」）⇒ ⇒ **写路径的 legacy `candidateRows` == 本口径的 `memoryRowsRead`** ⇒ ⇒ **断言 1b 的交叉校验在写路径上成立**（工程师第一段实测：写路径一次扫描 `candidateRows` = 20 次精确分 + 20 行 survivors = 40 ✓）。

### 1.3 裁决 A：**正文（`content` / `content_tokens`）不算**

1. **量纲要与旧预算同源**：`6,144,000 B = 2,000 行 × 3,072 B` 约束的是「每次写入搬运多少**向量**字节」（ADR §8.5 理由 1）⇒ 混入正文后与旧预算**不同量纲** ⇒「重声明」变成「另立一个数」。
2. **正文不是向量载荷、且与向量规模无关**（随语料长度任意变化）⇒ 计入它 ⇒ 判据从「向量搬运量」变成「正文长度」⇒ 脱离原意。
3. ★★ **排除它 ⇒ `bytesRead` 是真实搬运量的【下界】⇒ 判据偏严、不会假绿**：真实搬运 ≥ `bytesRead` ⇒ 门槛只会更难过 ⇒ 排除非向量字节**不放松**判据，只让判据更聚焦。
4. ★★ **「逐位等价」只在只数向量载荷时成立**（**这是裁决 A 最硬的一条理由**）：ADR §8.5 理由 3 说「对原本那批读 3 KB 行的实现，两者**逐位等价**（`N 行 ⇔ 3072N 字节`）」⇒ 这个等价**要求一行恰好贡献 3,072 B 的向量载荷** ⇒ 混入正文 ⇒ 字节数依赖正文长度 ⇒ **又变成「假设行长」** ⇒ 与「与实现无关」正面冲突。
5. ⇒ **恒等式成立 ≠ 物理 I/O 相等**：§2 断言 1 是**载荷恒等式**（零容差）；**真实搬运量更大**（正文 + 成员标识 + 窄列标量 + SQLite 行头 / 页开销都没算）⇒ ⇒ **`bytesRead` 是下界** ⇒ 判据**偏严**、**不会假绿**。

⇒ **裁决 A 的延伸（Q1 的答案）**：`vector_cell_members` 的成员标识、Q3 的窄列标量**同样不进 `bytesRead`**（路由 / 过滤元数据，不是向量载荷）。**Q1 若要单列字节**：用**实测 UTF-8 字节数**（`Buffer.byteLength(v,'utf8')`），**不用「声明长度 36」** —— 声明长度是**假设**（id 格式一改就错），实测是事实。⇒ 本轮**只落 `bucketMemberRows`（行数）**，不落字节（省掉每行两次 UTF-8 长度计算 ⇒ 计数器开销 ≈ 0）。
⇒ ★ **「下界差多少」必须可见** ⇒ `breakdown` 里**单列 `contentBytes`**（Q4 的 `content` + `content_tokens` 的 UTF-8 字节）⇒ **只算 Q4 的 ≤ 20 行 ⇒ 便宜** ⇒ 读的人能自己把 `bytesRead + contentBytes` 当作「更接近真实搬运量」的那个数。

### 1.4 裁决 B：**`scoreOf` 的逐条读算**

1. **它是真的从 `memories.embedding` 读走的 3,072 B/行**（当该行通过了 `deleted = 0 AND embedding IS NOT NULL` 时）—— 本次写入 / 召回最贵的一笔搬运；排除它 = 把判据的核心排除掉。
2. **排除它 ⇒ 剪枝失效时会假绿**：剪枝没起作用时 `exactReads ≈ candidates`，但码字节只有 `N × 768`（向量字节的 1/4）⇒ `bytesRead` 看着仍小 ⇒ **正是 ADR §8.5「防绿得没道理」要防的情形**。
3. **它与 ADR §8.6 的预算复算逐项对齐**：§8.6 的 `64 × 3,072 B = 0.20 MB` **就是**这一项（Q4 批量读 survivors）⇒ 不算它，预算复算对不上。

### 1.5 写路径 / 读路径构成式（两者不同）

```
bytesRead_write = codeBytes + embeddingBytes
  ≈ codeRowsRead × 768 + (scoreOfRows + q4Rows) × 3,072
  · Q1(0 B) · Q2(768 B/行) · scoreOf(3,072 B/行) · Q4 survivors 整行(3,072 B/行)
  · ⚠️ 无 Q3（窄列 gate 只在读路径用）· ⚠️ survivors 的 embedding 被读两次（scoreOf + Q4；刻意为之：不缓存 ⇒ 峰值内存只与一条向量成正比）

bytesRead_read = codeBytes + embeddingBytes
  ≈ codeRowsRead × 768 + scoreOfRows × 3,072
  · Q1(0 B) · Q3(0 B，仅 filter 带时间窗时才发) · Q2(768 B/行) · scoreOf(3,072 B/行)
  · ⚠️ 无 Q4 ⇒ survivors 的 embedding 只读一次（省下 k × 3,072 B）
```

⚠️ ★★ **「H1′ 判的是哪一笔」——写路径的字节账其实有【两笔】，不是一笔**：

* **判据量 = bench 的「独立实测段」那一笔**（`bench/perf.ts` 的写入扫描采样循环 ⇒ `writeSegments.vectorByteReads`）⇒ 与旧 H1 的 `vectorCandidateRows` **同一笔**（同探针 8/20、同库、同被考核方）⇒ **H1′ 与 H1 可比**。
* **另一笔 = `store.write()` 内部那一笔**（**真实生产写入**）：已核实 `src/store/write.ts:671`（`findMergeCandidate` 内）→ `collectDedupCandidates()`（`src/store/dedupCandidates.ts:400`）→ `:423` → `collectVectorCandidates()`（`:295`）⇒ **生产写入内部自己就会走向量候选扫描（读码）**。
  ⇒ **那一笔不单独落盘**（它已被 `writeTotal` 的计时覆盖）⇒ ⚠️ **读报表的人必须知道两件事**：
  * **向量字节这一项**：真实写入内部那一笔与 H1′ 判的这一笔**同一量级**（同探针 8/20、同一条扫描逻辑）⇒ 且独立实测段跑在写入循环**之后**（库里已多了 N 条 ⇒ **候选面更大**）⇒ **独立实测段略偏悲观 ⇒ H1′ 偏严** ✅。
  * **但真实写入的「总读取字节」远不止这些**（还有文本路 FTS、合并判定、桶归属等）⇒ **那些字节一次都没被观测** ⇒ ⇒ **H1′ 不是「一次真实写入的总字节预算」**（它只是**向量载荷**这一项的预算）⇒ 若要判那个，**需另设观测点**（§13 第 1 条）。
  ⇒ ⇒ **两笔都在，只有一笔是判据量；另一笔必须被【说明】而不是被【隐藏】** ⇒ 见 §4 的 `note`。

★ **交叉校验（今天成立 ⇒ 断言 1b）**：**写路径里碰 `memories` 的读只有 `scoreOf` 与 Q4 两条**（`collectVectorCandidates` → `readMemberIds` / `readCodes` / `scoreOf` / `buildSurvivorSql`）⇒ ⇒ **legacy 计数器的 `candidateRows` 恰好 == `memoryRowsRead`** ⇒ 写路径可写成 `bytesRead_write = codeRows × 768 + candidateRows × 3,072`。
⚠️ **这是交叉校验、不是定义**：读路径有 Q3（窄读也落进 legacy `candidateRows`）⇒ 读路径**不成立**；且将来写路径若多一条窄列读，这条也会破 ⇒ **定义始终以「向量来源」为准**。

### 1.6 ★ 设计稿 §5.1.2 的 **Q5 行与实现不符** ⇒ 处置：**按实现订正设计稿**（不补 Q5）

**事实**（已核实）：`readCandidateRows()` 的**唯一**调用点是 `searchExactBuckets()`（`src/vector/ivf.ts:1110`，`prune=false` 的**对照分支**）⇒ **生产读路径不发 Q5** ⇒ 读路径 survivors 的 `embedding` 只读一次。
**独立判断：按实现订正设计稿**（在 `perf-c2-admissible-two-stage.md` §5.1.2 的 Q5 行加注「⚠️ 生产读路径不使用；仅 `prune=false` 对照分支用」，**已由 architect-2 落盘**），**不补 Q5**。三条理由：① **补 Q5 是无用 IO** —— 读路径 survivors 已是 `pruneTopK()` 的 `out.survivors`（`{id, score}`）⇒ `searchPruned()` 只要 `id` + `score`（`compareHits` 定序）⇒ **不消费** `embedding` / 正文 / `last_access` / `pin_factor` ⇒ 再发整行读**没有任何下游消费者**，纯白读 `k × 3,072 B`；② **补 Q5 会改动生产读路径的 IO 行为** ⇒ 超出 T06「bench 侧只读观测」的边界，且**让「字节变小」不可信**；③ **设计稿那行是规划期产物** —— T04 落地时实际选了另一条路（`searchPruned` 直接用 `pruneTopK` 的 survivors，`PruneHit` 已带 `score`）⇒ **实现比设计稿新**。
⚠️ 连带订正：ADR §8.6 读路径预估 `4,503 × 768 B + 0.20 MB` 里那 `0.20 MB`（「Q4/Q5 批量读 survivors」）**在读路径上并不存在**；读路径的向量字节只有 `scoreOf` 那一项。（architect-2 已在 ADR §8.6 表后加订正段，**正文数字一个字未改** ✅）

### 1.7 `candidateUniverse` 与剪枝率怎么取

| | 写路径 | 读路径 |
|---|---|---|
| `candidateUniverse` | **`scan.scanned`**（`scanBucketCandidates()` 返回值，生产代码给的精确值，`= memberIds.size`） | `searchPruned()` **不返回** `scanned` ⇒ bench 侧用 `SELECT COUNT(DISTINCT memory_id) FROM vector_cell_members WHERE fine_id IN (...)`（**在计时窗口外**执行 ⇒ 聚合查询本就不计行） |
| 等价前提 | 无（直接是生产返回值） | bench 的 `backend` 是**新建实例** ⇒ `overlay` 空；`backend.search(q, k)` **不带 filter** ⇒ 无 `excludeIds`、无时间窗 ⇒ Q3 不发 ⇒ 该值 **== `memberIds.size`**（逐位）⇒ **前提必须写进 note**（前提一破即不等） |

**剪枝率（出关条件①）= `exactReads ÷ candidates`，门槛 `≤ 15%`**（设计稿 §5.1.10 / §7 出关条件① 的原口径：`exactReads ≤ 0.15 × candidates`）。

★ **分子怎么拿（本轮的关键设计 · 零 `src/**` 改动）**：

* **口径 = `exactReads` = `scoreOf` 的【调用次数】**（`src/vector/prune.ts:289-290`：`exactReads += 1;` 紧接 `const score = scoreOf(item.id);` ⇒ **一一对应、无例外**；`prune.ts` 内**没有第二处** `scoreOf` 调用点）。
* ⇒ **写路径的 `scoreOf` 每次调用恰好一次 `db.prepare(...).get(id)`**（`src/store/dedupCandidates.ts:310-329`：`oneEmbedding` 是**逐条 prepared statement**，每个 `scoreOf` 调用 ⇒ 恰好一次 `get()`）⇒ ⇒ **bench 侧只要数「该 statement 的 `get()` 调用次数」就逐位等于 `exactReads`** ⇒ **零 `src/**` 改动**即可拿到判据分子 ✅。
* ⇒ ⚠️ **方向纪律（防假绿）**：门槛是「**≤ 15%**」⇒ **分子偏小 = 更容易过 = 偏松 = 假绿**。
  * 若用「**返回了行**的调用次数」当分子 ⇒ 它 **≤** `exactReads`（差 = 软删 / 无向量 / 已硬删的行数）⇒ **偏松** ⇒ 最坏情形：命中桶内全是软删成员 ⇒ 返回行数 = 0 ⇒ **剪枝率 0% ⇒ 假绿**。
  * ⇒ **禁止**数「返回行数」⇒ **必须数「调用次数」**（`get()` 被调用就计，**返回 `undefined` 也计**）⇒ bench 的 `get` 包装里必须**无条件** `calls += 1`（⚠️ 现有实现只在 `row !== undefined` 时才计数 ⇒ **必须改**）。
* ⇒ **等价性的守卫（不靠 src · 裁决 2 已确认）**：**在 `tests/unit/prune.test.ts` 补一条显式断言**「`pruneTopK()` 的 `exactReads` === `scoreOf` 的调用次数」⇒ ⇒ **零 src 改动、但守卫仍有牙**（谁改了 `prune.ts` 的计数口径 ⇒ 这条测试立刻红）⇒ ⇒ 于是 bench 侧的 `embeddingCalls` **在定义上**就是 `exactReads`，可直接当判据分子。⚠️ **落点固定在 `tests/unit/prune.test.ts`**（那里已有 `pruneTopK` 的单测夹具）⇒ **不新开文件**。
* ⚠️ **等价性的成立条件（必须写进 note）**：**只在两段式分支（`prune = true`）成立**。**分支 A**（`prune = false` 的对照分支，`src/vector/ivf.ts:746-780`）**不调 `scoreOf`**、改为整行读 ⇒ 那里 `exactReads = rows.length` 而 `get()` 次数 = 0 ⇒ **等价性不成立** ⇒ ⚠️ **本轮 bench 的写路径扫描段走的是两段式分支**（`collectVectorCandidates()` 不传 `prune` ⇒ 默认 `true`）⇒ **不受影响**；读路径的对照分支同理（读路径**不判门槛** ⇒ 无影响）。
* ⇒ **三个数并存、各司其职**：**`embeddingCalls`**（bench 侧数出来的 `get()` **调用次数** = **判据分子**）/ **`embeddingRowsRead`**（物化行数 = **字节账分子**）/ `scan.exactReads`（生产返回值，**本轮不取**——取它需要改 `src/store/dedupCandidates.ts` ⇒ **违反裁决 ② 的零 src 改动** ⇒ 改由上面的等价性单测代偿）。

---

## 2. 钉死口径的断言（零容差，可直接写成测试）

> **断言 1（字节恒等式 · 零容差 · 永远成立）** —— **`bytesRead === codeBytes + embeddingBytes`**，其中 `codeBytes = Σ row.code.byteLength`、`embeddingBytes = Σ row.embedding.byteLength`（写路径与读路径同式，精确相等，零容差）。
> ⇒ **恒等式不依赖「库是健康的」这个前提** ⇒ 任何时候都能判绿/判红。
> ⚠️ **它是「载荷恒等式」，不是「物理 I/O 恒等式」** ⇒ 真实搬运量更大（正文 / 成员标识 / 窄列标量 / SQLite 行头与页开销都没算）⇒ ⇒ **`bytesRead` 是下界** ⇒ 判据**偏严**、**不会假绿**（见 §1.3 裁决 A 理由 3、4）。

> **断言 1a（健康库检查 · 零容差）** —— **`badCodeRows === 0 ⇒ codeBytes === codeRowsRead × 768`**（精确相等）；且 `embeddingBytes === embeddingRowsRead × 3,072`（全部向量 768 维）。
> ⇒ 前提不满足 ⇒ **先报前提违例，不许拿它判绿**。
> ⚠️ **坏码行是「白读」**：它进了 SQL 结果集（`code` 列被 SELECT ⇒ **字节已搬**）却被 `readCodes()` fail-open 丢弃（`ivf.ts:578-586`）⇒ **对剪枝毫无贡献** ⇒ 这类字节是纯浪费，必须被看见。

> **断言 1b（写路径交叉校验 · 零容差）** —— **写路径**：`bytesRead === codeRows × 768 + candidateRows × 3,072`（用 **legacy 计数器**的两个数算，与断言 1 用**新分类**算出的 `codeBytes + embeddingBytes` **必须逐位相等**）⇒ **两条独立路径算出的同一个字节数一致** ⇒ 分类没漏、没多算。
> ⚠️ **前提（三条，破了就报「前提违例」，不许悄悄改数）**：① 写路径**不发 Q3**（⇒ 全部 `memories` 物化行都带 `embedding`）；② `badCodeRows === 0`（否则「行数 × 768」不是实际字节）；③ 软删行被 SQL 的 `deleted = 0` 挡住 ⇒ **不物化 ⇒ 不计字节**（已核实 `ivf.ts:1244-1250`）。
> ⚠️ **只对写路径成立**（读路径有 Q3 ⇒ legacy `candidateRows` 含窄读）；将来写路径若多一条窄列读，这条会破 ⇒ **破了就报「分类口径变了」**。

> **断言 1c（剪枝率分子的口径等价性 · 零容差 · tests 侧）** —— **`pruneTopK()` 的 `exactReads` 必须等于 `scoreOf` 的调用次数**（用计数器数 `scoreOf` 调用 ⇒ 断言 `out.exactReads === calls`）。
> ⇒ **这条让 bench 侧「数 `get()` 调用次数」合法**：bench 的 `embeddingCalls` 与生产的 `exactReads` **定义性相等**（§1.7）⇒ ⇒ 剪枝率分子**不需要改 `src/**` 就能拿** ⇒ ⇒ **裁决 ② 的「零 src 改动」与「剪枝率判据」不冲突** ✅。
> ⇒ ⚠️ **既有测试已经间接钉住一半**：`tests/unit/prune.test.ts:141`「`scoreOf` 返回 `null` 的行仍计入 `exactReads`」⇒ 本条是把它**显式化**（数调用次数、逐条比）。
> ⇒ ⚠️ **等价性只在两段式分支成立**（分支 A 不调 `scoreOf` ⇒ `exactReads = rows.length`）⇒ 断言的夹具必须走**两段式**（`prune` 缺省 true）。
> ⇒ ★ **落点（裁决 2 · 已确认）**：这条单测放在 **`tests/unit/prune.test.ts`**（那里已有 `pruneTopK` 的单测夹具）⇒ **不新开文件**。

> **断言 1c-bench（口径纪律 · 零容差）** —— **`embeddingCalls ≥ embeddingExactRows`**（调用次数 ≥ `scoreOf` 返回行数；软删行存在的库上必须**严格大于**）。
> ⇒ **`embeddingExactRows` = `scoreOf` 返回了行的次数**（**第 13 项**（= 使清单达到 **13** 项的那一项；⚠️ **在 §4 的 JSON 清单里排在第 5 位** ⇒ ⇒ 按【位置】读会读错 ⇒ 会写出 `Object.keys(breakdown)[12] === 'embeddingExactRows'` 这种**必然红**的断言））。
> ⇒ ⚠️ **不许用 `embeddingRowsRead` 当比较对象**：它是**字节账分子**（含 Q4/Q5 的 survivors 整行）⇒ 写路径下**必然大于** `embeddingCalls` ⇒ 用它比对会**恒红**（⇒ ⇒ 口径会写出一条在自己实现上就不成立的断言）。
> ⇒ **读路径下 `embeddingCalls ≥ embeddingRowsRead` 仍成立**（读路径无 Q4 ⇒ 两数同域）⇒ 这条可作为**读路径的加强形式**保留。
> ⇒ 这条专打「把剪枝率分子换成『返回行数』」的变异 ⇒ 那个变异 = **偏松 = 假绿**（§1.7 方向纪律）。

> **断言 1d（样本对齐 · 有牙 · 写路径两轮 + 读路径对账）** —— ⚠️ **【写路径】两轮对齐**：**计量轮（轮 B）与计时轮（轮 A）的 `candidateUniverse` 必须逐样本相等**（两轮用**同一份输入**、跑**同一条生产扫描**）⇒ 证明「计量没有扰动扫描」「两轮看到的是同一批数据」⇒ ⇒ **写路径两轮制下这条才有牙**（同一轮 ⇒ 恒真 ⇒ 没牙 ⇒ 那种做法下**不许**写这条断言）。
> ⇒ ⚠️ **【读路径】本轮单轮 ⇒ 换「有牙的对账量」**（★ 主理人裁决 1 · 2026-11-05）：**读路径 `samplesAligned` :=（逐样本）计数器的实测桶成员行 === 由 `route()` 命中桶推算的成员行之和**（即 `bucketMemberRows`（计数器 · `search()` 侧实测）=== `bucketMemberRowsDerived`（`route()` 侧命中桶的成员数之和；★ **`bucketMemberRowsDerived` 是【样本层】字段（`VectorByteSample` 的成员 · 【不落盘】）⇒ 落盘结构零变化**（★ 主理人裁决 ②：落盘 JSON 里**没有**这个键 ⇒ 「旧键零删除、只新增」完全不受影响 ⇒ ⇒ **不要把它当落盘键**）；⚠️ 它的类型是 `number | null` ⇒ `null` = 没算 ⇒ **不可判定 ⇒ 判红** ⇒ 方向纪律：**宁可误红不可假绿**））⇒ **字段名 / 类型 / 落盘结构一律不动**（仍是 `samplesAligned: boolean`）⇒ ⇒ **不是删一条防线，是把一条假守卫换成真守卫**（删除方案已否决：动静大、且净效果是少一条防线 ⇒ 在「宁严勿松」的方向上不对）。⇒ ★ **该纯函数 `readSamplesAlignedOf()` 已导出**（★ 主理人裁决 ①）⇒ ⇒ **负控测试可直接喂数据**（**不靠间接路径验**）⇒ 这是仓库纪律「**守卫必须能被打红**」的**技术前提** ⇒ ⇒ **本轮恰栽过一次恒真守卫 ⇒ 这条必须留有独立的负控入口**。
> ⇒ ⇒ **为什么这个量「有牙」（三条理由 · 主理人给出，原样登记）**：
> · **① 读路径的 `candidateUniverse` 与字节来自不同的桶**：读路径的 `candidateUniverse` 来自 **`countDistinctMembers(db, route() 的 fineIds)`**（**在计时窗口之外**算的），而字节来自 **`search()` 实际扫的桶** ⇒ 若 `search()` 内部的路由与外层 `route()` 不一致 ⇒ 落盘的 `candidateUniverse` **对应的是另一批桶** ⇒ **读数不可对账** ⇒ 必须判红。
> · **② 两个量同形可比**：两个量都是**「命中桶的成员行总数」**（`readMemberIds` 是逐桶全量读、无 LIMIT；`membersOf` = `countBucketMembers` 是桶计数唯一口径）⇒ **同形可比** ⇒ 不是两个不同量纲在硬比。⇒ ★ **实测**：读路径的「实测桶成员行」与「route 侧推算桶成员行」**逐样本 20/20 逐位相等**（小规模实测）⇒ ⇒ **「同形可比」在实测下成立**；⇒ ★ **已在 1M 档复验**（2026-11-05 · 1M · 热档 · HDD）：读路径 `samplesAligned = true`（★ 逐样本判定 ⇒ **200/200 逐样本相等**）＋ 分布层面 `derivedCrossCheck` 与 `bucketMemberRowsRead` 六个统计量**逐位相等**（count 200 / min 57 / mean 3402.8 / p50 3200 / p99 8000 / max 9251）⇒ ⇒ **可写成「已在 1M 档成立」**。
> · **③ ⚠️ 不能用 `bucketMemberRows === candidateUniverse`**（**读路径**）—— ⇒ ★ **理由不是「`COUNT(DISTINCT)` 会偏小」，而是「两个量【来源不同】」**：`bucketMemberRows` = **计数器实测**（`search()` 侧真正扫的那批桶的成员行数）；读路径的 `candidateUniverse` = **`COUNT(DISTINCT memory_id)`**（**在计时窗口之外**、用**外层 `route()` 的 fineIds** 算的）⇒ ⇒ **两者不是同一批桶的同一个量** ⇒ ⇒ 拿它们互相比对 ⇒ **会把「`search()` 内部的路由 ≠ 外层 `route()` 的路由」这个真正的失配掩盖掉**（那**正是理由① 要抓的东西**）⇒ ⇒ ★ **方向纪律**：两批桶的成员行数**恰好相等**时 ⇒ 互比 ⇒ **假绿**（偏松 = 门禁放行 ⇒ 路由已经跑偏却看不出来）⇒ ⇒ **混用 ⇒ 这条守卫失明** ⇒ ⇒ **不许用这个比较**。
> · ⇒ ⚠️ **本轮新查到的事实（★ 推翻了本条原来的理由）**：`vector_cell_members` 上有**唯一索引** `idx_vcm_memory_unique`（`src/db/schema.sql.ts:352` / `schema/001_schema_v2.sql:335` / `schema/002_migration_v1_to_v2.sql:129`）⇒ **一条记忆只属一个细桶**（schema 注释自称「一条记忆只属一个细桶的最终防线」）⇒ ⇒ **同一批桶内 `COUNT(DISTINCT memory_id)` 恒等于 `COUNT(*)`（= 成员行总数）** ⇒ ⇒ **「一个 memory 落在多个命中桶时会小于成员行总数」这个前提在当前 schema 下【不成立】** ⇒ ⇒ ⚠️ **原理由作废**（★ 留痕见 §11 第 13 条 + §6.12 裁决 9）⇒ ⇒ ★ **但禁令不变**（主因是「异源」，与索引在不在**无关**）⇒ ⇒ ⚠️ **「它可能偏小」只作【防御性】理由保留**（唯一索引是 **schema 级不变式** ⇒ **可被人工 `DROP`** ⇒ 老库迁移前也可能缺 ⇒ ⇒ 那时这条禁令救场）⇒ ⇒ ⚠️ **理由栏不许把它写成当前事实**。
> · ⇒ ★★ **这条禁令的【可验证形态】= 在【接线层】按【来源】验**（★ **不是**在【判定层】按【数值】验）⇒ ⇒ **两层必须分清**：**接线层**问的是「**接线喂了哪一列**？」⇒ ⇒ **能判** ⇒ ⇒ **把两列人为改不同** ⇒ ⇒ 看 `measured` / `derived` 各自取自哪一列；**判定层**问的是「两个数组**数值相等**吗？」⇒ ⇒ **判不出来** ⇒ ⇒ 在真实数据上**恒真** ⇒ ⇒ **恒绿 ⇒ 打不红** ⇒ ⇒ ⇒ **守卫必须长在【接线层】**。
> · ⇒ ⇒ ⚠️ **为什么判定层判不出来**：唯一索引 ⇒ 一条记忆只属一个细桶 ⇒ ⇒ 同一批桶内 `COUNT(DISTINCT memory_id)` **恒等于** `COUNT(*)` ⇒ ⇒ **`candidateUniverse` 与 `bucketMemberRows` 在真实数据上【数值必然相同】** ⇒ ⇒ ⇒ 「这两个量不是同一个东西」这种**按数值**的断言**在真实数据上恒假**（⇒ **必红** ⇒ 那是一条**恒红**的守卫 ⇒ 不是有效断言）⇒ ⇒ ⇒ ⚠️ **判定层的任何「数值不等」断言都不许那样写**。
> · ⇒ ⇒ ★ **变异 E 的教训（本轮 QA 负控挖出来的）**：「把 `measured` 与 `derived` 接成**同一列**」这个变异 ⇒ ⇒ 在**接线层**它**确实**让对账失效（两个量同源了）⇒ ⇒ 但在**判定层**它**判不出来**（同一列 ⇒ 两个数组逐位相等 ⇒ 判定仍给 `true` ⇒ ⇒ **打不红**）⇒ ⇒ ⇒ ⇒ ⇒ **「同一列 ⇒ 不成立」这条判定，在【接线层】成立、在【判定层】不成立** ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ **所以口径不许写「判定层两列不等」，要写「接线喂了哪一列」**。
> · ⇒ ⇒ ★ **已落地的守卫**：`tests/bench/t06-prune-rate-wiring.test.ts` 的 **§D**（「登记 2 / 3：读路径 `samplesAligned` 的接线（按【来源】验，不按【数值】验）」）⇒ ⇒ 它把接线抽成**纯函数** `readSamplesAlignedInputs()`（返回**具名**的 `measured` / `derived` 两个数组 ⇒ 门禁能**按列**断言）⇒ ⇒ 负控在 **§E**（「登记 2 / 3 的负控：判定逻辑能分辨『喂对列』与『喂错列』」）⇒ ⇒ ⇒ ★ **负控的形态 = 把两列【人为改不同】** ⇒ ⇒ ⇒ **它证明的正是「按数值验不可行、按来源验才行」** ⇒ ⇒ ⇒ ⚠️ **口径引用守卫时只写【章节 / 用例名】、不许写行号**（会漂移）⇒ ⇒ ⇒ **落点登记见 §11 第 14 条 / §6.12 裁决 10**。
> ⇒ ⚠️ **为什么不能沿用旧写法（恒真 ⇒ 没牙）**：旧写法是「读路径字节样本数 == 召回毫秒样本数」⇒ 两个 `push` 在**同一个 `for (const query of queries)` 循环体内、无条件、无 `continue`/`break`** ⇒ **长度必然相等 ⇒ 恒真** ⇒ 它挂在一条判红的守卫上 ⇒ **永远打不红** ⇒ 违反既有纪律（负控台 / 断言 5 的「两头锁死」都要求**守卫必须能被打红**）。

> **断言 1e（写路径窗口没开大 · 零容差）** —— **写路径**：`bucketMemberRows === candidateUniverse`（★ **同源 ⇒ 必然相等**：两者量的是**同一个扫描的同一批桶** —— `bucketMemberRows` 是计数器实测的 Q1 成员行、`candidateUniverse` 是生产返回值 `scan.scanned`（= `memberIds.size`）⇒ ⇒ **零容差可判红**）。
> ⇒ **它比「> 0」有牙得多**：计数窗口一旦开大（罩住了召回探针、或罩住了写入循环内部那次扫描）⇒ 这个数就会**变大** ⇒ 不等 ⇒ 红。
> ⇒ 它同时钉住三件事：① 窗口没罩错段（§3.3 第 5 条）；② `bucketMemberRows`（Q1 成员侧计数）与 `candidateUniverse`（生产返回值）是**两条独立实现**的路径（同一次扫描、同一批桶）⇒ 互证；③ 桶归属没有重复写入。
> ⇒ ⚠️ **「一个记忆只属于一个细桶 ⇒ 桶间不重复」是【支撑事实】，不是「必然相等」的根据**（它保证的是 `COUNT(*) == COUNT(DISTINCT)`；**「必然相等」的根据是【同源】**）⇒ 依据见 §11 第 13 条（唯一索引 `idx_vcm_memory_unique` 在位）。
> ⇒ ⚠️ **只对写路径成立**（读路径的 `candidateUniverse` 是 `COUNT(DISTINCT memory_id)` 口径、且**来自外层 `route()` 侧** ⇒ 与计数器**异源** ⇒ **禁止互比** ⇒ 见 §1.7 与 §2 断言 1d 理由③）⇒ ⇒ ★ **一句话对照（别再把两件事讲成一件）**：**写路径 = 同源 ⇒ 必然相等（可判红）**；**读路径 = 异源 ⇒ 禁止互比**（读路径的对账量已换成 `bucketMemberRows === bucketMemberRowsDerived` —— **同源**：都是 `route()` 侧命中桶的成员行，一侧实测、一侧推算）。

> **断言 2（分类完备 · 零容差）** —— **`unclassifiedRows === 0`**；且**每个登记形状**的行数之和 == 对应读数：「码形状」返回行数之和 == `codeRowsRead`；「向量形状」返回行数之和 == `embeddingRowsRead`；「窄读形状」返回行数之和 == `narrowRowsRead`；「成员形状」返回行数之和 == `bucketMemberRows`。
> ⇒ 缺口 1（Q2 不被识别 ⇒ `codeRowsRead` 恒 0）、缺口 2（Q3 被记成向量行 ⇒ `embeddingRowsRead` 虚高）、缺口 3（`scoreOf` 与 Q4 混淆）**任一复发 ⇒ 这条立刻红**。
> ⇒ ★ **聚合豁免（裁决 3）**：**聚合查询命中零来源，但【不计入】`unclassifiedRows`**（字节侧**先判聚合** ⇒ 与 legacy 侧对称 ⇒ 见 §3.2 的聚合豁免条与 §3.3 第 1 条）⇒ ⇒ 聚合查询**不算**分类缺口（否则 `countUncodedCandidates` 这类诊断 SQL 会误判红）。

> **断言 3（unclassified 自检 · 有牙）** —— **把【故意未登记的 SQL 文本】喂进分类器 ⇒ 断言它【确实】落进 `unclassified`**。
> **例**：`SELECT id FROM memories`（表集合 `{memories}`、列集合 `{id}` ⇒ **不匹配任何登记形状** ⇒ 命中零来源）。
> ⇒ **否则「`unclassifiedRows` 恒为 0」就是【恒绿 = 没牙】** ⇒ 这条守卫会一直在骗人（断言 2 与真空通过守卫都依赖它）。

> **断言 4（本轮硬边界 · 零 src 改动 · 主理人裁决 ②）** —— **本轮结束时 `git diff --stat src/` 必须为空**。
> ⇒ 这是一条**可验证的强纪律**：任何 `src/**` 改动（含**注释**）都会让它红 ⇒ ⇒ 它把「T06 是测量装置、不是生产代码变更」这条边界**变成机器可验的**。

> **断言 5（过滤串失效守卫 · 有牙 · 主理人点名）** —— **旧的过滤串 `（H1）` / `（H2）` 必须一个都匹配不上任何违规行** ⇒ 若它们仍能匹配 ⇒ 判「**过滤串失效**」（那些断言从此**恒绿 = 没牙**）⇒ **判红**，不许放过。
> ⇒ **为什么必须独立成一条断言**（而不是「施工时记得改过滤串」这种软提醒）：既有 `tests/bench/h1-measurement.test.ts` 里就有断言在检查「违规清单里含 `（H1）`」⇒ H1′ 的标签改成 `（H1′）` 之后，**那个旧过滤串一个都匹配不上** ⇒ 那条断言会**红或绿——取决于它的断言形态**（`expect(h1).toHaveLength(1)` ⇒ 过滤后得空数组 ⇒ 0 ≠ 1 ⇒ **红**；`.some(...)` 形态 ⇒ 空数组 ⇒ **假**）⇒ ⇒ **无论红绿，它都不再验证任何东西**（它验的是「旧标签 `（H1）` 还在 `failures` 里」⇒ 而那个标签已经作废）⇒ ⇒ **不是「绿着骗人」，也不只是「红着等人」** ⇒ 处置 = **同批更新旧测试的过滤串 `（H1）` → `（H1′）`** + **它测的前提**（旧行数判据已降级为观测 ⇒ 该测 `bytesRead.max`）⇒ **不许**为了让测试变绿而删/改松断言 ⇒ ⇒ 「改名」这件事本身必须**有牙**。
> ⇒ **写法（两头都锁死）**：① **故意造一条**带**旧标签** `（H1）` 的违规行 ⇒ 断言它**不**进 `failures`；② 再造一条带**新标签** `（H1′）` 的违规行 ⇒ 断言它**确实**进 `failures` ⇒ ⇒ 任一头不成立 ⇒ 判红。
> ⇒ **同批必须改**：所有 `failure.includes('（H1）')` 之类的过滤串**全部**换成 `（H1′）` / `（H2′）` / `（PRUNE_RATE）`；旧串**不许**留着当「宽松匹配」继续用。
> ⇒ **落点**：① §5 末条 · ② §8 的 T06-4 验收第 6 条 · ② §10.3 断言写法表。

---

## 3. `classifyReadKind()` 扩展方案：**一次规范化、两个结论（legacy 行读 + 字节来源分解）**

**不选纯 (a)（五分类正则）、不选纯 (b)（手抄指纹登记）**；理由：**一个函数、一次归一化、两个结论** ⇒ ① **legacy 结论逐位复现旧行为**（`docs/baseline/*.json` 的 R6 `candidateReadRows` 不断档）；② **byte 结论拿到分类精度**；③ **未识别的 SQL 显式暴露**（(a) 会静默归 0、(b) 登记漏了就查不到）。

### 3.1 结论一：**legacy 行读口径**（必须逐位复现旧 `classifyReadKind()`）

| 归一化 SQL 特征 | legacy kind | 与旧行为的关系 |
|---|---|---|
| 含 `COUNT(`/`SUM(`/`AVG(`/`TOTAL(` | `null` | **不变** |
| 含 `FROM\|JOIN memories` | `candidate` | **不变**（⚠️ 必须在 `vector_codes` **之前**判 ⇒ 见 §3.3 第 2 条） |
| 含 `FROM\|JOIN vector_cell_members` | `bucketMember` | **不变** |
| 含 `FROM\|JOIN vector_codes` | `vectorCode`（**新增**） | 旧行为是 `null`（不计）⇒ **新增它不改动任何既有读数** ✅ |
| 其余 | `null` | **不变** |

⚠️ **注意 `memories_fts` 不匹配 `memories`**（`\b` 在 `_` 前不成立）⇒ 文本路 FTS 读**不计入**任何读数（与「正文不算」一致）。

### 3.2 结论二：**字节来源分解**（**形状登记表** ⇒ 未登记 ⇒ 命中零来源 ⇒ `unclassified`）

⚠️ ★ **为什么用「登记形状」而不是「开放的表 + 列规则」**：开放的规则下，**任何** `memories` 语句都命中「向量来源」或「窄读来源」⇒ 「命中零来源」**恒为 0** ⇒ 守卫没牙；而且 `SELECT * FROM memories` 会被**静默判成窄读** ⇒ 字节账**静默偏低**。
⇒ ⇒ **改成登记制**：只有**登记在册的语句形状**才认领来源；**未登记 ⇒ 命中零来源 ⇒ `unclassifiedRows` ⇒ 判红** ⇒ ⇒ 「命中零来源」这条口径**终于有了牙**（并让断言 3 的自检成立）。

| 形状 id | 表集合（`FROM`/`JOIN`） | 源列名集合（SELECT 段） | 认领来源 | **载荷列**（进 `bytesRead`） | **非向量字节列**（进 `contentBytes`） |
|---|---|---|---|---|---|
| **Q1** | `{vector_cell_members}` | `{fine_id, memory_id}` | 成员 | — | — |
| **Q2** | `{vector_codes}` | `{memory_id, code, scale, eps}` | 码 | `code` | — |
| **Q3** | `{memories}` | `{id, last_access, pin_factor}` | 窄读 | — | — |
| **Q4** | `{memories}` | `{id, content, content_tokens, stability, last_access, access_count, difficulty, embedding}` | 向量 | `embedding` | `content`, `content_tokens` |
| **Q5** | `{memories}` | `{id, embedding, last_access, pin_factor}`（**4 列**） | 向量 | `embedding` | — |
| **scoreOf** | `{memories}` | `{embedding}` | 向量 | `embedding` | — |
| **bucketCandidate**（★ 裁决 4 订正版） | `{vector_cell_members, memories}` | 同 Q4 的 8 列 | 向量 + 成员 | `embedding` | `content`, `content_tokens` |

★ **裁决 4（订正版 · 定性照此写）**：**`bucketCandidate` —— 仅 `prune = false` 对照分支（A1 / A7）使用 ⇒ 两段式写路径不发 ⇒ 不在 bench 采样窗口内**。
  · **登记它是为了【防御】**：将来若对照分支被打开，形状仍能认领（向量来源 + 成员来源并存）⇒ **不会静默漏检**。
  · ⛔ **删掉**「写路径候选扫描主体」/「H1′ 字节账的大头」这两句表述（**我先前那版 §14 的相关说法作废**）—— 事实：`buildBucketCandidateSql()` 的**唯一调用点**是 `src/vector/ivf.ts:748` 的**分支 A**（`prune = false` 对照分支）；源码注释（`ivf.ts:719-720`）已写明「`scanned = 成员数`（**不调** `buildBucketCandidateSql()`）」。
  · ⇒ **旁证（工程师第一段实测，完全吻合）**：写路径一次扫描的 legacy `candidateRows` = **40** = 「20 次精确分 + 20 行 survivors」⇒ **正好两项**、没有第三项（`bucketCandidate` 不发）✔ ⇒ ⇒ **§1.5 那句「写路径里碰 `memories` 的读只有 `scoreOf` 与 Q4 两条」是【正确】的，不用改** ✔。

* **形状键 = (归一化的表集合, 归一化的源列名集合)** ⇒ 查表 O(1) ⇒ **未登记 ⇒ 零来源 ⇒ `unclassified`**。
  ⇒ ⚠️ **形状键【只由 (表集合, 源列名集合) 决定】⇒ WHERE 条件不进键** ⇒ `deleted = 0` 的**有无不影响判定**；但**原文引用要写对**（读者会照抄 ⇒ 见 §1.2 的逐字版本）。
* ★ **聚合豁免（裁决 3）**：字节侧**先判聚合** ⇒ 聚合查询**命中零来源、但【不计入】`unclassified`**（与 legacy 侧「聚合 ⇒ `null`」对称）。
  · **事实**：`src/vector/ivf.ts:687` 的 `countUncodedCandidates` = `SELECT count(*) AS n FROM vector_cell_members vcm WHERE vcm.fine_id IN (?) AND NOT EXISTS (SELECT 1 FROM vector_codes vc WHERE vc.memory_id = vcm.memory_id)` ⇒ 它的形状键 = 表集合 `{vector_cell_members, vector_codes}` + 列集合 `{count}` ⇒ **未登记** ⇒ 若不豁免 ⇒ 命中零来源 ⇒ **误判红**。
  · ⚠️ **它当前只在 `src/store/recall.ts:997` 的 `withDiagnostics` 分支被调用** ⇒ **bench 默认不触发 ⇒ 现在不会误判红**；但**口径必须写死**，否则将来打开诊断开关就炸。
  · **同理**：`src/vector/bucketAssign.ts:525` 的 `SELECT memory_id FROM vector_cell_members GROUP BY memory_id HAVING COUNT(*) > 1` ⇒ 含 `COUNT(` ⇒ **同一豁免**。
* **「源列名」= SELECT 项 `AS` 之前的部分、去掉表限定符**（`m.embedding AS vec` ⇒ 源列名 `embedding`）⇒ **改别名不影响判定**。
* **「SELECT 列表」只取归一化 SQL 的第一个 `SELECT` 之后、第一个 `FROM` 之前** ⇒ 否则 `WHERE ... m.embedding IS NOT NULL` 这类**只过滤不取列**的语句会被误判。
* ⇒ **Q3（3 列窄）与 Q4（8 列整行）由此自动分开**；`scoreOf`（1 列）与 Q4 在**字节上完全同质**（都是 `memories` + `embedding`）⇒ **不必为字节区分**；若报告需要区分「写路径 survivors 被读两次」，再加一个**只影响报告细分**的细分类（`survivorRow` = `FROM memories m` 带别名；`exactEmbedding` = `WHERE id = ?` 单参等号）—— **它不参与字节计算**。
* ⇒ ★ **「Q2 若写成 `JOIN memories`」的护栏升级为结构性**：形状键不再匹配 Q2 ⇒ **命中零来源 ⇒ `unclassified` ⇒ 判红** ⇒ **不是「记到 candidate 后被人忽略」，而是「直接暴露」**。

### 3.3 实现要点

1. **归一化**（一次，两边共用）：折叠所有空白串为单空格 → `trim` → 把 `IN (?, ?, ...)` 折叠成 `IN (...)` ⇒ ★ **再走 §1.2 的两步**：取 `AS` 之前的部分 → 去表限定符（`m.` / `vc.`）⇒ ★★ **字节侧与 legacy 侧都【先判聚合】** ⇒ **聚合查询命中零来源、但【不计入】`unclassified`**（裁决 3 · §3.2 的聚合豁免条）⇒ ⇒ **聚合判定必须在形状查表之前**（否则 `countUncodedCandidates` 那种「表集合含两张表 + 列集合 `{count}`」的诊断 SQL ⇒ 未登记 ⇒ **误判红**）。
2. **legacy 侧 `memories` 必须排在 `vector_codes` 之前**（**不许倒**）：一条 SQL 碰了 `memories` ⇒ 它真的要付 `memories` 的字节 ⇒ 归 `candidate` 才如实（哪怕它同时还读了码池）⇒ ⇒ **legacy 侧**「Q2 若写成 `JOIN memories`」这条护栏**正是靠这个顺序生效**（规格 §5.1.2 的原文告警）。**字节侧不受影响**：字节侧是**形状登记制** ⇒ 混合 SQL **命中零来源 ⇒ 判红**（比「两类字节都被记上」更早暴露）。
3. ★ **字节累计必须【立即累加标量】，绝不缓存行数组**：字节只需 BLOB 的 `.byteLength`（**O(1)**）⇒ 逐行读一次属性即可 ⇒ ⚠️ **不许把行数组缓存到 `stop()`**（写路径一轮 ≈ 5,521 成员行 + 5,521 码行 ⇒ 缓存 ≈ 9 MB；跨轮不 `stop()` ⇒ **≈ 4.6 GB ⇒ OOM**）⇒ ⇒ **当场累加标量 ⇒ O(1) 内存 ⇒ 彻底没有 OOM 风险** ⇒ 且计时窗口内的额外成本 = 每行 1~2 次 O(1) 属性读，相对毫秒级耗时**可忽略**（与既有纪律「计数器的开销必须可忽略」一致）。
   ⇒ ⇒ ★ **【两件事是正交的】**（这是本轮最容易混的一处）：
   · **「当场累加标量」** 解决的是 **OOM**（不缓存行数组 ⇒ O(1) 内存）⇒ **必须**。
   · **「一轮 vs 两轮」** 解决的是 **计时窗口干不干净** ⇒ ⚠️ **【只限【写路径】· 不是通则】（2026-11-05 主理人核出的新事实 ⇒ 本条已订正）**：**写路径**沿用工程师已实现的两轮制（轮 A 计时无计数器 / 轮 B 计量有计数器，**两轮同一份输入**）⇒ ⇒ **计时窗口 100% 干净**（`vectorCandidateScan` 与历史基线逐位可比）⇒ ⇒ **`samplesAligned` 保留为【有牙的断言】**（两轮若看到的不是同一批数据 ⇒ 红 ⇒ 它证明「计量没有扰动扫描」）；⇒ ★★ **而【读路径】本轮【完全不动】（单轮 · HEAD 逐字同形：计数器装着 + 计数 + 计时位置不动）** ⇒ 理由 = **HEAD 的读路径计时窗口里，计数器本就装着且在计数**（`git show HEAD:bench/perf.ts:880` 的 `rowCounter.start()` 落在 `:872`–`:884` 的计时窗口**之内**）⇒ ⇒ 历史基线的 `vectorRouteP99Ms` **本来就含计数器的逐行开销** ⇒ ⇒ **读路径拆两轮 = 改口径 = 要重采百万级基线** ⇒ ⇒ **读路径不拆两轮**（HEAD 的两条路径**本来就是两种形态**：读路径装 + 计数 / 写路径无计数器 ⇒ **各按各的形态**）。
   ⇒ ⇒ **结论：当场累加标量 ＋ 两轮制 ＋ `samplesAligned` 断言，三者同时成立、互不冲突。**

   ⇒ ⇒ ★★ **【写路径两轮制的硬证据 · 口径同源】（⚠️ 只限写路径 · 读路径的硬证据见下一条）】**（**2026-11-05 补录；本条是防止再被翻案的锚点**）：
   · **事实（已复核 `git show HEAD:bench/perf.ts:943-952`）**：历史基线里的写路径扫描段是
     ```
     const start = process.hrtime.bigint();
     const scan = collectVectorCandidates(dedupContext, embedding);
     const end = process.hrtime.bigint();
     writeVectorScanSamples.push(...);
     ```
     ⇒ **那段计时窗口里【没有计数器】** ⇒ ⇒ **`docs/baseline/*.json` 的 `writeSegments.vectorCandidateScan` 是「无计数器的干净测量」**。
   · ⇒ **所以【写路径】两轮制是【口径同源】的必需，不是「怕代理开销」**：轮 A（不装计数器）**逐字复现 HEAD 的取时位置** ⇒ 新旧 ms **逐位可比** ⇒ 不用重跑百万级基线；而**单轮**（把计数器塞进被测区间）= **把 `vectorCandidateScan` 的口径改掉** ⇒ 与历史基线**不再逐位可比** ⇒ 违反既有纪律「换口径不用重跑百万级」⇒ ⇒ **单轮是要付「基线重采」代价的**，不是「省一次扫描」的免费午餐。
   · ⇒ ★★ **【读路径的硬证据 · 与写路径并列】（2026-11-05 主理人核出、架构师独立复核 `git show HEAD:bench/perf.ts`）**：HEAD 的**读路径**计时窗口是
     ```
     872: const start = process.hrtime.bigint();
     879: const before = rowCounter.snapshot();
     880: rowCounter.start();          ← ★ 计数器【在计数】，且落在计时窗口【之内】
     881: backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
     884: const end = process.hrtime.bigint();
     885: rowCounter.stop();
     887: vectorRouteSamples.push(...);
     900: rowCounter.uninstall();      ← 之后才是写路径段 ⇒ 写路径扫描段【无计数器】
     ```
     ⇒ **读路径**：计数器**装着且在计数**就在计时窗口里 ⇒ 历史基线的 `vectorRouteP99Ms` **本来就含计数器的逐行开销** ⇒ ⇒ **读路径拆两轮 = 改口径 = 要重采百万级基线** ⇒ ⇒ **读路径本轮【单轮 · HEAD 逐字同形】**（计数器照装照计数、计时位置不动）；⇒ **写路径**：`:900` 的 `uninstall()` 在写路径段之前 ⇒ 扫描段**无计数器** ⇒ ⇒ **写路径才需要**两轮制（轮 A 不装计数器才能逐字复现旧取时位置）⇒ ⇒ **两条路径各按各的形态 ⇒ 「两轮制」不是通则**。
   · ⇒ **「两轮会让 `vectorRouteP99Ms` 不可比」这条担心在本轮不成立**：召回窗口（`rowCounter`）本轮**完全不动**（单轮 · HEAD 逐字同形）⇒ `vectorRouteP99Ms` 的口径没变；受影响的只有写路径扫描段，而那段的旧口径**恰好就是「无计数器」** ⇒ ⇒ **写路径两轮 = 保持原口径，写路径单轮 = 改口径**。
   · ⇒ **「两轮会让 `samplesAligned` 恒真 ⇒ 没牙」这条判断不成立**：两轮是**两次独立执行**同一条生产扫描（同一份输入、同一库状态）⇒ 它**不是**恒真 —— 若计量扰动了扫描（GC / 页缓存 / 输入漂移）或计数器行为变了 ⇒ 两个 `candidateUniverse` 不等 ⇒ 红 ⇒ ⇒ 它的作用是**把字节样本与计时样本绑定**（否则落盘的 bytes 来自轮 B、ms 来自轮 A ⇒ 两者不能互相解读）。
   · ⇒ **代价账（唯一代价）**：写路径扫描段**多跑一遍** ⇒ bench 那一段耗时 ≈ ×2 ⇒ 百万级 bench 是**秒级**增量 ⇒ 与「口径同源 + 基线不重采」相比**完全值得**（工程师第一段的 impl-notes §5 第 11 条已记过这笔账）。

   ⇒ ⇒ ★★ **【写路径两轮制的三个实现坑（主理人 2026-11-05 点名 · 必须写进实现注释）· ⚠️ 只限【写路径】· 读路径本轮【单轮 · HEAD 逐字同形】、不套这三条】**：
   1. **轮 A 的计时区间内不得有任何逐行计数开销** ⇒ 最稳的做法是**轮 A 完全不装计数器**（**连包装都不装**）⇒ 计时窗口与 HEAD **逐字同形**（否则轮 A 的 ms 里混了计数器开销 ⇒ 白折腾）。
   2. **轮 A 与轮 B 之间不得有任何库写入** ⇒ 否则两次执行的候选宇宙不同 ⇒ **`samplesAligned` 恒红** ⇒ ⇒ **写路径扫描循环内无写入 ✔**（它只读），但**这条前提必须写明**（将来谁把扫描挪进写入循环 ⇒ 立刻红 ⇒ 好事）。
   3. **计数器实例的串行安装**：召回那个先 `uninstall()`（`bench/perf.ts:950`）⇒ 轮 B 之前装写路径那个 ⇒ 循环后 `uninstall()` ⇒ **第二个不能把第一个的包装当「原函数」**（否则 `uninstall()` 只会还原到「第一个的包装」⇒ 生产句柄上留残桩）。
   ⇒ ⇒ **判据量与计时严格同源**（单轮下的好处，裁决 1 曾据此拍板）**在两轮制下同样成立**：字节与毫秒都来自**同一条生产扫描**（轮 B 取字节、轮 A 取毫秒 ⇒ 两者是**同一份输入、同一库状态**下的两次执行 ⇒ `samplesAligned` 就是它们的对账凭据）。
4. **`unclassified` 必须暴露**：命中零来源的语句 ⇒ 计数 `unclassifiedRows` + 把指纹集合**打印 + 落盘**（`unclassifiedSqlKinds`）⇒ 配合断言 2 / 断言 3；`unclassifiedRows > 0` ⇒ **H1′ 判「口径不完整 ⇒ 不可判定」（红）**，不许默默按 0 计。
5. ★★ **写入路径的字节当前采不到**（缺口 4：`rowCounter.uninstall()` 在写入扫描循环之前）⇒ **不要移动 `uninstall()`**。
   **真正的理由（主理人补充、已核实）**：**生产的写入循环内部自己就会走向量候选扫描** —— `src/store/write.ts:671`（`findMergeCandidate` 内）→ `collectDedupCandidates()`（`src/store/dedupCandidates.ts:400`）→ `:423` → `collectVectorCandidates()`（`:295`）⇒ ⇒ **若把 `uninstall()` 往后挪，写入循环的向量扫描会被混进「写入扫描段」** ⇒ **判据量被污染**。（代理开销污染写入 P99 只是**次要**理由。）
   ⇒ **正确做法 = 在写入循环之后、写入扫描循环之前，另装一个计数器实例**（两个实例**串行**安装 ⇒ 第二个不能把第一个的包装当「原函数」⇒ **第一个必须先 `uninstall()`**）。
6. ★ **「调用次数」必须无条件计数**：`get()` 包装里要 `calls += 1`（**返回 `undefined` 也计**）⇒ 否则剪枝率分子偏小 ⇒ 假绿（§1.7 方向纪律 + 断言 1c-bench）。

---

## 4. 落盘结构（四个读数 + 层级）

**四读数取 ADR §8.5 的原名**（`memoryRowsRead` / `codeRowsRead` / `bytesRead` / `candidateUniverse`），**装在两个分段容器里**（写路径与读路径**不混成一个 `bytesRead`**）：

⚠️ ★ **形态 = `CountSummary` 分布**（`count` / `min` / `mean` / `p50` / `p99` / `max`）⇒ ① **判据取 `max`** 有值可取；② 与既有 `writeSegments.vectorCandidateRows` **同形**；③ 「换口径不用重跑百万级」（既有纪律）。

⚠️ ★★ **两个层次必须分清（★ 主理人裁决 ② · 2026-11-05）** —— **落盘层** vs **样本层**（★ **本条适用于全部 `breakdown`** · 写路径与读路径同此一条）：
· **落盘层** = `breakdown` 的 **13 项**（★ **本清单按【落盘顺序】排列** · 不是按重要度排 ⇒ ⇒ 按位置读第 N 项时请对着 §4 的 JSON 清单数）：`codeBytes` / `embeddingBytes` / `contentBytes` / `embeddingRowsRead` / **`embeddingExactRows`** / `embeddingCalls` / `narrowRowsRead` / `bucketMemberRows` / `badCodeRows` / `unclassifiedRows` / `unclassifiedSqlKinds` / `pruneRate` / `samplesAligned`）⇒ **这一层才是落盘 JSON 的键**；
· **样本层** = **`VectorByteSample`**（TS 类型 · **不落盘**）⇒ ⇒ ⚠️ **`VectorByteSample.bucketMemberRowsDerived` 属于【样本层】⇒ 它【不在落盘 JSON 里】⇒ 落盘结构零变化** ⇒ ⇒ **旧键零删除、只新增**（ADR §8.5）**完全不受影响** ⇒ ⇒ ★ **不要把它当落盘键加进 §4 清单**（加了反而与实现不符）。

```jsonc
{
  "writeSegments": {
    /* …旧键一个不动：vectorCandidateScan / vectorCandidateRows / writeTotal / otherMeanMs / otherMeanShare / note… */
    "vectorByteReads": {                    // ★ 新增（与 vectorCandidateRows 并列 ⇒ 同一组读数不拆散）
      // ★ 四个读数（ADR §8.5 原名）+ CountSummary 分布
      // ★ 下面四个读数的数值 = 2026-11-05 实测（1,000,000 条 · 热档 · HDD · 写路径独立实测段 · 200 样本）⇒ ⇒ ★ 可复算（`bytesRead = 码行数 × 768 B + embedding 行数 × 3,072 B` ⇒ ⇒ 5,286 × 768 + 2 × 3,072 = 4,065,792 ⇒ ⇒ 与 `bytesRead.max` 逐位相等 ⇒ ⇒ 详见 §6.12 裁决 9 下方「留痕 B」）
      "memoryRowsRead":   { "count": 200, "min": 0, "mean": 1.09, "p50": 2, "p99": 2, "max": 2 },
      "codeRowsRead":     { "count": 200, "min": 21, "mean": 2109.22, "p50": 2018, "p99": 5207, "max": 5286 },
      "bytesRead":        { "count": 200, "min": 16128, "mean": 1623229.44, "p50": 1549824, "p99": 3998976, "max": 4065792 },
      "candidateUniverse":{ "count": 200, "min": 21, "mean": 2109.22, "p50": 2018, "p99": 5207, "max": 5286 },
      "breakdown": {
        "codeBytes":        { /* Σ row.code.byteLength */ },
        "embeddingBytes":   { /* Σ row.embedding.byteLength */ },
        "contentBytes":     { /* ★ Q4 的 content + content_tokens（UTF-8）——【不在 bytesRead 里】⇒ 让「下界差多少」可见 */ },
        "embeddingRowsRead":{ /* 物化出 embedding 的行数（字节账分子） */ },
        "embeddingExactRows":{ /* ★ scoreOf【返回了行】的次数（= embeddingCalls 减去「白调用」）⇒ ★ 断言 1c-bench 的比较对象（写路径用它、不是 embeddingRowsRead） */ },
        "embeddingCalls":   { /* ★ bench 侧 get() 【调用次数】（= 剪枝率分子；定义上 == prune 的 exactReads，见 §1.7） */ },
        "narrowRowsRead":   { /* Q3（0 字节） */ },
        "bucketMemberRows": { /* Q1（0 字节进判据） */ },
        "badCodeRows":      0,        // 健康库恒 0（坏码行 = 白读）
        "unclassifiedRows": 0,        // 必须 0（> 0 ⇒ 口径不完整 ⇒ 判红）
        "unclassifiedSqlKinds": [],   // 未登记语句的指纹集合（打印 + 落盘）
        "pruneRate":        { /* 每样本剪枝率的分布（判定取 max）；分子 = embeddingCalls（== exactReads），分母 = candidateUniverse */ },
        "samplesAligned":   true      // ★【写路径】两轮（轮 A 计时 / 轮 B 计量）的 candidateUniverse 逐样本相等 ⇒【有牙】：不等即红（断言 1d 的写路径形态）
      },
      "note": "口径：bytesRead = 向量载荷字节（码 + embedding 两个 BLOB 的实测 byteLength）；不含正文 / 标量 / 成员标识 / SQLite 行头与页开销 ⇒ **是真实搬运量的下界 ⇒ 判据偏严、不会假绿**；判定取 max。⚠️★ 本数 = bench 的『写入扫描独立实测段』（同探针 8/20、同库、同被考核方 ⇒ 与旧 H1 的 vectorCandidateRows 同一笔 ⇒ H1′ 与 H1 可比）；⚠️★ 它【不是】store.write() 内部那一笔 —— 生产写入内部自己就会走向量候选扫描（write.ts:671 → collectDedupCandidates → collectVectorCandidates），那一笔不单独落盘（已被 writeTotal 计时覆盖）⇒ 两笔【同一量级】（向量字节这一项）；且独立实测段跑在写入循环【之后】（库里已多了 N 条 ⇒ 候选面更大）⇒ **独立实测段略偏悲观 ⇒ H1′ 偏严** ✅；⚠️ 但真实写入的『总读取字节』远不止这些（文本路 FTS / 合并判定 / 桶归属）⇒ **那些字节一次都没被观测** ⇒ **H1′ 不是『一次真实写入的总字节预算』**（它只是向量载荷这一项）；⚠️★ **ADR §8.6 那个 `4.44 MB` 是【偏高的估计】、不是【下界】（它按「每轮 64 次精确重排 × 3,072 B」估 ⇒ 而 **2026-11-05 实测精确分【至多】2 行**（★ 200 个样本 `embeddingRowsRead` 的 min 0 / p50 2 / p99 2 / max 2 ⇒ ⇒ **没有一个超过 2 行**⇒ ⇒ **比 ADR 假设的 64 次少 32 倍**）⇒ 实测 4,065,792 B 低于它 8~13%）⇒ ⇒ 实测低于它属预期、不是回归**⇒ ⇒ **判据只认实测 `bytesRead`**；⚠️ 计时口径（⚠️ 【两轮制只限写路径】· 不是通则）：写路径扫描段用【两轮制】（轮 A 计时【不装计数器】/ 轮 B 计量装计数器，同一份输入）⇒ 计时窗口 100% 干净 ⇒ vectorCandidateScan 与历史基线【逐位可比】；且轮 A 与轮 B 之间【不得有任何库写入】（否则 samplesAligned 恒红）；⚠️ 而【读路径窗口本轮完全不动】（单轮 · HEAD 逐字同形：计数器装着 + 计数 + 计时位置不动）⇒ 读路径的字节累加与行读计数【同处一个计时窗口】⇒ 逐行字节计算的微小开销落在 vectorRouteP99Ms 里 ⇒ 与历史基线【同量级而非逐位】（相对每行 3 KB 的读取开销 < 1% ⇒ 判门槛的 vectorRouteP99Ms 不受影响）"
    }
  },
  "vectorRouteByteReads": {                // ★ 新增（顶层，与 candidateReadRows / hitFineBuckets / perRowReadCostUs 同组）
    "memoryRowsRead": { /* … */ }, "codeRowsRead": { /* … */ },
    "bytesRead": { /* … */ }, "candidateUniverse": { /* … */ },
    "breakdown": { /* 同上（含 `embeddingExactRows` —— ★ 它是【使清单达到 13 项的那一项】、⚠️ **在上面的 JSON 清单里排在第 5 位** ⇒ 按【位置】读会读错） */ },
    "note": "读路径：无 Q4 ⇒ survivors 的 embedding 只读一次；candidateUniverse = COUNT(DISTINCT memory_id)（前提：overlay 空 + 无 filter ⇒ 与 memberIds.size 逐位相等）；⚠️ 读路径**不判门槛**（R6 同组：观测值）；⚠️ 剪枝率的分子（embeddingCalls）只在【两段式分支】与 prune 的 exactReads 定义性相等；⚠️★ **读路径的 `samplesAligned` 语义 = 换成「有牙的对账量」**（主理人裁决 1）：**（逐样本）计数器的实测桶成员行 === 由 route() 命中桶推算的成员行之和**（`bucketMemberRows` === `bucketMemberRowsDerived`）⇒ **字段名 / 类型不动**（仍是 boolean）⇒ ⚠️ **不许用 `bucketMemberRows === candidateUniverse`**（读路径：二者【来源不同】—— 计数器 `search()` 侧实测 vs 外层 `route()` 侧的 COUNT(DISTINCT memory_id) ⇒ 互比会掩盖真正的失配 ⇒ 详见 §2 断言 1d 理由③）；⚠️ **旧写法（字节样本数 == 召回毫秒样本数）是恒真的 ⇒ 永远打不红 ⇒ 已废**"
  }
}
```

⚠️ ★★ **上面那段 JSON 是【结构示意】，不是【逐字副本】** —— ⇒ **它只守【键名 / 层级 / 语义】**，**不守 `note` 的逐字内容** ⇒ ⇒ ⚠️ **它与真实落盘的 `note` 字符串【本来就不逐字一致】**（整块带 `{ /* … */ }` 占位符、条目被压缩、无 ① ② ③… 编号）⇒ ⇒ ★ **真正的逐字副本在 `docs/design/perf-c2-t06-byte-metering-impl-notes.md` §13**（两段 `note`）⇒ ⇒ 由 `.tmp/bench/check-json-note-fidelity.ts` **逐字**守着（⚠️ **该脚本只在 `.tmp/` 里（gitignored ⇒ 仓库里没有）** ⇒ ⚠️ **`bench/perf.ts` 把「机器凭据」写成 `handover/bench/…`（已提交 · 但那个路径不存在）** ⇒ ⇒ **提交态这道守卫是断的** ⇒ ⇒ ⇒ **待搬进 `scripts/` 并挂进 `verify` 链**（= §13 第 12 条覆盖缺口的另一半）⇒ 当前报 true / true）⇒ ⇒ ⚠️★ **不许拿本块去替换 `bench/perf.ts` 的真实 `note` 字符串**（⇒ 会丢掉真实 note 里的 ① ② ④ ⑦ 各项、⑤ 的后半句、⑥ 的「方向纪律」半句、⑧ 的细则 ⇒ ⇒ **净损失**；⇒ 且 impl-notes §13 的逐字副本会立刻失配 ⇒ ⇒ **自检脚本立刻报 false** ⇒ ⇒ **T07 一跑就红**）⇒ ⇒ ★ **改 `note` 字符串 = 改【落盘产物】⇒ 必须同批改 impl-notes §13**。
⇒ ⇒ ⚠️ ★ **一处【已验证的差异 · 机制已跑通】**：本块 `note` 里那句禁令（⚠️ **不许用 `bucketMemberRows === candidateUniverse`**）**现在也被写进了真实落盘的 `note` 字符串**（⇒ 落盘 note **自解释**：拿到 JSON 的人能看出读路径的对账量是哪一个、被禁止的是哪一个 ⇒ **这条路是对的**）⇒ ⇒ ⚠️ **但那一瞬间，impl-notes §13 的逐字副本没跟上** ⇒ ⇒ `.tmp/bench/check-json-note-fidelity.ts` **当场报 false**（读路径那段在中间失配 ⇒ ⚠️ **它只在 `.tmp/` 里 ⇒ 仓库里没有 ⇒ 提交态跑不到**）⇒ ⇒ ★ **同批把 impl-notes §13 的读路径 `note` 逐字更新后即回绿**（⇒ 当前 true / true）⇒ ⇒ ⚠️★ **这是「改落盘产物 ⇒ 必须同批改逐字副本」这条机制的第一次实战验证** ⇒ ⇒ 详见 §13 待办第 12 条。

⚠️ ★★★ **【盲区登记 · 2026-11-05 实测后】读路径的 `bytesRead.max` 已经超了 H1′ 门槛 —— 而 H1′ 按现行口径【只判写路径】** ⇒ ⇒ ⇒ **读路径目前是一个【无门槛的观测值】** ⇒ ⇒ ⇒ **一旦它被纳入判据（或两路径合并判），当场就是红**。

> **事实（可复算 · 2026-11-05 · 1,000,000 条 · 热档 · HDD · 读路径 `vectorRouteByteReads`）**：读路径 `bytesRead.max = 7,233,792 B` ⇒ ⇒ 相对 H1′ 门槛 `6,144,000 B` = **117.74%** ⇒ ⇒ **超出 17.74%** ⇒ ⇒ （H2′ 同一算法：`7,233,792 ÷ (1,000,000 × 3,072 B)` = **0.2355%** ⇒ 门槛 `0.2%` ⇒ ⇒ **同一个比值** ⇒ ⇒ **结论不随用哪把尺而变**）⇒ ⇒ ★ **而读路径这一侧按现行口径【不判门槛】**（§11 第 4 条：召回路径的字节**只作观测**）⇒ ⇒ ⇒ 所以这个超门槛**不会让 T07 判红** —— ★ **盲区就在这里**：**门槛只覆盖写路径、读路径是裸的**。

⚠️ ★★★ **三条要点（事实 / 盲区 / 建议）**：
> ① ★ **事实**：读路径 `bytesRead.max = 7,233,792 B` = H1′ 门槛的 **117.74%**（超出 **17.74%**）⇒ ⇒ H2′ 口径下同一比值（`0.2355%` vs `0.2%`）⇒ ⇒ **读路径在两把尺下都超**（⇒ ⇒ ★ **可复算**：见 §6.12 裁决 9 下方「留痕 B」的恒等式 `9,079 × 768 + 85 × 3,072 = 7,233,792`）。
> ② ★★ **盲区**：**H1′ 的门槛只覆盖写路径**（写路径 = bench 的『写入扫描独立实测段』；读路径 = 顶层 `vectorRouteByteReads`）⇒ ⇒ ⇒ **读路径目前是无门槛观测值** ⇒ ⇒ ⇒ **没有任何机制会因它变红** ⇒ ⇒ ⇒ ⚠️ **一个已经超了门槛的量，在门禁里是隐形的** ⇒ ⇒ ⇒ ⚠️ **两种误读都会改变结论**：① 下一个人看到「读路径 7.2 MB」若**误以为它受 H1′ 约束** ⇒ ⇒ 会得到「早就超了、门禁没抓到」的错觉；② 反过来若**顺手把它并进 `failures`** ⇒ ⇒ ⇒ **就把一个观测值悄悄变成了判据**（⇒ ⇒ 而它一进去当场就是红 ⇒ ⇒ ⇒ **判据变了、门禁却没走过裁决**）。
> ③ ★ **建议（采纳口径①「观测值不该悄悄变成判据」）** —— **在 ① 里把这条写死**：「**H1′ 只判写路径；读路径的字节是观测值、不参与红绿**」⇒ ⇒ ⇒ ★ **读路径本轮【不新设门槛值】**（新设门槛 = 让它悄悄变成判据 ⇒ ⇒ ⇒ 与本建议自相矛盾）⇒ ⇒ ⇒ ⇒ 若将来要把读路径纳入判据（或把两路径合并判）⇒ ⇒ ⇒ ⇒ **那属于【判据升级】**（与旧 H1 → H1′ 同性质）⇒ ⇒ ⇒ ⇒ **必须先走裁决、明确写进口径，再改 bench/tests** ⇒ ⇒ ⇒ ⇒ ⚠️ **不许靠「顺手把它算进 `failures`」实现** ⇒ ⇒ ⇒ ⇒ ★ **一旦纳入，当场就是红**（117.74%）⇒ ⇒ ⇒ ⇒ ⇒ 那时要先讨论「读路径门槛定多少」，**不是先改代码**。

**为什么读路径放顶层而不塞进 `recallVectorPath`**：`recallVectorPath` 是「new-path 档**整条召回**的 old vs new 时序对比」，字节数不参与那个对比 ⇒ 塞进去会 mislead；而字节读数的采样窗口**正是** `candidateReadRows` 那个（`backend.search()`，探针 20/50）⇒ **与同组读数放一起**才不拆散。
**硬约束**：`docs/baseline/*.json` 的旧顶层键与 `writeSegments` 的旧子键**一个都不许改名、挪位、删除**；新字段**只许新增**。
⚠️ **向后兼容**：旧 JSON 没有这些字段 ⇒ 读旧 JSON 的代码**不会炸**（`tests/bench/baseline-scale.test.ts` 只读 `corpusSize` / `trainedMembers`）⇒ 但**新代码读旧 JSON 时必须显式处理「字段缺失」**（⇒ 建议落盘结构里**所有新对象都带 `count: 0` 的空分布**，读方用 `?? 0` 兜底，**不许直接解构**）。

---

## 5. H1 / H2 判据处置

| 判据 | 处置 | 一句理由 |
|---|---|---|
| **H1′（字节）** `bytesRead.max ≤ 6,144,000 B` | **唯一判据**（红绿只看它）⇒ ★ **只判【写路径】**（bench 的『写入扫描独立实测段』）；读路径的字节是**观测值**、**不参与红绿**（见 §4 盲区登记） | ADR §8.5 已裁决（用户拍板）；字节口径**与码宽 / 存储形态无关** ⇒ 换实现不换尺。⚠️ ★ **「唯一判据」必须点名路径**（⚠️ 不点名 ⇒ 读的人会以为 `bytesRead` 到处都受这条约束 ⇒ ⇒ 而读路径实测**已经超了这条门槛** ⇒ ⇒ ⇒ ⇒ 详见 §4 盲区登记）。 |
| **H2′** `bytesRead.max ÷ (库规模 × 3,072 B) ≤ 0.2%` | **保留为判据**（与 H1′ 同义、规模无关写法；★ **路径限定同 H1′ · 只判写路径**） | 同一批样本、同一探针 ⇒ 必然同时红 / 同时绿。 |
| **剪枝率（出关条件①）** `embeddingCalls ÷ candidateUniverse ≤ 15%` | **保留为判据**（标签 `（PRUNE_RATE）`，判定取 `max`） | 出关条件① 的一半；分子 = **`embeddingCalls`（`get()` 调用次数）= 定义上 == `prune` 的 `exactReads`** ⇒ 方向正确（偏大 = 更严）。⚠️ **禁止**用「返回行数」当分子（偏小 = 假绿，见 §1.7）。 |
| **旧 H1（行）** `vectorCandidateRows.max ≤ 2,000 行` | **降级为并列观测**（仍落盘 + 打印 + note 写明「字节口径下它已不是判据」；**阈值常量 `candidateReadRowsMax` / `candidateReadRowsRatioMax` 一个都不许删**） | ①「行」是**实现相关**的单位（768 B 码 vs 96 B 码 vs 打包块 ⇒ 行数含义完全不同）⇒ 保留它当判据 = 换了存储形态就换了一把尺，**违反 ADR §8.5 理由 2**；②C′ 的 `scanned` = **候选宇宙**（≈ 5,521 行）**必然 > 2,000** ⇒ 保留它当判据 ⇒ **本档永远红、无法交付** ⇒ 降级是**必需**，不是偏好。 |
| **旧 H2（行 ÷ 规模）** | 同上，降级为并列观测 | 与旧 H1 同源、同一量 ⇒ 一起降级。 |

⚠️ **真空通过纪律照旧**：`bytesRead` 的样本数必须 > 0 且 `bytesRead > 0`，否则判「真空通过」（红）；**另加三条同级的「不可判定」守卫**（全部判红）：`unclassifiedRows > 0`（口径不完整）/ `badCodeRows > 0`（前提违例）/ **`samplesAligned === false`**（两轮看到的不是同一批数据 ⇒ 读数不可对账）。⇒ ⇒ ★ **这三条守卫判的是【被判定的那份】`bytesRead` ⇒ ⇒ 按现行口径 = 写路径**（⇒ ⇒ 读路径不判红绿 ⇒ ⇒ **别把读路径一并判成红** ⇒ ⇒ 详见 §4 盲区登记）。
⚠️ **打印措辞**：旧行数只许说「观测值 = … 行」，**不许**说成「已达标」。
⚠️ ⚠️ **`tests/bench/h1-measurement.test.ts` 的过滤串必须同批改**（`failure.includes('（H1）')` ⇒ 新标签是 `（H1′）` ⇒ **旧过滤器一个都匹配不上 ⇒ 那些断言变成恒绿 = 没牙**）⇒ 且要用**伪造 `bytesRead.max`** 的手法验证「判定真的读了字节那个字段」（沿用该文件既有的「伪造而非造真数据」手法）⇒ ⇒ ★ **这条已升级为独立断言 5（见 §2）**：它是一条**能红的断言**（「旧过滤串不得再匹配到任何违规行 ⇒ 若匹配则判『过滤串失效』」），**不是**「施工时记得改」这种软提醒。

---

## 6. 口径与风险（★ 8 条修正的**最终版** · 含主理人 2026-11-05 的订正）

> 每条：**原文主张** ⇒ **核实结论** ⇒ **最终口径**。**代码事实以代码为准**（本节所有行号均已复核）。

### 修正 1（命名）：`memoryRowsRead` 回 ADR §8.5 的「原口径」—— ✅ **采纳**

* **证据**：`docs/decisions/adr-perf-recall-vs-h1.md:589` —「`memoryRowsRead`（**原口径**）/ `codeRowsRead` / `bytesRead`（新判据）/ `candidateUniverse`（命中桶内的候选总数，**不变**）」。
* **最终口径**：`memoryRowsRead` ＝ **全部物化的 `memories` 行数**（窄读 + 向量）＝ ADR 的「原口径」；另设 `embeddingRowsRead` ＝ 其中带 `embedding` 的行数（字节账分子）。
* ⚠️ **写路径里两者相等**（写路径不发 Q3）⇒ **落盘数字不变**，零迁移成本。

### 修正 2（公式）：字节恒等式用**实测 `byteLength` 之和** —— ✅ **采纳（主理人已复核成立）**

* **证据**：`src/vector/ivf.ts:578-586` `if (row.code.byteLength !== dimensions) { continue; }` ⇒ **坏码行进了 SQL 结果集**（`code` 列在 SELECT 列表里 ⇒ **字节已搬**）**但没进码池**。
* **最终口径**：恒等式 = `bytesRead === codeBytes + embeddingBytes`（**永远成立**）；「`codeBytes === codeRowsRead × 768`」降为**健康库检查**（`badCodeRows === 0` 时成立）。
* ⚠️ **⚠️ 主理人订正（已并入 §1.1）**：**`memories` 侧恰好相反** —— `scoreOf` 的 SQL 带 `deleted = 0 AND embedding IS NOT NULL`（`ivf.ts:1244-1250`）⇒ **软删行返回 `undefined` ⇒ `embedding` 从未被物化 ⇒ 那 3 KB 根本没读** ⇒ ⇒ **「返回行数」与「字节」在 `memories` 侧一致** ⇒ ⇒ **断言 1b 的恒等式成立**（前提三条见 §2）。
* ⇒ **两条合起来写成**（本文件 §1.3 理由 3、5 + §2 断言 1）：**恒等式成立**（向量载荷口径，零容差）⇒ 断言 1 有效；**它是真实搬运量的下界**（正文与标量被排除）⇒ 判据**偏严**、**不会假绿** ⇒ 这正是「纯向量载荷口径」被采纳的理由。

### 修正 3（★ 剪枝率方向）：**偏小 = 偏松 = 假绿** —— ✅ **采纳（主理人已复核成立）**；★ **本轮追加：分子改为「调用次数」⇒ 零 src 改动**

* **证据**：`src/vector/prune.ts:289-290` `exactReads += 1;` 紧接 `const score = scoreOf(item.id);` ⇒ **`exactReads` 严格等于 `scoreOf` 调用次数**（一一对应、无例外）。
* **原方向主张被否**：bench 若数「**返回了行**的 `scoreOf` 调用」⇒ 该值 **≤** `exactReads`（差 = 软删 / 无向量 / 已硬删的行数）⇒ **偏小** ⇒ 门槛是「**≤ 15%**」⇒ **偏小 = 更容易过 = 偏松 = 假绿**（最坏情形：命中桶内全是软删成员 ⇒ 返回行数 = 0 ⇒ **剪枝率 0%**）。
* ★ **本轮追加的关键结论（让裁决 ② 的「零 `src/**` 改动」与剪枝率判据不冲突）**：bench 侧数「**调用次数**」（`get()` 被调用就计，返回 `undefined` 也计）⇒ **定义上等于** `exactReads`（§1.7 的三条推理）⇒ ⇒ **不需要改 `src/store/dedupCandidates.ts`**；等价性由 **tests 侧单测**（断言 1c）钉住 ⇒ **守卫仍有牙**。
* ⇒ **最终口径**：剪枝率分子 = **`embeddingCalls`（`get()` 调用次数）**；bench 侧**另数** `embeddingRowsRead`（物化行数 = 字节账分子）⇒ **两数并存、各司其职**。

### 修正 4（落盘形态）：改用 `CountSummary` 分布 —— ✅ **采纳（主理人限定：字段名 / 容器名沿用 architect-2）**

* **最终口径**：四个读数 + `breakdown` 里的字节项 **全部用 `CountSummary`**（`count/min/mean/p50/p99/max`）⇒ 判据取 `max` 有值可取；**字段名沿用 ADR §8.5 原名**（`memoryRowsRead` / `codeRowsRead` / `bytesRead` / `candidateUniverse`）；**容器名沿用** `writeSegments.vectorByteReads` + 顶层 `vectorRouteByteReads`。
* ⇒ **旧键一个不改名、不挪位、不删**（硬约束）。

### 修正 5（实现风险）：字节**当场累加标量**，不缓存行引用 —— ✅ **采纳机制（主理人已采纳并要求写成具体方案）**

* **机制成立**：延后累计必须保留行数组引用 ⇒ 写路径一轮 ≈ 5,521 成员行 + 5,521 码行 ⇒ 缓存 ≈ **9 MB** ⇒ 跨 500 轮不 `stop()` ⇒ **≈ 4.6 GB ⇒ OOM**。
* **主理人订正（已并入）**：我原先把「软删行消耗 3 KB」当作论据之一 —— **该前提不成立**（软删行被 SQL 挡住 ⇒ 未物化 ⇒ 未读）；但**机制本身不受影响**（OOM 来自**缓存行引用**，与软删行无关）。
* **最终方案（★ 裁决：当场累加标量）**：字节只需 BLOB 的 `.byteLength`（**O(1)**）⇒ **当场累加标量** ⇒ **O(1) 内存 ⇒ 彻底无 OOM 风险** ⇒ ⚠️ **【当场累加】与【一轮 / 两轮】是两件正交的事**（本轮最容易混的一处）：「当场累加」解决 **OOM**；「两轮制」解决 **计时窗口干净** ⇒ ⇒ **两者同时成立** ⇒ ⇒ **本轮沿用两轮制（⚠️ 只限【写路径】· 读路径本轮单轮 · HEAD 逐字同形）**（轮 A 计时无计数器 / 轮 B 计量有计数器，**同一份输入**）⇒ ⇒ **`samplesAligned` 保留为有牙的断言**（⇒ 断言 1d）。
* ⇒ **成员 id 的字节本轮不算**（`.length` / `Buffer.byteLength` 都是 O(n) × 5,521 行/轮）⇒ 用 `bucketMemberRows`（行数）表达即可。
* ⚠️ ★ **两轮制的理由不是「代理开销大」，而是「口径同源」**（硬证据见 §3.3 第 3 条：**HEAD 的写路径扫描段本就无计数器** ⇒ 历史基线的 `vectorCandidateScan` 是干净测量 ⇒ **单轮 = 改口径 = 与基线不可逐位比 = 要重采百万级基线**；两轮 = 逐字复现旧取时位置 ⇒ 基线不用重采）。⇒ ⇒ **这条不是口味问题，是「基线要不要重采」的成本问题**。

### 修正 6（`unclassified` 的触发条件）—— ⚠️ **主理人裁决：以 architect-2 的「命中零来源」为准 + 补自检断言**

* **裁决**：`unclassifiedRows` = **命中零来源**的语句所物化的行数 ⇒ **必须为 0**。
* **⚠️ 但「命中零来源」在开放规则下恒为 0 = 没牙** ⇒ ⇒ **配套改造**：字节侧改为**形状登记制**（§3.2）⇒ **未登记的形状 ⇒ 命中零来源 ⇒ `unclassified`** ⇒ 「命中零来源」**终于有牙**。
* **必须补的自检断言（断言 3）**：喂 **`SELECT id FROM memories`**（表集合 `{memories}`、列集合 `{id}` ⇒ **不匹配任何登记形状**）⇒ 断言它**确实**落进 `unclassified` ⇒ **否则这条守卫永远在骗人**。
* ⇒ **附带升级**：「Q2 若写成 `JOIN memories`」的护栏从「legacy 侧记到 candidate」升级为**字节侧直接暴露 ⇒ 判红**（§3.3 第 2 条）。
* ⇒ **附带（architect-2 独有）**：命中「列集合不可解析」的语句时，**除计数外还要把 SQL 指纹集合打印 + 落盘**（`unclassifiedSqlKinds`）⇒ 否则只知道「有东西没认领」，不知道「是什么」。

### 修正 7（坏码行是「白读」）—— ✅ **采纳（主理人已复核成立）**

* **证据**：`src/vector/ivf.ts:578-586`。
* **最终口径**：断言 1a 的前提（`badCodeRows === 0`）是**真实必要条件**；坏码行 = **读了、搬了字节、却对剪枝毫无贡献**（fail-open 丢弃）⇒ 必须在 `breakdown` 里可见。

### 修正 8（文档说谎）—— ⚠️ **主理人裁决②：本轮【不改 `src/**`】，注释订正转入待办清单**

* **证据**：`src/vector/ivf.ts:1387` 附近的 JSDoc 写着「本方法一次就把 3KB 的 `embedding` 全取回来 ⇒ 在 T04 之后它**只对 survivors 调用**（典型 ~60 行而不是 ~5,521 行）——**这正是收益的来源**」⇒ 但 `readCandidateRows()` 的**唯一**调用点是 `searchExactBuckets()`（`:1110`，`prune=false` 对照分支）⇒ 它读的是**全部 memberIds**（≈ 5,521 行）。
* **裁决②（主理人 2026-11-05）**：**本轮不改 `src/**`，包括这处注释**。理由三条：① 本轮边界是「bench 侧只读观测」⇒ 任何 `src/**` 改动都会把 T06 从「测量装置」变成「生产代码变更」⇒ 需单独回归面；② 那处注释的实质影响已被 T06 覆盖（`memoryRowsRead` 就是「实际读了多少向量字节」⇒ 落盘后读者会看到真实数字 ⇒ 事实覆盖了误导）；③ **零 `src/**` 改动是一个可验证的强纪律** ⇒ 本轮结束时 `git diff --stat src/` 应为空 ⇒ 这本身就是给 QA 的一条断言。
* ⇒ **最终口径**：**注释订正转入 §13 待办清单第 8 条**（T06 之后单独一轮小改）⇒ **本轮 T06-5 不包含 `src/vector/ivf.ts`**。

### 6.9 主理人 2026-11-05 裁决的落点（**与 §1~§5 的对照**）

| 主理人裁决 | 落点 |
|---|---|
| 修正 3（剪枝率方向）**采纳** | §1.7 / §2 断言 1c、1c-bench / §5 |
| 修正 5 的前提**订正**（软删行未物化 ⇒ 未读） | §1.1 末段 / §2 断言 1b 前提 ③ / §6 修正 2、5 |
| 「恒等式成立」＋「是真实搬运量的下界」**两件事合写** | §1.3 理由 3、4、5 / §2 断言 1 / §4 的 `note` |
| `breakdown` **单列 `contentBytes`** | §1.3 末段 / §3.2 登记表 / §4 的 JSON |
| 修正 4（分布形态）**采纳但限定**（字段名 / 容器名沿用 architect-2） | §4 |
| 修正 6 **以 architect-2 的「命中零来源」为准 + 补自检断言** | §3.2（形状登记制）/ §2 断言 3 / §6 修正 6 |
| 修正 1 / 2 / 5 **采纳，要求给可执行方案** | §1.1 / §2 / §3.2 / §3.3 第 3 条 / §6 |
| **剪枝率用 `prune` 的 `exactReads`** | §1.7 / §5 / §8 的 T06-2 —— ⚠️ **本轮追加：改由 bench 侧「调用次数」等价取得 ⇒ 零 `src/**` 改动**（见 §1.7 + 修正 3） |
| **`store.write()` 内部那一笔** 是「不许挪 `uninstall()`」的**真正理由** | §1.5 / §3.3 第 5 条 |
| 合并成**一份**唯一权威文档 | 本文件（文件头） |

### 6.10 ★ 主理人 2026-11-05 第二轮裁决（**四个读数** / **零 `src/**` 改动**）的落点

| 裁决 | 落点 |
|---|---|
| **① ADR §8.5 `:590` 的「三个数」是笔误 ⇒ 按【四个读数】执行**（`:589` 列的就是四个） | §4 的 JSON（四个读数并列）/ §10.1 字段命名表 / §11 第 9 条（待明确：口径按四个）/ ✅ **ADR 已改**（★ 终局裁决 2026-11-05 第 3 号：**3 处量词** · 零数字）⇒ 勘误登记在 §13 待办第 7 条 |
| **② 本轮零 `src/**` 改动**（含注释）⇒ `git diff --stat src/` 必须为空 | 文件头「边界」/ §2 **断言 4**（机器可验）/ §6 修正 8 / §7 文件列表（**删掉** `src/store/dedupCandidates.ts` 与 `src/vector/ivf.ts` 两行）/ §8 T06-5 验收标准 |
| **② 的例外条款**（若工程师的实现**必须**改 `src/**` ⇒ 停下来回传主理人裁决） | §1.7 已给出**免 src 的解法**（`embeddingCalls` ≡ `exactReads`）⇒ ⇒ **本轮不需要动用例外条款**；若工程师实现中发现确实绕不开 ⇒ 立即回传 team-lead |
| **mermaid 两文件的归属**（`docs/class-diagram.mermaid` / `docs/sequence-diagram.mermaid`） | §12 抬头 + §13 待办第 9 条（**归属 = T06 的产物**；与 `docs/design/` 下既有同名文件不冲突） |

### 6.11 ★ 主理人 2026-11-05 第三轮裁决（口径定稿 6 条）+ **写路径两轮制拍板**的落点

| 裁决 | 内容 | 落点 | 状态 |
|---|---|---|---|
| **裁决 1（单轮）** | 「删掉 `samplesAligned` 与断言 1d」 | —— | ⛔ **已撤回**（主理人同日拍板：两轮制成立）⇒ §3.3 第 3 条的「两轮制硬证据」段、§2 断言 1d、§4 的 `samplesAligned` **全部保留**；⚠️ 撤回理由与**我先前的判断错误**记在 §14 的**第 7 条**（合并消解记录表） |
| **裁决 2（剪枝率解法）** | bench 侧数 `get()` **调用次数** + `tests/unit/prune.test.ts` 补等价性单测（**不新开文件**）⇒ **取消** `dedupCandidates.ts` 透传 | §1.7 / §2 断言 1c（含「不新开文件」）/ §6 修正 3 / §7 文件列表（`dedupCandidates.ts` 标「不改」） | ✅ 已确认并落定 |
| **裁决 3（聚合豁免）** | 字节侧**先判聚合** ⇒ 聚合查询命中零来源但**不计入 `unclassified`**（与 legacy 侧对称） | §3.2（聚合豁免条 + 两条实例 SQL：`ivf.ts:687` / `bucketAssign.ts:525`）/ §3.3 第 1 条 / §2 断言 2 | ✅ 落定 |
| **裁决 4（登记表改名 + 定性）** | `legacy` → **`bucketCandidate`**；定性 = 「**仅 `prune = false` 对照分支（A1 / A7）使用 ⇒ 两段式写路径不发 ⇒ 不在 bench 采样窗口内**；登记它是为了**防御**（将来打开对照分支时形状仍能认领 ⇒ 不会静默漏检）」 | §3.2 形状表 + 该表下的定性段 | ✅ 落定（**含紧急勘误**：删掉「写路径候选扫描主体」/「H1′ 字节账的大头」两句 ⇒ §1.5 的「写路径只有 scoreOf 与 Q4 两条」**正确、不改**） |
| **裁决 5（SQL 原文订正）** | 逐字核对 7 条生产 SQL（位置 + 表集合 + 源列集合 + `deleted = 0` 的有无 + 别名） | §1.2（**新增「逐字原文」代码块 + 位置列 + 归一化三步**）/ §3.2（形状键**只由两集合决定** ⇒ WHERE 不进键） | ✅ 落定 |
| **裁决 6（ADR 小标题待办）** | 「双读数并列」实列**四个数**（`memoryRowsRead` / `codeRowsRead` / `bytesRead` / `candidateUniverse`）⇒ 应为「**四读数并列**」；✅ **已改**（★ **终局裁决 2026-11-05 第 3 号** ⇒ 授权恢复并扩到 **3 处量词** ⇒ 理由：ADR §8.5 是**现行口径的所在地**、必须自洽 ⇒ **纯量词、零数字** ⇒ 不触及任何裁决内容） | §13 待办第 7 条（**已修 · 3 处量词**） | ✅ 落定 |
| **拍板（两轮制）** | 采「**口径同源 + 基线不重采**」⇒ 两轮制；**撤回裁决 1** | §3.3 第 3 条（硬证据段 + **三个实现坑**）/ §2 断言 1d（保留）/ §4（`samplesAligned` 保留 + `note` 写明计时口径）/ §11 待明确事项的**第 10 条** | ✅ 落定（⚠️ **只限【写路径】**；读路径本轮【单轮】· HEAD 逐字同形） |
| **断言 1e** | 写路径 `bucketMemberRows === candidateUniverse`（零容差）⇒ 窗口罩错段就红 | §2 断言 1e | ✅ 落定 |
| **① 顶部版本 + 时间戳** | 口径变更**只能回 ① 改** | 文件头「版本 / 时间戳」 | ✅ 落定 |
| **裁决 7（本轮 · ★ 两条事故登记 + 量词勘误状态 + 报告纪律）** | ① **量词勘误：★ 已执行（3 处量词 · 一个数字未动）**（★ **终局裁决 2026-11-05 第 3 号** —— 理由：① ADR §8.5 是**现行口径的所在地**、必须**自洽** ⇒ 改动是**纯量词、零数字**、不触及任何裁决内容；勘误已在 §13 待办第 7 条登记 ⇒ 做成「已修」是**完成登记**，不是绕过登记）：ADR `:588` 段首小标题「双读数并列」→「**四读数并列**」+ ADR `:590` 段内正文「三个数并列」→「**四个读数并列**」+ ADR `:349` §5 ③ 裁决记录单元格「三个读数并列打印」→「**四个读数并列打印**」⇒ **只这 3 个量词**；另 `docs/design/DECISIONS.md` **D11 行**（「三读数并列打印」→「四读数并列打印」，**只这一个词**）⇒ ⚠️ **ADR `:365` 保持原样**（它转述的是**选项 (c) 本身** ⇒ 语境正确、不是勘误对象）⇒ ⇒ **① 内部不再自相矛盾**<br>② ⚠️ **事故登记 A（①② 不同步 ⇒ 实现与权威口径相反）**：「① 已改（形状名 → `bucketCandidate`）/ ② 未同步 ⇒ 工程师按 ② 实现 ⇒ **实现与权威口径相反**」—— 已真实发生（工程师的 `bench/lib/byteSources.ts` 用了 `id: 'legacy'`）⇒ **根因** = ①② 并存时没有「改名必须同批同步」的检查 ⇒ ⇒ **新增纪律**：① 改了口径，**必须同批核对 ② 的对应位置**（或直接写「② 不许维护可独立生效的口径句」）<br>③ ⚠️ **事故登记 B（量词没跟着清单一起数）**：「① `:455` / `:488` 自己写着「应为**三读数**并列」⇒ 与 ① `:441` / `:473` 的「**四个读数**」矛盾」⇒ **根因** = ①② 合并时量词没跟着清单一起数 ⇒ ⇒ **新增纪律**：**清单有几项，量词就写几**（数一遍，不许凭印象）<br>④ **报告纪律**（本项目「消息 ≠ 磁盘」**第五次**复发）：⚠️ ★ **这次是「报得比做得多」** —— 上轮报告称「已改 ADR 两处量词」，但**磁盘上没有那两处改动**（`git diff --stat` 里只有别人的 7 行）⇒ ⇒ ⇒ **新增工序**：凡声称改过某文件 ⇒ **报告里必须贴该文件的 `git diff` 原文输出**（不是复述、不是自己写的 diff 块）⇒ 主理人按 `git diff` 一比即知；另：凡报告出现「我没动 X / X 已是 Y 状态」这类断言 ⇒ **必须带能自证的证据**（`ls -la --time-style=+%H:%M:%S` / `git diff --stat` / `wc -l`）⇒ **无证据的「没动」一律按「可能动过」处理**<br>⑤ ⚠️ **并发工作区禁止任何改工作区状态的 git 命令**：`git stash` / `checkout` / `restore` / `reset` / `clean` ⇒ 隔离验证改用**只读**办法（`git worktree add` / `git show :<path>` / `cp` 到临时目录比对）⇒ **本条对所有成员生效** | §13 待办第 7 条（**保留待办条目 + 订正内容为三处量词**）/ §6.11 **裁决 6 行**（`:455`）/ `DECISIONS.md` **D11 行**（本轮唯一改动的 ADR 外文件）/ `docs/progress/vector-round-progress.md` **A4 行后续列** / `docs/baseline/README.md` **判读指引段** | ✅ 已落定（2026-11-05） |
| **裁决 8（2026-11-05 · 读路径对账量 / 断言 1c-bench 字面 / breakdown 第 13 项 / ADR 下界写进 note）**（★ 其中「第 13 项」= 使清单达到 **13** 项的那一项、⚠️ **在 §4 的 JSON 清单里排在第 5 位** ⇒ 按【位置】读会读错）｜★ **订正（2026-11-05 实测后）**：本条标题里的「**ADR 下界写进 note**」**已被实测推翻** ⇒ ⇒ 那个数现在是【**偏高的估计**】、不是【下界】（⇒ 详见 §6.12 裁决 9 与 §13 第 10 条）| ① **读路径 `samplesAligned` ⇒ 换「有牙的对账量」（不删字段）**：新语义 = **（逐样本）计数器的实测桶成员行 === 由 `route()` 命中桶推算的成员行之和**（`bucketMemberRows` === `bucketMemberRowsDerived`）⇒ **字段名 / 类型 / 落盘结构一律不动** ⇒ ⇒ **不是删一条防线，是把一条假守卫换成真守卫**（删除方案已否决：动静大 + 净效果是少一条防线 ⇒ 与「宁严勿松」相悖）；⇒ ⚠️ **旧写法恒真**（字节样本数 == 召回毫秒样本数 ⇒ 同一个 `for` 循环体内无条件 `push` ⇒ 长度必然相等 ⇒ **永远打不红**）⇒ **已废**；⇒ ⚠️ **不许用 `bucketMemberRows === candidateUniverse`**（★ **本句括号里的理由已被裁决 9 订正** ⇒ 「一个 memory 落在多个命中桶时偏小」的**前提不成立**（唯一索引 `idx_vcm_memory_unique` ⇒ 一记忆只属一桶 ⇒ 同批桶内 `COUNT(DISTINCT) == COUNT(*)`）⇒ **禁令本身不变**、**理由改为「来源不同 ⇒ 混用会掩盖真正的失配」** ⇒ 详见 §6.12 裁决 9 / §11 第 13 条）<br>② **断言 1c-bench 字面形式改**：`embeddingCalls ≥ embeddingRowsRead` ⇒ **`embeddingCalls ≥ embeddingExactRows`**（`embeddingExactRows` = `scoreOf` 返回了行的次数）⇒ ⚠️ **不许用 `embeddingRowsRead` 当比较对象**（它是**字节账分子**、含 Q4/Q5 的 survivors 整行 ⇒ 写路径下必然大于 `embeddingCalls` ⇒ 用它比对会**恒红** ⇒ 口径会写出一条在自己实现上就不成立的断言）⇒ 读路径下 `embeddingCalls ≥ embeddingRowsRead` 仍成立 ⇒ 可作**读路径加强形式**保留<br>③ **breakdown 第 13 项 `embeddingExactRows`** ⇒ 补进 §4 清单 + ② 字段表（**口径必须跟上实现**，否则落盘结构测试「键名一个都不许少」与口径互相打架）<br>④ **ADR §8.6 的 `4.44 MB` 是【下界】** ⇒ **不改口径**，但在 §4 的 `note` 里**显式写明**（写路径 survivors 的 `embedding` 被读**两次**：`scoreOf` 一次 + Q4 整行批量再一次 ⇒ 实测 > `4.44 MB` **属预期、不是回归**） | §2 断言 1d（扩写 = 写路径两轮 + 读路径对账 + 三条理由原文）/ §2 断言 1c-bench（字面形式）/ §4 breakdown 清单（13 项）/ §4 写路径 `samplesAligned` 注释 + `note`（4.44 MB 下界）/ §4 读路径 `vectorRouteByteReads.breakdown` 与 `note` / ② §10.1 字段表 + ② 断言写法表 | ✅ 已落定（2026-11-05） |


### 6.12 ★ T07 开工前裁决（**断言 1d 理由③ 的理由替换** + **唯一索引事实登记** · 零数字改动）

> **背景（为什么要先裁决）**：① §2 的**断言 1d 理由③** 与 **断言 1e** 对**同一件事**给了**对立结论** —— 前者说「一个 memory 落在多个命中桶时 `COUNT(DISTINCT)` 会小于成员行总数 ⇒ 1M 规模下不成立 ⇒ 不许用这个比较」，后者说「一个记忆只属于**一个**细桶 ⇒ 桶间不重复 ⇒ 两者必然相等」⇒ ⇒ **必须先裁决**，否则下一轮（重写守卫）会踩同一个坑。
> ⇒ ★ **本节只改【理由】，不改任何门槛值、不改禁令的效力**。

| 裁决 | 内容 | 落点 | 状态 |
|---|---|---|---|
| **裁决 9（T07 开工前 · ① 内部自相矛盾的裁决）** | ① ★ **禁令不变**：读路径**仍然禁止**用 `bucketMemberRows === candidateUniverse` 当对账量<br>② ★ **理由替换**：理由**不是**「`COUNT(DISTINCT)` 会偏小」，而是 ★ **两个量【来源不同】** —— `bucketMemberRows` = **计数器实测**（`search()` 侧真正扫的那批桶）；读路径 `candidateUniverse` = `COUNT(DISTINCT memory_id)`（**计时窗口之外**、用**外层 `route()` 的 fineIds** 算）⇒ ⇒ 互比**会把「`search()` 内部路由 ≠ 外层 `route()` 路由」这个真正的失配掩盖掉** ⇒ ⇒ **那正是这条守卫唯一该抓的东西**（理由①）⇒ ⇒ **混用 ⇒ 守卫失明**<br>③ ★ **本轮查到的 schema 事实（推翻了理由③ 的【前提】）**：`vector_cell_members` 上有**唯一索引** `idx_vcm_memory_unique`（`src/db/schema.sql.ts:352` / `schema/001_schema_v2.sql:335` / `schema/002_migration_v1_to_v2.sql:129`）⇒ **一条记忆只属一个细桶**（schema 注释自称「一条记忆只属一个细桶的最终防线」）⇒ ⇒ **同一批桶内 `COUNT(DISTINCT memory_id)` 恒等于 `COUNT(*)`（= 成员行总数）** ⇒ ⇒ **「会偏小」这个前提在当前 schema 下【不成立】** ⇒ ⇒ ⚠️ **被推翻的是「前提」，不是「禁令」**<br>④ ⚠️ **防御性理由保留但降级**：唯一索引是 **schema 级不变式** ⇒ **可被人工 `DROP`**（老库迁移前也可能缺）⇒ ⇒ 「它可能偏小」**只作纵深防御**，**不许**写成当前事实<br>⑤ ★ **对齐断言 1e**：断言 1e 讲的是**写路径**（★ **同源 ⇒ 必然相等** ⇒ 零容差可判红）；断言 1d 讲的是**读路径**（★ **异源 ⇒ 禁止互比**）⇒ ⇒ **两件事、两条规则** ⇒ ⇒ 「一个记忆只属于一个细桶」在断言 1e 里**降级为支撑事实**（它保证 `COUNT(*) == COUNT(DISTINCT)`），**不是**「必然相等」的根据<br>⑥ **② 同步**：② §10.3「读路径对账 1d」那一格有**同一处措辞** ⇒ 已同批改；② §10.1 字段表与 §8 的 T06-2 验收第 9 条**只写了禁令没写理由** ⇒ 已补「异源」的理由指向<br>⑦ ★ **留痕**：这是本项目「**口径自己会错**」的又一次实例（⇒ **被推翻的是前提、不是禁令** ⇒ ⇒ 留痕时必须写清这一点，否则下一个人会以为「禁令也作废了」） | ① §2 断言 1d 理由③ / ① §2 断言 1e / ① §4 读路径 `note` / ① §6.11 裁决 8 行（加订正标注）/ ① §11 第 13 条 / ② §8 T06-2 验收第 9 条 / ② §10.1 字段表 / ② §10.3 断言写法表 | ✅ 已落定（T07 开工前）<br>⑧ ★ **两条追加留痕（2026-11-05 实测后 · 见本表正下方的留痕块）**：**留痕 A** = 「实测低于它 **8~13%**」这个**区间是刻意选的**（同时兜住 `4.44 MB` 的两种单位约定）⇒ ⇒ ★ **不许把它「优化」成别的数**；**留痕 B** = 实测值**可复算**（`bytesRead = 码行数 × 768 B + embedding 行数 × 3,072 B`）⇒ ⇒ 任何人可独立对账 |
| **裁决 10（T07 收尾 · 这条禁令的【可验证形态】）** | ★ **背景（QA 负控挖出来的真缺口）**：① §2 理由③ 只写了「**不许**用 `bucketMemberRows === candidateUniverse`」⇒ ⇒ **没写「这条禁令的可验证形态是什么」** ⇒ ⇒ ⇒ **下一个人照着「同一列 ⇒ 不成立」的直觉去写断言 ⇒ 会写出一条【恒假】的断言**（判定层的「数值不等」在真实数据上恒假 ⇒ **必红** ⇒ 不是有效断言）<br>① ★ **可验证形态 = 在【接线层】按【来源】验**（把两列**人为改不同** ⇒ 看接线**喂了哪一列**）⇒ ⇒ ★ **不是**在判定层按【数值】验<br>② ★ **判定层的「数值不等」断言恒假**（唯一索引 ⇒ `candidateUniverse` 与 `bucketMemberRows` 数值恒等）⇒ ⇒ **不许那样写**<br>③ ★ **变异 E 的教训**：把两列接成**同一列** ⇒ ⇒ 在**接线层**对账确实失效、但在**判定层**判不出来（两数组逐位相等 ⇒ 判定仍给 `true` ⇒ ⇒ **打不红**）⇒ ⇒ ⇒ ⇒ ⇒ **「同一列 ⇒ 不成立」在【接线层】成立、在【判定层】不成立**<br>④ ★ **落点**：守卫 = `tests/bench/t06-prune-rate-wiring.test.ts` 的 **§D**（接线 · 按来源验）+ **§E**（负控 · 把两列人为改不同）⇒ ⇒ ⚠️ **口径引用只写【章节 / 用例名】· 不许写行号**（会漂移）<br>⑤ **② 同步**：② §10.1 字段表 `samplesAligned` 行 + §10.3「读路径对账 1d」行（打什么变异那栏）⇒ 已同批补 | ① §2 断言 1d 理由③（新增「可验证形态」层）/ ② §10.1 字段表 / ② §10.3 断言写法表 / ① §11 第 14 条 | ✅ 已落定（T07 收尾） |

> ⇒ ⇒ ★★★ **裁决 9 的两条追加留痕（2026-11-05 实测后 · 主理人点名登记 · 零门槛值改动）**：
>
> **留痕 A —— 「实测低于它 8~13%」这个【区间】是刻意选的 ⇒ ⇒ ⇒ 不许「优化」掉**：
> ⚠️ 那个 `4.44 MB` 在 ADR 里**没有写单位约定** ⇒ ⇒ ⇒ 它有两种读法 ⇒ ⇒ ⇒ **两条读法都落在「实测低于它 8~13%」这个区间里** ⇒ ⇒ ⇒ ⇒ ⇒ **这个区间是【同时兜住两种单位约定】而选的**：
> · 【读法一】`4.44 MiB` = **4,655,677 B** ⇒ ⇒ 差 (4,655,677 − 4,065,792) ÷ 4,655,677 = **12.67%**；
> · 【读法二】`4.44 MB` = **4,440,000 B** ⇒ ⇒ 差 (4,440,000 − 4,065,792) ÷ 4,440,000 = **8.43%**；
> ⇒ ⇒ ⇒ ★ **实测 4,065,792 B 低于它 8.43% ~ 12.67%** ⇒ ⇒ ⇒ ★ **写成「8~13%」正是为了让【两种读法都不用改文案】** ⇒ ⇒ ⇒ ⇒ ⇒ ⚠️ **不许把它「优化」成别的数**（例如改成「约 10%」「低了 12%」「低 8.43%」「低于下界 17%」等）⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ★ **一旦只写死其中一种读法，另一种读法下这句话就变成错的** ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⚠️ **这条是【区间】、不是【近似值】** ⇒ ⇒ ⇒ 区间两端各留了一点余量（8.43% → 8%；12.67% → 13%）⇒ ⇒ ⇒ ⇒ ⇒ **不许收窄成单值** ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ★ **动这个区间之前先回到本条**。
>
> ⇒ ⇒ ⇒ ★★★ **附：「只读了 2 行」的真实含义是「【至多】2 行」**（★ 主理人 2026-11-05 点名 · **证据是分布、不是 `max`**）：
> ⚠️ 写路径 `embeddingRowsRead` 的**完整分布** = `{count 200, min 0, mean 1.09, p50 2, p99 2, max 2}` ⇒ ⇒ **200 个样本里【没有一个】超过 2 行** ⇒ ⇒ ⇒ ⇒ ⇒ ★ **所以口径里一律写「至多 2 行」**（⚠️ 「只读了 2 行」是**单样本**的说法 ⇒ ⇒ 会被读成「恰好是 2」⇒ ⇒ **与分布不符**）⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ★★ **⇒ ADR §8.6 假设的「每轮 64 次精确重排」被否得更彻底**：实测 `max` 只有 2 ⇒ ⇒ **差 32 倍** ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ★ **落盘 `note` 已同步改成「至多 2 行」**（2026-11-05 · 工程师落盘 `bench/perf.ts` + 同批改 impl-notes §13 的逐字副本 ⇒ ⇒ ⇒ `check-json-note-fidelity.ts` 仍报 **WRITE: true / READ: true** ✅ ⇒ ⇒ ⇒ ⇒ ★ **本条为「机制已跑通」的第二例**：改落盘 `note` ⇒ ⇒ **同批**改逐字副本 ⇒ ⇒ 守卫不回红）。
>
> **留痕 B —— 实测值【可复算】 ⇒ ⇒ ⇒ 任何人可独立对账**：
> ★ **恒等式**：`bytesRead = 码行数 × 768 B + embedding 行数 × 3,072 B`（⇒ ⇒ 只数向量载荷那两个 BLOB：码 + embedding ⇒ ⇒ 与 §11 第 1 条「不含正文」同源 ⇒ ⇒ 与 §4 `note` 里的「bytesRead = 向量载荷字节（码 + embedding 两个 BLOB 的实测 byteLength）」同源）⇒ ⇒ ⇒ **2026-11-05 实测两笔逐位对上**：
> · ★ **写路径**：`5,286 × 768 + 2 × 3,072 = 4,059,648 + 6,144 = 4,065,792 B` ⇒ ⇒ **与实测 `bytesRead.max = 4,065,792 B` 逐位相等** ✅；
> · ★ **读路径**：`9,079 × 768 + 85 × 3,072 = 6,972,672 + 261,120 = 7,233,792 B` ⇒ ⇒ **与实测 `bytesRead.max = 7,233,792 B` 逐位相等** ✅ ⇒ ⇒ ★★ **但 `85` 这个数是【最坏样本】**：读路径 `embeddingRowsRead` 分布 = `{count 200, min 42, mean 42.475, p50 42, p99 57, max 85}` ⇒ ⇒ **`max` = 85（最坏）· `p50` = 42（典型）** ⇒ ⇒ ⇒ ⇒ **7,233,792 B 是最坏情况的数字**（不是典型值）⇒ ⇒ ⇒ ⇒ ⇒ ★ **⇒ 读路径【不判门槛】+ 判定取 `max` ⇒ ⇒ 方向【偏严】⇒ ⇒ ⇒ 「读路径不判门槛 · 观测值」这个措辞是正确的** ✅ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⚠️ **别把读路径的 `max` 当成「典型成本」去对外承诺**。
> ⇒ ⇒ ⇒ ★ **所以任何一个 `bytesRead` 都必须能被「码行数 × 768 + embedding 行数 × 3,072」拆出来** ⇒ ⇒ ⇒ ⇒ ⇒ **复算步骤（任何人独立可做）**：① 取同批样本的 `codeRowsRead`（写路径它 == `candidateUniverse`，同源）；② 取 `breakdown.embeddingRowsRead`；③ 代上式算；④ **与同批 `bytesRead` 逐位比对** ⇒ ⇒ ⇒ 不等 ⇒ ⇒ ⇒ **说明字节账不完整**（漏了某一项 / 有行没计数）⇒ ⇒ ⇒ ⇒ ⇒ ★ **这是判「口径自洽」最省事的一把尺**（比对着 ADR / 旧基线更硬 ⇒ ⇒ ⇒ 不依赖任何历史数字）⇒ ⇒ ⇒ ⚠️ **对账只认【写路径】的 `codeRowsRead`**（读路径的 `candidateUniverse` 与计数器**异源** ⇒ ⇒ **不许**用它代入本式 ⇒ ⇒ ⇒ 详见 §11 第 13 条）⇒ ⇒ ⇒ ⚠️ **写路径用 `codeRowsRead` 还是 `candidateUniverse` 都一样**（同源 ⇒ 必然相等 ⇒ 零容差）—— ★ 但**读路径没有这个等价性**，别顺手套过去。


## 11. 待明确事项（**每条都给出可执行的默认答案** · 不把球踢回来）

| # | 事项 | **默认答案（本轮照此施工）** | 依据 |
|---|---|---|---|
| 1 | `bytesRead` **含不含正文**？ | **不含**（只计向量载荷：`code` + `embedding` 两个 BLOB） | ADR §8.5 理由③ 的「`N 行 ⇔ 3072N 字节`」**只在只数向量载荷时成立**；且排除它 ⇒ **是下界 ⇒ 偏严不假绿** |
| 2 | **页字节**还是**逻辑载荷字节**？ | **逻辑载荷字节**（不含 SQLite 行头 / 页开销 / 索引 b-tree） | ① 页口径把 768 B 的码读放大成一整页 ⇒ **惩罚窄码** ⇒ 违反 ADR §8.5 理由②；② `better-sqlite3` **不暴露** per-statement 页计数 ⇒ **不可实现** |
| 3 | 旧的行数判据**保留还是废弃**？ | **废弃判定、保留常量与观测** | C′ 的 `scanned` = 候选宇宙 ≈ 5,521 ⇒ 恒红 ⇒ 留着当判据 = 本档永远无法交付；删常量 = 制造「同一个门槛两个名字」的镜像问题 |
| 4 | **召回路径**要不要也计字节？ | **要，但只作观测、不判门槛** ⇒ 顶层 `vectorRouteByteReads` | 与 `candidateReadRows` / `hitFineBuckets` 同属「召回路径的向量扫描」这一组 |
| 5 | **剪枝率**要不要在 T06 一起落？ | **落，且作为软阈值进 `failures`**（标签 `（PRUNE_RATE）`，阈值 0.15）⇒ 分子 = **`embeddingCalls`（`get()` 调用次数）** | 它是出关条件① 的一半；T07 只跑不改码 ⇒ 落盘放 T06 成本近零；⚠️ 分子必须用调用次数，否则偏松 ⇒ 假绿 |
| 6 | **能不能改 `src/store/**`**？ | **不能**（裁决 ②：零 `src/**` 改动）⇒ 剪枝率分子改由 bench 侧「调用次数」等价取得（§1.7）+ tests 侧等价性单测（断言 1c） | 主理人裁决 ②（2026-11-05 第二轮）⇒ 本轮 `git diff --stat src/` 必须为空 |
| 7 | 设计稿 §5.1.2 要求**实测 Q1 的 50 B/行** ⇒ 落在哪？ | 本轮**只落行数**（`bucketMemberRows`）⇒ 字节不进判据 | 成员标识不是向量载荷；实测 UTF-8 优于「声明长度 36」 |
| 8 | `bytesReadTotal`（含正文的全量字节）本轮做不做？ | **不做**；改用 `breakdown.contentBytes` 单列**正文那一项**（Q4 ≤ 20 行 ⇒ 便宜） | 免掉 O(n) 文本扫描 + 免掉第二套字节口径；而「下界差多少」的关键项（正文）已可见 |
| 9 | ADR §8.5 的「**三个**数并列」是不是笔误？ | **是笔误 ⇒ 按【四个读数】执行**（`:589` 列的就是四个）⇒ ✅ **ADR 已改**（终局裁决 2026-11-05 第 3 号：**3 处量词** · 零数字），勘误登记在 §13 待办第 7 条 | 主理人裁决 ①（2026-11-05 第二轮）+ **终局裁决（第 3 号）**；`:589` 是口径本身、`:590` 是行文疏漏 |
| 10 | 字节计量**放计时窗口内还是外**？ | **外**（⚠️ **只限【写路径】** —— **读路径本轮单轮**，字节计量与行读计数**同处一个计时窗口**，见 §3.3 第 3 条的读路径硬证据）：写路径**两轮制**（轮 A 计时**连计数器都不装** / 轮 B 计量装计数器，**同一份输入**）⇒ 计时窗口**完全干净** ⇒ `samplesAligned` 有牙（断言 1d）；⚠️ 两条前提：**轮 A 与轮 B 之间不得有任何库写入**（否则 `samplesAligned` 恒红）/ **轮 A 的计时区间内不得有任何逐行计数开销** | 修正 5 的最终方案 + 工程师第一段已实现的两轮制 + 主理人拍板（2026-11-05）；当场累加标量解决 OOM，两轮制解决计时干净，**两件事正交**；⚠️ **理由是「口径同源」不是「怕代理开销」**（§3.3 第 3 条的 HEAD 证据：旧写路径扫描段本就无计数器 ⇒ 单轮 = 改口径 = 基线要重采） |
| 11 | `store.write()` 内部那一笔要不要单独落盘？ | **不落盘，但必须在 `note` 里说明**（两笔都在，只有一笔是判据量） | 它已被 `writeTotal` 计时覆盖；且它与独立实测段**同一量级**、独立实测段**略偏悲观 ⇒ H1′ 偏严** |
| 12 | 剪枝率分子要不要改 `src/store/dedupCandidates.ts` 透传 `exactReads`？ | **不改**（裁决 ②）⇒ 用 bench 侧 `get()` **调用次数**（定义上 == `exactReads`）+ tests 侧等价性单测代偿 | §1.7 的三条推理 + `prune.ts:289-290` 一一对应 ⇒ **零 src 改动即可拿判据分子** |
| 13 | 读路径**为什么**不许用 `bucketMemberRows === candidateUniverse`？ | ★ **理由 = 两个量【来源不同】**（计数器 `search()` 侧实测 vs 外层 `route()` 侧的 `COUNT(DISTINCT memory_id)`）⇒ ⇒ **互比会掩盖「`search()` 内部路由 ≠ 外层 `route()` 路由」这个真正的失配** ⇒ ⇒ **守卫失明** ⇒ ⇒ **禁令不变、理由换成这一条**（★ 原理由「`COUNT(DISTINCT)` 会偏小」的**前提已被推翻** ⇒ ⇒ 详见 §6.12 裁决 9） | ★ **本轮查到的 schema 事实**：`vector_cell_members` 上有**唯一索引** `idx_vcm_memory_unique`（`src/db/schema.sql.ts:352` / `schema/001_schema_v2.sql:335` / `schema/002_migration_v1_to_v2.sql:129`）⇒ **一条记忆只属一个细桶** ⇒ ⇒ **同一批桶内 `COUNT(DISTINCT memory_id)` 恒等于 `COUNT(*)`（= 成员行总数）** ⇒ ⇒ **「会偏小」这个前提在当前 schema 下【不成立】** ⇒ ⇒ ⚠️ **但索引可被人工 `DROP`**（老库迁移前也可能缺）⇒ ⇒ 「它可能偏小」**只作【防御性】理由**，**不许**写成当前事实 ⇒ ⇒ ★ **另**：`src/vector/bucketAssign.ts:24` 的注释（「唯一索引只保证『写不进去』，保证不了『不重复』」）与本条**不冲突**（它讲的是『写不进去』vs『静默重复』）⇒ ⇒ **不许**把它当成「一记忆可属多桶」的证据 ⇒ ⇒ 本轮**不改** `src/**`（零 `src/**` 改动）⇒ ⇒ ⇒ ★★★ **交叉引用（★ 同类「拿错字段」陷阱的另一半 · 写路径）**：断言 1b 的 `bytesRead === codeRows × 768 + candidateRows × 3,072` 里的 **`candidateRows` 是【legacy 计数器】口径**（写路径 == `memoryRowsRead`）⇒ ⇒ **它【不是】落盘的 `candidateUniverse`** ⇒ ⇒ ⚠️ 1M 档实测：落盘 `candidateUniverse.max` = **5,286**，而 `memoryRowsRead.max` = **2** ⇒ ⇒ ⇒ **误拿 `candidateUniverse` 代入 ⇒ `5,286 × 768 + 5,286 × 3,072 = 20,298,240` ≠ 实测 `4,065,792` ⇒ ⇒ 【恒红】** ⇒ ⇒ ⇒ ★ **两处互相指认（★ 一处错了另一处能看见）**：**本条**讲【读路径不许拿 `candidateUniverse` 当对账量】· **② §10.3「交叉校验 1b」行**讲【写路径的 `candidateRows` 不是 `candidateUniverse`】⇒ ⇒ ⇒ ★ **两者是同一族病（近名字段拿错）⇒ ⇒ 同一个根**：**字段名长得像 ⇒ 抄错时【不会偏松、只会恒红】** ⇒ ⇒ ⇒ ★ 恒红是好事（一上来就暴露、不会静默放过）⇒ ⇒ ⇒ 详见 ② §10.3 与 ② §8 T06-2 验收第 3 条。 |
| 14 | 这条禁令的**可验证形态**是什么（怎么验才抓得住）？ | ★ **在【接线层】按【来源】验**（把两列**人为改不同** ⇒ 看 `measured` / `derived` 各自取自哪一列）⇒ ⇒ ★ **不在判定层按【数值】验**（★ 判定层的「数值不等」断言**恒假** ⇒ **必红** ⇒ **不许**那样写）⇒ ⇒ ⇒ ★ **已落地的守卫**：`tests/bench/t06-prune-rate-wiring.test.ts` 的 **§D**（接线）+ **§E**（负控）⇒ ⇒ ⚠️ **引用只写章节 / 用例名 · 不许写行号** | ★ **唯一索引** ⇒ 一条记忆只属一细桶 ⇒ ⇒ 同一批桶内 `COUNT(DISTINCT memory_id)` **恒等于** `COUNT(*)` ⇒ ⇒ **`candidateUniverse` 与 `bucketMemberRows` 在真实数据上数值恒等** ⇒ ⇒ ⇒ **按数值验 ⇒ 恒假 ⇒ 必红** ⇒ ⇒ ⇒ ★ **变异 E**（本轮 QA 负控）：把两列接成**同一列** ⇒ ⇒ 判定层**打不红** ⇒ ⇒ ⇒ ⇒ ⇒ **所以这条禁令只能在接线层抓** ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ **完整裁决见 §6.12 裁决 10** |


## 13. 待办清单（**本轮不做**的事 · 留给后续单独一轮）

1. ★ **真实写入（`store.write()` 内部）的字节数未落盘**：生产写入内部自己就会走向量候选扫描（`src/store/write.ts:671` → `collectDedupCandidates()`（`dedupCandidates.ts:400`）→ `:423` → `collectVectorCandidates()`（`:295`））⇒ **那一笔的 `bytesRead` 未被单独观测**（已被 `writeTotal` 的计时覆盖）⇒ ⇒ **H1′ 判的是 bench 的独立实测段**（§1.5）⇒ **若将来要判「一次真实写入的字节预算」**，需**另设观测点**（例如在 `store.write()` 的写入循环窗口内另装计数器 —— ⚠️ 但那会把代理开销落进写入 P99 ⇒ 需另行设计取数方式）。
2. **坏码行（`code.byteLength ≠ 768`）**：计数器可自行检出（`badCodeRows`）⇒ **不必改 `src/**`**；`badCodeRows > 0` ⇒ 断言 1a 的前提不成立 ⇒ **报前提违例（红）**，不许拿它判绿。
3. **读路径 `candidateUniverse` 的等价前提**（overlay 空 / 不带 filter ⇒ Q3 不发 ⇒ `COUNT(DISTINCT memory_id)` == `memberIds.size`）⇒ **前提必须写进 note**；若将来给 `backend.search()` 加带时间窗的 filter，Q3 会发 ⇒ 该值**不再等于** `memberIds.size` ⇒ 那时必须改成「gate 之后的数」。
4. **ADR §8.6 的读路径预估**里那 `0.20 MB`（「Q4/Q5 批量读 survivors」）**在读路径上并不存在** ⇒ architect-2 已在 ADR §8.6 表后加订正段（**正文数字未改** ✅）⇒ **已闭合**。
5. **`pnpm check:params` 恒 60 项** ⇒ 本备忘**不加任何 `Params` 键** ⇒ 工程师注意别顺手加。
6. **形状登记表的维护**：新增一条生产 SQL（改了 SELECT 列表）⇒ **必须同批登记** ⇒ 否则它会落进 `unclassified` ⇒ **判红**（这是**期望行为**，不是误报）⇒ ⇒ 但**必须有人负责同批登记**（与既有纪律「加表 = 必须同批扩展 `classifyReadKind()`」同源）。
7. ✅ **已修（2026-11-05 · 只改 3 处量词 · 一个数字未动）** —— ★ **ADR 的措辞勘误**（主理人裁决 ① + 裁决 6 ⇒ 最初定的是「**不改 ADR 文件**」；★ **终局裁决（2026-11-05 第 3 号）改为「改」** —— 理由：① ADR §8.5 是**现行口径的所在地**、必须**自洽**；改动是**纯量词、零数字**、不触及任何裁决内容；勘误已在本条登记 ⇒ 做成「已修」是**完成登记**，不是绕过登记）：同一段里有**三处**量词与它们各自实际列出的读数个数**不一致** ⇒
   · **段首小标题**（`:588`）写「**双读数**并列」，而它下面列的是**四个**（`memoryRowsRead` / `codeRowsRead` / `bytesRead` / `candidateUniverse`）⇒ ⇒ **已改为「四读数并列」**；
   · **下一句**（`:590`）写「⚠️ 判定只看 `bytesRead`，但**三个**数并列」，而它列的是**四个** ⇒ ⇒ **已改为「四个读数并列」**；
   · **`§5 ③` 裁决表单元格**（`:349`）写「判字节，但**三个读数并列打印**」⇒ ⇒ **已改为「四个读数并列打印」**（★ 它后面跟着「（§8.5）」⇒ 是**引用现行口径**、不是转述选项 (c) ⇒ §8.5 是四个 ⇒ 这句必须是四个）。
   ⇒ ⇒ ⚠️ **不改 ADR 之外任何数字**（`6,144,000` / `3,072` / `0.2%` / `4.44 MB` / `2,000 行` / **§8.6 预估表** / 订正段全部原样）⇒ ⇒ **执行时一律按【四个读数】**（`memoryRowsRead` / `codeRowsRead` / `bytesRead` / `candidateUniverse`）。
   ⇒ ⇒ **原文保留在案**：本条最初写的是「§8.5 的措辞勘误（★ 待办 · 保留条目）… **不改 ADR 文件** … **将来若有人整理 ADR，三处一并改掉**」⇒ ★ **那段「待办」状态已终结**（三处均已改）⇒ 但**「只改量词、一个数字不许动」这条约束原文照旧有效** ⇒ 且 §11 第 9 条「按【四个读数】执行」**始终有效**。
   ⇒ ⇒ ⚠️ **`:365`（「判据可以升级（如 §5 ③ 的 (c)：双读数并列），但不许降级」）⇒ 保持原样、一个字不动** —— 它转述的是**选项 (c) 本身**的措辞（码行 + 记忆行 = 2 个读数）⇒ **语境正确，不是勘误对象**。
8. ★ **`src/vector/ivf.ts:1387` 附近的过期 JSDoc**（说「`readCandidateRows()` 在 T04 之后**只对 survivors 调用**（典型 ~60 行）」⇒ **实际它只被 `prune = false` 的对照分支 `searchExactBuckets()`（`:1110`）调用** ⇒ 读的是**全部 memberIds**（≈ 5,521 行）⇒ **归因也错了**：收益的来源是「两段式让 `searchPruned` 不再调用它」，不是「它只被 survivors 调用」）⇒ ⇒ **主理人裁决 ②：T06 本轮不改 `src/**`（含注释）** ⇒ ⇒ **T06 之后单独一轮小改**（只改注释、零逻辑）。
9. ✅ **已订正（2026-11-05 · 归属方向明确）** —— **两张 mermaid 图的归属**：`docs/class-diagram.mermaid` / `docs/sequence-diagram.mermaid` 是 **② §12 的【抽取副本】**（便于独立预览）⇒ ★ **权威版 = ② §12**（`docs/design/perf-c2-t06-byte-metering-spec.md` §12）⇒ ⇒ **两者不一致时一律以 ② §12 为准** ⇒ ⇒ **不要在副本里改内容**（要改改 ② §12，然后重新抽取）⇒ ⇒ 与 `docs/design/` 下的任何同名文件无关、不冲突 ⇒ 若将来 `docs/design/` 下也出现同名文件，须在两处互注来源。
10. ✅ **已订正（2026-11-05 实测后）**：ADR §8.6 那个 `4.44 MB` 是【偏高的估计】、不是【下界】（它按「每轮 64 次精确重排 × 3,072 B」估 ⇒ 而 **2026-11-05 实测精确分【至多】2 行**（★ 200 个样本 `embeddingRowsRead` 的 min 0 / p50 2 / p99 2 / max 2 ⇒ ⇒ **没有一个超过 2 行**⇒ ⇒ **比 ADR 假设的 64 次少 32 倍**）⇒ 实测 4,065,792 B 低于它 8~13%）⇒ ⇒ **实测低于它属预期、不是回归**（★ 原文给的理由「本表漏了 Q4 批量读 survivors 那一项」**不成立** ⇒ ⇒ 真理由 = **那个 0.20 MB 假设了每轮 64 次精确重排** ⇒ ⇒ 「漏项」不是原因）⇒ ⇒ 已在 §4 的 `note`、② T06-3 验收第 6 条与 architect-2 的 ADR 订正段里写明。⇒ ⇒ ⇒ ★ **「8~13%」这个【区间】是刻意选的**（同时兜住 `4.44 MB` 的两种单位约定：4.44 MiB = 4,655,677 B ⇒ 差 12.67%；4.44 MB = 4,440,000 B ⇒ 差 8.43%）⇒ ⇒ ⇒ ★ **不许把它「优化」成别的数 / 不许收窄成单值** ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ 详见 §6.12 裁决 9 下方「留痕 A」⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ★ **附**：实测值本身**可复算**（`bytesRead = 码行数 × 768 B + embedding 行数 × 3,072 B`）⇒ ⇒ ⇒ 详见同处「留痕 B」。
11. ✅ **已部分落地（2026-11-05）** —— ★ **机器守卫（QA 的 P3 建议）**：**凡写「读路径 `samplesAligned`」的注释，必须同时出现 `readSamplesAlignedOf` 或「桶成员行」** ⇒ ⇒ **已落成一条测试断言**（`tests/bench/t06-byte-metering.test.ts` · 扫描 `bench/perf.ts` 源码文本 · 短语所在行的 **±3 行窗口**内必须出现否定标记 ⇒ 否则判「说谎」· 配两个负控：喂「提到却没否定」必抓 / 喂「提到并否定」必不抓）⇒ ⇒ ★ **它住在 `tests/` 里 ⇒ 随 `pnpm test` 每次 verify 都跑**（不动 `scripts/`、不动 `package.json`、不动 `verify` 链 ⇒ **零越界**）⇒ ⇒ ★ **本轮就栽过一次**：`bench/perf.ts` 的 `buildVectorByteReads` 的 `@param samplesAligned` JSDoc，修复前写的是「读路径 = 单轮 ⇒ 字节样本数 == 计时样本数」（工程师已于 21:38 修掉）⇒ ⇒ ★ **剩余留给 T07**：把这条守卫**泛化**到「凡写『某判据量』的注释必须同时给出它的算法」⇒ ⇒ ★ **T07 的头一件事**：复验那条 **20/20 逐位相等**的等式在 **1M 档**还成不成立。
12. ★⚠️ **【覆盖缺口】① §4 的 `note` 段没有被「逐字保真」守卫覆盖** ⇒ ⇒ **事实（已核实）**：① §4 那段 JSON 里的 `note` 是**压缩过的【结构示意】**（整块带 `{ /* … */ }` 占位符、条目被合并、无 ① ② ③… 编号）⇒ ⇒ **它与真实落盘的 `note` 字符串【从来就不逐字一致】** ⇒ ⇒ ⚠️ **所以「① §4 必须与真实落盘逐字一致」这条要求对它【不成立】** ⇒ ⇒ ⚠️★ **不许拿 ① §4 去替换 `bench/perf.ts` 的真实 `note` 字符串**（⇒ 会丢掉真实 note 里的 ① ② ④ ⑦ 各项、⑤ 的后半句、⑥ 的「方向纪律」半句、⑧ 的细则 ⇒ ⇒ **净损失**；⇒ 且 impl-notes §13 的逐字副本会立刻失配 ⇒ ⇒ `.tmp/bench/check-json-note-fidelity.ts` 立刻报 false ⇒ ⇒ **T07 一跑就红**）⇒ ⇒ ★ **真正的逐字副本在 `docs/design/perf-c2-t06-byte-metering-impl-notes.md` §13**（两段 `note`）⇒ ⇒ **那条自检脚本只读「impl-notes §13 + `bench/perf.ts`」两个文件 ⇒ ⇒ ① §4 完全在它的覆盖范围之外** ⇒ ⇒ ★ **这就是本条登记的覆盖缺口**：**① §4 里那几句实质口径句（禁令 + 理由）与真实落盘 `note` 的关系，没有任何机器守卫** ⇒ ⇒ ★ **待办（已发生 ⇒ 不是假设 · 且已跑通）**：**落盘 `note` 走「自解释」这条路是对的**（⇒ 禁令句已写进 `bench/perf.ts` 的真实 `note` 字符串）⇒ ⇒ **那一瞬间 impl-notes §13 的读路径 `note` 逐字副本没跟上** ⇒ ⇒ `.tmp/bench/check-json-note-fidelity.ts` **当场报 false**（读路径那段在中间失配 ⇒ ⚠️ **它只在 `.tmp/` 里 ⇒ 仓库里没有 ⇒ 提交态跑不到**）⇒ ⇒ ★ **同批更新后即回绿**（⇒ 当前 true / true）⇒ ⇒ ⚠️★ **「改 `note` 字符串 = 改【落盘产物】⇒ ⇒ 逐字副本与实现必须同批」这条机制已获实战验证** ⇒ ⇒ **本条转为长期纪律：以后任何人改 `note` 字符串，都必须同批改 impl-notes §13**<br>⇒ ⇒ ★ **附「口径 ↔ 实现同批必改」清单（裁决 9 换理由之后）**：写旧理由的注释在 `bench/perf.ts` 里共**三处** —— ① `VectorByteSample` 接口的 JSDoc（**已改**）；② `readSamplesAlignedOf(...)` 调用上方那处行内注释（**已改**）；③ `readSamplesAlignedOf()` 的 JSDoc（**已改** ⇒ ⚠️ **行号会随并发改动漂移 ⇒ 以函数名定位**）⇒ ⇒ ★ **三处都改完 + impl-notes §13 的逐字副本同批更新 + 自检脚本重新报 true / true ⇒ 才算「口径与实现同步」**。
13. ★★ **「四处同批」纪律（2026-11-05 · ★ 由本轮 ADR 漏网直接换来 · ★ 下一个人的检查清单）** —— ★ **凡改「2026-11-05 那批实测」的措辞 ⇒ ⇒ 必须同批核下面四处**（★ **只记载体、不记行号** ⇒ ⇒ 行号会漂）：★ **①** 设计稿 `docs/design/perf-c2-t06-byte-metering.md`（**口径本体**：§4 的 `note` 示意 + §6.12 留痕 A/B + §13 待办第 10 条）· ★ **②** `docs/design/perf-c2-t06-byte-metering-impl-notes.md` §13（**逐字副本**：两段 `note` + 待办表）· ★ **③** `bench/perf.ts`（**落盘真值**：两段 `note` 字面量）· ★ **④** `docs/decisions/adr-perf-recall-vs-h1.md`（**裁决留痕**：`4.44 MB` 订正段）⇒ ⇒ ★ **为什么是「纪律」而不是「清单」**：⇒ ⇒ **「载体清单要维护」本身就是要守的东西** ⇒ ⇒ 清单漏一项 ⇒ ⇒ 那一项就没人守 ⇒ ⇒ ★ **本轮实证**：改 ① 时**漏了 ④（ADR）** ⇒ ⇒ 工程师查 ④ 时**又漏了同一行里的第 3 处** ⇒ ⇒ **两次都漏 ⇒ ⇒ 证明「靠人记清单」不足以兜住** ⇒ ⇒ ⇒ ★ ⇒ ⇒ **所以这条纪律是「两条腿」**：**负向扫描（机器）+ 检查清单（人）**⇒ ⇒ ★ 负向扫描那一腿已由 `scripts/check-wording-drift.ts` 承担（**全仓扫描 ⇒ 新载体自动被覆盖**）⇒ ⇒ ★ **下面这份清单是「人」那一腿**。⇒ ⇒ ★★ **哪一维有机器守卫（现状 · 2026-11-05）**：★ **逐字** = `scripts/check-json-note-fidelity.ts`（`pnpm run check:json-note`）⇒ ⇒ **只覆盖 ③↔②**（落盘真值 ↔ 逐字副本）⇒ ⇒ ★ 判据已升级成**逐字节相等**；★ **措辞** = `scripts/check-wording-drift.ts`（`pnpm run check:wording-drift`）⇒ ⇒ **全仓负向扫描**（旧措辞不许以断言形态出现）⇒ ⇒ ★ **它把「④ 漏网」那类病变成机器拦得住**；★ **数值** = `scripts/check-benchmark-numbers.ts`（`pnpm run check:benchmark-numbers`）⇒ ⇒ 同一批数在多个载体里逐位相等⇒ ⇒ ⚠️ ★ **仍然只有人守的那一维**：★ **「四处对同一句话【逐字一致】」**（①↔② / ①↔④ 的措辞对齐）⇒ ⇒ ★ **负向扫描只保证「不出现旧措辞」⇒ ⇒ 不保证「四处说的是同一句」** ⇒ ⇒ ⇒ ★ ⇒ ⇒ **所以这条纪律仍然是必要的**（★ ⇒ ⇒ 而主理人裁决 ③「措辞锚点维度」要补的**正是这一维**）。⇒ ⇒ ★★★ **下一个人照着做的检查清单（★ 改任何一处措辞时逐条走）**：★ **①** 先确定要改的是**哪一句**（不是「改一下措辞」）⇒ ⇒ ★ **改前先跑 `pnpm run check:wording-drift` 确认当前是绿的**（⇒ ⇒ 改完才有对比基准）；★ **②** **同批核四处** ⇒ ⇒ ★ **②↔③ 必须逐字相同** ⇒ ⇒ ★ 改完必跑 `pnpm run check:json-note`（**逐字节判 ⇒ 不等即红**）；★ **③** ★ **① 与 ④ 的措辞也要对齐**（这两处**只有人守**）⇒ ⇒ ★ **对齐的标准 = 落盘 `note`（③）里的那一句**（它是真值）；★ **④** ★★ **搜残留必须用【宽式正则】、不许用精确串**（★ 2026-11-05 新纪律 · ★ **本轮实证**：旧措辞「只读了 2 行」有一个**只差一个字的变体**（结尾动词换成「只读到」）⇒ ⇒ **两者语义完全相同** ⇒ ⇒ **精确串 grep 必然漏掉变体** ⇒ ⇒ **宽式 `只读[^，。；）]{0,12}2 行` 才抓得住** ⇒ ⇒ ★ 宽式的写法里**不写具体措辞**（⇒ ⇒ 免得自己把自己扫进去）⇒ ⇒ ⇒ ★ ⇒ ⇒ **必须报告【命中数】+【剩下的命中在哪、为什么合法】** ⇒ ⇒ ★ **别只报「搜过了」**（★ 「搜过了」+「0 命中」≠「我用的是宽式」）⇒ ⇒ ★ 本轮实测：**命中 2 处**（① 的两行**释义段** ⇒ ⇒ 那是**在解释这个词**、必须留 ⇒ ⇒ **合法**）⇒ ⇒ ⇒ ★ **要报「宽式 + 命中数 + 逐条说明」三件**）；★ **⑤** 改完跑全门禁：`pnpm run lint && pnpm run typecheck && pnpm run verify` ⇒ ⇒ ★ 外加三条链外入口：`check:json-note` · `check:wording-drift` · `check:benchmark-numbers`。

## 14. 合并消解记录（**与 architect-2 的差异清单** · 审计轨迹）

> 主理人裁决：「两份设计并存必须收敛成一份 ⇒ **以 architect 的版本为主体**，把 architect-2 的裁决吸收进来，合并成一份」。
> ⇒ 本节保留**合并时的分歧点与最终结论**，供复盘（**不是为了留第二套口径**）。

| # | 分歧点 | architect-2 的主张 | 本文件的最终口径 | 依据 |
|---|---|---|---|---|
| 1 | 剪枝率方向 | 「偏小 ⇒ 偏严」 | **修正为：偏小 ⇒ 偏松 ⇒ 假绿**（门槛是「≤ 15%」） | `prune.ts:289-290`；主理人复核成立 |
| 2 | 剪枝率分子的取法 | bench 侧 `embeddingCalls`（调用次数） | **采纳，但补齐「为什么它 == `exactReads`」的三条推理 + 失效条件 + tests 侧等价性单测** ⇒ ⇒ 顺带把原计划的 `src/store/dedupCandidates.ts` 改动**取消**（零 src 改动） | §1.7 / 断言 1c / 裁决 ② |
| 3 | `unclassified` 的触发条件 | 「列集合不可解析」 | **改成「命中零来源」（形状登记制）** ⇒ 并补断言 3 自检 | 开放规则下「零来源」恒为 0 = 没牙 ⇒ 必须登记制 |
| 4 | 落盘形态 | 标量样例 | **改 `CountSummary` 分布**（字段名 / 容器名沿用 architect-2） | 标量判不了 `max` |
| 5 | 正文字节 | 不落盘 | **`breakdown.contentBytes` 单列**（不在 `bytesRead` 里） | 让「下界差多少」可见（主理人要求） |
| 6 | 断言体系 | 断言 1 / 1a / 1b / 2 | **扩到 1 / 1a / 1b / 1c / 1c-bench / 1d / 1e / 2 / 3 / 4 / 5**（11 条） | 主理人要求：补 1b（legacy 交叉校验）、3（unclassified 自检）、1d（两轮对齐）、4（零 src 边界）、5（过滤串守卫）；1c + 1c-bench（剪枝率分子等价性 + 口径纪律）、1e（窗口没开大）为本轮新增 |
| 7 | 两轮制 | **驳回**「必须分两轮」（理由：两轮会让 ms 与历史基线不可比） | ★ **最终【两轮制】**，但**核销了他的理由**（他担心的 `vectorCandidateScan` 旧口径**恰好就是「无计数器」** ⇒ 两轮 = 保持原口径、单轮 = 改口径 ⇒ 基线要不要重采）；⇒ **完整往返见 §6.11**：裁决 1（单轮）**已撤回** | ★ **`git show HEAD:bench/perf.ts:943-952`**：旧写路径扫描段的计时窗口**本就无计数器** ⇒ **单轮 = 改口径 = 百万级基线要重采**；两轮的唯一代价 = 那一段 bench 耗时 ≈ ×2（秒级）⇒ **成本压倒性**（⚠️ **只限【写路径】**；读路径本轮【单轮】· HEAD 逐字同形） |
| 8 | `src/vector/ivf.ts` 的注释 | 修正 8 = 本轮改注释 | **本轮不改**（裁决 ②）⇒ 转 §13 待办第 8 条 | 零 src 改动是可验证的强纪律 |
| 9 | 「H1′ 判的是哪一笔」 | 两笔分析（独立实测段 vs `store.write()` 内部） | **完整采纳**（§1.5 + §4 的 `note` + §13 第 1 条） | 主理人点名要求 |
| 10 | 打印措辞纪律 | 「旧行数只许说观测值」 | **采纳**（§5 + §10.1） | 降级为观测后，措辞也必须降级 |
