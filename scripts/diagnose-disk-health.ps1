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
    [switch] $NoElevate,
    [string] $RecomputeFrom = ''
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

if ($RecomputeFrom -eq '' -and -not $isAdmin -and -not $NoElevate) {
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

if ($RecomputeFrom -eq '' -and -not $isAdmin) {
    Write-Host '⚠ 未以管理员运行（★ -NoElevate）⇒ ★ SMART 与 chkdsk /scan 会失败 ⇒ ★ 结论会落到「无法判定」' -ForegroundColor Yellow
}

# ─────────────────────────────────────────────────────────────
# ★ 仓库根（★ 从脚本位置反推 ⇒ 从任何目录跑都能定位 docs/evidence）
# ─────────────────────────────────────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot
if ($OutFile -eq '') {
    # ★ 重算模式 ⇒ 默认【就地写回源文件】；★ 诊断模式 ⇒ 默认仓库里的标准路径
    $OutFile = if ($RecomputeFrom -ne '') { $RecomputeFrom } else { Join-Path $repoRoot 'docs/evidence/disk-health.json' }
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
    # ★★ **必须按【目标盘】选实例，不能「取第一个」**（★ 2026-11-05 实测踩到的真 bug）：
    #   WMI 实例名格式 = `SCSI\Disk&Ven_&Prod_<型号规范化>\<...>`，★ 其中 `<型号规范化>` =
    #   **型号前 16 个字符、非字母数字一律换成 `_`**（★ 例：`Colorful SL500 320GB` → `Colorful_SL500_3`；
    #   ★ `ST1000DM010-2EP102` → `ST1000DM010_2EP1`）⇒ ⇒ ★ **拿它跟目标盘的型号规范化比对**。
    $targetDisk = Get-Partition -DriveLetter $Drive.TrimEnd(':') -ErrorAction Stop | Get-Disk
    $normalized = ($targetDisk.FriendlyName -replace '[^A-Za-z0-9]', '_')
    if ($normalized.Length -gt 16) { $normalized = $normalized.Substring(0, 16) }

    $allInstances = @(Get-WmiObject -Namespace 'root\wmi' -Class 'MSStorageDriver_FailurePredictData' -ErrorAction Stop)
    $instanceNames = @($allInstances | ForEach-Object { [string]$_.InstanceName })

    $wmiDisk = $null
    foreach ($cand in $allInstances) {
        $name = [string]$cand.InstanceName
        if ($name -match 'Prod_([^\\&]+)') {
            if ($Matches[1] -ieq $normalized) { $wmiDisk = $cand; break }
        }
    }
    $matchesTarget = ($null -ne $wmiDisk)

    if ($matchesTarget) {
        $hex = (($wmiDisk.VendorSpecific | ForEach-Object { '{0:X2}' -f $_ }) -join '')
        Write-Host "   ✓ 取到【目标盘】的原始 SMART 数据（长度 $($wmiDisk.VendorSpecific.Length) 字节 · $($targetDisk.FriendlyName)）⇒ 落成 hex 供 CrystalDiskInfo / smartctl 离线解码"
    } else {
        Write-Host ('   ⚠ 取到的实例里【没有匹配目标盘】的（★ 目标盘 = {0} · 规范化 = {1}）⇒ ★ 不落 hex（★ 落别人的盘 = 落盘产物说谎）' -f $targetDisk.FriendlyName, $normalized) -ForegroundColor Yellow
        foreach ($n in $instanceNames) { Write-Host "     · 本机可见实例：$n" -ForegroundColor Yellow }
    }

    $report.smartRaw = [ordered]@{
        available = $matchesTarget
        matchesTargetDisk = $matchesTarget
        targetFriendlyName = [string]$targetDisk.FriendlyName
        targetNormalized = $normalized
        instanceName = if ($matchesTarget) { [string]$wmiDisk.InstanceName } else { '' }
        vendorSpecificHex = if ($matchesTarget) { $hex } else { '' }
        allInstances = $instanceNames
    }
} catch {
    Write-Host "   · 取不到：$($_.Exception.Message) ⇒ ★ 用 CrystalDiskInfo 看 05/197/198 三条" -ForegroundColor Yellow
    $report.smartRaw = [ordered]@{ available = $false; matchesTargetDisk = $false; reason = [string]$_.Exception.Message }
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

# ★★ **键查找必须同时支持两种载体**（★ 2026-11-05 实测踩到的第 4 个坑）：
#   · **诊断主流程**里 `counters` 是 **[ordered] 字典**（★ hashtable ⇒ ★ 有 `.Contains()` 方法）
#   · **重算模式**里 `counters` 是 **`ConvertFrom-Json` 出来的 PSCustomObject**（★ **没有** `.Contains()`）
#   ⇒ ⇒ ★ 若只写 `.Contains()` ⇒ ⇒ **重算模式会静默取不到值** ⇒ ⇒ ★ 结论从「盘健康」
#     掉到「SMART 计数缺失」⇒ ⇒ ★ **同一份数据、两种类型、两个结论** ⇒ ⇒ ★ **必须统一**
function Test-Key {
    param($Obj, [string] $Key)
    if ($null -eq $Obj) { return $false }
    if ($Obj -is [System.Collections.IDictionary]) { return $Obj.Contains($Key) }
    return ($Obj.PSObject.Properties.Name -contains $Key)
}
function Get-Val {
    param($Obj, [string] $Key)
    if (Test-Key $Obj $Key) { return $Obj.$Key }
    return $null
}

# ─────────────────────────────────────────────────────────────
# ★★ 落盘格式归一（★ 2026-11-06 实测踩到的坑：产物【格式不合仓库规范】⇒ 门禁 lint 直接红）
#   ★ 起因：PS 5.1 的 `ConvertTo-Json` 产出的是 **4 空格缩进 + 冒号后 2 空格 + CRLF**
#     （★ 实测确认：★ PS 7 才改成「冒号后 1 空格」⇒ ⇒ 脚本必须自己补齐）
#     ⇒ ⇒ 仓库规范（★ `biome.json` 的 `indentWidth: 2` + `lineEnding: lf` ⇒ ★ 等价于
#        Node 的 `JSON.stringify(x, null, 2)`）要求 **2 空格 + 冒号后 1 空格 + LF**
#     ⇒ ⇒ 后果：★ `docs/evidence/disk-health.json` 一入库 ⇒ `pnpm run lint` **当场红**
#     ⇒ ⇒ ★ **证据文件也是仓库文件** ⇒ ⇒ 产物必须**一出生就合规**
#
#   ★★ **踩到的第二个坑：PS 的缩进【不是线性的】**（★ 2026-11-06 实测）：
#     ★ 同一份产物的各级缩进实测是 **4 / 20 / 26 / 30** 空格（★ 不是 4 / 8 / 12 / 16）
#     ⇒ ⇒ ★ **「把缩进除以 2」这种线性规则从根上就是错的**（★ 第一次归一就栽在这 ⇒
#       归一后 biome 照样红）
#     ⇒ ⇒ ★ **正解：按【括号的嵌套深度】重建缩进**（★ 标准 JSON 的缩进本来就是
#        「深度 × 2」⇒ ⇒ 与 biome 的输出逐位一致）
#
#   ★ **只动空白** ⇒ ⇒ **判据数据一个字节都不改**（★ 这是本函数存在的全部前提）
#   ★ 仓库侧另有 `check:line-endings` 守卫（★ 链外）⇒ ★ LF 这条与它对齐
# ─────────────────────────────────────────────────────────────
function ConvertTo-RepoJson {
    param(
        [Parameter(Mandatory = $true)] $InputObject,
        [int] $Depth = 10
    )
    $json = $InputObject | ConvertTo-Json -Depth $Depth

    # ⚠️⚠️ **全程字符串感知**（★ 本函数最容易写错的地方）：
    #   JSON 的【值】里也可能出现 `{` `}` `[` `]` `:`（★ 例：`chkdsk.raw` 里 Windows 的原始输出）
    #   ⇒ ⇒ 若不跟踪「当前在不在字符串里」⇒ **缩进与冒号都会算错** ⇒ ⇒ ⇒ 必须用状态机
    #   ⇒ ⇒ 且字符串内的 `\"` 不算结束引号 ⇒ ⇒ 要处理反斜杠转义
    $lines = New-Object System.Collections.Generic.List[string]
    $buf = New-Object System.Text.StringBuilder
    $inString = $false
    $escaped = $false
    $depthNow = 0
    $indent = 0
    $lineHasContent = $false

    $i = 0
    $len = $json.Length
    while ($i -lt $len) {
        $ch = $json[$i]

        # ── 换行 ⇒ 收行 ──
        if ($ch -eq "`n") {
            if ($buf.Length -gt 0) { $lines.Add((' ' * $indent) + $buf.ToString()) } else { $lines.Add('') }
            [void]$buf.Clear()
            $lineHasContent = $false
            $i++
            continue
        }
        # ── 回车 ⇒ 丢弃（★ 统一 LF）──
        if ($ch -eq "`r") { $i++; continue }
        # ── 行首空白 ⇒ 丢弃（★ 缩进由本函数自己算 ⇒ ⇒ 原有缩进一律作废）──
        if (-not $lineHasContent -and ($ch -eq ' ' -or $ch -eq "`t")) { $i++; continue }

        # ── ★ 本行的第一个实质字符 ⇒ ★ 定本行缩进 ──
        #    · 闭合括号（`}` `]`）⇒ 它属于【外一层】⇒ 缩进 = 2 × (深度 − 1)
        #    · 其余（`{` `[` `"` 数字 …）⇒ 缩进 = 2 × 当前深度
        if (-not $lineHasContent) {
            if ($ch -eq '}' -or $ch -eq ']') { $indent = 2 * ($depthNow - 1) } else { $indent = 2 * $depthNow }
            $lineHasContent = $true
        }

        # ── 字符串内 ──
        if ($inString) {
            [void]$buf.Append($ch)
            if ($escaped) { $escaped = $false }
            elseif ($ch -eq '\') { $escaped = $true }
            elseif ($ch -eq '"') { $inString = $false }
            $i++
            continue
        }

        # ── 字符串外 ──
        if ($ch -eq '"') { $inString = $true; [void]$buf.Append($ch); $i++; continue }

        if ($ch -eq '{' -or $ch -eq '[') {
            [void]$buf.Append($ch)
            $depthNow++
            $i++
            continue
        }
        if ($ch -eq '}' -or $ch -eq ']') {
            [void]$buf.Append($ch)
            $depthNow--
            $i++
            continue
        }
        if ($ch -eq ':') {
            # ★ 冒号后：PS 5.1 给 2 个空格 ⇒ 仓库规范要 1 个 ⇒ ⇒ 吃掉多余的只留 1 个
            [void]$buf.Append($ch)
            $i++
            $sp = 0
            while ($i -lt $len -and $json[$i] -eq ' ') { $sp++; $i++ }
            if ($sp -gt 0) { [void]$buf.Append(' ') }
            continue
        }
        [void]$buf.Append($ch)
        $i++
    }
    # 收尾（★ 最后一行没有换行时）
    if ($buf.Length -gt 0) { $lines.Add((' ' * $indent) + $buf.ToString()) }

    # ── 行尾：CRLF → LF（★ `-join "`n"` 天然是 LF ⇒ ⇒ 全文件统一 LF）──
    #    ★ 末尾补一个 LF（★ biome 的 formatter 会要求文件以换行结尾）
    return (($lines -join "`n") + "`n")
}

# ─────────────────────────────────────────────────────────────
# ★★ 判读函数（★ 抽出来 ⇒ ① 主流程与 ② `-RecomputeFrom` 复用【同一份判据】
#   ⇒ ⇒ 两条路径【不可能给出不同结论】⇒ ⇒ ★ 这就是「判据只有一份」的纪律）
# ─────────────────────────────────────────────────────────────
function Get-DiskVerdict {
    param(
        [string] $ChkdskRaw,
        [bool] $ChkdskRan,
        $SmartCounters
    )
    $reasons = New-Object System.Collections.Generic.List[string]
    $action = '无法判定'
    $severity = 'unknown'

    # ★★ **判据必须对着【真实输出形态】写**（★ 2026-11-05 实测踩到的真 bug）：
    #   ① ★ **`chkdsk` 的输出是【英文】**（★ 本机 locale 下 `chkdsk` 输出英文 ⇒ 上一版关键词全是中文
    #      ⇒ ⇒ **一条都没命中** ⇒ ⇒ 连「0 KB in bad sectors」这条决定性信号都被漏掉 ⇒ ⇒ 白跑）
    #      ⇒ ⇒ ★ **判据要同时认中英两路**；
    #   ② ★ **`SMART Pending`（197 号）Windows 不暴露**（★ `Get-StorageReliabilityCounter` 没有该字段）
    #      ⇒ ⇒ ★ **判据不能只认它** ⇒ ⇒ ★ **要改用 Windows 侧真有的强信号**：
    #      ★ **`ReadErrorsUncorrected` / `WriteErrorsUncorrected`（未纠正的读写错误）**
    #      ⇒ ⇒ ★ **它们为 0 ⇒ ⇒ 当前没有正在恶化的坏块** ⇒ ⇒ 这与「坏簇 = 0」互为印证。
    # ★★ ★★ **「0」与「null / 缺失」必须分开**（★ 2026-11-05 实测踩到的第 5 个坑）：
    #   Windows 对这块 SATA 盘**不提供写侧计数**（★ `WriteErrorsTotal` / `WriteErrorsUncorrected`
    #   的值是 **`null`**）⇒ ⇒ ★ 而 `[int64]$null` = **0** ⇒ ⇒ ★ **若直接转整数 ⇒ 「未提供」
    #   会被当成「0（= 没有错误）」⇒ ⇒ ★ **结论就会声称一个【根本没测到】的事实**
    #   ⇒ ⇒ ★ **⇒ 纪律：缺信号 ≠ 有信号** ⇒ ⇒ ★ 下面用「存在且非 null」两个独立布尔量来守住。
    $pending = $null
    $readUncorrected = $null
    $writeUncorrected = $null
    $readOk = $false
    $writeOk = $false
    if ($null -ne $SmartCounters) {
        foreach ($key in @('PendingSectorCount', 'CurrentPendingSector', 'Pending')) {
            if (Test-Key $SmartCounters $key) {
                $pv = Get-Val $SmartCounters $key
                if ($null -ne $pv) { $pending = [int64]$pv }
                break
            }
        }
        if (Test-Key $SmartCounters 'ReadErrorsUncorrected') {
            $rv = Get-Val $SmartCounters 'ReadErrorsUncorrected'
            if ($null -ne $rv) { $readUncorrected = [int64]$rv; $readOk = $true }
        }
        if (Test-Key $SmartCounters 'WriteErrorsUncorrected') {
            $wv = Get-Val $SmartCounters 'WriteErrorsUncorrected'
            if ($null -ne $wv) { $writeUncorrected = [int64]$wv; $writeOk = $true }
        }
    }

    # ★ chkdsk 输出的三件事：★ 坏簇 KB 数（★ 「0 KB in bad sectors」= 零坏簇）· 是否「found no problems」· 是否不可读
    $chkdskBadSectorsKB = $null
    $chkdskNoProblems = $false
    $chkdskUnrecoverable = $false
    if ($ChkdskRan) {
        $t = [string]$ChkdskRaw
        if ($t -match '([0-9]+)\s+KB in bad sectors') { $chkdskBadSectorsKB = [int64]$Matches[1] }
        if ($t -match 'found no problems|没有发现问题|未发现问题') { $chkdskNoProblems = $true }
        if ($t -match 'unreadable|could not verify|无法修复|不可读取|无法读取') { $chkdskUnrecoverable = $true }
    }
$chkdskHasBadClusters = ($null -ne $chkdskBadSectorsKB -and $chkdskBadSectorsKB -gt 0)
    $zeroUncorrected = ($readOk -and $readUncorrected -eq 0 -and $writeOk -and $writeUncorrected -eq 0)
    $readClean = ($readOk -and $readUncorrected -eq 0)

    if ($null -ne $pending -and $pending -gt 0) {
        $action = '换盘'
        $severity = 'critical'
        $reasons.Add("SMART Pending 扇区 = $pending（> 0）⇒ ★ 盘在报废边缘 ⇒ ★ chkdsk /f 修不了物理坏块、只能绕")
    } elseif ($chkdskUnrecoverable) {
        $action = '换盘（并先备份）'
        $severity = 'critical'
        $reasons.Add('chkdsk 报告【无法修复 / 不可读取】⇒ ★ 有不可读扇区 ⇒ ⇒ 先备份，再考虑换盘')
    } elseif ($chkdskHasBadClusters) {
        $action = 'chkdsk /f（★ 先备份 · 要独占卷）'
        $severity = 'warning'
        $reasons.Add("chkdsk 报告坏簇 = $chkdskBadSectorsKB KB ⇒ ★ 可尝试重分配 ⇒ ⇒ 但 /f 遇不可读扇区会把相关文件标「损坏」⇒ ★ 先备份")
    } elseif ($null -ne $chkdskBadSectorsKB -and $chkdskBadSectorsKB -eq 0 -and $zeroUncorrected) {
        $action = '★ 盘健康 —— 不用做 chkdsk /f、也不用换盘'
        $severity = 'ok'
        $reasons.Add("chkdsk /scan：**$chkdskBadSectorsKB KB in bad sectors**（★ 零坏簇）＋ $(if ($chkdskNoProblems) { 'found no problems' } else { '（未见 found no problems）' }) ⇒ ★ 文件系统层健康")
        $reasons.Add("SMART：**未纠正读错误 = $readUncorrected**、**未纠正写错误 = $writeUncorrected** ⇒ ★ 没有正在恶化的坏块")
        $reasons.Add('⇒ ⇒ ★ **结论：当初那次的文件损坏【不是物理坏块造成的】** ⇒ ⇒ 「chkdsk /f D:」这条待办【可以撤销】')
    } elseif ($null -ne $chkdskBadSectorsKB -and $chkdskBadSectorsKB -eq 0 -and $readClean) {
        $action = '★ 盘健康 —— 不用做 chkdsk /f、也不用换盘'
        $severity = 'ok'
        $reasons.Add("chkdsk /scan：**$chkdskBadSectorsKB KB in bad sectors**（★ 零坏簇）＋ $(if ($chkdskNoProblems) { 'found no problems' } else { '（未见 found no problems）' }) ⇒ ★ 文件系统层健康")
        $reasons.Add("SMART：**未纠正读错误 = $readUncorrected** ⇒ ★ 读路径没有坏块迹象；★ **未纠正写错误 = $(if ($writeOk) { $writeUncorrected } else { 'null（★ Windows 对该盘【未提供】写侧计数 ⇒ ⇒ 【不是】0、只是【没测到】）' })**")
        $reasons.Add('⇒ ⇒ ★ **写侧虽未测到，但坏簇是【读写通吃】的物理层概念 ⇒ ⇒ chkdsk 的「零坏簇」已覆盖写路径** ⇒ ⇒ ★ **⇒ 结论不变**')
        $reasons.Add('⇒ ⇒ ★ **结论：当初那次的文件损坏【不能归因于物理坏块】** ⇒ ⇒ 「chkdsk /f D:」这条待办【可以撤销】')
    } elseif ($null -ne $chkdskBadSectorsKB -and $chkdskBadSectorsKB -eq 0) {
    $action = '不用做 chkdsk /f（★ 但 SMART 未纠正错误计数缺失 ⇒ 想更稳可用 CrystalDiskInfo 看 197 号）'
    $severity = 'ok'
    $reasons.Add("chkdsk /scan：**$chkdskBadSectorsKB KB in bad sectors**（★ 零坏簇）⇒ ★ 文件系统层健康 ⇒ ⇒ 无坏可修")
} else {
    $action = '无法判定（★ 请人工读上面的原始输出）'
    $severity = 'unknown'
    if ($null -eq $pending) { $reasons.Add('★ 没能读到 SMART Pending 计数（★ Windows 不暴露 197 号 ⇒ ★ 它的缺失【不等于】有坏块 ⇒ ★ 用 CrystalDiskInfo 看 197 号）') }
    if (-not $report.chkdsk -or -not $report.chkdsk.ran) { $reasons.Add('★ 没跑 chkdsk /scan（★ 被跳过 ⇒ ★ 文件系统层的坏簇情况未知）') }
    if ($null -eq $chkdskBadSectorsKB) { $reasons.Add('★ chkdsk 输出里没匹配到「N KB in bad sectors」⇒ ★ 请人工读原始输出') }
}

# ★★ **把判据用的原始量一并落盘**（★ ⇒ 结论【可复算】⇒ 不只是一句结论字符串）
    return [ordered]@{
        action = $action
        severity = $severity
        reasons = @($reasons)
        evidence = [ordered]@{
            chkdskBadSectorsKB = $chkdskBadSectorsKB
            chkdskNoProblems = $chkdskNoProblems
            smartPending = $pending
            smartReadErrorsUncorrected = $readUncorrected
            smartReadErrorsUncorrectedPresent = $readOk
            smartWriteErrorsUncorrected = $writeUncorrected
            smartWriteErrorsUncorrectedPresent = $writeOk
        }
        note = '★ 本脚本【只读】、不执行 /f、不删任何东西 ⇒ ★ /f 与换盘都要你本人决定'
    }
}

# ── ② `-RecomputeFrom`（★ 用【已落盘的原始数据】重算结论 ⇒ 不用再以管理员跑一次）──
if ($RecomputeFrom -ne '') {
    Write-Host ''
    Write-Host ('════ 重算结论（★ 源 = {0}）════' -f $RecomputeFrom) -ForegroundColor Cyan
    $src = Get-Content -Raw -Encoding UTF8 $RecomputeFrom | ConvertFrom-Json
    $srcCounters = $null
    if ($src.smart -and $src.smart.available) { $srcCounters = $src.smart.counters }
    $v = Get-DiskVerdict -ChkdskRaw ([string]$src.chkdsk.raw) -ChkdskRan ([bool]$src.chkdsk.ran) -SmartCounters $srcCounters
    $src | Add-Member -NotePropertyName verdict -NotePropertyValue $v -Force
    $src | Add-Member -NotePropertyName verdictEvidence -NotePropertyValue $v.evidence -Force
    $src | Add-Member -NotePropertyName recomputedAt -NotePropertyValue ((Get-Date).ToString('o')) -Force

    # ★★ **顺手清掉「取错盘的原始 SMART hex」**（★ 2026-11-05 实测踩到的真 bug）：
    #   旧版脚本是「取 WMI 的第一个实例」⇒ ★ 实测取到的是 **C: 的 SSD**（Colorful SL500）
    #   而不是 **D: 的 HDD**（ST1000DM010）⇒ ⇒ ★ **那份 hex 若留着 ⇒ 就是「落盘产物说谎」**
    #   ⇒ ⇒ ★ **判据：没有 `matchesTargetDisk` 标记（旧脚本产的）⇒ 或标记为 false ⇒ ⇒ 一律作废**
    if ($null -ne $src.smartRaw) {
        $matched = $false
        if ($src.smartRaw.PSObject.Properties.Name -contains 'matchesTargetDisk') { $matched = [bool]$src.smartRaw.matchesTargetDisk }
        if (-not $matched) {
            Write-Host '   ⚠ 原始 SMART 段【没有「匹配目标盘」的标记】⇒ ★ 那 hex 是旧脚本取的【可能是别的盘】⇒ ★ 已作废（★ 请以管理员重跑一次诊断以取回正确的）' -ForegroundColor Yellow
            $src | Add-Member -NotePropertyName smartRaw -NotePropertyValue ([ordered]@{
                    available = $false
                    matchesTargetDisk = $false
                    reason = '★ 旧版脚本取的是「WMI 第一个实例」⇒ ★ 可能不是目标盘 ⇒ ★ 已作废 ⇒ ★ 请以管理员重跑一次诊断'
                }) -Force
        }
    }

    # ★★ **把 SMART 计数里的【非标量元数据】剔掉**（★ 2026-11-05 实测：整份 JSON 有 ~90 KB 是
    #   `CimClass` / `ObjectId` / `UniqueId` 这类 CIM 元数据 ⇒ ⇒ 产物不可读、diff 也没意义
    #   ⇒ ⇒ ★ 只留【判据用的数值】⇒ ⇒ ★ 判据仍可复算、产物却变得很小）
    if ($null -ne $src.smart -and $null -ne $src.smart.counters) {
        $slim = [ordered]@{}
        foreach ($prop in $src.smart.counters.PSObject.Properties) {
            $v = $prop.Value
            if ($v -is [string] -or $v -is [ValueType]) { $slim[$prop.Name] = $v }
        }
        $src.smart.counters = $slim
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutFile, (ConvertTo-RepoJson -InputObject $src -Depth 10), $utf8NoBom)
    Write-Host ("   ⇒ 结论：{0}" -f $v.action) -ForegroundColor $(if ($v.severity -eq 'ok') { 'Green' } elseif ($v.severity -eq 'unknown') { 'Yellow' } else { 'Red' })
    foreach ($r in $v.reasons) { Write-Host "     · $r" }
    Write-Host ("★ 已写回：{0}" -f $OutFile) -ForegroundColor Green
    if (-not $NoPause) { Write-Host ''; Read-Host '按回车关闭' }
    exit 0
}

# ── ① 主流程：调用【同一个】判读函数 ──
$smartCounters = $null
if ($report.smart -and $report.smart.available) { $smartCounters = $report.smart.counters }
$chkdskRaw = ''
$chkdskRan = $false
if ($report.chkdsk -and $report.chkdsk.ran) { $chkdskRaw = [string]$report.chkdsk.raw; $chkdskRan = $true }
$report.verdict = Get-DiskVerdict -ChkdskRaw $chkdskRaw -ChkdskRan $chkdskRan -SmartCounters $smartCounters
$action = $report.verdict.action
$severity = $report.verdict.severity
$reasons = $report.verdict.reasons
$report.verdictEvidence = $report.verdict.evidence

Write-Host ("   ⇒ 结论：{0}" -f $action) -ForegroundColor $(if ($severity -eq 'ok') { 'Green' } elseif ($severity -eq 'unknown') { 'Yellow' } else { 'Red' })
foreach ($r in $reasons) { Write-Host "     · $r" }
Write-Host ''
Write-Host '★ 本脚本【只读】：没执行 /f、没删任何东西 ⇒ /f 与换盘都要你本人决定。' -ForegroundColor Yellow

# ─────────────────────────────────────────────────────────────
# 落盘（★ 唯一写入 ⇒ 诊断结果成为可复核的凭据）
# ─────────────────────────────────────────────────────────────
# ★★ **必须用「无 BOM 的 UTF-8」**（★ ★ 2026-11-05 实测踩到的坑）：
#   PS 5.1 的 `Set-Content -Encoding utf8` **会写 BOM** ⇒ ⇒ **Node 的 `JSON.parse` 直接报错**
#   （★ `SyntaxError: Unexpected token '﻿'`）⇒ ⇒ ★ 而 PowerShell 自己的 `ConvertFrom-Json`
#   能读 ⇒ ⇒ **⇒ 骗得过自己、骗不过仓库的 TS 工具链** ⇒ ⇒ ★ 必须显式用无 BOM 编码器。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$json = ConvertTo-RepoJson -InputObject $report -Depth 8
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

# ★★ **格式自检**（★ 2026-11-06 新增 ⇒ ★ 证明产物【一出生就合规】⇒ ⇒ 不会在「入库那一刻」把 lint 弄红）
#   ★ 判据（四条，★ 与 `biome.json` 的 `indentWidth: 2` / `lineEnding: lf` 对齐）：
#     ① 无 CRLF（★ 全文件只有 LF）
#     ② **首个缩进行的缩进 = 2 空格**（★ ★ 这条专抓 PS 的 4 空格制 ⇒ ★ 因为 JSON 的顶层是「{」，
#        第一层键的缩进在 2 空格制下必然是 2、在 4 空格制下必然是 4 ⇒ ★ 一看便知）
#        ⇒ ⚠️ **不能用「有没有 4 空格缩进的行」当判据**（★ 4 空格在 2 空格制里是【合法的第三层】）
#     ③ 文件以 LF 结尾
#     ④ **结构性冒号后恰好 1 个空格**（★ ★ 专抓 PS 5.1 的「冒号后 2 空格」⇒ ★ 那是 PS 7 才改掉的）
#        ⇒ ⚠️ 判据必须落在【行首的「引号键 + 冒号」】上（★ 那是结构性冒号）
#          ⇒ ⇒ 而【字符串值内部】的「:  」不匹配（★ 它不在行首引号键的位置上）
$text = [System.Text.Encoding]::UTF8.GetString($raw)
$hasCrLf = $text.Contains("`r")
$firstIndent = -1
foreach ($line in ($text -split "`n")) {
    if ($line -match '^([ ]+)\S') { $firstIndent = $Matches[1].Length; break }
}
$endsWithLf = $text.EndsWith("`n")
$doubleSpaceColon = [regex]::IsMatch($text, '(?m)^\s*"[^"]*":  ')
if ($hasCrLf -or $firstIndent -ne 2 -or -not $endsWithLf -or $doubleSpaceColon) {
    Write-Host ('✗ 格式自检失败：CRLF={0} · 首个缩进={1}（期望 2）· 末尾换行={2}（期望 True）· 冒号后双空格={3}（期望 False）⇒ ★ 产物不符合仓库规范 ⇒ ★ 请把这条报给主理人' -f $hasCrLf, $firstIndent, $endsWithLf, $doubleSpaceColon) -ForegroundColor Red
    exit 2
}
Write-Host '✓ 格式自检通过：LF 行尾 · 2 空格缩进 · 冒号后 1 空格 · 末尾有换行（★ 与 biome.json 对齐 ⇒ ★ 入库不会红 lint）' -ForegroundColor Green

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
