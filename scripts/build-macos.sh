#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
DESKTOP="$ROOT/desktop"
BUILD="$ROOT/build"
BACKEND_STAGE="$BUILD/backend"
PYINSTALLER_DIST="$BUILD/pyinstaller-dist"
PYINSTALLER_WORK="$BUILD/pyinstaller-work"
ICONSET="$BUILD/interview-assistant.iconset"
RELEASE_DIR="${MACOS_RELEASE_DIR:-$ROOT/release}"
# 优先使用本机 Electron 缓存，避免每次打包重新联网下载 Electron。
# 如需指定其他缓存目录，可在执行前设置 ELECTRON_CACHE / ELECTRON_BUILDER_CACHE。
export ELECTRON_CACHE="${ELECTRON_CACHE:-$HOME/Library/Caches/electron}"
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$HOME/Library/Caches/electron-builder}"
# Electron/校验文件默认走 npmmirror 国内镜像（GitHub 直连常超时）；
# 已在缓存中的版本不会触发下载。需要官方源时执行前设 ELECTRON_MIRROR=""。
export ELECTRON_MIRROR="${ELECTRON_MIRROR-https://npmmirror.com/mirrors/electron/}"
# 本地打包默认不自动签名，避免没有可用时间戳服务时阻断 DMG 生成。
# 发布签名时可通过 CSC_IDENTITY_AUTO_DISCOVERY=true 重新启用证书探测。
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

step() {
  printf '[...] %s\n' "$1"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[ERROR] macOS 打包脚本只能在 macOS 上运行。" >&2
  exit 1
fi

command -v npm >/dev/null 2>&1 || {
  echo "[ERROR] 未找到 npm，请先安装 Node.js 18+。" >&2
  exit 1
}

PYTHON="${ROOT}/env/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  SYSTEM_PYTHON="$(command -v python3 || true)"
  if [[ -z "$SYSTEM_PYTHON" ]]; then
    echo "[ERROR] 未找到 Python 3.10+。" >&2
    exit 1
  fi
  step "创建 Python 虚拟环境"
  "$SYSTEM_PYTHON" -m venv "$ROOT/env"
fi

if [[ ! -x "$PYTHON" ]]; then
  echo "[ERROR] 未找到 Python 3.10+。" >&2
  exit 1
fi

if [[ ! -d "$FRONTEND/node_modules" ]]; then
  step "安装前端依赖"
  npm --prefix "$FRONTEND" ci
fi

step "构建前端"
npm --prefix "$FRONTEND" run build

step "安装后端依赖"
"$PYTHON" -m pip install -r "$ROOT/backend/requirements.txt"

if [[ -d "$BACKEND_STAGE" ]]; then
  rm -rf "$BACKEND_STAGE"
fi
rm -rf "$PYINSTALLER_DIST" "$PYINSTALLER_WORK"
mkdir -p "$BACKEND_STAGE"

step "构建 macOS Python 后端（PyInstaller，快速打包）"
"$PYTHON" -m pip install --upgrade pyinstaller pyinstaller-hooks-contrib
"$PYTHON" -m PyInstaller \
  "$ROOT/packaging/interview-assistant-backend.spec" \
  --clean \
  --noconfirm \
  --distpath "$PYINSTALLER_DIST" \
  --workpath "$PYINSTALLER_WORK"

# PyInstaller final COLLECT output. Do not use $BUILD/interview-assistant-backend:
# that is the work directory containing .toc/.pkg intermediates, not the runnable app.
PYINSTALLER_OUT="$PYINSTALLER_DIST/interview-assistant-backend"
if [[ ! -d "$PYINSTALLER_OUT" ]]; then
  echo "[ERROR] PyInstaller未生成输出目录: $PYINSTALLER_OUT" >&2
  exit 1
fi

# Keep the PyInstaller onedir contents under build/backend/interview-assistant-backend,
# matching desktop/package.json extraResources and desktop/main.js.
mkdir -p "$BACKEND_STAGE/interview-assistant-backend"
cp -R "$PYINSTALLER_OUT/." "$BACKEND_STAGE/interview-assistant-backend/"

BACKEND_BIN="$BACKEND_STAGE/interview-assistant-backend/interview-assistant-backend"
if [[ ! -f "$BACKEND_BIN" ]]; then
  echo "[ERROR] PyInstaller 未生成后端可执行文件: $BACKEND_BIN" >&2
  exit 1
fi
chmod +x "$BACKEND_BIN"

step "校验后端运行目录"
"$PYTHON" "$ROOT/scripts/verify-backend-bundle.py" \
  "$BACKEND_STAGE/interview-assistant-backend" \
  --os mac

if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  step "生成 macOS 图标"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$DESKTOP/icon.png" \
      --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$DESKTOP/icon.png" \
      --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$DESKTOP/icon.icns"
else
  echo "[WARN] 未找到 iconutil/sips，将使用 Electron 默认应用图标。"
fi

step "安装桌面端依赖"
npm --prefix "$DESKTOP" ci

step "生成 macOS .dmg"
npm --prefix "$DESKTOP" run dist:mac -- --config.directories.output="$RELEASE_DIR" "$@"

step "校验 Electron 安装目录中的后端"
"$PYTHON" "$ROOT/scripts/verify-backend-bundle.py" \
  "$RELEASE_DIR/mac-arm64/面试Ace.app/Contents/Resources/backend" \
  --os mac

# electron-builder 固定会产出 blockmap（差量更新用）和 builder-debug.yml（调试信息），
# 发布只需要 dmg，打包完直接清掉。
rm -f "$RELEASE_DIR"/*.blockmap "$RELEASE_DIR"/builder-debug.yml

printf '\n[OK] macOS 打包完成，文件位于: %s\n' "$RELEASE_DIR"
