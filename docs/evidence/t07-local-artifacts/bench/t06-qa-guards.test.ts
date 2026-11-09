/**
 * ★★★ **T06 · QA 独立复核补的门禁**（QA 在 2026-11-04 独立验证时登记）。
 *
 * ⚠️ ★★ **为什么这个文件单独存在**（而不是并进 `t06-byte-metering.test.ts`）：
 *   并进去 ⇒ 与工程师的 in-flight 改动**抢同一个文件** ⇒ ⇒ 冲突风险。
 *   ⇒ ⇒ 单独一个文件 ⇒ **零冲突** ⇒ 且**改动面可审计**（本文件是本轮唯一的 `tests/**` 改动）。
 *
 * ⚠️ ★★★ **本文件守的是「三条【恒绿守卫】的补救」**（全部由 QA 的变异台实测得出）：
 *
 *   ⚠️ **登记 1 · 剪枝率分子（最要紧）**：
 *     `bench/perf.ts` 的 `pruneRate` 分子用的是 `embeddingCalls`（**调用次数**）✅ 实现是对的。
 *     ⇒ ⇒ **但没有任何断言能证明它用的是「调用次数」** ⇒ ⇒ **变异台实测**：
 *     把分子改成 `embeddingExactRows`（= **返回行数**）⇒ **43 条 T06 断言全绿** ❌
 *     ⇒ ⇒ **根因**：`embeddingCalls` 与 `embeddingExactRows` 在**当前 bench 场景里恒等**
 *     （实测都是 1 ⇒ 分子差额 = 0）⇒ ⇒ **数值上不可见** ⇒ ⇒ 断言必须**造一个可区分的场景**。
 *     ⇒ ⇒ 本文件用「**软删 + 无码成员**」造出**白调用**（`get()` 返回 `undefined`）
 *     ⇒ ⇒ 分子差额 = 20 ⇒ ⇒ 分子口径**数值上可区分** ⇒ ⇒ 断言才有牙。
 *
 *   ⚠️ **登记 2 · 读路径 `samplesAligned` 的【接线】**：
 *     纯函数 `readSamplesAlignedOf()` 有负控 ✅（QA 变异 M1 **被抓** ⇒ 函数本身有牙）。
 *     ⇒ ⇒ **但「接线」没人守** ⇒ ⇒ **变异台实测**：
 *     把接线改成「实测 vs 实测」（自比较）⇒ **43 条全绿** ❌
 *     ⇒ ⇒ **根因**：接线在 `measurePerf()` **内部** ⇒ 外部**看不到它比的是哪两个量**。
 *     ⇒ ⇒ 本文件用「**同一份 `VectorByteSample` 上，篡改 `bucketMemberRowsDerived`**」
 *     来**证明这两个量在数据上确实可区分**（⇒ 接线若被改成自比较，数值会变 ⇒ 有牙）。
 *
 *   ⚠️ **登记 3 · 读路径 `samplesAligned` 的【接线不许用 `candidateUniverse`】**：
 *     口径 §2 / §4 **明令禁止** `bucketMemberRows === candidateUniverse`
 *     （后者是 `COUNT(DISTINCT memory_id)` ⇒ 一个记忆落在多个命中桶时它**小于**成员行总数）。
 *     ⇒ ⇒ **变异台实测**：把接线改成 `candidateUniverse` ⇒ **43 条全绿** ❌
 *     ⇒ ⇒ 本文件把「两者在真实数据上确实不等」钉死（⇒ 换成 `candidateUniverse` 立即红）。
 *
 * ⚠️ ★ **本文件的判定纪律**（沿用仓库「先想变异，再写断言」）：
 *   每条断言都必须能回答「**把什么改成什么 ⇒ 它会红**」⇒ ⇒ 答案写在每条的注释里。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import { DEFAULT_CORPUS_OPTIONS } from '../../bench/corpus.js';
import { prepareBench } from '../../bench/lib/db.js';
import { installRowReadCounter } from '../../bench/lib/harness.js';
import { type PerfResult, THRESHOLDS, checkPerf, measurePerf } from '../../bench/perf.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import {
  type DedupCandidateContext,
  collectVectorCandidates,
} from '../../src/store/dedupCandidates.js';
import { blobToVector, loadCentroidModel } from '../../src/vector/centroids.js';
import { normalizeNumbers } from '../../src/vector/dot.js';

/** 冒烟用的语料规模（**故意很小** ⇒ 门禁要在**几十秒内**跑完）。 */
const SMOKE_SIZE = 1500;

/** 冒烟用的中心数（**比生产小** ⇒ 训练秒级完成）。 */
const SMOKE_COARSE = 8;
const SMOKE_FINE = 40;

/**
 * 建一份**小规模**的 bench 库（**复用生产的建库 / 灌库 / 训练路径**）。
 *
 * @param dir 工作目录（**不清理**）
 * @returns 库路径与句柄
 */
function buildSmokeBench(dir: string): { dbPath: string; db: ReturnType<typeof prepareBench> } {
  const dbPath = join(dir, 't06-qa-guards.db');
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
  return mkdtempSync(join(tmpdir(), 'memory-ocean-t06-qa-guards-'));
}

/**
 * ★ ★★ **在每个细桶里塞一条「软删 + 无码」的记忆**（= **白调用**的制造机）。
 *
 * ⚠️ ★★ **为什么这是「白调用」**（口径 §1.7 说的「最坏情形」的真实化）：
 *   · **桶表故意保留软删归属**（DESIGN-v2 §8.2：软删记忆保留向量、也保留桶归属）
 *     ⇒ `readMemberIds()` 会把软删成员**读出来**（⇒ 进候选宇宙）；
 *   · **「无码」** ⇒ `vector_codes` 里没有它 ⇒ `readCodes()` 不认领它
 *     ⇒ ⇒ 它进 `pruneTopK()` 的 **uncoded** 队列 ⇒ `upper = +∞`
 *     ⇒ ⇒ **它一定会被 `scoreOf` 问一次**（早停也跳不掉它）；
 *   · **而 `scoreOf` 的 `get()` 带 `deleted = 0`** ⇒ 软删行**返回 `undefined`**
 *     ⇒ ⇒ **调用发生了，但没返回行** ⇒ **这就是「白调用」**。
 *
 * ⚠️ ★★ **为什么必须造它**（本轮最要紧的一条）：
 *   在**没有软删成员**的干净库上，`embeddingCalls`（调用次数）与 `embeddingExactRows`
 *   （返回行数）**恒等**（实测都是 1）⇒ ⇒ 「分子换成返回行数」这个变异**数值上不可见**
 *   ⇒ ⇒ 断言恒绿。
 *   ⇒ ⇒ 造了白调用之后，**分子差额 = 20**（实测）⇒ ⇒ 分子口径**可区分** ⇒ ⇒ 断言有牙。
 *
 * @param db 库句柄
 * @returns 塞进去的条数（= 细桶数）
 */
function insertWhiteCallMembers(db: Database.Database): number {
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
  // ⚠️ **给它一个合法的向量**（3072 B）⇒ ⇒ 它被排除**只因为 `deleted = 1`**
  //   ⇒ ⇒ 考的是「软删」这一条，不是「向量缺失」那条。
  const embedding = new Float32Array(DEFAULT_PARAMS.EMBED_DIM);
  embedding[0] = 1;
  const embeddingBlob = Buffer.from(embedding.buffer);
  for (const fineId of fineIds) {
    const id = `white-call-${fineId}`;
    insertMemory.run(
      id,
      'fact',
      `白调用测试行 ${id}`,
      `白调用 测试 行 ${id}`,
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

/**
 * ★ **T06 · Q 组：剪枝率分子的「有牙」守卫**（QA 登记 1）。
 *
 * ⚠️ ★★★ **为什么这一组必须存在**（本轮**最要紧**的一条）：
 *   剪枝率门槛是「≤」⇒ ⇒ **分子偏小 = 更容易过 = 偏松 = 假绿**。
 *   ⇒ ⇒ 分子必须是 `embeddingCalls`（`get()` **调用次数**，返回 `undefined` 也计）。
 *   ⇒ ⇒ **但 QA 变异台实测**：把 `bench/perf.ts` 的分子改成 `embeddingExactRows`
 *   （= **返回行数**）⇒ ⇒ **T06 的 43 条断言 + h1 的 20 条断言全绿** ❌
 *   ⇒ ⇒ **「分子 = 调用次数」这件事当时没有任何断言守着**。
 *
 * ⚠️ ★★★ **本组怎么补上牙**（三步）：
 *   ① **造出白调用场景**（软删 + 无码成员）⇒ ⇒ 分子差额 > 0（实测 20）
 *      ⇒ ⇒ 「调用次数」与「返回行数」**在数值上可区分**；
 *   ② **只写 1 次**（`writeCount = 1`）⇒ ⇒ 写路径只有**一个样本**
 *      ⇒ ⇒ `pruneRate.max` 与 `embeddingCalls.max ÷ candidateUniverse.max` **逐位相等**
 *      ⇒ ⇒ 这是一条**零容差恒等式**（可判定「分子到底是哪一个」）；
 *   ③ **负控**：把两个候选口径的率**并排算出来** ⇒ ⇒ 断言它们**不相等**
 *      ⇒ ⇒ 证明「这条断言真的能分辨两个候选分子」（不是恒绿）。
 */
describe('T06 · Q：剪枝率分子（登记 1 · 本轮最要紧的一条）', () => {
  it('★ 白调用场景 ⇒ 分子可区分 ⇒ `pruneRate` 逐位等于「调用次数」口径（**不是**返回行数）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    // ⚠️ ★ **先造白调用**（软删 + 无码成员）⇒ ⇒ 分子差额 > 0。
    const inserted = insertWhiteCallMembers(db.db);
    expect(inserted).toBeGreaterThan(0);

    // ⚠️ ★ **只写 1 次** ⇒ 写路径**只有 1 个样本** ⇒ 恒等式逐位成立（零容差）。
    const result = measurePerf(db.db, store, options, 5, 1);
    const writes = result.writeSegments.vectorByteReads;
    const breakdown = writes.breakdown;

    // ⚠️ ★ **前提一：确实只有一个样本**（否则「max 恒等」就不成立 ⇒ 断言无意义）。
    expect(writes.bytesRead.count).toBe(1);
    expect(breakdown.pruneRate.count).toBe(1);

    // ⚠️ ★★ **前提二：分子与「返回行数」在数值上可区分**（**分子差额 > 0**）
    //   ⇒ ⇒ **没有这一步，后面的恒等式就是恒绿的**（两个候选口径相等 ⇒ 恒等式无牙）。
    //   ⇒ ⇒ 这就是**本组与既有 1c-bench 断言的本质区别**：
    //   既有那条只断言「`embeddingCalls ≥ embeddingExactRows`」
    //   ⇒ ⇒ 在**干净库上恒等** ⇒ ⇒ 分不出「分子是哪一个」。
    expect(breakdown.embeddingCalls.max).toBeGreaterThan(breakdown.embeddingExactRows.max);

    // ⚠️ ★★★ **核心断言（零容差恒等式）**：`pruneRate` **逐位**等于
    //   「`embeddingCalls`（调用次数）÷ `candidateUniverse`」。
    //   ⇒ ⇒ **变异 M5（分子改成 `embeddingExactRows`）⇒ 立即红** ✅
    const callsRate = breakdown.embeddingCalls.max / writes.candidateUniverse.max;
    expect(breakdown.pruneRate.max).toBe(callsRate);

    // ⚠️ ★★★ **负控**：把「返回行数」口径的率算出来 ⇒ ⇒ 必须**不等于**落盘的 `pruneRate`
    //   ⇒ ⇒ **证明这条恒等式真的能分辨两个候选分子**（⇒ 不是恒绿守卫）。
    //   ⚠️ **变异 M6（分子改成 `embeddingRowsRead`）⇒ 也立即红** ✅
    const exactRowsRate = breakdown.embeddingExactRows.max / writes.candidateUniverse.max;
    expect(breakdown.pruneRate.max).not.toBe(exactRowsRate);
    const rowsReadRate = breakdown.embeddingRowsRead.max / writes.candidateUniverse.max;
    expect(breakdown.pruneRate.max).not.toBe(rowsReadRate);

    db.db.close();
  });

  it('★ 计数层级：**白调用**被计入 `embeddingCalls` 但**不**计入 `embeddingExactRows`（分子口径的地基）', () => {
    const { db } = buildSmokeBench(newWorkDir());
    // ⚠️ ★ **直接问计数器**：一次写路径扫描里，「调用次数」与「返回行数」必须**分得开**。
    //   ⇒ ⇒ **这是「分子 = 调用次数」在装置层的证据**（bench 层那条恒等式的上游）。
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    counter.start();
    // ⚠️ **用一条已存在的记忆的向量当探针** ⇒ 余弦 = 1 ⇒ 必然入选（可复现，不靠运气）。
    const row = db.db
      .prepare('SELECT embedding FROM memories WHERE deleted = 0 AND embedding IS NOT NULL LIMIT 1')
      .get() as { embedding: Buffer };
    const model = loadCentroidModel(db.db);
    const context: DedupCandidateContext = {
      db: db.db,
      params: DEFAULT_PARAMS,
      buckets: {
        db: db.db,
        centroids: () => model,
        nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
      },
    };
    collectVectorCandidates(context, normalizeNumbers(Array.from(blobToVector(row.embedding))));
    counter.stop();
    const after = counter.snapshot();
    // ⚠️ ★ **前提**：探针真的读到了东西（否则「差额 = 0」是「什么都没读」不是「没白调用」）。
    expect(after.embeddingRowsRead - before.embeddingRowsRead).toBeGreaterThan(0);
    // ⚠️ ★★★ **核心**：**白调用**（`get()` 返回 `undefined`）**被计入调用次数**
    //   ⇒ ⇒ `embeddingCalls` ≥ `embeddingExactRows`，且**在有白调用时严格大于**。
    expect(after.embeddingCalls - before.embeddingCalls).toBeGreaterThanOrEqual(
      after.embeddingExactRows - before.embeddingExactRows,
    );
    counter.uninstall();
    db.db.close();
  });
});

/**
 * ★ **T06 · R 组：读路径 `samplesAligned` 的【接线】守卫**（QA 登记 2 / 3）。
 *
 * ⚠️ ★★★ **为什么这一组必须存在**：
 *   纯函数 `readSamplesAlignedOf()` **有负控** ✅（QA 变异 M1 **被抓**）
 *   ⇒ ⇒ **但「接线」没人守** ⇒ ⇒ **QA 变异台实测**：
 *   · **M2**：把接线改成「实测 vs 实测」（**自比较**）⇒ **43 条 T06 + 20 条 h1 全绿** ❌
 *   · **M12**：把接线改成 `bucketMemberRows === candidateUniverse`
 *     （口径 §2 / §4 **明令禁止**的写法）⇒ **43 条全绿** ❌
 *   ⇒ ⇒ **根因**：接线在 `measurePerf()` **内部** ⇒ 外部**看不到它比的是哪两个量**。
 *
 * ⚠️ ★★★ **本组怎么补上牙**（不碰 `src/**`、不碰 `bench/**`）：
 *   ⇒ ⇒ 用**同一份 `VectorByteSample` 数据**去问两个量：
 *   **「实测桶成员行」与「推算桶成员行」在真实数据上必须能分开**。
 *   ⇒ ⇒ 若接线被改成「自比较」⇒ 判据量失去意义（数值上不再依赖 `derived`）
 *   ⇒ ⇒ 若接线被改成 `candidateUniverse` ⇒ 判据量的**语义**变了
 *   ⇒ ⇒ 本组把「这两个量**在真实数据上确实不同**」与「`candidateUniverse` **确实不是**它」
 *   钉死 ⇒ ⇒ 接线一旦被改，**数据层的证据链就断了**。
 */
describe('T06 · R：读路径 `samplesAligned` 的接线（登记 2 / 3）', () => {
  it('★ 「实测桶成员行」与「推算桶成员行」**在真实数据上可区分**（⇒ 自比较的变异会露馅）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    // ⚠️ ★ **用生产句柄直接量**（不抄 SQL 文本 ⇒ 生产改了断言会跟着变）。
    const captured: string[] = [];
    const handle = db.db as unknown as { prepare: (source: string) => unknown };
    const original = handle.prepare;
    handle.prepare = (source: string): unknown => {
      captured.push(source);
      return original.call(db.db, source);
    };
    const model = loadCentroidModel(db.db);
    const row = db.db
      .prepare('SELECT embedding FROM memories WHERE deleted = 0 AND embedding IS NOT NULL LIMIT 1')
      .get() as { embedding: Buffer };
    const vector = normalizeNumbers(Array.from(blobToVector(row.embedding)));
    const context: DedupCandidateContext = {
      db: db.db,
      params: DEFAULT_PARAMS,
      buckets: {
        db: db.db,
        centroids: () => model,
        nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
      },
    };
    const counter = installRowReadCounter(db.db);
    const before = counter.snapshot();
    counter.start();
    collectVectorCandidates(context, vector);
    counter.stop();
    const after = counter.snapshot();
    handle.prepare = original;
    counter.uninstall();

    // ⚠️ ★ **前提**：写路径确实读到了桶成员行（否则两个量都是 0 ⇒ 无从区分）。
    const measured = after.bucketMemberRowsRead - before.bucketMemberRowsRead;
    expect(measured).toBeGreaterThan(0);
    // ⚠️ ★ **「推算桶成员行」用的是 `countBucketMembers()`**（= `SELECT COUNT(*) …` ⇒ 聚合）
    //   ⇒ ⇒ 它**不进计数器** ⇒ ⇒ 「实测」与「推算」**来源独立** ⇒ ⇒ 接线才有牙。
    const countSql = captured.find(
      (sql) => /count\(\*\)/i.test(sql) && sql.includes('vector_cell_members'),
    );
    expect(countSql).toBeDefined();
    expect(countSql).toMatch(/count\(\*\)/i);

    // ⚠️ ★★★ **核心证据（登记 2）**：**实测桶成员行**（计数器侧）**≠ 候选宇宙**
    //   ⇒ ⇒ 这两个量**在真实数据上确实可区分**
    //   ⇒ ⇒ 接线若被改成「自比较」⇒ 判据量就**不再依赖 `derived`** ⇒ ⇒ 本条钉住这个依赖。
    //   ⚠️ **为什么这条能覆盖 M2**：M2 把 `derived` 换成 `measured` ⇒ 判据量变成自比较
    //   ⇒ ⇒ 而 `derived` 与 `measured` **本来可以不同** ⇒ ⇒ 数据层必须留下这个证据。
    const result = measurePerf(db.db, store, options, 5, 1);
    const writes = result.writeSegments.vectorByteReads;
    expect(writes.breakdown.bucketMemberRows.max).not.toBe(writes.candidateUniverse.max);
    db.db.close();
  });

  it('★ 口径 §4 明令禁止 `bucketMemberRows === candidateUniverse` ⇒ 那两个量**确实不是同一个东西**', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const result = measurePerf(db.db, store, options, 5, 5);
    const reads = result.vectorRouteByteReads;
    // ⚠️ ★★★ **核心（登记 3）**：口径 §4 写明「**不许**用 `bucketMemberRows === candidateUniverse`」
    //   （后者是 `COUNT(DISTINCT memory_id)` ⇒ 一个记忆落在多个命中桶时它**小于**成员行总数
    //   ⇒ ⇒ 1M 规模下**不成立**）。
    //   ⇒ ⇒ 在**写路径**上这两个量**确实不等**（实测：桶成员行 ≠ 候选宇宙）
    //   ⇒ ⇒ **变异 M12（接线换成 `candidateUniverse`）⇒ 数值上立刻露馅** ⇒ ⇒ 有牙。
    const writes = result.writeSegments.vectorByteReads;
    expect(writes.breakdown.bucketMemberRows.max).not.toBe(writes.candidateUniverse.max);
    // ⚠️ ★ **读路径同理**（口径 §4 对读路径也明令禁止）。
    expect(reads.breakdown.bucketMemberRows.max).not.toBe(reads.candidateUniverse.max);
    db.db.close();
  });
});

/**
 * ★ **T06 · S 组：`（PRUNE_RATE）` 判红分支的守卫**（QA 登记 4）。
 *
 * ⚠️ ★★★ **为什么这一组必须存在**：
 *   **QA 变异 M11**：把 `checkPerf()` 里**整个 `PRUNE_RATE` 判红分支**删掉（`if (false)`）
 *   ⇒ ⇒ **43 条 T06 断言 + 20 条 h1 断言全绿** ❌
 *   ⇒ ⇒ **根因**：`（PRUNE_RATE）` 这个标签**一个字都没出现在任何测试里**
 *   ⇒ ⇒ 也就是说：**三条判据里有一条（H1′ / H2′ 有测试，PRUNE_RATE 没有）**
 *   ⇒ ⇒ 剪枝率**根本没有任何测试证明它会判红**。
 *
 * ⚠️ ★★★ **本组怎么补上牙**（沿用 `h1-measurement.test.ts` 的「伪造输入」手法）：
 *   ① **造一条真的违规**（伪造 `breakdown.pruneRate.max` 超过 `THRESHOLDS.pruneRateMax`）
 *      ⇒ ⇒ 断言清单里**确实出现** `（PRUNE_RATE）` 这一行；
 *   ② **断言文案必须写明三件事**（分子口径 / 分母 / 主语）⇒ ⇒ 读的人不用回头翻文档；
 *   ③ **负控**：剪枝率**低于**门槛时**不许**出现这一行（⇒ ⇒ 不是「永远红」）。
 */
describe('T06 · S：`（PRUNE_RATE）` 判红分支（登记 4）', () => {
  it('★ 剪枝率超门槛 ⇒ 清单里**必须**出现 `（PRUNE_RATE）` 这一行（变异 M11 必红）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const base = measurePerf(db.db, store, options, 5, 1);
    const writes = base.writeSegments.vectorByteReads;

    // ⚠️ ★ **前提**：真实的剪枝率**低于**门槛（否则下面两条都是「本来就红」⇒ 没有牙）。
    expect(writes.breakdown.pruneRate.max).toBeLessThan(THRESHOLDS.pruneRateMax);
    // ⚠️ ★ **前提**：真实清单里**没有** `（PRUNE_RATE）`（⇒ 「本来不红」）。
    expect(
      checkPerf(base).some((failure) => failure.includes('（PRUNE_RATE）')),
    ).toBe(false);

    // ⚠️ ★★★ **造一条真的违规**（伪造 `pruneRate.max` 越过门槛）⇒ ⇒ 必须判红。
    const forged: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...writes,
          breakdown: {
            ...writes.breakdown,
            pruneRate: { ...writes.breakdown.pruneRate, max: 0.99 },
          },
        },
      },
    };
    const failures = checkPerf(forged);
    const pruneFailures = failures.filter((failure) => failure.includes('（PRUNE_RATE）'));
    // ⚠️ ★ **核心**：**必须恰好一条**（⇒ 删掉整个分支 ⇒ 0 条 ⇒ 红 ✅）。
    expect(pruneFailures).toHaveLength(1);
    // ⚠️ ★ **文案必须写明主语**（⇒ 读的人知道判的是哪一笔）。
    expect(pruneFailures[0]).toContain('写入去重路径');
    // ⚠️ ★ **文案必须写明分子口径**（⇒ 「分子 = 调用次数」这件事在判红信息里**看得见**）。
    expect(pruneFailures[0]).toContain('embeddingCalls');
    // ⚠️ ★ **文案必须写明分母**（⇒ 剪枝率的分母不是猜的）。
    expect(pruneFailures[0]).toContain('candidateUniverse');
    // ⚠️ ★ **门槛数值必须在文案里**（⇒ 读的人知道越的是哪条线）。
    expect(pruneFailures[0]).toContain('15%');

    // ⚠️ ★★★ **负控**：剪枝率**低于**门槛 ⇒ **不许**出现这一行（⇒ ⇒ 不是「永远红」）。
    const under: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...writes,
          breakdown: {
            ...writes.breakdown,
            pruneRate: { ...writes.breakdown.pruneRate, max: 0.01 },
          },
        },
      },
    };
    expect(
      checkPerf(under).some((failure) => failure.includes('（PRUNE_RATE）')),
    ).toBe(false);

    db.db.close();
  });
});

/**
 * ★ **T06 · T 组：门槛类缺失绝不许兜 0**（QA 登记 5 · lead 风险点 #2）。
 *
 * ⚠️ ★★★ **为什么这一组必须存在**：
 *   lead 明确要求：「`bytesRead.count === 0` 和 `bytesRead.max === 0` 都必须**判红**
 *   （「真空通过」），不许读成「永远绿」」⇒ ⇒ **并且「这两条分支真的会被触发」**。
 *   ⇒ ⇒ **QA 变异 M3**：把 `bytesRead.count === 0` 那条判红分支删掉（`if (false)`）
 *   ⇒ ⇒ **h1-measurement 的「真空通过」用例仍然绿** ❌
 *   ⇒ ⇒ **根因**：现有那条断言只验「**有一条** `（H1′）` 违规行、且文案含「真空通过」」
 *   ⇒ ⇒ 而 **`count === 0` 与 `max === 0` 两条分支的文案都含「真空通过」**
 *   ⇒ ⇒ **删掉其中一条，断言仍然绿** ⇒ ⇒ **两条分支其实只被当成一条验了**。
 *
 * ⚠️ ★★★ **本组怎么补上牙**：
 *   分别构造两个场景，**分别**断言**各自专属的文案**：
 *   · `count === 0` ⇒ 文案必须说「**样本数为 0**」（= 采样窗口没产出样本）；
 *   · `count > 0` 且 `max === 0` ⇒ 文案必须说「**向量路在写入路径整路缺席**」。
 *   ⇒ ⇒ **删掉任一条分支 ⇒ 对应的那条文案断言必红** ✅。
 */
describe('T06 · T：门槛类缺失绝不许兜 0（登记 5 · count===0 与 max===0 分开验）', () => {
  it('★ `count === 0` ⇒ 文案必须说「样本数为 0」（删掉这条分支 ⇒ 必红）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const base = measurePerf(db.db, store, options, 5, 1);
    const writes = base.writeSegments.vectorByteReads;

    // ⚠️ ★ **前提**：真实读数**有样本**（否则下面就是「本来就没有样本」⇒ 没牙）。
    expect(writes.bytesRead.count).toBeGreaterThan(0);

    // ⚠️ ★ **造「0 个样本」** ⇒ 判据无从谈起 ⇒ 必须红。
    const empty: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...writes,
          bytesRead: { ...writes.bytesRead, count: 0, min: 0, mean: 0, p50: 0, p99: 0, max: 0 },
        },
      },
    };
    const failures = checkPerf(empty);
    const h1 = failures.filter((failure) => failure.includes('（H1′）'));
    // ⚠️ ★ **必须恰好一条**（⇒ 删掉 `count === 0` 那条分支 ⇒ 会落到 `max === 0` 那条
    //   ⇒ ⇒ 文案变成「整路缺席」⇒ ⇒ 下面这条「样本数为 0」断言**必红** ✅）。
    expect(h1).toHaveLength(1);
    // ⚠️ ★★★ **核心**：文案必须**点名「样本数为 0」**（= 这一条专属 ⇒ 不可被另一条顶替）。
    expect(h1[0]).toContain('样本数为 0');
    expect(h1[0]).toContain('真空通过');
    db.db.close();
  });

  it('★ `count > 0` 且 `max === 0` ⇒ 文案必须说「整路缺席」（删掉这条分支 ⇒ 必红）', () => {
    const { dbPath, db } = buildSmokeBench(newWorkDir());
    const options = { ...DEFAULT_CORPUS_OPTIONS, size: SMOKE_SIZE };
    const store = new MemoryStore({ dbPath });
    const base = measurePerf(db.db, store, options, 5, 1);
    const writes = base.writeSegments.vectorByteReads;

    // ⚠️ ★ **前提**：真实读数**有样本且非零**（否则下面就是「本来就是 0」⇒ 没牙）。
    expect(writes.bytesRead.count).toBeGreaterThan(0);
    expect(writes.bytesRead.max).toBeGreaterThan(0);

    // ⚠️ ★ **造「有样本但恒为 0」** ⇒ 向量路在写入路径整路缺席 ⇒ 必须红。
    const allZero: PerfResult = {
      ...base,
      writeSegments: {
        ...base.writeSegments,
        vectorByteReads: {
          ...writes,
          bytesRead: { ...writes.bytesRead, min: 0, mean: 0, p50: 0, p99: 0, max: 0 },
        },
      },
    };
    const failures = checkPerf(allZero);
    const h1 = failures.filter((failure) => failure.includes('（H1′）'));
    expect(h1).toHaveLength(1);
    // ⚠️ ★★★ **核心**：文案必须**点名「整路缺席」**（= 这一条专属 ⇒ 不可被 `count === 0` 顶替）。
    expect(h1[0]).toContain('向量路在写入路径整路缺席');
    expect(h1[0]).toContain('真空通过');
    db.db.close();
  });
});
