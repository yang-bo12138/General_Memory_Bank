-- ═══════════════════════════════════════════════════════════════════════════
-- 通用记忆库 v2.1（记忆海）· v1 → v2 迁移脚本 002（**阶段 A 的新增部分**）
-- 依据：DESIGN-v2.md §9.1（模式版本管理）/ §3 的 v2 九张新表，逐字取 §3。
--
-- ⚠️ 本脚本**只**负责「建齐 v2 的九张新表 + 全部索引」。
--    另外两件事**不在这里**，由 `src/db/migrate.ts` 负责：
--    ① `ALTER TABLE memories ADD COLUMN embedding BLOB CHECK (...)` ——
--       SQLite 的 `ADD COLUMN` **没有 `IF NOT EXISTS` 形式** ⇒ 重跑迁移会炸
--       `duplicate column name: embedding` ⇒ 必须用 `PRAGMA table_info(memories)` 在代码里守卫。
--    ② `PRAGMA user_version = 2;` —— 写库 PRAGMA 由代码与建表/事件在同一个事务里提交。
--
-- ⚠️ **全部用 `IF NOT EXISTS`** ⇒ 迁移**可重复执行**（跑两次不炸第二次）。
--
-- ⚠️ **建表带 FK 时不需要先开 `PRAGMA foreign_keys`**：
--    `ON DELETE CASCADE` 是写在 schema 里的；受开关影响的是**执行 DML 的那条连接**，
--    而阶段 B 是纯 INSERT ⇒ 安全。
--
-- ⚠️ **不得用「少建几张就补建」自愈**（§9.1 禁止「猜测式兼容」）：
--    v2.0 草案库的结构与 v2.1 不同（草案是 `vector_cells` **单表**），补建也补不对。
--    ⇒ 只认 `user_version = 1` 的真 v1 库；其它一律抛 INVALID_INPUT。
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 神经元交互：共激活表（记忆↔记忆的统计共现）
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ **与 `edges` 的区别，两者不是一回事，混用会造成数据事故**：
--   `edges`  = 实体↔实体的**语义关系**（张三 --住在--> 北京），有 predicate，是断言。
--   `coacts` = 记忆↔记忆的**统计共现**（「她喜欢猫粮」与「她对猫粮过敏」被反复一起想起），无 predicate，是观测。
CREATE TABLE IF NOT EXISTS coacts (
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
  last_active INTEGER NOT NULL,                    -- 上次共现时间戳（毫秒），衰减读它
  CHECK (memory_a < memory_b)                      -- 无序对规范化：强制 a<b。
                                                   -- ⚠️ 没有这一条，同一对会存成两行（a,b 与 b,a），
                                                   --   而簇的连通分量计算会把它们当成两条边 ⇒ 连通分量被算错
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coacts_pair ON coacts(memory_a, memory_b);
CREATE INDEX IF NOT EXISTS idx_coacts_b ON coacts(memory_b, affinity DESC);
CREATE INDEX IF NOT EXISTS idx_coacts_decay ON coacts(last_active);

-- ═══════════════════════════════════════════════════════════════════════════
-- 涌现层：主题簇（由共激活图算出的连通分量）
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ **它是缓存，不是定义**。定义永远是「共激活图上 affinity_eff ≥ COACT_AFFINITY_MIN 的连通分量」（§4.11.3）。
--    删掉这两张表重建一次，结果必须**完全一致**——这是 §4.11.3 的不变量。
CREATE TABLE IF NOT EXISTS theme_clusters (
  cluster_id      TEXT PRIMARY KEY,                -- 簇 id
  cluster_version INTEGER NOT NULL,                -- 快照版本号，簇成员发生变更时 +1
  computed_at     INTEGER NOT NULL,                -- 本快照生成时刻（毫秒），用于回答「这个簇有多旧」
  member_count    INTEGER NOT NULL CHECK (member_count >= 0)
);
CREATE TABLE IF NOT EXISTS theme_cluster_members (
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
CREATE INDEX IF NOT EXISTS idx_tcm_memory ON theme_cluster_members(memory_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 簇快照元信息（**单行表**）与通用就绪标记表
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ `cluster_snapshot_meta`（簇快照元信息，单行）与 `meta`（通用就绪标记，键值）
--    **是两张不同的表，不要混为一谈**。
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 通用「缓存就绪」标记表：用途 'archival_schedule_ready' / 'vector_buckets_ready' 等。
--   ★ 顺带解决 setParams({ARCHIVE_LINE})（§9.4.3）：参数变更 → 置 ready=0 → 退回逐行精筛
--     （结果仍正确，只是慢）→ 后台重建 → 置 1 ⇒ 参数变更从「阻塞操作」降级为「后台修复」，且不需要加列。
CREATE TABLE IF NOT EXISTS cluster_snapshot_meta (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表
  version              INTEGER NOT NULL,               -- 快照版本号，每次重算 +1
  computed_at          INTEGER NOT NULL,               -- 本快照生成时刻
  algo_version         INTEGER NOT NULL,               -- 聚类算法版本；换算法必须递增
  min_affinity         REAL NOT NULL,                  -- 本快照用的边阈值
  max_raw_ratio        REAL,                           -- ★ 本次重算中 union-find 跑完、切分之前的最大原始连通分量占比（**中间量**，§4.12.4 ③）
  last_split_at        INTEGER,                        -- ★ 最近一次兜底切分的时刻（事件元信息）
  last_split_reason    TEXT,                           --   触发原因（如 'max_share_exceeded'）
  last_split_threshold REAL,                           --   触发时**当时的**阈值值
  last_split_blocks    INTEGER,                        --   切成了几块
                                                       -- ⚠️ 这四列**只记「最近一次」**；**不记历史峰值**。
  cluster_count        INTEGER NOT NULL,               -- 簇数
  member_count         INTEGER NOT NULL                -- 成员总数（整表重建时 COUNT 出来 ⇒ 天然精确）
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 向量分桶（几何层）：两级 k-means 分桶
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ **与主题簇是两回事，绝不可混用同一个「簇」字**：
--   主题簇由**共激活涌现**（语义层）；向量分桶由**向量几何划分**（物理层）。
-- ⚠️ 拆成粗/细两张表，而不是一张表加 level 列：
--   「细桶必须属于某个粗桶」这条跨表不变式 SQLite 的 CHECK 表达不了
--   ⇒ 拆表后它变成**两张表之间的普通外键**，由 SQLite 引擎保证。
CREATE TABLE IF NOT EXISTS vector_coarse_cells (
  coarse_id   TEXT PRIMARY KEY,
  centroid    BLOB NOT NULL,                       -- 粗中心，Float32 小端、L2 归一化
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vector_fine_cells (
  fine_id     TEXT PRIMARY KEY,
  coarse_id   TEXT NOT NULL REFERENCES vector_coarse_cells(coarse_id) ON DELETE CASCADE,
                                                   -- ★ 细桶必须属于某个粗桶 —— 由**外键**保证，不靠应用层自觉
  centroid    BLOB NOT NULL,                       -- 细中心，Float32 小端、L2 归一化
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vfc_coarse ON vector_fine_cells(coarse_id);
CREATE TABLE IF NOT EXISTS vector_cell_members (
  fine_id   TEXT NOT NULL REFERENCES vector_fine_cells(fine_id) ON DELETE CASCADE,
                                                   -- ★ 指向**细桶**（不再是粗桶；粗桶不挂成员）
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (fine_id, memory_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vcm_memory_unique ON vector_cell_members(memory_id);
                                                   -- ★ 唯一索引**同时**服务 `memory_id = ?` 的查找
                                                   --   ⇒ 不需要再单独建一个非唯一索引（省一个索引的写放大）。
                                                   --   ★ **一条记忆只属一个细桶**的最终防线。

-- ═══════════════════════════════════════════════════════════════════════════
-- 归档缓存（§9.4）：把「何时归档」从**每次查询实时算**改成**一次算好、按索引取**
-- ═══════════════════════════════════════════════════════════════════════════
-- ★ 只装 `deleted = 0` 的行 ⇒ countArchived() 是纯索引扫描，不需要 JOIN memories。
CREATE TABLE IF NOT EXISTS archival_schedule (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  archive_at INTEGER NOT NULL                      -- 归档时刻（毫秒）；精确值
);
CREATE INDEX IF NOT EXISTS idx_arch_at ON archival_schedule(archive_at);
