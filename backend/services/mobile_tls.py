"""Optional HTTPS listener for mobile microphone access.

Mobile browsers expose getUserMedia only in a secure context. The desktop
Electron app keeps using local HTTP, while phones can connect to a second
uvicorn listener on the LAN with a locally generated certificate.
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import os
import socket
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from services.network_info import discover_lan_addresses


DEFAULT_TLS_PORT = 18443
_server_lock = threading.Lock()
_tls_server: Optional[Any] = None


def _find_port(preferred: int = DEFAULT_TLS_PORT) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("0.0.0.0", 0))
        return int(sock.getsockname()[1])


def _certificate_paths() -> tuple[Path, Path]:
    base = os.environ.get("IA_TLS_DIR")
    if not base:
        app_data = os.environ.get("IA_APP_DATA_DIR")
        base = os.path.join(app_data, "tls") if app_data else os.path.join(
            tempfile.gettempdir(), "interview-ace-tls"
        )
    root = Path(base)
    root.mkdir(parents=True, exist_ok=True)
    return root / "mobile-cert.pem", root / "mobile-key.pem"


def ensure_certificate() -> tuple[Path, Path]:
    cert_path, key_path = _certificate_paths()
    if cert_path.is_file() and key_path.is_file():
        return cert_path, key_path

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "面试Ace Local"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Interview Ace"),
    ])
    san: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    for item in discover_lan_addresses():
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(item.ip)))
        except ValueError:
            continue

    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def start_mobile_tls_server(app: Any) -> Optional[Any]:
    global _tls_server
    if os.environ.get("IA_MOBILE_TLS", "1").strip().lower() in ("0", "false", "no"):
        return None
    with _server_lock:
        if _tls_server is not None:
            return _tls_server
        import uvicorn

        cert_path, key_path = ensure_certificate()
        port = int(os.environ.get("IA_TLS_PORT") or _find_port())
        os.environ["IA_TLS_PORT"] = str(port)
        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=port,
            ssl_certfile=str(cert_path),
            ssl_keyfile=str(key_path),
            lifespan="off",
            loop="asyncio",
            log_level="warning",
            access_log=False,
        )
        server = uvicorn.Server(config)
        thread = threading.Thread(
            target=server.run,
            daemon=True,
            name="interview-ace-mobile-tls",
        )
        thread.start()
        deadline = time.monotonic() + 8.0
        while not getattr(server, "started", False) and time.monotonic() < deadline:
            if not thread.is_alive():
                break
            time.sleep(0.05)
        if not getattr(server, "started", False):
            server.should_exit = True
            raise RuntimeError("局域网 HTTPS 服务启动失败")
        _tls_server = server
        return server


def stop_mobile_tls_server() -> None:
    global _tls_server
    with _server_lock:
        server = _tls_server
        _tls_server = None
    if server is not None:
        server.should_exit = True

