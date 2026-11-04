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
 * ## ⚠️ 已知限制（**说清楚，别假装没有**）：**前缀 / 后缀截断检测不出来**
 *
 * ⚠️ ★ 本检查是**子串**语义（文档侧那段要能在实现侧源文本里**找到**）⇒ ⇒
 *   若有人把文档侧的 note 副本**截掉开头或结尾**（而中间不动）⇒ ⇒
 *   剩下的仍是实现侧那段文本的**子串** ⇒ ⇒ **照样命中** ⇒ ⇒ **检测不出来**。
 * ⇒ ⇒ 后果：**「前缀/后缀截断」这一类漂移目前无守卫** ⇒ ⇒ 已在负控里用「删中间」覆盖了
 *   **实义文本漂移**这一类 ⇒ ⇒ ★ **彻底堵上要改成【等长比较】**
 *   （把实现侧的 note 当作**一个整体**抽出来 ⇒ 与文档侧**逐位相等**比较）
 *   ⇒ ⇒ **本轮不做**（超出「搬脚本 + 修夹具」的范围）⇒ ⇒ 登记为**待办**。
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
 * 归一化：只留**实义字符**。
 *
 * ⚠️ ★ **为什么要去掉 `+`**（对称归一化的必然结果）：
 *   实现侧的 `note` 是 `'…' + '…'` 拼的 ⇒ 拼接符 `+` 会出现在**实义文本中间**
 *   ⇒ ⇒ 两边**对称**地去掉 `+` ⇒ ⇒ 只剩实义字符可比。
 *
 * ⚠️ ★★ **为什么【不】归一化 emoji**：emoji（尤其 `⚠` + VS16）**不是**噪声 ⇒
 *   ⇒ 它必须**原样参与比对** ⇒ ⇒ **VS16 少一个就是漂移**（⇒ 单独报成一类，见文件头「emoji 陷阱」）。
 */
const norm = (text: string): string => text.replace(/\s+/gu, '').replace(/['"`\\+]/gu, '');

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

/* ── 报告 ── */

/** 一处不一致的**类别**（负控要断言的正是它 ⇒ ⇒ 类别名必须稳定）。 */
type IssueCategory =
  | 'note 块数量为零'
  | 'note 块数量减少'
  | 'note 块未命中（逐字不一致）'
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
  /** 归一化后的实义字符（比对用）。 */
  readonly probe: string;
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
    blocks.push({ raw, probe: norm(unescapeJson(raw)) });
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
 * 核查：文档侧的两段 `note` 是否与实现侧**逐字**一致。
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
  const perfNorm = norm(perfText);
  const perfNoVs16 = stripVs16(perfNorm);
  const blocks = extractNoteBlocks(notesText);
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

  let hits = 0;
  blocks.forEach((block, index) => {
    if (perfNorm.includes(block.probe)) {
      hits += 1;
      metrics.push(`  note[${index}]（${block.probe.length} 字）在实现侧逐字命中：true`);
      return;
    }
    if (perfNoVs16.includes(stripVs16(block.probe))) {
      errors.push({
        category: 'emoji 漂移（仅 VS16 差异）',
        detail:
          `note[${index}]：去掉 VS16（U+FE0F）后**就命中了** ⇒ ⇒ 差异**仅由变体选择符造成** ⇒ ⇒ ` +
          '⇒ 改 note 字符串时**必须照抄「⚠️」（U+26A0 + U+FE0F）**，不要用纯「⚠」',
      });
      metrics.push(
        `  note[${index}]（${block.probe.length} 字）在实现侧逐字命中：false（仅 VS16 差异）`,
      );
      return;
    }
    // ⚠️ 报告**最长公共前缀**长度（定位漂移点）。
    let common = 0;
    while (common < block.probe.length && perfNorm.includes(block.probe.slice(0, common + 1))) {
      common += 1;
    }
    const anchor = block.probe.slice(0, Math.max(1, common - 10));
    const at = perfNorm.indexOf(anchor);
    errors.push({
      category: 'note 块未命中（逐字不一致）',
      detail:
        `note[${index}]（${block.probe.length} 字）：最长命中前缀 ${common} 字 ⇒ ⇒ 漂移点附近 —— ` +
        `实现侧：…${perfNorm.slice(at + anchor.length, at + anchor.length + 60)}… / ` +
        `文档侧：…${block.probe.slice(anchor.length, anchor.length + 60)}…`,
    });
    metrics.push(`  note[${index}]（${block.probe.length} 字）在实现侧逐字命中：false`);
  });

  metrics.unshift(`JSON note 块数量：${blocks.length}`);
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
      // ⚠️ ★★★ **必须删【中间】的一段，不能删开头**：
      //   本检查是**子串**语义（文档侧那段要能在实现侧源文本里**找到**）
      //   ⇒ ⇒ 删掉**开头** ⇒ 剩下的仍是实现侧那段文本的**后缀** ⇒ ⇒ **照样命中**
      //   ⇒ ⇒ **夹具等于没生效**（⇒ 本轮真实栽过一次：负控 B 一开始就是这么写的 ⇒ 立刻报「（无）」）。
      //   ⇒ ⇒ 删【中间】 ⇒ 剩下「前缀 + 后缀」⇒ ⇒ **不再是连续子串** ⇒ ⇒ 抓得住。
      return notes.slice(0, range.start + run.start) + notes.slice(range.start + run.end);
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

    // ── ★ 自测 · 【根因断言自己有没有牙】 ──
    //   ★ **一条「关于守卫的守卫」自己也可能是恒绿的** ⇒ ⇒ 必须验它。
    //   这里造一个**坏的夹具**：把 note 块的**开头**删掉 ⇒ ⇒ 子串语义下**照样命中**
    //   ⇒ ⇒ 判定**零错误** ⇒ ⇒ 断言「它确实零错误」⇒ ⇒
    //   ⇒ ⇒ **这就证明根因断言（判定必须不再通过）抓得住它**
    //   ⇒ ⇒ 若哪天它不再零错误（⇒ 子串语义改成等长比较）⇒ ⇒ 这条断言会红
    //   ⇒ ⇒ ⇒ 提醒：**负控 B 改成「删中间」之后，得把这条一并更新**。
    {
      const range = locateNoteBlock(baseNotes, 1);
      const broken =
        range === undefined
          ? baseNotes
          : baseNotes.slice(0, range.start) + baseNotes.slice(range.start + 40);
      write(broken, basePerf);
      const report = checkNoteFidelity({ notesPath, perfPath });
      if (report.errors.length === 0) {
        process.stdout.write(
          '✅ 根因断言有牙：坏的夹具（删 note 块的**开头** ⇒ 子串语义下仍命中）确实让判定**零错误**' +
            '⇒ ⇒ 根因断言（判定必须不再通过）**抓得住它**\n',
        );
      } else {
        failures += 1;
        process.stdout.write(
          `✗ 根因断言失牙：坏的夹具（删开头）竟然报出了 ${
            report.errors.map((issue) => issue.category).join('、') || '（无）'
          }⇒ ⇒ ⚠️ **子串语义可能已经变了** ⇒ ⇒ 负控 B「删中间」的写法与「前缀/后缀截断检测不出」这条限制**都要重新复核**\n`,
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

  process.stdout.write('落盘 note 的逐字保真校验（文档里的 note == 实现里真正落盘的那一串？）\n');
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
  process.stdout.write('\n✓ 两段 note 都是实现侧落盘字符串的逐字副本（真零差异）\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
