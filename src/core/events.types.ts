/**
 * 事件流的类型定义 —— DESIGN-v2.md §8.4。
 *
 * ⚠️ **13 种 `events.type` 是固定枚举，新增能力只能扩 payload 键**（ADR-15）：
 * SQLite 的 `CHECK` 约束**无法 ALTER** ⇒ 加新 type 要重建 `events` 表 + 重建全部索引与触发器。
 * ⇒ §3 已写明：加新 type 必须同改三处（本文件的枚举 / §3 的 CHECK / §8.4 的对照表）。
 *
 * ⚠️ 本文件在阶段 0 分两次长成：
 * · P0-T02 先落 `EVENT_TYPES` 与 `config` 事件的 payload（`setParams` 要写它）；
 * · P0-T04 补齐其余 12 种 type 的 payload 联合。
 * 枚举**不在 P0-T02 变更**——它自始至终是 §3 的这 13 个。
 */

import type { Params } from './params.js';

/**
 * `events.type` 的 13 种取值（§3 的 CHECK 约束，与 §8.4 的对照表**逐字一致**）。
 *
 * ⚠️ 顺序即 §3 CHECK 约束里的书写顺序，便于逐字比对。
 */
export const EVENT_TYPES = [
  'write',
  'merge',
  'restore',
  'manual_fix',
  'alias',
  'touch',
  'recall',
  'link',
  'pin',
  'unpin',
  'forget',
  'sweep',
  'config',
] as const;

/** `events.type` 的联合类型。 */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * `config` 事件的 payload（§8.4 的 config 行）。
 *
 * ⚠️ **构造时与 `setParams()` 时都必须带 `SCHEMA_VERSION` 与 `params`**
 * （`params` = **变更后的完整生效参数**）。
 * · `params` **恒有** —— 它是完整快照；
 * · `changed` **只在 `setParams()` 时有** —— 构造那一刻「没有变更」，
 *   只记 `changed: []` 等于把第 0 步的参数留白，重放时只能拿 `DEFAULT_PARAMS` 反推，
 *   推出来的与实际生效值可能不同，而且不会报错（§8.4 硬规则 2）。
 */
export interface ConfigEventPayload {
  /** schema 版本号（写入 `PRAGMA user_version` 的那个常量，§9.1）——**不是**文档版本号。 */
  SCHEMA_VERSION: number;
  /** 变更后的**完整**生效参数快照。 */
  params: Params;
  /** 本次变更的差异（仅 `setParams()` 事件带；构造事件不带）。 */
  changed?: Array<{ key: string; from: unknown; to: unknown }>;
}

/**
 * 事件 payload 的联合类型。
 *
 * ⚠️ 阶段 0 当前只有 `config` 会真的被写出来（其余 12 种 type 的发射点在阶段 1~4），
 *   P0-T04 会把本联合补齐。
 */
export type EventPayload = ConfigEventPayload;

/**
 * §8.2 的硬规则：**正文只在 `events.payload.contentText` 一个键**。
 *
 * 仅 `write` / `merge`(3c) / `manual_fix` 三类可写；其余 10 类**不得**包含 `contentText`。
 */
export const CONTENT_TEXT_KEY = 'contentText';

/** 允许在 payload 里写正文的 3 种 type（§8.2）。 */
export const TYPES_ALLOWING_CONTENT_TEXT: readonly EventType[] = ['write', 'merge', 'manual_fix'];
