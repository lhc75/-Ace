from cryptography import x509

from services import mobile_tls, network_info


def test_ensure_certificate_includes_lan_ip(tmp_path, monkeypatch):
    monkeypatch.setenv("IA_TLS_DIR", str(tmp_path))
    monkeypatch.setattr(
        mobile_tls,
        "discover_lan_addresses",
        lambda: [network_info.LanAddress("192.168.0.4", "en1", "Wi-Fi", 140)],
    )

    cert_path, key_path = mobile_tls.ensure_certificate()

    assert cert_path.is_file()
    assert key_path.is_file()
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "192.168.0.4" in [str(value) for value in san.get_values_for_type(x509.IPAddress)]
