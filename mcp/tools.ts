/**
 * MCP 工具表与**纯函数**调度 —— 阶段 5 · T05（PLAN P5-T05 / 设计 §4.5）。
 *
 * ⚠️ ★ **本文件刻意不 import MCP 官方 SDK**（`@modelcontextprotocol` 的 `sdk` 包）：
 *   ⇒ 即使那个包装不上、或它的 API 在小版本间改了（`server.tool()` vs `server.registerTool()`、
 *     `inputSchema` 收 zod 还是收 JSON Schema），**本文件与 `mcp/tools.test.ts` 照样能跑**。
 *   ⇒ SDK 的耦合面被压到 `mcp/server.ts` 一个文件（薄适配：133 行里大半是「为什么这么做」的注释，
 *     真正的代码只有一个工厂 + 两个处理器）⇒ 升级只改那一处。
 *   ⚠️ 这条纪律是**机器可检**的：`mcp/tools.test.ts` 扫 `src/` + `mcp/` 全树，
 *     断言「出现那个包名的文件**只有** `mcp/server.ts`」。
 *     ⇒ **所以本文件的注释里也不能出现那个包名的完整字面量**（否则上面的扫描会把自己抓成违规）。
 *
 * ⚠️ ★ **异步只在最外层包装**（§0.2.3 ⑦ / ADR-5）：库是**全同步** API，
 *   本文件全部同步返回（返回 `Promise` 就是 bug）；
 *   `async` 只出现在 `mcp/server.ts` 的请求处理器上（那是协议层的要求，不是库的）。
 *   `embedder` 是**同步注入点**：远程 embedding 必须由调用方**预取后**用 `write.embedding` 传进来
 *   （本层不 new 任何 embedder）。⚠️ `recall` **不收** `queryEmbedding`：设计 §4.5 的 recall 参数表里
 *   没有它，而本阶段向量路整路缺席 ⇒ 收一个「不产生任何效果」的参数只会让调用方以为它有效。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 【决策块 ①】维护类五个方法：逐个「暴露 / 不暴露」的裁决与理由
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | 方法             | 暴露？ | 理由 |
 * | ---------------- | ------ | ---- |
 * | `updateContent`  | ✅ 是  | 它是「人工改正正文」的**唯一入口**；不暴露它，MCP 侧就没有任何办法修一条写错的记忆 |
 * | `setAlias`       | ✅ 是  | 幂等、常数级、不阻塞；别名是「跨来源统一召回」得以成立的关键（同一个实体在不同来源里名字不同） |
 * | `mergeEntities`  | ✅ 是  | 有并发兜底，且它是 `setAlias` 撞 `CONFLICT` 时官方指定的**下一步**（§11.2）；不暴露则调用方卡死 |
 * | `sweep`          | ✅ 是  | ★ 终裁见设计 §9.2 的 **N-07**：暴露，且 `purgeDeletedDays` 与 `vacuum` **都进 `required`** —— 这两个参数的语义是「清多少天前的软删行」与「清完之后要不要回收空间」，缺省值不同会让同一次调用产生**物理删除**或**什么都不清**两种后果，**必须由调用方显式写明**。⚠️ `sweep` 在只读句柄上抛 `READONLY_VIOLATION`，而 MCP 用的是**写**句柄 |
 * | `clusters`       | ❌ 否  | 它是**读**方法，且首次调用会**现场重算**（几百毫秒量级，见设计 §3.6 的实测口径）⇒ 放进工具集会让调用方以为它是个便宜查询；这个需求由查看器的「主题簇导航」面板覆盖，不经 MCP |
 *
 * 【决策块 ②】三个**阻塞 1~3 分钟**的维护方法：一律**不暴露**（PLAN 明令）
 *
 * `rebuildArchivalSchedule` / `rebuildVectorBuckets` / `recluster`
 * —— 它们是全库重算型的写方法，一次调用会让宿主等待 1~3 分钟
 * （名单写死在 `BLOCKED_MAINTENANCE_METHODS`，并由 `assertNoBlockedMaintenance()` 在初始化时核）。
 * ⚠️ 这条纪律**不是靠自觉**：`assertNoBlockedMaintenance()` 在本模块**初始化时**就跑一遍
 *   ⇒ 谁把 `recluster` 加进 `TOOL_DEFINITIONS`，**import 本模块时就会抛错**（所有测试当场全红）。
 *
 * 【决策块 ③】§6 的 23 个公开方法里，**除上面 10 个之外刻意不暴露**的
 * （逐个写明理由，防「以后顺手加上」）
 *
 * | 方法                     | 不暴露的理由 |
 * | ------------------------ | ------------ |
 * | `get`                    | 最小集里没有它；单条读取是**宿主自己的库句柄**该做的事（MCP 服务端不该成为通用查询代理） |
 * | `pin` / `unpin`          | 强调倍率是**人的判断**（§4.1），MCP 是「被调用的服务」，不该替宿主表达偏好 |
 * | `linkByIds`              | 它是 `link` 的内部形态（按 id 而非按名字）。两个都暴露 ⇒ 调用方得记住「什么时候用哪个」 |
 * | `setParams`              | 改参数会**改变所有历史数据的解读方式**（§5 / §8.4 硬规则 2）⇒ 必须由运维显式操作，不做成远程工具 |
 * | `stats`                  | 不在 PLAN 的两份清单里（最小集 / 维护类）⇒ 本轮不扩面；观测需求由查看器面板覆盖 |
 * | `inhibitionTrace`        | 同上（它是排障专用读方法，属查看器面板 3 的职责） |
 * | `verifyIntegrity`        | 同上（护栏自检读方法，属运维/查看器的职责） |
 * | `close`                  | 生命周期由 `mcp/server.ts` 的宿主管理，不是工具 |
 *
 * 【决策块 ④】与设计稿的**两处刻意偏离**（都记在这里，不悄悄改设计稿）
 *
 * 1. **`touch.coActivateWith` 的元素形状**：设计 §4.5 写的是 `string[]`，
 *    而库的签名是 `CoactivationDeclaration[]`（`{ memoryId, seedIds, activatedAt? }`，
 *    见 `src/neuron/coacts.ts`），`COACT_BATCH_MAX` 校验数的就是这个数组的长度。
 *    ⇒ 本文件按**库的签名**声明 schema（对象数组），因为「把 `string[]` 转成声明数组」
 *      **必然要猜 `seedIds`**（猜错就写成一条错误的因果边）。
 *    ⇒ 结果不变：超 `COACT_BATCH_MAX` 仍然抛 `INVALID_INPUT`
 *      （而且是**库自己**抛的，`details.reason = 'coact_batch_max'` ⇒ 不是被 MCP 层截断）。
 *
 * 2. **不接受调用方传时钟（`now`）**：C37 的时钟注入是**库内部**的测试点
 *    （唯一入口 `src/core/clock.ts` 的 `resolveNow`）。MCP 是**远程**协议
 *    ⇒ 让远端指定 `now` 等于允许伪造事件时间戳（`events.at` 是「可完整重放」的唯一时间基准）
 *    ⇒ 本层一律不转发 `now`。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 【两条与「写放大 / 误用」直接相关的默认值】（PLAN 的硬断言，逐条落到 `inputSchema`）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * · **`recall.explain` 默认 `false`**：`explain: true` 时**库会写一条 `recall` 事件**（§4.6 步骤 4）
 *   ⇒ 常开 = 最高频操作每次写一条事件 = 写放大。默认关闭**由本层保证**
 *   （schema 的 `default: false` + 调度时 `=== true` 判定 ⇒ 缺省/`false` 都不写事件）。
 * · **`forget.hard` 默认 `false`（软删，可 `restore` 撤销）**：硬删**不可撤销**，
 *   必须由调用方**显式**传 `hard: true`（§4.8）。`keepAuditContent` 只在 `hard: true` 时有意义
 *   ⇒ 只给 `keepAuditContent` 不给 `hard` 会被本层**拒掉**（`INVALID_INPUT`），
 *   而不是静默忽略（静默忽略会让调用方以为「审计正文留住了」）。
 * · **`recall` 没有 `source` 过滤**（§6 / PLAN 的常见坑）：`source` 是**溯源元数据**，
 *   本库的核心价值是「**跨来源统一召回**」⇒ 在召回入口按来源过滤等于把卖点关掉。
 *   （`write.source` 是**写入**侧溯源，与过滤无关，保留。）
 *
 * 本文件的所有断言都在 `mcp/tools.test.ts`（**不依赖 SDK**）。
 */

import { MemoryError, type MemoryErrorDetails } from '../src/core/errors.js';
import type { CoactivationDeclaration } from '../src/neuron/coacts.js';
import type { MemoryStore } from '../src/store/MemoryStore.js';
import { MEDIA_TYPES, MEMORY_KINDS, type MediaType, type MemoryKind } from '../src/store/get.js';
import type { RecallOptions } from '../src/store/recall.js';
import type { RestoreOptions } from '../src/store/restore.js';
import type { WriteInput } from '../src/store/write.js';

// ═══════════════════════════════════════════════════════════════════════════
// 〇、工具表的数据形状
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个工具的入参声明（**JSON Schema 字面量**，不是 zod）。
 *
 * ⚠️ **为什么不用 zod**（设计 §9.2 的 N-05）：SDK 直接吃 JSON Schema；
 *   引 zod 要多两个包（`zod` + `zod-to-json-schema`）并把版本三角耦合进来
 *   ⇒ 而这层真正需要的只有「类型 / 必填 / 上限」三件事，手写一个 30 行的校验器就够。
 *
 * ⚠️ ★ **`additionalProperties: false` 是每个 schema 的硬要求**：
 *   它防的是「悄悄吃下未知参数」——调用方把 `explain` 拼成 `explainDetail`，
 *   没有这条时**静默无效**（用户以为开了明细，实际什么都没发生）。
 *   ⚠️ 它**不只是一句声明**：`readArguments()` 会在执行层真的拒掉未知键
 *   （`details.reason = 'invalid_arguments'`）。
 */
export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/** 一个 MCP 工具的声明。 */
export interface ToolDefinition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/**
 * ★ **工具名集合 = 最小集 6 项 + 维护类 4 项（逐个决策过，见文件头决策块 ①）。**
 *
 * ⚠️ 与设计 §4.5 的差异：那里列了 9 项（含 `clusters`、不含 `sweep`）；
 *   终裁（设计 §9.2 的 N-07）是**`sweep` 暴露、`clusters` 不暴露**
 *   ⇒ 本类型按终裁写，**总数仍是 10**（6 + 4）。
 */
export type ToolName =
  // ── 最小集（§12 阶段 5 原文，六项）──
  | 'write'
  | 'recall'
  | 'touch'
  | 'link'
  | 'forget'
  | 'restore'
  // ── 维护类：按需暴露（已决策：暴露）──
  | 'updateContent'
  | 'setAlias'
  | 'mergeEntities'
  | 'sweep';

/**
 * ★ **三个阻塞 1~3 分钟的维护方法 —— 绝不暴露**（PLAN P5-T05 明令 / 设计 §9.1 的 Q-P5-01）。
 *
 * ⚠️ 名单**写死**（不是「从某处推导」）：它是一条**纪律**，不是一张可推导的表
 *   ⇒ 推导出来的名单会在有人改推导源时静默变短。
 */
export const BLOCKED_MAINTENANCE_METHODS: readonly string[] = [
  'rebuildArchivalSchedule',
  'rebuildVectorBuckets',
  'recluster',
];

/** `recall` 的 `topN` 上限（§4.6 内部限制 `1~8`，设计 §4.5 的 schema 同值）。 */
const RECALL_TOP_N_MAX = 8;

/**
 * `void` 类工具（`forget` / `restore` / `updateContent` / `setAlias`）的统一回执。
 *
 * ⚠️ **必须是可 JSON 序列化的真值**：工具结果要经 `JSON.stringify` 变成 `tools/call` 的文本内容
 *   ⇒ 返回 `undefined` 会让 `text` 变成 `undefined`（不是字符串），返回 `Symbol` 更是直接丢掉。
 * ⚠️ 每次返回**新对象**：共享一个实例会让某个调用方的 mutation 污染别人的结果。
 */
function voidResult(): { readonly ok: true } {
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、工具表（`tools/list` 的唯一数据源）
// ═══════════════════════════════════════════════════════════════════════════

/** 六个最小集工具的声明。 */
const MINIMAL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'write',
    title: '写入记忆',
    description:
      '写入一条记忆（正文必填）。与已有记忆完全重复时合并而不是新建（返回值 merged / exact 说明是哪种）。' +
      '向量可选：远程 embedding 请调用方先取好，用 embedding 传入（本服务不做网络请求）。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, description: '记忆正文（落库用原文）。' },
        embedding: {
          type: 'array',
          items: { type: 'number' },
          description: '语义向量；长度必须等于库的 EMBED_DIM。不传则按库的 embedder 规则处理。',
        },
        kind: {
          type: 'string',
          enum: [...MEMORY_KINDS],
          description: '记忆类型，缺省 fact。',
        },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: '本条记忆关联的实体名（主名或别名）。',
        },
        entityAliases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1 },
              aliases: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'aliases'],
            additionalProperties: false,
          },
          description: '显式声明「某个实体有哪些别名」。',
        },
        emotion: { type: 'number', minimum: 0, maximum: 1, description: '情绪强度 0~1。' },
        mediaRef: { type: 'string', description: '原始多模态文件指针。' },
        mediaType: {
          type: 'string',
          enum: [...MEDIA_TYPES],
          description: '多模态类型；与 mediaRef 必须同时给或同时不给。',
        },
        source: {
          type: 'string',
          description: '溯源元数据（写入侧标签，仅存储与展示，不参与召回）。',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '置信度 0~1，缺省 0.7。',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    title: '召回记忆',
    description:
      '按上下文召回相关记忆（三路融合：文本 / 向量 / 图谱）。' +
      '⚠️ explain 默认关闭：设为 true 会返回打分明细，同时**写一条 recall 事件**（写放大）。' +
      '⚠️ 不支持按 source 过滤：本库的价值就是跨来源统一召回。',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', minLength: 1, description: '召回上下文（必填）。' },
        topN: {
          type: 'integer',
          minimum: 1,
          maximum: RECALL_TOP_N_MAX,
          description: '取前 N 条（1~8）。',
        },
        entityNames: {
          type: 'array',
          items: { type: 'string' },
          description: '调用方抽好的实体名（库不抽取实体）；不传则图谱路为空。',
        },
        includeArchived: {
          type: 'boolean',
          default: false,
          description: '是否显式查询归档层（默认 false）。',
        },
        explain: {
          type: 'boolean',
          default: false,
          description: '是否返回打分明细并写一条 recall 事件（默认 false）。',
        },
      },
      required: ['context'],
      additionalProperties: false,
    },
  },
  {
    name: 'touch',
    title: '批量加固',
    description:
      '批量加固若干记忆（提高稳定度、更新 last_access）。' +
      'coActivateWith 显式声明「谁唤起了谁」，库据此写共激活边（库不推断因果）。' +
      '⚠️ coActivateWith 的条目数超上限是**硬错**，不是截断。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: '要加固的记忆 id 列表。',
        },
        coActivateWith: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              memoryId: { type: 'string', minLength: 1 },
              seedIds: { type: 'array', items: { type: 'string' } },
              activatedAt: { type: 'integer' },
            },
            required: ['memoryId', 'seedIds'],
            additionalProperties: false,
          },
          description:
            '共激活声明：memoryId 必须在 ids 内；seedIds 是唤起它的那些记忆（不得含自己）。',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'link',
    title: '建关系',
    description: '按实体名建一条关系边（主-谓-宾），可挂在某条记忆上。',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', minLength: 1, description: '主语实体名。' },
        predicate: { type: 'string', minLength: 1, description: '关系谓词。' },
        object: { type: 'string', minLength: 1, description: '宾语实体名。' },
        memoryId: {
          type: ['string', 'null'],
          description: '关联的记忆 id；null 表示这是一条「断言」而不是某条记忆的内容。',
        },
        createMissing: {
          type: 'boolean',
          default: true,
          description: '缺失实体时自动建（默认 true）。false 时缺失即 NOT_FOUND 且整条零写入。',
        },
      },
      required: ['subject', 'predicate', 'object'],
      additionalProperties: false,
    },
  },
  {
    name: 'forget',
    title: '遗忘',
    description:
      '遗忘一条记忆。⚠️ 默认**软删**（可被 restore 撤销，行仍在）；' +
      '硬删必须显式传 hard: true（不可撤销）。keepAuditContent 只在 hard: true 时有意义。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: '记忆 id。' },
        hard: {
          type: 'boolean',
          default: false,
          description: '硬删（不可撤销）。默认 false = 软删。',
        },
        keepAuditContent: {
          type: 'boolean',
          default: false,
          description:
            '硬删时保留事件里的正文（放弃「原文不再可读」那一半承诺）。需同时 hard: true。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'restore',
    title: '撤销遗忘',
    description:
      '撤销软删。⚠️ 若恢复后与另一条未删记忆的正文完全相同（content_hash 撞），' +
      '默认抛 CONFLICT（带 conflictingId）⇒ 调用方须显式用 mergeInto 指定合并目标。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: '记忆 id。' },
        mergeInto: {
          type: 'string',
          minLength: 1,
          description: '撞 hash 时把待恢复行合并进哪一条（必须是冲突对象的 id）。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

/** 维护类工具的声明（**逐个决策过**：见文件头决策块 ①）。 */
const MAINTENANCE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'updateContent',
    title: '修正正文',
    description:
      '修正一条记忆的正文（人工改正的唯一入口）。只改正文、不加固：stability / last_access / access_count 一个都不动。' +
      '不传 embedding ⇒ 旧向量被置空（旧向量描述的是已经不存在的正文）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: '记忆 id。' },
        newContent: { type: 'string', minLength: 1, description: '新正文。' },
        embedding: {
          type: 'array',
          items: { type: 'number' },
          description: '新正文的向量；不传则向量置空。',
        },
      },
      required: ['id', 'newContent'],
      additionalProperties: false,
    },
  },
  {
    name: 'setAlias',
    title: '设别名',
    description:
      '给实体设一个别名（幂等）。别名是「同一个实体在不同来源里名字不同」时统一召回的关键。' +
      '⚠️ 别名撞既有主名 ⇒ CONFLICT（此时官方下一步是 mergeEntities）。',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', minLength: 1, description: '别名。' },
        entityId: { type: 'string', minLength: 1, description: '目标实体 id。' },
      },
      required: ['alias', 'entityId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mergeEntities',
    title: '合并实体',
    description:
      '把 sourceId 合并进 targetId（记忆关联、边、别名一并迁走；自环边丢弃）。' +
      '它是 setAlias 撞 CONFLICT 时官方指定的下一步。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', minLength: 1, description: '被合并的实体 id。' },
        targetId: { type: 'string', minLength: 1, description: '合并目标实体 id。' },
      },
      required: ['sourceId', 'targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'sweep',
    title: '维护清扫',
    description:
      '★ 两个参数都必须显式给出（不给默认值）：' +
      'purgeDeletedDays = 物理清理「软删超过多少天」的行（0 = 一条都不清，不是「清 0 天前的」）；' +
      'vacuum = 真的删掉了行之后要不要回收空间（VACUUM + FTS 重建）。' +
      '⚠️ 整体属写操作，只读句柄上一律 READONLY_VIOLATION。',
    inputSchema: {
      type: 'object',
      properties: {
        purgeDeletedDays: {
          type: 'integer',
          minimum: 0,
          description: '物理清理「软删超过多少天」的记录；0 = 不清任何东西。',
        },
        vacuum: {
          type: 'boolean',
          description: '是否在真的删掉了行之后回收空间（VACUUM + 全文索引重建）。',
        },
      },
      required: ['purgeDeletedDays', 'vacuum'],
      additionalProperties: false,
    },
  },
];

/**
 * ★ 工具表（`tools/list` 的**唯一**数据源）——
 *   最小集 6 项在前、维护类 4 项在后（顺序稳定 ⇒ 快照与断言可复现）。
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  ...MINIMAL_TOOL_DEFINITIONS,
  ...MAINTENANCE_TOOL_DEFINITIONS,
];

/** 工具名的有序清单（测试与错误详情共用）。 */
export const TOOL_NAMES: readonly ToolName[] = TOOL_DEFINITIONS.map((tool) => tool.name);

// ═══════════════════════════════════════════════════════════════════════════
// 二、工具表的**结构性不变量**（模块初始化时执行 ⇒ 违规者 import 就炸）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ 断言「工具表里没有阻塞维护方法」。
 *
 * ⚠️ **导出它不是为了复用，是为了让这条纪律可被反例验证**：
 *   `mcp/tools.test.ts` 会把一份**沾污的名单**（`[...TOOL_NAMES, 'recluster']`）喂给它
 *   ⇒ 必须抛错。否则这条断言就退化成「我们相信它没被加进去」。
 *
 * @throws {MemoryError} `INVALID_INPUT`（`details.reason = 'blocked_maintenance_exposed'`）
 */
export function assertNoBlockedMaintenance(names: readonly string[]): void {
  const blocked = names.filter((name) => BLOCKED_MAINTENANCE_METHODS.includes(name));
  if (blocked.length > 0) {
    throw MemoryError.invalidInput(
      `工具表里出现了阻塞 1~3 分钟的维护方法（一次性把工具注册注销）：${blocked.join(' / ')}`,
      { reason: 'blocked_maintenance_exposed', blocked },
    );
  }
}

/**
 * 断言工具名不重复。
 *
 * ⚠️ 重复名会让 `tools/call` 永远命中**先出现的那一个** ⇒ 后一个静默不可达
 *   （不是「都能用」，是「有一个永远用不到」）。
 *
 * @throws {MemoryError} `INVALID_INPUT`（`details.reason = 'duplicate_tool_name'`）
 */
export function assertUniqueToolNames(names: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of names) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  if (duplicates.length > 0) {
    throw MemoryError.invalidInput(`工具名重复：${duplicates.join(' / ')}`, {
      reason: 'duplicate_tool_name',
      duplicates,
    });
  }
}

// ⚠️ **模块初始化即校验**：谁把 `recluster` / 重复名塞进工具表，本模块 import 就抛
//   ⇒ 所有用到它的测试与 `mcp/server.ts` 启动当场失败（**不留「跑起来才发现」的窗口**）。
assertUniqueToolNames(TOOL_NAMES);
assertNoBlockedMaintenance(TOOL_NAMES);

// ═══════════════════════════════════════════════════════════════════════════
// 三、入参校验（JSON Schema 的**最小执行器**）
// ═══════════════════════════════════════════════════════════════════════════

/** JSON Schema 子树（本文件的 schema 只用得到这几种关键字）。 */
type SchemaNode = Record<string, unknown>;

/** 校验失败的统一构造器（`details` 里带工具名 + 路径，调用方能直接定位）。 */
function invalidArgument(
  tool: string,
  path: string,
  expected: string,
  extra: MemoryErrorDetails = {},
): MemoryError {
  return MemoryError.invalidInput(`工具 ${tool} 的入参不合法：${path} 期望 ${expected}`, {
    reason: 'invalid_arguments',
    tool,
    path,
    expected,
    ...extra,
  });
}

/** `type` 的取值（支持 `['string','null']` 这种联合写法）。 */
function typeNamesOf(schema: SchemaNode): readonly string[] {
  const type = schema.type;
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === 'string');
  return [];
}

/** 实际值的 JSON 类型名（只用于报错文案）。 */
function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 单个值是否满足某个 JSON Schema `type`。 */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // ⚠️ 未知 type 一律判**不通过**：宁可拒绝一个合法入参（调用方会看见明确的 expected），
      //   也不能悄悄放行（放行 = 校验器对没见过的关键字失效，而失效是静默的）。
      return false;
  }
}

/** 读一个可选的上限/下限数字（schema 里写错类型时返回 `undefined`，不抛）。 */
function asLimit(schema: SchemaNode, key: string): number | undefined {
  const value = schema[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * 递归校验一个值。
 *
 * 覆盖本文件 schema 真正用到的关键字：`type` / `enum` / `minLength` / `minimum` / `maximum` /
 * `minItems` / `items` / `properties` / `required` / `additionalProperties`。
 * **不覆盖**（用不到）：`pattern` / `oneOf` / `$ref` / `format` ……
 * ⇒ 需要它们时**先把它们加到这里**，再写进 schema（否则那条关键字是「写了但没执行」）。
 */
function validateNode(tool: string, path: string, schema: SchemaNode, value: unknown): void {
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.includes(value)) {
    throw invalidArgument(tool, path, `枚举值之一（${enumValues.join(' / ')}）`, {
      actual: value,
    });
  }

  const types = typeNamesOf(schema);
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    throw invalidArgument(tool, path, types.join(' | '), { actual: typeNameOf(value) });
  }

  if (typeof value === 'string') {
    const minLength = asLimit(schema, 'minLength');
    if (minLength !== undefined && value.length < minLength) {
      throw invalidArgument(tool, path, `长度 >= ${String(minLength)} 的字符串`, {
        actualLength: value.length,
      });
    }
    return;
  }

  if (typeof value === 'number') {
    const minimum = asLimit(schema, 'minimum');
    if (minimum !== undefined && value < minimum) {
      throw invalidArgument(tool, path, `>= ${String(minimum)} 的数`, { actual: value });
    }
    const maximum = asLimit(schema, 'maximum');
    if (maximum !== undefined && value > maximum) {
      throw invalidArgument(tool, path, `<= ${String(maximum)} 的数`, { actual: value });
    }
    return;
  }

  if (Array.isArray(value)) {
    const minItems = asLimit(schema, 'minItems');
    if (minItems !== undefined && value.length < minItems) {
      throw invalidArgument(tool, path, `至少 ${String(minItems)} 项`, {
        actualLength: value.length,
      });
    }
    const items = schema.items;
    if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
      const itemSchema = items as SchemaNode;
      value.forEach((item, index) => {
        validateNode(tool, `${path}[${String(index)}]`, itemSchema, item);
      });
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties;
    const propertySchemas: Record<string, SchemaNode> =
      typeof properties === 'object' && properties !== null && !Array.isArray(properties)
        ? (properties as Record<string, SchemaNode>)
        : {};

    // ① 必填
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key !== 'string') continue;
        if (record[key] === undefined) {
          throw MemoryError.invalidInput(`工具 ${tool} 的入参缺少必填项：${path}.${key}`, {
            reason: 'missing_required',
            tool,
            path: `${path}.${key}`,
            required: required.filter((item): item is string => typeof item === 'string'),
          });
        }
      }
    }

    // ② 未知键（`additionalProperties: false` 的**执行层**）
    if (schema.additionalProperties === false) {
      const unknownKeys = Object.keys(record).filter((key) => propertySchemas[key] === undefined);
      if (unknownKeys.length > 0) {
        throw MemoryError.invalidInput(
          `工具 ${tool} 的入参含未声明的键：${unknownKeys.join(' / ')}`,
          {
            reason: 'invalid_arguments',
            tool,
            path,
            unknownKeys,
            allowedKeys: Object.keys(propertySchemas),
          },
        );
      }
    }

    // ③ 已声明的键逐个递归（`undefined` 视同「没给」——JSON 里没有 undefined）
    for (const [key, childSchema] of Object.entries(propertySchemas)) {
      const childValue = record[key];
      if (childValue === undefined) continue;
      validateNode(tool, `${path}.${key}`, childSchema, childValue);
    }
  }
}

/**
 * 校验并返回入参对象。
 *
 * ⚠️ `args === undefined / null` 归一成 `{}`：MCP 客户端对「无参数的工具」会省略 `arguments`
 *   ⇒ 那时该报的是「缺必填项」，而不是「入参不是 object」。
 */
function readArguments(definition: ToolDefinition, args: unknown): Record<string, unknown> {
  const normalized: unknown = args === undefined || args === null ? {} : args;
  validateNode(definition.name, '$', definition.inputSchema as unknown as SchemaNode, normalized);
  return normalized as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、错误的结构化转换（§11.2：错误码 + details，不是裸文本）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个错误的**结构化**表达（交给 `mcp/server.ts` 序列化成 `isError: true` 的内容）。
 *
 * ⚠️ `code` 优先取 `MemoryError.code`（§11.2 的五个码）。
 *   库之外的意外错误（如 `TypeError`）用 `MCP_INTERNAL_ERROR_CODE` 表示 ——
 *   它**不是** `MemoryError` 的码，也**不得**被塞进 §11.2 的封闭集合（那会污染调用方的分流逻辑）。
 */
export interface ToolErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

/** 库之外意外错误的码（MCP 层专属，**不是** §11.2 的码）。 */
export const MCP_INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

/**
 * 把任意错误转成结构化回执。
 *
 * ⚠️ **不改写 `MemoryError` 的 `message` / `details`**（§11.2：门面与各层「不包装、不改写」
 *   ——包一层会让调用方拿不到错误码，整张「缺失的表达方式」表就失效）。
 */
export function toToolErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof MemoryError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: MCP_INTERNAL_ERROR_CODE,
    message,
    details: { reason: 'unexpected_error' },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、调度（**纯函数**：不 import SDK、全同步、错误原样抛）
// ═══════════════════════════════════════════════════════════════════════════

/** 未知工具名 ⇒ `INVALID_INPUT`（**返回错误，不是编译期炸**：远端可以传任何字符串）。 */
function unknownTool(name: string): MemoryError {
  return MemoryError.invalidInput(`未注册的工具：${name}`, {
    reason: 'unknown_tool',
    tool: name,
    available: TOOL_NAMES,
  });
}

/**
 * 把工具名 + 入参派发到 `MemoryStore` 的对应方法。
 *
 * ⚠️ `name` 收 `string` 而不是 `ToolName`（设计 §4.5 的签名）：**未知名字要返回错误**
 *   （远端传什么都有可能），收敛成联合类型只会在编译期把「运行期输入」当成「编译期常量」。
 *
 * ⚠️ **全同步**：返回值**不是** `Promise`（库是同步 API，异步包装在最外层 `mcp/server.ts`）。
 *
 * @throws {MemoryError} 库的错误**原样抛出**（`NOT_FOUND` / `INVALID_INPUT` / `CONFLICT` /
 *   `READONLY_VIOLATION` / `DATABASE_BUSY`）；由 `mcp/server.ts` 转成结构化回执。
 */
export function dispatchTool(store: MemoryStore, name: string, args: unknown): unknown {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (definition === undefined) {
    throw unknownTool(name);
  }
  const input = readArguments(definition, args);

  switch (definition.name) {
    case 'write': {
      // ⚠️ 用条件展开而不是显式写 `undefined`：`exactOptionalPropertyTypes` 下
      //   「属性是 undefined」与「属性不存在」是两件事，后者才是本意。
      const payload: WriteInput = {
        content: input.content as string,
        ...(input.embedding === undefined ? {} : { embedding: input.embedding as number[] }),
        ...(input.kind === undefined ? {} : { kind: input.kind as MemoryKind }),
        ...(input.entities === undefined ? {} : { entities: input.entities as string[] }),
        ...(input.entityAliases === undefined
          ? {}
          : { entityAliases: input.entityAliases as NonNullable<WriteInput['entityAliases']> }),
        ...(input.emotion === undefined ? {} : { emotion: input.emotion as number }),
        ...(input.mediaRef === undefined ? {} : { mediaRef: input.mediaRef as string }),
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType as MediaType }),
        ...(input.source === undefined ? {} : { source: input.source as string }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence as number }),
      };
      return store.write(payload);
    }

    case 'recall': {
      // ★ `explain` 默认关闭：只有**显式** `true` 才写事件（`=== true` 判定 ⇒ `false`/缺省都不写）。
      // ★ 没有 `source` 过滤（§6：它会让「跨来源统一召回」这个卖点失效）。
      const options: RecallOptions = {
        context: input.context as string,
        ...(input.topN === undefined ? {} : { topN: input.topN as number }),
        ...(input.entityNames === undefined ? {} : { entityNames: input.entityNames as string[] }),
        includeArchived: input.includeArchived === true,
        explain: input.explain === true,
      };
      return store.recall(options);
    }

    case 'touch': {
      const ids = input.ids as string[];
      const declarations = input.coActivateWith as CoactivationDeclaration[] | undefined;
      // ⚠️ `coActivateWith` **原样转交**（不截断、不去重）：
      //   条目数超 `COACT_BATCH_MAX` 必须由库抛 `INVALID_INPUT`（截断 = 静默丢失共激活边）。
      return store.touch(
        ids,
        undefined,
        declarations === undefined ? {} : { coActivateWith: declarations },
      );
    }

    case 'link': {
      const memoryId = input.memoryId as string | null | undefined;
      return store.link(
        input.subject as string,
        input.predicate as string,
        input.object as string,
        memoryId,
        undefined,
        // `createMissing` 缺省 = true（§4.5：`!== false` 即建）⇒ 只在显式给了值时覆盖。
        input.createMissing === undefined ? {} : { createMissing: input.createMissing === true },
      );
    }

    case 'forget': {
      const hard = input.hard === true;
      const keepAuditContent = input.keepAuditContent === true;
      // ⚠️ `keepAuditContent` 只在硬删时有意义（`src/store/forget.ts` 的软删分支不理它）
      //   ⇒ 只给这一个开关会让调用方**以为「审计正文留住了」**，而实际什么都没发生。
      //   ⇒ 明确拒掉，不静默忽略。
      if (keepAuditContent && !hard) {
        throw MemoryError.invalidInput(
          'keepAuditContent 只在 hard: true 时有意义（软删不处置任何正文）⇒ 请显式传 hard: true',
          {
            reason: 'keep_audit_content_requires_hard',
            tool: 'forget',
            path: '$.keepAuditContent',
            hint: { hard: true },
          },
        );
      }
      store.forget(input.id as string, { hard, keepAuditContent }, undefined);
      return voidResult();
    }

    case 'restore': {
      const options: RestoreOptions =
        input.mergeInto === undefined ? {} : { mergeInto: input.mergeInto as string };
      store.restore(input.id as string, options, undefined);
      return voidResult();
    }

    case 'updateContent': {
      // ⚠️ `embedding` 不传 ⇒ 库把向量置空（旧向量描述的是已经不存在的正文）。
      store.updateContent(
        input.id as string,
        input.newContent as string,
        undefined,
        input.embedding as number[] | undefined,
      );
      return voidResult();
    }

    case 'setAlias': {
      store.setAlias(input.alias as string, input.entityId as string);
      return voidResult();
    }

    case 'mergeEntities': {
      return store.mergeEntities(input.sourceId as string, input.targetId as string);
    }

    case 'sweep': {
      // ★ 两个参数都**必须**由调用方给出（schema 的 `required` 已强制）
      //   ⇒ 本层不提供任何默认值：默认「清 0 天前的」会让一次误调用变成全库物理删除。
      return store.sweep(
        {
          purgeDeletedDays: input.purgeDeletedDays as number,
          vacuum: input.vacuum as boolean,
        },
        undefined,
      );
    }
  }
}
