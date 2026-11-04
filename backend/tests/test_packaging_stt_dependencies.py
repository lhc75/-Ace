from __future__ import annotations

import json
import sys
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


def test_nuitka_builds_bundle_filelock_submodules():
    """filelock 4.x 的 ._soft 被依赖扫描漏掉会让 huggingface_hub 加载失败。"""

    for script in ("build-backend-nuitka.ps1", "build-backend-nuitka.sh"):
        content = (ROOT / "scripts" / script).read_text(encoding="utf-8")
        assert "include-package=filelock" in content, script


def test_nuitka_builds_bundle_soundcard_headers():
    """soundcard import 时 open() 包内 .h 声明；只带 .py 会让系统音频设备为空。"""

    for script in ("build-backend-nuitka.ps1", "build-backend-nuitka.sh"):
        content = (ROOT / "scripts" / script).read_text(encoding="utf-8")
        assert "--include-package=soundcard" in content, script
        assert "--include-package-data=soundcard" in content, script


def test_packaged_entry_check_audio_prints_json(monkeypatch, capsys):
    import packaged_entry

    monkeypatch.setattr(sys, "argv", ["interview-assistant-backend", "--check-audio"])
    packaged_entry.main()

    payload = json.loads(capsys.readouterr().out)
    assert payload["platform"] == sys.platform
    assert isinstance(payload["speakers"], list)
    assert "error" in payload
