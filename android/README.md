# 面试Ace Android 悬浮助手

Android 原生跨应用悬浮窗伴侣。电脑端继续负责音频采集、语音识别和 AI 回答；Android App 只负责：

- 扫描面试Ace电脑端二维码
- 连接现有 `/ws` WebSocket
- 将实时答案显示在其他 App 上方
- 拖动位置、放大/缩小窗口、调整透明度、滚动长答案

## 使用流程

1. 安装 APK。
2. 打开 App，点击“扫描电脑二维码”。
3. 点击“授权悬浮窗”，在系统设置中允许“显示在其他应用上层”。
4. 选择 `AI 面试` 或 `实时辅助`。
5. 点击“开始悬浮”，再切换到实际面试 App。

## 网络

- 支持二维码中的 HTTP 和 HTTPS 地址。
- HTTPS 使用局域网自签名证书时，仅对私有网段启用兼容信任。
- 如果二维码内包含 `t` 或 `token`，会自动带入 WebSocket 鉴权。

## iOS

iOS 不创建自定义跨 App 浮层，继续使用手机网页中的系统画中画。

## 本地构建

```bash
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

APK 输出：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```
