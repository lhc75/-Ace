#!/usr/bin/env bash
# 用 Nuitka 把后端编译为独立可执行文件（机器码，无 .pyc，不可直接反编译出源码）。
# 产物布局与 PyInstaller COLLECT 一致：
#   build/backend/interview-assistant-backend/interview-assistant-backend
# 这样 desktop/package.json 的 extraResources 与 desktop/main.js 的 spawn 逻辑无需改动。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
BACKEND_STAGE="$BUILD/backend"
TARGET="$BACKEND_STAGE/interview-assistant-backend"
WORK="$BUILD/nuitka-work"
PYTHON="${IA_PYTHON:-$ROOT/env/bin/python}"

step() {
  printf '[...] %s\n' "$1"
}

if [[ ! -x "$PYTHON" ]]; then
  echo "[ERROR] 未找到虚拟环境 Python: $PYTHON" >&2
  exit 1
fi

SP="$("$PYTHON" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"

step "安装 Nuitka"
"$PYTHON" -m pip install --upgrade nuitka ordered-set zstandard

ARGS=(
  --standalone
  --assume-yes-for-downloads
  --remove-output
  --jobs="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  --output-dir="$WORK"
  --output-filename=interview-assistant-backend
  # 截图 worker 通过 sys.executable --capture-worker 复用同一二进制，入口在函数内，显式包含
  --include-module=services.capture._screen_capture_worker
  # 第三方包的数据文件（词典/模板/随包 dylib 等）
  --include-package=opencc
  --include-package-data=opencc
  --include-package=pymupdf
  --include-package-data=pymupdf
  --include-package=av
  --include-package-data=av
  --include-package-data=ctranslate2
  --include-package-data=onnxruntime
  --include-package-data=faster_whisper
  --include-package-data=huggingface_hub
  --include-package-data=tokenizers
  # 后端资源（与 PyInstaller spec 的 datas 对齐）
  --include-data-dir="$ROOT/backend/assets=assets"
)

# 各 wheel 把原生库放在包内隐藏子目录，Nuitka 依赖扫描未必覆盖，逐一显式补齐
if [[ -d "$SP/ctranslate2/.dylibs" ]]; then
  ARGS+=(--include-data-dir="$SP/ctranslate2/.dylibs=ctranslate2/.dylibs")
fi
if [[ -d "$SP/av/.dylibs" ]]; then
  ARGS+=(--include-data-dir="$SP/av/.dylibs=av/.dylibs")
fi

# Nuitka 内置 sounddevice 配置在 macOS 上按前缀 libportaudio 拷贝 DLL，会误伤目录里
# 混放的 Windows DLL（架构不符直接 FATAL）。编译期间临时挪走，结束无论成败都还原。
PORTAUDIO_DIR="$SP/_sounddevice_data/portaudio-binaries"
MOVED_DLLS=()
if [[ -d "$PORTAUDIO_DIR" ]]; then
  for dll in "$PORTAUDIO_DIR"/*.dll; do
    [[ -e "$dll" ]] || continue
    mv "$dll" "$dll.nuitka-skip"
    MOVED_DLLS+=("$dll")
  done
fi
restore_dlls() {
  for dll in ${MOVED_DLLS[@]+"${MOVED_DLLS[@]}"}; do
    if [[ -f "$dll.nuitka-skip" ]]; then
      mv "$dll.nuitka-skip" "$dll"
    fi
  done
}
trap restore_dlls EXIT
# soundcard 是 Windows 专用系统音频库，装了才带
if "$PYTHON" -c 'import soundcard' >/dev/null 2>&1; then
  ARGS+=(--include-module=soundcard)
fi

step "编译后端（Nuitka standalone，首次约需几十分钟）"
(cd "$ROOT/backend" && "$PYTHON" -m nuitka "${ARGS[@]}" packaged_entry.py)

DIST="$WORK/packaged_entry.dist"
# macOS 上 Nuitka 把可执行文件产出为 <name>.bin，改回 desktop/main.js 期望的名字
if [[ -f "$DIST/interview-assistant-backend.bin" ]]; then
  mv "$DIST/interview-assistant-backend.bin" "$DIST/interview-assistant-backend"
fi
if [[ ! -f "$DIST/interview-assistant-backend" ]]; then
  echo "[ERROR] Nuitka 未生成后端可执行文件: $DIST/interview-assistant-backend" >&2
  exit 1
fi

if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
fi
mkdir -p "$BACKEND_STAGE"
mv "$DIST" "$TARGET"
rm -rf "$WORK"
chmod +x "$TARGET/interview-assistant-backend"

step "校验产物不含 .pyc"
if find "$TARGET" -name '*.pyc' -print -quit | grep -q .; then
  echo "[ERROR] 产物中仍存在 .pyc 文件" >&2
  exit 1
fi

printf '\n[OK] Nuitka 后端产物: %s\n' "$TARGET"
