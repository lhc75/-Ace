#!/usr/bin/env python3
"""Unified launcher for the interview assistant."""

import argparse
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
from typing import Optional

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(ROOT, "backend")
FRONTEND_DIR = os.path.join(ROOT, "frontend")
FRONTEND_DIST = os.path.join(FRONTEND_DIR, "dist")
DESKTOP_DIR = os.path.join(ROOT, "desktop")

REQUIREMENTS = os.path.join(BACKEND_DIR, "requirements.txt")
HIDE_CONSOLE_ENV = "IA_HIDE_CONSOLE"
PROJECT_PYTHON_REEXEC_ENV = "IA_PROJECT_PYTHON_REEXEC"
PROBE_PACKAGES = ("fastapi", "uvicorn", "openai", "numpy", "sounddevice", "mss")


# ---------------------------------------------------------------------------
# Console helpers
# ---------------------------------------------------------------------------

def _set_utf8_console():
    """Windows: switch active code page to UTF-8 so Unicode chars render."""
    if platform.system() != "Windows":
        return
    try:
        subprocess.run(["chcp", "65001"], capture_output=True, shell=True)
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass


def _hidden_process_kwargs() -> dict:
    if platform.system() != "Windows":
        return {}
    if os.environ.get(HIDE_CONSOLE_ENV, "").strip().lower() not in ("1", "true", "yes"):
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def find_free_port() -> int:
    """Let the OS assign a free port (bind 0)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def resolve_port(preferred: int) -> int:
    """优先使用约定端口；被占用则回退到系统分配的空闲端口（与其它桌面软件一致，不强杀占用者）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", preferred))
            return preferred
        except OSError:
            port = find_free_port()
            print(f"[WARN] 端口 {preferred} 被占用，自动改用空闲端口 {port}")
            return port


def _print_access_info(port: int):
    """Print access URLs for both local and LAN."""
    ip = get_local_ip()
    print(f"  本机访问:   http://localhost:{port}")
    print(f"  局域网访问: http://{ip}:{port}")
    print()
    print(f"  手机扫码:   打开上方页面 → 右上角设置 → 底部二维码")
    print(f"  (手机和电脑需在同一 WiFi 下，音频在电脑端采集)")
    print()


# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

def _project_python() -> Optional[str]:
    """Return the repository virtualenv interpreter when it exists."""
    if platform.system() == "Windows":
        candidate = os.path.join(ROOT, "env", "Scripts", "python.exe")
    else:
        candidate = os.path.join(ROOT, "env", "bin", "python")
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


def _missing_python_deps() -> list[str]:
    missing = []
    for pkg in PROBE_PACKAGES:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    return missing


def _reexec_with_project_python():
    """Use the bundled virtualenv when the caller's Python lacks backend deps."""
    if os.environ.get(PROJECT_PYTHON_REEXEC_ENV) == "1":
        return

    candidate = _project_python()
    if not candidate:
        return
    same_interpreter = os.path.abspath(sys.executable) == os.path.abspath(candidate)
    if same_interpreter or not _missing_python_deps():
        return

    print(f"[INFO] 当前 Python 缺少后端依赖，切换到项目虚拟环境: {candidate}", flush=True)
    env = {
        **os.environ,
        PROJECT_PYTHON_REEXEC_ENV: "1",
    }
    os.execve(candidate, [candidate, os.path.abspath(__file__), *sys.argv[1:]], env)


def ensure_python_deps():
    """Make sure all backend Python dependencies are importable.

    Strategy:
    1. Try importing key packages. If they all work, do nothing.
    2. If any is missing, run: pip install -r backend/requirements.txt
       using *sys.executable* (same Python that is running this script).
    3. After installing, re-check; exit with helpful message if still missing.
    """
    missing = _missing_python_deps()

    if not missing:
        return  # all good

    print(f"[WARN] 缺少 Python 依赖: {', '.join(missing)}")
    print(f"[...] 尝试自动安装 backend/requirements.txt ...")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", REQUIREMENTS, "--quiet"]
    )
    if r.returncode != 0:
        _print_dep_help()
        sys.exit(1)

    # Re-check
    still_missing = []
    for pkg in PROBE_PACKAGES:
        try:
            __import__(pkg.replace("-", "_"))
        except ImportError:
            still_missing.append(pkg)
    if still_missing:
        print(f"\n[ERROR] 安装后仍缺少: {', '.join(still_missing)}")
        _print_dep_help()
        sys.exit(1)

    print("[OK] 依赖安装完成")


def _print_dep_help():
    print()
    print("  请手动安装后端依赖：")
    print(f"    {sys.executable} -m pip install -r backend/requirements.txt")
    print()
    print("  如果你在使用虚拟环境，请先激活它：")
    if platform.system() == "Windows":
        print("    venv\\Scripts\\activate       # CMD")
        print("    venv\\Scripts\\Activate.ps1   # PowerShell")
    else:
        print("    source venv/bin/activate")
    print()
    print("  也可以用 conda：")
    print("    conda activate <your-env>")


def _find_npx() -> Optional[str]:
    """Return path to npx, or None if not found."""
    return shutil.which("npx") or shutil.which("npx.cmd")


def _find_npm() -> Optional[str]:
    return shutil.which("npm") or shutil.which("npm.cmd")


def _print_node_help():
    system = platform.system()
    print()
    print("[ERROR] 未找到 Node.js / npm，桌面模式和前端构建需要 Node.js 18+。")
    print()
    if system == "Windows":
        print("  安装方法（选一种）：")
        print("  1. 官网下载安装包: https://nodejs.org （推荐 LTS 版）")
        print("  2. winget: winget install OpenJS.NodeJS.LTS")
        print("  3. 用 nvm-windows 管理多版本: https://github.com/coreybutler/nvm-windows")
    elif system == "Darwin":
        print("  安装方法（选一种）：")
        print("  1. Homebrew: brew install node")
        print("  2. 官网下载: https://nodejs.org")
        print("  3. nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash")
        print("         nvm install --lts")
    else:
        print("  安装方法（选一种）：")
        print("  1. 包管理器: sudo apt install nodejs npm  / sudo dnf install nodejs")
        print("  2. nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash")
        print("          nvm install --lts")
    print()
    print("  安装后重新打开终端再运行本脚本。")
    print()
    print("  如果只想用网络模式（浏览器访问），可以先跳过桌面模式：")
    print("    python start.py --mode network")


# ---------------------------------------------------------------------------
# Frontend build
# ---------------------------------------------------------------------------

def build_frontend(force: bool = False):
    if not force and os.path.isdir(FRONTEND_DIST):
        print("[OK] 前端已构建，跳过 (用 --rebuild 强制重新构建)")
        return True

    npm = _find_npm()
    if npm is None:
        _print_node_help()
        return False

    if force and os.path.isdir(FRONTEND_DIST):
        print("[...] 清除旧构建产物...")
        shutil.rmtree(FRONTEND_DIST, ignore_errors=True)

    print("[...] 构建前端...")
    if not os.path.isdir(os.path.join(FRONTEND_DIR, "node_modules")):
        print("  安装前端 npm 依赖...")
        r = subprocess.run([npm, "install"], cwd=FRONTEND_DIR, **_hidden_process_kwargs())
        if r.returncode != 0:
            print("[ERROR] npm install 失败")
            return False
    r = subprocess.run([npm, "run", "build"], cwd=FRONTEND_DIR, **_hidden_process_kwargs())
    if r.returncode != 0:
        print("[ERROR] 前端构建失败")
        return False
    print("[OK] 前端构建完成")
    return True


def ensure_electron():
    """Make sure desktop/node_modules/electron exists."""
    if os.path.isdir(os.path.join(DESKTOP_DIR, "node_modules", "electron")):
        return True

    npm = _find_npm()
    if npm is None:
        _print_node_help()
        return False

    print("[...] 安装 Electron 依赖...")
    r = subprocess.run([npm, "install"], cwd=DESKTOP_DIR, **_hidden_process_kwargs())
    return r.returncode == 0


def _electron_binary() -> Optional[str]:
    """Return the Electron binary installed for this project."""
    candidates = [
        os.path.join(DESKTOP_DIR, "node_modules", ".bin", "electron"),
        os.path.join(DESKTOP_DIR, "node_modules", ".bin", "electron.cmd"),
    ]
    return next((candidate for candidate in candidates if os.path.isfile(candidate)), None)


def _list_processes() -> list[tuple[int, int, str]]:
    """Read the local process table without requiring an extra Python package."""
    if platform.system() == "Windows":
        return []
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,command="],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
        )
    except OSError:
        return []

    processes = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
        except ValueError:
            continue
        processes.append((pid, ppid, parts[2]))
    return processes


def stop_existing_desktop_processes():
    """Stop stale instances of this project's desktop launcher before starting.

    `resolve_port()` 只换端口，不处理残留的 Electron 进程。之前的 Electron 实例
    可能仍然存活并占着全局快捷键，导致新启动的 `python start.py` 看起来像在用旧代码。
    """
    if platform.system() == "Windows":
        return

    processes = _list_processes()
    if not processes:
        return

    children: dict[int, list[int]] = {}
    for pid, ppid, _command in processes:
        children.setdefault(ppid, []).append(pid)

    root_pids: set[int] = set()
    project_marker = os.path.normcase(DESKTOP_DIR)
    for pid, _ppid, command in processes:
        normalized = os.path.normcase(command)
        is_project_electron = project_marker in normalized and (
            'node_modules/electron' in normalized
            or '--app-path=' in normalized
        )
        is_project_desktop_launcher = (
            project_marker.replace('/desktop', '') in normalized
            and 'start.py' in normalized
            and '--mode network' not in normalized
        )
        if is_project_electron or is_project_desktop_launcher:
            if pid != os.getpid():
                root_pids.add(pid)

    if not root_pids:
        return

    stale_pids = set(root_pids)
    pending = list(root_pids)
    while pending:
        parent_pid = pending.pop()
        for child_pid in children.get(parent_pid, []):
            if child_pid == os.getpid() or child_pid in stale_pids:
                continue
            stale_pids.add(child_pid)
            pending.append(child_pid)

    current_pid = os.getpid()
    kill_order = sorted((pid for pid in stale_pids if pid != current_pid), reverse=True)
    if not kill_order:
        return

    print(f"[...] 清理本项目旧桌面进程: {len(kill_order)} 个")
    for pid in kill_order:
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        except OSError as error:
            print(f"[WARN] 终止旧桌面进程失败 PID={pid}: {error}")

    deadline = time.time() + 2.0
    remaining = set(kill_order)
    while remaining and time.time() < deadline:
        alive = {pid for pid, _ppid, _command in _list_processes()}
        remaining.intersection_update(alive)
        if remaining:
            time.sleep(0.1)

    for pid in sorted(remaining, reverse=True):
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        except OSError as error:
            print(f"[WARN] 强制终止旧桌面进程失败 PID={pid}: {error}")


# ---------------------------------------------------------------------------
# Port management: resolve_port() 见上方 (首选端口被占用时回退系统空闲端口)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

def start_server(host: str, port: int):
    port = resolve_port(port)
    # 供后端 /api/network 二维码等读取实际端口（自定义端口或自动回退时尤其重要）
    os.environ["PORT"] = str(port)

    # Add backend to sys.path so all relative imports work correctly
    if BACKEND_DIR not in sys.path:
        sys.path.insert(0, BACKEND_DIR)
    os.chdir(BACKEND_DIR)

    # Try direct import first (fastest, works when deps are in current env)
    try:
        import uvicorn
        _access_log = os.environ.get("IA_ACCESS_LOG", "1").strip().lower() not in ("0", "false", "no")
        uvicorn.run(
            "main:app",
            host=host,
            port=port,
            log_level="info",
            reload=False,
            access_log=_access_log,
        )
        return
    except ImportError:
        pass

    # Fallback: subprocess using sys.executable (handles venv / conda / pyenv)
    print("[INFO] uvicorn 不在当前 Python 路径，尝试通过 subprocess 启动...")
    uv_args = [
        sys.executable, "-m", "uvicorn",
        "main:app",
        "--host", host,
        "--port", str(port),
        "--log-level", "info",
    ]
    if os.environ.get("IA_ACCESS_LOG", "1").strip().lower() in ("0", "false", "no"):
        uv_args.append("--no-access-log")
    r = subprocess.run(uv_args, cwd=BACKEND_DIR, **_hidden_process_kwargs())
    sys.exit(r.returncode)


# ---------------------------------------------------------------------------
# Run modes
# ---------------------------------------------------------------------------

def run_desktop_mode(port: int):
    """Desktop mode: Electron window with content protection and global hotkeys."""
    if not ensure_electron():
        print("[ERROR] Electron 安装失败，请检查网络后重试。")
        print("  手动安装: cd desktop && npm install")
        print()
        print("  或者直接用无 Electron 模式启动:")
        print(f"    python start.py --mode network")
        sys.exit(1)

    electron = _electron_binary()
    if electron is None:
        print("[ERROR] 未找到项目内 Electron，可执行文件。")
        print("  手动安装: cd desktop && npm install")
        sys.exit(1)

    stop_existing_desktop_processes()

    # 端口不再预清理: Electron 主进程会在启动时探测首选端口,
    # 被占用则自动回退到系统分配的空闲端口 (desktop/portPicker.js)。

    # Windows: 如果当前进程还有控制台窗口，先以无窗口模式重启自己
    # 这样用户双击启动时，初始的命令行窗口会消失，只留 Electron 窗口
    if platform.system() == "Windows" and os.environ.get(HIDE_CONSOLE_ENV) != "1":
        print("  Electron 桌面模式")
        print("  - 屏幕共享隐身: 已开启")
        print("  - 全局快捷键: Ctrl+B 显示/隐藏")
        print("  - 系统托盘: 右键切换置顶、隐身等")
        print()
        _print_access_info(port)
        print()
        print("  正在启动桌面应用...")
        time.sleep(1)  # 给用户 1 秒看到消息

        # 重启自己，但这次带上隐藏标志
        env = {**os.environ, HIDE_CONSOLE_ENV: "1"}
        subprocess.Popen(
            [sys.executable] + sys.argv,
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
            cwd=os.getcwd(),
        )
        sys.exit(0)

    # 到这里说明已经是无窗口模式了（或者不是 Windows）
    env = {
        **os.environ,
        "PORT": str(port),
        HIDE_CONSOLE_ENV: "1",
        # Electron starts the network-mode backend itself. Keep that child on
        # the same Python environment that launched this desktop process.
        "IA_PYTHON_EXECUTABLE": sys.executable,
    }
    print(f"[INFO] 使用项目内 Electron: {electron}")
    proc = subprocess.run([electron, "."], cwd=DESKTOP_DIR, env=env, **_hidden_process_kwargs())
    sys.exit(proc.returncode)


def run_network_mode(port: int):
    """Network mode: LAN accessible via browser (no Electron needed)."""
    os.environ.setdefault("IA_AUTH_ENABLE", "1")
    print("  纯浏览器模式（无 Electron）")
    print()
    _print_access_info(port)

    start_server("0.0.0.0", port)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    # Switch console to UTF-8 immediately on Windows (before any print)
    _set_utf8_console()
    _reexec_with_project_python()

    parser = argparse.ArgumentParser(description="面试助手启动器")
    parser.add_argument("--mode", choices=["desktop", "network"], default="desktop",
                        help="运行模式: desktop (Electron 桌面窗口) 或 network (局域网浏览器访问)")
    parser.add_argument("--port", type=int, default=18080, help="服务端口 (默认 18080)")
    parser.add_argument("--no-build", action="store_true", help="跳过前端构建")
    parser.add_argument("--rebuild", action="store_true", help="强制重新构建前端（即使 dist 已存在）")
    parser.add_argument("--skip-dep-check", action="store_true",
                        help="跳过 Python 依赖检查（已确认环境正确时可加速启动）")
    args = parser.parse_args()

    print("=" * 50)
    print("  面试Ace InterviewAce")
    print("=" * 50)
    print()

    # Python 版本检查
    if sys.version_info < (3, 10):
        print(f"[ERROR] 需要 Python 3.10+，当前版本: {sys.version}")
        print("  请升级 Python: https://www.python.org/downloads/")
        sys.exit(1)

    print(f"  Python: {sys.version.split()[0]}  ({sys.executable})")
    print(f"  平台: {platform.system()} {platform.machine()}")
    print()

    # Ensure Python deps (auto-install if missing)
    if not args.skip_dep_check:
        ensure_python_deps()

    if not args.no_build:
        if not build_frontend(force=args.rebuild):
            print()
            print("  前端构建失败，可以用 --no-build 跳过（需先手动构建）：")
            print(f"    cd frontend && npm install && npm run build && cd ..")
            print(f"    python start.py --no-build")
            sys.exit(1)

    mode_label = "Electron 桌面窗口" if args.mode == "desktop" else "局域网浏览器"
    print(f"  模式: {mode_label}  端口: {args.port}")
    print("=" * 50)
    print()

    if args.mode == "desktop":
        run_desktop_mode(args.port)
    else:
        run_network_mode(args.port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  已停止。")
        sys.exit(0)
