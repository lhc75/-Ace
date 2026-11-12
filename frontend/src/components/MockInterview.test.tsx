import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import MockInterview, { appendTranscript } from './MockInterview'
import { useInterviewStore } from '@/stores/configStore'
import type { MockInterviewSession, MockInterviewQuestion } from '@/types/mock-interview'

const apiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  startAnswer: vi.fn(),
  saveDraft: vi.fn(),
  submitAnswer: vi.fn(),
  finishSession: vi.fn(),
  saveSelfAssessment: vi.fn(),
  deleteSession: vi.fn(),
}))

const audioMock = vi.hoisted(() => ({
  stopAndFlush: vi.fn(),
  start: vi.fn(),
}))

vi.mock('@/lib/mockInterviewAPI', () => ({ mockInterviewAPI: apiMock }))
vi.mock('@/hooks/useMockInterviewAudio', () => ({
  useMockInterviewAudio: () => ({
    state: 'recording',
    error: null,
    transcribing: false,
    level: 0.04,
    start: audioMock.start,
    stopAndFlush: audioMock.stopAndFlush,
  }),
}))
vi.mock('@/components/resume/ResumeMount', () => ({
  ResumeMountPanel: () => <div data-testid="resume-mount-panel">resume</div>,
}))
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

const now = () => Date.now() / 1000

function question(overrides: Partial<MockInterviewQuestion> = {}): MockInterviewQuestion {
  return {
    id: 'q-1',
    session_id: 7,
    main_index: 1,
    turn_index: 1,
    kind: 'main',
    parent_id: null,
    category: 'technical',
    question_text: '请说明一次缓存优化的完整过程。',
    answer_time_limit_seconds: 120,
    prep_seconds: 15,
    phase: 'answering',
    prep_started_at: now() - 20,
    answer_started_at: now(),
    answer_deadline_at: now() + 120,
    draft_text: '',
    answer_text: '',
    auto_submitted: false,
    score: null,
    evaluation: {},
    asked_at: now(),
    answered_at: null,
    ...overrides,
  }
}

function session(overrides: Partial<MockInterviewSession> = {}): MockInterviewSession {
  const q = question()
  return {
    id: 7,
    status: 'in_progress',
    position: 'Java 后端开发',
    company: '示例公司',
    job_description: '',
    difficulty: 'medium',
    focus: 'balanced',
    resume_filename: 'resume.pdf',
    model_name: 'demo-model',
    main_index: 1,
    turn_count: 1,
    current_question_id: q.id,
    total_score: null,
    report: null,
    self_rating: null,
    self_note: '',
    self_tags: [],
    error_message: null,
    created_at: now(),
    updated_at: now(),
    completed_at: null,
    has_resume: true,
    main_question_target: 10,
    max_follow_ups: 3,
    answered_count: 0,
    main_answered_count: 0,
    current_question: q,
    questions: [q],
    ...overrides,
  }
}

describe('appendTranscript', () => {
  it('concatenates speech segments without overwriting edited text', () => {
    expect(appendTranscript('我负责订单系统。', '后来做了缓存优化。')).toBe('我负责订单系统。后来做了缓存优化。')
  })

  it('keeps English terms separated and ignores duplicate final segments', () => {
    expect(appendTranscript('I used Redis', 'and MySQL')).toBe('I used Redis and MySQL')
    expect(appendTranscript('已经识别的内容', '已经识别的内容')).toBe('已经识别的内容')
  })
})

describe('MockInterview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    audioMock.stopAndFlush.mockResolvedValue(undefined)
    apiMock.listSessions.mockResolvedValue({ items: [] })
    apiMock.saveDraft.mockResolvedValue({ ok: true, saved_at: now() })
    useInterviewStore.setState({
      config: {
        has_resume: true,
        position: 'Java 后端开发',
        language: '中文',
        resume_active_filename: 'resume.pdf',
        resume_active_history_id: 3,
      },
      setToastMessage: vi.fn(),
    } as any)
  })

  it('renders setup and creates a ten-question mock interview', async () => {
    const created = session()
    apiMock.createSession.mockResolvedValue(created)

    render(<MockInterview />)

    expect(await screen.findByRole('heading', { name: 'AI 模拟面试' })).toBeInTheDocument()
    expect(screen.getByText(/10 个主问题，每个最多 3 次追问/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始 AI 模拟面试' }))

    await waitFor(() => {
      expect(apiMock.createSession).toHaveBeenCalledWith(expect.objectContaining({
        position: 'Java 后端开发',
        difficulty: 'medium',
        focus: 'balanced',
      }))
    })
    expect(await screen.findByText('请说明一次缓存优化的完整过程。')).toBeInTheDocument()
  })

  it('keeps speech text editable and submits only after the user clicks send', async () => {
    const active = session()
    apiMock.listSessions.mockResolvedValue({ items: [active] })
    apiMock.getSession.mockResolvedValue(active)
    apiMock.submitAnswer.mockResolvedValue({
      assessment: {},
      ready_to_finish: false,
      session: session({ current_question_id: 'q-2' }),
    })

    render(<MockInterview />)

    const input = await screen.findByTestId('mock-answer-input')
    fireEvent.change(input, { target: { value: '我先定位热点 Key，再用互斥锁重建缓存。' } })
    expect(apiMock.submitAnswer).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(audioMock.stopAndFlush).toHaveBeenCalled()
      expect(apiMock.submitAnswer).toHaveBeenCalledWith(
        7,
        'q-1',
        '我先定位热点 Key，再用互斥锁重建缓存。',
        false,
      )
    })
  })

  it('automatically starts answering when the 15 second thinking window expires', async () => {
    const thinking = session({
      current_question: question({
        phase: 'thinking',
        prep_started_at: now() - 16,
        answer_started_at: null,
        answer_deadline_at: null,
      }),
    })
    thinking.questions = [thinking.current_question as MockInterviewQuestion]
    apiMock.listSessions.mockResolvedValue({ items: [thinking] })
    apiMock.getSession.mockResolvedValue(thinking)
    apiMock.startAnswer.mockResolvedValue(session())

    render(<MockInterview />)

    await waitFor(() => expect(apiMock.startAnswer).toHaveBeenCalledWith(7, 'q-1'))
  })

  it('auto-submits the editable draft when the answer countdown reaches zero', async () => {
    const expired = session({
      current_question: question({
        phase: 'answering',
        draft_text: '这是倒计时结束前的草稿回答。',
        answer_deadline_at: now() - 1,
      }),
    })
    expired.questions = [expired.current_question as MockInterviewQuestion]
    apiMock.listSessions.mockResolvedValue({ items: [expired] })
    apiMock.getSession.mockResolvedValue(expired)
    apiMock.submitAnswer.mockResolvedValue({
      assessment: {},
      ready_to_finish: false,
      session: session(),
    })

    render(<MockInterview />)

    await waitFor(() => {
      expect(audioMock.stopAndFlush).toHaveBeenCalled()
      expect(apiMock.submitAnswer).toHaveBeenCalledWith(
        7,
        'q-1',
        '这是倒计时结束前的草稿回答。',
        true,
      )
    })
  })

  it('shows the diagnostic report and saves the candidate self assessment', async () => {
    const completed = session({
      status: 'completed',
      current_question_id: null,
      current_question: null,
      questions: [],
      total_score: 82,
      answered_count: 10,
      main_answered_count: 10,
      report: {
        total_score: 82,
        dimensions: [
          { key: 'professional_accuracy', label: '专业准确度', score: 84, weight: 25 },
        ],
        summary_markdown: '整体表现稳定。',
        strengths: ['表达清晰'],
        risks: [],
        improvements: ['补充量化结果'],
        next_practice_plan: ['复盘一次高并发项目'],
        question_reviews: [],
        answered_count: 10,
        main_question_target: 10,
        max_follow_ups: 3,
      },
    })
    apiMock.listSessions.mockResolvedValue({ items: [completed] })
    apiMock.getSession.mockResolvedValue(completed)
    apiMock.saveSelfAssessment.mockResolvedValue({ ...completed, self_rating: 4 })

    render(<MockInterview />)

    fireEvent.click(await screen.findByText(/Java 后端开发/))
    expect(await screen.findByText('模拟面试诊断报告')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '4 星' }))
    fireEvent.change(screen.getByPlaceholderText('补充一点你这场面试的真实感受（可选）…'), {
      target: { value: '节奏合适' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存我的感受' }))
    await waitFor(() => {
      expect(apiMock.saveSelfAssessment).toHaveBeenCalledWith(7, 4, '节奏合适', [])
    })
  })
})
