/**
 * CI 契约门禁脚本的单测 —— DEVELOPMENT-PLAN.md P0-T06。
 *
 * ⚠️ 每个门禁脚本都必须有一个**反例**用例：
 *   只测「通过」的话，一个「永远返回通过」的脚本也能全绿 ⇒ 闸门形同虚设。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_PATH_BINDINGS,
  EXPECTED_ANCHOR_PATH_COUNTS,
  EXPECTED_ANCHOR_ROWS,
  EXPECTED_HARD_RULE_COUNT,
  checkAnchorPathBindings,
  compareAnchorRows,
  countHardRules,
  findAnchorTable,
  normalizeCell,
} from '../../scripts/check-anchor.js';
import {
  ALLOWED_BUCKET_WRITE_FILES,
  checkBucketWriteSites,
} from '../../scripts/check-bucket-write.js';
import {
  EXPECTED_MISSING_EXPRESSION_GROUPS,
  EXPECTED_READONLY_WRITE_METHODS,
  EXPECTED_WARNING_ONLY_CASES,
  checkContracts,
  checkWarningOnlyRoster,
  extractCodeLikeNames,
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
  containsAnchorKeyword,
  normalizeAnchorLabel,
  parseAnchorKeywords,
  parseAnchorPathLabels,
} from '../../scripts/lib/anchor-match.js';
import { scanSourceTree } from '../../scripts/lib/bucket-write-scan.js';
import { blankComments, extractFunctionBody } from '../../scripts/lib/code-span.js';
import {
  extractBacktickSpans,
  extractPayloadKeys,
  extractSection,
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

describe('P2-T04 · check-bucket-write（§9.3.0 的 lint 规则）', () => {
  /** 仓库根（本测试文件所在目录的上一级）。 */
  const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

  it('白名单是**写死的期望值**，且恰好一个文件', () => {
    // ⚠️ C31：分母必须是外部写死的期望值 ⇒ 白名单不是「本次扫出来的」。
    expect(ALLOWED_BUCKET_WRITE_FILES).toEqual(['vector/bucketAssign.ts']);
  });

  it('真实的仓库：桶归属的写入只出现在唯一写入点', () => {
    const hits = scanSourceTree(resolve(REPO_ROOT, 'src'));
    expect(checkBucketWriteSites(hits)).toEqual([]);
  });

  it('★ 反例：别处出现裸写 ⇒ 必须报红并点名那个文件', () => {
    const hits = [
      { file: 'vector/bucketAssign.ts', line: 169 },
      { file: 'store/write.ts', line: 854 },
    ];
    const diffs = checkBucketWriteSites(hits);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('store/write.ts');
  });

  it('★ 反例：白名单写成空集 + 源码里一处裸写都没有 ⇒ **必须报红**（真空守卫）', () => {
    // ⚠️ 「每一处都在白名单内」在这种情况下**恒真** ⇒ 闸门形同虚设
    //   ⇒ 必须另有一条「命中数 > 0」的判据把它抓住（C31 的症状）。
    const diffs = checkBucketWriteSites([]);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('真空守卫');
  });

  it('★ 反例：白名单里的文件一处写入都没扫到 ⇒ 必须报红（白名单陈旧）', () => {
    const diffs = checkBucketWriteSites([{ file: 'store/write.ts', line: 1 }]);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('白名单');
  });
});

describe('P2-T04 · check-anchor 的「动作关键词落在管辖路径上」', () => {
  /** 仓库根。 */
  const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

  it('真实的设计稿 + 真实的源码：每条路径都命中（待补的除外）', () => {
    const rows = findAnchorTable(markdown) ?? [];
    const { outcomes, diffs } = checkAnchorPathBindings(rows, {
      repoRoot: REPO_ROOT,
      designDoc: markdown,
    });
    expect(diffs).toEqual([]);
    expect(outcomes.length).toBe(27);
  });

  it('待补的路径**被记进结果**（不许静默跳过），且**不判红**', () => {
    const rows = findAnchorTable(markdown) ?? [];
    const { outcomes, diffs } = checkAnchorPathBindings(rows, {
      repoRoot: REPO_ROOT,
      designDoc: markdown,
    });
    const pending = outcomes.filter((outcome) => outcome.status === 'pending');
    // ⚠️ **必须非空**：否则这条断言就是「待补机制根本没生效」的假绿。
    expect(pending.length).toBeGreaterThan(0);
    expect(diffs).toEqual([]);
    for (const outcome of pending) {
      expect(outcome.detail.length).toBeGreaterThan(0);
    }
  });

  it('★ 反例：删掉「桶归属同步」的一条管辖路径 ⇒ 必须报红（分母写死）', () => {
    const rows = (findAnchorTable(markdown) ?? []).map((row) => [...row]);
    const target = rows.find((row) => normalizeCell(row[0] ?? '') === '桶归属同步');
    expect(target).toBeDefined();
    if (target !== undefined) {
      // ⚠️ 把四个路径删成三个 ⇒ 「实际命中几个」当分母的话 ⇒ 脚本自己看不出来
      //   ⇒ 必须靠**写死的期望值**（4）抓住。
      target[2] = '§4.9 步骤 2 / §4.9 步骤 3c ② / §4.9 步骤 4';
    }
    const { diffs } = checkAnchorPathBindings(rows, {
      repoRoot: REPO_ROOT,
      designDoc: markdown,
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('管辖路径条数');
  });

  it('★ 反例：落点表少一条 ⇒ 必须报红（不是「少一个也照样绿」）', () => {
    const rows = findAnchorTable(markdown) ?? [];
    const original = ANCHOR_PATH_BINDINGS.findIndex((rule) => rule.rule === '桶归属同步');
    const binding = ANCHOR_PATH_BINDINGS[original];
    expect(binding).toBeDefined();
    if (binding === undefined) {
      return;
    }
    // ⚠️ **落点表少一条** ⇒ 若拿「实际命中几个」当分母 ⇒ 脚本自己看不出来
    //   ⇒ 必须靠**写死的期望值**（4）抓住。
    const shrunk = { ...binding, paths: binding.paths.slice(0, binding.paths.length - 1) };
    const patched = ANCHOR_PATH_BINDINGS.map((rule, index) => (index === original ? shrunk : rule));
    const { diffs } = checkAnchorPathBindings(rows, {
      repoRoot: REPO_ROOT,
      designDoc: markdown,
      bindings: patched,
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('落点条数');
  });

  it('★ 反例：落点指向一个没有关键词的文件 ⇒ 必须报红', () => {
    const rows = findAnchorTable(markdown) ?? [];
    const original = ANCHOR_PATH_BINDINGS.findIndex((rule) => rule.rule === '桶归属同步');
    const patched = ANCHOR_PATH_BINDINGS.map((rule, index) =>
      index === original
        ? {
            ...rule,
            paths: rule.paths.map((path) =>
              path.label === '§4.9 步骤 4'
                ? { ...path, file: 'src/store/write.ts', symbol: 'write' }
                : path,
            ),
          }
        : rule,
    );
    // ⚠️ `write()` 函数体里**没有** `assignBucket`（它在 `createMemory` 里）
    //   ⇒ 落点写错 ⇒ 必须被抓出来（这正是「错列比缺行更危险」的那一类）。
    const { diffs } = checkAnchorPathBindings(rows, {
      repoRoot: REPO_ROOT,
      designDoc: markdown,
      bindings: patched,
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('§4.9 步骤 4');
  });
});

describe('P2-T04 · 关键词与路径标签的口径', () => {
  it('关键词从锚定表那一列解析（去反引号、拆分）', () => {
    expect(
      parseAnchorKeywords('`vector_cell_members` / `assignBucket` / `unassignBucket`'),
    ).toEqual(['vector_cell_members', 'assignBucket', 'unassignBucket']);
    expect(parseAnchorKeywords('吻合率 / 只漏不错')).toEqual(['吻合率', '只漏不错']);
  });

  it('路径标签规范化（去 markdown、去掉末尾的括号补充）', () => {
    expect(normalizeAnchorLabel('§4.9.1 步骤 4（**四条 embedding 赋值路径一条都不能漏**）')).toBe(
      '§4.9.1 步骤 4',
    );
    expect(normalizeAnchorLabel('§3 `cluster_snapshot_meta`')).toBe('§3 cluster_snapshot_meta');
  });

  it('路径标签逐条解析出写死的条数（4 / 6 / 6 / 7 / 4）', () => {
    const rows = findAnchorTable(markdown) ?? [];
    const counts = rows.map((row) => parseAnchorPathLabels(row[2] ?? '').length);
    expect(counts).toEqual(EXPECTED_ANCHOR_PATH_COUNTS.map(([, count]) => count));
  });

  // ⚠️⚠️ **F5 的第三处锁死**（P2 QA 验收）——
  //   `EXPECTED_ANCHOR_PATH_COUNTS`（分母）与 `EXPECTED_ANCHOR_ROWS`（期望行）
  //   **在同一个文件里** ⇒ 可以**一起改** ⇒ QA 实测（M9）：
  //   「设计稿删一条路径 + 落点表删条目 + 期望行同步改 + 分母改成实际命中数」⇒ **全绿**
  //   ⇒ **「三处自洽」的漂移整类静默通过**。
  //   ⇒ 唯一的治法是**加第三处**：这里把「期望行第三列的项数」**独立硬编码**
  //   ⇒ ⇒ 要漂移就得改**三处**（设计稿 / 落点表+分母 / 本契约）⇒ ⇒ 而任何单处/两处的改动都会红。
  it('★ F5：期望行的第三列项数与写死的分母**互相锁死**（第三处 ⇒ 同改两处会被抓住）', () => {
    // ⚠️ 这里的数字是**独立硬编码**的（不是从 `EXPECTED_ANCHOR_PATH_COUNTS` 推导）
    //   ⇒ 它与 `EXPECTED_ANCHOR_PATH_COUNTS` 构成**互锁**。
    const expectedCountsFromRows = [4, 6, 6, 7, 4];
    const countsFromConstants = EXPECTED_ANCHOR_PATH_COUNTS.map(([, count]) => count);
    expect(countsFromConstants).toEqual(expectedCountsFromRows);

    // 性质：**期望行本身**的第三列解析出的项数，也要逐条等于上面那组数
    const perRowCounts = EXPECTED_ANCHOR_ROWS.map(
      (row) => parseAnchorPathLabels(row[2] ?? '').length,
    );
    expect(perRowCounts).toEqual(expectedCountsFromRows);

    // 性质：两条规则名也逐条对齐（防止「改数字不改规则名」）
    expect(EXPECTED_ANCHOR_PATH_COUNTS.map(([rule]) => rule)).toEqual(
      EXPECTED_ANCHOR_ROWS.map((row) => row[0] ?? ''),
    );
  });

  it('★ ASCII 关键词按**词边界**匹配（`mode` 不命中 `model`）', () => {
    expect(containsAnchorKeyword('mode: flat_auto', 'mode')).toBe(true);
    expect(containsAnchorKeyword('the model changed', 'mode')).toBe(false);
    expect(containsAnchorKeyword("mode === 'absent'", 'absent')).toBe(true);
  });

  it('★ 中文短语**去标点**后匹配（「只漏、不错」≡「只漏不错」）', () => {
    expect(containsAnchorKeyword('覆盖不足时只漏、不错', '只漏不错')).toBe(true);
    expect(containsAnchorKeyword('覆盖不足时只漏、不错', '只漏没错')).toBe(false);
  });

  it('★ 注释涂白后下标不变（长度一致）⇒ 区间定位不会漂', () => {
    const source = 'const a = 1; // assignBucket 的注释\nconst b = 2;\n';
    const blanked = blankComments(source);
    expect(blanked.length).toBe(source.length);
    expect(blanked).not.toContain('assignBucket');
  });

  it('★ 函数体提取按花括号配对（SQL 模板里的括号不算）', () => {
    const source = [
      'function demo(): void {',
      "  db.prepare('SELECT {x} FROM t').run();",
      '  assignBucket();',
      '}',
      'function other(): void {',
      '  unassignBucket();',
      '}',
    ].join('\n');
    const body = extractFunctionBody(source, 'demo');
    expect(body).toContain('assignBucket');
    expect(body).not.toContain('unassignBucket');
  });
});

describe('QA 复核 F-03 · §8.4 硬规则条数守卫', () => {
  const section84 = extractSection(markdown, '### 8.4 事件类型与发射点对照表（枚举必须逐个落地）');

  it('设计稿 §8.4 存在（抽不到就说明标题变了 ⇒ 必须报错而不是静默跳过）', () => {
    expect(section84).toBeDefined();
  });

  it('★ §8.4 的硬规则恰好 6 条', () => {
    expect(countHardRules(section84 ?? '')).toBe(EXPECTED_HARD_RULE_COUNT);
    expect(EXPECTED_HARD_RULE_COUNT).toBe(6);
  });

  it('★ 负控：规则 4 的编号后带 ★ 也必须被数到（否则守卫对真实文档误报）', () => {
    // ⚠️ 规则 4 的原文是 `4. ★ **只有 ...**` —— ★ 夹在编号与 ** 之间。
    //   若正则要求编号后紧跟 **，规则 4 会被漏数 ⇒ 数出 5 ⇒ 守卫恒失败 = 没有守卫。
    const withStar = [
      '1. **第一**',
      '2. **第二**',
      '3. **第三**',
      '4. ★ **第四**',
      '5. **第五**',
      '6. **第六**',
    ].join('\n');
    expect(countHardRules(withStar)).toBe(6);
  });

  it('★ 负控：删掉一条规则 ⇒ 必须数出 5（证明计数真的在数，不是恒等于 6）', () => {
    const five = ['1. **第一**', '2. **第二**', '3. **第三**', '4. ★ **第四**', '5. **第五**'].join(
      '\n',
    );
    expect(countHardRules(five)).toBe(5);
    expect(countHardRules(five)).not.toBe(EXPECTED_HARD_RULE_COUNT);
  });

  it('★ 负控：把编号换成中文数字 ⇒ 不该被当成编号项（避免数进无关的编号列表）', () => {
    const chinese = '（一）**第一**\n（二）**第二**';
    expect(countHardRules(chinese)).toBe(0);
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

  it('`ALIAS_CONFLICT` / `ALIAS_TARGET_NOT_LINKED` 刻意不是异常 ⇒ 不在任何抛错分组里', () => {
    // ⚠️ 两条 warning 码**三处必须相等**（ADR-P1-T07-DEC D-3/R2）：
    //   ① 本文件的 `EXPECTED_WARNING_ONLY_CASES`（scripts/check-contract-ids.ts）
    //   ② `src/core/errors.ts` 的 `WARNING_ONLY_CASES`
    //   ③ DESIGN §11.2 对照表最后一行（须用反引号包住，解析器才读得到）
    expect(EXPECTED_WARNING_ONLY_CASES).toEqual(['ALIAS_CONFLICT', 'ALIAS_TARGET_NOT_LINKED']);
    for (const group of Object.values(EXPECTED_MISSING_EXPRESSION_GROUPS)) {
      expect(group).not.toContain('ALIAS_CONFLICT');
      expect(group).not.toContain('ALIAS_TARGET_NOT_LINKED');
    }
    expect(EXPECTED_READONLY_WRITE_METHODS).not.toContain('ALIAS_CONFLICT');
    expect(EXPECTED_READONLY_WRITE_METHODS).not.toContain('ALIAS_TARGET_NOT_LINKED');
    expect(METHODS_THROWING_NOT_FOUND).not.toContain('ALIAS_CONFLICT');
    expect(METHODS_THROWING_NOT_FOUND).not.toContain('ALIAS_TARGET_NOT_LINKED');
    expect(METHODS_THROWING_CONFLICT).not.toContain('ALIAS_CONFLICT');
    expect(METHODS_THROWING_CONFLICT).not.toContain('ALIAS_TARGET_NOT_LINKED');
    expect(METHODS_THROWING_READONLY_VIOLATION).not.toContain('ALIAS_CONFLICT');
    expect(METHODS_THROWING_READONLY_VIOLATION).not.toContain('ALIAS_TARGET_NOT_LINKED');
    // ⚠️ 这份名单镜像的是 `src/core/errors.ts` 的 `WARNING_ONLY_CASES`（**代码侧**），
    //   ⇒ 与上面那行（镜像**脚本侧**的 `EXPECTED_WARNING_ONLY_CASES`）是**两份**，
    //   两边必须同步改，否则「代码 ↔ 脚本 ↔ 文档」三处相等的关系会破。
    expect(WARNING_ONLY_CASES).toEqual(['ALIAS_CONFLICT', 'ALIAS_TARGET_NOT_LINKED']);
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

/**
 * §11.2「不抛错，走 `write()` 的 `warnings」那一格的**「= 方向」守卫**。
 *
 * ⚠️ **为什么这一格需要「= 方向」**（实测漏洞）：
 *   既有守卫只查了「白名单 ⊆ 文档名册」（少一个码 ⇒ 报红）
 *   ⇒ **文档名册里多出来的东西**（陈旧码名）**没人管**
 *   ⇒ 那一格可以**无成本**地堆积垃圾，而门禁照样绿
 *   ⇒ 读者却会以为那一格就是权威清单。
 *
 * ⚠️ **为什么只比「码形态」的项**：
 *   那一列**合法地**混着方法名（`write`）⇒ 朴素地比全列会**恒红**
 *   ⇒ 按形态过滤（首字母大写）后，方法名被剔除、码被保留。
 */
describe('P1 收官 · §11.2 warnings 名册的「= 方向」守卫（第三处相等）', () => {
  const roster = (): string[] => parseSection11_2Methods(markdown).get('warning_only') ?? [];

  it('正向：文档那一格的码形态项恰好就是那两个（白名单加了第三个却忘了写进文档 ⇒ 这里必须红）', () => {
    expect(extractCodeLikeNames(roster())).toEqual(['ALIAS_CONFLICT', 'ALIAS_TARGET_NOT_LINKED']);
    expect(checkWarningOnlyRoster(roster(), EXPECTED_WARNING_ONLY_CASES)).toEqual([]);
  });

  it('★ 负控：码形态过滤器必须把方法名（小写开头）滤掉、把码名留下', () => {
    expect(extractCodeLikeNames(['write', 'ALIAS_CONFLICT', 'ALIAS_TARGET_NOT_LINKED'])).toEqual([
      'ALIAS_CONFLICT',
      'ALIAS_TARGET_NOT_LINKED',
    ]);
    // ⚠️ 「首字母大写」这个判据**不能**退化成「出现在白名单里」
    //   （那是循环论证：白名单漏了的码会降级成「非码形态」⇒ 门禁反而看不见它）。
    expect(extractCodeLikeNames(['ALIAS_STALE'])).toEqual(['ALIAS_STALE']);
  });

  it('★ 负控：喂进一个多出来的码名 ⇒ 守卫必须报红并点名它', () => {
    const broken = [...roster(), 'ALIAS_STALE'];
    const diffs = checkWarningOnlyRoster(broken, EXPECTED_WARNING_ONLY_CASES);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('ALIAS_STALE');
  });

  it('★ 负控：喂进一个少掉的码名 ⇒ 守卫必须报红并点名它', () => {
    const broken = roster().filter((name) => name !== 'ALIAS_TARGET_NOT_LINKED');
    const diffs = checkWarningOnlyRoster(broken, EXPECTED_WARNING_ONLY_CASES);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('ALIAS_TARGET_NOT_LINKED');
  });

  it('★ 负控：守卫真的接在 checkContracts 上（往文档那一格塞一个陈旧码 ⇒ 整体检查必须报红）', () => {
    // ⚠️ **不改 `docs/design/DESIGN-v2.md`**（那是正文，不是测试的靶子）⇒ 只改**内存里的副本**。
    const anchor = '别名目标未关联 `ALIAS_TARGET_NOT_LINKED`）';
    // ⚠️ 锚点必须**唯一** ⇒ 否则这个负控可能在改错的地方（⇒ 假绿）。
    expect(markdown.split(anchor)).toHaveLength(2);
    const doctored = markdown.replace(
      anchor,
      '别名目标未关联 `ALIAS_TARGET_NOT_LINKED`；陈旧码 `ALIAS_STALE`）',
    );
    const diffs = checkContracts(doctored);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('ALIAS_STALE');
  });

  it('★ 负控：正向路径必须仍然全绿（守卫不是恒红）', () => {
    expect(checkContracts(markdown)).toEqual([]);
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

  it('`verify` 链恰好串起 10 条门禁，且每段都写成 `pnpm run <名>`', () => {
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
