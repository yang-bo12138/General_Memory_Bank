#!/usr/bin/env tsx
/**
 * 打分权重的**真实查询回归** —— DESIGN-v2.md §12.1 ①②，对应 DEVELOPMENT-PLAN.md **P4-T08**。
 *
 * ⚠️ **golden 里锁的是「语料序号」（`c0` / `c7` …）而不是 uuid**：
 *   记忆 id 是写入时生成的 uuid ⇒ **每次重建语料都不同** ⇒ 直接锁 uuid 会让 golden
 *   **每次运行都红**（那是一条恒红的守卫，比恒绿更难被注意到）。
 *   ⇒ 用「这条记忆在语料快照里的序号」当稳定标识 ⇒ **语义等价于锁 id，且可复现**。
 *
 * ★ **只锁 top-N 的 id 序列，不断言 score 绝对值，也不断言 `rawBm25` / `cos`**（§12.1 的原文理由）：
 *   FTS5 的 `bm25` 依赖语料统计量 `total_docs` / `avgdl`，**每写入一条新记忆这两个量就变**
 *   ⇒ `raw_bm25 → medianBm25 → normBm25` 全链路漂移。这是 v1.0 就有的性质，不是新机制引入的。
 *   ⇒ **排序才是稳定契约，score 绝对值不是。**
 *
 * ★ **回归集按「语料快照 + embeddedRatio 档位」双重分档**（`golden/<corpus>/<ratio>/`）：
 *   embeddedRatio 会改变「有多少条记忆能进向量路」⇒ 排序结果**本来就该不同**
 *   ⇒ 把两个档位混在一份 golden 里，等于要求「同一个排序在两种能力覆盖下都成立」——那是错的。
 *
 * ⚠️ **本任务的产出是「回归报告」，不是「改权重」**（§4.6 步骤 3 的原文）：
 *   那五个权重「从未用真实查询回归过」，但**改权重是一次设计变更，应走 ADR**，不是运行时配置。
 *
 * 用法：
 * ```bash
 * pnpm exec tsx bench/regression/weights.ts            # 比对（不一致 ⇒ exit 1）
 * pnpm exec tsx bench/regression/weights.ts --capture  # 重新采集 golden
 * ```
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryStore } from '../../src/store/MemoryStore.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_ROOT = join(HERE, 'golden');

/** 语料快照的标识（**换语料必须换 id**，否则 golden 会张冠李戴）。 */
export const CORPUS_ID = 'corpus-a';

/** `embeddedRatio` 的两个档位（百分比整数 ⇒ 目录名稳定、可排序）。 */
export const RATIO_BUCKETS = [100, 50] as const;

/** 一条 golden 记录（**只有 id 序列**：没有 score、没有 rawBm25、没有 cos）。 */
export interface GoldenRecord {
  corpus: string;
  ratio: number;
  query: string;
  ids: string[];
}

/** 固定语料（**内容与顺序都写死** ⇒ 「语料快照」才真的是一份快照）。 */
const CORPUS: readonly { content: string; entities: string[] }[] = [
  { content: '张三住在上海', entities: ['张三', '上海'] },
  { content: '张三喜欢猫', entities: ['张三', '猫'] },
  { content: '张三在腾讯工作', entities: ['张三', '腾讯'] },
  { content: '李四住在北京', entities: ['李四', '北京'] },
  { content: '李四养了一只狗', entities: ['李四', '狗'] },
  { content: '上海今天下雨', entities: ['上海'] },
  { content: '北京今天刮风', entities: ['北京'] },
  { content: '猫喜欢晒太阳', entities: ['猫'] },
  { content: '狗需要每天遛', entities: ['狗'] },
  { content: '腾讯的总部在深圳', entities: ['腾讯', '深圳'] },
  { content: '她不喜欢猫粮', entities: ['她', '猫粮'] },
  { content: '他每天跑步五公里', entities: ['他'] },
];

/**
 * 固定查询（与语料**逐字同源** ⇒ 命中与否可人工核对）。
 *
 * ⚠️ **刻意用「语料里真实出现的片段」而不是自然问句**：FTS5 的匹配查询是**按 token 全含**构造的
 *   ⇒ 「谁养了狗」这种问句会一个 token 都对不上 ⇒ 返回空数组
 *   ⇒ 而**一整套空结果**的 golden 是**恒绿的**（任何改动都「通过」）⇒ 那等于没有回归。
 *   ⇒ 本文件还配一条断言：**至少一条查询必须命中**（`tests/contracts/weights-regression.test.ts`）。
 */
const QUERIES: readonly string[] = [
  '张三住在上海',
  '她不喜欢猫粮',
  '北京今天刮风',
  '腾讯的总部在深圳',
  '狗需要每天遛',
];

/** 确定性伪随机（**不使用 Math.random**：golden 必须可复现）。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** 造一个确定性向量（`EMBED_DIM` 维、L2 归一化）。 */
function vectorFor(text: string, dim: number): number[] {
  const next = seeded(
    [...text].reduce((accumulator, char) => (accumulator * 31 + char.charCodeAt(0)) >>> 0, 7),
  );
  const raw = Array.from({ length: dim }, () => next() - 0.5);
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

/**
 * 建库并写入语料（`ratio` 决定多少条记忆带向量）。
 *
 * @param dbPath 临时库路径
 * @param ratio 带向量的比例（百分比）
 * @returns 已关闭的库（调用方随后可直接 `new MemoryStore` 打开）
 */
export function seedCorpus(dbPath: string, ratio: number): Map<string, number> {
  const dim = 768;
  const store = new MemoryStore({ dbPath });
  const idToIndex = new Map<string, number>();
  try {
    const withEmbedding = Math.round((CORPUS.length * ratio) / 100);
    CORPUS.forEach((item, index) => {
      const written = store.write({
        content: item.content,
        entities: item.entities,
        ...(index < withEmbedding ? { embedding: vectorFor(item.content, dim) } : {}),
      });
      idToIndex.set(written.id, index);
    });
  } finally {
    store.close();
  }
  return idToIndex;
}

/** 语料序号 → golden 里的稳定标签。 */
export function labelOf(index: number): string {
  return `c${String(index)}`;
}

/**
 * 采集一组 golden 记录（**只记 id 序列**）。
 *
 * @param dbPath 已 seed 好的库
 * @param ratio 该库的 embeddedRatio 档位
 */
export function capture(
  dbPath: string,
  ratio: number,
  idToIndex: ReadonlyMap<string, number>,
): GoldenRecord[] {
  const dim = 768;
  const store = new MemoryStore({ dbPath });
  try {
    return QUERIES.map((query) => {
      const result = store.recall({
        context: query,
        queryEmbedding: vectorFor(query, dim),
        topN: 5,
      });
      return {
        corpus: CORPUS_ID,
        ratio,
        query,
        // ⚠️ 认不出的 id ⇒ 显式标 `unknown`（**不静默丢弃**：那会让「少了一条」看起来像「排序变了」）
        ids: result.hits.map((hit) => {
          const index = idToIndex.get(hit.id);
          return index === undefined ? 'unknown' : labelOf(index);
        }),
      };
    });
  } finally {
    store.close();
  }
}

/** golden 文件路径（`golden/<corpus>/<ratio>/records.json`）。 */
export function goldenPath(ratio: number): string {
  return join(GOLDEN_ROOT, CORPUS_ID, String(ratio), 'records.json');
}

/** 读 golden；不存在 ⇒ `null`。 */
export function readGolden(ratio: number): GoldenRecord[] | null {
  const path = goldenPath(ratio);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GoldenRecord[];
  } catch {
    return null;
  }
}

/** 写 golden。 */
export function writeGolden(ratio: number, records: readonly GoldenRecord[]): string {
  const path = goldenPath(ratio);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  return path;
}

/** 比对（**只比 id 序列**）。 */
export function diffGolden(
  expected: readonly GoldenRecord[],
  actual: readonly GoldenRecord[],
): string[] {
  const problems: string[] = [];
  for (const want of expected) {
    const got = actual.find((item) => item.ratio === want.ratio && item.query === want.query);
    if (got === undefined) {
      problems.push(`缺记录：ratio=${want.ratio} query=${want.query}`);
      continue;
    }
    if (got.ids.join('|') !== want.ids.join('|')) {
      problems.push(
        `排序变了：ratio=${want.ratio} query=${want.query}（expected ${want.ids.join(',')} / actual ${got.ids.join(',')}）`,
      );
    }
  }
  return problems;
}

/** CLI 薄壳。 */
function main(): void {
  const captureMode = process.argv.includes('--capture');
  const root = mkdtempSync(join(tmpdir(), 'gmb-weights-'));
  let failures = 0;

  for (const ratio of RATIO_BUCKETS) {
    const dbPath = join(root, `corpus-${String(ratio)}.db`);
    const idToIndex = seedCorpus(dbPath, ratio);
    const records = capture(dbPath, ratio, idToIndex);

    if (captureMode) {
      const path = writeGolden(ratio, records);
      process.stdout.write(`✅ 已采集 ratio=${String(ratio)} ⇒ ${path}\n`);
      continue;
    }

    const golden = readGolden(ratio);
    if (golden === null) {
      process.stdout.write(`⚠️ ratio=${String(ratio)} 没有 golden（先跑 --capture）⇒ 记一次失败\n`);
      failures += 1;
      continue;
    }
    const problems = diffGolden(golden, records);
    if (problems.length === 0) {
      process.stdout.write(
        `✅ ratio=${String(ratio)}：${String(records.length)} 条查询的 id 序列一致\n`,
      );
    } else {
      failures += problems.length;
      for (const problem of problems) process.stderr.write(`❌ ${problem}\n`);
    }
  }

  rmSync(root, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  ?.replace(/\\/g, '/')
  .endsWith('bench/regression/weights.ts');

if (invokedDirectly) {
  main();
}
