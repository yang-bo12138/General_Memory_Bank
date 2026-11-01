/**
 * ★ **规模契约测试** —— P2 收官 · Q-02（DEVELOPMENT-PLAN.md 行 2068~2070 的硬断言
 * 「**规模写进验收行**」）。
 *
 * ⚠️ ★ **这个文件测的是「验收项本身」**（不是 bench 的性能数字）：
 *   设计稿原文：「**规模必须写进验收行**：不写「100 万条」⇒ 实现者可能在小库上测得
 *   P99 达标就放行，而小库根本走不到分桶路径（`ROUTER_MIN_TRAINING`）⇒
 *   **那样的验收什么都没验到**。」
 *   ⇒ **缺的不是默认值**（`bench/corpus.ts` 的 `DEFAULT_CORPUS_SIZE` 本来就是 100 万），
 *     **缺的是「断言」** ⇒ 本文件就是那条断言的**落点**。
 *
 * ⚠️ **本文件在 verify 链里**（秒级 ⇒ 只读 JSON，不跑 bench）⇒
 *   ⇒ 「重测」与「守门」分离的设计**没有被破坏**（见 `tests/bench/bench-smoke.test.ts`）。
 *
 * ⚠️ ★ **两条断言各管一件事**（缺一不可）：
 *   ① **守卫的行为**：小规模**必须被拒绝**（默认拒绝 ⇒ 非零退出码 ⇒ 不落盘）
 *      ⇒ 守卫一旦被改弱（比如把下限从 100 万改成 100）⇒ 这里**立刻变红**。
 *   ② **落盘数据的契约**：**已经落盘**的百万级基线里记录的规模**必须真的是百万级**
 *      ⇒ 「报告里写的 100 万」与「跑的时候用的规模」**对得上**。
 *
 * ⚠️ ★ **方案裁决（方案 A）**：契约测试**只对文件名带 `1000000` 的 JSON** 断言
 *   「规模 ≥ 100 万」。
 *   ⇒ **为什么不写成「`docs/baseline/` 下所有 JSON 都必须 ≥ 100 万」**：
 *     库里还放着三份**1 万条**的基线（`perf-10000.json` / `agreement-10000.json` /
 *     `baseline-flat-10000.json`）—— 它们是**小规模参考数据**（用途：验证口径与工具链，
 *     不是验收结论）⇒ 那条断言会**一上来就红** ⇒ 而「让门禁一上来就红」不是修复，
 *     是**把欠账藏起来**。
 *   ⇒ **方案 A 的语义更准**：「**百万级基线的规模必须真的是百万级**」。
 *   ⇒ 同时**另加一条「文件名 ↔ 记录规模必须一致」**（对**所有** JSON 生效）⇒
 *     这样「拿 1500 条的结果冒充 `perf-1000000.json`」也会被抓住。
 *
 * ⚠️ ★ **阈值为什么在测试里另写一份字面量**（`1_000_000`），
 *   而不直接用 `MIN_BENCH_CORPUS_SIZE`：
 *   **契约不该由实现自己定义** ⇒ 改 `bench/lib/scale.ts` 的常量**不能**把契约一起改弱
 *   ⇒ 改常量 ⇒ ①（守卫行为）先变红 ⇒ 契约始终握在**人写下来的数字**手里。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BenchScaleError,
  MIN_BENCH_CORPUS_SIZE,
  allowSmallScaleFromArgs,
  assertBenchScale,
  checkBenchScale,
} from '../../bench/lib/scale.js';

/** 仓库根（`tests/bench/` ⇒ 上两层）。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 基线目录（**数字的出处**）。 */
const BASELINE_DIR = join(REPO_ROOT, 'docs', 'baseline');

/**
 * ★ **契约里写死的下限**（**不是**从实现 import 的 ⇒ 实现改了，契约不改）。
 */
const CONTRACT_MIN_SCALE = 1_000_000;

/** 基线 JSON 的最小形状（**只断本契约关心的字段** ⇒ 别的字段改了不会假红）。 */
interface BaselineJson {
  readonly corpusSize?: number;
  readonly trainedMembers?: number;
  readonly phases?: { readonly members?: number };
}

/**
 * 读 `docs/baseline/` 下的全部基线 JSON（**文件名 → 内容**）。
 *
 * @returns 基线 JSON 列表
 */
function readBaselineJson(): Array<{ file: string; json: BaselineJson }> {
  const files = readdirSync(BASELINE_DIR).filter(
    (name) => name.endsWith('.json') && name !== 'package.json',
  );
  return files.map((file) => {
    const content = readFileSync(join(BASELINE_DIR, file), 'utf8');
    return { file, json: JSON.parse(content) as BaselineJson };
  });
}

/**
 * 从基线文件名里取出**规模数字**（`perf-1000000.json` ⇒ `1000000`）。
 *
 * @param file 文件名
 * @returns 规模（**`null` ⇒ 文件名里没有规模**）
 */
function scaleOfFile(file: string): number | null {
  const matched = /-(\d+)\.json$/.exec(file);
  if (matched === null) {
    return null;
  }
  const parsed = Number(matched[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

describe('P2 收官 · Q-02 · 规模写进验收行（硬断言）', () => {
  // ══════════════ ① 守卫的行为（小规模必须被拒绝） ══════════════

  it('★ 规模下限本身是 100 万（改它 ⇒ 本文件立刻变红）', () => {
    expect(MIN_BENCH_CORPUS_SIZE).toBe(1_000_000);
  });

  it('★ 小规模**默认被拒绝**（`ok=false` 且 `allowed=false`）', () => {
    // ⚠️ **这些规模都必须被拒**：1500（冒烟规模）、1 万（库里那三份基线的规模）、
    //   99 万（**差一点点也不行** ⇒ 门槛是「≥ 100 万」不是「大概 100 万」）。
    for (const scale of [1, 1500, 10_000, 990_000, 999_999]) {
      const check = checkBenchScale(scale);
      expect(check.ok).toBe(false);
      expect(check.allowed).toBe(false);
      expect(check.downgraded).toBe(false);
    }
  });

  it('★ 百万级**被接受**（`ok=true` 且 `allowed=true`）', () => {
    for (const scale of [1_000_000, 1_000_001, 2_000_000]) {
      const check = checkBenchScale(scale);
      expect(check.ok).toBe(true);
      expect(check.allowed).toBe(true);
      expect(check.downgraded).toBe(false);
    }
  });

  it('★ 不达标 ⇒ **抛错**（`BenchScaleError`）⇒ 不是「只打印警告」', () => {
    expect(() => assertBenchScale(1500)).toThrow(BenchScaleError);
    expect(() => assertBenchScale(1500)).toThrow(/1_?000_?000|1000000/);
    // ⚠️ **达标 ⇒ 不抛**。
    expect(() => assertBenchScale(1_000_000)).not.toThrow();
  });

  it('★ 降级开关 `--allow-small-scale` 是**唯一**的放行路径（且必须显式写 `=true`）', () => {
    // ⚠️ **显式降级** ⇒ 放行，但 **`ok` 仍是 `false`**（报告里能看出这是降级跑出来的）。
    const downgraded = checkBenchScale(1500, true);
    expect(downgraded.allowed).toBe(true);
    expect(downgraded.downgraded).toBe(true);
    expect(downgraded.ok).toBe(false);
    expect(() => assertBenchScale(1500, true)).not.toThrow();

    // ⚠️ **开关必须显式打开**：不带参数 / 写成 `false` / 写成别的值 ⇒ 都不放行。
    expect(allowSmallScaleFromArgs({})).toBe(false);
    expect(allowSmallScaleFromArgs({ 'allow-small-scale': 'false' })).toBe(false);
    expect(allowSmallScaleFromArgs({ 'allow-small-scale': '1' })).toBe(false);
    expect(allowSmallScaleFromArgs({ 'allow-small-scale': 'true' })).toBe(true);
  });

  // ══════════════ ② 落盘数据的契约（百万级基线的规模必须真的是百万级） ══════════════

  it('★ **百万级基线确实存在**（防空转：没有百万级基线 ⇒ 上一条断言会「真空通过」）', () => {
    const millionFiles = readBaselineJson().filter(
      ({ file }) => scaleOfFile(file) === CONTRACT_MIN_SCALE,
    );
    expect(millionFiles.length).toBeGreaterThan(0);
  });

  it('★ **百万级基线里记录的规模 ≥ 100 万**（方案 A：只对文件名带 `1000000` 的断言）', () => {
    const millionFiles = readBaselineJson().filter(
      ({ file }) => scaleOfFile(file) === CONTRACT_MIN_SCALE,
    );
    for (const { file, json } of millionFiles) {
      expect(json.corpusSize, `${file} 的 corpusSize`).toBeGreaterThanOrEqual(CONTRACT_MIN_SCALE);
      // ⚠️ **更强的证据**：真正**训练过**的条数也必须是百万级
      //   （`corpusSize` 只是「跑的时候的规模参数」；`trainedMembers` 是「库里真的有多少条」）。
      if (json.trainedMembers !== undefined) {
        expect(json.trainedMembers, `${file} 的 trainedMembers`).toBeGreaterThanOrEqual(
          CONTRACT_MIN_SCALE,
        );
      }
      if (json.phases?.members !== undefined) {
        expect(json.phases.members, `${file} 的 phases.members`).toBeGreaterThanOrEqual(
          CONTRACT_MIN_SCALE,
        );
      }
    }
  });

  it('★ **文件名里的规模 ↔ 记录的规模必须一致**（防「拿小规模的结果冒充百万级」）', () => {
    for (const { file, json } of readBaselineJson()) {
      const fileScale = scaleOfFile(file);
      if (fileScale === null) {
        continue;
      }
      expect(json.corpusSize, `${file} 的 corpusSize 与文件名不一致`).toBe(fileScale);
    }
  });
});
