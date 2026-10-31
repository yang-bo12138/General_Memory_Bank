/**
 * `logs/` 文本流水 —— DESIGN-v2.md §8.1（格式与拍平规则）/ §8.3（分级 flush 与进程级兜底）。
 *
 * ⚠️ **自研**（决策 D-09）：§8.1 的格式与拍平规则是**自定义**的，
 *   第三方日志库反而要绕（它们各有各的序列化与批量策略）。
 *
 * ## 格式（§8.1）
 *
 * ```
 * YYYY-MM-DD HH:mm:ss  <级别>  <动作>  键=值 ...
 * ```
 *
 * · 目录：`<数据目录>/logs/<YYYY>/<MM>/<MM-DD>.log`
 * · 级别：`info` | `warn` | `error`——**这一列不能省**：§8.3 要求 `error` 级同步 flush、
 *   `warn`/`info` 进异步队列，而「是不是 error 级」必须在**写出当下**就能判定。
 * · 单次事件一行；值含空格或特殊字符用 URL 编码。
 * · **空值记 `-`，不省略键**（键本身是信息：`id=-` 表示「这条不关联记忆」，
 *   与「忘了记 id」是两件事）。
 *
 * ## 键值口径（§8.1）
 *
 * **键值口径 = 该事件 `events` payload 去掉 `contentText`**——
 * 日志**不另立第二套字段清单**（两份清单必然各自演化，最后没人说得清哪个准）。
 * ⇒ 「正文永不进日志」（§8.2）由此自动成立，不需要单独维护。
 *
 * ## 拍平规则（§8.1）
 *
 * | payload 里的值形态 | 日志里的写法                                      |
 * | ------------------ | ------------------------------------------------- |
 * | 标量               | `键=值`                                           |
 * | `null`/`undefined` | `键=-`                                           |
 * | 数组               | `键=[e1,e2]`（空数组记 `键=[]`）                  |
 * | 对象               | **只记它的键集合**：`键={k1,k2}`（空对象记 `键={}`）|
 *
 * ⚠️ **唯一的例外是 `config` 事件的 `params`**：它是参数的**完整生效快照**，
 *   不是「结构说明」而是**业务数据** ⇒ 逐项展开成 `params.MAX_STABILITY=180`，
 *   且它与 `changed` 分开记（`params` 是当前快照可覆盖全量，`changed` 是本次差异）。
 */

import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MS_PER_DAY } from './time.js';

/** 日志级别（§8.1）。 */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * 动作枚举（§8.1）——**14 项 = §8.4 的 13 种 `events.type` 各对应一个 + 1 项无事件对应的 `错误`**。
 *
 * ⚠️ 本枚举原先只有 9 项，而 §8.1 又声明「单次事件一行」——
 * 两者合起来的后果是 `restore` / `manual_fix` / `alias` / `pin` / `unpin`
 * 这 5 类操作在人类可读流水里**完全不出现**。动作名少一个，等于那类操作没有审计。
 */
export const LOG_ACTIONS = {
  write: '写入',
  merge: '合并',
  restore: '恢复',
  manual_fix: '纠正',
  alias: '别名',
  recall: '召回',
  touch: '加固',
  link: '建关系',
  pin: '置顶',
  unpin: '取消置顶',
  forget: '遗忘',
  config: '参数',
  sweep: '清理',
  error: '错误',
} as const;

/** 动作名。 */
export type LogAction = (typeof LOG_ACTIONS)[keyof typeof LOG_ACTIONS];

/** 一条日志的键值字段。 */
export type LogFields = Record<string, unknown>;

/** 队列参数（§8.3）：最大缓冲 200 行或 1000ms，先到先触发 flush。 */
export const LOG_QUEUE_MAX_LINES = 200;
export const LOG_QUEUE_MAX_MS = 1000;

/** 标量的写法。 */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '-';
  }
  const text = String(value);
  // 值含空格或特殊字符 ⇒ URL 编码
  return /[\s,="[\]{}()<>&;]/.test(text) ? encodeURIComponent(text) : text;
}

/**
 * 把一个字段值拍平成若干个 `键=值` 片段。
 *
 * @param key 字段名
 * @param value 字段值
 * @param expand 该字段是否需要**逐项展开**（`config` 事件的 `params` 是唯一的例外）
 */
export function flattenField(key: string, value: unknown, expand = false): string[] {
  if (expand && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return [`${key}=`];
    }
    return entries.map(([subKey, subValue]) => `${key}.${subKey}=${formatScalar(subValue)}`);
  }

  if (value === null || value === undefined) {
    return [`${key}=${'-'}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${key}=[]`];
    }
    const items = value.map((item) => {
      if (item !== null && typeof item === 'object') {
        // 数组元素若是对象，仍按「对象」规则记成 {k1,k2}
        const subKeys = Object.keys(item as Record<string, unknown>);
        return `{${subKeys.join(',')}}`;
      }
      return formatScalar(item);
    });
    return [`${key}=[${items.join(',')}]`];
  }
  if (typeof value === 'object') {
    const subKeys = Object.keys(value as Record<string, unknown>);
    return [`${key}={${subKeys.join(',')}}`];
  }
  return [`${key}=${formatScalar(value)}`];
}

/**
 * 把字段集合拍平成 `键=值` 片段数组（顺序 = 字段的书写顺序）。
 *
 * ⚠️ **不省略键**：`null` 的键也要写出来（记 `-`）。
 */
export function flattenFields(fields: LogFields, expandKeys: readonly string[] = []): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(...flattenField(key, value, expandKeys.includes(key)));
  }
  return parts;
}

/** 格式化一行日志。 */
export function formatLogLine(
  timestamp: number,
  level: LogLevel,
  action: LogAction,
  fields: LogFields,
  expandKeys: readonly string[] = [],
): string {
  const date = new Date(timestamp);
  const stamp =
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-` +
    `${String(date.getDate()).padStart(2, '0')} ` +
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:` +
    `${String(date.getSeconds()).padStart(2, '0')}`;
  const parts = flattenFields(fields, expandKeys);
  return `${stamp}  ${level}  ${action}  ${parts.join(' ')}`;
}

/** 日志器的配置。 */
export interface FileLoggerOptions {
  /** 数据目录；日志写到 `<dir>/logs/<YYYY>/<MM>/<MM-DD>.log`（§8.1）。 */
  dataDir: string;
  /** 注入时钟（C37：实现文件里不出现 `Date.now()`）。 */
  now: () => number;
}

/**
 * 自研文件日志器。
 *
 * ⚠️ **分级写入策略**（§8.3）：
 * · `error` 级：**同步写入并 flush**（不受队列影响），保证崩溃现场可取证；
 * · `warn` / `info`：进队列，批量追加（最大 200 行或 1000ms，先到先触发）。
 *
 * ⚠️ **`events` 表在事务内 COMMIT，不受日志缓冲影响**——即日志可能缺行，
 *   但事件流永远完整 ⇒ **重放以 `events` 为准，`logs/` 只作人类排障**（§8.3）。
 */
export class FileLogger {
  readonly #dataDir: string;
  readonly #now: () => number;
  readonly #queue: string[] = [];
  #timer: NodeJS.Timeout | undefined;
  #lastFilePath: string | undefined;

  constructor(options: FileLoggerOptions) {
    this.#dataDir = options.dataDir;
    this.#now = options.now;
  }

  /** 队列中待写的行数（测试用）。 */
  get pending(): number {
    return this.#queue.length;
  }

  /** 写一条日志。 */
  log(
    level: LogLevel,
    action: LogAction,
    fields: LogFields = {},
    expandKeys: readonly string[] = [],
  ): void {
    const line = formatLogLine(this.#now(), level, action, fields, expandKeys);
    if (level === 'error') {
      // error 级：同步写入并 flush，不受队列影响
      this.#writeLines([line]);
      return;
    }
    this.#enqueue(line);
  }

  /** info 级。 */
  info(action: LogAction, fields: LogFields = {}, expandKeys: readonly string[] = []): void {
    this.log('info', action, fields, expandKeys);
  }

  /** warn 级。 */
  warn(action: LogAction, fields: LogFields = {}, expandKeys: readonly string[] = []): void {
    this.log('warn', action, fields, expandKeys);
  }

  /** error 级。 */
  error(action: LogAction, fields: LogFields = {}, expandKeys: readonly string[] = []): void {
    this.log('error', action, fields, expandKeys);
  }

  /**
   * 立即把队列写盘。
   *
   * ⚠️ 正常退出时 `close()` 必须**先** `flushLogs()` 再关数据库句柄；
   *   顺序反了会丢掉最后一次写的日志（§8.3）。
   */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#queue.length === 0) {
      return;
    }
    const lines = this.#queue.splice(0, this.#queue.length);
    this.#writeLines(lines);
  }

  /**
   * 注册进程级兜底（§8.3）。
   *
   * ⚠️ 统一调用 `flushLogs()`，且必须用**同步** `fs.writeSync`——
   *   异步 API 在退出前写不完。
   */
  installProcessFallback(): void {
    const handler = (): void => {
      this.flush();
    };
    process.on('exit', handler);
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    process.on('uncaughtException', handler);
  }

  /** 关掉日志器（先 flush）。 */
  close(): void {
    this.flush();
  }

  /** 入队。 */
  #enqueue(line: string): void {
    this.#queue.push(line);
    if (this.#queue.length >= LOG_QUEUE_MAX_LINES) {
      this.flush();
      return;
    }
    if (this.#timer === undefined) {
      // ⚠️ 这是 §8.3 要求的**日志 flush 计时器**，**不是** ADR-5 禁止的**机制级定时器**：
      //   · 它只负责「把已入队的日志行落到文件」，**不触发任何业务机制**；
      //     （无后台聚类重算、无自动重训、无任何自演化 —— §4.11 / §4.15 的机制都不在这里）；
      //   · §4.11 / §4.15 说的「库内无定时器」指的是**机制级**定时器（那些会改数据）；
      //     日志 flush 是 §8.3 明文要求的行为，不属于那一类；
      //   · 它 `unref()` 了 ⇒ 不吊住进程（见下面两行）。
      this.#timer = setTimeout(() => {
        this.flush();
      }, LOG_QUEUE_MAX_MS);
      // ⚠️ 不让定时器吊住进程（否则库一被 import 就退不出去）
      this.#timer.unref?.();
    }
  }

  /** 当前时刻对应的日志文件路径。 */
  #filePath(timestamp: number): string {
    const date = new Date(timestamp);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return join(this.#dataDir, 'logs', year, month, `${month}-${day}.log`);
  }

  /** 同步写盘。 */
  #writeLines(lines: string[]): void {
    if (lines.length === 0) {
      return;
    }
    const timestamp = this.#now();
    const path = this.#filePath(timestamp);
    if (path !== this.#lastFilePath) {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.#lastFilePath = path;
    }
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, `${lines.join('\n')}\n`, null, 'utf8');
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * 日志器端口（供 `appendEvent()` 等模块依赖）。
 *
 * ⚠️ 只依赖这三个方法 ⇒ 测试可以塞一个内存实现，不必真的落盘。
 */
export interface Logger {
  info(action: LogAction, fields?: LogFields, expandKeys?: readonly string[]): void;
  warn(action: LogAction, fields?: LogFields, expandKeys?: readonly string[]): void;
  error(action: LogAction, fields?: LogFields, expandKeys?: readonly string[]): void;
}

/** 内存日志器（测试夹具 / 暂不落盘时使用）。 */
export class MemoryLogger implements Logger {
  /** 已写出的日志行（按写入顺序）。 */
  readonly lines: Array<{ level: LogLevel; action: LogAction; fields: LogFields }> = [];

  info(action: LogAction, fields: LogFields = {}): void {
    this.lines.push({ level: 'info', action, fields });
  }

  warn(action: LogAction, fields: LogFields = {}): void {
    this.lines.push({ level: 'warn', action, fields });
  }

  error(action: LogAction, fields: LogFields = {}): void {
    this.lines.push({ level: 'error', action, fields });
  }

  /** 只取某个级别的日志。 */
  ofLevel(level: LogLevel): Array<{ level: LogLevel; action: LogAction; fields: LogFields }> {
    return this.lines.filter((line) => line.level === level);
  }
}

/** 毫秒常量导出（避免其它模块重复定义）。 */
export const DAY_MS = MS_PER_DAY;
