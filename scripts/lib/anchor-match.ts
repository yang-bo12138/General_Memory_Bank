/**
 * 锚定检查的**关键词 / 路径标签**口径 —— 供 `scripts/check-anchor.ts` 用（P2-T04）。
 *
 * ⚠️ **关键词从设计稿的锚定表里解析**（而不是另写一份）：
 *   §14.3.1 末那张表**就是**「规则 → 动作关键词 → 管辖路径」的**唯一权威**
 *   ⇒ 另写一份关键词 = 第二份定义（C36：同一件事不得有两套词）
 *   ⇒ 两份一漂移，闸门就在校验一个**不存在的**规则。
 *
 * ⚠️ **匹配口径（两种关键词，两种规则）**：
 *   · **ASCII 标识符**（`mode` / `absent` / `assignBucket` / `'reinforce'` …）
 *     ⇒ **词边界**匹配 ⇒ `mode` **不会**命中 `model`（否则闸门误报成常态）。
 *   · **中文短语**（`吻合率` / `不建共激活边` / `只漏不错` …）
 *     ⇒ **去标点后子串**匹配 ⇒ 设计稿正文写「只漏、不错」（带顿号），
 *       锚定表写「只漏不错」（不带）⇒ 不去标点就**恒不命中** ⇒ 闸门变成摆设。
 */

/** 锚定表里「动作关键词」与「管辖路径」两列的分隔符。 */
const CELL_SEPARATOR = '/';

/**
 * 规范化一个**路径标签**（§14.3.1 锚定表第三列的每一项）。
 *
 * ⚠️ **去掉末尾的括号补充**：设计稿写的是
 *   「§4.9.1 步骤 4（**四条 embedding 赋值路径一条都不能漏**）」
 *   ⇒ 标签本体是「§4.9.1 步骤 4」⇒ 括号里是**给人看的说明**，不是路径的一部分。
 * ⚠️ **去掉 markdown 标记**（`**` 与反引号）⇒ 只比内容，不比排版。
 */
export function normalizeAnchorLabel(cell: string): string {
  return cell
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/（[^）]*）\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析锚定表的「动作关键词」列 ⇒ 关键词列表。
 *
 * @param cell 该列的原文（形如 `` `vector_cell_members` / `assignBucket` ``）
 * @returns 关键词列表（去空、去重、保持原顺序）
 */
export function parseAnchorKeywords(cell: string): string[] {
  const keywords: string[] = [];
  for (const raw of cell.split(CELL_SEPARATOR)) {
    const keyword = raw.replace(/`/g, '').trim();
    if (keyword === '' || keywords.includes(keyword)) {
      continue;
    }
    keywords.push(keyword);
  }
  return keywords;
}

/**
 * 解析锚定表的「管辖路径」列 ⇒ 路径标签列表。
 *
 * @param cell 该列的原文
 * @returns 路径标签列表（已规范化、去空）
 */
export function parseAnchorPathLabels(cell: string): string[] {
  const labels: string[] = [];
  for (const raw of cell.split(CELL_SEPARATOR)) {
    const label = normalizeAnchorLabel(raw);
    if (label === '' || labels.includes(label)) {
      continue;
    }
    labels.push(label);
  }
  return labels;
}

/** ASCII 词字符（用于词边界判定）。 */
const ASCII_WORD = /[A-Za-z0-9_]/;

/** 判定一个关键词是不是「ASCII 标识符」形态。 */
function isAsciiKeyword(keyword: string): boolean {
  return /^[A-Za-z0-9_'".\-]+$/.test(keyword);
}

/**
 * 去标点（中文短语匹配用）。
 *
 * ⚠️ **两侧同时去** ⇒ 标点的差异不参与匹配 ⇒ 「只漏、不错」≡「只漏不错」。
 */
function stripPunctuation(text: string): string {
  return text.replace(
    /[\s、。，．；：！？（）「」『』《》〈〉【】…—～·,.;:!?"()[\]{}<>|`~@#$%^&*+=_\-/\\]/g,
    '',
  );
}

/**
 * 判断一段文本里**有没有**某个动作关键词。
 *
 * @param haystack 被查的文本
 * @param keyword 关键词
 * @returns 有则 `true`
 */
export function containsAnchorKeyword(haystack: string, keyword: string): boolean {
  if (keyword === '') {
    return false;
  }
  if (isAsciiKeyword(keyword)) {
    // ⚠️ **词边界**：`mode` 不该命中 `model`。
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`,
    );
    return pattern.test(haystack);
  }
  // ⚠️ **中文短语 ⇒ 去标点后子串匹配**。
  const needle = stripPunctuation(keyword);
  return needle !== '' && stripPunctuation(haystack).includes(needle);
}

/** 导出 `ASCII_WORD` 的判定能力（供单测直接验证词边界口径）。 */
export function isAsciiWordChar(char: string): boolean {
  return ASCII_WORD.test(char);
}
