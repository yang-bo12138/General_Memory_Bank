/**
 * §5 分类声明 与 §8.1 参数计数 的**性质型**断言 —— 补 `scripts/check-params.ts` 的覆盖面缺口。
 *
 * ⚠️ **本脚本必须与「勘误回写」同批落地**（依据：docs/design/DESIGN-v2-errata.md 勘误 ② 与 ③）。
 *   在回写落地**之前**，它**必然报红**：
 *   · §8.1 现在写「**53** 项参数」（应是 60）；
 *   · §5 末尾的分类声明相加 **61**（`VECTOR_ROUTER` 被两个轴各数一次）。
 *   ⇒ 先落断言 ⇒ CI 立刻红 ⇒ 极易被误读成「回写做坏了」⇒ 回写被叫停。
 *
 * ## 为什么这些断言值得存在（实测缺口）
 *
 * `scripts/check-params.ts` 只比对「§5 **表格体** ↔ `DEFAULT_PARAMS`」。
 * 实测：把 §8.1 的「53 项」改成「45 项」、把 §5 分类声明的「共激活 10 项」改成「9 项」，
 * **门禁报出 0 处差异** ⇒ 静默通过。
 * （§5 表格体本身没坏 ⇒ 比对逻辑有效，缺的只是**覆盖面**。）
 *
 * ## 三条设计纪律（都来自真实踩过的坑）
 *
 * ① **不锚具体措辞**：勘误 ② 把「向量路**开关** 2 项」改成「向量路**阈值** 1 项 = `ROUTER_MIN_TRAINING` = **9**」
 *    ⇒ 任何锚在「向量路开关」上的正则都会**失配** ⇒ 解析器抛错 ⇒ 断言在**改好之后**反而失败。
 *    ⇒ 本实现只取该 bullet 括号段里的**全部** `N 项`，与措辞无关。
 * ② **不锚粗体标记**：现行的「机制开关」那一行的 `**` **没有闭合**
 *    （只有一个 `**`，且「选择器」后有**三个**右括号）⇒ 锚在 `**…**` 上的提取会**静默漏掉这一组**
 *    ⇒ 那正是「解析器漏读伪装成一致」这一类假绿。
 *    ⇒ 本实现按**结构**取组名（去掉 bullet 前缀 ⇒ 切到第一个括号/冒号前 ⇒ 去掉星号）。
 * ③ **找不到 ⇒ 抛错，不静默跳过**：「跳过」就是「解析器漏读伪装成一致」这一类假绿。
 *
 * ## 断言的是**性质**，不是「当次的数字」
 *
 * 只断言三条性质（**不**硬编码逐组小计 ⇒ 对勘误选哪种合法拆法不敏感）：
 * ① 四组之和 + v1.0 继承 == 代码里的参数键数；
 * ② 每组**自己声明的组总数**（若写了）== 它的子项数之和；
 * ③ §8.1 自称的参数项数 == 代码里的参数键数。
 *
 * ⚠️ 「只比总和够不够？」**回写之后够**：回写把「性能」改成 9 之后，
 *   「共激活 10→9」这个负控会让总和变成 **59 ≠ 60** ⇒ 被①抓住。
 *   （在**回写前**抓不住，因为那时性能是 10 ⇒ 总和恰好仍是 60 —— 这也正是必须同批落地的另一个理由。）
 *
 * ## 第四条断言（F-01 残余②）：**计划稿里的那份副本也要守**
 *
 * 实测缺口：§5 的分类声明在 `docs/design/DEVELOPMENT-PLAN.md` 里**还有一份副本**
 *   （「项的构成」那一段）。把那份副本改回旧口径（照抄相加得 61）⇒
 *   **6 条门禁全部 exit 0** ⇒ **假绿**——
 *   因为**所有门禁只读 DESIGN-v2.md 一份**，源码与计划稿里的副本**没人守**。
 * ⇒ 本脚本现在**同时**校验计划稿里的那份：
 *   构成之和 == §5 的参数总数、计划稿自称的「合计 N」一致、
 *   与 §5 **逐组**一致、v1.0 继承数一致，
 *   以及另一条轴（按生效阶段拆）的阶段项数之和 == 参数总数。
 * ⇒ 源码里那份副本（`src/core/params.ts` 的注释）已**删除**（复述即漂），
 *   改成「以 §5 为准」的引用 ⇒ 副本从三份降到两份，且两份都被门禁守着。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PARAM_KEYS } from '../src/core/params.js';
import { extractSection, readDesignDoc } from './lib/design-doc.js';

/** §5 的标题行。 */
const SECTION_5_HEADING = '## 5. 参数表（集中配置）';
/** §8.1 的标题行。 */
const SECTION_8_1_HEADING = '### 8.1 文本日志规范';

/** §5 分类声明的四个组（**性质分类**轴，与 §5 表格的「分组」轴不同 —— 见勘误 ② §2.3）。 */
const GROUP_NAMES = ['行为语义参数', '性能参数', '运维参数', '机制开关'] as const;

/**
 * 开发计划稿的路径（相对仓库根）。
 *
 * ⚠️ **为什么要校验它**（F-01 残余②的实测）：
 *   §5 的分类声明在**三处**有副本——设计稿 §5、`docs/design/DEVELOPMENT-PLAN.md`
 *   的「项的构成」那一段、以及（已被删掉的）`src/core/params.ts` 的注释。
 *   实测：把任一副本改回旧口径（照抄相加得 61）⇒ **6 条门禁全部 exit 0** ⇒ 假绿。
 *   ⇒ 现在这一份也纳入门禁：**副本漂移 ⇒ 门禁红**。
 */
const PLAN_DOC_PATH = 'docs/design/DEVELOPMENT-PLAN.md';

/** 计划稿里「§5 末的分类声明」那一段的标记（副本之一）。 */
const PLAN_COMPOSITION_MARKER = '项的构成';

/**
 * 计划稿那份计数声明的**来源标注**（架构师定的措辞，与计划稿里的那句话**逐字一致**）。
 *
 * ⚠️ **为什么门禁也要带这一句**：
 *   「文档里写的」与「门禁报出来的」**必须是同一句话** ⇒ 否则两处各说各话，
 *   看到报红的人不知道**该改哪一处**（计划稿的副本？还是 §5？还是代码？）。
 *   ⇒ 这一句同时回答了「**谁才是唯一副本**」：
 *   **§5 的表格体才是唯一副本**（`check-params.ts` 已守住它 ↔ `DEFAULT_PARAMS`），
 *   计划稿这份是**抄来的计数声明** ⇒ 修的时候改源头，不要只改抄本。
 *
 * ⚠️ **措辞必须与 `docs/design/DEVELOPMENT-PLAN.md`「60 项的构成」那一段的标注一致**
 *   （那一段归主理人）⇒ 两处逐字相同 ⇒ 不会各说各话。
 */
const PLAN_COMPOSITION_SOURCE_NOTE =
  '本段抄自 DESIGN-v2.md §5 末的分类声明；§5 表格体才是唯一副本。';

/** 计划稿里「参数生效阶段的分布统计」那一段的标记（另一条轴的副本）。 */
const PLAN_STAGE_DISTRIBUTION_MARKER = '参数生效阶段的分布统计';

/** 读开发计划稿全文。 */
export function readPlanDoc(path: string = PLAN_DOC_PATH): string {
  return readFileSync(path, 'utf8');
}

/**
 * 取出「标记行 + 其后的**缩进续行**」构成的一段。
 *
 * ⚠️ **按缩进续行取，而不是「取到下一个空行为止」**：
 *   计划稿的段落是「`- ` 开头的 bullet + 两空格缩进的续行」，
 *   而下一个 bullet 也在两空格缩进的续行**之后**（不是空行）⇒ 按空行取会串到别的段。
 *
 * @throws 找不到标记 ⇒ 抛错（**不**当作「一致」）
 */
function extractIndentedBlock(markdown: string, marker: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.includes(marker));
  if (start < 0) {
    throw new Error(`开发计划稿里找不到「${marker}」这一段 ⇒ 解析失败（不能当作「一致」）`);
  }
  const collected: string[] = [lines[start] ?? ''];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^\s+\S/.test(line)) {
      break;
    }
    collected.push(line);
  }
  return collected.join('\n');
}

/** 计划稿里「§5 末的分类声明」那一段的解析结果。 */
export interface ParsedPlanComposition {
  /** 每组的子项数（组名与 §5 一致）。 */
  groups: Record<string, number[]>;
  /** v1.0 继承的项数。 */
  inherited: number;
  /** 计划稿自称的合计（「合计 60」）。 */
  statedTotal?: number | undefined;
  /** 「参数生效阶段的分布统计」各阶段的项数（**另一条轴**：只校验总和，不与 §5 逐组比）。 */
  stageCounts: number[];
}

/**
 * 解析计划稿里的两份分类声明。
 *
 * ⚠️ **不锚措辞**：只认「组名 = ……N 项……」这个**结构**
 *   （组名与 §5 同名 ⇒ 逐组可比；数字一律取「N 项」形态）。
 *
 * @throws 找不到任何一个组 / 找不到 v1.0 继承数 ⇒ 抛错（**不**当作「一致」）
 */
export function parsePlanComposition(markdown: string): ParsedPlanComposition {
  const block = extractIndentedBlock(markdown, PLAN_COMPOSITION_MARKER);
  const groups: Record<string, number[]> = {};
  let inherited = -1;
  let statedTotal: number | undefined;

  for (const rawLine of block.split('\n')) {
    const body = rawLine.trim();
    // ⚠️ **整行取数**（计划稿的组没有括号段，数字散在「=」之后）。
    const groupMatch = /^(行为语义参数|性能参数|运维参数|机制开关)\s*=/.exec(body);
    if (groupMatch !== null) {
      const name = groupMatch[1] ?? '';
      const rest = body.slice(groupMatch[0].length).replace(/\*/g, '');
      groups[name] = [...rest.matchAll(/(\d+)\s*项/g)].map((match) => Number(match[1]));
      continue;
    }
    const inheritedMatch = /v1\.0\s*继承\s*=\s*\*{0,2}(\d+)\s*\*{0,2}\s*项/.exec(body);
    if (inheritedMatch !== null) {
      inherited = Number(inheritedMatch[1]);
    }
    const totalMatch = /合计\s*\*{0,2}(\d+)/.exec(body);
    if (totalMatch !== null) {
      statedTotal = Number(totalMatch[1]);
    }
  }

  for (const name of GROUP_NAMES) {
    if (groups[name] === undefined) {
      throw new Error(`开发计划稿里找不到「${name}」这一组 ⇒ 解析失败（不能当作「一致」）`);
    }
  }
  if (inherited < 0) {
    throw new Error('开发计划稿里找不到「v1.0 继承 = N 项」⇒ 解析失败（不能当作「一致」）');
  }

  // ⚠️ 阶段分布是**另一条轴**（按生效阶段拆，而不是按语义分类拆）
  //   ⇒ 只校验它的**总和**，**不**与 §5 的组逐组比（两条轴不可比）。
  const stageBlock = extractIndentedBlock(markdown, PLAN_STAGE_DISTRIBUTION_MARKER);
  const stageCounts = [...stageBlock.matchAll(/阶段\s*\d+\s*=\s*\*{0,2}(\d+)\s*\*{0,2}\s*项/g)].map(
    (match) => Number(match[1]),
  );
  if (stageCounts.length === 0) {
    throw new Error(
      '开发计划稿里找不到「参数生效阶段的分布统计」的阶段项数 ⇒ 解析失败（不能当作「一致」）',
    );
  }

  return { groups, inherited, statedTotal, stageCounts };
}

/** 一个组的解析结果。 */
export interface ParsedGroup {
  /** 该组括号段里出现的全部「N 项」（**含粗体包裹的数字**）。 */
  subs: number[];
  /** 该组**自己声明的组总数**（形如「= **9**」）；未声明则为 undefined。 */
  stated?: number;
}

/**
 * 解析 §5 分类声明的四个组。
 *
 * ⚠️ **措辞宽容 + 不锚粗体**（理由见文件头纪律 ①②）。
 *
 * @throws 找不到任何一个组 ⇒ 抛错（**不**当作「一致」）
 */
export function parseSection5Classification(markdown: string): Record<string, ParsedGroup> {
  const section = extractSection(markdown, SECTION_5_HEADING);
  const groups: Record<string, ParsedGroup> = {};

  for (const line of section.split('\n')) {
    if (!line.startsWith('> - ')) {
      continue;
    }
    // 按结构取组名：去掉 bullet 前缀 ⇒ 切到第一个括号/冒号前 ⇒ 去掉粗体星号
    const head = line.slice('> - '.length);
    const name = (head.split(/[（(:：]/)[0] ?? '').replace(/\*/g, '').trim();
    if (!GROUP_NAMES.includes(name as (typeof GROUP_NAMES)[number])) {
      continue;
    }
    // ⚠️ 文档用的是**全角**括号（`（` `）`），ASCII 括号也兼容
    const paren = /[（(]([^）)]*)[）)]/.exec(line)?.[1] ?? '';
    // 「N 项」里的 N 可能是粗体的（`**10** 项`）⇒ 先剥粗体再取数字
    const subs = [...paren.replace(/\*/g, '').matchAll(/(\d+)\s*项/g)].map((m) => Number(m[1]));
    const statedMatch = /=\s*\*{0,2}(\d+)/.exec(line);
    groups[name] = statedMatch === null ? { subs } : { subs, stated: Number(statedMatch[1]) };
  }

  for (const name of GROUP_NAMES) {
    if (groups[name] === undefined) {
      throw new Error(`§5 分类声明里找不到「${name}」这一组 ⇒ 解析失败（不能当作「一致」）`);
    }
  }

  return groups;
}

/**
 * 解析「v1.0 继承」项数（§5 末尾「参数总数：29（v1.0）→ 60（v2.1）」）。
 *
 * @throws 找不到 ⇒ 抛错
 */
export function parseInheritedCount(markdown: string): number {
  const section = extractSection(markdown, SECTION_5_HEADING);
  const match = /参数总数：(\d+)（v1\.0）/.exec(section);
  if (match === null) {
    throw new Error('§5 里找不到「参数总数：N（v1.0）」⇒ 解析失败（不能当作「一致」）');
  }
  return Number(match[1]);
}

/**
 * 解析 §8.1「config 事件的 `params` 是 N 项参数的完整生效快照」里的 N。
 *
 * ⚠️ **不要求 N 不带粗体**：勘误 ③ 的改后文本是「它是 **60** 项参数的**完整生效快照**」
 * ⇒ 严格正则在**改好之后**反而失配。
 *
 * @throws 找不到 ⇒ 抛错
 */
export function parseSection81ParamCount(markdown: string): number {
  const section = extractSection(markdown, SECTION_8_1_HEADING);
  const match = /它是 \*{0,2}(\d+)\*{0,2} 项参数的\*\*完整生效快照\*\*/.exec(section);
  if (match === null) {
    throw new Error('§8.1 里找不到「N 项参数的完整生效快照」⇒ 解析失败（不能当作「一致」）');
  }
  return Number(match[1]);
}

/** 一处不一致。 */
export interface DocCountDiff {
  reason: string;
}

/**
 * 断言「文档里自称的参数计数」与代码里的真实键数一致。
 *
 * @param markdown 设计稿全文
 * @param expectedKeyCount 代码里的参数键数（= `PARAM_KEYS.length`）
 */
export function checkDocCounts(markdown: string, expectedKeyCount: number): DocCountDiff[] {
  const diffs: DocCountDiff[] = [];

  const groups = parseSection5Classification(markdown);
  const inherited = parseInheritedCount(markdown);

  // ① 四组之和 + v1.0 继承 == 真实键数（**性质**：不依赖任何一种具体拆法）
  let sum = inherited;
  for (const name of GROUP_NAMES) {
    const group = groups[name];
    const groupSum = (group?.subs ?? []).reduce((a, b) => a + b, 0);
    sum += groupSum;
    // ② 每组**自己声明的组总数**（若写了）== 它的子项数之和
    if (group?.stated !== undefined && group.stated !== groupSum) {
      diffs.push({
        reason: `§5「${name}」声明的组总数 ${group.stated} ≠ 它的子项数之和 ${groupSum}`,
      });
    }
  }
  if (sum !== expectedKeyCount) {
    diffs.push({
      reason: `§5 分类声明的四组之和 + v1.0 继承 = ${sum} ≠ 代码里的参数键数 ${expectedKeyCount}`,
    });
  }

  // ③ §8.1 自称的参数项数 == 真实键数
  const section81Count = parseSection81ParamCount(markdown);
  if (section81Count !== expectedKeyCount) {
    diffs.push({
      reason: `§8.1 称 params 是 ${section81Count} 项参数的完整生效快照 ≠ 代码里的 ${expectedKeyCount} 项`,
    });
  }

  return diffs;
}

/**
 * 断言「开发计划稿里的分类构成声明」与 §5 一致（F-01 残余②）。
 *
 * ⚠️ **为什么必须有这条**（实测缺口）：
 *   §5 的分类声明在计划稿里**还有一份副本**（「项的构成」那一段）。
 *   实测：把那份副本改回旧口径（照抄相加得 61）⇒
 *   **6 条门禁全部 exit 0** ⇒ 假绿——因为**所有门禁只读 DESIGN-v2.md 一份**，
 *   源码与计划稿里的副本**没人守**。
 *   ⇒ 这条断言把那份副本纳入门禁：**谁漂了，门禁就红**。
 *
 * ⚠️ **断言的是「构成」而不是「某一串数字」**：
 *   ① 计划稿的构成之和 == §5 的参数总数（= 代码里的键数）；
 *   ② 计划稿自称的「合计 N」== 参数总数；
 *   ③ 计划稿与 §5 **逐组**的子项数一致（防「总数对、拆法不同」）；
 *   ④ 计划稿的 v1.0 继承项数 == §5 的；
 *   ⑤ 计划稿另一条轴（按生效阶段拆）的阶段项数之和 == 参数总数。
 *
 * @param planMarkdown 计划稿全文
 * @param designMarkdown 设计稿全文（取 §5 的分类声明与 v1.0 继承数）
 * @param expectedKeyCount 代码里的参数键数（= `PARAM_KEYS.length`）
 */
export function checkPlanDocCounts(
  planMarkdown: string,
  designMarkdown: string,
  expectedKeyCount: number,
): DocCountDiff[] {
  const diffs: DocCountDiff[] = [];

  const plan = parsePlanComposition(planMarkdown);
  const design = parseSection5Classification(designMarkdown);
  const designInherited = parseInheritedCount(designMarkdown);

  // ① 计划稿的构成之和 == §5 的参数总数
  let planSum = plan.inherited;
  for (const name of GROUP_NAMES) {
    planSum += (plan.groups[name] ?? []).reduce((a, b) => a + b, 0);
  }
  if (planSum !== expectedKeyCount) {
    diffs.push({
      reason:
        `DEVELOPMENT-PLAN.md「${PLAN_COMPOSITION_MARKER}」那一段的分类构成之和 = ${planSum}` +
        ` ≠ §5 的参数总数 ${expectedKeyCount}` +
        `（期望 ${expectedKeyCount}，实际 ${planSum}；§5 见 DESIGN-v2.md §5，计划稿见「${PLAN_COMPOSITION_MARKER}」那一段）` +
        ` ${PLAN_COMPOSITION_SOURCE_NOTE}`,
    });
  }

  // ② 计划稿自称的「合计 N」== 参数总数
  if (plan.statedTotal !== undefined && plan.statedTotal !== expectedKeyCount) {
    diffs.push({
      reason:
        `DEVELOPMENT-PLAN.md 自称的合计 ${plan.statedTotal} ≠ §5 的参数总数 ${expectedKeyCount}` +
        `（期望 ${expectedKeyCount}，实际 ${plan.statedTotal}）` +
        ` ${PLAN_COMPOSITION_SOURCE_NOTE}`,
    });
  }

  // ③ 逐组一致（防「总数对、拆法不同」）
  for (const name of GROUP_NAMES) {
    const planSubs = plan.groups[name] ?? [];
    const designSubs = design[name]?.subs ?? [];
    const planGroupSum = planSubs.reduce((a, b) => a + b, 0);
    const designGroupSum = designSubs.reduce((a, b) => a + b, 0);
    if (planGroupSum !== designGroupSum) {
      diffs.push({
        reason:
          `DEVELOPMENT-PLAN.md 的「${name}」构成 [${planSubs.join(' + ')}] = ${planGroupSum}` +
          ` ≠ §5 的 [${designSubs.join(' + ')}] = ${designGroupSum}` +
          `（期望 ${designGroupSum}，实际 ${planGroupSum}）` +
          ` ${PLAN_COMPOSITION_SOURCE_NOTE}`,
      });
    }
  }

  // ④ v1.0 继承项数一致
  if (plan.inherited !== designInherited) {
    diffs.push({
      reason:
        `DEVELOPMENT-PLAN.md 的 v1.0 继承 ${plan.inherited} 项 ≠ §5 的 ${designInherited} 项` +
        `（期望 ${designInherited}，实际 ${plan.inherited}）` +
        ` ${PLAN_COMPOSITION_SOURCE_NOTE}`,
    });
  }

  // ⑤ 阶段分布之和 == 参数总数（另一条轴，只看总和）
  //    ⚠️ **这一条刻意不带来源标注**：`PLAN_COMPOSITION_SOURCE_NOTE` 说的是
  //    「**本段**抄自 §5 末的分类声明」⇒ 它只适用于「项的构成」那一段；
  //    而「参数生效阶段的分布统计」是**另一条轴**的另一份声明 ⇒ 加同一句会变成**假话**。
  const stageSum = plan.stageCounts.reduce((a, b) => a + b, 0);
  if (stageSum !== expectedKeyCount) {
    diffs.push({
      reason:
        `DEVELOPMENT-PLAN.md「${PLAN_STAGE_DISTRIBUTION_MARKER}」的阶段项数之和 = ${stageSum}` +
        ` ≠ §5 的参数总数 ${expectedKeyCount}` +
        `（期望 ${expectedKeyCount}，实际 ${stageSum}）`,
    });
  }

  return diffs;
}

/**
 * 打印报告并返回**不一致的条数**（0 = 一致）。
 *
 * ⚠️ 返回值而不是直接 `process.exit` ⇒ 便于单测断言（纯函数 + 可测的 CLI）。
 *
 * @param markdown 设计稿全文
 * @param expectedKeyCount 代码里的参数键数（= `PARAM_KEYS.length`）
 * @param planMarkdown 计划稿全文（给了才校验它 —— F-01 残余②）
 */
export function reportDocCounts(
  markdown: string,
  expectedKeyCount: number,
  planMarkdown?: string,
): number {
  const diffs = checkDocCounts(markdown, expectedKeyCount);
  if (planMarkdown !== undefined) {
    diffs.push(...checkPlanDocCounts(planMarkdown, markdown, expectedKeyCount));
  }
  if (diffs.length === 0) {
    process.stdout.write(`✓ §5 分类声明与 §8.1 的参数计数与代码一致（${expectedKeyCount} 项）\n`);
    if (planMarkdown !== undefined) {
      process.stdout.write(
        `✓ DEVELOPMENT-PLAN.md 的分类构成与 §5 一致（${expectedKeyCount} 项）\n`,
      );
    }
    return 0;
  }
  process.stderr.write(`✗ 发现 ${diffs.length} 处参数计数不一致：\n`);
  for (const diff of diffs) {
    process.stderr.write(`    ${diff.reason}\n`);
  }
  return diffs.length;
}

/**
 * CLI 入口：读设计稿 → 断言 → 返回**退出码**。
 *
 * ⚠️ `--doc <path>` / `--plan <path>` 只为**测试**能指向别的文档（真实运行用默认路径）。
 */
export function runCli(argv: readonly string[] = []): number {
  const docIndex = argv.indexOf('--doc');
  const docPath = docIndex >= 0 ? (argv[docIndex + 1] ?? '') : '';
  const planIndex = argv.indexOf('--plan');
  const planPath = planIndex >= 0 ? (argv[planIndex + 1] ?? '') : '';
  const markdown = docPath === '' ? readDesignDoc() : readFileSync(resolve(docPath), 'utf8');
  const plan = planPath === '' ? readPlanDoc() : readFileSync(resolve(planPath), 'utf8');
  const diffs = reportDocCounts(markdown, PARAM_KEYS.length, plan);
  return diffs === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
