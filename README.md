# General_Memory_Bank
把「多模态记忆」「多层记忆」「图谱记忆」「遗忘曲线」「神经元交互」五件事 合成一个可复用的记忆库——不是五个模块，是同一片海里的五种现象\
0. 一句话说清\
一条记忆 = 一段可检索的文本 + 一个衰减中的强度 + 一群关联的节点。\
五个概念不是五个模块，是同一片海里的五种现象：其中三个落在一条记忆自身上（多模态=内容、图谱记忆=结构、多层=强度的投影），\
两个是引擎——「遗忘曲线」是时间引擎（驱动强度随时间衰减），\
「神经元交互」是网络引擎（驱动记忆之间的关系随使用而变化）。\
两个引擎并列，不是主从。

## 开发

```bash
pnpm install     # 装依赖
pnpm run verify  # 门禁：类型检查 → 代码风格 → 单元测试 → 8 条契约脚本（共 11 段）
pnpm build       # 构建产物（tsup：CJS + ESM + d.ts）
```

> 📌 **当前实现范围**（阶段 3 已收官，基线 `a121951`）：
> 阶段 0（骨架与不变量）、阶段 1（存储与基础运算）、阶段 2（向量分桶与路由，8 任务）、
> **阶段 3（神经元交互，6 任务 T01~T06）** —— **均已完成并通过对抗式验收**；
> **阶段 4（向量桶内 LIMIT）尚未开始** ⇒ 两条性能硬门槛仍红（H1 = 12,782 行，是门槛的 6.39 倍）。
> ⇒ 逐任务状态、验收证据、遗留清单与**下一步起点**见
> [`docs/progress/stage3-progress.md`](docs/progress/stage3-progress.md)，
> 交付总览见 [`docs/DELIVERY.md`](docs/DELIVERY.md)。

> 📌 **★ 写代码前请先读 [`docs/design/DEVELOPMENT-PLAN.md` §2.4](docs/design/DEVELOPMENT-PLAN.md)「通用工程纪律」**
> —— 5 条跨阶段长期有效的纪律，每条都有真实事故支撑（**13 个实例 · 4 个人各撞至少一次**）：
> ① 期望值必须外部写死 ② 新增断言前先想「什么变异会让它变红」
> ③ 验证工具自己会不会失手 ④ 一切「从间接证据推出的结论」都要用一次实测复核
> ⑤ 一切「会改状态的演练」必须隔离 ＋ 还原 ＋ 对账 ＋ 不可逆操作前先锚定

> ⚠️ **需要 Node ≥ 22**（`package.json` 的 `engines.node`）。
>
> 根因：依赖 `better-sqlite3@13` 的预编译产物按 **Node-API v10** 构建
> （Node 20 最高只支持 Node-API v9）⇒ 在 Node 20 上 `require('better-sqlite3')`
> 会**段错误（exit 139）**，而不是一个可读的报错。
> ⇒ 用 Node 20 跑本仓库会崩在装依赖之后的第一步。
>
> ⚠️ 注意 `engines` 只是**声明**，不是**闸门**（pnpm 默认 `engine-strict=false`，
> 不匹配只警告不拦）⇒ 真正把版本钉住的是 CI 的 `node-version: 22`。

> ⚠️ **门禁命令是 `pnpm run verify`**（别名：`pnpm run ci`）。
>
> **裸 `pnpm ci` / `npm ci` 只做依赖安装（clean install），不做任何校验，退出码却是 0。**
> 那是包管理器的**内建命令**，它会**遮蔽同名 script** ⇒
> 「跑了一下 `pnpm ci`，退出码 0」**不能**说明门禁跑过了。
> 这正是设计稿 C31 警告的症状：「一个从不失败的闸门，看起来在把关」。
>
> 门禁的形状由 `scripts/check-gate-entry.ts` **机器可检**：
> `scripts.ci` 必须**恰好**是 `pnpm run verify` 的别名，
> 且 `scripts.verify` 串起的 11 条子命令逐名齐全、每段都写成 `pnpm run <名>`。
>
> CI 工作流在 `.github/workflows/ci.yml`，跑的是 `pnpm run verify`（**不是** `pnpm ci`）。
