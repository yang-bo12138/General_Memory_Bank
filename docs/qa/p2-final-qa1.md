# P2 收官验收 · 最终汇总报告（software-qa-engineer）

> 被审：`D:/Git/repo` `main` **`4c70582`**（P2 收官）
> 执行：`D:/Git/wt/qa-r3`（临时副本，含 `bench/`，**独立 node_modules**）；报告落盘 `D:/Git/wt/p2-t01/.qa-report/`
> 纪律：主工作树 **源码零改动**（`git status --porcelain` 空、HEAD 未变）；14 条变异全部 `cp` 还原 + `cmp`/`diff -r -q` 校验
> ⚠️ **与 `software-qa-engineer-2` 并行**：我们在同一个 `.qa-report/` 目录工作 ⇒ **我覆盖了他们的 `p2-verify.md`**
> （`.qa-report/` 在 `.git/info/exclude` 里 ⇒ **不可从 git 恢复**）⇒ **他们的 `p2-mutation.md` 完好**（我已读并独立复现了他们的 M3）
> ⇒ 我的 `p2-verify.md` 是**重写版**，覆盖只读核查的全部分区；若他们那份有我这里没有的细节，**请他们重发给我**。
> ⇒ 为避免再撞名，本汇总另存为 `p2-final-qa1.md`。
> ⚠️ **更正我先前的一处判断**：`D:/Git/wt/p2-t01` 的 **HEAD 指针**是 `0f81c1c`/`feat/p2-t03`，但它的 **`src/` 与 `tests/` 与 main `4c70582` 逐字节同树**
> ⇒ software-qa-engineer-2 报告里「内容与 main HEAD 4c70582 逐字节同树」**是对的** ⇒ **在那个 worktree 里做变异是有效的**；我先前说「旧树、证据无效」**不成立**，撤回。

---

# 结论

| 项 | 判定 |
|---|---|
| **结论** | **`PASS_WITH_ISSUES`** |
| **智能路由** | ⚠️ **已更正：`Engineer`**（原写 `QA` → 后改 `NoOne`，**两版都不准确**）—— Q-01 已闭环；但**剩余项里有需要改生产代码的**（见「附录四」）：`bench/` 的**规模零强制** + `bench/perf.ts` 把四条门槛当**软阈值**「不判失败」（与计划稿的「硬门槛」相反）⇒ **必须改代码或改计划稿** ⇒ 不能说「无人可派」。**架构师**另需裁决门槛口径与 P2 裁决台账落点。 |

**一句话**：P2 的**实现与门禁**在 14 次变异下**只有 1 处「该红不红」**——而且那处**不是实现的问题，是仓库里那条断言自己的场景没造出来**；除此之外全部有牙。但 **P2 收官的最后一块「100 万条性能验收」没有产生可判定的结论**，且**收官文档断链** ⇒ 建议 **修一条测试 + 补测 + 补文档 ⇒ 即可收官**。

---

# 一、门禁基线

| 项 | 结果 |
|---|---|
| `pnpm run verify`（主工作树） | **EXIT=0** |
| ├ `tsc --noEmit` | ✓ 0 error |
| ├ `biome check .` | ✓ |
| ├ `vitest run` | ✓ **Test Files 41 passed (41) / Tests 809 passed (809)**，19.21s |
| └ 8 条契约脚本 | ✓ params / payload-keys / clock / anchor / bucket-write / contract-ids / doc-counts / clamp 全绿 |
| `pnpm run build` | **EXIT=0** —— ESM `219.56 KB` / CJS `224.74 KB` / DTS `103.71 KB` |

> ⚠️ 事故记录（我造成、已修复、已报备）：我第一轮把临时副本的 `node_modules` **软链到主工作树**，`pnpm install` 顺链冲掉了主工作树的 `node_modules/.bin`
> ⇒ 已用 `pnpm install --frozen-lockfile` 复原（`.bin` 已回、`git status` 全程为空、**源码零改动**），并给临时副本装了**独立** `node_modules`
> ⇒ **上表所有门禁数据都是修复之后跑的**。

---

# 二、逐任务核对（设计 ↔ 实现 ↔ 测试）

清单取自 `DEVELOPMENT-PLAN.md` 的 P2 段落（T01 行 1488 / T02 1554 / T03 1632 / T04 1725 / T05 1772 / T06 1860 / T07 1934 / T08 2004）。

| 任务 | 硬断言 | 真的被断言？ | 位置 | 结论 |
|---|---|---|---|---|
| **T01** 契约 + flat 基线 | init 幂等 / score ∈ [0,1] / 不足 k 返回实际条数 / `VectorFilter` 无 id 白名单 / 与手写全表点积**逐位一致** / score 是原始余弦 | ✅ 全在 | `vector-backend.test.ts`(485) | ✅ |
| **T02** 两级 k-means + IVF | 确定性 / 细桶必属粗桶 / 一条记忆只属一个细桶 / 路由桶数所有组合 / 桶内**全量精确点积** / 三个触发时机 | ✅ 前 5 条全在；**「三个触发时机」无独立断言**（触发条件属阶段 3 调度层） | `ivf.test.ts`(504) / `kmeans.test.ts`(148) | ✅（触发时机见「无法验证」） |
| **T03** 桶归属唯一写入点 | 回滚 / 换桶不残留 / 四条路径全覆盖 / 静态断言裸 SQL / 合并未传向量 unassignBucket / **集合相等** | ✅ 前 5 条在；⚠️ **「集合相等」那条断言是假阴性 ⇒ 见 Q-01** | `bucketAssign.test.ts`(566) / `bucketSync.test.ts`(407) | ⚠️ **有条件** |
| **T04** lint + 锚定检查 | 故意加裸 INSERT ⇒ lint 失败 / 故意删管辖路径 ⇒ check-anchor 失败 / 表头 3 列 / 管辖路径条数写死 | ✅ 全在（**都有负控**） | `scripts.test.ts`(784) | ✅ |
| **T05** rebuildVectorBuckets | 删除顺序 / 崩溃恢复 / 空旧桶清理 / 同事务性 / 幂等 / 重训事件 payload / `inRetrain` 可观测 / **只重训一次 + 告警放行** | ✅ 全在 | `rebuildBuckets.test.ts`(531/12) | ✅ |
| **T06** 启动对账 + P95 | 缺失补齐 / 脏行清理 / **软删保留** / 真孤儿删除 / 重复归属检出 / 三条判据分别报告 / P95 手算 / **重训中整体跳过** | ✅ 全在 | `reconcile.test.ts`(478/14) | ✅ |
| **T07** 候选收窄 | 候选 ≤ 2000 / 不做全表扫（EXPLAIN）/ 不加时间窗 / 与实时层同一合并路径 / **C29 分母纪律** | ✅ 全在（**每条都有负控**） | `dedupCandidates.test.ts`(772) | ✅ |
| **T08** 性能基线 | 吻合率 ≥ 0.98（软）/ 只漏不错 / 桶内精确性 / 语料可复现 / embedder 确定性 / P99 工具自检 | ✅ **断言层**全在且有负控 | `bench-smoke.test.ts`(219，1500 条，在门禁里) | ⚠️ **断言层通过；「100 万条验收」不可判定 ⇒ F1** |

---

# 三、重点攻击面

| # | 攻击面 | 结论 |
|---|---|---|
| 1 | **T03 唯一写入点** | ✅ 门禁扫到 3 处、全在白名单；`src/store/**` 对三张分桶表**零引用（连读也没有）** ⇒ 「流水线只调 `VectorBackend`」**完整成立**。**注入裸 INSERT ⇒ lint 红**（M-A） |
| 2 | **T05 重训** | ✅ `centroids.ts` 用 **`ON CONFLICT … DO UPDATE`（纯 UPDATE，不触发级联）**；**改回 `INSERT OR REPLACE` ⇒ 3 条断言红**（M-B）；**「只重训一次」闸门绕过 ⇒ 1 条红**（M-H） |
| 3 | **T06 启动对账** | ✅ 三条判据真实现（`reconcile.ts` 321 行 + `bucketQuality.ts` 128 行）；脏行清理只含 `orphans`+`vectorless`、**不含 `softDeleted`** ⇒ 「软删不删」在实现层就成立；**变异 ⇒ 断言红**（M-C） |
| 4 | **T07 候选收窄** | ✅ `buildBucketCandidateSql()` 是**生产代码导出的构造器** ⇒ EXPLAIN 断言跑的是**生产 SQL**；SQL 里**无 `last_access` 过滤**；C29 分母是 flat 的**候选全集**（有独立负控）；**改回全表扫 ⇒ 12 条红**（M-D） |
| 5 | **T08 可复现性** | ✅ 种子与机器信息落在 JSON 里；`21cba6a` 修过「复用即测错」；门槛值写在 JSON 的 `thresholds` ⇒ **判定确实按文档阈值做的**（但本次实测**未达标** ⇒ F1） |
| 6 | **导出面** | ✅ `src/index.ts` **零 `src/vector/**` 导出**；`export-surface.test.ts` 守「无向量层导出」+「只有 6 个类」两条；**两条都有负控**（M-E / M-I） |

---

# 四、跨任务一致性

| 项 | 实测 |
|---|---|
| **导入图无环** | `src/**` **43** 模块 + DFS ⇒ **环数 0**；跨层边只有 `store→core`、`store→vector`、`vector→core` |
| **唯一收敛：有没有第五份** | BLOB 编解码 **1** 份（`vector/centroids.ts`）· `MIN_VECTOR_NORM` **1** 份（`vector/dot.ts`）· `clampCos` **1** 份（`core/scoring.ts`）· 桶计数 **1** 份（`vector/bucketAssign.ts`）· `mergeCandidates` **1** 份（`store/recall.ts`）· L2 归一化 2 处但**语义不同** ⇒ **无重复实现** |
| **P1 承诺未被破坏** | 基线逐位一致 **13 条全绿** · 公开面 **11** 个方法（10 + `rebuildVectorBuckets`，硬编码名单守住）· §8.4 事件 type 数仍 **13**（P2 加的是 sweep 的 **action 变体**）· `DEFAULT_PARAMS` **未新增任何键** · C37 豁免清单 7 条且与 §11.1 **双向一致** |

---

# 五、待裁决点：`mergeMemory()` 不在公开导出面 ⇒ **不阻塞 P2 收官**

**依据（四条，均已独立核）**
1. **设计稿全文 `mergeMemory` 出现 0 次** ⇒ 它**不是 §6 的 23 个公开方法之一** ⇒ 塞进导出面**直接违反** P1 的裁决「导出面只含 §12 清单内的东西」（ADR-P1-T07-DEC D-1 / `src/index.ts` 头注释）与 §14.3 边界原则。
2. **`mergeMemory` 是 §4.9 步骤 3c 的内部函数**（`store/merge.ts:291`），入参 `MergeStore`/`MergeMemoryState`/`MergeInput` **都不是公开类型** ⇒ **就算导出了，宿主也构造不出合法入参** ⇒ 导出它**解决不了问题**。
3. **T07 的验收点是「候选收窄」**（`collectVectorCandidates` + `scanBucketCandidates`）⇒ 已落地且被 12 条断言守住（M-D）⇒ **T07 不欠账**。
4. **宿主真正需要的公开入口是 `updateContent()`（§4.9.1）** —— 恰好就是「用新正文改写一条记忆并同事务同步桶归属」那条路径；而 §4.9.1 属**阶段 4**（`check:anchor` 明确记为 `pending`：「§4.9.1 的 updateContent 属阶段 4：src/store/updateContent.ts 尚未建」）⇒ **阶段 2 不提供该入口是阶段划分的事实，不是欠账**。

**建议**：**不要**在 P2 里加 `mergeMemory` 导出；**在 T07 的「已知代价」补一句**：「宿主调度层要『走同一条 3c 路径』⇒ 依赖 §4.9.1 的 `updateContent()`；**阶段 4 之前宿主拿不到公开的 3c 入口**（`mergeMemory` 是 §4.9 步骤 3c 的内部函数，按 §6 不进导出面）」。若宿主**立即**需要 ⇒ 走正常流程：**新增一个 §6 公开方法**（先改 §6 + §12 + 方法归位表 ⇒ 再实现），**而不是导出内部函数**。

---

# 六、问题清单

## 🔴 Q-01 [Major] **路由 = QA**：`tests/unit/bucketSync.test.ts` 的「集合相等 ≠ 条数相等」断言是**假阴性（恒绿守卫）**

**① 现象**
那条断言名叫「★ 集合相等**不是**「条数相等」：一条漏 + 一条多 ⇒ 条数相同也必须报红」，
但它的**场景根本没造出「条数相同」**：夹具 `createBucketStore()` → `createTrainedBucketContext()` 默认落 **40 条带向量、不入桶**的种子记忆（`seed-000`…`seed-039`）
⇒ **库侧 liveRows = 40 种子 + 甲事实 = 41**，**桶侧 = 1** ⇒ **两侧条数是 41 vs 1，根本不相等**
⇒ 而测试自己的注释「性质：条数确实相同（桶表里就 1 行）」**只核对了桶侧、从未核对库侧**
⇒ ⇒ **断言的前提从未成立** ⇒ 它**守不住**它声称要守的东西。

**② 最小复现**（我独立做的，不是转述）
```bash
# 在临时副本上：把 diffBucketMembership 的双向集合比较换成「先比条数，条数一样就认为一致」
node .qa-mn.cjs
pnpm exec vitest run tests/unit/bucketSync.test.ts
```
**③ 失败输出 —— 实际是「全绿」（这就是问题）**
```
 ✓ tests/unit/bucketSync.test.ts (12 tests) 262ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```
（同时 `tests/integration/reconcile.test.ts` 的「对账后的库仍与既有口径一致（集合相等）」**红 1 条** ⇒ 只有它间接拦住了这个变异。）

**④ 影响面**
* §9.3.2 ③ 的核心承诺「**集合相等**，不是条数相等」在仓库里**没有真正的守卫** ⇒ 把实现改成「只比条数」这条缺陷**只有一条间接断言**挡着；
* 这是设计里点名的「**漏召永久存在且无人发现**」那一类；
* ⇒ **上一轮（我的第二轮）我写「§五 集合相等断言 —— 通过」是关于「实现」的正确结论**（我用自己的等条数场景验过，实现确实按集合比）**，
  **但我当时没有质疑「仓库里那条断言的场景是否真的构出了等条数」** ⇒ 这一刀应由 `software-qa-engineer-2` 补上，我确认他们**补对了**。

**⑤ 修法方向（不改生产代码）**
* **最小修法**：在该测试里**先让两侧条数真的相等**，并**加一条前置断言**同时核对**库侧**（例如 `expect(liveCount).toBe(bucketCount)`）⇒ 这样「用条数代替集合」的变异就会红；
* **更稳**：该断言**不依赖夹具的 40 条种子** —— 用一个**独立的小库**（不落种子）来构造「1 vs 1」；
* 派单允许「测试代码若自身有 Bug，你可以修测试并说明」⇒ 但**这条测试不是我写的**，建议由原写者修；若由我代修，须在提交信息里写明「依据 QA 验收报告 Q-01」。

## 🔴 F1 [Major] **路由 = NoOne（补测 / 架构师裁决）**：T08 的「100 万条性能验收」**不可判定**

`docs/baseline/perf-1000000.json` 自己记着：
```json
"failures": ["recall P99 678.119ms > 200ms（样本 10、预热 20）","写入 P99 658.189ms > 5ms（样本 50、预热 20）"]
```
`DEVELOPMENT-PLAN.md` T08 的门槛表：recall P99 ≤ 200ms / 写入 P99 ≤ 5ms / 向量路 P99 ≤ 20ms / 占比 ≤ 20% ⇒ **全部标「硬门槛（不达标 = 架构不成立）」**。

**⇒ 四条门槛在两个规模上的横向对照（这才是可裁决的表）**
（**注**：本表由我在 `software-qa-engineer-2` 的数据线索之上**重算**；其 `p2-adjudication.md` 指出「10k 的 233.64ms 是**单样本离群值**」⇒ **我原先写的「写入 P99 ≤ 5ms 在任何真实库上都不可能达标」这句话过强，已更正**）

| 门槛 | 10k 实测（50 样本） | 1M 实测 | 判定 |
|---|---|---|---|
| recall P99 ≤ **200ms** | min 2.08 / **p50 2.32** / p95 4.66 / max **5.79ms** ✔ | **仅 10 样本**：min 192 / **p50 268** / max **678ms** ✘ | 🔴 **1M 上连 p50 都 > 200ms ⇒ 真实规模效应，不是离群值 ⇒ 需架构师裁决**（口径是否含 FTS5 等非向量开销） |
| 写入 P99 ≤ **5ms** | min 3.33 / **p50 4.49** / p90 6.25 / p95 8.03 / **p99 233.64** ⇒ ⚠️ **p99=max=单个离群样本**（firstWrite 4.58ms 正常） | min 14.9 / **p50 108.37** / p90 220.47 / p95 269.53 / p99 658.19 ⇒ **p50 就 108ms** ⇒ 真实规模效应 | ⚠️ **10k 的「不达标」是离群值 ⇒ 不能据此下结论（需重测）**；🔴 **1M 的不达标是真的** |
| 向量路 P99 ≤ **20ms** | **7ms** ✔ | **13.35ms** ✔ | ✅ 达标 |
| 向量路占总耗时 ≤ **20%** | 63.70% ✘ | **2.17%** ✔ | ✅ **在 1M 达标**（与「规模必须写进验收行」一致 ⇒ 10k 的 ✘ 不算问题） |

⇒ ⇒ **关键结构**：**不达标的全是「百万级的整体 recall / 整体写入」**；
而**分桶本身引入的那部分（向量路 P99、向量路占比）两条全部达标**（13.35ms / 2.17%）⇒
⇒ ⇒ **这不是「分桶没做到位」，而是「200ms / 5ms 这两个数是在「全库开销」上定的，分桶只解决了向量路那一部分」**
⇒ ⇒ **架构师要裁决的是「这两条门槛的口径是否包含 FTS5 索引维护与其它非向量开销」**，而不是「分桶的实现有没有问题」。

**另**：`docs/baseline/` 的 README 列了 **6** 个数据文件，目录里只有 **4** 个 ⇒ 缺 **`agreement-1000000.json`** 与 **`baseline-flat-1000000.json`** ⇒ **百万级吻合率（≥0.98）从未被采到** ⇒「百万级达标」**无据可查**（1 万条是 `overall 1 / worst 1 / missing 0 / extra 0`，完美但只有 1 万条）。
**另**：`phases.trainMs = 7652354`（**2.13 小时**）、`peakRssBytes = 8474386432`（**8.47 GB**）⇒ 远超计划稿「训练 1~3 分钟」「峰值内存 ≥ 3.5GB」的软阈值预期（**耗时超 40~80 倍**），且**未被记进 `failures`** ⇒ 偏差被静默。
**另**：三个 1 万条 JSON 的 `machine` 块里**只有 `freeMemoryBytes` / `usedMemoryBytes` 不同**（`bench/lib/harness.ts` 的 `machineInfo()` 用 `freemem()` 采集 ⇒ **瞬时值**，同一台机器两次运行必然不同）⇒ ⚠️ **更正我原先的写法**：我曾写「三个 P99 互不可比」，**那是过度推断** —— `platform` / `node` / `cpuModel` / `cpuCount` / `totalMemoryBytes` / `benchNow` / 语料规模**全部一致** ⇒ **三个 P99 是可比的**（`software-qa-engineer-2` 指出的，我已独立复算确认：逐字段比对，只有 free/used 不同）。
⇒ **真正的问题降级为 Minor**：`machine` 块**不能整体当机器指纹用**（free/used 每次都变）⇒ `docs/baseline/README.md:40`「没有机器信息的 P99 不可复现、不可比较」这句**需要限定为「硬件标识（cpuModel / cpuCount / totalMemoryBytes / node）」** ⇒ 否则读者会以为「free/used 不同 ⇒ 不是同一台机器 ⇒ P99 不可比」。

**另（严重级：Minor → Major，按 `software-qa-engineer-2` 的更准框架采纳）**：`docs/design/` 下的 4 份 ADR **全是 P1 的**（`adr-p1-conflicts` / `adr-p1-round2` / `adr-p1-t07-decisions` / `adr-p1-t08-gaps`）⇒ **P2 的裁决没有台账落点** ⇒ 而「性能门槛口径」「mergeMemory 的设计缺口」「裁决写哪儿」这几条**都要架构师裁决** ⇒ **连「裁决写到哪里」都没指定** ⇒ `docs/design/DECISIONS.md`（主理人派单把它当权威文档引用）**不存在**。

**另（口径更正，写明以免误读）**：我上面说「1M 上 recall/写入的 p50 就超标」**不是**因为「P99 在 n≤50 时等于 max」这个统计缺陷 —— **即使把 P99 的口径修好，p50 已经超标了** ⇒ **「1M 不达标」是稳健的真实规模效应**。（`software-qa-engineer-2` 在他们自己上一版报告里把「nearest-rank ⇒ n≤50 时 P99==max」当成削弱结论的理由，我同意那是个不准确的框架，并已在此写明更正。）

**修法方向**：① 用**足够样本量**（recall ≥ 1000、write ≥ 200）在**记录的机器**上重测 1M；② 补跑并落盘两份百万级数据；③ 由架构师裁决「recall ≤ 200ms / 写入 ≤ 5ms」的**口径**（是否含非向量开销）；④ 把 10k 的写入 P99 离群值单独记一条（它同时是「两份基线的 P99 都是最大值」这一点的证据）。

## 🟠 F2 [Major] **路由 = NoOne（补文档）**：`docs/DELIVERY.md` 的现状对照表**已过时**且**指向不存在的文件**

| 它写的 | 现状（实测） |
|---|---|
| 「截至 **`95bd5e2`** 的真实状态」 | HEAD = **`4c70582`** |
| 测试「**37 文件 / 764 条**」 | **41 文件 / 809 条** |
| 源码「**43 个 `.ts`**」 | **46 个 `.ts`** |
| 阶段 2「T01~T05 已合并（T06~T08 在做）」 | **T06/T07/T08 全部已合并** |
| 「阶段 2 的进度与欠账见 **`docs/progress/stage2-progress.md`**」 | ⚠️ **该文件不存在** ⇒ **断链** |
| 「本文件将在阶段 2 收官时**全面刷新**」 | 现在**就是**阶段 2 收官 |

## 🟠 F3 [Minor-Major] **路由 = NoOne（统一措辞）**：性能门槛「硬/软」两份文档矛盾
* `DEVELOPMENT-PLAN.md` T08：「**硬门槛（不达标 = 架构不成立）**」
* `docs/baseline/README.md:160`：「性能门槛是**软阈值**（共享机器上是参考线）」⇒ 读者会以为没达标无所谓。**若保留硬门槛，README 不能说软；若改判参考线，必须走设计稿修订。**

## 🟠 F4 [Minor] **路由 = NoOne**：派单引用的 `docs/design/DECISIONS.md` **不存在**
`docs/design/` 只有 `DESIGN-v2.md` / `DESIGN-v2-errata.md` / `DEVELOPMENT-PLAN.md` + 4 份 ADR ⇒ 裁决散在 4 份 ADR，无汇总台账。

## 🟠 F5 [Minor] **路由 = NoOne**：**缺阶段 2 的进度文档**
阶段 1 留了 13 条交接账（`stage0-stage1-progress.md` §七，已随 P2 更新）；**阶段 2 没有对应交接账** ⇒ 阶段 3 接手时看不到「P2 留下了什么、欠了什么」。**我判定为缺**（派单问「有阶段 2 的进度文档吗？我还没写 ⇒ 若你认为缺 ⇒ 报出来」⇒ **缺**）。

---

# 七、变异测试全表（14 条）

| # | 变异点 | 打红了哪条 | 代表性失败原文 | 还原 |
|---|---|---|---|---|
| **M-N** | `bucketAssign.ts` 的 `diffBucketMembership`：**双向集合比较 ⇒ 「先比条数」** | 🟢 **`bucketSync.test.ts` 全绿（12/12）**；只有 `reconcile.test.ts` 红 1 条 | ⇒ **Q-01 假阴性**（= 独立复现 software-qa-engineer-2 的 M3） | ✔ cmp |
| M-A | `write.ts` 追加裸 `INSERT INTO vector_cell_members` | **check:bucket-write** | 「store/write.ts:1197 出现了裸的桶表写入」 | ✔ |
| M-B | `centroids.ts`：`ON CONFLICT DO UPDATE` → **`INSERT OR REPLACE`**（触发级联） | **rebuildBuckets.test.ts（3 红）** | 「删除顺序不可颠倒…」`expected [ false ] to deeply equal [ true ]`；「崩溃恢复…」；「同事务性…」 | ✔ |
| M-C | `reconcile.ts`：`dirtyIds` 加 `...diff.softDeleted` | **reconcile.test.ts（1 红）** | 「软删保留：…对账后它的桶归属仍在（不被删）」`expected 1 to be +0` | ✔ |
| M-D | `ivf.ts` 候选 SQL 去掉 `WHERE vcm.fine_id IN (…)` | **dedupCandidates.test.ts（12 红）** | 「★ 候选 SQL 的执行计划里**没有 SCAN**」等 | ✔ |
| M-E | `index.ts` 导出 `blobToVector` | **export-surface.test.ts（1 红）** | 「导出面里**没有任何 `src/vector/**` 的东西**」 | ✔ |
| M-F | §5 表加一行、默认值 `1e-8` | **check:params** | 「§5 表里有 1 个参数的默认值**无法解析**（不许静默跳过）」 | ✔ |
| M-G | §11.1 豁免清单塞 `qaBogus`、丢两个 | **check:clock** | 「§11.1 列了 `qaBogus`，但代码的 CLOCK_EXEMPT_METHODS 里没有它」等 3 处 | ✔ |
| M-H | 「只重训一次」闸门改 `if (false)` | **rebuildBuckets.test.ts（1 红）** | 「重训后仍不达标 ⇒ 只重训一次 + 记告警放行」`expected true to be false` | ✔ |
| M-I | `index.ts` 多导出一个类 | **export-surface.test.ts（1 红）** | 「导出面里**只有这 5 个类**」 | ✔ |
| M-J | 喂 `checkAgreement()`：分桶 top-20 混入 flat 没有的东西 | **报红** | 「**「不错」被破**：分桶 top-20 里有 3 条不在 flat top-20 里」 | — |
| M-K | 喂：桶候选跑到 flat 候选全集之外 | **报红** | 「**C29 被破**：1 条分桶候选不在 flat 的候选全集里」 | — |
| M-L | 喂：桶内精确性不匹配 | **报红** | 「**「算错」被破**：桶内 top-K 与全量精确扫描不逐位相同」 | — |
| M-M | 喂：吻合率 0.9 | **报红** | 「吻合率 0.900000 < **0.98**」 | — |

⇒ **13/14 条打红；唯一存活的是 M-N，且它证明的是「测试断言自身是假阴性」而不是「实现是错的」。**

**还原核验**：`src/scripts/tests/docs/bench/package.json` ⇒ 与基线快照 `diff -r -q` **全部一致**；主工作树 `git status --porcelain` **为空**，HEAD 仍 `4c70582`。

---

# 八、收官建议

1. **实现与门禁可以收官**：14 次变异只有 1 处存活，而那处是**测试断言的假阴性**，不是实现缺陷。
2. **必做 1（路由 QA）**：修 Q-01 —— 让 `bucketSync.test.ts` 那条断言**真的造出「条数相同」**并**同时核对库侧条数**。
3. **必做 2（路由 NoOne）**：F1 —— 补测百万级（足够样本量）+ 补落两份百万级数据 + 架构师裁决「写入 P99 ≤ 5ms」。
4. **必做 3（路由 NoOne）**：F2 / F5 —— 补 `docs/progress/stage2-progress.md` + 刷 `docs/DELIVERY.md` 到 `4c70582`；F3 统一硬/软措辞；F4 补裁决台账索引。
5. **⑤ 不阻塞**：`mergeMemory` 不在 §6 清单 ⇒ 不导出；在 T07「已知代价」写清「阶段 4 之前宿主拿不到公开 3c 入口」。
6. **建议 P2 状态标为「功能收官 · 性能验收待补测 + 一条测试待修」**。

---

## 附录 · Q-01 的后续：修复**已落地**且**我已独立验证它堵住了洞**（2026-11-01 追加）

`software-qa-engineer-2` 已把 Q-01 的修复落到主工作树（`tests/unit/bucketSync.test.ts` 已修改、**未提交**；`git status` 可见）：
① 先 `DELETE FROM memories WHERE id LIKE 'seed-%'` 清掉 40 条种子 ⇒ ② 加 `expect(liveCount).toBe(1)`（**库侧也核对**）③ 加 `expect(liveCount).toBe(countRows(db, 'vector_cell_members'))`（**两侧条数真的相同**）。

**我独立跑的验证**（他们的修复 + 我的 M-N「条数比较」变异叠在一起）：
```
× ★ 集合相等**不是**「条数相等」：一条漏 + 一条多 ⇒ 条数相同也必须报红 30ms
FAIL  tests/unit/bucketSync.test.ts > … > ★ 集合相等**不是**「条数相等」：一条漏 + 一条多 ⇒ 条数相同也必须报红
AssertionError: expected [] to include 'd2586c4a-1de0-462f-b773-193d3e922d4b'
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 11 passed (12)
```
⇒ ⇒ **修复前**：这条断言 🟢 全绿（恒绿守卫）⇒ **修复后**：同一条变异 🔴 红 ⇒ **洞真的堵上了** ✔
⇒ **带他们的修复跑全量**：`Test Files 41 passed (41) / Tests 809 passed (809)` ⇒ **修复没有破坏别的断言** ✔
⇒ ⇒ **Q-01 已闭环**（待主理人把 `tests/unit/bucketSync.test.ts` 的修改提交）。

---

## 附录二 · 收尾对齐（2026-11-01，与 `software-qa-engineer-2` 对齐后追加）

### 1. ✅ **Q-01 已由 `software-qa-engineer-2` 修复并提交（`720deec`）** ⇒ 本报告的 Q-01 状态改为「**已闭环**」

* 提交：`720deec fix(P2-QA): 修「集合相等 ≠ 条数相等」这条断言的**前提从未成立**（假阴性）`
* **只改测试代码**（`git show --name-only 720deec` ⇒ 仅 `tests/unit/bucketSync.test.ts`）⇒ **生产代码零改动** ✔
* **我独立验证过这个修复**（用提交后的版本，**逐字节一致**）：
  * 修复前：M-N「条数比较」变异 ⇒ `tests/unit/bucketSync.test.ts` **🟢 12/12 全绿**（恒绿守卫）
  * 修复后：**同一条变异 ⇒ 🔴 红**（`AssertionError: expected [] to include '<id>'`）⇒ **洞真的堵上了** ✔
  * 带修复跑全量：**41 文件 / 809 条全绿** ⇒ **没破坏别的断言** ✔
⇒ ⇒ **Q-01 关闭 ⇒ 最终结论的智能路由由「QA」改为「`NoOne`」**（剩余全部是补测 / 补文档 / 裁决口径）。

### 2. 📁 目录约定（避免再撞名）

* **我**只维护 `p2-final-qa1.md`（本文件）⇒ **不再写通用名** `p2-verify.md` / `p2-mutation.md` / `p2-adjudication.md`
* **`software-qa-engineer-2`** 维护 `p2-verify-qa2.md` / `p2-mutation-qa2.md` / `p2-adjudication-qa2.md`（通用名目前是他们那版）

### 3. ⚠️ 环境提醒（会影响任何在 `D:/Git/wt/p2-t01` 跑全量的人）

`D:/Git/wt/p2-t01` 被 **P3 工程师并发占用**（09:24 出现未跟踪的 `src/neuron/coacts.ts`）
⇒ **在该 worktree 里跑全量套件，`tests/unit/coact-guard.test.ts` 会假红**（「`src/` 里还没有任何共激活写入」）⇒ **那是 P3 在写，不是 P2 的问题**。
⇒ **我的变异全部在独立副本 `D:/Git/wt/qa-r3`（含 `bench/`、独立 `node_modules`）上做** ⇒ 不受该并发影响。

### 4. 门禁数据（已对齐新 HEAD `720deec`）

| 项 | 结果 |
|---|---|
| `pnpm run verify`（`D:/Git/repo` main，`720deec`） | **EXIT=0** |
| ├ `biome check .` | ✓ **126 files / 0 error** |
| ├ `vitest run` | ✓ **41 文件 / 809 条** |
| └ 8 条契约脚本 | ✓ 全绿 |
| `pnpm run build` | **EXIT=0**（ESM 219.56 KB / CJS 224.74 KB / DTS 103.71 KB） |
| **主工作树源码** | **零改动**（`git status --porcelain` 为空；`720deec` 是 `software-qa-engineer-2` 提交的**测试**修复） |
| 临时副本 `D:/Git/wt/qa-r3` | 与 main **逐字节一致**（`diff -r -q` 全绿）；14 条变异全部 `cp` 还原 + `cmp` 校验 |

---

## 附录三 · 收到 `software-qa-engineer-2` 的更正（2026-11-01 追加）

### ⚠️ 我的一处结论被更正（严重级下调）

**qa2 的更正**：三个 1 万条 JSON 的 `machine` 块**只有 `freeMemoryBytes` / `usedMemoryBytes` 不同**；
`platform` / `node` / `cpuModel` / `cpuCount` / `totalMemoryBytes` / `benchNow` / 语料规模**全部一致**
⇒ ⇒ **三个 P99 是可比的**；我原先写的「**三个 P99 互不可比**」**是过度推断，已撤回**。

**我独立复算确认了他们的更正**（逐字段比对三个 JSON 的 `machine`）：
```
platform            ★ 全部相同
node                ★ 全部相同
cpuModel            ★ 全部相同
cpuCount            ★ 全部相同
totalMemoryBytes    ★ 全部相同
freeMemoryBytes     ★ 差异: 4638208000 | 5129768960 | 4690395136
usedMemoryBytes     ★ 差异: 12482510848 | 11990949888 | 12430323712
```
且 `bench/lib/harness.ts` 的 `machineInfo()` 用 `freemem()` 采集 ⇒ **瞬时值** ⇒ 同一台机器两次运行必然不同。

⇒ **降级后的正确表述（Minor）**：`machine` 块**不能整体当机器指纹**；**硬件标识**（cpuModel / cpuCount / totalMemoryBytes / node）才是身份，`free/used` 是当次运行的资源余量
⇒ `docs/baseline/README.md:40`「没有机器信息的 P99 不可复现、不可比较」这句话**需要限定为「硬件标识」**。

### ✅ 我采纳他们的两条更强框架

1. **F4（`DECISIONS.md` 不存在）从 Minor 升为 Major**：4 份 ADR **全是 P1 的** ⇒ **P2 的裁决没有台账落点** ⇒ 而「性能门槛口径 / `mergeMemory` 的设计缺口 / 裁决写哪儿」都要架构师裁决 ⇒ **连「裁决写哪儿」都没指定**。
2. **口径框架更正**：「P99 在 n≤50 时 == max」**不是**削弱 1M 不达标的理由 —— **recall 的 p50 = 267.83ms、写入的 p50 = 108.37ms 就已经超标** ⇒ **「1M 不达标」是稳健的真实规模效应**（这一条我与他们的结论一致，且已写进 F1）。

### 📁 文件名约定（双方已达成）

* **我**只维护 `p2-final-qa1.md`（本文件）
* **`software-qa-engineer-2`** 独占维护 `p2-verify-qa2.md` / `p2-mutation-qa2.md` / `p2-adjudication-qa2.md`（通用名 `p2-verify.md` / `p2-mutation.md` / `p2-adjudication.md` 目前是他们那版）
⇒ **互不覆盖** ✔

---

## 附录四 · ⚠️ **我的路由结论被推翻（`NoOne` → `Engineer`）** —— 附我自己的实证

`software-qa-engineer-2` 对我的 `NoOne` 提出了实质异议：**剩余项里有需要改生产代码的** ⇒ 「无人可派」不成立。
⇒ **我复核后采纳**，并**独立跑了实证**。

### ① 规模零强制（`bench/` 全无「规模必须写进验收行」的断言）—— **我实证复现**

`bench/perf.ts` / `bench/agreement.ts` 里 `--scale` 只用于「库路径 / 输出文件名 / 语料条数」，**没有任何断言**要求它是 1,000,000。

**我自己在临时副本上跑（输出重定向，**没碰**仓库的 `docs/baseline/`）**：
```
$ pnpm exec tsx bench/perf.ts --scale=1500 --queries=20 --writes=20 --db=/tmp/qa-probe-1500.db --out=/tmp/qa-probe-perf-1500.json
P99 测量：语料 **1500** 条 / 查询 20 条 / 写入 20 条
  recall P99 = 7.222ms（门槛 200ms，样本 20）
  写入 P99 = 5.456ms（门槛 5ms，样本 20）
  向量路 P99 = 4.446ms（门槛 20ms，样本 20）
  向量路占总耗时 = 42.05%（门槛 ≤ 20%）
⚠ 性能门槛未达标（2 条）：
    写入 P99 5.456ms > 5ms（样本 20、预热 20）
    向量路占总耗时 42.05% > 20%
  ⇒ 这些是**软阈值**（共享机器上的参考线）⇒ 记录实测值，**不判失败**。
PERF_EXIT=0
```
⇒ ⇒ **用 1500 条跑、照样落盘、退出码 0** ⇒ **「规模必须写进验收行（100 万条）」这条设计硬断言在代码里零强制** ⇒ **代码缺口 ⇒ 路由 Engineer** ✔
⇒ **附带一条新的**：`--queries=20 --writes=20` ⇒ **样本量也没有下限** ⇒ 门槛判定的**两个输入（规模、样本量）都是自由的**。

### ② ⚠️ **矛盾在代码里，不只在文档里**（我的 F3 升级）

`bench/perf.ts:283` 的注释与 `:394` 的运行时输出都写死：
> 「⚠️ **这些是「软阈值」**（**§7.1** 把它们列在**软阈值**栏）⇒ …」
> 「⇒ 这些是**软阈值**（共享机器上的参考线）⇒ 记录实测值，**不判失败**。」

而 `DEVELOPMENT-PLAN.md` 的 **T08 门槛表**（行 2035~2052）把**同样这四条**标为「**硬门槛（不达标 = 架构不成立）**」。

⇒ ⇒ **代码按「软阈值」实现、计划稿按「硬门槛」写，且连引用的章节号都不一样（代码说 §7.1、计划稿在 T08）**
⇒ ⇒ 这**不是措辞问题，是行为问题**：现在跑一遍不达标的基线，**退出码是 0**
⇒ ⇒ ⇒ **必须改代码（按硬门槛判失败）或改计划稿（承认是参考线）⇒ 路由 Engineer** ✔
（吻合率那条**没问题**：`bench/agreement.ts:66` 的 0.98 在设计稿里**本来就是软阈值** ⇒ 有争议的只有 perf 的三条 P99 + 占比。）

### ③ 训练读路径的峰值内存（`src/vector/ivf.ts:102-118`）—— **代码问题**

`readVectorMemories()` 先 `.all()` 取回**全部**行（百万级 ⇒ 行数组 ~3.3GB，含 `embedding: Buffer`），
**再**逐行 `blobToVector()` 造出第二个数组（Float32Array ~3.07GB）⇒ **两个大数组同时存活** ⇒ 峰值 ≈ 两者之和
⇒ 这与 `perf-1000000.json` 记录的 `peakRssBytes = 8.47GB`、以及计划稿「训练期峰值内存 ≥ 3.5GB」的预期**量级不符**
⇒ ⇒ **要改生产代码**（流式读取 / 复用缓冲）⇒ **路由 Engineer** ✔

### ④ 我的路由结论的三次修订（如实记录）

| 版本 | 路由 | 依据 | 为什么被改 |
|---|---|---|---|
| 初版 | **`QA`** | Q-01（假阴性断言） | Q-01 已由 qa2 修复（`720deec`）⇒ **该条清零** |
| 二版 | **`NoOne`** | 剩下全是补测 / 补文档 / 裁决口径 | ✗ **错**：我只看了**我自己那 5 条**；**代码级缺口（规模零强制 / 软阈值「不判失败」/ 训练峰值内存）**是 qa2 找到的 ⇒ **「无人可派」不成立** |
| **终版** | **`Engineer`**（+ **架构师** 裁决口径与台账落点） | ①②③ 都需改代码 | — |

⇒ ⇒ **给主理人的最终口径**：
* **路由 `Engineer`**：① `bench/` 加「规模 + 样本量」下限断言；② `bench/perf.ts` 按计划稿改判失败（或计划稿改口径——**这是架构师裁决**）；③ `readVectorMemories` 改流式/复用缓冲；
* **路由 `software-architect-2`**：门槛的**性质**（硬/软）与**口径**（是否含 FTS5 等非向量开销）、P2 裁决台账落点（`docs/design/DECISIONS.md` 不存在且 4 份 ADR 全是 P1 的）；
* **路由 `NoOne`（纯文档/补跑）**：`docs/DELIVERY.md` 刷新 + 断链、补 `docs/progress/stage2-progress.md`、README:40 措辞限定、补跑两份百万级数据。

---

## 附录五 · Q-15（Minor，**措辞经 `software-qa-engineer-2` 纠正后精确化**）+ **「实测 vs 读码推断」标注纪律**

### ① Q-15 [Minor]「向量写入只允许经 `write.ts`」这条纪律**只靠注释维持，机器不守**

**先澄清三个既有事实**（否则会误判成「守卫缺失」—— 我先前给 qa2 的措辞正犯了这个错，已更正）：

| # | 事实 | 位置 |
|---|---|---|
| ① | **写入点守卫已存在**：谁能写 `memories.embedding` 有守卫（扫 `UPDATE memories SET content\|content_hash\|embedding =`） | `tests/unit/merge.test.ts:624`「★ 改写 content / content_hash / embedding 的写入点**只在** store/merge.ts」 |
| ② | **口径守卫已存在**，且它自己就写明是「**唯一**」 | `tests/unit/write.test.ts:1516`「★ 写入路径的向量归一化口径（**唯一**守住「写入口径 = double 域归一化」这条承诺的守卫）」 |
| ③ | **`merge.ts` / `bucketAssign.ts` 不校验 L2 归一化是**刻意的边界**，不是遗漏 | `src/vector/dot.ts:228-231`「⚠️ **本函数只验，不改**：向量是否**已 L2 归一化**由调用方保证…本函数**不代为归一化**（代劳会掩盖调用方的 bug，也会让「后端不做任何再归一化」这条边界失守）」 |

⇒ ⇒ **精确的表述是**：**守卫有两道，但两道都只覆盖「写入口径」这一层**；
`mergeMemory()`（`src/store/merge.ts:331`：`embedding: input.vector === null ? null : vectorToBlob(input.vector)` —— **直接落库、不归一化**）
与 `assignBucket()`（`bucketAssign.ts:147` 只调 `assertValidEmbedding`）**都假定入参已归一化，而这条假定只靠注释维持**。

**后果（成立）**：将来若有人绕过 `write.ts` 直接调这两个内部函数 ⇒ 落库的是未归一化向量 ⇒ **余弦 ≠ 点积** ⇒ 与 `dot.ts` 自己警告的「老库与新库向量不可比 ⇒ 静默劣化」同一类失效。
**但当前所有内部调用方都自洽**（`write.ts:1050` 传的 `vector` 来自 `resolveVector` ⇒ 已归一化）⇒ **不是活 bug，是「纪律没有守卫」的观察项** ⇒ **Minor**。

### ② 结构性观察：**同型的两条纪律，一条有生产侧门禁、一条只在单测里**

```bash
$ grep -rn "SET embedding" scripts/     # ⇒ 0 命中
```
* 「桶归属只允许经 `assignBucket`」⇒ **有生产侧 lint 门禁**（`scripts/check-bucket-write.ts`，挂在 `pnpm run verify` 上 ⇒ **CI 必红**）
* 「向量写入只允许经 `write.ts`」⇒ **只在 `tests/` 里**（`merge.test.ts:624` + `write.test.ts:1516`）⇒ **不在门禁链里**
⇒ ⇒ **覆盖面不对等** ⇒ 建议比照加一条**生产侧**守卫（`scripts/check-vector-write.ts` 或并入 `check-bucket-write.ts`）。

⚠️ **但别照抄那条正则的形状**（这条是 `software-qa-engineer-2` 实测纠正后的结论，我也采纳）：
`check-bucket-write.ts` 的正则是 `/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+vector_cell_members\b/gi`
⇒ 它**在全文上 `exec`**（`\s` 含 `\n`）⇒ **跨行 / 带 WHERE / `INSERT OR REPLACE` 三种形态全部命中** ⇒ **扫描器本身的能力完全足够，不需要改造**。
⇒ **真正的约束是**：那个正则**要求表名紧跟在动词后面**（`UPDATE vector_cell_members`），
而向量写入的形态是 `UPDATE memories SET embedding = …`（**目标不是紧跟动词的那个词**）⇒ ⇒ **照抄那个正则形状会一条都抓不到**
⇒ ⇒ **要做这条门禁，必须换个锚点**（锚在 `SET embedding` 上），而不是改扫描器。
⇒ ⇒ **而且任何「加门禁」的活都必须自带负控**（否则就是下一个恒绿守卫）。

### ③ 📌 新增纪律（采纳 `software-qa-engineer-2` 的提议，并**用在我自己身上**）

> **凡是对「别的模块的行为」下断言（正则强度、扫描口径、边界条件、内存行为），要么自己跑一遍实测，要么明写「据读码推断，未实测」⇒ 别让推断伪装成事实。**

**我这一轮的全部断言按此重新标注**：

| 断言 | 证据类型 |
|---|---|
| 规模零强制（1500 条也能过） | ✅ **实测**（我自己跑了 `--scale=1500`，`PERF_EXIT=0`） |
| `bench/perf.ts` 按「软阈值…不判失败」实现 | ✅ **实测**（同一次运行的输出原文）+ grep 核源码 |
| 三个 10k JSON 的 `machine` 只有 free/used 不同 ⇒ P99 可比 | ✅ **实测**（逐字段比对 + 核 `machineInfo()` 用 `freemem()`） |
| Q-01 假阴性 ⇒ 修复后必红 | ✅ **实测**（变异 + 断言红） |
| 11 条门禁 / 14 条变异 / 导入图无环 / store 层零表名引用 / 五件事各一份实现 | ✅ **实测**（自写脚本） |
| **`readVectorMemories()` 两个大数组同时存活 ⇒ 峰值 ≈ 之和** | ⚠️ **据读码推断，未由我独立测得**（与已记录的 `peakRssBytes = 8.47GB` 同向，但那个数是**别人跑出来的**，不是我测的）⇒ **按 qa2 的纪律标注在此** |
| 写入点守卫 / 口径守卫 / 「只验不改」边界的确切位置与措辞 | ✅ **实测**（grep 定位到行 + 读原文） |
| Q-15 的后果推演（绕过 `write.ts` ⇒ 未归一化向量入库） | ⚠️ **据读码推断**（推演，未构造该场景实测） |

⇒ ⇒ **本轮我自己被抓到两次「推断伪装成事实」**（「三个 P99 互不可比」是错的；「没有同等守卫」是错的）⇒ **两次都是靠对方交叉核对 + 自己复算才抓到的** ⇒ ⇒ 这条纪律**对 QA 自己同样成立**，不是只对工程师。
