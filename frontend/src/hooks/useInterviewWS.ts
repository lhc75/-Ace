import { useEffect, useRef } from 'react'
import { useInterviewStore } from '@/stores/configStore'
import { useKbStore } from '@/stores/kbStore'
import { buildWsUrl } from '@/lib/backendUrl'
import { subscribeLeader } from '@/lib/wsLeader'

// 指数退避重连步长（ms）。最后一档是稳态，不再翻倍。
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]
// 客户端 ping 间隔（与服务端 25s 心跳错开，避免对撞）。
let wsErrorClearTimer: ReturnType<typeof setTimeout> | null = null

const CLIENT_PING_INTERVAL_MS = 25000
// pong 超时阈值：若超过该时长没收到任何服务端帧（pong/ping/普通广播），视为僵尸。
const PONG_TIMEOUT_MS = 60000

interface WsMsg {
  type: string
  scope?: string
  [k: string]: unknown
}

export function useInterviewWS(active = true) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const reconnectAttempts = useRef(0)
  const shouldReconnect = useRef(true)
  const lastServerPongAt = useRef(0)

  const scheduleReconnect = () => {
    if (!shouldReconnect.current) return
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    const idx = Math.min(reconnectAttempts.current, RECONNECT_BACKOFF_MS.length - 1)
    const delay = RECONNECT_BACKOFF_MS[idx]
    reconnectAttempts.current += 1
    reconnectTimer.current = window.setTimeout(connect, delay)
  }

  const connect = () => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN
      || wsRef.current?.readyState === WebSocket.CONNECTING
    ) return
    let ws: WebSocket
    try {
      ws = new WebSocket(buildWsUrl('/ws'))
    } catch (err) {
      console.warn('[ws] failed to construct WebSocket', err)
      scheduleReconnect()
      return
    }
    wsRef.current = ws
    lastServerPongAt.current = Date.now()

    ws.onopen = () => {
      if (wsRef.current !== ws) return
      reconnectAttempts.current = 0
      useInterviewStore.getState().setWsConnected(true)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
    }
    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return
      lastServerPongAt.current = Date.now()
      let data: WsMsg
      try {
        data = JSON.parse(event.data)
      } catch (err) {
        console.warn('[ws] JSON parse failed', err, typeof event.data === 'string' ? event.data.slice(0, 120) : event.data)
        return
      }
      if (!data || typeof data !== 'object') return
      // 服务端 ping → 主动回 pong 维持心跳
      if (data.type === 'ping') {
        try {
          ws.send(JSON.stringify({ type: 'pong' }))
        } catch (err) {
          console.warn('[ws] send pong failed', err)
        }
        return
      }
      if (data.type === 'pong') return
      handleMessage(data)
    }
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      useInterviewStore.getState().setWsConnected(false)
      if (!shouldReconnect.current) return
      if (ev && ev.code === 1008) {
        // policy violation (鉴权失败)，重试也无效，停止
        console.warn('[ws] closed by server with policy violation; stop reconnecting')
        shouldReconnect.current = false
        return
      }
      scheduleReconnect()
    }
    ws.onerror = (ev) => {
      console.warn('[ws] error event', ev)
      try { ws.close() } catch (err) { console.warn('[ws] close after error failed', err) }
    }
  }

  const handleMessage = (msg: WsMsg) => {
    const s = useInterviewStore.getState()
    switch (msg.type) {
      case 'init':
        s.setInitData(msg as Parameters<typeof s.setInitData>[0])
        break
      case 'recording':
        s.setRecording(msg.value as boolean)
        break
      case 'paused':
        s.setPaused(msg.value as boolean)
        break
      case 'audio_level':
        s.setAudioLevel(msg.value as number)
        break
      case 'transcribing':
        s.setTranscribing(msg.value as boolean)
        break
      case 'transcription':
        s.addTranscription({
          id: String(msg.id || `ws-${Date.now()}`),
          text: String(msg.text || ''),
          timestamp: Number(msg.timestamp || Date.now() / 1000),
        })
        break
      // 面试官流式识别的中间结果：只更新“进行中”那一行，text 为空表示该行已定稿、清空。
      // 正式转写仍由后端在定稿后推 transcription，二者互不干扰。
      case 'transcription_interim':
        s.setInterimTranscription(String(msg.text || ''))
        break
      case 'transcription_updated':
        s.updateTranscription(
          String(msg.id || ''),
          String(msg.text || ''),
        )
        break
      case 'transcription_deleted':
        s.deleteTranscription(String(msg.id || ''), (msg.qa_ids as string[]) || [])
        break
      case 'candidate_transcription':
        s.addCandidateTranscription(msg.text as string, {
          segmentId: msg.segment_id as string | undefined,
          isFinal: msg.is_final as boolean | undefined,
        })
        break
      case 'session_cleared':
        s.clearSession()
        break
      case 'answer_start':
        if (msg.exam_preflight_id) return
        s.startAnswer(msg.id as string, msg.question as string, {
          source: msg.source as string,
          modelName: msg.model_name as string,
          sourceTranscriptionIds: (msg.source_transcription_ids as string[]) || [],
          replacement: Boolean(msg.replacement),
        })
        break
      case 'answer_think_chunk':
        if (msg.exam_preflight_id) return
        s.appendThinkChunk(msg.id as string, msg.chunk as string, Boolean(msg.replacement))
        break
      case 'answer_chunk':
        if (msg.exam_preflight_id) return
        s.appendAnswerChunk(msg.id as string, msg.chunk as string, Boolean(msg.replacement))
        break
      case 'answer_done':
        if (msg.exam_preflight_id) return
        s.finalizeAnswer(
          msg.id as string,
          msg.question as string,
          msg.answer as string,
          msg.think as string,
          msg.model_name as string,
          msg.first_token_ms as number | undefined,
          msg.total_ms as number | undefined,
          Boolean(msg.replacement),
          (msg.source_transcription_ids as string[]) || undefined,
          (msg.web_sources as any[]) || undefined,
        )
        break
      case 'answer_cancelled':
        if (msg.exam_preflight_id) return
        s.cancelAnswer(msg.id as string)
        if (msg.replacement) s.restoreAnswerReplacement(msg.id as string)
        break
      case 'answer_error':
        if (msg.exam_preflight_id) return
        {
          const message = (msg.message as string) || '答案处理失败'
          const prefix = msg.stage === 'persistence' ? '答案保存失败' : '答案生成失败'
          s.errorAnswer(msg.id as string, message, Boolean(msg.replacement))
          if (msg.replacement) s.restoreAnswerReplacement(msg.id as string)
          s.pushToast(message.startsWith(prefix) ? message : `${prefix}: ${message}`, 'error')
        }
        break
      case 'vision_verify':
        {
          const verdict = msg.verdict as Parameters<typeof s.setVisionVerify>[1]
          const reason = String(msg.reason || '').trim()
          const reasonHint = reason ? `：${reason.slice(0, 80)}` : ''
          if (verdict === 'FAIL') {
            s.pushToast(`截图自检不一致，请人工复核${reasonHint}`, 'warn', 6000)
          }
          s.setVisionVerify(
            msg.id as string,
            verdict,
            reason,
          )
        }
        break
      case 'stt_status':
        s.setSttStatus((msg.loaded as boolean) ?? false, (msg.loading as boolean) ?? false, msg.provider as string | undefined)
        break
      case 'candidate_asr_status':
        s.setCandidateSttStatus(
          (msg.loaded as boolean) ?? false,
          (msg.loading as boolean) ?? false,
          msg.provider as string | undefined,
        )
        if (msg.error) {
          s.pushToast(`会议软件可能独占麦克风，候选人口述记录已关闭，不影响面试录音: ${msg.error as string}`, 'warn')
        }
        break
      case 'model_health':
        s.setModelHealth(
          msg.index as number,
          msg.status as Parameters<typeof s.setModelHealth>[1],
          msg.detail as string | undefined,
          msg.latency_ms as number | undefined,
          msg.model_fingerprint as string | undefined,
        )
        break
      case 'token_update':
        s.setTokenUsage({
          prompt: msg.prompt as number,
          completion: msg.completion as number,
          total: msg.total as number,
          byModel: (msg.by_model as Record<string, { prompt: number; completion: number }>) ?? {},
        })
        break
      case 'model_fallback':
        s.setFallbackToast({ from: msg.from as string, to: msg.to as string, reason: msg.reason as string })
        break
      case 'stt_error':
        // 识别失败但绝不降级：提示并保持当前所选模式，下一段继续尝试
        s.pushToast(
          `语音识别暂时失败（保持 ${msg.provider as string} 模式）：${(msg.reason as string) || '未知原因'}`,
          'warn',
        )
        break
      case 'stt_stream_state':
        if (msg.state === 'reconnecting') {
          s.pushToast('实时识别连接中断，正在自动重连…', 'warn')
        } else if (msg.state === 'recovered') {
          s.pushToast('实时识别已恢复', 'info')
        }
        break
      case 'resume_opt_start':
        s.resetResumeOpt(typeof msg.job_id === 'string' ? msg.job_id : null)
        s.setResumeOptLoading(true)
        break
      case 'resume_opt_chunk':
        s.appendResumeOptChunk(msg.chunk as string, typeof msg.job_id === 'string' ? msg.job_id : null)
        break
      case 'resume_opt_done':
        s.setResumeOptResult(msg.text as string, typeof msg.job_id === 'string' ? msg.job_id : null)
        break
      case 'error': {
        s.setLastWSError((msg.message as string) || '未知错误')
        // 追踪定时器, 避免连续两条 error 时旧定时器提前抹掉新消息
        if (wsErrorClearTimer !== null) clearTimeout(wsErrorClearTimer)
        wsErrorClearTimer = setTimeout(() => {
          wsErrorClearTimer = null
          useInterviewStore.getState().setLastWSError(null)
        }, 5000)
        break
      }
      case 'kb_hits':
        useKbStore.getState().appendHits({
          qa_id: msg.qa_id as string,
          latency_ms: (msg.latency_ms as number) ?? 0,
          degraded: !!msg.degraded,
          hit_count: (msg.hit_count as number) ?? (Array.isArray(msg.hits) ? (msg.hits as unknown[]).length : 0),
          hits: Array.isArray(msg.hits) ? (msg.hits as Parameters<ReturnType<typeof useKbStore.getState>['appendHits']>[0]['hits']) : [],
        })
        break
    }
  }

  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null

    const teardown = () => {
      shouldReconnect.current = false
      reconnectAttempts.current = 0
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      if (wsRef.current) {
        try { wsRef.current.close() } catch (err) { console.warn('[ws] teardown close failed', err) }
        wsRef.current = null
      }
      useInterviewStore.getState().setWsConnected(false)
      useInterviewStore.getState().setWsIsLeader(false)
    }

    if (!active) {
      teardown()
      return teardown
    }

    unsubscribe = subscribeLeader((isLeader) => {
      useInterviewStore.getState().setWsIsLeader(isLeader)
      if (isLeader) {
        shouldReconnect.current = true
        reconnectAttempts.current = 0
        connect()
      } else {
        teardown()
      }
    })

    pingTimer = setInterval(() => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      // watchdog：长时间没收到任何服务端帧，认定连接已僵尸，主动重连。
      if (Date.now() - lastServerPongAt.current > PONG_TIMEOUT_MS) {
        console.warn('[ws] pong watchdog timeout, reconnecting')
        try { ws.close() } catch (err) { console.warn('[ws] watchdog close failed', err) }
        return
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }))
      } catch (err) {
        console.warn('[ws] client ping send failed', err)
      }
    }, CLIENT_PING_INTERVAL_MS)

    return () => {
      unsubscribe?.()
      if (pingTimer) clearInterval(pingTimer)
      teardown()
    }
    // 除 active 外，内部依赖都通过 ref/store getState 访问，不需要因 store 变化重建连接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}
