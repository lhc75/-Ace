from services import network_info


def test_usable_ip_rejects_proxy_and_virtual_ranges():
    assert not network_info._usable_ip("198.18.0.1")
    assert not network_info._usable_ip("127.0.0.1")
    assert not network_info._usable_ip("169.254.10.2")
    assert network_info._usable_ip("192.168.0.4")
    assert network_info._usable_ip("172.16.36.16")


def test_discover_prefers_wifi_label_and_deduplicates(monkeypatch):
    monkeypatch.setattr(network_info.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(
        network_info,
        "_mac_addresses",
        lambda: [
            network_info.LanAddress("172.16.36.16", "en0", "Ethernet", 80),
            network_info.LanAddress("192.168.0.4", "en1", "Wi-Fi", 140),
            network_info.LanAddress("192.168.0.4", "en1", "Wi-Fi", 130),
            network_info.LanAddress("198.18.0.1", "utun9", "VPN", 999),
        ],
    )
    monkeypatch.setattr(network_info, "_fallback_addresses", lambda: [])

    addresses = network_info.discover_lan_addresses()

    assert [item.ip for item in addresses] == ["192.168.0.4", "172.16.36.16"]
    assert addresses[0].label == "Wi-Fi"
