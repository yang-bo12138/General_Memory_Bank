#!/usr/bin/env tsx
/**
 * 跨节锚定检查 —— DESIGN-v2.md §14.3.1 末的「机器可检」清单（5 行 × 3 列）。
 *
 * > 「对每一条『在 §A 声明的规则』，全文搜索它的**动作关键词**，
 * > 断言每个『该规则管辖的代码路径』都在动作关键词的**同一代码块内**出现该动作。」
 *
 * ⚠️ **这类错误比缺行更危险**：缺行会报错，而**错列会静默地校验通过**。
 * ⇒ 脚本里这五行的**路径写死为常量**，不接受配置。
 *
 * ⚠️ **本脚本查两件事**（P2-T04 落地）：
 *   ① **清单自身**的校验：三列结构 + 五行内容与写死常量一致 + **每条规则的管辖路径条数**
 *      与写死的期望值一致（C31：分母必须是外部写死的期望值 ⇒ 不能用「实际命中几个」当分母）；
 *   ② **动作关键词是否真的落在管辖路径上**（P2-T04 新增）：
 *      每条规则的每个管辖路径，都有一个**写死的落点**（`ANCHOR_PATH_BINDINGS`）
 *      ⇒ 落点里必须出现该规则的**动作关键词**。
 *
 * ⚠️ **落点有三种**（`AnchorPathKind`）——**不同规则的「路径」性质不同**，硬套一种会误报：
 *   · `code` ⇒ 落点是**实现文件**（可选：某个函数体）⇒ 关键词必须出现在**代码**里
 *     （注释不算 ⇒ 见 `scripts/lib/code-span.ts` 的涂白口径）；
 *   · `doc` ⇒ 落点是**设计稿小节** ⇒ 关键词必须出现在那一节里
 *     （有的规则的「路径」本身就是设计稿的表 / 面板 / 状态表 ⇒ 没有代码落点）；
 *   · `pending` ⇒ **该路径的实现尚未存在**（阶段 N）⇒ **记为「待补」并写进输出**，
 *     **不判红**（判红就是误报）——但也**不许静默跳过**（否则「待补」会变成「没人管」）。
 *
 * 用法：`pnpm exec tsx scripts/check-anchor.ts`
 */

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  containsAnchorKeyword,
  normalizeAnchorLabel,
  parseAnchorKeywords,
  parseAnchorPathLabels,
} from './lib/anchor-match.js';
import { blankStrings, extractFunctionBody, readSourceFile } from './lib/code-span.js';
import {
  extractSection,
  isSeparatorRow,
  parseMarkdownTables,
  readDesignDoc,
} from './lib/design-doc.js';

/** §14.3.1 的标题行。 */
const SECTION_14_3_1_HEADING = '### 14.3.1 契约清单（本次审查沉淀）';

/** 锚定表的表头（必须恰好三列）。 */
const ANCHOR_HEADER = ['规则', '动作关键词', '管辖路径'];

/**
 * ★ **写死的**五行锚定清单（§14.3.1 末的表，逐字抄）。
 *
 * ⚠️ 路径**不接受配置**——「错列会静默地校验通过」，
 *   只有把它钉成常量，文档里改错了列才会被 CI 抓住。
 */
export const EXPECTED_ANCHOR_ROWS: readonly string[][] = [
  [
    '桶归属同步',
    '`vector_cell_members` / `assignBucket` / `unassignBucket`',
    '§4.9 步骤 2 / §4.9 步骤 3c ② / §4.9 步骤 4 / §4.9.1 步骤 4（**四条 embedding 赋值路径一条都不能漏**）',
  ],
  [
    '探针覆盖',
    '吻合率 / 只漏不错',
    '§4.15.3 选型表 / §4.15.4 ②③ / §4.6 步骤 2c / §4.9 步骤 3a2 / ADR-16 / ADR-17',
  ],
  [
    'reinforce 边界',
    "不建共激活边 / `'reinforce'` / `coacts`",
    '§4.2 / §4.6 步骤 4 / §6 / §8.4 / §0.2.2 / §0.2.3',
  ],
  [
    '向量路缺席',
    '`mode` / `absent` / `inRetrain`',
    '§4.6 步骤 0d / §4.6 步骤 2c / §4.15.6 / §6 / §7.2 面板 1 / §7.3 状态表 / §0.2.3 ④',
  ],
  [
    '切分触发量',
    '原始分量占比 / `maxRawComponentRatio`',
    '§4.12.4 ③ / §6 / §3 `cluster_snapshot_meta` / §7.2 面板 7',
  ],
];

/** §8.4 的标题。 */
const SECTION_8_4_HEADING = '### 8.4 事件类型与发射点对照表（枚举必须逐个落地）';

/**
 * ★ §8.4 的硬规则**条数**（写死为常量）。
 *
 * ⚠️ **为什么必须由 CI 守**：§8.4 标题写「六条硬规则」，正文实际列了 6 条。
 *   这两处一旦漂移（比如正文加到第 7 条、标题还写 6），全文所有引用
 *   「§8.4 硬规则 N」的地方（`DEVELOPMENT-PLAN.md` 与 `src/` 的注释都靠它定位）
 *   **全部指错** —— 而这**不会报任何错**，只会让实现者按错的口径写代码。
 *
 * ⚠️ 此前这条只被 `scripts/verify_errata_writeback.py` 断言，而那个脚本**不在 verify 链里**
 *   ⇒ CI 根本不守（QA 复核 F-03）。现补进本脚本（本脚本**在** verify 链里）。
 */
export const EXPECTED_HARD_RULE_COUNT = 6;

/**
 * §8.4 里「六条硬规则」那一段的编号列表（形如 `1. `、`2. ` …）。
 *
 * ⚠️ **编号后必须允许 `★`**：规则 4 的原文是
 *   `4. ★ **只有 \`action === 'purge'\` AND \`purged > 0\` 才代表……**`
 *   —— `★` 夹在编号与 `**` 之间。若要求编号后紧跟 `**`，规则 4 会被漏数
 *   ⇒ 数出 5 条 ⇒ **守卫对真实文档误报**（一个恒不等于期望值的守卫 = 没有守卫）。
 */
const HARD_RULE_NUMBERED_PATTERN = /^\s*(\d+)\.\s+(?:★\s*)?\*\*/gm;

/**
 * 数出 §8.4 硬规则列表的条数。
 *
 * ⚠️ **只数「以 `N. **` 开头的编号项」** —— §8.4 里还有别的编号列表（发射点表格的说明等），
 *   不加限定就会把不相干的编号也算进来 ⇒ 恒大于 6 ⇒ 守卫变成摆设。
 */
export function countHardRules(section: string): number {
  HARD_RULE_NUMBERED_PATTERN.lastIndex = 0;
  let count = 0;
  while (HARD_RULE_NUMBERED_PATTERN.exec(section) !== null) {
    count += 1;
  }
  return count;
}

/** 规范化单元格（去掉 markdown 粗体标记、压缩空白）——只比内容，不比排版。 */
export function normalizeCell(cell: string): string {
  return cell.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** 从 §14.3.1 里找出锚定表（表头为 `规则 / 动作关键词 / 管辖路径` 的那张）。 */
export function findAnchorTable(markdown: string): string[][] | undefined {
  const section = extractSection(markdown, SECTION_14_3_1_HEADING);
  for (const table of parseMarkdownTables(section)) {
    const header = table.header.map((cell) => normalizeCell(cell));
    if (
      header.length === ANCHOR_HEADER.length &&
      header.every((cell, i) => cell === ANCHOR_HEADER[i])
    ) {
      // ⚠️ 必须剔除分隔行（`| --- | --- | --- |`）——它会让行数多出 1，整张表错位
      return table.rows.filter((row) => !isSeparatorRow(row));
    }
  }
  return undefined;
}

/** 一处差异。 */
export interface AnchorDiff {
  /** 差异说明。 */
  reason: string;
}

// ─────────────────────── 动作关键词的落点（P2-T04 新增） ───────────────────────

/**
 * 落点类型。
 *
 * ⚠️ **为什么有三种**：不同规则的「管辖路径」性质不同 ——
 *   有的路径是**实现代码**（§4.9 的三条写路径），
 *   有的路径**本身就是设计稿的表 / 面板 / 状态表**（§7.2 面板 1、ADR-16），
 *   还有的路径**实现尚未存在**（§4.9.1 的 `updateContent` 属阶段 4）。
 *   ⇒ 硬套一种 ⇒ 要么误报、要么把「还没做」当成「做错了」。
 */
export type AnchorPathKind = 'code' | 'doc' | 'pending';

/** 一条管辖路径的**落点**（**写死**）。 */
export interface AnchorPathBinding {
  /** 设计稿锚定表第三列里的路径标签（**规范化后**逐字一致）。 */
  label: string;
  /** 落点类型。 */
  kind: AnchorPathKind;
  /** `kind === 'code'`：源文件（相对仓库根）。 */
  file?: string;
  /** `kind === 'code'`：该路径对应的**函数体**符号；省略 = 整个文件。 */
  symbol?: string;
  /** `kind === 'doc'`：设计稿小节的标题（逐字）。 */
  heading?: string;
  /** `kind === 'pending'`：**为什么**还没有落点（必须写明 ⇒ 不许静默跳过）。 */
  pendingReason?: string;
  /**
   * `kind === 'code'`：**必须**命中的关键词（**全部**命中才算通过）。
   *
   * ⚠️ **为什么需要它**（P2 QA 验收 F3）：
   *   规则的关键词是**弱 OR**（命中任一即可）⇒ 而「写入桶归属」与「删除桶归属」
   *   是**两个不同的动作** ⇒ 把 `assignBucket` 换成假对象、**只留** `unassignBucket`
   *   ⇒ 弱 OR 照样满足 ⇒ **锚定门禁分不清「写入」与「删除」**。
   *   ⇒ ⇒ 逐个落点**写死它必须出现的动作** ⇒ 把弱 OR 收紧成「这条路径**必须**做这个动作」。
   *
   * ⚠️ **省略 = 沿用规则的弱 OR**（保持既有落点行为不变 ⇒ 不做无关改动）。
   */
  requiredKeywords?: readonly string[];
}

/** 一条规则的落点集合。 */
export interface AnchorRuleBinding {
  /** 规则名（§14.3.1 锚定表第一列，逐字）。 */
  rule: string;
  /** 管辖路径的落点（**条数写死**）。 */
  paths: readonly AnchorPathBinding[];
}

/**
 * ★ **写死的期望值**：每条规则的**管辖路径条数**（C31 的分母）。
 *
 * ⚠️ **不能用「实际命中几个」当分母** ⇒ 脚本被删一半仍全绿。
 * ⚠️ 这五个数与 §14.3.1 锚定表第三列的项数**逐条一致**（4 / 6 / 6 / 7 / 4）。
 */
export const EXPECTED_ANCHOR_PATH_COUNTS: readonly (readonly [string, number])[] = [
  ['桶归属同步', 4],
  ['探针覆盖', 6],
  ['reinforce 边界', 6],
  ['向量路缺席', 7],
  ['切分触发量', 4],
];

/**
 * ★ **写死的**落点表：每条规则的每个管辖路径，落在**哪里**。
 *
 * ⚠️ **为什么逐条写死**：错列会**静默地**校验到错误的落点上
 *   ⇒ 「每个承诺指到唯一代码路径」（§14.3 边界原则 1）在机器可检的层面落地。
 * ⚠️ **落点的选择理由**（逐条）：
 *   · 「桶归属同步」⇒ 三条**写路径**的实现代码（P2-T03-b 已挂接），
 *     第四条（§4.9.1 的 `updateContent`）**属阶段 4** ⇒ `pending`；
 *   · 「探针覆盖」⇒ 它的动作是**可测的性质**（吻合率 / 只漏不错）⇒ 落在**设计稿小节**，
 *     而 §4.9 步骤 3a2 的向量路候选**尚未接通**（T05/T06）⇒ `pending`；
 *   · 「reinforce 边界」⇒ 多数是**设计稿小节**；§0.2.2（「共激活建立率」）
 *     与 §0.2.3（「调用方应当怎么做」）是**面向人的散文**，正文里没有字面的动作关键词
 *     ⇒ 它们的落点分别是**它们描述的那段代码**：
 *     `src/store/touch.ts`（共激活边的建立入口）与 `src/store/recall.ts`
 *     （`recall({ reinforce: true })` 的开关与「不建共激活边」的边界）；
 *   · 「向量路缺席」⇒ 多数是**设计稿小节**；§0.2.3 ④ 的落点是
 *     `src/core/flags.ts`（`mode` / `absent` / `inRetrain` 的定义处）；
 *   · 「切分触发量」⇒ §4.12.4 / §6 两节；§3 的 `cluster_snapshot_meta`
 *     当前只有 `max_raw_ratio`（对外名 `maxRawComponentRatio` 属阶段 3 的收敛）、
 *     §7.2 面板 7（簇快照面板）**属阶段 4** ⇒ 两条 `pending`。
 */
export const ANCHOR_PATH_BINDINGS: readonly AnchorRuleBinding[] = [
  {
    rule: '桶归属同步',
    paths: [
      {
        label: '§4.9 步骤 2',
        kind: 'code',
        file: 'src/store/write.ts',
        symbol: 'handleExactRepeat',
        // ⚠️ **必需关键词**（F3）：这条路径的语义是「**补写向量 ⇒ 同步入桶**」
        //   ⇒ 必须出现 `assignBucket`（**写入**桶归属）⇒ 不能用「命中任一即可」的弱 OR
        //   ⇒ 否则「把 assignBucket 换成假对象、只留 unassignBucket」也能过。
        requiredKeywords: ['assignBucket'],
      },
      {
        label: '§4.9 步骤 3c ②',
        kind: 'code',
        file: 'src/store/merge.ts',
        symbol: 'mergeMemory',
        requiredKeywords: ['assignBucket'],
      },
      {
        label: '§4.9 步骤 4',
        kind: 'code',
        file: 'src/store/write.ts',
        symbol: 'createMemory',
        requiredKeywords: ['assignBucket'],
      },
      {
        label: '§4.9.1 步骤 4',
        kind: 'pending',
        pendingReason:
          '§4.9.1 的 updateContent 属阶段 4：src/store/updateContent.ts 尚未建 ' +
          '（建一个「只改正文、不写桶」的空壳 = 假绿，同 P1-T07 对空壳 assignBucket 的处置）',
      },
    ],
  },
  {
    rule: '探针覆盖',
    paths: [
      {
        label: '§4.15.3 选型表',
        kind: 'doc',
        heading: '#### 4.15.3 本版实现：主库内的两级 k-means 分桶（IVF）',
      },
      {
        label: '§4.15.4 ②③',
        kind: 'doc',
        heading: '#### 4.15.4 分桶对打分的影响：**连候选池都不变**',
      },
      { label: '§4.6 步骤 2c', kind: 'doc', heading: '### 4.6 三路召回与融合打分' },
      {
        label: '§4.9 步骤 3a2',
        kind: 'pending',
        pendingReason:
          '§4.9 步骤 3a2 的写入路径向量路候选尚未接通（阶段 2 的 T05/T06）' +
          '⇒ 「只漏不错」这条性质在代码里还没有可观测的落点',
      },
      { label: 'ADR-16', kind: 'doc', heading: '## 13. 设计决策记录（ADR 摘要）' },
      { label: 'ADR-17', kind: 'doc', heading: '## 13. 设计决策记录（ADR 摘要）' },
    ],
  },
  {
    rule: 'reinforce 边界',
    paths: [
      { label: '§4.2', kind: 'doc', heading: '### 4.2 稳定度增长（记忆加固）' },
      { label: '§4.6 步骤 4', kind: 'doc', heading: '### 4.6 三路召回与融合打分' },
      { label: '§6', kind: 'doc', heading: '## 6. 接口设计（TypeScript 同步 API）' },
      {
        label: '§8.4',
        kind: 'doc',
        heading: '### 8.4 事件类型与发射点对照表（枚举必须逐个落地）',
      },
      {
        label: '§0.2.2',
        kind: 'code',
        file: 'src/store/touch.ts',
      },
      {
        label: '§0.2.3',
        kind: 'code',
        file: 'src/store/recall.ts',
      },
    ],
  },
  {
    rule: '向量路缺席',
    paths: [
      { label: '§4.6 步骤 0d', kind: 'doc', heading: '### 4.6 三路召回与融合打分' },
      { label: '§4.6 步骤 2c', kind: 'doc', heading: '### 4.6 三路召回与融合打分' },
      { label: '§4.15.6', kind: 'doc', heading: '#### 4.15.6 可复现性的口径' },
      { label: '§6', kind: 'doc', heading: '## 6. 接口设计（TypeScript 同步 API）' },
      { label: '§7.2 面板 1', kind: 'doc', heading: '### 7.2 功能面板' },
      { label: '§7.3 状态表', kind: 'doc', heading: '### 7.3 状态与错误呈现' },
      { label: '§0.2.3 ④', kind: 'code', file: 'src/core/flags.ts' },
    ],
  },
  {
    rule: '切分触发量',
    paths: [
      { label: '§4.12.4 ③', kind: 'doc', heading: '#### 4.12.4 超大簇的三层防护' },
      { label: '§6', kind: 'doc', heading: '## 6. 接口设计（TypeScript 同步 API）' },
      {
        label: '§3 cluster_snapshot_meta',
        kind: 'pending',
        pendingReason:
          '§3 的 cluster_snapshot_meta 当前只有 max_raw_ratio（触发量）' +
          '⇒ 对外名 maxRawComponentRatio 属阶段 3 的收敛（README 的 C35 行）',
      },
      {
        label: '§7.2 面板 7',
        kind: 'pending',
        pendingReason: '§7.2 面板 7（簇快照面板）属阶段 4 的实现范围',
      },
    ],
  },
];

/** 一条管辖路径的判定结果。 */
export interface AnchorPathOutcome {
  /** 规则名。 */
  rule: string;
  /** 路径标签。 */
  label: string;
  /** 落点类型。 */
  kind: AnchorPathKind;
  /** 判定结果。 */
  status: 'ok' | 'pending' | 'missing';
  /** 说明（命中了哪个关键词 / 为什么待补 / 缺了什么）。 */
  detail: string;
}

/**
 * 判定「动作关键词是否落在管辖路径上」。
 *
 * @param rows §14.3.1 锚定表的行（每行三列）
 * @param options `repoRoot`（读源码用）、`designDoc`（读设计稿用）、
 *   以及可选的 `bindings`（**默认用写死的落点表**；单测可传入改过的副本做负控）
 * @returns 逐条判定结果 + 不一致清单
 */
export function checkAnchorPathBindings(
  rows: string[][],
  options: {
    repoRoot: string;
    designDoc: string;
    bindings?: readonly AnchorRuleBinding[];
  },
): { outcomes: AnchorPathOutcome[]; diffs: AnchorDiff[] } {
  const diffs: AnchorDiff[] = [];
  const outcomes: AnchorPathOutcome[] = [];
  const bindings = options.bindings ?? ANCHOR_PATH_BINDINGS;

  for (const [rule, expectedCount] of EXPECTED_ANCHOR_PATH_COUNTS) {
    const row = rows.find((candidate) => normalizeAnchorLabel(candidate[0] ?? '') === rule);
    if (row === undefined) {
      diffs.push({ reason: `锚定表里没有「${rule}」这一行` });
      continue;
    }

    const keywords = parseAnchorKeywords(row[1] ?? '');
    const labels = parseAnchorPathLabels(row[2] ?? '');
    const binding = bindings.find((candidate) => candidate.rule === rule);
    if (binding === undefined) {
      diffs.push({ reason: `「${rule}」没有写死的落点表（ANCHOR_PATH_BINDINGS 里缺这一条）` });
      continue;
    }

    // ── ① 路径条数：文档侧与落点侧**都要**等于写死的期望值（C31）──
    if (labels.length !== expectedCount) {
      diffs.push({
        reason:
          `「${rule}」的管辖路径条数不一致：设计稿解析出 ${labels.length} 条，` +
          `写死的期望是 ${expectedCount} 条`,
      });
    }
    if (binding.paths.length !== expectedCount) {
      diffs.push({
        reason:
          `「${rule}」的落点条数不一致：落点表里有 ${binding.paths.length} 条，` +
          `写死的期望是 ${expectedCount} 条`,
      });
    }

    // ── ② 路径标签**逐条**一致（不只比数量）──
    const bindingLabels = binding.paths.map((path) => path.label);
    for (const label of labels) {
      if (!bindingLabels.includes(label)) {
        diffs.push({ reason: `「${rule}」的落点表里没有「${label}」这条路径` });
      }
    }
    for (const label of bindingLabels) {
      if (!labels.includes(label)) {
        diffs.push({ reason: `「${rule}」的落点表多出「${label}」这条路径` });
      }
    }

    // ── ③ 逐条判定：关键词是否落在该路径上 ──
    for (const path of binding.paths) {
      const outcome = judgeAnchorPath(rule, path, keywords, options);
      outcomes.push(outcome);
      if (outcome.status === 'missing') {
        diffs.push({ reason: `「${rule}」的「${path.label}」：${outcome.detail}` });
      }
    }
  }

  return { outcomes, diffs };
}

/**
 * 判定**一条**路径：关键词是否落在它的落点里。
 *
 * ⚠️ **关键词从设计稿那一行现解析**（不是另写一份 ⇒ C36）。
 */
function judgeAnchorPath(
  rule: string,
  path: AnchorPathBinding,
  keywords: readonly string[],
  options: { repoRoot: string; designDoc: string },
): AnchorPathOutcome {
  if (path.kind === 'pending') {
    return {
      rule,
      label: path.label,
      kind: path.kind,
      status: 'pending',
      detail: path.pendingReason ?? '（未写明待补原因）',
    };
  }

  if (path.kind === 'doc') {
    const heading = path.heading ?? '';
    let section: string;
    try {
      section = extractSection(options.designDoc, heading);
    } catch {
      return {
        rule,
        label: path.label,
        kind: path.kind,
        status: 'missing',
        detail: `设计稿里找不到小节「${heading}」`,
      };
    }
    const hit = keywords.find((keyword) => containsAnchorKeyword(section, keyword));
    return {
      rule,
      label: path.label,
      kind: path.kind,
      status: hit === undefined ? 'missing' : 'ok',
      detail: hit === undefined ? '该小节里没有出现任何动作关键词' : `命中关键词「${hit}」`,
    };
  }

  const file = path.file ?? '';
  let source: string;
  try {
    source = readSourceFile(options.repoRoot, file);
  } catch {
    return {
      rule,
      label: path.label,
      kind: path.kind,
      status: 'missing',
      detail: `实现文件不存在：${file}`,
    };
  }

  let haystack = source;
  if (path.symbol !== undefined) {
    const body = extractFunctionBody(source, path.symbol);
    if (body === undefined) {
      return {
        rule,
        label: path.label,
        kind: path.kind,
        status: 'missing',
        detail: `${file} 里找不到函数体「${path.symbol}」`,
      };
    }
    haystack = body;
  }

  // ⚠️⚠️ **P2 QA 验收 F4**：**涂白字符串字面量**后再匹配
  //   ⇒ 否则「动作关键词只出现在一个字符串里」也会被判绿
  //   （例如 `const assignment = 'assignBucket(...)';` ⇒ 真调用已被删掉 ⇒ 承诺已失效却判绿）。
  //   ⇒ ⚠️ **只对 `code` 落点做**：`doc` 落点**必须保留字符串**
  //     （设计稿正文里 `'absent'` / `'reinforce'` 这类带引号的字面量**就是**动作关键词本身）。
  const codeHaystack = blankStrings(haystack);

  const hit = keywords.find((keyword) => containsAnchorKeyword(codeHaystack, keyword));
  // ⚠️ **P2 QA 验收 F3**：若该落点**写死了必需关键词** ⇒ 必须**全部**命中才算通过。
  //   ⇒ 把「弱 OR（命中任一即可）」收紧成「这条路径**必须**做这个动作」。
  if (path.requiredKeywords !== undefined && path.requiredKeywords.length > 0) {
    const missed = path.requiredKeywords.filter(
      (keyword) => !containsAnchorKeyword(codeHaystack, keyword),
    );
    if (missed.length > 0) {
      return {
        rule,
        label: path.label,
        kind: path.kind,
        status: 'missing',
        detail: `该落点里缺少必需的动作关键词「${missed.join('」「')}」（命中任一即可的弱 OR 在此不成立）`,
      };
    }
    return {
      rule,
      label: path.label,
      kind: path.kind,
      status: 'ok',
      detail: `命中必需的动作关键词「${path.requiredKeywords.join('」「')}」`,
    };
  }
  return {
    rule,
    label: path.label,
    kind: path.kind,
    status: hit === undefined ? 'missing' : 'ok',
    detail: hit === undefined ? '该落点里没有出现任何动作关键词' : `命中关键词「${hit}」`,
  };
}

/** 比对锚定表与写死的期望。 */
export function compareAnchorRows(rows: string[][]): AnchorDiff[] {
  const diffs: AnchorDiff[] = [];

  if (rows.length !== EXPECTED_ANCHOR_ROWS.length) {
    diffs.push({
      reason: `行数不一致：§14.3.1 有 ${rows.length} 行，写死的期望是 ${EXPECTED_ANCHOR_ROWS.length} 行`,
    });
  }

  const count = Math.min(rows.length, EXPECTED_ANCHOR_ROWS.length);
  for (let index = 0; index < count; index += 1) {
    const actual = rows[index] ?? [];
    const expected = EXPECTED_ANCHOR_ROWS[index] ?? [];

    if (actual.length !== ANCHOR_HEADER.length) {
      diffs.push({
        reason: `第 ${index + 1} 行有 ${actual.length} 列，**每行必须只有 3 列**（多出的列会让按列解析的校验脚本取错列）`,
      });
      continue;
    }

    for (let column = 0; column < ANCHOR_HEADER.length; column += 1) {
      const actualCell = normalizeCell(actual[column] ?? '');
      const expectedCell = normalizeCell(expected[column] ?? '');
      if (actualCell !== expectedCell) {
        diffs.push({
          reason:
            `第 ${index + 1} 行第 ${column + 1} 列（${ANCHOR_HEADER[column]}）不一致：\n` +
            `      §14.3.1：${actualCell}\n` +
            `      写死的期望：${expectedCell}`,
        });
      }
    }
  }

  return diffs;
}

/** 主流程。 */
function main(): void {
  const markdown = readDesignDoc();
  const rows = findAnchorTable(markdown);

  process.stdout.write('跨节锚定检查（5 行 × 3 列）\n');

  if (rows === undefined) {
    process.stderr.write(
      '\n✗ 在 §14.3.1 里找不到锚定表（表头应为 规则 / 动作关键词 / 管辖路径）\n',
    );
    process.exitCode = 1;
    return;
  }

  const diffs = compareAnchorRows(rows);
  if (diffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${diffs.length} 处不一致：\n`);
    for (const diff of diffs) {
      process.stderr.write(`    ${diff.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ 跨节锚定清单：5 行 × 3 列，且与写死的期望一致\n');

  // ── 动作关键词是否落在管辖路径上（P2-T04）──
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { outcomes, diffs: pathDiffs } = checkAnchorPathBindings(rows, {
    repoRoot,
    designDoc: markdown,
  });

  const pending = outcomes.filter((outcome) => outcome.status === 'pending');
  const ok = outcomes.filter((outcome) => outcome.status === 'ok');
  process.stdout.write(
    `\n  动作关键词落点：${ok.length} 条命中 / ${pending.length} 条待补 / ${outcomes.length} 条合计\n`,
  );
  if (pending.length > 0) {
    // ⚠️ **待补必须写进输出**（不许静默跳过）⇒ 否则「待补」会变成「没人管」。
    process.stdout.write('  待补（实现尚未存在 ⇒ 记为待补，不判红）：\n');
    for (const outcome of pending) {
      process.stdout.write(`    · ${outcome.rule} → ${outcome.label}：${outcome.detail}\n`);
    }
  }

  if (pathDiffs.length > 0) {
    process.stderr.write(`\n✗ 发现 ${pathDiffs.length} 处动作关键词落点不一致：\n`);
    for (const diff of pathDiffs) {
      process.stderr.write(`    ${diff.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ 每条规则的每个管辖路径上，都出现了该规则的动作关键词\n');

  // ── §8.4 硬规则条数（QA 复核 F-03：此前只有不在 verify 链里的脚本守着）──
  const section84 = extractSection(markdown, SECTION_8_4_HEADING);
  if (section84 === undefined) {
    process.stderr.write('\n✗ 在设计稿里找不到 §8.4 这一节\n');
    process.exitCode = 1;
    return;
  }

  const hardRuleCount = countHardRules(section84);
  if (hardRuleCount !== EXPECTED_HARD_RULE_COUNT) {
    process.stderr.write(
      `\n✗ §8.4 的硬规则条数不一致：正文数出 ${hardRuleCount} 条，期望 ${EXPECTED_HARD_RULE_COUNT} 条\n` +
        '  ⇒ 全文所有「§8.4 硬规则 N」的引用都会指错（且不报错）\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n✓ §8.4 硬规则条数：${hardRuleCount} 条（与写死的期望一致）\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
