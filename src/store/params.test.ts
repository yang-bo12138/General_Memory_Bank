/**
 * `ParamStore` 的事务形状单测 —— DESIGN-v2.md §5 / §8.4。
 *
 * 覆盖的验收硬断言（DEVELOPMENT-PLAN.md P0-T02）：
 * · 8 条跨参数校验失败 ⇒ **库内参数一个都没变**（零写入、零事件）
 * · `setParams` 成功后**恰好写一条** `events(type='config')`，
 *   payload 含 `SCHEMA_VERSION` 与**完整** `params`
 */

import { describe, expect, it } from 'vitest';

import { MemoryError } from '../core/errors.js';
import type { EventPayload, EventType } from '../core/events.types.js';
import { DEFAULT_PARAMS, type Params } from '../core/params.js';
import { SCHEMA_VERSION } from '../core/version.js';
import { ParamStore, type ParamsBackend } from './params.js';

/** 事件写入的记录。 */
interface RecordedEvent {
  type: EventType;
  memoryId: string | null;
  payload: EventPayload;
}

/**
 * 内存后端：模拟一个**带事务**的存储（抛错 ⇒ 回滚）。
 *
 * ⚠️ 回滚是这里的关键：只有真的能回滚，「一个参数都不落库」才是可断言的，
 *   否则「校验失败时没写」只是因为「压根没走到写那一步」，
 *   测不出「写了一半」这类真事故。
 */
class FakeParamsBackend implements ParamsBackend {
  params: Params;
  readonly events: RecordedEvent[] = [];
  writeCount = 0;

  constructor(initial: Params = DEFAULT_PARAMS) {
    this.params = initial;
  }

  readParams(): Params {
    return this.params;
  }

  writeParams(params: Params): void {
    this.params = params;
    this.writeCount += 1;
  }

  appendEvent(type: EventType, memoryId: string | null, payload: EventPayload): void {
    this.events.push({ type, memoryId, payload });
  }

  transaction<T>(fn: () => T): T {
    const paramsSnapshot = this.params;
    const eventsSnapshot = [...this.events];
    const writeCountSnapshot = this.writeCount;
    try {
      return fn();
    } catch (error) {
      this.params = paramsSnapshot;
      this.events.length = 0;
      this.events.push(...eventsSnapshot);
      this.writeCount = writeCountSnapshot;
      throw error;
    }
  }
}

describe('P0-T02 · ParamStore 的事务形状', () => {
  it('校验失败 ⇒ 抛 INVALID_INPUT，且库内参数一个都没变（零写入、零事件）', () => {
    const backend = new FakeParamsBackend();
    const store = new ParamStore(backend);

    expect(() => store.setParams({ REDUNDANCY_COS: 0.95 })).toThrow(MemoryError);

    expect(backend.writeCount).toBe(0);
    expect(backend.events).toHaveLength(0);
    expect(backend.params).toEqual(DEFAULT_PARAMS);
    expect(backend.params.REDUNDANCY_COS).toBe(0.9);
  });

  it('只读参数 EMBED_DIM ⇒ 抛 INVALID_INPUT，且库内参数一个都没变', () => {
    const backend = new FakeParamsBackend();
    const store = new ParamStore(backend);

    expect(() =>
      store.setParams({ EMBED_DIM: 1024 } as Parameters<typeof store.setParams>[0]),
    ).toThrow(MemoryError);

    expect(backend.writeCount).toBe(0);
    expect(backend.events).toHaveLength(0);
    expect(backend.params).toEqual(DEFAULT_PARAMS);
  });

  it('成功后恰好写一条 events(type=config)，payload 含 SCHEMA_VERSION 与完整 params', () => {
    const backend = new FakeParamsBackend();
    const store = new ParamStore(backend);

    const result = store.setParams({ ARCHIVE_LINE: 0.1 });

    expect(backend.events).toHaveLength(1);
    const event = backend.events[0];
    expect(event?.type).toBe('config');
    // ⚠️ config 事件不关联任何记忆 ⇒ `memory_id` 必须是**显式 null**（§8.4 硬规则 5）
    expect(event?.memoryId).toBeNull();

    const payload = event?.payload as {
      SCHEMA_VERSION: number;
      params: Params;
      changed?: Array<{ key: string; from: unknown; to: unknown }>;
    };
    expect(payload.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
    // 完整生效参数（不是增量！）
    expect(Object.keys(payload.params)).toHaveLength(60);
    expect(payload.params).toEqual(result.params);
    expect(payload.params.ARCHIVE_LINE).toBe(0.1);
    // changed 只在 setParams() 时有
    expect(payload.changed).toEqual([{ key: 'ARCHIVE_LINE', from: 0.05, to: 0.1 }]);
  });

  it('连续两次变更 ⇒ 恰好两条 config 事件，各自带自己的 changed', () => {
    const backend = new FakeParamsBackend();
    const store = new ParamStore(backend);

    store.setParams({ ARCHIVE_LINE: 0.1 });
    store.setParams({ RECALL_TOP_N: 7 });

    expect(backend.events).toHaveLength(2);
    expect(backend.events[0]?.type).toBe('config');
    expect(backend.events[1]?.type).toBe('config');
    const second = backend.events[1]?.payload as { changed: Array<{ key: string }> };
    expect(second.changed).toEqual([{ key: 'RECALL_TOP_N', from: 5, to: 7 }]);
    expect(backend.params.RECALL_TOP_N).toBe(7);
  });

  it('合法补丁落库后，库内参数就是新的全量参数', () => {
    const backend = new FakeParamsBackend();
    const store = new ParamStore(backend);

    store.setParams({ REDUNDANCY_COS: 0.85 });

    expect(backend.params.REDUNDANCY_COS).toBe(0.85);
    expect(Object.keys(backend.params)).toHaveLength(60);
  });
});
