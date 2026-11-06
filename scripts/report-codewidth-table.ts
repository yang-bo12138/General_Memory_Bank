#!/usr/bin/env tsx
/**
 * ★ 「码宽 ↔ ε ↔ 剪枝率 ↔ 延迟」四列表的**只读报告器**（出关条件② · 设计稿 R3 行）。
 *
 * ⚠️ ★★★ **它是什么、不是什么**：
 * · ★ **它是「出关条件②」的证据产出器** ⇒ ⇒ ② 要的是一张表（★ R3 行原文：
 *   「先出『码宽 ↔ ε ↔ 剪枝率 ↔ 延迟』四列表（这是选码宽的唯一依据，**不许拍脑袋**）」）。
 * · ★ **它【不是】守卫**：★ 它要读**本机的 5.5 GB 采集库**（`.tmp/bench/perf-1000000.db`）
 *   ⇒ ⇒ **CI 上没有那个库** ⇒ ⇒ ⇒ **不能进 `verify` 链**（★ 进链 = CI 恒红 ⇒ 零收益）。
 * · ★ **它【不是】决策器**：★ 它的输出是**事实与可算的判据**，**不给「该选哪个码宽」的结论**
 *   ⇒ ⇒ **结论要人来下**（★ 这正是 R3「不许拍脑袋」的意思）。
 *
 * ⚠️ ★★ **为什么「四列」这个结构不是随便定的（★ 本脚本要说明的核心）**：
 *   换码宽有**两个方向相反的副作用**，必须并排看才能比：
 *   · **字节侧（省）**：码行字节变少 ⇒ `bytesRead = 码行数×码宽 + embedding 行数×3,072` 变小；
 *   · **精度侧（赔）**：ε 变大 ⇒ 「可证上界」变松 ⇒ **更多候选进精排** ⇒ `embedding 行数` 变多
 *     ⇒ ⇒ **embedding 一行 3,072 B = 码一行的 4 倍**（int8 768 B 时）⇒ ⇒ **赔的部分更贵**。
 *   ⇒ ⇒ ★ **所以表里必须有「剪枝率」这一列**（它是「赔」的量化）**与「延迟」这一列**
 *   （★ 收窄码宽省 IO 但可能更费 CPU ⇒ ⇒ 端到端延迟未必跟着降 ⇒ ⇒ 那是「延迟」列的职责）。
 *   ⇒ ⇒ ★ **而「ε」列的作用 = 把「码宽」翻译成「剪枝率」**：★ ε 越大 ⇒ 剪枝越差
 *   ⇒ ⇒ ⇒ **ε ⇒ 剪枝率 这段映射【不可线性外推】**（★ PQ 的 ε 可能比 int4 大一个量级）
 *   ⇒ ⇒ ⇒ ★ **⇒ 所以「临界剪枝率」（字节侧 · 可算）与「实测剪枝率」（精度侧 · 须实测）
 *   必须成对出现** ⇒ ⇒ ★ **这才是四列表的分工**。
 *
 * ⚠️ ★★★ **「临界剪枝率」的定义（★ 可算的那一半）**：
 *   对**决定门槛的那个样本**（★ `bytesRead` 判定取 `max` ⇒ 决定成败的是 `bytesRead.max` 那个样本）：
 *   ```
 *   bytesRead_now = C×768 + N_now×3,072            （C = 该样本候选宇宙行数 · N_now = 该样本进精排行数）
 *   bytesRead(w)  = C×w    + N(w)×3,072            （w = 新码宽 · N(w) = 新码宽下的进精排行数）
 *   ⇒ 换 w 仍然达标 ⇔ N(w) ≤ ⌊(C×(768−w) + N_now×3,072) / 3,072⌋
 *   ```
 *   ⇒ ⇒ ★ **「允许的进精排行数上限」** ⇒ ⇒ 除以 C ⇒ ⇒ **「允许的剪枝率上限」**
 *   ⇒ ⇒ ★ **⚠️ 这是【字节侧】的临界值**：★ 它**不预测**换成 w 之后剪枝率会变成多少
 *   ⇒ ⇒ ⇒ ★ **那一半只能实测**（★ ⇒ 这正是本表为什么要 ε 与剪枝率两列）。
 *
 * ⚠️ ★★ **本脚本的三个纪律**：
 * 1. ★ **只读**：★ 只 `readonly: true` 打开采集库 ⇒ ⇒ **一个字都不写**。
 * 2. ★ **不硬编码实测值**：★ 所有数字来自库与落盘凭据 ⇒ ⇒ **重采后不需改脚本**。
 * 3. ★ **不替人做决策**：★ 只给「事实 + 临界值 + 还缺什么」⇒ ⇒ **不给结论**。
 *
 * ⚠️ ★★ **用法**：
 * ```bash
 * pnpm exec tsx scripts/report-codewidth-table.ts                 # 人读表格
 * pnpm exec tsx scripts/report-codewidth-table.ts --json          # 机器读 JSON
 * pnpm exec tsx scripts/report-codewidth-table.ts --db <路径>      # 指定采集库
 * pnpm exec tsx scripts/report-codewidth-table.ts --self-test      # 只跑自测
 * ```
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import type { CodeWidth } from '../src/vector/quantize.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DB = join(REPO_ROOT, '.tmp/bench/perf-1000000.db');
const DEFAULT_EVIDENCE = join(REPO_ROOT, 'docs/evidence/t07-warm.json');

/** ★ 一行向量 = 768 个 float32 = 3,072 B（★ 生产侧的实际值 ⇒ `EMBED_DIM` 是参数、这里取实测）。 */
const EMBEDDING_ROW_BYTES = 3072;

/** ★ 当前已实现的码宽（★ `src/vector/quantize.ts` 只有 int8）。 */
const CURRENT_CODE_WIDTH_BYTES = 768;

/**
 * ★ **候选码宽清单**（★ 「哪些档还没实现」的权威登记处 ⇒ 下一轮实现时只改这里）。
 *
 * ⚠️ ★★ **「临界剪枝率」对 PQ 不适用**：★ 公式假设「只换了每行码字节、其余不变」；
 * PQ 换的**不只是字节数**，它的 ε 可能大一个量级 ⇒ ⇒ **ε ⇒ 剪枝率的映射不可线性外推**
 * ⇒ ⇒ ⇒ ★ **PQ 那一行的「临界剪枝率」标为待定**（★ 连字节数都取决于还没定的子空间数×码本）。
 */
interface CandidateWidth {
  readonly label: string;
  /** ★ 对应的码宽枚举值（★ `null` = 还没有对应的码宽（如 PQ ⇒ 它的实现形态都还没定））。 */
  readonly width: CodeWidth | null;
  /** ★ 每行码字节数（★ `null` = 取决于还没定的配置 ⇒ 连字节侧都算不出）。 */
  readonly bytesPerRow: number | null;
  /** ★ 是否已有实现（★ ⇒ 才有「实测三列」）。 */
  readonly implemented: boolean;
  /** ★ 备注（★ 会进输出 ⇒ ⇒ 用来解释「为什么没有实测值」）。 */
  readonly note: string;
}

const CANDIDATE_WIDTHS: readonly CandidateWidth[] = [
  {
    label: 'int8',
    width: 'int8',
    bytesPerRow: 768,
    implemented: true,
    note: '★ 生产现状（`src/vector/quantize.ts`）⇒ ε = 编码时实算的 ‖x−x̂‖₂',
  },
  {
    label: 'int4',
    width: 'int4',
    bytesPerRow: 384,
    implemented: true,
    note: '★ 2026-11-06 已实现（对称量化 · 值域 [-7,7] · 两维 1 字节）⇒ ★ **ε 已实测**（★ 见 R3 行表一）⇒ ★ 剪枝率与延迟两列**仍缺**（★ 待读路径接线 + 重新采集）',
  },
  {
    label: '二值（1 bit/维）',
    width: 'binary',
    bytesPerRow: 96,
    implemented: true,
    note: '★ 2026-11-06 已实现 ⇒ ★ **ε 已实测且【可证剪枝恒失效】**（★ ε 的 min > 1 ⇒ ⇒ `upper = q·x̂ + ε > 1 ≥ cos_true` ⇒ ⇒ **永远进不了剪枝** ⇒ ⇒ **剪枝率恒 100%** ⇒ ⇒ ★ **本档不需要读路径接线、也不需要重新采集**）',
  },
  {
    label: 'PQ（子空间×码本）',
    width: null,
    bytesPerRow: null,
    implemented: false,
    note: '★ 未实现 ⇒ ★ 且**每行字节数取决于还没定的配置**（子空间数 × 码本大小）⇒ ⇒ 连字节侧都算不出',
  },
];

/** ★ 分布的统一样形（★ 与落盘凭据里的 `CountSummary` 同形 ⇒ 便于对照）。 */
interface Distribution {
  readonly count: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/** ★ ε 的分布（★ 比 `Distribution` 多两个分位 ⇒ 因为 ε 的尾巴决定「上界还成不成立」）。 */
interface EpsDistribution extends Distribution {
  readonly p90: number;
  readonly p999: number;
}

/** ★ 落盘凭据里本脚本要用的那一小块（★ 只取需要的 ⇒ 不引整份 JSON 的类型）。 */
interface EvidenceSlice {
  readonly storageMediaClass: string;
  readonly pageCacheState: string;
  readonly corpusSize: number;
  readonly bytesReadMax: number;
  readonly bytesReadBudget: number;
  readonly candidateUniverseMax: number;
  readonly memoryRowsReadMax: number;
  readonly pruneRate: Distribution;
  readonly writeP99Ms: number;
  readonly vectorRouteP99Ms: number;
}

/** ★ 一行「码宽 ↔ ε ↔ 剪枝率 ↔ 延迟」的完整记录（★ 全部实测值 + 字节侧临界判据）。 */
export interface CodeWidthRow {
  readonly label: string;
  readonly bytesPerRow: number;
  readonly implemented: boolean;
  /** ★ ε 的分布（★ 只在已实现且已实测的档有值）。 */
  readonly eps: EpsDistribution | null;
  /** ★ 剪枝率（= 进入精排的比例）的分布。 */
  readonly pruneRate: Distribution | null;
  /** ★ 延迟（★ 分档记录 ⇒ ⇒ 只与同档可比）。 */
  readonly writeP99Ms: number | null;
  readonly vectorRouteP99Ms: number | null;
  readonly storageMediaClass: string | null;
  readonly pageCacheState: string | null;
  /** ★ **允许的进精排行数上限**（★ 字节侧 · 可算 ⇒ ⇒ 换这个码宽后仍达标的条件）。 */
  readonly maxExactRowsAllowed: number | null;
  /** ★ **允许的剪枝率上限**（★ = 上限行数 ÷ 候选宇宙行数）。 */
  readonly maxPruneRateAllowed: number | null;
  readonly note: string;
}

/** ★ 一个候选档的「还缺什么」登记（★ 让表格能诚实地说出「哪几列是空的、为什么」）。 */
export interface MissingColumn {
  readonly label: string;
  readonly missing: readonly string[];
  readonly reason: string;
}

export interface CodeWidthTable {
  readonly rows: readonly CodeWidthRow[];
  readonly missing: readonly MissingColumn[];
  readonly evidence: EvidenceSlice;
}

/**
 * ★ 从落盘凭据里切出本脚本要用的那一小块。
 *
 * ⚠️ ★★ **为什么必须从落盘凭据读、而不是重新跑 bench**：★ 剪枝率与延迟**只有那一次采集**有
 * ⇒ ⇒ 重跑一次就是 3.5~4 小时 ⇒ ⇒ ★ 而 ε **不需要采集**（码表里有 `eps` 列 ⇒ 一条 SQL 即可）
 * ⇒ ⇒ ⇒ ★ **⇒ ε 与剪枝率/延迟必须【跨载体】配对** ⇒ ⇒ ⇒ ★ **同源性由人工保证**
 * （★ 本脚本会把两边的库指纹打出来供人核对 —— 采集库的 `members` 行数 vs 凭据的 `corpusSize`）。
 */
export function sliceEvidence(json: unknown): EvidenceSlice {
  const root = json as Record<string, unknown>;
  const write = root.writeSegments as Record<string, unknown>;
  const writeBytes = write.vectorByteReads as Record<string, unknown>;
  const breakdown = writeBytes.breakdown as Record<string, unknown>;
  const thresholds = root.thresholds as Record<string, unknown>;
  const media = root.storageMedia as Record<string, unknown>;
  const cache = root.pageCacheState as Record<string, unknown>;

  const readDist = (value: unknown): Distribution => {
    const d = value as Record<string, number>;
    return {
      count: d.count ?? 0,
      min: d.min ?? 0,
      mean: d.mean ?? 0,
      p50: d.p50 ?? 0,
      p99: d.p99 ?? 0,
      max: d.max ?? 0,
    };
  };
  const maxOf = (value: unknown): number => {
    if (value === undefined || value === null) {
      return 0;
    }
    return Number((value as Record<string, number>).max ?? 0);
  };

  return {
    storageMediaClass: String(media.mediaClass ?? '未知'),
    pageCacheState: String(cache.state ?? '未知'),
    corpusSize: Number(root.corpusSize ?? 0),
    bytesReadMax: maxOf(writeBytes.bytesRead),
    bytesReadBudget: Number(thresholds.bytesReadMax ?? 0),
    candidateUniverseMax: maxOf(writeBytes.candidateUniverse),
    memoryRowsReadMax: maxOf(writeBytes.memoryRowsRead),
    pruneRate: readDist(breakdown.pruneRate),
    writeP99Ms: Number(root.writeP99Ms ?? 0),
    vectorRouteP99Ms: Number(root.vectorRouteP99Ms ?? 0),
  };
}

/**
 * ★ **由分位数数组算出 ε 分布**（★ 纯函数 ⇒ 自测可喂合成数据）。
 *
 * ⚠️ ★★ **分位数怎么取**（★ 必须写清 ⇒ 否则「可复算」是空话）：
 * ★ 取**最近秩法**（★ nearest-rank）：★ `p` 分位 = 升序排列后第 `⌈p×n⌉` 个
 * ⇒ ⇒ ★ **不插值** ⇒ ⇒ ★ **同一条数据、任何机器、任何 SQLite 版本都算出同一个值**
 * ⇒ ⇒ ★ **✔ 与 `bench/lib/harness.ts:149` 的 `percentile()` 同款**
 * （★ `rank = ceil((p/100)×n)` · `index = min(n, max(1, rank)) − 1`）
 * ⇒ ⇒ ★ **⇒ 本脚本的分位数与落盘凭据里的 `toCountSummary()` 可直接对照**（★ 同一套取法）。
 */
export function summarizeEps(sortedAsc: readonly number[]): EpsDistribution {
  const n = sortedAsc.length;
  if (n === 0) {
    return { count: 0, min: 0, mean: 0, p50: 0, p90: 0, p99: 0, p999: 0, max: 0 };
  }
  const nearestRank = (p: number): number => {
    const rank = Math.ceil(p * n);
    const index = Math.min(n - 1, Math.max(0, rank - 1));
    return sortedAsc[index] ?? 0;
  };
  let sum = 0;
  for (const value of sortedAsc) {
    sum += value;
  }
  return {
    count: n,
    min: sortedAsc[0] ?? 0,
    mean: sum / n,
    p50: nearestRank(0.5),
    p90: nearestRank(0.9),
    p99: nearestRank(0.99),
    p999: nearestRank(0.999),
    max: sortedAsc[n - 1] ?? 0,
  };
}

/**
 * ★ **算「字节侧」的临界判据**（★ 纯函数 ⇒ 自测可喂合成数据）。
 *
 * ★ 公式（★ 见文件头的推导）：
 * `N(w) ≤ ⌊(C×(768−w) + N_now×3,072) / 3,072⌋` ⇒ ⇒ 剪枝率上限 = 该上限 ÷ C。
 *
 * ⚠️ ★★ **口径提醒（★ 必读，否则会误用）**：
 * · ★ 它**只管字节**：★ 「省下的码字节」能不能抵住「多读的 embedding 字节」；
 * · ★ 它**不预测**换成 w 之后剪枝率会变成多少（★ ⇒ 那要实测 ⇒ ⇒ 靠 ε 列）；
 * · ★ 它**按 `bytesRead.max` 那个样本算**（★ 因为 `bytesRead` 判定取 `max` ⇒ 决定成败的是它）；
 * · ★ 它**不含 CPU 成本**（★ ⇒ 那是「延迟」列的职责 ⇒ ⇒ ★ 字节侧划算 ≠ 端到端划算）。
 */
export function computeByteSideLimit(
  candidateRows: number,
  exactRowsNow: number,
  newBytesPerRow: number,
): { maxExactRowsAllowed: number; maxPruneRateAllowed: number } | null {
  if (candidateRows <= 0 || newBytesPerRow >= CURRENT_CODE_WIDTH_BYTES) {
    return null;
  }
  const savedBytes = candidateRows * (CURRENT_CODE_WIDTH_BYTES - newBytesPerRow);
  const budget = savedBytes + exactRowsNow * EMBEDDING_ROW_BYTES;
  const maxExactRowsAllowed = Math.floor(budget / EMBEDDING_ROW_BYTES);
  return {
    maxExactRowsAllowed,
    maxPruneRateAllowed: maxExactRowsAllowed / candidateRows,
  };
}

/**
 * ★ **把 ε 分布 + 凭据切片拼成四列表**（★ 纯函数 ⇒ 自测可喂合成数据）。
 */
export function buildCodeWidthTable(
  epsByWidth: ReadonlyMap<CodeWidth, EpsDistribution | null>,
  evidence: EvidenceSlice,
): CodeWidthTable {
  const rows: CodeWidthRow[] = [];
  const missing: MissingColumn[] = [];

  for (const candidate of CANDIDATE_WIDTHS) {
    const bytesPerRow = candidate.bytesPerRow;
    const eps = candidate.width === null ? null : (epsByWidth.get(candidate.width) ?? null);
    const hasMeasured = candidate.implemented && bytesPerRow !== null && eps !== null;
    // ★ **剪枝率与延迟只属于 int8 档**（★ 凭据 `docs/evidence/t07-warm.json` 是 **int8 档**的
    //   ⇒ ⇒ 别的档没有自己的凭据 ⇒ ⇒ ★ 绝不能把 int8 的三列挂到 int4 行上 ⇒ ⇒ 那是假数据）
    const isEvidenceWidth = candidate.width === 'int8';
    const hasEvidence = hasMeasured && isEvidenceWidth;
    const limit =
      bytesPerRow === null
        ? null
        : computeByteSideLimit(
            evidence.candidateUniverseMax,
            evidence.memoryRowsReadMax,
            bytesPerRow,
          );
    rows.push({
      label: candidate.label,
      bytesPerRow: bytesPerRow ?? 0,
      implemented: candidate.implemented,
      eps: hasMeasured ? eps : null,
      pruneRate: hasEvidence ? evidence.pruneRate : null,
      writeP99Ms: hasEvidence ? evidence.writeP99Ms : null,
      vectorRouteP99Ms: hasEvidence ? evidence.vectorRouteP99Ms : null,
      storageMediaClass: hasEvidence ? evidence.storageMediaClass : null,
      pageCacheState: hasEvidence ? evidence.pageCacheState : null,
      maxExactRowsAllowed: limit?.maxExactRowsAllowed ?? null,
      maxPruneRateAllowed: limit?.maxPruneRateAllowed ?? null,
      note: candidate.note,
    });

    // ★ 「还缺哪几列」**按行逐列算**（★ 不是「整行有或没有」）⇒ ⇒ 一档只有 ε 时也要如实记缺两列
    const gaps: string[] = [];
    if (!hasMeasured) {
      gaps.push('ε');
    }
    if (!hasEvidence) {
      gaps.push('剪枝率', '延迟');
    }
    if (gaps.length > 0) {
      missing.push({
        label: candidate.label,
        missing: gaps,
        reason:
          bytesPerRow === null
            ? '★ 连每行字节数都取决于还没定的配置 ⇒ ⇒ 连「字节侧临界值」都算不出'
            : hasMeasured
              ? '★ ε 已实测 ⇒ ★ 但【剪枝率与延迟】要**读路径接线 + 重新采集**才有（★ 凭据 `t07-warm.json` 是 int8 档的）'
              : '★ 未实现 ⇒ ⇒ ε / 剪枝率 / 延迟 三列必须【实现 + 重新编码 + 重新采集】才有',
      });
    }
  }

  return { rows, missing, evidence };
}

/** ★ 百分比格式化（★ 保留 4 位 ⇒ 足够分辨、不至于把噪声当信号）。 */
function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(4)}%`;
}

/** ★ 把分布渲染成「min / p50 / p99 / max」。 */
function renderDistribution(d: Distribution | null): string {
  if (d === null) {
    return '—';
  }
  return `min ${d.min.toFixed(6)} · p50 ${d.p50.toFixed(6)} · p99 ${d.p99.toFixed(6)} · max ${d.max.toFixed(6)}`;
}

/** ★ 人读的表格。 */
export function renderTable(table: CodeWidthTable): string {
  const e = table.evidence;
  const lines: string[] = [];
  lines.push('「码宽 ↔ ε ↔ 剪枝率 ↔ 延迟」四列表（出关条件② · 设计稿 R3 行）');
  lines.push('');
  lines.push(`★ 凭据：1M 语料 · 介质 ${e.storageMediaClass} · 页缓存 ${e.pageCacheState}`);
  lines.push(
    `★ bytesRead.max = ${e.bytesReadMax.toLocaleString('en-US')} B（门槛 ${e.bytesReadBudget.toLocaleString('en-US')} B）· 候选宇宙 max ${e.candidateUniverseMax.toLocaleString('en-US')} 行 · 进精排行数 max ${e.memoryRowsReadMax}`,
  );
  lines.push('');
  lines.push('【表一 · 已实测的档】');
  lines.push(
    '| 码宽 | 每行码字节 | ε（码表实算 ‖x−x̂‖₂） | 剪枝率（进入精排比例） | 延迟（写 P99 / 向量路 P99） |',
  );
  lines.push('|---|---|---|---|---|');
  for (const row of table.rows) {
    if (row.eps === null) {
      continue;
    }
    lines.push(
      `| **${row.label}** | ${row.bytesPerRow} B | ${renderDistribution(row.eps)} | ${renderDistribution(row.pruneRate)} | ${row.writeP99Ms === null ? '—' : `${row.writeP99Ms.toFixed(2)} ms`} / ${row.vectorRouteP99Ms === null ? '—' : `${row.vectorRouteP99Ms.toFixed(2)} ms`}（${row.storageMediaClass ?? '—'} · ${row.pageCacheState ?? '—'}）|`,
    );
  }
  lines.push('');
  lines.push('【表二 · 尚未实现的候选档（★ 字节侧可算 · 精度侧须实测）】');
  lines.push(
    '| 候选档 | 每行码字节 | ★ 字节侧：允许的进精排行数上限 | ★ 字节侧：允许的剪枝率上限 | 还缺哪几列 |',
  );
  lines.push('|---|---|---|---|---|');
  for (const row of table.rows) {
    if (row.eps !== null) {
      continue;
    }
    lines.push(
      `| **${row.label}** | ${row.bytesPerRow > 0 ? `${row.bytesPerRow} B` : '待定'} | ${row.maxExactRowsAllowed ?? '待定'} | ${pct(row.maxPruneRateAllowed)} | ${table.missing.find((m) => m.label === row.label)?.missing.join(' / ') ?? '—'} |`,
    );
  }
  lines.push('');
  lines.push('★ **字节侧临界值的读法**（★ 别误用）：');
  lines.push('  · 它回答的是「换成这个码宽后，**进精排的行数**涨到多少就不再划算」；');
  lines.push('  · 它**不预测**换成这个码宽后剪枝率会变成多少（★ ⇒ 那是 ε 列 + 实测的职责）；');
  lines.push('  · 它**不含 CPU 成本**（★ ⇒ 字节侧划算 ≠ 端到端划算 ⇒ ⇒ 「延迟」列不可省）。');
  return lines.join('\n');
}

/** ★ 读采集库的 ε 分布（★ 只读打开）。 */
function readEpsDistribution(dbPath: string): EpsDistribution {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const values: number[] = [];
    const rows = db.prepare('SELECT eps FROM vector_codes').iterate() as IterableIterator<{
      eps: number;
    }>;
    for (const row of rows) {
      values.push(row.eps);
    }
    values.sort((a, b) => a - b);
    return summarizeEps(values);
  } finally {
    db.close();
  }
}

/**
 * ★ 自测（★ 照仓库其它守卫的形态：正控 + 负控 + 根因断言有牙）。
 */
export function runSelfTest(): readonly string[] {
  const results: string[] = [];
  const evidence: EvidenceSlice = {
    storageMediaClass: 'HDD',
    pageCacheState: 'warm',
    corpusSize: 1000000,
    bytesReadMax: 4065792,
    bytesReadBudget: 6144000,
    candidateUniverseMax: 5286,
    memoryRowsReadMax: 2,
    pruneRate: { count: 200, min: 0, mean: 0.000865, p50: 0.000274, p99: 0.0125, max: 0.037 },
    writeP99Ms: 1800.45,
    vectorRouteP99Ms: 4540.64,
  };

  // ── 正控：分位数取法必须符合「最近秩」──
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const summary = summarizeEps(sorted);
  results.push(
    summary.count === 10 &&
      summary.min === 1 &&
      summary.max === 10 &&
      summary.p50 === 5 &&
      summary.mean === 5.5
      ? '✅ 正控：最近秩分位数（n=10 ⇒ p50 = 第 5 个 = 5 · mean = 5.5）'
      : '❌ 正控失败：分位数取法不对',
  );

  // ── 正控：字节侧临界值（合成数）──
  const limit = computeByteSideLimit(5286, 2, 384);
  const expectedAllowed = Math.floor((5286 * 384 + 2 * 3072) / 3072);
  results.push(
    limit !== null && limit.maxExactRowsAllowed === expectedAllowed
      ? `✅ 正控：int4 的允许进精排行数上限 = ${expectedAllowed} 行（合成数）`
      : '❌ 正控失败：字节侧临界值算错',
  );

  // ── 负控：候选行数为 0 ⇒ 必须拒绝算（否则会除零 ⇒ 给出 Infinity）──
  results.push(
    computeByteSideLimit(0, 2, 384) === null
      ? '✅ 负控：候选行数 = 0 ⇒ 判定必须拒绝出临界值（防除零）'
      : '❌ 负控失败：候选行数 = 0 却算出了临界值',
  );

  // ── 负控：码宽不变或更宽 ⇒ 不存在「省字节」⇒ 临界值无意义 ──
  results.push(
    computeByteSideLimit(5286, 2, 768) === null && computeByteSideLimit(5286, 2, 960) === null
      ? '✅ 负控：码宽未变窄 ⇒ 判定必须拒绝出临界值（防「凭空给出上限」）'
      : '❌ 负控失败：码宽未变窄却算出了临界值',
  );

  // ── 正控：四列表的「缺列登记」必须与「是否已实现」一致 ──
  const table = buildCodeWidthTable(new Map([['int8' as CodeWidth, summary]]), evidence);
  const missingLabels = table.missing.map((m) => m.label).join(',');
  const measuredRows = table.rows.filter((r) => r.eps !== null).length;
  results.push(
    measuredRows === 1 && missingLabels.includes('int4') && missingLabels.includes('PQ')
      ? '✅ 正控：只有已实现的档才有实测三列；未实现的档进了「缺列登记」'
      : '❌ 正控失败：缺列登记与实现状态不一致',
  );

  // ── 负控：★ 根因断言有牙 —— 改坏 ε ⇒ 摘要必须变（★ 否则「算完不看」就是恒绿）──
  const broken = summarizeEps([...sorted].reverse());
  results.push(
    broken.p50 !== summary.p50
      ? '✅ 根因断言有牙：把升序数组打乱 ⇒ p50 变了 ⇒ 判定不是恒绿'
      : '❌ 根因断言失败：打乱后 p50 未变 ⇒ 判定没有分辨力',
  );

  return results;
}

function main(): void {
  if (process.argv.includes('--self-test')) {
    const results = runSelfTest();
    for (const line of results) {
      process.stdout.write(`${line}\n`);
    }
    const failed = results.filter((line) => line.startsWith('❌')).length;
    process.stdout.write(
      failed === 0 ? '\n✓ 自测全过 ⇒ 这条报告器不是恒绿\n' : `\n✗ 自测失败 ${failed} 项\n`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
    return;
  }

  const dbIndex = process.argv.indexOf('--db');
  const dbPath = dbIndex >= 0 ? (process.argv[dbIndex + 1] ?? DEFAULT_DB) : DEFAULT_DB;
  const evidenceIndex = process.argv.indexOf('--evidence');
  const evidencePath =
    evidenceIndex >= 0 ? (process.argv[evidenceIndex + 1] ?? DEFAULT_EVIDENCE) : DEFAULT_EVIDENCE;

  const evidence = sliceEvidence(JSON.parse(readFileSync(evidencePath, 'utf8')));
  // ★ ★ **每档的 ε 各自从自己的库读**（★ 2026-11-06）：★ `--db` 可重复、写法 `<档宽>=<路径>`
  //   （★ 不带 `<档宽>=` 的那个按「当前档」处理 ⇒ ⇒ 兼容旧的单库用法）
  //   ★ 而 **int8 档的 ε 永远从默认库读** ⇒ ⇒ ★ 于是「跑 int4 档」也能同时给出 int8 那行 ⇒ ⇒ ★ 三行表可一次产全
  const widthIndex = process.argv.indexOf('--code-width');
  const rawWidth = widthIndex >= 0 ? (process.argv[widthIndex + 1] ?? 'int8') : 'int8';
  if (rawWidth !== 'int8' && rawWidth !== 'int4' && rawWidth !== 'binary') {
    throw new Error(`--code-width 只接受 int8 / int4 / binary（收到「${rawWidth}」）`);
  }
  const currentWidth = rawWidth as CodeWidth;
  const epsByWidth = new Map<CodeWidth, EpsDistribution | null>();
  const argv = process.argv.slice(1);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    let value: string | undefined;
    if (token.startsWith('--db=')) {
      value = token.slice('--db='.length);
    } else if (token === '--db') {
      value = argv[index + 1];
      index += 1;
    } else {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    const separator = value.indexOf('=');
    if (separator < 0) {
      continue;
    }
    const width = value.slice(0, separator);
    if (width !== 'int8' && width !== 'int4' && width !== 'binary') {
      throw new Error(`--db 的档宽前缀只接受 int8 / int4 / binary（收到「${width}」）`);
    }
    epsByWidth.set(width as CodeWidth, readEpsDistribution(value.slice(separator + 1)));
  }
  if (!epsByWidth.has(currentWidth)) {
    epsByWidth.set(currentWidth, readEpsDistribution(dbPath));
  }
  if (currentWidth !== 'int8' && !epsByWidth.has('int8')) {
    epsByWidth.set('int8', readEpsDistribution(DEFAULT_DB));
  }
  const table = buildCodeWidthTable(epsByWidth, evidence);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderTable(table)}\n`);
}

if (process.argv[1]?.endsWith('report-codewidth-table.ts') === true) {
  main();
}
