/**
 * 源码「代码块」的定位与**注释涂白** —— 供跨节锚定检查用（P2-T04）。
 *
 * ⚠️ **为什么需要「涂白」而不是「删掉」**：
 *   涂白（把注释与字符串内容**就地替换成空格**、长度不变）⇒
 *   **替换后的下标仍与原文一一对应** ⇒ 可以拿它做「下标落在某个区间内」的判断
 *   （区间来自原文的花括号配对）。
 *   ⇒ 若改成「删掉」，行号与下标全部漂移 ⇒ 区间算错 ⇒ 判据**静默失效**
 *   （**这种错不会报任何错**，只会让闸门永远绿）。
 *
 * ⚠️ **只涂白注释，不涂白字符串**：
 *   锚定检查要认的动作关键词里**有落在字符串里的**（例如 `'absent'`、`'reinforce'`）
 *   ⇒ 涂白字符串会把它们一起抹掉 ⇒ 闸门误报。
 *   ⇒ 桶表 SQL 的扫描**另用一套**（`scripts/lib/bucket-write-scan.ts` 的
 *     `stripCommentLines`）—— 那套**故意保留字符串**（它要找的正是 SQL 字符串）。
 *   ⚠️ 两套工具的分工是刻意的，不是重复：
 *     · `stripCommentLines` ⇒ 找 **SQL 字符串**（要保留字符串）；
 *     · `blankComments`      ⇒ 找 **标识符**（要抹掉注释、保留字面量）。
 *
 * ⚠️⚠️ **v2.1（P2 QA 第二轮 F4 修正）**：
 *   原先 `blankComments` 的主循环里**引号判断排在注释判断之前** ⇒
 *   ⇒ **注释里的一个引号会「开启一个假字符串」** ⇒ 从那里往后**所有注释都不再被涂白**
 *   ⇒ 后果：`src/util/log.ts`（有 31 行注释里含引号/反引号）**32 行注释没被涂白**
 *   ⇒ `check:bucket-write` 会把**注释里**提到的桶表 SQL **误报**成裸写
 *   ⇒ 而「误报 ⇒ 大家开始忽略它」⇒ 闸门变成噪声（正是 F6 想消除的那类误报）。
 *   ⇒ **修法**：**先判注释、后判引号**，并**识别正则字面量**
 *     （正则内部可以有引号；`src/util/log.ts:95` 与 `src/core/tokenize.ts:131` 就有正则
 *     ⇒ 原注释「`src/` 里没有正则字面量（已核）」**已失真**）。
 *   ⇒ 判定正则起始的规则与 `scripts/check-clock.ts` 的 `stripComments` 一致（同一套规则）。
 */

import { readFileSync } from 'node:fs';

/**
 * 判断一个 `/` 是不是**正则字面量的起始**。
 *
 * ⚠️ **为什么要认正则**：正则内部可以出现引号（`/[\s,="[\]{}()<>&;]/`）
 *   ⇒ 若不识别它，就会把正则里的 `"` 当成字符串起始 ⇒ 后面整段被当字符串 ⇒ **失步**。
 *   ⇒ `src/util/log.ts:95` 与 `src/core/tokenize.ts:131` **确实有正则字面量**
 *   ⇒ 原注释「`src/` 里没有正则字面量（已核）」**已失真**。
 *
 * ⚠️ 判定规则与 `scripts/check-clock.ts` 的 `stripComments` **完全一致**（同一套规则 ⇒ 不会漂移）。
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'do',
  'else',
  'await',
  'yield',
  'delete',
  'void',
  'instanceof',
]);

const REGEX_PRECEDING_CHARS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/**
 * 把源码里的**注释**就地涂白（长度不变 ⇒ 下标与原文一一对应）。
 *
 * ⚠️ **字符串字面量里的 `//` 不算注释**（例如 `'https://x'`）⇒ 必须跟踪引号状态。
 * ⚠️⚠️ **判断顺序是「先注释、后引号」**（P2 QA 第二轮 F4）：反过来的话，
 *   **注释里的引号会开启一个假字符串** ⇒ 从那里往后所有注释都不再被涂白
 *   ⇒ 桶表门禁会**误报**注释里提到的 SQL。
 * ⚠️ **正则字面量整体跳过**（其内部可以有引号 ⇒ 否则同样会失步）。
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let index = 0;
  let quote: string | undefined;
  /** 最近的非空白代码字符（用于判断 `/` 是不是正则起始）。 */
  let lastChar = '';
  /** 最近的标识符 / 关键字（同上）。 */
  let lastWord = '';

  const track = (char: string): void => {
    if (/\s/.test(char)) {
      return;
    }
    lastChar = char;
    lastWord = /[A-Za-z_$]/.test(char) ? lastWord + char : '';
    if (!/[A-Za-z0-9_$]/.test(char)) {
      lastWord = '';
    }
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (quote !== undefined) {
      // ⚠️ 在字符串里：只看转义（`\'`）与结束引号 ⇒ 字符串里的 `//` 不会被当成注释。
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }

    // ⚠️⚠️ **判断顺序：先判注释，后判引号**（P2 QA 第二轮 F4 的核心修正）。
    //   反过来（引号在前）的话 ⇒ **注释里的一个引号会「开启一个假字符串」**
    //   ⇒ 从那里往后**所有注释都不再被涂白** ⇒ 桶表门禁把**注释里**的 SQL 误报成裸写
    //   ⇒ 而「误报 ⇒ 大家开始忽略它」⇒ 闸门变成噪声（正是 F6 想消除的那类误报）。
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      while (index < source.length) {
        const current = source[index] ?? '';
        if (current !== '\n') {
          out[index] = ' ';
        }
        if (current === '*' && source[index + 1] === '/') {
          out[index + 1] = ' ';
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    // ⚠️ **正则字面量**：内部可以有引号 ⇒ 必须整体跳过，否则会失步。
    //   `src/util/log.ts:95` 与 `src/core/tokenize.ts:131` 确实有正则
    //   ⇒ 原注释「`src/` 里没有正则字面量（已核）」**已失真**。
    if (
      char === '/' &&
      (REGEX_PRECEDING_CHARS.has(lastChar) || REGEX_PRECEDING_KEYWORDS.has(lastWord))
    ) {
      let cursor = index + 1;
      let inCharClass = false;
      while (cursor < source.length) {
        const current = source[cursor] ?? '';
        if (current === '\\') {
          cursor += 2;
          continue;
        }
        if (current === '[') {
          inCharClass = true;
        } else if (current === ']') {
          inCharClass = false;
        } else if (current === '/' && !inCharClass) {
          break;
        } else if (current === '\n') {
          break;
        }
        cursor += 1;
      }
      // 正则的**内容不是注释** ⇒ 原样保留 ⇒ 只把终止符之后当作代码继续
      index = cursor + 1;
      track('/');
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      index += 1;
      track(char);
      continue;
    }

    track(char);
    index += 1;
  }

  return out.join('');
}

/**
 * 把源码里的**字符串字面量**就地涂白（长度不变 ⇒ 下标与原文一一对应）。
 *
 * ⚠️ **为什么需要它**（P2 QA 验收 F4）：
 *   `code` 落点的动作关键词**若只在字符串字面量里出现**，那条断言就**不成立** ——
 *   例如 `const assignment = 'assignBucket(...)';` ⇒ 真调用被删了、只留一个字符串
 *   ⇒ 而「动作出现在管辖路径上」这条承诺**已经失效** ⇒ 门禁却判绿。
 *   ⇒ 涂白字符串 ⇒ 匹配只在**真正的代码位置**上生效。
 *
 * ⚠️ **只对 `code` 落点用**：`doc` 落点**必须保留字符串**
 *   （设计稿正文里 `'absent'` / `'reinforce'` 这类**带引号的字面量**就是动作关键词本身）。
 *
 * ⚠️ 与 `blankComments` 的区别：那个**保留字符串**、涂白注释；这个**保留注释**、涂白字符串。
 *
 * ⚠️⚠️ **已知限制（写在这里，免得下一个读的人踩）**：**模板字符串的插值会被整体涂白**
 *   （`` `${x}assignBucket${y}` `` ⇒ 整段被涂 ⇒ 关键词消失）
 *   ⇒ 关键词若出现在**模板字符串的插值里**，本函数**判不出来**
 *   ⇒ 当前三个 `code` 落点的关键词都不在模板串里（实测）⇒ 不影响现状
 *   ⇒ 将来若把关键词放进插值 ⇒ 需要另想办法（例如先判「标识符形态」的关键词）。
 *   ⇒ 两者**顺序敏感**：若要「既无注释又无字符串」，需先涂白注释、再在**其结果上**涂白字符串
 *   （涂白不会改变其它字符的下标 ⇒ 可直接串联）。
 *
 * @param source 源码文本
 * @returns 字符串字面量被涂白后的文本（长度与入参相同）
 */
export function blankStrings(source: string): string {
  const out = source.split('');
  let index = 0;
  let quote: string | undefined;

  while (index < source.length) {
    const char = source[index] ?? '';

    if (quote !== undefined) {
      // ⚠️ 在字符串里：只看转义（`\'`）与结束引号 ⇒ 字符串里的引号不会提前结束字符串。
      out[index] = ' ';
      if (char === '\\') {
        if (index + 1 < source.length) {
          out[index + 1] = ' ';
        }
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out[index] = ' ';
      index += 1;
      continue;
    }

    index += 1;
  }

  return out.join('');
}

/**
 * 取某个符号所在的**函数体**（花括号配对；注释已涂白）。
 *
 * ⚠️ **在涂白后的文本上配对花括号**：SQL 模板字符串里有 `{` / `}`，
 *   不涂白注释就数到 SQL 里的括号 ⇒ 区间算错 ⇒ 判据静默失效。
 * ⚠️ **找不到该符号 ⇒ 返回 `undefined`**（不抛错）⇒ 由调用方决定这是「缺失」
 *   还是「待补」——**两者都不许静默跳过**。
 *
 * @param source 源码文本
 * @param symbol 函数名（如 `handleExactRepeat`）
 * @returns 函数体文本（注释已涂白）；找不到时为 `undefined`
 */
export function extractFunctionBody(source: string, symbol: string): string | undefined {
  const blanked = blankComments(source);
  const marker = new RegExp(`\\bfunction\\s+${escapeRegExp(symbol)}\\s*\\(`);
  const match = marker.exec(blanked);
  if (match === null) {
    return undefined;
  }
  const open = blanked.indexOf('{', match.index);
  if (open < 0) {
    return undefined;
  }
  const end = matchBrace(blanked, open);
  if (end < 0) {
    return undefined;
  }
  return blanked.slice(open + 1, end);
}

/**
 * 读一个源文件（**相对仓库根**的路径）。
 *
 * ⚠️ 路径相对**仓库根**解析（而不是 cwd）⇒ 在任何工作目录下跑都读得到同一个文件。
 */
export function readSourceFile(repoRoot: string, relativePath: string): string {
  return readFileSync(`${repoRoot}/${relativePath}`, 'utf8');
}

/** 正则元字符转义。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从一个 `{` 出发，找到配对的 `}`（返回其下标；找不到 ⇒ -1）。
 *
 * ⚠️ 调用方**必须**传**已涂白**的文本（否则注释里的括号会数进去）。
 */
export function matchBrace(blanked: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < blanked.length; index += 1) {
    const char = blanked[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}
