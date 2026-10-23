#!/usr/bin/env bash
# 在你自己电脑上生成 macOS .dmg 安装包。
#
# 为什么要这个脚本：dmg 的制作依赖 `hdiutil` 挂载磁盘镜像，
# 在没有磁盘镜像权限的环境（例如受限沙箱 / CI 容器）里 `hdiutil create` 会返回
# "Operation not permitted"，electron-builder 的 dmg 步骤就会失败。
# 在普通 macOS 桌面环境下直接 `npm run dist:mac` 即可，本脚本只是把前置检查写清楚。
#
#   bash scripts/make-dmg.sh                 # 出 arm64 + x64 两个 dmg
#   bash scripts/make-dmg.sh arm64           # 只出 arm64
set -euo pipefail
cd "$(dirname "$0")/.."

if ! hdiutil create -size 8m -fs HFS+ -volname dmgt "$PWD/.cache/_hdiutil_probe.dmg" >/dev/null 2>&1; then
  echo "✗ 当前环境不允许创建磁盘镜像（hdiutil create 被拒绝）。"
  echo "  请在普通 macOS 桌面会话里运行，而不是沙箱/容器中。"
  echo "  替代方案：已在 release/ 下提供 .zip，解压后把 Mozhou.app 拖进「应用程序」即可。"
  exit 1
fi
rm -f "$PWD/.cache/_hdiutil_probe.dmg"

npm run build
if [[ "${1:-}" == "arm64" || "${1:-}" == "x64" ]]; then
  npx electron-builder --mac dmg --"$1"
else
  npx electron-builder --mac dmg --arm64 --x64
fi

echo
echo "✓ 完成，产物在 release/："
ls -lh release/*.dmg 2>/dev/null || true