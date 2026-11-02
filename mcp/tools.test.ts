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

  it('恰好 `COACT_BATCH_MAX` 条 ⇒ 不抛（边界是 `>` 而不是 `>=`，与上一条成对）', () => {
    const written = run<WriteResult>('write', { content: '共激活边界内的陪跑数据' });
    const justEnough = Array.from({ length: DEFAULT_PARAMS.COACT_BATCH_MAX }, () => ({
      memoryId: written.id,
      seedIds: [] as string[],
    }));
    expect(() =>
      dispatchTool(fixture.store, 'touch', { ids: [written.id], coActivateWith: justEnough }),
    ).not.toThrow();
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
  it('★ `mcp/tools.ts` 不 import SDK；`src/**` 与 `mcp/**` 里命中该包名的文件**只有** `mcp/server.ts`', () => {
    const scanned = [
      ...listTsFiles(join(REPO_ROOT, 'src')),
      ...listTsFiles(join(REPO_ROOT, 'mcp')),
    ];
    const hits = scanned
      .filter((file) => readFileSync(file, 'utf8').includes(SDK_PACKAGE_MARK))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'));

    expect(scanned.length).toBeGreaterThan(50); // 分母非空（别让空目录给出假绿）
    expect(hits, 'SDK 的耦合面被扩散了：升级 SDK 就得改多处').toEqual(['mcp/server.ts']);
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
