/**
 * v1.0 参考实现（**最小参考**）—— DEVELOPMENT-PLAN.md D-10。
 *
 * ⚠️ **本仓库只有 DESIGN-v2.md，v1.0 的代码不在库内** ⇒
 *   阶段 0 只能建立「开关骨架 + golden 格式 + CI 断言」，**逐位一致的比对基线在阶段 1 末才产生**。
 *   ⇒ 本文件在阶段 0 交付的是**契约 + 驱动器**：
 *   · `RefV1Adapter` —— 参考实现必须满足的接口（五个可观测操作）；
 *   · `runScenario()` —— 驱动适配器跑完一个场景，产出可逐位比对的记录。
 *   真正的 v1.0 适配器在 **P1-T09** 落地（记忆本体十方法齐备后），
 *   并在 P3-T06、P4-T07 再验两次基线。
 *
 * ⚠️ 为什么**重写最小参考**而不是「从 golden 集反推」：
 *   从 golden 集反推得到的是**当前实现的行为**，不是 v1.0 的行为——
 *   拿它当基线，等于拿「现在的自己」证明「现在的自己没变」，那是循环论证。
 */

import { type CaptureMeta, captureRun } from '../golden/capture.js';
import type { GoldenLine, GoldenRecord } from '../golden/golden-format.js';

/** `write()` 的入参（只取可观测输出的那部分）。 */
export interface RefV1WriteInput {
  content: string;
  kind?: string;
  entities?: string[];
}

/** `write()` 的返回值（只取可观测输出的那部分）。 */
export interface RefV1WriteOutput {
  id: string;
  warnings?: string[];
}

/**
 * v1.0 参考实现必须满足的接口。
 *
 * ⚠️ **只有五个操作**：它们正是 §5 基线条件里点名的那些可观测输出
 *   （`write` / `recall` / `touch` / `get` / `stats`）。
 */
export interface RefV1Adapter {
  write(input: RefV1WriteInput): RefV1WriteOutput;
  recall(options: { context: string; topN?: number }): unknown;
  touch(ids: string[], now?: number, options?: Record<string, unknown>): unknown;
  get(id: string, now?: number): unknown;
  stats(now?: number): unknown;
}

/** 场景里的一步。 */
export interface ScenarioStep {
  /** 操作名。 */
  op: 'write' | 'recall' | 'touch' | 'get' | 'stats';
  /**
   * 入参。
   *
   * ⚠️ 支持两个占位符，让场景不依赖具体 id：
   * · `'$ids'` —— 此前所有 `write` 产生的 id（`touch` 的全集）；
   * · `'$id:0'` —— 第 0 次 `write` 产生的 id（从 0 起）。
   */
  args?: Record<string, unknown>;
}

/** 标准场景：五个操作各来一次（§5 基线条件里点名的那五个）。 */
export const STANDARD_SCENARIO: readonly ScenarioStep[] = [
  { op: 'write', args: { content: '张三住在北京', kind: 'fact', entities: ['张三'] } },
  { op: 'write', args: { content: '张三喜欢猫', kind: 'preference', entities: ['张三', '猫'] } },
  { op: 'recall', args: { context: '张三住哪里', topN: 5 } },
  { op: 'touch', args: { ids: '$ids' } },
  { op: 'get', args: { id: '$id:0' } },
  { op: 'stats', args: {} },
];

/** 把场景里的占位符解析成真实 id。 */
function resolveArgs(args: Record<string, unknown>, writtenIds: string[]): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === '$ids') {
      resolved[key] = [...writtenIds];
    } else if (typeof value === 'string' && value.startsWith('$id:')) {
      const index = Number.parseInt(value.slice('$id:'.length), 10);
      const id = writtenIds[index];
      if (id === undefined) {
        throw new Error(`场景引用了尚未写入的 id：${value}`);
      }
      resolved[key] = id;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * 驱动适配器跑完一个场景，产出可逐位比对的观测记录。
 *
 * ⚠️ 记录的 `args` 是**解析后的真实入参**——比对时入参也参与，
 *   否则「换了入参却得到同样输出」会被误判成「输出逐位相同」。
 */
export function runScenario(
  adapter: RefV1Adapter,
  scenario: readonly ScenarioStep[] = STANDARD_SCENARIO,
): GoldenRecord[] {
  const writtenIds: string[] = [];
  const records: GoldenRecord[] = [];

  for (const step of scenario) {
    const args = resolveArgs(step.args ?? {}, writtenIds);
    switch (step.op) {
      case 'write': {
        const output = adapter.write(args as unknown as RefV1WriteInput);
        writtenIds.push(output.id);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'recall': {
        const output = adapter.recall(args as unknown as { context: string; topN?: number });
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'touch': {
        const ids = (args.ids as string[] | undefined) ?? [];
        const output = adapter.touch(ids, args.now as number | undefined);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'get': {
        const output = adapter.get(args.id as string, args.now as number | undefined);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      case 'stats': {
        const output = adapter.stats(args.now as number | undefined);
        records.push({ kind: 'record', op: step.op, args, output });
        break;
      }
      default: {
        throw new Error(`未知场景操作：${String(step.op)}`);
      }
    }
  }

  return records;
}

/**
 * 跑完一个场景并组装成 golden 文件的内容。
 */
export function captureRefV1Run(
  adapter: RefV1Adapter,
  meta: CaptureMeta,
  scenario: readonly ScenarioStep[] = STANDARD_SCENARIO,
): GoldenLine[] {
  return captureRun(meta, runScenario(adapter, scenario));
}
