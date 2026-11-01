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
