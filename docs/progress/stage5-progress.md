# 阶段 5（P5 · 只读查看器与服务集成）进度与交接账

> 时点：2026-11-02（Asia/Shanghai）· 分支 `feat/p5-verify-integrity`（基于 main 的合并点）
> 门禁：`pnpm run verify` **EXIT=0**（**14 段链**）· 测试 **80 文件 / 1,636 条断言**（2026-11-02 收官定稿读数，见 **§九.8**）
> ⚠️ 本文件的 §〇~§二 写于「只有 T06 落地」时，**已被 §九 取代**（§九 记 T01~T05 全量落地与断言判别力审计）。
> ⚠️ **本文件是阶段 5 的交接文档**：读完它应当能直接接手阶段 5 剩下的 T01~T05，不需要回放对话。
>
> ⚠️ **分层纪律（沿用阶段 2/3/4）**：**实测层** = 有落盘数据 / 可复制命令支撑的数字；
> **推断层** = 由实测推出的结论 ⇒ 一律显式标注 ⚠️（推断）。

---

## 〇、一句话状态

> ⚠️ **本节已过期**（写于 T01~T05 尚未开工时）⇒ **现状见 §九**：六个任务**全部落地**。

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

> ⚠️ **本表已过期**（写于 T01~T05 尚未开工时）⇒ **现状见 §九.1**：六个任务**全部落地**。

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
  ⑧ 门禁读数（实测，本块收尾时复跑）：`pnpm run verify` **EXIT=0**（14 段链）
     ⇒ **77 文件 / 1,507 条断言**（基线 72 / 1,330；本轮 T05 自己贡献 **1 文件 / 37 条**）。
     这个 77 / 1,507 是**三个已落地块之和**：T03 = `28f7da1`、T04 = `2a11d2d`、T05 = `2a08417`（+ `21a32e9`）。
     ⚠️ **「谁落的」只能按提交正文核，不能按 git 身份**：本仓库的所有提交是**同一个 git 身份**
     ⇒ 作者名分不出来。可复核的判据是正文：`2a11d2d`（T04）的正文含「环境留痕 / strict-dep-builds /
     os error 1392」三段 ⇒ 由 software-engineer-2 落；T03 的正文没有这类标记 ⇒ **不要在日志里替它归人**。
     其中 `mcp/` 三个文件 `biome check` 零告警；`mcp/tools.test.ts` **37 passed**。
     ⚠️ **过程留痕**（不是「一路绿」）：本轮中途 `verify` 曾两次为红 ——
     一次红在**并行的 T03/T04 在途文件**上（`viewer/renderer/panels/*` 的 biome 格式/导入顺序、
     `tests/integration/viewer-panels-*.test.ts` 的 1 条断言），与本轮 T05 改动无关；
     另一次是 `node_modules` 被清空（隔离验证时误删，已按设计 §2.2 的命令用
     `--frozen-lockfile` + 干净 store 重装恢复，锁文件未变）。⇒ 最终读数以上面这句为准。
     📌 **给下一个人的一条环境事实**（本轮实测，踩了三次）：`pnpm install` 若只报
     `ERR_PNPM_IGNORED_BUILDS`（electron 的构建脚本被忽略，属**预期**），pnpm 会**认定整次安装失败
     而不写 `node_modules/.modules.yaml`** ⇒ 之后**每一个** `pnpm run <script>` 都会在跑之前再自动装一遍
     ⇒ 与别人的 gate 互相把 `.bin` 清掉。处置：加 `--config.strict-dep-builds=false` 重装
     （**不要** `pnpm approve-builds`：那会开始下载 ~100MB 的 Chromium，见设计 §2.2），
     装完以 `node_modules/.modules.yaml` 存在为「真的装好了」的判据。
     ⚠️ 同理，判断依赖是否干净**不要用 `npx biome`**：`node_modules` 为空时 npx 会去 registry
     拉一个同名的无关包（`biome@0.3.3`）并「成功」返回 ⇒ 一律用 `node_modules/.bin/biome check .`。
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
---

## 九、★★ 2026-11-02 · **阶段 5 收官**：T01~T05 全量落地 ＋ 断言判别力审计

> 本节取代 §〇~§二 的状态描述（那三节写于 T01~T05 尚未开工时）。
> **全部读数来自本轮实跑**（`pnpm run verify` / `pnpm run build` / `vitest run mcp/`），不转抄。

### 9.1 六个任务全部落地（提交谱系）

| 任务 | 提交 | 落点 |
|---|---|---|
| **T01** 工程基础设施与依赖轮 | `5729f53` | 6 个 devDependency · `tsconfig` 补 `jsx`+DOM · `vitest` include 补 `mcp/**` · 三个共享契约 |
| **T02** 只读内核 | `8e12a59` | SQL 防护层 · 只读句柄 · worker 隔离 · IPC 8 通道 · preload 桥 |
| **T03** 面板 1/2/3 ＋ 状态层 | `28f7da1` | 四值向量路块 · 覆盖率 · 抑制单列 · 七面板共用的 `StatusBlock`/`useReadCall` |
| **T04** 面板 4/5/6/7 | `2a11d2d` | 图谱 · 只读日志 · 版本历史 · 礁石图 |
| **T05** MCP Server 最小集 | `2a08417` | 10 工具（最小集 6 ＋ 维护类 4）· 结构化错误 · SDK 耦合面收敛 |
| **T06** `verifyIntegrity()` | 前一轮 | 五个字段的唯一实现 |

**之后的补强轮**（不是返工，是验收发现后补齐）：`c265fdd` 交互层 · `1b10d5f` / `a1e244a` / `763343f` 断言判别力 · `16af6e3` / `99df145` 可用性 · `4dbfe92` 协议层覆盖。

### 9.2 五个工程决策的**落地结果**（设计 §2 的裁决，逐条对照代码事实）

| 决策 | 落地结果 | 验证方式 |
|---|---|---|
| **D1 依赖全放 devDependencies** | ✅ `dependencies` 仍**只有** `better-sqlite3` | `dist/` 只有 `index.*`；打包产物**一次都不引用** `react` / `electron` / `modelcontextprotocol`（实测 grep） |
| **D2 用 `react-dom/server` 不引 jsdom** | ✅ `vitest` 的 `environment:'node'` + `pool:'forks'` 未改 | 面板断言全部基于字符串 / markup，不依赖 DOM |
| **D3 `viewer`/`mcp` 进根 tsconfig、不进 tsup** | ✅ `tsup` entry 仍只 `src/index.ts`、`files` 仍 `["dist"]` | 同上 |
| **D4 只有 `viewer/main/index.ts` 允许 import electron** | ⚠️ **实际是 2 个**（`main/index.ts` ＋ `preload/index.ts`）：`contextBridge` / `ipcRenderer` 物理上只能从 electron 拿 | 落成写死白名单（多一个就红）＋「任何测试都不 import 它们」 |
| **D5 Q-P5-03 已裁** | ✅ 见 §五（已改标「已裁」） | — |

**Electron 二进制确认未下载**：`electron.d.ts` 在、`dist/` 与 `path.txt` 不在（有断言钉住）。⚠️ 每次 `pnpm add` 会在末尾打印 `ERR_PNPM_IGNORED_BUILDS: electron@…` —— 那是**预期结果**（构建脚本被忽略），命令本身成功。

### 9.3 ★★ 断言判别力审计（本节最该被接手者读的部分）

阶段 5 的验收标准一共 **60 余条「硬断言」**。交付过程中由一名**只读复核者**逐条判定「这条断言**改坏实现会不会红**」，抓出 **12 处不咬人**，分四类：

| 类型 | 形态 | 实例（补强前的真实形态） |
|---|---|---|
| **① 夹具让两种实现不可区分** | 夹具里两个量恰好相等 ⇒ 读 A 和算 B 渲出同一个值 | 面板 2 的 `effectiveStability` 恒等于 `stability × pinFactor`（25 = 10×2.5）⇒ 把实现改成自己乘照样绿 |
| **② 一条要求被另一条断言顶掉** | 同一段 markup 里另有一处文案顺带满足了断言 | 面板 7「气泡标注占比」的 `60.0%` 被聚合行「最大簇占比 60.0%」满足 ⇒ 删掉气泡占比仍全绿 |
| **③ 函数测了、接线没测** | 纯函数有单测，但组件有没有**用它**没人管 | 「快照对比用成员重叠度不用 `key`」只有纯函数单测；渲染断言用的是**成员完全相同**的夹具 ⇒ 两种实现都渲得出同一个百分比 |
| **④ 层错** | 面板测试去证明库的行为 | 「无 embedder ⇒ `vectorPart` 恒 0」在面板层只能证明「拿到 0 就显示 0」 |

**补强后**（`1b10d5f` / `a1e244a` / `763343f`）的判别力做法，三类各记一条：

- **①**：造**不一致夹具**（`stability=10, pinFactor=2.5, effectiveStability=30`）⇒ 断言页面显示 **30**、且**不含 25**。自己算的实现渲 25 ⇒ 立刻红。
- **②**：绑**单个节点**的 `data-cluster-share="0.6000"` ＋ 断气泡内**那一个文本节点**恰好是「成员 60 条（占全库 60.0%）」，聚合行那句不满足这个绑定。
- **③**：渲一例 **`key` 相同、成员不同**（`['m-1','m-2']` vs `['m-1','m-7']`）⇒ 断「重叠度 50.0%」且不含「100.0%」。

**另有 5 处「只断返回值、不回库看状态」**（T05）：`sweep` 最严重——原来只断「`purgeDeletedDays: 0` ⇒ `purged === 0`」，**一个什么都不做的空实现就能满足**。补强后造两条软删行（40 天 / 1 天前）⇒ `30` 时旧行消失、1 天前那条仍在，并与 `0` 那条成对。

★ **这一节要传下去的一句话**：**门禁绿 ≠ 断言有判别力**。本阶段的断言数从 1,194 涨到 1,636，涨出来的部分里有 12 处起初是咬不动的；它们**一个都不会让门禁变红**。

### 9.4 两条「测试自身会恒绿」的坑（写在这里，因为太容易重犯）

1. **`setRequestHandler` 内部把处理器包成 `Promise.resolve(handler(...))`** ⇒ 「注册进去的函数返回 `Promise`」**永远为真**。要证明「handler 是异步的」，必须拦下**传给 `setRequestHandler` 的原始函数**，一正一反断言（`tools/call` 是 `AsyncFunction`、`tools/list` 不是）。
2. **自己拼字符串再断言含子串**（如 `expect(probe.includes('writeFile')).toBe(true)`）**不经过被测判据**，是恒真。负控必须让**产品代码里同一个判据**去扫那个坏样本。

### 9.5 已知限制（**不是缺陷，是当前口径下做不到的事**）

| # | 限制 | 为什么 |
|---|---|---|
| 1 | 面板 5 无法表达「只选年 = 看整年」 | `LogQuery.month` 在库侧**必填**（按 `logs/<年>/<月>/` 目录读）⇒ 缺省归一到 1 月并**如实显示「1 月」**。把 1 月数据标成「整年」就是界面撒谎 |
| 2 | 面板 6 的「已裁剪」标记未实现 | `content_history` 无该列，裁剪是 P4-T01 的策略选择，**缺数据源** |
| 3 | 面板 6 的两种动作语义是**自定**的 | 「上一页 / 下一页」= 移窗口（替换）、「加载更早的版本」= 累积（追加）；翻页会重置累积。PLAN 未规定 |
| 4 | `runStdioServer()`（3 行薄壳）**无测试覆盖** | 它会抢真实 stdin / stdout，测试里跑等于挂住进程。**不假装覆盖** |
| 5 | 面板 7 的成员展开用 `<details>` | 原生折叠，静态渲染下成员行仍在 markup 里，不引额外状态 |
| 6 | 「点击 ⇒ 发请求」的**端到端**不可测 | `renderToStaticMarkup` 不执行事件处理器，`environment:'node'` 是硬约束 ⇒ 把**提交语义**抽成纯函数 `nextSubmitted` 承担那一段的判别力 |

### 9.6 未达成（与 §六 逐条对应，**本轮仍然一条没还**）

H1（12,782 行 = 门槛 6.39 倍，**沿用阶段 3 读数、本轮未复测**）· H2（1.2782%，未复测）· 矢量路仍未接进 `recall()` · 缺陷① `maxIterations` 不透传 · 缺陷② `ivf.ts:241` 约 200 倍重复扫描 · 缺「只补跑迁移段」入口 · 百万级 perf 未按实测口径重采 · 两个「2,000」命名未分离。

⇒ **一句话**：阶段 5 交付的是「**只读查看器七个面板 ＋ MCP 最小集 ＋ 护栏方法**」，**不是**「性能达标」。

### 9.7 环境事故与处置（**留给下一个人，别重踩**）

| 事故 | 根因 | 处置 |
|---|---|---|
| `node_modules` 被清空 **3 次** | ① 用 `rm -rf` 删 worktree 里的 junction ⇒ **顺着链接删了主仓**；②③ `pnpm install` **只**报 `ERR_PNPM_IGNORED_BUILDS` 时 pnpm 认定整次失败、**不写 `node_modules/.modules.yaml`** ⇒ 之后每个 `pnpm run` 都先自动重装，与并行 gate 互删 `.bin` | 加 `--config.strict-dep-builds=false` 重装；**判据是 `.modules.yaml` 存在**（不是「命令没报错」）。⚠️ **不要** `pnpm approve-builds`（会下载约 100MB Chromium） |
| `D:\.pnpm-store` 文件损坏（`os error 1392`） | 文件系统层面，早于本轮所有工程师 | 换干净 store 重装（`--store-dir`）；**未修根因** ⇒ 建议对 D 盘跑一次 `chkdsk /f` |
| `npx biome` 报 46 条假错 | npm 上有个**同名无关包** `biome@0.3.3` | 只用 `pnpm run lint` 或 `./node_modules/.bin/biome` |
| `pnpm run <script>` 触发依赖预检 | 见上第 2 条 | 跑脚本前缀 `npm_config_verify_deps_before_run=false` |

### 9.8 复验入口（定稿读数，2026-11-02 实跑）

```bash
cd gmb
npm_config_verify_deps_before_run=false pnpm run verify   # 期望 EXIT=0 · 80 文件 / 1,636 断言 · 14 段链
npm_config_verify_deps_before_run=false pnpm run build    # 期望 EXIT=0（dist 只有 index.*）
npx vitest run mcp/                                        # 期望 2 文件 / 63 条（tools 48 + server 15）
```

**规模（实测）**：`src/` 60 个 `.ts` / 21,472 行 · `viewer/` ＋ `mcp/` 33 个文件 / 8,530 行 · `tests/` 92 个 `.ts` / 39,258 行。
**两条文档审计**：档位审计判 121 处 / **真缺 0**；两层次审计**真缺 0**。
