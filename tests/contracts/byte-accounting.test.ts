/**
 * 落盘字节凭据的**自洽性**契约测试 —— `docs/evidence/t07-warm.json`。
 *
 * ⚠️ ★★ **这条测试守的是什么（★ 不是「数字对不对」，是「字节账自不自洽」）**：
 *   `docs/evidence/t07-warm.json` 是 H1′ 字节判据的**唯一原始凭据**（**已被 git 跟踪** ⇒ CI 上有）
 *   ⇒ ⇒ 万一它被手改、或 `toCountSummary` 那套统计实现被改坏 ⇒ ⇒
 *   **落盘数字会变，而链上没有任何东西会发现** ⇒ ⇒ **判据会悄悄失真** ⇒ ⇒ **这就是假绿**。
 *   ⇒ ⇒ 本文件补的就是这条：**对着【已落盘的 JSON】复算它的字节账恒等式**。
 *
 * ★ **与 bench 侧那几条断言的区别（别混淆）**：
 *   bench 侧（`tests/bench/t06-byte-metering.test.ts`）已经**逐样本**钉死了恒等式
 *   ⇒ 那守的是「**采集时**字节账是自洽的」；
 *   ⇒ 而本文件守的是「**落盘物**本身仍然自洽」⇒ ⇒ **两者不重叠、缺一不可**。
 *
 * ⚠️ ★★ **【可复算的只有三层】—— 这条测试的判据来源（★ 别越界断言）**：
 *   字节恒等式是 `bytesRead = 码行数 × 768 B + embedding 行数 × 3,072 B`。
 *   ★ **落盘物只有【分布】、没有【逐样本数组】** ⇒ ⇒ 于是：
 *   · **【分量层】**：`codeBytes[stat] == codeRowsRead[stat] × 768`（每个 stat 逐档）⇒ **恒成立**
 *     （★ 768 / 3,072 是常量 ⇒ 线性 ⇒ 逐样本恒等式直接推出逐档恒等式 ⇒ **与样本是否同源无关**）；
 *   · **【和层 · mean】**：`bytesRead.mean == codeBytes.mean + embeddingBytes.mean` ⇒ **恒成立**
 *     （★ 线性 ⇒ 跨样本严格相等）；
 *   · **【和层 · 分位（p50 / p99 / max）】** ⇒ ★ **不恒成立** ⇒ ★ **因为各分量的分位
 *     来自【不同样本】** ⇒ ⇒ **跨样本相加 ≠ 逐样本相加**。
 *     ⇒ ⇒ ★ **举例（机制说明 · 不写死数字）**：读路径那两个 `max` 不在同一条样本上
 *     ⇒ ⇒ 把它们相加得到的数【不等于】真正那条最坏样本的 `bytesRead.max`
 *     ⇒ ⇒ 而且**分解还不唯一**（一个字节数可拆成多组「码行 + embedding 行」的组合）
 *     ⇒ ⇒ ★ **所以【和层 max】绝不许断言** ⇒ **断言它 ⇒ 读路径必假红**。
 *
 * ⚠️ ★★ **两个「embedding 行数」是两个不同的口径（★ 本文件最容易踩的坑）**：
 *   · **顶层 `memoryRowsRead`** = **物化出来的行数**（★ 进字节账的就是它）；
 *   · `breakdown.embeddingRowsRead` = **精确分返回行数**（`scoreOf` 的 `get()` 返回了行的次数）。
 *   ⇒ ⇒ 它们**当前落盘数据里逐位相同**，★ **但那只是因为当前场景下没有「白调用」**
 *   （`get()` 返回 `undefined` 的行）⇒ ⇒ **一旦出现白调用，两者就会分叉**。
 *   ⇒ ⇒ ★ **所以：字节账恒等式必须用【顶层 `memoryRowsRead`】**
 *   ⇒ ⇒ ★ **且【不许断言这两个字段相等】** —— 那是把一个当前的巧合钉成不变式
 *   ⇒ ⇒ ⇒ **将来一出现白调用就假红** ⇒ ⇒ 正确做法是**只在注释里记这个陷阱**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** 仓库根（照搬 `tests/contracts/audit-negative-control.test.ts` 的写法）。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** H1′ 字节判据的**唯一原始凭据**（★ 已被 git 跟踪 ⇒ CI 上有）。 */
const EVIDENCE_PATH = join(REPO_ROOT, 'docs/evidence/t07-warm.json');

/** 一个 int8 码的字节数（★ 常量 · 不是实测值）。 */
const CODE_BYTES = 768;
/** 一个 float32 embedding 的字节数（★ 常量 · 不是实测值）。 */
const EMBEDDING_BYTES = 3072;
/** 浮点容差（★ 分量 mean 层实测残差在 1e-10 量级 ⇒ 取 1e-6 足够宽、又不宽到放过分量漂移）。 */
const TOLERANCE = 1e-6;

/** 分布里的每一个统计量（★ `count` 单独处理）。 */
const STATS = ['min', 'mean', 'p50', 'p99', 'max'] as const;

/** 一份分布的形状（★ 只取本测试要用的字段）。 */
interface CountSummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p99: number;
  max: number;
}

/** `vectorByteReads` 的形状（★ 只取本测试要用的字段）。 */
interface VectorByteReads {
  memoryRowsRead: CountSummary;
  codeRowsRead: CountSummary;
  bytesRead: CountSummary;
  breakdown: {
    codeBytes: CountSummary;
    embeddingBytes: CountSummary;
  };
}

/** 落盘 JSON 的形状（★ 只取本测试要用的字段）。 */
interface Evidence {
  writeSegments?: { vectorByteReads?: VectorByteReads };
  vectorRouteByteReads?: VectorByteReads;
}

/** 一条失败明细。 */
interface Failure {
  /** 哪一路（写 / 读）。 */
  path: string;
  /** 哪条判据。 */
  rule: string;
  /** 期望值与实际值的描述（★ 不写死具体数字 · 只说「哪个 stat 不等」）。 */
  detail: string;
}

/**
 * ★ **判定用的纯函数**（⇒ 负控可以喂合成数据 ⇒ 它自己也不是恒绿守卫）。
 *
 * @param label 这一路的标签（写 / 读）
 * @param reads 这一路的读数
 * @param options 是否断言「和层 p50」（★ 写路径不成立 ⇒ 由调用方决定）
 * @returns 失败明细列表（★ 空数组 ⇒ 自洽）
 */
function checkByteAccounting(
  label: string,
  reads: VectorByteReads,
  options: { assertSumP50: boolean } = { assertSumP50: false },
): readonly Failure[] {
  const failures: Failure[] = [];
  const { breakdown } = reads;

  // ── ① 分量层：码字节 = 码行数 × 每码字节数（★ 逐 stat）──
  for (const stat of STATS) {
    const expected = reads.codeRowsRead[stat] * CODE_BYTES;
    if (!nearly(breakdown.codeBytes[stat], expected)) {
      failures.push({
        path: label,
        rule: '分量层 · 码字节',
        detail: `codeBytes.${stat} ≠ codeRowsRead.${stat} × ${CODE_BYTES}`,
      });
    }
  }

  // ── ② 分量层：embedding 字节 = 物化行数 × 每行字节数（★ 用【顶层 memoryRowsRead】）──
  for (const stat of STATS) {
    const expected = reads.memoryRowsRead[stat] * EMBEDDING_BYTES;
    if (!nearly(breakdown.embeddingBytes[stat], expected)) {
      failures.push({
        path: label,
        rule: '分量层 · embedding 字节',
        detail: `embeddingBytes.${stat} ≠ memoryRowsRead.${stat} × ${EMBEDDING_BYTES}`,
      });
    }
  }

  // ── ③ 样本数：分量层与和层必须同批（★ 否则是拿两批样本对账）──
  if (breakdown.codeBytes.count !== reads.bytesRead.count) {
    failures.push({
      path: label,
      rule: '样本数 · 分量 vs 和',
      detail: 'codeBytes.count ≠ bytesRead.count',
    });
  }
  if (breakdown.embeddingBytes.count !== reads.bytesRead.count) {
    failures.push({
      path: label,
      rule: '样本数 · 分量 vs 和',
      detail: 'embeddingBytes.count ≠ bytesRead.count',
    });
  }

  // ── ④ 和层 · mean（★ 线性 ⇒ 跨样本严格相等 ⇒ 恒成立）──
  const expectedMean = breakdown.codeBytes.mean + breakdown.embeddingBytes.mean;
  if (!nearly(reads.bytesRead.mean, expectedMean)) {
    failures.push({
      path: label,
      rule: '和层 · mean',
      detail: 'bytesRead.mean ≠ codeBytes.mean + embeddingBytes.mean',
    });
  }

  // ── ⑤ 和层 · p50（★ ⚠️ 只对【分位恰好同源】的那一路成立 ⇒ 由调用方决定要不要断言）──
  if (options.assertSumP50) {
    const expectedP50 = breakdown.codeBytes.p50 + breakdown.embeddingBytes.p50;
    if (!nearly(reads.bytesRead.p50, expectedP50)) {
      failures.push({
        path: label,
        rule: '和层 · p50',
        detail: 'bytesRead.p50 ≠ codeBytes.p50 + embeddingBytes.p50',
      });
    }
  }

  // ★ **【和层 · max / p99】故意【不断言】** ——
  //   各分量的 max 来自不同样本 ⇒ 跨样本相加 ≠ 逐样本相加 ⇒ 断言它必然假红。
  //   ⇒ 详见文件头「可复算的只有三层」那段。

  return failures;
}

/** ★ **带容差的相等**（★ mean 层有浮点残差 ⇒ 绝不用 `toBe`）。 */
function nearly(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < TOLERANCE;
}

/** 读真实的落盘凭据。 */
function readEvidence(): Evidence {
  return JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as Evidence;
}

/** 造一份「全对」的读数（★ 用作负控的基底）。 */
function syntheticReads(): VectorByteReads {
  const summary = (
    count: number,
    min: number,
    mean: number,
    p50: number,
    p99: number,
    max: number,
  ): CountSummary => ({
    count,
    min,
    mean,
    p50,
    p99,
    max,
  });
  const codeRowsRead = summary(200, 100, 200, 200, 300, 300);
  const memoryRowsRead = summary(200, 0, 1, 1, 2, 2);
  return {
    memoryRowsRead,
    codeRowsRead,
    bytesRead: summary(
      200,
      codeRowsRead.min * CODE_BYTES,
      codeRowsRead.mean * CODE_BYTES + memoryRowsRead.mean * EMBEDDING_BYTES,
      codeRowsRead.p50 * CODE_BYTES,
      codeRowsRead.p99 * CODE_BYTES,
      codeRowsRead.max * CODE_BYTES,
    ),
    breakdown: {
      codeBytes: summary(
        200,
        codeRowsRead.min * CODE_BYTES,
        codeRowsRead.mean * CODE_BYTES,
        codeRowsRead.p50 * CODE_BYTES,
        codeRowsRead.p99 * CODE_BYTES,
        codeRowsRead.max * CODE_BYTES,
      ),
      embeddingBytes: summary(
        200,
        memoryRowsRead.min * EMBEDDING_BYTES,
        memoryRowsRead.mean * EMBEDDING_BYTES,
        memoryRowsRead.p50 * EMBEDDING_BYTES,
        memoryRowsRead.p99 * EMBEDDING_BYTES,
        memoryRowsRead.max * EMBEDDING_BYTES,
      ),
    },
  };
}

describe('落盘字节凭据的自洽性（docs/evidence/t07-warm.json）', () => {
  const evidence = readEvidence();
  const writeReads = evidence.writeSegments?.vectorByteReads;
  const readReads = evidence.vectorRouteByteReads;

  it('★ 凭据文件存在且两路都在（★ 缺一路 ⇒ 下面的断言会 vacuous 通过）', () => {
    expect(writeReads).toBeDefined();
    expect(readReads).toBeDefined();
  });

  it('★ 写路径：字节账自洽（★ 分量层逐 stat + 和层 mean）', () => {
    expect(writeReads).toBeDefined();
    if (writeReads === undefined) {
      return;
    }
    const failures = checkByteAccounting('写路径', writeReads, { assertSumP50: false });
    expect(failures).toEqual([]);
  });

  it('★ 读路径：字节账自洽（★ 分量层逐 stat + 和层 mean + 和层 p50）', () => {
    expect(readReads).toBeDefined();
    if (readReads === undefined) {
      return;
    }
    // ★ 读路径的 p50 **恰好同源** ⇒ 和层 p50 成立 ⇒ 断言它（写路径不成立 ⇒ 那边不传）
    const failures = checkByteAccounting('读路径', readReads, { assertSumP50: true });
    expect(failures).toEqual([]);
  });

  it('★ 写路径【不】断言和层 p50（★ 它不同源 ⇒ 断言它必假红 ⇒ 所以压根不传这个开关）', () => {
    expect(writeReads).toBeDefined();
    if (writeReads === undefined) {
      return;
    }
    // ★ 这不是「断言它成立」，而是「断言我们【没有】去断言它」⇒ 防止后人顺手加回来
    const failures = checkByteAccounting('写路径', writeReads, { assertSumP50: false });
    expect(failures.filter((failure) => failure.rule === '和层 · p50')).toEqual([]);
  });
});

describe('★ 负控 —— 证明上面的判定【有牙】（★ 断言的是「判定不再通过」，不是「内容变了」）', () => {
  it('负控 ① · 改坏分量层的码字节 ⇒ 判定必须失败', () => {
    const reads = syntheticReads();
    const before = checkByteAccounting('夹具', reads);
    expect(before).toEqual([]);

    reads.breakdown.codeBytes.max += CODE_BYTES; // ★ 改一个分量
    const after = checkByteAccounting('夹具', reads);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((failure) => failure.rule === '分量层 · 码字节')).toBe(true);
  });

  it('负控 ② · 改坏和层的 mean ⇒ 判定必须失败', () => {
    const reads = syntheticReads();
    expect(checkByteAccounting('夹具', reads)).toEqual([]);

    reads.bytesRead.mean += EMBEDDING_BYTES; // ★ 改和层
    const after = checkByteAccounting('夹具', reads);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((failure) => failure.rule === '和层 · mean')).toBe(true);
  });

  it('负控 ③ · 两路混用（拿写路的 bytesRead 配读路的 breakdown）⇒ 判定必须失败', () => {
    const evidence = readEvidence();
    const writeReads = evidence.writeSegments?.vectorByteReads;
    const readReads = evidence.vectorRouteByteReads;
    expect(writeReads).toBeDefined();
    expect(readReads).toBeDefined();
    if (writeReads === undefined || readReads === undefined) {
      return;
    }

    // ★ 把两路拼在一起 ⇒ 分量层与和层不再同源 ⇒ 必须被判失败
    const mixed: VectorByteReads = {
      ...readReads,
      bytesRead: writeReads.bytesRead,
    };
    const failures = checkByteAccounting('混用', mixed);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('负控 ④ · 改坏样本数 ⇒ 判定必须失败（★ 防止拿两批样本对账）', () => {
    const reads = syntheticReads();
    expect(checkByteAccounting('夹具', reads)).toEqual([]);

    reads.breakdown.codeBytes.count += 1;
    const after = checkByteAccounting('夹具', reads);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((failure) => failure.rule === '样本数 · 分量 vs 和')).toBe(true);
  });
});

describe('★ 元断言 —— 本文件自己不许硬编码实测值', () => {
  it('★ 源码里不出现那批实测字节数（★ 期望值必须现算 ⇒ 重采后不需改断言）', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');

    // ★ **自指的坑**：要写的「不许出现的数字」本身就会出现在这个文件里
    //   ⇒ ⇒ 必须用拼接构造出来 ⇒ 否则这条断言会把自己判红。
    const forbidden = [
      ['4', '0', '6', '5', '7', '9', '2'].join(''), // 写路径 bytesRead.max
      ['7', '2', '3', '3', '7', '9', '2'].join(''), // 读路径 bytesRead.max
      ['5', '2', '8', '6'].join(''), // 写路径 codeRowsRead.max
      ['9', '2', '5', '1'].join(''), // 读路径 codeRowsRead.max
    ];

    for (const literal of forbidden) {
      expect(source).not.toContain(literal);
    }
  });

  it('★ 但常量（每码字节数 / 每行字节数）【必须】出现（★ 它们不是实测值）', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).toContain('CODE_BYTES = 768');
    expect(source).toContain('EMBEDDING_BYTES = 3072');
  });
});
