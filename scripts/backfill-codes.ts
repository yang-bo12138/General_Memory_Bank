/**
 * **码表回填** —— 把 `memories.embedding`（768 维 float32、已 L2 归一化、小端）
 * 编成 int8 码写进 `vector_codes`（ADR-PERF-01 §8 · C′ 档 T03）。
 *
 * ## 它为什么是一个**独立脚本**，而不是 `ensureSchema()` 的一部分
 *
 * 码表是 `memories.embedding` 的**有损副本**（`x̂ = scale × code`，可随时重算）⇒
 * 「补建空表」（`ensureVectorCodesTable()`，微秒级）与「灌 100 万行」（分钟级）是**两件事**：
 * · 前者必须挂在**每次可写打开**上（否则老库永远没有这张表）；
 * · 后者**绝不能**挂在打开路径上 —— 打开一个库不该顺带跑几分钟的 CPU 活，
 *   而且它需要 `EMBED_DIM`、需要跳过坏行、需要可中断 ⇒ 那是运维动作，不是连接初始化的语义。
 * ⇒ ⇒ 于是：**打开即补表，回填单独跑**（`pnpm codes:backfill`）。
 *
 * ⚠️ **读取路径今天还没有任何读者**（T04 才两段化）⇒ 本脚本可以随时重跑、随时中断，
 *   跑不完**不影响任何现有行为**（无码行走精确兜底，A8）。
 *
 * ## 五个「不显然」的决定（每条都写了「不这么做会怎样」）
 *
 * ① **rowid 游标，不用 `LIMIT/OFFSET`**：OFFSET 是 **O(n) 扫描** —— 翻到第 500 页要重扫前
 *   499 页 ⇒ 100 万行回填的总代价从「一次全扫」变成「500 次全扫的一半」。
 *   游标推进（`WHERE rowid > ? ORDER BY rowid LIMIT ?`）是**每页一次索引定位**。
 *
 * ② **`LEFT JOIN vector_codes` 跳过已编码行**：这是「可断点续跑」的全部实现。
 *   不这么做的代价：中途 kill 后重跑要**全量重编**（100 万行 × 768 维）—— 而且是
 *   重复劳动（码只由 `embedding` 决定，重算一次结果**逐位相同**）。
 *   重跑时 `encoded = 0 / alreadyCoded = N` 就是「幂等」的可观测形状。
 *
 * ③ **只回填「有桶归属」的行**（`JOIN vector_cell_members`）：`fine_id` 只能从桶表取
 *   （码表的主键是 `(fine_id, memory_id)`）。没有归属的行**压根无法被路由**
 *   ⇒ 给它编码是**纯浪费**（768B × N 的写放大 + 磁盘），而且会让码表与桶表的行数
 *   对不上（A6 当场红）。⇒ 跳过并**单独计数**（不是一个「静默的 if」）。
 *
 * ④ **每批一个事务**，不是一个大事务：100 万行单事务 ⇒ WAL 暴涨到 GB 级 + 持写锁数分钟
 *   ⇒ 期间任何写入方都撞 `SQLITE_BUSY`。分批之后最坏情况只丢**一批**的工作量（而且重跑会补上）。
 *
 * ⑤ **坏 `embedding` 计数跳过，不崩**：库里真的会有坏行（老数据 / 调用方塞了非有限值 /
 *   维度漂移）。`encodeVector()` 对 `NaN` / `Inf` 抛 `INVALID_INPUT` —— 那是**编码器的正确行为**
 *   （不许悄悄钳制），但**不是**整个回填应该失败的理由：一条坏行会让 99.9999% 的好行永远编不上。
 *   ⇒ 捕获 `INVALID_INPUT` ⇒ 计入 `skippedBadEmbedding` ⇒ 继续。
 *   ⚠️ 但**不吞其他错误**：非 `INVALID_INPUT` 一律原样抛出（那才是真故障，继续跑只会掩盖它）。
 *
 * ## 用法
 *
 * ```bash
 * pnpm codes:backfill --db=data/ocean.db --dry-run                 # 只算「会写多少行」，一个字节都不写
 * pnpm codes:backfill --db=data/ocean.db --batch-size=2000         # 真跑（可中途 kill，重跑接着走）
 * pnpm codes:backfill --db=data/ocean.db --limit=1000              # 冒烟：只回填前 1000 行
 * pnpm codes:backfill --db=data/ocean.db --force                   # 连已编码的行也重算覆盖
 * ```
 *
 * ⚠️ **参数一律用 `=` 写法**（`--db=...`）。本仓库出过「空格写法被解析成布尔」的事故
 *   （脚本里 `argv.indexOf('--db')` 取到的是下一个 flag）；本文件两种写法**都支持**，
 *   但「`--db` 后面紧跟另一个 flag」会被判成**没给值** ⇒ 报「缺 --db」，而不是猜。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type Database from 'better-sqlite3';

import { MemoryError, translateSqliteError } from '../src/core/errors.js';
import { DEFAULT_PARAMS } from '../src/core/params.js';
import { openDatabase } from '../src/db/connection.js';
import { ensureSchema } from '../src/db/migrate.js';
import { blobToVector } from '../src/vector/centroids.js';
import {
  CODE_WIDTHS,
  type CodeWidth,
  type EncodedVectorWidth,
  codeToBlobWithWidth,
  encodeVectorWithWidth,
} from '../src/vector/quantize.js';

/** 一次回填的用法说明（错误信息里回显，避免「报错了但不知道怎么用」）。 */
export const USAGE =
  '用法：tsx scripts/backfill-codes.ts --db=<库文件> [--batch-size=500] [--dry-run] [--limit=N] [--force] [--code-width=int8|int4|binary]';

/** 每多少批打一行进度（**不逐行刷屏**：100 万行逐行打 = 100 万行日志）。 */
export const PROGRESS_EVERY_BATCHES = 10;

/** 命令行入参。 */
export interface BackfillArgs {
  /** 库文件（**必填**，不猜默认路径 —— 猜错就是往别人的库里写）。 */
  dbPath: string;
  /** 每批行数（缺省走 `Params.SWEEP_BATCH_SIZE`，与 sweep / 迁移回填同一口径）。 */
  batchSize?: number;
  /** 只看「会写多少行」、**一个字节都不写**（只读打开）。 */
  dryRun: boolean;
  /** 只扫描前 N 行活记忆（冒烟用；输出里会显式声明这是 limit 模式）。 */
  limit?: number;
  /** 忽略「已编码」跳过逻辑，把已存在的码行**重算覆盖**（`INSERT OR REPLACE`）。 */
  force: boolean;
  /**
   * ★ 码宽（★ 2026-11-06 · 出关条件② 的前置 · ★ **缺省 `int8` = 生产现状**）。
   *
   * ⚠️ ★★ **非 `int8` 的档只能用于「统计 ε」**（★ 原因见 `CODE_WIDTH_USAGE_NOTE`）：
   *   ⇒ ⇒ ★ `src/vector/ivf.ts:580` 现在只认「1 字节/维」⇒ ⇒ **非 int8 的码行会被跳过**
   *   ⇒ ⇒ ★ **该库跑召回/剪枝测试只会得到假数据** ⇒ ⇒ ★ **不许拿它跑 bench**
   */
  codeWidth?: CodeWidth;
}

/**
 * ★ 非 `int8` 档的**使用边界**（★ 每次跑都原样打出来 ⇒ ★ 免得有人拿它跑 bench 得出假数）。
 */
export const CODE_WIDTH_USAGE_NOTE =
  '★ 本档码宽【不是 int8】⇒ ⇒ 该库的码行**读路径当前会跳过**（★ src/vector/ivf.ts 只认「1 字节/维」）' +
  ' ⇒ ⇒ ★★ **该库只能用于统计 `vector_codes.eps` 的分布**（★ 出关条件② 四列表的 ε 列）' +
  ' ⇒ ⇒ ★★ **不许用它跑召回 / 剪枝 / 延迟测试**（★ 会得到「候选宇宙为空」的假数据）';

/** 坏 `embedding` 的细分原因（诊断用：只说「跳过 12 行」等于没说）。 */
export interface BadEmbeddingBreakdown {
  /** `embedding IS NULL`（老数据 / 调用方没给向量 —— 合法状态，但编不出码）。 */
  nullEmbedding: number;
  /** 字节数不是 4 的倍数（读不成 float32）。 */
  byteLength: number;
  /** 字节数 / 4 ≠ `EMBED_DIM`（维度漂移）。 */
  dimension: number;
  /** 含 `NaN` / `Inf`（`encodeVector()` 抛 `INVALID_INPUT`）。 */
  nonFinite: number;
}

/** 一次回填的计数器。 */
export interface BackfillCounters {
  /** 扫过的活记忆行数（`deleted = 0`，**含**被跳过的）。 */
  scanned: number;
  /** 本次真正写入（或覆盖）的码行数。 */
  encoded: number;
  /** 已有码行、被跳过（幂等重跑时它 == 总行数，`encoded == 0`）。 */
  alreadyCoded: number;
  /** 没有桶归属 ⇒ 跳过（编了也用不上，见文件头 ③）。 */
  skippedNoMembership: number;
  /** 坏 `embedding` ⇒ 跳过（细分见 `badEmbedding`）。 */
  skippedBadEmbedding: number;
  /** 坏 `embedding` 的细分原因。 */
  badEmbedding: BadEmbeddingBreakdown;
}

/**
 * ★ A6 三表一致性（设计稿 §6 的 A6 断言，**两句话都要**）。
 *
 * A6 的原话有两半，缺了后一半就会**假绿**（QA 实测：行数全相等、`fine_id` 已漂移，
 * 自检却报「通过」⇒ T04 上线后那一批行会被**静默漏召回**）：
 *
 * ① **行数口径**：`codes` / `members` / `memories` 三数相等（`mismatch === 0`）；
 * ② **桶归属口径**：
 *    · 每条码行都能在桶表里找到归属（`lonelyCodes === 0`）；
 *    · 同一个 `memory_id` 在两张表里的 `fine_id` 相同（`fineIdDrift === 0`）。
 *
 * ⚠️ ②的两项**不可能**由①推出：①只数行数，「换桶后码行留在旧桶」时行数一行没少
 *   （`codes = members = memories` 全相等）⇒ 只有 ② 能看见它。
 * ⚠️ ②的两项也**互不覆盖**：`lonelyCodes` 抓「归属丢了」，`fineIdDrift` 抓「归属搬了」。
 */
export interface A6Consistency {
  /**
   * **活记忆域**里的码行数（★ R11 订正：**不是** `SELECT count(*) FROM vector_codes`）。
   *
   * 实际口径（与实现逐字一致，见 `snapshotConsistency()`）：
   * ```sql
   * SELECT count(*) FROM vector_codes vc
   *   JOIN memories m ON m.id = vc.memory_id
   *  WHERE m.deleted = 0
   * ```
   * ⚠️ **这条注释曾经是旧口径**（`SELECT count(*) FROM vector_codes`，「只有活行」的理由
   *   来自「回填只扫活行」，而**查**的时候并不是）⇒ 与 `members` / `memories` 不同域
   *   ⇒ 一条「软删 + 有向量 + 有归属」的记忆就足以让 `mismatch ≠ 0` 而 A6 恒红。
   *   ⇒ 注释与判定两套词正是上次「假绿 / 恒红」的成因，故同步到实现。
   */
  codes: number;
  /**
   * **活记忆域**里的桶成员行数（★ R11 订正：**不是** `SELECT count(*) FROM vector_cell_members`
   * —— 那条会**含软删行的归属**，而 `forget.ts` 故意保留它们，见 `snapshotConsistency()`）。
   *
   * 实际口径：
   * ```sql
   * SELECT count(*) FROM vector_cell_members vcm
   *   JOIN memories m ON m.id = vcm.memory_id
   *  WHERE m.deleted = 0
   * ```
   */
  members: number;
  /** `SELECT count(*) FROM memories WHERE deleted = 0 AND embedding IS NOT NULL`。 */
  memories: number;
  /**
   * **总偏差** = `|codes − members| + |members − memories|`。
   *
   * ⚠️ **语义只限「行数」**，`lonelyCodes` / `fineIdDrift` **不许**加进来：
   *   这个数是历史报告/门禁已经在看的数，混进别的口径会让同一条库的数值「变形」
   *   （运维会以为回填坏了，其实只是换桶了）。
   *
   * ⚠️ **为什么是一个数、而不是布尔**：「不一致」有三种形状（码表少 / 桶表多 / 记忆多），
   *   运维需要知道**差多少**才能判断「再跑一次就补齐」还是「桶表本身坏了」。
   * ⚠️ **为什么用链式两项相加**：只比其中一对会漏掉另一对
   *   （`codes == members` 但 `memories` 多 100 行 —— 只比第一对就「绿」了）。
   */
  mismatch: number;
  /**
   * ★ A6 后半句之一：**码表里有、桶表里找不到归属**的码行数。
   *
   * `LEFT JOIN vector_cell_members ... WHERE vcm.memory_id IS NULL`
   * ⇒ 这些码行**永远取不到**（T04 的两段式是「先按桶定候选集，再取码」）。
   *
   * ⚠️ 用 **SQL 聚合**而不是拉进 JS 数：100 万行的码表不能为了自检被读成 100 万个对象
   *   （`code` 是 768B 的 BLOB，`SELECT *` 会把 784MB 全搬进堆）。
   */
  lonelyCodes: number;
  /**
   * ★ A6 后半句之二：同一个 `memory_id` 在 `vector_codes` 与 `vector_cell_members`
   * 里 **`fine_id` 不同**的行数（`JOIN ON memory_id WHERE vc.fine_id <> vcm.fine_id`）。
   *
   * 这是「换桶后码行没跟着搬」的唯一可观测形状（行数不变 ⇒ `mismatch` 恒为 0）。
   */
  fineIdDrift: number;
}

/** 一次运行的完整结果。 */
export interface BackfillResult {
  /** 干跑？（干跑不写库，也**不**用 A6 判失败 —— 回填本来还没发生）。 */
  dryRun: boolean;
  /** limit 模式？（输出必须显式声明） */
  limitMode: boolean;
  /** force 模式？（已编码行被重算覆盖） */
  forced: boolean;
  /** 实际生效的批次大小。 */
  batchSize: number;
  /** 实际跑了多少批。 */
  batches: number;
  counters: BackfillCounters;
  /** 干跑时「会写多少行」；真跑时为 `null`（看 `counters.encoded`）。 */
  wouldWrite: number | null;
  /** ★ A6 快照（真跑是「跑完之后」；干跑是「现在库里」）。 */
  consistency: A6Consistency;
  /**
   * ★ **A6 复合判定**（`isA6Passed()`）：行数口径 **且** 桶归属口径都成立
   * （`mismatch === 0 && lonelyCodes === 0 && fineIdDrift === 0`）。
   *
   * ⚠️ 这里**不是** `mismatch === 0`：只数行数的判定会对着「换桶后的 `fine_id` 漂移」
   *   说「通过」（QA 实测的假绿）。
   */
  a6Passed: boolean;
  /** limit 模式下「全库活记忆数」（非 limit 模式为 `null`，不去白扫一遍）。 */
  liveMemoriesTotal: number | null;
  /** 耗时（毫秒，注入的时钟）。 */
  elapsedMs: number;
}

/** 一行进度（**不逐行**：每 `PROGRESS_EVERY_BATCHES` 批一次）。 */
export interface BackfillProgress {
  batches: number;
  scanned: number;
  encoded: number;
  alreadyCoded: number;
  skippedNoMembership: number;
  skippedBadEmbedding: number;
  elapsedMs: number;
}

/** 进度回调（测试里传空实现 ⇒ 不污染测试输出）。 */
export type ProgressSink = (progress: BackfillProgress) => void;

/** `runBackfill()` 的可注入依赖（时钟 / 进度出口 —— 测试用）。 */
export interface BackfillRunOptions {
  /** 时钟（缺省 `Date.now`；测试可注入固定值）。 */
  now?: () => number;
  /** 进度出口（缺省写 stderr）。 */
  onProgress?: ProgressSink;
  /**
   * ★ 告警出口（★ 2026-11-06 新增 · ★ 缺省写 stderr；测试可注入空实现 ⇒ 不污染测试输出）。
   *
   * ⚠️ **为什么不走 `onProgress`**：★ `onProgress` 收的是**结构化进度**（`BackfillProgress`）
   *   ⇒ ⇒ ★ 而告警是**一句话** ⇒ ⇒ ★ 塞进去会把结构弄脏 ⇒ ⇒ ★ 单开一个出口。
   */
  warn?: (message: string) => void;
}

/** 默认进度出口：**stderr**（stdout 留给最终报告，别让进度把报告冲散）。 */
const writeProgressToStderr: ProgressSink = (progress: BackfillProgress): void => {
  process.stderr.write(
    `… 批 ${String(progress.batches)}｜已扫 ${String(progress.scanned)}` +
      `｜encoded ${String(progress.encoded)}｜alreadyCoded ${String(progress.alreadyCoded)}` +
      `｜无归属 ${String(progress.skippedNoMembership)}｜坏向量 ${String(progress.skippedBadEmbedding)}` +
      `｜${String(Math.round(progress.elapsedMs / 1000))}s\n`,
  );
};

/**
 * 读一个选项的值（**同时支持 `--name=value` 与 `--name value`**）。
 *
 * ⚠️ **`--name` 后面紧跟另一个 flag（或什么都没有）⇒ 返回 `undefined`**：
 *   这就是「空格写法被解析成布尔」那个事故的防线 —— 宁可报「缺 --db」，
 *   也不要把 `--dry-run` 当成库路径去 `resolve()`。
 *
 * @param argv 参数表
 * @param name 选项名（含前导 `--`）
 * @returns 值，或 `undefined`（没给 / 给了个空值）
 */
export function readOption(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith(prefix)) {
      const value = token.slice(prefix.length);
      return value === '' ? undefined : value;
    }
    if (token === name) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return undefined;
      }
      return next;
    }
  }
  return undefined;
}

/** 解析一个「>= 1 的整数」选项（**非法值一律抛错**，不静默回退到默认值）。 */
function readPositiveInt(argv: readonly string[], name: string): number | undefined {
  const raw = readOption(argv, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw MemoryError.invalidInput(`${name} 必须是 >= 1 的整数（收到 ${raw}）`, {
      reason: name,
      expected: '>= 1 的整数',
      actual: raw,
    });
  }
  return value;
}

/**
 * 解析命令行。
 *
 * ⚠️ **缺 `--db` 一律抛错**（同 `scripts/migrate.ts` / `scripts/backup.ts`）：
 *   猜默认路径 ⇒ 可能往**另一个库**写，而且回填是**写 784MB** 的动作，猜错的代价不可逆。
 */
export function parseArgs(argv: readonly string[]): BackfillArgs {
  const rawDb = readOption(argv, '--db');
  if (rawDb === undefined) {
    throw MemoryError.invalidInput(`缺 --db（必填，不猜默认路径）。${USAGE}`, {
      reason: 'db',
      expected: '--db=<库文件>',
      actual: argv.join(' '),
    });
  }

  const batchSize = readPositiveInt(argv, '--batch-size');
  const limit = readPositiveInt(argv, '--limit');

  // ★ 码宽（★ 缺省 int8 = 生产现状 ⇒ ⇒ 不传就是零行为变更）
  const rawCodeWidth = readOption(argv, '--code-width');
  let codeWidth: CodeWidth = 'int8';
  if (rawCodeWidth !== undefined) {
    if (!CODE_WIDTHS.includes(rawCodeWidth as CodeWidth)) {
      throw MemoryError.invalidInput(`--code-width 只接受 ${CODE_WIDTHS.join(' / ')}。${USAGE}`, {
        reason: 'code-width',
        expected: CODE_WIDTHS.join(' / '),
        actual: rawCodeWidth,
      });
    }
    codeWidth = rawCodeWidth as CodeWidth;
  }

  // ★★ **安全闸**：换码宽**必须**带 `--force`
  //   ⇒ ⇒ 理由：没有 `--force` 时脚本会**跳过已编码的行** ⇒ ⇒ 产出的是「一部分 int8 + 一部分 int4」
  //     的**混合库** ⇒ ⇒ 而那是最难认出来的中间态 ⇒ ⇒ **宁可报错也不让它发生**
  const force = argv.includes('--force');
  if (codeWidth !== 'int8' && !force) {
    throw MemoryError.invalidInput(
      `换码宽（${codeWidth}）必须带 --force：★ 否则脚本会跳过已编码的行 ⇒ ⇒ 产出「混合码宽」的库。${USAGE}`,
      {
        reason: 'force',
        expected: '--force',
        actual: '未传',
      },
    );
  }

  return {
    dbPath: resolve(rawDb),
    // ⚠️ 条件展开（`exactOptionalPropertyTypes`）：显式 `batchSize: undefined` 与「不传」是两件事。
    ...(batchSize === undefined ? {} : { batchSize }),
    ...(limit === undefined ? {} : { limit }),
    dryRun: argv.includes('--dry-run'),
    force,
    codeWidth,
  };
}

/** 空的计数器（每次都从新对象开始 —— 共享字面量对象会被累加成脏数据）。 */
function emptyCounters(): BackfillCounters {
  return {
    scanned: 0,
    encoded: 0,
    alreadyCoded: 0,
    skippedNoMembership: 0,
    skippedBadEmbedding: 0,
    badEmbedding: { nullEmbedding: 0, byteLength: 0, dimension: 0, nonFinite: 0 },
  };
}

/** 码表在不在（**只读探测**：干跑时不许建表，所以要能问「有没有」）。 */
export function hasVectorCodesTable(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'vector_codes'",
    )
    .get() as { n: number };
  return row.n > 0;
}

/**
 * 取一次 A6 快照（三表行数 + 总偏差 + 桶归属口径；**纯读**）。
 *
 * ★★ **R11 订正（2026-11-05）：三数统一到「活记忆域」**（`deleted = 0`）。
 *
 * **改前的形状**（三个数各自的口径互不相容）：
 * ```
 * codes    = count(vector_codes)                                       ← 只有活行（回填只扫活行）
 * members  = count(vector_cell_members)                                ← ★ 含软删行的归属
 * memories = count(memories WHERE deleted = 0 AND embedding NOT NULL)  ← 只有活行
 * ```
 * ⇒ 库里只要有 ≥1 条「软删 + 有向量 + 有桶归属」的记忆（`forget.ts` 只改 `deleted = 1`、
 *   **不**调 `unassignBucket` ⇒ 归属**故意**留着），`members > codes` ⇒ `mismatch ≠ 0`
 *   ⇒ **A6 恒红，且红得没有信息量**（它报的是「软删机制在工作」，不是「码表坏了」）。
 *
 * **改后的形状**（三数都在「活记忆域」内数）：
 * ```
 * codes    = count(vector_codes vc JOIN memories m ON m.id = vc.memory_id WHERE m.deleted = 0)
 * members  = count(vector_cell_members vcm JOIN memories m ON m.id = vcm.memory_id WHERE m.deleted = 0)
 * memories = count(memories WHERE deleted = 0 AND embedding IS NOT NULL)   ← 不动
 * ```
 * ⚠️ **为什么不是「删掉软删行的桶归属」**（那是修错了地方）：软删**保留**归属与向量是**裁决过的语义**
 *   （§9.3.2 ②：`restore()` 要能把它恢复回向量路）。为了「让 A6 绿」去删它 ⇒ 恢复之后这条记忆
 *   **永久进不了向量路**（静默、永久）。⇒ 该改的是**读数口径**，不是数据。
 * ⚠️ **代价**：`members` / `codes` 现在各带一次 `memories` 主键探针（1M 行 ≈ 每条一次索引定位）。
 *   这是自检脚本（运维动作），不在召回路径上 ⇒ 可接受。
 * ⚠️ **R11 之后 `scanned` 与 A6 的「同源偏差」仍然存在**（T04 的 `scanned` 数成员行、含软删成员，
 *   见 `BucketCandidateScan.scanned`）—— 两件事分开看：A6 查「码表与桶表在**活记忆域**里对齐没」，
 *   `scanned` 查「这次扫了多少成员行」。用 A1' 负控钉住后者。
 *
 * @param db 库句柄
 * @returns A6 快照（**全部数都在活记忆域内**）
 */
export function snapshotConsistency(db: Database.Database): A6Consistency {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  // ★ R11：`codes` / `members` 都 `JOIN memories` 只数活行 ⇒ 与 `memories` 同域。
  const codes = count(`
    SELECT count(*) AS n
      FROM vector_codes vc
      JOIN memories m ON m.id = vc.memory_id
     WHERE m.deleted = 0
  `);
  const members = count(`
    SELECT count(*) AS n
      FROM vector_cell_members vcm
      JOIN memories m ON m.id = vcm.memory_id
     WHERE m.deleted = 0
  `);
  const memories = count(
    'SELECT count(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL',
  );
  // ★ A6 后半句之一：有码、无桶归属（`LEFT JOIN` 判 NULL；**在 SQL 里数**，不拉进 JS）
  //   ⚠️ **R11：也在活记忆域内判** —— 否则一条软删行的「有码无归属」会污染这个数，
  //     而那不是 T05 要修的东西（软删行的归属本来就该由 `restore()` 决定）。
  const lonelyCodes = count(`
    SELECT count(*) AS n
      FROM vector_codes vc
      JOIN memories m ON m.id = vc.memory_id AND m.deleted = 0
      LEFT JOIN vector_cell_members vcm ON vcm.memory_id = vc.memory_id
     WHERE vcm.memory_id IS NULL
  `);
  // ★ A6 后半句之二：同 memory 但 `fine_id` 不同（`JOIN` 走两张表的 `memory_id` 唯一索引）
  //   ⚠️ **R11：同样在活记忆域内判**（理由同上：软删行的桶归属不参与 A6 的判定）。
  const fineIdDrift = count(`
    SELECT count(*) AS n
      FROM vector_codes vc
      JOIN memories m ON m.id = vc.memory_id AND m.deleted = 0
      JOIN vector_cell_members vcm ON vcm.memory_id = vc.memory_id
     WHERE vc.fine_id <> vcm.fine_id
  `);
  return {
    codes,
    members,
    memories,
    mismatch: Math.abs(codes - members) + Math.abs(members - memories),
    lonelyCodes,
    fineIdDrift,
  };
}

/**
 * ★ **A6 的复合判定**：两句都成立才算通过。
 *
 * ⚠️ 退出码、打印、`BackfillResult.a6Passed` **全部**只走这一个函数 ——
 *   分散写三处 `consistency.xxx === 0 && ...` 就一定会漏掉一处（这次那个洞就是这么来的：
 *   判定里只有前半句，而打印却说「码表 == 桶表」）。
 *
 * @param consistency A6 快照
 * @returns 行数口径与桶归属口径**同时**成立
 */
export function isA6Passed(consistency: A6Consistency): boolean {
  return (
    consistency.mismatch === 0 && consistency.lonelyCodes === 0 && consistency.fineIdDrift === 0
  );
}

/**
 * 干跑的统计口径：**只用 SQL 聚合**，不把 3KB 的 BLOB 读到 JS 里。
 *
 * ⚠️ `length(embedding)` **不需要读 BLOB 载荷**（长度在记录头里）⇒ 100 万行的干跑是
 *   「一次索引/表扫」而不是「3GB 读 + 3GB 解包」。这也是干跑能在秒级返回的原因。
 * ⚠️ `LIMIT @limit`：`-1` = 不限制（SQLite 的 `LIMIT -1` 就是「全部」，
 *   比「拼两段 SQL」少一处漂移面）。
 * ⚠️ **NaN / Inf 查不出来**（SQL 看不见 float32 的内容）⇒ 干跑给出的 `wouldWrite` 是
 *   **上界**，报告里明写了这一点（宁可说「会写 ≤ N 行」，也不假装精确）。
 */
const DRY_RUN_SQL = `
WITH scope AS (
  SELECT rowid AS rowid, id AS memory_id, length(embedding) AS embedding_bytes
    FROM memories
   WHERE deleted = 0
   ORDER BY rowid
   LIMIT @limit
)
SELECT
  count(*) AS scanned,
  COALESCE(sum(CASE WHEN vcm.memory_id IS NULL THEN 1 ELSE 0 END), 0) AS no_membership,
  COALESCE(sum(CASE WHEN vcm.memory_id IS NOT NULL
                     AND (m.embedding_bytes IS NULL
                          OR m.embedding_bytes % 4 <> 0
                          OR m.embedding_bytes <> @bytes) THEN 1 ELSE 0 END), 0) AS bad_embedding,
  COALESCE(sum(CASE WHEN vcm.memory_id IS NOT NULL
                     AND m.embedding_bytes IS NOT NULL
                     AND m.embedding_bytes % 4 = 0
                     AND m.embedding_bytes = @bytes
                     AND vc.memory_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS already_coded,
  COALESCE(sum(CASE WHEN vcm.memory_id IS NOT NULL
                     AND m.embedding_bytes IS NOT NULL
                     AND m.embedding_bytes % 4 = 0
                     AND m.embedding_bytes = @bytes
                     AND vc.memory_id IS NULL THEN 1 ELSE 0 END), 0) AS pending
  FROM scope m
  LEFT JOIN vector_cell_members vcm ON vcm.memory_id = m.memory_id
  LEFT JOIN vector_codes vc ON vc.memory_id = m.memory_id
`;

/**
 * 真跑的扫描：**一批一次**，rowid 游标推进。
 *
 * ⚠️ 三个 `LEFT JOIN` 都在**唯一索引**上（`idx_vcm_memory_unique` / `idx_vcode_memory_unique`）
 *   ⇒ 每行两次索引定位，没有一次全表扫。
 * ⚠️ **不过滤 `embedding IS NOT NULL`**：过滤掉就**永远统计不到**坏行的条数
 *   （「静默跳过」正是要避免的形状）⇒ 让它们进 JS 再分类计数。
 */
const SCAN_SQL = `
SELECT m.rowid      AS rowid,
       m.id         AS memory_id,
       m.embedding  AS embedding,
       vcm.fine_id  AS fine_id,
       vc.memory_id AS coded_memory_id
  FROM memories m
  LEFT JOIN vector_cell_members vcm ON vcm.memory_id = m.id
  LEFT JOIN vector_codes vc ON vc.memory_id = m.id
 WHERE m.deleted = 0 AND m.rowid > @cursor
 ORDER BY m.rowid
 LIMIT @batch
`;

/**
 * 写一行码（**先按 `memory_id` 删旧行，再插**）。
 *
 * ⚠️ **为什么不是只靠 `INSERT OR REPLACE`**：`vector_codes` 的主键是
 *   `(fine_id, memory_id)`，换桶后 `fine_id` 变了 ⇒ 对**主键**来说是**一条新行**；
 *   挡下重复的只有 `idx_vcode_memory_unique(memory_id)`。
 *   实测（SQLite 3.53.4 / better-sqlite3 13）`OR REPLACE` 确实会因那条唯一索引**先删旧行**
 *   —— 但那是一条**不那么显然**的 REPLACE 语义（依赖「secondary unique index 也参与
 *   REPLACE 的删除」）⇒ 换 SQLite 版本 / 有人重建表时漏掉那个索引，「同 memory 两行」
 *   就会**静默**发生（T04 按桶取码时会取到旧桶那条 ⇒ 召回结果错）。
 *   ⇒ 把「同一 `memory_id` 在码表里**恒为 1 行**」写成**本脚本自己的性质**：
 *      `DELETE ... WHERE memory_id = ?`（走 `idx_vcode_memory_unique`，一次索引定位）
 *      再插。`OR REPLACE` 保留作第二道保险（同批内不可能重复，但便宜的保险不删）。
 *
 * ⚠️ **必须在同一个事务里**（见 `insertBatch`）：删了但没插进去 ⇒ 那一行变成「无码」
 *   ⇒ 反而制造 A6 红（宁可什么都没发生）。
 */
const INSERT_SQL = `
INSERT OR REPLACE INTO vector_codes (fine_id, memory_id, code, scale, eps)
VALUES (?, ?, ?, ?, ?)
`;

/** 删掉某个 `memory_id` 的旧码行（换桶/覆盖前的**前置**动作，见 `INSERT_SQL` 的注释）。 */
const DELETE_CODE_SQL = 'DELETE FROM vector_codes WHERE memory_id = ?';

/** 扫描出来的一行（`LEFT JOIN` 的列可能是 `null`）。 */
interface ScanRow {
  rowid: number;
  memory_id: string;
  embedding: Buffer | null;
  fine_id: string | null;
  coded_memory_id: string | null;
}

/** 待写入的一行码。 */
interface CodeRow {
  fineId: string;
  memoryId: string;
  blob: Buffer;
  scale: number;
  eps: number;
}

/** 干跑（**只读打开**：就算代码写错也写不进去）。 */
function runDryRun(
  args: BackfillArgs,
  batchSize: number,
  expectedBytes: number,
  now: () => number,
): BackfillResult {
  const startedAt = now();
  // ⚠️ `openDatabase({ readonly: true })` 就是 `{ readonly: true, fileMustExist: true }`
  //   （见 `src/db/connection.ts`）⇒ 句柄本身拒绝任何写，比「记得别写」可靠。
  const db = openDatabase({ dbPath: args.dbPath, readonly: true });
  try {
    if (!hasVectorCodesTable(db)) {
      // ⚠️ **不许静默成功**：干跑的唯一产出是「会写多少行」，而这个数**必须**以码表已存在为前提
      //   （否则「会写 N 行」与「一张表都没有」是同一句输出，运维据此判断不了任何事）。
      //   ⇒ 明确告诉运维「先去可写打开补建表」并**非零退出**。
      throw MemoryError.invalidInput(
        '干跑无法进行：库里还没有 vector_codes 表（只读句柄不能建表）。' +
          `需要先可写打开补建表：跑一次不带 --dry-run 的 \`pnpm codes:backfill --db=${args.dbPath}\`，` +
          '或任何会可写打开该库的入口（`ensureSchema()` 会幂等补建）。',
        { reason: 'vector_codes_missing', path: args.dbPath, expected: 'vector_codes 表已存在' },
      );
    }

    const aggregate = db.prepare(DRY_RUN_SQL).get({
      limit: args.limit ?? -1,
      bytes: expectedBytes,
    }) as {
      scanned: number;
      no_membership: number;
      bad_embedding: number;
      already_coded: number;
      pending: number;
    };

    const counters = emptyCounters();
    counters.scanned = aggregate.scanned;
    counters.skippedNoMembership = aggregate.no_membership;
    counters.skippedBadEmbedding = aggregate.bad_embedding;
    counters.alreadyCoded = args.force ? 0 : aggregate.already_coded;
    // ⚠️ `--force` ⇒ 已编码的行**也会被重算** ⇒ 「会写」= pending + already_coded
    const wouldWrite = args.force ? aggregate.pending + aggregate.already_coded : aggregate.pending;

    const consistency = snapshotConsistency(db);
    // ⚠️ limit 模式要给出「全库分母」，否则「只扫了 1000 行」这句话没有对照
    //   （报告里那句「不是全库结果」必须有**具体数字**支撑）。
    let liveMemoriesTotal: number | null = null;
    if (args.limit !== undefined) {
      liveMemoriesTotal = (
        db.prepare('SELECT count(*) AS n FROM memories WHERE deleted = 0').get() as { n: number }
      ).n;
    }

    return {
      dryRun: true,
      limitMode: args.limit !== undefined,
      forced: args.force,
      batchSize,
      batches: 0,
      counters,
      wouldWrite,
      consistency,
      // ⚠️ 干跑**不判** A6：回填本来还没发生 ⇒ 这个字段在这里只作「当前库里三表是否齐」的陈述，
      //   退出码不看它（否则对一个空库干跑就必然 exit 1，把「还没回填」误报成「不一致」）。
      a6Passed: isA6Passed(consistency),
      liveMemoriesTotal,
      elapsedMs: now() - startedAt,
    };
  } finally {
    db.close();
  }
}

/**
 * 跑一次回填。
 *
 * @param args 命令行入参
 * @param options 可注入依赖（时钟 / 进度出口）
 * @returns 结果（含 A6 快照：三表行数 + 总偏差 + 桶归属口径的两个数）
 * @throws {MemoryError} `NOT_FOUND`（库文件不存在）/ `INVALID_INPUT`（参数非法 · 干跑缺码表）
 */
export function runBackfill(args: BackfillArgs, options: BackfillRunOptions = {}): BackfillResult {
  const now = options.now ?? ((): number => Date.now());
  const onProgress = options.onProgress ?? writeProgressToStderr;
  const warn =
    options.warn ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    });

  const batchSize = args.batchSize ?? DEFAULT_PARAMS.SWEEP_BATCH_SIZE;
  const expectedBytes = DEFAULT_PARAMS.EMBED_DIM * 4;
  const codeWidth = args.codeWidth ?? 'int8';

  // ★★ **码宽告警（★ 非 int8 时每次都打）**：★ 这一行的存在理由 =
  //   「免得有人拿一个 int4/二值的库去跑 bench ⇒ ⇒ 读到「候选宇宙为空」的假数据却以为码坏了」
  if (codeWidth !== 'int8') {
    warn(`⚠ ${CODE_WIDTH_USAGE_NOTE}`);
  }

  if (!existsSync(args.dbPath)) {
    throw MemoryError.notFound(`库文件不存在：${args.dbPath}`, { path: args.dbPath });
  }

  if (args.dryRun) {
    return runDryRun(args, batchSize, expectedBytes, now);
  }

  const startedAt = now();
  const db = openDatabase({ dbPath: args.dbPath });
  try {
    // ⚠️ **写库前先 `ensureSchema(db)`**：存量库（`user_version = 2`）的码表由它幂等补建
    //   （`ensureSchema()` 对 v2 库早退、不重跑建库脚本 ⇒ 建库脚本里那行对它永不执行）。
    //   `PRAGMA foreign_keys` 不在这里设：那是 `openDatabase()` 的职责（§9.1 的连接初始化）。
    ensureSchema(db);

    const scanStmt = db.prepare(SCAN_SQL);
    const insertStmt = db.prepare(INSERT_SQL);
    const deleteCodeStmt = db.prepare(DELETE_CODE_SQL);
    // ★ 每批一个事务：100 万行单事务 ⇒ WAL 暴涨 + 持写锁数分钟（见文件头 ④）
    // ⚠️ 「删旧行 + 插新行」**必须在同一事务内**：只删不插会让那一行变成「无码」（A6 红）。
    const insertBatch = db.transaction((rows: readonly CodeRow[]): void => {
      for (const row of rows) {
        // ★ 先删「同一 memory 的旧码行」⇒ 换桶后旧 `fine_id` 的那一行不会留下（见 `INSERT_SQL`）
        deleteCodeStmt.run(row.memoryId);
        insertStmt.run(row.fineId, row.memoryId, row.blob, row.scale, row.eps);
      }
    });

    const counters = emptyCounters();
    let cursor = 0;
    let batches = 0;

    for (;;) {
      const take =
        args.limit === undefined ? batchSize : Math.min(batchSize, args.limit - counters.scanned);
      if (take <= 0) {
        break;
      }
      const rows = scanStmt.all({ cursor, batch: take }) as ScanRow[];
      if (rows.length === 0) {
        break;
      }
      batches += 1;

      const pending: CodeRow[] = [];
      for (const row of rows) {
        // ① 没有桶归属 ⇒ 编了也用不上（见文件头 ③）
        if (row.fine_id === null) {
          counters.skippedNoMembership += 1;
          continue;
        }
        // ② 已编码 ⇒ 跳过（幂等重跑的**全部实现**，见文件头 ②）
        if (!args.force && row.coded_memory_id !== null) {
          counters.alreadyCoded += 1;
          continue;
        }
        // ③ 坏 embedding 计数跳过（不许崩，见文件头 ⑤）
        const embedding = row.embedding;
        if (embedding === null) {
          counters.skippedBadEmbedding += 1;
          counters.badEmbedding.nullEmbedding += 1;
          continue;
        }
        if (embedding.byteLength % 4 !== 0) {
          counters.skippedBadEmbedding += 1;
          counters.badEmbedding.byteLength += 1;
          continue;
        }
        if (embedding.byteLength !== expectedBytes) {
          counters.skippedBadEmbedding += 1;
          counters.badEmbedding.dimension += 1;
          continue;
        }

        let encoded: EncodedVectorWidth;
        try {
          // ★ 统一走 `encodeVectorWithWidth`（★ int8 档的落库**字节与既有 `encodeVector` 逐位相同**
          //   ⇒ ⇒ 由 `tests/unit/quantize.test.ts` 的「int8 路径逐位不变」那条断言背书）
          encoded = encodeVectorWithWidth(blobToVector(embedding), codeWidth);
        } catch (error) {
          // ⚠️ **只吞 `INVALID_INPUT`**（含 NaN / Inf）：那是「这一行坏了」，不是「回填坏了」
          if (error instanceof MemoryError && error.code === MemoryError.INVALID_INPUT) {
            counters.skippedBadEmbedding += 1;
            counters.badEmbedding.nonFinite += 1;
            continue;
          }
          throw error;
        }

        pending.push({
          fineId: row.fine_id,
          memoryId: row.memory_id,
          blob: codeToBlobWithWidth(encoded.code),
          scale: encoded.scale,
          eps: encoded.eps,
        });
      }

      if (pending.length > 0) {
        try {
          insertBatch(pending);
        } catch (error) {
          // ⚠️ **裸的 SQLite 错误码不许穿到调用方**（§11.2）：`SQLITE_BUSY` / `SQLITE_LOCKED` ⇒
          //   `DATABASE_BUSY`（这是**可分流**的：等一会儿重跑就补上，因为回填是幂等的）；
          //   `translateSqliteError()` 对不在封闭集合内的错误**原样重抛**（不硬塞 code）。
          //   ⚠️ 只包写入这一处：读循环里的错误交给上层原样冒泡（那里没有可分流语义）。
          throw translateSqliteError(error, { path: args.dbPath });
        }
        counters.encoded += pending.length;
      }

      counters.scanned += rows.length;
      cursor = (rows[rows.length - 1] as ScanRow).rowid;

      if (batches % PROGRESS_EVERY_BATCHES === 0) {
        onProgress({
          batches,
          scanned: counters.scanned,
          encoded: counters.encoded,
          alreadyCoded: counters.alreadyCoded,
          skippedNoMembership: counters.skippedNoMembership,
          skippedBadEmbedding: counters.skippedBadEmbedding,
          elapsedMs: now() - startedAt,
        });
      }
    }

    const consistency = snapshotConsistency(db);
    let liveMemoriesTotal: number | null = null;
    if (args.limit !== undefined) {
      // ⚠️ 只在 limit 模式算全库分母（它是「这份结果不代表全库」的证据）；
      //   非 limit 模式它必然等于 `counters.scanned`，白扫一遍没意义。
      liveMemoriesTotal = (
        db.prepare('SELECT count(*) AS n FROM memories WHERE deleted = 0').get() as { n: number }
      ).n;
    }

    return {
      dryRun: false,
      limitMode: args.limit !== undefined,
      forced: args.force,
      batchSize,
      batches,
      counters,
      wouldWrite: null,
      consistency,
      // ★ 复合判定（行数口径 + 桶归属口径）—— **唯一**的通过口径，退出码只看它
      a6Passed: isA6Passed(consistency),
      liveMemoriesTotal,
      elapsedMs: now() - startedAt,
    };
  } finally {
    db.close();
  }
}

/** 把结果渲染成一段人能读的报告（**失败也要能看出是哪种失败**）。 */
export function formatReport(result: BackfillResult, args: BackfillArgs): string {
  const lines: string[] = [];
  const { counters, consistency } = result;

  lines.push(`库：${args.dbPath}`);
  lines.push(
    result.dryRun
      ? '模式：干跑（只读打开，一个字节都不写）'
      : `模式：实跑（batch-size=${String(result.batchSize)}，force=${result.forced ? '是' : '否'}）`,
  );

  // ⚠️ limit 模式**必须显式声明**：否则「encoded=1000」会被读成「这个库只有 1000 条要编」。
  if (result.limitMode) {
    const total = result.liveMemoriesTotal === null ? '未知' : String(result.liveMemoriesTotal);
    lines.push(
      `⚠️ limit 模式：只扫描前 ${String(args.limit ?? 0)} 行活记忆（全库 ${total} 行）` +
        ' —— 下面的数字**不是**全库结果',
    );
  }

  lines.push(`扫过活记忆：${String(counters.scanned)} 行；批次数：${String(result.batches)}`);
  lines.push(
    `encoded ${String(result.dryRun ? 0 : counters.encoded)}` +
      `｜alreadyCoded ${String(counters.alreadyCoded)}` +
      `｜无桶归属 ${String(counters.skippedNoMembership)}` +
      `｜坏 embedding ${String(counters.skippedBadEmbedding)}`,
  );
  if (counters.skippedBadEmbedding > 0) {
    const bad = counters.badEmbedding;
    lines.push(
      `坏 embedding 明细：NULL ${String(bad.nullEmbedding)}` +
        `｜字节数非 4 倍数 ${String(bad.byteLength)}` +
        `｜维度 ≠ ${String(DEFAULT_PARAMS.EMBED_DIM)} ${String(bad.dimension)}` +
        `｜含 NaN/Inf ${String(bad.nonFinite)}`,
    );
  }

  // ★ A6 六行（**固定形状**：运维/门禁都按 `A6 <名> = <数>` 这一行 grep）
  // ⚠️ 前四行是**行数口径**（历史报告/门禁一直在看，名字与顺序都不许动）；
  //   后两行是**桶归属口径**（A6 的后半句，补上之前它只存在于设计稿里）。
  lines.push(`A6 codes    = ${String(consistency.codes)}`);
  lines.push(`A6 members  = ${String(consistency.members)}`);
  lines.push(`A6 memories = ${String(consistency.memories)}`);
  lines.push(`A6 mismatch = ${String(consistency.mismatch)}`);
  lines.push(`A6 lonelyCodes = ${String(consistency.lonelyCodes)}`);
  lines.push(`A6 fineIdDrift = ${String(consistency.fineIdDrift)}`);

  if (result.dryRun) {
    lines.push(
      `本轮会写：${String(result.wouldWrite ?? 0)} 行` +
        '（干跑：未写一个字节；NaN/Inf 在 SQL 里查不出来 ⇒ 这是**上界**）',
    );
    lines.push('提示：干跑不判 A6（回填尚未发生）⇒ 退出码只看「参数是否合法 / 码表在不在」');
  } else if (result.a6Passed) {
    // ⚠️ **措辞单独核过**：以前这里写「码表 == 桶表」，而那半句（`fine_id` 集合相等）
    //   **根本没有被算过** ⇒ 打印一句没被验证的话 = 假绿的来源。现在两句话分开说，
    //   每句都对应上面那两行具体的数字。
    lines.push('✓ A6 通过（两句都成立）');
    lines.push(
      `  · 行数口径：codes / members / memories 三数相等（mismatch = ${String(consistency.mismatch)}）`,
    );
    lines.push(
      `  · 桶归属口径：lonelyCodes = ${String(consistency.lonelyCodes)}` +
        ` · fineIdDrift = ${String(consistency.fineIdDrift)}` +
        '（每条码行都有桶归属，且 `fine_id` 与桶表一致）',
    );
  } else {
    lines.push('⚠️ A6 不一致（下面按两个口径分别说明）');
    if (consistency.mismatch !== 0) {
      lines.push(
        `  · 行数口径：codes−members = ${String(consistency.codes - consistency.members)}，` +
          `members−memories = ${String(consistency.members - consistency.memories)}` +
          ' ⇒ 可能原因：回填被中断（再跑一次就补齐）/ 桶归属缺失 / 坏 embedding 无法编码',
      );
    }
    if (consistency.lonelyCodes !== 0 || consistency.fineIdDrift !== 0) {
      lines.push(
        `  · 桶归属口径：lonelyCodes = ${String(consistency.lonelyCodes)}` +
          `（码行找不到桶归属）· fineIdDrift = ${String(consistency.fineIdDrift)}` +
          '（同 memory 的 `fine_id` 与桶表不同）' +
          ' ⇒ 换桶后码行留在旧桶：跑一次 `--force` 重算即可（T04 上线后这类行会被静默漏召回）',
      );
    }
    lines.push('⚠️ 退出码 1');
  }

  const seconds = result.elapsedMs / 1000;
  const rate = seconds > 0 ? Math.round(counters.scanned / seconds) : 0;
  lines.push(`耗时：${seconds.toFixed(2)}s（${String(rate)} 行/s）`);
  return lines.join('\n');
}

// ⚠️ 可选链（biome 的 `useOptionalChain`）：`argv[1]` 在 `node -e` 这类调用下可能是 undefined
const invokedDirectly =
  process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/backfill-codes.ts') === true;

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = runBackfill(args);
    process.stdout.write(`${formatReport(result, args)}\n`);
    // ★ A6 不一致 ⇒ **非零退出码**（真跑才判：干跑时回填本来还没发生）
    if (!result.dryRun && !result.a6Passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    // ⚠️ `MemoryError` 带上 code（运维要能一眼分流：「参数错」还是「库忙」还是一致性红）
    const message = error instanceof Error ? error.message : String(error);
    const prefix = error instanceof MemoryError ? `[${error.code}] ` : '';
    process.stderr.write(`${prefix}${message}\n`);
    process.exitCode = 1;
  }
}
