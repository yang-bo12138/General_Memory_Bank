#!/usr/bin/env tsx
/**
 * 落盘 `note` 的【逐字保真】校验 —— 把「文档里的 `note` == 实现里真正落盘的那一串」变成机器可复算的东西。
 *
 * ## 背景（为什么有这条脚本）
 *
 * 落盘 JSON 的 `note` 字段是**给读 JSON 的人看的口径说明** ⇒ 它必须与实现里**真正落盘的那一串**逐字相同。
 * 本项目已经栽过一次（实测过、不是推演）：
 *   · `bench/perf.ts` 的 `note` 字符串被加了内容 ⇒ 而
 *     `docs/design/perf-c2-t06-byte-metering-impl-notes.md` §13 里那份**逐字副本**没跟上
 *     ⇒ ⇒ 两边说法不一致 ⇒ ⇒ 拿到 JSON 的人按文档理解、而机器按实现理解 ⇒ ⇒ **且这一路是【静默】的**。
 * ⇒ ⇒ 本脚本的作用是**把「两份各自演化」这条路物理封死**：
 *   `impl-notes` §13 的两段 `note` **只能是** `bench/perf.ts` 的**逐字字节复制**
 *   ⇒ 唯一的维护动作 = 「改实现 → **同批**改副本」。
 *
 * ⚠️ ★★ **emoji 陷阱（谁改 `note` 字符串，必读这一条）**：
 *   本仓库的 `⚠` 必须是 **U+26A0 + U+FE0F**（带变体选择符 VS16）⇒ ⇒ 而本脚本
 *   **只归一化空白 / 引号 / 反斜杠 / `+`**（**不归一化 emoji**）⇒ ⇒ ⇒
 *   **一个 emoji 的字节不一致 ⇒ 脚本就红**（⇒ 而这种红**很容易被误当成「文档写错了」**）。
 *   ⇒ ⇒ 所以：**改 `note` 字符串时，必须照抄 U+26A0+U+FE0F 这一串**（`⚠️`），
 *   **不要**用纯 `⚠`（U+26A0 无 VS16）⇒ ⇒ 本脚本会把这种「只差 VS16」的漂移**单独报成一类**
 *   （`emoji 漂移（仅 VS16 差异）`）⇒ ⇒ 它与真正的「文案漂移」**不是同一类病**。
 *
 * ## ⚠️ 路径解析必须相对【脚本自身】（不是相对「当前工作目录」）
 *
 * ⚠️ ★ **旧版脚本（`.tmp/bench/check-json-note-fidelity.ts`）的路径是相对【仓库根】的**
 *   （`readFileSync('docs/design/…')` / `readFileSync('bench/lib/../perf.ts')`）⇒ ⇒ **从任何别的目录跑都会找不到文件**
 *   ⇒ ⇒ 而且它在 `.tmp/` 里（**gitignored**）⇒ ⇒ **仓库里没有它** ⇒ ⇒ **提交态这道守卫是断的**
 *   ⇒ ⇒ 本脚本用 `new URL('../…', import.meta.url)` **相对脚本自身**定位 ⇒ ⇒
 *   ⇒ ⇒ **从哪个目录跑都能跑**（⇒ 「路径不再悬空」这件事**可被验证**，不是口号）。
 *
 * ## ⚠️ 这条脚本自己**绝不能是恒绿守卫**
 *
 * 本项目刚治好一类「恒绿守卫」⇒ 所以本脚本**自带正控 + 负控**（`--self-test`）：
 *   · **正控**：当前状态 ⇒ 两段 `note` 都逐字命中 ⇒ 通过；
 *   · **反向对照**：在 `note` 块**之外**插几行 ⇒ 仍应零错误（证明**无假报警**）；
 *   · **负控**：喂**改坏的副本** ⇒ 必须**报出对应类别**（不是只报「失败」）。
 * ⇒ ⇒ 负控夹具**必须真的进得了判定路径** ⇒ 本实现对每个负控**断言具体失败类别**，
 *   而不只是断言「exit 1」⇒ 否则「夹具没进判定路径」会伪装成「守卫有牙」。
 * ⇒ ⇒ ★ **本轮真实栽过一次**：负控 B 一开始写成「删掉 note 块的**开头**一段」⇒ ⇒
 *   本检查是**子串**语义 ⇒ ⇒ 剩下的仍是实现侧那段文本的**后缀** ⇒ ⇒ **照样命中**
 *   ⇒ ⇒ 夹具**等于没生效** ⇒ ⇒ 自测当场报「负控 B 没有报出任何类别」。
 * ⇒ ⇒ ⇒ ★ **由此定下的纪律（可复用）**：
 *   **负控的 `mutate` 必须真的让【判定不再通过】**（⇒ 判据是「判定结果」，**不是**「内容变了」）
 *   ⇒ ⇒ 否则这条负控自己就是恒绿的 ⇒ ⇒ **当场报错**，不等别人发现。
 *   ⇒ ⇒ 本实现把这条断言**写进了自测循环**（见 `runSelfTest()` 里的「根因断言」）。
 *
 * ## ★ 判据（2026-11-05 升级）：**逐字节相等**（★ 不再是「归一化后相等」）
 *
 * ⚠️ ★★ **升级前的判据是【子串 + 归一化】** ⇒ ⇒ 打印的那句「真零差异」**是说过头的**
 *   （工程师 2026-11-05 实测：HEAD 基线里就藏着 1 处**空白差异** ⇒ ⇒ 而旧判据照样报 true）。
 * ⇒ ⇒ **现在改成【等长比较】**：把实现侧那段 `note` 当作**一个整体**抽出来
 *   （`buildVectorByteReads(...)` 的**第三个参数** ⇒ ⇒ 它是若干单引号字面量的 `+` 拼接）
 *   ⇒ ⇒ 与文档侧那段**解转义后逐字节相等**比较 ⇒ ⇒ **长度必须也相等**。
 * ⇒ ⇒ ★ **这样「真零差异」这句话从此是真的** ✅
 * ⇒ ⇒ ★ **并且顺带堵上了旧判据抓不到的那一类漂移**：**前缀 / 后缀截断**
 *   （旧判据是**子串**语义 ⇒ 截掉开头 / 结尾 ⇒ 剩下的仍是子串 ⇒ **照样命中 ⇒ 检测不出**）
 *   ⇒ ⇒ 现在**逐字节相等** ⇒ ⇒ **截断一律判红** ⇒ ⇒ 已加**负控 F** 专门钉这一条。
 * ⇒ ⇒ ★ **归一化比较保留为【辅助诊断】**（**不参与判绿**）：
 *   归一化后相等但逐字节不等 ⇒ ⇒ 报「**仅空白/格式差异**」⇒ ⇒ 这比「直接说不一致」有信息量。
 *
 * ## ⚠️ 已知限制（**说清楚，别假装没有**）
 *
 * ⚠️ ★ **实现侧那段 `note` 的抽取靠【源码结构】**（`buildVectorByteReads(` 的调用点 ⇒ 第三个参数）
 *   ⇒ ⇒ **若实现侧改成别的写法**（改成模板串 / 把 note 挪到别处 / 换成变量）⇒ ⇒ 抽取会失败
 *   ⇒ ⇒ ⇒ **判红**（「实现侧 note 段数不足」）⇒ ⇒ **不会静默放过**
 *   ⇒ ⇒ ⇒ 但那是**误报**（不是真的漂移）⇒ ⇒ ⇒ 那时该改的是**本脚本的抽取器**，**不是放松判据**。
 * ⚠️ ★ **本检查比的是【字符串内容】，不是【语义】** ⇒ ⇒ 「换一种说法但意思一样」**判红**
 *   ⇒ ⇒ 这是**故意的**（本项目要的正是「逐字相同」）⇒ ⇒ 措辞改动必须**同批**改副本。
 * ⚠️ ★ **两侧的转义规则不同**（文档侧是 **JSON** 转义、实现侧是 **JS** 转义）⇒ ⇒
 *   ⇒ ⇒ 两边**各自解转义后**再比 ⇒ ⇒ ⇒ 若将来 note 里出现 JSON 有而 JS 没有的转义
 *   ⇒ ⇒ ⇒ （例如 `\/`）⇒ ⇒ ⇒ **解出来可能不同** ⇒ ⇒ ⇒ 那时要同步调整两边的解转义函数。
 *
 * ⇒ ⇒ ★ **负控一律用【临时副本】做**（拷到临时目录 ⇒ 改 ⇒ 跑 ⇒ 删）⇒ ⇒ **绝不许改仓库里的真实文件**。
 *
 * ## 用法
 *   tsx scripts/check-json-note-fidelity.ts               # 校验（默认）
 *   tsx scripts/check-json-note-fidelity.ts --self-test   # 自带正控 + 负控（证明这条守卫有牙）
 *   tsx scripts/check-json-note-fidelity.ts --notes <路径> --perf <路径>   # 指定两侧文件（自测/排障用）
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 路径（★ 相对【脚本自身】· 与当前工作目录无关） ── */

/** 仓库根（`scripts/` 的上一级）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 文档侧：落盘 JSON 的**逐字副本**所在处（§13 的两段 `note`）。 */
const NOTES_DOC_REL = 'docs/design/perf-c2-t06-byte-metering-impl-notes.md';

/** 实现侧：真正把 `note` 落盘的那一串。 */
const PERF_REL = 'bench/perf.ts';

/**
 * 预期的 `note` 块数（写路径 + 读路径各一段）。
 *
 * ⚠️ ★ **为什么必须钉住这个数**：块数变少 ⇒ **覆盖面缩小**（少一段就没被守）⇒ ⇒
 *   而「少一段」本身**不会**让任何一条逐字比对失败 ⇒ ⇒ 必须**单独**判红。
 */
const EXPECTED_NOTE_BLOCKS = 2;

/* ── 归一化 ── */

/** 变体选择符 VS16（`⚠` + VS16 = `⚠️`）。 */
const VS16 = '\u{FE0F}';

/**
 * 归一化（**只去空白**）—— 用于「仅空白/格式差异」这条**辅助诊断**（**不参与判绿**）。
 *
 * ⚠️ ★ 与旧版不同：旧版的 `norm` 还去掉了引号 / 反斜杠 / `+`
 *   （旧判据是**子串**语义 ⇒ 必须去掉拼接符 `+` 才能在**源文本**里找）
 *   ⇒ ⇒ **现在两侧都是【整体字符串】** ⇒ ⇒ `+` 是**真实内容**
 *   （note 里就有「`bytesRead = codeBytes + embeddingBytes`」这句话）⇒ ⇒ **不许去**
 *   ⇒ ⇒ 只去空白 ⇒ ⇒ 这样「仅空白差异」这一类判定才是**准的**。
 */
const normWhitespace = (text: string): string => text.replace(/\s+/gu, '');

/** 去掉全部 VS16（**只用于诊断**：判定「差异是否仅由 VS16 造成」）。 */
const stripVs16 = (text: string): string => text.replace(/\u{FE0F}/gu, '');

/** JSON 字符串体解转义（`\"` → `"`、`\\` → `\`、`\n` → 换行 …）。 */
const unescapeJson = (raw: string): string =>
  raw.replace(/\\(u[0-9a-fA-F]{4}|.)/gu, (_whole, seq: string) => {
    if (seq.startsWith('u')) {
      return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
    }
    switch (seq) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return seq;
    }
  });

/** `"note": "…"` 的 JSON 字符串体（跳过引号与转义引号）。 */
const NOTE_BLOCK_PATTERN = /"note":\s*"((?:[^"\\]|\\.)*)"/gu;

/* ── 实现侧抽取（★ 把那段 note 当作【一个整体】抽出来 ⇒ 才能逐字节比较） ── */

/**
 * 实现侧那段 `note` 的落点：**`buildVectorByteReads(...)` 的第三个参数**。
 *
 * ⚠️ ★ **为什么锚在这里而不是锚在 note 的内容上**：锚内容（`"① ★ **口径**…"）会随文案漂移
 *   ⇒ ⇒ 锚**结构**（函数调用 + 参数位置）才稳 ⇒ ⇒ 而结构变了 ⇒ ⇒ 抽取失败 ⇒ ⇒ **判红**
 *   ⇒ ⇒ ⇒ **不会静默放过**（见文件头「已知限制」）。
 */
const IMPL_NOTE_CALL = 'buildVectorByteReads(';

/** 单引号 TS 字面量（实现侧的 note 就是一串这种字面量用 `+` 拼起来的）。 */
const TS_LITERAL_RE = /'((?:[^'\\]|\\.)*)'/gu;

/**
 * 跳过字符串字面量（单引号 / 双引号 / 模板串），返回其后的第一个位置。
 *
 * ⚠️ 模板串要处理 `${…}` 插值（插值里可能再套字符串 / 括号）⇒ ⇒ 递归跳过。
 */
function skipStringLiteral(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quote === '`' && char === '$' && text[index + 1] === '{') {
      let depth = 1;
      index += 2;
      while (index < text.length && depth > 0) {
        const inner = text[index];
        if (inner === "'" || inner === '"' || inner === '`') {
          index = skipStringLiteral(text, index);
          continue;
        }
        if (inner === '{') {
          depth += 1;
        } else if (inner === '}') {
          depth -= 1;
        }
        index += 1;
      }
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/**
 * 抽出 `callOpen`（**`(` 的位置**）那个调用里**第三个参数**的源码文本。
 *
 * @returns 参数源码；抽不出 ⇒ `undefined`
 */
function extractThirdArgument(text: string, callOpen: number): string | undefined {
  let depth = 0;
  let commas = 0;
  let argStart = -1;
  let index = callOpen;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      index = skipStringLiteral(text, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        return argStart === -1 ? undefined : text.slice(argStart, index);
      }
      index += 1;
      continue;
    }
    if (char === ',' && depth === 1) {
      commas += 1;
      if (commas === 2) {
        argStart = index + 1;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return undefined;
}

/**
 * 抽出实现侧的全部 `note`（★ **顺序 = 源码里的调用顺序** ⇒ 与文档侧 §13 的顺序一一对应）。
 *
 * ⚠️ ★ **函数定义那一处要跳过**（`function buildVectorByteReads(` ⇒ 它的第三个参数不是 note）。
 */
function extractImplNotes(text: string): string[] {
  const notes: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf(IMPL_NOTE_CALL, cursor);
    if (at === -1) {
      break;
    }
    cursor = at + IMPL_NOTE_CALL.length;
    if (
      text
        .slice(Math.max(0, at - 16), at)
        .trimEnd()
        .endsWith('function')
    ) {
      continue;
    }
    const argument = extractThirdArgument(text, cursor - 1);
    if (argument === undefined) {
      continue;
    }
    let joined = '';
    for (const match of argument.matchAll(TS_LITERAL_RE)) {
      joined += unescapeJson(match[1] ?? '');
    }
    notes.push(joined);
  }
  return notes;
}

/* ── 报告 ── */

/** 一处不一致的**类别**（负控要断言的正是它 ⇒ ⇒ 类别名必须稳定）。 */
type IssueCategory =
  | 'note 块数量为零'
  | 'note 块数量减少'
  | '实现侧 note 段数不足'
  | 'note 块未命中（逐字不一致）'
  | '仅空白/格式差异（归一化后相等）'
  | 'emoji 漂移（仅 VS16 差异）';

/** 一处不一致。 */
interface Issue {
  readonly category: IssueCategory;
  readonly detail: string;
}

/** 一段 `note`。 */
interface NoteBlock {
  /** JSON 字符串体（未解转义）。 */
  readonly raw: string;
  /** ★ **解转义后的整体文本**（★ 逐字节比较的对象 ⇒ **不是**归一化后的探针）。 */
  readonly text: string;
}

/** 一次核查的结论。 */
interface Report {
  /** 文档侧抽到的 `note` 块数。 */
  readonly blocks: number;
  /** 逐字命中的块数。 */
  readonly hits: number;
  /** 错误清单（空 = 通过）。 */
  readonly errors: readonly Issue[];
  /** 逐块的过程行。 */
  readonly metrics: readonly string[];
}

/* ── 抽取 ── */

/** 从文本里抽出全部 `"note": "…"` 块。 */
function extractNoteBlocks(text: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  for (const match of text.matchAll(NOTE_BLOCK_PATTERN)) {
    const raw = match[1] ?? '';
    blocks.push({ raw, text: unescapeJson(raw) });
  }
  return blocks;
}

/**
 * 定位第 `index` 个 `note` 块在**原始文本**里的字符区间（负控要靠它做精确改写）。
 *
 * @param text 原始文本
 * @param index 块序号（从 0 起）
 * @returns 区间（`start` = 字符串体起点，`end` = 字符串体终点·不含）；找不到 ⇒ `undefined`
 */
function locateNoteBlock(
  text: string,
  index: number,
): { readonly start: number; readonly end: number } | undefined {
  let seen = 0;
  for (const match of text.matchAll(NOTE_BLOCK_PATTERN)) {
    const raw = match[1] ?? '';
    const offset = match.index + match[0].indexOf(raw);
    if (seen === index) {
      return { start: offset, end: offset + raw.length };
    }
    seen += 1;
  }
  return undefined;
}

/** 删掉**包含**给定偏移量的那一整行（含其换行符）。 */
function deleteLineContaining(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset) + 1;
  const lineEnd = text.indexOf('\n', offset);
  return text.slice(0, lineStart) + text.slice(lineEnd === -1 ? text.length : lineEnd + 1);
}

/* ── 核查 ── */

/**
 * 核查：文档侧的两段 `note` 是否与实现侧**逐字节相等**。
 *
 * ⚠️ ★ **判据 = 逐字节相等**（两侧都是【整体字符串】⇒ ⇒ 长度也必须相等）
 *   ⇒ ⇒ 归一化比较**不参与判绿**，只作为**辅助诊断**（见「仅空白/格式差异」这一类）。
 *
 * @param options 两侧文件路径
 * @returns 报告
 */
function checkNoteFidelity(options: {
  readonly notesPath: string;
  readonly perfPath: string;
}): Report {
  const notesText = readFileSync(options.notesPath, 'utf8');
  const perfText = readFileSync(options.perfPath, 'utf8');
  const blocks = extractNoteBlocks(notesText);
  const implNotes = extractImplNotes(perfText);
  const errors: Issue[] = [];
  const metrics: string[] = [];

  if (blocks.length === 0) {
    errors.push({
      category: 'note 块数量为零',
      detail:
        `「${options.notesPath}」里一个「"note": "…"」块都没有 ⇒ ⇒ 逐字比对**无事可做** ⇒ ` +
        '**必然是恒绿守卫** ⇒ 判红',
    });
  }
  if (blocks.length < EXPECTED_NOTE_BLOCKS) {
    errors.push({
      category: 'note 块数量减少',
      detail:
        `只抽到 ${blocks.length} 段 note（预期 ${EXPECTED_NOTE_BLOCKS} 段：写路径 + 读路径）⇒ ⇒ ` +
        '**少的那段不再被守** ⇒ ⇒ 而「少一段」本身不会让任何一条逐字比对失败 ⇒ ⇒ 必须单独判红',
    });
  }
  if (implNotes.length < EXPECTED_NOTE_BLOCKS) {
    errors.push({
      category: '实现侧 note 段数不足',
      detail:
        `从「${options.perfPath}」里只抽到 ${implNotes.length} 段实现侧 note` +
        `（预期 ${EXPECTED_NOTE_BLOCKS} 段）⇒ ⇒ 逐字节比较**无从做起** ⇒ ⇒ **判红**` +
        '（⚠️ 若实现侧其实没漂移、只是**写法变了**（挪了位置 / 改成模板串）⇒ ⇒ ' +
        '⇒ ⇒ 那要改的是**本脚本的抽取器**，**不是放松判据**）',
    });
  }

  let hits = 0;
  blocks.forEach((block, index) => {
    const impl = implNotes[index];
    if (impl === undefined) {
      metrics.push(`  note[${index}]：实现侧【没有】对应的第 ${index + 1} 段 note ⇒ ⇒ 无从比较`);
      return;
    }
    // ★ 判据：逐字节相等（**长度也要相等**）。
    if (block.text === impl) {
      hits += 1;
      metrics.push(
        `  note[${index}]（${block.text.length} 字）逐字节相等：true（实现侧 ${impl.length} 字）`,
      );
      return;
    }
    // ⚠️ 诊断 1：仅 VS16 差异（emoji 漂移）。
    if (stripVs16(block.text) === stripVs16(impl)) {
      errors.push({
        category: 'emoji 漂移（仅 VS16 差异）',
        detail:
          `note[${index}]：去掉 VS16（U+FE0F）后**就相等了** ⇒ ⇒ 差异**仅由变体选择符造成** ⇒ ⇒ ` +
          '⇒ 改 note 字符串时**必须照抄「⚠️」（U+26A0 + U+FE0F）**，不要用纯「⚠」',
      });
      metrics.push(
        `  note[${index}]（${block.text.length} 字）逐字节相等：false（仅 VS16 差异 · 实现侧 ${impl.length} 字）`,
      );
      return;
    }
    // ⚠️ 诊断 2：仅空白/格式差异（**归一化后相等** ⇒ ⇒ 说明漂移「小」但仍然是漂移）。
    if (normWhitespace(block.text) === normWhitespace(impl)) {
      errors.push({
        category: '仅空白/格式差异（归一化后相等）',
        detail:
          `note[${index}]：归一化（去空白）后**相等**，但**逐字节不等** ⇒ ⇒ 差异**只在空白 / 格式**上 ⇒ ⇒ ` +
          '⇒ 这仍是漂移（判据 = 逐字节相等）⇒ ⇒ ⇒ 去空白后才相等 = **文案本身没变、排版变了** ⇒ ⇒ ' +
          '⇒ ⇒ **这正是旧判据抓不到的那一类**（旧判据归一化后相等 ⇒ 报 true ⇒ 掩盖了它）',
      });
      metrics.push(
        `  note[${index}]（${block.text.length} 字）逐字节相等：false（仅空白/格式差异 · 实现侧 ${impl.length} 字）`,
      );
      return;
    }
    // ⚠️ 其余：真漂移（文案变了）。报告**最长公共前缀**长度（定位漂移点）。
    let common = 0;
    while (
      common < block.text.length &&
      common < impl.length &&
      block.text[common] === impl[common]
    ) {
      common += 1;
    }
    const at = Math.max(0, common - 10);
    errors.push({
      category: 'note 块未命中（逐字不一致）',
      detail:
        `note[${index}]（文档侧 ${block.text.length} 字 / 实现侧 ${impl.length} 字）：` +
        `最长公共前缀 ${common} 字 ⇒ ⇒ 漂移点附近 —— ` +
        `实现侧：…${impl.slice(at, at + 60)}… / 文档侧：…${block.text.slice(at, at + 60)}…`,
    });
    metrics.push(
      `  note[${index}]（${block.text.length} 字）逐字节相等：false（实现侧 ${impl.length} 字）`,
    );
  });

  metrics.unshift(`JSON note 块数量：${blocks.length}`);
  metrics.unshift(`实现侧 note 段数（${IMPL_NOTE_CALL} 的第三个参数）：${implNotes.length}`);
  return { blocks: blocks.length, hits, errors, metrics };
}

/* ── 自测（正控 + 反向对照 + 负控） ── */

/** 一个负控：名字、期望的失败类别、改坏副本的方法。 */
interface Control {
  readonly name: string;
  readonly expect: IssueCategory;
  readonly mutate: (notes: string) => string;
}

/**
 * 负控清单。
 *
 * ⚠️ ★ **每个夹具都必须真的改到 `note` 块里面** ⇒ ⇒ 否则夹具没进判定路径
 *   ⇒ ⇒ 负控会**伪装成「守卫有牙」**（其实没喂到坏数据）。
 */
const NEGATIVE_CONTROLS: readonly Control[] = [
  {
    name: '负控 A · note 块里改一个字',
    expect: 'note 块未命中（逐字不一致）',
    mutate: (notes) => {
      const range = locateNoteBlock(notes, 0);
      if (range === undefined) {
        return notes;
      }
      // ⚠️ 改一个**中文实义字**（不是 emoji、不是空白）⇒ ⇒ 必然造成文案漂移。
      return `${notes.slice(0, range.start)}◆${notes.slice(range.start + 1)}`;
    },
  },
  {
    name: '负控 B · note 块里删一段【中间的】实义文本',
    expect: 'note 块未命中（逐字不一致）',
    mutate: (notes) => {
      const range = locateNoteBlock(notes, 1);
      if (range === undefined) {
        return notes;
      }
      const body = notes.slice(range.start, range.end);
      const run = findPlainRun(body, PLAIN_RUN_LENGTH);
      if (run === undefined) {
        return notes;
      }
      // ⚠️ ★★★ **删【中间】的一段**（⇒ 剩下「前缀 + 后缀」⇒ ⇒ **不再是连续子串** ⇒ ⇒ 抓得住）：
      //   ⚠️ ★ **旧判据是【子串】语义** ⇒ ⇒ 删掉**开头** ⇒ 剩下的仍是实现侧那段文本的**后缀**
      //   ⇒ ⇒ **照样命中** ⇒ ⇒ **旧判据抓不到「前缀截断」** ⇒ ⇒ 本轮已升级成【逐字节相等】
      //   ⇒ ⇒ ⇒ **现在改开头也会被抓**（见负控 F）⇒ ⇒ 负控 B 只负责「实义文本漂移」这一类。
      return notes.slice(0, range.start + run.start) + notes.slice(range.start + run.end);
    },
  },
  {
    name: '负控 F · note 块里删掉【开头】一段（★ 旧子串判据抓不到的那一类）',
    expect: 'note 块未命中（逐字不一致）',
    mutate: (notes) => {
      const range = locateNoteBlock(notes, 0);
      if (range === undefined) {
        return notes;
      }
      const body = notes.slice(range.start, range.end);
      // ⚠️ ★ 删**开头** ⇒ ⇒ 剩下的仍是实现侧那段文本的**后缀**
      //   ⇒ ⇒ **旧判据（子串语义）会照样命中 ⇒ 抓不到** ⇒ ⇒ ★ 这条负控就是用来证明
      //   ⇒ ⇒ **新判据（逐字节相等）把这一类堵上了**。
      // ⚠️ 删的这段必须**不含引号 / 反斜杠** ⇒ ⇒ 否则 JSON 串体被破坏 ⇒ ⇒ 块数会变 ⇒ ⇒
      //   ⇒ ⇒ 报出来的类别就不是「逐字不一致」了（那是另一个病）。
      let cut = body.length;
      for (let index = 0; index < Math.min(body.length, 200); index += 1) {
        const char = body[index];
        if (char === '"' || char === '\\') {
          cut = index;
          break;
        }
      }
      if (cut < 5) {
        return notes;
      }
      return notes.slice(0, range.start) + notes.slice(range.start + cut);
    },
  },
  {
    name: '负控 C · note 块里删掉一个 VS16（emoji 漂移）',
    expect: 'emoji 漂移（仅 VS16 差异）',
    mutate: (notes) => {
      const range = locateNoteBlock(notes, 0);
      if (range === undefined) {
        return notes;
      }
      const body = notes.slice(range.start, range.end);
      const at = body.indexOf(VS16);
      if (at === -1) {
        return notes;
      }
      return (
        notes.slice(0, range.start) +
        body.slice(0, at) +
        body.slice(at + VS16.length) +
        notes.slice(range.end)
      );
    },
  },
  {
    name: '负控 D · 整段 note 所在的那一行被删掉（块数减少）',
    expect: 'note 块数量减少',
    mutate: (notes) => {
      const range = locateNoteBlock(notes, 1);
      if (range === undefined) {
        return notes;
      }
      return deleteLineContaining(notes, range.start);
    },
  },
  {
    name: '负控 E · 文档侧一个 note 块都不剩（块数为零 ⇒ 本该恒绿）',
    expect: 'note 块数量为零',
    mutate: (notes) => {
      // ⚠️ 把两段 note 块**整段删掉** ⇒ ⇒ 块数为零 ⇒ ⇒ 若不判红，这条守卫就是**恒绿**。
      let out = notes;
      for (const index of [1, 0]) {
        const range = locateNoteBlock(out, index);
        if (range === undefined) {
          continue;
        }
        out = deleteLineContaining(out, range.start);
      }
      return out;
    },
  },
];

/** 负控 B 要删的那段实义文本的长度（够长 ⇒ 不会在别处偶然命中）。 */
const PLAIN_RUN_LENGTH = 24;

/**
 * 一个字符是不是「普通实义字符」。
 *
 * ⚠️ 排除：反斜杠（JSON 转义）、双引号、空白（**归一化会吃掉空白** ⇒ 删它等于没删）、
 *   代理对（U+D800–DFFF ⇒ 切半个字符）、U+FE00 及以上（变体选择符 / emoji 段 ⇒ 别切坏 emoji）。
 */
function isPlainChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (char === '\\' || char === '"' || /\s/u.test(char)) {
    return false;
  }
  if (code >= 0xd800 && code <= 0xdfff) {
    return false;
  }
  if (code >= 0xfe00) {
    return false;
  }
  return true;
}

/**
 * 在内容区里找一段**中间的**普通实义文本（不含转义符 ⇒ 不落在转义序列里）。
 *
 * ⚠️ ★ **为什么要从「四分之一处」开始找**：必须落在**中间** ⇒ ⇒ 删掉它之后剩下的
 *   「前缀 + 后缀」**不再是连续子串** ⇒ ⇒ 子串语义下也**抓得住**（删开头则抓不住）。
 *
 * @param body 内容区（JSON 字符串体）
 * @param length 目标长度
 * @returns 区间；找不到 ⇒ `undefined`
 */
function findPlainRun(
  body: string,
  length: number,
): { readonly start: number; readonly end: number } | undefined {
  const from = Math.floor(body.length / 4);
  for (let index = from; index + length <= body.length; index += 1) {
    let plain = true;
    for (let offset = 0; offset < length; offset += 1) {
      const char = body[index + offset] ?? '';
      if (!isPlainChar(char)) {
        plain = false;
        break;
      }
    }
    if (plain) {
      return { start: index, end: index + length };
    }
  }
  return undefined;
}

/** 自测：正控 + 反向对照 + 逐条负控（**只用临时副本** ⇒ 绝不动仓库里的真实文件）。 */
function runSelfTest(): number {
  const dir = mkdtempSync(join(tmpdir(), 'json-note-fidelity-'));
  const notesPath = join(dir, 'impl-notes.md');
  const perfPath = join(dir, 'perf.ts');
  let failures = 0;

  try {
    const baseNotes = readFileSync(join(REPO_ROOT, NOTES_DOC_REL), 'utf8');
    const basePerf = readFileSync(join(REPO_ROOT, PERF_REL), 'utf8');
    const write = (notes: string, perf: string): void => {
      writeFileSync(notesPath, notes, 'utf8');
      writeFileSync(perfPath, perf, 'utf8');
    };

    // ── 正控 ──
    write(baseNotes, basePerf);
    const positive = checkNoteFidelity({ notesPath, perfPath });
    if (positive.errors.length === 0) {
      process.stdout.write('✅ 正控：两段 note 都与实现侧逐字一致 ⇒ 零错误\n');
    } else {
      failures += 1;
      process.stdout.write('✗ 正控失败（不该有错误）：\n');
      for (const issue of positive.errors) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }

    // ── 反向对照：在 note 块**之外**插几行 ⇒ 仍应零错误（证明无假报警）──
    write(`前置说明行\n${baseNotes}`, basePerf);
    const shifted = checkNoteFidelity({ notesPath, perfPath });
    if (shifted.errors.length === 0) {
      process.stdout.write('✅ 反向对照：在 note 块**之外**插一行 ⇒ 仍零错误（无假报警）\n');
    } else {
      failures += 1;
      process.stdout.write('✗ 反向对照失败（不该有错误）：\n');
      for (const issue of shifted.errors) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }

    // ── 负控：每个都必须报出**对应类别**（证明夹具真的进了判定路径）──
    for (const control of NEGATIVE_CONTROLS) {
      const mutated = control.mutate(baseNotes);
      if (mutated === baseNotes) {
        failures += 1;
        process.stdout.write(`✗ ${control.name} ⇒ **夹具没生效**（文档没被改坏）⇒ 夹具无效\n`);
        continue;
      }
      write(mutated, basePerf);
      const report = checkNoteFidelity({ notesPath, perfPath });

      // ★★★★ **根因断言（这条才是根治「夹具没进判定路径」的）**：
      //   判据不是「mutate 前后内容变了」⇒ ⇒ **太弱**（删掉一段**开头**也算「变了」，
      //   可它**照样命中** ⇒ ⇒ 夹具照样是恒绿的 ⇒ ⇒ 本轮真实栽过一次）。
      //   ⇒ ⇒ 判据必须是：**mutate 之后，判定必须【不再通过】** ⇒ ⇒
      //   ⇒ ⇒ 否则这条负控自己就是恒绿的 ⇒ ⇒ **当场报错**，而不是等别人发现。
      if (report.errors.length === 0) {
        failures += 1;
        process.stdout.write(
          `✗ ${control.name} ⇒ **判定仍然通过（零错误）** ⇒ ⇒ 这条负控自己就是恒绿的 ⇒ ` +
            '⇒ **夹具没进判定路径**（★ 已由这条根因断言当场抓住）\n',
        );
        continue;
      }

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

    // ── ★ 自测 · 【新判据的能力证明：前缀截断现在会被抓】 ──
    //   ★ **旧判据（子串语义）抓不到这一类**：删掉 note 块的**开头** ⇒ ⇒ 剩下的仍是实现侧
    //   ⇒ ⇒ 那段文本的**后缀** ⇒ ⇒ 子串 ⇒ ⇒ **照样命中 ⇒ 判定零错误**。
    //   ⇒ ⇒ **现在改成逐字节相等** ⇒ ⇒ 截断一律判红（负控 F 已专门钉这一条）。
    //   ⇒ ⇒ 这里再独立验一次（不走负控循环）⇒ ⇒ 确认「这条能力是真的、不是负控写歪了」。
    {
      const range = locateNoteBlock(baseNotes, 0);
      const broken =
        range === undefined
          ? baseNotes
          : baseNotes.slice(0, range.start) + baseNotes.slice(range.start + 40);
      write(broken, basePerf);
      const report = checkNoteFidelity({ notesPath, perfPath });
      if (report.errors.length > 0) {
        process.stdout.write(
          '✅ 新判据能力证明：删掉 note 块的**开头**（旧子串语义下会「照样命中 ⇒ 零错误」）' +
            '⇒ ⇒ 现在**判红**了 ⇒ ⇒ 「前缀截断」这一类漂移**已被守住** ✅\n',
        );
      } else {
        failures += 1;
        process.stdout.write(
          `✗ 新判据能力证明失败：删掉 note 块的**开头**竟然报出了 ${
            report.errors.map((issue) => issue.category).join('、') || '（无）'
          }⇒ ⇒ ⚠️ **判据可能退回子串语义了** ⇒ ⇒ 逐字节相等这条能力**没了**\n`,
        );
      }
    }

    // ── ★ 自测 · 【根因断言自己有没有牙】 ──
    //   ★ **一条「关于守卫的守卫」自己也可能是恒绿的** ⇒ ⇒ 必须验它。
    //   这里造一个**【不该变红】的夹具**：改一个**不属于任何 note 块**的地方
    //   ⇒ ⇒ 判定**仍然零错误** ⇒ ⇒ 断言「它确实零错误」⇒ ⇒
    //   ⇒ ⇒ **这就证明根因断言（判定必须不再通过）抓得住它**（不是见什么都红）。
    {
      const marker = '落盘结构与判定';
      if (!baseNotes.includes(marker)) {
        failures += 1;
        process.stdout.write(
          '✗ 根因断言有牙：基准里找不到「落盘结构与判定」这个标记 ⇒ ⇒ 夹具无效\n',
        );
      } else {
        write(baseNotes.replace(marker, '落盘结构与判定·自测'), basePerf);
        const report = checkNoteFidelity({ notesPath, perfPath });
        if (report.errors.length === 0) {
          process.stdout.write(
            '✅ 根因断言有牙：改一个**不属于任何 note 块**的地方 ⇒ ⇒ 判定**仍然零错误**' +
              '⇒ ⇒ 根因断言（判定必须不再通过）**有分辨力**、不是恒绿\n',
          );
        } else {
          failures += 1;
          process.stdout.write(
            `✗ 根因断言失牙：改非 note 块的地方竟然报出了 ${
              report.errors.map((issue) => issue.category).join('、') || '（无）'
            }⇒ ⇒ ⚠️ **判定范围可能过宽** ⇒ ⇒ 需要复核抽取器\n`,
          );
        }
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

/* ── CLI ── */

function runCli(argv: readonly string[]): number {
  if (argv.includes('--self-test')) {
    return runSelfTest();
  }

  const notesIndex = argv.indexOf('--notes');
  const perfIndex = argv.indexOf('--perf');
  const notesArg = notesIndex === -1 ? '' : (argv[notesIndex + 1] ?? '');
  const perfArg = perfIndex === -1 ? '' : (argv[perfIndex + 1] ?? '');

  const notesPath = notesArg === '' ? join(REPO_ROOT, NOTES_DOC_REL) : resolve(notesArg);
  const perfPath = perfArg === '' ? join(REPO_ROOT, PERF_REL) : resolve(perfArg);

  const report = checkNoteFidelity({ notesPath, perfPath });

  process.stdout.write(
    '落盘 note 的逐字节保真校验（文档里的 note **逐字节等于**实现里真正落盘的那一串？）\n',
  );
  process.stdout.write(`  文档侧（逐字副本）：${notesPath}\n`);
  process.stdout.write(`  实现侧（真正落盘）：${perfPath}\n`);
  for (const metric of report.metrics) {
    process.stdout.write(`${metric}\n`);
  }

  if (report.errors.length > 0) {
    process.stderr.write(`\n✗ 发现 ${report.errors.length} 处不一致：\n`);
    for (const issue of report.errors) {
      process.stderr.write(`    ${issue.category}：${issue.detail}\n`);
    }
    process.stderr.write('WRITE: false  READ: false\n');
    return 1;
  }

  process.stdout.write('WRITE: true  READ: true\n');
  process.stdout.write(
    '\n✓ 两段 note 都是实现侧落盘字符串的逐字副本（**逐字节相等** · 真零差异）\n',
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
