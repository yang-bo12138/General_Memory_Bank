# P2 全量验收报告（T01~T08）

> 验收人：software-qa-engineer-2｜仓库：`D:/Git/repo`（main, HEAD=`4c70582`）
> 变异 worktree：`D:/Git/wt/p2-t01`（分支 `feat/p2-t03`，内容与 `4c70582` **逐字节同树**）
> ⚠️ 本报告**只验收，不改生产代码**；主工作树全程 `git status --porcelain` 为空。
> ⚠️ 配套文件：`p2-mutation.md`（变异记录）、`p2-adjudication.md`（⑤⑥ 独立结论）。

---

# 0. 结论

| 项 | 结论 |
|---|---|
| **总判定** | **`PASS_WITH_ISSUES`** |
| **智能路由判定** | **`Engineer`**（**最终判定**）—— Q-01（唯一的**测试代码**缺陷）**已由 QA 修复并提交（`720deec`），并经并行 QA 独立复验** ⇒ **无遗留的 QA 侧缺陷**；但仍有**待实现的验收项缺口**（Q-02）与**待优化的生产代码**（Q-06）⇒ 剩余可执行项落在**工程师**。另有 Q-05/Q-07/Q-08/Q-12 需**架构师**裁决。 |
| 门禁 | ✅ `pnpm run verify` **退出码 0**（41 files / 809 tests 全过）｜✅ `pnpm run build` **退出码 0** |
| 变异测试 | 6 条变异，**5 条断言有牙**，1 条存活（Q-01） |
| 待裁决 | ⑤⑥ 四个小节的独立结论见 `p2-adjudication.md` |

**为什么不是 `PASS`**：① T08 的**硬断言「规模写进验收行」在实现里没有对应物**（Q-02）；
② 有一条**本该抓住「集合相等」缺陷的断言是假阴性**（Q-01）；
③ **落盘的 1M 性能基线本身不达标**（recall P99 678ms / 写入 P99 658ms）⇒ **P2 不能声称「性能门槛已达标」**（Q-03）。

**为什么不是 `FAIL`**：① 门禁全绿、809 条断言全过；
② 43 条设计硬断言里 **40 条有真实断言且经变异验证有牙**；
③ 唯一的**测试代码**缺陷（Q-01）**生产实现是对的**，且缺陷范围已精确定位、可一行修复；
④ ⑤⑥ 的问题**全部是「文档冲突 / 数据口径 / 设计缺口」**，不是代码 Bug ⇒ **不该由工程师背**。

---

# 1. 门禁基线

## 1.1 `pnpm run verify`（main, HEAD=`4c70582`）

| 步骤 | 退出码 | 结果 |
|---|---|---|
| `typecheck`（`tsc --noEmit`） | 0 | ✅ |
| `lint`（`biome check .`） | 0 | ✅ |
| `test`（`vitest run`） | 0 | ✅ **41 test files / 809 tests 全过**（Duration 22.10s） |
| `check:params` | 0 | ✅ |
| `check:payload-keys` | 0 | ✅ |
| `check:clock` | 0 | ✅ |
| `check:anchor` | 0 | ✅ |
| `check:bucket-write` | 0 | ✅（白名单 `vector/bucketAssign.ts`，扫到裸写 3 处） |
| `check:contract-ids` | 0 | ✅ |
| `check:doc-counts` | 0 | ✅（§5 参数 60 项一致） |
| `check:clamp` | 0 | ✅ |
| **总退出码** | **0** | ✅ **PASS** |

**测试文件构成**：41 = `tests/` 下 38 + `src/` 下 3（`src/core/flags.test.ts`、`src/core/params.test.ts`、`src/store/params.test.ts`）。
vitest `include` = `['tests/**/*.test.ts', 'src/**/*.test.ts']`
⇒ 仓库根 `.tmp/**` 下的 **35 个**历史 QA 残留 `.test.ts` **不会**被误收进测试集（已核实）。

## 1.2 `pnpm run build`

```
$ pnpm run build     # tsup
CJS dist\index.cjs     224.74 KB   ✅ Build success in 162ms
ESM dist\index.js      219.56 KB   ✅ Build success in 161ms
DTS dist\index.d.ts    103.71 KB   ✅ Build success in 5588ms
EXIT_CODE=0
```

---

# 2. 逐任务核对表（设计 ↔ 实现 ↔ 测试 三方一致）

> 「已断言条数」= 在 `tests/` 里**真的能失败**的对应断言数（**不是**「有测试文件」）。

| 任务 | 设计硬断言条数 | 已断言 | 缺失 / 欠账 | 结论 |
|---|---|---|---|---|
| **P2-T01** | 6 | **6** | 0 | ✅ **PASS**（M5 变异验证 4 个文件同时变红） |
| **P2-T02** | 6 | **5.5** | 0.5：「库长大了 ⇒ 自动触发」按 `DESIGN-v2.md:3475` 划归**宿主责任**；库侧能力（`rebuildVectorBuckets` / `rebuildVectorBucketsOnce` / `mode==='absent'` 检测信号）**都有且已断言** | ✅ **PASS**（设计已划界，不算缺失） |
| **P2-T03** | 8 | **7** | ① 集合相等的**一条断言是假阴性**（Q-01）<br>② 「先对账后开路」的**关窗闸门** ⏸️ 阶段 4（`recall()` 向量路整路缺席）⇒ **欠一条 TODO 锚点**（Q-05） | ⚠️ **PASS_WITH_ISSUES** |
| **P2-T04** | 4 | **4** | 0 | ✅ **PASS**（M6 实测绕过 ⇒ 门禁红、退出码 1、定位到行） |
| **P2-T05** | 8 | **8** | 0 | ✅ **PASS**（M1/M4 变异各红 9 / 3 条） |
| **P2-T06** | 7 | **7** | 0 | ✅ **PASS**（但「集合相等」那条被 M3 揭穿是假阴性 ⇒ 见 Q-01） |
| **P2-T07** | 5 | **5** | 0 | ✅ **PASS**（M2 变异精确命中 3 条；EXPLAIN 断言**确实跑在生产 SQL 上**） |
| **P2-T08** | 8 | **4** | ① 「文本路不受影响」**缺**<br>② 「三路准入闸门一视同仁」**缺**<br>③ 「软删记忆不被向量路召回」**缺**<br>④ 「规模写进验收行」**部分**（默认 100 万 ✅，「断言规模达标」❌）<br>⑤ 「mode 四值互斥」**仅纯函数层**，无真实库路径 | ⚠️ **PASS_WITH_ISSUES** |
| **合计** | **52** | **46.5** | **5.5 条缺失/欠账** | ⚠️ |

### 2.1 逐条硬断言明细

**P2-T01（6/6）** — `tests/unit/vector-backend.test.ts`
`init` 幂等(:186)｜`score ∈ [0,1]`(:227)｜不足 k 返回实际条数(:247)｜`VectorFilter` 无 id 白名单(:272 `@ts-expect-error`)｜flat vs 手写全表点积逐位一致(:302)｜score 是原始余弦不重标定(:329,:341)

**P2-T02（5.5/6）** — `tests/unit/ivf.test.ts` / `kmeans.test.ts`
确定性(:164,:34)｜细桶必属粗桶 + `foreign_key_check` 空(:195,:214)｜`COUNT==COUNT(DISTINCT)`(:222)｜路由桶数 C32(:251,:274)｜桶内全量精确点积(:291)｜训练三时机(见上表)

**P2-T03（7/8）** — `tests/unit/bucketAssign.test.ts` / `bucketSync.test.ts` + `scripts/check-anchor.ts` / `scripts/check-bucket-write.ts`
回滚(:179)｜换桶不残留(:222)｜四路径锚定(check-anchor)｜静态断言 + 负控(:526,:540,:561)｜合并未传向量 ⇒ unassign(bucketSync:213)｜`updateContent` ⏸️阶段4（TODO 锚点 bucketSync:273）｜★集合相等(实现✅，但 Q-01)｜★先对账后开路(时点✅，闸门⏸️阶段4)

**P2-T04（4/4）** — `scripts/check-anchor.ts` / `scripts/check-bucket-write.ts`
裸写 ⇒ lint 失败(bucketAssign:540 + M6 实测)｜删管辖路径 ⇒ anchor 失败｜锚定表 3 列｜管辖路径条数写死

**P2-T05（8/8）** — `tests/integration/rebuildBuckets.test.ts`
删除顺序(:225)｜崩溃恢复(:320)｜空旧桶清理(:268,:287)｜同事务性(:469)｜幂等(:307)｜重训事件(:367)｜`inRetrain`(:391)｜只重训一次 + 告警放行(:405,:424)

**P2-T06（7/7）** — `tests/integration/reconcile.test.ts`
缺失补齐(:172)｜脏行清理(:192)｜软删保留(:210)｜真孤儿删除(:232)｜重复检出(:246)｜三判据分别报告(:268)｜P95 与手算一致(:322)

**P2-T07（5/5）** — `tests/unit/dedupCandidates.test.ts`
候选 ≤2000(:227,:242,:259)｜不做全表扫 EXPLAIN(:295)｜不加时间窗(:336,:363,:407)｜同一合并路径(:427,:470)｜C29 分母纪律(:523,:549,:584)

**P2-T08（4/8）** — `tests/unit/ivf.test.ts` / `tests/bench/bench-smoke.test.ts` / `src/core/flags.test.ts` / `tests/unit/scoring.test.ts`
桶内精确性(ivf:291 + smoke:168)｜medianBm25 逐位不变(scoring:355,:372)｜`mode` 四值(flags.test.ts,**纯函数**)｜`inRetrain` 作用域(flags.test.ts:162-165)｜❌ 文本路不受影响｜❌ 三路准入闸门｜❌ 软删不被向量路召回｜⚠️ 规模（默认✅ / 断言❌）

---

# 3. 重点攻击面核查（逐条）

## 3.1 P2-T03 桶归属唯一写入点 ✅ **通过**

- **静态核实**：`src/**` 里写 `vector_cell_members` 的地方**只有** `src/vector/bucketAssign.ts`
  （`grep -rn "INSERT|UPDATE|DELETE FROM vector_cell_members" src/` ⇒ 3 处命中，全在 `bucketAssign.ts`）。
- **门禁能拦住绕过吗？** ⇒ **能**。**QA 真的绕了一次**（M6）：往 `src/store/write.ts` 注入一行裸
  `INSERT INTO vector_cell_members …` ⇒ `pnpm run check:bucket-write` **退出码 1**，
  报错精确到 `store/write.ts:1008`，并明确指出「唯一合法的写入点是 vector/bucketAssign.ts」。
  ⇒ **白名单是写死的常量**（`ALLOWED_BUCKET_WRITE_FILES = ['vector/bucketAssign.ts']`，C31 合规），
  且门禁**自带「命中数 > 0」与「白名单里的文件真的被扫到」两条反真空守卫**。
- **扫描器剥注释正确**：M6 变异里那行**注释**含 `INSERT INTO vector_cell_members` 字样，
  **没有**造成误报 ⇒ 命中的是代码行而非注释行。

## 3.2 P2-T05 重训 ✅ **通过**

| 攻击点 | 结论 | 证据 |
|---|---|---|
| 三步硬约束顺序 | ✅ | 源码 `rebuild.ts:193/202/239`（①建桶→②迁成员→③删旧桶）；**M4 变异（把③提前）⇒ 红 3 条** |
| 崩溃可恢复 | ✅ | `rebuildBuckets.test.ts:320`；M1/M4 变异均让它红 |
| 旧代桶清理**只清当前代** | ✅ | 判据 = 「该 fine_id/coarse_id **不在新模型里**」（`rebuild.ts:243-262`）⇒ **不误删新代桶**（新代桶哪怕成员数为 0 也不删，否则写入路径撞外键崩）。测试：`:268` 空旧桶清理、`:287` 形状变化后残留清理 |
| 重训闸门（只重训一次）可被绕过吗 | ❌ **绕不过** | `MemoryMaintainer.rebuildVectorBucketsOnce()`（`maintain.ts:253`）+ `degraded` 标记；测试 `:405`「重训后仍不达标 ⇒ 只重训一次 + 记告警放行（不抛错、不循环）」、`:424`「质量达标 ⇒ 不重训」 |

## 3.3 P2-T06 启动对账 ✅ **通过（但断言层有 Q-01）**

- **三条判据都真的实现了**（不是 TODO/stub）：`src/vector/bucketAssign.ts` 的 `diffBucketMembership()`
  返回 **missing / orphans / vectorless / duplicates / softDeleted** 五类 + `liveCount` / `bucketCount`；
  `src/vector/reconcile.ts` 的 `reconcileBuckets()` 消费它并分别报告。
- **桶侧用 LEFT JOIN** ✅（`bucketAssign.ts:297-299`）⇒ 不丢硬删真孤儿。
- **三分支处置** ✅（孤儿删 / 软删跳过 / 无向量删，`bucketAssign.ts:469-484`）。
- **「先对账后开路」的时点** ✅（`tests/integration/reconcile.test.ts:441` 在 reconcile 之后断言集合相等）。
- ⚠️ **关窗闸门本身 ⏸️ 阶段 4**（`recall()` 的向量路整路缺席 ⇒ 无门可关）⇒ **但没有任何 TODO 锚点承载它** ⇒ **Q-05**。

## 3.4 P2-T07 候选收窄 ✅ **通过**

| 攻击点 | 结论 | 证据 |
|---|---|---|
| 候选 ≤ 2000 的口径 | ✅ | 断言的是**被扫描的候选行数**（`scan.scanned`），不是 top-N；上界 = 探针数 × **最大桶成员数**（结构上界，:259） |
| EXPLAIN 断言是否跑在**生产代码真正执行的 SQL** 上 | ✅ **是** | `buildBucketCandidateSql()` 是 `src/vector/ivf.ts:419` 的**生产导出**，`scanBucketCandidates()` 在 `ivf.ts:477` 用 `db.prepare(buildBucketCandidateSql(fineIds)).all(...)` 执行 ⇒ **同一条 SQL**。测试 `:305-307` 的注释明写「用生产代码真正执行的那条 SQL」 |
| EXPLAIN 断言分得清两者吗 | ✅ | **负控** `:322`：全表扫那条 SQL 的计划里**有 SCAN** |
| 有没有时间窗 | ✅ **没有** | 生产 SQL 里无任何时间窗条件；测试有**静态断言**(:407，regex 查 `last_access` 比较) + **行为断言**(:336 半年前访问过的、:363 半年前写入并被合并的)；**M2 变异 ⇒ 精确红 3 条** |
| 向量路与文本路是否走**同一合并路径** | ✅ | 两条路的 `merge` 事件 **payload 键集完全一致**（`:470`）；生产侧两者都进 `src/store/write.ts:1050` 的同一个 `mergeMemory(...)` 调用 |
| C29 分母纪律 | ✅ | `:523` 分母是 flat 的**候选全集**；`:549` **负控**（换成 top-N ⇒ 子集关系不成立 ⇒ 纪律有牙）；`:584` 说明「取子集后再取 top-K」不保序 |

## 3.5 P2-T08 性能基线 ⚠️ **有问题（见 Q-02 / Q-03）**

| 攻击点 | 结论 |
|---|---|
| 实测数据是否可复现 | ✅ 种子**记录并参与比对**：`bench/lib/db.ts:261` `manifest.corpusSize !== corpus.size \|\| manifest.seed !== corpus.seed` ⇒ **复用库时连种子一起比**（21cba6a 修的那条，QA 复核确认已落地）；`benchNow` 与 `machine` 落进 JSON |
| 门槛判定是否真按文档阈值做 | ✅ 阈值**逐条写死**：`bench/perf.ts:63-66` `recallP99Ms:200 / writeP99Ms:5 / vectorRouteP99Ms:20 / vectorRouteShare:0.2` |
| 库复用时是否连种子一起比 | ✅ **是** |
| ⚠️ **落盘数据的 P99 在统计上无意义** | ❌ `bench/lib/harness.ts:139-147` 的 `percentile()` 是 nearest-rank：`rank = ceil(0.99 × n)` ⇒ **n < 100 时 P99 == max**（精确边界，实测 n=1/5/10/20/50 ⇒ P99==max；n=100 ⇒ 第 99 个）。实测：`perf-10000.json` 的 write 样本 **50**、`perf-1000000.json` 的 recall 样本 **10** / write 样本 **50** ⇒ **两份基线的「P99」都是「最大值」** ⇒ **Q-03** |
| ⚠️ **规模硬断言缺失** | ❌ **没有**任何「规模 ≥ 100 万 ⇒ 失败」的语句 ⇒ **Q-02**（实测 `--scale=1500` 跑完落盘、退出码 0） |

## 3.6 导出面 ✅ **通过**

- **P2 的向量层能力没有泄漏到公开导出面** ✅
  - `tests/contracts/export-surface.test.ts:73` 断言导出面**没有任何** `src/vector/**` 的东西；
    `ALLOWED_VECTOR_EXPORTS = []`（**写死的空集**）。
  - 负控 `:97`：注入一个 `src/vector/` 的导出 ⇒ 断言必须红。
  - 类集合用**运行时判定**（`Function.prototype.toString().startsWith('class ')`）⇒ 不靠「首字母大写」猜。
- **`MemoryMaintainer` 的值导出让宿主调得到启动对账** ✅
  - `src/index.ts` 里是 `export { MemoryMaintainer } from './store/maintain.js';`（**值导出**，不是 type-only）
    ⇒ 宿主可以 `new MemoryMaintainer(...)` 或从实例拿到它；
  - `MemoryMaintainer.reconcileBuckets()`（`maintain.ts:311`）是**公开方法** ⇒ **启动对账可达** ✅
  - `src/index.ts:170-176` 的注释明确：这是**P2-QA 第二轮的修复**（此前是 type-only ⇒ 宿主根本调不到），
    且「**不新增 `MemoryStore` 的公开方法**」。

---

# 4. 问题清单

| # | 严重级 | 文件:行 | 问题 | 失败断言原文 / 证据 | 复现命令 |
|---|---|---|---|---|---|
| **Q-01** | **Major** | `tests/unit/bucketSync.test.ts:383` | **「集合相等 ≠ 条数相等」这条断言是假阴性**：它**没有真的构造出「条数相同」的场景**。夹具 `createTrainedBucketContext()`（`tests/fixtures/bucket-store.ts:61-66`）落了 **40 条带向量、不入桶**的种子记忆 ⇒ 该场景下 **liveCount=41 / bucketCount=1**，**两侧条数根本不相等** ⇒ 测试注释「性质：条数确实相同」只核对了**桶侧**，**从未核对库侧**。⇒ 把实现改成「先比条数、条数一样就认为一致」的变异**存活**（真·条数相同时 `missing=[]`、`isConsistent=true` ⇒ **静默漏召**）。<br>✅ **已由 QA 修复并提交（`720deec`，测试代码，生产代码未动）**：清掉种子记忆 + **补上库侧核对** ⇒ 修复后该变异**必定变红**（实测 `AssertionError: expected [] to include '<id>'`）。 | 变异存活（只红 1 条，应 ≥3）。探针实测（真·条数相同）：<br>`liveCount=1 bucketCount=1 → diff.missing.length=0 → isConsistent=true`（变异版）<br>原版：`diff.missing.length=1 → isConsistent=false`<br>**修复后重测**：变异版 ⇒ 该测试**变红** ✅ | `cd D:/Git/wt/p2-t01 && pnpm exec vitest run tests/unit/bucketSync.test.ts`（配 M3 变异）<br>探针：见 `p2-mutation.md` M3 |
| **Q-02** | **Major** | `bench/perf.ts:328` / `bench/agreement.ts:392` / `bench/baseline-flat.ts:152` | **硬断言「规模写进验收行」只做了一半**：默认 `--scale` **确实是 1 000 000**（`bench/corpus.ts:32`）✅，但**没有任何一处断言「规模 ≥ 100 万」** ⇒ 规模只被打印 / 写进 JSON / 用作文件名。**小库上测 P99 照样放行**。 | 实测：`pnpm exec tsx bench/perf.ts --scale=1500 --queries=20 --writes=20` ⇒ 跑完、落盘 `perf-1500.json`、**EXIT_CODE=0**，无任何规模告警 | `cd D:/Git/repo && pnpm exec tsx bench/perf.ts --scale=1500 --queries=20 --writes=20 --out=/tmp/x.json` |
| **Q-03** | **Major** | `docs/baseline/perf-1000000.json` / `docs/baseline/perf-10000.json` / `bench/lib/harness.ts:139-147` | ① **1M 基线不达标，而且这不是统计假象**：`perf-1000000.json` 的 `failures` = `recall P99 678.119ms > 200ms` + `写入 P99 658.189ms > 5ms`；**关键是中位数就已经超标** —— recall `p50 = 267.83ms > 200ms`、写入 `p50 = 108.37ms > 5ms` ⇒ **真实的规模效应**（与 `software-qa-engineer` 独立重算一致）。⚠️ **我对自己上一版口径的更正**：我原先把「P99 在 n<100 时 == max」（当时我写的边界偏窄，是 n≤50）当成削弱该数字的理由，**这个框架不准确** —— 统计口径确实有缺陷（见②），但**它救不了这个结论**：连 p50 都超标。<br>② **但「P99」这个统计口径本身仍有缺陷**（独立问题）：`percentile()` 是 nearest-rank，`rank = ceil(0.99 × n)` ⇒ **n < 100 时 P99 == max**（实测：n=1/5/10/20/50 ⇒ **P99 == max**；n=100 ⇒ 第 99 个；n=200 ⇒ 第 198 个；n=500 ⇒ 第 495 个）。⇒ 落盘的两份基线 recall 只有 **10** 个样本、写入 **50** 个 ⇒ **两份的「P99」在统计上都是「最大值」** ⇒ 报出来的数字**不可当作 P99 解读**。<br>⚠️ **精确化更正**（并行 QA 提示我自查）：我上一版写的边界是「n ≤ 50」，**偏窄** ⇒ 精确边界是 **n < 100**（n=100 时已取到第 99 个，不再是 max）。**这不改变结论**（两份基线用的 n=10 / n=50 都在 n<100 区间内）。<br>③ **10k 那份的 233.64ms 是单个离群样本**（p99=max=离群值；firstWrite 4.58ms 正常；p50 仅 4.49ms）⇒ **不能据此判定「写入路径不达标」**（见 ⑥④）。 | `perf-1000000.json`：`"recallP99Ms": 678.1187`、`"writeP99Ms": 658.1894`、`"failures": ["recall P99 678.119ms > 200ms…","写入 P99 658.189ms > 5ms…"]`、`recallLatency.p50 = 267.83`、`writeLatency.p50 = 108.37`、`recallLatency.count = 10` | `cat docs/baseline/perf-1000000.json` |
| **Q-04** | **Major** | `docs/baseline/README.md:18,20` | README 的文件索引列了 `agreement-1000000.json` 与 `baseline-flat-1000000.json`，**这两个文件在磁盘上不存在** ⇒ README 自我定位是「**数字的出处**」，却指向不存在的数字。 | `for f in agreement-1000000.json baseline-flat-1000000.json; do [ -f docs/baseline/$f ] \|\| echo "MISSING $f"; done` ⇒ 两行 MISSING | `ls docs/baseline/` |
| **Q-05** | **Major** | `src/core/flags.ts:174-181` | **「先对账、后开路」的关窗闸门在代码里没有任何形态、也没有 TODO 锚点**：`VectorBackendFacts` 里**没有 `hasReconciled` 这一项** ⇒ 「是否已对账」**无法表达** ⇒ 阶段 4 接向量路时这条义务会被悄悄遗忘。`src/` 里的 TODO 只有 2 条（`recall.ts:748` 候选去重收敛、`write.ts:973` updateContent），**都不承载它**。 | `grep -rn "TODO" src/` ⇒ 仅 2 条，均不含「对账/开路」；`grep -rn "hasReconciled" src/` ⇒ 0 命中 | `cd D:/Git/repo && grep -rn "hasReconciled\|先对账\|后开路" src/ tests/` |
| **Q-06** | **Major** | `src/vector/ivf.ts:102-118` | **训练峰值内存 8.47GB 是必要量的 2.4 倍**（`.all()` 一次性物化 100 万行 ≈3.3GB 与 `blobToVector` 的 3.07GB Float32Array **同时存活** ⇒ 峰值 ≈6.4GB + Node/SQLite）。设计把它写成「**≥ 3.5GB 的下限**（资源规划提醒）」⇒ **字面满足**，但**对 8GB 机器就是 OOM**，且**若 8.47GB 真是需求，则设计稿的 3.5GB 估算错了、必须回写**。另：`perf-1000000.json` 的 `phases.sampledPeakRssBytes: 0` 与 `rssBeforeTrainBytes: 0` ⇒ **「采样峰值」根本没采到数** ⇒ 这条软阈值**没有独立测量值**。 | `perf-1000000.json`：`"peakRssBytes": 8474386432`、`"sampledPeakRssBytes": 0` | `cd D:/Git/repo && pnpm exec tsx bench/perf.ts --scale=1000000 --db=.tmp/bench/shared-1000000.db --reuse=true`（数小时） |
| **Q-07** | **Major** | `DESIGN-v2.md:2161-2183` / `DEVELOPMENT-PLAN.md:116-127` | **§4.9 步骤 3a2 的「宿主调度层」对宿主不可实现**：设计要求宿主「携带原始文本，**走同一条 3c 路径**」，但 3c 是 `write()` 内部的合并分支；宿主用现有公开 API **无法表达「把它与这条合并」**（`write()` 会自己重收候选 ⇒ 复现同一个探针边界 ⇒ 走不通）。⇒ **设计缺口**，不是代码 Bug。⇒ 路由：**software-architect**（阶段 4 接向量路之前必须补）。 | `mergeMemory()` 不在 §6 的 23 方法里（§3.1 表：阶段 2 只有 `rebuildVectorBuckets`）；`grep -n "mergeMemory" src/index.ts` ⇒ 0 命中 | `cd D:/Git/repo && sed -n '116,127p' docs/design/DEVELOPMENT-PLAN.md` |
| **Q-08** | **Major** | `docs/design/DEVELOPMENT-PLAN.md:2035-2038` vs `:2072-2076` vs `:109`；`DESIGN-v2.md:5944-5947` / `:1260` / `:5033` | **性能门槛的软/硬类型，两份文档互相矛盾，且计划稿内部也自相矛盾**（2035-2038 标「硬门槛（不达标 = 架构不成立）」；2072-2076 与 109 标「软阈值」；DESIGN-v2 用「**验收门槛**」「**门槛**」措辞且未标软硬）⇒ 工程师选了「软」这一派 ⇒ **`checkPerf()` 不置 exitCode**。<br>⚠️ **裁决时必须知道的关键结构**（与 `software-qa-engineer` 独立重算一致）：**不达标的是「整体 recall」与「整体写入」，而「分桶自己引入的那两条」在 1M 规模上全部达标** —— 向量路 P99 = **13.35ms**（≤20 ✅）、向量路占比 = **2.17%**（≤20% ✅）；不达标的是 recall（p50 267.83ms / p99 678.12ms）与写入（p50 108.37ms / p99 658.19ms）。⇒ ⇒ **这不是「分桶没做到位」，而是「200ms / 5ms 这两条门槛是按『全库开销』定的，而分桶只解决了向量路那部分」** ⇒ **架构师要裁决的真正问题是：「这两条门槛的口径是否包含 FTS5 索引维护 / 图谱路 / 去重等非向量开销？」**<br>⚠️ **新增强化证据（QA 实证）：代码里「软」的依据是一个**死引用** ⇒ 这不只是文档矛盾，是**行为问题**。`bench/perf.ts:283` 的注释写「⚠️ **这些是「软阈值」**（**§7.1 把它们列在软阈值栏**）」，而 `:394` 的**运行时输出**也写死「⇒ 这些是**软阈值**…⇒ 记录实测值，**不判失败**」<br>⇒ ⇒ **我核了两份文档的 §7.1**：`DESIGN-v2.md §7` 是「桌面查看器（Electron 只读观察器）」、§7.1 是「定位与安全」；`DEVELOPMENT-PLAN.md §7` 是「参数与契约清单」、§7.1 是「§5 的 60 项参数按阶段归位」⇒ ⇒ **两份文档的 §7.1 里都没有任何软阈值表**（实测 grep「软阈值\|P99\|200ms\|5ms」**零命中**）⇒ ⇒ **代码引用了一个不存在的依据** ⇒ 「不判失败」这个行为**在代码里没有可追溯的出处**⇒ ⇒ **所以问题不是「措辞不统一」，而是「判定逻辑只写在代码里、且它引用的裁决依据不存在」**⇒ ⇒ **要么按计划稿改成硬门槛（退出码非 0），要么计划稿改成参考线 —— 但先裁再改**（裁权在架构师）<br>⚠️ **附带确认**：**吻合率那条没问题** —— `bench/agreement.ts:66` 的 0.98 在设计稿里**本来就是软阈值** ⇒ 有争议的**只有 perf 的三条 P99 + 占比**这四条。 | `bench/perf.ts:389-396`：`if (failures.length > 0) { … return; }`（**无 `process.exitCode`**） | `cd D:/Git/repo && sed -n '2032,2038p;2072,2076p' docs/design/DEVELOPMENT-PLAN.md` |
| **Q-09** | **Minor** | `tests/contracts/export-surface.test.ts:82` | 用例标题写「**只有这 5 个类**」，而写死的期望值 `EXPECTED_EXPORTED_CLASSES`（:29-36）里有 **6** 个类（`EventWriter / FileLogger / MemoryError / MemoryLogger / MemoryMaintainer / MemoryStore`）。**断言本身正确**，只是标题与实现不符。 | `EXPECTED_EXPORTED_CLASSES` 长度 = 6 | `cd D:/Git/repo && sed -n '29,36p;82p' tests/contracts/export-surface.test.ts` |
| **Q-10** | **Minor** | `src/index.ts:1-48`（文件头） | 文件头说「阶段 1 **只导这 10 个**…⇒ **只导这 10 个**」，容易被读成「导出面只含阶段 1 的东西」；实际上导出面含 **P3 形状的类型**（`CoactPair` / `CoactSkipped`）。**已核实不构成「半承诺」**（全部 type-only、运行时被擦除、字段可选、coacts 未实现）⇒ 只是**措辞**问题。 | `grep -c "CoactPair\|CoactSkipped\|MergeEventPayload3c" dist/index.js` ⇒ **0**（已擦除） | `cd D:/Git/repo && grep -c "CoactPair" dist/index.js` |
| **Q-11** | **Minor** | 仓库根 `.tmp/` | `.tmp/` 下有 **35 个**历史 QA 残留 `*.test.ts`。vitest `include` 不含 `.tmp` ⇒ **不影响门禁**，但属仓库卫生问题。 | `find . -name "*.test.ts" -not -path "./node_modules/*" -not -path "./dist/*" \| grep "^\./\.tmp" \| wc -l` ⇒ 35 | `cd D:/Git/repo && find ./.tmp -name "*.test.ts" \| wc -l` |
| **Q-12** | **Major** | `docs/design/DECISIONS.md`（**不存在**）；`docs/design/adr-p1-*.md` | **裁决台账缺失**：本轮派单把 `docs/design/DECISIONS.md`（裁决台账）列为**权威文档**，但该文件**不存在**；`docs/design/` 下只有 4 份 `adr-p1-*`（**全是 P1 的**）⇒ **P2 的所有裁决（ADR-P1-C 裁决 7、ADR-26、P2-T03~T08 的裁决）都没有台账落点**。⇒ 而 Q-05 / Q-07 / Q-08 三条**正需要架构师裁决** ⇒ **裁决写在哪里都没有被指定** ⇒ 建议先指定落点（新建 `docs/design/DECISIONS.md` 或 `adr-p2-*.md`）。 | `ls docs/design/` ⇒ 4 份全是 `adr-p1-*`，无 `DECISIONS.md`；`grep -rn "DECISIONS.md" docs/` ⇒ 引用悬空 | `cd D:/Git/repo && ls docs/design/ && grep -rn "DECISIONS.md" docs/` |
| **Q-13** | **Major** | `docs/DELIVERY.md:15,19-24,28` | **交付文档断链 + 严重过时**：① 第 28 行「阶段 2 的进度与欠账见 `docs/progress/stage2-progress.md`」⇒ **该文件不存在**（`docs/progress/` 下只有 `stage0-stage1-progress.md` 与 `stage1-closing-snapshot.md`）⇒ **断链**；② 状态表自称「**截至 `95bd5e2`**」，而 main 已到 `4c70582`/`720deec`；③ 表里的数字全部过时：「测试 **37 文件 / 764 条**」⇒ 实际 **41 文件 / 809 条**；「源码 `src/` **43 个 `.ts`**」⇒ 实际 **46 个**；「阶段 2：T01~T05 已合并（T06~T08 在做）」⇒ **T01~T08 全部已合并**。⇒ ⇒ **主理人问的「阶段 2 进度文档」＝ 缺**（这一条应补写）。 | `ls docs/progress/` ⇒ 无 `stage2-progress.md`；`find src -name '*.ts' \| wc -l` ⇒ 46；`find tests -name '*.test.ts' \| wc -l` + 3 ⇒ 41 | `cd D:/Git/repo && ls docs/progress/ && grep -n "95bd5e2\|stage2-progress" docs/DELIVERY.md` |
| **Q-14** | Minor | `bench/lib/harness.ts:378-391` | `machine` 块里的 `freeMemoryBytes` / `usedMemoryBytes` 是**采集时刻的瞬时值**（源码注释自己写着「采集时刻的**可用**内存」）⇒ **同一台机器的两次运行必然不同** ⇒ ⇒ **`machine` 块不能当「机器指纹」用**（README:40「没有机器信息的 P99 不可复现」需要限定：**硬件标识**（cpuModel / cpuCount / totalMemoryBytes / node）才是身份，free/used 是当次运行的资源余量）。<br>⚠️ **更正一条并行 QA 的推断**：三份 1 万条 JSON 的 `machine` 块**并非「互不相同 ⇒ P99 互不可比」** —— 硬件字段**完全相同**（同一 CPU / 16 核 / 同 node / 同 `benchNow`），**只有 freeMemoryBytes 这个瞬时快照不同** ⇒ **P99 是可比的**。 | `perf-10000` free=4638208000 / `agreement-10000` free=5129768960 / `baseline-flat-10000` free=4690395136；**cpuModel / cpuCount / node / benchNow 三份完全一致** | `cd D:/Git/repo && for f in perf-10000 agreement-10000 baseline-flat-10000; do python -c "import json;d=json.load(open('docs/baseline/$f.json'));print('$f', d['machine']['cpuModel'].strip(), d['machine']['cpuCount'], d['machine']['node'], d['benchNow'])"; done` |
| **Q-15** | Minor | `src/vector/dot.ts:230-236`；`src/store/merge.ts:331`；`src/vector/bucketAssign.ts:147` | **「向量写入只允许经 `write.ts`」这条纪律目前只有注释、没有机器守卫**（与「桶归属只允许经 `assignBucket`」那条**有 lint 门禁**的纪律形成对比）。⚠️ **须先澄清三个既有事实**（否则容易误判成缺陷）：① **写入点守卫已存在** —— `tests/unit/merge.test.ts:624`「★ 改写 content / content_hash / embedding 的写入点**只在** store/merge.ts」⇒ **谁**能写 embedding 是守住的；② **口径守卫已存在** —— `tests/unit/write.test.ts:1516`「★ 写入路径的向量归一化口径（**唯一**守住『写入口径 = double 域归一化』这条承诺的守卫）」；③ **`merge.ts` / `bucketAssign.ts` 不校验 L2 归一化是**刻意**的** —— `src/vector/dot.ts:230-233` 明写「⚠️ **本函数只验，不改**：向量是否**已 L2 归一化**由调用方保证…本函数**不代为归一化**（代劳会掩盖调用方的 bug，也会让『后端不做任何再归一化』这条边界失守）」。<br>⇒ ⇒ **真正的缺口**是：`mergeMemory()`（`merge.ts:331` 直接 `vectorToBlob(input.vector)`）与 `assignBucket()`（`bucketAssign.ts:147` 只调 `assertValidEmbedding`）**都假定入参已归一化，而这条假定只靠注释维持** ⇒ **将来若有人绕过 `write.ts` 直接调这两个内部函数，落库的就是未归一化向量** ⇒ 余弦 ≠ 点积 ⇒ **与 `dot.ts` 自己警告的「老库与新库的向量不可比 ⇒ 静默劣化」同一类失效**。<br>⇒ **当前所有内部调用方都自洽**（`write.ts:1050` 传的 `vector` 来自 `resolveVector` ⇒ 已归一化）⇒ **不是活 bug，是「纪律没有守卫」的观察项**。<br>⇒ **建议**：比照 `scripts/check-bucket-write.ts` 加一条 `scripts/check-vector-write.ts`（或并入它），把「向量只能经 `write.ts` 的 `resolveVector` 落库」变成**生产侧硬门禁** ⇒ 挂进 `pnpm run verify`。<br>⚠️ **但要换个正则形状**：`check-bucket-write.ts` 的正则是 `/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+vector_cell_members\b/gi`
| **Q-16** | **Major** | `bench/perf.ts:329-330`；`bench/perf.ts:319` | **门槛判定的「两个输入」都是自由的** —— 与 **Q-02（规模无下限）**同型：**样本量也没有下限**。<br>① **规模无下限**（= Q-02）：`--scale` 无校验 ⇒ 实测 `--scale=1500` 照样跑完落盘、**退出码 0**。<br>② **★ 样本量无下限**（新增）：`bench/perf.ts:329-330` 的 `intArg(args,'queries',200)` / `intArg(args,'writes',200)` **没有任何下限校验**；`checkPerf()` 里唯一的样本数守卫是 `=== 0`（`:319`，「样本数为 0 ⇒ P99 是真空通过」）⇒ **n=20 时 P99 就是最大值**（nearest-rank，**n < 100 ⇒ P99 == max**）。<br>⇒ ⇒ **「规模 ≥ 100 万」与「样本 ≥ 200（建议 ≥1000）」两个下限都要钉死** —— 只补规模那条，结论**仍然不可用**（n=10 的 recall P99 与 n=50 的写入 P99 都只是「最差的那一次」）。<br>⇒ **本轮最可复用的检查式**（建议写进下一轮 QA 清单）：对每条「验收行」问三句 —— ① **判定输入**（规模 / 样本量 / 口径）**有没有下限**？② **不达标时退出码是不是非 0**？③ **判定逻辑写在代码里，还是只写在文档里**？ | `bench/perf.ts:329-330`：`const queryCount = intArg(args,'queries',200); const writeCount = intArg(args,'writes',200);`（**无下限**）<br>`bench/perf.ts:319`：`if (result.recallSamples === 0 || result.writeSamples === 0 || result.vectorRouteSamples === 0)`（**只挡 0**）<br>并行 QA 实证：`pnpm exec tsx bench/perf.ts --scale=1500 --queries=20 --writes=20` ⇒ **落盘 + 退出码 0**<br>P99 边界实测（复刻 `bench/lib/harness.ts` 的 nearest-rank）：n=1/5/10/20/50 ⇒ **P99==max**；n=100 ⇒ 第 99 个；n=200 ⇒ 第 198 个 | `cd D:/Git/repo && grep -n "intArg(args, 'queries'\|intArg(args, 'writes'" bench/perf.ts` |
—— 它**要求表名紧跟在动词后面**（`UPDATE vector_cell_members`）。
⇒ 而向量写入的形态是 `UPDATE memories SET embedding = …`（**目标不是紧跟动词的那个词**）
⇒ ⇒ **照抄那个正则形状会一条都抓不到** ⇒ 必须另写一个锚在 `SET embedding` 上的模式。
⚠️ **好消息**（我实测过，**更正我自己一版错误的措辞**）：那个扫描器**不是逐行匹配** ——
它在**全文**上 `exec`（`\s` 含 `\n`）⇒ **跨行、带 `WHERE`、`INSERT OR REPLACE` 三种形态都能命中**（实测均 YES）
⇒ ⇒ **扫描器本身的能力足够，不需要改造；需要改的只是「匹配哪个形态」。**<br>⇒ **通用教训**：**Q-02（规模断言）、Q-15（向量写入门禁）这类「加门禁」的活，必须自带负控**（像 `check-bucket-write.ts` 那样断言「命中数 > 0」+「白名单里的文件真的被扫到」），否则就是下一个恒绿守卫。 | `src/vector/dot.ts:230-233`：「本函数只验，不改：向量是否已 L2 归一化**由调用方保证**」<br>`src/store/merge.ts:331`：`embedding: input.vector === null ? null : vectorToBlob(input.vector)`（**不归一化**）<br>`grep -rn "SET embedding" scripts/` ⇒ **0 命中**（静态守卫只存在于 `tests/unit/merge.test.ts`，**不在 `scripts/` 门禁链里**）<br>正则实测：紧跟表名 **YES** / 跨行 **YES** / 带 WHERE **YES** / `INSERT OR REPLACE` **YES** | `cd D:/Git/repo && sed -n '228,236p' src/vector/dot.ts && sed -n '329,333p' src/store/merge.ts` |

---

# 5. 智能路由判定

## 判定：**`Engineer`**（最终判定；Q-01 闭环后**不再有 QA 侧遗留**）

| 分类 | 条目 | 路由 | 状态 |
|---|---|---|---|
| **测试代码 Bug** | **Q-01**（`tests/unit/bucketSync.test.ts:383` 的断言/夹具） | ⇒ **`QA`（我自己）** | ✅ **已修并提交（`720deec`）**，并行 QA 独立复验：修前该变异 🟢 12/12 全绿（恒绿守卫）⇒ 修后同一条变异 🔴 红 ⇒ 全量 41/809 全绿 |
| **验收项缺口（需实现）** | **Q-02**（硬断言「规模写进验收行」在 `bench/` 里**无对应物**）、**Q-16**（**样本量**同样无下限 ⇒ 门槛判定的两个输入都是自由的） | ⇒ **`Engineer`** | ⏳ 待实现 |
| **生产代码（待优化）** | **Q-06**（`readVectorMemories()` 用 `.all()` ⇒ 3.3GB 与 3.07GB 同时存活 ⇒ 峰值 8.47GB） | ⇒ **`Engineer`** | ⏳ 待流式化 |
| **数据口径 / 文档** | Q-03（1M 基线不达标 + P99 口径）、Q-04（README 索引断链）、Q-09~Q-11、Q-14、**Q-15**（向量写入纪律无机器守卫） | ⇒ **`Engineer`** | ⏳ 待重刷/补写 |
| **设计缺口（需裁决）** | Q-05（关窗义务无锚点）、Q-07（宿主层不可实现）、Q-08（门槛口径）、Q-12（裁决台账不存在） | ⇒ **`software-architect`** | ⏳ 已发消息 |

### 5.0 为什么最终是 `Engineer` 而不是 `QA` 或 `NoOne`

- **不是 `QA`**：Q-01 是本轮**唯一**的 QA 侧缺陷（恒绿守卫），**已修 + 已提交 + 已双向复验** ⇒ 无遗留。
- **不是 `NoOne`**：仍有**待实现**的验收项缺口（**Q-02**：设计要求「断言规模达标（不达标直接失败）」，
  而 `bench/` 里**一条这样的语句都没有** ⇒ 实测 `--scale=1500` 照样落盘、退出码 0）
  与**待优化的生产代码**（**Q-06**：训练峰值 8.47GB，根因在 `src/vector/ivf.ts` 的 `.all()`）
  ⇒ 这些**必须由工程师动手**，不是「无人可派」。
- ⇒ **`Engineer`**（Q-02/Q-06/Q-03/Q-04/Q-09~Q-11/Q-14）＋ **`software-architect`**（Q-05/Q-07/Q-08/Q-12）
  ＝ 当前 P2 收官的全部剩余可执行项。

**为什么生产代码没有 Blocker**：全部 **6 条变异**里，**生产代码在每一条上都表现正确**：
M1/M4 的红是因为测试确实守住了设计；M2/M5 的红同理；
唯一存活的 M3 **暴露的是测试夹具的问题**——生产实现 `diffBucketMembership()` 在「真·条数相同」场景下
**正确报出 `missing` / `isConsistent=false`**（探针实测确认）。
⇒ **生产代码没有功能 bug**，只有 Q-06 那条**资源效率**问题（按设计字面判据它「通过」）。

---

## 5.1 ⚠️ 环境坑自查（并行 QA 提示的三条，我逐条核过：**我的树全部干净**）

| 坑 | 我的核验结果 |
|---|---|
| **软链 `node_modules` 污染主工作树**（`pnpm install` 顺链冲掉 `node_modules/.bin`） | ✅ **我没踩**：主工作树 `node_modules/.bin` **完好（24 个条目**，biome / tsc / tsup / tsx / vitest 都在）⇒ 我全程用 `pnpm run verify`，**从未在主工作树跑过 `pnpm install` / `pnpm ci`** |
| **`cp -r SRC DST` 在 DST 已存在时变成 `DST/SRC`** | ✅ **我没踩**：还原一律用 `cp <单文件>`；已核 `src/src`、`scripts/scripts`、`tests/tests`、`bench/bench`、`docs/docs` **在 main 与 worktree 中均不存在** |
| **QA 探针脚本放在被审仓库根目录 ⇒ 被 biome / typecheck 扫到 ⇒ 假红** | ✅ **我没留**：我唯一的探针 `probe-m3.ts` 放在 **worktree 根目录**、**跑完即删**（已核不存在）；`.qa-report/` 在 `.git/info/exclude` 里且 biome `files.ignore` 含 `".tmp/**"` ⇒ **不影响门禁**。⚠️ 但**有一条值得记进经验**：`biome.json` 的 `files.ignore` 显式列了 `".tmp/**"` ⇒ **`.tmp/` 下的 `.ts` 不会被 biome 扫到** ⇒ 探针放 `.tmp/` 是安全的（main 里现存的 `.tmp/probe-semantics.ts` 是 10-31 的历史残留，**biome 不扫它**，verify 仍 126 files / 0 error） |

---

# 5.2 Q-01 的修复与验证（QA 自修，测试代码，生产代码未动）

- **修复提交**：`720deec`（main，已提交）
- **改法**（`tests/unit/bucketSync.test.ts`，+21 / −1）：
  1. 先 `DELETE FROM memories WHERE id LIKE 'seed-%'` 清掉 40 条种子记忆
     ⇒ 让「条数相同」这个前提**真的成立**；
  2. **补上库侧的核对**（原实现漏了）：断言 `liveCount == 1` 且 `liveCount == 桶表行数`
     ⇒ 前提从此**被显式验证**，不可能再悄悄失效。
- **验证**：
  - 原实现：该测试通过；main 全量 `pnpm run verify` **退出码 0**（41 files / 809 tests）；
    `pnpm run build` **退出码 0**；
  - 变异实现（COUNT 比较）：该测试**变红**
    `AssertionError: expected [] to include '<id>'` ⇒ **Q-01 关闭**。
- ⚠️ 修复过程中踩到并已解决：`pnpm run lint`（biome）报**行宽**格式错 ⇒ 已用
  `pnpm exec biome check --write` 格式化 ⇒ 重跑 verify 全绿。

---

# 5.3 ⚠️ 给主理人的两条操作提醒

1. **worktree `D:/Git/wt/p2-t01` 被 P3 工程师并发使用**：本轮 QA 的 6 条变异在 **09:12~09:23** 之间
   完成并全部还原（逐字节 `cmp` 已验）；**09:24** 该 worktree 出现了 `src/neuron/coacts.ts`
   （**未跟踪**文件，26KB）⇒ 疑为 P3 工程师正在写入。
   ⇒ **该 worktree 不是 QA 独占** ⇒ 建议给后续 QA 分配**独立 worktree**，
   否则变异测试会与并发写入互相污染（本轮我发现的唯一一次假失败
   `tests/unit/coact-guard.test.ts`（「src/ 里还没有任何共激活写入」）**正是**这个原因，
   **不是** P2 的问题）。
2. **主工作树 `D:/Git/repo`**：QA 只提交了一个**测试代码**修复（`720deec`），
   **未改动任何生产代码**（`src/**` 与 `4c70582` 逐字节一致）。

---

# 6. ⑤⑥ 各小节的独立结论

⇒ **完整内容见 `p2-adjudication.md`**。摘要：

| 小节 | 结论 | 严重级 | 路由 |
|---|---|---|---|
| **⑤ `mergeMemory()` 拿不到** | **❗ 不阻塞 P2 收官**（它是**内部函数**，不在 §6 的 23 方法里；§3.1 规定阶段 2 只加 `rebuildVectorBuckets`；P2-T07 的 5 条硬断言无一要求它）⇒ **不阻塞**。但 §4.9 步骤 3a2 的**宿主调度层对宿主不可实现**（Q-07）⇒ **需架构师补设计**。<br>`CoactPair`/`CoactSkipped`/`MergeEventPayload3c` ⇒ **不构成「半承诺」**（全部 type-only、运行时 0 命中；`MergeEventPayload3c` 被生产代码实际使用；另两个是 `TouchEventPayload` 的**可选**字段类型，导出是机械必然；coacts 未实现）。 | Q-07 **Major** | **software-architect** |
| **⑥① 性能门槛类型冲突** | **有条件可接受，但不足以支撑 P2 签字**。冲突精确行号：`DEVELOPMENT-PLAN.md:2035-2038`（硬）vs `:2072-2076`（软）vs `:109`（软）；`DESIGN-v2.md:5944-5947`（未标注）、`:1260`「**验收门槛**」、`:5033`「**门槛**」。⇒ 实现选「软」这一派本身不算错，**但落盘的 1M 数据本身不达标**（Q-03）⇒ **无论怎么裁，P2 都不能声称「性能门槛已达标」**。<br>**建议裁决方向**：裁成**硬门槛**，改 `DEVELOPMENT-PLAN.md:2035-2038`（类型列）、`:2072-2076`（去重）、`:109`（移出软阈值列）；若坚持软阈值，则必须改 `DESIGN-v2.md:1260` 的「验收门槛」措辞并在 README 顶部声明现状。 | **Major**（若裁硬 ⇒ **Blocker**） | **software-architect**（裁决）+ software-engineer（按裁决改实现/重刷） |
| **⑥② 规模硬断言** | 默认 `--scale` **确实是 1 000 000** ✅；**「断言规模达标（不达标直接失败）」的语句不存在** ❌ ⇒ **验收项缺失**，**Major**。CI 链里 1500 条的 `tests/bench/bench-smoke.test.ts` **不满足**该硬断言的意图（它断的是逻辑正确性，**明确不断性能达标**——这个解耦本身合理）⇒ 但**没有任何东西**保证「落盘基线来自 ≥100 万」。<br>**最小成本落地**：① bench 脚本加写死的规模下限断言；② 加一条**契约测试**断言「落盘 `docs/baseline/*.json` 的 `corpusSize` ≥ 1 000 000」（秒级、可进 CI）——它会**立刻变红**，正好把「百万级吻合率未采到」变成机器可见的欠账。 | **Major** | **software-engineer** |
| **⑥③ 训练峰值 8.47GB** | **优化项（技术债），不是功能缺陷**——设计的判据是「**≥ 3.5GB 的下限**（资源规划提醒）」⇒ **字面满足**。但它是必要量的 **2.4 倍** ⇒ 8GB 机器 OOM ⇒ 且若 8.47GB 真是需求，**设计稿的 3.5GB 估算错了、必须回写**。根因已在 `src/vector/ivf.ts:102-118` 核实（`.all()` 物化 + `blobToVector` 同时存活）。**我没有改生产代码**。另：`sampledPeakRssBytes: 0` ⇒ 这条软阈值**没有独立测量值**。 | **Major** | **software-engineer**（流式化 + 修采样）+ software-architect（回写 3.5GB 估算） |
| **⑥④ 1 万条 233.64ms** | **不按工程师给的理由算「脏数据」**——该理由**被代码与数据双重反证**：① 「写入也预热 20 轮」在**产出该 JSON 的那个 commit（`fba3049`, 22:18）里就已经存在**（不是 22:29 才加的）；② 同一份 JSON 的 `firstWriteMs = 4.5762` ⇒ **第一次写入是 4.58ms，不是 233.64ms**；③ 分布是 50 个样本里 **1 个离群点**（min 3.33 / p50 4.49 / p95 8.03 / max 233.64）⇒ **它是未被解释的单样本离群值**，不是首写污染（具体成因**无法从落盘物判定**——JSON 只存分布）。<br>⇒ **但仍然必须重刷三份 JSON**（不是「标注为过期」）：该文件自己的 `failures` 写着「写入 P99 233.643ms > 5ms」⇒ **重刷与否会改变「写入门槛达不达标」这个结论**；且重刷必须用 **≥200 样本**（nearest-rank 下 **n < 100 时 P99 == max** ⇒ n=200 才取到第 198 个；建议 **≥1000**）。**同一条问题也命中 1M 那份**（recall 只有 10 个样本）。 | **Major**（数据不可用于结论），**不阻塞代码** | **software-engineer**（重刷） |

---

# 7. 落盘物清单

| 文件 | 归属 | 内容 |
|---|---|---|
| `D:/Git/wt/p2-t01/.qa-report/p2-verify-qa2.md` | **qa2（本文件的规范副本）** | 门禁基线 + 逐任务核对 + 攻击面 + **问题清单 Q-01~Q-16** + 智能路由 |
| `D:/Git/wt/p2-t01/.qa-report/p2-mutation-qa2.md` | qa2 | **变异测试记录**（M1~M6，含还原校验 + M3 的 Q-01 闭环复验） |
| `D:/Git/wt/p2-t01/.qa-report/p2-adjudication-qa2.md` | qa2 | **⑤⑥ 独立结论**（含 ⑥①/⑥④ 的口径更正） |
| `D:/Git/wt/p2-t01/.qa-report/p2-final-qa1.md` | **qa1（并行 QA `software-qa-engineer`）** | 他的独立汇总（13+ 条变异、文档侧发现）—— **与我的三份并列、不覆盖** |
| `p2-verify.md` / `p2-mutation.md` / `p2-adjudication.md` | 通用名 | **我那版的副本**（已从 `-qa2` 同步）；**从现在起我只维护 `-qa2` 三份，通用名不再写** |

**还原校验（收尾）**：`D:/Git/wt/p2-t01` 的 `git status --porcelain` **为空**（除并发 P3 工程师的未跟踪 `src/neuron/`）；
`cmp` 逐字节校验 5 个被变异过的文件**全部与 main 一致**；worktree 全量回归 **41 files / 809 tests 全过**；
主工作树 `D:/Git/repo` 的 **`src/**` 与 `4c70582` 逐字节一致**（`git diff 4c70582 HEAD -- src/` **为空**），
**唯一提交 `720deec` 只改测试代码**（`git show --name-only 720deec` ⇒ 仅 `tests/unit/bucketSync.test.ts`）；
main `pnpm run verify` **退出码 0**、`pnpm run build` **退出码 0**。
