# 面试Ace 2.0.4

## Windows 透明悬浮窗与鼠标穿透双支持

- 修复 Windows 鼠标穿透与共享隐身无法同时生效的问题
- 不再使用会破坏捕获保护的 Electron `setIgnoreMouseEvents(true)`
- 使用原生 Win32 命中穿透，光标移出悬浮窗时点击可落到下方应用
- 光标移入悬浮窗时自动恢复交互，拖动、按钮和滚动保持可用
- 每次鼠标穿透状态变化后立即重新应用 `WDA_EXCLUDEFROMCAPTURE`
- 周期性重新断言捕获排除，降低 Windows 版本和会议软件差异影响
- macOS 保持现有鼠标穿透与捕获保护逻辑

## 验证

- Windows CI 实测窗口同时满足 `click-through` 与 `captureExcluded`
- 桌面端自动化测试通过
- 重新构建 Windows 安装版和便携版
