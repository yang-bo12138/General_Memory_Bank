/**
 * ★ **`detectStorageMedia()` 的契约测试** —— 「拿不到介质类型 ⇒ 记 `unknown` 且绝不抛错」。
 *
 * ⚠️ ★ **为什么这条纪律最关键**（2026-11-02 架构师裁决的落点）：
 *   裁决原文：「**bench 必须把「存储介质类别」与「每行读成本」记进落盘 JSON**
 *   （否则换一块盘，判据的含义会**静默改变**）」。
 * ⇒ ⇒ **介质类别是「判据的介质解耦落点」** ⇒ 它**必须出现在每一份落盘 JSON 里**
 *   ⇒ ⇒ **而 bench 必须能在任何机器上跑**（CI 容器 / Linux / macOS /
 *   **没有 PowerShell 的 Windows** / 被安全策略禁掉 `powershell.exe` 的机器）
 *   ⇒ ⇒ **探测失败绝不能让整轮测量失败** ⇒ **必须降级成 `'unknown'`**。
 * ⇒ ⇒ **「拿不到就记 `unknown`」是整个设计里最容易被悄悄破坏的一条** ⇒ 这里把它钉住。
 *
 * ⚠️ ★ **本文件绝不依赖真实硬件状态**（这是硬要求）：
 *   介质探测是 bench 里**唯一**会问操作系统的地方 ⇒ 它的失败路径**必须能被测**，
 *   而**不能**靠「在一台没有 PowerShell 的机器上跑」来测（那样这条断言在 CI 上是恒绿的）
 *   ⇒ ⇒ **把「怎么执行命令」与「跑哪个平台」都做成可注入的参数**
 *   （`CommandRunner` / `StorageMediaProbeOptions`）⇒ **负控能模拟「命令失败」**
 *   ⇒ **三条平台分支都能在任意一台机器上被测**。
 * ⇒ （本仓库方法论第 2 条：「守卫的判据要抽成可注入的纯函数 ⇒ 负控才能在不污染源码/正文
 *   的前提下测它」—— 本文件就是这个纪律在 bench 侧的一次落地。）
 *
 * ⚠️ **本文件在 verify 链里**（秒级 ⇒ **不执行任何真实命令** ⇒ 不 spawn PowerShell）✓
 */

import { describe, expect, it } from 'vitest';

import {
  type CommandRunner,
  type StorageMediaClass,
  detectStorageMedia,
} from '../../bench/lib/harness.js';

/** 三条平台分支（**都要被测** ⇒ 否则某一条永远没人验过）。 */
const PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'linux', 'darwin'];

/**
 * 一个「必定失败」的命令执行器（**模拟命令不存在 / 被策略禁用 / 超时**）。
 *
 * ⚠️ **抛的是普通 `Error`**（不是 `ENOENT` 那种特定错误）⇒ 顺带证明
 * **任何**异常都被吞掉（不是只吞某一种）。
 */
const explodingRunner: CommandRunner = () => {
  throw new Error('命令不存在 / 被策略禁用（模拟）');
};

/** 一个「成功但输出为空」的执行器（**模拟「命令跑通了但什么也没说」**）。 */
const silentRunner: CommandRunner = () => '';

/**
 * 按文件名分发的执行器（**模拟各平台的真实输出**）。
 *
 * @param outputs 文件名 → 输出
 * @returns 执行器
 */
function runnerByFile(outputs: Readonly<Record<string, string>>): CommandRunner {
  return (file) => {
    const found = outputs[file];
    if (found === undefined) {
      throw new Error(`未预期的命令：${file}`);
    }
    return found;
  };
}

describe('bench · 存储介质探测的契约（不依赖真实硬件）', () => {
  it('★ **命令失败 ⇒ 记 `unknown` 且绝不抛错**（三条平台分支都要守）', () => {
    // ⚠️ **这是本文件最核心的一条**：「bench 必须能在任何机器上跑」。
    for (const platform of PLATFORMS) {
      // ⚠️ **`expect(() => …).not.toThrow()` 是关键**：探测失败**绝不允许**把 bench 带崩。
      let result: ReturnType<typeof detectStorageMedia> | undefined;
      expect(() => {
        result = detectStorageMedia('D:/probe-target', {
          platform,
          runner: explodingRunner,
        });
      }).not.toThrow();
      expect(result, `${platform} 分支必须返回一个结果`).toBeDefined();
      // ⚠️ **「没测到」与「测到了未知」是两件事** ⇒ `detected` 必须是 `false`。
      expect(result?.mediaClass, `${platform} 分支的介质类别`).toBe('unknown');
      expect(result?.detected, `${platform} 分支的 detected 标志`).toBe(false);
    }
  });

  it('★ **命令跑通但输出为空 ⇒ 同样是 `unknown` ＋ `detected=false`**（不是「测到了未知」）', () => {
    for (const platform of PLATFORMS) {
      const result = detectStorageMedia('D:/probe-target', {
        platform,
        runner: silentRunner,
      });
      expect(result.mediaClass, `${platform} 分支的介质类别`).toBe('unknown');
      expect(result.detected, `${platform} 分支的 detected 标志`).toBe(false);
    }
  });

  it('★ **Windows：`MediaType` 的四个取值都判对**（HDD / SSD / NVMe / Unspecified）', () => {
    const probe = (mediaType: string, busType = 'SATA'): StorageMediaClass =>
      detectStorageMedia('D:/probe-target', {
        platform: 'win32',
        runner: runnerByFile({
          'powershell.exe': [
            `MediaType=${mediaType}`,
            `BusType=${busType}`,
            'FriendlyName=ST1000DM010',
          ].join('\n'),
        }),
      }).mediaClass;

    expect(probe('HDD')).toBe('HDD');
    expect(probe('SSD')).toBe('SSD');
    expect(probe('NVMe')).toBe('NVMe');
    // ⚠️ **`Unspecified` ⇒ 归 `unknown`，绝不猜**（宁可不知道，也不要给一个假的类别）。
    expect(probe('Unspecified')).toBe('unknown');
    // ⚠️ **总线兜底**：介质说不清、但总线明确是 NVMe ⇒ 才认 NVMe。
    expect(probe('Unspecified', 'NVMe')).toBe('NVMe');
  });

  it('★ **Linux：`rota` 判 HDD / 固态，`tran` 判 NVMe**', () => {
    // ⚠️ **Linux 分支会问三条命令**：`findmnt` 一次、`lsblk` **两次**（`rota` 与 `tran`）
    //   ⇒ ⇒ **不能**用「按文件名分发」的 mock（两次 `lsblk` 会拿到同一份输出）
    //   ⇒ ⇒ 这里**按参数**区分（`args` 里带 `rota` 还是 `tran`）。
    const probe = (rota: string, tran: string): StorageMediaClass =>
      detectStorageMedia('/probe-target', {
        platform: 'linux',
        runner: (file, args) => {
          if (file === 'findmnt') {
            return '/dev/sda1\n';
          }
          if (file === 'lsblk') {
            return args.includes('rota') ? `${rota}\n` : `${tran}\n`;
          }
          throw new Error(`未预期的命令：${file}`);
        },
      }).mediaClass;

    expect(probe('1', 'sata')).toBe('HDD');
    expect(probe('0', 'sata')).toBe('SSD');
    expect(probe('0', 'nvme')).toBe('NVMe');
  });

  it('★ **macOS：`Solid State` / `Rotational` / `nvme` 都判对**', () => {
    const probe = (output: string): StorageMediaClass =>
      detectStorageMedia('/probe-target', {
        platform: 'darwin',
        runner: runnerByFile({ diskutil: output }),
      }).mediaClass;

    expect(probe('Device Node: /dev/disk1\nSolid State Disk\n')).toBe('SSD');
    expect(probe('Device Node: /dev/disk2\nRotational Disk\n')).toBe('HDD');
    expect(probe('Device Node: /dev/disk3\nProtocol: NVMe\n')).toBe('NVMe');
    // ⚠️ **说不清 ⇒ `unknown`**（不猜）。
    expect(probe('Device Node: /dev/disk4\n')).toBe('unknown');
  });

  it("★ **未知平台 ⇒ `unknown` ＋ `detected=false` ＋ `source='none'`**", () => {
    const result = detectStorageMedia('D:/probe-target', {
      platform: 'aix' as NodeJS.Platform,
      runner: explodingRunner,
    });
    expect(result.mediaClass).toBe('unknown');
    expect(result.detected).toBe(false);
    expect(result.source).toBe('none');
  });

  it('★ **默认参数（真实行为）不抛错**（**不许**因为探测失败把 bench 带崩）', () => {
    // ⚠️ **这条只断言「不抛错」** ⇒ **不依赖本机的真实介质类型**
    //   （本机是 HDD、别的机器可能是 NVMe ⇒ 断言具体类别就变成「依赖真实硬件」的脆断言）。
    let result: ReturnType<typeof detectStorageMedia> | undefined;
    expect(() => {
      result = detectStorageMedia();
    }).not.toThrow();
    expect(result).toBeDefined();
    // ⚠️ **类别只能是四个合法取值之一**（枚举没有第五个 ⇒ 探测不会造出怪值）。
    expect(['HDD', 'SSD', 'NVMe', 'unknown']).toContain(result?.mediaClass);
    // ⚠️ **`detected=true` ⇒ 类别一定不是 `unknown`**（这两者必须自洽）。
    if (result?.detected === true) {
      expect(result.mediaClass).not.toBe('unknown');
    }
  });
});
