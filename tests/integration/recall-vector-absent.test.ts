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

import { DEFAULT_PARAMS } from '../../src/core/params.js';
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

// ═══════════════════════════════════════════════════════════════════════════
// T03 补强（阶段 5 · P2-T10）：**B 行**（整路缺席）与 **A 行**（不传）逐字段相同
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **为什么这一组必须存在**（设计 D5 的处境表）：
 *   A 行（不传 `queryEmbedding`）与 B 行（传了，但向量路整路缺席）在**行为产物上必须一致**——
 *   都是 `ran=false` / `candidates=0` / 每条 `fromVector=false` / `cos=null` / `vectorPart=0`。
 *   ⇒ 而「一致」这件事**只能靠逐字段比**：只断言几个标志的话，
 *     「B 行其实悄悄走了 flat」这种错**看不出来**（分数只差 0.25 × cos，看起来仍是合法数字）。
 *
 * ⚠️ 本组与文件头那两条断言**不是同一件事**：那两条说的是「没配 embedder ⇒ 向量分恒 0」；
 *   本组说的是「**传了**向量但整路缺席 ⇒ 与不传完全一样」。两者共用「缺项」这个结论，
 *   但走的是不同分支（前者连端口都不装配，后者装配了但 `mode='absent'`）。
 */
describe('T03 补强 · B 行：过门槛但分桶未训练（`absent`）⇒ 传了向量与不传**逐字段相同**', () => {
  /** 建一个**过了建桶门槛但没有细桶**的库（`mode='absent'`）。 */
  function createAbsentStore(): MemoryStore {
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-recall-absent-mode-'));
    // ⚠️ 门槛压到 2 条：`ROUTER_MIN_TRAINING` 是**参数**（§5），压它不改变被测逻辑；
    //   默认 10000 条在测试里不可行。`'auto'` + 过门槛 + 无细桶 ⇒ `absent`（不是 flat_auto）。
    const store = new MemoryStore({
      dbPath: join(dataDir, 'memory.db'),
      params: { VECTOR_ROUTER: 'auto', ROUTER_MIN_TRAINING: 2 },
    });
    store.write({ content: '张三住在北京', embedding: unitEmbedding(0), now: 1_700_000_000_000 });
    store.write({ content: '张三每天喝茶', embedding: unitEmbedding(1), now: 1_700_000_000_000 });
    return store;
  }

  /** 只在一个轴上为 1 的 768 维向量（`EMBED_DIM` 由参数表决定）。 */
  function unitEmbedding(axis: number): number[] {
    const vector = new Array<number>(DEFAULT_PARAMS.EMBED_DIM).fill(0);
    vector[axis] = 1;
    return vector;
  }

  it("★ `mode==='absent'` ⇒ 传了向量也 `ran=false`，且 `hits` / `suppressed` / `diffused` 与**不传**逐字段相同", () => {
    const store = createAbsentStore();
    try {
      // ── 前提自检：这一库确实是 `absent`（不是 flat_auto、也不是 ivf）──
      const mode = store.stats(1_700_000_000_000).vectorBackend.mode;
      expect(mode).toBe('absent');

      const context = '张三住在哪里';
      const plain = store.recall({ context, explain: true, now: 1_700_000_000_000 });
      const withVector = store.recall({
        context,
        explain: true,
        now: 1_700_000_000_000,
        queryEmbedding: unitEmbedding(0),
      });

      // ── 分母不为 0（否则下面的「相同」是空转）──
      expect(plain.hits.length).toBeGreaterThanOrEqual(1);
      // ── B 行的五个字段（与 A 行**同值**）──
      // ⚠️ 整路缺席 ⇒ `codesMissing` 同样是**确定值 0**（桶集为空）⇒ 逐字段钉死（`toEqual`）。
      expect(withVector.explain?.routes.vector).toEqual({
        ran: false,
        candidates: 0,
        codesMissing: 0,
      });
      for (const hit of withVector.hits) {
        expect(hit.fromVector).toBe(false);
        expect(hit.breakdown?.cos).toBeNull();
        expect(hit.breakdown?.vectorPart).toBe(0);
      }
      // ── **逐字段相同**（这一条才是「B 行 ≡ A 行」的证明）──
      expect(withVector.hits).toEqual(plain.hits);
      expect(withVector.suppressed).toEqual(plain.suppressed);
      expect(withVector.diffused).toEqual(plain.diffused);
    } finally {
      store.close();
    }
  });
});
