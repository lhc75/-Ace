"""LAN address discovery for the mobile QR page.

The default-route trick (UDP connect to 8.8.8.8) is not reliable on machines
running Clash, Docker, VPNs, or virtual adapters: it can return a fake or
non-LAN address. Enumerate physical adapters first and keep the default-route
address only as a last-resort fallback.
"""

from __future__ import annotations

import ipaddress
import json
import platform
import socket
import subprocess
from dataclasses import dataclass
from typing import Iterable


VIRTUAL_PREFIXES = (
    "utun",
    "tun",
    "tap",
    "bridge",
    "vmnet",
    "vboxnet",
    "docker",
    "veth",
    "awdl",
    "llw",
    "gif",
    "stf",
    "ap",
    "anpi",
)


@dataclass(frozen=True)
class LanAddress:
    ip: str
    interface: str
    label: str
    priority: int


def _run(command: list[str]) -> str:
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        ).stdout
    except Exception:
        return ""


def _usable_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if not isinstance(address, ipaddress.IPv4Address):
        return False
    # 198.18.0.0/15 is commonly used by transparent proxy tools (Clash etc.)
    # and is unreachable from a phone on the physical Wi-Fi network.
    if address in ipaddress.ip_network("198.18.0.0/15"):
        return False
    return address.is_private and not (
        address.is_loopback or address.is_link_local or address.is_multicast
    )


def _priority(interface: str, label: str, ip: str) -> int:
    score = 0
    lowered_label = label.lower()
    if "wi-fi" in lowered_label or "wifi" in lowered_label or "无线" in label:
        score += 100
    elif "ethernet" in lowered_label or "以太网" in label:
        score += 60
    if interface.startswith("en"):
        score += 20
    if ip.startswith("192.168."):
        score += 20
    elif ip.startswith("10."):
        score += 15
    elif ip.startswith("172."):
        score += 10
    return score


def _mac_addresses() -> list[LanAddress]:
    port_by_device: dict[str, str] = {}
    current_port = ""
    for raw_line in _run(["/usr/sbin/networksetup", "-listallhardwareports"]).splitlines():
        line = raw_line.strip()
        if line.startswith("Hardware Port:"):
            current_port = line.split(":", 1)[1].strip()
        elif line.startswith("Device:") and current_port:
            port_by_device[line.split(":", 1)[1].strip()] = current_port

    addresses: list[LanAddress] = []
    current_interface = ""
    for raw_line in _run(["/sbin/ifconfig"]).splitlines():
        if raw_line and not raw_line[0].isspace():
            current_interface = raw_line.split(":", 1)[0].strip()
            continue
        parts = raw_line.strip().split()
        if len(parts) >= 2 and parts[0] == "inet" and _usable_ip(parts[1]):
            label = port_by_device.get(current_interface, current_interface or "网络接口")
            addresses.append(
                LanAddress(
                    ip=parts[1],
                    interface=current_interface,
                    label=label,
                    priority=_priority(current_interface, label, parts[1]),
                )
            )
    return addresses


def _linux_addresses() -> list[LanAddress]:
    addresses: list[LanAddress] = []
    for line in _run(["ip", "-4", "-o", "addr", "show"]).splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        interface = parts[1]
        for index, part in enumerate(parts):
            if part == "inet" and index + 1 < len(parts):
                ip = parts[index + 1].split("/", 1)[0]
                if _usable_ip(ip):
                    addresses.append(
                        LanAddress(
                            ip=ip,
                            interface=interface,
                            label=interface,
                            priority=_priority(interface, interface, ip),
                        )
                    )
                break
    return addresses


def _windows_addresses() -> list[LanAddress]:
    command = (
        "Get-NetIPAddress -AddressFamily IPv4 | "
        "Select-Object InterfaceAlias,IPAddress | ConvertTo-Json -Compress"
    )
    raw = _run([
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
    ])
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    rows = data if isinstance(data, list) else [data]
    addresses: list[LanAddress] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ip = str(row.get("IPAddress") or "").strip()
        label = str(row.get("InterfaceAlias") or "").strip()
        if not _usable_ip(ip):
            continue
        lowered = label.lower()
        if any(token in lowered for token in ("vethernet", "virtual", "vmware", "hyper-v", "tailscale")):
            continue
        addresses.append(
            LanAddress(
                ip=ip,
                interface=label,
                label=label or "网络接口",
                priority=_priority(label, label, ip),
            )
        )
    return addresses


def _fallback_addresses() -> list[LanAddress]:
    values: set[str] = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            values.add(sock.getsockname()[0])
    except Exception:
        pass
    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo(
            socket.gethostname(), None, socket.AF_INET
        ):
            del family
            values.add(str(sockaddr[0]))
    except Exception:
        pass
    return [
        LanAddress(ip=ip, interface="fallback", label="系统默认地址", priority=0)
        for ip in values
        if _usable_ip(ip)
    ]


def discover_lan_addresses() -> list[LanAddress]:
    system = platform.system()
    if system == "Darwin":
        candidates = _mac_addresses()
    elif system == "Windows":
        candidates = _windows_addresses()
    else:
        candidates = _linux_addresses()
    candidates.extend(_fallback_addresses())

    deduped: dict[str, LanAddress] = {}
    for item in candidates:
        if any(item.interface.startswith(prefix) for prefix in VIRTUAL_PREFIXES):
            continue
        existing = deduped.get(item.ip)
        if existing is None or item.priority > existing.priority:
            deduped[item.ip] = item

    ordered = sorted(
        deduped.values(),
        key=lambda item: (-item.priority, item.ip),
    )
    return ordered[:6]

