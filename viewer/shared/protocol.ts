/**
 * ★ 渲染进程能看到的**全部**数据能力 —— 阶段 5 · P5-T02/P5-T03（§4.1 / §4.2）。
 *
 * 本文件是「只读」这件事在**类型层**的落点，一共三件事：
 *   ① `ReadPort`：8 个方法，**没有写方法、没有"传 SQL 文本"的口子**；
 *   ② 面板要用的**行形状**（`MemoryDetail` / `RecallSimResult` / `LogPage` / `SqlRow`）；
 *   ③ worker 消息协议（`WorkerRequest` / `WorkerResponse`）与跨进程错误的唯一线上形态
 *      （`WorkspaceError`）。
 *
 * ⚠️ **所有类型都必须可 JSON 序列化**（除 `Promise` 外壳）：它们要过
 *   `structuredClone`（`worker_threads.postMessage`）与 Electron 的 IPC 序列化。
 *   ⇒ 这里**不许**出现 `MemoryError` 实例、`Date`、`Map`、`Buffer`、函数、带方法的类。
 *   最典型的一条：`MemoryError` 的 `code` / `details` 是**自有属性**，
 *   直接 `postMessage` 会退化成 `{}`（结构化克隆丢自有属性）⇒ 必须手动搬进 `WorkspaceError`。
 */

import type { MemoryLayer } from '../../src/core/decay.js';
import type { ClustersResult } from '../../src/store/clusters.js';
import type { MemoryView } from '../../src/store/get.js';
import type { InhibitionTraceResult } from '../../src/store/inhibition.js';
import type { VerifyIntegrityReport } from '../../src/store/maintain.js';
import type { Hit, RecallSuppressed } from '../../src/store/recall.js';
import type { MemoryStats } from '../../src/store/stats.js';
import type { SqlQueryName, SqlQueryParams } from './sql-names.js';

/**
 * ★ 渲染进程能拿到的**全部**数据能力 —— **8 个方法**，写死在下面的 `READ_PORT_METHODS`。
 *
 * ⚠️ 这 8 个方法 = §6 的 7 个读方法（`recall` / `stats` / `get` / `close` / `clusters` /
 *   `inhibitionTrace` / `verifyIntegrity`）里**去掉 `close`**（关库归库线程，renderer 无权关）
 *   **+ `select`**（面板 4/6 的原始 SELECT，先过 `sql-guard`）
 *   **+ `logs`**（面板 5 读 `logs/` 目录）。
 *
 * ⚠️ **没有任何写方法**（§7.1 的 16 个写方法一个都不在这里），
 *   **也没有"传 SQL 文本"的通道**（`select` 只收**名字**，SQL 文本在库线程的常量表里）。
 */
export interface ReadPort {
  /** 面板 1：全库统计（含 `vectorBackend` / `embeddedRatio`）。 */
  stats(now?: number): Promise<MemoryStats>;
  /** 面板 2：单条记忆详情 + 库线程算好的衰减曲线（查不到 ⇒ `null`，不抛错）。 */
  get(id: string, now?: number): Promise<MemoryDetail | null>;
  /** 面板 3：召回模拟（**永远 `reinforce: false`**，见 `RecallSimInput`）。 */
  recall(input: RecallSimInput): Promise<RecallSimResult>;
  /** 面板 7：簇快照。 */
  clusters(now?: number): Promise<ClustersResult>;
  /** 面板 3 的诊断补充：侧抑制候选（只接 `context`，与 `recall` 同口径）。 */
  inhibitionTrace(context: string): Promise<InhibitionTraceResult>;
  /** 面板 1 / 7：一致性自检报告（**纯读**，只读实例上也必须可用）。 */
  verifyIntegrity(): Promise<VerifyIntegrityReport>;
  /** 面板 4/6：原始 SELECT（只收**名字**，SQL 文本在库线程）。 */
  select<N extends SqlQueryName>(
    name: N,
    params: SqlQueryParams[N],
  ): Promise<ReadonlyArray<SqlRow>>;
  /** 面板 5：只**读** `<dataDir>/logs/` 目录（不经数据库）。 */
  logs(query: LogQuery): Promise<LogPage>;
}

/**
 * ★ 写死的分母：`ReadPort` 的方法名清单（**8 条**）。
 *
 * ⚠️ `satisfies ReadonlyArray<keyof ReadPort>` ⇒ 数组里写错一个名字**编译期**就红；
 *   `as const` ⇒ 元素是字面量类型，测试可以拿它做集合运算。
 *   ⚠️ 但 `satisfies` **不保证"不漏"**（少写两个照样编译过）
 *   ⇒ 「恰好 8 个」这条由 `tests/integration/viewer-worker.test.ts` 的
 *   `READ_PORT_METHODS.length === 8` + 「假端口的方法集恰好 8 个」共同钉住。
 */
export const READ_PORT_METHODS = [
  'stats',
  'get',
  'recall',
  'clusters',
  'inhibitionTrace',
  'verifyIntegrity',
  'select',
  'logs',
] as const satisfies ReadonlyArray<keyof ReadPort>;

/**
 * 召回模拟器的入参：**只有**这些字段能被 renderer 指定。
 *
 * ⚠️ `reinforce` 的类型是 `false`（不是 `boolean`）⇒ 「加固本次 topN」这个写行为
 *   在**类型层**就不接受 `true`：它是「采纳」，属于宿主，不属于查看器。
 *   ⚠️ 但**只靠类型不够**：`ipc.ts` 收到的是 `unknown`（IPC 没有类型）
 *   ⇒ 那里还会**运行时**把 `reinforce` 强制成 `false`（见 `ipc.ts` 的 `sanitizeRecallInput`）。
 */
export interface RecallSimInput {
  /** 召回上下文（必传）。 */
  context: string;
  /** 取前 N 条（库侧限制 `1~8`）。 */
  topN?: number;
  /** 调用方抽好的实体名（与库侧 `entityNames` 同义）。 */
  entityNames?: string[];
  /** ⚠️ 恒为 `false`（写在库线程侧，**不接受 renderer 传 `true`**）。 */
  readonly reinforce?: false;
}

/**
 * 面板 2 的详情：视图 + **库线程算好的**曲线。
 *
 * ⚠️ **renderer 不做任何时间计算**（§7.6）：`curve[].t` 已经是绝对 epoch 毫秒，
 *   `layerMarks` / `archiveAt` / `dropOutL3At` 也都在库线程里用
 *   `intensity()` / `layerOf()` / `archiveAt()` 算好。
 *   ⇒ 「核心计算复用纯函数算法模块」这条（§7.1 保证 ③）因此变成**结构性事实**：
 *     renderer 手上根本没有 `stability` 的曲线公式，只有一串坐标点。
 */
export interface MemoryDetail {
  /** 记忆的静态视图（`get()` 的原样返回）。 */
  view: MemoryView;
  /** 采 120 点，`t` 从 `lastAccess` 到「跌出归档」之后一点，`t` 是 epoch 毫秒。 */
  curve: ReadonlyArray<{ t: number; intensity: number; layer: MemoryLayer }>;
  /** 层级分界线的强度值（`THRESHOLD_L3` / `THRESHOLD_L2` / `ARCHIVE_LINE`）⇒ 曲线画横线用。 */
  layerMarks: { l3: number; l2: number; archived: number };
  /** 由 `archiveAt()` 算出的「跌入归档」时刻（epoch 毫秒）。 */
  archiveAt: number;
  /** 由「当前 intensity 与 τ」反推的「跌出 L3」时刻；已跌出则为 `null`。 */
  dropOutL3At: number | null;
}

/**
 * 面板 3 的结果：命中 + 诊断 + 被抑制（**三者分开**，不许混进同一根柱）。
 *
 * ⚠️ `hits` 用 `Pick<Hit, …>` 而不是整个 `Hit`：
 *   面板只需要「画柱 + 标来源」所需的字段，**不需要** `content_hash` 之类的内部列
 *   （少送一个字段，renderer 就少一个能被误用的东西）。
 */
export interface RecallSimResult {
  /** 命中的精简投影（按 `score` 降序，库侧已排好）。 */
  hits: ReadonlyArray<
    Pick<
      Hit,
      | 'id'
      | 'content'
      | 'layer'
      | 'intensity'
      | 'score'
      | 'fromText'
      | 'fromVector'
      | 'fromGraph'
      | 'breakdown'
    >
  >;
  /** `explain.routes.vector.ran` 的**直接投影**（不是"配了 embedder 没有"的猜测）。 */
  vectorRouteRan: boolean;
  /** 只读查看器是否配了 embedder（默认 `false`）。 */
  hasEmbedder: boolean;
  /** 被侧抑制挤掉的候选（**单列一栏**，不进柱状图）。 */
  suppressed: ReadonlyArray<RecallSuppressed>;
}

/** 面板 5 的查询。 */
export interface LogQuery {
  /** 年（四位数）。 */
  year: number;
  /** 月（`1~12`）。 */
  month: number;
  /** 日（不传 ⇒ 整个月）。 */
  day?: number;
  /** 关键字过滤（不传 ⇒ 不过滤）。 */
  keyword?: string;
  /** 跳过前面几行（默认 0）。 */
  offset?: number;
  /** 最多取几行（默认 `LOG_PAGE_SIZE`）。 */
  limit?: number;
}

/** 面板 5 的一页结果。 */
export interface LogPage {
  /** 本页的行（`no` 是该行在**文件内**的行号，从 1 起）。 */
  lines: ReadonlyArray<{ no: number; raw: string; level: 'info' | 'warn' | 'error' }>;
  /** 过滤后命中的总行数（分页控件要分母）。 */
  total: number;
}

/**
 * worker → renderer 的**行**类型（SQL 结果是"扁的"，不猜列语义）。
 *
 * ⚠️ 三个取值而不是 `unknown`：`better-sqlite3` 对 TEXT / INTEGER / REAL 分别给
 *   `string` / `number` / `number`，NULL 给 `null`。
 *   BLOB（`Buffer`）**不在允许集里** —— 面板用的那几条 SQL 刻意不选 `embedding` 之类的列
 *   （见 `viewer/main/queries.ts` 的注释）。
 */
export type SqlRow = Readonly<Record<string, string | number | null>>;

/**
 * ★ 跨进程错误的**唯一**线上形态。
 *
 * ⚠️ `MemoryError` **不能直接** `postMessage`：`Error` 的 `code` / `details` 是**自有属性**，
 *   结构化克隆只搬 `message` / `stack` ⇒ 还原出来的对象上 `code` 是 `undefined`
 *   ⇒ 面板再也分不清「库里没有」与「查询错了」。
 *   ⇒ 本类型是错误跨进程的**唯一**载体；**序列化只在 `db-worker.ts` 一处做**，
 *     `useReadCall` 只消费它。
 *
 * ⚠️ `code` 的取值 = 五个 `MemoryError` 码 + 查看器自己的 `SQL_GUARD_REJECTED`
 *   + 超时归一到 `DATABASE_BUSY`（`details.reason = 'worker_timeout'`）。
 *   **不新增第三个查看器专用码**（§7.2）：超时与「库不响应」是同一件事。
 */
export interface WorkspaceError {
  /** 错误码（五个库码之一，或 `SQL_GUARD_REJECTED`；超时用 `DATABASE_BUSY`）。 */
  code: string;
  /** 人类可读说明（**不是**给用户看的最终文案：面板显示的是码 + `details`）。 */
  message: string;
  /** 结构化详情（原样搬运；面板以 JSON 展示）。 */
  details: Record<string, unknown>;
}

/**
 * ★ 主进程 → 库线程的请求。
 *
 * ⚠️ **两条硬规则**（都进断言）：
 *   ① `kind` 的联合里**没有** `'write' | 'exec' | 'sql'`（裸 SQL 文本）
 *     ⇒ renderer 拿不到「随便执行」的口子；
 *   ② `open` 的 `dbPath` **只能由主进程给**（`ipc.ts` 不接受 renderer 传路径）
 *     ⇒ 面板不能打开任意文件。
 */
export type WorkerRequest =
  | { id: number; kind: 'open'; dbPath: string }
  | {
      id: number;
      kind: 'call';
      method: Exclude<keyof ReadPort, 'select' | 'logs'>;
      args: unknown[];
    }
  | { id: number; kind: 'select'; name: SqlQueryName; params: unknown }
  | { id: number; kind: 'logs'; query: LogQuery }
  | { id: number; kind: 'close' };

/** ★ 库线程 → 主进程的应答（成功给 `data`，失败给 `WorkspaceError`，**没有第三种**）。 */
export type WorkerResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: WorkspaceError };

/** 面板 5 的分页大小（`logs()` 的默认 `limit`）。 */
export const LOG_PAGE_SIZE = 200;
