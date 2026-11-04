/**
 * bench 的**字节来源解析**（T06 · C′ 档 H1′ 的取数装置 · **结论二**）。
 *
 * ⚠️ ★ **这个文件为什么存在**（口径：`docs/design/perf-c2-t06-byte-metering.md` §3.2）：
 *   字节账不能靠「开放的表 + 列规则」算 —— 那种规则下**任何** `memories` 语句都会命中
 *   「向量来源」或「窄读来源」⇒ **「命中零来源」恒为 0** ⇒ 守卫没牙；而且
 *   `SELECT * FROM memories` 会被**静默判成窄读** ⇒ 字节账**静默偏低**。
 *   ⇒ ⇒ **改成「形状登记制」**：只有**登记在册的语句形状**才认领来源；
 *     **未登记 ⇒ 命中零来源 ⇒ `unclassifiedRows` ⇒ 判红**（这是**期望行为**，不是误报）。
 *
 * ⚠️ ★ **纯函数、零 db 依赖**（口径 §8 的 T06-1 验收标准第 10 条）：
 *   解析函数不碰库句柄 ⇒ ⇒ **可单测**（形状登记表自测 + 字节模型单测都在
 *   `tests/bench/t06-byte-metering.test.ts` 里）⇒ ⇒ 分类逻辑不会随生产 SQL 一起腐坏。
 *
 * ⚠️ ★ **形状键 = (归一化的表集合, 归一化的源列名集合)**：
 *   · **表集合** = `FROM` / `JOIN` 后的表名（去别名）；
 *   · **源列名** = SELECT 项 `AS` 之前的部分、**去掉表限定符**
 *     （`m.embedding AS vec` ⇒ 源列名 `embedding`）⇒ **改别名不影响判定**；
 *   · **SELECT 列表** = **第一个 `SELECT` 之后、第一个 `FROM` 之前**
 *     ⇒ ⚠️ 不许扫全文 ⇒ 否则 `WHERE m.embedding IS NOT NULL` 这类
 *     「只过滤不取列」的语句会被误判成向量来源。
 *
 * ⚠️ ★ **与 legacy 结论的关系**（口径 §3.1）：
 *   本文件**只管字节侧**；legacy 行读结论在 `bench/lib/harness.ts` 的
 *   `classifyReadKind()` 里（**逐位复现旧行为** ⇒ `docs/baseline/*.json` 的
 *   R6 `candidateReadRows` 不断档）⇒ ⇒ 两边**共用同一次归一化**（口径 §3 的「一个函数、两个结论」）。
 */

/** ★ **字节来源的种类**（口径 §3.2 的「认领来源」列 + §3.2 末条允许的细分类）。 */
export type ByteSourceKind =
  /** **成员**（Q1 `vector_cell_members`）：0 字节进判据，只记行数。 */
  | 'member'
  /** **码**（Q2 `vector_codes`）：768 B/行（实测 `byteLength`）⇒ 进 `bytesRead`。 */
  | 'code'
  /** **窄读**（Q3 `memories` 的 3 列 gate）：**0 字节**（无 `embedding`）。 */
  | 'narrow'
  /** **逐条精确分**（`scoreOf` 的 `get()`）：3,072 B/行 ⇒ 进 `bytesRead`。 */
  | 'exactEmbedding'
  /** **整行 survivors**（Q4 / Q5 / `bucketCandidate` JOIN）：3,072 B/行 ⇒ 进 `bytesRead`。 */
  | 'survivorRow';

/** ★ **SELECT 列表的一项**（解析结果）。 */
export interface SelectItem {
  /** 归一化后的表达式原文（**小写**）。 */
  readonly expression: string;
  /** **源列名**（`AS` 之前的部分去掉表限定符；不是列时就是表达式本身）。 */
  readonly sourceColumn: string;
}

/** ★ **形状键**（两个集合；**有序无关** ⇒ 比较前一律排序）。 */
export interface ShapeKey {
  /** `FROM` / `JOIN` 后的表名集合（排序后）。 */
  readonly tables: readonly string[];
  /** SELECT 段的源列名集合（排序后）。 */
  readonly columns: readonly string[];
}

/**
 * ★ **一个登记形状**（形状登记表的条目）。
 *
 * ⚠️ **为什么载荷来源与行数来源要分开**（`payloadSource` vs `sources`）：
 *   `bucketCandidate`（JOIN 形状）**同时**认领「向量」与「成员」两个来源 ⇒ 若载荷字节
 *   按 `sources` 逐个累加 ⇒ **同一份字节会被记两遍** ⇒ `bytesRead` 虚高一倍
 *   ⇒ ⇒ 载荷字节**只记在 `payloadSource` 这一个来源上**。
 */
export interface ShapeEntry {
  /** 形状 id（`Q1` / `Q2` / `Q3` / `Q4` / `Q5` / `scoreOf` / `bucketCandidate`）。 */
  readonly id: string;
  /** 表名集合（排序后）。 */
  readonly tables: readonly string[];
  /** 源列名集合（排序后）。 */
  readonly columns: readonly string[];
  /** **认领的来源**（行数认领；一个形状可认领多个 ⇒ 行数按来源分别记）。 */
  readonly sources: readonly ByteSourceKind[];
  /** **载荷字节记在哪个来源上**（`null` ⇒ 该形状不贡献向量载荷字节）。 */
  readonly payloadSource: ByteSourceKind | null;
  /** **载荷列**（进 `bytesRead`；口径 §1.3 裁决 A：只计向量载荷）。 */
  readonly payloadColumns: readonly string[];
  /** **非向量字节列**（进 `contentBytes`；**不在** `bytesRead` 里）。 */
  readonly contentColumns: readonly string[];
  /**
   * ★ **`.get()` 调用次数记在哪个来源上**（**剪枝率分子** ⇒ 口径 §1.7）。
   *
   * ⚠️ **只有 `scoreOf` 有** ⇒ 因为 `exactReads` 只在 `pruneTopK()` 里对 `scoreOf` 计数
   *   （`src/vector/prune.ts:289-290`）⇒ ⇒ 「数 `get()` 调用次数」才与它**定义性相等**。
   */
  readonly callSource: ByteSourceKind | null;
}

/** ★ **一行的字节模型**（`bytesOfRow()` 的产物）。 */
export interface RowBytes {
  /** 载荷字节（进 `bytesRead`）。 */
  readonly payloadBytes: number;
  /** 非向量字节（进 `contentBytes`）。 */
  readonly contentBytes: number;
  /** 这一行**物化出了 `embedding`** 吗（`false` ⇒ 不计入 `embeddingRowsRead`）。 */
  readonly hasEmbedding: boolean;
  /** 这一行的**码长 ≠ 期望值**吗（**坏码行 = 白读** ⇒ 断言 1a 的前提）。 */
  readonly badCode: boolean;
}

/**
 * ★ **形状登记表**（口径 §3.2 的表 · 7 个形状）。
 *
 * ⚠️ ★ **维护纪律**（口径 §13 第 6 条）：
 *   **新增一条生产 SQL（改了 SELECT 列表）⇒ 必须同批登记** ⇒ 否则它会落进
 *   `unclassified` ⇒ **判红**（这是**期望行为**，不是误报）。
 *
 * ⚠️ **为什么读路径与写路径的 `scoreOf` 只登记一条**：
 *   两条 SQL 的文本**完全相同**（`src/vector/ivf.ts:1244` 与
 *   `src/store/dedupCandidates.ts:310` 都是 `SELECT embedding FROM memories
 *   WHERE id = ? AND deleted = 0 AND embedding IS NOT NULL`）⇒ **形状键相同**
 *   ⇒ ⇒ 一个登记条目覆盖两个调用点（**表里是 7 个形状 / 8 个 SQL 站点**）。
 */
export const REGISTERED_SHAPES: readonly ShapeEntry[] = [
  {
    id: 'Q1',
    tables: ['vector_cell_members'],
    columns: ['fine_id', 'memory_id'],
    sources: ['member'],
    payloadSource: null,
    payloadColumns: [],
    contentColumns: [],
    callSource: null,
  },
  {
    id: 'Q2',
    tables: ['vector_codes'],
    columns: ['memory_id', 'code', 'scale', 'eps'],
    sources: ['code'],
    payloadSource: 'code',
    payloadColumns: ['code'],
    contentColumns: [],
    callSource: null,
  },
  {
    id: 'Q3',
    tables: ['memories'],
    columns: ['id', 'last_access', 'pin_factor'],
    sources: ['narrow'],
    payloadSource: null,
    payloadColumns: [],
    contentColumns: [],
    callSource: null,
  },
  {
    id: 'Q4',
    tables: ['memories'],
    columns: [
      'id',
      'content',
      'content_tokens',
      'stability',
      'last_access',
      'access_count',
      'difficulty',
      'embedding',
    ],
    sources: ['survivorRow'],
    payloadSource: 'survivorRow',
    payloadColumns: ['embedding'],
    contentColumns: ['content', 'content_tokens'],
    callSource: null,
  },
  {
    id: 'Q5',
    tables: ['memories'],
    columns: ['id', 'embedding', 'last_access', 'pin_factor'],
    sources: ['survivorRow'],
    payloadSource: 'survivorRow',
    payloadColumns: ['embedding'],
    contentColumns: [],
    callSource: null,
  },
  {
    id: 'scoreOf',
    tables: ['memories'],
    columns: ['embedding'],
    sources: ['exactEmbedding'],
    payloadSource: 'exactEmbedding',
    payloadColumns: ['embedding'],
    contentColumns: [],
    callSource: 'exactEmbedding',
  },
  {
    // ⚠️ ★★ **形状 id = `bucketCandidate`**（口径 §3.2 形状表 · 裁决 4 订正版）。
    //   ⚠️ **定性（照口径原文）**：**仅 `prune = false` 对照分支（A1 / A7）使用
    //   ⇒ 两段式写路径不发 ⇒ 不在 bench 采样窗口内** ⇒ 登记它是为了**防御**
    //   （将来若对照分支被打开，形状仍能认领「向量来源 + 成员来源」⇒ 不会静默漏检）。
    id: 'bucketCandidate',
    tables: ['vector_cell_members', 'memories'],
    columns: [
      'id',
      'content',
      'content_tokens',
      'stability',
      'last_access',
      'access_count',
      'difficulty',
      'embedding',
    ],
    sources: ['member', 'survivorRow'],
    payloadSource: 'survivorRow',
    payloadColumns: ['embedding'],
    contentColumns: ['content', 'content_tokens'],
    callSource: null,
  },
];

/** ★ **登记表索引**（形状键 ⇒ 形状条目；查表 O(1)）。 */
const SHAPE_INDEX: ReadonlyMap<string, ShapeEntry> = new Map(
  REGISTERED_SHAPES.map((shape) => [shapeKeyOfLists(shape.tables, shape.columns), shape]),
);

/**
 * ★ **归一化**（口径 §3.3 第 1 条 · 一次，两边共用）。
 *
 * ⚠️ **三步，顺序不许变**：
 *   ① **折叠所有空白串为单空格**（生产的 Q4 / `bucketCandidate` SQL **跨多行** ⇒ 不折叠就匹配不上）；
 *   ② `trim`；
 *   ③ **把 `IN (?, ?, ...)` 折叠成 `IN (...)`**（占位符个数随桶数变 ⇒ 不折叠则形状键不稳定）。
 *
 * ⚠️ **关键字小写**（表名 / 列名在 SQLite 里大小写不敏感 ⇒ 全小写安全）。
 *   ⚠️ **字符串字面量的内容不得被改写** —— 形状键**只用于比表名与列名**，
 *   且本仓库的生产 SQL **一律用参数占位符**（`?` / `@name`）⇒ 没有字面量风险。
 *
 * @param sql SQL 文本
 * @returns 归一化后的 SQL
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'in (...)')
    .toLowerCase();
}

/**
 * ★ **聚合判定**（口径 §10.2：「聚合判定必须第一个判」）。
 *
 * ⚠️ ★ **为什么必须最先**：`countUncodedCandidates()` 的 SQL 内部嵌了
 *   `NOT EXISTS (SELECT 1 FROM vector_codes vc …)` ⇒ 若不先判聚合，
 *   它会被 `vector_codes` 那条规则抢走 ⇒ **一条诊断查询被记成「读了码行」**。
 *
 * ⚠️ **聚合查询命中零来源，但【不计入 `unclassified`】**（与 legacy 侧对称）：
 *   聚合读的是索引、**不物化行** ⇒ 不进字节账、不进行数账、也不算「口径不完整」。
 *
 * @param sql SQL 文本
 * @returns 是聚合查询吗
 */
export function isAggregateSql(sql: string): boolean {
  return /\b(?:count|sum|avg|total)\s*\(/i.test(sql);
}

/**
 * ★ **取表名集合**（`FROM` / `JOIN` 后的表；去别名、去重）。
 *
 * ⚠️ **子查询**：`FROM (` 不会匹配（正则要求表名首字符是字母或下划线）
 *   ⇒ 子查询内部的 `FROM` 会**各自**匹配到自己的表 ⇒ 对 `NOT EXISTS (…)` 这类
 *   嵌在聚合里的子查询无影响（**聚合先判掉了**）。
 *
 * @param sql SQL 文本
 * @returns 表名集合（**按出现顺序**；调用方需要集合语义时自行排序）
 */
export function parseTables(sql: string): string[] {
  const normalized = normalizeSql(sql);
  const tables: string[] = [];
  const pattern = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g;
  let match = pattern.exec(normalized);
  while (match !== null) {
    const name = match[1] as string;
    if (!tables.includes(name)) {
      tables.push(name);
    }
    match = pattern.exec(normalized);
  }
  return tables;
}

/**
 * ★ **取 SELECT 列表**（**只取第一个 `SELECT` 之后、第一个 `FROM` 之前**）。
 *
 * ⚠️ ★ **为什么不许扫全文**（口径 §3.2 的第三条）：
 *   `WHERE m.embedding IS NOT NULL` 里的 `embedding` **不是 SELECT 项**
 *   ⇒ 扫全文 ⇒ 窄读（Q3）会被误判成向量来源 ⇒ **字节账当场虚高**。
 *
 * ⚠️ **按顶层逗号切分**（括号深度 0）：`bm25(mem_fts)` 这种**函数调用里带逗号**
 *   的表达式不会被切坏。
 *
 * @param sql SQL 文本
 * @returns SELECT 项（解析不出 ⇒ 空数组 ⇒ 调用方判「不可解析」）
 */
export function parseSelectList(sql: string): SelectItem[] {
  const normalized = normalizeSql(sql);
  const selectIndex = normalized.indexOf('select ');
  if (selectIndex < 0) {
    return [];
  }
  const fromIndex = normalized.indexOf(' from ', selectIndex + 'select '.length);
  const listText =
    fromIndex < 0
      ? normalized.slice(selectIndex + 'select '.length)
      : normalized.slice(selectIndex + 'select '.length, fromIndex);
  return splitTopLevel(listText).map((expression) => ({
    expression,
    sourceColumn: sourceColumnOf(expression),
  }));
}

/**
 * ★ **算一行的字节**（口径 §1.3 裁决 A · §2 断言 1 / 1a）。
 *
 * ⚠️ **只算 BLOB 的 `.byteLength`**（O(1)）⇒ ⇒ **当场累加标量 ⇒ O(1) 内存**
 *   （口径 §3.3 第 3 条：**绝不缓存行数组** ⇒ 500 轮 ≈ 4.6 GB ⇒ OOM）。
 *
 * ⚠️ **非向量字节列走 UTF-8 实测**（`Buffer.byteLength(v, 'utf8')`）
 *   ⇒ **不用「声明长度」**（口径 §1.3 末条：id 格式一改声明长度就错）。
 *
 * @param row 物化出来的一行
 * @param shape 该行所属的形状
 * @param expectedCodeBytes 期望的码长（768 = 768 个 int8）
 * @returns 这一行的字节模型
 */
export function bytesOfRow(row: unknown, shape: ShapeEntry, expectedCodeBytes: number): RowBytes {
  const record = (row ?? {}) as Record<string, unknown>;
  let payloadBytes = 0;
  let contentBytes = 0;
  let hasEmbedding = false;
  let badCode = false;
  for (const column of shape.payloadColumns) {
    const value = record[column];
    if (column === 'embedding') {
      if (value !== null && value !== undefined) {
        hasEmbedding = true;
        payloadBytes += blobByteLength(value);
      }
      continue;
    }
    if (column === 'code') {
      const length = blobByteLength(value);
      if (value !== null && value !== undefined && length !== expectedCodeBytes) {
        // ⚠️ **坏码行 = 白读**（进了结果集 ⇒ 字节已搬 ⇒ 但 `readCodes()` fail-open 丢弃它）
        //   ⇒ ⇒ 计数并报「前提违例」（口径 §2 断言 1a / §6 修正 7）。
        badCode = true;
      }
      payloadBytes += length;
      continue;
    }
    payloadBytes += blobByteLength(value);
  }
  for (const column of shape.contentColumns) {
    contentBytes += blobByteLength(record[column]);
  }
  return { payloadBytes, contentBytes, hasEmbedding, badCode };
}

/**
 * ★ **算一个形状键**（表集合 + 源列名集合 ⇒ 字符串键）。
 *
 * @param sql SQL 文本
 * @returns 形状键（**解析不出 ⇒ `null`** ⇒ 调用方判「命中零来源」）
 */
export function shapeKeyOf(sql: string): ShapeKey | null {
  const tables = parseTables(sql);
  if (tables.length === 0) {
    return null;
  }
  const items = parseSelectList(sql);
  if (items.length === 0) {
    return null;
  }
  return {
    tables: [...tables].sort(),
    columns: [...new Set(items.map((item) => item.sourceColumn))].sort(),
  };
}

/**
 * ★ **认领一个形状**（形状登记表查表）。
 *
 * @param sql SQL 文本
 * @returns 登记形状（**未登记 ⇒ `null`** ⇒ ⇒ 命中零来源 ⇒ `unclassified`）
 */
export function resolveShape(sql: string): ShapeEntry | null {
  const key = shapeKeyOf(sql);
  if (key === null) {
    return null;
  }
  return SHAPE_INDEX.get(shapeKeyOfLists(key.tables, key.columns)) ?? null;
}

/**
 * ★ **SQL 指纹**（`unclassifiedSqlKinds` 的元素）。
 *
 * ⚠️ **为什么用归一化后的文本**：同一个「形状」的不同写法（缩进不同、占位符个数不同）
 *   必须落进**同一个**指纹 ⇒ 否则「未登记语句」的清单会被噪声淹没。
 *   ⚠️ **截断到 120 字符**：够认人，又不至于把整条 SQL 塞进落盘 JSON。
 *
 * @param sql SQL 文本
 * @returns 指纹
 */
export function sqlFingerprint(sql: string): string {
  const normalized = normalizeSql(sql);
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

/**
 * ★ **形状键 → 字符串键**（表集合与列集合都排序 ⇒ **顺序无关** ⇒ 改 SELECT 顺序不改变形状）。
 *
 * @param tables 表名集合
 * @param columns 源列名集合
 * @returns 字符串键
 */
function shapeKeyOfLists(tables: readonly string[], columns: readonly string[]): string {
  return `${[...tables].sort().join(',')}||${[...columns].sort().join(',')}`;
}

/**
 * ★ **按顶层逗号切分**（括号深度 0）。
 *
 * @param text 文本
 * @returns 切分结果（去掉空白项）
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    }
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * ★ **取源列名**（`AS` 之前的部分、去掉表限定符）。
 *
 * ⚠️ **改别名不影响判定**（口径 §3.2：「源列名 = SELECT 项 `AS` 之前的部分、
 *   去掉表限定符」）⇒ ⇒ `m.embedding AS vec` 的源列名是 `embedding`。
 *
 * @param expression SELECT 项
 * @returns 源列名（小写）
 */
function sourceColumnOf(expression: string): string {
  const lower = expression.toLowerCase();
  const asIndex = lower.indexOf(' as ');
  const head = asIndex < 0 ? expression : expression.slice(0, asIndex);
  const trimmed = head.trim();
  const dotIndex = trimmed.lastIndexOf('.');
  const bare = dotIndex < 0 ? trimmed : trimmed.slice(dotIndex + 1);
  return bare.toLowerCase();
}

/**
 * ★ **一个值的字节长度**（BLOB 取 `.byteLength`；字符串取 UTF-8 实测；标量取 0）。
 *
 * ⚠️ **标量列（`scale` / `eps` / `last_access` …）= 0 字节**：
 *   它们不是向量载荷（口径 §1.3 裁决 A：正文与标量都不进 `bytesRead`）。
 *
 * @param value 值
 * @returns 字节长度
 */
function blobByteLength(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }
  if (value instanceof Uint8Array) {
    // ⚠️ `Buffer` 是 `Uint8Array` 的子类 ⇒ 这一条同时覆盖 BLOB。
    return value.byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  return 0;
}
