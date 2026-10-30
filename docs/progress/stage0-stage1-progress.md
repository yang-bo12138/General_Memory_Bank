# 阶段 0 / 阶段 1 交付进度与遗留清单

> 记录时点：2026-10-31 07:50（Asia/Shanghai）
> 基线 commit：`33d3034`（`origin/main`）
> 本文件是**交接文档**：任何接手者读完它，应当能直接开工，不需要回放对话。

---

## 一、一句话状态

**阶段 0 全完成**（6 个任务 + 收尾修复 + 设计稿回写）；**阶段 1 完成 3 / 9、部分 2 / 9**；
**阶段 2~5 共 28 个任务尚未开始**。门禁全绿：`pnpm run verify` 退出码 0，14 个测试文件 / 263 条测试。

---

## 二、任务完成度总表

图例：✅ 完成 · 🟡 部分完成（见备注） · ❌ 未开始

| 阶段 | 任务 | 状态 | 落点 commit | 备注 |
|---|---|---|---|---|
| 0 | P0-T01 工程基线与脚手架 | ✅ | `32fa697` | |
| 0 | P0-T02 参数表与跨参数校验 | ✅ | `3e8086c` | 60 项 / 8 条 |
| 0 | P0-T03 五个机制开关与基线不变量 | ✅ | `8b234b2` | |
| 0 | P0-T04 事件流扩展（扩 payload 键） | ✅ | `963b2e0` | 不新增 `type` |
| 0 | P0-T05 错误类型体系与时钟注入 | ✅ | `698094d` | |
| 0 | P0-T06 CI 契约断言脚本骨架 | ✅ | `811258f` | 5 条契约脚本 |
| 0 | P0-T07 收尾（门禁可见性 + 脚本补强） | ✅ | `e174fb4` `4e5cfb3` `07e7924` | 门禁入口守卫 + CI 工作流 |
| 0 | A6 §8.4 硬规则编号更正 | ✅ | `55654a7` | |
| 0 | A7 FK 违规归一化 NOT_FOUND | ✅ | `370c2c4` | 不扩码 |
| 0 | 提交前检查单（共享工作树纪律） | ✅ | `e98ebb0` | |
| 0 | **设计稿回写**（同步 + 5 条勘误） | ✅ | `828e6a4` `25447a6` | |
| 1 | P1-T01 Schema 建库脚本与连接初始化 | ✅ | `acbab21` | 17 张表 / PRAGMA A/B / FTS5 三触发器 |
| 1 | P1-T02 v1 → v2 迁移 | ✅ | 内容在 `1fbb574` | ⚠️ 归属被并入他人 commit，见 §六 |
| 1 | P1-T03 中文 Bigram 分词与 FTS5 查询构造 | ❌ | — | **下一棒的建议起点** |
| 1 | P1-T04 纯函数算法模块 | ✅ | `6d05109` | 衰减/强度/层级/边权/归档时刻 + `resolveEntity` |
| 1 | P1-T05 图谱维护 | 🟡 | `1ac013c` `33d3034` | 纯决策层 ✅；SQL 层为**在途稿**（未接入、未验收） |
| 1 | P1-T06 growStability 与 touch | 🟡 | `1fbb574` | 纯计算 ✅；`touch` 的 SQL 层与事件写入 ❌ |
| 1 | P1-T07 write 写入路径（去重与合并） | ❌ | — | |
| 1 | P1-T08 recall：三路召回与融合打分 | ❌ | — | |
| 1 | P1-T09 get() 与阶段 1 基线不变量验收 | ❌ | — | |
| 2 | P2-T01 ~ P2-T08（8 个任务） | ❌ | — | 向量分桶与路由 |
| 3 | P3-T01 ~ P3-T06（6 个任务） | ❌ | — | 神经元交互 |
| 4 | P4-T01 ~ P4-T08（8 个任务） | ❌ | — | 生命周期、事件重放与可观测性 |
| 5 | P5-T01 ~ P5-T06（6 个任务） | ❌ | — | 只读查看器与服务集成 |

**合计：43 个任务 → ✅ 13 · 🟡 2 · ❌ 28。**

---

## 三、已交付的代码资产

### 核心库（`src/`）
```
src/core/clock.ts        时钟注入（C37 的落点）
src/core/decay.ts        衰减/强度/层级/边权/归档时刻 5 个纯函数 + resolveEntity
src/core/entities.ts     实体解析
src/core/errors.ts       MemoryError（封闭五码）+ translateSqliteError()
src/core/events.types.ts 事件类型与 payload 契约
src/core/flags.ts        五个机制开关
src/core/graph.ts        图谱的 6 个纯决策（自环/强化/合并/别名冲突/缺失差集）
src/core/params.ts       60 项参数的默认值与校验
src/core/schema.ts       建库脚本装载
src/core/stability.ts    growStability 的纯计算 + 唯一写入点静态闸门
src/core/version.ts      版本
src/db/connection.ts     连接初始化（PRAGMA A/B、foreign_keys 显式开启）
src/db/migrate.ts        v1 → v2 迁移（阶段 A / 阶段 B）
src/db/schema.sql.ts     schema/001 + schema/002 的装载
src/store/events.ts      appendEvent（memory_id 必传实参）
src/store/params.ts      参数读写
src/store/link.ts        ★ 在途稿：link / linkByIds 的 §4.5 四步（未接入）
src/util/log.ts          日志（setTimeout 是 §8.3 的 flush 计时器，非机制级定时器）
```

### 建库脚本
```
schema/001_schema_v2.sql          17 张表 + FTS5 三触发器
schema/002_migration_v1_to_v2.sql  阶段 A（ALTER + 建表 + config 事件）+ 阶段 B（分批回填）
```

### 门禁脚本（`scripts/`，9 条串成一条链）
| 脚本 | 守什么 |
|---|---|
| `check-gate-entry.ts` | 门禁入口的**形状**（`ci` 恰为 `verify` 的别名、链恰好 9 段、名字逐名齐全） |
| `check-params.ts` | §5 参数表 ↔ `DEFAULT_PARAMS` 逐键逐值 |
| `check-doc-counts.ts` | §5 分类声明与 §8.1 的参数计数 ↔ 代码（60 项） |
| `check-payload-keys.ts` | §8.4 的 payload 键集 ↔ 代码 |
| `check-clock.ts` | C37 时钟注入契约（白名单为**字面量**） |
| `check-anchor.ts` | 跨节锚定清单（5 行 × 3 列） |
| `check-contract-ids.ts` | C25 / C26 / §5 的 8 条 / §11.2 的错误语义 |
| `capture-golden.ts` + `tests/baseline/` | 黄金基线捕获与比对 |
| `lib/design-doc.ts` | 上述脚本共用的设计稿解析器 |

---

## 四、验收证据（基线 `33d3034` 实测）

| 项 | 实测 |
|---|---|
| `pnpm run verify` | **退出码 0** |
| vitest 收集数 | **14** == 仓库 `*.test.ts` 清单数 **14** ✅ |
| 测试数 | **263 passed / 0 failed**，无 `Errors N errors` 行 |
| `pnpm typecheck` | 零错误 |
| `pnpm lint` | 零错误（biome，41 个文件） |
| `pnpm build` | 通过（tsup：CJS + ESM + d.ts） |
| Node 版本 | **≥ 22**（`better-sqlite3@13` 是 Node-API v10，Node 20 段错误） |
| CI 工作流 | `.github/workflows/ci.yml`，verify + build 两个 job，跑 `pnpm run verify` |

⚠️ **采信判据是语义判据，不是写死的数字**：收集数 == 仓库 `*.test.ts` 清单数 + 全部 passed +
无 `Errors N errors` 行 + 退出码 0。写死「263」或任何具体条数就是 C31 警告的同一个坑
（用实际条数当分母，条数一漂移就假绿或假红）。

---

## 五、遗留问题清单（按优先级）

### P0 —— 阻塞后续阶段，必须先做
| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| 1 | **P1-T05 的 SQL 层未接入、未验收** | `src/store/link.ts` | 文件已提交但 `src/index.ts` 未导出；缺 6 条端到端集成测试（重复三元组强化不产生重复边 / `createMissing=false` 零写入 / 每次 link 记一条事件 / `setAlias` 撞既有别名走 DO UPDATE / `mergeEntities` 后记忆正文一行未动 / 幂等返回） |
| 2 | **P1-T06 的 `touch` 只做了纯计算** | `src/core/stability.ts` | 缺 SQL 写入路径、缺 R-EDGE-TOUCH（先计数再 UPDATE、`memory_id IS NULL` 的边永不强化）、缺事件的 `boostApplied` / `edgesReinforced` / `reason` 三值 |
| 3 | **`hasTrainedBuckets` 未接入** | `src/core/flags.ts` | 「低于门槛」分支目前不看桶是否真的建过；这是 QA 确认的阶段 2 待补项 A1 |
| 4 | **P1-T03 未开工** | — | 中文 Bigram 分词与 FTS5 查询构造；`recall` 依赖它 |

### P1 —— 设计/工程一致性，需在阶段 2 之前解决
| # | 问题 | 说明 |
|---|---|---|
| 5 | **P1-T02 的提交归属错位** | 其内容落在 engineer-2 的 `1fbb574` 里（共享工作树的暂存区被全量暂存吞掉）。**未重写历史**（07:30 前改历史风险大于收益），归属在本文件与提交信息中留档 |
| 6 | **共享工作树的暂存区会串** | 已两次发生（阶段 0 的 `git stash` 抽走补丁、阶段 1 的全量暂存吞掉他人改动）。缓解措施已写进 `scripts/README.md` 的「提交前检查单」，但**两人以上并行时建议改用独立 `git worktree`** |
| 7 | **`page_size` 只在建库时生效** | 实测：`new Database()` 已按 4096 建好文件，`journal_mode=WAL` 写库头后固化 ⇒ 对已存在的库再设 8192 无效。实现已改为「文件原本不存在时把 `page_size` 作为第一条 PRAGMA」 |

---

## 六、本轮沉淀的方法论（写下来是为了不再重犯）

1. **门禁入口必须用不被遮蔽的名字。** `pnpm ci` / `npm ci` 是包管理器的**内建 clean-install**，
   会遮蔽同名 script ⇒ 退出码 0 却一条检查都没跑 ⇒ 正是 C31 警告的「一个从不失败的闸门，
   看起来在把关」。真实门禁名是 `verify`（`ci` 降为其别名）。
2. **验收工具本身必须被验收。** 本轮出现过三个同族缺陷：① 抽取正则在 CRLF 文件上匹配不到
   ⇒ 抽出 0 个块 ⇒「脚本跑通了但什么都没验」；② `GATE_CHECKS` 用 npm script 名拼文件名
   ⇒ 5 条门禁永远判 ❌；③ 守卫脚本只断言「文件存在」而非「被 verify 链调用到」。
   ⇒ 每条负控都要能说出「它到底是因为什么而失败」。
3. **判据再严，只要取串那一步替回写者修正了缺陷，严判据也白搭。**
4. **断言要写「性质」，不要写「当次的具体形状 / 数字」。**
5. **工作树绿 ≠ 提交绿。** 每次提交后用 `git show HEAD:<关键文件> | grep '<关键符号>'` 确认实现确实在提交里。
6. **成员结论为准，委托方不得凭印象断言。** 本轮主理人有两次判断被实测证伪
   （§8.4 实为 6 条硬规则；桌面原件是 LF 而非 CRLF；某个锚点串三个基线文件里都不存在）。

---

## 七、下一步的建议起点（可直接开工）

**第一件事（建议）**：P1-T03（中文 Bigram 分词与 FTS5 查询构造）——
它是 `recall`（P1-T08）与只读查看器（P5）的前置，且**不依赖任何未完成的模块**，零冲突风险。

**并行第二件事**：P1-T05 的收尾 —— 把 `src/store/link.ts` 接入 `src/index.ts`，
并补齐 6 条端到端集成测试；顺带把 `src/store/entities.ts` / `src/store/touch.ts` 建起来。

**第三件事**：P1-T07（write 写入路径：去重与合并）⇒ P1-T08（recall）⇒ P1-T09（get() 与基线验收）。

**开工前必读**：
- `docs/design/DESIGN-v2.md`（v2 设计稿，5799 行，**已回写定稿**）
- `docs/design/DEVELOPMENT-PLAN.md`（阶段与任务清单，4029 行）
- `docs/design/DESIGN-v2-errata.md`（回写补丁，1871 行）
- `scripts/README.md` 的「提交前检查单」（共享工作树纪律）
