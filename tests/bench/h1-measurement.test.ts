/**
 * **H1 口径加固 + 门槛归口 + 页缓存状态标注** 的门禁
 * （2026-11-02 架构师裁决的落地 · 2026-11-03 的 `D10` 归口）。
 *
 * ⚠️ ★ **本文件守的是「判据本身的可信性」** —— 不是「性能达标」：
 *   · **R6（`RECALL_VEC_ROWS`）的取数量必须是「生产 SQL 实际物化的行数」（实测）**，
 *     **不是**「命中桶成员数之和」（推算 ⇒ **模型化了「桶内不设 LIMIT」这个实现**）
 *     ⇒ ⇒ 否则阶段 4 一旦引入「桶内 LIMIT」/「两段式读」，真实读的行数会降、
 *     **读数却还红** ⇒ ⇒ **看不出「阶段 4 收官」**；
 *   · ★ **H1/H2 的判据量必须是「写入去重路径」那一个**（`writeSegments.vectorCandidateRows`，
 *     写入探针 8/20）⇒ **不是**召回路径的同名量（`candidateReadRows`，探针 20/50）
 *     ⇒ ⇒ 2026-11-03 之前这里是「同一件事两套词」：一个**召回侧**的量去撞**写入侧**的门槛；
 *   · **页缓存状态必须能被机器读出来**（`cold` / `warm` / `unknown`）
 *     ⇒ 冷 / 热两档的毫秒数**差 21.6 倍** ⇒ 这个区分不能只靠人记。
 *
 * ⚠️ **为什么这些断言值得存在**（本仓库的纪律：判据要可被变异打红）：
 *   · 把 `installRowReadCounter()` 换回「推算口径」⇒ 第 ① 条会红
 *     （推算 ≠ 实测这件事，在**实现变了**的时候才暴露 ⇒ 平时看不出来）；
 *   · 把 H1 的判据量换回 `candidateReadRows` ⇒ 「归口」那一组的断言会红
 *     （见文件末尾 `describe('★ 门槛归口（D10）…')`；
 *   · 把 `--cache-state` 的缺省从 `unknown` 改成 `cold` ⇒ 第 ③ 条会红
 *     （**不许猜** —— 猜出来的档位比没有档位更坏）。
 *
 * ⚠️ **规模故意很小（1500 条）** ⇒ 门禁要在**几十秒内**跑完。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import { DEFAULT_CORPUS_OPTIONS, generateQueries } from '../../bench/corpus.js';
import { prepareBench } from '../../bench/lib/db.js';
import { installRowReadCounter, parsePageCacheState } from '../../bench/lib/harness.js';
import {
  GATE_REGROUPING,
  type PerfResult,
  THRESHOLDS,
  checkPerf,
  formatRecallVecRowsObservation,
  measurePerf,
} from '../../bench/perf.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { countBucketMembers } from '../../src/vector/bucketAssign.js';
import { loadCentroidModel } from '../../src/vector/centroids.js';
import { IvfVectorBackend } from '../../src/vector/ivf.js';

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
  const dbPath = join(dir, 'h1-measurement.db');
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
  return mkdtempSync(join(tmpdir(), 'memory-ocean-h1-measurement-'));
}

describe('R6（召回路径）口径加固 · 实测读行数（不再模型化「桶内不设 LIMIT」）', () => {
  it('★ 实测候选行读数 == 推算值（命中桶成员数之和）⇒ 当前实现下两者相等', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const model = loadCentroidModel(db.db);
    const backend = new IvfVectorBackend({
      db: db.db,
      centroids: () => model,
      nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
      nprobeFine: DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
    });
    backend.init({
      dimensions: DEFAULT_PARAMS.EMBED_DIM,
      coarseCenters: DEFAULT_PARAMS.ROUTER_COARSE_CENTERS,
      fineCenters: DEFAULT_PARAMS.ROUTER_FINE_CENTERS,
    });
    const counter = installRowReadCounter(db.db);
    const queries = generateQueries({ ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE }, 3);
    for (const query of queries) {
      const fineIds = backend.route(
        query.embedding,
        DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
        DEFAULT_PARAMS.ROUTER_NPROBE_FINE,
      );
      // ⚠️ **推算口径**：命中细桶的成员数之和（**模型化了「桶内不设 LIMIT」**）。
      let derived = 0;
      for (const fineId of fineIds) {
        derived += countBucketMembers(db.db, fineId);
      }

      // ⚠️ **实测口径**：生产 SQL **实际物化**了多少候选行。
      const before = counter.snapshot();
      counter.start();
      backend.search(query.embedding, DEFAULT_PARAMS.VECTOR_TOPK);
      counter.stop();
      const after = counter.snapshot();
      const measured = after.candidateRows - before.candidateRows;

      // ⚠️ ★ **核心断言（T04 起改口径）**：
      //   **T04 之前**这一条是 `measured === derived`（「桶内不设 LIMIT ⇒ 全量物化」）。
      //   **T04 之后**两段式剪枝只物化 survivors ⇒ 实测**必然小于**推算
      //   （推算模型化的正是「把整个桶读回来」这个**已不存在的实现**）。
      //   ⇒ 现在的性质是**方向 + 上界**：
      //     ① 实测 ≤ 推算（剪枝只会读更少，**不可能**读更多）；
      //     ② 实测 > 0（真的读了东西，不是「两边都空」的真空断言）；
      //     ③ 判据量仍然取**实测**（`candidateReadRows`）—— 那一条由下一节的门槛测试钉死。
      expect(measured).toBeLessThanOrEqual(derived);
      expect(measured).toBeGreaterThan(0);
      // ⚠️ **桶成员侧的行读**也要被抓到（⇒ 分类器没把两张表搞混）。
      expect(after.bucketMemberRows - before.bucketMemberRows).toBeGreaterThan(0);
    }
    counter.uninstall();
    db.db.close();
  });

  it('★ 计数只在采集窗口内累积（窗口外读的行数不计入）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    // ⚠️ **窗口外**：直接查一行 ⇒ 不该被计数。
    db.db.prepare('SELECT COUNT(*) AS count FROM vector_cell_members').get();
    const after = counter.snapshot();
    expect(after.candidateRows).toBe(before.candidateRows);
    expect(after.bucketMemberRows).toBe(before.bucketMemberRows);
    counter.uninstall();
    db.db.close();
  });

  it('★ `uninstall()` 把 `db.prepare` 恢复原状（bench 不许给生产句柄留残桩）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    const original = db.db.prepare;
    const counter = installRowReadCounter(db.db);
    expect(db.db.prepare).not.toBe(original);
    counter.uninstall();
    expect(db.db.prepare).toBe(original);
    // ⚠️ **恢复之后生产调用照常**（⇒ 装桩没有破坏语句对象）。
    const row = db.db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number };
    expect(row.count).toBeGreaterThan(0);
    db.db.close();
  });

  it('★ `measurePerf` 的 R6 口径声明是「实测」，且推算对照值一并落盘', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    // ⚠️ ★ **口径必须是「实测」**（⇒ 读 JSON 的人不会把它误读成推算）。
    expect(result.candidateReadRowsBasis.mode).toBe('measured');
    expect(result.candidateReadRowsBasis.note).toContain('measured');
    // ⚠️ ★ **口径声明里必须写明「本块 = R6，不判门槛」**
    //   ⇒ 否则读 JSON 的人只看到「measured」⇒ 会以为它还在判 H1。
    expect(result.candidateReadRowsBasis.note).toContain('R6');
    expect(result.candidateReadRowsBasis.note).toContain('不设门槛');
    // ⚠️ **推算对照值必须也在**（⇒ 「实测 vs 推算」的差可见）。
    expect(result.candidateReadRowsBasis.derivedCrossCheck).not.toBeNull();
    expect(result.candidateReadRowsBasis.derivedCrossCheck?.count).toBe(
      result.candidateReadRows.count,
    );
    // ⚠️ **桶成员侧的行读**（附加信息）也落盘。
    expect(result.candidateReadRowsBasis.bucketMemberRowsRead?.count).toBe(
      result.candidateReadRows.count,
    );
    // ⚠️ **观测值本身**：样本非零 ⇒ 不是真空通过（虽然它不判门槛）。
    expect(result.candidateReadRows.count).toBe(5);
    expect(result.candidateReadRows.max).toBeGreaterThan(0);
    db.db.close();
  });

  it('★ 阈值块的键名与数值一个都没改（归口只改主语，不改门槛）', () => {
    // ⚠️ ★ **这条是「归口 ≠ 改门槛」的机器可核证据**：
    //   键名一改 ⇒ 读旧 JSON / 旧脚本的人对不上账 ⇒ 「同一个门槛两个名字」。
    //   数值一改 ⇒ 那就不是归口，是**放宽门槛**（本轮明令禁止）。
    expect(THRESHOLDS.candidateReadRowsMax).toBe(2000);
    expect(THRESHOLDS.candidateReadRowsRatioMax).toBe(0.002);
    // ⚠️ **键名仍在**（`Object.keys` 断言 ⇒ 改名会被这条抓到）。
    expect(Object.keys(THRESHOLDS)).toContain('candidateReadRowsMax');
    expect(Object.keys(THRESHOLDS)).toContain('candidateReadRowsRatioMax');
  });

  it('★ H2′ 违规行**必须写明主语是「写入去重路径」**（小规模下 H2′ 必然红 ⇒ 这条总能被验到）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const failures = checkPerf(result);
    // ⚠️ **为什么这里断言非空**：H2′ 是**规模无关写法**（≤ 0.2%）⇒
    //   1,500 条的小库上「向量载荷字节 ÷（库规模 × 3,072 B）」必然远超 0.2% ⇒ **H2′ 本轮一定红**
    //   ⇒ ⇒ 于是「H2′ 的文案对不对」这件事**每一轮都能被验到**（不是碰运气）。
    // ⚠️ ★ **标签是 `（H2′）`**（T06 起字节口径）⇒ **旧标签 `（H2）` 一个都不许再出现在清单里**
    //   （断言 5 会独立守这一条）。
    const h2Failures = failures.filter((failure) => failure.includes('（H2′）'));
    expect(h2Failures.length).toBeGreaterThan(0);
    for (const failure of h2Failures) {
      expect(failure).toContain('写入去重路径');
      expect(failure).toContain('写入');
      // ⚠️ 判据量的**字段路径**必须点名（⇒ 读的人不用回头翻文档）。
      expect(failure).toContain('writeSegments.vectorByteReads.bytesRead');
    }
    db.db.close();
  });

  it('★ H1′ 判红时违规清单里**带上口径与探针配置**（不许让人误以为它判的是召回路径）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const failures = checkPerf(result);
    // ⚠️ ★ **标签是 `（H1′）`**（字节口径）⇒ 旧的 `（H1）` 已经**不是**判据了。
    const h1Failures = failures.filter((failure) => failure.includes('（H1′）'));
    // ⚠️ **小规模下 H1′ 不一定超门槛** ⇒ 两种情况都要说得清：
    //   超了 ⇒ 清单里必须带口径 + 主语 + 探针；没超 ⇒ 清单里不许出现 H1′ 判红。
    for (const failure of h1Failures) {
      expect(failure).toContain('口径');
      expect(failure).toContain('写入去重路径');
      expect(failure).toContain('探针 8/20');
    }
    db.db.close();
  });
});

describe('页缓存状态标注（冷 / 热 / 未知 —— 可标注，不可测量）', () => {
  it('★ 缺省是 `unknown` 且 `declared = false`（不许猜）', () => {
    const info = parsePageCacheState(undefined);
    expect(info.state).toBe('unknown');
    expect(info.declared).toBe(false);
    expect(info.source).toBe('none');
    expect(info.note).toContain('不许猜');
  });

  it('★ 显式声明 `cold` / `warm` ⇒ 落进 JSON 且标明「由跑的人声明」', () => {
    for (const state of ['cold', 'warm'] as const) {
      const info = parsePageCacheState(state);
      expect(info.state).toBe(state);
      expect(info.declared).toBe(true);
      expect(info.source).toBe('cli:--cache-state');
      expect(info.note).toContain('由跑的人声明');
    }
  });

  it('★ 声明的那一档要**带判档的可复算旁证**（⇒ 声明不再纯主观）', () => {
    for (const state of ['cold', 'warm'] as const) {
      const info = parsePageCacheState(state);
      // ⚠️ ★ **旁证必须落在 note 里**（⇒ 读 JSON 的人能自证「这一档是怎么判的」）。
      expect(info.note).toContain('顺序读吞吐');
      // ⚠️ ★★ **旁证必须指向 `storageMedia` 那块盘的「名义带宽」，且不许写死具体盘速**（2026-11-04 改）：
      //   旧版在这里断言 `toContain('166 MB/s')` —— 那是**一台 SATA HDD 的实测值**，
      //   而同一份 JSON 的 `storageMedia` 早已是 `SSD | NVMe | WD Blue SN570` ⇒
      //   **落盘的 note 与落盘的介质字段自相矛盾**（基线自己说谎，且会被后人引用）。
      //   ⇒ 现在断言的是**方法**（比名义带宽）与**不许写死**这条纪律，而不是某一个数字。
      expect(info.note).toContain('名义顺序读带宽');
      expect(info.note).toContain('storageMedia');
      expect(info.note).toMatch(/刻意不写具体盘速/);
      expect(info.note).not.toMatch(/\d{2,4}\s*MB\/s/);
      // ⚠️ **但它仍然只是「声明」**（⇒ 语义不许被旁证改成「测量」）。
      expect(info.declared).toBe(true);
      expect(info.note).toContain('由跑的人声明');
    }
    // ⚠️ **缺省那一档也要告诉人「怎么才能变成可判的」**（⇒ 不许只说「不可知」就完）。
    expect(parsePageCacheState(undefined).note).toContain('--cache-state=cold|warm');
  });

  it('★ 显式声明 `unknown` ⇒ 状态仍是 `unknown`，但 `declared = true`', () => {
    const info = parsePageCacheState('unknown');
    expect(info.state).toBe('unknown');
    expect(info.declared).toBe(true);
  });

  it('★ 非法值 ⇒ 报错（不静默钳制 ⇒ 否则「档位」是假的）', () => {
    expect(() => parsePageCacheState('coldish')).toThrow(/--cache-state/);
    expect(() => parsePageCacheState('COLDISH')).toThrow(/--cache-state/);
    expect(() => parsePageCacheState('')).toThrow(/--cache-state/);
  });

  it('★ 大小写与首尾空白宽容（`COLD` / ` warm ` ⇒ 认）', () => {
    expect(parsePageCacheState('COLD').state).toBe('cold');
    expect(parsePageCacheState(' warm ').state).toBe('warm');
  });
});

/**
 * ★★★ **两条「有牙」的守卫**（2026-11-02 主理人验收后补）。
 *
 * ⚠️ ★ **为什么上一轮的 10 条断言抓不到「口径被换掉」**（**本仓库的老坑，值得记住**）：
 *   上一轮的核心断言是「**实测 == 推算**」这个恒等式
 *   ⇒ 而**当前实现下两者本来就相等** ⇒ ⇒ **任何以「当前实现下的具体数值」为断言的测试，
 *   对「两个来源被调换」这类变异天然失明**
 *   ⇒ ⇒ 两个变异（① `mode` 恒为 `measured`；② `candidateReadRows` 取推算值）**都跑绿**。
 * ⇒ ⇒ **教训（进自查清单）**：**新增断言时先想「什么变异会让它变红」，再写它**
 *   ⇒ **想不出 ⇒ 那条断言可能就是恒绿的**。
 *
 * ⚠️ ★ **本文件两条守卫的分工**：
 * · **守卫一**：制造「**计数器失效**」⇒ 断言 **兜底把 `mode` 标成 `derived`**
 *   ⇒ **专打变异 ①**（`mode` 恒为 `measured`）；
 * · **守卫二**：制造「**实测 ≠ 推算**」⇒ 断言 **判据量跟着实测走**
 *   ⇒ **专打变异 ②**（`candidateReadRows` 取推算值）。
 */

// ── ★ **制造「实测 ≠ 推算」的场景**（守卫二的注入点）──────────────────────────
/**
 * 在**每个细桶**里塞一条**软删**的记忆（`deleted = 1`）并给它挂上桶归属。
 *
 * ⚠️ ★ **为什么这个场景是「生产真实状态」而不是人造的**：
 *   `DESIGN-v2.md` §8.2：**软删记忆保留向量、也保留桶归属**（§9.3.2 ② 明确「软删不删桶归属」）
 *   ⇒ ⇒ **桶成员里坐着软删行，是生产里真实存在的状态**
 *   ⇒ ⇒ **而这正是「推算」与「实测」两个口径的真实差异所在**：
 *   · **推算**（`countBucketMembers`）= 桶里的**全部成员**（**含软删**）；
 *   · **实测**（候选 SQL 物化的行）= `deleted = 0 AND embedding IS NOT NULL` 的**候选行**（**不含软删**）。
 *
 * @param db 库句柄
 * @returns 塞进去的软删行条数（= 细桶数）
 */
function insertSoftDeletedMembers(db: Database.Database): number {
  const fineIds = (
    db.prepare('SELECT fine_id FROM vector_fine_cells ORDER BY fine_id').all() as Array<{
      fine_id: string;
    }>
  ).map((row) => row.fine_id);
  const now = 1_700_000_000_000;
  const insertMemory = db.prepare(
    'INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding, ' +
      'stability, difficulty, created_at, last_access, deleted, deleted_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
  );
  const insertMember = db.prepare(
    'INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)',
  );
  // ⚠️ **给它一个合法的向量**（3072 字节）⇒ ⇒ 它被排除**只因为 `deleted = 1`**
  //   （⇒ 守卫考的就是「软删」这一条 ⇒ 不是「向量缺失」那条）。
  const embedding = new Float32Array(DEFAULT_PARAMS.EMBED_DIM);
  embedding[0] = 1;
  const embeddingBlob = Buffer.from(embedding.buffer);
  for (const fineId of fineIds) {
    const id = `soft-deleted-${fineId}`;
    insertMemory.run(
      id,
      'fact',
      `软删测试行 ${id}`,
      `软删 测试 行 ${id}`,
      `hash-${id}`,
      embeddingBlob,
      1,
      0.5,
      now,
      now,
      now,
    );
    insertMember.run(fineId, id);
  }
  return fineIds.length;
}

describe('★ 两条「有牙」的守卫（防「口径被悄悄换掉」）', () => {
  it('★ 守卫一：计数器失效 ⇒ R6 兜底把 `mode` 标成 `derived`，而**行数判据量照旧**', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    // ⚠️ ★ **注入「计数器装了但不计数」** ⇒ 实测值恒为 0 ⇒ R6 的兜底必须接手。
    const result = measurePerf(db.db, store, options, 5, 5, { disableRowReadCounter: true });
    // ⚠️ ★ **这条断言专打「`mode` 恒为 `measured`」那个变异**。
    expect(result.candidateReadRowsBasis.mode).toBe('derived');
    expect(result.candidateReadRowsBasis.note).toContain('推算');
    // ⚠️ **R6 的取数必须退回到推算值**（⇒ 有值 ⇒ 不是「真空通过」）。
    expect(result.candidateReadRowsBasis.derivedCrossCheck?.max).toBeGreaterThan(0);
    expect(result.candidateReadRows.max).toBe(result.candidateReadRowsBasis.derivedCrossCheck?.max);
    // ⚠️ ★★ **2026-11-03 归口后的新断言（比原来更强，不是迁就）**：
    //   原断言是「H1 违规行里必须出现『推算』」—— 那是**旧口径**（H1 用滚动计数器取数）的产物。
    //   归口后行数判据量的取数是 `writeSegments.vectorCandidateRows`（**不经过这个计数器**）
    //   ⇒ ⇒ 正确的新断言是：**计数器被打残，行数判据量也必须完全不受影响**
    //   ⇒ ⇒ 若哪天有人把行数判据又改回读 `candidateReadRows`，这条会红（R6 那一侧被清成推算值/0）。
    expect(result.writeSegments.vectorCandidateRows.count).toBe(5);
    expect(result.writeSegments.vectorCandidateRows.max).toBeGreaterThan(0);
    // ⚠️ ★★★ **T06 的字节判据（H1′）**：计数器被打残 ⇒ **字节账恒为 0**
    //   ⇒ ⇒ **H1′ 必须判红（真空通过）**（这是**正确**的行为：判据量被打残 ⇒ 不许静默通过）
    //   ⇒ ⇒ ⚠️ **与行数判据相反**（行数判据量来自生产返回值 ⇒ 不受计数器影响）⇒ 这是两条不同的账。
    expect(result.writeSegments.vectorByteReads.bytesRead.max).toBe(0);
    const failures = checkPerf(result);
    const h1PrimeFailure = failures.find((failure) => failure.includes('（H1′）'));
    expect(h1PrimeFailure).toBeDefined();
    expect(h1PrimeFailure).toContain('真空通过');
    // ⚠️ ★ **旧标签 `（H1）` 不许再出现**（否则断言 5 的「过滤串失效」就要判红了）。
    expect(failures.some((failure) => failure.includes('（H1）'))).toBe(false);
    db.db.close();
  });

  it('★ 守卫二：实测 ≠ 推算时，判据量必须跟着**实测**走（不是跟着推算走）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    // ⚠️ ★ **制造「实测 ≠ 推算」**：每个细桶塞一条软删成员
    //   ⇒ **推算**（桶成员数之和）**含**它、**实测**（候选行）**不含**它。
    const softDeletedCount = insertSoftDeletedMembers(db.db);
    expect(softDeletedCount).toBeGreaterThan(0);

    const result = measurePerf(db.db, store, options, 5, 5);
    // ⚠️ **前提**：这一轮两个口径**确实不相等**（否则下面的断言是恒绿的 ⇒ 没有牙）。
    const derived = result.candidateReadRowsBasis.derivedCrossCheck;
    expect(derived).not.toBeNull();
    expect((derived?.mean ?? 0) - result.candidateReadRows.mean).toBeGreaterThan(0);

    // ⚠️ ★★ **核心断言（T04 起改口径）**：
    //   **T04 之前**差值恰好 = 命中细桶数（每个命中桶恰好多一条软删成员）。
    //   **T04 之后**两段式剪枝**又少读了一批**（只读 survivors）⇒ 差值 = 软删成员 + 被剪掉的成员
    //   ⇒ 性质从「相等」变成「**≥ 命中细桶数**」。
    //   ⇒ ⇒ 这一条仍然专打「`candidateReadRows` 取推算值」那个变异：
    //      该变异下差值为 0，而 `hitFineBuckets.mean > 0` ⇒ `0 ≥ n` 不成立 ⇒ **必红**。
    expect((derived?.mean ?? 0) - result.candidateReadRows.mean).toBeGreaterThanOrEqual(
      result.hitFineBuckets.mean - 1e-6,
    );
    // ⚠️ **口径声明仍然是「实测」**（⇒ 这一轮计数器是好的 ⇒ 不许退回推算）。
    expect(result.candidateReadRowsBasis.mode).toBe('measured');
    db.db.close();
  });
});

/**
 * ★★★ **门槛归口（`D10` · 2026-11-03）的门禁** —— 本组断言守的是**「谁被考核」**。
 *
 * ⚠️ ★ **为什么这一组必须存在**（它是本轮改动唯一能被打红的地方）：
 *   改前 H1 判 `candidateReadRows`（召回探针 20/50）、改后判
 *   `writeSegments.vectorCandidateRows`（写入探针 8/20）——
 *   **两个字段都还在、都还有值、都不为 0** ⇒ ⇒ **任何只看「有没有数」的断言对这次改动天然失明**。
 *   ⇒ ⇒ 所以这里用**伪造一份 `PerfResult`**（把一个字段推到离谱的大、另一个保持原样）
 *   来问「判定到底读了哪一个字段」——**这是唯一能分辨两者的问法**。
 *
 * ⚠️ **伪造而不是造真数据**：要让写入路径真的超过 2,000 行，得灌几万条语料（几分钟）；
 *   而这里要验的是**判定逻辑**，不是性能 ⇒ 伪造输入是最小、最快、最精准的手段
 *   （`checkPerf()` 是纯函数 ⇒ 伪造完全合法，不改任何生产行为）。
 */
describe('★ 门槛归口（D10）：H1/H2 判写入去重路径，召回同名量降为 R6 观测值', () => {
  /** ★ **伪造的写入侧字节数**（T06 起 H1′/H2′ 的判据量；**故意取得与任何真实读数都不撞**）。 */
  const FORGED_WRITE_BYTES = 987_654_321;
  /** ★ **伪造的召回侧字节数**（**与写入侧的刻意不同** ⇒ 才分得清判定读了谁）。 */
  const FORGED_RECALL_BYTES = 123_456_789;

  it('★ H1′/H2′ 的判据量 = `writeSegments.vectorByteReads.bytesRead.max`（不是召回侧的字节）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const base = measurePerf(db.db, store, options, 5, 5);
    // ⚠️ **前提**：字节账必须是**真的有样本**（否则下面全是「真空通过」分支 ⇒ 测不到判据量）。
    expect(base.writeSegments.vectorByteReads.bytesRead.count).toBeGreaterThan(0);
    expect(base.writeSegments.vectorByteReads.bytesRead.max).toBeGreaterThan(0);
    expect(base.vectorRouteByteReads.bytesRead.count).toBeGreaterThan(0);
    expect(base.vectorRouteByteReads.bytesRead.max).toBeGreaterThan(0);
    // ⚠️ **前提**：写入侧与召回侧的字节读数**真的不同**（探针 8/20 vs 20/50）
    //   ⇒ ⇒ 若两者恰好相等，下面的断言就无法分辨「读了哪一个」⇒ 没有牙。
    expect(base.writeSegments.vectorByteReads.bytesRead.max).not.toBe(
      base.vectorRouteByteReads.bytesRead.max,
    );

    // ① **把写入路径那个字节数推过门槛** ⇒ H1′/H2′ 必须红，且文案里出现的是**这个**数。
    const forcedWrite: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...base.writeSegments.vectorByteReads,
          bytesRead: { ...base.writeSegments.vectorByteReads.bytesRead, max: FORGED_WRITE_BYTES },
        },
      },
    };
    const writeFailures = checkPerf(forcedWrite);
    const h1 = writeFailures.filter((failure) => failure.includes('（H1′）'));
    const h2 = writeFailures.filter((failure) => failure.includes('（H2′）'));
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(1);
    expect(h1[0]).toContain(String(FORGED_WRITE_BYTES));
    expect(h1[0]).toContain('写入去重路径');
    expect(h2[0]).toContain(String(FORGED_WRITE_BYTES));
    // ⚠️ ★ **判据量的字段路径必须点名**（⇒ 读的人不用回头翻文档）。
    expect(h1[0]).toContain('writeSegments.vectorByteReads.bytesRead');
    // ⚠️ ★ **反向**：H1′/H2′ 的文案里**不许出现召回路径那个字节数**（⇒ 判定没读它）。
    expect(h1[0]).not.toContain(String(FORGED_RECALL_BYTES));
    expect(h2[0]).not.toContain(String(FORGED_RECALL_BYTES));

    // ② **把召回路径的字节数推到离谱量级** ⇒ **H1′/H2′ 的结论一个字都不许变**
    //   ⇒ ⇒ 这条专打「H1′ 又改回读 `vectorRouteByteReads`」那个变异。
    //   ⚠️ **为什么用「与 base 逐条相同」而不是「断言为空」**：
    //     H2′ 是**规模无关写法**（≤ 0.2%）⇒ 1,500 条的小库上它**必然红**（与召回侧无关）
    //     ⇒ 断言「为空」会把「H2′ 本来该红」误判成失败 ⇒ ⇒ 正确的问法是**「判定对这个字段免疫」**。
    const h1h2Of = (failures: readonly string[]): string[] =>
      failures.filter((failure) => failure.includes('（H1′）') || failure.includes('（H2′）'));
    const baseH1H2 = h1h2Of(checkPerf(base));
    const forcedRecall: PerfResult = {
      ...base,
      vectorRouteByteReads: {
        ...base.vectorRouteByteReads,
        bytesRead: { ...base.vectorRouteByteReads.bytesRead, max: FORGED_RECALL_BYTES },
      },
    };
    const recallFailures = checkPerf(forcedRecall);
    expect(h1h2Of(recallFailures)).toEqual(baseH1H2);
    expect(recallFailures.some((failure) => failure.includes(String(FORGED_RECALL_BYTES)))).toBe(
      false,
    );
    db.db.close();
  });

  it('★ 写入路径的字节样本数为 0 ⇒ H1′ 是**真空通过**（必须判出来，不许静默通过）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const base = measurePerf(db.db, store, options, 5, 5);
    const emptySummary = { count: 0, min: 0, mean: 0, p50: 0, p99: 0, max: 0 };
    // ⚠️ **0 个样本** ⇒ 判据无从谈起 ⇒ 必须红（不是「0 字节 ⇒ 达标」）。
    const empty: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...base.writeSegments.vectorByteReads,
          bytesRead: { ...base.writeSegments.vectorByteReads.bytesRead, ...emptySummary },
        },
      },
    };
    const failures = checkPerf(empty);
    const h1 = failures.filter((failure) => failure.includes('（H1′）'));
    expect(h1).toHaveLength(1);
    expect(h1[0]).toContain('真空通过');
    // ⚠️ **恒为 0 但有样本** ⇒ 同样是真空通过（向量路在写入路径整路缺席）。
    const allZero: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...base.writeSegments.vectorByteReads,
          bytesRead: {
            ...base.writeSegments.vectorByteReads.bytesRead,
            count: 5,
            min: 0,
            mean: 0,
            p50: 0,
            p99: 0,
            max: 0,
          },
        },
      },
    };
    const zeroFailures = checkPerf(allZero);
    const zeroH1 = zeroFailures.filter((failure) => failure.includes('（H1′）'));
    expect(zeroH1).toHaveLength(1);
    expect(zeroH1[0]).toContain('向量路在写入路径整路缺席');
    db.db.close();
  });

  /**
   * ★★★ **断言 5（过滤串失效守卫 · 两头锁死）**。
   *
   * ⚠️ ★ **为什么这条必须存在**（口径 §5 末条 + 施工规格 T06-4 验收标准 6）：
   *   H1/H2 改成 H1′/H2′ 之后，**旧的过滤串 `（H1）` / `（H2）` 一个都匹配不上任何违规行**
   *   ⇒ ⇒ 那些「靠过滤串找到违规行」的断言**全部变成恒绿 = 没牙**
   *   ⇒ ⇒ **必须有一条断言专门守「过滤串没有失效」**。
   *
   * ⚠️ ★ **两头锁死**（缺一头就等于没守）：
   *   ① **旧标签行**（`（H1）` / `（H2）`）⇒ 断言它**不**被新过滤串命中
   *     （⇒ 改名这件事**真的生效了**；否则新旧串会互相命中 ⇒ 改名是假的）；
   *   ② **新标签行**（`（H1′）` / `（H2′）`）⇒ 断言它**确实**被新过滤串命中
   *     （⇒ 新过滤串**不是恒空的**；否则「旧串不匹配」可能只是因为「新串也匹配不上」）。
   *
   * ⚠️ ★ **为什么用「伪造的 `bytesRead.max`」**（而不是造真数据）：
   *   `checkPerf()` 是**纯函数** ⇒ 伪造输入完全合法、不改任何生产行为；
   *   而这条要验的是**判定逻辑**，不是性能 ⇒ 伪造是最小、最快、最精准的手段。
   */
  it('★ 断言 5：旧过滤串 `（H1）`/`（H2）` 失效 **且** 新过滤串 `（H1′）`/`（H2′）` 有效（两头锁死）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const base = measurePerf(db.db, store, options, 5, 5);

    // ⚠️ ★ **造一条真的违规行**（伪造写入侧字节 ⇒ H1′/H2′ 必红）⇒ 拿它当「新标签行」的样本。
    const forced: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...base.writeSegments.vectorByteReads,
          bytesRead: { ...base.writeSegments.vectorByteReads.bytesRead, max: FORGED_WRITE_BYTES },
        },
      },
    };
    const forcedFailures = checkPerf(forced);
    const newTagFailures = forcedFailures.filter(
      (failure) => failure.includes('（H1′）') || failure.includes('（H2′）'),
    );
    // ⚠️ **前提**：新标签的违规行必须**确实存在**（否则下面两条都是空断言 ⇒ 没牙）。
    expect(newTagFailures.length).toBeGreaterThan(0);

    // ── ② **新标签行**：确实进 `failures` **且** 确实被新过滤串命中 ──
    expect(forcedFailures.filter((failure) => failure.includes('（H1′）'))).toHaveLength(1);
    expect(forcedFailures.filter((failure) => failure.includes('（H2′）'))).toHaveLength(1);
    // ⚠️ ★ **反向也要锁**：新标签**不许**被旧过滤串命中（⇒ 两套标签真的分开了）。
    expect(newTagFailures.some((failure) => failure.includes('（H1）'))).toBe(false);
    expect(newTagFailures.some((failure) => failure.includes('（H2）'))).toBe(false);

    // ── ① **旧标签行**：把它塞进一份「违规行清单」⇒ 断言它**不**进新过滤串 ──
    //   ⚠️ **怎么造一条「带旧标签的违规行」**：`checkPerf()` 自己产不出旧标签了
    //   （这正是要守的事实）⇒ ⇒ 用**把真违规行的标签换回旧标签**来合成一条
    //   ⇒ ⇒ 若新过滤串是「宽松匹配」（例如用 `includes('H1')` 而不是 `includes('（H1′）')`）
    //   ⇒ ⇒ 这条合成行**会**被命中 ⇒ ⇒ **这条断言会红** ⇒ ⇒ 过滤串失效有牙。
    const syntheticOldTagLines = newTagFailures.map((failure) =>
      failure.replace('（H1′）', '（H1）').replace('（H2′）', '（H2）'),
    );
    expect(syntheticOldTagLines).toHaveLength(newTagFailures.length);
    for (const line of syntheticOldTagLines) {
      // ⚠️ ★ **旧标签行必须被新过滤串漏掉**（⇒ 改名真的生效了）。
      expect(line.includes('（H1′）')).toBe(false);
      expect(line.includes('（H2′）')).toBe(false);
      // ⚠️ ★ **而旧过滤串自己认它**（⇒ 这条合成行确实是「带旧标签的违规行」⇒ 前提成立）。
      expect(line.includes('（H1）') || line.includes('（H2）')).toBe(true);
    }
    // ⚠️ ★★ **最硬的一条**：**真实的 `failures` 里一个旧标签都不许有**
    //   ⇒ ⇒ 旧过滤串在真实清单上**匹配不上任何违规行** ⇒ ⇒ **过滤串失效守卫成立**。
    expect(forcedFailures.some((failure) => failure.includes('（H1）'))).toBe(false);
    expect(forcedFailures.some((failure) => failure.includes('（H2）'))).toBe(false);
    // ⚠️ ★ **基线那一轮也一样**（⇒ 不是「伪造才有的现象」）。
    const baseFailures = checkPerf(base);
    expect(baseFailures.some((failure) => failure.includes('（H1）'))).toBe(false);
    expect(baseFailures.some((failure) => failure.includes('（H2）'))).toBe(false);
    db.db.close();
  });

  it('★ R6 的观测行：写明「不设门槛」＋「仍然红」＋探针 20/50（**不许**说成达标）', () => {
    // ⚠️ **用真实读数那条分支**（max > 门槛）⇒ 文案里必须同时出现三件事：
    //   ①「观测值，不设门槛、不判红绿」；② 与门槛的**倍数关系**；③「不是达标」。
    const overGate = {
      corpusSize: 1_000_000,
      candidateReadRows: {
        count: 1000,
        min: 57,
        mean: 4502.959,
        p50: 4385,
        p99: 10103,
        max: 12782,
      },
    } as unknown as PerfResult;
    const line = formatRecallVecRowsObservation(overGate);
    expect(line).toContain('R6 召回路径向量扫描量（RECALL_VEC_ROWS）');
    expect(line).toContain('12782 行');
    expect(line).toContain('观测值，不设门槛、不判红绿');
    expect(line).toContain('探针 20/50');
    // ⚠️ **必须把「仍然红 + 6.39 倍」写在同一个句子里**（只说「不判红绿」会被读成没问题）。
    expect(line).toContain('仍然红');
    expect(line).toContain('6.39 倍');
    // ⚠️ **不许出现任何「达标」结论**（含 ✓ / 「全部达标」这句话）。
    expect(line).not.toContain('✓');
    expect(line).not.toContain('性能门槛全部达标');
    // ⚠️ **但必须出现「不是达标」这个否定句**（⇒ 光不说，读者仍会自己补上「那就是绿了」）。
    expect(line).toContain('不是「达标」');

    // ⚠️ **低于门槛那条分支也不许给出「绿」的结论**（它没有门槛可判）。
    const underGate = {
      corpusSize: 1_000_000,
      candidateReadRows: { count: 10, min: 1, mean: 1.5, p50: 1, p99: 2, max: 2 },
    } as unknown as PerfResult;
    const underLine = formatRecallVecRowsObservation(underGate);
    expect(underLine).toContain('观测值，不设门槛、不判红绿');
    expect(underLine).toContain('不构成任何门槛结论');
    expect(underLine).not.toContain('✓');
  });

  it('★ 落盘声明 `gateRegrouping` 三件事齐备（归口日期 / H1 判谁 / candidateReadRows 是 R6 观测值）', () => {
    expect(GATE_REGROUPING.decidedAt).toBe('2026-11-03');
    expect(GATE_REGROUPING.decision).toContain('D10');
    // ① **H1/H2 判据量必须点名那个字段路径**（机器可核 ⇒ 读 JSON 的脚本能对着它走）。
    //   ⚠️ ★ **T06 起判据量 = `writeSegments.vectorByteReads.bytesRead`**（字节口径）
    //   ⇒ ⇒ 旧的 `writeSegments.vectorCandidateRows` 已**降级为并列观测**（不再进 `failures`）。
    expect(GATE_REGROUPING.h1h2Quantity).toContain('writeSegments.vectorByteReads.bytesRead');
    expect(GATE_REGROUPING.h1h2Quantity).toContain('vectorCandidateRows');
    expect(GATE_REGROUPING.h1h2Quantity).toContain('降级');
    expect(GATE_REGROUPING.h1h2Subject).toContain('写入去重路径');
    // ② **R6 必须点名另一个字段**，且**明确是观测值**。
    expect(GATE_REGROUPING.r6Quantity).toContain('candidateReadRows');
    expect(GATE_REGROUPING.r6Status).toContain('观测值');
    expect(GATE_REGROUPING.r6Status).toContain('不设门槛');
    // ③ **「归口 ≠ 达标」必须写在正文里**（否则读 JSON 的人会把「不判红绿」读成「没问题」）。
    expect(GATE_REGROUPING.note).toContain('6.39 倍');
    expect(GATE_REGROUPING.note).toContain('仍然红');
    expect(GATE_REGROUPING.note).toContain('2.76 倍');
    expect(GATE_REGROUPING.note).toContain('不是门槛');
  });
});
