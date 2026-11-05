#!/usr/bin/env tsx
/**
 * 「同一批实测数不许在多处各说各话」的**跨载体**守卫。
 *
 * ## 背景（为什么要有这条脚本）
 *
 * 2026-11-05 的 1M · 热档 · HDD 采集，产出了一批**互相关联**的实测数
 * （`4,065,792` / `1,623,229.4` / `3,998,976` / `3.877 MiB` / `33.8%` / `0.1323%` /
 * `7,233,792` / 样本 `200`）⇒ ⇒ 它们被抄进了**多个已提交的载体**：
 *
 * | # | 载体 | 承载的内容 | 谁在守 |
 * |---|---|---|---|
 * | 1 | `bench/perf.ts` 的 `note`（写路径 + 读路径） | **真值**（落盘字符串） | `scripts/check-json-note-fidelity.ts` |
 * | 2 | `docs/design/perf-c2-t06-byte-metering-impl-notes.md` §13 | `note` 的**逐字副本** | 同上（①↔②） |
 * | 3 | `docs/baseline/README.md`（H1′ / H2′ 两行） | 门槛表的**实测值列** | ★ **本脚本** |
 * | 4 | `docs/DELIVERY.md`（6 处） | 门槛表的**实测值列** | ★ **本脚本** |
 * | 5 | `docs/decisions/adr-perf-recall-vs-h1.md` | 裁决留痕 | ★ **本脚本** |
 *
 * ⇒ ⇒ **既有的 `check-json-note-fidelity.ts` 只保证 ①↔② 那一对**
 * ⇒ ⇒ ⇒ **「同一批数在 ②/③/④/⑤ 各说各话」这件事，此前没有任何机器拦得住**
 * ⇒ ⇒ ⇒ 本脚本补的就是这一段。
 *
 * ## 设计要点
 *
 * ★ **1. 锚点必须是【已提交】的文件**
 *   本批数的落盘 JSON（`.tmp/bench/t07-warm.json`）被 `.gitignore` 忽略 ⇒ ⇒ **CI 上没有**
 *   ⇒ ⇒ **不能当锚点** ⇒ ⇒ 锚点只能是已提交的文档（`docs/baseline/README.md` 的 H1′/H2′ 两行）。
 *   ⚠️ **出处仍然要写清楚**（让人知道这批数从哪来）⇒ ⇒ 见下面的「数据出处」注释。
 *
 * ★ **2. 比较的是【数值】，不是【字符串】**
 *   `4,065,792` 与 `4065792` 是同一个数（千分位只是排版）⇒ ⇒ 所以判定用**数值相等**
 *   （按规范写法的**小数位**四舍五入后比较）⇒ ⇒ `4,065,791` 才是漂移。
 *   ⚠️ **但规范写法本身也参与判定**：写法与规范不同（`3.877MB` 少了空格）⇒ ⇒ 单独报一类
 *   ⇒ ⇒ 因为本仓库的纪律是「**同一批数逐位相等**」⇒ ⇒ 写法不一致 = 各说各话。
 *
 * ★ **3. 单位必须钉住**
 *   本批数是**字节**（无歧义）⇒ ⇒ 规范写法里**带上单位**（`4,065,792 B` / `3.877 MiB` / `33.8%`）
 *   ⇒ ⇒ 「同一个数字、两种单位」会被立刻抓出来。
 *   ⚠️ **不要给本脚本引入「4.44 MB 有 MiB / 10⁶ 两种读法」这类换算模糊性**
 *   ⇒ ⇒ 那个数是 ADR 的**旧估计**、不是本批实测数 ⇒ ⇒ 本脚本**不碰它**。
 *
 * ★ **4. 载体靠【内容锚点】定位，不靠行号**
 *   行号会漂（在上游插一行就全错位）⇒ ⇒ 所以每个载体用一条**行选择正则**定位
 *   ⇒ ⇒ 并**写死「应命中几行」**（分母写死，同 `check-gate-entry.ts` 的纪律）
 *   ⇒ ⇒ 定位不到 / 命中数变了 ⇒ ⇒ 报「载体定位失败」⇒ ⇒ **不许静默跳过**。
 *
 * ★ **5. 这条脚本自己绝不能是恒绿守卫**
 *   自带**正控 + 反向对照 + 4 条负控**（`--self-test`）：
 *   · 每条负控**断言具体失败类别**（不是只断言「exit 1」）；
 *   · 每条负控都有**根因断言**（mutate 之后**判定必须不再通过**）⇒ ⇒ 否则夹具没进判定路径
 *     ⇒ ⇒ 这条负控自己就是恒绿的 ⇒ ⇒ 当场报错；
 *   · 另有一条**「根因断言有牙」**的自测（造一个「不该变红却变了」的坏夹具 ⇒ ⇒ 证明根因断言有分辨力）。
 *   ⇒ ⇒ ★ **负控一律用【临时副本】做**（拷到临时目录 ⇒ 改 ⇒ 跑 ⇒ 删）⇒ ⇒ **绝不许改仓库里的真实文件**。
 *
 * ## 数据出处（让人知道这批数从哪来；但**不作为机器依赖**）
 *
 *   · 采集：**2026-11-05 · 1,000,000 条 · 热档 · HDD（ST1000DM010）**（准备段 6.40 h · 峰值 RSS 9,916 MB）
 *   · 落盘 JSON：`.tmp/bench/t07-warm.json` ⇒ ⇒ ⚠️ **被 `.gitignore` 忽略 ⇒ CI 上没有**
 *     ⇒ ⇒ **所以它不是锚点**（只作出处说明）
 *   · 可复算恒等式：`bytesRead = 码行数 × 768 B + embedding 行数 × 3,072 B`
 *     （写路径 `5,286 × 768 + 2 × 3,072 = 4,065,792`；读路径 `9,079 × 768 + 85 × 3,072 = 7,233,792`）
 *
 * ## 用法
 *   tsx scripts/check-benchmark-numbers.ts               # 校验（默认）
 *   tsx scripts/check-benchmark-numbers.ts --self-test   # 自带正控 + 反向对照 + 4 条负控
 *   tsx scripts/check-benchmark-numbers.ts --root <目录> # 指定根目录（自测 / 排障用）
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 路径（★ 相对【脚本自身】· 与当前工作目录无关） ── */

/** 仓库根（`scripts/` 的上一级）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 本仓库的 `⚠️` = **U+26A0 + U+FE0F**（带变体选择符 VS16）。
 *
 * ⚠️ 这里**故意用码点转义**而不是手打 ⇒ ⇒ 这样无论谁在哪个编辑器里改这个文件
 *   都不会把它写成「无 VS16 的 `⚠`」⇒ ⇒ 也就不用担心 emoji 漂移。
 */
const WARN = '\u26A0\uFE0F';

/* ── 载体（★ 靠【内容锚点】定位· 行号只用来报告） ── */

type Carrier = {
  /** 稳定 id（规格里用它指名「谁必须带这个数」）。 */
  readonly id: string;
  /** 人类可读标签。 */
  readonly label: string;
  /** 相对仓库根的文件路径。 */
  readonly file: string;
  /** 行选择正则（★ **必须非全局** · 否则 `test()` 的 `lastIndex` 会漂）。 */
  readonly pattern: RegExp;
  /** ★ **写死的期望命中行数**（分母写死 · 定位不到就红 · 不许静默跳过）。 */
  readonly expectLines: number;
};

const CARRIERS: readonly Carrier[] = [
  {
    id: 'readme-h1',
    label: 'README 门槛表 · H1′ 行',
    file: 'docs/baseline/README.md',
    pattern: /^> \| \*\*H1′ 单次写入的向量载荷字节\*\*/,
    expectLines: 1,
  },
  {
    id: 'readme-h2',
    label: 'README 门槛表 · H2′ 行',
    file: 'docs/baseline/README.md',
    pattern: /^> \| \*\*H2′ 单次写入的向量载荷字节/,
    expectLines: 1,
  },
  {
    id: 'delivery-note',
    label: 'DELIVERY 公告行（判据改字节）',
    file: 'docs/DELIVERY.md',
    pattern: /判据已从「行」改为「字节」/,
    expectLines: 1,
  },
  {
    id: 'delivery-h1',
    label: 'DELIVERY 门槛表 · H1′ 行',
    file: 'docs/DELIVERY.md',
    pattern: /^\| \*\*H1′ 字节口径\*\*/,
    expectLines: 2,
  },
  {
    id: 'delivery-h2',
    label: 'DELIVERY 门槛表 · H2′ 行',
    file: 'docs/DELIVERY.md',
    pattern: /^\| \*\*H2′ 字节口径\*\*/,
    expectLines: 2,
  },
  {
    id: 'delivery-gates',
    label: 'DELIVERY 两条性能硬门槛行',
    file: 'docs/DELIVERY.md',
    pattern: /^\| \*\*两条性能硬门槛（H1 \/ H2）\*\*/,
    expectLines: 1,
  },
  {
    id: 'adr-4.44',
    label: 'ADR · 4.44 MB 订正行',
    file: 'docs/decisions/adr-perf-recall-vs-h1.md',
    pattern: /写入侧 `4\.44 MB` 是【偏高的估计】/,
    expectLines: 1,
  },
  {
    id: 'impl-write',
    label: 'impl-notes §13 · 写路径 note（逐字副本）',
    file: 'docs/design/perf-c2-t06-byte-metering-impl-notes.md',
    pattern: /^\s*"note":.*写入扫描独立实测段/,
    expectLines: 1,
  },
  {
    id: 'impl-read',
    label: 'impl-notes §13 · 读路径 note（逐字副本）',
    file: 'docs/design/perf-c2-t06-byte-metering-impl-notes.md',
    pattern: /^\s*"note":.*读路径的对账量/,
    expectLines: 1,
  },
];

/* ── 被比的量（★ 规范写法 + 数值 + 族内正则 + 谁必须带它） ── */

/** 按 id 查载体（★ 报告里要打出「文件:行号」⇒ 需要能反查文件路径）。 */
const CARRIER_BY_ID = new Map(CARRIERS.map((carrier) => [carrier.id, carrier]));

type Spec = {
  readonly id: string;
  readonly label: string;
  /** ★ **规范写法**（含单位）—— 逐位比较的基准。 */
  readonly literal: string;
  /** 数值（用于判定「值相同 / 值漂移」）。 */
  readonly value: number;
  /** 比较时保留的小数位（★ `1,623,229.44` 与 `1,623,229.4` 在 1 位上相等 ⇒ 不算漂移）。 */
  readonly decimals: number;
  /**
   * ★ **族内正则**（捕获组 1 = 数字文本）—— 用来区分三种病：
   *   · 值相同但写法不同 ⇒ 「写法不一致」
   *   · 值不同 ⇒ 「数值漂移」
   *   · 压根没有 ⇒ 「规范写法缺失」
   */
  readonly family: RegExp;
  /** 族内**其它合法值**（同一族里别的量的规范写法 ⇒ 不算漂移）。 */
  readonly allow: readonly string[];
  /** ★ **必须带这个数的载体**（★ 谁必须带 ⇒ 谁就得逐位相等）。 */
  readonly requiredIn: readonly string[];
};

const SPECS: readonly Spec[] = [
  {
    id: 'write-bytes-max',
    label: '写路径 bytesRead.max',
    literal: '4,065,792 B',
    value: 4065792,
    decimals: 0,
    family: /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)(?=\s*B\b)/g,
    allow: ['6,144,000', '1,623,229.4', '3,998,976', '3,072'],
    requiredIn: [
      'readme-h1',
      'readme-h2',
      'delivery-note',
      'delivery-h1',
      'delivery-h2',
      'delivery-gates',
      'adr-4.44',
      'impl-write',
    ],
  },
  {
    id: 'write-mean-bytes',
    label: '写路径 bytesRead 均值',
    literal: '1,623,229.4 B',
    value: 1623229.4,
    decimals: 1,
    family: /均值[^0-9]{0,8}(\d[\d,]*(?:\.\d+)?)/g,
    allow: [],
    requiredIn: ['readme-h1', 'delivery-h1'],
  },
  {
    id: 'write-p99-bytes',
    label: '写路径 bytesRead p99',
    literal: '3,998,976 B',
    value: 3998976,
    decimals: 0,
    family: /p99[^0-9]{0,8}(\d[\d,]*(?:\.\d+)?)/g,
    allow: [],
    requiredIn: ['readme-h1', 'delivery-h1'],
  },
  {
    id: 'write-mib',
    label: '写路径 bytesRead 的 MiB 写法',
    literal: '3.877 MiB',
    value: 3.877,
    decimals: 3,
    family: /(\d[\d,]*\.\d+)\s*M[iI]?B/g,
    allow: [],
    requiredIn: ['readme-h1', 'delivery-h1'],
  },
  {
    id: 'write-margin',
    label: 'H1′ 余量',
    literal: '33.8%',
    value: 33.8,
    decimals: 1,
    family: /余量[^0-9]{0,8}(\d[\d.]*)\s*%/g,
    allow: [],
    requiredIn: ['impl-write', 'readme-h1', 'delivery-note', 'delivery-h1', 'delivery-gates'],
  },
  {
    id: 'h2-ratio',
    label: 'H2′ 占比',
    literal: '0.1323%',
    value: 0.1323,
    decimals: 4,
    family: /(\d[\d.]*)\s*%/g,
    allow: ['0.2'],
    requiredIn: ['readme-h2', 'delivery-h2'],
  },
  {
    id: 'read-bytes-max',
    label: '读路径 bytesRead.max',
    literal: '7,233,792 B',
    value: 7233792,
    decimals: 0,
    family: /实测[^0-9]{0,8}(\d[\d,]*(?:\.\d+)?)\s*B/g,
    allow: [],
    requiredIn: ['impl-read'],
  },
  {
    id: 'sample-count',
    label: '样本数',
    literal: '样本 200',
    value: 200,
    decimals: 0,
    family: /样本[^0-9]{0,8}(\d[\d,]*)/g,
    allow: [],
    requiredIn: ['readme-h1', 'readme-h2', 'delivery-h1', 'delivery-h2'],
  },
];

/* ── 失败类别（★ 负控要断言【具体类别】· 所以类别名是稳定的契约） ── */

const CATEGORY_LOCATE = '载体定位失败';
const CATEGORY_DRIFT = '数值漂移（写成别的值）';
const CATEGORY_RENDER = '写法不一致（值同、写法不同）';
const CATEGORY_MISSING = '规范写法缺失';

type Issue = {
  readonly category: string;
  readonly detail: string;
};

type Cell = {
  readonly specId: string;
  readonly carrierId: string;
  readonly lineNo: number;
  readonly ok: boolean;
};

type Report = {
  readonly issues: readonly Issue[];
  readonly cells: readonly Cell[];
  readonly carrierLines: ReadonlyMap<
    string,
    readonly { readonly lineNo: number; readonly text: string }[]
  >;
  readonly comparisons: number;
};

/** 按规范写法的小数位四舍五入（★ `1,623,229.44` → `1,623,229.4` ⇒ 不算漂移）。 */
function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/** 把数字文本（可能带千分位）解析成数值。 */
function parseNumber(raw: string): number {
  return Number(raw.replace(/,/g, '').trim());
}

/** 读文件并按行编号（1 起）。 */
function readLines(path: string): { readonly lineNo: number; readonly text: string }[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((text, index) => ({ lineNo: index + 1, text }));
}

/**
 * 跑一遍检查。
 *
 * @param root 仓库根（★ 相对脚本自身 ⇒ 从任何目录跑都能跑；自测时传临时目录）
 */
function check(root: string): Report {
  const issues: Issue[] = [];
  const cells: Cell[] = [];
  const carrierLines = new Map<string, { readonly lineNo: number; readonly text: string }[]>();

  // ── ① 定位载体（★ 定位不到 / 命中数变了 ⇒ 红 ⇒ 不许静默跳过）──
  for (const carrier of CARRIERS) {
    const path = join(root, carrier.file);
    let lines: { readonly lineNo: number; readonly text: string }[] = [];
    try {
      lines = readLines(path);
    } catch {
      issues.push({
        category: CATEGORY_LOCATE,
        detail: `${carrier.label}（${carrier.file}）⇒ 文件读不到（${path}）`,
      });
      continue;
    }
    const hits = lines.filter((line) => carrier.pattern.test(line.text));
    if (hits.length !== carrier.expectLines) {
      issues.push({
        category: CATEGORY_LOCATE,
        detail:
          `${carrier.label}（${carrier.file}）⇒ 应命中 ${carrier.expectLines} 行，` +
          `实际命中 ${hits.length} 行（${hits.map((hit) => hit.lineNo).join('、') || '无'}）`,
      });
      continue;
    }
    carrierLines.set(carrier.id, hits);
  }

  // ── ② 逐「量」逐「载体」逐行比对 ──
  let comparisons = 0;
  for (const spec of SPECS) {
    for (const carrierId of spec.requiredIn) {
      const hits = carrierLines.get(carrierId);
      if (hits === undefined) {
        // 载体定位失败已经报过 ⇒ 这里不重复报（避免一个病报两遍）
        continue;
      }
      for (const hit of hits) {
        comparisons += 1;
        if (hit.text.includes(spec.literal)) {
          cells.push({ specId: spec.id, carrierId, lineNo: hit.lineNo, ok: true });
          continue;
        }
        cells.push({ specId: spec.id, carrierId, lineNo: hit.lineNo, ok: false });

        const family = [...hit.text.matchAll(spec.family)].map((match) => ({
          num: match[1] ?? '',
          raw: match[0],
        }));
        const sameValue = family.filter(
          (item) => roundTo(parseNumber(item.num), spec.decimals) === spec.value,
        );
        const drift = family.filter(
          (item) =>
            !spec.allow.includes(item.num) &&
            roundTo(parseNumber(item.num), spec.decimals) !== spec.value,
        );
        const where = `${carrierId}（${CARRIER_BY_ID.get(carrierId)?.file ?? '?'}:${hit.lineNo}）`;

        if (sameValue.length > 0) {
          issues.push({
            category: CATEGORY_RENDER,
            detail:
              `${where} · 量「${spec.label}」⇒ 规范写法「${spec.literal}」不在该行，` +
              `但同一位置出现了同值的写法：${sameValue.map((item) => item.raw).join('、')}`,
          });
        } else if (drift.length > 0) {
          issues.push({
            category: CATEGORY_DRIFT,
            detail:
              `${where} · 量「${spec.label}」⇒ 规范写法「${spec.literal}」不在该行，` +
              `该位置上的值变成了：${drift.map((item) => item.raw).join('、')}`,
          });
        } else {
          issues.push({
            category: CATEGORY_MISSING,
            detail: `${where} · 量「${spec.label}」⇒ 规范写法「${spec.literal}」不在该行`,
          });
        }
      }
    }
  }

  return { issues, cells, carrierLines, comparisons };
}

/* ── 自测（★ 正控 + 反向对照 + 4 条负控 · **只用临时副本**） ── */

type Mutation = {
  readonly name: string;
  readonly expect: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
};

const NEGATIVE_CONTROLS: readonly Mutation[] = [
  {
    name: '负控 A · 把 4,065,792 B 改成 4,065,791 B',
    expect: CATEGORY_DRIFT,
    file: 'docs/baseline/README.md',
    from: '4,065,792 B',
    to: '4,065,791 B',
  },
  {
    name: '负控 B · 把 0.1323% 整段抹掉',
    expect: CATEGORY_MISSING,
    file: 'docs/baseline/README.md',
    from: '0.1323%',
    to: '（待定）',
  },
  {
    name: '负控 C · 改掉 H1′ 行的标题（载体定位不到）',
    expect: CATEGORY_LOCATE,
    file: 'docs/baseline/README.md',
    from: '**H1′ 单次写入的向量载荷字节**',
    to: '**H1′ 写入的向量载荷字节**',
  },
  {
    name: '负控 D · 把 3.877 MiB 写成 3.877MiB（少一个空格）',
    expect: CATEGORY_RENDER,
    file: 'docs/baseline/README.md',
    from: '3.877 MiB',
    to: '3.877MiB',
  },
];

function runSelfTest(): number {
  const dir = mkdtempSync(join(tmpdir(), 'benchmark-numbers-'));
  let failures = 0;

  try {
    const files = [...new Set(CARRIERS.map((carrier) => carrier.file))];
    const base = new Map<string, string>();
    for (const file of files) {
      base.set(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
    }

    /** 把【基准内容 + 覆盖】物化到临时目录（★ 绝不动仓库里的真实文件）。 */
    const materialize = (overrides: ReadonlyMap<string, string>): void => {
      for (const file of files) {
        const dest = join(dir, file);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, overrides.get(file) ?? base.get(file) ?? '', 'utf8');
      }
    };

    // ── 正控 ──
    materialize(new Map());
    const positive = check(dir);
    if (positive.issues.length === 0) {
      process.stdout.write(`✅ 正控：${positive.comparisons} 处比对全部一致 ⇒ 零错误\n`);
    } else {
      failures += 1;
      process.stdout.write('✗ 正控失败（不该有错误）：\n');
      for (const issue of positive.issues) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }

    // ── 反向对照：在【载体之外】插一行 ⇒ 仍应零错误（证明无假报警）──
    const reverseFile = 'docs/baseline/README.md';
    const reverseBase = base.get(reverseFile) ?? '';
    materialize(new Map([[reverseFile, `> （反向对照：这一行不属于任何载体）\n${reverseBase}`]]));
    const shifted = check(dir);
    if (shifted.issues.length === 0) {
      process.stdout.write('✅ 反向对照：在载体**之外**插一行 ⇒ 仍零错误（无假报警）\n');
    } else {
      failures += 1;
      process.stdout.write('✗ 反向对照失败（不该有错误）：\n');
      for (const issue of shifted.issues) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }

    // ── 负控：每条都必须报出**对应类别**（证明夹具真的进了判定路径）──
    for (const control of NEGATIVE_CONTROLS) {
      const original = base.get(control.file) ?? '';
      if (!original.includes(control.from)) {
        failures += 1;
        process.stdout.write(
          `✗ ${control.name} ⇒ **夹具没生效**（基准里找不到「${control.from}」）⇒ 夹具无效\n`,
        );
        continue;
      }
      const mutated = original.replace(control.from, control.to);
      if (mutated === original) {
        failures += 1;
        process.stdout.write(`✗ ${control.name} ⇒ **夹具没生效**（内容没被改坏）⇒ 夹具无效\n`);
        continue;
      }
      materialize(new Map([[control.file, mutated]]));
      const report = check(dir);

      // ★★★★ **根因断言**：mutate 之后，判定必须【不再通过】
      //   判据不是「mutate 前后内容变了」（太弱）⇒ ⇒ 必须是「判定结果变了」
      //   ⇒ ⇒ 否则这条负控自己就是恒绿的 ⇒ ⇒ 当场报错，不等别人发现。
      if (report.issues.length === 0) {
        failures += 1;
        process.stdout.write(
          `✗ ${control.name} ⇒ **判定仍然通过（零错误）** ⇒ ⇒ 这条负控自己就是恒绿的 ⇒ ` +
            '⇒ **夹具没进判定路径**（★ 已由这条根因断言当场抓住）\n',
        );
        continue;
      }

      const hit = report.issues.find((issue) => issue.category === control.expect);
      if (hit !== undefined) {
        process.stdout.write(`✅ ${control.name} ⇒ 报出「${control.expect}」\n`);
      } else {
        failures += 1;
        process.stdout.write(
          `✗ ${control.name} ⇒ **没有**报出「${control.expect}」（实际报出：` +
            `${report.issues.map((issue) => issue.category).join('、') || '（无）'}）\n`,
        );
      }
    }

    // ── ★ 自测 · 【根因断言自己有没有牙】 ──
    //   一条「关于守卫的守卫」自己也可能是恒绿的 ⇒ ⇒ 必须验它。
    //   这里造一个**不该变红**的改动（改一个**不属于任何载体**的行里的数）
    //   ⇒ ⇒ 判定**仍然零错误** ⇒ ⇒ 证明根因断言（判定必须不再通过）**有分辨力**。
    {
      const marker = '**1199.99ms**';
      const original = base.get(reverseFile) ?? '';
      if (!original.includes(marker)) {
        failures += 1;
        process.stdout.write('✗ 根因断言有牙：基准里找不到「写入 P99」那一行的标记 ⇒ 夹具无效\n');
      } else {
        materialize(new Map([[reverseFile, original.replace(marker, '**1199.98ms**')]]));
        const report = check(dir);
        if (report.issues.length === 0) {
          process.stdout.write(
            '✅ 根因断言有牙：改一个**不属于任何载体**的行里的数 ⇒ 判定**仍然零错误**' +
              '⇒ ⇒ 根因断言（判定必须不再通过）**有分辨力**、不是恒绿\n',
          );
        } else {
          failures += 1;
          process.stdout.write(
            '✗ 根因断言失牙：改非载体行竟然报出了 ' +
              `${report.issues.map((issue) => issue.category).join('、') || '（无）'} ⇒ ⇒ ` +
              `${WARN} **判定范围可能过宽** ⇒ ⇒ 需要复核载体选择器\n`,
          );
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stderr.write(`\n✗ 自测失败 ${failures} 项\n`);
    return 1;
  }
  process.stdout.write('\n✅ 自测全过 ⇒ 这条守卫**不是恒绿守卫**\n');
  return 0;
}

/* ── CLI ── */

function runCli(argv: readonly string[]): number {
  if (argv.includes('--self-test')) {
    return runSelfTest();
  }

  const rootIndex = argv.indexOf('--root');
  const rootArg = rootIndex === -1 ? '' : (argv[rootIndex + 1] ?? '');
  const root = rootArg === '' ? REPO_ROOT : resolve(rootArg);

  const report = check(root);

  process.stdout.write('跨载体一致性校验（同一批实测数在各处不许各说各话）\n');
  process.stdout.write(`  根目录：${root}\n`);
  process.stdout.write(
    `  载体：${CARRIERS.length} 类（${CARRIERS.map((c) => c.id).join(' / ')}）\n`,
  );
  process.stdout.write(`  比对的量：${SPECS.length} 个\n`);
  process.stdout.write(
    '  实测出处：2026-11-05 · 1,000,000 条 · 热档 · HDD（落盘 JSON 在 .tmp/，被 ignore ⇒ 不作锚点）\n',
  );

  for (const spec of SPECS) {
    const own = report.cells.filter((cell) => cell.specId === spec.id);
    const where = own
      .map((cell) => `${cell.carrierId}:${cell.lineNo}${cell.ok ? '' : ' ' + WARN}`)
      .join('  ');
    const mark = own.every((cell) => cell.ok) && own.length > 0 ? '✔' : `${WARN} 不一致`;
    process.stdout.write(`  ${mark} 「${spec.literal}」· ${spec.label}（${own.length} 处）\n`);
    process.stdout.write(`      ${where}\n`);
  }

  if (report.issues.length > 0) {
    process.stderr.write(`\n✗ 发现 ${report.issues.length} 处不一致：\n`);
    for (const issue of report.issues) {
      process.stderr.write(`    ${issue.category}：${issue.detail}\n`);
    }
    process.stderr.write('\n⇒ ⇒ 同一批数在多处各说各话 ⇒ ⇒ 改一处就必须同批改其余各处\n');
    return 1;
  }

  process.stdout.write(
    `\n✓ ${report.comparisons} 处比对全部逐位相等（零漂移）⇒ ⇒ 同一批数在各处说的是同一件事\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
