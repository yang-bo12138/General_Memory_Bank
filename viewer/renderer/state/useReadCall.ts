/**
 * ★ **七个面板共用的唯一读调用 hook** —— 阶段 5 · T03（设计 §7.3「七个面板共享同一套状态约定」）。
 *
 * ★ **本文件是「错误只在 一处实现」这条纪律的落点**：
 *   `MemoryError` 跨进程后 `code` / `details` 会丢（`postMessage` / `contextBridge` 都只搬
 *   `message`），所以**还原动作只走 `asWorkspaceError()`**，
 *   面板**不许**自己 `catch` 之后读 `error.code` —— 那在真实 Electron 下是 `undefined`。
 *   ⇒ `panels/*.tsx` 里 `catch (` 的出现次数被断言为 **0**
 *     （`viewer-panels-structure.test.ts`）：不是纪律，是可扫的事实。
 *
 * ⚠️ **错误路径用 `.then(onFulfilled, onRejected)` 而不是 `try/catch`**：
 *   两者等价，但前者让「本文件是唯一 catch 错误的地方」这件事在扫描层面也成立
 *   （`panels/` 与 `state/` 的判据形状一致，不需要为 hook 开例外）。
 *
 * ⚠️ **依赖用一个 `key` 字符串表达**（不是变长 `deps` 数组）：
 *   `useEffect(fn, [port, ...deps])` 在 `deps` 长度变化时 React 会警告且行为不可预测；
 *   一个显式的 `key` 让「什么时候该重查」变成**调用方写下来的字符串**，
 *   既稳定又可读（如 `` `stats:${now}` `` / `` `history:${memoryId}:${page}` ``）。
 *
 * ⚠️ **本文件不 import `electron`、不 import `viewer/main/**`**：
 *   面板只吃一个 `ReadPort`（真跑时由 preload 注入，测试里传假端口）。
 */

import { useEffect, useRef, useState } from 'react';

import { type ReadPort, type WorkspaceError, asWorkspaceError } from '../../shared/protocol.js';

/**
 * 一次读调用的三种状态（**没有第四种**）。
 *
 * ⚠️ `error` 分支装的是 `WorkspaceError`（跨进程的唯一线上形态），**不是** `Error`：
 *   面板要显示的是「错误码 + details」，而 `Error` 上那两个东西在真实 IPC 之后都不在。
 *   ⚠️ 类型上**刻意不用 `idle`**：面板打开即开始算，「还没开始」这个状态没有对应用户动作，
 *     多一个状态就多一个「忘记处理」的分支。
 */
export type ReadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly error: WorkspaceError };

/** 读一个值的函数形状（端口 → Promise）。 */
export type ReadRunner<T> = (port: ReadPort) => Promise<T>;

/**
 * 跑一次读调用并把结果包成 `ReadState`。
 *
 * @param port 读端口；`null` ⇒ **一直停在 `loading`**（端口还没注入完，不是错误）
 * @param key 依赖键：变了就重查（见文件头的说明）
 * @param run 真正的调用；**它会随渲染闭包变化，所以用 ref 拿最新的那份**
 * @returns 当前状态
 *
 * ⚠️ **端口为 `null` 时不报错也不调用**：preload 注入是异步的，
 *   在它到位之前把界面画成「库不可用」是误诊（用户会去查库）。
 *   ⚠️ 组件卸载 / `key` 变更后到货的结果**必须丢弃**（`cancelled` 旗标）：
 *     否则旧的快照会盖掉新的（在切记忆时表现为「详情串页」）。
 */
export function useReadCall<T>(
  port: ReadPort | null,
  key: string,
  run: ReadRunner<T>,
): ReadState<T> {
  const [state, setState] = useState<ReadState<T>>({ status: 'loading' });

  // ⚠️ `run` 每次都可能是新的闭包（内联箭头函数）⇒ 放进 ref，
  //   让 effect 的依赖只有 `port` 与 `key`（否则每次渲染都会重查）。
  const runRef = useRef<ReadRunner<T>>(run);
  runRef.current = run;

  /** 最近一次**生效**的失效键（见下面对 `requestedKey` 的比较）。 */
  const keyRef = useRef<string>(key);
  keyRef.current = key;

  useEffect(() => {
    if (port === null) {
      setState({ status: 'loading' });
      return;
    }

    // ⚠️ ★ 这里**真的读** `key`（不是为了让 lint 闭嘴）：
    //   它在下面被用作「这次请求属于哪个失效键」的标记，回包时与 `keyRef.current` 比对。
    //   两者不等就说明**期间又换过一次 key**（快速切换记忆 / 翻页）⇒ 丢弃这份回包。
    //   `cancelled` 旗标已经覆盖了「effect 重跑」这一种；`requestedKey` 还覆盖
    //   「重跑之后旧 Promise 才 resolve」这一种 ⇒ 详情串页的最后一条路也被堵住。
    const requestedKey = key;
    let cancelled = false;
    setState({ status: 'loading' });

    const stillWanted = (): boolean => !cancelled && keyRef.current === requestedKey;

    runRef.current(port).then(
      (data) => {
        if (stillWanted()) {
          setState({ status: 'ready', data });
        }
      },
      (error: unknown) => {
        if (stillWanted()) {
          setState({ status: 'error', error: asWorkspaceError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [port, key]);

  return state;
}

/** 构造一个 `loading` 状态（测试与面板的初值共用同一份，避免字面量散落）。 */
export function loadingState<T>(): ReadState<T> {
  return { status: 'loading' };
}

/** 构造一个 `ready` 状态。 */
export function readyState<T>(data: T): ReadState<T> {
  return { status: 'ready', data };
}

/** 构造一个 `error` 状态（**入参是任意异常**，内部统一走 `asWorkspaceError`）。 */
export function errorState<T>(error: unknown): ReadState<T> {
  return { status: 'error', error: asWorkspaceError(error) };
}
