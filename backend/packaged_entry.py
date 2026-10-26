"""PyInstaller entry point for the bundled Windows backend."""

from __future__ import annotations

import os
import sys


def _ensure_ca_certs() -> None:
    # 打包环境（Nuitka standalone）不携带系统 CA 证书，OpenSSL 默认路径为空，
    # wss/https 会报 CERTIFICATE_VERIFY_FAILED。指向随包的 certifi 证书库，
    # Python 的 ssl 默认上下文会读取 SSL_CERT_FILE（requests 读 REQUESTS_CA_BUNDLE）。
    if os.environ.get("SSL_CERT_FILE"):
        return
    try:
        import certifi
    except ImportError:
        return
    os.environ["SSL_CERT_FILE"] = certifi.where()
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _port() -> int:
    for index, arg in enumerate(sys.argv[1:], start=1):
        if arg == "--port" and index + 1 < len(sys.argv):
            try:
                return int(sys.argv[index + 1])
            except (TypeError, ValueError):
                break
        if arg.startswith("--port="):
            try:
                return int(arg.split("=", 1)[1])
            except (TypeError, ValueError):
                break
    return _int_env("PORT", 18080)


def main() -> None:
    _ensure_ca_certs()
    if len(sys.argv) > 1 and sys.argv[1] == "--capture-worker":
        # The frozen backend reuses its executable for the screen-capture child.
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        from services.capture._screen_capture_worker import main as capture_main

        capture_main()
        return

    import uvicorn
    from main import app

    uvicorn.run(
        app,
        host=os.environ.get("IA_HOST", "127.0.0.1"),
        port=_port(),
        log_level=os.environ.get("IA_LOG_LEVEL", "info"),
        access_log=os.environ.get("IA_ACCESS_LOG", "1").strip().lower()
        not in ("0", "false", "no"),
        log_config=None,
    )


if __name__ == "__main__":
    main()
