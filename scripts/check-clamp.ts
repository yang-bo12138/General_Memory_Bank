#!/usr/bin/env tsx
/**
 * F-08 ③：`intensity()` 的两道钳制的**静态守卫** —— DESIGN-v2.md §4.1。
 *
 * ⚠️ **为什么必须是静态扫描（行为层无解）**：
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
 * ⚠️★ **光验「模式存在」不够 —— 还要验「那道钳制还在原地、还在钳制对的那个东西」**：
 *   只验「函数体内存在某个 `Math.max(0, …)`」有一条**现成的绕过路径**：
 *     ```
 *     const elapsedMs = resolveNow(now) - memory.last_access;  // ← 钳制被删
 *     const unrelated = Math.max(0, 42);                       // ← 补一个无关的
 *     return Math.min(1, Math.exp(-elapsedMs / tauMs));
 *     ```
 *   ⇒ 存在性检查照样通过 ⇒ 守卫就松了。
 *   ⇒ 故本脚本在「首参」判据之外，**再做一层数据流判据**：
 *     ① 「强度上钳」必须夹住的那个表达式里**确实有** `Math.exp(…)`；
 *     ② 「Δt 下钳」必须在**那个 exp 的数据流上**——要么它就写在 exp 的实参里，
 *        要么它夹住的标识符被 exp 的实参引用。
 *   ⚠️ **为什么不用「第二个实参里必须出现 `last_access`」这种 token 判据**：
 *     `const deltaMs = resolveNow(now) - memory.last_access;` 再 `Math.max(0, deltaMs)`
 *     ⇒ 第二个实参里**没有** `last_access` ⇒ token 判据会**误报**。
 *   ⇒ 数据流判据既能堵住绕过，又不会误报这种等价写法。
 *
 * ⚠️ **「没扫到」必须判红，不能判过**：
 *   若 `intensity()` 被改名 / 被删掉，本脚本找不到函数体 ⇒ 那是「守卫失效」，
 *   不是「钳制合规」⇒ 必须 exit 1（否则删掉整个函数也会显示全绿）。
 *
 * ⚠️ **「钳制被提取成辅助函数」也会判红（这是有意的）**：
 *   若有人把 `Math.max(0, …)` / `Math.min(1, …)` 提取成 `clampDelta()` 之类的辅助函数，
 *   钳制**事实上还在**，但已不在 `intensity()` 的函数体里 ⇒ 本守卫判缺。
 *   ⇒ 这是**故意**的：提取会让「§4.1 的两重防护就位在 intensity 里」变成一条**间接约定**，
 *     而间接约定正是漂移的来源 ⇒ 要改就得**显式**改守卫（人过一遍），不能默默绕过。
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
  /** 缺失的钳制（规格）—— 连调用都不存在。 */
  readonly missing: readonly ClampSpec[];
  /**
   * 「存在但没生效」的钳制（规格）—— 调用在，但**不作用在正确的量上**。
   *
   * ⚠️ 与 `missing` 分开报：前者是「写都没写」，后者是「写了但白写」——
   *   后者正是「删掉钳制 + 补一个无关的同形态调用」这种绕过的特征。
   */
  readonly unguarded: readonly ClampSpec[];
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
 * 取一次调用的**全部实参**（按**顶层**逗号切分）。
 *
 * ⚠️ 顶层 = 不在任何嵌套括号里 ⇒ `Math.min(1, Math.exp(-a / b))` 的实参是
 *   `['1', 'Math.exp(-a / b)']`（不是把内层的逗号也算进去）。
 *
 * @param source 源码（调用点所在的那份文本）
 * @param openParen 左括号 `(` 的下标
 */
export function argumentsOfCall(source: string, openParen: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = openParen + 1;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(source.slice(current, index).trim());
        return args;
      }
      continue;
    }
    if (char === ',' && depth === 1) {
      args.push(source.slice(current, index).trim());
      current = index + 1;
    }
  }
  return args;
}

/**
 * 取一次调用的**第一个实参**（原文，去首尾空白）。
 *
 * @param source 源码
 * @param openParen 左括号 `(` 的下标
 */
export function firstArgumentOfCall(source: string, openParen: number): string | null {
  return argumentsOfCall(source, openParen)[0] ?? null;
}

/** 一次 `Math.max` / `Math.min` / `Math.exp` 调用。 */
export interface MathCall {
  /** 方法名。 */
  readonly method: 'max' | 'min' | 'exp';
  /** 相对传入文本的起始偏移。 */
  readonly start: number;
  /** 第一个实参（`exp` 只有一个实参 ⇒ 就是它的实参）。 */
  readonly firstArgument: string;
  /** 第二个实参；`exp` 没有第二个实参 ⇒ `null`。 */
  readonly secondArgument: string | null;
}

/** `Math.max(` / `Math.min(` / `Math.exp(` 的调用形态。 */
const MATH_CALL_PATTERN = /\bMath\s*\.\s*(max|min|exp)\s*\(/g;

/**
 * 找出文本里的 `Math.max` / `Math.min` / `Math.exp` 调用。
 *
 * @param text 要扫的文本（**已剥注释**）
 */
export function findMathCalls(text: string): MathCall[] {
  const calls: MathCall[] = [];
  MATH_CALL_PATTERN.lastIndex = 0;
  let match = MATH_CALL_PATTERN.exec(text);
  while (match !== null) {
    const raw = match[1] ?? '';
    const method: 'max' | 'min' | 'exp' = raw === 'max' ? 'max' : raw === 'min' ? 'min' : 'exp';
    const openParen = match.index + match[0].length - 1;
    const args = argumentsOfCall(text, openParen);
    const first = args[0];
    if (first !== undefined && first !== '') {
      calls.push({
        method,
        start: match.index,
        firstArgument: first,
        secondArgument: args[1] ?? null,
      });
    }
    match = MATH_CALL_PATTERN.exec(text);
  }
  return calls;
}

/** 赋值语句（`const X = …;` / `let` / `var`）。 */
const ASSIGNMENT_PATTERN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*);/g;

/** 正则元字符转义（标识符要拿去做 `\b` 边界匹配）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 「被 `Math.max(0, …)` 夹住」的标识符集合。
 *
 * ⚠️ 例如 `const elapsedMs = Math.max(0, …);` ⇒ 集合里有 `elapsedMs`。
 *   ⇒ 它就是「Δt 下钳」的产物，后面用数据流把它和 `exp(...)` 接上。
 */
function identifiersGuardedByMax(bodyText: string): Set<string> {
  const guarded = new Set<string>();
  ASSIGNMENT_PATTERN.lastIndex = 0;
  let match = ASSIGNMENT_PATTERN.exec(bodyText);
  while (match !== null) {
    const name = match[1] ?? '';
    const expression = match[2] ?? '';
    const hasZeroMax = findMathCalls(expression).some(
      (call) => call.method === 'max' && Number(call.firstArgument) === 0,
    );
    if (hasZeroMax && name !== '') {
      guarded.add(name);
    }
    match = ASSIGNMENT_PATTERN.exec(bodyText);
  }
  return guarded;
}

/**
 * 「被 `Math.min(1, …)` 夹住的那个 `Math.exp(…)`」的实参文本。
 *
 * ⚠️ 空数组 ⇒ **没有任何** `Math.min(1, …)` 夹住指数 ⇒ 强度上钳没生效。
 */
function expArgumentsGuardedByMin(bodyText: string): string[] {
  const result: string[] = [];
  for (const call of findMathCalls(bodyText)) {
    if (call.method !== 'min' || Number(call.firstArgument) !== 1) {
      continue;
    }
    const second = call.secondArgument;
    if (second === null) {
      continue;
    }
    for (const expCall of findMathCalls(second)) {
      if (expCall.method === 'exp') {
        result.push(expCall.firstArgument);
      }
    }
  }
  return result;
}

/**
 * 「Δt 下钳」是否**真的在数据流上**。
 *
 * 两种算数：
 * ① `Math.max(0, …)` 就**写在** exp 的实参里（内联写法）；
 * ② exp 的实参**引用**了某个「被 `Math.max(0, …)` 赋值」的标识符。
 *
 * ⚠️ ② 这一支是「中间变量」写法的通行证：
 *   `const deltaMs = …; const elapsedMs = Math.max(0, deltaMs);` ⇒ exp 用的是 `elapsedMs`
 *   ⇒ 它在数据流上 ✓（而「第二个实参里必须出现 `last_access`」那种 token 判据会误报）。
 */
function isMaxClampInDataFlow(
  expArguments: readonly string[],
  guardedIdentifiers: ReadonlySet<string>,
): boolean {
  for (const expArgument of expArguments) {
    const inline = findMathCalls(expArgument).some(
      (call) => call.method === 'max' && Number(call.firstArgument) === 0,
    );
    if (inline) {
      return true;
    }
    for (const name of guardedIdentifiers) {
      if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(expArgument)) {
        return true;
      }
    }
  }
  return false;
}

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
      unguarded: [],
    };
  }

  const bodyText = stripped.slice(body.bodyStart + 1, body.bodyEnd);
  const hits: { max: ClampHit[]; min: ClampHit[] } = { max: [], min: [] };

  for (const call of findMathCalls(bodyText)) {
    if (call.method === 'exp') {
      continue;
    }
    const absolute = body.bodyStart + 1 + call.start;
    const line = lineAt(starts, absolute);
    hits[call.method].push({
      line,
      argument: call.firstArgument,
      numeric: Number(call.firstArgument),
      sourceLine: (lines[line - 1] ?? '').trim(),
    });
  }

  const missing = REQUIRED_CLAMPS.filter(
    (spec) => !hits[spec.method].some((hit) => hit.numeric === spec.expectedArgument),
  );

  // ── 数据流判据：钳制「存在」之外，还必须「作用在正确的量上」──
  const expArguments = expArgumentsGuardedByMin(bodyText);
  const guardedIdentifiers = identifiersGuardedByMax(bodyText);
  const unguarded = REQUIRED_CLAMPS.filter((spec) => {
    if (missing.includes(spec)) {
      return false; // 连调用都没有 ⇒ 归 `missing` 管
    }
    if (spec.method === 'min') {
      // 强度上钳必须夹住的那个表达式里**确实有** `Math.exp(…)`
      return expArguments.length === 0;
    }
    // Δt 下钳必须在那个 exp 的数据流上
    return !isMaxClampInDataFlow(expArguments, guardedIdentifiers);
  });

  return {
    functionFound: true,
    bodyLines: {
      start: lineAt(starts, body.bodyStart),
      end: lineAt(starts, body.bodyEnd),
    },
    hits,
    missing,
    unguarded,
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
    const isUnguarded = result.unguarded.includes(spec);
    if (hit === undefined) {
      process.stdout.write(
        `  缺失：Math.${spec.method}(${spec.expectedArgument}, …)  —— ${spec.label}\n`,
      );
    } else if (isUnguarded) {
      process.stdout.write(
        `  存在但未生效：Math.${spec.method}(${spec.expectedArgument}, …) @ 第 ${hit.line} 行  —— ${spec.label}\n`,
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

  if (result.unguarded.length > 0) {
    process.stderr.write(
      `\n✗ ${TARGET_FILE} 的 ${TARGET_FUNCTION}() 有 ${result.unguarded.length} 道钳制**存在但没生效**：\n`,
    );
    for (const spec of result.unguarded) {
      process.stderr.write(
        `    · Math.${spec.method}(${spec.expectedArgument}, …) —— ${spec.label}\n`,
      );
    }
    process.stderr.write(
      '    ⇒ 守卫验的**不只是「模式存在」**，还验「那道钳制还在原地、还在钳制对的那个东西」\n' +
        '    ⇒ 典型绕过：删掉真钳制，再补一个**无关的**同形态调用 ⇒ 存在性检查照样通过\n' +
        '    ⇒ 判据：强度上钳必须夹住 `Math.exp(…)`；Δt 下钳必须在那个 exp 的数据流上\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n✓ intensity() 的两道钳制同时存在，且都作用在正确的量上\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
