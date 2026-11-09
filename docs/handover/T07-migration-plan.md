# T07 收口后的搬迁方案（A 方案 · 整仓移到 E 盘）

> **决策（用户 2026-11-05 10:07 拍板）**：**T07 收口后执行 A 方案** —— 把整个仓库从 D 盘移到 E 盘。
> **触发原因**：`D:\.pnpm-store` 有坏块（`os error 1392`，登记在 `docs/progress/vector-round-progress.md:115`）⇒ ⇒ **根因未修**（那行原文：「只绕过了…**没修根因** ⇒ 建议 `chkdsk /f D:`」）⇒ ⇒ **代码本体仍在 D 盘坏块风险区**。
> ⚠️ ★★ **2026-11-05 23:49 订正（★ 原文保留 —— 它是「迁移当时为什么发生」的历史事实）**：★ 全量诊断
> ⇒ ⇒ **`chkdsk D: /scan` = `0 KB in bad sectors` + `found no problems`** · SMART **未纠正读写错误 = 0**
> ⇒ ⇒ ★★ **D: 盘【健康】⇒ ⇒ 「坏块」这个归因【被证伪】⇒ ⇒ 「代码本体在坏块风险区」这个说法【不成立】**
> ⇒ ⇒ ★ ⇒ **迁移本身依然是对的**（★ store 迁 E 盘仍是正确决策）⇒ ⇒ ★ **「`chkdsk /f D:`」待办【已撤销】**
> ⇒ ⇒ ★ **真正成因至今未定位**（★ 不猜）⇒ ⇒ ★ 凭据 `docs/evidence/disk-health.json`。

---

## 一、★ 侦察结论（**全部实测，不是推测**）

### 1.1 代码本体**零路径依赖** ⇒ ⇒ 搬移**不需要改任何代码**

| 检查项 | 结果 |
|---|---|
| `package.json` / `tsconfig.json` / `biome.json` / `vitest.config.ts` / `.npmrc` / `.gitignore` | ✅ **全是相对路径** |
| `.git/config` | ✅ **无 `worktree`、无绝对路径** |
| `vite.config.ts` / viewer 的 alias | ✅ 无路径 alias |
| `bench/lib/db.ts` 的默认库路径 | ✅ 相对（`.tmp/bench/…`） |
| 全仓盘符绝对路径（`*.ts/*.tsx/*.json/*.cjs/*.sql`） | ✅ **仅 2 处，且都不是运行期依赖**：<br>· `bench/lib/harness.ts:220` = 注释里的历史实测记录（`D:/Git/wt/p2-final` 的探针）<br>· `bench/lib/harness.ts:531` = 跨平台判定示例字符串（`path.parse('D:/probe-target').root`）<br>· `tests/integration/backfill-codes.test.ts:14` = 注释里的历史验收记录（`E:/bench/codes/`） |
| 全仓盘符绝对路径（`*.md`） | ⚠️ **3 处**，全在历史文档里（见 §四） |

### 1.2 真实占用（**Windows 原生 `dir /s` 统计**，不用 `du` —— 它在 Windows junction 上不准）

| 目录 | 大小 | 性质 |
|---|---|---|
| `gmb/.git` | **8.24 MB**（690 文件） | ★ 不可再生 ⇒ 必须搬 |
| `gmb/src` | 1.10 MB | 不可再生 |
| `gmb/docs` | 2.88 MB | 不可再生 |
| `gmb/node_modules` | **423 MB**（21,374 文件） | ★ **可重装** ⇒ ⇒ **链接全是绝对路径**（见 §二.2）⇒ ⇒ 搬完必须 `pnpm install` |
| `gmb/.tmp` | **5.27 GB**（157 文件） | ★ **可再生**（语料种子 `20260101` + manifest）⇒ ⇒ **结论已落盘**（`handover/bench/t07-warm.json` 26 KB）⇒ ⇒ **不必搬** |
| **`gmb` 合计** | **5.71 GB**（22,550 文件） | |
| `handover/` | 481 KB | 不可再生 |
| `qa-mutation-sandbox/` | 12 MB | 独立目录（**不在 gmb 仓库里**） |
| `pnpm-store-fresh/` | 157 MB | ★ **遗留**（mtime 11-02，比 E 盘 store 旧）⇒ ⇒ **可删** |

⇒ ⇒ ★★ **关键结论**：**真正不可再生的只有 ~12 MB**（`.git` + `src` + `docs`）⇒ ⇒ **搬移成本极低**；
⇒ ⇒ 而 **5.27 GB 的大头是可再生的中间产物** ⇒ ⇒ **不必搬、可以删**。

### 1.3 pnpm store **已经在 E 盘**（这一步已经做过了）

```
$ pnpm store path
E:\.pnpm-store\v11            ← 156 MB · mtime 2026-11-04 21:39
```
⇒ ⇒ ★ **依赖安装这条路已经脱离 D 盘坏块** ⇒ ⇒ **重装依赖是快的**（store 在 E 盘、本地）。

### 1.4 ★ 硬约束：**WorkBuddy 会话与工作区路径是绑定的**

- 本会话的 `Workspace Folder` = `D:\WorkBuddyData\2026-11-02-08-56-53`（**系统注入**）
- `~/.workbuddy/<session-uuid>/` 里只有 `sidebar-list-snapshot.json` 与 `startup-route.json` ⇒ ⇒ **工作区路径是会话启动时注入的，不是可改配置**
⇒ ⇒ ★★ **搬移完成后，当前会话的 cwd 即失效** ⇒ ⇒ **必须由用户在 WorkBuddy 里用 E 盘新路径重开工作区（新会话）** ⇒ ⇒
⇒ ⇒ ★ **这条决定了「什么时候搬」**：**必须等 T07 全部收口 + 提交 + 用户新开会话**，否则当前会话的队友写操作会落空。

---

## 二、搬迁步骤（**收口后执行 · 顺序不能反**）

### 2.1 前置检查（**全部通过才动手**）

```bash
cd D:/WorkBuddyData/2026-11-02-08-56-53/gmb
git status --short                 # ⇒ 必须为空（★ 队友正在改文件 ⇒ 必须等他们收工）
git log --oneline -1               # ⇒ 记录搬移前的 HEAD（回滚锚点）
pnpm run verify                    # ⇒ exit 0（★ 搬移前的基线）
```

### 2.2 ★ 搬移本体（**建议用 robocopy 而不是 `mv`** —— 跨盘 `mv` = 复制 + 删除，无原子性，且失败时难以续传）

```bash
# ① 建目标
mkdir -p /e/WorkBuddyData/2026-11-02-08-56-53

# ② 复制（★ 排除可再生的大头）
robocopy "D:\WorkBuddyData\2026-11-02-08-56-53" "E:\WorkBuddyData\2026-11-02-08-56-53" \
  /E /XD node_modules .tmp "pnpm-store-fresh" /R:1 /W:1 /MT:8 /NFL /NDL /NP

# ③ 验证复制成功（对比文件数与关键目录）
```

> ⚠️ **为什么排除 `.tmp` 的大部分（5.27 GB）**：它**大部分可再生**（语料种子 + manifest），且**结论已在 `handover/bench/t07-warm.json`**（26 KB）⇒ ⇒ 搬它纯属浪费 5 GB 传输。
>
> ⚠️★ **但 `.tmp/bench/perf-1000000.db`（5.5 GB）要【单独带过去】**（★ **2026-11-05 12:35 的裁决**：工程师报「重建代价 = 准备段 **6.40 h**（灌库 3.61 + 训练 2.79），仓库外只有 manifest、没有库本体」⇒ ⇒ **删了就得重跑 9 小时** ⇒ ⇒ **而它就是「将来跑复现档」的原料** ⇒ ⇒ **E 盘还有 661 GB 空闲** ⇒ ⇒ **⇒ 迁移时它必须一起过去**）。
> ⇒ ⇒ **⇒ 所以 `.tmp` 不是「整体排除」，而是「只带这一个 .db」**：
> ```bash
> # ③ 额外带一个 5.5 GB 的库（★ 单独一步，便于中途断点续传）
> robocopy "D:\...\gmb\.tmpench" "E:\...\gmb\.tmpench" perf-1000000.db /R:1 /W:1 /MT:8 /NFL /NDL /NP
> ```
> ⇒ ⇒ ★ **真正不可再生的资产清单（迁移后要验的）**：
> | 资产 | 位置 | 大小 | 丢了要多久 |
> |---|---|---|---|
> | 代码 + `.git` | `gmb/` | ~12 MB | — |
> | 实测落盘 JSON | `handover/bench/t07-warm.json` | 26 KB | — （★ **真正的资产**）|
> | 百万级库（复现档原料）| `gmb/.tmp/bench/perf-1000000.db` | 5.5 GB | **6.40 h 准备段 + 2.75 h 测量** |
> | manifest | `gmb/.tmp/bench/*.manifest.json` | 431 B | — |
> ⚠️ **为什么排除 `node_modules`（423 MB）**：它的**每个链接都是绝对路径**（`/d/WorkBuddyData/…/node_modules/.pnpm/…`）⇒ ⇒ **搬过去必然全断** ⇒ ⇒ 正确做法是**在 E 盘重装**。
> ⚠️ **为什么排除 `pnpm-store-fresh`（157 MB）**：E 盘已有 `E:\.pnpm-store\v11` 在用，它是被替换掉的遗留。

### 2.3 ★ 在 E 盘重装依赖（**替代搬 node_modules**）

```bash
cd /e/WorkBuddyData/2026-11-02-08-56-53/gmb
pnpm install --frozen-lockfile      # ★ store 在 E:\.pnpm-store ⇒ 快
pnpm run verify                     # ★ 必须 exit 0（★ 这是搬移成功的机器凭据）
```

### 2.4 ★ 验收（**搬移成功的判据**）

| # | 检查 | 判据 |
|---|---|---|
| 1 | `pnpm run verify` | **exit 0**（含 `98 files / 1972 tests`） |
| 2 | `pnpm run check:json-note` | `WRITE: true  READ: true`（★ 验证路径解析改成相对脚本自身后仍成立） |
| 3 | `git status` | **干净**（★ 且 `git log -1` 的 hash 与搬移前一致） |
| 4 | `git fsck` | 无错误（★ 验证 `.git` 完整） |
| 5 | 全仓再扫盘符 | **零新增** `D:\WorkBuddyData` 引用（★ 排除 §四那 3 处历史文档） |
| 6 | 采样一个测试 | `pnpm exec vitest run tests/bench/t06-prune-rate-wiring.test.ts` ⇒ **13 passed**（★ 验证 `better-sqlite3` 原生模块在 E 盘能加载） |

### 2.5 ★ 回滚（**搬移失败时**）

```bash
# D 盘原件在 robocopy 阶段**不动** ⇒ ⇒ 回滚 = 删掉 E 盘副本即可
rm -rf /e/WorkBuddyData/2026-11-02-08-56-53
# ⇒ D 盘继续用（★ 这就是选 robocopy 而不是 mv 的理由：★ 原件全程可回退）
```

### 2.6 ★ 收尾（**搬移成功后**）

```bash
# ① 删 D 盘的原件（★ 确认 E 盘验收全绿之后再删）
# ② 删两个可再生的大头：
rm -f D:/.../gmb/.tmp/bench/perf-1000000.db*      # 5.27 GB（★ 结论已落盘 JSON）
rm -f D:/.../E:/bench/perf-1000000.db*             # 4.23 GB（★ 11-04 的旧库残留）
rm -rf D:/.../pnpm-store-fresh                     # 157 MB（★ 遗留 store）
```

---

## 三、★ 用户侧要做的两件事（**我做不了**）

| # | 动作 | 为什么我做不了 |
|---|---|---|
| 1 | ★ **在 WorkBuddy 里用 `E:\WorkBuddyData\2026-11-02-08-56-53` 重开工作区**（新会话） | 工作区路径是**会话启动时注入**的 ⇒ ⇒ 搬移后当前会话的 cwd 失效 ⇒ ⇒ 必须在 IDE 里重选 |
| 2 | ~~★ **（可选）D 盘坏块根因修复**：`chkdsk /f D:`~~ | ★★ **2026-11-05 23:49 已诊断完毕 ⇒ 【撤销】** —— ★ `chkdsk D: /scan` = **`0 KB in bad sectors` + `found no problems`** · SMART **未纠正读写错误 = 0** ⇒ ⇒ ★★ **D: 盘健康 ⇒ 无坏可修** ⇒ ⇒ ★ 而 `/f` 要**独占卷** + ★ D: 上有 **46 个顶层目录的第三方数据** ⇒ ⇒ ★ **不做比做更安全** ⇒ ⇒ ★ **真正成因（当初那次 `os error 1392`）至今未定位**（★ 不猜）⇒ ★ 凭据 `docs/evidence/disk-health.json` |

⇒ ⇒ ★ **注意第 1 条**：**搬移后请在新会话里说「继续 T07」** ⇒ ⇒ 交接信息全在 `T07-ordered-backlog.md` 与 `handover/bench/`，⇒ ⇒ **不会丢上下文**。

---

## 四、★ 搬移时要一并订正的历史文档（**3 处 · 全是历史记录，不影响运行**）

| # | 位置 | 现状 | 处置 |
|---|---|---|---|
| 1 | `docs/decisions/adr-perf-recall-vs-h1.md:446` | ★ **已写的是 `--store-dir=E:\.pnpm-store`** | ✅ **不用动**（现状正确） |
| 2 | `docs/design/p5-t01-t05-design.md:159/172/177` | 装 electron 时的临时绕过 `--store-dir "D:/WorkBuddyData/.pnpm-store-clean"` | ★ **保留历史价值**，但★ **补一句现状**（store 已迁到 `E:\.pnpm-store`）⇒ ⇒ 免得下一个人照着它跑 |
| 3 | `docs/progress/vector-round-progress.md:115` | 「`D:\.pnpm-store` 有坏块（`os error 1392`）⇒ 只绕过了、**没修根因** ⇒ 建议 `chkdsk /f D:`」 | ★ **更新为「已规避（store 迁至 E 盘）+ 仓库也已迁至 E 盘」** ⇒ ⇒ ★ ~~**但 `chkdsk` 根因未修的事实要保留**（★ 那是 D 盘的健康问题，不是本仓库的问题）~~ ⇒ ⇒ ★★ **2026-11-05 23:49 订正：那件事【根本不是坏块】** —— ★ 实测 D: **零坏簇 + SMART 未纠正错误 = 0** ⇒ ⇒ **D: 盘健康 ⇒ `chkdsk /f D:` 待办【撤销】** ⇒ ⇒ ★ 真正成因至今未定位（★ 不猜） |

---

## 五、★ 风险登记

| 风险 | 概率 | 影响 | 处置 |
|---|---|---|---|
| ★ **搬移后当前会话 cwd 失效** | **必然** | 会话中断 | ⇒ **必须由用户重开工作区**（§三.1）⇒ ⇒ **所以要等 T07 收口 + 用户新开会话** |
| ★ `node_modules` 链接全断 | **必然** | 依赖不可用 | ⇒ ⇒ **不搬它，在 E 盘 `pnpm install` 重装**（store 在 E 盘 ⇒ 快） |
| ★ `.git` 复制不完整 | 低 | 仓库损坏 | ⇒ ⇒ `git fsck` 验收（§二.4.4）⇒ ⇒ ★ **robocopy 而非 mv ⇒ D 盘原件全程保留 ⇒ 可回滚** |
| ★ `better-sqlite3` 原生模块在 E 盘加载失败 | 低 | 测试挂 | ⇒ ⇒ 验收第 6 条专门验这个（★ 它是本项目唯一必须编译的原生依赖） |
| ⚠️ 搬移时队友正在改文件 | — | 写操作落空 | ⇒ ⇒ **硬前置：`git status` 必须为空**（§二.1） |

---

## 六、★ 一句话结论

> ⇒ **代码零路径依赖 ⇒ 搬移不需要改一行代码**；⇒ **真正不可再生的只有 12 MB**（`.git` + `src` + `docs`）；
> ⇒ **5.27 GB 的大头是可再生的中间产物 ⇒ 删掉比搬更划算**；⇒ **唯一的硬约束是「会话与工作区路径绑定」⇒ ⇒ 必须在 T07 完全收口后、由用户重开工作区**。
