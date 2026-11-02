/**
 * ★ 查看器的 **IPC 通道白名单** —— 阶段 5 · P5-T01（§4.4）。
 *
 * ⚠️ **本文件只有常量，零依赖**（`viewer/shared/` 是分层最左端：它不许 import `viewer/main/**`
 *   与 `viewer/renderer/**`）。这条不是洁癖：`preload` 与 `renderer` 都会 import 它，
 *   一旦它 import 了 `main` 的某个文件，那条依赖就会跟着漏进渲染进程。
 *
 * ⚠️ **为什么"没有写通道"要写成一个空数组**：
 *   「我们记得没写写通道」是**纪律**；`WRITE_CHANNELS.length === 0` 是**可断言的事实**。
 *   前者会随时间失守（下一个人加一条通道时没人拦），后者一改就红。
 *   ⇒ 这是 §7.1 只读保证在「通道层」的落点（三层结构断言里最强的一层）。
 */

/**
 * ★ **写死的 8 条通道名**（与 `READ_PORT_METHODS` **逐名对应**，由断言钉住）。
 *
 * ⚠️ 通道名与 `ReadPort` 的方法名**不是一对一照抄**：通道名带 `mem:` 前缀、用 kebab-case
 *   （Electron 的通道名惯例），方法名是 camelCase ⇒ 二者的对应关系收在下面的
 *   `READ_CHANNEL_METHODS` 里，**只此一份**（不另立第二张对照表）。
 */
export const READ_CHANNELS = [
  'mem:stats',
  'mem:get',
  'mem:recall',
  'mem:clusters',
  'mem:inhibition-trace',
  'mem:verify-integrity',
  'mem:select',
  'mem:logs',
] as const;

/** 8 条读通道之一。 */
export type ReadChannel = (typeof READ_CHANNELS)[number];

/**
 * ★ 通道名 → `ReadPort` 方法名。**8 条，逐名写死**。
 *
 * ⚠️ 它的用途是「让 `ipc.ts` 与 `preload/index.ts` 都从同一份映射出发」：
 *   两处各手写一遍 8 个名字，必然有一天只改了一处。
 * ⚠️ 值的类型写成字面量联合（不是 `string`）⇒ 写错一个方法名**编译期**就红，
 *   而不是等到运行时 `ipcRenderer.invoke` 拿到 `undefined`。
 */
export const READ_CHANNEL_METHODS = {
  'mem:stats': 'stats',
  'mem:get': 'get',
  'mem:recall': 'recall',
  'mem:clusters': 'clusters',
  'mem:inhibition-trace': 'inhibitionTrace',
  'mem:verify-integrity': 'verifyIntegrity',
  'mem:select': 'select',
  'mem:logs': 'logs',
} as const satisfies Readonly<Record<ReadChannel, string>>;

/** 某条通道对应的 `ReadPort` 方法名。 */
export type ReadChannelMethod<C extends ReadChannel> = (typeof READ_CHANNEL_METHODS)[C];

/**
 * ★ **必须永远是空数组**。
 *
 * ⚠️ 它存在的唯一理由是**让"没有写通道"变成一条可断言的事实**，
 *   而不是"我们记得没写"。空数组 + 长度断言 ⇒ 谁想加一条写通道，门禁立刻红。
 *
 * ⚠️ 类型写成 `readonly string[]`（**不是** `readonly never[]`）：
 *   渲染进程拿到的 `ReadPort` 上**没有任何写方法**，所以「加一条写通道」在类型层面
 *   本来就没有对应的方法可调；这里保留 `string` 是为了让「它确实是个通道名数组」
 *   这件事在类型上是可读的 —— 真正的守卫是长度断言，不是这个类型。
 */
export const WRITE_CHANNELS: readonly string[] = [] as const;
