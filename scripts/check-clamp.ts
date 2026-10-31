#!/usr/bin/env tsx
/**
 * F-08 ③：`intensity()` 的两道钳制的**静态守卫** —— DESIGN-v2.md §4.1。
 *
 * ⚠️ **为什么行为层无解、只能用静态扫描**（QA 四轮复核查清的事实）：
 *   `intensity()` 的两道钳制 `Math.max(0, Δt)` 与 `Math.min(1, …)` 在**正常输入下行为等价**
 *   —— 留一道、删另一道，逐位结果**完全相同** ⇒ 任何「删掉一道」的行为断言都是**真空负控**
 *   （红不起来 ⇒ 等于没有守卫）。
 *   QA 用穷举证明：只有**两道同时**删，`intensity` 才会越界 ⇒
 *   行为层**抓不到**「少一道」这种最常见的漂移。
 *   ⇒ 通用解是**静态扫描**：直接确认两道钳制**同时存在于 `intensity()` 的函数体里**。
 *
 * ⚠️ **必须按「函数体范围」定位，不能全文件 grep**：
 *   `src/core/decay.ts` 里别处也有 `Math.max` / `Math.min` ⇒ 全文件 grep 会把它们算进来
 *   ⇒ 删掉 `intensity()` 里的钳制也可能照样通过 ⇒ 守卫就松了（形同虚设）。
 *   ⇒ 本脚本按「`function intensity(` 的签名 → 配对花括号」定位函数体，**只扫函数体内**的调用。
 *
 * ⚠️ **必须先剥注释再扫**：
 *   `decay.ts` 的注释里大量出现 `min(1, ...)` / `max(0, now - last_access)` 这类**说明文字**
 *   ⇒ 不剥注释会把说明文字当成代码 ⇒ 守卫恒通过 ⇒ 形同虚设。
 *   ⇒ 复用 `check-clock.ts` 的 `stripComments`（它保留换行与字符位置 ⇒ 行号不失真）。
 *
 * ⚠️ **判据是「调用的第一个实参」**，不是「文件里出现过这个字符串」：
 *   `Math.min(1, …)` 与 `Math.min(0.5, …)` 语义完全不同 ⇒ 必须比**实参**。
 *
 * ⚠️ **「没扫到」必须判红，不能判过**：
 *   若 `intensity()` 被改名 / 被删掉，本脚本找不到函数体 ⇒ 那是「守卫失效」，
 *   不是「钳制合规」⇒ 必须 exit 1（否则删掉整个函数也会显示全绿）。
 *
 * 用法：`pnpm exec tsx scripts/check-clamp.ts`
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stripComments } from './check-clock.js';

/** 被扫描的目标文件（相对仓库根，用 `/` 分隔）。 */
export const TARGET_FILE = 'src/core/decay.ts';

/** 被扫描的函数名。 */
export const TARGET_FUNCTION = 'intensity';

/** 一道必须存在的钳制。 */
export interface ClampSpec {
  /** 方法名（`Math.max` / `Math.min`）。 */
  readonly method: 'max' | 'min';
  /** 第一个实参必须等于它（**数值**比较，不是字符串比较）。 */
  readonly expectedArgument: number;
  /** 人读的说明（写进输出与错误信息）。 */
  readonly label: string;
}

/** 必须**同时**存在的两道钳制（§4.1 的「两重防护」）。 */
export const REQUIRED_CLAMPS: readonly ClampSpec[] = [
  { method: 'max', expectedArgument: 0, label: 'Δt 下钳（防时钟回拨 / 注入过去时刻）' },
  { method: 'min', expectedArgument: 1, label: '强度上钳（防 τ → 0 等极端输入）' },
];

/**
 * ★ C31：**写死**的期望条数。
 *
 * ⚠️ 分母**不能**由「本次扫到几条」派生 —— 那样「两道都删了」会显示成「0/0 全绿」。
 *   ⇒ 这里写死 2，并让脚本自检 `REQUIRED_CLAMPS.length === 2`（自洽性也是断言）。
 */
export const EXPECTED_REQUIRED_CLAMP_COUNT = 2;

/** 函数体的位置（偏移量，0 起）。 */
export interface FunctionBodyRange {
  /** 函数签名的起始偏移。 */
  readonly signatureStart: number;
  /** 函数体 `{` 的偏移。 */
  readonly bodyStart: number;
  /** 函数体 `}` 的偏移。 */
  readonly bodyEnd: number;
}

/** 一次 `Math.max` / `Math.min` 调用。 */
export interface ClampHit {
  /** 所在行号（1 起）。 */
  readonly line: number;
  /** 第一个实参的原文（去首尾空白）。 */
  readonly argument: string;
  /** 第一个实参的数值（非数字时为 `NaN`）。 */
  readonly numeric: number;
  /** 命中所在源码行（去首尾空白）。 */
  readonly sourceLine: string;
}

/** 扫描结果。 */
export interface ClampScanResult {
  /** 是否定位到了目标函数。 */
  readonly functionFound: boolean;
  /** 函数体的行号范围（1 起，闭区间）；没定位到时为 `null`。 */
  readonly bodyLines: { readonly start: number; readonly end: number } | null;
  /** 函数体内**所有** `Math.max` / `Math.min` 调用（不只达标的）。 */
  readonly hits: { readonly max: readonly ClampHit[]; readonly min: readonly ClampHit[] };
  /** 缺失的钳制（规格）。 */
  readonly missing: readonly ClampSpec[];
}

/** 每一行的起始偏移。 */
function lineStarts(source: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** 偏移量 → 行号（1 起）。 */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

/**
 * 找配对的右花括号（跳过字符串字面量）。
 *
 * ⚠️ **已知边界**：正则字面量里的花括号**不**特殊处理 ——
 *   `decay.ts` 的 `intensity()` 函数体内没有正则字面量，满足该前提。
 */
function findMatchingBrace(source: string, openIndex: number): number | null {
  let depth = 0;
  let state: 'code' | 'sq' | 'dq' | 'tpl' = 'code';
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (state === 'code') {
      if (char === "'") {
        state = 'sq';
        continue;
      }
      if (char === '"') {
        state = 'dq';
        continue;
      }
      if (char === '`') {
        state = 'tpl';
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
        continue;
      }
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (
      (state === 'sq' && char === "'") ||
      (state === 'dq' && char === '"') ||
      (state === 'tpl' && char === '`')
    ) {
      state = 'code';
    }
  }
  return null;
}

/**
 * 定位 `function <name>(` 的函数体（**按花括号配对**，不是按行尾）。
 *
 * ⚠️ 找不到、或只有声明没有实现（`;` 收尾）⇒ 返回 `null`
 *   ⇒ 上层据此判定「没扫到」⇒ **必须让它红**，不能当成「通过」。
 *
 * @param source 已剥注释的源码
 * @param functionName 函数名
 */
export function findFunctionBody(source: string, functionName: string): FunctionBodyRange | null {
  const pattern = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (match === null) {
    return null;
  }
  const signatureStart = match.index;
  // ⚠️ 从 `(` **之后**开始 ⇒ 参数列表的括号深度是 1
  let depth = 1;
  let bodyStart = -1;
  for (let index = signatureStart + match[0].length; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === ';') {
      return null; // 只有声明、没有实现
    }
    if (char === '{') {
      bodyStart = index;
      break;
    }
  }
  if (bodyStart < 0) {
    return null;
  }
  const bodyEnd = findMatchingBrace(source, bodyStart);
  if (bodyEnd === null) {
    return null;
  }
  return { signatureStart, bodyStart, bodyEnd };
}

/**
 * 取一次调用的**第一个实参**（原文，去首尾空白）。
 *
 * ⚠️ 按「第一个**顶层**逗号」切分 ⇒ `Math.min(1, Math.exp(...))` 的第一个实参是 `1`，
 *   而不是 `1, Math.exp(...)`。
 *
 * @param source 源码（调用点所在的那份文本）
 * @param openParen 左括号 `(` 的下标
 */
export function firstArgumentOfCall(source: string, openParen: number): string | null {
  let depth = 0;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParen + 1, index).trim();
      }
      continue;
    }
    if (char === ',' && depth === 1) {
      return source.slice(openParen + 1, index).trim();
    }
  }
  return null;
}

/** `Math.max(` / `Math.min(` 的调用形态。 */
const CLAMP_CALL_PATTERN = /\bMath\s*\.\s*(max|min)\s*\(/g;

/**
 * 扫描 `intensity()` 函数体里的钳制调用。
 *
 * @param source 目标文件的**原始**源码（内部会先剥注释）
 */
export function scanClamps(source: string): ClampScanResult {
  const stripped = stripComments(source);
  const starts = lineStarts(stripped);
  const lines = stripped.split('\n');
  const body = findFunctionBody(stripped, TARGET_FUNCTION);

  if (body === null) {
    return {
      functionFound: false,
      bodyLines: null,
      hits: { max: [], min: [] },
      missing: [...REQUIRED_CLAMPS],
    };
  }

  const bodyText = stripped.slice(body.bodyStart + 1, body.bodyEnd);
  const hits: { max: ClampHit[]; min: ClampHit[] } = { max: [], min: [] };

  CLAMP_CALL_PATTERN.lastIndex = 0;
  let match = CLAMP_CALL_PATTERN.exec(bodyText);
  while (match !== null) {
    const method = match[1] === 'max' ? 'max' : 'min';
    const openParen = match.index + match[0].length - 1;
    const argument = firstArgumentOfCall(bodyText, openParen);
    if (argument !== null && argument !== '') {
      const absolute = body.bodyStart + 1 + match.index;
      const line = lineAt(starts, absolute);
      hits[method].push({
        line,
        argument,
        numeric: Number(argument),
        sourceLine: (lines[line - 1] ?? '').trim(),
      });
    }
    match = CLAMP_CALL_PATTERN.exec(bodyText);
  }

  const missing = REQUIRED_CLAMPS.filter(
    (spec) => !hits[spec.method].some((hit) => hit.numeric === spec.expectedArgument),
  );

  return {
    functionFound: true,
    bodyLines: {
      start: lineAt(starts, body.bodyStart),
      end: lineAt(starts, body.bodyEnd),
    },
    hits,
    missing,
  };
}

/** 主流程。 */
function main(): void {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const source = readFileSync(resolve(repoRoot, TARGET_FILE), 'utf8');
  const result = scanClamps(source);

  process.stdout.write('F-08 ③ 静态扫描守卫：intensity() 的两道钳制（§4.1）\n');

  // ── C31 自洽：期望条数必须与规格表一致（否则守卫的「分母」本身会漂）──
  if (REQUIRED_CLAMPS.length !== EXPECTED_REQUIRED_CLAMP_COUNT) {
    process.stderr.write(
      `\n✗ 规格表有 ${REQUIRED_CLAMPS.length} 条，但写死的期望是 ${EXPECTED_REQUIRED_CLAMP_COUNT} 条\n` +
        '  ⇒ 守卫的「分母」本身漂了（C31）⇒ 必须让它红\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`  目标文件：${TARGET_FILE}\n`);

  if (!result.functionFound) {
    process.stderr.write(`\n✗ 在 ${TARGET_FILE} 里定位不到 \`${TARGET_FUNCTION}()\` 的函数体\n`);
    process.stderr.write(
      '  ⇒ 这是「守卫失效」而不是「钳制合规」⇒ 必须让它红\n' +
        '    （否则把整个 intensity() 删掉也会显示全绿）\n',
    );
    process.exitCode = 1;
    return;
  }

  const bodyLines = result.bodyLines;
  process.stdout.write(
    `  目标函数：${TARGET_FUNCTION}()（函数体 第 ${bodyLines?.start ?? 0}-${bodyLines?.end ?? 0} 行）\n`,
  );

  for (const spec of REQUIRED_CLAMPS) {
    const hit = result.hits[spec.method].find((item) => item.numeric === spec.expectedArgument);
    if (hit === undefined) {
      process.stdout.write(
        `  缺失：Math.${spec.method}(${spec.expectedArgument}, …)  —— ${spec.label}\n`,
      );
    } else {
      process.stdout.write(
        `  已找到：Math.${spec.method}(${spec.expectedArgument}, …) @ 第 ${hit.line} 行  —— ${spec.label}\n`,
      );
    }
  }

  if (result.missing.length > 0) {
    process.stderr.write(
      `\n✗ ${TARGET_FILE} 的 ${TARGET_FUNCTION}() 缺少 ${result.missing.length} 道钳制：\n`,
    );
    for (const spec of result.missing) {
      process.stderr.write(
        `    · Math.${spec.method}(${spec.expectedArgument}, …) —— ${spec.label}\n`,
      );
    }
    process.stderr.write(
      '    ⇒ §4.1 的两重防护缺一不可：① Δt = max(0, …) 防时钟回拨 / 注入过去时刻；② min(1, …) 防 τ → 0\n' +
        '    ⇒ 缺任一 ⇒ intensity 可能 > 1 ⇒ §4.4 层级判定错乱、§4.6 的 0.30 × intensity 越界\n' +
        '    ⇒ ⚠️ 这类漂移**行为层抓不到**（正常输入下两道钳制等价）⇒ 只能靠这条静态守卫\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ intensity() 的两道钳制同时存在（Δt 下钳 + 强度上钳）\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
