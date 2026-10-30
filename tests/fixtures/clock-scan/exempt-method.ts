/**
 * C37 扫描器的**豁免**夹具：方法名在 §11.1 的豁免清单里（`pin`），
 * 且代码里有注释写明「为什么不接收 now」⇒ 扫描器必须放行。
 */

export function pin(id: string): void {
  // ⚠️ `pin` 不接收 now：它不写任何时间派生字段（§11.1 豁免清单）
  void id;
  void Date.now();
}
