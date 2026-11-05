#!/usr/bin/env tsx
/**
 * 「措辞漂移」守卫 —— 禁止旧措辞「只读…2 行」以【断言】的形态出现在仓库任何地方。
 *
 * ## ★ 一眼看懂：**什么算豁免、什么算违规**（★ 下一个人不用猜）
 *
 * | 形态 | 怎么认 | 判定 |
 * |---|---|---|
 * | **断言形态** | 旧措辞**裸用**（不加引号）、当事实陈述 | ❌ **违规 ⇒ 判红** |
 * | **引述形态** | 旧措辞**落在引号里**（`「…」` / `『…』` / `“…”` / `` `…` ``） | ✅ 豁免（类 A） |
 * | **释义形态** | 旧措辞**邻近**特征短语「真实含义是」（★ 间隔 ≤ 40 字） | ✅ 豁免（类 B） |
 *
 * ⚠️ ★★ **类 B 是【逐个命中】判的、不是【整行】判的**（★ 本轮收紧项 · ★ 阈值由主理人拍「≤ 40 字」）：
 *   ⇒ ⇒ 同一行里若有一个**紧邻**释义标记的旧措辞、**又**有一个**远离**它的旧措辞
 *   ⇒ ⇒ ⇒ ⇒ **前者豁免、后者判红** ⇒ ⇒ ⇒ ⇒ 断言形态的漏网被堵住。
 * ⚠️ ★ **匹配是【按段】做的、不是对整行做的**：先把行按引号切成段 ⇒ ⇒ 段内独立匹配
 *   ⇒ ⇒ **一段引号内的命中 = 引述**（豁免）· **引号外的命中 = 断言**（判红）
 *   ⇒ ⇒ ⇒ 为什么要分段：宽式正则若对整行跑 ⇒ ⇒ 会**横跨两处引述**
 *   ⇒ ⇒ （「」不在排除集里）⇒ ⇒ 两处**都合规的引述**会被并成一个「跨引号命中」⇒ ⇒ **假红**
 *   ⇒ ⇒ ⇒ **本轮真实踩过一次**（设计稿的「四处同批」登记行）⇒ ⇒ 才改成按段扫。
 * ⚠️ ★★ **本文件里写不出「违规示例」**：任何**连续的**旧措辞都会把守卫自己判红
 *   ⇒ ⇒ 所以示例只能用**形态描述**表达（就像上表）⇒ ⇒ ⇒ **这本身说明「守卫对自己」的约束是实的**。
 *
 * ## ★★ **对外契约（下游脚本【必须】用它）**
 *
 * ★ 本文件导出两个判定入口 ⇒ ⇒ **下游【必须】import 它们** ⇒ ⇒
 *   **不许自己重写一遍「按引号切段 / 豁免规则」** ⇒ ⇒ 那会造成**两份判定** ⇒ ⇒
 *   两份判定会漂 ⇒ ⇒ 而「判定只有一份」正是这条守卫链的立身之本。
 * ★ **单向依赖**：本文件**导出** · 下游**import** ⇒ ⇒ **绝不能反向**（会成环）。
 *
 * | 形态 | 怎么认 | `classifyLine`（判**旧措辞**） | `classifySnippet`（判**任意子串**） |
 * |---|---|---|---|
 * | **断言处** | 引号**外** | ❌ **违规**（判红） | `assertion`（★ 规范措辞必须出现在这里） |
 * | **引述形态** | 引号**内**（`「」` / `『』` / `“”` / `` ` ``） | ✅ 豁免（类 A） | `quoted`（豁免） |
 * | **释义形态** | 该子串**邻近**特征短语「真实含义是」（★ 间隔 ≤ 40 字） | ✅ 豁免（类 B） | `explanation`（豁免） |
 *
 * ⚠️ ★★★ **`classifySnippet` 的返回值是【三值 + `undefined`】的闭集**（★ 契约 · 下游必须照这个判）：
 *   · **`'assertion'`** —— 子串在**引号外**、且**不邻近**释义标记 ⇒ ⇒ 它是**断言**（★ 规范措辞必须出现在这里）；
 *   · **`'quoted'`** —— 子串**落在引号内** ⇒ ⇒ 它是被**引用**的词（豁免）；
 *   · **`'explanation'`** —— 子串在引号外、但**邻近**释义标记（≤ 40 字）⇒ ⇒ 那一行在**解释**这个词（豁免）；
 *   · **`undefined`** —— ★ **只表示「这个子串不在这一行里」**（★ **不是**「形态判不出来」！）
 *     ⇒ ⇒ ★★ **下游绝不能把 `undefined` 当豁免**（★ 那是「压根没有」⇒ ⇒ 语义是**缺失**⇒ ⇒ 必须判红）。
 *     ⇒ ⇒ ★★ **为什么它不会与「形态判不出来」混淆（★ 结构上已堵）**：
 *     ⇒ ⇒ ⇒ **先 `includes`、再 `classifySnippet`** ⇒ ⇒ ⇒ `includes` 通过 ⇒ ⇒ 子串必在行内
 *     ⇒ ⇒ ⇒ ⇒ ⇒ `classifySnippet` **必定**返回三者之一 ⇒ ⇒ ⇒ ⇒ ⇒ **`undefined` 在结构上不可能出现**
 *     ⇒ ⇒ ⇒ ⇒ ⇒ （★ 已由 `scripts/check-benchmark-numbers.ts` 的判定顺序兑现 ⇒ ⇒ 它 import 本文件、不重写判据）。
 * ⚠️ ★ **两个入口答的是【不同的问题】、但共用【同一份切段实现】**（`splitSegments()`）：
 *   · `classifyLine` 答：「这一行里有没有**旧措辞**、它是否被豁免」；
 *   · `classifySnippet` 答：「这一行里、**这个子串**是不是以断言形态出现」（裁决③「措辞锚点维度」要的就是它）。
 *   ⇒ ⇒ ⇒ **切段 = 底层能力（只有一份）· 旧措辞豁免 = 一层 · 规范措辞形态 = 一层** ⇒ ⇒ ⇒ 三层同源。
 *
 * ## ★★ **与 `scripts/check-benchmark-numbers.ts` 的分工（★ 两者互补、不重叠）**
 *
 * | 脚本 | 守什么 | 方向 |
 * |---|---|---|
 * | ★ **本文件** `scripts/check-wording-drift.ts` | ★ **旧措辞不许以断言形态出现** | **负向**（禁止说错话） |
 * | ★ `scripts/check-benchmark-numbers.ts` | ★ **新措辞必须在各载体逐字一致**（数值维度 + 措辞维度 + 状态维度） | **正向**（必须说同一句话） |
 *
 * ⇒ ⇒ ★ **两者互补、不重叠**：本文件管「别退回旧说法」，那条管「各处都要用新说法」⇒ ⇒
 *   ⇒ ⇒ **只有合起来才封住「同一件事各处各说各话」**（负向 + 正向）。
 * ⇒ ⇒ ★★ **反向依赖被禁止**：那条脚本 **import 本脚本** ⇒ ⇒ **绝不能反向**（会成环）⇒ ⇒
 *   ⇒ ⇒ ⇒ 也不许在那条脚本里**重写一遍**切段/豁免规则 ⇒ ⇒ **两份判定会漂**。
 *
 * ## 背景（为什么要有这条脚本）
 *
 * 2026-11-05 的 1M · 热档采集把「精确分」的事实定成了「**至多 2 行**」
 * （依据是**分布**、不是 `max`：`{count 200, min 0, mean 1.09, p50 2, p99 2, max 2}`
 * ⇒ ⇒ 200 个样本**没有一个超过 2 行**）。
 * ⇒ ⇒ 而旧措辞（指「只读了 2 行」那一句）在 `min = 0` 的样本上是**假的**
 * （会被读成「恰好是 2」）⇒ ⇒ 所以口径里一律写「至多 2 行」。
 *
 * ⚠️ ★★ **本脚本为什么是「负向扫描」而不是「正向量锚点」**：
 *   · 正向量锚点（锚住「至多 2 行」这句话、逐字对齐各处）**依赖「载体清单」**；
 *   · 而「载体清单要维护」**正是本轮 ADR 漏网的机制本身**
 *     （architect 改设计稿时没回头扫 ADR ⇒ ⇒ 整条 ADR 的旧措辞留了下来）；
 *   · ⇒ ⇒ 负向扫描（**禁止旧措辞以断言形态出现**）**不需要维护清单**：
 *     新载体自动被覆盖 ⇒ ⇒ 而且能抓未来变体（「只读到 2 行」等）。
 *
 * ## ⚠️ ★★★ 白名单是【规则】、不是【清单】（★ 行号会漂、清单会变成后门）
 *
 * ⚠️ ★ **本仓库已经栽过两次**：
 *   ① 只 grep 字面量「只读了 2 行」⇒ ⇒ 漏掉 ADR 里的「只**读到** 2 行」；
 *   ② 把「释义行」写成**行号清单** ⇒ ⇒ 行号一漂就失效。
 * ⇒ ⇒ 所以豁免**只认内容特征**，共两类：
 *   · **A ·「被引用的词」**：命中片段**落在引号内**（`「」` / `『』` / `“”` / `` ` ``）
 *     ⇒ ⇒ 它是被**引用**的一个词，不是被**断言**的一个事实；
 *   · **B ·「释义形态」**：命中片段**邻近**特征短语「真实含义是」（★ **间隔 ≤ 40 字**）
 *     ⇒ ⇒ 它在**解释**这个词。
 * ⇒ ⇒ ⚠️ **凡不满足这两类的命中 ⇒ ⇒ 一律判红**。
 * ⇒ ⇒ ★ **两类都是【逐个命中】判的**（★ A 看命中自己在不在引号里 · B 看它离释义标记多近）
 *   ⇒ ⇒ ⇒ ⇒ **没有「整行放行」这回事** ⇒ ⇒ ⇒ ⇒ 同一行里「一处合规、一处违规」能被分开。
 *
 * ⚠️ ★★ **为什么 A 类不能省**（实测出来的坑）：
 *   释义段实际是**两行** ⇒ ⇒ 而**只有第一行**含「真实含义是」
 *   （第二行说的是「『只读了 2 行』是**单样本**的说法」）⇒ ⇒
 *   ⇒ ⇒ **只认 B 类的白名单会漏掉第二行** ⇒ ⇒ **正控当场红** ⇒ ⇒
 *   ⇒ ⇒ A 类（结构判定：片段在引号内）**正好把那两行都盖住** ⇒ ⇒
 *   ⇒ ⇒ 两类豁免**互补**、且**都不含行号** ⇒ ⇒ 行号漂了也不怕。
 *
 * ## ⚠️ ★ 白名单的【自检】（不靠人记得）
 *
 * ★ **豁免是规则 ⇒ ⇒ 它自己就会自检**：
 *   · 把「释义」改成「断言」（去掉引号、删掉特征短语）⇒ ⇒ **两处豁免同时失效**
 *     ⇒ ⇒ 该行变红（由 `--self-test` 的负控 B **机械证明**，不是靠嘴说）；
 *   · 豁免条目数**超过上限** ⇒ ⇒ 报「豁免条目过多」
 *     ⇒ ⇒ 防止「白名单被撑大」变成后门。
 *
 * ## ⚠️ ★★ 本脚本**扫自己**（★ ⇒ ⇒ 所以它的源码必须【自己合规】）
 *
 * ★ 全仓扫描**包含本文件** ⇒ ⇒ ⇒ 本文件里**每一处**旧措辞都必须是
 *   「被引用的词」（在引号里）或「释义行」（含特征短语）⇒ ⇒ 否则**守卫红在自己身上**。
 * ⇒ ⇒ ★ 而**自测夹具**必须造出**真正的坏文本**（未加引号的断言）⇒ ⇒
 *   ⇒ ⇒ 所以夹具里的旧措辞是**拼出来的**（见 `OLD_WORDING_HEAD` / `OLD_WORDING_TAIL`）
 *   ⇒ ⇒ **源码里不出现那个连续字面量** ⇒ ⇒ 守卫不误伤自己
 *   ⇒ ⇒ 而夹具在**运行时**造出的仍是真坏文本 ⇒ ⇒ 负控照样能进判定路径
 *   ⇒ ⇒ （由「根因断言」当场证明：判定必须不再通过）。
 *
 * ⚠️ ★ **豁免条目上限只统计【本文件之外】的豁免** ⇒ ⇒ 因为本文件必须引用旧措辞
 *   （否则写不出判据与夹具）⇒ ⇒ 它的豁免条目**天然很多** ⇒ ⇒ 不该计入上限。
 *
 * ## 已知限制（说清楚，别假装没有）
 *
 * ✅ ★★ **类 B 已从「整行豁免」收紧成「逐个命中 + 行级上下文」**（★ 主理人拍板 · ★ 本轮已改）：
 *   ⇒ ⇒ 判据 = **释义标记与该命中的间隔 ≤ 40 字**（★ 数的是字符数）⇒ ⇒ 超过 ⇒ ⇒ **该命中判红**。
 *   ⇒ ⇒ ⇒ 旧盲区（「一行里有释义标记、别处又断言式地用旧措辞 ⇒ 整行被豁免」）**已堵住**。
 *   ⇒ ⇒ ⇒ 且**由负控机械证明**（★ 同一行「近的一处豁免 + 远的一处判红」⇒ ⇒ 两次跑结论必须一致）。
 * ⚠️ ★ **残余限制 ①：间隔阈值数的是【字符数】、不是【语义】**：
 *   ⇒ ⇒ 一行里若有一段**恰好 ≤ 40 字**的无关文字把旧措辞与释义标记连起来 ⇒ ⇒ 那处仍会被豁免。
 *   ⇒ ⇒ 缓解：豁免条目数**有上限** ⇒ ⇒ 靠量堆豁免很快会撞上限 ⇒ ⇒ 报出来。
 * ⚠️ ★ **残余限制 ②：类 A（引述形态）仍是「该命中在引号内就豁免」**：
 *   ⇒ ⇒ 一行里若既有一个「被引用的词」、又有一个「当断言用的」旧措辞 ⇒ ⇒
 *   ⇒ ⇒ 那处断言**看得见**（★ A 是逐个命中判的、不牵连同行）⇒ ⇒ 但**引号内那处**永远豁免。
 *   ⇒ ⇒ 缓解：同上（豁免条目数有上限）。
 *
 * ## 用法
 *
 *   tsx scripts/check-wording-drift.ts                 # 校验（默认）
 *   tsx scripts/check-wording-drift.ts --self-test     # 自带正控 + 反向对照 + 负控
 *   tsx scripts/check-wording-drift.ts --root <dir>    # 扫别处（自测 / 排障用）
 *   tsx scripts/check-wording-drift.ts --max-allowed <n>
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 常量 ── */

/** 仓库根（`scripts/` 的上一级）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 本脚本自身（★ 它**参与扫描** ⇒ ⇒ 源码必须自己合规）。 */
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * 本脚本自身的**相对路径**（★ 用它、而不是绝对路径来判「是不是自己」）。
 *
 * ⚠️ ★ **为什么必须用相对路径**：自测把仓库拷到临时目录再扫 ⇒ ⇒
 *   绝对路径**必然不同** ⇒ ⇒ 若按绝对路径判 ⇒ ⇒ 临时副本里的本文件会被当成
 *   「普通文件」⇒ ⇒ 它的 7 处引用会**被计入豁免上限** ⇒ ⇒ 正控当场红。
 *   ⇒ ⇒ 用相对路径 ⇒ ⇒ 副本里的同一位置**照样**被认成「自己」。
 */
const SELF_REL = relative(REPO_ROOT, SELF_PATH).split(sep).join('/');

/**
 * 禁止出现的旧措辞（**宽式**：覆盖「只读了 / 只读到 / 只读过 … 2 行」等变体）。
 *
 * ⚠️ ★ **为什么用宽式而不是字面量**：本轮真实栽过一次 ——
 *   ADR 里的第三处是「只**读到** 2 行」⇒ ⇒ 用「只读了 2 行」grep **扫不到**。
 */
const FORBIDDEN_PATTERN = /只读[^，。；）]{0,12}2 行/gu;

/** 释义特征短语（★ 命中**邻近**它 ⇒ 它在**解释**这个词 ⇒ 豁免类 B）。 */
const FEATURE_PHRASE = '真实含义是';

/**
 * ★ 类 B 的**邻近阈值**：释义特征短语与该命中之间的**间隔字符数**上限。
 *
 * ⚠️ ★ **为什么是「间隔」而不是「同一行」**（★ 本轮收紧的根因）：
 *   「同一行含特征短语 ⇒ ⇒ 整行豁免」是**存在性判** ⇒ ⇒ 一行里只要有一处释义标记
 *   ⇒ ⇒ ⇒ **别处的断言式旧措辞就跟着被放行** ⇒ ⇒ ⇒ 那处断言**看不见**。
 *   ⇒ ⇒ 改成「**逐个命中** + **行级上下文**」⇒ ⇒ 释义标记必须**就在附近**才放行。
 *
 * ⚠️ ★ **阈值 40 字由主理人拍**（★ 本轮收紧项）⇒ ⇒ 判据写死在这里、只此一份。
 */
export const MAX_FEATURE_DISTANCE = 40;

/** 引号对（命中片段落在引号内 ⇒ 它是被**引用**的词 ⇒ 豁免类 A）。 */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['`', '`'],
];

/** 扫描时**跳过的目录名**（生成物 / 依赖 / 版本库 / 临时产物）。 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.tmp',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '.workbuddy',
]);

/** 扫描的**文件扩展名**（白名单 ⇒ ⇒ 不碰二进制、不碰 `.db` 这类大文件）。 */
const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.txt',
]);

/** 单文件大小上限（超过 ⇒ 跳过 ⇒ ⇒ 免得把生成物扫进来）。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 豁免条目数上限（**只统计本文件之外**的豁免；超过 ⇒ 报「豁免条目过多」）。 */
const DEFAULT_MAX_ALLOWED = 6;

/** 上下文截断长度（报告里贴整行 ⇒ ⇒ 但别刷屏）。 */
const CONTEXT_LIMIT = 120;

/**
 * ★ 旧措辞的**前半截**（★ 见文件头「本脚本扫自己」⇒ ⇒ 源码里不出现连续字面量）。
 */
const OLD_WORDING_HEAD = '只读';

/**
 * ★ 旧措辞的**后半截**（★ 与 `OLD_WORDING_HEAD` 拼起来才是那一句）。
 */
const OLD_WORDING_TAIL = '了 2 行';

/* ── 类型 ── */

/** 豁免类别（`undefined` ⇒ ⇒ 该命中是**违例**）。 */
export type Allowance =
  | { readonly kind: 'quoted'; readonly quote: string }
  | {
      readonly kind: 'feature-phrase';
      readonly phrase: string;
      /** ★ 释义标记与该命中之间的**间隔字符数**（≤ `MAX_FEATURE_DISTANCE` 才豁免）。 */
      readonly distance: number;
    };

/** 一处命中（违例或豁免）。 */
export interface Occurrence {
  /** 相对扫描根的文件路径（`/` 分隔）。 */
  readonly file: string;
  /** 行号（1 起）。 */
  readonly line: number;
  /** 命中的旧措辞片段。 */
  readonly snippet: string;
  /** 所在整行（截断）。 */
  readonly context: string;
  /** 豁免理由（`undefined` ⇒ 违例）。 */
  readonly allowance: Allowance | undefined;
  /** 是否命中在**本脚本自身**（★ 自身的豁免不计入上限）。 */
  readonly inSelf: boolean;
}

/** 一处不一致的**类别**（负控要断言的正是它 ⇒ ⇒ 类别名必须稳定）。 */
type IssueCategory = '旧措辞被当作断言' | '豁免条目过多';

/** 一处不一致。 */
interface Issue {
  readonly category: IssueCategory;
  readonly detail: string;
}

/** 一次扫描的结论。 */
interface Report {
  /** 扫过的文件数。 */
  readonly filesScanned: number;
  /** 全部命中（含豁免）。 */
  readonly occurrences: readonly Occurrence[];
  /** 违例（无豁免理由的命中）。 */
  readonly violations: readonly Occurrence[];
  /** 豁免（被规则放行的命中；**含**本脚本自身的）。 */
  readonly allowed: readonly Occurrence[];
  /** 豁免里**不属于本脚本自身**的条数（★ 计入上限的就是它）。 */
  readonly allowedCounted: number;
  /** 错误清单（空 = 通过）。 */
  readonly errors: readonly Issue[];
}

/* ── 扫描 ── */

/**
 * 找出本行里所有**引号跨度**。
 *
 * @param line 整行文本
 * @returns 跨度列表（`start` 闭、`end` 开）
 */
function findQuotedSpans(
  line: string,
): { readonly start: number; readonly end: number; readonly quote: string }[] {
  const spans: { start: number; end: number; quote: string }[] = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    while (from <= line.length) {
      const start = line.indexOf(open, from);
      if (start === -1) {
        break;
      }
      const end = line.indexOf(close, start + open.length);
      if (end === -1) {
        from = start + open.length;
        continue;
      }
      spans.push({
        start,
        end: end + close.length,
        quote: open === close ? open : `${open}${close}`,
      });
      from = end + close.length;
    }
  }
  return spans;
}

/**
 * 截断上下文（超长时加省略号）。
 *
 * @param text 整行文本
 * @returns 截断后的文本
 */
function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= CONTEXT_LIMIT ? trimmed : `${trimmed.slice(0, CONTEXT_LIMIT)}…`;
}

/**
 * 一个**文本跨度**（半开区间 `[start, end)`）。
 */
interface Span {
  /** 起始偏移（含）。 */
  readonly start: number;
  /** 结束偏移（不含）。 */
  readonly end: number;
}

/**
 * 找出本行里所有**特征短语**的跨度。
 *
 * @param line 整行文本
 * @param phrase 特征短语
 * @returns 跨度列表（按出现顺序）
 */
function findPhraseSpans(line: string, phrase: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (;;) {
    const start = line.indexOf(phrase, from);
    if (start === -1) {
      break;
    }
    spans.push({ start, end: start + phrase.length });
    from = start + phrase.length;
  }
  return spans;
}

/**
 * 两个跨度之间的**间隔字符数**（★ 中间夹着的那些字）。
 *
 * ⚠️ ★ **重叠算 0**：两个跨度重叠 ⇒ ⇒ 中间隔了 0 个字 ⇒ ⇒ 视为「紧邻」。
 *
 * @param left 左边那个
 * @param right 右边那个
 * @returns 间隔字符数
 */
function gapBetween(left: Span, right: Span): number {
  if (left.end <= right.start) {
    return right.start - left.end;
  }
  if (right.end <= left.start) {
    return left.start - right.end;
  }
  return 0;
}

/**
 * 一行被引号切出来的【段】。
 *
 * ⚠️ ★ **为什么要按段扫、而不是对整行扫**：
 *   宽式正则 `只读[^，。；）]{0,12}2 行` 若对**整行**跑 ⇒ ⇒ 它会**横跨两个引述**
 *   （「」与「」都不在排除集里）⇒ ⇒ 明明是两处**合规的引述**、却被判成一个
 *   「跨引号的命中」⇒ ⇒ **假红** ⇒ ⇒ 本轮真实踩过一次（设计稿的登记行）。
 *   ⇒ ⇒ 所以改成：**先按引号把行切成段 ⇒ ⇒ 段内独立匹配** ⇒ ⇒
 *   ⇒ ⇒ 引号内的命中 = 引述（豁免）· 引号外的命中 = 断言（判红）。
 */
interface Segment {
  /** 段文本。 */
  readonly text: string;
  /** 该段是否落在引号内（★ 落在引号内 ⇒ ⇒ 是「被引用的词」）。 */
  readonly quoted: boolean;
  /** 该段在整行里的起始偏移。 */
  readonly offset: number;
  /** 引号字符（仅 `quoted` 段有值）。 */
  readonly quote: string;
}

/**
 * 把一行按引号切成【引号内】/【引号外】的交替段。
 *
 * @param line 整行文本
 * @returns 段列表（按出现顺序）
 */
function splitSegments(line: string): Segment[] {
  const spans = findQuotedSpans(line).sort((left, right) => left.start - right.start);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) {
      // ⚠️ 跨度重叠（如嵌套引号）⇒ ⇒ 保守处理：跳过它 ⇒ ⇒ 里面那段仍算「引号内」。
      continue;
    }
    if (span.start > cursor) {
      segments.push({
        text: line.slice(cursor, span.start),
        quoted: false,
        offset: cursor,
        quote: '',
      });
    }
    segments.push({
      text: line.slice(span.start, span.end),
      quoted: true,
      offset: span.start,
      quote: span.quote,
    });
    cursor = span.end;
  }
  if (cursor < line.length) {
    segments.push({ text: line.slice(cursor), quoted: false, offset: cursor, quote: '' });
  }
  return segments;
}

/**
 * 扫一行 ⇒ ⇒ 找出全部旧措辞命中 + 各自的豁免理由。
 *
 * @param line 整行文本
 * @param file 相对路径（写进报告）
 * @param lineNo 行号（1 起）
 * @param inSelf 是否是本脚本自身
 * @returns 命中列表
 */
function scanLine(line: string, file: string, lineNo: number, inSelf: boolean): Occurrence[] {
  const segments = splitSegments(line);
  const featureSpans = findPhraseSpans(line, FEATURE_PHRASE);
  const out: Occurrence[] = [];
  for (const segment of segments) {
    for (const match of segment.text.matchAll(FORBIDDEN_PATTERN)) {
      const snippet = match[0] ?? '';
      const hitStart = segment.offset + match.index;
      const hitSpan: Span = { start: hitStart, end: hitStart + snippet.length };
      let allowance: Allowance | undefined;
      if (segment.quoted) {
        // ★ 类 A：该命中落在引号内 ⇒ ⇒ 它是被**引用**的词。
        allowance = { kind: 'quoted', quote: segment.quote };
      } else {
        // ★ 类 B：**逐个命中**判定 ⇒ ⇒ 释义标记必须【邻近】该命中（间隔 ≤ 阈值）。
        //   ⚠️ ★ 不再是「整行含特征短语就整行豁免」⇒ ⇒ 同一行里「近的一处 + 远的一处」
        //   ⇒ ⇒ ⇒ 必须给出**两个不同**的结论。
        let best: number | undefined;
        for (const span of featureSpans) {
          const gap = gapBetween(hitSpan, span);
          if (best === undefined || gap < best) {
            best = gap;
          }
        }
        if (best !== undefined && best <= MAX_FEATURE_DISTANCE) {
          allowance = { kind: 'feature-phrase', phrase: FEATURE_PHRASE, distance: best };
        }
      }
      out.push({ file, line: lineNo, snippet, context: truncate(line), allowance, inSelf });
    }
  }
  return out;
}

/**
 * **对外导出的判定入口** —— 把一行文本里的旧措辞命中分类（【断言】/【引述】/【释义】）。
 *
 * ★ **为什么导这一层、而不是只导「怎么切段」的手段**：
 *   下游脚本（例如跨载体措辞锚点守卫）要的是**判定**（这一处命中算不算违规），
 *   不是**手段**（怎么按引号切段）⇒ ⇒ 若只导手段 ⇒ ⇒ 下游就得自己重写一遍豁免规则
 *   ⇒ ⇒ **两份判定会漂** ⇒ ⇒ 所以这里导的是**带豁免判定的整层**。
 *
 * ★ **判定实现只有一份**：本函数只是内部扫描用的 `scanLine()` 的薄包装 ⇒ ⇒
 *   「是断言还是引述/释义」这条判据**不存在第二份实现** ⇒ ⇒ 改一处 ⇒ ⇒ 两处都生效。
 *
 * ★ **单向依赖**：本文件**导出**、下游**import** ⇒ ⇒ **绝不能反向**（否则成环）。
 *
 * @param line 整行文本
 * @param file 相对路径（写进报告）
 * @param lineNo 行号（1 起）
 * @returns 命中列表（含豁免理由；`allowance === undefined` ⇒ 该命中是违例）
 */
export function classifyLine(line: string, file: string, lineNo: number): Occurrence[] {
  return scanLine(line, file, lineNo, false);
}

/**
 * 某个子串在一行里处于什么形态。
 *
 * ⚠️ ★ **与 `classifyLine` 共用同一份切段实现**（`splitSegments()`）⇒ ⇒
 *   **切段只有一份** ⇒ ⇒ 「判定只有一份」在三层里都成立
 *   （切段 = 底层能力 · 旧措辞豁免 = 一层 · 规范措辞形态 = 一层）。
 */
export type SnippetShape =
  /** 断言处（引号外、且整行不是释义行）⇒ ★ 规范措辞必须出现在这里。 */
  | 'assertion'
  /** 引述形态（落在引号内）⇒ ★ 豁免。 */
  | 'quoted'
  /** 释义形态（所在行含特征短语「真实含义是」）⇒ ★ 豁免。 */
  | 'explanation';

/**
 * 判定某个子串在一行里的形态。
 *
 * ★ **判定顺序**（与 `classifyLine` 的豁免顺序一致）：
 *   ① 子串落在**引号内** ⇒ ⇒ `quoted`（引述形态 ⇒ 豁免）；
 *   ② 否则、特征短语「真实含义是」**邻近**该子串（★ 间隔 ≤ 40 字）⇒ ⇒ `explanation`（释义形态 ⇒ 豁免）；
 *   ③ 否则 ⇒ ⇒ `assertion`（断言处 ⇒ 规范措辞必须出现在这里）。
 *
 * ⚠️ ★ **同一行里子串出现多次时 ⇒ ⇒ 以【第一次出现】为准**（段序 = 行内先后）。
 *
 * @param line 整行文本
 * @param snippet 要判定的子串（★ 必须**逐字**出现在 line 里）
 * @returns 形态；★ `undefined` ⇒ 该子串不在这一行里
 */
export function classifySnippet(line: string, snippet: string): SnippetShape | undefined {
  for (const segment of splitSegments(line)) {
    const index = segment.text.indexOf(snippet);
    if (index === -1) {
      continue;
    }
    if (segment.quoted) {
      return 'quoted';
    }
    // ★ 与 `scanLine` 同构：释义形态要求特征短语**邻近**该子串（★ 判据只有一份）。
    const hitSpan: Span = {
      start: segment.offset + index,
      end: segment.offset + index + snippet.length,
    };
    let best: number | undefined;
    for (const span of findPhraseSpans(line, FEATURE_PHRASE)) {
      const gap = gapBetween(hitSpan, span);
      if (best === undefined || gap < best) {
        best = gap;
      }
    }
    return best !== undefined && best <= MAX_FEATURE_DISTANCE ? 'explanation' : 'assertion';
  }
  return undefined;
}

/**
 * 递归收集待扫描的文件。
 *
 * @param root 扫描根
 * @returns 文件绝对路径列表（已排序 ⇒ ⇒ 报告顺序稳定）
 */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) {
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!SCANNED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        continue;
      }
      out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 扫一棵树。
 *
 * @param root 扫描根（绝对路径）
 * @param maxAllowed 豁免条目数上限（**只统计本脚本自身之外**的豁免）
 * @returns 报告
 */
function scanTree(root: string, maxAllowed: number): Report {
  const files = collectFiles(root);
  const occurrences: Occurrence[] = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const inSelf = rel === SELF_REL;
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      occurrences.push(...scanLine(line, rel, index + 1, inSelf));
    }
  }

  const violations = occurrences.filter((item) => item.allowance === undefined);
  const allowed = occurrences.filter((item) => item.allowance !== undefined);
  const allowedCounted = allowed.filter((item) => !item.inSelf).length;
  const errors: Issue[] = [];

  for (const violation of violations) {
    errors.push({
      category: '旧措辞被当作断言',
      detail:
        `${violation.file}:${violation.line} ⇒ 「${violation.snippet}」 ⇒ ` +
        `该处把旧措辞当成【断言】在用（既不在引号里、离释义特征短语「${FEATURE_PHRASE}」` +
        `也超过 ${MAX_FEATURE_DISTANCE} 字）` +
        '⇒ ⇒ 口径里一律写「至多 2 行」⇒ ⇒ 请改成「至多 2 行」（或把它写成**被引用的词**）',
    });
  }

  if (allowedCounted > maxAllowed) {
    errors.push({
      category: '豁免条目过多',
      detail:
        `豁免 ${allowedCounted} 处 > 上限 ${maxAllowed}（★ 只统计本脚本自身之外的豁免）⇒ ⇒ ` +
        '白名单被撑大 ⇒ ⇒ 「引用式豁免」开始被当后门用 ⇒ ⇒ ' +
        '请改判据，或显式调高 --max-allowed（并说明理由）',
    });
  }

  return {
    filesScanned: files.length,
    occurrences,
    violations,
    allowed,
    allowedCounted,
    errors,
  };
}

/* ── 报告 ── */

/**
 * 把豁免理由翻成人话（报告里贴出来 ⇒ ⇒ 一眼可见「放行了什么」）。
 *
 * @param allowance 豁免理由
 * @returns 文字说明
 */
function describeAllowance(allowance: Allowance): string {
  return allowance.kind === 'quoted'
    ? `被引用的词（引号 ${allowance.quote}）`
    : `释义形态（特征短语「${allowance.phrase}」与该命中相距 ${allowance.distance} 字 ≤ ${MAX_FEATURE_DISTANCE}）`;
}

/**
 * 打印一次扫描的报告。
 *
 * @param report 报告
 * @param root 扫描根
 * @param maxAllowed 豁免上限
 */
function printReport(report: Report, root: string, maxAllowed: number): void {
  process.stdout.write('措辞漂移守卫（旧措辞不许以【断言】形态出现）\n');
  process.stdout.write(`  扫描根：${root}\n`);
  process.stdout.write(
    `  扫描文件：${report.filesScanned} 个（排除 node_modules / .git / .tmp / dist / 二进制 / >5 MB）\n`,
  );
  process.stdout.write(
    `  判据：/${FORBIDDEN_PATTERN.source}/ 命中 ⇒ ⇒ 必须属于下列豁免之一，否则判红：\n`,
  );
  process.stdout.write(
    '    ① 「被引用的词」：命中片段落在引号内（`「」` / `『』` / `“”` / `` ` ``）\n',
  );
  process.stdout.write(
    `    ② 「释义形态」：命中与释义特征短语「${FEATURE_PHRASE}」相距 ≤ ${MAX_FEATURE_DISTANCE} 字\n`,
  );
  process.stdout.write(`  豁免条目上限：${maxAllowed}（★ 只统计本脚本自身之外的豁免）\n`);

  const listed = report.allowed.filter((item) => !item.inSelf);
  const selfListed = report.allowed.filter((item) => item.inSelf);

  process.stdout.write(`\n豁免（仓库内 · 实际放行 ${listed.length} 处 · 计入上限的也是它）：\n`);
  if (listed.length === 0) {
    process.stdout.write('  （无）\n');
  }
  for (const item of listed) {
    const reason = item.allowance === undefined ? '（无）' : describeAllowance(item.allowance);
    process.stdout.write(`  ✔ ${item.file}:${item.line} · 「${item.snippet}」 · ${reason}\n`);
  }

  process.stdout.write(`\n豁免（本脚本自身 · ${selfListed.length} 处 · ★ 不计入上限）：\n`);
  for (const item of selfListed) {
    const reason = item.allowance === undefined ? '（无）' : describeAllowance(item.allowance);
    process.stdout.write(`  ✔ ${item.file}:${item.line} · 「${item.snippet}」 · ${reason}\n`);
  }

  process.stdout.write(`\n违例：${report.violations.length} 处\n`);
  for (const item of report.violations) {
    process.stdout.write(`  ✗ ${item.file}:${item.line} · 「${item.snippet}」 · ${item.context}\n`);
  }
}

/* ── 自测（正控 + 反向对照 + 负控 + 根因断言） ── */

/**
 * 自测里用的一个负控：名字、期望的失败类别、怎么把副本改坏。
 */
interface Control {
  readonly name: string;
  readonly expect: IssueCategory;
  /**
   * ★ 期望的**违例条数**（★ 不给 ⇒ 只要求「至少报出一条该类别的错」）。
   *
   * ★ **为什么需要它**：负控 D 的要点是「同一行里**近的一处豁免 + 远的一处判红**」
   *   ⇒ ⇒ 判红**一条**就对了（两条 ⇒ 说明**近的那处也被判红了** ⇒ ⇒ 类 B 收得太紧）；
   *   ⇒ ⇒ 零条 ⇒ 说明**远的那处也没抓住** ⇒ ⇒ 收紧根本没生效。
   */
  readonly expectViolationCount?: number;
  readonly mutate: (repo: string) => void;
}

/** 释义段所在文件（相对仓库根）。 */
const EXPLANATION_FILE = 'docs/design/perf-c2-t06-byte-metering.md';

/** ADR（另一个载体 · 用来做「非释义处」的对照）。 */
const ADR_FILE = 'docs/decisions/adr-perf-recall-vs-h1.md';

/**
 * 往文件末尾追加一行。
 *
 * @param path 文件路径
 * @param text 追加内容
 * @returns 是否追加成功（★ 自测要靠它判断「夹具有没有生效」⇒ ⇒ **不许恒返回真**）
 */
function appendLine(path: string, text: string): boolean {
  let original: string;
  try {
    original = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  writeFileSync(path, `${original}${original.endsWith('\n') ? '' : '\n'}${text}\n`, 'utf8');
  return true;
}

/**
 * 在**含指定锚点**的那一行之后插入一行。
 *
 * @param path 文件路径
 * @param anchor 锚点（行内子串）
 * @param text 插入内容（整行）
 * @returns 是否插进去了
 */
function insertAfterLine(path: string, anchor: string, text: string): boolean {
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  const index = lines.findIndex((line) => line.includes(anchor));
  if (index === -1) {
    return false;
  }
  lines.splice(index + 1, 0, text);
  writeFileSync(path, lines.join('\n'), 'utf8');
  return true;
}

/**
 * 在文件里把一段文字替换成另一段。
 *
 * @param path 文件路径
 * @param from 原文字
 * @param to 新文字
 * @returns 是否替换成功
 */
function replaceInFile(path: string, from: string, to: string): boolean {
  const original = readFileSync(path, 'utf8');
  if (!original.includes(from)) {
    return false;
  }
  writeFileSync(path, original.split(from).join(to), 'utf8');
  return true;
}

/**
 * 判断某个路径**要不要**被拷进自测用的临时副本。
 *
 * @param src 源路径
 * @returns 拷（`true`）/ 不拷（`false`）
 */
function shouldCopy(src: string): boolean {
  const name = basename(src);
  if (SKIPPED_DIRS.has(name)) {
    return false;
  }
  if (name.endsWith('.db') || name.endsWith('.db-wal') || name.endsWith('.db-shm')) {
    return false;
  }
  return true;
}

/**
 * 自测：正控 + 反向对照 + 逐条负控（**全部用临时副本** ⇒ ⇒ 绝不动仓库里的真实文件）。
 *
 * @returns 失败项数（0 = 全过）
 */
function runSelfTest(): number {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'wording-drift-selftest-'));
  let failures = 0;

  try {
    /* ── 准备：把仓库拷一份到临时目录（排除 node_modules / .git / .tmp / dist / *.db）── */
    const pristine = join(tmpRoot, 'pristine');
    cpSync(REPO_ROOT, pristine, { recursive: true, filter: shouldCopy });

    /* ── 正控：当前状态 ⇒ 零错误，且豁免机制**确实被用到**（不是空转）── */
    const positive = scanTree(pristine, DEFAULT_MAX_ALLOWED);
    if (positive.errors.length === 0) {
      process.stdout.write('✅ 正控：当前状态零错误\n');
    } else {
      failures += 1;
      process.stdout.write('✗ 正控失败（不该有错误）：\n');
      for (const issue of positive.errors) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }
    if (positive.allowedCounted > 0) {
      process.stdout.write(
        `✅ 正控：豁免机制**确实被用到**（仓库内放行 ${positive.allowedCounted} 处：${positive.allowed
          .filter((item) => !item.inSelf)
          .map((item) => `${item.file}:${item.line}`)
          .join('、')}）⇒ ⇒ 不是空转的守卫\n`,
      );
    } else {
      failures += 1;
      process.stdout.write(
        '✗ 正控：仓库内豁免条目为 0 ⇒ ⇒ 守卫从未被真正使用过 ⇒ ⇒ **空转的守卫**（恒绿）⇒ 必须修\n',
      );
    }
    if (positive.violations.some((item) => item.file.endsWith('check-wording-drift.ts'))) {
      failures += 1;
      process.stdout.write(
        '✗ 正控：**守卫脚本自身**有未豁免的旧措辞 ⇒ ⇒ 守卫会红在自己身上 ⇒ 必须修\n',
      );
    } else {
      process.stdout.write('✅ 正控：守卫脚本**自身**也零违例（★ 它扫自己 ⇒ ⇒ 源码自己合规）\n');
    }

    /* ── 反向对照 ①：同样的旧措辞，插在【非释义处】⇒ ⇒ 必须红 ── */
    {
      const work = join(tmpRoot, 'case-reverse-assert');
      cpSync(pristine, work, { recursive: true });
      const inserted = appendLine(
        join(work, ADR_FILE),
        `- ⚠️ ★ 反向对照：实测精确分${OLD_WORDING_HEAD}${OLD_WORDING_TAIL} ⇒ ⇒ 这是【断言】形态 ⇒ ⇒ 必须判红。`,
      );
      if (!inserted) {
        failures += 1;
        process.stdout.write('✗ 反向对照 ① ⇒ **夹具没生效**（没能插进副本）⇒ 夹具无效\n');
      } else {
        const report = scanTree(work, DEFAULT_MAX_ALLOWED);
        const hit = report.errors.find((issue) => issue.category === '旧措辞被当作断言');
        if (report.errors.length > 0 && hit !== undefined) {
          process.stdout.write(
            '✅ 反向对照 ①（非释义处 ⇒ 必须红）⇒ 判红 ✔（类别：旧措辞被当作断言）\n',
          );
        } else {
          failures += 1;
          process.stdout.write(
            `✗ 反向对照 ①（非释义处 ⇒ 必须红）⇒ **没红**（错误 ${report.errors.length} 处）` +
              '⇒ ⇒ 白名单开得过大 ⇒ 必须修\n',
          );
        }
      }
    }

    /* ── 反向对照 ②：同样的旧措辞，插在【释义处】（带引号 + 特征短语）⇒ ⇒ 必须**不**红 ── */
    {
      const work = join(tmpRoot, 'case-reverse-explain');
      cpSync(pristine, work, { recursive: true });
      const inserted = insertAfterLine(
        join(work, EXPLANATION_FILE),
        FEATURE_PHRASE,
        `> ⇒ ⇒ ⇒ ★ **附注：「${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}」${FEATURE_PHRASE}「【至多】2 行」**（★ 反向对照 · 释义形态）。`,
      );
      if (!inserted) {
        failures += 1;
        process.stdout.write('✗ 反向对照 ② ⇒ **夹具没生效**（没能插进副本）⇒ 夹具无效\n');
      } else {
        const report = scanTree(work, DEFAULT_MAX_ALLOWED);
        const stillAllowed = report.allowed.some(
          (item) =>
            item.file === EXPLANATION_FILE &&
            item.snippet === `${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}` &&
            !item.inSelf,
        );
        if (report.errors.length === 0 && stillAllowed) {
          process.stdout.write(
            '✅ 反向对照 ②（释义处 ⇒ 必须不红）⇒ 零错误且该处**落在豁免清单里**\n',
          );
        } else {
          failures += 1;
          process.stdout.write(
            `✗ 反向对照 ②（释义处 ⇒ 必须不红）⇒ 错误 ${report.errors.length} 处 / 豁免命中 ${stillAllowed}` +
              '⇒ ⇒ 豁免规则太紧（把释义也判红了）⇒ 必须修\n',
          );
        }
      }
    }

    /* ── 反向对照 ③：同一行里【两处引述】⇒ ⇒ 必须**不**红（★ 防「跨引号假红」回归）── */
    {
      const work = join(tmpRoot, 'case-two-quotes');
      cpSync(pristine, work, { recursive: true });
      const inserted = appendLine(
        join(work, ADR_FILE),
        `- ★ 反向对照 ③：「${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}」与「${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}」两处引述 ⇒ ⇒ 必须**不**红（★ 宽式正则不许横跨两处引述）。`,
      );
      if (!inserted) {
        failures += 1;
        process.stdout.write('✗ 反向对照 ③ ⇒ **夹具没生效**（没能插进副本）⇒ 夹具无效\n');
      } else {
        const report = scanTree(work, DEFAULT_MAX_ALLOWED);
        if (report.errors.length === 0) {
          process.stdout.write('✅ 反向对照 ③（同一行两处引述 ⇒ 必须不红）⇒ 零错误\n');
        } else {
          failures += 1;
          process.stdout.write(
            `✗ 反向对照 ③（同一行两处引述 ⇒ 必须不红）⇒ 错误 ${report.errors.length} 处` +
              '⇒ ⇒ 宽式正则横跨了两处引述 ⇒ ⇒ **假红** ⇒ ⇒ 必须按段扫\n',
          );
        }
      }
    }

    /* ── 反向对照 ④：旧措辞【紧邻】释义标记（标记在命中【之后】）⇒ ⇒ 必须**不**红 ── */
    {
      const work = join(tmpRoot, 'case-reverse-explain-after');
      cpSync(pristine, work, { recursive: true });
      const inserted = appendLine(
        join(work, ADR_FILE),
        `- ★ 反向对照 ④：实测精确分${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}（这一行${FEATURE_PHRASE}「【至多】2 行」）⇒ ⇒ 紧邻释义标记（标记在后）⇒ ⇒ 必须**不**红。`,
      );
      if (!inserted) {
        failures += 1;
        process.stdout.write('✗ 反向对照 ④ ⇒ **夹具没生效**（没能插进副本）⇒ 夹具无效\n');
      } else {
        const report = scanTree(work, DEFAULT_MAX_ALLOWED);
        const exempted = report.allowed.some(
          (item) =>
            item.file === ADR_FILE &&
            item.snippet === `${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}` &&
            item.allowance?.kind === 'feature-phrase',
        );
        if (report.errors.length === 0 && exempted) {
          process.stdout.write(
            '✅ 反向对照 ④（紧邻释义标记 · 标记在后 ⇒ 必须不红）⇒ 零错误且该处**由类 B 豁免**\n',
          );
        } else {
          failures += 1;
          process.stdout.write(
            `✗ 反向对照 ④（紧邻释义标记 · 标记在后 ⇒ 必须不红）⇒ 错误 ${report.errors.length} 处 / 类 B 豁免 ${exempted}` +
              '⇒ ⇒ 类 B 收得太紧（把紧邻的释义也判红了）⇒ 必须修\n',
          );
        }
      }
    }

    /* ── 反向对照 ⑤：旧措辞【紧邻】释义标记（标记在命中【之前】）⇒ ⇒ 必须**不**红 ── */
    {
      const work = join(tmpRoot, 'case-reverse-explain-before');
      cpSync(pristine, work, { recursive: true });
      const inserted = appendLine(
        join(work, ADR_FILE),
        `- ★ 反向对照 ⑤：这一行${FEATURE_PHRASE}「【至多】2 行」（实测精确分${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}）⇒ ⇒ 紧邻释义标记（标记在前）⇒ ⇒ 必须**不**红。`,
      );
      if (!inserted) {
        failures += 1;
        process.stdout.write('✗ 反向对照 ⑤ ⇒ **夹具没生效**（没能插进副本）⇒ 夹具无效\n');
      } else {
        const report = scanTree(work, DEFAULT_MAX_ALLOWED);
        const exempted = report.allowed.some(
          (item) =>
            item.file === ADR_FILE &&
            item.snippet === `${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}` &&
            item.allowance?.kind === 'feature-phrase',
        );
        if (report.errors.length === 0 && exempted) {
          process.stdout.write(
            '✅ 反向对照 ⑤（紧邻释义标记 · 标记在前 ⇒ 必须不红）⇒ 零错误且该处**由类 B 豁免**\n',
          );
        } else {
          failures += 1;
          process.stdout.write(
            `✗ 反向对照 ⑤（紧邻释义标记 · 标记在前 ⇒ 必须不红）⇒ 错误 ${report.errors.length} 处 / 类 B 豁免 ${exempted}` +
              '⇒ ⇒ 类 B 收得太紧（把紧邻的释义也判红了）⇒ 必须修\n',
          );
        }
      }
    }

    /* ── 形态判定自测（★ 新导出 `classifySnippet` 的契约证明）── */
    {
      const wording = `${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}`;
      const inside = classifySnippet(`旧措辞「${wording}」是旧说法。`, wording);
      const outside = classifySnippet(`实测精确分${wording} ⇒ ⇒ 断言形态。`, wording);
      const explained = classifySnippet(
        `实测精确分${wording}（这一行的真实含义是「至多」）。`,
        wording,
      );
      const absent = classifySnippet('这一行里没有那个说法。', wording);
      if (
        inside === 'quoted' &&
        outside === 'assertion' &&
        explained === 'explanation' &&
        absent === undefined
      ) {
        process.stdout.write(
          '✅ 形态判定：同一子串在引号内=quoted / 引号外=assertion / 释义行=explanation / 不在行内=undefined ✔\n',
        );
      } else {
        failures += 1;
        process.stdout.write(
          `✗ 形态判定：inside=${String(inside)} outside=${String(outside)} ` +
            `explained=${String(explained)} absent=${String(absent)} ⇒ ⇒ 形态判据失灵 ⇒ ⇒ 必须修\n`,
        );
      }
    }

    /* ── 负控：每条都必须报出【对应类别】（证明夹具真的进了判定路径）── */
    const controls: readonly Control[] = [
      {
        name: '负控 A · 变体措辞（「只**读到** 2 行」）',
        expect: '旧措辞被当作断言',
        mutate: (repo) => {
          appendLine(
            join(repo, ADR_FILE),
            `- ⚠️ ★ 负控：实测精确分${OLD_WORDING_HEAD}到${OLD_WORDING_TAIL} ⇒ ⇒ 变体也必须判红。`,
          );
        },
      },
      {
        name: '负控 B · 把「释义」改成「断言」（★ 白名单自检）',
        expect: '旧措辞被当作断言',
        mutate: (repo) => {
          const path = join(repo, EXPLANATION_FILE);
          replaceInFile(
            path,
            `「${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}」${FEATURE_PHRASE}`,
            `实测精确分${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}`,
          );
          replaceInFile(
            path,
            `「${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}」是**单样本**的说法`,
            `${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}是**单样本**的说法`,
          );
        },
      },
      {
        name: '负控 C · 豁免条目过多（★ 白名单不许被撑大）',
        expect: '豁免条目过多',
        mutate: (repo) => {
          const path = join(repo, 'docs/design/wording-drift-fixture.md');
          const lines: string[] = [];
          for (let index = 0; index < 6; index += 1) {
            lines.push(
              `> ★ 夹具 ${index}：「${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}」${FEATURE_PHRASE}「【至多】2 行」。`,
            );
          }
          writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
        },
      },
      {
        name: '负控 D · 同行既有释义标记、又有【远离】的断言式旧措辞（★ 类 B 收紧的证明）',
        expect: '旧措辞被当作断言',
        // ★ 期望**恰好 1 条**违例：近的那处（紧邻释义标记）豁免 · 远的那处（隔了 60+ 字）判红。
        expectViolationCount: 1,
        mutate: (repo) => {
          // ★ 填充物长度 = 阈值 + 20 ⇒ ⇒ 必然超出 `MAX_FEATURE_DISTANCE` ⇒ ⇒ 不靠手数。
          const filler = '·'.repeat(MAX_FEATURE_DISTANCE + 20);
          appendLine(
            join(repo, ADR_FILE),
            `- ⚠️ ★ 负控 D：实测精确分${OLD_WORDING_HEAD}${OLD_WORDING_TAIL}（这一行${FEATURE_PHRASE}「【至多】2 行」）⇒ ⇒ ${filler} ⇒ ⇒ 而后面这半句是【断言】旧说法：实测精确分${OLD_WORDING_HEAD}${OLD_WORDING_TAIL} ⇒ ⇒ 必须判红（近的那处豁免 · 远的那处判红）。`,
          );
        },
      },
    ];

    for (const [index, control] of controls.entries()) {
      const work = join(tmpRoot, `case-control-${index}`);
      cpSync(pristine, work, { recursive: true });
      control.mutate(work);

      const report = scanTree(work, DEFAULT_MAX_ALLOWED);

      /* ★★★★ **根因断言**：判据不是「内容变了」⇒ ⇒ **太弱**
       *   （夹具没进判定路径 ⇒ 判定仍零错误 ⇒ ⇒ 这条负控自己就是恒绿的）
       *   ⇒ ⇒ 判据必须是：**判定必须【不再通过】**。 */
      if (report.errors.length === 0) {
        failures += 1;
        process.stdout.write(
          `✗ ${control.name} ⇒ **判定仍然通过（零错误）** ⇒ ⇒ 这条负控自己就是恒绿的 ⇒ ` +
            '⇒ ⇒ **夹具没进判定路径**（★ 已由这条根因断言当场抓住）\n',
        );
        continue;
      }

      const hit = report.errors.find((issue) => issue.category === control.expect);
      if (hit === undefined) {
        failures += 1;
        process.stdout.write(
          `✗ ${control.name} ⇒ **没有**报出「${control.expect}」（实际报出：${report.errors
            .map((issue) => issue.category)
            .join('、')}）\n`,
        );
        continue;
      }

      if (control.expectViolationCount !== undefined) {
        const actual = report.violations.length;
        if (actual !== control.expectViolationCount) {
          failures += 1;
          process.stdout.write(
            `✗ ${control.name} ⇒ 违例条数 = ${actual}（期望 ${control.expectViolationCount}）` +
              '⇒ ⇒ 同一行里「近的一处」与「远的一处」的结论**没有分开**' +
              '（★ 多 = 近的那处也被判红了 = 类 B 收得太紧 · 少 = 远的那处没抓住 = 收紧没生效）⇒ ⇒ 必须修\n',
          );
          continue;
        }
        process.stdout.write(
          `✅ ${control.name} ⇒ 报出「${control.expect}」且违例条数 = ${actual}（★ 近的豁免 · 远的判红）\n`,
        );
        continue;
      }

      process.stdout.write(`✅ ${control.name} ⇒ 报出「${control.expect}」\n`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stderr.write(`\n✗ 自测失败 ${failures} 项\n`);
    return 1;
  }
  process.stdout.write('\n✅ 自测全过 ⇒ 这条守卫**不是恒绿守卫**\n');
  return 0;
}

/* ── CLI ── */

/**
 * CLI 入口。
 *
 * @param argv 命令行参数
 * @returns 退出码
 */
function runCli(argv: readonly string[]): number {
  if (argv.includes('--self-test')) {
    return runSelfTest();
  }

  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1] ?? REPO_ROOT);

  const maxIndex = argv.indexOf('--max-allowed');
  const maxAllowedRaw = maxIndex === -1 ? '' : (argv[maxIndex + 1] ?? '');
  const maxAllowed = Number.parseInt(maxAllowedRaw, 10);
  const max = Number.isFinite(maxAllowed) && maxAllowed >= 0 ? maxAllowed : DEFAULT_MAX_ALLOWED;

  const report = scanTree(root, max);
  printReport(report, root, max);

  if (report.errors.length > 0) {
    process.stderr.write(`\n✗ 发现 ${report.errors.length} 处不一致：\n`);
    for (const issue of report.errors) {
      process.stderr.write(`    ${issue.category}：${issue.detail}\n`);
    }
    process.stderr.write('DRIFT: true\n');
    return 1;
  }

  process.stdout.write('\n✓ 未发现旧措辞漂移（所有命中都是「被引用的词」或「释义形态」）\n');
  process.stdout.write('DRIFT: false\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
