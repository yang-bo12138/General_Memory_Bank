# 交付总结 · 2026-10-31

**项目**：General_Memory_Bank —— 把「多模态记忆 / 多层记忆 / 图谱记忆 / 遗忘曲线 / 神经元交互」
合成一个可复用的记忆库（不是五个模块，是同一片海里的五种现象）。

**仓库**：https://github.com/yang-bo12138/General_Memory_Bank
**基线**：`33d3034`（`origin/main`）· 26 次提交

---

## 一、TL;DR

阶段 0（骨架与不变量）**全部完成并通过独立验证**；阶段 1（存储与基础运算）完成 3/9、
部分 2/9；门禁 `pnpm run verify` 全绿（14 个测试文件 / 263 条测试 / 退出码 0）；
设计稿已完成同步与 5 条勘误回写，**文档与代码在 CI 里互为锚点**。

---

## 二、交付概览

| 项 | 状态 |
|---|---|
| 阶段 0（6 任务 + 收尾 + 回写） | ✅ 全部完成 |
| 阶段 1（9 任务） | ✅ 3 · 🟡 2 · ❌ 4 |
| 阶段 2~5（28 任务） | ❌ 未开始 |
| 门禁 | `pnpm run verify` 退出码 0（9 段链：typecheck → lint → test → 6 条契约脚本） |
| 测试 | 14 个文件 / 263 条，全通过，无 `Errors` 行 |
| 构建 | `pnpm build` 通过（CJS + ESM + d.ts） |
| CI | `.github/workflows/ci.yml`（verify + build 两个 job，Node 22 + pnpm 12.16.1） |
| 独立验证 | 阶段 0 判定 **NoOne**（源码无 Bug）：28/28 项通过、343 条断言、破坏矩阵 28/28 确认 |
| 已知问题 | 4 个 P0（阻塞后续阶段）+ 3 个 P1，详见 `docs/progress/stage0-stage1-progress.md` |

---

## 三、文件清单

**新建目录结构**
```
src/core/       clock · decay · entities · errors · events.types · flags · graph · params · schema · stability · version
src/db/         connection · migrate · schema.sql
src/store/      events · params · link（★ 在途稿）
src/util/       log
schema/         001_schema_v2.sql · 002_migration_v1_to_v2.sql
scripts/        check-anchor · check-clock · check-contract-ids · check-doc-counts · check-gate-entry
                check-params · check-payload-keys · capture-golden · lib/design-doc
tests/          unit(5) · integration(1) · contracts(3) · baseline(3) · fixtures(6) · golden(2)
docs/design/    DESIGN-v2.md（5799 行）· DEVELOPMENT-PLAN.md（4029 行）· DESIGN-v2-errata.md（1871 行）
docs/quality/   stage0-verification.md（1033 行）
docs/progress/  stage0-stage1-progress.md（★ 本次新增：交接文档）
.github/        workflows/ci.yml
```

**关键文档**
| 文件 | 内容 |
|---|---|
| `docs/design/DESIGN-v2.md` | v2 设计稿，已同步用户桌面原件并应用 5 条勘误 |
| `docs/design/DEVELOPMENT-PLAN.md` | 6 个阶段 / 43 个任务的可执行计划 |
| `docs/design/DESIGN-v2-errata.md` | 回写补丁（22 条内容锚点，逐条验证唯一命中） |
| `docs/quality/stage0-verification.md` | 阶段 0 独立验证报告 |
| `docs/progress/stage0-stage1-progress.md` | **阶段 1 进度与遗留清单（接手者从这份开始）** |

---

## 四、用户下一步建议

1. **接手开发**：读 `docs/progress/stage0-stage1-progress.md` 的「下一步的建议起点」，
   从 **P1-T03**（中文 Bigram 分词 + FTS5 查询构造）开工 —— 它零依赖、不冲突，
   且是 `recall` 与只读查看器的前置。
2. **本地复现门禁**：
   ```bash
   pnpm install --frozen-lockfile
   pnpm run verify     # ⚠️ 不是 `pnpm ci`（内建 clean-install，会遮蔽同名 script，退出码 0 却什么都没跑）
   ```
3. **务必使用 Node ≥ 22**：`better-sqlite3@13` 按 Node-API v10 构建，Node 20 上直接段错误。
4. **看设计稿而不是看代码**：本项目的核心约束（60 项参数、5 个封闭错误码、6 条硬规则、
   13 种事件类型）都在 `docs/design/DESIGN-v2.md`，且已由 6 条契约脚本在 CI 里机器校验
   —— 改代码不改设计稿，CI 会红；改设计稿不改代码，CI 同样会红。
5. **多人并行时用独立 `git worktree`**：共享工作树的暂存区会互相吞并（本轮发生过两次），
   纪律已写进 `scripts/README.md` 的「提交前检查单」，但独立 worktree 才是根治。

---

## 五、本轮最有价值的三个发现

1. **`pnpm ci` 是一条永远为绿的假闸门** —— 它是包管理器的内建 clean-install，会遮蔽同名 script。
   真正的门禁名改成了 `verify`，并由 `check-gate-entry.ts` 把「门禁的形状」本身变成机器可检的不变量。
2. **`better-sqlite3@13` 要求 Node ≥ 22** —— 工程师实测 Node 20 下直接段错误（ABI 不匹配，
   不是缺 FTS5）。这个错误参数原本会写进 CI 工作流，让 CI 第一步就崩。
3. **验收工具本身必须被验收** —— 本轮发现三个同族缺陷：抽取正则在 CRLF 文件上匹配不到
   ⇒「跑通了但什么都没验」；门禁脚本名与文件名映射不一致 ⇒ 5 条门禁永远判失败；
   守卫只断言「文件存在」而非「被 verify 链真正调用到」。每个都补了负控。

---

## 六、诚实的边界

**阶段 2~5 共 28 个任务未开始**，不是「做完了但没写文档」。原因：
本轮团队 4 个角色中有 3 个（架构师、QA、工程师-2）因平台额度耗尽而中断，
主理人在 07:30 的截止点前把剩余积分全部用于：抢救未落盘的设计稿回写、
修正一处契约违例（自造错误码）、写齐交接文档，并把全部程序与文档一并推送。
⇒ **没有为了赶进度而降低质量**：`src/store/link.ts` 被明确标注为「在途稿 / 未接入 / 未验收」，
而不是伪装成完成的交付物。
