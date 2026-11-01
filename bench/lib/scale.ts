/**
 * **bench 的规模守卫** —— P2 收官 · Q-02。
 *
 * ⚠️ ★ **为什么要有这个模块**（DEVELOPMENT-PLAN.md 行 2068~2070 的硬断言
 *   「**规模写进验收行**」）：
 *   设计稿原文：「**规模必须写进验收行**：不写「100 万条」⇒ 实现者可能在小库上测得
 *   P99 达标就放行，而小库根本走不到分桶路径（`ROUTER_MIN_TRAINING`）⇒
 *   **那样的验收什么都没验到**。」
 *   ⇒ 也就是说：**「在小库上测出的数字」不是「小一点的验收」，而是「什么都没验」**。
 *   ⇒ 而 `bench/` 的默认 `--scale` 已经是 1 000 000 ⇒ **缺的不是默认值，是断言**：
 *     `--scale=1500` 能跑完、能落盘、退出码 0 ⇒ **等于「没验收也放行」**。
 *   ⇒ 本模块提供那个**缺的断言**：规模不达标 ⇒ **抛错 + 非零退出码**，**不落盘**。
 *
 * ⚠️ ★ **为什么默认必须是「拒绝」**：
 *   落盘的基线是「数字的出处」（`docs/baseline/README.md` 的定位）⇒
 *   一个 1500 条的基线一旦落进 `docs/baseline/`，就会被后来的报告当成「验收过的数字」。
 *   ⇒ ⇒ **默认拒绝**是唯一安全的默认值。
 *
 * ⚠️ ★ **降级开关 `--allow-small-scale` 为什么存在**（默认**关闭**）：
 *   · **存在理由**：冒烟 / 自检 / 工具链联调场景需要在**小规模**上**快速**跑一遍
 *     bench 脚本（否则每次自检都要灌 100 万条 + 训练 ≈ 5 小时 ⇒ 根本没法做）。
 *   · **为什么默认关闭**：小规模上**走不到分桶路径**（`ROUTER_MIN_TRAINING` = 1 万）
 *     ⇒ 小规模上的 P99 / 吻合率**什么也没验到** ⇒ 它**只能**当「工具跑得通」的自检，
 *     **不能**当「性能达标」的证据。
 *   · **怎么保证它不会被误当成验收结论**：落盘文件名**带规模数字**
 *     （`perf-1500.json` vs `perf-1000000.json`）⇒ 规模写在**文件名**里，
 *     一眼可辨；且契约测试（`tests/bench/baseline-scale.test.ts`）只对
 *     **文件名带 `1000000`** 的基线断言「规模 ≥ 100 万」。
 */

/**
 * **性能基线的最小语料规模**（= 设计稿验收行里的「100 万条」）。
 *
 * ⚠️ **这是唯一的下限出处**（bench 脚本与契约测试都从这里取）。
 *   ⇒ 但契约测试里**另有一份写死的字面量**（1_000_000）⇒
 *     「改实现常量」不能把「契约」一起改弱（见该测试文件的说明）。
 */
export const MIN_BENCH_CORPUS_SIZE = 1_000_000;

/** 降级开关的**命令行参数名**（`--allow-small-scale` ⇒ 值 `'true'`）。 */
export const ALLOW_SMALL_SCALE_FLAG = 'allow-small-scale';

/**
 * 规模守卫的**判定结果**。
 */
export interface ScaleCheck {
  /** 本次实测的语料规模。 */
  readonly scale: number;
  /** **规模本身**是否达标（`scale ≥ MIN_BENCH_CORPUS_SIZE`）。 */
  readonly ok: boolean;
  /**
   * **是否允许继续**（= 达标 **或** 显式开了降级开关）。
   *
   * ⚠️ **与 `ok` 分开**是刻意的：`ok` 回答「规模达标了吗」（事实），
   *   `allowed` 回答「能不能继续跑」（决策）⇒ 降级跑出来的结果
   *   **`ok` 仍是 `false`** ⇒ 报告里能看出「这是降级跑出来的」。
   */
  readonly allowed: boolean;
  /** 是否走了**降级开关**（`true` ⇒ 小规模是被显式放行的）。 */
  readonly downgraded: boolean;
  /** 人类可读的理由（**进报告 / 进错误信息**）。 */
  readonly reason: string;
}

/**
 * **规模不达标**时抛的错（**专门一类** ⇒ 调用方能只 catch 这一类）。
 *
 * ⚠️ **为什么单独一类**：bench 脚本的 `main()` 靠它区分
 *   「规模不够（用户忘了加开关）」与「真的跑挂了（真 bug）」。
 */
export class BenchScaleError extends Error {
  /** 当时的规模。 */
  readonly scale: number;

  /** 当时的下限。 */
  readonly minimum: number;

  /**
   * @param scale 本次规模
   * @param minimum 下限
   * @param message 错误信息
   */
  constructor(scale: number, minimum: number, message: string) {
    super(message);
    this.name = 'BenchScaleError';
    this.scale = scale;
    this.minimum = minimum;
  }
}

/**
 * 判一次规模（**不抛错** ⇒ 可用于测试与「先判后跑」的两段式）。
 *
 * @param scale 本次语料规模
 * @param allowSmallScale 是否开了降级开关（**默认 `false` ⇒ 默认拒绝**）
 * @returns 判定结果
 */
export function checkBenchScale(scale: number, allowSmallScale = false): ScaleCheck {
  const ok = Number.isFinite(scale) && scale >= MIN_BENCH_CORPUS_SIZE;
  if (ok) {
    return {
      scale,
      ok: true,
      allowed: true,
      downgraded: false,
      reason: `规模 ${scale} ≥ 下限 ${MIN_BENCH_CORPUS_SIZE} ⇒ 达标`,
    };
  }
  const reason =
    `规模 ${scale} < 下限 ${MIN_BENCH_CORPUS_SIZE}` +
    '（小库走不到分桶路径 ⇒ 在小库上测得的 P99 / 吻合率**什么也没验到**）';
  return {
    scale,
    ok: false,
    allowed: allowSmallScale,
    downgraded: allowSmallScale,
    reason: allowSmallScale
      ? `${reason} ⇒ **已显式降级**（--${ALLOW_SMALL_SCALE_FLAG}）⇒ 该结果只能当「工具跑得通」的自检`
      : reason,
  };
}

/**
 * 判一次规模（**不达标就抛错**）。
 *
 * ⚠️ **抛错 ⇒ 调用方必须处理**（不许静默吞掉）⇒
 *   bench 脚本的 `main()` 捕获它 ⇒ 写错误信息 ⇒ **置非零退出码** ⇒ **不落盘**。
 *
 * @param scale 本次语料规模
 * @param allowSmallScale 是否开了降级开关（**默认 `false` ⇒ 默认拒绝**）
 * @returns 判定结果（**达标或已降级时**返回）
 * @throws {BenchScaleError} 规模不达标且未开降级开关
 */
export function assertBenchScale(scale: number, allowSmallScale = false): ScaleCheck {
  const check = checkBenchScale(scale, allowSmallScale);
  if (!check.allowed) {
    throw new BenchScaleError(
      scale,
      MIN_BENCH_CORPUS_SIZE,
      `bench 规模守卫：${check.reason}。` +
        '⇒ 落盘的基线会被当成「验收过的数字」⇒ **拒绝落盘**。' +
        `若确属冒烟/自检，请显式加 --${ALLOW_SMALL_SCALE_FLAG}（默认关闭）。`,
    );
  }
  return check;
}

/**
 * 从**已解析的命令行参数**里读降级开关（`--allow-small-scale` ⇒ `'true'`）。
 *
 * ⚠️ **只认 `'true'`**：`--allow-small-scale=false` ⇒ 不降级。
 *   ⇒ 「开关必须**显式**打开」⇒ 少写一个字母不会意外放行。
 *
 * @param args 已解析的参数（`parseArgs` 的产物）
 * @returns 是否降级
 */
export function allowSmallScaleFromArgs(args: Record<string, string>): boolean {
  return args[ALLOW_SMALL_SCALE_FLAG] === 'true';
}

/**
 * ★ **在 bench 脚本的 `main()` 开头调一次**（规模守卫的**唯一入口**）。
 *
 * ⚠️ **不达标时它做三件事**（**不是「只打印警告」**）：
 *   1. 往 `stderr` 写**明确的错误信息**（含规模、下限、补救办法）；
 *   2. **置非零退出码**（`process.exitCode = 1`）⇒ CI / 脚本能判红；
 *   3. 返回 `allowed === false` ⇒ **调用方必须立刻 `return`** ⇒ **绝不落盘**。
 *      （落盘的基线是「数字的出处」⇒ 一个 1500 条的基线落进去，
 *       就会被后来的报告当成「验收过的数字」⇒ **必须挡住**。）
 *
 * @param args 已解析的命令行参数
 * @param scale 本次语料规模
 * @returns 判定结果（`allowed === false` ⇒ **调用方必须停止，且不得落盘**）
 */
export function enforceBenchScale(args: Record<string, string>, scale: number): ScaleCheck {
  const allowSmallScale = allowSmallScaleFromArgs(args);
  try {
    return assertBenchScale(scale, allowSmallScale);
  } catch (error) {
    if (error instanceof BenchScaleError) {
      process.stderr.write(`\n✗ bench 规模守卫未通过：\n    ${error.message}\n\n`);
      process.exitCode = 1;
      return {
        scale,
        ok: false,
        allowed: false,
        downgraded: false,
        reason: error.message,
      };
    }
    throw error;
  }
}
