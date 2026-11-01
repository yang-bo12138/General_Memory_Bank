/**
 * `scripts/audit-tier-qualifiers.mjs` 的**类型声明**（供 TypeScript 侧 import 时使用）。
 *
 * ⚠️ **为什么需要它**：本脚本按主理人指定的形态是 **`.mjs`**（纯 `node` 即可跑，不依赖 `tsx`）
 *   ⇒ ⇒ 而 `tsconfig.json` 的 `include` 里的 `scripts/` **只覆盖 `.ts`**
 *   ⇒ ⇒ **`.mjs` 本身不会被 `tsc --noEmit` 检查** ⇒ ⇒ **若没有这份声明，import 它的一方
 *   （如 `tests/contracts/tier-qualifier-audit.test.ts`）会拿到 `any`** ⇒ ⇒ **类型检查反而在这里断掉**。
 *   ⇒ ⇒ **⇒ 这份 `.d.mts` 把类型补回来** ⇒ ⇒ **⇒ 脚本的「纯 node 可跑」与「有类型」两件事同时成立**。
 *
 * ⚠️ **这份声明是手写的 ⇒ ⇒ 它可能与实现漂移** ⇒ ⇒ **⇒ 所以 `tests/contracts/tier-qualifier-audit.test.ts`
 * 里有「白名单漂移守卫」**（弱词不得进强词表、且那几个弱词必须在弱词表里）
 * ⇒ ⇒ **⇒ 一旦实现与这份声明对不上，那条单测会先红** ⇒ ⇒ **⇒ 声明与实现的漂移会被门禁抓住**。
 */

/** 一处判定（真缺或提示）。 */
export interface AuditFinding {
  /** 文档内行号（1 起）。 */
  readonly line: number;
  /** 类目名（提示项用固定的说明）。 */
  readonly className: string;
  /** 命中的那一行原文（截断后）。 */
  readonly text: string;
}

/** 一次审计的计数（输出里的三个数 + 提示数）。 */
export interface AuditCounts {
  /** 扫了多少处「只属于某一档的数」。 */
  readonly scanned: number;
  /** 判了多少处。 */
  readonly adjudicated: number;
  /** 发现几处真缺。 */
  readonly missing: number;
  /** 几处「档位标得不够近」的提示。 */
  readonly advisories: number;
}

/** 一次审计的完整结果。 */
export interface AuditResult {
  readonly counts: AuditCounts;
  readonly gaps: readonly AuditFinding[];
  readonly advisories: readonly AuditFinding[];
}

/** 「只属于某一档的数」的一个类目。 */
export interface TierSpecificClass {
  /** 人类可读的类目名。 */
  readonly name: string;
  /** 该类量在文档里的写法。 */
  readonly pattern: RegExp;
}

/** 强档位词：明确说明「是哪一档」⇒ 单独出现即可成立。 */
export declare const STRONG_TIER_WORDS: readonly string[];

/** 弱指示词：只说明「是哪一次」或「在比几个档位」⇒ 必须与强词同现才算数。 */
export declare const WEAK_TIER_WORDS: readonly string[];

/** 只属于某一档的数（必须带档位限定）。 */
export declare const TIER_SPECIFIC_CLASSES: readonly TierSpecificClass[];

/** 跨档一致的数（不许被写成「只在这一档成立」）。 */
export declare const CROSS_TIER_PATTERN: RegExp;

/** 判定「这段文本是否给出了档位」。 */
export declare function hasTier(text: string): boolean;

/** 判定「本行是否含出处陈述标志」。 */
export declare function hasProvenance(text: string): boolean;

/** 判定「本行是否是 Markdown 表格的分隔行」。 */
export declare function isTableSeparator(line: string): boolean;

/** 把一行切成片段（按分号 / 句号）。 */
export declare function fragmentsOf(line: string): Array<[number, number]>;

/** 找出某个偏移所在的片段。 */
export declare function fragmentAt(line: string, offset: number): string;

/** 找出该行所在表格的表头行。 */
export declare function tableHeaderOf(lines: readonly string[], index: number): string;

/** 找出该行所属的小节标题。 */
export declare function sectionHeadingOf(lines: readonly string[], index: number): string;

/** 审计一份 Markdown 的档位限定一致性（纯函数）。 */
export declare function auditTierQualifiers(lines: readonly string[]): AuditResult;

/** 把审计结果渲染成报告文本（纯函数）。 */
export declare function renderAudit(target: string, result: AuditResult): string;
