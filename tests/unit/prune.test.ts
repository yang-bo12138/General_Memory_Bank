/**
 * `src/vector/prune.ts` 的单测 —— C′ 档 **T04** 的剪枝原语
 * （规格 `docs/design/perf-c2-admissible-two-stage.md` §5.1.1 / §5.1.7 / §5.1.10）。
 *
 * ★ **本文件要证明的不是「剪枝跑得通」，而是四件更容易写错的事**：
 *   ① **早停用严格小于**（`<`，不是 `≤`）—— 否则「同分且 id 更小」的行会被漏掉；
 *   ② **无码行的 `upper = +∞` ⇒ 排最前、且早停永远不会越过它**（§5.1.5 的 fail-open）；
 *   ③ **`threshold` 只作用在 `upper` 上**（不是精确分）⇒ 精确分低于门槛的行**能**进来占位；
 *   ④ **`exactRescoreBudget` 用尽后撤回剪枝不改结果**（只多付 IO）；
 *      ★ 而**不传预算**（`undefined`）⇒ 无预算 ⇒ 早停照常工作（`exactReads` 可以超过 64）。
 *
 * ⚠️ **判据是「逐位相同」**（`Object.is`），不是 `toBeCloseTo`：剪枝的全部价值就在这条。
 * ⚠️ **夹具是手写的码，不是编码器产物**：本文件测的是**剪枝逻辑**，
 *   把 `encodeVector()` 拉进来只会让「哪一位不同」变成灾难（A3/A4 另有专门用例）。
 */

import { describe, expect, it, vi } from 'vitest';

import { blankComments } from '../../scripts/lib/code-span.js';
import { compareHits } from '../../src/vector/flat.js';
import {
  type CodedEntry,
  type PruneEntry,
  type PruneHit,
  WRITE_EXACT_RESCORE_BUDGET,
  pruneTopK,
} from '../../src/vector/prune.js';
import { approxDot, approxDotWithWidth, unpackCode } from '../../src/vector/quantize.js';
import { readCode, readRaw } from '../helpers/sourceScan.js';

/**
 * ★★★ **把 `quantize.ts` 的两个点积函数换成「间谍」**（T08 · A2 的机械背书）。
 *
 * ★ **为什么必须这样**（这是 A2 存在的**全部理由**）：
 *   `approxDotWithWidth` 的 int8 分支与 `approxDot` **逐位相同**（A1 已证）
 *   ⇒ ⇒ **任何「比值」的断言都抓不住「有人把 int8 切到新分支」**
 *   ⇒ ⇒ ⇒ 唯一的办法是**观测「生产路径到底调了谁」** ⇒ ⇒ 间谍。
 *
 * ⚠️ **间谍是「调包不改行为」**：`vi.fn(actual.approxDot)` 仍然调用**真函数**
 *   ⇒ ⇒ 本文件其余用例的行为**一字不变** ⇒ ⇒ 既有用例继续背书。
 */
vi.mock('../../src/vector/quantize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vector/quantize.js')>();
  return {
    ...actual,
    approxDot: vi.fn(actual.approxDot),
    approxDotWithWidth: vi.fn(actual.approxDotWithWidth),
  };
});

/**
 * 造一条「码 + 精确向量」的夹具：`code = [1, 0, 0, 0]`、`scale = score`
 * ⇒ `x = scale × code` ⇒ `q·x = score`（`q = [1,0,0,0]`）。
 *
 * ⚠️ **`eps = 0` 是刻意的**：它让「上界 == 精确分」，于是早停的边界条件
 *   （`upper < 第 k 名` vs `≤`）**恰好落在等号上** ⇒ 「严格小于」这条纪律才有牙。
 * ⚠️ **值走 `scale`、不走 `code`**：`Uint8Array` 只能装整数（`Uint8Array.from([0.5])` 会静默变成 0）
 *   —— 这条坑在本文件的第一版里真的踩到了（两条用例因此假通过）。
 * ⚠️ **`codeWidth: 'int8'` 是必填的**（T08）：码宽是**数据属性**，不许有「缺省 = int8」，
 *   ⇒ 忘了传就会静默按 int8 口径算上界 ⇒ ⇒ 静默漏检。
 */
function exactEntry(id: string, score: number): CodedEntry {
  return {
    kind: 'coded',
    id,
    code: Uint8Array.from([1, 0, 0, 0]),
    codeWidth: 'int8',
    scale: score,
    eps: 0,
  };
}

/** 精确分 = 点积（`‖q‖ = ‖x‖` 的夹具里它就是余弦；本文件不关心归一化）。 */
const query = Float32Array.from([1, 0, 0, 0]);

/**
 * 精确分：`q·x`（其中 `x = scale × code`）。
 *
 * ⚠️ ★ **必须按码宽解包**（T08 · 规格 `docs/design/perf-c2-codewidth-int4-wiring.md` §5 的 M3）：
 *   `code` 现在是 `Uint8Array`（★ 打包字节）⇒ ⇒ **直接读元素拿到的是 0..255**
 *   ⇒ ⇒ int8 的负值会变成大正数 ⇒ ⇒ **参照值算错** ⇒ ⇒ 用例**假绿**。
 * ⇒ ⇒ 这里用 `unpackCode()`（★ 它按码宽解包；int8 分支正好返回 `Int8Array`）。
 * ⇒ ⇒ `dim` 取 `query.length`（★ `pruneTopK()` 已按码宽校验过「码长 == 该维度的期望码长」
 *   ⇒ ⇒ **查询向量长度就是维度**）。
 */
function exactOf(entry: CodedEntry): number {
  const unpacked = unpackCode(entry.code, entry.codeWidth, query.length);
  let sum = 0;
  for (let index = 0; index < query.length; index += 1) {
    sum += (query[index] as number) * (unpacked[index] as number) * entry.scale;
  }
  return sum;
}

/** 从 entries 里造一个「精确分查询」表（模拟调用方注入的 `scoreOf`）。 */
function scoreTableOf(entries: readonly PruneEntry[]): (id: string) => number | null {
  const scores = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'coded') {
      scores.set(entry.id, exactOf(entry));
    }
  }
  return (id) => scores.get(id) ?? null;
}

/** 全量精确参照：所有行算精确分 → 按 `compareHits` 排 → 取前 k。 */
function referenceTopK(
  entries: readonly (PruneEntry & { kind: 'coded' })[],
  k: number,
): PruneHit[] {
  const hits: PruneHit[] = entries.map((entry) => ({ id: entry.id, score: exactOf(entry) }));
  hits.sort(compareHits);
  return hits.slice(0, k);
}

describe('T04 · 剪枝原语（pruneTopK）', () => {
  describe('契约：三个计数与 error 面', () => {
    it('`k = 0` ⇒ 空 survivors，但 `candidates` / `uncoded` 如实计数、`exactReads = 0`', () => {
      const entries: PruneEntry[] = [exactEntry('a', 1), { kind: 'uncoded', id: 'b' }];
      const out = pruneTopK(entries, { query, k: 0, scoreOf: scoreTableOf(entries) });
      expect(out.survivors).toEqual([]);
      // ⚠️ **候选宇宙 = entries.length**（不是 survivors 的条数）
      expect(out.candidates).toBe(2);
      expect(out.uncoded).toBe(1);
      // ⚠️ 一条都没读（没有 K 名额 ⇒ 读谁都是白读）
      expect(out.exactReads).toBe(0);
    });

    it('`k` 非非负整数 / 码长不符 / `scale` 非有限 / `eps` 为负 / `threshold` 是 NaN ⇒ 一律抛 INVALID_INPUT', () => {
      const good: PruneEntry[] = [exactEntry('a', 1)];
      const scoreOf = (): number => 1;
      expect(() => pruneTopK(good, { query, k: -1, scoreOf })).toThrowError(/k/);
      expect(() => pruneTopK(good, { query, k: 1.5, scoreOf })).toThrowError(/k/);
      expect(() =>
        pruneTopK([{ ...exactEntry('a', 1), code: Uint8Array.from([1, 0]) }], {
          query,
          k: 1,
          scoreOf,
        }),
      ).toThrowError(/长度/);
      expect(() =>
        pruneTopK(
          [
            {
              kind: 'coded',
              id: 'a',
              code: Uint8Array.from([1, 0, 0, 0]),
              codeWidth: 'int8',
              scale: Number.NaN,
              eps: 0,
            },
          ],
          {
            query,
            k: 1,
            scoreOf,
          },
        ),
      ).toThrowError(/标量/);
      expect(() =>
        pruneTopK(
          [
            {
              kind: 'coded',
              id: 'a',
              code: Uint8Array.from([1, 0, 0, 0]),
              codeWidth: 'int8',
              scale: 1,
              eps: -1e-9,
            },
          ],
          { query, k: 1, scoreOf },
        ),
      ).toThrowError(/误差项/);
      expect(() => pruneTopK(good, { query, k: 1, threshold: Number.NaN, scoreOf })).toThrowError(
        /NaN/,
      );
    });

    it('`scoreOf` 抛错 ⇒ 原样透传（不许吞）', () => {
      const entries: PruneEntry[] = [exactEntry('a', 1)];
      expect(() =>
        pruneTopK(entries, {
          query,
          k: 1,
          scoreOf: () => {
            throw new Error('boom');
          },
        }),
      ).toThrowError('boom');
    });

    it('`scoreOf` 返回 `null` 的行**不入堆、不占 K 名额**，但仍计入 `exactReads`', () => {
      const entries: PruneEntry[] = [exactEntry('a', 1), exactEntry('b', 0.9), exactEntry('c', 0)];
      const out = pruneTopK(entries, {
        query,
        k: 2,
        scoreOf: (id) =>
          id === 'b' ? null : exactOf(entries.find((e) => e.id === id) as CodedEntry),
      });
      // `b` 不在候选宇宙里 ⇒ 名额让给 `c`
      expect(out.survivors.map((hit) => hit.id)).toEqual(['a', 'c']);
      // 三条都调过 `scoreOf`（`b` 那次也已经付了代价）
      expect(out.exactReads).toBe(3);
    });
  });

  /**
   * ★★★ **断言 1c（口径 §2）：`exactReads` === `scoreOf` 的【调用次数】**。
   *
   * ⚠️ ★ **为什么这条必须存在**（它守的是「bench 侧剪枝率分子的可信性」）：
   *   bench 侧的剪枝率分子 = `embeddingCalls` = **`scoreOf` 的 `get()` 调用次数**
   *   （**无条件**计数 ⇒ 返回 `undefined` 也计）
   *   ⇒ ⇒ 而口径要它与 `prune` 的 `exactReads` **定义性相等**
   *   ⇒ ⇒ **这条断言就是那两个数的「换算说明书」**：哪天 `prune.ts` 改了 `exactReads`
   *   的计数口径（比如改成「只数返回了行的」），这条会红 ⇒ ⇒ **bench 的剪枝率不会被悄悄放宽**。
   *
   * ⚠️ ★ **为什么必须是「调用次数」而不是「返回行数」**（方向纪律）：
   *   门槛是「≤」⇒ **分子偏小 = 更容易过 = 偏松 = 假绿**
   *   ⇒ ⇒ 最坏情形：命中桶内全是软删成员 ⇒ 「返回行数」= 0 ⇒ 剪枝率 0% ⇒ **假绿**。
   *
   * ⚠️ ★ **等价性只在【两段式分支（`prune = true`）成立】**：
   *   `prune = false` 的对照分支（`src/vector/ivf.ts:748`）**根本不调 `scoreOf`**
   *   ⇒ ⇒ 那条路上「`exactReads` == 调用次数」是**恒真**（两边都是 0）⇒ 没意义。
   *   ⇒ ⇒ **本条的夹具必须走两段式**（`pruneTopK()` 本身就是两段式的那一段
   *   ⇒ ⇒ 夹具必须**真的调 `scoreOf`** ⇒ 若一条都没调 ⇒ 断言恒绿 ⇒ 必须排除）。
   */
  describe('★ 断言 1c：`exactReads` === `scoreOf` 的【调用次数】（bench 侧剪枝率分子的依据）', () => {
    it('★ 早停发生 ⇒ `exactReads` 严格等于 `scoreOf` 的调用次数（**不是**返回行数）', () => {
      // ⚠️ **夹具必须让早停真的发生**（否则 `exactReads` = 全部候选数 ⇒
      //   「调用次数 == exactReads」会**恰好**也成立 ⇒ 这条断言就变成恒绿 ⇒ 没牙）。
      //   ⇒ 造 40 条「上界宽、精确分低」的行 + 5 条「上界窄」的行
      //   ⇒ ⇒ `k = 3` ⇒ 读到第 3 条时堆满 ⇒ 第 4 条起上界 < 第 3 名 ⇒ **早停**。
      const entries: PruneEntry[] = [];
      for (let index = 0; index < 40; index += 1) {
        entries.push({
          kind: 'coded',
          id: `w-${String(index).padStart(3, '0')}`,
          code: Uint8Array.from([1, 0, 0, 0]),
          codeWidth: 'int8',
          scale: 0.5,
          eps: 0.4,
        });
      }
      for (let index = 0; index < 5; index += 1) {
        entries.push({
          kind: 'coded',
          id: `n-${String(index).padStart(3, '0')}`,
          code: Uint8Array.from([1, 0, 0, 0]),
          codeWidth: 'int8',
          scale: 0.1,
          eps: 0,
        });
      }
      // ⚠️ ★ **计数包装**：数 `scoreOf` 的**调用次数**（**无条件**计数 ⇒ 返回 `null` 也计）。
      let calls = 0;
      const scores = new Map<string, number>();
      for (const entry of entries) {
        if (entry.kind === 'coded') {
          scores.set(entry.id, exactOf(entry));
        }
      }
      const countingScoreOf = (id: string): number | null => {
        calls += 1;
        return scores.get(id) ?? null;
      };
      const out = pruneTopK(entries, { query, k: 3, scoreOf: countingScoreOf });
      // ⚠️ **前提**：早停真的发生了（`exactReads` 明显小于候选总数）⇒ 否则这条断言没牙。
      expect(out.exactReads).toBeLessThan(entries.length);
      expect(out.exactReads).toBeGreaterThan(0);
      // ⚠️ ★★ **核心断言（口径 §2 断言 1c）**：`exactReads` **逐位等于**调用次数。
      expect(out.exactReads).toBe(calls);
      // ⚠️ ★ **反向**：调用次数**不等于**「返回了行的次数」⇒ 说明这两条路**真的分得开**
      //   ⇒ ⇒ 若哪天有人把 bench 的分子改成「返回行数」⇒ bench 的断言 1c-bench 会红。
      const returnedRows = out.survivors.length;
      expect(calls).toBeGreaterThan(returnedRows);
    });

    it('★ `scoreOf` 返回 `null` 的行**也算一次调用**（⇒ 分子偏大 = 更严，不是偏松）', () => {
      const entries: PruneEntry[] = [exactEntry('a', 1), exactEntry('b', 0.9), exactEntry('c', 0)];
      let calls = 0;
      const out = pruneTopK(entries, {
        query,
        k: 2,
        scoreOf: (id) => {
          calls += 1;
          // ⚠️ **`b` 永远返回 `null`**（模拟「不在候选宇宙里」）⇒ 它**消耗了一次调用**。
          return id === 'b' ? null : exactOf(entries.find((e) => e.id === id) as CodedEntry);
        },
      });
      // ⚠️ ★ **核心断言**：返回 `null` 的那次**照样计入** `exactReads`
      //   ⇒ ⇒ `exactReads` == 调用次数（**不是**「返回行数」= 2）。
      expect(out.exactReads).toBe(3);
      expect(calls).toBe(3);
      expect(out.exactReads).toBe(calls);
      // ⚠️ ★ **方向纪律的证据**：`exactReads`（3）> 返回行数（2）
      //   ⇒ ⇒ 若 bench 的剪枝率分子取「返回行数」⇒ 分子偏小 ⇒ **偏松 = 假绿**
      //   ⇒ ⇒ 这条差值就是「为什么必须用调用次数」的量化证据。
      expect(out.exactReads).toBeGreaterThan(out.survivors.length);
    });

    it('★ 无预算（读路径口径）与写路径预算**两个配置的 `exactReads` 都等于各自的调用次数', () => {
      const entries: PruneEntry[] = [];
      for (let index = 0; index < 99; index += 1) {
        entries.push({
          kind: 'coded',
          id: `h-${String(index).padStart(3, '0')}`,
          code: Uint8Array.from([1, 0, 0, 0]),
          codeWidth: 'int8',
          scale: 0.5,
          eps: 0.4,
        });
      }
      for (let index = 0; index < 100; index += 1) {
        entries.push({
          kind: 'coded',
          id: `l-${String(index).padStart(3, '0')}`,
          code: Uint8Array.from([1, 0, 0, 0]),
          codeWidth: 'int8',
          scale: 0.1,
          eps: 0,
        });
      }
      const scores = new Map<string, number>();
      for (const entry of entries) {
        if (entry.kind === 'coded') {
          scores.set(entry.id, exactOf(entry));
        }
      }
      // ① 无预算（读路径口径）：早停在 99 处停住。
      let unbudgetedCalls = 0;
      const unbudgeted = pruneTopK(entries, {
        query,
        k: 5,
        scoreOf: (id) => {
          unbudgetedCalls += 1;
          return scores.get(id) ?? null;
        },
      });
      expect(unbudgeted.exactReads).toBe(99);
      expect(unbudgeted.exactReads).toBe(unbudgetedCalls);
      // ② 写路径预算（64）：预算用尽 ⇒ 撤回剪枝 ⇒ 扫完（199 条）。
      let budgetedCalls = 0;
      const budgeted = pruneTopK(entries, {
        query,
        k: 5,
        exactRescoreBudget: WRITE_EXACT_RESCORE_BUDGET,
        scoreOf: (id) => {
          budgetedCalls += 1;
          return scores.get(id) ?? null;
        },
      });
      expect(budgeted.exactReads).toBe(entries.length);
      expect(budgeted.exactReads).toBe(budgetedCalls);
    });
  });

  describe('★ 早停：严格小于（`<`，不是 `≤`）', () => {
    it('「同分且 id 更小」的行**必须**进 survivors（用 `≤` 会把它漏掉）', () => {
      // 五条**同分**（都是 1.0），id 逆序给出 ⇒ 队列按 upper 降序、同 upper 按 id 升序
      // ⇒ 前 k 名之后剩下的行 upper 恰好**等于**第 k 名的分。
      const entries: PruneEntry[] = [
        exactEntry('m-05', 1),
        exactEntry('m-04', 1),
        exactEntry('m-03', 1),
        exactEntry('m-02', 1),
        exactEntry('m-01', 1),
      ];
      const out = pruneTopK(entries, { query, k: 3, scoreOf: scoreTableOf(entries) });
      // ⇒ 必须是 id 升序的前 3 条（同分 id 升序），**不是**「先来先得」的 m-05/m-04/m-03
      expect(out.survivors.map((hit) => hit.id)).toEqual(['m-01', 'm-02', 'm-03']);
      // ⚠️ 若早停写成 `≤`：`m-03` 之后的 `m-04/m-05` 会被跳过 —— 它们本来也不该进前三，
      //   **但**同一形状在「前 k 名分数更高、后面同分」时才会真的丢行。见下一条。
    });

    it('★★ 「第 k 名的分 == 剩余最大 upper」⇒ `≤` 会丢一条同分且 id 更小的行（本条是那条唯一可靠的牙）', () => {
      // 构造要点（**必须是 `eps > 0` 才能造出这种局面**）：
      //   队列按 **upper** 降序排，而早停比的是 **upper vs 第 k 名的精确分**。
      //   ⇒ 让一条「upper 大、精确分低」的行先占住第 k 名，再让一条
      //     「upper 恰好等于该精确分、id 更小」的行排在它**后面**：
      //
      //   | 队列位 | id     | upper | 精确分 |
      //   |---|---|---|---|
      //   | 1 | m-09 | 1.0 | 1.0 |
      //   | 2 | m-08 | 0.6 | **0.5** |  ← upper 宽松（eps = 0.1）⇒ 它先被读、占住第 2 名
      //   | 3 | m-02 | 0.5 | 0.5 |      ← id 更小 ⇒ **应该**挤掉 m-08
      //   | 4 | m-05 | 0.5 | 0.5 |
      //
      //   k = 2 ⇒ 读完前两条后：第 2 名 = m-08（0.5，id 更大），剩余最大 upper = 0.5
      //   · `<`（正确）：`0.5 < 0.5` 为假 ⇒ 继续读 ⇒ m-02 与 m-08 同分且 id 更小 ⇒ 挤掉它 ✓
      //   · `≤`（错误）：`0.5 ≤ 0.5` 为真 ⇒ **提前停** ⇒ 丢掉 m-02 ⇒ 结果错，且是**静默**的
      //     （条数一样、都是 2 条、分数也一样 —— 只有 id 不同）⇒ 这正是 A1/A2「逐位」才抓得到的那类。
      const loose: CodedEntry = {
        kind: 'coded',
        id: 'm-08',
        code: Uint8Array.from([1, 0, 0, 0]),
        codeWidth: 'int8',
        scale: 0.5,
        eps: 0.1, // ⇒ upper = 0.6，精确分仍是 0.5
      };
      const entries: PruneEntry[] = [
        exactEntry('m-09', 1), // upper 1.0 / 分 1.0
        loose, // upper 0.6 / 分 0.5
        exactEntry('m-02', 0.5), // upper 0.5 / 分 0.5（id 更小 ⇒ 该进）
        exactEntry('m-05', 0.5), // upper 0.5 / 分 0.5
      ];
      const out = pruneTopK(entries, { query, k: 2, scoreOf: scoreTableOf(entries) });
      expect(out.survivors.map((hit) => hit.id)).toEqual(['m-09', 'm-02']);
      expect(out.survivors.map((hit) => hit.score)).toEqual([1, 0.5]);
    });
  });

  describe('★ 无码行：`upper = +∞` ⇒ 排最前、早停永不越过它', () => {
    it('★★ 无码行的**精确分更高**时它必须进 survivors（`upper` 一旦不是 `+∞`，这里就丢行）', () => {
      // a: 有码 1.0 / b: 有码 0.9 / u: **无码**，精确分 0.95
      // ⇒ 正确的 top-2 是 a + u（0.95 > 0.9）。
      // ⚠️ 若把无码的 `upper` 写成有限值（哪怕写成 0）：它排到队尾，
      //   而堆满两条之后 `0 < 0.9` ⇒ **立刻早停** ⇒ `u` 根本没被读 ⇒ 结果丢掉 0.95 那条。
      const entries: PruneEntry[] = [
        exactEntry('m-01', 1),
        exactEntry('m-02', 0.9),
        { kind: 'uncoded', id: 'm-00' },
      ];
      const scoreOf = (id: string): number | null =>
        id === 'm-00' ? 0.95 : exactOf(entries.find((entry) => entry.id === id) as CodedEntry);
      const out = pruneTopK(entries, { query, k: 2, scoreOf });
      expect(out.survivors.map((hit) => hit.id)).toEqual(['m-01', 'm-00']);
      expect(out.uncoded).toBe(1);
      // 只读了两条：`m-02` 的 upper（0.9）已经 < 第 2 名（0.95）⇒ **可证**它进不了前二 ✓
      expect(out.exactReads).toBe(2);
    });
  });

  describe('★★ `scoreFloor`：结果键被钳制时，`upper` 不再是结果键的上界', () => {
    it('第 K 名的分 == 下界（0）时，`upper < 0` 的行**必须**被读進來按 id 抢名额', () => {
      // 结果键 = `clampCos`（负余弦一律变 0）⇒ 下界 = 0。
      //   a: upper 0.5  ⇒ 分 0.5
      //   b: upper 0.1  ⇒ 分 0.0（被钳制），id `m-10`
      //   c: upper −0.3 ⇒ 分 **0.0**（被钳制），id `m-00`（更小）
      // k = 2 ⇒ 正确结果 = a + **c**（c 与 b 同分，但 id 更小）。
      // ⚠️ 若不传 `scoreFloor`：第 2 名 = b(0)，剩余 upper = −0.3 ⇒ `−0.3 < 0` ⇒ **提前停**
      //   ⇒ 丢掉 c ⇒ survivors 变成 a + b ⇒ **条数、分数全对，只有 id 错**（最阴的一类）。
      const entries: PruneEntry[] = [
        exactEntry('m-09', 0.5), // upper 0.5 ⇒ 分 0.5
        exactEntry('m-10', -0.05), // upper −0.05 ⇒ 分 **0**（被钳制），id 更大
        exactEntry('m-00', -0.3), // upper −0.3 ⇒ 分 **0**（被钳制），id 更小
      ];
      const scoreOf = (id: string): number => {
        const raw = id === 'm-09' ? 0.5 : id === 'm-10' ? -0.05 : -0.3;
        return Math.min(1, Math.max(0, raw)); // = clampCos
      };

      // ① 传 `scoreFloor: 0`（生产的两条路都这么传）⇒ 正确
      const correct = pruneTopK(entries, { query, k: 2, scoreFloor: 0, scoreOf });
      expect(correct.survivors.map((hit) => hit.id)).toEqual(['m-09', 'm-00']);

      // ② 负控：不传 ⇒ **丢行**（这条把「为什么必须有这个选项」钉在测试里，而不是注释里）
      const buggy = pruneTopK(entries, { query, k: 2, scoreOf });
      expect(buggy.survivors.map((hit) => hit.id)).toEqual(['m-09', 'm-10']);
      expect(buggy.survivors.map((hit) => hit.score)).toEqual(
        correct.survivors.map((hit) => hit.score),
      );
    });
  });

  describe('★ `threshold` 只剪**上界**（不是精确分）', () => {
    it('上界低于门槛 ⇒ 跳过（不读）；上界够而精确分不够 ⇒ **能**进来占位（门槛归下游）', () => {
      // a：上界 1.0（过门槛）但精确分 0.1（下游会滤掉）
      // b：上界 0.5（< 门槛 0.92）⇒ 直接被剪
      const weak: CodedEntry = {
        kind: 'coded',
        id: 'a',
        code: Uint8Array.from([1, 0, 0, 0]),
        codeWidth: 'int8',
        scale: 1,
        eps: 0,
      };
      const below: CodedEntry = {
        kind: 'coded',
        id: 'b',
        code: Uint8Array.from([0.5, 0, 0, 0]),
        codeWidth: 'int8',
        scale: 1,
        eps: 0,
      };
      const entries: PruneEntry[] = [weak, below];
      const out = pruneTopK(entries, {
        query,
        k: 5,
        threshold: 0.92,
        scoreOf: () => 0.1, // 精确分远低于门槛
      });
      // ⚠️ **`a` 进来了**：门槛只作用在 `upper` 上；按精确分剔会变成「第二份 θ 实现」
      expect(out.survivors.map((hit) => hit.id)).toEqual(['a']);
    });
  });

  describe('★ `exactRescoreBudget`：预算用尽 ⇒ 撤回剪枝，**结果不变**（只多付 IO）', () => {
    /** 造 `total` 条「分数单调下降」的有码行（`id` 反序，顺便测同分/定序）。 */
    function descendingEntries(total: number): PruneEntry[] {
      const entries: PruneEntry[] = [];
      for (let index = 0; index < total; index += 1) {
        const value = 1 - index / total;
        entries.push({
          kind: 'coded',
          id: `m-${String(total - index).padStart(4, '0')}`,
          code: Uint8Array.from([Math.round(value * 127), 0, 0, 0]),
          codeWidth: 'int8',
          scale: 1 / 127,
          eps: 1e-9,
        });
      }
      return entries;
    }

    it(`写路径预算（${String(WRITE_EXACT_RESCORE_BUDGET)}）用尽时，结果与全量精确参照逐位相同`, () => {
      const total = WRITE_EXACT_RESCORE_BUDGET + 20;
      const entries = descendingEntries(total);
      const scoreOf = scoreTableOf(entries);
      const out = pruneTopK(entries, {
        query,
        k: 5,
        exactRescoreBudget: WRITE_EXACT_RESCORE_BUDGET,
        scoreOf,
      });
      const reference = referenceTopK(entries as (PruneEntry & { kind: 'coded' })[], 5);
      expect(out.survivors.map((hit) => hit.id)).toEqual(reference.map((hit) => hit.id));
      for (let index = 0; index < reference.length; index += 1) {
        expect(Object.is(out.survivors[index]?.score, reference[index]?.score)).toBe(true);
      }
      // ⚠️ 预算用尽 ⇒ `exactReads` 会 > 预算（这是**可观测的退化信号**，
      //   不是错误：`exactReads / candidates` 就是出关条件①的剪枝率）
      expect(out.exactReads).toBeLessThanOrEqual(total);
    });

    it('★ **不传**预算（`undefined`）= 无预算：早停可以撑到 64 条**之后**才停（写路径预算做不到）', () => {
      // ⚠️ 本条钉的是「读路径不传预算」这个裁决的**观测面**（T04 收尾）：
      //   若有人把缺省值写成 `?? WRITE_EXACT_RESCORE_BUDGET`（= 让 `undefined` 等价于 64），
      //   本条会红 —— 读路径 `k = VECTOR_TOPK × 3 = 60` 时那个 64 会让剪枝名存实亡。
      //
      // 夹具（**必须让早停点落在 64 之后**，否则两种配置的 `exactReads` 分不开）：
      //   · 99 条「上界宽、精确分低」的行：`scale = 0.5`、`eps = 0.4` ⇒ `upper = 0.9`、分 = 0.5；
      //   · 100 条「上界窄」的行：`scale = 0.1`、`eps = 0` ⇒ `upper = 0.1`、分 = 0.1；
      //   · `k = 5` ⇒ 前 99 条读完后第 5 名 = 0.5，剩余最大上界 = 0.1 < 0.5 ⇒ **在队列尾之前停**。
      //   ⇒ 无预算：`exactReads = 99`（> 64，**且没扫完**）；
      //   ⇒ 预算 64：读到第 64 条时预算用尽 ⇒ 撤回剪枝 ⇒ `exactReads = 199`（扫完）。
      const entries: PruneEntry[] = [];
      for (let index = 0; index < 99; index += 1) {
        entries.push({
          kind: 'coded',
          id: `h-${String(index).padStart(3, '0')}`,
          code: Uint8Array.from([1, 0, 0, 0]),
          codeWidth: 'int8',
          scale: 0.5,
          eps: 0.4,
        });
      }
      for (let index = 0; index < 100; index += 1) {
        entries.push({
          kind: 'coded',
          id: `l-${String(index).padStart(3, '0')}`,
          code: Uint8Array.from([1, 0, 0, 0]),
          codeWidth: 'int8',
          scale: 0.1,
          eps: 0,
        });
      }
      const scoreOf = scoreTableOf(entries);

      // ① 无预算（读路径）：早停真的在 99 处停住 —— **明显超过 64**，且没扫完
      const unbudgeted = pruneTopK(entries, { query, k: 5, scoreOf });
      expect(unbudgeted.exactReads).toBe(99);
      // ② 写路径预算（64）：同样的输入 ⇒ 预算用尽、撤回剪枝 ⇒ 扫完（**结果仍然相同**）
      const budgeted = pruneTopK(entries, {
        query,
        k: 5,
        exactRescoreBudget: WRITE_EXACT_RESCORE_BUDGET,
        scoreOf,
      });
      expect(budgeted.exactReads).toBe(entries.length);
      // ③ 两者结果**逐位相同**（预算只影响 IO，不影响结果集）
      expect(budgeted.survivors).toEqual(unbudgeted.survivors);
      expect(unbudgeted.survivors.map((hit) => hit.id)).toEqual([
        'h-000',
        'h-001',
        'h-002',
        'h-003',
        'h-004',
      ]);
    });

    it('`exactRescoreBudget` 只接受「有限非负整数」或 `undefined`：`Infinity` / `-1` / `1.5` ⇒ 抛错', () => {
      // ⚠️ **`Infinity` 必须被拒**：「不传」与「传 `Infinity`」表达同一件事
      //   ⇒ 允许第二种写法就会有两套判据（`=== undefined` 与 `Number.isFinite`）必然漂移。
      const entries: PruneEntry[] = [exactEntry('a', 1)];
      const scoreOf = scoreTableOf(entries);
      for (const budget of [Number.POSITIVE_INFINITY, -1, 1.5, Number.NaN]) {
        expect(() =>
          pruneTopK(entries, { query, k: 1, exactRescoreBudget: budget, scoreOf }),
        ).toThrowError(/exactRescoreBudget/);
      }
      // 合法值：`0`（立刻撤回剪枝 ⇒ 逐行精确）
      const out = pruneTopK(entries, { query, k: 1, exactRescoreBudget: 0, scoreOf });
      expect(out.survivors.map((hit) => hit.id)).toEqual(['a']);
      expect(out.exactReads).toBe(1);
    });
  });

  describe('定序：复用 `compareHits`（精确分降序、同分 id 升序）', () => {
    it('乱序输入 ⇒ survivors 仍按 `compareHits` 出队', () => {
      const entries: PruneEntry[] = [
        exactEntry('m-03', 0.2),
        exactEntry('m-01', 1),
        exactEntry('m-02', 0.2),
      ];
      const out = pruneTopK(entries, { query, k: 3, scoreOf: scoreTableOf(entries) });
      expect(out.survivors.map((hit) => hit.id)).toEqual(['m-01', 'm-02', 'm-03']);
      // 复核：与 `compareHits` 排出来的完全一致（不自立第二套顺序）
      const expected = [...out.survivors].sort(compareHits).map((hit) => hit.id);
      expect(out.survivors.map((hit) => hit.id)).toEqual(expected);
    });
  });
});

/**
 * ★★★ **T08 · A2：int8 的 `CodedEntry` 走的是 `approxDot` 原路**
 * （规格 `docs/design/perf-c2-codewidth-int4-wiring.md` §2.2 的「第 3 道」· §6 的 A2）。
 *
 * ★★ **这一组断言的判据有两层，缺一不可**：
 *
 * | 层 | 断言 | 抓什么 |
 * |---|---|---|
 * | ① | ★ **间谍观测**：int8 的 entry **只调 `approxDot`**、**一次都不调 `approxDotWithWidth`** | ★ **「有人把 int8 切到新分支」**（★ 唯一能抓它的一层） |
 * | ② | ★ **早停决策逐位相同**（`exactReads` + `survivors` 的 id 序） | ★ **上界的值变了哪怕 1 ulp** |
 *
 * ⚠️ ★ **为什么 ① 不可省**：`approxDotWithWidth` 的 int8 分支与 `approxDot` **逐位相同**（A1 已证）
 *   ⇒ ⇒ **只靠 ② 的话，有人把 int8 切到新分支，这一层照样绿**
 *   ⇒ ⇒ ⇒ 必须有 ①（**观测「生产路径到底调了谁」**）。
 * ⚠️ ★ **为什么 ② 不可省**：① 只证明「调了谁」，不证明「算对了」⇒ ⇒ 两者互补。
 */
describe('★ A2 · int8 走 `approxDot` 原路（★ 生产 int8 路径永不经过那个慢分支）', () => {
  /** 把打包字节零拷贝地看成 int8（★ 与 `prune.ts` 的 `signedViewOf()` 同一手法）。 */
  function int8ViewOf(code: Uint8Array): Int8Array {
    return new Int8Array(code.buffer, code.byteOffset, code.byteLength);
  }

  /**
   * 用 `approxDot`（★ 原函数）手算一遍「上界 + 早停」的决策 —— 作为参照物。
   *
   * ⚠️ **刻意不复用 `pruneTopK`**（★ 那就是「生产代码 == 生产代码」⇒ 测不出东西）。
   * ⚠️ **判据是「早停决策」**：`exactReads`（读了几条）+ `survivors` 的 id 序
   *   ⇒ ★ **最灵的判据**：★ 只要上界的值变了哪怕 1 ulp，早停的「剩余上界 < 第 K 名」
   *   比较就可能翻转 ⇒ ⇒ `exactReads` 或 survivors 顺序变 ⇒ 红。
   *
   * @param entries 有码条目
   * @param k 取前 k 条
   * @returns 参照的早停决策
   */
  function referenceEarlyStop(
    entries: readonly (PruneEntry & { kind: 'coded' })[],
    k: number,
  ): { exactReads: number; survivors: string[] } {
    // ① 上界（★ 用 `approxDot` 原函数 —— 这就是「改前」的那条路）
    const queued = entries.map((entry) => ({
      id: entry.id,
      upper: approxDot(query, int8ViewOf(entry.code), entry.scale) + entry.eps,
    }));
    // ② 排序：上界降序、同上界 id 升序
    queued.sort((left, right) => {
      if (left.upper !== right.upper) {
        return right.upper - left.upper;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    // ③ 精确重排 + 严格小于早停（★ `scoreFloor` 缺省 = 无下界 ⇒ 判据就是裸 `upper`）
    const scores = new Map(entries.map((entry) => [entry.id, exactOf(entry)]));
    const best: PruneHit[] = [];
    let exactReads = 0;
    for (const item of queued) {
      if (best.length >= k) {
        // 第 k 名 = 堆里最差的那一个
        const worst = best.reduce((left, right) => (compareHits(left, right) > 0 ? left : right));
        if (item.upper < worst.score) {
          break;
        }
      }
      exactReads += 1;
      const score = scores.get(item.id);
      if (score === undefined) {
        continue;
      }
      best.push({ id: item.id, score });
      best.sort(compareHits);
      if (best.length > k) {
        best.pop();
      }
    }
    return { exactReads, survivors: best.map((hit) => hit.id) };
  }

  it('★ ① int8 只调 `approxDot`（★ 一次都不碰 `approxDotWithWidth`）② 早停决策逐位相同', () => {
    vi.mocked(approxDot).mockClear();
    vi.mocked(approxDotWithWidth).mockClear();

    // 夹具（★ 与「断言 1c」同形）：40 条「上界宽、精确分低」+ 5 条「上界窄」
    //   ⇒ `k = 3` ⇒ 堆会满 ⇒ **早停真的发生**（否则下面那条逐位比较会变成恒绿）。
    const entries: PruneEntry[] = [];
    for (let index = 0; index < 40; index += 1) {
      entries.push({
        kind: 'coded',
        id: `w-${String(index).padStart(3, '0')}`,
        code: Uint8Array.from([1, 0, 0, 0]),
        codeWidth: 'int8',
        scale: 0.5,
        eps: 0.4,
      });
    }
    for (let index = 0; index < 5; index += 1) {
      entries.push({
        kind: 'coded',
        id: `n-${String(index).padStart(3, '0')}`,
        code: Uint8Array.from([1, 0, 0, 0]),
        codeWidth: 'int8',
        scale: 0.1,
        eps: 0,
      });
    }
    const coded = entries as (PruneEntry & { kind: 'coded' })[];
    const out = pruneTopK(entries, { query, k: 3, scoreOf: scoreTableOf(entries) });

    // ── ① 间谍观测（★ 必须在参照物之前断言：参照物自己也会调 `approxDot`）──
    expect(approxDotWithWidth).not.toHaveBeenCalled();
    expect(approxDot).toHaveBeenCalledTimes(coded.length);

    // ── ② 早停决策与「手算参照」逐位相同 ──
    const reference = referenceEarlyStop(coded, 3);
    expect(out.exactReads).toBe(reference.exactReads);
    expect(out.survivors.map((hit) => hit.id)).toEqual(reference.survivors);
    // ⚠️ 负控：早停真的发生了（`exactReads` 明显小于候选总数）⇒ 否则上面两条是恒绿
    expect(out.exactReads).toBeLessThan(entries.length);
    expect(out.exactReads).toBeGreaterThan(0);
  });

  it('★ 负控：int4 的 entry **确实**走 `approxDotWithWidth`（★ 证明间谍接上了线）', () => {
    // ⚠️ **没有这一条，上面那条 `not.toHaveBeenCalled()` 就是恒绿**（间谍没接上也绿）
    //   ⇒ ⇒ 必须证明「分派真的按码宽走」⇒ ⇒ int4 必须落到新分支。
    vi.mocked(approxDot).mockClear();
    vi.mocked(approxDotWithWidth).mockClear();

    // ★ int4：两维一字节 ⇒ 4 维的 int4 码是 **2 字节**（★ `query` 是 4 维）
    const int4Entry: CodedEntry = {
      kind: 'coded',
      id: 'x-000',
      code: Uint8Array.from([0x01, 0x00]),
      codeWidth: 'int4',
      scale: 1,
      eps: 0,
    };
    pruneTopK([int4Entry], { query, k: 1, scoreOf: () => 0 });

    expect(approxDotWithWidth).toHaveBeenCalledTimes(1);
    expect(approxDot).not.toHaveBeenCalled();
  });
});

/**
 * ★★★ **QA 补强 · A7：`src/vector/prune.ts` 仍是纯函数库**
 * （规格 `docs/design/perf-c2-codewidth-int4-wiring.md` §6 的 A7 · ★ **T08 交付时本条没有任何自动化断言**）。
 *
 * ★ **为什么这条必须有断言（★ 本轮 QA 实测发现的盲区）**：
 *   A7 的判据是「`grep -n "better-sqlite3\|SELECT\|INSERT\|UPDATE\|DELETE" src/vector/prune.ts` ⇒ 零命中」
 *   ⇒ ⇒ **它是一个"人去跑一次 grep"的纪律，不是机器守卫**
 *   ⇒ ⇒ 任何一次「顺手在 `prune.ts` 里 import 一下 db / 写一句 SQL」都**不会被任何测试发现**
 *   ⇒ ⇒ 后果：`scanned` / `bytesRead` 的口径被撕成两处（§5.1 的纪律 ④）⇒ T06 的账没法归因。
 *
 * ⚠️ ★★ **判据必须排除注释行**（★ 这是本条最容易做错的地方）：
 *   `prune.ts` 的**文件头注释里本来就写着** `better-sqlite3` / `UPDATE ...` / `DELETE` / `INSERT`
 *   （★ 那正是「为什么不许用」的纪律说明本身）⇒ ⇒ **裸 grep 一定命中**
 *   ⇒ ⇒ ⇒ 所以本条用 `readCode()`（★ `tests/helpers/sourceScan.ts` ⇒ **涂白注释**、保留字符串）
 *   ⇒ ⇒ ⇒ 判据 = 「**真实代码**里不许出现这些词」。
 *
 * ⚠️ ★ **判据是纯函数**（★ 可喂数据）⇒ ⇒ ⇒ 负控才能证明它**不是恒绿守卫**。
 */
describe('★ A7 · `prune.ts` 仍是纯函数库（★ 真实代码里零命中 better-sqlite3 / SQL）', () => {
  /**
   * ★ **判据（纯函数 · 可喂数据）**：在一段**已涂白注释**的源码里找「越界」的词。
   *
   * ⚠️ **为什么关键词集合正好是设计稿 A7 那一行**：
   *   `better-sqlite3`（能读库）· `SELECT` / `INSERT` / `UPDATE` / `DELETE`（能写 SQL）
   *   ⇒ ⇒ **不多不少** ⇒ 判据不会因为「多查一个词」而误报，也不会因为「少查一个词」而漏。
   *
   * @param code 已涂白注释的源码
   * @returns 命中的「行号 + 词」（空数组 = 干净）
   */
  function findForbiddenTokens(code: string): Array<{ line: number; token: string }> {
    const pattern = /better-sqlite3|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/g;
    const hits: Array<{ line: number; token: string }> = [];
    code.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        hits.push({ line: index + 1, token: match[0] });
      }
    });
    return hits;
  }

  it('★ 真实仓库：`src/vector/prune.ts` 的**真实代码**里零命中（★ 注释已被涂白，不算）', () => {
    // ⚠️ ★ **负控（分母不许为 0）**：文件必须真的读得到、且**确实含注释**
    //   ⇒ ⇒ 否则「扫描 0 行 ⇒ 零命中」会是一条**恒绿**的空气断言。
    const raw = readRaw('src/vector/prune.ts');
    expect(raw.length).toBeGreaterThan(0);
    // ★ 注释里**确实**有 `better-sqlite3`（★ 纪律说明本身）⇒ ⇒ 「涂白」这一步真的在干活。
    expect(raw).toContain('better-sqlite3');

    const hits = findForbiddenTokens(readCode('src/vector/prune.ts'));
    expect(hits).toEqual([]);
  });

  it('★ 负控：同一套判据喂「真的写了 SQL」的源码 ⇒ **必须报出来**（★ 证明它不是恒绿守卫）', () => {
    const evil = [
      "import Database from 'better-sqlite3';",
      "const stmt = db.prepare('SELECT id FROM vector_codes');",
      "db.prepare('DELETE FROM vector_codes').run();",
    ].join('\n');
    const hits = findForbiddenTokens(evil);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.map((hit) => hit.token)).toContain('better-sqlite3');
    expect(hits.map((hit) => hit.token)).toContain('SELECT');
    expect(hits.map((hit) => hit.token)).toContain('DELETE');
  });

  it('★ 负控：注释里写了这些词 ⇒ **不报**（★ 证明判据真的排除了注释行）', () => {
    // ⚠️ **这条是「涂白」这一步的机器背书**：不涂白的话 ⇒ 下面这行就会命中
    //   ⇒ ⇒ 「零命中」就永远达不到 ⇒ ⇒ 守卫要么恒红、要么被人加豁免 ⇒ ⇒ 失去牙齿。
    const onlyComment = [
      '// 不 import better-sqlite3、不写 SELECT / INSERT / UPDATE / DELETE',
      'export const x = 1;',
    ].join('\n');
    expect(findForbiddenTokens(blankComments(onlyComment))).toEqual([]);
  });
});

/**
 * ★★★ **QA 补强 · 「零拷贝视图必须带 `byteOffset`」的机器背书**
 * （★ **本轮 QA 实测发现的假绿盲区**：★ 去掉 `byteOffset` ⇒ **全量 2003 个用例照样全绿**）。
 *
 * ★★ **为什么这条极其重要**：
 *   `src/vector/prune.ts` 的 `signedViewOf()` 把打包字节**重解释**成 `Int8Array`
 *   ⇒ ⇒ `new Int8Array(code.buffer, code.byteOffset, code.byteLength)`（★ 三个参数缺一不可）
 *   ⇒ ⇒ **偏移错了** ⇒ 读的是**底层 ArrayBuffer 的第 0 段** ⇒ ★ **不是同一批字节**
 *   ⇒ ⇒ 上界算错 ⇒ ⇒ **漏检**（本档唯一不可接受的失效形状）。
 *
 * ⚠️ ★★ **两种偏移错法的失效形状不同（★ 本条断言把两种都堵住 · ★ QA 实测过）**：
 *   | 变异 | 后果 | 本条的判据 |
 *   |---|---|---|
 *   | `new Int8Array(code.buffer)`（★ 偏移整个丢掉） | 长度变成**整个底层缓冲** ⇒ `approxDot` 的「码与查询等长」守卫 ⇒ **响亮失败**（`MemoryError`） | ★ 变红（抛错） |
 *   | `new Int8Array(code.buffer, 0, code.byteLength)`（★ 偏移写成 0） | 长度**对**、字节**错** ⇒ ⇒ **静默**按另一段字节算上界 ⇒ ⇒ **静默漏检** | ★ 变红（`exactReads` 2 ≠ 1） |
 *   ⇒ ⇒ ★ **只有第二行才是真正危险的形状** ⇒ ⇒ 本条必须能**按值**判红（★ 不许只判「有没有抛错」）。
 *
 * ⚠️ **为什么既有测试抓不住**：★ 既有夹具全部用 `Uint8Array.from([...])` 造码
 *   ⇒ ⇒ 它们的 `byteOffset` **恒为 0** ⇒ ⇒ **丢掉 `byteOffset` 结果一模一样** ⇒ ⇒ 恒绿。
 *   ⇒ ⇒ ⇒ 本条**故意造一个 `byteOffset ≠ 0` 的视图** ⇒ ⇒ 偏移错了就必然被抓住。
 */
describe('★ QA 补强 · 码视图的 `byteOffset` 不可丢（★ 丢了 ⇒ 上界按错的字节算 ⇒ 漏检）', () => {
  it('★ `code` 带非零 `byteOffset` 时，上界必须按**视图自己的字节**算（★ 偏移错了 ⇒ 读错字节）', () => {
    // ── 夹具：一块大缓冲 + 两个**截然不同**的区域 ──
    //   正确区域（偏移 8..11）= [1, 0, 0, 0]  ⇒ 上界 = 1.0
    //   错误区域（偏移 0..3）  = [50, 0, 0, 0] ⇒ 上界 = 50.0（★ 偏移写成 0 就会读到它）
    const backing = new Uint8Array(16);
    backing.set([1, 0, 0, 0], 8);
    backing.set([50, 0, 0, 0], 0);
    const view = new Uint8Array(backing.buffer, 8, 4);
    // ⚠️ **负控**：夹具真的带非零偏移（★ 否则下面两条是恒绿）
    expect(view.byteOffset).toBe(8);
    expect([...view]).toEqual([1, 0, 0, 0]);

    const entries: PruneEntry[] = [
      { kind: 'coded', id: 'offset-view', code: view, codeWidth: 'int8', scale: 1, eps: 0 },
      {
        kind: 'coded',
        id: 'plain',
        code: Uint8Array.from([1, 0, 0, 0]),
        codeWidth: 'int8',
        scale: 5,
        eps: 0,
      },
    ];
    // ⚠️ **上界的对照值**（手算，不复用被测代码）：
    //   `offset-view` 的上界 = query[0] × code[0] × scale = 1 × 1 × 1 = **1**
    //   `plain`       的上界 = 1 × 1 × 5 = **5**
    // ★ 门槛取 **3**：★ 1 < 3 ⇒ `offset-view` 被剪掉；★ 5 ≥ 3 ⇒ `plain` 留下
    //   ⇒ ⇒ 丢掉 `byteOffset` ⇒ `offset-view` 的上界变成 50 ⇒ ≥ 3 ⇒ **它会被留下** ⇒ 本条变红。
    const out = pruneTopK(entries, {
      query,
      k: 2,
      threshold: 3,
      scoreOf: (id) => (id === 'plain' ? 0.5 : 0.1),
    });

    expect(out.exactReads).toBe(1);
    expect(out.survivors.map((hit) => hit.id)).toEqual(['plain']);

    // ⚠️ **负控**：门槛放宽到 0.5 ⇒ 两条都该留下（★ 证明上一条不是因为「这条根本进不来」）
    const loose = pruneTopK(entries, {
      query,
      k: 2,
      threshold: 0.5,
      scoreOf: (id) => (id === 'plain' ? 0.5 : 0.1),
    });
    expect(loose.exactReads).toBe(2);
    expect(loose.survivors.map((hit) => hit.id).sort()).toEqual(['offset-view', 'plain']);
  });
});
