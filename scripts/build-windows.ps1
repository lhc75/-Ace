$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $root "frontend"
$desktop = Join-Path $root "desktop"
$build = Join-Path $root "build"
$backendStage = Join-Path $build "backend"

function Invoke-Step([string]$label, [scriptblock]$action) {
    Write-Host "[...] $label"
    & $action
    if ($LASTEXITCODE -ne 0) {
        throw "$label 失败，退出码: $LASTEXITCODE"
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "未找到 npm，请先安装 Node.js 18+。"
}

$projectPython = Join-Path $root "env\Scripts\python.exe"
if (Test-Path $projectPython) {
    $pythonExe = $projectPython
    $pythonPrefix = @()
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $pythonExe = "py"
    $pythonPrefix = @("-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonExe = "python"
    $pythonPrefix = @()
} else {
    throw "未找到 Python 3.10+。"
}

if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Invoke-Step "安装前端依赖" { npm --prefix $frontend ci }
}
Invoke-Step "构建前端" { npm --prefix $frontend run build }

Invoke-Step "安装后端依赖" {
    & $pythonExe @pythonPrefix -m pip install -r (Join-Path $root "backend\requirements.txt")
}

Invoke-Step "安装 Windows 系统音频依赖" {
    & $pythonExe @pythonPrefix -m pip install soundcard
}

if (Test-Path $backendStage) {
    Remove-Item $backendStage -Recurse -Force
}
New-Item -ItemType Directory -Path $backendStage -Force | Out-Null

Invoke-Step "构建 Python 后端（PyInstaller，快速打包）" {
    & $pythonExe @pythonPrefix -m pip install --upgrade pyinstaller pyinstaller-hooks-contrib
    & $pythonExe @pythonPrefix -m PyInstaller (Join-Path $root "packaging\interview-assistant-backend.spec") --clean --noconfirm
    $distPath = Join-Path $build "interview-assistant-backend"
    if (-not (Test-Path $distPath)) {
        throw "PyInstaller 未生成后端可执行文件"
    }
    Move-Item $distPath $backendStage -Force
}

Invoke-Step "安装桌面端依赖" { npm --prefix $desktop ci }

Invoke-Step "生成 Windows 安装包和便携版" {
    npm --prefix $desktop run dist:win
}

Write-Host ""
Write-Host "[OK] 打包完成，文件位于: $(Join-Path $root 'release')"
