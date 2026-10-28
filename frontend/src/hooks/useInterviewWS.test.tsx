import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useInterviewWS } from './useInterviewWS'
import { useInterviewStore } from '@/stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

vi.mock('@/lib/backendUrl', () => ({
  buildWsUrl: vi.fn(() => 'ws://example.test/ws'),
}))

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CONNECTING = 0

  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  closed = false

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  emitClose() {
    this.readyState = FakeWebSocket.CONNECTING
    this.onclose?.()
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.closed = true
    this.onclose?.()
  }
}

function Harness({ active = true }: { active?: boolean }) {
  useInterviewWS(active)
  return null
}

describe('useInterviewWS', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    useInterviewStore.setState({
      qaPairs: [],
      streamingIds: [],
      currentStreamingId: null,
      transcriptions: [],
      isPaused: false,
      wsConnected: false,
      isRecording: false,
      sttLoaded: false,
      sttLoading: true,
      sttActiveProvider: '',
      sttFallbackLoaded: false,
      modelHealth: {},
      modelHealthDetail: {},
      modelHealthLatency: {},
      tokenUsage: { prompt: 0, completion: 0, total: 0, byModel: {} },
      resumeOptLoading: false,
      resumeOptStreaming: '',
      resumeOptResult: '',
      resumeOptJobId: null,
      toastMessage: null,
      toasts: [],
      lastWSError: null,
    } as any)
    useUiPrefsStore.setState({ appMode: 'assist' } as any)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('maps init and answer messages into store state', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({
        type: 'init',
        is_recording: true,
        is_paused: false,
        stt_loaded: true,
        transcriptions: ['hello'],
        qa_pairs: [{ id: 'q1', question: 'Q', answer: 'A', timestamp: 1 }],
      })
      ws.emitMessage({
        type: 'transcription_updated',
        id: 'legacy-0',
        text: 'hello revised',
        qa_id: 'q1',
      })
      ws.emitMessage({ type: 'answer_start', id: 'q2', question: 'Next', model_name: 'demo' })
      ws.emitMessage({ type: 'answer_chunk', id: 'q2', chunk: 'part' })
    })

    act(() => {
      vi.advanceTimersByTime(80)
    })

    const state = useInterviewStore.getState()
    expect(state.wsConnected).toBe(true)
    expect(state.isRecording).toBe(true)
    expect(state.transcriptions).toEqual([
      { id: 'legacy-0', text: 'hello revised' },
    ])
    expect(state.qaPairs[0].question).toBe('Q')
    expect(state.qaPairs[1].answer).toContain('part')
  })

  it('stores screenshot images from answer_start and restores them from init snapshot', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]
    act(() => {
      ws.emitOpen()
      ws.emitMessage({
        type: 'init',
        qa_pairs: [{
          id: 'qa-old',
          question: '截图审题',
          answer: '旧答案',
          timestamp: 1,
          images: ['data:image/png;base64,old'],
        }],
      })
      ws.emitMessage({
        type: 'answer_start',
        id: 'qa-new',
        question: '截图审题',
        images: ['data:image/png;base64,new1', 'data:image/png;base64,new2'],
      })
      ws.emitMessage({
        type: 'answer_done',
        id: 'qa-new',
        question: '截图审题',
        answer: '答案',
        images: ['data:image/png;base64,new1', 'data:image/png;base64,new2'],
      })
    })

    const state = useInterviewStore.getState()
    expect(state.qaPairs[0].images).toEqual(['data:image/png;base64,old'])
    expect(state.qaPairs[1].images).toEqual(['data:image/png;base64,new1', 'data:image/png;base64,new2'])
  })

  it('maps transcription_interim into interimTranscription and clears on empty text', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({ type: 'transcription_interim', text: '你', sentence_id: 1 })
    })
    expect(useInterviewStore.getState().interimTranscription).toBe('你')

    act(() => {
      ws.emitMessage({ type: 'transcription_interim', text: '你好', sentence_id: 1 })
    })
    expect(useInterviewStore.getState().interimTranscription).toBe('你好')

    act(() => {
      ws.emitMessage({ type: 'transcription_interim', text: '', sentence_id: 1 })
    })
    expect(useInterviewStore.getState().interimTranscription).toBe('')
  })

  it('clears interimTranscription on stop, pause and clearSession', () => {
    const store = useInterviewStore.getState()
    store.setInterimTranscription('部分文字')
    expect(useInterviewStore.getState().interimTranscription).toBe('部分文字')
    store.setRecording(false)
    expect(useInterviewStore.getState().interimTranscription).toBe('')

    store.setInterimTranscription('部分文字')
    store.setPaused(true)
    expect(useInterviewStore.getState().interimTranscription).toBe('')

    store.setInterimTranscription('部分文字')
    store.clearSession()
    expect(useInterviewStore.getState().interimTranscription).toBe('')
  })

  it('labels generation and persistence answer failures accurately', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({ type: 'answer_start', id: 'q-generation', question: '生成失败题' })
      ws.emitMessage({
        type: 'answer_error',
        id: 'q-generation',
        stage: 'generation',
        message: '大模型响应超时',
      })
      ws.emitMessage({ type: 'answer_start', id: 'q-persistence', question: '保存失败题' })
      ws.emitMessage({
        type: 'answer_error',
        id: 'q-persistence',
        stage: 'persistence',
        message: '答案保存失败',
      })
    })

    const state = useInterviewStore.getState()
    expect(state.qaPairs).toMatchObject([
      { id: 'q-generation', status: 'error', errorMessage: '大模型响应超时' },
      { id: 'q-persistence', status: 'error', errorMessage: '答案保存失败' },
    ])
    expect(state.toasts.slice(-2).map((toast) => toast.message)).toEqual([
      '答案生成失败: 大模型响应超时',
      '答案保存失败',
    ])
  })

  it('does not connect while inactive and connects after activation', () => {
    const { rerender } = render(<Harness active={false} />)

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(useInterviewStore.getState().wsConnected).toBe(false)
    expect(useInterviewStore.getState().wsIsLeader).toBe(false)

    rerender(<Harness active />)

    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('closes the websocket when deactivated', () => {
    const { rerender } = render(<Harness active />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
    })
    expect(useInterviewStore.getState().wsConnected).toBe(true)

    rerender(<Harness active={false} />)

    expect(ws.closed).toBe(true)
    expect(useInterviewStore.getState().wsConnected).toBe(false)
    expect(useInterviewStore.getState().wsIsLeader).toBe(false)
  })

  it('ignores stale websocket events after deactivation', () => {
    const { rerender } = render(<Harness active />)
    const ws = FakeWebSocket.instances[0]

    rerender(<Harness active={false} />)

    act(() => {
      ws.emitOpen()
      ws.emitMessage({ type: 'answer_start', id: 'stale', question: '旧连接问题' })
    })

    const state = useInterviewStore.getState()
    expect(state.wsConnected).toBe(false)
    expect(state.qaPairs).toEqual([])
  })

  it('reconnects after close', () => {
    render(<Harness />)
    const first = FakeWebSocket.instances[0]

    act(() => {
      first.emitOpen()
      first.emitClose()
      vi.advanceTimersByTime(2000)
    })

    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('ignores stale messages from a previous websocket after reconnect', () => {
    render(<Harness />)
    const first = FakeWebSocket.instances[0]

    act(() => {
      first.emitOpen()
      first.emitClose()
      vi.advanceTimersByTime(1000)
    })

    const second = FakeWebSocket.instances[1]
    act(() => {
      second.emitOpen()
      first.emitMessage({ type: 'answer_start', id: 'stale', question: '旧连接问题' })
      second.emitMessage({ type: 'answer_start', id: 'fresh', question: '新连接问题' })
    })

    const state = useInterviewStore.getState()
    expect(state.qaPairs.map((qa) => qa.id)).toEqual(['fresh'])
    expect(state.currentStreamingId).toBe('fresh')
  })

  it('recovers speech readiness when the final loading status was missed while disconnected', () => {
    render(<Harness />)
    const first = FakeWebSocket.instances[0]
    act(() => {
      first.emitOpen()
      first.emitMessage({ type: 'stt_status', loaded: false, loading: true, provider: 'whisper' })
      first.emitClose()
      vi.advanceTimersByTime(1000)
    })

    expect(useInterviewStore.getState().sttLoading).toBe(true)
    const second = FakeWebSocket.instances[1]
    act(() => {
      second.emitOpen()
      second.emitMessage({
        type: 'init',
        stt_loaded: true,
        stt_loading: false,
        stt_provider: 'whisper',
      })
    })

    expect(useInterviewStore.getState()).toMatchObject({
      wsConnected: true,
      sttLoaded: true,
      sttLoading: false,
      sttActiveProvider: 'whisper',
    })
  })

  it('warns when candidate microphone degrades safely', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({
        type: 'candidate_asr_status',
        loaded: false,
        loading: false,
        provider: 'off',
        error: 'mic unavailable',
        safe_degraded: true,
      })
    })

    const state = useInterviewStore.getState()
    expect(state.candidateSttLoaded).toBe(false)
    expect(state.toastMessage).toContain('候选人口述记录已关闭，不影响面试录音')
  })

  it('warns immediately when screenshot self-check fails', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({
        type: 'answer_start',
        id: 'qa-screen',
        question: '多图截图代码题',
        source: 'server_screen_multi',
        model_name: 'Lite Ark',
      })
      ws.emitMessage({
        type: 'answer_done',
        id: 'qa-screen',
        question: '多图截图代码题',
        answer: '```python\nprint(0)\n```',
        think: '',
        model_name: 'Lite Ark',
      })
      ws.emitMessage({
        type: 'vision_verify',
        id: 'qa-screen',
        verdict: 'FAIL',
        reason: '截图里的第二个样例不通过',
      })
    })

    const state = useInterviewStore.getState()
    expect(state.qaPairs[0].visionVerify).toEqual({
      verdict: 'FAIL',
      reason: '截图里的第二个样例不通过',
    })
    expect(state.toasts[state.toasts.length - 1]).toMatchObject({
      level: 'warn',
      message: '截图自检不一致，请人工复核：截图里的第二个样例不通过',
      ttlMs: 6000,
    })
  })

  it('keeps successful screenshot self-check quiet', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({
        type: 'answer_start',
        id: 'qa-screen',
        question: '截图代码题',
        source: 'server_screen_left',
        model_name: 'Lite Ark',
      })
      ws.emitMessage({
        type: 'vision_verify',
        id: 'qa-screen',
        verdict: 'PASS',
        reason: '样例与约束匹配',
      })
    })

    const state = useInterviewStore.getState()
    expect(state.qaPairs[0].visionVerify).toEqual({
      verdict: 'PASS',
      reason: '样例与约束匹配',
    })
    expect(state.toasts).toEqual([])
  })

  it('ignores stale resume optimization chunks from older jobs', () => {
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({ type: 'resume_opt_start', job_id: 'job-old' })
      ws.emitMessage({ type: 'resume_opt_chunk', job_id: 'job-old', chunk: 'old-1' })
      ws.emitMessage({ type: 'resume_opt_start', job_id: 'job-new' })
      ws.emitMessage({ type: 'resume_opt_chunk', job_id: 'job-old', chunk: 'stale-old' })
      ws.emitMessage({ type: 'resume_opt_chunk', job_id: 'job-new', chunk: 'new-1' })
      ws.emitMessage({ type: 'resume_opt_done', job_id: 'job-new', text: 'new-final' })
      ws.emitMessage({ type: 'resume_opt_done', job_id: 'job-old', text: 'old-final' })
    })

    const state = useInterviewStore.getState()
    expect(state.resumeOptResult).toBe('new-final')
    expect(state.resumeOptStreaming).toBe('')
    expect(state.resumeOptLoading).toBe(false)
  })

  it('keeps scoped module state updates when another app tab is active', () => {
    useUiPrefsStore.setState({ appMode: 'assist' } as any)
    render(<Harness />)
    const ws = FakeWebSocket.instances[0]

    act(() => {
      ws.emitOpen()
      ws.emitMessage({ type: 'resume_opt_start', scope: 'resume-opt', job_id: 'job-bg' })
      ws.emitMessage({ type: 'resume_opt_chunk', scope: 'resume-opt', job_id: 'job-bg', chunk: '后台分析' })
      ws.emitMessage({ type: 'resume_opt_done', scope: 'resume-opt', job_id: 'job-bg', text: '后台分析完成' })
    })

    const state = useInterviewStore.getState()
    expect(state.resumeOptResult).toBe('后台分析完成')
    expect(state.resumeOptLoading).toBe(false)
  })
})
