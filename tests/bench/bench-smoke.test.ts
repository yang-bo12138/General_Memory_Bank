/**
 * **bench 的小规模冒烟** —— P2-T08 的「bench 怎么与 verify 链解耦」答案。
 *
 * ⚠️ **为什么 bench 的五个脚本不在 `pnpm run verify` 链里**：
 *   那些脚本要跑**几分钟**（百万级语料 + 训练 + 上千次查询）
 *   ⇒ 放进门禁 ⇒ **每次 CI 都跑一遍重测** ⇒ 门禁从「秒级」变成「分钟级」
 *   ⇒ 且 CI 机器的性能**不代表**性能基线的结论（基线必须在**记录在案的**机器上采）。
 *   ⇒ **分离方案**：
 *   · **重测** = 人跑 `pnpm exec tsx bench/*.ts`（**记录在案的**机器 + **落盘**结果）；
 *   · **守门** = 本文件（**小规模**跑**同一套断言逻辑** ⇒ bench 的断言不会腐坏）。
 *
 * ⚠️ **本文件测的是「断言逻辑」，不是「性能数字」**：
 *   性能门槛（recall P99 ≤ 200ms 等）在**共享机器上是参考线** ⇒ 放进门禁必然 flaky
 *   ⇒ 门禁里**只**断言「**逻辑正确**」（吻合率口径、只漏不错、语料可复现、embedder 确定性、
 *   P99 工具自检），**不**断言「性能达标」。
 *
 * ⚠️ **规模故意很小（1500 条）**：门禁要在**几十秒内**跑完
 *   ⇒ 用小的中心数（粗 8 / 细 40）⇒ 训练秒级完成。
 *   ⇒ ⚠️ **注意**：小规模下 `ROUTER_MIN_TRAINING`（1 万）**不满足**
 *   ⇒ `resolveVectorBackendState` 会判成 `flat_auto` ⇒ **这是设计内行为，不是故障**
 *   ⇒ 但 bench 直接调 `IvfVectorBackend`（不经过那个判定）⇒ **分桶路径照样被走到**。
 *
 * ⚠️ **临时目录不清理**（与 `tests/unit/memory-store.test.ts` 同一套法）：
 *   生产的 `MemoryStore` **刻意不提供 `close()`**（§6 公开面里没有它）
 *   ⇒ 库文件在进程存活期间**一直被 Windows 锁着** ⇒ 删不掉（`EBUSY`）
 *   ⇒ 且删不掉时**真正的错误会被 `EBUSY` 掩盖**（清理异常会顶掉原始异常）
 *   ⇒ 所以这里**不清理**（临时目录由系统回收），宁可留文件也不掩盖错误。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkAgreement, measureAgreement } from '../../bench/agreement.js';
import {
  DEFAULT_CORPUS_OPTIONS,
  generateCorpus,
  generateQueries,
  runCorpusSelfCheck,
} from '../../bench/corpus.js';
import { EXPECTED_VOCABULARY_SIZE, runEmbedderSelfCheck } from '../../bench/embedder.js';
import { prepareBench } from '../../bench/lib/db.js';
import { flatStreamMismatches } from '../../bench/lib/flat.js';
import { BENCH_NOW, percentile, summarizeLatency } from '../../bench/lib/harness.js';
import { checkPerf, measurePerf } from '../../bench/perf.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';

/** 冒烟用的语料规模（**故意很小** ⇒ 门禁秒级完成）。 */
const SMOKE_SIZE = 1500;

/** 冒烟用的中心数（**比生产小** ⇒ 训练秒级完成）。 */
const SMOKE_COARSE = 8;
const SMOKE_FINE = 40;

/**
 * 建一份**小规模**的 bench 库（**复用生产的建库 / 灌库 / 训练路径**）。
 *
 * @param dir 工作目录（**不清理**：见文件头的说明）
 * @returns 库路径与句柄
 */
function buildSmokeBench(dir: string): { dbPath: string; db: ReturnType<typeof prepareBench> } {
  const dbPath = join(dir, 'smoke.db');
  const prepared = prepareBench({
    dbPath,
    corpus: { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE },
    coarseCenters: SMOKE_COARSE,
    fineCenters: SMOKE_FINE,
    nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
  });
  return { dbPath, db: prepared };
}

/** 新建一个**临时工作目录**（不清理 ⇒ 见文件头）。 */
function newWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-ocean-bench-smoke-'));
}

describe('P2-T08 · bench 的小规模冒烟（守门用；重测靠 bench/*.ts 脚本）', () => {
  it('★ embedder 确定性：同一输入两次调用**逐位相同**', () => {
    const check = runEmbedderSelfCheck();
    expect(check.deterministic).toBe(true);
    expect(check.vocabularySize).toBe(EXPECTED_VOCABULARY_SIZE);
  });

  it('★ embedder 的语义结构：「同义改写真的接近」且「无关概念真的远」', () => {
    const check = runEmbedderSelfCheck();
    // ⚠️ **阈值是构造出来的性质**，不是「碰巧」：
    //   同 group 的两个词共享 `v_group` ⇒ 余弦高；跨 group ⇒ 近乎正交。
    expect(check.synonymCosine).toBeGreaterThan(0.7);
    expect(check.unrelatedCosine).toBeLessThan(0.3);
  });

  it('★ 语料可复现：同种子两次生成**逐条**相同', () => {
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: 500 };
    const check = runCorpusSelfCheck(options);
    expect(check.reproducible).toBe(true);
    expect(check.compared).toBe(500);
    expect(check.firstMismatchIndex).toBe(-1);
  });

  it('★ 语料正文**全局唯一**（撞唯一索引 ⇒ 落库直接失败）', () => {
    // ⚠️ **为什么必须守这条**：生产的 `memories` 表上有
    //   `CREATE UNIQUE INDEX idx_mem_hash ON memories(content_hash) WHERE deleted = 0`
    //   ⇒ 正文一旦重复 ⇒ 落库抛「唯一性冲突」⇒ **整份基线跑不起来**。
    //   ⇒ 这条断言在**门禁里**守着（不然要到跑百万条时才发现）。
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: 2000 };
    const hashes = new Set<string>();
    for (const record of generateCorpus(options)) {
      hashes.add(record.content);
    }
    expect(hashes.size).toBe(options.size);
  });

  it('★ 查询是**同义改写**：表面不同，但向量上真的接近', () => {
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: 600 };
    const queries = generateQueries(options, 10);
    expect(queries.length).toBe(10);
    for (const query of queries) {
      // ⚠️ **不是原文照抄** ⇒ 否则测的是「精确命中」而不是「同义召回」。
      expect(query.context).not.toBe(query.targetId);
      // ⚠️ **同义改写真的接近**（关键口径 #2）⇒ 生产口径的点积即余弦。
      const cosine = query.embedding.reduce(
        (total, value, index) => total + value * (query.targetEmbedding[index] ?? 0),
        0,
      );
      expect(cosine).toBeGreaterThan(0.5);
    }
  });

  it('★ P99 工具自检：已知的探针 ⇒ 测出的 P99 落在合理区间', () => {
    // ⚠️ **为什么要有这条**：P99 是**测量工具的产物** ⇒ 工具坏了 ⇒ 数字全是假的
    //   ⇒ 必须有一条「工具本身是对的」的独立证据。
    //   ⇒ 用一个**已知耗时的忙等**（约 5ms）⇒ 测出的 P99 必须落在这个量级。
    const samples: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const start = process.hrtime.bigint();
      const deadline = start + 5_000_000n;
      // ⚠️ **忙等**（不是 sleep）⇒ 精确可控的耗时。
      while (process.hrtime.bigint() < deadline) {
        // 空循环：占住 CPU 5ms
      }
      samples.push(Number(process.hrtime.bigint() - start) / 1_000_000);
    }
    const p99 = percentile(samples, 99);
    expect(p99).toBeGreaterThan(4);
    expect(p99).toBeLessThan(500);
    expect(summarizeLatency(samples).count).toBe(5);
  });

  it('★ flat 参照 ≡ 生产 `FlatVectorBackend`（流式版与生产版逐条相同）', () => {
    // ⚠️ **为什么必须守这条**：bench 侧另写了一份流式 flat 扫描（为了 100 万条不爆内存）
    //   ⇒ 两份实现一旦漂移 ⇒ **吻合率的分母与分子都错** ⇒ 整个结论无效。
    const { db } = buildSmokeBench(newWorkDir());
    try {
      const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
      const queries = generateQueries(options, 5);
      for (const query of queries) {
        expect(flatStreamMismatches(db.db, query.embedding, 20)).toEqual([]);
      }
    } finally {
      db.db.close();
    }
  });

  it('★ 吻合率：分桶 top-20 ⊆ flat top-20（「只漏不错」）且吻合率 ≥ 0.98', () => {
    const { db } = buildSmokeBench(newWorkDir());
    try {
      const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
      const result = measureAgreement(db.db, options, 20, {
        ...DEFAULT_PARAMS,
        ROUTER_COARSE_CENTERS: SMOKE_COARSE,
        ROUTER_FINE_CENTERS: SMOKE_FINE,
      });
      const failures = checkAgreement(result);
      expect(failures).toEqual([]);
      // ⚠️ **「不错」的硬断言**（分桶结果里的每一条都必须在 flat 的 top-20 里）：
      //   `checkAgreement` 已把它写成 `extraTotal === 0` ⇒ 这里再显式断一次（防止它被改弱）。
      expect(result.extraTotal).toBe(0);
      expect(result.overall).toBeGreaterThanOrEqual(0.98);
      expect(result.queryCount).toBeGreaterThan(0);
      // ⚠️ **C29 的分母纪律**（分桶候选 ⊆ flat 的**候选全集**，不是 top-20）。
      expect(result.bucketCandidatesOutsideUniverse).toBe(0);
      // ⚠️ **「同义改写真的接近」**（关键口径 #2 的实测值）。
      expect(result.synonymCosineMean).toBeGreaterThan(0.5);
    } finally {
      db.db.close();
    }
  });

  it('★ 性能测量：工具跑得通，且样本数非零（不判性能达标）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    try {
      const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
      const store = new MemoryStore({ dbPath });
      const result = measurePerf(db.db, store, options, 10, 10);
      // ⚠️ **只断言「测到了东西」**，不断言「性能达标」
      //   （达标是**软阈值** ⇒ 放进门禁必然 flaky）。
      expect(result.recallSamples).toBe(10);
      expect(result.writeSamples).toBe(10);
      expect(result.vectorRouteSamples).toBe(10);
      expect(result.warmupRounds).toBeGreaterThan(0);
      // ⚠️ **工具自检**：测量函数本身要能跑完并给出有限的数
      expect(Number.isFinite(result.recallP99Ms)).toBe(true);
      expect(Number.isFinite(result.writeP99Ms)).toBe(true);
      expect(Number.isFinite(result.vectorRouteShare)).toBe(true);
      // ⚠️ **断言函数本身可调用**（它判的是软阈值 ⇒ 这里只确认它不抛）。
      expect(Array.isArray(checkPerf(result))).toBe(true);
      expect(BENCH_NOW).toBeGreaterThan(0);
    } finally {
      db.db.close();
    }
  });
});
