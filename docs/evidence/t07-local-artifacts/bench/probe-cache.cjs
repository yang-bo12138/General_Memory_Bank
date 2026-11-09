// 页缓存旁证 + 驱逐尝试。用法：
//   node probe-cache.cjs read  <file> <offsetMB> <sizeMB>     # 读一段，报 MB/s
//   node probe-cache.cjs evict <targetMB>                     # 占内存把 standby 里的文件页挤掉
const fs = require('node:fs');
const [mode, ...rest] = process.argv.slice(2);
const CHUNK = 32 * 1024 * 1024;

if (mode === 'read') {
  const [file, offsetMB, sizeMB] = rest;
  const fd = fs.openSync(file, 'r');
  const bytes = Number(sizeMB) * 1024 * 1024;
  const buf = Buffer.allocUnsafe(CHUNK);
  let read = 0;
  const t0 = process.hrtime.bigint();
  while (read < bytes) {
    const n = fs.readSync(fd, buf, 0, CHUNK, Number(offsetMB) * 1024 * 1024 + read);
    if (n <= 0) break;
    read += n;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  fs.closeSync(fd);
  console.log(JSON.stringify({ mode: 'read', file, offsetMB: Number(offsetMB), sizeMB: Number(sizeMB), readMB: +(read / 1048576).toFixed(1), ms: +ms.toFixed(1), mbps: +(read / 1048576 / (ms / 1000)).toFixed(1) }));
} else if (mode === 'evict') {
  const targetMB = Number(rest[0] ?? 6000);
  const block = Buffer.allocUnsafe(256 * 1024 * 1024);
  const t0 = process.hrtime.bigint();
  let touched = 0;
  const blocks = [];
  while (touched < targetMB) {
    // 每个块逐页写 1 字节（迫使真实占页，不允许零页优化）
    for (let i = 0; i < block.length; i += 4096) block[i] = touched & 0xff;
    blocks.push(Buffer.from(block)); // 拷贝留在堆上
    touched += block.length / 1048576;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(JSON.stringify({ mode: 'evict', targetMB, heldMB: blocks.length * 256, ms: +ms.toFixed(0), rssMB: +(process.memoryUsage().rss / 1048576).toFixed(0) }));
}
