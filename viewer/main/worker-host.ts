/**
 * ★ **主进程侧的库线程客户端** —— 阶段 5 · P5-T01（设计 §3.3 第 12 项）。
 *
 * 职责只有四件（**不碰库、不碰 SQL、不碰文件**）：
 *   ① `spawn` 一个 worker；
 *   ② 维护 `id → Promise` 的映射（请求/应答配对）；
 *   ③ 超时（库不响应 ⇒ `DATABASE_BUSY` + `details.reason = 'worker_timeout'`）；
 *   ④ 把 worker 回来的 `WorkspaceError` 反序列化成一个可抛的 `Error`。
 *
 * ⚠️ **它不 import `electron`，也不 import `better-sqlite3`**：它是纯 Node ⇒
 *   可以在 vitest 里被直接 import 与断言（设计 §2.5 第 2 条：只有 `viewer/main/index.ts`
 *   与 `viewer/preload/index.ts` 允许 `import 'electron'`；视图侧库句柄只在 `db-worker.ts`）。
 *
 * ⚠️ **`dbPath` 只从构造参数来**（由 `viewer/main/index.ts` 从 `argv` / `app.getPath` 取）
 *   ⇒ `ipc.ts` 里**没有**任何一条通道能传路径进来（设计 §4.2 硬规则 ②）。
 */

import { Worker } from 'node:worker_threads';

import type {
  LogPage,
  LogQuery,
  SqlRow,
  WorkerRequest,
  WorkerResponse,
  WorkspaceError,
} from '../shared/protocol.js';
import type { SqlQueryName } from '../shared/sql-names.js';

/** 默认超时（毫秒）。 */
export const WORKER_TIMEOUT_MS = 20_000;

/**
 * ★ worker 回来的错误的**可抛形态**。
 *
 * ⚠️ 它 `implements WorkspaceError`：`code` / `message` / `details` 三个字段**同名同义**
 *   ⇒ 调用方既能 `catch (e) { e.code }`，也能把它当 `WorkspaceError` 直接送进 IPC 信封。
 *   ⚠️ 它加了 `name = 'WorkspaceError'`：`StatusBlock` 靠 `code` 判别，
 *     `name` 只是让日志里看得出这是**跨进程搬过来的**错误而不是本地抛的。
 */
export class WorkspaceFailure extends Error implements WorkspaceError {
  /** 线上错误码。 */
  readonly code: string;

  /** 结构化详情。 */
  readonly details: Record<string, unknown>;

  constructor(error: WorkspaceError) {
    super(error.message);
    this.name = 'WorkspaceError';
    this.code = error.code;
    this.details = error.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 一条挂起的请求。 */
interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * `WorkerRequest` 去掉 `id` 之后的形状。
 *
 * ⚠️ **不能用 `Omit<WorkerRequest, 'id'>`**：`Omit` 作用在**联合类型**上会退化成
 *   「所有成员共有键」的对象类型（判别字段 `kind` 之外的字段全丢）
 *   ⇒ 请求构造处的类型检查形同虚设。这里用条件类型**逐成员**分配。
 */
type WorkerRequestPayload = WorkerRequest extends infer Member
  ? Member extends { id: number }
    ? Omit<Member, 'id'>
    : never
  : never;

/** `WorkerHost` 的构造参数。 */
export interface WorkerHostOptions {
  /** 库文件路径（**只能由主进程给**）。 */
  dbPath: string;
  /** 超时（毫秒），缺省 `WORKER_TIMEOUT_MS`。 */
  timeoutMs?: number;
  /**
   * worker 脚本的 URL。
   *
   * ⚠️ 默认按**本文件同目录**解析 `db-worker.js`：仓库在开发期用 `tsx` 直接跑 `.ts`，
   *   打包轮会把它编成 `.js` ⇒ 「同目录同名」是两种形态下都成立的唯一约定。
   *   测试会显式传一个指向 `.ts` 的 URL（并配 `execArgv: ['--import','tsx']`）。
   */
  workerUrl?: URL;
  /** worker 的 `execArgv`（测试传 `['--import','tsx']` 才能直接跑 `.ts`）。 */
  execArgv?: string[];
}

/**
 * 库线程客户端。
 *
 * ⚠️ **`open` 在构造时立刻发出**，`ready()` 是它的 Promise：
 *   ⇒ 「库路径」这件事在**构造期就定了**，之后的每一条请求都只带方法名与参数。
 */
export class WorkerHost {
  readonly #worker: Worker;

  readonly #timeoutMs: number;

  /** `id → 挂起请求`。 */
  readonly #pending = new Map<number, PendingRequest>();

  /** 下一个请求 id（从 1 起，`0` 留给「还没分配」）。 */
  #nextId = 1;

  /** `open` 的结果（构造时就发了）。 */
  readonly #opened: Promise<void>;

  /** `close()` 是否已调用（`close()` 幂等）。 */
  #closed = false;

  constructor(options: WorkerHostOptions) {
    this.#timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;

    const workerUrl = options.workerUrl ?? new URL('./db-worker.js', import.meta.url);
    this.#worker = new Worker(workerUrl, {
      ...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
    });

    this.#worker.on('message', (message: WorkerResponse) => {
      this.#settle(message);
    });

    // ⚠️ worker 崩了 ⇒ 所有挂起请求都必须被拒，否则它们会一直等到超时
    //   （那时面板看到的是「计算中」而不是「库线程挂了」，排障方向会被带偏）。
    this.#worker.on('error', (error: Error) => {
      this.#rejectAll(
        new WorkspaceFailure({
          code: 'DATABASE_BUSY',
          message: `库线程异常退出：${error.message}`,
          details: { reason: 'worker_crashed' },
        }),
      );
    });
    this.#worker.on('exit', (code) => {
      this.#rejectAll(
        new WorkspaceFailure({
          code: 'DATABASE_BUSY',
          message: `库线程已退出（exit code ${String(code)}）`,
          details: { reason: 'worker_exited', exitCode: code },
        }),
      );
    });

    this.#opened = this.#request<void>({ kind: 'open', dbPath: options.dbPath });
  }

  /** 等库线程把库打开（构造期自动发出那条 `open`）。 */
  async ready(): Promise<void> {
    await this.#opened;
  }

  /**
   * 发一条 `call` 请求（6 个读方法走这里）。
   *
   * @param method `ReadPort` 里除 `select` / `logs` 之外的 6 个方法之一
   * @param args 位置参数（**由 `ipc.ts` 逐个方法显式组装**，不做透传）
   */
  async call(
    method: 'stats' | 'get' | 'recall' | 'clusters' | 'inhibitionTrace' | 'verifyIntegrity',
    args: unknown[],
  ): Promise<unknown> {
    return this.#request<unknown>({ kind: 'call', method, args });
  }

  /** 发一条 `select` 请求（面板 4/6 的原始 SELECT，**只传名字**）。 */
  async select(name: SqlQueryName, params: unknown): Promise<ReadonlyArray<SqlRow>> {
    return this.#request<ReadonlyArray<SqlRow>>({ kind: 'select', name, params });
  }

  /** 发一条 `logs` 请求（面板 5，只读 `logs/` 目录）。 */
  async logs(query: LogQuery): Promise<LogPage> {
    return this.#request<LogPage>({ kind: 'logs', query });
  }

  /** 关掉 worker（幂等）。 */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#request<null>({ kind: 'close' });
    } catch {
      // ⚠️ 关库失败不该盖住「关窗」这个主流程（库已经不可用了，再抛只会让窗口关不掉）
    }
    await this.#worker.terminate();
  }

  /**
   * 发一条请求并等应答（**唯一的请求通道**）。
   *
   * @param request 不含 `id` 的请求（`id` 在这里分配）
   */
  #request<T>(request: WorkerRequestPayload): Promise<T> {
    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new WorkspaceFailure({
            code: 'DATABASE_BUSY',
            message: '库线程超时未应答',
            details: { reason: 'worker_timeout', timeoutMs: this.#timeoutMs, method: request.kind },
          }),
        );
      }, this.#timeoutMs);
      // ⚠️ 不让超时定时器吊住进程（与 `FileLogger` 的 flush 定时器同一条纪律）
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (data: unknown) => {
          resolve(data as T);
        },
        reject,
        timer,
      });

      this.#worker.postMessage({ ...request, id } satisfies WorkerRequest);
    });
  }

  /** 处理一条应答（成功 ⇒ resolve；失败 ⇒ 反序列化成 `WorkspaceFailure`）。 */
  #settle(message: WorkerResponse): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      // 迟到的应答（已超时）⇒ 没有接收者，直接丢弃（不是错误）
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.ok) {
      pending.resolve(message.data);
      return;
    }
    pending.reject(new WorkspaceFailure(message.error));
  }

  /** 把全部挂起请求拒掉（worker 崩了 / 退了）。 */
  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}
