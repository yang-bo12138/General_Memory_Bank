/**
 * golden 采集器 / 比对器的单测 —— DEVELOPMENT-PLAN.md P0-T03。
 *
 * ⚠️ **本阶段的验收是「比对机制可用」，不是「基线已达成」**：
 *   真正的「与 v1.0 逐位一致」需要 v1.0 参考实现，而 v1.0 代码不在本仓库（D-10）⇒
 *   真正的基线达成点在 P1-T09 末，并在 P3-T06、P4-T07 再验两次。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveFlags, toBaselineParams } from '../../src/core/flags.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { DeterministicAdapter } from '../fixtures/adapters/deterministic.js';
import {
  canonicalJson,
  metaOf,
  parseGolden,
  recordsOf,
  serializeGolden,
  writeGoldenFile,
} from '../golden/golden-format.js';
import { assertGoldenIdentical, compareGoldenRecords } from './compare.js';
import { STANDARD_SCENARIO, captureRefV1Run, runScenario } from './ref-v1.js';

describe('P0-T03 · golden 格式（JSONL，D-08）', () => {
  it('每行一条 JSON；解析后能原样还原', () => {
    const lines = [
      { kind: 'meta' as const, label: 'baseline', flags: {}, params: {} },
      { kind: 'record' as const, op: 'write', args: { content: 'x' }, output: { id: 'm1' } },
    ];
    const text = serializeGolden(lines);
    expect(text.trimEnd().split('\n')).toHaveLength(2);
    expect(parseGolden(text)).toEqual(lines);
  });

  it('规范化 JSON：键序不影响序列化结果（否则「逐位一致」会假失败）', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('非法 JSON 报错并指出行号', () => {
    expect(() => parseGolden('{"kind":"meta"}\nnot-json\n')).toThrow(/第 2 行/);
  });

  it('meta 行与 record 行可区分', () => {
    const lines = parseGolden(
      '{"kind":"meta","label":"x","flags":{},"params":{}}\n{"kind":"record","op":"stats","args":{},"output":{}}\n',
    );
    expect(metaOf(lines)?.label).toBe('x');
    expect(recordsOf(lines)).toHaveLength(1);
    expect(recordsOf(lines)[0]?.op).toBe('stats');
  });
});

describe('P0-T03 · 基线比对机制可用', () => {
  it('采集器可运行：标准场景产出五条观测记录', () => {
    const adapter = new DeterministicAdapter();
    const records = runScenario(adapter, STANDARD_SCENARIO);
    expect(records.map((record) => record.op)).toEqual([
      'write',
      'write',
      'recall',
      'touch',
      'get',
      'stats',
    ]);
  });

  it('采集器可运行：场景占位符被解析成真实 id', () => {
    const adapter = new DeterministicAdapter();
    const records = runScenario(adapter, STANDARD_SCENARIO);
    const touch = records.find((record) => record.op === 'touch');
    const get = records.find((record) => record.op === 'get');
    expect((touch?.args as { ids: string[] }).ids).toEqual(['m1', 'm2']);
    expect((get?.args as { id: string }).id).toBe('m1');
  });

  it('★ 基线组 vs 单开一个开关 ⇒ write/recall/touch/get/stats 输出逐位相同', () => {
    const baselineParams = toBaselineParams(DEFAULT_PARAMS);
    const oneFlagOnParams = { ...baselineParams, coactivation: true };

    const baseline = captureRefV1Run(new DeterministicAdapter(), {
      label: 'baseline',
      flags: resolveFlags(baselineParams) as unknown as Record<string, unknown>,
      params: baselineParams as unknown as Record<string, unknown>,
    });
    const oneFlagOn = captureRefV1Run(new DeterministicAdapter(), {
      label: 'baseline+coactivation',
      flags: resolveFlags(oneFlagOnParams) as unknown as Record<string, unknown>,
      params: oneFlagOnParams as unknown as Record<string, unknown>,
    });

    // meta 行本来就该不同（这正是这次比对的**前提**）
    expect(canonicalJson(metaOf(baseline))).not.toBe(canonicalJson(metaOf(oneFlagOn)));

    // record 行必须逐位相同
    assertGoldenIdentical(
      recordsOf(baseline),
      recordsOf(oneFlagOn),
      '四开关全关 + flat vs 单开 coactivation',
    );
    expect(compareGoldenRecords(recordsOf(baseline), recordsOf(oneFlagOn)).identical).toBe(true);
  });

  it('★ 比对器**能发现**差异（否则上条断言就是假绿）', () => {
    const left = runScenario(new DeterministicAdapter(), STANDARD_SCENARIO);
    const right = runScenario(new DeterministicAdapter(), STANDARD_SCENARIO);
    // 人为制造一处差异
    const mutated = right.map((record, index) =>
      index === 2 ? { ...record, output: { hits: [], topN: 5 } } : record,
    );

    const result = compareGoldenRecords(left, mutated);
    expect(result.identical).toBe(false);
    expect(result.firstDiff?.index).toBe(2);
    expect(result.firstDiff?.reason).toContain('第 2 条记录不一致');
    expect(() => assertGoldenIdentical(left, mutated)).toThrow(/不逐位相同/);
  });

  it('★ 比对器能发现「条数不一致」', () => {
    const left = runScenario(new DeterministicAdapter(), STANDARD_SCENARIO);
    const result = compareGoldenRecords(left, left.slice(0, 3));
    expect(result.identical).toBe(false);
    expect(result.firstDiff?.reason).toContain('记录条数不一致');
  });

  it('golden 文件可落盘并原样读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-golden-'));
    const path = join(dir, 'run.jsonl');
    const lines = captureRefV1Run(new DeterministicAdapter(), {
      label: 'baseline',
      flags: {},
      params: {},
    });
    writeGoldenFile(path, lines);
    const text = readFileSync(path, 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(lines.length);
    expect(parseGolden(text)).toEqual(lines);
  });
});
