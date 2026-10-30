/**
 * 提案：`scripts/check-doc-counts.ts` 的单测（随提案同批落地）。
 *
 * ⚠️ 这些用例**全部**基于「勘误回写**之后**的设计稿文本」——
 *   因为回写未落地时，断言必然报红（§8.1 写「53」、§5 分类声明相加 61）。
 *   ⇒ 断言与回写**必须同批**落地（依据：docs/design/DESIGN-v2-errata.md 勘误 ② 与 ③）。
 */

import { describe, expect, it } from 'vitest';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkDocCounts,
  parseInheritedCount,
  parseSection5Classification,
  parseSection81ParamCount,
  runCli,
} from '../../scripts/check-doc-counts.js';
import { PARAM_KEYS } from '../../src/core/params.js';

/**
 * 勘误回写**之后**的 §5 分类声明片段（逐字抄自勘误 §2.4 的「改后」块）。
 */
const POST_WRITEBACK_CLASSIFICATION = [
  '> - **行为语义参数**（共激活 **10** 项、涌现簇 5 项、侧抑制 1 项）：改动会改变库的**拓扑与召回行为**，',
  '>   属于 ADR 级别的变更，须走 §13 的决策记录。',
  '> - **性能参数**（分桶路由 7 项 + 簇跳 1 项 + **向量路阈值 1 项 = `ROUTER_MIN_TRAINING`** = **9**）：只影响延迟与召回率，不改变语义，可在运行期调整。  ',
  '>   ⚠️ **「向量路」只算 `ROUTER_MIN_TRAINING` 一项**——`VECTOR_ROUTER` 归**机制开关**（它是一个三值选择器，「机制有没有」的语义），  ',
  '>   **两处都数它 ⇒ 四类相加会得到 61**，与 §6 的 60 个键对不上。  ',
  '> - **运维参数**（`ARCHIVAL_ORPHAN_CHECK` 1 项）：影响宿主调度各类维护动作的频率与开销。  ',
  '> - **机制开关（5 项：4 个布尔 + 1 个三值选择器 `VECTOR_ROUTER`）**：只切换机制的有无，不改变任何参数语义。  ',
].join('\n');

/**
 * 把一段 §5 分类声明 + 若干 §5/§8.1 的必要上下文，组装成一份**可解析的迷你设计稿**。
 *
 * ⚠️ 之所以用迷你稿而不是真文档：断言必须**对「文档长什么样」不敏感**，
 *   只对「文档**说了什么**」敏感 ⇒ 用迷你稿才能证明它不依赖具体排版。
 */
function miniDoc(
  classification: string,
  section81 = '它是 **60** 项参数的**完整生效快照**',
): string {
  return [
    '## 5. 参数表（集中配置）',
    '',
    '> ⚠️ **参数总数：29（v1.0）→ 60（v2.1）。新增 31 项（其中 5 项是机制开关）**。',
    '',
    classification,
    '',
    '### 8.1 文本日志规范',
    '',
    `- **唯一的例外是 \`config\` 事件的 \`params\`**：${section81}（§8.4，与 §5 参数表逐项一致），`,
    '',
  ].join('\n');
}

describe('提案 · §5 分类声明与 §8.1 参数计数的性质型断言', () => {
  it('回写后的文本 ⇒ 零不一致', () => {
    expect(checkDocCounts(miniDoc(POST_WRITEBACK_CLASSIFICATION), PARAM_KEYS.length)).toEqual([]);
  });

  it('★ 负控：共激活 10→9 ⇒ 总和不再等于 60 ⇒ 被抓住', () => {
    const broken = POST_WRITEBACK_CLASSIFICATION.replace('共激活 **10** 项', '共激活 **9** 项');
    const diffs = checkDocCounts(miniDoc(broken), PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('四组之和');
  });

  it('★ 负控：某组的子项数与它自己声明的组总数不符 ⇒ 被抓住', () => {
    const broken = POST_WRITEBACK_CLASSIFICATION.replace(
      '**向量路阈值 1 项 = `ROUTER_MIN_TRAINING`** = **9**',
      '**向量路阈值 2 项 = `ROUTER_MIN_TRAINING`** = **9**',
    );
    const diffs = checkDocCounts(miniDoc(broken), PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('声明的组总数');
  });

  it('★ 负控：§8.1 的 N ≠ 真实键数 ⇒ 被抓住', () => {
    const diffs = checkDocCounts(
      miniDoc(POST_WRITEBACK_CLASSIFICATION, '它是 **55** 项参数的**完整生效快照**'),
      PARAM_KEYS.length,
    );
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((d) => d.reason).join(' ')).toContain('§8.1');
  });

  it('★ 负控：v1.0 继承项数被改 ⇒ 被抓住', () => {
    const doc = miniDoc(POST_WRITEBACK_CLASSIFICATION).replace(
      '参数总数：29（v1.0）',
      '参数总数：28（v1.0）',
    );
    const diffs = checkDocCounts(doc, PARAM_KEYS.length);
    expect(diffs.length).toBeGreaterThan(0);
  });

  it('★ 找不到组 ⇒ 抛错（不静默跳过：跳过 = 解析器漏读伪装成一致）', () => {
    const doc = miniDoc('> - **别的参数**（1 项）：无关的组。');
    expect(() => parseSection5Classification(doc)).toThrow(/找不到/);
  });

  it('★ 找不到 §8.1 的计数 ⇒ 抛错', () => {
    const doc = miniDoc(POST_WRITEBACK_CLASSIFICATION).replace(
      '它是 **60** 项参数的**完整生效快照**',
      '它是若干项参数的完整生效快照',
    );
    expect(() => parseSection81ParamCount(doc)).toThrow(/找不到/);
  });

  it('★ 找不到「参数总数：N（v1.0）」⇒ 抛错', () => {
    const doc = miniDoc(POST_WRITEBACK_CLASSIFICATION).replace(
      '参数总数：29（v1.0）',
      '参数总数若干',
    );
    expect(() => parseInheritedCount(doc)).toThrow(/找不到/);
  });

  it('★ 措辞宽容：勘误把「向量路开关」改成「向量路阈值」后仍能解析', () => {
    const groups = parseSection5Classification(miniDoc(POST_WRITEBACK_CLASSIFICATION));
    expect(groups.性能参数?.subs).toEqual([7, 1, 1]);
    expect(groups.性能参数?.stated).toBe(9);
  });

  it('★ CLI：一致 ⇒ 退出码 0；不一致 ⇒ 退出码非 0（脚本不许「什么都不做也过」）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-doccounts-'));
    const good = join(dir, 'good.md');
    const bad = join(dir, 'bad.md');
    writeFileSync(good, miniDoc(POST_WRITEBACK_CLASSIFICATION), 'utf8');
    writeFileSync(
      bad,
      miniDoc(POST_WRITEBACK_CLASSIFICATION, '它是 **55** 项参数的**完整生效快照**'),
      'utf8',
    );

    expect(runCli(['--doc', good])).toBe(0);
    expect(runCli(['--doc', bad])).not.toBe(0);
  });

  it('★ 不锚粗体：现行文档的「机制开关」那一行粗体未闭合，仍能解析出该组', () => {
    // 现行文档原文：粗体只有一个 `**`（没有闭合）⇒ 锚在 `**...**` 上的提取会静默漏掉这一组
    const unclosedBold = POST_WRITEBACK_CLASSIFICATION.replace(
      '> - **机制开关（5 项：4 个布尔 + 1 个三值选择器 `VECTOR_ROUTER`）**：只切换机制的有无，不改变任何参数语义。  ',
      '> - **机制开关（5 项：4 个布尔 + 1 个三值选择器））：只切换机制的有无，不改变任何参数语义。',
    );
    const groups = parseSection5Classification(miniDoc(unclosedBold));
    expect(groups.机制开关?.subs).toEqual([5]);
  });
});
