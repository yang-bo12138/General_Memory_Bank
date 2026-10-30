/**
 * 基线比对框架 —— ADR-21「关掉开关 = 与 v1.0 逐位一致」。
 *
 * ⚠️ **本阶段只建立骨架**：真正的「与 v1.0 逐位一致」需要 v1.0 参考实现或 golden 基线，
 *   而 **v1.0 代码不在本仓库**（DEVELOPMENT-PLAN.md D-10）⇒
 *   **本阶段的验收是「比对机制可用」，不是「基线已达成」**。
 *   真正的基线达成点在 **P1-T09 末**（记忆本体十方法齐备后），并在 P3-T06、P4-T07 再验两次。
 *
 * ⚠️ **比对的纪律**（C30）：「逐位相同」是**硬断言**（算错），
 *   「漏了多少」是**软阈值**（调参）——本模块只做前者，且**不做任何阈值判断**。
 */

import {
  type GoldenLine,
  type GoldenRecord,
  canonicalJson,
  isRecord,
  recordsOf,
} from '../golden/golden-format.js';

/** 一次比对的结果。 */
export interface ComparisonResult {
  /** 是否**逐位相同**。 */
  identical: boolean;
  /** 观测记录的条数（左右两侧应相等）。 */
  leftCount: number;
  rightCount: number;
  /** 第一处差异的定位（无差异时为 undefined）。 */
  firstDiff?: {
    /** 差异所在记录的序号（0 起）。 */
    index: number;
    /** 左侧该记录的规范化 JSON。 */
    left: string;
    /** 右侧该记录的规范化 JSON。 */
    right: string;
    /** 人类可读的原因。 */
    reason: string;
  };
}

/**
 * 逐位比对两套 golden 记录。
 *
 * ⚠️ 只比对 `kind="record"` 的行——`meta` 行本来就该不同（开关不同是这次比对的**前提**）。
 *
 * @param left 基线一侧的记录
 * @param right 对照一侧的记录
 */
export function compareGoldenRecords(
  left: GoldenRecord[],
  right: GoldenRecord[],
): ComparisonResult {
  const leftCount = left.length;
  const rightCount = right.length;

  const common = Math.min(leftCount, rightCount);
  for (let index = 0; index < common; index += 1) {
    const leftJson = canonicalJson(left[index]);
    const rightJson = canonicalJson(right[index]);
    if (leftJson !== rightJson) {
      return {
        identical: false,
        leftCount,
        rightCount,
        firstDiff: {
          index,
          left: leftJson,
          right: rightJson,
          reason: `第 ${index} 条记录不一致（op=${left[index]?.op ?? '?'}）`,
        },
      };
    }
  }

  if (leftCount !== rightCount) {
    return {
      identical: false,
      leftCount,
      rightCount,
      firstDiff: {
        index: common,
        left: canonicalJson(left[common] ?? null),
        right: canonicalJson(right[common] ?? null),
        reason: `记录条数不一致：左侧 ${leftCount} 条，右侧 ${rightCount} 条`,
      },
    };
  }

  return { identical: true, leftCount, rightCount };
}

/**
 * 逐位比对两个 golden **文件**（含 meta 行，但 meta 行不参与比对）。
 */
export function compareGoldenFiles(left: GoldenLine[], right: GoldenLine[]): ComparisonResult {
  return compareGoldenRecords(recordsOf(left), recordsOf(right));
}

/**
 * 断言两套 golden 记录**逐位相同**；不同时抛错并带上第一处差异的位置。
 *
 * ⚠️ 这是**硬断言**：不同时立即失败，不做任何「差不多就算过」的判断（C30）。
 */
export function assertGoldenIdentical(
  left: GoldenRecord[],
  right: GoldenRecord[],
  context = '',
): void {
  const result = compareGoldenRecords(left, right);
  if (result.identical) {
    return;
  }
  const diff = result.firstDiff;
  const prefix = context === '' ? '' : `[${context}] `;
  throw new Error(
    `${prefix}golden 集**不逐位相同**：${diff?.reason ?? '未知差异'}\n` +
      `  左侧：${diff?.left ?? '(无)'}\n` +
      `  右侧：${diff?.right ?? '(无)'}`,
  );
}

/**
 * 从 golden 文件里挑出某个操作的记录（便于「只比 recall 的输出」这类窄口径断言）。
 */
export function recordsWithOp(lines: GoldenLine[], op: string): GoldenRecord[] {
  return lines.filter((line): line is GoldenRecord => isRecord(line) && line.op === op);
}
