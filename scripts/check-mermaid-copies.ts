#!/usr/bin/env tsx
/**
 * mermaid 抽取副本的**锚点校验** —— 把「副本 == 权威版」变成**机器可复算**的东西。
 *
 * ## 背景（为什么有这条脚本）
 *
 * `docs/class-diagram.mermaid` 与 `docs/sequence-diagram.mermaid` 是
 * `docs/design/perf-c2-t06-byte-metering-spec.md`（下称「②」）§12 那两张图的**抽取副本**。
 *
 * ⚠️ ★ 它们**曾经是各自维护的第二份口径** ⇒ 已经漂移过一次：
 *   · 类图里的接口名与实现对不上（`normalize` vs `normalizeSql` …）；
 *   · 时序图里还写着**旧的单轮语义**（`candidateUniverse[i] 与计时轮 vectorCandidateRows[i] 逐样本比对`）。
 * ⇒ ⇒ 本脚本的作用是**把「两份各自演化」这条路物理封死**：
 *   副本**只能是** ② §12 的**逐字字节复制** ⇒ 唯一的维护动作 = 「改 ② → 按锚点重抽」。
 *
 * ## 为什么用**锚点**（不用行号）
 *
 * ⚠️ ★ **行号引用是机制性必坏的**：② 每被编辑一次（插一行限定语、改一行类图），
 *   引用它行号的副本头就**当场失效** ⇒ 而「照失效行号重抽」会抽出一份**畸形图**
 *   （实测：多抽了围栏、少抽了 `uninstall()` 与「剪枝率」两行）
 *   ⇒ ⇒ 而且**错列是静默的**（不报错 ⇒ 没人会发现）
 *   ⇒ 这与 `scripts/check-anchor.ts` 头注释那句
 *   「**缺行会报错，而错列会静默地校验通过**」是同一类病。
 *
 * ⇒ 所以本脚本**只认锚点**：② 的**节标题** + 该节内**第 N 个 ```mermaid 围栏块**。
 * ⇒ 并且**主动拒绝**副本头里出现行号引用（防回归 ⇒ 见「副本头」那组断言）。
 *
 * ## ⚠️ 这条脚本自己**绝不能是恒绿守卫**
 *
 * 本项目刚治好一类「恒绿守卫」⇒ 所以本脚本**自带正控 + 负控**（`--self-test`）：
 *   · **正控**：副本 == ② 的锚点抽取 ⇒ 零差异 ⇒ 通过；
 *   · **负控**：喂**改坏的副本 / 坏图** ⇒ 必须**报出对应类别**（不是只报「失败」）。
 * ⇒ 负控夹具**必须真的进得了判定路径** ⇒ 本实现对每个负控**断言具体失败类别**，
 *   而不只是断言「exit 1」⇒ 否则「夹具没进判定路径」会伪装成「守卫有牙」。
 *
 * ## 为什么结构体检是**刚需**（不是锦上添花）
 *
 * ⚠️ **仓库里没有任何 mermaid 语法校验**（实测：没装 mermaid 包、没有任何脚本扫 `.mermaid`）
 * ⇒ ⇒ **图写坏了不会被任何门禁抓到**（`pnpm run verify` 照样 exit 0）
 * ⇒ ⇒ 本实现用**静态结构体检**兜底（首行 / 末行 / 嵌套围栏 / `%%` 形态）。
 *
 * ## ⚠️ ★ `--write` 是**幂等**的（为什么这条很重要）
 *
 * ⚠️ ★ **一个每次运行都弄脏工作区的工具，会把「工作区脏 ⇒ 一定有东西要查」这条信号变成噪声。**
 *   而那正是本项目最核心的纪律之一 ⇒ ⇒ 所以 `--write` 的规则是：
 *
 *   · 先把权威版按锚点抽成**正文** ⇒ 与现有副本**逐字比对**：
 *     · **正文一致 且 头部（除「抽取时刻」那一行）也一致** ⇒ ⇒ **一行都不改**（连「抽取时刻」都不动）
 *       ⇒ ⇒ 「抽取时刻」记录的是【最后一次**正文真的变了**的时刻】，**不是**最后一次运行时刻；
 *     · **正文变了 或 头部过时了**（例如头部还写着旧措辞 / 旧行号）⇒ ⇒ 才写盘，并**刷新「抽取时刻」**。
 *
 * ⇒ ⇒ 「只更新必要的那一行？⇒ **不** ⇒ 要么全不改，要么整体重写」⇒ ⇒ **跑一次 `--write`
 *   不会在工作区留下任何痕迹**（除非权威版真的变了）。
 *
 * ## 用法
 *   tsx scripts/check-mermaid-copies.ts                # 校验（默认）
 *   tsx scripts/check-mermaid-copies.ts --write        # 按锚点重抽（**幂等**：没变就一行都不改）
 *   tsx scripts/check-mermaid-copies.ts --self-test    # 自带正控 + 负控（证明这条守卫有牙）
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractSection } from './lib/design-doc.js';

// ── 常量（**路径与标题写死为常量**，不接受配置 ⇒ 与 `check-gate-entry.ts` 同一条纪律）──

/** 权威版（②）—— 那两张图的宿主文档。 */
const SOURCE_PATH = 'docs/design/perf-c2-t06-byte-metering-spec.md';
/** 权威版里那两张图所在的小节标题（**逐字**，含井号与空格）。 */
const SECTION_HEADING = '## 12. 类图与时序图';

type CopyKind = 'class' | 'sequence';

interface CopySpec {
  /** 角色名（出现在副本头的锚点描述里）。 */
  readonly role: string;
  /** 围栏序号（**第几个** ```mermaid 块）⇒ 这就是锚点的一半。 */
  readonly ordinal: number;
  /** 图类型（决定「末行完整」的判据）。 */
  readonly kind: CopyKind;
  /** 副本路径（相对仓库根）。 */
  readonly path: string;
}

const CLASS_COPY: CopySpec = {
  role: '类图',
  ordinal: 1,
  kind: 'class',
  path: 'docs/class-diagram.mermaid',
};

const SEQUENCE_COPY: CopySpec = {
  role: '时序图',
  ordinal: 2,
  kind: 'sequence',
  path: 'docs/sequence-diagram.mermaid',
};

// ⚠️ `COPY_SPECS` 不做成数组常量：两份副本的**角色 / 序号 / 路径**各自写死成常量
//   ⇒ 少一个「数组里多一个元素 ⇒ 序号错位」的失手面（序号是锚点的一半，错位 = 静默取错块）。

/** 合法的 mermaid 图类型指令（**首行**必须是其中之一）。 */
const DIAGRAM_DIRECTIVES: ReadonlySet<string> = new Set([
  'classDiagram',
  'sequenceDiagram',
  'flowchart',
  'stateDiagram',
  'stateDiagram-v2',
  'graph',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'gitGraph',
]);

/**
 * 「行号引用」的模式 —— **本脚本要主动拒绝的东西**。
 *
 * ⚠️ 只认两种中文写法：
 *   · `第 198–272 行`（带「第」⇒ 任何连字符都行）
 *   · `198–272 行`（不带「第」⇒ **只认 en dash / em dash / 波浪号**）
 * ⇒ 刻意**不认普通连字符**（`-`）⇒ 否则 `docs/2026-11-05-…` 这类路径会误报。
 */
const LINE_RANGE_PATTERN = /第\s*\d+\s*[–—\-~至]\s*\d+\s*行|\d+\s*[–—~]\s*\d+\s*行/;

/** 副本头里必须出现的「非权威」声明。 */
const NON_AUTHORITATIVE_MARK = '不是权威版';

// ── 类型 ──

type IssueCategory =
  | '源文件解析失败'
  | '围栏不闭合'
  | '副本缺失'
  | '副本正文不一致'
  | '副本头锚点描述不符'
  | '副本头仍写死行号'
  | '副本头缺抽取时刻'
  | '副本头缺非权威声明'
  | '图类型指令不在首行'
  | '末行不完整'
  | '块内嵌套围栏'
  | '%% 畸形行'
  | '语句行带尾注'
  | '无缩进 %% 行';

interface Issue {
  readonly category: IssueCategory;
  readonly detail: string;
}

interface Report {
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly metrics: readonly string[];
}

// ── 锚点描述（副本头里那几行）──

function anchorSourceLine(sourcePath: string, sectionHeading: string): string {
  return `抽取自：② \`${sourcePath}\` 的「${sectionHeading}」节内`;
}

function anchorOrdinalLine(ordinal: number, role: string): string {
  return `第 ${ordinal} 个 \`\`\`mermaid 围栏块（${role}）`;
}

// ── 解析 ──

/**
 * 从小节正文里抽出全部 ```mermaid 块（**按围栏配对**，不靠行号）。
 *
 * ⚠️ **围栏不闭合 ⇒ 必须报出来**（不能当作「就一个块」⇒ 那是解析器漏读伪装成一致）。
 */
function extractMermaidBlocks(section: string): { blocks: string[]; unclosed: boolean } {
  const lines = section.split('\n');
  const blocks: string[] = [];
  let index = 0;
  let unclosed = false;
  while (index < lines.length) {
    if ((lines[index] ?? '').trim() !== '```mermaid') {
      index += 1;
      continue;
    }
    const body: string[] = [];
    index += 1;
    let closed = false;
    while (index < lines.length) {
      const line = lines[index] ?? '';
      if (line.trim() === '```') {
        closed = true;
        index += 1;
        break;
      }
      body.push(line);
      index += 1;
    }
    if (!closed) {
      unclosed = true;
      break;
    }
    blocks.push(body.join('\n'));
  }
  return { blocks, unclosed };
}

/** 把副本拆成「头部注释行」与「正文」。 */
function splitCopy(text: string): { header: string[]; body: string } {
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length && /^\s*%%/.test(lines[index] ?? '')) {
    index += 1;
  }
  return { header: lines.slice(0, index), body: lines.slice(index).join('\n') };
}

/** 逐行找出第一处不同（供报错时给出可读证据）。 */
function describeFirstDiff(actual: string, expected: string): string {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const limit = Math.max(actualLines.length, expectedLines.length);
  for (let index = 0; index < limit; index += 1) {
    const left = actualLines[index];
    const right = expectedLines[index];
    if (left !== right) {
      return `第 ${index + 1} 行不同（副本=「${left ?? '（无此行）'}」/ 权威=「${right ?? '（无此行）'}」）`;
    }
  }
  return '（逐行相同但总行数不同）';
}

/** 读副本头里「抽取时刻」那一行的原文（供自测判断它有没有被刷新）。 */
function readStampOf(path: string): string {
  try {
    return (
      readFileSync(path, 'utf8')
        .split('\n')
        .find((line) => line.includes(TIMESTAMP_MARK)) ?? '（无）'
    );
  } catch {
    return '（读不到）';
  }
}

// ── 结构体检（**替代不存在的 mermaid 解析器**）──

function structuralIssues(block: string, kind: CopyKind): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const lines = block.split('\n');
  const first = lines[0] ?? '';
  const last = lines[lines.length - 1] ?? '';

  if (!DIAGRAM_DIRECTIVES.has(first.trim())) {
    errors.push({
      category: '图类型指令不在首行',
      detail: `首行是「${first}」⇒ mermaid 认不出图类型`,
    });
  }

  // ⚠️ 「末行完整」给**可机器判定**的定义（不靠人眼）：
  //   类图末行必须是关系行（`..>` / `-->`）· 时序图末行必须是箭头行（`->>` / `->`）。
  const terminalPattern = kind === 'class' ? /(\.\.>|-->)/ : /(->>|->)/;
  if (!terminalPattern.test(last)) {
    errors.push({
      category: '末行不完整',
      detail: `末行是「${last}」⇒ 图被截断了（末行应是${kind === 'class' ? '关系行' : '箭头行'}）`,
    });
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      errors.push({ category: '块内嵌套围栏', detail: `块内出现围栏行「${line.trim()}」` });
      continue;
    }
    if (/^\s*%%[^ \t]/.test(line)) {
      // ⚠️ `%%{` 会被 mermaid 当成**指令**（`%%{init: …}%%`）而不是注释 ⇒ 判红。
      errors.push({
        category: '%% 畸形行',
        detail: `「%%」后紧跟非空白：${line.trim()}`,
      });
      continue;
    }
    if (/^\s*%%/.test(line)) {
      if (/^%%/.test(line)) {
        warnings.push({ category: '无缩进 %% 行', detail: line.trim() });
      }
      continue;
    }
    if (line.includes('%%')) {
      warnings.push({ category: '语句行带尾注', detail: line.trim() });
    }
  }

  return { errors, warnings };
}

// ── 校验主体 ──

interface CheckOptions {
  /**
   * 权威版的**物理路径**（只为「读文件」用）。
   *
   * ⚠️ ★ **它不参与锚点描述的比对** ⇒ 锚点里写死的是**规范相对路径**（`SOURCE_PATH`）
   *   ⇒ ⇒ 「从哪个目录跑这条脚本」不影响比对结果（否则临时目录一换、正控就假红）。
   */
  readonly sourcePath: string;
  /** 两份副本的规格（路径可被夹具覆盖）。 */
  readonly copies: readonly CopySpec[];
}

function checkCopies(options: CheckOptions): Report {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const metrics: string[] = [];

  let markdown = '';
  try {
    markdown = readFileSync(options.sourcePath, 'utf8');
  } catch (error) {
    errors.push({ category: '源文件解析失败', detail: `读不到权威版：${String(error)}` });
    return { errors, warnings, metrics };
  }

  let section = '';
  try {
    section = extractSection(markdown, SECTION_HEADING);
  } catch {
    errors.push({
      category: '源文件解析失败',
      detail: `权威版里找不到节标题「${SECTION_HEADING}」`,
    });
    return { errors, warnings, metrics };
  }

  const { blocks, unclosed } = extractMermaidBlocks(section);
  if (unclosed) {
    errors.push({
      category: '围栏不闭合',
      detail: '权威版里有一个 ```mermaid 块没有对应的 ``` ⇒ 抽取不可信',
    });
    return { errors, warnings, metrics };
  }
  if (blocks.length < options.copies.length) {
    errors.push({
      category: '源文件解析失败',
      detail: `权威版里只有 ${blocks.length} 个 mermaid 块，期望 ≥ ${options.copies.length}`,
    });
    return { errors, warnings, metrics };
  }

  for (const spec of options.copies) {
    const block = blocks[spec.ordinal - 1];
    if (block === undefined) {
      errors.push({
        category: '源文件解析失败',
        detail: `找不到第 ${spec.ordinal} 个 mermaid 块`,
      });
      continue;
    }

    // ① 权威块自身的结构体检
    const structural = structuralIssues(block, spec.kind);
    errors.push(...structural.errors);
    warnings.push(...structural.warnings);

    // ② 副本
    let copyText = '';
    try {
      copyText = readFileSync(spec.path, 'utf8').replace(/\n$/, '');
    } catch {
      errors.push({ category: '副本缺失', detail: `${spec.path} 读不到` });
      continue;
    }
    const { header, body } = splitCopy(copyText);
    const headerText = header.join('\n');

    const expectedSourceLine = anchorSourceLine(SOURCE_PATH, SECTION_HEADING);
    const expectedOrdinalLine = anchorOrdinalLine(spec.ordinal, spec.role);
    if (!headerText.includes(expectedSourceLine)) {
      errors.push({
        category: '副本头锚点描述不符',
        detail: `${spec.path} 的头部缺少「${expectedSourceLine}」`,
      });
    }
    if (!headerText.includes(expectedOrdinalLine)) {
      errors.push({
        category: '副本头锚点描述不符',
        detail: `${spec.path} 的头部缺少「${expectedOrdinalLine}」`,
      });
    }
    if (!headerText.includes('抽取时刻：')) {
      errors.push({
        category: '副本头缺抽取时刻',
        detail: `${spec.path} 的头部缺「抽取时刻：」`,
      });
    }
    if (!headerText.includes(NON_AUTHORITATIVE_MARK)) {
      errors.push({
        category: '副本头缺非权威声明',
        detail: `${spec.path} 的头部缺「${NON_AUTHORITATIVE_MARK}」声明`,
      });
    }
    if (LINE_RANGE_PATTERN.test(headerText)) {
      errors.push({
        category: '副本头仍写死行号',
        detail: `${spec.path} 的头部仍写死行号 ⇒ 行号会随权威版的任何一次编辑失效 ⇒ 必须改成锚点`,
      });
    }

    if (body !== block) {
      errors.push({
        category: '副本正文不一致',
        detail: `${spec.path} 与权威版第 ${spec.ordinal} 个 mermaid 块不一致：${describeFirstDiff(body, block)}`,
      });
    }

    metrics.push(
      `  ${spec.path}：副本正文 ${body.split('\n').length} 行 · 权威块 ${block.split('\n').length} 行 · 逐字一致=${body === block}`,
    );
  }

  return { errors, warnings, metrics };
}

// ── 生成副本（`--write`）──

/** 「抽取时刻」那一行的标记（**用它把时间戳从「可比对的头部」里摘掉**）。 */
const TIMESTAMP_MARK = '抽取时刻：';

/** 生成副本的**头部注释行**（含「抽取时刻」那一行）。 */
function buildHeader(spec: CopySpec, timestamp: string): string[] {
  return [
    `%% T06 ${spec.kind === 'class' ? '字节计量装置 · 类图' : '字节计量 · 写路径计量轮时序'}（C′ 档 · ADR §8.5 的 H1′ 判据）`,
    '%%',
    `%% ⚠️ ★★ **本文件是【抽取副本】，不是权威版** ⇒ 权威版 = ② \`${SOURCE_PATH}\` 的「${SECTION_HEADING}」节内（architect 独家维护）`,
    '%% ⇒ ⇒ 若两者不一致 ⇒ **一律以 ② §12 为准**（本文件不得被当作口径来源引用）',
    '%% ⇒ ⇒ **不要在本文件里改内容** ⇒ 要改改 ② §12 ⇒ 然后重新抽取（否则副本会漂移）',
    `%% ${anchorSourceLine(SOURCE_PATH, SECTION_HEADING)}`,
    `%%        ${anchorOrdinalLine(spec.ordinal, spec.role)}`,
    `%% ${TIMESTAMP_MARK}${timestamp}`,
  ];
}

function buildCopyText(spec: CopySpec, block: string, timestamp: string): string {
  return `${buildHeader(spec, timestamp).join('\n')}\n${block}`;
}

/** 头部里**去掉「抽取时刻」**之后的部分（⇒ 这才是可逐字比对的部分）。 */
function headerKeyOf(header: readonly string[]): string {
  return header.filter((line) => !line.includes(TIMESTAMP_MARK)).join('\n');
}

interface WriteResult {
  readonly path: string;
  readonly state: 'written' | 'unchanged';
  readonly detail: string;
}

/**
 * 按锚点重抽两份副本（**幂等**）。
 *
 * ⚠️ ★ **正文与头部（除「抽取时刻」）都一致 ⇒ 一行都不改** ⇒ ⇒ 跑一次不会弄脏工作区
 *   （「工作区脏 ⇒ 有东西要查」这条信号不能被工具噪声稀释）。
 */
function writeCopies(
  sourcePath: string,
  copies: readonly CopySpec[],
): { results: WriteResult[]; error: string | null } {
  let markdown = '';
  try {
    markdown = readFileSync(sourcePath, 'utf8');
  } catch (error) {
    return { results: [], error: `读不到权威版：${String(error)}` };
  }

  let section = '';
  try {
    section = extractSection(markdown, SECTION_HEADING);
  } catch {
    return { results: [], error: `权威版里找不到节标题「${SECTION_HEADING}」` };
  }

  const { blocks, unclosed } = extractMermaidBlocks(section);
  if (unclosed) {
    return { results: [], error: '权威版围栏不闭合 ⇒ 不重抽' };
  }

  const stamp = timestampNow();
  const results: WriteResult[] = [];

  for (const spec of copies) {
    const block = blocks[spec.ordinal - 1];
    if (block === undefined) {
      return { results: [], error: `找不到第 ${spec.ordinal} 个 mermaid 块 ⇒ 不重抽` };
    }

    let existing: { header: string[]; body: string } | null = null;
    try {
      existing = splitCopy(readFileSync(spec.path, 'utf8').replace(/\n$/, ''));
    } catch {
      existing = null;
    }

    const expectedHeaderKey = headerKeyOf(buildHeader(spec, stamp));
    const bodySame = existing !== null && existing.body === block;
    const headerSame = existing !== null && headerKeyOf(existing.header) === expectedHeaderKey;

    if (bodySame && headerSame) {
      results.push({
        path: spec.path,
        state: 'unchanged',
        detail: '正文与头部（除「抽取时刻」）都逐字一致 ⇒ 一行都不改',
      });
      continue;
    }

    writeFileSync(spec.path, `${buildCopyText(spec, block, stamp)}\n`, 'utf8');
    results.push({
      path: spec.path,
      state: 'written',
      detail:
        existing === null
          ? '副本原先不存在 ⇒ 新建'
          : bodySame
            ? '正文一致但**头部过时** ⇒ 重写头部并刷新「抽取时刻」'
            : '正文有变 ⇒ 已写盘并刷新「抽取时刻」',
    });
  }

  return { results, error: null };
}

function timestampNow(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ── 自测（正控 + 负控）──

const SYNTHETIC_SOURCE = [
  '# 合成源（自测夹具 · 非真实文档）',
  '',
  '## 12. 类图与时序图',
  '',
  '> **归属**：**本节是这两张图的权威版**。',
  '',
  '```mermaid',
  'classDiagram',
  '    class Alpha {',
  '        +value number',
  '    }',
  '    Alpha --> Beta : 关系',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '    %% ⚠️ **本图只画【写路径 · 计量轮（轮 B）】**',
  '    autonumber',
  '    participant P as bench/perf.ts<br/>（写入扫描计量轮 · ⚠️ 只画轮 B）',
  '    P->>C: uninstall()',
  '```',
  '',
].join('\n');

interface FixtureFiles {
  readonly source: string;
  readonly classCopy: string;
  readonly seqCopy: string;
}

function buildFixture(sourceText: string): FixtureFiles {
  const section = extractSection(sourceText, SECTION_HEADING);
  const { blocks } = extractMermaidBlocks(section);
  const stamp = '2026-11-05 00:00（自测夹具）';
  return {
    source: sourceText,
    classCopy: buildCopyText(CLASS_COPY, blocks[0] ?? '', stamp),
    seqCopy: buildCopyText(SEQUENCE_COPY, blocks[1] ?? '', stamp),
  };
}

interface Control {
  readonly name: string;
  readonly expect: IssueCategory;
  readonly mutate: (base: FixtureFiles) => FixtureFiles;
}

/** 重建副本（源被改动后 ⇒ 副本必须跟着重建，否则差异噪声会盖掉结构问题）。 */
function rebuildCopies(files: FixtureFiles): FixtureFiles {
  try {
    return buildFixture(files.source);
  } catch {
    return files;
  }
}

const NEGATIVE_CONTROLS: readonly Control[] = [
  {
    name: '负控 A · 副本正文改一个字',
    expect: '副本正文不一致',
    mutate: (base) => ({
      ...base,
      classCopy: base.classCopy.replace('+value number', '+value numbe'),
    }),
  },
  {
    name: '负控 B · 副本正文挪一行',
    expect: '副本正文不一致',
    mutate: (base) => ({
      ...base,
      seqCopy: base.seqCopy
        .replace('    autonumber\n    participant P', '    participant P')
        .replace('    P->>C: uninstall()', '    autonumber\n    P->>C: uninstall()'),
    }),
  },
  {
    name: '负控 C · 副本正文删一行',
    expect: '副本正文不一致',
    // ⚠️ 必须连着**换行符**一起删：副本正文是「逐字拼接」的 ⇒ 最后一行后面**没有**换行符
    //   ⇒ 只删行文本会匹配不上 ⇒ 夹具没生效 ⇒ 负控会伪装成「守卫有牙」（其实没喂到坏数据）。
    mutate: (base) => ({
      ...base,
      classCopy: base.classCopy.replace('    }\n    Alpha --> Beta : 关系', '    }'),
    }),
  },
  {
    name: '负控 D · 权威块首行不是图类型指令',
    expect: '图类型指令不在首行',
    mutate: (base) =>
      rebuildCopies({ ...base, source: base.source.replace('classDiagram', '不是图类型') }),
  },
  {
    name: '负控 E · 权威块里有畸形 %% 行',
    expect: '%% 畸形行',
    mutate: (base) =>
      rebuildCopies({
        ...base,
        source: base.source.replace('    autonumber', '    %%坏注释\n    autonumber'),
      }),
  },
  {
    name: '负控 F · 权威版围栏不闭合',
    expect: '围栏不闭合',
    mutate: (base) => ({
      ...base,
      source: base.source.replace('    P->>C: uninstall()\n```\n', '    P->>C: uninstall()\n'),
    }),
  },
  {
    name: '负控 G · 副本头仍写死行号',
    expect: '副本头仍写死行号',
    // ⚠️ 必须插进**头部**（副本的第一行之后）⇒ 追加到文件末尾会落进正文里
    //   ⇒ 那样触发的是「正文不一致」，**不是**「头部仍写死行号」⇒ 夹具没进判定路径。
    mutate: (base) => ({
      ...base,
      classCopy: base.classCopy.replace('%%\n', '%%\n%% 抽取自 ② §12 的第 198–272 行\n'),
    }),
  },
  {
    name: '负控 H · 副本头的围栏序号写错',
    expect: '副本头锚点描述不符',
    mutate: (base) => ({
      ...base,
      classCopy: base.classCopy.replace(
        '第 1 个 ```mermaid 围栏块（类图）',
        '第 2 个 ```mermaid 围栏块（类图）',
      ),
    }),
  },
  {
    name: '负控 I · 副本头缺「抽取时刻」',
    expect: '副本头缺抽取时刻',
    mutate: (base) => ({
      ...base,
      classCopy: base.classCopy
        .split('\n')
        .filter((line) => !line.includes('抽取时刻：'))
        .join('\n'),
    }),
  },
  {
    name: '负控 J · 副本头缺「非权威」声明',
    expect: '副本头缺非权威声明',
    mutate: (base) => ({
      ...base,
      classCopy: base.classCopy.replace('不是权威版', '就是权威版'),
    }),
  },
];

function runSelfTest(): number {
  const dir = mkdtempSync(join(tmpdir(), 'mermaid-copies-'));
  const sourcePath = join(dir, '合成源.md');
  const classPath = join(dir, 'class-diagram.mermaid');
  const seqPath = join(dir, 'sequence-diagram.mermaid');
  const specs: readonly CopySpec[] = [
    { ...CLASS_COPY, path: classPath },
    { ...SEQUENCE_COPY, path: seqPath },
  ];

  const write = (files: FixtureFiles): void => {
    writeFileSync(sourcePath, `${files.source}\n`, 'utf8');
    writeFileSync(classPath, `${files.classCopy}\n`, 'utf8');
    writeFileSync(seqPath, `${files.seqCopy}\n`, 'utf8');
  };

  let failures = 0;
  try {
    const base = buildFixture(SYNTHETIC_SOURCE);

    // ── 正控 ──
    write(base);
    const positive = checkCopies({
      sourcePath,
      copies: specs,
    });
    if (positive.errors.length === 0) {
      process.stdout.write('✅ 正控：副本 == 权威版的锚点抽取 ⇒ 零错误\n');
    } else {
      failures += 1;
      process.stdout.write('✗ 正控失败（不该有错误）：\n');
      for (const issue of positive.errors) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }

    // ── 反向对照：权威版在**围栏块之外**多几行 ⇒ 仍应零错误（证明无假报警 + 位移免疫）──
    write({ ...base, source: `${'前插行\n'.repeat(5)}${base.source}` });
    const shifted = checkCopies({
      sourcePath,
      copies: specs,
    });
    if (shifted.errors.length === 0) {
      process.stdout.write(
        '✅ 反向对照：权威版在围栏块**之外**插 5 行 ⇒ 仍零错误（锚点免疫、无假报警）\n',
      );
    } else {
      failures += 1;
      process.stdout.write('✗ 反向对照失败（不该有错误）：\n');
      for (const issue of shifted.errors) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }

    // ── 写盘路径自测（正例 + 幂等）──
    //   ★ 这两条合起来才证明「--write 不会弄脏工作区」：
    //     ① 正例：正文真的变了 ⇒ 必须写盘、且**刷新「抽取时刻」**（证明写盘路径没被写死）；
    //     ② 幂等：紧接着再跑一次 ⇒ 必须**零改动**（内容逐字节不变 + mtime 不变）。
    {
      // ① 正例：先把副本正文改坏 ⇒ --write 必须写盘并刷新「抽取时刻」
      write({ ...base, classCopy: base.classCopy.replace('+value number', '+value numbe') });
      const stampBefore = readStampOf(classPath);
      const first = writeCopies(sourcePath, specs);
      const stampAfter = readStampOf(classPath);
      const firstState = first.results[0]?.state;
      if (firstState === 'written' && stampBefore !== stampAfter) {
        process.stdout.write(
          '✅ 写盘正例：副本正文有变 ⇒ --write **写盘**且**刷新了「抽取时刻」**（写盘路径没被写死）\n',
        );
      } else {
        failures += 1;
        process.stdout.write(
          `✗ 写盘正例失败（state=${firstState ?? '（无）'} · 时刻前=${stampBefore} 后=${stampAfter}）\n`,
        );
      }

      // ② 幂等：紧接着再跑一次 ⇒ 必须零改动
      const contentBefore = readFileSync(classPath, 'utf8');
      const mtimeBefore = statSync(classPath).mtimeMs;
      const second = writeCopies(sourcePath, specs);
      const contentAfter = readFileSync(classPath, 'utf8');
      const mtimeAfter = statSync(classPath).mtimeMs;
      const secondState = second.results[0]?.state;
      // ⚠️ `state` 才是**判定依据**（内容比较可能被「同一秒内写盘 ⇒ 时间戳相同」掩盖）
      if (
        secondState === 'unchanged' &&
        contentBefore === contentAfter &&
        mtimeBefore === mtimeAfter
      ) {
        process.stdout.write(
          '✅ 幂等：紧接着第二次 --write ⇒ **零改动**（内容逐字节不变 + mtime 不变）⇒ 不弄脏工作区\n',
        );
      } else {
        failures += 1;
        process.stdout.write(
          `✗ 幂等失败（state=${secondState ?? '（无）'} · 内容相同=${contentBefore === contentAfter} · mtime 相同=${mtimeBefore === mtimeAfter}）\n`,
        );
      }
    }

    // ── 负控：每个都必须报出**对应类别**（证明夹具真的进了判定路径）──
    for (const control of NEGATIVE_CONTROLS) {
      write(control.mutate(base));
      const report = checkCopies({
        sourcePath,
        copies: specs,
      });
      const hit = report.errors.find((issue) => issue.category === control.expect);
      if (hit !== undefined) {
        process.stdout.write(`✅ ${control.name} ⇒ 报出「${control.expect}」\n`);
      } else {
        failures += 1;
        process.stdout.write(
          `✗ ${control.name} ⇒ **没有**报出「${control.expect}」（实际报出：${
            report.errors.map((issue) => issue.category).join('、') || '（无）'
          }）\n`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stderr.write(`\n✗ 自测失败 ${failures} 项\n`);
    return 1;
  }
  process.stdout.write('\n✅ 自测全过 ⇒ 这条守卫**不是恒绿守卫**\n');
  return 0;
}

// ── CLI ──

function runCli(argv: readonly string[]): number {
  if (argv.includes('--self-test')) {
    return runSelfTest();
  }

  const srcIndex = argv.indexOf('--src');
  const srcPath = srcIndex >= 0 ? (argv[srcIndex + 1] ?? '') : '';
  const classIndex = argv.indexOf('--class');
  const classPath = classIndex >= 0 ? (argv[classIndex + 1] ?? '') : '';
  const seqIndex = argv.indexOf('--seq');
  const seqPath = seqIndex >= 0 ? (argv[seqIndex + 1] ?? '') : '';

  const sourcePath = srcPath === '' ? resolve(SOURCE_PATH) : resolve(srcPath);
  const copies: readonly CopySpec[] = [
    { ...CLASS_COPY, path: classPath === '' ? resolve(CLASS_COPY.path) : resolve(classPath) },
    { ...SEQUENCE_COPY, path: seqPath === '' ? resolve(SEQUENCE_COPY.path) : resolve(seqPath) },
  ];

  if (argv.includes('--write')) {
    const outcome = writeCopies(sourcePath, copies);
    if (outcome.error !== null) {
      process.stderr.write(`✗ ${outcome.error}\n`);
      return 1;
    }
    for (const result of outcome.results) {
      const verb = result.state === 'written' ? '已按锚点重抽' : '未改动（幂等）';
      process.stdout.write(`  ${verb}：${result.path}（${result.detail}）\n`);
    }
  }

  const report = checkCopies({ sourcePath, copies });

  process.stdout.write('mermaid 抽取副本的锚点校验（副本 == 权威版？）\n');
  process.stdout.write(`  权威版：${sourcePath} 的「${SECTION_HEADING}」节内\n`);
  for (const metric of report.metrics) {
    process.stdout.write(`${metric}\n`);
  }
  for (const issue of report.warnings) {
    process.stdout.write(`  ⚠️  [警告] ${issue.category}：${issue.detail}\n`);
  }

  if (report.errors.length > 0) {
    process.stderr.write(`\n✗ 发现 ${report.errors.length} 处不一致：\n`);
    for (const issue of report.errors) {
      process.stderr.write(`    ${issue.category}：${issue.detail}\n`);
    }
    return 1;
  }

  process.stdout.write('\n✓ 两份副本都是权威版的逐字抽取（锚点一致 · 结构体检通过）\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
