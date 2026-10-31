/**
 * 中文 Bigram 分词与 FTS5 查询构造 —— DESIGN-v2.md §10.2，对应 DEVELOPMENT-PLAN.md **P1-T03**。
 *
 * ★ 本文件是**纯函数模块**：不碰数据库、不读时钟、不写任何状态。
 *   ⇒ 写入路径（§4.9 步骤 3a 的去重查询串）与召回路径（§4.6 步骤 2a 的文本路）
 *     共用同一套切分与转义，避免「同一段文本在两条路径上的可检索性不一致」。
 *
 * ⚠️ **四个纯函数各司其职，混用会静默出错**：
 * · `toHalfWidth` —— 全角 → 半角。**必须在分词前做**（理由见下）。
 * · `normalize`   —— 归一化，**只用于算 `content_hash`**；落库的 `content` 一律保留原文。
 * · `tokenize`    —— 切成 bigram / 整词，**空格分隔**（落进 `memories.content_tokens`）。
 * · `escapeFts5` / `escapeLike` —— 查询串转义（**包裹**与**转义**是两件事）。
 *
 * ⚠️ **为什么必须在分词前做全角转半角**（§10.2 原文）：
 *   正则 `[\u4e00-\u9fa5]+|[a-zA-Z0-9_]+` 的两个分支**都不匹配全角字母数字**
 *   ⇒ 不转换就等于**静默丢弃**：`tokenize("ＡＢＣ")` 返回空串，
 *     而 `normalize` 又把它的 hash 算得与 `"abc"` 相同
 *   ⇒ 一条 `write("ＡＢＣ")` 的记忆既**搜不到**，又会在后续 `write("abc")` 时被判为完全重复，
 *     把所有等价写法都吸收进这条检索不到的记忆里。**不报错、不告警。**
 *
 * ⚠️ **§4.9 步骤 3a 的去重查询串不得复用 `buildMatchQuery`**（§10.2 原文）：
 *   `buildMatchQuery` 内部**会再 tokenize 一次**
 *   ⇒ 把已切好的 bigram 串传进去 = **二次分词**：
 *     对 2 字 token 恰好幂等、对其它长度会切出意外 token ⇒ 去重条件变成不可预测的东西。
 *   ⇒ 正确写法（**自己 tokenize、自己取前 3 个、自己 AND 连接**）：
 *     `tokenize(新文本).split(' ').filter(Boolean).slice(0, 3).map(escapeFts5).join(' AND ')`。
 *   ⇒ 本文件里**刻意不提供**「已切好的 token 串 → 查询串」的入口：提供它就是在给二次分词开门。
 *
 * ⚠️ **`content_tokens` 与 `content` 不是逐字符对应的关系**（§3 的 `content_tokens` 列注释）：
 *   `content_tokens` 是**半角化 + 小写后**的切分结果，而 `content` 是原文（可能含全角与大写）。
 *   ⇒ 拿 `content` 去比对 `content_tokens` 一定对不上，这不是数据坏了。
 */

/** §10.2：单个查询最多取前 N 个 token（SQLite 变量与查询表达式上限防护）。 */
export const MAX_MATCH_TOKENS = 30;

/** §10.2 的汉字区间（U+4E00–U+9FA5）。 */
const CJK_PATTERN = /[\u4e00-\u9fa5]/;

/**
 * §10.2 的切分正则：**中文串** 或 **拉丁字母 / 数字 / 下划线串**。
 *
 * ⚠️ **必须先 `toHalfWidth` 再匹配它**（理由见文件头），
 *   且**必须保留大写**（`[a-zA-Z0-9_]`）——小写统一放到后面做。
 */
const TOKEN_PATTERN = /[\u4e00-\u9fa5]+|[a-zA-Z0-9_]+/g;

/**
 * 全角 ASCII 区间转半角（U+FF01–U+FF5E → U+0021–U+007E），并把全角空格 U+3000 转普通空格。
 *
 * ⚠️ **必须在分词前做**：正则 `[\u4e00-\u9fa5]+|[a-zA-Z0-9_]+` 两个分支都不匹配全角字母数字，
 *   不转换就等于**静默丢弃**——`tokenize("ＡＢＣ")` 返回空串，而 `normalize` 又把它的 hash
 *   算得与 `"abc"` 相同。于是一条 `write("ＡＢＣ")` 的记忆既**搜不到**，又会在后续
 *   `write("abc")` 时被判为完全重复，把所有等价写法都吸收进这条检索不到的记忆里。
 *   **不报错、不告警。**
 *
 * @param text 原始文本
 * @returns 半角化后的文本（中文原样保留）
 */
export function toHalfWidth(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 归一化：去首尾空白 → 全角转半角 → 小写。
 *
 * ⚠️ **只用于计算 `content_hash`**；落库的 `content` 一律保留原文
 *   （`tokenize` 自己会转半角与小写，见上）。
 *   ⇒ 归一化后的两个字符串**必然**是「同一事实」——去重判重因此才成立。
 *
 * ⚠️ 这里的顺序是「先 `toHalfWidth` 再 `trim`」，与 §10.2 正文写的
 *   「去首尾空白 → 全角转半角 → 小写」**等价**：
 *   ECMAScript 的 `trim()` 本身就删 U+3000（它属于 `WhiteSpace`），
 *   所以「先 trim」与「先半角化」对首尾空白的处理结果完全相同。
 *
 * @param text 原始文本
 * @returns 归一化后的文本（用于算 hash）
 */
export function normalize(text: string): string {
  return toHalfWidth(text).trim().toLowerCase();
}

/**
 * 中文 2 字滑窗，英文数字保留整词，全角转半角，大写转小写。
 *
 * ⚠️ **顺序不可换**（§10.2 的常见坑）：
 *   ① 先 `toHalfWidth` —— 否则全角字母数字被**静默丢弃**；
 *   ② 再按正则切分（正则里保留 `A-Z`）—— 小写统一在**最后**做，
 *      提前小写会改变 `[a-zA-Z0-9_]+` 这条分支的语义。
 *
 * ⚠️ **单个汉字**（长度 1 的中文段）**原样保留**：
 *   它构不成 bigram，但丢掉它会让「搜一个字」彻底无候选（§10.3 的已知限制）。
 *
 * @param text 原始文本
 * @returns 空格分隔的 token 串（落进 `memories.content_tokens`）
 */
export function tokenize(text: string): string {
  const parts = toHalfWidth(text).match(TOKEN_PATTERN) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    if (CJK_PATTERN.test(part.charAt(0))) {
      if (part.length === 1) {
        out.push(part);
        continue;
      }
      // 中文 2 字滑窗：长度 n 的汉字段 ⇒ n - 1 个 bigram（相邻两个 token 重叠 1 个字）
      for (let index = 0; index < part.length - 1; index += 1) {
        out.push(part.slice(index, index + 2));
      }
      continue;
    }
    out.push(part.toLowerCase());
  }
  return out.join(' ');
}

/**
 * 转义 FTS5 特殊保留字符，避免语法解析错误与崩溃。
 *
 * ⚠️ **「包裹 + 转义」是两件事，只做一件都不行**：
 *   · 只转义不包裹 ⇒ FTS5 把 token 当作**多个词**（`猫 狗` 变成隐式 AND，而不是短语）；
 *   · 只包裹不转义 ⇒ token 里的 `"` 会**提前闭合**字符串，余下内容被当成 FTS5 语法。
 *
 * @param token 单个 token
 * @returns 可直接交给 `MATCH` 的字符串（形如 `"猫粮"`）
 */
export function escapeFts5(token: string): string {
  // 替换内部双引号，整体包裹双引号
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * 转义 LIKE 通配符，防 SQL 通配逃逸。
 *
 * ⚠️ 调用方必须配 `ESCAPE '\'`（§4.6 步骤 2a 的 LIKE 兜底路就是这么写的）：
 *   没有 `ESCAPE` 子句时，`\` 只是普通字符，转义**不生效** ⇒ `'50\%'` 会被当成字面量匹配。
 *
 * @param str 待转义的字符串
 * @returns 转义后的字符串（`%` / `_` / `\` 三个字符被加反斜杠）
 */
export function escapeLike(str: string): string {
  return str.replace(/([%_\\])/g, '\\$1');
}

/** `buildMatchQuery` 的结果。 */
export interface MatchQuery {
  /**
   * FTS5 的 `MATCH` 表达式（`null` = 不走 FTS 路）。
   *
   * ⚠️ **两个都为 `null` 时文本路整体不执行**（§4.6 步骤 2a）：
   *   判定顺序固定为 `matchSql` 非空 → 走 FTS；否则 `fallbackLike` 非空 → 走 LIKE；
   *   否则文本路候选 = `[]`。
   */
  matchSql: string | null;
  /** LIKE 兜底的**已转义**片段（`null` = 不走 LIKE 路）。 */
  fallbackLike: string | null;
}

/**
 * 智能查询串构造：兼顾短语精确度与长文本召回率（§10.2）。
 *
 * ★ **三个分支的判定顺序不可换**：
 *   ① `tokens.length === 0` ⇒ 双 `null`（文本路整体不执行）；
 *   ② 单 token 且长度为 1 ⇒ 单个**汉字**走 LIKE 兜底、单个**拉丁字母/数字**走双 `null`；
 *   ③ `tokens.length ≤ 3` ⇒ `AND` 精确收敛；`> 3` ⇒ `OR` 宽松召回（由 BM25 排位）。
 *
 * ⚠️ **分支 ② 必须在分支 ③ 之前**：单字汉字若落到 ③，会被当成一个 FTS 短语条件
 *   ⇒ 召回质量比 LIKE 兜底更差（且中文单字在 FTS 里根本没有独立的 token）。
 *
 * ⚠️ **分支 ② 的两个子分支也不可换**：
 *   单个拉丁字母/数字走 LIKE 会**扫全表且区分度为零**（`LIKE '%a%'` 命中一切含 a 的正文）
 *   ⇒ 返回空候选、交给调用方补全关键词，比返回几万条噪声更有用。
 *
 * ⚠️ **单 token 时 `matchSql` 里不会出现 `AND` 字面量**（这是 `Array.join` 的**语义**，
 *   不是个人偏好）：分支 ③ 的实现是 `safeTokens.map(escapeFts5).join(' AND ')`
 *   ⇒ 数组**只有 1 个元素**时 `join` 直接返回那一个元素、**不插分隔符**
 *   ⇒ `buildMatchQuery("猫粮")`（`tokenize("猫粮")` 只有 1 个 bigram）
 *     实测 `matchSql === '"猫粮"'`、**条件个数 == 1**。
 *   ⇒ 因此断言要按「**走哪支 + 条件个数**」写，**不要**按「字符串里有没有 `AND` 字面量」写
 *     （后者在 token 数为 1 时恒假 ⇒ 是一条恒不成立的假断言）。
 *   权威：DESIGN-v2.md §10.2（`safeTokens.map(escapeFts5).join(' AND ')`，≤3 走 AND、>3 走 OR），
 *   口径与 `docs/design/DEVELOPMENT-PLAN.md` P1-T03 的验收标准（「走哪支 + 条件个数」）一致。
 *
 * ⚠️ **本函数内部会 tokenize 一次** ⇒ **不得**把「已切好的 token 串」喂进来
 *   （二次分词；详见文件头的说明）。
 *
 * @param q 用户的原始查询文本
 * @returns `{ matchSql, fallbackLike }`
 */
export function buildMatchQuery(q: string): MatchQuery {
  const tokens = tokenize(q).split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return { matchSql: null, fallbackLike: null };
  }

  // ── 分支 ②：单 token 且长度为 1 ──
  if (tokens.length === 1 && tokens[0]?.length === 1) {
    const ch = tokens[0] ?? '';
    // ②a. 单个汉字：无法构成 bigram，只能走 LIKE 兜底（转义通配符）
    if (CJK_PATTERN.test(ch)) {
      return { matchSql: null, fallbackLike: escapeLike(ch) };
    }
    // ②b. 单个拉丁字母/数字：LIKE '%a%' 会扫全表且几乎命中一切，
    //     而区分度为零（单个字母不表达任何意图）。直接返回空候选，
    //     交给调用方补全关键词——这比返回几万条噪声更有用。
    return { matchSql: null, fallbackLike: null };
  }

  // 截断过长 tokens 数量（SQLite 变量与查询表达式上限防护，最大取前 30 个）
  const safeTokens = tokens.slice(0, MAX_MATCH_TOKENS);

  // ── 分支 ③a：短词查询（≤ 3 个 bigram）⇒ AND 精确收敛 ──
  if (safeTokens.length <= 3) {
    return {
      matchSql: safeTokens.map(escapeFts5).join(' AND '),
      fallbackLike: null,
    };
  }

  // ── 分支 ③b：长句上下文（> 3 个 bigram）⇒ OR 宽松召回，由 BM25 计算相关度排位 ──
  return {
    matchSql: safeTokens.map(escapeFts5).join(' OR '),
    fallbackLike: null,
  };
}
