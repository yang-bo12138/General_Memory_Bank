/**
 * v1.0 参考实现（**最小参考**）—— DEVELOPMENT-PLAN.md D-10。
 *
 * ⚠️ **本仓库只有 DESIGN-v2.md，v1.0 的代码不在库内** ⇒
 *   阶段 0 只能建立「开关骨架 + golden 格式 + CI 断言」，**逐位一致的比对基线在阶段 1 末才产生**。
 *   ⇒ 本文件在阶段 0 交付的是**契约 + 驱动器**：
 *   · `RefV1Adapter` —— 参考实现必须满足的接口（五个可观测操作）；
 *   · `runScenario()` —— 驱动适配器跑完一个场景，产出可逐位比对的记录。
 *   真正的 v1.0 适配器在 **P1-T09** 落地（记忆本体十方法齐备后），
 *   并在 P3-T06、P4-T07 再验两次基线。
 *
 * ⚠️ 为什么**重写最小参考**而不是「从 golden 集反推」：
 *   从 golden 集反推得到的是**当前实现的行为**，不是 v1.0 的行为——
 *   拿它当基线，等于拿「现在的自己」证明「现在的自己没变」，那是循环论证。
 */

import { createHash } from 'node:crypto';

import { type CaptureMeta, captureRun } from '../golden/capture.js';
import type { GoldenLine, GoldenRecord } from '../golden/golden-format.js';

/** `write()` 的入参（只取可观测输出的那部分）。 */
export interface RefV1WriteInput {
  content: string;
  kind?: string;
  entities?: string[];
}

/** `write()` 的返回值（只取可观测输出的那部分）。 */
export interface RefV1WriteOutput {
  id: string;
  warnings?: string[];
}

/**
 * v1.0 参考实现必须满足的接口。
 *
 * ⚠️ **只有五个操作**：它们正是 §5 基线条件里点名的那些可观测输出
 *   （`write` / `recall` / `touch` / `get` / `stats`）。
 */
export interface RefV1Adapter {
  write(input: RefV1WriteInput): RefV1WriteOutput;
  recall(options: { context: string; topN?: number }): unknown;
  touch(ids: string[], now?: number, options?: Record<string, unknown>): unknown;
  get(id: string, now?: number): unknown;
  stats(now?: number): unknown;
}

/** 场景里的一步。 */
export interface ScenarioStep {
  /** 操作名。 */
  op: 'write' | 'recall' | 'touch' | 'get' | 'stats';
  /**
   * 入参。
   *
   * ⚠️ 支持两个占位符，让场景不依赖具体 id：
   * · `'$ids'` —— 此前所有 `write` 产生的 id（`touch` 的全集）；
   * · `'$id:0'` —— 第 0 次 `write` 产生的 id（从 0 起）。
   */
  args?: Record<string, unknown>;
}

/** 标准场景：五个操作各来一次（§5 基线条件里点名的那五个）。 */
export const STANDARD_SCENARIO: readonly ScenarioStep[] = [
  { op: 'write', args: { content: '张三住在北京', kind: 'fact', entities: ['张三'] } },
  { op: 'write', args: { content: '张三喜欢猫', kind: 'preference', entities: ['张三', '猫'] } },
  { op: 'recall', args: { context: '张三住哪里', topN: 5 } },
  { op: 'touch', args: { ids: '$ids' } },
  { op: 'get', args: { id: '$id:0' } },
  { op: 'stats', args: {} },
];

/** 把场景里的占位符解析成真实 id。 */
function resolveArgs(args: Record<string, unknown>, writtenIds: string[]): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === '$ids') {
      resolved[key] = [...writtenIds];
    } else if (typeof value === 'string' && value.startsWith('$id:')) {
      const index = Number.parseInt(value.slice('$id:'.length), 10);
      const id = writtenIds[index];
      if (id === undefined) {
        throw new Error(`场景引用了尚未写入的 id：${value}`);
      }
      resolved[key] = id;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * 驱动适配器跑完一个场景，产出可逐位比对的观测记录。
 *
 * ⚠️ 记录的 `args` 是**解析后的真实入参**——比对时入参也参与，
 *   否则「换了入参却得到同样输出」会被误判成「输出逐位相同」。
 */
export function runScenario(
  adapter: RefV1Adapter,
  scenario: readonly ScenarioStep[] = STANDARD_SCENARIO,
): GoldenRecord[] {
  const writtenIds: string[] = [];
  const records: GoldenRecord[] = [];

  for (const step of scenario) {
    const args = resolveArgs(step.args ?? {}, writtenIds);
    switch (step.op) {
      case 'write': {
        const output = adapter.write(args as unknown as RefV1WriteInput);
        writtenIds.push(output.id);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'recall': {
        const output = adapter.recall(args as unknown as { context: string; topN?: number });
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'touch': {
        const ids = (args.ids as string[] | undefined) ?? [];
        const output = adapter.touch(ids, args.now as number | undefined);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'get': {
        const output = adapter.get(args.id as string, args.now as number | undefined);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'stats': {
        const output = adapter.stats(args.now as number | undefined);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      default: {
        throw new Error(`未知场景操作：${String(step.op)}`);
      }
    }
  }

  return records;
}

/**
 * 跑完一个场景并组装成 golden 文件的内容。
 */
export function captureRefV1Run(
  adapter: RefV1Adapter,
  meta: CaptureMeta,
  scenario: readonly ScenarioStep[] = STANDARD_SCENARIO,
): GoldenLine[] {
  return captureRun(meta, runScenario(adapter, scenario));
}

// ═══════════════════════════════════════════════════════════════════════════
// v1.0 参考实现（P1-T09）—— **纯函数重算**
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ **本段是 P1-T09 的交付物**：把 v1.0 的语义按 DESIGN §4.1 / §4.2 / §4.3 / §4.6 / §4.9
//   **独立重算一遍**，供 `tests/baseline/v1-equivalence.test.ts` 与真实实现逐位比对。
//
// ⚠️ **为什么必须独立重算**（本文件 P0 段的原话）：
//   「从 golden 集反推得到的是**当前实现的行为**，不是 v1.0 的行为 ⇒ 拿它当基线，
//   等于拿『现在的自己』证明『现在的自己没变』，那是循环论证。」
//   ⇒ 本段**不 import `src/**` 的任何运行时代码**（只 import `node:crypto` 算 sha1）；
//     `tests/baseline/v1-equivalence.test.ts` 里有一条**静态守卫**盯着这件事
//     （扫本文件的 import 语句 ⇒ `src/**` 一条都不许有）。
//
// ⚠️ **参考实现与真实实现的分工**（避免「拿实现比实现」）：
//   · **规则与公式**（分词、匹配串构造、粗筛窗口、强度精筛、`normBm25` 归一化、
//     五因子融合、衰减、加固、难度/稳定度初值、合并判据、实体归一与别名冲突）
//     ——**全部在参考实现里**（本段）；
//   · **引擎事实**（FTS5 的 `bm25()` 原始值、FTS/LIKE 命中的行、证据边条数）
//     ——由测试夹具从 SQLite 取，**作为输入喂给参考实现**。
//   ⇒ 「FTS 命中了哪几行」是 SQLite 的事实；「命中之后怎么打分、怎么排序」是本库的设计。
//
// ⚠️ **浮点逐位相同的口径**：公式里的**表达式顺序**也照抄设计（`a * b * c` 的左结合、
//   `min(MAX, x * y * z)` 的钳制位置）⇒ 两侧的浮点结果逐位相同。
//   ⚠️ 因此**参考实现里不要「顺手优化」表达式**（例如把 `min(1, ·)` 提前）——
//   那会让基线假红，而红的原因不是实现变了。

/** §4.1 / §4.5 公式里的一天毫秒数。 */
export const REF_MS_PER_DAY = 86400000;

/** §4.6 步骤 3 的五项权重（**刻意不进参数表**）。 */
export const REF_SCORE_WEIGHTS = {
  intensity: 0.3,
  vectorSim: 0.25,
  normBm25: 0.2,
  graphProximity: 0.15,
  recency: 0.1,
} as const;

/** §4.6：`normBm25` 的 sigmoid 斜率（**刻意不进参数表**）。 */
export const REF_NORM_BM25_SLOPE = 0.2;

/** §4.3 的置信度惩罚系数（公式常量，不在参数表里）。 */
export const REF_CONFIDENCE_PENALTY = 0.2;

/** §4.3 的难度上限（`min(0.95, …)`）。 */
export const REF_DIFFICULTY_CEILING = 0.95;

/** §6：`topN` 的内部上限（`1~8`）。 */
export const REF_MAX_TOP_N = 8;

/** §4.6 步骤 2a / 2b：每条路**精筛之后**的候选上限（`slice(0, 20)`）。 */
export const REF_ROUTE_CANDIDATE_LIMIT = 20;

/** §10.2：单个查询最多取前 N 个 token。 */
export const REF_MAX_MATCH_TOKENS = 30;

/** §4.4 的四个层级。 */
export type RefV1Layer = 'L3' | 'L2' | 'L1' | 'archived';

/** §4.6 步骤 2a 的文本路分支。 */
export type RefV1TextRoute = 'fts' | 'like' | 'none';

/**
 * 参考实现用到的参数（§5 的 **v1.0 继承 29 项**中的一部分）。
 *
 * ⚠️ **为什么在参考实现里写死一份**：基线要冻结的是「与 v1.0 逐位一致」这件事，
 *   而 v1.0 的代码不在本仓库（D-10）⇒ **v1.0 的参数值以 §5 的表为准**。
 *   ⇒ 参考实现把用到的那几项**逐字抄成字面量**，测试夹具再断言
 *   「运行时生效的参数 == 这份字面量」⇒ 任何调参都会**显式地**撞红基线，
 *   而不是悄悄改变「与 v1.0 一致」这句话的含义。
 */
export interface RefV1Params {
  MAX_STABILITY: number;
  MAX_PIN_FACTOR: number;
  THRESHOLD_L3: number;
  THRESHOLD_L2: number;
  ARCHIVE_LINE: number;
  INITIAL_STABILITY: number;
  EMOTION_WEIGHT: number;
  DIFFICULTY_BASE: number;
  DIFFICULTY_SCALE: number;
  DIFFICULTY_FIRST: number;
  DIFFICULTY_NORMAL: number;
  SPACING_CAP: number;
  DEDUP_ENTITY_MIN: number;
  DEDUP_COS_MIN: number;
  DEDUP_BOOST: number;
  RECALL_TOP_N: number;
  RECENCY_DECAY_DAYS: number;
}

/** §5 的 v1.0 继承参数（参考实现用的那一部分，逐字）。 */
export const REF_V1_PARAMS: RefV1Params = {
  MAX_STABILITY: 180,
  MAX_PIN_FACTOR: 5.0,
  THRESHOLD_L3: 0.7,
  THRESHOLD_L2: 0.3,
  ARCHIVE_LINE: 0.05,
  INITIAL_STABILITY: 1.0,
  EMOTION_WEIGHT: 2.0,
  DIFFICULTY_BASE: 1.5,
  DIFFICULTY_SCALE: 0.5,
  DIFFICULTY_FIRST: 0.3,
  DIFFICULTY_NORMAL: 0.5,
  SPACING_CAP: 2.0,
  DEDUP_ENTITY_MIN: 2,
  DEDUP_COS_MIN: 0.92,
  DEDUP_BOOST: 1.3,
  RECALL_TOP_N: 5,
  RECENCY_DECAY_DAYS: 14,
};

/** §4.6 步骤 3 的五个因子。 */
export interface RefV1ScoreFactors {
  intensity: number;
  vectorSim: number;
  normBm25: number;
  graphProximity: number;
  recency: number;
}

/** §4.6 步骤 3 的五个分项（字段名与 §6 的 `Hit.breakdown` 一致）。 */
export interface RefV1ScoreParts {
  intensityPart: number;
  vectorPart: number;
  textPart: number;
  graphPart: number;
  recencyPart: number;
}

/** §4.2 的加固输入。 */
export interface RefV1StabilityInput {
  stability: number;
  lastAccess: number;
  accessCount: number;
  difficulty: number;
}

/** §4.2 的一次加固结果。 */
export interface RefV1Growth {
  stability: number;
  lastAccess: number;
  accessCount: number;
  intervalDays: number;
  boosted: boolean;
  stabilityDelta: number;
}

/**
 * 参考实现的**公式层**。
 *
 * ⚠️ **做成可注入的对象**（而不是散落的自由函数）是为了**负控**：
 *   负控要能「只改一个公式」并让基线比对变红（`tests/baseline/v1-equivalence.test.ts`
 *   里有一条用例专门做这件事）⇒ 公式必须能被整体替换掉其中一个。
 */
export interface RefV1Formulas {
  /** §10.2：全角 → 半角。 */
  toHalfWidth(text: string): string;
  /** §10.2：归一化（**只用于算 `content_hash`**）。 */
  normalize(text: string): string;
  /** §10.2：中文 2 字滑窗 + 拉丁整词。 */
  tokenize(text: string): string;
  /** §10.2：FTS5 查询串构造（三分支）。 */
  buildMatchQuery(query: string): { matchSql: string | null; fallbackLike: string | null };
  /** §4.9 步骤 3a：去重查询串（**自己的 tokenize、前 3 个、AND 连接**）。 */
  dedupQuery(content: string): string;
  /** §10.2：FTS5 转义（包裹 + 转义是两件事）。 */
  escapeFts5(token: string): string;
  /** §10.2：LIKE 通配符转义。 */
  escapeLike(text: string): string;
  /** §4.3：初始稳定度。 */
  initialStability(params: RefV1Params, emotion: number): number;
  /** §4.3：初始难度（★ 负控的目标公式）。 */
  initialDifficulty(baseDifficulty: number, confidence: number): number;
  /** §4.1：强度（两重钳制缺一不可）。 */
  intensity(stability: number, pinFactor: number, lastAccess: number, now: number): number;
  /** §4.4：层级判定（三处都是严格大于）。 */
  layerOf(value: number, params: RefV1Params): RefV1Layer;
  /** §4.2：难度加成。 */
  difficultyBonus(difficulty: number, params: RefV1Params): number;
  /** §4.2：间隔重复加成。 */
  spacingFactor(intervalDays: number, useSpacing: boolean, params: RefV1Params): number;
  /** §4.2：三个约束 + 增长公式。 */
  growStability(
    memory: RefV1StabilityInput,
    baseGrowth: number,
    useSpacing: boolean,
    params: RefV1Params,
    now: number,
  ): RefV1Growth;
  /** §4.6：中位数。 */
  median(values: readonly number[]): number;
  /** §4.6：`normBm25` 的 sigmoid。 */
  normBm25Sigmoid(rawBm25: number, medianBm25: number): number;
  /** §4.6：`normBm25` 的三条规则。 */
  normalizeBm25(raws: readonly (number | null)[], route: RefV1TextRoute): number[];
  /** §4.6：新近度。 */
  recency(createdAt: number, params: RefV1Params, now: number): number;
  /** §4.6 步骤 3：五因子加权和（缺项记 0、不重算分母）。 */
  fuse(factors: Partial<RefV1ScoreFactors>): { score: number; breakdown: RefV1ScoreParts };
  /** §6：`topN` 的钳制（`1~8`）。 */
  clampTopN(value: number | undefined, fallback: number): number;
}

/** §10.2 的汉字区间（U+4E00–U+9FA5）。 */
const REF_CJK_PATTERN = /[一-龥]/;

/** §10.2 的切分正则（**中文串** 或 **拉丁字母 / 数字 / 下划线串**）。 */
const REF_TOKEN_PATTERN = /[一-龥]+|[a-zA-Z0-9_]+/g;

function refToHalfWidth(text: string): string {
  return text
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function refNormalize(text: string): string {
  return refToHalfWidth(text).trim().toLowerCase();
}

function refTokenize(text: string): string {
  const parts = refToHalfWidth(text).match(REF_TOKEN_PATTERN) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    if (REF_CJK_PATTERN.test(part.charAt(0))) {
      if (part.length === 1) {
        out.push(part);
        continue;
      }
      for (let index = 0; index < part.length - 1; index += 1) {
        out.push(part.slice(index, index + 2));
      }
      continue;
    }
    out.push(part.toLowerCase());
  }
  return out.join(' ');
}

function refEscapeFts5(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function refEscapeLike(text: string): string {
  return text.replace(/([%_\\])/g, '\\$1');
}

function refBuildMatchQuery(query: string): {
  matchSql: string | null;
  fallbackLike: string | null;
} {
  const tokens = refTokenize(query).split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return { matchSql: null, fallbackLike: null };
  }
  if (tokens.length === 1 && tokens[0]?.length === 1) {
    const ch = tokens[0] ?? '';
    if (REF_CJK_PATTERN.test(ch)) {
      return { matchSql: null, fallbackLike: refEscapeLike(ch) };
    }
    return { matchSql: null, fallbackLike: null };
  }
  const safeTokens = tokens.slice(0, REF_MAX_MATCH_TOKENS);
  if (safeTokens.length <= 3) {
    return { matchSql: safeTokens.map(refEscapeFts5).join(' AND '), fallbackLike: null };
  }
  return { matchSql: safeTokens.map(refEscapeFts5).join(' OR '), fallbackLike: null };
}

function refDedupQuery(content: string): string {
  const tokens = refTokenize(content).split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return '';
  }
  return tokens.slice(0, 3).map(refEscapeFts5).join(' AND ');
}

function refInitialStability(params: RefV1Params, emotion: number): number {
  return Math.min(
    params.MAX_STABILITY,
    params.INITIAL_STABILITY * (1 + params.EMOTION_WEIGHT * emotion),
  );
}

function refInitialDifficulty(baseDifficulty: number, confidence: number): number {
  return Math.min(
    REF_DIFFICULTY_CEILING,
    baseDifficulty + REF_CONFIDENCE_PENALTY * (1 - confidence),
  );
}

function refIntensity(
  stability: number,
  pinFactor: number,
  lastAccess: number,
  now: number,
): number {
  const tauMs = stability * pinFactor * REF_MS_PER_DAY;
  const elapsedMs = Math.max(0, now - lastAccess);
  return Math.min(1, Math.exp(-elapsedMs / tauMs));
}

function refLayerOf(value: number, params: RefV1Params): RefV1Layer {
  if (value > params.THRESHOLD_L3) {
    return 'L3';
  }
  if (value > params.THRESHOLD_L2) {
    return 'L2';
  }
  if (value > params.ARCHIVE_LINE) {
    return 'L1';
  }
  return 'archived';
}

function refDifficultyBonus(difficulty: number, params: RefV1Params): number {
  return params.DIFFICULTY_BASE + params.DIFFICULTY_SCALE * (1 - difficulty);
}

function refSpacingFactor(intervalDays: number, useSpacing: boolean, params: RefV1Params): number {
  return useSpacing ? Math.min(params.SPACING_CAP, 1 + Math.log2(intervalDays)) : 1;
}

function refGrowStability(
  memory: RefV1StabilityInput,
  baseGrowth: number,
  useSpacing: boolean,
  params: RefV1Params,
  now: number,
): RefV1Growth {
  const before = memory.stability;
  const intervalDays = Math.max(0, now - memory.lastAccess) / REF_MS_PER_DAY;
  let stability = before;
  let boosted = false;
  if (intervalDays >= 1.0) {
    const spacing = refSpacingFactor(intervalDays, useSpacing, params);
    stability = Math.min(params.MAX_STABILITY, before * baseGrowth * spacing);
    boosted = stability > before;
  }
  return {
    stability,
    lastAccess: now,
    accessCount: memory.accessCount + 1,
    intervalDays,
    boosted,
    stabilityDelta: stability - before,
  };
}

function refMedian(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  const lower = sorted[middle - 1] as number;
  const upper = sorted[middle] as number;
  return (lower + upper) / 2;
}

function refNormBm25Sigmoid(rawBm25: number, medianBm25: number): number {
  return 1 / (1 + Math.exp(REF_NORM_BM25_SLOPE * (rawBm25 - medianBm25)));
}

function refNormalizeBm25(raws: readonly (number | null)[], route: RefV1TextRoute): number[] {
  if (route === 'like') {
    return raws.map(() => 1);
  }
  if (route === 'none') {
    return raws.map(() => 0);
  }
  const bm25List: number[] = [];
  for (const raw of raws) {
    if (raw === null) {
      continue;
    }
    bm25List.push(raw);
  }
  if (bm25List.length === 0) {
    return raws.map(() => 0);
  }
  const medianBm25 = refMedian(bm25List);
  return raws.map((raw) => (raw === null ? 0 : refNormBm25Sigmoid(raw, medianBm25)));
}

function refRecency(createdAt: number, params: RefV1Params, now: number): number {
  const elapsedMs = Math.max(0, now - createdAt);
  const tauMs = params.RECENCY_DECAY_DAYS * REF_MS_PER_DAY;
  return Math.min(1, Math.exp(-elapsedMs / tauMs));
}

function refFuse(factors: Partial<RefV1ScoreFactors>): {
  score: number;
  breakdown: RefV1ScoreParts;
} {
  const values: RefV1ScoreFactors = {
    intensity: 0,
    vectorSim: 0,
    normBm25: 0,
    graphProximity: 0,
    recency: 0,
  };
  for (const key of ['intensity', 'vectorSim', 'normBm25', 'graphProximity', 'recency'] as const) {
    const value = factors[key];
    if (value === undefined) {
      continue;
    }
    values[key] = value;
  }
  const breakdown: RefV1ScoreParts = {
    intensityPart: values.intensity * REF_SCORE_WEIGHTS.intensity,
    vectorPart: values.vectorSim * REF_SCORE_WEIGHTS.vectorSim,
    textPart: values.normBm25 * REF_SCORE_WEIGHTS.normBm25,
    graphPart: values.graphProximity * REF_SCORE_WEIGHTS.graphProximity,
    recencyPart: values.recency * REF_SCORE_WEIGHTS.recency,
  };
  const score =
    breakdown.intensityPart +
    breakdown.vectorPart +
    breakdown.textPart +
    breakdown.graphPart +
    breakdown.recencyPart;
  return { score, breakdown };
}

function refClampTopN(value: number | undefined, fallback: number): number {
  const base = value === undefined || !Number.isFinite(value) ? fallback : Math.trunc(value);
  return Math.min(REF_MAX_TOP_N, Math.max(1, base));
}

/** 参考实现的公式层（默认实现）。 */
export const REF_FORMULAS: RefV1Formulas = {
  toHalfWidth: refToHalfWidth,
  normalize: refNormalize,
  tokenize: refTokenize,
  buildMatchQuery: refBuildMatchQuery,
  dedupQuery: refDedupQuery,
  escapeFts5: refEscapeFts5,
  escapeLike: refEscapeLike,
  initialStability: refInitialStability,
  initialDifficulty: refInitialDifficulty,
  intensity: refIntensity,
  layerOf: refLayerOf,
  difficultyBonus: refDifficultyBonus,
  spacingFactor: refSpacingFactor,
  growStability: refGrowStability,
  median: refMedian,
  normBm25Sigmoid: refNormBm25Sigmoid,
  normalizeBm25: refNormalizeBm25,
  recency: refRecency,
  fuse: refFuse,
  clampTopN: refClampTopN,
};

// ═══════════════════════════════════════════════════════════════════════════
// 一、参考实现的内存模型
// ═══════════════════════════════════════════════════════════════════════════

/** 参考模型里的实体（`id` 是参考实现自己的序号，不是真实 uuid）。 */
export interface RefV1Entity {
  id: string;
  name: string;
}

/** 参考模型里的一条记忆。 */
export interface RefV1Record {
  refId: string;
  content: string;
  contentHash: string;
  kind: string;
  /** 关联的实体 id（顺序 = 首次出现顺序）。 */
  entityIds: string[];
  stability: number;
  pinFactor: number;
  lastAccess: number;
  accessCount: number;
  createdAt: number;
  confidence: number;
  difficulty: number;
  hasEmbedding: boolean;
  source: string | null;
  mediaRef: string | null;
  mediaType: string | null;
  deleted: boolean;
  deletedAt: number | null;
}

/** 参考模型里的一条事件。 */
export interface RefV1Event {
  type: string;
  memoryRefId: string | null;
  payload: Record<string, unknown>;
  at: number;
}

/** 参考模型（**纯内存**；不碰数据库、不读时钟）。 */
export interface RefV1Model {
  params: RefV1Params;
  formulas: RefV1Formulas;
  records: Map<string, RefV1Record>;
  /** 记忆的创建顺序（`refId` 序列）。 */
  recordOrder: string[];
  /** `content_hash` → `refId`（§4.9 步骤 2 的完全重复检测）。 */
  recordsByHash: Map<string, string>;
  /** 实体（**按主名索引**）。 */
  entities: Map<string, RefV1Entity>;
  /** 实体的创建顺序。 */
  entityOrder: string[];
  /** 别名 → 实体 id。 */
  aliases: Map<string, string>;
  events: RefV1Event[];
}

/** 建一个空的参考模型。 */
export function createRefV1Model(
  params: RefV1Params = REF_V1_PARAMS,
  formulas: RefV1Formulas = REF_FORMULAS,
): RefV1Model {
  return {
    params,
    formulas,
    records: new Map(),
    recordOrder: [],
    recordsByHash: new Map(),
    entities: new Map(),
    entityOrder: [],
    aliases: new Map(),
    events: [],
  };
}

/** 实体 id → 主名。 */
export function refEntityName(model: RefV1Model, entityId: string): string {
  for (const entity of model.entities.values()) {
    if (entity.id === entityId) {
      return entity.name;
    }
  }
  return entityId;
}

/** 解析实体名（**主名优先**，其次别名；§4.5 末尾的解析顺序）。 */
function refResolveEntityId(model: RefV1Model, name: string): string | null {
  const primary = model.entities.get(name);
  if (primary !== undefined) {
    return primary.id;
  }
  return model.aliases.get(name) ?? null;
}

/** 建立实体（已存在则复用）。 */
function refUpsertEntity(model: RefV1Model, name: string): string {
  const existing = model.entities.get(name);
  if (existing !== undefined) {
    return existing.id;
  }
  const id = `e${model.entityOrder.length}`;
  model.entities.set(name, { id, name });
  model.entityOrder.push(id);
  return id;
}

/** §4.9 步骤 1c 的别名冲突检测（**主名优先**；别名已指向本人不算冲突）。 */
function refDetectAliasConflict(
  model: RefV1Model,
  alias: string,
  intendedEntityId: string,
): string | null {
  const primary = model.entities.get(alias);
  if (primary !== undefined) {
    return primary.id;
  }
  const owner = model.aliases.get(alias);
  if (owner !== undefined && owner !== intendedEntityId) {
    return owner;
  }
  return null;
}

/** §4.9 步骤 3b：传入实体集合 ∩ 候选已关联实体集合的大小。 */
function refEntityOverlap(
  candidateEntityIds: readonly string[],
  linkedEntityIds: readonly string[],
): number {
  if (linkedEntityIds.length === 0) {
    return 0;
  }
  const linked = new Set(candidateEntityIds);
  return linkedEntityIds.filter((id) => linked.has(id)).length;
}

/** §4.9 步骤 3c ⑤ / 步骤 2：本次要补链的实体（**顺序 = 传入顺序**）。 */
function refAddedEntities(record: RefV1Record, linkedEntityIds: readonly string[]): string[] {
  const existing = new Set(record.entityIds);
  return linkedEntityIds.filter((id) => !existing.has(id));
}

/** §4.3：是否还有「尚无任何关联记忆」的实体。 */
function refHasEntityWithoutMemory(model: RefV1Model, entityId: string): boolean {
  for (const record of model.records.values()) {
    if (record.entityIds.includes(entityId)) {
      return false;
    }
  }
  return true;
}

/** §4.3：把 `emotion` 钳进 `[0, 1]`。 */
function refClampEmotion(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/** §4.9 步骤 2：归一化正文的 sha1。 */
function refSha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 两向量点积（**任一侧为 `null` ⇒ 不可比** ⇒ `null`）。 */
function refCosine(left: readonly number[] | null, right: readonly number[] | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  if (left.length !== right.length || left.length === 0) {
    return null;
  }
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return null;
    }
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }
  if (normLeft <= 0 || normRight <= 0) {
    return null;
  }
  return dot / Math.sqrt(normLeft * normRight);
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、四个方法的参考实现
// ═══════════════════════════════════════════════════════════════════════════

/** `write()` 的入参（只取可观测输出的那部分）。 */
export interface RefV1WriteInput {
  content: string;
  kind?: string;
  entities?: string[];
  entityAliases?: Array<{ name: string; aliases: string[] }>;
  emotion?: number;
  source?: string;
  confidence?: number;
  mediaRef?: string;
  mediaType?: string;
  embedding?: number[] | null;
}

/**
 * `write()` 需要的**引擎事实**（由测试夹具从 SQLite 取，参考实现自己不做 IO）。
 *
 * ⚠️ 这里刻意**不含**「本次会不会合并」的答案——那是**规则**，属于参考实现。
 */
export interface RefV1WriteEvidence {
  /** §4.9 步骤 3a 的去重候选（FTS 命中的前 3 条，按 bm25 升序）。 */
  dedupCandidates: Array<{
    refId: string;
    /** 候选已关联的实体**名**（参考实现自己归一到自己的实体 id 空间）。 */
    entityNames: string[];
    /** 候选的向量（`null` = 没有向量）。 */
    embedding: number[] | null;
  }>;
  /** 证据边条数（按 `refId` 统计；§4.5 的 R-EDGE-TOUCH）。 */
  edgesByRefId: Record<string, number>;
}

/** `write()` 的可观测输出。 */
export interface RefV1WriteOutcome {
  refId: string;
  merged: boolean;
  exact: boolean;
  content: string;
  warnings: Array<{
    code: string;
    alias: string;
    currentEntityId: string;
    intendedEntityId: string;
  }>;
  /** 本次关联的实体 id（顺序 = 首次出现顺序）。 */
  entityIds: string[];
  /** 本次写入产生的事件（顺序 = 落库顺序）。 */
  events: RefV1Event[];
}

/**
 * `write()` 的参考实现（§4.9 的四步）。
 *
 * ⚠️ **四条路径**（与实现一一对应）：
 *   ① 全新事实（`merged=false, exact=false`）；
 *   ② 完全重复（`merged=true, exact=true`；只加固、不改正文）；
 *   ③ 近似合并（`merged=true, exact=false`；正文**无条件**采纳新文本）。
 */
export function refWrite(
  model: RefV1Model,
  input: RefV1WriteInput,
  now: number,
  evidence: RefV1WriteEvidence,
): RefV1WriteOutcome {
  const formulas = model.formulas;
  const params = model.params;

  // ── 步骤 1a / 1b：实体归一与建立 ──
  const linkedEntityIds: string[] = [];
  const byName = new Map<string, string>();
  for (const name of input.entities ?? []) {
    const existing = refResolveEntityId(model, name);
    const entityId = existing ?? refUpsertEntity(model, name);
    byName.set(name, entityId);
    if (!linkedEntityIds.includes(entityId)) {
      linkedEntityIds.push(entityId);
    }
  }

  // ── 步骤 1c：别名同步（冲突进 `warnings`，**不覆盖**）──
  const warnings: RefV1WriteOutcome['warnings'] = [];
  for (const entry of input.entityAliases ?? []) {
    const intendedEntityId =
      byName.get(entry.name) ??
      refResolveEntityId(model, entry.name) ??
      refUpsertEntity(model, entry.name);
    for (const alias of entry.aliases) {
      const currentEntityId = refDetectAliasConflict(model, alias, intendedEntityId);
      if (currentEntityId !== null) {
        warnings.push({ code: 'ALIAS_CONFLICT', alias, currentEntityId, intendedEntityId });
        continue;
      }
      model.aliases.set(alias, intendedEntityId);
    }
  }

  const confidence = input.confidence ?? 0.7;
  const emotion = refClampEmotion(input.emotion ?? 0);
  const hash = refSha1(formulas.normalize(input.content));

  // ── 步骤 2：完全重复检测 ──
  const exactRefId = model.recordsByHash.get(hash);
  const exactRecord = exactRefId === undefined ? undefined : model.records.get(exactRefId);
  if (exactRecord !== undefined && !exactRecord.deleted) {
    const growth = formulas.growStability(exactRecord, params.DEDUP_BOOST, false, params, now);
    exactRecord.stability = growth.stability;
    exactRecord.lastAccess = growth.lastAccess;
    exactRecord.accessCount = growth.accessCount;
    const addedEntities = refAddedEntities(exactRecord, linkedEntityIds);
    for (const entityId of addedEntities) {
      exactRecord.entityIds.push(entityId);
    }
    const edgesReinforced = evidence.edgesByRefId[exactRecord.refId] ?? 0;
    const event: RefV1Event = {
      type: 'touch',
      memoryRefId: exactRecord.refId,
      at: now,
      payload: {
        id: exactRecord.refId,
        reason: 'exact_repeat',
        intervalDays: growth.intervalDays,
        boostApplied: growth.boosted,
        edgesReinforced,
        embeddingAdded: 0,
        addedEntities,
        stabilityDelta: growth.stabilityDelta,
      },
    };
    model.events.push(event);
    return {
      refId: exactRecord.refId,
      merged: true,
      exact: true,
      content: exactRecord.content,
      warnings,
      entityIds: linkedEntityIds,
      events: [event],
    };
  }

  // ── 步骤 3a / 3b：相似检测 ──
  const tokens = formulas.tokenize(input.content).split(' ').filter(Boolean);
  let mergeTarget: RefV1Record | undefined;
  if (tokens.length > 0) {
    const textRouteDegenerate = tokens.length < 2;
    let best: { record: RefV1Record; overlap: number; cos: number } | undefined;
    for (const candidate of evidence.dedupCandidates) {
      const record = model.records.get(candidate.refId);
      if (record === undefined || record.deleted) {
        continue;
      }
      // ⚠️ 候选的实体**名**要先归一到参考实现自己的实体 id 空间（别名指向同一实体 ⇒ 同一个 id）。
      const candidateEntityIds = candidate.entityNames
        .map((name) => refResolveEntityId(model, name))
        .filter((id): id is string => id !== null);
      const overlap = refEntityOverlap(candidateEntityIds, linkedEntityIds);
      const cos = refCosine(input.embedding ?? null, candidate.embedding);
      const entityOk = overlap >= params.DEDUP_ENTITY_MIN;
      const cosOk = cos !== null && cos >= params.DEDUP_COS_MIN && !textRouteDegenerate;
      if (!entityOk && !cosOk) {
        continue;
      }
      const cosValue = cos ?? Number.NEGATIVE_INFINITY;
      if (
        best === undefined ||
        overlap > best.overlap ||
        (overlap === best.overlap && cosValue > best.cos)
      ) {
        best = { record, overlap, cos: cosValue };
      }
    }
    mergeTarget = best?.record;
  }

  // ── 步骤 3c：原子合并 ──
  if (mergeTarget !== undefined) {
    const target = mergeTarget;
    const prevContentLength = target.content.length;
    const prevHash = target.contentHash;
    const growth = formulas.growStability(target, params.DEDUP_BOOST, false, params, now);
    target.content = input.content;
    target.contentHash = hash;
    // ⚠️ **旧 hash 必须从索引里摘掉**：合并后这条记忆的 `content_hash` 已经是新值，
    //   旧值不再对应任何行 ⇒ 之后再写同样的旧正文**不该**被判成「完全重复」。
    model.recordsByHash.delete(prevHash);
    model.recordsByHash.set(hash, target.refId);
    target.stability = growth.stability;
    target.lastAccess = growth.lastAccess;
    target.accessCount = growth.accessCount;
    const addedEntities = refAddedEntities(target, linkedEntityIds);
    for (const entityId of addedEntities) {
      target.entityIds.push(entityId);
    }
    const event: RefV1Event = {
      type: 'merge',
      memoryRefId: target.refId,
      at: now,
      payload: {
        targetId: target.refId,
        intervalDays: growth.intervalDays,
        boostApplied: growth.boosted,
        contentText: input.content,
        contentLength: input.content.length,
        contentHash: hash,
        prevContentLength,
        addedEntities,
        hasEmbedding: (input.embedding ?? null) !== null,
        stabilityDelta: growth.stabilityDelta,
      },
    };
    model.events.push(event);
    return {
      refId: target.refId,
      merged: true,
      exact: false,
      content: input.content,
      warnings,
      entityIds: linkedEntityIds,
      events: [event],
    };
  }

  // ── 步骤 4：全新事实 ──
  const refId = `m${model.recordOrder.length}`;
  const isFirstAboutEntity =
    linkedEntityIds.length > 0 &&
    linkedEntityIds.some((entityId) => refHasEntityWithoutMemory(model, entityId));
  const baseDifficulty = isFirstAboutEntity ? params.DIFFICULTY_FIRST : params.DIFFICULTY_NORMAL;
  const initialDifficulty = formulas.initialDifficulty(baseDifficulty, confidence);
  const initialStability = formulas.initialStability(params, emotion);
  const record: RefV1Record = {
    refId,
    content: input.content,
    contentHash: hash,
    kind: input.kind ?? 'fact',
    entityIds: [...linkedEntityIds],
    stability: initialStability,
    pinFactor: 1.0,
    lastAccess: now,
    accessCount: 0,
    createdAt: now,
    confidence,
    difficulty: initialDifficulty,
    hasEmbedding: (input.embedding ?? null) !== null,
    source: input.source ?? null,
    mediaRef: input.mediaRef ?? null,
    mediaType: input.mediaType ?? null,
    deleted: false,
    deletedAt: null,
  };
  model.records.set(refId, record);
  model.recordOrder.push(refId);
  model.recordsByHash.set(hash, refId);
  const event: RefV1Event = {
    type: 'write',
    memoryRefId: refId,
    at: now,
    payload: {
      id: refId,
      kind: record.kind,
      contentText: input.content,
      contentLength: input.content.length,
      contentHash: hash,
      entityIds: [...linkedEntityIds],
      emotion,
      confidence,
      hasEmbedding: record.hasEmbedding,
      initialStability,
      initialDifficulty,
    },
  };
  model.events.push(event);
  return {
    refId,
    merged: false,
    exact: false,
    content: input.content,
    warnings,
    entityIds: linkedEntityIds,
    events: [event],
  };
}

/** 一次 `touch` 的逐条结果。 */
export interface RefV1TouchOutcome {
  refId: string;
  intervalDays: number;
  boosted: boolean;
  stabilityDelta: number;
  edgesReinforced: number;
}

/** `touch()` 的可观测输出。 */
export interface RefV1TouchResult {
  outcomes: RefV1TouchOutcome[];
  events: RefV1Event[];
}

/**
 * `touch()` 的参考实现（§4.2 的批量加固）。
 *
 * ⚠️ **难度加成必须在循环内按各自的 `difficulty` 算**（§4.2 的原文）。
 */
export function refTouch(
  model: RefV1Model,
  ids: readonly string[],
  now: number,
  edgesByRefId: Record<string, number>,
): RefV1TouchResult {
  const formulas = model.formulas;
  const params = model.params;
  const requested = [...new Set(ids)];
  const outcomes: RefV1TouchOutcome[] = [];
  const events: RefV1Event[] = [];
  for (const refId of requested) {
    const record = model.records.get(refId);
    if (record === undefined) {
      throw new Error(`参考实现：touch 的记忆不存在：${refId}`);
    }
    const bonus = formulas.difficultyBonus(record.difficulty, params);
    const growth = formulas.growStability(record, bonus, true, params, now);
    record.stability = growth.stability;
    record.lastAccess = growth.lastAccess;
    record.accessCount = growth.accessCount;
    const edgesReinforced = edgesByRefId[refId] ?? 0;
    outcomes.push({
      refId,
      intervalDays: growth.intervalDays,
      boosted: growth.boosted,
      stabilityDelta: growth.stabilityDelta,
      edgesReinforced,
    });
    events.push({
      type: 'touch',
      memoryRefId: refId,
      at: now,
      payload: {
        id: refId,
        reason: 'explicit',
        intervalDays: growth.intervalDays,
        boostApplied: growth.boosted,
        edgesReinforced,
        stabilityDelta: growth.stabilityDelta,
      },
    });
  }
  for (const event of events) {
    model.events.push(event);
  }
  return { outcomes, events };
}

/** §6 的 `MemoryView`（参考实现侧；字段集与实现一一对应）。 */
export interface RefV1MemoryView {
  id: string;
  content: string;
  hasEmbedding: boolean;
  kind: string;
  layer: RefV1Layer;
  intensity: number;
  stability: number;
  difficulty: number;
  effectiveStability: number;
  entities: string[];
  mediaRef: string | null;
  mediaType: string | null;
  createdAt: number;
  lastAccess: number;
  accessCount: number;
  pinFactor: number;
  confidence: number;
  source: string | null;
  deleted: boolean;
  deletedAt: number | null;
}

/** `get()` 的参考实现（§4.1 末）。 */
export function refGet(model: RefV1Model, refId: string, now: number): RefV1MemoryView | null {
  const record = model.records.get(refId);
  if (record === undefined) {
    return null;
  }
  const intensityValue = model.formulas.intensity(
    record.stability,
    record.pinFactor,
    record.lastAccess,
    now,
  );
  return {
    id: record.refId,
    content: record.content,
    hasEmbedding: record.hasEmbedding,
    kind: record.kind,
    layer: model.formulas.layerOf(intensityValue, model.params),
    intensity: intensityValue,
    stability: record.stability,
    difficulty: record.difficulty,
    effectiveStability: record.stability * record.pinFactor,
    entities: record.entityIds.map((entityId) => refEntityName(model, entityId)).sort(),
    mediaRef: record.mediaRef,
    mediaType: record.mediaType,
    createdAt: record.createdAt,
    lastAccess: record.lastAccess,
    accessCount: record.accessCount,
    pinFactor: record.pinFactor,
    confidence: record.confidence,
    source: record.source,
    deleted: record.deleted,
    deletedAt: record.deletedAt,
  };
}

/** `recall()` 的入参。 */
export interface RefV1RecallInput {
  context: string;
  topN?: number;
  now: number;
  includeArchived?: boolean;
}

/** `recall()` 需要的**引擎事实**。 */
export interface RefV1RecallEvidence {
  /** 文本路 FTS 分支的命中行（**引擎事实**：`bm25()` 的原始值来自 SQLite）。 */
  ftsRows: Array<{ refId: string; rawBm25: number | null }>;
  /** 文本路 LIKE 单字兜底分支的命中行。 */
  likeRows: string[];
  /** 真实 id（**只用于同分时的字典序 tie-break**，§4.6 步骤 4）。 */
  realIdOf: (refId: string) => string;
}

/** 一条命中的分值明细（§6 的 `Hit.breakdown`）。 */
export interface RefV1Breakdown extends RefV1ScoreParts {
  rawBm25: number | null;
  cos: number | null;
}

/** 一条命中（参考实现侧）。 */
export interface RefV1RecallHit {
  refId: string;
  score: number;
  breakdown: RefV1Breakdown;
  fromText: boolean;
  fromVector: boolean;
  fromGraph: boolean;
  view: RefV1MemoryView;
}

/** `recall()` 的可观测输出。 */
export interface RefV1RecallOutcome {
  hits: RefV1RecallHit[];
  /** 本次文本路走的分支。 */
  route: RefV1TextRoute;
}

/** §4.6 步骤 2：上下文里出现过的实体（**主名优先**）。 */
function refContextEntityIds(model: RefV1Model, context: string): string[] {
  if (context === '') {
    return [];
  }
  const names: string[] = [];
  for (const entity of model.entities.values()) {
    if (entity.name.length > 0 && context.includes(entity.name)) {
      names.push(entity.name);
    }
  }
  for (const alias of model.aliases.keys()) {
    if (alias.length > 0 && context.includes(alias)) {
      names.push(alias);
    }
  }
  const ids: string[] = [];
  for (const name of names) {
    const entityId = refResolveEntityId(model, name);
    if (entityId !== null && !ids.includes(entityId)) {
      ids.push(entityId);
    }
  }
  return ids;
}

/** §4.6 步骤 2 的粗筛窗口（两个时刻）。 */
function refCoarseCutoffs(
  params: RefV1Params,
  now: number,
  includeArchived: boolean,
): { plain: number; pinned: number } | null {
  if (includeArchived) {
    return null;
  }
  const archiveSpanDays = Math.log(1 / params.ARCHIVE_LINE);
  const plainWindowDays = params.MAX_STABILITY * archiveSpanDays;
  const pinnedWindowDays = params.MAX_STABILITY * params.MAX_PIN_FACTOR * archiveSpanDays;
  return {
    plain: now - plainWindowDays * REF_MS_PER_DAY,
    pinned: now - pinnedWindowDays * REF_MS_PER_DAY,
  };
}

/** §4.6 步骤 2：粗筛 + 强度精筛 + 截断（**保留行上的其余字段**）。 */
function refFilterAndSlice<T extends { refId: string }>(
  model: RefV1Model,
  rows: readonly T[],
  archiveLine: number,
  now: number,
  cutoffs: { plain: number; pinned: number } | null,
): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    const record = model.records.get(row.refId);
    if (record === undefined || record.deleted) {
      continue;
    }
    const intensityValue = model.formulas.intensity(
      record.stability,
      record.pinFactor,
      record.lastAccess,
      now,
    );
    if (!(intensityValue > archiveLine)) {
      continue;
    }
    if (cutoffs !== null) {
      const limit = record.pinFactor > 1.0 ? cutoffs.pinned : cutoffs.plain;
      if (!(record.lastAccess >= limit)) {
        continue;
      }
    }
    kept.push(row);
  }
  return kept.slice(0, REF_ROUTE_CANDIDATE_LIMIT);
}

/**
 * `recall()` 的参考实现（§4.6 的四步）。
 *
 * ⚠️ **向量路整路缺席**（阶段 2 才有向量后端）⇒ `vectorSim` 恒为 0、`fromVector` 恒为 false。
 */
export function refRecall(
  model: RefV1Model,
  input: RefV1RecallInput,
  evidence: RefV1RecallEvidence,
): RefV1RecallOutcome {
  const formulas = model.formulas;
  const params = model.params;
  const at = input.now;
  const topN = formulas.clampTopN(input.topN, params.RECALL_TOP_N);
  const includeArchived = input.includeArchived === true;
  const archiveLine = includeArchived ? 0 : params.ARCHIVE_LINE;

  // ── 步骤 1：上下文实体 ──
  const contextEntityIds = refContextEntityIds(model, input.context);

  // ── 步骤 2a：文本路 ──
  const query = formulas.buildMatchQuery(input.context);
  let route: RefV1TextRoute = 'none';
  let textRows: Array<{ refId: string; rawBm25: number | null }> = [];
  if (query.matchSql !== null && query.matchSql !== '') {
    route = 'fts';
    textRows = evidence.ftsRows;
  } else if (query.fallbackLike !== null && query.fallbackLike !== '') {
    route = 'like';
    textRows = evidence.likeRows.map((refId) => ({ refId, rawBm25: null }));
  }

  // ── 步骤 2b：图谱路 ──
  const graphRows: Array<{ refId: string }> = [];
  for (const refId of model.recordOrder) {
    const record = model.records.get(refId);
    if (record === undefined) {
      continue;
    }
    const hit = record.entityIds.some((entityId) => contextEntityIds.includes(entityId));
    if (hit) {
      graphRows.push({ refId });
    }
  }

  // ── 步骤 2：粗筛 + 精筛 + 截断 ──
  const cutoffs = refCoarseCutoffs(params, at, includeArchived);
  const textKept = refFilterAndSlice(model, textRows, archiveLine, at, cutoffs);
  const graphKept = refFilterAndSlice(model, graphRows, archiveLine, at, cutoffs);

  // ── 步骤 2.5：候选去重合并 ──
  const candidates: Array<{
    refId: string;
    rawBm25: number | null;
    fromText: boolean;
    fromVector: boolean;
    fromGraph: boolean;
  }> = [];
  const byId = new Map<string, (typeof candidates)[number]>();
  for (const row of textKept) {
    byId.set(row.refId, {
      refId: row.refId,
      rawBm25: row.rawBm25 ?? null,
      fromText: true,
      fromVector: false,
      fromGraph: false,
    });
  }
  for (const row of graphKept) {
    const existing = byId.get(row.refId);
    if (existing === undefined) {
      byId.set(row.refId, {
        refId: row.refId,
        rawBm25: null,
        fromText: false,
        fromVector: false,
        fromGraph: true,
      });
      continue;
    }
    existing.fromGraph = true;
  }
  for (const candidate of byId.values()) {
    candidates.push(candidate);
  }

  // ── 步骤 3：融合打分 ──
  const normValues = formulas.normalizeBm25(
    candidates.map((candidate) => candidate.rawBm25),
    route,
  );
  const hits: RefV1RecallHit[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const record = model.records.get(candidate.refId);
    if (record === undefined) {
      continue;
    }
    const intensityValue = formulas.intensity(
      record.stability,
      record.pinFactor,
      record.lastAccess,
      at,
    );
    const normBm25Value = normValues[index] ?? 0;
    const graphProximityValue = record.entityIds.some((entityId) =>
      contextEntityIds.includes(entityId),
    )
      ? 1
      : 0;
    const recencyValue = formulas.recency(record.createdAt, params, at);
    const fused = formulas.fuse({
      intensity: intensityValue,
      vectorSim: 0,
      normBm25: normBm25Value,
      graphProximity: graphProximityValue,
      recency: recencyValue,
    });
    const view = refGet(model, candidate.refId, at);
    if (view === null) {
      continue;
    }
    hits.push({
      refId: candidate.refId,
      score: fused.score,
      breakdown: {
        ...fused.breakdown,
        rawBm25: candidate.rawBm25,
        cos: null,
      },
      fromText: candidate.fromText,
      fromVector: candidate.fromVector,
      fromGraph: candidate.fromGraph,
      view,
    });
  }

  // ── 步骤 4：排序（分数降序，同分按 id 字典序）+ 截断 ──
  const ordered = [...hits].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const leftId = evidence.realIdOf(left.refId);
    const rightId = evidence.realIdOf(right.refId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

  return { hits: ordered.slice(0, topN), route };
}
