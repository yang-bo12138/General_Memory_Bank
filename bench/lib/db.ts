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
  /** 灌库耗时（毫秒）。 */
  readonly loadMs: number;
  /** 训练耗时（毫秒）。 */
  readonly trainMs: number;
  /** 训练期峰值 RSS（字节）—— **进程高水位**（含灌库阶段的占用）。 */
  readonly trainPeakRssBytes: number;
  /** 训练段**采样**到的峰值 RSS（字节）—— 只覆盖训练那一段。 */
  readonly trainSampledPeakRssBytes: number;
  /** 训练**前**的 RSS（字节）—— 与峰值对比 ⇒ 训练自身的增量。 */
  readonly rssBeforeTrainBytes: number;
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
}

/** 准备结果的**清单文件**（**复用时读它** ⇒ 相位耗时不会丢）。 */
const MANIFEST_SUFFIX = '.manifest.json';

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
    corpusSize?: number;
    loadMs?: number;
    trainMs?: number;
    peakRssBytes?: number;
    sampledPeakRssBytes?: number;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return undefined;
  }
  if (manifest.corpusSize !== corpus.size) {
    return undefined;
  }
  const db = openBenchDatabase(dbPath);
  try {
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const vectorRows = (
      db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL AND deleted = 0')
        .get() as { n: number }
    ).n;
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
      loadMs: manifest.loadMs ?? 0,
      trainMs: manifest.trainMs ?? 0,
      trainPeakRssBytes: manifest.peakRssBytes ?? 0,
      trainSampledPeakRssBytes: manifest.sampledPeakRssBytes ?? 0,
      rssBeforeTrainBytes: 0,
      options: corpus,
    };
  } catch (error) {
    db.close();
    throw error;
  }
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
        corpusSize: prepared.options.size,
        seed: prepared.options.seed,
        rows: prepared.rows,
        vectorRows: prepared.vectorRows,
        fineCells: prepared.fineCells,
        members: prepared.members,
        loadMs: prepared.loadMs,
        trainMs: prepared.trainMs,
        peakRssBytes: prepared.trainPeakRssBytes,
        sampledPeakRssBytes: prepared.trainSampledPeakRssBytes,
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
  const vectorRows = (
    db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL AND deleted = 0')
      .get() as { n: number }
  ).n;

  if (options.skipTraining === true) {
    return {
      db,
      rows: load.rows,
      vectorRows,
      fineCells: 0,
      members: 0,
      loadMs: load.elapsedMs,
      trainMs: 0,
      trainPeakRssBytes: 0,
      trainSampledPeakRssBytes: 0,
      rssBeforeTrainBytes: 0,
      options: corpusOptions,
    };
  }

  // ⚠️ **训练期的峰值内存**（§12 的 R-04：≥3.5GB 是资源规划的下限）：
  //   生产的重训序列一次性把全部向量读进内存 ⇒ 峰值 RSS 就是「训练期峰值内存」。
  const rssBeforeTrain = process.memoryUsage().rss;
  // ⚠️ **两个峰值一起报**（互为兜底）：
  //   · `PeakRssSampler`：**采样**到的峰值（训练是同步长任务 ⇒ 采样器可能一次都跑不到
  //     ⇒ 这个值可能偏低 ⇒ 不能单独用）；
  //   · `process.resourceUsage().maxRSS`：**内核维护的高水位**（永不丢失，但含灌库阶段）。
  //   ⇒ 报告里写「进程高水位（含灌库）」+「采样峰值（仅训练段）」两个数。
  const sampler = new PeakRssSampler();
  sampler.start();
  const trainStart = process.hrtime.bigint();
  const trained = trainBenchBuckets(db, {
    coarseCenters: options.coarseCenters,
    fineCenters: options.fineCenters,
    nprobeCoarse: options.nprobeCoarse,
    now: BENCH_NOW,
  });
  const trainEnd = process.hrtime.bigint();
  sampler.stop();
  const trainSampledPeakRssBytes = sampler.peakBytes();

  return {
    db,
    rows: load.rows,
    vectorRows,
    fineCells: trained.cells,
    members: trained.members,
    loadMs: load.elapsedMs,
    trainMs: Number(trainEnd - trainStart) / 1_000_000,
    // ⚠️ **内核高水位**（不会因为采样器没跑到而丢失）。
    trainPeakRssBytes: Math.max(process.resourceUsage().maxRSS * 1024, trainSampledPeakRssBytes),
    trainSampledPeakRssBytes,
    rssBeforeTrainBytes: rssBeforeTrain,
    options: corpusOptions,
  };
}
