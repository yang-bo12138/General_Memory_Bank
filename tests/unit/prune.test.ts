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

import { describe, expect, it } from 'vitest';

import { compareHits } from '../../src/vector/flat.js';
import {
  type CodedEntry,
  type PruneEntry,
  type PruneHit,
  WRITE_EXACT_RESCORE_BUDGET,
  pruneTopK,
} from '../../src/vector/prune.js';

/**
 * 造一条「码 + 精确向量」的夹具：`code = [1, 0, 0, 0]`、`scale = score`
 * ⇒ `x = scale × code` ⇒ `q·x = score`（`q = [1,0,0,0]`）。
 *
 * ⚠️ **`eps = 0` 是刻意的**：它让「上界 == 精确分」，于是早停的边界条件
 *   （`upper < 第 k 名` vs `≤`）**恰好落在等号上** ⇒ 「严格小于」这条纪律才有牙。
 * ⚠️ **值走 `scale`、不走 `code`**：`Int8Array` 只能装整数（`Int8Array.from([0.5])` 会静默变成 0）
 *   —— 这条坑在本文件的第一版里真的踩到了（两条用例因此假通过）。
 */
function exactEntry(id: string, score: number): CodedEntry {
  return { kind: 'coded', id, code: Int8Array.from([1, 0, 0, 0]), scale: score, eps: 0 };
}

/** 精确分 = 点积（`‖q‖ = ‖x‖` 的夹具里它就是余弦；本文件不关心归一化）。 */
const query = Float32Array.from([1, 0, 0, 0]);

/** 精确分：`q·x`（其中 `x = scale × code`）。 */
function exactOf(entry: CodedEntry): number {
  let sum = 0;
  for (let index = 0; index < entry.code.length; index += 1) {
    sum += (query[index] as number) * (entry.code[index] as number) * entry.scale;
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
        pruneTopK([{ ...exactEntry('a', 1), code: Int8Array.from([1, 0]) }], {
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
              code: Int8Array.from([1, 0, 0, 0]),
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
          [{ kind: 'coded', id: 'a', code: Int8Array.from([1, 0, 0, 0]), scale: 1, eps: -1e-9 }],
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
        code: Int8Array.from([1, 0, 0, 0]),
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
        code: Int8Array.from([1, 0, 0, 0]),
        scale: 1,
        eps: 0,
      };
      const below: CodedEntry = {
        kind: 'coded',
        id: 'b',
        code: Int8Array.from([0.5, 0, 0, 0]),
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
          code: Int8Array.from([Math.round(value * 127), 0, 0, 0]),
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
          code: Int8Array.from([1, 0, 0, 0]),
          scale: 0.5,
          eps: 0.4,
        });
      }
      for (let index = 0; index < 100; index += 1) {
        entries.push({
          kind: 'coded',
          id: `l-${String(index).padStart(3, '0')}`,
          code: Int8Array.from([1, 0, 0, 0]),
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
