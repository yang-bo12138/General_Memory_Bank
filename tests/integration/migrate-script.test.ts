/**
 * `scripts/migrate.ts` 的测试 —— 「**只补跑迁移段**」这条运维入口（性能轮补齐）。
 *
 * ★ **本文件要证明的是「断点续跑」，不是「函数能跑」**：
 *   造一个「阶段 A 跑完、阶段 B 只回填了一部分」的中间态
 *   （删掉 `archival_schedule` 的部分行 + 把 `archival_schedule_ready` 置回 0），
 *   然后只跑 `--phase b`，断言回填补齐且就绪位回 1。
 *
 * ⚠️ **为什么必须用文件库**：`runMigrate()` 走的是「打开库 → 迁移 → 关库」的真实路径；
 *   `:memory:` 库在关掉之后什么都不剩 ⇒ 测不到「再打开一次继续补」这件事。
 *
 * ⚠️ **干跑（`--dry-run`）必须证明「真的没写」**：判据用**库文件内容的 sha256**
 *   前后相等（不是「看返回值说没写」）。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { USAGE, formatReport, parseArgs, runMigrate, snapshot } from '../../scripts/migrate.js';
import { openDatabase } from '../../src/db/connection.js';
import { ensureSchema } from '../../src/db/migrate.js';

/** 建一个**已迁到 v2 形态**的文件库（内存里建不出来 ⇒ 必须落盘）。 */
function makeDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gmb-migrate-'));
  const dbPath = join(dir, 'ocean.db');
  const db = openDatabase({ dbPath });
  try {
    ensureSchema(db);
    // 造 5 条活记忆（回填的分母）
    // ⚠️ `kind` / `content_tokens` 是 NOT NULL ⇒ 少一个就 `SQLITE_CONSTRAINT`。
    //   这里刻意**不写向量**（回填只依赖 stability / last_access / pin_factor）。
    const insert = db.prepare(
      `INSERT INTO memories (id, kind, content, content_tokens, content_hash, created_at,
                             last_access, access_count, stability, difficulty, pin_factor,
                             source, deleted)
       VALUES (?, 'fact', ?, ?, ?, 1000, 1000, 0, 10, 1, 1, 'cli', 0)`,
    );
    for (let index = 0; index < 5; index += 1) {
      const id = `m-${String(index)}`;
      insert.run(id, `内容 ${id}`, `内容 ${id}`, `hash-${id}`);
    }
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

/** 把库改成「阶段 B 跑到一半崩了」的中间态。 */
function breakPhaseB(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    // ⚠️ **显式造 2 行**，不依赖 `ensureSchema()` 有没有顺手回填过
    //   （首次建库那条路径也会回填 ⇒ 用 DELETE ... LIMIT 的写法会因起始行数不同而不稳定）。
    db.prepare('DELETE FROM archival_schedule').run();
    db.prepare(
      `INSERT INTO archival_schedule (memory_id, archive_at)
       SELECT id, 0 FROM memories WHERE deleted = 0 ORDER BY id LIMIT 2`,
    ).run();
    // 就绪位必须回 0 —— 这才是「没跑完」的事实（用 UPSERT：首次建库可能没有这行）
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('archival_schedule_ready', '0')
       ON CONFLICT(key) DO UPDATE SET value = '0'`,
    ).run();
  } finally {
    db.close();
  }
}

/** 库文件指纹（干跑用：必须前后不变）。 */
function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('parseArgs · 缺参数/非法值一律抛错（不猜、不静默回退）', () => {
  it('缺 --db ⇒ 抛错且回显用法（猜默认路径 = 可能往别人的库写）', () => {
    expect(() => parseArgs([])).toThrowError(new RegExp(USAGE.slice(0, 6)));
  });

  it('缺 --db 的另一个形态（只给别的参数）⇒ 同样抛错', () => {
    expect(() => parseArgs(['--phase', 'b'])).toThrowError(/缺 --db/);
  });

  it('--phase 非 a/b/all ⇒ 抛错（迁移不可逆，不做宽容解析）', () => {
    expect(() => parseArgs(['--db', 'x.db', '--phase', 'c'])).toThrowError(/--phase 只能是 a/);
  });

  it('--batch-size 非正整数 ⇒ 抛错', () => {
    expect(() => parseArgs(['--db', 'x.db', '--batch-size', '0'])).toThrowError(/batch-size/);
    expect(() => parseArgs(['--db', 'x.db', '--batch-size', '1.5'])).toThrowError(/batch-size/);
  });

  it('缺省值：phase=all、dryRun=false；--dry-run 才为 true', () => {
    const base = parseArgs(['--db', 'x.db']);
    expect(base.phase).toBe('all');
    expect(base.dryRun).toBe(false);
    expect(base.batchSize).toBeUndefined();
    expect(parseArgs(['--db', 'x.db', '--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--db', 'x.db', '--phase', 'b', '--batch-size', '300']).batchSize).toBe(300);
  });
});

describe('runMigrate · 断点续跑（阶段 A 完成、阶段 B 只跑了一半）', () => {
  it('★ 只跑 --phase b ⇒ 回填补齐、就绪位回 1（这就是「只补跑迁移段」）', () => {
    const { dir, dbPath } = makeDbPath();
    try {
      breakPhaseB(dbPath);
      const opener = new Database(dbPath, { readonly: true, fileMustExist: true });
      const broken = snapshot(opener);
      opener.close();
      // 前提：夹具真的是「不完整」的状态，否则这条用例什么都没证明
      expect(broken.liveMemories).toBe(5);
      expect(broken.scheduleRows).toBe(2);
      expect(broken.ready).toBe(false);

      const result = runMigrate({ dbPath, phase: 'b', dryRun: false });

      expect(result.ran).toEqual(['b']);
      expect(result.backfilled).toBeGreaterThan(0);
      expect(result.after.scheduleRows).toBe(result.after.liveMemories);
      expect(result.after.ready).toBe(true);
      expect(result.before.scheduleRows).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('幂等：再跑一次 --phase b ⇒ 行数不变（重复补跑是安全的）', () => {
    const { dir, dbPath } = makeDbPath();
    try {
      breakPhaseB(dbPath);
      runMigrate({ dbPath, phase: 'b', dryRun: false });
      const second = runMigrate({ dbPath, phase: 'b', dryRun: false });
      expect(second.after.scheduleRows).toBe(second.after.liveMemories);
      expect(second.after.scheduleRows).toBe(second.before.scheduleRows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runMigrate · 干跑真的不写库', () => {
  it('★ --dry-run ⇒ 库文件 sha256 前后相同，且 ran 为空', () => {
    const { dir, dbPath } = makeDbPath();
    try {
      breakPhaseB(dbPath);
      const before = sha256Of(dbPath);
      const result = runMigrate({ dbPath, phase: 'all', dryRun: true });
      expect(sha256Of(dbPath)).toBe(before);
      expect(result.ran).toEqual([]);
      expect(result.before.scheduleRows).toBe(result.after.scheduleRows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('库文件不存在 ⇒ 抛错（不能悄悄建一个空库）', () => {
    expect(() =>
      runMigrate({ dbPath: join(tmpdir(), 'definitely-missing.db'), phase: 'b', dryRun: true }),
    ).toThrowError(/库文件不存在/);
  });
});

describe('formatReport · 报告必须能看出「回填完不完整」', () => {
  it('ready=1 且行数相等 ⇒ 明确写「回填完整」', () => {
    const { dir, dbPath } = makeDbPath();
    try {
      breakPhaseB(dbPath);
      const args = { dbPath, phase: 'b' as const, dryRun: false };
      const report = formatReport(runMigrate(args), args);
      expect(report).toContain('回填完整');
      expect(report).toContain('迁移不可逆');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('★ 反例：ready 仍为 0（干跑于中间态）⇒ 必须提示「走逐行精筛」，而不是说完整', () => {
    const { dir, dbPath } = makeDbPath();
    try {
      breakPhaseB(dbPath);
      const args = { dbPath, phase: 'all' as const, dryRun: true };
      const report = formatReport(runMigrate(args), args);
      expect(report).not.toContain('回填完整');
      expect(report).toContain('逐行精筛');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
