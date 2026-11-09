/**
 * ★★★ **T07 用 · QA 打红脚本（骨架）** —— T06「H1′ 字节口径」守卫的**可打红性**验证。
 *
 * ⚠️ ★ **为什么保留它**（工程师要求：T07 第一件事 = 1M 档复验那条字节恒等式）：
 *   这套「主动伪造违规输入 ⇒ 看守卫会不会报红」的编排逻辑**不该重写** ⇒ ⇒ 保留骨架。
 *
 * ⚠️ ★★ **三条硬纪律（本脚本自己踩过的坑，写在最前面）**：
 *   ① **不碰共享文件**：只读 + 纯函数调用 ⇒ ⇒ 零并发风险（**绝不**「临时改源码再还原」）。
 *   ② **先跑 ⇒ 再用 md5 卡快照 ⇒ 重跑一次确认** ⇒ ⇒ 否则会把「别人的 in-flight 中间态」
 *      误判成「仓库红了」（本轮真撞过：`scripts/check-mermaid-copies.ts` 的 `statSync`）。
 *   ③ **规模守卫先过**：1M 档灌库 ≈ 3 小时 ⇒ ⇒ **先跑小规模**（本脚本默认 1500）
 *      ⇒ ⇒ 脚本逻辑验完再放大 ⇒ ⇒ 别把「脚本 bug」当成「实现 bug」。
 *
 * ⚠️ ★ **T07 的三条预警（工程师给的，我复核过并补充了第 4 条）**：
 *   ① **不许用 `bucketMemberRows === candidateUniverse` 做 1M 档判据**
 *      ⇒ `candidateUniverse` = `COUNT(DISTINCT memory_id)` ⇒ 一个记忆落在多个命中桶时
 *      ⇒ 它**小于**成员行总数 ⇒ ⇒ 1M 规模下不成立 ⇒ ⇒ 拿它当判据 = **假绿**。
 *      ⇒ ⇒ **正确判据 = 逐样本 `bucketMemberRows === bucketMemberRowsDerived`**
 *      ⇒ ⇒（**与规模无关**：两侧都数 `vector_cell_members` 的**行数** ⇒ 结构上精确相等，
 *      ⇒ ⇒ 只在「`search()` 与 `route()` 命中的桶集合不同」时才不等 ⇒ 那正是它要抓的）。
 *   ② **软删不破坏这个相等**（工程师的预警偏保守 ⇒ 我核过两条 SQL）：
 *      · `readMemberIds`：`SELECT fine_id, memory_id FROM vector_cell_members WHERE fine_id = ?`
 *      · `countBucketMembers`：`SELECT COUNT(*) FROM vector_cell_members WHERE fine_id = ?`
 *      ⇒ ⇒ **两侧都不带 `deleted` 过滤** ⇒ ⇒ 对称 ⇒ ⇒ 软删**不会**让它们不等。
 *   ③ **ADR §8.6 的 4.44 MB 是【下界】** ⇒ ⇒ 1M 档实测 > 4.44 MB 属**预期**，不是回归
 *      ⇒ ⇒ **别把它当失败条件**，只当参照。
 *   ④ ★ **我补的第 4 条：1M 档 H1′ 的余量只有 ~29%** ⇒ 按小规模实测外推：
 *      候选宇宙 ≈ 5,521 行 ⇒ 码字节 ≈ 5,521 × 768 = 4,240,128 B
 *      ⇒ 加 survivors 两笔（scoreOf 一次 + Q4 整行一次，各 ≤ 20 × 3,072 B）
 *      ⇒ ⇒ **≈ 4,363,008 B vs 门槛 6,144,000 B ⇒ 只剩 ~29% 余量**
 *      ⇒ ⇒ ★ **1M 档必须实测，不能外推** ⇒ ⇒ 候选面稍涨就可能顶破。
 *
 * ⚠️ **零副作用**：只读 + 纯函数调用 ⇒ 不改任何仓库文件。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CORPUS_OPTIONS } from '../bench/corpus.js';
import { installRowReadCounter } from '../bench/lib/harness.js';
import { prepareBench } from '../bench/lib/db.js';
import { checkPerf, readSamplesAlignedOf, type PerfResult } from '../bench/perf.js';
import { DEFAULT_PARAMS } from '../src/core/params.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import {
  type DedupCandidateContext,
  collectVectorCandidates,
} from '../src/store/dedupCandidates.js';
import { blobToVector, loadCentroidModel } from '../src/vector/centroids.js';
import { normalizeNumbers } from '../src/vector/dot.js';

let passed = 0;
let failed = 0;
const lines: string[] = [];

function check(title: string, condition: boolean, detail: string): void {
  if (condition) {
    passed += 1;
    lines.push(`  ✅ **打红了**（守卫有牙） · ${title}\n       └ ${detail}`);
  } else {
    failed += 1;
    lines.push(`  ❌ **没打红**（恒绿守卫！） · ${title}\n       └ ${detail}`);
  }
}

function cs(count: number, value: number): PerfResult['writeSegments']['vectorCandidateRows'] {
  return { count, min: value, mean: value, p50: value, p99: value, max: value };
}

/** 合成基线（**全部达标** ⇒ 任何一条 failure 都只能来自伪造的那一处）。 */
function baseResult(): PerfResult {
  const bytes = cs(5, 1000);
  const block = (samplesAligned: boolean) => ({
    memoryRowsRead: cs(5, 40),
    codeRowsRead: cs(5, 20),
    bytesRead: bytes,
    candidateUniverse: cs(5, 20),
    breakdown: {
      codeBytes: cs(5, 20 * 768),
      embeddingBytes: cs(5, 40 * 3072),
      contentBytes: cs(5, 100),
      embeddingRowsRead: cs(5, 40),
      embeddingExactRows: cs(5, 20),
      embeddingCalls: cs(5, 25),
      narrowRowsRead: cs(5, 0),
      bucketMemberRows: cs(5, 20),
      badCodeRows: 0,
      unclassifiedRows: 0,
      unclassifiedSqlKinds: [] as string[],
      pruneRate: cs(5, 0.01),
      samplesAligned,
    },
    note: '合成基线（QA 打红实验用）',
  });
  return {
    corpusSize: 1_000_000,
    recallSamples: 5,
    writeSamples: 5,
    vectorRouteSamples: 5,
    warmupRounds: 1,
    firstWriteMs: 1,
    recallP99Ms: 1,
    writeP99Ms: 1,
    vectorRouteP99Ms: 1,
    vectorRouteShare: 0.1,
    recallVectorPath: {} as PerfResult['recallVectorPath'],
    vectorScanNote: '',
    candidateReadRows: cs(5, 100),
    candidateReadRowsBasis: {} as PerfResult['candidateReadRowsBasis'],
    hitFineBuckets: cs(5, 50),
    perRowReadCostUs: 1,
    recallLatency: {} as PerfResult['recallLatency'],
    writeLatency: {} as PerfResult['writeLatency'],
    vectorRouteLatency: {} as PerfResult['vectorRouteLatency'],
    vectorRouteByteReads: block(true),
    writeSegments: {
      vectorCandidateScan: {} as PerfResult['writeSegments']['vectorCandidateScan'],
      vectorCandidateRows: cs(5, 20),
      vectorByteReads: block(true),
      writeTotal: {} as PerfResult['writeSegments']['writeTotal'],
      otherMeanMs: 1,
      otherMeanShare: 0.1,
      note: '',
    },
  };
}

const clone = (r: PerfResult): PerfResult => structuredClone(r);

function forgeWriteBreakdown(
  result: PerfResult,
  patch: Partial<PerfResult['writeSegments']['vectorByteReads']['breakdown']>,
): PerfResult {
  const next = clone(result);
  const block = next.writeSegments.vectorByteReads;
  return {
    ...next,
    writeSegments: {
      ...next.writeSegments,
      vectorByteReads: { ...block, breakdown: { ...block.breakdown, ...patch } },
    },
  };
}

function forgeReadBreakdown(
  result: PerfResult,
  patch: Partial<PerfResult['vectorRouteByteReads']['breakdown']>,
): PerfResult {
  const next = clone(result);
  const block = next.vectorRouteByteReads;
  return { ...next, vectorRouteByteReads: { ...block, breakdown: { ...block.breakdown, ...patch } } };
}

lines.push('══ 第一部分 · `checkPerf()` 的守卫打红实验（纯函数层 · 不碰库） ══');
const base = baseResult();
const baseFailures = checkPerf(base);
check('前提：合成基线零 failure', baseFailures.length === 0, `failures = ${JSON.stringify(baseFailures)}`);

{
  const forged = clone(base);
  forged.writeSegments.vectorByteReads.bytesRead = {
    ...forged.writeSegments.vectorByteReads.bytesRead,
    count: 5,
    min: 0,
    mean: 0,
    p50: 0,
    p99: 0,
    max: 0,
  };
  const hits = checkPerf(forged).filter((f) => f.includes('（H1′）'));
  check(
    '① 伪造 bytesRead.max = 0（有样本）⇒ 判红「真空通过」',
    hits.length === 1 && hits[0]?.includes('真空通过') === true,
    `H1′ 违规行数 = ${hits.length}；文案 = ${JSON.stringify(hits[0])}`,
  );
}
{
  const forged = clone(base);
  forged.writeSegments.vectorByteReads.bytesRead = {
    ...forged.writeSegments.vectorByteReads.bytesRead,
    count: 0,
    min: 0,
    mean: 0,
    p50: 0,
    p99: 0,
    max: 0,
  };
  const hits = checkPerf(forged).filter((f) => f.includes('（H1′）'));
  check(
    '② 伪造 bytesRead.count = 0 ⇒ 判红「样本数为 0」',
    hits.length === 1 && hits[0]?.includes('真空通过') === true,
    `H1′ 违规行数 = ${hits.length}；文案 = ${JSON.stringify(hits[0])}`,
  );
}
{
  const hits = checkPerf(
    forgeWriteBreakdown(base, { unclassifiedRows: 7, unclassifiedSqlKinds: ['select id from memories'] }),
  ).filter((f) => f.includes('命中零来源') || f.includes('口径不完整'));
  check(
    '③ 伪造 unclassifiedRows = 7 ⇒ 判红「口径不完整」',
    hits.length >= 1,
    `违规行数 = ${hits.length}；文案 = ${JSON.stringify(hits[0])}`,
  );
}
{
  const hits = checkPerf(forgeWriteBreakdown(base, { badCodeRows: 3 })).filter(
    (f) => f.includes('坏码行') || f.includes('前提违例'),
  );
  check(
    '④ 伪造 badCodeRows = 3 ⇒ 判红「前提违例」',
    hits.length >= 1,
    `违规行数 = ${hits.length}；文案 = ${JSON.stringify(hits[0])}`,
  );
}
{
  const hits = checkPerf(forgeWriteBreakdown(base, { samplesAligned: false })).filter((f) =>
    f.includes('不可判定'),
  );
  check(
    '⑤a 伪造写路径 samplesAligned = false ⇒ 判红「不可判定」',
    hits.length >= 1,
    `违规行数 = ${hits.length}；文案 = ${JSON.stringify(hits[0])}`,
  );
  const readHits = checkPerf(forgeReadBreakdown(base, { samplesAligned: false })).filter((f) =>
    f.includes('不可判定'),
  );
  check(
    '⑤b 伪造读路径 samplesAligned = false ⇒ 判红「不可判定」',
    readHits.length >= 1,
    `违规行数 = ${readHits.length}；文案 = ${JSON.stringify(readHits[0])}`,
  );
}
check(
  '⑥a readSamplesAlignedOf([1,2,3],[1,2,4]) ⇒ false',
  readSamplesAlignedOf([1, 2, 3], [1, 2, 4]) === false,
  `实际 = ${readSamplesAlignedOf([1, 2, 3], [1, 2, 4])}`,
);
check(
  '⑥b readSamplesAlignedOf([1,2,3],[1,null,3]) ⇒ false',
  readSamplesAlignedOf([1, 2, 3], [1, null, 3]) === false,
  `实际 = ${readSamplesAlignedOf([1, 2, 3], [1, null, 3])}`,
);
check(
  '⑥c readSamplesAlignedOf([1,2,3],[1,2,3]) ⇒ true（正控：证明它不是恒 false）',
  readSamplesAlignedOf([1, 2, 3], [1, 2, 3]) === true,
  `实际 = ${readSamplesAlignedOf([1, 2, 3], [1, 2, 3])}`,
);
{
  const forged = clone(base);
  forged.writeSegments.vectorByteReads.bytesRead = {
    ...forged.writeSegments.vectorByteReads.bytesRead,
    max: 99_999_999,
  };
  const failures = checkPerf(forged);
  const oldTag = failures.filter((f) => f.includes('（H1）') || f.includes('（H2）'));
  const newTag = failures.filter((f) => f.includes('（H1′）') || f.includes('（H2′）'));
  check(
    '⑦a 旧标签 `（H1）`/`（H2）` 在 checkPerf 的 failures 里零命中',
    oldTag.length === 0,
    `旧标签命中数 = ${oldTag.length}`,
  );
  check('⑦b 新标签 `（H1′）`/`（H2′）` 必须出现', newTag.length >= 2, `新标签命中数 = ${newTag.length}`);
}
{
  const hits = checkPerf(forgeWriteBreakdown(base, { pruneRate: cs(5, 0.5) })).filter((f) =>
    f.includes('（PRUNE_RATE）'),
  );
  check(
    '⑧a 伪造 pruneRate.max = 0.5 ⇒ 判红且标签含 `（PRUNE_RATE）`',
    hits.length === 1,
    `违规行数 = ${hits.length}；文案 = ${JSON.stringify(hits[0])}`,
  );
  const clean = checkPerf(base).filter((f) => f.includes('（PRUNE_RATE）'));
  check('⑧b 剪枝率合格时不许出现 PRUNE_RATE 违规行（负控）', clean.length === 0, `违规行数 = ${clean.length}`);
}
{
  const forged = clone(base);
  forged.writeSegments.vectorCandidateRows = cs(5, 999_999);
  const hits = checkPerf(forged).filter(
    (f) => f.includes('候选读取行数') || f.includes('vectorCandidateRows'),
  );
  check('⑨ 旧行数判据量推到 999,999 行 ⇒ 不进 failures（已降级）', hits.length === 0, `命中数 = ${hits.length}`);
  const { THRESHOLDS } = await import('../bench/perf.js');
  check(
    '⑨b 旧常量 `candidateReadRowsMax` / `candidateReadRowsRatioMax` 保留不删',
    THRESHOLDS.candidateReadRowsMax === 2000 && THRESHOLDS.candidateReadRowsRatioMax === 0.002,
    `candidateReadRowsMax = ${THRESHOLDS.candidateReadRowsMax}；candidateReadRowsRatioMax = ${THRESHOLDS.candidateReadRowsRatioMax}`,
  );
}

lines.push('');
lines.push('══ 第二部分 · 计数器层的打红实验（真库 · 生产 SQL） ══');

const workDir = mkdtempSync(join(tmpdir(), 'qa-t06-redlight-'));
const dbPath = join(workDir, 'redlight.db');
const prepared = prepareBench({
  dbPath,
  corpus: { ...DEFAULT_CORPUS_OPTIONS, size: 1500 },
  coarseCenters: 8,
  fineCenters: 40,
  nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE,
});
const db = prepared.db;

{
  const counter = installRowReadCounter(db);
  const before = counter.snapshot();
  counter.start();
  db.prepare('SELECT id FROM memories LIMIT 3').all();
  counter.stop();
  const after = counter.snapshot();
  check(
    '⑩ 喂未登记形状 `SELECT id FROM memories` ⇒ 落进 unclassified（行数 = 3）',
    after.unclassifiedRows - before.unclassifiedRows === 3,
    `unclassifiedRows 增量 = ${after.unclassifiedRows - before.unclassifiedRows}；字节增量 = ${after.bytesRead - before.bytesRead}；指纹 = ${JSON.stringify(after.unclassifiedSqlKinds)}`,
  );
  check(
    '⑩b 未登记形状 ⇒ 一个字节都不认领',
    after.bytesRead - before.bytesRead === 0,
    `bytesRead 增量 = ${after.bytesRead - before.bytesRead}`,
  );
  counter.uninstall();
}
{
  const model = loadCentroidModel(db);
  const context: DedupCandidateContext = {
    db,
    params: DEFAULT_PARAMS,
    buckets: { db, centroids: () => model, nprobeCoarse: DEFAULT_PARAMS.ROUTER_NPROBE_COARSE },
  };
  const row = db
    .prepare('SELECT embedding FROM memories WHERE deleted = 0 AND embedding IS NOT NULL LIMIT 1')
    .get() as { embedding: Buffer };
  const vector = normalizeNumbers(Array.from(blobToVector(row.embedding)));
  const counter = installRowReadCounter(db);
  const before = counter.snapshot();
  counter.start();
  const scan = collectVectorCandidates(context, vector);
  counter.stop();
  const after = counter.snapshot();
  check(
    '⑪ 生产写路径扫描 ⇒ unclassifiedRows 增量 = 0',
    after.unclassifiedRows - before.unclassifiedRows === 0,
    `增量 = ${after.unclassifiedRows - before.unclassifiedRows}；指纹 = ${JSON.stringify(after.unclassifiedSqlKinds)}`,
  );
  check(
    '⑪b 写路径 `bucketMemberRows === candidateUniverse`（断言 1e）',
    after.bucketMemberRowsRead - before.bucketMemberRowsRead === scan.scanned,
    `${after.bucketMemberRowsRead - before.bucketMemberRowsRead} vs ${scan.scanned}`,
  );
  check(
    '⑪c `embeddingCalls` ≥ `embeddingExactRows`（断言 1c-bench 字面形式）',
    after.embeddingCalls - before.embeddingCalls >= after.embeddingExactRows - before.embeddingExactRows,
    `embeddingCalls = ${after.embeddingCalls - before.embeddingCalls}；embeddingExactRows = ${after.embeddingExactRows - before.embeddingExactRows}`,
  );
  counter.uninstall();
}
{
  const store = new MemoryStore({ dbPath });
  const { measurePerf } = await import('../bench/perf.js');
  const result = measurePerf(db, store, { ...DEFAULT_CORPUS_OPTIONS, size: 1500 }, 5, 5);
  const w = result.writeSegments.vectorByteReads;
  const r = result.vectorRouteByteReads;
  check('⑫a 写路径 bytesRead 有样本且 > 0', w.bytesRead.count > 0 && w.bytesRead.max > 0, `count = ${w.bytesRead.count}；max = ${w.bytesRead.max}`);
  check('⑫b 写路径 samplesAligned = true', w.breakdown.samplesAligned === true, `samplesAligned = ${w.breakdown.samplesAligned}`);
  check('⑫c 读路径 samplesAligned = true（新语义）', r.breakdown.samplesAligned === true, `samplesAligned = ${r.breakdown.samplesAligned}`);
  check('⑫d 两路径 unclassifiedRows 均为 0', w.breakdown.unclassifiedRows === 0 && r.breakdown.unclassifiedRows === 0, `写 = ${w.breakdown.unclassifiedRows}；读 = ${r.breakdown.unclassifiedRows}`);
  check('⑫e 两路径 badCodeRows 均为 0', w.breakdown.badCodeRows === 0 && r.breakdown.badCodeRows === 0, `写 = ${w.breakdown.badCodeRows}；读 = ${r.breakdown.badCodeRows}`);
  check('⑫f 断言 1：bytesRead.max === codeBytes.max + embeddingBytes.max', w.bytesRead.max === w.breakdown.codeBytes.max + w.breakdown.embeddingBytes.max, `${w.bytesRead.max} vs ${w.breakdown.codeBytes.max} + ${w.breakdown.embeddingBytes.max}`);
  check('⑫g 断言 1b：bytesRead.max === codeRowsRead.max×768 + memoryRowsRead.max×3072', w.bytesRead.max === w.codeRowsRead.max * 768 + w.memoryRowsRead.max * 3072, `${w.bytesRead.max} vs ${w.codeRowsRead.max}×768 + ${w.memoryRowsRead.max}×3072`);
  check('⑫h breakdown 恰好 13 项', Object.keys(w.breakdown).length === 13, `实际 ${Object.keys(w.breakdown).length} 项：${JSON.stringify(Object.keys(w.breakdown))}`);
  check('⑫i 四个读数用 ADR §8.5 原名', ['memoryRowsRead', 'codeRowsRead', 'bytesRead', 'candidateUniverse'].every((k) => k in w), `键 = ${JSON.stringify(Object.keys(w))}`);
  const failures = checkPerf(result);
  const oldTag = failures.filter((f) => f.includes('（H1）') || f.includes('（H2）'));
  const newTag = failures.filter((f) => f.includes('（H1′）') || f.includes('（H2′）'));
  check('⑫j 真实 failures 里旧标签命中数 = 0', oldTag.length === 0, `全部 failures = ${JSON.stringify(failures)}`);
  check('⑫k 真实 failures 里新标签 `（H2′）` 必须出现', newTag.some((f) => f.includes('（H2′）')), `命中数 = ${newTag.length}`);
  check('⑫k2 小库上 H1′ 合法地绿（不许误报）', newTag.every((f) => !f.includes('（H1′）')), `bytesRead.max = ${w.bytesRead.max}`);
  const forgedReal = clone(result);
  forgedReal.writeSegments.vectorByteReads.bytesRead = {
    ...forgedReal.writeSegments.vectorByteReads.bytesRead,
    max: 99_999_999,
  };
  check('⑫k3 真实结果上伪造 bytesRead.max = 99,999,999 ⇒ H1′ 立刻红', checkPerf(forgedReal).filter((f) => f.includes('（H1′）')).length === 1, `H1′ 违规行数 = ${checkPerf(forgedReal).filter((f) => f.includes('（H1′）')).length}`);
  // ★ **T07 的核心等式**（1M 档要复验的那条）：把两条占比都打出来。
  lines.push(
    `  ── T07 关注 ── bytesRead.max = ${w.bytesRead.max} B；门槛 6,144,000 B ⇒ 余量 ${(((6_144_000 - w.bytesRead.max) / 6_144_000) * 100).toFixed(1)}%`,
  );
  lines.push(
    `  ── codeRowsRead.max = ${w.codeRowsRead.max}；memoryRowsRead.max = ${w.memoryRowsRead.max}；候选宇宙 max = ${w.candidateUniverse.max}`,
  );
  db.close();
}

console.log(lines.join('\n'));
console.log('');
console.log(`══════ 打红实验汇总：通过 ${passed} / 失败 ${failed} ══════`);
process.exitCode = failed === 0 ? 0 : 1;
