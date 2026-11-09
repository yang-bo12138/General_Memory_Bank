/**
 * ★ 只读自检：**从落盘 JSON 里抽出本轮任务书要的每一个量**（一条都不许漏）。
 *
 * ⚠️ 只读：只 `readFileSync` + `JSON.parse` ⇒ 不碰库、不跑 bench。
 * 用法：pnpm exec tsx .tmp/extract-t07-metrics.ts <json 路径> …
 */
import { readFileSync } from 'node:fs';

interface Summary {
  readonly count: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

interface ByteReads {
  readonly memoryRowsRead: Summary;
  readonly codeRowsRead: Summary;
  readonly bytesRead: Summary;
  readonly candidateUniverse: Summary;
  readonly breakdown: {
    readonly codeBytes: Summary;
    readonly embeddingBytes: Summary;
    readonly contentBytes: Summary;
    readonly embeddingRowsRead: Summary;
    readonly embeddingExactRows: Summary;
    readonly embeddingCalls: Summary;
    readonly narrowRowsRead: Summary;
    readonly bucketMemberRows: Summary;
    readonly badCodeRows: number;
    readonly unclassifiedRows: number;
    readonly unclassifiedSqlKinds: string[];
    readonly pruneRate: Summary;
    readonly samplesAligned: boolean;
  };
}

interface PerfJson {
  readonly corpusSize: number;
  readonly trainedCells: number;
  readonly trainedMembers: number;
  readonly pageCacheState: { readonly declared: string; readonly note?: string };
  readonly storageMedia: { readonly mode: string; readonly note?: string };
  readonly failures: string[];
  readonly machine?: Record<string, unknown>;
  readonly phases?: Record<string, unknown>;
  readonly recallP99Ms: number;
  readonly writeP99Ms: number;
  readonly vectorRouteP99Ms: number;
  readonly vectorRouteShare: number;
  readonly candidateReadRows: Summary;
  readonly hitFineBuckets: Summary;
  readonly writeSegments: {
    readonly vectorCandidateRows: Summary;
    readonly vectorByteReads: ByteReads;
  };
  readonly vectorRouteByteReads: ByteReads;
}

const format = (s: Summary): string =>
  `count=${s.count} min=${s.min} mean=${s.mean.toFixed(1)} p50=${s.p50} p99=${s.p99} max=${s.max}`;

for (const path of process.argv.slice(2)) {
  const json = JSON.parse(readFileSync(path, 'utf8')) as PerfJson;
  const w = json.writeSegments.vectorByteReads;
  const r = json.vectorRouteByteReads;
  const bd = w.breakdown;

  console.log(`\n==================== ${path} ====================`);
  console.log(`【规模自证】corpusSize=${json.corpusSize}  trainedCells=${json.trainedCells}  trainedMembers=${json.trainedMembers}`);
  console.log(`【档位声明】pageCacheState=${JSON.stringify(json.pageCacheState)}`);
  console.log(`【存储介质】storageMedia=${JSON.stringify(json.storageMedia)}`);
  console.log(`【failures】${json.failures.length === 0 ? '（空 ⇒ 无门槛未达标）' : ''}`);
  for (const f of json.failures) {
    console.log(`   ✗ ${f}`);
  }
  console.log('──── 写路径（H1′ / H2′ / PRUNE_RATE 的判据量）────');
  console.log(`  ★ bytesRead.max          = ${w.bytesRead.max} B      [门槛 ≤ 6,144,000 B]  ${format(w.bytesRead)}`);
  console.log(`  ★ candidateUniverse.max   = ${w.candidateUniverse.max} 行   [破点参考 7,838 / 7,960]  ${format(w.candidateUniverse)}`);
  console.log(`  ★ codeRowsRead.max        = ${w.codeRowsRead.max} 行   ${format(w.codeRowsRead)}`);
  console.log(`  ★ memoryRowsRead.max      = ${w.memoryRowsRead.max} 行   ${format(w.memoryRowsRead)}`);
  console.log(`  ★ pruneRate.max           = ${(bd.pruneRate.max * 100).toFixed(2)}%   [门槛 ≤ 15%]  ${format(bd.pruneRate)}`);
  console.log(`  ★ embeddingCalls.max      = ${bd.embeddingCalls.max}   ${format(bd.embeddingCalls)}`);
  console.log(`  ★ embeddingExactRows.max  = ${bd.embeddingExactRows.max}   ${format(bd.embeddingExactRows)}`);
  console.log(`  ★ embeddingRowsRead.max   = ${bd.embeddingRowsRead.max}   ${format(bd.embeddingRowsRead)}`);
  console.log(`  ★ bucketMemberRows.max    = ${bd.bucketMemberRows.max}   ${format(bd.bucketMemberRows)}`);
  console.log(`  ★ narrowRowsRead.max      = ${bd.narrowRowsRead.max}   ${format(bd.narrowRowsRead)}`);
  console.log(`  ★ codeBytes.max           = ${bd.codeBytes.max}   ${format(bd.codeBytes)}`);
  console.log(`  ★ embeddingBytes.max      = ${bd.embeddingBytes.max}   ${format(bd.embeddingBytes)}`);
  console.log(`  ★ contentBytes.max        = ${bd.contentBytes.max}   ${format(bd.contentBytes)}`);
  console.log(`  ★ unclassifiedRows        = ${bd.unclassifiedRows}   [必须 0]`);
  console.log(`  ★ badCodeRows             = ${bd.badCodeRows}   [必须 0]`);
  console.log(`  ★ unclassifiedSqlKinds    = ${JSON.stringify(bd.unclassifiedSqlKinds)}`);
  console.log(`  ★ samplesAligned（写路径）  = ${bd.samplesAligned}   [必须 true]`);
  console.log(`  ★ 旧行数（观测值）vectorCandidateRows.max = ${json.writeSegments.vectorCandidateRows.max} 行`);
  console.log('──── 判据计算（用落盘值自己算一遍）────');
  const h1 = w.bytesRead.max;
  const h2 = json.corpusSize > 0 ? h1 / (json.corpusSize * 3072) : 0;
  console.log(`  H1′ bytesRead.max              = ${h1} B  vs 门槛 6,144,000 B  ⇒ ${h1 <= 6_144_000 ? '绿' : '红'}（余量 ${(((6_144_000 - h1) / 6_144_000) * 100).toFixed(1)}%）`);
  console.log(`  H2′ bytesRead.max ÷ (corpus×3072) = ${(h2 * 100).toFixed(4)}%  vs 门槛 0.2%  ⇒ ${h2 <= 0.002 ? '绿' : '红'}`);
  console.log(`  PRUNE_RATE pruneRate.max        = ${(bd.pruneRate.max * 100).toFixed(2)}%  vs 门槛 15%  ⇒ ${bd.pruneRate.max <= 0.15 ? '绿' : '红'}`);
  console.log(`  恒等式 bytesRead = codeBytes + embeddingBytes（max）: ${w.bytesRead.max} vs ${bd.codeBytes.max}+${bd.embeddingBytes.max} = ${bd.codeBytes.max + bd.embeddingBytes.max}`);
  console.log('──── 读路径（观测值 · 不判门槛）────');
  console.log(`  bytesRead.max = ${r.bytesRead.max}   candidateUniverse.max = ${r.candidateUniverse.max}   samplesAligned = ${r.breakdown.samplesAligned}`);
  console.log(`  unclassifiedRows = ${r.breakdown.unclassifiedRows}   badCodeRows = ${r.breakdown.badCodeRows}`);
  console.log('──── 毫秒参考线（介质相关 · 不作判据）────');
  console.log(`  recallP99Ms=${json.recallP99Ms.toFixed(3)}  writeP99Ms=${json.writeP99Ms.toFixed(3)}  vectorRouteP99Ms=${json.vectorRouteP99Ms.toFixed(3)}  vectorRouteShare=${(json.vectorRouteShare * 100).toFixed(2)}%`);
  console.log(`  candidateReadRows(R6 观测) = ${format(json.candidateReadRows)}   hitFineBuckets = ${format(json.hitFineBuckets)}`);
}
