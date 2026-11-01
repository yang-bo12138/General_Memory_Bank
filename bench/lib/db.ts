/**
 * **bench 的库准备** —— 建库、灌语料、训练分桶。
 *
 * ⚠️ **为什么单独一个文件**：灌 100 万条语料要**分批**落库（峰值内存与规模脱钩），
 *   而这个批处理逻辑**被三个脚本共用**（agreement / perf / baseline-flat）
 *   ⇒ 抄三份必然漂移（C36：同一件事不得有两套实现）。
 *
 * ⚠️ **落库必须走生产口径**：
 *   · `content_tokens` 用**生产分词器**（`src/core/tokenize.ts`）；
 *   · `content_hash` 用**生产哈希**（`sha1(normalize(content))`）；
 *   · `embedding` 用**生产编码**（`src/vector/centroids.ts` 的 `vectorToBlob`）；
 *   ⇒ 否则 bench 测的是「另一套数据」⇒ 结论无效。
 *
 * ⚠️ **桶归属由生产重训序列写**（`src/vector/rebuild.ts`）——
 *   bench **不手工 INSERT 桶行**（§9.3.0 的「桶归属唯一写入点」纪律）。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type Database from 'better-sqlite3';

import { runWriteTransaction } from '../../src/store/transaction.js';
import {
  type CorpusOptions,
  type CorpusRow,
  DEFAULT_CORPUS_OPTIONS,
  generateCorpus,
  toCorpusRow,
} from '../corpus.js';
import {
  BENCH_NOW,
  type PeakRssMeasurement,
  PeakRssSampler,
  encodeVector,
  openBenchDatabase,
  trainBenchBuckets,
} from './harness.js';

/** 灌库的批大小（**一条事务一批** ⇒ 事务日志与回滚粒度都可控）。 */
const INSERT_BATCH_SIZE = 500;

/** 灌库的结果。 */
export interface CorpusLoadResult {
  /** 落库条数。 */
  readonly rows: number;
  /** 灌库耗时（毫秒）。 */
  readonly elapsedMs: number;
  /** 关联条数（`memory_entities`）。 */
  readonly linkCount: number;
}

/**
 * 灌语料（**分批**、**同事务**）。
 *
 * ⚠️ **必须分批**：100 万条一次插 ⇒ 单个事务的 WAL 会膨胀到 GB 级
 *   ⇒ 峰值内存与磁盘写入都会被拖垮。
 * ⚠️ **实体单独建表**：图谱路要 JOIN `memory_entities` ⇒ 没有实体 ⇒ 图谱路恒空
 *   ⇒ 测出来的召回耗时**不代表生产**（生产里图谱路是有候选的）。
 *
 * @param db 库句柄
 * @param options 语料参数
 * @returns 灌库结果
 */
export function loadCorpus(db: Database.Database, options: CorpusOptions): CorpusLoadResult {
  const insertMemory = db.prepare(
    'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
      'source, confidence, stability, difficulty, pin_factor, created_at, last_access, access_count) ' +
      'VALUES (@id, @kind, @content, @contentTokens, @contentHash, @embedding, ' +
      '@source, @confidence, @stability, @difficulty, @pinFactor, @createdAt, @lastAccess, @accessCount)',
  );
  const insertEntity = db.prepare(
    'INSERT OR IGNORE INTO entities (id, name, type, created_at) VALUES (@id, @name, @type, @now)',
  );
  const insertLink = db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (@memoryId, @entityId)',
  );

  const start = process.hrtime.bigint();
  let rows = 0;
  let linkCount = 0;
  let batch: CorpusRow[] = [];

  const flush = (): void => {
    if (batch.length === 0) {
      return;
    }
    runWriteTransaction(db, () => {
      for (const row of batch) {
        insertMemory.run({
          id: row.id,
          kind: 'fact',
          content: row.content,
          contentTokens: row.contentTokens,
          contentHash: row.contentHash,
          embedding: encodeVector(row.embedding),
          source: 'bench',
          confidence: 0.7,
          stability: 30,
          difficulty: 0.5,
          pinFactor: 1,
          createdAt: row.createdAt,
          lastAccess: row.lastAccess,
          accessCount: row.accessCount,
        });
        for (const entityName of row.entities) {
          const entityId = `e-${entityName}`;
          insertEntity.run({ id: entityId, name: entityName, type: 'concept', now: row.createdAt });
          insertLink.run({ memoryId: row.id, entityId });
          linkCount += 1;
        }
      }
    });
    batch = [];
  };

  for (const record of generateCorpus(options)) {
    batch.push(toCorpusRow(record));
    rows += 1;
    if (batch.length >= INSERT_BATCH_SIZE) {
      flush();
    }
  }
  flush();

  const end = process.hrtime.bigint();
  return { rows, elapsedMs: Number(end - start) / 1_000_000, linkCount };
}

/**
 * 一份**准备好的 bench 库**（语料 + 桶）。
 */
export interface PreparedBench {
  /** 库句柄。 */
  readonly db: Database.Database;
  /** 语料条数（**实测值** ⇒ 必须写进报告）。 */
  readonly rows: number;
  /** 有向量的条数（= flat 候选全集的规模）。 */
  readonly vectorRows: number;
  /** 细桶数。 */
  readonly fineCells: number;
  /** 桶归属条数。 */
  readonly members: number;
  /**
   * 灌库耗时（毫秒）。
   *
   * ⚠️ ★ **`null` ⇒ 这次运行没测到**（**不是 `0`**）：
   *   **复用**一份「别人已经灌好」的库时 ⇒ 灌库发生在**别的进程 / 别的机器状态**下
   *   ⇒ 本次运行**没有测到**它 ⇒ 记 `0` 会被读成「灌库耗时 0 毫秒」（假）
   *   ⇒ 与 `peakRss.sampledPeakBytes` 同一纪律（**没测到 ⇒ `null`，不许退化成 `0`**）。
   *   ⚠️ **自己灌的库**（`prepareBench` 的非复用路径）⇒ 这里一定是**实测值**。
   */
  readonly loadMs: number | null;
  /** 训练耗时（毫秒）。 */
  readonly trainMs: number;
  /**
   * 训练第一段（「**读向量 + 建中心**」）的耗时（毫秒）。
   *
   * ⚠️ ★ **`null` ⇒ 这次运行没测到 / 拆不开**（**不是 `0`**）：
   *   · **自己灌库 + 训练**的路径 ⇒ **不拆段** ⇒ 一定是 `null`；
   *   · **复用**时 ⇒ 取清单里记的值（清单没记 ⇒ `null`）。
   */
  readonly trainReadAndKmeansMs: number | null;
  /**
   * 训练第二段（「**迁移 100 万条归属**」）的耗时（毫秒）。
   *
   * ⚠️ **`null` ⇒ 没测到 / 拆不开**（同上纪律）。
   */
  readonly trainMigrateMs: number | null;
  /**
   * 训练期峰值 RSS 的**完整测量口径**（**两个数 + 采样次数 + 是否 worker**）。
   *
   * ⚠️ **两个数必须一起报**（P2 收官 · Q-06）：
   *   · `kernelPeakBytes` = **进程高水位**（含灌库阶段）⇒ 「训练期峰值内存」的**上界**；
   *   · `sampledPeakBytes` = **采样器独立观察**到的峰值 ⇒ **训练段自己的峰值**
   *     （`null` ⇒ **没测到** ⇒ 不许当成 0）。
   */
  readonly trainPeakRss: PeakRssMeasurement;
  /**
   * 训练**前**的 RSS（字节）—— 与峰值对比 ⇒ 训练自身的增量。
   *
   * ⚠️ ★ **`null` ⇒ 这次运行没测到**（**不是 `0`**）：
   *   「峰值 − 训练前」= **训练自身的增量** ⇒ 训练前没测到 ⇒ **增量也测不到**
   *   ⇒ 记 `0` ⇒ 增量会被算成「峰值 − 0 = 峰值」⇒ **把上界当成增量** ⇒ 偏大。
   *   ⇒ 与 `loadMs` / `sampledPeakBytes` 同一纪律（**没测到 ⇒ `null` ⇒ 不许退化成 `0`**）。
   */
  readonly rssBeforeTrainBytes: number | null;
  /** 语料参数（**写进报告 ⇒ 规模与种子可核对**）。 */
  readonly options: CorpusOptions;
}

/** 准备 bench 的参数。 */
export interface PrepareBenchOptions {
  /** 库文件路径。 */
  readonly dbPath: string;
  /** 语料参数（**默认 100 万条**）。 */
  readonly corpus?: CorpusOptions;
  /** 粗中心数。 */
  readonly coarseCenters: number;
  /** 细中心总数。 */
  readonly fineCenters: number;
  /** 粗层探针数（**训练与运行期必须一致**，§4.15.3）。 */
  readonly nprobeCoarse: number;
  /** 是否跳过训练（**只测 flat 路线时用**）。 */
  readonly skipTraining?: boolean;
  /**
   * ★ **是否复用已准备好的库**（**百万级必用**）。
   *
   * ⚠️ **为什么需要它**：百万级的「灌库 + 训练」要 **~1.5 小时**
   *   ⇒ 三个脚本各跑一次 = 4.5 小时 ⇒ **不可接受**；
   *   ⇒ 而且**三个脚本必须测同一份语料与同一套分桶**才有可比性
   *   ⇒ **一次准备、三次测量**才是对的。
   *
   * ⚠️ **复用的前提**：库里已有**同样规模**的语料与**已训练**的分桶
   *   ⇒ 不满足就**重新准备**（绝不拿一个错的库去测）。
   */
  readonly reuseExisting?: boolean;
  /**
   * ★ **「明知要重灌」的显式声明**（**默认 `false`**）。
   *
   * ⚠️ **为什么需要它**：`--reuse=true` 而**复用不了**时 ⇒ **默认直接报错**
   *   （不许悄悄删库重灌 ⇒ 那是 3~5 小时的活）
   *   ⇒ 真的要重灌时 ⇒ 由调用方**显式**声明 ⇒ 意图写在命令行上 ⇒ 可追溯。
   */
  readonly forceRebuild?: boolean;
}

/** 准备结果的**清单文件**（**复用时读它** ⇒ 相位耗时不会丢）。 */
const MANIFEST_SUFFIX = '.manifest.json';

/**
 * 清单的**版本号**（**每次改清单结构就 +1** ⇒ 读的时候能判「这是哪一版的清单」）。
 *
 * ⚠️ **为什么要有版本**：清单里新增了 `peakRss`（**峰值内存的完整口径**）
 *   ⇒ **旧清单里没有这个字段** ⇒ 若不判版本，就会把「没有这个字段」误当成
 *   「测到了 0」（**这正是 `sampledPeakRssBytes: 0` 的由来**）⇒
 *   ⇒ **版本号让「没测到」能被如实表达**（`null`）。
 */
export const MANIFEST_VERSION = 2;

/**
 * ★ **「有向量的活记忆」条数**的**唯一口径**（**读法与写法都只有这一份** ⇒ C36）。
 *
 * ⚠️ ★★ **为什么必须带 `NOT INDEXED`**（2026-11-01 实测踩坑）：
 *   **同样的 SQL、同样的结果**，但**查询计划**差了一个数量级：
 *   · **默认计划** = `SCAN memories USING INDEX idx_mem_created_at`
 *     ⇒ 该索引是 `WHERE deleted = 0` 的**部分索引**、**不含 `embedding`**
 *     ⇒ 对**每一行**都要**回表**读一次 3KB 的 `embedding` ⇒ **100 万次随机行读**
 *     ⇒ 在**机械硬盘**（本机 `D:` = SATA HDD）上实测 **~1.75MB/s ⇒ 30~45 分钟**；
 *   · **`NOT INDEXED`** = 强制**全表顺序扫**（4.5GB 连续读）
 *     ⇒ 实测 **28.6 秒**（**同一条 SQL、逐条相同的语义、同一个数**）⇒ **快约 60 倍**。
 *   ⇒ ⇒ **本函数是「复用路径」上最贵的一步**（百万级每次复用都要跑）
 *   ⇒ ⇒ 不修的话，「跑一次百万级 perf」光计数就要多花一个多小时。
 *   ⚠️ **`NOT INDEXED` 不改变语义**：它只禁止**索引**参与，**过滤条件一字未改**
 *   ⇒ **计数结果逐位相同**（实测 `n = 1000000` 两条路径一致）。
 *
 * @param db 库句柄
 * @returns 有向量的活记忆条数
 */
function countVectorMemories(db: Database.Database): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM memories NOT INDEXED WHERE embedding IS NOT NULL AND deleted = 0',
    )
    .get() as { n: number };
  return row.n;
}

/** 清单里**峰值内存**那一块的形状（**新清单**才有 ⇒ 旧清单走兜底）。 */
interface ManifestPeakRss {
  readonly kernelPeakBytes?: number;
  readonly sampledPeakBytes?: number | null;
  readonly sampleCount?: number;
  readonly workerActive?: boolean;
}

/**
 * 准备一份 bench 库（**建库 → 灌语料 → 训练 → 挂桶**）。
 *
 * ⚠️ **训练走生产实现**（`src/vector/rebuild.ts` 的 `rebuildBuckets`）⇒ 测的是生产路径。
 * ⚠️ **峰值内存口径**：`process.resourceUsage().maxRSS` 是**进程高水位**
 *   ⇒ 它包含「灌库」阶段的占用 ⇒ 报告里必须写清这一点（**不能**声称它是纯训练峰值）。
 *
 * @param options 准备参数
 * @returns 准备结果
 */
export function prepareBench(options: PrepareBenchOptions): PreparedBench {
  const corpusOptions = options.corpus ?? DEFAULT_CORPUS_OPTIONS;
  // ⚠️ ★ **复用已准备好的库**（百万级必需：一次准备 ≈ 1.5 小时）。
  if (options.reuseExisting === true) {
    const reused = tryReuse(options.dbPath, corpusOptions);
    if (reused !== undefined) {
      return reused;
    }
    // ⚠️ ★★★ **「要求复用但复用不了」⇒ 必须**当场报错**，不许悄悄删库重灌**
    //   （P2 收官 · Q-04 期间实测踩到）：
    //   · 触发形状：库在、但**清单丢了**（或规模/种子对不上）⇒ `tryReuse` 返回 `undefined`
    //     ⇒ 旧行为 = **删掉那个库** ⇒ 然后从零灌 100 万条（**3 小时**）
    //     ⇒ 而调用方（人）以为「我只是复用了已有的库」⇒ **3 小时的活白干**；
    //   · ⚠️ **实测**：另一个 bench 进程正开着那个库 ⇒ 删除被 Windows 文件锁挡下
    //     ⇒ 报的是「删除失败」这个**误导性的错**（真正的问题是「清单没了」）；
    //   · ⇒ **现在**：`--reuse=true` 却复用不了 ⇒ **立刻报错并说清原因**
    //     ⇒ 要重灌必须**显式** `--force-rebuild=true`（⇒ 人的意图写在命令行上）。
    if (options.forceRebuild !== true) {
      throw new Error(
        `bench：要求复用已准备好的库（--reuse=true），但**复用不了**：${options.dbPath}` +
          `（清单缺失 / 规模或种子对不上 ⇒ 见 ${options.dbPath}${MANIFEST_SUFFIX}）。` +
          '⇒ **不会**自动删库重灌（那是 3~5 小时的活）。' +
          '⇒ 若确实要重灌 ⇒ 显式加 --force-rebuild=true；' +
          '⇒ 若只是清单丢了 ⇒ 把那份清单找回来（复用期间不要删它）。',
      );
    }
  }
  // ⚠️ ★ **每次都从空库开始**（bench 脚本必须**可重复跑**）：
  //   `memories.content_hash` 上有唯一索引 ⇒ 同一份语料灌第二遍会撞唯一索引
  //   ⇒ 「脚本跑第二遍就炸」⇒ 不可重复 ⇒ 基线不可复采。
  //   ⇒ 所以这里**先删旧库**（含 WAL 边车）⇒ 每次跑都是干净的同一份语料。
  removeDatabaseFiles(options.dbPath);
  removeDatabaseFiles(`${options.dbPath}${MANIFEST_SUFFIX}`);
  const db = openBenchDatabase(options.dbPath);

  // ⚠️ **失败时必须关掉库句柄**：Windows 上「打开着的库文件」会锁住文件
  //   ⇒ 后续的临时目录清理会报 `EBUSY` ⇒ **真正的错误被掩盖成清理错误**。
  //   ⇒ 这里统一「失败即关库再抛」。
  try {
    const prepared = prepareWithDatabase(db, options, corpusOptions);
    writeManifest(options.dbPath, prepared);
    return prepared;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * 试着**复用**一份已准备好的库（**规模与分桶都对得上才复用**）。
 *
 * ⚠️ **复用必须严格**：语料条数、向量条数、桶归属条数、细桶数**全都要对**
 *   ⇒ 对不上就返回 `undefined`（调用方重新准备）
 *   ⇒ 绝不拿「一个错的库」去测（那是在测空气）。
 *
 * @param dbPath 库文件路径
 * @param corpus 语料参数
 * @returns 复用结果（**不可复用时 `undefined`**）
 */
function tryReuse(dbPath: string, corpus: CorpusOptions): PreparedBench | undefined {
  if (!existsSync(dbPath)) {
    return undefined;
  }
  const manifestPath = `${dbPath}${MANIFEST_SUFFIX}`;
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  let manifest: {
    manifestVersion?: number;
    corpusSize?: number;
    seed?: number;
    loadMs?: number;
    trainMs?: number;
    trainReadAndKmeansMs?: number;
    trainMigrateMs?: number;
    peakRssBytes?: number;
    sampledPeakRssBytes?: number;
    rssBeforeTrainBytes?: number;
    peakRss?: ManifestPeakRss;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return undefined;
  }
  // ⚠️ ★ **连种子也要对**：规模相同但种子不同 ⇒ **是不同的语料**
  //   ⇒ 若不比种子 ⇒ 复用的是**别的语料** ⇒ 结论无效。
  if (manifest.corpusSize !== corpus.size || manifest.seed !== corpus.seed) {
    return undefined;
  }
  // ⚠️ ★ **清单版本不能比本代码新**（前向兼容）：
  //   新版清单的字段含义可能已变 ⇒ 用旧代码读它 ⇒ **读出来的数是错的**
  //   ⇒ 宁可**重新准备**（贵但正确）⇒ 绝不拿一个「读不懂的清单」去测。
  if (manifest.manifestVersion !== undefined && manifest.manifestVersion > MANIFEST_VERSION) {
    return undefined;
  }
  const db = openBenchDatabase(dbPath);
  try {
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const vectorRows = countVectorMemories(db);
    const fineCells = (
      db.prepare('SELECT COUNT(*) AS n FROM vector_fine_cells').get() as { n: number }
    ).n;
    const members = (
      db.prepare('SELECT COUNT(*) AS n FROM vector_cell_members').get() as { n: number }
    ).n;
    if (rows !== corpus.size || vectorRows !== corpus.size || fineCells === 0 || members === 0) {
      db.close();
      return undefined;
    }
    return {
      db,
      rows,
      vectorRows,
      fineCells,
      members,
      loadMs: manifest.loadMs ?? null,
      trainMs: manifest.trainMs ?? 0,
      // ⚠️ ★ **训练的两段耗时也要从清单里带回来**（没记 ⇒ 如实写 `null`）。
      //   「百万级一次跑完会被环境掐掉」⇒ 实测拆两段跑 ⇒ `trainMs` 是个**和**
      //   ⇒ ⇒ **两段的数必须能单独读出来**（否则「这个和是怎么来的」说不清）。
      trainReadAndKmeansMs: manifest.trainReadAndKmeansMs ?? null,
      trainMigrateMs: manifest.trainMigrateMs ?? null,
      // ⚠️ ★ **峰值内存：旧清单没有 `peakRss` ⇒ 「没测到」必须如实写成 `null`**，
      //   **不许**退化成 `0`（`0` 会被读成「测到了 0 字节」⇒ 掩盖了「没测到」这件事）。
      //   ⇒ 上界（进程高水位）从旧字段 `peakRssBytes` 兜底 ⇒ **上界不丢**。
      trainPeakRss: readManifestPeakRss(manifest),
      // ⚠️ ★ **训练前的 RSS 也要从清单里带回来**（复用时它有值）：
      //   「峰值 − 训练前」= **训练自身的增量** ⇒ 这是**唯一**能算出那个增量的两个数。
      //   ⇒ 复用时若写死 `0` ⇒ 增量会被算成「峰值 − 0 = 峰值」⇒ **把上界当成增量**
      //   ⇒ **报告里的数会偏大** ⇒ 宁可如实带回来。
      //   ⚠️ **清单里没有这个字段（旧清单）⇒ 如实写 `null`（= 没测到）**，**不许**退化成 `0`。
      rssBeforeTrainBytes: manifest.rssBeforeTrainBytes ?? null,
      options: corpus,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * 从清单里读**峰值内存的测量口径**（**旧清单 ⇒ 「没测到」**）。
 *
 * ⚠️ **两条兜底**：
 *   · **上界**（`kernelPeakBytes`）：新清单取 `peakRss.kernelPeakBytes`；
 *     旧清单退回旧的 `peakRssBytes`（**那时候它就是进程高水位**）⇒ **上界不丢**。
 *   · **采样峰值**（`sampledPeakBytes`）：新清单取 `peakRss.sampledPeakBytes`；
 *     旧清单**没有这个字段** ⇒ **`null`（= 没测到）** ⇒ **绝不写 `0`**。
 *
 * @param manifest 清单内容
 * @returns 峰值内存的测量口径
 */
function readManifestPeakRss(manifest: {
  peakRssBytes?: number;
  sampledPeakRssBytes?: number;
  peakRss?: ManifestPeakRss;
}): PeakRssMeasurement {
  const peakRss = manifest.peakRss;
  if (peakRss !== undefined) {
    const sampled = peakRss.sampledPeakBytes;
    return {
      kernelPeakBytes: peakRss.kernelPeakBytes ?? manifest.peakRssBytes ?? 0,
      sampledPeakBytes: sampled === undefined || sampled === null ? null : sampled,
      sampleCount: peakRss.sampleCount ?? 0,
      workerActive: peakRss.workerActive ?? false,
    };
  }
  // ⚠️ **旧清单**：只有进程高水位 ⇒ 采样峰值**没测到**（`null`）。
  return {
    kernelPeakBytes: manifest.peakRssBytes ?? 0,
    sampledPeakBytes: null,
    sampleCount: 0,
    workerActive: false,
  };
}

/**
 * 把准备结果写成**清单文件**（**复用时读它** ⇒ 相位耗时不会丢）。
 *
 * @param dbPath 库文件路径
 * @param prepared 准备结果
 */
function writeManifest(dbPath: string, prepared: PreparedBench): void {
  writeFileSync(
    `${dbPath}${MANIFEST_SUFFIX}`,
    `${JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        corpusSize: prepared.options.size,
        seed: prepared.options.seed,
        rows: prepared.rows,
        vectorRows: prepared.vectorRows,
        fineCells: prepared.fineCells,
        members: prepared.members,
        loadMs: prepared.loadMs,
        trainMs: prepared.trainMs,
        trainReadAndKmeansMs: prepared.trainReadAndKmeansMs,
        trainMigrateMs: prepared.trainMigrateMs,
        // ⚠️ **峰值内存整块存**（两个数 + 采样次数 + 是否 worker）⇒
        //   复用时**不必**再猜「这个 0 是没测到还是测到了 0」。
        peakRss: prepared.trainPeakRss,
        rssBeforeTrainBytes: prepared.rssBeforeTrainBytes,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * 删掉一个库文件（**含 WAL 边车**）。
 *
 * ⚠️ **为什么连边车一起删**：SQLite 的 `-wal` / `-shm` 是库的一部分
 *   ⇒ 只删主文件会留下不一致的边车 ⇒ 下次打开会报「malformed」。
 *
 * @param dbPath 库文件路径
 */
function removeDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
}

/**
 * 在**已打开的库**上完成准备流程（建库后的全部步骤）。
 *
 * @param db 库句柄
 * @param options 准备参数
 * @param corpusOptions 语料参数
 * @returns 准备结果
 */
function prepareWithDatabase(
  db: Database.Database,
  options: PrepareBenchOptions,
  corpusOptions: CorpusOptions,
): PreparedBench {
  const load = loadCorpus(db, corpusOptions);
  const vectorRows = countVectorMemories(db);

  if (options.skipTraining === true) {
    return {
      db,
      rows: load.rows,
      vectorRows,
      fineCells: 0,
      members: 0,
      loadMs: load.elapsedMs,
      trainMs: 0,
      trainReadAndKmeansMs: null,
      trainMigrateMs: null,
      trainPeakRss: {
        kernelPeakBytes: 0,
        sampledPeakBytes: null,
        sampleCount: 0,
        workerActive: false,
      },
      rssBeforeTrainBytes: null,
      options: corpusOptions,
    };
  }

  // ⚠️ **训练期的峰值内存**（§12 的 R-04：≥3.5GB 是资源规划的下限）：
  //   生产的重训序列一次性把全部向量读进内存 ⇒ 峰值 RSS 就是「训练期峰值内存」。
  const rssBeforeTrain = process.memoryUsage().rss;
  // ⚠️ **两个峰值一起报**（互为兜底，但**各司其职**）：
  //   · `sampledPeakBytes`：**采样器独立观察**到的峰值（**训练段自己的峰值**）
  //     ⇒ 采样器跑在 **worker 线程**上 ⇒ **同步长任务期间也采得到**
  //       （主线程的定时器在同步长任务期间**一次都不会触发** ⇒ 这就是历史上
  //        「采样峰值采不到数」的**根因**）；
  //   · `kernelPeakBytes`：**内核维护的进程高水位**（含灌库阶段）⇒ **上界**，
  //     永不丢失。
  //   ⇒ 报告里写「进程高水位（含灌库）」+「采样峰值（仅训练段）」两个数。
  const sampler = new PeakRssSampler();
  sampler.start();
  const trainStart = process.hrtime.bigint();
  let trained: ReturnType<typeof trainBenchBuckets>;
  try {
    trained = trainBenchBuckets(db, {
      coarseCenters: options.coarseCenters,
      fineCenters: options.fineCenters,
      nprobeCoarse: options.nprobeCoarse,
      now: BENCH_NOW,
    });
  } finally {
    // ⚠️ **失败也要停采样**（worker 线程不该泄漏）⇒ 训练抛错时也要收尾。
    sampler.stop();
  }
  const trainEnd = process.hrtime.bigint();
  const sampleCount = sampler.sampleCount();
  const trainPeakRss: PeakRssMeasurement = {
    kernelPeakBytes: sampler.kernelPeakBytes(),
    // ⚠️ **一次都没采到 ⇒ `null`（= 没测到）**，**不是 `0`**。
    sampledPeakBytes: sampleCount > 0 ? sampler.sampledPeakBytes() : null,
    sampleCount,
    workerActive: sampler.isWorkerActive(),
  };

  return {
    db,
    rows: load.rows,
    vectorRows,
    fineCells: trained.cells,
    members: trained.members,
    loadMs: load.elapsedMs,
    trainMs: Number(trainEnd - trainStart) / 1_000_000,
    // ⚠️ **自己跑的整段训练不拆段**（拆段是「分段跑」那次的口径）⇒ 如实写 。
    trainReadAndKmeansMs: null,
    trainMigrateMs: null,
    trainPeakRss,
    rssBeforeTrainBytes: rssBeforeTrain,
    options: corpusOptions,
  };
}
