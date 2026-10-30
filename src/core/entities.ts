/**
 * 实体解析 —— DESIGN-v2.md §4.5 末尾「名称与 ID 的转换规则」的**唯一实现**。
 *
 * ★ **只收拢 ①②、不收拢 ③**（§4.5 原文）：
 *   ① 主名命中 ⇒ 返回 id；② 别名命中 ⇒ 返回 entity_id；③ 均未命中 ⇒ **返回 null**。
 *
 * ⚠️ **「查不到怎么办」在三处调用点语义恰好相反，绝不能统一**（统一才会出错）：
 *   · `link`（§4.5 步骤 2）：按 `options.createMissing` 建实体或抛 `NOT_FOUND`（整条失败、事务回滚）；
 *   · `recall`（§4.6 步骤 1）：该名称**仅参与文本路，不进图谱路**——**查询路径禁止写库**；
 *     若统一 ③，一次**查询**就会创建实体（§7.1 的只读约束只拦事件写入的短路，拦不住主表 INSERT）；
 *   · `write`（§4.9 步骤 1a）：视为新实体，用该名称作主名走 `ON CONFLICT(name)` UPSERT。
 *
 * ⚠️ **不要给它加 `createMissing` 参数**：加了就得在每个调用点判断该不该传 `true`，
 *   而上面三处的答案天生不同 ⇒ 参数本身就成了「把决策推回调用点」的伪装。
 *
 * ⚠️ **实体名按精确匹配查找**，不做 trim / 大小写 / 全角处理
 *   ⇒ **调用方负责提供稳定的实体名形式**（§4.5）。
 *   这里刻意不做归一化：归一化放在解析层会让「同一个名字到底指谁」取决于调用点，
 *   而 `setAlias` 的冲突校验（§4.9.2）也依赖精确匹配。
 */

/** 实体查询用到的预编译语句的最小结构（与 better-sqlite3 的 `Statement` 兼容）。 */
export interface EntityStatement {
  get(...params: unknown[]): unknown;
}

/**
 * 实体查询用到的数据库的最小结构（与 better-sqlite3 的 `Database` 兼容）。
 *
 * ⚠️ **刻意声明成最小结构**而不是直接依赖 `better-sqlite3` 的 `Database` 类型：
 *   `src/core/` 是**纯逻辑层**，不应因一个 `SELECT` 就把原生模块的类型绑进核心；
 *   真实 `Database` 在结构上天然满足它（`tests/unit/decay.test.ts` 有一条断言专门盯这点）。
 */
export interface EntityDatabase {
  prepare(sql: string): EntityStatement;
}

/** ① 主名命中（§4.5）。 */
export const RESOLVE_ENTITY_BY_NAME_SQL = 'SELECT id FROM entities WHERE name = ?';

/** ② 别名命中（§4.5）。 */
export const RESOLVE_ENTITY_BY_ALIAS_SQL = 'SELECT entity_id FROM entity_aliases WHERE alias = ?';

/**
 * 名称 → `entity_id`（§4.5 的**唯一实现**）。
 *
 * ⚠️ **① 优先于 ② 是刻意的**：主名是权威命名，一个名字同时是 A 的主名和 B 的别名时**以主名为准**
 *   （这种冲突由 §4.9.2 的 `setAlias` 校验拦住，正常路径下不会同时存在）。
 *
 * ⚠️ **不写库**：本函数只发两条 `SELECT`，未命中返回 `null`——
 *   不建实体、不抛错、不产生任何写入（验收断言见 `tests/unit/decay.test.ts`：
 *   断言的是「一条写语句都没发出」，比「行数不变」更强——
 *   一条 `INSERT ... ON CONFLICT DO NOTHING` 不改行数，但它仍然是写库）。
 *
 * @param db 数据库句柄
 * @param name 实体名（**精确匹配**，调用方负责归一化）
 * @returns `entity_id`；未命中返回 `null`
 */
export function resolveEntity(db: EntityDatabase, name: string): string | null {
  const byName = db.prepare(RESOLVE_ENTITY_BY_NAME_SQL).get(name) as { id?: unknown } | undefined;
  if (byName != null && typeof byName.id === 'string') {
    return byName.id;
  }

  const byAlias = db.prepare(RESOLVE_ENTITY_BY_ALIAS_SQL).get(name) as
    | { entity_id?: unknown }
    | undefined;
  if (byAlias != null && typeof byAlias.entity_id === 'string') {
    return byAlias.entity_id;
  }

  return null;
}
