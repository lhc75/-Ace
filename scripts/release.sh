#!/usr/bin/env bash
# 一键发版：bump 版本号 → 提交 → 打 tag → 推送，触发 GitHub Actions 云端打包并生成 Release。
# 用法: scripts/release.sh 1.3.4
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-}"
TAG="v$VERSION"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "用法: $0 <x.y.z>，例如 $0 1.3.4" >&2; exit 1; }

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "[X] 工作区有未提交改动，请先提交或 stash" >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "[X] 标签 $TAG 已存在" >&2
  exit 1
fi

python3 -I - "$VERSION" <<'EOF'
import json, sys
path = "desktop/package.json"
with open(path) as f:
    data = json.load(f)
old = data["version"]
data["version"] = sys.argv[1]
with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"版本号: {old} -> {sys.argv[1]}")
EOF

git add desktop/package.json
git commit -m "chore(release): 准备 $VERSION 版本"
git tag "$TAG"
git push origin master
git push origin "$TAG"

echo "[OK] 已推送 $TAG。GitHub Actions 正在云端打包，完成后 Releases 页面可见 $TAG。"
