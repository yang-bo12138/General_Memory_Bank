/**
 * ★ T11 守卫 · v3 · ★★★ 【表格结构盲区】的机器守护 ★★★
 *
 * ★★★ **v3 的起因（★ QA 独立回归实测出的真盲区 · ★ 我独立复现确认）** ★★★：
 *   · QA 实测：我在表二的**中间**插了一段非表格行（★ 段落被放在 `| **int4** |` 行之后、
 *     `| **二值（1 bit/维）** |` 行之前）⇒ ⇒ ★ **它把表二整张表切断了**
 *     ⇒ ⇒ ⇒ **「二值」行与「PQ」行掉出表格 ⇒ 表二实际只剩 int4 一行在表里**。
 *   · ★★ **门禁抓不到（★ QA 实测）**：★ `check:benchmark-numbers` / `check:wording-drift` /
 *     `check:mermaid-copies` / `audit:tier-qualifiers` / `check:t11-int4-row` / `check:doc-counts`
 *     ⇒ ⇒ ★★ **全部 exit 0** ⇒ ⇒ ★★ **没有任何守卫检查 markdown 表格结构**。
 *   · ⇒ ⇒ ★★ **这比「不登记 2000 行档上限」严重得多 —— 它把表本身弄坏了** ⇒ ⇒ ★★ 必须机器守护。
 *
 * ★★★ **v3 的断言（★ 在 v1 / v2 之上追加）** ★★★：
 *   ⑦ ★★ **R3 行内所有 markdown 表格的【逻辑行】必须都是表格行**（★ 表格不许被段落打断）
 *      · R3 行是**单行巨行**（★ 内部用 `<br>` 拆成 51 条「逻辑行」）⇒ ⇒ 表格是**嵌在单元格里的**。
 *      · 判据：★ 一个表格块 = 「表头行 + 紧邻的分隔行 + 后续连续的表格行」；
 *        ★ **块内每行的单元格数必须 == 表头列数**；
 *        ★ ★ **块结束后若紧接着又出现表格行 ⇒ 说明有表格行被段落「挤」出了表 ⇒ ⇒ 判红**。
 *      · ★ 这正是 QA 实测的那个缺陷形态（表头 · 分隔 · int4 · **段落** · 二值 · PQ ⇒ 二值/PQ 游离）。
 *   ⑧ **本轮新增的实测数据必须在位**（★ QA 建议 · ★ 逐位）：
 *      · 阈值扫描反例（★ 证明「无分辨力」是 threshold 取值巧合、不是结构性）：0/200 · **1/200** · **197/200** …
 *      · 无翻转的严格形式：**cos_true ≥ 0.782211** vs 实测 **≤ 0.706677** · 上界 **0.713386** / **0.819994** · 差 **0.100006**
 *      · 口径 A 的边界：**首个有差异的候选宇宙规模 = 62** · 写 **0 / 200** · 读 **0 / 100** · **规模【非单调】**
 *      · 口径 B 必须被标明是 **1M 库 · 单桶 · 桶首行自命中查询**（★ 不是本轮口径）
 *   ⑨ ★ **旧表述必须已消失**（★ 防「旧结论」被误当成现行结论）：
 *      · 「被阈值【完全掩盖】」· 「有效边界 = 候选宇宙 ≳ 35 行」· 「问题在【规模】不在【接线】」
 *
 * ★ **链外还是链内**：★ **链外**（★ 不进 `verify` · ★ 纪律 5：门禁链 18 段本批不加段）
 *   ⇒ ⇒ `pnpm run check:t11-int4-row` 可独立运行。
 */
import { readFileSync } from 'node:fs';

const DOC = 'docs/design/perf-c2-admissible-two-stage.md';
const EVIDENCE_INT4 = 'docs/evidence/t11-int4-2000.json';
const EVIDENCE_INT8 = 'docs/evidence/t11-int8-2000.json';

/** ★ int8 行的基线（★ 逐字节 · 取自 T11 之前的最后一个提交 `6465d81`）。 */
const INT8_BASELINE =
  '| **int8** | **768 B** | min **0.004486** · p50 **0.005477** · p90 **0.005838** · p99 **0.006155** · p999 **0.006375** · max **0.006793** | min 0.000000 · p50 **0.000274** · p99 **0.012500** · max **0.037037** | **1,800.45 ms** / **4,540.64 ms**（HDD · warm）|';

/* ★★ 支撑证据数值（★ 全部来自实测） ★★ */

/** ★ int4 行的 ε 分布（★ 实测码表值 · 表一 ε 列一个都不许改）。 */
const INT4_EPS_CELL =
  'min **0.080736** · p50 **0.099353** · p90 **0.105900** · p99 **0.111635** · p999 **0.115554** · max **0.126871**';

/** ★ 决定性证据（★ 「两档阈值判定跨过 0.92 的行数」= 0 / 5,986）。 */
const EVIDENCE_DECISION = '0 / 5,986';

/** ★ 三档实测余弦（★ 含全部行 / 排除写压测行 / 纯语料行）。 */
const COSINE_TRIPLE = ['1.000000', '0.675913', '0.204562'];

/** ★ 混档占比（★ 落盘写路径 / 去重 / 读路径 / benchQ×写探针）。 */
const MIXED_RATIOS = ['37.19%', '18.56%', '8.79%', '9.38%'];

/** ★ 「混档落差」段落的存在性标记（★ ★ 防「整理文档」静默丢失）。 */
const MIXED_SECTION_MARK = '混档落差';

/** ★ 生产召回口径（k=60）下的可分辨性（★ QA 指出的反例 · ★ 必须登记）。 */
const K60_EVIDENCE = ['54.4900', '55.1500', '12 / 100'];

/** ★ 1M 档的延迟数值（★ ★ 跨档不可比 ⇒ ★ 不许出现在 int4 行的延迟格里）。 */
const ONE_MILLION_LATENCY = ['1,800.45', '4,540.64'];

/** ★★★ v3 · 阈值扫描反例（★ 证明「无分辨力」是 threshold 取值巧合 ⇒ 不是结构性、不是规模问题） ★★★ */
const THRESHOLD_SCAN_EVIDENCE = ['0.92', '0/200', '1/200', '197/200'];

/** ★★★ v3 · 无翻转的严格形式（★ QA 建议的形式 · ★ 逐位） ★★★ */
const STRICT_FORM_EVIDENCE = [
  '0.782211', // ★ 由 margin4 ≤ 0.137789 推出的「要翻转必须有 cos_true ≥」
  '0.706677', // ★ 实测非自命中行 cos_true max
  '0.713386', // ★ 非自命中行 int8 上界 max
  '0.819994', // ★ 非自命中行 int4 上界 max
  '0.100006', // ★ 两档上界离阈值还差的量
  '0.137789', // ★ margin4 max
  '0.007378', // ★ margin8 max
];

/** ★★★ v3 · 口径 A 的边界（★ 落盘口径 · 本轮凭据的数据源） ★★★ */
const CALIBER_A_EVIDENCE = [
  '首个有差异的候选宇宙规模 = 62',
  '0 / 200 样本有差异',
  '0 / 100 样本有差异',
  '规模【非单调】',
];

/** ★★★ v3 · 口径 B 必须被标明是 1M 库单桶自命中口径（★ 不是本轮口径） ★★★ */
const CALIBER_B_MARK = '口径 B = 1M 库 · 单桶 · 桶首行自命中查询';

/** ★★★ v3 · 旧表述必须已消失 ★★★ */
const STALE_PHRASES = [
  '被阈值【完全掩盖】',
  '有效边界 = 候选宇宙 ≳ 35 行',
  '问题在【规模】不在【接线】',
];

const issues: string[] = [];

const doc = readFileSync(DOC, 'utf8');
const lines = doc.split('\n');
const r3Line = lines.find((l) => l.startsWith('| **R3** |')) ?? '';
const statusLine = lines.find((l) => l.startsWith('> | ② |')) ?? '';

if (r3Line === '') issues.push(`找不到 R3 行（${DOC}）`);
if (statusLine === '') issues.push(`找不到 §7 状态表第 ② 行（${DOC}）`);

/* ── ① int8 行逐字节不变 ── */
const seg = (text: string, mark: string): string | null => {
  const i = text.indexOf(mark);
  if (i < 0) return null;
  const s = text.slice(i);
  const e = s.indexOf('<br>');
  return e < 0 ? s : s.slice(0, e);
};
const int8Now = seg(r3Line, '| **int8** |');
if (int8Now !== INT8_BASELINE) {
  issues.push(
    `int8 行与基线不一致（★ D6「逐字不变」被破坏）\n  基线: ${INT8_BASELINE}\n  现值: ${int8Now ?? '（找不到 int8 行）'}`,
  );
}

/* ── ② int4 行的剪枝率列必须写「无分辨力」 · 不许填数 ── */
const int4Row = seg(r3Line, '| **int4** |');
if (int4Row === null) {
  issues.push('R3 行里找不到表一的 int4 行');
} else {
  const cells = int4Row
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  const pruneCell = cells[3] ?? '';
  if (!pruneCell.includes('无分辨力')) {
    issues.push(
      `表一 int4 行的【剪枝率】列必须写「无分辨力」（★ 不许填一个数）\n  现值: ${pruneCell}\n  理由: 2000 行档的剪枝率 ≡ 1/candidateUniverse（几何常数 ⇒ 零码宽信息）⇒ 填进去就是假数`,
    );
  }
  if (/0\.0714|0\.07142|7\.14/.test(pruneCell)) {
    issues.push(
      '表一 int4 行的剪枝率列出现了那个【几何常数】的值 ⇒ 那是假数（★ 它与 int8 逐位相同 ⇒ 零码宽信息）',
    );
  }

  /* ── ③ 延迟列必须带档位标注 + 数值必须是本档实测值 + 不许出现 1M 档数值 ── */
  const latencyCell = cells[4] ?? '';
  if (!latencyCell.includes('warm') || !latencyCell.includes('unknown')) {
    issues.push(
      `表一 int4 行的【延迟】列必须带「介质 × 页缓存」档位标注（★ 本档 = unknown · warm）\n  现值: ${latencyCell}`,
    );
  }
  if (!latencyCell.includes('2000')) {
    issues.push(
      `表一 int4 行的【延迟】列必须标明是 2000 行档（★ ⇒ 与 1M 档不可比）\n  现值: ${latencyCell}`,
    );
  }
  if (!latencyCell.includes('13.68')) {
    issues.push(
      `表一 int4 行的【延迟】列必须写本档实测值 13.68 ms（★ 凭据 writeP99Ms = 13.6803）\n  现值: ${latencyCell}`,
    );
  }
  if (!latencyCell.includes('4.20')) {
    issues.push(
      `表一 int4 行的【延迟】列必须写本档实测值 4.20 ms（★ 凭据 vectorRouteP99Ms = 4.1985）\n  现值: ${latencyCell}`,
    );
  }
  for (const value of ONE_MILLION_LATENCY) {
    if (latencyCell.includes(value)) {
      issues.push(
        `表一 int4 行的【延迟】列出现了 1M 档的延迟数值 ${value} ⇒ ★ 跨档不可比（★ 本档 = 2000 行档）\n  现值: ${latencyCell}`,
      );
    }
  }

  /* ── ε 列必须等于实测分布 ── */
  const epsCell = cells[2] ?? '';
  if (!epsCell.includes(INT4_EPS_CELL)) {
    issues.push(
      `表一 int4 行的【ε】列与实测分布不一致（★ 实测码表值）\n  期望: ${INT4_EPS_CELL}\n  现值: ${epsCell}`,
    );
  }
}

/* ── ④ 两份凭据的剪枝率必须逐位相同（★ 这是「无分辨力」的机器证据） ── */
try {
  const int4 = JSON.parse(readFileSync(EVIDENCE_INT4, 'utf8')) as {
    codeWidth?: string;
    writeSegments?: { vectorByteReads?: { breakdown?: { pruneRate?: unknown } } };
    vectorRouteByteReads?: { breakdown?: { pruneRate?: unknown } };
  };
  const int8 = JSON.parse(readFileSync(EVIDENCE_INT8, 'utf8')) as {
    codeWidth?: string;
    writeSegments?: { vectorByteReads?: { breakdown?: { pruneRate?: unknown } } };
    vectorRouteByteReads?: { breakdown?: { pruneRate?: unknown } };
  };
  const p4 = int4.writeSegments?.vectorByteReads?.breakdown?.pruneRate;
  const p8 = int8.writeSegments?.vectorByteReads?.breakdown?.pruneRate;
  if (p4 === undefined || p8 === undefined) {
    issues.push('两份凭据里读不到写路径 pruneRate ⇒ 无法核验「无分辨力」');
  } else if (JSON.stringify(p4) !== JSON.stringify(p8)) {
    issues.push(
      `两份凭据的写路径 pruneRate **不相同** ⇒ ⇒ 「该档无分辨力」的结论站不住\n  int4: ${JSON.stringify(p4)}\n  int8: ${JSON.stringify(p8)}`,
    );
  }
  const r4 = int4.vectorRouteByteReads?.breakdown?.pruneRate;
  const r8 = int8.vectorRouteByteReads?.breakdown?.pruneRate;
  if (r4 === undefined || r8 === undefined) {
    issues.push('两份凭据里读不到读路径 pruneRate ⇒ 无法核验「无分辨力」');
  } else if (JSON.stringify(r4) !== JSON.stringify(r8)) {
    issues.push(
      `两份凭据的读路径 pruneRate **不相同** ⇒ ⇒ 「该档无分辨力」的结论站不住\n  int4: ${JSON.stringify(r4)}\n  int8: ${JSON.stringify(r8)}`,
    );
  }
  if (int4.codeWidth !== 'int4') {
    issues.push(`int4 凭据的 codeWidth 应为 'int4'（★ 实为 ${String(int4.codeWidth)}）`);
  }
  if (int8.codeWidth !== 'int8') {
    issues.push(`int8 凭据的 codeWidth 应为 'int8'（★ 实为 ${String(int8.codeWidth)}）`);
  }
} catch (error) {
  issues.push(`读凭据失败：${(error as Error).message}`);
}

/* ── ⑤ 状态 emoji 纪律 ── */
for (const [label, text] of [
  ['R3 行', r3Line],
  ['状态表 ② 行', statusLine],
] as const) {
  for (const emoji of ['✅', '⏳', '❌'] as const) {
    const count = text.split(emoji).length - 1;
    const expected = emoji === '⏳' ? 1 : 0;
    if (count !== expected) {
      issues.push(`${label} 内状态 emoji「${emoji}」出现 ${count} 次（期望 ${expected}）`);
    }
  }
}

/* ── ⑥ 支撑证据的数值与段落存在性 ── */
if (!r3Line.includes(EVIDENCE_DECISION)) {
  issues.push(
    `R3 行里找不到决定性证据「判定不同的行 = ${EVIDENCE_DECISION}」（★ ★ 这是「无分辨力」的机器证据 · ★ 不许被改掉或删掉）`,
  );
}
for (const value of COSINE_TRIPLE) {
  if (!r3Line.includes(value)) {
    issues.push(`R3 行里找不到实测余弦 ${value}（★ 三档实测值：1.000000 / 0.675913 / 0.204562）`);
  }
}
for (const value of MIXED_RATIOS) {
  if (!r3Line.includes(value)) {
    issues.push(`R3 行里找不到混档占比 ${value}（★ 期望四档：37.19% / 18.56% / 8.79% / 9.38%）`);
  }
}
if (!r3Line.includes(MIXED_SECTION_MARK)) {
  issues.push(
    `R3 行里找不到「${MIXED_SECTION_MARK}」段落（★ ★ 该段落是**混档落差的唯一登记处** ⇒ ★ 删掉它 = 静默丢失一条已实测的事实）`,
  );
}
for (const value of K60_EVIDENCE) {
  if (!r3Line.includes(value)) {
    issues.push(
      `R3 行里找不到生产召回口径（k=60）的可分辨性证据 ${value}（★ ★ QA 指出的反例 · ★ 「落盘口径无分辨力」≠「任何口径无分辨力」）`,
    );
  }
}

/* ══ ⑦ ★★★ v3 · R3 行内所有 markdown 表格的逻辑行必须都是表格行 ★★★ ══ */

/** ★ 把 R3 行按 `<br>` 拆成「逻辑行」（★ 表格是嵌在单元格里的 ⇒ 必须这样拆）。 */
function logicalRows(text: string): string[] {
  return text.split('<br>');
}

/** ★ 一行是不是表格行（★ 以 `|` 开头）。 */
function isTableRow(text: string): boolean {
  return text.trim().startsWith('|');
}

/** ★ 一行是不是表格分隔行（★ `|---|---|`）。 */
function isSeparatorRow(text: string): boolean {
  return /^\|[\s:-]*\|[\s|:-]*$/.test(text.trim());
}

/** ★ 一行的单元格数（★ 掐掉首尾空项后按 `|` 切）。 */
function cellCount(text: string): number {
  return text
    .trim()
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '').length;
}

{
  const rows = logicalRows(r3Line);
  // ★ 逻辑行 #0 就是 R3 行本身（★ 它是【外层】表格的一行）⇒ ⇒ 从 #1 开始扫。
  const start = 1;

  /** ★ 一段连续的表格行（★ run = 连续索引上的表格行）。 */
  type Run = { start: number; end: number; cells: number[]; hasHeaderSep: boolean };
  const runs: Run[] = [];
  for (let index = start; index < rows.length; index += 1) {
    if (!isTableRow(rows[index] ?? '')) {
      continue;
    }
    const runStart = index;
    const cells: number[] = [];
    while (index < rows.length && isTableRow(rows[index] ?? '')) {
      cells.push(cellCount(rows[index] ?? ''));
      index += 1;
    }
    const end = index - 1;
    runs.push({
      start: runStart,
      end,
      cells,
      // ★ 一个 run 若是「表头行 + 紧邻的分隔行」⇒ ⇒ 它是一张表的【开头】
      hasHeaderSep: cells.length >= 2 && isSeparatorRow(rows[runStart + 1] ?? ''),
    });
  }

  if (runs.length === 0) {
    issues.push(
      'R3 行里一个 markdown 表格块都没识别到（★ 表格结构守卫本身可能失效 ⇒ 请检查本脚本）',
    );
  }

  /** ★ 已被归入某张表的 run 索引（★ 用于判「游离」）。 */
  let currentTableColumns: number | null = null;
  let currentTableHeader = -1;
  let previousRunEnd = -2;

  for (const run of runs) {
    if (run.hasHeaderSep) {
      // ★ 一张新表的开始 ⇒ ⇒ 记下它的表头与列数
      currentTableColumns = run.cells[0] ?? null;
      currentTableHeader = run.start;
      // ★ 块内每行的单元格数必须 == 表头列数
      for (let offset = 0; offset < run.cells.length; offset += 1) {
        if ((run.cells[offset] ?? 0) !== currentTableColumns) {
          issues.push(
            `R3 行的表格（表头 @逻辑行 #${run.start}）里第 #${run.start + offset} 行的单元格数 ${run.cells[offset]} ≠ 表头列数 ${currentTableColumns}\n  行: ${(rows[run.start + offset] ?? '').trim().slice(0, 120)}`,
          );
        }
      }
      // ★ 至少要有「表头 + 分隔行 + 一行数据」
      if (run.cells.length < 3) {
        issues.push(
          `R3 行的表格（表头 @逻辑行 #${run.start}）只有 ${run.cells.length} 行（★ 至少要有表头 + 分隔行 + 一行数据）`,
        );
      }
    } else if (run.start === previousRunEnd + 1 && currentTableColumns !== null) {
      // ★ 紧邻上一段的表格行 ⇒ ⇒ 是同一张表的延续（★ 合法）
      for (let offset = 0; offset < run.cells.length; offset += 1) {
        if ((run.cells[offset] ?? 0) !== currentTableColumns) {
          issues.push(
            `R3 行的表格（表头 @逻辑行 #${currentTableHeader}）里第 #${run.start + offset} 行的单元格数 ${run.cells[offset]} ≠ 表头列数 ${currentTableColumns}\n  行: ${(rows[run.start + offset] ?? '').trim().slice(0, 120)}`,
          );
        }
      }
    } else {
      // ★★★ **游离行**（★ ★ 这就是 QA 实测的那个缺陷形态）★★：
      //   ★ 这一段表格行**既不是**一张新表的开头（★ 没有表头 + 分隔行）
      //   ★ **又不是**上一段的紧邻延续（★ 中间隔了段落 ⇒ ⇒ 表格被段落切断了）
      //   ⇒ ⇒ ⇒ **GFM 渲染时这段会掉出表格，变成表格外的孤立文本**
      issues.push(
        `★ ★ ★ R3 行的表格被段落打断了（★ 结构缺陷）：逻辑行 #${run.start}~#${run.end} 是一段表格行，` +
          `但它既没有「表头 + 分隔行」（⇒ 不是一张新表的开始）、又与上一段表格（表头 @逻辑行 #${currentTableHeader}）之间隔着段落` +
          `（⇒ 不是同一张表的延续）⇒ ⇒ **这段行被挤出了表**\n  ★ 首行: ${(rows[run.start] ?? '').trim().slice(0, 80)}\n  ★ 后果：GFM 渲染时该表只剩前面的行 ⇒ ⇒ **必须把中间那段移到表之后**`,
      );
    }
    previousRunEnd = run.end;
  }
}

/* ══ ⑧ v3 · 本轮新增的实测数据必须在位 ══ */
for (const value of THRESHOLD_SCAN_EVIDENCE) {
  if (!r3Line.includes(value)) {
    issues.push(
      `R3 行里找不到阈值扫描证据 ${value}（★ ★ 证明「无分辨力」是【threshold 取值巧合】而非【结构性】/【规模问题】的关键证据）`,
    );
  }
}
for (const value of STRICT_FORM_EVIDENCE) {
  if (!r3Line.includes(value)) {
    issues.push(`R3 行里找不到「无翻转严格形式」的实测数 ${value}（★ QA 建议的形式 · ★ 逐位）`);
  }
}
for (const value of CALIBER_A_EVIDENCE) {
  if (!r3Line.includes(value)) {
    issues.push(`R3 行里找不到口径 A 的边界证据 ${value}（★ 落盘口径 · 本轮凭据的数据源）`);
  }
}
if (!r3Line.includes(CALIBER_B_MARK)) {
  issues.push(
    `R3 行里找不到「${CALIBER_B_MARK}」的标注（★ ★ 口径 B 的数是 1M 库单桶自命中口径 ⇒ ⇒ 必须标明不是本轮口径 ⇒ ⇒ 否则会被误当成本轮的边界）`,
  );
}

/* ══ ⑨ v3 · 旧表述必须已消失 ══ */
for (const stale of STALE_PHRASES) {
  if (r3Line.includes(stale)) {
    issues.push(`R3 行里还留着旧表述「${stale}」（★ 已被本轮实测推翻 ⇒ ⇒ 必须已订正）`);
  }
}

/* ══ ⑩ v4 · 主理人整合新增：状态表/R3 一致性 · 条目落位 · 决策含义登记 ══ */
{
  /* ── ⑩-A 状态表 ② 行必须与 R3 行口径一致（★ QA 的 B2 盲区：只改一处 ⇒ 另一处还留着旧结论） ── */
  for (const mark of ['落盘口径', '无分辨力', '12 / 100', '投之前']) {
    if (!statusLine.includes(mark)) {
      issues.push(
        `状态表 ② 行里找不到「${mark}」（★ ★ 状态表与 R3 行必须口径一致（★ B2 盲区：只改一处 ⇒ 另一处还留着旧结论）⇒ ★ R3 行的「落盘口径 / k=60 反例 / 投之前先裁决 threshold 口径」三件事都必须同步到状态表）`,
      );
    }
  }

  /* ── ⑩-B ①/② 行不许带 ⏳（★ 出关条件② 的 ⏳ 只属于 R3 行） ── */
  for (const mark of ['| **R1** |', '| **R2** |'] as const) {
    const line = lines.find((l) => l.startsWith(mark)) ?? '';
    if (line === '') {
      issues.push(`找不到 ${mark} 行`);
      continue;
    }
    const count = line.split('⏳').length - 1;
    if (count !== 0) {
      issues.push(
        `${mark} 行内出现状态 emoji「⏳」${count} 次（期望 0 次 · ★ 出关条件② 的 ⏳ 只属于 R3 行）`,
      );
    }
  }

  /* ── ⑩-C ⑤/⑥ 条必须落在 R3 行内、不在 R4 行内（★ 曾错落 ⇒ ★ 双向钉死） ── */
  const r4Line = lines.find((l) => l.startsWith('| **R4** |')) ?? '';
  for (const mark of ['⑥ ★ **2026-11-07', '⑤ ★ **2026-11-07']) {
    if (!r3Line.includes(mark)) {
      issues.push(`R3 行里找不到「${mark}」（★ 该条必须落在 R3 行内）`);
    }
    if (r4Line.includes(mark)) {
      issues.push(`「${mark}」错落到 R4 行（★ ★ 必须是 R3 行内）`);
    }
  }

  /* ── ⑩-D 决策含义必须登记（★ 防止下一轮又无脑投那 4 h） ── */
  for (const mark of ['投之前', '影子阈值', '17.9487%', '66.6667%']) {
    if (!r3Line.includes(mark)) {
      issues.push(
        `R3 行里找不到「${mark}」（★ ★ 决策含义必须登记：★ 投 1M 档【之前】必须先裁决 threshold 口径（★ 生产阈值取绝对值 + 影子阈值取相对差异 ⇒ 两列并报）⇒ ★ 且「int4 超标方向」的实测支撑（★ threshold 0.4 档 17.9487% vs 66.6667%）必须留在文档里）`,
      );
    }
  }

  /* ── ⑩-E 过宽 / 自相矛盾的旧措辞必须已消失（★ R3 行 + 状态表 ② 行） ── */
  for (const stale of ['全部远离该阈值', '该档【结构性】无分辨力']) {
    for (const [label, text] of [
      ['R3 行', r3Line],
      ['状态表 ② 行', statusLine],
    ] as const) {
      if (text.includes(stale)) {
        issues.push(`${label} 里还留着过宽 / 自相矛盾的表述「${stale}」（★ 已被本轮实测推翻）`);
      }
    }
  }
}

/* ── 报告 ── */
if (issues.length > 0) {
  process.stdout.write('✗ T11 守卫：发现下列问题\n');
  for (const issue of issues) {
    process.stdout.write(`  · ${issue}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write('✓ T11 守卫：表一 int4 行未被假数顶替（★ 剪枝率列写「无分辨力」）\n');
  process.stdout.write('✓ T11 守卫：int8 行与基线逐字节一致（★ D6）\n');
  process.stdout.write('✓ T11 守卫：int4 行延迟带档位标注（unknown · warm · 2000 行档）\n');
  process.stdout.write(
    '✓ T11 守卫：int4 行延迟数值 = 本档实测值（13.68 / 4.20 · ★ 无 1M 档数值）\n',
  );
  process.stdout.write('✓ T11 守卫：int4 行 ε 列 = 实测分布\n');
  process.stdout.write(
    '✓ T11 守卫：两份凭据的写路径 + 读路径 pruneRate 逐位相同（★ 「无分辨力」的机器证据）\n',
  );
  process.stdout.write('✓ T11 守卫：R3 行与状态表 ② 行各只有 ⏳ 一种状态 emoji\n');
  process.stdout.write(
    '✓ T11 守卫：支撑证据在位（★ 判定 0 / 5,986 · 三档余弦 · 混档四档占比 · 混档落差段落 · k=60 反例）\n',
  );
  process.stdout.write(
    '✓ T11 守卫：R3 行内所有表格的逻辑行都是表格行（★ ★ 表格未被段落打断 · ★ QA 实测的真盲区）\n',
  );
  process.stdout.write(
    '✓ T11 守卫：阈值扫描反例 + 无翻转严格形式 + 口径 A/B 边界在位（★ 旧表述已清除）\n',
  );
}
