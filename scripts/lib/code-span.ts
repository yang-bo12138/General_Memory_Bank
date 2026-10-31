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
 */

import { readFileSync } from 'node:fs';

/**
 * 把源码里的**注释**就地涂白（长度不变 ⇒ 下标与原文一一对应）。
 *
 * ⚠️ **字符串字面量里的 `//` 不算注释**（例如 `'https://x'`）⇒ 必须跟踪引号状态。
 * ⚠️ 本项目的 `src/` 里没有正则字面量（已核）⇒ 不必处理「正则里的引号」这一族歧义。
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let index = 0;
  let quote: string | undefined;

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

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      index += 1;
      continue;
    }

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
