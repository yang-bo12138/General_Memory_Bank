/**
 * 门面 `MemoryStore` —— DESIGN-v2.md §6 的公开 API 入口（阶段 1 的 10 个方法）。
 *
 * ⚠️ **本文件只做「委托」，一行业务逻辑都没有**（§14.3 边界原则 1：
 *   「每个承诺都要能指到唯一代码路径」）：
 *   · **不做参数校验**（校验在各自实现里：§4.1 的 pin 因子、§4.9 的写入入参、§11.2 的错误码）；
 *   · **不取时钟**（`now` 由调用方注入，实现里统一走 `resolveNow`，§11.1 / C37）；
 *   · **不开事务**（事务在 `runWriteTransaction()` 里统一包，§4.2 / §4.5 / §4.9.2）；
 *   · **不算任何派生值**（`intensity` / `layer` / `effectiveStability` 都是库内部现算，§4.1）。
 *   ⇒ 门面**唯一**的职责是「把 10 个函数各自需要的上下文对象（`db` / `params` / `events` /
 *     `logger`）补齐」，然后原样转交。
 *
 * ⚠️ **公开面严格是 10 个方法**（DEVELOPMENT-PLAN.md §3.1 的阶段 1 归位表）：
 *   `write` / `recall` / `touch` / `get` / `pin` / `unpin` / `link` / `linkByIds` /
 *   `setAlias` / `mergeEntities`。
 *   ⇒ **刻意不实现 `stats`**（阶段 4）、**不加第 11 个方法**：
 *   每多一个公开方法都是一次**公开承诺**，而 §6 的 23 个方法分属阶段 1~5
 *   ⇒ 阶段 1 的门面只承诺这 10 个，其余的等各自阶段落地时再加。
 *
 * ⚠️ **签名全部从现有实现抄**（`src/store/*.ts`），不臆测、不「按设计稿再美化一次」：
 *   形参顺序、可选性、返回类型与实现**逐字一致**（含 `memoryId?: string | null` 这种
 *   「允许显式 `null`」的细节）⇒ 门面加一层不会改变任何既有调用语义。
 *
 * ⚠️ **错误原样透出**（§11.2）：底层抛的 `MemoryError`（`code` + `details`）**不包装、不改写**
 *   —— 包成通用 `Error` 会让调用方拿不到错误码，§11.2 的「缺失的表达方式」整张表就失效了。
 */

import { dirname } from 'node:path';
import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import { DEFAULT_PARAMS, type Params, applyParamPatch } from '../core/params.js';
import { SCHEMA_VERSION } from '../core/version.js';
import { openDatabase, readUserVersion } from '../db/connection.js';
import { assertV2TablesComplete, ensureSchema } from '../db/migrate.js';
import { FileLogger, type Logger } from '../util/log.js';
import {
  type MergeEntitiesResult,
  mergeEntities as mergeEntitiesImpl,
  setAlias as setAliasImpl,
} from './entities.js';
import { EventWriter } from './events.js';
import { type MemoryReadStore, type MemoryView, get as getImpl } from './get.js';
import {
  type GraphStore,
  type LinkOptions,
  type LinkResult,
  linkByIds as linkByIdsImpl,
  link as linkImpl,
} from './link.js';
import { pin as pinImpl, unpin as unpinImpl } from './pin.js';
import { type RecallOptions, type RecallResult, recall as recallImpl } from './recall.js';
import { type TouchOptions, type TouchOutcome, touch as touchImpl } from './touch.js';
import { type WriteInput, type WriteResult, type WriteStore, write as writeImpl } from './write.js';

/**
 * 门面的构造配置 —— DESIGN-v2.md §6 的 `MemoryConfig`。
 */
export interface MemoryConfig {
  /** 数据库文件路径。 */
  dbPath: string;
  /**
   * 只读实例？（§7.1：桌面查看器用只读句柄；**真正的写操作一律抛 `READONLY_VIOLATION`**，
   * 而事件流按 §8.4 只读短路、不落库。）
   */
  readonly?: boolean;
  /**
   * 参数覆盖（§5）：在 `DEFAULT_PARAMS`（60 项）之上覆盖若干项。
   *
   * ⚠️ **`EMBED_DIM` 是只读参数**（§5 / §6）：`setParams()` 传入它抛 `INVALID_INPUT`
   *   （改维度等于全库旧向量作废），**它只在 `MemoryConfig` 构造时生效**
   *   ⇒ 这里是它唯一的合法入口（运行期改参数的 `setParams()` 归阶段 4）。
   */
  params?: Partial<typeof DEFAULT_PARAMS>;
  /**
   * 可选的**同步**向量函数（ADR-10：库内不接模型、不读环境变量、不发网络请求；
   * 远程 embedding 请调用方先取好，再用 `WriteInput.embedding` / `RecallOptions.queryEmbedding` 传进来）。
   *
   * ⚠️ **本阶段只有 `write` 用得到它**：`RecallStore` 上下文里**没有** embedder 字段
   *   ⇒ 召回的 `queryEmbedding` 现算属**阶段 2 的向量路**（§4.6 步骤 2c），门面不代劳。
   */
  embedder?: (text: string) => number[];
}

/**
 * 把「构造期的参数覆盖」合并到 `DEFAULT_PARAMS`（60 项）之上。
 *
 * ⚠️ **为什么 `EMBED_DIM` 要单独摘出来**：`applyParamPatch()` 对它**一律拒绝**
 *   （它正是被 `setParams()` 拒的那一个：运行期改维度等于全库旧向量作废，§5）。
 *   但 §5 明写它「**只在 `MemoryConfig` 构造时生效**」⇒ 构造期是它唯一的合法入口。
 *   ⇒ 这里把它从补丁里摘出来单独合并；其余键照常走 `applyParamPatch()`
 *   （它顺带做未知键 / 类型 / **8 条跨参数校验**，§5）。
 *
 * ⚠️ **必须返回新对象**：`DEFAULT_PARAMS` 是**全进程共享**的默认参数表
 *   （各 store 直接引用它）⇒ 就地改它会让一个实例的构造参数漏到别的实例。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`（未知键 / 类型不符 / 跨参数校验不过）
 */
function resolveParams(patch: Partial<Params> | undefined): Params {
  if (patch === undefined) {
    return { ...DEFAULT_PARAMS };
  }
  const { EMBED_DIM, ...rest } = patch;
  const merged: Params = { ...applyParamPatch(DEFAULT_PARAMS, rest) };
  if (EMBED_DIM !== undefined) {
    merged.EMBED_DIM = EMBED_DIM;
  }
  return merged;
}

/**
 * 按连接模式决定「建库 / 迁移」还是「只校验」。
 *
 * ⚠️ **只读实例不迁移**：迁移要写库，而只读句柄上写库必然抛 `SQLITE_READONLY`
 *   ⇒ 那会让调用方拿到一个**裸的 SQLite 错误码**（§11.2：裸码绝不能抛给调用方）。
 *   ⇒ 只读实例要求库**已经是当前 schema 版本**；不是就抛 `MemoryError.INVALID_INPUT`，
 *   并在 `details.schema` 里写清「期望版本 / 实际版本 / 为什么」。
 *
 * ⚠️ **写实例一律走 `ensureSchema()`**（§9.1）：空库建表、v1 迁移、版本号对不上就抛错，
 *   **不做猜测式兼容**。
 *
 * @throws {MemoryError} code = `INVALID_INPUT`（schema 版本不认识 / 只读实例未迁移）
 */
function ensureSchemaForMode(db: Database.Database, readonly: boolean): void {
  if (!readonly) {
    ensureSchema(db);
    return;
  }
  const version = readUserVersion(db);
  if (version !== SCHEMA_VERSION) {
    throw MemoryError.invalidInput(
      `只读实例要求库已迁移到当前 schema 版本（实际 ${String(version)}，期望 ${String(SCHEMA_VERSION)}）`,
      {
        schema: {
          expected: SCHEMA_VERSION,
          actual: version,
          reason:
            '只读句柄无法执行迁移（写库必然 SQLITE_READONLY）；请先用可写实例迁移，再以只读方式打开',
        },
      },
    );
  }
  assertV2TablesComplete(db);
}

/**
 * 门面 —— 库对外的唯一入口（§6）。
 *
 * ⚠️ **只暴露 10 个公开方法**（阶段 1 的归位表），其余全是私有字段：
 *   公开面每多一个名字就是一次公开承诺（§14.3 原则 1），
 *   而 §6 的 23 个方法分属阶段 1~5 ⇒ 阶段 1 只承诺这 10 个。
 *
 * ⚠️ **不提供 `close()`**：§6 的公开面里没有它，而阶段 1 的门面方法归位表里也没有它
 *   ⇒ 本阶段不加。调用方要释放句柄时，自行管理 `dbPath` 的生命周期即可
 *   （better-sqlite3 的句柄随进程退出而释放）。
 */
export class MemoryStore {
  /**
   * `{ db, params, events }` 形状的上下文。
   *
   * ⚠️ `RecallStore` / `TouchStore` / `PinStore` / `GraphStore` / `EntityStore`
   *   在 TypeScript 上**结构完全相同**（都是那三个字段）⇒ 一个对象复用即可，
   *   不必为每个实现各造一份（造多份只是把同一件事抄五遍）。
   */
  readonly #context: GraphStore;

  /** `get` 用的上下文（**只要 `db` + `params`**：单条读取不记事件）。 */
  readonly #readContext: MemoryReadStore;

  /** `write` 用的上下文（多了 `logger` 与可选 `embedder`）。 */
  readonly #writeContext: WriteStore;

  /**
   * 构造一个门面实例。
   *
   * ⚠️ **构造期做的四件事**（都不是业务逻辑，是「把依赖接上」）：
   *   ① 开连接（写 / 只读两套 PRAGMA，§9.1）；
   *   ② 建库或校验 schema（§9.1）；
   *   ③ 合并参数覆盖（§5）；
   *   ④ 把日志器与事件写入器接上（§8.1 / §8.4）。
   *
   * @throws {MemoryError} `NOT_FOUND`（只读模式下文件不存在）/ `INVALID_INPUT`（schema 版本不对、参数非法）
   */
  constructor(config: MemoryConfig) {
    const readonly = config.readonly === true;
    const db = openDatabase({ dbPath: config.dbPath, readonly });
    ensureSchemaForMode(db, readonly);

    const params = resolveParams(config.params);

    // ⚠️ **日志目录 = 数据库文件所在目录**（§8.1：`<数据目录>/logs/<YYYY>/<MM>/<MM-DD>.log`）。
    //   `dataDir` 取 `dirname(dbPath)`：调用方给的是「库文件路径」，
    //   而 §8.1 的口径是「数据目录」⇒ 二者的自然对应就是「库文件所在的目录」。
    //   ⚠️ **隐含假设：该目录可写**。只读实例（§7.1）可能打开一个装在**不可写目录**里的库
    //   （查看器常打开只读安装目录）⇒ 那时日志落盘会失败；
    //   但**兜底属于 `FileLogger` 自己的地盘**（`src/util/log.ts`，别的文件域），
    //   本门面不替它加静默降级（静默吞掉日志写失败 = 排障时看不到「日志断了」这件事）。
    const logger: Logger = new FileLogger({
      dataDir: dirname(config.dbPath),
      // ⚠️ **真实时钟只能从 `resolveNow()` 取**（§11.1 / C37）：
      //   `src/core/clock.ts` 是**唯一**允许读真实时钟的实现文件，
      //   其余 `src/` 文件里出现 `Date.now()` 会被 `scripts/check-clock.ts` 拦下。
      now: () => resolveNow(),
    });

    // ⚠️ **`readonly` 必须传进事件写入器**（§7.1 第 4 条）：只读实例上的事件流
    //   **短路而不抛错**（业务返回值照常给出），判断收在 `appendEvent()` 内部。
    const events = new EventWriter(db, { readonly, logger, now: () => resolveNow() });

    this.#context = { db, params, events };
    this.#readContext = { db, params };
    // ⚠️ `embedder` 是**可选属性**：`exactOptionalPropertyTypes` 下显式写 `embedder: undefined`
    //   与「不传」是**两件事** ⇒ 用条件展开，避免把「没有 embedder」写成「embedder 是 undefined」。
    this.#writeContext = {
      db,
      params,
      events,
      logger,
      ...(config.embedder === undefined ? {} : { embedder: config.embedder }),
    };
  }

  /**
   * 写入一条记忆 —— §6 的 `write()`（§4.9 的四步写入流程）。
   *
   * @param input 写入入参（`content` 必填，其余可省）
   * @returns §6 的 `WriteResult`（`id` / `merged` / `exact` / `content` / `warnings`）
   */
  write(input: WriteInput): WriteResult {
    return writeImpl(this.#writeContext, input);
  }

  /**
   * 召回 —— §6 的 `recall()`（§4.6 的三路召回与融合打分）。
   *
   * @param options 召回选项（`context` 必填）
   * @returns §6 的 `RecallResult`（`hits` / `explain?` / `suppressed` / `diffused`）
   */
  recall(options: RecallOptions): RecallResult {
    return recallImpl(this.#context, options);
  }

  /**
   * 批量加固 —— §6 的 `touch()`（§4.2）。
   *
   * @param ids 要加固的记忆 id 列表
   * @param now 注入时钟（C37）
   * @param options 可选开关（`reason`）
   * @returns 逐条结果（`intervalDays` / `boosted` / `stabilityDelta` / `edgesReinforced`）
   * @throws {MemoryError} `NOT_FOUND`（`details.missingIds` = 差集；**一条都不加固**）
   */
  touch(ids: readonly string[], now?: number, options?: TouchOptions): TouchOutcome[] {
    return touchImpl(this.#context, ids, now, options);
  }

  /**
   * 读取单条记忆 —— §6 的 `get()`（§4.1 末）。
   *
   * ⚠️ **查不到返回 `null`、不抛错**（§11.2：读接口用返回值表达缺失）。
   *   软删记录**照常返回**（靠 `deleted` 字段区分状态），硬删返回 `null`。
   *
   * @param id 记忆 id
   * @param now 注入时钟（`layer` / `intensity` 是时间派生的，§11.1）
   * @returns §6 的 `MemoryView`，或 `null`（不存在）
   */
  get(id: string, now?: number): MemoryView | null {
    return getImpl(this.#readContext, id, now);
  }

  /**
   * 强调 —— §6 的 `pin()`（§4.1 步骤 1~3）。
   *
   * @param id 记忆 id
   * @param factor 强调倍率；缺省 `2.0`（§4.1），必须落在 `[1.0, MAX_PIN_FACTOR]`
   * @throws {MemoryError} `NOT_FOUND`（不存在 / 已软删）/ `INVALID_INPUT`（factor 越界）
   */
  pin(id: string, factor?: number): void {
    pinImpl(this.#context, id, factor);
  }

  /**
   * 取消强调 —— §6 的 `unpin()`（§4.1）。
   *
   * ⚠️ **幂等**：本来就是 `1.0` 时不写库、不记事件（§4.1）。
   *
   * @param id 记忆 id
   * @throws {MemoryError} `NOT_FOUND`（不存在 / 已软删）
   */
  unpin(id: string): void {
    unpinImpl(this.#context, id);
  }

  /**
   * 按**实体名**建关系 —— §6 的 `link()`（§4.5）。
   *
   * @param subject 主语实体名
   * @param predicate 关系谓词
   * @param object 宾语实体名
   * @param memoryId 关联的记忆 id（可省；`null` 表示这是一条「断言」而不是「记忆」，§4.5）
   * @param now 注入时钟（`edges.created_at` / `last_active`，§11.1）
   * @param options 可选开关（`createMissing`，缺省 `true`）
   * @returns §6 的 `LinkResult`（`weightAfter` 是**实际落库**的权重）
   * @throws {MemoryError} `NOT_FOUND` / `INVALID_INPUT`（自环）
   */
  link(
    subject: string,
    predicate: string,
    object: string,
    memoryId?: string | null,
    now?: number,
    options?: LinkOptions,
  ): LinkResult {
    return linkImpl(this.#context, subject, predicate, object, memoryId, now, options);
  }

  /**
   * 按**实体 id** 建关系 —— §6 的 `linkByIds()`（§4.5 步骤 4）。
   *
   * @param subjectId 主语实体 id
   * @param predicate 关系谓词
   * @param objectId 宾语实体 id
   * @param memoryId 关联的记忆 id（可省）
   * @param now 注入时钟
   * @returns §6 的 `LinkResult`
   * @throws {MemoryError} `NOT_FOUND`（`details.missingIds` = 缺失的实体 id 差集）
   */
  linkByIds(
    subjectId: string,
    predicate: string,
    objectId: string,
    memoryId?: string | null,
    now?: number,
  ): LinkResult {
    return linkByIdsImpl(this.#context, subjectId, predicate, objectId, memoryId, now);
  }

  /**
   * 设别名 —— §6 的 `setAlias()`（§4.9.2）。
   *
   * ⚠️ **本方法不接收 `now`**（§11.1 豁免：它不写任何时间派生字段）。
   *
   * @param alias 别名
   * @param entityId 目标实体 id
   * @throws {MemoryError} `NOT_FOUND`（目标实体不存在）/ `CONFLICT`（alias 撞既有主名）
   */
  setAlias(alias: string, entityId: string): void {
    setAliasImpl(this.#context, alias, entityId);
  }

  /**
   * 合并实体 —— §6 的 `mergeEntities()`（§4.9.2）。
   *
   * ⚠️ **本方法不接收 `now`**（§11.1 豁免：`edges.last_active` 取两条边中的较大者）。
   *
   * @param sourceId 被合并的实体 id
   * @param targetId 合并目标实体 id
   * @returns §6 的 `MergeEntitiesResult`（`movedMemories` / `mergedEdges` / `droppedSelfLoops` / `sourceName`）
   * @throws {MemoryError} `NOT_FOUND`（任一端实体不存在；`details.missingIds`）
   */
  mergeEntities(sourceId: string, targetId: string): MergeEntitiesResult {
    return mergeEntitiesImpl(this.#context, sourceId, targetId);
  }
}
