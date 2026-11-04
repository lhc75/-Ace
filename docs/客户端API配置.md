# 客户端 API 配置指南

本文说明在**面试Ace 桌面客户端**里怎么填 API：语音识别用哪个引擎、Key 去哪里申请、地址填什么、推荐什么模型。客户端设置页里填的内容会保存到后端的 `config.json`，与手动编辑配置文件是同一份配置。

打开方式：进入客户端 **设置**，左侧有 **常用 / 语音 / 模型 / 知识库** 等分页。本文只涉及 **语音** 和 **模型** 两页。

> 推荐组合：**语音识别用阿里千问实时识别 `qwen-audio-3.1-asr-flash-streaming`，并打开「面试官实时流式转写」**；答题模型用 DeepSeek 或通义千问。

---

## 一、语音识别：阿里千问实时识别（推荐）

千问实时识别是服务端流式识别，面试官边说边出字，说完一句由服务端断句定稿，定稿后立即派发给大模型答题。四种引擎里它的「边说边出字」体验最好，是推荐的引擎。

### 1. 申请 API Key

| 项目 | 地址 / 说明 |
| --- | --- |
| 平台 | 千问 AI 平台：<https://platform.qianwenai.com> |
| API Key 页面 | <https://platform.qianwenai.com/home/api-keys> |
| Key 获取文档 | <https://platform.qianwenai.com/docs/api-reference/preparation/api-key> |
| 实时识别文档 | <https://platform.qianwenai.com/docs/developer-guides/speech/asr-realtime> |

步骤：

1. 登录千问 AI 平台，进入 **API Key** 页面，点击 **创建 API Key**。
2. 填一个描述（如「面试Ace」），点击 **生成 API Key**。
3. **立即复制保存**。完整 Key 只在创建时显示一次，之后列表里只显示掩码。

Key 格式说明：

- 按量付费的通用 Key 是 `sk-ws-xxxxx`（早期创建的是 `sk-xxxxx`），用这个即可。
- `sk-sp-xxxxx` 是 Token Plan 订阅套餐专属 Key，按套餐 Credits 计费。是否覆盖语音识别模型以套餐说明为准。
- 这里要的是**千问 AI 平台**（platform.qianwenai.com）的 Key。阿里云百炼控制台（dashscope.console.aliyun.com）是另一个入口，它的 Key 不保证能连千问实时识别地址，请以千问 AI 平台创建的 Key 为准。

### 2. 在客户端里填写

进入 **设置 → 语音**：

| 界面字段 | 填什么 |
| --- | --- |
| 识别引擎（主链路） | 选 **阿里千问** |
| 阿里千问 API Key | 粘贴上一步的 Key |
| 千问实时识别模型 | `qwen-audio-3.1-asr-flash-streaming`（推荐，默认值） |
| 面试官实时流式转写 | **打开**（引擎为阿里千问且已填 Key 时可用） |

填完点 **保存并测试**。测试会直接调用千问识别服务转写一段内置音频，不会用本地 Whisper 的结果掩盖失败。测试通过即可开始面试。

客户端不需要填接口地址，程序内置了千问实时识别的 WebSocket 地址：

```text
wss://maas.qianwenaiapi.com/api-ws/v1/inference
```

鉴权方式是请求头 `Authorization: Bearer <API Key>`，音频以 16 kHz 单声道 PCM 分块上行。如果公司网络有代理或防火墙，需要放行 `maas.qianwenaiapi.com` 的 443 端口。

### 3. 模型怎么选

| 模型 | 建议 | 断句方式 |
| --- | --- | --- |
| `qwen-audio-3.1-asr-flash-streaming` | **推荐**，默认值 | 服务端 VAD 模型（`vad_model`），默认远场 |
| `qwen-audio-3.0-asr-flash-streaming` | 备选，3.1 不可用时再换 | 静音时长阈值（`max_sentence_silence`） |

「千问实时识别模型」输入框也可以手动填其他名称，但该模型必须兼容千问实时识别的 `run-task` WebSocket 协议，能否调用由平台和账户权限决定。

### 4. 高级参数（只能改 config.json）

下面两项界面上没有，需要时在 `config.json` 里改：

```jsonc
{
  // 3.1 系列的服务端断句模型。空 = 服务端默认 far_field_meeting_16k（远场，适合会议软件外放音频）。
  // 手机贴近麦克风、耳机直录等近场场景可改为 near_meeting_16k。
  "aliyun_stt_vad_model": "",

  // 断句静音阈值（毫秒），范围 200–6000，0 = 不传、用服务端默认 800。
  // 越小定稿越快、答题越早；过小会在面试官句中停顿时把一个问题拆成两段。
  // 官方文档里这个参数对应 3.0 系列；3.1 系列以 vad_model 为准。
  "aliyun_stt_max_sentence_silence_ms": 600
}
```

### 5. 我的麦克风也用千问（可选）

**设置 → 语音** 下方「我的语音识别引擎」也可以选 **阿里千问**，会复用上面的 API Key 和模型，用于记录你自己的回答（复盘和下一题的上下文）。这一路**不会触发自动答题**，但会额外产生识别费用；不在意成本差异的话也可以保持默认的本地 Whisper。

### 6. 常见报错

| 现象 | 原因与处理 |
| --- | --- |
| 鉴权失败 / 401 / 403 / InvalidApiKey | Key 填错、多了空格或已被删除；用百炼控制台的 Key 也可能出现。到千问 AI 平台重新复制 Key。 |
| 连接或传输超时 | 网络无法访问 `maas.qianwenaiapi.com`，检查代理、VPN、公司防火墙。 |
| 任务失败（Model 相关） | 账户没有该模型权限或模型名拼错，换回 `qwen-audio-3.1-asr-flash-streaming`。 |
| 打包版报 SSL 证书错误 | v1.3.5 起安装包已内置证书库，请升级到最新版。 |

---

## 二、其他语音识别引擎（简要）

| 引擎 | 适用场景 | 配置要点 |
| --- | --- | --- |
| Whisper（本地） | 断网可用、零费用 | 选模型大小即可，`base` 适合大多数机器 |
| 豆包（火山引擎） | 已有火山引擎账号 | API Key 在 [火山引擎新版控制台](https://console.volcengine.com/speech/new/setting/apikeys) 获取，详见 [豆包语音识别](./豆包语音识别.md) |
| 通用 ASR | 自建 FunASR / faster-whisper 服务 | Base URL 写到 `/v1`（如 `http://127.0.0.1:8000/v1`），程序自动请求 `/audio/transcriptions`；本地服务 Key 可留空 |

---

## 三、答题模型（设置 → 模型）

答题模型统一走 **OpenAI 兼容接口**（`POST {API Base URL}/chat/completions`），可以添加多个并行回答。

| 界面字段 | 说明 |
| --- | --- |
| 模型名称 * | 界面显示名，随便起，如 `DeepSeek-V3` |
| API Base URL | 厂商的 OpenAI 兼容地址，见下表 |
| API Key | 厂商控制台申请的 Key |
| Model ID | 实际请求的模型标识；可点「获取模型列表」从接口拉取，拉不到时手动填 |
| Temperature | 推荐 0.4–0.6 |
| Max Tokens | 建议 2048–4096 |

填完点 **保存并测试** 验证连通性。

### 推荐配置

| 厂商 | API Base URL | 推荐 Model ID | Key 申请地址 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | <https://platform.deepseek.com/api_keys> |
| 千问 AI 平台 | `https://maas.qianwenaiapi.com/compatible-mode/v1` | 平台模型列表中的 Qwen 模型 | <https://platform.qianwenai.com/home/api-keys> |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`；截图识题用带视觉能力的型号 | <https://dashscope.console.aliyun.com/apiKey> |

- 千问 AI 平台的 Key 可以同时用于语音识别和答题模型，只申请一个即可。
- 百炼地址必须带 `/compatible-mode/v1` 后缀。
- 需要截图识题时，选支持视觉的模型并打开「识图支持」。
- 联网搜索、思考强度等进阶设置见 [API 密钥与模型](./API密钥与模型.md)。
