/**
 * P2-T03-b · **四条 embedding 赋值路径的桶归属同步** + **集合相等断言**
 * （DESIGN-v2.md §4.9 步骤 2 / 步骤 3c ② / 步骤 4、§9.3.0、§9.3.2 ①③、§4.15.5）。
 *
 * ★ 本文件的断言纪律：
 *   · **硬断言逐条对应计划稿**，每条都能被变异打红；
 *   · **夹具用的是真库 + 真的两级中心模型**（⇒ 外键 / 唯一索引验得了）；
 *   · **集合相等断言必须能红**（一条永远绿的断言等于没有断言）。
 *
 * ⚠️ **四条路径的现状（本轮）**：
 *   | # | 路径 | 位置 | 本轮 |
 *   | - | ---- | ---- | ---- |
 *   | 1 | 完全重复路径补写向量 | §4.9 步骤 2 | ✅ 已挂接 |
 *   | 2 | 合并路径写入新向量 | §4.9 步骤 3c ② | ✅ 已挂接 |
 *   | 3 | 全新事实创建 | §4.9 步骤 4 | ✅ 已挂接 |
 *   | 4 | `updateContent` 显式改正文 | §4.9.1 步骤 4 | ⚠️ **未挂接**（阶段 4 建 `updateContent.ts`） |
 *   ⇒ 路径 4 本轮**只留 TODO 锚点**（在 `src/store/write.ts`）⇒ 本文件断言那个锚点在，
 *     **并且**断言 `src/store/updateContent.ts` **不存在**
 *     （「空壳 = 死函数 = 假绿」——同 P1-T07 对空壳 `assignBucket` 的处理）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { runWriteTransaction } from '../../src/store/transaction.js';
import { type WriteStore, write } from '../../src/store/write.js';
import { MemoryLogger } from '../../src/util/log.js';
import {
  type BucketAssignContext,
  assignBucket,
  countBucketMembers,
  diffBucketMembership,
  isBucketMembershipConsistent,
} from '../../src/vector/bucketAssign.js';
import { type IvfCentroidModel, blobToVector } from '../../src/vector/centroids.js';
import { assignFineBucket } from '../../src/vector/ivf.js';
import { createTrainedBucketContext } from '../fixtures/bucket-store.js';
import { countRows, createTestStore } from '../fixtures/graph-store.js';

/** 测试用的库句柄类型（内存 SQLite）。 */
type TestDb = ReturnType<typeof createTestStore>['db'];

/** 夹具。 */
interface BucketStore {
  db: TestDb;
  store: WriteStore;
  params: ReturnType<typeof createTestStore>['params'];
  logger: MemoryLogger;
  buckets: BucketAssignContext;
  model: IvfCentroidModel;
}

/**
 * 建一个「**分桶已训练**」的写入上下文。
 *
 * ⚠️ **种子记忆故意不入桶**：`createTrainedBucketContext` 落的种子记忆有向量、
 *   但**没有桶归属** ⇒ 它们就是「阶段 1 遗留的欠账」样本
 *   ⇒ **集合相等断言因此默认是红的**（本文件里有一条断言专门守这一点）。
 */
function createBucketStore(): BucketStore {
  const { db, store, params } = createTestStore();
  const logger = new MemoryLogger();
  const { buckets, model } = createTrainedBucketContext(db);
  return { db, store: { ...store, logger, buckets }, params, logger, buckets, model };
}

/** 造一个单位向量（第 `index` 个分量为 1；模长恰好 1）。 */
function unitVector(dim: number, index: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  vector[index] = 1;
  return vector;
}

/** 读某条记忆的桶归属（`null` = 没有归属）。 */
function membershipOf(db: TestDb, memoryId: string): string | null {
  const row = db
    .prepare('SELECT fine_id FROM vector_cell_members WHERE memory_id = ?')
    .get(memoryId) as { fine_id: string } | undefined;
  return row?.fine_id ?? null;
}

/** 某条记忆在桶表里的行数（**一条记忆只属一个桶 ⇒ 恒 ≤ 1**）。 */
function countMembershipRows(db: TestDb, memoryId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM vector_cell_members WHERE memory_id = ?')
    .get(memoryId) as { count: number };
  return row.count;
}

/** 读某条记忆的向量（`null` = 无向量）。 */
function embeddingOf(db: TestDb, memoryId: string): Buffer | null {
  const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(memoryId) as
    | { embedding: Buffer | null }
    | undefined;
  return row?.embedding ?? null;
}

/**
 * **全量重分配**（启动对账 / 首次重训的「迁成员」步骤，§4.15.5 的步骤 ②）。
 *
 * ⚠️ **逐条 delete-old + insert-new**（§4.15.5 明写）：
 *   不能「先批量插新桶、再批量删旧桶」⇒ 唯一索引会直接写失败。
 */
function reassignAll(db: TestDb, buckets: BucketAssignContext): void {
  const rows = db
    .prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND deleted = 0')
    .all() as Array<{ id: string; embedding: Buffer }>;
  runWriteTransaction(db, () => {
    for (const row of rows) {
      assignBucket(buckets, row.id, blobToVector(row.embedding));
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 四条 embedding 赋值路径
// ─────────────────────────────────────────────────────────────

describe('P2-T03-b · 路径 1（§4.9 步骤 2 · 完全重复路径补写向量）', () => {
  it('★ 补写了向量 ⇒ 桶归属同步补上（一条不多、一条不少）', () => {
    const { db, store, params } = createBucketStore();

    // ① 第一条：**不带向量** ⇒ 库里既没有向量，也没有桶归属
    const first = write(store, { content: '李四喜欢猫粮', entities: ['李四', '猫粮'], now: 0 });
    expect(embeddingOf(db, first.id)).toBeNull();
    expect(membershipOf(db, first.id)).toBeNull();

    // ② 第二条：**正文完全相同** + 带向量 ⇒ 走「完全重复」路径 ⇒ 回填向量
    write(store, {
      content: '李四喜欢猫粮',
      entities: ['李四', '猫粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 1000,
    });

    // 性质：向量**真的补上了**（这是步骤 2 的既有行为）
    expect(embeddingOf(db, first.id)).not.toBeNull();
    // 性质：★ **桶归属也补上了**
    //   ⇒ 漏了它 ⇒ 这条记忆**永远不进任何桶** ⇒ 向量路永远召不回它，
    //     而 `embeddedRatio` 却在涨 ⇒ **静默、永久、不报错**（§9.3.2 ①）。
    expect(membershipOf(db, first.id)).not.toBeNull();
    expect(countMembershipRows(db, first.id)).toBe(1);
  });

  it('★ 已有向量的重复写入**不重算桶归属**（不制造无谓的桶 churn）', () => {
    const { db, store, params } = createBucketStore();

    const first = write(store, {
      content: '李四喜欢猫粮',
      entities: ['李四', '猫粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 0,
    });
    const fineId = membershipOf(db, first.id);
    expect(fineId).not.toBeNull();

    // 再写一次完全相同的正文（带向量）⇒ 完全重复路径 ⇒ **不覆盖已有向量**
    write(store, {
      content: '李四喜欢猫粮',
      entities: ['李四', '猫粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 1000,
    });

    // 性质：桶归属**没变**（本次没改向量 ⇒ 桶归属不该动）
    expect(membershipOf(db, first.id)).toBe(fineId);
    expect(countMembershipRows(db, first.id)).toBe(1);
  });
});

describe('P2-T03-b · 路径 2（§4.9 步骤 3c ② · 合并路径写入新向量）', () => {
  it('★ 合并改了向量 ⇒ 桶归属同步更新（与**新**向量对应，且仍只有一条）', () => {
    const { db, store, params, model } = createBucketStore();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 0,
    });
    const oldFineId = membershipOf(db, first.id);
    expect(oldFineId).not.toBeNull();

    // 合并：内容相近 + 实体重叠 ⇒ 走 §4.9 步骤 3c
    const newVector = unitVector(params.EMBED_DIM, 3);
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      embedding: newVector,
      now: MS_PER_DAY,
    });

    // 性质：落库的是**新**向量
    const stored = embeddingOf(db, first.id);
    expect(stored).not.toBeNull();

    // 性质：★ 桶归属与**新**向量对应（否则就是「排在错位置」——§4.9 步骤 3c ②）
    const expectedFine = assignFineBucket(
      model,
      new Float32Array(newVector),
      params.ROUTER_NPROBE_COARSE,
    );
    expect(expectedFine).not.toBeNull();
    expect(membershipOf(db, first.id)).toBe(expectedFine);
    // 性质：**一条记忆只属一个桶**（换桶不残留）
    expect(countMembershipRows(db, first.id)).toBe(1);
  });

  it('★ 合并时**未传向量** ⇒ 桶归属被摘掉（桶计数 −1，不是「保留旧向量」）', () => {
    const { db, store, params } = createBucketStore();

    const first = write(store, {
      content: '李四喜欢猫粮和狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      embedding: unitVector(params.EMBED_DIM, 0),
      now: 0,
    });
    const fineId = membershipOf(db, first.id);
    expect(fineId).not.toBeNull();
    expect(countBucketMembers(db, fineId as string)).toBe(1);

    // 合并：**不带向量** ⇒ `embedding` 置 NULL（§4.9 步骤 3c ②：不保留旧向量）
    write(store, {
      content: '李四喜欢猫粮以及狗粮',
      entities: ['李四', '猫粮', '狗粮'],
      now: MS_PER_DAY,
    });

    // 性质：向量确实被置 NULL
    expect(embeddingOf(db, first.id)).toBeNull();
    // 性质：★ **桶归属被摘掉**（§4.15.3 第三条：没传向量 ⇒ 必须 `unassignBucket(id)`）
    //   ⇒ 漏了它 ⇒ 桶里留一条没有向量的行 ⇒ 桶计数偏大
    //     ⇒ `p95BucketSize` / `maxBucketSize` / 兜底切分判定量**全部偏**。
    expect(membershipOf(db, first.id)).toBeNull();
    expect(countMembershipRows(db, first.id)).toBe(0);
    // 性质：桶计数 −1
    expect(countBucketMembers(db, fineId as string)).toBe(0);
  });
});

describe('P2-T03-b · 路径 3（§4.9 步骤 4 · 全新事实创建）', () => {
  it('★ 全新事实带向量 ⇒ 桶归属同步写入', () => {
    const { db, store, params } = createBucketStore();

    const created = write(store, {
      content: '王五养了一只猫',
      entities: ['王五', '猫'],
      embedding: unitVector(params.EMBED_DIM, 5),
      now: 0,
    });

    expect(embeddingOf(db, created.id)).not.toBeNull();
    expect(membershipOf(db, created.id)).not.toBeNull();
    expect(countMembershipRows(db, created.id)).toBe(1);
  });

  it('★ 全新事实**不带向量** ⇒ 桶里不该有它', () => {
    const { db, store } = createBucketStore();

    const created = write(store, { content: '王五养了一只狗', entities: ['王五', '狗'], now: 0 });

    expect(embeddingOf(db, created.id)).toBeNull();
    expect(membershipOf(db, created.id)).toBeNull();
    expect(countMembershipRows(db, created.id)).toBe(0);
  });
});

describe('P2-T03-b · 路径 4（§4.9.1 步骤 4 · updateContent 显式改正文）', () => {
  it('★ 本轮**不建** `updateContent.ts`（阶段 4 才建）——但 TODO 锚点必须在', () => {
    // ⚠️ **空壳 = 死函数 = 假绿**（同 P1-T07 对空壳 `assignBucket` 的处理）：
    //   造一个只写 `memories` 不写桶的 `updateContent` ⇒ 那就是「阶段 1 不入桶」的翻版
    //   ⇒ 而静态断言会**假通过**（「四条路径都调了 assignBucket」）。
    // ⇒ 本轮只留**明确的 TODO 锚点**，让阶段 4 不会漏。
    const here = fileURLToPath(new URL('.', import.meta.url));
    const srcRoot = resolve(here, '../../src');

    // 性质：文件**不存在**（本轮不建）
    expect(existsSync(join(srcRoot, 'store', 'updateContent.ts'))).toBe(false);

    // 性质：TODO 锚点在 `src/store/write.ts` 里（阶段 4 的接手点）
    const writeSource = readFileSync(join(srcRoot, 'store', 'write.ts'), 'utf8');
    expect(writeSource).toContain('updateContent');
    expect(writeSource).toContain('TODO');
  });
});

// ─────────────────────────────────────────────────────────────
// 集合相等断言（§9.3.2 ③）
// ─────────────────────────────────────────────────────────────

describe('P2-T03-b · 集合相等断言（§9.3.2 ③ 的三条判据）', () => {
  it('★ 左侧是「全库」扫描 ⇒ 阶段 1 的欠账必须被抓出来（**断言不是真空的**）', () => {
    const { db } = createBucketStore();

    // 种子记忆：有向量、**无桶归属**（= 阶段 1 遗留的欠账，ADR-P1-T07-DEC D-12）
    const diff = diffBucketMembership(db);

    // 性质：★ **缺失集非空** ⇒ 断言能红
    //   ⚠️ 若左侧只取「本次写入的批次」⇒ 这一项会为空 ⇒ 断言永远绿 ⇒ 等于没有断言。
    expect(diff.missing.length).toBeGreaterThan(0);
    // 性质：★ **最早的**那条种子也在缺失集里
    //   ⇒ 「本批次」口径（只取最近写入的那几条）**抓不到**它 ⇒ 这条断言能红。
    expect(diff.missing).toContain('seed-000');
    expect(diff.missing).toContain('seed-039');
    expect(isBucketMembershipConsistent(diff)).toBe(false);
  });

  it('★ 全量重分配之后 ⇒ 集合相等（四条判据全过）', () => {
    const { db, buckets } = createBucketStore();

    // 启动对账 / 首次重训的「迁成员」步骤
    reassignAll(db, buckets);

    const diff = diffBucketMembership(db);
    expect(diff.missing).toEqual([]);
    expect(diff.orphans).toEqual([]);
    expect(diff.vectorless).toEqual([]);
    expect(diff.duplicates).toEqual([]);
    expect(isBucketMembershipConsistent(diff)).toBe(true);
  });

  it('★ 软删的记忆**保留桶归属** ⇒ 不算「多出来」（§9.3.2 ②/③）', () => {
    const { db, store, params } = createBucketStore();

    const created = write(store, {
      content: '赵六喜欢喝茶',
      entities: ['赵六'],
      embedding: unitVector(params.EMBED_DIM, 7),
      now: 0,
    });
    expect(membershipOf(db, created.id)).not.toBeNull();

    // 软删（`deleted = 1`）⇒ 桶归属**保留**（§9.3.2 ②：软删不删桶归属）
    db.prepare('UPDATE memories SET deleted = 1, deleted_at = ? WHERE id = ?').run(
      MS_PER_DAY,
      created.id,
    );

    const diff = diffBucketMembership(db);
    // 性质：它落在「软删」这一类里 ⇒ **不是**不一致
    expect(diff.softDeleted).toContain(created.id);
    expect(diff.orphans).not.toContain(created.id);
    expect(diff.missing).not.toContain(created.id);
  });

  it('★ 重复归属（COUNT(*) != COUNT(DISTINCT memory_id)）必须被抓出来', () => {
    const { db, store, params } = createBucketStore();

    const created = write(store, {
      content: '孙七喜欢喝咖啡',
      entities: ['孙七'],
      embedding: unitVector(params.EMBED_DIM, 9),
      now: 0,
    });
    const fineId = membershipOf(db, created.id);
    expect(fineId).not.toBeNull();

    // ⚠️ **人为拆掉唯一索引**（复现「老库没有这条索引」的情形）
    //   ⇒ 没有它，唯一索引会让「重复归属」**写不进去**（这正是 §4.15.5 说的
    //     「唯一索引让它写不进去，而不是静默重复」）。
    db.exec('DROP INDEX idx_vcm_memory_unique');
    const otherFineId = (
      db.prepare('SELECT fine_id FROM vector_fine_cells WHERE fine_id != ? LIMIT 1').get(fineId) as
        | { fine_id: string }
        | undefined
    )?.fine_id;
    expect(otherFineId).toBeDefined();
    db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
      otherFineId,
      created.id,
    );

    const diff = diffBucketMembership(db);
    // 性质：★ 重复被抓出来（**集合比较单独用看不见它**——§9.3.2 ③ 的判据 ②）
    expect(diff.duplicates).toContain(created.id);
    expect(isBucketMembershipConsistent(diff)).toBe(false);
  });

  it('★ 集合相等**不是**「条数相等」：一条漏 + 一条多 ⇒ 条数相同也必须报红', () => {
    const { db, store, params } = createBucketStore();

    const withVector = write(store, {
      content: '甲事实',
      embedding: unitVector(params.EMBED_DIM, 1),
      now: 0,
    });
    const withoutVector = write(store, { content: '乙事实', now: 0 });

    // 人为制造「条数相同、成员不同」：把甲的桶行改挂到乙名下
    db.prepare('UPDATE vector_cell_members SET memory_id = ? WHERE memory_id = ?').run(
      withoutVector.id,
      withVector.id,
    );

    // 性质：条数确实相同（桶表里就 1 行）
    expect(countRows(db, 'vector_cell_members')).toBe(1);
    // 性质：但**集合不等** ⇒ 缺失与脏行**都**被抓出来
    const diff = diffBucketMembership(db);
    expect(diff.missing).toContain(withVector.id);
    expect(diff.vectorless).toContain(withoutVector.id);
    expect(isBucketMembershipConsistent(diff)).toBe(false);
  });
});
