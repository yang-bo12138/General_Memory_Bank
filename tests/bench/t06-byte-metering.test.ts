/**
 * **T06 第一段**（C′ 档「字节读数口径」的两件先行工作）的门禁。
 *
 * ⚠️ ★ **本文件守的是「采数装置本身」** —— 不是「字节达标」：
 *   · **A**：行读计数器的**窗口覆盖写入路径**
 *     （**此前写路径的读数完全采不到** ⇒ 计数器在 `:900` 就拆了 ⇒ 写路径那段是「空气」）；
 *   · **B**：`classifyReadKind()` 能**认领 `vector_codes`**
 *     （**此前码池读数恒为 0** ⇒ 没人认领这张表 ⇒ 两段式的「省字节」在报表上看不出来）。
 *
 * ⚠️ ★★ **为什么这两件事必须先做**（它们是第二段的**前置**）：
 *   T06 第二段要落盘 `bytesRead` / `codeRowsRead` / `memoryRowsRead` / `candidateUniverse`
 *   ⇒ ⇒ **字节账的每一项都来自「窗口内采到的行数」**
 *   ⇒ ⇒ **窗口没罩住写路径 ⇒ 字节账恒 0；码池没被认领 ⇒ 码那一项恒 0**
 *   ⇒ ⇒ **两者都是「报表看起来很正常、账却从根上算错」的形状**（规格 §5.1.2 的原话）。
 *
 * ⚠️ ★ **「什么变异会让它变红」**（本仓库的纪律：先想变异，再写断言）：
 *   · 把 `classifyReadKind()` 里的 `vector_codes` 规则删掉 ⇒ 第 ① 组会红；
 *   · 把**规则顺序**倒过来（`vector_codes` 排在 `memories` 前面）⇒ 第 ③ 条会红
 *     （规格 §5.1.2 的告警就失效了 ⇒ Q2 写成 JOIN 会被静默吞掉）；
 *   · 把写路径的计数窗口删掉 / 挪回 `:900` 之前 ⇒ 第 ④ 组会红（码行 = 0）；
 *   · 把窗口开得太大（罩住整个写区间）⇒ 第 ⑤ 条会红（`bucketMemberRows` 超过候选宇宙）；
 *   · 把 `disableRowReadCounter` 的语义改掉（变成「照数」）⇒ 第 ⑥ 条会红。
 *
 * ⚠️ **规模故意很小（1500 条）** ⇒ 门禁要在**几十秒内**跑完。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import { DEFAULT_CORPUS_OPTIONS } from '../../bench/corpus.js';
import { embedText } from '../../bench/embedder.js';
import {
  type ByteSourceKind,
  REGISTERED_SHAPES,
  bytesOfRow,
  isAggregateSql,
  normalizeSql,
  parseSelectList,
  parseTables,
  resolveShape,
  shapeKeyOf,
  sqlFingerprint,
} from '../../bench/lib/byteSources.js';
import { prepareBench } from '../../bench/lib/db.js';
import { classifyReadKind, installRowReadCounter } from '../../bench/lib/harness.js';
import {
  THRESHOLDS,
  type WritePathReadSample,
  measurePerf,
  readSamplesAlignedOf,
} from '../../bench/perf.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import {
  type DedupCandidateContext,
  collectVectorCandidates,
} from '../../src/store/dedupCandidates.js';
import { blobToVector, loadCentroidModel } from '../../src/vector/centroids.js';
import { normalizeNumbers } from '../../src/vector/dot.js';

/** 冒烟用的语料规模（**故意很小** ⇒ 门禁秒级完成）。 */
const SMOKE_SIZE = 1500;

/** 冒烟用的中心数（**比生产小** ⇒ 训练秒级完成）。 */
const SMOKE_COARSE = 8;
const SMOKE_FINE = 40;

/**
 * 建一份**小规模**的 bench 库（**复用生产的建库 / 灌库 / 训练路径**）。
 *
 * @param dir 工作目录（**不清理** ⇒ 与 `bench-smoke.test.ts` 同一套法）
 * @returns 库路径与句柄
 */
function buildSmokeBench(dir: string): { dbPath: string; db: ReturnType<typeof prepareBench> } {
  const dbPath = join(dir, 't06-byte-metering.db');
  const prepared = prepareBench({
    dbPath,
    corpus: { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE },
    coarseCenters: SMOKE_COARSE,
    fineCenters: SMOKE_FINE,
    nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
  });
  return { dbPath, db: prepared };
}

/** 新建一个**临时工作目录**（不清理）。 */
function newWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-ocean-t06-byte-metering-'));
}

/**
 * 造一个**写路径去重扫描**的上下文（与 `bench/perf.ts` 里的那个同形）。
 *
 * @param db 库句柄
 * @returns 去重上下文
 */
function buildWriteContext(db: Database.Database): DedupCandidateContext {
  const model = loadCentroidModel(db);
  return {
    db,
    params: DEFAULT_PARAMS,
    buckets: {
      db,
      centroids: () => model,
      nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
    },
  };
}

/**
 * 造一个**归一化**的查询向量（与写路径用的口径同形：`normalizeNumbers`）。
 *
 * @param content 正文
 * @returns 归一化向量
 */
function buildVector(content: string): Float32Array {
  return normalizeNumbers(Array.from(embedText(content)));
}

/**
 * 造一个**「重复写入」探针**（= 库里已有的一条记忆的向量）。
 *
 * ⚠️ ★ **为什么需要它**（这是本文件最容易被写错的一处）：
 *   两段式剪枝的**上界**会把「余弦远低于 `DEDUP_COS_MIN`（0.92）」的行**全部剪掉**
 *   ⇒ ⇒ **一条随机文本的探针 ⇒ `memories` 侧读到 0 行**（Q1 / Q2 照读）
 *   ⇒ ⇒ 那不是 bug，**那是两段式在正常工作**（「什么都没像 ⇒ 什么都不用读」）
 *   ⇒ ⇒ 但要验「`memories` 侧的行读被采到」，就必须造一个**必然入选**的探针
 *   ⇒ ⇒ **拿库里已有的一条记忆的向量当探针** ⇒ 余弦 = 1 ⇒ 必然入选 ⇒ 稳定可复现。
 *
 * @param db 库句柄
 * @returns 归一化向量（= 某条已有记忆的向量）
 */
function buildDuplicateProbeVector(db: Database.Database): Float32Array {
  const row = db
    .prepare('SELECT embedding FROM memories WHERE deleted = 0 AND embedding IS NOT NULL LIMIT 1')
    .get() as { embedding: Buffer };
  return normalizeNumbers(Array.from(blobToVector(row.embedding)));
}

/**
 * ★ **一次写路径扫描的「逐形状」窗口**（计数器实测 + 生产扫描自己报的数）。
 *
 * ⚠️ ★ **为什么要单独造一个窗口对象**（口径 §2 断言 2 的第二半）：
 *   落盘结构里**只有各来源的合计**（`codeRowsRead` / `embeddingRowsRead` …）
 *   ⇒ ⇒ **「逐形状」的证据只在计数器的快照里**（`shapeRows`）
 *   ⇒ ⇒ 这里把「计数器的实测」与「生产扫描自己报的数」**装进同一个对象**
 *   ⇒ ⇒ 负控台就能**单独喂数据**给下面的纯函数（⇒ 证明它不是恒绿守卫）。
 */
interface ShapeWindow {
  /** 逐形状的行数（**计数器实测**；累计值之差）。 */
  readonly shapeRows: Readonly<Record<string, number>>;
  /** 码行读数（`code` 来源）。 */
  readonly codeRowsRead: number;
  /** 向量行读数（`exactEmbedding` + `survivorRow`）。 */
  readonly embeddingRowsRead: number;
  /** `scoreOf` **返回了行**的次数（`exactEmbedding` 来源）。 */
  readonly embeddingExactRows: number;
  /** 窄读行数（`narrow` 来源）。 */
  readonly narrowRowsRead: number;
  /** 成员行数（`member` 来源）。 */
  readonly bucketMemberRowsRead: number;
  /**
   * ★ **独立对照**：**生产扫描自己报的候选宇宙**（`collectVectorCandidates()` 的 `scanned`）。
   *
   * ⚠️ ★ **为什么它是「独立」的**：它**不经过 bench 的行读计数器**
   *   ⇒ ⇒ 它与 `shapeRows` 是**两个互不相干的数** ⇒ ⇒
   *   ⇒ **「只钉总和」的抵消手法在这里【失效】**（⇒ 负控台能实证这一点）。
   */
  readonly scanned: number;
}

/**
 * ★ **量一次写路径扫描的逐形状窗口**（装计数器 → 跑一次生产扫描 → 前后快照相减）。
 *
 * ⚠️ ★ **为什么用「重复写入」探针**：余弦 = 1 ⇒ 必然入选 ⇒ **Q4 一定发**
 *   ⇒ ⇒ 整条形状链（Q1 / Q2 / `scoreOf` / Q4）都在窗口里 ⇒ 逐形状断言才有东西可断言。
 *
 * @param db 库句柄
 * @returns 窗口读数
 */
function measureWritePathShapeWindow(db: Database.Database): ShapeWindow {
  const context = buildWriteContext(db);
  const vector = buildDuplicateProbeVector(db);
  const counter = installRowReadCounter(db);
  const before = counter.snapshot();
  counter.start();
  const scan = collectVectorCandidates(context, vector);
  counter.stop();
  const after = counter.snapshot();
  const shapeRows: Record<string, number> = {};
  for (const [id, rows] of Object.entries(after.shapeRows)) {
    shapeRows[id] = rows - (before.shapeRows[id] ?? 0);
  }
  const window: ShapeWindow = {
    shapeRows,
    codeRowsRead: after.codeRowsRead - before.codeRowsRead,
    embeddingRowsRead: after.embeddingRowsRead - before.embeddingRowsRead,
    embeddingExactRows: after.embeddingExactRows - before.embeddingExactRows,
    narrowRowsRead: after.narrowRowsRead - before.narrowRowsRead,
    bucketMemberRowsRead: after.bucketMemberRowsRead - before.bucketMemberRowsRead,
    scanned: scan.scanned,
  };
  counter.uninstall();
  return window;
}

/**
 * ★ **某个来源认领的形状行数之和**（按 `REGISTERED_SHAPES` 的 `sources` 累加）。
 *
 * ⚠️ ★ **为什么按登记表算**（而不是手写一份清单）：
 *   登记表是**唯一的「形状 → 来源」映射** ⇒ ⇒ 新增形状时**自动**纳入
 *   ⇒ ⇒ 不会与登记表漂移（手写清单迟早会漏一个形状 ⇒ 那就是恒绿）。
 *
 * @param window 窗口读数
 * @param source 来源种类
 * @returns 该来源认领的形状行数之和
 */
function rowsOfSource(window: ShapeWindow, source: ByteSourceKind): number {
  return REGISTERED_SHAPES.filter((shape) => shape.sources.includes(source)).reduce(
    (total, shape) => total + (window.shapeRows[shape.id] ?? 0),
    0,
  );
}

/**
 * ★ **一个形状的行数应该等于什么**（**它自己的那一份**；**不是**与别的形状相加后的总和）。
 *
 * ⚠️ ★ **两层锚点**：
 *   ① **独立对照**（`Q1` / `Q2` ⇒ `scanned`）⇒ ★ **生产扫描自己报的候选宇宙**
 *   ⇒ ⇒ 它与 bench 计数器**互不相干** ⇒ ⇒ **「互相抵消」不可能**；
 *   ② **来源读数**（`scoreOf` / `Q4` / `Q5` / `Q3`）⇒ **它独占的那一份**
 *   （`exactEmbedding` 独占 `embeddingExactRows`；`survivorRow` 独占
 *   `embeddingRowsRead − embeddingExactRows`；`narrow` 独占 `narrowRowsRead`）。
 *
 * @param shapeId 形状 id
 * @param window 窗口读数
 * @returns 期望行数（`null` ⇒ 该形状在写路径上不应出现 ⇒ 由「形状集合」那条断言钉）
 */
function shapeTargetOf(shapeId: string, window: ShapeWindow): number | null {
  switch (shapeId) {
    case 'Q1':
      return window.scanned;
    case 'Q2':
      return window.scanned;
    case 'Q3':
      return window.narrowRowsRead;
    case 'scoreOf':
      return window.embeddingExactRows;
    case 'Q4':
    case 'Q5':
      return window.embeddingRowsRead - window.embeddingExactRows;
    default:
      return null;
  }
}

/**
 * ★ **某个形状的行数**（**逐形状**取；没发的形状 = 0）。
 *
 * ⚠️ ★ **为什么绕一道函数**（而不是直接写 `shapeRows['Q2']`）：
 *   `shapeRows` 的类型是 `Record<string, number>` ⇒ 直接取下标**类型是 `number | undefined`**
 *   （`noUncheckedIndexedAccess`）⇒ 且 biome 的 `useLiteralKeys` 规则**不许**写字面量下标
 *   ⇒ ⇒ 统一走这个函数：**一处收口**（缺形状 = 0 是**明确语义**，不是「忘了登记」）。
 *
 * @param window 窗口读数
 * @param shapeId 形状 id
 * @returns 该形状的行数
 */
function rowsOfShape(window: ShapeWindow, shapeId: string): number {
  return window.shapeRows[shapeId] ?? 0;
}

/**
 * ★ **某个形状的判定**（**逐形状**取）。
 *
 * @param verdicts 逐形状的判定
 * @param shapeId 形状 id
 * @returns 该形状是否一致
 */
function verdictOf(verdicts: Readonly<Record<string, boolean>>, shapeId: string): boolean {
  return verdicts[shapeId] === true;
}

/**
 * ★ **逐形状的对账判定**（**纯函数** ⇒ 负控台能单独喂数据 ⇒ **证明它不是恒绿守卫**）。
 *
 * ⚠️ ★★ **为什么必须「逐形状」而不是「只比总和」**（口径 §2 断言 2 的第二半）：
 *   若只比「各来源的行数之和 == 对应读数」⇒ ⇒ **一个形状多算、另一个少算会互相抵消**
 *   ⇒ ⇒ 那条断言**恒绿** ⇒ ⇒ **永远打不红** ⇒ ⇒ 违反「守卫必须能被打红」的纪律
 *   （本仓库已因此栽过一次：读路径的 `samplesAligned` 曾是恒真的长度比较）。
 *   ⇒ ⇒ 本函数**逐个形状**判 ⇒ ⇒ **一个形状多算 ⇒ 立刻 false**。
 *
 * @param window 窗口读数
 * @returns 逐形状的判定（形状 id ⇒ 是否一致）
 */
function shapeRowsAgree(window: ShapeWindow): Readonly<Record<string, boolean>> {
  const verdicts: Record<string, boolean> = {};
  for (const shape of REGISTERED_SHAPES) {
    const rows = window.shapeRows[shape.id] ?? 0;
    if (rows === 0) {
      // ⚠️ **没发的形状**（零行）⇒ 与「这条 SQL 没跑」一致 ⇒ 判它**真**
      //   （⚠️ 「哪些形状该发」由**形状集合那条断言**钉死 ⇒ 这里不重复管）。
      verdicts[shape.id] = true;
      continue;
    }
    const target = shapeTargetOf(shape.id, window);
    // ⚠️ ★ **目标为 `null` 却发了行 ⇒ 判红**（这个形状在写路径上不该出现）。
    verdicts[shape.id] = target !== null && target === rows;
  }
  return verdicts;
}

/**
 * ★ **已废的读路径口径短语**（**本仓库有前科的那一条**）。
 *
 * ⚠️ ★★ **为什么单拎出这一个短语**（不做泛化扫描）：
 *   「读路径的 `samplesAligned` 是什么」这件事在 `bench/perf.ts` 里**说了不止一遍**
 *   ⇒ ⇒ 其中一遍**曾是错的**（这条）⇒ ⇒ 「**注释说谎**」这个坑**已经栽过两次**
 *   ⇒ ⇒ 只钉**有前科**的那一条 ⇒ ⇒ 既能覆盖真风险、又不至于泛化到查不准。
 */
const STALE_READ_PATH_PHRASE = '字节样本数 == 计时样本数';

/**
 * ★ **否定标记**（= 「这条短语是被否定的」的证据）。
 *
 * ⚠️ ★ **为什么是「标记词」而不是「精确匹配」**：
 *   否定词可能写在**相邻行**（例：`为什么不能是「…」` 与 `（**那条是恒真的**）` 分两行）
 *   ⇒ ⇒ 扫描时取 **±3 行的窗口**再找标记词。
 */
const STALE_READ_PATH_DENIALS: readonly string[] = [
  '不是',
  '恒真',
  '已废',
  '换掉',
  '原先',
  '为什么不能',
];

/**
 * ★★★ **「注释说谎」扫描器**（**纯函数** ⇒ 负控台能单独喂数据 ⇒ **它自己也不是恒绿守卫**）。
 *
 * ⚠️ ★★★ **为什么需要它**（QA 在 T06 验证时登记的「同一个坑又踩了一次」）：
 *   `bench/perf.ts` 里「读路径 `samplesAligned` 是什么」这件事**说了多遍**
 *   ⇒ ⇒ 人读注释可能读到**陈旧的那一遍** ⇒ ⇒ **拿到的口径是错的**
 *   ⇒ ⇒ ★ **比代码本身更危险**（代码有类型、有测试；注释什么都没有）
 *   ⇒ ⇒ 把「**凡提到那条已废口径的地方，必须同时否定它**」钉成**机器规则**。
 *
 * ⚠️ ★ **判据**：凡是出现该短语的行，其 **±3 行窗口**里必须出现至少一个**否定标记**
 *   ⇒ ⇒ 「提到它是为了否定它」= 合规；「提到它却当成现行口径」= **说谎 ⇒ 打红**。
 *
 * @param source 被扫描的源码文本
 * @returns **说谎**的行号列表（**空数组** ⇒ 没有说谎的注释）
 */
function lyingStaleReadPathPhraseLines(source: string): readonly number[] {
  const lines = source.split(/\r?\n/);
  const lying: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.includes(STALE_READ_PATH_PHRASE)) {
      continue;
    }
    // ⚠️ ★ **看上下文窗口（±3 行）**：否定词可能写在相邻行 ⇒ 不许只看本行。
    const window = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
    const denied = STALE_READ_PATH_DENIALS.some((marker) => window.includes(marker));
    if (!denied) {
      lying.push(index + 1);
    }
  }
  return lying;
}

/**
 * 录下**这段时间里实际 `prepare` 过的 SQL 文本**。
 *
 * ⚠️ ★ **为什么录「真实跑过的那条」而不是抄一份 SQL 文本进断言**：
 *   抄一份 ⇒ 生产改了 SQL 而测试还在测旧文本 ⇒ **断言恒绿**（本仓库的老坑）
 *   ⇒ ⇒ 这里直接**从生产句柄上录**⇒ **生产 SQL 一改，断言立刻跟着变**。
 *
 * @param db 库句柄（**会被就地改造** ⇒ 函数返回前一定还原）
 * @param body 要录的动作
 * @returns 录到的 SQL 文本（按 `prepare` 的先后顺序）
 */
function recordPreparedSql(db: Database.Database, body: () => void): string[] {
  const captured: string[] = [];
  const handle = db as unknown as { prepare: (source: string) => unknown };
  const original = handle.prepare;
  handle.prepare = (source: string): unknown => {
    captured.push(source);
    return original.call(db, source);
  };
  try {
    body();
  } finally {
    handle.prepare = original;
  }
  return captured;
}

/**
 * ★ **B 组的门禁：码池（Q2）必须被 `classifyReadKind()` 认领**。
 *
 * ⚠️ ★ **为什么这组最重要**（它是整个 T06 的地基）：
 *   两段式剪枝的**全部卖点**是「读 ~784B/行（int8 码）而不是 3KB/行」
 *   ⇒ ⇒ **码行读数是字节账的第一项**
 *   ⇒ ⇒ 它恒为 0 ⇒ 报表上「省了字节」这件事**根本看不见**
 *   ⇒ ⇒ 而报表**看起来很正常**（⇒ 「别让读 JSON 的人误以为它是实测」的反面）。
 */
describe('T06 · B：`classifyReadKind()` 必须认领码池（`vector_codes`）', () => {
  it('★ 生产 Q2 那条 SQL 被认成**码类**（**不是** candidate）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    const vector = buildVector('码池认领门禁：一条生产写路径扫描');
    // ⚠️ ★ **录生产真正跑过的那条 SQL**（不抄一份 ⇒ 改了 SQL 断言会跟着变）。
    const captured = recordPreparedSql(db.db, () => {
      collectVectorCandidates(context, vector);
    });
    const codeSql = captured.find((sql) => sql.includes('vector_codes'));
    expect(codeSql).toBeDefined();
    if (codeSql === undefined) {
      // ⚠️ **不许恒绿**：Q2 消失 ⇒ 下面的断言会变成「没找到就跳过」⇒ 必须当场炸。
      throw new Error('写路径没有发出任何含 vector_codes 的 SQL（⇒ Q2 不存在 ⇒ 断言失去意义）');
    }
    // ⚠️ ★ **核心断言**：码池读 ⇒ 归**码类**（**不是**候选行）。
    expect(classifyReadKind(codeSql)).toBe('vectorCode');
    expect(classifyReadKind(codeSql)).not.toBe('candidate');
    db.db.close();
  });

  it('★ 生产 Q2 那条 SQL **不许 JOIN `memories`**（规格 §5.1.2 的硬约束，破了必红）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    const vector = buildVector('Q2 不许 JOIN memories：一条生产写路径扫描');
    const captured = recordPreparedSql(db.db, () => {
      collectVectorCandidates(context, vector);
    });
    const codeSql = captured.find((sql) => sql.includes('vector_codes'));
    if (codeSql === undefined) {
      throw new Error('写路径没有发出任何含 vector_codes 的 SQL（⇒ Q2 不存在 ⇒ 断言失去意义）');
    }
    // ⚠️ ★ **这条是「H1′ 的账从根上算错，而报表看起来很正常」的守卫**：
    //   一旦 Q2 带上 `JOIN memories` ⇒ 分类器（按规格的顺序）会把它认成候选行
    //   ⇒ **码行恒 0、记忆行满额** ⇒ 字节账偏得离谱却没人看得出来
    //   ⇒ ⇒ **在这里当场炸掉**（比在报表里发现便宜一万倍）。
    expect(codeSql).not.toMatch(/\b(?:FROM|JOIN)\s+memories\b/i);
    db.db.close();
  });

  it('★ 匹配顺序：`memories` **优先于** `vector_codes`（规格 §5.1.2 的告警靠它生效）', () => {
    // ⚠️ ★ **顺序不许倒**：一条 SQL **碰了 `memories`** ⇒ 它**真的要付 `memories` 的字节**
    //   ⇒ 归成候选行才是如实的（哪怕它同时还读了码池）
    //   ⇒ ⇒ 顺序倒过来 ⇒ 规格 §5.1.2 那条告警（「Q2 一旦 JOIN memories ⇒ 码行恒 0」）就失效了。
    const joined = classifyReadKind(
      'SELECT vc.memory_id FROM vector_codes vc JOIN memories m ON m.id = vc.memory_id',
    );
    expect(joined).toBe('candidate');
    // ⚠️ **纯码池那条**仍然归码类（⇒ 上面的顺序没有把码池整个吃掉）。
    expect(classifyReadKind('SELECT vc.code FROM vector_codes vc WHERE vc.fine_id IN (?)')).toBe(
      'vectorCode',
    );
    // ⚠️ **桶成员那条**仍然归桶成员（⇒ 三类互不串味）。
    expect(
      classifyReadKind('SELECT fine_id, memory_id FROM vector_cell_members WHERE fine_id = ?'),
    ).toBe('bucketMember');
  });

  it('★ 聚合查询**不计**（含 `NOT EXISTS (… FROM vector_codes …)` 的诊断 SQL 也不计）', () => {
    // ⚠️ ★ **聚合必须最先判**：`countUncodedCandidates()` 的 SQL 内部嵌了
    //   `NOT EXISTS (SELECT 1 FROM vector_codes vc …)` ⇒ 若不先判聚合，
    //   它会被 `vector_codes` 那条规则抢走 ⇒ **一条诊断查询被记成「读了码行」**。
    const diagnostic = classifyReadKind(
      'SELECT count(*) AS n FROM vector_cell_members vcm ' +
        'WHERE vcm.fine_id IN (?) ' +
        'AND NOT EXISTS (SELECT 1 FROM vector_codes vc WHERE vc.memory_id = vcm.memory_id)',
    );
    expect(diagnostic).toBeNull();
    expect(classifyReadKind('SELECT COUNT(*) AS n FROM memories')).toBeNull();
    expect(classifyReadKind('SELECT SUM(x) FROM memories')).toBeNull();
  });
});

/**
 * ★ **A 组的门禁：行读计数器的窗口必须罩住写入路径**。
 *
 * ⚠️ ★ **为什么这组必须有「反向断言」**（防「窗口开太大」）：
 *   窗口开太大 ⇒ **窗口外的读数被算进来** ⇒ 字节账偏大却看不出偏
 *   ⇒ ⇒ 断言「窗口外的读数**不计入**」比断言「窗口内的读数被计到」**更重要**
 *   （后者只证明「装了」，前者才证明「**只**装了要的那一段」）。
 */
describe('T06 · A：行读计数器的窗口覆盖写入路径', () => {
  it('★ 跑一次写路径扫描 ⇒ **码行**被计数、**桶成员行**被计数、`memories` 侧被计数', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    // ⚠️ ★ **用「重复写入」探针**（= 库里已有的一条记忆的向量 ⇒ 余弦 = 1 ⇒ 必然入选）
    //   ⇒ ⇒ 三段读（Q1 / Q2 / `memories` 侧）**都会被走到**（可复现，不靠运气）。
    const vector = buildDuplicateProbeVector(db.db);
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    counter.start();
    const scan = collectVectorCandidates(context, vector);
    counter.stop();
    const after = counter.snapshot();
    // ⚠️ ★ **核心断言**：写路径的三段读都被采到了
    //   （**此前码行恒 0** ⇒ 这条就是任务 B 的价值证明）。
    expect(after.codeRows - before.codeRows).toBeGreaterThan(0);
    expect(after.bucketMemberRows - before.bucketMemberRows).toBeGreaterThan(0);
    expect(after.candidateRows - before.candidateRows).toBeGreaterThan(0);
    // ⚠️ ★ **桶成员行数 == 候选宇宙**（`scan.scanned` = 命中桶的成员数）
    //   ⇒ 这是「Q1 读到的不多不少」的**结构性质**（一个记忆只属于一个细桶 ⇒ 桶间不重复）
    //   ⇒ ⇒ **窗口一旦开大，就会 > 候选宇宙** ⇒ 这条断言自带「防窗口开太大」的牙。
    expect(after.bucketMemberRows - before.bucketMemberRows).toBe(scan.scanned);
    counter.uninstall();
    db.db.close();
  });

  it('★ 一条**随机文本**探针 ⇒ `memories` 侧读到 **0 行**（两段式上界在正常工作，不是坏了）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    const vector = buildVector('随机探针：什么都不像 ⇒ 上界把全部候选剪掉');
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    counter.start();
    const scan = collectVectorCandidates(context, vector);
    counter.stop();
    const after = counter.snapshot();
    // ⚠️ ★ **Q1 / Q2 照读**（候选宇宙与码池必须读 —— 不然算不出上界）。
    expect(after.bucketMemberRows - before.bucketMemberRows).toBe(scan.scanned);
    expect(after.codeRows - before.codeRows).toBe(scan.scanned);
    // ⚠️ ★ **`memories` 侧读到 0 行**（余弦远低于 0.92 ⇒ 上界就把全部候选剪掉了）
    //   ⇒ ⇒ **「什么都没像 ⇒ 什么都不用读」** ⇒ 这是两段式的**卖点**，不是缺陷
    //   ⇒ ⇒ 也说明「码行数」必须与「`memories` 行数」**分开记**（合在一起会把
    //     「省下来的字节」藏起来）。
    expect(after.candidateRows - before.candidateRows).toBe(0);
    counter.uninstall();
    db.db.close();
  });

  it('★ **窗口之外**的读数**不计入**快照（窗口前 / 窗口后各读一次）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    // ⚠️ ★ **窗口前**的三种读（**每一种都是会被计数的表**）⇒ 一个都不许进快照。
    db.db.prepare('SELECT memory_id FROM vector_codes LIMIT 5').all();
    db.db.prepare('SELECT memory_id FROM vector_cell_members LIMIT 5').all();
    db.db.prepare('SELECT id FROM memories LIMIT 5').all();
    const outside = counter.snapshot();
    expect(outside.codeRows).toBe(before.codeRows);
    expect(outside.bucketMemberRows).toBe(before.bucketMemberRows);
    expect(outside.candidateRows).toBe(before.candidateRows);
    // ⚠️ **窗口内**读一次 ⇒ 进快照。
    counter.start();
    db.db.prepare('SELECT memory_id FROM vector_codes LIMIT 5').all();
    counter.stop();
    const inside = counter.snapshot();
    expect(inside.codeRows).toBe(before.codeRows + 5);
    // ⚠️ ★ **窗口后**的读**不许**再进快照（⇒ 停表必须真的停）。
    db.db.prepare('SELECT memory_id FROM vector_codes LIMIT 5').all();
    const afterStop = counter.snapshot();
    expect(afterStop.codeRows).toBe(inside.codeRows);
    counter.uninstall();
    db.db.close();
  });

  it('★ `measurePerf` 的写路径窗口 ⇒ 码行 > 0、桶成员行 > 0（窗口真的罩住了写路径）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const samples: WritePathReadSample[] = [];
    const result = measurePerf(db.db, store, options, 5, 5, {
      onWritePathReads: (rows) => {
        samples.push(...rows);
      },
    });
    // ⚠️ ★ **每一次写路径扫描都要有样本**（一个都没有 ⇒ 窗口没罩住 ⇒ 真空通过）。
    expect(samples.length).toBe(5);
    const totalMemories = (
      db.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    ).n;
    for (const sample of samples) {
      // ⚠️ ★ **码行被计数**（这是任务 B 的落点：两段式的「省字节」必须看得见）。
      expect(sample.codeRows).toBeGreaterThan(0);
      // ⚠️ **桶成员行被计数**（Q1）。
      expect(sample.bucketMemberRows).toBeGreaterThan(0);
      // ⚠️ **候选宇宙 > 0**（⇒ 向量路在写路径真的跑了 ⇒ 不是「什么都没读到」）。
      expect(sample.candidateUniverse).toBeGreaterThan(0);
      // ⚠️ ★ **反向断言（防「窗口开太大」）**：桶成员行数 **== 候选宇宙**
      //   ⇒ 一旦窗口罩住了别的扫描（召回探针 20/50 / **生产写入循环**内部那次向量扫描），
      //     这个数就会变大 ⇒ ⇒ **这条同时钉住施工规格 T06-2 验收标准 1**
      //     （「写入循环 `store.write()` 内部的向量扫描**不被计量**」）。
      expect(sample.bucketMemberRows).toBe(sample.candidateUniverse);
      // ⚠️ ★ **`memories` 侧的读数远小于全表**（⇒ 不是「把整张表读了一遍」）。
      expect(sample.candidateRows).toBeGreaterThan(0);
      expect(sample.candidateRows).toBeLessThan(totalMemories);
    }
    // ⚠️ **H1/H2 的判据量不受本段影响**（它不经过这个计数器 ⇒ 行数账与字节账各走各的）。
    expect(result.writeSegments.vectorCandidateRows.max).toBeGreaterThan(0);
    db.db.close();
  });

  it('★ `disableRowReadCounter` ⇒ 写路径样本**恒为 0**（「装了但不计数」这条纪律没破）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const samples: WritePathReadSample[] = [];
    const result = measurePerf(db.db, store, options, 5, 5, {
      disableRowReadCounter: true,
      onWritePathReads: (rows) => {
        samples.push(...rows);
      },
    });
    expect(samples.length).toBe(5);
    for (const sample of samples) {
      expect(sample.codeRows).toBe(0);
      expect(sample.bucketMemberRows).toBe(0);
      expect(sample.candidateRows).toBe(0);
      // ⚠️ ★ **候选宇宙不是 0**（它是 `scan.scanned` ⇒ 来自生产返回值，**不经过计数器**）
      //   ⇒ ⇒ 「计数器被打残」不会把判据量一起打没。
      expect(sample.candidateUniverse).toBeGreaterThan(0);
    }
    // ⚠️ ★ **H1 的判据量照旧**（计数器失效不影响行数账 ⇒ 这两笔账必须彼此独立）。
    expect(result.writeSegments.vectorCandidateRows.max).toBeGreaterThan(0);
    db.db.close();
  });
});

/**
 * ★★★ **T06 第二段 · C 组：形状登记表自测（7 个登记形状 + 1 个未登记）**。
 *
 * ⚠️ ★ **为什么这一组必须存在**（口径 §3.2 的「维护纪律」）：
 *   字节账**只认登记在册的形状** ⇒ ⇒ **新增一条生产 SQL（改了 SELECT 列表）而没同批登记**
 *   ⇒ 它会落进 `unclassified` ⇒ 判红 ⇒ ⇒ **「报表看起来很正常、账从根上算错」的形状**。
 *   ⇒ ⇒ **登记表的完备性必须被机器钉住**，而不是靠人记得。
 *
 * ⚠️ ★ **为什么用「生产录下来的 SQL」而不是抄一份**（本仓库的老坑）：
 *   抄一份 ⇒ 生产改了 SQL 而测试还在测旧文本 ⇒ **断言恒绿**。
 */
describe('T06 · C：形状登记表（7 个登记形状 + 1 个未登记）', () => {
  it('★ 登记表恰好 7 条，id 唯一，且 id 集合 = Q1/Q2/Q3/Q4/Q5/scoreOf/bucketCandidate', () => {
    expect(REGISTERED_SHAPES).toHaveLength(7);
    const ids = REGISTERED_SHAPES.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(7);
    // ⚠️ ★ **形状 id 必须是 `bucketCandidate`**（口径 §3.2 裁决 4 订正版）
    //   ⇒ ⇒ **不许叫 `legacy`**（那会把「legacy 行读结论」与「JOIN 形状」混成一个词
    //   ⇒ ⇒ 读的人会以为「legacy 那个形状 = legacy 那个计数器」⇒ **两个不同的东西一个名字**）。
    expect(ids).toContain('bucketCandidate');
    expect(ids).not.toContain('legacy');
    expect([...ids].sort()).toEqual(
      ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'bucketCandidate', 'scoreOf'].sort(),
    );
  });

  it('★ 7 条登记形状**逐条**都能被生产 SQL 认领（**从生产句柄上录**）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    const vector = buildDuplicateProbeVector(db.db);
    const captured = recordPreparedSql(db.db, () => {
      collectVectorCandidates(context, vector);
    });
    // ⚠️ ★ **写路径必须录到这三条**（Q1 / Q2 / Q4）。
    const memberSql = captured.find((sql) => sql.includes('vector_cell_members'));
    const codeSql = captured.find((sql) => sql.includes('vector_codes'));
    const survivorSql = captured.find((sql) => sql.includes('FROM memories m'));
    expect(memberSql).toBeDefined();
    expect(codeSql).toBeDefined();
    expect(survivorSql).toBeDefined();
    if (memberSql === undefined || codeSql === undefined || survivorSql === undefined) {
      throw new Error('写路径没录到预期的三条 SQL（⇒ 断言失去意义）');
    }
    // ⚠️ ★ **Q1**（成员）：只认 `vector_cell_members` ⇒ 零向量载荷字节。
    const q1 = resolveShape(memberSql);
    expect(q1?.id).toBe('Q1');
    expect(q1?.sources).toEqual(['member']);
    expect(q1?.payloadSource).toBeNull();
    // ⚠️ ★ **Q2**（码池）：载荷 = `code` 这一列。
    const q2 = resolveShape(codeSql);
    expect(q2?.id).toBe('Q2');
    expect(q2?.sources).toEqual(['code']);
    expect(q2?.payloadSource).toBe('code');
    expect(q2?.payloadColumns).toEqual(['code']);
    // ⚠️ ★ **Q4**（survivors 整行）：载荷 = `embedding`；正文 = `content` + `content_tokens`。
    const q4 = resolveShape(survivorSql);
    expect(q4?.id).toBe('Q4');
    expect(q4?.payloadColumns).toEqual(['embedding']);
    expect(q4?.contentColumns).toEqual(['content', 'content_tokens']);
    db.db.close();
  });

  it('★ `scoreOf` 的形状：载荷 = `embedding`、**且是唯一带 `callSource` 的形状**（剪枝率分子的依据）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    const vector = buildDuplicateProbeVector(db.db);
    const captured = recordPreparedSql(db.db, () => {
      collectVectorCandidates(context, vector);
    });
    // ⚠️ ★ **`scoreOf` 那条 SQL 必须被录到**（它是「逐条精确分」的载体）。
    const scoreSql = captured.find(
      (sql) => sql.includes('SELECT embedding FROM memories') && sql.includes('id = ?'),
    );
    expect(scoreSql).toBeDefined();
    if (scoreSql === undefined) {
      throw new Error('写路径没录到 scoreOf 的 SQL（⇒ 剪枝率分子无从验证）');
    }
    const shape = resolveShape(scoreSql);
    expect(shape?.id).toBe('scoreOf');
    expect(shape?.payloadColumns).toEqual(['embedding']);
    expect(shape?.callSource).toBe('exactEmbedding');
    // ⚠️ ★ **全表只有一条形状带 `callSource`**（⇒ 「数调用次数」只对 `scoreOf` 成立
    //   ⇒ ⇒ 它才与 `prune` 的 `exactReads` 定义性相等）。
    const withCallSource = REGISTERED_SHAPES.filter((entry) => entry.callSource !== null);
    expect(withCallSource).toHaveLength(1);
    expect(withCallSource[0]?.id).toBe('scoreOf');
  });

  it('★ **未登记的形状 ⇒ `resolveShape()` 返回 `null`**（⇒ 命中零来源 ⇒ `unclassified` ⇒ 判红）', () => {
    // ⚠️ ★ **这条是「口径不完整必须暴露」的地基**：一个没登记的形状
    //   ⇒ ⇒ 字节账会**少算** ⇒ ⇒ 报表看起来很正常 ⇒ ⇒ 必须当场变成 `unclassified`。
    const unregistered = resolveShape('SELECT id, stability FROM memories WHERE id IN (?)');
    expect(unregistered).toBeNull();
    // ⚠️ **形状键算得出来**（⇒ `null` 是「未登记」，不是「解析不出来」——这两件事必须分得开）。
    const key = shapeKeyOf('SELECT id, stability FROM memories WHERE id IN (?)');
    expect(key).not.toBeNull();
    expect(key?.tables).toEqual(['memories']);
    expect(key?.columns).toEqual(['id', 'stability']);
  });

  it('★ 形状键 = (归一化表集合, 归一化源列名集合)：**WHERE 条件不进键**、`AS` 别名不进键', () => {
    // ⚠️ ★ **WHERE 不进键**（口径 §3.2）：`deleted = 0` 的有无**不影响**判定。
    const withDeleted = resolveShape(
      'SELECT embedding FROM memories WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL',
    );
    const withoutDeleted = resolveShape('SELECT embedding FROM memories WHERE id = ?');
    expect(withDeleted?.id).toBe('scoreOf');
    expect(withoutDeleted?.id).toBe('scoreOf');
    // ⚠️ ★ **别名不进键**（`m.embedding AS vec` ⇒ 源列名仍是 `embedding`）。
    const aliased = resolveShape('SELECT m.embedding AS vec FROM memories m WHERE m.id = ?');
    expect(aliased?.id).toBe('scoreOf');
    // ⚠️ ★ **`IN (?, ?, ?)` 折叠成 `IN (...)`**（占位符个数随桶数变 ⇒ 不折叠则键不稳定）。
    const onePlaceholder = resolveShape(
      'SELECT id, last_access, pin_factor FROM memories WHERE id IN (?)',
    );
    const manyPlaceholders = resolveShape(
      'SELECT id, last_access, pin_factor FROM memories WHERE id IN (?, ?, ?)',
    );
    expect(onePlaceholder?.id).toBe('Q3');
    expect(manyPlaceholders?.id).toBe('Q3');
  });

  it('★ 归一化三步：折叠空白 → trim → `IN (…)` 折叠 → 小写（**顺序不许变**）', () => {
    const raw = '  SELECT  id,\n   last_access FROM   memories  WHERE id IN ( ?, ?, ? )  ';
    const normalized = normalizeSql(raw);
    expect(normalized).toBe('select id, last_access from memories where id in (...)');
    expect(normalized).not.toMatch(/\n/);
    // ⚠️ ★ **小写**（表名 / 列名在 SQLite 里大小写不敏感 ⇒ 全小写安全）。
    expect(normalized).toBe(normalized.toLowerCase());
  });

  it('★ `parseTables` / `parseSelectList` 的行为（**只取第一个 SELECT 之后、第一个 FROM 之前**）', () => {
    expect(
      parseTables('SELECT a FROM memories m JOIN vector_codes vc ON vc.memory_id = m.id'),
    ).toEqual(['memories', 'vector_codes']);
    // ⚠️ ★ **WHERE 里的列名不许进 SELECT 列表**（口径 §3.2 的第三条）
    //   ⇒ 否则 `WHERE m.embedding IS NOT NULL` 会让窄读被误判成向量来源 ⇒ 字节账虚高。
    const items = parseSelectList(
      'SELECT id, last_access FROM memories WHERE embedding IS NOT NULL',
    );
    expect(items.map((item) => item.sourceColumn)).toEqual(['id', 'last_access']);
    // ⚠️ ★ **改别名不影响源列名**。
    const aliased = parseSelectList('SELECT m.embedding AS vec FROM memories m');
    expect(aliased[0]?.sourceColumn).toBe('embedding');
    // ⚠️ ★ **函数调用里带逗号**不许被切坏（`bm25(mem_fts)` 那种）。
    const withFunction = parseSelectList('SELECT id, bm25(mem_fts) AS rank FROM mem_fts');
    expect(withFunction).toHaveLength(2);
    // ⚠️ **表达式本身不是列** ⇒ 源列名 = 整个表达式（`bm25(mem_fts)`）
    //   ⇒ ⇒ 它**不是**任何登记形状的列 ⇒ 未登记 ⇒ 命中零来源。
    expect(withFunction[1]?.sourceColumn).toBe('bm25(mem_fts)');
    expect(resolveShape('SELECT id, bm25(mem_fts) AS rank FROM mem_fts')).toBeNull();
  });

  it('★ 聚合判定**必须最先**（诊断 SQL 命中零来源、但**不计入** `unclassified`）', () => {
    const diagnostic =
      'SELECT count(*) AS n FROM vector_cell_members vcm ' +
      'WHERE vcm.fine_id IN (?) ' +
      'AND NOT EXISTS (SELECT 1 FROM vector_codes vc WHERE vc.memory_id = vcm.memory_id)';
    expect(isAggregateSql(diagnostic)).toBe(true);
    // ⚠️ ★ **但它【不是】未登记**（聚合豁免）⇒ ⇒ 不得落进 `unclassified`。
    expect(classifyReadKind(diagnostic)).toBeNull();
    // ⚠️ **同样形态的分组查询**（`bucketAssign.ts:525`）也是聚合。
    expect(
      isAggregateSql(
        'SELECT memory_id FROM vector_cell_members GROUP BY memory_id HAVING COUNT(*) > 1',
      ),
    ).toBe(true);
  });

  it('★ `sqlFingerprint`：归一化后的文本、截断到 120 字符（同形状不同写法 ⇒ 同一指纹）', () => {
    const a = sqlFingerprint('SELECT id FROM memories\n  WHERE id IN (?, ?)');
    const b = sqlFingerprint('select id from memories where id in (...)');
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(120);
    const long = sqlFingerprint(`SELECT ${'x'.repeat(500)} FROM memories`);
    expect(long.length).toBe(120);
    expect(long.endsWith('...')).toBe(true);
  });
});

/**
 * ★★★ **T06 第二段 · D 组：字节模型单测（纯函数 ⇒ 不碰库）**。
 *
 * ⚠️ ★ **为什么字节模型要单测**（而不是只在集成路径上验）：
 *   字节账的**全部价值**是「实测的字节数」⇒ ⇒ 如果 `bytesOfRow()` 的口径偏了
 *   （比如把标量也算进去、把正文也算进去、把坏码当成好码）
 *   ⇒ ⇒ 集成路径上的断言**可能仍然绿**（因为恒等式是自洽的）
 *   ⇒ ⇒ **偏了也看不出来** ⇒ ⇒ 必须在纯函数层把口径钉死。
 */
describe('T06 · D：字节模型单测（`bytesOfRow()`）', () => {
  /** 造一条**形状**（按 id 取；登记表是纯数据 ⇒ 取出来即可用）。 */
  function shapeOf(id: string): (typeof REGISTERED_SHAPES)[number] {
    const shape = REGISTERED_SHAPES.find((entry) => entry.id === id);
    if (shape === undefined) {
      throw new Error(`登记表里没有形状 ${id}`);
    }
    return shape;
  }

  it('★ 码行：768 B 的码 ⇒ 载荷 768 B；`scale` / `eps` 是标量 ⇒ **0 字节**', () => {
    const shape = shapeOf('Q2');
    const row = {
      memory_id: 'm-1',
      code: Buffer.alloc(768, 1),
      scale: 0.5,
      eps: 1e-9,
    };
    const bytes = bytesOfRow(row, shape, 768);
    // ⚠️ ★ **核心**：载荷 = **只有码**（标量不进 `bytesRead` ⇒ 口径 §1.3 裁决 A）。
    expect(bytes.payloadBytes).toBe(768);
    expect(bytes.contentBytes).toBe(0);
    expect(bytes.hasEmbedding).toBe(false);
    expect(bytes.badCode).toBe(false);
  });

  it('★ **坏码行**（码长 ≠ 768）⇒ `badCode = true`（= 白读 ⇒ 断言 1a 的前提违例）', () => {
    const shape = shapeOf('Q2');
    const bytes = bytesOfRow({ memory_id: 'm-1', code: Buffer.alloc(100, 1) }, shape, 768);
    // ⚠️ ★ **字节照样计入**（它**已经被读了、被搬了**）⇒ 但**同时**标记为坏码。
    expect(bytes.payloadBytes).toBe(100);
    expect(bytes.badCode).toBe(true);
    // ⚠️ **健康库的对照**：768 B 的码 ⇒ 不是坏码。
    expect(bytesOfRow({ code: Buffer.alloc(768) }, shape, 768).badCode).toBe(false);
  });

  it('★ 向量行：`embedding` 的 `.byteLength` 进载荷；**正文走 UTF-8 实测**且**不进** `bytesRead`', () => {
    const shape = shapeOf('Q4');
    const embedding = Buffer.alloc(3072, 1);
    const row = {
      id: 'm-1',
      content: '中文正文',
      content_tokens: '中文 正文',
      stability: 1,
      last_access: 0,
      access_count: 0,
      difficulty: 0.5,
      embedding,
    };
    const bytes = bytesOfRow(row, shape, 768);
    // ⚠️ ★ **载荷 = 只有向量**（3,072 B）。
    expect(bytes.payloadBytes).toBe(3072);
    expect(bytes.hasEmbedding).toBe(true);
    // ⚠️ ★ **正文走 UTF-8 实测**（不许用「声明长度」⇒ id 格式一改就错）。
    expect(bytes.contentBytes).toBe(
      Buffer.byteLength('中文正文', 'utf8') + Buffer.byteLength('中文 正文', 'utf8'),
    );
    // ⚠️ ★ **正文字节【不在】载荷里**（⇒ 「下界差多少」这件事必须可见）。
    expect(bytes.payloadBytes).not.toBe(3072 + bytes.contentBytes);
  });

  it('★ 窄读行（Q3）：**0 载荷字节**（没有 `embedding` ⇒ 不进 `bytesRead`）', () => {
    const shape = shapeOf('Q3');
    const bytes = bytesOfRow({ id: 'm-1', last_access: 1, pin_factor: 0.5 }, shape, 768);
    expect(bytes.payloadBytes).toBe(0);
    expect(bytes.contentBytes).toBe(0);
    expect(bytes.hasEmbedding).toBe(false);
  });

  it('★ 成员行（Q1）：**0 载荷字节**（成员 id 不是向量载荷）', () => {
    const shape = shapeOf('Q1');
    const bytes = bytesOfRow({ fine_id: 'f-1', memory_id: 'm-1' }, shape, 768);
    expect(bytes.payloadBytes).toBe(0);
    expect(bytes.contentBytes).toBe(0);
  });

  it('★ `bucketCandidate`（JOIN 形状）：载荷**只记在 `payloadSource` 一个来源上**（不许记两遍）', () => {
    const shape = shapeOf('bucketCandidate');
    // ⚠️ ★ **它同时认领「成员」与「向量」两个来源** ⇒ 若按 `sources` 逐个累加
    //   ⇒ ⇒ **同一份字节被记两遍** ⇒ `bytesRead` 虚高一倍 ⇒ ⇒ 这条钉住「只记一次」。
    expect(shape.sources).toEqual(['member', 'survivorRow']);
    expect(shape.payloadSource).toBe('survivorRow');
    const bytes = bytesOfRow(
      {
        id: 'm-1',
        content: 'abc',
        content_tokens: 'a b c',
        stability: 1,
        last_access: 0,
        access_count: 0,
        difficulty: 0.5,
        embedding: Buffer.alloc(3072, 1),
      },
      shape,
      768,
    );
    expect(bytes.payloadBytes).toBe(3072);
  });

  it('★ `embedding` 为 `null` ⇒ **不**计入载荷、**不**算 `hasEmbedding`（⇒ 白读不算）', () => {
    const shape = shapeOf('scoreOf');
    const bytes = bytesOfRow({ embedding: null }, shape, 768);
    expect(bytes.payloadBytes).toBe(0);
    expect(bytes.hasEmbedding).toBe(false);
  });
});

/**
 * ★★★ **T06 第二段 · E 组：口径断言（1 / 1a / 1b / 1c-bench / 1d / 1e / 2 / 3）+ 落盘结构**。
 *
 * ⚠️ ★ **这一组是「口径本身」的账**（不是「字节达标」）：
 *   断言 1（字节恒等式）/ 1a（健康库）/ 1b（legacy 交叉校验）/ 1c-bench（剪枝率分子纪律）
 *   / 1d（两轮对齐）/ 1e（窗口没开大）/ 2（分类完备）/ 3（unclassified 自检）
 *   ⇒ ⇒ **它们守的是「账算得对不对」**，不是「账够不够小」。
 *
 * ⚠️ ★ **断言 4（零 `src/**` 改动）**由 `git diff --stat src/` 在**验收命令**里验
 *   （⇒ 它是**仓库状态**的断言 ⇒ 写在测试文件里反而会骗人）。
 */
describe('T06 · E：口径断言与落盘结构', () => {
  it('★ 断言 1：`bytesRead === codeBytes + embeddingBytes`（**零容差**恒等式）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    const reads = result.vectorRouteByteReads;
    for (const [label, block] of [
      ['写入去重路径（探针 8/20）', writes],
      ['召回路径（探针 20/50）', reads],
    ] as const) {
      // ⚠️ ★ **零容差**（不许用 `toBeCloseTo` ⇒ 偏 1 字节都是错的）。
      expect(block.bytesRead.max, `${label} bytesRead.max`).toBe(
        block.breakdown.codeBytes.max + block.breakdown.embeddingBytes.max,
      );
      // ⚠️ ★ **均值这条是【结构性成立】的**（均值是线性的 ⇒ 跨样本也严格相等）
      //   ⇒ ⇒ 它比 `max` 那条更稳 ⇒ **两条都断言**（`max` 那条若哪天破了，
      //   说明「各序列的 max 来自不同样本」⇒ 那是**另一个**要查的问题）。
      expect(
        Math.abs(
          block.bytesRead.mean -
            (block.breakdown.codeBytes.mean + block.breakdown.embeddingBytes.mean),
        ),
      ).toBeLessThan(1e-6);
      // ⚠️ ★ **样本数必须一致**（否则「逐样本」的恒等式就是假的）。
      expect(block.bytesRead.count).toBe(block.breakdown.codeBytes.count);
      expect(block.bytesRead.count).toBe(block.breakdown.embeddingBytes.count);
    }
    db.db.close();
  });

  it('★ 断言 1 的**逐样本**版本（counter 层 · 零容差）：每个窗口的字节都等于它的两分项之和', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    const vector = buildDuplicateProbeVector(db.db);
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    counter.start();
    collectVectorCandidates(context, vector);
    counter.stop();
    const after = counter.snapshot();
    // ⚠️ ★ **逐样本的恒等式**（零容差 ⇒ 「字节恒等式」这条断言的**真正形态**）。
    expect(after.bytesRead - before.bytesRead).toBe(
      after.codeBytes - before.codeBytes + (after.embeddingBytes - before.embeddingBytes),
    );
    counter.uninstall();
    db.db.close();
  });

  it('★ 断言 1a（健康库检查）：`badCodeRows === 0` ⇒ `codeBytes === codeRowsRead × 768`', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    // ⚠️ ★ **前提**：健康库**恒 0 坏码行**（非 0 ⇒ 前提违例 ⇒ 下面那条恒等式不成立）。
    expect(writes.breakdown.badCodeRows).toBe(0);
    expect(result.vectorRouteByteReads.breakdown.badCodeRows).toBe(0);
    // ⚠️ ★ **核心**：码字节 = 码行数 × 768（**实测** ⇒ 恒等于行数 × 期望码长）。
    expect(writes.breakdown.codeBytes.max).toBe(writes.codeRowsRead.max * 768);
    expect(writes.breakdown.codeBytes.min).toBe(writes.codeRowsRead.min * 768);
    expect(result.vectorRouteByteReads.breakdown.codeBytes.max).toBe(
      result.vectorRouteByteReads.codeRowsRead.max * 768,
    );
    db.db.close();
  });

  it('★ 断言 1b（legacy 交叉校验 · 写路径）：`bytesRead === codeRows × 768 + memoryRows × 3,072`', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    // ⚠️ ★ **前提**：写路径的 `memories` 侧读数必须被采到（**Q3 在写路径不发** ⇒
    //   ⇒ 写路径的 `memoryRowsRead` == legacy 计数器的 `candidateRows`
    //   ⇒ ⇒ 交叉校验 1b **在写路径成立**（口径 §1.5 / §6.1））。
    expect(writes.memoryRowsRead.max).toBeGreaterThan(0);
    expect(writes.codeRowsRead.max).toBeGreaterThan(0);
    // ⚠️ ★ **核心（零容差）**：字节 = 码行 × 768 + `memories` 侧行 × 3,072
    //   ⇒ ⇒ **专打「分类漏了 Q4 / 漏了 `scoreOf`」那两个变异**（漏一个 ⇒ 字节对不上）。
    expect(writes.bytesRead.max).toBe(
      writes.codeRowsRead.max * 768 + writes.memoryRowsRead.max * 3072,
    );
    db.db.close();
  });

  it('★ 断言 1b 的**逐样本**版本（counter 层 · 零容差）：legacy `candidateRows × 3,072` 逐位对得上', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const context = buildWriteContext(db.db);
    const vector = buildDuplicateProbeVector(db.db);
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    counter.start();
    collectVectorCandidates(context, vector);
    counter.stop();
    const after = counter.snapshot();
    // ⚠️ ★ **这是 1b 真正的形态**（逐样本 ⇒ 零容差）：
    //   落盘层的 `max` 恒等式是**跨样本**的（各序列的 max 可能来自不同样本）
    //   ⇒ ⇒ **逐样本这一层才是「分类有没有漏」的精确判据**。
    const codeRows = after.codeRows - before.codeRows;
    const legacyMemoryRows = after.candidateRows - before.candidateRows;
    const bytes = after.bytesRead - before.bytesRead;
    expect(codeRows).toBeGreaterThan(0);
    expect(legacyMemoryRows).toBeGreaterThan(0);
    expect(bytes).toBe(codeRows * 768 + legacyMemoryRows * 3072);
    // ⚠️ ★ **字节恒等式（逐样本）**：向量载荷 = 码字节 + 向量字节（零容差）。
    expect(bytes).toBe(
      after.codeBytes - before.codeBytes + (after.embeddingBytes - before.embeddingBytes),
    );
    counter.uninstall();
    db.db.close();
  });

  it('★ 断言 1c-bench（口径纪律）：分子 = `embeddingCalls`（调用次数）⇒ **≥** `scoreOf` 返回行数', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    const reads = result.vectorRouteByteReads;
    // ⚠️ ★★ **核心口径纪律（口径 §1.7 / 断言 1c-bench）**：
    //   **剪枝率的分子必须是「调用次数」**（`embeddingCalls` = `get()` 调用次数 · 无条件计数）
    //   ⇒ ⇒ 它 **≥** 「`scoreOf` 返回了行的次数」（`embeddingExactRows`）
    //   ⇒ ⇒ 若有人把分子换成「返回行数」⇒ 分子偏小 ⇒ **偏松 = 假绿**。
    expect(writes.breakdown.embeddingCalls.max).toBeGreaterThanOrEqual(
      writes.breakdown.embeddingExactRows.max,
    );
    expect(reads.breakdown.embeddingCalls.max).toBeGreaterThanOrEqual(
      reads.breakdown.embeddingExactRows.max,
    );
    // ⚠️ ★★ **读路径的【加强形式】**（口径 **裁决 8 ②** 明说：「**读路径下
    //   `embeddingCalls ≥ embeddingRowsRead` 仍成立**（读路径无 Q4 ⇒ 两数同域）
    //   ⇒ 这条可作为**读路径的加强形式**保留」）：
    //   ⇒ ⇒ 口径那条**字面形式**在**读路径成立**、在**写路径恒红**
    //   ⇒ ⇒ 这一条把「两个域的差别」**机器化**了（不是散文）。
    //   ⚠️ 实测：读路径 `embeddingRowsRead.max = 20` = `embeddingCalls.max = 20`（相等 ⇒ 成立）。
    expect(reads.breakdown.embeddingCalls.max).toBeGreaterThanOrEqual(
      reads.breakdown.embeddingRowsRead.max,
    );
    // ⚠️ ★ **落盘必须有这两个字段**（⇒ 「分子 = 调用次数」这件事在 JSON 里看得见）。
    expect(Object.keys(writes.breakdown)).toContain('embeddingCalls');
    expect(Object.keys(writes.breakdown)).toContain('embeddingExactRows');
    // ⚠️ ★★★ **为什么判定对象是 `embeddingExactRows` 而不是 `embeddingRowsRead`**
    //   （**这是本轮实测出来的一处口径内部张力 · 必须写明**）：
    //   `embeddingRowsRead` = **物化出 `embedding` 的行数**（= `scoreOf` 的行 + Q4/Q5 survivors 的行）
    //   ⇒ 而 `embeddingCalls` 只数 `scoreOf` 的 `get()` **调用次数**
    //   ⇒ ⇒ **写路径的 Q4 一发（survivors 整行读）⇒ `embeddingRowsRead` 就比 `embeddingCalls` 大**
    //   ⇒ ⇒ 口径 §4 表里那条字面形式 `embeddingCalls ≥ embeddingRowsRead` **在写路径不成立**
    //   ⇒ ⇒ 本实现**新增 `embeddingExactRows`**（= `scoreOf` 返回行数）作为 1c-bench 的可判定比较对象
    //   ⇒ ⇒ **「严格不等」的证据**（调用里有「白调用」⇒ 调用数 > 返回行数）
    //   由 `tests/unit/prune.test.ts` 的断言 1c 提供（那里能造出白调用）。
    expect(writes.breakdown.embeddingCalls.max).toBeGreaterThanOrEqual(
      writes.breakdown.embeddingExactRows.max,
    );
    db.db.close();
  });

  it('★ 断言 1d（两轮对齐）：写路径 `samplesAligned === true`（**写路径**才是两轮）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    // ⚠️ ★ **写路径 = 两轮**（轮 A 计时 / 轮 B 计量 · 同一份输入）
    //   ⇒ ⇒ 逐样本 `candidateUniverse` 必须相等 ⇒ **有牙**：不等即红。
    expect(result.writeSegments.vectorByteReads.breakdown.samplesAligned).toBe(true);
    // ⚠️ ★★ **读路径 = 单轮**（字节与毫秒同源）⇒ 它的对账量是**别的量**（口径裁决落地 #1）：
    //   **实测桶成员行**（`search()` 真正扫的桶）**逐样本等于**
    //   **推算桶成员行**（`route()` 命中的桶各自 `countBucketMembers()` 之和）
    //   ⇒ ⇒ 证明「`search()` 看到的桶」与「`route()` 看到的桶」是同一批
    //   ⇒ ⇒ 落盘的 `candidateUniverse` 对得上实测字节账 ⇒ ⇒ **可判定**。
    //   ⚠️ **原先那条「字节样本数 == 计时样本数」是恒真的**（两个 push 在同一循环体内、
    //   无条件、无 continue/break ⇒ 长度必然相等）⇒ ⇒ 已被换掉。
    expect(result.vectorRouteByteReads.breakdown.samplesAligned).toBe(true);
    db.db.close();
  });

  it('★ 读路径对账量的**负控**：`readSamplesAlignedOf()` 喂**不相等**的两个数组 ⇒ 必须返回 false（**证明它不是恒绿守卫**）', () => {
    // ⚠️ ★★★ **这条是「负控」**（仓库纪律：**先想变异，再写断言**）：
    //   若这个纯函数被写成「恒返回 true」（**像原先那条「字节样本数 == 计时样本数」**）
    //   ⇒ ⇒ 读路径的「不可判定」守卫**永远打不红** ⇒ ⇒ **说谎**。
    //   ⇒ ⇒ **必须证明它能被喂红**（这正是断言 5「两头锁死」的纪律）。
    // ⚠️ ★ **正控**：逐样本相等 ⇒ true。
    expect(readSamplesAlignedOf([1, 2, 3], [1, 2, 3])).toBe(true);
    // ⚠️ ★ **负控 ①**：有一个样本不等 ⇒ false（⇒ 「有一批桶对不上」能被发现）。
    expect(readSamplesAlignedOf([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(readSamplesAlignedOf([1, 2, 3], [2, 2, 3])).toBe(false);
    // ⚠️ ★ **负控 ②**：长度不等 ⇒ false（⇒ 样本数对不上也能被发现）。
    expect(readSamplesAlignedOf([1, 2, 3], [1, 2])).toBe(false);
    expect(readSamplesAlignedOf([1, 2], [1, 2, 3])).toBe(false);
    // ⚠️ ★ **负控 ③**：推算值缺失（`null`）⇒ false（**方向纪律**：宁可误红不可假绿）。
    expect(readSamplesAlignedOf([1, 2, 3], [1, null, 3])).toBe(false);
    // ⚠️ ★ **负控 ④**：空数组 ⇒ true（**没有样本就没有可对账的东西** ⇒ 不判红）。
    expect(readSamplesAlignedOf([], [])).toBe(true);
  });

  it('★ 机器守卫：`bench/perf.ts` 里凡提到「字节样本数 == 计时样本数」的地方 ⇒ **必须同时否定它**（不许出现说谎的注释）', () => {
    // ⚠️ ★★★ **这条是 QA 在 T06 独立验证时登记的**（登记 1）：
    //   「`bench/perf.ts` 里同一件事说多遍、其中一遍是错的」⇒ ⇒ **同一个坑这一轮又踩了一次**
    //   ⇒ ⇒ 本条把「**注释不许说谎**」钉成**机器规则**（而不是靠人记得去读每一遍）。
    const source = readFileSync(new URL('../../bench/perf.ts', import.meta.url), 'utf8');
    // ⚠️ ★ **核心**：**没有**「提到却没否定」的处数 ⇒ 空数组（空数组 ⇒ 零处说谎）。
    expect(lyingStaleReadPathPhraseLines(source)).toEqual([]);
    // ⚠️ ★★★ **负控 ①（证明这个扫描器自己不是恒绿守卫）**：
    //   喂一条「提到却没否定」的文本 ⇒ **必须被抓出来**（行号 = 1）。
    expect(lyingStaleReadPathPhraseLines('// 读路径 = 字节样本数 == 计时样本数')).toEqual([1]);
    // ⚠️ ★ **负控 ②**：喂一条「提到并否定」的文本 ⇒ **不许**被抓（⇒ 不误报）。
    expect(
      lyingStaleReadPathPhraseLines('// 为什么不能是「字节样本数 == 计时样本数」：那条恒真'),
    ).toEqual([]);
  });

  it('★ 口径张力钉死：写路径 `embeddingRowsRead ≥ embeddingCalls`（**Q4 让字节账分子必然 ≥ 调用数**）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    // ⚠️ ★★★ **为什么这条必须钉住**（口径 §2 :188 那处「张力」）：
    //   `embeddingRowsRead` = **物化出 `embedding` 的行数**
    //   （= `scoreOf` 命中的行 **+** Q4 把 **survivors 整行**又读了一遍的行）
    //   ⇒ 而 `embeddingCalls` 只数 `scoreOf` 的 `get()` **调用次数**
    //   ⇒ ⇒ **写路径 Q4 一发 ⇒ `embeddingRowsRead` 就比 `embeddingCalls` 大**
    //   ⇒ ⇒ 口径 §4 表里那条字面形式 **`embeddingCalls ≥ embeddingRowsRead` 在写路径不成立**
    //   ⇒ ⇒ 口径已裁决改成 `embeddingCalls ≥ embeddingExactRows`（`embeddingExactRows` = `scoreOf` 返回行数）。
    // ⚠️ ★ **「为什么 `embeddingRowsRead` 不能当 1c-bench 的比较对象」**：
    //   它**混进了 Q4 的整行读** ⇒ ⇒ 它不是「精确分的行数」⇒ ⇒ 用它当比较对象，
    //   口径那句话就会在写路径**字面不成立**（⇒ 口径就变成散文而不是机器可证的事实）。
    expect(writes.breakdown.embeddingRowsRead.max).toBeGreaterThanOrEqual(
      writes.breakdown.embeddingCalls.max,
    );
    // ⚠️ ★ **结构上恒成立的那一对**（口径裁决后的可判定形式）：
    //   `embeddingCalls`（调用次数）**≥** `embeddingExactRows`（返回行数）—— 白调用也在计数
    //   ⇒ ⇒ 剪枝率的分子**偏大 = 更严** ⇒ ⇒ 不会假绿。
    expect(writes.breakdown.embeddingCalls.max).toBeGreaterThanOrEqual(
      writes.breakdown.embeddingExactRows.max,
    );
    // ⚠️ ★ **字节账的分子 ≥ 精确分的行数**（Q4 只加不减 ⇒ 方向恒为偏大）。
    expect(writes.breakdown.embeddingRowsRead.max).toBeGreaterThanOrEqual(
      writes.breakdown.embeddingExactRows.max,
    );
    db.db.close();
  });

  it('★ 断言 1e（窗口没开大）：写路径 `bucketMemberRows === candidateUniverse`（**零容差**）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    // ⚠️ ★ **结构等式（零容差）**：一个记忆只属于一个细桶 ⇒ 桶间不重复
    //   ⇒ ⇒ 写路径 Q1 读到的成员行数 **==** 候选宇宙
    //   ⇒ ⇒ **窗口一旦开大**（罩住了生产写入循环内部那次向量扫描）⇒ 这个数就变大 ⇒ 红。
    expect(writes.breakdown.bucketMemberRows.max).toBe(writes.candidateUniverse.max);
    expect(writes.breakdown.bucketMemberRows.min).toBe(writes.candidateUniverse.min);
    db.db.close();
  });

  it('★ 断言 2（分类完备）：`unclassifiedRows === 0` **且** 各形状行数之和 == 对应读数', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    const reads = result.vectorRouteByteReads;
    // ⚠️ ★ **前提**：生产路径上的每一条 SQL 都必须被认领（未认领 ⇒ 字节账偏小 ⇒ 假绿）。
    expect(writes.breakdown.unclassifiedRows).toBe(0);
    expect(writes.breakdown.unclassifiedSqlKinds).toEqual([]);
    expect(reads.breakdown.unclassifiedRows).toBe(0);
    expect(reads.breakdown.unclassifiedSqlKinds).toEqual([]);
    // ⚠️ ★ **分类完备的第二半**：各来源的行数之和 == 对应的读数
    //   ⇒ ⇒ **码行**（Q2）+ **向量行**（`scoreOf` + Q4）== `memories` 侧的读数。
    expect(writes.codeRowsRead.max).toBeGreaterThan(0);
    expect(writes.breakdown.embeddingRowsRead.max).toBeGreaterThan(0);
    // ⚠️ ★ **窄读在写路径不发**（Q3 只在读路径发）⇒ ⇒ 写路径 `narrowRowsRead` 恒 0。
    expect(writes.breakdown.narrowRowsRead.max).toBe(0);

    // ⚠️ ★★★★ **分类完备的第二半（逐形状）**：各登记形状的行数之和 == 对应读数。
    //   ⇒ ⇒ ★ **必须逐形状钉死**（只钉总和 ⇒ 一个形状多算、另一个少算会**互相抵消**
    //   ⇒ ⇒ **恒绿** ⇒ ⇒ 没牙）。
    const window = measureWritePathShapeWindow(db.db);
    // ⚠️ ★ **形状集合逐位钉死**：生产写路径上发这 4 条 SQL。
    //   ⇒ ⇒ 生产 SQL 改了 SELECT 列表（形状变了）⇒ 这条**立刻红** ⇒ 强制「同批登记」
    //   （口径 §13 第 6 条的纪律）。
    expect(Object.keys(window.shapeRows).sort()).toEqual(['Q1', 'Q2', 'Q4', 'scoreOf']);
    // ⚠️ ★ **逐形状判定**（纯函数；它的**负控**见下面那条「负控」测试）。
    const verdicts = shapeRowsAgree(window);
    // ⚠️ ★ **每个形状各点名**（不许只判「全绿」⇒ 否则一条形状坏了会被平均掉）。
    for (const id of ['Q1', 'Q2', 'Q4', 'scoreOf']) {
      expect(`${id}=${verdicts[id]}`).toBe(`${id}=true`);
    }
    // ⚠️ ★★ **独立对照（Q1 / Q2）**：桶成员行 / 码行 == **生产扫描自己报的候选宇宙**
    //   ⇒ ⇒ 这两个数**不经过 bench 计数器** ⇒ ⇒ **互相抵消不可能**
    //   ⇒ ⇒ 「分类被改坏」这种变异在这里**必然露出来**。
    expect(rowsOfShape(window, 'Q1')).toBe(window.scanned);
    expect(rowsOfShape(window, 'Q2')).toBe(window.scanned);
    // ⚠️ ★ **逐形状绑定到它自己那一份读数**
    //   （`scoreOf` 独占精确分；Q4 独占整行 survivors ⇒ **不许**与别的形状相加）。
    expect(rowsOfShape(window, 'scoreOf')).toBe(window.embeddingExactRows);
    expect(rowsOfShape(window, 'Q4')).toBe(window.embeddingRowsRead - window.embeddingExactRows);
    // ⚠️ ★ **各来源的行数之和 == 对应读数**（口径 §2 断言 2 的**字面**那半）。
    expect(rowsOfSource(window, 'code')).toBe(window.codeRowsRead);
    expect(rowsOfSource(window, 'narrow')).toBe(window.narrowRowsRead);
    expect(rowsOfSource(window, 'member')).toBe(window.bucketMemberRowsRead);
    expect(rowsOfSource(window, 'exactEmbedding')).toBe(window.embeddingExactRows);
    expect(rowsOfSource(window, 'survivorRow')).toBe(
      window.embeddingRowsRead - window.embeddingExactRows,
    );
    db.db.close();
  });

  /**
   * ★★★ **负控**：某个形状的行数被改动 ⇒ **逐形状判定必须打红**。
   *
   * ⚠️ ★★★ **为什么这条必须存在**（本轮的核心纪律：「守卫必须能被打红」）：
   *   断言 2 的第二半如果只钉「各来源之和 == 对应读数」⇒ ⇒ **恒绿**
   *   （一个形状多算 5、另一个少算 5 ⇒ 总和不变 ⇒ 照样绿 ⇒ **没牙**）
   *   ⇒ ⇒ 逐形状判定**必须**能抓住「某一个形状被改坏」这件事。
   *
   * ⚠️ ★★ **变异 ② 是本条的关键**：它**连读数一起改**（`codeRowsRead` 也 +5）
   *   ⇒ ⇒ **「只钉总和」的写法会【照样绿】** ⇒ ⇒ 这就是「恒绿守卫」的实证
   *   ⇒ ⇒ 逐形状判定**必须打红** ⇒ ⇒ **证明它不是恒绿**。
   */
  it('★ 负控：某个形状的行数被改动 ⇒ 逐形状判定**必须打红**（证明它不是「只钉总和」的恒绿守卫）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const window = measureWritePathShapeWindow(db.db);
    // ⚠️ ★ **正控**：真实数据 ⇒ 逐形状全绿（⇒ 下面的负控不是「本来就红」）。
    const verdicts = shapeRowsAgree(window);
    expect(Object.values(verdicts).every((ok) => ok)).toBe(true);
    // ⚠️ ★ **变异 ①**：把 `Q2` 的行数 +5（读数不动）⇒ `Q2` **必须打红**。
    const mutatedQ2: ShapeWindow = {
      ...window,
      shapeRows: { ...window.shapeRows, Q2: rowsOfShape(window, 'Q2') + 5 },
    };
    expect(verdictOf(shapeRowsAgree(mutatedQ2), 'Q2')).toBe(false);
    // ⚠️ ★★★ **变异 ②（关键的那条）**：`Q2` +5 **且** `codeRowsRead` 也 +5
    //   ⇒ ⇒ **「只钉总和」的写法会【照样绿】**（抵消成功 ⇒ 恒绿）
    //   ⇒ ⇒ 逐形状判定**必须**打红 ⇒ ⇒ **证明这条断言不是恒绿守卫**。
    const mutatedBoth: ShapeWindow = { ...mutatedQ2, codeRowsRead: window.codeRowsRead + 5 };
    // ⚠️ **先证明「总和口径确实会绿」**（⇒ 负控的前提成立，不是空断言）。
    expect(rowsOfSource(mutatedBoth, 'code')).toBe(mutatedBoth.codeRowsRead);
    // ⚠️ ★ **再证明「逐形状口径打红」**（⇒ 这才是我们要的牙）。
    expect(verdictOf(shapeRowsAgree(mutatedBoth), 'Q2')).toBe(false);
    db.db.close();
  });

  it('★ 断言 3（unclassified 自检）：喂一条**未登记**的形状 ⇒ 必须落进 `unclassified`', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    counter.start();
    // ⚠️ ★ **`SELECT id FROM memories` 是个未登记形状**（登记表里没有「只要 id」这一条）
    //   ⇒ ⇒ 它必须被记成「命中零来源」⇒ ⇒ **不许默默按 0 计**。
    db.db.prepare('SELECT id FROM memories LIMIT 3').all();
    counter.stop();
    const after = counter.snapshot();
    // ⚠️ ★ **核心断言**：命中零来源的行数 > 0（⇒ 口径不完整这件事**暴露出来了**）。
    expect(after.unclassifiedRows - before.unclassifiedRows).toBe(3);
    // ⚠️ ★ **指纹必须被记下**（⇒ 读的人能知道是哪条 SQL 没被认领）。
    expect(after.unclassifiedSqlKinds.length).toBeGreaterThan(0);
    expect(after.unclassifiedSqlKinds.some((kind) => kind.includes('memories'))).toBe(true);
    // ⚠️ ★★ **两个结论必须「分得干净」**（这是「双结论模型」的核心性质）：
    //   · **legacy 侧照旧计数**（`candidateRows` = 物化了几行就计几行 ⇒ **逐位复现旧行为**
    //     ⇒ ⇒ `docs/baseline/*.json` 的 R6 `candidateReadRows` **不断档**）；
    //   · **字节侧一个字节都不认领**（⇒ 命中零来源 ⇒ 落进 `unclassified` ⇒ **判红**）。
    expect(after.candidateRows - before.candidateRows).toBe(3);
    expect(after.bytesRead - before.bytesRead).toBe(0);
    expect(after.embeddingRowsRead - before.embeddingRowsRead).toBe(0);
    counter.uninstall();
    db.db.close();
  });

  it('★ 落盘结构：两个容器 + 四个读数 + breakdown 13 项（**键名一个都不许少**）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    // ⚠️ ★ **两个分段容器**（写路径在 `writeSegments` 下、读路径在**顶层**）。
    expect(result.writeSegments.vectorByteReads).toBeDefined();
    expect(result.vectorRouteByteReads).toBeDefined();
    // ⚠️ ★ **顶层容器【不进】`recallVectorPath`**（那是「整条召回的 old vs new 时序对比」）。
    expect(
      (result.recallVectorPath as unknown as Record<string, unknown>).vectorByteReads,
    ).toBeUndefined();
    // ⚠️ ★ **四个读数用 ADR §8.5 的原名**（不另立名字 ⇒ 读旧 JSON 的人对得上账）。
    for (const block of [result.writeSegments.vectorByteReads, result.vectorRouteByteReads]) {
      expect(Object.keys(block)).toEqual(
        expect.arrayContaining([
          'memoryRowsRead',
          'codeRowsRead',
          'bytesRead',
          'candidateUniverse',
          'breakdown',
          'note',
        ]),
      );
      // ⚠️ ★ **形态 = `CountSummary` 分布**（不是标量 ⇒ 判据取 `max` 有值可取）。
      for (const key of ['memoryRowsRead', 'codeRowsRead', 'bytesRead', 'candidateUniverse']) {
        const summary = block[key as 'bytesRead'];
        expect(Object.keys(summary).sort()).toEqual(
          ['count', 'max', 'mean', 'min', 'p50', 'p99'].sort(),
        );
      }
      // ⚠️ ★ **breakdown 的 13 项**（口径 §4 的表里列了 12 项 ⇒ ⇒ 本轮多落了
      //   `embeddingExactRows` ⇒ ⇒ **断言必须把它写进来** ⇒ ⇒ 否则它「悄悄消失」也不被发现
      //   —— `arrayContaining` **不是精确匹配** ⇒ ⇒ 漏写一个键就等于这条断言变弱）。
      expect(Object.keys(block.breakdown)).toEqual(
        expect.arrayContaining([
          'codeBytes',
          'embeddingBytes',
          'contentBytes',
          'embeddingRowsRead',
          'embeddingExactRows',
          'embeddingCalls',
          'narrowRowsRead',
          'bucketMemberRows',
          'badCodeRows',
          'unclassifiedRows',
          'unclassifiedSqlKinds',
          'pruneRate',
          'samplesAligned',
        ]),
      );
    }
    // ⚠️ ★ **旧键一个都没动**（`vectorCandidateRows` / `vectorCandidateScan` / `writeTotal` …）。
    expect(result.writeSegments.vectorCandidateRows).toBeDefined();
    expect(result.writeSegments.vectorCandidateScan).toBeDefined();
    expect(result.writeSegments.writeTotal).toBeDefined();
    db.db.close();
  });

  it('★ 落盘 note 必须含**六件事**（口径 §4 验收标准 6）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const note = result.writeSegments.vectorByteReads.note;
    // ① 只计向量载荷。
    expect(note).toContain('向量载荷');
    // ② 是真实搬运量的**下界** ⇒ 判据偏严、不会假绿。
    expect(note).toContain('下界');
    // ③ ADR §8.6 那个 4.44 MB 也是**下界**（实测大于它不是回归）。
    expect(note).toContain('4.44 MB');
    expect(note).toContain('下界');
    // ④ H1′ 判的是**哪一笔**（写入扫描独立实测段 · 不是 `store.write()` 内部那一笔）。
    expect(note).toContain('H1′');
    expect(note).toContain('collectVectorCandidates');
    // ⑤ 剪枝率分子与 `exactReads` 的**等价性前提**（只在两段式分支成立）。
    expect(note).toContain('exactReads');
    expect(note).toContain('两段式');
    // ⑥ 计时口径（写路径 = 两轮制 ⇒ 计量在计时窗口之外 ⇒ 与历史基线逐位可比）。
    expect(note).toContain('两轮');
    expect(note).toContain('计时窗口');
    // ⚠️ ★ **旧行数判据已降级**（note 里必须写明它不再是判据）。
    expect(note).toContain('降级');
    db.db.close();
  });

  it('★ 读路径 note 必须写明「**单轮** + 字节与毫秒同源 + 同量级而非逐位」', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const note = result.vectorRouteByteReads.note;
    // ⚠️ ★ **裁决第 1 号的落点**：读路径 = 单轮（与 HEAD 逐字同形）⇒ 字节与毫秒同源。
    expect(note).toContain('单轮');
    expect(note).toContain('同一个计时窗口');
    // ⚠️ ★ **开销口径必须诚实**：同量级而非逐位 + 可忽略（< 1%）。
    expect(note).toContain('同量级而非逐位');
    expect(note).toContain('< 1%');
    // ⚠️ ★ **读路径不判门槛**（判据量在写路径那侧）。
    expect(note).toContain('不判门槛');
    db.db.close();
  });

  it('★ 剪枝率 = `embeddingCalls ÷ candidateUniverse`（判定取 max）且阈值常量在', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const writes = result.writeSegments.vectorByteReads;
    expect(writes.breakdown.pruneRate.count).toBe(writes.bytesRead.count);
    expect(writes.breakdown.pruneRate.max).toBeGreaterThanOrEqual(0);
    // ⚠️ ★ **阈值常量必须存在**（口径 §5：0.15）。
    expect(THRESHOLDS.pruneRateMax).toBe(0.15);
    // ⚠️ ★ **字节阈值的常量也必须在**（H1′ = 6,144,000 B / H2′ = 0.2%）。
    expect(THRESHOLDS.bytesReadMax).toBe(6_144_000);
    expect(THRESHOLDS.bytesReadRatioMax).toBe(0.002);
    // ⚠️ ★ **旧行数常量不许删**（降级 ≠ 删常量 ⇒ 否则「同一个门槛两个名字」）。
    expect(THRESHOLDS.candidateReadRowsMax).toBe(2000);
    expect(THRESHOLDS.candidateReadRowsRatioMax).toBe(0.002);
    db.db.close();
  });
});
