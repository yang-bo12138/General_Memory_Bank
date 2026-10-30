/**
 * 五个机制开关与基线条件的单测 —— DESIGN-v2.md §5（ADR-21）。
 */

import { describe, expect, it } from 'vitest';

import {
  BASELINE_FLAGS,
  BOOLEAN_FLAG_KEYS,
  FEATURE_FLAG_SPEC,
  isBaselineConfig,
  resolveFlags,
  resolveVectorBackendState,
  toBaselineParams,
} from './flags.js';
import { DEFAULT_PARAMS, type Params } from './params.js';

/** 造一份改了开关的参数集合。 */
function withFlag(key: keyof Params, value: boolean | string): Params {
  return { ...DEFAULT_PARAMS, [key]: value } as Params;
}

describe('P0-T03 · 五个机制开关', () => {
  it('四个布尔开关 + 一个三值选择器，规格表与默认参数一致', () => {
    expect(BOOLEAN_FLAG_KEYS).toHaveLength(4);
    expect(FEATURE_FLAG_SPEC.map((entry) => entry.key)).toEqual([
      'coactivation',
      'inhibition',
      'writeBack',
      'ARCHIVAL_CACHE',
      'VECTOR_ROUTER',
    ]);
    const flags = resolveFlags(DEFAULT_PARAMS);
    expect(flags.coactivation).toBe(true);
    expect(flags.inhibition).toBe(true);
    expect(flags.writeBack).toBe(true);
    expect(flags.ARCHIVAL_CACHE).toBe(true);
    expect(flags.VECTOR_ROUTER).toBe('auto');
  });

  it('开关大小写：前三个小写、后两个大写（§5 刻意如此）', () => {
    expect(BOOLEAN_FLAG_KEYS.slice(0, 3)).toEqual(['coactivation', 'inhibition', 'writeBack']);
    expect(BOOLEAN_FLAG_KEYS[3]).toBe('ARCHIVAL_CACHE');
    expect(Object.keys(DEFAULT_PARAMS)).toContain('ARCHIVAL_CACHE');
    expect(Object.keys(DEFAULT_PARAMS)).toContain('VECTOR_ROUTER');
  });

  it('运行时可切换：改参数后下一次 resolveFlags 立即生效（不在 open() 快照）', () => {
    const before = resolveFlags(DEFAULT_PARAMS);
    expect(before.coactivation).toBe(true);

    // 模拟 setParams() 之后的下一次调用
    const after = resolveFlags(withFlag('coactivation', false));
    expect(after.coactivation).toBe(false);
    expect(after.inhibition).toBe(true);
  });

  it('VECTOR_ROUTER 的三个取值都能被设置，且互相可区分', () => {
    expect(resolveFlags(withFlag('VECTOR_ROUTER', 'auto')).VECTOR_ROUTER).toBe('auto');
    expect(resolveFlags(withFlag('VECTOR_ROUTER', 'ivf')).VECTOR_ROUTER).toBe('ivf');
    expect(resolveFlags(withFlag('VECTOR_ROUTER', 'flat')).VECTOR_ROUTER).toBe('flat');
  });
});

describe('P0-T03 · 基线条件（完整）', () => {
  it('基线 = 四个布尔开关全关 + VECTOR_ROUTER=flat', () => {
    expect(isBaselineConfig(toBaselineParams(DEFAULT_PARAMS))).toBe(true);
    expect(BASELINE_FLAGS).toEqual({
      coactivation: false,
      inhibition: false,
      writeBack: false,
      ARCHIVAL_CACHE: false,
      VECTOR_ROUTER: 'flat',
    });
  });

  it('默认配置**不构成**基线（VECTOR_ROUTER 默认是 auto）', () => {
    expect(isBaselineConfig(DEFAULT_PARAMS)).toBe(false);
  });

  it('四个开关全关但 VECTOR_ROUTER=auto ⇒ 仍不构成基线', () => {
    const params: Params = {
      ...DEFAULT_PARAMS,
      coactivation: false,
      inhibition: false,
      writeBack: false,
      ARCHIVAL_CACHE: false,
      VECTOR_ROUTER: 'auto',
    };
    expect(isBaselineConfig(params)).toBe(false);
  });

  it('ARCHIVAL_CACHE 也纳入基线组（结果相同但路径不同，字面上必须成立）', () => {
    const params: Params = {
      ...DEFAULT_PARAMS,
      coactivation: false,
      inhibition: false,
      writeBack: false,
      ARCHIVAL_CACHE: false,
      VECTOR_ROUTER: 'flat',
    };
    expect(params.ARCHIVAL_CACHE).toBe(false);
    expect(BASELINE_FLAGS.ARCHIVAL_CACHE).toBe(false);
  });

  it('toBaselineParams 只动五个开关，其余 55 项一字不改', () => {
    const baseline = toBaselineParams(DEFAULT_PARAMS);
    const changed = Object.keys(DEFAULT_PARAMS).filter(
      (key) => DEFAULT_PARAMS[key as keyof Params] !== baseline[key as keyof Params],
    );
    expect(changed.sort()).toEqual(
      ['ARCHIVAL_CACHE', 'VECTOR_ROUTER', 'coactivation', 'inhibition', 'writeBack'].sort(),
    );
    expect(Object.keys(baseline)).toHaveLength(60);
  });
});

describe('P0-T03 · 向量路后端状态（C36：配置与状态不得共用同一套词）', () => {
  const belowThreshold = { embeddedCount: 100, hasTrainedBuckets: false, inRetrain: false };
  const aboveThreshold = { embeddedCount: 20_000, hasTrainedBuckets: true, inRetrain: false };
  const aboveThresholdUntrained = {
    embeddedCount: 20_000,
    hasTrainedBuckets: false,
    inRetrain: false,
  };

  it("'flat' ⇒ flat_explicit（无论库规模）", () => {
    const params = withFlag('VECTOR_ROUTER', 'flat');
    expect(resolveVectorBackendState(params, belowThreshold).mode).toBe('flat_explicit');
    expect(resolveVectorBackendState(params, aboveThreshold).mode).toBe('flat_explicit');
  });

  it("'auto' 低于门槛 ⇒ flat_auto（库太小自动降级）", () => {
    const params = withFlag('VECTOR_ROUTER', 'auto');
    expect(resolveVectorBackendState(params, belowThreshold).mode).toBe('flat_auto');
  });

  it("'auto' 过门槛且分桶已训练 ⇒ ivf（'auto' 必须真的自动，不是死值）", () => {
    const params = withFlag('VECTOR_ROUTER', 'auto');
    expect(resolveVectorBackendState(params, aboveThreshold).mode).toBe('ivf');
  });

  it("'auto' 过门槛但分桶未训练 ⇒ absent（向量路整体缺席，不静默回落 flat）", () => {
    const params = withFlag('VECTOR_ROUTER', 'auto');
    const state = resolveVectorBackendState(params, aboveThresholdUntrained);
    expect(state.mode).toBe('absent');
    expect(state.inRetrain).toBe(false);
  });

  it("'ivf' 低于门槛 ⇒ 仍走 ivf（强制建桶 + 记 warn，不静默回落）", () => {
    const params = withFlag('VECTOR_ROUTER', 'ivf');
    expect(resolveVectorBackendState(params, belowThreshold).mode).toBe('ivf');
  });

  it("'ivf' 过门槛但分桶未训练 ⇒ absent（不静默走 ivf：桶表为空 ⇒ 向量路恒空）", () => {
    const params = withFlag('VECTOR_ROUTER', 'ivf');
    expect(resolveVectorBackendState(params, aboveThresholdUntrained).mode).toBe('absent');
  });

  it('inRetrain 仅在 mode=absent 时有意义；其余模式恒为 false', () => {
    const params = withFlag('VECTOR_ROUTER', 'auto');
    expect(resolveVectorBackendState(params, belowThreshold).inRetrain).toBe(false);
    expect(resolveVectorBackendState(params, aboveThreshold).inRetrain).toBe(false);
    expect(
      resolveVectorBackendState(params, { ...aboveThresholdUntrained, inRetrain: true }).inRetrain,
    ).toBe(true);
  });

  it('mode 的四个字面量互不相同（不是 mode + flatReason 两个字段）', () => {
    const modes = new Set([
      resolveVectorBackendState(withFlag('VECTOR_ROUTER', 'flat'), aboveThreshold).mode,
      resolveVectorBackendState(withFlag('VECTOR_ROUTER', 'auto'), belowThreshold).mode,
      resolveVectorBackendState(withFlag('VECTOR_ROUTER', 'auto'), aboveThreshold).mode,
      resolveVectorBackendState(withFlag('VECTOR_ROUTER', 'auto'), aboveThresholdUntrained).mode,
    ]);
    expect([...modes].sort()).toEqual(['absent', 'flat_auto', 'flat_explicit', 'ivf']);
  });
});
