# T07 · 回填速查表（★ 主理人核磁盘现状后落盘 · 供独立比对用）

> ★ **用途**：architect 落盘后，我**不只采信报告**，而是按这张表**逐处独立比对**。
> ★ **依据**：`handover/bench/t07-warm.json`（★ 我已独立核过：恒等式 `4,065,792 == 4,059,648 + 6,144` ✔ · H1′ 绿 · H2′ 绿 · PRUNE_RATE 绿 · 前提未违例）。

## 一、要替换的占位文案（★ **共 12 处** · 每处都要**替换**，不是追加）

| # | 文件 | 行 | 现在的占位（节选） |
|---|---|---|---|
| 1 | `docs/baseline/README.md` | **85** | 「⚠️ **本轮不落实测值**（T06 施工中 ⇒ **T07 冷 / 热两档重采**）⇒ **本页不写任何未实测的字节数**」 |
| 2 | `docs/baseline/README.md` | **86** | 同上（H2′ 行） |
| 3 | `docs/DELIVERY.md` | **53** | H1′ 行的占位 |
| 4 | `docs/DELIVERY.md` | **54** | H2′ 行的占位 |
| 5 | `docs/DELIVERY.md` | **168** | H1′ 行（第二张表） |
| 6 | `docs/DELIVERY.md` | **169** | H2′ 行（第二张表） |
| 7 | `docs/design/DESIGN-v2-errata.md` | **2290** | H1′ 行 |
| 8 | `docs/design/DESIGN-v2-errata.md` | **2291** | H2′ 行 |
| 9 | `docs/design/DESIGN-v2.md` | **6086** | 「⚠️ **实测值留空 —— T07 冷 / 热两档重采后回填**（本轮**不写任何未实测的字节数**）」 |
| 10 | `docs/design/DESIGN-v2.md` | **6090** | 「⚠️ **实测值留空 —— T07 冷 / 热两档重采后回填**（本轮**不写任何未实测的数字**）」 |
| 11 | `docs/design/DEVELOPMENT-PLAN.md` | **2292** | H1′ 行 |
| 12 | `docs/design/DEVELOPMENT-PLAN.md` | **2293** | H2′ 行 |

⚠️ ★ **「替换」不是「追加」** —— 否则同一份文档里会同时有「留空」与「实测值」⇒ ⇒ **两份口径**。

## 二、要填的三段内容（★ **逐字用**）

**H1′ 实测值**：
```
4,065,792 B（3.877 MiB；均值 1,623,229.4 B / p99 3,998,976 B；样本 200）⇒ ≤ 6,144,000 B ⇒ ★ 绿（余量 33.8%）
```
**H2′ 实测值**：
```
0.1323%（= 同一笔 bytesRead.max 4,065,792 B ÷（1,000,000 × 3,072 B））⇒ ≤ 0.2% ⇒ ★ 绿
```
**★ 档位串（★ 每处都要带 ⇒ 不带就变成「无档位的数」）**：
```
2026-11-05 · 1,000,000 条 · 热档（页缓存 = 跑的人声明；★ 实测读吞吐 127 MB/s ≈ HDD 盘速 ⇒ 读的是盘）· HDD（ST1000DM010）· 准备段 6.40 h（灌库 3.61 h + 训练 2.79 h）· 峰值 RSS 9,916 MB · 样本 200
```

## 三、其余三处（**非占位替换**）

| # | 文件 | 动作 |
|---|---|---|
| 13 | `docs/design/perf-c2-admissible-two-stage.md` §7 风险表 R2 行「出关条件①」列 | **追加**：「✅ 2026-11-05 实测（1M · 热档 · HDD）：`bytesRead.max` = 4,065,792 B（≤ 6,144,000 B ⇒ 绿，余量 33.8%）；剪枝率 = 3.70%（≤ 15% ⇒ 绿，分子 = `embeddingCalls`、白调用 = 0）；候选宇宙 max = 5,286 行 ⇒ 破点 7,838/7,960 未触及（余量 1.48×/1.51×）；前提未违例（`unclassifiedRows`=0、`badCodeRows`=0、`samplesAligned`=true）⇒ ⇒ **出关条件① 达成**（★ 毫秒参考线 4 条红是介质/机器所致）」 |
| 14 | `docs/decisions/adr-perf-recall-vs-h1.md` §8.6 | ★ **本轮唯一授权改 ADR 数字的地方**：「写入侧 `4.44 MB` 是【偏高的估计】、**不是**【下界】」（它按「每轮 64 次精确重排 × 3,072 B」估 ⇒ 而实测精确分至多 2 行 ⇒ 实测 4,065,792 B 低于它 8~13%）⇒ ⇒ **实测低于它属预期、不是回归** ⇒ ★ **必须留痕**（★「不是笔误，是前提被实测推翻」） |
| 15 | `docs/design/perf-c2-t06-byte-metering.md` | ① §2 断言 1d 理由②（1M 复验已成立）· ① §4 读路径那段（登记超门槛盲区）· ① §6 风险表（登记「桶内无 LIMIT」+ 阶段 4 钩子）· ① §4 示例 JSON（换成实测那组 · ★ **写路径那一侧**） |

## 四、我落盘后**独立比对**的判据（★ 不用只等报告）

```bash
# ① 占位清零：★ 这 12 处的占位文案必须【一个不剩】
grep -rn "T07 冷 / 热两档重采\|T07 冷/热两档重采\|实测值留空\|本轮不落实测值" \
  docs/baseline/README.md docs/DELIVERY.md docs/design/DESIGN-v2-errata.md \
  docs/design/DESIGN-v2.md docs/design/DEVELOPMENT-PLAN.md
#    ⇒ 期望：零命中

# ② 实测值到位：H1′ 的 4,065,792 与 H2′ 的 0.1323% 必须出现在全部 5 份文档
for f in docs/baseline/README.md docs/DELIVERY.md docs/design/DESIGN-v2-errata.md \
         docs/design/DESIGN-v2.md docs/design/DEVELOPMENT-PLAN.md; do
  printf "%-40s H1′=%s H2′=%s 档位串=%s\n" "$f" \
    "$(grep -c '4,065,792' $f)" "$(grep -c '0.1323%' $f)" "$(grep -c 'ST1000DM010' $f)"
done
#    ⇒ 期望：H1′ ≥1 · H2′ ≥1 · 档位串 ≥1（DELIVERY 是 2 张表 ⇒ ≥2）

# ③ 零门槛值改动
git diff -U0 <五个文件> | grep -E "^[+-]" | grep -vE "^(\+\+\+|---)" \
  | grep -cE "6,144,000|0\.2%|15%|768|3,072"
#    ⇒ 期望：0

# ④ ADR 只改了那一句
git diff docs/decisions/adr-perf-recall-vs-h1.md | grep "^[+-]" | grep -vE "^(\+\+\+|---)" | wc -l
#    ⇒ 期望：条数很少（只有那一句 + 留痕）

# ⑤ 门禁
pnpm run verify && pnpm run audit:tier-qualifiers && pnpm run check:mermaid-copies
#    ⇒ 全部 exit 0
git diff --stat src/     # ⇒ 空
```

## 五、★ 三条新增登记的**事实依据**（★ 供比对措辞是否失真）

| # | 事实 | 出处 |
|---|---|---|
| A | 读路径 `samplesAligned = true` · 写路径同 `true`；`derivedCrossCheck` 与 `bucketMemberRowsRead` 六统计量逐位相等（200 / 57 / 3402.8 / 3200 / 8000 / 9251） | `handover/bench/t07-warm.json` |
| B | 读路径 `bytesRead.max` = **7,233,792 B**（候选宇宙 9,251 行）vs 写路径 **4,065,792 B**（5,286 行）⇒ 大 75% ⇒ 超 6,144,000 B **33.2%**；但按现行口径**读路径不判门槛** | 同上 + ① §4「读路径不判门槛（R6 同组：观测值）」 |
| C | `derivedCrossCheck` 是**模型化**值（bench note 自陈「模型化了桶内不设 LIMIT」）⇒ 与实测逐位相等 ⇒ ⇒ **当前实现是桶内全量读、无 LIMIT** ⇒ ⇒ **阶段 4 落地后两者会分叉 ⇒ 分叉 = 「阶段 4 已生效」的信号** | 同上 + `bench/perf.ts` 的 `candidateReadRowsBasis.note` |
