/**
 * v1.0 基线等价验收 —— DEVELOPMENT-PLAN.md **P1-T09**。
 *
 * ★ **这条测试要回答的问题**：「关掉新机制之后，行为是不是与 v1.0 逐位一致？」
 *   （§5 的基线条件：**四个布尔开关全关** + **`VECTOR_ROUTER='flat'`**，ADR-21。）
 *
 * ⚠️ **为什么不能「拿 golden 集反推」**（`tests/baseline/ref-v1.ts` 的 P0 段原话）：
 *   从当前实现录下来的 golden 集 = **当前实现的行为** ⇒ 拿它当基线等于拿
 *   「现在的自己」证明「现在的自己没变」⇒ **循环论证**。
 *   ⇒ 本文件用**独立重算的 v1.0 参考实现**（`tests/baseline/ref-v1.ts` 的第二段）做比对：
 *     参考实现按 DESIGN §4.1 / §4.2 / §4.3 / §4.6 / §4.9 **自己算一遍**，
 *     本文件只负责**喂引擎事实**（FTS5 的 `bm25()` 原始值、命中的行、证据边条数），
 *     并把两侧的**可观测输出**归一化后逐位比对。
 *
 * ⚠️ **基线覆盖的四个方法**（`stats` 不在其中：它不在阶段 1 的 10 个方法内且当前未实现）：
 *   `write` / `recall` / `touch` / `get`。
 *
 * ⚠️ **id 的规范化口径**（必须写死，否则比对无意义）：
 *   真实 id 是**随机 uuid** ⇒ 两侧不可能「逐位相同」。
 *   ⇒ 本文件把「**第 k 次写入创建的那条记忆**」作为两侧的共同键（`recordKey`），
 *     逐位比对的是**这个键**以及**挂在它上面的全部可观测字段**。
 *   ⇒ 若两侧对「哪一次写入创建了哪条记忆」的判断不一致 ⇒ 键对不上 ⇒ **判红**。
 *
 * ⚠️ **断言用 `toEqual` 而不是 `toBeCloseTo`**：本基线要的是**逐位相同**，
 *   近似比较会把「权重差 1e-6」这种真漂移放过去。
 */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { isBaselineConfig } from '../../src/core/flags.js';
import { DEFAULT_PARAMS, type Params } from '../../src/core/params.js';
import { createSchema } from '../../src/db/connection.js';
import { EventWriter } from '../../src/store/events.js';
import { type MemoryKind, type MemoryView, get } from '../../src/store/get.js';
import { link } from '../../src/store/link.js';
import { type RecallResult, recall } from '../../src/store/recall.js';
import { type TouchOutcome, touch } from '../../src/store/touch.js';
import { type WriteResult, write } from '../../src/store/write.js';
import { MemoryLogger } from '../../src/util/log.js';
import {
  REF_FORMULAS,
  REF_V1_PARAMS,
  type RefV1Model,
  type RefV1RecallEvidence,
  type RefV1WriteEvidence,
  type RefV1WriteInput,
  createRefV1Model,
  refEntityName,
  refGet,
  refRecall,
  refTouch,
  refWrite,
} from './ref-v1.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、基线配置与语料
// ═══════════════════════════════════════════════════════════════════════════

/** 语料的基准时刻（固定值 ⇒ 完全确定）。 */
const T0 = 1_700_000_000_000;

/** 一天（毫秒）。 */
const DAY = 86_400_000;

/** 一小时（毫秒）。 */
const HOUR = 3_600_000;

/**
 * 基线参数（**手写**，不用 `toBaselineParams()`）。
 *
 * ⚠️ **为什么手写**：`toBaselineParams()` 本身也是被测代码 ⇒ 用它来构造基线，
 *   等于让「基线条件」这件事依赖于被审对象 ⇒ 它哪天坏了，基线会**静默地**不再是基线。
 *   ⇒ 这里手写字面量，并**另外**用 `isBaselineConfig()` 交叉校验。
 */
const BASELINE_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  coactivation: false,
  inhibition: false,
  writeBack: false,
  ARCHIVAL_CACHE: false,
  VECTOR_ROUTER: 'flat',
};

/** 语料的一步。 */
type CorpusStep =
  | {
      op: 'write';
      content: string;
      kind?: MemoryKind;
      entities?: string[];
      entityAliases?: Array<{ name: string; aliases: string[] }>;
      confidence?: number;
      emotion?: number;
      source?: string;
      now: number;
    }
  | { op: 'recall'; context: string; topN?: number; now: number }
  | { op: 'touch'; targets: number[]; now: number }
  | { op: 'get'; target: number; now: number };

/**
 * 语料（**17 次写 + 5 次召回 + 3 次 touch + 5 次 get**）。
 *
 * ⚠️ **每一条语料都对应一个必须被守住的语义**（否则那条用例是空跑）：
 *   · 写 0/1：新建 + 「首因优待」（`DIFFICULTY_FIRST`）；
 *   · 写 2：**近似合并**（§4.9 步骤 3a/3b/3c；实体重叠 ≥ `DEDUP_ENTITY_MIN`）；
 *   · 写 8：**完全重复**（§4.9 步骤 2；`exact=true`、正文不变）；
 *   · 写 12/13：**别名冲突**（§4.9 步骤 1c；`ALIAS_CONFLICT` 进 `warnings`）；
 *   · 写 14：**不构成合并**（去重查询串没命中 ⇒ 新建）；
 *   · 写 15/16：**置信度惩罚**与**情绪加权**（§4.3 的两个初值公式）；
 *   · 召 17：**OR 宽松路**（> 3 个 token）；
 *   · 召 18/19/20：**AND 精确路**；
 *   · 召 21：**LIKE 单字兜底路**（`normBm25` 恒为 1.0）；
 *   · touch 22：**跨天加固**（`spacing` 生效）；
 *   · touch 23：**同日守卫**（`intervalDays < 1` ⇒ **不增长**，`stabilityDelta = 0`）；
 *   · touch 24：**大间隔**（`spacing` 触 `SPACING_CAP`）；
 *   · get 25~29：**不同 `now` 下的 `intensity` / `layer`** 与「不存在的 id ⇒ `null`」。
 *
 * ⚠️ **时间轴为什么这样排**（这是本文件最容易踩空的地方）：
 *   召回的**强度精筛**是 `intensity > ARCHIVE_LINE`（0.05）⇒
 *   `Δt < τ × ln(20)`（τ = 稳定度，天）。默认初始稳定度只有 **1 天**
 *   ⇒ 写完 **3 天**后这条记忆就被精筛掉了。
 *   ⇒ 若把召回放在「几天后」，召回会返回**空集** ⇒ 基线「全绿」但**什么都没验**。
 *   ⇒ 因此：写入集中在 **17 秒**内、召回放在 **1 小时**后（此时强度 ≈ 0.96，存活），
 *     而 touch 放在 **2 天后 / 2 天后 1 秒 / 40 天后**（分别覆盖跨天加固、同日守卫、大间隔）。
 */
const CORPUS: CorpusStep[] = [
  { op: 'write', content: '张三住在北京', kind: 'fact', entities: ['张三'], now: T0 },
  {
    op: 'write',
    content: '张三喜欢猫',
    kind: 'preference',
    entities: ['张三', '猫'],
    now: T0 + 1000,
  },
  {
    op: 'write',
    content: '张三喜欢猫粮',
    kind: 'preference',
    entities: ['张三', '猫'],
    now: T0 + 2000,
  },
  { op: 'write', content: '李四在杭州工作', kind: 'fact', entities: ['李四'], now: T0 + 3000 },
  {
    op: 'write',
    content: '李四喜欢用 PostgreSQL',
    kind: 'preference',
    entities: ['李四', 'PostgreSQL'],
    now: T0 + 4000,
  },
  { op: 'write', content: '王五负责周会', kind: 'event', entities: ['王五'], now: T0 + 5000 },
  {
    op: 'write',
    content: '周会每周一上午十点',
    kind: 'event',
    entities: ['周会'],
    now: T0 + 6000,
  },
  {
    op: 'write',
    content: '赵六喜欢喝咖啡',
    kind: 'preference',
    entities: ['赵六'],
    now: T0 + 7000,
  },
  { op: 'write', content: '张三住在北京', kind: 'fact', entities: ['张三'], now: T0 + 8000 },
  {
    op: 'write',
    content: '孙七在学 Rust',
    kind: 'fact',
    entities: ['孙七', 'Rust'],
    now: T0 + 9000,
  },
  { op: 'write', content: '周报每周五提交', kind: 'event', entities: ['周报'], now: T0 + 10_000 },
  { op: 'write', content: '咖啡机在三楼', kind: 'fact', entities: ['咖啡机'], now: T0 + 11_000 },
  {
    op: 'write',
    content: '郑八喜欢喝茶',
    kind: 'preference',
    entities: ['郑八'],
    entityAliases: [{ name: '郑八', aliases: ['老郑'] }],
    now: T0 + 12_000,
  },
  {
    op: 'write',
    content: '吴九喜欢喝果汁',
    kind: 'preference',
    entities: ['吴九'],
    entityAliases: [{ name: '吴九', aliases: ['张三'] }],
    now: T0 + 13_000,
  },
  { op: 'write', content: '周会改到周三', kind: 'event', entities: ['周会'], now: T0 + 14_000 },
  {
    op: 'write',
    content: '低置信度的记忆',
    kind: 'fact',
    entities: ['低置信度'],
    confidence: 0.2,
    now: T0 + 15_000,
  },
  {
    op: 'write',
    content: '高情绪的记忆',
    kind: 'event',
    entities: ['高情绪'],
    emotion: 0.8,
    now: T0 + 16_000,
  },
  { op: 'recall', context: '张三住哪里', topN: 5, now: T0 + HOUR },
  { op: 'recall', context: '周会', topN: 5, now: T0 + HOUR + 1000 },
  { op: 'recall', context: '咖啡', topN: 3, now: T0 + HOUR + 2000 },
  { op: 'recall', context: 'PostgreSQL', topN: 5, now: T0 + HOUR + 3000 },
  { op: 'recall', context: '猫', topN: 5, now: T0 + HOUR + 4000 },
  { op: 'touch', targets: [0, 1], now: T0 + 2 * DAY },
  { op: 'touch', targets: [0], now: T0 + 2 * DAY + 1000 },
  { op: 'touch', targets: [3, 4], now: T0 + 40 * DAY },
  { op: 'get', target: 0, now: T0 + 2 * DAY + HOUR },
  { op: 'get', target: 1, now: T0 + 41 * DAY },
  { op: 'get', target: 6, now: T0 + 41 * DAY },
  { op: 'get', target: 13, now: T0 + 41 * DAY },
  { op: 'get', target: -1, now: T0 + 41 * DAY },
  // ⚠️ **时钟回拨**：`now` 早于 `last_access` ⇒ `Δt` 被 `max(0, ·)` 钳到 0 ⇒
  //   强度恒为 1（§4.1 的第一重钳制；F-08 的正域不可观测 ⇒ 这里专门钉住它）。
  { op: 'get', target: 0, now: T0 },
];

// ═══════════════════════════════════════════════════════════════════════════
// 二、真实实现的驱动器（跑语料 + 收集引擎事实 + 记录真实输出）
// ═══════════════════════════════════════════════════════════════════════════

/** 一条落库事件的形状。 */
interface StoredEvent {
  type: string;
  memory_id: string | null;
  payload: Record<string, unknown>;
  at: number;
}

/** 一次操作的引擎事实（**只喂给参考实现**，不参与比对）。 */
type Evidence =
  | {
      kind: 'write';
      dedupCandidates: RefV1WriteEvidence['dedupCandidates'];
      edgesByRefId: Record<string, number>;
    }
  | { kind: 'recall'; ftsRows: RefV1RecallEvidence['ftsRows']; likeRows: string[] }
  | { kind: 'touch'; edgesByRefId: Record<string, number> }
  | { kind: 'none' };

/** 真实侧每一步的原始输出。 */
type RealStepOutput =
  | { op: 'write'; result: WriteResult }
  | { op: 'recall'; result: RecallResult }
  | { op: 'touch'; outcomes: TouchOutcome[] }
  | { op: 'get'; view: MemoryView | null };

/** 语料跑完之后的产物。 */
interface RealRun {
  /** 每一步的**引擎事实**（按步骤顺序）。 */
  evidence: Evidence[];
  /** 每一步的**真实输出**（按步骤顺序）。 */
  outputs: RealStepOutput[];
  /** 每次写入返回的 id（按步骤顺序；合并 / 完全重复也占位）。 */
  writtenIds: string[];
  /** 每次写入**创建**的记忆 id（按创建顺序）。 */
  createdIds: string[];
  /** 记忆 id ⇒ 「创建它的那次写入」的步骤序号（两侧的共同键）。 */
  recordKey: Map<string, number>;
  /** 实体 id ⇒ 实体名。 */
  entityNames: Map<string, string>;
  /** 每一步落库的事件（按步骤顺序）。 */
  eventsPerStep: StoredEvent[][];
}

/** 建一个全新的内存库 + store 上下文。 */
function createWorld(): {
  db: Database.Database;
  store: { db: Database.Database; params: Params; events: EventWriter; logger: MemoryLogger };
} {
  const db = new Database(':memory:');
  createSchema(db);
  const logger = new MemoryLogger();
  const events = new EventWriter(db, { readonly: false, logger, now: () => 0 });
  return { db, store: { db, params: BASELINE_PARAMS, events, logger } };
}

/** 读全部事件（按落库顺序）。 */
function readEvents(db: Database.Database): StoredEvent[] {
  const rows = db
    .prepare('SELECT type, memory_id, payload, at FROM events ORDER BY id')
    .all() as Array<{ type: string; memory_id: string | null; payload: string; at: number }>;
  return rows.map((row) => ({
    type: row.type,
    memory_id: row.memory_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    at: row.at,
  }));
}

/** 证据边的条数（按记忆 id 统计；§4.5 的 R-EDGE-TOUCH）。 */
function readEdgeCounts(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(
      'SELECT memory_id, COUNT(*) AS n FROM edges WHERE memory_id IS NOT NULL GROUP BY memory_id',
    )
    .all() as Array<{ memory_id: string; n: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.memory_id] = row.n;
  }
  return counts;
}

/** 读一个记忆已关联的实体**名**（升序）。 */
function readEntityNamesOf(db: Database.Database, memoryId: string): string[] {
  const rows = db
    .prepare(
      `SELECT e.name AS name
         FROM memory_entities me JOIN entities e ON e.id = me.entity_id
        WHERE me.memory_id = ?
        ORDER BY e.name ASC`,
    )
    .all(memoryId) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** 把 BLOB 里的向量解成普通数组（**测试夹具自己的解码**，不借库的实现）。 */
function decodeVector(blob: Buffer | null): number[] | null {
  if (blob === null) {
    return null;
  }
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(floats);
}

/**
 * §4.9 步骤 3a 的去重候选（**引擎事实**）。
 *
 * ⚠️ **查询串由参考实现给出**（`REF_FORMULAS.dedupQuery`）⇒ 两侧对「什么叫候选」的理解一致；
 *   命中哪些行是 SQLite 的事实。
 */
function readDedupCandidates(
  db: Database.Database,
  matchSql: string,
): Array<{ realId: string; entityNames: string[]; embedding: number[] | null }> {
  if (matchSql === '') {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.embedding AS embedding
         FROM mem_fts JOIN memories m ON mem_fts.rowid = m.rowid
        WHERE mem_fts MATCH @matchSql
          AND m.deleted = 0
        ORDER BY bm25(mem_fts) ASC
        LIMIT 3`,
    )
    .all({ matchSql }) as Array<{ id: string; embedding: Buffer | null }>;
  return rows.map((row) => ({
    realId: row.id,
    entityNames: readEntityNamesOf(db, row.id),
    embedding: decodeVector(row.embedding),
  }));
}

/** §4.6 步骤 2a 的文本路命中行（**引擎事实**：`bm25()` 的原始值来自 SQLite）。 */
function readFtsRows(
  db: Database.Database,
  matchSql: string,
): Array<{ realId: string; rawBm25: number | null }> {
  if (matchSql === '') {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT m.id AS id, bm25(mem_fts) AS raw_bm25
         FROM mem_fts JOIN memories m ON mem_fts.rowid = m.rowid
        WHERE mem_fts MATCH @matchSql
          AND m.deleted = 0
        ORDER BY bm25(mem_fts) ASC
        LIMIT 100`,
    )
    .all({ matchSql }) as Array<{ id: string; raw_bm25: number | null }>;
  return rows.map((row) => ({ realId: row.id, rawBm25: row.raw_bm25 }));
}

/** §4.6 步骤 2a 的 LIKE 单字兜底命中行（**引擎事实**）。 */
function readLikeRows(db: Database.Database, fallbackLike: string): string[] {
  if (fallbackLike === '') {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT m.id AS id
         FROM memories m
        WHERE m.content LIKE ('%' || @fallbackLike || '%') ESCAPE '\\'
          AND m.deleted = 0
        ORDER BY m.last_access DESC
        LIMIT 100`,
    )
    .all({ fallbackLike }) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** 跑一遍语料（真实实现），并把每一步的**引擎事实**与**真实输出**收集下来。 */
function runRealCorpus(): RealRun {
  const { db, store } = createWorld();
  const evidence: Evidence[] = [];
  const outputs: RealStepOutput[] = [];
  const writtenIds: string[] = [];
  const createdIds: string[] = [];
  const recordKey = new Map<string, number>();
  const eventsPerStep: StoredEvent[][] = [];
  let edgesSeeded = false;

  for (const [stepIndex, step] of CORPUS.entries()) {
    // ── 语料准备：建两条证据边（让 `edgesReinforced` 有非零值可判）──
    // ⚠️ `link` 不在本次基线覆盖的四个方法内 ⇒ 它只用来**造状态**。
    // ⚠️ **必须早于任何 touch**（否则 `edgesReinforced` 恒为 0，判据失效）。
    if (!edgesSeeded && step.op !== 'write') {
      const first = writtenIds[0];
      const second = writtenIds[1];
      if (first !== undefined && second !== undefined) {
        link(store, '张三', '喜欢', '猫', second, T0 + 19 * DAY);
        link(store, '张三', '住在', '北京', first, T0 + 19 * DAY);
      }
      edgesSeeded = true;
    }

    const eventsBefore = readEvents(db).length;
    switch (step.op) {
      case 'write': {
        const dedupQuery = REF_FORMULAS.dedupQuery(step.content);
        const candidates = readDedupCandidates(db, dedupQuery);
        evidence.push({
          kind: 'write',
          dedupCandidates: candidates.map((candidate) => ({
            refId: candidate.realId,
            entityNames: candidate.entityNames,
            embedding: candidate.embedding,
          })),
          edgesByRefId: readEdgeCounts(db),
        });
        const result = write(store, {
          content: step.content,
          ...(step.kind === undefined ? {} : { kind: step.kind }),
          ...(step.entities === undefined ? {} : { entities: step.entities }),
          ...(step.entityAliases === undefined ? {} : { entityAliases: step.entityAliases }),
          ...(step.confidence === undefined ? {} : { confidence: step.confidence }),
          ...(step.emotion === undefined ? {} : { emotion: step.emotion }),
          ...(step.source === undefined ? {} : { source: step.source }),
          now: step.now,
        });
        outputs.push({ op: 'write', result });
        writtenIds.push(result.id);
        if (!result.merged) {
          createdIds.push(result.id);
          recordKey.set(result.id, stepIndex);
        }
        break;
      }
      case 'recall': {
        const query = REF_FORMULAS.buildMatchQuery(step.context);
        const ftsRows = readFtsRows(db, query.matchSql ?? '');
        const likeRows = readLikeRows(db, query.fallbackLike ?? '');
        evidence.push({
          kind: 'recall',
          ftsRows: ftsRows.map((row) => ({ refId: row.realId, rawBm25: row.rawBm25 })),
          likeRows,
        });
        const result = recall(store, {
          context: step.context,
          ...(step.topN === undefined ? {} : { topN: step.topN }),
          // ⚠️ 用 `diagnostics` 而不是 `explain`：`diagnostics` 给同样的 `breakdown`，
          //   但**不写 `recall` 事件** ⇒ 事件流里只有真正的业务事件（§4.6 步骤 4）。
          diagnostics: true,
          now: step.now,
        });
        outputs.push({ op: 'recall', result });
        break;
      }
      case 'touch': {
        evidence.push({ kind: 'touch', edgesByRefId: readEdgeCounts(db) });
        const ids = step.targets.map((target) => {
          const id = writtenIds[target];
          if (id === undefined) {
            throw new Error(`语料引用了尚未写入的 id：第 ${target} 次写`);
          }
          return id;
        });
        const outcomes = touch(store, ids, step.now);
        outputs.push({ op: 'touch', outcomes });
        break;
      }
      case 'get': {
        evidence.push({ kind: 'none' });
        const id =
          step.target < 0 ? '不存在的记忆 id' : (writtenIds[step.target] ?? '不存在的记忆 id');
        const view = get(store, id, step.now);
        outputs.push({ op: 'get', view });
        break;
      }
      default: {
        throw new Error(`未知步骤：${JSON.stringify(step)}`);
      }
    }
    eventsPerStep.push(readEvents(db).slice(eventsBefore));
  }

  const entityNames = new Map<string, string>();
  const entityRows = db.prepare('SELECT id, name FROM entities').all() as Array<{
    id: string;
    name: string;
  }>;
  for (const row of entityRows) {
    entityNames.set(row.id, row.name);
  }

  return { evidence, outputs, writtenIds, createdIds, recordKey, entityNames, eventsPerStep };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、归一化（把两侧的输出变成**可逐位比对**的形状）
// ═══════════════════════════════════════════════════════════════════════════

/** id 归一化需要的两张表。 */
interface IdResolver {
  /** 记忆 id ⇒ 「创建它的那次写入」的步骤序号（两侧的共同键）。 */
  recordKey(id: string): number | null;
  /** 实体 id ⇒ 实体名。 */
  entityName(id: string): string;
}

/** 把事件 payload 里的 id 归一化（**顺序必须保留**）。 */
function normalizePayload(
  payload: Record<string, unknown>,
  resolver: IdResolver,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = normalizePayloadValue(key, value, resolver);
  }
  return out;
}

function normalizePayloadValue(key: string, value: unknown, resolver: IdResolver): unknown {
  if (key === 'id' || key === 'targetId' || key === 'memory_id') {
    return typeof value === 'string' ? resolver.recordKey(value) : value;
  }
  if (key === 'entityIds' || key === 'addedEntities') {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? resolver.entityName(item) : item))
      : value;
  }
  if (key === 'currentEntityId' || key === 'intendedEntityId') {
    return typeof value === 'string' ? resolver.entityName(value) : value;
  }
  return value;
}

/** 归一化后的事件。 */
interface NormalizedEvent {
  type: string;
  memory: number | null;
  payload: Record<string, unknown>;
}

function normalizeEvents(
  events: ReadonlyArray<{
    type: string;
    memory_id: string | null;
    payload: Record<string, unknown>;
  }>,
  resolver: IdResolver,
): NormalizedEvent[] {
  return events.map((event) => ({
    type: event.type,
    memory: event.memory_id === null ? null : resolver.recordKey(event.memory_id),
    payload: normalizePayload(event.payload, resolver),
  }));
}

/** 归一化后的 `write` 输出。 */
interface NormalizedWrite {
  op: 'write';
  merged: boolean;
  exact: boolean;
  content: string;
  warnings: Array<{
    code: string;
    alias: string;
    currentEntity: string;
    intendedEntity: string;
  }>;
  events: NormalizedEvent[];
}

/** 归一化后的 `recall` 输出。 */
interface NormalizedRecall {
  op: 'recall';
  hits: Array<{
    key: number | null;
    score: number;
    breakdown: {
      intensityPart: number;
      vectorPart: number;
      textPart: number;
      graphPart: number;
      recencyPart: number;
      rawBm25: number | null;
      cos: number | null;
    };
    fromText: boolean;
    fromVector: boolean;
    fromGraph: boolean;
  }>;
}

/** 归一化后的 `touch` 输出。 */
interface NormalizedTouch {
  op: 'touch';
  outcomes: Array<{
    key: number | null;
    intervalDays: number;
    boosted: boolean;
    stabilityDelta: number;
    edgesReinforced: number;
  }>;
  events: NormalizedEvent[];
}

/** 归一化后的 `get` 输出。 */
interface NormalizedGet {
  op: 'get';
  view: Record<string, unknown> | null;
}

type NormalizedStep = NormalizedWrite | NormalizedRecall | NormalizedTouch | NormalizedGet;

// ═══════════════════════════════════════════════════════════════════════════
// 四、参考实现的回放
// ═══════════════════════════════════════════════════════════════════════════

/** 回放的结果。 */
interface RefRun {
  steps: NormalizedStep[];
  /** 创建出来的记忆（参考实现的 `refId`，按创建顺序）。 */
  createdIds: string[];
}

/** 用给定模型把语料回放一遍（产出归一化后的输出）。 */
function replayReference(model: RefV1Model, real: RealRun): RefRun {
  const steps: NormalizedStep[] = [];
  const createdIds: string[] = [];
  const recordKey = new Map<string, number>();
  /** 第 k 次写入返回的 `refId`（**按写入步序**，与真实侧同口径）。 */
  const refIdOfWriteStep: string[] = [];
  /**
   * 真实 id ⇒ 参考实现的 `refId`（**按创建顺序**对齐）。
   *
   * ⚠️ **必须翻译**：引擎事实（FTS 命中的行、去重候选）给的是**真实 uuid**，
   *   而参考实现的模型以 `refId` 为键 ⇒ 不翻译的话参考实现会「找不到这条记忆」。
   */
  const refIdOfRealId = new Map<string, string>();

  /**
   * 把引擎事实里的**真实 id** 翻译成参考实现的 `refId`。
   *
   * ⚠️ 引擎事实（去重候选、FTS 命中行、证据边条数）给的都是**真实 uuid**，
   *   而参考实现的模型以 `refId` 为键 ⇒ 不翻译 ⇒ 参考实现会「找不到这条记忆」
   *   ⇒ 表现为「参考实现从不合并 / 证据边恒为 0」这类**假绿**。
   */
  const translateEdges = (edges: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [id, count] of Object.entries(edges)) {
      const refId = refIdOfRealId.get(id);
      if (refId !== undefined) {
        out[refId] = count;
      }
    }
    return out;
  };

  // ── 两侧 id 的对应表：按**创建顺序**对齐（§4.6 步骤 4 的同分 tie-break 要用真实 id）──
  const realIdOfRefId = (refId: string): string => {
    const index = createdIds.indexOf(refId);
    const realId = index < 0 ? undefined : real.createdIds[index];
    return realId ?? refId;
  };
  const refResolver = (): IdResolver => ({
    recordKey: (id) => recordKey.get(id) ?? null,
    entityName: (id) => refEntityName(model, id),
  });

  for (const [stepIndex, step] of CORPUS.entries()) {
    const evidence = real.evidence[stepIndex];
    switch (step.op) {
      case 'write': {
        if (evidence === undefined || evidence.kind !== 'write') {
          throw new Error(`第 ${stepIndex} 步缺写证据`);
        }
        const input: RefV1WriteInput = {
          content: step.content,
          ...(step.kind === undefined ? {} : { kind: step.kind }),
          ...(step.entities === undefined ? {} : { entities: step.entities }),
          ...(step.entityAliases === undefined ? {} : { entityAliases: step.entityAliases }),
          ...(step.confidence === undefined ? {} : { confidence: step.confidence }),
          ...(step.emotion === undefined ? {} : { emotion: step.emotion }),
          ...(step.source === undefined ? {} : { source: step.source }),
          embedding: null,
        };
        const outcome = refWrite(model, input, step.now, {
          dedupCandidates: evidence.dedupCandidates.map((candidate) => ({
            refId: refIdOfRealId.get(candidate.refId) ?? candidate.refId,
            entityNames: candidate.entityNames,
            embedding: candidate.embedding,
          })),
          edgesByRefId: translateEdges(evidence.edgesByRefId),
        });
        refIdOfWriteStep.push(outcome.refId);
        if (!outcome.merged) {
          const realId = real.createdIds[createdIds.length];
          if (realId !== undefined) {
            refIdOfRealId.set(realId, outcome.refId);
          }
          createdIds.push(outcome.refId);
          recordKey.set(outcome.refId, stepIndex);
        }
        steps.push({
          op: 'write',
          merged: outcome.merged,
          exact: outcome.exact,
          content: outcome.content,
          warnings: outcome.warnings.map((warning) => ({
            code: warning.code,
            alias: warning.alias,
            currentEntity: refEntityName(model, warning.currentEntityId),
            intendedEntity: refEntityName(model, warning.intendedEntityId),
          })),
          events: normalizeEvents(
            outcome.events.map((event) => ({
              type: event.type,
              memory_id: event.memoryRefId,
              payload: event.payload,
            })),
            refResolver(),
          ),
        });
        break;
      }
      case 'recall': {
        if (evidence === undefined || evidence.kind !== 'recall') {
          throw new Error(`第 ${stepIndex} 步缺召回证据`);
        }
        const outcome = refRecall(
          model,
          {
            context: step.context,
            ...(step.topN === undefined ? {} : { topN: step.topN }),
            now: step.now,
          },
          {
            ftsRows: evidence.ftsRows.map((row) => ({
              refId: refIdOfRealId.get(row.refId) ?? row.refId,
              rawBm25: row.rawBm25,
            })),
            likeRows: evidence.likeRows.map((row) => refIdOfRealId.get(row) ?? row),
            realIdOf: realIdOfRefId,
          },
        );
        steps.push({
          op: 'recall',
          hits: outcome.hits.map((hit) => ({
            key: recordKey.get(hit.refId) ?? null,
            score: hit.score,
            breakdown: {
              intensityPart: hit.breakdown.intensityPart,
              vectorPart: hit.breakdown.vectorPart,
              textPart: hit.breakdown.textPart,
              graphPart: hit.breakdown.graphPart,
              recencyPart: hit.breakdown.recencyPart,
              rawBm25: hit.breakdown.rawBm25,
              cos: hit.breakdown.cos,
            },
            fromText: hit.fromText,
            fromVector: hit.fromVector,
            fromGraph: hit.fromGraph,
          })),
        });
        break;
      }
      case 'touch': {
        if (evidence === undefined || evidence.kind !== 'touch') {
          throw new Error(`第 ${stepIndex} 步缺 touch 证据`);
        }
        const ids = step.targets.map((target) => {
          const refId = refIdOfWriteStep[target];
          if (refId === undefined) {
            throw new Error(`语料引用了尚未写入的记忆：第 ${target} 次写`);
          }
          return refId;
        });
        const result = refTouch(model, ids, step.now, translateEdges(evidence.edgesByRefId));
        steps.push({
          op: 'touch',
          outcomes: result.outcomes.map((outcome) => ({
            key: recordKey.get(outcome.refId) ?? null,
            intervalDays: outcome.intervalDays,
            boosted: outcome.boosted,
            stabilityDelta: outcome.stabilityDelta,
            edgesReinforced: outcome.edgesReinforced,
          })),
          events: normalizeEvents(
            result.events.map((event) => ({
              type: event.type,
              memory_id: event.memoryRefId,
              payload: event.payload,
            })),
            refResolver(),
          ),
        });
        break;
      }
      case 'get': {
        const refId = step.target < 0 ? undefined : refIdOfWriteStep[step.target];
        const view = refId === undefined ? null : refGet(model, refId, step.now);
        steps.push({
          op: 'get',
          view:
            view === null
              ? null
              : { ...view, id: refId === undefined ? null : (recordKey.get(refId) ?? null) },
        });
        break;
      }
      default: {
        throw new Error(`未知步骤：${JSON.stringify(step)}`);
      }
    }
  }

  return { steps, createdIds };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、真实侧的归一化
// ═══════════════════════════════════════════════════════════════════════════

/** 把真实实现的输出归一化（与参考实现**同一个形状**）。 */
function normalizeReal(real: RealRun): NormalizedStep[] {
  const resolver: IdResolver = {
    recordKey: (id) => real.recordKey.get(id) ?? null,
    entityName: (id) => real.entityNames.get(id) ?? id,
  };
  const steps: NormalizedStep[] = [];
  real.outputs.forEach((output, stepIndex) => {
    switch (output.op) {
      case 'write': {
        steps.push({
          op: 'write',
          merged: output.result.merged,
          exact: output.result.exact,
          content: output.result.content,
          warnings: output.result.warnings.map((warning) => ({
            code: warning.code,
            alias: warning.alias,
            currentEntity: resolver.entityName(warning.currentEntityId),
            intendedEntity: resolver.entityName(warning.intendedEntityId),
          })),
          events: normalizeEvents(real.eventsPerStep[stepIndex] ?? [], resolver),
        });
        break;
      }
      case 'recall': {
        steps.push({
          op: 'recall',
          hits: output.result.hits.map((hit) => ({
            key: resolver.recordKey(hit.id),
            score: hit.score,
            breakdown: {
              intensityPart: hit.breakdown?.intensityPart ?? 0,
              vectorPart: hit.breakdown?.vectorPart ?? 0,
              textPart: hit.breakdown?.textPart ?? 0,
              graphPart: hit.breakdown?.graphPart ?? 0,
              recencyPart: hit.breakdown?.recencyPart ?? 0,
              rawBm25: hit.breakdown?.rawBm25 ?? null,
              cos: hit.breakdown?.cos ?? null,
            },
            fromText: hit.fromText,
            fromVector: hit.fromVector,
            fromGraph: hit.fromGraph,
          })),
        });
        break;
      }
      case 'touch': {
        steps.push({
          op: 'touch',
          outcomes: output.outcomes.map((outcome) => ({
            key: resolver.recordKey(outcome.id),
            intervalDays: outcome.intervalDays,
            boosted: outcome.boosted,
            stabilityDelta: outcome.stabilityDelta,
            edgesReinforced: outcome.edgesReinforced,
          })),
          events: normalizeEvents(real.eventsPerStep[stepIndex] ?? [], resolver),
        });
        break;
      }
      case 'get': {
        steps.push({
          op: 'get',
          view:
            output.view === null
              ? null
              : { ...output.view, id: resolver.recordKey(output.view.id) },
        });
        break;
      }
      default: {
        throw new Error(`未知步骤：${JSON.stringify(output)}`);
      }
    }
  });
  return steps;
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、差分工具（负控要指出「红在哪一行」）
// ═══════════════════════════════════════════════════════════════════════════

/** 把一个值格式化成人能读的文本（差分信息用）。 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

/** 深度差分（返回**逐条**差异描述；空数组 = 完全相同）。 */
function deepDiff(expected: unknown, actual: unknown, path = ''): string[] {
  if (Object.is(expected, actual)) {
    return [];
  }
  if (
    typeof expected !== typeof actual ||
    expected === null ||
    actual === null ||
    typeof expected !== 'object'
  ) {
    return [`${path}: 参考 ${formatValue(expected)} ≠ 实现 ${formatValue(actual)}`];
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return [`${path}: 数组 / 非数组不一致`];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return [`${path}: 长度 ${expected.length} ≠ ${actual.length}`];
    }
    const out: string[] = [];
    expected.forEach((item, index) => {
      out.push(...deepDiff(item, actual[index], `${path}[${index}]`));
    });
    return out;
  }
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const out: string[] = [];
  for (const key of keys) {
    out.push(...deepDiff(left[key], right[key], `${path}.${key}`));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 七、用例
// ═══════════════════════════════════════════════════════════════════════════

/** 语料只跑一次（**确定性**：全部时刻与内容都是写死的）。 */
const REAL = runRealCorpus();

/** 真实侧的归一化输出。 */
const REAL_STEPS = normalizeReal(REAL);

/** 参考实现（默认公式）的归一化输出。 */
const REF_STEPS = replayReference(createRefV1Model(), REAL).steps;

/** 按操作类型挑出归一化步骤。 */
function pick<T extends NormalizedStep['op']>(
  steps: NormalizedStep[],
  op: T,
): Extract<NormalizedStep, { op: T }>[] {
  return steps.filter((step): step is Extract<NormalizedStep, { op: T }> => step.op === op);
}

describe('P1-T09 · v1.0 基线等价（write / recall / touch / get）', () => {
  it('★ 基线条件成立：四个布尔开关全关 + VECTOR_ROUTER=flat（ADR-21）', () => {
    expect(BASELINE_PARAMS.coactivation).toBe(false);
    expect(BASELINE_PARAMS.inhibition).toBe(false);
    expect(BASELINE_PARAMS.writeBack).toBe(false);
    expect(BASELINE_PARAMS.ARCHIVAL_CACHE).toBe(false);
    expect(BASELINE_PARAMS.VECTOR_ROUTER).toBe('flat');
    // ⚠️ 交叉校验：手写的基线参数必须被库自己的判定函数认成基线。
    expect(isBaselineConfig(BASELINE_PARAMS)).toBe(true);
  });

  it('★ 参考实现的参数与 §5 的 v1.0 继承值逐项相等（调参必须显式撞红基线）', () => {
    const keys = Object.keys(REF_V1_PARAMS) as Array<keyof typeof REF_V1_PARAMS>;
    const actual = keys.map((key) => BASELINE_PARAMS[key]);
    const expected = keys.map((key) => REF_V1_PARAMS[key]);
    expect(actual).toEqual(expected);
  });

  it('★ 参考实现不得 import 库的实现（否则基线是自证的）', () => {
    const source = readFileSync(new URL('./ref-v1.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...[...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? ''),
      ...[...source.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g)].map((match) => match[1] ?? ''),
    ];
    // ⚠️ **直接依赖**：参考实现所在的文件不许 import `src/**`。
    expect(specifiers.filter((specifier) => specifier.includes('src/'))).toEqual([]);
    // ⚠️ **间接依赖**：它 import 的本地模块也不许（递归一层即可 —— 本地模块只有 golden 两个）。
    const localSpecifiers = specifiers.filter(
      (specifier) => specifier.startsWith('.') && !specifier.includes('node:'),
    );
    for (const specifier of localSpecifiers) {
      // ⚠️ TS 的 ESM 风格 import 写的是 `.js`，实际文件是 `.ts` ⇒ 解析时要换回来。
      const resolved = new URL(
        specifier.replace(/\.js$/, '.ts'),
        new URL('./ref-v1.ts', import.meta.url),
      );
      const localSource = readFileSync(resolved, 'utf8');
      const localSpecifiers = [
        ...[...localSource.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? ''),
      ];
      expect(localSpecifiers.filter((item) => item.includes('src/'))).toEqual([]);
    }
  });

  it('★ 语料本身有判别力：四条写入路径 + 冲突 + 同日守卫都出现了', () => {
    const writes = pick(REAL_STEPS, 'write');
    expect(writes.filter((step) => !step.merged && !step.exact).length).toBeGreaterThan(0);
    expect(writes.filter((step) => step.merged && step.exact).length).toBeGreaterThan(0);
    expect(writes.filter((step) => step.merged && !step.exact).length).toBeGreaterThan(0);
    expect(writes.filter((step) => step.warnings.length > 0).length).toBeGreaterThan(0);
    const touches = pick(REAL_STEPS, 'touch');
    expect(touches.some((step) => step.outcomes.some((outcome) => outcome.boosted))).toBe(true);
    expect(touches.some((step) => step.outcomes.some((outcome) => !outcome.boosted))).toBe(true);
    expect(
      touches.some((step) => step.outcomes.some((outcome) => outcome.edgesReinforced > 0)),
    ).toBe(true);
    // ⚠️ **反真空守卫**：召回**必须真的召回了东西**。
    //   否则「召回逐位一致」这条断言会在**空集**上成立 ⇒ 绿得毫无意义
    //   （本轮实测踩过：把召回放在写完 20 天后 ⇒ 全部被强度精筛掉 ⇒ 空集）。
    const recalls = pick(REAL_STEPS, 'recall');
    expect(recalls.length).toBeGreaterThan(0);
    expect(recalls.every((step) => step.hits.length > 0)).toBe(true);
    // ⚠️ 召回命中的**分数**必须互不相同（否则排序判据退化成「按 id 排」）。
    const allScores = recalls.flatMap((step) => step.hits.map((hit) => hit.score));
    expect(new Set(allScores).size).toBe(allScores.length);
  });

  it('★ write：merged / exact / content / warnings / entityIds 顺序逐位一致', () => {
    expect(pick(REF_STEPS, 'write')).toEqual(pick(REAL_STEPS, 'write'));
  });

  it('★ recall：命中顺序 / score / breakdown / fromText / fromVector / fromGraph 逐位一致', () => {
    expect(pick(REF_STEPS, 'recall')).toEqual(pick(REAL_STEPS, 'recall'));
  });

  it('★ touch：受影响 id / stability 变化量 / edgesReinforced / 事件条数与类型序列逐位一致', () => {
    expect(pick(REF_STEPS, 'touch')).toEqual(pick(REAL_STEPS, 'touch'));
  });

  it('★ get：全部字段逐位一致（含 intensity / layer / effectiveStability）', () => {
    expect(pick(REF_STEPS, 'get')).toEqual(pick(REAL_STEPS, 'get'));
  });

  it('★ 负控：参考实现的 initialDifficulty 公式被改错 ⇒ 基线比对必须变红（差分指向难度）', () => {
    const mutant = createRefV1Model(REF_V1_PARAMS, {
      ...REF_FORMULAS,
      // ⚠️ **故意写错**：`0.2 × (1 - confidence)` 写成 `0.2 × confidence`。
      initialDifficulty: (baseDifficulty, confidence) =>
        Math.min(0.95, baseDifficulty + 0.2 * confidence),
    });
    const mutantSteps = replayReference(mutant, REAL).steps;
    const diffs = deepDiff(REAL_STEPS, mutantSteps);
    expect(diffs.length).toBeGreaterThan(0);
    // ⚠️ 差分必须**指向难度**（或由难度派生出来的稳定度 / 分数）——
    //   否则这条负控只证明「有什么东西变了」，不证明「那条公式被守着」。
    expect(diffs.some((diff) => /difficulty|stability|score/.test(diff))).toBe(true);
  });

  it('★ 负控：参考实现的五项权重被改错 ⇒ 分数必须变红', () => {
    const mutant = createRefV1Model(REF_V1_PARAMS, {
      ...REF_FORMULAS,
      fuse: (factors) => {
        // ⚠️ **故意写错**：把 `vectorSim` 的权重从 0.25 挪到 `intensity` 上。
        const base = REF_FORMULAS.fuse(factors);
        const intensity = factors.intensity ?? 0;
        const vectorSim = factors.vectorSim ?? 0;
        const intensityPart = 0.55 * intensity;
        const vectorPart = 0 * vectorSim;
        const breakdown = {
          intensityPart,
          vectorPart,
          textPart: base.breakdown.textPart,
          graphPart: base.breakdown.graphPart,
          recencyPart: base.breakdown.recencyPart,
        };
        return {
          breakdown,
          score:
            breakdown.intensityPart +
            breakdown.vectorPart +
            breakdown.textPart +
            breakdown.graphPart +
            breakdown.recencyPart,
        };
      },
    });
    const mutantSteps = replayReference(mutant, REAL).steps;
    const diffs = deepDiff(REAL_STEPS, mutantSteps);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((diff) => /score|Part/.test(diff))).toBe(true);
  });
});
