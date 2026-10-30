/**
 * 确定性的内存适配器 —— **测试夹具**，不是 v1.0 参考实现。
 *
 * ⚠️ 它存在的唯一理由：让 golden 采集器 / 比对器在阶段 0 就有一条**可运行的**链路
 *   （P0-T03 的验收是「比对机制可用」，不是「基线已达成」）。
 *   ⇒ 它**刻意不实现**任何 v2.1 机制（无共激活、无侧抑制、无分桶、无簇），
 *     因此「换开关不会改变它的输出」是**当前阶段的正确结果**，而不是假绿。
 *   ⚠️ 它**不是** v1.0 的行为模型——真正的参考实现归 P1-T09。
 *
 * ⚠️ 全部输出**确定**：id 顺序生成、时间用注入时钟、无随机数、无 `Date.now()`。
 */

import type { RefV1Adapter, RefV1WriteInput, RefV1WriteOutput } from '../../baseline/ref-v1.js';

interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  entities: string[];
  stability: number;
  accessCount: number;
  createdAt: number;
  lastAccess: number;
}

/** 确定性的内存实现（固定时钟、顺序 id）。 */
export class DeterministicAdapter implements RefV1Adapter {
  readonly #rows = new Map<string, MemoryRow>();
  #counter = 0;

  constructor(private readonly baseTime = 1_700_000_000_000) {}

  write(input: RefV1WriteInput): RefV1WriteOutput {
    this.#counter += 1;
    const id = `m${this.#counter}`;
    this.#rows.set(id, {
      id,
      content: input.content,
      kind: input.kind ?? 'fact',
      entities: [...(input.entities ?? [])].sort(),
      stability: 1,
      accessCount: 0,
      createdAt: this.baseTime,
      lastAccess: this.baseTime,
    });
    return { id };
  }

  recall(options: { context: string; topN?: number }): unknown {
    const topN = options.topN ?? 5;
    const hits = [...this.#rows.values()]
      .filter((row) => row.content.includes(options.context.slice(0, 2)))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .slice(0, topN)
      .map((row) => ({ id: row.id, score: 1 }));
    return { hits, topN };
  }

  touch(ids: string[], now?: number): unknown {
    const at = now ?? this.baseTime;
    const touched: string[] = [];
    for (const id of ids) {
      const row = this.#rows.get(id);
      if (row === undefined) {
        continue;
      }
      row.accessCount += 1;
      row.lastAccess = at;
      touched.push(id);
    }
    return { touched, count: touched.length };
  }

  get(id: string, now?: number): unknown {
    const row = this.#rows.get(id);
    if (row === undefined) {
      return null;
    }
    const at = now ?? this.baseTime;
    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      entities: [...row.entities],
      stability: row.stability,
      accessCount: row.accessCount,
      createdAt: row.createdAt,
      lastAccess: at,
      deleted: false,
    };
  }

  stats(now?: number): unknown {
    const at = now ?? this.baseTime;
    return {
      count: this.#rows.size,
      asOf: at,
      memories: [...this.#rows.values()]
        .map((row) => ({ id: row.id, stability: row.stability, accessCount: row.accessCount }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    };
  }
}

/** CLI 用的工厂（`scripts/capture-golden.ts` 通过它拿到适配器）。 */
export function createAdapter(): RefV1Adapter {
  return new DeterministicAdapter();
}
