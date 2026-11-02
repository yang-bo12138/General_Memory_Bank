/**
 * ★ **七个面板共用的唯一状态组件** —— 阶段 5 · T03（设计 §7.3 那张表 + §7.2 的向量路块）。
 *
 * 设计 §7.3 要求七个面板**共享同一套状态约定，不每面板各写一套**。
 * 那四条状态在这里各有**唯一一个**实现：
 *
 * | 状态        | 判定来源                                   | 本文件里的实现                    |
 * | --------- | -------------------------------------- | -------------------------- |
 * | 加载中       | 面板自身的异步调用                              | `StatusBlock` 的 `loading` 分支 |
 * | 库不可用      | `open()` 失败 / `readonly` 句柄异常          | `StatusBlock` 的 `error` 分支   |
 * | 只读模式      | `MemoryStore.readonly`                 | `ReadonlyBadge`             |
 * | **向量路状态** | `stats().vectorBackend.mode` + `inRetrain` | `VectorRouteBlock`          |
 *
 * ⚠️ **为什么 `StatusBlock` 收的是 `state` 而不是 `data`**：
 *   它的价值在于「**面板拿不到未就绪的数据**」这件事在类型上成立 ——
 *   `children` 的类型是 `(data: T) => ReactNode`，只有 ready 分支才调用它
 *   ⇒ 面板里写不出 `state.data!` 这类东西（也就写不出「error 时画半张表」）。
 *
 * ⚠️ **错误态显示的是「错误码 + details」，不是一句「加载失败」**（设计 §7.2 末）。
 *   理由：用户必须能区分「库里没有」与「查询错了」——
 *   一句「加载失败」把这两种情况压成同一个界面，排障方向当场消失。
 *   `details` 以 JSON 原样给出（`JSON.stringify(details, null, 2)`）：
 *   它可能含 `reason` / `query` / `memoryId` 之类的线索，**翻译**它就会丢东西。
 *
 * ⚠️ 本文件不 import `electron` / `better-sqlite3` / `viewer/main/**`。
 */

import type { ReactElement, ReactNode } from 'react';

import type { VectorBackendMode } from '../../../src/store/stats.js';
import {
  ERROR_CODE_LABEL,
  ERROR_DETAILS_LABEL,
  ERROR_HEADING,
  ERROR_MESSAGE_LABEL,
  LOADING_TEXT,
  READONLY_BADGE,
  VECTOR_INDEX_BYTES_LABEL,
  VECTOR_ROUTE_HEADING,
  formatBytes,
  showsVectorIndexBytes,
  vectorRouteText,
} from '../texts.js';
import type { ReadState } from './useReadCall.js';

// ═══════════════════════════════════════════════════════════════════════════
// 一、加载中 / 库不可用 / ready 的唯一分派点
// ═══════════════════════════════════════════════════════════════════════════

/** `StatusBlock` 的入参。 */
export interface StatusBlockProps<T> {
  /** 面板这次的读状态。 */
  readonly state: ReadState<T>;
  /** 面板名（只用于 `data-panel` 定位与排障，不显示给用户）。 */
  readonly what: string;
  /** ready 分支的渲染函数（**只有 ready 时才会被调用**）。 */
  readonly children: (data: T) => ReactNode;
}

/**
 * 三态分派：加载中 → 骨架屏 + 「计算中」；错误 → 错误码 + `details`；就绪 → 交给 `children`。
 *
 * ⚠️ 骨架屏不是装饰：`clusters()` 的现场重算是**几百毫秒量级**，
 *   没有反馈时用户会反复点同一个面板（而每次点击都在 worker 里排一次重算）。
 */
export function StatusBlock<T>({ state, what, children }: StatusBlockProps<T>): ReactElement {
  if (state.status === 'loading') {
    return (
      <section className="status status--loading" data-status="loading" data-panel={what}>
        <div className="status__skeleton" aria-hidden="true" />
        <p className="status__text">{LOADING_TEXT}</p>
      </section>
    );
  }

  if (state.status === 'error') {
    const error = state.error;
    return (
      <section
        className="status status--error"
        data-status="error"
        data-panel={what}
        data-error-code={error.code}
      >
        <h3 className="status__title">{ERROR_HEADING}</h3>
        <p className="status__code">
          <span className="status__label">{ERROR_CODE_LABEL}</span>
          <code className="status__code-value" data-error-code-value="">
            {error.code}
          </code>
        </p>
        <p className="status__message">
          <span className="status__label">{ERROR_MESSAGE_LABEL}</span>
          <span className="status__message-value">{error.message}</span>
        </p>
        <pre className="status__details" data-error-details="">
          <span className="status__label">{ERROR_DETAILS_LABEL}</span>
          {'\n'}
          {JSON.stringify(error.details, null, 2)}
        </pre>
      </section>
    );
  }

  return <>{children(state.data)}</>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、只读徽标（顶栏常驻）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 「只读观察器」徽标。
 *
 * ⚠️ **常驻**（§7.3：顶部常驻）：它不是「当前处于只读模式」这种会变的状态，
 *   而是这个应用**是什么**的声明。放在 `App` 的 `<header>` 里，
 *   七个面板共用同一个（不每面板各画一个）。
 */
export function ReadonlyBadge(): ReactElement {
  return (
    <span className="badge badge--readonly" data-badge="readonly">
      {READONLY_BADGE}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、向量路块（§7.2 面板 1 的★不可省略项）
// ═══════════════════════════════════════════════════════════════════════════

/** `VectorRouteBlock` 的入参。 */
export interface VectorRouteBlockProps {
  /** `stats().vectorBackend.mode`（四值）。 */
  readonly mode: VectorBackendMode;
  /** `stats().vectorBackend.inRetrain`。 */
  readonly inRetrain: boolean;
  /** `stats().vectorBackend.indexBytes`（**只在 `ivf` / `absent` 下才显示**）。 */
  readonly indexBytes?: number | undefined;
}

/**
 * ★ **向量路的可观测落点**（§7.2：本块是「向量路静默缺席」这个失效模式的唯一观测面）。
 *
 * 两个「不得」写在这里：
 *   ① **`flat_explicit` / `flat_auto` 下不得显示「向量索引占用」** ——
 *      flat 没有分桶索引，`indexBytes` 即便有值也是个假指标；
 *   ② **`flat_auto` 不得被标成「正在重训」** —— 见 `vectorRouteText()` 的分支形状
 *      （`inRetrain` 只在 `absent` 里被读）。
 */
export function VectorRouteBlock({
  mode,
  inRetrain,
  indexBytes,
}: VectorRouteBlockProps): ReactElement {
  return (
    <section
      className="vector-route"
      data-vector-block=""
      data-vector-mode={mode}
      data-vector-in-retrain={inRetrain ? 'true' : 'false'}
    >
      <h3 className="vector-route__heading">{VECTOR_ROUTE_HEADING}</h3>
      <p className="vector-route__text" data-vector-route-text="">
        {vectorRouteText(mode, inRetrain)}
      </p>
      {showsVectorIndexBytes(mode) && indexBytes !== undefined ? (
        <p className="vector-route__bytes" data-vector-index-bytes={indexBytes}>
          {VECTOR_INDEX_BYTES_LABEL}：{formatBytes(indexBytes)}
        </p>
      ) : null}
    </section>
  );
}
