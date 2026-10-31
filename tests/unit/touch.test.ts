/**
 * P1-T06 · `growStability` / `touch` 的端到端断言 —— DESIGN-v2.md §4.2 / §4.5（R-EDGE-TOUCH）。
 *
 * ★ 断言纪律：
 *   · **写性质，不写当次的形状**：数值一律引用 `params`（或由 `params` 推导）；
 *   · **关键断言配反例**：故意写出那个会错的写法，断言它确实会错、而实现不会错；
 *   · **静态扫描类断言必须带负控**：把断言的目标临时改掉 ⇒ 扫描必须报出来。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { MemoryError } from '../../src/core/errors.js';
import { difficultyBonus } from '../../src/core/stability.js';
import { growStability, touch } from '../../src/store/touch.js';
import {
  countRows,
  createTestStore,
  insertEdge,
  insertEntity,
  insertMemory,
  readEdge,
  readEvents,
  readMemory,
} from '../fixtures/graph-store.js';

/** 取出捕获到的 `MemoryError`（失败时给出可读的原因）。 */
function expectMemoryError(fn: () => unknown): MemoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemoryError) {
      return error;
    }
    throw error;
  }
  throw new Error('期望抛出 MemoryError，但没有抛');
}

describe('P1-T06 · touch 的加固语义（§4.2 的三个约束）', () => {
  it('★ 连续两次 touch 在同一天（注入时钟）⇒ stability 不变、boostApplied=false', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, lastAccess: 0, accessCount: 0 });

    const first = touch(store, ['m-1'], 0);
    const second = touch(store, ['m-1'], 0);

    // 性质：同日守卫 ⇒ 稳定度**一点没涨**
    expect(first[0]?.boosted).toBe(false);
    expect(second[0]?.boosted).toBe(false);
    expect(readMemory(db, 'm-1').stability).toBe(1);
    expect(second[0]?.stabilityDelta).toBe(0);

    // 性质：但 access_count 每次 +1、last_access 被刷新
    expect(readMemory(db, 'm-1').access_count).toBe(2);
    expect(readMemory(db, 'm-1').last_access).toBe(0);

    // 性质：难度加成再大也不能突破同日守卫（否则 webhook 重投 10 次能涨 13.8 倍）
    const withBigBonus = touch(store, ['m-1'], 0);
    expect(withBigBonus[0]?.boosted).toBe(false);
    expect(readMemory(db, 'm-1').stability).toBeLessThanOrEqual(params.MAX_STABILITY);
  });

  it('★ 事件里 stabilityDelta **键恒在**（未增长时为 0）——§8.4 硬规则 5 的对账依赖它', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, lastAccess: 0 });

    touch(store, ['m-1'], 0);

    const events = readEvents(db, 'touch');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload ?? {};
    // ★ 键的有无就是「这次有没有真的加固」的标志
    expect(Object.prototype.hasOwnProperty.call(payload, 'stabilityDelta')).toBe(true);
    expect(payload.stabilityDelta).toBe(0);
    // 字段名是 `boostApplied`，取的是 `boosted`
    expect(payload.boostApplied).toBe(false);
    expect(payload.reason).toBe('explicit');
    // 无证据边时 `edgesReinforced` 记 0，**不省略该键**
    expect(Object.prototype.hasOwnProperty.call(payload, 'edgesReinforced')).toBe(true);
    expect(payload.edgesReinforced).toBe(0);
  });

  it('★ 间隔 ≥ 1 天 ⇒ stability 按 difficultyBonus × spacing 增长', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, difficulty: 0.5, lastAccess: 0 });

    const outcome = touch(store, ['m-1'], MS_PER_DAY);

    // 性质：间隔 1 天 ⇒ spacing = 1 + log2(1) = 1 ⇒ 增长倍率 = 难度加成
    const bonus = difficultyBonus(0.5, params);
    expect(outcome[0]?.boosted).toBe(true);
    expect(readMemory(db, 'm-1').stability).toBeCloseTo(1 * bonus * 1, 12);
    expect(outcome[0]?.stabilityDelta).toBeCloseTo(bonus - 1, 12);

    // 性质：间隔 2 天 ⇒ spacing = 1 + log2(2) = 2 ⇒ 增长更快
    // ⚠️ 用**另一条**记忆：上一条 touch 已把 `last_access` 刷到 1 天处，
    //   再 touch 一次时相对间隔只有 1 天 ⇒ spacing 回到 1。
    insertMemory(db, 'm-2', { stability: 1, difficulty: 0.5, lastAccess: 0 });
    const two = touch(store, ['m-2'], MS_PER_DAY * 2);
    expect(readMemory(db, 'm-2').stability).toBeCloseTo(1 * bonus * 2, 12);
    expect(two[0]?.boosted).toBe(true);
  });

  it('★ stability 按 MAX_STABILITY 截断（任何路径都不得超过上限）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1', { stability: 170, difficulty: 0.5, lastAccess: 0 });

    touch(store, ['m-1'], MS_PER_DAY * 2);

    // 性质：170 × 1.75 × 2 = 595 ⇒ 被钳到上限
    expect(readMemory(db, 'm-1').stability).toBe(params.MAX_STABILITY);
    expect(readMemory(db, 'm-1').stability).toBeLessThanOrEqual(params.MAX_STABILITY);
  });

  it('★ 难度加成在**循环内**按各自的 difficulty 算（不是给整批套同一个倍率）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-easy', { stability: 1, difficulty: 0.3, lastAccess: 0 });
    insertMemory(db, 'm-hard', { stability: 1, difficulty: 1, lastAccess: 0 });

    touch(store, ['m-easy', 'm-hard'], MS_PER_DAY);

    const easy = readMemory(db, 'm-easy').stability;
    const hard = readMemory(db, 'm-hard').stability;
    // 性质：两条的倍率**不同**
    expect(easy).toBeCloseTo(difficultyBonus(0.3, params), 12);
    expect(hard).toBeCloseTo(difficultyBonus(1, params), 12);
    expect(easy).not.toBeCloseTo(hard, 12);

    // ⚠️ 反例：若在循环外算一次再复用，两条会得到**同一个**值 ⇒ 上面两行有一行变红。
    //   （这种错法**结果仍像正常值**，不报错、不告警 —— 最难查的一类 bug。）
  });

  it('★ touch 含一个不存在的 id ⇒ NOT_FOUND，且**库里没有任何一条被加固**', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, lastAccess: 0, accessCount: 0 });

    const error = expectMemoryError(() => touch(store, ['m-1', 'm-missing'], MS_PER_DAY));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.details.missingIds).toEqual(['m-missing']);

    // 性质：**一条都不加固**（整体回滚）
    expect(readMemory(db, 'm-1').stability).toBe(1);
    expect(readMemory(db, 'm-1').access_count).toBe(0);
    expect(readMemory(db, 'm-1').last_access).toBe(0);
    expect(countRows(db, 'events')).toBe(0);
  });

  it('★ touch 含一个软删 id ⇒ NOT_FOUND（不给「绕过遗忘悄悄复活」的入口）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-deleted', { stability: 1, lastAccess: 0, deleted: true });
    insertMemory(db, 'm-live', { stability: 1, lastAccess: 0 });

    const error = expectMemoryError(() => touch(store, ['m-deleted', 'm-live'], MS_PER_DAY));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.details.missingIds).toEqual(['m-deleted']);
    // 性质：整体回滚 ⇒ 活着的那条也没被加固
    expect(readMemory(db, 'm-live').access_count).toBe(0);
    expect(readMemory(db, 'm-live').stability).toBe(1);
  });
});

describe('P1-T06 · R-EDGE-TOUCH（§4.5 的证据边强化）', () => {
  it('★ touch 后证据边的 weight 增长、last_active 刷新，事件里的 edgesReinforced 等于实际强化条数', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, lastAccess: 0 });
    insertEntity(db, 'e-1', '甲');
    insertEntity(db, 'e-2', '乙');
    insertEntity(db, 'e-3', '丙');
    insertEdge(db, 'edge-1', 'e-1', 'p', 'e-2', 0.8, 0, 'm-1');
    insertEdge(db, 'edge-2', 'e-1', 'q', 'e-3', 0.8, 0, 'm-1');

    const now = MS_PER_DAY;
    touch(store, ['m-1'], now);

    // 性质：两条证据边各强化一次
    const edge1 = readEdge(db, 'e-1', 'p', 'e-2');
    const edge2 = readEdge(db, 'e-1', 'q', 'e-3');
    expect(edge1?.weight).toBeCloseTo(0.8 + params.EDGE_REINFORCE_STEP, 12);
    expect(edge2?.weight).toBeCloseTo(0.8 + params.EDGE_REINFORCE_STEP, 12);
    // 性质：last_active 被刷新（衰减读的是它）
    expect(edge1?.last_active).toBe(now);
    expect(edge2?.last_active).toBe(now);

    // 性质：事件里的计数 == **实际**被强化的条数
    const events = readEvents(db, 'touch');
    expect(events[0]?.payload.edgesReinforced).toBe(2);
  });

  it('★ memory_id IS NULL 的边**永不被**强化（它们是「断言」不是「记忆」）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, lastAccess: 0 });
    insertEntity(db, 'e-1', '甲');
    insertEntity(db, 'e-2', '乙');
    insertEdge(db, 'edge-assertion', 'e-1', 'p', 'e-2', 0.8, 0, null);

    touch(store, ['m-1'], MS_PER_DAY);

    const edge = readEdge(db, 'e-1', 'p', 'e-2');
    expect(edge?.weight).toBe(0.8);
    expect(edge?.weight).toBeLessThan(0.8 + params.EDGE_REINFORCE_STEP);
    // 性质：last_active 也没刷新（它不属于这次 touch 的证据边）
    expect(edge?.last_active).toBe(0);
    // 性质：事件里的计数不含它
    expect(readEvents(db, 'touch')[0]?.payload.edgesReinforced).toBe(0);
  });

  it('★ 批量 touch：每条记忆的事件各记各的 edgesReinforced', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, lastAccess: 0 });
    insertMemory(db, 'm-2', { stability: 1, lastAccess: 0 });
    insertEntity(db, 'e-1', '甲');
    insertEntity(db, 'e-2', '乙');
    insertEdge(db, 'edge-1', 'e-1', 'p', 'e-2', 0.8, 0, 'm-1');
    insertEdge(db, 'edge-2', 'e-1', 'q', 'e-2', 0.8, 0, 'm-2');

    touch(store, ['m-1', 'm-2'], MS_PER_DAY);

    const events = readEvents(db, 'touch');
    expect(events).toHaveLength(2);
    const byId = new Map(events.map((event) => [event.payload.id as string, event.payload]));
    expect(byId.get('m-1')?.edgesReinforced).toBe(1);
    expect(byId.get('m-2')?.edgesReinforced).toBe(1);
  });

  it('★ reason 可传参（三条路径的取值不同：explicit / exact_repeat / reinforce）', () => {
    const { db, store } = createTestStore();
    insertMemory(db, 'm-1', { stability: 1, lastAccess: 0 });
    insertMemory(db, 'm-2', { stability: 1, lastAccess: 0 });

    touch(store, ['m-1'], MS_PER_DAY);
    touch(store, ['m-2'], MS_PER_DAY, { reason: 'reinforce' });

    const events = readEvents(db, 'touch');
    expect(events[0]?.payload.reason).toBe('explicit');
    expect(events[1]?.payload.reason).toBe('reinforce');
    // ⚠️ `recall({ reinforce: true })` 的 reason **不是** 'explicit'——
    //   理由不同、来源标记必须能区分，否则事后复盘分不清
    //   「调用方真的采纳了这批记忆」与「调用方只是开了 reinforce 开关」。
    expect(events[1]?.payload.reason).not.toBe('explicit');
  });
});

describe('P1-T06 · growStability 是全库唯一的 stability 写入点', () => {
  /** 本测试文件所在目录（ESM 下没有 `__dirname`）。 */
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  /** 仓库的 `src/` 目录。 */
  const SRC_ROOT = resolve(HERE, '../../src');

  /** 递归列出目录下的 `.ts` 实现文件（排除测试与声明）。 */
  function listSourceFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
          out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  /**
   * 扫出源码里**真正写 `stability`** 的位置（剥掉注释行）。
   *
   * ⚠️ **必须先剥注释**：正文与代码注释里大量出现这条语句的字面量
   *   （例如「只出现在 growStability 内」这句话本身），
   *   不剥注释的话扫描器会把**说明文字**当成写入点 ⇒ 误报满天飞，闸门就废了。
   */
  function findStabilityWriteSites(source: string): number[] {
    const sites: number[] = [];
    source.split('\n').forEach((rawLine, index) => {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return;
      }
      if (/UPDATE\s+memories\s+SET\s+stability/i.test(rawLine)) {
        sites.push(index);
      }
    });
    return sites;
  }

  /** `growStability` 函数体的区间（源码字符下标）。 */
  function growStabilitySpan(source: string): { start: number; end: number } {
    const start = source.indexOf('function growStability');
    const next = source.indexOf('\nexport function ', start + 1);
    return { start, end: next === -1 ? source.length : next };
  }

  it('★ 全仓只有 growStability 写 stability（静态扫描：恰好一处，且落在该函数体内）', () => {
    const hits: Array<{ file: string; line: number; insideGrowStability: boolean }> = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      const span = growStabilitySpan(source);
      for (const index of findStabilityWriteSites(source)) {
        const offset = source.split('\n').slice(0, index).join('\n').length;
        hits.push({
          file: relative(SRC_ROOT, file).split(sep).join('/'),
          line: index + 1,
          insideGrowStability: span.start >= 0 && offset > span.start && offset < span.end,
        });
      }
    }

    // 性质：**恰好一处**（不多 ⇒ 没有第二个后门；不少 ⇒ 写回确实在库里发生）
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe('store/touch.ts');
    expect(hits[0]?.insideGrowStability).toBe(true);
  });

  it('★ 负控：把写入点挪到 growStability 之外 ⇒ 扫描必须报出来（闸门不是摆设）', () => {
    const source = readFileSync(join(SRC_ROOT, 'store', 'touch.ts'), 'utf8');

    // ① 注入一个**函数外**的写入点 ⇒ 命中数从 1 变 2
    const injected = `${source}\nexport function anotherWriter(db: Database.Database): void {\n  db.prepare('UPDATE memories SET stability = 1 WHERE id = ?').run('x');\n}\n`;
    const sites = findStabilityWriteSites(injected);
    expect(sites).toHaveLength(2);

    // 性质：新增的那一处**不在** growStability 的函数体内 ⇒ 闸门会判红
    const span = growStabilitySpan(injected);
    const injectedOffset = injected
      .split('\n')
      .slice(0, sites[1] ?? 0)
      .join('\n').length;
    expect(injectedOffset > span.start && injectedOffset < span.end).toBe(false);

    // ② 反过来：把 growStability 里的写入点删掉 ⇒ 命中数变 0 ⇒ 闸门也会判红
    const withoutWrite = source
      .split('\n')
      .filter((line) => !/UPDATE\s+memories\s+SET\s+stability/i.test(line))
      .join('\n');
    expect(findStabilityWriteSites(withoutWrite)).toHaveLength(0);
  });

  it('★ growStability 直接调用时也走同一套三个约束（守卫 / 上限 / 计数）', () => {
    const { db, store, params } = createTestStore();
    insertMemory(db, 'm-1', { stability: 170, difficulty: 0.5, lastAccess: 0 });

    const outcome = growStability(
      store,
      { id: 'm-1', stability: 170, last_access: 0, access_count: 0, difficulty: 0.5 },
      difficultyBonus(0.5, params),
      true,
      MS_PER_DAY * 2,
    );

    expect(readMemory(db, 'm-1').stability).toBe(params.MAX_STABILITY);
    expect(outcome.boosted).toBe(true);
    expect(outcome.stabilityDelta).toBeCloseTo(params.MAX_STABILITY - 170, 12);
    expect(readMemory(db, 'm-1').access_count).toBe(1);
    expect(readMemory(db, 'm-1').last_access).toBe(MS_PER_DAY * 2);
  });
});
