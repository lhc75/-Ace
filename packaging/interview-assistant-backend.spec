# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.building.build_main import Analysis, COLLECT, EXE, PYZ
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)


ROOT = Path(SPECPATH).resolve().parent
BACKEND = ROOT / "backend"


def collect_package(name: str) -> tuple[list, list, list]:
    try:
        return (
            collect_data_files(name, include_py_files=True),
            collect_dynamic_libs(name),
            collect_submodules(name),
        )
    except Exception:
        # Optional packages differ slightly between Windows environments.
        return [], [], []


datas = [(str(BACKEND / "assets"), "assets")]
binaries = []
hiddenimports = [
    "services.capture._screen_capture_worker",
    "soundcard",
]

for package_name in (
    "uvicorn",
    "fastapi",
    "starlette",
    "pydantic",
    "pydantic_core",
    "faster_whisper",
    "ctranslate2",
    "onnxruntime",
    "tokenizers",
    "mss",
    "PIL",
    "fitz",
    "opencc",
    "websocket",
    "soundcard",
):
    package_datas, package_binaries, package_hiddenimports = collect_package(package_name)
    datas.extend(package_datas)
    binaries.extend(package_binaries)
    hiddenimports.extend(package_hiddenimports)


analysis = Analysis(
    [str(BACKEND / "packaged_entry.py")],
    pathex=[str(BACKEND)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "torch",
        "tensorflow",
    ],
    noarchive=False,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="interview-assistant-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Electron 启动时使用 windowsHide=true；保留标准流可支持截图 worker 输出。
    console=True,
)

coll = COLLECT(
    exe,
    analysis.binaries,
    analysis.zipfiles,
    analysis.datas,
    strip=False,
    upx=False,
    name="interview-assistant-backend",
)
