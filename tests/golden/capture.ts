/**
 * golden 集的采集 —— DEVELOPMENT-PLAN.md P0-T03 / D-08。
 *
 * ⚠️ **采集器的职责边界**：它只负责「把一次运行的可观测输出变成可逐位比对的记录」。
 *   它**不**判断任何阈值——「算错」与「调参」的分离是 C30 的纪律，
 *   阈值判断属于软断言那一栏，不在采集器里。
 */

import { type GoldenLine, type GoldenRecord, writeGoldenFile } from './golden-format.js';

/** 一次采集的元信息（写进 golden 文件的第一行）。 */
export interface CaptureMeta {
  /** 本次运行的标识（人工辨认两套基线时用）。 */
  label: string;
  /** 本次运行生效的机制开关。 */
  flags: Record<string, unknown>;
  /** 本次运行生效的全量参数。 */
  params: Record<string, unknown>;
}

/**
 * 把一次运行的观测记录组装成 golden 文件的内容。
 *
 * ⚠️ `meta` 行**固定排在第一行**——它是「这次是用什么开关跑的」的凭据，
 *   与「输出是否逐位相同」这个判定**分开**。
 */
export function captureRun(meta: CaptureMeta, records: GoldenRecord[]): GoldenLine[] {
  return [{ kind: 'meta', label: meta.label, flags: meta.flags, params: meta.params }, ...records];
}

/** 采集并落盘。 */
export function captureToFile(
  path: string,
  meta: CaptureMeta,
  records: GoldenRecord[],
): GoldenLine[] {
  const lines = captureRun(meta, records);
  writeGoldenFile(path, lines);
  return lines;
}
