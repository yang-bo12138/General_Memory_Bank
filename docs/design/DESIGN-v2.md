# 通用记忆库 · 设计文档（记忆海版）

> 目标：把「多模态记忆」「多层记忆」「图谱记忆」「遗忘曲线」「神经元交互」五件事  
> 合成**一个**可复用的记忆库——不是五个模块，是同一片海里的五种现象。
>
> 状态：设计阶段（**v2.1** 记忆海版）。本文档是实现的唯一依据——写完代码后，  
> 任何与本文不符的地方都算 bug 或需回写文档。
>
> **v2.1 相对 v1.0 的根本变化**：规模目标从 10 万条提到 **100 万条**，  
> 概念从四件加到**五件**（新增「神经元交互」），存储从单文件 SQLite 改为  
> **单文件 SQLite（含向量分桶表，不引入独立向量目录）**，检索从「全表扫 + 纯加权排序」改为  
> **分层路由 + 簇关联加成 + 后置侧抑制**。  
> **v1.0 的绝大部分内容在 v2.1 里原样保留**——衰减公式、量纲口径、  
> 去重合并规则、遗忘一致性、42 条踩坑记录全部继承。  
> 被推翻/改写的 ADR 见 §13（ADR-6 撤销「flat-only」、ADR-16 与 ADR-33 撤销 ANN 路线、ADR-14 作废共激活加项），逐条列在 §13。

## 0. 一句话说清

**一条记忆 = 一段可检索的文本 + 一个衰减中的强度 + 一群关联的节点。**

五个概念不是五个模块，是同一片海里的五种现象：其中三个落在**一条记忆自身**上（多模态=内容、图谱记忆=结构、多层=强度的投影），  
两个是**引擎**——「遗忘曲线」是**时间引擎**（驱动强度随时间衰减），  
「神经元交互」是**网络引擎**（驱动记忆之间的关系随使用而变化）。  
两个引擎并列，不是主从（详见 §2 与 ADR-11）。


### 0.2 使用前提（必读）

本库有两种能力：**基础召回**（文本 / 向量 / 命题三路 + 遗忘曲线）与**涌现能力**  
（联想路、主题簇、侧抑制）。两者的可用性来源完全不同：

- **基础召回** —— 库单方面保证。只要数据在、向量在，就能用。
- **涌现能力** —— **由调用方的使用方式决定**。它们建立在「共激活」之上，  
  而共激活**只由显式 `touch()` 喂养**（recall 不喂养，见 ADR-19）。

★ **为什么 recall 不能喂养共激活**：  
若 recall 自身喂养，topN 会自我强化 —— 第一次检索选出的 5 条互相共激活 →  
成为图上唯一的强连通块 → 下次召回的簇补全优先带出这 5 条 → 再次被共激活 → ……  
**topN 自我强化，库锁死在早期话题上。**  
⇒ 代价必须写明：**共激活的增长速率 = 调用方的 touch 频率，不是检索频率。**

#### 0.2.1 密度门槛（实测数据）

> ⚠️ **本表采用「机制 A（同批自动建边）」口径**：共享实体 ≥ `COACT_MIN_ENTITIES`  
> 或余弦 ≥ `COACT_MIN_COS` 即建边；**未使用 `coActivateWith`**（该机制在当时的实验里尚未存在）。  
> ⚠️ 曲线基于 `COACT_MIN_ENTITIES = 1`；本版已改为 2 ⇒ **实际门槛只会高于「每 2 条一次」**，不会更低。

20,000 条语料 / 200 主题 / 768 维的实验结果：

| 采纳方式             | 覆盖率@1 万次 touch | 覆盖率@4 万次 touch | 全程最大簇 |
| ---------------- | -------------- | -------------- | ----- |
| 主题相关采纳（真实场景）     | 0.617          | **0.936**      | 95    |
| 主题相关 + 30% 近重复样板 | 0.542          | **0.949**      | 1,000 |
| 随机采纳（无主题偏好）      | 0.005          | **0.028**      | 5     |

> **可用门槛**（覆盖率 ≥ 0.5 且平均簇大小 ≥ 3）需要约 **10,000 次 touch**，  
> 折合 **「每 2 条记忆 touch 一次」的采纳密度**。  
> ⚠️ **这是基于 `COACT_MIN_ENTITIES = 1` 测得的量级参考值，不是已验证的验收线**——  
> 本版 `COACT_MIN_ENTITIES = 2`，真实门槛会**更高**（见下）。**实现前须按新参数重跑**（QA 待办）。

三条结论：  
① **簇的涌现依赖「主题相关的采纳」，不是「碰得多就行」。**  
随机采纳 4 万次后覆盖率仅 0.028 —— 若你的调用方式是随机采纳，  
簇与联想路将始终接近无候选。  
② **低于「每 2 条一次」的密度，联想路近似无候选，召回质量退化为纯三路基线。**  
这不是 bug，是设计后果。  
③ **簇会过时。** 固定 10,000 次 touch 后不再 touch：  
覆盖率 0 天 0.936 → 7 天 0.830 → 21 天 0.830 → **60 天 0.000**。  
⇒ 不持续使用的库，簇会自然消散（这是 §4.11 衰减机制的直接后果，  
也是「礁石会呼吸」的具体含义）。

⚠️ **以上曲线基于 `COACT_MIN_ENTITIES = 1`。** 本版已把它改为 2  
（实体路径要求共享 ≥ 2 个实体）⇒ 共激活的实体路径门槛提高 ⇒ **建立率进一步下降**  
⇒ **实际门槛只会高于「每 2 条一次」**，不会更低。  
（曲线需用新参数重跑，已登记为 QA 的待办事项。）

#### 0.2.2 与向量覆盖率耦合

共激活的建立有两条路径：**语义路径**（双方都有 embedding 且余弦达标）与  
**实体路径**（共享 ≥ 2 个实体）。⇒ **共激活建立率与 `embeddedRatio` 相关，但不是「直接耦合」**——  
⚠️ **这里有三条路径，诊断时必须分开看，否则会把「部分相关」误判成「直接相关」**：

| 路径            | 成立条件                          | 诊断手法                             |
| ------------- | ----------------------------- | -------------------------------- |
| ① **直接**：语义路径 | 双方都有 embedding 且 cos 达标       | `embeddedRatio` 低 ⇒ 语义路径几乎不发生    |
| ② **部分**：实体路径 | 共享 ≥ 2 个实体（**不要求 embedding**） | `embeddedRatio` 低时，**只有这条路还在供血** |
| ③ **无关**      | 只 touch 了不相干的记忆               | 两个覆盖率都很低 ⇒ 查调用方的采纳主题性            |

⇒ **`embeddedRatio` 低时覆盖率低，有两种完全不同的原因**：  
①「没向量所以建不了边」（路径①失效，路径②仍在）  
②「touch 的记忆根本不相干」（路径③）  
⇒ **区分办法**：看 `coverageOverAdopted`（触达口径）。  
触达口径高 ⇒ 路径③ 是主因（调用方问题）；  
触达口径也低 ⇒ 路径① 是主因（去回填向量）。  
⇒ **先看触达口径，再看全库口径**，顺序反了会修错地方。  
⇒ **准确表述是「部分相关」，不是「直接耦合」**：三条建边判据里  
**只有机制 A 的语义路径依赖 embedding**（双方都要有向量）；  
机制 A 的实体路径与机制 B（显式声明）**完全不依赖**。  
⇒ `embeddedRatio` 低 ⇒ 压制语义路径，**但实体路径仍在供血**。

> ★ **排查指引：联想路 / 簇跳产出偏低时，先看 `stats().embeddedRatio`，  
> 不要去调簇的参数或阈值。** 覆盖率低时共激活边必然少，调簇参数只会掩盖真因。

#### 0.2.3 调用方应当怎么做

1. **真的用了这批记忆，就 `touch()`。** 这是共激活的唯一来源，  
   也是簇与联想路唯一能长出来的方式。
2. **写的时候尽量带上实体。** 实体路径不依赖 embedding，  
   在 `embeddedRatio` 低的库上它是主要的共激活来源。  
   （代价：写入去重的实体路径要求 `DEDUP_ENTITY_MIN` 个重叠实体，见 §4.9）
3. **用 `diffused[].seeds` 构造 `coActivateWith`。**  
   这是「哪条联想唤起了哪条」的唯一可靠来源；自己猜会把无关的记忆关联起来。
4. **不要期待「刚写完立刻就能被向量路召回」跨进程生效。**  
   向量分桶的桶归属与主表同事务，但**桶中心需要训练**（建库时一次 1~3 分钟）；  
   分布漂移后还要重训（§9.3.2 ④）。刚写完的记忆在重训前可能落在已过期的桶里。  
   对账完成前向量路不可用（就绪闸门，§9.3）。
5. **老库升级后簇是空的。** 共激活历史不可重建（那是它的定义），  
   需要一段使用时间才会涌现。
6. **★ 换 embedding 模型必须全量重嵌入 + 重建分桶**（**即使维度相同**）。  
   ⚠️ **同维度的模型切换本库检测不到**（§5 `EMBED_DIM` 的注释已写明）——  
   换模型后旧向量仍在库里 ⇒ `cos` 比较、`VECTOR_MIN_COS` 准入、`COACT_MIN_COS` 共激活判据、  
   **分桶归属**全部在新旧向量空间错配下进行 ⇒ **检索语义静默崩坏，且无任何报错**。  
   ⇒ **调用方必须自己记住这件事**：切换模型 ⇒ 遍历全部记忆重算 embedding（`write` 或专门的回填路径）  
   ⇒ 再调 `rebuildVectorBuckets()` 重建桶归属 ⇒ **否则分桶不会自动重训**  
   （「未训练 ⇒ 向量路缺席」是另一回事，它**不等于**「模型变了要重训」）。  
   ⇒ **本库不引入 `embedderVersion` 之类的自动检测**：那需要把「模型身份」写进 schema，  
   而模型身份是**调用方的领域知识**（同一个模型有多个版本、同一个版本有多个部署）——  
   库替调用方猜，猜错的后果比不检测更糟（静默地拒绝合法写入）。  
   ⇒ **代价明写**：这一条**靠调用方的发布纪律兜住**，本库不提供技术保障。
7. **★ 部署形态：单文件 + 单写者**（§9.1 / ADR-5 / ADR-7）。
   - **多副本部署**：每个副本**各持各的 db 文件**，或在外层加**单写者队列**串行化；  
     **不要**让多个进程同时写同一个 `.db` 文件。
   - **并发写**：依赖 WAL + `busy_timeout`（§9.1）；写仍然是**互斥**的，  
     1~3 分钟的重训 / 重建期间，其它写会等锁。
   - **异步服务**：库是**全同步**的，异步要在**最外层**包装（§6 开头）；  
     且 `embedder` 必须是**同步**注入点（ADR-10）⇒ 远程 embedding 要由调用方**预取后传入**。


## 1. 五个概念各自的定位

先把它们各自的原始诉求摆清楚，避免融合时把不同的东西混为一谈。

| 概念        | 它真正在解决                   | 单独用时会在哪里失效                                          |
| --------- | ------------------------ | --------------------------------------------------- |
| **多模态记忆** | 语音、图片、视频里的信息也要能记住        | 只加了媒体类型，但"记不住多久""想不起来"仍是老问题                         |
| **多层记忆**  | 工作记忆、短期、长期要分开，不然上下文会爆    | 层怎么划、什么时候晋升/沉降，只能拍脑袋定 TTL                           |
| **图谱记忆**  | 记忆之间有关联，能顺着关系推理          | 关系有了，但没有强弱——三年前的关系和昨天的一样重                           |
| **遗忘曲线**  | 记忆该随时间淡忘，不该永久等权          | 只有衰减，没有结构——忘了就彻底没了，想不起来                             |
| **神经元交互** | 记忆之间不只是「有联系」，而是**会互相影响** | 只有静态关系，没有动态——讲同一件事的三条记忆会同时挤进 topN，且谁都不会因为「被一起想起」而变强 |

**关键观察**：这五个的失效点互为对方的解药。

- 多层缺"何时升降" → 遗忘曲线给了**强度**这个客观依据
- 图谱缺"关系强弱" → 遗忘曲线给了**边权重衰减**
- 遗忘曲线缺"结构" → 图谱给了**激活扩散**（被联想起来的记忆在本次检索中重获曝光）
- 多模态缺"重要性区分" → 多层 + 强度给了**优先级**
- 图谱缺"动态" → 神经元交互给了**共激活强化**（一起被想起的更近）与**侧抑制**（讲同一件事的互相让位）
- 神经元交互缺"载体" → 遗忘曲线给了**共激活亲和度的衰减**（不衰减的共激活会固化成马太效应）

所以融合不是拼装，是**五个失效点互相补位**。

**神经元交互为什么是第五个概念，而不是第四个的附属**：前四个都是**一条记忆自身的属性**  
（内容、结构、深度、时间——即 §2 的「内容 / 结构 / 强度」三个维度，其中「深度」是强度的投影）。  
神经元交互是**记忆之间的关系动力学**——它改变的不是某一条记忆有多重要，  
而是「哪些记忆会因为被一起想起而靠得更近，哪些会因为讲同一件事而互相让位」。  
它没有独立的存储列（除了一张共现表），它是**这几个维度交叉处的行为**。


## 2. 核心判断：三属性 + 两引擎 + 一涌现层

> **口径**：本节与 ADR-11 一致（ADR-11 是这条框架的**定盘星**）。  
> **三属性** = 一条记忆**自身**的、可存储可计算的维度（内容 / 结构 / 强度）；  
> **两引擎** = 驱动这三条属性变化的两套动力学（**遗忘曲线**：时间驱动；**神经元交互**：网络驱动）；  
> **一涌现层** = 主题簇（由共激活图算出，不是维度也不是引擎）。  
> ⚠️ **「四属性 + 一引擎」是本节的旧措辞，已作废**——它把「神经元交互」误算成了记忆自身的第 4 个维度。  
> 依据见下方树状图的注释：**神经元交互没有落在 `memories` 表的一行里**（§1 已写明  
> 「它没有独立的存储列，除了一张共现表」）⇒ 它是**引擎**，不是**属性**。

```
一条记忆（memories 表的一行）——三属性
├── 内容维度（多模态）   content(文本) + media_ref(指针) + media_type
├── 结构维度（图谱）     entities 关系 + memory_entities 关联 + edges 表里的边
└── 强度维度（遗忘曲线）  stability + difficulty + last_access
   ↑ 这条属性同时是「时间引擎」的载体：衰减由公式驱动，不是被动字段
↓
两引擎（都不是字段，是作用于上述属性的动力学）
├── 时间引擎 = 遗忘曲线     改的是**一条记忆自己**的强度（§4.1 / §4.2）
└── 网络引擎 = 神经元交互   改的是**记忆之间的关系**（§4.11 / §4.13）
   ↑ ★ 它的载体是 `coacts` 表（**记忆↔记忆**的共激活亲和度，不是实体↔实体），
     **不在 memories 行里** ⇒ 这是它属于「引擎」而非「属性」的**结构性理由**，
     而不只是措辞问题（§1「神经元交互为什么是第五个概念」已给出同一判断）
↓
层级（多层）不是字段，是 intensity 的分段结果
簇（涌现层）不是字段，是共激活图的连通分量
```

★ **为什么「层」不在这张图里**：多层是**算出来的**（强度分档），不是维度、也不是引擎——  
它是强度维度的一个**投影**。把它单列成「第四属性」会让人去找一个并不存在的 `layer` 列。

五条不可动摇的设计原则：

**① 层级是算出来的，不是存出来的。**  
不存 `layer` 字段。层 = `intensity` 落在哪个阈值区间。改阈值就能改分层策略，不用迁移数据。TTL 这个概念在本库中不存在。

**② 库不做多模态理解。**  
只接收"已经降维好的文本 + 一个指向原始文件的字符串"。图片转描述、语音转文字是**调用方**的责任。理由：各平台的视觉/ASR 能力不同、成本不同，塞进来会让它变成大泥球，而且换模型就要改记忆库。

**③ 遗忘是特性，但要可控。**  
衰减由公式决定，不是随机。且必须设稳定度上限，否则反复提及的记忆会变成"永不遗忘"，退化成全量注入。

**④ 向量只参与排序，不参与准入。**  
三路候选（文本/向量/图谱）只回答「谁可能是候选」，准入闸门对三路一视同仁。  
若让向量绕过闸门，一条 intensity 0.01 的旧记忆会因为「语义很像」被拉回 topN——**等于用相似度废掉了遗忘曲线**。  
本库两个卖点（会遗忘 + 能语义找）会互相抵消。

**⑤ 共激活由写路径喂养，不由读路径喂养。**  
`recall()` **绝不写** coacts。若召回自身参与共激活，topN 会自我强化：第一次检索就把整个库固化在早期话题上，  
之后越检索越窄——这是致命的正反馈。共激活的两个写入源都是写路径（§4.11.2）。


## 3. 数据模型

数据库选型为 SQLite（单文件，嵌入式部署，极简备份）。

为彻底避免 `VACUUM` 重排隐式 rowid 导致 FTS5 外部内容表错位，`memories` 采用 `rowid INTEGER PRIMARY KEY AUTOINCREMENT`，对外暴露业务 uuid `id TEXT UNIQUE`。

```sql
-- @schema  ★ **本块是建库脚本**（工具与人都以它为准）：
-- 外键是**每连接**开关，且 SQLite 默认关闭。这一行只对执行本脚本的那条连接有效，
-- 并且**在事务内执行是静默无效的**（SQLite 不报错、不生效）——建库脚本若把整段 DDL
-- 包进 BEGIN...COMMIT，它会被无声忽略。真正必须生效的位置是 §9.1 的连接初始化。
-- 这里保留它，是为了让单看本脚本的人知道「这个库依赖 FK 级联」，
-- 并让脚本里可能附带的种子数据插入受约束保护。
PRAGMA foreign_keys = ON;

-- 记忆条目
CREATE TABLE memories (
  rowid         INTEGER PRIMARY KEY AUTOINCREMENT, -- 显式自增主键，固化物理 rowid，防御 VACUUM
  id            TEXT NOT NULL UNIQUE,              -- 业务 uuid，对外暴露唯一标识
  kind          TEXT NOT NULL
                CHECK (kind IN ('fact','event','preference','thought','topic')),
                                                   -- 枚举由 CHECK 强制，非法值无法落库
  content       TEXT NOT NULL,                     -- 文本表示（多模态降维后原文，不参与 FTS）
  content_tokens TEXT NOT NULL,                    -- content 的 bigram 预切分结果，空格分隔。
                                                   --   ⚠️ tokenize 会先做 toHalfWidth + 小写，所以它是**半角化后**的切分结果，
                                                   --   与 content（原文，可能含全角/大写）不是逐字符对应的关系
  content_hash  TEXT NOT NULL,                     -- content 归一化后的 sha1，防御重复
  embedding     BLOB
                CHECK (embedding IS NULL OR length(embedding) % 4 = 0),
                                                   -- 语义向量：Float32 小端、**L2 归一化后**存储（§4.6 步骤 2c）
                                                   --   归一化后余弦 = 点积，省一次除法，且杜绝「长向量占优」。
                                                   --   字节长度必须 = EMBED_DIM × 4，由应用层校验。
                                                   --   ⚠️ **CHECK 写不出「= @dim」**（SQLite 的 CHECK 不能引用
                                                   --   配置参数），但 **EMBED_DIM 是只读固定值（768）**，
                                                   --   故可写字面量守卫 `length(embedding) = 3072`
                                                   --   或更宽松的 `length(embedding) % 4 = 0`（弱守卫，与维度解耦，
                                                   --   换维度仍成立）。二者都比「全靠应用层」多一道库层防线：
                                                   --   维度错乱 / 截断的脏数据在库层就被挡住，而不是等到算分时才错。
                                                   --   ⚠️ 选 `% 4 = 0` 而非 `= 3072`：换维度时弱守卫不必改写
                                                   --   （`EMBED_DIM` 只读 ⇒ 换维度要走全量重嵌入 + 重建库）。
                                                   --   ⚠️ 必须允许 NULL：老数据与「调用方不提供向量」都是合法状态。
                                                   --   ⚠️ 它是 content 的**衍生物**，遗忘口径见 §8.2——
                                                   --   不能当「脱敏后仍可保留的统计量」。
  media_ref     TEXT,                              -- 原始多模态文件指针（路径/URL）
  media_type    TEXT
                CHECK (media_type IS NULL OR media_type IN ('image','audio','video')),
                                                   -- 允许 NULL；非 NULL 时必须为三种之一
                                                   -- 与 media_ref 的同生同死由下方表级 CHECK 兜住
  source        TEXT,                              -- 来源标识（会话/文档/消息通道）；仅用于溯源展示与查看器筛选，**不参与召回过滤**
  confidence    REAL NOT NULL DEFAULT 0.7
                CHECK (confidence >= 0.0 AND confidence <= 1.0),
                                                   -- 置信度 0~1（明确声明 vs 自动抽取）；**仅用于展示与排序提示，不进入 §4.6 打分公式**

  -- 遗忘曲线（强度维度）
  stability     REAL NOT NULL CHECK (stability > 0),
                                                   -- 稳定度（单位：天）。>0 是除零的最后一道防线：
                                                   -- 即使 API 层漏校验，数据库也拒绝写入 0
  difficulty    REAL NOT NULL CHECK (difficulty >= 0.0 AND difficulty <= 1.0),
                                                   -- 难度 0~1，越低越容易记牢
  pin_factor    REAL NOT NULL DEFAULT 1.0
                CHECK (pin_factor >= 1.0 AND pin_factor <= 5.0), -- 人为强调倍率（1~5），不污染 stability，只在算 intensity 时乘
  created_at    INTEGER NOT NULL,                  -- 创建毫秒时间戳
  last_access   INTEGER NOT NULL,                  -- 上次有效召回/使用时间戳
  access_count  INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
                                                   -- 累计被使用次数

  -- 状态
  deleted       INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
                                                   -- 1 = 用户显式遗忘（软删，不参与任何召回与扩散）
  deleted_at    INTEGER,                           -- 软删时间戳（毫秒），用于 sweep 清理判断

  -- 状态一致性：删除标记与删除时间必须同生同死，避免出现「已删但无时间」（sweep 无法清理）
  CHECK ((deleted = 0 AND deleted_at IS NULL) OR (deleted = 1 AND deleted_at IS NOT NULL)),

  -- 多模态二元组同生同死：「有 type 没 ref」和「有 ref 没 type」都是脏数据——
  -- 前者让 MemoryView 交出一个无法定位的类型，后者让查看器拿到路径却不知怎么渲染。
  -- 二者都只在实体被读出时才暴露问题，写入时不报错，所以必须在库层拦住。
  CHECK ((media_ref IS NULL AND media_type IS NULL)
      OR (media_ref IS NOT NULL AND media_type IS NOT NULL))
);

-- 索引
CREATE UNIQUE INDEX idx_mem_hash ON memories(content_hash) WHERE deleted = 0;
CREATE INDEX idx_mem_last_access ON memories(last_access) WHERE deleted = 0;
CREATE INDEX idx_mem_kind ON memories(kind) WHERE deleted = 0;
CREATE INDEX idx_mem_created_at ON memories(created_at) WHERE deleted = 0;
-- 软删清理专用（与上面三者的 WHERE 条件互补，sweep 的 purgeDeletedDays 依赖此索引）
CREATE INDEX idx_mem_deleted_at ON memories(deleted_at) WHERE deleted = 1;
-- ⚠️ **不要给 `embedding` 建任何索引**（包括 `WHERE embedding IS NOT NULL` 的部分索引）：
--   向量路要的是「窗口内全部行」，索引省不掉一次全扫；而 BLOB 无法参与范围查询，
--   建了只会换来每次写入时的额外写放大。这是引入向量后最容易顺手加错的一项。

-- 实体表（实体归一，支持别名）
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,                  -- entity uuid
  name          TEXT NOT NULL UNIQUE,              -- 主名称（如 "张三"）
  type          TEXT NOT NULL DEFAULT 'concept'
                CHECK (type IN ('person','thing','place','concept','media')),
                                                   -- 枚举由 CHECK 强制，与 memories.kind 同一口径
                                                   -- （原先只写在注释里，非法值可以静默落库）。
                                                   -- ⚠️ **现状**：唯一写入点写死 'concept'（§4.5 步骤 2、
                                                   --   §4.9 步骤 1b 的 UPSERT），没有任何接口能传入别的类型，
                                                   --   全文也没有读取点——`idx_entity_type` 目前是空转索引。
                                                   --   要真正区分类型，得先给 `WriteInput` 加类型字段或做自动推断，
                                                   --   那是设计扩展而非实现遗漏；在那之前不要假装它已经在用。
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_entity_type ON entities(type);
-- 曾有一列 `aliases TEXT`（JSON 数组，供展示）：已删除。
--   理由是「同一件事只存一份」——权威来源是 entity_aliases，展示层 join 即可。
--   保留它意味着每次别名变更都要在 setAlias / mergeEntities / write 三处同步，
--   而三处里 write（§4.9 步骤 1c）实际已漏掉同步：冗余列一旦漂移，展示层看到的别名
--   与召回实际生效的别名不一致，且没有任何地方报错。（同 §4.1 `pin()` 里「不要另立 `pinned` 列」的判断。）

-- 别名索引表（写入与召回两条路径都走主键查找，避免解析 JSON 全表扫描）
CREATE TABLE entity_aliases (
  alias         TEXT PRIMARY KEY,                  -- 别名（如 "老张"），全局唯一
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX idx_alias_entity ON entity_aliases(entity_id);
-- 约束：别名不得与任何主名称冲突，由应用层在写入别名时先查 entities.name 校验。

-- 记忆与实体关联表（M:N 多对多）
CREATE TABLE memory_entities (
  memory_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX idx_me_entity ON memory_entities(entity_id);
CREATE INDEX idx_me_memory ON memory_entities(memory_id);

-- 知识图谱关系边（实体与实体之间的有向边）
CREATE TABLE edges (
  id            TEXT PRIMARY KEY,                  -- edge uuid
  subject_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate     TEXT NOT NULL,                     -- 关系名（喜欢 / 住在 / 养 / 关联）
  object_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  memory_id     TEXT REFERENCES memories(id) ON DELETE SET NULL, -- 支撑证据
  weight        REAL NOT NULL DEFAULT 0.8,         -- 边强度，初始 0.8，衰减基准 30 天
  last_active   INTEGER NOT NULL,                  -- 上次活跃时间戳
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_edge_spo ON edges(subject_id, predicate, object_id);
CREATE INDEX idx_edge_subj ON edges(subject_id);
CREATE INDEX idx_edge_obj ON edges(object_id);
CREATE INDEX idx_edge_mem ON edges(memory_id);

-- 正文历史表（只追加）：合并/重写时保留旧版本，保证「可完整重放」不留空洞
CREATE TABLE content_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,                     -- 被替换掉的旧正文（每一版合并/修正的前任）
  content_tokens TEXT,                             -- 对应分词快照，便于回溯其可检索性
  reason        TEXT NOT NULL
                CHECK (reason IN ('merge','manual_fix')),
                                                   -- merge（被合并替换的旧版） / manual_fix（被显式纠正的旧版）
                                                   -- 枚举由 CHECK 强制。不是形式主义：一个再无发射点的枚举值（如旧的 'merge_variant'）
                                                   -- 会因为没有约束而一直活在注释与文档里（死枚举）。
  replaced_at   INTEGER NOT NULL                   -- 毫秒时间戳
);
CREATE INDEX idx_ch_memory ON content_history(memory_id, replaced_at);

-- 事件流表（只追加；**唯一例外**是 §8.2 的正文脱敏，且只允许改 payload.contentText 一个键）
-- 保证历史可追溯、可审计，调参时可完整重放
-- 注意：payload 中的正文属于「可脱敏区」，遗忘流程会按 §8.2 处理，详见该节
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL
                CHECK (type IN ('write','merge','restore','manual_fix','alias','touch',
                                'recall','link','pin','unpin','forget','sweep','config')),
                                                   -- 13 种，与 §8.4 对照表**逐字一致**。
                                                   -- 加新 type 必须同改三处：本 CHECK、§8.4 的表、
                                                   --   §8.1 的「动作 ⇄ events.type」对照表。
                                                   -- 为什么不但靠注释：拼错的 type（'Write' / 'recalls'）
                                                   --   会静默落库，重放时被当成未知事件跳过——
                                                   --   而 events 是「可完整重放」的唯一依据（§9.2）。
  memory_id     TEXT,                              -- 事件所涉记忆的 uuid（供遗忘脱敏**按索引定位**）
                                                   -- **刻意不设外键**：事件必须比记忆活得久。
                                                   -- 若设 ON DELETE CASCADE，forget(hard) 会把「曾经有过这条记忆」
                                                   -- 的骨架一并抹掉，重放与审计直接断链。
  payload       TEXT NOT NULL,                     -- 结构化 JSON，完整记录入参与计算快照（正文走 contentText 字段，可被脱敏）
  at            INTEGER NOT NULL                   -- 事件毫秒时间戳
);
CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_events_type ON events(type);
-- 遗忘/清理路径的定位索引（见 §8.2）：无此索引，脱敏只能靠 payload LIKE 全表扫
CREATE INDEX idx_events_memory ON events(memory_id) WHERE memory_id IS NOT NULL;

-- 全文检索虚拟表（FTS5 external content 挂载显式 rowid）
CREATE VIRTUAL TABLE mem_fts USING fts5(
  content_tokens,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0'
);

-- 触发器：同步保持 FTS 索引与 memories 一致
CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO mem_fts(rowid, content_tokens) VALUES (new.rowid, new.content_tokens);
END;

CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content_tokens) VALUES('delete', old.rowid, old.content_tokens);
END;

CREATE TRIGGER mem_au AFTER UPDATE OF content_tokens ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content_tokens) VALUES('delete', old.rowid, old.content_tokens);
  INSERT INTO mem_fts(rowid, content_tokens) VALUES (new.rowid, new.content_tokens);
END;
```

```sql
-- @schema  ★ **本块是建库脚本**（工具与人都以它为准）：
-- @example  （本块是示例片段，不参与建库）
-- ═══════════════════════════════════════════════════════════════  
-- 神经元交互：共激活表（记忆↔记忆的统计共现）  
-- ═══════════════════════════════════════════════════════════════  
-- ⚠️ **与 `edges` 的区别，两者不是一回事，混用会造成数据事故**：  
--   `edges`  = 实体↔实体的**语义关系**（张三 --住在--> 北京），有 predicate，是断言。  
--   `coacts` = 记忆↔记忆的**统计共现**（「她喜欢猫粮」与「她对猫粮过敏」被反复一起想起），无 predicate，是观测。  
--   把共现当语义用 → 「讲同一件事的两个人」会被当成「同一个事实」合并掉。  
--   把语义当共现用 → 语义边会因「被想起」而涨权，与 ADR-9「当下最准」打架。  
CREATE TABLE coacts (  
memory_a    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,  
memory_b    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,  
affinity    REAL NOT NULL CHECK (affinity >= 0.0 AND affinity <= 1.0),  
-- 共激活亲和度 0~1。与 COACT_AFFINITY_MAX=1.0 同步；  
-- 改动这个上界必须同时改这里的 CHECK，否则应用层钳制与库层约束不一致  
coact_count INTEGER NOT NULL DEFAULT 1 CHECK (coact_count >= 1),  
cause_flags INTEGER NOT NULL DEFAULT 0 CHECK (cause_flags IN (0, 1, 2, 3)),
-- ★ **位掩码**（不是枚举）：本条边**历史上被哪些机制建过**
--   bit0 (1) = 机制 A（批内自动，§4.11.2）；bit1 (2) = 机制 B（调用方显式声明）
--   3 = 两者都建过 ⇒ **位掩码能表达「两者都建过」**，枚举做不到。
-- ⚠️ ⚠️ **只置位、不清零**（历史事实不可撤销）⇒ 与 `affinity` 的衰减**解耦**：
--   边会衰减到 0，但「曾被显式声明过」是历史。
--   ⚠️ **行被淘汰时**（sweep 的 coacts 清理）**随行删除**——那时 affinity 已低于阈值。
--   ⇒ 与 `coactSkipped.hadActivationEvidence` **正好互补**：表里有的 = 写进去了。
-- ⚠️ **语义分层**：表侧 = **历史累计**；事件侧 `coactPairs[].source` = **本次来源**。
-- 累计共现次数。**只增不减**（它不是衰减量，衰减只作用于 affinity）  
last_active INTEGER NOT NULL,                  -- 上次共现时间戳（毫秒），衰减读它  
CHECK (memory_a < memory_b)                     -- 无序对规范化：强制 a<b。  
-- ⚠️ 没有这一条，同一对会存成两行（a,b 与 b,a），  
--   而簇的连通分量计算会把它们当成两条边 → 连通分量被算错  
);  
CREATE UNIQUE INDEX idx_coacts_pair ON coacts(memory_a, memory_b);  
CREATE INDEX idx_coacts_b ON coacts(memory_b, affinity DESC);  
-- 反向查邻居（簇内 topK 邻居直查用这个方向）  
CREATE INDEX idx_coacts_decay ON coacts(last_active);  
-- 淘汰扫描：按最后共现时间清理低频对

-- ═══════════════════════════════════════════════════════════════  
-- 涌现层：主题簇（由共激活图算出的连通分量）  
-- ═══════════════════════════════════════════════════════════════  
-- ⚠️ **它是缓存，不是定义**。定义永远是「共激活图上 affinity_eff ≥ COACT_AFFINITY_MIN 的连通分量」  
--    （§4.11.3）。删掉这两张表重建一次，结果必须**完全一致**——这是 §4.11.3 的不变量。  
--    存它是因为 100 万条下 union-find 是秒级操作，不可能放进召回热路径。  
--    这与「层级是算出来的不是存出来的」不矛盾：层级的定义源是 intensity（随时间变），  
--    簇的定义源是 coacts（共激活数据），存的都是**缓存**，不是**定义**。  
CREATE TABLE theme_clusters (  
cluster_id     TEXT PRIMARY KEY,                -- 簇 id  
cluster_version INTEGER NOT NULL,               -- 快照版本号，簇成员发生变更时 +1  
computed_at    INTEGER NOT NULL,                -- 本快照生成时刻（毫秒），用于回答「这个簇有多旧」  
member_count   INTEGER NOT NULL CHECK (member_count >= 0)  
);  
-- ★ v2.1：快照元信息用**单行表**承载（`CHECK (id = 1)`），
--   簇本体（theme_clusters / theme_cluster_members）是**当前快照**，每次重算**整表替换**（同一事务内）。
--   ⇒ **不做历史快照表**（不做存储翻倍，也就没有保留策略这个同款问题——
--     §4.9 的 content_history 已经付过一次「单调增长」的代价，别再叠一个）。
--   ⇒ **跨快照比较只在进程内做**：§7.2 面板 7 的「上次结果」是
--     **本次会话内上次打开面板时的结果**（进程内暂存，重启即失），
--     **不是**「上一版已发布快照」⇒ 面板必须常驻这条基准说明。
-- ★ 通用「缓存就绪」标记表：**不是**簇快照专用表的语义挪用。
--   用途：'archival_schedule_ready' / 'vector_buckets_ready' 等
--   ⇒ 「就绪标记」从一次性机制变成**可复用模式**。
--   ★ 顺带解决 `setParams({ARCHIVE_LINE})`（§9.4.3）：参数变更 → 置 ready=0
--     → 退回逐行精筛（**结果仍正确**，只是慢）→ 后台重建 → 置 1
--   ⇒ **参数变更从「阻塞操作」降级为「后台修复」**，且**不需要加列**。
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE cluster_snapshot_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表
  version        INTEGER NOT NULL,                    -- 快照版本号，每次重算 +1
  computed_at    INTEGER NOT NULL,                    -- 本快照生成时刻
  algo_version   INTEGER NOT NULL,                    -- 聚类算法版本；换算法必须递增
  min_affinity   REAL NOT NULL,                       -- 本快照用的边阈值
  max_raw_ratio    REAL,                          -- ★ 本次重算中 union-find 跑完、切分之前的
                                               --   最大原始连通分量占比（**中间量**，落表才能对外暴露——
                                               --   重算读到的是切完之后的图，算不出原始占比；§4.12.4 ③）
  last_split_at        INTEGER,                     -- ★ 最近一次兜底切分的时刻（事件元信息）
  last_split_reason    TEXT,                        --   同上：触发原因（如 'max_share_exceeded'）
  last_split_threshold REAL,                        --   同上：触发时**当时的**阈值值
  last_split_blocks    INTEGER,                     --   同上：切成了几块
                                               -- ⚠️ 这四列**只记「最近一次」**——语义纯净。
                                               --   **不记历史峰值**（running-max 需要混合语义 ⇒ 不要）。
                                               --   「内容有多重复」由 max_raw_ratio（当前量）回答。
  cluster_count  INTEGER NOT NULL,                    -- 簇数
  member_count   INTEGER NOT NULL                     -- 成员总数（整表重建时 COUNT 出来 ⇒ 天然精确）
);
-- ⚠️ ★ **刻意不设到 `memories` 的外键**（冻结快照）：
--   已发布的簇快照是**某一时刻的划分**，它的成员行**不该**被硬删/软删级联改写
--   —— 否则「两次相同查询之间簇跳候选集会变」，§4.12.3 的可复现性口径失效。
--   ⇒ **快照膨胀由「整表替换」解决**（每次重算在同一事务内替换全表），
--     不靠级联删除。
--   ★ 文档已有同款先例：§3 的 `events` 表**刻意不设外键**
--     （「事件必须比记忆活得久」）。
CREATE TABLE theme_cluster_members (  
cluster_id TEXT NOT NULL REFERENCES theme_clusters(cluster_id) ON DELETE CASCADE,  
memory_id  TEXT NOT NULL,  
-- ⚠️ ★ **刻意不设到 `memories` 的外键**（冻结快照）：
--   已发布的簇快照是**某一时刻的划分**，它的成员行**不该**被硬删/软删级联改写
--   —— 否则「两次相同查询之间簇跳候选集会变」，§4.12.3 的可复现性口径失效。
--   ⇒ 孤儿行由「整表替换」清理（每次重算在同一事务内替换全表）。
--   ⇒ 召时按 `deleted = 0` 过滤（§4.6 步骤 3 的准入闸门）。
--   ★ 与 `archival_schedule` 的**级联**策略相反，**理由不同**（C34）。
PRIMARY KEY (cluster_id, memory_id)  
);  
CREATE INDEX idx_tcm_memory ON theme_cluster_members(memory_id);  
-- 反查：这条记忆属于哪些簇（一条记忆可能同时在多个簇里——  
-- 连通分量是互斥的，但**衰减后**的边会分裂，同一记忆可能短暂属于两个簇）

-- ═══════════════════════════════════════════════════════════════  
-- 向量分桶（几何层）：IVF 检索加速用  
-- ═══════════════════════════════════════════════════════════════  
-- ⚠️ **与主题簇是两回事，绝不可混用同一个「簇」字**：  
--   主题簇（theme_cluster）由**共激活涌现**，是语义层的，回答「这几条记忆讲的是同一件事」。  
--   向量分桶（vector_cell）由**向量几何划分**，是物理层的，回答「这条向量落在空间哪个格子」。  
--   两者可以有关联（例如同一主题的记忆大概率落在相邻格子），但不可互相替代：  
--   用几何分桶做语义路由 → 语义相近但向量不相近的记忆召不回；  
--   用语义簇做几何路由 → 没有几何相似性保证，检索质量失控。  
-- ═══════════════════════════════════════════════════════════════════
-- 向量分桶（几何层）：两级 k-means 分桶，**桶归属与主表同事务**（§9.3.2）
-- ⚠️ 拆成粗/细两张表，而不是一张表加 level 列：
--   level + 自引用 parent_id 的方案里，「细桶必须属于某个粗桶」这条跨表不变式
--   **SQLite 的 CHECK 表达不了**（CHECK 只能看本行的列），只能靠触发器或应用层保证。
--   拆表后它变成**两张表之间的普通外键**，由 SQLite 引擎保证。
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE vector_coarse_cells (
  coarse_id   TEXT PRIMARY KEY,
  centroid    BLOB NOT NULL,                     -- 粗中心，Float32 小端、L2 归一化
  updated_at  INTEGER NOT NULL
);
CREATE TABLE vector_fine_cells (
  fine_id     TEXT PRIMARY KEY,
  coarse_id   TEXT NOT NULL REFERENCES vector_coarse_cells(coarse_id) ON DELETE CASCADE,
                                               -- ★ 细桶必须属于某个粗桶 —— 现在由**外键**保证，不再靠应用层自觉
  centroid    BLOB NOT NULL,                     -- 细中心，Float32 小端、L2 归一化
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_vfc_coarse ON vector_fine_cells(coarse_id);
CREATE TABLE vector_cell_members (
  fine_id   TEXT NOT NULL REFERENCES vector_fine_cells(fine_id) ON DELETE CASCADE,
                                               -- ★ 指向**细桶**（不再是粗桶；粗桶不挂成员）
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (fine_id, memory_id)
);
CREATE UNIQUE INDEX idx_vcm_memory_unique ON vector_cell_members(memory_id);
                                               -- ★ 唯一索引**同时**服务 `memory_id = ?` 的查找
                                               --   ⇒ 不需要再单独建一个非唯一索引（省一个索引的写放大）。
                                               -- ★ **一条记忆只属一个细桶**的最终防线。
                                               --   主键是 (fine_id, memory_id)，换桶时若只 INSERT 不 DELETE
                                               --   旧行，一条记忆会同时挂在两个桶上（候选集重复 + size 偏大）。
                                               --   这个唯一索引让它**写不进去**（而不是静默重复）。
```

```sql
-- @schema  ★ **本块是建库脚本**（工具与人都以它为准）：
-- @example  （本块是示例片段，不参与建库）
        SELECT name FROM sqlite_master WHERE type='table'
          AND name IN ('coacts','theme_clusters','theme_cluster_members','cluster_snapshot_meta',
                       'vector_coarse_cells','vector_fine_cells','vector_cell_members','archival_schedule');
```

---

## 4. 核心算法


### 4.1 强度衰减（纯函数）

```
effectiveStability(m) = m.stability × m.pin_factor          // 单位：天，作为时间常数 τ
Δt                    = max(0, now - m.last_access)          // 防时钟回拨：未来时间不产生加成
intensity(m, now)     = min(1, exp( -Δt / (effectiveStability(m) × 86400000) ))
```

★ **实现分层（v2.1 勘误 / ADR-P1-T07-DEC §10-A）——`86400000` 只有**一个**定义处**：  
- **`src/util/time.ts`** = 时间常量的**唯一定义处**（导出 `MS_PER_DAY = 86400000`）；  
- **`src/core/decay.ts`** = **re-export**（`export { MS_PER_DAY } from '…/util/time.js'`）⇒  
  ⚠️ **别名不是第二份定义**：re-export 只是把同一个常量换个名字暴露出去，**不得**在 `decay.ts` 里再写一遍字面量；  
- **任何模块都不得自己再写一遍 `86400000`**（§4.4 / §4.5 / §4.6 / §4.15 / §9.4 各处公式里的那个数，**一律引用它**）。  
⇒ **为什么要分层而不是各自定义**：C36「同一件事不得有两套口径」——两份副本一旦漂移**不报错**，  
  只表现为「记忆保鲜时长看起来不太对」/「归档判定提前或推后」，极难定位。  
⇒ **判定方式**：静态扫描「除 `src/util/time.ts` 外没有第二处 `86400000` 字面量」+  
  `decay.ts` 的 `MS_PER_DAY` 必须是 **re-export**（不是 `const MS_PER_DAY = 86400000`）。

- **量纲说明（避免「半衰期」误称）**：  
  `effectiveStability` 是负指数衰减的**时间常数 τ**，不是半衰期。  
  `intensity = exp(-t/τ)` 在 `t = τ` 时衰减到 `1/e ≈ 36.8%`；  
  真正的**半衰期 = τ × ln2 ≈ 0.693τ**。  
  即：stability = 1 天 → 半衰期约 16.6 小时；stability = 30 天 → 半衰期约 20.8 天。  
  本文档统一用「时间常数」，凡出现「半衰期」必同时给出换算，不允许混用。
- `intensity ∈ (0, 1]`，**必须有上界钳制**：`τ → 0`（stability 极小）或 `Δt` 为负（时钟回拨、测试注入过去时刻）  
  都会让 `exp(...) > 1`，进而使 §4.4 的层级判定错乱、§4.6 的 `0.30 × intensity` 越界。  
  两重防护：① `Δt = max(0, now - last_access)`；② 结果再 `min(1, ...)`。
  ⚠️ **v2.1 勘误（ADR-P1-T07-DEC §12.1）：这两道钳制在 `τ ≥ 0` 域是「互为冗余」的，
    原文「缺一不可」的说法不准确**——
  - ① 在前：`Δt ≥ 0` ⇒ `exp(-Δt/τ) ≤ 1` ⇒ ② 恒为**无操作**；
  - ② 在前：`Δt < 0` ⇒ `exp(-Δt/τ) > 1` ⇒ ② 把它拉回 **1**，与 ① 把 `Δt` 归零后的结果**逐位相同**。  
  ⇒ **在 `τ ≥ 0` 域**：任一道单独存在都足以保证 `intensity ≤ 1` ⇒ **删掉任一道，不改变任何可观测行为**。  
    **实测**：77 组 `(Δt, τ)` 网格（`τ` 全为正：含负 `Δt`、`Δt = 0`、`Δt/τ = 745/746 天` 的下溢边界、
    `τ` 从 1ms 到 1e15ms，以及 `τ = 0 且 Δt = 0` 的 `0/0 = NaN` 边界）⇒ **去掉任一道 ⇒ 0 处差异**。  
  ⚠️ **但 `τ < 0` 域（`stability` 为负的**越界输入**）不成立**：此时 `exp(-Δt/τ) > 1`
    ⇒ **`min(1, …)` 是唯一拦住越界的那道**（`max(0, Δt)` 归零的是 `Δt`、**不是 `τ`** ⇒ 拦不住）。  
    实测：`Δt=1, τ=-1` ⇒ 完整实现得 `1`、删掉 `min` 得 `2.718…`；`Δt=1e6, τ=-1` ⇒ 删掉 `min` 得 `Infinity`。  
  ⇒ **两个域要分开说**（⚠️ 别用一句「互为冗余」覆盖全部输入域）：
    · **生产域（`τ ≥ 0`）**：两道都留是**防御性 + 可读性**的选择（读代码的人一眼看到「Δt 不会为负、结果不会大于 1」），
      **不是正确性依赖** ⇒ **不要把「两道都必须存在」写成正确性论证**；
    · **越界域（`τ < 0`）**：`min(1, …)` 是**承重的** ⇒ 它不能被删 ⇒
      这正是 F-08 ② 的**负 τ 探针**（`τ < 0` 且 `Δt > 0`）能抓住「漏掉 `min`」的原因
      （该探针已落进 `tests/unit/decay.test.ts`，并写明了「生产域内不存在能区分二者的输入 ⇒ 越界输入是必要条件」）。  
  ⇒ **想真的守住 `intensity ∈ [0,1]`，要守的是行为而不是字面**（ADR-P1-T07-DEC §12.1 给了判据与**现状**）：
    值域断言（finite 且 ∈[0,1]，含边界输入）＋ `Δt < 0 ⇒ 1` ＋ `Δt = 0 ⇒ 1` ＋ 对 `Δt` 单调不增
    —— ⚠️ **这四条行为断言库里已都有**（`tests/unit/decay.test.ts`），**不需要**再补
    （「下溢成恰好 0」那条目前是本地 `Math.exp` 算的、未经 `intensity()` 公开入口 ⇒ 已交工程师-3 补）。  
    （`scripts/check-clamp.ts` 的静态扫描是**形状守卫**：它钉住源码写法。
    ⚠️ 精确地说：**在生产域（`τ ≥ 0`）它守不住行为**（等价改写会绕过它，而按上面的冗余性它本来也守不住什么）；
    **在越界域（`τ < 0`）它与行为探针互补**（一个钉写法、一个钉行为）——**两者并存，不互相替代**。）
- `pin_factor` 默认 1.0。强调时传入 `> 1.0`（如 3.0）。**只在强度计算时相乘，绝不回写 stability**；`unpin` 时将系数复原为 1.0，原记忆的历史稳定度增长完整保留。  
  **校验规则**：`pin()` 必须校验 `factor` 为有限数且落在 `[1.0, MAX_PIN_FACTOR]`（默认 5.0），  
  否则抛 `MemoryError.INVALID_INPUT`。数据库层同样用 `CHECK (pin_factor >= 1.0 AND pin_factor <= 5.0)` 兜底。
  - 传 0 会让 `effectiveStability = 0` 导致除零（intensity 变 NaN/Infinity）。
  - 传负数会让记忆强度随时间长**上升**。
  - **传超大值（如 1e9）同样必须拒绝**：它让这条记忆的有效寿命变成 `MAX_STABILITY × 1e9` 天，  
    实际等于「永生」——强度永不跌破归档线，每次召回都被捞出并排在最前，  
    而 §4.6 的粗筛对它也永久豁免。单条记忆就能污染整个召回结果。  
    上界取 5 是因为 `effectiveStability = 180 × 5 = 900 天`已足够表达「这条特别重要」。

**`pin()` / `unpin()` 的完整行为**（此前只定义了 `pin_factor` 的语义与校验规则，  
两个方法本身的行为从未给出——§8.4 的表却要求它们记事件，实现者无处可依）：

```
pin(id: string, factor?: number): void
unpin(id: string): void
-- 两者都不需要 now：只修改 pin_factor 这一列，不碰任何时间派生值
-- （与 setAlias 同理；stability / last_access 全程不动）

pin:
1) SELECT id, pin_factor FROM memories WHERE id = @id AND deleted = 0;
   不存在 → 抛 MemoryError.NOT_FOUND（软删的记忆不接受 pin）。
2) factor 缺省为 2.0；必须为有限数且落在 [1.0, MAX_PIN_FACTOR]（§4.1 校验规则），
   否则抛 MemoryError.INVALID_INPUT。**校验在查库之后、写库之前**——
   先写后校验会留下一条 factor 非法的行。
3) @prevFactor = m.pin_factor
   UPDATE memories SET pin_factor = @factor WHERE id = @id;
   -- ⚠️ **绝不同步写 stability**：pin_factor 只在算 intensity 时相乘（§4.1），
   --   直接改 stability 就无法撤销了（这正是用 pin_factor 而非直接改 stability 的原因）。
   -- ⚠️ **表里没有 `pinned` 列，也不要加**：`pin_factor > 1.0` 本身就是「是否被强调」的判据，
   --   另立一个布尔列等于同一件事存两份，两列一旦不同步（例如手工修库）就没有权威答案。
4) events(type='pin', memory_id=@id,
     payload={ id, factor: @factor, prevFactor: @prevFactor })
   -- prevFactor 记的是**改之前**的值：`pin` 可以被连续调用（2.0 改成 4.0 再改成 1.5），
   --   只看 factor 无法还原「原来是多强」。注意 unpin 不读这条事件——它自己 SELECT 当前
   --   pin_factor（步骤 1），事件的 prevFactor 纯粹是给人和重放看的。
   --   「这条记忆被强调过几次」也可由此追溯。

unpin:
1) SELECT id, pin_factor FROM memories WHERE id = @id AND deleted = 0;
   不存在 → 抛 MemoryError.NOT_FOUND。
2) @prevFactor = m.pin_factor
   若 @prevFactor == 1.0（本就未强调）→ **幂等返回，不写库、不记事件**：
   重复 unpin 不该在事件流里堆噪音（§8.4 硬规则 1 的同一条理由）。
3) UPDATE memories SET pin_factor = 1.0 WHERE id = @id;
   -- 复原系数即完成撤销：stability 全程未被触碰，历史增长完整保留（§4.1）。
4) events(type='unpin', memory_id=@id, payload={ id, prevFactor: @prevFactor })
```

**为什么 `unpin` 要记 `prevFactor` 而不是 `factor`**：unpin 后 factor 恒为 1.0，  
记 `factor: 1` 等于没记任何信息；记改前的值才知道「取消的是多强的强调」。

**`get(id, now?)` 的完整行为**（此前只散落在 §6 的签名注释里，实现者不知道  
`entities` 从哪来、`layer` / `intensity` 怎么算）：

```
get(id: string, now?: number): MemoryView | null

1) SELECT * FROM memories WHERE id = @id;
   -- ⚠️ **不过滤 deleted**：软删记录照常返回（deleted=true），
   --   查看器要列软删项、restore 前要确认状态，硬删的行才返回 null。
   行不存在（已硬删）→ 返回 null。
2) 组装 MemoryView：
   - content / kind / media_ref / media_type / stability / difficulty / pin_factor /
     confidence / source / created_at / last_access / access_count / deleted / deleted_at
     → 直接取自该行。
   - entities: 另查关联表——**`entities` 不在 memories 表里**：
       SELECT e.name FROM memory_entities me JOIN entities e ON e.id = me.entity_id
        WHERE me.memory_id = @id ORDER BY e.name;
     结果是**实体名数组**（不是 id）：MemoryView 是给人看的视图。
   - effectiveStability = stability × pin_factor
     intensity = min(1, exp(-max(0, now - last_access) / (effectiveStability × 86400000)))
     layer     = 按 §4.4 的阈值分段（intensity > THRESHOLD_L3 → 'L3'，依此类推）
   -- ⚠️ layer / intensity 是**时间派生值**，必须在读取时现算，库里没有这两列。
   --   `now` 缺省取当前时间；注入它才能测「这条记忆此刻算不算归档」。
3) 返回该 MemoryView。**不返回 score / breakdown**——单条读取没有「本次检索」的语境，
   那两个字段只在 recall 的上下文里有意义（§6 Hit 的说明）。
```


### 4.2 稳定度增长（记忆加固）

> ⚠️ 核心防线：**被检索（recall）不等于被使用（touch）。**  
> 纯召回操作默认只读；只有当调用方确认将记忆实际注入或采纳时，才触发加固（或配置 `reinforce: true`）。

**全库唯一的 `stability` 写入点**：

```ts
/**
 * 增长一条记忆的稳定度。除本函数外，任何地方都不得写 `m.stability`。
 *
 * @param baseGrowth 基础倍率。touch 传「难度加成」；去重合并传 DEDUP_BOOST。
 * @param useSpacing 是否叠加「分散重复」加成。touch = true；合并 = false
 *                   （合并只是「又提了一次」，不是一次间隔重复，不该拿间隔加成）。
 *
 * 三个约束全部封在这里，调用方无从绕过：
 *   · 同日守卫（intervalDays < 1 不增长）—— 两条路径共用
 *   · MAX_STABILITY 上限钳制
 *   · last_access / access_count 一并更新，不留给调用方
 *   · **数据库写回也在函数内完成**——调用方不会漏 UPDATE
 *
 * @returns intervalDays（调用方要记进 events payload）与 boosted（是否真的涨了）
 *          这两个值调用方自己算不出来：intervalDays 依赖旧 last_access，
 *          boosted 要比较前后值。函数不返回，事件流就会缺字段。
 */
function growStability(
  db: Database, m: Memory, baseGrowth: number, useSpacing: boolean, now = Date.now(),
): { intervalDays: number; boosted: boolean; stabilityDelta: number } {
  const intervalDays = Math.max(0, now - m.last_access) / 86_400_000
  const before = m.stability
  m.last_access = now
  m.access_count += 1

  // 同一场对话/同一天内的重复提及：不属于间隔重复，不增长
  let boosted = false
  if (intervalDays >= 1.0) {
    // 隔天及以上的间隔效应（艾宾浩斯分散重复）
    // 隔 1 天 = 1.0，隔 2 天 = 2.0，封顶 SPACING_CAP（默认 2.0）
    const spacing = useSpacing
      ? Math.min(SPACING_CAP, 1 + Math.log2(intervalDays))
      : 1
    m.stability = Math.min(MAX_STABILITY, m.stability * baseGrowth * spacing)
    boosted = m.stability > before
  }

  // 写回数据库**在函数内完成**：调用方无须自行 UPDATE。
  // 漏写不会报错，只会让加固静默失效——那是最难查的一类 bug。
  db.prepare(
    'UPDATE memories SET stability = ?, last_access = ?, access_count = ? WHERE id = ?',
  ).run(m.stability, m.last_access, m.access_count, m.id)

  // ★ v2.1：`stabilityDelta` 也必须返回 —— 调用点算不出 `before`
  //   （它是函数内局部变量）⇒ 若函数不返回，**事件流就会缺这个键**
  //   ⇒ §8.4 规则 5 的对账恒等式（Σ 库内变化 == Σ 事件里的 delta）恒不成立。
  //   ⚠️ **调用方不得用 `boosted` 反推 delta**（一个是布尔、一个是数值）。
  //   ★ 未增长时为 0，**键恒在**。
  const stabilityDelta = m.stability - before
  return { intervalDays, boosted, stabilityDelta }
}
```

**touch 路径**（难度效应：difficulty 越低，增幅越快；默认 1.5 + 0.5×(1-difficulty)）：

```ts
const difficultyBonus = DIFFICULTY_BASE + DIFFICULTY_SCALE * (1 - m.difficulty)
const { intervalDays, boosted } = growStability(db, m, difficultyBonus, true, now)
// 事件记录用返回的 intervalDays / boosted，不要另算
```

`touch(ids, now?)` 的完整形状（**批量**，逐条加固，最后统一强化边并留痕）：

```
事务开始
  0. 校验：SELECT id FROM memories WHERE id IN (@ids) AND deleted = 0;
     -- 取回的集合与传入的 ids 不等 → **抛 NOT_FOUND**（details.missingIds = 差集），
     --   一条都不加固、也不进入后续步骤（已提交的事务整体回滚）。
     -- ⚠️ 为什么必须显式校验而不是「取到几条算几条」：下面是 `m = 按 id 取出该条 Memory`，
     --   取不到时 m 是 undefined，下一行 `m.difficulty` 抛的是 **TypeError**——
     --   一个未类型化的崩溃，而不是「这条记忆不在了」这个调用方能处理的语义。
     --   也不能静默跳过：调用方以为自己确认了 20 条，实际只加固了 18 条，且没有任何回执。
     --   与 §4.1 的 pin/unpin 同口径：查不到（含软删）就是 NOT_FOUND（§11.2）。
  1. @results = {}                  -- 按 id 索引：{ intervalDays, boosted }
     for id of ids:
       m = 按 id 取出该条 Memory
       difficultyBonus = DIFFICULTY_BASE + DIFFICULTY_SCALE × (1 - m.difficulty)
       -- ⚠️ 必须在**循环内**按各自的 m.difficulty 逐条算。批量 touch 的每一条难度不同
       --    （DIFFICULTY_FIRST / DIFFICULTY_NORMAL / 置信度惩罚，见 §4.3），
       --    在循环外算一次再复用，等于给整批套同一个倍率——静默算错，结果仍像正常值。
       @results[id] = growStability(db, m, difficultyBonus, true, now)
       -- 内部自行写回；返回值按 id 收集，第 3 步直接取，不要重算（重算会与库内实际值漂移）
  2. R-EDGE-TOUCH（§4.5）：统计 + 一条 UPDATE 覆盖全部 @ids 的证据边 → @edgeCounts
  3. for id of ids: 记 events(type='touch', memory_id=id,
       payload={ id, reason:'explicit',
                 intervalDays: @results[id].intervalDays,
                 boostApplied: @results[id].boosted,   -- 字段名是 boostApplied，取的是 boosted
                 edgesReinforced: @edgeCounts[id] ?? 0 })   -- 无证据边时记 0，不要省略该键
  事务提交
```

- 顺序不可换：先加固再强化边，最后记事件（`edgesReinforced` 要读第 2 步的真实结果，不能预估）。
- 三条路径的 `reason` 取值不同：`touch()` 是 `'explicit'`、§4.9 步骤 2 的完全重复路径是 `'exact_repeat'`、  
  以及 `recall({ reinforce: true })` 走的是 `touch()` 这条（见 §4.6 步骤 4），是 **`'reinforce'`**（**不是 `'explicit'`**——理由不同、来源标记必须能区分，否则事后复盘分不清「调用方真的采纳了这批记忆」与「调用方只是开了 reinforce 开关」）。
- **`recall({ reinforce: true })` 会**走的是 touch 的「加固形状」**（§4.2 加固 + §4.5 R-EDGE-TOUCH 证据边强化）——**&#x4F46;【不建共激活边】**（§4.11.2 裁决）：否则每次 reinforce 都把本次 top-N 焊成一个团（它们对同一 query 响应得都好 ⇒ 共享实体/余弦达标），触发 §0.2 明令禁止的「topN 自我强化」。**：这是预期行为，不是副作用——采纳了这些记忆，

> **为什么收拢成单一函数**：本库有两条路径会增长稳定度——touch 与去重合并。  
> 它们最初各写各的公式，接连出过三次同类事故：合并路径漏套 `MAX_STABILITY`  
> 成了绕过上限的后门、合并路径绕过了同日守卫（webhook 重投 10 次能涨 13.8 倍）、  
> 以及两条路径的间隔语义不一致导致同一行为有两种结果。  
> 收拢后这三个约束**结构上不可能漏**——调用方只能传倍率，改不了守卫。


### 4.3 初始稳定度与难度

```
// 情绪加成：情绪越强烈，初次记忆越牢固
// emotion ∈ [0, 1]，由调用方从语音 ASR 语气或文本情感分析估算，缺失默认 0
// ⚠️ 越界值必须在入口钳制，不能假定调用方守规矩（ASR 置信度换算、情感分归一化都可能出 1.2 或 -0.1）：
//    emotion = clamp(input.emotion ?? 0, 0, 1)
// ⚠️ 结果必须再套 MAX_STABILITY —— 这是**第三个**能绕过稳定度上限的入口
//    （前两个是 §4.2 注释里记的合并路径漏钳制、以及 touch 的 baseGrowth 未封顶）。
//    emotion 若无上界校验，emotion = 100 会算出 201 天，直接越过 MAX_STABILITY = 180；
//    §3 的 CHECK 只要求 `stability > 0`，拦不住它，于是库里出现一条「生来就超过上限」的记忆。
initialStability = min(MAX_STABILITY,                       // ← 默认 180，与 §4.2 同一道上限
                       INITIAL_STABILITY × (1 + EMOTION_WEIGHT × emotion))
// 默认 1.0 × (1 + 2.0 × emotion) → [1.0, 3.0] 天（emotion ∈ [0,1] 且 MAX_STABILITY = 180 时永不触顶）

// 首因效应：针对关联实体的初次事实，难度更低（更易强化）
// 性能优化：通过 memory_entities 关联表对已解析的实体 id 进行查询。
// 若有实体（@linkedEntityIds 非空，定义见 §4.9 步骤 1——本节按 §4.9 的调用顺序执行，用的是那个值），
// 检查**任一**实体是否尚无任何关联记忆——「关于李四这是第一条」就该享受首因优待，
// 哪怕同一条记忆里的张三早已是老熟人。若为空（无实体）→ 用 DIFFICULTY_NORMAL，无依据给优待。
isFirstAboutEntity = (@linkedEntityIds.length > 0 && existsEntityWithoutMemory(@linkedEntityIds))
//   -- existsEntityWithoutMemory = EXISTS(SELECT 1 FROM entities e WHERE e.id IN (@linkedEntityIds)
//   --    AND NOT EXISTS(SELECT 1 FROM memory_entities me WHERE me.entity_id = e.id))
//   -- 不要写成 queryRelatedMemoryCount(...) === 0：那是「这些实体**总共**关联 0 条记忆」，
//   --   等于要求**全部**实体都是首次——「新人 + 老友」的记忆会拿不到首因优待，
//   --   而它恰恰是最该拿的那一类。且 EXISTS 命中即短路，比 COUNT 全扫快。
//   -- 也不要写成 `entityIds`：那是 §4.6 recall 的入参名，同名不同义。
baseDifficulty = isFirstAboutEntity ? DIFFICULTY_FIRST : DIFFICULTY_NORMAL   // 默认 0.3 / 0.5

// 置信度惩罚：低置信（自动抽取、含糊表述）的记忆一开始就更难记牢。
// 这是 confidence 唯一的作用点——它不进 §4.6 打分公式，而是通过 difficulty 影响后续所有强度计算。
// confidence ∈ [0,1]，缺省 0.7；confidence = 1 时无惩罚，= 0 时 difficulty 上抬 0.2。
initialDifficulty = min(0.95, baseDifficulty + 0.2 × (1 - confidence))
// ↑ 这个 0.95 在当前参数下**不可达**（baseDifficulty ≤ 0.5，上抬最多 0.2 → 最大 0.7），
//   是给「将来上调 DIFFICULTY_NORMAL」预留的兜底，不要因为「算不出来」就删掉。
```


### 4.4 层级判定（纯函数，不落库）

```
intensity > 0.7   (THRESHOLD_L3)                      → L3 活跃
intensity > 0.3   (THRESHOLD_L2) 且 ≤ 0.7             → L2 温和
intensity > 0.05  (ARCHIVE_LINE) 且 ≤ 0.3             → L1 冷却（可检索，但不主动提）
intensity ≤ 0.05  (ARCHIVE_LINE)                      → 归档（不进入主召回，但可被显式查询与被扩散唤起）
```

- **归档的两个例外通道**（否则「归档」会被误读成「永久消失」）：
  1. **显式查询**：`recall({ includeArchived: true })` → 见 §4.6 步骤 2 的参数化说明。
  2. **激活扩散**：`recall()` 返回的 `diffused` 字段可包含归档记忆，且带 `layer: 'archived'` 标记 → 规则见 §4.7 的 **R-ARCH-DIFF**。  
     这是有意设计（「想不起名字，但看到照片想起来」），不违反本节规则。
- **活跃度 vs 牢固度**：
  - `intensity` 代表当前瞬时**活跃度**（她现在多容易想起）。
  - `stability > 7 天` 才代表真正的**牢固度**（长久记忆）。
- **默认参数下的实际分层时长（务必先做这道算术，否则会以为分层坏了）**：  
  新记忆 `stability = INITIAL_STABILITY = 1 天`，跌到 `THRESHOLD_L3 = 0.7` 需  
  `Δt = τ·ln(1/0.7) = 1 × 0.357 天 ≈ 8.6 小时`；跌到归档线需 `τ·ln(20) ≈ 3 天`。  
  也就是说**默认配置下 L3 基本等价于「8 小时内说过的事」**，与「活跃层＝可主动提及」的产品语义未必吻合。  
  若要「L3 维持一天以上」，只有两条路：抬高 `INITIAL_STABILITY`（如 2~~3 天）  
  或下调 `THRESHOLD_L3`（如 0.4~~0.5）。二者都会连带影响归档速度，须一起看（见 §11.4）。
- 层级只影响对外交互策略，不改变存储物理状态：
  - **L3 活跃**：上下文丰富，可主动提及。
  - **L2 温和**：被动问答时直接引用。
  - **L1 冷却**：相关性极高时才呈现，不主动扩展。
  - **归档**：常规 query 默认过滤，防止旧信息污染工作上下文。  
    （过滤实现见 §4.6 `@archiveLine`；扩散例外见 §4.7 R-ARCH-DIFF）


### 4.5 边权重衰减与强化

```
Δt = max(0, now - e.last_active)
edgeWeight(e, now) = e.weight × exp( -Δt / (EDGE_STABILITY × 86400000) )
```

> **本文档的伪代码约定（适用于全篇，不只本节）**：
>
> - **数学/JS 式伪代码里的配置常量直接写名字**：`min(MAX_EDGE_WEIGHT, ...)`、`INITIAL_STABILITY` 等，  
>   它们是 `DEFAULT_PARAMS` 的键，读作「该参数的值」。
> - **凡是会被送进 SQLite 执行的片段，参数一律写成 `@名字`**（`@MAX_EDGE_WEIGHT`、`@now`、`@ids`）。  
>   裸写的名字会被 SQLite 逐字当成**列名**，执行时报 `no such column`——  
>   这类错误不会静默，但会在实现到那一步时突然冒出来，且看起来像「表少了一列」而不是「参数忘了绑定」。
> - 两者不是两套配置：`@MAX_EDGE_WEIGHT` 绑定的就是 `MAX_EDGE_WEIGHT` 的值。

- `EDGE_STABILITY` 默认 30 天，是**时间常数 τ**（不是半衰期）。  
  实际半衰期 = 30 × ln2 ≈ **20.8 天**，即一条边闲置约 21 天后强度减半。  
  （表述统一口径见 §4.1 的量纲说明。）
- 边的强化形式统一为：
  ```
  e.weight = min(MAX_EDGE_WEIGHT, e.weight + EDGE_REINFORCE_STEP)   // 默认 0.3（JS 伪代码，常量裸名）
  e.last_active = now
  ```
- **强化有且只有两个来源**（除此二者，任何地方不得写 `edges.weight`；唯一的第三种写入口是 §4.9.2 的合并迁移，那是搬迁不是强化）：
  ```
  ① link 重复同一三元组 —— 见下方「边的创建（link）」步骤 3 的 UPSERT
  ② touch 按「证据记忆」 —— 规则 R-EDGE-TOUCH，见下
  ```

**规则 R-EDGE-TOUCH（边随使用保鲜）**：

`touch(ids)` 在同事务内追加一步——把「以这些记忆为证据」的边各强化一次：

```sql
-- @example  （本块是示例片段，不参与建库）
-- ① 先统计（供 §8.4 的 touch 事件按 memory 逐条归因，见下）
SELECT memory_id, COUNT(*) AS n FROM edges WHERE memory_id IN (@ids) GROUP BY memory_id;

-- ② 再更新（一条语句覆盖全部 ids）
--     ⚠️ 参数一律写成 @名字。`MAX_EDGE_WEIGHT` 裸写进 SQL 会被 SQLite 逐字当成**列名**，
--        执行时报 `no such column: MAX_EDGE_WEIGHT`——不是静默错，但会让整条 touch 抛错回滚。
UPDATE edges
   SET weight      = min(@MAX_EDGE_WEIGHT, weight + @EDGE_REINFORCE_STEP),
       last_active = @now
 WHERE memory_id IN (@ids);
```

- **语义**：一条边之所以存在，是因为某条记忆提供了这个关系（`edges.memory_id`）。那条记忆被反复确认采纳，说明它承载的关系仍然有效。这实现了本规则原来那句「两端实体所属记忆被确认采纳且沿图推进」所指向的意图——「沿图推进」本身不是独立动作，它就是「关联的记忆被采纳后，图谱跟着被确认」。
- **为什么按证据记忆，不按「两端实体」**：`edges.memory_id` 是单值，一条边只归属一条证据记忆，归因无歧义；而「两端实体所属记忆都被 touch 才算」在一次 `touch([A,B,C])` 里会退化成「A、B 的实体集合求交」，边界模糊且可能一条边都不命中。
- **`last_active` 必须无条件刷新，不能因为 `weight` 已满格就跳过**：`edgeWeight = weight × e^(-Δt/τ)`，衰减读的是 `last_active`。已封顶的边若不刷新 `last_active`，仍会随时间跌回阈值以下——那就等于「用得越多死得越快」，与规则意图相反。
- **边界**：`memory_id IS NULL` 的边（`link()` 的 `memoryId` 可选，允许无证据边）永远不会被 touch 强化，只能靠重复 link 增长。这是刻意的——无证据的边是「断言」而非「记忆」，不该因为某条记忆被采纳而变强。
- **代价（写放大，本规则唯一的成本）**：一次 `touch(ids)` 会更新这批记忆的**全部**证据边。若每条记忆平均有 10 条证据边、每次 reinforce 5 条，就是每次 50 行 `UPDATE`。  
  缓解不靠采样或频率限制——那会把「用得多就保鲜」变成概率事件，而 §4.2 的「被检索 ≠ 被使用」本来就要求**只在确实采纳时才 touch**。  
  真要压成本，正确方向是让上游少做无意义的 reinforce，而不是让强化打折。
- **对扩散窗口的影响**（与 §4.7 的 8.6 天临界点配合看）：`bonus ≥ ACTIVATION_MIN` 等价于  
  `w × e^(-Δt/30) ≥ 0.6`，即窗口 `Δt ≤ 30 × ln(w / 0.6)`。  
  `w = 0.8`（新边）→ 8.6 天；`w = 3.0`（封顶）→ 48.3 天。  
  **所以扩散窗口不是恒定的 8.6 天，而是这条边最近被强化到多高、以及多久没被强化。**

**边的创建（link）——名称与 ID 的转换规则**：

```
link(subject: string, predicate: string, object: string, memoryId?: string, now?: number, options?: { createMissing?: boolean })
linkByIds(subjectId: string, predicate: string, objectId: string, memoryId?: string, now?: number)

1) 名称 → entity_id 解析（**唯一实现是 resolveEntity()**，定义见本节末尾）：
     resolveEntity(db, name) → entity_id | null
       ① SELECT id FROM entities WHERE name = @name;                 -- 主名直接命中
       ② SELECT entity_id FROM entity_aliases WHERE alias = @name;   -- 别名命中
       ③ 均未命中 → 返回 null（**函数到此为止：不建实体、不抛错、不写库**）
       ① 优先于 ② 是刻意的：主名是权威命名，别名表冲突时以主名为准
       （此冲突由 §4.9.2 的 setAlias 校验拦住，正常路径下不会同时存在）
   返回 null 时**各调用方语义不同，不要试图统一——统一才会出错**：
     - link（本节步骤 2）：按 options.createMissing 决定建实体或抛 NOT_FOUND（整条失败、事务回滚）
     - recall（§4.6 步骤 1）：该名称仅参与文本路，不进图谱路（**查询路径禁止写库**）
     - write（§4.9 步骤 1a）：视为新实体，用该名称作主名走 ON CONFLICT(name) UPSERT
   两个端点各解析一次。**解析结果先落在两个「可能为 null」的变量里**——
   步骤 2 会为 null 的那些补建实体并回填，所以最终的 @subjectId / @objectId 在步骤 2 结束时才齐备：
     @subjectIdRaw = resolveEntity(db, subject)   -- null = 该名称尚不存在
     @objectIdRaw  = resolveEntity(db, object)    -- null = 该名称尚不存在
     @now       = 入参 now ?? Date.now()      -- 同 §11.1：所有时间戳走注入时钟，缺省取真实时钟
     @memoryId  = 入参 memoryId（可为 undefined，表示这条边没有证据记忆）
   ⚠️ **不要写成 `@subjectId = resolveEntity(...) ?? 步骤 2 建出的 id`**：
   那样的写法在步骤 1 就引用了步骤 2 的产物——步骤 2 此时还没执行。
   正确的形状是「步骤 1 解析出两个 Raw，步骤 2 建实体后回填成最终的 @subjectId / @objectId」，
   详见步骤 2 末尾的回填说明。

   **另一处 `entities WHERE name` 不属于本函数**（防止误收拢）：
   §4.9.2 的 setAlias 步骤 1 也查 `entities WHERE name`，但它的语义是
   **「检测冲突并抛 CONFLICT」**，与这里「解析成 id」恰好相反。
   若把它也收进 resolveEntity，setAlias 会把「命中」当成成功返回，冲突检测静默失效。
   —— 见 §4.9.2 步骤 1 的说明。

   ⚠️ **v2.1 勘误（ADR-P1-R2 ②）：`memoryId` 的存在性自校验属于「只读校验」，
      必须排在**第一次写入之前** —— 校验次序写死为**五步**：
      ① 两端名称解析（只读）→ ② `memoryId` 存在性自校验（只读，`AND deleted = 0`）
      → ③ 步骤 2 建实体（**写**）→ ④ 自环校验（必须在 `@subjectId` / `@objectId` 回填之后）
      → ⑤ 步骤 3 UPSERT（**写**）。
      ⇒ 理由：自环校验**结构上**必须在解析之后（它比较的是两个 `entity_id`），
        所以**唯一能提前的只读校验**就是 `memoryId` 校验 ⇒ 把它提前，
        是唯一能做到「失败时零副作用（连回滚都不需要）」的位置。
      ⇒ **代价（明写）**：同时传「坏 `memoryId`」与「自环」时，
        **先报 `NOT_FOUND`（memoryId 不存在）**，而不是 `INVALID_INPUT`（自环）——
        这是**有意为之**，不是偶然；两个错误都要改，但一次只暴露一个。

2) 缺失实体的处理策略（**必须与 write 一致：write 会自动建实体，link 默认同样自动建**）：
   - options.createMissing !== false（默认）：自动创建实体（type='concept'，与 write 的默认一致），
     @autoCreatedEntities = [本次实际新建的实体名, ...]      -- 无新建时为 []
     建实体必须**取回 id**（步骤 1 的 @subjectId / @objectId 依赖它）：
       INSERT INTO entities(id, name, type, created_at) VALUES(<新 uuid>, @name, 'concept', @now)
       ON CONFLICT(name) DO UPDATE SET name=excluded.name
       RETURNING id;
       -- ON CONFLICT 分支不是多余的：两个端点同名、或并发下已被别人建过时，
       -- 裸 INSERT 会撞 entities.name 的 UNIQUE；这里要的是「拿到 id」而不是「必须新建」。
       -- 走 DO UPDATE 分支拿到的是既有实体的 id，此时**不应**把它算进 @autoCreatedEntities。
     供**步骤 3 的统一事件**写入 payload（便于事后审计）。
     —— 事件只在步骤 3 记一次，不要在这里另记：两处各记一次会让一次 link 产生两条 link 事件。
   - options.createMissing === false：抛 MemoryError.NOT_FOUND，不产生任何写入（整条 link 失败，事务回滚）。
   - 明确禁止「一边自动建、一边抛错」的混合策略——两个 API 对同一输入必须给出相同结论。
   —— ⚠️ ★ **`details` 里的键名按「装的是 id 还是名字」分开**（v2.1 勘误）：
     · **端点缺失**（上一条分支）⇒ 端点的入参是**名称** ⇒ 记 **`details.missingEntityNames`**
       （装缺失的端点**名**），**不要塞进 `details.missingIds`**——
       `missingIds` 这个键名的语义是「缺失的**行 id**差集」（`src/core/errors.ts` 的
       `MISSING_IDS_KEY`；§11.2 的 FK 兜底句「FK 违规 ⇒ NOT_FOUND（带 `details.missingIds`）」
       也是这个意思，因为本库所有 FK 列都是 **id 引用**）
       ⇒ 让它装名字，等于同一个键名在 `touch` / `linkByIds`（装 id）与 `link`（装名字）
       下表达两件事 ⇒ 与 §14.3.1 的 C36「同一件事不得有两套词」同源。
     · **`memoryId` 缺失** ⇒ 那是**记忆 id** ⇒ 记 **`details.missingIds`**（与 `touch` /
       `linkByIds` 同族）。⚠️ **`link` 必须自己校验 `memoryId`**（§11.2 的自校验清单明写
       「`link` ⇒ `memoryId`（记忆）」）：`edges.memory_id` 有 FK，不校验会撞
       `SQLITE_CONSTRAINT_FOREIGNKEY`（未类型化，会原样穿给调用方，见 §11.2 的归一化收口）。
     ⇒ 一句话：**键名必须与内容同族**——「装 id 的叫 `missingIds`，装实体名的叫 `missingEntityNames`」。

   **回填 @subjectId / @objectId**（步骤 1 只解析，步骤 2 才定稿）：
     @subjectId = @subjectIdRaw ?? （为 subject 新建/复用到的实体 id）
     @objectId  = @objectIdRaw  ?? （为 object  新建/复用到的实体 id）
     两个端点**各自独立**处理：Raw 非 null 的直接沿用（不建），Raw 为 null 的才走上面的 INSERT。
     ⚠️ 两个端点可能是**同一个名称**（`link('张三','关联','张三')`）：
        此时第一个端点 INSERT 建出 id=1，第二个端点的 INSERT 走 ON CONFLICT(name) DO UPDATE
        分支、拿回**同一个 id=1**——正是它让下面的自环校验能抓住这种情形。

   自环校验（**必须在步骤 2 回填完 @subjectId / @objectId 之后、步骤 3 写入之前**）：
     若 @subjectId === @objectId → 抛 MemoryError.INVALID_INPUT（details = { subjectId, predicate }）。
     ⚠️ **抛错会回滚步骤 2 已建的实体**——整条 link 在一个事务里（§9.2），
        抛异常即回滚，库里不会留下那个为「自环」而建出来的孤儿实体。
        前提是**建实体与写边在同一事务**：若实现时把建实体单独提交（为了拿到 id 而提前 COMMIT），
        回滚就失效，会留下一个只被这一条失败 link 顺带建出来的实体。
        —— 这就是「校验必须在写库之前、且与写库同事务」的意义所在。
     —— 为什么不能在步骤 1 用名称比较：`link('张三', '关联', '老张')` 两个名字不同，
        但「老张」是「张三」的别名（§4.9.2），解析后是同一个 entity_id。按名称判永远漏。
     —— 为什么是抛错而不是静默跳过：调用方会以为关系建好了。自环在扩散里 neighbor 恒为自己
        （§4.6 步骤 5），这条边永远不产生任何邻居，只在图里占位，还白占一次写入与一条 link 事件。
     —— 这与 §4.9.2 步骤 2b「合并产生的自环必须清掉」是同一条规则的两端：
        那边清理历史遗留，这边拒绝新增。只清不拒，等于永远在擦地板。

3) 边的 UPSERT（edges 上有 UNIQUE(subject_id, predicate, object_id)，见 idx_edge_spo）：
   -- 参数一律 @ 前缀（同步骤 2 顶部的说明：裸写的名字会被当成列名）
   INSERT INTO edges(id, subject_id, predicate, object_id, memory_id, weight, last_active, created_at)
   VALUES(<新 edge uuid>, @subjectId, @predicate, @objectId, @memoryId, @INITIAL_EDGE_WEIGHT, @now, @now)
   -- ↑ 第一列必须显式给出新 uuid（`edges.id` 是 TEXT PRIMARY KEY，没有自增兜底）；
   --   不要写成 `...` 省略——省略掉的是主键，读者无从判断它从哪来。
   ON CONFLICT(subject_id, predicate, object_id) DO UPDATE SET
     weight      = min(@MAX_EDGE_WEIGHT, edges.weight + @EDGE_REINFORCE_STEP),
     last_active = @now,
     memory_id   = COALESCE(@memoryId, edges.memory_id)
   RETURNING weight;                   -- → @weightAfter（取回实际落库值，不要在外面再算一遍 min()：
                                       --   算错一处，事件里的 weightAfter 就与实际权重不符）
   ——重复 link 同一三元组不会产生重复边，而是强化既有边（幂等语义）。
   随后**无条件**记录事件：
   events(type='link', memory_id: @memoryId ?? null,
     payload={ subjectId, predicate, objectId, memoryId, weightAfter: @weightAfter,
               autoCreatedEntities: @autoCreatedEntities })    -- 步骤 2 实际新建的实体名，无则 []
   —— **每次 link 都记，不能只在「自动建了实体」的分支里记**：weight 是图谱强度的唯一载体，
      只在 autoCreate 分支记账会让「重复 link 强化了权重」这件事完全不留痕，重放时图谱强度无法复原
      （§8.4 硬规则 2 的同一条理由：状态变了就必须有记录）。

4) linkByIds 跳过步骤 1 的名称解析与步骤 2 的建实体，**但下面三项照常执行**：
   - `@now` / `@memoryId` 的赋值（步骤 1 尾部那两行）——否则步骤 3 的 SQL 里这两个参数没有值；
   - **自环校验**（同样按 id 比较，理由见上）；
   - 步骤 3 的 UPSERT 与事件记录（`@autoCreatedEntities` 恒为 `[]`，它不建实体）。
   **实体存在性必须自己校验，不能指望外键**：
     对 @subjectId / @objectId 各执行 `SELECT 1 FROM entities WHERE id = @x`；
     任一缺失 → 抛 MemoryError.NOT_FOUND（details.missingIds），不写入任何东西。
     ★ **记忆存在性同理**：`edges.memory_id` 有 `REFERENCES memories(id)`（§3），
       而 @memoryId 是**调用方给的 id**、本库不校验 ⇒ 不存在的 id 会撞 FK，
       并把 `SQLITE_CONSTRAINT_FOREIGNKEY` 原样穿给调用方（违反 §11.2「客户端只看到规范化的错误结构」）。
       ⇒ 传了 @memoryId 时必须先 `SELECT 1 FROM memories WHERE id = @x AND deleted = 0`；
         查不到 → 抛 MemoryError.NOT_FOUND（details.missingIds），不写入任何东西。
     —— 为什么不能靠外键兜：① FK 报的是 `SQLITE_CONSTRAINT_FOREIGNKEY`，未类型化，
        会原样穿到调用方（违反 §11.2「客户端只看到规范化的错误结构」）；
        ② 更隐蔽的是——`PRAGMA foreign_keys` 是**每连接**开关（§9.1），只要哪条连接漏开，
        这里会**静默写入一条指向不存在实体的边**，之后扩散永远查不到邻居，且不报任何错。
```

**`resolveEntity()` —— 名称 → canonical entity_id 的唯一实现**

三处调用点（§4.5 link / §4.6 recall / §4.9 write）共用这一个函数。

```ts
/**
 * 实体名 → canonical entity_id。
 *
 * 只读：不建实体、不抛错、不写库。未命中返回 null，由调用方按各自语义处理。
 * 主名优先于别名（① 先于 ②）。
 *
 * ⚠️ 不要给它加 createMissing 参数——加了就得在每个调用点判断该不该传 true，
 *    等于把「返回 null 后怎么办」的分叉从显式变成隐式，而那正是最容易出错的地方。
 */
export function resolveEntity(db: Database, name: string): string | null {
  const byName = db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: string } | undefined;
  if (byName) return byName.id;
  const byAlias = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?').get(name) as { entity_id: string } | undefined;
  return byAlias?.entity_id ?? null;
}
```

**为什么只收拢 ①②、不收拢 ③**：

①② 是纯粹的「查名字 → 拿 id」，三处字面完全一致，抽出来零行为变化。  
③ 是「查不到怎么办」，三处语义**恰好相反**：

| 调用点      | ③ 的行为                           | 若统一 ③ 会怎样           |
| -------- | ------------------------------- | ------------------- |
| `link`   | 按 createMissing 建实体或抛 NOT_FOUND | —                   |
| `recall` | 仅参与文本路，不进图谱路                    | 查询路径凭空创建实体 → **写库** |
| `write`  | 视为新实体并 UPSERT                   | —                   |

**recall 尤其危险**：§7.1 要求「只读实例绝不写库」，但那个约束是针对**事件写入**的短路，  
拦不住主表的 INSERT。统一 ③ 等于让一次**查询**创建实体。

**实体名归一化的责任归属**：本函数按**精确匹配**查找（`WHERE name = ?`），  
不做 trim / 大小写 / 全角处理。`input.entities` 来自外部 NER（ADR-2：库不做 NER），  
命名形式不受库控制——若调用方传入 `' 张三'`（带空格），会建出与 `'张三'` 不同的第二个实体。  
**因此：调用方负责提供稳定的实体名形式。** 库不为此加归一化列——  
两条 `UNIQUE(name)` 与 `UNIQUE(name_norm)` 并存会让「同名不同写」到底撞哪条变得含糊，  
而本库已有 `setAlias` / `mergeEntities` 两个显式修复入口（§4.9.2）处理这类分裂。

- **类型签名与存储字段的对应关系**：API 对外收 `string` 名称（调用方友好），  
  内部一律先转成 `entity_id` 再写 `edges.subject_id / object_id`（外键完整性）。  
  `edges` 表**不冗余存储实体名字**，名称变更（改名/合并别名）不影响边。


### 4.6 三路召回与融合打分

**三条候选路，一个打分公式。** 文本路（FTS5 bigram，精确）／向量路（语义）／图谱路（实体关联与共现）  
各自产出候选，合并去重后按同一个加权公式排序。

> ⚠️ **v2.0 的召回流水线比 v1.0 多两段，顺序不可换**：  
> **路由（步骤 0）→ 三路候选（步骤 2）→ 融合打分（步骤 3）→ 侧抑制后置（步骤 4.5）→ 排序截断（步骤 4）**。  
> 侧抑制是**后置**的，不进五因子公式（理由见 §4.11.3）——这是 v1.0「五项权重恒和为 1.0」得以保留的前提。  
> 路由必须在候选之前：100 万条下 flat 扫描要 500~1500ms，而分层路由（粗 200 中心 ≈0.2ms）  
> 能把它压进 P99 ≤200ms 的门槛内（§12 阶段 2 的性能门槛）。

两条铁律先写在前面，它们比任何权重都重要：

1. **三路只回答「谁可能是候选」，不回答「谁配被想起」。** 准入闸门（`deleted = 0`、`last_access` 粗筛窗口、  
   `intensity > ARCHIVE_LINE` 精筛）对所有路**一视同仁**，向量路也必须过同一道闸。  
   ⚠️ 这是向量化最容易踩的坑：若让向量绕过闸门，一条**早已淡忘**（intensity 0.01）的记忆会因为  
   「语义很像」被拉回 topN，等于**用相似度废掉了遗忘曲线**——那本库的两个核心卖点（遗忘 + 语义）  
   就互相抵消了。
2. **向量只进入 `score`，不改变任何准入判定。** 它排的是名次，不是资格。

```
输入：context（string）、topN（1~8，默认 5）、entityIds?、entityNames?、queryEmbedding?、includeArchived?、diffuseArchived?、reinforce?、explain?、now?
     ——字段全集以 §6 的 RecallOptions 为准。**不提供 source 过滤**（理由见 §6 字段说明）。
     queryEmbedding 缺省时由 MemoryConfig.embedder 现算（若也未配置，则本次不走向量路，见步骤 2c）。
     ⚠️ **`entityIds` 与 `entityNames` 互斥**（同时给 ⇒ 抛 `INVALID_INPUT`）—— 见步骤 1。

1) 实体抽取与别名消解
   ⚠️ **v2.1 勘误：原稿只写了「对上下文中抽取到的每个实体名称 n」，没写「名字从哪来」——
     这一步因此没有可实现的契约。下列三条把它写死（ADR-P1-T08-GAP-①）。**
   - **实体名由调用方提供，库不内置 NER**（ADR-2）：
     调用方把上下文里抽好的实体名放进 `RecallOptions.entityNames`；
     库**只**负责「名字 → entity_id」的归一（别名消解），**不负责「上下文 → 名字」的抽取**。
   - 对 `entityNames` 中的每个实体名称 n，调 `resolveEntity(db, n)`（§4.5 末尾，**唯一实现**）：
     返回 entity_id → 进图谱路；返回 null → **该名称仅参与文本路检索，不进入图谱路**
     （**查询路径禁止写库**：不得因为「名字不认识」就建实体）。
   - 结果去重后得到 @entityIds；调用方也可以通过 `RecallOptions.entityIds` 直接传入已解析好的 entity_id 列表，
     此时完全跳过本步骤（不再做名称匹配）。传入空数组 [] 等价于「明确表示无实体」，图谱路转空。
   - ⚠️ **`entityIds` 与 `entityNames` 互斥**：同时传 ⇒ 抛 `INVALID_INPUT`。
     （两者装的是**同一件事的两个阶段**；库若做优先级取舍，取舍那一边的动作就是
      **静默丢弃调用方的一半意图**——本设计一贯拒绝静默取舍（不静默回落 flat / 不静默走 ivf）；
      且「`[]` = 明确无实体」的语义也只在互斥时才无歧义。）
   - ⚠️ **两者都不传 ⇒ 图谱路为空**（本次调用退化为「文本路 + 向量路」）。
     这是 ADR-2 明写并接受的代价：「调用方不传就退化为纯文本检索，**功能仍完整**」。
     ⇒ **图谱路是「调用方显式点名才走」的路**，不是「库自己猜出来的路」。
   - 说明：entity_aliases.alias 为 PRIMARY KEY，`name` 与 `alias` 两次查询均为 O(log n) 索引查找，
     不再解析任何 JSON 数组列（`entities` 曾有的 `aliases` 冗余列已从 §3 删除，
     若保留它会退化为全表扫描）。

   ★ **为什么「库内抽取」（拿上下文扫全表找名字）不算数——对实现者的硬约束**：
   - **与 ADR-2 冲突**：库内做实体抽取 = 实体抽取归属搬回库里（哪怕实现成「对着自己的实体表做字典匹配」），
     调用方就再也控制不了「哪些词算实体」——那正是 ADR-2 要挡的事。
   - **与本步的成本模型冲突**：本步明写「两次查询均为 **O(log n) 索引查找**」
     ⇒ 成本模型是「**按名字索引查**」，不是「扫全表找名字」。
     库内抽取会把本步成本变成 **O(#实体 + #别名) 的行扫描**：10 万级实体上就是几十~几百毫秒，
     **一次调用就吃掉 §12 的整个 P99 ≤ 200ms 预算**（而这是**每次 recall** 都要付的）。
   - **与步骤 0 冲突**：路由只约束向量路。若把「实体抽取」挂在路由侧，
     则「向量路缺席」（没配 embedder / 分桶未训练）会连带**图谱路一起消失**——
     两条路被另一条路的前置条件绑死（本库最坏的一种耦合）。
   ⇒ 库**可以**提供一个**独立的**便利查询（例如「按上下文匹配已知实体名」的辅助函数），
     但它**必须由调用方显式调用**，绝不能成为 recall 流水线的隐式步骤。
   ★ **这个「口子」的三条硬条件**（ADR-P1-T07-DEC D-1）：
     ① **独立**：它**不在** recall 流水线里（流水线只做「名字 → id」的归一）；
     ② **显式**：只有**调用方主动调**它才算数（调用方自己决定要不要用、用不用都合法）；
     ③ **成本写在脸上**：文档必须写明它的成本 = **每次调用 O(#实体 + #别名) 行扫描**
       （子串匹配 ⇒ 短名/英文短词会误命中，无词边界）。
   ⚠️ **阶段 1 不实现它**（ADR-P1-T07-DEC D-1）：它不在 §12 阶段 1 的方法清单里
     ⇒ 实现它会把阶段 1 的范围扩到清单之外（本阶段只认清单内的方法）。
     ⇒ **本节只留口子**：让后人知道「这条路存在、怎么用、代价多少」，
     而不是以为「库本来就不做字典匹配」。

0) 向量路的两级分桶路由（v2.0 新增；**只作用于向量路**）
   目的：把向量路的「扫 100 万条」变成「扫几千条」，且**保持精确**——
   桶内是全量点积，不是近似召回。

   ⚠️ **路由只约束向量路；文本路与图谱路不经过路由。**
      这不是性能取舍，是三条硬理由：
      ① **文本路是 FTS5 精确检索**，本库最强的一条性质是「精确查那个报错码」。
         拿 `m.id IN (@routedIds)` 去筛它，等于让**几何邻近**否决**词法精确**：
         一条在 routedIds 之外、但 BM25 极高的结果会被静默丢掉。
      ② **图谱路走 B-tree 索引**（`memory_entities` + `idx_me_entity`），本身就不慢；
         加 routedIds 只是多一层无谓的约束。
      ③ **routedIds 有几千个 id**：`IN (几千个)` 在 SQLite 上要么撞绑定变量上限
         （老版本默认 999），要么退化成几千次索引查找——比它省下的还多。
      ⇒ **路由是向量路的内部实现细节，不是召回流水线的公共前置阶段。**

   ⚠️ **先判 `VECTOR_ROUTER`**（§5 的第五个开关，三值 `'auto' | 'ivf' | 'flat'`）：
   ★ **判定顺序（自动优先，backend 的方案）**：
     ① **未命中 `ROUTER_MIN_TRAINING`**（库规模太小）⇒ `'auto'` / `'flat'` ⇒ 走 flat；
        显式 `'ivf'` 在此时**照建桶 + 走两级分桶 + 记一条 warn 日志**
        （「库规模低于建桶门槛，IVF 收益未经验证」）—— **不静默回落**：
        静默回落 = 静默改写调用方的显式配置，那正是本文档反复反对的那类行为。
        ⇒ 而本库的 IVF 是**精确的**（桶内全量点积）⇒ 小库上强制 IVF **结果仍然正确**。
     ② 否则（规模 ≥ `ROUTER_MIN_TRAINING`）按 `VECTOR_ROUTER`：`'ivf'` / `'auto'` ⇒ 走两级分桶；`'flat'` ⇒ 走 flat。
        ⇒ **`'auto'` 在这里必须走 ivf**（否则它在两个分支里都等价于 flat ⇒ 成了死值，见下方 ★ 注）。
   ⇒ **同一库不会因实现不同而走不同向量路**。
   ★ **`'auto'` 必须真的自动**（否则它是个**死值**：两个分支里都等价于 flat）：
     规模 ≥ `ROUTER_MIN_TRAINING` ⇒ **走 ivf**；否则 ⇒ 走 flat。
   ★ **第三分支（堵一个静默失效）**：规模 ≥ 门槛 **且分桶尚未训练**（`vector_fine_cells` 为空）
     ⇒ **向量路整体缺席** + 记一条 warn（「跨过建桶门槛，尚未训练」）。
     ⇒ **不静默走 ivf**（桶表是空的 ⇒ 路由算得出桶号、桶内无成员 ⇒ **向量路恒空**）；
       **也不静默回落 flat**（那会改写调用方显式指定的 `'ivf'`）。
     ⇒ **训练完成前 `stats().vectorBackend.mode` 报 `'absent'`**（`inRetrain=false`）
       ⇒ 突变对调用方可见（§4.15.6 的状态②、§7.2 面板 1 的措辞）。
     ⇒ **触发训练的时机写死**：跨过门槛后的**首次 `open()`** 触发一次训练
       （1~3 分钟阻塞，§9.3.2 ④），训练完成后才切 ivf。
     ⚠️ ★ **此处不回落 flat 是有性能理由的，不是偷懒**：
       flat 在 100 万条下是**全表精确点积**（§4.15.3 记 500~1500ms），
       而 §12 的验收门槛是 **recall P99 ≤ 200ms** ⇒ 「静默回落 flat」会把
       **每一次召回**都拖进全表扫 ⇒ **直接击穿延迟门槛**。
       ⇒ **「缺席」既是性能上唯一自洽的选择，也是语义上唯一自洽的选择**
       （`flat_auto` 在 §6 已被定义为「未过门槛」，不能兼表「已过门槛但未训练」——
       否则同一个字面量要表达两种处境，正是 C36 要防的「两份副本可能不一致」）。
       ⇒ 文本路与图谱路照常工作，召回质量退化为「无向量路」（最高 0.75 分，§4.6 步骤 3），
       **且这件事可观测**（§14.1「向量路在分桶训练完成前静默缺席」条目的「必须可观测」要求）。
   ⇒ `'flat'` 才是真正回到 v1.0 的向量路（ADR-21 的基线组包含它）。

   步骤（仅当本次有 queryEmbedding 时执行；取法优先级见 §4.6 输入行）：
     a. 粗层：对 `ROUTER_COARSE_CENTERS`(200) 个**粗桶中心**算点积
        （200 × 768 ≈ 0.2ms），取最近 `ROUTER_NPROBE_COARSE`(20) 个粗桶
     b. 细层：在这 20 个粗桶下的细桶中心（每粗桶约 50 个，总 1 万）算点积
        （1000 × 768 ≈ 0.8ms），取最近 `ROUTER_NPROBE_FINE`(50) 个细桶
     c. 桶内：在命中的 50 个细桶内做**精确点积**，取桶内全部成员
        → 候选总量 = **50 个细桶 × 桶内成员数**。
          100 万条 / 1 万细桶 = 每桶 100 条 ⇒ 典型量级 **5000 条**。
          ⚠️ **不要写成「20 桶 × 50 细桶」**——粗桶是细桶的父级，不参与乘法；
          实际命中的是 50 个细桶，不是 1000 个。
     d. 桶内取完 → 交步骤 2c 做时间窗过滤与 top-N 截断
   ⚠️ **没有 queryEmbedding 时，本步骤整体不执行**——不是「退化成时间扇区」。
      向量路整条缺席（与步骤 2c 的降级规则一致），文本路与图谱路照常在全表上检索。
      **绝不能把路由扩成「无向量时的候选资格裁剪」**：那会让「没配 embedder 的库」
      连文本路与图谱路都被裁，并让 `includeArchived: true` 失效
      （路由按时间扇区排除了归档，而归档过滤的唯一开关就是 `includeArchived`）。
   ⚠️ **路由不参与打分，不改变权重**。它只决定「向量路从哪取候选」。
      若把桶距离也算进 score，等于让「几何邻近」压过「语义相关」——
      这正是 §4.6 铁律 1 禁止的事（向量绕过闸门），换了个形式犯同样的错。
   ⚠️ **桶为空时不做全表回退**：桶内无成员 ⇒ 该路没有候选。
      回退到全表扫描 = 500~1500ms，正是本步骤要避免的；而向量路缺席时
      文本路与图谱路仍在，recall 不会为空。
      **静默零召回是 P0，但那指的是「三路都没结果」，不是「某一路没结果」。**
      （§4.6 输入行已明说：无 queryVec 时向量路「整体缺席，不是向量分全 0 那种降级」。）

2) 三路候选召回（必须先排序再多取、再精筛、最后截断）
   前提：intensity 不是存储列，由 §4.1 公式运行时计算。**此处必须照抄 §4.1 的完整形式（含两重钳制）**：
     effectiveStability = m.stability × m.pin_factor                  -- pin_factor 在**分母内**（拉长 τ）
     Δt                 = max(0, now - m.last_access)                -- 时钟回拨保护
     intensity          = min(1, exp(-Δt / (effectiveStability × 86400000)))
   若只写 exp(-Δt/τ) 而漏掉 max/min，时钟回拨或注入过去时刻会让 intensity > 1，
   直接污染 0.30×intensity 这一项与 §4.4 的层级判定。
   为避免依赖 SQLite 数学函数扩展（exp 需 SQLITE_ENABLE_MATH_FUNCTIONS），
   采用「SQL 粗筛（last_access 上界）+ 应用层精筛（真实 intensity）」双层策略。

   includeArchived 参数化（对应 §4.4「归档仅显式查询可见」）：
     - includeArchived = false（默认）：按下面 ARCHIVE_LINE 推导 @coarseCutoff，精筛剔除 intensity ≤ ARCHIVE_LINE 的项。
     - includeArchived = true：令 @coarseCutoff = 0（不设 last_access 粗筛），
       **精筛阈值 @archiveLine 不参与判定**——归档模式下**不做强度精筛**，
       只保留 deleted = 0，归档记忆照常参与打分与排序（它们的 intensity 分项照常算，可能接近 0）。
       ——这是「显式查询归档层」的唯一代码路径，也是 §4.4 那句话的落地实现。
       ⚠️ **v2.1 勘误**：原稿写「精筛阈值 @archiveLine = 0.0，即只过滤 deleted = 0」——
         这**两句在数值上不等价**：精筛是**严格大于**（`intensity > @archiveLine`），
         阈值取 0.0 时会把**强度因 exp 下溢成恰好 0.0** 的记忆一并挡掉
         （下溢条件：Δt / τ > 745 天；而 schema 只要求 `stability > 0`，
          小 stability 的记忆几十小时就能下溢到 0）。
         ⇒ 那些行**已经被 SQL 粗筛放进来了**（归档模式下 @coarseCutoff = 0，没有时间窗），
         却在应用层被悄悄丢掉 ⇒「显式查询归档层」名存实亡。
       ⇒ **本版口径：归档模式下强度精筛整体不执行**（不是「阈值改成 0」，是「不做这个判定」）。
         ⇒ 三路一致（铁律①：准入闸门对三路一视同仁——归档模式下三路都**不**做强度精筛）。

   ★ **三个字面量的归属（刻意硬编码，不进 §5 参数表）**（C26：硬编码必须在正文写明）
   | 字面量 | 出现处 | 为什么不是参数 |
   |---|---|---|
   | `LIMIT 100` | 步骤 2a / 2b / 2c 的**预取**上限 | 它决定「**候选池有多大**」，不决定「谁有资格」；改它没有可验证的指标（改成 200 只会让精筛后的候选更多，不会让 topN 更准）；且它与同为硬编码的 `VECTOR_TOPK × VECTOR_OVERFETCH_FACTOR` 耦合 ⇒ 改一个必须改另一个 |
   | `slice(0, 20)` | 步骤 2a / 2b 的**每路**候选上限 | 同上：它是「每路送进融合打分多少条」的**形状**参数，不是语义阈值；改它改的是「哪几条能参与排名」，无法用单一指标验证好坏 |
   | `topN ∈ 1~8` | §6 `RecallOptions.topN` | 它是**公开 API 的取值域**，不是运行时旋钮：调小改的是「这次给你看几条」，与召回质量无关；放开上限会直接放大「向量只进 score」带来的 topN 自我强化风险（§0.2） |
   ⇒ 三者与「五项权重」「normBm25 斜率 0.2」同构 ⇒ 改它们是一次**设计变更**，走 §13 的 ADR，不是运行时配置。
   ⚠️ **实现时必须在代码里写明「这是刻意硬编码，不是漏做参数化」**（C26）。

   ★ **`SELECT m.*` 是伪代码：只 SELECT 用到的列**（正文写的与实现做的必须一致）
   - `memories.embedding` 是 **768 × 4 字节 = 3KB 的 BLOB**
     （`schema/001_schema_v2.sql`：`embedding BLOB CHECK (embedding IS NULL OR length(embedding) % 4 = 0)`）。
   - 每路预取 100 行 ⇒ `m.*` 会把 **100 × 3KB ≈ 300KB/路/次** 的向量原样搬进 JS 侧（三路合计近 1MB/次），
     而召回链路里**没有一处需要向量本身**（向量路的 `cos` 由桶内点积算出，§6 `MemoryView` 也「刻意不返回向量本身」）。
   - ⇒ 实现里必须**显式列出用到的列**，不得写 `m.*`。

   粗筛上界推导：intensity > ARCHIVE_LINE ⇔ now - last_access < effectiveStability × ln(1/ARCHIVE_LINE) × 86400000
     因 stability ≤ MAX_STABILITY、且 pin_factor ≤ MAX_PIN_FACTOR（§4.1），
     取**两档窗口**：
       普通记忆：@coarseCutoff       = now - MAX_STABILITY × ln(1/ARCHIVE_LINE) × 86400000
                 （默认 180 × ln(20) ≈ 539 天）
       被 pin：  @coarseCutoffPinned = now - MAX_STABILITY × MAX_PIN_FACTOR × ln(1/ARCHIVE_LINE) × 86400000
                 （默认 180 × 5 × ln(20) ≈ 2696 天）
     SQL 条件：
       (m.last_access >= @coarseCutoff
        OR (m.pin_factor > 1.0 AND m.last_access >= @coarseCutoffPinned))
     **为什么不给被 pin 的记忆「一律豁免」**：豁免意味着被 pin 的条目无论多旧都进候选集，
     pin 数量一多粗筛就退化成全表扫，再叠加 LIMIT 100 就会挤掉真正新鲜的匹配。
     两档窗口既保证不漏召（被 pin 的窗口足够宽），又让索引照常生效。

   a. 文本路（FTS5 bigram OR 检索 + 单字防御）：
      - 构造查询串：{ matchSql, fallbackLike } = buildMatchQuery(context)
      - 若 matchSql 有效：
        SELECT m.*, bm25(mem_fts) as raw_bm25
        FROM mem_fts JOIN memories m ON mem_fts.rowid = m.rowid
        WHERE mem_fts MATCH @matchSql AND m.deleted = 0
          AND (m.last_access >= @coarseCutoff
               OR (m.pin_factor > 1.0 AND m.last_access >= @coarseCutoffPinned))
        ORDER BY bm25(mem_fts) ASC      -- FTS5 bm25 返回负值，越负越相关；ASC 即最相关在前（显式写出，不依赖默认）
        LIMIT 100;                       -- 放大预取，留出精筛余量
        -- 注：不要给 mem_fts 起别名再写 bm25(mem_fts)/mem_fts MATCH，FTS5 辅助函数与 MATCH 必须引用可用表名（有别名时用别名），否则报 no such column。
      - 若 fallbackLike 有效（单字输入）：
        SELECT m.*, NULL as raw_bm25
        FROM memories m
        WHERE m.content LIKE ('%' || @fallbackLike || '%') ESCAPE '\'
          AND m.deleted = 0
          AND (m.last_access >= @coarseCutoff
               OR (m.pin_factor > 1.0 AND m.last_access >= @coarseCutoffPinned))
        ORDER BY m.last_access DESC
        LIMIT 100;
      - **两个都为空时（单个拉丁字母/数字，§10.2 分支 1b）文本路整体不执行**，候选只来自图谱路。
        判定顺序必须固定为：`matchSql` 非空 → 走 FTS；否则 `fallbackLike` 非空 → 走 LIKE；
        否则文本路候选 = `[]`。**不要写成「先判一个再无条件拼第二个」**——
        把 null 绑进 `mem_fts MATCH @matchSql` 或 `LIKE ('%' || null || '%')`，
        前者行为依赖 FTS5 版本、后者恒不命中，两种都是没法测的静默错误。
      - 应用层精筛：过滤 intensity(m, now) > @archiveLine，再 slice(0, 20)。
        （@archiveLine = includeArchived ? 0.0 : ARCHIVE_LINE）
        ⚠️ **归档模式下本精筛整体不执行**（`includeArchived = true` ⇒ 只保留 `deleted = 0`，
          见步骤 2 的 includeArchived 参数化）——**不是「阈值改成 0」**。
      - ⚠️ **v2.0 不给文本路加任何路由约束**（不加 `AND m.id IN (@routedIds)`）。
        文本路是 FTS5 精确检索，加了会让**几何邻近否决词法精确**——
        一条在路由结果之外、但 BM25 极高的结果会被静默丢掉。
        本库最强的一条性质（「精确查那个报错码」）必须与向量后端无关（理由见步骤 0）。

   b. 图谱路（1 跳实体关联）：
      - 根据上下文命中的 entity_ids（若为空则图路候选为空列表），从 memory_entities 关联表查询：
        SELECT m.* FROM memory_entities me JOIN memories m ON me.memory_id = m.id
        WHERE me.entity_id IN (@entityIds) AND m.deleted = 0
          AND (m.last_access >= @coarseCutoff
               OR (m.pin_factor > 1.0 AND m.last_access >= @coarseCutoffPinned))
        ORDER BY m.last_access DESC      -- 无文本相关度可用，按最近使用优先
        LIMIT 100;
      - 应用层精筛：过滤 intensity(m, now) > @archiveLine，再 slice(0, 20)。
        （entityIds 为空时直接跳过本查询，避免 IN () 语法错误）
        ⚠️ **归档模式下本精筛整体不执行**（`includeArchived = true` ⇒ 只保留 `deleted = 0`，
          见步骤 2 的 includeArchived 参数化）——**不是「阈值改成 0」**。

   c. 向量路（语义近邻，**v2.0 起走两级分桶 + 桶内精确点积**）：
   ⚠️ **v1.0 的 flat 全表扫描在 100 万条下不可用**：100 万 × 768 维点积 ≈ 500~1500ms，
   而召回门槛是 P99 ≤ 200ms（§12 阶段 2）。因此向量路改为**两步**：
   第一步（路由）由步骤 0 完成——粗 200 中心 → 细 1 万中心 → 命中桶；
   第二步（桶内检索）在命中桶内做**精确点积**。

   ⚠️ **本段 SQL 是「分桶后端的参考实现」**，归属 §4.15.2 的 `VectorBackend`，
     **不是流水线里的字面 SQL**。流水线只允许调用 `VectorBackend`：
       步骤 0 = `backend.route(queryVec, ROUTER_NPROBE_COARSE, ROUTER_NPROBE_FINE)`
       步骤 2c = `backend.search(queryVec, VECTOR_TOPK, filter)`
     ⇒ **流水线不得直接引用 `vector_coarse_cells` / `vector_fine_cells` /
       `vector_cell_members` 的表名**——这条规则守住 ADR-16 的「替换点收敛在一处」承诺
       （换后端实现时不必重写 §4.6 的整段）。
     ⚠️ `filter` 承载**准入闸门条件**（`deleted = 0` + 粗筛窗口），
       由 §4.6 步骤 2 统一构造后传入 —— 后端**不决定**谁有资格（§4.15.2 契约）。
   - 若本次有 queryVec（取法优先级见 §4.6 输入行）：
     SELECT m.*, <桶内点积> as cos
     FROM vector_cell_members vcm JOIN memories m ON vcm.memory_id = m.id
     WHERE vcm.fine_id IN (@hitCells) AND m.deleted = 0
       AND m.embedding IS NOT NULL      -- ★ **必须有这条**：桶里可能有 embedding 已被置 NULL 的行
                                        --   （正文被改写但没传新向量，§4.9.1）。对它算点积会得到 NaN，
                                        --   NaN 进 ORDER BY 会让**整条查询的排序失效**（SQLite 对 NaN 的比较是未定义行为），
                                        --   结果是召回静默返回乱序结果，不报错。
       AND (m.last_access >= @coarseCutoff
            OR (m.pin_factor > 1.0 AND m.last_access >= @coarseCutoffPinned))
     ORDER BY cos DESC
     -- ⚠️ **LIMIT 与 VECTOR_TOPK 的关系**：上层的 `LIMIT @VECTOR_TOPK` 是**准入门**，
     --   不是「打分阶段取几条」。真正的打分条数由 §4.6 步骤 3 的 `slice(0, VECTOR_TOPK)` 决定。
     --   两者含义不同：LIMIT 在 SQL 里先截断（按 cos 排），slice 在打分后截断（按五因子分排）。
     --   ⇒ **SQL 层要取够**：LIMIT 应取 `VECTOR_TOPK × VECTOR_OVERFETCH_FACTOR`（**本版硬编码 3**），
     --   否则闸门（`intensity > ARCHIVE_LINE`）会在 SQL 层就把候选滤光，
     --   应用层再 slice 就凑不满 VECTOR_TOPK 条。
     LIMIT @VECTOR_TOPK * 3;
     -- ⚠️ 桶归属（vector_cell_members）与主表在**同一个事务**里写，
     --    所以本查询**不存在索引与主库不同步的问题**（这是选分桶而非 sidecar ANN 的直接收益，
     --    对照见 §4.15.3 的选型理由）。
   - 若本次无 queryVec（整条向量路不执行，§4.6 输入行的降级规则）：
     **该路整体缺席**，不是「向量分全 0」那种降级。
   - 若本次有 queryVec 但**分桶未训练**（`vector_fine_cells` 为空）：
     **该路同样整体缺席**——缺席，**不是阻塞**。
     ⚠️ 这与 ANN sidecar 的「就绪闸门」**不是一回事**：那里是「索引未就绪 ⇒ 整路缺席且需重建」，
     这里是「**根本没建分桶** ⇒ 该路不执行，而文本路与图谱路照常」。
     ⇒ `routes.vector.ran = false` 会把两者统一呈现（查看器不区分原因，
     但面板 1 的健康度块会显示「分桶未训练」）。
   - 应用层精筛：**① 先过滤 `cos ≥ VECTOR_MIN_COS`(0.25)** —— §5 明写「低于此余弦的条目
     **不进候选**（不是得 0 分，是根本不出现）」；**② 再过滤 intensity(m, now) > @archiveLine**；
     **③ 最后 slice(0, VECTOR_TOPK)**。
     ⚠️ **归档模式下②整体不执行**（`includeArchived = true` ⇒ 只保留 `deleted = 0`，
       见步骤 2 的 includeArchived 参数化）——**不是「阈值改成 0」**；
       ① 与③ 与归档与否无关（前者管「像不像」，后者管「取几条」）。
     ⚠️ 三个过滤的**顺序不能换**：先按 cos 滤掉弱相关，再按强度滤掉归档，
     最后截断——若先按强度截断，会把 cos 更高但已被归档的候选切掉，挤掉本该保留的次优项。
   - ⚠️ **cos 必须钳制到 [0,1]**：向量已 L2 归一化 ⇒ 点积的理论范围是 [-1,1]，
     但**浮点误差可能给出 1.0000001**；不钳制会让 `cos ≥ VECTOR_MIN_COS` 在边界上不稳定。
     ⇒ `cos = min(1, max(0, dot))`。
   - ⚠️ **分桶改变的是「扫多少条」，不是「谁进候选池」**——这一条与 v1.0 的 flat 完全一致：
     - **桶内是全量精确点积**，不是近似召回。命中桶内的成员**全部**参与点积，
       再按 cos 排序取前 `VECTOR_TOPK`。因此**分桶不产生召回损失**——
       只要一条记忆与查询向量足够近，它的**粗桶**几乎必然被探到（但**粗桶命中 ≠ 细桶命中**，见 §4.6 步骤 2c 的「只漏、不错」）
       （粗层取 20 个最近粗桶、细层取 50 个最近细桶，探针数是参数，不是 1）。
       ⇒ **分桶与 flat 的 top-N 结果高度一致，但不是逐条相同**：
         探针覆盖充分时**吻合率 ≥ 0.98**（§12 阶段 2 的验收线）。
         ⚠️ **不要写成「完全相同」**——探针边界上的候选确实会不同，
         写死「完全相同」会让实现者以为「有个小 bug 导致结果不一致」。
         **准确的表述是：分桶不产生近似误差（桶内是精确点积），
         只产生探针边界效应（可测、可调）。**
       这是选分桶而非 ANN 的核心收益：**没有「ANN 召回率」这个指标要守**。
     - **但 `normBm25` 的基准与它无关**（这一点自 v1.0 起就没变）：
       §4.6 步骤 3 的 `medianBm25` 取自「`raw_bm25` **非空**的候选」——
       即**只有文本路命中的候选**。向量路命中的候选 `raw_bm25` 恒为 `null`
       （不参与中位数计算），而文本路完全不受向量路影响。
       ⇒ **median 基准逐位不变**，任何候选的五因子分逐位不变。
     - **推论：分桶路线下 `score` 与 flat 逐位一致，变化的只有「命中集合」的成员构成**
       （探针数不够时的边界情况），而 §4.6 步骤 2a 已保证文本路成员**完全不变**。
     - ⚠️ **文本路本身不受影响**：文本路是 FTS5 精确检索，与向量路无关。
       所以「精确查那个报错码」这类查询在分桶与 flat 下结果完全一致。
   - ⚠️ **探针数与召回的关系**（唯一的近似来源）：
     分桶的召回损失来自**探针数不够**：若真正的最近邻落在第 21 个粗桶之外，
     它就永远进不了候选。`ROUTER_NPROBE_COARSE`(20) / `ROUTER_NPROBE_FINE`(50)
     就是为此存在的旋钮。**这是分桶唯一的近似**，且它**可测**：
     用 flat 全表扫描作参照，断言「分桶的 top-20 与 flat 的 top-20 吻合率 ≥ 0.98」
     （§12 阶段 2 的性能门槛里含这一项）。

2.5) 候选去重合并
   - 将三路的候选按 `memory_id` 构建 Map，**同一个 id 只留一条**。
   - 同一条记忆可能被多路同时命中（「讲张三的文本又含张三实体、向量也近」是最常见的情形）：
     * **各路分数各自独立保留**，不合并、不取平均：`raw_bm25` 记词法分，`cos` 记语义分。
       它们是两个不同维度的证据，合并成一个数就再也拆不开了（`breakdown` 也就没法解释）。
     * 分别记 `fromText` / `fromVector` / `fromGraph` 三个来源标记——**只为排障与 `explain` 展示**，
       不参与任何计算（尤其不参与 `graphProximity`，见下一条）。
     * 避免同一条记忆占用两个 topN 名额，也避免它按出现次数重复贡献给 `medianBm25` 样本。
   - 某条记忆**没有 embedding** 时，它的 `cos` 就是「无此项」，不是 0 ——区别见步骤 3 的缺项规则。
   - **`graphProximity` 不在本步判定**——统一在步骤 3 按「实体交集」计算（见步骤 3 的说明）。
     **不要**在本步打标：会与步骤 3 的规则冲突——一条「只被文本路召回、但同样含相关实体」的
     记忆，按本步逻辑拿不到 1.0，而它恰恰是最该被召回的那一类（内容相关 + 实体相关）。
     同理，向量路引入后也**不要**按「来自哪条路」给 graph 分。
   - 去重后的候选集进入步骤 3 打分。

3) 融合打分公式
   总分 score = 0.30 × intensity
              + 0.25 × vectorSim
              + 0.20 × normBm25
              + 0.15 × graphProximity
              + 0.10 × recency

   **五项权重恒和为 1.0；缺项一律记 0，不重算分母。** 缺项规则见本节末，先看权重为什么是这几个数：

   - **intensity 0.30 仍是最大单项**：记忆库与普通 RAG 的分界就在「活着」这件事上，
     一条今天刚被用过的记忆，本来就该比一条半年前的更靠前。
   - **vectorSim 0.25 刻意低于 intensity**：向量最擅长的「语义相近」恰恰也是它最危险的地方——
     旧事实与新事实的语义高度相似（「已升级到 PG15」与「已升级到 PG17」余弦常在 0.95 以上）。
     若让向量压过活跃度，过期信息会稳定盖过当前信息，与 §4.9「当下最准」的取向直接打架。
     **权重低不等于不重要**：它决定的是「在同等活跃度下谁更相关」。
   - **normBm25 0.20，不删**。错误码、文件路径、版本号、人名这些，向量的表现远不如字面匹配
     （模型眼里 `ERR_2041` 与 `ERR_2047` 几乎是同一个点）。纯向量检索在这类查询上会输，
     而「我上次记的那个报错」恰恰是最常见的查询形态。
   - **graphProximity 0.15 / recency 0.10**：recency 压得低是因为它与 intensity
     高度相关（都是时间衰减），两者合计 0.40 已经足够，再多就是同一个信号投两次票。
   - **五个权重硬编码，不进 §5 参数表**：它们必须和为 1，单独调一个会让其余四项的相对比例失真；
     而且调它没有任何指标能验证好坏，与 normBm25 斜率 0.2 不开放的理由完全同构。
     改权重是一次**设计变更**，应走 §13 的 ADR，不是运行时配置。

   ⚠️ **权重的相对顺序有论证，具体数值没有基准数据支撑**：0.30 / 0.25 / 0.20 / 0.15 / 0.10
   是按上面四条理由先验排定的，**从未用真实查询回归过**。纠正方式是 §12 阶段 3 的回归，
   而不是在这里反复改数。
   vectorSim 的取值：
     - 有 embedding、且该行在向量路存活 → 步骤 2c 算出的 `cos`（已钳到 [0,1]）
     - 有 embedding、但本次调用没有 queryVec（整条向量路没执行）→ **全体候选一律 0**
     - 该记忆没有 embedding → **0**（是「无此项」，不是「此项为零分」——但计算上等同）

   ⚠️ **为什么不按缺项重算分母**：分母一旦随候选而变，分数就失去可比性——
     一条「只有三路命中、且三路都满分」的候选会算出 1.0，压过「五路命中、每路 0.8」的候选（0.8）。
     这正是「补偿稀疏候选」的经典翻车现场，而且它在测试里极难被抓到（两条记忆各自看都很合理）。
   ⚠️ **代价明写**：无 embedding 的记忆**理论最高分 0.75**（0.30 + 0.20 + 0.15 + 0.10）。
     它不会被永久埋没（0.75 仍高于一条各方面平庸、只是满配向量的候选），但**回填越晚越吃亏**。
     这是刻意的：让「没向量」成为一个能被观测到的劣势（`stats().embeddedRatio`），
     而不是悄悄让所有人分数都虚高。

   - normBm25 归一化（稳健相对排位）。**三条规则按下列顺序判定，先命中先返回**：
     符号约定：SQLite FTS5 的 bm25() 返回**负值**，越负表示匹配越好（更相关）。

     ① **文本路本次走的是 LIKE 单字兜底**（§10.2 的 `fallbackLike` 分支）：
        所有 LIKE 命中记忆视为同等相关，统一置 normBm25 = 1.0（不参与中位数归一）；
        raw_bm25 字段直接置 null（不使用 -1.0 哨兵值，避免与真实 bm25 负值混淆）；
        排序交由 intensity / recency / graphProximity 决定。
     ② 否则，若**去重后的候选集**中存在文本路命中（raw_bm25 非空）：
        bm25List = 所有 raw_bm25 非空的候选值数组（**未走文本路的条目必须排除**——纯图谱命中、纯向量命中，其 raw_bm25 为 null，不得以 0 或 -1 参与中位数计算）；
        medianBm25 = 该数组的中位数；
        normBm25 = 1 / (1 + exp(0.2 × (raw_bm25 - medianBm25)))；
        方向校验：raw_bm25 越负（越相关）→ 差值越负 → exp 越小 → normBm25 越接近 1，符合预期。
        （斜率 0.2 刻意硬编码，不进 §5 参数表：它只决定候选**内部**的相对排序陡缓，
         不改变任何绝对阈值；开放为参数等于把「归一化曲线的形状」变成可调项，
         调它没法用指标验证好坏，只会让不同实例的分数不可比。）
        未走文本路的条目（raw_bm25 为 null，含纯图谱命中与纯向量命中）在本次归一里严格置 0.0。
     ③ 否则（bm25List 为空、且不是 LIKE 兜底路，即整批都没走文本路）：
        全部置 normBm25 = 0.0。

     ⚠️ **为什么必须把优先级写死**：LIKE 兜底路的 `raw_bm25` 全是 null，
     而「纯图谱命中 → 0.0」那句话单看也罩得住它（它确实没有 bm25），
     只有括号里的「未命中文本路」把 LIKE 命中排除掉，才轮得到「LIKE 路 → 1.0」生效——
     一条 0.2 分的归属要靠一个括号救场，顺序读反就得到完全不同的分数。
     更要命的是若在 ② 内部写「数组长度 0 时跳过归一，全部置 0」：这句在 ② 里
     **永远不可达**（能进 ② 就说明 `bm25List` 非空），它唯一可能的实际效果就是被读成
     「LIKE 路的结果」，于是同一批 LIKE 命中同时有 1.0 与 0.0 两种说得通的结果。
     判据不该是「`bm25List` 是否为空」，而是「本次文本路到底走没走 FTS」：
     **兜底路的 0.2 分要给，因为它确实命中了文本，只是没有相关度可言**；未走文本路的才拿 0。
   - graphProximity（按**实体交集**判定，不按「候选来自哪条路」判定）：
     graphProximity = 1.0   当且仅当 memory_entities 中存在 entity_id ∈ entityIds
     graphProximity = 0.0   否则（entityIds 为空时恒为 0）
     **为什么不能用「是否由图路召回」代替**：图路候选有 `LIMIT 100`，一条记忆完全可能与上下文实体
     有交集、却因为最近使用时间排在第 100 名之外而没进图路候选。它同时是文本路的高相关命中，
     若按「来自哪条路」判，它的 intensity 与 graph 两项会被判 0，直接被挤出 topN——
     而它恰恰是最该被召回的那一类（内容相关 + 实体相关）。
     实现方式：对去重后的候选集做一次批量查询
       SELECT memory_id FROM memory_entities WHERE memory_id IN (...) AND entity_id IN (...)
     用返回集合打标，`O(候选数)` 而非逐条查询。
     注：**本规则是全库唯一判定处**。§4.6 步骤 2.5 只做去重与分数合并，**不打 graphProximity 标记**
     （若在 2.5 打标会与本节冲突：一条只被文本路召回、但实体确实相交的记忆拿不到 1.0）。
   - recency：
     Δt = max(0, now - m.created_at)
     recency = min(1, exp( -Δt / (RECENCY_DECAY_DAYS × 86400000) ))
     （基于创建时间，反映客观新近度；`RECENCY_DECAY_DAYS` 默认 14 天是**时间常数 τ**，
       对应实际半衰期 = 14 × ln2 ≈ 9.7 天。量纲口径见 §4.1。）

   - **为什么公式里没有 confidence**（与 §2 schema 注释一致，避免两处口径冲突）：
     五项权重之和恰为 1.0，再插一项会破坏这一整洁性；
     且 confidence 与 intensity 高度相关（置信度低的记忆通常也难被反复强化），再计分等于重复加权。
     confidence 要真正生效，走**写入侧**而非**打分侧**：
     在 §4.3 计算 initialDifficulty 时按 `initialDifficulty = min(0.95, baseDifficulty + 0.2 × (1 - confidence))` 施加惩罚，
     让低置信记忆一开始就"更难记牢"，从而在后续所有强度计算中自然体现。

4.5) 侧抑制后置筛选（v2.0 新增；**不进 score**，见 §4.13）
   输入：步骤 3 打分后的完整候选集 C（未截断），以及 topN。
   算法（**纯筛选，三桶 R / D / overflow**；完整定义见 §4.13.3）：
     ① 按 (score DESC, id ASC) 全序遍历 C。
        ⚠️ 排序键必须带 id：score 相同者按 id 字典序排。
           不加这条，抑制边界会随 SQLite 的返回顺序漂移 →
           「同一查询两次结果不同」，且**无法复现**。
     ② **前置判定 poolHomogeneous**（池级，进入遍历前算一次并固定）：
        「候选集里除最高分那条 C0 外，是否每一条都与 C0 冗余」。
        - **是**（整池同质）→ 全部候选进 R，**不做任何抑制**。
          理由：没有替代品，抑制只会让结果变少而不变得更好。
        - **否** → 逐条判断「是否与已保留集 R 中的某条冗余」：
          冗余 → 进 D（冗余池）；不冗余 → 进 R。
          判据见 §4.13.2（纯逐对，不用分组）。
     ③ R 满 topN 后，剩余候选进 overflow，**不再参与评估**。
     ④ **不做全局补位**：仅当 poolHomogeneous 为真时，
        取全序前 topN 条作为 hits（此时 suppressed 为空）。
        ★ **本节与 §4.13.3 的三桶模型是同一套规则的两种写法**——
          两处必须给出**同一个结果**（池级语义 ⇒ hits 3 条、suppressed 空）；
          若哪天两者读出不同结果，就是文档内部矛盾（QA 的 G11 闸门专查这条）。
        ⚠️ **为什么不做补位**：补位会把刚挤掉的近义内容又塞回上下文，
          **抑制的目的被自己抵消**。
     ⑤ 输出：hits = R（≤ topN），suppressed = D（**默认随结果返回**）。
   ⚠️ **三条不变式**：
     - `hits.length ≥ min(topN, min(2, |C|))` —— 抑制**永远不会**把结果压到 1 条以下；
     - `hits.length ≤ min(topN, |C|)` —— 不超过 topN；
     - **D 非空**时**不保证** `hits.length == min(topN, |C|)`（「宁少不冗余」是刻意的）。
   ⚠️ **抑制不写库**：本步骤只影响本次返回的排序结果，
     任何候选的 score 都不被修改（`Hit.score` 与 `rankScore` 是同一个数，见 §4.13.1 硬约束①）。
   ⚠️ **抑制不作用于 diffused**（§4.13.1 硬约束③）。

4) 排序取 topN（默认 5）
   - 若传入 reinforce: true，则触发 §4.2 对 topN 进行加固（**按 touch 的「加固形状」连带强化这些
     记忆的证据边**，见 §4.5 R-EDGE-TOUCH）——
     ⚠️ **只加固，不建共激活边**（§4.11.2 裁决；理由见 §4.2）。默认保持只读。
   - 事件记录：仅当 explain === true 时追加 events(type='recall', payload={ contextHash, topN, hitIds, scores, includeArchived, diffuseArchived, vectorUsed, suppressedIds, diffusedSeeds });  
     vectorUsed = 本次是否真的执行了向量路（有 queryVec 才算）。**恒带该键**：
     事后复盘「这次为什么没命中」时，第一个要排除的就是「向量路根本没跑」，
     而这个事实在正文与 scores 里都看不出来。
     默认不记录（召回是最高频操作，逐次写事件会造成写放大，详见 §8.4）。
     contextHash = sha1(context)，只存哈希不存原文，避免日志侧泄露对话内容。
```


### 4.7 激活扩散（有界扩散）

为避免联想跑题与计算发散，扩散作为独立后置步骤运行。

> **v2.0 的扩散有两条腿**（原 v1.0 只有第一条）：
>
> - **实体跳**（沿 `edges` 的 1 跳）：「看到照片想起名字」——v1.0 原有语义，原样保留。
> - **簇跳**（沿共激活的簇内邻居）：「想起一件事，顺带想起同一话题下的另一件事」——v2.0 新增。  
>   两条腿**共享同一个预算**（`MAX_DIFFUSED_VISITS`），不是各给一份——  
>   分开给预算等于把总上限翻倍，扩散的「有界」承诺就作废了。

```
// ── 扩散预算控制：必须有硬上限，否则是 topN × 实体数 × 边数 × 关联记忆 的无界展开 ──
// MAX_DIFFUSED_NODES / MAX_DIFFUSED_VISITS 是 §5 参数表项（默认 20 / 200），不在此硬编码
let visited = new Set<string>();   // 键为 `${memoryId}:${entityId}`，**只负责去重，不承担预算**
let scanned = 0;                   // 已处理的边数——唯一的预算闸门
// ⚠️ **候选必须收进一个跨循环的累积表**，不能直接写在查询返回的对象上：
//   「从 memory_entities 找出 n」每次都返回**全新的对象**，若把 diffusionScore 挂在那个对象上，
//   同一条记忆经**不同实体**被访问时（第二、三条关联路径）拿到的是新对象、
//   diffusionScore 又是 undefined → `?? 0` 把它重置为 0 → **多路径累加根本没发生**。
//   而「多路径比单路径更相关」正是下面 diffusionScore 上界那段的前提。
const candidates = new Map<string, { memory: Memory; score: number }>();  // 键为 memoryId

对 topN 结果中的每条记忆 m：
  if (scanned >= MAX_DIFFUSED_VISITS) break;               // 全局预算耗尽，立即停止
  获取 m 关联实体的 1 跳出边与入边 e:
    if (scanned >= MAX_DIFFUSED_VISITS) break;             // 内层必须同样判：单条记忆的边数可能就超过整个预算
    scanned += 1;                                          // 每处理一条边耗一格预算，与是否产生新候选无关
    neighbor_entity = 边的另一端
    从 memory_entities 找出 neighbor_entity 对应的候选记忆 n:
      if n 不在当前 topN 且 n.deleted == 0:
        const key = `${n.id}:${neighbor_entity.id}`;
        if (visited.has(key)) continue;                    // 同一 (记忆, 实体) 组合不再重复累加（防环）
        visited.add(key);
        // 计算扩散增益，受边衰减权重与扩散系数调节
        // 分母用 INITIAL_EDGE_WEIGHT，让初始强度映射到满值，MAX_EDGE_WEIGHT 仅作上限
        bonus = ACTIVATION_DECAY × (edgeWeight(e, now) / INITIAL_EDGE_WEIGHT)
        // 累加到**累积表**里，而不是查询返回的那个对象上（见开头 candidates 的说明）：
        const prev = candidates.get(n.id)?.score ?? 0;
        candidates.set(n.id, { memory: n, score: prev + bonus });

候选 = [...candidates.values()].filter(c => c.score >= ACTIVATION_MIN (默认 0.15))
if (diffuseArchived === false):                       // R-ARCH-DIFF 的例外通道
  // 元素是 { memory, score }，强度算在 c.memory 上，不是 c 上——写成 intensity(c, now) 会拿到 NaN
  候选 = 候选.filter(c => intensity(c.memory, now) > ARCHIVE_LINE)   // 与主召回同一口径

if (候选.length > 0):
  按 score 降序排序，取前 MAX_DIFFUSED_NODES 条（默认 20，见 §5）
  每条输出时带上 `diffusionScore: c.score`，其余字段（`id` / `content` / `layer`）取自 `c.memory`
  （字段名对外不变，见下）
  作为「额外联想记忆」附带在返回结构的 diffused 字段中，
  不直接挤占 topN 主位，供调用方自主决定是否作为背景知识。
```

**簇跳（v2.0 新增）**：从步骤 4.5 选出的 topN 种子出发，  
查每条种子在**同一主题簇**内的其他成员（`theme_cluster_members` + `coacts` 亲和度），  
按 `coacts.affinity_eff` 降序取前 `CLUSTER_TOPK`（默认 3）条。

- **簇跳不消耗 `MAX_DIFFUSED_VISITS` 的边预算**（它不遍历 `edges`，直接查成员表），  
  但它**受 `MAX_DIFFUSED_NODES` 约束**——总数上限不变。
- ⚠️ **簇跳的结果与实体跳的结果合并后去重**：同一条记忆可能两条腿都命中，  
  按 `max(实体跳分, 簇跳分)` 取较高者，**不累加**（累加会让「既是同簇又是同实体」的  
  记忆凭空翻倍，而它并不比别的记忆更相关两倍）。
- ⚠️ **簇跳是 `diffuseArchived` 唯一的新增例外通道**：它按簇成员表查，  
  可能捞出归档记忆。口径与实体跳一致——`diffuseArchived: false` 时同样过滤。

**为什么必须有两层上限**（缺一层就退化为无界）：

- `MAX_DIFFUSED_VISITS` 限制**计算量**：不做这层限制，一个高度连通的实体（如「我」）可以让扩散遍历整个库。
- `MAX_DIFFUSED_NODES` 限制**返回量与 Token 成本**：即使只算了几十条，也不能全塞给调用方。
- `visited` 去重只解决**重复累加**：环（A→B→A），以及同一 `(记忆, 实体)` 组合被多条边重复命中。

**预算必须记在「边」上，不能记在「候选节点」上**（用 `visited.size` 当预算正是记错的）：  
若用 `visited.size` 当预算，它挡不住它声称要挡的东西——**去重判断发生在查库之后**：  
必须先「从 memory_entities 找出 neighbor_entity 对应的候选记忆 n」，才可能算出 `key`。  
于是每一次重复遍历（枢纽实体最容易产生）都要先执行一次查询，而 `visited` 一个都不增：

- 最坏情形：topN 中几条记忆共享同一个枢纽实体，`visited` 很快饱和，剩余的全部边仍在逐一查询。
- 归结起来：`visited.size` 只能限制「产生了多少次新结果」，限制不了「执行了多少次查询」，  
  而后者才是上一条「限制计算量」要防的东西。名不副实的上限比没有上限更危险——它让人以为已经防住了。

现在改为每处理一条边 `scanned += 1`，与去重彻底解耦；`visited` 退化为纯去重集合。  
（同时删掉了一处死代码：原代码在 `visited.add` 之后又判 `if (visited.size > MAX_DIFFUSED_VISITS) break;`。  
循环开头已是 `>=`，进入循环体时 size ≤ MAX−1，add 之后最多等于 MAX，`>` 恒为假，那个 `break` 永不执行。）

**`diffusionScore` 是累加值，没有 0~1 上界**：  
`visited` 的键含 `entityId`，所以同一条记忆经**不同**实体被访问时会各加一次 `bonus`——这是有意为之：  
一条记忆能从 3 条不同关联路径被联想起来，确实比只有 1 条路径更相关。但由此必须明确两点：

- 「`visited` 去重解决……② 同一记忆经不同实体被多次加分导致分数虚高」这个说法是**错的**：  
  它恰恰放行该情形，拦住的只是「同一记忆经**同一**实体」的重复。已按上条措辞修正。
- `diffusionScore` 的上界是 `MAX_DIFFUSED_VISITS × ACTIVATION_DECAY`（默认 200 × 0.2 = 40），  
  实际值取决于命中了几条路径。它**只用于 diffused 内部排序**，不参与 §4.6 的五项公式，  
  调用方不得当作 0~1 的置信度或概率使用。

**规则 R-ARCH-DIFF（扩散与归档的关系，有意为之，非疏漏）**：

- 主召回（§4.6 的 hits）严格过滤 `intensity > ARCHIVE_LINE`；**扩散路径（diffused）默认只过滤 `deleted = 0`，不过滤归档**  
  （唯一例外：`diffuseArchived: false` 时扩散同样过滤归档，见下方边界约束 3）。
- 理由是这条链路模拟的正是人类记忆的经典现象：**「想不起名字，但看到照片就想起来了」**——直接检索唤不醒的归档记忆，可以经强关联被重新唤起。
- 因此 §4.4 中「归档：常规 query 默认过滤」的准确含义是「不进入主召回结果」，**不等于「永不出现在任何返回结构中」**。
- 边界约束：
  1. diffused 独立字段返回，调用方可整体丢弃，不会污染 hits 的排序与 Token 预算；
  2. `includeArchived = false` 时，diffused 中允许出现归档记忆，但每条附带 `layer: 'archived'` 标记，便于调用方决定是否使用；
  3. `includeArchived` 只管主召回；若调用方要求**连联想里也不要归档记忆**，传 `diffuseArchived: false`  
     （默认 true）：此时扩散候选同样要过 `intensity > ARCHIVE_LINE` 的精筛，与主召回口径一致。  
     —— 这条开关是 R-ARCH-DIFF 的唯一例外通道，不存在「忽略 diffused 字段」这种口头约定：  
     字段要么返回要么不返回，全靠调用方自觉的约定不算设计。

**参数标定校验（默认值下确实会触发）**：

- 新边 `weight = INITIAL_EDGE_WEIGHT = 0.8`、`last_active = now` → `edgeWeight = 0.8` → `bonus = 0.2 × (0.8/0.8) = 0.20 ≥ 0.15` ✓ 立即进入 diffused。
- 边闲置 30 天（`EDGE_STABILITY`）→ `edgeWeight = 0.8 × e^-1 ≈ 0.294` → `bonus ≈ 0.074 < 0.15` ✗ 不触发。
- **临界点**（令 `bonus = ACTIVATION_MIN`）：`0.2 × e^(-Δt/30) = 0.15` → `Δt = 30 × ln(4/3) ≈ 8.63 天`。  
  实测：7 天 → `bonus ≈ 0.158` ✓；10 天 → `≈ 0.143` ✗。
- 结论：扩散只对**近 8.6 天内活跃过**的关联生效（按「15~20 天」估算是笔算错误，把窗口说大了一倍多）。  
  若希望更宽松，调高 `ACTIVATION_DECAY` 或调低 `ACTIVATION_MIN`；**不要再把分母改回 `MAX_EDGE_WEIGHT`**（那会让阈值实际需要边被强化 5 次以上才触发，新库长期 diffused 恒空）。
- 这个 8.6 天是**新边（`w = 0.8`）**&#x7684;窗口，不是固定值。`w` 越高窗口越长（`Δt ≤ 30 × ln(w/0.6)`：  
  `w = 3.0` 封顶时约 48 天），而 `w` 由两个来源提升——重复 link 同一三元组、touch 时按证据记忆强化  
  （§4.5 规则 R-EDGE-TOUCH）。所以「联想是否还活着」取决于这条边最近**有没有被用过**，  
  这正是该规则存在的理由：没有它，一条建好后不再被 link 的边 9 天后扩散即永久失效。


### 4.8 显式遗忘（forget）

```
forget(id: string, options?: { hard?: boolean; keepAuditContent?: boolean }, now?: number)

前置校验：SELECT deleted FROM memories WHERE id = @id;
  不存在（或已被硬删）→ 抛 MemoryError.NOT_FOUND，不做任何写入。
  已软删（deleted = 1）且 hard = false → 幂等返回，**不重写 deleted_at**
    （重写会把 sweep 的清理倒计时往后推，用户反复点「忘掉」就等于永远清不掉）。

默认软删（hard = false）：
  UPDATE memories SET deleted = 1, deleted_at = @now WHERE id = @id;
  记录 events(type='forget', memory_id=@id, payload={ id, hard: false })
  -- 软删不处置任何正文，故**不带** auditContentRetained——该字段只在 hard: true 时有意义（见 §8.4）
  软删不触碰 content_history 与 events 正文（数据仍在，只是不参与召回，可 undo）

若 hard = true（物理删除）：
  ① DELETE FROM memories WHERE id = @id;
     -- memory_entities、content_history 由外键 ON DELETE CASCADE 自动清理；
     -- mem_fts 由触发器 mem_ad AFTER DELETE ON memories 自动同步，**禁止手动 DELETE mem_fts**
     --   （external content 表必须用 INSERT INTO mem_fts(mem_fts,rowid,content_tokens) VALUES('delete',...) 形式，
     --     普通 DELETE 会报错或损坏索引）；
     -- edges.memory_id 为 ON DELETE SET NULL，边本身保留（关系比单条证据更长寿）。
  ② 正文脱敏（兑现「遗忘」承诺）。**全库唯一一份脱敏 SQL，§8.2 / §4.10 引用此处，不得各写一份**：
     if (keepAuditContent !== true):
       UPDATE events
       SET payload = json_set(payload, '$.contentText', '[redacted]')
       WHERE memory_id = @id
         AND CASE WHEN json_valid(payload)
                  THEN json_extract(payload, '$.contentText') IS NOT NULL
                  ELSE 0 END;
     -- 三个要点，缺一即出事故：
     --   a. 走 memory_id 索引定位（O(log n)），不再用 payload LIKE '%"id"%' 全表扫；
     --   b. 不再用 json_extract(payload,'$.id') 反查——它对每一行都要解一次 JSON，等于全表 O(n) 解析；
     --   c. 必须先用 json_valid 兜住非法 JSON：json_extract 遇到坏 payload 会直接抛
     --      "malformed JSON"，把「遗忘」这个必须成功的操作整个中断。
  ③ 记录 events(type='forget', memory_id=@id, payload={ id, hard: true, auditContentRetained: !!keepAuditContent })

事务要求：① ② ③ 必须在**同一事务**内提交（§9.2），否则会出现「行已删、正文还在」的半完成状态。
```

> **写入侧配套义务**：凡 payload 里可能出现 `contentText` 的事件（`write` / `merge` / `manual_fix`），  
> `appendEvent()` 必须同时写入 `memory_id`。漏写该列的后果是**该条事件的正文永远脱敏不到**——  
> 不报错、不告警，只是用户说了「忘掉」而原文静静躺在库里。实现上把 `memory_id` 设为

|   |   |
| - | - |

|   |   |
| - | - |

> `appendEvent()` 的**必传实参**（类型 `string | null`，值为 null 时也必须显式传入），从签名层面堵死省略。

- **两个选项的语义边界**（不得含糊）：
  - `hard: false`：**可撤销的隐藏**。数据完好，可用 `restore()` 恢复（更新 `deleted = 0, deleted_at = NULL`）。
  - `hard: true, keepAuditContent: false`（默认）：**不可撤销的遗忘**。正文在所有三处位置全部消失，  
    仅保留「曾在某时有过这条记忆」的结构骨架。
  - `hard: true, keepAuditContent: true`：**不可撤销的下线 + 完整留证**。正文留在事件流里，  
    产品文案不得声称「彻底删除」，只能声称「不再参与任何召回」。


### 4.8.1 restore() 与唯一索引的冲突（必须显式处理，否则必炸）

**问题本身**：`idx_mem_hash` 是 `UNIQUE(content_hash) WHERE deleted = 0`。以下序列在真实使用中极常见：

```
① write "我对花生过敏"        → 记忆 A（hash = H，deleted = 0）
② forget(A)                   → A 软删，hash 槽位被释放
③ write "我对花生过敏"        → hash H 在 deleted = 0 范围内不存在 → 新建记忆 B（hash = H）
④ restore(A)                  → A 改回 deleted = 0，此时 A、B 同为 H 且都未删
                              → **SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: memories.content_hash**
```

「说了忘掉 → 又说一遍 → 又改主意」是用户最自然的操作序列，这条路径不能靠运气。

**处理策略（二选一，默认抛错而非静默合并）**：

```
restore(id: string, options?: { mergeInto?: string }): void

前置：SELECT * FROM memories WHERE id = @id;
  不存在（已被硬删）→ 抛 MemoryError.NOT_FOUND；
  deleted = 0 → 幂等返回（已经是正常状态，不重复写事件）。

1) 检测冲突：SELECT id FROM memories
             WHERE content_hash = @hash AND deleted = 0 AND id <> @id;
2) 无冲突 → UPDATE memories SET deleted = 0, deleted_at = NULL WHERE id = @id;
            记录 events(type='restore', memory_id=@id, payload={ id })
3) 有冲突且未传 mergeInto → 抛 MemoryError.CONFLICT，
   携带 { conflictingId }，让调用方决定（这是产品决策，库不能替用户猜）。
4) 有冲突且 mergeInto === conflictingId：
   a. 把待恢复记忆的实体关联并入目标。**先算差集**（下面 e 的 addedEntities 要用），再插入：
      @addedEntities = SELECT entity_id FROM memory_entities WHERE memory_id = @id
                       且该 entity_id **不在** (SELECT entity_id FROM memory_entities WHERE memory_id = @targetId) 中
      INSERT OR IGNORE INTO memory_entities
        SELECT @targetId, entity_id FROM memory_entities WHERE memory_id = @id;
      -- 顺序不能反：先 INSERT 再算差集，交集已并进去，算出来恒为空。
   b. 把待恢复记忆的 content_history 迁到目标名下：
      UPDATE content_history SET memory_id = @targetId WHERE memory_id = @id;
   c. 把指向它的 edges.memory_id 改指向目标（避免边失去证据）：
      UPDATE edges SET memory_id = @targetId WHERE memory_id = @id;
   d. 硬删待恢复行：DELETE FROM memories WHERE id = @id;  -- 触发器同步 FTS，FK 级联清理残留关联
      -- 这一步**不走 §4.8 的 forget 脱敏流程**（不抹掉该行历史事件里的正文），这是有意的：
      --   合并后正文由目标记忆承载，历史事件保留原文即构成「可审计的合并痕迹」；
      --   若在此脱敏，反而抹掉了「这条记忆曾被单独记过」这一事实。
   e. 记录 events(type='merge', memory_id=@targetId,
        payload={ targetId, addedEntities: @addedEntities, mergedFrom: @id, reason: 'restore_merge' })
      -- 与 §4.9 步骤 3c 的 merge payload 相比，本路径**刻意少四项**，不是漏写：
      --   intervalDays / boostApplied —— 本路径不调 growStability（不加固 stability、不改 last_access），
      --     硬填 0 / false 等于伪造一条「发生过间隔重复」的假记录，重放会据此算错衰减；
      --   contentText / contentLength / contentHash / prevContentLength —— 本路径不改写任何正文
      --     （target 原样保留，source 的原文已在其自己的 write 事件里）。填 target 的 hash
      --     会让重放误以为这里发生过一次正文替换。
      -- 因此 §8.4 的 merge 行按来源列两种字段集，本路径用后者。
   ——本质是「以恢复为名义的合并」，所以复用 merge 事件类型，`reason` 区分来源。
```

> **为什么默认抛错而不是自动合并**：自动合并会静默丢弃一条记忆的正文  
> （两条同 hash 记录必有一方的 `content` 被淘汰），用户点的是「恢复」，  
> 结果却少了一条——这类「操作意图与实际结果不符」的 bug 最难被用户描述清楚。


### 4.9 写入去重与合并

> ★ **阶段 1（P1）的桶归属阶段性豁免**（v2.1 勘误；**这是临时口径，阶段 2 落地后必须撤销**）：
>
> 本节有**四条 embedding 赋值路径**（步骤 2 补写 / 步骤 3c ② 合并写回 / 步骤 4 新建 /
> §4.9.1 步骤 4 改写），每一条都要求「同事务内同步 `vector_cell_members`」（§9.3.0 / §9.3.2 ①）。
> ⚠️ **但阶段 1 还没有分桶**：两级 k-means 训练、细桶中心、`assignBucket` / `unassignBucket`
> 全部属于**阶段 2**（DEVELOPMENT-PLAN.md 的 P2-T03 及其桶训练任务）。
> ⇒ **阶段 1 的 `write()` 照写 `memories.embedding`，但不写 `vector_cell_members`**：
> - **写不了**：`vector_cell_members.fine_id` 有 FK 指向 `vector_fine_cells`（§3），
>   而阶段 1 库里**一条细桶都没有** ⇒ 任何桶行都会被外键直接拒绝（FK 在每连接都开，§9.1）；
> - **也不该写一个「空壳 `assignBucket`」**：没有细桶可分配的空函数 = **死函数 = 假绿**
>   （§14.3 边界原则 1：每个承诺都要能指到唯一代码路径——指不到的，要么补实现，要么删承诺）。
>
> ⇒ ★ **欠账不会变成「永久漏召」**，阶段 2 有**两条自动修复路径**（都已在设计稿里）：
> ① §9.3.2 ③ 的**启动对账**：「库侧有、桶侧无 ⇒ 补（归入最近的细桶）」；
> ② §4.15.5 重建步骤 ② 的**全量重分配**：「按新中心重新分配**每条**记忆的桶归属」。
> ⇒ ★ **阶段 2 落地时必须满足两条硬约束**（缺一条，那才是设计稿点名的「静默、永久、不报错」窗口）：
> - **在启动对账 / 首次重训完成之前，不得对外提供 IVF 向量路**；
> - **必须新增一条硬断言**：「库内所有 `embedding IS NOT NULL` 且 `deleted = 0` 的记忆，
>   其 id 集合与 `vector_cell_members` 的 `memory_id` 集合**相等**」
>   （集合相等，不是条数相等——§9.3.2 ③ 的三条判据）
>   ⚠️ **左侧是「全库」，不是「本次写入的批次」**（ADR-P1-T07-DEC D-12）——
>   取全批次 ⇒ 断言退化成「本批写的东西都进桶了」⇒ **恰好放不过阶段 1 遗留的那笔欠账**
>   ⇒ 口径必须写成 `SELECT id FROM memories WHERE embedding IS NOT NULL AND deleted = 0`（全库）
>   ⇒ 把阶段 2 的**可检断言**做成真正的「全库对账」，而不是「本批次自洽」。
>
> ⚠️ 阶段 1 另有两处**同源**的阶段性豁免（一并写明，避免被当成漏实现）：
> - §4.9 步骤 3a2 的**向量路候选**（两级路由 + 桶内检索）需要桶中心 ⇒ 阶段 1 **跳过**，
>   近似去重退回纯文本路（步骤 3a）。代价是**少一条去重证据**，不是「去重失效」；
> - §4.9 步骤 3c ② 的 `unassignBucket` 在阶段 1 **不存在** ⇒ 阶段 1 库里根本没有桶行可删 ⇒ 无矛盾。
>
> ⇒ ⚠️ **阶段 1 的 `stats().vectorBackend.embeddedRatio` 只表示「有向量的记忆数」**，
> **不代表「已进入向量路」**（阶段 1 根本没有向量路）⇒ 不要把它读成「向量覆盖率」。
> ★ 而 §0.2.2 的「密度门槛与向量覆盖率耦合」讨论的是**阶段 2 之后**的口径，
> 阶段 1 的 `embeddedRatio` 偏高**不构成** §0.2.1 的任何结论。

```
写入处理（包含实体同步与完整事件记录）：

1) 实体别名归一与 UPSERT：
   a. 别名解析（调 `resolveEntity(db, n)`，§4.5 末尾，**唯一实现**）：
      对 input.entities 中的每个名称 n：
        返回 entity_id → 用它作为 canonical（**该实体已存在，不新建、不改主名**）
        返回 null     → 视为新实体，用 n 作为主名走下面的 UPSERT
      —— 这里与 §4.6 步骤 1 用**同一个函数**，但**返回 null 后的处理不同**（这是刻意的）：
         recall 是「不进图谱路」，write 是「建新实体」。不要因为「两处都调 resolveEntity」
         就顺手把 ③ 也统一掉。
   b. 实体 UPSERT（**仅对 a 返回 null 的名称执行**，用该名称作主名）：
      INSERT INTO entities(id, name, type, created_at) VALUES(<新 uuid>, @name, 'concept', @now)
      -- ↑ 四列全部显式给出，与 §4.5 步骤 2 的写法保持一致：
      --   `id` 是 TEXT PRIMARY KEY（无自增兜底），`type` 当前恒为 'concept'（§3 已注明现状），
      --   `created_at` 直接用 @now。写成 `VALUES(...)` 会让读者无从判断这几列从哪来。
      ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id;
      -- 为什么必须加这个前置条件：ON CONFLICT(name) 只在「该名称已是某个 entities.name」时
      -- 才复用既有行。若 a 命中的是**别名表**（该名称不是任何实体主名），直接 UPSERT 会
      -- 插入一条新实体，别名归一当场失效——正是 §4.9.2 开头说的那种静默错挂。
      -- a 返回 entity_id 时一律直接采用该 id，不再查也不再写 entities。
      @linkedEntityIds = [a 返回的 id 与 b 新建的 id 汇总，按 id 去重]
      -- ↑ 下游步骤 2 与 3c ⑤ 引用的就是**这个名字**
      -- ↑ 刻意不叫 @entityIds：那是 §4.6 recall 的入参，同名不同义
   c. 若调用方显式传入了 `input.entityAliases`（见 §6 `WriteInput`），在实体落库后同步维护别名表。
      `input.entityAliases` 的每一项形如 `{ name, aliases: string[] }`，按项遍历：
        该项的 `name` 先在 a 步解析出 entity_id（命中既有实体或 b 步新建），记为 @thisEntityId；
        entity_id 是**单个**值，因为每一项只描述一个实体——不要拿 `@linkedEntityIds` 当它用，
        那是步骤 1 全部名称的汇总（可能多个）。
      @warnings = []    -- 本次「想写但没写成」的清单；无冲突则为空数组（不要省略该键）
      **必须先查再插，不能只靠 DO NOTHING**——DO NOTHING 会把两种完全不同的情况一起吞掉：
        ① alias 已存在且**指向 @thisEntityId** → 幂等，跳过正确，什么都不用做
        ② alias 已存在但**指向另一个 entity_id** → 本次「老张→张三」的归一根本没生效，
           调用方却以为成功了。这正是 §4.9.2 开头说的「静默错挂」。
      正确写法——对每一项的 each alias a：
        @existingEntityId = SELECT entity_id FROM entity_aliases WHERE alias = @a;
        若 @existingEntityId 非空且 ≠ @thisEntityId：
          跳过，**不覆盖**（覆盖是 setAlias 的职责，见 §4.9.2「两处不能统一」），同时走两个通道：
            - 返回值 warnings 追加 { code: 'ALIAS_CONFLICT', alias: a,
                                     currentEntityId: @existingEntityId, intendedEntityId: @thisEntityId }
            - 按 §8.1 记一条磁盘日志（动作 `写入`，键 alias=… now=… want=…）
          —— 两个都要：磁盘日志给人排障，**warnings 才是调用方能看见的**。
             只记日志等于静默，而这一整节的目的就是「不要静默」。
        否则：
          INSERT INTO entity_aliases(alias, entity_id) VALUES(@a, @thisEntityId)
            ON CONFLICT(alias) DO NOTHING;
          -- 能走到这一行时，冲突只可能是「已指向 @thisEntityId」（幂等），所以 DO NOTHING 正确。
          -- 保留 DO NOTHING 而非 DO UPDATE，是为了让「写路径永不覆盖别人的映射」这条边界
          -- 一眼可见——与 setAlias 的 DO UPDATE 不统一，是刻意的。
      另：除上述检查外，仍需校验 a 不等于任何已有 entities.name（主名优先，见 §4.5 解析顺序），
          冲突同样走「跳过 + warnings + 日志」，不要静默。
      ⚠️ **「撞主名」没有例外**（v2.1 勘误 / ADR-P1-T07-DEC D-5）：即使撞的**就是它自己**
        （把实体自己的主名再声明成自己的别名）⇒ 同样算冲突。
        理由：§4.5 的解析顺序是「主名优先」⇒ 同一字符串会解析出两个不同的答案
        （① 命中主名 A、② 命中别名 B）⇒ 召回结果取决于实现先查哪张表。
        ⇒ 与 `setAlias` 保持同一口径（它也不允许把主名写进别名表）。
        ⚠️ **两条路径分别处理，别混**：
        · **`setAlias`（§4.9.2 步骤 1）** ⇒ 抛 `MemoryError.CONFLICT`
          （**`details.conflictingEntityId`**）——它是**显式修改别名映射**的动作，冲突要**硬失败**。
        · **写路径步骤 1c（本节）** ⇒ **跳过 + `warnings` + 磁盘日志**，**不抛错**——
          因为**记忆本身已经写成功**（§11.2 末：别名冲突是「非致命但调用方必须知道的事」；
          抛错会让调用方重试 `write()` ⇒ 同一事实被写两遍）。
      ⚠️ **v2.1 勘误（ADR-P1-T07-DEC D-3，★ 2026-10-31 主理人**改判**，结论反转过一次）：
        `entityAliases[].name` 的解析走与 `input.entities` **同一套 a → b 归一**——
        ① `resolveEntity` 命中（主名或别名）⇒ 用该 id（**不新建**）；
        ② 均未命中 ⇒ **按步骤 1b UPSERT 新建一个实体**。
        · **建**：`entityAliases[].name` 是调用方**显式点名**的实体，
          而写路径的既定语义就是「**写入路径负责建实体**」（步骤 1b 对 `input.entities` 里的未知名字也是建）
          ⇒ **同一个调用方语义在两个字段上必须表现一致**。
          ⇒ 不建 ⇒ 这次声明的别名**无处可挂**（`entity_aliases.entity_id` 无处指）⇒ **静默丢弃**。
        · ⚠️ **不隐含关联**：**无论命中既有实体还是新建，都不进 `@linkedEntityIds`**
          ⇒ 不与本条记忆建立 `memory_entities` 关联，也不出现在 write 事件的 `entityIds` 里。
          理由：**`entities` 是「这条记忆跟 X 有关」的**唯一**表达机制**
          ⇒ 若 `entityAliases` 也能顺带建立关联，就有**两处**能表达同一件事
          ⇒ §14.3 边界原则 1（每个承诺都要能指到唯一代码路径）就破了。
        · ⚠️ **代价（明写在这里，别让它变成静默）**：调用方若**只**声明 `entityAliases`、
          却没把该实体名放进 `input.entities` ⇒ 别名映射建好了，但**本条记忆不与该实体关联**
          ⇒ 图谱路查不到它 ⇒ **静默达不到召回目的**。
          ⇒ **想让别名对召回生效，必须把实体名同时写进 `input.entities`。**
        · ★ **这条边界已可观测（ADR-P1-T07-DEC D-3/R2，落地于 P1-T07）**：
          「建但不隐含关联」是**有意**的边界，但它有代价 ⇒ **边界可以存在，但必须可观测**
          ⇒ 写路径在「别名目标实体没跟本条记忆关联」时，回一条 **`ALIAS_TARGET_NOT_LINKED`** warning
          （字段：`code` / `name` = 调用方在 `entityAliases[].name` 里写的那个名字 /
          `entityId` = **已经建出来的**那个实体的 id），并按 §8.1 记一条磁盘日志。
          ⚠️ **一个 `name` 一条**（不是每个别名一条）：报的是「**这个实体**没跟这条记忆关联」，
          不是「这两个别名有问题」⇒ `{ name:'张三', aliases:['老张','小张'] }` ⇒ **1 条**，不是 2 条。
          ⚠️ **判定按实体 id，不按名字**：调用方可能用**别名**点名同一个实体
          （`entities: ['老张']` + `entityAliases: [{ name:'张三', … }]`）⇒ 那个实体**确实**被关联了
          ⇒ **不该**报这条 warning。
          ⚠️ **三处必须同步**（漏一处门禁就红）：`src/core/errors.ts` 的 `WARNING_ONLY_CASES`、
          `scripts/check-contract-ids.ts` 的 `EXPECTED_WARNING_ONLY_CASES`、§11.2 的对照表那一行。
        · **若别名目标实体与 `input.entities` 里的同名实体是同一个** ⇒ 那时它**因 `input.entities`
          而被关联**（走 `entities` 那条路径）⇒ 这是对的；
          **不要因此把别名路径的关联也打开**（别名路径**不**调「计入 `@linkedEntityIds`」那一步）。
          ⇒ 这种情况下**不**回 `ALIAS_TARGET_NOT_LINKED`（它确实被关联了）。
   注：这确保「老张」和「张三」写入同一实体记录，召回图谱路才查得到这些记忆。
      （唯一例外是 c 的冲突情形——alias 已指向他人时本次不覆盖，此时靠 warnings 让调用方知道。）

2) 文本归一化与完全重复检测：
   @normText = normalize(input.content)   -- 去首尾空白 → 全角转半角 → 小写（定义见 §10.2）
   @newHash  = sha1(@normText)            -- ← 步骤 3c ② 与 ⑦ 引用的就是**这个名字**，不要在那里重算
   新文本    = input.content              -- 落库用**原文**（保留大小写与全角），只有 hash 用归一化形式
   @newVec   = 本次写入使用的向量，**唯一产生处**：
               input.embedding 直接给 → 校验（维度 == EMBED_DIM、无 NaN/Inf、模长 > 1e-8）后
                 L2 归一化成 Float32Array；
               没给但配置了 MemoryConfig.embedder → 调 embedder(input.content) 现算，再走同一套校验；
               两者都没有 → null。
               校验失败一律抛 INVALID_INPUT 并在 details 里带 reason（'dim' / 'nan' / 'zero'），
               **不做截断、不补零、不静默降级为 null**——静默降级会让这条记忆此后一直搜不到，
               而调用方以为写成功了（与 §4.6 步骤 2c「拒绝而非截断」同一口径）。
   若已存在同 @newHash 且 deleted = 0 的记录 m：
   → 判定为完全重复。执行加固，**统一走 §4.2 的 growStability()**（守卫与上限都在里面）：
     const { intervalDays, boosted } = growStability(db, m, DEDUP_BOOST, false, now)
     // useSpacing=false：完全重复不是间隔重复
     // boosted=false = 仅计数与时间戳（防 webhook 重投打爆稳定度），或已触及 MAX_STABILITY 封顶
     ⚠️ **必须补齐实体关联**：本路径虽然不改写正文，但调用方这次可能带了新的实体名。
       若不补，这些实体会**丢失与该记忆的关联**——正文没变、强度也加了，
       但图谱路查不到这层关系（对比步骤 3c ⑤ 的同一动作）。
     @addedEntities = @linkedEntityIds 中**不在**下列集合里的那些：
                      SELECT entity_id FROM memory_entities WHERE memory_id = m.id
     若 @addedEntities 非空（空数组不要拼进 SQL，否则 VALUES 子句语法错误）：
       INSERT OR IGNORE INTO memory_entities(memory_id, entity_id)
         VALUES (m.id, @e1), (m.id, @e2), ...;   -- 每个 entity_id 一组
     -- 顺序不能反：必须先算差异再 INSERT，下面的 touch 事件要记 addedEntities。
     --   memory_entities 本身不在事件流里，没有第二处能追溯「这条记忆多了哪些实体关联」，
     --   所以这一笔只能落在 payload 上。字段名与含义同 3c ⑦ 的 merge payload。
     -- 边强化（§4.5 规则 R-EDGE-TOUCH）：本路径同样是「确认采纳」，以 m 为证据的边也要强化
     @edgesReinforced = SELECT COUNT(*) FROM edges WHERE memory_id = m.id;
     UPDATE edges SET weight = min(@MAX_EDGE_WEIGHT, weight + @EDGE_REINFORCE_STEP), last_active = @now
       WHERE memory_id = m.id;
     -- 先取计数再 UPDATE。当前 WHERE 不含 weight 条件，先后结果确实一样；但顺序写死才不会被人
     -- 顺手给 WHERE 补一个 `weight < MAX_EDGE_WEIGHT` 过滤后，让 payload 与实际强化条数对不上。
     ⚠️ **向量补写（老库回填的唯一机会）**：本路径不改正文，旧向量仍然有效，**绝不清空**；
       --   ⚠️ ★ **补写向量必须同步补写桶归属**（§9.3.2 ①）：
       --   补了向量却不入桶 ⇒ 这条记忆**永远不进任何桶** ⇒ 向量路永远召不回它，
       --   而 `embeddedRatio` 在涨 —— **静默、永久、不报错**。
       --   ⇒ 补向量与入桶必须在**同一个事务**里。
       --   ⚠️ **换桶要「先 DELETE 旧归属行、再 INSERT 新行」**（唯一索引兜底，见 §4.15.5）。
       但若库内 m.embedding IS NULL 且本次带了 @newVec，就写进去：
       UPDATE memories SET embedding = @newVec WHERE id = m.id AND embedding IS NULL;
       -- ★ 同事务内更新 `vector_cell_members` —— 调 assignBucket(...)（§9.3.0）
       --   ⚠️ 漏了这一步 ⇒ 有向量但不在任何桶里 ⇒ 向量路永远召不回，
       --   而 `embeddedRatio` 却在涨 ⇒ **静默、永久**。
       --   ⚠️ **阶段 1（P1）暂缓这一步**（见本节开头的「阶段性豁免」）：
       --     阶段 1 没有细桶 ⇒ 桶行写不进去；欠账由阶段 2 的启动对账 / 首次重训补齐。
       -- 带 `embedding IS NULL` 是必须的：已有向量时不得覆盖。同一段正文在不同模型下算出的向量
       --   不可比（维度可能恰好相同，库无法检测），一旦允许覆盖，同一张表里就会混着两代向量，
       --   余弦值失去意义且**没有任何报错**。换模型 = 全库重算，那是 §11.3 快照导出后重建的事。
       @embeddingAdded = 上一句是否真的写了（1 / 0），供下面 payload 使用
     记录 events(type='touch', memory_id: m.id,
       payload={ id: m.id, reason: 'exact_repeat', intervalDays, boostApplied: boosted,
                 edgesReinforced: @edgesReinforced,   -- 无证据边时记 0，不要省略该键
                 embeddingAdded: @embeddingAdded,     -- 恒带该键，0 表示未补写
                 addedEntities: @addedEntities })    -- 无新增时记 []，不要省略该键
     返回已有 id 与 { merged: true, exact: true, content: m.content,
                      warnings: @warnings }。    -- @warnings 见步骤 1c，无冲突时为 []
     // exact=true：本路径**没有改写库内正文**（只动了 stability / last_access / access_count，
     //   以及 R-EDGE-TOUCH 的证据边 weight / last_active）。
     //   归一化后 hash 相同不代表字面相同（"ＡＢＣ" 与 "abc" 同 hash），此时返回的 content 是库内版本，
     //   可能和调用方传入的字符串不同——调用方据此展示，不要用 input.content。
     ⚠️ ★ **并发兜底（多进程部署时必读）**：
     //   上面「查 @newHash 是否已存在」是 SELECT-then-INSERT，在**单写进程**下安全（§9.1 的单写者约束）。
     //   但若**两个进程同时**写同一正文，二者都可能 SELECT 到「不存在」，
     //   然后都去 INSERT ⇒ 后者撞 `idx_mem_hash`（`UNIQUE(content_hash) WHERE deleted = 0`）
     //   ⇒ 得到裸的 `SQLITE_CONSTRAINT_UNIQUE`。
     //   ⇒ **INSERT memories 时必须捕获该约束冲突，转成 `MemoryError.CONFLICT`
     //      （带 details.conflictingId）**——与 §4.8.1 的 restore 撞唯一索引同源、同处理。
     //   ⇒ **绝不能把裸的 SQLite 错误码抛给调用方**：它既不说明「冲突了」，
     //      也不告诉调用方「哪一条冲突了」，调用方无法决定是重试还是查重。
     //   ⇒ 单写进程下这条分支永不触发（纯兜底），但**兜底必须存在**——
     //      §9.1 允许多线程/多进程经进程锁调度，锁的粒度未必覆盖到这条 INSERT。

3) 相似检测与原子合并：
   a. 取新文本的前 3 个核心 bigram 构造查询串 @dedupSql，到 FTS5 取最相关候选（前 3 条）：
      SELECT m.id, bm25(mem_fts) as raw_bm25
      FROM mem_fts JOIN memories m ON mem_fts.rowid = m.rowid
      WHERE mem_fts MATCH @dedupSql AND m.deleted = 0
      ORDER BY bm25(mem_fts) ASC          -- 必须显式排序，否则取到的是 rowid 最小的 3 条而非最相似的 3 条
      LIMIT 3;
      -- @dedupSql 直接显式构造，**不要复用 buildMatchQuery(新文本)**：
      --   const dedupSql = tokenize(新文本).split(' ').filter(Boolean)
      --                        .slice(0, 3).map(escapeFts5).join(' AND ')
      -- 原因：buildMatchQuery 内部还会对入参再 tokenize 一次；把已切好的 bigram 串传进去是「二次分词」，
      -- 对 2 字 token 恰好幂等、对其它长度会切出意外 token，等于把去重条件变成了不可预测的东西。
      -- 另外：候选不足 2 个 bigram（如「好的」）时 dedupSql 只有 1 个 token，AND 退化为单条件，
      -- 候选相关性骤降——此时应要求实体重叠数 ≥ 2 才允许合并（见步骤 c），不要放宽。
      -- ⚠️ v2.1 勘误（ADR-P1-T07-DEC D-6）：这里的「≥ 2」是 **DEDUP_ENTITY_MIN 的默认值**，
      --   判据本身应当用**参数** `DEDUP_ENTITY_MIN`（默认 2），与步骤 c 的实体判据同源。
   ★ **退化态与非退化态的精确判定式**（v2.1 勘误 / ADR-P1-T07-DEC D-6，★ 2026-10-31 与实现逐条对齐）：
     ```
     记 @bigrams = tokenize(新文本) 的 bigram 列表（去掉空项），n = @bigrams.length

     n = 0（空串 / 纯空白）⇒ **文本路整体不执行**：连候选都不取 ⇒ 直接判「不合并」
        ⚠️ 这**不是**「退化态」：退化态是「有候选、但候选面不可信」；这里是「压根没有候选面」
          ⇒ 两条是**不同的路**，不要合并成一个分支写。

     n = 1（退化态，如「好的」）⇒ 合并 ⟺ entityOverlap ≥ DEDUP_ENTITY_MIN（默认 2）
        ⇒ **cos 通道整条不生效**：「单靠余弦即可判合并」这条判据在退化态**恒为假**
          （不是「cos 参与候选生成、但不足以单独成立合并」的弱化版 —— 两种实现不等价）
        ⇒ 候选**照常取**（FTS 用单个 token 的 AND 退化查询），只是**合并资格**只看实体重叠

     n ≥ 2（非退化态）⇒ 合并 ⟺ entityOverlap ≥ DEDUP_ENTITY_MIN
                           OR (cos ≠ null AND cos ≥ DEDUP_COS_MIN)
     ```
     ⇒ **字面读法**：步骤 3a 的「**应要求实体重叠数 ≥ 2 才允许合并**」是**必要条件**，
       叠加步骤 c 的「满足任一即可」⇒ 退化态的判定**收敛为** `entityOverlap ≥ DEDUP_ENTITY_MIN`。
     ⇒ ⚠️ **不得**写成「退化态只要 cos 高就合并」：候选面已不可信 ⇒ 不能拿余弦去合并。
     ⇒ ⚠️ **也不得**写成「退化态放宽阈值」——放宽会让短文本的误合并率直接跳上去。
     ⇒ ⚠️ **「cos 通道不生效」说的是「合并资格」，不是「排序」**：退化态下若多个候选同时达标，
       tie-break 里的 `cos 降序` **照常执行**（D-4 的四级全序在退化态同样适用）。

   a2. 向量路候选（**只在本次有 @newVec 时执行**；没有就跳过，回到纯文本路的行为，不是降级报错）：
       ⚠️ **v1.0 的写法是全表扫**（`WHERE m.deleted = 0 AND m.embedding IS NOT NULL`，无 LIMIT），
       --   在 100 万条下每次 write 要付 500~1500ms —— **写路径比读路径更致命**。
       --   v2.0 改为**两级分桶收窄**，与 §4.6 步骤 0 同一套桶，但用**写入专用探针数**
       --   （更小：写入的候选上限是 2000，召回是 5000）。
       -- ① 先用新向量定位候选桶（此时新记忆还没入库、也没有桶归属，
       --    所以必须**先算桶、再查桶**，顺序不能颠倒）：
       @writeHitCells = 两级路由(@newVec, ROUTER_NPROBE_WRITE_COARSE, ROUTER_NPROBE_WRITE_FINE)
         -- 粗层：对 200 个粗桶中心算点积，取最近 N 个粗桶
         -- 细层：在这 N 个粗桶下的细中心里算点积，取最近 M 个细桶
         -- ⇒ 命中 M 个细桶（每桶约 100 条）⇒ 候选约 800~2000 条
       -- ② 在命中桶内取候选：
       SELECT m.id, m.embedding
       FROM vector_cell_members vcm JOIN memories m ON vcm.memory_id = m.id
       WHERE vcm.fine_id IN (@writeHitCells) AND m.deleted = 0 AND m.embedding IS NOT NULL;
       -- 逐条算 cos（点积，已归一化），取 cos ≥ @DEDUP_COS_MIN 的按 cos 降序前 VECTOR_TOPK 条。
       -- **刻意不加 @coarseCutoff 窗口**：重复项完全可能是半年前写的那条，
       --   加了窗口就等于「只和最近用过的记忆去重」，这正是老库越用越脏的成因。
       -- ⚠️ **不加时间窗 ≠ 不加空间窗**：分桶收窄的是**空间**（几何邻近），
       --   不影响「半年前写的那条」是否进候选——只要它与新文本足够近，
       --   它的**粗桶**几乎必然被探到（粗层按相似度选，它大概率排第 1）。
       -- ⚠️ ⚠️ **但「粗桶命中」不等于「细桶命中」**——原文档在这里写了「必定」，
       --   **那是未证断言，默认参数下就是错的**。真实命中率：
       --     粗层：真近重复的粗桶大概率为第 1 ⇒ 粗层覆盖远高于 4%（4% 是对**随机对**的数字）
       --     细层：被探到的粗桶下约 50 个细桶，探针 20 ⇒ **20/50 = 40%**
       --   ⇒ **真近重复的命中率 ≈ 40%，漏检 ≈ 60%。**
       --   ⇒ **所以写路径去重是「两层架构」**（见 §4.9 步骤 3a2 的说明块）：
       --     **实时层**：分桶近似，命中即合并（便宜、快、**不完备**）
       --     **后台层**：周期性分片做 flat 全量近重复扫描，补上漏掉的那 60%
       --   ⇒ **不能再靠加探针解决**：20 × 100 = 2000 = 候选上限（顶格），
       --     再加就撞「写入 P99 ≤ 5ms」（§12 阶段 2）。
       -- ⚠️ **写入路径用主题簇是无效的**：新记忆从未被 touch 过，不属于任何主题簇，
       --   主题簇路由救不了写入路径（ADR-26）。
       --   **不要**为此加「只扫最近 N 条」的参数——
       --   那会让老重复项永远查不出来，且没有任何信号告诉调用方漏了。
       @vecCandidates = 上述 id 列表
       -- 为什么必须有这条路：文本路候选靠 bigram，而**同义改写恰恰没有共享 bigram**
       --   （「她不吃猫粮」vs「她对猫粮过敏」），FTS 一条都找不到，去重直接失效。
       --   §4.9 末尾「无实体时近似去重完全失效」那段，现在有了第二条出路。

       -- ★★ **写路径去重是「两层架构」**（v2.1 裁决）：
       --   ① **实时层**（本段）：分桶近似，命中即合并。
       --      **便宜、快、但不完备**（命中率 ≈ 40%，见上面的推导）。
       --   ② **宿主调度层**：由**调用方在自己的进程/线程里**周期性做**分片 flat 全量近重复扫描**
       --      （不限时间窗），补上实时层漏掉的那 ~60%。
       --      · flat 全扫 100 万条 ≈ 500~1500ms ⇒ **必须分片 + 限流**，
       --        否则会撞上正在跑的请求（同库同进程）。
       --      · ⚠️ **库内没有定时器、没有后台线程**（ADR-5 全同步）：这段扫描**不是库的能力**，
       --        库只提供同步的写方法；调度归宿主（详见 §4.15.5 与 ADR-5 的适用范围注记）。
       --        ⇒ 若宿主要做，须由宿主自己分片、自己在两次调用之间让出事件循环，
       --          **并接受「这 1~3 秒内该库的其它调用会一起等」**（单写者模型的必然结果）。
       --      · 命中后走**与实时层完全相同的合并路径**（§4.9 步骤 3c）——
       --        同一事务、同一 payload、同一个 `merge` 事件。
       --      · ⚠️ 该合并**不能覆盖新正文**：步骤 3c 的规则是「无条件采纳新文本」
       --        （ADR-9），而扫描拿到的是**库里的旧正文** ⇒ 它会把库里的新正文
       --        **顶掉**！⇒ **这一层只做「标记 + 提示」，不自动合并**，
       --        或必须携带「本次写入的原始文本」再走 3c。
       --        **本版取后者**：宿主在扫描时携带原始文本，走同一条 3c 路径。
       --   ⇒ 代价（明写）：**实时层漏掉的近重复会在库里停留一段时间**
       --     （宿主扫描周期内）⇒ 这不是缺陷，是「快 vs 全」的取舍。
   b. 对候选（文本路 ∪ 向量路，按 id 去重）逐个计算两个证据：
      · entityOverlap = 当前传入实体集合与该候选已关联实体集合的交集大小
      · cos           = 本次 @newVec 与该候选 embedding 的余弦（候选无 embedding 或本次无 @newVec 时 = null）
   c. 判定为「同一事件的新描述」的条件（**满足任一即可**）：
      · entityOverlap ≥ DEDUP_ENTITY_MIN（默认 2）——原有规则，不变
      · cos ≠ null 且 cos ≥ DEDUP_COS_MIN（默认 0.92）——新增，专治同义改写
      —— 为什么 0.92 不再叠加「共享 bigram ≥ 1」：这条规则存在的全部意义就是捞同义改写，
         而它们通常没有共享 bigram；再加字面条件等于把它废掉。
         0.92 在归一化嵌入空间里已属「几乎同一断言」的保守线（同主题不同断言一般 0.75~0.88），
         且候选已被限制在 top VECTOR_TOPK 内，误合并风险可控。
         **代价明写**：不同断言但措辞高度相似的两句（「她喜欢猫粮」/「她讨厌猫粮」）余弦也可能过 0.9，
         这类误合并会把两条相反事实并成一条。缓解手段是 §4.9.1 的人工修正入口与 content_history，
         而不是把阈值拉到 0.97（那样这条规则就只剩形式意义）。**阈值不是安全线，是取舍点。**

   ★ **多个候选同时达标时选哪一个**（v2.1 勘误 / ADR-P1-T07-DEC D-4：原稿只写「判定成立则进入原子合并」，
     **没写选谁** ⇒ 实现者各自发挥 ⇒ 同一份输入在不同实现里合并到不同的记忆）：
     **entityOverlap 降序 → cos 降序（`cos` 为 `null` 的排最后）→ raw_bm25 升序 → id 升序。**
     ⇒ **最后一级 `id` 升序是必需的**：没有它，这个排序就不是**全序**
       （§12 对排序的要求：「排序有全序 tie-break」）⇒ 同样输入不可复现。
     ⇒ **不要**改成「取第一条达标的就合并」：那会让「先命中哪个候选」取决于 BM25 抖动，
       而合并是**不可逆**的正文改写（只能靠 `content_history` 兜底）。
     ⇒ ⚠️ **「`id` 升序」这一级的守卫方式与其他三级不同**（ADR-P1-T07-DEC D-4 补充）：
       它是**可复现性**的唯一保证，但**行为级断言覆盖不了它**——
       要让两个候选的 `raw_bm25` 相等，它们必须有相同的 `content_tokens`
       ⇒ 相同正文 ⇒ 相同 `content_hash` ⇒ **撞 `idx_mem_hash` 唯一索引** ⇒ **构造不出来**。
       ⇒ 守卫放在**比较器级**：`compareMergeCandidates` 直接单测（四级全序 + `id` 升序那一格）
       ＋ **全序性性质断言**（任意两个键 ⇒ 比较器返回非 0 且反对称）；
       行为级只守「同分候选**恒定**选中同一条、连跑两次结果一致」。

   → **判定成立则进入原子合并**（UPDATE，与归档同事务）：
        ① 先把**现有正文**归档进 content_history（这是唯一的版本兜底，须与下面的 UPDATE 同事务）：
           INSERT INTO content_history(memory_id, content, content_tokens, replaced_at, reason)
           VALUES(m.id, m.content, m.content_tokens, now, 'merge');
           -- 不写 id 列：它是 INTEGER PRIMARY KEY AUTOINCREMENT，手写值会与自增序列抢号，
           -- 后续自增撞上历史手写值时直接 UNIQUE 报错。§4.9.1 步骤 3 的写法与此保持一致。
        ② 正文采纳规则（**无条件采纳新文本**，不做长度比较）：
           content = 新文本; content_tokens = tokenize(新文本); content_hash = @newHash
           -- ⚠️ @newHash 就是**步骤 2 算出的那个 content_hash**（对输入文本归一化后的 sha1），
           --    不是这里重新算的。步骤 2 已验证「该 hash 在未删记录中不存在」，
           --    重算等于丢掉这个前置保证——而它正是「合并后不撞 content_hash 唯一约束」的依据。
           -- 旧正文已在 ① 归档（reason='merge'），新文本必然上位
           embedding = @newVec    -- 本次传了就写新的；**没传就置 NULL**
           -- ★ ★ **改了 embedding 就必须同步更新桶归属**（§9.3.0）：同事务内调用
           --   `assignBucket(id, @newVec)`（**从旧细桶移出 + 插入新细桶**，同事务）。
           --   ⚠️ **阶段 1（P1）暂缓这两步**（见本节开头的「阶段性豁免」）：
           --     阶段 1 没有细桶 ⇒ 桶行写不进去；且阶段 1 没有桶行可 unassign。
           --   ⚠️ **漏了这一步的后果不是「召不回」，是「排在错位置」**：
           --      它的向量已与旧桶心不匹配，却仍被扫到并参与排序 ⇒ **召回质量静默劣化**。
           --   ⚠️ **没传向量（置 NULL）⇒ 必须 `unassignBucket(id)`**：
           --      桶里留一条没有向量的行 ⇒ 桶计数偏大 ⇒
           --      `p95BucketSize` / `maxBucketSize` / 兜底切分判定量**全部偏**。
           -- ⚠️ 这一行不能省，也不能「保留旧向量」：旧向量描述的是旧正文，
           --    留着它等于造出一条「语义指向已不存在的内容」的记录——向量路会把它捞出来，
           --    正文却是另一句话，而且**不会报任何错**。
           --    置 NULL 的代价只是这条记忆暂时退出向量路（文本路与图谱路仍可召回），
           --    下次 write 带上向量时按步骤 2 的规则补回。
           -- 取舍理由与代价见本节代码块之后的说明块
        ③ 稳定度加固（**统一走 §4.2 的 growStability()**，守卫与上限都在里面）：
           const { intervalDays, boosted } = growStability(db, m, DEDUP_BOOST, false, now)
           // useSpacing=false：合并不是间隔重复
           // 同日不增长、隔天才涨 ×DEDUP_BOOST、且始终受 MAX_STABILITY 钳制
           // intervalDays / boosted 直接用于下面 ⑦ 的 events payload
        ④ （last_access / access_count 已由 growStability 一并更新，此处不再重复赋值）
        ⑤ 补充新实体到 memory_entities——**与步骤 2 用同一算法**，不要各写一份：
           @addedEntities = @linkedEntityIds 中不在 SELECT entity_id FROM memory_entities WHERE memory_id = m.id 的那些
           非空则 INSERT OR IGNORE INTO memory_entities(memory_id, entity_id) VALUES (m.id, @e1), ...;
           算出的 @addedEntities 直接喂给下面 ⑦ 的 payload（不要在那里重新算一遍，两处会漂移）
        ⑥ content / content_tokens / content_hash 每次合并都会变更，FTS 索引由触发器 mem_au 自动同步，
           不需要手动维护
        ⑦ 记录 events(type='merge', memory_id: m.id,
             payload={ targetId: m.id, intervalDays,
                       boostApplied: boosted,      // ← 用 growStability 返回的 boosted；直接写 boostApplied 会是 undefined
                       contentText: 新文本, contentLength: 新文本长度, contentHash: @newHash,
                       // ↑ 用 @newHash，不要在这里重算（重算还得再过一次 normalize，多一处漂移机会）
                       prevContentLength, addedEntities: @addedEntities,
                       hasEmbedding: (@newVec !== null) })   -- 恒带该键：合并后这条记忆是否仍有向量
           （contentText 属于 §8.2 定义的「可脱敏区」，硬删时会被替换为 "[redacted]"）
        返回原 id 与 { merged: true, exact: false, content: 新文本,
                         warnings: @warnings }。    -- @warnings 见步骤 1c，无冲突时为 []
      → **若无实体（input.entities 为空）**：实体重叠恒为 0，判定只剩 `cos ≥ DEDUP_COS_MIN` 一条。
        这里**不是**「近似去重完全失效」——
        因为同义改写恰恰是向量路的主场。但仍有两点要认清：
        · 调用方若**既不给实体也不给向量**，近似去重才真正完全失效，只剩 content_hash 一条防线。
          这是 ADR-2（实体由调用方提供）+ ADR-10（向量由调用方提供）叠加的直接代价，不是 bug。
        · 单靠 cos 判定时误合并风险高于「实体 + 向量」双证据，且**无法用实体交集兜底**。
          在意准确率的调用方，仍应尽量给 `write()` 传实体。

4) 全新事实创建：
   ★ **同事务内更新 `vector_cell_members` —— 调 assignBucket(newId, @newVec)****（§9.3.0）
       -- ⚠️ **新建是唯一的入口**：漏了这一步 ⇒ **向量路对所有新记忆恒空**
       --   （旧记忆还能靠历史桶归属召回，新记忆一条都进不来）。
       执行 INSERT memories（含 `embedding = @newVec`，为 null 时该列为 NULL），批量插入 memory_entities，记录
       -- ★ 同事务内更新 `vector_cell_members` —— 调 assignBucket(...)（§9.3.0）
       --   ⚠️ 漏了这一步 ⇒ 有向量但不在任何桶里 ⇒ 向量路永远召不回，
       --   而 `embeddedRatio` 却在涨 ⇒ **静默、永久**。
       --   ⚠️ **阶段 1（P1）暂缓这一步**（见本节开头的「阶段性豁免」）：
       --     阶段 1 没有细桶 ⇒ 桶行写不进去；欠账由阶段 2 的启动对账 / 首次重训补齐。
  events(type='write', memory_id=<新 id>,
    payload={ id, kind, contentText, contentLength, contentHash,
      entityIds: @linkedEntityIds, emotion, confidence,
      hasEmbedding: (@newVec !== null),   -- 恒带该键：事后能判断「这条为什么没进向量路」
      initialStability, initialDifficulty })
  （同样遵守 §8.2：正文只放 contentText，且该键是唯一可被遗忘流程脱敏的字段）
  ⚠️ **payload 里没有 `entityNames`**（勘误）：本键只在 §4.9 步骤 4 的伪代码里出现过，
    而 §8.4 的 write 行与 `EVENT_PAYLOAD_KEYS.write` **都没有它**
    ⇒ 两处不一致 ⇒ 以 §8.4（事件 payload 契约的唯一权威）为准，删去该键。
    实体名可由 `entityIds` 查 `entities` 表得到 ⇒ 信息不丢，且少一份冗余快照。
  返回 { id, merged: false, exact: false, content: input.content,
           warnings: @warnings }。    -- @warnings 见步骤 1c，无冲突时为 []
```

> **为什么无条件采纳新文本**（替代「保留更长版本」的长度启发式）：
>
> 1. **长度不是信息量的代理。**「PG15 · Docker · 5432」比「已升级到 PG17」长，只是列举得多，  
>    不是信息量更大。一个罗嗦的过时段子和一个精炼的当前事实可以等长，信息量差十倍。
> 2. **这条规则有系统性偏差，不是偶尔判错。** `write()` 的调用方是 LLM 做记忆抽提，  
>    把一轮对话提炼成一条事实——提炼天然精简，同一事实第二次写入通常比第一次短。  
>    长度规则因此会**稳定地**让旧版本获胜。更糟的是每次合并都按 `DEDUP_BOOST` 加固 stability，  
>    等于让过期的正文越错越牢。
> 3. **「信息量最大」在本架构下无法兑现。** `content_history` 不参与召回（§4.6 三路候选只查 `memories`、  
>    `mem_fts` 与 `memories.embedding`，没有一条路读这张表），被沉入的版本对 LLM 完全不可见。所谓「保留信息量更大的版本」  
>    实际实现的是「旧版本胜出」——既不准，也没真把两版都给下游看。
>
> **代价（明示）**：
>
> - 放弃「越合并越短」的防护。若调用方反复用低质量抽提覆写，正文可能逐步劣化；  
>   兜底是 `content_history` 完整保留每一版与 §4.9.1 的人工修正入口。  
>   劣化是**可观测**的：`merge` 事件的 `prevContentLength` / `contentLength` 就是每次覆写的长度比，  
>   若某条记忆的该比值长期显著 < 1，说明上游抽提在丢信息，应去检查抽提 prompt 而不是回退到长度保护。
> - ⚠️ **「完整保留」只有在能读出来时才构成兜底。** `content_history` 不参与召回，§6 也刻意不提供  
>   读取历史正文的公开方法（理由见本节「代价」倒数第二条），所以旧版本的**唯一**查看入口是 §7.2 面板 6「版本历史」。  
>   这不是可选项：**该面板缺失时，本节所说的兜底就等于不存在**——正文一旦被覆写就再也取不回来。  
>   而「无条件采纳」意味着这条路径**每次合并都会走一次**，不是偶发，所以面板 6 与本节是绑定的，  
>   实现时不能当作「查看器的锦上添花」推迟。  
>   还原动作 = 从面板取旧版正文 → 调 `updateContent()`。当前版会被再归档一次（`reason = 'manual_fix'`），  
>   历史链条不丢，只是多出一版——这是刻意如此：还原本身也是「一次正文变更」，必须留痕。
> - 正文变短 → 该记忆在 FTS 上的 token 覆盖面积缩小，被**宽泛**查询命中的概率略降；  
>   但相关词密度上升，**精确**查询的 BM25 反而更高。净效应方向不确定，留待 §12 阶段 3 用真实数据回归。
> - **content_history 会单调增长**：每次合并或人工修正都追加一版，永不自动清理。  
>   一条被反复提及 100 次的记忆就有 100 条历史版本。它不参与召回，也不占 FTS 索引  
>   （`content_history` 没有单独的 FTS 表——实现时切勿把它的 `content_tokens` 加进 `mem_fts`，  
>   那会污染召回），但 db 文件会持续变大。若库要长期运行，需给它定保留策略  
>   （保留最近 N 版，更早的按 `replaced_at` 归档或丢弃）——暂不做，留作后续迭代。
> - **刻意不提供读历史正文的公开方法**（不叫 `getHistory` / `listVersions`，§6 里没有对应成员）。  
>   理由：一旦有这个口子，调用方极易把「最新一版历史」当「当前正文」使用——两条事实同时可见时，  
>   **「当下最准」就没有唯一答案了**，而这正是本决策的全部意义。需要程序化取旧版的场景  
>   （迁移、导出、审计）直接对 `content_history` 表 SELECT：结构在 §3 固定，  
>   `idx_ch_memory(memory_id, replaced_at)` 就是为这个「按记忆取倒序版本」的查询建的。  
>   给它加方法，必须同时改 §6 成员计数（13 写 + 4 读 + 1 构造）与 §12 的方法归位表——别只在 §6 加。
> - 若将来确实需要「新旧两版都对 LLM 可见」，正确做法是**显式结构化合并**（正文内带时间标记保留两版），  
>   而不是退回长度竞猜——后者连自己的目标都代理不了。


### 4.9.1 显式修正正文（updateContent）

`write()` 的正文采纳规则是「无条件采纳新文本」（见 §4.9 步骤 3c ②），  
所以「新描述更短更准却进不来」这个空洞已经自动堵上。但还有两类需求 `write()` 覆盖不了：

1. **人工纠错**——抽提本身就错了（把「她不喜欢猫粮」记成「她喜欢猫粮」）。  
   这不需要经过相似度检测，需要的是「照我说的改」。§14.1 明令禁止「记忆失真」，本接口是它的兑现点。
2. **只改正文、不加固**——`write()` 命中合并会按 `DEDUP_BOOST` 抬 stability，  
   而「修正一处记错的字」不该让这条记忆变得更牢固。

`updateContent()` 同时解决这两点：绕过去重直接改写，且**不触碰 stability / last_access / access_count**。

```
updateContent(id: string, newContent: string, now?: number, embedding?: number[]): void

1) SELECT * FROM memories WHERE id = @id AND deleted = 0;
   不存在 → 抛 MemoryError.NOT_FOUND。
2) 归一化（同 §4.9 步骤 2）→ @newHash = sha1(normalize(newContent))
   -- 必须过 normalize：updateContent 与 write 对同一段文本要算出**同一个** content_hash，
   --   否则 idx_mem_hash 的唯一性约束与下面 2a 的幂等判断同时失效
   @newVec = 本次要写入的向量，规则与 §4.9 步骤 2 的 @newVec **完全一致**（同一套校验、同一处归一化）：
             embedding 参数直接给 → 用它；没给但配置了 embedder → 现算；都没有 → null
   a. @newHash === m.content_hash → 幂等：正文没变，直接返回，不写 content_history。
      -- ⚠️ 幂等返回时**不要**顺手校验或更新 embedding：正文没变，向量就不需要变，
      --    此时覆盖向量等于让调用方误以为「传了向量就等于改了正文」。
   b. 存在其它未删记录 content_hash = @newHash → 抛 MemoryError.CONFLICT（带 conflictingId）：
      这说明新正文与另一条记忆完全重复，调用方应改走 write()（去重合并）或先清理重复项，
      而不是让两条记忆的正文变得一模一样（那会让 content_hash 唯一约束失效）。
3) 归档旧正文（复用 §4.9 步骤 3c ① 的写法）：
   INSERT INTO content_history(memory_id, content, content_tokens, reason, replaced_at)
   VALUES(m.id, m.content, m.content_tokens, 'manual_fix', now);
4) UPDATE memories SET content = @newContent,
                       content_tokens = tokenize(@newContent),
                       content_hash = @newHash,
                       embedding = @newVec      -- 没传就是 NULL，**不能省**
                       -- ★ 同事务内更新 `vector_cell_members` —— 调 assignBucket(...)（§9.3.0）
                       --   ⚠️ 漏了这一步 ⇒ 有向量但不在任何桶里 ⇒ 向量路永远召不回，
                       --   而 `embeddedRatio` 却在涨 ⇒ **静默、永久**。
   WHERE id = @id;                 -- 触发器 mem_au 自动同步 FTS
   -- ⚠️ embedding 必须跟着正文一起换：正文改了而向量没改，这条记忆在向量路上就指向旧内容，
   --    召回结果与正文对不上且不报错。没传向量时置 NULL 是**正确的降级**（暂时退出向量路），
   --    不是「丢数据」——旧向量描述的正文已经不存在了，留着它才是错。
5) events(type='manual_fix', memory_id=@id,
     payload={ id, contentText: @newContent, contentLength, contentHash: @newHash, prevContentLength,
               hasEmbedding: (@newVec !== null) })   -- 恒带该键
6) **不改 stability / last_access / access_count。**
   修正的是「记的内容」，不是「记得多牢」。若确实希望顺带加固，调用方显式调 touch()——
   两件事必须分开，否则一次「改错字」会把强度莫名抬高。
```

> 与 `write()` 的分工：`write()` 表达「这是我对这件事的最新认知」，会走完整去重与稳定度加固；  
> `updateContent()` 表达「这条记录写错了，改掉它」，不做去重、不加固。  
> 两者的共同点：旧正文一律先归档进 `content_history` 再被覆盖，任何时候都能倒着还原  
> （查看入口见 §7.2 面板 6；还原 = 取旧版正文 → 再调一次本方法，当前版随之被归档，历史不丢）。


### 4.9.2 别名维护与实体合并（setAlias / mergeEntities）

**为什么必须有这一节**：§4.9 步骤 1c 写别名的两条路都是**静默跳过**——`ON CONFLICT(alias) DO NOTHING`，  
以及与 `entities.name` 冲突时「跳过并记 warn 日志」。而库里此前没有任何接口能把错挂的别名改回来：

- 「老张」被误挂到「张山」名下 → 之后正确写入被静默丢弃 → 所有「老张」的查询永远只命中张山；
- 「张三」与「張三」（简繁）、「Zhang San」与「张三」各建一个实体 → 图谱路从此分裂，  
  两组记忆互相看不见，且**没有任何办法恢复**（`entities.name` 是 UNIQUE，删不掉也改不了）。

静默失败 + 无修复入口 = 不可逆的数据损坏。两个显式入口是这条链路的兜底。

```
setAlias(alias: string, entityId: string): void

1) 校验 alias 不得是任何既有主名：
   SELECT id FROM entities WHERE name = @alias;
   命中 → 抛 MemoryError.CONFLICT（details.conflictingEntityId = 该实体 id）。
   —— **主名优先于别名**：若允许主名同时作为别名，§4.6 步骤 1 的解析顺序 ①② 会对同一字符串
      给出两个不同答案（① 命中 A、② 命中 B），召回结果取决于实现先查哪张表。
   —— ⚠️ **这一处刻意不用 §4.5 的 resolveEntity()**：那三处是「解析成 id」，
      这里要的是「检测冲突并抛错」，语义恰好相反。若误收拢，setAlias 会把「命中」
      当成成功返回，冲突检测静默失效——而这个冲突正是上面「主名优先于别名」规则要拦的。
2) SELECT 1 FROM entities WHERE id = @entityId;  不存在 → 抛 NOT_FOUND。
3) INSERT INTO entity_aliases(alias, entity_id) VALUES(@alias, @entityId)
   ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id;
   —— 与 §4.9 步骤 1c 的**关键区别**：
      写入路径用 DO NOTHING（批量补别名，不该覆盖别人的正确映射）；
      维护路径用 DO UPDATE（人明确要求改，必须生效）。两处不能统一，统一哪一边都是错的。
4) events(type='alias', payload={ action: 'set', alias, entityId, prevEntityId })
   —— 不必再同步什么「entities.aliases 的 JSON 冗余」：该列已从 §3 删除。
      aliases 的唯一权威来源就是 entity_aliases，展示层 join 即可，不存在第二份拷贝需要追平。

限制：别名只影响**后续**的召回与写入，不会重算历史查询。
（别名是解析期的映射，不是存储期的改写——不要指望改完别名，过去没召回的记忆会自动出现。）
```

```
mergeEntities(sourceId: string, targetId: string): void

0) sourceId === targetId → 幂等返回；任一不存在 → 抛 NOT_FOUND。
1) 迁移记忆关联（PK 是 (memory_id, entity_id)，直接改会撞主键，先插后删）：
   INSERT OR IGNORE INTO memory_entities(memory_id, entity_id)
     SELECT memory_id, @targetId FROM memory_entities WHERE entity_id = @sourceId;
   DELETE FROM memory_entities WHERE entity_id = @sourceId;
   —— ⚠️ ★ **不需要对 `memory_id` 做存在性预校验**（v2.1 勘误，把两处疑问一次说清）：
     ① **`memory_entities` 表确实有外键**（§3：`memory_id REFERENCES memories(id) ON DELETE CASCADE`、
        `entity_id REFERENCES entities(id) ON DELETE CASCADE`）——「这张表没有外键」是**误传**。
     ② **但本步骤不可能违反那个外键**：它是把**既有的行**逐字拷贝——
        `memory_id` 一律取自 `memory_entities` 已有行 ⇒ **不引入任何新的记忆引用**
        ⇒ 拷贝出来的 `memory_id` 必然指向一条存在的 `memories` 行（外键要么本来就成立，要么是历史脏行）。
     ③ **`entity_id` 那一侧也不会违反**：写入的 `@targetId` 由**步骤 0 的存在性校验**保证存在。
     ⇒ 所以「预校验 `memory_id` 是否存在」是**为一个不可能发生的错误加一次全表扫描**：
        它挡不住任何真实故障，只是让合并变慢。
     ⚠️ **真正要防的是 `PRAGMA foreign_keys` 漏开**（§9.1 的**每连接**开关，R-08）——
        但本步骤**不依赖 CASCADE**：它自己把源实体的行显式搬走、再显式删掉
        ⇒ 漏开 FK 也不会留下「指向已删实体的孤儿关联行」。
     ⚠️ 结论：**现在不加预校验**。若将来 `memory_entities` 的外键语义发生变化
        （例如加上 `ON DELETE RESTRICT` 之类的新约束），**届时**再补预校验并同步本处与 §11.2 的自校验清单。
2) 迁移边（可能与既有边撞 UNIQUE(subject_id, predicate, object_id)，必须逐条判冲突）：
   对 source 参与的每条边 e：
     若已存在同三元组且已指向 target 的边 e2：
       -- ⚠️ 以下三行是 **JS 伪代码**（常量裸名，照 §4.5 开头约定）：
       e2.weight      = min(MAX_EDGE_WEIGHT, e2.weight + e.weight)   -- **取和，不取大**
       e2.last_active = max(e2.last_active, e.last_active)
       e2.memory_id   = COALESCE(e2.memory_id, e.memory_id)
       -- 下面这行是 **SQL**（参数必带 @）：
       DELETE FROM edges WHERE id = e.id;
     否则：UPDATE edges SET
              subject_id = CASE WHEN subject_id = @sourceId THEN @targetId ELSE subject_id END,
              object_id  = CASE WHEN object_id  = @sourceId THEN @targetId ELSE object_id  END
            WHERE id = e.id;
            -- 必须用 CASE **分别**判断两个端点：一条边只有一个端点可能是 sourceId。
            -- 若按字面写成 `SET subject_id/object_id = @targetId`，会把**另一端也改成 targetId**，
            -- 等于凭空造出一条「目标指向自己」的假关系。
   —— 为什么取和：取大等于凭空砍掉一半关系强度。两条各 0.8 的边合并后应得 1.6，
      若取大只剩 0.8，可能直接跌破 ACTIVATION_MIN 让扩散永久失效（沉默的功能消失）。
   —— ★ **`mergedEdges` 的口径（v2.1 勘误）**：**本次因三元组冲突而被折叠掉的边数**
     （即上面「`DELETE FROM edges WHERE id = e.id`」那一支的执行次数）。
     ⚠️ **只改指、无冲突的边不计入**——它们是「搬迁」，不是「合并」。
     ⇒ 由此得到一条**可对账的恒等式**（合并前后各数一次 `edges` 的行数即可核）：
          合并前的边数 − 合并后的边数 == mergedEdges + droppedSelfLoops
        （每次冲突合并净删一条边；每次自环清理净删一条边；这两者之外边数不变）
     ⇒ 口径一旦漂移（例如改成「迁移的边总数」），这条恒等式立刻不成立 ⇒ 可被对账当场抓住。
     ⚠️ 命名上的刻意对照：`movedMemories` 是「**迁移**」的记忆关联条数（全部迁走的行），
        `mergedEdges` 是「**合并**」掉的边数（只数冲突那一支）—— 两者刻意不同义，
        不要拿「迁移了几条边」去填 `mergedEdges`。
2b) 清理合并产生的自环（原 A→B 迁移后变成 A→A）：
   DELETE FROM edges WHERE subject_id = @targetId AND object_id = @targetId;   -- 计数入 droppedSelfLoops
   -- 只删**本次目标实体**身上的自环。不要写成 `WHERE subject_id = object_id`——
   -- 那会把全库所有自环清掉（包括与本次合并无关的），属于误伤。
   -- 迁移前 source 的自环（source→source）迁移后正好落在这个范围内，所以不会漏。
   —— 自环在扩散里毫无意义（neighbor_entity 恒为自己）且会污染 visited 集合，必须清掉。
3) 迁移别名，并把被合并实体的主名降级为别名（否则旧名字此后召回不到）：
   UPDATE entity_aliases SET entity_id = @targetId WHERE entity_id = @sourceId;
   INSERT INTO entity_aliases(alias, entity_id) VALUES(@sourceName, @targetId)
     ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id;
   —— 无需同步任何 JSON 冗余列（`entities.aliases` 已从 §3 删除，权威唯一来源是 entity_aliases）。
4) DELETE FROM entities WHERE id = @sourceId;   -- 此时已无任何引用，各外键不会级联误删数据
5) events(type='alias', payload={ action: 'merge', sourceId, targetId,
     movedMemories, mergedEdges, droppedSelfLoops,
     aliasAdded: true,        -- ★ **布尔**：本次是否新增/改写了一条「别名 → 实体」映射
     alias: sourceName })     -- ★ 被降级为别名的**源实体主名**本体
   -- ⚠️ ★ **v2.1 勘误：`aliasAdded` 是布尔，不是被降级的主名**。
   --   原稿写的是 `aliasAdded: sourceName`（与 §8.4 的键集表无关，但与
   --   `src/core/events.types.ts` 的 `AliasEventPayload.aliasAdded?: boolean` 直接冲突：
   --   **同一个键名在两处表达两件事**（一个字符串、一个布尔）⇒ 重放器读到哪种含义取决于实现）。
   --   ⇒ **裁决：`aliasAdded` = 布尔**（是否新增/改写了别名映射）；
   --     **被降级的主名本体记在 `alias` 键上**。
   --   ⇒ 为什么这样不丢信息：合并后源实体行被删（步骤 4）⇒ **它的主名在库里只剩别名表与事件两处**；
   --     `alias` 键保住了名字，`aliasAdded` 键说明了「确实动过别名映射」⇒ 两条信息一条不丢。
   --   ⇒ 为什么不用 `aliasAdded` 装名字（另一种写法）：那样同一个事件类型里
   --     `alias` 与 `aliasAdded` 会**在两个 action 下各表示一件事**（`set` 时 `alias` 是被设置的别名、
   --     `merge` 时 `aliasAdded` 是被降级的主名）⇒ 一个事件类型两套词，违反 C36 的同源纪律。
   --     现在的口径是：`alias` 在**两个 action 下都是「本次涉及的别名名」**，语义统一。
   --   （类型与口径的完整约定见 §8.4 表后的「alias 行的字段类型约定」。）
```

> **为什么放在 §4.9 而不是单开一节**：这两个操作改的是「后续写入与召回如何解析实体」，  
> 与 §4.9 步骤 1 的归一逻辑是同一件事的两面——分开放必然再次漂移成两份不同的解析规则。


### 4.10 维护清理（sweep）

sweep 是**唯一会批量物理删除**的入口。它的三个动作（清理 / 统计 / 空间回收）彼此独立，  
`purgeDeletedDays` 与 `vacuum` 都不传时它**不删任何记忆行**（仍会写一条汇总事件，见步骤 4）——  
但这指的是「本次没有破坏性动作」，**不是「它变成了只读方法」**：`sweep` 整体归入写操作范畴，  
在只读句柄上一律拒绝（理由见本节末尾）。  
想要一次纯读的统计，请调 `stats()`，不要靠「传空参给 sweep」凑合。

```
sweep(options?: { purgeDeletedDays?: number; vacuum?: boolean }, now?: number)
  : { purged: number; archivedCount: number }

1) 物理清理软删记录（仅当传入 purgeDeletedDays > 0）：
   @cutoff = now - purgeDeletedDays × 86400000
   @sweepBatch = SWEEP_BATCH_SIZE
   -- ⚠️ 下面凡写进 SQL 的变量一律带 `@`：裸写 `cutoff` / `SWEEP_BATCH_SIZE` 会被 SQLite
   --   逐字当成**列名**，执行时报 `no such column`（与 §4.5 开头立的约定同源，
   --   本节这两处同样不能漏）。
   循环：
     SELECT id, deleted_at FROM memories     -- ⚠️ 必须一并取出 deleted_at：下面 ① 会把整行删掉
     WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < @cutoff
     LIMIT @sweepBatch;                      -- 默认 500；分批避免长事务与长时间持锁
     本批为空 → 退出循环
     → 逐条执行（每条一个事务，与 §4.8 hard 删除语义完全一致）：
         ① DELETE FROM memories WHERE id = @id;   -- mem_fts 由触发器、memory_entities/content_history 由 FK CASCADE 同步
         ② 脱敏该 id 的事件正文（否则「行删了、正文还在 events 里」，与 §8.2 冲突）：
            直接复用 §4.8 步骤 ② 的那条 SQL（按 events.memory_id 索引定位 + json_valid 兜底），**不要另写一份**：
            UPDATE events SET payload = json_set(payload, '$.contentText', '[redacted]')
            WHERE memory_id = @id AND CASE WHEN json_valid(payload)
                   THEN json_extract(payload, '$.contentText') IS NOT NULL ELSE 0 END;
         ③ 追加 events(type='sweep', memory_id=@id, payload={ id, reason: 'purge_deleted', deletedAt })
            -- deletedAt 取自本批 SELECT 的列值。**不要在这里回查**：① 已把该行删掉，
            --   SELECT deleted_at FROM memories WHERE id = @id 只会返回空，payload 落成 null 或抛错。
     purged += 本批实际处理条数
   ⚠️ **任一条抛错即中止整个 sweep 并上抛**，不要 try-catch 之后继续下一批：
      删不掉的行不会被 DELETE 移除，下一轮 SELECT 仍会选中它——「循环直至本批为空」
      在这种情形下是**死循环**，而且每轮都在写事件，库会持续膨胀。
      （典型触发：某表以 ON DELETE RESTRICT 引用 memories、或 trigger 里 RAISE。）
   注意：schema 上的状态一致性 CHECK 已保证「deleted = 1 必有 deleted_at」，
        因此新建库不可能出现脏数据；若从旧版本迁移而来、存在 deleted = 1 且 deleted_at IS NULL 的记录，
        WHERE 条件已将其排除，sweep 保守跳过（不清理）——这类行**不会**导致死循环（它们不被选中）。
        需人工核查后补写 deleted_at 或直接硬删。

2) 统计归档数（只读，不删除）：
   因 intensity 依赖数学函数，统一在应用层计算。
   @archivedCount = countArchived(db, now)      -- ← 与 stats() 共用同一个函数，**不要各写一份**
   -- countArchived 的实现：分批 SELECT rowid, stability, pin_factor, last_access
   --   FROM memories WHERE deleted = 0 AND rowid > @lastRowid ORDER BY rowid LIMIT @sweepBatch;
   --   逐条算 intensity(m, now)，累加 <= ARCHIVE_LINE 的条数，@lastRowid 推进到本批末条。
   --   用 rowid 游标而不是 LIMIT/OFFSET：OFFSET 是 O(n) 扫描，翻到第 100 页要重扫前 100 页。
   -- 扣掉这一项统计 ≈ 全表 intensity 计算，是 sweep 里最重的一步；调用方若只要清理结果，
   --   不要因为「顺手看一眼」而每次 sweep 都触发它（见下方返回值的说明）。
   （归档只统计、不落库标记——层级与归档状态均为运行时派生值，见 §4.4。）

3) 可选空间回收（vacuum = true **且** purged > 0）：
   @vacuumed = false
   if (vacuum === true AND purged > 0):
     硬删完成后依次执行：
     ① db.transaction(() => INSERT INTO mem_fts(mem_fts) VALUES('rebuild'))();
        -- FTS 重建单独包一个事务：它是写操作，中途失败会让索引停在与主表不一致的状态。
        -- 不能与下面的 VACUUM 同事务——VACUUM 在事务内执行会直接报错。
     ② VACUUM;
        -- 回收磁盘空间。**必须在事务外执行**，better-sqlite3 用 db.exec 直接跑。
     因 memories 使用显式 rowid INTEGER PRIMARY KEY AUTOINCREMENT，VACUUM 不会重排主键，FTS rowid 映射安全。
     @vacuumed = true
   -- 为什么 purged = 0 时跳过：VACUUM 会全量重写数据库文件并在此期间独占写锁，
   --   没有页可回收时执行它只有代价没有收益。定时任务每日跑 sweep 是常态，
   --   而绝大多数日子一条都清不掉——不加这个前置条件，每天的定时任务都会锁库重写一遍。
   -- rebuild 同理：它依赖的是「刚发生过硬删」这个前提，没有硬删就没有需要修复的错位。

4) 追加汇总事件（无论 1) 是否执行，都要记一条）：
   events(type='sweep', memory_id: null, payload={ purged, archivedCount, vacuumed })
   -- memory_id 必须是显式 null，不能挂某一条记忆上：这是整次 sweep 的汇总，
   --   挂到某个 id 上会让该记忆的脱敏范围（§4.8 步骤 ②）莫名覆盖这条汇总。
   -- 字段名用 vacuumed（**实际是否执行**）而不是 vacuum（入参）：传了 true 但 purged = 0 时
   --   实际没执行，回显入参会让日志看起来「执行过 VACUUM」。
```

**返回值的两个字段语义不同，不要当成同一类结果读**：

- `purged` 是**本次动作的结果**——这次真删掉了几条。
- `archivedCount` 是**当时的库状态快照**，与本次 sweep 无关：purge 删的是 `deleted = 1` 的行，  
  而归档统计只看 `deleted = 0`，两个集合不相交。所以 sweep 前后它**一样**。  
  它出现在返回值里，是因为定时任务跑完通常想顺带看一眼库的健康度；  
  但它与 `stats().archivedCount` 是同一个数，实现必须共用 `countArchived()`，  
  不要在两处各算一遍（两处各算 = 迟早漂移，且漂移后没人知道该信哪个）。

**`vacuum` 是否真的执行，看汇总事件的 `vacuumed`，不要看入参**：`vacuum: true` 但 `purged = 0` 时不会执行  
（理由见步骤 3 的注释）。返回值不含该字段——它是执行轨迹而非业务结果，查 `events` 即可。

**只读实例**：`sweep` 属于写操作范畴（§7.1），在 `readonly: true` 的句柄上**一律抛  
`MemoryError.READONLY_VIOLATION`**，即使本次调用既没传 `purgeDeletedDays` 也没传 `vacuum`。  
理由：按入参动态决定「这次算不算写操作」会让同一方法的行为随参数跳变，  
调用方无法从签名判断安全性；只读场景要统计归档数，应调 `stats()`（它是纯读，语义明确）。

---


### 4.11 神经元交互（第五个概念）

前四个概念都落在**一条记忆自身**上：内容（多模态）、结构（图谱）、深度（多层）、时间（遗忘曲线）。  
⚠️ 按 §2 的口径，**「深度」是「强度」的投影、「时间」是时间引擎**——  
三属性实为**内容 / 结构 / 强度**，两引擎为**遗忘曲线（时间驱动）/ 神经元交互（网络驱动）**。  
神经元交互是**记忆之间的关系动力学**——它改变的不是某一条记忆有多重要，  
而是「哪些记忆会因为被一起想起而靠得更近，哪些会因为讲同一件事而互相让位」。

它由三个机制组成，各自解决一个 v1.0 解决不了的问题：

| 机制                          | 它解决什么            | v1.0 的缺口                                                    |
| --------------------------- | ---------------- | ----------------------------------------------------------- |
| **共激活强化**（Hebbian）          | 一起被想起的记忆，关联会变强   | v1.0 的强化只有两个源（重复 link、touch 按证据记忆），**没有 memory↔memory 的共现** |
| **侧抑制**（lateral inhibition） | 讲同一件事的记忆互相让位     | v1.0 的打分是纯加权求和，5 条 topN 里可能 3 条讲同一件事                        |
| **激活回写**                    | 被联想唤起且被采纳的记忆会被加固 | v1.0 的 `diffused` 是**只读**的，唤起不留下任何痕迹                        |

#### 4.11.1 共激活的数据形态与它不是什么

```sql
-- @example  （本块是示例片段，不参与建库）
-- 共激活表已在 §3 定义。这里只强调三处最容易搞错的地方：
-- ① 它是 memory↔memory，不是 entity↔entity（那是 edges）
-- ② 它是**统计共现**，不是**语义关系**：没有 predicate，因为它说的不是「是什么关系」，
--    而是「这两条记忆被反复一起想起」
-- ③ 它**不参与召回打分**（§4.6 的五因子公式里没有它），它参与的是
--    「簇的涌现」与「簇跳扩散」
```

**coacts 与 edges 的分工**（这一条必须写死，否则会出现「讲同一件事的两个人被合并」的事故）：

|        | `edges`                  | `coacts`            |
| ------ | ------------------------ | ------------------- |
| 连接谁    | 实体 ↔ 实体                  | 记忆 ↔ 记忆             |
| 是什么    | 语义断言（住在/喜欢/养）            | 统计共现（被一起想起）         |
| 谁写     | `link()` / `linkByIds()` | `touch()`（§4.11.2）  |
| 会不会被合并 | 实体合并时边权重取和（§4.9.2）       | **不合并**，只衰减         |
| 用在哪    | §4.6 图谱路、§4.7 实体跳        | §4.11.3 侧抑制、§4.12 簇 |

#### 4.11.2 共激活的写入时机（**唯一写入入口：touch()；两个建边机制**）

★ **机制 A 的正文（与标题对齐）**：  
机制 A 是「**同一批 `touch(ids)` 内**的机械共现判定」——  
批内任意两条满足 §4.11.4 ① 的证据门槛（共享实体数达标 或 余弦达标）即建边，  
**不需要调用方声明**。  
⇒ **机制 A 的作用域天然是批内**（跨批次的关联只能由机制 B 声明）。  
⇒ ⚠️ **第三种写入源明确不实现**：`write()` 时的同批写入配对 ——  
写入路径**不建共激活边**（`write()` 表达的是「这条内容被写下来了」，  
**不是「它和同批的其它内容被一起用过」**）。

```
**唯一写入源：touch(ids, now?, options?: { coActivateWith?: Array<{ memoryId, seedIds, activatedAt? }> })**

  `options.coActivateWith` 是调用方对「谁与谁一起用过」的**显式声明**：
  - `memoryId`：本次被采纳的记忆（必须是 `ids` 的成员，否则抛 `INVALID_INPUT`）
  - `seedIds`：唤起它的那条（或那些）记忆——**由调用方声明**
  - `activatedAt`：唤起时刻（缺省 `now`）

  库据此建立/强化 `memoryId ↔ seedIds` 的共激活边，按 §4.11.4 的公式。

  ⚠️ **为什么种子必须由调用方声明，库不能自己推断**：
  库曾考虑用「召回种子台账」推断（记下 B 被哪个种子唤起，后来 touch B 时据此建边）。
  **这个设计是错的**：台账是**推测**——调用方可能从别处拿到 B（比如从它自己的历史里），
  恰好后来 touch 了它，库就会把一个从未发生的因果关系记成事实。
  **把因果归因到库无法确知的事上，是本库从头到尾在避免的那类错**（§2 原则⑤ 同源）。
  ⇒ 因果判断归调用方（与 ADR-2「实体抽取归调用方」、ADR-10「向量由调用方提供」同构），
  库只做归一与存储。

  ⚠️ **种子不存在或已软删 → 跳过并记 `coactSkipped(reason='invalid_seed')`，不抛错**：
  种子被遗忘不该让整个 touch 失败（那会让「清理一条旧记忆」这个操作连带失败）。

  单次 touch 最多记 `COACT_MAX_PAIRS_PER_TOUCH`（默认 20）对，超出按数组顺序截断，
  **截断数必须写进事件**（`coactPairsTruncated`）**并由 `touch()` 的返回值 `truncated` 直接给出**
  （§6 的 `TouchResult`）——否则调用方不知道有多少对没被记上。
  ⚠️ **三种上界在此必须列全**（实现者常误以为只有 20 这一条）：
    ① `COACT_MAX_PAIRS_PER_TOUCH`（默认 20）——**单次 touch 记多少对共激活**，超出按序截断；
    ② `COACT_BATCH_MAX`（默认 256）——**单次 touch 的 `coActivateWith` 条目数上限**，
       超出是**硬拒 `INVALID_INPUT`，不是截断**（§6 `touch` 约束④）；
    ③ `COACT_AFFINITY_MIN`——**边的有效阈值**，决定一条共激活边「算不算存在」
       （§4.11.3），它影响**能不能连上**，不限制**记多少对**。
  ⇒ 截断取 ① 的上界；② 走抛错路径；③ 是有效性判定——三者语义不同，**不可混谈**。

  **本版不实现的写入源**：`write()` 时的同批写入配对。
  一条 write 只产生一条记忆，不产生配对；若调用方要一次写多条，先做 §4.9 的合并。

⚠️ recall() 绝不写 coacts（§2 原则 ⑤）。
   若召回参与共激活，topN 会自我强化：第一次检索就把库固化在早期话题上，
   之后越检索越窄。这是致命的正反馈，且**不报任何错**。
```

#### 4.11.2b 共激活强度的作用边界（**它管什么，不管什么**）

这是本机制最容易被误解的地方，必须写死：

```
共激活强度决定  ① 一条边是否存在（有效 affinity ≥ COACT_AFFINITY_MIN 才连上）
                ② 取哪几个邻居（簇跳 top-K 的排序依据）
名次            **一律由 §4.6 的五项权重决定**
⇒ 共激活与向量路严格同构：它决定「谁有资格被想起」与「想起谁」，
  但**不决定「谁排第几」**。
```

⚠️ **本版刻意不做「共激活加项」**（即不把 affinity 加进 score 或加成一个有界加分项）。  
三条理由：

1. **可归因性**：§4.6 明说五项权重「从未用真实查询回归过」。  
   在回归之前引入第六项，分数变化将**无法归因**——分不清是权重调整还是加项生效。  
   加项必须等回归定稿后，作为一次独立的 ADR 变更再加。
2. **不破坏铁律**：§4.6 的「五项权重恒和为 1.0」是硬约束（缺项记 0，不重算分母）。  
   加一个第六项会破坏这个整洁性，且让「score 的含义」变得依赖实现细节。
3. **向量路从未享受过这种优待**：向量路的候选靠 graphProximity / intensity / recency  
   活下来，那个「无 embedding 最高 0.75 分」的上限**全部来自五项之内**。  
   共激活若要靠加项才能活，它早有了——它现在活得好好的，靠的是簇跳与联想路。

⚠️ **为什么叫 `COACT_AFFINITY_MIN` 而不是 `COACT_CLUSTER_MIN`**：  
这个阈值有**三重身份**——① 簇的边判定；② `sweep()` 的淘汰判据；  
③「这一对还算不算一条关联」。叫 `CLUSTER_MIN` 会让其中两处名不副实。  
⇒ **一套阈值三处语义，不漂移**（与 §4.5 的 `EDGE_STABILITY` 同风格）。

#### 4.11.3 三条不可违反的原则

**原则 1：共激活由「被一起用过」喂养，不由「被想起」喂养。**  
`recall` 返回了 A 和 B，只说明它们相关；只有调用方 `touch([A,B])` 才说明它们被一起用上了。  
把「相关」当「用过」，会让检索本身改变库的拓扑。

**原则 2：侧抑制是纯计算，绝不写库。**  
抑制若落库，就成了「存出来的层级」——而本库第一原则是「层级是算出来的」。  
所以抑制只影响本次返回的排序，**任何候选的 score 都不被修改**。  
这也意味着：**关掉抑制，v1.0 的行为逐位复现**（这是 §12 验收的核心断言之一）。

**原则 3：共激活的强度由遗忘曲线衰减。**  
`affinity_eff(a,b,now) = affinity × exp(-max(0, now - last_active) / (COACT_STABILITY × 86400000))`  
`COACT_STABILITY` 默认 21 天（时间常数 τ），实际半衰期 = 21 × ln2 ≈ **14.6 天**。  
不衰减的共激活会固化成马太效应：常用的记忆对越来越强，最终整个库坍缩成几个话题。

#### 4.11.4 共激活强化的公式

★ **base 的合成规则（只施加一次）**：

```
base = COACT_REINFORCE_STEP（默认 0.20）
     + (机制 B 命中 ? COACT_CAUSAL_BONUS（默认 0.25） : 0)
```

★ 「机制 A/B 同时命中」时**只施加一次** base，**不是两次 base**（那会重复计入 0.20）。  
★ 也**不是「取 max」**——「共享实体/余弦达标」与「调用方声明 A 唤起了 B」是**两个独立事实**，  
取 max 会丢掉一个（尤其会丢掉因果加成，那正是「证据更强」的情形）。

★ **幂等分支（★ 任何模型下都必须存在）**：  
这一对**已在 `coacts` 表中** ⇒ **只 UPDATE**（强化 `affinity` / `coact_count` /  
`last_active` / 按位或上 `cause_flags`），**不 INSERT**。  
⚠️ `coacts` 有 `UNIQUE idx_coacts_pair (memory_a, memory_b)` + `CHECK (memory_a < memory_b)`  
⇒ **一对有且只有一行** ⇒ 任何模型下都必须走这个分支，  
否则**第二次 touch 同一对时 INSERT 撞 UNIQUE**，原始 `SQLITE_CONSTRAINT` 会**穿给调用方**  
（违反 §11.2「客户端只看到规范化的错误结构」）。  
⚠️ 它是 **UPSERT 的另一半**，不是「建立条件」——把两者混在一起正是当初让两边读出相反答案的根源。

```
① 建立边的证据（满足任一即可）：
   共享实体数 ≥ COACT_MIN_ENTITIES（默认 2）
   余弦相似度 ≥ COACT_MIN_COS（默认 0.50）

② **base 的合成规则（★ 只施加一次）**：
```

base = COACT_REINFORCE_STEP（默认 0.20）  
\+ (机制 B 命中 ? COACT_CAUSAL_BONUS（默认 0.25） : 0)

```
★ 「机制 A/B 同时命中」时**只施加一次** base，**不是两次 base**（那会重复计入 0.20）。
★ 也**不是「取 max」**——「共享实体/余弦达标」与「调用方声明 A 唤起了 B」是**两个独立事实**，
  取 max 会丢掉一个（尤其会丢掉因果加成，那正是「证据更强」的情形）。

②③ **幂等分支（★ 任何模型下都必须存在）**：
这一对**已在 `coacts` 表中** ⇒ **只 UPDATE**（强化 `affinity` / `coact_count` /
`last_active` / 按位或上 `cause_flags`），**不 INSERT**。
⚠️ `coacts` 有 `UNIQUE idx_coacts_pair (memory_a, memory_b)` + `CHECK (memory_a < memory_b)`
⇒ **一对有且只有一行** ⇒ 任何模型下都必须走这个分支，
否则**第二次 touch 同一对时 INSERT 撞 UNIQUE**，原始 `SQLITE_CONSTRAINT` 会**穿给调用方**
（违反 §11.2「客户端只看到规范化的错误结构」）。
⚠️ 它是 **UPSERT 的另一半**，不是「建立条件」——把两者混在一起正是当初让两边读出相反答案的根源。

base = COACT_REINFORCE_STEP（默认 0.20）
    + （若该对是「扩散唤起后被采纳」→ 加 COACT_CAUSAL_BONUS，默认 0.25）
Δ    = base × (1 - affinity_old / COACT_AFFINITY_MAX)      ← 饱和阻尼
affinity_new = min(COACT_AFFINITY_MAX, affinity_old + Δ)   ← ★ 钳制位置（见下）
coact_count += 1
last_active = now

⚠️ ★ **v2.1 裁决：同日守卫按「(记忆对, 证据来源)」分别计数**
  （backend + 许可研 两侧独立论证后采纳）：
· 机制 A 的基础增量：同一对 **24h 内至多记一次**
· 机制 B 的因果增量：同一对 **24h 内至多记一次**
· **两者互不豁免** ⇒ 「A 建边 + 当天 B 声明」能同时拿到两条证据
⇒ 理由（从守卫自身的定义来）：守卫针对的是「**同类证据的重复**」——
  同一天内的重复提及不构成「被一起用过」的新证据；
  而机制 B 的因果声明是**不同类的新证据**（谁唤起了谁），**不该被同类守卫挡下**。
⇒ **不改的后果**：机制 A 与 B 同日命中时，机制 B 的因果加成与 `hadActivationEvidence`
  **双双被吞掉** ⇒ 机制 B 在**最常见的场景**下系统性丢失价值
  （同一批记忆通常既共享实体、又被显式声明），
  且 `coacts.origin` 永远不可能出现 `'both'`。
⇒ **同源归一**：若两条声明的 (对) 相同，**归一后取字典序小的那个作为 memory_a**
  （与 §4.11.2 的 a<b 归一规则一致），再按上面的规则分别判定。

③ **已存在分支（幂等）** —— ★ **这一段必须在任何模型下都存在**：
这一对**已在 `coacts` 表中** ⇒ **只 UPDATE**（强化 `affinity` / `coact_count` /
`last_active`），**不 INSERT**。
⚠️ `coacts` 有 `UNIQUE idx_coacts_pair (memory_a, memory_b)` + `CHECK (memory_a < memory_b)`
⇒ **一对有且只有一行** ⇒ 任何模型下都必须走这个分支，
否则**第二次 touch 同一对时 INSERT 撞 UNIQUE**，
原始 `SQLITE_CONSTRAINT` 会**穿给调用方**（违反 §11.2「客户端只看到规范化的错误结构」）。
⚠️ **它是 UPSERT 的另一半，不是「建立条件」**——
「已存在 ⇒ 只 UPDATE」与「什么条件下建立」是两件事，
把前者混进后者正是当初让两边读出相反答案的根源。

④ 有效亲和度（读路径）：
affinity_eff(a, b, now) =
    min(COACT_AFFINITY_MAX,
        affinity × exp(-max(0, now - last_active) / (COACT_STABILITY × 86400000)))
    -- ★ **三处必须逐字相同**（§4.11.3 原则 3 / §4.11.4 ③ / §4.14.3 腿 2）：
    --   ① `max(0, …)` —— 时钟回拨保护，缺了它 Δt<0 ⇒ exp(正数) > 1 ⇒ 亲和度反超上限
    --   ② `min(COACT_AFFINITY_MAX, …)` —— 存储值已钳过，但**衰减后必然 ≤ 存储值**，
    --      钳制在这里是冗余的；**留着是为了三处口径一致**（少一处判断就少一处分叉）
    --   ③ `COACT_STABILITY` 是**时间常数 τ**（不是半衰期；半衰期 = τ·ln2 ≈ 14.6 天）
```

⚠️ **上限钳制必须写死在哪一步**（否则「钳制」只在 §5 与 §3 的注释里，算法节里根本没有）：  
闭式 `1-(1-a)(1-base)` **数学上恒 ≤ 1.0** ⇒ 默认 `COACT_AFFINITY_MAX = 1.0` 时  
**永远碰不到 §3 的 CHECK**（所以默认参数下跑任何回归都发现不了这个洞）；  
但 `COACT_AFFINITY_MAX` **可被调低**（§5 校验只要求 > 0），  
此时闭式可能产出超上限的值（实测：`MAX=0.8`、`a_old=0.7`、`base=0.45` ⇒ 闭式 0.835 > 0.8）。  
⇒ **采纳「两者都钳 + 明写后果」**：  
① **写库前**：`affinity_new = min(MAX, affinity_old + Δ)`（硬上限，绝不写超限值）  
② **闭式解同步钳**：闭式算出后同样取 `min(MAX, ·)`  
③ ⚠️ **被钳后，本次的实际增量不再等于 base**（可能是 0）。  
⇒ **凡是断言「n 次后 affinity 等于某值」的用例，必须先声明 base 恒定**  
**且 MAX 足够大（本次不触发钳制）**。  
⇒ 结构断言 `(1-a_new/MAX)/(1-a_old/MAX) == 1-base/MAX` **在触发钳制时不成立**——  
写断言时必须排除这种情况。  
⚠️ **§3 的 CHECK 写死 `affinity <= 1.0`，运行期改不了** ⇒ 运行期只能靠应用层钳。  
这才是 §5 校验第 7 条「必须同步」的真实含义：**同步要改 DDL，不是运行期能调的**。  
⚠️ **上限调低时，两个上界的含义不同**：`COACT_AFFINITY_MIN`（簇的边判定下界）  
与 `COACT_AFFINITY_MAX`（写入上限）是**独立**的两个值，调低 MAX **不会**改变簇的边判定下界。

⚠️ **`affinity_old` 到底是哪个值？必须写死**（这是最容易实现分叉的一处）：  
**`affinity_old` = 该对上一次增量时写入的**存储&#x503C;**（不是衰减后的有效值）。**  
理由：阻尼要表达「离上限还有多远」，而**存储值单调不减**；  
若拿衰减后的有效值当 `affinity_old`，一条三个月没共现的 pair  
（有效值已衰减到 0.02）会拿到**几乎全额的 base 增量**——  
「很久没联系了 ⇒ 重新联系给满权重」，这与饱和阻尼的设计意图相反。  
⇒ 增量用存储值，衰减只作用于**读路径**。两者分工明确。

⚠️ **闭式解只在 base 恒定时成立**（否则不可用）：  
通解 a_n = 1 - (1 - base)^n **仅当 base = COACT_AFFINITY_MAX 时成立**；  
一般的 `COACT_AFFINITY_MAX = 1.0` 之外的上界下，  
闭式为 `a_n = MAX × (1 - (1 - base/MAX)^n)`。  
⇒ **本库默认 MAX = 1.0**，此时 base = 0.20 的闭式是 `a_n = 1 - 0.8^n`：  
a_1 = 0.200000  a_2 = 0.360000  a_3 = 0.488000  
a_15 = 0.9648164  a_16 = 0.9718531  
⚠️ **「因果证据」那条 base = 0.45 的闭式是 `1 - 0.55^n`，但它只在「每次都是因果」时成立**——  
一次因果 + 若干次普通共现混在一起时**没有闭式**，只能逐次迭代。  
⇒ **结构断言才可靠**：`每次增量后 (1 - a_new/MAX) == (1 - a_old/MAX) × (1 - base/MAX)`，  
误差 ≤ 1e-12。**任何声称「n 次后 affinity 等于某值」的断言都必须先声明 base 恒定。**

#### 4.11.5 侧抑制与共激活的参数边界

侧抑制的完整定义在 §4.13，本节只登记它与共激活共享的参数与边界。

| 参数                   | 默认   | 含义                                                                     |
| -------------------- | ---- | ---------------------------------------------------------------------- |
| `REDUNDANCY_COS`     | 0.90 | 判「事实级冗余」的余弦阈值（语义路径）。**校验：`0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN`**        |
| `COACT_AFFINITY_MIN` | 0.15 | 共激活的**有效**亲和度下限。**一套阈值三处语义**：① 簇的边判定；② `sweep()` 的淘汰判据；③ 「这一对还算不算一条关联」 |

⚠️ **`COACT_MIN_ENTITIES` 与 `DEDUP_ENTITY_MIN` 当前同为 2，但语义不同，不绑死**：  
前者是「要不要把这两条记为共激活」，后者是「要不要把这两条合并成一条记忆」。  
`setParams()` 只校验 `COACT_MIN_ENTITIES >= 1`，**不与 `DEDUP_ENTITY_MIN` 联动**——  
绑死会让两个独立旋钮失去调节余地，而 §11.4 的前提正是「人能独立调旋钮」。

⚠️ **侧抑制的判据不含主题簇**。簇是**话题级**，冗余是**事实级**：  
「张三住上海 / 张三喜欢猫 / 张三在腾讯工作」同簇、三条都是有用记忆，  
按簇抑制会误杀它们——写入侧从未合并过它们。  
⇒ 判据用**逐对谓词**（§4.13.2），簇只出现在 `inhibitionTrace` 的诊断上下文里。


### 4.12 涌现簇（主题簇）

#### 4.12.1 簇是什么，不是什么

**簇 = 共激活图上，`affinity_eff ≥ COACT_AFFINITY_MIN`（默认 0.15）的边构成的连通分量。**  
⚠️ ★ **边的两端都必须是非软删的记忆**（`memories.deleted = 0`）——  
软删记忆**保留**共激活边（§9.3.2 ②，restore 后要能回到原状），  
但**不参与簇的构成**。  
⇒ 两条后果必须写死：  
① 一条边若两端有一端被软删 ⇒ **该边不计入簇**（软删记忆不拉进任何簇）  
② 软删记忆**可以是簇成员吗？** ⇒ **不是**——它不在图里，  
所以「它还属于某个旧簇」这件事只存在于**已发布快照**中（§4.12.2）。  
⇒ 「移除 vs 不移除」的裁决落地的唯一方式就是**这一句 + 快照口径**：  
`size` = **当前活跃成员数**（实时 COUNT，`WHERE deleted = 0`），  
`splitInfo.originSize` = 切分前的规模（含已软删的；**与 `originComponentId` 同词根**）。  
⚠️ **不写这一句，「移除 vs 不移除」就永远落不了地**：实现者无法判断  
「软删记忆算不算簇成员」，两种实现会给出不同的簇。

- **不是**人工标签：调用方**不能**给记忆打簇标签。簇是算出来的。
- **不是**向量分桶：向量分桶（§3 `vector_fine_cells`）按几何划分，是检索加速用的；  
  主题簇按共激活涌现，是语义导航用的。两者不可互相替代（§3 的注释已详述）。
- **不是** `edges` 的连通性：edges 是语义断言，coacts 是统计共现。  
  用 edges 算簇，得到的是「概念图」，不是「记忆实际怎么被一起想起」。

#### 4.12.2 为什么簇要物化，尽管它是算出来的

100 万条、1500 万条共激活边上做一次 union-find 连通分量是**秒级**操作，  
放进召回热路径不可行。因此：

- **定义永远是纯函数**（上文的连通分量定义）；
- **存的是缓存**：`theme_clusters` + `theme_cluster_members` 两张表，  
  带 `cluster_version` 与 `computed_at`，由调用方调 `recluster()` 增量更新（**库内无定时器**，ADR-5）；
- **不变量**：删掉这两张表重建一次，结果必须**完全一致**。  
  这条不变量是「簇是涌现的、不是存的」的机器可验证形式。

#### 4.12.3 簇的变更比合并更难

共激活边会随时间衰减，一条边衰减到阈值以下会让连通分量**分裂**——  
而分裂比合并难处理：合并只需改一簇的成员表，分裂需要把一个成员表拆成两个，  
且要决定新簇的 id 与版本号。

**本版的处理**（明确选择，不是待办）：

- 簇重算是**由调用方调度的同步操作**（`recluster()`），按 `cluster_version` 递增发布新快照；  
  ⚠️ **库内无定时器**（ADR-5）——`CLUSTER_RECALC_INTERVAL_MS` 是**建议宿主调度的周期**，  
  库自己不按周期跑（§4.15.5 与 §5 的口径一致）。
- 召回读**上一个已发布快照**（`computed_at` 可查，调用方能知道它有多旧）；
- **分裂时新簇沿用原簇 id 的一半 + 新后缀**，避免 id 复用；
- 快照之间**不保证连续**：一个记忆在相邻两个快照里可能属于不同簇。  
  这不是 bug，是「簇本身随共激活衰减而变化」的必然结果。

#### 4.12.4 超大簇的三层防护

实测规律（20,000 条语料 / 200 主题 / 768 维）：巨型簇的规模 ≈ **样板（近重复内容）的总体规模**。  
样板占 5% → 20,000 条库下巨型簇 1,000；100 万条库下巨型簇 50,000。  
⇒ 巨型簇不是异常，是**事实**：用户确实在发大量近重复内容，  
这本身就是一个值得被识别出来的簇（「你发的 5 万条『好的』」）。

**① 主防线 —— 枚举上限**  
任何「列出簇成员」的操作一律带 LIMIT，按有效 affinity 降序取  
`CLUSTER_MEMBER_SAMPLE_MAX`（默认 50）。  
⇒ 巨型簇也只贡献 50 条 → **唯一的输出风险被封死**。  
★ 前提：**侧抑制从不做传递闭包**，判定是逐对比较（候选 vs 已保留集 R），  
与簇的大小、与图的连通性都无关 ⇒ 巨型簇**不会**让抑制退化成「整个库只留 1 条」。

**② 可观测 —— 巨型簇是事实，不隐藏**

- `clusters()`：原样报出每个簇的 size（**不截断、不隐藏**）+ `largestClusterRatio`
  - `computedAt` + `algoVersion`。
- `sweep()` / `recluster()` 的汇总事件：带 `clusterCount` 与 `largestClusterRatio`（最新值）。
- `stats()`：**不新增该字段**——`stats()` 不得扫 `coacts`（§11.4 的观测纪律）；  
  且它的 16 个字段是「当前状态快照」，混入一个带 `computedAt` 的派生快照会让字段语义不一致。

**③ 兜底切分 —— 只在真正退化时才动**  
触发条件：**本次重算中 union-find 跑完、切分之前的最大原始连通分量占比 > `MAX_CLUSTER_SHARE`**（默认 **0.5**）。  
⚠️ ★ **这是行为变更**（v2.1 裁决，架构 D6）：此前触发条件读的是**切分后**的  
`largestClusterRatio` ⇒ 切完就永远 ≤ 0.02 ⇒ **兜底切分每个库最多发生一次**  
⇒ 漂移后再退化**也不会被触发** ⇒ 「兜底切分」在长期漂移的库里**实质失效**。  
⇒ **改为读原始分量占比** ⇒ 它在切分前后指向**同一个事实**（图本来有多重复）  
⇒ 切完再重算，触发条件仍成立。  
⇒ **但切分是幂等的**（同样的图 + 同样的确定性分块算法 ⇒ 同样的块）⇒ **不会 5→25→125 发散**。  
⚠️ ★ **切分必须每轮从原始连通分量重新推导**（coacts → 原始分量 → 切分 → 发布），  
**绝不对已切过的块再切**。  
⚠️ **触发量必须内部化、且与对外字段不同名** ——  
若触发条件直接写「用 `maxRawComponentRatio` 判定」⇒ 触发量引用了被测对象的字段名  
⇒ **结构性耦合**（那正是刚修掉的那类）。  
⇒ **字段分工**：  
· 内部触发量     = 原始分量占比（本次重算的**中间量**）  
· 对外 `largestClusterRatio`  = 切后最大块占比（「现在有没有大簇」）  
· 对外 `maxRawComponentRatio` = 原始分量占比（「内容有多重复」）  
★ 理由：簇的存在意义是**区分**。一个簇占了全库 60% 时，  
「簇成员身份」几乎不再携带信息（几乎所有东西都在里面）⇒ 它确实退化了；  
40% 时仍有区分力（60% 在外面）⇒ 不退化。  
★ 切分的正当理由是「这个簇已经不是导航单元，而是数据质量问题」，  
而不是「它太大了不好看」——后者会切碎「用户在发大量重复内容」这个本身有价值的簇。  
目标尺寸：每块 ≤ `max(2, floor(CLUSTER_MAX_FRACTION × totalMemories))`，  
`CLUSTER_MAX_FRACTION` 默认 0.02（**随库规模自适应**）。  
算法：**均衡分块**（见下）。

**均衡分块算法（确定性、幂等、终止）**

```
  对超限的连通分量（size > 目标上限）：
    1. 成员按【节点强度降序，同分按 memory id 字典序升序】排序
       —— 节点强度 = 与其相连的有效边权之和
       —— 完全确定性：不依赖随机、不依赖几何、不依赖遍历顺序
    2. k = ceil(size / 目标上限)
    3. 按排序后的顺序切成 k 块，每块 ⌈size/k⌉ 条（最后一块可能略小）
    4. 每块成为一个簇
  ★ 每块 ≤ 目标上限；块数恰好 = k；完全确定性（同图必同结果，幂等）；
    复杂度 O(n log n)；不会产生海量单元素簇
  ★ 语义一致性：块内成员来自同一个连通分量 ⇒ 至少弱相关；
    而巨型簇的成因是「近重复内容」，其成员在语义上本就高度相似
    ⇒ 均衡切分不会切出语义离谱的块
  ★ 为什么不用「按向量分桶切」：每个细桶约 100 条 ⇒ 60 万成员的簇会切出 6000 块
    （而非 30 块），粒度太细，反而制造更多簇
```

⚠️ **两个已被否决的切分算法（写在这里防止被重新引入）**：  
① **「逐条删除最弱边直到 size ≤ 上限」——不收敛。**  
近重复形成的是**团（clique）**&#x4E0D;是链，团里删掉一条边仍然连通

```
 （|V| ≥ 3 时 clique 少一条边依然连通）⇒ size 完全不变 ⇒ 循环不推进；
 拆 5 万节点的团需要 O(n²) 条边。
 同理「只保留簇内最强的 (size−1) 条边」也不成立——
 剩下那个节点仍通过其余边连着整个团，分量大小根本没变。
```

② **「全图取节点强度最低者，剥离其全部关联边」——会空转。**  
已孤立的节点强度 = 0，永远是最小值 → 每轮都选中它 → 每轮都是无操作。  
★ **通用教训：任何「逐个删除元素直到集合变小」的循环，  
都必须先证明「被删的元素不会再被选中」。**  
① 的失败是「元素还在集合里，但删了不改变连通性」；  
② 的失败是「元素已被移出集合，但仍在参与最小值选取」。

★ **三个簇参数，三个不同职责，不要混**：  
`CLUSTER_MEMBER_SAMPLE_MAX` = 50 → 「切之前怎么不炸」（输出上限）  
`MAX_CLUSTER_SHARE` = 0.5 → 「什么时候切」（退化判定）  
`CLUSTER_MAX_FRACTION` = 0.02 → 「切到多大」（目标尺寸）  
⇒ 只有一个数被误用就会出问题：把 0.02 当触发条件 ⇒ 每次重算都切；  
把 0.5 当目标尺寸 ⇒ 切完还是超标；把 50 当簇大小 ⇒ 簇永远建不起来。

#### 4.12.5 簇覆盖率与未分配记忆

不是所有记忆都有簇——**从未被 touch 过的记忆没有任何共激活边，是孤岛**。  
孤岛记忆**仍然可以被召回**（走正常的五因子打分），只是：

- 不被簇跳扩散捞起（§4.14）；
- 侧抑制**与它无关**——侧抑制的判据是纯逐对的（余弦 OR 实体交集），**不使用簇**（§4.13.2），  
  所以「有没有簇」不影响它是否受抑制。

这是正确的，不是缺陷：簇反映的是「被一起用过」，从没被用过的记忆本来就没有簇。  
`clusters().coverage` 报告「有簇的记忆占比」，  
**三个覆盖率口径必须各自标清**（否则 QA 会按错的分母写断言）：

| 指标                                                             | 分子 / 分母                               | 回答什么                                                    |
| -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `coverage`                                                     | coveredMemories / totalMemories       | 簇覆盖了**全库**多少（受库大小影响）                                    |
| `coverageOverAdopted`                                          | |covered ∩ adopted| / adoptedMemories | **被采纳过的**记忆里有多少进了簇（受采纳质量影响）                             |
| 旧表述「covered ÷ 被 touch 过的记忆」                                    | coveredMemories / touchedMemories     | **第三个分母**——它既不是上面两个，**且分子可能大于分母**（机制 B 的种子侧可从未被采纳）⇒ 不可用 |
| ⚠️ **覆盖率不从 `stats()` 出**——`stats()` 不得扫 `coacts`（§11.4 的观测纪律）， |                                       |                                                         |
| 它的 16 个字段是「当前状态快照」；簇是有 `computedAt` 的**派生快照**，                 |                                       |                                                         |
| 两者语义不同，混在一起会让调用方误以为簇是实时状态。                                     |                                       |                                                         |


### 4.13 侧抑制（lateral inhibition）

> **前提**：本节的所有机制在 §4.6 步骤 4.5 执行，**只影响本次返回的 hits**。  
> 它不写库、不改 score、不进 §4.6 的五因子加权公式。  
> 这不是实现上的偷懒，而是三条原则的必然结果（§4.11.3）：  
> ① 「层级是算出来的，不是存出来的」——抑制若落库就成了「存出来的层级」；  
> ② 五项权重恒和为 1.0 是 §4.6 的铁律，抑制作为第六项会破坏它；  
> ③ 抑制是**候选集内部的相对关系**，而 score 是「这条记忆有多相关」的度量——  
> 同一条记忆在「拥挤的查询」与「独占的查询」里必须拿到**同一个** score，  
> 否则 score 无法跨查询比较，`explain` 也无法解释。

#### 4.13.1 三条硬约束

**① 抑制不进 score。**  
`Hit.score` **恒等于五项加权和**（§4.6 的可测恒等式，误差 ≤ 1e-9）。  
**`Hit.score` 与 `rankScore` 是同一个数；抑制不引入第二个分。**  
「谁挤掉了谁、冗余度多少」属 `inhibitionTrace` 的诊断输出，**不进入 `Hit.breakdown`**——  
把它塞进 score 会让 score 跨候选不可比，而 §4.6 的 `normBm25` 三分支设计整套就是为了保这个可比性。

**② 抑制不写库。**  
本节全程只读。抑制前后 `memories` 表哈希必须完全相同。  
写库等于给「相似」判了死刑，而「层级是算出来的，不是存出来的」（§2 原则①）是本库第一原则。

**③ 抑制只作用于 hits，不作用于 diffused。**  
`diffused` 是 §4.7 / §4.14 的联想输出，它不参与 topN 名额的竞争。  
把抑制套到 diffused 上，会让「想不起名字但看到照片就想起来」这条通道（§4.7 R-ARCH-DIFF）失效。

#### 4.13.2 判据：纯逐对，不用分组

```
isRedundant(A, B) =
    (双方都有 embedding 且 cos(A,B) ≥ REDUNDANCY_COS)   ← 语义路径
    OR (|E(A) ∩ E(B)| ≥ DEDUP_ENTITY_MIN)               ← 实体路径，**始终可用**
```

**为什么用「实体交集」而不是「簇成员关系」**：

1. **它是事实级的**：共享 ≥ 2 个实体的两条记忆大概率讲同一件事  
   （「她在用 PG15」/「她用 PG15 跑生产」共享 她 + PG15）；  
   而「同簇」只保证「相关」（簇由 cos ≥ 0.5 或共享 ≥ 2 实体建立）——  
   **簇是主题簇，用它判事实冗余会误杀「张三住上海 / 张三喜欢猫」**。
2. **复用 §4.9 步骤 3c 的同一谓词** ⇒ 零新增语义、零新增参数：  
   **写入侧认为「同一事实」的，召回侧也认为「冗余」，两个口径不会打架。**
3. **零额外 IO**：§4.6 步骤 3 已为 `graphProximity` 做过一次 `memory_entities` 批量查询，复用即可。
4. **实体路径不依赖 embedding** ⇒ `embeddedRatio = 0` 时侧抑制**仍然工作**。  
   若把判据绑到向量覆盖率上，会出现「没有向量时整个侧抑制机制消失」，  
   第五概念在最需要它的场景里整个不工作；而共激活的建立门槛  
   （`COACT_MIN_COS` / `COACT_MIN_ENTITIES`）本来就与向量覆盖率有关，再绑一次是重复惩罚。

⚠️ **两种「同质」的区别（本节最容易搞混的一处）**：

- **poolHomogeneous（池级）**：候选集**整体**互为冗余 ⇒ 没有替代品 ⇒ 不抑制。
- **R 内两两不冗余（组级）**：贪心遍历保证 R 内部无冗余对。  
  两者**不是同一件事**：poolHomogeneous 为真时 R 内部同样两两不冗余（因为都等于 C0 的冗余），  
  但那不是「组内冗余被压掉」，而是「没有替代品」——所以**不抑制**。

**为什么是逐对而不是连通分量（量化依据）**：

> 抑制判定采用**逐对**口径，不采用连通分量口径。  
> **实测**：10 万组随机图（三族：链 / 星 / 团），两种口径的分歧率 **5.11%**，  
> **全部集中在链状图上、且 100% 落在危险方向**——  
> 并查集口径认为「整池同质、不该抑制」，而实际池中存在异质替代 ⇒ **近义项被留在 topN**。  
> **根因：连通性 ≠ 同质性。** `A~B, B~C, A≁C` 是一条**链**不是一个**团**；  
> 用传递闭包判同质性，会把「链」当「团」。  
> ⚠️ **诚实的限定**：5.11% 是三族随机图上的数字，真实共激活图里链状结构的占比未知，  
> 实际分歧率可能更高也可能更低。但**方向是确定的**：所有分歧都错在「该抑制的没抑制」这一侧，  
> 不会错在「不该抑制的抑制了」——后者会误杀有用内容，危害更大。

**⇒ 推论：抑制从不做传递闭包 ⇒ 巨型簇只影响 `clusters()` 的导航质量，不影响抑制行为。**  
⇒ 「巨型簇会让抑制退化成整个库只留 1 条」这一顾虑**在结构上不成立**。

⚠️ **本版刻意不做词面（bigram Jaccard）冗余判定。** 理由不是「省一次计算」，而是  
**词面相似与语义相似在中文上不可用一个阈值分开**：

- 「她**不**喜欢猫粮」与「她喜欢猫粮」：bigram 高度重合，但语义**相反**；
- 「她喜欢猫粮」与「她钟爱猫粮」：bigram 重合度一般，但语义**几乎相同**。  
  这两类在词面距离上的分布区间**互相嵌套**——  
  实测「否定翻转」落在 [0.200, 0.400]、「同义改写」落在 [0.143, 0.444]，  
  **不存在任何阈值 T 能同时抓住前者且放过后者**：  
  T ≤ 0.143 必然误杀全部否定翻转（把相反的事实当重复抑制掉，违反 §14.1「记忆失真」禁令）；  
  T > 0.400 则同义改写一个都抓不到。  
  唯一安全的词面判据是「正文完全相同」，而那已被 `idx_mem_hash` 唯一索引排除。  
  ⇒ 词面相似**只用于写入去重**（§4.9），**不用于召回侧抑制**。

#### 4.13.3 算法：三桶模型（R / D / overflow）

```
输入：候选池 C（步骤 3 打分后、**未截断**的全部候选），每条带 score
      topN（默认 5）
输出：hits、suppressed

桶定义（★ 三个桶必须分开，这是实现最容易错的一处）：
  R = 异质代表集（进 hits）
  D = 冗余池（确实冗余 → 进 suppressed，有合法的 redundantWith）
  O = 溢出桶（因 R 已满而【未参与评估】→ 没有合法的 redundantWith）

前置判定（★ **池级**，与遍历顺序无关）：
  poolHomogeneous = 「候选集里除最高分那条 C0 外，是否**每一条**都与 C0 冗余」
  实现：**进入遍历前算一次并固定**。
    取候选集 score 最高的那条 **C0**，逐条检查**其余候选**是否与 C0 冗余。
  ⚠️ **C0 不与自己比**：判断对象是「候选 c 与 C0 是否冗余」，
    **不是「C0 与 C0」**（那恒为真，会把 poolHomogeneous 永远判成真）。
  ⚠️ 候选池为空（|C| = 0）时 poolHomogeneous 恒为**真**（无候选可判），
    但此时遍历不执行 ⇒ hits = [] ⇒ 不变式 `hits.length ≥ min(topN, min(2, |C|))`
    仍然成立（|C| = 0 ⇒ 下界为 0）。
  ⚠️ **必须在遍历前算完**，不能随 R 的增长而重算——
     若随 R 重算，行为就依赖遍历顺序，「整池同质」这个判定会漂移。

遍历（按 (score DESC, id ASC) 全序）：
  for c of C:
    if R.length >= topN:  O.push(c); continue      ← 停止评估，不再判冗余
    if poolHomogeneous:    R.push(c); continue      ← 整池同质：全部让位（无替代品）
    if ∃ r ∈ R 使 isRedundant(c, r):  D.push(c)      ← 冗余：让位给已保留的
    else:                            R.push(c)      ← 异质：进 R

输出：
  R 按 score 降序取前 topN → hits
  D → suppressed（默认随结果返回）
  O → 两者都不进

**为什么三个桶必须分开**：把 O 混进 D，会让「**根本没参与评估**的候选」被误标成「被挤掉的」——  
它们没有合法的 `redundantWith`（没跟谁比过），标注是假的。

**不变式**：

|   |   |   |
| - | - | - |

- `hits.length ≥ min(2, |C|)` —— 抑制**永远不会**把结果压到 1 条以下；
- `hits.length ≤ min(topN, |C|)`；  
  |  |  |  |  |  |  
  | --- | --- | --- | --- | --- |
- `|R| ≥ 2` 时**不保证** `hits.length == min(topN, |C|)`（「宁少不冗余」是刻意的）。

#### 4.13.4 参数与硬约束

| 参数               | 默认   | 含义          | 调大的后果        | 调小的后果                    |
| ---------------- | ---- | ----------- | ------------ | ------------------------ |
| `REDUNDANCY_COS` | 0.90 | 语义路径的冗余余弦阈值 | 判为冗余的更少，抑制变弱 | 判为冗余的更多，抑制变强，可能误杀「重要但相似」 |

> ⚠️ **硬约束：`0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN`（0.90 ≤ 0.92）**。  
> 这两个阈值管的是**不同的事**：
>
> - `DEDUP_COS_MIN` = 0.92：「**就是同一个事实**」→ 写入时该**合并**成一条；
> - `REDUNDANCY_COS` = 0.90：「**讲的是同一件事**」→ 召回时该**让位**。  
>   若 `REDUNDANCY_COS` > `DEDUP_COS_MIN`，会出现「召回时判为该让位、写入时判为同一事实」的矛盾——  
>   同一对记忆在两个环节得到相反的结论，且**两边都不会报错**。  
>   `setParams()` 必须在写入前校验这条并抛 `INVALID_INPUT`（§5 的跨参数校验规则），  
>   **且一个参数都不落库**。
>
> ⚠️ **方向是 `≤` 不是 `<`**：若要求严格小于，参数空间会塌缩到 (0.90, 0.92)——  
> 不到 0.02 的宽区间，任何一次调参都可能落进非法区直接抛错。  
> 默认值 0.90 不下调，依据是 §4.9 的实测：「同主题不同断言」的余弦落在 0.75~0.88，  
> 若把判冗余阈值压到 0.75 以下，**连「喜欢 vs 不喜欢」这类真冲突都会被放行**（它余弦更高）。
>
> ⚠️ **`COACT_MIN_COS` 与 `REDUNDANCY_COS` 不做联动校验**：  
> 前者是「要不要建立关联」，后者是「要不要让位」——两个独立旋钮，  
> 绑死会让「想把共激活收紧」被迫同时「削弱抑制」。

#### 4.13.5 边界与失败模式

- **抑制只作用于 `hits`，不作用于 `diffused`**（硬约束③）。
- **抑制不写库**：本节任何一条规则都不产生 `UPDATE`。
- **抑制不修改 `score`**：`Hit.score` 仍是 §4.6 步骤 3 的五因子加权和。
- **`suppressed` 默认随结果返回**：调用方需要知道「有 N 条被挤掉了」，  
  否则它无法区分「库里只有 3 条相关」与「有 5 条但 2 条被挤掉」。  
  这两个是不同的产品事实，混起来会让调用方做出错误决策。

| 失败模式           | 症状                            | 处理                                                       |
| -------------- | ----------------------------- | -------------------------------------------------------- |
| 主题级冗余被误杀       | 「张三住上海 / 张三喜欢猫」同簇 → 被挤掉       | **已修**：判据为纯逐对，簇不参与判定                                     |
| 抑制导致 topN 不足   | 候选被挤掉后 hits 变短                | 由 `hits.length ≥ min(2, \|C\|)` 保证；被挤掉的进 `suppressed` 可见 |
| 溢出候选被误标为被抑制    | 没参与评估的候选带上了假的 `redundantWith` | **已修**：三桶分离                                              |
| 整池同质时结果被压到 1 条 | 所有候选都互相冗余                     | **已修**：`R.length == 1` 例外                                |
| 同分导致的非确定性      | 两次召回同一查询返回不同的两条               | **已修**：全序 `(score DESC, id ASC)`                         |
| 抑制被当成「相似即死刑」   | 有人把抑制结果落库                     | 硬约束①②已禁止；`stats()` 暴露抑制计数供观测，但**不产生任何持久状态**              |
| 有界减项被重新引入      | 有人想「调温和一点，别误杀」                | 见 §4.13.6 的数值论证                                          |

#### 4.13.6 为什么不能做成「有界减项」

曾经的备选方案：给每条冗余候选扣一个**有界**的 penalty（如 0.15），再按新分数排序。  
**它在数学上无法达成目标**：

```

pool = [a(.90, 与 b 冗余), b(.88), c(.20), d(.10)]，topN = 2  
penalty = 0.15 → b = .73 → top2 = [a, b]   近义 2 条  ✗  
penalty = 0.40 → b = .48 → top2 = [a, b]   ✗  
penalty = 0.68 → b = .20 → 与 c 并列 → 需 penalty 略大于 .68 才生效  
⇒ 所需 penalty = 0.88 − 0.20 = 0.68，而 s_next(c) 可以任意小 ⇒ **所需 penalty 无界**

```

⇒ 有界减项在数学上无法保证「同质内容不占多个名额」；而无界 penalty ≡ 硬筛选，只是多绕一圈——  
多一个**没有出处的数字**（0.15）、多一处 score 语义分裂、还要写进 `breakdown` 参与求和。  
**直接用硬筛选，少一个数。**

⇒ 纯筛选在同一 pool 下：**poolHomogeneous 为假**（c 与 a 不冗余）⇒
  逐对判定：`R = {a, c}`、`D = {b}` ⇒ hits = [a, c] ✓（近义 1 条）

### 4.14 联想路（clue 扩召）

联想路把「被直接检索到」的记忆作为**种子**，捞出与之相关但未被检索到的记忆。  
它有两条腿，**共享同一份预算**。

> ⚠️ **联想路不产生 hits 候选**。它只产出 `diffused`（§4.6 步骤 4.5 之后）。  
> 联想结果**不参与 hits 排序**、**不占 topN 名额**——这与 v1.0 一致（v1.0 的 diffused 也是独立字段）。  
> ⚠️ **联想路与主召回答复的是两个不同问题**：主召回答「最相关的是什么」，  
> 联想路答「顺着这个线索还能想起什么」。两者混在一起会让 topN 被联想结果占满。

#### 4.14.1 两条腿

| 腿       | 走什么                                | 语义                  | v2.0         |
| ------- | ---------------------------------- | ------------------- | ------------ |
| **实体跳** | `edges`（实体↔实体）1 跳                  | 「看到照片想起名字」          | v1.0 原有，原样保留 |
| **簇跳**  | `coacts` + `theme_cluster_members` | 「想起一件事，顺带想起同话题的另一个」 | v2.0 新增      |

> ⚠️ **两条腿共享 `MAX_DIFFUSED_VISITS` 预算，不是各给一份。**  
> 分开给预算等于把总上限翻倍，「有界扩散」的承诺就作废了——  
> 而扩散无界的真正代价不是慢，是**联想跑题**。

#### 4.14.2 种子从哪来

```

种子 = §4.6 步骤 4.5 选出的 hits（topN 条）。  
⚠️ **种子不额外筛选**：种子就是 hits 本身。  
若「种子也要有簇」或「种子要够强」，就会把联想的第一跳锁死在某个话题里，  
而联想路的全部意义恰恰是「从一个话题跳到相邻话题」。  
唯一的约束是种子数 ≤ MAX_DIFFUSED_NODES（默认 20）。

```

#### 4.14.3 簇跳的算法

⚠️ **驱动顺序是硬约束：必须从 `coacts` 驱动，禁止从 `theme_cluster_members` 驱动。**

理由：巨型簇在 100 万条库下可达 **50,000 个成员**（§4.12.4 ② 的实测）。
从簇成员表驱动 ⇒ 单条种子扫 5 万行；`topN=5` 条种子 ⇒ **25 万次索引探测**，
且这是**每次 recall 都跑**的热路径 ⇒ 粗估 200~500ms，**直接冲掉 P99 ≤ 200ms 门槛**。
⚠️ **加 `LIMIT` 救不了** —— LIMIT 作用在 JOIN 之后，外层表照扫不误。

⇒ 正确形态（成本 **O(度数)** 而非 O(簇大小)，三个数量级的差）：

```

① 种子所属的全部簇（idx_tcm_memory，通常 ≤ 几行）  
SELECT cluster_id FROM theme_cluster_members WHERE memory_id = @seedId

② 种子的全部共激活邻居（**两个方向**）  
SELECT memory_b AS nid, affinity, last_active  
FROM coacts WHERE memory_a = @seedId  
UNION ALL  
SELECT memory_a AS nid, affinity, last_active  
FROM coacts WHERE memory_b = @seedId

③ 应用层：与 ① 的簇集合求交 → 算 affinity_eff → 降序 → 取 CLUSTER_TOPK

```

**七条约束（成段写死，拆开就会写错）**：

| # | 约束 | 说明 |
| --- | --- | --- |
| 1 | **多簇** | `cluster_id IN (种子所属的全部簇)`。§3 明写一条记忆可能同时属于两个簇（衰减后边会分裂）；单数写法会漏掉第二个簇的全部邻居 |
| 2 | **软删过滤** | 交出的候选必须 `JOIN memories m ON m.id = ... AND m.deleted = 0` |
| 3 | **双向 JOIN** | 两支 `UNION ALL`。⚠️ **互斥性完全依赖 `CHECK (memory_a < memory_b)`**（支1 要求 seed<nbr，支2 要求 nbr<seed ⇒ 互斥且完备）。**若将来放宽该 CHECK，必须从 `UNION ALL` 改回 `UNION`**，否则同一对被计两次 |
| 4 | **种子无簇 ⇒ 跳过簇跳** | 孤岛记忆（§4.12.5）没有簇，跳过即可——不是报错、不是特殊分支 |
| 5 | **affinity_eff 钳制** | `Δt = max(0, now - last_active)`；`affinity_eff = min(COACT_AFFINITY_MAX, affinity × exp(-Δt/(COACT_STABILITY×86400000)))`。*两腿量级**刻意不同**（实体跳 ≤ `ACTIVATION_DECAY`(0.2)；簇跳 ≤ `CLUSTER_BONUS` × affinity_eff(≤0.4)）⇒ 合并取 max 时**簇跳在 `affinity_eff > 0.5` 时占优** ⇒ 这不是 bug，它让**强同簇关系优先于弱边关系**。
| 6 | **截断位置** | 是「**每条种子各取 `CLUSTER_TOPK`(3)**」⇒ 总量 = topN(5) × 3 = **15 条**，再由 `MAX_DIFFUSED_NODES`(20) 统一截断。**必须写死**，否则 Token 成本上界差 5 倍 |
| 7 | **归档过滤时序** | `diffuseArchived: false` 的过滤**发生在两腿合并之后统一做**。若在合并前做，两腿的 `layer` 标记会不一致 |

⚠️ **索引按需**：`idx_coacts_a(memory_a, affinity DESC)` 在改为从 `coacts` 驱动后
**变为可选**（要排序的行数只有度数级，应用层排即可，不必付第三个索引的写放大）。
⇒ **不强制建**，但 §5 的 `COACT_DEGREE_MAX` 上限必须保留（它是度数爆炸的唯一闸门）。

#### 4.14.4 两腿结果的合并

> ⚠️ **合并时取 `max`，不累加。**  
> 同一条记忆可能两条腿都命中（「既同簇又同实体」）。累加会让它的分数凭空翻倍，  
> 而它并不比别的记忆更相关两倍——那只是它被**发现了两条路径**。  
> 取 `max` 的语义是「它最相关的那条路径有多强」，这才是我们要表达的东西。

```

合并去重：  
按 memory_id 建 Map，两腿写入时取 max(实体跳分, 簇跳分)  
⚠️ 与 §4.6 步骤 2.5 的候选去重是**两处不同的去重**：  
步骤 2.5 去的是「同一条记忆被多路召回」（保留各路原始分，不合并），  
§4.14 去的是「同一条记忆被两条腿扩散命中」（合并扩散分，取 max）。  
两处都只按 id 去重，但**合分规则相反**（前者保留各自，后者取 max）——  
写反了会导致扩散结果随实现顺序变化。

````

#### 4.14.5 归档口径

- 簇跳与实体跳**共用同一套归档口径**：默认 `diffuseArchived: true` 时，两腿都允许捞出归档记忆，  
  输出带 `layer: 'archived'` 标记（§4.7 规则 R-ARCH-DIFF）。
- `diffuseArchived: false` 时，**两腿都过滤**归档，口径一致。
- ⚠️ 簇跳是**新增的归档例外通道**（v1.0 只有实体跳一条）。  
  这一点必须写明，否则查看器会把簇跳捞出的归档记忆当成漏过滤的 bug。
- 簇跳**不消耗 `MAX_DIFFUSED_VISITS` 的边预算**（它不遍历 `edges`，直接查成员表），  
  但**受 `MAX_DIFFUSED_NODES` 约束**——返回总量上限不变。

### 4.15 向量后端与分桶路由

#### 4.15.1 为什么把向量检索抽成后端

v1.0 把向量检索写死在 §4.6 步骤 2c（flat 全表扫描）。100 万条下这条路不可用  
（100 万 × 768 维点积 ≈ 500~1500ms，越过 §12 的 P99 ≤200ms 门槛）。  
但向量检索是**唯一必须做近似**的一路——文本路有 FTS5 索引、图谱路有 B-tree 索引，两者都是精确的。

把向量路抽成**可插拔后端**的三条理由：

1. **替换点收敛在一处**：换索引实现不触碰打分公式与准入闸门  
   （ADR-6 原文写的可替换性承诺，v2.0 正好行使它）。
2. **可测试**：后端可替换意味着能用「假后端」做确定性测试。
3. **将来可分级**：若将来要为小库提供「零近似」的精确后端（小库 flat 扫描本就很便宜），
   接口已就位，无需改流水线。**本版不实现**——分桶在小库上的行为与 flat 完全一致
   （探针覆盖充分时），没有必要为小库单开一条路径。

⚠️ **可插拔 ≠ 本版要实现多个。** 本版**只有一个实现**（主库内的两级分桶）。  
保留接口是为了将来换实现时不必重写流水线，**不是**为了现在就跑两套。

#### 4.15.2 后端接口契约

```ts
/**
 * 向量检索后端。**只负责「取候选 + 排序」**，不参与任何打分决策。
 *
 * ⚠️ 契约边界：实现**不得**返回归一化相似度之外的任何东西；
 *   不得决定哪些候选有资格（那是 §4.6 准入闸门的职责）；
 *   不得读写除向量索引与分桶元数据之外的数据。
 *   越界的实现会让「向量只参与排序不参与准入」这条铁律失效。
 */
/** 后端配置。维度必须与 `EMBED_DIM` 一致；`EMBED_DIM` 本身**只读**（§6）。 */
interface VectorBackendConfig {
  dimensions: number;          // = EMBED_DIM
  coarseCenters: number;       // 粗桶中心数（§4.15.3）
  fineCenters: number;         // 细桶中心数
  storagePath?: string;        // 派生索引的落盘位置（纯 TS + SQLite 实现可为空）
}

/** 检索过滤条件。★ **不接受 id 白名单**（§4.6 步骤 0 的硬边界）：
 *  一旦允许传 id 集合，将来一定会有人把它接到文本路上——
 *  那正是「几何邻近否决词法精确」那件事。 */
interface VectorFilter {
  timeFloor?: number;          // last_access 下界（毫秒）
  pinnedTimeFloor?: number;    // pinned 记忆的 last_access 下界
  excludeIds?: string[];       // ★ **只用于「排除本次已入 topN 的记忆」**（§4.7 的扩散语义），
                                //   **不是**「只在这批 id 里找」—— 方向相反，语义不可混用
}

/** 一条近邻命中。 */
interface VectorHit {
  id: string;
  score: number;               // 余弦（已 L2 归一化 ⇒ 点积）；**不由后端做归一化或重标定**
}

interface VectorBackend {
  init(config: VectorBackendConfig): void;      // 必须幂等

  /**
   * **只路由、不取候选**：算新向量落在哪些桶里。
   * @returns 命中的细桶 id 列表（有序，按中心距离升序）
   * ★ 这与 `search()` **必须是两个方法**——「路由」与「取候选」是两件事，
   *   合成一个方法会导致调用方无法在「路由结果」与「最终候选」之间插入自己的处理
   *   （§4.6 步骤 2c 的时间窗过滤与强度精筛就无处安放）。
   */
  route(query: Float32Array, nprobeCoarse: number, nprobeFine: number): string[];

  /**
   * 检索近邻。
   * @param query  已 L2 归一化的查询向量
   * @param k      返回条数
   * @param filter 候选过滤（时间窗下界、层等——**不是** id 白名单）
   * @returns      按相似度降序的候选（id + 余弦）。
   *               **不足 k 条时返回实际条数，不补齐**——
   *               补齐会引入不存在的相似度值，污染归一化。
   */
  search(query: Float32Array, k: number, filter?: VectorFilter): VectorHit[];

  upsert(id: string, vector: Float32Array): void;   // upsert 语义：同 id 覆盖
  remove(id: string): void;                          // 硬删时调用；软删**不删**
  rebuild(): void;                                   // 全量重建
  stats(): { count: number; dimensions: number; backend: string; indexBytes: number };
}
````

⚠️ **`filter` 不接受 id 白名单**。这是 §4.6 步骤 0 的一条硬边界：  
路由只作用于向量路，文本路与图谱路**不接受任何 id 白名单过滤**（理由见步骤 0 的三条硬理由）。  
若后端接口允许传 id 集合，将来一定会有人把它接到文本路上——那正是 §4.6 步骤 0 要防的事。

#### 4.15.3 本版实现：主库内的两级 k-means 分桶（IVF）

```
两张表都在主库 ocean.db 内（**完整 DDL 见 §3，本节不重复以免两处漂移**）：
  vector_coarse_cells(coarse_id, centroid, updated_at)          -- 粗桶中心
  vector_fine_cells(fine_id, coarse_id, centroid, updated_at)    -- 细桶中心，**粗桶归属由外键保证**
  vector_cell_members(fine_id, memory_id)                      -- ★ cell_id 恒指向**细桶**；
                                                                --   一条记忆只属一个细桶
                                                                --   （唯一索引 idx_vcm_memory_unique 兜底）

桶中心：Float32 小端、L2 归一化（与 memories.embedding 同构）
训练：k-means 两级
  粗：ROUTER_COARSE_CENTERS(200) 个中心，对全库向量训练一次
  细：在每个粗桶内再分 ROUTER_FINE_CENTERS / ROUTER_COARSE_CENTERS(50) 个细中心
  ⚠️ **确定性初始化**：按 rowid 顺序取前 K 条作为初始中心，**不用随机采样**——
     随机初始化会让「同一份数据两次训练得到不同的桶」，直接破坏可复现性。
  ⚠️ ★ **训练触发有三个时机，缺一不可**（v2.1 裁决）：
     ① **建库时**（语料已过 `ROUTER_MIN_TRAINING`）
     ② **库长大成人时**（原本 < 门槛、未建分桶 ⇒ 后来越过门槛）
        —— **自动触发**：宿主检测到「已过门槛但分桶未训练」⇒ 调用一次 `rebuildVectorBuckets()`。
        ⚠️ **这条必须有，否则「库长大了」这条最正常的成长路径没有对应的能力提升**：
        从 500 条长起来的库，建库时因 < 10000 未建桶、从未训练；
        而重训的触发条件（桶内成员数 P95 超标）**在根本没有桶的情况下永远不触发**
        ⇒ 向量路**永久缺席**，而库里明明有 5 万条有向量的记忆。
     ③ **分布漂移后**（§9.3.2 ④ 的 P95 阈值）
     ⇒ 三个时机**共用同一套训练代码**，只差触发条件。
  ⚠️ 训练耗时：100 万 × 768 维，k-means 一轮 ≈ 1~3 分钟（一次性）。
     ⚠️ **训练期的峰值内存必须写明**：全部向量（3.07GB）+ 桶中心（30MB）+ k-means 的
     距离矩阵 ⇒ **峰值 ≥ 3.5GB**。这是本库**唯一**的高内存时刻（日常运行只需
     桶中心常驻 30MB + SQLite 页缓存）。**低配机器建库时要有心理预期。**
  ⚠️ **增量归桶规则**（新记忆入库时）：
     ① 算新向量到**全部粗中心**的距离 → 取最近 `ROUTER_NPROBE_COARSE` 个粗桶；
     ② 在这些粗桶的**细中心**里取最近的一个 → 该细桶即新记忆的归属。
     ③ **桶归属与 memories 的写入必须同事务**（§9.3.2 ①）；
        换桶时要**先 DELETE 旧归属行再 INSERT 新行**——
        `INSERT OR REPLACE` 只按 `(fine_id, memory_id)` 复合主键覆盖，
        **换桶（fine_id 变了）不会删掉旧行** ⇒ 一条记忆会同时挂在两个桶上，
        候选集里出现重复，且 `size` 计数偏大。**这一步漏了就是 §4.15.5 那个静默失效点。**
     ⇒ **建库时训练一次，之后增量维护**（新记忆归到最近的细桶中心）。
```

| 方案                          | 优势                                                                            | 劣势                                                                                                                          | 结论         |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **主库内两级分桶（本版选定）**           | **精确**（桶内全量点积，无近似召回）；**与主表同事务**（零一致性负担）；**零原生依赖**（保住 v1.0 的边界）；100 万条下约 3~5ms | 桶需随语料重训；探针数不够时有召回损失（可测、可调）                                                                                                  | ✅ **本版选定** |
| usearch HNSW（Rust 核心，N-API） | HNSW/IVF 均可；索引可 mmap 持久化；100 万条查询 10~30ms                                     | **需原生依赖**；**索引是 sidecar 文件 ⇒ 与主库无法同事务**，要额外建一套对账 + 就绪闸门 + 幽灵向量防御（§9.3）；**有 ANN 召回损失**（要额外守 recall@20 ≥ 0.95 的验收线）；结果不可跨版本复现 | ❌          |
| hnswlib-node（纯 JS 移植）       | 无原生编译，部署最简单                                                                   | 100 万条查询性能约为 usearch 的 1/3；内存更高；无 IVF，做不了两级路由                                                                               | ❌          |
| sqlite-vec（SQLite 扩展）       | 最贴合「单文件」定位                                                                    | 需重新编译 SQLite；只支持全量 flat 或单层 IVF，做不了「粗 200 → 细 1 万」两级路由                                                                      | ❌          |

> **被否决的备选方案：usearch HNSW（本版曾选它，后推翻）。**  
> 理由不是「ANN 不好」，而是**它带来的三样东西，本库一个都不需要**：  
> ① **sidecar 一致性机制**（启动对账、就绪闸门、幽灵向量防御、原子替换顺序）——  
> 分桶把桶归属放在主库表里，**与主表同事务写**，这一整套机制直接不存在；  
> ② **ANN 召回损失**与守它的验收线——分桶是精确的，探针覆盖充分时 top-N 与 flat 高度一致（覆盖不足时**只漏、不错**）；  
> ③ **原生依赖**——分桶是纯 TypeScript + SQLite，保住了 v1.0「零外部依赖」这条边界。  
> **代价明写**：分桶需要训练（一次性 1~3 分钟）与重训（语料分布漂移后），  
> 且探针数不够时会有召回损失（唯一的近似来源，§4.6 步骤 2c 已给出测法）。  
> ⇒ **ADR-16 记录本裁决；ADR-25（ANN sidecar 一致性）随之作废。**

#### 4.15.4 分桶对打分的影响：**连候选池都不变**

```
① medianBm25 基准：不受影响。
   §4.6 步骤 3 的 bm25List 只收 raw_bm25 非空的候选（只有文本路命中的），
   而文本路与向量路完全解耦 ⇒ median 逐位不变 ⇒ 每条候选的五因子分逐位不变。

② 向量路的候选集：只要探针覆盖充分，分桶的 top-N 与 flat 的 top-N **高度一致**（吻合率 ≥ 0.98；覆盖不足时**只漏、不错**）
   （桶内是全量精确点积，不是近似召回）。⇒ 与 flat 相比，只有探针边界上的少数候选会变。

③ 唯一的变化来源是探针数，不是「近似误差」。
   ⇒ 这与 v1.0 的 flat 相比，是**可解释的、可测的、可调的**——
   不像 ANN 那样有一层无法归因的召回损失。
```

⚠️ **理由写对比结论写对更重要**：v1.0 有一条很有道理的断言——  
「本库不接受用参数换正确性」。分桶**没有破坏**它：  
探针数换来的是**延迟**，不是**正确性**——探针覆盖充分时结果与全表扫完全相同。  
而 ANN 换来的延迟**确实**降低了正确性（召回损失），那才违反这条断言。

#### 4.15.5 分桶的维护与一致性

```
★ **桶归属与主表同事务写**——这是选分桶最实在的收益：
  write()/merge()/updateContent() 改 embedding 的同一事务内，
  必须同步更新 vector_cell_members 的行（INSERT OR REPLACE 到最近的细桶）。
  失败即整体回滚 ⇒ **不会出现「记忆在、桶不在」的孤儿**。
  ⚠️ 这一步**不能省**：省了它，那条记忆将永远不进任何桶 ⇒ 向量路永远召不回它，
  且**没有任何报错**（这是本节唯一的静默失效点）。

删除路径：
  forget({hard:true}) → 删 vector_cell_members 行（同事务，FK ON DELETE CASCADE 兜底）
  软删**不删桶归属**：软删记忆仍可 restore，且 §8.2 要求软删保留向量。
  ⚠️ **软删记忆必须被召回时过滤掉**——§4.6 步骤 2c 的 SQL 有 `m.deleted = 0`。
    ⚠️ **这是软删场景的唯一一道防线**：FK `ON DELETE CASCADE` 只在**硬删**（行被物理删除）时触发；
    **软删不删行 ⇒ CASCADE 不生效** ⇒ 软删场景下没有「第二道防线」，
    省略 `m.deleted = 0` ⇒ **已遗忘的记忆会被向量路照常召回**（§8.2 的遗忘承诺直接破）。
    硬删场景由 FK CASCADE 兜底（§9.3.2 ②）。

重建：
  ① 桶归属与主表不同步（应当不可能，但防御）→ 启动时对账：
     ★ **口径以 §9.3.2 ③ 为准，本节不重复定义**：
       **必须用集合比较，不能用 COUNT 比较**（条数相同但成员不同 ⇒ 漏召永久存在且无人发现），
       桶侧必须用 **LEFT JOIN**（否则硬删孤儿会被一并放过），且须同时满足三条判据
       （双向 EXCEPT 抓缺失/脏行 + `COUNT(*) == COUNT(DISTINCT memory_id)` 抓重复归属 +
       唯一索引从源头堵住重复）。
       ⇒ **实现细节与三分支处置规则一律看 §9.3.2 ③**，两处口径必须一致。
  ② 向量分布漂移导致桶质量下降（实测：分桶内成员数的方差显著上升）
     → 触发全量重训 + 重分配（`rebuild()`）。
     触发条件写成硬阈值（桶内成员数 P95 超过 `ROUTER_BUCKET_MAX`），不靠感觉。

  ⚠️⚠️ **重训的删除顺序是硬约束（缺了它，一次重训会静默清空全库桶归属）**：

```

★ 正确顺序（三步，不可颠倒）：  
① 建新桶（新一组 coarse/fine cell id，centroid 与旧桶无关）  
② 迁成员：按新中心重新分配每条记忆的桶归属  
③ 最后删旧桶（旧 coarse/fine cell 及其成员行随 FK CASCADE 一并消失）

⚠️ **为什么不能先删旧桶**：细桶的成员行通过 FK 指向细桶、  
细桶指向粗桶 ⇒ 删旧粗桶会**级联删掉它下面全部细桶**，  
再级联删掉全部 `vector_cell_members` 行。  
⇒ 一次重训 = **全库桶归属被清空**（记忆本体不受影响）  
⇒ 向量路整体消失、**不报错、不告警**，直到有人查 `archivalMismatch` 之外的向量路指标。  
⚠️ **CASCADE 本身是对的**（自引用链条确实成立）；  
错的是**文档没写删除顺序**，而缺这条时最自然的写法恰好是最坏的那个。

⚠️⚠️ **步骤 ② 必须是「逐条记忆 delete-old + insert-new」，不能是「先批量插新桶、再批量删旧桶」**：  
`idx_vcm_memory_unique`（`memory_id` 唯一，§3）保证「一条记忆只属一个细桶」。  
⇒ 若先 INSERT 新桶成员行而**旧行还在**，唯一索引会**直接写失败**  
（`UNIQUE constraint failed`）——这不是「防重复的兜底」，而是**步骤 ② 本身跑不通**。  
⇒ 正确形状（每条记忆在**同一个事务**内）：  
DELETE FROM vector_cell_members WHERE memory_id = ?;   -- 先摘掉旧归属  
INSERT INTO vector_cell_members(fine_id, memory_id) VALUES (?, ?);  -- 再挂新归属  
⇒ 唯一索引在**任何时刻都不被违反**，且「一条记忆同时挂两个桶」的状态**根本不存在**，  
而不是「存在但会被索引挡下」。  
⇒ 因此步骤 ③ 只需删**已空的旧桶**（成员行已随步骤 ② 摘干净），  
删旧粗桶时的 CASCADE **不再影响任何有效归属**。  
⚠️ 这正是那条唯一索引存在的**第二个理由**（第一个理由是挡住历史脏数据写入）。  
⚠️ 重训的**中间态可见性**：步骤 ② 与 ③ 之间，旧桶仍存在（但成员行已摘空）⇒  
路由若命中一个**空旧桶**，候选集为空 ⇒ 表现为「漏召」而非报错。  
⇒ 步骤 ② 必须**整批提交之后**才执行 ③；且步骤 ③ 之前不得让新桶对外可见。  
⚠️ **重训中途崩溃怎么办**（1~3 分钟的批量操作，按 §9.2 的反长事务哲学必然增量提交）：  
崩溃点落在「② 提交了一部分」时 ⇒ **新旧两代桶同时存在**，  
而 `inRetrain` 是内存/查询态（§6）、**重启即失** ⇒ 无从知道「上次没跑完」。  
⇒ **恢复口径（不引入代际标记的最小做法）**：  
· 启动对账（§9.3.2 ③）会先发现「库侧有向量、桶侧无归属」⇒ **按集合补齐**，  
补进最近的**当前代**细桶；  
· 随后由调用方显式调 `rebuildVectorBuckets()` **重做一次**（重做是幂等的：  
它按当前全部向量重新分配，不依赖上一轮的中间产物）；  
· **重做前**必须先清掉**成员行为空、但仍存在的旧代细桶/粗桶**，  
否则路由可能命中空旧桶 ⇒ 静默漏召。  
⇒ ★ **推论：`rebuildVectorBuckets()` 必须能清理「空的旧代桶」**，  
否则崩溃后的第二次重做会留下一堆空桶，让路由有概率命中空桶。  
这是**恢复所必需**的行为，不是可选优化。  
⚠️ **重训后仍不达标**：若重训一次后 P95 仍超 `ROUTER_BUCKET_MAX`，  
不得在启动阶段反复重训（会把启动拖成分钟级）。  
⇒ 只重训一次，仍不达标则**记告警并放行**（向量路质量降级，不是启动失败）。  
⚠️ **训练期峰值内存**：全部向量 3.07GB + 桶中心 30MB + 距离矩阵 ⇒ **峰值 ≥ 3.5GB**。  
这是全库**唯一**的高内存时刻（日常运行只需桶中心常驻 30MB + SQLite 页缓存）。  
**低配机器建库时要有心理预期。**  
⚠️ ★ **重训的触发与并发口径（v2.1 裁决，与 ADR-5 一致）**：  
\- **库内没有定时器、没有后台线程**：重训由**调用方显式调用** `rebuildVectorBuckets()` 触发。  
\- **库是全同步 API（ADR-5）**：在**同一个线程**上调用时，该线程会被阻塞 1~3 分钟  
（同步模型的必然结果，不是缺陷）。  
\- **要让重训期间不阻塞请求**：调用方须在**自己的另一个线程**里调用它，  
并使用**独立的数据库连接**。  
⇒ 此时 **WAL 保证「读不阻塞写」**（这正是选 WAL 的理由）⇒ `recall` / `stats` 照常工作。  
⇒ ⚠️ **写仍然互斥**：重训期间其它**写**调用会等锁（`busy_timeout` 见 §9.1）。  
\- ⚠️ ★ **`inRetrain` 的可观测性有前提**：它是**进程内的实例字段**。  
⇒ 只有当重训与查询**发生在同一个 `MemoryStore` 实例**（同进程、同实例、不同线程）时，  
查询侧才可能观察到 `inRetrain = true`。  
⇒ 若重训跑在**另一个进程 / 另一个实例**里，本实例的 `inRetrain` **恒为 false**——  
这不是 bug，是**跨实例不可观测**的必然结果。  
⇒ **推论**：面板不得把「`inRetrain=false`」解读成「没在重训」——  
它只说明「**本实例看不到**重训」；库级真相看 `vector_fine_cells.updated_at`。  
\- **为什么不设成「只能在启动期做」**：那会让 §4.15.6 的状态③**永远观察不到**  
⇒ 那个守卫是空的、`inRetrain` 恒为 false ⇒ 三态退化成两态  
⇒ 「库长大了自动训练」这条路径也没有地方落脚。  
⇒ **允许运行时重训**，但**触发权在调用方**（库不自己决定何时训练）。  
\- ⚠️ **代价**：训练期间向量路缺席 ⇒ 那 1~3 分钟内向量召回质量下降  
（不是没有，是退化成无向量路）。**必须可观测**（`stats().vectorBackend.mode`）。

````

#### 4.15.6 可复现性的口径

v1.0 的「结果可复现」在引入分桶后**基本保住了**，比引入 ANN 时好得多：

- ✅ **同库 + 同查询 → 结果稳定**（桶归属确定、桶内点积确定、排序有全序 tie-break）
- ✅ **同库 + 同查询 + 桶未重训 → 与 flat 扫描结果一致**（桶内是精确点积）
- ⚠️ **不承诺跨桶重训逐位一致**（重训后桶边界变了，近邻的取法可能变）
- ⚠️ **不承诺跨探针数一致**（`ROUTER_NPROBE_*` 改了，边界候选会变）

⚠️ ★ **向量路的后端状态：四种，互斥。面板与 `stats()` 必须能区分。**
（v2.1 裁决——原文本的「前言说缺席、① 说走 flat」是**同一段里两个结论**，
  而**小库（500 条）同时落在两者上** ⇒ 文档最常见的场景有两种读法。）

| 态 | 条件 | 向量路 | 面板措辞 |
| --- | --- | --- | --- |
| ① **flat 模式** | 库内未删且有向量的记忆数 **< `ROUTER_MIN_TRAINING`**(10000) ⇒ **还没到建桶的门槛**，**且 `VECTOR_ROUTER` 不是 `'ivf'`**（显式 `'ivf'` 属态④） | **正常工作**（全表精确点积） | 「向量路：**flat 模式**（库规模 < 1 万条，未建分桶）」——**不是「不可用」** |
| ② **缺席（未训练）** | 语料已过门槛，但分桶尚未训练 | **不工作**（向量候选一条也没有） | 「向量路不可用（分桶未训练）」 |
| ③ **缺席（重训中）** | 分桶正在重训 | **不工作** | 「向量路不可用（分桶重训中）」 |
| ④ **ivf 模式（强制）** | `VECTOR_ROUTER` = `'ivf'`（**无论库规模**）：低于门槛时**照建桶 + 一条 warn**（「库规模低于建桶门槛，IVF 收益未经验证」），桶尚未建好期间向量路整体缺席 | 建好后**正常工作**（两级分桶）；建桶完成前**不工作** | 「向量路：ivf 模式（两级分桶）」／建桶完成前「向量路不可用（分桶未训练）」——**逐条读 §7.2 面板 1 的表** |

⇒ **① 与 ②③ 必须分开**：① 是「能搜」，②③ 是「不能搜」。
混为一谈 ⇒ 用户看到一个**完全正常的小库**被标成「向量路不可用」⇒ 误判系统坏了。
⇒ ②③ 时**文本路与图谱路照常工作**（§4.6 铁律① 的准入闸门不受影响）。
⇒ **这必须可观测**：`stats().vectorBackend.mode` + `stats().vectorBackend.inRetrain`
  （**类型以 §6 的 `MemoryStats.vectorBackend` 为唯一权威**：`mode` 是**四值**
  `'flat_explicit' | 'flat_auto' | 'ivf' | 'absent'`，`inRetrain` 仅在 `mode === 'absent'` 时有意义）
  + 面板 1 的「向量路」块（§7.2 面板 1 的向量路块、§7.3 状态表）。
★ **「四态」是**语义层**的归纳，「四值 + 一布尔」是**类型层**的投影，两者不是矛盾**：
  上表四行是用户能读懂的四种处境，而 `mode` 必须用**四个互不相同的字面量**表达，
  因为 `flat_explicit`（调用方显式选择）与 `flat_auto`（库太小自动降级）虽然都「能搜」，
  **处境不同、措辞也不同**（C36：配置与状态不得共用同一套词）。
  ⇒ **本表的四行按「能搜 / 不能搜（未训练）/ 不能搜（重训中）/ 不能搜（强制建桶中）」归纳**；
    具体取值一律读 §6，不要在本表另立一套枚举。

★ **与 ANN 方案的关键差别**：这里只有两条限定，且**两条都能被观测**——  
「桶重训过没有」（看 `vector_fine_cells.updated_at`）、「探针数是多少」（看参数快照）。  
不需要维护「ANN 召回率 ≥ 0.95」这种无法从结果反推的指标。

## 5. 参数表（集中配置）

所有业务参数统一通过配置对象传入，支持动态覆写与查看器只读观察：

| 分组        | 参数名                   | 默认值   | 作用与含义                                                                    | 调大的后果                                                                                                    |
| --------- | --------------------- | ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **衰减与分层** | `MAX_STABILITY`       | 180 天 | 单条记忆的稳定度上限截断                                                             | 老记忆淡化极慢，长期可能导致召回偏向陈旧内容                                                                                   |
|           | `MAX_PIN_FACTOR`      | 5.0   | `pin()` 允许的强调倍率上界                                                        | 允许「永生」记忆，且让 §4.6 粗筛对它永久失效。注：数据库 CHECK 约束写死为 5.0，改这个默认值需同步改 DDL                                           |
|           | `THRESHOLD_L3`        | 0.7   | L3（活跃层）的 intensity 阈值下限                                                  | 活跃层记忆变少，AI 减少主动发起话题的频率                                                                                   |
|           | `THRESHOLD_L2`        | 0.3   | L2（温和层）的 intensity 阈值下限                                                  | L2 区间变窄，L1 冷却层变宽                                                                                         |
|           | `ARCHIVE_LINE`        | 0.05  | 归档线，低于此值不参与常规召回                                                          | 调大（如0.1）则更早被归档；调小则归档放缓                                                                                   |
|           | `EDGE_STABILITY`      | 30 天  | 图谱边权重的时间常数 τ（**实际半衰期 20.8 天**）                                           | 历史关系维持时间更长                                                                                               |
|           | `MAX_EDGE_WEIGHT`     | 3.0   | 边权重上限（仅用于截断 weight 增长，**不作为扩散公式分母**）                                     | 允许单条关系被强化到更高强度                                                                                           |
| **写入与增长** | `INITIAL_STABILITY`   | 1.0 天 | 全新记忆写入时的初始稳定度                                                            | 新记忆起步更牢固                                                                                                 |
|           | `EMOTION_WEIGHT`      | 2.0   | 情绪系数放大倍率                                                                 | 高情绪记忆沉淀时间极长                                                                                              |
|           | `DIFFICULTY_BASE`     | 1.5   | 间隔复习时的基础倍率                                                               | 强化节奏全面加快                                                                                                 |
|           | `DIFFICULTY_SCALE`    | 0.5   | 难度系数对倍率的调节幅度                                                             | 简单事物与困难事物的增长差距放大                                                                                         |
|           | `DIFFICULTY_FIRST`    | 0.3   | 实体首次事实的难度（偏简单）                                                           | 初次印象更容易变牢                                                                                                |
|           | `DIFFICULTY_NORMAL`   | 0.5   | 常规记忆的基础难度                                                                | 后续补充事实的默认难度                                                                                              |
|           | `SPACING_CAP`         | 2.0   | 间隔效应封顶倍数                                                                 | 单次间隔复习的最大加成受控                                                                                            |
| **去重与关联** | `DEDUP_ENTITY_MIN`    | 2     | 合并近重复事实所需重叠实体数                                                           | 门槛更高，减少误合并，可能轻度增加冗余                                                                                      |
|           | `DEDUP_COS_MIN`       | 0.92  | 写入去重时「仅凭余弦即可判为同一事实」的阈值（§4.9 步骤 3c），**满足它就不再看实体重叠**                       | 调高则误合并更少、重复堆积更多；调低反之。**它是取舍点，不是安全线**——0.97 会让这条规则只剩形式意义，0.85 会把「喜欢/讨厌」并成一条                               |
|           | `DEDUP_BOOST`         | 1.3   | 重复提及或合并时的稳定度提升系数                                                         | 多次提及能更快稳定                                                                                                |
|           | `INITIAL_EDGE_WEIGHT` | 0.8   | 新创建知识边时的初始权重                                                             | 关系起步强度更高                                                                                                 |
|           | `EDGE_REINFORCE_STEP` | 0.3   | 单次权重增量，两个来源：重复 link 同一三元组、touch 时按证据记忆强化（§4.5 R-EDGE-TOUCH）              | 关系强度增长更快，更早触及 `MAX_EDGE_WEIGHT`                                                                          |
| **检索与扩散** | `RECALL_TOP_N`        | 5     | 每次召回默认注入的记忆条数                                                            | 上下文更长，需权衡 Token 消耗（钳制 1~8）                                                                               |
|           | `EMBED_DIM`           | 768   | 向量维度。**只读**：`setParams()` 传入它直接抛 `INVALID_INPUT`，只在 `MemoryConfig` 构造时生效 | 它不是一个可以「调大」的量：改它等于全库旧向量作废（长度校验会拒绝读回）。换维度或换 embedding 模型都必须**全量重嵌入**，同维度的模型切换本库无法检测——见 §3 `embedding` 列注释 |
|           | `VECTOR_TOPK`         | 20    | 向量路带进打分阶段的候选条数（与文本路 `slice(0, 20)` 对齐）                                   | 更多语义候选参与竞争，也可能带进弱相关项；延迟几乎不变（点积已经算完）                                                                      |
|           | `VECTOR_MIN_COS`      | 0.25  | 低于此余弦的条目**不进候选**（不是得 0 分，而是根本不出现在候选集里）                                   | 调高则语义路更保守、可能漏召；调低则弱相关项挤占 topN 名额                                                                         |
|           | `ACTIVATION_DECAY`    | 0.2   | 关联记忆的激活扩散系数                                                              | 联想范围更广                                                                                                   |
|           | `ACTIVATION_MIN`      | 0.15  | 激活扩散进入附带结果的最小阈值（按 `INITIAL_EDGE_WEIGHT` 归一，新边 `0.2×(0.8/0.8)=0.2` 可立即触发） | 门槛更低，返回更多背景线索                                                                                            |
|           | `MAX_DIFFUSED_NODES`  | 20    | `diffused` 最多返回的条数（返回量与 Token 成本上限）                                      | 联想返回更多，直接抬高每次召回的输出长度                                                                                     |
|           | `MAX_DIFFUSED_VISITS` | 200   | 扩散的**边处理预算**（不是候选数，见 §4.7）                                               | 计算量与单次召回延迟上升；图稠密时最明显                                                                                     |
|           | `RECENCY_DECAY_DAYS`  | 14 天  | 新近度的时间常数 τ（**实际半衰期 9.7 天**）                                              | 更偏向近期新记录的内容                                                                                              |
| **维护**    | `SWEEP_BATCH_SIZE`    | 500   | `sweep()` 每批处理的条数与归档统计的分批粒度（既是事务粒度也是游标步长）                                | 单事务更长、持锁更久，但批次往返次数减少；调小则相反。不建议超过 5000                                                                    |


---

**v2.0 新增参数（神经元交互 + 涌现簇 + 侧抑制 + 分桶路由 + 维护 + 机制开关）**：

| 类别       | 名称                           | 默认      | 含义                                                                       | 调大后果                                             | 调小后果                                                                  |
| -------- | ---------------------------- | ------- | ------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------- |
| **共激活**  | `COACT_AFFINITY_MAX`         | 1.0     | 共激活亲和度上限（应用层钳制，与 §3 的 CHECK 同步）                                          | 上限放宽，弱关联保留更久，共激活表更快膨胀                            | 上限收紧，强关联优势更明显，中等关联被过早淘汰                                               |
|          | `COACT_AFFINITY_MIN`         | 0.15    | 共激活的**有效**亲和度下限。**一套阈值三处语义**：① 簇的边判定 ② `sweep()` 的淘汰判据 ③「这一对还算不算一条关联」    | 簇更少更大、淘汰更慢；但陈旧关联长期滞留                             | 簇更碎、淘汰更早；调大到 0.30 会让单次共现（0.20）根本不成边                                   |
|          | `COACT_REINFORCE_STEP`       | 0.20    | 每次共激活的基础增量                                                               | 强化更快，簇形成更快，但误共激活的代价也更快放大                         | 强化更慢，簇形成周期拉长                                                          |
|          | `COACT_CAUSAL_BONUS`         | 0.25    | 「扩散唤起后被采纳」的额外增量（因果证据）                                                    | 因果关联权重更高，簇更贴近真实使用                                | 因果区分度下降，簇退化为「只是相关」                                                    |
|          | `COACT_STABILITY`            | 21 天    | 共激活亲和度的衰减时间常数 τ（**半衰期 = 21×ln2 ≈ 14.6 天**）                               | 衰减更慢，关联更持久，但陈旧关联长期滞留                             | 衰减更快，簇更贴近当下，但易碎                                                       |
|          | `COACT_MIN_ENTITIES`         | 2       | 建立共激活所需的最小共享实体数（**与 `DEDUP_ENTITY_MIN` 语义不同、不绑死**）                       | 门槛更高，共激活更稀疏更准，但覆盖率下降                             | 门槛更低，覆盖率上升，但弱关联灌满共激活表；**调低会让实体路径成为共激活的主要来源，而实体路径不要求语义相近 ⇒ 巨型簇风险显著上升** |
|          | `COACT_MIN_COS`              | 0.50    | 建立共激活所需的最小余弦                                                             | 语义更严格，簇更纯，但低向量质量库的覆盖率下降                          | 更宽松，弱语义关联进入共激活表；**同样是巨型簇的一级成因**                                       |
|          | `COACT_MAX_PAIRS_PER_TOUCH`  | 20      | 单次 touch 最多记多少对共激活                                                       | 覆盖更全，但单次 touch 的写放大上升                            | 写放大小，但大批量 touch 时会漏记（截断数写进事件）                                         |
|          | `COACT_BATCH_MAX`            | 256     | 单次 touch 的 `coActivateWith` 条目数上限                                        | 一次可声明更多关联                                        | 超出 → `INVALID_INPUT`（**不静默截断**——截断会让调用方以为全写进去了）                       |
| **涌现簇**  | `CLUSTER_TOPK`               | 3       | 簇跳每条种子取几个同簇邻居                                                            | 联想更丰富，但 Token 成本与跑题风险上升                          | 更保守                                                                   |
|          | `MAX_CLUSTER_SHARE`          | 0.5     | **兜底切分的触发阈值**：最大簇成员数 / 未删记忆总数。超过它才切分（§4.12.4）                            | 单簇可占更大比例 → 切分更少 →「用户在发大量重复内容」这个可识别事实保留得更完整       | 退化判定更早 → 切分更频繁 → 簇结构变更更多、该信息被抹得更碎                                     |
|          | `CLUSTER_MAX_FRACTION`       | 0.02    | 切分的**目标尺寸** = 库规模的比例。有效上限 = `max(2, floor(该比例 × totalMemories))`         | 单簇可占更大比例 → 切分更少                                  | 单簇占比更小 → 切分更频繁 → 簇结构变更更多                                              |
|          | `CLUSTER_MEMBER_SAMPLE_MAX`  | 50      | **所有列出簇成员的操作的 LIMIT**，按有效 affinity 降序取                                   | 簇快照更全；返回量与 Token 成本上升                            | 更快更省；巨型簇的代表性样本可能偏少                                                    |
|          | `CLUSTER_RECALC_INTERVAL_MS` | 3600000 | **建议宿主调度 `recluster()` 的周期**（默认 1 小时）。⚠️ **库内无定时器**（ADR-5）——这是给调用方的调度建议，库不会自己按周期跑；宿主在自己的线程里按时调用即可 | 簇更新更及时，但 CPU 开销上升                                | 更省资源，但簇更陈旧                                                            |
| **侧抑制**  | `REDUNDANCY_COS`             | 0.90    | 语义路径判「事实级冗余」的余弦阈值。**校验：`0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN`**            | 冗余判定变少，抑制变弱                                      | 冗余判定变多，抑制变强，可能误杀「重要但相似」                                               |
| **维护**   | `ARCHIVAL_ORPHAN_CHECK`      | 1000    | 归档缓存一致性抽样条数（每次 `stats()` 抽 N 条，用 §9.4.1 公式重算 `archive_at` 与表内值比对，不一致则告警） | 自检更密 ⇒ 偏移发现更早；`stats()` 略慢                       | 自检更稀 ⇒ 偏移可能长期未被发现（但 `archivalOrphans` 仍是常设护栏）                         |
| **共激活** | `COACT_DEGREE_MAX` | 32 | **单条记忆的共激活邻居数上限**（度数上限）。超过上限时**只保留最强的前 N 条**，其余边被删除。这是度数爆炸的**唯一闸门**——没有它，一条被反复 touch 的枢纽记忆会连出上万条边，簇跳与聚类都会被它拖垮 | 上限调大 ⇒ 枢纽记忆的邻居更全、簇跳更准；但共激活表更快膨胀、聚类更慢 | 上限调小 ⇒ 表更小、聚类更快；但枢纽记忆的真实近邻会被截断，簇跳可能错过强关联 |
| **向量路** | `ROUTER_MIN_TRAINING` | 10000 | **建分桶的最小库规模**（未删且有向量的记忆数）。低于它**不建分桶**，向量路走 flat（§4.15.3）。★ 这是**设计内行为，不是故障** ⇒ 面板须显示「flat 模式」而非「不可用」 | 更小 ⇒ 更多小库走 flat（精确但慢）；更大 ⇒ 更多小库被迫走分桶（探针边界可能有漏召） | 更小 ⇒ 几乎所有库都建分桶（但小库上桶内成员过少，簇跳易返回空） |
| **向量路** | `VECTOR_ROUTER` | 'auto' | **第五个机制开关**（三值选择器）：向量路后端选择。`'auto'`（默认，按 `ROUTER_MIN_TRAINING` 自动选：低于门槛 → flat，达到 → 建桶）/ `'ivf'`（**强制**两级分桶，即使低于门槛；因分桶是精确的，结果仍正确，只记一条 warn 日志）/ `'flat'`（强制全表精确扫描，v1.0 做法）。★ **自动判定只作用于 `'auto'`**：低于门槛 → flat，达到门槛 → 建桶（§4.6 步骤 0 的判定顺序）；**显式值永远接管**——`'ivf'` 恒走两级分桶（低于门槛时照建桶 + 一条 warn），`'flat'` 恒走全表精确 ⇒ 同一库不会因实现不同而走不同向量路 | —（三值各自固定，无单调方向） | `'flat'` 才是真正回到 v1.0 的向量路；`'ivf'` 强制建桶（低于门槛时结果仍正确，只是收益未经验证） |
| **簇跳** | `CLUSTER_BONUS` | 0.40 | 簇跳进入 `diffused` 的加成系数（§4.14.3） | 联想更易被采纳；但**挤占**实体跳在 `MAX_DIFFUSED_NODES` 里的名额 | 联想更保守 |

> ★ **五个机制开关**（CI 与文档各有一份权威，改开关时两处必须同步）：
> | 开关 | 默认 | 关掉 / 改值的含义 |
> | --- | --- | --- |
> | `coactivation` | true | 不写 `coacts`；联想路与簇跳不执行；簇不计算 |
> | `inhibition` | true | 无侧抑制（候选带不重排） |
> | `writeBack` | true | 关闭「扩散唤起 → 采纳 → 回写」的**联动**（`growStability` 加固不受影响） |
> | `ARCHIVAL_CACHE` | true | `countArchived()` 退回逐行精筛（结果相同、路径不同） |
> | `VECTOR_ROUTER` | 'auto' | 向量路后端：auto / ivf / flat（见 §5 的向量路分组） |
>
> ⚠️ 前三个是**小写**键：它们不是业务参数，是「机制有没有」的开关。
> ⚠️ `ARCHIVAL_CACHE` 与 `VECTOR_ROUTER` 是**大写**键，因为它们本身有取值语义。
>
> ★ **CI 断言**（建议纳入流水线，data-engineer 的 `check_params.py` 已就绪）：
> · §5 表与 `DEFAULT_PARAMS` **逐键逐值相等**（含 5 个机制开关的白名单）
> · §5 表的**行不缺**（形态②）
> · §5 说明文字里的**裸数值必须点名参数**（形态④）——
>   例：`ACTIVATION_MIN` 行写「新边 `0.2×(0.8/0.8)=0.2`」⇒ 那两个 0.2 其实是
>   `ACTIVATION_DECAY` / `INITIAL_EDGE_WEIGHT` 的值但没点名 ⇒ 读者会误读
>   ⇒ 修法：写成 `ACTIVATION_DECAY × (edgeWeight / INITIAL_EDGE_WEIGHT)`
> · **payload 键集断言**：解析 §8.4 的 touch / merge 字段表 ⇒ 比对 §4.2 / §4.9 三处
>   payload 字面量的键集 ⇒ **缺键即报错**
>   ⇒ ★ **这一条能一次性堵住「§8.4 声明了、实现点没有」这一整类缺陷**
                                 -- ⚠️ **调它不是「对齐量纲」**——两腿量级不同是**刻意的**（见 §4.14.3）：
                                 --   实体跳 ≤ `ACTIVATION_DECAY`(0.2)；簇跳 ≤ `CLUSTER_BONUS` × affinity_eff(≤0.4)
                                 --   ⇒ 只在 affinity_eff ≈ 0.5 时相等 ⇒ 合并取 max 时
                                 --   **簇跳在 affinity_eff > 0.5 时占优、实体跳在低亲和时占优**
                                 --   ⇒ 把它调到 0.2「对齐量纲」会**把设计意图改掉**
| **分桶路由** | `ROUTER_COARSE_CENTERS`      | 200     | 粗层桶中心数（k-means 第一层）                                                      | 粗扫更贵（200×768 ≈ 0.2ms），漏桶更少                       | 粗扫更快，但漏掉的粗桶里的细桶全扫不到 ⇒ **静默漏召**，这是路由最危险的失败模式                           |
|          | `ROUTER_FINE_CENTERS`        | 10000   | 细层桶中心数（每粗桶约 50 个）                                                        | 细桶更小 ⇒ 桶内成员更少、桶内扫描更快；但中心表更大（10000×768×4B ≈ 30MB） | 桶内成员更多 ⇒ 桶内扫描更慢、候选集更大                                                 |
|          | `ROUTER_NPROBE_COARSE`       | 20      | 粗层探查的桶数                                                                  | 覆盖更多粗桶 → 漏召更少，但细层点积更贵                            | 漏召更多。**这是召回损失的唯一来源**（§4.15.4）                                         |
|          | `ROUTER_NPROBE_FINE`         | 50      | 细层探查的桶数                                                                  | 候选更全 ⇒ 桶内扫描量上升；召回损失更小                            | 漏召更多；候选扫描量 = `nprobe_fine × 每桶成员数`，调它必须同步算这个乘积                        |
|          | `ROUTER_BUCKET_MAX`          | 300     | 桶内成员数 P95 的上限，超过则触发全量重训（§9.3.2 ④）                                        | 重训更少，但桶可能已经不够「纯」                                 | 重训更勤；每次重训 1~3 分钟且阻塞启动                                                 |
|          | `ROUTER_NPROBE_WRITE_COARSE` | 8       | **写入去重路径**的粗层探查桶数（§4.9 步骤 3a2）                                           | 写入去重候选更全；写入延迟上升                                  | 写入更快；去重漏召风险上升（近重复对漏掉 → 重复堆积）                                          |
|          | `ROUTER_NPROBE_WRITE_FINE`   | 20      | **写入去重路径**的细层探查桶数（候选扫描量 ≈ **20 × 每桶成员数 = 2000 条**（= 候选池上限，**顶格**））                           | 写入去重候选更多                                         | 写入更快；候选不足 2000 条的下限可能被击穿                                              |

**机制级开关（v2.0 新增，进 `DEFAULT_PARAMS`，可运行时切换）**：

| 名称               | 默认   | 关闭后的行为                                                                                                               | 用途              |
| ---------------- | ---- | -------------------------------------------------------------------------------------------------------------------- | --------------- |
| `coactivation`   | true | `touch` 不写 `coacts`；联想路不执行；§4.14 簇跳不执行；主题簇不计算也不使用                                                                    | **A/B 对照的基线开关** |
| `inhibition`     | true | 无侧抑制（候选带不重排，直接按 base 分取 topN）                                                                                        | 同上              |
| `writeBack`      | true | 关闭「扩散唤起 → 采纳 → 回写」的**联动**部分（`touch` 的 `coActivateWith` 交叉强化不发生）。**`touch` 自身的 `growStability` 加固不受影响**（那是 v1.0 既有行为） | 同上              |
| `ARCHIVAL_CACHE` | true | `countArchived()` 退回逐行精筛（§9.4）                                                                                       | 同上              |

> ⚠️ **基线组全关时（四布尔开关 + `VECTOR_ROUTER='flat'`），库的行为与 v1.0 逐位一致**（同一 DB 副本、同一注入时钟下，  
> `write` / `recall` / `touch` / `get` / `stats` 的可观测输出完全相同）。  
> **这是本次重构唯一的「没顺手改坏别的东西」的证明手段**（ADR-21）。  
> ⚠️ `ARCHIVAL_CACHE` 也必须纳入基线组：虽然它的**结果**与逐行精筛逐位相同，  
> 但**实现路径不同**——不纳入的话，「逐位一致」这句话在字面上就不成立。

> ⚠️ **参数总数：29（v1.0）→ 60（v2.1）**。新增 31 项（其中 5 项是机制开关）。
> ★ **验收断言（QA 的 G26）**：**本表与 `DEFAULT_PARAMS` 必须逐键逐值相等**
>   （键集合相同、值相同、默认值相同）。
>   ⇒ 「§5 是写给人看的表、`DEFAULT_PARAMS` 是代码里的真相」——
>   两边不一致时**实现者照哪边写都行**，而这类漂移**极难在实现期被发现**
>   （参数名对、值不同 ⇒ 行为不同但无报错）。
>   ⇒ **每次改参数必须同时改两处，并由上面这条断言守住**。  
> 数量本身不是问题，但**它们分属四种性质**：
>
> - **行为语义参数**（共激活 **10** 项、涌现簇 5 项、侧抑制 1 项）：改动会改变库的**拓扑与召回行为**，  
>   属于 ADR 级别的变更，须走 §13 的决策记录。  
>   ⚠️ 共激活是 **10** 项（不是 9）：`COACT_AFFINITY_MAX` / `COACT_AFFINITY_MIN` /
>   `COACT_REINFORCE_STEP` / `COACT_CAUSAL_BONUS` / `COACT_STABILITY` / `COACT_MIN_ENTITIES` /
>   `COACT_MIN_COS` / `COACT_MAX_PAIRS_PER_TOUCH` / `COACT_BATCH_MAX`
>   + **第十项 `COACT_DEGREE_MAX`**（度数上限，表尾单独一行）——  
>   ⇒ 分类声明原写「共激活 9 项」与表内实际对不上，已更正为 10。
> - **性能参数**（分桶路由 7 项 + 簇跳 1 项 + **向量路阈值 1 项 = `ROUTER_MIN_TRAINING`** = **9**）：只影响延迟与召回率，不改变语义，可在运行期调整。  
>   ⚠️ **「向量路」只算 `ROUTER_MIN_TRAINING` 一项**——`VECTOR_ROUTER` 归**机制开关**（它是一个三值选择器，「机制有没有」的语义），  
>   **两处都数它 ⇒ 四类相加会得到 61**，与 §6 的 60 个键对不上。  
> - **运维参数**（`ARCHIVAL_ORPHAN_CHECK` 1 项）：影响宿主调度各类维护动作的频率与开销。  
> - **机制开关（5 项：4 个布尔 + 1 个三值选择器 `VECTOR_ROUTER`）**：只切换机制的有无，不改变任何参数语义。  
>
> ⇒ **四类相加 = 行为语义 16 + 性能 9 + 运维 1 + 机制开关 5 = 新增 31 项**；  
>   **29（v1.0 继承）+ 31（v2.0 新增）= 60** ✓（与行 3457「29 → 60」与 §12 的「29 → 60 项」一致）。

> ⚠️ **跨参数校验**（`setParams()` 在写入前**全量**校验，任一不满足即抛 `INVALID_INPUT`  
> 且**一个参数都不落库**；实现形状必须是「先全量校验 → 再单事务写入 → 同事务记 `config` 事件」）：
>
> 1. `0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN`（0.90 ≤ 0.92 ✓）——**方向是 `≤` 不是 `<`**：  
>    若要求严格小于，参数空间会塌缩到 (0.90, 0.92)，不到 0.02 的宽区间，  
>    任何一次调参都可能落进非法区直接抛错。
> 2. ★ **`COACT_AFFINITY_MAX > COACT_REINFORCE_STEP + COACT_CAUSAL_BONUS`**（默认 1.0 > 0.45 ✓）
>   —— §4.11.4 ② 的 `Δ = base × (1 − a_old / MAX)` 在 `a_old = 0` 时 `Δ = base`；
>   若 `MAX ≤ base` ⇒ `min(MAX, a_old+Δ)` 在**第一次强化就顶格**：
>   亲和度谱塌缩（所有对一步到 MAX ⇒ 全部 ≥ `COACT_AFFINITY_MIN` ⇒ 图上全连通 ⇒ 巨型簇风险，
>   §4.12.4 ① 的一级成因），**且不报错**。
>   ⚠️ 边界要往前推一格：**`MAX == base` 也会顶格** ⇒ **必须是严格大于**。
>   —— 附带好处：保证 §4.11.4 的结构断言在合法参数下不被钳制打断。
> 3. ★ **`COACT_REINFORCE_STEP ≥ COACT_AFFINITY_MIN`**（默认 0.20 ≥ 0.15 ✓）
>    —— ⇒ **单次共现即成边** ⇒ 簇 = 原始共激活图的连通分量 ⇒ 巨型簇风险
>    （§4.12.4 ① 的一级成因）。★ 默认参数**就是**「单次共现成边」（有意取舍），
>    但必须写成可检的关系 ⇒ **调 MIN 时必须同步知道这条**。
> 4. `COACT_MIN_ENTITIES >= 1`、`COACT_MIN_COS ∈ (0, 1]`。
> 5. `COACT_MAX_PAIRS_PER_TOUCH >= 1`、`COACT_BATCH_MAX >= 1`。
> 6. `ROUTER_NPROBE_COARSE ≥ 1` 且 `ROUTER_NPROBE_FINE ≥ 1`——探针数为 0 会让向量路恒空。
> 7. `ROUTER_COARSE_CENTERS ≥ ROUTER_NPROBE_COARSE` 且 `ROUTER_FINE_CENTERS ≥ ROUTER_NPROBE_FINE`——
>    探针数不得大于中心数。写入路径的两个探针数同理。
> 8. `COACT_AFFINITY_MAX = 1.0` 与 §3 的 CHECK 约束**必须同步**；
>    改动这个上界要同时改 DDL，否则应用层钳制与库层约束不一致。
>
> ⚠️ **本清单共 8 条**（原文本此处把第 2 条与第 3 条各写了两遍，编号出现「2、2、3、3」，
> 而 §12 引用的是「12 条」——**正文与引用对不上**）。已去重并改为连续编号 **1~8**，
> §12 的引用同步改为 **8 条**。
> ⇒ **「条数」是会被交叉引用与断言的量**：清单增删必须同步改引用处的数字
> （与 §12 方法覆盖表同一条纪律，C25）。
>
> ⚠️ **故意不做的联动校验**：`COACT_MIN_COS` 与 `REDUNDANCY_COS` **不联动**——  
> 前者是「要不要建立关联」，后者是「要不要让位」，两个独立旋钮绑死会让其中一个失去调节余地  
> （§11.4 的前提正是「人能独立调旋钮」）。同理 `COACT_MIN_ENTITIES` 不与 `DEDUP_ENTITY_MIN` 联动。
>
> ⚠️ **校验失败时 `INVALID_INPUT` 的 `details` 必须带上建议值**：
>
> ```
> details = { REDUNDANCY_COS: { current: 0.90, maxAllowed: 0.85,
>                             reason: 'must be <= DEDUP_COS_MIN（抑制不得比合并更严）' } }
> ```
>
> 给出建议值省掉调用方自己算——而 `DEDUP_COS_MIN` 本身也是可调参数，  
> 合法上界会随它一起动。

> ⚠️ **五条互相咬合的耦合，调参时必须一起看**：  
> ① `COACT_MIN_COS` 与 `COACT_MIN_ENTITIES` 是巨型簇的一级成因：  
> 共激活图被限制在「语义相近 或 实体高度重叠」的邻域内 → 邻域内节点两两相连 → 形成团 → 巨型簇。  
> 调低任一阈值 → 共激活边变密 → 巨型簇风险上升；调高 → 簇涌现密度下降（见 §0.2 的密度门槛）。  
> ② 簇的涌现密度与 `embeddedRatio` 直接耦合：  
> 语义路径要求双方都有 embedding ⇒ `embeddedRatio` 低的库上共激活边少 ⇒ 簇少、联想路产出低。  
> ⇒ ★ **排查指引：联想路/簇跳产出偏低时，先看 `stats().embeddedRatio`，  
> 不要去调簇的参数或阈值。**  
> ③ 三个簇参数是一组（§4.12.4 的职责表），只有 ① 单独存在时才有意义。  
> ④ `REDUNDANCY_COS` 与 `DEDUP_COS_MIN` 是一组，且顺序不可倒置。  
> ⑤ `COACT_MIN_COS` 与 `COACT_MIN_ENTITIES` 的下调会同时  
> ① 提高共激活建立率（好）② 降低簇涌现密度门槛（好）③ 增大巨型簇风险（坏）——三者同向联动，不能只调一个。


## 6. 接口设计（TypeScript 同步 API）

遵循 better-sqlite3 核心优势，采用**纯同步 API**，消除无意义的 `Promise` 开销与并发写锁争抢。MCP 或网络服务需要异步接口时在最外层自行包装。

```ts
export const DEFAULT_PARAMS = {
  MAX_STABILITY: 180,
  MAX_PIN_FACTOR: 5.0,        // 必须与 §3 schema 的 CHECK (pin_factor <= 5.0) 同步；
                              // 漏了这个键，§4.1 的 `factor <= MAX_PIN_FACTOR` 会与 undefined 比较恒为 false，
                              // 结果 pin() 对任何输入都抛 INVALID_INPUT
  THRESHOLD_L3: 0.7,
  THRESHOLD_L2: 0.3,
  ARCHIVE_LINE: 0.05,
  EDGE_STABILITY: 30,
  MAX_EDGE_WEIGHT: 3.0,
  INITIAL_STABILITY: 1.0,
  EMOTION_WEIGHT: 2.0,
  DIFFICULTY_BASE: 1.5,
  DIFFICULTY_SCALE: 0.5,
  DIFFICULTY_FIRST: 0.3,
  DIFFICULTY_NORMAL: 0.5,
  SPACING_CAP: 2.0,
  DEDUP_ENTITY_MIN: 2,
  DEDUP_COS_MIN: 0.92,        // 仅凭余弦即可判为同一事实的阈值（§4.9 步骤 3c）；与 DEDUP_ENTITY_MIN 是「或」的关系
  DEDUP_BOOST: 1.3,
  INITIAL_EDGE_WEIGHT: 0.8,
  EDGE_REINFORCE_STEP: 0.3,
  RECALL_TOP_N: 5,
  EMBED_DIM: 768,             // **只读参数**：setParams() 传入它抛 INVALID_INPUT，只在构造时生效。
                              // 它不是可调项——改维度等于全库旧向量作废，且同维度的换模型无法检测（§5）
  VECTOR_TOPK: 20,            // 向量路带进打分的候选数，与文本路 slice(0, 20) 对齐
  VECTOR_MIN_COS: 0.25,       // 低于此余弦不进候选（不是得 0 分，是根本不出现）
  ACTIVATION_DECAY: 0.2,
  ACTIVATION_MIN: 0.15,
  MAX_DIFFUSED_NODES: 20,     // 必须与 §4.7 的 diffused 取前 N 一致；漏了这个键，取前 N 会变成 undefined
  MAX_DIFFUSED_VISITS: 200,   // 扩散的边处理预算，语义见 §4.7（不是候选数）
  RECENCY_DECAY_DAYS: 14,
  SWEEP_BATCH_SIZE: 500,      // sweep() 的批次粒度：既是每条事务的分组大小，也是归档统计的游标步长

  // ── v2.0 新增：神经元交互（§4.11 / §4.13）──
  COACT_AFFINITY_MAX: 1.0,    // 共激活亲和度上限。必须与 §3 的 CHECK (affinity <= 1.0) 同步
  COACT_AFFINITY_MIN: 0.15,   // 共激活有效亲和度下限。一套阈值三处语义：
                               //   簇的边判定 / sweep() 的淘汰判据 / 「这一对还算不算一条关联」
  COACT_REINFORCE_STEP: 0.20,
  COACT_CAUSAL_BONUS: 0.25,
  COACT_STABILITY: 21,        // 时间常数 τ（天），半衰期 = 21×ln2 ≈ 14.6 天
  COACT_MIN_ENTITIES: 2,      // 只校验 >= 1，**不与 DEDUP_ENTITY_MIN 联动**（语义不同）
  COACT_MIN_COS: 0.50,
  COACT_MAX_PAIRS_PER_TOUCH: 20,
  COACT_BATCH_MAX: 256,       // 单次 touch 的 coActivateWith 条目数上限；超出抛 INVALID_INPUT，不静默截断
  CLUSTER_TOPK: 3,
  MAX_CLUSTER_SHARE: 0.5,     // 兜底切分的**触发阈值**（单簇占比），不是目标尺寸
  CLUSTER_MAX_FRACTION: 0.02, // 切分的**目标尺寸**（库规模的比例）
  CLUSTER_MEMBER_SAMPLE_MAX: 50, // 所有列出簇成员的操作的 LIMIT
  CLUSTER_RECALC_INTERVAL_MS: 3600000,
  REDUNDANCY_COS: 0.90,       // 校验 0 < REDUNDANCY_COS <= DEDUP_COS_MIN

  // ── v2.0 新增：分桶路由（§4.15）──
  ROUTER_COARSE_CENTERS: 200,
  ROUTER_FINE_CENTERS: 10000,
  ROUTER_NPROBE_COARSE: 20,    // 粗层探查桶数；召回损失的唯一来源（§4.15.4）
  ROUTER_NPROBE_FINE: 50,      // 细层探查桶数
  ROUTER_BUCKET_MAX: 300,      // 桶内成员数 P95 上限，超过触发全量重训
  ROUTER_NPROBE_WRITE_COARSE: 8, // 写入去重路径的粗层探查桶数（§4.9 步骤 3a2）
  ROUTER_NPROBE_WRITE_FINE: 20,  // 写入去重路径的细层探查桶数（候选面 ≤ 召回路径）
  COACT_DEGREE_MAX: 32,         // 单条记忆的共激活邻居数上限（度数爆炸的唯一闸门）
  ROUTER_MIN_TRAINING: 10000,   // 建分桶的最小库规模；低于它走 flat（设计内行为，非故障）
  VECTOR_ROUTER: 'auto',        // 第五个机制开关（三值选择器）：'auto'（**默认**，按 ROUTER_MIN_TRAINING 自动选：
                                 //   低于门槛 → flat，达到 → 建桶）/ 'ivf'（**强制**两级分桶，即使低于门槛也照建桶 + 记 warn）/
                                 //   'flat'（**强制**全表精确，v1.0 做法）
                                 //   ★ 切到 'flat' 才能做「与 v1.0 逐位一致」这条基线断言（ADR-21）；
                                 //     ⚠️ 'auto' **不构成**基线条件（它的实际走向随库规模变，见下方基线条件注记）
  CLUSTER_BONUS: 0.40,           // 簇跳进入 diffused 的加成系数（§4.14.3）
  ARCHIVAL_ORPHAN_CHECK: 1000, // 归档缓存一致性抽样条数（§9.4.4）

  // ── v2.0 新增：机制级开关（ADR-21）── ★ **基线条件（完整）**：「与 v1.0 逐位一致」= **四个布尔开关全关** + **`VECTOR_ROUTER='flat'`**（三值选择器 ⇒ 只能说「设为 flat」，不能「关闭」）+ `ARCHIVAL_CACHE` 任意（关掉 = 走慢路但结果相同） ⚠️ **`'auto'` 不构成基线条件**（它的实际走向随库规模变） ⚠️ **默认 `VECTOR_ROUTER='auto'` ⇒ 默认配置下「四开关全关」并不等于 v1.0 行为** |
  // 四个开关全为 false 时，库的行为与 v1.0 逐位一致。
  // ⚠️ 这四个键是**小写**的：它们不是业务参数，是「机制有没有」的开关。
  //    小写是刻意的——避免被误当成可调业务参数写进参数表与跨参数校验。
  coactivation: true,          // 关：touch 不写 coacts；联想路与簇跳不执行；簇不计算
  inhibition: true,            // 关：无侧抑制，直接按 base 分取 topN
  writeBack: true,             // 关：关闭「扩散唤起 → 采纳 → 回写」的联动（growStability 不受影响）
  ARCHIVAL_CACHE: true,        // 关：countArchived() 退回逐行精筛（§9.4）
};

export interface MemoryConfig {
  dbPath: string;
  readonly?: boolean;
  params?: Partial<typeof DEFAULT_PARAMS>;
  /** 可选的**同步**向量函数：给了它，write / recall 不传向量时由库现算（§4.6 步骤 2c）。
   *  **必须同步**——本库全同步（ADR-5）。远程 embedding 请调用方先取好，再用
   *  `WriteInput.embedding` / `RecallOptions.queryEmbedding` 传进来。
   *  库自身不读环境变量、不发起网络请求、不内置任何模型（ADR-10）。
   *  返回值的校验与归一化由库统一做（§4.9 步骤 2），embedder 自己不用管。 */
  embedder?: (text: string) => number[];
}

export interface WriteInput {
  content: string;
  embedding?: number[];                        // 语义向量，长度必须 == EMBED_DIM。不传则用 MemoryConfig.embedder
                                               //   现算；两者都没有 → 该记忆 embedding 为 NULL（不进向量路）。
                                               //   库负责校验与 L2 归一化（§4.9 步骤 2）；维度不符/含 NaN/全零
                                               //   一律抛 INVALID_INPUT，**不截断不补零**（ADR-10）
  kind?: 'fact' | 'event' | 'preference' | 'thought' | 'topic';
                                               //   ⚠️ 不在枚举 ⇒ **INVALID_INPUT**（`details.reason = 'kind'`）
                                               //     （§3 的库层 CHECK 会拒，但那样会漏裸 SQLite 错误码给调用方 ⇒ §11.2）
  entities?: string[];                         // 实体名列表（可为主名或别名，内部按 §4.9 步骤 1 归一到 canonical）
  entityAliases?: Array<{ name: string; aliases: string[] }>;
                                               // 显式声明「某个实体有哪些别名」：`name` 按 §4.9 步骤 1 解析出
                                               // entity_id 后，把这些 aliases 挂到它名下（§4.9 步骤 1c）。
                                               // ⚠️ **别名目标实体「建、但不隐含关联」**（ADR-P1-T07-DEC D-3/R2）：
                                               //   目标实体**会被建出来**（或复用既有的），但**不会**因此与本条记忆
                                               //   建立关联 ⇒ 想让别名对召回生效，**必须**同时把该实体名写进 `entities`。
                                               //   ⇒ 这种情况下 `write()` 会回一条 **`ALIAS_TARGET_NOT_LINKED`** warning。
                                               //   ⚠️ 别名与已有映射冲突时**不覆盖**，改为在返回值 `warnings` 里报
                                               //   `ALIAS_CONFLICT` ——覆盖是 `setAlias` 的职责（§4.9.2），两处不能统一。
  emotion?: number;                            // 0.0 ~ 1.0；**越界 ⇒ 钳制到 [0, 1]，不抛错**
                                               //   （§4.3：`emotion = clamp(input.emotion ?? 0, 0, 1)`）
                                               //   ⚠️ 与下面的 `confidence` **刻意不同**（ADR-P1-T07-DEC D-7，
                                               //     主理人 2026-10-31 确认「不改实现，只在本文写明」）：
                                               //     `emotion` **没有**库层 CHECK ⇒ 钳制是它的既定语义；
                                               //     `confidence` **有**库层 CHECK ⇒ 越界只能抛错、不能钳制。
  mediaRef?: string;
  mediaType?: 'image' | 'audio' | 'video';     // 与 mediaRef 必须同时给或同时不给（§3 的 media_type 允许 NULL）
                                               //   ⚠️ 二者**只给一个** ⇒ **INVALID_INPUT**（`details.reason = 'media'`）；
                                               //     `mediaType` 不在枚举 ⇒ 同样 `INVALID_INPUT`（`details.reason = 'media'`）
                                               //   ⚠️ `details` 一律**平铺**（见 `confidence` 行的形状约定）
  source?: string;                             // 溯源元数据，仅存储与展示，不参与召回
  confidence?: number;                         // 0~1，缺省 0.7；通过 §4.3 影响 initialDifficulty
                                               //   ⚠️ 越界（含非有限数）⇒ **抛 INVALID_INPUT**（**不是钳制**，详见下）
                                               //   ⚠️ 与 `emotion` 的「越界由 §4.3 钳制」**刻意不同**（v2.1 勘误 / ADR-P1-T07-DEC D-7）：
                                               //   ① confidence **有**库层 CHECK（§3：`CHECK (confidence >= 0.0 AND confidence <= 1.0)`）
                                               //      ⇒ 不在应用层拦就会撞 CHECK ⇒ 裸的 SQLite 错误码穿给调用方（§11.2 禁止）；
                                               //   ② emotion **没有**库层 CHECK ⇒ 钳制是它的既定语义（§4.3）。
                                               //   ⚠️ 「不信任调用方」= **报错**，不是**替他改成合法**：
                                               //     钳制 confidence 会静默改写调用方的数据，而调用方以为自己写进去了。
                                               //   ⚠️ **details 的形状（ADR-P1-T07-DEC D-7）**：一律**平铺**
                                               //     `details.reason` = `'confidence'` / `'kind'` / `'media'`
                                               //     （与 §4.9 步骤 2 的向量校验同口径：`details.reason` = `'dim'`/`'nan'`/`'zero'`），
                                               //     并带 `details.current`（出错的入参值）与 `details.expected`（有意义的项才带）。
                                               //     ⇒ **不要写成嵌套的 `{ kind: { current, reason } }`**：
                                               //     本库的错误 details 一律平铺（`MemoryErrorDetails` = `Record<string, unknown>`），
                                               //     嵌套形状会让调用方要写两套取值逻辑（C36）。
  now?: number;                                // 可注入测试时钟
}

export interface RecallOptions {
  context: string;
  topN?: number;                               // 默认 5，内部限制 1~8
  queryEmbedding?: number[];                   // 查询向量，长度 == EMBED_DIM。不传则用 MemoryConfig.embedder
                                               //   对 context 现算；两者都没有 → 本次**不走向量路**
                                               //   （不是「向量分全 0」那种降级，见 §4.6 步骤 2c 与缺项规则）
  entityIds?: string[];                        // 已解析好的 canonical entity_id 列表；传入则跳过 §4.6 步骤 1 的**名称解析**
                                               //   ⚠️ 与 `entityNames` **互斥**：同时传 ⇒ 抛 INVALID_INPUT（§4.6 步骤 1）
                                               //   ⚠️ 传 [] = 「明确表示无实体」⇒ 图谱路转空（不是「没传」）
  entityNames?: string[];                      // ★ v2.1 新增：调用方抽好的实体**名**列表（ADR-2：实体抽取归调用方，库不内置 NER）
                                               //   库逐名调 `resolveEntity` 归一（别名消解）⇒ entity_id 集合 ⇒ 图谱路
                                               //   ⚠️ 与 `entityIds` **互斥**：同时传 ⇒ 抛 INVALID_INPUT
                                               //   ⚠️ 解析不到的名字（resolveEntity 返回 null）**不进图谱路**
                                               //     （它只参与文本路检索，§4.6 步骤 1）
                                               //   ⚠️ 与 `entityIds` **都不传** ⇒ 图谱路为空（退化为文本路 + 向量路，ADR-2 明写的代价）
  includeArchived?: boolean;                   // 默认 false；true 时召回包含归档层（intensity ≤ ARCHIVE_LINE），见 §4.4
                                               //   ⚠️ 归档模式下**不做强度精筛**（只保留 deleted = 0）——见 §4.6 步骤 2 的 includeArchived 参数化
  diffuseArchived?: boolean;                   // 默认 true；false 时 diffused 也过滤归档（R-ARCH-DIFF 的例外通道，见 §4.7）
  reinforce?: boolean;                         // 是否同步加固稳定度，默认 false。
                                               //   ⚠️ **只加固，不写共激活边**（§4.11.2 裁决）：
                                               //   它触发的内部路径**不建共激活边**——
                                               //   否则每次 reinforce 都把本次 top-N 焊成一个团，
                                               //   触发 §0.2 明令禁止的「topN 自我强化」。
                                               //   ⚠️ 它**仍计入** `stats().adoptedMemories`
                                               //   （它确实是调用方确认的采纳）——
                               //   ★ 已改用 `reason` 的第三个取值 `'reinforce'`（**不再有 `trigger` 键**：
                               //   两个名字装同一件事是本轮反复修的那类缺陷）。
  explain?: boolean;                           // 是否附带各项分值明细（供查看器与调试）
                                               //   ⚠️ **它同时会触发 recall 事件写入**（§4.6 步骤 4：
                                               //   仅当 explain === true 时记录）⇒ 常开 explain = 最高频操作
                                               //   每次写一条事件（**写放大**）。
  diagnostics?: boolean;                       // ★ v2.1 新增：**只要诊断数据，不要事件**。
                                               //   true ⇒ 返回 `explain` 块（routes / diffusion），
                                               //   但**不写 recall 事件**。
                                               //   ★ **为什么要单独开一个开关**：
                                               //   「为什么联想路是空的」是最高频的诊断需求，
                                               //   而为它常开 explain 会把写放大引进最高频路径。
                                               //   ⇒ **诊断的成本应当由「要不要事件」决定，而不是由「要不要数据」决定**。
                                               //   ⚠️ 与 `explain` 同为 true 时：以 `explain` 为准（含事件）。
  now?: number;
}
// 说明：不提供 source 过滤。source 是溯源元数据（记忆来自哪个会话/文档），
// 记忆库的核心价值是「跨来源统一召回」，按来源过滤会与其定位冲突；
// 如需在查看器中按来源浏览，直接在 UI 层用 SQL 筛选，不进入公开 API。

// 记忆的静态视图：只描述「这条记忆现在是什么样」，与任何一次检索无关
// ⚠️ 这里的字段必须覆盖 memories 表里**所有对外有意义的列**。少一个是「写进去了但读不出来」——
//    这类缺口不会报错，只会让某个能力在实现完成后悄悄不可用。
export interface MemoryView {
  id: string;
  content: string;                             // 原文（可能含全角/大写，与 content_tokens 不同构，见 §3）
  hasEmbedding: boolean;                       // 该记忆是否已有语义向量（§3 `embedding` 非空）。
                                               //   **刻意不返回向量本身**：768 维 Float32 会让一次 topN=5 的召回
                                               //   多背约 15KB，而调用方拿到它也做不了任何事——
                                               //   要回答「这条为什么没进向量路」，这一个布尔就够了。
  kind: 'fact' | 'event' | 'preference' | 'thought' | 'topic';
  layer: 'L3' | 'L2' | 'L1' | 'archived';
  intensity: number;
  stability: number;
  difficulty: number;                          // 0~1，越低越易强化。必须暴露：否则「这条为什么涨得慢」
                                               //   在查看器里无从解释——它直接决定 growStability 的倍率（§4.2）
  entities: string[];                          // canonical 实体名称（非 entity_id），供展示与调用方直接使用
  mediaRef: string | null;                     // 原始多模态文件指针（§3 media_ref）
  mediaType: 'image' | 'audio' | 'video' | null;// 与 mediaRef 同生同死：两者必须同时有值或同时为 null
  createdAt: number;
  lastAccess: number;
  accessCount: number;
  pinFactor: number;
  confidence: number;
  source: string | null;
  deleted: boolean;                             // 软删标记。get() 对软删记录**照常返回**（查看器列软删项、
                                                // restore 前置确认都需要），调用方靠此字段区分是否已在「遗忘」状态；
                                                // 已硬删的行不存在 → get() 返回 null
  deletedAt: number | null;                     // 软删时间戳；deleted = false 时恒为 null（§3 的状态一致性 CHECK 保证）。
                                                //   查看器要显示「何时被删」、sweep 的清理倒计时也依赖它
}

// 检索命中的记忆：在静态视图上叠加「本次检索」的评分
// 关键区分：score / breakdown 只对「某一次 recall」有意义，不属于记忆本身的属性
export interface Hit extends MemoryView {
  score: number;
  /** ★ v2.1 补齐（ADR-P1-T08-GAP-②）：本条记忆来自哪几路（§4.6 步骤 2.5 的三个来源标记）。
   *  ⚠️ **三个都是布尔，且不参与任何计算**——尤其**不参与 `graphProximity`**
   *    （那是 §4.6 步骤 3 按「实体交集」现算的，不是「被哪条路召回的」）。
   *  ⚠️ **至少有一个为 true**：能进候选集必然来自某一路。
   *  ⚠️ **per-hit 层 ≠ call 级层**：`fromVector`（这一条来自向量路吗）
   *    与 `explain.routes.vector.ran`（整条向量路本次跑没跑）是**两个层级**——
   *    单看 `from*` 区分不了「整条路缺席」与「这条路跑了但这条没进它的候选」（见 `breakdown.cos` 的缺项规则）。 */
  fromText: boolean;
  fromVector: boolean;
  fromGraph: boolean;
  breakdown?: {
    intensityPart: number;
    vectorPart: number;                        // 0.25 × vectorSim。本次无 queryVec 或该条无 embedding 时为 0
    textPart: number;
    graphPart: number;
    recencyPart: number;
    // v2.0 新增：侧抑制的**说明性**字段（不进求和、不参与 score，见 §4.13.1）
    suppression?: {
      clusterId: string | null;   // 触发的簇 id；无簇时为 null
      rankInCluster: number;      // 该候选在本簇内按 score 的名次（1 = 簇内最强）
      basis: 'cluster' | 'cluster-or-cosine';  // 判定依据；余弦不可用时退化为 'cluster'
    };
    rawBm25: number | null;                    // LIKE 单字兜底路、纯图谱命中、纯向量命中时为 null（见 §4.6 步骤 3）
    cos: number | null;                        // ★ **纯原始证据**职责：本次语义余弦。
                                               //   未走向量路或该条无 embedding 时为 null。
                                               //   ⚠️ **null 把三种语义压成一个值**，单看它**判定不了缺项**：
                                               //     ① 该条无 embedding（缺项）
                                               //     ② 本次整条向量路缺席（缺项）
                                               //     ③ **向量路跑了但这条没进它的候选（真实的 0 分，不是缺项）**
                                               //   ⇒ **缺项判定必须靠 `fromVector`（per-hit）+ `explain.routes.vector.ran`（call 级）**，
                                               //     **不能靠 cos**。
                                               //   ⚠️ **不要把「未走向量路 ⇒ cos 必须为 null」钉成契约**：
                                               //   §4.6 步骤 3 讲的是**打分项 `vectorSim`**（无 queryVec ⇒ 全体一律 **0**），
                                               //   §6 讲的是**原始证据 `cos`**（未走向量路 ⇒ null）——
                                               //   **两个不同字段、配套关系、不矛盾**。
                                               //   ⇒ **断言必须写成行为断言，不依赖任何字段的具体取值**：
                                               //     ① 未配 embedder ⇒ 面板显示「本次未执行向量路」
                                               //        （且**不得**显示「向量索引损坏」）
                                               //     ② 分桶未训练 ⇒ 显示「向量路不可用（分桶未训练）」
                                               //     ③ 已就绪但无候选 ⇒ 显示「本次无向量路候选」
                                               //        并**列出可能原因**，**不得**断言单一原因
                                               //   与 rawBm25 一样是**原始证据**，不是加权后的分项，
                                               //   explain 时两者都要给：0.25×cos 看不出「到底有多像」
  };
}

export interface RecallResult {
  hits: Hit[];
  /** v2.1 新增：**仅 `explain: true` 时给出** —— 本次调用的**级**诊断
   *  （与 `Hit.breakdown` 的 **hit 级**诊断相对）。
   *  ★ **为什么必须与 per-hit 的 `from*` 分开**：两者回答的是不同层级的问题。
   *    - `from*`（per-hit）：**这一条**是从哪几路来的
   *    - `explain.routes`（call 级）：**这一路**这次跑没跑、跑出了多少
   *  ⇒ 单看 `from*` **无法区分**「整条路缺席」与「这条路跑了但这条没进它的候选」——
   *    而这两者在打分语义上完全不同（缺项 vs 真实的 0 分）。
   *  ⇒ **成本≈0**：这些数在 §4.6 流水线里本来就有（每路的候选数组长度 / 扩散计数），
   *    只是此前没往结果里带。
   *  ⚠️ `routes.vector.ran` **≡ §4.6 步骤 4 的 recall 事件 payload 里的 `vectorUsed`**
   *    （两者都是「本次有没有 queryVec 且后端就绪」）；文档两处必须写明这个等同关系。 */
  explain?: {   // ★ **仅 `explain === true` 或 `diagnostics === true` 时给出**
    routes: {
      text:  { ran: boolean; candidates: number };   // ran=false = 本次文本路整体不执行
                                                     //   （§4.6 步骤 2a 的「单个拉丁字母/数字」分支）
      vector:{ ran: boolean; candidates: number };   // ran=false = 无 queryVec 或分桶未训练
      graph: { ran: boolean; candidates: number };   // ran=false = 本次没有解析出任何实体
    };
    /** `candidates` 口径写死**：各路在**精筛 + slice 之后**的候选条数，**去重前**。 */
    diffusion: {
      scanned: number;            // 本次处理的边数（§4.7 的 scanned）
      belowThreshold: number;     // 因 bonus < ACTIVATION_MIN 而**未产出候选**的边数
                                 //   ★ **> 0 就是「你的边过期了，请重新 link() 或 touch 保鲜」的确切信号**
                                 //   （§0.2 的 ~8.6 天窗口）。没有它，`diffused` 为空有四种原因
                                 //   （无边 / 边过期 / 种子不带实体 / 预算耗尽）而调用方**全部分辨不了**
                                 //   —— 那违反 §4.13.5「静默失效必须可归因」的纪律。
      skippedNoEntity: number;   // ★ **因「种子不带实体」而被跳过的扩散次数**（§4.7 的实体跳前提）。
                                 //   ⚠️ **不加这一位，「库里没有边」与「种子不带实体」两种情形的
                                 //   诊断签名完全相同**（都是 scanned=0 / belowThreshold=0 /
                                 //   budgetExhausted=false）⇒ 不可分 ⇒ 用户会「去 link() 了，
                                 //   但 link 完还是没联想」，因为真因是种子不带实体。
                                 //   ⇒ 这一位是**让两种情形可分**的最小充分信息。
      budgetExhausted: boolean;   // 是否因 MAX_DIFFUSED_VISITS 耗尽而提前停止
    };
  /** v2.0 新增：被侧抑制挤掉、但仍可查的候选。
   *  **默认返回**（不是可选字段）——调用方需要知道「有 N 条被挤掉了」，
   *  否则它无法区分「库里只有 3 条相关」与「有 5 条但 2 条被挤掉」。
   *  这两个是不同的产品事实，混起来会让调用方做出错误决策。 */
  suppressed: Array<{
    id: string;
    content: string;
    score: number;             // 被抑制前的 score（抑制不改分数，§4.13.1 硬约束①）
    layer: 'L3' | 'L2' | 'L1' | 'archived';
    redundantWith?: string;    // 与谁冗余（留在 hits 里的那条）
    redundancySim?: number;    // 该冗余对的相似度（0~1）
    reason: 'redundant';       // ★ 只有 'redundant' 一种：**溢出候选不收进 suppressed**
                               //   （它们根本没参与评估，没有合法的 redundantWith，
                               //    标成「被抑制」是语义污染——QA 抓过这个坑）
  }>;
  diffused: Array<{
    id: string;
    content: string;
    diffusionScore: number;
    layer: 'L3' | 'L2' | 'L1' | 'archived';    // 扩散不过滤归档，故可能为 'archived'（见 §4.7 R-ARCH-DIFF）
    viaEntity?: string;         // ★ **走哪条路被联想到的**：实体跳 ⇒ 触发它的实体名
                               //   ⚠️ **恰有一个有值**（`viaEntity` 与 `viaClusterId` 二选一）
                               //   —— 调用方要的是「**沿哪条路**」，不是「它挂了哪些实体」。
                               //   ★ **成本真≈0**：两者都是扩散循环里现成的值
                               //   （实体跳的 `neighbor_entity`、簇跳的 `cluster_id`）。
                               //   ⚠️ **不要用 `entities`**（它会诱使人做一次批量查询）：
                               //   §4.6 步骤 3 的那次批量查询是对**去重后的候选集**做的，
                               //   **覆盖不到 diffused 的成员** —— 那次成本论证是错的。
    viaClusterId?: string;      // ★ 簇跳 ⇒ 触发它的簇 id（与 viaEntity 二选一）
    seeds?: string[];          // v2.0：唤起它的 topN 命中 id 列表。
                               //   调用方据此构造 touch({coActivateWith})——
                               //   这是「哪条联想唤起了哪条」的**唯一可靠来源**（ADR-31 / ADR-32）
    // ↓ 以下为 memories 行上的静态列：扩散取邻居时**本就 SELECT 了该行** ⇒ 零额外 JOIN
    //   ⚠️ **刻意不含 `entities`**：它需 JOIN memory_entities，与 §4.7
    //   「不要用 entities（会诱使人做一次批量查询）」的成本纪律冲突 ⇒ 调用方按需单独查。
    kind: 'fact' | 'event' | 'preference' | 'thought' | 'topic';
    intensity: number;         // 当前强度（与 MemoryView 同源，便于调用方按强度取舍）
    stability: number;         // 稳定度（天）
    difficulty: number;
    confidence: number;
    createdAt: number;         // ★ 调用方可据此判断联想记忆的新旧
    source: string | null;     // ★ 来源标识（会话/文档/通道）
    hasEmbedding: boolean;     // 该条是否参与向量路（不是「是否有向量」而是「是否在向量路上有效」）
  }>;
  };   // ★ 关闭 explain（★ 缺这一行会使整个 §6 接口块不可解析：
        //   MemoryStats / WriteWarning / MemoryStore 会被整体嵌套进 explain 里）
}

export interface MemoryStats {
  // ── 规模与分布 ──
  total: number;              // deleted = 0 的记忆总数（占比由各项 / total 自行算，不重复存）
  l3Count: number;
  l2Count: number;
  l1Count: number;
  archivedCount: number;
  deletedCount: number;       // 软删未清理的条数，供 sweep 决策
  edgeCount: number;
  entityCount: number;

  // ── §11.4 承诺的调参观测指标（**8 项计数**（total / l3Count / l2Count / l1Count /
  //   archivedCount / deletedCount / edgeCount / entityCount）
  //   + **1 个观测块**（vectorBackend）
  //   + **11 项指标**（avgStability / medianStability / touchRate7d / mergeRate / graphDensity /
  //   adoptedMemories / embeddedRatio / archivalOrphans / archivalMismatch / archivalMissing /
  //   coactWriteDrops）
  //   = **20 个字段**；
  //   ⚠️ 本注释统计的是**字段**（20），与 §11.4 的「**9 项**」（指标**分组**）不是同一口径——
  //   两者都对，但**不可互相换算**（§11.4 的 1 组对应本注释的多个字段）。
  //   缺一项「人工调参」就少一个输入） ──
  vectorBackend?: {          // ★ v2.1 新增：**向量路的实现状态**（面板五态判定的唯一依据）
    mode: 'flat_explicit' | 'flat_auto' | 'ivf' | 'absent';
                              //   'flat_explicit' = **调用方显式选了 flat** ⇒ 面板说「已显式选择 flat」
                              //   'flat_auto'     = **库太小自动降级**（未过 ROUTER_MIN_TRAINING）
                              //                   ⇒ 面板说「库规模 < 1 万条，未建分桶」
                              //   'ivf'           = 走两级分桶
                              //   'absent'        = 已过门槛但**分桶不可用**
                              //   ⚠️ ★ **四值而不是「mode + flatReason」两个字段**：
                              //     两个字段 = 又一个「两份副本可能不一致」的新坑。
                              //   ⚠️ ★ **配置与状态不得共用同一套词**（C36）：
                              //     `VECTOR_ROUTER='flat'`（**要求**）与 `mode='flat_auto'`（**实际走的**）
                              //     语义不同 ⇒ 状态侧用**互不相同的字面量**。
    inRetrain: boolean;      // ★ **仅 `mode === 'absent'` 时有意义**：true = 正在重训；
                              //   false = 从未训练 / 训练失败。
                              //   ⚠️ **作用域写死**：`mode === 'flat_auto'` 时恒为 false
                              //   （flat 不建桶 ⇒ 没有重训这件事）。
                              //   ⇒ 面板的五态判定必须按这个作用域写，
                              //   否则小库会被误标成「正在重训」。
    coarseCells: number;     // 粗桶数
    fineCells: number;       // 细桶数
    members: number;         // 已入桶的记忆数
    maxBucketSize: number;   // ★ **展示量**（预计算）：最大的桶有多少成员 ⇒ 直接可比 ROUTER_BUCKET_MAX
    p95BucketSize: number;   // ★ **重训触发量**（预计算；面板**不展示**）—— P95 是分位数、max 是极值，
                              //   展示 P95 会让人误以为它是「典型的桶大小」
    centroidsUpdatedAt: number;  // MAX(vector_fine_cells.updated_at)
    count: number;           // 已建索引的向量条数
    dimensions: number;
    indexBytes?: number;     // ⚠️ **'flat' 模式下无意义**（没有独立索引文件）
                              //   ⇒ 面板 1 **不得**在 flat 模式下显示「向量索引占用」
  };                          // ★ 三态必须由**同一个内部函数**算出（§4.6 步骤 2c 的「缺席」判定与 stats() 共用）：
                              //   且 'ivf' 的依据是「**存在可用的细桶**」，**不是**「曾经调用过
                              //   rebuildVectorBuckets()」——后者在训练失败时会说谎。
  avgStability: number;       // 未删记忆的 stability 均值（天）
  medianStability: number;    // 中位数：均值会被少数 MAX_STABILITY 封顶项拉偏，故两个都给
  touchRate7d: number;        // 近 7 天 touch 次数 / 未删记忆数（衡量「召回是否真被采纳」）。
                              // ⚠️ **它与 `adoptedMemories` 不是冗余，是互补**：
                              //   · `adoptedMemories` = **累计**采纳面（`access_count > 0` ⇒ **单调不减**）
                              //   · `touchRate7d`     = **近期**采纳频率（**唯一会掉到 0 的那个**）
                              //   ⇒ **簇的失效由「最近没在用」驱动**（§4.11 的边权靠 touch 保鲜
                              //     ⇒ §0.2.1 ③：固定 touch 后停用，约 60 天覆盖率归零）
                              //   ⇒ **`touchRate7d` 是「这个库还活着吗」的唯一答案**。
                              //   ⇒ **面板两个都展示**（标签分清「累计」/「近期」）。
                              //   ⚠️ **不要因为「名字都像采纳率」就只留一个**：
                              //     只展示累计面 ⇒ 一个「累计 12,000 条、近 7 天 touch 率 0」的库
                              //     **看起来一片健康，实际已在簇归零的路上**。
  mergeRate: number;          // 近 7 天 merge 次数 / write 次数（过高 = 去重过激，过低 = 重复堆积）
  graphDensity: number;       // edgeCount / entityCount（图谱连通度，过低说明 link 没用起来）
  adoptedMemories: number;   // ★ v2.1 新增：**被采纳过**的未删记忆数（`access_count > 0`）。
                              //   §0.2 整节讲「采纳密度决定涌现能力」，却**没有工具测量调用方
                              //   离门槛有多远** ⇒ 这是产品级必加的观测口。
                              //   ⚠️ 口径（4 条计入路径，实现时必须全含）：
                              //     ① `touch(ids)` 显式采纳 ② `recall({reinforce:true})` 确认使用
                              //     ③ `write()` 命中完全重复（§4.9 步骤 2）
                              //     ④ `write()` 命中合并（§4.9 步骤 3c）
                              //   四者都是「调用方确认这条记忆被用上了」。
                              //   ⚠️ 它**不违反**「stats() 不混派生快照」的纪律（§4.12.4 ②）：
                              //   那条禁令针对**簇派生量**（要扫 coacts + 带 computedAt），
                              //   而触达分母**两条都不占**（不扫 coacts、是当前状态）。
  embeddedRatio: number;      // 有 embedding 的未删记忆 / 未删记忆总数。
                              //   这不是「健康度」，而是**能力覆盖率**：它低于 1 时，
                              //   那部分记忆在向量路上永久缺席、最高只能拿到 0.75 分（§4.6 步骤 3）。
                              //   看到它长期停在 0.6 就该去回填，而不是去调 VECTOR_MIN_COS

  // ── 归档缓存自检（§9.4.4 护栏① / §9.4.5 降级路径 / ADR-30）──
  // ⚠️ 这三个字段与 `verifyIntegrity()` 的同名字段**共用同一个实现**（口径不得分叉）。
  archivalOrphans: number;   // archival_schedule 中指向不存在 / 已软删记忆的行数 ⇒ **应恒为 0**
                              //   （§9.4.4 护栏①：孤儿行说明某条路径漏了 reindexArchive）
  archivalMismatch: number;  // schedule 存的 archive_at 与按公式重算值不一致的条数
                              //   ⇒ 不为 0 说明有路径漏调 reindexArchive（§9.4.3 的 9 个调用点漏了一个）
  archivalMissing: number | null; // 未删记忆中未出现在 archival_schedule 的条数
                              //   ⚠️ **ready=0（重索引进行中）时返回 null**（§9.4.5 降级路径），
                              //   此时该值无意义，调用方不得据此判故障
  coactWriteDrops: number;   // ★ **累计**被丢弃的共激活关联数 = Σ(截断数 + 无效种子跳过数)
                              //   （与 `touch()` 返回值的 truncated / skippedInvalidSeed 同源，
                              //    实现必须共用同一口径）
                              //   ⚠️ 它是**状态计数**，不是派生快照 ⇒ 不违反 §4.12.4 ②
                              //     「stats() 不混派生快照」的纪律（那条针对**簇派生量**）。
                              //   ⇒ **持续偏高 = 联想路在「边喂边漏」**，调用方据此发现漏记。
}

/** 非致命但调用方必须知道的事。目前两个来源都是 §4.9 步骤 1c 的别名处理。
 *  这类情形库**不覆盖**既有映射（覆盖是 setAlias 的职责），但绝不能静默——
 *  调用方若不看这个字段，会一直以为自己提供的别名归一已经生效。 */
export interface AliasConflictWarning {
  code: 'ALIAS_CONFLICT';   // alias 已指向另一个实体，本次映射未生效
  alias: string;            // 冲突的别名
  currentEntityId: string;  // 库里现在指向谁
  intendedEntityId: string; // 本次想指向谁（调用方若要改，请显式调 setAlias）
}

/** ★ `ALIAS_TARGET_NOT_LINKED`：别名目标实体**建好了**，但**没有**跟本条记忆建立关联。
 *  ⚠️ 为什么需要它（ADR-P1-T07-DEC D-3/R2）：「建但不隐含关联」是**有意**的边界
 *    （关联只由 `input.entities` 表达 ⇒ §14.3 边界原则 1），但它有代价：
 *    只声明 `entityAliases`、不点名实体 ⇒ 别名建好了、本条记忆却不与该实体关联
 *    ⇒ 图谱路查不到它 ⇒ **静默达不到召回目的**。
 *  ⇒ **边界可以存在，但必须可观测** ⇒ 这里回一条 warning（并按 §8.1 记一条磁盘日志）。
 *  ⚠️ 它**不是错误**：主体工作（写入这条记忆）已经做成 ⇒ 同样**不抛错**（§11.2 末）。 */
export interface AliasTargetNotLinkedWarning {
  code: 'ALIAS_TARGET_NOT_LINKED'; // 边界提示码（可辨识联合的判别键）
  name: string;                     // 调用方在 entityAliases[].name 里写的那个实体名
  entityId: string;                 // 该实体的 id（**已经建出来了**——只是没跟本条记忆关联）
}

/** `write()` 返回值里的 warning 集合（**可辨识联合** ⇒ 用 `code` 判别）。 */
export type WriteWarning = AliasConflictWarning | AliasTargetNotLinkedWarning;

/** `touch()` 的回执：本次「声明了但没写进去」的结构化归因。
 *  ★ 为什么需要它：共激活有两个**不抛错**的收敛点——
 *    ① 种子不存在 / 已软删 → 静默跳过（记 `coactSkipped`）；
 *    ② 超出 `COACT_MAX_PAIRS_PER_TOUCH` → 按数组顺序静默截断（记 `coactPairsTruncated`）。
 *    两者原先**只落进 events**，而同步调用方通常不消费 events 表 ⇒ 对它而言是**实质静默**：
 *    联想路会「边喂边漏」，长期长不出来却无感知。
 *  ⇒ 返回值把归因从事件级前移到 API 级；events 的既有语义**完全不变**（仍照记）。 */
export interface TouchResult {
  accepted: number;           // 实际写入的共激活对数
  truncated: number;          // 因 COACT_MAX_PAIRS_PER_TOUCH 上界被截断的对数（对应 coactPairsTruncated）
  skippedInvalidSeed: number; // 因种子无效 / 已软删被跳过的对数（对应 coactSkipped，reason='invalid_seed'）
  // ⚠️ **只覆盖这两个静默收敛点**；`COACT_BATCH_MAX` 超限是硬错 INVALID_INPUT，不进这里。
}

export class MemoryStore {
  constructor(config: MemoryConfig);

  // 基础操作（全同步）
  write(input: WriteInput): {
    id: string;
    merged: boolean;                            // 是否命中已有记忆（完全重复或近似合并）
    exact: boolean;                             // 是否完全重复（content_hash 相同）
                                                //   **这一个字段就够判断「我的输入入库了吗」**：
                                                //   exact === true  ⟺ 库内正文未被改写，调用方传的 content 没有入库；
                                                //   exact === false ⟺ 本次文本已成为库内正文（新建 / 近似合并）；
                                                //   新建路径恒为 false。不要另加同义字段。
    content: string;                            // 写入后库内该记忆的**实际正文**，可能与 input.content 不同
    warnings?: WriteWarning[];                  // 本次「想写但没写成」的事；缺省表示一切按预期落库
  };

  recall(options: RecallOptions): RecallResult;
  touch(ids: string[], now?: number, options?: {
    coActivateWith?: Array<{ memoryId: string; seedIds: string[]; activatedAt?: number }>;
  }): TouchResult;
                                    // 确认使用记忆后显式加固。
                                    // ★ options.coActivateWith 是**「与谁关联」的显式声明**：
                                    //   调用方说明「这条记忆是被哪个种子唤起的」，库据此写共激活边。
                                    //   库**不推断、不记账、不维护任何跨调用的状态**（无 ledger、无 LRU）——
                                    //   ledger 把因果归因到库无法确知的事上（ADR-31）。
                                    //   四条约束：
                                    //   ① coActivateWith[].memoryId 必须是 ids 的成员，否则 INVALID_INPUT；
                                    //   ② seedIds 不得包含**它自己那条**的 memoryId（自共激活），否则 INVALID_INPUT；
                                    //      ★ 但**允许** seedIds 与 ids 的其他成员相交——
                                    //        「A 唤起 B，A 与 B 也一并被采纳」是完全合法的；
                                    //   ③ 种子 id 不存在或已软删 → 跳过该种子，记入事件的 coactSkipped
                                    //      （reason='invalid_seed'），**不抛错**（种子被遗忘不该让整个 touch 失败）；
                                    //   ④ 条目数超 COACT_BATCH_MAX → INVALID_INPUT（**不静默截断**）。
                                    // ⚠️ **可信度声明**：coacts 表记录的是【调用方声明的关联】，
                                    //   不是【库观测到的关联】——库没有观测能力。
                                    //   这与 ADR-2（实体由调用方提供）、ADR-10（向量由调用方提供）完全同构。
                                    //   代价：coacts 的可信度上限 = 调用方声明的准确度。
                                    // ★ **返回值 = 本次「声明了但没写进去」的结构化回执**（§6 的 TouchResult）：
                                    //   上面 ③ 与「超出 COACT_MAX_PAIRS_PER_TOUCH 静默截断」是**两个不抛错的收敛点**，
                                    //   它们此前只落进 events（`coactSkipped` / `coactPairsTruncated`）——
                                    //   而同步调用方通常不消费 events 表 ⇒ 对它而言是**实质静默**。
                                    //   ⇒ 返回值把归因从「事件级」前移到「API 级」，不改变 events 的既有语义。
  link(
    subject: string, predicate: string, object: string,
    memoryId?: string, now?: number,
    options?: { createMissing?: boolean }     // 默认 true，与 write 自动建实体保持一致；false 则抛 NOT_FOUND
  ): void;
  linkByIds(subjectId: string, predicate: string, objectId: string, memoryId?: string, now?: number): void;
  pin(id: string, factor?: number): void;      // factor 缺省 2.0；必须为有限数且落在 [1.0, MAX_PIN_FACTOR]；
                                               // 越界抛 INVALID_INPUT（见 §4.1）；软删记录抛 NOT_FOUND
  unpin(id: string): void;
  forget(id: string, options?: {
    hard?: boolean;                 // true = 物理删除 memories 行；默认软删
    keepAuditContent?: boolean;     // true = 保留 events 中的正文（放弃「遗忘」承诺的彻底性）；默认 false
  }, now?: number): void;           // now 用于写 deleted_at；缺它则 sweep(cutoff) 无法用注入时钟测试
  get(id: string, now?: number): MemoryView | null;   // 单条读取无「本次检索」语境，故不返回 score/breakdown；
                                                      // 但 layer / intensity 是时间派生值，必须能注入 now。
                                                      // 软删记录照常返回（deleted=true），硬删返回 null
  restore(id: string, options?: {
    mergeInto?: string;             // 与未删记录撞 content_hash 时的目标记忆 id；不传则抛 CONFLICT（见 §4.8.1）
  }): void;                         // 撤销软删：deleted = 0, deleted_at = NULL；对已硬删记录抛 NOT_FOUND
  updateContent(id: string, newContent: string, now?: number, embedding?: number[]): void;
                                    // 显式纠正正文：绕过去重直接改写，不改 stability/last_access（见 §4.9.1）；
                                    // 要顺带加固请另外调 touch()。与 write() 的分工见该节末尾
                                    // ⚠️ embedding 不传 = 该记忆的向量被置 NULL（正文变了，旧向量失效）。
                                    //    这是刻意不做成默认值的行为：静默保留旧向量 = 向量指向已删内容

  // 实体维护（修复写入路径的静默跳过，见 §4.9.2）
  setAlias(alias: string, entityId: string): void;
                                    // 与 write 的 DO NOTHING 不同，这里是 DO UPDATE（显式意图必须生效）；
                                    // alias 撞任何既有 entities.name 则抛 CONFLICT
  mergeEntities(sourceId: string, targetId: string): void;
                                    // 合并重复实体：迁移 memory_entities / edges（权重取和）/ aliases，
                                    // 源实体主名降级为目标实体别名后删除源实体

  // 维护与统计
  setParams(patch: Partial<Omit<typeof DEFAULT_PARAMS, 'EMBED_DIM'>>): void;
                                    // 变更参数并记录 events(type='config') 的 from/to 快照。
                                    // **EMBED_DIM 被类型排除在 patch 之外**，运行期再兜一道：
                                    //   patch 里出现 EMBED_DIM 就抛 INVALID_INPUT。
                                    //   类型挡的是「误写」，运行期挡的是「JS 调用方绕过类型」——
                                    //   两层都要，因为漏了这一项的后果是**全库向量静默失效**（§5）。
  stats(now?: number): MemoryStats;
  sweep(options?: { purgeDeletedDays?: number; vacuum?: boolean }, now?: number
  ): { purged: number; archivedCount: number; coactPairsPurged: number };
                                    // ⚠️ **返回类型与 §8.4 的 sweep 事件 payload 必须一致**（§8.4 是唯一权威表）：
                                    //   `coactPairsPurged` = 本次淘汰的共激活边数（§4.10 步骤 1b）
                                    //   `archivedCount` = 归档数
                                    //   `purged` = 物理删除的记忆数
                                    // 【历史】以下为已作废的设计，仅供追溯：⚠️ `rebuildArchive` 与公开方法 `rebuildArchivalSchedule()`
                                    //   **两者取一，不要都做** —— 本版**不提供** `rebuildArchive` 选项，
                                    //   重建一律走公开方法（§9.4.4 护栏③），理由见 §9.4.4。
  // 维护方法（v2.1 新增）：**三个写方法**都是阻塞操作（1~3 分钟：`rebuildArchivalSchedule` / `rebuildVectorBuckets` / `recluster`），**MCP 不得暴露**；`verifyIntegrity` 是**纯读**（深检可能慢，但不阻塞写、不记事件）
  rebuildArchivalSchedule(options?: { batchSize?: number }): { scanned: number; repaired: number };
                                    // 重建归档缓存（§9.4.4 护栏③）。**写**事件：type='sweep', action='rebuildArchive'
  rebuildVectorBuckets(options?: { reason?: string }): { cells: number; members: number };
                                    // 重训两级分桶 + 全量重分配（§4.15.5）。**写**事件：action='rebuildBuckets'
                                    // ⚠️ **阻塞 1~3 分钟**；重训顺序必须遵守 §4.15.5 的三步硬约束
  recluster(now?: number): {
    clusterCount: number; largestClusterRatio: number;
    computed: boolean;          // ★ 本次**是否真的重算了**
    skipped: 'too_soon' | null; // ★ 非 null ⇒ 因距上次发布不足
                                   //   `CLUSTER_RECALC_INTERVAL_MS` 而跳过
  };                             // ⚠️ **跳过时 `clusterCount` 与真算出来「长得一样」**
                                   //   ⇒ 宿主必须靠 `computed` / `skipped` 区分，
                                   //   **不能靠 clusterCount 的值判断有没有重算**
                                    // 重算主题簇并发布快照（§4.12.3）。**写**事件：action='recluster'
                                    // ⚠️ 距上次发布不足 CLUSTER_RECALC_INTERVAL_MS ⇒ **跳过**（幂等返回，skipped=true）
                                    //   ⇒ 宿主任意频繁调用都不会触发阻塞（该参数是「两次发布之间的最小间隔」，
                                    //   **不是调度承诺** —— 不需要定时器，不违反 ADR-5 全同步）
  verifyIntegrity(options?: { deep?: boolean }): {
    archivalOrphans: number;    // ★ 与 `stats().archivalOrphans` **共用同一个实现**
    archivalMismatch: number;   // ★ 与 `stats().archivalMismatch` **共用同一个实现**
                               //   （§4.10 步骤 4 与 `stats()` 共用 `countArchived()` 是同款先例）
                               //   ⇒ **两处都放**：只放 `verifyIntegrity` 会让护栏①
                               //   从「常设」退化成「要主动调用才看得到」
    bucketCoverage: number;     // 已有向量且已入桶的记忆占比
    clusterSnapshotFreshness: number;   // 距上次簇发布过了多久
    edgesDiffusable: number;    // ★ **联想路健康度（库级）**：当前 bonus 仍 ≥ ACTIVATION_MIN 的边数。
                               //   ⇒ 与**本次调用级**的 `explain.diffusion.belowThreshold`
                               //   **对照**看：边总数够、但本次遇到的都过期了 ⇒
                               //   该重新 `link()` / `touch()` 保鲜（§0.2 的 ~8.6 天窗口）。
                               //   ⚠️ 它与 `clusters().explain.diffusion.*` **不同源**
                               //   （一个是库级存量、一个是本次增量）⇒ 不能相减。
  };                          // 一致性自检（**纯读，不记事件**）

  // 只读导航（v2.0 新增，全部纯读，不写库）
  clusters(options?: { minAffinity?: number; minSize?: number; limit?: number }, now?: number): {
    /* ★★★ v2.1 最终形态（许可研第十四批，唯一权威版，版本戳 a1c926fc）★★★ */
    // —— 顶层：两个口径，缺一都会误导 ——
    largestClusterRatio: number;   // 切分后：当前最大块占比（「现在有没有大簇」）
    maxRawComponentRatio: number; // ★ 切分前：**当前图**最大原始连通分量占比（「内容有多重复」）
                                  //   —— 当前量；落 cluster_snapshot_meta 一列
                                  //   ⚠️ 它与 §4.12.4 ③ 的**触发量同值但不同名**：
                                  //      触发量 = 本次重算过程中的中间量（内部，不具名）
                                  //      本字段 = 已发布快照的属性（对外）
                                  //      ⇒ **不可互相引用**（否则结构性耦合）
                                  //   ⚠️ 两个口径是同一份快照的两个切面，**不是两个时间点**
                                  //      （簇级 `splitInfo.at` 才是时间点）
                                  //   ⚠️ **两者不能互相推出**：切分后块的大小 ≠ 原始分量的大小
                                  //      ⇒ 面板必须同时展示

    clusters: Array<{
      key: string;                // 快照内标识 = 簇内最小成员 id（确定性，但**不是稳定标识**）
      clusterId: string;          // 持久簇 id（`key` 会变，它不会）
      originComponentId?: string; // ★ **簇级**（身份块，与 key/clusterId 同组）：快照内分组键
                                  //   ⇒ 「它们是不是同一块切出来的」的分组键。
                                  //   ⚠️ **不跨快照持久**（不是簇的持久标识）。
                                  //   ⇒ 未被切分的簇**也有**：它就是自己的一组 ⇒ **簇级能统一处理**；
                                  //     放进 splitInfo 里会让「没被切过的簇没有归组键」变成特例。
      label: string | null;       // 展示用代表词（可为 null）
      size: number;               // ★ **块级**：本块**当前活跃**成员数（`deleted = 0`，实时 COUNT）
                                  //   —— **气泡大小用它**。
                                  //   ⚠️ 与 `splitInfo.originSize`（切分前、含已软删）
                                  //     **不是同一集合**，不可直接相减 / 对比。
      memberIds: string[];        // ★ **必须带 LIMIT**：≤ `CLUSTER_MEMBER_SAMPLE_MAX`（默认 50）。
                                  //   ⚠️ 不带 LIMIT 就是 §4.12.4 ① 说的「唯一的输出风险」在这里破掉：
                                  //   一个 5 万成员的巨型簇会让调用方一次拿到 5 万个 id。
                                  //   排序键：**按有效 affinity 降序**，同值按 id 字典序升序
                                  //   （★ 必须与 §4.12.4 ① 完全一致 —— 两处写不同的排序键，
                                  //     实现者二选一 ⇒ 同一份数据两次查询给出不同顺序 ⇒ 不可复现）。
      representativeId: string;   // 代表记忆 = 簇内共激活度数最高的成员（并列按 id 升序）
      entities: string[];         // 簇内高频实体（最多 3 个）：频次降序、名称升序
      meanAffinity: number;
      maxAffinity: number;
      strength: number;           // 簇内边权之和（礁石高度）
      lastActive: number;
      splitInfo?: {               // ★ **簇级**：**这一簇**所属原始分量的来路（**不落表**，重算重现）
        originRatio: number;      //   那个原始分量的占比
        originSize: number;       //   那个原始分量的成员数（含已软删）
        blocksCount: number;     //   那次切分把它切成了几块（顶层无同名 ⇒ 无需改名）
        at: number;              //   那次切分的时刻
      };                          //   ⚠️ **不带 reason / threshold**：触发条件是常量
                                  //   （`MAX_CLUSTER_SHARE`）⇒ 面板直接写常量值；
                                  //   「切于 X」没有可靠来源（落单行表会被每次重算覆盖
                                  //   ⇒ 不可归因）⇒ **不做**。
                                  //   ★ 「曾发生过兜底切分」的历史事实**并不丢**：
                                  //     那次切出来的**每一块都自报 `originRatio=52%`** ⇒ 顶层再存一份是重复。
    }>;

    // ★ **没有 lastSplit、没有 splitPeak、没有顶层 blocksCount**
    //   事件元信息（何时 / 为什么 / 按什么阈值 / 切了几块）**归 §8.4 的事件与日志**
    //   （sweep 行的汇总 payload 已有 largestClusterRatioBeforeSplit / blocksAfterSplit）。
    //   ⇒ **诊断归日志，结构归 API**。

    asOf: number;                 // ★ **簇划分所依据的共激活图的时间点**。
                                  //   ⚠️ **两条路径下它不是同一个东西**：
                                  //     · **快照路径**（`minAffinity` 缺省或等于快照阈值）
                                  //       ⇒ = **已发布快照的 asOf**，**不是**传入的 `now`；
                                  //         且**此时传入的 `now` 被完全忽略且不报错**
                                  //         （静默失效——但这是**刻意**的：`now` 在这条路径上
                                  //         本来就没有意义，报错会打断正常的只读查询）。
                                  //     · **现场重算路径**（`minAffinity` 显式给了别的值）
                                  //       ⇒ = 传入的 `now`；⚠️ 此时 `clusterId` **不保证持久**。
                                  //   ⇒ **要知道快照有多旧看 `computedAt`；要知道簇划分依据哪个时刻看 `asOf`**。
    computedAt: number;           // 本次快照的生成时刻
                                  //   ⚠️ **它与 `asOf` 不是同一个东西**：`asOf` = **簇划分所依据的**
                                  //   共激活图的时间点（**T 时刻**）；`computedAt` = 本次快照的**生成时刻**
                                  //   （可能远晚于 T ⇒ 算得慢的库两者相差很大）。
                                  //   ⇒ 面板要答「簇有多旧」用 `stale` / `computedAt`；
                                  //     要答「簇划分依据哪一刻」用 `asOf`。
    algoVersion: number;          // 聚类算法版本；换算法必须递增
    stale: boolean;                // ★ 本快照是否已超过 `CLUSTER_RECALC_INTERVAL_MS` 未更新
    totalClusters: number;        // 满足条件的簇总数（未受 limit 截断）
    coveredMemories: number;      // **参与过共激活的记忆数**（出现在共激活边上的）
    adoptedMemories: number;      // ★ **被采纳过**的未删记忆数（`access_count > 0`）。
                                  //   ⚠️ 与 `stats().adoptedMemories` 是**同一个数、同一口径、同一实现**
                                  //     ⇒ **必须恒等** ⇒ 不要当成两个指标比较。
                                  //   ★ **调用方可直查 `coacts`** 拿「我声明过的边现在还在吗」
                                  //     （§8.4 规则 3）——**本版不新增公开查询方法**：
                                  //     嵌入式库，调用方可直查；`clusters()` 与 `stats()` **都不暴露**它
                                  //     （口径会随时间漂移）。
    totalMemories: number;        // 全库未删记忆数
    totalMembers: number;
    seedOnlyMemories: number;     // ★ **只当过唤起者、从未被采纳**的记忆数
                                  //   = coveredMemories 中不属于 adoptedMemories 的部分。
                                  //   ★ **唯一暴露的「切法」字段**（许可研定案）：
                                  //     需要被展示与解释的是它；
                                  //     分子 `covered ∩ adopted` 只是**算术部分**，**不设字段**。
                                  //   ⚠️ **措辞要准**：「被召回唤起却从未被采纳」容易被读反——
                                  //     它是**唤起者**（被声明为「谁唤起了谁」里的那个谁），
                                  //     自己却从未被采纳。**不是「它被召回了但没被用上」。**
                                  //   ⚠️ **它不是健康分**：调用方可能**正当地**把召回结果当上下文用、
                                  //     只 touch 事实而不 touch 上下文 ⇒ 这个数高**不必然是坏事**。
                                  //   ⇒ 文档与面板一律写成「**需要解释的信号**」，不是「越低越好」。
                                  //   ⇒ 恒等式（**派生式**）：
                                  //     coveredMemories == (coveredMemories − seedOnlyMemories) + seedOnlyMemories
    coverage: number;             // ① coveredMemories / totalMemories（**全库口径**）
    coverageOverAdopted: number;  // ② (coveredMemories − seedOnlyMemories) / adoptedMemories
                              //   ★ **分子是派生量，不是字段**：`coveredMemories − seedOnlyMemories`。
                              //     ⚠️ **不要写「分子与分母都用绝对数给出」**——分子**不是**字段，
                              //       它必须现算 ⇒ 面板 tooltip 要写「分子 = coveredMemories − seedOnlyMemories」。
                              //   ★ 与 `seedOnlyMemories` **同刻取数**（§0.2.2）：
                              //     两个数都叫覆盖率，调用方必然会拿它们对比 ⇒ **必须同刻**。
  };
                                    // ⚠️ **成本**：全表扫 coacts + union-find ⇒ 几百毫秒量级的显式调用，
                                    //   **不是 recall 的热路径组件**。
                                    // ⚠️ ★ **物化 / 现场重算的分流规则**（按 minAffinity 判）：
                                    //   minAffinity **缺省或等于快照阈值**
                                    //     → 读**已发布快照**：瞬时返回，但可能是旧的
                                    //   minAffinity **显式给了别的值**
                                    //     → **现场重算**：返回的一定是当前值，但
                                    //       ⚠️ **clusterId 不保证持久**（调用方自己认 key）
                                    //   ★ **为什么按阈值分流而不是按参数「是不是默认」分流**：
                                    //     「改阈值会改**结构**（哪些边成边、簇怎么分），不是改**过滤条件**」。
                                    //   ⇒ 换阈值 = 换一份快照 ⇒ 该走现场重算。
                                    //   ⚠️ **比对的是「快照自己记录的阈值」**
                                    //     （`cluster_snapshot_meta.min_affinity`），**不是常量 `COACT_AFFINITY_MIN`** ——
                                    //     否则「重算换了阈值而快照没换」时，分流会走错路径。
                                    //   ⚠️ **两处阈值不是同一个语义**：
                                    //     · 快照的 `min_affinity` = **该快照生成时**用的边阈值
                                    //     · 调用的 `minAffinity` = **调用方此刻**要的边阈值
                                    //     ⇒ 二者相等 ⇒ 读快照；不等 ⇒ 现场重算。
                                    //   ★ **minSize / limit 不得触发重算**（纯展示侧过滤，在快照上做即可）。
                                    //   ⚠️ **filter 不接受 id 白名单**（§4.6 步骤 0 的硬边界）：
                                    //     一旦允许传 id 集合，将来一定会有人把它接到文本路上——
                                    //     那正是「几何邻近否决词法精确」那件事。
  inhibitionTrace(context: string, options?: { now?: number }): {
    candidates: Array<{
      id: string;
      baseScore: number;          // 五因子分，逐位等于该候选的 Hit.score
      clusterId: string | null;    // 主题簇（**诊断上下文**，抑制不消费它，见 §4.13.2）
      redundantWith?: string;
      redundancySim?: number;
      inhibited: boolean;          // true = 被抑制机制挤掉（仍在候选集里，只是没进 topN）
    }>;
    selected: Array<{ id: string; baseScore: number }>;
  };
                                    // ★ 纯读：不写库、不写 events、不更新 last_access。
                                    // ⚠️ **唯一的例外：`explain === true` 时会经 `appendEvent()` 写一条
                                    //   `type='recall'` 事件**（§8.4）——这是**唯一**的写入路径。
                                    //   ⇒ 只读实例上由 `appendEvent()` 内部短路（跳过写入 + 记 warn，
                                    //     业务返回值照常，§7.1）⇒ **只读实例仍不写任何业务数据**。
                                    //   ⇒ 实现者不要以为 recall「绝不触碰写入路径」——
                                    //     它碰了，只是那一步在只读模式下会被拦下。
                                    // ★ 必须与 recall 走同一段打分代码——
                                    //   否则「trace 看到的」和「recall 实际发生的」会漂移。
                                    // ★ 结构刻意**不含 penalty / finalScore**：
                                    //   抑制是候选集级后置筛选，不改 score（§4.13.1 硬约束①）。

  close(): void;
}
````

---

## 7. 桌面查看器（Electron 只读观察器）

### 7.1 定位与安全

- **定位**：纯观察、可解释性与调参辅助工具。严禁修改业务数据。
- **只读架构保证**：
  1. 打开数据库句柄时严格声明 `{ readonly: true, fileMustExist: true }`。
  2. SQL 防护层仅放行 `SELECT / PRAGMA / EXPLAIN`。
  3. 核心计算复用纯函数算法模块（`decay.ts`, `scoring.ts`），绝不调用写操作代码。
  4. **`appendEvent()` 在只读实例上必须短路，而不是抛错**：  
     §7.2 的召回模拟器会调用 `recall({ explain: true })`，而按 §8.4 这条路径要写一条 `recall` 事件——  
     在 `readonly: true` 的句柄上执行必然抛 `SQLITE_READONLY`，界面直接白屏。  
     规则：`appendEvent()` 内部先判 `this.readonly`，为真则**跳过写入并记一条 warn 日志**（说明「只读模式下事件未落库」），  
     业务返回值照常给出。判断必须收在 `appendEvent()` 内部，不能让每个调用点各自记得判——  
     否则以后新增任何一个会记事件的方法都会重新踩一遍。  
     与之对照：**真正的写操作**仍然抛 `MemoryError.READONLY_VIOLATION`，不短路。  
     **完整清单**（§6 的 `MemoryStore` 共 24 个成员 = 23 个方法 + 构造函数；归类后 **16 写 + 7 读 + 1 构造**）：  
     ⚠️ `verifyIntegrity()` 是**读**方法（纯读、不记事件）—— 它是护栏报告，只读查看器要直接调它。  
     **写（16 个，一律抛 `READONLY_VIOLATION`）**——  
     `write` / `touch` / `link` / `linkByIds` / `forget` / `restore` / `pin` / `unpin` /  
     `setAlias` / `mergeEntities` / `updateContent` / `sweep` / `setParams` /  
     `rebuildArchivalSchedule` / `rebuildVectorBuckets` / `recluster`  
     ⚠️ **后三个是「阻塞 1~3 分钟」的维护方法**（§4.15.5 / §9.4.4）——  
     它们在只读句柄上同样抛 `READONLY_VIOLATION`，且**MCP 不得暴露**  
     （§12 阶段 5 的 MCP 最小集里没有它们）。  
     **读（7 个，允许）**——`recall` / `stats` / `get` / `close` / `clusters` / `inhibitionTrace` /  
     `verifyIntegrity`  
     （`close` 要 flush 日志、断开句柄，但它不写业务数据，只读实例必须能正常关闭。）  
     **构造（1 个）**——`constructor`：只读实例同样要走它，唯一额外要求是构造时那条 `config` 事件  
     按上面的短路规则跳过写入。  
     **不要用「等」字省略**：§4.10 的 `sweep` 自己也强调  
     「按入参动态决定这次算不算写操作会让行为随参数跳变」，那正说明只读拒绝必须**按方法**判定，  
     而不能靠调用方记得哪些参数算写。漏掉任何一个 = 它在只读实例上会真的写下去。

### 7.2 功能面板

1. **总览与层级分布**：  
   实时依据当前时刻 `now` 计算各记忆的 `intensity`，统计 L3 / L2 / L1 / 归档 的数量占比。  
   **同时显示向量覆盖率**（`stats().embeddedRatio`）：有多少条记忆还没有 embedding。  
   这一项必须摆在总览上，因为「无向量记忆最高只能得 0.75 分」（§4.6 步骤 3）是个**看不见的降权**——  
   覆盖率长期偏低时，用户会以为「召回不准」，实际上是根本没走向量路。
   - **★ 向量路块（向量路的可观测落点，不可省略）**：  
     渲染 `stats().vectorBackend.mode` + `stats().vectorBackend.inRetrain`，**按 §6 的四值枚举**，  
     措辞逐条固定（**不得自行归并或另造措辞**）：
     | `mode`                                                                    | `inRetrain` | 呈现措辞                               |
     | ------------------------------------------------------------------------- | ----------- | ---------------------------------- |
     | `flat_explicit`                                                           | —           | 「向量路：flat 模式（**已显式选择 flat**）」      |
     | `flat_auto`                                                               | —           | 「向量路：flat 模式（**库规模 < 1 万条，未建分桶**）」 |
     | `ivf`                                                                     | —           | 「向量路：ivf 模式（两级分桶）」                 |
     | `absent`                                                                  | `false`     | 「向量路不可用（**分桶未训练**）」                |
     | `absent`                                                                  | `true`      | 「向量路不可用（**分桶重训中**）」                |
     | ⚠️ **`mode === 'flat_auto'` 时 `inRetrain` 恒为 false**（flat 不建桶 ⇒ 没有重训这件事）， |             |                                    |
     | 面板不得据此把它标成「正在重训」（§6 已写死这个作用域）。                                            |             |                                    |
     | ⚠️ **`mode === 'absent'` 的两种取值都必须在总览上常驻可见**——                             |             |                                    |
     | 「向量路静默缺席不可观测」是本库明令禁止的失效模式（§0.2.3 ④ / §14.1）；                              |             |                                    |
     | **本块就是它的可观测落点**（§14.3 锚定检查的「向量路缺席」一行指向本块）。                                |             |                                    |
2. **记忆列表与单条详情**：
   - 查看记忆正文、关联实体、当前强度。
   - 渲染 **强度衰减曲线**：根据 `effectiveStability` 绘制指数曲线，直观展现跌出 L3、跌入归档的剩余时间。
3. **召回模拟器（Recall Simulator）**：
   - 输入模拟对话文本，调用 `recall({ explain: true, reinforce: false })`。
   - 给出各候选记忆的综合排名与打分明细柱状图（**五项**：活跃度 0.30 / 语义 0.25 / 文本 0.20 /  
     图谱 0.15 / 新近 0.10），并**并列显示原始证据** `rawBm25` 与 `cos`——  
     只看加权后的分项，无法判断「0.25×cos = 0.20」到底是「很像但权重低」还是「不太像但别项救回来了」。
   - ⚠️ **向量路要求一个 embedder，而只读查看器默认没有**：不配置 `embedder` 时，  
     模拟器本次**不走向量路**，明细里 `vectorPart` 恒为 0。此时界面必须显式标注  
     「本次未执行向量路」——否则用户会以为向量检索坏了，实际是没给它算向量的能力。  
     配置了 embedder 就照常走（§7.1 第 3 条禁止的是调写操作，不是禁用纯函数计算）。
   - **另列一栏「被抑制」**：把 `RecallResult.suppressed` 逐条列出（id、原始 `score`、  
     `redundantWith`、`redundancySim`）。⚠️ **不混进打分柱状图**——  
     混进去会让人以为「五项加起来不等于 score」；抑制不改分数（§4.13.1 硬约束①），  
     它是「谁没进 topN」的诊断信息，与「这条有多相关」是两类事实。
4. **图谱可视化**：  
   基于实体与 `edges` 渲染轻量级力导向关联图，展现两跳以内的知识结构。
   - **数据来源**：通过 §7.1 放行的 `SELECT` 读 `edges`（实体↔实体有向边，§3）与  
     `entities` / `memory_entities`，取两跳子图渲染；**不调 `link()`、不做任何写**。  
     ⚠️ §6 刻意不提供「读边图」的公开方法（图数据量随库规模增长，属查看器内部视图），  
     故本面板走 §7.1 规则②放行的原始 `SELECT`——与面板 6（版本历史）同一模式。  
     大图按 `LIMIT` 抽样，避免 worker 卡顿。
5. **只读日志查看（二级面板）**：  
   按年/月/日浏览操作流水，支持关键字高亮与分页滚动。
6. **版本历史（`content_history`）**：  
   ⚠️ **软删记忆在此面板仍可见旧正文**（`get()` 对软删照常返回，§6）⇒ 须标注  
   「**已遗忘（软删于 X），此处仍可见旧正文**」（§8.2），否则用户会以为「忘了怎么还在」。  
   单条详情下展开，按 `replaced_at` **逆序**列出该记忆的每一版旧正文，与当前正文并列对比，  
   并显示每版的来源（`reason`：`merge` 表示被 `write()` 采纳的新文本顶掉，`manual_fix` 表示被  
   `updateContent()` 人工改正）与替换时间。
   - 这是 §4.9「无条件采纳新文本」之后**旧版本的唯一查看入口**：`content_history` 不参与召回，  
     §6 也刻意不提供读取历史正文的公开方法（理由见 §4.9 说明块）。**面板缺了，那份兜底就不可达。**
   - 查询走 §7.1 已放行的 `SELECT`，用 `idx_ch_memory(memory_id, replaced_at)`；  
     分页取最近 50 版，更早的按需加载——历史上限不受控（§4.9 说明块已明示它会单调增长），  
     一次性全取会在被反复提及的记忆上卡住界面。
7. **主题簇导航（礁石图）**：  
   调用 §6 的 `clusters()`，把涌现出的簇画成气泡群：
   - 每个簇一个气泡，大小 = `size`，标注 = 簇内高频实体（`entities` 的前 3 个）；  
     点开展开成员列表（**顺序与 `clusters().memberIds` 完全一致**：按有效 affinity 降序、  
     同值按 id 字典序升序，见 §6 / §4.12.4 ①——**两处写不同的排序键会让成员列表不可复现**）与代表记忆正文。
   - **必须显示快照新鲜度**：依据 `clusters().computedAt` / `clusters().stale` 标注  
     「簇快照 X 前更新 / 已过期」——否则用户会把一份可能过期的划分当成当前事实（§6 的返回类型注释要求面板回答「簇有多旧」）。
   - **必须同时显示 `coverage` 与 `largestClusterRatio`**：前者告诉你「簇覆盖了多少记忆」，  
     后者告诉你「有没有一个簇吞掉了半个库」（§4.12.4）。⚠️ **巨型簇不隐藏**——  
     它是事实（用户确实在发大量近重复内容），藏起来比展示它更危险。
   - **簇成员列表必须带 LIMIT**（`CLUSTER_MEMBER_SAMPLE_MAX`，默认 50），  
     与 §4.12.4 的枚举上限一致。
   - ⚠️ **只读**：面板不提供任何写入口（§7.1 第 1、2 条仍然成立）。  
     「按簇召回」这类操作只能由调用方拿着 `entities` 自己去调 `recall()`，面板不代劳。
   - ⚠️ **簇的 `key` 不是稳定标识**：成员会随时间增减 ⇒ key 会变。  
     面板里的「最近两次快照对比」必须用**成员重叠度**，不能用 key。
   - **不放「回滚」按钮**：还原由人复制旧正文后显式调 `updateContent()` 完成。  
     面板若能一键回滚，就等于在只读观察器里开了一个写入口，直接违反 §7.1 第 1、2 条。

---

## 8. 操作日志与事件流体系

明确区分 **`events` 数据表** 与 **`logs/` 文本流水** 的职责：

| 维度        | `events` 数据库表                      | `logs/` 磁盘日志文件                          |
| --------- | ---------------------------------- | --------------------------------------- |
| **形态**    | 结构化 JSON 行记录                       | 纯文本追加流水                                 |
| **目标受众**  | 程序与重放引擎                            | 人类开发者与审计                                |
| **持久生命期** | 与业务库同生共死；**结构字段不可删，正文可脱敏**（见 §8.2） | 按日分文件，支持配置化归档                           |
| **记录时机**  | 在业务事务内同批 COMMIT                    | 事务提交后异步队列写入，失败仅告警（**error 级除外，见 §8.3**） |

### 7.3 状态与错误呈现

七个面板共享同一套状态约定（**不每面板各写一套**）：

| 状态        | 判定来源                                       | 呈现                                                                                                        |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 加载中       | 面板自身的异步调用                                  | 骨架屏 + 「计算中」（`clusters()` 的现场重算是**几百毫秒量级**，必须给反馈）                                                          |
| 库不可用      | `open()` 失败 / `readonly` 句柄异常              | 整页错误态 + 错误码（§11.2）                                                                                        |
| 只读模式      | `MemoryStore.readonly`                     | 顶部常驻「只读观察器」徽标；**不提供任何维护入口**                                                                               |
| 库调用阻塞     | —                                          | ⚠️ **库是全同步 API（ADR-5）**，一次 `recall()` / `clusters()` 会**阻塞 UI 线程** ⇒ **所有库调用必须在子进程 / worker 里执行**，界面只渲染结果 |
| **向量路状态** | `stats().vectorBackend.mode` + `inRetrain` | **总览常驻「向量路」块**，五值分措辞（§7.2 面板 1 的表）——**不得省略**：向量路静默缺席必须可观测                                                 |

★ **最后一条是硬要求**：全同步 API 放在主线程上，任何一次 200ms 的召回都会让窗口卡住 200ms；  
`clusters()` 的现场重算是**几百毫秒**，落在主线程上就是**面板点开即冻结**。  
⇒ **查看器的所有库调用都走子进程 / worker**（§7.2 面板 3 与面板 7 尤其如此）。

⚠️ **错误呈现原则**：面板**不得**把库的错误「翻译」成自己的措辞后只显示一句「加载失败」——  
必须显示**错误码 + `details`**（§11.2 的 `MemoryError.details`），  
否则用户无法区分「库里没有」与「查询错了」。

### 8.1 文本日志规范

- 目录：`<数据目录>/logs/<YYYY>/<MM>/<MM-DD>.log`
- 格式：`YYYY-MM-DD HH:mm:ss  <级别>  <动作>  键=值 ...`
  |   |   |   |
  | - | - | - |
- **级别**：`info` | `warn` | `error`。这一列不能省——§8.3 要求 `error` 级同步 flush、  
  `warn`/`info` 进异步队列，而「是不是 error 级」必须在**写出当下**就能判定；  
  只在正文里写一句「失败」而没有级别字段，分级写入无从实现，  
  事后也没法用一条 `grep ' error '` 把崩溃现场捞出来。  
  另：§7.1「只读模式下事件未落库」这类提示就是 `warn`，此前格式里没有任何位置能表达它。
- 规则：单次事件一行；值含有空格或特殊字符使用 URL 编码或规范转义；  
  **空值记 `-`，不省略键**（键本身是信息：`id=-` 表示「这条不关联记忆」，与「忘了记 id」是两件事）。
- **键值口径 = 该事件 `events` payload 去掉 `contentText`**：§8.4 已逐行规定每个 type 的 payload 键，  
  日志不再另立第二套字段清单——两份清单必然各自演化，最后没人说得清哪个准。  
  §8.2「正文永不进日志」也由此自动成立，不需要再单独维护。  
  例外只有 `错误`：它没有对应的 `events.type`，固定记 `op`（出错或被降级的动作）与 `err`（错误码或原因）；  
  它的级别可以是 `error`（操作真的失败了）或 `warn`（操作完成了但被降级——例如 §7.1 那个  
  「只读实例跳过事件写入」）。
- **嵌套值怎么拍平**（payload 里不全是标量，必须有确定规则，否则同一事件两个人写出两种日志）：
  | payload 里的值形态        | 日志里的写法                                     | 例                                   |
  | -------------------- | ------------------------------------------ | ----------------------------------- |
  | 标量（字符串 / 数字 / 布尔）    | `键=值`                                      | `id=8f2a` `boostApplied=true`       |
  | `null` / `undefined` | `键=-`                                      | `memoryId=-`                        |
  | **数组**               | `键=` 接**方括号内逗号分隔**，元素各自 URL 编码；空数组记 `键=[]` | `addedEntities=[e1,e2]` `hitIds=[]` |
  | **对象**               | **只记它的键集合**，不记值：`键={k1,k2}`；值为空的记 `键={}`   | `changed=[{key,from,to}]`           |
  - 数组元素若是对象，仍按「对象」规则记成 `{k1,k2}`，所以最坏形态是 `changed=[{key,from,to}]`  
    （`changed` 是 `Array<{key,from,to}>`，**方括号不能省**；`hitIds` 是纯字符串数组，  
    记 `hitIds=[id1,id2]`，不要因为名字带 s 就当成对象数组）。
  - **对象不记值是有意的**：§8.4 里对象形态的值全是「结构说明」而非业务数据  
    （`changed` 的 `from/to`、`scores[]` 的评分明细），逐值展开会让一行日志膨胀到不可读，  
    而这些明细在 `events.payload` 里随时可查——日志的职责是**让人一眼看到发生了什么**，  
    不是复刻 payload（§8.3「重放以 events 为准，logs/ 只作人类排障」正是这个分工）。
  - **唯一的例外是 `config` 事件的 `params`**：它是 **60** 项参数的**完整生效快照**（§8.4，与 §5 参数表逐项一致），  
    不是「结构说明」而是**业务数据**——`from/to` 只在 `setParams()` 时才有，  
    构造时的初始参数就靠 `params` 留痕。所以 `params` 逐项展开成 `params.MAX_STABILITY=180` 这种形式，  
    且它与 `changed` 分开记：`params` 是当前快照（可覆盖全量），`changed` 是本次差异。  
    —— 这也解释了为什么 §8.4 的 config 行把 `params` 列为**必带**：少了它，  
    建库时的非默认参数就再也无从复原（§8.4 该行的说明）。
- 动作枚举（**14 项 = §8.4 的 13 种 `events.type` 各对应一个 + 1 项无事件对应的 `错误`**）：

| 动作   | 对应 `events.type` | 动作     | 对应 `events.type`                    |
| ---- | ---------------- | ------ | ----------------------------------- |
| `写入` | `write`          | `遗忘`   | `forget`                            |
| `合并` | `merge`          | `建关系`  | `link`                              |
| `恢复` | `restore`        | `置顶`   | `pin`                               |
| `纠正` | `manual_fix`     | `取消置顶` | `unpin`                             |
| `别名` | `alias`          | `参数`   | `config`                            |
| `召回` | `recall`         | `清理`   | `sweep`                             |
| `加固` | `touch`          | `错误`   | 无（不进 `events`；级别取 `error` 或 `warn`） |

⚠️ 本枚举原先只有 9 项（`写入`/`合并`/`召回`/`加固`/`建关系`/`遗忘`/`参数`/`清理`/`错误`），  
而本节又声明「单次事件一行」——两者合起来的后果是 `restore` / `manual_fix` / `alias` / `pin` / `unpin`  
这 5 类操作在人类可读流水里**完全不出现**。其中 `restore` 把一条已遗忘的记忆复活、  
`mergeEntities` 把两个实体合并后删掉源实体，改的恰恰是事后最难复原的东西，  
却在 `logs/` 里查不到痕迹。动作名少一个，等于那类操作没有审计。

### 8.2 正文留存与「遗忘」的一致性（重要）

先分清三者的正文口径，否则下面这句话会读成自相矛盾：

- `logs/*.log`：**完全不写正文**，只有动作名与结构化键值。
- `events`：**结构字段不写正文**；唯一允许存正文的位置是 `payload.contentText` 这一个键（供重放），  
  且仅 `write` / `merge` / `manual_fix` 三类事件会写它。  
  （`merge` 的 `restore_merge` 变体属于例外：它不改写任何正文，故**不写**该键——见 §4.8.1 4e。  
  这是「允许写」与「本次是否需要写」两件事，不要据此认为存在第四类事件。）

因此正文**及其衍生物**只出现在下面这几处，它们与 `forget()` 的关系必须严格一致：

| 存储位置                         | 用途              | `forget({ hard: false })` 软删  | `forget({ hard: true })` 硬删    |
| ---------------------------- | --------------- | ----------------------------- | ------------------------------ |
| `memories.content`           | 主召回正文           | 保留（deleted=1 后不参与召回）          | **删除**（整行删除）                   |
| `memories.embedding`         | 语义向量，正文的**衍生物** | 保留（与 content 同生同死，restore 要用） | **随行删除**（整行删除，无单独的脱敏动作）        |
| `content_history.content`    | 合并历史版本          | 保留                            | **级联删除**（FK ON DELETE CASCADE） |
| `events.payload.contentText` | 重放用的正文快照        | 保留                            | **默认脱敏为 `"[redacted]"`**       |
| `logs/*.log`                 | 人类审计流水          | 从不写正文                         | 从不写正文                          |

**为什么向量必须跟着正文一起消失**（引入向量后新增的遗忘漏洞，必须堵）：  
向量不是「脱敏后可以留下的统计量」，它是正文的**充分近似**——  
同一段文字在同一模型下必然得到同一个向量，拿它能做「和这句话很像的还有哪些」，  
也就等于能把用户要求忘掉的事**重新捞回来**，甚至反推出大致内容。  
所以：硬删随行删除（删行即消失，不需要也不应该写单独的脱敏 SQL）；  
软删保留（它和 `content` 一样要支撑 `restore`）；  
**并且禁止任何「向量脱敏后保留做匿名统计」的优化**——那是给遗忘承诺开后门，  
开了之后全库没有任何一处会报错。

**payload 字段约定（所有 type 统一）**：

- 结构性字段（`id`、`targetId`、`type`、分数快照、`intervalDays`、实体 id 列表、  
  正文长度 `contentLength`、`contentHash`）**永久保留**——重放与调参只需要这些，不需要原文。
- 正文一律放在 `contentText` 键下，**且仅在确有必要时写入**（`write` / `manual_fix` / `merge` 三类，  
  其中 `merge` 只有 §4.9 步骤 3c 会写——§4.8.1 的 `restore_merge` 变体不改写正文，不写该键）。
- 其余事件（`restore` / `alias` / `recall` / `touch` / `forget` / `link` / `pin` / `unpin` / `sweep` / `config`）  
  **不得包含 `contentText`**——共 3 个 type 允许存正文，10 个不允许（合计 13），与 §8.4 的表逐行对齐。  
  ⚠️ 「允许写」与「本次是否需要写」是两件事：`merge` 这个 type 在 3c 路径写、`restore_merge` 路径不写，  
  两者的字段集见 §8.4 的 merge 行。**不要据此认为存在第四类事件。**

**`forget({ hard: true })` 的完整语义**（这是「遗忘」承诺的兑现点）：

实现见 **§4.8 步骤 ②③**，此处不重复写第二份 SQL——两处各写一份正是会出现「三种不同脱敏语句」的原因。  
一句话概括：删 `memories` 行（级联 `content_history`、触发器同步 FTS）→ 按 `events.memory_id` 索引把  
`payload.contentText` 置为 `"[redacted]"` → 追加一条 `forget` 事件记账。三步同一事务。

**明确的取舍声明**（避免实现者两边都想满足）：

- `events` 定位&#x4E3A;**「结构可审计 + 正文可脱敏」**&#x7684;系统记录，不是「不可删的完整审计」。
- 硬删后结构骨架仍在（知道「曾有过这条记忆、何时被删、当时强度多少」），但**无法还原原文**——  
  这正是用户说「忘掉」时应有的结果。
- 若业务确实需要完整审计（如合规留证），显式传 `keepAuditContent: true`，  
  此时必须在产品文案上**不说「已彻底删除」**，只承诺「不再参与任何召回」。

### 8.3 日志缓冲的退出与崩溃收尾

`logs/` 走异步队列，必须定义收尾行为，否则崩溃瞬间丢的恰好是出事前的那几行：

- **分级写入策略**：
  - `error` 级：**同步写入并 flush**（不受队列影响），保证崩溃现场可取证。
  - `warn` / `info`：进队列，批量追加。
- **队列参数**：最大缓冲 200 行或 1000ms，先到先触发 flush。
- **正常退出**：`close()` 必须先 `flushLogs()` 再关数据库句柄；顺序反了会丢掉最后一次写的日志。
  |   |   |   |   |
  | - | - | - | - |
- **进程级兜底**：注册 `process.on('exit' | 'SIGINT' | 'SIGTERM' | 'uncaughtException')`，  
  统一调用 `flushLogs()`（同步 `fs.writeSync`，不能用异步 API，否则退出前写不完）。
- **崩溃不可避免时的一致性**：`events` 表在事务内 COMMIT，**不受日志缓冲影响**；  
  即日志可能缺行，但事件流永远完整——所以「重放」以 `events` 为准，`logs/` 只作人类排障。

### 8.4 事件类型与发射点对照表（枚举必须逐个落地）

`events.type` 的每一个取值都必须有明确的发射位置，否则枚举里会出现「永远不会有记录」的死值。

| type         | 发射位置                                                                                  | `memory_id`               | 关键 payload 字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 含正文？                                    |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `write`      | §4.9 步骤 4（新建）                                                                         | = 新 id                    | `id, kind, contentText, contentLength, contentHash, entityIds, emotion, confidence, hasEmbedding, initialStability, initialDifficulty`                                                                                                                                                                                                                                                                                                                                                                                                                         | 是（`contentText`）                        |
| `merge`      | §4.9 步骤 3c（完整字段）／§4.8.1 步骤 4e（`restore_merge` 子集）                                     | = targetId                | 3c：`targetId, intervalDays, boostApplied, contentText, contentLength, contentHash, prevContentLength, addedEntities, hasEmbedding, stabilityDelta`；restore_merge：`targetId, addedEntities, mergedFrom, reason('restore_merge')`（**无** `intervalDays` / `boostApplied` / 正文四项——该路径不调 growStability、不改写正文，理由见 §4.8.1 4e）                                                                                                                                                                                                                                         | 3c 是（`contentText`）；restore_merge **否** |
| `restore`    | §4.8.1 步骤 2（无冲突恢复）                                                                    | = id                      | `id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 否                                       |
| `manual_fix` | §4.9.1 步骤 5（显式纠正正文）                                                                   | = id                      | `id, contentText, contentLength, contentHash, prevContentLength, hasEmbedding`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 是（`contentText`）                        |
| `alias`      | §4.9.2 `setAlias()` / `mergeEntities()`                                               | 无（涉实体而非记忆）                | `action('set'/'merge'), alias?, entityId?, prevEntityId?, sourceId?, targetId?, movedMemories?, mergedEdges?, droppedSelfLoops?, aliasAdded?`                                                                                                                                                                                                                                                                                                                                                                                                                  | 否                                       |
| `touch`      | §4.9 步骤 2（完全重复）、§4.2 的 `touch()`                                                      | = id                      | `id, reason('exact_repeat'/'explicit'/'reinforce'), intervalDays, boostApplied, edgesReinforced, addedEntities, embeddingAdded, stabilityDelta, coactPairs, coactPairsTruncated, activationWrites, coactSkipped`（`addedEntities` 仅 `'exact_repeat'` 恒有，无新增记 `[]`；`'explicit'` 无此键——两个发射点不同，见 §4.9 步骤 2。`embeddingAdded` 同理只在 `'exact_repeat'` 出现，取值 0/1。`edgesReinforced` **两个发射点都有**：该记忆作为证据被强化的边数，无则记 `0`，见 §4.5 规则 R-EDGE-TOUCH）                                                                                                                            | 否                                       |
| `recall`     | §4.6 步骤 4，**仅当 `explain === true` 时记录**（⚠️ `diagnostics: true` **不触发**本事件——它只取数据不写事件） | 无（涉及多条记忆，无法单值）            | `contextHash, topN, hitIds, scores[], includeArchived, diffuseArchived, vectorUsed, suppressedIds, diffusedSeeds`                                                                                                                                                                                                                                                                                                                                                                                                                                              | 否（只存 context 的 hash，不存原文）               |
| `link`       | §4.5 步骤 3（**每次 link 都记**，不只在自动建实体时）                                                   | 可选（= payload.memoryId，若有） | `subjectId, predicate, objectId, memoryId, weightAfter, autoCreatedEntities`（后者无新建时为 `[]`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 否                                       |
| `pin`        | `pin()` 成功后                                                                           | = id                      | `id, factor, prevFactor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 否                                       |
| `unpin`      | `unpin()` 成功后                                                                         | = id                      | `id, prevFactor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 否                                       |
| `forget`     | §4.8（软删步骤／硬删步骤 ③）                                                                     | = id                      | `id, hard`；`hard: true` 时另有 `auditContentRetained`（软删**不带**此键——该字段只在硬删时才有意义，见 §4.8）                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否                                       |
| `sweep`      | §4.10 步骤 1（每条清理）+ 步骤 4（整次汇总）                                                          | = id（逐条）；**汇总事件填无**       | 逐条：`id, reason('purge_deleted'), deletedAt`；**汇总（★ 全库唯一权威口径，§4.10 步骤 4 与 §4.12.4 ② 都以它为准）**：`action('purge'\|'rebuildArchive'\|'rebuildBuckets'\|'recluster'), purged, archivedCount, vacuumed, coactPairsActive, coactPairsPurged, clusterCount, largestClusterRatio, largestClusterRatioBeforeSplit, blocksAfterSplit` —— ★ `action` 用**同一个 events.type** 区分四个维护动作（**不新增 events.type**，符合 ADR-15 —— SQLite 的 CHECK 无法 ALTER，新增 type 要重建 events 表 + 重建全部索引与触发器）。`memory_id` 一律填 null（这些动作不针对单条记忆）。（`vacuumed` = 实际是否执行了 VACUUM，**不是入参回显**——`purged = 0` 时会跳过） | 否                                       |
| `config`     | `MemoryStore` 构造或 `setParams()` 时                                                     | 无                         | 两者都必带 `SCHEMA_VERSION, params`（**变更后的完整生效参数**）；`setParams()` 另有 `changed: Array<{ key, from, to }>`，构造时**不带** `changed`（没有变更）                                                                                                                                                                                                                                                                                                                                                                                                                                  | 否                                       |

> ★ **`alias` 行的字段类型约定**（v2.1 勘误补齐；**上表只列键名，类型在此补齐**——
> ⚠️ **不要把类型标注写进上表第 4 列**：`scripts/check-payload-keys.ts` 从那一列解析键集，
> `aliasAdded?(boolean)` 这类写法会被解析器判成「不是键」⇒ 门禁会误报「代码有而 §8.4 没有」）：
>
> - `action`：`'set'` / `'merge'`；
> - `alias`（**字符串**）：`action='set'` ⇒ 被设置的别名名；`action='merge'` ⇒ **被降级为别名的源实体主名**；
> - `aliasAdded`（**布尔**）：本次是否新增/改写了一条「别名 → 实体」映射。
>   `action='merge'` 恒为 `true`（源主名必然被降级为目标的别名）；`action='set'` **不带**此键；
> - `entityId` / `prevEntityId` / `sourceId` / `targetId`（**字符串**）：实体 id；
> - `movedMemories`（**整数**）：迁移的记忆关联条数（**全部**迁走的行，含目标本来就有的那些）；
> - `mergedEdges`（**整数**）：**因三元组冲突而被折叠掉的边数**（只数冲突那一支，不数仅改指的边）；
> - `droppedSelfLoops`（**整数**）：合并后被清掉的自环条数。
>
> ⚠️ 三个计数的**口径互不相同**（§4.9.2 步骤 1 / 2 / 2b），
> 抄写时不要用「迁移了几条」去填 `mergedEdges`（它数的是「合并掉了几条」）。

**六条硬规则**（编号 1~6 即全文引用的唯一口径——`DEVELOPMENT-PLAN.md` 与 `src/` 里的「§8.4 硬规则 N」都指这里）：

1. **`recall` 默认不记录**——召回是最高频操作，逐次写事件会造成严重的写放大（每次 recall 都追加一行，  
   一天几千次就撑爆事件流）。只在 `explain: true`（调试/查看器场景）时记录，且只存 `contextHash` 不存原文。
2. **`config` 必须记录**——参数变更会改变所有历史数据的解读方式，不记录则「可完整重放」在第 0 步就断了。  
   每次参数变更记一条含 `from/to` 的快照，回滚就是把相关 key 改回去并再记一条。  
   **`params` 恒有、`changed` 只在 `setParams()` 时有**，原因：`MemoryConfig.params` 允许调用方  
   建库时就传非默认值，而构造那一刻「没有变更」——只记 `changed: []` 等于把第 0 步的参数留白，  
   重放时只能拿 `DEFAULT_PARAMS` 反推，推出来的与实际生效值可能不同，而且不会报错。  
   所以重放读的字段是 `params`（完整快照），`changed` 只供人看「这次动了哪几个」。
3. **v2.0 新增的四个键只在 `touch()` 的显式发射点出现，`exact_repeat` 路径不出现**：  
   `coactPairs`（本次写入的共激活对，每项 `{a, b, affinityAfter}`）、`coactPairsTruncated`（因三种上界中最小者  
   而丢弃的对数，0 = 没截断）、`activationWrites`（扩散唤起且被采纳的因果写入，每项  
   `{diffusedId, seedId, affinityAfter, activatedAt}`）、`coactSkipped`（因日守卫或种子无效而**未写入**的关联，  
   每项 `{a, b, reason, hadActivationEvidence}`）。  
   ★ **`coactSkipped` 的意义是「因果证据从不静默丢失」**：一条关联要么体现在 `affinity` 上，  
   要么出现在 `coactSkipped` 里——两者都没有才是 bug。  
   ★ **旧事件重放**：v1.0 的历史事件里这四个键**不存在** ⇒ 重放器一律取 `?? []` / `?? 0`。  
   ⇒ 这也是「v1.0 → v2.0 **不能回填** `coacts`」的原因：**数据不存在**，不是「不想回填」。  
   （v2.0 → v2.x 则可以回填：事件里有 `coactPairs` / `activationWrites`，事件的 `at` 就是 `last_active`。）
4. ★ **只有 `action === 'purge'` AND `purged > 0` 才代表「发生了物理删除」。**  
   任何按 `type='sweep'` 推断「数据被销毁」的消费方**必须同时判这两个条件** ——  
   否则桶重建 / 簇重算会被误读成数据销毁。  
   ★ **payload 按 `action` 分组写清字段集**（照 `merge` 行「3c / restore_merge 两套」的格式）：  
   · `action='purge'`        → `purged, archivedCount, vacuumed, coactPairsActive, coactPairsPurged`  
   · `action='rebuildArchive'`→ `scanned, repaired`  
   · `action='rebuildBuckets'`→ `cells, members`  
   · `action='recluster'`     → `clusterCount, largestClusterRatio`  
   ★ **旧事件 `action` 缺失 ⇒ 默认 `'purge'`**（照抄硬规则 3 的「旧事件重放」句式）；  
   其余新增键一律 `?? 0`。  
   ★ `action` **不是新造词** —— §8.4 的 `alias` 行已有 `action('set'/'merge')`，  
   这是承袭既有的「子变体判别键」惯例。
5. **`stabilityDelta` 的「键的有无」就是「这次有没有真的加固」的标志**：  
   `stabilityDelta` = 本次 stability 的实际增量（天，`after − before`；未增长时为 0，**键恒在**）。  
   §4.8.1 4e 的 `restore_merge` 路径**刻意省略**了 `intervalDays` / `boostApplied` ⇒ 它也不会有  
   `stabilityDelta` ⇒ 对账代码不需要特判任何事件类型。  
   ⇒ 精确对账口径：`Σ(全库 stability 变化) == Σ over events{有 stabilityDelta 键的事件} of payload.stabilityDelta`，  
   误差 ≤ 1e-9。  
   ★ 顺带更正一个常见误解：§4.9 步骤 2（完全重复）记的是 **`type='touch'`**（`reason='exact_repeat'`），  
   **不是** `write` 事件——§8.4 的 touch 行明写它有两个发射点。  
   ⇒ 对账路径实际是：`touch(explicit)` + `touch(exact_repeat)` + `merge(带 stabilityDelta)`。
6. **`memory_id` 是 `appendEvent()` 的必传实参**（值可以是 `null`，但**不允许省略这个参数**）——  
   上表第三列逐行给出了它该填什么：要么是某个 id，要么明确写「无」。  
   这一列不是可选的：遗忘脱敏（§4.8 步骤 ②）**按 `memory_id` 索引定位**，  
   漏写该列的后果是「用户说了忘掉，而原文静静躺在库里」——不报错、不告警。  
   「必传实参 + 显式 null」而不是「可选参数」的原因：可选参数漏传是静默的（TS 编译通过、运行时无异常），  
   而显式传 `null` 会在代码审查里一眼看到「这里为什么不关联记忆」。  
   本表是该规则的**唯一权威来源**，实现时以此列为准，不要凭记忆写。

---

## 9. 存储底座与并发模型（SQLite）

### 9.1 PRAGMA 规范与崩溃一致性

初始化分两套，**不能合成一套**——两类连接能执行的 PRAGMA 不同：

```sql
-- @example  （本块是示例片段，不参与建库）
-- A. 写连接（readonly: false）：连接建好后、任何事务开始之前
PRAGMA journal_mode = WAL;      -- 会改数据库头并创建 -wal/-shm，只读句柄上执行必然抛 SQLITE_READONLY
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -64000;  -- ★ 64MB 页缓存（负数 = KB）。默认仅 ~2MB，
                               --   对 100 万条 / ~4GB 的库**严重欠缓存** ⇒ 每次查询都可能落盘，
                               --   直接对冲 §12 阶段 2 的 recall P99 ≤ 200ms 门槛
PRAGMA wal_autocheckpoint = 1000;  -- ★ WAL 累积 1000 页自动 checkpoint
                               --   （页大小随建库时的 `page_size` 而定：默认 4096B ≈ 4MB；
                               --    若按上面 §9.1 建库建议设了 8192B，则 ≈ 8MB）
                               --   不设则 WAL 只在连接关闭或被动触发时回落，
                               --   长读持有期间 -wal 会持续增长（磁盘与读放大双压）
PRAGMA mmap_size   = 268435456; -- ★ 256MB 内存映射读：向量点积这类顺序扫可少一次拷贝
PRAGMA temp_store  = MEMORY;    -- 重训 / 对账的排序与临时表放内存（§9.3.2 ③ 的 1M 行集合比对）

-- B. 只读连接（readonly: true，§7.1 桌面查看器）
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -16000;  -- 只读连接给 16MB 即可（§7.1 只做展示性查询）
-- journal_mode / synchronous 一律不设：理由见下
```

- ⚠️ **`page_size` 只能在建库前设一次**（`PRAGMA page_size = 8192`），  
  对已有库无效（需 VACUUM 重建）。⇒ 它属于**建库脚本**（§3 的 @schema 块之前），  
  **不属于 `open()` 的连接初始化**——放在初始化块里是「设了但没生效」的假动作。  
  选 8192 的理由：embedding 行 768 维 float32 ≈ 3KB，默认 4096 字节页下约 1 行/页，打包差。
- ⚠️ **`cache_size` 是负数 = KB**（`-64000` = 64MB）；写正数是「页数」，极易写错量级。
- ⚠️ **`wal_autocheckpoint` 与长事务的相互作用**：重训/对账这类长读会推迟 checkpoint；  
  §9.2 的事务粒度限制了单事务时长，此处由 SQLite 自动处理，不必手工干预。
- **WAL 优势**：读写互不阻塞，读操作不持有排它锁，大幅提升吞吐。
- **为什么只读连接不设 `journal_mode`**：① 它是**写库**的 PRAGMA，在 `readonly: true` 的句柄上  
  执行会抛 `SQLITE_READONLY`——§7.1 的查看器正是用只读句柄打开的，照「一套 PRAGMA 统一初始化」  
  去做，查看器会在 `open()` 当场失败；② WAL 是**持久化在库文件里**的属性，写连接设过一次之后  
  就一直有效，只读连接本来也不需要再设。  
  `synchronous` 是每连接的**内存**设置，只读连接不写盘，设了无效——不会报错，但别写，  
  免得让人以为只读连接也参与了持久化策略。  
  —— 这条与下面「禁止在初始化块里写 `user_version`」是**同一个病根**：凡是会写库的 PRAGMA，  
  都不能出现在「每次 open 都无条件执行」的位置上。早先本节只对 `user_version` 说了这句，  
  却把同样会写库的 `journal_mode` 留在统一块里，等于自相矛盾。
- **`synchronous = NORMAL` 的代价必须写明**（本节标题叫「崩溃一致性」，很容易被读成「已提交就不丢」）：  
  WAL 下 `NORMAL` 只在 checkpoint 时 fsync，断电或进程被强杀时——  
  ① **数据库不会损坏**：WAL 尾部未完整写入的部分被丢弃，恢复后仍是自洽的；  
  ② **最近若干已提交事务可能丢失**：即最后一次 checkpoint 之后写入的那些。  
  本库能接受这个取舍，前提是所有写入都在事务内（§9.2）——丢失是**整事务级**的，  
  `memories` / `edges` / `events` 会一起丢，不会出现「状态变了、事件没了」这种半截状态。  
  若场景要求「返回成功即已落盘」，改 `synchronous = FULL`，代价是每次提交一次 fsync；  
  本库写路径存在 touch 写放大（§4.5 R-EDGE-TOUCH），这个代价会很直接。
- **单写进程约束**：应用层采用单个写入连接，多线程/多进程访问时统一通过进程锁或守护服务调度，排队超时设定为 5000ms。
- **`foreign_keys` 是每连接开关，且 SQLite 默认关闭**——这是本节最容易出事的一条。  
  漏开时**不报错、不警告**，只是所有外键检查与级联动作全部不执行。后果是静默的：
  - `forget({hard:true})` 删掉 `memories` 行后，`memory_entities` / `content_history` 里留下**孤儿行**  
    （§4.8 注释里「由 FK CASCADE 同步」那句当场失效）；
  - `mergeEntities` 删掉 `entities` 行后，`entity_aliases` / `edges` 留下孤儿行；
  - `linkByIds` 传入不存在的实体时不再报错，而是写入**悬空边**（§4.5 步骤 4）。  
    三者都不抛异常、也不在 `logs/` 留痕，只在日后某个查询里表现为「数据对不上」。  
    所以**任何构造 `MemoryStore` 的路径都必须设它**，只读连接与测试临时库同样不例外。
- **模式版本管理（user_version）**：
  - **`SCHEMA_VERSION` 就是写进 `PRAGMA user_version` 的那个常量**，两处同名同值。  
    `events(type='config')` 的 payload 里记的也是它（§8.4），**不是文档版本号**——  
    不要另立第二个「版本常量」，否则重放时无从判断一条历史事件属于哪套 schema。
  - **建库时写入一次**：schema 初始化脚本**末尾**执行 `PRAGMA user_version = 2;`  
    （schema 版本为 **2**：与 v1 的差别是 ① `memories` 多了 `embedding BLOB` 一列  
    　　② **新增九张表** `coacts` / `theme_clusters` / `theme_cluster_members` /  
    　　`cluster_snapshot_meta` / `meta` / `vector_coarse_cells` / `vector_fine_cells` /  
    　　`vector_cell_members` / `archival_schedule`  
    　　（**九张**，其中 `cluster_snapshot_meta` 是**单行快照元信息表**（§4.12.2）、  
    　　`meta` 是**通用就绪标记表**（key/value，§4.12.2）——**两张不同的表，不要混为一谈**）。  
    　　⚠️ **迁移必须建齐全部新表，并回填 `archival_schedule`**——  
    　　把 schema 版本号说成「只多了一列」会让实现者照着只 ALTER 一列，  
    　　老库要等到第一次 `stats()` / `touch()` 才炸（`no such table`）。）
  - **运行时只读校验（两段式）**：每次 `open()` 后读 `PRAGMA user_version`：  
    · `== 1` → 走 v1 → v2 迁移（上面的块）    · `== 2` → **再查 `sqlite_master`** 确认 v2 的九张新表齐全：  
    → 期望 **9 行**；**不等于 9** ⇒ 抛错  
    （`details = { expected: 9, actual: n, missing: [...] }`，  
    错误信息须写明「这是 v2.0 草案库，需重建或手工迁移」）  
    ⚠️ **不得用「少建几张就补建」自愈**——§9.1「不一致时一律抛错，不做猜测式兼容」禁止；  
    且 v2.0 草案库的结构与 v2.1 不同（草案是 `vector_cells` 单表），**补建也补不对**。  
    齐全 → 放行；缺 `vector_coarse_cells` → 这是 **v2.0 设计稿**建出的库（单表 `vector_cells`）  
    → 抛明确错误（提示重建），**不做猜测式迁移**  
    · 其余 → 抛错  
    ⇒ **为什么不升到 3**：版本号是给用户的**承诺**，不是内部计数器。  
    v2.0 **从未发布**（只是设计稿）⇒ 没有「已部署的 v2」需要与 v2.1 区分  
    ⇒ 升 3 等于向用户声明「v2.0 是个发布过的版本」，而它不是。  
    ⇒ 两段式判定对两种情形都安全：草案库存在就被抓住，不存在则零成本。
  - **v1 → v2 迁移（本库目前唯一的迁移，必须真写出来，不能只写"将来"）**：  
    `open()` 读到 `user_version = 1` 时，在**建立业务连接之前**、**同一个事务内**执行：
    ```sql
    ```

-- @migration  ★ **本块不属于建库脚本**（只对已存在的 v1 库有意义）：  
-- @example  （本块是示例片段，不参与建库）  
BEGIN IMMEDIATE;  
-- ⚠️ ★ **ALTER 必须带上与 §3 完全相同的 CHECK 约束**：  
--   `ALTER TABLE ... ADD COLUMN` 若只写 `embedding BLOB`，  
--   迁移出来的库**就没有** §3 定义的 `% 4 = 0` 守卫  
--   ⇒ 新建库与迁移库的 schema **分叉**（同样的列名、不同的约束），  
--   而 §9.1 的运行时会校验是按 schema 版本号放行的 ⇒ 分叉不会被发现，只在脏数据写入时才暴露。  
--   ⇒ **两条路径必须产出同一个 schema**（这是「迁移必须建齐全部新表」的同一条纪律）。  
--   ⚠️ SQLite 的 CHECK 在 ADD COLUMN 时**不校验已有行**（新列全为 NULL，本就合法），无副作用。  
ALTER TABLE memories ADD COLUMN embedding BLOB  
CHECK (embedding IS NULL OR length(embedding) % 4 = 0);  -- 与 §3 的 memories 表逐字一致  
-- ★ 建齐 v2 的全部**九张**新表 + 全部索引与触发器（DDL 逐字取 §3）  
-- ★ 建表语句逐字取 §3 的 @schema 块（**唯一权威**），下面是它们的清单：  
--   CREATE TABLE IF NOT EXISTS coacts (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS theme_clusters (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS theme_cluster_members (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS cluster_snapshot_meta (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS meta (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS vector_coarse_cells (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS vector_fine_cells (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS vector_cell_members (...);   -- DDL 逐字取 §3  
--   CREATE TABLE IF NOT EXISTS archival_schedule (...);   -- DDL 逐字取 §3  
-- ⚠️ ALTER 用 `PRAGMA table_info(memories)` 守卫（SQLite 无 IF NOT EXISTS）：  
--   PRAGMA table_info(memories);  -- 已有 embedding 列 ⇒ 跳过 ALTER  
--   coacts / theme_clusters / theme_cluster_members / cluster_snapshot_meta / meta /  
--   vector_coarse_cells / vector_fine_cells / vector_cell_members / archival_schedule  
--   ★ **建表必须用 CREATE TABLE IF NOT EXISTS** ⇒ 迁移可重复执行  
--   ★ **ALTER TABLE ADD COLUMN 在 SQLite 没有 IF NOT EXISTS 形式**  
--     ⇒ 重跑迁移会炸 `duplicate column name: embedding`  
--     ⇒ 正确形状：**建表用 IF NOT EXISTS** ✅ + **ALTER 用 PRAGMA table_info 守卫** ✅  
--   ★ coacts / theme\_* / vector\_* 保持为空（无历史数据；§8.4 规则 3）  
--   ★ archival_schedule 保持为空（阶段 B 回填）  
-- ⚠️ 建表带 FK 时**不需要**先开 foreign_keys（ON DELETE CASCADE 写在 schema 里）；  
--   受开关影响的是**执行 DML 的那条连接**。  
--   ⇒ **迁移块自己执行的 DML 不能依赖级联**——阶段 B 是纯 INSERT，安全 ✅  
PRAGMA user_version = 2;  
COMMIT;

````
-- 阶段 B：分批回填 archival_schedule（rowid 游标，可中断可重跑）
--   ⚠️ 不写任何 events ⇒ §12.1 ③「events 恰好 +1 条」仍成立
--   ⚠️ 纯 INSERT，不依赖 ON DELETE CASCADE
--   ⚠️ **分批而非单事务**：100 万行单事务 ⇒ WAL 暴涨 + 持写锁数分钟
-- ★ **就绪标记**（`meta` 的 'archival_schedule_ready'）：
--   **正确性从不依赖回填是否跑完** ⇒ ready=0 时 countArchived() 走逐行精筛
--   （§9.4.5 的降级路径**已经存在**）⇒ 慢但正确 ⇒ 可中断可重跑
--   ⇒ **就绪标记比「同事务」便宜**：同事务只是「保证不出现静默半张表」的手段
--   ★ 护栏必须区分「未就绪」与「真漏了」：ready=0 时 `stats().archivalMissing`
--     报 **null**（不是 0、也不是 >0）—— 否则它必然非 0 ⇒ 护栏会误报
rebuildArchivalScheduleInternal(db, now);
setCacheReady(db, 'archival_schedule_ready', 1);
```
成功后**按 v2 继续工作**，不要抛错——迁移成功还报错，等于逼调用方手工改库。
- 旧数据**不回填**：`embedding IS NULL` 是合法状态（§3）。这些记忆照常走文本路与图谱路，  
  只在向量路上缺席，代价是得分上限 0.75（§4.6 步骤 3）。回填靠 §4.9 步骤 2 的「重复写入时补写」。
- **为什么不做一次性全量回填**：它需要 embedder，而构造期未必配置；强做会把 `open()`  
  变成几万次模型调用，启动时间不可控，中途失败后的状态也难描述（一半有向量一半没有，  
  且没有事务能包住外部模型调用）。宁可就地降级，让调用方自己决定何时补。
- **迁移不可逆**：用 v1 的代码打开 v2 的库会因版本不符抛错——这是**正确行为**，  
  不要让旧代码打开新库后按 v1 的假设去解释数据。
````

- **不一致时一律抛 `MemoryError.INVALID_INPUT`（`details = { expected, actual }`），不做"猜测式"兼容。**  
  `user_version` 为 2 → 直接放行；为 1 → 走上面那条迁移；**其余任何值** → 抛错。  
  写成「抛错（或触发迁移流程）」这种括号二选一，实现者只会写出一个什么也不做的 `if` 分支。  
  **将来引入 v3 时**：迁移逻辑写在 `open()` 内、建业务连接之前，成功后再写  
  `PRAGMA user_version = 3`；**不允许**「启动时顺手把版本号改成当前代码期望值」——  
  那等于把版本检查变成永远通过的装饰。
- **禁止在连接初始化设置块里写 `user_version`**：① 只读连接执行写 PRAGMA 会直接失败  
  （理由同上面 `journal_mode` 那条）；② 每次 open 都把版本号重置为 1，  
  将来做迁移时会永久覆盖已升级的版本号，迁移机制彻底失效。

### 9.2 事务原子性

所有写操作（如 `write`、`link`、`touch`、`forget`、`sweep`）必须包裹在显式事务 `db.transaction()` 中：

- `memories` 数据变动、`memory_entities` 关联变动、`edges` 权重变动、`events` 流追加在同一事务中原子提交。
- `touch()` 会同时改两张表：`memories`（stability / last_access / access_count）与 `edges`（§4.5 R-EDGE-TOUCH 的 weight / last_active）。  
  二者必须同事务——否则会出现「记忆被确认了、关系没跟着保鲜」这种半截状态，而且它不会报错。
- FTS 虚拟表由 SQLite 原生触发器自动同事务维护。
- **`sweep()` 是唯一「多事务」的写操作**（§4.10）：它按 `SWEEP_BATCH_SIZE` 分批，**每条记忆的删除 + 脱敏 + 记事件  
  是一个独立事务**，而不是把整次 sweep 包成一个大事务。  
  两个不能混的地方：
  - 若照「所有写操作一个事务」把整个 sweep 包起来，清理 10 万条软删记录时会持写锁数分钟，  
    正是 §4.10 分批要避免的情形；
  - `VACUUM` **必须在事务外**执行（SQLite 硬性要求），better-sqlite3 用 `db.exec` 直接跑，不能放进 `db.transaction()`。  
    代价是「sweep 中途崩溃」会留下已清理一部分的状态——这是可接受的：每条记录的处理本身是原子的，  
    残留的软删记录只是留到下次 sweep，不产生半删状态。

### 9.3 存储物理布局与分桶一致性（v2.0 新增）

#### 9.3.0.1 通则：全库唯一的合并写入点

★ **在写入路径内，§4.9 步骤 2 / 3c 的合并写入序列是唯一能改变这六项的代码路径**：  
`content` / `content_hash` / `embedding` / `growStability` 加固 /  
`content_history` 归档 / `merge` 事件。  
⇒ **前台写入（§4.9 步骤 2 / 3c）、去重路径（§4.9 步骤 3a2）、后台补齐扫描全部走它。**  
⇒ ⚠️ **「写入路径内」这个限定不可省**（v2.1 勘误 / ADR-P1-T07-DEC D-2）：  
  稳定度的**加固**还有第二个入口——**`touch()`（§4.2）**——它同样调 `growStability()`。  
  **加固的唯一函数入口是 `growStability()` 本身**（§4.2 / §4.15.5 的「全库唯一的 stability 写入点」）。  
  ⇒ 即：本节说的是「**写一条记忆时**，正文/向量/稳定度/历史/事件只由合并写入序列改」；  
  「**稳定度只由 `growStability()` 改**」是**另一条**通则（它管的是 `touch()` 这条路）。  
  （不写这个限定，读者会以为「只有合并能加固」——而 `touch()` 明明也能。）

· **步骤 2 在这条路径上的位置**（它**不改正文 / 哈希 / 历史、不发 `merge` 事件**）：  
  它碰 `embedding` 的**唯一**入口是「**向量回填**」——**只补 `embedding IS NULL` 的行，
  已有向量不得覆盖**，且**必须调合并写入序列所在模块里的那个回填函数**（不得各自写 SQL）。  
· **`embedding` 的两条改法**：**步骤 3c 的合并**（写新向量 / 没传就置 NULL）
  与**步骤 2 的向量回填**。⇒ 两条路都不得自己写 `UPDATE memories SET embedding`  
  ⇒ 该 SQL **全库只应出现在一个模块里** ⇒ 可用**静态扫描**守住（当前实现：`src/store/merge.ts`）。

⇒ **理由与 §4.15.5 的「全库唯一的 stability 写入点」同源**：  
**同一件事有两份实现 ⇒ 必然漂移，而漂移不报错。**  
⇒ 配套：**后台补齐不得自己写 stability**，必须调 `growStability` ——  
⇒ 这与 `growStability` 必须返回 `stabilityDelta` 是**同一条链**：  
后台补齐要正确加固 ⇒ 拿得到正确的 delta ⇒ payload 才带得上 ⇒ 对账恒等式才成立。

★ **代码位置（可静态扫描的落点）**：合并序列与向量回填放在**同一个模块**  
（当前实现：`src/store/merge.ts`）⇒ 「唯一写入点」可以靠**扫描该模块之外没有第二处正文 UPDATE**
来守住，而不是靠注释提醒。  
⇒ ⚠️ 这与 §9.3.0 的 `assignBucket` / `unassignBucket` 是**同一种手法**：
**把「唯一写入点」从「一条纪律」变成「一个只有它能碰的地方」。**

#### 9.3.0 桶归属的写入**只允许出现在一个内部函数里**（★ 架构裁决）

```
assignBucket(memoryId: string, vector: Float32Array): void
  内部做：算最近细桶 → DELETE 旧归属 → INSERT 新归属 → 更新 member_count（−1/+1）
unassignBucket(memoryId: string): void
  内部做：DELETE 归属 → member_count −1
```

⇒ **§4.9 的每一条 embedding 赋值路径一律调用它**，**不得各自写 SQL**。  
⇒ **为什么用函数而不是注释提醒**（同 §4.2 `growStability` 的先例，原话在 §4.2）：  
「它们最初各写各的公式，接连出过三次同类事故……**收拢后这三个约束结构上不可能漏**  
——调用方只能传倍率，改不了守卫。」  
⇒ **桶归属是第四例**：注释提醒会漏读、后续新增路径又会忘；  
单一函数则让「漏」变成**编译不过**。  
⇒ **配套 lint 规则**：`§4.9 里不得出现裸 `INSERT INTO vector_cell_members`/`UPDATE vector_cell_members\`。

#### 9.3.1 目录布局

```
<library>/
├── ocean.db          # ★ 唯一事实源。含下列全部表：
│                     #   memories（含 float32 embedding）/ entities / entity_aliases /
│                     #   memory_entities / edges / content_history / events / mem_fts /
│                     #   coacts / theme_clusters / theme_cluster_members /
│                     #   cluster_snapshot_meta / meta /
│                     #   vector_coarse_cells / vector_fine_cells /
│                     #   vector_cell_members / archival_schedule
└── logs/             # §8.1 文本日志
```

★ **v2.0 没有 ANN sidecar 目录。** 早期方案曾打算用 usearch 的 mmap 索引文件  
（`cells.idx` + `cells.meta.json`），但那套方案已被推翻（§4.15.3 的选型理由）：  
分桶把桶归属放在主库表里，**与主表同事务**，因而**不存在索引与主库不同步的问题**——  
也就不需要「启动对账 + 就绪闸门 + 幽灵向量防御 + 原子替换顺序」这一整套机制。  
⇒ **备份对象回到「一个 db 文件 + logs/ 目录」**，这是分桶选型最实在的收益。

- **主库仍是单文件**：ADR-7 的「单机文件」结论**完整保留**，  
  连 v1.0 都没破——**没有 sidecar 索引文件**（向量桶归属在主库表里，§9.3.1）。  
  ⇒ **备份对象 = 一个 db 文件 + `logs/` 目录**，这是分桶选型最实在的收益。  
  ⚠️ **但「单文件」≠「裸 cp 就是备份」**：WAL 模式下 `-wal` / `-shm` 是附属文件，  
  直接拷 `.db` **不一致**（§11.3）。**唯一推荐的备份方式是 `VACUUM INTO`**（产出自洽单文件）。  
  ⇒ 正确表述：**导出 = 一次自洽快照（`VACUUM INTO`），不是一次文件复制**（§11.3.1）。
- ⚠️ **目录不是「多租户」的入口**：一个目录 = 一个记忆库。  
  多租户仍由上层开多个目录（ADR-1 不变）。

#### 9.3.2 分桶归属与主库的一致性

★ **桶归属（`vector_cell_members`）与 `memories` 在同一个事务里写。**  
这意味着**本节只需要一条规则**：

```
① write() / merge() / updateContent() 改变了 embedding
   → 同一事务内同步 vector_cell_members（INSERT OR REPLACE 到最近的细桶）
   → 失败即整体回滚 ⇒ 不会出现「记忆在、桶不在」的孤儿
   ⚠️ 这一步**不能省**：省了它，那条记忆将永远不进任何桶 ⇒ 向量路永远召不回它，
     且**没有任何报错**。这是本机制唯一的静默失效点。

② forget({hard:true}) → 删 vector_cell_members 行
   （同事务，FK ON DELETE CASCADE 兜底）
   软删**不删桶归属**：软删记忆仍可 restore，§8.2 也要求软删保留向量。
   ⚠️ 但软删记忆**必须在召回时被过滤**——§4.6 步骤 2c 的 SQL 有 `m.deleted = 0`，
     这是第二道防线（第一道是 FK CASCADE）。

③ 启动对账（防御性，正常情况下应当永远相等）：
   ⚠️ **必须用集合比较，不能用 COUNT 比较**：
     COUNT 相同但**成员不同**（一条漏了、另一条多了）是完全可能的，
     而「条数对得上」会让人以为对账通过 ⇒ 漏召永久存在且无人发现。
   ⇒ 对账口径（两侧都取 id 集合）：
     库侧：SELECT id FROM memories
            WHERE deleted = 0 AND embedding IS NOT NULL
     ⚠️ **左侧（库侧）是「全库」扫描的结果，不是「本次写入的批次」**（ADR-P1-T07-DEC D-12）——
       若左侧只取本批次，断言就退化成「本批写的东西都进桶了」，
       **恰好放不过阶段 1 遗留的那笔欠账**（有向量、无桶归属的旧记忆）
       ⇒ 阶段 2 什么都没写也会**假绿**。
       ⇒ 左侧口径必须写成：`SELECT id FROM memories WHERE embedding IS NOT NULL AND deleted = 0`（**全库**）。
       ⚠️ **列名是 `id`，不是 `memory_id`**：`memory_id` 是 `vector_cell_members` 的外键列名，
       `memories` 表的主键叫 `id` ⇒ 抄成 `SELECT memory_id FROM memories` 会直接 SQL 报错。
     桶侧（★ **LEFT JOIN，不丢硬删孤儿**，否则真孤儿会被一并放过）：
       SELECT vcm.memory_id, m.id, m.deleted, m.embedding
         FROM vector_cell_members vcm
         LEFT JOIN memories m ON m.id = vcm.memory_id
     → 差集双向比对：
       库侧有、桶侧无 ⇒ 补（归入最近的细桶）
       桶侧有、库侧无 ⇒ ★ **三分支，不再一刀切**：
         · JOIN 不到 memories 行（硬删且 FK 未开 ⇒ **真孤儿**）⇒ **删**
         · `m.deleted = 1`（**软删**）⇒ **跳过，不删**
           ⚠️ §9.3.2 ② 明写「软删不删桶归属」（软删仍可 restore，§8.2 也要求软删保留向量）。
           **若这里一刀切删掉 ⇒ forget(soft) → 桶行被删 → restore() 回来 → 那条记忆
           永久进不了向量路（桶行已不存在）⇒ 静默、永久、不报错** ——
           正是本库反复强调的「唯一的静默失效点」。
         · `m.embedding IS NULL` ⇒ **删**（无向量记忆不该在桶里，§9.3.2 ① 第三分支）
     成本：两侧各 100 万个 id 的哈希比对 ≈ 1 秒（36MB × 2）
     ⇒ **绝不**用「只比条数」或「只比数量上限」

   ⚠️ ⚠️ **集合比较单独用仍然看不见「重复归属」**（QA 实测结论）：
     对账的键是 `memory_id`，而**一条记忆同时挂在两个桶上时，它在两侧都出现**
     ⇒ 双向 EXCEPT **查不出它**（缺行查不出、脏行查不出、重复也查不出）。
     ⇒ **三条判据必须齐过**，缺一条都会漏：
       ① **双向集合比较**（EXCEPT）    → 抓「缺失」与「脏行（桶里有无向量记忆）」
       ② **COUNT(*) == COUNT(DISTINCT memory_id)** → **抓「重复归属」**
       ③ **源头堵**：§3 的 `idx_vcm_memory_unique` 唯一索引（一条记忆只属一个细桶）
          ⇒ 让重复**根本写不进去**，而不只是事后查出来
     ★ 三条的关系：①抓「少/脏」、②抓「多」、③让「多」**不可能发生**。
       只做 ① 是不够的；只做 ② 也会漏「少」；③ 是唯一的根治手段，
       但 ①② 仍需保留——**唯一索引能挡「写进去」，挡不住「历史脏数据」**。
   ⚠️ 对账是**防御**不是常态：同事务写入意味着正常路径不可能不一致。
     若对账每次都发现差异，说明 ① 被漏实现了——那是 bug，不是数据问题。
```

④ 桶质量退化 → 全量重训：  
触发条件：桶内成员数的 P95 超过 `ROUTER_BUCKET_MAX`（默认 300），  写死硬阈值，不靠感觉。  
⚠️ ★ **P95 的数据源 = 启动时按 `vector_cell_members` 聚合**（**刻意不落维护列**）：

```sql
-- @example  （本块是示例片段，不参与建库）
SELECT fine_id, COUNT(*) AS n FROM vector_cell_members GROUP BY fine_id
```

⇒ 取 n 的 P95（细桶粒度；粗桶计数 = 其下细桶之和）。  
⚠️ **刻意不落 `member_count` 列**：落列就多出 3 个维护点（换桶 ±1 / 硬删 −1 / 重训批量赋值），  
**漏一条就永久漂移 ⇒ 重训触发被静默焊死** —— 这正是 `cell_count`（**已删除的旧列名**） 的死法。  
⇒ 与 `cluster_snapshot_meta.member_count` 同款语义：**聚合口径天然精确，不做增量维护**。  
★ **口径**：含软删记忆（软删不删桶归属）⇒ 与 `clusters[].size`（活跃成员数）**口径不同**。  
★ **成立的前提**：重训触发本来就是**启动阶段**操作 ⇒ 启动时多扫一遍不是额外成本；  
这一遍可与 §9.3.2 ③ 的启动对账**合并成同一次扫描**。  
⚠️ **P95 只在启动时算一次** ⇒ 运行期桶退化不会即时触发重训  
⇒ 这是刻意的（运行期重训要 1~3 分钟阻塞，不能由库自作主张）⇒ 由调用方显式调  
`rebuildVectorBuckets()`（§4.15.5）。  
⚠️ **全量重训是阻塞操作**（100 万条约 1~3 分钟）。  
⚠️ **重训只能由调用方显式触发**（`rebuildVectorBuckets()`），**库不会自动重训**；  
触发期间**库阻塞 1~3 分钟** ⇒ **调用方必须自行安排维护窗口**。  
⚠️ 它**可以在运行期发生**（不必等到下次启动）—— 这正是  
`stats().vectorBackend.inRetrain` 要表达的状态（调用方已发起、正在执行）。  
⚠️ **不是「只能在启动期做」**：库是全同步 API（ADR-5），阻塞 1~3 分钟的操作由**调用方择时**发起，  
而不是由库在启动时替它决定（§4.6 步骤 0 的同一理由）。

★ **与「幽灵向量」的对照**（为什么这里不需要那道防御）：  
sidecar ANN 索引方案里，「索引里有、主库里没有」是真实风险（硬删后索引未同步），  
必须靠「ANN 结果 JOIN 主库」的第二道防线挡住。  
**分桶没有这个问题**——桶归属在主库表里，FK CASCADE 保证「主库删了桶归属也删了」，  
不存在索引侧的残留。⇒ §4.6 步骤 2c 的 `JOIN memories m ... AND m.deleted = 0`  
在本方案里是**第一道也是唯一一道**防线（它防的是软删，不是硬删残留）。

#### 9.3.3 冷热分层：v2.0 **不做**

v1.0 曾考虑按「近岸/远洋」分层存放。v2.0 **明确不做**，理由：

- 分层会让「一条记忆在哪个层」变成**存储状态**，而层级本应是 intensity 的派生结果（§2 原则①）；
- 分层迁移需要搬运数据，而 `memories` 表有 FTS5 触发器与多个索引，搬运即重建；
- 100 万条的主库体积（4 GB）在 NVMe 上完全可接受，**没有实际的性能压力支撑这次复杂度**。  
  ⇒ 规模真的到千万级时再考虑。

### 9.4 归档缓存（archival_schedule）与一致性

#### 9.4.1 为什么要有这张表

`countArchived()` 若逐行算 intensity，100 万次 `exp()` ≈ 150~400ms，  
且 `stats()` 与 `sweep()` 都要调它。但归档时刻是**精确可计算的**：

```
intensity ≤ ARCHIVE_LINE
 ⟺ exp(-Δt / (stability × pin_factor × 86400000)) ≤ ARCHIVE_LINE
 ⟺ Δt ≥ stability × pin_factor × ln(1/ARCHIVE_LINE) × 86400000

定义：archive_at = last_access + stability × pin_factor × ln(1/ARCHIVE_LINE) × 86400000
```

★ **自洽校验（这条是它值得信任的理由）**：  
`stability ≤ MAX_STABILITY(180)`、`pin_factor ≤ MAX_PIN_FACTOR(5)`  
⇒ 最远归档时刻 = `last_access + 180×5×ln(20)` 天 = **2696 天**，  
与 §4.6 的 `@coarseCutoffPinned`（2696 天）**完全吻合**  
⇒ 这个公式与 §4.6 的粗筛推导同源，可直接引用。

★ **归档跨度的唯一实现（v2.1 勘误 / ADR-P1-T07-DEC §10-A）**：  
`ln(1 / ARCHIVE_LINE)` 这个数**至少在三处**被用到——① 本节的 `archive_at`；② §9.4.1 的**迁移回填**；  
③ §4.6 步骤 2 的**粗筛窗口**（`coarseGateWindow`）⇒ **三处各写一遍 ⇒ 改公式要改三处，漏改一处不报错**。  
⇒ **唯一定义处 = `src/core/decay.ts` 的 `archiveSpanFactor(archiveLine)`**（并由 `archiveSpanMs()` 给出毫秒形态）；  
⚠️ **`src/core/scoring.ts` 的粗筛窗口必须调它**，**不得自己再写一遍 `Math.log(1 / ARCHIVE_LINE)`**——  
  那就是**第三份副本**（C36：两份副本必然漂移，而漂移不报错；表现为「按迁移回填判未归档、按粗筛窗口却被挡住」）。  
⇒ 与 `86400000` 的分层同源：**`src/util/time.ts` 定义常量 → `src/core/decay.ts` 提供唯一公式 → 其余模块一律调用**。

⇒ `countArchived()` = `SELECT COUNT(*) FROM archival_schedule WHERE archive_at <= @now`  
　　走索引，**< 5ms**，且**结果与全表精筛逐位相同**（不是近似）。

#### 9.4.2 表结构

```sql
-- @schema  ★ **本块是建库脚本**（工具与人都以它为准）：
-- @example  （本块是示例片段，不参与建库）
CREATE TABLE archival_schedule (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  archive_at INTEGER NOT NULL          -- 归档时刻（毫秒）；精确值
);
CREATE INDEX idx_arch_at ON archival_schedule(archive_at);
```

★ **只装 `deleted = 0` 的行。** 计数因此是纯索引扫描，不需要 JOIN `memories`。

#### 9.4.3 维护点收拢为一个函数

```
reindexArchive(memoryIds: string[]): void
  —— 依据当前 memories 行的 stability / pin_factor / last_access
     重算 archive_at，并 INSERT OR REPLACE / DELETE 对应行
  —— **不依赖 ON DELETE CASCADE**
```

★ **为什么必须显式调用而不靠 CASCADE**：  
§9.1 明写「`PRAGMA foreign_keys` 是每连接开关、**漏开时不报错不告警**」。  
漏开时 CASCADE 不执行 → 孤儿行留在缓存表 → `countArchived` 把一个  
**不存在的记忆**算进归档数 → 归档数只多不少、不会报错、只会慢慢偏。  
靠 CASCADE 兜底 = 把一个静默偏移交给一个会静默失效的开关。

**全部调用点（9 条，缺一即漂移）**：  
`growStability()`（stability + last_access 变）、`pin()` / `unpin()`（pin_factor 变）、  
`write()` / `merge()`（新建 / 改写）、`forget({soft})`（移出缓存表）、  
`forget({hard})`（物理删行 → 移出）、`restore()`（插回）、  
`sweep({purgeDeletedDays})`（物理删行 → 移出）。  
· **`setParams({ ARCHIVE_LINE })`** ★ **第 10 条路径**（易漏的一条）——  
归档线变了 ⇒ **所有** `archive_at` 全变（旧值按旧线算的）⇒ 必须全量重算。  
⚠️ 它**不在 `reindexArchive` 的调用点里**（那里只按 memoryIds 逐条重算，  
而改归档线是**全库**范围）⇒ 由 `setParams()` 直接触发  
`rebuildArchivalScheduleInternal(db, now)`。  
★ **所有删除路径都走 `reindexArchive`，不靠 CASCADE。**

#### 9.4.4 派生缓存的三道护栏

① **可观测**：`stats().archivalOrphans`  
= `archival_schedule` 中在 `memories` 里找不到对应行、或对应行 `deleted ≠ 0` 的条数。  
—— 该数**应当恒为 0**；非 0 即表示某条路径漏了 `reindexArchive`。  
这是把「静默偏移」变成「可观测偏移」的关键。  
② **自检**：抽样一致性检查（`ARCHIVAL_ORPHAN_CHECK` 条，§5）  
随机抽 N 条，用公式重算 `archive_at` 与表内值比对，不一致则告警。  
③ **重建**：`rebuildArchivalSchedule()`  
分批全量重算（rowid 游标，§4.10 同款），`sweep()` 可选执行。

★ 三道护栏缺一不可：只有 ① 没有 ③，发现偏移后无法修复；  
　只有 ③ 没有 ①，偏移会一直存在直到某天有人手工重算。

#### 9.4.5 开关

`ARCHIVAL_CACHE`（默认 true）：关掉 → `countArchived` 退回逐行精筛。  
★ 它必须纳入「关掉后与 v1.0 逐位一致」的基线开关组  
（虽然结果相同，但实现路径不同 —— 见 §5 与 ADR-21）。

## 10. 文本路：中文 Bigram 分词与 FTS5

> **Bigram 是 §4.6 三路召回里的文本路，不是「检索的唯一实现」。** 它负责精确匹配  
> （错误码、文件路径、人名、版本号——这些是向量的弱项），语义召回交给向量路；  
> 它在融合分里的权重是 0.20。分词规则本身一个字没改。
>
> §10.3 的两条限制依然成立，但影响面收窄了：向量路不经过分词，  
> 「拉丁文前缀搜不到」这类问题、换个说法问仍可能命中。  
> **但这不构成不修的理由**——精确匹配恰恰是向量的短板，两者是互补而非替代关系（§4.6 步骤 3）。

### 10.1 为什么放弃纯 Trigram

实测中文 1~2 字高频查询（如"猫粮"、"发烧"）在 SQLite trigram 下切不出 3 字符滑窗，导致召回直接返回 0 条。因此采用 **Bigram 预切分 + unicode61**。

### 10.2 分词与检索逻辑

```ts
/** 全角 ASCII 区间转半角（U+FF01-FF5E → U+0021-007E），并把全角空格 U+3000 转普通空格。
 *  为什么必须在分词前做：正则 `[\u4e00-\u9fa5]+|[a-zA-Z0-9_]+` 两个分支都不匹配全角字母数字，
 *  不转换就等于**静默丢弃**——tokenize("ＡＢＣ") 返回空串，而 normalize 又把它的 hash 算得与
 *  "abc" 相同。于是一条 write("ＡＢＣ") 的记忆既**搜不到**，又会在后续 write("abc") 时
 *  被判为完全重复，把所有等价写法都吸收进这条检索不到的记忆里。不报错、不告警。 */
export function toHalfWidth(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/** 归一化：去首尾空白 → 全角转半角 → 小写。
 *  **只用于计算 content_hash**；落库的 content 一律保留原文（tokenize 自己会转半角与小写）。 */
export function normalize(text: string): string {
  return toHalfWidth(text).trim().toLowerCase();
}

/** 中文 2 字滑窗，英文数字保留整词，全角转半角，大写转小写 */
export function tokenize(text: string): string {
  const parts = toHalfWidth(text).match(/[\u4e00-\u9fa5]+|[a-zA-Z0-9_]+/g) ?? [];
  const out: string[] = [];
  for (const p of parts) {
    if (/^[\u4e00-\u9fa5]/.test(p)) {
      if (p.length === 1) out.push(p);
      else for (let i = 0; i < p.length - 1; i += 1) out.push(p.slice(i, i + 2));
    } else {
      out.push(p.toLowerCase());
    }
  }
  return out.join(' ');
}

/** 转义 FTS5 特殊保留字符，避免语法解析错误与崩溃 */
function escapeFts5(token: string): string {
  // 替换内部双引号，整体包裹双引号
  return `"${token.replace(/"/g, '""')}"`;
}

/** 转义 LIKE 通配符，防 SQL 通配逃逸 */
export function escapeLike(str: string): string {
  return str.replace(/([%_\\])/g, '\\$1');
}

/** 智能查询串构造：兼顾短语精确度与长文本召回率 */
export function buildMatchQuery(q: string): { matchSql: string | null; fallbackLike: string | null } {
  const tokens = tokenize(q).split(' ').filter(Boolean);
  if (tokens.length === 0) return { matchSql: null, fallbackLike: null };

  // 1. 单字输入
  if (tokens.length === 1 && tokens[0]!.length === 1) {
    const ch = tokens[0]!;
    // 1a. 单个汉字：无法构成 bigram，只能走 LIKE 兜底（转义通配符）
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      return { matchSql: null, fallbackLike: escapeLike(ch) };
    }
    // 1b. 单个拉丁字母/数字：LIKE '%a%' 会扫全表且几乎命中一切，
    //     而区分度为零（单个字母不表达任何意图）。直接返回空候选，
    //     交给调用方补全关键词——这比返回几万条噪声更有用。
    return { matchSql: null, fallbackLike: null };
  }

  // 截断过长 tokens 数量（SQLite 变量与查询表达式上限防护，最大取前 30 个）
  const safeTokens = tokens.slice(0, 30);

  // 2. 短词查询 (≤ 3 个 bigram)：AND 精确收敛
  if (safeTokens.length <= 3) {
    return {
      matchSql: safeTokens.map(escapeFts5).join(' AND '),
      fallbackLike: null
    };
  }

  // 3. 长句上下文 (> 3 个 bigram)：OR 宽松召回，由 BM25 计算相关度排位
  return {
    matchSql: safeTokens.map(escapeFts5).join(' OR '),
    fallbackLike: null
  };
}
```

### 10.3 已知限制（必须写清，避免使用者误判）

Bigram 方案是为中文优化的，对拉丁文与数字有明确缺陷。以下三条是**设计取舍，不是待修 bug**：

| 限制             | 具体表现                                                                        | 影响                                                                                                                                                                                                            | 缓解方式                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **拉丁文不支持前缀匹配** | `tokenize("config")` → `"config"`（整词），所以搜 `conf`、`confi` 都**召回不到** `config` | 用户输入英文缩写或未输完的单词时命中率为 0                                                                                                                                                                                        | ① 调用方在 UI 层做英文补全；② 或对纯拉丁输入额外走一次 `LIKE '%kw%'`（代价是全表扫，仅建议在结果为空时兜底）                                                                                                                                              |
| **数字串被逐字符切碎**  | `tokenize("1.2.3")` → `"1 2 3"`：每个数字段成为**独立整词 token**，不参与 bigram            | **后果取决于 §10.2 走哪一支，两个方向相反**：token 总数 ≤ 3 时走 AND（`"1" AND "2" AND "3"`，要求三个整词同时出现，命中率**极低**，不是「几乎命中一切」）；> 3 时走 OR，此时每个单数字 token 独立放行一批候选（正文含独立数字 `1` 的记忆都会进来），**噪声只出现在这一支**。原表述「任何数字都会把所有含该数字的记忆捞进来」对 AND 支是反的 | ① 候选集有 `LIMIT 100` 与 `medianBm25` 归一，OR 支的噪声会被 BM25 排到后面；② 若要给 OR 支降噪，可在 `buildMatchQuery` 里丢弃长度 = 1 的纯数字 token——**但必须连带处理**：丢弃后可能使 `tokens` 为空，从而命中 §10.2 的「tokens.length === 0 → 返回双 null」，文本路整体变空（另一个方向的漏召） |
| **中文单字查询退化**   | 单个汉字无法构成 bigram                                                             | 只能走 `LIKE '%字%'` 兜底（§4.6 步骤 2a）                                                                                                                                                                               | 已有兜底路径；但该路径**无相关性排序**（统一 `normBm25 = 1.0`），结果质量弱于正常路径                                                                                                                                                          |

**为什么不用 trigram 解决拉丁文前缀问题**：见 §10.1——trigram 会让「猫粮」这类 2 字词直接召回 0 条，  
代价远大于收益。若将来确需英文前缀匹配，应引入**独立的拉丁词前缀索引**（如另一张 FTS5 表配 `prefix='2 3'`），  
而不是改动主分词器。

**这三条限制只作用于文本路**：向量路不经过 `tokenize`，上述三类查询若换个说法提出，  
语义路仍有机会命中。但**不要**因此把它们从「已知限制」降级为「已解决」——  
「精确查那个报错码」是向量天然的弱项，而它恰好是最常见的查询形态，  
文本路坏了就是坏了，向量路兜不住（§4.6 步骤 3 已把这点写成 normBm25 保留 0.20 的理由）。

---

## 11. 缺失项补充规约

### 11.1 时钟注入机制（Testing & Simulation）

凡**写入或依赖时间戳**的方法都支持可选入参 `now?: number`，缺省 `Date.now()`：

| 方法                | now 的用途                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `write`           | `created_at` / `last_access` / 初始稳定度 / `content_history.replaced_at`           |
| `recall`          | 强度与 recency 的计算基准（纯读，不改数据）                                                     |
| `touch`           | 间隔天数、`last_access`，以及 R-EDGE-TOUCH 强化证据边时的 `edges.last_active`                 |
| `link`            | `edges.created_at` / `last_active`                                             |
| `updateContent`   | `content_history.replaced_at`（归档旧正文的时间戳）                                       |
| `forget`          | `deleted_at`（**没有它就无法用注入时钟测 `sweep({purgeDeletedDays})` 的截止判断**）               |
| `sweep`           | purge 截止点 `cutoff = now - purgeDeletedDays × 86400000`（**这是它的首要用途**）、归档判定与统计基准 |
| `stats` / `get`   | 归档判定与统计基准（`stats` 的归档计数走 §9.4 的 `archival_schedule` 缓存，`now` 是判定基准）            |
| `clusters`        | 有效 affinity 的计算基准（决定哪些边存在）与 `asOf` / `computedAt` 快照时刻                         |
| `inhibitionTrace` | 与 `recall` 同一套时间基准（强度与 recency 的计算）                                            |

`pin` / `unpin` / `restore` / `setParams` / `setAlias` / `mergeEntities` 不接收 `now`：它们不写任何时间派生字段  
（`restore` 只把 `deleted_at` 置 NULL；`mergeEntities` 的 `edges.last_active` 取两条边中的较大者，  
不引入当前时刻；`setParams` / `setAlias` 的 `events.at` 用真实时钟，不参与计算）。

测试套件可通过步进 `now` 模拟数小时至数月的记忆演变，无需依赖真实时间。

★ **机器可检约束（C37）**：**凡方法体读写时间戳或参与时间计算的，签名必须含 `now?`；  
不接收 `now` 的方法必须在本表显式列出并写明理由**（本节已列全：`pin` / `unpin` / `restore` /  
`setParams` / `setAlias` / `mergeEntities` / `rebuildVectorBuckets`——最后一个的理由是「桶中心的  
`updated_at` 用真实时钟，且只用于观测（库级真相看 `vector_fine_cells.updated_at`）、不参与任何计算」，  
与 `setParams` 的 `events.at` 口径相同）。  
⇒ **实现者新增任何方法时，若它碰时间戳而本表没有它 ⇒ 契约校验失败**——  
这条把「时钟注入」从实现约定升级为**可被 CI 拦住的规则**，否则新方法很容易直接写 `Date.now()`，  
而那种方法**在测试里无法复现**（衰减、共激活、归档三条时间相关链路会一起失真）。

**向量同理：测试必须能注入确定性 embedder。** `MemoryConfig.embedder` 是同步签名，  
所以测试里塞一个「按字符哈希生成定长向量」的函数就能完整覆盖向量路，不需要任何模型或网络  
（归一化与校验由库统一做，见 §4.9 步骤 2）。**不要在测试里 mock 掉 `recall` 的向量分支**——  
那等于把要被验证的东西换成了桩。需要「余弦恰好等于 0.93」这类边界用例时，  
直接用 `write({ embedding })` / `recall({ queryEmbedding })` 传构造好的向量，比调阈值可靠得多。

### 11.2 错误类型体系

统一导出标准错误类 `MemoryError`：

- `MemoryError.READONLY_VIOLATION`：在只读实例执行写操作。
- `MemoryError.NOT_FOUND`：目标记忆或实体不存在。**逐方法列全，不用「等」省略**：  
  `forget` / `restore` / `updateContent` / `pin` / `unpin` / `touch` /  
  `link({createMissing:false})` / `linkByIds`（收 id 的接口必须自己校验，不能靠外键，  
  理由见 §4.5 步骤 4）/ `setAlias` 的 entityId / `mergeEntities` 的任一端；  
  **`link` / `linkByIds` 的 `memoryId`（记忆）同样必须自校验**——`edges.memory_id` 有外键，  
  不校验会把 `SQLITE_CONSTRAINT_FOREIGNKEY` 原样穿给调用方（见上「归一化收口」）。
  - `pin` / `unpin` / `touch` 对**软删**记录同样抛 NOT_FOUND（查询带 `deleted = 0`，见 §4.1 / §4.2）：  
    已遗忘的记忆不再接受强调与加固，不给「绕过遗忘悄悄复活」的入口。

|   |   |
| - | - |

|   |   |
| - | - |

- **`get` 刻意不抛 NOT_FOUND**：它返回 `MemoryView | null`（§6 / §4.1）。  
  单条读取是查看器与调试的高频操作，「查不到」是常态而不是异常；写成异常会让每次单条读取  
  都得包一层 try-catch。软删记录照常返回（`deleted = true`），只有硬删（行真的不存在）才返回 null。  
  —— 这一条与上面那批方法不是不一致：**读接口用返回值表达缺失，写接口用异常表达**。
- `MemoryError.INVALID_INPUT`：输入参数未通过校验（含 `pin` 的 factor 越界、`topN` 越界、  
  `link` / `linkByIds` 的**自环**（subject 与 object 解析到同一个 `entity_id`，见 §4.5 步骤 2）、  
  `schema` 版本不符、**向量校验失败**（长度 ≠ `EMBED_DIM` / 含 NaN 或 Inf / 模长为 0，§4.9 步骤 2）、  
  `setParams` 试图修改只读的 `EMBED_DIM`（§5）、  
  `setParams` 传入**越界或非法取值**的其它参数（§5 的参数取值范围）、  
  `mergeEntities` 两端解析到**同一个实体**、  
  `touch` 的 `coActivateWith` 校验失败（**三类**，见 §6 `touch` 的四条约束）：  
  ① `coActivateWith[].memoryId` 不在 `ids` 内；② `seedIds` 含它自己那条（自共激活）；  
  ③ `coActivateWith` 条目数超 `COACT_BATCH_MAX`（**硬拒，不是静默截断**）。  
  ⚠️ **硬拒类与静默类必须分清**：`COACT_BATCH_MAX` 超限是 `INVALID_INPUT`（抛错）；  
  而 `COACT_MAX_PAIRS_PER_TOUCH` 超限是**静默截断**（不抛错，计数写进事件与 `touch()` 返回值）——  
  两者不可合并成一条。  
  自环这一条按「校验失败」而非「静默跳过」处理：调用方以为关系建好了，实际这条边在扩散里  
  永远不产生邻居（§4.6 步骤 5），只占位不生效。  
  向量那两条同理，而且后果更隐蔽：**截断或补零都不报错**，只是这条记忆此后在向量路上  
  给出一个语义错位的分数。宁可让 `write()` 当场失败。
- `MemoryError.CONFLICT`：唯一性冲突。错误对象必须携带 `details.conflictingId`（或 `details.conflictingEntityId`），  
  否则调用方无法决定下一步。三个来源，全部是「唯一索引挡住的合法意图」：
  1. `restore()` 撞 `content_hash`（§4.8.1）→ 传 `mergeInto` 走合并；
  2. `updateContent()` 的新正文撞另一条未删记忆（§4.9.1 步骤 2b）→ 应改走 `write()` 或先清理重复项；
  3. `setAlias()` 的 alias 撞既有主名（§4.9.2）→ 说明该字符串已被占用为主名，需先 `mergeEntities`。
- `MemoryError.DATABASE_BUSY`：并发等待超时。
- ★ **归一化收口：客户端只看到规范化的错误结构**——  
  **任何 SQLite 原生错误码都不得穿给调用方**；它必须先被翻译成本节的**五个 code 之一**。  
  ⚠️ **五个 code 是封闭集合**：本库**不新增**第六个错误码——新增会破坏调用方对 `code` 的穷尽 `switch`，  
  且与 C36「同一语义不得有两套词」相悖。  
  ⇒ **兜底映射**（下面的清单之外，**不得原样穿出**；  
    ⚠️ 兜底是**最后一道网**，不是常态路径——常态路径是下面那份「必须自校验」清单）：  
  · `SQLITE_CONSTRAINT_UNIQUE` ⇒ `CONFLICT`（**必须带 `details.conflictingId`**）——§4.9 步骤 2 并发兜底、  
    §4.8.1 `restore` 撞 `content_hash`、§4.9.2 `setAlias` 撞主名。  
  · `SQLITE_CONSTRAINT_FOREIGNKEY` ⇒ `NOT_FOUND`（带 `details.missingIds`）——本库所有 FK 列都是 id 引用，  
    FK 违规的语义**就是**「被引用的行不存在」⇒ 与 `NOT_FOUND` 完全同义，**复用它，不另造码**。  
  · `SQLITE_BUSY` / `SQLITE_LOCKED` ⇒ `DATABASE_BUSY`——§9.1 的 `busy_timeout = 5000` 超时。  
  · `SQLITE_READONLY` ⇒ `READONLY_VIOLATION`——在只读句柄上执行写操作。  
  · **其余未列出的 SQLite 错误码** ⇒ **原样抛出，但必须带上 `code` 字段**（供日志定位）——  
    ⚠️ **不得硬塞进五个 code 里的任何一个**：语义未知的错误塞进某个 code，  
    会把调用方引向错误的处置（重试 / 改参数 / 查重），**比一个未类型化的错误更难排查**。  
  ⇒ **为什么 FK 不单列一个错误码**：FK 违规的语义与 `NOT_FOUND` 完全同义（被引用的行不存在），  
    单列 `FOREIGN_KEY_VIOLATION` 只会让同一件事有两个码 ⇒ 违反 C36。  
    ⇒ **但「不单列错误码」不等于「可以不管」**：FK 违规**必须被翻译**，  
    而让它**根本不发生**的办法是下面这份**自校验清单**——清单里的每条路径都**必须自己校验存在性**：  
  · `linkByIds` ⇒ `subjectId` / `objectId`（实体）与 **`memoryId`（记忆）**。  
  · `link` ⇒ **`memoryId`（记忆）**（两端实体由 `resolveEntity` 保证）。  
  · `setAlias` ⇒ `entityId`。  
  · `mergeEntities` ⇒ 两端 `entityId`。  
  · `touch` ⇒ `ids` 全部存在且未软删；`coActivateWith[].memoryId` 不在 `ids` 内 ⇒ `INVALID_INPUT`（见 §6）。  
  ⚠️ **「自己校验、不能靠外键」的两条理由**（§4.5 步骤 4 的原文，逐字适用）：  
  ① FK 报的是 `SQLITE_CONSTRAINT_FOREIGNKEY`，**未类型化** ⇒ 会原样穿到调用方；  
  ② `PRAGMA foreign_keys` 是**每连接**开关（§9.1），只要哪条连接漏开，  
  这里会**静默写入一条指向不存在实体的边**，之后扩散永远查不到邻居，且不报任何错。  
  ⚠️ **`link` / `linkByIds` 的 `memoryId` 是 §4.5 步骤 4 漏掉的一条路径**：  
    `edges.memory_id` 有 `REFERENCES memories(id)`（§3），而步骤 4 只校验了两端**实体** id ⇒  
    传一个不存在的 `memoryId` 会撞 FK ⇒ **必须自校验**（§4.5 步骤 4 与 §11.2 的 `NOT_FOUND` 清单都要补上它）。

**缺失的表达方式对照**（读接口用返回值、写接口用异常——这条边界必须能一眼看完）：

| 情形                  | 表达方式                                    | 涉及方法                                                                                                                                            |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标不存在，且方法必须成功才有意义   | 抛 `NOT_FOUND`                           | `forget` / `restore` / `updateContent` / `pin` / `unpin` / `touch` / `link({createMissing:false})` / `linkByIds` / `setAlias` / `mergeEntities` |
| 目标不存在，但「查不到」是该接口的常态 | **返回 `null`**（不抛错）                      | `get`                                                                                                                                           |
| 参数不合法               | 抛 `INVALID_INPUT`                       | 全部写方法 + `recall` / `setParams`                                                                                                                  |
| 唯一性冲突               | 抛 `CONFLICT`（带 `details.conflictingId`） | `restore` / `updateContent` / `setAlias`                                                                                                        |
| 只读实例上的写操作           | 抛 `READONLY_VIOLATION`                  | 全部写方法                                                                                                                                           |
| 主体工作做成了，但附属产出未生效    | **不抛错**，走 `write()` 的 `warnings`        | `write`（别名冲突 `ALIAS_CONFLICT`；别名目标未关联 `ALIAS_TARGET_NOT_LINKED`）                                                                                                                  |

**`ALIAS_CONFLICT` 刻意不是异常，而是 `write()` 返回值的 `warnings`**（§6 `WriteWarning`）：  
异常意味着「本次调用什么都没做成」，而别名冲突时**记忆本身已经写成功**，只有附带的别名映射没落库。  
若把它当 `CONFLICT` 抛出，调用方会重试 `write()`，结果是同一事实被写两遍——  
用一次静默的数据冗余，换一个看起来更「严格」的错误码。两者边界：

- 异常 = 主体工作没做成，调用方应重试或改参数；
- warning = 主体工作做成了，但有一项附属产出未生效，调用方需据此调整后续行为（例如显式调 `setAlias`）。

★ **`ALIAS_TARGET_NOT_LINKED` 同属这一类**（ADR-P1-T07-DEC D-3/R2；§4.9 步骤 1c）：  
它是「**边界可以存在，但必须可观测**」的产物——「别名目标实体建了、但**不**与本条记忆关联」是**有意**的边界  
（关联只由 `input.entities` 表达 ⇒ §14.3 边界原则 1：每个承诺都要能指到唯一代码路径），  
但它的代价是「只声明别名、不点名实体」的调用方**静默达不到召回目的** ⇒ 必须让它**看得见**。  
⇒ 它**不是错误**、**不抛错**：主体工作（写入这条记忆 + 挂上别名）**已经做成**，  
只有「这条记忆与该实体的关联」没有建立 ⇒ 与 `ALIAS_CONFLICT` 同属「附属产出未生效」，同走 `warnings`。  
⚠️ **两个码不是同一类**（别混）：  
  · `ALIAS_CONFLICT` = 「**没建成**」——别名撞了别人的主名 ⇒ 本次别名映射**没落库**；  
  · `ALIAS_TARGET_NOT_LINKED` = 「**建了但没连上**」——实体**建出来了**（别名也挂上了），  
    只是**没与本条记忆建立关联** ⇒ 库里的数据是完整的，缺的是**调用方没声明的那条关联**。  
⇒ 调用方对两者的处置**不同**：前者要改映射（或显式调 `setAlias`），后者要**补 `input.entities`**。  
⚠️ **三处必须同步**（漏一处门禁就红，`scripts/check-contract-ids.ts` 会逐名比对）：  
`src/core/errors.ts` 的 `WARNING_ONLY_CASES`、`scripts/check-contract-ids.ts` 的 `EXPECTED_WARNING_ONLY_CASES`、  
以及**本表最后一行**（`ALIAS_TARGET_NOT_LINKED` 必须写在反引号里，门禁才读得到）。  
⇒ 另有一条**方向相反**的守卫（工程师-2 的「源码实发 warning code ⊆ 白名单」）：  
它查的是「**白名单 ⊇ 实发**」⇒ **白名单里有、但当前没有实发点**的码**不会**报错  
⇒ 登记新码时不会因为「还没有实发点」而踩坑。  
⇒ ⚠️ **本表最后一行是「机器读的名册」**（门禁在解析它 ⇒ 门禁能看见它）⇒ 守卫是**双向**的：  
  · 「**白名单 ⊆ 本行**」——少一个码就报红；  
  · 「**本行的码形态项 == 白名单**」（码形态 = **首字母大写** + 只含大写字母/数字/下划线）  
    ——**多**一个码（陈旧码名）也报红。  
    ⚠️ 那一列**合法地**含方法名（`write`，小写开头）⇒ 按**形态**过滤后被**天然排除**，不会误伤；  
    ⚠️ 但**小写的多余词**（例如某个陈旧的方法名）**不在**这两个方向的覆盖内 ——  
    那一列是「涉及方法」列，多写一个方法名在语义上**不算错**（将来某个 warning 也许由别的方法产出）。  
⇒ 三个方向合起来才闭环：**源码实发 ⊆ 白名单 == 本行的码形态名册**。

### 11.3 备份与恢复

- 支持调用 SQLite 原生 `VACUUM INTO '<backup-path>'` 创建安全在线快照，无需停机。
  - **这是唯一推荐的备份方式**。直接拷贝 `.db` 文件在 WAL 模式下是**不一致**的  
    （最新事务还在 `-wal` 里，单拷主文件会丢最近的写入）；要文件级备份就必须连  
    `-wal` / `-shm` 一起拷，且期间不能有写入。
  - `VACUUM INTO` 产出的是一个**独立的完整数据库**（已压实、无 WAL 残留），  
    但它的 `journal_mode` 是默认的 `delete`——**恢复后要重新执行一次 §9.1 的「A. 写连接」那套 PRAGMA**  
    （`journal_mode` / `synchronous` / `busy_timeout` / `foreign_keys`；只读连接那套 §9.1 也已列明），  
    否则那个库不再是 WAL，读写并发能力与崩溃一致性的前提都变了。
  - 备份文件不含 `logs/` 文本流水。要完整留证需一并拷走 `<数据目录>/logs/`。
- 维护操作 `sweep({ vacuum: true })` 在**硬删清理确实发生了**（`purged > 0`）之后才执行空间回收，  
  并在完成时统一触发 FTS 重建 `INSERT INTO mem_fts(mem_fts) VALUES('rebuild')`。  
  `purged = 0` 时整段跳过——理由与判定见 §4.10 步骤 3。

#### 11.3.1 备份 / 恢复 / 校验 runbook

```
【备份】
  1. **不需要停写**（`VACUUM INTO` 是在线快照，自带一致性）。
     ⚠️ **唯一禁忌：不要直接 cp 一个正在写的 .db 文件**——
       WAL 里的已提交事务不在主文件里，裸拷会得到一个**不一致**的副本
       （§11.3）。若确实要做文件级备份，必须**连 `-wal` / `-shm` 一起拷，且期间不能有写入**。
  2. 用 SQLite 的一致性快照，而不是文件复制：
       VACUUM INTO 'backup/ocean-YYYYMMDD.db';
     —— 这条**自带一致性**，不需要停写（★ 本 runbook 的**唯一推荐路径**）。
     ⚠️ `VACUUM INTO` 中途失败（磁盘满等）会留下**半截文件** ⇒ 必须先删掉残件再重试，
       绝不能把半截文件当成有效备份（备份失败要**显式失败**，不能静默产出坏档）。
  3. 同时备份 logs/ 目录（人类排障用，不影响一致性）。
  4. 记录版本：PRAGMA user_version（v2 = 2）+ 应用版本 + 当时的参数快照
     （stats() 的 config 事件里有完整 params 快照）。
  5. ★ **备份成败要有人看**：跑完 `VACUUM INTO` 后对产物做
       PRAGMA integrity_check;          -- 期望 ok
     并登记产物的尺寸与校验和。**没有校验的备份只是一份文件，不是一份备份。**

【恢复】
  1. 停写进程。
  2. 把备份文件放回 <library>/ocean.db。
     ⚠️ 若恢复源是**文件级拷贝**（连 `-wal`/`-shm` 一起拷的），必须**删掉残留的 -wal / -shm**，
       否则旧 WAL 会与新主文件不一致；
       若恢复源是 **`VACUUM INTO` 产物**（本 runbook 的推荐路径），它自带完整状态、无 WAL 残留，
       **不需要**这一步。
  3. 开库后**必须**重设 §9.1 的 A 套 PRAGMA（WAL / synchronous / busy_timeout / foreign_keys）——
     ⚠️ **备份文件不带 PRAGMA 设置**，不重设就不是 WAL 模式。
     ⇒ **建议在 `open()` 里加一条断言**：`PRAGMA journal_mode` 读回不是 `wal` 就告警/抛错——
       `VACUUM INTO` 产物是 `delete` 模式，忘了重设就不再是 WAL，并发与崩溃一致性的前提都变了。
  4. 跑一次完整性自检：
       PRAGMA integrity_check;          -- 期望 ok
       PRAGMA foreign_key_check;         -- 期望空
       调 verifyIntegrity()              -- 看 archivalOrphans / archivalMismatch / bucketCoverage
  5. ★ **桶归属与归档缓存的可重建性**：
       · vector_cell_members / vector_fine_cells / vector_coarse_cells
         ⇒ **可从 memories.embedding 重建**（rebuildVectorBuckets()）
       · archival_schedule ⇒ **可从 memories 重算**（rebuildArchivalSchedule()）
       · clusters / theme_cluster_members ⇒ **可从 coacts 重算**（recluster()）
       · **coacts ⇒ 半可重建**：`affinity` 与 `last_active` 可由 events 的 `coactPairs`
         重放（§8.4 规则 3），但 **`coact_count` 不可重建** ⇒ 硬删会让这段历史永久缺失
         ⇒ **硬删前必须先做一次备份快照**（本节【备份】步骤）——
           ⚠️ 这就是本库的 **RPO 口径**：**「硬删前的备份」是唯一的不可逆分界线**，
           除它之外的一切（桶 / 归档 / 簇）都可重建。
     ⇒ 结论：**必备份 = ocean.db（含 coacts）+ logs/；其余可在恢复后重建。**

【校验（每次恢复后必做）】
  - integrity_check / foreign_key_check / verifyIntegrity() 三项全绿；
  - 抽 200 条记忆调 get()，正文与备份快照逐字一致。

【保留策略】
  - 保留最近 N 份（N 由磁盘定，默认 7）+ 每月 1 份归档一年；
  - ★ **不要按「总量」轮转**：单份备份就是整库，轮转粒度只能是「份数」。
```

### 11.4 参数调优策略（明确「不自动调参」）

「基于归档率与访问指标的动态调参」是一个没有定义的承诺。这里给出明确结论：

**决策：本库不实现自动调参（no auto-tuning）。** 理由：

1. 自动调参需要稳定的优化目标（什么算「召回变好」），而记忆召回的质量无法在库内部闭环度量——  
   只有调用方知道某条记忆有没有用上、有没有说错。
2. 参数变更会改变全部历史数据的解读方式（比如 `ARCHIVE_LINE` 一变，归档集合就变了），  
   自动调整等于让系统悄悄改写自己的判断标准，不可审计。

**替代方案（人工调参 + 可回滚）**：

- 库只提供**观测指标**，由 `stats()` 与查看器暴露（**9 项**）：

1. `l3Count` / `l2Count` / `l1Count` / `archivedCount`（层级分布，§4.4）
2. `avgStability` / `medianStability`（稳定度分布）
3. `touchRate7d`（★ **近期采纳频率** —— 与 `adoptedMemories`（累计采纳面）**互补不冗余**：**它是唯一会掉到 0 的那个** ⇒ **簇失效的先行指标** ⇒ 面板两个都要展示）
4. `mergeRate`（合并率）
5. `graphDensity`（实体关联密度）
6. `embeddedRatio`（向量覆盖率）
7. `adoptedMemories`（★ **采纳密度**——§0.2 前提的唯一测量口）
8. `archivalOrphans` / `archivalMismatch`（★ **归档缓存自检**——§9.4.4 护栏①；  
   **必须是常设**（每次 `stats()` 都算），不能只在 `verifyIntegrity()` 里  
   ⚠️ **与 `verifyIntegrity()` 的同名字段共用同一实现**（§6 的 `MemoryStats`）
9. `coactWriteDrops`（★ **共激活漏记计数**——累计被截断 / 跳过的关联数；  
   **持续偏高 = 联想路在「边喂边漏」**，是调用方唯一能程序化发现的漏记信号）  
   ⇒ 否则护栏①不可达）

- **调向量相关参数之前，先看 `embeddedRatio`**：覆盖率低于 1 时，召回变差的第一嫌疑是「根本没向量」，  
  不是 `VECTOR_MIN_COS` 太大。先去回填（§4.9 步骤 2），再去调阈值——  
  这条顺序写在这里，是因为「覆盖率 0.5 却去调阈值」是最容易发生的误诊。
- 人据此判断是否调参，通过 `setParams({...})` 注入新值。
- 每次 `setParams` 写一条 `events(type='config', payload={ SCHEMA_VERSION, params, changed })`：  
  `params` = **变更后的完整生效参数**，`changed` = `Array<{ key, from, to }>`（本次改了哪几个）。  
  构造时同样记一条，但**只有 `SCHEMA_VERSION` 与 `params`**（那时还没有「变更」）。
- **回滚** = 把相关 key 改回原值并再记一条 `config` 事件；因为事件流完整，  
  重放到任一时点都能复现当时的参数与判定结果。
- **v2.0 新增：共激活类参数的调参指引**（v1.0 的通用原则不适用于这一组）：  
  共激活相关参数（`COACT_*` / `CLUSTER_*`）**长期调不出效果时，先看调用方的采纳策略，  
  不要去调阈值**。原因是共激活数据由 `touch` 的 `coActivateWith` 声明喂养——  
  **随机采纳喂不出簇**：若调用方每次 touch 的记忆之间没有真实的主题关系，  
  共激活表里积累的全是噪声，调任何阈值都只是在噪声里挑得更精细。  
  正确诊断顺序：① 看 `clusters().coverage`（有簇记忆 / 被 touch 过记忆）；  
  ② 若覆盖率长期上不去，看调用方是否在声明 `coActivateWith`；  
  ③ 若覆盖率正常但簇的语义不纯，看 `clusters().largestClusterRatio` 是否过大（§4.12.4 ③）。  
  ⚠️ 它是**切分后**口径（与气泡同口径）⇒ 恒 ≤ `MAX_CLUSTER_SHARE` 是**正常**的；  
  「曾有过多大簇」要看 `clusters().splitInfo.originalRatio`。。  
  ⚠️ **这三项都不在 `stats()` 里**——`stats()` 不得扫 `coacts`，  
  它回答的是「当前状态」，而簇是带 `computedAt` 的派生快照。
- **唯一的「自适应」保留项**：`sweep()` 只做统计与清理，**不改任何参数**。  
  若将来确实要引入自动调参，必须先定义可量化的目标函数并单独写一节，不得隐含实现。

---

## 12. 实施路线图

> **v2.0 的阶段划分与 v1.0 最大的不同**：v1.0 是「功能堆叠式」（存储→图谱→生命周期→查看器），  
> v2.0 改&#x4E3A;**「先立不变量、再建机制」**——  
> 因为新架构的正确性依赖三个可验证的不变量（关掉新机制后行为与 v1.0 逐位一致、  
> 簇不落库可重建、桶归属缺失只漏召不错召），它们必须**先于**机制本身被建立，  
> 否则机制写完了也无法证明它没破坏既有行为。
>
> ⚠️ **版本号口径（本节的「v2.0」指什么）**：  
> **本文档的交付版本号是 v2.1**（ADR-22：v2.0 是从未发布的设计稿，不给版本号）。  
> 但本节及全文大量使用「**v2.0 新增**」作为**特性标记**——  
> 意思是「相对 v1.0 的这一批新增能力」，**不是**「发布了一个叫 v2.0 的版本」。  
> ⇒ **读法**：全文的「v2.0 新增」=「v2.1 相对 v1.0 的新增」；  
> 真正作为**版本承诺**出现的只有：文档头与 §9.1 的 **v2.1**、以及 schema 版本号 **2**。  
> ⚠️ 这条必须写明，否则读者无法判断「交付物到底叫 v2.0 还是 v2.1」——  
> 而版本号是**对用户的承诺**，不是内部计数器（ADR-22 原话）。

```
阶段 0：不变量与骨架（**新增阶段，v2.1 特有**）
  - 特征开关（feature flags）：coactivation / inhibition / writeBack / ARCHIVAL_CACHE 四个开关，
    运行时可关。**关掉后行为必须与 v1.0 逐位一致**——这是本次重构的验收基线。
  - 事件流扩展：events 的 touch 载荷增加 stabilityDelta / coactPairs / coactPairsTruncated /
    activationWrites / coactSkipped 五个键，
    **不新增 events.type**（理由见 §13 的 ADR-15）
  - 参数表扩充：29 → 60 项（§5），含跨参数校验（§5 的 8 条）
  - 单测：四个开关各关闭时，召回结果与 v1.0 参考实现逐位一致
  ⚠️ 本阶段**不实现任何新机制**，只建开关与不变量测试。
     没有这个阶段，后面每个机制的「没改坏别的东西」都无法证明。

阶段 1：存储与基础运算（承接 v1.0 阶段 1）
  - Schema 初始化（memories, entities, entity_aliases, memory_entities, edges,
    content_history, events, mem_fts + **coacts, theme_clusters, theme_cluster_members,
    cluster_snapshot_meta,
    vector_coarse_cells, vector_fine_cells, vector_cell_members,
    **archival_schedule, cluster_snapshot_meta, meta** + 全部触发器与索引）
  - tokenize() 与 buildMatchQuery()
  - 记忆本体的读写：write() / recall() / touch() / get() / pin() / unpin()
    （coactivation 开关关闭时，touch 的 coacts 写入路径必须完全短路）
  - 自动化单测覆盖：衰减曲线、间隔重复、实体多对多关联、长短句检索

阶段 2：向量分桶与路由（**v2.0 的性能前提**）
  - VectorBackend 接口 + 主库内两级 k-means 分桶实现（§4.15.2 / §4.15.3）
  - 分桶训练与增量维护：建库时训练一次（1~3 分钟），新记忆入最近细桶（§4.15.5）
  - 桶归属与主表**同事务**写入——失败即回滚，不留「记忆在、桶不在」的孤儿（§9.3.2 ①）
  - 写入路径的去重候选改为「向量分桶 + 内容哈希桶」粗筛（≤2000 条候选，§4.9 步骤 3a2）
  - 启动对账（防御性，§9.3.2 ③）与桶质量退化时的全量重训（§9.3.2 ④）
  - **分桶吻合率验收**：用 flat 全表扫描作参照，断言「分桶的 top-20 与 flat 的 top-20
    **吻合率 ≥ 0.98」**（§4.15.4）。⚠️ **不可写成「完全相同」**——探针边界上的候选
    确实会不同，写死「完全相同」会让实现者以为「有个小 bug 导致结果不一致」。
  - **训练期资源门槛**：建库训练（100 万 × 768 维）**峰值内存 ≥ 3.5GB**
    （全部向量 3.07GB + 桶中心 30MB + 距离矩阵）⇒ **低配机器建库时要有心理预期**；
    日常运行只需桶中心常驻 30MB + SQLite 页缓存。
  - 性能门槛验收（★ **改造后**，**且必须在 100 万条规模下验收**——小库上测出的 P99 没有意义）：
    recall P99 ≤ 200ms；写入 P99 ≤ 5ms；
    **向量路 P99 ≤ 20ms 且占总耗时 ≤ 20%**（改造后向量路**不再是**瓶颈）。
    ⚠️ **不可写成「向量路耗时占比 ≥80%」**：按 §4.15.3 的数字，向量路 ≈ 5ms、
    recall 门槛 200ms ⇒ 占比 ≈ 2.5%。「≥80%」是**改造前**用来证明瓶颈位置的测量值，
    写成改造后的静态验收条件会与 P99 ≤ 200ms **在同一行里互斥**。
    ⚠️ **规模必须写进验收行**：不写「100 万条」⇒ 实现者可能在小库上测得 P99 达标就放行，
    而小库根本走不到分桶路径（`ROUTER_MIN_TRAINING`）——那样的验收**什么都没验到**。
  - **前置测量（阶段 2 开工前，随 flat 基线一起采）**：flat 路线下向量路耗时占比 ≥ 80%
    —— 这是「为什么要上分桶」的证据，不是验收条件。

阶段 3：神经元交互（**第五概念**）
  - coacts 的写入（只在 touch 路径，§4.11.2）与衰减淘汰
  - 主题簇的涌现：调用方调度 `recluster()` + 快照发布（§4.12.2）
  - 侧抑制的纯筛选三桶算法与逐对判据（§4.13.2 / §4.13.3）
  - 簇跳扩散（§4.14.2）
  - 簇快照的物化与查询接口 clusters()（§6）
  - 单测覆盖：共激活强化不震荡、侧抑制不误杀、簇分裂/合并、抑制关闭后与 v1.0 逐位一致

阶段 4：生命周期、事件重放与可观测性（承接 v1.0 阶段 3）
  - 遗忘与撤销：forget() / restore()（含 mergeInto）
  - 正文修正与参数变更：updateContent() / setParams()
  - 观测与维护：stats()（§11.4 的 9 项调参指标）/ sweep()（含共激活淘汰）/ close()
  - 事件流追加与历史重放回溯工具
  - 观测指标面板（归档率、**采纳密度**（原「touch 率」—— 见 §11.4，touch 率已并入采纳密度）、
  merge 率、stability 分布、向量覆盖率、簇覆盖率、**共激活覆盖率**）
  - 打分权重的真实查询回归：用真实查询集验证 §4.6 的五项权重
  - content_history 保留策略（沿用 v1.0 的取舍前置，§12 末尾）

阶段 5：只读查看器与服务集成（承接 v1.0 阶段 4）
  - Electron 只读观察器 UI（**§7.2 的 7 个面板全量**：
  总览与层级分布 / 记忆列表与单条详情 / 召回模拟器 / 图谱可视化 /
  只读日志查看（二级面板） / 版本历史 / 主题簇导航（礁石图））
  - MCP Server 协议封装（最小集：write, recall, touch, link, forget, restore；
    维护类 updateContent / setAlias / mergeEntities / sweep / clusters 按需暴露）
```

**方法覆盖核对（§6 的公开方法逐个归位，不留「以后再说」）**：

| 阶段 | 公开方法                                                                                                           | 小计 |
| -- | -------------------------------------------------------------------------------------------------------------- | -- |
| 0  | 不新增方法（只建开关与不变量测试）                                                                                              | 0  |
| 1  | `write` / `recall` / `touch` / `get` / `pin` / `unpin` / `link` / `linkByIds` / `setAlias` / `mergeEntities`   | 10 |
| 2  | `rebuildVectorBuckets`                                                                                         | 1  |
| 3  | `clusters` / `inhibitionTrace` / `recluster`                                                                   | 3  |
| 4  | `forget` / `restore` / `updateContent` / `setParams` / `stats` / `sweep` / `close` / `rebuildArchivalSchedule` | 8  |
| 5  | `verifyIntegrity`（随 §7 的只读查看器一起交付）                                                                             | 1  |

合计 **23 = §6 `MemoryStore` 的方法总数**（v1.0 是 17，v2.1 净增 **2 个只读方法**——`clusters` 与  
`inhibitionTrace`；`clusterSnapshot` 已合并进 `clusters`，**不另计**——加 **4 个维护方法**  
`rebuildArchivalSchedule` / `rebuildVectorBuckets` / `recluster` / `verifyIntegrity`）。  
⚠️ **行级小计之和必须等于 23**：这张表的存在意义就是「给 §6 加方法时，必须同时给它在某个阶段  
找到位置」，否则它会以「接口有、路线图没有」的形式漏掉——**表自己漏掉方法，等于示范了它要防的缺陷**。  
★ `recluster` 归阶段 3（与簇能力同批验收）、`rebuildArchivalSchedule` 归阶段 4（与归档缓存同批）——  
两者都是**阻塞 1~3 分钟的维护方法**（§4.15.5 / §9.4.4），不早于依赖它们的机制交付。

> ⚠️ **两个只读导航方法归阶段 3 而非阶段 1**  
> （主题簇要靠共激活数据算，共激活是阶段 3 的能力）。把它们放阶段 1 会得到永远返回空数组的方法。  
> ⚠️ `inhibitionTrace` 虽然在 `coactivation` 开关关闭时仍可用（它不依赖共激活），  
> 但它必须与 `recall` 走**同一段打分代码**——否则「trace 看到的」与「recall 实际发生的」会漂移。  
> ⇒ 它的实现随打分器一起交付，不早于阶段 1，但**归位在阶段 3**（与打分器同批验收）。

**阶段 4 的取舍前置（`content_history` 裁剪）**（沿用 v1.0 的裁决，未变）：  
§4.9 说明块把「`content_history` 完整保留每一版」当作**放弃长度比较之后的唯一兜底**。  
一旦按「保留最近 N 版」裁剪，这条兜底就自动降级为「最近 N 版之内可还原」——两者不可能同时成立。  
动手前必须先二选一：

1. **不裁剪**，接受 db 文件单调增长（当前选择）；
2. **裁剪**，则必须同时把 §4.9 说明块的兜底措辞降级为「最近 N 版内可还原」，  
   并把 `N` 登记进 §5 参数表（不得硬编码）。

**阶段 4 的实现期跟踪项（本轮审查沉淀，归 QA 跟踪，均非实现前阻塞）**：

1. **C37 的机械扫描要进 CI**：C37 要求「凡读写时间戳或参与时间计算的，签名必须含 `now?`」。  
   ⇒ **在 CI 里加一条静态扫描**：命中 `Date.now()` / `new Date()` / `performance.now()` 的实现文件，  
   若所在方法签名无 `now?`、且该方法未在 §11.1 的豁免清单里 ⇒ **失败**。  
   ★ **分母必须是写死的期望值**（如「允许 `Date.now()` 的文件数 = 3」），  
   **不能用「本次实际命中几个」当分母**（C31 的同一条纪律在扫描场景的翻版）。
2. **性能验收需要可复现的语料与固定的 embedder**：§12 阶段 2 的 P99 门槛  
   （recall ≤ 200ms / 写入 ≤ 5ms / 向量路 ≤ 20ms 且占比 ≤ 20%）  
   **必须配一套可复现的验收基线**，否则同一份代码两次跑出不同结论：
   - **100 万条语料 + 固定随机种子**（同一 seed ⇒ 同一批文本、同一批实体、同一批查询）；
   - **固定的 embedder**（同一模型 + 同一版本 + 同一 batch 切分 ⇒ 同一批向量）。  
     ⇒ **两者任一不固定，P99 门槛就不可判定**——它测的是「语料 + 模型 + 机器」的组合，  
     不是「代码」。⚠️ 这条**不阻塞实现**，但**阻塞「性能达标」的结论**。

---

### 12.1 回归与迁移的三条硬约束

**① 权重回归必须在分桶路由与联想路落地之后做。**  
顺序：阶段 2（分桶路由）→ 阶段 3（神经元交互）→ 阶段 4（五项权重真实查询回归）。  
★ **正确的理由**：回归的对象是「**这组权重配这组候选集**」；  
候选集变了，同一组权重的表现就变了 ⇒ 必须在最终候选集形态上回归。  
⚠️ **不是**因为「medianBm25 变了」——  
`bm25List` 只收 `raw_bm25` 非空的候选（即只收文本路命中的），  
而文本路（FTS5）独立于向量后端，也独立于联想路  
（联想路注入的候选 `raw_bm25` 为 `null`，不参与中位数）  
⇒ **median 基准逐位不变** ⇒ 每一条候选的五因子分逐位不变。  
⇒ 分桶与联想路改变的是「**谁参与竞争**」，不是「分数怎么算」。  
⚠️ **理由写错比结论写错更危险**：后来者会照着错理由去论证  
「那分桶一定会让分数不可比」，然后推翻掉一条其实成立的结论。

**② golden 回归集只锁 top-N 的 id 序列，不断言 score 绝对值。**  
也不断言 `rawBm25` / `cos` 这两个原始证据字段。  
★ **理由**：FTS5 的 `bm25` 依赖语料统计量 `total_docs` / `avgdl`，  
每写入一条新记忆这两个量就变 ⇒ `raw_bm25` → `medianBm25` → `normBm25` 全链路漂移。  
**这是 v1.0 就有的性质，不是新机制引入的。**  
依据：§4.6 的注释「`normBm25` 只决定候选**内部**的相对排序陡缓」——  
**排序才是稳定契约，score 绝对值不是。**  
⇒ 回归集按「**语料快照 + embeddedRatio 档位**」双重分档，每档重新采集一次命中序列。

**③ 迁移验收的口径（v1.0 → v2.1）**：

| 对象                                                     | 门槛                                                  | 说明                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `diffused`                                             | **逐位相同**                                            | `coacts` 从空表开始 ⇒ 簇补全不产出 ⇒ 退化为纯实体边扩散 = v1.0 行为                                                                                              |
| `hits`                                                 | 成员 Jaccard ≥ 0.90 + **各【非向量】分项逐位相同**（`cos` 不计入逐位相同） | **差异只来自向量后端（flat → 分桶探针边界），不来自共激活**。⚠️ 「逐位相同」只对**非向量分项**成立：切换分桶探针数时 `cos` 必然变化，把它算进「逐位相同」会让断言**在边界情形下假失败**（C30）。集合层面的差异由 Jaccard ≥ 0.90 吸收 |
| `memories` 全字段 / `embedding` SHA-256 / `edges` 权重 / 行数 | **零差异**                                             | 迁移不得触碰任何一行                                                                                                                                 |
| `events`                                               | **恰好 +1 条**（`type='config'`）                        | 含新 `SCHEMA_VERSION` 与完整 `params`                                                                                                           |
| `coacts`                                               | 0 行                                                 | v1.0 历史事件里没有共激活数据 ⇒ **数据不存在，不能回填**                                                                                                         |

⚠️ **不能笼统写「hits 与 diffused 双双零差异」**——  
那个结论只在「**同一向量后端下**」成立。迁移若同时切分桶探针数，`hits` 的差异就存在。

## 13. 设计决策记录（ADR 摘要）

文档里若有开放问题在讨论中消失了，但「消失」不等于「已决定」。这里逐条给出明确结论，  
避免实现者自行猜测、或后来者以为漏写。

| #          | 议题                     | 决策                                                                                                                                                                                                                                                                                                                                                 | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR-1      | **多租户**                | **不做。单用户单库（一个 db 文件 = 一个记忆库）**                                                                                                                                                                                                                                                                                                                     | 记忆是强个人隐私数据，租户隔离一旦做错就是数据泄露。需要多用户时，由上层为每个用户开独立 db 文件，库本身不引入 tenant_id 维度（否则所有索引与去重唯一约束都要加前缀，复杂度陡增）                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ADR-2      | **实体抽取归属**             | **由调用方提供，库不内置 NER**                                                                                                                                                                                                                                                                                                                                | 库内做 NER 需要绑定特定模型与语言，且抽取质量无法在库内闭环评估。`write(input.entities)` 与 `recall(options.entityIds)` 都接受外部结果，库只负责归一（别名）与存储。调用方不传就退化为纯文本检索，功能仍完整                                                                                                                                                                                                                                                                                                                                                                                |
| ADR-3      | **是否内置自动调参**           | **不做**，只提供指标与建议（详见 §11.4）                                                                                                                                                                                                                                                                                                                          | 见 §11.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ADR-4      | **语音/图像理解**            | **不在库内做**。多模态只存 `media_ref` / `media_type` 与降维后的文本                                                                                                                                                                                                                                                                                                 | 库的职责是「记住并想起」，不是「看懂」。ASR/视觉理解由调用方完成后以文本写入                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ADR-5      | **API 同步 or 异步**       | **全部同步**（better-sqlite3）                                                                                                                                                                                                                                                                                                                           | 单进程本地库，异步只会带来无意义的 Promise 开销与写锁竞争；需要异步的场景由最外层包装（§6 开头）                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ADR-6      | **是否需要向量检索**           | **需要，作为第三路并入，不替换现有两路；100 万条起向量路走两级分桶路由（主库内 IVF）**                                                                                                                                                                                                                                                                                                  | 三个必要条件都已具备：①「需要额外 embedding 模型」——模型不进库，由调用方提供（ADR-10）；②「需要额外索引与相似度计算」——v2.0 引入两级 k-means 分桶（§4.15、§9.3）；③「与可解释性冲突」——恰恰相反，向量只产出一个标量 `cos`，连同加权后的 `vectorPart` 一起写进 `breakdown`，比任何黑箱重排都更可解释。**只作第三路并入**：文本路权重保留 0.20，没有删除。⚠️ **v2.0 撤销了本 ADR 原文的「只做 flat 精确扫描」**：flat 在 100 万条下需 500~1500ms，越过 §12 的 P99 ≤200ms 门槛。但「替换点限定在取候选 + 排序那一处实现内」的可替换性承诺**继续有效**。⚠️ **同时撤销「引入 ANN」**：见 ADR-16 与 ADR-33。                                                                                                                    |
| ADR-7      | **跨设备同步**              | **不在库内做**。库是单机文件                                                                                                                                                                                                                                                                                                                                   | 同步涉及冲突解决（同一记忆在两台设备被改动），这属于上层应用问题。库只保证「单机一致性」与「可导出快照」（§11.3）。⚠️ **「单机文件」指没有 sidecar 索引文件**（向量桶归属在主库表里）——**不等于「裸 cp .db 就是备份」**：WAL 下裸拷不一致，唯一推荐的导出方式是 `VACUUM INTO`（§11.3.1）                                                                                                                                                                                                                                                                                                                                         |
| ADR-8      | **归档记忆的最终归属**          | **永不自动物理删除**；物理删除只有三处显式入口——`forget({hard:true})`、`sweep({purgeDeletedDays})`、`restore({mergeInto})`（逐条列清见 §14.3）                                                                                                                                                                                                                                   | 「淡忘」是降权而非销毁；自动清理会让用户失去「很久以前的事突然想起来」的可能，而这正是记忆库的价值。**第三处不能漏**：`restore({mergeInto})` 在撞唯一索引后会物理删除待恢复的那一行，它同样是不可回的「行消失」——原先只写两处，与已修正的 §14.3「三处」直接矛盾，而 §14.3 恰恰引本行作为依据                                                                                                                                                                                                                                                                                                                                                |
| ADR-9      | **合并时正文采纳哪一版**         | **无条件采纳新文本**（旧正文先归档进 `content_history`），**不做长度比较**                                                                                                                                                                                                                                                                                                 | 取向定为「**当下最准**」而非「信息量最大」。在「只查 `memories` 与 `mem_fts`」的召回架构下，`content_history` 对下游完全不可见，所以「保留信息量更大的版本」实际实现的是「旧版本胜出」；且调用方是 LLM 抽提、提炼天然精简，长度规则会**系统性**偏袒旧版，再叠加每次合并都按 `DEDUP_BOOST` 加固 stability，等于让过期正文越错越牢。代价（正文可能被低质量抽提逐步劣化、`content_history` 单调增长、旧版本只能经 §7.2 面板 6 查看）与观测手段见 §4.9 说明块                                                                                                                                                                                                                               |
| ADR-10     | **向量由谁产生**             | **由调用方提供**。库内不接任何模型、不读环境变量、不发网络请求；只提供可选的**同步**注入点 `MemoryConfig.embedder`                                                                                                                                                                                                                                                                          | 与 ADR-2（不做 NER）同构：一旦绑模型，就要绑语言、绑 API key、绑版本兼容与计费，而库的定位是嵌进别人的应用里。更要命的是与 ADR-5（全同步）的冲突——内置 provider 必然要发 HTTP，那会让 `write()` 从同步退化成**事实上阻塞**的调用，或者在库里塞一个无法解释的异步边界。所以模型层留在库外：调用方取好向量再传进来，或注入一个本地同步函数。代价是**开箱不能语义检索**，必须接一次 embedder——这个代价写在这里，不藏                                                                                                                                                                                                                                                                       |
| **ADR-11** | **「神经元交互」的定位**         | **第二引擎（网络驱动）**，与遗忘曲线（时间驱动）并列。框架为「**三属性 + 两引擎 + 一涌现层**」（§2 与 §0 已按此口径对齐）                                                                                                                                                                                                                                                                            | 共激活、侧抑制、激活回写这三件事**没有一件能由单条记忆独立决定**——它们全部是「记忆与记忆之间」才成立的耦合关系。因此它是机制层，不是存储层。★ **结构性理由**：它的载体是 `coacts` 表，**不在 `memories` 行里**（§1「它没有独立的存储列，除了一张共现表」）⇒ 它天然不是「一条记忆自身的属性」。**这是本次重构的定盘星**                                                                                                                                                                                                                                                                                                                                 |
| **ADR-12** | **主题簇的来源**             | **共激活图上有效 affinity ≥ `COACT_AFFINITY_MIN` 的边的连通分量**。涌现，不可由调用方标注；公开 API 不接受任何簇 / 分类 / 标签字段；带 `computed_at` + `algo_version`                                                                                                                                                                                                                         | 用户硬约束。**簇是算出来的，不是存出来的**（与 §2 原则①「层级是算出来的」同构）。落库就要维护一致性，增量维护就要引入稳定标识——两者都在解决一个不存在的问题                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **ADR-13** | **侧抑制的实现形态**           | **纯计算后置筛选**：不写库、不进五因子加权公式、只作用于 `hits`。判据为**纯逐对**（余弦 OR 实体交集），**主题簇完全不参与判定**                                                                                                                                                                                                                                                                        | 抑制若乘进 score，同一条记忆在不同查询里拿到不同的分，score 失去跨查询可比性，`explain` 的解释力也塌掉。**主题簇是话题级、冗余是事实级**——「张三住上海 / 张三喜欢猫」同簇但都是有用记忆，按簇抑制是信息损失                                                                                                                                                                                                                                                                                                                                                                                              |
| **ADR-14** | ~~共激活强度是否进入打分~~        | **已作废。** 共激活强度只决定「边是否存在」与「取哪几个邻居」，**不进分数**                                                                                                                                                                                                                                                                                                         | 作废三条理由：① §4.6 的「五项权重和恒为 1.0」不只是结构性质，更是**已被 QA 拿去写断言的可测恒等式**（五项之和 == score，≤1e-9），有界加项让它恒假；② §4.6 明说那五项权重「**从未用真实查询回归过**」，在回归之前引入加项，分数变化**分不清来自权重调整还是加项生效**；③ **向量路没有资格加项**——它的候选靠五项之内的 intensity/graphProximity/recency 活下来（无向量路候选理论最高 0.75，全部来自五项之内），**若向量路需要加项才能活下来，它早有了**                                                                                                                                                                                                                                       |
| **ADR-15** | **事件流是否扩展类型**          | **不新增任何 `events.type`。** 共激活强化记在既有 `touch` 事件的 payload 里；簇重算 / 缓存刷新不记事件                                                                                                                                                                                                                                                                            | SQLite 的 CHECK 约束**无法 ALTER**——新增 type 要重建 `events` 表 + 重建全部索引与触发器。而 v1.0 §3 自己写明「加新 type 必须同改三处」。**用字段扩展绕开这张迁移账单**，代价只是重放器对旧事件取 `?? []` / `?? 0`                                                                                                                                                                                                                                                                                                                                                                  |
| **ADR-16** | **向量后端选型**             | **向量检索后端可插拔（`VectorBackend`），但本版只实现一个**；**实现选型见 ADR-33**（本条只管可插拔性）。**向量事实源留在 `memories.embedding`**                                                                                                                                                                                                                                                | **被否决的备选：usearch HNSW + mmap（ANN sidecar）**——它带来的三样东西本库一个都不需要：① sidecar 一致性机制（启动对账、就绪闸门、幽灵向量防御、原子替换顺序）——分桶把桶归属放在主库表里，**与主表同事务**，这一整套机制直接不存在；② ANN 召回损失与守它的验收线——分桶是精确的，探针覆盖充分时 top-N 与 flat 高度一致（覆盖不足时**只漏、不错**）；③ 原生依赖——分桶是纯 TypeScript + SQLite，**保住了 v1.0「零外部依赖」这条边界**。同时否决 hnswlib-node（无 mmap ⇒ 3GB 必须常驻 RAM）与独立向量数据库（破坏嵌入式 / 全同步 / 单机目录三条底线）。**代价明写**：分桶需要训练（一次性 1~3 分钟）与重训（分布漂移后），且探针数不够时有召回损失——**这是本库唯一的近似来源**，且它可测（§4.15.4）。⚠️ **「sidecar 一致性机制不需要」的适用范围 = 稳态写路径**（同事务 ⇒ 无中间态）；**重训批量路径仍需恢复处理**，见 §4.15.5。 |
| **ADR-17** | **向量路是否设扫描上限**         | `ROUTER_NPROBE_COARSE`(20) / `ROUTER_NPROBE_FINE`(50) 决定**扫多少桶**，`VECTOR_TOPK`(20) 决定**多少条进打分**。⚠️ **二者削减的是不同的东西**（这一条必须写死，否则与正文互斥）：· **探针数削减的是「候选资格」**——真正的最近邻若落在未探针覆盖的桶里，它**永远进不了候选**。这是分桶**唯一的近似来源**（§4.6 步骤 2c / ADR-33）。· **`VECTOR_TOPK` 削减的只是「候选数量」**，不削减资格。· **两者都不改变「候选资格的判定规则」**：闸门条件与打分公式一字不动。                                          | v1.0 明写「本库不接受用参数换正确性」——这条在分桶方案下**完整保住了**：探针数换来的是**延迟**，不是**正确性**（桶内是全量精确点积，探针覆盖充分时结果与全表扫完全相同）。要守的不是「没有上限」，而是「**上限不得削减候选资格**」。⚠️ **对照被否决的 ANN 方案**：ANN 换来的延迟**确实**降低了正确性（召回损失），那才违反这条断言。                                                                                                                                                                                                                                                                                                                            |
| **ADR-18** | **归档计数能否缓存**           | **能，且是精确公式不是近似**：`archive_at = last_access + stability × pin_factor × ln(1/ARCHIVE_LINE) × 86400000`。`countArchived()` 变 O(log n) 且**结果与全表精筛逐位相同**                                                                                                                                                                                                 | 自洽校验：最远归档时刻 = 180×5×ln(20) = **2696 天**，与 §4.6 的 `@coarseCutoffPinned`（2696 天）完全吻合 ⇒ 与粗筛推导同源。开关 `ARCHIVAL_CACHE` 可退回全表                                                                                                                                                                                                                                                                                                                                                                                             |
| **ADR-19** | **共激活由什么喂养**           | **只由显式 `touch()` 喂养。** `recall()` 与 `write()` 均不写 `coacts`。recall 是纯只读热路径                                                                                                                                                                                                                                                                          | 若 recall 自身喂养共激活，**topN 会自我强化**：第一次检索选出的 5 条互相共激活 → 成为图上唯一强连通块 → 下次簇补全优先带出它们 → 再被共激活 ⇒ **库锁死在早期话题上**。代价是共激活的增长速率 = 调用方的 touch 频率，不是检索频率（§0.2 已写明）                                                                                                                                                                                                                                                                                                                                                                  |
| **ADR-20** | **「与谁关联」怎么定**          | **由调用方在 `touch()` 时显式声明**（`options.coActivateWith`）。库只做三项弱校验：种子存在、未软删、种子与被采纳者自身不相交。**库内部不维护任何跨调用的状态**（无 ledger、无 LRU、无「最近一次召回」缓存）                                                                                                                                                                                                                  | ledger 把因果归因到**库无法确知**的事上——「这次 touch 的 B 是被最近一次 recall 的某个种子唤起的」只是**推测**；调用方可能从别处拿到 B、恰好后来 touch 了它。显式传参让调用方**声明**因果：零隐藏状态、跨进程无问题、只读实例无需特殊处理。这与 ADR-2（实体由调用方提供）、ADR-10（向量由调用方提供）同构。**代价（明写）**：`coacts` 的可信度上限 = 调用方声明的准确度                                                                                                                                                                                                                                                                                          |
| **ADR-21** | **机制开关**               | **四个机制级开关进 `DEFAULT_PARAMS`**：`coactivation` / `inhibition` / `writeBack` / `ARCHIVAL_CACHE`。四者全关时，库的行为与 v1.0 **逐位一致**                                                                                                                                                                                                                             | 这是本次重构唯一的「没顺手改坏别的东西」的证明手段。**关掉机制 ≠ 跳过它的测试**，而是**让 v1.0 的测试集原样跑在新架构上**——那才是真正的回归                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **ADR-22** | **迁移形态**               | **纯增量**：不改 `memories` 表、不改 `edges` 表、不重建 `events` 表、不重建 FTS5 触发器。**v1.0 → v2.1** = 新增九张表 + 新增索引 + **1 项回填**（`archival_schedule`，按 §9.4 公式逐行算）。⚠️ 不新增任何 `events.type`（ADR-15）；`coacts` 不回填（数据不存在，§8.4）。⚠️ **版本号仍是 2** 的理由写在这条里：v2.0 是设计草案、**从未发布** ⇒ 不给它版本号 = **不给用户一个假历史**（版本号是承诺，不是内部计数器）                                                         | 「4 项回填」是数不对也**无内容可核**的悬空断言——全文没有任何一处列举这 4 项                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **ADR-23** | **侧抑制的算法形态**           | **纯筛选 + 三桶（R / D / overflow）+ 纯逐对判据**：① 冗余判据**只用** `cos ≥ REDUNDANCY_COS` **或** `实体交集数 ≥ DEDUP_ENTITY_MIN`；② 候选按分降序遍历，冗余者进 D，其余进 R；`R.length == 1\` 时不抑制（防整池同质被压到 1 条）；R 满 topN 后其余进 O（**未参与评估**）；④ **不做全局补位**；⑤ 抑制不进 score、不写库、只作用于 hits                                                                                                          | **为什么不能用有界减项**：把一条冗余候选压到下一条非冗余候选之下，所需 penalty = `s_redundant − s_next`，而 `s_next` 可任意小 ⇒ **所需 penalty 无界** ⇒ 有界减项在数学上无法保证「同质内容不占多个名额」；而无界 penalty ≡ 硬筛选，只是多绕一圈——多一个没出处的数字（0.15）、多一处 score 语义分裂、还要写进 `breakdown` 参与求和。**为什么不做补位**：补位会把刚挤掉的近义内容又塞回上下文，**抑制的目的被自己抵消**。**为什么用实体交集而不是簇**：复用 §4.9 步骤 3c 的同一谓词 ⇒ 两个口径不会打架，且**实体路径不依赖 embedding** ⇒ `embeddedRatio = 0` 时抑制仍然工作                                                                                                                                            |
| **ADR-24** | **归一基准是否固定**           | **不固定**。`normBm25` 继续用候选集内中位数。**新增不变式：路由层不得改变文本路自身的候选选择**（`LIMIT 100 → 精筛 → slice(0,20)` 与向量后端、其它路是否跳过完全无关），由一条单测守住                                                                                                                                                                                                                                | `bm25List` 只含文本路命中的候选，文本路独立于向量后端 ⇒ **median 逐位不变**，ANN 不造成 score 漂移。全局基准无定义、破坏「候选集与查询相关」的前提、且解决的是一个不存在的问题。★ **顺序约束的正确理由是「回归的对象是『这组权重配这组候选集』」，不是「median 变了」**——理由写错比结论写错更危险                                                                                                                                                                                                                                                                                                                                         |
| **ADR-25** | **ANN 索引与主库的一致性**      | **~~ANN 索引与主库的一致性~~ → 已作废。** ANN sidecar 路线已随 ADR-16 一起被推翻（ADR-33）。**替代方案：桶归属与主表同事务写**——因此不需要 sidecar 对账、就绪闸门、幽灵向量防御与原子替换顺序。一致性规则只有一条：改 `embedding` 的同一事务内必须同步 `vector_cell_members`，失败即整体回滚（§9.3.2）                                                                                                                                               | sidecar 与主库无法同事务，是**外部 ANN 后端的固有代价**。本版既然不引入外部 ANN 后端，这一整套机制就没有存在理由。**保留 §9.3.2 的启动对账作为防御性检查**（同事务写入意味着正常路径不可能不一致；对账每次都发现差异说明 ① 被漏实现了，那是 bug 不是数据问题）。⚠️ **作废理由必须记在这里**：理由写错比结论写错更危险——后来者会照着错理由去论证「那 sidecar 一致性机制还是需要的」，把一条已作废的复杂度重新引回来。★ **本条的适用范围要写死**：「不需要就绪闸门 / 幽灵向量防御」**只对稳态写路径成立**（改 `embedding` 与 `vector_cell_members` 同事务、失败即整体回滚 ⇒ 永远不会出现「桶归属缺失」的中间态）；**重训这条批量路径不在此豁免范围内**——它是 1~3 分钟的增量提交操作，崩溃会留下新旧两代桶（`inRetrain` 是内存态、重启即失）⇒ 重训的恢复口径见 §4.15.5 的「重训中途崩溃怎么办」。**豁免范围被写错，比豁免本身更危险**：它会让实现者以为重训也不需要恢复处理。   |
| **ADR-26** | **写入去重的候选收窄方式**        | **靠向量分桶（几何层），不靠主题簇**。两级 k-means（粗 200 / 细 1 万），写入用探针数收窄到约 800 条后精确算余弦；**不加时间窗**                                                                                                                                                                                                                                                                    | **新写入的记忆从未被 touch 过 ⇒ 不属于任何主题簇 ⇒ 主题簇路由对写入路径结构性无效**；且 §4.9 步骤 3a2 不加时间窗的理由（重复项可能半年前写的）继续成立 ⇒ 收窄必须靠内容相似度分桶，不能靠时间                                                                                                                                                                                                                                                                                                                                                                                                     |
| **ADR-27** | **第四路的准入闸门**           | **准入闸门对四路一视同仁。** 联想路必须过与文本 / 向量 / 命题**完全相同**的闸门（`deleted = 0` + 粗筛窗口 + `intensity > ARCHIVE_LINE`），一条例外都不许                                                                                                                                                                                                                                         | **联想路的归档泄漏风险比向量路更高，不是更低**：向量路候选由「与 query 的相似度」决定（与历史无关），联想路候选由「历史上是否一起被用过」决定 ⇒ **老记忆被 touch 过的次数天然更多 ⇒ 共激活边更多 ⇒ 更容易被拉回**。一条 intensity 0.01 的归档记忆因历史上共现过就进候选池 = **用共激活废掉遗忘曲线**，且比向量路更难发现（共激活边不是「相似」，运维直觉会认为「它是相关的」）                                                                                                                                                                                                                                                                                                 |
| **ADR-28** | **超大簇的处理方式**           | **三层防护**：① **有界枚举**（主防线，所有列出簇成员的操作带 `LIMIT`，`CLUSTER_MEMBER_SAMPLE_MAX`）② **相对上限**（`CLUSTER_MAX_FRACTION = 0.02`，有效上限 = `max(2, floor(0.02 × total))`）③ **兜底切分**（仅当 `largestClusterRatio > MAX_CLUSTER_SHARE = 0.5` 才触发，算法为**均衡分块**）                                                                                                               | **巨型簇是事实不是异常**：实测规模 ≈ 样板总体规模（5% 样板 → 100 万库下 50,000）。切碎它反而抹掉「这批内容是重复的」这个信息，而它想防的「巨型簇吞掉候选池」**在逐对比较的抑制下本来就不会发生**（抑制与簇大小无关）。**同时否决两个错误写法**：① 「逐条删最弱边直到 size ≤ 上限」——近重复形成的是**团**不是链，团里删一条边仍连通 ⇒ **循环不推进**（终止性缺陷）；② 「全图取节点强度最低者剥离」——已孤立节点强度恒为 0 ⇒ **每轮都是无操作**（空转）。★ **通用教训：任何「逐个删除元素直到集合变小」的循环，都必须先证明「被删的元素不会再被选中」**                                                                                                                                                                                                    |
| **ADR-29** | **簇能力的成立前提**           | **簇与联想路是「涌现」能力，其可用性取决于调用方的采纳密度，不是库单方面保证的。** §0.2 写死密度门槛与时效                                                                                                                                                                                                                                                                                         | 实测：覆盖率 ≥ 50% 需要约「**每 2 条记忆 touch 一次**」的采纳密度；**随机采纳 4 万次后覆盖率仅 0.028**（簇的涌现依赖主题相关的采纳，不是碰得多就行）；不持续 touch 时覆盖率约 **60 天归零**（τ=21 天衰减 + 淘汰阈值共同决定）。⇒ 只查不 touch 的集成方式，联想路近似无候选，召回质量退化为纯三路基线。⚠️ **该实测曲线基于 `COACT_MIN_ENTITIES = 1`；本版已改为 2 ⇒ 实际门槛只会更高**（§0.2.1 已标注）。⇒ **本 ADR 引用的是「量级」而非精确值**：「需要主题相关的密集采纳」这个结论是稳的，**「每 2 条一次」这个具体数字待按新参数重跑确认**（QA 待办）——**不得把它当作已验证的验收线**                                                                                                                                                   |
| **ADR-30** | **派生缓存的失效防护**          | **`archival_schedule` 的维护点收拢为 `reindexArchive(memoryIds)`，覆盖全部 9 条 `reindexArchive` 调用点 + 第 10 条路径（`setParams({ARCHIVE_LINE})` ⇒ 全量重算，走 `rebuildArchivalScheduleInternal`，**&#x4E0D;在\** `reindexArchive` 的 9 个调用点里）——**合计 10 条影响归档集合的路径**，\*\*不依赖 `ON DELETE CASCADE`\*\*；并加 `stats().archivalOrphans`（应恒为 0）+ 抽样自检 + `rebuildArchivalSchedule()` | §9.1 明写 `PRAGMA foreign_keys` 是每连接开关、**漏开时不报错不告警**。靠 CASCADE 兜底 = 把一个静默偏移交给一个会静默失效的开关。而缓存失配的后果是**静默的**：归档集合错 → 层级判定错 → 记忆被错误判定为「已淡忘」——**比崩溃更危险**，因为一切看起来都正常                                                                                                                                                                                                                                                                                                                                                        |
| **ADR-31** | **共激活关联的来源**           | **调用方在 touch 时显式声明**（`options.coActivateWith`），**库不推断**。库只做三项弱校验：种子存在、未软删、种子与被采纳者自身不相交。**库内部不维护任何跨调用的状态**（无 ledger、无 LRU、无「最近一次召回」缓存）                                                                                                                                                                                                              | ledger 把因果归因到**库无法确知**的事上——「这次 touch 的 B 是被最近一次 recall 的某个种子唤起的」只是**推测**；调用方可能从别处拿到 B、恰好后来 touch 了它。显式传参让调用方**声明**因果：零隐藏状态、跨进程无问题、只读实例无需任何特殊处理。与 ADR-2（实体由调用方提供）、ADR-10（向量由调用方提供）同构：**语义判断归调用方，库只做归一与存储**                                                                                                                                                                                                                                                                                                          |
| **ADR-32** | **`diffused` 的来源可追溯性** | `RecallResult.diffused[]` 增加 `seeds?: string[]`，标明「哪个 topN 命中唤起了这一条」；调用方据此构造 `coActivateWith`                                                                                                                                                                                                                                                      | 「谁唤起了谁」是调用方构造 `coActivateWith` 所需的输入。若库不返回，调用方只能靠猜——那正是 ADR-31 要避免的「推测」。⇒ **库的只读输出是调用方声明的输入**：这条链路由 `diffused[].seeds` → `touch({coActivateWith})` → `coacts` 闭合，全程无隐藏状态                                                                                                                                                                                                                                                                                                                                           |

|                                        |                  |                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-33**                             | **向量检索是否引入 ANN** | **不引入。** 向量路走**主库内的两级 k-means 分桶（IVF）**：桶归属与主表同事务，桶内是全量精确点积。**召回损失的唯一来源是探针数**，且可测（与 flat 全表扫对照，top-N 吻合率 ≥ 0.98） | **本条取代 v2.0 草案选定的 usearch HNSW 方案**（该选型只存在于 v2.0 草案，已随本版作废；**当前文档的 ADR-16 里已无该选型痕迹**，不要在现行文本里找它）。 理由：ANN 带来的三样东西本库一个都不需要——① sidecar 一致性机制 ② ANN 召回损失与守它的验收线 ③ 原生依赖。**分桶把它们全免了**：桶内是精确点积，探针覆盖充分时结果与 flat 完全相同；桶归属在主库表里，不存在索引与主库不同步的问题；纯 TypeScript + SQLite，**保住了 v1.0「零外部依赖」这条边界**。**代价明写**：分桶需要训练（一次性 1~3 分钟）与重训（分布漂移后）；探针数不够时有召回损失——**这是全库唯一的近似来源** |
| **维护约定**：新增任何跨模块的设计取舍，必须在此表追加一行（编号递增）， |                  |                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                       |
| 不得只在正文某处随手一提——那正是前后不一致的常见成因。           |                  |                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                       |

---

## 14. 明确不做的（重要）

这是一份**边界声明**：以下能力看起来相关，但本库**刻意不实现**。  
每条都给出原因——将来有人问「为什么不支持 X」，答案在这里。

### 14.1 刻意不做的产品行为

| 不做                   | 原因                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **记忆失真**（每次回忆都重构改写）  | 机器人记错事是灾难。把"不喜欢猫"记成"喜欢猫"然后当事实用，比记不住更糟                                                                                                  |
| **情绪性遗忘**（情绪差时选择性遗忘） | 表现成 bug：昨天不愉快，今天"忘了"为什么。用户的情绪不该影响系统对事实的记录                                                                                              |
| **随机遗忘**             | 重要的事随机漏掉，用户只会认为系统坏了                                                                                                                    |
| **间隔重复复习队列**（Anki 式） | 它假设"记忆需要被主动复习"，而对话场景里没有"该复习了"这个动作。硬套的结果是她突然提起三周前的旧事                                                                                    |
| **自动物理删除归档记忆**       | 「淡忘」是降权而非销毁。自动清理会让用户失去"很久以前的事突然想起来"的可能，而这正是记忆库的价值（ADR-8）                                                                               |
| **向量路在分桶训练完成前静默缺席**  | 库规模 ≥ `ROUTER_MIN_TRAINING` 但分桶未训练时，向量路**不产出任何候选**，文本路与图谱路照常工作。**必须可观测**（`stats().vectorBackend.mode`），否则与「库里没有相关内容」无法区分（§4.15.6 的三态表） |

> **拟人要的是手感，不是缺陷。**  
> 人脑里那些"不完美"（记忆会失真、会被情绪干扰、会随机遗忘）是进化妥协，不是功能。机器人没理由继承。

### 14.2 刻意不做的架构决策

| 不做                                      | 原因                                                                                                                                                                                                                                                                                                                                                                                                                                   | 详见              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| **多租户**                                 | 记忆是强个人隐私数据，租户隔离一旦做错就是数据泄露。需要多用户时，由上层为每个用户开独立 db 文件                                                                                                                                                                                                                                                                                                                                                                                   | ADR-1           |
| **内置实体抽取（NER）**                         | 库内做 NER 需要绑定特定模型与语言，且抽取质量无法在库内闭环评估。`write(input.entities)` 与 `recall(options.entityIds)` 都接受外部结果，库只负责归一与存储                                                                                                                                                                                                                                                                                                                           | ADR-2           |
| **自动改参数**                               | 参数变更会改变全部历史数据的解读方式，而库内没有"改完怎么回滚"的完整语义。`sweep()` 只做统计与清理，**不改任何参数**                                                                                                                                                                                                                                                                                                                                                                   | §11.4 / ADR-3   |
| **多模态理解**                               | 只存 `media_ref` / `media_type` 与降维后的文本。图片描述、语音转写由调用方做——各平台能力与成本不同，塞进库里会让它变成大泥球                                                                                                                                                                                                                                                                                                                                                        | ADR-4           |
| **异步 API**                              | better-sqlite3 是同步的，单进程本地库用异步只会带来无意义的复杂度                                                                                                                                                                                                                                                                                                                                                                                             | ADR-5           |
| **原生向量索引扩展**                            | 引入 ANN 索引必然要选型：① **usearch**（Rust 核心，HNSW/IVF 均可，索引可 mmap 持久化）——**不选**，它把索引放在 sidecar 文件里，与主库无法同事务，因而必须额外建一整套「启动对账 + 就绪闸门 + 幽灵向量防御 + 原子替换顺序」；② **hnswlib-node**（纯 JS 移植，无原生编译，但无 mmap ⇒ 3GB 向量必须常驻 RAM）——**不选**；③ **sqlite-vec**（SQLite 扩展，最贴合单文件，但只支持全量 flat 或单层 IVF，做不了「粗 200 → 细 1 万」两级路由）——**不选**。**本版选定：主库内的两级 k-means 分桶**——桶归属与主表同事务，桶内是全量精确点积，零原生依赖。**被否决的备选**：usearch HNSW。理由是它带来的三样东西本库一个都不需要（sidecar 一致性机制、ANN 召回损失、原生依赖） | ADR-16 / ADR-33 |
| **跨设备同步**                               | 库是单机文件。同步涉及冲突解决（同一记忆在两台机器上并发修改），那不是一个库该解决的问题                                                                                                                                                                                                                                                                                                                                                                                         | ADR-7           |
| **独立向量数据库**（Qdrant / Milvus / Weaviate） | 破坏嵌入式、全同步、单机目录三条底线。向量路用**主库内的两级 k-means 分桶**解决（§4.15），不需要一个服务进程，**也不需要任何原生扩展**                                                                                                                                                                                                                                                                                                                                                       | ADR-16          |
| **人工簇标注**                               | 簇必须由共激活数据涌现，这是本次重构的硬约束。公开 API 不接受任何簇 / 分类 / 标签字段——调用方打标签会让「涌现」名存实亡                                                                                                                                                                                                                                                                                                                                                                   | ADR-12          |
| **在线聚类落库 / 增量簇维护**                      | 簇是**算出来的**（与「层级是算出来的，不是存出来的」同构）。落库就要维护一致性，增量维护就要引入簇 id 的稳定标识——两者都在解决一个不存在的问题                                                                                                                                                                                                                                                                                                                                                         | ADR-12          |
| **按正文长度选版本**（合并时「保留更长的那版」）              | 长度不是信息量的代理，且调用方是 LLM 抽提、提炼天然精简，该规则会**系统性**让旧版本胜出；再叠加每次合并都加固 stability，等于让过期正文越错越牢。这是已废弃的规则，列在这里是防止有人把它当「更稳妥的兜底」加回来                                                                                                                                                                                                                                                                                                                   | ADR-9           |

### 14.3.1 契约清单（本次审查沉淀）

> ⚠️ **本表是 3 列**（编号 / 契约 / 归属），**「归属」列写的是该契约的『类别 + 理由』**——  
> 「类别」指它属于哪一类检查（一致性 / 断言类 / 命名类 / 可观测类），  
> 「理由」指为什么需要它。**不要按「四类分工」去找第四列**（那是我上一版误写的，现已更正）。

| 编号      | 契约                                                                                                                                       | 归属                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **C25** | **同一规则在几处描述、值是否一致**                                                                                                                      | 例：`ROUTER_NPROBE_WRITE_*` 在 §5 与 §6 必须是同一组值（§5=8/20，§6=8/20）                                                              |
| **C26** | **参数名（默认值 N）必须在 §5 + `DEFAULT_PARAMS` 或显式硬编码**                                                                                           | 例：VECTOR_OVERFETCH_FACTOR 本版**硬编码 3**、不开放为参数 ⇒ 必须在正文写明「硬编码 3」                                                             |
| **C27** | **计数列要么实时聚合，要么写死维护点**                                                                                                                    | 例：`vector_fine_cells.member_count` 必须写死三处维护点（换桶 / 硬删 / 重训）；`theme_clusters.member_count` 则**明确不存**                        |
| **C28** | **凡以「该状态不可达」为由删除的字段，必须在同处记录它依赖的前提**（引用到具体的一节/一条裁决），前提变更时复查                                                                               | 例：`inRetrain` 的前提是「重训可在运行时发生」（§4.15.5）——该前提一变，字段必须回填                                                                      |
| **C29** | **验收断言里凡用「分桶 ⊆ flat」这类子集关系，**&#x5206;母必须是 flat 的候选全&#x96C6;**，不是 flat 的 top-N** ⇒ 否则探针不足会被误判成算法错误（**假失败**）                               | QA 实测推翻架构侧的断言措辞：「取子集后再取 top-K」**不保序**——被移除的高分元素会「让位」给后面的元素挤进 top-K                                                        |
| **C30** | **验收断言必须把「算错」与「调参」分开**：「有没有算错」⇒ 硬断言（集合包含）；「漏了多少」⇒ 软断言（统计阈值）                                                                              | 混成一个数 ⇒ 阈值一超就分不清该改代码还是该调参数；★ 典型症状是**断言在边界情形下假失败**                                                                         |
| **C31** | **任何「N/N 全绿」里的 N 必须是外部写死的期望值**，不是实际跑出来的条数                                                                                                | 闸门脚本误删 5 条函数仍显示「35/35 全绿」⇒ 用实际条数当分母，缺一条就自动掩盖了缺口                                                                           |
| **C32** | **能用结构判定的，不要用统计阈值判定**                                                                                                                    | 例：探针数 ≤ 中心数的所有组合都跑一次路由，断言命中桶数 == min(探针数, 可用中心数)                                                                          |
| **C33** | **验收断言要固化架构约束，不要固化实现细节**                                                                                                                 | `triggerSourceRows <= 10200`（不许每次启动全表扫）比「用某个列名算」更准——列名随实现变、约束不变                                                           |
| **C34** | **同一机制族在不同表上的取向相反时，必须各自写明「为什么相反」，不得互相借用理由**                                                                                              | 例：`theme_cluster_members` 刻意不设到 `memories` 的外键（冻结快照），而 `archival_schedule` 用 `ON DELETE CASCADE`（§3、§9.4.3）——两者的理由不同、各自成立 |
| **C35** | **凡「触发判定量」与「对外报告量」同值，必须不同名**，且注释写清两者的时点不同（触发量 = 本次计算过程中的**中间量**；对外量 = **已发布快照的属性**）。⚠️ 若触发条件直接写「用 <对外字段名> 判定」⇒ **结构性耦合**（触发量引用了被测对象的字段名） | 触发量读切后值 ⇒ 切分「跑一次就没了」⇒ 漂移后再退化也不触发 ⇒ 重训承诺落空                                                                                 |
| **C36** | **配置（要求）与状态（实际）不得共用同一套词/字面量**                                                                                                            | 例：`VECTOR_ROUTER='flat'`（**要求**）与 `mode='flat_auto'`（**实际走的**）语义不同 ⇒ 状态侧用互不相同的字面量（§6）                                     |
| **C37** | **凡方法体读写时间戳或参与时间计算的，签名必须含 `now?`；不接收 `now` 的方法必须显式列出并写明理由**                                                                              | §11.1 的时钟注入表；新增方法若碰时间戳而表中无它 ⇒ 契约校验失败。**这条把「时钟注入」从约定升级为 CI 可检**——否则新方法直接写 `Date.now()`，衰减 / 共激活 / 归档三条时间链路在测试里一起失真         |

★ **跨节锚定检查**（机器可检）：

对每一条「在 §A 声明的规则」，全文搜索它的**动作关键词**，  
断言每个「该规则管辖的代码路径」都在动作关键词的**同一代码块内**出现该动作。

| 规则           | 动作关键词                                                     | 管辖路径                                                                            |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 桶归属同步        | `vector_cell_members` / `assignBucket` / `unassignBucket` | §4.9 步骤 2 / §4.9 步骤 3c ② / §4.9 步骤 4 / §4.9.1 步骤 4（**四条 embedding 赋值路径一条都不能漏**） |
| 探针覆盖         | 吻合率 / 只漏不错                                                | §4.15.3 选型表 / §4.15.4 ②③ / §4.6 步骤 2c / §4.9 步骤 3a2 / ADR-16 / ADR-17           |
| reinforce 边界 | 不建共激活边 / `'reinforce'` / `coacts`                         | §4.2 / §4.6 步骤 4 / §6 / §8.4 / §0.2.2 / §0.2.3                                  |
| 向量路缺席        | `mode` / `absent` / `inRetrain`                           | §4.6 步骤 0d / §4.6 步骤 2c / §4.15.6 / §6 / §7.2 面板 1 / §7.3 状态表 / §0.2.3 ④        |
| 切分触发量        | 原始分量占比 / `maxRawComponentRatio`                           | §4.12.4 ③ / §6 / §3 `cluster_snapshot_meta` / §7.2 面板 7                         |

⚠️ **本表是「机器可检」的清单 ⇒ 每行必须只有 3 列**（规则 / 动作关键词 / 管辖路径）。  
★ 本表曾出现两处笔误，均已修正：① 三行多出一个与第 3 列重复的第 4 列（表头只有 3 列，  
多出的列会让任何按列解析的校验脚本取错列）；② 「切分触发量」行的第 4 列  
**被误填成「向量路缺席」行的路径**——那会让「切分触发量」这条规则**校验到错误的路径上去**，  
而它本该指向 §4.12.4 ③ / §6 / §3 / §7.2 面板 7。  
⇒ **这类错误比缺行更危险**：缺行会报错，而错列**会静默地校验通过**。

⇒ ★ 这条规则与 C25~~C28 **不同类**：  
C25~~C28 查「同一规则在几处描述、值是否一致」；  
**跨节锚定检查查「规则的【动作】是否落在【路径】上」**——  
而本轮 16 项残留里有 10 项的根因正是后者。

### 14.3 边界原则

1. **每个承诺都要能指到唯一代码路径。** 指不到的，要么补实现，要么删承诺——  
   本库的历史 bug 大多是「文档承诺了但代码路径不存在」或「两处都写对、合起来矛盾」。
2. **不存状态就不该有动作。** 归档是逻辑状态（算出来的），所以没有"归档"这个动作；  
   同理层级不落库，所以没有"晋升/降级"操作。见 §4.4。
3. **物理破坏性操作必须显式、留痕、可回滚。** 全文共**三处**会真正删除 `memories` 行，  
   每一处都在下面列清——漏一处就会让「可回滚」变成空话：
   - `forget({ hard: true })`（§4.8）—— 显式传参才生效；删行 + 正文脱敏 + 记 `forget` 事件，三步同事务。
   - `sweep({ purgeDeletedDays })`（§4.10）—— 显式传参才生效；**只清理已软删且超过期限**的行，  
     不碰任何 `deleted = 0` 的记录（ADR-8 的落地）。逐条一条事务，每条都记 `sweep` 事件。
   - `restore({ mergeInto })`（§4.8.1 步骤 4d）—— 这是最容易被漏掉的一处：恢复请求撞上唯一索引后，  
     把待恢复行**合并进目标记忆并硬删自己**。它有意**不走** §4.8 的脱敏流程  
     （正文由目标记忆承载，历史事件保留原文即构成「可审计的合并痕迹」），  
     所以它的「可回滚」口径与其他两处不同：**数据不丢（已并入目标），但那一行本身不可复原**。  
     它必须显式传 `mergeInto` 才走到这一步，不传则抛 `CONFLICT`——默认路径不会删任何东西。
   ★ **为什么 `mergeEntities` 不在这三处里**（容易被误以为漏了一处，故写明）：  
   `mergeEntities(sourceId, targetId)`（§4.9.2）**不删除任何 `memories` 行**——  
   它删的是 `entities` 里的**源实体行**，以及改指/清理 `memory_entities` 关联行与 `edges` 边行；  
   **所有记忆本体与正文原封不动地存活**，只是它们的实体关联从 source 改指到 target。  
   ⇒ 它是**图谱层的破坏性操作**（源实体不可复原），但**不是记忆内容的销毁** ⇒ 不属于本条。  
   ⚠️ 但它仍需显式调用、仍记 `alias` 事件（`action='merge'`），且事件里带  
   `movedMemories` / `mergedEdges` / `droppedSelfLoops` —— **可审计性要求与三处同级**。

---

*文档版本：**v2.1**（记忆海）——本文档自此版本起作为实现的唯一依据。*  
*本版 = v1.0 的完整重构：新增第五概念「神经元交互」，规模从 10 万条提升到 100 万条级，*  
*检索从 flat 精确扫描改为两级分桶路由（主库内 IVF，精确、同事务、零原生依赖），主题簇由共激活数据涌现。*  
*本版（v2.1）是 v2.0 的严格审查修订：**推翻 v2.0 选定的 ANN sidecar 路线**（改为主库内分桶，ADR-16/25/33）、*  
*路由收敛为向量路专属（不再约束文本路与图谱路）、§3 DDL 两级化、写入路径去重改走分桶、簇查询接口合并为一个。*  
*算法、schema、接口、参数全部重新定稿；被推翻的决策与理由见 §13 的 ADR-14 / ADR-19 / ADR-22 / ADR-23 / ADR-24 / ADR-28。*  
*后续修改在此处按版本号**升序**追加变更记录，最新的一条在文件末尾。*

