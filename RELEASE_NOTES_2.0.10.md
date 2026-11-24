# 面试 Ace 2.0.10

- 修复 macOS 开启窗口捕获保护后，部分整屏共享场景出现灰块的问题。
- 主窗口与悬浮窗使用 Electron 的公开捕获保护设置。
- macOS「启动并连接」沿用目标应用默认的屏幕采集配置。

使用 ScreenCaptureKit 的应用仍可能在整屏共享中采集 Ace 窗口。

macOS 安装包支持 macOS 15 及以上的 Apple Silicon 机型。
