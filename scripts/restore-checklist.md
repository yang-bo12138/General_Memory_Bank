# 备份 / 恢复 / 校验 · 运维 runbook

> 依据：`DESIGN-v2.md` **§11.3.1**，落地任务 **P4-T08**。
> 配套脚本：`scripts/backup.ts`；自检实现：`src/tools/verify.ts` 的 `verifyIntegrity()`。

---

## 0. 三条不能违反的硬规则

| # | 规则 | 违反后的表现 |
|---|---|---|
| 1 | **不要 `cp` 一个正在写的 `.db`** | WAL 里已提交的事务不在主文件里 ⇒ 得到**不一致副本**，**且不报错**（它看起来就是一份备份） |
| 2 | **恢复后必须重设 PRAGMA**（WAL / synchronous / busy_timeout / foreign_keys） | 备份文件**不带** PRAGMA 设置 ⇒ 那个库不再是 WAL ⇒ 并发与崩溃一致性的前提全变了（而一切照常工作，**不报错**） |
| 3 | **硬删之前必须先备份** | `coacts.coact_count` **不可重建**（`affinity` / `last_active` 可由事件重放，计数不行）⇒ 这是本库唯一的 RPO 分界线 |

---

## 1. 备份（不停写）

```bash
pnpm exec tsx scripts/backup.ts --db data/ocean.db --out-dir backup            # 默认保留 7 份
pnpm exec tsx scripts/backup.ts --db data/ocean.db --out-dir backup --keep 3   # 只留 3 份
```

脚本做五件事（**任一失败 ⇒ 非 0 退出 + 删除残件**）：

1. `VACUUM INTO 'backup/ocean-YYYYMMDD-HHmmss.db'` —— **唯一推荐路径**，自带一致性；
2. 对**产物**跑 `PRAGMA integrity_check`（期望 `ok`）—— ★ **没有校验的备份只是一份文件，不是一份备份**；
3. 登记尺寸 + `sha256` + `PRAGMA user_version` + 应用版本 + **当时的参数快照**（`meta.params`）到 `backup/manifest.json`；
4. 按**份数**轮转（不按总量：单份备份就是整库）；
5. 同一秒重复执行 ⇒ **失败而不覆盖**（覆盖会把上一份好备份变成废档）。

⚠️ 同时备份 `logs/` 目录（事件流在库里，日志只作人类排障用 —— **重放**永远以 `events` 为准，§8.3）。

---

## 2. 恢复

```bash
# ① 停写进程（这是唯一必须「停下来」的一步）
# ② 放回备份文件
cp backup/ocean-20261102-100000.db data/ocean.db
# ③ 若来源是**文件级拷贝**（不是 VACUUM INTO 产物）⇒ 必须删掉残留
rm -f data/ocean.db-wal data/ocean.db-shm
#    ⚠️ VACUUM INTO 产物自带完整状态、无 WAL 残留 ⇒ 这一步不需要
```

④ **开库后重设 PRAGMA**：用 `MemoryStore` 打开即可（`openDatabase()` 会按 §9.1 的 A 套重设）。
   自检断言：`PRAGMA journal_mode` 必须读回 `wal` —— 不是就说明「恢复后没重设」，**此时不要继续用**。

⑤ 完整性自检（三项）：

```bash
pnpm exec tsx -e "
const { MemoryStore } = await import('./src/store/MemoryStore.ts');
const { verifyIntegrity } = await import('./src/tools/verify.ts');
const { DEFAULT_PARAMS } = await import('./src/core/params.ts');
const s = new MemoryStore({ dbPath: 'data/ocean.db' });
console.log(verifyIntegrity(s['#db'] ?? s, DEFAULT_PARAMS));
"
```

> ⚠️ 上面这条示意里访问私有字段的写法**不要照抄**：正常做法是用库自己的 `stats()` +
> `verifyIntegrity(db, params)`（后者需要一个 `better-sqlite3` 句柄）——
> 运维脚本请直接 `new Database(path, {readonly:true})` 再调 `verifyIntegrity`。

期望结果：

```json
{ "integrityOk": true, "foreignKeyViolations": 0,
  "bucketCoverage": { "embeddedMemories": 0, "bucketMembers": 0, "ratio": 1 },
  "archival": { "orphans": 0, "mismatch": 0, "missing": 0 },
  "ok": true }
```

⑥ **可重建项**（都从主表或共激活表重算，不需要备份它们）：

| 缓存 | 重建入口 | 备注 |
|---|---|---|
| 向量桶（`vector_*`） | `rebuildVectorBuckets()` | 从 `memories.embedding` 重算（阻塞 1~3 分钟） |
| 归档缓存（`archival_schedule`） | `rebuildArchivalSchedule()` | 从 `memories` 重算 |
| 主题簇（`theme_clusters` / `theme_cluster_members`） | `recluster()` | 从 `coacts` 重算 |
| `coacts` 的 `affinity` / `last_active` | **重放事件**（`replayFromDb()` 的 `coactPairs`） | ⚠️ **`coact_count` 不可重建** |

⑦ 抽 200 条记忆调 `get()`，正文与备份快照逐字一致（**逐字**：不是「长度相同」）。

---

## 3. 校验（定期，不依赖恢复）

```bash
pnpm exec tsx bench/perf.ts --db data/ocean.db        # 性能基线（阶段 3 的 H1 / H2）
pnpm exec tsx bench/regression/weights.ts             # 打分权重的排序回归（只比 id 序列）
```

`stats()` 里三个归档自检字段应恒为 0：
`archivalOrphans` / `archivalMismatch` / `archivalMissing`（后者在重索引进行中会是 `null`，**不是故障**）。

---

## 4. 出事时的最短排障路径

| 现象 | 先查 | 判据 |
|---|---|---|
| `archivedCount` 与「逐行精筛」不一致 | `meta.archival_schedule_ready` | 为 `0` ⇒ 缓存未就绪，**结果仍正确**（走慢路径）；为 `1` 且不一致 ⇒ 跑 `rebuildArchivalSchedule()` |
| 召回变差但无报错 | `stats().vectorBackend.mode` | `absent` ⇒ 桶不可用（跑 `rebuildVectorBuckets()`）；`ivf` 且 `maxBucketSize` 远大于 `ROUTER_BUCKET_MAX` ⇒ 该重训 |
| 事件流与库内 `stability` 对不上 | `checkStabilityBalance()` 的 `mismatches` | 逐条列出 `initial / eventDelta / actual`，差值即「哪次加固没记事件」 |
| 恢复后行为异常（并发 / 崩溃） | `PRAGMA journal_mode` | 不是 `wal` ⇒ **PRAGMA 没重设**，重开 `MemoryStore` |
