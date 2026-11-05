/**
 * `scripts/check-line-endings.ts` —— 行尾守卫（物理字节扫描 · 只读 · 链外）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【它查什么】
 * ★ 仓库内**工作树**的文本文件里，物理字节是否含 `CRLF`（`\r\n`）。
 *
 * 【★ 为什么不能用 `git diff` / `git status` 判（★ 这是本脚本存在的唯一理由）】
 * ★ `.gitattributes` 钉了 `* text=auto eol=lf` ⇒ ⇒ **blob 侧恒为 LF**
 *   ⇒ ⇒ **写入工具在 Windows 上产出 CRLF 时，`git diff` 仍然是空的**
 *   （★ `text=auto` 把差异归一化掉了）⇒ ⇒ 同理 `git status` 报 `M` 也不代表
 *   内容真的变了（★ stat 变了、内容归一化后相同 ⇒ ⇒ 报 M、diff 却空）。
 *   ⇒ ⇒ **⇒ 唯一可靠的判据是【物理字节扫描】** ⇒ ⇒ 而这一步没有任何守卫在看。
 *
 * 【判据】
 * ★ 对每个 tracked 文件：**按字节读** ⇒ ⇒
 *   ① 前 8000 字节含 NUL ⇒ ⇒ **判为二进制 ⇒ 跳过**（★ 与 git 自己的启发式同口径）
 *   ② 否则判为文本 ⇒ ⇒ **物理含 `\r\n` ⇒ ⇒ 报告**
 * ⇒ ⇒ **有则 exit 1**。
 *
 * 【★ 只读】只读仓库 ⇒ 不写任何仓库内文件；`--self-test` 的夹具写在**系统临时
 *   目录**、跑完即删 ⇒ ⇒ 仓库零污染。
 *
 * 【★ 不挂进 `verify` 链】挂链 = 改 CI 行为 = 判据升级 ⇒ ⇒ 要走裁决。
 *   ⇒ 手动跑：`pnpm exec tsx scripts/check-line-endings.ts`
 *   ⇒ 自测 ：`pnpm exec tsx scripts/check-line-endings.ts --self-test`
 *
 * 【退出码】0 = 工作树物理行尾全是 LF · 1 = 有文件物理含 CRLF · 2 = 用法 / IO 错
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** CRLF 的物理字节。 */
const CRLF = Buffer.from('\r\n');

/** 二进制启发式的探测长度（★ 与 git 自己的口径一致：看前 8000 字节有没有 NUL）。 */
const BINARY_PROBE_BYTES = 8000;

/** 一个文件的扫描结果。 */
export interface FileScan {
  /** 仓库相对路径（用 `/`）。 */
  readonly file: string;
  /** 是不是二进制（⇒ 被跳过）。 */
  readonly binary: boolean;
  /** 物理含 CRLF。 */
  readonly hasCrlf: boolean;
  /** 读不到（⇒ 被跳过）。 */
  readonly unreadable: boolean;
}

/** 整批扫描的结果。 */
export interface ScanResult {
  readonly scans: FileScan[];
  /** 物理含 CRLF 的文件（★ 只含文本文件）。 */
  readonly crlfFiles: string[];
  /** 被判为二进制而跳过的文件数。 */
  readonly binarySkipped: number;
  /** 实际扫描的文本文件数。 */
  readonly textScanned: number;
  /** 读不到而跳过的文件数。 */
  readonly unreadable: number;
}

/** 是不是二进制（★ 前 8000 字节含 NUL ⇒ 是）。 */
export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/**
 * 判一个 buffer 是不是物理含 CRLF。
 *
 * ★ 这是判定的【唯一一份实现】⇒ 写路径 / 读路径 / 自测台共用它 ⇒ ⇒ 不会漂。
 */
export function bufferHasCrlf(buffer: Buffer): boolean {
  return buffer.includes(CRLF);
}

/** 扫一批文件（★ 纯函数：不碰 git、不碰仓库 ⇒ 自测可直接喂它）。 */
export function scanFiles(root: string, files: readonly string[]): ScanResult {
  const scans: FileScan[] = [];
  const crlfFiles: string[] = [];
  let binarySkipped = 0;
  let textScanned = 0;
  let unreadable = 0;

  for (const file of files) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(root, file));
    } catch {
      unreadable++;
      scans.push({ file, binary: false, hasCrlf: false, unreadable: true });
      continue;
    }
    if (isBinary(buffer)) {
      binarySkipped++;
      scans.push({ file, binary: true, hasCrlf: false, unreadable: false });
      continue;
    }
    const hasCrlf = bufferHasCrlf(buffer);
    textScanned++;
    if (hasCrlf) crlfFiles.push(file);
    scans.push({ file, binary: false, hasCrlf, unreadable: false });
  }

  return { scans, crlfFiles, binarySkipped, textScanned, unreadable };
}

/** 列 tracked 文件（★ 用 `-z` ⇒ 文件名里有特殊字符也不会解析错）。 */
export function listTrackedFiles(root: string): string[] {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return output.split('\0').filter((line) => line.length > 0);
}

/** 打印报告。 */
export function printReport(result: ScanResult, root: string): void {
  process.stdout.write(`仓库根：${root}\n`);
  process.stdout.write(
    `tracked 文件：文本扫描 ${result.textScanned} · 二进制跳过 ${result.binarySkipped}` +
      ` · 读不到跳过 ${result.unreadable}\n`,
  );
  process.stdout.write(`★ 物理含 CRLF 的文件：${result.crlfFiles.length}\n`);
  for (const file of result.crlfFiles) {
    process.stdout.write(`  ✗ ${file}\n`);
  }
}

/** 断言。 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`✗ ${message}`);
  process.stdout.write(`  ✓ ${message}\n`);
}

/** 自测主体（★ 必须有负控 ⇒ 不许是恒绿守卫）。 */
export function runSelfTest(): number {
  process.stdout.write('── check-line-endings · 自测 ──\n');
  const fixtureRoot = join(tmpdir(), `qa-line-endings-selftest-${process.pid}`);
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(fixtureRoot, { recursive: true });

    // ① CRLF 文件
    writeFileSync(join(fixtureRoot, 'crlf.txt'), Buffer.from('a\r\nb\r\n'), 'binary');
    // ② 纯 LF 文件
    writeFileSync(join(fixtureRoot, 'lf.txt'), Buffer.from('a\nb\n'), 'binary');
    // ③ 二进制（含 NUL、且故意带 CRLF）⇒ ⇒ 必须被跳过、不能被报成 CRLF
    writeFileSync(
      join(fixtureRoot, 'binary.bin'),
      Buffer.concat([Buffer.from([0x00, 0x01]), CRLF, Buffer.from([0x02])]),
      'binary',
    );

    const files = readdirSync(fixtureRoot);
    const result = scanFiles(fixtureRoot, files);
    const crlf = result.crlfFiles;

    // 负控 ①：CRLF 文件必须被报出来
    assert(crlf.includes('crlf.txt'), `负控 ① · CRLF 文件被报出来（实测 ${JSON.stringify(crlf)}）`);
    // 负控 ②：纯 LF 文件必须不被报
    assert(!crlf.includes('lf.txt'), '负控 ② · 纯 LF 文件【不被】报出来');
    // 负控 ③：二进制文件必须被跳过（即使它含 CRLF）
    assert(
      !crlf.includes('binary.bin') && result.binarySkipped === 1,
      '负控 ③ · 含 NUL 的二进制被跳过（即使它物理含 CRLF）',
    );
    // 内容驱动：同一段文字、只换行尾 ⇒ ⇒ 判定必须跟着变（★ 证明不是恒绿）
    {
      const asCrlf = bufferHasCrlf(Buffer.from('a\r\nb'));
      const asLf = bufferHasCrlf(Buffer.from('a\nb'));
      assert(
        asCrlf === true && asLf === false,
        '内容驱动 · 只换行尾 ⇒ 判定从 true 变 false（证明判据由内容驱动）',
      );
    }
    // 只含 LF 的文件绝不能被报（对全量结果的额外一致性断言）
    assert(
      result.crlfFiles.every((f) => f !== 'lf.txt' && f !== 'binary.bin'),
      '一致性 · 被报出的文件里没有纯 LF 的、也没有二进制的',
    );

    // 夹具跑完即删（★ 仓库零污染）
    rmSync(fixtureRoot, { recursive: true, force: true });
    assert(!existsSync(fixtureRoot), '负控 ④ · 临时夹具已删除（仓库零污染）');

    process.stdout.write('\n✓ 自测全部通过\n');
    return 0;
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    process.stderr.write(
      `\n✗ 自测失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

/** CLI 入口。 */
export function runCli(argv: readonly string[]): number {
  if (argv.includes('--self-test')) {
    return runSelfTest();
  }

  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1] ?? REPO_ROOT);

  const files = listTrackedFiles(root);
  const result = scanFiles(root, files);
  printReport(result, root);

  if (result.crlfFiles.length > 0) {
    process.stderr.write(
      `\n✗ 发现 ${result.crlfFiles.length} 个工作树文件物理含 CRLF（★ blob 侧仍是 LF ⇒ ⇒ git diff/status 看不出来）\n`,
    );
    return 1;
  }
  process.stdout.write('\n✓ 工作树内所有 tracked 文本文件的物理行尾都是 LF\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
