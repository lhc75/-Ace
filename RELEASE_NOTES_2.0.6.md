# 面试Ace 2.0.6

## 外部 Electron 应用 CDP 截图

- 设置 → 工作模式新增“外部 Electron 截图”
- 支持调试端口、窗口标题过滤、页面 URL 过滤和连接测试
- 通过本机 Chrome DevTools Protocol 读取目标 Electron 页面，不受 `setContentProtection` 影响
- CDP 截图失败时自动回退到原有系统截图
- 仅连接 `127.0.0.1`，不访问远程主机
- 目标应用需要使用 `--remote-debugging-port=<端口>` 启动
- 调试端口具有页面控制权限，仅应对自有或已授权的本机应用启用

## 验证

- 前端 400 项测试通过
- 桌面端 105 项测试通过
- 后端相关 64 项测试通过
- TypeScript 与 Vite 生产构建通过
- 已完成真实 Electron 目标客户端 CDP 截图验证

macOS 15+，Apple Silicon (arm64)。下载 DMG 后将「面试Ace」拖入「应用程序」。
