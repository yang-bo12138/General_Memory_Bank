/**
 * 桶归属的**唯一写入点**（`assignBucket` / `unassignBucket`）的单测 ——
 * DEVELOPMENT-PLAN.md **P2-T03-a** 的硬断言（DESIGN-v2.md §9.3.0 / §4.15.5）。
 *
 * ★ 本文件的断言纪律（沿用阶段 0~2 的口径）：
 *   · **硬断言逐条对应计划稿**，每条都能被变异打红；
 *   · **参考实现自己手写**（归属的期望值用 `assignFineBucket` 现算，不抄生产代码的 SQL）；
 *   · **夹具用的是 §3 的权威 DDL**（真库 ⇒ 外键 / 唯一索引这些约束验得了）。
 *
 * ⚠️ **本测试文件是 `vector_cell_members` 的「第二写点」**（测试夹具要手工造数据）：
 *   它在 `tests/` 下，**不在 `src/` 下** ⇒ 不违反 §9.3.0 的「唯一写入点」
 *   （那条铁律的管辖范围是生产代码；静态扫描断言只扫 `src/**`）。
 *   ⇒ 凡是能靠 `assignBucket` 造出来的数据，本文件都**不**手工 INSERT。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MemoryError } from '../../src/core/errors.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import {
  type BucketAssignContext,
  assignBucket,
  countBucketMembers,
  listBucketMemberCounts,
  unassignBucket,
} from '../../src/vector/bucketAssign.js';
import { CentroidCache, type IvfCentroidModel } from '../../src/vector/centroids.js';
import { assignFineBucket, trainCentroids } from '../../src/vector/ivf.js';
import {
  createTestDb,
  insertMemories,
  insertMemory,
  pseudoUnitVector,
} from '../fixtures/vector.js';

/** 一个固定的时间基准。 */
const T0 = 1_700_000_000_000;

/**
 * 训练与运行期共用的探针数。
 *
 * ⚠️ **必须一致**（§4.15.3）：训练期与运行期用同一套规则
 *   ⇒ 训练算出的归属与写入算出的归属一致 ⇒ 不会产生无谓的桶 churn。
 */
const NPROBE = 2;

/** 夹具。 */
interface Fixture {
  db: Database.Database;
  ids: string[];
  vectors: Float32Array[];
  model: IvfCentroidModel;
  context: BucketAssignContext;
  /** 训练期算出的归属（与输入同序）。 */
  trainedFineIds: Array<string | null>;
}

/**
 * 建一个「已训练 + 有中心缓存」的夹具。
 *
 * ⚠️ **走真实加载路径**：中心模型用 `CentroidCache`（⇒ 真的从库里读 `vector_fine_cells`），
 *   不是把训练结果直接塞进上下文 ⇒ 这样「库里没有桶 ⇒ 没有归属」这条也验得到。
 */
function createFixture(options?: {
  count?: number;
  coarseCenters?: number;
  fineCenters?: number;
}): Fixture {
  const db = createTestDb();
  const count = options?.count ?? 40;
  const vectors: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    vectors.push(pseudoUnitVector(index + 1));
  }
  const ids = insertMemories(db, vectors);

  const result = trainCentroids(db, {
    coarseCenters: options?.coarseCenters ?? 4,
    fineCenters: options?.fineCenters ?? 12,
    maxIterations: 5,
    nprobeCoarse: NPROBE,
    now: T0,
  });

  const cache = new CentroidCache(db);
  const context: BucketAssignContext = {
    db,
    centroids: () => cache.model(),
    nprobeCoarse: NPROBE,
  };
  return { db, ids, vectors, model: result.model, context, trainedFineIds: result.fineBucketIds };
}

/** 取第 n 项（越界 ⇒ 抛错，不给「静默 undefined」留口子）。 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`夹具越界：index=${index}，length=${items.length}`);
  }
  return item;
}

/** 某条记忆在 `vector_cell_members` 里的行数。 */
function countMembershipRows(db: Database.Database, memoryId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM vector_cell_members WHERE memory_id = ?')
    .get(memoryId) as { count: number };
  return row.count;
}

/** 某条记忆当前的桶归属（`null` = 没有归属）。 */
function membershipOf(db: Database.Database, memoryId: string): string | null {
  const row = db
    .prepare('SELECT fine_id FROM vector_cell_members WHERE memory_id = ?')
    .get(memoryId) as { fine_id: string } | undefined;
  return row?.fine_id ?? null;
}

/** 某个桶里的成员 id 列表。 */
function membersOf(db: Database.Database, fineId: string): string[] {
  const rows = db
    .prepare('SELECT memory_id FROM vector_cell_members WHERE fine_id = ?')
    .all(fineId) as Array<{ memory_id: string }>;
  return rows.map((row) => row.memory_id);
}

/** 断言某个桶 id 非空（把 `string | null` 收窄成 `string`）。 */
function mustFineId(value: string | null): string {
  if (value === null) {
    throw new Error('预期有桶归属，实际为 null');
  }
  return value;
}

/** 库里某条记忆的行数。 */
function countMemoryRows(db: Database.Database, memoryId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(memoryId) as {
    count: number;
  };
  return row.count;
}

/**
 * 从夹具里挑出**落在不同细桶**的两条向量（用于「换桶」场景）。
 *
 * ⚠️ **不写死哪两个**：训练结果随参数变 ⇒ 写死 id 就会变成「测的是夹具常量，不是机制」。
 */
function pickDifferentBuckets(fixture: Fixture): {
  fromId: string;
  fromVector: Float32Array;
  toVector: Float32Array;
} {
  for (let index = 0; index < fixture.vectors.length; index += 1) {
    const fromVector = at(fixture.vectors, index);
    const fromFine = assignFineBucket(fixture.model, fromVector, NPROBE);
    for (let other = index + 1; other < fixture.vectors.length; other += 1) {
      const toVector = at(fixture.vectors, other);
      const toFine = assignFineBucket(fixture.model, toVector, NPROBE);
      if (fromFine !== null && toFine !== null && fromFine !== toFine) {
        return { fromId: at(fixture.ids, index), fromVector, toVector };
      }
    }
  }
  throw new Error('夹具里找不到落在不同细桶的两条向量（分桶太粗 ⇒ 测试前提不成立）');
}

describe('P2-T03-a · 桶归属的唯一写入点（assignBucket / unassignBucket）', () => {
  describe('硬断言：回滚测试（同事务内抛错 ⇒ 记忆行与归属行同时回滚）', () => {
    it('★ 同事务内人为抛错 ⇒ memories 行与 vector_cell_members 行同时回滚（都查不到）', () => {
      const fixture = createFixture({ count: 10 });
      const newId = 'm-rollback';
      const vector = pseudoUnitVector(999);

      expect(() => {
        runWriteTransaction(fixture.db, () => {
          insertMemory(fixture.db, newId, vector);
          assignBucket(fixture.context, newId, vector);
          // ⚠️ 人为抛错 ⇒ 整个事务回滚（§4.15.5：失败即整体回滚 ⇒ 不会出现孤儿归属）。
          throw new Error('人为抛错（模拟事务中途失败）');
        });
      }).toThrow('人为抛错');

      // 性质：记忆行回滚了
      expect(countMemoryRows(fixture.db, newId)).toBe(0);
      // 性质：归属行**也**回滚了（不是「记忆没了、桶行还在」的孤儿）
      expect(countMembershipRows(fixture.db, newId)).toBe(0);
      expect(membershipOf(fixture.db, newId)).toBeNull();
    });

    it('★ 同一事务里连续调用安全（多条记忆的归属都写进去了）', () => {
      const fixture = createFixture({ count: 10 });

      runWriteTransaction(fixture.db, () => {
        for (let index = 0; index < 5; index += 1) {
          assignBucket(fixture.context, at(fixture.ids, index), at(fixture.vectors, index));
        }
      });

      for (let index = 0; index < 5; index += 1) {
        expect(countMembershipRows(fixture.db, at(fixture.ids, index))).toBe(1);
      }
      const counts = listBucketMemberCounts(fixture.db);
      let total = 0;
      for (const count of counts.values()) {
        total += count;
      }
      expect(total).toBe(5);
    });
  });

  describe('硬断言：换桶不残留（§4.15.5 唯一的静默失效点）', () => {
    it('★ 一条记忆换桶后，vector_cell_members 里它的行数 == 1', () => {
      const fixture = createFixture();
      const { fromId, fromVector, toVector } = pickDifferentBuckets(fixture);

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, fromId, fromVector);
      });
      const oldFineId = membershipOf(fixture.db, fromId);
      expect(oldFineId).not.toBeNull();

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, fromId, toVector);
      });
      const newFineId = membershipOf(fixture.db, fromId);

      // 性质：**只有一行**（换桶不残留）
      expect(countMembershipRows(fixture.db, fromId)).toBe(1);
      // 性质：它确实换到新桶了（不是「压根没写」）
      expect(newFineId).not.toBeNull();
      expect(newFineId).not.toBe(oldFineId);
      // 性质：旧桶里不再有它
      expect(membersOf(fixture.db, mustFineId(oldFineId))).not.toContain(fromId);
      expect(membersOf(fixture.db, mustFineId(newFineId))).toContain(fromId);
    });

    it('★ 换桶时唯一索引不被违反（先 DELETE 再 INSERT ⇒ 不会抛 UNIQUE constraint failed）', () => {
      const fixture = createFixture();
      const { fromId, fromVector, toVector } = pickDifferentBuckets(fixture);

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, fromId, fromVector);
      });
      // ⚠️ 若实现是「先 INSERT 新桶、再删旧桶」⇒ 唯一索引会直接挡住 ⇒ 这里抛错。
      expect(() => {
        runWriteTransaction(fixture.db, () => {
          assignBucket(fixture.context, fromId, toVector);
        });
      }).not.toThrow();
      expect(countMembershipRows(fixture.db, fromId)).toBe(1);
    });

    it('★ 说明：唯一索引只是最后一道防线——没有它时「只 INSERT 不 DELETE 旧行」会**静默重复**', () => {
      // ⚠️ **这条测的是「为什么必须 DELETE」**，不是「实现对不对」：
      //   §4.15.5 说「唯一索引让它**写不进去**（而不是静默重复）」
      //   ⇒ 那「静默重复」长什么样？把索引拆掉看一眼。
      const fixture = createFixture();
      const { fromId, fromVector, toVector } = pickDifferentBuckets(fixture);

      // ⚠️ **人为拆掉唯一索引** ⇒ 复现「老库没有这条索引」的情形。
      fixture.db.exec('DROP INDEX idx_vcm_memory_unique');

      const oldFine = assignFineBucket(fixture.model, fromVector, NPROBE);
      const newFine = assignFineBucket(fixture.model, toVector, NPROBE);
      expect(oldFine).not.toBeNull();
      expect(newFine).not.toBe(oldFine);

      runWriteTransaction(fixture.db, () => {
        // ⚠️ **只 INSERT、不 DELETE 旧行**（§4.15.5 点名的错误写法）
        fixture.db
          .prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)')
          .run(oldFine, fromId);
        fixture.db
          .prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)')
          .run(newFine, fromId);
      });

      // 性质：**两行**（一条记忆同时挂两个桶 ⇒ 候选集重复 + 桶计数偏大 ⇒ 静默劣化）
      expect(countMembershipRows(fixture.db, fromId)).toBe(2);

      // 对照：**正确的形状**（先 DELETE 再 INSERT）⇒ 自己就干净了，**不需要**索引来救
      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, fromId, toVector);
      });
      expect(countMembershipRows(fixture.db, fromId)).toBe(1);
    });
  });

  describe('硬断言：未传向量 ⇒ 归属被删（unassignBucket）', () => {
    it('★ unassignBucket 后该 id 不在 vector_cell_members 里，且桶计数 −1', () => {
      const fixture = createFixture({ count: 10 });
      const id = at(fixture.ids, 0);
      const vector = at(fixture.vectors, 0);

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, id, vector);
      });
      const fineId = membershipOf(fixture.db, id);
      expect(fineId).not.toBeNull();
      expect(countBucketMembers(fixture.db, mustFineId(fineId))).toBe(1);

      // ⚠️ 「没传向量（置 NULL）」⇒ 必须 unassignBucket（§4.15.3 第三条）。
      runWriteTransaction(fixture.db, () => {
        unassignBucket(fixture.context, id);
      });

      expect(membershipOf(fixture.db, id)).toBeNull();
      expect(countMembershipRows(fixture.db, id)).toBe(0);
      // 性质：桶计数 −1
      expect(countBucketMembers(fixture.db, mustFineId(fineId))).toBe(0);
    });

    it('★ unassignBucket 幂等（对没有归属的 id 调用不报错）', () => {
      const fixture = createFixture({ count: 10 });
      const id = 'm-never-assigned';

      expect(() => {
        runWriteTransaction(fixture.db, () => {
          unassignBucket(fixture.context, id);
        });
      }).not.toThrow();
      expect(countMembershipRows(fixture.db, id)).toBe(0);
    });
  });

  describe('硬断言：同一桶重复归入不重复', () => {
    it('★ 同一条记忆 assignBucket 两次到同一个桶 ⇒ 表里仍只有 1 行', () => {
      const fixture = createFixture({ count: 10 });
      const id = at(fixture.ids, 0);
      const vector = at(fixture.vectors, 0);

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, id, vector);
      });
      const fineId = membershipOf(fixture.db, id);

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, id, vector);
      });

      expect(countMembershipRows(fixture.db, id)).toBe(1);
      expect(membershipOf(fixture.db, id)).toBe(fineId);
      expect(countBucketMembers(fixture.db, mustFineId(fineId))).toBe(1);
    });

    it('★ COUNT(*) == COUNT(DISTINCT memory_id)（一条记忆只属一个细桶）', () => {
      const fixture = createFixture({ count: 20 });
      runWriteTransaction(fixture.db, () => {
        for (let index = 0; index < 20; index += 1) {
          assignBucket(fixture.context, at(fixture.ids, index), at(fixture.vectors, index));
        }
      });

      const row = fixture.db
        .prepare(
          'SELECT COUNT(*) AS total, COUNT(DISTINCT memory_id) AS distinctCount FROM vector_cell_members',
        )
        .get() as { total: number; distinctCount: number };
      expect(row.total).toBe(row.distinctCount);
      expect(row.total).toBe(20);
    });
  });

  describe('机制：复用 assignFineBucket（同一套规则，不会有第二套词）', () => {
    it('★ assignBucket 归到的桶 == assignFineBucket 现算出来的桶', () => {
      const fixture = createFixture();
      const id = at(fixture.ids, 0);
      const vector = at(fixture.vectors, 0);

      const expected = assignFineBucket(fixture.model, vector, NPROBE);
      const result = runWriteTransaction(fixture.db, () =>
        assignBucket(fixture.context, id, vector),
      );

      expect(expected).not.toBeNull();
      expect(result.fineId).toBe(expected);
      expect(membershipOf(fixture.db, id)).toBe(expected);
      expect(result.assigned).toBe(true);
    });

    it('★ 训练期算出的归属 == 运行期 assignBucket 算出的归属（不产生无谓的桶 churn）', () => {
      const fixture = createFixture();
      runWriteTransaction(fixture.db, () => {
        for (let index = 0; index < fixture.ids.length; index += 1) {
          assignBucket(fixture.context, at(fixture.ids, index), at(fixture.vectors, index));
        }
      });

      fixture.ids.forEach((id, index) => {
        expect(membershipOf(fixture.db, id)).toBe(fixture.trainedFineIds[index]);
      });
    });

    it('★ 分桶尚未训练（模型为空）⇒ 不写归属，但结果显式交出去（不是静默）', () => {
      const db = createTestDb();
      const id = 'm-untrained';
      const vector = pseudoUnitVector(1);
      insertMemory(db, id, vector);

      const context: BucketAssignContext = { db, centroids: () => ({ coarse: [], fine: [] }) };
      const result = runWriteTransaction(db, () => assignBucket(context, id, vector));

      expect(result.assigned).toBe(false);
      expect(result.fineId).toBeNull();
      expect(countMembershipRows(db, id)).toBe(0);
    });
  });

  describe('机制：桶计数现算（不改 schema ⇒ 零迁移风险）', () => {
    it('★ 换桶后旧桶 −1、新桶 +1（计数与行永远一致，不可能漂移）', () => {
      const fixture = createFixture();
      const { fromId, fromVector, toVector } = pickDifferentBuckets(fixture);

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, fromId, fromVector);
      });
      const oldFineId = mustFineId(membershipOf(fixture.db, fromId));
      expect(countBucketMembers(fixture.db, oldFineId)).toBe(1);

      runWriteTransaction(fixture.db, () => {
        assignBucket(fixture.context, fromId, toVector);
      });
      const newFineId = mustFineId(membershipOf(fixture.db, fromId));

      expect(countBucketMembers(fixture.db, oldFineId)).toBe(0);
      expect(countBucketMembers(fixture.db, newFineId)).toBe(1);
      expect(listBucketMemberCounts(fixture.db).get(newFineId)).toBe(1);
      expect(listBucketMemberCounts(fixture.db).has(oldFineId)).toBe(false);
    });

    it('★ countBucketMembers 与实际行数一致（现算口径 = 行数）', () => {
      const fixture = createFixture({ count: 20 });
      runWriteTransaction(fixture.db, () => {
        for (let index = 0; index < 20; index += 1) {
          assignBucket(fixture.context, at(fixture.ids, index), at(fixture.vectors, index));
        }
      });

      let total = 0;
      for (const [fineId, count] of listBucketMemberCounts(fixture.db)) {
        expect(countBucketMembers(fixture.db, fineId)).toBe(count);
        total += count;
      }
      expect(total).toBe(20);
    });
  });

  describe('守卫：必须在事务内调用（不静默留孤儿归属）', () => {
    it('★ 事务外调 assignBucket / unassignBucket ⇒ 抛 INVALID_INPUT', () => {
      const fixture = createFixture({ count: 10 });
      const id = at(fixture.ids, 0);
      const vector = at(fixture.vectors, 0);

      expect(() => assignBucket(fixture.context, id, vector)).toThrow(MemoryError);
      expect(() => unassignBucket(fixture.context, id)).toThrow(MemoryError);

      try {
        assignBucket(fixture.context, id, vector);
        expect.unreachable('事务外调用必须抛错');
      } catch (error) {
        expect((error as MemoryError).code).toBe('INVALID_INPUT');
        expect((error as MemoryError).details.reason).toBe('not-in-transaction');
      }
      // 性质：抛错了 ⇒ 一条都没写（不是「写了一半」）
      expect(countMembershipRows(fixture.db, id)).toBe(0);
    });
  });

  describe('守卫：向量校验（走 dot.ts 的唯一权威）', () => {
    it('★ 维度不对 ⇒ 抛 INVALID_INPUT', () => {
      const fixture = createFixture({ count: 10 });
      const id = at(fixture.ids, 0);

      expect(() => {
        runWriteTransaction(fixture.db, () => {
          assignBucket(fixture.context, id, new Float32Array(4));
        });
      }).toThrow(MemoryError);
    });

    it('★ 零向量 ⇒ 抛 INVALID_INPUT（零向量没有方向）', () => {
      const fixture = createFixture({ count: 10 });
      const id = at(fixture.ids, 0);

      expect(() => {
        runWriteTransaction(fixture.db, () => {
          assignBucket(fixture.context, id, new Float32Array(768));
        });
      }).toThrow(MemoryError);
    });

    it('★ 记忆 id 为空串 ⇒ 抛 INVALID_INPUT（不撞外键）', () => {
      const fixture = createFixture({ count: 10 });
      expect(() => {
        runWriteTransaction(fixture.db, () => {
          assignBucket(fixture.context, '', at(fixture.vectors, 0));
        });
      }).toThrow(MemoryError);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 硬断言：桶归属的「唯一写入点」（静态扫描；T04 的 lint 照这条形状落地）
// ─────────────────────────────────────────────────────────────

describe('P2-T03-a · 静态断言：桶归属只有一个写入点', () => {
  /** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  /** 仓库的 `src/` 目录。 */
  const SRC_ROOT = resolve(HERE, '../../src');
  /** 唯一合法的写入点（§9.3.0 的白名单）。 */
  const ALLOWED_FILE = 'vector/bucketAssign.ts';

  /** 递归列出目录下的 `.ts` 实现文件（排除测试与声明）。 */
  function listSourceFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
          out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  /**
   * 剥掉**整行注释**，保留行结构（行号才对得上）。
   *
   * ⚠️ **必须先剥注释**：源码的说明文字里大量出现
   *   `INSERT INTO vector_cell_members` / `vector_cell_members` 这些词
   *   （它们是「唯一写入点」的**说明**）⇒ 不剥注释的话扫描器把说明文字当实现
   *   ⇒ 既误报、又测不出真问题。
   * ⚠️ **保留行结构**（用空行替换而不是删行）：否则行号会漂移 ⇒ 报错定位不到位置。
   */
  function stripCommentLines(source: string): string {
    return source
      .split('\n')
      .map((rawLine) => {
        const trimmed = rawLine.trim();
        const isComment =
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*') ||
          trimmed.endsWith('*/');
        return isComment ? '' : rawLine;
      })
      .join('\n');
  }

  /**
   * 扫出**真正写** `vector_cell_members` 的位置（裸 INSERT / UPDATE / DELETE FROM）。
   *
   * ⚠️ **只认写、不认读**：`SELECT ... FROM vector_cell_members` 是合法的
   *   （`src/vector/ivf.ts` 的桶内检索就在读它）⇒ 正则只匹配三种写动词。
   */
  function findMembershipWriteSites(source: string): number[] {
    const code = stripCommentLines(source);
    const pattern =
      /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+vector_cell_members\b/gi;
    const sites: number[] = [];
    let match = pattern.exec(code);
    while (match !== null) {
      sites.push(code.slice(0, match.index).split('\n').length);
      match = pattern.exec(code);
    }
    return sites;
  }

  it('★ src/** 里写 vector_cell_members 的地方只有 vector/bucketAssign.ts', () => {
    const hits: Array<{ file: string; line: number }> = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const line of findMembershipWriteSites(source)) {
        hits.push({ file: relative(SRC_ROOT, file).split(sep).join('/'), line });
      }
    }

    // 性质：**每一处都在白名单文件里**（不多 ⇒ 没有第二个后门）
    for (const hit of hits) {
      expect(hit.file).toBe(ALLOWED_FILE);
    }
    // 性质：**不少** ⇒ 写入点确实存在（否则这条断言是真空负控）
    expect(hits.length).toBeGreaterThan(0);
  });

  it('★ 负控：注入一个裸 INSERT ⇒ 扫描必须报出来（闸门不是摆设）', () => {
    const source = readFileSync(join(SRC_ROOT, 'vector', 'bucketAssign.ts'), 'utf8');

    // ① 注入 ⇒ 剥完注释仍能扫到 ⇒ 闸门会判红
    const injected = `${source}\nexport function rogue(): void {\n  db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run('a', 'b');\n}\n`;
    expect(findMembershipWriteSites(injected).length).toBeGreaterThan(
      findMembershipWriteSites(source).length,
    );

    // ② 反过来：把写入点删掉 ⇒ 命中数变 0 ⇒ 闸门也会判红
    const withoutWrite = stripCommentLines(source)
      .split('\n')
      .filter((line) => !/\bvector_cell_members\b/.test(line))
      .join('\n');
    expect(findMembershipWriteSites(withoutWrite)).toHaveLength(0);

    // ③ 对照：**原文**（含注释）里确实有这些词 ⇒ 说明「剥注释」这一步是有效的
    //   ⇒ 上面两条断言不是因为「源码里根本没有这个词」才通过的。
    expect(source).toContain('vector_cell_members');
  });

  it('★ 负控：注入一个裸 DELETE ⇒ 扫描必须报出来', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'write.ts'), 'utf8');
    const injected = `${source}\nexport function rogue(db: Database.Database): void {\n  db.prepare('DELETE FROM vector_cell_members WHERE memory_id = ?').run('a');\n}\n`;
    expect(findMembershipWriteSites(injected).length).toBeGreaterThan(0);
  });
});
