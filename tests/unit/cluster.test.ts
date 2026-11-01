/**
 * §4.12 的簇计算 —— DEVELOPMENT-PLAN.md **P3-T03** 的单元层硬断言。
 *
 * ⚠️ **本文件只测「纯计算」**（`src/neuron/cluster.ts`）：union-find、连通分量、
 *   均衡分块、簇 id 派生、有效亲和度衰减。
 *   ⇒ **不碰数据库** ⇒ 断言不会因为「库里的巧合」而变绿。
 *
 * ⚠️ **断言必须真能失败**：涉及集合的断言都**逐条比对**（不只是长度），
 *   涉及顺序的断言都**逐位比对**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '../../src/core/decay.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import {
  type CoactGraphEdge,
  componentBaseId,
  computeClusters,
  connectedComponents,
  derivedClusterId,
  effectiveAffinity,
  filterEffectiveEdges,
  originIdOf,
  splitBalanced,
} from '../../src/neuron/cluster.js';

/** 固定的「现在」（epoch 毫秒）。 */
const NOW = 1_700_000_000_000;

/** 造一条边（`a` 必须小于 `b`，与 `coacts` 的 CHECK 一致）。 */
function edge(a: string, b: string, affinity: number, lastActive = NOW): CoactGraphEdge {
  return { a, b, affinity, lastActive };
}

// ═══════════════════════════════════════════════════════════════════════
// 一、有效亲和度（§4.11.3 原则 3 / §4.11.4 ③ 的同一份实现）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T03 · effectiveAffinity（衰减后的有效值）', () => {
  it('★ 随时间衰减：exp(-Δt / (COACT_STABILITY × 86400000))', () => {
    const params = DEFAULT_PARAMS;
    const value = effectiveAffinity(0.5, NOW, NOW + params.COACT_STABILITY * MS_PER_DAY, params);
    // Δt = 一个时间常数 τ ⇒ exp(-1)
    expect(value).toBeCloseTo(0.5 * Math.exp(-1), 12);
  });

  it('★ 时钟回拨保护：now < lastActive ⇒ 不衰减（max(0, Δt)）', () => {
    const params = DEFAULT_PARAMS;
    const value = effectiveAffinity(0.5, NOW, NOW - 10 * MS_PER_DAY, params);
    expect(value).toBeCloseTo(0.5, 12);
    // ⚠️ **不能超过上限**（没有 max(0,·) 时 exp(正数) > 1 ⇒ 会反超）
    expect(value).toBeLessThanOrEqual(params.COACT_AFFINITY_MAX);
  });

  it('★ 钳到 COACT_AFFINITY_MAX（存储值已钳过，但衰减后仍要钳）', () => {
    const params = DEFAULT_PARAMS;
    const value = effectiveAffinity(params.COACT_AFFINITY_MAX, NOW, NOW, params);
    expect(value).toBe(params.COACT_AFFINITY_MAX);
  });

  it('★ 门槛过滤：affinity_eff < COACT_AFFINITY_MIN 的边**不计入簇**', () => {
    const params = DEFAULT_PARAMS;
    const edges = [
      edge('m-1', 'm-2', 0.5, NOW), // 新鲜 ⇒ 有效
      edge('m-3', 'm-4', 0.5, NOW - 100 * MS_PER_DAY), // 久未共现 ⇒ 衰减到门槛下
    ];
    const effective = filterEffectiveEdges(edges, NOW, params);
    expect(effective).toHaveLength(1);
    expect(effective[0]?.a).toBe('m-1');
    expect(effective[0]?.affinity).toBeCloseTo(0.5, 12);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 二、union-find 与连通分量
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T03 · 连通分量（union-find）', () => {
  it('★ 两个分量：共享端点的边连成一块', () => {
    const components = connectedComponents([
      edge('m-1', 'm-2', 0.4),
      edge('m-2', 'm-3', 0.3),
      edge('m-7', 'm-8', 0.9),
    ]);
    expect(components).toHaveLength(2);
    expect(components[0]?.memberIds).toEqual(['m-1', 'm-2', 'm-3']);
    expect(components[1]?.memberIds).toEqual(['m-7', 'm-8']);
  });

  it('★ 节点强度 = 与其相连的**有效**边权之和', () => {
    const components = connectedComponents([edge('m-1', 'm-2', 0.4), edge('m-1', 'm-3', 0.3)]);
    const strengths = components[0]?.strengths;
    expect(strengths?.get('m-1')).toBeCloseTo(0.7, 12);
    expect(strengths?.get('m-2')).toBeCloseTo(0.4, 12);
    expect(strengths?.get('m-3')).toBeCloseTo(0.3, 12);
  });

  it('★ 确定性：边的**传入顺序不同** ⇒ 分量与成员顺序逐条相同', () => {
    const edges = [
      edge('m-1', 'm-2', 0.4),
      edge('m-2', 'm-3', 0.3),
      edge('m-3', 'm-4', 0.2),
      edge('m-9', 'm-8', 0.5),
    ];
    const first = connectedComponents(edges);
    const second = connectedComponents([...edges].reverse());
    expect(second.map((component) => component.memberIds)).toEqual(
      first.map((component) => component.memberIds),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 三、均衡分块（确定性 / 幂等 / 终止）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T03 · 均衡分块', () => {
  it('★ k = ceil(size / 目标上限)，每块 ⌈size/k⌉ 条（最后一块可能略小）', () => {
    const members = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7'];
    const strengths = new Map(members.map((id) => [id, 1]));
    const blocks = splitBalanced(members, strengths, 3);

    // ceil(7/3) = 3 块；每块 ⌈7/3⌉ = 3 条 ⇒ 3 + 3 + 1
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.length)).toEqual([3, 3, 1]);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(3);
    }
    // ★ 所有成员**恰好**出现一次（没有丢、没有重）
    expect(blocks.flat().sort()).toEqual(members);
  });

  it('★ 排序键 = 【节点强度降序，同分按 memory id 字典序升序】', () => {
    const members = ['m-b', 'm-a', 'm-c'];
    const strengths = new Map([
      ['m-a', 0.5],
      ['m-b', 0.5],
      ['m-c', 0.9],
    ]);
    const blocks = splitBalanced(members, strengths, 3);
    // 强度降序 ⇒ m-c 在前；m-a 与 m-b 同分 ⇒ 按 id 升序 ⇒ m-a 在前
    expect(blocks[0]).toEqual(['m-c', 'm-a', 'm-b']);
  });

  it('★ 确定性：成员**传入顺序打乱** ⇒ 同样的块', () => {
    const members = Array.from({ length: 9 }, (_, index) => `m-${index}`);
    const strengths = new Map(members.map((id, index) => [id, (index % 3) + 0.1]));
    const first = splitBalanced(members, strengths, 3);
    const shuffled = [...members].reverse();
    const second = splitBalanced(shuffled, strengths, 3);
    expect(second).toEqual(first);
  });

  it('★ 幂等：同样的图分两次 ⇒ 逐条相同的块', () => {
    const members = Array.from({ length: 12 }, (_, index) => `m-${index}`);
    const strengths = new Map(members.map((id, index) => [id, (index % 4) + 0.1]));
    const first = splitBalanced(members, strengths, 5);
    const second = splitBalanced(members, strengths, 5);
    expect(second).toEqual(first);
  });

  it('★ 终止性（否决算法①的形状）：**团**（clique）也能切完，且块数符合公式', () => {
    // ⚠️ 团：任意两点之间都有边 ⇒ 「逐条删除最弱边」永远不收敛（size 不变）
    const members = Array.from({ length: 8 }, (_, index) => `m-${index}`);
    const cliqueEdges: CoactGraphEdge[] = [];
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        cliqueEdges.push(edge(members[i] ?? '', members[j] ?? '', 0.5));
      }
    }
    const components = connectedComponents(cliqueEdges);
    expect(components).toHaveLength(1);

    const strengths = components[0]?.strengths ?? new Map<string, number>();
    const blocks = splitBalanced(components[0]?.memberIds ?? [], strengths, 2);
    // ceil(8/2) = 4 块，每块 2 条
    expect(blocks).toHaveLength(4);
    expect(blocks.map((block) => block.length)).toEqual([2, 2, 2, 2]);
  });

  it('★ 终止性（否决算法②的形状）：**孤立节点**（强度 0）不会让循环空转', () => {
    // ⚠️ 已孤立节点的强度 = 0 ⇒ 「取强度最低者并剥离」会永远选中它 ⇒ 每轮都是无操作
    const members = Array.from({ length: 5 }, (_, index) => `m-${index}`);
    const strengths = new Map<string, number>([
      ['m-0', 0],
      ['m-1', 0.9],
      ['m-2', 0.8],
      ['m-3', 0.7],
      ['m-4', 0.6],
    ]);
    const blocks = splitBalanced(members, strengths, 2);
    expect(blocks).toHaveLength(3);
    expect(blocks.flat().sort()).toEqual(members);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 四、簇 id 与来源（C35 / §4.12.3）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T03 · 簇 id 与来源', () => {
  it('★ 基准 id 是成员集合的**纯函数**（同样的成员 ⇒ 同样的 id）', () => {
    const members = ['m-1', 'm-2', 'm-3'];
    expect(componentBaseId(members)).toBe(componentBaseId([...members].reverse()));
  });

  it('★ 分裂时新簇沿用原簇 id 的**一半 + 新后缀**，且**不与原 id 相同**（避免 id 复用）', () => {
    const base = componentBaseId(['m-1', 'm-2', 'm-3', 'm-4']);
    const first = derivedClusterId(base, 1);
    const second = derivedClusterId(base, 2);

    expect(first).not.toBe(base);
    expect(second).not.toBe(base);
    expect(first).not.toBe(second);
    // ★ 前一半与原 id 相同 ⇒ 血缘可辨
    expect(first.startsWith(base.slice(0, Math.ceil(base.length / 2)))).toBe(true);
    // ★ 同源分组键 = 派生 id 的前缀
    expect(originIdOf(first)).toBe(originIdOf(second));
    expect(originIdOf(first)).not.toBe(base);
  });

  it('★ 未分裂的簇：originComponentId 就是它自己', () => {
    const computation = computeClusters({
      edges: [edge('m-1', 'm-2', 0.5)],
      totalMemories: 10,
      now: NOW,
      params: DEFAULT_PARAMS,
    });
    const cluster = computation.clusters[0];
    expect(cluster?.originComponentId).toBe(cluster?.clusterId);
    expect(cluster?.blocksCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 五、兜底切分（§4.12.4 ③，v2.1 行为变更）
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T03 · 兜底切分（读**切前**的原始分量占比）', () => {
  /** 造 n 条互不相连、但都连到 m-0 的边 ⇒ 一个大小为 n+1 的分量。 */
  function hubEdges(n: number, affinity = 0.5): CoactGraphEdge[] {
    const edges: CoactGraphEdge[] = [];
    for (let index = 1; index <= n; index += 1) {
      edges.push(edge('m-0', `m-${index}`, affinity));
    }
    return edges;
  }

  it('★ 原始分量占比 > MAX_CLUSTER_SHARE ⇒ 触发切分', () => {
    const params = DEFAULT_PARAMS;
    // hubEdges(6) ⇒ 一个 7 节点的分量；7/10 = 0.7 > 0.5 ⇒ 触发
    // 目标上限 = max(2, floor(0.02 × 10)) = 2 ⇒ k = ceil(7/2) = 4 ⇒ 每块 ⌈7/4⌉ = 2（最后一块 1）
    const computation = computeClusters({
      edges: hubEdges(6),
      totalMemories: 10,
      now: NOW,
      params,
    });
    expect(computation.splitTriggered).toBe(true);
    expect(computation.clusters).toHaveLength(4);
    expect(computation.clusters.map((cluster) => cluster.memberIds.length)).toEqual([2, 2, 2, 1]);
    // ★ **切后**的最大块占比 = 2/10 = 0.2（目标上限口径）
    expect(computation.largestClusterRatio).toBeCloseTo(0.2, 12);
    // ★ **切前**的原始分量占比 = 7/10 = 0.7 ⇒ 两个口径**不同值**
    expect(computation.rawComponentShare).toBeCloseTo(0.7, 12);
    expect(computation.rawComponentShare).not.toBeCloseTo(computation.largestClusterRatio, 6);
  });

  it('★ 原始分量占比 <= MAX_CLUSTER_SHARE ⇒ **不切**（哪怕某块超过目标尺寸）', () => {
    const params = DEFAULT_PARAMS;
    // 4/10 = 0.4 <= 0.5 ⇒ 不触发 ⇒ 即便 0.4 > 目标上限（2）也**不切**
    const computation = computeClusters({
      edges: hubEdges(4),
      totalMemories: 10,
      now: NOW,
      params,
    });
    expect(computation.splitTriggered).toBe(false);
    expect(computation.clusters).toHaveLength(1);
    expect(computation.clusters[0]?.memberIds).toHaveLength(5);
  });

  it('★ 切分**幂等**：同样的图算两次 ⇒ 逐条相同的块', () => {
    const params = DEFAULT_PARAMS;
    const edges = hubEdges(6);
    const first = computeClusters({ edges, totalMemories: 10, now: NOW, params });
    const second = computeClusters({ edges, totalMemories: 10, now: NOW, params });
    expect(second.clusters.map((cluster) => cluster.memberIds)).toEqual(
      first.clusters.map((cluster) => cluster.memberIds),
    );
    expect(second.clusters.map((cluster) => cluster.clusterId)).toEqual(
      first.clusters.map((cluster) => cluster.clusterId),
    );
  });

  it('★ 切分**每轮从原始分量重新推导**（不对已切过的块再切）', () => {
    const params = DEFAULT_PARAMS;
    const edges = hubEdges(6);
    const computation = computeClusters({ edges, totalMemories: 10, now: NOW, params });
    // ★ 每一块都来自**同一个原始分量** ⇒ originComponentId 相同、originSize 是切前的规模
    const origins = new Set(computation.clusters.map((cluster) => cluster.originComponentId));
    expect(origins.size).toBe(1);
    for (const cluster of computation.clusters) {
      expect(cluster.originSize).toBe(7);
      expect(cluster.blocksCount).toBe(4);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 六、C35：触发量必须内部化、且与对外字段不同名
// ═══════════════════════════════════════════════════════════════════════

describe('P3-T03 · C35（触发量与对外量不同名）', () => {
  it('★ 源码里**不得出现**对外字段名 `maxRawComponentRatio`（触发量不引用被测对象的字段名）', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'neuron', 'cluster.ts'), 'utf8');
    expect(source).not.toContain('maxRawComponentRatio');
    // ⚠️ **负控**：把这种写法塞进去 ⇒ 断言必须红（证明这条不是摆设）
    const mutated = `${source}\nconst x = { maxRawComponentRatio: 1 };\n`;
    expect(mutated).toContain('maxRawComponentRatio');
  });

  it('★ 内部触发量与对外 `largestClusterRatio` 是**两个不同的数**（切前 vs 切后）', () => {
    const computation = computeClusters({
      edges: [edge('m-0', 'm-1', 0.5), edge('m-0', 'm-2', 0.5), edge('m-0', 'm-3', 0.5)],
      totalMemories: 4,
      now: NOW,
      params: DEFAULT_PARAMS,
    });
    // 4/4 = 1.0 > 0.5 ⇒ 触发；目标上限 = max(2, floor(0.02×4)) = 2 ⇒ k = 2
    expect(computation.rawComponentShare).toBeCloseTo(1, 12);
    expect(computation.largestClusterRatio).toBeCloseTo(0.5, 12);
  });
});
