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
    Start-Sleep -Seconds 1
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
    
    # 将备份目录覆盖回安装目录
    Copy-Item -Path "$BackupDir\*" -Destination $TargetDir -Recurse -Force
    Write-Host "✓ 已成功回滚至备份版本！" -ForegroundColor Green
    if (-not $NoRestart) {
        Start-App
    }
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

    # 停止进程并替换
    Stop-RunningApp

    $destEngine = Join-Path $TargetDir "resources\engine"
    Write-Host "正在替换引擎文件 -> $destEngine..." -ForegroundColor Cyan
    if (Test-Path $destEngine) {
        Remove-Item -Recurse -Force $destEngine
    }
    New-Item -ItemType Directory -Force -Path $destEngine | Out-Null
    Copy-Item -Recurse "dist_engine\MaskitEngine\_internal" "$destEngine\_internal"
    Copy-Item "dist_engine\MaskitEngine\MaskitEngine.exe" "$destEngine\MaskitEngine.exe"

    Write-Host "✓ 引擎更新完成！" -ForegroundColor Green
    if (-not $NoRestart) {
        Start-App
    }
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

# 3. 同步到 Tauri 打包源目录
$srcEngine = "src-tauri\resources\engine"
if (Test-Path $srcEngine) { Remove-Item -Recurse -Force $srcEngine }
New-Item -ItemType Directory -Force -Path $srcEngine | Out-Null
Copy-Item -Recurse "dist_engine\MaskitEngine\_internal" "$srcEngine\_internal"
Copy-Item "dist_engine\MaskitEngine\MaskitEngine.exe" "$srcEngine\MaskitEngine.exe"

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

# 5. 替换到本地安装目录
Stop-RunningApp
Write-Host "正在替换安装目录全部文件 -> $TargetDir..." -ForegroundColor Cyan
Copy-Item -Path "src-tauri\target\release\Maskit.exe" -Destination "$TargetDir\Maskit.exe" -Force

$destEngine = Join-Path $TargetDir "resources\engine"
if (Test-Path $destEngine) { Remove-Item -Recurse -Force $destEngine }
New-Item -ItemType Directory -Force -Path $destEngine | Out-Null
Copy-Item -Recurse "dist_engine\MaskitEngine\_internal" "$destEngine\_internal"
Copy-Item "dist_engine\MaskitEngine\MaskitEngine.exe" "$destEngine\MaskitEngine.exe"

Write-Host "✓ 全量更新完成！" -ForegroundColor Green

# 6. 打包最新浏览器扩展
Write-Host "`n打包最新浏览器扩展..." -ForegroundColor Yellow
& $py313 scripts\pack-extension.py
Write-Host "扩展打包完成（dist_extension 目录）" -ForegroundColor Cyan

if (-not $NoRestart) {
    Start-App
}
Write-Host "`n=== 本地全量部署成功！已成功应用全部前端与客户端改动 ===" -ForegroundColor Green
