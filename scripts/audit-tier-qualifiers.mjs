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
 * 【判定分两级】★ 这是本脚本最要紧的设计（也是它能被信任的原因）
 *
 *   · **★ 真缺（exit 1）** —— 该数所在 **片段 ∪ 表头 ∪ 上下文 ∪ 小节标题** **全都**没有强档位词
 *     ⇒ ⇒ **这才是「这个数的档位真的丢了」** ⇒ ⇒ **这是唯一会打红的一类**；
 *   · **⚠️ 提示（不判红）** —— 该数的 **片段 ∪ 表头** 没有强档位词，但 **上下文 / 小节标题** 有
 *     ⇒ ⇒ **这说明「档位标得不够近」**：读者得往上翻才能知道这个数属于哪一档
 *     ⇒ ⇒ **它不是错，但它是可改进项** ⇒ ⇒ **故只提示、不打红**。
 *
 * ⇒ ⇒ ★ **为什么这样分**：实测发现**这份文档的档位信息大量靠小节标题承载**（不是逐数标注）
 * ⇒ ⇒ **⇒ 若把作用域收到「片段 ∪ 表头」，原始 README 立刻出现 26 处误报**
 * ⇒ ⇒ **⇒ 而若只保留宽作用域，脚本就永远不会打红（等于恒绿守卫）**
 * ⇒ ⇒ **⇒ 两级判定是唯一既能判红、又不误报的设计**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【强档位词 vs 弱指示词】★ 这是「脚本抓不到东西」的真凶（一度让我以为机制坏了）
 *
 *   · **强档位词**（`冷盘档` / `热盘档` / `部分热档` / `全热档` / `两档` / `三档` / `跨档` / `（热）` / `（冷）` …）
 *     ⇒ **明确说明「是哪一档」** ⇒ **单独出现即可成立**；
 *   · **弱指示词**（`本次` / `上一轮`）⇒ **只说明「是哪一次」，不说明「是哪一档」**
 *     ⇒ ⇒ **必须与强档位词同现才算数**。
 *
 * ⚠️ **踩坑记录**：早期版本把「本次」也算成档位词 ⇒
 *   「百万级实测（本次 · 档位未标）」这种**已经丢了档位**的表头**仍然被判为「有档位」**
 *   ⇒ ⇒ **整个作用域被这几个代词撑起来** ⇒ ⇒ **脚本变成恒绿守卫、怎么改都抓不到东西**
 *   ⇒ ⇒ **⇒ 判别力的第一前提是：判据本身必须真的在判那件事。**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【这个脚本自己的纪律】（§2.4 纪律 4 / 5 的自我约束）
 *
 *   · **必须自证**：输出里给出**三个数**（扫了多少处 / 判了多少处 / 发现几处真缺）
 *     ⇒ 不许只输出「通过」⇒ ⇒ **数字变了它就该变** ⇒ 它自己也有判别力。
 *   · **必须可复跑且幂等**：连续跑两次输出**逐字相同** ⇒ **无随机性、无时间依赖**。
 *   · **核对必须用「机制自己的读法」**：它按**读者读 Markdown 的方式**分层定位
 *     （片段 / 表头 / 上下文窗口 / 小节标题），
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
 *   ⇒ ⇒ **代价**：它**不进 `tsc --noEmit` 的类型检查** ⇒ ⇒ **类型信息改用 JSDoc 承载**。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = join(REPO_ROOT, 'docs', 'baseline', 'README.md');

/**
 * **强档位词**：明确说明「是哪一档」⇒ **单独出现即可成立**。
 * @type {readonly string[]}
 */
export const STRONG_TIER_WORDS = [
  '冷盘档',
  '部分热档',
  '部分预热档',
  '热盘档',
  '全热档',
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
 * **弱指示词**：只说明「是哪一次」或「在比几个档位」，**不说明「这个数属于哪一档」**
 * ⇒ **必须与强词同现才算数**。
 *
 * ⚠️ ★ **`两档` / `三档` / `跨档` 也在这一类** —— 它们说的是「**在比几个档位**」，
 * **不是**「**这个数属于哪一档**」⇒ ⇒ 若把它们算成强词，
 * 「这一段谈过档位 ⇒ 这一行的数就都算有档位限定」⇒ ⇒ **作用域被它们撑起来**。
 *
 * @type {readonly string[]}
 */
export const WEAK_TIER_WORDS = ['本次', '上一轮', '两档', '三档', '跨档'];

/**
 * **只属于某一档的数**（必须带档位限定）。
 *
 * ⚠️ 类目按「同一个语义量」归并 ⇒ 同一个数出现在多处时被**逐处**判定 ⇒ ⇒ 漏一处就会被抓出一处。
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

/** 片段切分符：分号与句号 ⇒ ⇒ 一个「片段」= 一个分句。 */
const FRAGMENT_DELIMITERS = ['；', ';', '。'];

/** 上下文窗口：命中行往上多少行内出现档位词即算已限定。 */
const CONTEXT_WINDOW = 5;

/** 所属小节标题的向上搜索上限。 */
const SECTION_WINDOW = 40;

/**
 * 一次审计里的一处判定。
 *
 * @typedef {{ line: number, className: string, text: string }} AuditFinding
 */

/**
 * 一次审计的计数（⇒ 输出里的三个数 + 提示数）。
 *
 * @typedef {{ scanned: number, adjudicated: number, missing: number, advisories: number }} AuditCounts
 */

/**
 * 一次审计的完整结果。
 *
 * @typedef {{ counts: AuditCounts, gaps: AuditFinding[], advisories: AuditFinding[] }} AuditResult
 */

/**
 * 判定「这段文本是否给出了档位」。
 *
 * ⚠️ **强词单独成立；弱词必须与强词同现**（见头注释「强档位词 vs 弱指示词」）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasTier(text) {
  if (STRONG_TIER_WORDS.some((word) => text.includes(word))) return true;
  return (
    WEAK_TIER_WORDS.some((word) => text.includes(word)) &&
    STRONG_TIER_WORDS.some((word) => text.includes(word))
  );
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
 * 把一行切成**片段**（按分号 / 句号）。
 *
 * @param {string} line
 * @returns {Array<[number, number]>} 片段的 `[起, 止)` 偏移
 */
export function fragmentsOf(line) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (FRAGMENT_DELIMITERS.includes(line[i])) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  ranges.push([start, line.length]);
  return ranges;
}

/**
 * 找出某个偏移所在的片段。
 *
 * @param {string} line
 * @param {number} offset
 * @returns {string}
 */
export function fragmentAt(line, offset) {
  for (const [start, end] of fragmentsOf(line)) {
    if (offset >= start && offset <= end) return line.slice(start, end);
  }
  return line;
}

/**
 * 找出该行所在表格的**表头行**（分隔行的上一行）。
 *
 * @param {readonly string[]} lines
 * @param {number} index
 * @returns {string}
 */
export function tableHeaderOf(lines, index) {
  for (let k = index - 1; k >= 0 && k >= index - 60; k -= 1) {
    if (isTableSeparator(lines[k] ?? '')) return lines[k - 1] ?? '';
  }
  return '';
}

/**
 * 找出该行所属的**小节标题**。
 *
 * ⚠️ **括号要全角 `）`** —— 文档里写的是 `**（b）★ …` ⇒ 用半角 `)` 的话
 * 这条正则**永远匹配不上** ⇒ ⇒ 整节都被判成「真缺」⇒ ⇒ **见头注释里那个坑**。
 *
 * @param {readonly string[]} lines
 * @param {number} index
 * @returns {string}
 */
export function sectionHeadingOf(lines, index) {
  for (let k = index - 1; k >= 0 && k >= index - SECTION_WINDOW; k -= 1) {
    const candidate = lines[k] ?? '';
    if (/^#{1,6} /.test(candidate) || /^\*\*（[a-z][)）]/.test(candidate.trim())) return candidate;
  }
  return '';
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
  /** @type {AuditFinding[]} */
  const gaps = [];
  /** @type {AuditFinding[]} */
  const advisories = [];
  let scanned = 0;
  let adjudicated = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const header = tableHeaderOf(lines, index);
    const section = sectionHeadingOf(lines, index);
    /** @type {string[]} */
    const context = [];
    for (let k = index - 1; k >= 0 && k >= index - CONTEXT_WINDOW; k -= 1) {
      context.push(lines[k] ?? '');
    }

    for (const tierClass of TIER_SPECIFIC_CLASSES) {
      for (const match of line.matchAll(tierClass.pattern)) {
        scanned += 1;
        adjudicated += 1;
        const fragment = fragmentAt(line, match.index);
        const localHasTier = hasTier(fragment) || hasTier(header);
        if (localHasTier) continue;
        const wideHasTier = context.some(hasTier) || hasTier(section);
        const finding = {
          line: index + 1,
          className: tierClass.name,
          text: fragment.trim().slice(0, 150),
        };
        if (wideHasTier) {
          advisories.push(finding);
        } else {
          gaps.push(finding);
        }
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
  const local = counts.adjudicated - counts.missing - counts.advisories;
  const out = [];
  out.push('════ 档位限定一致性审计 ════');
  out.push(`目标：${target}`);
  out.push(`扫了 ${counts.scanned} 处「只属于某一档的数」（一处 = 一个被识别的数）`);
  out.push(
    `判了 ${counts.adjudicated} 处（✅ ${local} 处自带档位 · ⚠️ ${counts.advisories} 处档位标得不够近 · ❌ ${counts.missing} 处真缺）`,
  );
  out.push(`发现 ${counts.missing} 处真缺`);
  out.push(`（另有 ${counts.advisories} 处「档位标得不够近」的提示，不判红）`);

  if (result.gaps.length > 0) {
    out.push('');
    out.push('---- 真缺明细（该数的档位在片段 / 表头 / 上下文 / 小节标题里都找不到）----');
    for (const gap of result.gaps) {
      out.push(
        `  ❌ [${gap.className}] 第 ${gap.line} 行 ⇒ 片段 / 表头 / 上下文 / 小节标题 都没有强档位词`,
      );
      out.push(`     ${gap.text}`);
    }
  }

  if (result.advisories.length > 0) {
    out.push('');
    out.push('---- 提示（不判红：档位只在上下文 / 小节标题里给出 ⇒ 读者得往上翻才知道）----');
    for (const advisory of result.advisories) {
      out.push(`  ⚠️ 第 ${advisory.line} 行：${advisory.className} ⇒ 档位标得不够近`);
      out.push(`     ${advisory.text}`);
    }
  }

  out.push('');
  out.push(
    counts.missing === 0
      ? '✅ 结论：没有「档位真的丢了」的数（口径标注一致）'
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

/**
 * ★ **只在「本文件被直接执行」时才跑 CLI** —— 被  时**只导出纯函数**。
 * （仓库的「新增门禁的做法」第 1 条：「导出纯函数（便于单测），**CLI 只是薄壳**」⇒
 *   ⇒ 若 import 就跑 CLI，单测一 import 就把审计跑了一遍 ⇒ ⇒ 副作用 ⇒ ⇒ 不可测。）
 */
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
