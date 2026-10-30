/**
 * 参数表与跨参数校验的单测 —— DESIGN-v2.md §5。
 *
 * 覆盖的验收硬断言（DEVELOPMENT-PLAN.md P0-T02）：
 * · §5 表 ↔ `DEFAULT_PARAMS` **逐键逐值相等**（键集合相同、值相同、默认值相同）
 * · 8 条跨参数校验**逐条**有单测：构造非法组合 ⇒ 抛 `INVALID_INPUT`
 * · `setParams({ EMBED_DIM: 1024 })` ⇒ 抛 `INVALID_INPUT`
 * · `setParams({ REDUNDANCY_COS: 0.95 })` ⇒ `details.REDUNDANCY_COS.maxAllowed === 0.92`
 * · **刻意不做的联动校验**确实没做（否则两个独立旋钮被绑死，§11.4 的前提就没了）
 */

import { describe, expect, it } from 'vitest';

import { MemoryError } from './errors.js';
import {
  COACT_AFFINITY_MAX_DDL_CHECK,
  DEFAULT_PARAMS,
  PARAM_COUNT,
  PARAM_KEYS,
  type Params,
  VECTOR_OVERFETCH_FACTOR,
  VECTOR_ROUTER_MODES,
  applyParamPatch,
  validateParams,
} from './params.js';

/**
 * §6 的 `DEFAULT_PARAMS` 代码块的**独立副本**。
 *
 * ⚠️ 这份副本是「§5 ↔ 代码」的**手工对照物**：它与 `src/core/params.ts` 里的那份
 *   分处两个文件 ⇒ 任何一侧被误改，`toEqual` 立刻失败。
 *   ⇒ 它与 `scripts/check-params.ts`（从 DESIGN-v2.md **自动**解析 §5 的那张表）互为独立证据。
 */
const DESIGN_SECTION_6_PARAMS = {
  MAX_STABILITY: 180,
  MAX_PIN_FACTOR: 5.0,
  THRESHOLD_L3: 0.7,
  THRESHOLD_L2: 0.3,
  ARCHIVE_LINE: 0.05,
  EDGE_STABILITY: 30,
  MAX_EDGE_WEIGHT: 3.0,
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
  INITIAL_EDGE_WEIGHT: 0.8,
  EDGE_REINFORCE_STEP: 0.3,
  RECALL_TOP_N: 5,
  EMBED_DIM: 768,
  VECTOR_TOPK: 20,
  VECTOR_MIN_COS: 0.25,
  ACTIVATION_DECAY: 0.2,
  ACTIVATION_MIN: 0.15,
  MAX_DIFFUSED_NODES: 20,
  MAX_DIFFUSED_VISITS: 200,
  RECENCY_DECAY_DAYS: 14,
  SWEEP_BATCH_SIZE: 500,
  COACT_AFFINITY_MAX: 1.0,
  COACT_AFFINITY_MIN: 0.15,
  COACT_REINFORCE_STEP: 0.2,
  COACT_CAUSAL_BONUS: 0.25,
  COACT_STABILITY: 21,
  COACT_MIN_ENTITIES: 2,
  COACT_MIN_COS: 0.5,
  COACT_MAX_PAIRS_PER_TOUCH: 20,
  COACT_BATCH_MAX: 256,
  CLUSTER_TOPK: 3,
  MAX_CLUSTER_SHARE: 0.5,
  CLUSTER_MAX_FRACTION: 0.02,
  CLUSTER_MEMBER_SAMPLE_MAX: 50,
  CLUSTER_RECALC_INTERVAL_MS: 3600000,
  REDUNDANCY_COS: 0.9,
  ROUTER_COARSE_CENTERS: 200,
  ROUTER_FINE_CENTERS: 10000,
  ROUTER_NPROBE_COARSE: 20,
  ROUTER_NPROBE_FINE: 50,
  ROUTER_BUCKET_MAX: 300,
  ROUTER_NPROBE_WRITE_COARSE: 8,
  ROUTER_NPROBE_WRITE_FINE: 20,
  COACT_DEGREE_MAX: 32,
  ROUTER_MIN_TRAINING: 10000,
  VECTOR_ROUTER: 'auto',
  CLUSTER_BONUS: 0.4,
  ARCHIVAL_ORPHAN_CHECK: 1000,
  coactivation: true,
  inhibition: true,
  writeBack: true,
  ARCHIVAL_CACHE: true,
} as const;

/** 造一份「改了某几个键」的参数集合。 */
function withOverrides(overrides: Partial<Params>): Params {
  return { ...DEFAULT_PARAMS, ...overrides } as Params;
}

/** 断言某个补丁会抛 `INVALID_INPUT`，并返回错误的 `details`。 */
function expectInvalidInput(patch: Parameters<typeof applyParamPatch>[1]): MemoryError {
  let caught: unknown;
  try {
    applyParamPatch(DEFAULT_PARAMS, patch);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MemoryError);
  const memoryError = caught as MemoryError;
  expect(memoryError.code).toBe('INVALID_INPUT');
  return memoryError;
}

describe('P0-T02 · DEFAULT_PARAMS 与 §5/§6 逐键逐值相等', () => {
  it('参数总数恰好 60', () => {
    expect(Object.keys(DEFAULT_PARAMS)).toHaveLength(PARAM_COUNT);
    expect(PARAM_KEYS).toHaveLength(PARAM_COUNT);
  });

  it('键集合与 §6 的代码块完全相同', () => {
    expect(new Set(Object.keys(DEFAULT_PARAMS))).toEqual(
      new Set(Object.keys(DESIGN_SECTION_6_PARAMS)),
    );
  });

  it('每个键的默认值与 §6 的代码块逐值相等', () => {
    expect(DEFAULT_PARAMS).toEqual(DESIGN_SECTION_6_PARAMS);
  });

  it('五个机制开关的大小写与设计一致（前三个小写、后两个大写）', () => {
    expect(DEFAULT_PARAMS.coactivation).toBe(true);
    expect(DEFAULT_PARAMS.inhibition).toBe(true);
    expect(DEFAULT_PARAMS.writeBack).toBe(true);
    expect(DEFAULT_PARAMS.ARCHIVAL_CACHE).toBe(true);
    expect(DEFAULT_PARAMS.VECTOR_ROUTER).toBe('auto');
  });

  it('默认参数通过全部 8 条跨参数校验', () => {
    expect(validateParams(DEFAULT_PARAMS)).toEqual([]);
  });

  it('C26：VECTOR_OVERFETCH_FACTOR 是硬编码 3 且不开放为参数', () => {
    expect(VECTOR_OVERFETCH_FACTOR).toBe(3);
    expect(Object.keys(DEFAULT_PARAMS)).not.toContain('VECTOR_OVERFETCH_FACTOR');
  });

  it('跨参数校验第 8 条：COACT_AFFINITY_MAX 的上界与 §3 的 CHECK 同步', () => {
    expect(DEFAULT_PARAMS.COACT_AFFINITY_MAX).toBe(COACT_AFFINITY_MAX_DDL_CHECK);
  });
});

describe('P0-T02 · 8 条跨参数校验（逐条）', () => {
  it('第 1 条：0 < REDUNDANCY_COS ≤ DEDUP_COS_MIN（方向是 ≤ 不是 <）', () => {
    // 0.90 ≤ 0.92 默认合法；0.92 也合法（等号必须放行）
    expect(validateParams(withOverrides({ REDUNDANCY_COS: 0.92 }))).toEqual([]);
    // 0.95 > 0.92 ⇒ 非法，且 details 必须带上建议上界
    const error = expectInvalidInput({ REDUNDANCY_COS: 0.95 });
    expect(error.details.REDUNDANCY_COS).toMatchObject({
      current: 0.95,
      maxAllowed: 0.92,
    });
    // ≤ 0 ⇒ 非法
    expectInvalidInput({ REDUNDANCY_COS: 0 });
  });

  it('第 2 条：COACT_AFFINITY_MAX > COACT_REINFORCE_STEP + COACT_CAUSAL_BONUS（严格大于）', () => {
    // 默认 1.0 > 0.20 + 0.25 = 0.45 ✓
    expect(validateParams(DEFAULT_PARAMS)).toEqual([]);
    // ★ MAX == base 也顶格 ⇒ 必须是严格大于 ⇒ 0.45 非法
    const error = expectInvalidInput({ COACT_AFFINITY_MAX: 0.45 });
    expect(error.details.COACT_AFFINITY_MAX).toMatchObject({ current: 0.45, minAllowed: 0.45 });
    expectInvalidInput({ COACT_AFFINITY_MAX: 0.4 });
  });

  it('第 3 条：COACT_REINFORCE_STEP ≥ COACT_AFFINITY_MIN', () => {
    expect(validateParams(withOverrides({ COACT_REINFORCE_STEP: 0.15 }))).toEqual([]);
    const error = expectInvalidInput({ COACT_REINFORCE_STEP: 0.1 });
    expect(error.details.COACT_REINFORCE_STEP).toMatchObject({ current: 0.1, minAllowed: 0.15 });
  });

  it('第 4 条：COACT_MIN_ENTITIES >= 1、COACT_MIN_COS ∈ (0,1]', () => {
    expectInvalidInput({ COACT_MIN_ENTITIES: 0 });
    expectInvalidInput({ COACT_MIN_COS: 0 });
    expectInvalidInput({ COACT_MIN_COS: 1.5 });
    // 边界：1 与 1 都合法
    expect(validateParams(withOverrides({ COACT_MIN_ENTITIES: 1, COACT_MIN_COS: 1 }))).toEqual([]);
  });

  it('第 5 条：COACT_MAX_PAIRS_PER_TOUCH >= 1、COACT_BATCH_MAX >= 1', () => {
    expectInvalidInput({ COACT_MAX_PAIRS_PER_TOUCH: 0 });
    expectInvalidInput({ COACT_BATCH_MAX: 0 });
    expect(
      validateParams(withOverrides({ COACT_MAX_PAIRS_PER_TOUCH: 1, COACT_BATCH_MAX: 1 })),
    ).toEqual([]);
  });

  it('第 6 条：ROUTER_NPROBE_COARSE ≥ 1 且 ROUTER_NPROBE_FINE ≥ 1', () => {
    expectInvalidInput({ ROUTER_NPROBE_COARSE: 0 });
    expectInvalidInput({ ROUTER_NPROBE_FINE: 0 });
    expect(
      validateParams(withOverrides({ ROUTER_NPROBE_COARSE: 1, ROUTER_NPROBE_FINE: 1 })),
    ).toEqual([]);
  });

  it('第 7 条：探针数不得大于中心数（写入路径的两个探针数同理）', () => {
    expectInvalidInput({ ROUTER_COARSE_CENTERS: 19 });
    expectInvalidInput({ ROUTER_FINE_CENTERS: 49 });
    // 写入路径：COARSE 需 ≥ 8、FINE 需 ≥ 20
    expectInvalidInput({ ROUTER_COARSE_CENTERS: 7 });
    expectInvalidInput({ ROUTER_FINE_CENTERS: 19 });
    // 等号必须放行
    expect(
      validateParams(
        withOverrides({
          ROUTER_COARSE_CENTERS: 20,
          ROUTER_FINE_CENTERS: 50,
        }),
      ),
    ).toEqual([]);
  });

  it('第 8 条：COACT_AFFINITY_MAX 不得高于 §3 的 CHECK 上界 1.0', () => {
    const error = expectInvalidInput({ COACT_AFFINITY_MAX: 1.5 });
    expect(error.details.COACT_AFFINITY_MAX).toMatchObject({ current: 1.5, maxAllowed: 1.0 });
  });
});

describe('P0-T02 · 刻意不做的联动校验（不得「顺手」加上）', () => {
  it('COACT_MIN_COS 与 REDUNDANCY_COS 不联动', () => {
    expect(validateParams(withOverrides({ COACT_MIN_COS: 0.01, REDUNDANCY_COS: 0.9 }))).toEqual([]);
  });

  it('COACT_MIN_ENTITIES 与 DEDUP_ENTITY_MIN 不联动', () => {
    expect(validateParams(withOverrides({ COACT_MIN_ENTITIES: 1, DEDUP_ENTITY_MIN: 9 }))).toEqual(
      [],
    );
  });
});

describe('P0-T02 · 只读参数与取值合法性', () => {
  it('EMBED_DIM 是只读参数：运行期传它抛 INVALID_INPUT', () => {
    const error = expectInvalidInput({ EMBED_DIM: 1024 } as Parameters<typeof applyParamPatch>[1]);
    expect(error.details.EMBED_DIM).toMatchObject({ current: 768 });
  });

  it('未知键抛 INVALID_INPUT', () => {
    expectInvalidInput({ NOT_A_PARAM: 1 } as Parameters<typeof applyParamPatch>[1]);
  });

  it('类型不匹配抛 INVALID_INPUT', () => {
    expectInvalidInput({ MAX_STABILITY: '180' } as unknown as Parameters<
      typeof applyParamPatch
    >[1]);
  });

  it('VECTOR_ROUTER 的三个取值都合法，第四个非法', () => {
    for (const mode of VECTOR_ROUTER_MODES) {
      expect(validateParams(withOverrides({ VECTOR_ROUTER: mode }))).toEqual([]);
    }
    expectInvalidInput({ VECTOR_ROUTER: 'ann' } as unknown as Parameters<
      typeof applyParamPatch
    >[1]);
  });
});

describe('P0-T02 · 补丁应用的原子性', () => {
  it('校验失败时抛错，且不返回任何「改了一半」的结果', () => {
    const before = DEFAULT_PARAMS;
    expect(() => applyParamPatch(before, { REDUNDANCY_COS: 0.95 })).toThrow(MemoryError);
    // 输入对象未被就地修改
    expect(before.REDUNDANCY_COS).toBe(0.9);
  });

  it('合法补丁返回合并后的全量参数', () => {
    const next = applyParamPatch(DEFAULT_PARAMS, { ARCHIVE_LINE: 0.1 });
    expect(next.ARCHIVE_LINE).toBe(0.1);
    expect(next.MAX_STABILITY).toBe(DEFAULT_PARAMS.MAX_STABILITY);
    expect(Object.keys(next)).toHaveLength(PARAM_COUNT);
  });
});
