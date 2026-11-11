import { useCallback, useEffect, useRef, useState } from 'react'
import { api, getErrorMessage } from '@/lib/api'
import { buildWsUrl } from '@/lib/backendUrl'

type CaptureState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error'

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

export function useMobileAudioCapture() {
  const [state, setState] = useState<CaptureState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const sinkRef = useRef<GainNode | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null)
  const stateRef = useRef<CaptureState>('idle')
  const intentionalStopRef = useRef(false)

  const publishState = useCallback((next: CaptureState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const closeLocalCapture = useCallback(() => {
    void wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
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
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {})
    }
  }, [])

  const stop = useCallback(async (stopBackend = true) => {
    intentionalStopRef.current = true
    publishState('stopping')
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop' }))
      }
    } catch {
      /* ignore */
    }
    try {
      wsRef.current?.close()
    } catch {
      /* ignore */
    }
    wsRef.current = null
    closeLocalCapture()
    setLevel(0)
    if (stopBackend) {
      try {
        await api.stop()
      } catch {
        /* local cleanup still succeeds */
      }
    }
    publishState('idle')
    intentionalStopRef.current = false
  }, [closeLocalCapture, publishState])

  const start = useCallback(async () => {
    if (stateRef.current === 'starting' || stateRef.current === 'recording') return
    setError(null)
    if (!window.isSecureContext) {
      setError('手机麦克风只能在 HTTPS 页面使用，请从设置中的 HTTPS 二维码重新打开')
      publishState('error')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前手机浏览器不支持麦克风采集')
      publishState('error')
      return
    }

    publishState('starting')
    intentionalStopRef.current = false
    try {
      await api.mobileCaptureStart('ai_interview')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
        video: false,
      })
      streamRef.current = stream
      const ws = new WebSocket(buildWsUrl('/ws/mobile-audio'))
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('连接手机音频服务超时')), 10000)
        ws.onopen = () => {
          window.clearTimeout(timer)
          resolve()
        }
        ws.onerror = () => {
          window.clearTimeout(timer)
          reject(new Error('连接手机音频服务失败'))
        }
      })
      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data))
          if (payload.type === 'mobile_audio_error') {
            setError(String(payload.message || '手机音频识别失败'))
          }
        } catch {
          /* status messages are optional */
        }
      }
      ws.onclose = () => {
        if (!intentionalStopRef.current && stateRef.current === 'recording') {
          setError('手机音频连接已断开，请重新开始采集')
          publishState('error')
        }
      }

      const AudioContextCtor = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextCtor) throw new Error('当前浏览器不支持音频处理')
      const context = new AudioContextCtor()
      contextRef.current = context
      await context.resume()
      const source = context.createMediaStreamSource(stream)
      sourceRef.current = source
      const processor = context.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      const sink = context.createGain()
      sink.gain.value = 0
      sinkRef.current = sink
      processor.onaudioprocess = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return
        const input = event.inputBuffer.getChannelData(0)
        let energy = 0
        for (let index = 0; index < input.length; index += 1) {
          energy += input[index] * input[index]
        }
        const rms = Math.sqrt(energy / Math.max(1, input.length))
        setLevel((current) => current * 0.75 + rms * 0.25)
        const pcm = downsample(input, context.sampleRate, 16000)
        ws.send(toPcm16(pcm))
      }
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)
      try {
        const wakeLockApi = (navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
        }).wakeLock
        wakeLockRef.current = await wakeLockApi?.request('screen') ?? null
      } catch {
        /* wake lock is optional */
      }
      publishState('recording')
    } catch (err) {
      closeLocalCapture()
      try {
        wsRef.current?.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
      setError(getErrorMessage(err, '启动手机音频采集失败'))
      publishState('error')
      try {
        await api.stop()
      } catch {
        /* ignore */
      }
    }
  }, [closeLocalCapture, publishState])

  useEffect(() => () => {
    intentionalStopRef.current = true
    const wasRecording = stateRef.current === 'recording' || stateRef.current === 'starting'
    try {
      wsRef.current?.close()
    } catch {
      /* ignore */
    }
    closeLocalCapture()
    if (wasRecording) void api.stop().catch(() => {})
  }, [closeLocalCapture])

  return {
    state,
    error,
    level,
    isSecure: typeof window !== 'undefined' && window.isSecureContext,
    start,
    stop,
  }
}
