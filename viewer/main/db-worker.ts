/**
 * ★ **库线程**（worker_threads 入口）—— 阶段 5 · P5-T01（设计 §1.1 架构图最下层）。
 *
 * **全仓库唯一持有「查看器侧库句柄」的地方**，两处：
 *   ① `MemoryStore({ dbPath, readonly: true })` —— 7 个读方法走它（§7.1 保证 3/4）；
 *   ② `openDatabase({ dbPath, readonly: true })` —— 面板 4/6 的原始 SELECT 走它，
 *      每条 SQL **先过 `guard()`**（§7.1 保证 ②）。
 *
 * ⚠️ **为什么必须在 worker 里**（§7.3 硬要求）：库是**全同步 API**，一次 `recall()` /
 *   `clusters()` 会**阻塞调用它的线程**。`clusters()` 的现场重算是几百毫秒量级
 *   ⇒ 落在主线程上就是「面板点开即冻结」。放在 worker 里，那次阻塞只发生在库线程。
 *
 * ⚠️ **本文件是 `viewer/**` 里唯一允许 `import 'better-sqlite3'` 的文件**
 *   （设计 §7.1；由 `viewer-worker.test.ts` 的源码扫描断言）。
 *   ⚠️ 它**不 import `electron`**：它是纯 Node，才能在 vitest 里被真的起一个 Worker 跑。
 *
 * ⚠️ **它不做任何"业务计算"**：曲线（面板 2）用的是 `src/core/decay.ts` 的**纯函数**
 *   （§7.1 保证 ③：核心计算复用纯函数算法模块，**绝不调用写操作代码**），
 *   renderer 只负责把算好的点画出来。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort } from 'node:worker_threads';

import type Database from 'better-sqlite3';

import {
  MS_PER_DAY,
  type MemoryLayer,
  archiveAt,
  intensity,
  layerOf,
} from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { openDatabase } from '../../src/db/connection.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import type { RecallOptions } from '../../src/store/recall.js';
import { readStoredParams } from '../../src/store/setParams.js';
import {
  LOG_PAGE_SIZE,
  type LogPage,
  type LogQuery,
  type MemoryDetail,
  type RecallSimInput,
  type RecallSimResult,
  type SqlRow,
  type WorkerRequest,
  type WorkerResponse,
  type WorkspaceError,
} from '../shared/protocol.js';
import { type SqlQueryName, isSqlQueryName } from '../shared/sql-names.js';
import { CONTENT_HISTORY_PAGE_SIZE, GRAPH_NODE_LIMIT, SQL_QUERIES } from './queries.js';
import { guard } from './sql-guard.js';

/**
 * ★ 只读查看器**没有** embedder（ADR-10：库内不接模型、不读环境变量、不发网络请求）。
 *
 * ⚠️ 它不是「配错了」而是**设计如此**：面板 3 因此要**显式标注**「本次未执行向量路」
 *   + 「只读查看器未配置 embedder」两条，而不是把 `vectorPart = 0` 当成「向量路跑了但没命中」。
 *   ⚠️ 它与 `RecallSimResult.vectorRouteRan` **不是同一个量**：
 *     `vectorRouteRan` 来自 `explain.routes.vector.ran`（本次跑没跑），本常量说的是
 *     「**这个进程有没有能力算查询向量**」⇒ 两个字段同时给，面板才不会把二者混为一谈。
 */
const VIEWER_HAS_EMBEDDER = false;

/** 面板 2 曲线的采样点数（设计 §4.1：`MemoryDetail.curve` 采 120 点）。 */
export const CURVE_SAMPLE_COUNT = 120;

// ═══════════════════════════════════════════════════════════════════════════
// 错误：跨进程的唯一线上形态
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 查看器自己的拒绝（`SQL_GUARD_REJECTED`）—— **五个库错误码之外唯一的查看器自有码**。
 *
 * ⚠️ 它**不可能**从 `src/**` 抛出来（库不知道防护层的存在）⇒ 只能在这里定义，
 *   而 `MemoryError` 的五个码是封闭集合（扩码是破坏性变更）⇒ 不复用 `MemoryError`。
 */
export class WorkspaceRejection extends Error {
  /** 线上错误码（恒 `SQL_GUARD_REJECTED`）。 */
  readonly code = 'SQL_GUARD_REJECTED' as const;

  /** 结构化详情（进 `WorkspaceError.details`）。 */
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkspaceRejection';
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 从任意异常里取一段人类可读的说明（`Error` / 字符串 / 其它都兜住）。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * ★ **把异常搬成 `WorkspaceError`** —— 错误跨进程序列化**只在这里做一次**（设计 §7.2）。
 *
 * ⚠️ `MemoryError` **不能**直接 `postMessage`：`code` / `details` 是**自有属性**，
 *   结构化克隆只搬 `message` / `stack` ⇒ 还原出来的对象上 `code` 是 `undefined`
 *   ⇒ 面板再也分不清「库里没有」与「查询错了」。
 *
 * ⚠️ **码的封闭性**（设计 §7.2）：线上码只有「五个库码 + `SQL_GUARD_REJECTED`」。
 *   超时与「库不响应」是同一件事 ⇒ 归 `DATABASE_BUSY`（`details.reason = 'worker_timeout'`，
 *   由 `worker-host.ts` 打）。
 *   而**预期之外的异常**（裸 SQLite 码 / `TypeError`）同样归 `DATABASE_BUSY` 并带
 *   `details.reason = 'worker_unexpected_error'` + `details.cause`：
 *   —— 这不是「把 bug 说成库忙」，而是**不新增第三种码**的必然代价；
 *   真正的根因在 `details.cause` 里（面板的 `StatusBlock` 会把 `details` 的 JSON 原样显示），
 *   所以「排障信息没丢」，只是「码这一层被归一」。
 */
export function toWorkspaceError(error: unknown): WorkspaceError {
  if (error instanceof MemoryError) {
    return { code: error.code, message: error.message, details: { ...error.details } };
  }
  if (error instanceof WorkspaceRejection) {
    return { code: error.code, message: error.message, details: { ...error.details } };
  }

  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (candidate !== null && typeof candidate === 'object' && typeof candidate.code === 'string') {
    // 裸的 SQLite 错误码（`SQLITE_ERROR` / `SQLITE_MISUSE` …）：
    // ⚠️ 依 §11.2「裸的 SQLite 错误码绝不能抛给调用方」⇒ 不把它当 code 穿出去，
    //   只放进 details 供排障。
    return {
      code: 'DATABASE_BUSY',
      message: messageOf(error),
      details: { reason: 'worker_unexpected_error', sqliteCode: candidate.code },
    };
  }

  return {
    code: 'DATABASE_BUSY',
    message: messageOf(error),
    details: { reason: 'worker_unexpected_error', cause: messageOf(error) },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 库线程状态
// ═══════════════════════════════════════════════════════════════════════════

/** 库线程打开之后的全部状态。 */
export interface WorkerState {
  /** 只读门面（7 个读方法走它）。 */
  store: MemoryStore;
  /** 只读旁路连接（面板 4/6 的原始 SELECT 走它，每条先过 `guard`）。 */
  raw: Database.Database;
  /** 生效参数（只读地从 `meta.params` 读；缺省用 `DEFAULT_PARAMS`）。 */
  params: Params;
  /** 库文件路径（主进程给的，**从不**由 renderer 给）。 */
  dbPath: string;
}

/**
 * 打开库：**两处 `{ readonly: true, fileMustExist: true }`**（§7.1 保证 ①）。
 *
 * ⚠️ 两处都靠仓库已有的 `openDatabase({ readonly: true })` 落 `fileMustExist: true`
 *   （它自己先 `existsSync`，不存在就抛 `NOT_FOUND`）⇒ 「只读标志」不是靠自觉，
 *   而是靠「打开一个不存在的路径必须抛 `NOT_FOUND`」这条断言钉住的。
 */
export function openWorkerState(dbPath: string): WorkerState {
  const store = new MemoryStore({ dbPath, readonly: true });
  const raw = openDatabase({ dbPath, readonly: true });
  // ⚠️ 参数只读地取（与 `MemoryStore` 构造期同一条路径：先库里存的，否则默认表）
  const params: Params = { ...(readStoredParams(raw) ?? DEFAULT_PARAMS) };
  return { store, raw, params, dbPath };
}

/** 关掉库线程状态（先 flush 日志由 `close()` 负责，这里只断句柄）。 */
export function closeWorkerState(state: WorkerState): void {
  state.store.close();
  state.raw.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// 面板 2：详情 + 衰减曲线（**库线程算好**，renderer 只画）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 构造面板 2 的详情。
 *
 * ⚠️ **renderer 一律不读时钟、不做衰减计算**（设计 §7.6 / §7.1 保证 ③）：
 *   这里用 `decay.ts` 的**纯函数**算好 `curve` / `layerMarks` / `archiveAt` / `dropOutL3At`，
 *   renderer 拿到的是一串坐标点。
 *
 * @param state 库线程状态
 * @param id 记忆 uuid
 * @param now 注入时钟（缺省取真实时钟；`check:clock` 只扫 `src/` ⇒ 这里允许 `Date.now()`）
 * @returns 详情；记忆不存在 ⇒ `null`（`get` 是读接口，**缺失用返回值表达**，§11.2）
 */
export function buildMemoryDetail(
  state: WorkerState,
  id: string,
  now?: number,
): MemoryDetail | null {
  const at = now ?? Date.now();
  const view = state.store.get(id, at);
  if (view === null) {
    return null;
  }

  // 纯函数的入参形状（`DecayMemoryInput` 只要三个字段）
  const memory = {
    stability: view.stability,
    pin_factor: view.pinFactor,
    last_access: view.lastAccess,
  };

  /** 归档时刻（`intensity` 恰好跌到 `ARCHIVE_LINE` 的那一刻，§9.4.1 / ADR-18）。 */
  const archivedAt = archiveAt(memory, state.params);

  // 曲线的横轴：从「最近一次访问」到「跌入归档之后一点」。
  // ⚠️ `at` 可能已经远晚于归档时刻（一条很旧的记忆）⇒ 取两者较大者，再把跨度多留 10%，
  //   这样曲线不会在最有信息量的那一段被截断。
  const start = view.lastAccess;
  const span = archivedAt - start;
  const end = Math.max(archivedAt, at) + span * 0.1;

  const curve: Array<{ t: number; intensity: number; layer: MemoryLayer }> = [];
  for (let index = 0; index < CURVE_SAMPLE_COUNT; index += 1) {
    const t = start + ((end - start) * index) / (CURVE_SAMPLE_COUNT - 1);
    const value = intensity(memory, t);
    curve.push({ t: Math.round(t), intensity: value, layer: layerOf(value, state.params) });
  }

  // 「跌出 L3」的时刻：解 `exp(-Δt/τ) = THRESHOLD_L3` ⇒ `Δt = τ × ln(1 / THRESHOLD_L3)`。
  // ⚠️ 用**公式**而不是反解当前 `intensity`：`intensity` 有 `min(1, …)` 上界，
  //   刚写入不久（`Δt < 0` 或极小）时反解会得到 `-0` 附近的无意义值。
  const tauMs = view.effectiveStability * MS_PER_DAY;
  const dropOutL3Raw = start + tauMs * Math.log(1 / state.params.THRESHOLD_L3);
  const dropOutL3At = dropOutL3Raw > at ? Math.round(dropOutL3Raw) : null;

  return {
    view,
    curve,
    layerMarks: {
      l3: state.params.THRESHOLD_L3,
      l2: state.params.THRESHOLD_L2,
      archived: state.params.ARCHIVE_LINE,
    },
    archiveAt: Math.round(archivedAt),
    dropOutL3At,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 面板 3：召回模拟（**reinforce 恒 false**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 跑一次召回模拟。
 *
 * ⚠️ **`reinforce` 写死 `false`**（不是「跟着入参走」）：`reinforce: true` 是**采纳**
 *   （会加固 topN 并写事件），属于宿主，不属于只读观察器。
 *   ⚠️ 类型上 `RecallSimInput.reinforce` 已经是 `false`，但 IPC 收的是 `unknown`
 *   ⇒ 这里再写死一次（`ipc.ts` 还有第三道：把外来字段剔掉）。
 *
 * ⚠️ **`explain: true` 是刻意的**：它要产出 `explain.routes.vector.ran`
 *   （面板 3 的「本次未执行向量路」必须来自这个**直接投影**，不是猜）。
 *   代价是 `appendEvent()` 会尝试写一条 `recall` 事件 —— 只读实例上它**短路**（§7.1 第 4 条），
 *   业务返回值照常给出。这正是 T02 要断言的那条。
 */
export function runRecallSimulation(
  state: WorkerState,
  input: RecallSimInput,
  now?: number,
): RecallSimResult {
  const options: RecallOptions = {
    context: input.context,
    explain: true,
    reinforce: false,
    ...(input.topN === undefined ? {} : { topN: input.topN }),
    ...(input.entityNames === undefined ? {} : { entityNames: input.entityNames }),
    ...(now === undefined ? {} : { now }),
  };

  const result = state.store.recall(options);

  return {
    // 只投影面板要用的字段（少送一个字段 = renderer 少一个能被误用的东西）
    hits: result.hits.map((hit) => ({
      id: hit.id,
      content: hit.content,
      layer: hit.layer,
      intensity: hit.intensity,
      score: hit.score,
      fromText: hit.fromText,
      fromVector: hit.fromVector,
      fromGraph: hit.fromGraph,
      ...(hit.breakdown === undefined ? {} : { breakdown: hit.breakdown }),
    })),
    vectorRouteRan: result.explain?.routes.vector.ran ?? false,
    hasEmbedder: VIEWER_HAS_EMBEDDER,
    suppressed: result.suppressed,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 面板 4 / 6：原始 SELECT（每条先过 guard）
// ═══════════════════════════════════════════════════════════════════════════

/** 把外部传进来的数钳到 `[min, max]`（`unknown` 一律当缺省值）。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 取一个必填的字符串参数。 */
function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value === '') {
    throw MemoryError.invalidInput(`参数 ${key} 必须是非空字符串`, { key });
  }
  return value;
}

/**
 * 按查询名绑定命名参数（**参数上界一律来自常量，不信调用方**）。
 *
 * ⚠️ `nodeLimit` / `limit` 都**钳**在常量以内：即使 renderer 传 `1e9`，
 *   真正执行的 SQL 也只会取 `GRAPH_NODE_LIMIT` / `CONTENT_HISTORY_PAGE_SIZE` 条
 *   ⇒ 「按 LIMIT 抽样」这件事不是靠调用方守规矩。
 */
function bindQueryParams(name: SqlQueryName, params: unknown): Record<string, unknown> {
  const source = (params ?? {}) as Record<string, unknown>;
  const memoryId = requireString(source.memoryId, 'memoryId');

  switch (name) {
    case 'graphTwoHop':
      return {
        memoryId,
        nodeLimit: clampNumber(source.nodeLimit, GRAPH_NODE_LIMIT, 1, GRAPH_NODE_LIMIT),
      };
    case 'contentHistoryPage':
      return {
        memoryId,
        limit: clampNumber(source.limit, CONTENT_HISTORY_PAGE_SIZE, 1, CONTENT_HISTORY_PAGE_SIZE),
        offset: clampNumber(source.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      };
    case 'contentHistoryCount':
      // 聚合恒定一行 ⇒ `limit` 恒 1（见 `queries.ts` 文件头的说明）
      return { memoryId, limit: 1 };
  }
}

/** 把一行的值收敛到 `SqlRow` 允许的三种类型（`string | number | null`）。 */
function toSqlRow(row: Record<string, unknown>): SqlRow {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      out[key] = value;
    } else {
      // ⚠️ BLOB（`Buffer`）与 `bigint` 都不在 `SqlRow` 的允许集里。
      //   本文件的 SQL 常量刻意不选这类列 ⇒ 走到这里说明**常量被改坏了**，
      //   把它转成字符串而不是丢掉：面板上看得见「这里有异常值」比静默 null 更可查。
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * 执行一条**已登记**的查询。
 *
 * @throws {WorkspaceRejection} `SQL_GUARD_REJECTED`（防护层拒绝 / 查询名不认识）
 * @throws {MemoryError} `INVALID_INPUT`（绑定参数缺失）
 */
export function runSelect(
  state: WorkerState,
  name: SqlQueryName,
  params: unknown,
): ReadonlyArray<SqlRow> {
  // ⚠️ 类型上说 `name` 是 `SqlQueryName`，但 IPC 边界上的东西**运行期**是 `unknown`
  //   ⇒ 这里真的判一次（否则 `SQL_QUERIES[name]` 会得到 `undefined`，
  //     而 `guard(undefined)` 的报错信息会把排障方向带偏）
  if (!isSqlQueryName(name)) {
    throw new WorkspaceRejection(`未知的查询名：${String(name)}`, {
      reason: 'unknown_query_name',
      name: String(name),
    });
  }

  const sql = SQL_QUERIES[name];

  // ★ §7.1 保证 ②：**每次执行前必过**（不是"上线前审一遍代码"）
  const verdict = guard(sql);
  if (!verdict.ok) {
    throw new WorkspaceRejection(`SQL 防护层拒绝了查询 ${name}：${verdict.reason}`, {
      name,
      reason: verdict.reason,
      verb: verdict.verb,
    });
  }

  const statement = state.raw.prepare(verdict.sql);
  const bound = bindQueryParams(name, params);
  const rows = statement.all(bound) as Array<Record<string, unknown>>;
  return rows.map(toSqlRow);
}

// ═══════════════════════════════════════════════════════════════════════════
// 面板 5：只**读** `<数据目录>/logs/`
// ═══════════════════════════════════════════════════════════════════════════

/** 一行的级别（`§8.1` 的格式里定时器第二列；解析不出来就当 `info`）。 */
function parseLevel(line: string): 'info' | 'warn' | 'error' {
  const parts = line.split(/\s{2,}/);
  const level = parts[1];
  return level === 'warn' || level === 'error' || level === 'info' ? level : 'info';
}

/**
 * 读一页日志（**只读**：只用 `readFileSync` / `readdirSync` / `existsSync`）。
 *
 * ⚠️ **不经数据库**（§8.3：`logs/` 只作人类排障，重放以 `events` 为准）。
 * ⚠️ 目录不存在 ⇒ 返回空页而**不抛错**：新库本来就没有日志目录
 *   （它不是「错误」，是「还没有」——面板 5 的空态靠这个区分）。
 *
 * @param dataDir 数据目录（= 库文件所在目录，与 `FileLogger` 的口径一致）
 * @param query 年月日 + 关键字 + 分页
 */
export function readLogPage(dataDir: string, query: LogQuery): LogPage {
  const year = String(query.year);
  const month = String(query.month).padStart(2, '0');
  const monthDir = join(dataDir, 'logs', year, month);

  if (!existsSync(monthDir)) {
    return { lines: [], total: 0 };
  }

  // 文件清单：给了 `day` 就是那一天，否则按文件名升序把整月拼起来
  const fileNames =
    query.day === undefined
      ? readdirSync(monthDir)
          .filter((name) => name.endsWith('.log'))
          .sort()
      : [`${month}-${String(query.day).padStart(2, '0')}.log`];

  const keyword = query.keyword === undefined ? undefined : query.keyword.trim().toLowerCase();
  const matched: Array<{ no: number; raw: string; level: 'info' | 'warn' | 'error' }> = [];

  for (const fileName of fileNames) {
    const filePath = join(monthDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    const text = readFileSync(filePath, 'utf8');
    const rows = text.split('\n');
    for (let index = 0; index < rows.length; index += 1) {
      const raw = rows[index] ?? '';
      if (raw.trim() === '') {
        continue;
      }
      if (keyword !== undefined && !raw.toLowerCase().includes(keyword)) {
        continue;
      }
      // `no` = 该行在**文件内**的行号（1 起）
      matched.push({ no: index + 1, raw, level: parseLevel(raw) });
    }
  }

  const offset = clampNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampNumber(query.limit, LOG_PAGE_SIZE, 1, LOG_PAGE_SIZE);
  return { lines: matched.slice(offset, offset + limit), total: matched.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// 消息分发
// ═══════════════════════════════════════════════════════════════════════════

/** 处理一条请求；**永不抛错**（一律翻译成 `WorkerResponse`）。 */
function handleRequest(request: WorkerRequest, current: () => WorkerState | undefined): unknown {
  const state = current();
  if (request.kind === 'open') {
    if (state !== undefined) {
      closeWorkerState(state);
    }
    return openWorkerState(request.dbPath);
  }

  if (state === undefined) {
    throw MemoryError.notFound('库线程还没打开库（先发 kind=open）', {
      reason: 'worker_not_opened',
    });
  }

  switch (request.kind) {
    case 'call':
      switch (request.method) {
        case 'stats':
          return state.store.stats(request.args[0] as number | undefined);
        case 'get':
          return buildMemoryDetail(
            state,
            requireString(request.args[0], 'id'),
            request.args[1] as number | undefined,
          );
        case 'recall':
          return runRecallSimulation(state, request.args[0] as RecallSimInput);
        case 'clusters':
          // ⚠️ 门面的签名是 `clusters(options?, now?)`；`ReadPort` 只给 `now`
          //   ⇒ 第一个参数必须显式 `undefined`（「读已发布快照」那条路径）
          return state.store.clusters(undefined, request.args[0] as number | undefined);
        case 'inhibitionTrace':
          return state.store.inhibitionTrace(requireString(request.args[0], 'context'));
        case 'verifyIntegrity':
          return state.store.verifyIntegrity();
      }
      throw MemoryError.invalidInput('未知的读方法', { method: request.method });
    case 'select':
      return runSelect(state, request.name, request.params);
    case 'logs':
      return readLogPage(dirname(state.dbPath), request.query);
    case 'close':
      closeWorkerState(state);
      return null;
  }
}

// ── worker 入口（只有真的作为 Worker 被加载时才挂监听）──
if (parentPort !== null) {
  const port = parentPort;
  let state: WorkerState | undefined;

  port.on('message', (request: WorkerRequest) => {
    const id = request.id;
    let response: WorkerResponse;
    try {
      const data = handleRequest(request, () => state);
      if (request.kind === 'open') {
        state = data as WorkerState;
        response = { id, ok: true, data: null };
      } else if (request.kind === 'close') {
        state = undefined;
        response = { id, ok: true, data: null };
      } else {
        response = { id, ok: true, data };
      }
    } catch (error) {
      response = { id, ok: false, error: toWorkspaceError(error) };
    }
    port.postMessage(response);
  });
}
