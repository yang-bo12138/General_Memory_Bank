# 阶段 0（P0）独立复核报告 · 通用记忆库 v2.1（记忆海版）

> **复核人**：QA（严过关）
> **复核时点**：2026-10-31 约 10:40（Asia/Shanghai）
> **基线 commit**：`a1cf013`（`main`，分支 `HEAD`）
> **复核方式**：**独立实测**——复跑门禁、在隔离沙箱里做**破坏性负控**、静态审查全部门禁脚本。
> ⚠️ **本报告不引用上一轮报告的结论当结论**；上一轮报告（`docs/quality/stage0-verification.md`）
> 只被用来做「结论一致性抽查」。

---

## 一、结论

### 1.1 总体判定

| 项 | 判定 |
| --- | --- |
| **门禁（`pnpm run verify`）** | ✅ **PASS**（退出码 0，9 段全绿） |
| **P0 交付状态** | ✅ **PASS_WITH_FINDINGS**（功能层面无缺陷；有 3 条需修 + 6 条可选的文档/覆盖问题） |
| **智能路由判定** | 🟡 **Engineer**（有 2 条必须由开发线改 `src/` / `scripts/`；1 条属 QA 自修范围） |

**一句话**：**P0 的「机械门禁」部分是可信的**——6 条门禁脚本我逐个做了破坏性负控，
全部能「因为目标原因而失败」，且**上一轮踩过的三个同族缺陷（CRLF 抽取失配 / npm script 名拼文件名 /
守卫只断言「文件存在」）确认都已修好**；**但 P0 的「文档一致性」部分有 3 处真实缺口**，
其中 1 处是 C25 级漂移（同一规则在几处描述、值不一致），会让 P1 实现者读到过期的参数构成口径。

### 1.2 智能路由判定明细

| 路由对象 | 判定 | 说明 |
| --- | --- | --- |
| `src/` 实现代码（运行时行为） | **NoOne** | 263 条测试全绿；负控证明每条关键不变量都有测试守着；未发现任何运行时缺陷 |
| `src/core/params.ts` 的注释 + `DEVELOPMENT-PLAN.md` P0-T02 段 | **Engineer** | C25 级漂移（见 F-01），**必须修** |
| `scripts/` 门禁覆盖面 | **Engineer** | §8.4「六条硬规则」的条数未进 `verify` 链（见 F-03），**应该修** |
| `tests/contracts/clock.test.ts` 覆盖 | **QA（我）** | `resolveNow(0)` 未被守住（见 F-02），属测试侧缺口，下一轮由 QA 补 |
| `docs/` / `scripts/README.md` 措辞 | **Engineer（可选）** | 6 处文档不一致（F-04 ~ F-06），不阻塞 P1 |

### 1.3 「P0 是否真的有问题」的明确回答

**运行时行为层面：没有。** 6 条门禁脚本的判据都真实有效，14 个测试文件 / 263 条测试覆盖了
P0 的全部硬断言，且我做的 22 组破坏性负控（含 10 组文档变异、6 组代码变异、6 组实现变异）
**全部按预期报红**。

**但 P0 仍有 3 条真问题**（都不影响运行时，影响的是「P1 实现者会不会被误导」和「CI 守不守得住」）：

1. **F-01（必须修）** `DEVELOPMENT-PLAN.md:230` 与 `src/core/params.ts:46-55` 仍用**勘误 ② 之前**的
   参数分类轴（性能参数 = 10 项），文中写「合计 60」但**它自己的数字相加是 61**。
   设计权威 `DESIGN-v2.md:3515` 早已改成「向量路阈值 1 项 = 9」。
   ⇒ **C25 违规**（同一规则在几处描述、值是否一致），且**没有任何门禁脚本能发现**
   （`check-doc-counts.ts` 只读 `DESIGN-v2.md`）。
2. **F-02（应该修，QA 自修）** `resolveNow(0)` **没有测试守着**：把 `src/core/clock.ts` 的
   `now ?? Date.now()` 改成 `now || Date.now()`，**整个测试套件依然全绿**。
   而 `resolveNow` 是 `decay.ts` / `stability.ts` / `store/link.ts` 的**实际调用点**。
3. **F-03（应该修）** §8.4 的**硬规则条数（6 条）**只被 `scripts/verify_errata_writeback.py` 断言，
   而该脚本**不在 `verify` 链里** ⇒ CI 不守。

---

## 二、门禁实测表

### 2.1 主门禁（实测，非引用）

| 项 | 实测值 | 判据 | 判定 |
| --- | --- | --- | --- |
| 入口命令 | `pnpm run verify` | **不是** `pnpm ci` / `npm ci` | ✅ |
| **退出码** | **0** | == 0 | ✅ |
| vitest **收集的文件数** | **14** | == 仓库 `*.test.ts` 清单数 **14**（`find src tests -name "*.test.ts" \| wc -l`） | ✅ |
| vitest **测试条数** | **263 passed / 0 failed** | 全部 passed | ✅ |
| `Errors N errors` 行 | **0 条**（`grep -c Errors` = 0） | 无 | ✅ |
| typecheck | `tsc --noEmit` 零错误 | 零错误 | ✅ |
| lint | `biome check .` → `Checked 57 files. No fixes applied.` | 零错误 | ✅ |

> ⚠️ **采信判据是语义判据，不是写死的数字。**
> 本报告**不**写死「263」当期望值；期望值 =「本次收集数 == 仓库 `*.test.ts` 清单数（按仓库清单求）」。
> 加一条测试 ⇒ 条数漂移 ⇒ 期望值随之漂移 ⇒ 不会假绿/假红（C31）。

### 2.2 `verify` 链 9 段逐段结果

| # | 段 | 命令 | 退出码 | 输出要点 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | typecheck | `tsc --noEmit` | 0 | 无输出 | ✅ |
| 2 | lint | `biome check .` | 0 | `Checked 57 files in 79ms. No fixes applied.` | ✅ |
| 3 | test | `vitest run` | 0 | `Test Files 14 passed (14)` / `Tests 263 passed (263)` | ✅ |
| 4 | check:params | `tsx scripts/check-params.ts` | 0 | `§5 解析出的参数条数：60` / `DEFAULT_PARAMS 的键数：60` / `✓ §5 表与 DEFAULT_PARAMS 逐键逐值相等` | ✅ |
| 5 | check:payload-keys | `tsx scripts/check-payload-keys.ts` | 0 | `§8.4 解析出的 type 数：13` / `✓ §8.4 的 payload 键集与代码逐键一致` | ✅ |
| 6 | check:clock | `tsx scripts/check-clock.ts` | 0 | `命中时钟读取的文件数：1（期望 1）` / `命中点数：1（期望 1）` / `src/core/clock.ts:57 Date.now() resolveNow` | ✅ |
| 7 | check:anchor | `tsx scripts/check-anchor.ts` | 0 | `✓ 跨节锚定清单：5 行 × 3 列，且与写死的期望一致` | ✅ |
| 8 | check:contract-ids | `tsx scripts/check-contract-ids.ts` | 0 | `✓ 契约编号与引用数字全部一致`（内含门禁入口守卫 `check-gate-entry`） | ✅ |
| 9 | check:doc-counts | `tsx scripts/check-doc-counts.ts` | 0 | `✓ §5 分类声明与 §8.1 的参数计数与代码一致（60 项）` | ✅ |

**形状核对**：`scripts.ci` **恰为** `pnpm run verify`；`scripts.verify` **恰好 9 段**，
逐名齐全且每段都写成 `pnpm run <名>`（由 `check-gate-entry.ts` 机器强制，负控见 §四）。

---

## 三、P0 验收标准逐条复核表

> 断言来源 = `docs/design/DEVELOPMENT-PLAN.md` 阶段 0 段（P0-T01 ~ P0-T07 + 勘误 A6/A7/设计稿回写）
> 与阶段总览表的阶段 0 行。判定只依据**代码与测试的实测**，不依据上一轮报告的自述。

### 3.1 P0-T01 · 工程基线与项目脚手架

| # | 断言 | 守护测试 / 门禁 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `tsc --noEmit` 零错误 | `pnpm run typecheck` | ✅ | 实测退出码 0 |
| 2 | `npm test` 在空测试套件下退出码 0 | `vitest run` | ✅ | 14 文件 / 263 条全通过 |
| 3 | smoke test 断言 `SELECT count(*) FROM mem_fts` 与 `memories` 行数一致 | `tests/unit/smoke.fts5.test.ts` | ✅ | 该文件存在且在 14 个收集文件内 |
| 4 | vitest 必须 `pool: 'forks'`（better-sqlite3 原生模块） | `vitest.config.ts:13` | ✅ | 源码内硬编码，附注释说明「本地过、CI 挂」的坑 |
| 5 | `tsconfig` 开 `exactOptionalPropertyTypes` | `tsconfig.json` | ✅ | 已开启（见 `tsconfig.json`） |
| 6 | `.npmrc` / `.gitignore` / `biome.json` 就位 | 仓库文件 | ✅ | 均存在 |

### 3.2 P0-T02 · 参数表与跨参数校验（60 项 / 8 条）

| # | 断言 | 守护测试 / 门禁 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | **§5 表 ↔ `DEFAULT_PARAMS` 逐键逐值相等**（G26） | `scripts/check-params.ts` + `src/core/params.test.ts` | ✅ | 门禁实测 `§5 解析出 60 / 键数 60 / 逐键逐值相等`；**负控 NC-01/02/03 全部 exit=1** |
| 2 | **`DEFAULT_PARAMS` 恰好 60 项** | `src/core/params.test.ts:117` + `check-params.ts:138` | ✅ | 负控：删 `MAX_PIN_FACTOR` ⇒ `expected […] to have a length of 60 but got 59`（NC-T2） |
| 3 | **8 条跨参数校验逐条有单测** | `src/core/params.test.ts:155-228`（8 个 `it`） | ✅ | 逐条存在；**负控 NC-T3**：把第 2 条 `>` 改成 `>=` ⇒ 报红 `expected undefined to be an instance of MemoryError` |
| 4 | 校验失败 ⇒ 抛 `INVALID_INPUT` ⇒ **库内参数一个都没变** | `src/store/params.test.ts:71` | ✅ | 用例存在（零写入、零事件） |
| 5 | `setParams({EMBED_DIM:1024})` ⇒ `INVALID_INPUT`，参数未变 | `src/core/params.test.ts:280` + `src/store/params.test.ts:83` | ✅ | 两处都守 |
| 6 | `setParams({REDUNDANCY_COS:0.95})` ⇒ `details.REDUNDANCY_COS.maxAllowed === 0.92` | `src/core/params.test.ts`（第 1 条用例） | ✅ | 规则 1 的用例存在 |
| 7 | 成功后**恰好一条** `events(type='config')`，payload 含 `SCHEMA_VERSION` 与**完整** `params` | `src/store/params.test.ts:96` + `:122` | ✅ | 含「连续两次变更 ⇒ 恰好两条」 |
| 8 | `VECTOR_OVERFETCH_FACTOR` 硬编码 3、不开放为参数（C26） | `scripts/check-contract-ids.ts:374-381` | ✅ | **负控 NC-06**：删「硬编码 3」⇒ exit=1 |
| 9 | 校验失败时 `details` 带**建议值**，同一键多条违反取**最严**的界 | `src/core/params.test.ts:231`（★ 建议值取最严的界） | ✅ | 用例存在 |
| 10 | 刻意**不**加的两条联动校验不得被「顺手」加上 | `src/core/params.test.ts:268,272` | ✅ | 两个 `it` 都在 |
| 11 | `EMBED_DIM` 读-only：类型上 `Omit` + 运行期再兜一道 | `src/core/params.ts:157-160,550` | ✅ | 两层都有 |
| 12 | 5 个机制开关的大小写（前三个小写 / 后两个大写） | `src/core/params.test.ts:132` | ✅ | 用例存在 |

### 3.3 P0-T03 · 五个机制开关与基线不变量骨架

| # | 断言 | 守护测试 / 门禁 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 四个布尔开关 + 三值选择器共 5 个 | `src/core/flags.ts:20-25,55-88` + `src/core/flags.test.ts` | ✅ | `BOOLEAN_FLAG_KEYS` 4 个 + `VECTOR_ROUTER` 1 个 |
| 2 | 开关**每次调用时**读（运行时可切换，不在 `open()` 快照） | `src/core/flags.ts:98-106`（纯函数 `resolveFlags(params)`） | ✅ | 纯函数，无快照概念 |
| 3 | `VECTOR_ROUTER` 三值合法、第四个非法 | `src/core/params.test.ts:295` | ✅ | 用例存在 |
| 4 | **基线条件 = 四布尔全关 + `VECTOR_ROUTER='flat'`**（`'auto'` 不构成） | `src/core/flags.ts:114-137` + `tests/baseline/baseline.test.ts:82` | ✅ | `isBaselineConfig` 逐名比对 5 个开关 |
| 5 | `ARCHIVAL_CACHE` **必须**纳入基线组（路径不同） | `src/core/flags.ts:111-119`（`BASELINE_FLAGS.ARCHIVAL_CACHE === false`） | ✅ | 源码注释明写理由 |
| 6 | golden 采集器 / 比对器可运行 | `tests/baseline/baseline.test.ts:60,73` | ✅ | 采集器产出 5 条观测记录 |
| 7 | ★ 基线组 vs 单开一个开关 ⇒ `write/recall/touch/get/stats` **逐位相同** | `tests/baseline/baseline.test.ts:82` | ✅ | 用例存在 |
| 8 | ★ **比对器能发现差异**（否则上条是假绿） | `tests/baseline/baseline.test.ts:109,124` | ✅ | 两条负控（发现差异 / 发现条数不一致）都在 |
| 9 | 本阶段只建**骨架**，真正的「与 v1.0 逐位一致」在 P1-T09 末 | `tests/baseline/compare.ts` 文件头 | ✅ | 措辞与计划一致（未虚报达成） |

### 3.4 P0-T04 · 事件流扩展（扩 payload 键，不新增 type）

| # | 断言 | 守护测试 / 门禁 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `events.type` **恰好** 13 种 | `src/core/events.types.ts:19-33` + `tests/contracts/scripts.test.ts:145` | ✅ | `EVENT_TYPES` 13 项；门禁 `§8.4 解析出的 type 数：13` |
| 2 | touch payload **5 个新键**齐备（`coactPairs` / `coactPairsTruncated` / `activationWrites` / `coactSkipped` / `stabilityDelta`） | `src/core/events.types.ts:364-377` + `scripts/check-payload-keys.ts` | ✅ | **负控 NC-04**（改 §8.4 一个键名）⇒ exit=1；**负控 NC-T6**（删代码里的 `coactSkipped`）⇒ exit=1 并点名 `touch` |
| 3 | 4 个键只在 `explicit` 发射点出现，`exact_repeat` 不出现 | `EVENT_PAYLOAD_VARIANTS.touch`（`touch_explicit` vs `touch_exact_repeat`） | ✅ | 两套字段集分列；门禁的 `compareVariants()` 校验并集 |
| 4 | `stabilityDelta` **两个发射点都有**、未增长时为 0、键恒在 | `EVENT_PAYLOAD_VARIANTS.touch.*` 均含 `stabilityDelta` | ✅ | 两套都含 |
| 5 | `merge` 分两套字段集：`restore_merge` **刻意少四项** | `EVENT_PAYLOAD_VARIANTS.merge.restore_merge` | ✅ | 子集只有 4 键 |
| 6 | `appendEvent` 的 `memory_id` **必传**（值可 `null`）⇒ 编译期可检 | `src/store/events.ts:109`（签名必传） | ✅ | **负控 NC-T7**：改成可选 ⇒ `tsc --noEmit` 报 `error TS2554: Expected 2-3 arguments, but got 4.`（4 处） |
| 7 | 只读句柄上 `appendEvent` ⇒ **不抛错、不写库、记一条 warn 日志** | `src/store/events.ts:124-130` | ✅ | 判断收在 `appendEvent()` 内部 |
| 8 | §8.2：正文只在 `contentText` 一个键，仅 3 类可写 | `src/store/events.ts:64-72`（`allowsContentText`） | ✅ | `TYPES_ALLOWING_CONTENT_TEXT` = 3 类 |

### 3.5 P0-T05 · 错误类型体系与时钟注入契约

| # | 断言 | 守护测试 / 门禁 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | **五个错误码都存在** | `tests/contracts/clock.test.ts:87` | ✅ | `toEqual([...5 个])` — **集合相等**，第 6 个码会红 |
| 2 | ★ **`MemoryError.code` 是封闭五码，没有第六个码** | 同上 + `src/core/errors.ts:21-35`（`as const` + 联合类型） | ✅ | **负控 NC-T4**：加第 6 个码 `TIMEOUT` ⇒ `expected […(4)] to deeply equal […(3)]` ⇒ 红 |
| 3 | `details` 结构符合 §11.2 | `tests/contracts/clock.test.ts:105` | ✅ | `ConflictDetails` 在**类型层**强制至少带一个冲突标识 |
| 4 | 写接口抛 `NOT_FOUND`、读接口返回 `null`（边界一眼看完） | `tests/contracts/clock.test.ts:97` + `src/core/errors.ts:111-130` | ✅ | `METHODS_RETURNING_NULL` = `['get']` |
| 5 | `CONFLICT` 的方法必须带 `details.conflictingId` | `tests/contracts/clock.test.ts:105` | ✅ | 编译期 + 运行期双守 |
| 6 | 只读实例抛 `READONLY_VIOLATION` 的方法**恰好 16 个**（逐名） | `src/core/errors.ts:152-169` + `scripts/check-contract-ids.ts:113-130` | ✅ | 逐名比对（非计数）；**负控 NC-07**：把 `sweep` 换成 `sweepX` ⇒ 逐名比对抓出 |
| 7 | `ALIAS_CONFLICT` **刻意不是异常**（走 `warnings`） | `tests/contracts/clock.test.ts:116` + `scripts/check-contract-ids.ts:138` | ✅ | 既不在任何抛错分组里，也在 `WARNING_ONLY_CASES` 里 |
| 8 | 裸 SQLite 错误码不得穿给调用方 | `src/core/errors.ts:268-314` + `tests/contracts/clock.test.ts:129,139,144,182` | ✅ | 含 **真实 SQLite 的 FK 违规**可达性测试（非死代码） |
| 9 | ★ **C37：`src/` 下除 `src/core/clock.ts` 外没有第二处 `Date.now()`** | `scripts/check-clock.ts`（分母写死：`EXPECTED_CLOCK_READ_FILES=1` / `EXPECTED_CLOCK_READ_SITES=1`） | ✅ | 实测命中 1 文件 / 1 点；**负控 NC-C37-1**（加一处）⇒ exit=1 并点名 `src/core/params.ts:283`；**NC-C37-2**（删掉 clock.ts 那处）⇒ `命中点数：0（期望 1）` exit=1 |
| 10 | C37 白名单长度**独立写死**（不由白名单长度派生） | `scripts/check-clock.ts:47,502-509` | ✅ | **负控 NC-C37-3**：白名单加一项不改期望值 ⇒ `白名单长度 2 ≠ 期望 1` ⇒ 红 |
| 11 | §11.1 豁免清单 6 个方法**确实不含** `now?`，且有理由 | `tests/contracts/clock.test.ts:58,68` | ✅ | 注入集与豁免集**不相交**也有断言 |
| 12 | `get()` 对不存在 id 返回 `null`（不抛） | `src/core/errors.ts:130`（契约声明） | ⚠️ **本阶段不适用** | 属 P1-T09 的实现；阶段 0 只有契约声明。**不判失败** |

### 3.6 P0-T06 · CI 契约断言脚本骨架

| # | 断言 | 守护测试 / 门禁 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `npm run ci` 串起全部脚本，任一失败 ⇒ 退出码非 0 | `package.json` + `scripts/check-gate-entry.ts` | ✅ | `ci` = `pnpm run verify`；链 9 段 |
| 2 | 门禁入口**形状**：`ci` 恰为别名、链恰好 9 段、名字逐名齐全 | `scripts/check-gate-entry.ts` | ✅ | **负控 NC-G1~NC-G6** 全部 exit=1（见 §四） |
| 3 | 每条 C25~C37 中可机械检查的项都有脚本或单测 + README 登记对照表 | `scripts/README.md` §C25~C37 对照表 | ✅ | 对照表在（C25/C26/C30/C31/C32/C33/C34/C35/C36/C37 全登记） |
| 4 | 故意破坏一处（改一个参数默认值）⇒ `check-params.ts` 失败并**指出是哪个键** | `tests/contracts/scripts.test.ts:126` + **我的负控 NC-01** | ✅ | 负控输出点名 `MAX_STABILITY` |
| 5 | 跨节锚定表 **5 行 × 3 列**，路径写死为常量 | `scripts/check-anchor.ts:40-66` | ✅ | **负控 NC-08（错列）/ NC-09（少行）** 全部 exit=1 |
| 6 | §5 的 8 条 ↔ §12 引用 ↔ 代码条数三方一致 | `scripts/check-contract-ids.ts:315-342` | ✅ | **负控 NC-05**：把 §12 的「8 条」改成「9 条」⇒ `§12 引用的条数 9 ≠ 代码里的 8` ⇒ 红 |
| 7 | 门禁脚本的条数纪律：期望值外部写死，不是「本次实际命中几个」 | `check-clock.ts` / `check-gate-entry.ts` / `check-params.ts` 三处均写死 | ✅ | 负控 NC-C37-2 / NC-C37-3 / NC-10 全部证明 |

### 3.7 P0-T07 · 收尾（门禁可见性 + 脚本补强）+ 勘误 A6 / A7 / 设计稿回写

| # | 断言 | 守护测试 / 门禁 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 门禁入口可见性（防「假绿闸门」） | `scripts/check-gate-entry.ts`（内联进 `check-contract-ids` ⇒ 每跑一次 `verify` 都验一遍） | ✅ | 实测 `✓ 门禁入口可见` |
| 2 | `pnpm ci` / `npm ci` 是包管理器内建 clean-install，**不做任何校验** | `scripts/README.md` + `check-gate-entry.ts:64-121`（`PNPM_BUILTIN_COMMANDS` 含 `ci`） | ✅ | 我实测 `pnpm ci` → 输出 `Removing node_modules` + 装依赖，**退出码 0，一条契约脚本都没跑** ⇒ 警告属实 |
| 3 | A6：§8.4 硬规则编号更正（标题「三条」→「六条」；第 6 条不与第 5 条撞号；硬规则 5 仍是 5） | `scripts/verify_errata_writeback.py:179-238` | ⚠️ **通过但未进链** | 实测 `--self-test` 0 失败 / 全量校验 21/21 通过。**但该脚本不在 `verify` 链里 ⇒ CI 不守**（见 F-03） |
| 4 | A7：FK 违规归一化 `NOT_FOUND`（不扩码） | `src/core/errors.ts:293-300` + `tests/contracts/clock.test.ts:144,154` | ✅ | 含**真实 SQLite FK 违规**的可达性测试 |
| 5 | 设计稿回写：5 条勘误逐条落盘 | `scripts/verify_errata_writeback.py --self-test` | ✅ | 实测：抽取 23 组补丁、每组「改前」或「改后」都在文档命中；自检 5 条负控 0 失败 |
| 6 | 提交前检查单（共享工作树纪律） | `scripts/README.md:117-149` | ⚠️ **与当前实际纪律不一致** | 见 F-06 |

### 3.8 阶段总览表 §3「阶段 0」行的 6 条硬断言（逐条）

| # | 阶段 0 硬断言（`DEVELOPMENT-PLAN.md:104`） | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | §5 表 ↔ `DEFAULT_PARAMS` 逐键逐值相等 | ✅ | `check-params.ts` + NC-01/02/03 |
| 2 | 8 条跨参数校验逐条有单测 | ✅ | `src/core/params.test.ts:155-228` + NC-T3 |
| 3 | `setParams` 失败时**一个参数都不落库** | ✅ | `src/store/params.test.ts:71` |
| 4 | `events.type` 仍为 13 种 | ✅ | `src/core/events.types.ts:19-33` + `check-payload-keys.ts` |
| 5 | touch payload 5 个新键齐备 | ✅ | `EVENT_PAYLOAD_KEYS.touch` + NC-04 / NC-T6 |
| 6 | C37 静态扫描进 CI | ✅ | `check-clock.ts` 在 verify 链第 6 段 + NC-C37-1/2/3 |

---

## 四、门禁脚本可靠性审查表

> 审查对象：`scripts/check-{gate-entry,params,payload-keys,clock,anchor,contract-ids,doc-counts}.ts`
> + `scripts/lib/design-doc.ts` + `scripts/verify_errata_writeback.py`
>
> **方法**：静态审查 + **在隔离沙箱（`.tmp/qa/recheck/`，仓库副本 + `node_modules` 目录联接）里做破坏性变异**，
> 变异**真的改到了文件**（每次变异都断言文件字节数变化 ⇒ 杜绝「变异没生效 ⇒ 脚本照常通过 ⇒ 被误读成脚本没守住」）。

### 4.1 逐个脚本

| 脚本 | 判据（失败条件） | 失败退出码 | 有无负控 | 负控是否因**目标原因**而失败 | 静默假绿风险 | 被 `verify` 链调用到？ |
| --- | --- | --- | --- | --- | --- | --- |
| `check-params.ts` | §5 解析结果 ↔ `DEFAULT_PARAMS` **逐键逐值**；且**条数相等**（`docParams.size !== PARAM_KEYS.length` ⇒ 失败） | **1** | ✅ NC-01（改默认值）<br>✅ NC-02（删一整行）<br>✅ NC-03（加一行新键） | ✅ 三者都点名了具体键（`MAX_STABILITY` / 「§5 表里没有」/「DEFAULT_PARAMS 里有这个键，但 §5 表里没有」） | **无**。解析 0 项时 `compareParams` 会为**每个**代码键报「§5 表里没有」⇒ 60 条差异 ⇒ 必红 | ✅ 第 4 段 |
| `check-payload-keys.ts` | §8.4 逐 type 键集 ↔ `EVENT_PAYLOAD_KEYS`（缺键/多键都红）；**变体并集 ↔ 键集**也必须相等 | **1** | ✅ NC-04（改 §8.4 一个键名）<br>✅ NC-T6（删代码里的 `coactSkipped`） | ✅ NC-T6 输出同时点名 `touch` 与缺失键 `coactSkipped` | **无**。某 type 行解析不到 ⇒ `doc === undefined` ⇒ 报「§8.4 的表里没有这一行」⇒ 必红 | ✅ 第 5 段 |
| `check-clock.ts` | ① 非白名单文件里的时钟读取 = 违规；② **命中文件数 == 1**（写死）；③ **命中点数 == 1**（写死）；④ **白名单长度 == 1**（独立写死，不由长度派生） | **1** | ✅ NC-C37-1（加一处 `Date.now()`）<br>✅ NC-C37-2（删掉 clock.ts 那处）<br>✅ NC-C37-3（白名单加一项不改期望值） | ✅ NC-C37-1 点名 `src/core/params.ts:283` + 「方法 sneakyNow 的签名不含 `now?`」；NC-C37-2 输出 `命中点数：0（期望 1）` | **无**。扫描 0 命中 ⇒ 文件数 0 ≠ 1 ⇒ 必红。⚠️ 但**豁免路径**依赖「声明上方 8 行内有含 `now` 的注释」，是启发式 | ✅ 第 6 段 |
| `check-anchor.ts` | 锚定表**恰好 5 行** × **每行恰好 3 列** × **逐格与写死常量相等** | **1** | ✅ NC-08（错列：把第 1 行的管辖路径换成第 2 行的）<br>✅ NC-09（少一行） | ✅ NC-08 报「第 1 行第 3 列（管辖路径）不一致」；NC-09 报「行数不一致」 | **无**。找不到表 ⇒ 报「在 §14.3.1 里找不到锚定表」⇒ 必红 | ✅ 第 7 段 |
| `check-contract-ids.ts` | ① §5 的 8 条编号连续 ↔ 代码条数 ↔ §12 引用数字（三方）；② C25：`ROUTER_NPROBE_WRITE_*` 在 §5/§6/代码三处同值；③ C26：硬编码 3 + 不在参数表 + 正文写明；④ §11.2 六组表达方式**逐名**比对（设计稿 ↔ 写死期望 ↔ 代码）；⑤ `missingIds` 锚点（§4.2/§4.5）；⑥ **内联门禁入口守卫** | **1** | ✅ NC-05（§12 的「8 条」→「9 条」）<br>✅ NC-06（删「硬编码 3」）<br>✅ NC-10（改 §11.2 的方法名）<br>✅ NC-G1~NC-G6（门禁入口 6 种破坏） | ✅ NC-05 报「§12 引用的条数 9 ≠ 代码里的 8（C25：引用处的数字必须同步）」；NC-06 报「设计稿里找不到「硬编码 3」的说明（C26 要求正文写明）」 | **无**。`parseSection5ValidationCount` 找不到块会**抛错**；`parseSection12ValidationReference` 返回 `undefined` ⇒ 报「§12 里找不到「§5 的 N 条」这个引用」⇒ 必红 | ✅ 第 8 段（同时承担门禁入口守卫） |
| `check-doc-counts.ts` | ① **性质**：四组之和 + v1.0 继承 == 代码键数；② 每组自报的组总数 == 其子项之和；③ §8.1 自称的项数 == 代码键数 | **1** | ✅ NC-11（§8.1 的 60 → 45）<br>✅ NC-12（§5 分类声明「共激活 10 → 9」）<br>✅ 单测 7 条负控（`tests/contracts/doc-counts.test.ts`） | ✅ NC-11 报「§8.1 称 params 是 45 项参数的完整生效快照 ≠ 代码里的 60 项」；NC-12 报「四组之和 + v1.0 继承 = 59 ≠ 代码里的参数键数 60」 | **无**。**找不到组 ⇒ 抛错**（不静默跳过）；「找不到 §8.1 的计数 ⇒ 抛错」；「找不到参数总数 ⇒ 抛错」。这三条「找不到即抛错」是本脚本最关键的防线 | ✅ 第 9 段 |
| `check-gate-entry.ts` | ① `scripts.ci` **恰好** == `pnpm run verify`；② `verify` 不在 pnpm 内建命令表里、`ci` 在表里；③ `verify` 链**逐名**齐全 + 每段写法是 `pnpm run <名>` + 无重复 + 每段指向的 script **存在** | **1** | ✅ NC-G1（改 `ci`）<br>✅ NC-G2（摘掉 `check:clock`）<br>✅ NC-G3（写成裸 `pnpm ci`）<br>✅ NC-G4（指向不存在的 script）<br>✅ NC-G5（重复一段） | ✅ 五种破坏全部 exit=1，且 NC-G2 报「缺少 check:clock」、NC-G4 报「多出 check:nonexistent」、NC-G5 报「重复 check:clock」 | **无**（对「链的形状」这一判据而言）。⚠️ **一处缺口**：它**不**检查每个 script 的**命令体指向的文件是否存在**（见 F-05） | ✅ **是**——被 `check-contract-ids.ts` **内联调用**（`checkContracts` 的最后一步）⇒ 每跑一次 `verify` 都会验一遍。**注意**：它**没有**自己的 `check:gate-entry` script（见 F-04） |
| `lib/design-doc.ts` | 纯解析库（`extractSection` / `parseAllTableRows` / `splitTableRow` / `extractPayloadKeys` / `parseDefaultCell` …） | —（无 CLI） | ✅ 12 条解析器单测（`tests/contracts/scripts.test.ts:69-112, 266-272`） | ✅ 逐条测：`stripBlockquote` / 转义竖线 / 括号深度切逗号 / 带单位默认值 / 反引号片段 / payload 键的三种形态 / 排除名单 | **低风险**（被上表脚本的「条数相等」断言间接兜住：解析漏读 ⇒ 条数不等 ⇒ 必红） | ✅ 被 5 条脚本共用 |
| `verify_errata_writeback.py` | 16 条语义断言（设计稿内容）+ 5 条契约门禁（跑仓库脚本） | **1**（有未通过项）<br>**2**（用法/文件缺失）<br>**3**（幂等自检失败） | ✅ `--self-test` **5 条负控**：① 抽取非空转 + 每组「改前/改后」命中；② 门禁名字映射（`check:params` → `check-params.ts` 存在 且 `check:params.ts` 不存在）；③ CRLF→LF 归一化；④ 追加型补丁幂等（连用两次 ⇒ 第 2 次 `already-applied` 且内容不复制）；⑤ 守卫逻辑**本身会报红** | ✅ 实测 `--self-test` → **0 项失败**；全量校验 → **21/21 通过** | ⚠️ **中**：它**不在 `verify` 链里** ⇒ 它的判据不构成 CI 的一部分（见 F-03） | ❌ **不在** `verify` 链（一次性工具） |

### 4.2 ★ 上一轮三个同族缺陷的复核结论

| 原缺陷族 | 现象 | 复核结果 | 证据 |
| --- | --- | --- | --- |
| ① **抽取正则在 CRLF 文件上匹配不到** ⇒「脚本跑通了但什么都没验」 | 设计稿被写成 CRLF 时，正则全失配 | ✅ **已修好** | 我把 `DESIGN-v2.md` **整份转成 CRLF**（实测 550,305 字节 / 5,799 个 CRLF），重跑 **6 条门禁脚本全部 exit=0 且输出 ✓** ⇒ 抽取对行尾不敏感。**但这条修复没有任何单测守着**（全仓库搜 `CRLF` 无命中）⇒ 见 F-04 的同类建议 |
| ② **用 npm script 名拼文件名** ⇒ 某些门禁永远判 ❌ | `check:params` → `scripts/check:params.ts`（不存在） | ✅ **已修好** | `verify_errata_writeback.py:542` 用 `script_name.replace(':', '-')` 做映射；`--self-test` 的负控 ② 专门断言「`check:params.ts` 不存在 且 `check-params.ts` 存在」 |
| ③ **守卫脚本只断言「文件存在」而非「被 verify 链真正调用到」** | 门禁脚本存在但没进链 ⇒ 永不生效 | ✅ **已修好** | **负控 NC-G2**：把 `check:clock` 从 `verify` 链摘掉（**文件仍在**）⇒ `check-contract-ids.ts` exit=1，报「scripts.verify 的门禁链：缺少 check:clock」。⚠️ 补充：`check-gate-entry.ts` 本身**没有**独立的 `check:gate-entry` script，它是被 `check-contract-ids.ts` **内联调用**的（实测 NC-G2 证明内联链路确实生效） |

### 4.3 我做的负控清单（全部实测，含变异生效断言）

| 编号 | 变异 | 目标脚本 | 退出码 | 报红原因（摘） |
| --- | --- | --- | --- | --- |
| NC-01 | §5 表 `MAX_STABILITY` 180 → 181 | `check-params.ts` | **1** | `发现 1 处不一致：MAX_STABILITY：默认值不一致…` |
| NC-02 | 删掉 §5 表的 `MAX_STABILITY` 整行 | `check-params.ts` | **1** | `DEFAULT_PARAMS 里有这个键，但 §5 表里没有` |
| NC-03 | §5 表加一行 `BRAND_NEW_PARAM` | `check-params.ts` | **1** | `§5 表里有这个键，但 DEFAULT_PARAMS 里没有` |
| NC-04 | §8.4 的 `coactPairsTruncated` → 拼错 | `check-payload-keys.ts` | **1** | `payload 键集不一致：§8.4 有而代码没有 [coactPairsTruncated]` |
| NC-05 | §12 的「§5 的 8 条」→「9 条」 | `check-contract-ids.ts` | **1** | `§12 引用的条数 9 ≠ 代码里的 8（C25）` |
| NC-06 | 删掉设计稿里的「硬编码 3」 | `check-contract-ids.ts` | **1** | `设计稿里找不到「硬编码 3」的说明（C26 要求正文写明）` |
| NC-07 | §11.2 改一个方法名 | `check-contract-ids.ts` | **1** | `4 处不一致`（逐名比对命中） |
| NC-08 | 锚定表第 1 行的「管辖路径」列换成第 2 行的 | `check-anchor.ts` | **1** | `第 1 行第 3 列（管辖路径）不一致` |
| NC-09 | 删掉锚定表的一行 | `check-anchor.ts` | **1** | `行数不一致` |
| NC-10 | §8.1 的「60 项参数」→「45 项参数」 | `check-doc-counts.ts` | **1** | `§8.1 称 params 是 45 项…≠ 代码里的 60 项` |
| NC-11 | §5 分类声明「共激活 10 项」→「9 项」 | `check-doc-counts.ts` | **1** | `四组之和 + v1.0 继承 = 59 ≠ 代码里的参数键数 60` |
| NC-12 | 设计稿整份转 CRLF | 全部 6 条 | **全 0** | ✅ 证明 CRLF 缺陷族已修好 |
| NC-C37-1 | `src/core/params.ts` 加 `Date.now()` | `check-clock.ts` | **1** | `src/core/params.ts:283 Date.now() 方法 sneakyNow 的签名不含 now?` + `命中文件数 2 ≠ 期望 1` |
| NC-C37-2 | 删掉 `src/core/clock.ts` 里的 `Date.now()` | `check-clock.ts` | **1** | `命中时钟读取的文件数 0（期望 1）` + `命中点数 0（期望 1）` |
| NC-C37-3 | 白名单加一项但不改写死的期望值 | `check-clock.ts` | **1** | `时钟白名单长度 2 ≠ 期望 1（C31）` |
| NC-G1 | `scripts.ci` 改成 `pnpm run typecheck` | `check-contract-ids.ts` | **1** | `scripts.ci 必须是「pnpm run verify」` |
| NC-G2 | 从 `verify` 链摘掉 `check:clock` | `check-contract-ids.ts` | **1** | `scripts.verify 的门禁链：缺少 check:clock` |
| NC-G3 | 链里写成裸 `pnpm ci` | `check-contract-ids.ts` | **1** | `不是「pnpm run <脚本名>」的写法（裸 pnpm ci 会被内建命令遮蔽 ⇒ 假绿）` |
| NC-G4 | 链里加一段不存在的 script | `check-contract-ids.ts` | **1** | `多出 check:nonexistent` |
| NC-G5 | 链里重复一段 | `check-contract-ids.ts` | **1** | `重复 check:clock` |
| NC-T1 | `DEFAULT_PARAMS.MAX_STABILITY` 180 → 181 | vitest | **1** | `每个键的默认值与 §6 的代码块逐值相等` ⇒ `expected { MAX_STABILITY: 181, …}` |
| NC-T2 | 删掉 `MAX_PIN_FACTOR` 键 | vitest | **1** | `参数总数恰好 60` ⇒ `to have a length of 60 but got 59` |
| NC-T3 | 校验第 2 条 `>` 改 `>=` | vitest | **1** | `第 2 条：…（严格大于）` ⇒ `expected undefined to be an instance of MemoryError` |
| NC-T4 | `MemoryErrorCode` 加第 6 个码 | vitest | **1** | `五个错误码都存在` ⇒ `to deeply equal […(3)]` |
| NC-T5 | `resolveNow` 的 `??` 改 `||` | vitest | **0** ⭐ | **没有报红** ⇒ 见 **F-02** |
| NC-T6 | 删掉 `EVENT_PAYLOAD_KEYS.touch` 的 `coactSkipped` | vitest + 门禁本体 | **1 / 1** | 门禁输出点名 `touch` 与 `coactSkipped` |
| NC-T7 | `appendEvent` 的 `memoryId` 改成可选 | `tsc --noEmit` | **2** | `error TS2554: Expected 2-3 arguments, but got 4.`（4 处）+ `TS2578: Unused '@ts-expect-error' directive` |

> **方法论说明（本次复核自身踩的坑，如实记录）**：
> ① 我第一版负控脚本**有 3 个正则没匹配上**（设计稿表格是**填充列宽**的，`| \`MAX_STABILITY\`       | 180 天`），
>    变异没生效 ⇒ 脚本照常 exit=0 ⇒ **看起来像「脚本没守住」**。
>    ⇒ 修法：负控脚本**必须断言「文件字节确实变了」**，否则负控无效。
>    本报告表中的所有负控都已加这道断言，且**每条都实测过**。
> ② 我第一版**还原函数漏了 `src/core/params.ts`**，导致 NC-C37-2 被上一条负控的残留污染 ⇒
>    结论不可信。⇒ 修法：还原函数必须**逐文件 `cmp` 自检**，不一致直接退出。
>    修正后 NC-C37-2 复跑，输出为 `命中点数：0（期望 1）`，符合预期。
> ③ 我有一次把 `pnpm exec vitest run <tsx 参数>` 写反了（vitest 把 `pnpm`/`exec` 当成了测试文件过滤器）⇒
>    误报「门禁 exit=1」。⇒ 修法：同一批负控里凡出现「与预期不符」的结果，**必须单独复跑**再下结论。

---

## 五、P1 验收判据基线

> 用途：阶段 1 开发线与最终验收**共用**的判据清单。
> 口径依 `DEVELOPMENT-PLAN.md:99-104`：**硬断言 = 算错了**（失败即 bug）；
> **软阈值 = 调参**（超了要判断是代码问题还是参数问题）。

### 5.1 阶段 1 总览行（`DEVELOPMENT-PLAN.md:104` 的原文硬断言 / 软阈值）

| 类别 | 条目 | 判定口径 | 守门测试文件 |
| --- | --- | --- | --- |
| **硬断言** | **五项权重和 == `score`**（误差 ≤ 1e-9） | 恒等式，`toBeCloseTo(score, 9)` | `tests/unit/recall.test.ts`（新建） |
| **硬断言** | **`intensity ∈ (0, 1]` 且 `min(1, …)` 钳制存在** | 区间断言 + **存在性**断言（两条都要） | `tests/unit/decay.test.ts` + `tests/unit/recall.test.ts` |
| **硬断言** | 同日守卫 `intervalDays < 1` 不增长 | 注入时钟，同日两次 `touch` | `tests/unit/stability.test.ts` |
| **硬断言** | 任何路径 `stability ≤ MAX_STABILITY` | 含合并 / emotion 两条路径 | `tests/unit/stability.test.ts` + `tests/unit/write.test.ts` |
| **硬断言** | FTS 只能走触发器同步（**禁** `DELETE FROM mem_fts`） | 静态扫描 + 端到端（旧 token 查不到 / 新 token 查到） | `tests/unit/schema.test.ts` + 静态扫描脚本 |
| **软阈值** | 分层时长算术事实（默认 `INITIAL_STABILITY=1` 天 ⇒ L3 ≈ 8.6 小时、归档 ≈ 3 天） | ⚠️ **说明项，非验收项**——**不得写成断言** | —— |

### 5.2 ★ 阶段 1 特有的两类硬约束（**不写下来就会被实现者漏掉**）

#### 约束 A · 五项权重和 == `score`（误差 ≤ 1e-9）

- **出处**：`DESIGN-v2.md` §4.6 步骤 3 的融合打分公式（行 1370-1376）+ §4.13.1 硬约束①（行 2782-2786）
  + `DEVELOPMENT-PLAN.md:104` 的阶段 1 硬断言列。
- **公式**（逐字）：

  ```
  总分 score = 0.30 × intensity
             + 0.25 × vectorSim
             + 0.20 × normBm25
             + 0.15 × graphProximity
             + 0.10 × recency
  ```

- **必须守的性质**：
  1. `Hit.score` **恒等于**上式（误差 ≤ 1e-9）；
  2. **权重和恒为 1.0**（0.30+0.25+0.20+0.15+0.10 = 1.00）——**参数表改动也不能破坏**；
  3. **缺项一律记 0，不重算分母**（无 embedding ⇒ 理论最高分 0.75）；
  4. **`Hit.score` 与 `rankScore` 是同一个数**；**抑制不引入第二个分**（§4.13.1 硬约束①）。
- **守门**：`tests/unit/recall.test.ts` —— 对**每一个**返回的 hit 断言
  `Math.abs(hit.score - (0.30*intensity + 0.25*vectorSim + 0.20*normBm25 + 0.15*graphProximity + 0.10*recency)) <= 1e-9`；
  再单独断言五项权重之和 `=== 1.0`。
- ⚠️ **反例（会被漏掉的写法）**：把 `vectorSim` 缺项当成「重新归一化其余四项」⇒ 权重和不再是 1.0 ⇒ 恒等式与可比性同时被破坏。

#### 约束 B · `intensity ∈ (0, 1]` 且 `min(1, …)` 钳制**必须存在**

- **出处**：`DESIGN-v2.md` §4.1（行 616 / 1207）+ `DEVELOPMENT-PLAN.md:104` + P1-T04 验收标准第 1 条。
- **公式**：

  ```
  effectiveStability(m) = m.stability × m.pin_factor      // τ
  Δt                    = max(0, now - m.last_access)      // 防时钟回拨
  intensity(m, now)     = min(1, exp(-Δt / (effectiveStability × 86400000)))
  ```

- **两重防护缺一不可**：
  1. `Δt = max(0, now - last_access)`；
  2. 结果 `min(1, …)`。
- **为什么必须写下来**（设计稿原话）：缺任一 ⇒ **时钟回拨或注入过去时刻**会让 `intensity > 1` ⇒
  直接污染 §4.6 的 `0.30 × intensity` 与 §4.4 的层级判定（`THRESHOLD_L3` / `THRESHOLD_L2` / `ARCHIVE_LINE`）。
- **守门**：`tests/unit/decay.test.ts`
  1. **区间断言**：对 `now < last_access`（时钟回拨）与 `now = last_access`（Δt=0 ⇒ intensity=1）
     都断言 `0 < intensity <= 1`；
  2. **存在性断言**（★ 这一条最容易被漏）：断言**实现里存在 `min(1, …)` 钳制**——
     用**静态扫描**（如 `grep` `src/core/decay.ts` 与 `src/store/recall.ts` 里 `Math.min(1,`）
     **或**用「`intensity` 恰好为 1 的边界用例」（`Δt = 0` ⇒ 必须是 1.0，不是 `exp(0)=1` 的巧合——
     ⚠️ 注意：`exp(0) = 1` 恰好等于 `min(1, 1)` ⇒ **这条用例区分不出「钳制存在」与「钳制缺失」**！
     ⇒ **必须另找一个能区分的用例**：让 `exp(-Δt/τ) > 1` 成为可能，即
     `Δt < 0`（已被 `max(0, …)` 挡住）——⚠️ 那么在 `max(0,…)` 存在的前提下 `exp` 永远 ≤ 1 ⇒
     **`min(1, …)` 钳制在数学上是冗余的** ⇒ **正确做法是：用静态扫描断言 `Math.min(1,` 出现在 intensity 的计算路径上**，
     这也正是 §4.6 步骤 2 的召回 SQL「**必须照抄这两重钳制**」的原因（SQL 里没有 `max(0,…)` 的等价物保证）。
  3. **召回 SQL 侧**：§4.6 步骤 2 的 SQL **必须同时含** `MAX(0, ...)` 与 `MIN(1, ...)`
     ⇒ 这条**只能靠静态扫描守**（纯函数测试守不住 SQL 里的钳制）。
- ⚠️ **反例（会被漏掉的写法）**：只在纯函数里钳制、召回 SQL 里只写 `exp(...)` ⇒
  召回路径的 `intensity` 可能 > 1 ⇒ **同时污染约束 A**（score 恒等式）。

### 5.3 阶段 1 逐任务硬断言（从 `DEVELOPMENT-PLAN.md` P1 段逐条提取）

| 任务 | 硬断言（摘） | 守门测试文件 | 状态 |
| --- | --- | --- | --- |
| **P1-T01** Schema | `user_version == 2`；`foreign_keys` 写/只读连接**都** == 1；写连接 `journal_mode == wal`、只读连接**不执行**该 PRAGMA；写连接 `cache_size == -64000`；**九张新表恰好 9 张**（≠ 9 抛错）；`mem_fts` 三个触发器存在、插入后 `count(*) == 1`、UPDATE `content_tokens` 后 FTS 同步（旧 token 查不到 / 新 token 查到）；`integrity_check == ok`；`foreign_key_check` 为空；`page_size=8192` **只在建库脚本**（不在 `open()` 初始化块） | `tests/unit/schema.test.ts` + `tests/integration/migrate.test.ts` | 部分已有（`schema.test.ts` 23 条 / `migrate.test.ts` 12 条） |
| **P1-T02** 迁移 | v1 库 ⇒ `open()` 成功迁移 ⇒ `user_version == 2` + 九张新表齐全 + **`memories.embedding` 的 CHECK 与 §3 逐字一致**（查 `sqlite_master` 的 SQL 文本）；**迁移后 `events` 恰好 +1 条**（`type='config'`，含 `SCHEMA_VERSION` 与完整 `params`）；迁移后 `memories` 全字段 / `edges` 权重 / 行数**零差异**、`coacts` **0 行**；迁移**可重复执行**；迁移中断后重跑 ⇒ 与一次跑完**一致**；`user_version=99` ⇒ `INVALID_INPUT` 且 `details.expected/actual` 正确；`user_version=2` 但缺一张新表 ⇒ 抛错且**不自动补建** | `tests/integration/migrate.test.ts` | 部分已有（12 条，含 ★ embedding CHECK 逐字比对、★ 阶段 B 回填公式） |
| **P1-T03** 分词 | `toHalfWidth("ＡＢＣ")=="ABC"`；`toHalfWidth("\u3000")==" "`；`normalize("  ＡＢＣ  ")=="abc"`；`tokenize("猫粮")=="猫粮"` / `tokenize("config")=="config"` / `tokenize("1.2.3")=="1 2 3"`；`buildMatchQuery("猫")=={matchSql:null,fallbackLike:"猫"}`；`buildMatchQuery("a")=={matchSql:null,fallbackLike:null}`；`buildMatchQuery("猫粮")` 含 `AND`、含 >3 token 时含 `OR`；`escapeLike("50%")=="50\\%"`；`escapeFts5('a"b')=='"a""b"'`；token 数**截断到前 30 个**；端到端 `write("ＡＢＣ")` 后 `recall("abc")` **能命中** 且 `write("abc")` 判为**完全重复** | `tests/unit/tokenize.test.ts`（新建） | ❌ 未开工 |
| **P1-T04** 纯函数 | ★ `intensity` 恒 ∈ `(0,1]`（含 `now < last_access`）；`effectiveStability` 与 `pin_factor` 相乘（**`pin_factor` 在分母内**、拉长 τ）、**不写回 `stability`**；`archiveAt` 在 `stability=MAX_STABILITY` 且 `pin_factor=MAX_PIN_FACTOR` 时 == `now + 2696 天`（误差 ≤ 1ms）；`resolveEntity` **不写库**（前后 `entities` 行数不变）、**主名优先于别名**、未命中返回 `null` | `tests/unit/decay.test.ts`（31 条已有）+ `tests/unit/entities.test.ts` | 部分已有 |
| **P1-T05** 图谱 | `link` 重复同一三元组 ⇒ **不产生重复边**而是强化（`weight` 按 `EDGE_REINFORCE_STEP` 增长、被 `MAX_EDGE_WEIGHT` 截断）；自环（按 **id** 判，不按名）⇒ `INVALID_INPUT` 且**库内无残留实体行**；`link({createMissing:false})` 对不存在实体 ⇒ `NOT_FOUND` 且**零写入**；`linkByIds` 对不存在 `entityId` ⇒ `NOT_FOUND`（**不是裸 FK 码**）；每次 `link` 产生**一条** `link` 事件（含 `weightAfter`、`autoCreatedEntities`）；`setAlias` 撞既有**主名** ⇒ `CONFLICT`；撞既有**别名** ⇒ **覆盖成功**（DO UPDATE）；`mergeEntities` ⇒ 源实体的记忆改指目标 / 边权**取和** / **仅目标实体身上的自环被清** / 源主名成为目标别名 / 源实体行被删 / **记忆正文一行未动**；`mergeEntities(x,x)` **幂等**；任一端不存在 ⇒ `NOT_FOUND` | `tests/unit/graph.test.ts`（20 条已有）+ `tests/integration/link.test.ts`（新建，**6 条端到端**） | 🟡 纯决策层已有，SQL 层在途稿 |
| **P1-T06** touch | ★ 同日两次 `touch` ⇒ `stability` **不变**、`boostApplied === false`，但 `access_count` +1、`last_access` 更新、**`stabilityDelta === 0` 且键存在**；间隔 ≥ 1 天 ⇒ 按 `difficultyBonus × spacing` 增长且被 `MAX_STABILITY` 截断；★ **任何路径**（含合并 / emotion）写入的 `stability` **≤ `MAX_STABILITY`**；`touch` 含不存在 id ⇒ `NOT_FOUND` + `details.missingIds` 正确 + **库里没有任何一条被加固**；含软删 id ⇒ `NOT_FOUND`；证据边 `weight` 增长 / `last_active` 刷新、事件 `edgesReinforced` **== 实际强化条数**；`memory_id IS NULL` 的边**永不被** touch 强化；★ **静态扫描**：`UPDATE memories SET stability` 只出现在 `growStability` 内 | `tests/unit/stability.test.ts`（19 条已有）+ `tests/unit/touch.test.ts` + 静态扫描脚本 | 🟡 纯计算已有，SQL 层缺 |
| **P1-T07** write | 相同归一化文本 ⇒ `exact === true`、库内**只有一条**、返回**库内版本** `content`；同义改写（共享实体 ≥ 2 或 cos ≥ 0.92）⇒ `exact === false` 的合并、库内一条、旧正文进 `content_history(reason='merge')`、事件 `type='merge'` 且 **payload 键集完整**；新事实 ⇒ `events(type='write')` 且 payload 含 `hasEmbedding`（**恒带**）；合并后 `content_hash` 用步骤 2 的值（**不重算**）⇒ 不撞 `idx_mem_hash`；`entityAliases` 撞已有映射 ⇒ `warnings` 含 `ALIAS_CONFLICT` 且**不覆盖**；embedding 维度错 / NaN / 全零 ⇒ `INVALID_INPUT` 且 `details.reason` 分别为 `'dim'`/`'nan'`/`'zero'`、**库内无该条记录**；合并时未传向量 ⇒ `embedding` 变 **NULL**（不是保留旧向量）；合并后 `stability` 按 `DEDUP_BOOST` 增长且被 `MAX_STABILITY` 截断、`useSpacing=false`；初次写入情绪加成受 `MAX_STABILITY` 约束（`emotion=100` ⇒ `stability ≤ 180`）；`initialDifficulty` 为 `DIFFICULTY_FIRST`(0.3) / `DIFFICULTY_NORMAL`(0.5)；★ **静态断言**：`UPDATE memories SET content` / `SET embedding` / `SET content_hash` 只出现在 `merge.ts` 的合并序列内 | `tests/unit/write.test.ts`（新建） | ❌ 未开工 |
| **P1-T08** recall | ★ **五项加权和 == `Hit.score`**（误差 ≤ 1e-9）；**权重和恒为 1.0**；`includeArchived:false` ⇒ **无** `intensity ≤ ARCHIVE_LINE` 的项、`true` ⇒ 可以有；`includeArchived:true` 时文本路与图谱路**不受 `routedIds` 约束**；`normBm25` **三分支各一个单测**（LIKE 兜底 ⇒ 全 1.0 / FTS 命中 ⇒ sigmoid 形状 / 无命中 ⇒ 全 0.0）；**纯向量命中的候选 `raw_bm25` 为 `null` 且不参与中位数计算**（⇒ 文本路全命中时 median 逐位不变）；`graphProximity` 对「只被文本路召回但实体确实相交」的候选 == 1.0；`cos` 钳制到 `[0,1]`（`min(1, max(0, dot))`）；候选去重后同 id 只出现一次但 `fromText`/`fromVector`/`fromGraph` 三个来源标记都保留；`explain:true` ⇒ **恰好一条** `recall` 事件；`diagnostics:true` ⇒ **零条** `recall` 事件但有 `explain` 块；`recall` **不写 `memories`**（除 `reinforce:true` 的加固） | `tests/unit/recall.test.ts`（新建） | ❌ 未开工 |
| **P1-T09** get + 基线 | `get` 对软删记录返回对象且 `deleted === true`、`deletedAt` 非 null；对硬删返回 `null`；`get` 的 `entities` 是**名称数组**、按名称**升序**；`get` 的 `layer` 与 `intensity` 与注入 `now` **严格对应**（改 `now` ⇒ `intensity` 变、`layer` 可能变）；★ **基线断言**：四开关全关 + `VECTOR_ROUTER='flat'` 时 `write`/`recall`/`touch`/`get`/`stats` 的可观测输出与参考实现**逐位相同**（数组逐元素 `deepEqual`，含 id 序列与每个数值） | `tests/unit/get.test.ts` + `tests/baseline/baseline.test.ts`（扩） | ❌ 未开工 |

### 5.4 阶段 1 的**软阈值**与判据写法规则

| # | 规则 | 写法要求（照抄即用） |
| --- | --- | --- |
| R1 | **统计型结论只能写阈值，不能写「完全相同」** | 写「吻合率 **≥ 0.98**」（探针边界效应 ⇒ 不可写「完全相同」）；**禁止**写成「必须 100% 命中」 |
| R2 | **性能门槛必须写明规模** | 「recall P99 ≤ 200ms / 写入 P99 ≤ 5ms / 向量路 P99 ≤ 20ms 且占比 ≤ 20%」——⚠️ **必须写明「100 万条规模」**，否则等于没验（阶段 2 用；阶段 1 无性能门槛） |
| R3 | **「逐位相同」是硬断言；「漏了多少」是软阈值** | 比对器（`tests/baseline/compare.ts`）**只做硬断言**，不做任何阈值判断（C30） |
| R4 | **「N/N 全绿」里的 N 必须是外部写死的期望值** | 采集/比对**收集数**要按「仓库清单数」求期望（不写死条数）；任何「期望值」不得由「本次实际结果」派生（C31） |
| R5 | 阶段 1 唯一一条软阈值 | 「分层时长算术事实（L3 ≈ 8.6 小时、归档 ≈ 3 天）」是**说明项，非验收项** ⇒ **不得写成断言**，否则会把「说明」变成「硬线」 |
| R6 | 基线比对在阶段 1 的口径 | 本阶段是「**比对机制可用**」，**不是**「基线已达成」；真正的「与 v1.0 逐位一致」在 **P1-T09 末**产生，并在 P3-T06 / P4-T07 再验两次 |

### 5.5 阶段 1 的**准入前置**（P1 开工前必须先满足，否则实现者会踩空）

| # | 前置 | 为什么 | 现状 |
| --- | --- | --- | --- |
| 1 | **`scripts/check-*.ts` 的「设计稿 ↔ 代码」断言必须延伸到 P1 的新契约** | P1 会新增大量「文档里写死的契约」（五项权重、`stabilityDelta` 对账恒等式、FTS 触发器同步）⇒ 若不写进门禁，漂移无人守 | 🔶 阶段 1 的两条特有硬约束**目前没有门禁脚本守**（纯单测守） |
| 2 | **`resolveNow(0)` 必须被守住** | `resolveNow` 是 `decay.ts` / `stability.ts` / `link.ts` 的实际调用点；`now=0` 被当成「没传」⇒ 注入时钟失效 ⇒ 衰减/强度/层级三条链路一起失真且**不报错** | ❌ **未守住**（F-02） |
| 3 | **`UPDATE memories SET stability` / `SET content` / `SET embedding` / `SET content_hash` 的静态扫描** | 「唯一写入点」是 §4.2 / §9.3.0.1 的不变量；纯单测守不住「有人在新文件里加了一行 UPDATE」 | ⚠️ `src/core/stability.ts` 已有自闸门（progress 文档提及），但**不在 `verify` 链里**（需确认） |
| 4 | **`§8.4` 硬规则条数进 `verify` 链** | 规则 5（`stabilityDelta` 对账恒等式）与规则 6（`memory_id` 必传）是 P1/P4 的关键契约 | ❌ 未进链（F-03） |

---

## 六、遗留问题清单（按优先级）

> 每条都带**复现证据**（命令 + 实际输出 + 期望输出）。**不写「可能有问题」。**

### P0 · 必须修（阻塞「P0 收口」结论）

#### **F-01 · C25 级漂移：参数「性质分类」在 3 处描述不一致，且计划文档自相和为 61**

- **性质**：**C25 违规**（同一规则在几处描述、值是否一致）。C25 在 `scripts/README.md` 的对照表里被标为
  「实现前必须做（**阻塞对应任务的合并**）」。
- **位置**：
  - `docs/design/DEVELOPMENT-PLAN.md:230`（P0-T02「**60 项的构成**」）
  - `src/core/params.ts:48` 与 `:53`（`DEFAULT_PARAMS` 上方的构成注释）
  - 对照的权威：`docs/design/DESIGN-v2.md:3515`（勘误 ② 已修正）
- **证据**（设计稿权威侧，已修正）：

  ```
  $ sed -n '3515p' docs/design/DESIGN-v2.md
  > - **性能参数**（分桶路由 7 项 + 簇跳 1 项 + **向量路阈值 1 项 = `ROUTER_MIN_TRAINING`** = **9**）：只影响延迟与召回率，不改变语义，可在运行期调整。
  ```

  ⇒ 性能组 = 9；四组之和 + v1.0 继承 = 16 + 9 + 1 + 5 + 29 = **60** ✅

- **证据**（计划文档侧，**未**修正）：

  ```
  $ sed -n '228,233p' docs/design/DEVELOPMENT-PLAN.md
    行为语义参数 = 共激活 **10** 项 + 涌现簇 **5** 项 + 侧抑制 **1** 项；
    性能参数 = 分桶路由 **7** 项 + 簇跳 **1** 项 + 向量路开关 **2** 项；
    运维参数 = `ARCHIVAL_ORPHAN_CHECK` **1** 项；
    机制开关 = **5** 项（4 布尔 + 1 三值选择器 `VECTOR_ROUTER`）；
    v1.0 继承 = **29** 项。合计 60。
  ```

  ⇒ 16 + 10 + 1 + 5 + 29 = **61**，而同一段写「合计 **60**」⇒ **自我矛盾**。

- **证据**（源码注释侧，**未**修正）：

  ```
  $ sed -n '46,55p' src/core/params.ts
   * · 行为语义参数 = 共激活 **10** + 涌现簇 **5** + 侧抑制 **1** = 16
   * · 性能参数     = 分桶路由 **7** + 簇跳 **1** + 向量路开关 **2** = 10
   ...
   * ⚠️ 口径提醒：`VECTOR_ROUTER` 同时出现在「性能参数（向量路开关 2 项）」与
   *   「机制开关（5 项）」两类里——**两处都数它**，所以把四类直接相加会得到 61。
  ```

- **为什么没被门禁抓到**：`scripts/check-doc-counts.ts` 只读 `docs/design/DESIGN-v2.md`
  （`readDesignDoc()` → `DESIGN_DOC_PATH = 'docs/design/DESIGN-v2.md'`），
  **从不读 `DEVELOPMENT-PLAN.md`，也不读源码注释** ⇒ 这条漂移对 CI **完全不可见**。
- **根因**：勘误 ② 的「全文扫描」（`DESIGN-v2-errata.md` §3.4）**只扫了 `DESIGN-v2.md` 一份文件**；
  它在 §2.5 里明确把 `DEVELOPMENT-PLAN.md` §7.1 判为「**无需改动**——那张表是按阶段分组的另一个轴」，
  但**没有连带审到 P0-T02 的「60 项的构成」**（那才是同一个「性质分类」轴）。
- **建议修法**（按 C25 的「同一规则在几处描述」逐处同步）：
  1. `DEVELOPMENT-PLAN.md:230`：`向量路开关 **2** 项` ⇒ `向量路阈值 **1** 项 = \`ROUTER_MIN_TRAINING\``（与设计稿 3515 行逐字对齐）；
  2. `src/core/params.ts:48`：同样改成 `向量路阈值 **1** = ROUTER_MIN_TRAINING`（性能组 = 9）；
  3. `src/core/params.ts:53-55`：删掉「61」那段「两处都数它」的旧口径提醒（勘误 ② 之后已不成立），改为引用设计稿；
  4. **（可选但推荐）** 给 `check-doc-counts.ts` 加一条「`DEVELOPMENT-PLAN.md` 的 60 项构成之和 == 60」的断言，
     让这条漂移**以后**再也逃不掉（C31 的分母纪律：一个防漂移的断言必须有写死的期望值）。
- **路由**：**Engineer**（`src/` 注释 + `docs/` 计划文档）。

### P1 · 应该修（不阻塞 P1 开工，但应在阶段 1 验收前修掉）

#### **F-02 · `resolveNow(0)` 没有测试守着（注入时钟可被静默吞掉）**

- **性质**：测试覆盖缺口。**实现本身是对的**（用的是 `??`），但没有任何断言把它钉住。
- **位置**：`src/core/clock.ts:56-58`（`resolveNow`）；调用点 `src/core/decay.ts:83`、`:126`、
  `src/core/stability.ts:114`、`src/store/link.ts:179`、`:293`。
- **复现证据**：

  ```
  # 沙箱里把 src/core/clock.ts 的
  #   return now ?? Date.now();
  # 改成
  #   return now || Date.now();
  $ pnpm exec vitest run tests/contracts/clock.test.ts
  exit=0        ← ★ 全绿通过，没有任何断言报红
  ```

  对照：同一文件里 `resolveNowStrictly` 的 `0` 用例**有**断言
  （`tests/contracts/clock.test.ts:80`：`expect(resolveNowStrictly(0, 999)).toBe(0)`），
  而 `resolveNow` 的用例（`:75-78`）只测了 `resolveNow(123)` 与 `resolveNow(undefined)`
  ⇒ **恰恰是被生产代码用的那个函数少了一条断言**。
- **期望输出**：把 `??` 改成 `||` 后，测试套件**必须报红**（`expect(resolveNow(0)).toBe(0)`）。
- **影响**：`now = 0` 是合法的 epoch 毫秒（`resolveNowStrictly` 的注释明写「显式传 0 必须是合法的」）。
  一旦被吞掉，注入时钟退化成真实时钟 ⇒ **衰减 / 强度 / 层级三条时间链路一起失真，且不报错、不告警**
  —— 正是 §11.1 时钟注入契约要防的那件事。
- **建议修法**：在 `tests/contracts/clock.test.ts` 补一条
  `expect(resolveNow(0)).toBe(0)`（并可顺手补 `resolveNow(NaN)` 的行为约定）。
  ★ **附带建议**：把 `resolveNow` 的实现改为直接复用 `resolveNowStrictly(now, Date.now())`，
  这样「0 合法」这条不变量就**只有一处实现**，不再靠两条代码各自记得。
- **路由**：**QA（我）**——属测试侧缺口，下一轮由 QA 补（本次因纪律「不改 `tests/`」未动手）。

#### **F-03 · §8.4「六条硬规则」的条数不在 `verify` 链里 ⇒ CI 不守**

- **性质**：门禁覆盖面缺口。
- **位置**：`scripts/verify_errata_writeback.py:179-238`（`_assert_004a/004b/004e`）。
- **复现证据**：

  ```
  $ grep -rn "verify_errata" package.json .github/workflows/*.yml
  （无输出）          ← 不在任何门禁入口里
  $ grep -rn "硬规则" scripts/check-*.ts
  （只有 check-payload-keys.ts 的注释里提到「硬规则 4」）  ← verify 链里没有任何脚本断言硬规则条数
  ```

  ⇒ 实测：把设计稿 §8.4 的「**六条硬规则**」改回「**三条硬规则**」，
  **6 条门禁脚本全部 exit=0**（`verify` 依然全绿）⇒ CI 不会发现。
- **期望输出**：§8.4 硬规则条数变化 ⇒ `pnpm run verify` 必须非 0 退出。
- **为什么重要**：硬规则 5（`stabilityDelta` 对账恒等式：`Σ 库内变化 == Σ 事件 delta`）
  与硬规则 6（`memory_id` 必传）是 **P1-T06 与 P4 的关键契约**；
  它们的编号若在文档里漂移，P1/P4 会照着一个不存在的约定写代码。
- **建议修法**：把「§8.4 硬规则条数 == 6」做成 `scripts/check-payload-keys.ts`（或新脚本）里的一条断言，
  **分母写死**（C31：不得由「本次数到几个」派生），并给一条负控。
  （另一条更省事的路子：把 `verify_errata_writeback.py` 挂进 `verify` 链 —— 但它依赖
  `DESIGN-v2-errata.md` 这个**一次性**补丁文件，长期挂进 CI 不合适 ⇒ **推荐前者**。）
- **路由**：**Engineer**（改 `scripts/` + `tests/`）。

### P2 · 可选（文档整理，不阻塞任何结论）

#### **F-04 · `scripts/README.md` 与 `scripts/check-gate-entry.ts` 的 4 处不一致**

| # | 位置 | 现状 | 期望 |
| --- | --- | --- | --- |
| a | `scripts/README.md:26` 标题 | `## 五个门禁脚本`，但下面的表有 **6 行** | `## 六个门禁脚本` |
| b | `scripts/README.md:41-42` 正文 | `全部串在 pnpm run verify 里（typecheck → lint → test → 五个门禁）` | 应为「**九个门禁段**（typecheck → lint → test → **六个门禁脚本**）」 |
| c | `scripts/README.md:112`（新增门禁的做法 步骤 2） | `在 package.json 的 scripts 里加 check:xxx，并串进 ci` | ⭐ **与机器强制的规则直接矛盾**：`check-gate-entry.ts` 要求 `scripts.ci` **恰好**等于 `pnpm run verify` ⇒ **照 README 做会让门禁当场失败**（负控 NC-G1 复现）。应改为「串进 **`verify`**」 |
| d | `scripts/check-gate-entry.ts:24`（文件头注释） | `也可单独运行：pnpm run check:gate-entry` | ⭐ **该 script 不存在**。实测：`$ pnpm run check:gate-entry` ⇒ `ERR_PNPM_NO_SCRIPT: Missing script: check:gate-entry`（退出码 1）。应改为 `pnpm exec tsx scripts/check-gate-entry.ts` |

- **复现证据**（d）：

  ```
  $ pnpm run check:gate-entry
  Error: ERR_PNPM_NO_SCRIPT
    × Missing script: check:gate-entry
  EXIT=1
  ```

- **路由**：**Engineer（可选）**。

#### **F-05 · `check-gate-entry.ts` 不检查「每个 script 的命令体指向的文件是否存在」**

- **性质**：**不是静默假绿**（见下），只是诊断信息不精确。
- **复现证据**：

  ```
  # 把 scripts/check-clock.ts 改名成 scripts/check-clock-renamed.ts（package.json 不动）
  $ pnpm exec tsx scripts/check-contract-ids.ts
  exit=0        ← 门禁守卫没发现
  ```

  但运行 `pnpm run check:clock` 会因 `tsx: file not found` 而**响亮失败**（非 0）⇒
  **不会静默通过**，所以不构成假绿；只是错误信息是「tsx 找不到文件」而不是「门禁链指向了一个不存在的脚本」。
- **建议**：在 `checkGateEntry` 里解析每条 `check:*` 的命令体，断言 `scripts/<name>.ts` 存在。
  （可选。）
- **路由**：**Engineer（可选）**。

#### **F-06 · `scripts/README.md`「提交前检查单」与当前实际纪律不一致**

- **现状**：检查单（`scripts/README.md:117-149`）写的是**共享工作树**纪律
  （① `git diff --cached --stat` ② `git show HEAD:<file>` ③ `git stash list`）。
  而**当前的团队实际做法已经是「开发线用独立 `git worktree`」**（主理人明确说明：
  开发工程师在 `D:/Git/wt/p1-t03`、`D:/Git/wt/p1-t05t06` 里干活，主线 `D:/Git/repo` 不被碰）。
- **差距**：检查单里**没有** worktree 纪律（每个 agent 用哪个 worktree、怎么确认自己不在别人的 worktree 里、
  怎么在合并前把两个 worktree 的提交对齐），而**这正是上一轮两次事故的根因**
  （`docs/progress/stage0-stage1-progress.md` §六.2：共享工作树的暂存区会串，已两次发生）。
- **建议**：在检查单里补一条「★ 当前纪律：每个 agent 一个独立 worktree；主线只由主理人合并」，
  并保留原三条作为「共用 worktree 时的兜底」。
- **附带的真实不一致**（同一批）：
  - `.github/workflows/ci.yml` 的 job 注释写「门禁：**8 条**子命令串成一条链」⇒ 实际是 **9 段**；
  - `docs/progress/stage0-stage1-progress.md:81` 的标题「门禁脚本（`scripts/`，**9 条串成一条链**）」
    列了 9 行，但其中 `capture-golden.ts` + `tests/baseline/` 与 `lib/design-doc.ts` **不是 verify 链的段**
    ⇒ **verify 链的 9 段是另一组**（typecheck / lint / test / 6 条 check 脚本）。
    ⇒ **读者会把「9 条脚本」和「9 段链」当成一回事** ⇒ 建议标题改为「verify 链的 9 段 + 4 个支撑文件」。
- **路由**：**Engineer（可选）**。

#### **F-07 · `scripts/verify_errata_writeback.py` 的 `GATE_CHECKS` 只覆盖 5 条门禁脚本，缺 `check:doc-counts`**

- **复现证据**：

  ```
  $ grep -n "check:" scripts/verify_errata_writeback.py | grep -E "^\s*[0-9]+:\s*\('check"
  ('check:params', ...)
  ('check:payload-keys', ...)
  ('check:clock', ...)
  ('check:anchor', ...)
  ('check:contract-ids', ...)
  ← 缺 'check:doc-counts'（第 6 条门禁脚本）
  ```

- **影响**：**低**。该脚本是**一次性**的回写自证工具，**不在 `verify` 链里**；
  `check:doc-counts` 有自己的门禁段（第 9 段）⇒ CI 不受影响。
- **建议**：加进 `GATE_CHECKS`（一行），或在文件头注明「本清单只覆盖 5 条，`check:doc-counts` 由 verify 链直接守」。
- **路由**：**Engineer（可选）**。

---

## 七、我**没有**验到的部分（如实列出，不粉饰）

| # | 未验到的部分 | 为什么没验 / 风险 |
| --- | --- | --- |
| 1 | **GitHub Actions 上的真实运行** | 本次只验了本地 `pnpm run verify`。`.github/workflows/ci.yml` 的 YAML **未实际执行**（无网络/无 runner）。⚠️ 该工作流的 `verify` job 与 `build` job 的**顺序、Node 22 + pnpm 12.16.1 的组合**未在 CI 上验证过。 |
| 2 | **`pnpm run build`（tsup 产物）** | 本轮未跑 build（team-lead 的门禁命令是 `verify`）。上一轮报告称 build 通过，我**未独立复验**。⇒ 「dist 产物可用」在本报告中**无独立证据**。 |
| 3 | **CRLF 修复的「单测级」守护** | 我实测了 CRLF 下 6 条脚本全绿（NC-12），但**全仓库没有任何一条单测覆盖 CRLF**（`grep CRLF tests/ src/` 无命中）⇒ 这条修复**目前只靠人工约定维持**，下次有人改解析正则可能再次静默失配。**建议**：加一条「用 CRLF 文本跑一遍解析器 ⇒ 条数不变」的单测。 |
| 4 | **`tests/golden/__captured__/baseline.jsonl` 的内容质量** | 该文件被 `.gitignore` 忽略（`tests/golden/__captured__/`），是**采集产物**。我只验了 golden 的**格式与比对机制**（`tests/baseline/baseline.test.ts`），**没有**独立复算过它与 v1.0 的等价性（v1.0 代码不在本仓库，见 D-10）⇒ **「与 v1.0 逐位一致」在本阶段无法验证**，计划文档对此的表述是诚实的。 |
| 5 | **P1-T05 / P1-T06 的 SQL 层** | `src/store/link.ts` 与 `src/core/stability.ts` 的在途稿**未被 `src/index.ts` 导出**、**未接入**、**未验收**（progress 文档已列）。本报告只把它们当作「P1 的起点」，**没有**对其 SQL 正确性下结论。 |
| 6 | **`src/core/schema.ts` 的 `SCHEMA_VERSION` 与 §9.1 的版本号口径** | 只验了 `migrate.test.ts` 里的 `user_version == 2` 断言存在且通过，**没有**独立复核「schema 版本号 = 2、交付版本号 = 2.1、特性标记『v2.0 新增』非版本承诺」三条口径在**代码注释**里是否处处一致。 |
| 7 | **`scripts/capture-golden.ts`** | 未做负控（它是采集器，不是断言器）。只验了它「能运行」与产物格式。 |
| 8 | **门禁脚本的**性能** | 6 条脚本在 5,799 行的设计稿上跑完的总耗时我未单独测量（`verify` 整体 ≈ 6s，其中 vitest ≈ 4.5s）。⇒ 「门禁会不会在 100 万条规模或 10 万行设计稿上变慢」**未评估**。 |
| 9 | **沙箱里 `node_modules` 用的是目录联接** | 负控在 `.tmp/qa/recheck/` 里跑，`node_modules` 是指向主仓的**目录联接**（junction）。⇒ 负控的**被测代码**是沙箱副本（真·独立），但**依赖**与主仓共享。理论上依赖侧的干扰（如 vitest 的 `pool: 'forks'` 在 Windows 上的 `EPERM` 偶发）仍可能存在；不过我**每条负控都跑出了与预期一致的红色**，且基线复测全绿 ⇒ 依赖干扰的证据不足。 |
| 10 | **我自己的一次操作事故（必须如实报告）** | ⭐ 我在实测「`pnpm ci` 是包管理器内建 clean-install」这条纪律时，**实际执行了 `pnpm ci`**（team-lead 明确要求「不要跑 `pnpm install`」）。它删掉了 `node_modules` 并按 lockfile 重装（输出 `Removing node_modules` → `added 83`）。**事后核查**：① `git status` 干净；② `pnpm-lock.yaml` **未改动**；③ `node_modules` 完整（8 个直接依赖 + `.bin` 全量 shim 在位）；④ `pnpm run verify` 复跑**退出码 0**（14 文件 / 263 条全绿）。⇒ **未造成任何仓库改动，也未打断他人工作**，但这条操作本身**违反了本次任务的纪律**，特此如实报告。 |

---

## 八、给后续（阶段 1）的三句话

1. **P0 的门禁可以信**——它的每一条判据我都做过「因为目标原因而失败」的验证，**没有发现静默假绿**。
   阶段 1 可以放心地把 `pnpm run verify` 当唯一门禁。
2. **但门禁只看得到它看过的地方**——本轮 3 条发现全部是「**门禁没覆盖的契约**」
   （F-01 计划文档的构成、F-02 `resolveNow(0)`、F-03 §8.4 硬规则条数）。
   ⇒ **阶段 1 每写下一条硬断言，就要同时问一句「谁守着它」**；只有单测、没有门禁脚本的断言，
   在门禁层面等于**没有**（这是本项目已经付出过代价的教训）。
3. **P1 的两条特有硬约束必须现在就被钉住**——
   **五项权重和 == `score`（误差 ≤ 1e-9）** 与 **`intensity ∈ (0,1]` + `min(1,…)` 钳制存在**。
   它们互相咬合：钳制漏了 ⇒ `intensity > 1` ⇒ 恒等式与层级判定**同时**被污染。
   ⚠️ 而 `min(1,…)` 钳制的**存在性**在纯函数里**测不出来**（`max(0,…)` 存在时 `exp` 恒 ≤ 1 ⇒ 数学上冗余）
   ⇒ **必须用静态扫描守**，且**召回 SQL 侧要单独守**（SQL 里没有 `max(0,…)` 的等价保证）。

---

*（报告完）*
