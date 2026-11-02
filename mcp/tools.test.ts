/**
 * ★ MCP 工具表与调度的断言 —— 阶段 5 · T05（PLAN P5-T05 / 设计 §六 T05 的验收项逐条落地）。
 *
 * ⚠️ **本文件刻意不 import MCP 官方 SDK**（除了 `mcp/server.ts` 的间接依赖）：
 *   断言几乎全部跑在 `mcp/tools.ts` 这个**纯函数**文件上
 *   ⇒ SDK 装不上 / API 改了，本文件的绝大多数断言照样绿（设计 §8 的 R2 的隔离手段）。
 *   ⚠️ 连「那个包名」都不能在下面写成完整字面量：本文件最后一条断言会**扫全树**
 *     找那个包名，写全了会把自己抓成违规（下面用 `SDK_PACKAGE_MARK` 拼接）。
 *
 * 覆盖的硬断言（与设计 §六 T05 的勾选项一一对应）：
 *   ① 六个最小集工具逐个可调用；
 *   ② 三个阻塞维护方法**不在**工具表里（工具名总数写死）+ **反例**（沾污名单必须抛）；
 *   ③ `sweep` 暴露，且 `purgeDeletedDays` / `vacuum` 都在 `required` 里；
 *   ④ `forget` 默认软删（行仍在）；`hard: true` 才删行（**成对**断言）；
 *   ⑤ `recall.explain` 默认关闭（不写事件）/ 显式 `true` 恰好 +1 条（**成对**断言）；
 *   ⑥ `touch.coActivateWith` 超 `COACT_BATCH_MAX` ⇒ `INVALID_INPUT`（库自己抛，不是截断）；
 *   ⑦ 错误**结构化**（`code` + `message` + `details`），不是裸文本；
 *   ⑧ 每个 `inputSchema` 都有 `additionalProperties: false`，且**执行层真的拒未知键**；
 *   ⑨ `mcp/tools.ts` 不 import SDK；`mcp/server.ts` 是唯一一处；
 *   ⑩ vitest 真的收集 `mcp/**`（不是「没跑还不报错」）。
 *
 * ⚠️ **不许恒绿断言**：每条「不含 X」的断言都在**同一个对象**上配一条「含 Y」
 *   （否则一个空对象就能让前者通过）。
 */

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryError } from '../src/core/errors.js';
import { DEFAULT_PARAMS } from '../src/core/params.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import type { MergeEntitiesResult } from '../src/store/entities.js';
import type { LinkResult } from '../src/store/link.js';
import type { RecallResult } from '../src/store/recall.js';
import type { SweepResult } from '../src/store/sweep.js';
import type { TouchOutcome } from '../src/store/touch.js';
import type { WriteResult } from '../src/store/write.js';
import vitestConfigRaw from '../vitest.config.js';
import { callTool } from './server.js';
import {
  BLOCKED_MAINTENANCE_METHODS,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  assertNoBlockedMaintenance,
  assertUniqueToolNames,
  dispatchTool,
  toToolErrorPayload,
} from './tools.js';

// ═══════════════════════════════════════════════════════════════════════════
// 〇、分母与夹具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ **工具名总数（写死的分母）**。
 *
 * ⚠️ 这是「加工具必须有人来改这个数」的闸门：不是「顺手多一个」，
 *   而是「一个需要显式决策的变更」（维护类 5 个方法逐个裁过，见 `mcp/tools.ts` 的决策块）。
 */
const EXPECTED_TOOL_COUNT = 10;

/** 六个最小集工具名（§12 阶段 5 原文，**写死**）。 */
const MINIMAL_TOOL_NAMES: readonly string[] = [
  'write',
  'recall',
  'touch',
  'link',
  'forget',
  'restore',
];

/** 维护类里**已裁暴露**的四个（`clusters` 已裁**不**暴露）。 */
const EXPOSED_MAINTENANCE_NAMES: readonly string[] = [
  'updateContent',
  'setAlias',
  'mergeEntities',
  'sweep',
];

/** 维护类里**已裁不暴露**的读方法（`clusters` 首调会现场重算，属查看器面板 7）。 */
const UNEXPOSED_READ_METHODS: readonly string[] = ['clusters'];

/** 涉及 SDK 包名的**拼接**写法（不能让完整字面量出现在本文件里，见文件头）。 */
const SDK_PACKAGE_MARK = '@modelcontextprotocol' + '/sdk';

/** 仓库根（本文件在 `mcp/` 下）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 一个测试用的文件库（内存库做不到「旁路连接看落库结果」，而本文件要看软删后的行）。 */
interface Fixture {
  readonly store: MemoryStore;
  readonly dbPath: string;
  readonly dataDir: string;
}

/** 当前用例的夹具（`beforeEach` 建、`afterEach` 关）。 */
let fixture: Fixture;

/**
 * 建一个全新的文件库。
 *
 * ⚠️ **临时目录不清理**（与仓库既有夹具同口径）：Windows 上句柄未释放时删不掉目录，
 *   清理失败会掩盖真正的断言失败。
 */
function createFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'memory-ocean-mcp-'));
  const dbPath = join(dataDir, 'memory.db');
  return { store: new MemoryStore({ dbPath }), dbPath, dataDir };
}

/** 旁路连接（门面**不暴露 `db`**，要看真实落库状态只能另开一条连接）。 */
function withDb<T>(dbPath: string, run: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 一条记忆的原始行（`deleted` / `deleted_at` 是「软删还是硬删」的判别依据）。 */
interface MemoryRow {
  content: string;
  deleted: number;
  deleted_at: number | null;
}

/** 查一条记忆的原始行；不存在 ⇒ `undefined`。 */
function memoryRow(id: string): MemoryRow | undefined {
  return withDb(
    fixture.dbPath,
    (db) =>
      db.prepare('SELECT content, deleted, deleted_at FROM memories WHERE id = ?').get(id) as
        | MemoryRow
        | undefined,
  );
}

/** 数某类事件的行数（`recall` 事件的写放大断言靠它）。 */
function countEvents(type: string): number {
  return withDb(fixture.dbPath, (db) => {
    const row = db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as {
      n: number;
    };
    return row.n;
  });
}

/** 按实体名取 `entity_id`（`setAlias` / `mergeEntities` 需要 id 而不是名字）。 */
function entityIdByName(name: string): string {
  return withDb(fixture.dbPath, (db) => {
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as
      | { id: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`夹具里没有实体 ${name}`);
    }
    return row.id;
  });
}

/** 调一个工具并把结果按期望类型取回（**同步**：库是全同步 API）。 */
function run<T>(name: string, args: unknown): T {
  return dispatchTool(fixture.store, name, args) as T;
}

/**
 * 断言某个调用抛 `MemoryError` 且码是 `code`（返回它，便于继续断言 `details`）。
 *
 * ⚠️ 与 `expect(...).toThrow()` 的差别：那条只断言「抛了」，
 *   而本文件要的是「抛的是**哪个**码 + `details` 里有什么」——那才是 §11.2 的承诺。
 */
function expectMemoryError(invoke: () => unknown, code: string): MemoryError {
  try {
    invoke();
  } catch (error) {
    expect(error, `抛的不是 MemoryError，而是 ${String(error)}`).toBeInstanceOf(MemoryError);
    const memoryError = error as MemoryError;
    expect(memoryError.code, `抛的是 ${memoryError.code}，期望 ${code}`).toBe(code);
    return memoryError;
  }
  throw new Error(`期望抛 ${code}，实际**没有抛错**（这条断言本该红）`);
}

/** 取一个工具的声明（找不到就当场失败——不写 `?.`，否则失败信息会变成一堆 undefined 断言）。 */
function tool(name: string): (typeof TOOL_DEFINITIONS)[number] {
  const found = TOOL_DEFINITIONS.find((definition) => definition.name === name);
  if (found === undefined) {
    throw new Error(`工具表里没有 ${name}`);
  }
  return found;
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.store.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 一、工具表：形状 / 禁暴露 / 参数语义
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 工具表：最小集齐、阻塞方法不在、参数语义显式', () => {
  it('工具名总数是**写死的 10**（6 最小集 + 4 维护类），且无重复', () => {
    expect(TOOL_NAMES.length).toBe(EXPECTED_TOOL_COUNT);
    expect(new Set(TOOL_NAMES).size).toBe(EXPECTED_TOOL_COUNT);
    // 六个最小集逐个在场（分母写死 6）
    expect(MINIMAL_TOOL_NAMES.length).toBe(6);
    for (const name of MINIMAL_TOOL_NAMES) {
      expect(TOOL_NAMES, `最小集缺 ${name}`).toContain(name);
    }
    // 四个维护类逐个在场
    for (const name of EXPOSED_MAINTENANCE_NAMES) {
      expect(TOOL_NAMES, `维护类缺 ${name}`).toContain(name);
    }
  });

  it('★ 三个阻塞维护方法**不在**工具名集合里（且反例：沾污名单必须抛）', () => {
    expect(BLOCKED_MAINTENANCE_METHODS.length).toBe(3);
    // ★ 三个名字**逐个写死**：只断 `length === 3` 时，把 `recluster` 换成别的阻塞方法也绿。
    expect([...BLOCKED_MAINTENANCE_METHODS].sort()).toEqual([
      'rebuildArchivalSchedule',
      'rebuildVectorBuckets',
      'recluster',
    ]);
    const exposed = TOOL_NAMES.filter((name) => BLOCKED_MAINTENANCE_METHODS.includes(name));
    expect(exposed, '阻塞维护方法被暴露了（一次调用会阻塞 1~3 分钟）').toEqual([]);

    // ⚠️ **反例**：把一个阻塞方法加进名单 ⇒ `assertNoBlockedMaintenance()` 必须抛错。
    //   不写这条的话，上面那条断言只是「我相信它没被加进去」。
    const poisoned = [...TOOL_NAMES, 'recluster'];
    const error = expectMemoryError(() => assertNoBlockedMaintenance(poisoned), 'INVALID_INPUT');
    expect(error.details.reason).toBe('blocked_maintenance_exposed');
    expect(error.details.blocked).toEqual(['recluster']);
    // 干净名单不抛（否则上面的反例只是个「永远抛」的空断言）
    expect(() => assertNoBlockedMaintenance(TOOL_NAMES)).not.toThrow();
  });

  it('★ 工具名重复必须抛（`tools/call` 会永远命中先出现的那一个）', () => {
    expect(() => assertUniqueToolNames(TOOL_NAMES)).not.toThrow();
    const error = expectMemoryError(
      () => assertUniqueToolNames([...TOOL_NAMES, 'write']),
      'INVALID_INPUT',
    );
    expect(error.details.duplicates).toEqual(['write']);
  });

  it('`clusters` 不暴露（它是读方法，但首调会现场重算几百毫秒）', () => {
    expect(UNEXPOSED_READ_METHODS.length).toBe(1);
    for (const name of UNEXPOSED_READ_METHODS) {
      expect(TOOL_NAMES, `${name} 不该被暴露`).not.toContain(name);
    }
    // 反例配对：同一份名单里必须有东西在场，否则「not.toContain」可以靠空数组通过
    expect(TOOL_NAMES).toContain('write');
  });

  it('每个 `inputSchema` 都是 `additionalProperties: false`（分母写死 10）', () => {
    expect(TOOL_DEFINITIONS.length).toBe(EXPECTED_TOOL_COUNT);
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.inputSchema.type, `${definition.name} 的 type`).toBe('object');
      expect(
        definition.inputSchema.additionalProperties,
        `${definition.name} 缺 additionalProperties: false（会悄悄吃下未知参数）`,
      ).toBe(false);
      expect(Object.keys(definition.inputSchema.properties).length).toBeGreaterThan(0);
      expect(definition.title.length, `${definition.name} 的 title 为空`).toBeGreaterThan(0);
      expect(
        definition.description.length,
        `${definition.name} 的 description 为空`,
      ).toBeGreaterThan(0);
    }
  });

  it('★ `sweep` 暴露，且 `purgeDeletedDays` 与 `vacuum` **都在 required 里**', () => {
    const sweep = tool('sweep');
    const required = [...(sweep.inputSchema.required ?? [])].sort();
    expect(required).toEqual(['purgeDeletedDays', 'vacuum']);
    // 语义显式：两个参数都必须有说明（否则「0 天」会被读成「清 0 天前的」）
    const properties = sweep.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.purgeDeletedDays?.description).toBeTruthy();
    expect(properties.vacuum?.description).toBeTruthy();
  });

  it('★ `recall` 没有 `source` / `reinforce` / `diagnostics` 三个键（同一个对象上配「有 context」）', () => {
    const properties = tool('recall').inputSchema.properties;
    const keys = Object.keys(properties);
    // 配对断言：证明这确实是一份非空 schema（否则「不含 X」毫无意义）
    expect(keys).toContain('context');
    expect(keys).toContain('explain');
    expect(keys, '§6：不给 MCP 暴露 source 过滤（核心价值是跨来源统一召回）').not.toContain(
      'source',
    );
    expect(keys, 'reinforce 是「采纳」，由宿主决定，不是服务的事').not.toContain('reinforce');
    expect(keys, 'diagnostics 与 explain 是两条不同的写放大口径，只留 explain').not.toContain(
      'diagnostics',
    );
    // explain 必须**默认 false**（写放大）
    expect((properties.explain as { default?: boolean }).default).toBe(false);
  });

  it('`forget` 的 `hard` 默认 false（软删），`restore` 只有 mergeInto 一个可选参数', () => {
    const forgetSchema = tool('forget');
    expect((forgetSchema.inputSchema.properties.hard as { default?: boolean }).default).toBe(false);
    expect([...(forgetSchema.inputSchema.required ?? [])]).toEqual(['id']);
    const restoreSchema = tool('restore');
    expect([...(restoreSchema.inputSchema.required ?? [])]).toEqual(['id']);
    expect(Object.keys(restoreSchema.inputSchema.properties).sort()).toEqual(['id', 'mergeInto']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、最小集六项逐个可调用
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 最小集六项逐个可调用（write / recall / touch / link / forget / restore）', () => {
  it('`write` ⇒ 落库（旁路连接查得到正文）且**同步返回**（库仍是全同步）', () => {
    const result = run<WriteResult>('write', {
      content: '张三喜欢猫',
      entities: ['张三', '猫'],
    });
    expect(typeof result.id).toBe('string');
    expect(result.merged).toBe(false);
    expect(memoryRow(result.id)?.content).toBe('张三喜欢猫');

    // ★ 库是全同步的：返回值**不是** Promise（异步包装在最外层 `mcp/server.ts`）
    const raw: unknown = dispatchTool(fixture.store, 'recall', { context: '张三喜欢猫' });
    expect(raw instanceof Promise).toBe(false);
    expect((raw as { then?: unknown }).then).toBeUndefined();
  });

  it('`recall` ⇒ 命中刚写的那条', () => {
    const written = run<WriteResult>('write', { content: '张三喜欢猫', entities: ['张三'] });
    const result = run<RecallResult>('recall', { context: '张三喜欢猫' });
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.map((hit) => hit.id)).toContain(written.id);
  });

  it('`touch` ⇒ 逐条返回加固结果（`ids` 全命中）', () => {
    const written = run<WriteResult>('write', { content: '李四养狗' });
    const outcomes = run<TouchOutcome[]>('touch', { ids: [written.id] });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.id).toBe(written.id);
    expect(typeof outcomes[0]?.stabilityDelta).toBe('number');
  });

  it('`link` ⇒ 返回**实际落库**的权重', () => {
    const written = run<WriteResult>('write', { content: '王五在甲公司的同事是赵六' });
    const result = run<LinkResult>('link', {
      subject: '王五',
      predicate: '同事',
      object: '赵六',
      memoryId: written.id,
    });
    expect(typeof result.weightAfter).toBe('number');
    expect(result.weightAfter).toBeGreaterThan(0);
    expect(result.predicate).toBe('同事');
  });

  it('★ `forget` **默认软删**：`deleted = 1`、`deleted_at` 非空、**行仍在**', () => {
    const written = run<WriteResult>('write', { content: '这条要被软删' });
    const result = run<{ ok: true }>('forget', { id: written.id });
    expect(result.ok).toBe(true);

    const row = memoryRow(written.id);
    expect(row, '软删把行删掉了（那是 hard: true 的后果）').toBeDefined();
    expect(row?.deleted).toBe(1);
    expect(row?.deleted_at).not.toBeNull();
    // 正文仍在（软删只改两个状态列）
    expect(row?.content).toBe('这条要被软删');
  });

  it('★ `forget` 的 `hard: true` 才真删行（与上一条成对：默认值没有被悄悄当成硬删）', () => {
    const written = run<WriteResult>('write', { content: '这条要被硬删' });
    run<{ ok: true }>('forget', { id: written.id, hard: true });
    expect(memoryRow(written.id), 'hard: true 之后行仍在（硬删没生效）').toBeUndefined();
  });

  it('`restore` ⇒ `deleted` 回到 0、`deleted_at` 清空', () => {
    const written = run<WriteResult>('write', { content: '先删再恢复' });
    run<{ ok: true }>('forget', { id: written.id });
    run<{ ok: true }>('restore', { id: written.id });
    const row = memoryRow(written.id);
    expect(row?.deleted).toBe(0);
    expect(row?.deleted_at).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、维护类四项可调用
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 维护类四项（updateContent / setAlias / mergeEntities / sweep）', () => {
  it('`updateContent` ⇒ 正文被改写（且旧向量被置空不等于报错）', () => {
    const written = run<WriteResult>('write', { content: '原来的正文' });
    const result = run<{ ok: true }>('updateContent', {
      id: written.id,
      newContent: '改正后的正文',
    });
    expect(result.ok).toBe(true);
    expect(memoryRow(written.id)?.content).toBe('改正后的正文');
  });

  it('`setAlias` ⇒ 别名真的挂到了实体上（旁路连接查 `entity_aliases`）', () => {
    run<WriteResult>('write', { content: '孙八来过', entities: ['孙八'] });
    const entityId = entityIdByName('孙八');
    run<{ ok: true }>('setAlias', { alias: '阿八', entityId });
    const aliases = withDb(fixture.dbPath, (db) =>
      db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?').all(entityId),
    ) as Array<{ alias: string }>;
    expect(aliases.map((row) => row.alias)).toContain('阿八');
  });

  it('`mergeEntities` ⇒ 返回迁移计数（源实体被合并掉）', () => {
    run<WriteResult>('write', { content: '周九和周玖是同一个人', entities: ['周九', '周玖'] });
    const result = run<MergeEntitiesResult>('mergeEntities', {
      sourceId: entityIdByName('周玖'),
      targetId: entityIdByName('周九'),
    });
    expect(typeof result.movedMemories).toBe('number');
    expect(result.sourceName).toBe('周玖');
  });

  it('`sweep` ⇒ 两个参数都给时正常返回（`purgeDeletedDays: 0` = 一条都不清）', () => {
    run<WriteResult>('write', { content: 'sweep 的陪跑数据' });
    const result = run<SweepResult>('sweep', { purgeDeletedDays: 0, vacuum: false });
    expect(typeof result.purged).toBe('number');
    expect(typeof result.archivedCount).toBe('number');
    expect(typeof result.coactPairsPurged).toBe('number');
    // 0 天 = 「不清任何东西」（不是「清 0 天前的」）
    expect(result.purged).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、`recall.explain` 的写放大（默认关闭 / 显式打开）+1
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · `recall.explain` 默认关闭（不写事件）', () => {
  it('不传 `explain` ⇒ `events` 里 `recall` 行数**不变**', () => {
    run<WriteResult>('write', { content: '不写事件的召回' });
    const before = countEvents('recall');
    const result = run<RecallResult>('recall', { context: '不写事件的召回' });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(countEvents('recall'), 'MCP 的 recall 默认把事件写上去了（写放大）').toBe(before);
    // 明细块也不该出现（它与事件是同一个开关）
    expect(result.explain).toBeUndefined();
  });

  it('显式 `explain: true` ⇒ **恰好 +1** 条 `type=recall` 事件（与上一条成对）', () => {
    run<WriteResult>('write', { content: '要写事件的召回' });
    const before = countEvents('recall');
    const result = run<RecallResult>('recall', { context: '要写事件的召回', explain: true });
    expect(result.explain, 'explain: true 却没给明细块').toBeDefined();
    expect(countEvents('recall')).toBe(before + 1);
  });

  it('`explain: false` 与「不传」等价（不会因为显式传了就写事件）', () => {
    run<WriteResult>('write', { content: '显式 false 的召回' });
    const before = countEvents('recall');
    run<RecallResult>('recall', { context: '显式 false 的召回', explain: false });
    expect(countEvents('recall')).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、`touch.coActivateWith` 的上限校验（MCP 层不吞错、不截断）
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · `touch.coActivateWith` 校验在 MCP 层同样生效', () => {
  it('分母写死：`COACT_BATCH_MAX` 就是 256（不抄数，从参数表取）', () => {
    expect(DEFAULT_PARAMS.COACT_BATCH_MAX).toBe(256);
  });

  it('★ 超 `COACT_BATCH_MAX` ⇒ `INVALID_INPUT`（**库自己抛**，不是被 MCP 层截断）', () => {
    const written = run<WriteResult>('write', { content: '共激活上限的陪跑数据' });
    const tooMany = Array.from({ length: DEFAULT_PARAMS.COACT_BATCH_MAX + 1 }, () => ({
      memoryId: written.id,
      seedIds: [] as string[],
    }));
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'touch', { ids: [written.id], coActivateWith: tooMany }),
      'INVALID_INPUT',
    );
    // ⚠️ 这个 reason 是**库**（`src/neuron/coacts.ts`）写的
    //   ⇒ 它证明校验真的跑到了库里，而不是被 MCP 层按 schema 上限提前拒掉/截断
    expect(error.details.reason).toBe('coact_batch_max');
    expect(error.details.max).toBe(DEFAULT_PARAMS.COACT_BATCH_MAX);
    expect(error.details.count).toBe(DEFAULT_PARAMS.COACT_BATCH_MAX + 1);
  });

  it('★ 恰好 `COACT_BATCH_MAX` 条 ⇒ 不抛，且 256 条声明**全部被消费**（不是静默丢弃）', () => {
    // ⚠️ 为什么不能只断 `not.toThrow()`：在 `MAX-1` 处静默截断同样不抛 ⇒ 恒绿。
    //   ⇒ 这里造 **256 个互不相同**的 (seed, memoryId) 对，再按库自己的记账核对：
    //     accepted（真的写成边）+ truncated（明确的截断）+ skippedInvalidSeed（无效种子）
    //     **必须恰好等于 256** ⇒ 少一条就说明被悄悄丢了。
    const anchors = [
      run<WriteResult>('write', { content: '共激活锚点 A' }).id,
      run<WriteResult>('write', { content: '共激活锚点 B' }).id,
    ];
    const seeds: string[] = [];
    // 2 个锚点 × 128 个种子 = 256 个互不相同的对（`COACT_BATCH_MAX` 恰好 256）
    const seedCount = DEFAULT_PARAMS.COACT_BATCH_MAX / anchors.length;
    for (let i = 0; i < seedCount; i += 1) {
      seeds.push(run<WriteResult>('write', { content: `共激活种子 ${i}` }).id);
    }

    const declarations: Array<{ memoryId: string; seedIds: string[] }> = [];
    for (const seed of seeds) {
      for (const anchor of anchors) {
        if (declarations.length >= DEFAULT_PARAMS.COACT_BATCH_MAX) break;
        declarations.push({ memoryId: anchor, seedIds: [seed] });
      }
    }
    expect(declarations.length).toBe(DEFAULT_PARAMS.COACT_BATCH_MAX);

    const outcomes = run<TouchOutcome[]>('touch', { ids: anchors, coActivateWith: declarations });
    const outcome = outcomes[0];
    expect(outcome?.skippedInvalidSeed, '有声明被当成无效种子丢掉 —— 那不是「消费」').toBe(0);
    expect(
      (outcome?.accepted ?? -1) + (outcome?.truncated ?? -1),
      'accepted + truncated != 声明的条数 ⇒ 有声明被静默丢弃（在 MAX-1 处截断就会这样）',
    ).toBe(DEFAULT_PARAMS.COACT_BATCH_MAX);
    // 上限是 `COACT_MAX_PAIRS_PER_TOUCH`（每对上限），**不是** `COACT_BATCH_MAX`：
    // 前者限制「一次写多少对边」，后者限制「一次收多少条声明」，两者各管一件事。
    expect(outcome?.accepted).toBe(DEFAULT_PARAMS.COACT_MAX_PAIRS_PER_TOUCH);
    // 后果：`accepted` 那么多行真的进了 `coacts`
    expect(coactCount(), 'accepted 说有边，但 coacts 表里没有').toBe(
      DEFAULT_PARAMS.COACT_MAX_PAIRS_PER_TOUCH,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、错误结构化 + 入参校验（`additionalProperties: false` 的执行层）
// ═══════════════════════════════════════════════════════════════════════════

describe('T05 · 错误以结构化形式返回（§11.2 的 code + details）', () => {
  it('未知工具名 ⇒ `INVALID_INPUT` + `details.reason = unknown_tool`（并列出可用工具）', () => {
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'recluster', {}),
      'INVALID_INPUT',
    );
    expect(error.details.reason).toBe('unknown_tool');
    expect(error.details.available).toEqual(TOOL_NAMES);
    expect((error.details.available as string[]).length).toBe(EXPECTED_TOOL_COUNT);
  });

  it('库的 `NOT_FOUND` 原样透出（带 `details.id`，不被改写成通用错误）', () => {
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'forget', { id: '不存在-的记忆-id' }),
      'NOT_FOUND',
    );
    expect(error.details.id).toBe('不存在-的记忆-id');
  });

  it('★ 未知参数被**执行层**拒掉（不是只在 schema 里写着）', () => {
    // 反例配对：合法参数能过
    expect(() => dispatchTool(fixture.store, 'recall', { context: '合法入参' })).not.toThrow();
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'recall', { context: '合法入参', sourceFilter: 'cli' }),
      'INVALID_INPUT',
    );
    expect(error.details.reason).toBe('invalid_arguments');
    expect(error.details.unknownKeys).toEqual(['sourceFilter']);
  });

  it('缺必填项 ⇒ `details.reason = missing_required`（反例配对：给了就过）', () => {
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'write', {}),
      'INVALID_INPUT',
    );
    expect(error.details.reason).toBe('missing_required');
    expect(error.details.path).toBe('$.content');
    expect(() => dispatchTool(fixture.store, 'write', { content: '给了必填' })).not.toThrow();
  });

  it('类型 / 上限越界 ⇒ `invalid_arguments`（`topN` 的上限是 8）', () => {
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'recall', { context: '越界', topN: 99 }),
      'INVALID_INPUT',
    );
    expect(error.details.reason).toBe('invalid_arguments');
    expect(error.details.path).toBe('$.topN');
    expect(() =>
      dispatchTool(fixture.store, 'recall', { context: '边界内', topN: 8 }),
    ).not.toThrow();
  });

  it('`keepAuditContent` 不给 `hard: true` ⇒ 明确拒掉（不静默忽略）', () => {
    const written = run<WriteResult>('write', { content: '审计正文开关' });
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'forget', { id: written.id, keepAuditContent: true }),
      'INVALID_INPUT',
    );
    expect(error.details.reason).toBe('keep_audit_content_requires_hard');
    // 反例配对：同时给 hard: true ⇒ 过
    expect(() =>
      dispatchTool(fixture.store, 'forget', {
        id: written.id,
        hard: true,
        keepAuditContent: true,
      }),
    ).not.toThrow();
  });

  it('`toToolErrorPayload` 不改写 message / details（§11.2：包装会让调用方拿不到错误码）', () => {
    const original = MemoryError.conflict('撞了唯一索引', { conflictingId: 'mem-1' });
    const payload = toToolErrorPayload(original);
    expect(payload.code).toBe('CONFLICT');
    expect(payload.message).toBe('撞了唯一索引');
    expect(payload.details).toEqual({ conflictingId: 'mem-1' });
  });

  it('★ `server.ts` 的 `callTool` 把 `MemoryError` 变成 `isError: true` 的 **JSON 结构化**内容', () => {
    const failure = callTool(fixture.store, 'forget', { id: '不存在-的记忆-id' });
    expect(failure.isError).toBe(true);
    const text = failure.content[0]?.text ?? '';
    // 「不是裸文本」的判据：它是**可解析的 JSON**，且三个键齐、值来自 §11.2
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['code', 'details', 'message']);
    expect(payload.code).toBe('NOT_FOUND');
    expect(payload.details).toEqual({ id: '不存在-的记忆-id' });
    expect(typeof payload.message).toBe('string');
  });

  it('`callTool` 的成功路径：`isError` 不为 true，文本是可解析的 JSON 结果', () => {
    const success = callTool(fixture.store, 'write', { content: '经 server 薄适配写入' });
    expect(success.isError).toBeUndefined();
    const payload = JSON.parse(success.content[0]?.text ?? '{}') as WriteResult;
    expect(typeof payload.id).toBe('string');
    expect(memoryRow(payload.id)?.content).toBe('经 server 薄适配写入');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、架构约束（源码级：SDK 只在一处 / 本文件真的被收集）
// ═══════════════════════════════════════════════════════════════════════════

/** 列出一个目录下的全部 `.ts` 文件（递归；跳过 `node_modules`）。 */
function listTsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('T05 · 架构约束', () => {
  it('★ `mcp/tools.ts` 不 import SDK；**产品代码**里命中该包名的文件只有 `mcp/server.ts`', () => {
    const scanned = [
      ...listTsFiles(join(REPO_ROOT, 'src')),
      ...listTsFiles(join(REPO_ROOT, 'mcp')),
    ];
    const hits = scanned
      .filter((file) => readFileSync(file, 'utf8').includes(SDK_PACKAGE_MARK))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'));

    expect(scanned.length).toBeGreaterThan(50); // 分母非空（别让空目录给出假绿）

    // ① **产品代码**（非 `*.test.ts`）：只许 `mcp/server.ts` 一处。
    const productHits = hits.filter((file) => !file.endsWith('.test.ts'));
    expect(productHits, 'SDK 的耦合面被扩散了：升级 SDK 就得改多处').toEqual(['mcp/server.ts']);

    // ② ★ **测试侧**：命中该包名的测试文件必须**恰好**是 `mcp/server.test.ts`。
    //   ⚠️ 这半条不是凑数：它证明「排除 `*.test.ts`」不是一块遮羞布 ——
    //     若有人把 SDK 悄悄 import 进**别的**测试文件当捷径，这里会红；
    //     若 `server.test.ts` 被删/改名，这里也会红（那时 ① 依然绿，说明半条断言各有分工）。
    const testHits = hits.filter((file) => file.endsWith('.test.ts'));
    expect(
      testHits,
      '测试侧 import SDK 的文件集合变了（协议层覆盖的入口只有 server.test.ts）',
    ).toEqual(['mcp/server.test.ts']);

    // ③ 再钉一次最核心的那句：`mcp/tools.ts` 自己不含这个包名（它是 SDK 免疫的纯函数层）。
    expect(hits).not.toContain('mcp/tools.ts');
  });

  it('★ vitest 的 `include` 含 `mcp/**/*.test.ts`（否则本文件根本不跑，而且**不报错**）', () => {
    const config = vitestConfigRaw as unknown as { test?: { include?: string[] } };
    const include = config.test?.include ?? [];
    expect(include.length).toBeGreaterThan(0);
    expect(include).toContain('mcp/**/*.test.ts');
    // 反例配对：既有两条 glob 仍在（不是「把旧的换掉」）
    expect(include).toContain('tests/**/*.test.ts');
    expect(include).toContain('src/**/*.test.ts');
  });

  it('工具表的顺序稳定（最小集在前、维护类在后）⇒ 快照与断言可复现', () => {
    expect(TOOL_NAMES.slice(0, 6)).toEqual(MINIMAL_TOOL_NAMES);
    expect(TOOL_NAMES.slice(6)).toEqual(EXPOSED_MAINTENANCE_NAMES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 八、后果层：**回库查状态**，不只断库方法的返回值
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 这一节的存在理由（复核指出的病根）：上一版的 5 条断言「改坏实现也不会红」——
//   它们只读**返回值**（`purged === 0`、`typeof stabilityDelta === 'number'`、
//   `movedMemories` 是数字……），而一个**空实现**（什么都不做、只编排一个漂亮的返回对象）
//   完全满足这些条件。⇒ 本节每条都是：**先用旁路只读连接看到后果，再与返回值对照**。
//
// ⚠️ 「摆夹具」用可写旁路连接或门面自己的 `now` 注入（**只用于造过去的时间**），
//   因为 MCP 层刻意不转发时钟（见 `mcp/tools.ts` 决策块④）。
//   ⇒ 每一步都注明「这是摆夹具，不是被测对象」。

/** 可写旁路连接（**只用于摆夹具**：把 `last_access` 拨到过去，让同日守卫不再吞掉增长）。 */
function withWritableDb<T>(dbPath: string, run: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 一条记忆的**后果列**（加固 / 置信度 / 软删状态都从这里读）。 */
interface MemoryStateRow {
  stability: number;
  access_count: number;
  last_access: number;
  confidence: number;
  deleted: number;
  deleted_at: number | null;
}

/** 读一条记忆的后果列（不存在 ⇒ `undefined`）。 */
function memoryState(id: string): MemoryStateRow | undefined {
  return withDb(
    fixture.dbPath,
    (db) =>
      db
        .prepare(
          'SELECT stability, access_count, last_access, confidence, deleted, deleted_at FROM memories WHERE id = ?',
        )
        .get(id) as MemoryStateRow | undefined,
  );
}

/** 某个实体还在不在（`mergeEntities` 的后果：源实体必须消失）。 */
function entityExists(entityId: string): boolean {
  return withDb(fixture.dbPath, (db) => {
    const row = db.prepare('SELECT count(*) AS n FROM entities WHERE id = ?').get(entityId) as {
      n: number;
    };
    return row.n > 0;
  });
}

/** 某条记忆挂在某个实体上的关联条数。 */
function entityLinkCount(memoryId: string, entityId: string): number {
  return withDb(fixture.dbPath, (db) => {
    const row = db
      .prepare('SELECT count(*) AS n FROM memory_entities WHERE memory_id = ? AND entity_id = ?')
      .get(memoryId, entityId) as { n: number };
    return row.n;
  });
}

/** 一条边的落库形态（`link` 的后果：`memory_id` 与权重都必须真的写进去）。 */
interface EdgeRow {
  subject_id: string;
  object_id: string;
  memory_id: string | null;
  weight: number;
}

/** 按谓词取一条边（每个用例用互不相同的谓词，避免撞 `idx_edge_spo` 唯一索引）。 */
function edgeByPredicate(predicate: string): EdgeRow | undefined {
  return withDb(
    fixture.dbPath,
    (db) =>
      db
        .prepare('SELECT subject_id, object_id, memory_id, weight FROM edges WHERE predicate = ?')
        .get(predicate) as EdgeRow | undefined,
  );
}

/** 边表总行数（`createMissing:false` 的「零写入」判据）。 */
function edgeCount(): number {
  return withDb(fixture.dbPath, (db) => {
    const row = db.prepare('SELECT count(*) AS n FROM edges').get() as { n: number };
    return row.n;
  });
}

/** 共激活边总数（`touch` 的后果：声明被真的消费成边）。 */
function coactCount(): number {
  return withDb(fixture.dbPath, (db) => {
    const row = db.prepare('SELECT count(*) AS n FROM coacts').get() as { n: number };
    return row.n;
  });
}

/** 一天多少毫秒（摆夹具用）。 */
const ONE_DAY_MS = 86_400_000;

describe('T05 · 后果层 ①：`sweep` 真的物理删了行（PLAN P0）', () => {
  it('★ `purgeDeletedDays: 30` ⇒ 40 天前的软删行**已消失**；1 天前的那条还在（成对）', () => {
    const stale = run<WriteResult>('write', { content: '40 天前被软删的那条' });
    const fresh = run<WriteResult>('write', { content: '1 天前被软删的那条' });

    // 摆夹具：用门面自己的 `now` 注入把 `deleted_at` 拨到过去（MCP 不转发时钟）
    const now = Date.now();
    fixture.store.forget(stale.id, {}, now - 40 * ONE_DAY_MS);
    fixture.store.forget(fresh.id, {}, now - 1 * ONE_DAY_MS);
    expect(memoryRow(stale.id)?.deleted).toBe(1);
    expect(memoryRow(stale.id)?.deleted_at).toBe(now - 40 * ONE_DAY_MS);

    // ① `purgeDeletedDays: 0` = 「一条都不清」（不是「清 0 天前的」）
    const zero = run<SweepResult>('sweep', { purgeDeletedDays: 0, vacuum: false });
    expect(zero.purged).toBe(0);
    expect(memoryRow(stale.id), 'purgeDeletedDays:0 把 40 天前的旧行删了').toBeDefined();
    expect(memoryRow(fresh.id)).toBeDefined();

    // ② `purgeDeletedDays: 30` ⇒ 只清 40 天前那条
    const swept = run<SweepResult>('sweep', { purgeDeletedDays: 30, vacuum: false });
    expect(swept.purged).toBe(1);
    expect(
      memoryRow(stale.id),
      '返回值说 purged=1，但行还在（空实现也能满足旧断言）',
    ).toBeUndefined();
    expect(memoryRow(fresh.id), '1 天前的软删行被误删（阈值方向反了）').toBeDefined();
  });
});

describe('T05 · 后果层 ②：`touch` 真的改了 stability / access_count（PLAN P0）', () => {
  it('★ 加固之后 `stability` 与 `access_count` 在库里真的变了', () => {
    const written = run<WriteResult>('write', { content: '要被加固的那条' });

    // 摆夹具：把 `last_access` 拨回 3 天前。
    // ⚠️ 不拨会踩**同日守卫**（`intervalDays < 1` ⇒ 不增长）⇒ `stabilityDelta` 恒为 0
    //   ⇒ 那条断言就退化成恒真（这正是复核说的「改坏实现也不会红」）。
    withWritableDb(fixture.dbPath, (db) => {
      db.prepare('UPDATE memories SET last_access = ? WHERE id = ?').run(
        Date.now() - 3 * ONE_DAY_MS,
        written.id,
      );
    });

    const before = memoryState(written.id);
    expect(before?.stability).toBeGreaterThan(0);
    const accessCountBefore = before?.access_count ?? -1;

    const outcomes = run<TouchOutcome[]>('touch', { ids: [written.id] });

    const after = memoryState(written.id);
    expect(
      after?.stability,
      'stability 在库里没涨（touch 只返回了一个好看的数字）',
    ).toBeGreaterThan(before?.stability ?? 0);
    expect(after?.access_count).toBe(accessCountBefore + 1);
    expect(after?.last_access).toBeGreaterThan(before?.last_access ?? 0);
    // 返回值与后果**对得上**（不是各说各话）
    expect(outcomes[0]?.stabilityDelta).toBeCloseTo(
      (after?.stability ?? 0) - (before?.stability ?? 0),
      6,
    );
  });
});

describe('T05 · 后果层 ③：`link` 真的把 memory_id 与权重写进 edges（PLAN P0）', () => {
  it('★ `memory_id` 被整个丢掉也会让旧断言全绿 ⇒ 这里回库查四列', () => {
    const written = run<WriteResult>('write', {
      content: '钱七在乙公司的同事是孙八',
      entities: ['钱七', '孙八'],
    });
    const result = run<LinkResult>('link', {
      subject: '钱七',
      predicate: '同事乙公司',
      object: '孙八',
      memoryId: written.id,
    });

    const edge = edgeByPredicate('同事乙公司');
    expect(edge, '`edges` 里没有这条边（link 只返回了一个对象）').toBeDefined();
    expect(edge?.subject_id).toBe(entityIdByName('钱七'));
    expect(edge?.object_id).toBe(entityIdByName('孙八'));
    expect(edge?.memory_id, 'memoryId 被吞了：返回值仍然好看，但证据链断了').toBe(written.id);
    expect(edge?.weight, '落库权重与返回值不一致').toBeCloseTo(result.weightAfter, 6);
    expect(edge?.weight).toBeGreaterThan(0);
  });
});

describe('T05 · 后果层 ④：`mergeEntities` 的后果（源实体消失 / 关联迁移）（PLAN P0）', () => {
  it('★ 合并之后 `entities` 里没有源实体，`memory_entities` 指向 target', () => {
    const written = run<WriteResult>('write', {
      content: '丙和丁是同一个人',
      entities: ['丙', '丁'],
    });
    const sourceId = entityIdByName('丁');
    const targetId = entityIdByName('丙');

    // 分母非空：合并前，这条记忆在源、目标两侧各有一条关联
    expect(entityLinkCount(written.id, sourceId), '夹具里源实体没挂上这条记忆').toBe(1);
    expect(entityLinkCount(written.id, targetId)).toBe(1);

    const result = run<MergeEntitiesResult>('mergeEntities', { sourceId, targetId });

    expect(entityExists(sourceId), '源实体还在（movedMemories 只是个数字）').toBe(false);
    expect(entityLinkCount(written.id, targetId), '关联没有迁到 target').toBe(1);
    expect(result.movedMemories).toBeGreaterThanOrEqual(0);
    // 源实体成了 target 的别名（§4.9.2 的后果：主名降级为别名）
    const aliases = withDb(fixture.dbPath, (db) =>
      db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?').all(targetId),
    ) as Array<{ alias: string }>;
    expect(aliases.map((row) => row.alias)).toContain('丁');
  });
});

describe('T05 · 后果层 ⑤：六个「参数只在 schema 里描述」的项', () => {
  it('★ `link{createMissing:false}` ⇒ `NOT_FOUND` 且 **`edges` 一行都没写**（零写入）', () => {
    const before = edgeCount();
    const error = expectMemoryError(
      () =>
        dispatchTool(fixture.store, 'link', {
          subject: '从未存在的实体甲',
          predicate: '自造关系',
          object: '从未存在的实体乙',
          createMissing: false,
        }),
      'NOT_FOUND',
    );
    expect(error.details.missingEntityNames).toBeDefined();
    expect(edgeCount(), '抛错前已经写了一半（§4.5 禁止「一边自动建、一边抛错」）').toBe(before);
    // 反例配对：同一对实体，`createMissing` 缺省（true）时**会**建出来
    const ok = run<LinkResult>('link', {
      subject: '从未存在的实体甲',
      predicate: '自造关系',
      object: '从未存在的实体乙',
    });
    expect(ok.weightAfter).toBeGreaterThan(0);
    expect(edgeByPredicate('自造关系')).toBeDefined();
    expect(edgeCount()).toBe(before + 1);
  });

  it('★ `restore{mergeInto}`：先 `CONFLICT`（带 conflictingId），合并后源行**消失**', () => {
    const first = run<WriteResult>('write', { content: '同一条事实（会撞 hash）' });
    run<{ ok: true }>('forget', { id: first.id });
    const second = run<WriteResult>('write', { content: '同一条事实（会撞 hash）' });
    expect(second.id).not.toBe(first.id);
    expect(second.merged).toBe(false);

    // ① 不传 mergeInto ⇒ CONFLICT 且**不改任何东西**
    const conflict = expectMemoryError(
      () => dispatchTool(fixture.store, 'restore', { id: first.id }),
      'CONFLICT',
    );
    expect(conflict.details.conflictingId).toBe(second.id);
    expect(memoryRow(first.id)?.deleted, '抛 CONFLICT 之后待恢复行被动了').toBe(1);

    // ② 传 mergeInto ⇒ 源行被合并掉（后果，不是返回值）
    run<{ ok: true }>('restore', { id: first.id, mergeInto: second.id });
    expect(memoryRow(first.id), 'mergeInto 之后源行还在（它只是被 undelete 了？）').toBeUndefined();
    expect(memoryRow(second.id)?.deleted).toBe(0);
  });

  it('★ `recall{includeArchived}`：归档记忆**只有在显式要的时候**才回来', () => {
    const written = run<WriteResult>('write', { content: '很久以前的一条归档记忆' });
    // 摆夹具：把 last_access 拨到 900 天前 ⇒ intensity 跌破归档线（不改任何阈值）
    withWritableDb(fixture.dbPath, (db) => {
      db.prepare('UPDATE memories SET last_access = ? WHERE id = ?').run(
        Date.now() - 900 * ONE_DAY_MS,
        written.id,
      );
    });

    const plain = run<RecallResult>('recall', { context: '很久以前的一条归档记忆' });
    expect(
      plain.hits.map((hit) => hit.id),
      '归档记忆出现在默认召回里',
    ).not.toContain(written.id);
    const withArchived = run<RecallResult>('recall', {
      context: '很久以前的一条归档记忆',
      includeArchived: true,
    });
    // 反例配对：开启之后必须**真的**回来（否则「默认不含」可以靠「永远不返回」通过）
    expect(withArchived.hits.map((hit) => hit.id)).toContain(written.id);
  });

  it('★ `write{mediaRef}` 只给一半 ⇒ `INVALID_INPUT`（互斥约束在库层，schema 管不到）', () => {
    expectMemoryError(
      () =>
        dispatchTool(fixture.store, 'write', { content: '多模态只给一半', mediaRef: '/tmp/a.png' }),
      'INVALID_INPUT',
    );
    // 反例配对：两个都给 ⇒ 过，且 `media_ref` / `media_type` 都落库
    const written = run<WriteResult>('write', {
      content: '多模态两个都给',
      mediaRef: '/tmp/b.png',
      mediaType: 'image',
    });
    const row = withDb(fixture.dbPath, (db) =>
      db
        .prepare('SELECT media_ref AS mediaRef, media_type AS mediaType FROM memories WHERE id = ?')
        .get(written.id),
    ) as { mediaRef: string | null; mediaType: string | null } | undefined;
    expect(row?.mediaRef).toBe('/tmp/b.png');
    expect(row?.mediaType).toBe('image');
  });

  it('★ `write{entityAliases}` ⇒ `entity_aliases` 里真的有那两条别名', () => {
    run<WriteResult>('write', {
      content: '别名写入测试',
      entityAliases: [{ name: '老周', aliases: ['周先生', '周总'] }],
    });
    const aliases = withDb(fixture.dbPath, (db) =>
      db.prepare('SELECT alias FROM entity_aliases ORDER BY alias').all(),
    ) as Array<{ alias: string }>;
    expect(aliases.map((row) => row.alias)).toEqual(['周先生', '周总']);
  });

  it('★ `write{confidence}` 是**真的落库**（不是只回一条 `warnings`）', () => {
    const written = run<WriteResult>('write', { content: '置信度 0.5', confidence: 0.5 });
    expect(memoryState(written.id)?.confidence).toBe(0.5);
    // 反例配对：缺省时库里是 0.7（§3 的默认值），说明这条断言读的是真列
    const defaulted = run<WriteResult>('write', { content: '置信度缺省' });
    expect(memoryState(defaulted.id)?.confidence).toBe(0.7);
    // 越界值在 MCP 层就被 schema 拦掉（0~1），不会走到库的 INVALID_INPUT
    const error = expectMemoryError(
      () => dispatchTool(fixture.store, 'write', { content: '置信度越界', confidence: 5 }),
      'INVALID_INPUT',
    );
    expect(error.details.path).toBe('$.confidence');
  });

  it('★ `write{emotion}`：越界被 schema 拒、合法值能写进去（**不**复算库的 difficulty 公式）', () => {
    // ⚠️ 为什么只到这一步：`emotion` **不是** `memories` 的列（它只参与算 `initialDifficulty`）
    //   ⇒ 想断言它的后果就得在测试里**重抄一遍库的公式**，那恰恰是会漂移的第二种实现。
    //   ⇒ 这里只验两件**可判**的事：越界被拒（`$.emotion`）、合法值不报错且难度落进合法区间。
    const outOfRange = expectMemoryError(
      () => dispatchTool(fixture.store, 'write', { content: '情绪越界', emotion: 2 }),
      'INVALID_INPUT',
    );
    expect(outOfRange.details.path).toBe('$.emotion');

    const written = run<WriteResult>('write', { content: '情绪 0.5', emotion: 0.5 });
    const difficulty = withDb(fixture.dbPath, (db) =>
      db.prepare('SELECT difficulty FROM memories WHERE id = ?').get(written.id),
    ) as { difficulty: number } | undefined;
    expect(difficulty?.difficulty).toBeGreaterThanOrEqual(0);
    expect(difficulty?.difficulty).toBeLessThanOrEqual(1);
  });
});
