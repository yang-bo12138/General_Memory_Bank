/**
 * ★ 向量端口装配点的口径守卫 —— 阶段 5 · P2-T09（设计 D1 / D2 / D7 / RK-1 / RK-5）。
 *
 * ⚠️ **本文件为什么必须存在**：`resolveRecallVectorPort()` 是「四态模式 → 后端对象」的**唯一装配点**
 *   ⇒ 它把 `flat_explicit` / `flat_auto` / `ivf` / `absent` 四态映射成「哪个后端 / 或者没有后端」。
 *   而这里最危险的三个错误都是**静默的**：
 *   ① 小库被映射成 `null`（不是错，但那会让「1 万条以下的库永远拿不到那 0.25 权重」= 语义台阶）；
 *   ② 过门槛但桶没训练时**回落 flat**（改写调用方显式指定的 `'ivf'`）；
 *   ③ **缓存了 port**（探针数是构造时的值 ⇒ `setParams()` 之后路由与 `search()` 用两套探针
 *      ⇒ 桶集分叉 ⇒ 召回悄悄少一批候选，RK-1）。
 *   ⇒ 每条裁决都配一条断言，且**每条正向断言都配了负控**（改坏实现必须红）。
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { createSchema } from '../../src/db/connection.js';
import { EventWriter } from '../../src/store/events.js';
import { resolveVectorBackendMode } from '../../src/store/stats.js';
import { touch } from '../../src/store/touch.js';
import {
  type RecallVectorPort,
  type VectorPortDeps,
  createFlatRowSource,
  resolveRecallVectorPort,
} from '../../src/store/vectorPort.js';
import { MemoryLogger } from '../../src/util/log.js';
import {
  type IvfCentroidModel,
  saveCentroidModel,
  vectorToBlob,
} from '../../src/vector/centroids.js';
import { FLAT_ALL_BUCKETS, FLAT_BACKEND_NAME } from '../../src/vector/flat.js';
import { IVF_BACKEND_NAME } from '../../src/vector/ivf.js';

const DIM = DEFAULT_PARAMS.EMBED_DIM;
const NOW = 1_700_000_000_000;

/**
 * 造一个**只在一个分量上是 1** 的向量（其余 0）。
 *
 * ⚠️ 用它做「余弦是确定的」这件事：`unit(0)·unit(0) = 1`、`unit(0)·unit(1) = 0`
 *   ⇒ 断言可以写成精确值，不必 `toBeCloseTo`。
 */
function unitVector(axis: number): Float32Array {
  const vector = new Float32Array(DIM);
  vector[axis] = 1;
  return vector;
}

/** 建一个空的内存库 + store 上下文（`touch` 要 `events`）。 */
function createDb(params: Params): {
  db: Database.Database;
  store: { db: Database.Database; params: Params; events: EventWriter };
} {
  const db = new Database(':memory:');
  createSchema(db);
  const events = new EventWriter(db, {
    readonly: false,
    logger: new MemoryLogger(),
    now: () => NOW,
  });
  return { db, store: { db, params, events } };
}

/** 插一条带向量的记忆（`content_tokens` 直接抄正文：本文件不验 FTS）。 */
function insertMemory(
  db: Database.Database,
  id: string,
  options: {
    vector?: Float32Array | null;
    deleted?: boolean;
    lastAccess?: number;
    pinFactor?: number;
  } = {},
): void {
  const vector = options.vector === undefined ? unitVector(0) : options.vector;
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash, embedding,
                           stability, difficulty, pin_factor, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @content, @hash, @embedding,
             10, 0.5, @pinFactor, @createdAt, @lastAccess, 0,
             @deleted, @deletedAt)`,
  ).run({
    id,
    content: `内容 ${id}`,
    hash: `hash-${id}`,
    embedding: vector === null ? null : vectorToBlob(vector),
    pinFactor: options.pinFactor ?? 1,
    createdAt: NOW - 86_400_000,
    lastAccess: options.lastAccess ?? NOW,
    deleted: options.deleted === true ? 1 : 0,
    deletedAt: options.deleted === true ? NOW : null,
  });
}

/** 造一个 **sticky 位** 的 deps（`centroids` 用给定模型）。 */
function createDeps(model: IvfCentroidModel = { coarse: [], fine: [] }): {
  deps: VectorPortDeps;
  wasMarked: () => boolean;
} {
  let crossed = false;
  return {
    deps: {
      centroids: () => model,
      embeddedAtLeastThreshold: () => crossed,
      markEmbeddedAtLeastThreshold: () => {
        crossed = true;
      },
    },
    wasMarked: () => crossed,
  };
}

/** 造一个**手工中心模型**：2 个粗桶，每个粗桶 2 个细桶（共 4 个细桶）。 */
function createSmallModel(): IvfCentroidModel {
  return {
    coarse: [
      { coarseId: 'c-000', centroid: unitVector(0) },
      { coarseId: 'c-001', centroid: unitVector(1) },
    ],
    fine: [
      { fineId: 'f-000-000', coarseId: 'c-000', centroid: unitVector(0) },
      { fineId: 'f-000-001', coarseId: 'c-000', centroid: unitVector(2) },
      { fineId: 'f-001-000', coarseId: 'c-001', centroid: unitVector(1) },
      { fineId: 'f-001-001', coarseId: 'c-001', centroid: unitVector(3) },
    ],
  };
}

describe('P2-T09 · 四态 → 后端的映射（D1 / D5 / D7）', () => {
  it("★ `VECTOR_ROUTER='flat'` ⇒ **flat 后端**且 `mode==='flat_explicit'`（显式要求，不是降级）", () => {
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'flat' };
    const { db } = createDb(params);
    // 甚至**过门槛 + 有细桶**也不改变结论：显式 flat 是「要求」，不是「自动选择的兜底」。
    insertMemory(db, 'm-1');
    saveCentroidModel(db, createSmallModel(), NOW);

    const { deps } = createDeps();
    const port = resolveRecallVectorPort(db, params, deps);

    expect(port).not.toBeNull();
    expect(port?.mode).toBe('flat_explicit');
    expect(port?.backend.stats().backend).toBe(FLAT_BACKEND_NAME);
    // ⚠️ 负控：显式 flat 却拿到 ivf ⇒ 上面两条会一起红（`mode` 与 `backend` 都变）
    expect(port?.backend.stats().backend).not.toBe(IVF_BACKEND_NAME);
  });

  it("★ `'auto'` + 库内 0 条向量 ⇒ **flat 后端**且 `mode==='flat_auto'`（小库走 flat 是设计内行为，**不是 `null`**）", () => {
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'auto' };
    const { db } = createDb(params);
    insertMemory(db, 'm-1', { vector: null });
    insertMemory(db, 'm-2', { vector: null });

    const { deps } = createDeps();
    const port = resolveRecallVectorPort(db, params, deps);

    // ⚠️ **它不是 `null`**：`null` 只表示 `absent`（过门槛但桶不可用）——
    //   把 `flat_auto` 也映射成 `null` ⇒ 「库小所以没有语义能力」⇒ 10,000 条处一个语义台阶（D7）。
    expect(port).not.toBeNull();
    expect(port?.mode).toBe('flat_auto');
    expect(port?.backend.stats().backend).toBe(FLAT_BACKEND_NAME);
  });

  it("★ 过门槛 + `vector_fine_cells` 为空 ⇒ 返回 `null`（`mode==='absent'`，整路缺席而不是回落 flat）", () => {
    // 门槛压到 2 条（默认 10000 太贵，且**门槛是参数**，压它不改变被测逻辑）。
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'auto', ROUTER_MIN_TRAINING: 2 };
    const { db } = createDb(params);
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');

    // 前提自检：这一库确实是 `absent`（不是 `flat_auto`、也不是 `ivf`）
    expect(resolveVectorBackendMode(db, params)).toBe('absent');

    const { deps, wasMarked } = createDeps();
    const port = resolveRecallVectorPort(db, params, deps);

    expect(port).toBeNull();
    // ⚠️ **`absent` 不能置位 sticky**：它只说明「桶还没训练」，与「库规模」无关。
    expect(wasMarked()).toBe(false);
  });

  it('★ 过门槛 + 细桶非空 ⇒ **ivf 后端**；`route()` 的细桶数 == `min(NPROBE_FINE, 命中的细中心数)`', () => {
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'auto', ROUTER_MIN_TRAINING: 2 };
    const { db } = createDb(params);
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    saveCentroidModel(db, createSmallModel(), NOW);

    expect(resolveVectorBackendMode(db, params)).toBe('ivf');

    const { deps, wasMarked } = createDeps(createSmallModel());
    const port = resolveRecallVectorPort(db, params, deps);

    expect(port).not.toBeNull();
    expect(port?.mode).toBe('ivf');
    expect(port?.backend.stats().backend).toBe(IVF_BACKEND_NAME);
    // ⚠️ **`ivf` 是唯一能确认「已过门槛」的分支** ⇒ 它必须置位（省掉后续每次的 COUNT）。
    expect(wasMarked()).toBe(true);

    // ── 细桶数：模型里一共 4 个细中心；探针数远超它 ⇒ 全部命中 ──
    const fineIds =
      port?.backend.route(unitVector(0), params.ROUTER_NPROBE_COARSE, params.ROUTER_NPROBE_FINE) ??
      [];
    expect(fineIds).toHaveLength(Math.min(params.ROUTER_NPROBE_FINE, 4));

    // ── 负控：探针数压到 1 ⇒ **细桶数变少**（证明上一条不是「无论如何都返回 4」）──
    const narrowed = port?.backend.route(unitVector(0), 1, 1) ?? [];
    expect(narrowed).toHaveLength(1);
  });

  it('★ **两次连续调用是两个独立实例**：第一次 `upsert()` 的索引侧增量在第二次的 `search()` 里**不出现**（RK-1）', () => {
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'flat' };
    const { db } = createDb(params);
    insertMemory(db, 'm-1', { vector: unitVector(0) });

    const { deps } = createDeps();
    const first = resolveRecallVectorPort(db, params, deps) as RecallVectorPort;
    const second = resolveRecallVectorPort(db, params, deps) as RecallVectorPort;

    // ⚠️ 必须是**两个不同的对象**（同一个实例 = 缓存了 port ⇒ RK-1 的那条静默路径）
    expect(first).not.toBe(second);
    expect(first.backend).not.toBe(second.backend);

    const query = unitVector(0);
    // 改动前：两个实例看到的都是库里的 `unit(0)` ⇒ cos 恰好 1
    expect(first.backend.search(query, 5)[0]?.score).toBe(1);
    expect(second.backend.search(query, 5)[0]?.score).toBe(1);

    // 只在**第一个**实例上 `upsert` 一个与查询正交的向量
    (first.backend as { upsert: (id: string, vector: Float32Array) => void }).upsert(
      'm-1',
      unitVector(1),
    );
    expect(first.backend.search(query, 5)[0]?.score).toBe(0);
    // ⚠️ **第二个实例不受影响** ⇒ 若 port 被缓存/复用，这一条会红（它会是 0）
    expect(second.backend.search(query, 5)[0]?.score).toBe(1);
  });
});

describe('P2-T09 · flat 行源的口径（F9：候选宇宙由取行方保证）', () => {
  it('★ `deleted = 1` 的行与 `embedding IS NULL` 的行**都不出现**（软删 / 无向量不是「相似度低」）', () => {
    const params: Params = { ...DEFAULT_PARAMS };
    const { db } = createDb(params);
    insertMemory(db, 'alive');
    insertMemory(db, 'soft-deleted', { deleted: true });
    insertMemory(db, 'no-vector', { vector: null });

    const rows = createFlatRowSource(db)();
    const ids = rows.map((row) => row.id);

    expect(ids).toEqual(['alive']);
    // ⚠️ 负控：把上面两条过滤器任意删掉一条 ⇒ 这一条立刻变红
    expect(ids).not.toContain('soft-deleted');
    expect(ids).not.toContain('no-vector');
  });

  it('★ 行源是**活数据**：`touch()` 之后同一个行源的 `lastAccess` **立刻**变（不是快照）', () => {
    const params: Params = { ...DEFAULT_PARAMS };
    const { db, store } = createDb(params);
    insertMemory(db, 'm-1', { lastAccess: NOW - 3_600_000 });

    // ⚠️ **同一个闭包**（只创建一次）⇒ 若它内部缓存了快照，下面第二条断言会红；
    //   而那正是「粗筛窗口按旧时间判」的成因（ivf 后端是实时读的 ⇒ 两者会漂移）。
    const source = createFlatRowSource(db);
    const before = source()[0]?.lastAccess;
    expect(before).toBe(NOW - 3_600_000);

    const at = NOW + 7_200_000;
    touch(store, ['m-1'], at);

    const after = source()[0]?.lastAccess;
    expect(after).toBe(at);
    expect(after).not.toBe(before);
  });

  it('★ 行源带上 `pinFactor` 与向量本体（粗筛的 pinned 档与点积都靠它）', () => {
    const params: Params = { ...DEFAULT_PARAMS };
    const { db } = createDb(params);
    insertMemory(db, 'm-1', { pinFactor: 2.5, vector: unitVector(9) });

    const row = createFlatRowSource(db)()[0];
    expect(row?.pinFactor).toBe(2.5);
    expect(row?.vector.length).toBe(DIM);
    expect(row?.vector[9]).toBe(1);
  });
});

describe('P2-T09 · `resolveVectorBackendMode` 的 `known` 参数（不加第二套判据）', () => {
  it('★ 带 `known:{embeddedAtLeastThreshold:true}` 与不带，在**已过门槛**的库上返回**同一个字面量**', () => {
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'auto', ROUTER_MIN_TRAINING: 2 };
    const { db } = createDb(params);
    insertMemory(db, 'm-1');
    insertMemory(db, 'm-2');
    saveCentroidModel(db, createSmallModel(), NOW);

    const withoutKnown = resolveVectorBackendMode(db, params);
    const withKnown = resolveVectorBackendMode(db, params, { embeddedAtLeastThreshold: true });

    expect(withKnown).toBe(withoutKnown);
    expect(withKnown).toBe('ivf');
    // ⚠️ 负控：`known` **不能**把 `absent` 洗成 `ivf`（它只能省 COUNT，不能改结论）
    const { db: emptyDb } = createDb(params);
    insertMemory(emptyDb, 'm-1');
    insertMemory(emptyDb, 'm-2');
    expect(resolveVectorBackendMode(emptyDb, params, { embeddedAtLeastThreshold: true })).toBe(
      'absent',
    );
  });

  it('★ 显式 flat 时 `known` 一个字节都不影响（第一条判据在 COUNT 之前就返回了）', () => {
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'flat' };
    const { db } = createDb(params);
    expect(resolveVectorBackendMode(db, params)).toBe('flat_explicit');
    expect(resolveVectorBackendMode(db, params, { embeddedAtLeastThreshold: true })).toBe(
      'flat_explicit',
    );
  });

  it(`★ flat 行源的哨兵串只用于「整库都算命中」，不会与真实桶 id 混淆（${FLAT_ALL_BUCKETS}）`, () => {
    const params: Params = { ...DEFAULT_PARAMS, VECTOR_ROUTER: 'flat' };
    const { db } = createDb(params);
    insertMemory(db, 'm-1');
    const { deps } = createDeps();
    const port = resolveRecallVectorPort(db, params, deps) as RecallVectorPort;
    expect(port.backend.route(unitVector(0), 1, 1)).toEqual([FLAT_ALL_BUCKETS]);
  });
});
