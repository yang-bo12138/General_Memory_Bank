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
  EXPECTED_MISSING_EXPRESSION_GROUPS,
  EXPECTED_READONLY_WRITE_METHODS,
  EXPECTED_WARNING_ONLY_CASES,
  checkContracts,
  parseSection5ValidationCount,
  parseSection6Params,
  parseSection7_1WriteMethods,
  parseSection11_2Methods,
  parseSection12ValidationReference,
} from '../../scripts/check-contract-ids.js';
import {
  EXPECTED_CI_ALIAS,
  EXPECTED_GATE_COMMANDS,
  PNPM_BUILTIN_COMMANDS,
  checkGateEntry,
  compareNameSets,
  parseVerifyChain,
  readPackageJson,
} from '../../scripts/check-gate-entry.js';
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
import {
  METHODS_THROWING_CONFLICT,
  METHODS_THROWING_NOT_FOUND,
  METHODS_THROWING_READONLY_VIOLATION,
  MISSING_IDS_KEY,
  NOT_FOUND_METHODS_WITH_MISSING_IDS,
  WARNING_ONLY_CASES,
} from '../../src/core/errors.js';
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

describe('P0-T07 · §11.2 的六组表达方式（逐名比对，不是计数）', () => {
  it('§7.1 的写方法清单能解析出 16 个，且与写死的期望逐名相同', () => {
    const parsed = parseSection7_1WriteMethods(markdown);
    expect(parsed).toHaveLength(16);
    expect([...parsed].sort()).toEqual([...EXPECTED_READONLY_WRITE_METHODS].sort());
  });

  it('★ 反例：§7.1 少写一个方法 ⇒ 逐名比对必须抓出来（不是只比数量）', () => {
    // ⚠️ 若只比「数量 == 16」，把 `sweep` 换成 `sweepX` 是**发现不了**的
    //   （数量对上了，名字对不上 ⇒ 另一种假绿）。
    const swapped = EXPECTED_READONLY_WRITE_METHODS.map((name) =>
      name === 'sweep' ? 'sweepX' : name,
    );
    const diffs = compareNameSets(EXPECTED_READONLY_WRITE_METHODS, swapped, '写方法');
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('sweep');
  });

  it('期望分组写死为常量（不从设计稿现场解析当分母）', () => {
    // ⚠️ §11.2 的「涉及方法」列对 READONLY_VIOLATION 只写「全部写方法」，
    //   解析出来的名单**不完整** ⇒ 期望值必须是外部写死的常量（C31）。
    expect(EXPECTED_MISSING_EXPRESSION_GROUPS.throw_not_found).toHaveLength(10);
    expect(EXPECTED_MISSING_EXPRESSION_GROUPS.return_null).toEqual(['get']);
    expect(EXPECTED_MISSING_EXPRESSION_GROUPS.conflict).toEqual([
      'restore',
      'updateContent',
      'setAlias',
    ]);
    expect(EXPECTED_READONLY_WRITE_METHODS).toHaveLength(16);
  });

  it('`ALIAS_CONFLICT` 刻意不是异常 ⇒ 不在任何抛错分组里', () => {
    expect(EXPECTED_WARNING_ONLY_CASES).toEqual(['ALIAS_CONFLICT']);
    for (const group of Object.values(EXPECTED_MISSING_EXPRESSION_GROUPS)) {
      expect(group).not.toContain('ALIAS_CONFLICT');
    }
    expect(EXPECTED_READONLY_WRITE_METHODS).not.toContain('ALIAS_CONFLICT');
    expect(METHODS_THROWING_NOT_FOUND).not.toContain('ALIAS_CONFLICT');
    expect(METHODS_THROWING_CONFLICT).not.toContain('ALIAS_CONFLICT');
    expect(METHODS_THROWING_READONLY_VIOLATION).not.toContain('ALIAS_CONFLICT');
    expect(WARNING_ONLY_CASES).toEqual(['ALIAS_CONFLICT']);
  });

  it('`missingIds` 锚点：承载它的方法必须在 NOT_FOUND 分组里', () => {
    expect(MISSING_IDS_KEY).toBe('missingIds');
    for (const method of NOT_FOUND_METHODS_WITH_MISSING_IDS) {
      expect(METHODS_THROWING_NOT_FOUND).toContain(method);
    }
  });

  it('§11.2 的 warnings 那一行确实标了 ALIAS_CONFLICT（文档 ↔ 代码）', () => {
    const semantics = parseSection11_2Methods(markdown);
    expect(semantics.get('warning_only')).toContain('ALIAS_CONFLICT');
    expect(semantics.get('warning_only')).toContain('write');
  });
});

describe('P0-T07 · 门禁入口的可见性（防「假绿闸门」）', () => {
  it('真实的 package.json 完全合规', () => {
    expect(checkGateEntry(readPackageJson())).toEqual([]);
  });

  it('规范入口是 `verify`（不是任何包管理器的内建命令名）', () => {
    expect(PNPM_BUILTIN_COMMANDS).toContain('ci');
    expect(PNPM_BUILTIN_COMMANDS).not.toContain('verify');
  });

  it('`scripts.ci` 恰好是 `pnpm run verify` 的别名', () => {
    expect(EXPECTED_CI_ALIAS).toBe('pnpm run verify');
    const pkg = readPackageJson();
    // ⚠️ `ci` 是**别名**（内容恰好是 `pnpm run verify`）；`verify` 本身是那条链。
    expect(pkg.scripts?.ci).toBe(EXPECTED_CI_ALIAS);
    expect(pkg.scripts?.verify).not.toBe(EXPECTED_CI_ALIAS);
    expect(pkg.scripts?.verify).toContain('pnpm run typecheck');
  });

  it('`verify` 链恰好串起 8 条门禁，且每段都写成 `pnpm run <名>`', () => {
    const pkg = readPackageJson();
    const { names, malformed } = parseVerifyChain(pkg.scripts?.verify ?? '');
    expect(malformed).toEqual([]);
    expect(names).toEqual([...EXPECTED_GATE_COMMANDS]);
  });

  it('★ 反例：把 `ci` 改回一串别的命令 ⇒ 必须失败', () => {
    const pkg = readPackageJson();
    const diffs = checkGateEntry({
      scripts: { ...pkg.scripts, ci: 'pnpm run typecheck && pnpm run lint' },
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('scripts.ci');
  });

  it('★ 反例：从 `verify` 上摘掉一条门禁 ⇒ 必须失败', () => {
    const pkg = readPackageJson();
    const diffs = checkGateEntry({
      scripts: { ...pkg.scripts, verify: 'pnpm run typecheck && pnpm run lint' },
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('缺少');
  });

  it('★ 反例：链里写了裸 `pnpm ci` ⇒ 必须失败（会被内建命令遮蔽）', () => {
    const pkg = readPackageJson();
    const diffs = checkGateEntry({
      scripts: { ...pkg.scripts, verify: 'pnpm ci && pnpm run typecheck' },
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('pnpm run <脚本名>');
  });

  it('★ 反例：链里引用了不存在的 script ⇒ 必须失败', () => {
    const pkg = readPackageJson();
    const diffs = checkGateEntry({
      scripts: { ...pkg.scripts, verify: 'pnpm run typecheck && pnpm run ghost' },
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('ghost');
  });
});
