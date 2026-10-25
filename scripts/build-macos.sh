#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
DESKTOP="$ROOT/desktop"
BUILD="$ROOT/build"
BACKEND_STAGE="$BUILD/backend"
ICONSET="$BUILD/interview-assistant.iconset"
RELEASE_DIR="${MACOS_RELEASE_DIR:-$ROOT/release}"
# 优先使用本机 Electron 缓存，避免每次打包重新联网下载 Electron。
# 如需指定其他缓存目录，可在执行前设置 ELECTRON_CACHE。
export ELECTRON_CACHE="${ELECTRON_CACHE:-$HOME/Library/Caches/electron}"
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
mkdir -p "$BACKEND_STAGE"

step "构建 macOS Python 后端（Nuitka，编译为机器码）"
"$ROOT/scripts/build-backend-nuitka.sh"

BACKEND_BIN="$BACKEND_STAGE/interview-assistant-backend/interview-assistant-backend"
if [[ ! -f "$BACKEND_BIN" ]]; then
  echo "[ERROR] PyInstaller 未生成后端可执行文件: $BACKEND_BIN" >&2
  exit 1
fi
chmod +x "$BACKEND_BIN"

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

# electron-builder 固定会产出 blockmap（差量更新用）和 builder-debug.yml（调试信息），
# 发布只需要 dmg，打包完直接清掉。
rm -f "$RELEASE_DIR"/*.blockmap "$RELEASE_DIR"/builder-debug.yml

printf '\n[OK] macOS 打包完成，文件位于: %s\n' "$RELEASE_DIR"
