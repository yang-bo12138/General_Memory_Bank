# 阶段 4（P4 · 生命周期 / 事件重放 / 可观测性）进度与交接账

> 时点：2026-11-02（Asia/Shanghai）· 分支 `feat/p4-lifecycle`（基于阶段 3 收官点 `3d477d8` 之后的门禁收尾提交）
> 门禁：`pnpm run verify` **EXIT=0**（**14 段链**）· 测试 **67 文件 / 1,193 条断言**
> ⚠️ **本文件是阶段 4 的交接文档**：读完它应当能直接接手阶段 5，不需要回放对话。
>
> ⚠️ **分层纪律（沿用阶段 2/3）**：**实测层** = 有落盘数据 / 可复制命令支撑的数字；
> **推断层** = 由实测推出的结论 ⇒ 一律显式标注 ⚠️（推断）。

---

## 〇、一句话状态

**阶段 4 的八个任务（T01~T08）全部落地，门禁 14 段全绿。**
公开面从 **14 个方法长到 22 个**（新增 `forget` / `restore` / `updateContent` / `setParams` /
`stats` / `sweep` / `close` / `rebuildArchivalSchedule`），另有**两个离线工具**（重放 / 对账）。

**但阶段 4 不是「性能达标」** —— 阶段 3 遗留的两条硬门槛（H1 / H2）与三条产品级缺陷
**仍未解决**，且**本轮一行向量路代码都没动**（见 §六）。

---

## 一、八个任务的交付清单

| # | 任务 | 状态 | 落点 | 验收 |
|---|---|---|---|---|
| **P4-T01** | `content_history` 裁剪二选一（★ 阻塞项） | ✅ | `docs/decisions/content-history-retention.md` · `tests/contracts/content-history-retention.test.ts` | 决策记录 + **代码里无裁剪逻辑**（静态扫描：无 `DELETE FROM content_history`，且归档写入点只有两处） |
| **P4-T02** | `forget()` / `restore()` / 脱敏 | ✅ | `src/store/forget.ts` · `src/store/restore.ts` · `src/store/redact.ts` · `tests/unit/forget.test.ts`(11) · `tests/unit/restore.test.ts`(9) | 软删幂等 / 硬删级联与脱敏 / 坏 JSON 不中断 / `CONFLICT` 带 `conflictingId` / 合并分支少六项键 |
| **P4-T03** | `updateContent()` | ✅ | `src/store/updateContent.ts` · `tests/unit/updateContent.test.ts`(10) | 不加固（三个字段不变）/ 不传向量置 NULL **且退桶** / hash 与 `write` 同口径 / 冲突回滚 |
| **P4-T04** | `setParams()` + 第 10 条归档路径 | ✅ | `src/store/setParams.ts` · `src/store/archival.ts` · `tests/unit/setParams.test.ts`(9) | 原子性（非法 patch 一个参数都不落库）/ `EMBED_DIM` 两层拦截 / 改归档线 ⇒ 全量重建且**快慢两路径逐位相等** |
| **P4-T05** | `stats()`（20 字段） | ✅ | `src/store/stats.ts` · `tests/unit/stats.test.ts`(16) | 20 字段齐 / **不扫 `coacts`**（源码静态扫描）/ `archivalMissing` 的 `null` 语义 / `mode` 四值互斥 / `inRetrain` 作用域 |
| **P4-T06** | `sweep()` + 共激活淘汰 | ✅ | `src/store/sweep.ts` · `src/neuron/coacts.ts`（丢弃计数器）· `tests/integration/sweep.test.ts`(12) | 只清超期软删 / 脏行跳过不死循环 / 逐条事务 / 任一条抛错即中止 / `vacuumed` 是实际执行 / 度数上限 |
| **P4-T07** | 事件重放与对账 | ✅ | `src/tools/replay.ts` · `src/tools/verify.ts` · `tests/integration/replay.test.ts`(11) | 对账恒等式 ≤ 1e-9 / 旧事件可重放（缺键兜底 + 缺 `action` 默认 `purge`）/ 重放可复现 / `config` 恢复参数快照 |
| **P4-T08** | 备份 / 恢复 / 权重回归 | ✅ | `scripts/backup.ts` · `scripts/restore-checklist.md` · `bench/regression/weights.ts` · `bench/regression/golden/` · `docs/baseline/weights-report.md` · `tests/integration/backup.test.ts`(7) · `tests/contracts/weights-regression.test.ts`(6) | `VACUUM INTO` + 校验和登记 / 失败删残件 / 恢复后 `journal_mode == wal` 且自检全绿 / golden 只锁 id 序列 |

---

## 二、★ 破坏性变更清单（宿主接入必读）—— **阶段 4 新增两条**

> ⚠️ 判据与阶段 3 相同：**只记「旧宿主会静默判错」的变更**；「新 API、旧宿主压根调不到」不算破坏性（那是加法）。

| # | 变更 | 旧宿主的写法（**会静默判错**） | 新口径 |
|---|---|---|---|
| **2** | ★ **构造 `MemoryStore` 现在会写一条 `config` 事件**（§8.4 硬规则 2 的「第 0 步」） | 用「`events` 表总条数」判断「这次操作写了几条事件」⇒ **每次都是 +1** | 按 `type` 过滤后再数；或只数本次操作对应的事件类型 |
| **3** | ★ **`sweep()` 现在**总是**做共激活淘汰（不再只在传参时做） | 把 `sweep()` 当「只清软删」用 ⇒ 它会顺手删掉一批低亲和度的 `coacts` 边（`coactPairsPurged` 会 > 0） | 把它当「维护」读：返回值里三个数都要看；只想要统计请用 `stats()` |

> ⚠️ 第 2 条的依据：`§8.4` 的 `config` 行原文是「`MemoryStore` 构造**或** `setParams()` 时」。
> ⚠️ 第 3 条的依据：§4.10 把共激活淘汰写成 sweep 的**步骤 1b**（与清理解耦、每次都做）。

---

## 三、几个「不报错但结论错」的落地细节（本轮踩过的）

| # | 陷阱 | 表现 | 处置 |
|---|---|---|---|
| 1 | **`recordInitialConfig` 与只读实例** | 只读实例上写 `meta` 会抛 `SQLITE_READONLY` | 由 `appendEvent()` 内部的只读短路 + `recordInitialConfig` 的分支处理 ⇒ 只读实例照常能开库 |
| 2 | **`meta` 里的计数器被写成 `5.0`** | `CAST(REAL AS TEXT)` 的形态污染 ⇒ 下游 `Number()` 能读，但字符串比较会错 | 写入时显式 `CAST(? AS INTEGER)`；断言比**数值**不比字符串 |
| 3 | **`setParams` 必须就地更新 params 容器** | 换成新对象 ⇒ 维护器与四个上下文各自持一份 ⇒ 「改了参数但某条路径行为没变」，**不报错** | `Object.assign(target, next)`（一个真相源） |
| 4 | **`verifyIntegrity().ok` 与 `archivalMissing`** | 新建库 `ready=0`、缓存空 ⇒ 若把 `missing>0` 直接判失败 ⇒ **每个新库都自检失败** | `missing` 只在 `ready=1` 时算问题 |
| 5 | **golden 锁 uuid** | 每次重建语料 uuid 都变 ⇒ **每次都红**（恒红守卫比恒绿更难发现） | 锁「语料序号」`c0…c11` |
| 6 | **golden 用自然问句** | FTS5 按 token 全含匹配 ⇒ 5 条里 3 条命中为空 ⇒ **整套空结果的 golden 是恒绿的** | 查询逐字取自语料 + 加一条「每条都必须非空」的守卫 |
| 7 | **静态扫描命中测试自己** | 「脱敏 SQL 只出现一次」被**用例标题**里的原文命中 ⇒ 恒红 | 扫描范围限定**生产代码**（`src`/`scripts`/`bench`），且判据落在实现上而不是「我怎么写测试」 |

---

## 四、与阶段 3 的接口：**哪些东西变了、哪些没变**

| 项 | 变了吗 | 说明 |
|---|---|---|
| `recall()` / `write()` / `touch()` 的行为 | **没变** | 本轮没碰读写主路径（唯一改动是 `coacts.writeCoactivations` 收尾多了**一次 `meta` 累加**） |
| `coacts` 表结构 | **没变** | 累计丢弃数存 `meta`（**不扫 `coacts`** 才有 `stats()` 的那条纪律） |
| 事件类型 | **没新增** | 仍是 13 种；`rebuildArchive` / `recluster` / `rebuildBuckets` 共用 `type='sweep'` + `action` |
| `stats()` 与 `clusters()` | **口径分开** | `stats()` **不含**簇覆盖率（不得扫 `coacts`）；`adoptedMemories` 两处**同一个定义**（有断言） |
| 归档计数 | **共用实现** | `stats().archivedCount` / `sweep().archivedCount` / 自检**都走** `countArchived()` |

---

## 五、给阶段 5 的输入

| # | 输入 | 阶段 5 怎么用 |
|---|---|---|
| 1 | **`verifyIntegrity()` 已经实现但没挂门面**（`src/tools/verify.ts`） | 阶段 5 只需在 `MemoryStore` 上挂一个薄壳 + 补进 `LANDED_STAGES`（`tests/contracts/export-surface.test.ts`） |
| 2 | **`close()` 已存在且幂等** | 查看器（Electron）可以直接用它释放句柄；**注意**：关闭后任何方法都会抛 SQLite 的 `database is closed`（不是 `MemoryError`） |
| 3 | **重放器是「工具」不是「方法」** | §3.1 的归位表里没有它 ⇒ **不要**把它挂到门面上（那会变成第二条公开路径） |
| 4 | **`stats().vectorBackend.mode` 的四态判定**是唯一实现（`resolveVectorBackendMode`） | 阶段 5 的**面板五态**必须复用它；⚠️ 向量路**还没接进 `recall()`** ⇒ `mode='ivf'` 只说明「桶可用」，不说明「召回用了向量路」 |
| 5 | **备份 runbook 已写死 RPO 口径** | `coacts.coact_count` **不可重建** ⇒ **硬删前必须备份**（`scripts/restore-checklist.md` §0 第 3 条） |

---

## 六、★ 明确的「未达成」清单（**阶段 4 不负责还，别当成已解决**）

| # | 项 | 现状 | 归属 |
|---|---|---|---|
| 1 | **H1 候选读取行数 ≤ 2,000** | **仍红**（阶段 3 实测 12,782 行 = 门槛 6.39 倍，**推算口径档**） | 向量路接线前必须还（阶段 3 §6.2 已裁） |
| 2 | **H2 候选行数 ÷ 库规模 ≤ 0.2%** | **仍红**（1.2782%） | 同上 |
| 3 | **矢量路从未在 `recall()` 里跑过** | `routes.vector.ran` 恒 `false` | ⇒ 本轮 `stats()` 的 `mode` 只反映「桶可用」，**不反映「召回用了向量」** |
| 4 | **两条产品级缺陷**：`rebuild.ts` 不透传 `maxIterations` / `ivf.ts` 的细层分组 200 倍重复扫描 | **未修**（本轮一行 `src/vector/**` 都没动） | 阶段 5 或专门的性能轮 |
| 5 | **「只补跑迁移段」的运维入口** | **未做**（但归档这一侧有了 `rebuildArchivalSchedule()` 与 `backfillMissingArchivalRows()`，**迁移段**仍缺） | 同上 |
| 6 | **百万级 perf 未按实测口径重采** | 未做（需 ≥5GB 可用内存的时段 ≈26 分钟） | 与 1/2 一起 |
| 7 | **两个「2,000」的命名分离** | 未做 | 与 1 一起 |

⇒ ⇒ **一句话**：阶段 4 交付的是「**生命周期与可观测性**」，
**不是**「性能达标」；性能账仍然挂在向量路接线之前。

---

## 七、验收结论

- **门禁**：`pnpm run verify` **EXIT=0**（14 段：typecheck → lint → test → 8 条契约 → 3 条文档审计）。
- **测试**：**67 文件 / 1,193 条断言**全绿（阶段 3 是 55 / 1,082 ⇒ 本轮 **+12 文件 / +111 断言**）。
- **构建**：`pnpm run build` 通过（ESM / CJS / d.ts）。
- **公开面**：22 个方法（§3.1 的阶段 4 八个**全部挂上**，无空壳）。
- **策略**：`content_history` **不裁剪**（决策记录在 `docs/decisions/`）。
- **回归**：权重排序回归两档（`embeddedRatio` 100 / 50）**全部一致**；结论是**不改权重**。

---

## 八、本轮更新日志

- **2026-11-02（阶段 4 全量落地）**：
  ① 新增 6 个 store 模块（`forget` / `restore` / `updateContent` / `setParams` / `stats` / `sweep`）
  + 1 个唯一脱敏实现（`redact`）+ 1 个归档缓存模块（`archival`）+ 2 个工具（`tools/replay` / `tools/verify`）；
  ② 门面加 8 个方法（含 `close` / `rebuildArchivalSchedule`），公开面 14 → 22；
  ③ 新增 2 个运维脚本（`scripts/backup.ts` / `bench/regression/weights.ts`）与 1 份 runbook；
  ④ 门禁 14 段全绿；测试 67 / 1,193。
  ⚠️ **未做**：`src/vector/**` 与 `bench/perf.ts` 一行未动；百万级重采未跑（见 §六）。
