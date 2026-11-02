# 矢量路接线轮（P2-T09~T12）· 交付与遗留

> 时点：2026-11-03（Asia/Shanghai）· 分支 `perf/ivf-single-pass` → PR **#6**
> 门禁：`pnpm run verify` **EXIT=0**（14 段链）· **90 文件 / 1,832 条断言** · `pnpm run build` **EXIT=0**
> 设计：`docs/design/p5-vector-path-design.md`（D1~D9 + §11 实现后读数）· 裁决索引：`DECISIONS.md` 的 **ADR-P5-VEC** · 勘误：`DESIGN-v2-errata.md` **§11**
>
> ⚠️ **本文件取代以下过期陈述**（那几处已同步改掉或加了指针）：
> 「`recall()` 的步骤 2c 整路缺席」「H1/H2 归『向量路接线前必须还』」
> —— 前半句**不再是事实**，后半句的**前提已满足，但门槛仍然红**（见 §四）。

---

## 一、一句话状态

**向量路接通了**：`recall()` 第一次真的会调向量后端，`fromVector` / `cos` / `vectorPart` / `vectorUsed` 第一次可以非零。
**但这不等于「快」**：H1 / H2 两条硬门槛**仍然红**，而且接线**不会**让它们转绿（§三.1）。

## 二、这轮交付了三样东西

| # | 内容 | 性质 |
|---|---|---|
| 1 | **矢量路接进 `recall()`**（P2-T09~T12） | 清偿阶段 2 的 §4.6 步骤 2c 欠账 |
| 2 | `ivf.ts` 细层分组 `O(粗桶数 × N)` → `O(N)` ＋ `maxIterations` 透传 | 性能清理 / 缺陷①② |
| 3 | `pnpm migrate`（`--db` / `--phase a\|b\|all` / `--dry-run`） | 「只补跑迁移段」的运维入口 |

提交：`e8aabf2`（分堆 + 透传）· `7390b66`（迁移入口）· `b6c3307`/`fd75744`（设计与其口径更正）·
`77b1e2d`（T01 端口装配，不接线）· `96568eb`（T02 接线）· `399d1ee`（T03 验收测试）· `57e0cbc`（T04 文档收口）。

## 三、★ 三条会让人读错的「口径」（本轮最贵的产出）

### 3.1 H1 / H2 测的**就是**「接线后召回的向量扫描量」——它从来不是纸面数字

`bench/perf.ts` 里 H1 的取数是 `:364-365` 用**召回探针**（`ROUTER_NPROBE_COARSE=20` / `ROUTER_NPROBE_FINE=50`）构造后端，
`:457-463` 直接调 `backend.search()`（**不经过 `recall()`**），`:471` 收 `candidateRows`。
⇒ 12,782 行这个数**一直代表**「每次带向量的召回会读多少行」，只是**没有任何用户操作会触发它**。

⚠️ **绝不能说「H1 与召回路径无关」。** 唯一正确的说法是两条并行：
- 接线**不改变** H1 的读数（因为 bench 绕过 `recall()`）；
- **但该读数本来就等于接线后召回的向量扫描量** ⇒ **接线不会让 H1 变绿，只会让它第一次测到真东西**。

### 3.2 时间窗与 `ARCHIVE_LINE` 在默认参数下**是同一个边界** ⇒ 它单独不可观测

`coarseGateWindow()`（`scoring.ts:783`）算窗口用的就是 `archiveSpanFactor(ARCHIVE_LINE)`，τ 取 `MAX_STABILITY × MAX_PIN_FACTOR`。
⇒ 窗口边界恰好是「任何记忆最迟衰减到归档线」那一刻 ⇒ **落在窗外的记忆，`intensity` 必然已 ≤ `ARCHIVE_LINE`**。

⇒ 推论：它是**索引友好的预筛**，不是独立的语义闸门。**后果是测试陷阱**：
把 `filter` 换成 `{}`（等于关掉时间窗）**测试仍然可能全绿**（QA 第一版就踩了）。
要测它，必须造 **over-fetch 饱和**形状：`> VECTOR_TOPK × 3 = 60` 条「窗内但已归档」的旧记忆 + 1 条「窗外但很新」的记忆
⇒ 正确实现 `candidates = 1`，绕过时间窗则 `candidates = 0`。

### 3.3 「吻合率 ≥ 0.98」是**数据 + 探针配置**的特定值，不是实现性质

一次实测（3,200 条簇状语料 · 16 簇×200 · 粗 16 / 细 64 · 6 条查询，每档 120 点）：

| 探针（粗/细） | 吻合 |
|---|---|
| 满探针 16/64 | **120/120**（每条 `cos` 也逐位一致） |
| 2/8 | 120/120 |
| 2/4 | **0.958** ← **低于 0.98** |
| 1/2 | 0.725 |

⇒ 能当**实现性质**断言的只有一条：**探针吃满 ⇒ 必须 1.0**。已按此写成断言（另配「探 1/1 时两者必须不同」的反向对照）。
要在生产语料上复现 0.98，需要 200/10,000 中心 + 100 万行 ⇒ 测试里做不到。

## 四、遗留问题清单（**当前未还的全部**）

### A. 性能门槛（两条，仍是红的）

| # | 问题 | 现状 | 为什么没做 | 下一步 |
|---|---|---|---|---|
| **A1** | **H1 候选读取行数 ≤ 2,000** | ❌ 12,782 行 = **6.39 倍**（阶段 3 冷盘档读数，**本轮未复测**） | 接线只是让它「测到真东西」；下界 ≈ 文本 100 + 图谱 100 + 桶内 4,500~12,782 + 回表 60，**本来就在门槛之上** | 只能动 `ROUTER_NPROBE_FINE`（唯一旋钮，伤召回质量）或改「桶内不设 LIMIT」（§4.15.3 的设计裁决 ⇒ 走 ADR） |
| **A2** | **H2 候选行数 ÷ 库规模 ≤ 0.2%** | ❌ 1.2782%（**未复测**） | 与 A1 同源 | 同上 |

### B. 本轮明确没做的功能

| # | 问题 | 现状 | 下一步 |
|---|---|---|---|
| **B1** | **bench 的 `queryEmbedding` 变体 + 百万级重采**（设计 T05 / P2-T13） | ❌ 未做。`bench/perf.ts` 的 `recall()` 循环**仍不传向量** ⇒ 它测的仍是「无向量路的召回」 | 另立一档、**保留 old-path**（替换就永久丢对照组）；重采 26 分钟 / ≥5GB |
| **B2** | `MemoryConfig.embedder` **现算查询向量** | ❌ 不做（设计 §10 第 1 条）。门面「不代劳」 | 与「零影响」直接冲突 ⇒ 必须作为**独立的行为变更**验收 |
| **B3** | **H1/H2 门槛的归口**（设计 **Q8**） | ⏳ **待裁决**。门槛值 2,000 出自写入预算（8/20 探针），实测取数却用召回探针（20/50）⇒ **两者错位** | 要么「两个读数两个门槛」，要么「明确 2,000 只管写入路径」。默认维持现状 |

### C. 已登记的既有缺陷（不是本轮引入，但接线后变得可观测）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **C1** | `flags.resolveVectorBackendState` 与 `stats.resolveVectorBackendMode` 对「显式 `VECTOR_ROUTER='ivf'` + 低于建桶门槛」**答案不同**（前者 `ivf` 强制建桶，后者 `flat_auto`） | `flags.ts:211-219` / `stats.ts:128-134`；两函数均无覆盖 | 召回走 flat（**结果正确、精确**，但慢），而查看器面板 1 的 `flat_auto` 文案会说「未建分桶」——**桶其实建了** |
| **C2** | `vector/flat.ts` 的 `assertBackendConfig` 把维度**硬比** `DEFAULT_PARAMS.EMBED_DIM`（而非 `params.EMBED_DIM`） | `flat.ts` 的 `assertBackendConfig` | 覆盖了 `EMBED_DIM` 的宿主**一旦传 `queryEmbedding` 会抛 `INVALID_USER_INPUT`**（响亮失败，非静默）；不传则完全不受影响 |

### D. 覆盖上的已知空洞（QA 明确列出，未用「应该没问题」糊过去）

| # | 空洞 | 说明 |
|---|---|---|
| **D1** | **生产规模下的 0.98** | 见 §3.3；测试里只能验「探针吃满 ⇒ 1.0」 |
| **D2** | **并发删导致 enrich 查不到行** | `collectVectorCandidates()` 里 `row === undefined ⇒ continue`；只读了代码，**没造场景**（enrich 与 `search()` 之间那条缝） |
| **D3** | **`excludeIds` 的运行时断言** | 只静态确认「召回只传 `timeFloor` / `pinnedTimeFloor`」；没有运行时断言证明它没被误用 |
| **D4** | **接线前 commit 的字节级输出 diff** | 没做；用了替代证据（`v1-equivalence.test.ts` 一字未改且仍绿 + `stage3` 断言只增） |

### E. 环境与运维（与代码无关，但会咬人）

| # | 问题 | 现状 |
|---|---|---|
| **E1** | **`D:\.pnpm-store` 有坏块**（`os error 1392`） | 只绕过了（`--store-dir "D:/WorkBuddyData/.pnpm-store-clean"`），**没修根因** ⇒ 建议 `chkdsk /f D:` |
| **E2** | 装依赖「假失败」 | `pnpm install` 若**只**报 `ERR_PNPM_IGNORED_BUILDS`，pnpm 认定整次失败、**不写 `node_modules/.modules.yaml`** ⇒ 之后每个 `pnpm run` 都先自动重装。判据是 **`.modules.yaml` 存在**，不是「命令没报错」 |
| **E3** | 跑脚本要加前缀 | `npm_config_verify_deps_before_run=false`（否则触发依赖预检 → 撞坏块） |
| **E4** | 工作区垃圾 | `pnpm-store-fresh/`（5,370 个文件，某工程师的临时 store，可删）；已合并的 `feat/p5-verify-integrity` 仍保留 |

## 五、复验入口

```bash
cd gmb
npm_config_verify_deps_before_run=false pnpm run verify   # 期望 EXIT=0 · 90 文件 / 1,832 断言 · 14 段链
npm_config_verify_deps_before_run=false pnpm run build    # 期望 EXIT=0（dist 只有 index.*）
```

**只跑向量路相关的验收**：

```bash
npx vitest run tests/integration/recall-vector-           # 六个文件：path / absent / four-states / nonregression / flat-vs-ivf / ivf-path
npx vitest run tests/unit/vector-query.test.ts tests/unit/vector-port.test.ts
```

## 六、接手须知（四条最容易踩的）

1. **`queryEmbedding` 是向量路唯一的开关。** 不传 ⇒ 整段不执行（`ran=false`），而且**连端口的四态判定都不发生**
   （实测：不传 3 条 SQL / 全表 COUNT 0 次；传了 6 条 / COUNT 1 次）。改这条路径前先读设计 **D2**。
2. **端口每次现场装配、不缓存**（**D1** / **D1-a**）。缓存会让 `route()` 用新探针数、`search()` 用构造时的旧值 ⇒ 桶集分叉且不报错。
   注意实现是「**带向量的**召回才装配」（设计字面写的是「每次」）—— 若你按字面改回无条件装配，D2 的**成本**维度会静默破掉。
3. **`inhibitionTrace` 与 `recall` 共用一个流水线** ⇒ 想让 `baseScore` 与 `Hit.score` 逐位相等，**两边必须传同一条 `queryEmbedding`**（**D8**）。
4. **改向量路相关测试前先读 §3.2**：时间窗在默认参数下与归档线同边界，用「1 条旧 + 1 条新」去测它**会得到一条恒绿断言**。
