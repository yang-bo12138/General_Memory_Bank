/**
 * **H1 口径加固 + 页缓存状态标注** 的门禁（2026-11-02 架构师裁决的落地）。
 *
 * ⚠️ ★ **本文件守的是「判据本身的可信性」** —— 不是「性能达标」：
 *   · **H1 的判据量必须来自「生产 SQL 实际物化的行数」（实测）**，
 *     **不是**「命中桶成员数之和」（推算 ⇒ **模型化了「桶内不设 LIMIT」这个实现**）
 *     ⇒ ⇒ 否则阶段 4 一旦引入「桶内 LIMIT」/「两段式读」，真实读的行数会降、
 *     **判据却还红** ⇒ ⇒ **「阶段 4 收官」就是假的**；
 *   · **页缓存状态必须能被机器读出来**（`cold` / `warm` / `unknown`）
 *     ⇒ 冷 / 热两档的毫秒数**差 21.6 倍** ⇒ 这个区分不能只靠人记。
 *
 * ⚠️ **为什么这些断言值得存在**（本仓库的纪律：判据要可被变异打红）：
 *   · 把 `installRowReadCounter()` 换回「推算口径」⇒ 第 ① 条会红
 *     （推算 ≠ 实测这件事，在**实现变了**的时候才暴露 ⇒ 平时看不出来）；
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
import { checkPerf, measurePerf } from '../../bench/perf.js';
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

describe('H1 口径加固 · 实测读行数（不再模型化「桶内不设 LIMIT」）', () => {
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

      // ⚠️ ★ **核心断言**：**当前实现下两者相等**
      //   ⇒ ⇒ 「口径加固」**不改变门槛数值**（≤ 2,000 行不变）
      //   ⇒ ⇒ 但它**不再依赖这个等式**（阶段 4 引入桶内 LIMIT 后，实测会降、推算不会）。
      expect(measured).toBe(derived);
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

  it('★ `measurePerf` 的 H1 口径声明是「实测」，且推算对照值一并落盘', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    // ⚠️ ★ **口径必须是「实测」**（⇒ 读 JSON 的人不会把它误读成推算）。
    expect(result.candidateReadRowsBasis.mode).toBe('measured');
    expect(result.candidateReadRowsBasis.note).toContain('measured');
    // ⚠️ **推算对照值必须也在**（⇒ 「实测 vs 推算」的差可见）。
    expect(result.candidateReadRowsBasis.derivedCrossCheck).not.toBeNull();
    expect(result.candidateReadRowsBasis.derivedCrossCheck?.count).toBe(
      result.candidateReadRows.count,
    );
    // ⚠️ **桶成员侧的行读**（附加信息）也落盘。
    expect(result.candidateReadRowsBasis.bucketMemberRowsRead?.count).toBe(
      result.candidateReadRows.count,
    );
    // ⚠️ **判据量本身**：样本非零 ⇒ H1 不是真空通过。
    expect(result.candidateReadRows.count).toBe(5);
    expect(result.candidateReadRows.max).toBeGreaterThan(0);
    db.db.close();
  });

  it('★ H1 超标时违规清单里**带上口径**（不许让人误以为那是实测或推算）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const failures = checkPerf(result);
    const h1Failures = failures.filter((failure) => failure.includes('（H1）'));
    // ⚠️ **小规模下 H1 不一定超门槛** ⇒ 两种情况都要说得清：
    //   超了 ⇒ 清单里必须带口径；没超 ⇒ 清单里不许出现 H1 判红。
    for (const failure of h1Failures) {
      expect(failure).toContain('口径');
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
      expect(info.note).toContain('166 MB/s');
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
  it('★ 守卫一：计数器失效 ⇒ 兜底必须把 `mode` 标成 `derived`（不许假装它是实测）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    // ⚠️ ★ **注入「计数器装了但不计数」** ⇒ 实测值恒为 0 ⇒ 兜底必须接手。
    const result = measurePerf(db.db, store, options, 5, 5, { disableRowReadCounter: true });
    // ⚠️ ★ **这条断言专打「`mode` 恒为 `measured`」那个变异**。
    expect(result.candidateReadRowsBasis.mode).toBe('derived');
    expect(result.candidateReadRowsBasis.note).toContain('推算');
    // ⚠️ **判据量必须退回到推算值**（⇒ 有值 ⇒ 不是「真空通过」）。
    expect(result.candidateReadRowsBasis.derivedCrossCheck?.max).toBeGreaterThan(0);
    expect(result.candidateReadRows.max).toBe(result.candidateReadRowsBasis.derivedCrossCheck?.max);
    // ⚠️ ★ **违规清单里必须标明「口径 = 推算」**（⇒ 不许让人误以为那是实测）。
    const failures = checkPerf(result);
    const h1Failure = failures.find((failure) => failure.includes('（H1）'));
    if (h1Failure !== undefined) {
      expect(h1Failure).toContain('推算');
    }
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

    // ⚠️ ★★ **核心断言**：**差的量 = 命中细桶数**（每个命中桶恰好多一条软删成员）
    //   ⇒ ⇒ **判据量（`candidateReadRows`）取的是「实测」那一侧**
    //   ⇒ ⇒ **这条断言专打「`candidateReadRows` 取推算值」那个变异**
    //   （该变异下差值 = 0 ⇒ 与命中细桶数（> 0）不符 ⇒ 必红）。
    expect((derived?.mean ?? 0) - result.candidateReadRows.mean).toBeCloseTo(
      result.hitFineBuckets.mean,
      6,
    );
    // ⚠️ **口径声明仍然是「实测」**（⇒ 这一轮计数器是好的 ⇒ 不许退回推算）。
    expect(result.candidateReadRowsBasis.mode).toBe('measured');
    db.db.close();
  });
});
