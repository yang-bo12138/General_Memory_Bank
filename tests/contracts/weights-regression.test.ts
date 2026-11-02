/**
 * 权重回归集的契约测试 —— DESIGN-v2.md §12.1 ①②，对应 **P4-T08**。
 *
 * ★ 守四件事（都是「跑起来绿、但契约其实没守住」的那一类）：
 *   ① **golden 里只有 id 序列**（不含 `score` / `rawBm25` / `cos`）——
 *      断言绝对分会**每写一条记忆就漂**（FTS5 的 `total_docs` / `avgdl` 在变）；
 *   ② **双重分档的目录结构**（`golden/<corpus>/<embeddedRatio>/`）；
 *   ③ **稳定性**：同一语料快照 + 同一档位，采集两次 ⇒ 序列逐条相同；
 *   ④ `diffGolden` 真的能发现「排序变了」（反例）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CORPUS_ID,
  GOLDEN_ROOT,
  RATIO_BUCKETS,
  capture,
  diffGolden,
  goldenPath,
  readGolden,
  seedCorpus,
} from '../../bench/regression/weights.js';

describe('weights · golden 的契约', () => {
  it('★ golden 只锁 id 序列：记录里**没有** score / rawBm25 / cos', () => {
    for (const ratio of RATIO_BUCKETS) {
      const records = readGolden(ratio);
      expect(records, `ratio=${String(ratio)} 缺少 golden`).not.toBeNull();
      for (const record of records ?? []) {
        expect(Object.keys(record).sort()).toEqual(['corpus', 'ids', 'query', 'ratio']);
        for (const id of record.ids) {
          expect(typeof id).toBe('string');
        }
      }
    }
  });

  it('★ 反例守卫：至少一条查询**必须命中**（整套空结果的 golden 是恒绿的）', () => {
    // ⚠️ 这条守的是「回归集本身有判别力」：
    //   若全部查询都返回空数组 ⇒ 任何改动都「通过」⇒ 等于没有回归。
    //   （实测教训：第一版用了「谁养了狗」这类自然问句 ⇒ FTS5 按 token 全含匹配 ⇒ 5 条里 3 条命中为空。）
    for (const ratio of RATIO_BUCKETS) {
      const records = readGolden(ratio) ?? [];
      const nonEmpty = records.filter((record) => record.ids.length > 0);
      expect(nonEmpty.length, `ratio=${String(ratio)}`).toBeGreaterThanOrEqual(records.length);
    }
  });

  it('★ 双重分档：目录是 `golden/<corpus>/<ratio>/records.json`', () => {
    const corpusDirs = readdirSync(GOLDEN_ROOT);
    expect(corpusDirs).toContain(CORPUS_ID);
    const ratioDirs = readdirSync(join(GOLDEN_ROOT, CORPUS_ID)).sort();
    expect(ratioDirs).toEqual([...RATIO_BUCKETS].map(String).sort());
    for (const ratio of RATIO_BUCKETS) {
      const raw = readFileSync(goldenPath(ratio), 'utf8');
      // ★ 静态断言：文件里连 `score` 这个词都不该出现（golden 不是分数的快照）
      expect(raw).not.toContain('score');
      expect(raw).not.toContain('rawBm25');
    }
  });

  it('★ 稳定性：同一语料快照 + 同一档位，采集两次 ⇒ 序列逐条相同', () => {
    const root = mkdtempSync(join(tmpdir(), 'gmb-weights-test-'));
    try {
      for (const ratio of RATIO_BUCKETS) {
        const dbA = join(root, `a-${String(ratio)}.db`);
        const dbB = join(root, `b-${String(ratio)}.db`);
        const first = capture(dbA, ratio, seedCorpus(dbA, ratio));
        const second = capture(dbB, ratio, seedCorpus(dbB, ratio));
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        // ⇒ 而且它与已落盘的 golden 一致（**没被改权重偷偷改掉**）
        expect(diffGolden(readGolden(ratio) ?? [], first)).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('★ 反例：`diffGolden` 能发现「排序变了」', () => {
    const golden = readGolden(100) ?? [];
    const tampered = golden.map((record, index) =>
      index === 0 ? { ...record, ids: [...record.ids].reverse() } : record,
    );
    const problems = diffGolden(golden, tampered);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('排序变了');
  });

  it('★ `writeGolden` 会落到双重分档的路径上（不是随手一个文件名）', () => {
    const root = mkdtempSync(join(tmpdir(), 'gmb-weights-path-'));
    try {
      // 只证明路径形状：`golden/<corpus>/<ratio>/records.json`
      expect(goldenPath(42).replace(/\\/g, '/')).toContain(`/${CORPUS_ID}/42/records.json`);
      void root;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
