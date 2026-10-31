/**
 * 「源码实发 ⊆ 白名单」守卫的单测 —— `scripts/check-contract-ids.ts` 的源码层守卫。
 *
 * ⚠️ **这条守卫补的是一个「三方比对看不见」的方向**（实测漏洞）：
 *   既有门禁做**三方互相比对**（写死的期望 ↔ 代码常量 ↔ 设计稿表格）
 *   ⇒ 它们保证「白名单与文档一致」，却**从不检查「源码里实际发出的 warning code 集合」**
 *   ⇒ **新加一个 warning code 而忘了登记白名单 ⇒ 门禁全绿**。
 *   实测：`src/store/write.ts` 已经有两个 warning code，而三处白名单都还只有
 *   `ALIAS_CONFLICT` ⇒ `pnpm run verify` **EXIT=0**。
 *
 * ★ **断言纪律**：负控**喂假源码文本**，**不改 `src/store/write.ts`**
 *   （那是源码，不是测试的靶子）⇒ 守卫既可测，又不污染源码。
 *   这是它能不能被信任的关键。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkMemoryErrorCodesClosed,
  checkSourceContracts,
  checkWarningCodesRegistered,
  findEmittedWarningCodes,
  findUnknownMemoryErrorCodes,
  findUnregisteredWarningCodes,
} from '../../scripts/check-contract-ids.js';
import { MemoryErrorCode, WARNING_ONLY_CASES } from '../../src/core/errors.js';

/** 错误码的封闭集合（§11.2 的五个 code）。 */
const CLOSED_SET = Object.values(MemoryErrorCode);

/** 列出 `src/` 下的源文件（排除测试文件）。 */
function listSourceFiles(root: string = resolve(process.cwd(), 'src')): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

describe('源码实发 ⊆ 白名单 · warning code 登记守卫', () => {
  it('★ 负控：塞一个未登记的 code ⇒ 守卫报红并指名是哪一个', () => {
    const fakeSource = `
      export function pushWarning(warnings: Warning[]): void {
        warnings.push({ code: 'ALIAS_NOT_REGISTERED' });
      }
    `;
    const unregistered = findUnregisteredWarningCodes(fakeSource, ['ALIAS_CONFLICT']);
    expect(unregistered).toEqual(['ALIAS_NOT_REGISTERED']);

    const diffs = checkWarningCodesRegistered(fakeSource, ['ALIAS_CONFLICT']);
    expect(diffs.length).toBeGreaterThan(0);
    // 性质：报错要**指名**那个 code（否则调用方还得自己去猜是哪个）
    expect(diffs[0]?.reason).toContain('ALIAS_NOT_REGISTERED');
    expect(diffs[0]?.reason).toContain('白名单');
  });

  it('★ 负控（整条链路）：`checkSourceContracts` 对假源码报红 ⇒ 守卫真的接在门禁上', () => {
    const diffs = checkSourceContracts(
      [{ file: 'fake.ts', source: "warnings.push({ code: 'ALIAS_NOT_REGISTERED' });" }],
      ['ALIAS_CONFLICT'],
      CLOSED_SET,
    );
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.map((diff) => diff.reason).join('\n')).toContain('ALIAS_NOT_REGISTERED');
    // ⚠️ 反例：若守卫没接在链路里（函数写了但没人调）⇒ 上面的断言会失败
    //   ⇒ 这条是「接线」本身的守卫。
  });

  it('★ 注释里出现的 code **不算实发**（否则源码注释里的举例会被误报）', () => {
    const commented = `
      // ⚠️ 这里回一条 \`ALIAS_COMMENT_ONLY\`（注释里的举例，不是实发）。
      /* 块注释里也提一句：code: 'ALIAS_BLOCK_COMMENT_ONLY' */
      export const x = 1;
    `;
    expect(findEmittedWarningCodes(commented)).toEqual([]);
    expect(findUnregisteredWarningCodes(commented, [])).toEqual([]);
    // ⚠️ 反例：若剥注释坏掉（注释被当代码读）⇒ 上面会得到两个 code ⇒ 变红。
  });

  it("★ 判据是「`code: 'XXX'` 这个形状」，不是「文件里出现过这个字符串」", () => {
    const mentioned = `
      /** 见 \`ALIAS_MENTIONED_ONLY\` 的说明。 */
      export const note = 'ALIAS_MENTIONED_ONLY';
      export function f(): void {}
    `;
    expect(findEmittedWarningCodes(mentioned)).toEqual([]);
    // ⚠️ 反例：若判据写成「出现过这个字符串」⇒ 上面的数组会非空 ⇒ 变红。
  });

  it('★ 已登记的 code 不算未登记（守卫是「⊆」不是「=」）', () => {
    const source = "warnings.push({ code: 'ALIAS_CONFLICT' });";
    expect(findUnregisteredWarningCodes(source, WARNING_ONLY_CASES)).toEqual([]);
    expect(findUnregisteredWarningCodes(source, ['ALIAS_CONFLICT'])).toEqual([]);
  });

  it('★ 白名单里有「暂时没实发」的 code 也不报错（方向是「实发 ⊆ 白名单」）', () => {
    const source = "warnings.push({ code: 'ALIAS_CONFLICT' });";
    expect(
      findUnregisteredWarningCodes(source, [...WARNING_ONLY_CASES, 'ALIAS_NOT_EMITTED_YET']),
    ).toEqual([]);
  });

  it('★ 真实仓库的源码层守卫：唯一的红只能是「warning code 没登记」', () => {
    const sources = listSourceFiles().map((file) => ({
      file,
      source: readFileSync(file, 'utf8'),
    }));
    const diffs = checkSourceContracts(sources, WARNING_ONLY_CASES, CLOSED_SET);

    // 性质：错误码封闭集合那一半**当前必须是干净的**
    //   （`new MemoryError(...)` 的 code 全部落在五个 code 内）。
    const errorDiffs = diffs.filter((diff) => diff.reason.includes('封闭集合'));
    expect(errorDiffs).toEqual([]);

    // 性质：剩下若有红，只能是「warning code 没登记」这一类
    //   （架构师把 \`ALIAS_TARGET_NOT_LINKED\` 登记进白名单后，这里会变成**零红**）。
    for (const diff of diffs) {
      expect(diff.reason).toContain('warning code');
    }
  });
});

describe('源码实发 ⊆ 白名单 · 错误码封闭集合守卫', () => {
  it("★ 负控：`new MemoryError('NEW_CODE', …)` ⇒ 报红并指名", () => {
    const fake = "throw new MemoryError('BRAND_NEW_CODE', 'x');";
    expect(findUnknownMemoryErrorCodes(fake, CLOSED_SET)).toEqual(['BRAND_NEW_CODE']);

    const diffs = checkMemoryErrorCodesClosed([{ file: 'fake.ts', source: fake }], CLOSED_SET);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs[0]?.reason).toContain('BRAND_NEW_CODE');
    expect(diffs[0]?.reason).toContain('fake.ts');
  });

  it('★ 封闭集合内的写法全部合规（`MemoryErrorCode.X` 与字面量两种形状）', () => {
    const source = `
      throw new MemoryError(MemoryErrorCode.CONFLICT, 'x');
      throw new MemoryError('NOT_FOUND', 'x');
    `;
    expect(findUnknownMemoryErrorCodes(source, CLOSED_SET)).toEqual([]);
  });

  it('★ 动态实参判不了 ⇒ 跳过（不误报）', () => {
    const source = 'throw new MemoryError(someCode, "x");';
    expect(findUnknownMemoryErrorCodes(source, CLOSED_SET)).toEqual([]);
    // ⚠️ 说明：动态实参**判不了**（只能靠人看）⇒ 本守卫只覆盖**字面量**形状。
  });
});
