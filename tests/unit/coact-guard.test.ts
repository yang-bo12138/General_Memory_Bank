/**
 * §4.6 / §4.11.2：`recall({ reinforce: true })` **只加固、不建共激活边**。
 *
 * ⚠️ **这条断言存在的理由**：DESIGN §4.6 的 `reinforce` 通道明写「**只加固，不写共激活边**」——
 *   否则每次 reinforce 都把本次 top-N 焊成一个团
 *   （它们对同一 query 响应得都好 ⇒ 共享实体 / 余弦达标），
 *   触发 §0.2 明令禁止的「**topN 自我强化**」。
 *   ⇒ 这条约束**此前只有注释、没有断言** ⇒ 谁在 reinforce 里顺手写一条共激活，
 *   **测不出来** ⇒ 本文件把它变成机器可检的。
 *
 * ⚠️ **断言必须非空洞**：只断言「`coacts` 没长」是不够的——
 *   「什么都没发生」当然也不会长 ⇒ 那是一条**恒真**的假绿。
 *   ⇒ 每条用例都同时断言「**加固确实发生了**」（稳定度涨了、访问计数 +1）。
 *
 * ⚠️ **显式共激活入口（`touch(ids, { coActivateWith })`）现已落地**（P3-T01）：
 *   §4.11 的共激活写入路径在 `src/neuron/coacts.ts`（**全库唯一的 `coacts` 写入点**）。
 *   ⇒ 本文件的守卫从「**还没有**共激活写入」升级成「**只有那一个地方**写共激活」——
 *     这正是它原先的注释要求的：§4.11 落地时必须**同时**
 *     ① 把守卫扩展成「显式共激活会写 `coacts`、而 reinforce 不写」这一对断言，
 *     ② 并把 §4.6 的 `reinforce` 通道与 §0.2 的「topN 自我强化禁令」一起复核。
 *   ⇒ 两条都做了（见下面「显式共激活会写 coacts」与「全库只有一处写 coacts」两条用例）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { tokenize } from '../../src/core/tokenize.js';
import { recall } from '../../src/store/recall.js';
import { touch } from '../../src/store/touch.js';
import { countRows, createTestStore, readMemory } from '../fixtures/graph-store.js';

/** 固定的「现在」（epoch 毫秒）——全部时间从它推导。 */
const NOW = 1_700_000_000_000;

/** 造一条记忆（`content_tokens` 由 `tokenize()` 算，FTS 索引由触发器同步）。 */
function seedMemory(db: Database.Database, id: string, content: string): void {
  db.prepare(
    `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                           stability, difficulty, pin_factor, created_at, last_access, access_count,
                           deleted, deleted_at)
     VALUES (@id, 'fact', @content, @tokens, @hash, @stability, @difficulty, @pinFactor,
             @createdAt, @lastAccess, @accessCount, 0, NULL)`,
  ).run({
    id,
    content,
    tokens: tokenize(content),
    hash: `hash-${id}`,
    stability: 10,
    difficulty: 0.5,
    pinFactor: 1,
    createdAt: NOW - 10 * MS_PER_DAY,
    // ⚠️ `last_access` 必须**早于**一天前**：同日守卫（§4.2）会让间隔不足一天时**不涨稳定度**
    //   ⇒ 那时「稳定度没变」就分不清是「守卫拦住了」还是「reinforce 没跑」。
    lastAccess: NOW - 2 * MS_PER_DAY,
    accessCount: 1,
  });
}

/** 判断一段源码里有没有「写共激活表」的语句。 */
function hasCoactWrite(source: string): boolean {
  return /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+coacts/i.test(source);
}

/** 列出 `src/` 下的全部源文件（**排除**测试文件）。 */
function listSourceFiles(dir: string = join(process.cwd(), 'src')): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('§4.11.2 · reinforce 只加固、不建共激活边', () => {
  it('★ recall({reinforce:true}) 之后 coacts 表的行数不增加（而加固确实发生了）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, 'm-1', '张三喜欢猫粮');
    seedMemory(db, 'm-2', '张三在买猫粮');

    const before = countRows(db, 'coacts');
    const result = recall(store, { context: '猫粮', reinforce: true, now: NOW });

    // 性质：召回到了东西（否则「coacts 没变」是**空洞**的：什么都没发生当然没变）
    expect(result.hits.length).toBeGreaterThan(0);

    // ★ **核心断言**：共激活边**一条都没多**
    expect(countRows(db, 'coacts')).toBe(before);

    // 性质（非空洞性）：**加固确实发生了** —— 稳定度涨了、访问计数 +1
    const hitId = result.hits[0]?.id ?? '';
    const memory = readMemory(db, hitId);
    expect(memory.stability).toBeGreaterThan(10);
    expect(memory.access_count).toBe(2);
  });

  it('★ 对照组：不带 reinforce 的 recall 连加固都不做（证明上面那条测的是 reinforce 本身）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, 'm-1', '张三喜欢猫粮');
    seedMemory(db, 'm-2', '张三在买猫粮');

    const result = recall(store, { context: '猫粮', now: NOW });

    expect(result.hits.length).toBeGreaterThan(0);
    // 性质：不 reinforce ⇒ 稳定度**不变**（访问计数也不变）
    const hitId = result.hits[0]?.id ?? '';
    const memory = readMemory(db, hitId);
    expect(memory.stability).toBe(10);
    expect(memory.access_count).toBe(1);
    // 性质：共激活当然也没长
    expect(countRows(db, 'coacts')).toBe(0);
  });

  it('★ 正控：共激活表的探针是灵的（真写一条 coacts ⇒ 计数会涨）', () => {
    const { db } = createTestStore();
    seedMemory(db, 'm-1', '张三喜欢猫粮');
    seedMemory(db, 'm-2', '张三在买猫粮');

    const before = countRows(db, 'coacts');
    // ⚠️ 这一条正是「违规模板」：如果 reinforce 顺手写了这么一行，
    //   上面那条断言就会红 ⇒ 证明探针不是坏了所以没报。
    db.prepare(
      `INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active)
       VALUES (@a, @b, 0.5, 1, 1, @now)`,
    ).run({ a: 'm-1', b: 'm-2', now: NOW });

    expect(countRows(db, 'coacts')).toBe(before + 1);
  });

  it('★ 静态：加固路径（src/store/touch.ts）里没有任何共激活写入', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'store', 'touch.ts'), 'utf8');
    expect(hasCoactWrite(source)).toBe(false);

    // ⚠️ **负控**：往同一段源码里塞进一条共激活写入 ⇒ 扫描必须报出来（闸门不是摆设）
    const mutated = `${source}\nexport function badWriter(db: Database.Database): void {\n  db.prepare('INSERT INTO coacts (memory_a, memory_b, affinity, coact_count, cause_flags, last_active) VALUES (?, ?, 0.5, 1, 1, 0)').run('a', 'b');\n}\n`;
    expect(hasCoactWrite(mutated)).toBe(true);
  });

  it('★ 全库现状：**只有** src/neuron/coacts.ts 这一个地方写 coacts（§4.11.2 的唯一写入源）', () => {
    const offenders = listSourceFiles().filter((file) => hasCoactWrite(readFileSync(file, 'utf8')));
    // ⚠️ **不是「一个都没有」**（§4.11 已落地），而是「**有且只有那一处**」——
    //   多一处就意味着共激活边可以被绕过「唯一写入入口」那条纪律（§14.3 边界原则 1）。
    expect(offenders.map((file) => file.replace(/\\/g, '/'))).toEqual([
      `${join(process.cwd(), 'src', 'neuron', 'coacts.ts').replace(/\\/g, '/')}`,
    ]);
  });

  it('★ 对照组：显式共激活**会**写 coacts（与上面「reinforce 不写」构成一对）', () => {
    const { db, store } = createTestStore();
    seedMemory(db, 'm-1', '张三喜欢猫粮');
    seedMemory(db, 'm-2', '张三在买猫粮');

    const before = countRows(db, 'coacts');
    touch(store, ['m-1', 'm-2'], NOW, {
      coActivateWith: [{ memoryId: 'm-2', seedIds: ['m-1'] }],
    });

    // ★ 这一对断言的另一半：**显式声明确实写了 coacts** ⇒ 上面那条不是「探针坏了所以没报」
    expect(countRows(db, 'coacts')).toBe(before + 1);
  });
});
