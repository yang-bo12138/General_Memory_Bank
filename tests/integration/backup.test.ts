/**
 * 备份 / 恢复的集成测试 —— DESIGN-v2.md §11.3.1，对应 **P4-T08**。
 *
 * ★ 本文件守四件事：
 *   ① `VACUUM INTO` 产物的 `integrity_check == ok`，且**尺寸与校验和被登记**；
 *   ② **备份失败要显式失败**：非 0 退出 + **残件被删除**（半截文件绝不冒充备份）；
 *   ③ 保留策略按**份数**轮转；
 *   ④ **恢复后 PRAGMA 重新生效**（`journal_mode == wal`）+ 自检三项全绿 + 可重建。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import {
  type BackupArgs,
  type BackupManifestEntry,
  backupOnce,
  listBackups,
  parseArgs,
} from '../../scripts/backup.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { MemoryStore } from '../../src/store/MemoryStore.js';
import { verifyIntegrity } from '../../src/tools/verify.js';

/** 建一个临时目录（每个用例一个，用完删）。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gmb-backup-'));
}

/** 造一个有数据的库（`MemoryStore` 保证 WAL 与 schema 都按产品口径建立）。 */
function seedStore(dbPath: string): void {
  const store = new MemoryStore({ dbPath });
  try {
    store.write({ content: '她不喜欢猫粮', entities: ['她', '猫粮'] });
    store.write({ content: '张三住在上海', entities: ['张三', '上海'] });
    store.rebuildArchivalSchedule(1_700_000_000_000);
  } finally {
    store.close();
  }
}

describe('backup · 成功路径', () => {
  it('★ 产物 `integrity_check == ok`，且清单里登记了尺寸与校验和', () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'ocean.db');
      seedStore(dbPath);
      const args: BackupArgs = { dbPath, outDir: join(dir, 'backup'), keep: 7 };

      const entry: BackupManifestEntry = backupOnce(args, new Date('2026-11-02T10:00:00Z'));
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.userVersion).toBe(2);
      expect(entry.appVersion).toBe('2.1.0');

      // 产物本身可被打开且一致
      const check = new Database(join(args.outDir, entry.file), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(check.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      } finally {
        check.close();
      }

      // 清单落盘（**没有校验的备份只是一份文件**）
      const manifest = JSON.parse(
        readFileSync(join(args.outDir, 'manifest.json'), 'utf8'),
      ) as BackupManifestEntry[];
      expect(manifest).toHaveLength(1);
      expect(manifest[0]?.sha256).toBe(entry.sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('★ 保留策略按**份数**轮转（`keep = 2` ⇒ 只留最新两份）', () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'ocean.db');
      seedStore(dbPath);
      const args: BackupArgs = { dbPath, outDir: join(dir, 'backup'), keep: 2 };

      backupOnce(args, new Date('2026-11-02T10:00:00Z'));
      backupOnce(args, new Date('2026-11-02T10:00:01Z'));
      backupOnce(args, new Date('2026-11-02T10:00:02Z'));

      const files = listBackups(args.outDir);
      expect(files).toHaveLength(2);
      // 最新那份一定在（按时间戳命名，字典序即时间序）
      // ⚠️ 文件名用的是**本地时区**（`10:00:02Z` 在 +08 下是 `18:00:02`）⇒ 只断言秒位，
      //   不断言时区偏移（否则这条断言在 CI 的 UTC 机器上会红）。
      expect(files[1]?.endsWith('02.db')).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(args.outDir, 'manifest.json'), 'utf8'),
      ) as BackupManifestEntry[];
      expect(manifest).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backup · 失败要显式失败', () => {
  it('★ 目标路径不可写 ⇒ 抛错且**不留残件**', () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'ocean.db');
      seedStore(dbPath);
      // 让 outDir 的父级是一个**文件** ⇒ mkdir 必然失败
      const blocker = join(dir, 'blocker');
      new Database(blocker).close();
      const args: BackupArgs = { dbPath, outDir: join(blocker, 'backup'), keep: 7 };

      expect(() => backupOnce(args)).toThrow();
      expect(existsSync(args.outDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('库文件不存在 ⇒ 抛错（不猜、不建空库）', () => {
    const dir = tempDir();
    try {
      const args: BackupArgs = {
        dbPath: join(dir, 'nope.db'),
        outDir: join(dir, 'backup'),
        keep: 7,
      };
      expect(() => backupOnce(args)).toThrow(/库文件不存在/);
      expect(existsSync(args.outDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一秒内重复执行 ⇒ 失败（**不覆盖**上一份好备份）', () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'ocean.db');
      seedStore(dbPath);
      const args: BackupArgs = { dbPath, outDir: join(dir, 'backup'), keep: 7 };
      const at = new Date('2026-11-02T10:00:00Z');
      backupOnce(args, at);
      expect(() => backupOnce(args, at)).toThrow(/已存在/);
      expect(listBackups(args.outDir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`parseArgs`：缺参数 / `--keep` 非法 ⇒ 抛错', () => {
    expect(() => parseArgs([])).toThrow(/用法/);
    expect(() => parseArgs(['--db', 'a.db', '--out-dir', 'b', '--keep', '0'])).toThrow(/keep/);
  });
});

describe('restore · 恢复后自检', () => {
  it('★ 恢复产物：`journal_mode == wal` 重新生效，且自检三项全绿、可重建', () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'ocean.db');
      seedStore(dbPath);
      const args: BackupArgs = { dbPath, outDir: join(dir, 'backup'), keep: 7 };
      const entry = backupOnce(args, new Date('2026-11-02T10:00:00Z'));

      // ── 恢复：把产物放回一个新路径（`VACUUM INTO` 产物无 WAL 残留 ⇒ 不需要删 -wal/-shm）──
      const restoredPath = join(dir, 'restored.db');
      copyFileSync(join(args.outDir, entry.file), restoredPath);
      expect(existsSync(`${restoredPath}-wal`)).toBe(false);

      const store = new MemoryStore({ dbPath: restoredPath });
      try {
        // ① PRAGMA 重新生效（备份文件**不带** PRAGMA 设置 ⇒ 必须由 open() 重设）
        const db = new Database(restoredPath, { readonly: true });
        try {
          expect(String(db.pragma('journal_mode', { simple: true }))).toBe('wal');
        } finally {
          db.close();
        }

        // ② 可重建（桶 / 归档 / 簇都从主表或共激活表恢复）
        store.rebuildArchivalSchedule(1_700_000_000_000);
        store.rebuildVectorBuckets({ reason: 'restore-drill' });
        store.recluster(1_700_000_000_000);

        // ③ 自检三项全绿
        const reportDb = new Database(restoredPath, { readonly: true });
        try {
          const report = verifyIntegrity(reportDb, DEFAULT_PARAMS);
          expect(report.integrityOk).toBe(true);
          expect(report.foreignKeyViolations).toBe(0);
          expect(report.archival.orphans).toBe(0);
          expect(report.archival.missing).toBe(0);
          expect(report.ok).toBe(true);
        } finally {
          reportDb.close();
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
