# 面试Ace 2.1.0

- macOS Apple Silicon 用户可下载 `InterviewAce-2.1.0-arm64.dmg`。正常启动后按 `⌘O` 打开透明悬浮窗。
- 原生保护层仍为实验功能，可通过 `--ace-protected-overlay` 启用。macOS 27.2.1 与 v2.6.0 探测客户端的实机对照中，启用保护的图层也会从 Mac 物理屏幕消失。
- 恢复普通显示时，退出实验模式下运行的 App，从「应用程序」重新启动。普通透明悬浮窗仍可能出现在 ScreenCaptureKit 整屏预览里。

## 发布后实机复验（2026-11-25）

环境为 macOS 27.2.1、内建显示器、镜像关闭。对照窗口使用 [Screening PR #11](https://github.com/dimqsh/Screening/pull/11) 提交 `5b8501a` 的原生图层和送帧实现，左侧为普通红块，右侧为受保护绿块。

| 采集条件 | 物理屏幕观察 | 采集侧观察 |
| --- | --- | --- |
| 国考云 2.6.0 设备预览开启 | 只有红块；关闭预览后绿块自动恢复 | 用户在预览里只看到红块 |
| 国考云预览关闭，独立程序使用 ScreenCaptureKit 采集内建屏幕 | 用户在采集期间只看到红块 | 收到 320 个含图像缓冲区的样本，仅计数，未检查像素 |

独立采集期间，测试程序轮询到的受保护图层状态保持 `readyForDisplay=true`、`outputObscuredDueToInsufficientExternalProtection=false`。这些状态不足以判断物理屏幕上的内容是否可读。当前实测仍未达到“采集期间本机可见、视频帧排除”的验收条件。
