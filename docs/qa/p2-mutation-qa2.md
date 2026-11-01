# P2 变异测试记录（QA 自己做，不采信工程师自测）

> 执行人：software-qa-engineer-2｜工作树：`D:/Git/wt/p2-t01`（分支 `feat/p2-t03`，内容与 main HEAD `4c70582` **逐字节同树**）
> ⚠️ **只在 worktree 里做**；主工作树 `D:/Git/repo` **全程未改**（`git status --porcelain` 始终为空）。
> ⚠️ **还原方式**：`cp` 备份 + `cmp` 逐字节校验（**未用** `git stash` / `git restore` / `git checkout --`）。
> ⚠️ **扰动幅度**：全部为**结构性改坏**（改算法/改判定口径），**不是** `1e-9` 级浮点扰动（那会被 float32 舍入掉）。

## 基线（变异前，worktree 内）

```
$ pnpm exec vitest run <6 个 P2 测试文件>
 Test Files  6 passed (6)
      Tests  103 passed (103)
```

---

## M1 · T03「换桶不残留」—— §4.15.5 所说的「唯一的静默失效点」

**变异**：`src/vector/bucketAssign.ts` 的 `assignBucket()` 里，把「无条件 DELETE 旧归属行」
改成**只在桶没变时才 DELETE**：

```diff
-    db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run(memoryId);
+    if (previousFineId === fineId) {
+      db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run(memoryId);
+    }
```

**结果：红了 9 条断言**（4 个测试文件）

| # | 失败断言（原文） | 文件 |
|---|---|---|
| 1 | `★ 一条记忆换桶后，vector_cell_members 里它的行数 == 1` | `tests/unit/bucketAssign.test.ts` |
| 2 | `★ 换桶时唯一索引不被违反（先 DELETE 再 INSERT ⇒ 不会抛 UNIQUE constraint failed）` | 同上 |
| 3 | `★ 说明：唯一索引只是最后一道防线——没有它时「只 INSERT 不 DELETE 旧行」会**静默重复**` | 同上 |
| 4 | `★ 换桶后旧桶 −1、新桶 +1（计数与行永远一致，不可能漂移）` | 同上 |
| 5 | `★ 合并改了向量 ⇒ 桶归属同步更新（与**新**向量对应，且仍只有一条）` | `tests/unit/bucketSync.test.ts` |
| 6 | `删除顺序不可颠倒：步骤 ③ 之前旧代桶仍在（且新桶已存在），步骤 ③ 之后旧代桶全部消失` | `tests/integration/rebuildBuckets.test.ts` |
| 7 | `形状变化后残留的旧代桶也被清掉（新模型里不存在的细桶一个都不留）` | 同上 |
| 8 | `崩溃恢复：② 提交了一部分 ⇒ 旧桶仍在、库仍可用；重做一次 ⇒ 归属与一次跑完完全一致` | 同上 |
| 9 | `同事务性：单条记忆的 DELETE + INSERT 在同一事务内（并发读者永不见中间态）` | 同上 |

代表性失败原文：

```
AssertionError: expected [Function] to throw error including '模拟崩溃'
but got '唯一性冲突：目标已存在（§4.8.1 / §4.9.1 / §4.9.2 的三个来源）'
```

**结论**：T03/T05 的「换桶先 DELETE 再 INSERT」这条硬断言**有牙**，且跨 T03/T05 三个测试文件生效。

**还原**：`cp` 还原 ⇒ `cmp` 一致 ⇒ `git status --porcelain` 为空 ✅

---

## M2 · T07「写入路径不加时间窗」—— §4.9 步骤 3a2

**变异**：`src/vector/ivf.ts` 的 `buildBucketCandidateSql()`（**生产代码真正执行的那条 SQL**）里
加一条设计明确禁止的时间窗：

```diff
       WHERE vcm.fine_id IN (${placeholders})
         AND m.deleted = 0
-        AND m.embedding IS NOT NULL`;
+        AND m.embedding IS NOT NULL
+        AND m.last_access >= ${QA_MUTATION_COARSE_CUTOFF}`;   // 1_700_000_000_000
```

**结果：红了 3 条断言**（全部落在 `tests/unit/dedupCandidates.test.ts`，`Test Files 1 failed | 2 passed`）

| # | 失败断言（原文） |
|---|---|
| 1 | `★ 候选 SQL 里**不含**任何时间窗条件（静态断言：没有 last_access 过滤）` |
| 2 | `★ 一条**半年前**访问过的近重复**仍然进候选**（没有 @coarseCutoff）` |
| 3 | `★ 一条**半年前**写入的近重复**仍然会被合并**（注入时钟 ⇒ 没有 @coarseCutoff）` |

代表性失败原文（静态断言那条）：

```
expect(received).not.toMatch(/last_access\s*(>=|<=|>|<|BETWEEN)/i)
```

**结论**：T07 的「不加时间窗」这条硬断言**有牙**，且**静态断言 + 行为断言两条都在**（不是单靠一条）。
⚠️ 注意：该变异**没有**让 `EXPLAIN QUERY PLAN` 那条变红 —— 说明时间窗与「全表扫」是**两条独立的轴**，
门禁确实覆盖了设计里点名的两个不同失效模式。

**还原**：`cp` 还原 ⇒ `cmp` 一致 ⇒ `git status --porcelain` 为空 ✅

---

## M3 · T03/T06「集合相等，不是条数相等」—— §9.3.2 ③ ★ **本轮最重要的发现**

**变异**：`src/vector/bucketAssign.ts` 的 `diffBucketMembership()` 里，把「双向集合比较」
换成「先比条数，条数一样就认为一致」：

```diff
   const bucketIds = new Set(bucketRows.map((row) => row.memoryId));
-  const missing = liveRows.map((row) => row.id).filter((id) => !bucketIds.has(id));
+  const qaCountsMatch = liveRows.length === bucketIds.size;
+  const missing = qaCountsMatch ? [] : liveRows.map((row) => row.id).filter((id) => !bucketIds.has(id));
```

### 结果：**只红了 1 条断言**（`tests/integration/reconcile.test.ts` 的「对账后的库仍与既有口径一致」）

而**本该抓住它的**那条断言**没有红**：

```
FAIL  tests/unit/bucketSync.test.ts > … > ★ 集合相等**不是**「条数相等」：一条漏 + 一条多 ⇒ 条数相同也必须报红
```

⇒ **该变异存活 ⇒ 这条断言是假阴性（恒绿守卫）。**

### QA 探针复核（临时脚本，跑完即删）

复刻 `tests/unit/bucketSync.test.ts:383` 的场景并打印两侧条数：

| 实现 | liveCount | bucketCount | 两侧条数相同？ | `diff.missing` 含 甲事实 | `isConsistent` |
|---|---|---|---|---|---|
| **原版（集合比较）** | 41 | 1 | ❌ | ✅ true | false |
| **变异版（COUNT 比较）** | 41 | 1 | ❌ | ✅ true | false |
| **原版（集合比较）** + **真·条数相同** | 1 | 1 | ✅ | ✅ true | false |
| **变异版（COUNT 比较）** + **真·条数相同** | 1 | 1 | ✅ | ❌ **false** | ❌ **true** |

### 根因

`tests/unit/bucketSync.test.ts:383` 那条测试**并没有真的构造出「条数相同」的场景**：

- 夹具 `createTrainedBucketContext()`（`tests/fixtures/bucket-store.ts:61-66`）会落 **40 条带向量、
  不入桶**的种子记忆（`seed-000` … `seed-039`，用来模拟阶段 1 的欠账）；
- ⇒ 该场景下 **liveCount = 41**（40 条种子 + 甲事实）、**bucketCount = 1**（只把甲的桶行改挂到乙名下）
  ⇒ **两侧条数根本不相等**；
- 测试自己的注释「性质：条数确实相同（桶表里就 1 行）」只核对了**桶侧**，
  **从未核对库侧** ⇒ 断言的**前提从未成立**。

### 判定

- **生产代码是对的**（原版在真·条数相同场景下正确报出 `missing` / `isConsistent=false`）；
- **测试夹具/断言有 Bug** ⇒ **路由 = QA**；
- 严重级：**Major** —— 因为这正是设计里点名的、会导致「**漏召永久存在且无人发现**」的那条硬断言
  （§9.3.2 ③：「只比条数会漏掉『A 多一条、B 少一条』这种**总数相同但内容不同**的情况」）。

**还原**：`cp` 还原 ⇒ `cmp` 一致 ⇒ `git status --porcelain` 为空 ✅

---

## M4 · T05「重训的删除顺序不可颠倒」—— §4.15.5 ★

**变异**：`src/vector/rebuild.ts` 的 `rebuildBuckets()` 里，把「删旧代桶」提前到**步骤 ② 之前**
（设计原文：「⚠️ **为什么不能先删旧桶**：删旧粗桶会**级联删掉它下面全部细桶**，再级联删掉全部
`vector_cell_members` 行 ⇒ **一次重训 = 全库桶归属被清空**」）：

```diff
   hooks.onCentroidsWritten?.();
+
+  // ⚠️⚠️ **QA 变异 M4**：把「删旧代桶」提前到**步骤 ② 之前**
+  runInTransaction(() => {
+    pruneStaleCentroidCells(db, model);
+  });
```

**结果：红了 3 条断言**（`tests/integration/rebuildBuckets.test.ts`）

| # | 失败断言（原文） |
|---|---|
| 1 | `删除顺序不可颠倒：步骤 ③ 之前旧代桶仍在（且新桶已存在），步骤 ③ 之后旧代桶全部消失` |
| 2 | `崩溃恢复：② 提交了一部分 ⇒ 旧桶仍在、库仍可用；重做一次 ⇒ 归属与一次跑完完全一致` |
| 3 | `同事务性：单条记忆的 DELETE + INSERT 在同一事务内（并发读者永不见中间态）` |

代表性失败原文：

```
AssertionError: expected [ false ] to deeply equal [ true ]
  [
-   true,
+   false,
  ]
```

**结论**：T05 的「三步硬约束顺序」这条硬断言**有牙**；且它**连带**抓住了「崩溃恢复」与「同事务性」两条。

**还原**：`cp` 还原 ⇒ `cmp` 一致 ⇒ `git status --porcelain` 为空 ✅

---

## M5 · T01「score ∈ [0,1] 钳制」—— §4.15.2

**变异**：`src/core/scoring.ts` 的 `clampCos()` 里，去掉区间钳制：

```diff
-  return Math.min(1, Math.max(0, dot));
+  // ⚠️⚠️ **QA 变异 M5**：去掉区间钳制
+  return dot;
```

**结果：红了 9 条断言**（4 个测试文件）

| # | 失败断言（原文） | 文件 |
|---|---|---|
| 1 | `所有命中的分数都落在 [0,1]，且负余弦被钳到 0` | `tests/unit/vector-backend.test.ts` |
| 2 | `k 大于候选数时，返回条数 == 候选数，且每条都有合法分数` | 同上 |
| 3 | `同一批向量、同一 query ⇒ id 顺序与每个 score 都逐位相同` | 同上 |
| 4 | `search() 的 score 全部 ∈ [0,1]，且不足 k 时返回实际条数` | `tests/unit/ivf.test.ts` |
| 5 | `upsert() 覆盖索引侧的向量与归属；remove() 让它不再出现` | 同上 |
| 6 | `★ cos 钳制到 [0,1]；本阶段向量路缺席 ⇒ 每条命中的 cos 都是 null` | `tests/unit/recall.test.ts` |
| 7 | `★ 反例：不钳制 ⇒ `cos ≥ VECTOR_MIN_COS` 在边界上不稳定（浮点误差能翻面）` | `tests/unit/scoring.test.ts` |
| 8 | `点积：同向 ⇒ 1；反向 ⇒ 0；维度不一致 ⇒ INVALID_INPUT` | 同上 |
| 9 | `钳制到 [0, 1]：浮点误差给出的 1.0000001 ⇒ 1；负余弦 ⇒ 0` | 同上 |

代表性失败原文：

```
AssertionError: expected -0.014726433902978897 to be greater than or equal to 0
 ❯ tests/unit/vector-backend.test.ts:235:27
    234|       expect(Number.isFinite(hit.score)).toBe(true);
    235|       expect(hit.score).toBeGreaterThanOrEqual(0);
```

**结论**：T01 的「score 钳制」硬断言**有牙**；且它跨 `vector-backend` / `ivf` / `scoring` / `recall`
四个测试文件生效 ⇒ 说明这条约束在多层被真正执行，不是只在一个地方断言。

**还原**：`cp` 还原 ⇒ `cmp` 一致 ⇒ `git status --porcelain` 为空 ✅

---

## 还原后的全量回归（worktree）

```
$ pnpm exec vitest run
 Test Files  41 passed (41)
      Tests  809 passed (809)
```

⇒ 与 main 基线**完全一致**（41 / 809），worktree **已完全还原**。

---

## 变异测试总结

| # | 任务 | 设计硬断言 | 变异 | 红了 | 断言「有牙」？ |
|---|---|---|---|---|---|
| M1 | P2-T03/T05 | 换桶不残留（§4.15.5） | 换桶时不删旧归属 | **9** | ✅ |
| M2 | P2-T07 | 写入路不加时间窗（§4.9 步骤 3a2） | 候选 SQL 加时间窗 | **3** | ✅ |
| M3 | P2-T03/T06 | 集合相等 ≠ 条数相等（§9.3.2 ③） | 改成 COUNT 比较 | **1（应 ≥3）** | ❌ **假阴性 ⇒ QA 缺陷** |
| M4 | P2-T05 | 删除顺序不可颠倒（§4.15.5） | 先删桶后迁成员 | **3** | ✅ |
| M5 | P2-T01 | score ∈ [0,1]（§4.15.2） | 去掉 clampCos 钳制 | **9** | ✅ |

**总判定**：5 条变异里 **4 条**断言有牙、**1 条（M3）**存活 ⇒
P2 的断言体系**整体质量高**，但 **M3 对应的那个夹具/断言必须修**（见问题清单 Q-01）。

---

## M6 · T03/T04「桶归属唯一写入点」的 lint 门禁 —— **实测绕过尝试**

> 这条是**门禁级**变异（不是单测级）：QA **真的往生产代码里塞了一行裸的桶表写入**，看门禁会不会红。

**变异**：`src/store/write.ts` 注入：

```ts
// ⚠️⚠️ **QA 变异 M6**：故意在生产代码里加一行裸的桶表写入（绕过唯一写入点）
function qaRogueBucketWrite(db: import('better-sqlite3').Database): void {
  db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run('f-000-000', 'm-1');
}
```

**结果：门禁红了，退出码 1，且定位精确**：

```
桶归属唯一写入点的 lint 门禁（§9.3.0）
  白名单（写死的期望值）：vector/bucketAssign.ts
  扫到的裸写处数：4
✗ 发现 1 处不一致：
    store/write.ts:1008 出现了裸的桶表写入（唯一合法的写入点是 vector/bucketAssign.ts，§9.3.0：
    桶归属的写入只允许出现在一个内部函数里）
EXIT_CODE=1
```

**还原**：`cp` 还原 ⇒ `cmp` 一致 ⇒ `git status --porcelain` 为空 ⇒ 重跑门禁 `EXIT_CODE=0`、`扫到的裸写处数：3` ✅

**结论**：T03 的「唯一写入点」与 T04 的 lint 门禁**都是真的**（不是靠自觉、不是靠注释提醒）。
另注：扫描器**剥注释**处理正确 ⇒ 变异里那行**注释**（含 `INSERT INTO vector_cell_members` 字样）
**没有**造成误报 ⇒ 命中的是**代码行 1008** 而非注释行。

---

## 变异测试总结表（最终）

| # | 任务 | 设计硬断言 | 变异 | 红了 | 有牙？ |
|---|---|---|---|---|---|
| M1 | P2-T03/T05 | 换桶不残留（§4.15.5） | 换桶时不删旧归属 | **9** | ✅ |
| M2 | P2-T07 | 写入路不加时间窗（§4.9 3a2） | 候选 SQL 加时间窗 | **3** | ✅ |
| M3 | P2-T03/T06 | 集合相等 ≠ 条数相等（§9.3.2 ③） | 改成 COUNT 比较 | **1（应 ≥3）** | ❌ **假阴性 ⇒ Q-01** |
| M4 | P2-T05 | 删除顺序不可颠倒（§4.15.5） | 先删桶后迁成员 | **3** | ✅ |
| M5 | P2-T01 | score ∈ [0,1]（§4.15.2） | 去掉 clampCos 钳制 | **9** | ✅ |
| M6 | P2-T03/T04 | 唯一写入点 + lint 门禁（§9.3.0） | 往 `write.ts` 塞裸 INSERT | **门禁红（exit 1）** | ✅ |

---

## M3 的收尾：QA 修复与复验（Q-01 关闭）

**修复提交**：`720deec`（main；**只改测试代码**，生产代码未动）

**改法**（`tests/unit/bucketSync.test.ts`，+21 / −1）：

1. 先清掉 40 条种子记忆，让「条数相同」这个前提**真的成立**：
   ```ts
   db.prepare("DELETE FROM memories WHERE id LIKE 'seed-%'").run();
   ```
2. **补上库侧的核对**（原实现漏了 ⇒ 前提从未被验证）：
   ```ts
   const liveCount = (
     db.prepare('SELECT COUNT(*) AS count FROM memories WHERE embedding IS NOT NULL AND deleted = 0').get() as { count: number }
   ).count;
   expect(liveCount).toBe(1);
   expect(liveCount).toBe(countRows(db, 'vector_cell_members'));
   ```

**复验（修复后 + M3 变异）** ⇒ **变红** ✅：

```
FAIL  tests/unit/bucketSync.test.ts > P2-T03-b · 集合相等断言（§9.3.2 ③ 的三条判据）
      > ★ 集合相等**不是**「条数相等」：一条漏 + 一条多 ⇒ 条数相同也必须报红
AssertionError: expected [] to include 'f5dc4363-0d45-48e2-a65b-b4c782bb0bed'
```

（`missing` 为空 ⇒ 正是「少一条 + 多一条被静默判成一致」那个失效模式 ⇒ 断言现在**有牙**了。）

**修复后的基线**：

| 场景 | 结果 |
|---|---|
| 原实现 + 修复后的测试 | ✅ 通过 |
| M3 变异 + 修复后的测试 | ❌ **变红**（`expected [] to include '<id>'`）✅ |
| main 全量 `pnpm run verify` | ✅ **退出码 0**（41 files / 809 tests） |
| main `pnpm run build` | ✅ **退出码 0** |

⇒ **M3 从「存活」转为「有牙」；6 条变异现在全部有牙。**

⚠️ 过程中踩到：`pnpm run lint`（biome）报**行宽**格式错 ⇒ 已 `pnpm exec biome check --write` 修好。

---

## ⚠️ 给主理人的操作提醒：worktree 并发占用

本轮 QA 的 6 条变异在 **09:12 ~ 09:23** 之间完成并全部还原（逐字节 `cmp` 已验）。
**09:24** 该 worktree 出现了 `src/neuron/coacts.ts`（**未跟踪**，26KB）⇒ 疑为 P3 工程师并发写入。

⇒ **`D:/Git/wt/p2-t01` 不是 QA 独占** ⇒ 建议后续 QA 用**独立 worktree**。
本轮遇到的唯一一次**假失败**（`tests/unit/coact-guard.test.ts` 的
「★ 全库现状：src/ 里还没有任何共激活写入」）**正是**这个原因，**与 P2 无关**。
