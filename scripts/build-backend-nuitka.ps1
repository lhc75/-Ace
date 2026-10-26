# 用 Nuitka 把后端编译为独立可执行文件（机器码，无 .pyc，不可直接反编译出源码）。
# 产物布局与 PyInstaller COLLECT 一致：
#   build/backend/interview-assistant-backend/interview-assistant-backend.exe
# 这样 desktop/package.json 的 extraResources 与 desktop/main.js 的 spawn 逻辑无需改动。
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root "build"
$backendStage = Join-Path $build "backend"
$target = Join-Path $backendStage "interview-assistant-backend"
$work = Join-Path $build "nuitka-work"
$pythonExe = Join-Path $root "env\Scripts\python.exe"

function Invoke-Step([string]$label, [scriptblock]$action) {
    Write-Host "[...] $label"
    & $action
    if ($LASTEXITCODE -ne 0) {
        throw "$label 失败，退出码: $LASTEXITCODE"
    }
}

if (-not (Test-Path $pythonExe)) {
    throw "未找到虚拟环境 Python: $pythonExe"
}

$sp = & $pythonExe -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"

Invoke-Step "安装 Nuitka" {
    & $pythonExe -m pip install --upgrade nuitka ordered-set zstandard
}

$nuitkaArgs = @(
    "--standalone",
    "--assume-yes-for-downloads",
    "--remove-output",
    "--jobs=$env:NUMBER_OF_PROCESSORS",
    "--output-dir=$work",
    "--output-filename=interview-assistant-backend",
    # PyInstaller spec 里 console=True 的等价配置（Electron 以 windowsHide 启动）
    "--windows-console-mode=force",
    # 截图 worker 通过 sys.executable --capture-worker 复用同一二进制，入口在函数内，显式包含
    "--include-module=services.capture._screen_capture_worker",
    # 第三方包的数据文件（词典/模板/随包 DLL 等）
    "--include-package=opencc",
    "--include-package-data=opencc",
    "--include-package=pymupdf",
    "--include-package-data=pymupdf",
    "--include-package=av",
    "--include-package-data=av",
    "--include-package-data=ctranslate2",
    "--include-package-data=onnxruntime",
    "--include-package-data=faster_whisper",
    "--include-package-data=huggingface_hub",
    "--include-package-data=tokenizers",
    # 打包环境无系统 CA 证书，certifi 的 cacert.pem 必须随包（packaged_entry 会指向它）
    "--include-package-data=certifi",
    # 后端资源（与 PyInstaller spec 的 datas 对齐）
    "--include-data-dir=$(Join-Path $root 'backend\assets')=assets"
)

# 各 wheel 把原生库放在包内隐藏子目录，Nuitka 依赖扫描未必覆盖，逐一显式补齐
$nativeDirs = @(
    @("$sp\ctranslate2\bin", "ctranslate2\bin"),
    @("$sp\ctranslate2.libs", "ctranslate2.libs"),
    @("$sp\av.libs", "av.libs")
)
foreach ($entry in $nativeDirs) {
    if (Test-Path $entry[0]) {
        $nuitkaArgs += "--include-data-dir=$($entry[0])=$($entry[1])"
    }
}
# Nuitka 内置 sounddevice 配置在 Windows x64 上只带 libportaudio64bit*.dll，无需额外处理
# soundcard 是 Windows 专用系统音频库，装了才带
& $pythonExe -c "import soundcard" 2>$null
if ($LASTEXITCODE -eq 0) {
    $nuitkaArgs += "--include-module=soundcard"
}

Invoke-Step "编译后端（Nuitka standalone，首次约需几十分钟）" {
    Push-Location (Join-Path $root "backend")
    try {
        & $pythonExe -m nuitka @nuitkaArgs packaged_entry.py
    } finally {
        Pop-Location
    }
}

$dist = Join-Path $work "packaged_entry.dist"
$exe = Join-Path $dist "interview-assistant-backend.exe"
if (-not (Test-Path $exe)) {
    throw "Nuitka 未生成后端可执行文件: $exe"
}

if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
}
New-Item -ItemType Directory -Path $backendStage -Force | Out-Null
Move-Item $dist $target
Remove-Item $work -Recurse -Force

Write-Host "[...] 校验产物不含 .pyc"
if (Get-ChildItem $target -Recurse -Filter *.pyc -ErrorAction SilentlyContinue | Select-Object -First 1) {
    throw "产物中仍存在 .pyc 文件"
}

Write-Host ""
Write-Host "[OK] Nuitka 后端产物: $target"
