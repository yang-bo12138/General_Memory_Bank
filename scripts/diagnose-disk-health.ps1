<#
.SYNOPSIS
    ★ D: 盘只读体检（★ 出关条件无关的机器健康诊断 · ★ 对应 `docs/handover/T07-cold-tier-and-disk-health-runbook.md`）。

.DESCRIPTION
    ★★ **只读脚本 —— 它绝不修改任何东西**：
    · ★ **不会**执行 `chkdsk /f`（★ 修复要独占卷、有风险 ⇒ ★ 诊断与修复【必须分开】）
    · ★ **不会**删除任何文件（★ 包括 `$RECYCLE.BIN` —— 只报体积，不清空）
    · ★ **不会**写入除「诊断结果 JSON」之外的任何文件

    ★ **它做什么**（全只读）：
    ① 提权检查（★ 不是管理员 ⇒ **自动用 `RunAs` 重启自己** ⇒ ★ 只需运行一次、会弹 UAC）
    ② 物理盘清单 + 健康状态
    ③ SMART 可靠性计数（★ 尽力而为：Windows 暴露多少记多少）
    ④ 原始 SMART 字节（★ 若 WMI 能取到 ⇒ 落成 hex ⇒ 供 CrystalDiskInfo / smartctl 离线解码）
    ⑤ `chkdsk <盘符> /scan`（★ **在线只读**、不占卷；★ 可用 `-SkipChkdsk` 跳过）
    ⑥ 卷 → 物理盘映射 + 空闲空间 + 顶层目录用量前 N（★ 供估「/f 要多久」）
    ⑦ **结论**（★ 照 runbook 的判读表算；★ 判不出来就明说「无法判定」，★ 不猜）

.PARAMETER Drive
    ★ 要体检的卷（★ 默认 `D:` —— 即当初报坏块的那块 ST1000DM010）

.PARAMETER SkipChkdsk
    ★ 跳过 `chkdsk /scan`（★ 它要扫全卷、可能十几到几十分钟）

.PARAMETER SkipDirScan
    ★ 跳过「顶层目录用量」统计（★ ★ 它要递归扫全卷 ⇒ **很慢**（★ 本机 D: 上 46 个目录 ·
    146.9 GB ⇒ 实测要几分钟）⇒ ⇒ ★ **只有要估 `/f` 耗时才需要它**）

.PARAMETER OutFile
    ★ 诊断结果 JSON 的输出路径（★ 默认 `docs/evidence/disk-health.json` —— ★ 落进仓库 ⇒ 结果可复核）

.PARAMETER NoPause
    ★ 结束时不等待按键（★ 供自动化调用）

.PARAMETER NoElevate
    ★ **不申请提权**（★ 仅供自测 / 无人值守调用）⇒ ⇒ ★ 此时 SMART 与 `chkdsk /scan` 会因缺权限
    而失败 ⇒ ⇒ ★ **结论会落到「无法判定」** ⇒ ⇒ ★ **正常诊断不要用这个开关**

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/diagnose-disk-health.ps1
#>

[CmdletBinding()]
param(
    [string] $Drive = 'D:',
    [switch] $SkipChkdsk,
    [switch] $SkipDirScan,
    [string] $OutFile = '',
    [switch] $NoPause,
    [switch] $NoElevate
)

$ErrorActionPreference = 'Continue'

# ★ 控制台输出用 UTF-8（★ 不设的话 PS 5.1 按 OEM 代码页输出 ⇒ 中文在窗口里是乱码）
#   ★ **两步都要**：★ ① 代码页切 65001（★ 否则控制台按 936/GBK 解码 UTF-8 字节 ⇒ 乱码）
#   ★ ② `OutputEncoding` 设 UTF8（★ 否则 PowerShell 按旧代码页写字节 ⇒ 乱码）
try { chcp 65001 > $null 2>&1 } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ─────────────────────────────────────────────────────────────
# ★ 提权：不是管理员 ⇒ 用 RunAs 重启自己（★ 只需运行一次）
# ─────────────────────────────────────────────────────────────
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $NoElevate) {
    Write-Host ''
    Write-Host '★ 需要管理员权限（★ 读 SMART 与 chkdsk /scan 都要）⇒ 现在申请提权 …' -ForegroundColor Yellow
    Write-Host ''
    $relaunchArgs = @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', $PSCommandPath, '-Drive', $Drive)
    if ($SkipChkdsk) { $relaunchArgs += '-SkipChkdsk' }
    if ($SkipDirScan) { $relaunchArgs += '-SkipDirScan' }
    if ($OutFile -ne '') { $relaunchArgs += @('-OutFile', $OutFile) }
    if ($NoPause) { $relaunchArgs += '-NoPause' }
    try {
        Start-Process -Verb RunAs -FilePath 'powershell.exe' -ArgumentList $relaunchArgs
        exit 0
    } catch {
        Write-Host "✗ 提权失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host '  ⇒ 请右键「以管理员身份运行」本脚本。' -ForegroundColor Red
        exit 1
    }
}

if (-not $isAdmin) {
    Write-Host '⚠ 未以管理员运行（★ -NoElevate）⇒ ★ SMART 与 chkdsk /scan 会失败 ⇒ ★ 结论会落到「无法判定」' -ForegroundColor Yellow
}

# ─────────────────────────────────────────────────────────────
# ★ 仓库根（★ 从脚本位置反推 ⇒ 从任何目录跑都能定位 docs/evidence）
# ─────────────────────────────────────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot
if ($OutFile -eq '') {
    $OutFile = Join-Path $repoRoot 'docs/evidence/disk-health.json'
}
$OutDir = Split-Path -Parent $OutFile
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

Write-Host ''
Write-Host '════════ D: 盘只读体检 ════════' -ForegroundColor Cyan
Write-Host ("管理员 = {0} · 目标卷 = {1}" -f $isAdmin, $Drive)
Write-Host ''

# ★ 同时产出一份【人读的 .txt】（★ transcript ⇒ PS 5.1 写 UTF-16LE ⇒ 记事本能正常打开）
#   ★ ★ 为什么需要它：★ 控制台代码页与重定向目标可能不是 UTF-8 ⇒ ⇒ 控制台输出可能被读成乱码
#   ⇒ ⇒ ★ **正式凭据是那个 JSON**（★ 保证 UTF-8）；★ 这份 .txt 只是给人看的便利副本
$textOut = [System.IO.Path]::ChangeExtension($OutFile, '.txt')
try { Start-Transcript -Path $textOut -Force | Out-Null } catch { }

$report = [ordered]@{
    schemaVersion = 1
    ranAt = (Get-Date).ToString('o')
    admin = $true
    drive = $Drive
    machine = [ordered]@{
        platform = $env:OS
        psVersion = $PSVersionTable.PSVersion.ToString()
    }
    physicalDisks = @()
    smart = $null
    smartRaw = $null
    chkdsk = $null
    volumes = @()
    topDirectories = @()
    recycleBinBytes = $null
    verdict = $null
}

# ─────────────────────────────────────────────────────────────
# ② 物理盘清单
# ─────────────────────────────────────────────────────────────
Write-Host '【② 物理盘】' -ForegroundColor Cyan
try {
    $disks = Get-PhysicalDisk -ErrorAction Stop | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus, @{n = 'SizeGB'; e = { [math]::Round($_.Size / 1GB, 0) } }
    foreach ($d in $disks) {
        Write-Host ("   {0,-26} {1,-6} {2,-9} {3,-3} {4} GB" -f $d.FriendlyName, $d.MediaType, $d.HealthStatus, $d.OperationalStatus, $d.SizeGB)
        $report.physicalDisks += [ordered]@{
            friendlyName = $d.FriendlyName
            mediaType    = [string]$d.MediaType
            healthStatus = [string]$d.HealthStatus
            operationalStatus = [string]$d.OperationalStatus
            sizeGB       = $d.SizeGB
        }
    }
} catch {
    Write-Host "   ✗ 读不到：$($_.Exception.Message)" -ForegroundColor Red
}

# ─────────────────────────────────────────────────────────────
# ③ SMART 可靠性计数（★ 尽力而为）
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '【③ SMART 可靠性计数】' -ForegroundColor Cyan
try {
    $target = Get-Partition -DriveLetter $Drive.TrimEnd(':') -ErrorAction Stop | Get-Disk
    $counter = $target | Get-StorageReliabilityCounter -ErrorAction Stop
    $counterDict = [ordered]@{}
    foreach ($prop in $counter.PSObject.Properties) {
        $counterDict[$prop.Name] = $prop.Value
        Write-Host ("   {0,-28} = {1}" -f $prop.Name, $prop.Value)
    }
    $report.smart = [ordered]@{
        available = $true
        diskNumber = $target.Number
        friendlyName = $target.FriendlyName
        counters = $counterDict
    }
} catch {
    Write-Host "   ✗ 读不到（★ 这也是「为什么要管理员」的证据之一）：$($_.Exception.Message)" -ForegroundColor Yellow
    $report.smart = [ordered]@{ available = $false; reason = [string]$_.Exception.Message }
}

# ─────────────────────────────────────────────────────────────
# ④ 原始 SMART 字节（★ 若 WMI 能取 ⇒ 落成 hex ⇒ 供离线解码 05/197/198）
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '【④ 原始 SMART（WMI 尽力而为）】' -ForegroundColor Cyan
try {
    $wmiDisk = Get-WmiObject -Namespace 'root\wmi' -Class 'MSStorageDriver_FailurePredictData' -ErrorAction Stop |
        Where-Object { $_.InstanceName -like '*Disk#VenStor*' -or $_.InstanceName -like '*_0*' } |
        Select-Object -First 1
    if ($null -ne $wmiDisk) {
        $hex = (($wmiDisk.VendorSpecific | ForEach-Object { '{0:X2}' -f $_ }) -join '')
        Write-Host "   ✓ 取到原始 SMART 数据（长度 $($wmiDisk.VendorSpecific.Length) 字节）⇒ 落成 hex 供 CrystalDiskInfo / smartctl 离线解码"
        $report.smartRaw = [ordered]@{
            available = $true
            instanceName = [string]$wmiDisk.InstanceName
            vendorSpecificHex = $hex
        }
    } else {
        Write-Host '   · 本机 WMI 未暴露 MSStorageDriver_FailurePredictData ⇒ ★ 用 CrystalDiskInfo 看 05/197/198 三条' -ForegroundColor Yellow
        $report.smartRaw = [ordered]@{ available = $false; reason = 'WMI 未暴露该类（或驱动不支持）' }
    }
} catch {
    Write-Host "   · 取不到：$($_.Exception.Message) ⇒ ★ 用 CrystalDiskInfo 看 05/197/198 三条" -ForegroundColor Yellow
    $report.smartRaw = [ordered]@{ available = $false; reason = [string]$_.Exception.Message }
}

# ─────────────────────────────────────────────────────────────
# ⑤ chkdsk /scan（★ 在线只读 · 不占卷）
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '【⑤ chkdsk /scan（★ 在线只读 · 不占卷）】' -ForegroundColor Cyan
if ($SkipChkdsk) {
    Write-Host '   · 已按 -SkipChkdsk 跳过' -ForegroundColor Yellow
    $report.chkdsk = [ordered]@{ ran = $false; reason = '-SkipChkdsk' }
} else {
    Write-Host '   · 扫描中（★ 扫全卷 ⇒ 可能十几到几十分钟）…' -ForegroundColor Yellow
    $raw = & chkdsk $Drive /scan 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $raw
    $report.chkdsk = [ordered]@{ ran = $true; exitCode = $code; raw = $raw }
}

# ─────────────────────────────────────────────────────────────
# ⑥ 卷映射 + 空间 + 顶层目录用量
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '【⑥ 卷与空间】' -ForegroundColor Cyan
try {
    foreach ($l in (Get-PSDrive -PSProvider FileSystem)) {
        $partition = Get-Partition -DriveLetter $l.Name -ErrorAction SilentlyContinue
        $report.volumes += [ordered]@{
            driveLetter = "$($l.Name):"
            usedGB = [math]::Round($l.Used / 1GB, 1)
            freeGB = [math]::Round($l.Free / 1GB, 1)
            diskNumber = if ($partition) { $partition.DiskNumber } else { $null }
        }
        Write-Host ("   {0}: 已用 {1} GB · 空闲 {2} GB · Disk {3}" -f $l.Name, [math]::Round($l.Used / 1GB, 1), [math]::Round($l.Free / 1GB, 1), $(if ($partition) { $partition.DiskNumber } else { '?' }))
    }
} catch {
    Write-Host "   ✗ 读不到：$($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Write-Host '   顶层目录用量（前 10 · 供估 /f 耗时）' -ForegroundColor Cyan
if ($SkipDirScan) {
    Write-Host '   · 已按 -SkipDirScan 跳过（★ 该步要递归扫全卷、很慢）' -ForegroundColor Yellow
    $report.topDirectoriesSkipped = $true
} else {
try {
    $dirs = Get-ChildItem ($Drive + '\') -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $sum = (Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        [PSCustomObject]@{ Name = $_.Name; GB = [math]::Round($sum / 1GB, 2) }
    } | Sort-Object GB -Descending | Select-Object -First 10
    foreach ($d in $dirs) {
        Write-Host ("   {0,-34} {1} GB" -f $d.Name, $d.GB)
        $report.topDirectories += [ordered]@{ name = $d.Name; gb = $d.GB }
    }
    $rb = (Get-ChildItem ($Drive + '\') -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq '$RECYCLE.BIN' } | ForEach-Object {
            (Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        })
    if ($rb) {
        $report.recycleBinBytes = $rb
        Write-Host ("   · `$RECYCLE.BIN 占 {0} GB（★ 只报、不清空 —— 清空是删个人文件 ⇒ 要你本人确认）" -f [math]::Round($rb / 1GB, 2)) -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ✗ 读不到：$($_.Exception.Message)" -ForegroundColor Red
}
}

# ─────────────────────────────────────────────────────────────
# ⑦ 结论（★ 照 runbook 的判读表 · ★ 判不出来就明说「无法判定」）
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '【⑦ 结论】' -ForegroundColor Cyan

$reasons = New-Object System.Collections.Generic.List[string]
$action = '无法判定'
$severity = 'unknown'

# ① Pending > 0 ⇒ 盘在报废边缘 ⇒ 换盘
$pending = $null
if ($report.smart -and $report.smart.available) {
    foreach ($key in @('PendingSectorCount', 'CurrentPendingSector', 'Pending')) {
        if ($report.smart.counters.Contains($key)) { $pending = [int64]$report.smart.counters[$key]; break }
    }
}
$chkdskBadCluster = $false
$chkdskUnrecoverable = $false
if ($report.chkdsk -and $report.chkdsk.ran) {
    $t = [string]$report.chkdsk.raw
    if ($t -match 'bad cluster|坏簇|有错误|包含错误') { $chkdskBadCluster = $true }
    if ($t -match 'unreadable|无法修复|不可读取') { $chkdskUnrecoverable = $true }
}

if ($null -ne $pending -and $pending -gt 0) {
    $action = '换盘'
    $severity = 'critical'
    $reasons.Add("SMART Pending 扇区 = $pending（> 0）⇒ ★ 盘在报废边缘 ⇒ ★ chkdsk /f 修不了物理坏块、只能绕")
} elseif ($chkdskUnrecoverable) {
    $action = '换盘（并先备份）'
    $severity = 'critical'
    $reasons.Add('chkdsk 报告【无法修复 / 不可读取】⇒ ★ 有不可读扇区 ⇒ ⇒ 先备份，再考虑换盘')
} elseif ($chkdskBadCluster) {
    $action = 'chkdsk /f（★ 先备份 · 要独占卷）'
    $severity = 'warning'
    $reasons.Add('chkdsk 报告坏簇 ⇒ ★ 可尝试重分配 ⇒ ⇒ 但 /f 遇不可读扇区会把相关文件标「损坏」⇒ ★ 先备份')
} elseif ($null -ne $pending -and $pending -eq 0 -and $report.chkdsk -and $report.chkdsk.ran) {
    $action = '不用做 chkdsk /f'
    $severity = 'ok'
    $reasons.Add('SMART Pending = 0 ⇒ 坏块已被文件系统吸收 ⇒ ⇒ 无坏可修')
} else {
    $action = '无法判定（★ 请人工读上面的原始输出）'
    $severity = 'unknown'
    if ($null -eq $pending) { $reasons.Add('★ 没能读到 SMART Pending 计数（★ Windows 可能不暴露该字段 ⇒ ★ 用 CrystalDiskInfo 看 197 号）') }
    if (-not $report.chkdsk -or -not $report.chkdsk.ran) { $reasons.Add('★ 没跑 chkdsk /scan（★ 被跳过 ⇒ ★ 文件系统层的坏簇情况未知）') }
}

$report.verdict = [ordered]@{
    action = $action
    severity = $severity
    reasons = @($reasons)
    note = '★ 本脚本【只读】、不执行 /f、不删任何东西 ⇒ ★ /f 与换盘都要你本人决定'
}

Write-Host ("   ⇒ 结论：{0}" -f $action) -ForegroundColor $(if ($severity -eq 'ok') { 'Green' } elseif ($severity -eq 'unknown') { 'Yellow' } else { 'Red' })
foreach ($r in $reasons) { Write-Host "     · $r" }
Write-Host ''
Write-Host '★ 本脚本【只读】：没执行 /f、没删任何东西 ⇒ /f 与换盘都要你本人决定。' -ForegroundColor Yellow

# ─────────────────────────────────────────────────────────────
# 落盘（★ 唯一写入 ⇒ 诊断结果成为可复核的凭据）
# ─────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────
# 落盘（★ 唯一写入 ⇒ 诊断结果成为可复核的凭据）
# ─────────────────────────────────────────────────────────────
# ★★ **必须用「无 BOM 的 UTF-8」**（★ ★ 2026-11-05 实测踩到的坑）：
#   PS 5.1 的 `Set-Content -Encoding utf8` **会写 BOM** ⇒ ⇒ **Node 的 `JSON.parse` 直接报错**
#   （★ `SyntaxError: Unexpected token '﻿'`）⇒ ⇒ ★ 而 PowerShell 自己的 `ConvertFrom-Json`
#   能读 ⇒ ⇒ **⇒ 骗得过自己、骗不过仓库的 TS 工具链** ⇒ ⇒ ★ 必须显式用无 BOM 编码器。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$json = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($OutFile, $json, $utf8NoBom)

# ★★ 落盘自检（★ 证明「机器可读」而不是「我认为它可读」）
$raw = [System.IO.File]::ReadAllBytes($OutFile)
$hasBom = ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)
$parsed = $null
try { $parsed = [System.Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json } catch { }
if ($hasBom -or $null -eq $parsed) {
    Write-Host '✗ 自检失败：落盘 JSON 不是「无 BOM 的 UTF-8」或不可解析 ⇒ ★ 请把这条报给主理人' -ForegroundColor Red
    exit 2
}
Write-Host '✓ 落盘自检通过：无 BOM 的 UTF-8 · 可被严格解析（★ Node 的 JSON.parse 也能读）' -ForegroundColor Green

Write-Host ("★ 诊断结果已落盘：{0}" -f $OutFile) -ForegroundColor Green
Write-Host ("★ 人读副本（transcript）：{0}" -f $textOut) -ForegroundColor Green
Write-Host '  ⇒ 把它交给主理人 ⇒ ★ 可作为仓库凭据提交（★ 里面只有状态与计数、不含序列号）' -ForegroundColor Green
try { Stop-Transcript | Out-Null } catch { }
# ★ transcript 转成「无 BOM 的 UTF-8」（★ PS 的 transcript 是 UTF-16LE ⇒ ⇒ 转了才能进 git 当文本看）
try {
    $transcriptText = [System.IO.File]::ReadAllText($textOut, [System.Text.Encoding]::Unicode)
    [System.IO.File]::WriteAllText($textOut, $transcriptText, $utf8NoBom)
} catch { }

if (-not $NoPause) {
    Write-Host ''
    Read-Host '按回车关闭'
}
exit 0
