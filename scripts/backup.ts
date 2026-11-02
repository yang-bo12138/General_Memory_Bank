#!/usr/bin/env tsx
/**
 * 备份 —— DESIGN-v2.md §11.3.1，对应 DEVELOPMENT-PLAN.md **P4-T08**。
 *
 * ★ **唯一推荐路径是 `VACUUM INTO`**：
 *   它自带一致性（相当于「在一个读事务里把整个库按页写出」）。
 *   ⚠️ **唯一禁忌：不要直接 `cp` 一个正在写的 `.db`** —— WAL 里已提交的事务不在主文件里，
 *   裸拷会得到一个**不一致**的副本，而且**不报错**（这才可怕：它看起来是一份备份）。
 *
 * ⚠️ **备份失败必须显式失败**（不是「静默产出一个坏档」）：
 *   `VACUUM INTO` 中途失败（磁盘满 / 路径不可写）会留下**半截文件**
 *   ⇒ 本脚本**先删残件、再非 0 退出**；只有 `integrity_check == ok`
 *   且校验和登记成功，才算「产出了一份备份」。
 *   ⇒ ★ **没有校验的备份只是一份文件，不是一份备份。**
 *
 * ⚠️ **保留策略按「份数」轮转**（默认 7 份）：
 *   不要按「总量」轮转 —— 单份备份就是整库，总量轮转没有意义（库一大就把自己的备份删光）。
 *
 * 用法：
 * ```bash
 * pnpm exec tsx scripts/backup.ts --db data/ocean.db --out-dir backup
 * pnpm exec tsx scripts/backup.ts --db data/ocean.db --out-dir backup --keep 3
 * ```
 *
 * 退出码：`0` = 备份成功且校验通过；`1` = 任何一步失败（**残件已删除**）。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

/** 备份产物清单里的一条记录（**这就是「校验和登记」本身**）。 */
export interface BackupManifestEntry {
  file: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  userVersion: number;
  appVersion: string;
  /** 备份时的参数快照（与 `config` 事件的 `params` 同源：`meta.params`）。 */
  params: Record<string, unknown> | null;
}

/** 命令行参数。 */
export interface BackupArgs {
  dbPath: string;
  outDir: string;
  keep: number;
}

/** 解析命令行（缺参数 ⇒ 抛错，**不猜默认库路径**）。 */
export function parseArgs(argv: readonly string[]): BackupArgs {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dbPath = get('--db');
  const outDir = get('--out-dir');
  if (dbPath === undefined || outDir === undefined) {
    throw new Error('用法：tsx scripts/backup.ts --db <库文件> --out-dir <目录> [--keep N]');
  }
  const keepRaw = get('--keep');
  const keep = keepRaw === undefined ? 7 : Number(keepRaw);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep 必须是 >= 1 的整数（收到 ${String(keepRaw)}）`);
  }
  return { dbPath: resolve(dbPath), outDir: resolve(outDir), keep };
}

/** 时间戳目录名（`YYYYMMDD-HHmmss`，本地时区）。 */
function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 读 `PRAGMA user_version` 与 `meta.params`（只读打开，**不动原库**）。 */
function readMeta(dbPath: string): { userVersion: number; params: Record<string, unknown> | null } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const userVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
    let params: Record<string, unknown> | null = null;
    try {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'params'`).get() as
        | { value: string }
        | undefined;
      if (row !== undefined) params = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      // `meta` 表不存在（v1 库）⇒ 参数快照记 null（**不猜**）
      params = null;
    }
    return { userVersion, params };
  } finally {
    db.close();
  }
}

/**
 * 执行一次备份。
 *
 * @returns 清单条目（**只在成功时返回**）
 * @throws 任何一步失败（调用方负责删残件 —— 本函数自己也会删）
 */
export function backupOnce(args: BackupArgs, now: Date = new Date()): BackupManifestEntry {
  if (!existsSync(args.dbPath)) {
    throw new Error(`库文件不存在：${args.dbPath}`);
  }
  mkdirSync(args.outDir, { recursive: true });

  const fileName = `ocean-${stamp(now)}.db`;
  const target = join(args.outDir, fileName);
  // ⚠️ 同名已存在（同一秒内跑两次）⇒ 直接失败，**不覆盖**（覆盖会把上一份好备份变成废档）
  if (existsSync(target)) {
    throw new Error(`备份目标已存在（同一秒内重复执行？）：${target}`);
  }

  const meta = readMeta(args.dbPath);

  try {
    // ── ① `VACUUM INTO`（唯一推荐路径：自带一致性）──
    const db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
    try {
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }

    // ── ② 对产物做 `integrity_check`（★ **没有校验的备份不是备份**）──
    const check = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const rows = check.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok';
      if (!ok) {
        throw new Error(`备份产物的 integrity_check 不是 ok：${JSON.stringify(rows)}`);
      }
    } finally {
      check.close();
    }

    // ── ③ 登记尺寸与校验和 ──
    const bytes = statSync(target).size;
    const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
    const entry: BackupManifestEntry = {
      file: fileName,
      bytes,
      sha256,
      createdAt: now.toISOString(),
      userVersion: meta.userVersion,
      appVersion: readAppVersion(),
      params: meta.params,
    };

    // ── ④ 写清单（**追加**到 manifest.json；清单本身是「这份备份可被信任」的唯一凭据）──
    const manifestPath = join(args.outDir, 'manifest.json');
    const manifest = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifestEntry[])
      : [];
    manifest.push(entry);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // ── ⑤ 按「份数」轮转 ──
    rotate(args.outDir, args.keep);

    return entry;
  } catch (error) {
    // ★ **显式失败**：残件必须删掉（半截文件绝不能留下冒充备份）
    rmSync(target, { force: true });
    throw error;
  }
}

/** 按份数轮转（只删 `.db` 产物与清单里的对应条目）。 */
function rotate(outDir: string, keep: number): void {
  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifestEntry[];
  const sorted = [...manifest].sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
  const excess = sorted.slice(0, Math.max(0, sorted.length - keep));
  if (excess.length === 0) return;
  const removed = new Set(excess.map((entry) => entry.file));
  for (const entry of excess) rmSync(join(outDir, entry.file), { force: true });
  const kept = manifest.filter((entry) => !removed.has(entry.file));
  writeFileSync(manifestPath, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
}

/** 读 `package.json` 的版本号（**不写死**：版本号只有一个出处）。 */
function readAppVersion(): string {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? 'unknown';
}

/** CLI 薄壳。 */
function main(): void {
  let args: BackupArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const entry = backupOnce(args);
    process.stdout.write(
      `✅ 备份完成：${entry.file}（${entry.bytes} 字节，sha256=${entry.sha256.slice(0, 16)}…，` +
        `user_version=${entry.userVersion}）\n`,
    );
  } catch (error) {
    process.stderr.write(
      `❌ 备份失败（残件已删除）：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && basename(process.argv[1]).startsWith('backup');

if (invokedDirectly) {
  main();
}

/** 目录里现有的备份文件（测试与排障用）。 */
export function listBackups(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => name.endsWith('.db'))
    .sort();
}
