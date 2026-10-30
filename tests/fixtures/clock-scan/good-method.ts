/**
 * C37 扫描器的**正例**夹具：方法体读真实时钟，但签名**含** `now?`
 * ⇒ 扫描器必须放行（它接收注入时钟，真实时钟只是缺省值）。
 */

export function goodMethod(now?: number): number {
  return now ?? Date.now();
}
