/**
 * CI 契约门禁脚本的单测 —— DEVELOPMENT-PLAN.md P0-T06。
 *
 * ⚠️ 每个门禁脚本都必须有一个**反例**用例：
 *   只测「通过」的话，一个「永远返回通过」的脚本也能全绿 ⇒ 闸门形同虚设。
 */

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_ANCHOR_ROWS,
  compareAnchorRows,
  findAnchorTable,
  normalizeCell,
} from '../../scripts/check-anchor.js';
import {
  checkContracts,
  parseSection5ValidationCount,
  parseSection6Params,
  parseSection11_2Methods,
  parseSection12ValidationReference,
} from '../../scripts/check-contract-ids.js';
import { compareParams, parseSection5Params } from '../../scripts/check-params.js';
import {
  comparePayloadKeys,
  parseSection8_4PayloadKeys,
  parseSweepActionGroups,
} from '../../scripts/check-payload-keys.js';
import {
  extractBacktickSpans,
  extractPayloadKeys,
  parseAllTableRows,
  parseDefaultCell,
  readDesignDoc,
  splitByTopLevelComma,
  splitTableRow,
  stripBlockquote,
} from '../../scripts/lib/design-doc.js';
import { EVENT_PAYLOAD_KEYS, EVENT_TYPES } from '../../src/core/events.types.js';
import {
  CROSS_PARAM_VALIDATION_COUNT,
  DEFAULT_PARAMS,
  VECTOR_OVERFETCH_FACTOR,
} from '../../src/core/params.js';

const markdown = readDesignDoc();

describe('P0-T06 · 设计稿解析器（逐条可测）', () => {
  it('去掉引用标记', () => {
    expect(stripBlockquote('> | a | b |')).toBe('| a | b |');
    expect(stripBlockquote('>> x')).toBe('x');
  });

  it('拆表格行：处理转义竖线', () => {
    const cells = splitTableRow("| a | action('x'\\|'y') | b |");
    expect(cells).toHaveLength(3);
    expect(cells[1]).toContain('action(');
  });

  it('按括号深度切逗号：`Array<{ key, from, to }>` 不被切碎', () => {
    expect(splitByTopLevelComma('changed: Array<{ key, from, to }>')).toHaveLength(1);
    expect(splitByTopLevelComma('a, b, c')).toHaveLength(3);
  });

  it('解析默认值：带单位 / 带引号 / 布尔', () => {
    expect(parseDefaultCell('180 天')).toBe(180);
    expect(parseDefaultCell('1.0 天')).toBe(1);
    expect(parseDefaultCell('0.50')).toBe(0.5);
    expect(parseDefaultCell("'auto'")).toBe('auto');
    expect(parseDefaultCell('true')).toBe(true);
    expect(parseDefaultCell('')).toBeUndefined();
  });

  it('抽反引号片段', () => {
    expect(extractBacktickSpans('`a` 与 `b`')).toEqual(['a', 'b']);
  });

  it('抽 payload 键：`IDENT: 值` 只有 Array<> 形态才算键', () => {
    expect(extractPayloadKeys('`changed: Array<{ key, from, to }>`')).toEqual(['changed']);
    expect(extractPayloadKeys('`diagnostics: true`')).toEqual([]);
  });

  it('抽 payload 键：`IDENT(...)` 必须含带引号的字符串', () => {
    expect(extractPayloadKeys("`action('set'/'merge')`")).toEqual(['action']);
    expect(extractPayloadKeys('`setParams()`')).toEqual([]);
  });

  it('抽 payload 键：排除名单生效', () => {
    expect(extractPayloadKeys('`memory_id` 一律填 null', ['memory_id'])).toEqual([]);
  });
});

describe('P0-T06 · check-params（§5 ↔ DEFAULT_PARAMS）', () => {
  it('§5 解析出恰好 60 项', () => {
    const parsed = parseSection5Params(markdown);
    expect(parsed.size).toBe(60);
  });

  it('逐键逐值相等', () => {
    const parsed = parseSection5Params(markdown);
    const diffs = compareParams(parsed, DEFAULT_PARAMS as never);
    expect(diffs).toEqual([]);
  });

  it('★ 反例：改一个参数默认值 ⇒ 失败并指出是哪个键', () => {
    const parsed = parseSection5Params(markdown);
    const broken = { ...DEFAULT_PARAMS, ARCHIVE_LINE: 0.06 } as never;
    const diffs = compareParams(parsed, broken);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.key).toBe('ARCHIVE_LINE');
    expect(diffs[0]?.reason).toContain('默认值不一致');
  });

  it('★ 反例：代码里多一个键 ⇒ 失败', () => {
    const parsed = parseSection5Params(markdown);
    const broken = { ...DEFAULT_PARAMS, EXTRA_PARAM: 1 } as never;
    const diffs = compareParams(parsed, broken);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.reason).toContain('§5 表里没有');
  });
});

describe('P0-T06 · check-payload-keys（§8.4 键集）', () => {
  it('§8.4 解析出 13 种 type', () => {
    const parsed = parseSection8_4PayloadKeys(markdown);
    expect([...parsed.keys()].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('逐键一致', () => {
    const parsed = parseSection8_4PayloadKeys(markdown);
    expect(comparePayloadKeys(parsed, EVENT_PAYLOAD_KEYS)).toEqual([]);
  });

  it('sweep 的四个 action 分组被解析出来', () => {
    const section = readDesignDoc();
    const groups = parseSweepActionGroups(section);
    expect(Object.keys(groups).sort()).toEqual([
      'purge',
      'rebuildArchive',
      'rebuildBuckets',
      'recluster',
    ]);
  });

  it('★ 反例：代码少一个键 ⇒ 失败并指出是哪个 type', () => {
    const parsed = parseSection8_4PayloadKeys(markdown);
    const broken = {
      ...EVENT_PAYLOAD_KEYS,
      touch: EVENT_PAYLOAD_KEYS.touch.filter((key) => key !== 'coactSkipped'),
    };
    const diffs = comparePayloadKeys(parsed, broken);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.type).toBe('touch');
    expect(diffs[0]?.reason).toContain('coactSkipped');
  });

  it('★ 反例：代码多一个键 ⇒ 失败', () => {
    const parsed = parseSection8_4PayloadKeys(markdown);
    const broken = {
      ...EVENT_PAYLOAD_KEYS,
      pin: [...EVENT_PAYLOAD_KEYS.pin, 'inventedKey'],
    };
    const diffs = comparePayloadKeys(parsed, broken);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.reason).toContain('inventedKey');
  });
});

describe('P0-T06 · check-anchor（跨节锚定 5 行 × 3 列）', () => {
  it('§14.3.1 里的锚定表恰好 5 行', () => {
    const rows = findAnchorTable(markdown);
    expect(rows).toHaveLength(5);
  });

  it('逐行逐列与写死的期望一致', () => {
    const rows = findAnchorTable(markdown) ?? [];
    expect(compareAnchorRows(rows)).toEqual([]);
  });

  it('每行恰好 3 列', () => {
    const rows = findAnchorTable(markdown) ?? [];
    for (const row of rows) {
      expect(row).toHaveLength(3);
    }
  });

  it('★ 反例：错列 ⇒ 失败（错列比缺行更危险）', () => {
    const rows = (findAnchorTable(markdown) ?? []).map((row) => [...row]);
    // 把第 1 行的「管辖路径」换成第 2 行的 ⇒ 静默地校验到错误的路径上
    if (rows.length >= 2 && rows[0] !== undefined && rows[1] !== undefined) {
      rows[0][2] = rows[1][2] ?? '';
    }
    const diffs = compareAnchorRows(rows);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs[0]?.reason).toContain('管辖路径');
  });

  it('★ 反例：少一行 ⇒ 失败', () => {
    const rows = (findAnchorTable(markdown) ?? []).slice(0, 4);
    const diffs = compareAnchorRows(rows);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs[0]?.reason).toContain('行数不一致');
  });

  it('规范化只去掉排版，不动内容', () => {
    expect(normalizeCell('**粗体**  文本')).toBe('粗体 文本');
  });

  it('写死的期望恰好五行', () => {
    expect(EXPECTED_ANCHOR_ROWS).toHaveLength(5);
  });
});

describe('P0-T06 · check-contract-ids（C25 / C26 / §5 的 8 条 / §11.2）', () => {
  it('§5 的跨参数校验编号是连续的 1~8', () => {
    expect(parseSection5ValidationCount(markdown)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('§12 引用的条数 = 代码里的条数 = 8', () => {
    expect(parseSection12ValidationReference(markdown)).toBe(CROSS_PARAM_VALIDATION_COUNT);
    expect(CROSS_PARAM_VALIDATION_COUNT).toBe(8);
  });

  it('§6 的 DEFAULT_PARAMS 代码块能解析出 60 项', () => {
    expect(parseSection6Params(markdown).size).toBe(60);
  });

  it('§11.2 的「缺失的表达方式对照」能解析出方法名单', () => {
    const semantics = parseSection11_2Methods(markdown);
    expect(semantics.get('throw_not_found')).toContain('forget');
    expect(semantics.get('return_null')).toEqual(['get']);
    expect(semantics.get('conflict')).toEqual(['restore', 'updateContent', 'setAlias']);
  });

  it('全部检查通过（零不一致）', () => {
    expect(checkContracts(markdown)).toEqual([]);
  });

  it('C26：VECTOR_OVERFETCH_FACTOR 硬编码 3 且不是参数', () => {
    expect(VECTOR_OVERFETCH_FACTOR).toBe(3);
    expect(Object.keys(DEFAULT_PARAMS)).not.toContain('VECTOR_OVERFETCH_FACTOR');
  });
});

describe('P0-T06 · 表格行解析', () => {
  it('§5 的引用块里的表也算表格行', () => {
    const rows = parseAllTableRows('> | `a` | 1 |\n> | --- | --- |\n> | `b` | 2 |');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.[0]).toBe('`a`');
  });
});
