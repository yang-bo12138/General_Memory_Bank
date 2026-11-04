/**
 * `scripts/backfill-codes.ts` 的集成测试 —— 码表回填（C′ 档 T03）。
 *
 * ★ **本文件要证明的不是「函数能跑」，而是四条运维承诺**：
 *   ① **幂等**：第二次跑 `encoded = 0 / alreadyCoded = N`（码只由 `embedding` 决定 ⇒
 *      重算结果逐位相同 ⇒ 重跑的唯一区别是白烧 CPU）；
 *   ② **可断点续跑**：先删掉一半码行再跑 ⇒ **只补那一半**（这就是「中途 kill 后接着走」）；
 *   ③ **干跑真的不写**：判据是**库文件 sha256 前后相等**（不是「看返回值说没写」）；
 *   ④ **A6 会红**：造「桶表多一行」的夹具 ⇒ `mismatch ≠ 0` ⇒ **退出码 1**（走 CLI 薄壳验）。
 *
 * ⚠️ **为什么必须用文件库**：`runBackfill()` 走「打开库 → 回填 → 关库」的真实路径；
 *   `:memory:` 库关掉之后什么都不剩 ⇒ 测不到「再打开一次接着补」这件事。
 * ⚠️ **夹具全是小规模**（6~10 行）：这里要测的是**语义**，不是吞吐；
 *   100 万行的真跑是 T03 的**验收动作**（在 `E:/bench/codes/` 上跑），不是单测的事。
 * ⚠️ **坏 embedding 的四种形状都要造**：`NULL` / 字节数非 4 倍数 / 维度 ≠ 768 / 含 NaN——
 *   它们的**分类路径不同**（SQL 判前两种、长度判第三种、`encodeVector()` 抛 `INVALID_INPUT` 判第四种）
 *   ⇒ 只造一种就等于只测了一条分支。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { USAGE, formatReport, parseArgs, runBackfill } from '../../scripts/backfill-codes.js';
import { DEFAULT_PARAMS } from '../../src/core/params.js';
import { openDatabase } from '../../src/db/connection.js';
import { ensureSchema } from '../../src/db/migrate.js';
import { blobToVector, vectorToBlob } from '../../src/vector/centroids.js';
import { blobToCode, decodeVector } from '../../src/vector/quantize.js';

/** 仓库根（CLI 薄壳测试要用绝对路径起子进程）。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 维度与字节数（从权威参数取，不写死 768 / 3072）。 */
const DIM = DEFAULT_PARAMS.EMBED_DIM;
const BYTES = DIM * 4;

/** 进度出口的静默实现（否则每个用例都往 stderr 刷进度行）。 */
const SILENT = (): void => {
  // 故意空：进度是给人看的，测试不需要
};

/** 一条夹具记忆（`embedding` 传 `null` ⇒ 造「没有向量」的行）。 */
interface SeedMemory {
  id: string;
  /** 向量；`null` ⇒ 该行 `embedding IS NULL`。 */
  embedding: Float32Array | Buffer | null;
  /** 是否给它一个桶归属（缺省 `true`）。 */
  withMembership?: boolean;
}

/**
 * 造一条**已 L2 归一化**的确定性向量（不用随机数：失败可复算）。
 *
 * ⚠️ **必须归一化**：`eps = ‖x − x̂‖` 那条上界证明要求 `‖x‖ = 1`（`quantize.ts` 的头三条前提）
 *   ⇒ 夹具若给未归一化的向量，测出来的 `eps` 与真实口径不是一回事。
 */
function unitVector(seed: number): Float32Array {
  const vector = new Float32Array(DIM);
  let squared = 0;
  for (let index = 0; index < DIM; index += 1) {
    // 一个便宜的确定性伪随机（LCG）：只要「各不相同且能归一化」就够了
    const value = Math.sin(seed * 12.9898 + index * 78.233);
    vector[index] = value;
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  for (let index = 0; index < DIM; index += 1) {
    vector[index] = (vector[index] as number) / norm;
  }
  return vector;
}

/** 造一个新库（可写打开 ⇒ `ensureSchema()` 建齐九张表 + 幂等补建码表）。 */
function makeDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gmb-backfill-'));
  const dbPath = join(dir, 'ocean.db');
  const db = openDatabase({ dbPath });
  try {
    ensureSchema(db);
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

/** 桶模型：一个粗桶 + 一个细桶（码表的 `fine_id` 有外键指向细桶 ⇒ 必须先有它）。 */
function seedBucketModel(db: Database.Database, fineId = 'f-1'): void {
  const centroid = vectorToBlob(unitVector(999));
  db.prepare(
    'INSERT OR REPLACE INTO vector_coarse_cells (coarse_id, centroid, updated_at) VALUES (?, ?, ?)',
  ).run('c-1', centroid, 1000);
  db.prepare(
    `INSERT OR REPLACE INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(fineId, 'c-1', centroid, 1000);
}

/** `seed()` 的选项。 */
interface SeedOptions {
  /** 细桶 id（缺省 `f-1`）。 */
  fineId?: string;
  /**
   * 关掉 `CHECK` 约束再灌（**只有「字节数非 4 倍数」那条夹具需要**）。
   *
   * ⚠️ 建库脚本里写着 `CHECK (embedding IS NULL OR length(embedding) % 4 = 0)`
   *   ⇒ 这种行**从正常写入路径根本进不了库** ⇒ 不关 CHECK 就造不出这条夹具。
   * ⚠️ 那这条分支为什么还要实现？因为**回填面对的是「已经存在的字节」**：
   *   手工 `INSERT`（sqlite3 CLI / 外部工具）、更老版本的 schema、或将来被放宽的 CHECK
   *   都会让这种行出现在库里 ⇒ 脚本不能靠「我们的 CHECK 挡得住」来免责。
   *   （`PRAGMA ignore_check_constraints` 是 SQLite 的**官方**开关，只影响当前连接。）
   */
  ignoreCheckConstraints?: boolean;
}

/**
 * 灌夹具（**同时灌 `memories` 与 `vector_cell_members`**）。
 *
 * ⚠️ `kind` / `content_tokens` / `content_hash` 是 NOT NULL ⇒ 少一个就 `SQLITE_CONSTRAINT`
 *   （这条注释是从 `migrate-script.test.ts` 抄来的 —— 同一个坑踩过两次就写进测试里）。
 */
function seed(dbPath: string, rows: readonly SeedMemory[], options: SeedOptions = {}): void {
  const fineId = options.fineId ?? 'f-1';
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    if (options.ignoreCheckConstraints === true) {
      db.pragma('ignore_check_constraints = ON');
    }
    seedBucketModel(db, fineId);
    const insertMemory = db.prepare(
      `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                             created_at, last_access, access_count, stability, difficulty,
                             pin_factor, source, deleted, embedding)
       VALUES (?, 'fact', ?, ?, ?, 1000, 1000, 0, 10, 1, 1, 'cli', 0, ?)`,
    );
    const insertMember = db.prepare(
      'INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)',
    );
    for (const row of rows) {
      const blob =
        row.embedding === null
          ? null
          : row.embedding instanceof Float32Array
            ? vectorToBlob(row.embedding)
            : row.embedding;
      insertMemory.run(row.id, `内容 ${row.id}`, `内 容 ${row.id}`, `hash-${row.id}`, blob);
      if (row.withMembership !== false) {
        insertMember.run(fineId, row.id);
      }
    }
  } finally {
    db.close();
  }
}

/** 只读查一个计数（**不写库**：夹具断言不该改状态）。 */
function countOf(dbPath: string, sql: string): number {
  const db = openDatabase({ dbPath, readonly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** 库文件指纹（干跑用：必须前后不变）。 */
function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 6 条「好行」：全部有归属、全部有合法向量。 */
function sixGoodRows(): SeedMemory[] {
  return Array.from(
    { length: 6 },
    (_, index): SeedMemory => ({
      id: `m-${String(index)}`,
      embedding: unitVector(index + 1),
    }),
  );
}

describe('parseArgs · 缺参数/非法值一律抛错（不猜、不静默回退）', () => {
  it('缺 --db ⇒ 抛错且回显用法（猜默认路径 = 可能往别人的库里写几百 MB）', () => {
    expect(() => parseArgs([])).toThrowError(/缺 --db/);
    expect(() => parseArgs([])).toThrowError(new RegExp(USAGE.slice(0, 6)));
  });

  it('缺 --db 的另一个形态（只给别的参数）⇒ 同样抛错', () => {
    expect(() => parseArgs(['--batch-size=100'])).toThrowError(/缺 --db/);
  });

  it('★ 空格写法：`--db` 后面紧跟另一个 flag ⇒ 判成「没给值」（这就是那个事故的防线）', () => {
    // 实测过的形状：`--db --dry-run` 在 `argv.indexOf('--db') + 1` 的写法下会把
    // `--dry-run` 当成库路径 ⇒ `resolve('--dry-run')` 变成一个**长得像文件的相对路径**。
    expect(() => parseArgs(['--db', '--dry-run'])).toThrowError(/缺 --db/);
  });

  it('`--db=值` 与 `--db 值` 两种写法都要能解析', () => {
    expect(parseArgs(['--db=ocean.db']).dbPath.endsWith('ocean.db')).toBe(true);
    expect(parseArgs(['--db', 'ocean.db']).dbPath.endsWith('ocean.db')).toBe(true);
  });

  it('--batch-size / --limit 非正整数 ⇒ 抛错（不静默回退到默认值）', () => {
    expect(() => parseArgs(['--db=x.db', '--batch-size=0'])).toThrowError(/batch-size/);
    expect(() => parseArgs(['--db=x.db', '--batch-size=1.5'])).toThrowError(/batch-size/);
    expect(() => parseArgs(['--db=x.db', '--limit=0'])).toThrowError(/limit/);
  });

  it('缺省值：dryRun=false、force=false、batchSize/limit 不设', () => {
    const base = parseArgs(['--db=x.db']);
    expect(base.dryRun).toBe(false);
    expect(base.force).toBe(false);
    expect(base.batchSize).toBeUndefined();
    expect(base.limit).toBeUndefined();
    expect(parseArgs(['--db=x.db', '--dry-run', '--force']).force).toBe(true);
    expect(parseArgs(['--db=x.db', '--batch-size=300', '--limit=7'])).toMatchObject({
      batchSize: 300,
      limit: 7,
    });
  });
});

describe('runBackfill · 正常回填', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = makeDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('★ 6 行全部编码；A6 三表相等；抽样的 `eps` 仍是**真误差**', () => {
    seed(dbPath, sixGoodRows());
    const result = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    expect(result.counters.encoded).toBe(6);
    expect(result.counters.alreadyCoded).toBe(0);
    expect(result.counters.skippedBadEmbedding).toBe(0);
    expect(result.counters.skippedNoMembership).toBe(0);
    expect(result.batches).toBe(1); // 6 行 < SWEEP_BATCH_SIZE ⇒ 一批
    expect(result.a6Passed).toBe(true);
    // ⚠️ 用 `toMatchObject`：A6 快照会随「补上后半句」增加字段（`lonelyCodes` / `fineIdDrift`），
    //   这里要钉的是**这几个数的值**，不是「对象只有这四个键」。
    expect(result.consistency).toMatchObject({
      codes: 6,
      members: 6,
      memories: 6,
      mismatch: 0,
      lonelyCodes: 0,
      fineIdDrift: 0,
    });

    // ★ 抽样校验：`decodeVector()` 还原后，`eps` 必须**仍是** `‖x − x̂‖ + 1e-6`
    //   （A4 的口径；若 `eps` 被写成 `scale·√d/2` 那种最坏界，这里会差 1~2 个数量级）
    const db = openDatabase({ dbPath, readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT m.embedding AS embedding, v.code AS code, v.scale AS scale, v.eps AS eps
             FROM vector_codes v JOIN memories m ON m.id = v.memory_id
            WHERE m.id = 'm-3'`,
        )
        .get() as { embedding: Buffer; code: Buffer; scale: number; eps: number };
      const original = blobToVector(row.embedding);
      const restored = decodeVector(blobToCode(row.code), row.scale);
      expect(restored.length).toBe(DIM);
      let squared = 0;
      for (let index = 0; index < DIM; index += 1) {
        const difference = (original[index] as number) - (restored[index] as number);
        squared += difference * difference;
      }
      // 容差 1e-5：`eps` 是 float64 算出来的，这里也按 float64 复算，只差浮点求和顺序
      expect(Math.abs(row.eps - (Math.sqrt(squared) + 1e-6))).toBeLessThan(1e-5);
      expect(row.code.byteLength).toBe(DIM);
    } finally {
      db.close();
    }
  });

  it('报告里必须有 A6 四行（固定形状，供运维/门禁 grep）', () => {
    seed(dbPath, sixGoodRows());
    const args = { dbPath, dryRun: false, force: false };
    const report = formatReport(runBackfill(args, { onProgress: SILENT }), args);
    expect(report).toContain('A6 codes    = 6');
    expect(report).toContain('A6 members  = 6');
    expect(report).toContain('A6 memories = 6');
    expect(report).toContain('A6 mismatch = 0');
    expect(report).toContain('✓ A6 通过');
  });

  it('★ 幂等：第二次跑 ⇒ encoded = 0、alreadyCoded = 6（码行数不变）', () => {
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    const second = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    expect(second.counters.encoded).toBe(0);
    expect(second.counters.alreadyCoded).toBe(6);
    expect(second.consistency.codes).toBe(6);
    expect(second.a6Passed).toBe(true);
  });

  it('★ 断点续跑：先删掉一半码行再跑 ⇒ 只补那一半（其余记为 alreadyCoded）', () => {
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    // 造「跑到一半被 kill」的中间态：3 行有码、3 行没有
    const db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM vector_codes WHERE memory_id IN ('m-0','m-1','m-2')").run();
    } finally {
      db.close();
    }
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(3);

    const resumed = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    expect(resumed.counters.encoded).toBe(3);
    expect(resumed.counters.alreadyCoded).toBe(3);
    expect(resumed.consistency.codes).toBe(6);
    expect(resumed.a6Passed).toBe(true);
  });

  it('--force：忽略「已编码」跳过逻辑，6 行全部重算覆盖（码值逐位相同）', () => {
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    const before = countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes');

    // 先记下一次编码的 (scale, eps, **code 字节**)，用于断言「重算结果与第一次相同」
    // ⚠️ **必须把 `code` 的字节一起快照**（`hex(code)`）：只比 `scale` / `eps` 是不够的 ——
    //   两个不同的码可以让 `sqrt(Σ(x − q·scale)²) + 1e-6` 恰好同值（只是概率低），
    //   而文件头 ② 那句「重算结果**逐位相同**」讲的正是**码字节**。
    const snapshot = (): string => {
      const db = openDatabase({ dbPath, readonly: true });
      try {
        return JSON.stringify(
          db
            .prepare(
              'SELECT memory_id, scale, eps, hex(code) AS code_hex FROM vector_codes ORDER BY memory_id',
            )
            .all() as unknown[],
        );
      } finally {
        db.close();
      }
    };
    const firstCodes = snapshot();
    // 快照里必须真的有码字节（否则 `hex(code)` 写错成 NULL 时本用例会「恒绿」）
    expect(firstCodes).toContain('code_hex');
    expect(firstCodes.length).toBeGreaterThan(sixGoodRows().length * DIM);

    const forced = runBackfill({ dbPath, dryRun: false, force: true }, { onProgress: SILENT });
    expect(forced.counters.encoded).toBe(6);
    expect(forced.counters.alreadyCoded).toBe(0);
    expect(forced.forced).toBe(true);
    // 行数没涨（`INSERT OR REPLACE` 是替换，不是追加）
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(before);
    expect(snapshot()).toBe(firstCodes);
  });

  it('★ 换桶后 `--force`：码表 `fine_id` 必须**跟着搬**（QA 补：工程师原 21 条里没有这条）', () => {
    // ⚠️ **为什么这条重要**：`vector_codes` 的主键是 `(fine_id, memory_id)`，
    //   而 T04 的两段式读取是「按桶取码」⇒ 码行留在旧桶 ⇒ 那一行**永远取不到**
    //   ⇒ 静默漏召回（A6 的 `mismatch` 只数行数，**查不出这种漂移**）。
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    const MOVED = ['m-0', 'm-1', 'm-2'];
    const newFineId = 'f-2';

    // 模拟「重新分桶」：造第二个细桶，把 3 行的归属搬过去（`embedding` 不动）
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      // ⚠️ **必须用裸 `INSERT`，不能用 `seedBucketModel()`**：后者对 `vector_coarse_cells`
      //   是 `INSERT OR REPLACE` ⇒ REPLACE 会**先删掉 `c-1` 那一行** ⇒
      //   `vector_fine_cells.coarse_id` 上的 `ON DELETE CASCADE` 把 `f-1` 连带删掉 ⇒
      //   再顺着 `f-1` 把**桶归属和码行一起清空**（QA 实测：members 6→0、codes 6→0）。
      //   那是「重训粗中心」的语义，不是「多一个细桶」的语义。
      db.prepare(
        `INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at)
         VALUES (?, 'c-1', ?, 1000)`,
      ).run(newFineId, vectorToBlob(unitVector(999)));
      db.prepare(
        `UPDATE vector_cell_members SET fine_id = ? WHERE memory_id IN (${MOVED.map(() => '?').join(',')})`,
      ).run(newFineId, ...MOVED);
    } finally {
      db.close();
    }

    // 夹具自检：搬完必须仍是「6 行桶归属 / 6 条码」——否则下面测的就不是 `fine_id` 漂移
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_cell_members')).toBe(6);
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(6);
    expect(
      countOf(dbPath, "SELECT count(*) AS n FROM vector_cell_members WHERE fine_id = 'f-2'"),
    ).toBe(MOVED.length);

    const fineIdsOf = (): { memory_id: string; fine_id: string; n: number }[] => {
      const handle = openDatabase({ dbPath, readonly: true });
      try {
        return handle
          .prepare(
            `SELECT memory_id, fine_id, count(*) OVER (PARTITION BY memory_id) AS n
               FROM vector_codes WHERE memory_id IN (${MOVED.map(() => '?').join(',')})
              ORDER BY memory_id`,
          )
          .all(...MOVED) as { memory_id: string; fine_id: string; n: number }[];
      } finally {
        handle.close();
      }
    };

    // ① 换桶之后、`--force` 之前：码表**仍然在旧桶** ⇒ 这就是「漂移」的形状。
    //    ⚠️ 此刻**三表行数仍然相等**（漂移只发生在 `fine_id` 上，行数一行没少）⇒
    //    「只数行数」的 A6 看不见它。这里刻意**只钉计数相等、不钉 `mismatch === 0`**：
    //    设计稿 §6 的 A6 有两句（行数相等 + 换桶后 `fine_id` **集合相等**），
    //    等把后半句补进 `snapshotConsistency()` 之后，本用例不该因此变红。
    for (const row of fineIdsOf()) {
      expect(row.fine_id).toBe('f-1');
      expect(row.n).toBe(1);
    }
    const drifted = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    expect(drifted.consistency.codes).toBe(drifted.consistency.members);
    expect(drifted.consistency.members).toBe(drifted.consistency.memories);

    // ② `--force` 之后：**必须跟着搬**，而且每行**仍然恰好 1 条**（不是「新旧各一条」）
    const forced = runBackfill({ dbPath, dryRun: false, force: true }, { onProgress: SILENT });
    const after = fineIdsOf();
    expect(after).toHaveLength(MOVED.length);
    for (const row of after) {
      expect(row.fine_id).toBe(newFineId);
      expect(row.n).toBe(1);
    }
    // ③ 没被搬的 3 行仍在旧桶（`--force` 不许把所有人都搬到一个桶里）
    expect(countOf(dbPath, "SELECT count(*) AS n FROM vector_codes WHERE fine_id = 'f-1'")).toBe(
      sixGoodRows().length - MOVED.length,
    );
    // ④ 行数不变、A6 仍绿
    expect(forced.consistency.codes).toBe(sixGoodRows().length);
    expect(forced.a6Passed).toBe(true);
  });

  it('--limit=2：只扫描前 2 行，且报告**显式声明** limit 模式', () => {
    seed(dbPath, sixGoodRows());
    const args = { dbPath, dryRun: false, force: false, limit: 2 };
    const result = runBackfill(args, { onProgress: SILENT });
    expect(result.limitMode).toBe(true);
    expect(result.counters.scanned).toBe(2);
    expect(result.counters.encoded).toBe(2);
    expect(result.liveMemoriesTotal).toBe(6);

    const report = formatReport(result, args);
    expect(report).toContain('limit 模式');
    expect(report).toContain('不是');
  });
});

describe('runBackfill · 该跳过的行要跳过、并**计数**', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = makeDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('★ 没有桶归属的行跳过（编了也无法被路由）⇒ skippedNoMembership = 1', () => {
    const rows = sixGoodRows();
    rows.push({ id: 'm-orphan', embedding: unitVector(42), withMembership: false });
    seed(dbPath, rows);

    const result = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    expect(result.counters.encoded).toBe(6);
    expect(result.counters.skippedNoMembership).toBe(1);
    expect(result.consistency.codes).toBe(6);
    // ⚠️ **A6 会红，而且这是对的**：那条孤儿记忆有 embedding 却没有桶归属
    //   ⇒ `memories` 比 `members`/`codes` 多 1 ⇒ 这是**桶表的问题**，不是回填能修的
    expect(result.consistency.mismatch).toBe(1);
    expect(result.a6Passed).toBe(false);
    expect(
      countOf(dbPath, "SELECT count(*) AS n FROM vector_codes WHERE memory_id='m-orphan'"),
    ).toBe(0);
  });

  it('★ 四种坏 embedding 全部跳过并**分类计数**，脚本不崩', () => {
    // ① NULL（合法状态，但编不出码）
    // ② 字节数非 4 的倍数（读不成 float32）
    // ③ 字节数是 4 的倍数但维度 ≠ EMBED_DIM
    // ④ 含 NaN（`encodeVector()` 抛 INVALID_INPUT）
    const nonFinite = unitVector(7);
    nonFinite[5] = Number.NaN;
    const rows: SeedMemory[] = [
      { id: 'ok-0', embedding: unitVector(1) },
      { id: 'ok-1', embedding: unitVector(2) },
      { id: 'bad-null', embedding: null },
      { id: 'bad-bytes', embedding: Buffer.alloc(BYTES - 2, 1) },
      { id: 'bad-dim', embedding: Buffer.alloc(BYTES - 72, 1) }, // 750 维
      { id: 'bad-nan', embedding: nonFinite },
    ];
    // ⚠️ `bad-bytes` 那条（3070 字节）**过不了建库脚本的 CHECK**
    //   （`length(embedding) % 4 = 0`）⇒ 必须关掉 CHECK 才灌得进去，
    //   而这恰好说明这条分支不是「假想防御」：回填面对的是**已经存在的字节**。
    seed(dbPath, rows, { ignoreCheckConstraints: true });

    const result = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    expect(result.counters.encoded).toBe(2);
    expect(result.counters.skippedBadEmbedding).toBe(4);
    expect(result.counters.badEmbedding).toEqual({
      nullEmbedding: 1,
      byteLength: 1,
      dimension: 1,
      nonFinite: 1,
    });
    // 坏行**没有**留下码（不是写了一条垃圾码）
    expect(result.consistency.codes).toBe(2);
    // 报告要把四种原因分开写（只说「跳过 4 行」等于没说）
    const report = formatReport(result, { dbPath, dryRun: false, force: false });
    expect(report).toContain('坏 embedding 明细');
    expect(report).toContain('含 NaN/Inf 1');
  });

  it('干跑的统计口径与真跑一致（跳过项都要数出来）', () => {
    const rows = sixGoodRows();
    rows.push({ id: 'bad-null', embedding: null });
    seed(dbPath, rows);

    const dry = runBackfill({ dbPath, dryRun: true, force: false });
    expect(dry.counters.scanned).toBe(7);
    expect(dry.counters.skippedBadEmbedding).toBe(1);
    expect(dry.wouldWrite).toBe(6);

    const real = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    expect(real.counters.encoded).toBe(dry.wouldWrite);
  });
});

describe('runBackfill · 干跑真的不写库', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = makeDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('★ 库文件 sha256 前后相同，且 wouldWrite 是「会写多少行」', () => {
    seed(dbPath, sixGoodRows());
    const before = sha256Of(dbPath);
    const result = runBackfill({ dbPath, dryRun: true, force: false });
    expect(sha256Of(dbPath)).toBe(before);
    expect(result.wouldWrite).toBe(6);
    expect(result.counters.encoded).toBe(0);
    expect(result.dryRun).toBe(true);
    // 干跑**不建表**也不写码
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(0);
  });

  it('★ 码表不存在 ⇒ 明确报「需要先可写打开补建表」并非零退出（不许静默成功）', () => {
    seed(dbPath, sixGoodRows());
    const db = new Database(dbPath);
    try {
      db.exec('DROP INDEX idx_vcode_memory_unique;');
      db.exec('DROP TABLE vector_codes;');
    } finally {
      db.close();
    }

    expect(() => runBackfill({ dbPath, dryRun: true, force: false })).toThrowError(/补建表/);
    expect(() => runBackfill({ dbPath, dryRun: true, force: false })).toThrowError(/vector_codes/);
    // 而且它**真的没建表**（只读句柄写不进去 ⇒ 报错是唯一出路）
    expect(
      countOf(dbPath, "SELECT count(*) AS n FROM sqlite_master WHERE name='vector_codes'"),
    ).toBe(0);
  });

  it('库文件不存在 ⇒ 抛 NOT_FOUND（不能悄悄建一个空库）', () => {
    const missing = join(tmpdir(), 'gmb-definitely-missing-backfill.db');
    expect(() => runBackfill({ dbPath: missing, dryRun: true, force: false })).toThrowError(
      /库文件不存在/,
    );
    expect(() => runBackfill({ dbPath: missing, dryRun: false, force: false })).toThrowError(
      /库文件不存在/,
    );
  });
});

describe('A6 不一致 ⇒ 非零退出码（走 CLI 薄壳，验的是退出码接线）', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = makeDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** 造「桶表多一行」的夹具：一条 **没有 embedding** 的记忆却有桶归属。 */
  function addExtraMembershipRow(): void {
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                               created_at, last_access, access_count, stability, difficulty,
                               pin_factor, source, deleted, embedding)
         VALUES ('m-novec', 'fact', '没有向量', '没 有 向 量', 'hash-novec', 1000, 1000, 0, 10, 1, 1, 'cli', 0, NULL)`,
      ).run();
      db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
        'f-1',
        'm-novec',
      );
    } finally {
      db.close();
    }
  }

  it('★ members 多一行 ⇒ mismatch = 2、a6Passed = false、报告写「退出码 1」', () => {
    seed(dbPath, sixGoodRows());
    addExtraMembershipRow();

    const args = { dbPath, dryRun: false, force: false };
    const result = runBackfill(args, { onProgress: SILENT });
    // codes 6 / members 7 / memories 6 ⇒ |6−7| + |7−6| = 2
    // ⚠️ 这一行守的是 **`mismatch` 的语义**：它只数行数，`lonelyCodes` / `fineIdDrift`
    //   **不许**混进来（否则历史报告的数会变形 ⇒ 运维以为回填坏了，其实只是换桶了）。
    //   本夹具里 6 条码行都有归属、`fine_id` 也都一致 ⇒ 两个桶归属指标都是 0。
    expect(result.consistency).toMatchObject({
      codes: 6,
      members: 7,
      memories: 6,
      mismatch: 2,
      lonelyCodes: 0,
      fineIdDrift: 0,
    });
    expect(result.a6Passed).toBe(false);
    const report = formatReport(result, args);
    expect(report).toContain('⚠️ A6 不一致');
    expect(report).toContain('退出码 1');
  });

  it('★ CLI 真跑：A6 不一致 ⇒ 进程退出码非 0（接线也得守住）', () => {
    seed(dbPath, sixGoodRows());
    addExtraMembershipRow();

    // ⚠️ 与 `tier-qualifier-audit.test.ts` 同款：`process.execPath --import tsx <脚本>`
    //   ⇒ 这条同时守住「算对了但 main() 忘了设 exitCode」那一类事故。
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'backfill-codes.ts'), `--db=${dbPath}`],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('A6 mismatch = 2');
  });

  it('★ CLI 真跑：一致 ⇒ 退出码 0（否则「绿」这件事本身没有被证明）', () => {
    seed(dbPath, sixGoodRows());
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'backfill-codes.ts'), `--db=${dbPath}`],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✓ A6 通过');
  });

  it('★ 干跑在「A6 不一致」的库上仍必须退出码 0（报告里承诺了「干跑不判 A6」）', () => {
    // ⚠️ **这条守的是一个具体的翻车形状**：main() 里那句
    //   `if (!result.dryRun && !result.a6Passed)` —— 只要有人把 `!result.dryRun` 手滑删掉，
    //   「对一个还没回填的库干跑」就会 exit 1（把「还没回填」误报成「不一致」），
    //   而**现有 21 条里没有任何一条会因此变红**（它们验的都是真跑的退出码）。
    seed(dbPath, sixGoodRows());
    // 先真跑一次把 6 条码填上（否则 `codes = 0`，mismatch 会算出 8，与本用例要的「漂移」不是同一件事）
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    addExtraMembershipRow();
    // 此刻 codes 6 / members 7 / memories 6 ⇒ mismatch = 2（真跑会 exit 1，见上一条用例）
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(6);

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(REPO_ROOT, 'scripts', 'backfill-codes.ts'),
        `--db=${dbPath}`,
        '--dry-run',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).toBe(0);
    // 干跑也要把「现在库里不一致」如实说出来（只是不用它判退出码）
    expect(result.stdout).toContain('A6 mismatch = 2');
    expect(result.stdout).toContain('干跑不判 A6');
    // 而且干跑**真的没修**这个不一致（`--dry-run` 只读打开，一个字都写不进去）
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_cell_members')).toBe(7);
  });
});

/**
 * ★ **A6 的后半句**（回归用：QA R1 打回的那个洞）。
 *
 * 设计稿 §6 的 A6 是**两句话**：
 *   ① 行数口径：`codes` / `members` / `memories` 三数相等；
 *   ② 桶归属口径：换桶之后 `fine_id` 集合仍相等（= 每条码行有归属，且 `fine_id` 与桶表一致）。
 *
 * ⚠️ **为什么这组用例必须存在**：只实现①的时候，`snapshotConsistency()` 会对着一个
 *   「行数一行没少、`fine_id` 全漂移」的库报「通过」并 exit 0 —— 片上有洞的绿比红更危险。
 *   将来 T04 两段式上线后，这批行会被**静默漏召回**，而自检还在说「通过」。
 */
describe('★ A6 后半句 · 桶归属口径（行数相等也可能是假绿）', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = makeDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /**
   * 造第二个细桶，并把若干条记忆的**桶归属**搬过去（**只动 `vector_cell_members`**，
   * 码表一行不动 ⇒ 这就是 QA 用 SQL 改出来的「换桶」状态）。
   *
   * ⚠️ 与 QA 那条用例同款：**必须裸 `INSERT`**，不能用 `seedBucketModel()` —— 后者对
   *   `vector_coarse_cells` 是 `INSERT OR REPLACE` ⇒ 会顺着
   *   `ON DELETE CASCADE` 把 `f-1` 连同归属和码行一起清空（那是「重训粗中心」，不是「多一个细桶」）。
   */
  function moveMembership(ids: readonly string[], newFineId: string): void {
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(
        `INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at)
         VALUES (?, 'c-1', ?, 1000)`,
      ).run(newFineId, vectorToBlob(unitVector(999)));
      db.prepare(
        `UPDATE vector_cell_members SET fine_id = ? WHERE memory_id IN (${ids.map(() => '?').join(',')})`,
      ).run(newFineId, ...ids);
    } finally {
      db.close();
    }
  }

  /** 「一个 memory 在码表里有几行」的分布（`{ 1: 6 }` = 6 个 memory 各 1 行，没有重复）。 */
  function rowsPerMemory(): Record<string, number> {
    const db = openDatabase({ dbPath, readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT n, count(*) AS how_many
             FROM (SELECT count(*) AS n FROM vector_codes GROUP BY memory_id)
            GROUP BY n`,
        )
        .all() as { n: number; how_many: number }[];
      return Object.fromEntries(rows.map((row) => [String(row.n), row.how_many]));
    } finally {
      db.close();
    }
  }

  it('★ fine_id 漂移：三数相等但 fineIdDrift ≠ 0 ⇒ 自检红 + exit 1；`--force` 后归 0 且无重复行', () => {
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    const MOVED = ['m-0', 'm-1', 'm-2'];
    moveMembership(MOVED, 'f-2');

    // ── ① 假绿的形状：**三数仍然相等**（漂移只发生在 `fine_id` 上，一行没少）
    const selfCheckArgs = { dbPath, dryRun: false, force: false };
    const selfCheck = runBackfill(selfCheckArgs, { onProgress: SILENT });
    expect(selfCheck.consistency.codes).toBe(6);
    expect(selfCheck.consistency.members).toBe(6);
    expect(selfCheck.consistency.memories).toBe(6);
    // ⇒ 旧的判定（只看这一句）会在这里放行。这就是 R1 打回的那条缺陷。
    expect(selfCheck.consistency.mismatch).toBe(0);
    // ⇒ A6 的后半句把它抓出来（自检这一趟是**非 force**：已有码行按幂等逻辑跳过 ⇒ 漂移不会被修）
    expect(selfCheck.consistency.fineIdDrift).toBe(MOVED.length);
    expect(selfCheck.consistency.lonelyCodes).toBe(0);
    expect(selfCheck.a6Passed).toBe(false);

    const report = formatReport(selfCheck, selfCheckArgs);
    // 报告里必须有两个桶归属指标的具体数字（门禁按 `A6 <名> = <数>` grep）
    expect(report).toContain(`A6 fineIdDrift = ${String(MOVED.length)}`);
    expect(report).toContain('A6 lonelyCodes = 0');
    // ⚠️ 旧措辞必须消失：那半句（`fine_id` 集合相等）当时**根本没算过**，
    //   「码表 == 桶表」是一句没被验证的话。
    expect(report).not.toContain('码表 == 桶表');
    expect(report).toContain('桶归属口径');
    expect(report).toContain('退出码 1');

    // ── ② 退出码接线：同一条命令（`--db=<库>`，不带 `--force`）改前 exit 0 / 改后 exit 1
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'backfill-codes.ts'), `--db=${dbPath}`],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain(`A6 fineIdDrift = ${String(MOVED.length)}`);

    // ── ③ `--force` 之后：`fine_id` **跟着搬**，且**没有产生重复行**
    const forced = runBackfill({ dbPath, dryRun: false, force: true }, { onProgress: SILENT });
    expect(forced.consistency.fineIdDrift).toBe(0);
    expect(forced.consistency.lonelyCodes).toBe(0);
    expect(forced.consistency.mismatch).toBe(0);
    expect(forced.a6Passed).toBe(true);
    // 「同一 memory 在码表里恒为 1 行」：6 个 memory 各 1 行，**没有** 2 行的
    expect(rowsPerMemory()).toEqual({ 1: 6 });
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(6);
    // 而且搬过去的那 3 行确实在**新桶**（不是「两行都在旧桶」也不是「凭空多出来」）
    expect(countOf(dbPath, "SELECT count(*) AS n FROM vector_codes WHERE fine_id = 'f-2'")).toBe(
      MOVED.length,
    );
    // 改后自检真的绿了（不再是「exit 1 挂着」）
    const afterForce = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    expect(afterForce.a6Passed).toBe(true);
    expect(formatReport(afterForce, selfCheckArgs)).toContain('✓ A6 通过');
  });

  it('★ 有码无归属：三数仍相等但 lonelyCodes = 1 ⇒ a6Passed = false（行数刻意配平）', () => {
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    // 造「码行成了孤儿、同时桶表里多一个没向量的归属」：**行数刻意配平**
    //   memories（有 embedding）= 6，members = 6（5 + 新增的 m-novec），codes = 6（含 m-0）
    // ⇒ `mismatch = 0`，但 m-0 的码行**没有桶归属**（T04 按桶取码永远取不到它）。
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare("DELETE FROM vector_cell_members WHERE memory_id = 'm-0'").run();
      db.prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                               created_at, last_access, access_count, stability, difficulty,
                               pin_factor, source, deleted, embedding)
         VALUES ('m-novec', 'fact', '没有向量', '没 有 向 量', 'hash-novec', 1000, 1000, 0, 10, 1, 1, 'cli', 0, NULL)`,
      ).run();
      db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
        'f-1',
        'm-novec',
      );
    } finally {
      db.close();
    }

    const args = { dbPath, dryRun: false, force: false };
    const selfCheck = runBackfill(args, { onProgress: SILENT });
    expect(selfCheck.consistency.codes).toBe(6);
    expect(selfCheck.consistency.members).toBe(6);
    expect(selfCheck.consistency.memories).toBe(6);
    // 前半句完全「绿」——这就是只用三数相等会漏掉的形状
    expect(selfCheck.consistency.mismatch).toBe(0);
    // 后半句抓到它
    expect(selfCheck.consistency.lonelyCodes).toBe(1);
    expect(selfCheck.consistency.fineIdDrift).toBe(0);
    expect(selfCheck.a6Passed).toBe(false);

    const report = formatReport(selfCheck, args);
    expect(report).toContain('A6 lonelyCodes = 1');
    expect(report).toContain('桶归属口径');
    expect(report).toContain('退出码 1');

    // 退出码也非 0（同一条命令行）
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'backfill-codes.ts'), `--db=${dbPath}`],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain('A6 lonelyCodes = 1');
  });

  it('绿的时候两个口径都要**各自**出现在报告里（不许再说一句没被验证的话）', () => {
    seed(dbPath, sixGoodRows());
    const args = { dbPath, dryRun: false, force: false };
    const report = formatReport(runBackfill(args, { onProgress: SILENT }), args);

    expect(report).toContain('✓ A6 通过');
    // 两个口径分开陈述，且各自带着**具体数字**
    expect(report).toContain('行数口径');
    expect(report).toContain('桶归属口径');
    expect(report).toContain('A6 lonelyCodes = 0');
    expect(report).toContain('A6 fineIdDrift = 0');
    // ⚠️ 「==」只许用在**真的算过**的关系上：三数相等（由 `mismatch = 0` 支撑）可以，
    //   「码表 == 桶表」这种「看起来像检查、其实没算」的措辞不许再出现。
    expect(report).not.toContain('码表 == 桶表');
  });
});

/**
 * ★ **R11 · A6 的「活记忆域」口径**（2026-11-05 裁决；规格 `perf-c2-admissible-two-stage.md` §7 的 R11 行）
 *
 * ## 这一组要钉死的事
 *
 * A6 的三个数**必须同域**。改前它们各说各话：
 * ```
 * codes    = count(vector_codes)                                       ← 只有活行（回填只扫活行）
 * members  = count(vector_cell_members)                                ← ★ 含软删行的归属
 * memories = count(memories WHERE deleted = 0 AND embedding NOT NULL)  ← 只有活行
 * ```
 * ⇒ 只要库里有 ≥1 条「软删 + 有向量 + 有桶归属」的记忆（**这是既有裁决**：
 *   `forget.ts` 只改 `deleted = 1`、**不调** `unassignBucket`），`members > codes`
 *   ⇒ `mismatch ≠ 0` ⇒ **A6 恒红，且红得没有信息量**（它报的是「软删机制在工作」）。
 *
 * ## 三条用例（少一条都不成立）
 *
 * | # | 夹具 | 期望 | 少它会怎样 |
 * |---|---|---|---|
 * | ① | 软删行**保留**桶归属且有码 | A6 **绿**（三数相等、`mismatch = 0`） | 「修好了没有」不可证 |
 * | ② | 该软删行的 `fine_id` 被人为改乱 | A6 **仍然绿**（**刻意**：它在活记忆域外） | 口径会被放宽成「查不出任何东西」也没人发现 |
 * | ③ | **活行**里造漂移 | A6 **仍然红** | ②的理由会被误读成「A6 不查漂移了」 |
 *
 * ⚠️ **② 为什么是「刻意」**：软删行的「码 ↔ 归属」对不上，是 `restore()` 那条路的事
 *   （它要不要恢复向量路、恢复时归属怎么定），**不是** T05 的漏。
 *   把它算进 A6 ⇒ 运维会被一条**永远修不掉**的红追着跑（除非去删软删行的归属 —— 而那会
 *   让「软删可恢复」这条语义破掉，正是 §9.3.2 ② 明令禁止的做法）。
 * ⇒ 所以口径是：**A6 只在活记忆域内判定**；软删行的漂移由 `restore()` 的用例守。
 */
describe('★ R11 · A6 的活记忆域口径（软删行不该让 A6 恒红）', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = makeDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /**
   * 往库里塞一条**带向量 + 带桶归属**的记忆（`deleted` 可指定）。
   *
   * ⚠️ 不复用 `seed()`：它会重建桶模型（`INSERT OR REPLACE vector_coarse_cells`），
   *   而 `ON DELETE CASCADE` 会把已有的 `f-1` 连同归属和码行一起清空（R10 的形状）。
   */
  function addMemoryRow(
    id: string,
    options: { deleted?: boolean; fineId?: string; lastAccess?: number } = {},
  ): void {
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      const deleted = options.deleted === true ? 1 : 0;
      db.prepare(
        `INSERT INTO memories (id, kind, content, content_tokens, content_hash,
                               created_at, last_access, access_count, stability, difficulty,
                               pin_factor, source, deleted, deleted_at, embedding)
         VALUES (?, 'fact', ?, ?, ?, 1000, ?, 0, 10, 1, 1, 'cli', ?, ?, ?)`,
      ).run(
        id,
        `内容 ${id}`,
        `内 容 ${id}`,
        `hash-${id}`,
        options.lastAccess ?? 1000,
        deleted,
        deleted === 1 ? 1000 : null,
        vectorToBlob(unitVector(id.length + 7)),
      );
      db.prepare('INSERT INTO vector_cell_members (fine_id, memory_id) VALUES (?, ?)').run(
        options.fineId ?? 'f-1',
        id,
      );
    } finally {
      db.close();
    }
  }

  /** 造第二个细桶（`f-2`），并把若干条记忆的**桶归属**搬过去（码表一行不动）。 */
  function moveMembershipToNewBucket(ids: readonly string[], newFineId: string): void {
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(
        `INSERT INTO vector_fine_cells (fine_id, coarse_id, centroid, updated_at)
         VALUES (?, 'c-1', ?, 1000)`,
      ).run(newFineId, vectorToBlob(unitVector(999)));
      db.prepare(
        `UPDATE vector_cell_members SET fine_id = ? WHERE memory_id IN (${ids.map(() => '?').join(',')})`,
      ).run(newFineId, ...ids);
    } finally {
      db.close();
    }
  }

  /** 直接把一条记忆标成软删（**只改 `deleted`**，与 `forget.ts` 的形状一致）。 */
  function softDelete(ids: readonly string[]): void {
    const db = new Database(dbPath);
    try {
      db.prepare(
        `UPDATE memories SET deleted = 1, deleted_at = 1000 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).run(...ids);
    } finally {
      db.close();
    }
  }

  /** 库里**物理上**有多少条「码与归属的 `fine_id` 不一致」（不区分活/死）。 */
  function physicalDriftRows(): number {
    return countOf(
      dbPath,
      `SELECT count(*) AS n
         FROM vector_codes vc
         JOIN vector_cell_members vcm ON vcm.memory_id = vc.memory_id
        WHERE vc.fine_id <> vcm.fine_id`,
    );
  }

  it('① 软删但**保留桶归属且有码** ⇒ A6 三数相等、`mismatch = 0`（改前这里恒红）', () => {
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    // 造「软删 + 保留归属 + 有码」的那一行：**先活着写进去（于是有码），再软删**
    addMemoryRow('m-gone');
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    expect(
      countOf(dbPath, "SELECT count(*) AS n FROM vector_codes WHERE memory_id = 'm-gone'"),
    ).toBe(1);
    softDelete(['m-gone']);

    // 前置：**物理上**桶表比码表多一行（软删的归属还在）—— 这正是 R11 的成因
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_cell_members')).toBe(7);
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(7);
    expect(
      countOf(
        dbPath,
        'SELECT count(*) AS n FROM memories WHERE deleted = 0 AND embedding IS NOT NULL',
      ),
    ).toBe(6);

    const selfCheck = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    // ★ 三数**同域**（活记忆域）⇒ 都等于 6
    expect(selfCheck.consistency).toMatchObject({
      codes: 6,
      members: 6,
      memories: 6,
      mismatch: 0,
      lonelyCodes: 0,
      fineIdDrift: 0,
    });
    expect(selfCheck.a6Passed).toBe(true);
    expect(formatReport(selfCheck, { dbPath, dryRun: false, force: false })).toContain('✓ A6 通过');

    // ⚠️ **数据一行没删**（我们改的是**读数口径**，不是数据 —— 改数据会让「软删可恢复」破掉）
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_cell_members')).toBe(7);
    expect(countOf(dbPath, 'SELECT count(*) AS n FROM vector_codes')).toBe(7);
  });

  it('② 该软删行的 `fine_id` 被人为改乱 ⇒ A6 **仍然绿**（**刻意**：它在活记忆域外）', () => {
    seed(dbPath, sixGoodRows());
    addMemoryRow('m-gone');
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    // ① 先软删，② 再把它的**归属**搬到 f-2（码行留在 f-1 ⇒ 物理上是「漂移」）
    softDelete(['m-gone']);
    moveMembershipToNewBucket(['m-gone'], 'f-2');

    // 前置：物理上确实存在 1 条漂移行（不区分活/死）
    expect(physicalDriftRows()).toBe(1);

    const selfCheck = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    // ★★ **刻意**：A6 判的是「**活**记忆的码表与桶表对不对齐」。
    //   这条软删行的归属要不要留、要不要跟着码搬，是 `restore()` 的语义问题
    //   （恢复时它会被重新 `assignBucket`），**不是** T05 的漏。
    //   ⇒ 把它算进 A6 ⇒ 运维被一条**永远修不掉**的红追着跑
    //     （除非去删软删行的归属 —— 而那是 §9.3.2 ② 明令禁止的做法）。
    expect(selfCheck.consistency.mismatch).toBe(0);
    expect(selfCheck.consistency.fineIdDrift).toBe(0);
    expect(selfCheck.consistency.lonelyCodes).toBe(0);
    expect(selfCheck.a6Passed).toBe(true);
    // 负控：**物理漂移仍然在**（上一条绿不是「把漂移修掉了」）
    expect(physicalDriftRows()).toBe(1);
  });

  it('③ 活行里造漂移 ⇒ **仍然红**（防止 ② 的口径被放宽成「什么都查不出」）', () => {
    seed(dbPath, sixGoodRows());
    runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });

    // 只动**活行**的归属（码行留在旧桶 ⇒ 漂移）
    moveMembershipToNewBucket(['m-1', 'm-2'], 'f-2');

    const selfCheck = runBackfill({ dbPath, dryRun: false, force: false }, { onProgress: SILENT });
    expect(selfCheck.consistency.codes).toBe(6);
    expect(selfCheck.consistency.members).toBe(6);
    expect(selfCheck.consistency.memories).toBe(6);
    // 行数完全相等（漂移只在 `fine_id` 上）—— 这就是「只数行数」会漏的形状
    expect(selfCheck.consistency.mismatch).toBe(0);
    expect(selfCheck.consistency.fineIdDrift).toBe(2);
    expect(selfCheck.a6Passed).toBe(false);

    // 退出码也非 0（同一条命令行）
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'backfill-codes.ts'), `--db=${dbPath}`],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain('A6 fineIdDrift = 2');
  });
});
