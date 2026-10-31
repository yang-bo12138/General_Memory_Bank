/**
 * P1-T10 · 门面 `MemoryStore` 的单测 —— DESIGN-v2.md §6（公开 API）/ §7.1（只读）/
 * §11.2（错误体系）/ §5（参数表）。
 *
 * ★ 本文件的断言纪律（沿用本仓库的口径）：
 *   · **每个方法都「真调一次」**：断言的是**返回值的形状与真实副作用**，
 *     不是「方法存在」（断言方法存在太浅：它证明不了委托真的接上了）。
 *   · **错误原样透出**：门面对底层抛出的 `MemoryError` 既不包成通用 `Error`、
 *     也不改写 `code` / `details` ⇒ 断言**与直接调实现逐字段相同**。
 *   · **负控写在测试内部**：故意写一个「包成通用 Error」的版本，断言它**过不了**同一条断言
 *     ⇒ 证明那条断言真的有鉴别力（不是恒真）。
 *
 * ⚠️ **为什么用「文件库 + 第二个连接」而不是内存库**：
 *   ① 门面的 `MemoryConfig.dbPath` 就是一个**文件路径**（§6），内存库不是它的输入形状；
 *   ② 「只读实例」必须**另开一个连接**才能测（§7.1：`fileMustExist: true`），
 *      同一个连接不可能既是可写又是只读；
 *   ③ 门面**刻意不暴露 `db`**（只暴露 11 个方法：阶段 1 的 10 个 + 阶段 2 的
 *      `rebuildVectorBuckets`）⇒ 要核对「库里到底发生了什么」，
 *      只能另开一个连接去读 —— 这正好也是「门面不泄漏实现细节」的一个正向证据。
 *
 * ⚠️ **临时目录不清理**：门面**刻意没有 `close()`**（§6 的公开面里没有它）
 *   ⇒ 句柄要到进程退出才释放；Windows 上此时删不掉那个目录。
 *   与仓库既有测试（`tests/unit/schema.test.ts` 等）同一口径：**临时目录留在系统 temp 下**。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import * as publicApi from '../../src/index.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { EventWriter } from '../../src/store/events.js';
import { type PinStore, pin as pinImpl } from '../../src/store/pin.js';
import { MemoryLogger } from '../../src/util/log.js';

/** 一个固定的时间基准（所有时刻都相对它推算）。 */
const T0 = 1_700_000_000_000;

/** 一个夹具：门面 + 一个「旁路」连接（用来核对库里的真实状态）。 */
interface Harness {
  /** 门面的库文件路径。 */
  dbPath: string;
  /** 被测门面。 */
  store: MemoryStore;
  /**
   * 旁路连接（**不经过门面**）。
   *
   * ⚠️ 它的存在不是为了「偷看实现」，而是为了断言**真实副作用**
   *   （边真的建了？别名真的落库了？）——
   *   门面只返回 id / 权重这类摘要，不返回「库里有没有那行」。
   */
  reader: Database.Database;
}

/** 建一个夹具（每个用例一份，互不干扰）。 */
function createHarness(
  config: { params?: ConstructorParameters<typeof MemoryStore>[0]['params'] } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'memory-ocean-store-'));
  const dbPath = join(dir, 'memory.db');
  const store = new MemoryStore({
    dbPath,
    ...(config.params === undefined ? {} : { params: config.params }),
  });
  const reader = new Database(dbPath);
  return { dbPath, store, reader };
}

/** 捕获一个抛出的异常（失败时给出可读的原因）。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出异常，但没有抛');
}

/** 捕获一个 `MemoryError`（不是 `MemoryError` 就立刻失败，并说明实际是什么）。 */
function captureMemoryError(fn: () => unknown): MemoryError {
  const error = captureError(fn);
  if (error instanceof MemoryError) {
    return error;
  }
  throw new Error(`期望 MemoryError，实际拿到：${String(error)}`);
}

/** 读某个实体的 id（按主名）。 */
function entityIdOf(reader: Database.Database, name: string): string {
  const row = reader.prepare('SELECT id FROM entities WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`实体不存在：${name}`);
  }
  return row.id;
}

/** 读某张表的行数。 */
function countRows(reader: Database.Database, table: string): number {
  const row = reader.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、10 个公开方法：每个都真调一次，断言返回值的形状
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T10 · 门面的 10 个公开方法（§6）', () => {
  it('① write()：真调一次，拿到 §6 的 WriteResult 形状，且正文真的落库', () => {
    const h = createHarness();

    const result = h.store.write({
      content: '张三喜欢猫',
      entities: ['张三'],
      now: T0,
    });

    // ⚠️ 断言的是**形状 + 真实副作用**，不是「方法存在」。
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.merged).toBe(false);
    expect(result.exact).toBe(false);
    expect(result.content).toBe('张三喜欢猫');
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings).toHaveLength(0);

    // 真实副作用：库里确实多了一行，且正文与返回一致。
    const row = h.reader.prepare('SELECT content FROM memories WHERE id = ?').get(result.id) as
      | { content: string }
      | undefined;
    expect(row?.content).toBe('张三喜欢猫');
  });

  it('② recall()：真调一次，拿到 §6 的 RecallResult 形状，并能命中刚写入的记忆', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    const result = h.store.recall({ context: '张三喜欢猫', topN: 3, now: T0 });

    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.id).toBe(written.id);
    expect(typeof result.hits[0]?.score).toBe('number');
    // §6：`suppressed` / `diffused` 的字段**恒在**（不省略）。
    expect(Array.isArray(result.suppressed)).toBe(true);
    expect(Array.isArray(result.diffused)).toBe(true);
  });

  it('★ 门面透传 ADR-2 的实体契约：库**不抽取实体**（不传 ⇒ 图谱路为空；传 entityNames ⇒ 图谱路跑）', () => {
    const h = createHarness();
    h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    // ── ① 不传 entityNames / entityIds ⇒ **图谱路整体不执行** ──
    // ⚠️ 依据：ADR-2 / ADR-P1-T08-GAP 缺口①「库不抽取实体」——
    //   「上下文 → 实体名」由**调用方**完成 ⇒ 库**不会**替你去库里找实体。
    //   ⇒ 本次召回退化为「文本路 + 向量路」（向量路本阶段整路缺席）。
    const withoutEntities = h.store.recall({
      context: '张三喜欢猫',
      topN: 3,
      explain: true,
      now: T0,
    });
    expect(withoutEntities.explain?.routes.graph.ran).toBe(false);
    expect(withoutEntities.explain?.routes.text.ran).toBe(true);

    // ── ② 传 entityNames ⇒ 图谱路**真的跑了**（与 ① 构成一对）──
    const withEntities = h.store.recall({
      context: '张三喜欢猫',
      entityNames: ['张三'],
      topN: 3,
      explain: true,
      now: T0,
    });
    expect(withEntities.explain?.routes.graph.ran).toBe(true);
  });

  it('③ touch()：真调一次，拿到逐条结果，且稳定度真的涨了', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    const outcomes = h.store.touch([written.id], T0 + 10 * MS_PER_DAY);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.id).toBe(written.id);
    expect(outcomes[0]?.intervalDays).toBe(10);
    expect(outcomes[0]?.boosted).toBe(true);
    expect(outcomes[0]?.stabilityDelta).toBeGreaterThan(0);
    expect(outcomes[0]?.edgesReinforced).toBe(0);

    // 真实副作用：库里那条记忆的稳定度确实变了（不是只在返回值里好看）。
    const row = h.reader
      .prepare('SELECT stability, access_count FROM memories WHERE id = ?')
      .get(written.id) as { stability: number; access_count: number };
    expect(row.stability).toBeGreaterThan(1);
    expect(row.access_count).toBe(1);
  });

  it('④ get()：真调一次，拿到 §6 的 MemoryView 形状；查不到返回 null（不抛错）', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    const view = h.store.get(written.id, T0);

    expect(view).not.toBeNull();
    expect(view?.id).toBe(written.id);
    expect(view?.content).toBe('张三喜欢猫');
    expect(view?.entities).toEqual(['张三']);
    expect(view?.deleted).toBe(false);
    expect(typeof view?.intensity).toBe('number');
    expect(typeof view?.layer).toBe('string');

    // §11.2：**只有 `get` 用返回值表达缺失** ⇒ 查不到是 `null`，不是异常。
    expect(h.store.get('不存在的记忆 id', T0)).toBeNull();
  });

  it('⑤ pin()：真调一次，pin_factor 真的落库，且缺省是 2.0', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    h.store.pin(written.id);

    const row = h.reader
      .prepare('SELECT pin_factor FROM memories WHERE id = ?')
      .get(written.id) as {
      pin_factor: number;
    };
    expect(row.pin_factor).toBe(2);
    expect(h.store.get(written.id, T0)?.pinFactor).toBe(2);
  });

  it('⑥ unpin()：真调一次，pin_factor 真的回到 1.0', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });
    h.store.pin(written.id);

    h.store.unpin(written.id);

    const row = h.reader
      .prepare('SELECT pin_factor FROM memories WHERE id = ?')
      .get(written.id) as {
      pin_factor: number;
    };
    expect(row.pin_factor).toBe(1);
    expect(h.store.get(written.id, T0)?.pinFactor).toBe(1);
  });

  it('⑦ link()：真调一次，边真的建出来了，且返回 §6 的 LinkResult 形状', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    const result = h.store.link('张三', '喜欢', '猫', written.id, T0);

    expect(typeof result.subjectId).toBe('string');
    expect(result.predicate).toBe('喜欢');
    expect(typeof result.objectId).toBe('string');
    expect(result.subjectId).toBe(entityIdOf(h.reader, '张三'));
    expect(result.objectId).toBe(entityIdOf(h.reader, '猫'));
    expect(result.weightAfter).toBeGreaterThan(0);
    // §4.5 步骤 2：`autoCreatedEntities` 装的是**实体名**（不是 id）——
    //   「张三」已存在 ⇒ 本次只新建了「猫」。
    expect(result.autoCreatedEntities).toEqual(['猫']);

    // 真实副作用：边确实落库了。
    const edge = h.reader
      .prepare(
        'SELECT weight, memory_id FROM edges WHERE subject_id = ? AND predicate = ? AND object_id = ?',
      )
      .get(result.subjectId, result.predicate, result.objectId) as
      | { weight: number; memory_id: string | null }
      | undefined;
    expect(edge?.memory_id).toBe(written.id);
    expect(edge?.weight).toBe(result.weightAfter);
  });

  it('⑧ linkByIds()：真调一次，第二条边真的建出来了', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });
    const first = h.store.link('张三', '喜欢', '猫', written.id, T0);

    const second = h.store.linkByIds(first.subjectId, '养', first.objectId, written.id, T0);

    expect(second.subjectId).toBe(first.subjectId);
    expect(second.predicate).toBe('养');
    expect(second.objectId).toBe(first.objectId);
    expect(second.weightAfter).toBeGreaterThan(0);

    const edge = h.reader
      .prepare(
        'SELECT COUNT(*) AS n FROM edges WHERE subject_id = ? AND predicate = ? AND object_id = ?',
      )
      .get(second.subjectId, second.predicate, second.objectId) as { n: number };
    expect(edge.n).toBe(1);
    expect(countRows(h.reader, 'edges')).toBe(2);
  });

  it('⑨ setAlias()：真调一次，别名真的落库并指向目标实体', () => {
    const h = createHarness();
    h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });
    const zhangsan = entityIdOf(h.reader, '张三');

    h.store.setAlias('老张', zhangsan);

    const row = h.reader
      .prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?')
      .get('老张') as { entity_id: string } | undefined;
    expect(row?.entity_id).toBe(zhangsan);
  });

  it('⑩ mergeEntities()：真调一次，源实体的主名降级为目标的别名', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });
    h.store.link('张三', '喜欢', '猫', written.id, T0);
    const zhangsan = entityIdOf(h.reader, '张三');
    const mao = entityIdOf(h.reader, '猫');

    const result = h.store.mergeEntities(zhangsan, mao);

    expect(result.sourceId).toBe(zhangsan);
    expect(result.targetId).toBe(mao);
    // §4.9.2：源主名降级为目标的别名 ⇒ `sourceName` 是**源主名的字符串**。
    expect(result.sourceName).toBe('张三');
    expect(result.movedMemories).toBe(1);
    expect(typeof result.mergedEdges).toBe('number');
    expect(typeof result.droppedSelfLoops).toBe('number');

    // 真实副作用：源实体没了，源主名成了目标的别名。
    const alias = h.reader
      .prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?')
      .get('张三') as { entity_id: string } | undefined;
    expect(alias?.entity_id).toBe(mao);
    expect(countRows(h.reader, 'entities')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、边界：公开面恰好 11 个方法 / 错误原样透出 / 只读拒绝
// ═══════════════════════════════════════════════════════════════════════════

describe('P1-T10 · 门面的边界（公开面 / 错误透出 / 只读）', () => {
  it('★ 公开方法恰好是那 11 个（阶段 1 的 10 个 + 阶段 2 的 rebuildVectorBuckets）', () => {
    const methods = Object.getOwnPropertyNames(MemoryStore.prototype)
      .filter((name) => name !== 'constructor')
      .filter((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(MemoryStore.prototype, name);
        return descriptor !== undefined && typeof descriptor.value === 'function';
      })
      .sort();

    // ⚠️ **阶段 2 新增的是 `rebuildVectorBuckets`**（DEVELOPMENT-PLAN.md §3.1 的方法归位表：
    //   阶段 2 = 1 个方法 = `rebuildVectorBuckets`）⇒ 公开面从 10 个长到 11 个。
    expect(methods).toEqual([
      'get',
      'link',
      'linkByIds',
      'mergeEntities',
      'pin',
      'rebuildVectorBuckets',
      'recall',
      'setAlias',
      'touch',
      'unpin',
      'write',
    ]);
  });

  it('★ 公开入口**不导**便利函数 `extractEntityNames`（阶段 1 的导出面不越出方法清单）', () => {
    // ⚠️ **理由出处**：ADR-P1-T07-DEC **D-1**（两份 ADR 口径相反时取**更晚**的那份正式裁决）
    //   + DESIGN-v2.md §4.6 步骤 1 正文：「⚠️ **阶段 1 不实现它**……**本节只留口子**」。
    //   ⇒ 阶段 1 的导出面**只含 §12 阶段 1 方法清单内的东西**；便利函数不在其中。
    const exported = Object.keys(publicApi);

    // ⚠️ **负控先行**：导出面**确实**有东西（否则下面那条可能因为「模块空了」而恒真）。
    expect(exported).toContain('MemoryStore');
    expect(exported).toContain('DEFAULT_PIN_FACTOR');

    // ⇒ 阶段 1 的公开入口**不导**它。
    // ⚠️ **本条只断言「导出面」**：它与「这个函数本身还在不在」**无关**
    //   ⇒ 那个函数将来被删（阶段 1 终裁：ADR-P1-T07-DEC D-1「阶段 1 不实现它」，
    //     连同 `CONTEXT_ENTITY_NAMES_SQL` 一起删）时，本条**照样成立**。
    //   ⇒ 「recall.ts 里也没有这个函数」由**该文件的属主**在 `tests/unit/recall.test.ts` 里守
    //     （那是他的文件域；本文件不越界断言别人的实现细节）。
    expect(exported).not.toContain('extractEntityNames');
  });

  it('★ 底层抛出的 MemoryError 原样透出（code / details / message 逐字段与直接调实现相同）', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    // 门面的错误
    const viaFacade = captureMemoryError(() => h.store.pin(written.id, 99));

    // ★ 直接调实现的错误（同一份库、同一份参数）⇒ 逐字段比对。
    //   这才是「原样透出」的**硬证据**：不是「错误码对」，而是「错误对象逐字段相同」。
    const directStore: PinStore = {
      db: h.reader,
      params: DEFAULT_PARAMS,
      events: new EventWriter(h.reader, {
        readonly: false,
        logger: new MemoryLogger(),
        now: () => T0,
      }),
    };
    const viaImpl = captureMemoryError(() => pinImpl(directStore, written.id, 99));

    expect(viaFacade.code).toBe('INVALID_INPUT');
    expect(viaFacade.code).toBe(viaImpl.code);
    expect(viaFacade.message).toBe(viaImpl.message);
    expect(viaFacade.details).toEqual(viaImpl.details);
    expect(viaFacade.details.factor).toBeDefined();

    // ★ 负控：把错误包成通用 Error ⇒ **过不了**上面那条 `instanceof MemoryError` 断言
    //   ⇒ 证明那条断言真的有鉴别力（不是恒真）。
    const wrapped = captureError(() => {
      try {
        h.store.pin(written.id, 99);
      } catch (error) {
        throw new Error(String(error));
      }
    });
    expect(wrapped).not.toBeInstanceOf(MemoryError);
    expect((wrapped as Partial<MemoryError>).code).toBeUndefined();
  });

  it('★ 目标不存在 ⇒ NOT_FOUND 原样透出（details 也在）', () => {
    const h = createHarness();

    const error = captureMemoryError(() => h.store.pin('不存在的记忆 id'));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toBeDefined();
  });

  it('★ 构造期的 params 覆盖真的生效（MAX_PIN_FACTOR 改成 3 ⇒ pin(3.5) 越界）', () => {
    const h = createHarness({ params: { MAX_PIN_FACTOR: 3 } });
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    // 上界被改成 3 ⇒ 3.0 合法、3.5 越界。
    h.store.pin(written.id, 3);
    expect(h.store.get(written.id, T0)?.pinFactor).toBe(3);
    expect(captureMemoryError(() => h.store.pin(written.id, 3.5)).code).toBe('INVALID_INPUT');

    // ★ 负控：默认参数（MAX_PIN_FACTOR = 5）下 3.5 **合法** ⇒ 证明上面那条变红
    //   的原因是「覆盖真的生效」，而不是「3.5 本来就非法」。
    const defaults = createHarness();
    const other = defaults.store.write({ content: '默认参数', now: T0 });
    defaults.store.pin(other.id, 3.5);
    expect(defaults.store.get(other.id, T0)?.pinFactor).toBe(3.5);
  });

  it('★ 只读实例：写方法被拒绝（§7.1），且库里的数据一个字都没变', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });
    // ⚠️ 先把「猫」这个实体与那条边建好：后面的 `mergeEntities` 需要**两个都存在**的实体，
    //   否则它会在「存在性校验」那一步就抛 `NOT_FOUND` ⇒ 断言到的就不是只读拒绝这条路径了。
    h.store.link('张三', '喜欢', '猫', written.id, T0);

    // 另开一个只读连接（§7.1：`fileMustExist: true`）。
    const readonly = new MemoryStore({ dbPath: h.dbPath, readonly: true });

    // ── ① `pin` / `unpin`：实现里**直接**判 `events.readonly` ⇒ 抛 `READONLY_VIOLATION` ──
    const pinError = captureMemoryError(() => readonly.pin(written.id));
    expect(pinError.code).toBe('READONLY_VIOLATION');
    expect(pinError.details.method).toBe('pin');

    const unpinError = captureMemoryError(() => readonly.unpin(written.id));
    expect(unpinError.code).toBe('READONLY_VIOLATION');

    // ── ② 其余写方法：抛 `READONLY_VIOLATION`，且**零写入** ──
    // ⚠️ 这四个方法的实现里**没有** `readonly` 断言（它们是写到 SQLite 时才撞上
    //   `SQLITE_READONLY`）⇒ 错误码由**唯一**的映射出处 `translateSqliteError()`
    //   给出（§14.3 边界原则 1：每个承诺指到唯一代码路径）。
    //   ⇒ 本条断言守的是「**门面透出的错误码是对的**」，而不是「某个方法自己判了 readonly」。
    const writeError = captureMemoryError(() => readonly.write({ content: '只读写入', now: T0 }));
    expect(writeError.code).toBe('READONLY_VIOLATION');

    const touchError = captureMemoryError(() => readonly.touch([written.id], T0 + MS_PER_DAY));
    expect(touchError.code).toBe('READONLY_VIOLATION');

    const linkError = captureMemoryError(() => readonly.link('张三', '讨厌', '狗', written.id, T0));
    expect(linkError.code).toBe('READONLY_VIOLATION');

    const aliasError = captureMemoryError(() =>
      readonly.setAlias('老张', entityIdOf(h.reader, '张三')),
    );
    expect(aliasError.code).toBe('READONLY_VIOLATION');

    const mergeError = captureMemoryError(() =>
      readonly.mergeEntities(entityIdOf(h.reader, '张三'), entityIdOf(h.reader, '猫')),
    );
    expect(mergeError.code).toBe('READONLY_VIOLATION');

    // 零写入：记忆条数没变、`pin_factor` 没变、别名表没多行、边表没多行。
    expect(countRows(h.reader, 'memories')).toBe(1);
    expect(countRows(h.reader, 'entity_aliases')).toBe(0);
    // ⚠️ 边表**本来就有一条**（上面 `link` 建的）⇒ 只读实例没能再加第二条。
    expect(countRows(h.reader, 'edges')).toBe(1);
    const row = h.reader
      .prepare('SELECT pin_factor FROM memories WHERE id = ?')
      .get(written.id) as {
      pin_factor: number;
    };
    expect(row.pin_factor).toBe(1);
  });

  it('★ 只读实例：读方法照常可用（§7.1 的查看器语义）', () => {
    const h = createHarness();
    const written = h.store.write({ content: '张三喜欢猫', entities: ['张三'], now: T0 });

    const readonly = new MemoryStore({ dbPath: h.dbPath, readonly: true });

    const view = readonly.get(written.id, T0);
    expect(view?.id).toBe(written.id);
    expect(view?.content).toBe('张三喜欢猫');

    const recalled = readonly.recall({ context: '张三喜欢猫', topN: 3, now: T0 });
    expect(recalled.hits.length).toBeGreaterThan(0);
  });
});
