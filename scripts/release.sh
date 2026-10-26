#!/usr/bin/env bash
# 一键发版：自动 bump 版本号 → 提交 → 打 tag → 推送，触发 GitHub Actions 云端打包并生成 Release。
# 用法:
#   scripts/release.sh          # patch +1（1.3.3 -> 1.3.4）
#   scripts/release.sh minor    # 次版本 +1（1.3.3 -> 1.4.0）
#   scripts/release.sh major    # 主版本 +1（1.3.3 -> 2.0.0）
#   scripts/release.sh 1.4.0    # 指定版本号
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARG="${1:-patch}"

cd "$ROOT"

[ -z "$(git status --porcelain)" ] || { echo "[X] 工作区有未提交改动，请先提交或 stash" >&2; exit 1; }

VERSION="$(python3 -I - "$ARG" <<'EOF'
import json, re, sys
path = "desktop/package.json"
with open(path) as f:
    data = json.load(f)
major, minor, patch = map(int, data["version"].split("."))
arg = sys.argv[1]
if arg == "patch":
    patch += 1
elif arg == "minor":
    minor, patch = minor + 1, 0
elif arg == "major":
    major, minor, patch = major + 1, 0, 0
elif re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", arg):
    major, minor, patch = map(int, arg.split("."))
else:
    sys.exit(f"无效参数: {arg}（应为 patch / minor / major 或 x.y.z）")
new = f"{major}.{minor}.{patch}"
data["version"] = new
with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(new)
EOF
)"
TAG="v$VERSION"
echo "[...] 版本号 bump 为 $VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "[X] 标签 $TAG 已存在" >&2
  exit 1
fi

git add desktop/package.json
git commit -m "chore(release): 准备 $VERSION 版本"
git tag "$TAG"
git push origin master
git push origin "$TAG"

echo "[OK] 已推送 ${TAG}。GitHub Actions 正在云端打包，完成后 Releases 页面可见 ${TAG}。"
