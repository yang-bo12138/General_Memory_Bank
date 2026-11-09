/**
 * `docs/handover/T07-ordered-backlog.md` 的**待办 ⇔ 实现存在性**对账守卫。
 *
 * ⚠️ ★★★ **这个守卫治的是哪个病（★ 本轮一次查出 3 条过期登记）**：
 *   阶段 1 复核时发现：backlog 里标着「📌 已登记为待办」的 **P3-c″**，
 *   其内容是「前缀/后缀截断**无守卫**」⇒ ⇒ **而事实是「判据已升级为逐字节等长比较
 *   ＋ 负控 F 真打红」** ⇒ ⇒ ★ **三个要素全部过期**。
 *   ⇒ ⇒ 而这种过期**没有任何机器会发现** ⇒ ⇒ 因为
 *   · **文档侧**没人改它（人只记得改代码、不记得改索引）；
 *   · **代码侧**确实有守卫（⇒ 守卫自己的自测是绿的）。
 *   ⇒ ⇒ ★ **⇒ 单向漂移** ⇒ ⇒ ⇒ **「守卫有牙」不等于「台账是真的」**
 *   ⇒ ⇒ ⇒ **⇒ 这就是本守卫要补的那条腿**。
 *
 * ⚠️ ★★ **为什么不能靠「人维护一张『待办 ↔ 实现文件』对照表」**：
 *   那张表本身**就是第二个真相源** ⇒ ⇒ 它也会漂 ⇒ ⇒ 本仓库治过这个病
 *   （手写的 `.d.mts` 声明被删，就是为了消灭它）⇒ ⇒ **所以本守卫的判据必须是
 *   「登记在 backlog 里、且机器能验的那个东西」** ⇒ ⇒ 即：**实现文件的路径**。
 *
 * ⚠️ ★★ **判据分两条（★ 都是可机械判定、不需要人维护对照表）**：
 *   ① **登记完整性**：每一条标着「待办 / 未开始」状态的条目 ⇒
 *      **必须**在同一行的说明里登记它对应的**实现路径**
 *      （形如 `scripts/…` 或 `tests/…`）**或**显式声明「本条无实现路径」并给出理由
 *      ⇒ ⇒ 缺失 ⇒ 判红（**防止下一个待办又变成没人销账的条目**）；
 *   ② **登记真实性**：登记了路径的 ⇒ **该路径必须真实存在**
 *      ⇒ ⇒ 不存在 ⇒ 判红（**这就是能抓出「文档说有、其实没有」的那条**）。
 *
 * ⚠️ ★★★ **为什么【已解决 / 已提交】的条目【不参与】判据**：
 *   它们的状态字段已经声明了完成 ⇒ ⇒ 判据是「**待办**条目不许失联」
 *   ⇒ ⇒ **不是**「完成条目必须逐条核对」⇒ ⇒ **后者会把台账变成一个无法维护的大工程**
 *   ⇒ ⇒ ⇒ **判据只覆盖「还欠着的」那部分** ⇒ ⇒ 这是它能长期活下来的前提。
 *
 * ⚠️ ★ **为什么这是【链外】守卫**：
 *   它守的是**台账与代码的对应关系**、不是代码本身 ⇒ ⇒
 *   ⇒ 而它要读 backlog ⇒ ⇒ 一旦 backlog 改版（表头变了 / 状态词换了）本守卫会误报
 *   ⇒ ⇒ ⇒ **挂进 `verify` 链 = 给 CI 埋雷** ⇒ ⇒ ⇒ 保持链外、手动跑。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BACKLOG_PATH = join(REPO_ROOT, 'docs/handover/T07-ordered-backlog.md');

/** 状态字段里表示「**还欠着**」的标记（★ 只覆盖这些 ⇒ 已解决 / 已提交的条目不参与判据）。 */
const PENDING_STATUS_MARKERS: readonly string[] = ['⏸', '📌', '⏳'];

/** 状态字段里表示「**已经还清了**」的标记（★ 用于把「已解决但漏了实现登记」的条目排除掉）。 */
const DONE_STATUS_MARKERS: readonly string[] = ['✅'];

/** ★ **登记了「本条无实现路径」的写法**（★ 显式声明 ⇒ 不算漏登记）。 */
const NO_IMPL_MARKER = '本条无实现路径';

/** 一条对账结果。 */
export interface LedgerFinding {
  /** 行号（1 起）。 */
  line: number;
  /** 事项名。 */
  item: string;
  /** 哪条判据。 */
  rule: '登记完整性' | '登记真实性';
  /** 说明。 */
  detail: string;
}

/** 一条 backlog 表行拆出来的字段。 */
interface BacklogRow {
  line: number;
  item: string;
  status: string;
  detail: string;
}

/**
 * ★ **抽出 backlog「施工日志」表里的数据行**。
 *
 * ⚠️ ★ **为什么按「表行形状」抽、而不是按「事项编号」抽**：
 *   编号（`P3-c` / `P0-a` …）会随排序变化 ⇒ ⇒ 按编号抽 = 把台账结构也钉死
 *   ⇒ ⇒ **按表格形状抽（`| 序号 | 事项 | 状态 | 说明 |`）** ⇒ ⇒ 顺序可以变、编号可以变
 *   ⇒ ⇒ ⇒ **判据只依赖「这是一条待办条目」这个事实** ⇒ ⇒ 不会随台账演进而误报。
 *
 * @param source backlog 全文
 * @returns 数据行列表
 */
export function extractBacklogRows(source: string): readonly BacklogRow[] {
  const rows: BacklogRow[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trimStart().startsWith('|')) {
      continue;
    }
    const cells = line.split('|');
    // ⚠️ ★ 一行至少要有 4 个单元格（`|` 分段 ⇒ 首尾各有一个空段）。
    if (cells.length < 5) {
      continue;
    }
    const item = (cells[2] ?? '').trim();
    const status = (cells[3] ?? '').trim();
    const detail = (cells[4] ?? '').trim();
    if (item === '' || status === '') {
      continue;
    }
    rows.push({ line: index + 1, item, status, detail });
  }
  return rows;
}

/**
 * ★ **从说明里抽出登记的实现路径**（★ 只认 `scripts/…` 与 `tests/…` ⇒ 那是守卫能验的地方）。
 *
 * @param detail 说明列
 * @returns 路径列表（★ 可能为空 ⇒ 那是「没登记」）
 */
export function extractRegisteredPaths(detail: string): readonly string[] {
  const matches = detail.match(/(?:scripts|tests)\/[A-Za-z0-9_\-./]+\.(?:ts|tsx)/g);
  return matches === null ? [] : [...new Set(matches)];
}

/**
 * ★ **判定：这条待办条目登记得对不对**。
 *
 * @param root 仓库根（用来验路径是否真实存在）
 * @param source backlog 全文
 * @returns 发现的问题（★ 空数组 ⇒ 全部对得上）
 */
export function auditBacklogLedger(root: string, source: string): readonly LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  for (const row of extractBacklogRows(source)) {
    // ★ **只管「还欠着的」**：状态里有 ⏸ / 📌 / ⏳，且**没有** ✅（⇒ 已解决的排除掉）。
    const isPending = PENDING_STATUS_MARKERS.some((marker) => row.status.includes(marker));
    const isDone = DONE_STATUS_MARKERS.some((marker) => row.status.includes(marker));
    if (!isPending || isDone) {
      continue;
    }

    const paths = extractRegisteredPaths(row.detail);
    if (paths.length === 0) {
      // ① 登记完整性：显式声明「本条无实现路径」⇒ 放行（★ 但必须真的声明了）。
      if (row.detail.includes(NO_IMPL_MARKER)) {
        continue;
      }
      findings.push({
        line: row.line,
        item: row.item,
        rule: '登记完整性',
        detail: `待办条目未登记实现路径（也没有显式声明「${NO_IMPL_MARKER}」）`,
      });
      continue;
    }

    // ② 登记真实性：登记的路径必须真实存在。
    for (const path of paths) {
      if (!existsSync(join(root, path))) {
        findings.push({
          line: row.line,
          item: row.item,
          rule: '登记真实性',
          detail: `登记的实现路径不存在：${path}`,
        });
      }
    }
  }
  return findings;
}

/** 跑一次并渲染报告。 */
export function renderLedgerReport(root: string, source: string): string {
  const findings = auditBacklogLedger(root, source);
  const lines: string[] = [];
  lines.push('backlog 待办 ⇔ 实现存在性 · 对账');
  lines.push('');
  if (findings.length === 0) {
    lines.push('✓ 每条待办条目都登记了实现路径（或显式声明「本条无实现路径」）');
    lines.push('✓ 登记的路径全部真实存在');
    return lines.join('\n');
  }
  lines.push(`✗ 发现 ${findings.length} 处问题：`);
  for (const finding of findings) {
    lines.push(
      `  · [${finding.rule}] ${finding.item}（第 ${finding.line} 行）—— ${finding.detail}`,
    );
  }
  return lines.join('\n');
}

/**
 * ★★★ **自测**（★ 照搬仓库其它守卫的形态：正控 + 反向对照 + 负控 + 「根因断言有牙」）。
 *
 * ⚠️ ★ **为什么必须自带自测**：本守卫守的是**台账** ⇒ ⇒ 若它自己恒绿
 *   ⇒ ⇒ 「台账失联」这件事会被放过 ⇒ ⇒ **那它就等于没有**。
 *
 * @returns 自测结果（★ 空数组 ⇒ 全过）
 */
export function runSelfTest(): readonly string[] {
  const failures: string[] = [];

  // ── 正控：一份「登记齐全、路径真实」的台账 ⇒ 必须零发现 ──
  // ⚠️ ★ **路径必须真实存在**（★ 夹具本身就要过「登记真实性」那条判据
  //   ⇒ ⇒ **不许**在这里放一个编出来的路径 ⇒ ⇒ 那会让正控自己被判红）
  const good = [
    '| 1 | 某事项 | ⏸ 待办 | ★ 实现：`scripts/check-backlog-ledger.ts` |',
    '| 2 | 某事项 | ⏸ 待办 | ★ **本条无实现路径**（★ 理由：尚未开工）|',
    '| 3 | 某事项 | ✅ **已完成** | — |',
  ].join('\n');
  const goodFindings = auditBacklogLedger(REPO_ROOT, good);
  if (goodFindings.length !== 0) {
    failures.push(`正控：登记齐全的台账应零发现，实际 ${goodFindings.length} 处`);
  }

  // ── 反向对照：一条**已解决**的条目即使没登记实现路径 ⇒ 也必须【不】判红
  //   （★ 判据只覆盖「还欠着的」⇒ ⇒ 已解决的条目不参与 ⇒ ⇒ 这是它能长期活下来的前提）
  const doneRow = '| 1 | 某事项 | ✅ **已完成** | — |';
  if (auditBacklogLedger(REPO_ROOT, doneRow).length !== 0) {
    failures.push('反向对照：已解决的条目不应被判红');
  }

  // ── 负控 ①：登记了【不存在的路径】⇒ 必须被抓 ──
  const missingPath = '| 1 | 某事项 | ⏸ 待办 | ★ 实现：`scripts/definitely-not-here.ts` |';
  const missingFindings = auditBacklogLedger(REPO_ROOT, missingPath);
  if (!missingFindings.some((finding) => finding.rule === '登记真实性')) {
    failures.push('负控 ①：登记了不存在的路径必须被抓');
  }

  // ── 负控 ②：既没登记路径、也没声明「本条无实现路径」⇒ 必须被抓 ──
  const noRegistration = '| 1 | 某事项 | ⏸ 待办 | — |';
  const noRegFindings = auditBacklogLedger(REPO_ROOT, noRegistration);
  if (!noRegFindings.some((finding) => finding.rule === '登记完整性')) {
    failures.push('负控 ②：漏登记必须被抓');
  }

  // ── 负控 ③：★ **根因断言有牙** —— 判定必须真的被「内容」驱动 ──
  //   （★ 改一个字符 ⇒ 判定必须改变 ⇒ ⇒ 证明它不是恒绿）
  const before = auditBacklogLedger(REPO_ROOT, noRegistration).length;
  const after = auditBacklogLedger(
    REPO_ROOT,
    '| 1 | 某事项 | ⏸ 待办 | ★ **本条无实现路径** |',
  ).length;
  if (before === after) {
    failures.push('根因断言有牙：判定必须被内容驱动（改声明 ⇒ 判定必须改变）');
  }

  return failures;
}

/** CLI 入口。 */
function main(): void {
  // ★ `--self-test` ⇒ 只跑自测（★ 照搬仓库其它守卫的形态）。
  if (process.argv.includes('--self-test')) {
    const failures = runSelfTest();
    if (failures.length === 0) {
      process.stdout.write('✓ 自测全过 ⇒ 这条守卫**不是恒绿守卫**\n');
      process.exitCode = 0;
      return;
    }
    process.stdout.write(`✗ 自测失败 ${failures.length} 项：\n`);
    for (const failure of failures) {
      process.stdout.write(`  · ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const source = readFileSync(BACKLOG_PATH, 'utf8');
  const findings = auditBacklogLedger(REPO_ROOT, source);
  process.stdout.write(`${renderLedgerReport(REPO_ROOT, source)}\n`);
  process.exitCode = findings.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('check-backlog-ledger.ts') === true) {
  main();
}
