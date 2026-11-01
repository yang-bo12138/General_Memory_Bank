/**
 * 主题簇的重算 —— DESIGN-v2.md §4.12（簇的定义 / 物化 / 可复现性 / 超大簇的三层防护），
 * 对应 DEVELOPMENT-PLAN.md **P3-T03**。
 *
 * ★ **簇的定义（唯一权威，§4.12.1）**：
 *   **簇 = 共激活图上，`affinity_eff ≥ COACT_AFFINITY_MIN`（默认 0.15）的边构成的连通分量。**
 *   ⚠️ **边的两端都必须是非软删的记忆**（`memories.deleted = 0`）：
 *     软删记忆**保留**共激活边（restore 后要能回到原状），但**不参与簇的构成**。
 *     ⇒ ① 一端被软删 ⇒ **该边不计入簇**；② 软删记忆**不是**簇成员。
 *
 * ★ **为什么物化（§4.12.2）**：100 万条、1500 万条共激活边上做一次 union-find 是**秒级**操作，
 *   放进召回热路径不可行 ⇒ **定义永远是纯函数；存的是缓存**。
 *   ⇒ **不变量**：删掉 `theme_clusters` + `theme_cluster_members` 两张表重建一次，
 *     **结果必须完全一致**（簇集合与成员划分逐条相同）。
 *
 * ★ **兜底切分的触发条件（§4.12.4 ③，v2.1 行为变更 / 架构 D6）**：
 *   **本次重算中 union-find 跑完、切分之前的最大原始连通分量占比 > `MAX_CLUSTER_SHARE`（默认 0.5）**。
 *   ⚠️ **不读切后的值**：切完就永远 ≤ 0.02 ⇒ 兜底切分每个库最多发生一次 ⇒ 漂移后再退化**不会**被触发。
 *   ⚠️ **切分是幂等的**（同样的图 + 同样的确定性分块算法 ⇒ 同样的块）⇒ 不会 5→25→125 发散。
 *
 * ⚠️ ★ **触发量必须内部化、且与对外字段不同名**（C35）：
 *   · **内部触发量** = 原始分量占比（本次重算的**中间量**，**不具名**）；
 *   · 对外「切后最大块占比」= 切分后最大的那块占全库多少；
 *   · 对外「原始分量占比」= 切分前的原始分量占全库多少（**P3-T05 的 `clusters()` 才有那个字段名**）。
 *   ⇒ **本文件刻意不出现那个对外字段名** ⇒
 *     触发量与对外字段**不可互相引用**（否则结构性耦合 ⇒ 那正是刚修掉的那类缺陷）。
 *   ⇒ `tests/unit/cluster.test.ts` 有一条**静态断言**盯着这件事（源码里出现那个名字就红）。
 *
 * ⚠️ ★ **切分必须每轮从原始连通分量重新推导**（coacts → 原始分量 → 切分 → 发布），
 *   **绝不对已切过的块再切**。
 *
 * ⚠️ **两个已被否决的切分算法（写在这里防止被重新引入）**：
 *   ① 「逐条删除最弱边直到 size ≤ 上限」——**不收敛**：近重复形成的是**团（clique）**不是链，
 *      团里删掉一条边仍然连通 ⇒ size 完全不变 ⇒ 循环不推进。
 *   ② 「全图取节点强度最低者，剥离其全部关联边」——**会空转**：已孤立的节点强度 = 0，
 *      永远是最小值 → 每轮都选中它 → 每轮都是无操作。
 *   ★ **通用教训：任何「逐个删除元素直到集合变小」的循环，
 *     都必须先证明「被删的元素不会再被选中」。**
 */

import { createHash } from 'node:crypto';

import { MS_PER_DAY } from '../core/decay.js';
import type { Params } from '../core/params.js';

/**
 * 有效亲和度（**衰减后的**值）—— §4.11.3 原则 3 / §4.11.4 ③ / §4.14.3 腿 2 的**同一份实现**。
 *
 * ```
 * affinity_eff(a,b,now) = min(COACT_AFFINITY_MAX,
 *                            affinity × exp(-max(0, now - last_active) / (COACT_STABILITY × 86400000)))
 * ```
 *
 * ⚠️ **三处必须逐字相同**（§4.11.3 原则 3 明写）：
 *   ① `max(0, …)` —— 时钟回拨保护（缺了它 `Δt < 0` ⇒ `exp(正数) > 1` ⇒ 亲和度反超上限）；
 *   ② `min(COACT_AFFINITY_MAX, …)` —— 存储值已钳过，但**衰减后必然 ≤ 存储值**；
 *      钳制在这里是冗余的，**留着是为了三处口径一致**（少一处判断就少一处分叉）；
 *   ③ `COACT_STABILITY` 是**时间常数 τ**（不是半衰期；半衰期 = τ·ln2 ≈ 14.6 天）。
 *
 * ⚠️ **本函数是全库唯一的这一份衰减公式**（C36：同一件事不得有两套实现）：
 *   **P3-T04（簇跳）必须复用它**，不要另写一份。
 *
 * @param affinity 该对上一次写入时的**存储值**
 * @param lastActive 该对的 `last_active`（毫秒）
 * @param now 计算时刻（毫秒）
 * @param params 生效参数（`COACT_STABILITY` / `COACT_AFFINITY_MAX`）
 * @returns 有效亲和度（`0 ≤ 值 ≤ COACT_AFFINITY_MAX`）
 */
export function effectiveAffinity(
  affinity: number,
  lastActive: number,
  now: number,
  params: Params,
): number {
  const elapsed = Math.max(0, now - lastActive);
  const decayed = affinity * Math.exp(-elapsed / (params.COACT_STABILITY * MS_PER_DAY));
  return Math.min(params.COACT_AFFINITY_MAX, decayed);
}

/** 共激活图的一条边（**只取算簇需要的字段**）。 */
export interface CoactGraphEdge {
  /** 归一后较小的那个记忆 id。 */
  a: string;
  /** 归一后较大的那个记忆 id。 */
  b: string;
  /** 该对的存储亲和度。 */
  affinity: number;
  /** 该对最近一次共现的时刻（毫秒）。 */
  lastActive: number;
}

/** 一个连通分量（**原始的**，切分之前）。 */
export interface Component {
  /** 成员 id（**升序**，确定性）。 */
  memberIds: string[];
  /** 成员 id ⇒ 节点强度（与其相连的有效边权之和）。 */
  strengths: Map<string, number>;
}

/** 算出来的一个簇（**切分之后**的块）。 */
export interface ComputedCluster {
  /** 簇 id（**持久标识**，见 `clusterIdOf`）。 */
  clusterId: string;
  /** 成员 id（**升序**）。 */
  memberIds: string[];
  /** 所属**原始分量**的来路（`originComponentId`）。 */
  originComponentId: string;
  /** 该原始分量的占比（切前）。 */
  originRatio: number;
  /** 该原始分量的成员数（切前）。 */
  originSize: number;
  /** 那次切分把它切成了几块。 */
  blocksCount: number;
  /** 切分的时刻（毫秒）；未切分 ⇒ 本次重算的时刻。 */
  splitAt: number;
  /** 成员 id ⇒ 节点强度（诊断用）。 */
  strengths: Map<string, number>;
}

/** 一次重算的产物。 */
export interface ClusterComputation {
  /** 切分后的簇（**按簇 id 升序**，确定性）。 */
  clusters: ComputedCluster[];
  /**
   * ★ **内部触发量**：切分**之前**的最大原始连通分量占比。
   *
   * ⚠️ **它与对外那个字段同值但不同名**（C35）：
   *   对外那个名字属于 P3-T05 的 `clusters()`；本模块**刻意不用那个名字**
   *   ⇒ 触发量**不引用**被测对象的字段名 ⇒ 无结构性耦合。
   */
  rawComponentShare: number;
  /** 切分后的最大块占比（「现在有没有大簇」）。 */
  largestClusterRatio: number;
  /** 本次是否触发了兜底切分。 */
  splitTriggered: boolean;
  /** 本次切分把超限分量切成了几块（未切分 ⇒ 0）。 */
  splitBlocks: number;
  /** 参与过共激活的**活跃**记忆数（出现在共激活边上的）。 */
  coveredMemories: number;
  /** 库内**活跃**记忆总数（占比的分母）。 */
  totalMemories: number;
}

/** 一次重算的入参。 */
export interface ClusterComputationInput {
  /** 共激活边（**调用方已过滤掉软删端点**）。 */
  edges: readonly CoactGraphEdge[];
  /** 库内**活跃**记忆总数（占比的分母）。 */
  totalMemories: number;
  /** 计算时刻（毫秒）。 */
  now: number;
  /** 生效参数。 */
  params: Params;
}

// ─────────────────────────── union-find ───────────────────────────

/**
 * 并查集（union-find）—— **路径压缩 + 按秩合并**。
 *
 * ⚠️ **确定性**：合并时**按秩**（`rank`）决定挂哪边 ⇒ 与边的遍历顺序无关
 *   ⇒ 同样的图必得同样的结果（幂等的前提）。
 */
export class UnionFind {
  readonly #parent = new Map<string, string>();
  readonly #rank = new Map<string, number>();

  /** 把一个节点加进集合（自成一派）。 */
  add(node: string): void {
    if (!this.#parent.has(node)) {
      this.#parent.set(node, node);
      this.#rank.set(node, 0);
    }
  }

  /** 查根（**带路径压缩**）。 */
  find(node: string): string {
    const parent = this.#parent.get(node);
    if (parent === undefined) {
      this.add(node);
      return node;
    }
    let root = parent;
    while (root !== this.#parent.get(root)) {
      root = this.#parent.get(root) ?? root;
    }
    // ⚠️ **路径压缩**：把沿途的节点直接挂到根上 ⇒ 后续查询变快（结果不变）。
    let current = node;
    while (current !== root) {
      const next = this.#parent.get(current) ?? root;
      this.#parent.set(current, root);
      current = next;
    }
    return root;
  }

  /** 合并两个集合（**按秩** ⇒ 与遍历顺序无关）。 */
  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    const leftRank = this.#rank.get(leftRoot) ?? 0;
    const rightRank = this.#rank.get(rightRoot) ?? 0;
    if (leftRank < rightRank) {
      this.#parent.set(leftRoot, rightRoot);
      return;
    }
    this.#parent.set(rightRoot, leftRoot);
    if (leftRank === rightRank) {
      this.#rank.set(leftRoot, leftRank + 1);
    }
  }

  /** 集合里的**全部**节点（按插入顺序）。 */
  nodes(): string[] {
    return [...this.#parent.keys()];
  }
}

// ─────────────────────────── 连通分量 ───────────────────────────

/**
 * 把边集算成**连通分量**（含节点强度）。
 *
 * ⚠️ **节点强度 = 与其相连的**有效**边权之和**（§4.12.4 的均衡分块排序键）：
 *   只累加**通过门槛的**边（被门槛挡下的边不构成簇 ⇒ 也不该贡献强度）。
 *
 * @param edges 通过门槛的边
 * @returns 连通分量（按「首个成员 id 升序」排序 ⇒ 确定性）
 */
export function connectedComponents(edges: readonly CoactGraphEdge[]): Component[] {
  const unionFind = new UnionFind();
  const strengths = new Map<string, number>();

  for (const edge of edges) {
    unionFind.add(edge.a);
    unionFind.add(edge.b);
    // ⚠️ **必须真的合并**（`add` 只是把节点加进集合，**不合并集合**）
    unionFind.union(edge.a, edge.b);
    const weight = edge.affinity;
    strengths.set(edge.a, (strengths.get(edge.a) ?? 0) + weight);
    strengths.set(edge.b, (strengths.get(edge.b) ?? 0) + weight);
  }

  const grouped = new Map<string, string[]>();
  for (const node of unionFind.nodes()) {
    const root = unionFind.find(node);
    const bucket = grouped.get(root);
    if (bucket === undefined) {
      grouped.set(root, [node]);
    } else {
      bucket.push(node);
    }
  }

  const components: Component[] = [];
  for (const memberIds of grouped.values()) {
    memberIds.sort();
    const componentStrengths = new Map<string, number>();
    for (const memberId of memberIds) {
      componentStrengths.set(memberId, strengths.get(memberId) ?? 0);
    }
    components.push({ memberIds, strengths: componentStrengths });
  }
  // ⚠️ **按首个成员 id 升序** ⇒ 分量的顺序与边的遍历顺序无关（确定性）。
  components.sort((left, right) => {
    const first = left.memberIds[0] ?? '';
    const second = right.memberIds[0] ?? '';
    return first < second ? -1 : first > second ? 1 : 0;
  });
  return components;
}

// ─────────────────────────── 均衡分块 ───────────────────────────

/**
 * 均衡分块（§4.12.4 的算法，**确定性 / 幂等 / 终止**）。
 *
 * ```
 * 1. 成员按【节点强度降序，同分按 memory id 字典序升序】排序
 * 2. k = ceil(size / 目标上限)
 * 3. 按排序后的顺序切成 k 块，每块 ⌈size/k⌉ 条（最后一块可能略小）
 * ```
 *
 * ⚠️ **排序键必须带 id**：同分成员若按遍历顺序排 ⇒ 同样的图两次算出不同的块
 *   ⇒ 切分**不幂等** ⇒ 每次重算都产生新的划分 ⇒ 「簇在漂」。
 *
 * @param members 该连通分量的成员（**顺序无关**，内部会排序）
 * @param strengths 成员 id ⇒ 节点强度
 * @param targetMax 目标上限（每块 ≤ 它）
 * @returns k 个块（`k = ceil(size / targetMax)`；每块 ≤ targetMax）
 */
export function splitBalanced(
  members: readonly string[],
  strengths: ReadonlyMap<string, number>,
  targetMax: number,
): string[][] {
  const limit = Math.max(1, Math.trunc(targetMax));
  const size = members.length;

  // ⚠️ **排序键：强度降序 + id 升序**（完全确定性：不依赖随机、不依赖几何、不依赖遍历顺序）
  //   ⇒ **未超限的那一块也用同一个键**（否则「切了的那块」与「没切的那块」成员顺序口径不同
  //   ⇒ 快照的行序会随「这次切没切」而变 ⇒ 不可复现）。
  const ordered = [...members].sort((left, right) => {
    const leftStrength = strengths.get(left) ?? 0;
    const rightStrength = strengths.get(right) ?? 0;
    if (leftStrength !== rightStrength) {
      return rightStrength - leftStrength;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });

  if (size <= limit) {
    return [ordered];
  }

  const blockCount = Math.ceil(size / limit);
  const perBlock = Math.ceil(size / blockCount);
  const blocks: string[][] = [];
  for (let index = 0; index < blockCount; index += 1) {
    const start = index * perBlock;
    blocks.push(ordered.slice(start, start + perBlock));
  }
  return blocks;
}

// ─────────────────────────── 簇 id ───────────────────────────

/**
 * 一个原始分量的**基准 id**（**纯函数** ⇒ 同样的图必得同样的 id ⇒ 可复现）。
 *
 * ⚠️ **为什么用成员集合的哈希而不是自增序号**：自增序号依赖插入顺序 ⇒
 *   同样的图两次重算会给出不同的 id ⇒ 「删表重建 ⇒ 完全一致」这条不变量就断了。
 */
export function componentBaseId(memberIds: readonly string[]): string {
  const payload = [...memberIds].sort().join('\n');
  const hash = createHash('sha1').update(payload, 'utf8').digest('hex');
  return `c-${hash.slice(0, 12)}`;
}

/**
 * 簇 id 的**派生形式**（分裂时用）：**原簇 id 的一半 + 新后缀**（§4.12.3 / §4.12.4）。
 *
 * ⚠️ **为什么要派生而不是沿用原 id**：沿用 ⇒ 同一个 id 先后指两个不同的成员集合
 *   ⇒ 持有旧 id 的调用方会误以为「还是那个簇」⇒ **id 复用**是假的连续性。
 * ⇒ 派生的 id **既保留了血缘（前一半相同 ⇒ 同源可辨）**，又**不会与原 id 相同**。
 *
 * @param baseId 原始分量的基准 id
 * @param index 该块在切分中的序号（**从 1 开始**）
 * @returns 派生的簇 id（形如 `c-3f2a91.1`）
 */
export function derivedClusterId(baseId: string, index: number): string {
  const half = baseId.slice(0, Math.ceil(baseId.length / 2));
  return `${half}.${index}`;
}

/** 派生 id 的**血缘前缀**（`c-3f2a91.1` ⇒ `c-3f2a91`）—— 即 `originComponentId`。 */
export function originIdOf(clusterId: string): string {
  const dot = clusterId.lastIndexOf('.');
  return dot < 0 ? clusterId : clusterId.slice(0, dot);
}

// ─────────────────────────── 主计算 ───────────────────────────

/**
 * 算一次主题簇（**纯计算，不碰数据库**）。
 *
 * ⚠️ **切分必须每轮从原始连通分量重新推导** ⇒ 本函数**永远**从 `edges` 出发，
 *   **绝不对已切过的块再切**。
 *
 * @param input 边集 / 分母 / 时刻 / 参数
 * @returns 簇集合 + 两个口径的占比 + 切分信息
 */
export function computeClusters(input: ClusterComputationInput): ClusterComputation {
  const { edges, totalMemories, now, params } = input;

  const components = connectedComponents(edges);

  // ⚠️ ★ **内部触发量**：切分**之前**的最大原始连通分量占比。
  //   ⚠️ **它刻意不叫那个对外字段的名字**（C35：触发量不引用对外字段名）。
  let rawComponentShare = 0;
  for (const component of components) {
    const share = totalMemories > 0 ? component.memberIds.length / totalMemories : 0;
    if (share > rawComponentShare) {
      rawComponentShare = share;
    }
  }

  // ── 目标上限（随库规模自适应）──
  const targetMax = Math.max(2, Math.floor(params.CLUSTER_MAX_FRACTION * totalMemories));

  // ── 兜底切分的触发（v2.1：读**切前**的原始分量占比）──
  const splitTriggered = rawComponentShare > params.MAX_CLUSTER_SHARE;

  const clusters: ComputedCluster[] = [];
  let splitBlocks = 0;

  for (const component of components) {
    const baseId = componentBaseId(component.memberIds);
    const originRatio = totalMemories > 0 ? component.memberIds.length / totalMemories : 0;

    if (!splitTriggered || component.memberIds.length <= targetMax) {
      // ── 未超限（或没触发切分）⇒ 整块成为一个簇 ──
      clusters.push({
        clusterId: baseId,
        memberIds: component.memberIds,
        originComponentId: baseId,
        originRatio,
        originSize: component.memberIds.length,
        blocksCount: 1,
        splitAt: now,
        strengths: component.strengths,
      });
      continue;
    }

    // ── 超限 ⇒ 均衡分块（确定性 / 幂等 / 终止）──
    const blocks = splitBalanced(component.memberIds, component.strengths, targetMax);
    splitBlocks += blocks.length;
    blocks.forEach((block, index) => {
      clusters.push({
        // ★ **分裂时新簇沿用原簇 id 的一半 + 新后缀**（不与原 id 相同 ⇒ 不复用）
        clusterId: derivedClusterId(baseId, index + 1),
        memberIds: [...block].sort(),
        // ★ **同源分组键**（= 派生 id 的血缘前缀）⇒ 「它们是不是同一块切出来的」
        originComponentId: originIdOf(derivedClusterId(baseId, index + 1)),
        originRatio,
        originSize: component.memberIds.length,
        blocksCount: blocks.length,
        splitAt: now,
        strengths: new Map(
          block.map((memberId) => [memberId, component.strengths.get(memberId) ?? 0] as const),
        ),
      });
    });
  }

  // ⚠️ **按簇 id 升序** ⇒ 快照的行序与边的遍历顺序无关（可复现）。
  clusters.sort((left, right) =>
    left.clusterId < right.clusterId ? -1 : left.clusterId > right.clusterId ? 1 : 0,
  );

  let largestBlockSize = 0;
  for (const cluster of clusters) {
    if (cluster.memberIds.length > largestBlockSize) {
      largestBlockSize = cluster.memberIds.length;
    }
  }
  const largestClusterRatio = totalMemories > 0 ? largestBlockSize / totalMemories : 0;

  return {
    clusters,
    rawComponentShare,
    largestClusterRatio,
    splitTriggered,
    splitBlocks,
    coveredMemories: new Set(edges.flatMap((edge) => [edge.a, edge.b])).size,
    totalMemories,
  };
}

/**
 * 过滤出**通过门槛**的边（§4.12.1：两端都活跃 + `affinity_eff ≥ COACT_AFFINITY_MIN`）。
 *
 * @param edges 全部共激活边（**两端活跃**的那些，由调用方筛好）
 * @param now 计算时刻（毫秒）
 * @param params 生效参数
 * @returns 通过门槛的边（**带有效亲和度**，权重用它）
 */
export function filterEffectiveEdges(
  edges: readonly CoactGraphEdge[],
  now: number,
  params: Params,
): CoactGraphEdge[] {
  const effective: CoactGraphEdge[] = [];
  for (const edge of edges) {
    const affinity = effectiveAffinity(edge.affinity, edge.lastActive, now, params);
    if (affinity < params.COACT_AFFINITY_MIN) {
      continue;
    }
    effective.push({ ...edge, affinity });
  }
  return effective;
}
