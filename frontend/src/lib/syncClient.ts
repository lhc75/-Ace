// WebSocket同步客户端
import { getAuthToken } from './auth'

export class SyncClient {
  private ws: WebSocket | null = null
  private sessionId: string
  private reconnectTimer: NodeJS.Timeout | null = null
  private onMessageCallback: ((data: any) => void) | null = null

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  connect(onMessage: (data: any) => void) {
    this.onMessageCallback = onMessage
    this.connectWebSocket()
  }

  private connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const token = getAuthToken()
    const url = `${protocol}//${host}/api/ws/sync/${this.sessionId}${token ? `?token=${token}` : ''}`

    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('[SyncClient] WebSocket连接成功')
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (this.onMessageCallback) {
          this.onMessageCallback(data)
        }
      } catch (error) {
        console.error('[SyncClient] 消息解析失败:', error)
      }
    }

    this.ws.onerror = (error) => {
      console.error('[SyncClient] WebSocket错误:', error)
    }

    this.ws.onclose = () => {
      console.log('[SyncClient] WebSocket断开，3秒后重连')
      this.ws = null
      // 自动重连
      this.reconnectTimer = setTimeout(() => {
        this.connectWebSocket()
      }, 3000)
    }
  }

  sendAIOutput(content: string, isFinal: boolean = false) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'ai_output',
        content,
        is_final: isFinal,
        timestamp: Date.now()
      }))
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}
