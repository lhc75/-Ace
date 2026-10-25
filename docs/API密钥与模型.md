# API 密钥与模型配置

本助手使用 **OpenAI 兼容** 的 Chat Completions API，任一兼容该格式的服务均可接入。

## 配置多个模型

在 `backend/config.json` 的 `models` 数组中添加多个模型，界面顶部会出现下拉选择器，可实时切换。`active_model` 为默认选中的下标（从 0 开始）。

```json
{
  "models": [
    { "name": "GPT-4o", "api_base_url": "...", "api_key": "...", "model": "gpt-4o", "supports_think": false, "supports_vision": true },
    { "name": "DeepSeek", "api_base_url": "...", "api_key": "...", "model": "deepseek-chat", "supports_think": true, "supports_vision": false }
  ],
  "active_model": 0
}
```

- `supports_vision: true`：支持截图识题，选择器中会显示 👁
- `supports_think: true`：可启用 Think 深度思考模式

## 为单个模型开启联网搜索

联网搜索是模型级配置，每个模型可以独立开启、关闭并使用不同的 DeepSeek Search 凭据。搜索 Key 与模型 API Key 分开填写；关闭搜索不会删除已保存的 Search Key。

```json
{
  "name": "DeepSeek-V3",
  "api_base_url": "https://api.deepseek.com",
  "api_key": "模型 API Key",
  "model": "deepseek-chat",
  "supports_think": true,
  "supports_vision": false,
  "enabled": true,
  "web_search_enabled": true,
  "web_search_api_base_url": "https://api.deepseek.com",
  "web_search_api_key": "独立 Search API Key"
}
```

设置页开启“联网搜索”后，会显示 Search API Base URL、Search API Key 和测试按钮。搜索仅在对应模型被调用时执行；搜索失败、超时、限流或无结果时会自动跳过联网上下文，模型仍会正常作答。

- Search Base URL 可填写 `https://api.deepseek.com` 或 `https://api.deepseek.com/v1`
- Search 请求固定使用 `count=5` 和 `need_content=true`
- 同一模型、同一查询会短时缓存，避免并行答题重复计费
- 真实截图题会先使用同一识图模型提取一条脱敏搜索词，再执行 Search；关键词提取或搜索失败时自动回到普通截图答题
- 健康探测、OCR 后台入库、笔试链路预检和后台标签整理不会触发联网搜索

## 通用思考强度

设置页的 Think 开关旁可选择通用思考强度：

```text
off / minimal / low / medium / high / xhigh / max / ultra
```

该选项对所有模型统一展示，后端会根据模型协议自动适配：

- OpenAI 推理模型使用 `reasoning_effort`
- Claude 风格模型转换为 `thinking.budget_tokens`
- DeepSeek 使用 `thinking.type` 和 `reasoning_effort`，并按官方映射归一化
- 只支持思考开关的模型会自动忽略细分强度
- 模型“保存并测试”里的 `探测样例` 固定使用低成本参数验证兼容性；`当前实际` 才是正式答题会发送的参数

---

## 各厂商配置示例

### OpenAI (GPT-4o / GPT-4o-mini)

- **API Key**：[https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)

```json
{
  "name": "GPT-4o",
  "api_base_url": "https://api.openai.com/v1",
  "api_key": "sk-proj-xxxxxxxxxxxx",
  "model": "gpt-4o",
  "supports_think": false,
  "supports_vision": true
}
```

### DeepSeek (V3 / R1)

- **API Key**：[https://platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)

```json
{
  "name": "DeepSeek-V3",
  "api_base_url": "https://api.deepseek.com",
  "api_key": "sk-xxxxxxxxxxxx",
  "model": "deepseek-chat",
  "supports_think": true,
  "supports_vision": false
}
```

### 通义千问 (Qwen)

- **API Key**：[https://dashscope.console.aliyun.com/apiKey](https://dashscope.console.aliyun.com/apiKey)

```json
{
  "name": "Qwen-Plus",
  "api_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "api_key": "sk-xxxxxxxxxxxx",
  "model": "qwen-plus",
  "supports_think": false,
  "supports_vision": true
}
```

### 智谱 GLM

- **API Key**：[智谱 AI 开放平台](https://www.bigmodel.cn/)（免费注册即送 token）

```json
{
  "name": "GLM-4.7-Flash",
  "api_base_url": "https://open.bigmodel.cn/api/paas/v4",
  "api_key": "your-zhipu-api-key",
  "model": "GLM-4.7-Flash",
  "supports_think": false,
  "supports_vision": false
}
```

多模态可用 `GLM-4.6V-Flash`，设置 `"supports_vision": true`。

### 本地部署 (Ollama)

无需 API Key，先在本机运行：`ollama serve`

```json
{
  "name": "Ollama-Qwen",
  "api_base_url": "http://localhost:11434/v1",
  "api_key": "ollama",
  "model": "qwen2.5:14b",
  "supports_think": false,
  "supports_vision": false
}
```

### Claude（通过第三方兼容 API）

需使用兼容 OpenAI 格式的 Claude 代理服务，按服务商要求填写 `api_base_url` 和 `api_key`。

```json
{
  "name": "Claude-3.5-Sonnet",
  "api_base_url": "https://your-claude-proxy.com/v1",
  "api_key": "sk-xxxxxxxxxxxx",
  "model": "claude-3-5-sonnet-20241022",
  "supports_think": false,
  "supports_vision": true
}
```
