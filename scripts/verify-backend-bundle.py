#!/usr/bin/env python3
"""Fail the release build when PyInstaller's intermediate work directory is packaged."""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path


MIN_FILES = {"mac": 100, "win": 50}
MIN_NATIVE_FILES = {"mac": 30, "win": 20}
NATIVE_SUFFIXES = {
    "mac": {".so", ".dylib"},
    "win": {".pyd", ".dll"},
}
INTERMEDIATE_SUFFIXES = {".toc", ".pkg", ".pyz"}


def fail(message: str) -> None:
    print(f"[ERROR] {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--os", choices=("mac", "win"), required=True)
    parser.add_argument("--skip-smoke", action="store_true")
    args = parser.parse_args()

    bundle = args.bundle.resolve()
    if not bundle.is_dir():
        fail(f"后端运行目录不存在: {bundle}")

    executable = bundle / (
        "interview-assistant-backend.exe"
        if args.os == "win"
        else "interview-assistant-backend"
    )
    if not executable.is_file():
        fail(f"后端可执行文件不存在: {executable}")

    root_files = [path for path in bundle.iterdir() if path.is_file()]
    intermediates = [
        path.name
        for path in root_files
        if path.suffix.lower() in INTERMEDIATE_SUFFIXES
        or path.name.startswith(("warn-", "xref-"))
    ]
    if intermediates:
        fail(
            "检测到 PyInstaller 中间产物，说明打包目录取错: "
            + ", ".join(sorted(intermediates))
        )

    all_files = [path for path in bundle.rglob("*") if path.is_file()]
    native_files = [
        path for path in all_files if path.suffix.lower() in NATIVE_SUFFIXES[args.os]
    ]
    if len(all_files) < MIN_FILES[args.os]:
        fail(
            f"后端文件不完整: {len(all_files)} files, "
            f"expected at least {MIN_FILES[args.os]}"
        )
    if len(native_files) < MIN_NATIVE_FILES[args.os]:
        fail(
            f"后端原生依赖不完整: {len(native_files)} native files, "
            f"expected at least {MIN_NATIVE_FILES[args.os]}"
        )

    if args.os == "mac" and not any(path.name == "Python" for path in all_files):
        fail("macOS 后端缺少 Python 运行时")
    if args.os == "win" and not any(
        path.name.lower().startswith("python") and path.suffix.lower() == ".dll"
        for path in all_files
    ):
        fail("Windows 后端缺少 Python 运行时")

    if not args.skip_smoke:
        try:
            # PyInstaller's multiprocessing helper can inherit pipe handles and
            # outlive the parent briefly. Capture to files so communicate() does
            # not wait for an unrelated inherited pipe to close.
            with (
                tempfile.TemporaryFile(mode="w+") as stdout_file,
                tempfile.TemporaryFile(mode="w+") as stderr_file,
            ):
                result = subprocess.run(
                    [str(executable), "--self-test"],
                    stdout=stdout_file,
                    stderr=stderr_file,
                    text=True,
                    timeout=45,
                    check=False,
                )
                stdout_file.seek(0)
                stderr_file.seek(0)
                stdout = stdout_file.read()
                stderr = stderr_file.read()
        except (OSError, subprocess.TimeoutExpired) as exc:
            fail(f"后端可执行文件启动校验失败: {exc}")
        if result.returncode != 0:
            detail = (stderr or stdout).strip()
            fail(f"后端可执行文件启动校验失败 (exit {result.returncode}): {detail}")

    print(
        "[OK] 后端运行目录完整: "
        f"{len(all_files)} files, {len(native_files)} native files"
    )


if __name__ == "__main__":
    main()
