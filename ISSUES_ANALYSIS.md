# 三个问题的分析和解决方案

## 问题1：简短回答模式需要更精简

### 当前状态
- 配置项：`assist_high_churn_short_answer` (backend/core/config.py:240)
- 当前限制：80-220字
- 问题：用户反馈需要更精简

### 解决方案
修改 `backend/services/llm/prompts.py` 中的 `_asr_realtime_prompt_body` 函数：

```python
# 当前（第289-297行）：
"- 默认 80-180 字，复杂题最多 220 字；不要背景铺垫、长例子、延伸知识树；\n"

# 修改为：
"- 默认 50-120 字，复杂题最多 180 字；只给核心结论 + 1-2个关键点；\n"
"- 去掉所有铺垫、例子、延伸；直接给答案；\n"
```

同时修改 token 限制（backend/core/config.py:244）：
```python
# 当前：
assist_realtime_high_churn_max_tokens: int = 320

# 修改为：
assist_realtime_high_churn_max_tokens: int = 220
```

---

## 问题2：手机扫码访问无法连接

### 当前实现分析
- API: `/api/network-info` (backend/api/common/router.py:522-549)
- 获取局域网IP：通过连接8.8.8.8获取本机IP
- 问题可能原因：
  1. 防火墙阻止18080端口
  2. WiFi隔离模式（AP隔离）
  3. 后端服务只监听localhost而非0.0.0.0

### 排查步骤
1. 检查后端监听地址
2. 检查防火墙规则
3. 验证WiFi是否有AP隔离

### 解决方案
需要检查 `start.py` 或 `main.py` 中的服务启动配置，确保：
```python
# 应该是：
uvicorn.run(app, host="0.0.0.0", port=18080)

# 而不是：
uvicorn.run(app, host="127.0.0.1", port=18080)
```

---

## 问题3：电脑和手机AI输出实时同步

### 需求分析
- 电脑上的AI回答需要同步到手机
- 手机上也使用悬浮提示框显示
- 双向实时同步

### 技术方案：WebSocket实时推送

#### 后端改动
1. 添加WebSocket支持（backend/api/sync/）
2. 创建会话同步管理器
3. 当AI输出时广播到所有连接的客户端

#### 前端改动
1. 桌面端：添加WebSocket连接，推送AI输出
2. 手机端：连接WebSocket，接收并显示在悬浮框

#### 实现流程
```
电脑AI输出 → WebSocket Server → 广播到所有设备 → 手机悬浮框显示
手机扫码 → 连接WebSocket → 订阅当前会话 → 接收实时更新
```

---

## 下一步行动

1. **问题1（简短回答）**：直接修改代码，调整字数限制
2. **问题2（扫码访问）**：检查服务监听地址和防火墙
3. **问题3（实时同步）**：需要实现完整的WebSocket同步机制

需要我开始实现这些修复吗？
