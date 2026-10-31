/**
 * 时间单位常量 —— **唯一定义处**。
 *
 * ★ `MS_PER_DAY` 的**唯一定义**在本文件（`86_400_000` 毫秒 = 1 天）。
 *
 * ⚠️ **为什么把它下沉到 `util/`**（C36：同一个键名两处两套语义）：
 *   `MS_PER_DAY` 原本在**两个地方各定义了一份**——
 *   `src/core/decay.ts`（`86400000`）与 `src/util/log.ts`（`86_400_000`）——
 *   数值相同、**来源不同** ⇒ 哪天有人只改其中一份，两份就分家
 *   ⇒ 而分家的表现是「有的地方按天算、有的地方按别的单位算」，**不报错**，只是数悄悄错了。
 *   另一个理由是**分层**：`src/util/log.ts` 是最底层（不依赖任何 `core/`），
 *   而 `src/core/decay.ts` 在 `core/` 里 ⇒ 常量若定义在 `core/`，
 *   `util/log.ts` 就得反过来依赖 `core/` ⇒ **分层倒置**。
 *   ⇒ 常量下沉到两边都能依赖的 `util/`，`core/decay.ts` 与 `util/log.ts` 都从这里取。
 *
 * ⚠️ **待办（下一次统一收敛时一并做）**：
 *   `src/core/decay.ts` 的 **re-export** 与 `src/index.ts` / `src/core/scoring.ts` /
 *   `src/core/stability.ts` 的 **import 路径**目前仍指向 `./decay.js`。
 *   ⇒ 这次刻意**只做「定义下沉、导出保留」**：`decay.ts` 继续 re-export，
 *     既有 import 一行都不用改 ⇒ 门面线与 recall 线**不需要串行等待**，
 *     主线不会在中间态编译不过。
 *   ⇒ 待下一次三方都能同时动手时，把这些 import 路径统一改成直接指向 `./util/time.js`。
 *
 * ⚠️ **本文件不得读时钟、不得有副作用** —— 它只被 import。
 */

/** 一天的毫秒数（§4.1 / §4.5 公式里的 `86400000`）。 */
export const MS_PER_DAY = 86_400_000;
