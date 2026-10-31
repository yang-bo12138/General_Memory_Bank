/**
 * 记忆加固：`growStability` / `touch` —— DESIGN-v2.md §4.2 / §4.5 规则 R-EDGE-TOUCH，
 * 对应 DEVELOPMENT-PLAN.md **P1-T06**。
 *
 * ★ **全库唯一的 `stability` 写入点**（§4.2 原话）：
 *   本库有两条路径会增长稳定度——`touch` 与去重合并。它们最初各写各的公式，
 *   接连出过三次同类事故：
 *     ① 合并路径漏套 `MAX_STABILITY` ⇒ 成了绕过上限的后门；
 *     ② 合并路径绕过同日守卫 ⇒ webhook 重投 10 次能涨 13.8 倍；
 *     ③ 两条路径的间隔语义不一致 ⇒ 同一行为有两种结果。
 *   ⇒ 收拢后这**三个约束结构上不可能漏**：调用方只能传倍率，改不了守卫。
 *
 * ⚠️ **写回在函数内完成**（§4.2）：
 *   「数据库写回也在函数内完成 ⇒ 调用方不会漏 UPDATE」——
 *   漏写**不报错**，只会让加固**静默失效**（那是最难查的一类 bug）。
 *   ⇒ 纯计算部分在 `src/core/stability.ts`（那里能被纯单测守住三个约束），
 *     本文件负责「算完立刻落库」这唯一的一步。
 *
 * ⚠️ **`stabilityDelta` 必须返回**（v2.1 裁决）：调用点算不出 `before`
 *   （它是函数内的局部变量）⇒ 若函数不返回，**事件流就会缺这个键**
 *   ⇒ §8.4 硬规则 5 的对账恒等式（Σ 库内变化 == Σ 事件里的 delta）恒不成立。
 *   ⚠️ **调用方不得用 `boosted` 反推 delta**（一个是布尔、一个是数值）。
 *   未增长时为 0，**键恒在**。
 *
 * ⚠️ **C37**：所有函数签名含 `now?`；真实时钟只经 `resolveNow()`（唯一入口 `src/core/clock.ts`）。
 */

import type Database from 'better-sqlite3';

import { resolveNow } from '../core/clock.js';
import { MemoryError } from '../core/errors.js';
import type { TouchEventPayload } from '../core/events.types.js';
import { missingIds } from '../core/graph.js';
import type { Params } from '../core/params.js';
import { type StabilityInput, computeStabilityGrowth, difficultyBonus } from '../core/stability.js';
import type { EventWriter } from './events.js';
import { runWriteTransaction } from './transaction.js';

/**
 * `touch` 事件的 `reason` 取值（§4.2 / §8.4 的 touch 行）。
 *
 * ⚠️ **三条路径的取值不同，绝不能统一**：
 * · `'explicit'` —— `touch()`（调用方明确确认采纳）；
 * · `'exact_repeat'` —— §4.9 步骤 2 的**完全重复**路径（写入时发现内容一模一样）；
 * · `'reinforce'` —— `recall({ reinforce: true })`（调用方只开了 reinforce 开关）。
 *
 * ⚠️ **理由不同、来源标记必须能区分**：否则事后复盘分不清
 *   「调用方真的采纳了这批记忆」与「调用方只是开了 reinforce 开关」。
 */
export type TouchReason = 'explicit' | 'exact_repeat' | 'reinforce';

/** 加固所需的上下文（库句柄 + 生效参数 + 事件写入器）。 */
export interface TouchStore {
  db: Database.Database;
  params: Params;
  events: EventWriter;
}

/** 加固所需的记忆字段（`memories` 行的子集 + 自身的 id）。 */
export interface TouchMemoryInput extends StabilityInput {
  /** 记忆 id（写回时定位用）。 */
  id: string;
}

/** 一次加固的结果（§4.2 要求返回的三个值）。 */
export interface GrowStabilityOutcome {
  /** 距上次访问的天数（记进 `touch` 事件的 `intervalDays`）。 */
  intervalDays: number;
  /** 是否真的涨了（记进事件的 `boostApplied`）。 */
  boosted: boolean;
  /** 稳定度的实际增量（天）；未增长时为 0，**键恒在**。 */
  stabilityDelta: number;
}

/** `touch` 的可选开关。 */
export interface TouchOptions {
  /**
   * 事件的 `reason` 取值（§8.4 的 touch 行）。
   *
   * ⚠️ **默认 `'explicit'`**（这就是 `touch()` 本身）；
   *   §4.9 步骤 2 的完全重复路径传 `'exact_repeat'`；
   *   `recall({ reinforce: true })` 传 `'reinforce'`。
   */
  reason?: TouchReason;
}

/** 一次 `touch` 的逐条结果。 */
export interface TouchOutcome extends GrowStabilityOutcome {
  id: string;
  /** 该记忆作为证据被强化的边数（无证据边时为 0）。 */
  edgesReinforced: number;
}

/**
 * `growStability(store, m, baseGrowth, useSpacing, now?)` —— §4.2 的**唯一**稳定度写入点。
 *
 * ⚠️ **三个约束全部封在这里**（§4.2），调用方无从绕过：
 *   ① **同日守卫**：`intervalDays < 1.0` 不增长；
 *   ② **`MAX_STABILITY` 上限钳制**；
 *   ③ **`last_access` / `access_count` 一并更新**，不留给调用方。
 *
 * ⚠️ **数据库写回也在本函数内完成** ⇒ 调用方不会漏 UPDATE
 *   （漏写不报错，只会让加固静默失效——最难查的一类 bug）。
 *
 * ⚠️ **本函数是全库唯一会写 `stability` 的地方**：
 *   由静态扫描断言守着（`tests/unit/touch.test.ts` 扫 `src/` 全树，
 *   断言那一条写 `stability` 的语句只出现在本函数内）。
 *   ⇒ **不要把这条 SQL 提到模块顶层常量**：那条闸门按「源码里第一次出现的位置」定位，
 *     提到函数外会让它落到函数声明之前 ⇒ 闸门误判为「不在 growStability 内」而变红。
 *
 * @param store 库句柄 + 生效参数（三个约束的界都在参数表里 ⇒ **必传**）
 * @param m 该记忆的当前状态（`stability` / `last_access` / `access_count` / `difficulty` / `id`）
 * @param baseGrowth 基础倍率：touch 传「难度加成」；去重合并传 `DEDUP_BOOST`
 * @param useSpacing 是否叠加间隔加成：touch = `true`；合并 = **`false`**
 * @param now 注入时钟（C37）
 */
export function growStability(
  store: TouchStore,
  m: TouchMemoryInput,
  baseGrowth: number,
  useSpacing: boolean,
  now?: number,
): GrowStabilityOutcome {
  const at = resolveNow(now);
  const growth = computeStabilityGrowth(m, baseGrowth, useSpacing, store.params, at);

  // ⚠️ ★ **全库唯一写 `stability` 的语句**（SQL 刻意写在这里、不提为模块常量，理由见上）。
  store.db
    .prepare(
      `UPDATE memories SET stability = @stability, last_access = @lastAccess, access_count = @accessCount
       WHERE id = @id`,
    )
    .run({
      stability: growth.stability,
      lastAccess: growth.last_access,
      accessCount: growth.access_count,
      id: m.id,
    });

  return {
    intervalDays: growth.intervalDays,
    boosted: growth.boosted,
    stabilityDelta: growth.stabilityDelta,
  };
}

/**
 * `touch(ids, now?, options?)` —— §4.2 的批量加固。
 *
 * ★ **事务形状（顺序不可换）**：
 *   0. **校验**：`SELECT id FROM memories WHERE id IN (...) AND deleted = 0`；
 *      取回的集合与传入 ids 不等 ⇒ 抛 `NOT_FOUND`（`details.missingIds = 差集`）
 *      ⇒ **一条都不加固、也不进入后续步骤**（整体回滚）。
 *      ⚠️ **软删的 id 也算缺失**（`deleted = 0` 过滤）：不给「绕过遗忘悄悄复活」的入口。
 *   1. **逐条 `growStability`**：难度加成**必须在循环内按各自的 `m.difficulty` 算**
 *      （在循环外算一次再复用 = 给整批套同一个倍率 = **静默算错，结果仍像正常值**）。
 *   2. **R-EDGE-TOUCH**：先统计各记忆被强化的边数，再一条 UPDATE 覆盖全部 ids。
 *   3. **记事件**（逐条；`edgesReinforced` 读第 2 步的**真实**结果，不能预估）。
 *
 * ⚠️ **`recall({ reinforce: true })` 只加固、不建共激活边**（§4.11.2 裁决）：
 *   否则每次 reinforce 都把本次 top-N 焊成一个团（它们对同一 query 响应得都好 ⇒
 *   共享实体/余弦达标），触发 §0.2 明令禁止的「topN 自我强化」。
 *   ⇒ **这是预期行为，不是副作用**。
 *
 * @throws {MemoryError} `NOT_FOUND`（`details.missingIds = 差集`；一条都不加固）
 */
export function touch(
  store: TouchStore,
  ids: readonly string[],
  now?: number,
  options?: TouchOptions,
): TouchOutcome[] {
  const at = resolveNow(now);
  const reason: TouchReason = options?.reason ?? 'explicit';
  const db = store.db;

  return runWriteTransaction(db, () => {
    // ── 步骤 0：校验（先校验全集，一条都不加固）──
    // ⚠️ **必须显式校验而不是「取到几条算几条」**：下面是「按 id 取出该条 Memory」，
    //   取不到时下一行 `m.difficulty` 抛的是 **TypeError**——
    //   一个未类型化的崩溃，而不是「这条记忆不在了」这个调用方能处理的语义。
    //   也不能静默跳过：调用方以为自己确认了 20 条，实际只加固了 18 条，且没有任何回执。
    const requested = [...new Set(ids)];
    if (requested.length === 0) {
      return [];
    }

    // ⚠️ **参数一律写 `@名字` 的具名占位符**：裸写的名字会被 SQLite 逐字当成**列名**，
    //   执行时报 `no such column`（§4.5 的伪代码约定）。
    const placeholders = requested.map((_, index) => `@id${index}`).join(', ');
    const bindings: Record<string, string> = {};
    requested.forEach((id, index) => {
      bindings[`id${index}`] = id;
    });

    const found = db
      .prepare(`SELECT id FROM memories WHERE id IN (${placeholders}) AND deleted = 0`)
      .all(bindings) as Array<{ id: string }>;
    const missing = missingIds(
      requested,
      found.map((row) => row.id),
    );
    if (missing.length > 0) {
      throw MemoryError.notFound(`touch 的记忆不存在（含软删）：${missing.join(', ')}`, {
        missingIds: missing,
      });
    }

    // ── 步骤 1：逐条加固（难度加成在循环内按各自的 difficulty 算）──
    const selectMemory = db.prepare(
      'SELECT id, stability, last_access, access_count, difficulty FROM memories WHERE id = @id',
    );
    const outcomes: TouchOutcome[] = [];
    for (const id of requested) {
      const m = selectMemory.get({ id }) as TouchMemoryInput | undefined;
      if (m === undefined) {
        // ⚠️ **理论上不可达**（步骤 0 刚校验过全集）：但仍必须给一个**有类型**的错误，
        //   而不是让 `m.difficulty` 抛 TypeError（未类型化的崩溃）。
        throw MemoryError.notFound(`touch 的记忆在事务内消失：${id}`, { missingIds: [id] });
      }
      // ⚠️ **难度加成必须在循环内算**：批量 touch 的每一条难度不同
      //   （首因 0.3 / 常规 0.5 / 置信度惩罚，见 §4.3），
      //   在循环外算一次再复用 = 给整批套同一个倍率 ⇒ **静默算错，结果仍像正常值**。
      const bonus = difficultyBonus(m.difficulty, store.params);
      const growth = growStability(store, m, bonus, true, at);
      outcomes.push({ id, ...growth, edgesReinforced: 0 });
    }

    // ── 步骤 2：R-EDGE-TOUCH（§4.5）──
    // ⚠️ **先统计、再更新**（顺序写死）：`edgesReinforced` 要读第 2 步的**真实**结果，
    //   不能预估；反过来先更新就统计不到「实际强化了几条」。
    const edgeCounts = new Map<string, number>();
    const counted = db
      .prepare(
        `SELECT memory_id, COUNT(*) AS n FROM edges WHERE memory_id IN (${placeholders}) GROUP BY memory_id`,
      )
      .all(bindings) as Array<{ memory_id: string; n: number }>;
    for (const row of counted) {
      edgeCounts.set(row.memory_id, row.n);
    }

    // ⚠️ **一条语句覆盖全部 ids**；**不要给 WHERE 补 `weight < MAX` 过滤**——
    //   那会让「payload 里记的强化条数」与「实际被强化的条数」对不上
    //   （封顶的边同样被刷新了 `last_active`，它是「仍然有效」的证据）。
    // ⚠️ **`memory_id IS NULL` 的边永不被强化**（`IN (...)` 天然排除 NULL）：
    //   它们是「断言」而非「记忆」，不该因为某条记忆被采纳而变强。
    db.prepare(
      `UPDATE edges
          SET weight      = min(@maxWeight, weight + @reinforceStep),
              last_active = @now
        WHERE memory_id IN (${placeholders})`,
    ).run({
      ...bindings,
      maxWeight: store.params.MAX_EDGE_WEIGHT,
      reinforceStep: store.params.EDGE_REINFORCE_STEP,
      now: at,
    });

    // ── 步骤 3：记事件（逐条）──
    for (const outcome of outcomes) {
      const edgesReinforced = edgeCounts.get(outcome.id) ?? 0;
      outcome.edgesReinforced = edgesReinforced;
      const payload: TouchEventPayload = {
        id: outcome.id,
        reason,
        intervalDays: outcome.intervalDays,
        // ⚠️ **字段名是 `boostApplied`，取的是 `boosted`**（§8.4 的 touch 行）。
        boostApplied: outcome.boosted,
        // ⚠️ 无证据边时记 **0**，不要省略该键（§8.4：键的有无就是语义）。
        edgesReinforced,
        // ⚠️ **键恒在**（未增长时为 0）——§8.4 硬规则 5 的对账恒等式依赖它。
        stabilityDelta: outcome.stabilityDelta,
      };
      store.events.appendEvent('touch', outcome.id, payload, at);
    }

    return outcomes;
  });
}
