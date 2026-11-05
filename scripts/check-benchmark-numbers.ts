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

/**
 * ★★ **单向依赖**：★ 本文件 **import** `check-wording-drift.ts`（它导出）⇒ ⇒ **绝不能反向**
 * ⇒ ⇒ ★ **否则会成环** ⇒ ⇒ ★ **⇒ 「判定只有一份」的根据就在这两行的注释里**。
 *
 * ★ **为什么要 import 而不是自己写**：★ 豁免判定（引号内 = 引述形态 · 「真实含义是」 = 释义形态）
 * ★ **必须与旧措辞那条守卫【共用同一份切段实现】** ⇒ ⇒ **自己重写一遍 ⇒ ⇒ 两份判定会漂**。
 */
import { classifySnippet } from './check-wording-drift.js';

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
  /* ── 状态维度（★ 出关条件的状态：状态表那一格 ⇄ 对应 R 行那一格） ── */
  {
    id: 'status-table-1',
    label: '⑦ §7 出关条件状态表 · ① 行',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^> \| ① \|/,
    expectLines: 1,
  },
  {
    id: 'status-table-2',
    label: '⑦ §7 出关条件状态表 · ② 行',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^> \| ② \|/,
    expectLines: 1,
  },
  {
    id: 'status-table-3',
    label: '⑦ §7 出关条件状态表 · ③ 行',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^> \| ③ \|/,
    expectLines: 1,
  },
  {
    id: 'status-table-4',
    label: '⑦ §7 出关条件状态表 · ④ 行',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^> \| ④ \|/,
    expectLines: 1,
  },
  {
    id: 'gate-r2',
    label: '⑦ §7 风险表 · R2 行（出关条件①）',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^\| \*\*R2\*\* \|/,
    expectLines: 1,
  },
  {
    id: 'gate-r3',
    label: '⑦ §7 风险表 · R3 行（出关条件②）',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^\| \*\*R3\*\* \|/,
    expectLines: 1,
  },
  {
    id: 'gate-r4',
    label: '⑦ §7 风险表 · R4 行（出关条件③）',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^\| \*\*R4\*\* \|/,
    expectLines: 1,
  },
  {
    id: 'gate-r7',
    label: '⑦ §7 风险表 · R7 行（出关条件④）',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    pattern: /^\| \*\*R7\*\* \|/,
    expectLines: 1,
  },
  /* ── 措辞维度（★ 规范措辞必须在【断言形态】出现） ── */
  {
    id: 'perf-write-note',
    label: 'bench/perf.ts · 写路径 note（落盘真值）',
    file: 'bench/perf.ts',
    pattern: /实测精确分【至多】2 行/,
    expectLines: 1,
  },
  {
    id: 'design-doc-write',
    label: '① §4 · 写路径 note 示意（结构示意 · 非逐字副本）',
    file: 'docs/design/perf-c2-t06-byte-metering.md',
    pattern: /^\s*"note":.*实测精确分【至多】2 行/,
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
const CATEGORY_STATUS_MISSING = '状态字面缺失';
const CATEGORY_STATUS_CONFLICT = '状态语义冲突（两侧状态 emoji 不同）';
const CATEGORY_STATUS_REF = '状态表与 R 行的引用断裂';
const CATEGORY_STATUS_LINK = 'R 行与状态表的条件编号对不上';

/**
 * ★ 出关条件的**状态**（★ 状态 = 那一格的状态 emoji；★ 备注（「以替代口径达成」「已测 · 红」）**不是**状态）。
 *
 * ★ **为什么用 emoji 当状态、而不是逐字比对**：
 *   ★ 状态表用 `✅ **达成**`、R 行用 `✅ 2026-11-05 实测` ⇒ ⇒ **两侧字面【不同形】却是【同一个状态】**
 *   ⇒ ⇒ **⇒ 逐字相等判据在结构上就不成立** ⇒ ⇒ **⇒ 判据必须是【语义】而不是【字面】**。
 *   ⇒ ⇒ ★ 而 emoji 恰好就是那个跨形态稳定的语义标记 ⇒ ⇒ **两侧 emoji 相同 ⇒ ⇒ 状态相同**。
 *
 * ★ **为什么要限定「『出关条件』标记之后的第一个 emoji」**：
 *   ★ R7 那一行里有 **5 个 `✅`**（★ 后 4 个在字节账验算的上下文里）⇒ ⇒ **全行扫会取到错的** ⇒ ⇒
 *   ⇒ ⇒ **⇒ 必须从「出关条件」那个标记之后开始找** ⇒ ⇒ ★ **位置本身是判据的一部分**。
 */
const STATUS_EMOJI = ['✅', '⏳', '❌'] as const;

type StatusSpec = {
  readonly id: string;
  readonly label: string;
  /** 状态表那一格的载体 id。 */
  readonly tableCarrier: string;
  /** 对应 R 行那一格的载体 id。 */
  readonly gateCarrier: string;
  /** ★ **两侧必须一致的状态 emoji**（★ 规范值）。 */
  readonly state: (typeof STATUS_EMOJI)[number];
  /** ★ 状态表「依据」列里必须出现的 R 行引用（★ 写死 ⇒ ⇒ 把「状态表 ↔ R 行」这条引用链钉住）。 */
  readonly tableRef: string;
  /** ★ 对应 R 行里必须出现的条件编号引用（★ 写死 ⇒ ⇒ R 行里的【所有】同类标记都必须等于它）。 */
  readonly rConditionRef: string;
};

/**
 * ★ **出关条件状态清单**（★ 声明式 · 与 `SPECS` 同形态）。
 *
 * ★ **注意**：★ ① 与 ④ 都是 `✅`（★ ④ 是「以替代口径达成」⇒ ⇒ **备注不同、状态相同** ⇒ ⇒
 * ★ ⇒ **这正是「状态 = emoji、备注 ≠ 状态」的价值** ⇒ ⇒ ⇒ **如果按字面比，④ 会被误判成不一致**）。
 */
const STATUS_SPECS: readonly StatusSpec[] = [
  {
    id: 'gate-1',
    label: '出关条件① 1M 实测 bytesRead.max ≤ 6,144,000 B',
    tableCarrier: 'status-table-1',
    gateCarrier: 'gate-r2',
    state: '✅',
    tableRef: 'R2 行',
    rConditionRef: '出关条件①',
  },
  {
    id: 'gate-2',
    label: '出关条件② 码宽 ↔ ε ↔ 剪枝率 ↔ 延迟 四列表',
    tableCarrier: 'status-table-2',
    gateCarrier: 'gate-r3',
    state: '⏳',
    tableRef: 'R3 行',
    rConditionRef: '出关条件②',
  },
  {
    id: 'gate-3',
    label: '出关条件③ 1M 重编码实测 < 5 分钟',
    tableCarrier: 'status-table-3',
    gateCarrier: 'gate-r4',
    state: '❌',
    tableRef: 'R4 行',
    rConditionRef: '出关条件③',
  },
  {
    id: 'gate-4',
    label: '出关条件④ 报告 bytesRead 与 survivors 的 p50/p99/max',
    tableCarrier: 'status-table-4',
    gateCarrier: 'gate-r7',
    state: '✅',
    tableRef: 'R7 行',
    rConditionRef: '出关条件④',
  },
];

/**
 * ★ **期望的锚点清单形状**（★ 与被测对象【分处两地】⇒ ⇒ 清单被悄悄改宽 ⇒ ⇒ 必红）。
 *
 * ★ **为什么必须有一份【不在被测对象里】的硬编码期望**：
 *   守卫怎么知道「少列了一个载体」？⇒ ⇒ 判据必须有一个【独立于清单】的期望值
 *   ⇒ ⇒ 否则「改宽」这件事本身【不可判定】⇒ ⇒ ⇒ **★ 这正是「守卫被改成恒绿」的同款**。
 */
const EXPECTED_ANCHOR_SHAPE: readonly {
  readonly id: string;
  readonly carrierCount: number;
}[] = [
  { id: 'exact-rows-at-most-2', carrierCount: 4 },
  { id: 'gate-1', carrierCount: 2 },
  { id: 'gate-2', carrierCount: 2 },
  { id: 'gate-3', carrierCount: 2 },
  { id: 'gate-4', carrierCount: 2 },
];

/**
 * ★ **措辞锚点清单**（★ 声明式 · 与 `SPECS` / `STATUS_SPECS` 同形态）。
 *
 * ★ **判据**：★ 每个载体的那一行 ⇒ ⇒ **必须逐字含 `wording`** ⇒ ⇒ ★ **而且 `wording` 在该行里必须处于【断言形态】**
 * ⇒ ⇒ ★ **引述形态 / 释义形态 ⇒ ⇒ 豁免**（★ 那是「在引用这个说法」、不是「在断言这个说法」）。
 *
 * ★ **为什么载体要「自带位置限定」**（`where`）：★ 不然就得去猜「哪些文件要核」⇒ ⇒ **新载体不会被自动覆盖**
 * ⇒ ⇒ ★ **★ 而「载体清单要维护」本身就是要守的东西** ⇒ ⇒ ★ **⇒ 让每条锚点自带它的载体 ⇒ ⇒ 就不用维护第二份清单**。
 */
const WORDING_ANCHORS: readonly {
  readonly id: string;
  readonly label: string;
  /** 规范措辞（★ 逐位比对的基准 · 含标点）。 */
  readonly wording: string;
  /** ★ **同族正则**（★ 区分「说法变了」与「压根没写」⇒ ⇒ 分开报类别）。 */
  /** ★★ **必须带 `g` 标志**（★ `String.prototype.matchAll` 对无 g 的正则会抛 TypeError）。 */
  readonly family?: RegExp;
  /** 必须逐字一致的载体（★ 每条自带 ⇒ ⇒ 不用去猜哪些文件要核）。 */
  readonly carriers: readonly {
    readonly carrier: string;
    /**
     * 该载体里这条措辞的【位置限定】（★ 正则 ⇒ ⇒ **不用行号**，行号会漂）。
     *
     * ★★★ **它必须【独立于被检验的内容】**（★ 不能就是 `wording` 本身）：
     *   ★ 若 `where` == `wording` ⇒ ⇒ 有人把措辞改掉 ⇒ ⇒ **定位先失败** ⇒ ⇒
     *   ⇒ 报出来的是「缺失」而不是「漂移」⇒ ⇒ ⇒ **「漂移」这一类就永远测不出来**
     *   ⇒ ⇒ ⇒ **守卫的定位与判据【不能耦合】** ⇒ ⇒ ⇒ **⇒ 这是一条通用纪律**。
     */
    readonly where: RegExp;
  }[];
}[] = [
  {
    id: 'exact-rows-at-most-2',
    label: '「实测精确分至多 2 行」这条口径措辞',
    wording: '2026-11-05 实测精确分【至多】2 行',
    family: /实测精确分[^，。；）]{0,8}2 行/g,
    carriers: [
      { carrier: 'perf-write-note', where: /实测精确分/ },
      { carrier: 'impl-write', where: /实测精确分/ },
      { carrier: 'design-doc-write', where: /实测精确分/ },
      { carrier: 'adr-4.44', where: /实测精确分/ },
    ],
  },
];

/** 措辞锚点（★ 供负控覆盖清单用 ⇒ 类型单独抽出来）。 */
type WordingAnchor = (typeof WORDING_ANCHORS)[number];

/**
 * ★ 锚点条目总数上限（★ **放宽必须显式传参** `--max-anchors N` ⇒ ⇒ **不许悄悄改常量**）。
 */
const DEFAULT_MAX_ANCHORS = 8;

const CATEGORY_ANCHOR_WIDENED = '锚点清单被改宽';

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
 * ★ 提取一行里【「出关条件」标记之后】的**第一个状态 emoji**。
 *
 * ★ **为什么要限定「之后」**：★ R7 那一行里有 5 个 `✅`（★ 后 4 个在字节账验算的上下文里）⇒ ⇒
 * ★ ⇒ 全行扫会取到错的 ⇒ ⇒ **位置本身是判据的一部分**。
 *
 * @returns 状态 emoji；★ 找不到 ⇒ `undefined`
 */
function extractStateEmoji(line: string): (typeof STATUS_EMOJI)[number] | undefined {
  const marker = line.indexOf('出关条件');
  const scope = marker >= 0 ? line.slice(marker) : line;
  for (const emoji of STATUS_EMOJI) {
    const at = scope.indexOf(emoji);
    if (at >= 0) {
      // ★ 「第一个」= 在 scope 里位置最靠前的那一个（★ 三种 emoji 混在一起时也要取最靠前的）
      const first = Math.min(
        ...STATUS_EMOJI.map((candidate) => {
          const found = scope.indexOf(candidate);
          return found >= 0 ? found : Number.POSITIVE_INFINITY;
        }),
      );
      return scope[first] as (typeof STATUS_EMOJI)[number];
    }
  }
  return undefined;
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

/* ── 状态维度（★ 出关条件的状态：状态表那一格 ⇄ 对应 R 行那一格） ── */

type StatusCell = {
  readonly specId: string;
  readonly carrierId: string;
  readonly lineNo: number;
  readonly state: (typeof STATUS_EMOJI)[number] | undefined;
  readonly ok: boolean;
};

type StatusReport = {
  readonly issues: readonly Issue[];
  readonly cells: readonly StatusCell[];
  readonly comparisons: number;
};

/**
 * ★ 跑一遍**状态维度**的检查（★ 与数值维度【完全独立】⇒ ⇒ 数值维度零回归风险）。
 *
 * ★ **判据**：★ 每个出关条件 ⇒ ⇒ **状态表那一格的状态 emoji 必须与对应 R 行那一格的状态 emoji 相同**
 * ⇒ ⇒ **⇒ 两侧表达同一个状态**。
 */
function checkStatus(root: string): StatusReport {
  const issues: Issue[] = [];
  const cells: StatusCell[] = [];

  // ── ① 定位载体（★ 定位不到 ⇒ 红 ⇒ 不许静默跳过）──
  const lines = new Map<string, { readonly lineNo: number; readonly text: string }[]>();
  for (const carrier of CARRIERS) {
    const path = join(root, carrier.file);
    let content: { readonly lineNo: number; readonly text: string }[] = [];
    try {
      content = readLines(path);
    } catch {
      issues.push({
        category: CATEGORY_LOCATE,
        detail: `${carrier.label}（${carrier.file}）⇒ 文件读不到（${path}）`,
      });
      continue;
    }
    const hits = content.filter((line) => carrier.pattern.test(line.text));
    if (hits.length !== carrier.expectLines) {
      issues.push({
        category: CATEGORY_LOCATE,
        detail:
          `${carrier.label}（${carrier.file}）⇒ 应命中 ${carrier.expectLines} 行，` +
          `实际命中 ${hits.length} 行（${hits.map((hit) => hit.lineNo).join('、') || '无'}）`,
      });
      continue;
    }
    lines.set(carrier.id, hits);
  }

  // ── ② ★ 引用链检查（★ 状态表「依据」列 → R 行 · ★ 那一行的 R 行必须存在）──
  for (const spec of STATUS_SPECS) {
    const tableHit = lines.get(spec.tableCarrier)?.[0];
    if (tableHit === undefined) {
      continue; // 载体定位失败已经报过
    }
    if (!tableHit.text.includes(spec.tableRef)) {
      issues.push({
        category: CATEGORY_STATUS_REF,
        detail:
          `${spec.tableCarrier}（${CARRIER_BY_ID.get(spec.tableCarrier)?.file ?? '?'}:${tableHit.lineNo}）` +
          `· 条件「${spec.label}」⇒ 「依据」列里没有引用「${spec.tableRef}」` +
          '⇒ ⇒ 状态表与 R 行的引用链断了',
      });
    }
  }

  // ── ③ ★ 条件编号一致性（★ R 行里的【所有】「出关条件N」标记都必须指向同一个编号）──
  //   ★ 「有没有那个标记」不够 —— ★ 「有两个不同的标记」才是不一致 ⇒ ⇒ 全部必须相等。
  for (const spec of STATUS_SPECS) {
    const gateHit = lines.get(spec.gateCarrier)?.[0];
    if (gateHit === undefined) {
      continue;
    }
    const refs = [...gateHit.text.matchAll(/出关条件[①②③④]/gu)].map((match) => match[0]);
    const wrong = [...new Set(refs)].filter((ref) => ref !== spec.rConditionRef);
    if (wrong.length > 0) {
      issues.push({
        category: CATEGORY_STATUS_LINK,
        detail:
          `${spec.gateCarrier}（${CARRIER_BY_ID.get(spec.gateCarrier)?.file ?? '?'}:${gateHit.lineNo}）` +
          `· 条件「${spec.label}」⇒ 该行里的条件编号标记有 ${wrong.join('、')}` +
          `，而状态表那一格是「${spec.rConditionRef}」⇒ ⇒ 编号对不上`,
      });
    }
  }

  // ── ④ 逐条件比对两侧的状态 emoji ──
  let comparisons = 0;
  for (const spec of STATUS_SPECS) {
    const tableHit = lines.get(spec.tableCarrier)?.[0];
    const gateHit = lines.get(spec.gateCarrier)?.[0];
    if (tableHit === undefined || gateHit === undefined) {
      // 载体定位失败已经报过 ⇒ 这里不重复报
      continue;
    }
    const tableState = extractStateEmoji(tableHit.text);
    const gateState = extractStateEmoji(gateHit.text);
    const tableWhere = `${spec.tableCarrier}（${CARRIER_BY_ID.get(spec.tableCarrier)?.file ?? '?'}:${tableHit.lineNo}）`;
    const gateWhere = `${spec.gateCarrier}（${CARRIER_BY_ID.get(spec.gateCarrier)?.file ?? '?'}:${gateHit.lineNo}）`;

    for (const [where, state] of [
      [tableWhere, tableState],
      [gateWhere, gateState],
    ] as const) {
      comparisons += 1;
      if (state === undefined) {
        cells.push({ specId: spec.id, carrierId: where, lineNo: 0, state, ok: false });
        issues.push({
          category: CATEGORY_STATUS_MISSING,
          detail:
            `${where} · 条件「${spec.label}」⇒ 该格**读不出状态 emoji**` +
            '（★ 状态 = ✅ / ⏳ / ❌；★ 要从「出关条件」标记之后开始找）',
        });
        continue;
      }
      const ok = state === spec.state;
      cells.push({ specId: spec.id, carrierId: where, lineNo: 0, state, ok });
      if (!ok) {
        issues.push({
          category: CATEGORY_STATUS_CONFLICT,
          detail:
            `${where} · 条件「${spec.label}」⇒ 状态是「${state}」、` +
            `但规范状态是「${spec.state}」⇒ ⇒ **两侧表达的状态不一致**`,
        });
      }
    }
  }

  // ★ ★ 清单形状的两道锁【不在这里做】⇒ ⇒ **统一放在措辞维度**（★ 它同时知道措辞锚点与状态清单）
  //   ⇒ ⇒ 否则两个维度各查一半 ⇒ ⇒ 会重复报、也会各报一半。

  return { issues, cells, comparisons };
}

/* ── 措辞维度（★ 规范措辞必须在【断言形态】出现） ── */

const CATEGORY_WORDING_MISSING = '措辞缺失';
const CATEGORY_WORDING_NOT_ASSERTED = '措辞不在断言处';
const CATEGORY_WORDING_DRIFT = '措辞漂移（断言处是别的说法）';

type WordingCell = {
  readonly anchorId: string;
  readonly carrierId: string;
  readonly lineNo: number;
  readonly ok: boolean;
};

type WordingReport = {
  readonly issues: readonly Issue[];
  readonly cells: readonly WordingCell[];
  readonly comparisons: number;
};

/**
 * ★ 跑一遍**措辞维度**的检查（★ 与数值维度、状态维度【完全独立】）。
 *
 * ★ **判据**：★ 每个载体的那一行 ⇒ ⇒ **必须逐字含规范措辞** ⇒ ⇒ ★ **而且它必须处于【断言形态】**
 * ⇒ ⇒ ★ **引述形态 / 释义形态 ⇒ ⇒ 豁免**（★ 那是「在引用这个说法」、不是「在断言这个说法」）。
 */
function checkWording(
  root: string,
  maxAnchors: number,
  anchors: readonly WordingAnchor[] = WORDING_ANCHORS,
): WordingReport {
  const issues: Issue[] = [];
  const cells: WordingCell[] = [];

  // ── ① 定位载体 ──
  const lines = new Map<string, { readonly lineNo: number; readonly text: string }[]>();
  for (const carrier of CARRIERS) {
    const path = join(root, carrier.file);
    let content: { readonly lineNo: number; readonly text: string }[] = [];
    try {
      content = readLines(path);
    } catch {
      issues.push({
        category: CATEGORY_LOCATE,
        detail: `${carrier.label}（${carrier.file}）⇒ 文件读不到（${path}）`,
      });
      continue;
    }
    const hits = content.filter((line) => carrier.pattern.test(line.text));
    if (hits.length !== carrier.expectLines) {
      issues.push({
        category: CATEGORY_LOCATE,
        detail:
          `${carrier.label}（${carrier.file}）⇒ 应命中 ${carrier.expectLines} 行，` +
          `实际命中 ${hits.length} 行（${hits.map((hit) => hit.lineNo).join('、') || '无'}）`,
      });
      continue;
    }
    lines.set(carrier.id, hits);
  }

  // ── ② 逐锚点逐载体比对措辞 ──
  let comparisons = 0;
  for (const anchor of anchors) {
    for (const target of anchor.carriers) {
      const hits = lines.get(target.carrier);
      if (hits === undefined) {
        continue; // 载体定位失败已经报过
      }
      // ★ 用锚点自带的 `where` 在该载体的命中行里再定位一次（★ 不用行号 ⇒ ⇒ 行号会漂）
      const hit = hits.find((line) => target.where.test(line.text));
      if (hit === undefined) {
        issues.push({
          category: CATEGORY_WORDING_MISSING,
          detail:
            `${target.carrier}（${CARRIER_BY_ID.get(target.carrier)?.file ?? '?'}）` +
            `⇒ 锚点「${anchor.label}」的定位正则没命中任何一行`,
        });
        continue;
      }
      comparisons += 1;
      const where = `${target.carrier}（${CARRIER_BY_ID.get(target.carrier)?.file ?? '?'}:${hit.lineNo}）`;

      if (!hit.text.includes(anchor.wording)) {
        cells.push({
          anchorId: anchor.id,
          carrierId: target.carrier,
          lineNo: hit.lineNo,
          ok: false,
        });
        // ★ 判「漂移」还是「缺失」：★ 若该行有【同族变体】（★ 例如把「【至多】2 行」写成「最多 2 行」）
        //   ⇒ ⇒ 那就是**说法变了** ⇒ ⇒ 比「压根没写」更接近真相 ⇒ ⇒ 分开报。
        const variant =
          anchor.family === undefined
            ? []
            : [...hit.text.matchAll(anchor.family)].map((match) => match[0]);
        if (variant.length > 0) {
          issues.push({
            category: CATEGORY_WORDING_DRIFT,
            detail: `${where} · 措辞「${anchor.label}」⇒ 规范写法「${anchor.wording}」不在该行，该行出现了同族的说法：${variant.join('、')}`,
          });
        } else {
          issues.push({
            category: CATEGORY_WORDING_MISSING,
            detail: `${where} · 措辞「${anchor.label}」⇒ 规范写法「${anchor.wording}」不在该行`,
          });
        }
        continue;
      }

      // ★ ★ 形态判定（★ 用上游那份判定 ⇒ ⇒ 判定只有一份）
      const shape = classifySnippet(hit.text, anchor.wording);
      if (shape === undefined) {
        cells.push({
          anchorId: anchor.id,
          carrierId: target.carrier,
          lineNo: hit.lineNo,
          ok: false,
        });
        issues.push({
          category: CATEGORY_WORDING_MISSING,
          detail: `${where} · 措辞「${anchor.label}」⇒ 形态判定读不出（子串不在行内）`,
        });
        continue;
      }
      if (shape === 'explanation') {
        // ★ ★ **只有「释义形态」才豁免**（★ 那一行是在解释这个词 ⇒ ⇒ 合法）
        //   ⇒ ⇒ ★ **「引述形态」【不豁免】**（★ 把规范措辞包进引号 ⇒ ⇒ 那是在【引用旧说法】、
        //   不是在【断言当前口径】⇒ ⇒ 必须红）★ ⇒ ★ 这条区分是本维度的核心。
        cells.push({
          anchorId: anchor.id,
          carrierId: target.carrier,
          lineNo: hit.lineNo,
          ok: true,
        });
        continue;
      }
      if (shape === 'quoted') {
        cells.push({
          anchorId: anchor.id,
          carrierId: target.carrier,
          lineNo: hit.lineNo,
          ok: false,
        });
        issues.push({
          category: CATEGORY_WORDING_NOT_ASSERTED,
          detail: `${where} · 措辞「${anchor.label}」⇒ 规范写法「${anchor.wording}」**落在引号内** ⇒ ⇒ 那是【引用】、不是【断言当前口径】⇒ ⇒ 必须以断言形态出现`,
        });
        continue;
      }

      cells.push({ anchorId: anchor.id, carrierId: target.carrier, lineNo: hit.lineNo, ok: true });
    }
  }

  // ── ③ ★ 清单形状的两道锁（★ 与状态维度共用同一份期望形状）──
  const expectedIds = EXPECTED_ANCHOR_SHAPE.map((entry) => entry.id);
  const actualIds = [...anchors.map((anchor) => anchor.id), ...STATUS_SPECS.map((spec) => spec.id)];
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  const extra = actualIds.filter((id) => !expectedIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    issues.push({
      category: CATEGORY_ANCHOR_WIDENED,
      detail:
        `锚点清单的条目集合与期望形状不一致（★ 期望：${expectedIds.join('、')}；` +
        `实际：${actualIds.join('、')}；★ 缺：${missing.join('、') || '无'}；` +
        `★ 多：${extra.join('、') || '无'}）⇒ ⇒ **清单被改宽 / 改窄**`,
    });
  }
  // ★★★ ★★★ **逐条比【载体数】**（★★ 这一段此前**从未存在** ⇒ ⇒ `EXPECTED_ANCHOR_SHAPE`
  //   里的 `carrierCount` 字段是**死的** ⇒ ⇒ 「清单少列了一个载体」【没人管】⇒ ⇒ 锁一形同虚设）。
  //   ⚠️ ★ 上面的注释写着「守卫怎么知道『少列了一个载体』？⇒ ⇒ 判据必须有一个【独立于清单】的期望值」
  //   ⇒ ⇒ **那正是本段要做的事** ⇒ ⇒ 注释承诺的行为必须真的发生（★ 否则 = 「说过头」）。
  const actualCarrierCount = (id: string): number | undefined => {
    const anchor = anchors.find((candidate) => candidate.id === id);
    if (anchor !== undefined) {
      return anchor.carriers.length;
    }
    const spec = STATUS_SPECS.find((candidate) => candidate.id === id);
    if (spec !== undefined) {
      // ★ 状态规格牵住【两侧】＝ 状态表那一格 + 对应 R 行那一格
      return 2;
    }
    return undefined;
  };
  for (const expected of EXPECTED_ANCHOR_SHAPE) {
    const actual = actualCarrierCount(expected.id);
    if (actual === undefined) {
      continue;
    }
    if (actual !== expected.carrierCount) {
      issues.push({
        category: CATEGORY_ANCHOR_WIDENED,
        detail:
          `锚点「${expected.id}」⇒ ★ 期望牵住 ${expected.carrierCount} 个载体、` +
          `实际 ${actual} 个 ⇒ ⇒ **清单被改窄 / 改宽**` +
          '⇒ ⇒ 改清单必须同批改期望（★ 期望形状在【分处两地】的硬编码里）',
      });
    }
  }
  if (actualIds.length > maxAnchors) {
    issues.push({
      category: CATEGORY_ANCHOR_WIDENED,
      detail:
        `锚点清单的条目数 ${actualIds.length} 超过上限 ${maxAnchors}` +
        '（★ 放宽必须**显式**传参 `--max-anchors N` ⇒ ⇒ 不许悄悄改常量）',
    });
  }

  return { issues, cells, comparisons };
}

/* ── 自测（★ 正控 + 反向对照 + 4 条负控 · **只用临时副本**） ── */

type Mutation = {
  readonly name: string;
  /** ★ 这条负控针对【哪个维度】（★ 三个维度各自独立 ⇒ ⇒ 必须声明 ⇒ ⇒ 否则自测不知道该跑哪个）。 */
  readonly dimension: 'numbers' | 'status' | 'wording';
  readonly expect: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
};

const NEGATIVE_CONTROLS: readonly Mutation[] = [
  {
    name: '负控 A · 把 4,065,792 B 改成 4,065,791 B',
    dimension: 'numbers',
    expect: CATEGORY_DRIFT,
    file: 'docs/baseline/README.md',
    from: '4,065,792 B',
    to: '4,065,791 B',
  },
  {
    name: '负控 B · 把 0.1323% 整段抹掉',
    dimension: 'numbers',
    expect: CATEGORY_MISSING,
    file: 'docs/baseline/README.md',
    from: '0.1323%',
    to: '（待定）',
  },
  {
    name: '负控 C · 改掉 H1′ 行的标题（载体定位不到）',
    dimension: 'numbers',
    expect: CATEGORY_LOCATE,
    file: 'docs/baseline/README.md',
    from: '**H1′ 单次写入的向量载荷字节**',
    to: '**H1′ 写入的向量载荷字节**',
  },
  {
    name: '负控 D · 把 3.877 MiB 写成 3.877MiB（少一个空格）',
    dimension: 'numbers',
    expect: CATEGORY_RENDER,
    file: 'docs/baseline/README.md',
    from: '3.877 MiB',
    to: '3.877MiB',
  },
  {
    name: '负控 E · 把状态表①的状态从 ✅ 改成 ❌（★ 与 R2 的 ✅ 矛盾）',
    expect: CATEGORY_STATUS_CONFLICT,
    dimension: 'status',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    from: '> | ① | 1M 实测 `bytesRead.max` ≤ 6,144,000 B（**且** 剪枝率 ≤ 15%） | ✅ **达成** |',
    to: '> | ① | 1M 实测 `bytesRead.max` ≤ 6,144,000 B（**且** 剪枝率 ≤ 15%） | ❌ **不达成** |',
  },
  {
    name: '负控 F · 把 R3 的状态 emoji 删掉（★ 状态字面缺失）',
    expect: CATEGORY_STATUS_MISSING,
    dimension: 'status',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    from: '⏳ **2026-11-05：未达成（★ 决策前置 · 码宽还没选 ⇒ ⇒ 它不是实测能闭合的 ⇒ ⇒ 不许算进「实测达成率」）**',
    to: '（待定）',
  },
  {
    name: '负控 G · 把规范措辞改成同族变体（★ 措辞漂移）',
    expect: CATEGORY_WORDING_DRIFT,
    dimension: 'wording',
    file: 'docs/design/perf-c2-t06-byte-metering-impl-notes.md',
    from: '2026-11-05 实测精确分【至多】2 行',
    to: '2026-11-05 实测精确分最多 2 行',
  },
  {
    name: '负控 H · 把规范措辞整段抹掉（★ 措辞缺失）',
    expect: CATEGORY_WORDING_MISSING,
    dimension: 'wording',
    file: 'docs/design/perf-c2-t06-byte-metering-impl-notes.md',
    from: '2026-11-05 实测精确分【至多】2 行',
    to: '2026-11-05 实测精确分若干行',
  },
  {
    name: '负控 I · 把规范措辞包进引号（★ 变成引述形态 ⇒ 不是断言当前口径）',
    expect: CATEGORY_WORDING_NOT_ASSERTED,
    dimension: 'wording',
    file: 'docs/design/perf-c2-t06-byte-metering-impl-notes.md',
    from: '2026-11-05 实测精确分【至多】2 行',
    to: '「2026-11-05 实测精确分【至多】2 行」',
  },
  {
    name: '负控 J · 把状态表④的「依据」列引用改掉（★ 引用链断裂）',
    expect: CATEGORY_STATUS_REF,
    dimension: 'status',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    from: '| ✅ **以替代口径达成** | R7 行 ·',
    to: '| ✅ **以替代口径达成** | R9 行 ·',
  },
  {
    name: '负控 K · 把 R7 行里的条件编号改成另一个（★ 编号对不上）',
    expect: CATEGORY_STATUS_LINK,
    dimension: 'status',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    from: '出关条件④：报告 `bytesRead` 与 `survivors` 的 p50/**p99/max**',
    to: '出关条件①：报告 `bytesRead` 与 `survivors` 的 p50/**p99/max**',
  },
  {
    name: '负控 L · 把状态表①的 R 行引用删掉（★ 引用链断裂）',
    expect: CATEGORY_STATUS_REF,
    dimension: 'status',
    file: 'docs/design/perf-c2-admissible-two-stage.md',
    from: '| ✅ **达成** | R2 行 ·',
    to: '| ✅ **达成** | ·',
  },
];

/**
 * ★ **清单级负控**（★ 改的是【清单】、不是文件 ⇒ ⇒ 需要另一套机制）。
 *
 * ⚠️ ★ **为什么必须有它们**：★★ **两把锁（期望形状 / 上限）此前【一条负控都没有】**
 *   ⇒ ⇒ 也就是说「锁有没有牙」**从来没被验过** ⇒ ⇒ ★ **实测：锁一的 `carrierCount` 字段是死的**
 *   ⇒ ⇒ 清单少列一个载体 ⇒ ⇒ 守卫**不红** ⇒ ⇒ ⇒ **这正是「守卫的守卫没有守卫」**
 *   ⇒ ⇒ ⇒ ★ 所以这两条负控是**给锁装上牙齿**，不是给守卫再加一层装饰。
 */
type ListControl = {
  readonly name: string;
  /** 期望的失败类别（★ `''` ⇒ **不许**报这一类 ⇒ ⇒ 用来验「显式放宽上限」确实生效）。 */
  readonly expect: string;
  readonly run: (dir: string) => WordingReport;
};

const LIST_CONTROLS: readonly ListControl[] = [
  {
    name: '负控 M · 清单被改窄（把措辞锚点少列一个载体 ⇒ ⇒ 期望形状的载体数对不上）',
    expect: CATEGORY_ANCHOR_WIDENED,
    run: (dir) =>
      checkWording(
        dir,
        DEFAULT_MAX_ANCHORS,
        WORDING_ANCHORS.map((anchor) => ({
          ...anchor,
          carriers: anchor.carriers.slice(0, anchor.carriers.length - 1),
        })),
      ),
  },
  {
    name: '负控 N · 清单条目数超过上限（上限显式调到 1 ⇒ ⇒ 实际 5 条 ⇒ ⇒ 超了）',
    expect: CATEGORY_ANCHOR_WIDENED,
    run: (dir) => checkWording(dir, 1),
  },
  {
    name: '负控 N2 · 显式放宽上限（上限显式调到 5 ⇒ ⇒ 不再报「超过上限」）',
    expect: '',
    run: (dir) => checkWording(dir, 5),
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
    const positiveStatus = checkStatus(dir);
    const positiveWording = checkWording(dir, DEFAULT_MAX_ANCHORS);
    const positiveAll = [...positive.issues, ...positiveStatus.issues, ...positiveWording.issues];
    if (positiveAll.length === 0) {
      process.stdout.write(
        `✅ 正控：数值 ${positive.comparisons} 处 + 状态 ${positiveStatus.comparisons} 侧 + ` +
          `措辞 ${positiveWording.comparisons} 处 全部一致 ⇒ 零错误
`,
      );
      for (const issue of positiveAll) {
        process.stdout.write(`    ${issue.category}：${issue.detail}\n`);
      }
    }

    // ── 反向对照：在【载体之外】插一行 ⇒ 仍应零错误（证明无假报警）──
    const reverseFile = 'docs/baseline/README.md';
    const reverseBase = base.get(reverseFile) ?? '';
    materialize(new Map([[reverseFile, `> （反向对照：这一行不属于任何载体）\n${reverseBase}`]]));
    const shifted = check(dir);
    const shiftedStatus = checkStatus(dir);
    const shiftedWording = checkWording(dir, DEFAULT_MAX_ANCHORS);
    const shiftedAll = [...shifted.issues, ...shiftedStatus.issues, ...shiftedWording.issues];
    if (shiftedAll.length === 0) {
      process.stdout.write('✅ 反向对照：在载体**之外**插一行 ⇒ 仍零错误（无假报警）\n');
    } else {
      failures += 1;
      process.stdout.write('✗ 反向对照失败（不该有错误）：\n');
      for (const issue of shiftedAll) {
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
      // ★ 按这条负控针对的维度选检查函数（★ 三个维度各自独立 ⇒ ⇒ 必须选对）
      const report =
        control.dimension === 'status'
          ? checkStatus(dir)
          : control.dimension === 'wording'
            ? checkWording(dir, DEFAULT_MAX_ANCHORS)
            : check(dir);

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

    // ── ★ 清单级负控：改的是【清单】、不是文件（★ 给两把锁装上牙齿）──
    for (const control of LIST_CONTROLS) {
      const report = control.run(dir);
      if (control.expect === '') {
        // ★ 期望「不报这一类」⇒ ⇒ 用来验「显式放宽上限确实生效」
        const fired = report.issues.filter((issue) => issue.category === CATEGORY_ANCHOR_WIDENED);
        if (fired.length === 0) {
          process.stdout.write(`✅ ${control.name} ⇒ **没有**报「${CATEGORY_ANCHOR_WIDENED}」\n`);
        } else {
          failures += 1;
          process.stdout.write(
            `✗ ${control.name} ⇒ 竟然报出了「${CATEGORY_ANCHOR_WIDENED}」⇒ ⇒ 显式放宽上限没生效\n`,
          );
        }
        continue;
      }
      // ★ **根因断言**：mutate 之后，判定必须【不再通过】⇒ ⇒ 否则这条负控自己就是恒绿的
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

  const maxIndex = argv.indexOf('--max-anchors');
  const maxArg = maxIndex === -1 ? '' : (argv[maxIndex + 1] ?? '');
  const maxAnchors = maxArg === '' ? DEFAULT_MAX_ANCHORS : Number(maxArg);

  const report = check(root);
  const statusReport = checkStatus(root);
  const wordingReport = checkWording(root, maxAnchors);

  process.stdout.write('跨载体一致性校验（同一批实测数在各处不许各说各话）\n');
  process.stdout.write(`  根目录：${root}\n`);
  process.stdout.write(
    `  载体：${CARRIERS.length} 类（${CARRIERS.map((c) => c.id).join(' / ')}）\n`,
  );
  process.stdout.write(`  比对的量：${SPECS.length} 个（★ 数值维度）\n`);
  process.stdout.write(
    `  出关条件状态：${STATUS_SPECS.length} 个（★ 状态维度 · 状态表 ⇄ 对应 R 行）\n`,
  );
  process.stdout.write(
    `  措辞锚点：${WORDING_ANCHORS.length} 条（★ 措辞维度 · 规范措辞必须在断言形态）\n`,
  );
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

  for (const spec of STATUS_SPECS) {
    const own = statusReport.cells.filter((cell) => cell.specId === spec.id);
    const where = own
      .map((cell) => `${cell.carrierId}：${cell.state ?? '读不出'}${cell.ok ? '' : ' ' + WARN}`)
      .join('  ');
    const mark = own.every((cell) => cell.ok) && own.length > 0 ? '✔' : `${WARN} 不一致`;
    process.stdout.write(`  ${mark} 状态「${spec.state}」· ${spec.label}（${own.length} 侧）\n`);
    process.stdout.write(`      ${where}\n`);
  }

  for (const anchor of WORDING_ANCHORS) {
    const own = wordingReport.cells.filter((cell) => cell.anchorId === anchor.id);
    const where = own
      .map((cell) => `${cell.carrierId}:${cell.lineNo}${cell.ok ? '' : ' ' + WARN}`)
      .join('  ');
    const mark = own.every((cell) => cell.ok) && own.length > 0 ? '✔' : `${WARN} 不一致`;
    process.stdout.write(
      `  ${mark} 措辞「${anchor.wording}」· ${anchor.label}（${own.length} 处）\n`,
    );
    process.stdout.write(`      ${where}\n`);
  }

  const allIssues = [...report.issues, ...statusReport.issues, ...wordingReport.issues];
  if (allIssues.length > 0) {
    process.stderr.write(`\n✗ 发现 ${allIssues.length} 处不一致：\n`);
    for (const issue of allIssues) {
      process.stderr.write(`    ${issue.category}：${issue.detail}\n`);
    }
    process.stderr.write('\n⇒ ⇒ 同一批数在多处各说各话 ⇒ ⇒ 改一处就必须同批改其余各处\n');
    return 1;
  }

  process.stdout.write(
    `\n✓ 数值维度 ${report.comparisons} 处比对全部逐位相等（零漂移）` +
      '⇒ ⇒ 同一批数在各处说的是同一件事\n',
  );
  process.stdout.write(
    `✓ 状态维度 ${statusReport.comparisons} 侧状态一致（状态表 ⇄ 对应 R 行）` +
      '⇒ ⇒ 出关条件的状态没有被两处维护拖成矛盾\n',
  );
  process.stdout.write(
    `✓ 措辞维度 ${wordingReport.comparisons} 处规范措辞在断言形态` +
      '⇒ ⇒ 同一句话在各处的说法一致\n',
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
