import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AnswerPanel from './AnswerPanel'
import { useInterviewStore } from '@/stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

vi.mock('./SoundTest', () => ({ default: () => <div>sound-test-ready</div> }))
vi.mock('./WrittenExamTest', () => ({ default: () => <div>written-exam-test-ready</div> }))

const apiMock = vi.hoisted(() => ({
  ask: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: apiMock,
  getErrorMessage: (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback,
}))

function resetStores(writtenExamMode = false) {
  useInterviewStore.setState({
    isRecording: false,
    isPaused: false,
    qaPairs: [],
    streamingIds: [],
    currentStreamingId: null,
    config: {
      api_key_set: true,
      written_exam_mode: writtenExamMode,
      models: [{ name: 'Lite Ark', enabled: true, supports_vision: true, supports_think: true }],
      active_model: 0,
      answer_autoscroll_bottom_px: 40,
    },
    toggleSettings: vi.fn(),
  } as any)
  useUiPrefsStore.setState({
    answerPanelLayout: 'cards',
    colorScheme: 'aurora',
  } as any)
}

describe('AnswerPanel empty recording state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.ask.mockReset()
    resetStores(false)
  })

  it('hides the sound preflight panel while interview recording is active', async () => {
    render(<AnswerPanel />)

    expect(await screen.findByText('sound-test-ready')).toBeInTheDocument()

    act(() => {
      useInterviewStore.getState().setRecording(true)
    })

    await waitFor(() => {
      expect(screen.queryByText('sound-test-ready')).not.toBeInTheDocument()
    })

    act(() => {
      useInterviewStore.getState().setRecording(false)
    })

    expect(await screen.findByText('sound-test-ready')).toBeInTheDocument()
  })

  it('hides the written exam preflight panel while exam recording is active', async () => {
    resetStores(true)
    render(<AnswerPanel />)

    expect(await screen.findByText('written-exam-test-ready')).toBeInTheDocument()

    act(() => {
      useInterviewStore.getState().setRecording(true)
    })

    await waitFor(() => {
      expect(screen.queryByText('written-exam-test-ready')).not.toBeInTheDocument()
    })
  })

  it('labels realtime and multi-screenshot answer sources', async () => {
    resetStores(false)
    useInterviewStore.setState({
      qaPairs: [
        {
          id: 'qa-asr',
          question: 'Redis 怎么持久化？',
          answer: 'AOF 和 RDB 组合。',
          thinkContent: '',
          isThinking: false,
          timestamp: 1710000000,
          questionSource: 'asr',
          modelLabel: 'Lite Ark',
          status: 'done',
        },
        {
          id: 'qa-screen',
          question: '两张截图里的代码题怎么修？',
          answer: '```python\nprint("ok")\n```',
          thinkContent: '',
          isThinking: false,
          timestamp: 1710000001,
          questionSource: 'server_screen_multi',
          modelLabel: 'Lite Ark',
          status: 'done',
        },
      ],
      streamingIds: [],
    } as any)

    render(<AnswerPanel />)

    expect(screen.getByText('实时转写')).toBeInTheDocument()
    expect(screen.getByText('连续截图审题')).toBeInTheDocument()
  })

  it('renders markdown while the answer is still streaming', async () => {
    useInterviewStore.setState({
      qaPairs: [{
        id: 'qa-stream',
        question: '说说 Redis 持久化',
        answer: '## 核心思路\n\n先用 **RDB** 快照',
        thinkContent: '',
        isThinking: false,
        timestamp: 1710000003,
        questionSource: 'manual_text',
        modelLabel: 'Lite Ark',
        status: 'streaming',
      }],
      streamingIds: ['qa-stream'],
    } as any)

    render(<AnswerPanel />)

    // Cherry 式流式渲染: 流式期间也直接渲染 markdown, 不能出现原始 "##" 文本
    // (AnswerMarkdownContent 走 lazy import, 全量并发下加载较慢, 放宽等待时间)
    expect(await screen.findByRole('heading', { level: 2, name: '核心思路' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/## 核心思路/)).not.toBeInTheDocument()
    expect(screen.getByText('RDB').tagName).toBe('STRONG')
  })

  it('renders persisted web search sources on an answer card', async () => {
    useInterviewStore.setState({
      qaPairs: [{
        id: 'qa-web',
        question: 'Redis 持久化怎么选？',
        answer: 'RDB 和 AOF 通常组合使用。',
        thinkContent: '',
        isThinking: false,
        timestamp: 1710000002,
        questionSource: 'manual_text',
        modelLabel: 'DeepSeek',
        status: 'done',
        webSources: [{
          rank: 1,
          title: 'Redis Persistence',
          url: 'https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/',
          site_name: 'Redis',
          authority: 4,
        }],
      }],
      streamingIds: [],
    } as any)

    render(<AnswerPanel />)

    expect(screen.getByText('联网参考来源')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /1\. Redis Persistence/ })
    expect(link).toHaveAttribute('href', 'https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('starts auto-follow when the first answer arrives after an empty state', async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
    const clientHeightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280)

    try {
      render(<AnswerPanel />)

      act(() => {
        useInterviewStore.setState({
          qaPairs: [{
            id: 'qa-first',
            question: '第一道题',
            answer: '正在生成',
            thinkContent: '',
            isThinking: false,
            timestamp: Date.now(),
            status: 'streaming',
          }],
          streamingIds: ['qa-first'],
        } as any)
      })

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        })
      } else {
        delete (Element.prototype as any).scrollIntoView
      }
      scrollHeightSpy.mockRestore()
      clientHeightSpy.mockRestore()
    }
  })

  it('edits a text question and resends it into the same QA card', async () => {
    apiMock.ask.mockResolvedValue({ ok: true })
    useInterviewStore.setState({
      transcriptions: [{
        id: 'tr-edit',
        text: '语音识别出的旧问题',
      }],
      qaPairs: [{
        id: 'qa-edit',
        question: '语音识别出的旧问题',
        answer: '旧答案',
        thinkContent: '旧思考',
        isThinking: false,
        timestamp: 1710000000,
        questionSource: 'asr',
        modelLabel: 'Lite Ark',
        sourceTranscriptionIds: ['tr-edit'],
        status: 'done',
      }],
    } as any)

    render(<AnswerPanel />)

    fireEvent.click(screen.getByRole('button', { name: '编辑问题后重新发送' }))
    const editor = screen.getByRole('textbox', { name: '编辑面试官问题' })
    fireEvent.change(editor, { target: { value: '修正后的面试官问题' } })
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))

    await waitFor(() => {
      expect(apiMock.ask).toHaveBeenCalledWith(
        '修正后的面试官问题',
        undefined,
        { replaceQaId: 'qa-edit' },
      )
    })
    const state = useInterviewStore.getState()
    expect(state.qaPairs).toHaveLength(1)
    expect(state.qaPairs[0]).toMatchObject({
      id: 'qa-edit',
      question: '修正后的面试官问题',
      answer: '',
      status: 'streaming',
      isResending: true,
    })
    expect(state.transcriptions).toEqual([{
      id: 'tr-edit',
      text: '修正后的面试官问题',
    }])
  })

  it('allows editing and resending an existing question while paused', async () => {
    apiMock.ask.mockResolvedValue({ ok: true })
    useInterviewStore.setState({
      isRecording: true,
      isPaused: true,
      qaPairs: [{
        id: 'qa-paused-edit',
        question: '暂停前识别的问题',
        answer: '旧答案',
        thinkContent: '',
        isThinking: false,
        timestamp: 1710000000,
        questionSource: 'asr',
        status: 'done',
      }],
    } as any)

    render(<AnswerPanel />)

    fireEvent.click(screen.getByRole('button', { name: '编辑问题后重新发送' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: '编辑面试官问题' }),
      { target: { value: '暂停时修正的问题' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))

    await waitFor(() => {
      expect(apiMock.ask).toHaveBeenCalledWith(
        '暂停时修正的问题',
        undefined,
        { replaceQaId: 'qa-paused-edit' },
      )
    })
  })

  it('restores the old question and answer when resend fails', async () => {
    apiMock.ask.mockRejectedValue(new Error('网络不可用'))
    useInterviewStore.setState({
      qaPairs: [{
        id: 'qa-edit-failed',
        question: '原始问题',
        answer: '原始答案',
        thinkContent: '原始思考',
        isThinking: false,
        timestamp: 1710000000,
        questionSource: 'asr',
        modelLabel: 'Lite Ark',
        status: 'done',
      }],
    } as any)

    render(<AnswerPanel />)

    fireEvent.click(screen.getByRole('button', { name: '编辑问题后重新发送' }))
    const editor = screen.getByRole('textbox', { name: '编辑面试官问题' })
    fireEvent.change(editor, { target: { value: '会失败的新问题' } })
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))

    expect(await screen.findByRole('textbox', { name: '编辑面试官问题' })).toHaveValue('原始问题')
    expect(useInterviewStore.getState().qaPairs[0]).toMatchObject({
      question: '原始问题',
      answer: '原始答案',
      status: 'done',
      isResending: false,
    })
    const toasts = useInterviewStore.getState().toasts
    expect(toasts[toasts.length - 1]?.message).toBe('网络不可用')
  })
})
