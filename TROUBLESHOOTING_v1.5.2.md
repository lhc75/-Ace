# v1.5.2 应用打不开诊断

## 可能原因和解决方案

### 1. macOS安全限制（最常见）
**症状**：双击DMG后无反应，或提示"应用已损坏"

**解决方案**：
```bash
# 方法1：移除隔离属性
sudo xattr -rd com.apple.quarantine /Applications/面试Ace.app

# 方法2：允许任何来源（macOS Ventura+）
sudo spctl --master-disable

# 方法3：允许特定应用
sudo spctl --add /Applications/面试Ace.app
sudo xattr -d com.apple.quarantine /Applications/面试Ace.app
```

### 2. 检查应用日志
```bash
# 查看控制台日志
open /Applications/Utilities/Console.app
# 过滤关键词：面试Ace 或 Electron

# 查看崩溃报告
~/Library/Logs/DiagnosticReports/
```

### 3. 尝试从终端启动查看错误
```bash
/Applications/面试Ace.app/Contents/MacOS/面试Ace
```

### 4. 检查端口占用
```bash
# 检查18080端口是否被占用
lsof -i :18080

# 如果被占用，杀掉进程
kill -9 <PID>
```

### 5. 回滚到v1.4.10（已验证可用）
如果v1.5.2确实有问题，可以先用v1.4.10：
https://github.com/lhc75/-Ace/releases/tag/v1.4.10

---

## v1.5.3的改进
v1.5.3版本修复了：
1. 手机扫码访问失败（这是主要修复）
2. 简短回答更精简
3. 添加实时同步功能

**如果v1.5.2打不开，请先尝试上面的解决方案，或者等v1.5.3构建完成后直接用新版本。**

需要我帮你进一步诊断吗？请告诉我：
1. 具体的错误提示（如果有）
2. 从终端启动的输出
3. 控制台日志内容
