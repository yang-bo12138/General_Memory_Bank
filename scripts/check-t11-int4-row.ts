/**
 * ★ **T11 守卫 · 四列表 int4 行的「无分辨力」结论不得被假数顶替**。
 *
 * ★★★ **为什么需要这个守卫（★ 实测发现的真实盲区 · 不是臆想）**：
 *   · `scripts/check-benchmark-numbers.ts` 的 R3 行载体**只参与【状态维度】**
 *     （★ 不在数值 SPEC 的 `requiredIn` 里）⇒ ⇒ ★ **R3 行里的【数值】没有任何机器守护**。
 *   · ★ 实测两个负控（★ 本脚本作者亲手注入）：
 *     ① 把 int4 行的剪枝率列改成 `max **0.071429**`（★ 那个**几何常数**冒充 int4 剪枝率）
 *        ⇒ `check:benchmark-numbers` **仍然绿**（★ 抓不到）。
 *     ② 把 int8 行的 `ε min` 从 `0.004486` 改成 `0.004487`（★ 一位数字的漂移）
 *        ⇒ `check:benchmark-numbers` **仍然绿**（★ 抓不到）。
 *   · ⇒ ⇒ ★ **「同一批数不许各说各话」这条纪律在 R3 行上【靠人眼审】⇒ ⇒ 就是本项目反复治的「假绿」病**。
 *   · ⇒ ⇒ ★ 本守卫把这条纪律**变成可复算的断言**。
 *
 * ★ **本守卫断言什么（★ 全部可在 1 秒内机器核验）**：
 *   ① **int8 行逐字节不变**（★ D6）—— 基线取自提交 `6465d81`（★ T11 之前的最后一个提交）。
 *   ② **int4 行的剪枝率列必须写「无分辨力」**（★ 不许填一个数）——
 *      ★ **理由**：2000 行档的剪枝率 ≡ `1/candidateUniverse`（几何常数 ⇒ 零码宽信息），
 *      ★ 同批 int4 / int8 对照**逐位相同** ⇒ ⇒ **填进去就是假数**。
 *   ③ **int4 行的延迟必须带档位标注**（★ 「介质 × 页缓存」+ 「2000 行档」提示）。
 *   ④ **两份凭据必须存在且【剪枝率逐位相同】**（★ 这是「无分辨力」的机器证据）
 *      ⇒ ★ 两者若不同 ⇒ ⇒ **「无分辨力」的结论就站不住** ⇒ ⇒ 守卫判红。
 *   ⑤ **R3 行与状态表 ② 行各自只允许 `⏳` 一种状态 emoji**（★ 与既有守卫同纪律）。
 *
 * ★ **链外还是链内**：★ **链外**（★ 不进 `verify`）
 *   ⇒ 理由：★ 本守卫依赖 `docs/evidence/t11-*.json` 两份**小体积**凭据（★ 各 ≈ 28 KB）
 *   ⇒ ⇒ 其实可以进链 ⇒ ⇒ ★ 但**本批不接门禁**（★ 纪律 5：门禁链 18 段**本批不加段**）
 *   ⇒ ⇒ ⇒ **本脚本只作为「链外可独立运行」的守卫生效**（★ `pnpm run check:t11-int4-row`）。
 */
import { readFileSync } from 'node:fs';

const DOC = 'docs/design/perf-c2-admissible-two-stage.md';
const EVIDENCE_INT4 = 'docs/evidence/t11-int4-2000.json';
const EVIDENCE_INT8 = 'docs/evidence/t11-int8-2000.json';

/** ★ int8 行的基线（★ 逐字节 · 取自 T11 之前的最后一个提交 `6465d81`）。 */
const INT8_BASELINE =
  '| **int8** | **768 B** | min **0.004486** · p50 **0.005477** · p90 **0.005838** · p99 **0.006155** · p999 **0.006375** · max **0.006793** | min 0.000000 · p50 **0.000274** · p99 **0.012500** · max **0.037037** | **1,800.45 ms** / **4,540.64 ms**（HDD · warm）|';

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
  // ★ 表一的 int4 行有 5 列 ⇒ 取第 4 列（剪枝率）—— ★ 按「|」切分并去掉首尾空项
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
  // ★ 剪枝率格里**不许出现**那个几何常数的值
  if (/0\.0714|0\.07142|7\.14/.test(pruneCell)) {
    issues.push(
      '表一 int4 行的剪枝率列出现了那个【几何常数】的值 ⇒ 那是假数（★ 它与 int8 逐位相同 ⇒ 零码宽信息）',
    );
  }
  // ── ③ 延迟列必须带档位标注 ──
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
}

/* ── ④ 两份凭据的剪枝率必须逐位相同（★ 这是「无分辨力」的机器证据） ── */
try {
  const int4 = JSON.parse(readFileSync(EVIDENCE_INT4, 'utf8')) as {
    codeWidth?: string;
    writeSegments?: { vectorByteReads?: { breakdown?: { pruneRate?: unknown } } };
  };
  const int8 = JSON.parse(readFileSync(EVIDENCE_INT8, 'utf8')) as {
    codeWidth?: string;
    writeSegments?: { vectorByteReads?: { breakdown?: { pruneRate?: unknown } } };
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
      issues.push(`${label} 内状态 emoji「${emoji}」出现 ${count} 次（期望 ${expected} 次）`);
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
    '✓ T11 守卫：两份凭据的写路径 pruneRate 逐位相同（★ 「无分辨力」的机器证据）\n',
  );
  process.stdout.write('✓ T11 守卫：R3 行与状态表 ② 行各只有 ⏳ 一种状态 emoji\n');
}
