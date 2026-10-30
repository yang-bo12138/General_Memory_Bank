/**
 * 建库 DDL 的**运行时副本**（由 `schema/001_schema_v2.sql` 生成，内容逐字相同）。
 *
 * ⚠️ **为什么要有这个副本，而不是运行时去读 `.sql` 文件**：
 *   本库用 tsup 打包，消费方拿到的是 `dist/index.js` —— `schema/*.sql` **不会**随产物分发。
 *   ⇒ 运行时按 `import.meta.url` 去拼路径读文件，在消费方那里必然找不到。
 *   ⇒ 所以 DDL 必须**内联**成字符串（DEVELOPMENT-PLAN.md 的 `src/db/schema.sql.ts` 就是这个用途）。
 *
 * ⚠️ **两份副本会漂移吗？** 会 —— 所以 `tests/unit/schema.test.ts` 有一条用例断言：
 *   本文件导出的 `SCHEMA_SQL` 与磁盘上的 `schema/001_schema_v2.sql` **逐字相等**。
 *   ⇒ 改了 `.sql` 而没重新生成本文件 ⇒ 门禁当场失败。
 *
 * **重新生成**：把 `.sql` 的内容原样放进下面的模板字面量（反斜杠 / 反引号 / `${` 需按 TS 规则转义）。
 */

/** 建库 DDL（v2.1 / schema 版本 2）。 */
export const SCHEMA_SQL = `-- ═══════════════════════════════════════════════════════════════════════════
-- 通用记忆库 v2.1（记忆海）· 建库脚本 001
-- 依据：DESIGN-v2.md §3（数据模型）全部 \`@schema\` 块，逐字落成。
--
-- ⚠️ 三条纪律（违反时**不报错**，只是静默留下隐患）：
--   ① \`PRAGMA page_size\` **只能在建库前设一次**（对已有库无效，需 VACUUM 重建）
--      ⇒ 它属于**建库脚本**，不属于 \`open()\` 的连接初始化（放那儿是「设了但没生效」的假动作）。
--   ② **不要把整段 DDL 包进 BEGIN...COMMIT**：事务内 \`PRAGMA foreign_keys = ON\` 是**静默无效**的
--      （SQLite 不报错、不生效）⇒ 后面 \`forget(hard)\` 会留下孤儿行且不报错。
--   ③ **不要给 \`embedding\` 建任何索引**（含 \`WHERE embedding IS NOT NULL\` 的部分索引）：
--      向量路要的是「窗口内全部行」，索引省不掉一次全扫；BLOB 无法参与范围查询，只换来写放大。
--      ⇒ 这是引入向量后最容易顺手加错的一项。
-- ═══════════════════════════════════════════════════════════════════════════

-- ★ 页大小必须在**任何 CREATE TABLE 之前**设置，且只此一次。
--   选 8192 的理由：embedding 行 768 维 float32 ≈ 3KB，默认 4096 字节页下约 1 行/页，打包差。
PRAGMA page_size = 8192;

-- 外键是**每连接**开关，且 SQLite 默认关闭。这一行只对执行本脚本的那条连接有效，
-- 并且**在事务内执行是静默无效的**。真正必须生效的位置是 §9.1 的连接初始化（src/db/connection.ts）。
-- 这里保留它，是为了让单看本脚本的人知道「这个库依赖 FK 级联」。
PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════════════════════════════════════════════
-- 记忆条目
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ \`rowid INTEGER PRIMARY KEY AUTOINCREMENT\`：显式自增主键，固化物理 rowid，防御 VACUUM。
--    为彻底避免 VACUUM 重排隐式 rowid 导致 FTS5 外部内容表错位；对外只暴露业务 uuid \`id\`。
CREATE TABLE memories (
  rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('fact','event','preference','thought','topic')),
  content        TEXT NOT NULL,                     -- 文本表示（多模态降维后原文，不参与 FTS）
  content_tokens TEXT NOT NULL,                     -- content 的 bigram 预切分结果，空格分隔。
                                                    --   ⚠️ tokenize 会先做 toHalfWidth + 小写，所以它是**半角化后**的切分结果，
                                                    --   与 content（原文，可能含全角/大写）不是逐字符对应的关系
  content_hash   TEXT NOT NULL,                     -- content 归一化后的 sha1，防御重复
  embedding      BLOB
                 CHECK (embedding IS NULL OR length(embedding) % 4 = 0),
                                                    -- 语义向量：Float32 小端、**L2 归一化后**存储（§4.6 步骤 2c）
                                                    --   归一化后余弦 = 点积，省一次除法，且杜绝「长向量占优」。
                                                    --   字节长度必须 = EMBED_DIM × 4，由应用层校验。
                                                    --   ⚠️ CHECK 写不出「= @dim」（SQLite 的 CHECK 不能引用配置参数），
                                                    --   但 EMBED_DIM 是只读固定值（768），故可写字面量守卫 \`length = 3072\`
                                                    --   或更宽松的 \`% 4 = 0\`（弱守卫，与维度解耦，换维度仍成立）。
                                                    --   ⚠️ 必须允许 NULL：老数据与「调用方不提供向量」都是合法状态。
                                                    --   ⚠️ 它是 content 的**衍生物**，遗忘口径见 §8.2——
                                                    --   不能当「脱敏后仍可保留的统计量」。
  media_ref      TEXT,                              -- 原始多模态文件指针（路径/URL）
  media_type     TEXT
                 CHECK (media_type IS NULL OR media_type IN ('image','audio','video')),
  source         TEXT,                              -- 来源标识（会话/文档/消息通道）
                                                    --   仅用于溯源展示与查看器筛选，**不参与召回过滤**
  confidence     REAL NOT NULL DEFAULT 0.7
                 CHECK (confidence >= 0.0 AND confidence <= 1.0),
                                                    -- 置信度 0~1（明确声明 vs 自动抽取）
                                                    --   仅用于展示与排序提示，不进入 §4.6 打分公式

  -- 遗忘曲线（强度维度）
  stability      REAL NOT NULL CHECK (stability > 0),
                                                    -- 稳定度（单位：天）。>0 是除零的最后一道防线：
                                                    --   即使 API 层漏校验，数据库也拒绝写入 0
  difficulty     REAL NOT NULL CHECK (difficulty >= 0.0 AND difficulty <= 1.0),
                                                    -- 难度 0~1，越低越容易记牢
  pin_factor     REAL NOT NULL DEFAULT 1.0
                 CHECK (pin_factor >= 1.0 AND pin_factor <= 5.0),
                                                    -- 人为强调倍率（1~5），不污染 stability，只在算 intensity 时乘
  created_at     INTEGER NOT NULL,                  -- 创建毫秒时间戳
  last_access    INTEGER NOT NULL,                  -- 上次有效召回/使用时间戳
  access_count   INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),

  -- 状态
  deleted        INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
                                                    -- 1 = 用户显式遗忘（软删，不参与任何召回与扩散）
  deleted_at     INTEGER,                           -- 软删时间戳（毫秒），用于 sweep 清理判断

  -- 状态一致性：删除标记与删除时间必须同生同死，
  --  避免出现「已删但无时间」（sweep 无法清理）
  CHECK ((deleted = 0 AND deleted_at IS NULL) OR (deleted = 1 AND deleted_at IS NOT NULL)),

  -- 多模态二元组同生同死：「有 type 没 ref」和「有 ref 没 type」都是脏数据。
  --  二者都只在实体被读出时才暴露问题，写入时不报错，所以必须在库层拦住。
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
-- ⚠️ **不给 \`embedding\` 建任何索引** —— 见文件头纪律 ③

-- ═══════════════════════════════════════════════════════════════════════════
-- 实体 / 别名 / 记忆-实体关联
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,                  -- entity uuid
  name          TEXT NOT NULL UNIQUE,              -- 主名称（如 "张三"）
  type          TEXT NOT NULL DEFAULT 'concept'
                CHECK (type IN ('person','thing','place','concept','media')),
                                                   -- 枚举由 CHECK 强制，与 memories.kind 同一口径
                                                   -- ⚠️ 现状：唯一写入点写死 'concept'，无接口能传别的类型，
                                                   --   全文也没有读取点 ⇒ idx_entity_type 目前是空转索引。
                                                   --   要真正区分类型需先给 WriteInput 加类型字段或做自动推断，
                                                   --   那是设计扩展而非实现遗漏；在那之前不要假装它已经在用。
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_entity_type ON entities(type);

CREATE TABLE entity_aliases (
  alias         TEXT PRIMARY KEY,                  -- 别名（如 "老张"），全局唯一
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX idx_alias_entity ON entity_aliases(entity_id);
-- 约束：别名不得与任何主名称冲突，由应用层在写入别名时先查 entities.name 校验。

CREATE TABLE memory_entities (
  memory_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX idx_me_entity ON memory_entities(entity_id);
CREATE INDEX idx_me_memory ON memory_entities(memory_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 知识图谱关系边（实体↔实体的**有向**边）
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 正文历史表（只追加）：合并/重写时保留旧版本，保证「可完整重放」不留空洞
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE content_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content        TEXT NOT NULL,                    -- 被替换掉的旧正文（每一版合并/修正的前任）
  content_tokens TEXT,                             -- 对应分词快照，便于回溯其可检索性
  reason         TEXT NOT NULL
                 CHECK (reason IN ('merge','manual_fix')),
                                                   -- merge（被合并替换的旧版）/ manual_fix（被显式纠正的旧版）
                                                   -- ⚠️ 枚举由 CHECK 强制。不是形式主义：一个再无发射点的枚举值
                                                   --   会因为没有约束而一直活在注释与文档里（死枚举）。
  replaced_at    INTEGER NOT NULL                  -- 毫秒时间戳
);
CREATE INDEX idx_ch_memory ON content_history(memory_id, replaced_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- 事件流表（只追加；**唯一例外**是 §8.2 的正文脱敏，且只允许改 payload.contentText 一个键）
-- ═══════════════════════════════════════════════════════════════════════════
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
                                                   --   若设 ON DELETE CASCADE，forget(hard) 会把「曾经有过这条记忆」
                                                   --   的骨架一并抹掉，重放与审计直接断链。
  payload       TEXT NOT NULL,                     -- 结构化 JSON
  at            INTEGER NOT NULL                   -- 事件毫秒时间戳
);
CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_events_type ON events(type);
-- 遗忘/清理路径的定位索引（见 §8.2）：无此索引，脱敏只能靠 payload LIKE 全表扫
CREATE INDEX idx_events_memory ON events(memory_id) WHERE memory_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 全文检索虚拟表（FTS5 external content 挂载显式 rowid）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE VIRTUAL TABLE mem_fts USING fts5(
  content_tokens,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0'
);

-- 触发器：同步保持 FTS 索引与 memories 一致（insert / delete / update 三条路径）
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 神经元交互：共激活表（记忆↔记忆的统计共现）
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ **与 \`edges\` 的区别，两者不是一回事，混用会造成数据事故**：
--   \`edges\`  = 实体↔实体的**语义关系**（张三 --住在--> 北京），有 predicate，是断言。
--   \`coacts\` = 记忆↔记忆的**统计共现**（「她喜欢猫粮」与「她对猫粮过敏」被反复一起想起），无 predicate，是观测。
--   把共现当语义用 → 「讲同一件事的两个人」会被当成「同一个事实」合并掉。
--   把语义当共现用 → 语义边会因「被想起」而涨权，与 ADR-9「当下最准」打架。
CREATE TABLE coacts (
  memory_a    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_b    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  affinity    REAL NOT NULL CHECK (affinity >= 0.0 AND affinity <= 1.0),
                                                   -- 共激活亲和度 0~1。与 COACT_AFFINITY_MAX=1.0 同步；
                                                   --   改动这个上界必须同时改这里的 CHECK，否则应用层钳制与库层约束不一致
  coact_count INTEGER NOT NULL DEFAULT 1 CHECK (coact_count >= 1),
  cause_flags INTEGER NOT NULL DEFAULT 0 CHECK (cause_flags IN (0, 1, 2, 3)),
                                                   -- ★ **位掩码**（不是枚举）：本条边**历史上被哪些机制建过**
                                                   --   bit0 (1) = 机制 A（批内自动，§4.11.2）；bit1 (2) = 机制 B（调用方显式声明）
                                                   --   3 = 两者都建过 ⇒ 位掩码能表达「两者都建过」，枚举做不到。
                                                   -- ⚠️ **只置位、不清零**（历史事实不可撤销）⇒ 与 affinity 的衰减**解耦**。
                                                   -- ⚠️ 语义分层：表侧 = 历史累计；事件侧 \`coactPairs[].source\` = 本次来源。
  last_active INTEGER NOT NULL,                    -- 上次共现时间戳（毫秒），衰减读它
  CHECK (memory_a < memory_b)                      -- 无序对规范化：强制 a<b。
                                                   -- ⚠️ 没有这一条，同一对会存成两行（a,b 与 b,a），
                                                   --   而簇的连通分量计算会把它们当成两条边 ⇒ 连通分量被算错
);
CREATE UNIQUE INDEX idx_coacts_pair ON coacts(memory_a, memory_b);
CREATE INDEX idx_coacts_b ON coacts(memory_b, affinity DESC);
-- 反向查邻居（簇内 topK 邻居直查用这个方向）
CREATE INDEX idx_coacts_decay ON coacts(last_active);
-- 淘汰扫描：按最后共现时间清理低频对

-- ═══════════════════════════════════════════════════════════════════════════
-- 涌现层：主题簇（由共激活图算出的连通分量）
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ **它是缓存，不是定义**。定义永远是「共激活图上 affinity_eff ≥ COACT_AFFINITY_MIN 的连通分量」（§4.11.3）。
--    删掉这两张表重建一次，结果必须**完全一致**——这是 §4.11.3 的不变量。
--    存它是因为 100 万条下 union-find 是秒级操作，不可能放进召回热路径。
CREATE TABLE theme_clusters (
  cluster_id      TEXT PRIMARY KEY,                -- 簇 id
  cluster_version INTEGER NOT NULL,                -- 快照版本号，簇成员发生变更时 +1
  computed_at     INTEGER NOT NULL,                -- 本快照生成时刻（毫秒），用于回答「这个簇有多旧」
  member_count    INTEGER NOT NULL CHECK (member_count >= 0)
);
CREATE TABLE theme_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES theme_clusters(cluster_id) ON DELETE CASCADE,
  memory_id  TEXT NOT NULL,
                                                   -- ⚠️ ★ **刻意不设到 \`memories\` 的外键**（冻结快照）：
                                                   --   已发布的簇快照是**某一时刻的划分**，它的成员行**不该**被硬删/软删级联改写
                                                   --   —— 否则「两次相同查询之间簇跳候选集会变」，§4.12.3 的可复现性口径失效。
                                                   --   ⇒ 孤儿行由「整表替换」清理（每次重算在同一事务内替换全表）。
                                                   --   ⇒ 召时按 \`deleted = 0\` 过滤（§4.6 步骤 3 的准入闸门）。
                                                   --   ★ 与 \`archival_schedule\` 的**级联**策略相反，**理由不同**（C34）。
  PRIMARY KEY (cluster_id, memory_id)
);
CREATE INDEX idx_tcm_memory ON theme_cluster_members(memory_id);
-- 反查：这条记忆属于哪些簇（一条记忆可能同时在多个簇里——
--   连通分量是互斥的，但**衰减后**的边会分裂，同一记忆可能短暂属于两个簇）

-- ═══════════════════════════════════════════════════════════════════════════
-- 簇快照元信息（**单行表**）与通用就绪标记表
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ \`cluster_snapshot_meta\`（簇快照元信息，单行）与 \`meta\`（通用就绪标记，键值）
--    **是两张不同的表，不要混为一谈**。
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 通用「缓存就绪」标记表：**不是**簇快照专用表的语义挪用。
--   用途：'archival_schedule_ready' / 'vector_buckets_ready' 等 ⇒ 「就绪标记」从一次性机制变成可复用模式。
--   ★ 顺带解决 setParams({ARCHIVE_LINE})（§9.4.3）：参数变更 → 置 ready=0 → 退回逐行精筛
--     （结果仍正确，只是慢）→ 后台重建 → 置 1 ⇒ 参数变更从「阻塞操作」降级为「后台修复」，且不需要加列。

CREATE TABLE cluster_snapshot_meta (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表
  version              INTEGER NOT NULL,               -- 快照版本号，每次重算 +1
  computed_at          INTEGER NOT NULL,               -- 本快照生成时刻
  algo_version         INTEGER NOT NULL,               -- 聚类算法版本；换算法必须递增
  min_affinity         REAL NOT NULL,                  -- 本快照用的边阈值
  max_raw_ratio        REAL,                           -- ★ 本次重算中 union-find 跑完、切分之前的
                                                       --   最大原始连通分量占比（**中间量**，落表才能对外暴露——
                                                       --   重算读到的是切完之后的图，算不出原始占比；§4.12.4 ③）
  last_split_at        INTEGER,                        -- ★ 最近一次兜底切分的时刻（事件元信息）
  last_split_reason    TEXT,                           --   触发原因（如 'max_share_exceeded'）
  last_split_threshold REAL,                           --   触发时**当时的**阈值值
  last_split_blocks    INTEGER,                        --   切成了几块
                                                       -- ⚠️ 这四列**只记「最近一次」**——语义纯净。
                                                       --   **不记历史峰值**（running-max 需要混合语义 ⇒ 不要）。
                                                       --   「内容有多重复」由 max_raw_ratio（当前量）回答。
  cluster_count        INTEGER NOT NULL,               -- 簇数
  member_count         INTEGER NOT NULL                -- 成员总数（整表重建时 COUNT 出来 ⇒ 天然精确）
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 向量分桶（几何层）：两级 k-means 分桶，**桶归属与主表同事务**（§9.3.2）
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ **与主题簇是两回事，绝不可混用同一个「簇」字**：
--   主题簇（theme_cluster）由**共激活涌现**，是语义层，回答「这几条记忆讲的是同一件事」。
--   向量分桶（vector_cell）由**向量几何划分**，是物理层，回答「这条向量落在空间哪个格子」。
-- ⚠️ 拆成粗/细两张表，而不是一张表加 level 列：
--   level + 自引用 parent_id 的方案里，「细桶必须属于某个粗桶」这条跨表不变式 SQLite 的 CHECK 表达不了
--   ⇒ 拆表后它变成**两张表之间的普通外键**，由 SQLite 引擎保证。
CREATE TABLE vector_coarse_cells (
  coarse_id   TEXT PRIMARY KEY,
  centroid    BLOB NOT NULL,                       -- 粗中心，Float32 小端、L2 归一化
  updated_at  INTEGER NOT NULL
);
CREATE TABLE vector_fine_cells (
  fine_id     TEXT PRIMARY KEY,
  coarse_id   TEXT NOT NULL REFERENCES vector_coarse_cells(coarse_id) ON DELETE CASCADE,
                                                   -- ★ 细桶必须属于某个粗桶 —— 由**外键**保证，不靠应用层自觉
  centroid    BLOB NOT NULL,                       -- 细中心，Float32 小端、L2 归一化
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
                                                   -- ★ 唯一索引**同时**服务 \`memory_id = ?\` 的查找
                                                   --   ⇒ 不需要再单独建一个非唯一索引（省一个索引的写放大）。
                                                   --   ★ **一条记忆只属一个细桶**的最终防线。
                                                   --   换桶时若只 INSERT 不 DELETE 旧行，一条记忆会同时挂在两个桶上
                                                   --   ⇒ 这个唯一索引让它**写不进去**（而不是静默重复）。

-- ═══════════════════════════════════════════════════════════════════════════
-- 归档缓存（§9.4）：把「何时归档」从**每次查询实时算**改成**一次算好、按索引取**
-- ═══════════════════════════════════════════════════════════════════════════
-- ★ 只装 \`deleted = 0\` 的行 ⇒ countArchived() 是纯索引扫描，不需要 JOIN memories。
CREATE TABLE archival_schedule (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  archive_at INTEGER NOT NULL                      -- 归档时刻（毫秒）；精确值
);
CREATE INDEX idx_arch_at ON archival_schedule(archive_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- schema 版本号
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 只在本脚本（建库时）写一次。**禁止**放进 \`open()\` 的连接初始化块：
--   ① 只读连接执行写 PRAGMA 会直接失败；② 每次 open 都重置为 2 ⇒ 将来迁移时会永久覆盖已升级的版本号。
PRAGMA user_version = 2;
`;
