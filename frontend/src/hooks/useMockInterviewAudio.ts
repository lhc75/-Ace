import { useCallback, useEffect, useRef, useState } from 'react'
import { buildWsUrl } from '@/lib/backendUrl'

export type MockAudioState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error'

function downsample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (outputRate >= inputRate) return input
  const ratio = inputRate / outputRate
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)))
    let total = 0
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      total += input[sourceIndex]
    }
    output[index] = total / Math.max(1, end - start)
  }
  return output
}

function toPcm16(input: Float32Array): ArrayBuffer {
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output.buffer
}

interface UseMockInterviewAudioOptions {
  active: boolean
  sessionId: number | null
  questionId: string | null
  onSegment: (text: string, segmentId: string) => void
}

export function useMockInterviewAudio({
  active,
  sessionId,
  questionId,
  onSegment,
}: UseMockInterviewAudioOptions) {
  const [state, setState] = useState<MockAudioState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const [level, setLevel] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const sinkRef = useRef<GainNode | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const stateRef = useRef<MockAudioState>('idle')
  const onSegmentRef = useRef(onSegment)
  const flushedResolverRef = useRef<(() => void) | null>(null)
  const activeKeyRef = useRef('')
  const intentionalStopRef = useRef(false)

  useEffect(() => {
    onSegmentRef.current = onSegment
  }, [onSegment])

  const publishState = useCallback((next: MockAudioState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const cleanupLocal = useCallback(() => {
    try {
      processorRef.current?.disconnect()
      sourceRef.current?.disconnect()
      sinkRef.current?.disconnect()
    } catch {
      /* already disconnected */
    }
    processorRef.current = null
    sourceRef.current = null
    sinkRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') void context.close().catch(() => undefined)
    setLevel(0)
    setTranscribing(false)
  }, [])

  const cleanupSocket = useCallback(() => {
    flushedResolverRef.current?.()
    flushedResolverRef.current = null
    try {
      wsRef.current?.close()
    } catch {
      /* ignore */
    }
    wsRef.current = null
  }, [])

  const stopAndFlush = useCallback(async (): Promise<void> => {
    if (stateRef.current === 'idle') return
    intentionalStopRef.current = true
    publishState('stopping')
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      const flushed = new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 7000)
        flushedResolverRef.current = () => {
          window.clearTimeout(timer)
          resolve()
        }
        try {
          ws.send(JSON.stringify({ type: 'stop' }))
        } catch {
          flushedResolverRef.current?.()
        }
      })
      await flushed
    }
    cleanupSocket()
    cleanupLocal()
    setError(null)
    publishState('idle')
  }, [cleanupLocal, cleanupSocket, publishState])

  const start = useCallback(async () => {
    if (!active || !sessionId || !questionId) return
    if (stateRef.current === 'starting' || stateRef.current === 'recording') return
    setError(null)
    setTranscribing(false)
    intentionalStopRef.current = false
    publishState('starting')
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前环境不支持麦克风采集，可直接输入回答')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
        video: false,
      })
      if (intentionalStopRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const context = new AudioContext()
      contextRef.current = context
      const source = context.createMediaStreamSource(stream)
      sourceRef.current = source
      const processor = context.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      const sink = context.createGain()
      sink.gain.value = 0
      sinkRef.current = sink
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)

      const query = new URLSearchParams({ session_id: String(sessionId), question_id: questionId })
      const ws = new WebSocket(buildWsUrl(`/ws/mock-interview/audio?${query.toString()}`))
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('连接语音转写服务超时')), 10000)
        ws.onopen = () => {
          window.clearTimeout(timer)
          resolve()
        }
        ws.onerror = () => {
          window.clearTimeout(timer)
          reject(new Error('连接语音转写服务失败'))
        }
      })
      if (intentionalStopRef.current) {
        cleanupSocket()
        cleanupLocal()
        return
      }
      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as Record<string, unknown>
          if (payload.type === 'segment_final') {
            const text = String(payload.text || '').trim()
            if (text) onSegmentRef.current(text, String(payload.segment_id || ''))
          } else if (payload.type === 'transcribing') {
            setTranscribing(Boolean(payload.value))
          } else if (payload.type === 'asr_error') {
            setError(String(payload.message || '语音识别失败，可直接输入文字'))
          } else if (payload.type === 'flushed') {
            flushedResolverRef.current?.()
          }
        } catch {
          /* ignore malformed frame */
        }
      }
      ws.onclose = () => {
        if (stateRef.current === 'recording') {
          setError('语音转写连接已断开，可直接输入文字')
          publishState('error')
        }
      }
      ws.onerror = () => {
        setError('语音转写连接异常，可直接输入文字')
      }

      processor.onaudioprocess = (event) => {
        const socket = wsRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        const input = event.inputBuffer.getChannelData(0)
        let sum = 0
        for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index]
        setLevel(Math.sqrt(sum / Math.max(1, input.length)))
        const pcm = downsample(input, context.sampleRate, 16000)
        socket.send(toPcm16(pcm))
      }
      publishState('recording')
    } catch (err) {
      cleanupSocket()
      cleanupLocal()
      setError(err instanceof Error ? err.message : '麦克风启动失败，可直接输入回答')
      publishState('error')
    }
  }, [active, cleanupLocal, cleanupSocket, publishState, questionId, sessionId])

  useEffect(() => {
    const key = active && sessionId && questionId ? `${sessionId}:${questionId}` : ''
    if (key === activeKeyRef.current) return
    activeKeyRef.current = key
    if (!active) {
      void stopAndFlush()
      return
    }
    void start()
  }, [active, questionId, sessionId, start, stopAndFlush])

  useEffect(() => {
    return () => {
      cleanupSocket()
      cleanupLocal()
    }
  }, [cleanupLocal, cleanupSocket])

  return {
    state,
    error,
    transcribing,
    level,
    start,
    stopAndFlush,
  }
}
