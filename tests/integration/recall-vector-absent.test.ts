/**
 * ★ **库侧**断言：未配 embedder ⇒ 明细里的 `vectorPart` 恒为 0 —— 阶段 5 · T03 断言补强。
 *
 * ⚠️ ★ **为什么这条必须放在库侧（而不是面板测试里）**：
 *   面板测试能证明的只是「**拿到 0 就显示 0.000**」——那是**投影**，不是**行为**。
 *   把库侧改成 `vectorPart: 0.25` 而面板照抄，「面板显示 0.000」那条**照样绿**，
 *   因为它喂的是手工构造的 `breakdown`。
 *   ⇒ 「无 embedder ⇒ 库真的给 0」只能在**真的跑一次 `recall()`** 的地方证明。
 *   ⇒ 面板侧的同一句话已在 `viewer-panels-structure.test.ts` 里**注明是投影断言**。
 *
 * ⚠️ 本文件用**可写**实例（要 `write()` 造数据），断言的是**读**路径的行为：
 *   `recall()` 在只读/可写两种句柄上行为一致（§7.1 第 4 条只影响 `appendEvent()`）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MemoryStore } from '../../src/store/MemoryStore.js';

/** 建一个**没有 embedder** 的临时库，写入一条带实体的记忆。 */
function createStore(): { store: MemoryStore; content: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-recall-absent-'));
  const store = new MemoryStore({ dbPath: join(dataDir, 'memory.db') });
  // ⚠️ 刻意**不传** `embedding`：这正是「未配 embedder」的形态
  const content = '张三喜欢猫';
  store.write({ content, entities: ['张三', '猫'] });
  return { store, content };
}

describe('T03 补强 · 库侧：未配 embedder 时 `vectorPart` 恒为 0（不是 0.25 或复用别的分项）', () => {
  it('★ `explain.routes.vector.ran === false`，且**每一条**命中的 `breakdown.vectorPart === 0`', () => {
    const { store, content } = createStore();
    try {
      const result = store.recall({
        context: content,
        explain: true,
        reinforce: false,
      });

      // 分母不为 0：真的召回到了东西，否则下面的循环是空转
      expect(result.hits.length).toBeGreaterThanOrEqual(1);
      expect(result.explain?.routes.vector.ran).toBe(false);

      for (const hit of result.hits) {
        expect(hit.breakdown, '开了 explain 就必须有 breakdown').toBeDefined();
        expect(hit.breakdown?.vectorPart).toBe(0);
        // 判别力：它不是「一个很像 0 的小数」
        expect(hit.breakdown?.vectorPart).not.toBe(0.25);
        expect(hit.breakdown?.cos).toBeNull();
      }
    } finally {
      store.close();
    }
  });

  it('★ 五柱之和仍等于 `score`（`vectorPart = 0` 不能是靠「少算一项」凑出来的）', () => {
    const { store, content } = createStore();
    try {
      const result = store.recall({ context: content, explain: true, reinforce: false });
      expect(result.hits.length).toBeGreaterThanOrEqual(1);

      for (const hit of result.hits) {
        const breakdown = hit.breakdown;
        expect(breakdown).toBeDefined();
        if (breakdown === undefined) {
          continue;
        }
        const sum =
          breakdown.intensityPart +
          breakdown.vectorPart +
          breakdown.textPart +
          breakdown.graphPart +
          breakdown.recencyPart;
        expect(Math.abs(sum - hit.score)).toBeLessThanOrEqual(1e-9);
      }
    } finally {
      store.close();
    }
  });
});
