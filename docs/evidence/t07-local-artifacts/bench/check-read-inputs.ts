/**
 * ★ 只读自检：`readSamplesAlignedInputs()` 的接线**可被按【来源】验证**
 *   （⇒ 这正是「登记 2/3」两条守卫要用的形态）。
 *
 * ⚠️ ★ **不变量**：`measured` 必须来自 `bucketMemberRows`、
 *   `derived` 必须来自 `bucketMemberRowsDerived` ⇒ ⇒ **两者取自不同的列**
 *   ⇒ ⇒ 改 `candidateUniverse` **不许**影响 `measured`（⇒ ⇒ 证明它看的是那一列）。
 */
import { readSamplesAlignedInputs } from '../bench/perf.ts';
import type { VectorByteSample } from '../bench/perf.ts';

const base: VectorByteSample = {
  memoryRowsRead: 0,
  codeRowsRead: 0,
  bytesRead: 0,
  candidateUniverse: 941,
  codeBytes: 0,
  embeddingBytes: 0,
  contentBytes: 0,
  embeddingRowsRead: 0,
  embeddingExactRows: 0,
  embeddingCalls: 0,
  narrowRowsRead: 0,
  bucketMemberRows: 941,
  bucketMemberRowsDerived: 941,
  badCodeRows: 0,
  unclassifiedRows: 0,
  unclassifiedSqlKinds: [],
  legacyCandidateRows: 0,
  legacyCodeRows: 0,
};

// ★ 守卫 1：把 `candidateUniverse` 改成与 `bucketMemberRows` 不同 ⇒ `measured` 仍等于 `bucketMemberRows`。
const mutatedUniverse: VectorByteSample = { ...base, candidateUniverse: 7 };
const a = readSamplesAlignedInputs([base]);
const b = readSamplesAlignedInputs([mutatedUniverse]);
console.log(
  `守卫 1 · candidateUniverse 改成 7 后 measured 仍是 bucketMemberRows：${b.measured[0] === mutatedUniverse.bucketMemberRows}（measured=${b.measured[0]} / bucketMemberRows=${mutatedUniverse.bucketMemberRows}）`,
);

// ★ 守卫 2：把 `bucketMemberRowsDerived` 改成与 `bucketMemberRows` 不同 ⇒ `derived` 仍等于 `bucketMemberRowsDerived`。
const mutatedDerived: VectorByteSample = { ...base, bucketMemberRowsDerived: 7 };
const c = readSamplesAlignedInputs([mutatedDerived]);
console.log(
  `守卫 2 · bucketMemberRowsDerived 改成 7 后 derived 仍是那一列：${c.derived[0] === mutatedDerived.bucketMemberRowsDerived}（derived=${c.derived[0]}）`,
);

// ★ 守卫 3：`measured` 与 `derived` **取自不同的列**（⇒ 不是自比较）。
console.log(
  `守卫 3 · measured 与 derived 不是同一列（source 不同）：${a.measured[0] === a.derived[0]}（数值恰好相等，但来源不同 ⇒ 靠列断言才能抓住自比较）`,
);

// ★ 守卫 4：逐样本配对（长度一致、顺序一致）。
const two: VectorByteSample[] = [
  { ...base, bucketMemberRows: 10, bucketMemberRowsDerived: 10 },
  { ...base, bucketMemberRows: 20, bucketMemberRowsDerived: 21 },
];
const d = readSamplesAlignedInputs(two);
console.log(
  `守卫 4 · 逐样本配对：measured=[${d.measured.join(',')}] derived=[${d.derived.join(',')}]（长度 ${d.measured.length}/${d.derived.length}）`,
);

// ★ `null`（= 没算 ⇒ 不可判定）必须原样传下去（判定逻辑在 `readSamplesAlignedOf()` 里）。
const withNull: VectorByteSample = { ...base, bucketMemberRowsDerived: null };
const e = readSamplesAlignedInputs([withNull]);
console.log(`守卫 5 · null 原样透传：${e.derived[0] === null}`);
