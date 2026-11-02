# 阶段 5（P5 · 只读查看器与服务集成）进度与交接账

> 时点：2026-11-02（Asia/Shanghai）· 分支 `feat/p5-verify-integrity`（基于 main 的合并点）
> 门禁：`pnpm run verify` **EXIT=0**（**14 段链**）· 测试 **68 文件 / 1,213 条断言**（实测，2026-11-02 本轮复跑）
> ⚠️ **本文件是阶段 5 的交接文档**：读完它应当能直接接手阶段 5 剩下的 T01~T05，不需要回放对话。
>
> ⚠️ **分层纪律（沿用阶段 2/3/4）**：**实测层** = 有落盘数据 / 可复制命令支撑的数字；
> **推断层** = 由实测推出的结论 ⇒ 一律显式标注 ⚠️（推断）。

---

## 〇、一句话状态

**阶段 5 的六个任务里，只有 P5-T06（`verifyIntegrity()`）落地了。**
T01~T04（Electron 只读查看器的 7 个面板）与 T05（MCP Server）**一行代码都没写**——
不是「做得不够」，而是**没开始**，原因见 §二 的「为什么没做」列。

阶段 4 遗留的**七条未达成**（H1 / H2 / 矢量路未接线 / 两条缺陷 / 缺迁移补跑入口 /
百万级 perf 未重采 / 两个「2,000」未分离）本轮**一条都没还**（见 §六）。

---

## 一、本轮实际发生的事（三件）

| # | 事 | 结果 |
|---|---|---|
| 1 | 三条阶段 3/4 分支的 PR **合并到 main** | ✅ #4 → #2 → #3 依次合入，每个合并点的 CI 均 `success`（见 §1.1） |
| 2 | **P5-T06** 落地（`verifyIntegrity()` 挂门面） | ✅ 新增 19 条断言，门禁全绿（见 §三） |
| 3 | 两个可交付点提交并**推送** | ✅ 分支 `feat/p5-verify-integrity` 已推送，**PR #5** 已开，CI 全绿（见 §1.4） |

> ⚠️ **推送中途有过一段失败**（`github.com:443` 一度不可达，只 `api.github.com` / `codeload` 通），
> 后来网络自行恢复 ⇒ 推送与开 PR 都完成了。**这一段的过程留在 §1.2**（不是「没发生」，
> 而是「发生过、已绕回」）—— 因为它解释了为什么本地曾经重建过 main。

### 1.1 三个 PR 的合并（实测，GitHub REST API 逐个核对）

| 顺序 | PR | head → base | 合并后 main | 合并前 head 的 check-runs |
|---|---|---|---|---|
| 1 | **#4** `fix/storage-media-win-path` | `6552b79` → `main` | `a08c69d` | 构建 success / 门禁 success |
| 2 | **#2** `feat/p3-audit-gate` | `c010720` → `main` | `7942843` | 构建 success / 门禁 success |
| 3 | **#3** `feat/p4-lifecycle` | `17bd96c` → `feat/p3-audit-gate` ⇒ **手工 retarget 到 `main`** | `774e9b8` | 构建 success / 门禁 success |

- **合并方式**：`merge`（**不是** squash），三个 PR 各留一个 merge commit。
- ⚠️ **#3 的 base 需要手工改**：GitHub 在 #2 合入后**不会**自动把 #3 的 base 从
  `feat/p3-audit-gate` 改成 `main`（base 分支仍存在 ⇒ 它保持原样）。本轮用
  `PATCH /pulls/3 {base: main}` 显式 retarget，之后 `mergeable_state` 回到 `clean` 才继续。
  ⇒ **下一个人也会撞这条**：栈式 PR 合完中段，**必须**检查下一段的 base 是不是已经指向 `main`。
- **每个合并点都等 CI**：合 #4 后等 `a08c69d` 的「门禁（verify）」`success` 才合 #2；
  合 #2 后等同理才合 #3。**没有任何一步是「绿着猜」过去的。**

### 1.2 ⚠️ 本地 main 曾经是**重建**的、不是 fetch 下来的（**已消除，留作教训**）

本轮 `git fetch` / `git push` 对 `github.com:443` **持续失败**（`Recv failure: Connection was reset`
→ 后续 `Failed to connect ... after 21s`），但 `api.github.com` 与 `codeload.github.com` 正常
⇒ 只能走 REST API 做合并，**git 传输层拿不到新对象**。

为了让「在 main 上复跑门禁」这件事仍然成立，本地按**同一顺序、同一 merge 方式**重建了 main：

```
3d477d8 (原 main) + 6552b79 → 3cfeee8   ← 对应远端 a08c69d
3cfeee8        + c010720    → 1178b0a   ← 对应远端 7942843
1178b0a        + 17bd96c    → 949e8f7   ← 对应远端 774e9b8
```

⚠️ **commit SHA 不同（本地 merge 的时间戳与服务端不同），但内容已被证明等价**：
本地最终 `HEAD^{tree}` = `01c61b45…`，与 GitHub API 返回的 `774e9b8` 的 `tree.sha` **逐字相同**
（实测，两边都取 `git/commits/<sha>.tree.sha` / `git rev-parse HEAD^{tree}`）。
⇒ §1.3 的读数是在**与 main 内容完全一致**的树上跑出来的。

⇒ ⇒ **⚠️ 这条分叉已经消除**（2026-11-02 同一轮内网络恢复后处理完毕）：
`git fetch origin` 拿到真实的 `origin/main = 774e9b8` ⇒ 把阶段 5 的两个提交
**cherry-pick 到真实 main 上**，`main` 分支 `reset` 回 `origin/main`
⇒ 现在本地 `main` == `origin/main`，**那三个重建的 merge commit 已不在任何分支上**。
⚠️ 证据：重建态与新历史的 `HEAD^{tree}` **逐字相同**（`91ea83f…`）⇒ 搬运**没有改变任何内容**。
⚠️ 搬运时对 `feat/p5-verify-integrity` 用了 `--force-with-lease`（**只覆盖本分支自己刚推的那一版**，
PR 尚未创建、没有别人的提交）⇒ 不违反「不 force push 覆盖他人提交」。

### 1.4 阶段 5 的交付点（实测）

| 项 | 值 |
|---|---|
| 分支 | `feat/p5-verify-integrity`（基于真实 `main` 的 `774e9b8`，**2 个提交**） |
| PR | **#5** https://github.com/yang-bo12138/General_Memory_Bank/pull/5 （base `main`） |
| PR head 的 CI | `7774c6b` 的「门禁（verify）」+「构建（tsup）」**4 个 check-run 全 `success`**（实测） |

### 1.3 main 上的复验读数（实测，2026-11-02 本轮复跑）

| 项 | 读数 |
|---|---|
| `pnpm run verify` | **EXIT=0**（14 段链）· **67 文件 / 1,194 断言** |
| `pnpm run build` | **EXIT=0**（ESM / CJS / d.ts 三产物） |
| 远端 main 的 CI | `774e9b8` 的「门禁（verify）」+「构建（tsup）」均 `success` |

⚠️ 这一段的读数是**合并完成后、在并入阶段 5 的提交之前**的，所以是 67 / 1,194；
阶段 5 的提交进去之后是 **68 / 1,213**（见 §三）。**两个数都对，差的是那次提交。**

---

## 二、六个任务的状态

| # | 任务 | 状态 | 落点 |
|---|---|---|---|
| **P5-T01** | 查看器骨架：只读句柄 / SQL 防护层 / worker 架构 | ❌ **未开始** | — |
| **P5-T02** | 面板 1/2/3：总览 / 记忆列表 / 召回模拟器 | ❌ **未开始** | — |
| **P5-T03** | 面板 4/5/6：图谱 / 只读日志 / 版本历史 | ❌ **未开始** | — |
| **P5-T04** | 面板 7：主题簇导航（礁石图） | ❌ **未开始** | — |
| **P5-T05** | MCP Server 最小集 | ❌ **未开始** | — |
| **P5-T06** | `verifyIntegrity()`：一致性自检 | ✅ **已落地** | `src/store/maintain.ts` · `src/store/MemoryStore.ts` · `tests/integration/verifyIntegrity.test.ts` |

### 为什么 T01~T05 没做（如实记，不当成「已排期」）

| 阻塞 | 具体是什么 |
|---|---|
| **新依赖** | 仓库当前**只有** `better-sqlite3` 一个运行时依赖（`react` / `electron` / `@modelcontextprotocol/sdk` 全无）。T01~T04 要 React + Electron，T05 要 MCP SDK ⇒ 都要动 `package.json` 与 `pnpm-lock.yaml` |
| **本轮网络** | `npm` 源可达（实测 `registry.npmjs.org` HTTP 200），但 **git 传输层被阻断**（§1.2）⇒ 装了依赖也**推不上去**，无法形成可交付点 |
| **验收方式** | T02~T04 的硬断言是**渲染层**断言（面板措辞快照、渲染树里没有写入口控件）⇒ 需要 `react-dom/server` 或 jsdom 渲染测试；这不是「顺手写两条断言」的量级 |
| **没有显示器** | T01 的「全部库调用在 worker」与「renderer 不持有 better-sqlite3」是**可以**在 node 里断言的（静态扫描 + `worker_threads`），但 Electron 主进程那层起不来 |

⇒ ⚠️ **诚实的结论**：T01~T05 属于「**另开一轮、且网络恢复后**」的工作量；
本轮把它们写成「未开始」，**不写成「已完成 60%」**（没写一行就是没写）。

---

## 三、P5-T06 的落地与验收

### 3.1 实现（§6 的签名逐字一致）

```ts
verifyIntegrity(options?: { deep?: boolean }): {
  archivalOrphans: number;
  archivalMismatch: number;
  bucketCoverage: number;
  clusterSnapshotFreshness: number;
  edgesDiffusable: number;
}
```

| 字段 | 实现来源 | 为什么这么取 |
|---|---|---|
| `archivalOrphans` / `archivalMismatch` | 复用 `checkArchivalSchedule()` | ★ §6 要求与 `stats()` **共用同一个实现**（同款先例：`countArchived()`）⇒ 两处都放，护栏①才「常设」 |
| `bucketCoverage` | 复用 `computeBucketCoverage()`（`reconcileBuckets({detectOnly:true}).report.coverage`） | 「已有向量且已入桶的占比」只有一处实现 ⇒ 不写第二份 |
| `clusterSnapshotFreshness` | 直接 `SELECT computed_at FROM cluster_snapshot_meta WHERE id = 1` | ⚠️ **绝不调 `clusters()`**：它会写快照、会触发重算 ⇒ 自检会把被检的表改掉（观察者效应），且只读句柄上直接违规 |
| `edgesDiffusable` | 扫 `edges`，在 JS 里用 `edgeWeight()` 判 `ACTIVATION_DECAY × w / INITIAL_EDGE_WEIGHT ≥ ACTIVATION_MIN` | ⚠️ **不在 SQL 里重写指数**：`EDGE_STABILITY` 一改、SQL 那份不跟着变还不报错 ⇒ 「召回里一条边都不激活，自检却说边很健康」 |

- **纯读**：不写任何表、不记事件。测试用「全表行数 + 内容哈希 + `events` 行数」前后比对来钉住。
- **只读实例上可用**（§7.1：查看器要能看护栏报告）——这正是 P5-T06「常见坑」里点名的那条。
- `rebuildArchivalSchedule()` **不在本轮实现**：它已在阶段 4 落地（含只读守卫与 `sweep/rebuildArchive` 事件），
  本轮只补「护栏③能把护栏②发现的问题修好」这条**跨阶段**断言。

### 3.2 验收标准 → 证据映射（9 条，逐条有测试）

| 验收标准（PLAN §P5-T06） | 测试用例（`tests/integration/verifyIntegrity.test.ts`） |
|---|---|
| `archivalOrphans`/`archivalMismatch` 与 `stats()` 恒等 | ★ 四种状态逐个比对 ＋ 真孤儿计数一致 ＋ 门面与 store 层同值 |
| `verifyIntegrity` 不写任何数据、不产生 events | ★ 纯读：全表行数 + 内容哈希不变，`events` 不新增行 |
| `rebuildArchivalSchedule` 后两项归零 | ★ 护栏③真的能修好护栏②发现的问题 |
| 该调用记一条 `sweep`/`rebuildArchive` 且字段集恰为 `{scanned,repaired}` | ★ 事件断言（§8.4 硬规则 4 的键集） |
| 抽样自检能命中人为改坏的 `archive_at` | ★ 真孤儿命中 ＋ 默认窗口 ~8.6 天的前提自检 |
| `bucketCoverage`：删归属 ⇒ 降；重建后 == 1 | ★ 全量入桶 ⇒ 1；删一条 ⇒ < 1；补齐回 1 ＋ 无向量取 1 |
| `edgesDiffusable`：构造过期边 ⇒ 下降 | ★ 过旧边计数下降／窗口内仍计数（不是「边总数」的别名） ＋ 无边库为 0 |
| `verifyIntegrity` 只读句柄可用 | ★ 只读实例可用且与可写实例同值 |
| `rebuildArchivalSchedule` 只读抛 `READONLY_VIOLATION` | ★ 只读实例上抛 `READONLY_VIOLATION` |

> **测试读数（实测）**：19 条断言。门禁总数 1,194 → **1,213**（+19），文件 67 → **68**（+1）。
> ⚠️ 两个数字**对得上**（不是「看起来差不多」）：新增文件里 `it(` 计数 = 19。

---

## 四、本次的三条裁决（文档未规定 ⇒ 已裁，并在此留痕）

> 依据本轮任务纪律：「若某条验收标准需要文档未规定的决策，记成待定问题、不要自己猜」。
> 下面三条**无法悬空**（不裁就写不出代码），所以裁了，但**每条都写明了「文档原文只说了什么」**。

| # | 问题 | 文档原文 | 本次裁决 | 理由 |
|---|---|---|---|---|
| **D-P5-01** | `options.deep` **检什么**？ | §6 只有 `deep?: boolean` 与一句「深检可能慢，但不阻塞写」 | `deep:true` = 在算完五个字段后**额外**跑 `PRAGMA integrity_check` + `foreign_key_check`，不通过只记一条 warn 日志 | 返回值被 §6 钉成**五个 number** ⇒ 塞进布尔等于改签名；深检的价值在「留痕可查」 |
| **D-P5-02** | `clusterSnapshotFreshness` **从未发布**时返回什么？ | §6 只说「距上次簇发布过了多久」，类型是 `number` | 返回 **`-1`** 作哨兵（`0` 已被「刚刚发布」占用） | 不能返回 `null`（破类型）；不能返回巨大数（读者会当成真值） |
| **D-P5-03** | 门面方法 `verifyIntegrity` 与 `src/tools/verify.ts` 的**同名函数**怎么共存？ | §3.1 归位表把门面那个归阶段 5；阶段 4 那个是恢复 runbook 的工具 | **两个入口都留**，门面那个**不额外具名导出**（只导返回类型 `VerifyIntegrityReport`） | 否则导出面上出现两个 `verifyIntegrity`（同名不同签名）⇒ 调用方必然踩错 |

⚠️ **D-P5-01 的连带保证**：`deep` **不得改变五个字段的口径**（有专门断言：
`deep:false` 与 `deep:true` 的五字段完全相同）——否则「与 `stats()` 恒等」会因开关而破。

---

## 五、★ 待定问题（**没有裁**，需要设计方决定）

| # | 问题 | 现状 | 为什么不自己裁 |
|---|---|---|---|
| **Q-P5-01** | **`rebuildArchivalSchedule` 的签名与 §6 不一致** | §6 写 `rebuildArchivalSchedule(options?: {...batchSize...})`；实现是 `rebuildArchivalSchedule(now?: number)`（阶段 4 落地，已合入 main） | 这是**设计稿与已合入代码的口径冲突**，不是实现细节。改哪一边都会动公开 API：改实现 = 破坏性变更（宿主已可调用）；改文档 = 修改已裁定的 §6。**需要设计方裁**，我不动 |
| **Q-P5-02** | **C37 的钟表豁免清单是否应收 `verifyIntegrity`** | 它需要在「当前时刻」判定边是否过期与快照新鲜度 ⇒ 读了时钟；`check:clock` 当前**绿**（实测），说明它未被判成裸读时钟 | 收进豁免清单 = 改 `CLOCK_EXEMPT_METHODS` 与 §11.1 的名单（两份要对得上）；📌 也可能是「`resolveNow()` 本身就是**被许可的唯一入口**，根本不需要逐方法豁免」。**两种读法都自洽，我不猜** |
| **Q-P5-03** | **T01~T05 的依赖引入要不要单开一个「依赖轮」** | **✅ 已裁**（见 `docs/design/p5-t01-t05-design.md` §2.6 的裁决 D-P5-Q03）。原文保留：现在仓库运行时依赖只有 `better-sqlite3`；一笔加进 react/electron/MCP SDK 会同时改 `package.json` 与锁文件 | 依赖策略（尤其 Electron 是**打包期**依赖还是**运行时**依赖）属架构决策 ⇒ 归架构师（⇒ 已由架构师裁：6 个包全部 `devDependencies`，`dependencies` 仍只有 `better-sqlite3`） |

---

## 六、★ 明确的「未达成」清单（**本轮一条都没还**）

> 与 `docs/progress/stage4-progress.md` §六 **逐条对应**，本轮**没有一条被解决**。
> ⚠️ 这里的数字**沿用阶段 3 的实测读数**（本轮未重采，标「未复测」）。

| # | 项 | 现状 | 归属 |
|---|---|---|---|
| 1 | **H1 候选读取行数 ≤ 2,000** | **仍红**（12,782 行 = 门槛的 **6.39 倍**；⚠️ 该读数来自阶段 3 冷盘档，**本轮未复测**） | 向量路接线前必须还 |
| 2 | **H2 候选行数 ÷ 库规模 ≤ 0.2%** | **仍红**（1.2782%；**本轮未复测**） | 同上 |
| 3 | **矢量路从未在 `recall()` 里跑过** | 未动（`routes.vector.ran` 恒 `false`）⇒ 本轮 `verifyIntegrity().bucketCoverage` 只反映「桶齐不齐」，**不反映「召回用了向量」** | 同上 |
| 4 | **缺陷①：`maxIterations` 不透传** | 未修（本轮 `src/vector/**` 一行未动） | 阶段 5 或专门的性能轮 |
| 5 | **缺陷②：`ivf.ts:241` 约 200 倍重复扫描** | 未修（同上） | 同上 |
| 6 | **「只补跑迁移段」的运维入口** | 未做（归档侧有 `rebuildArchivalSchedule()`；**迁移段**仍缺） | 同上 |
| 7 | **百万级 perf 未按实测口径重采** | 未做（需 ≥5GB 可用内存的时段 ≈26 分钟） | 与 1/2 一起 |
| 8 | **两个「2,000」的命名未分离** | 未做 | 与 1 一起 |

⇒ ⇒ **一句话**：本轮交付的是「**阶段 4 的三个 PR 合进 main** + **阶段 5 的护栏方法（P5-T06）**」，
**不是**「阶段 5 完成」，更**不是**「性能达标」。

---

## 七、本轮更新日志

- **2026-11-02（阶段 5 首块 + 阶段 3/4 合并收尾）**：
  ① 三条分支按 #4 → #2 → #3 合入 main（#3 的 base 需手工 retarget，见 §1.1）；
  ② 新增 `verifyIntegrity()` 五个字段的**唯一实现**（`verifyIntegrityReport()`）与门面薄壳；
  ③ `LANDED_STAGES` 补 5 ⇒ 公开面 **22 → 23**（`MemoryStore.prototype` 与 §3.1 清单的恒等断言继续成立）；
  ④ 新增 `tests/integration/verifyIntegrity.test.ts`（19 条断言）；门禁 14 段全绿；
  ⑤ 测试 **67 文件 / 1,194 断言 → 68 / 1,213**（实测）；`src/` **60 个 `.ts` / 21,472 行**（实测，不含测试）。
  ⚠️ **未做**：T01~T05（查看器与 MCP，见 §二）；阶段 4 §六 的八条（见 §六）。

- **2026-11-02（阶段 5 · T05：MCP Server 最小集）**：
  ① 新增 `mcp/tools.ts`：`TOOL_DEFINITIONS`（**10 个工具 = 最小集 6 + 维护类 4**）+ 纯函数
     `dispatchTool()` + 入参校验器（JSON Schema 的执行层，`additionalProperties: false` **真的会拒未知键**）。
     ★ **不 import MCP 官方 SDK**：`mcp/server.ts` 是**唯一**一处（由 `mcp/tools.test.ts` 扫
     `src/**` + `mcp/**` 全树断言「命中文件恰好只有 `mcp/server.ts`」）。
  ② 新增 `mcp/server.ts`（薄适配）：低层 `Server` + `tools/list` / `tools/call` 两个处理器。
     **异步只在这一层**（库仍是全同步 API，`dispatchTool()` 返回值不是 Promise，有断言钉住）；
     错误以 `{ code, message, details }` 的 `isError: true` 内容返回（§11.2，不是裸文本）。
  ③ 三个**阻塞 1~3 分钟**的维护方法（`rebuildArchivalSchedule` / `rebuildVectorBuckets` / `recluster`）
     **不暴露**；且 `assertNoBlockedMaintenance()` 在**模块初始化时就跑**
     ⇒ 谁把它加回工具表，`import` 那一刻就抛错（不是「跑起来才发现」）。
  ④ `sweep` 按终裁（设计 §9.2 的 **N-07**）**暴露**，且 `purgeDeletedDays` 与 `vacuum` 两个键**都进 `required`**
     （本层不给任何默认值）；`clusters` **不暴露**（它是读方法，但首调会现场重算几百毫秒 ⇒ 归查看器面板 7）。
     五个维护类方法的逐个裁决与理由写在 `mcp/tools.ts` 顶部的决策块。
  ⑤ 三条默认值纪律都配了「正向 + 反向」成对断言：`recall.explain` 默认关（不写 `recall` 事件，
     显式 `true` 恰好 +1 条）；`forget.hard` 默认 `false`（软删：`deleted=1`、`deleted_at` 非空、**行仍在**，
     `hard:true` 才删行）；`recall` **没有** `source` 过滤。
  ⑥ `touch.coActivateWith` 超 `COACT_BATCH_MAX`（256）⇒ `INVALID_INPUT`，且 `details.reason` 是**库**写的
     `coact_batch_max` ⇒ 证明 MCP 层没吞错、没截断（边界 256 条不抛，成对）。
  ⑦ 新增 `mcp/tools.test.ts`（**37 条断言**；`vitest.config.ts` 的 `include` 已含 `mcp/**/*.test.ts`，
     本文件同时断言这条 glob 在场 ⇒ 不是「没被收集还不报错」）。
     其中 7 条做过**变异验证**：把 `explain` 默认改成开 / 把 `hard` 默认改成真 / 去掉一条
     `additionalProperties: false` / 把阻塞守卫改成空实现 / 把 `coActivateWith` 截断成 100 条
     ⇒ **各自都会把断言打红**（判别力已实测，不是恒绿守卫）。
  ⑧ 门禁读数（实测）：`typecheck` 绿；`biome check .` 下 **`mcp/` 三个文件零告警**；
     10 个 `check:*` 与 `audit:*` 段全绿；`mcp/tools.test.ts` **37 passed**。
     ⚠️ **全链 `pnpm run verify` 此刻不是 EXIT=0**，红点在**并行的 T03/T04 在途文件**上
     （`viewer/renderer/panels/LogViewer.tsx` / `GraphView.tsx` 的 biome 格式与导入顺序，
     以及 `tests/integration/viewer-panels-structure.test.ts` 的 1 条断言），
     与本轮 T05 的改动无关（已当场告知 T03/T04 的工程师修）。
  ⚠️ **未做**：`stats` / `get` / `inhibitionTrace` 等读工具的暴露、HTTP/SSE 传输、
     `sweep` 之外的维护面（理由逐个写在 `mcp/tools.ts` 的决策块 ③）。
  ⚠️ 本文件**头部**那句「68 文件 / 1,213 条断言」是上一轮的读数，本轮**没有改**
     （避免与并行任务抢同一行；以本条与 §八 的复验入口为准）。

---

## 八、复验入口（别人想自己确认时，跑这三条就够）

```bash
cd gmb
pnpm run verify        # 期望 EXIT=0 且 Tests 1213 passed（14 段链）
pnpm run build         # 期望 EXIT=0（ESM / CJS / d.ts）
npx vitest run tests/integration/verifyIntegrity.test.ts   # 期望 19 passed
```
