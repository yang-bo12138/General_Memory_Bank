/**
 * 「**只补跑迁移段**」的运维入口 —— P4 起就挂在欠账里的一条（性能轮补齐）。
 *
 * ⚠️ **它解决的是一个真实的中断场景**：v1 → v2 迁移分两段（§9.1）——
 *   · **阶段 A**：建齐九张新表 + 全部索引（全部 `IF NOT EXISTS` ⇒ **可重复执行**）；
 *   · **阶段 B**：回填 `archival_schedule`（**分批提交**，100 万行单事务会让 WAL 暴涨 + 持写锁数分钟）。
 *   阶段 B 跑到一半崩了 ⇒ 库里是「阶段 A 已完成、阶段 B 只回填了一部分」的中间态。
 *   此时**不该**再走一次完整的 `migrateV1ToV2()`（虽然它幂等，但会让运维以为要从头来），
 *   也不该手工敲 SQL ⇒ 需要一条**只重跑阶段 B**的命令。
 *
 * ⚠️ **正确性从不依赖「回填是否跑完」**：`migratePhaseB` 只在**跑完**时置
 *   `archival_schedule_ready = 1`；未置位时 `countArchived()` 走**逐行精筛**
 *   （慢但正确，§9.4.5 的降级路径）⇒ 中断态**仍然是可用的库**，只是观测口径退化。
 *   ⇒ 本命令的价值是「把降级态修回正常态」，不是「修一个坏掉的库」。
 *
 * 用法：
 * ```bash
 * pnpm migrate --db data/ocean.db --dry-run          # 只看现状（不写库）
 * pnpm migrate --db data/ocean.db --phase b           # 只补跑回填段
 * pnpm migrate --db data/ocean.db --phase b --batch-size 2000
 * pnpm migrate --db data/ocean.db --phase all         # 完整两段（等价 migrateV1ToV2）
 * ```
 *
 * ⚠️ **不做备份**：本脚本**只跑 DDL + 回填**（不改已有业务行），但迁移本身**不可逆**
 *   （v1 的代码打不开 v2 的库，§9.1）⇒ 首次迁移前请先跑 `scripts/backup.ts`。
 *   脚本会在输出里再提醒一次。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import { openDatabase, readUserVersion } from '../src/db/connection.js';
import { migratePhaseA, migratePhaseB, migrateV1ToV2 } from '../src/db/migrate.js';

/** 要跑哪一段。 */
export type MigratePhase = 'a' | 'b' | 'all';

/** 命令行入参。 */
export interface MigrateArgs {
  /** 库文件（**必填**，不猜默认路径 —— 猜错就是往别人的库里写）。 */
  dbPath: string;
  /** 跑哪一段（缺省 `all`）。 */
  phase: MigratePhase;
  /** 阶段 B 的批次大小（缺省走 `Params.SWEEP_BATCH_SIZE`）。 */
  batchSize?: number;
  /** 只看现状、不写库。 */
  dryRun: boolean;
}

/** 现状快照（干跑与实跑都先取一次，便于对照）。 */
export interface MigrateSnapshot {
  /** `PRAGMA user_version`。 */
  userVersion: number;
  /** 未软删的记忆条数（回填的**分母**）。 */
  liveMemories: number;
  /** `archival_schedule` 行数（回填的**分子**）。 */
  scheduleRows: number;
  /** `archival_schedule_ready` 是否置 1（置 1 = 回填跑完过）。 */
  ready: boolean;
}

/** 一次运行的结果。 */
export interface MigrateRunResult {
  before: MigrateSnapshot;
  after: MigrateSnapshot;
  /** 阶段 B 本次真正写进 `archival_schedule` 的行数（阶段 `a` 时为 0）。 */
  backfilled: number;
  /** 本次实际跑了哪几段（干跑时为空）。 */
  ran: MigratePhase[];
}

/** 一次迁移的用法说明（错误信息里回显，避免「报错了但不知道怎么用」）。 */
export const USAGE =
  '用法：tsx scripts/migrate.ts --db <库文件> [--phase a|b|all] [--batch-size N] [--dry-run]';

/**
 * 解析命令行。
 *
 * ⚠️ **缺 `--db` 一律抛错**（同 `scripts/backup.ts`）：猜默认路径 ⇒ 可能往**另一个库**写。
 * ⚠️ **非法 `--phase` 也抛错**（不静默回退到 `all`）：迁移是不可逆动作，
 *   「我以为只补跑 B，结果它把 A 也重跑了一遍」这种事故不值得用「宽容解析」去换。
 */
export function parseArgs(argv: readonly string[]): MigrateArgs {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const dbPath = get('--db');
  if (dbPath === undefined) {
    throw new Error(`缺 --db。${USAGE}`);
  }

  const phaseRaw = get('--phase') ?? 'all';
  if (phaseRaw !== 'a' && phaseRaw !== 'b' && phaseRaw !== 'all') {
    throw new Error(`--phase 只能是 a / b / all（收到 ${phaseRaw}）。${USAGE}`);
  }

  const batchRaw = get('--batch-size');
  let batchSize: number | undefined;
  if (batchRaw !== undefined) {
    batchSize = Number(batchRaw);
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(`--batch-size 必须是 >= 1 的整数（收到 ${batchRaw}）`);
    }
  }

  return {
    dbPath: resolve(dbPath),
    phase: phaseRaw,
    // ⚠️ 条件展开（`exactOptionalPropertyTypes`）：显式 `batchSize: undefined` 与「不传」是两件事。
    ...(batchSize === undefined ? {} : { batchSize }),
    dryRun: argv.includes('--dry-run'),
  };
}

/** 取一次现状快照（**只读**，干跑也用它）。 */
export function snapshot(db: Database.Database): MigrateSnapshot {
  const userVersion = readUserVersion(db);
  const liveMemories = (
    db.prepare('SELECT COALESCE(count(*), 0) AS n FROM memories WHERE deleted = 0').get() as {
      n: number;
    }
  ).n;
  let scheduleRows = 0;
  try {
    scheduleRows = (
      db.prepare('SELECT COALESCE(count(*), 0) AS n FROM archival_schedule').get() as { n: number }
    ).n;
  } catch {
    // 阶段 A 还没跑过 ⇒ 表不存在。这不是错误，是「回填确实还没发生」。
    scheduleRows = 0;
  }
  let ready = false;
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'archival_schedule_ready'`).get() as
      | { value: string }
      | undefined;
    ready = row?.value === '1';
  } catch {
    ready = false;
  }
  return { userVersion, liveMemories, scheduleRows, ready };
}

/**
 * 跑一次迁移。
 *
 * ⚠️ **干跑只读打开**：`readonly: true` ⇒ 就算代码写错也写不进去（比「记得别写」可靠）。
 */
export function runMigrate(args: MigrateArgs): MigrateRunResult {
  if (!existsSync(args.dbPath)) {
    throw new Error(`库文件不存在：${args.dbPath}`);
  }

  if (args.dryRun) {
    const db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
    try {
      const before = snapshot(db);
      return { before, after: before, backfilled: 0, ran: [] };
    } finally {
      db.close();
    }
  }

  const db = openDatabase({ dbPath: args.dbPath });
  try {
    const before = snapshot(db);
    const ran: MigratePhase[] = [];
    let backfilled = 0;

    const options = {
      ...(args.batchSize === undefined ? {} : { batchSize: args.batchSize }),
      now: () => Date.now(),
    };

    if (args.phase === 'a' || args.phase === 'all') {
      migratePhaseA(db, options);
      ran.push('a');
    }
    if (args.phase === 'b' || args.phase === 'all') {
      backfilled = migratePhaseB(db, options);
      ran.push('b');
    }
    if (args.phase === 'all') {
      // ⚠️ 走一遍 `migrateV1ToV2` 的**完整性校验侧**（`assertV2TablesComplete` 在内部）：
      //   上面已按段跑过，这里再调一次是**幂等**的，作用是「让整条链路自己验一遍」。
      migrateV1ToV2(db, options);
    }

    const after = snapshot(db);
    return { before, after, backfilled, ran };
  } finally {
    db.close();
  }
}

/** 把结果渲染成一段人能读的报告（**失败也要能看出是哪种失败**）。 */
export function formatReport(result: MigrateRunResult, args: MigrateArgs): string {
  const lines: string[] = [];
  lines.push(`库：${args.dbPath}`);
  lines.push(`模式：${args.dryRun ? '干跑（只读，不写库）' : `实跑 phase=${args.phase}`}`);
  lines.push(
    `schema 版本：${String(result.before.userVersion)} → ${String(result.after.userVersion)}`,
  );
  lines.push(
    `活记忆：${String(result.before.liveMemories)}；` +
      `archival_schedule：${String(result.before.scheduleRows)} → ${String(result.after.scheduleRows)}`,
  );
  lines.push(
    `archival_schedule_ready：${String(result.before.ready)} → ${String(result.after.ready)}`,
  );
  if (!args.dryRun) {
    lines.push(`本次回填行数：${String(result.backfilled)}（跑了 ${result.ran.join(' + ')}）`);
  }

  // ⚠️ **一致性判据**：ready=1 时，回填行数与活记忆数必须相等
  //   （`archival_schedule` 每行对应一条活记忆；不等就是「回填跑完了但有漏」）。
  if (result.after.ready) {
    const consistent = result.after.scheduleRows === result.after.liveMemories;
    lines.push(
      consistent
        ? '✓ 回填完整：archival_schedule 行数 == 活记忆数'
        : `⚠️ 回填不完整：archival_schedule ${String(result.after.scheduleRows)} 行 ≠ 活记忆 ${String(result.after.liveMemories)} 条 ⇒ 建议再跑一次 --phase b`,
    );
  } else {
    lines.push('提示：archival_schedule_ready 仍为 0 ⇒ 归档口径走逐行精筛（慢但正确）');
  }
  lines.push('⚠️ 迁移不可逆：首次迁移前请先 `tsx scripts/backup.ts --db <库> --out-dir <目录>`');
  return lines.join('\n');
}

// ⚠️ 可选链（biome 的 `useOptionalChain`）：`argv[1]` 在 `node -e` 这类调用下可能是 undefined
//   ⇒ `?.` 之后再比 `=== true`，语义与「先判 undefined 再调」完全一致。
const invokedDirectly =
  process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/migrate.ts') === true;

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = runMigrate(args);
    process.stdout.write(`${formatReport(result, args)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
