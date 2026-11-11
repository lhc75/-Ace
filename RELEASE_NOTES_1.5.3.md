# v1.5.3 修复说明

## 修复内容

### 1. 简短回答模式更精简 ✅
- 字数限制：80-220字 → **50-180字**
- Token上限：320 → **220**
- Section数量：2-4个 → **2-3个**（每个只写1句）
- 依据数量：2-3个 → **1-2个关键点**

### 2. 手机扫码访问失败 ✅
**问题根源**：DMG打包版本的后端默认监听 `127.0.0.1`，手机无法访问

**修复方案**：
- `backend/packaged_entry.py`：添加 `_host()` 函数支持 `--host` 参数
- 默认监听地址改为 `0.0.0.0`，支持局域网访问
- `desktop/main.js`：启动参数添加 `--host 0.0.0.0`

### 3. 电脑手机AI输出实时同步 ✅
**实现方案**：WebSocket实时推送系统

**后端**：
- 新增 `backend/api/sync/` 模块
- WebSocket端点：`/api/ws/sync/{session_id}`
- 支持多设备连接同一会话
- 自动广播AI输出到所有设备

**前端**：
- 新增 `frontend/src/lib/syncClient.ts`
- WebSocket客户端，支持自动重连
- 发送/接收AI输出消息

## 使用方式

### 电脑端
```typescript
import { SyncClient } from '@/lib/syncClient'

const client = new SyncClient('session-123')
client.connect((data) => {
  if (data.type === 'ai_output') {
    // 显示AI输出
    console.log(data.content)
  }
})

// 发送AI输出
client.sendAIOutput('这是AI的回答', false)
```

### 手机端
1. 扫描二维码访问应用
2. 自动连接到同一会话的WebSocket
3. 实时接收电脑端的AI输出
4. 显示在手机悬浮框中

## 技术细节

- WebSocket自动重连机制（3秒）
- 消息格式：JSON，包含type、content、is_final、timestamp
- 鉴权：使用token参数进行验证
- 广播机制：排除发送者，避免回传
