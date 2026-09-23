# scripts/local-dev-deploy.ps1
# 本地极速部署与回滚脚本 (Local Dev Hot Update & Rollback)
#
# 适用场景：本地开发、调试脱敏/还原/NER/扩展逻辑，免去发版等待与重复安装
# 用法：
#   .\scripts\local-dev-deploy.ps1             # 默认快速更新引擎 (约15~20秒，只打包并替换 Python 引擎)
#   .\scripts\local-dev-deploy.ps1 -Full       # 全量更新 (前端 + 引擎 + Tauri 桌面壳)
#   .\scripts\local-dev-deploy.ps1 -Restore    # 一键回滚到上一个备份版本
#   .\scripts\local-dev-deploy.ps1 -TargetDir "<你的安装目录>" # 指定安装路径

param(
    [string]$TargetDir = "",
    [string]$Python = "",
    [switch]$Full,
    [switch]$Restore,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

# 1. 自动探测目标安装路径
if (-not $TargetDir) {
    # 优先检测当前运行中进程的路径
    $proc = Get-Process -Name "Maskit" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.Path) {
        $TargetDir = Split-Path -Parent $proc.Path
    } elseif ($env:MASKIT_INSTALL_DIR -and (Test-Path (Join-Path $env:MASKIT_INSTALL_DIR "Maskit.exe"))) {
        $TargetDir = $env:MASKIT_INSTALL_DIR
    } elseif (Test-Path "$env:LOCALAPPDATA\Programs\Maskit\Maskit.exe") {
        $TargetDir = "$env:LOCALAPPDATA\Programs\Maskit"
    } else {
        Write-Error "未能自动定位 Maskit 安装目录，请通过 -TargetDir 参数或 MASKIT_INSTALL_DIR 环境变量显式指定，例如：-TargetDir 'C:\Tools\Maskit'"
        exit 1
    }
}

$TargetDir = [System.IO.Path]::GetFullPath($TargetDir)
$BackupDir = "${TargetDir}_backup"
Write-Host "目标目录: $TargetDir" -ForegroundColor Cyan

# 终止运行中的进程
function Stop-RunningApp {
    Write-Host "正在停止运行中的 Maskit 进程..." -ForegroundColor Yellow
    foreach ($name in @("Maskit", "MaskitEngine", "LLMShield", "llm-shield", "LLMShieldEngine")) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    # 彻底清理残留的 mitmdump
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
             Select-Object ProcessId, Name, CommandLine)
    foreach ($p in $all) {
        if ($p.Name -like "*Maskit*" -or ($p.Name -eq "mitmdump.exe" -and $p.CommandLine -like "*transparent.py*")) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    [void](Wait-AppExited)
}

# ── 替换阶段的安全底座（2026-09-22 停机事故修复）─────────────────────────
# 事故复盘：Stop-RunningApp 只 `Start-Sleep -Seconds 1` 就去 `Remove-Item -Recurse`
# 引擎目录，Windows 上 exe 句柄往往还没释放 → 删除抛错（$ErrorActionPreference="Stop"）
# → 脚本在「替换」中途中止；而 Start-App 是脚本**最后一行**，中止后再没执行
# → 客户端与引擎被留在停机状态（实测约 16 分钟不可用，用户视角就是「程序炸了」）。
# 三处加固，缺一不可：
#   ① 等进程**真的退出**（Stop-Process 返回 ≠ 句柄已释放）——Wait-AppExited；
#   ② 删除/覆盖**退避重试**（占用是暂时态）——Remove-PathWithRetry / Copy-FileWithRetry；
#   ③ 替换段包在 try/finally 里：**失败也一定把客户端拉回来**，并尽力回滚备份
#      ——Invoke-SwapGuarded；同时把「先删后拷」改成「先落到旁边暂存再换名就位」，
#      让「安装目录里没有引擎」的窗口缩短成一次重命名，拷贝失败时旧引擎还在。

# 等 Maskit 相关进程真正退出；返回是否在超时前全部退出。
function Wait-AppExited {
    param([int]$TimeoutSec = 20)
    $names = @("Maskit", "MaskitEngine", "LLMShield", "llm-shield", "LLMShieldEngine")
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $alive = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
        $md = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq "mitmdump.exe" -and $_.CommandLine -like "*transparent.py*" })
        if ($alive.Count -eq 0 -and $md.Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    }
    Write-Warning "等待进程退出超时（$TimeoutSec 秒）；继续尝试替换（可能因句柄未释放而失败）"
    return $false
}

# 删除目录/文件：被占用的句柄是**暂时态**，退避重试能过；仍失败才抛错。
function Remove-PathWithRetry {
    param([Parameter(Mandatory)][string]$Path, [int]$TimeoutSec = 20)
    if (-not (Test-Path $Path)) { return }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $last = ""
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        try {
            Remove-Item -Recurse -Force $Path -ErrorAction Stop
            return
        } catch {
            $last = $_.Exception.Message
            Start-Sleep -Milliseconds 400
        }
    }
    throw "删除失败（重试 $TimeoutSec 秒仍被占用）：$Path | $last"
}

# 覆盖单个文件：同样重试（例如客户端被看门狗拉起，Maskit.exe 又被占用）。
function Copy-FileWithRetry {
    param([Parameter(Mandatory)][string]$Source,
          [Parameter(Mandatory)][string]$Destination,
          [int]$TimeoutSec = 20)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $last = ""
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        try {
            Copy-Item -Path $Source -Destination $Destination -Force -ErrorAction Stop
            return
        } catch {
            $last = $_.Exception.Message
            Start-Sleep -Milliseconds 400
        }
    }
    throw "覆盖文件失败（重试 $TimeoutSec 秒仍被占用）：$Destination | $last"
}

# 把「引擎产物目录」装到目标位置：**先落到 $Dest.new 暂存，再换名就位**。
# 与旧的「先 Remove-Item 目标目录再拷」相比：拷贝失败时目标目录毫发无损
# （旧写法的中间态是「安装目录里没有引擎」——那才是真把程序搞坏）。
function Install-EngineDir {
    param([Parameter(Mandatory)][string]$SourceDir, [Parameter(Mandatory)][string]$DestDir)
    $stage = "$DestDir.new"
    Remove-PathWithRetry $stage
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item -Recurse (Join-Path $SourceDir "_internal") (Join-Path $stage "_internal")
    Copy-Item (Join-Path $SourceDir "MaskitEngine.exe") (Join-Path $stage "MaskitEngine.exe")
    if (-not (Test-Path (Join-Path $stage "MaskitEngine.exe"))) {
        throw "暂存目录缺少 MaskitEngine.exe：$stage"
    }
    Remove-PathWithRetry $DestDir
    Move-Item -Path $stage -Destination $DestDir
    if (-not (Test-Path (Join-Path $DestDir "MaskitEngine.exe"))) {
        throw "替换后校验失败，缺少 $DestDir\MaskitEngine.exe"
    }
}

# 从备份回滚（尽力而为；没备份要明确告警，不能让异常吞掉这条信息）。
function Restore-FromBackup {
    if (-not (Test-Path $BackupDir)) {
        Write-Warning "没有可用备份，无法回滚：$BackupDir"
        return $false
    }
    Write-Host "正在从备份回滚 -> $TargetDir..." -ForegroundColor Yellow
    Copy-FileWithRetry (Join-Path $BackupDir "Maskit.exe") (Join-Path $TargetDir "Maskit.exe")
    Install-EngineDir -SourceDir (Join-Path $BackupDir "resources\engine") -DestDir (Join-Path $TargetDir "resources\engine")
    Write-Host "✓ 已回滚到备份版本" -ForegroundColor Green
    return $true
}

# 替换段的统一守卫：无论成功还是异常，**都保证客户端被拉起**（除非 -NoRestart）。
# 这是本次事故的核心修复——旧脚本把 Start-App 放在最后一行，中途抛错
# 用户得到的就是一台被停掉的客户端，而不是「失败但还能用」。
function Invoke-SwapGuarded {
    param([Parameter(Mandatory)][scriptblock]$Action,
          [string]$Label = "替换安装文件",
          [switch]$NoRollback)
    try {
        & $Action
    } catch {
        Write-Warning "$Label 失败：$($_.Exception.Message)"
        if (-not $NoRollback) {
            Write-Warning "尝试从备份回滚（$BackupDir）..."
            try { [void](Restore-FromBackup) } catch { Write-Warning "回滚也失败：$($_.Exception.Message)" }
        }
        throw
    } finally {
        if (-not $NoRestart) { Start-App }
    }
}

# 启动应用程序
function Start-App {
    $exe = Join-Path $TargetDir "Maskit.exe"
    if (Test-Path $exe) {
        Write-Host "正在重新拉起 Maskit ($exe)..." -ForegroundColor Green
        Start-Process -FilePath $exe
    } else {
        Write-Host "未找到可执行文件: $exe" -ForegroundColor Red
    }
}

# ─── 回滚模式 (-Restore) ───
if ($Restore) {
    if (-not (Test-Path $BackupDir)) {
        Write-Error "未找到备份目录: $BackupDir，无法回滚！"
        exit 1
    }
    Write-Host "正在执行一键回滚..." -ForegroundColor Cyan
    Stop-RunningApp

    # 逐个文件装回去（-NoRollback：回滚本身就是目的地，没有更早的版本可退）
    Invoke-SwapGuarded -Label "回滚" -NoRollback {
        Copy-FileWithRetry (Join-Path $BackupDir "Maskit.exe") (Join-Path $TargetDir "Maskit.exe")
        Install-EngineDir -SourceDir (Join-Path $BackupDir "resources\engine") -DestDir (Join-Path $TargetDir "resources\engine")
    }
    Write-Host "✓ 已成功回滚至备份版本！" -ForegroundColor Green
    exit 0
}

# ─── 更新前自动备份 ───
Write-Host "创建更新备份 -> $BackupDir..." -ForegroundColor DarkGray
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}
# 快速镜像核心程序与引擎，排除事件库和临时日志
Copy-Item -Path "$TargetDir\Maskit.exe" -Destination "$BackupDir\Maskit.exe" -Force -ErrorAction SilentlyContinue
if (Test-Path "$TargetDir\resources\engine") {
    if (-not (Test-Path "$BackupDir\resources\engine")) {
        New-Item -ItemType Directory -Force -Path "$BackupDir\resources\engine" | Out-Null
    }
    Copy-Item -Path "$TargetDir\resources\engine\*" -Destination "$BackupDir\resources\engine" -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "✓ 备份已就绪 (随时可用 -Restore 一键回滚)" -ForegroundColor DarkGray

# ─── 编译准备 ───
# 探测 Python 3.13 解释器。
#
# ⚠️ 只判「能不能找到 python」是不够的：打包引擎需要 flask + mitmproxy，
# 缺了它们 PyInstaller 会**静默产出一个启动即崩的引擎**（缺模块），而替换动作
# 发生在打包成功之后 —— 用户客户端会被换成一个跑不起来的版本。
# 实测某些机器上 `py -3.13` 指向的解释器就没有 mitmproxy，而它恰恰排在候选列表第一位。
# 所以候选解释器必须**逐个校验依赖**，第一个通过的才用。
$pyCandidates = @()
if ($Python) { $pyCandidates += $Python }
if ($env:MASKIT_PYTHON) { $pyCandidates += $env:MASKIT_PYTHON }
# ⚠️ 必须先确认命令**存在**再调用：`py` / `python` 在某些环境（实测本机 PowerShell）
# 根本没进 PATH，而脚本开了 $ErrorActionPreference = "Stop"，
# 「术语 'py' 不会被识别为 cmdlet」会直接抛错，整个部署在探测阶段就崩掉。
#
# 显式带上 `-3.13` / `-3` 再落到默认档：裸 `py` 与 `python` 都可能指向别的版本
# （实测本机裸 `py` / `python` 都是 3.14），只靠后面的依赖校验过滤会白白多一轮。
$pyProbes = @()
$pyProbes += ,@("py", "-3.13")
$pyProbes += ,@("py", "-3")
$pyProbes += ,@("py")
$pyProbes += ,@("python")
foreach ($spec in $pyProbes) {
    if (-not (Get-Command $spec[0] -ErrorAction SilentlyContinue)) { continue }
    $extra = @()
    if ($spec.Count -gt 1) { $extra = $spec[1..($spec.Count - 1)] }
    try {
        $probe = & $spec[0] @extra -c "import sys; print(sys.executable)" 2>$null
        if ($probe) { $pyCandidates += $probe.Trim() }
    } catch { }
}
foreach ($venvRel in @(".venv\Scripts\python.exe", "venv\Scripts\python.exe")) {
    $vp = Join-Path $Root $venvRel
    if (Test-Path $vp) { $pyCandidates += $vp }
}

$py313 = $null
foreach ($cand in ($pyCandidates | Select-Object -Unique)) {
    if (-not (Test-Path $cand)) { continue }
    # 判定用「退出码 0」+「独占一行的标记」**双判据**。
    # 不能只靠 $LASTEXITCODE：实测它在 `2>$null` 重定向之后不可靠；
    # 也不能只匹配文本 —— 原因见下。
    $probeOut = ""
    $probeCode = 1
    try {
        $probeOut = (& $cand -c "import sys, flask, mitmproxy, PyInstaller; assert sys.version_info[:2] == (3, 13); print('MASKIT_PY_OK')" 2>&1 | Out-String)
        $probeCode = $LASTEXITCODE
    } catch { $probeOut = ""; $probeCode = 1 }
    # ⚠️ 不能只 `-match 'MASKIT_PY_OK'`：校验失败时 Python 的 Traceback 会把**源码行**
    # 原样回显到 stderr，而那行里就含 `'MASKIT_PY_OK'` 字面量 —— 于是**每个**候选都被
    # 判成「通过」，选中一个缺 PyInstaller 的解释器，直到打包阶段才炸
    # （实测踩过：3.14 被选中，报 `No module named PyInstaller`）。
    # 用「退出码 0」+「独占一行的标记」双判据：只有真正跑到 print 才会有后者。
    if ($probeCode -eq 0 -and $probeOut -match '(?m)^\s*MASKIT_PY_OK\s*$') { $py313 = $cand; break }
    Write-Host "  跳过 $cand（缺 flask / mitmproxy / PyInstaller，或非 3.13）" -ForegroundColor DarkYellow
}
if (-not $py313) {
    Write-Error "未找到带 flask + mitmproxy + PyInstaller 的 Python 3.13。请用 -Python 显式指定，例如：-Python 'C:\path\to\venv\Scripts\python.exe'"
    exit 1
}
Write-Host "Python 解释器: $py313" -ForegroundColor DarkGray

# ─── 模式 A：快速更新引擎 (Fast Mode, 约15~20秒) ───
if (-not $Full) {
    Write-Host "`n=== [快速模式] 构建 Python 引擎 Sidecar ===" -ForegroundColor Cyan
    
    # 快速语法自检
    & $py313 -m py_compile engine/transparent.py engine/panel.py engine/engine_entry.py
    if ($LASTEXITCODE -ne 0) { Write-Error "Python 代码语法检查失败，终止部署"; exit 1 }

    if (Test-Path "dist_engine") { Remove-Item -Recurse -Force "dist_engine" }
    if (Test-Path "build_engine") { Remove-Item -Recurse -Force "build_engine" }

    Write-Host "正在打包 PyInstaller 引擎..." -ForegroundColor Yellow
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $py313 -m PyInstaller engine\maskit-engine.spec --noconfirm --distpath dist_engine --workpath build_engine 2>&1 | Write-Host
    $pyiExit = $LASTEXITCODE
    $ErrorActionPreference = $oldEAP
    if ($pyiExit -ne 0 -or -not (Test-Path "dist_engine\MaskitEngine\MaskitEngine.exe")) {
        Write-Error "PyInstaller 打包失败"
        exit 1
    }

    # 停止进程并替换（守卫内执行：失败也一定把客户端拉回来，见 Invoke-SwapGuarded）
    Stop-RunningApp

    $destEngine = Join-Path $TargetDir "resources\engine"
    Write-Host "正在替换引擎文件 -> $destEngine..." -ForegroundColor Cyan
    Invoke-SwapGuarded -Label "引擎替换到安装目录" {
        Install-EngineDir -SourceDir (Join-Path $Root "dist_engine\MaskitEngine") -DestDir $destEngine
    }

    Write-Host "✓ 引擎更新完成！" -ForegroundColor Green
    Write-Host "`n=== 本地极速更新成功！耗时约 20 秒 ===" -ForegroundColor Green
    exit 0
}

# ─── 模式 B：全量更新 (Full Mode: 前端 + 引擎 + Tauri 壳) ───
Write-Host "`n=== [全量模式] 构建前端 + 引擎 + Tauri 桌面壳 ===" -ForegroundColor Cyan

# 1. 构建前端
Write-Host "构建前端 (npm run build)..." -ForegroundColor Yellow
Set-Location "$Root\frontend"
$env:CODEBUDDY_SAFE_DELETE_ENABLED = "0"
npm run build
if ($LASTEXITCODE -ne 0) { Set-Location $Root; Write-Error "前端构建失败"; exit 1 }
Set-Location $Root

# 2. 打包引擎
if (Test-Path "dist_engine") { Remove-Item -Recurse -Force "dist_engine" }
if (Test-Path "build_engine") { Remove-Item -Recurse -Force "build_engine" }
Write-Host "打包 PyInstaller 引擎..." -ForegroundColor Yellow
$oldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $py313 -m PyInstaller engine\maskit-engine.spec --noconfirm --distpath dist_engine --workpath build_engine 2>&1 | Write-Host
$pyiExit = $LASTEXITCODE
$ErrorActionPreference = $oldEAP
if ($pyiExit -ne 0) { Write-Error "PyInstaller 打包失败"; exit 1 }

# 3. 同步到 Tauri 打包源目录（复用 Install-EngineDir：带占用重试 + 暂存换名，
#    避免源目录被删到一半；此处客户端仍在运行，失败也只影响构建，不影响你的安装）
$srcEngine = Join-Path $Root "src-tauri\resources\engine"
Install-EngineDir -SourceDir (Join-Path $Root "dist_engine\MaskitEngine") -DestDir $srcEngine

# 4. 构建 Tauri 壳
Write-Host "构建 Tauri 桌面客户端..." -ForegroundColor Yellow
$tauriCli = Join-Path $Root "frontend\node_modules\.bin\tauri.cmd"
if (-not (Test-Path $tauriCli)) {
    Write-Error "找不到 tauri CLI: $tauriCli（请先在 frontend 下 npm install）"
    exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c `"$tauriCli`" build --no-bundle"
$psi.WorkingDirectory = $Root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] = ""
$proc = [System.Diagnostics.Process]::Start($psi)
$so = $proc.StandardOutput.ReadToEndAsync()
$se = $proc.StandardError.ReadToEndAsync()
$proc.WaitForExit()
$tauriText = $so.Result + "`n" + $se.Result
Write-Host $tauriText
if ($proc.ExitCode -ne 0) {
    Write-Error "Tauri 编译失败"
    exit 1
}

# 5. 替换到本地安装目录（守卫内执行：失败也一定把客户端拉回来，见 Invoke-SwapGuarded）
Stop-RunningApp
Write-Host "正在替换安装目录全部文件 -> $TargetDir..." -ForegroundColor Cyan
$destEngine = Join-Path $TargetDir "resources\engine"
Invoke-SwapGuarded -Label "全量替换到安装目录" {
    Copy-FileWithRetry (Join-Path $Root "src-tauri\target\release\Maskit.exe") (Join-Path $TargetDir "Maskit.exe")
    Install-EngineDir -SourceDir (Join-Path $Root "dist_engine\MaskitEngine") -DestDir $destEngine
}

Write-Host "✓ 全量更新完成！" -ForegroundColor Green

# 6. 打包最新浏览器扩展（客户端已在守卫的 finally 里拉起，扩展打包与它无关）
Write-Host "`n打包最新浏览器扩展..." -ForegroundColor Yellow
& $py313 scripts\pack-extension.py
Write-Host "扩展打包完成（dist_extension 目录）" -ForegroundColor Cyan

Write-Host "`n=== 本地全量部署成功！已成功应用全部前端与客户端改动 ===" -ForegroundColor Green
