# T06 第一段 · 实现说明（工程师：Kou）

> **身份**：**第一段的施工记录**（不是裁决、不是落盘规格）。
> **上游（施工依据）**：`docs/design/perf-c2-t06-byte-metering-spec.md`（**② 施工规格** · 最终口径）
> ＋ `docs/design/perf-c2-t06-byte-metering.md`（**①** 决策备忘 + 二审修正 1~8）
> ＋ `docs/design/perf-c2-admissible-two-stage.md`（**设计稿**）**设计稿 §5.1.2**。
> **本段边界**：只做两件先行工作 —— **A**（计数窗口覆盖写入路径）与 **B**（认领 `vector_codes`）。
> **明确不做**：字节算法、落盘字段、H1′/H2′ 判定、剪枝率（⇒ 全部留给第二段）。
> ⚠️ **本段没提交**（⇒ 主理人提交）。

> ⚠️ ★★★ **本文档的章节引用纪律（防止下一个人再踩「§N 指向不唯一」那个坑）**
>
> ⚠️ **根因**：同一个「§N」前缀**同时指三份文档** ⇒ ⇒ 读者**无法判断它指哪一份** ⇒ ⇒ **点过去才发现不对**（**不报错、最隐蔽的一种错**）：
>
> | 前缀 | 指哪份文档 | 它的章节 |
> |---|---|---|
> | **① §N** | `docs/design/perf-c2-t06-byte-metering.md`（决策备忘 / 口径） | §1 §2 §3 §4 §5 §6 **§11** §13 §14（★ **没有** §7 / §8 / §9 / §10 / §12） |
> | **② §N** | `docs/design/perf-c2-t06-byte-metering-spec.md`（施工规格） | §7 §8 §9 §10 §12（★ **没有** §11） |
> | **设计稿 §N** | `docs/design/perf-c2-admissible-two-stage.md` | §5.1.2 等 |
> | **本文件 §N** | **本文档** | §0 ~ §16 |
>
> ⇒ ★ **纪律**：**指向外部文档的 §N，一律带前缀**（① / ② / 设计稿）⇒ ⇒ **读到「规格 §N」「施工规格 §N」这种前缀 = 笔误**（它不指任何一份文档）⇒ ⇒ **「口径 §N」= ① §N**（口径只有一份 ⇒ 不歧义，但为统一也写成 ①）。
>
> ⚠️ ★ **唯一的例外（**不改**）**：**第一段（§0 ~ §9 · 架构师落的骨架）内部的引用保持原样** ⇒ ⇒ 那些 §N 一律指**本文件自己** ⇒ ⇒ **合法**、**不动**（架构师骨架要求「第一段的记录一个字未改」）。
>
> ⚠️ ★ **例外之例外**：**本文件自产的章节（§11 ~ §16）里，凡指向外部文档的引用，一律带前缀**。

---

## 0. ★ 对齐记录（**施工期间架构师落了两份文档 ⇒ 本段实现按最终规格校准过一次**）

| 时点 | 事件 | 本段的动作 |
|---|---|---|
| 开工时 | 只有主理人的任务书（事实包） | 按事实包实现 |
| 中途 | 架构师落 `perf-c2-t06-byte-metering.md`（含**修正 5**：字节累计**延后到 `stop()`** ⇒ 推出「**分两轮**」） | ⚠️ 本段按修正 5 实现成**两轮制**（轮 A 计时无计数器 / 轮 B 计量有计数器） |
| 再中途 | 架构师落 **`perf-c2-t06-byte-metering-spec.md`（② 施工规格）** 与 **`perf-c2-t06-byte-metering.md`（①）· ① §11 待明确事项 · 第 10 行**：字节**当场累加标量** ⇒ 开销 O(1)/行 ⇒ **不必分两轮**；且「分两轮会让 `samplesAligned` **恒真 ⇒ 没牙**」 | ✅ **本段已按最终规格改回单轮**（计数器在计时窗口【内】，与召回路径同一先例）⇒ **以架构师的最终规格为准** |
| **第二段**（2026-11-05） | 主理人**裁决第 1 号**（读路径回单轮）＋ 架构师**裁决 4 订正版**（形状 id `legacy` → `bucketCandidate`） | ⚠️ **读路径窗口本轮完全不动**（HEAD 本来就是「装计数器 + 计数 + 计时」⇒ 拆两轮 = **改口径** ⇒ 与历史基线不再逐位可比）⇒ ⇒ **只有【写路径】拆两轮**（HEAD 的写路径扫描段**窗口里没有计数器** ⇒ 单轮 = 要重采百万级基线）⇒ ⇒ **`samplesAligned` 的两轮对账只在写路径有牙**；形状 id / 注释按裁决 4 改成 **`bucketCandidate`**（定性：「仅 `prune = false` 对照分支（A1 / A7）使用 ⇒ 两段式写路径不发 ⇒ 不在 bench 采样窗口内；登记它是为了防御」） |
| **裁决落地 #1** | 架构师挖出：**读路径的 `samplesAligned`（`readByteSamples.length === vectorRouteSamples.length`）是【恒真的】**（两个 `push` 在同一个循环体内、无条件、无 `continue` / `break` ⇒ 长度必然相等）⇒ ⇒ 挂在判红守卫上却**永远打不红** ⇒ ⇒ 原注释「仍有牙」**是说谎** | ✅ **按裁决落地 #1 换掉**：读路径 `samplesAligned` := **实测桶成员行 == 推算桶成员行**（逐样本）⇒ ⇒ **字段名 / 类型 / 落盘结构一律不动**（只换「怎么算」）⇒ ⇒ 纯函数 `readSamplesAlignedOf()` **导出** ⇒ ⇒ **补了负控**（喂不等 ⇒ 必须 `false`）⇒ ⇒ **逐样本实测 20/20 相等**（§11.5.1）⇒ ⇒ **写路径的 `samplesAligned` 语义不变**（仍是两轮 `candidateUniverse` 对账） |

⇒ ⚠️ **对第二段的影响（第一段的判断 · 已于第二段订正）**：**没有两轮** ⇒ **`samplesAligned` 这个量不存在了**（施工规格里也没列它）
⇒ 第一段**不要**再引入它（它会恒真 ⇒ 没牙）。
⇒ ⚠️ ★★★ **第二段订正（2026-11-05 · 主理人裁决第 1 号）**：**这一条被推翻了** ——
   ⇒ ⇒ **`samplesAligned` 回来了**（① §2 断言 1d + ① §4 落盘结构都列了它）
   ⇒ ⇒ 但**只有【写路径】是两轮**（⇒ 它**有牙**），**读路径是单轮**（⇒ 字节与毫秒同源 ⇒ 天然绑定）
   ⇒ ⇒ **裁决依据**（两条都是 HEAD 的硬证据，方向相反）：
     · **写路径必须两轮**：HEAD 的写路径扫描段是「`start` → `collectVectorCandidates` → `end`」
       ⇒ **那段窗口里【没有计数器】** ⇒ 历史基线的 `vectorCandidateScan` 是**「无计数器的干净测量」**
       ⇒ ⇒ **单轮 = 改口径 = 与基线不再逐位可比 = 要重采百万级基线** ⇒ ⇒ **两轮 = 逐字复现旧取时位置**。
     · **读路径必须单轮**：HEAD 的读路径**本来就是「装计数器 + 计数 + 计时」**
       ⇒ 历史基线的 `vectorRouteP99Ms` **本来就含计数器的逐行开销**
       ⇒ ⇒ **拆两轮 = 改了口径（方向是变快）= 与历史基线不再逐位可比** ⇒ ⇒ **读路径必须单轮**。
   ⇒ ⇒ 一句话：**「哪儿在计时窗口里本来就装了计数器，哪儿就单轮；哪儿本来没有，哪儿就两轮」**
     ⇒ ⇒ **两处都不是口味问题，是「基线要不要重采」的成本问题**（详见 §11.4）。

---

## 1. 改了什么（文件 × 处数 × 一句话机制）

| 文件 | 处数 | 机制（一句话） |
|---|---|---|
| `bench/lib/harness.ts` | 6 | ①`ReadKind` 提到**模块级并导出**（`'candidate' \| 'bucketMember' \| 'vectorCode'`）；②`classifyReadKind()` **导出**并新增 `vector_codes` 规则（**排在 `memories` 之后**，与 **② §10.2** 的 legacy 顺序逐条一致）；③`ByteReadSnapshot` 加 `codeRows`；④计数器多认一类；⑤`RowReadSnapshot` → `ByteReadSnapshot` 改名（**② §12** 类图）；⑥注释同步。 |
| `bench/perf.ts` | 3 | ①**另装一个计数器实例**罩住写路径扫描循环（**不移动召回那个的 `uninstall()`**）；②每个样本 `start`/`stop`/快照 ⇒ **逐样本**的行读读数；③新增 `WritePathReadSample` + `onWritePathReads` 钩子（**仅测试用**，**不落盘**）。 |
| `tests/bench/t06-byte-metering.test.ts` | **新增** | 9 条断言（B 组 4 条 + A 组 5 条）。 |

### 1.1 A（窗口覆盖写入路径）—— 关键机制

```
写入循环（store.write() × writeCount）   ← ★ 这里【没有】计数器（代理不在这个区间）
   ↓
写路径扫描循环（× writeCount）：
   before = snapshot() → start() → [计时开始] → collectVectorCandidates() → [计时结束] → stop() → after = snapshot()
```

⚠️ **为什么必须另装一个实例**（施工规格 T06-2 验收标准 1，已核实）：

* `:900` 的 `rowCounter.uninstall()` **不能往后挪** ⇒ 因为 `:900` 与写路径之间夹着**生产的写入循环**
  （`store.write()` × `writeCount`；它自己就会调 `collectVectorCandidates()`）⇒
  ① 那些读数会被算进「写路径窗口」（⇒ 两笔账混成一件）；
  ② 代理开销会落进 `store.write()` 的计时 ⇒ **写入 P99（硬门槛 ≤ 5ms）被污染**。
* ⇒ **串行安装第二个实例**（召回那个已卸掉 ⇒ 第二个的「原函数」是真原函数 ⇒ `uninstall()` 逐位还原）。

⚠️ **计数器在计时窗口【内】**（**① §11 待明确事项 · 第 10 行**的最终裁决，与召回路径同一先例）：
「字节**当场累加标量** ⇒ 开销 O(1)/行 ⇒ 可忽略 ⇒ **不必分两轮**」
⇒ ⇒ 计数器的**逐行计数开销**落在被测区间里 ⇒ ⇒ **`vectorCandidateScan` 的毫秒数
与历史基线是「同量级」而不是「逐位相同」**（施工规格 T06-2 验收标准 7：记录实测，不设门槛）。
⇒ ⚠️ **这是与「事实 6」的一致读法**：「计数器自己的开销（取快照 / 停表）不落在被测区间里」
—— 本段的取时位置与召回窗口**逐字同形**（计时在扫描之后立刻取 ⇒ `stop()`/快照在计时之外）。

### 1.2 B（认领 `vector_codes`）—— 关键机制

`classifyReadKind()` 的匹配顺序（**与 ② §10.2 的 legacy 判定逐条一致**）：

```
① 聚合（COUNT/SUM/AVG/TOTAL）⇒ null
② FROM|JOIN memories          ⇒ 'candidate'     ★ 必须在 ③ 之前（**设计稿 §5.1.2** 的告警靠它生效）
③ FROM|JOIN vector_cell_members⇒ 'bucketMember'
④ FROM|JOIN vector_codes       ⇒ 'vectorCode'    ★ 本段新增
⑤ 其余                          ⇒ null
```

⚠️ **②为什么必须在④之前**：一条 SQL **碰了 `memories`** ⇒ 它**真的要付 `memories` 的字节**
⇒ 归 `candidate` 才是如实的 ⇒ ⇒ **设计稿 §5.1.2** 的告警（「Q2 一旦写成 `JOIN memories`
⇒ `codeRowsRead` 恒 0、`memoryRowsRead` 满额 ⇒ **H1′ 的账从根上算错，而报表看起来很正常**」）
**正是靠这个顺序生效**；顺序倒过来 ⇒ 那条告警失效 ⇒ Q2 写成 JOIN 会被静默吞掉。

⚠️ **①为什么必须最先**：`countUncodedCandidates()` 的 SQL 内部嵌了
`NOT EXISTS (SELECT 1 FROM vector_codes vc …)` ⇒ 若不先判聚合，它会被 ④ 抢走
⇒ **一条诊断查询被记成「读了码行」**。

---

## 2. 命名选择与理由（⇒ 转给架构师对齐）

| 名字 | 取值 | 理由 / 与架构师文档的关系 |
|---|---|---|
| `ReadKind`（模块级类型） | `'candidate' \| 'bucketMember' \| 'vectorCode'` | ★ **与 ② §10.2 的 legacy 判定逐字一致** ⇒ **零冲突**。⚠️ 原来它是 `installRowReadCounter()` 的**函数内局部类型** ⇒ 提到模块级才能被导出与断言。 |
| `classifyReadKind()` | **导出** | 原来是模块私有 ⇒ 不导出就没法直接断言「Q2 被认成码类」。导出是**新增**，不动旧落盘键。 |
| `ByteReadSnapshot`（快照类型） | 由 `RowReadSnapshot` 改名 | ★ **② §12 类图钉死的形状**（`RowReadCounter.snapshot(): ByteReadSnapshot`）⇒ 以架构师为准。⚠️ **TypeScript 类型名，不是落盘 JSON 的键** ⇒ **旧落盘键一个都没动**。全仓无其他引用（已 grep）⇒ 无兼容包袱。 |
| 快照字段 `codeRows` | 新增 | ★ **② §12 类图里就是 `codeRows`**（`ByteReadSnapshot.codeRows`）⇒ 与落盘层的 `codeRowsRead`（**② §10.1**）**分层不同名**，不冲突。 |
| `WritePathReadSample` | 新增（**不落盘**） | 写路径**逐样本**的读数载体（第二段会被落盘结构取代）。字段名**刻意对齐 ② §10.1**：`candidateUniverse` / `bucketMemberRows` / `codeRows` / `candidateRows`。 |
| `PerfMeasurementOptions.onWritePathReads` | 新增（**仅测试用**） | ★ **为什么不落盘**：落盘字段名与层级由架构师裁决 ⇒ 本段抢先定 = 制造「同一个东西两个名字」。⇒ 钩子是本段**唯一的可观测出口**（否则「窗口罩没罩住」无法被测试证伪）。⚠️ **不参与任何红/绿判定**。 |

---

## 3. 校验结果

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 绿 |
| `pnpm lint` | ✅ 绿（252 文件） |
| `pnpm test` | ✅ 绿（**97 文件 / 1921 用例**全过；含既有 `tests/bench/h1-measurement.test.ts` 19 条） |
| `pnpm check:params` | ✅ 绿（**Params 仍 60 项**） |
| `pnpm check:bucket-write` | ✅ 绿（桶归属唯一写入点 = `src/vector/bucketAssign.ts`） |
| `pnpm verify` | ✅ **退出码 0**（含 `check:payload-keys` / `check:clock` / `check:anchor` / `check:contract-ids` / `check:doc-counts` / `check:clamp` / `audit:tier-qualifiers` / `audit:two-layer` / `audit:negative-control`） |
| `tests/contracts/table-name-boundary.test.ts` | ✅ 绿（`src/store/**` 无 `vector_codes` ⇒ 本段**没碰 `src/**`**） |

---

## 4. 新写的测试清单（`tests/bench/t06-byte-metering.test.ts` · 9 条）

**B 组（分类器）**

1. ★ **生产 Q2 那条 SQL 被认成码类**（**不是** candidate）—— **从生产句柄上录下真实跑过的 SQL**
   （不抄一份 ⇒ 改了 SQL 断言会跟着变）⇒ `classifyReadKind(sql) === 'vectorCode'`。
2. ★ **生产 Q2 那条 SQL 不许 JOIN `memories`** —— 破了就当场炸（比在报表里发现便宜一万倍）。
3. ★ **匹配顺序：`memories` 优先于 `vector_codes`** —— 一条 JOIN `memories` 的码池读 ⇒ 归 `candidate`
   ⇒ **设计稿 §5.1.2 的告警靠它生效**；同时断言纯码池仍归 `vectorCode`、成员读仍归 `bucketMember`。
4. ★ **聚合查询不计** —— 含 `NOT EXISTS (… FROM vector_codes …)` 的诊断 SQL 仍归 `null`。

**A 组（计数窗口）**

5. ★ **跑一次写路径扫描 ⇒ 码行 / 桶成员行 / `memories` 侧三段读都被计数**
   （用「重复写入」探针 ⇒ 余弦 = 1 ⇒ 必然入选 ⇒ 可复现，不靠运气）。
6. ★ **一条随机文本探针 ⇒ `memories` 侧读到 0 行** —— **两段式上界在正常工作，不是坏了**
   （⇒ 「码行数」与「`memories` 行数」必须**分开记**，否则「省下的字节」会被藏起来）。
7. ★ **窗口之外的读数不计入快照**（窗口前 / 窗口内 / 窗口后三段各读一次 ⇒ 只有窗口内进账）。
8. ★ **`measurePerf` 的写路径窗口 ⇒ 码行 > 0、桶成员行 > 0**，且
   **桶成员行数 == 候选宇宙**（**反向断言：防窗口开太大** ⇒ 同时钉住施工规格 T06-2 验收标准 1
   「写入循环 `store.write()` 内部的向量扫描**不被计量**」）。
9. ★ **`disableRowReadCounter` ⇒ 写路径样本恒为 0**（「装了但不计数 ⇒ 实测值恒为 0」这条纪律没破）
   ⇒ 且 **候选宇宙不受影响**（它来自生产返回值，不经过计数器）⇒ 但 **现行判据量 = `bytesRead.max`，它是会被计数器影响的** ⇒ ⇒ **`candidateUniverse` 才不受影响**。

---

## 5. 留给第二段的事（清单 · 按施工规格的任务号）

| # | 事项 | 归属 | 本段已铺好的路 |
|---|---|---|---|
| 1 | **字节来源分解 + `byteSources.ts`（形状登记制 · 7 个形状）** | T06-1 | ①`classifyReadKind()` 已导出且 legacy 顺序钉死；②`codeRows` 已在快照里；③**聚合判定已在第一位**（诊断 SQL 不被抢走）。 |
| 2 | **`calls`（`get()` 调用次数 = `PruneOutcome.exactReads`）** | T06-1 / 修正 3 | 现有 `get` 包装处就在 `harness.ts` 的 `wrapStatement()` ⇒ 加一个无条件 `calls += 1` 即可。 |
| 3 | **`unclassifiedRows` + `unclassifiedSqlKinds`**（未登记形状 ⇒ 判红） | T06-1 / 修正 6 | 分类器已导出 ⇒ 解析函数可拆到 `byteSources.ts`（纯函数、可单测）。 |
| 4 | **Q3 窄列与 Q4 整行拆开**（`narrowRowsRead` vs `memoryRowsRead`） | T06-1 | 见 §6.1。 |
| 5 | **`src/store/dedupCandidates.ts` 透传 `exactReads` / `uncoded`**（断言 1c 的另一半） | T06-2 | 本段**没碰 `src/**`** ⇒ 留给第二段。 |
| 6 | **落盘结构**（`writeSegments.vectorByteReads` + 顶层 `vectorRouteByteReads`，四读数用 `CountSummary`） | T06-3 | 写路径逐样本读数已在 `writePathReadSamples` 里（**字段名已对齐 ② §10.1**）。 |
| 7 | **H1′ / H2′ 判定 + 打印 + 旧行数判据降级** | T06-4 | 本段**没碰** `THRESHOLDS` 与 `checkPerf()`。 |
| 8 | **剪枝率**（`（PRUNE_RATE）`，阈值 0.15，分子 = `scan.exactReads`） | T06-4 / 待明确 #5 | 分子需要第 2 项的 `calls` + 第 5 项的 `scan.exactReads`。 |
| 9 | **读路径的字节计量**（顶层 `vectorRouteByteReads`） | T06-3 | 召回窗口的计数器**已覆盖** `readCodes()` ⇒ 码行在召回侧也能被认领（**本段已生效**）。 |
| 10 | **计时口径的记账**（`vectorCandidateScan` 的毫秒数现在是「同量级」而非「逐位相同」） | T06-3 | ⚠️ 已在 §1.1 写明 ⇒ **落盘 note 里必须带这一句**（否则读的人会以为它与旧基线逐位可比）。 |
| 11 | **`src/vector/ivf.ts` 的过期 JSDoc**（`readCandidateRows()` 说谎） | T06-5 / 修正 8 | 本段**没碰 `src/**`**。 |

---

## 6. 已知缺口（**明确留给第二段**）

### 6.1 Q3 窄列读被误记成候选行

* `readGateColumns()`（`src/vector/ivf.ts`）的 SQL 是
  `SELECT id, last_access, pin_factor FROM memories WHERE id IN (…)`
  ⇒ 含 `FROM memories` ⇒ **被 legacy 分类器认成 `candidate`**。
* ⚠️ **影响范围比预想的小**（**实测订正**）：**Q3 只在读路径发**（`searchPruned()` 里「filter 带时间窗时才发」）
  ⇒ ⇒ **写路径不发 Q3** ⇒ ⇒ **写路径的 legacy `candidateRows` == 施工规格口径的 `memoryRowsRead`**
  （= `scoreOf` 的逐条读 + Q4 survivors 整行读）⇒ **① §1.5 的交叉校验 1b 在写路径上成立**
  （本段实测：写路径一次扫描 `candidateRows` = 20 次精确分 + 20 行 survivors = 40 ✓）。
  ⇒ ⇒ **读路径的 `candidateRows` 仍含窄读** ⇒ 交叉校验 1b **在读路径不成立**（与裁决一致）。
* ⇒ **本段的处理**：**不动**（施工规格 T06-1 的形状登记制会把它分开）；
  临时口径 = 「legacy `candidateRows` = 窄读 + 向量行」，已在 `WritePathReadSample.candidateRows`
  与 `ByteReadSnapshot.candidateRows` 的注释里**写明**。

### 6.2 「一行不等于一字节」

`codeRows` 是**行数**（一行 = 768 个 int8 + `scale` + `eps`）⇒ **换算口径留给架构师裁决**
⇒ 本段**没有**在任何地方乘字节系数（避免第二套字节口径）。

### 6.3 `uninstall()` 逐位还原的既有纪律

第二段若再加计数器实例，**必须串行安装**（本段的第二个实例已经满足）⇒ 否则 `uninstall()`
会把 `db.prepare` 还原成「上一个实例的包装」⇒ 残桩留在生产句柄上。

---

## 7. 给架构师的口径建议（第二段可直接照抄）

1. **legacy 分类器已经是「两个结论」的天然骨架**：本段的 `classifyReadKind()` 只给**一个**结论（表级）；
   第二段的 `byteSources.ts` 应在**同一次归一化**上给**第二个**结论（形状级：含不含 `embedding`）
   ⇒ ⇒ **legacy 侧逐位不变**（`docs/baseline/*.json` 的 R6 不断档），**字节侧拿到分类精度**。
2. **写路径的 `candidateRows` == `memoryRowsRead`**（Q3 不发）⇒ ⇒ **① §1.5** 的交叉校验 1b
   **可以升级成一条零容差断言**（本段已备好数据：`WritePathReadSample.candidateRows`）。
3. **写路径的 `bucketMemberRows == candidateUniverse`**（一个记忆只属于一个细桶 ⇒ 桶间不重复）
   ⇒ ⇒ 这条**结构等式**可以当「窗口没开大 / 分类没串味」的守卫（比「> 0」有牙得多）——
   ⚠️ **注意**：**`bucketMemberRows === candidateUniverse`（零容差）这条结构等式只在【写路径】成立**
   （读路径的 `candidateUniverse` 是 `COUNT(DISTINCT memory_id)` 口径，与 `bucketMemberRows` 不同源）。
4. **`unclassifiedRows` 的触发条件**（修正 6）：「`SELECT` 列表**解析不出确定列集合**」
   ⇒ ⇒ 第二段的解析器必须**只看 SELECT 段**（归一化 SQL 的第一个 `SELECT` 之后、第一个 `FROM` 之前）
   ⇒ 否则 `WHERE m.embedding IS NOT NULL` 会被误判成向量来源。
5. ⚠️ **建议第二段把 `WritePathReadSample` 直接换成落盘结构**（`CountSummary` 形状），
   ⇒ 本段的 `onWritePathReads` 钩子可**保留**（测试用）或**删掉**（生产路径不传 ⇒ 零影响）。
6. ⚠️ **落盘 note 里必须写明「`vectorCandidateScan` 的毫秒数现在含计数器的逐行开销 ⇒ 与旧基线同量级而非逐位相同」**
   （施工规格 T06-2 验收标准 7 ⇒ 记录实测、不设门槛 ⇒ 但**读的人必须知道**）。

---

## 8. 与「事实包」不符 / 需要订正之处（以代码为准）

| # | 事实包的表述 | 核实结果 |
|---|---|---|
| 1 | 「`:900` 到 `:1060` 之间还有没有别的会走生产 SQL 的调用？」 | ✅ **有**：**生产的写入循环**（`store.write()` × `writeCount`，走文本路 `mem_fts JOIN memories` + 向量路 + 落库）⇒ ⇒ **`uninstall()` 不能后挪**（已按此实现）。 |
| 2 | 事实 2 的四条写路径 SQL | ✅ **逐条核实无误**（Q1 `readMemberIds` / Q2 `readCodes` / `scoreOf` 逐条 / Q4 `buildSurvivorSql`）。 |
| 3 | 事实 5「Q3 窄列读会被误记成候选行」 | ✅ **属实**，但**影响范围需订正**：**Q3 只在读路径发** ⇒ **写路径不受影响** ⇒ 写路径的 legacy `candidateRows` == `memoryRowsRead`（见 §6.1）。 |
| 4 | 事实 6「计时的取法必须与之一致」 | ✅ **继承**（取时位置与召回窗口**逐字同形**：计时在扫描之后立刻取 ⇒ 快照 / 停表在计时之外）。⚠️ **补充**：**① §11 待明确事项 · 第 10 行**裁定「计量在计时窗口【内】」⇒ 计数器的**逐行开销**落在被测区间里 ⇒ 毫秒数是「同量级」而非「逐位相同」（已记进 §7 第 6 条）。 |
| 5 | — | ⚠️ **② §7（文件列表）曾提到的 `tmp-debug-writepath.ts`** = **本段工程师临时建的调试脚本**（用它量了三组探针的读数形状）⇒ **已删除**（未进提交）⇒ 工作区干净。⚠️ ★ **注**：architect 后来的版本已**不再提**这个文件名 ⇒ ⇒ 此处按「② §7 的早期版本」记。 |
| 6 | — | ⚠️ **架构师的决策备忘（`…-byte-metering.md`）① §6 修正 5 与 ① §11 待明确事项 · 第 10 行相反**（前者要两轮、后者不要）⇒ **本段按施工规格（最终裁决）实现** ⇒ 见 §0 的对齐记录。 |

---

## 9. 全局一致性自检

| 检查项 | 结论 |
|---|---|
| ① 与架构师即将落盘的口径**冲突**？ | ✅ **无冲突**：`ReadKind` 三个成员名与 **② §10.2** 逐字一致；legacy 判定顺序一致；`codeRows` 与 **② §12** 类图一致；`ByteReadSnapshot` 已按 **② §12** 改名；写路径接线方式与 T06-2 验收标准 1 一致；**计量在计时窗口内**（**① §11 待明确事项 · 第 10 行**）✓。 |
| ② 遗留 TODO / 调试代码？ | ✅ 无（临时脚本已删；无 `console.log`；无 `TODO`/`FIXME`）。 |
| ③ 注释里的「为什么」说清？ | ✅ 说清了（尤其：为什么另装实例、为什么顺序不许倒、为什么一行不等于一字节、为什么毫秒数只是「同量级」）。 |
| ④ 计时口径未被破坏？ | ✅ 取时位置与召回窗口**逐字同形**；⚠️ **但计数器在写路径的计时窗口内**（**① §11 待明确事项 · 第 10 行**的最终裁决）⇒ `vectorCandidateScan` 的毫秒数与旧基线是**同量级**而非逐位相同 ⇒ **已在 §7 第 6 条要求写进落盘 note**。 |
| ⑤ 既有测试仍全绿？ | ✅ 全绿（1921/1921）。 |
| ⑥ 落盘键一个都没动？ | ✅ `PerfResult` / `WriteSegmentSummary` / `THRESHOLDS` **一个键都没加、没改、没挪**（新数据只经**测试钩子**出去）。 |
| ⑦ `Params` 仍 60 项？ | ✅（`pnpm check:params` 绿）。 |
| ⑧ `src/**` 未被碰？ | ✅ `git diff` 只含 `bench/**` 与 `tests/**`（`src/` 零改动）。 |

**IS_PASS: YES**

---
---

# ★ 第二段（T06-2 ~ T06-5）· 施工记录**框架**

> **落盘人**：架构师（`software-architect`）· 2026-11-05 —— **只落骨架，工程师往里填**。
> **上游口径（唯一权威）**：`docs/design/perf-c2-t06-byte-metering.md`（**①**）**① §1~§14**（**口径以它为准**；本文件只记「怎么实现的」）。
> **第一段（§1~§9）已由工程师完成** ✅ —— 本段**接着往下写**（不要改写 §1~§9）。
> **硬边界（主理人裁决 ②）**：**本轮零 `src/**` 改动**（含**注释**）⇒ 每节写完都要过一遍「断言 4」。
> **给工程师的三条硬提醒**（主理人点名）：
> ① **落盘用分布形态**（`CountSummary`）⇒ `bytesRead` 是 `{count,min,mean,p50,p99,max}` **不是标量** ⇒ **门槛取 `max`**；
> ② **`breakdown` 里加 `contentBytes`**（Q4 的正文）⇒ 让「`bytesRead` 是下界」这件事**可见**，而不只是一句 note；
> ③ **剪枝率分子 = `embeddingCalls`（`get()` 调用次数）** ⇒ **不许数「返回行数」**（偏小 = 假绿）⇒ 且 **`get()` 包装必须无条件计数**（现有实现只在 `row !== undefined` 时计数 ⇒ **必须改**）。

## 10. 本段范围与边界（**开工前先抄一遍**）

| 项 | 值 |
|---|---|
| 上游口径 | `docs/design/perf-c2-t06-byte-metering.md`（**① §1** 字节算法 / **① §2** 断言 / **① §3** 分类器 / **① §4** 落盘 / **① §5** 判据 / **任务列表见 ② §8**） |
| 本段任务 | **T06-2**（写路径接线）→ **T06-3**（落盘 + 打印）→ **T06-4**（H1′/H2′/剪枝率判定）→ **T06-5**（文档同步 + 收尾） |
| 允许改的文件 | `bench/lib/harness.ts`、`bench/lib/byteSources.ts`（新增）、`bench/perf.ts`、`tests/**`、`docs/**` |
| **禁止改的文件** | ⚠️ **`src/**`（全部，含注释）** ⇒ `git diff --stat src/` 必须为空（**断言 4**） |
| 不许加的东西 | `Params` 键（恒 60 项）/ 第三方依赖 / `src/store/**` 里的 `vector_codes` |
| 判定口径 | **只认 `bytesRead.max`**；旧行数判据**降级为观测**（常量一个都不许删） |


## 11. 改了什么（文件 × 处数 × 一句话机制）

> ⚠️ **第二段（T06-2 ~ T06-5）· 工程师填**（2026-11-05）。
> ⚠️ **第一段（§1~§9）的记录一个字未动**（架构师骨架要求）⇒ **只有本节起是第二段的**。

| 文件 | 处数 | 机制（一句话） |
|---|---|---|
| `bench/lib/harness.ts` | 11 | ①`ByteReadSnapshot` 扩成**双结论快照**（legacy 三字段 + 字节侧十字段）；②`installRowReadCounter()` 的 `prepare` 包装改成「**legacy 分类 ⇒ 字节形状解析**」双轨（**包装条件 = `classifyReadKind(sql) !== null`** ⇒ 聚合豁免）；③`.get()` 包装**无条件** `calls += 1`（剪枝率分子）；④字节**当场累加标量**（**绝不缓存行数组** ⇒ O(1) 内存）；⑤未登记形状 ⇒ `unclassifiedRows` + 指纹；⑥`expectedCodeBytes` 选项（缺省 `EMBED_DIM`）。 |
| `bench/lib/byteSources.ts`（**新**） | 1（485 行） | ①**纯函数**字节来源解析（**零 db 依赖** ⇒ 可单测）：`normalizeSql` / `parseTables` / `parseSelectList` / `bytesOfRow` / `shapeKeyOf` / `resolveShape` / `sqlFingerprint` / `isAggregateSql`；②**形状登记表 7 条**（Q1 / Q2 / Q3 / Q4 / Q5 / `scoreOf` / `bucketCandidate`）；③形状 id 按 ① 裁决 4 = **`bucketCandidate`**（**不是 `legacy`**）。 |
| `bench/perf.ts` | 12 | ①`THRESHOLDS` 加 `bytesReadMax` / `bytesReadRatioMax` / `pruneRateMax`（**旧两个常量一个没删**）；②新增 `VectorByteSample` / `VectorByteReadsBreakdown` / `VectorByteReads` 三类型；③`WriteSegmentSummary` 加 `vectorByteReads`、顶层加 `vectorRouteByteReads`；④**读路径 = 单轮**（HEAD 逐字同形 · 字节与毫秒同源）；⑤**写路径 = 两轮制**（轮 A 计时不装计数器 / 轮 B 计量装计数器 · 同一份输入）；⑥`checkPerf()` 换成 **H1′ / H2′ /（PRUNE_RATE）** 三条判据 + 四条不可判定守卫（**旧 H1/H2 行数判据降级为并列观测**）；⑦stdout **四读数并列打印**；⑧`formatRecallVecRowsObservation()` 措辞同步；⑨★ **裁决落地 #1**：读路径 `samplesAligned` 从**恒真的长度比较**换成 **实测桶成员行 == 推算桶成员行**（纯函数 `readSamplesAlignedOf()` **导出** ＋ `buildByteSample()` 加第 4 个参数 ＋ 守卫生效文案改写）；⑩`VectorByteSample` 加**样本层**字段 `bucketMemberRowsDerived`（**不是落盘键** ⇒ 落盘结构零变化）；⑪`VectorByteReadsBreakdown` 的 `samplesAligned` 注释改成**真话**（删掉「仍有牙」那句说谎的）；⑫读路径 note 加 **⑧**（写明读路径的对账量 + 「原先那条是恒真的」）。 |
| `tests/unit/prune.test.ts` | 3 | **断言 1c**（`out.exactReads` === `scoreOf` **调用次数**；含「返回 `null` 的那次**照样计入**」与「两个配置的 `exactReads` 都等于各自的调用次数」两条）。 |
| `tests/bench/t06-byte-metering.test.ts` | 41（**9 → 39 → 41**） | C 组**形状登记表自测**（7 登记 + 1 未登记）· D 组**字节模型单测**（纯函数）· E 组**口径断言 1 / 1a / 1b / 1c-bench / 1d / 1d′ / 1e / 2 / 3 + 落盘结构 + note 六件事**。⇒ ★ **裁决落地 #1 轮新增 2 条**：⑨★ `读路径对账量的负控`（喂不等 / 长度不等 / `null` ⇒ 必须 `false` ⇒ **证明它不是恒绿守卫**）；⑩★ `口径张力钉死`（写路径 `embeddingRowsRead ≥ embeddingCalls` ⇒ **把「为什么 `embeddingRowsRead` 不能当 1c-bench 的比较对象」机器化**）。⇒ ★ 落盘结构用例的期望数组**补进了 `embeddingExactRows`**（**12 项 ⇒ 13 项**）⇒ ⇒ 否则 `arrayContaining` 会让它**悄悄消失而不被发现**。 |
| `tests/bench/h1-measurement.test.ts` | 4 | ①旧过滤串 `（H1）`/`（H2）` **全部换成** `（H1′）`/`（H2′）`；②「门槛归口」两条用例重写成**字节口径**（判据量 = `writeSegments.vectorByteReads.bytesRead.max`）；③**新增断言 5（过滤串失效守卫 · 两头锁死）**；④`gateRegrouping` 断言同步。 |

### 11.1 「两个结论」的落地形态（一次归一化 ⇒ 两个结论）

```
归一化 = 折叠空白 → trim → `IN (?, ?, …)` ⇒ `IN (…)` → 小写（bench/lib/byteSources.ts:normalizeSql）

【结论一 · legacy 行读】memories ⇒ candidate（⚠️ 必须在 vector_codes 之前）/ vector_cell_members ⇒ bucketMember / vector_codes ⇒ vectorCode / 聚合 ⇒ null
  ⇒ ★ **逐位复现旧行为** ⇒ `docs/baseline/*.json` 的 R6 `candidateReadRows` **不断档**

【结论二 · 字节来源】形状键 = (归一化 FROM/JOIN 表集合, 归一化 SELECT 源列名集合)
  登记表 7 个形状：Q1 / Q2 / Q3 / Q4 / Q5 / scoreOf / bucketCandidate
  未登记 ⇒ 命中零来源 ⇒ unclassifiedRows += 行数，unclassifiedSqlKinds += 指纹
```

⚠️ ★ **两个结论「分得干净」的实测证据**（断言 3 的用例）：喂一条未登记形状
`SELECT id FROM memories` ⇒ **legacy 侧照旧计 3 行**（逐位复现旧行为）
⇒ **字节侧一个字节都不认领**（`unclassifiedRows += 3`）⇒ ⇒ **两边互不污染**。

⚠️ ★ **形状 id = `bucketCandidate`**（① 裁决 4 订正版；定性照 ① `:249` 原文）：
**仅 `prune = false` 对照分支（A1 / A7）使用 ⇒ 两段式写路径不发 ⇒ 不在 bench 采样窗口内**；
**登记它是为了防御**（将来若打开对照分支，形状仍能认领「向量来源 + 成员来源」⇒ 不会静默漏检）。

### 11.2 ★ 「调用次数」怎么数（**剪枝率分子的命门**）

```
get() 包装：⚠️ **无条件** `calls += 1` ⇒ 返回 undefined 也计（bench/lib/harness.ts 的 `.get()` 分支）
  ⇒ ⇒ 它**定义上** == `prune` 的 `exactReads`（src/vector/prune.ts:289-290 一一对应）
rows  与 calls 的区别：rows = 物化行数；calls = 调用次数（剪枝率分子用 calls）
剪枝率 = embeddingCalls ÷ candidateUniverse（判定取 max）
```

⚠️ ★ **无条件计数的位置**：`calls += 1` 在 `if (row !== undefined)` **之外**
⇒ ⇒ **返回 `undefined` 的那次也算**（那一次**已经付了 IO 代价**）
⇒ ⇒ 而 legacy 的 `counters[kind] += 1` 仍**只在返回了行时**计（**逐位复现旧行为**）⇒ **两个数分得干净**。

### 11.3 当场累加标量（**OOM 防线**）

```
bytes 怎么累：⚠️ **当场累加标量**（`bytesOfRow()` 返回 `{payloadBytes, contentBytes, hasEmbedding, badCode}`
  ⇒ 立刻加进 `state.bytes` / `state.contentBytes`）⇒ ⇒ **绝不缓存行数组** ⇒ **O(1) 内存**
  ⇒ ⇒ 500 轮 × ~2,000 行 × 3 KB ≈ 4.6 GB ⇒ 缓存行数组会 **OOM** ⇒ ⇒ 必须当场累加
```

⚠️ ★ **字节是「实测」不是「推算」**：BLOB 取 `.byteLength`、字符串取 `Buffer.byteLength(v, 'utf8')`
⇒ ⇒ **标量列（`scale` / `eps` / `last_access` …）= 0 字节**（它们不是向量载荷）。

### 11.4 ★★ 计时口径：**读路径 = 单轮 / 写路径 = 两轮**（裁决第 1 号）

| 路径 | HEAD 的形状 | 本轮的实现 | 判据量 | `samplesAligned` 的含义 |
|---|---|---|---|---|
| **读路径**（探针 20/50） | **装计数器 + 计数 + 计时**（`git show HEAD:bench/perf.ts` 逐字核对） | **单轮 · 逐字同形**（计数器装着且在计数 ⇒ 字节与毫秒来自**同一个计时窗口**） | **不判门槛**（观测值） | ★★ **实测桶成员行 === 推算桶成员行**（口径裁决落地 #1） |
| **写路径**（探针 8/20） | **无计数器**（`start` → `collectVectorCandidates` → `end`） | **两轮制**（轮 A 计时**不装**计数器 / 轮 B 计量**装**计数器 · **同一份输入**） | ★ **H1′ / H2′ 的唯一判据量** | **两轮对齐**（轮 A / 轮 B 的 `candidateUniverse` 逐样本相等） |

⚠️ ★ **为什么读路径【不】拆两轮**（裁决第 1 号 · 硬证据）：
HEAD 的读路径**本来就是「装计数器 + 计数 + 计时」** ⇒ ⇒ 历史基线的 `vectorRouteP99Ms`
**本来就含计数器的逐行开销** ⇒ ⇒ **把它拆成两轮 = 改了口径（方向是变快）= 与历史基线不再逐位可比**
⇒ ⇒ **读路径必须回到单轮**（**① §3.3** 第 3 条：「召回窗口本轮**完全不动** ⇒ 口径没变」）。

⚠️ ★ **为什么写路径【要】拆两轮**（**① §3.3** 第 3 条的另一条硬证据）：
HEAD 的写路径扫描段**窗口里没有计数器** ⇒ ⇒ 历史基线的 `writeSegments.vectorCandidateScan`
是**「无计数器的干净测量」** ⇒ ⇒ **单轮（把计数器塞进被测区间）= 改口径 = 要重采百万级基线**
⇒ ⇒ **两轮 = 逐字复现旧取时位置 ⇒ 基线不用重采**。

### 11.5 ★★ 读路径的 `samplesAligned`：**从「恒真的长度比较」换成「有牙的桶成员行对账」**（口径裁决落地 #1）

⚠️ ★★★ **原实现是恒真的（架构师挖出来的真问题）**：

```
$ grep -n "readSamplesAligned" bench/perf.ts
1375:  const readSamplesAligned = readByteSamples.length === vectorRouteSamples.length;
```

两个 `push` 在**同一个 `for (const query of queries)` 循环体内、无条件、无 `continue` / `break`**
⇒ ⇒ **长度必然相等** ⇒ ⇒ **恒为 `true`** ⇒ ⇒ 它挂在 `checkPerf()` 的判红守卫上
⇒ ⇒ **永远打不红** ⇒ ⇒ 原注释里那句「仍有牙：漏采一个样本就红」**是错的**（已删）。

⇒ ⇒ **裁决落地**：读路径 `samplesAligned` 换成**真正有牙**的对账量
（**字段名 / 类型 / 落盘结构一律不动**）：

```
读路径 samplesAligned := (逐样本) 计数器的实测桶成员行 === 由 route() 命中桶推算的成员行之和
                       = bucketMemberRows（计数器 · search 侧实测） === bucketMemberRowsDerived（route 侧命中桶成员数之和）
```

| 实现要求 | 落点 |
|---|---|
| ① **提取成纯函数**（照 `samplesAlignedOf(roundA, roundB)` 的样式） | `bench/perf.ts` → **`export function readSamplesAlignedOf(measured, derived): boolean`**（**导出** ⇒ 门禁能单独喂数据） |
| ② **`buildByteSample` 多拿一个参数** | `bench/perf.ts` → `buildByteSample(before, after, candidateUniverse, bucketMemberRowsDerived)`；读路径循环里把已算好的 `candidateRowsDerived` 传进去 ⇒ ⇒ 逐样本的 `bucketMemberRows` delta 与它**配对**（写在同一个 `VectorByteSample` 对象里 ⇒ 不会错位） |
| ③ ★ **负控测试**（喂两个**不相等**的数组 ⇒ 必须返回 `false`） | `tests/bench/t06-byte-metering.test.ts` → `★ 读路径对账量的负控：readSamplesAlignedOf() 喂不相等的两个数组 ⇒ 必须返回 false（证明它不是恒绿守卫）` |
| ④ **守卫生效（文案）** | `bench/perf.ts` `checkPerf()` 的读路径那条 ⇒ 「**实测桶成员行 ≠ 推算桶成员行 ⇒ `search()` 看到的桶与 `route()` 看到的不是同一批 ⇒ 落盘的 `candidateUniverse` 对不上 ⇒ 不可判定**」 |

⚠️ ★ **为什么这个量有牙**（裁决落地 #1 的原文理由；⚠️ ★ **T07 起第 ③ 条的理由已按 ① §6.12 裁决 9 换掉** ⇒ ⇒ 下面第 ③ 条与 `bench/perf.ts` 的三处代码注释、读路径 note 的 ⑧ 现在都写的是**「来源不同」那条** ⇒ ⇒ **禁令不变、只换理由**）：

1. 读路径落盘的 `candidateUniverse` 来自 `countDistinctMembers(db, route() 的 fineIds)`
   （**在计时窗口之外**算），而字节来自 **`search()` 实际扫的桶**
   ⇒ 若 `search()` 内部路由与外层 `route()` 不一致 ⇒ 落盘的 `candidateUniverse`
   **对应的是另一批桶** ⇒ ⇒ **读数不可对账** ⇒ ⇒ 必须判红；
2. 两个量**同形可比**：都是「命中桶的成员行总数」
   （`readMemberIds()` 逐桶全量读、无 LIMIT；`membersOf()` = `countBucketMembers()`
   是桶计数的**唯一口径**）；
3. ⚠️ **不许用 `bucketMemberRows === candidateUniverse`**（**读路径**）——
   ⇒ ★ **理由 = 两个量【来源不同】**（计数器 `search()` 侧实测 vs 外层 `route()` 侧的
   `COUNT(DISTINCT memory_id)`）⇒ ⇒ 互比**会把「`search()` 内部路由 ≠ 外层 `route()` 路由」
   这个真正的失配掩盖掉** ⇒ ⇒ **守卫失明** ⇒ ⇒ **禁令不变、理由只有这一条**；
   ⇒ ⇒ ★ **理由与「唯一索引」那条事实的全文只写在 ①**（① §2 断言 1d 理由③ +
   ① §6.12 裁决 9 + ① §11 第 13 条）⇒ ⇒ **这里只指路、不抄一份**
   （抄一份 = 多一份会漂移的副本）⇒ ⇒ ★ **同一套措辞的落点**：
   `bench/perf.ts` 的三处代码注释 + 读路径 note 的 ⑧（**落盘字段**）。

#### 11.5.1 ★ 实测数据（**裁决的经验闸门**：逐样本对照）

> ⚠️ ★ **采样方式（这一轮换了方式 ⇒ 理由值得写下来）**：
> 上一轮是**在 `bench/perf.ts` 里加临时打印**采的 ⇒ ⇒ 那会**撞上「正在改文件的瞬间」**
> ⇒ ⇒ **team-lead 那边有一次 verify 红了**（查明原因 = 撞上了改文件的瞬间，**不是回归**）
> ⇒ ⇒ **这一轮改成「另写一个只读脚本」**（`.tmp/bench/read-align-diag.ts` ⇒ **gitignored**）
> ⇒ ⇒ **它用同一套生产件**（`prepareBench` / `loadCentroidModel` / `IvfVectorBackend` /
> `installRowReadCounter` / `countBucketMembers`）**逐字复刻 `bench/perf.ts` 读路径的那个循环**
> ⇒ ⇒ **仓库源码一个字没动**（⇒ ⇒ **零「改文件瞬间」窗口** ⇒ ⇒ verify 不会假红）。
>
> 采样命令：`pnpm exec tsx .tmp/bench/read-align-diag.ts`（**复用已训好的 `.tmp/bench/perf-2000.db`**）

| 样本 | 实测桶成员行（`bucketMemberRows`） | 推算桶成员行（`bucketMemberRowsDerived`） | 逐位相等？ | 差值 | （附）`candidateUniverse` |
|---|---|---|---|---|---|
| 0 | 30 | 30 | ✅ | **0** | 30 |
| 1 | 34 | 34 | ✅ | **0** | 34 |
| 2 | 42 | 42 | ✅ | **0** | 42 |
| 3 | 40 | 40 | ✅ | **0** | 40 |
| 4 | 38 | 38 | ✅ | **0** | 38 |
| 5 | 40 | 40 | ✅ | **0** | 40 |
| 6 | 35 | 35 | ✅ | **0** | 35 |
| 7 | 33 | 33 | ✅ | **0** | 33 |
| 8 | 40 | 40 | ✅ | **0** | 40 |
| 9 | 29 | 29 | ✅ | **0** | 29 |
| 10 | 50 | 50 | ✅ | **0** | 50 |
| 11 | 50 | 50 | ✅ | **0** | 50 |
| 12 | 50 | 50 | ✅ | **0** | 50 |
| 13 | 50 | 50 | ✅ | **0** | 50 |
| 14 | 50 | 50 | ✅ | **0** | 50 |
| 15 | 50 | 50 | ✅ | **0** | 50 |
| 16 | 50 | 50 | ✅ | **0** | 50 |
| 17 | 50 | 50 | ✅ | **0** | 50 |
| 18 | 51 | 51 | ✅ | **0** | 51 |
| 19 | 50 | 50 | ✅ | **0** | 50 |

⇒ ✅ **20/20 样本逐位相等，且每一个差值都是 0** ⇒ ⇒ **不需要停下回报**（裁决里那条「若不相等 ⇒ 停下回报」的分支**未触发**）。

⚠️ ★ **根因（为什么相等 ⇒ 三件事同时成立）**：
① `search()` 内部调的就是 `this.route(query, this.nprobeCoarse, this.nprobeFine)`
（`src/vector/ivf.ts:1044`）⇒ 与外层 `backend.route(query.embedding, 同一对 nprobe)` **同一批桶**；
② `search()` 里 Q1（`readMemberIds()`）**只发一次**（`collectMemberIds()` 只被调一次）
⇒ ⇒ 成员表**没被读两遍**；
③ 两侧数的都是**成员行数**（`readMemberIds()` 全量读、不去重地数行；
`countBucketMembers()` 是 `COUNT(*) FROM vector_cell_members WHERE fine_id = ?`）
⇒ ⇒ **同形可比**（**注意**：不是「去重后的成员数」——去重是 `readMemberIds()` 返回 `Set` 之后的事，
计数器数的是**读到的行数**）。

⇒ ⇒ ★ **为什么本轮 `candidateUniverse` 也恰好等于这两个数**（**不是「本轮语料恰好如此」**）：
`candidateUniverse` = `COUNT(DISTINCT memory_id)` ⇒ ⇒ ★ **在当前 schema 下、同一批桶内
它与成员行总数是【恒等】**（`vector_cell_members` 上有**唯一索引** ⇒ 一记忆只属一个细桶
⇒ ⇒ 同一批桶内 `COUNT(DISTINCT)` 恒等于 `COUNT(*)`）⇒ ⇒ **所以「本轮三者相等」不是巧合
而是【不变式】**（20/20 逐位相等、差值全 0 ⇒ 见上表）
⇒ ⇒ ⇒ ★ **但这正是裁决明令「不许用 `candidateUniverse` 当比较对象」的原因** ——
**理由 = 两个量【来源不同】**（计数器 `search()` 侧实测 vs 外层 `route()` 侧的
`COUNT(DISTINCT memory_id)`）⇒ ⇒ 互比**会把「`search()` 内部路由 ≠ 外层 `route()` 路由」
这个真正的失配掩盖掉** ⇒ ⇒ **守卫失明** ⇒ ⇒ **禁令不变、理由只有这一条**
⇒ ⇒ ★ **理由与「唯一索引」那条事实的全文只写在 ①**（① §2 断言 1d 理由③ +
① §6.12 裁决 9 + ① §11 第 13 条）⇒ ⇒ **这里只指路、不抄一份**。

## 12. 断言 × 落点 × 测试用例（**逐条对齐，一行都不许空**）

| 断言 | 口径 | 落在哪一行代码 | 测试用例名 | 打什么变异 | 结果 |
|---|---|---|---|---|---|
| **1 字节恒等式** | `bytesRead === codeBytes + embeddingBytes`（零容差） | `bench/lib/harness.ts` `snapshot()` 的 `bytesRead: codeBytes + embeddingBytes`；`bench/perf.ts` `buildVectorByteReads()` | `tests/bench/t06-byte-metering.test.ts` → `★ 断言 1：bytesRead === codeBytes + embeddingBytes（零容差恒等式）` + `★ 断言 1 的逐样本版本（counter 层 · 零容差）` | 把 `embeddingBytes` 漏记 / 记两遍 / 记到 `contentBytes` 里 | ✅ 绿（39/39 文件内全绿） |
| **1a 健康库检查** | `badCodeRows === 0` ⇒ `codeBytes === codeRowsRead × 768` | `bench/lib/byteSources.ts` `bytesOfRow()` 的 `badCode` 判定；`harness.ts` `accumulateRow()` | `★ 断言 1a（健康库检查）：badCodeRows === 0 ⇒ codeBytes === codeRowsRead × 768` | 把码长判定去掉（⇒ 坏码行静默通过）/ 把 768 写成 784 | ✅ 绿 |
| **1b legacy 交叉校验** | 写路径 `bytesRead === codeRows × 768 + memoryRows × 3,072`（**逐样本**零容差） | `bench/lib/harness.ts` 的 `codeBytes` / `embeddingBytes` / `counters.candidate` 三账 | `★ 断言 1b（legacy 交叉校验 · 写路径）` + `★ 断言 1b 的逐样本版本（counter 层 · 零容差）` | 分类**漏了 Q4** 或**漏了 `scoreOf`**（⇒ 字节对不上） | ✅ 绿 |
| **1c 等价性（tests 侧）** | `pruneTopK()` 的 `exactReads` === `scoreOf` **调用次数** | `src/vector/prune.ts:289-290`（**零 `src/**` 改动** ⇒ 只在测试侧钉） | `tests/unit/prune.test.ts` → `★ 断言 1c：exactReads === scoreOf 的【调用次数】`（3 条） | `prune.ts` 改了 `exactReads` 的计数口径（改成「只数返回了行的」） | ✅ 绿（16/16） |
| **1c-bench 口径纪律** | 分子 = `embeddingCalls`（`get()` 调用次数）⇒ **≥** `embeddingExactRows` | `bench/lib/harness.ts` `.get()` 包装的**无条件** `calls += 1`；`bench/perf.ts` `buildVectorByteReads()` 的 `pruneRate` | `★ 断言 1c-bench（口径纪律）：分子 = embeddingCalls（调用次数）⇒ ≥ scoreOf 返回行数` **＋** ★ `口径张力钉死：写路径 embeddingRowsRead ≥ embeddingCalls（Q4 让字节账分子必然 ≥ 调用数）` | 把剪枝率分子换成「返回行数」（⇒ **偏松 = 假绿**） | ✅ 绿 ⚠️ **判定对象用了 `embeddingExactRows`**（见 §15 偏差 ②）⇒ ⇒ **「为什么 `embeddingRowsRead` 不能当 1c-bench 的比较对象」已被机器钉死**（写路径 `embeddingRowsRead.max ≥ embeddingCalls.max` ⇒ **① §4** 的字面形式 `embeddingCalls ≥ embeddingRowsRead` **在写路径不成立**） |
| **1d 两轮对齐（写路径）** | 写路径 `samplesAligned === true` | `bench/perf.ts` `samplesAlignedOf(writeUniverseSamples, writeUniverseSamplesB)` | `★ 断言 1d（两轮对齐）：写路径 samplesAligned === true（写路径才是两轮）` | 两轮之间有库写入 / 计量扰动了扫描 ⇒ 两个 `candidateUniverse` 不等 | ✅ 绿 |
| **1d′ 读路径对账（口径裁决 8 ①）** | 读路径 `samplesAligned` := **实测桶成员行 === 推算桶成员行**（逐样本） | `bench/perf.ts` `readSamplesAlignedOf(measured, derived)`（**导出**的纯函数）+ `buildByteSample()` 的第 4 个参数 | `★ 断言 1d（…）` 里那条读路径断言 **＋** ★ `读路径对账量的负控：readSamplesAlignedOf() 喂不相等的两个数组 ⇒ 必须返回 false（证明它不是恒绿守卫）` | 把 `readSamplesAlignedOf()` 写成「恒返回 true」（**像原先那条恒真的长度比较**）⇒ ⇒ 读路径的「不可判定」守卫永远打不红 ⇒ ⇒ **说谎** | ✅ 绿（**负控已证明它能被打红**：**正控 + 4 种负控**（不等 / 长度不等 / `null` / 空数组）⇒ **全部按预期返回**）⇒ 逐样本实测 **20/20 相等、差值全 0**（见 §11.5.1） |
| **1e 窗口没开大** | 写路径 `bucketMemberRows === candidateUniverse`（零容差） | `bench/lib/harness.ts` 的 `bucketMemberRowsRead`；`bench/perf.ts` `buildByteSample()` 的 `candidateUniverse` | `★ 断言 1e（窗口没开大）：写路径 bucketMemberRows === candidateUniverse（零容差）` | 把写路径的计量窗口开到「罩住生产写入循环内部那次向量扫描」 | ✅ 绿 |
| **2 分类完备** | `unclassifiedRows === 0` + 各形状行数之和 == 对应读数 | `bench/lib/harness.ts` `accumulateRow()` 的 `shape === null` 分支 | `★ 断言 2（分类完备）：unclassifiedRows === 0 且 各形状行数之和 == 对应读数` | 新增一条生产 SQL（改了 SELECT 列表）而**没同批登记** | ✅ 绿 |
| **3 unclassified 自检** | 喂 `SELECT id FROM memories` ⇒ 落进 `unclassified`（且**字节侧一个字节都不认领**） | `bench/lib/harness.ts` `.all()` / `.get()` 包装的 `shape === null` 分支 | `★ 断言 3（unclassified 自检）：喂一条未登记的形状 ⇒ 必须落进 unclassified` | 形状登记制被改成「开放的表 + 列规则」（⇒ 命中零来源**恒为 0** ⇒ 守卫没牙） | ✅ 绿 |
| **4 零 src 改动** | `git diff --stat src/` **为空** | ——（**仓库状态** ⇒ 只能由验收命令验 ⇒ 写在测试文件里会骗人） | `git diff --stat src/`（验收命令） | 顺手改 `src/**`（含注释） | ✅ **空**（见 §14） |
| **5 过滤串失效守卫** | 旧串 `（H1）`/`（H2）` **匹配不上任何违规行**；新串 `（H1′）`/`（H2′）` **确实匹配得上** | `bench/perf.ts` `checkPerf()` 的三条标签 | `tests/bench/h1-measurement.test.ts` → `★ 断言 5：旧过滤串 （H1）/（H2）失效 且 新过滤串 （H1′）/（H2′） 有效（两头锁死）` | 把新标签改回旧标签 / 用宽松匹配（`includes('H1')` 而不是 `includes('（H1′）')`）⇒ **过滤串失效** | ✅ 绿（20/20） |

## 13. 落盘结构与判定（**实际落盘 JSON 片段**）

> ⚠️ **下面是真实落盘的 JSON**（`pnpm exec tsx bench/perf.ts --scale=2000 --queries=20 --writes=20
> --allow-small-scale --out=…` 的产物；⚠️ **小规模 ⇒ 数值只当「形状样板」，不当验收数字**）。

```json
// writeSegments.vectorByteReads（★ H1′ / H2′ 的唯一判据量在这个容器里）
// ⚠️ 下面是 .tmp/bench/perf-2000.json 里该对象的【逐字原文】（JSON.stringify(x, null, 2)）
{
  "memoryRowsRead": {
    "count": 20,
    "min": 0,
    "mean": 1.9,
    "p50": 2,
    "p99": 2,
    "max": 2
  },
  "codeRowsRead": {
    "count": 20,
    "min": 11,
    "mean": 21.4,
    "p50": 21,
    "p99": 26,
    "max": 26
  },
  "bytesRead": {
    "count": 20,
    "min": 8448,
    "mean": 22272,
    "p50": 22272,
    "p99": 26112,
    "max": 26112
  },
  "candidateUniverse": {
    "count": 20,
    "min": 11,
    "mean": 21.4,
    "p50": 21,
    "p99": 26,
    "max": 26
  },
  "breakdown": {
    "codeBytes": {
      "count": 20,
      "min": 8448,
      "mean": 16435.2,
      "p50": 16128,
      "p99": 19968,
      "max": 19968
    },
    "embeddingBytes": {
      "count": 20,
      "min": 0,
      "mean": 5836.8,
      "p50": 6144,
      "p99": 6144,
      "max": 6144
    },
    "contentBytes": {
      "count": 20,
      "min": 0,
      "mean": 151.15,
      "p50": 157,
      "p99": 161,
      "max": 161
    },
    "embeddingRowsRead": {
      "count": 20,
      "min": 0,
      "mean": 1.9,
      "p50": 2,
      "p99": 2,
      "max": 2
    },
    "embeddingExactRows": {
      "count": 20,
      "min": 0,
      "mean": 0.95,
      "p50": 1,
      "p99": 1,
      "max": 1
    },
    "embeddingCalls": {
      "count": 20,
      "min": 0,
      "mean": 0.95,
      "p50": 1,
      "p99": 1,
      "max": 1
    },
    "narrowRowsRead": {
      "count": 20,
      "min": 0,
      "mean": 0,
      "p50": 0,
      "p99": 0,
      "max": 0
    },
    "bucketMemberRows": {
      "count": 20,
      "min": 11,
      "mean": 21.4,
      "p50": 21,
      "p99": 26,
      "max": 26
    },
    "badCodeRows": 0,
    "unclassifiedRows": 0,
    "unclassifiedSqlKinds": [],
    "pruneRate": {
      "count": 20,
      "min": 0,
      "mean": 0.04348040403532396,
      "p50": 0.045454545454545456,
      "p99": 0.05263157894736842,
      "max": 0.05263157894736842
    },
    "samplesAligned": true
  },
  "note": "① ★ **口径**：`bytesRead` = **向量载荷字节**（码 BLOB + embedding BLOB 的**实测** `byteLength` 之和；**恒等式** `bytesRead = codeBytes + embeddingBytes`，零容差）；**不含**正文 / 标量 / 成员标识 / SQLite 行头与页开销 ⇒ ⇒ **是真实搬运量的【下界】⇒ 判据偏严、不会假绿**（口径 §1.3 裁决 A）；② ⚠️ ★ **ADR §8.6 那个 `4.44 MB` 是【偏高的估计】、不是【下界】**（它按「每轮 64 次精确重排 × 3,072 B」估 ⇒ 而 **2026-11-05 实测精确分只读了 2 行** ⇒ 实测 4,065,792 B **低于**它 8~13%）⇒ ⇒ **实测低于它属预期、不是回归**；★ **2026-11-05 实测**：4,065,792 B（≤ 6,144,000 B ⇒ **绿**，余量 33.8%）；⚠️ ★ **具体差在哪**：**写路径 survivors 的 `embedding` 被读【两次】** —— **`scoreOf` 逐条一次** + **Q4 整行批量再一次** ⇒ ⇒ **§8.6 那张表漏了 Q4 那一笔**；③ ⚠️ ★ **H1′ 判的是哪一笔**：本块 = **bench 的「写入扫描独立实测段」** （`collectVectorCandidates()` 那一笔 ⇒ 同探针 8/20、同库、同被考核方 ⇒ **与旧 H1 的 `vectorCandidateRows` 同一笔 ⇒ H1′ 与 H1 可比**）；⚠️ **它【不是】`store.write()` 内部那一笔** —— 生产写入内部自己就会走向量候选扫描 （`src/store/write.ts:671` → `collectDedupCandidates()` → `collectVectorCandidates()`）⇒ 那一笔**不单独落盘**（已被 `writeTotal` 的计时覆盖）⇒ **两笔都在，只有一笔是判据量**；⇒ 且独立实测段跑在写入循环**之后**（库里已多了 N 条 ⇒ 候选面更大）⇒ **略偏悲观 ⇒ H1′ 偏严**；⚠️ **真实写入的「总读取字节」远不止这些**（文本路 FTS / 合并判定 / 桶归属）⇒ **那些字节一次都没被观测** ⇒ ⇒ **H1′ 不是「一次真实写入的总字节预算」**（它只是**向量载荷**这一项）；④ ⚠️ ★ **剪枝率分子的等价性前提**：分子 = `embeddingCalls` = bench 侧数出来的 **`get()` 调用次数**（**无条件**计数 ⇒ 返回 `undefined` 也计）⇒ ⇒ 它**定义上** == `prune` 的 `exactReads`（`src/vector/prune.ts:289-290` 一一对应）⇒ ⇒ 等价性由 `tests/unit/prune.test.ts` 的断言 1c 钉住（**零 `src/**` 改动**）；⚠️ **该等价性只在两段式分支（`prune = true`）成立**（`prune = false` 的对照分支不调 `scoreOf`）；⚠️ ★ **方向纪律**：门槛是「≤」⇒ **分子偏小 = 偏松 = 假绿** ⇒ **绝不许用「返回行数」当分子**；⑤ ⚠️ ★ **计时口径**：**写路径 = 两轮制**（轮 A 计时**不装**计数器 / 轮 B 计量**装**计数器，**同一份输入**）⇒ ⇒ **`vectorCandidateScan` 的毫秒数与历史基线逐位可比**（口径同源）⇒ ⇒ `samplesAligned` 证明「计量没有扰动扫描」；⚠️ ★ **读路径 = 单轮**（计数器**装着且在计数** + 计时 ⇒ **与 HEAD 逐字同形**）⇒ ⇒ **字节读数与毫秒数来自【同一个计时窗口】**；⑥ ⚠️ ★ **读路径的字节累加与行读计数同处一个计时窗口** ⇒ 逐行字节计算的微小开销落在 `vectorRouteP99Ms` 里 ⇒ 与历史基线是**同量级而非逐位**；但相对每行 3 KB 的读取开销**可忽略（< 1%）** ⇒ **判门槛的 `vectorRouteP99Ms` 不受影响**；⑦ **旧行数判据已降级为并列观测**（`writeSegments.vectorCandidateRows` 仍落盘、仍打印，但**不再进 `failures`** ⇒ 字节口径下它已不是判据；阈值常量一个都没删）。"
}
```

```json
// 顶层 vectorRouteByteReads（★ 观测值 · 不判门槛）
// ⚠️ 下面是 .tmp/bench/perf-2000.json 里该对象的【逐字原文】（JSON.stringify(x, null, 2)）
{
  "memoryRowsRead": {
    "count": 20,
    "min": 20,
    "mean": 20,
    "p50": 20,
    "p99": 20,
    "max": 20
  },
  "codeRowsRead": {
    "count": 20,
    "min": 29,
    "mean": 43.65,
    "p50": 42,
    "p99": 53,
    "max": 53
  },
  "bytesRead": {
    "count": 20,
    "min": 83712,
    "mean": 94963.2,
    "p50": 93696,
    "p99": 102144,
    "max": 102144
  },
  "candidateUniverse": {
    "count": 20,
    "min": 29,
    "mean": 43.65,
    "p50": 42,
    "p99": 53,
    "max": 53
  },
  "breakdown": {
    "codeBytes": {
      "count": 20,
      "min": 22272,
      "mean": 33523.2,
      "p50": 32256,
      "p99": 40704,
      "max": 40704
    },
    "embeddingBytes": {
      "count": 20,
      "min": 61440,
      "mean": 61440,
      "p50": 61440,
      "p99": 61440,
      "max": 61440
    },
    "contentBytes": {
      "count": 20,
      "min": 0,
      "mean": 0,
      "p50": 0,
      "p99": 0,
      "max": 0
    },
    "embeddingRowsRead": {
      "count": 20,
      "min": 20,
      "mean": 20,
      "p50": 20,
      "p99": 20,
      "max": 20
    },
    "embeddingExactRows": {
      "count": 20,
      "min": 20,
      "mean": 20,
      "p50": 20,
      "p99": 20,
      "max": 20
    },
    "embeddingCalls": {
      "count": 20,
      "min": 20,
      "mean": 20,
      "p50": 20,
      "p99": 20,
      "max": 20
    },
    "narrowRowsRead": {
      "count": 20,
      "min": 0,
      "mean": 0,
      "p50": 0,
      "p99": 0,
      "max": 0
    },
    "bucketMemberRows": {
      "count": 20,
      "min": 29,
      "mean": 43.65,
      "p50": 42,
      "p99": 53,
      "max": 53
    },
    "badCodeRows": 0,
    "unclassifiedRows": 0,
    "unclassifiedSqlKinds": [],
    "pruneRate": {
      "count": 20,
      "min": 0.37735849056603776,
      "mean": 0.4747863527425558,
      "p50": 0.4,
      "p99": 0.6896551724137931,
      "max": 0.6896551724137931
    },
    "samplesAligned": true
  },
  "note": "① ★ **口径**：`bytesRead` = **向量载荷字节**（码 BLOB + embedding BLOB 的**实测** `byteLength` 之和；**恒等式** `bytesRead = codeBytes + embeddingBytes`，零容差）；**不含**正文 / 标量 / 成员标识 / SQLite 行头与页开销 ⇒ ⇒ **是真实搬运量的【下界】⇒ 判据偏严、不会假绿**（口径 §1.3 裁决 A）；② ⚠️ ★ **ADR §8.6 那个 `4.44 MB` 是【偏高的估计】、不是【下界】**（它按「每轮 64 次精确重排 × 3,072 B」估 ⇒ 而**读路径**把命中候选的 embedding 也读了一遍⇒ ⇒ **实测 7,233,792 B 高于它是预期、不是回归**（口径更严）⇒ ⇒ ★ **2026-11-05 实测**：7,233,792 B）；③ ★ **读路径**：无 Q4（survivors 的 `embedding` 只读一次）⇒ 字节构成 = 码字节 + `scoreOf` 的向量字节；④ **候选宇宙** = `COUNT(DISTINCT memory_id)`（**在计时窗口之外**执行）；⚠️ ★ **等价前提**：bench 的 `backend` 是**新建实例** ⇒ `overlay` 空；`backend.search(q, k)` **不带 filter** ⇒ 无 `excludeIds`、无时间窗 ⇒ **Q3 不发** ⇒ ⇒ 该值 **== `memberIds.size`**（逐位）⇒ **前提一破即不等**（口径 §1.7 / §13 第 3 条）；⑤ ⚠️ **读路径【不判门槛】**（与 R6 同组：观测值）⇒ 判据只在 `writeSegments.vectorByteReads`；⑥ ⚠️ ★ **剪枝率的分子（`embeddingCalls`）只在【两段式分支】与 `prune` 的 `exactReads` 定义性相等**；⚠️ ★ **方向纪律**：**绝不许用「返回行数」当分子**（偏小 = 偏松 = 假绿）；⑦ ★ **计时口径**：**读路径 = 单轮**（计数器**装着且在计数** + 计时 ⇒ **与 HEAD 逐字同形**）⇒ ⇒ **字节读数与毫秒数来自【同一个计时窗口】** ⇒ **字节与毫秒天然同源**；⚠️ ★ **因此**：`vectorRouteP99Ms` 与历史基线是**同量级而非逐位**（逐行字节计算的微小开销落在窗口里）⇒ 但相对每行 3 KB 的读取开销**可忽略（< 1%）** ⇒ **判门槛的 `vectorRouteP99Ms` 不受影响**；⑧ ★★ **读路径的对账量（口径裁决落地 #1）**：`samplesAligned` = **实测桶成员行**（计数器认领的「成员来源」行数 = `search()` 真正扫的桶）**逐样本等于** **推算桶成员行**（`route()` 命中的桶各自 `countBucketMembers()` 之和）⇒ ⇒ 不等 ⇒ `search()` 看到的桶与 `route()` 看到的不是同一批⇒ ⇒ 落盘的 `candidateUniverse` 对不上 ⇒ ⇒ **不可判定 ⇒ 判红**；⇒ ⚠️ **不许用 `bucketMemberRows === candidateUniverse`**（读路径：二者【来源不同】—— 计数器 `search()` 侧实测 vs 外层 `route()` 侧的 COUNT(DISTINCT memory_id) ⇒ 互比会掩盖真正的失配 ⇒ 详见 §2 断言 1d 理由③）；⚠️ ★ **读路径原先那条「字节样本数 == 计时样本数」是【恒真的】**（两个 `push` 在同一个循环体内、无条件、无 `continue` / `break` ⇒ 长度必然相等⇒ ⇒ 挂在判红守卫上却**永远打不红**）⇒ ⇒ **已换掉**；⚠️ **注意：写路径才是两轮制**（轮 A 计时**不装**计数器 / 轮 B 计量**装**计数器）⇒ `samplesAligned` 的**两轮对账只在写路径有牙**（读路径的对账量是**上面第 ⑧ 条**）。"
}
```

⚠️ ★ **两个容器的 `breakdown` 都是【同样那 13 项】**（键名一个都不多、一个都不少）：
`codeBytes` / `embeddingBytes` / `contentBytes` / `embeddingRowsRead` / `embeddingExactRows` /
`embeddingCalls` / `narrowRowsRead` / `bucketMemberRows` / `badCodeRows` / `unclassifiedRows` /
`unclassifiedSqlKinds` / `pruneRate` / `samplesAligned`
⇒ ★ **注意**：**① §4** 表里列的是 **12 项**，**本轮多落了一项 `embeddingExactRows`**（⇒ 变成 **13 项**）
⇒ ⇒ 原因是 §15 ② 那条**口径内部张力**（`embeddingRowsRead` ≠ `embeddingCalls` 的比较对象）⇒
⇒ ⇒ **新增它是为了让 1c-bench 有可判定的比较对象** ⇒ ⇒ **旧键一个都没动**（只是多了一项）。
⇒ ⇒ **断言侧已同步**（`tests/bench/t06-byte-metering.test.ts` 的落盘结构用例把
`embeddingExactRows` **写进期望数组** ⇒ ⇒ 否则 `arrayContaining` 会让它**悄悄消失而不被发现**）。

* **H1′ 判据**：`writeSegments.vectorByteReads.bytesRead.max ≤ 6,144,000 B` ⇒ 标签 **`（H1′）`**
* **H2′ 判据**：`writeSegments.vectorByteReads.bytesRead.max ÷ (库规模 × 3,072 B) ≤ 0.2%` ⇒ 标签 **`（H2′）`**
* **剪枝率判据**：`writeSegments.vectorByteReads.breakdown.pruneRate.max ≤ 0.15`
  （= `embeddingCalls ÷ candidateUniverse`，**逐样本**求比值后取 max）⇒ 标签 **`（PRUNE_RATE）`**
* **旧行数**：`writeSegments.vectorCandidateRows` 仍落盘、仍打印，但**只许说「观测值 = … 行」** ⇒ **不进 `failures`**
* ⚠️ ★ **顶层 `vectorRouteByteReads` 不进 `recallVectorPath`**（那是「整条召回的 old vs new 时序对比」）

### 13.1 ★ stdout 的四读数并列打印（真实输出片段）

```
  ★★ H1′ 向量载荷字节（写入去重路径 · 探针 8/20）= 26112 B（判定取 max；均值 22272.0 B、p99 26112 B，门槛 ≤ 6144000 B，样本 20）
    ★ H1′ 口径 = 实测（生产 SQL 实际物化的向量载荷字节 = 实测 byteLength 之和）（不含正文 / 标量 / 页开销 ⇒ 是真实搬运量的下界 ⇒ 判据偏严；判据量 = writeSegments.vectorByteReads.bytesRead）
  ★★ H2′ 向量载荷字节 ÷（库规模 × 3,072 B）（写入去重路径 · 探针 8/20）= 0.4250%（门槛 ≤ 0.2%）
  ★★ 剪枝率（PRUNE_RATE · 分子 = embeddingCalls = get() 调用次数）= 5.26%（门槛 ≤ 15%）
  ★ 记忆行读数 memoryRowsRead = 2 行（均值 1.9；码行 codeRowsRead = 26 行；候选宇宙 candidateUniverse = 26）
  ★ 旧行数（观测值 = 26 行，写入去重路径 · 探针 8/20）（均值 21.4 行；⚠️ 字节口径下它已不是判据；历史行数口径 ≤ 2000 行，样本 20）
```

## 14. 校验结果（**命令 × 结果**）

> ⚠️ **下面是「裁决落地 #1 + QA 的 P1 + 注释机器守卫」最终轮的【亲自重跑】的真实输出**（不是引述上一轮的；**每条命令本轮都亲自跑过**）。
> ⚠️ ★ **实测时间窗**：2026-11-04 **22:00 ~ 22:08**（⇒ 与 team-lead / QA 的任何一次运行**都不重叠** ⇒ ⇒ 下面每个数字都对应**磁盘上的当前快照**）。

| 命令 | 真实输出（原文） | 结果 |
|---|---|---|
| `pnpm run lint` | `$ biome check .` / `Checked 254 files in 586ms. No fixes applied.` | ✅ **exit 0** |
| `pnpm run typecheck` | `$ tsc --noEmit`（**无任何输出**） | ✅ **exit 0** |
| `pnpm exec vitest run tests/bench/t06-byte-metering.test.ts tests/bench/h1-measurement.test.ts tests/unit/prune.test.ts` | `Test Files  3 passed (3)` / `Tests  79 passed (79)` / `Duration  146.95s` | ✅ **exit 0**（**79 = 77 + 本轮新增 2 条**：形状逐判定的**负控** + 「注释说谎」的**机器守卫**） |
| `pnpm exec vitest run tests/bench/t06-byte-metering.test.ts -t "机器守卫"` | `Test Files  1 passed (1)` / `Tests  1 passed | 42 skipped (43)` / `Duration  7.55s` | ✅ **exit 0**（★ **单独点名跑** ⇒ 证明这条守卫**真的在被执行**，不是「文件名对但没跑」） |
| `pnpm exec vitest run tests/contracts/table-name-boundary.test.ts` | `Test Files  1 passed (1)` / `Duration  2.01s` | ✅ **exit 0** |
| `pnpm run check:params`（★ 仍 60 项） | `§5 解析出的参数条数：60` / `DEFAULT_PARAMS 的键数：60` / `✓ §5 表与 DEFAULT_PARAMS 逐键逐值相等` | ✅ **exit 0** |
| `git diff --stat src/`（★ **必须为空**） | **无任何输出**（`wc -l` = **0**） | ✅ **空** |
| `pnpm run verify` | 末行 `✅ 全部负控符合预期 ⇒ 审计脚本**有判别力**（不是恒绿守卫）`；`VERIFY_EXIT=0`（整体 2 分 29 秒） | ✅ **exit 0** |
| `pnpm test`（`verify` 内那一轮） | `Test Files  97 passed (97)` / `Tests  1959 passed (1959)` / `Duration  98.20s` | ✅ **exit 0**（**1959 = 1957 + 本轮新增 2 条**） |
| `pnpm run check:json-note`（★ 只读自检 · 脚本已进仓库 `scripts/check-json-note-fidelity.ts`） | `JSON note 块数量：2` / `note[0]（1560 字）在 bench/perf.ts 中逐字命中：true` / `note[1]（**1424 字**）在 bench/perf.ts 中逐字命中：true` / `WRITE: true  READ: true` | ✅ **§13 的 JSON 与 `bench/perf.ts` 的 note 逐字一致**（⇒ 它不是手写样例） |
| **章节引用消歧**（3 条 `grep -c`） | **0 / 0 / 0**（★ 三条**全部清零** ⇒ 「§N 指向不唯一」的坑已堵死；⚠️ **本行故意不写出那三条 grep 的模式原文** ⇒ ⇒ 否则本行会**命中它自己** ⇒ ⇒ 下一个人复跑会得到 **1** 而不是 **0** ⇒ ⇒ **模式见 §0 的「引用纪律」表**（那里列了哪几种前缀算**作废写法**）⇒ ⇒ 复跑命令：`grep -c "作废前缀1" …` 之类，**自己拼**） |


⚠️ ★ **另附一次真实落盘运行**（证明 §13 的 JSON 不是手写样例）：
```
$ pnpm exec tsx bench/perf.ts --scale=2000 --queries=20 --writes=20 --allow-small-scale --out=.tmp/bench/perf-2000.json
  ★★ H1′ 向量载荷字节（**写入去重路径** · 探针 8/20）= 26112 B（判定取 max；均值 22272.0 B、p99 26112 B，门槛 ≤ 6144000 B，样本 20）
  ★★ H2′ 向量载荷字节 ÷（库规模 × 3,072 B）（**写入去重路径** · 探针 8/20）= 0.4250%（门槛 ≤ 0.2%）
  ★★ 剪枝率（PRUNE_RATE · 分子 = embeddingCalls = get() 调用次数）= 5.26%（门槛 ≤ 15%）
  ★ 记忆行读数 memoryRowsRead = 2 行（均值 1.9；码行 codeRowsRead = 26 行；候选宇宙 candidateUniverse = 26）
  结果已写入 .tmp/bench/perf-2000.json
```
⇒ ⚠️ **小规模 ⇒ 数值只当「形状样板」，不当验收数字**（规模守卫已显式降级告警）。

⚠️ ★★ **另附「读路径逐样本对账」的实测**（**裁决落地 #1 的经验闸门**）：
**20/20 样本逐位相等，且每一个差值都是 0**（实测桶成员行 == 推算桶成员行）⇒ ⇒ **裁决里「若不相等 ⇒ 停下回报」的分支未触发**
⇒ ⇒ **逐样本表格见 §11.5.1**（那张表是**本轮真实采样**的结果，不是推演）。
⇒ ⚠️ ★ **采样方式 = 「另写一个只读脚本」**（`.tmp/bench/read-align-diag.ts` ⇒ **gitignored**）
⇒ ⇒ **仓库源码一个字没动**（⇒ ⇒ **零「改文件瞬间」窗口** ⇒ ⇒ **不会像上一轮那样撞出一次假红的 verify**）
⇒ ⇒ 上一轮那段**临时打印**（`T06_DIAG`）**采样完已删** ⇒ ⇒ `grep -rn "T06_DIAG" bench/ tests/` = **0 命中**。

## 15. 已知偏差 / 未做项 / 与设计的出入（**如实写，不许藏**）

| # | 事项 | 原因 | 影响 |
|---|---|---|---|
| ① | ★ **读路径的字节累加与行读计数同处一个计时窗口** ⇒ 逐行字节计算的微小开销落在 `vectorRouteP99Ms` 里 ⇒ 与历史基线是**同量级而非逐位**（相对每行 3 KB 的读取开销 **< 1%** ⇒ 判门槛的 `vectorRouteP99Ms` 不受影响） | **裁决第 1 号**：HEAD 的读路径本来就是「装计数器 + 计数 + 计时」⇒ 拆两轮 = **改口径**（方向是变快）⇒ 与历史基线不再逐位可比 ⇒ ⇒ **读路径必须单轮**（**① §3.3** 第 3 条：「召回窗口本轮**完全不动**」） | ⚠️ `vectorRouteP99Ms` 与历史基线**不是逐位相同**（但**同量级**）⇒ 已写进**读路径 note 的 ⑦** 与**写路径 note 的 ⑥** ⇒ 读 JSON 的人不会误读 |
| ② | ⚠️ ★ **断言 1c-bench 的判定对象用了 `embeddingExactRows`（新增字段），不是 **① §4** 表里的 `embeddingRowsRead`** | ⚠️ **实测出来的口径内部张力**：`embeddingRowsRead` = **物化出 `embedding` 的行数**（= `scoreOf` 的行 **+** Q4/Q5 survivors 的行）；而 `embeddingCalls` 只数 `scoreOf` 的 `get()` **调用次数** ⇒ ⇒ **写路径的 Q4 一发（survivors 整行读）⇒ `embeddingRowsRead` 就比 `embeddingCalls` 大** ⇒ ⇒ ① §4 的字面形式 `embeddingCalls ≥ embeddingRowsRead` **在写路径不成立**（实测：`embeddingRowsRead.max = 2` 而 `embeddingCalls.max = 1`） | ⇒ **新增 `embeddingExactRows`**（= `scoreOf` 返回行数）作为 1c-bench 的**可判定比较对象** ⇒ 判据形式 = `embeddingCalls ≥ embeddingExactRows`；⚠️ **「严格不等」的证据**（调用里有「白调用」⇒ 调用数 > 返回行数）由 `tests/unit/prune.test.ts` 的断言 1c 提供（那里能造出返回 `null` 的白调用）。✅ **口径已按【裁决 8 ②】改成 `embeddingCalls ≥ embeddingExactRows`**（`docs/design/perf-c2-t06-byte-metering.md:188`）⇒ ⇒ **本实现与口径逐字一致**（措辞核对：`embeddingExactRows` = 「`scoreOf` 返回了行的次数」＝ `embeddingCalls` 减去「白调用」⇒ **同一口径**）；⇒ ⇒ **读路径的加强形式也已落进测试**（读路径无 Q4 ⇒ 两数同域 ⇒ `embeddingCalls ≥ embeddingRowsRead` **在读路径成立** ⇒ 实测 20 = 20）⇒ ⇒ **写路径恒红 / 读路径成立**这个「域差」被机器化了 |
| ③ | ⚠️ ★ **落盘层的跨样本恒等式**：`bytesRead.max === codeBytes.max + embeddingBytes.max` 是**跨样本**的（各序列的 `max` 可能来自不同样本）⇒ ⇒ **它不是结构性成立的** | ⇒ ⇒ 断言 1 的**零容差形态落在逐样本层**（counter 层 ⇒ 确定性）⇒ 落盘层**同时**断言 `max` 形式（口径原文）与**结构性成立的 `mean` 形式** | ⇒ 若哪天 `max` 形式破了 ⇒ **不是**「账算错了」，而是「各序列的 max 来自不同样本」⇒ 另一个要查的问题（**已在测试注释里写明**） |
| ④ | ⚠️ **断言 1b 在落盘层用的是 `memoryRowsRead`**（ADR §8.5 的「原口径」），**不是** `writeSegments.vectorCandidateRows` | 后者是**候选宇宙**（`scan.scanned`）⇒ 它是**桶成员数**、不是「`memories` 侧实际物化的行数」⇒ 拿它乘 3,072 **恒等式不成立** | ⇒ 1b 的判据量 = `codeRowsRead.max × 768 + memoryRowsRead.max × 3,072`（**写路径 Q3 不发 ⇒ `memoryRowsRead` == legacy `candidateRows`** ⇒ 等价）⇒ **另加**一条**逐样本（counter 层）**的零容差版本 |
| ⑤ | ⚠️ **`src/vector/ivf.ts:1387` 的过期 JSDoc**（`readCandidateRows()` 说谎）**本轮没改** | **硬边界**：本轮**零 `src/**` 改动**（含注释）⇒ 断言 4 | ⇒ 已登记进 **① §13** 待办第 8 条 ⇒ **留给下一轮** |
| ⑥ | ⚠️ **`docs/baseline/*.json` 的旧基线**里**没有**新的字节字段 | 本轮**只落结构、不重采基线**（重采是 T07 的活）⇒ ⇒ 读旧 JSON 的代码**不会炸**（新对象都带 `count: 0` 的空分布） | ⇒ ⇒ **已于 2026-11-05 回填**（1M · 热档 · HDD：`bytesRead.max` = **4,065,792 B** ⇒ ≤ 6,144,000 B ⇒ **绿**，余量 33.8%）⇒ ⇒ **本条的前提已解除** |
| ⑦ | ⚠️ **`bench/lib/byteSources.ts` 的 `bucketCandidate` 形状在生产路径上【不发】** | 它只服务于 `prune = false` 对照分支（A1 / A7）⇒ **两段式写路径不发** ⇒ ⇒ 不在 bench 采样窗口内 | ⇒ **登记它是为了防御**（将来打开对照分支时形状仍能认领 ⇒ 不会静默漏检）⇒ ⇒ **它不会给字节账贡献任何字节**（实测：`unclassifiedRows = 0`） |
| ⑧ | ⚠️ **临时调试脚本已全部删除**（`tmp-debug-bytes.ts` / `tmp-debug-shapes.ts` / `tmp-debug-stability.ts` / `tmp-patch-h1.py`） | ⚠️ **工作区不许留临时脚本**（它们会进提交） | ⇒ ✅ 工作区只有 `bench/**` + `tests/**` + `docs/**` 的改动 |
| ⑨ | ⚠️ ★ **`breakdown` 实际落了【13 项】**，而 **① §4** 表里列的是【12 项】 ⇒ **多了一项 `embeddingExactRows`** | 与 §15 ② 同源：`embeddingRowsRead`（物化行数）≠ `embeddingCalls`（调用次数）⇒ ⇒ 1c-bench 需要一个**可判定的比较对象** ⇒ ⇒ **新增 `embeddingExactRows`（= `scoreOf` 返回行数）** | ⇒ **旧键一个都没删、没改名**（只是**多了一项**）⇒ ⇒ ✅ **口径侧已闭环（本项不再是悬项）**：**architect 已补** —— `docs/design/perf-c2-t06-byte-metering.md:329` 的落盘清单改成【**13 项**】并把 `embeddingExactRows` 写进清单；`:189` / `:363` 补了「**第 13 项 = 使清单达到 13 项的那一项、⚠️ 在 §4 的 JSON 清单里排第 5 位**」的措辞 ⇒ ⇒ **本文件原先那句「待 architect 补成 13 项」已撤销** ⇒ ⇒ 断言侧已同步（落盘结构用例把它**写进期望数组** ⇒ 否则 `arrayContaining` 会让它**悄悄消失而不被发现**） |
| ⑩ | ⚠️ ★ **ADR §8.6 那个「4.44 MB」是【偏高的估计】、不是【下界】** ⇒ ⇒ **实测低于它属预期、不是回归**（写路径 2026-11-05 实测 4,065,792 B ⇒ 低于它 8~13%） | ADR §8.6 那张表按「码 768 B/行 + **每轮 64 次精确重排 × 3,072 B**」估算 ⇒ ⇒ **它高估了「精确分」那一半**：实测**精确分只读了 2 行**（`embeddingBytes.max` = 6,144 B）⇒ ⇒ 而**码行那一半是准的**（`codeBytes.max` = 4,059,648 B = 5,286 × 768 ✅）⇒ ⇒ ⇒ **实测 4,065,792 B 低于那个估计 8~13%** ⇒ ⇒ **那是【估计偏高】，不是【回归】** | ⇒ ⇒ **口径更严**（实测 ≤ 估算 ⇒ 不是回归）⇒ ⇒ 已写进**写路径 note 的 ②**（逐字写明「**具体差在哪**」）⇒ ⇒ 读 JSON 的人不会把「实测低于它」误读成回归 |
| ⑪ | ⚠️ ★★★ **读路径的 `samplesAligned` 原实现是【恒真的】**（架构师挖出来的真问题） | 原实现 = `readByteSamples.length === vectorRouteSamples.length` ⇒ 两个 `push` 在**同一个循环体内、无条件、无 `continue` / `break`** ⇒ ⇒ **长度必然相等** ⇒ ⇒ **恒为 `true`** ⇒ ⇒ 挂在 `checkPerf()` 的判红守卫上却**永远打不红** ⇒ ⇒ 原注释里那句「仍有牙」**是错的**（已删） | ⇒ ⇒ **按【裁决 8 ①】换成真正有牙的对账量**（**实测桶成员行 == 推算桶成员行**）⇒ ⇒ **字段名 / 类型 / 落盘结构一律不动**（只换「怎么算」）⇒ ⇒ **逐样本实测 20/20 相等**（§11.5.1）⇒ ⇒ **负控测试已补**（**正控 + 4 种负控**：不等 / 长度不等 / `null` / 空数组 ⇒ **全部按预期返回** ⇒ **证明它能被打红**）⇒ ⇒ ⚠️ **「同一件事在同一个文件里说四遍、其中一遍是错的」是最容易被下一个人踩的坑** ⇒ ⇒ **四处（`:410` / `:1413` / `:1498` / `:1736`）已逐字改成同一口径** |
| ⑫ | ✅ **已裁决通过（不再是悬着的风险）**：`readSamplesAlignedOf()` **导出** | **主理人裁决 ①**：★ **负控必须能单独喂数据** ⇒ 仓库纪律是「**守卫必须能被打红**」⇒ ⇒ 一个**没法被单独喂数**的纯函数 ⇒ 它的负控测试**只能靠间接路径** ⇒ ⇒ 而本轮**已经栽过一次「恒真守卫」** ⇒ ⇒ **导出是这条纪律的技术前提**，不是「为了测试而暴露实现」的坏味道。⚠️ 且**不扩大公开面**：`bench/perf.ts` 的 `export` 是**模块内导出**（bench 不是对外 API）⇒ `check:contract-ids` / `check:payload-keys` **管不到它** ⇒ ⇒ **零风险** | ⇒ ⇒ **负控测试（正控 + 4 种负控）已落**（`tests/bench/t06-byte-metering.test.ts:872`）⇒ ⇒ **照旧实现** |
| ⑬ | ✅ **已裁决通过（不再是悬着的风险）**：`VectorByteSample.bucketMemberRowsDerived` 作为**样本层**字段（**不落盘**） | **主理人裁决 ②**：★ **落盘结构零变化**（落盘 JSON 里**没有**这个键 —— 它只活在 `VectorByteSample` 这个 **TS 类型**里，而 `VectorByteSample` **本身不落盘**）⇒ ⇒ ADR §8.5 的「旧键零删除、只新增」**完全不受影响**。★ 且**把两个数放进同一个对象配对**，比「两个平行数组按下标对齐」**更不容易错位** ⇒ ⇒ 改成「不落盘的对账数组」是**退回旧形状** ⇒ ⇒ **不改** | ⇒ ⇒ **机器比对仍是「DELETED 集合为空」**（§16 ⑥）⇒ ⇒ **照旧实现** |
| ⑭ | ✅ **已补（QA 独立验证时提的 P1 · 覆盖缺口 · 不是实现 bug）**：① §2 断言 2 的**第二半**（每个登记形状的行数之和 == 对应读数）原先**只有 `unclassifiedRows === 0` 那一半在守** | QA 实测：`grep -rn "shapeRows" tests/` **零命中** ⇒ ⇒ `shapeRows` 实现了、也落进了快照，却**没有任何测试读它** ⇒ ⇒ 「**分类没漏、没多算**」这条**只剩一半有牙** ⇒ ⇒ 「漏认领一个形状」这种变异**打不红** | ⇒ ⇒ **已补三层守卫**（`tests/bench/t06-byte-metering.test.ts`）：① **逐形状判定**（`shapeRowsAgree()` ⇒ 纯函数 ⇒ 可被单独喂数）；② **逐形状点名**（`Q1` / `Q2` / `Q4` / `scoreOf` **各判各的** ⇒ 不许只判「全绿」）；③ ★ **负控**（**变异 ② 连读数一起改** ⇒ 「只钉总和」的写法会**照样绿** ⇒ 逐形状判定**必须打红** ⇒ ⇒ **证明它不是恒绿守卫**）⇒ ⇒ **QA 实测该不变式在真库上成立**（`shapeRows = {Q1:780, Q2:780, scoreOf:20, Q4:20}` ⇒ 四类来源行数之和逐位等于对应读数）⇒ ⇒ **不是实现 bug，是覆盖缺口** ⇒ ⇒ **已闭环** |
| ⑮ | ✅ **已补（QA 登记 1 的建议）**：**「注释说谎」的机器守卫** | QA 指出：「**同一个坑这一轮又踩了一次** —— `bench/perf.ts` 里同一件事说多遍、其中一遍是错的」⇒ ⇒ 光靠人读注释**不可靠**（代码有类型、有测试；**注释什么都没有**）⇒ ⇒ 「**凡提到那条已废口径的地方，必须同时否定它**」必须**钉成机器规则** | ⇒ ⇒ **已加一条机器守卫**（`tests/bench/t06-byte-metering.test.ts`）：扫描 `bench/perf.ts` 的源码文本 ⇒ 凡是出现 `字节样本数 == 计时样本数` 的行，其 **±3 行窗口**里必须出现**否定标记**（`不是` / `恒真` / `已废` / `换掉` / `原先` / `为什么不能`）⇒ ⇒ **提到却没否定 = 说谎 ⇒ 打红**（返回说谎行号数组 ⇒ 失败信息直接给行号）⇒ ⇒ ⚠️ **只钉有前科的那一条**（不做泛化扫描：泛化既做不到也查不准）⇒ ⇒ ★ **守卫自己也有负控**（喂「提到却没否定」的文本 ⇒ 必被抓；喂「提到并否定」的文本 ⇒ 必不被抓 ⇒ ⇒ **证明它不是恒绿守卫、且不误报**） |

## 16. 全局一致性自检

| 检查项 | 结论 |
|---|---|
| ① 与权威版口径冲突？ | ✅ **无冲突**（形状 id = `bucketCandidate` ✓ · 登记表 7 条 ✓ · 聚合豁免 ✓ · 无条件 `calls` ✓ · 四读数用 ADR §8.5 原名 ✓ · **裁决 8 ① 已落地**：读路径 `samplesAligned` 换成有牙的对账量 ⇒ 见 §11.5）⇒ ★ ****① §2** :188 的字面形式已按【裁决 8 ②】改成 `embeddingCalls ≥ embeddingExactRows`**（`docs/design/perf-c2-t06-byte-metering.md:188`）⇒ ⇒ **措辞核对 = 逐字一致**（`embeddingExactRows` = 「`scoreOf` 返回了行的次数」＝ `embeddingCalls` 减去「白调用」）⇒ ⇒ **本实现的判定对象与口径一致**（见 §15 ②）；✅ **口径侧已全部闭环 ⇒ 零处待回请**（**architect 已把 ① §4 的落盘清单补成【13 项】** ⇒ `docs/design/perf-c2-t06-byte-metering.md:329` ⇒ ⇒ **本文件原先记的「待 architect 补成 13 项」那一处已撤销** ⇒ 见 §15 ⑨） |
| ② 遗留 TODO / 调试代码 / `console.log`？ | ✅ 无（临时脚本已删；上一轮那段**临时诊断打印**（`T06_DIAG`）**采样完已删** ⇒ `grep -rn "T06_DIAG" bench/ tests/` = **0 命中**；⚠️ **本轮的采样改用「另写一个只读脚本」**（`.tmp/bench/read-align-diag.ts` ⇒ **gitignored** ⇒ **仓库源码一个字没动** ⇒ ⇒ **零「改文件瞬间」窗口** ⇒ ⇒ **不会撞出假红的 verify**）；`bench/**` 里只有 `main()` 的 stdout 打印 ⇒ 那是**产物**，不是调试残留） |
| ③ 注释里的「为什么」说清？ | ✅ 说清了（尤其：为什么读路径单轮 / 写路径两轮、`calls` 为什么无条件、载荷字节为什么只记一次、为什么 `bucketCandidate` 只做防御、为什么标量列 = 0 字节）⇒ ⚠️ **原先那句【说谎】的注释已删**（「仍有牙：漏采一个样本就红」⇒ **恒真 ⇒ 说谎**）⇒ ⇒ 换成**裁决落地 #1 的三条理由**（原文照抄进代码注释与读路径 note 的 ⑧）；★ **并且已加一条「机器守卫」**（QA 登记 1 的建议 ⇒ §15 ⑮）⇒ ⇒ **「注释说谎」从此不再是靠人记得去读**：凡是提到那条已废口径的地方，**必须同时否定它** ⇒ ⇒ 违反即打红（守卫自己带负控 ⇒ 不是恒绿） |
| ④ 计时口径未被破坏？ | ✅ **读路径**：逐字回到 HEAD（装计数器 + 计数 + 计时）⇒ **口径同源**（代价 = 逐行字节计算的微小开销 < 1% ⇒ 已如实写进 note）；✅ **写路径**：两轮制 ⇒ 轮 A **不装**计数器 ⇒ **与历史基线逐位可比**；⚠️ ⚠️ **读路径的「对账量」变了**（**不是计时口径变了**）⇒ ⇒ **计时窗口一个字没动**（仍是 `route()` 之后、`search()` 前后那两行） |
| ⑤ 既有测试仍全绿？ | ✅ 全绿（`pnpm test` **97 文件 / 1959 用例**全过 · exit 0；三个目标文件 **3 文件 / 79 用例**全过）⇒ ⇒ **1959 = 1957 + 本轮新增 2 条**（① 形状逐判定的**负控** —— QA 的 P1 ⇒ §15 ⑭；② **「注释说谎」的机器守卫** ⇒ §15 ⑮）⇒ ⇒ ⚠️ **这两条都各自带负控** ⇒ ⇒ **不是恒绿守卫** |
| ⑥ 旧落盘键一个都没动？ | ✅ **零删除、只新增**（**机器比对**：`HEAD` vs 当前，三个结构的键名集合做 `comm` 差集 ⇒ **DELETED 集合为空**）—— `THRESHOLDS`：DELETED **空** / ADDED = `bytesReadMax` / `bytesReadRatioMax` / `pruneRateMax`；`WriteSegmentSummary`：DELETED **空** / ADDED = `vectorByteReads`；`PerfResult`：DELETED **空** / ADDED = `vectorRouteByteReads`；`GateRegrouping`：DELETED **空** / ADDED **空**（**逐字未动**）；⚠️ `candidateReadRowsMax` / `candidateReadRowsRatioMax` **两个常量按要求保留不删**；⚠️ **本轮新增的 `VectorByteSample.bucketMemberRowsDerived` 是【样本层】字段，不是落盘键** ⇒ ⇒ **落盘结构零变化**（`samplesAligned` 的**名字 / 类型 / 位置**都没动，只换了「怎么算」） |
| ⑦ `Params` 仍 60 项？ | ✅（`pnpm run check:params` 绿；本轮**没碰** `src/core/params.ts`） |
| ⑧ **`src/**` 零改动？**（★ 断言 4） | ✅ **`git diff --stat src/` 为空**（连注释都没动） |

**IS_PASS: YES（第二段 · 裁决落地 #1 + QA 的 P1 闭环 + 「注释说谎」机器守卫）**
