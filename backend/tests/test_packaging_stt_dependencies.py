from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_macos_backend_package_collects_onnxruntime_for_whisper_vad():
    spec = (ROOT / "packaging" / "interview-assistant-backend.spec").read_text(
        encoding="utf-8"
    )

    package_block = spec.split("for package_name in (", 1)[1].split("):", 1)[0]
    excludes_block = spec.split("excludes=[", 1)[1].split("],", 1)[0]

    assert '"onnxruntime",' in package_block
    assert '"onnxruntime"' not in excludes_block


def test_backend_requirements_pin_onnxruntime_as_a_runtime_dependency():
    requirements = (ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8")

    assert "onnxruntime>=" in requirements
