# 面试Ace 2.0.3

## Windows 共享屏幕悬浮窗修复

- 修复 Windows 开启笔试隐身时，透明悬浮窗仍会出现在共享画面中的问题
- 根因是 `setIgnoreMouseEvents(true)` 会破坏透明置顶窗的捕获排除状态
- Windows 恢复初版行为，不再启用悬浮窗鼠标穿透
- macOS 保留悬停交互和现有捕获保护
- Windows 原生 `WDA_EXCLUDEFROMCAPTURE` 继续作为第二层保护

## 验证

- Windows 专项回归测试覆盖“永不开启鼠标穿透”
- 桌面端自动化测试通过
- CI 重新构建 Windows 安装版与便携版
