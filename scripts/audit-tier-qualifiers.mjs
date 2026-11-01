#!/usr/bin/env node
/**
 * `docs/baseline/README.md` 的**档位限定一致性审计** —— 把「哪些数必须带档位、哪些数不许带档位」
 * 这条纪律做成**可复跑**的脚本，使它在每次重采基线后能被机械地重新核对一遍。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【为什么需要它】
 *
 * 百万级基线现在有**三档采集**（冷盘档 23:25 / 部分热档 23:43 / 全热档 19:49），
 * 而 README 里同时存在两类**语义完全不同**的数字：
 *
 *   · **只属于某一档的数**（毫秒、占比、每行读成本……）
 *       ⇒ **换一档就变** ⇒ **必须带档位限定词**，否则读者会把它当成通义值。
 *         ⚠️ 本仓库已经真出过这个错：曾把「文本路 87.9% / 向量 12.1%」写成
 *            「在两档里都不因 I/O 快慢而改变」，而实测两档是 **12.1% vs 21.6%**。
 *
 *   · **跨档一致的数**（H1 = 12,782 行 / H2 = 1.2782%）
 *       ⇒ **三档逐位相同** ⇒ **不许**被写成「只在这一档成立」
 *         ⚠️ 但**可以**出现在「这组数采自哪一次」这种**出处陈述**里
 *            （例：「实测（2026-11-01 冷盘档 · H1 判据）= … max 12,782 行」）——
 *            那是**数据出处**，不是**值的适用范围** ⇒ **不能删**，只能把含义讲清楚。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【怎么用】
 *
 *   ```bash
 *   # 审计默认目标（仓库根的 docs/baseline/README.md）
 *   node scripts/audit-tier-qualifiers.mjs
 *   #   （也可用 pnpm exec tsx scripts/audit-tier-qualifiers.mjs —— 两者等价）
 *
 *   # 审计别处的同名文件（用于比对别的分支的快照）
 *   node scripts/audit-tier-qualifiers.mjs path/to/README.md
 *   ```
 *
 *   **退出码**：`0` = 无真缺；`1` = 有真缺（⇒ 可直接当门禁用）。
 *   ⚠️ 「行数类判据出现在带档位词的句子里」只作**提示**，**不判红**
 *   （脚本无法可靠区分「出处陈述」与「适用范围断言」⇒ 交人判断）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【这个脚本自己的纪律】（§2.4 纪律 4 / 5 的自我约束）
 *
 *   · **必须自证**：输出里给出**三个数**（扫了多少处 / 判了多少处 / 发现几处真缺）
 *     ⇒ 不许只输出「通过」⇒ ⇒ **数字变了它就该变** ⇒ 它自己也有判别力。
 *     （实测：删掉一处档位限定 ⇒ 三个数从 `69 / 69 / 0` 变成 `69 / 69 / 2` ⇒ 退出码 1。）
 *   · **必须可复跑且幂等**：连续跑两次输出**逐字相同** ⇒ **无随机性、无时间依赖**。
 *   · **核对必须用「机制自己的读法」**：它按**读者读 Markdown 的方式**分层定位
 *     （本行 / 所在表的表头 / 上下文窗口 / 所属小节标题），
 *     **不是**「文件里出现过这个词就算」⇒ ⇒ 这是 §2.4 纪律 5 ③ 的镜像：
 *     **「文件存在」≠「机制在用」⇒ 要用机制自己的读法去核。**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【它第一版踩过的坑】（留给后人）
 *
 *   小节标题的正则原本写成 `^\*\*（[a-z]\)`（**半角 `)`**），
 *   而文档里是 `**（b）★ …`（**全角 `）`**）⇒ ⇒ **那条正则永远匹配不上**
 *   ⇒ ⇒ 整节被误判成「真缺」（4 处假缺口）⇒ ⇒ **一个「看起来红」的守卫其实是坏的**
 *   ⇒ ⇒ **如果只信它的输出，就会去改本来正确的文档** ⇒ ⇒ **这正是纪律 3「先让工具失手一次」的价值**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【与本仓库「新增门禁的做法」的差距】（`scripts/README.md` §「新增门禁的做法」）
 *
 *   本脚本**已做到**第 1 条（**导出纯函数**，见下方的 `auditTierQualifiers` / `renderAudit`）
 *   与第 4 条（**已在 `scripts/README.md` 登记**）。
 *   ⚠️ **尚未做到**第 2 条（串进 `package.json` 的 `ci`）与第 3 条（`tests/contracts/` 的
 *   **含反例**的单测）—— ⇒ **故本脚本目前是「可复跑的审计」，还不是「门禁」**
 *   ⇒ ⇒ **接入门禁的两步由谁做，等主理人定**（第 2 步要动 `package.json`；
 *   第 3 步要动 `tests/contracts/**` ⇒ **都不在工程师-7 的边界内**）。
 *
 * ⚠️ **交付形态说明**：本脚本按主理人指定用 **`.mjs`**（⇒ **纯 `node` 即可跑，不依赖 `tsx`**）
 *   ⇒ ⇒ **代价**：它**不进 `tsc --noEmit` 的类型检查**（`tsconfig.json` 的 `include` 里的
 *   `scripts/` 只覆盖 `.ts`）⇒ ⇒ **类型信息改用 JSDoc 承载**（编辑器仍可推断）。
 *   ⇒ ⇒ **⇒ 若日后要把它当门禁**，建议连同单测一起改成 `.ts`（本仓库其余 15 个脚本都是 `.ts`）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = join(REPO_ROOT, 'docs', 'baseline', 'README.md');

/** 档位词表：**任何**能说明「这个数属于哪一档」的词都算。 */
const TIER_WORDS = [
  '冷盘档',
  '部分热档',
  '部分预热档',
  '热盘档',
  '全热档',
  '两档',
  '三档',
  '跨档',
  '本次',
  '上一轮',
  '（热）',
  '（冷）',
  '热）',
  '冷）',
  '（热',
  '（冷',
  '冷 /',
  '冷／',
  '热 /',
  '热／',
];

/**
 * **只属于某一档的数**（必须带档位限定）。
 *
 * ⚠️ 类目按「同一个语义量」归并 ⇒ 同一个数出现在多处时被**逐处**判定
 * ⇒ ⇒ 漏一处就会被抓出一处。
 *
 * @typedef {{ name: string, pattern: RegExp }} TierSpecificClass
 */
export const TIER_SPECIFIC_CLASSES = [
  {
    name: '① 写入毫秒拆分',
    pattern: /12\.1%|87\.9%|21\.6%|78\.4%|243\.59|161\.84|33\.44|44\.67|277\.03|206\.51/g,
  },
  { name: '② 每行读成本', pattern: /212\.025|280\.517|424\.0 ms/g },
  {
    name: '③ 向量路 P99 / 均值 / 分位',
    pattern:
      /4969\.50|4969\.497|229\.66|4441\.77|954\.74|94\.45|774\.21|2228\.52|14122|350\.08|89\.59|175\.15/g,
  },
  { name: '④ recall P99', pattern: /164\.44|164\.439|108\.99|565\.03|565\.035/g },
  {
    name: '⑤ 写入 P99 / 分位',
    pattern: /1199\.99|1199\.991|644\.06|884\.99|884\.995|194\.49|818\.22|149\.32|36\.50/g,
  },
];

/**
 * **跨档一致的数**（不许被写成「只在这一档成立」）。
 *
 * ⚠️ 只作**提示**：文档里**允许**出现「这组数采自哪一次」的出处陈述。
 */
export const CROSS_TIER_PATTERN = /12,782|1\.2782%|12\.782/g;

/** 出处陈述的标志词 ⇒ 出现它们 ⇒ 那句里的档位词是在说「出处」而非「适用范围」。 */
const PROVENANCE_MARKERS = [
  '实测',
  '采集',
  '出处',
  '这一组数',
  '逐位相同',
  '两档全同',
  '跨档',
  '三档',
  '两次采集',
];

/** 上下文窗口：命中行往上多少行内出现档位词即算已限定。 */
const CONTEXT_WINDOW = 5;

/** 所属小节标题的向上搜索上限。 */
const SECTION_WINDOW = 40;

/**
 * 一次审计里的一处判定（真缺或提示）。
 *
 * @typedef {{ line: number, className: string, text: string }} AuditFinding
 */

/**
 * 一次审计的计数（⇒ 输出里的三个数）。
 *
 * @typedef {{ scanned: number, adjudicated: number, missing: number, advisories: number }} AuditCounts
 */

/**
 * 一次审计的完整结果。
 *
 * @typedef {{ counts: AuditCounts, gaps: AuditFinding[], advisories: AuditFinding[] }} AuditResult
 */

/**
 * 判定「本行是否含档位词」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasTier(text) {
  return TIER_WORDS.some((word) => text.includes(word));
}

/**
 * 判定「本行是否含出处陈述标志」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasProvenance(text) {
  return PROVENANCE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 判定「本行是否是 Markdown 表格的分隔行」。
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isTableSeparator(line) {
  return /^\|[\s|:-]+\|$/.test(line.trim());
}

/**
 * 逐层定位「这个数属于哪一档」。
 *
 * ⚠️ **四层缺一不可**：本行 / 所在表的表头 / 上下文窗口 / 所属小节标题
 * ⇒ ⇒ 只查本行会把「表头已限定」的行误判成缺口 ⇒ ⇒ 只查表头会把散文段落误判。
 *
 * @param {readonly string[]} lines 文档全文按行切分
 * @param {number} index 命中行下标
 * @returns {boolean} 是否已带档位限定
 */
export function scopeHasTier(lines, index) {
  // ① 本行自带档位词。
  if (hasTier(lines[index] ?? '')) return true;

  // ② 所在表格的**表头行**（分隔行的上一行）—— 向上找最近的表格分隔行。
  for (let k = index - 1; k >= 0 && k >= index - 60; k -= 1) {
    if (isTableSeparator(lines[k] ?? '')) {
      const header = lines[k - 1];
      if (header !== undefined && hasTier(header)) return true;
      break;
    }
  }

  // ③ 上下文窗口：命中行上方若干行内出现档位词（例：「实测（冷盘档 · 样本 500）：」）。
  for (let k = index - 1; k >= 0 && k >= index - CONTEXT_WINDOW; k -= 1) {
    if (hasTier(lines[k] ?? '')) return true;
  }

  // ④ 所属小节标题（`### …` 或 `**（x）…**` 这类加粗小标题）。
  //    ⚠️ **括号要全角 `）`** —— 文档里写的是 `**（b）★ …` ⇒ 用半角 `)` 的话
  //    这条正则**永远匹配不上** ⇒ ⇒ 整节都被判成「真缺」⇒ ⇒ **见头注释里那个坑**。
  for (let k = index - 1; k >= 0 && k >= index - SECTION_WINDOW; k -= 1) {
    const candidate = lines[k] ?? '';
    if (/^#{1,6} /.test(candidate) || /^\*\*（[a-z][)）]/.test(candidate.trim())) {
      if (hasTier(candidate)) return true;
      break;
    }
  }

  return false;
}

/**
 * **纯函数**：审计一份 Markdown 的档位限定一致性。
 *
 * ⚠️ **无随机性、无时间依赖** ⇒ ⇒ 连跑两次结果逐字相同（幂等）。
 *
 * @param {readonly string[]} lines 文档全文按行切分
 * @returns {AuditResult} 审计结果
 */
export function auditTierQualifiers(lines) {
  const gaps = [];
  const advisories = [];
  let scanned = 0;
  let adjudicated = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    // —— 只属于某一档的数：逐类、逐处判定 ——
    for (const tierClass of TIER_SPECIFIC_CLASSES) {
      tierClass.pattern.lastIndex = 0;
      if (!tierClass.pattern.test(line)) continue;
      scanned += 1;
      adjudicated += 1;
      if (!scopeHasTier(lines, index)) {
        gaps.push({
          line: index + 1,
          className: tierClass.name,
          text: line.trim().slice(0, 150),
        });
      }
    }

    // —— 跨档一致的数：出现在带档位词的句子里 ⇒ 提示（除非那是出处陈述）——
    CROSS_TIER_PATTERN.lastIndex = 0;
    if (CROSS_TIER_PATTERN.test(line) && hasTier(line) && !hasProvenance(line)) {
      advisories.push({
        line: index + 1,
        className: '行数类判据（H1/H2）出现在带档位词的句子里',
        text: line.trim().slice(0, 150),
      });
    }
  }

  return {
    counts: {
      scanned,
      adjudicated,
      missing: gaps.length,
      advisories: advisories.length,
    },
    gaps,
    advisories,
  };
}

/**
 * **纯函数**：把审计结果渲染成报告文本。
 *
 * @param {string} target 被审计的文件路径（写进报告头）
 * @param {AuditResult} result 审计结果
 * @returns {string} 报告文本（**逐字确定** ⇒ 便于比对两次运行）
 */
export function renderAudit(target, result) {
  const { counts } = result;
  const out = [];
  out.push('════ 档位限定一致性审计 ════');
  out.push(`目标：${target}`);
  out.push(`扫了 ${counts.scanned} 处「只属于某一档的数」`);
  out.push(
    `判了 ${counts.adjudicated} 处（✅ ${counts.adjudicated - counts.missing} 处已带档位限定 · ❌ ${counts.missing} 处缺）`,
  );
  out.push(`发现 ${counts.missing} 处真缺`);

  if (result.gaps.length > 0) {
    out.push('');
    out.push('---- 真缺明细 ----');
    for (const gap of result.gaps) {
      out.push(
        `  ❌ [${gap.className}] 第 ${gap.line} 行 ⇒ 本行 / 所在表头 / 上下文 / 小节标题 都没有档位词`,
      );
      out.push(`     ${gap.text}`);
    }
  }

  if (result.advisories.length > 0) {
    out.push('');
    out.push('---- 提示（不判红；脚本无法可靠区分「出处陈述」与「适用范围断言」）----');
    for (const advisory of result.advisories) {
      out.push(`  ⚠️ 第 ${advisory.line} 行：${advisory.className} ⇒ 人工确认是「适用范围断言」还是「出处陈述」`);
      out.push(`     ${advisory.text}`);
    }
  }

  out.push('');
  out.push(
    counts.missing === 0
      ? '✅ 结论：口径标注一致（无真缺）'
      : '❌ 结论：存在真缺 ⇒ 补档位限定后重跑',
  );
  return out.join('\n');
}

/** CLI 薄壳（★ 逻辑都在上面的纯函数里 ⇒ 便于写单测）。 */
function main() {
  const target = resolve(process.argv[2] ?? DEFAULT_TARGET);
  const lines = readFileSync(target, 'utf8').split(/\r?\n/);
  const result = auditTierQualifiers(lines);
  process.stdout.write(`${renderAudit(target, result)}\n`);
  process.exitCode = result.counts.missing === 0 ? 0 : 1;
}

main();
