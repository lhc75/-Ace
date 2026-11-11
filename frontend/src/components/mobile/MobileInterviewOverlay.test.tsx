import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileInterviewOverlay from './MobileInterviewOverlay'
import { useInterviewStore } from '@/stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

vi.mock('@/components/AnswerMarkdownContent', () => ({
  default: ({ answer }: { answer: string }) => <div>{answer}</div>,
}))

describe('MobileInterviewOverlay', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    useInterviewStore.setState({
      currentStreamingId: 'qa-live',
      qaPairs: [{
        id: 'qa-live',
        question: '请说明你最有代表性的项目。',
        answer: '第一，先交代业务目标。第二，说明关键取舍。第三，用数字收尾。',
        thinkContent: '',
        isThinking: false,
        timestamp: 1710000000,
        status: 'streaming',
      }],
    } as any)
    useUiPrefsStore.setState({
      interviewOverlayEnabled: true,
      interviewOverlayMode: 'glass',
      interviewOverlayOpacity: 0.72,
      interviewOverlayFontSize: 18,
      interviewOverlayFontColor: '#f8fafc',
      interviewOverlayFocusWidthPct: 96,
      interviewOverlayFocusHeightPct: 90,
      interviewOverlayPromptMaxWidth: 700,
      interviewOverlayMaxLines: 0,
    })
  })

  it('renders the live answer as the settings-controlled mobile overlay', () => {
    render(<MobileInterviewOverlay />)

    expect(screen.getByRole('dialog', { name: '悬浮提示窗' })).toBeInTheDocument()
    expect(screen.getByText('第一，先交代业务目标。第二，说明关键取舍。第三，用数字收尾。')).toBeInTheDocument()
  })

  it('keeps the overlay content synchronized with the desktop answer store', () => {
    render(<MobileInterviewOverlay />)

    act(() => {
      useInterviewStore.setState({
        qaPairs: [{
          id: 'qa-live',
          question: '请说明你最有代表性的项目。',
          answer: '同步后的实时答案。',
          thinkContent: '',
          isThinking: false,
          timestamp: 1710000000,
          status: 'streaming',
        }],
      } as any)
    })

    expect(screen.getByText('同步后的实时答案。')).toBeInTheDocument()
  })

  it('closes through the shared overlay preference', () => {
    render(<MobileInterviewOverlay />)

    fireEvent.click(screen.getByRole('button', { name: '关闭悬浮提示窗' }))

    expect(useUiPrefsStore.getState().interviewOverlayEnabled).toBe(false)
    expect(screen.queryByRole('dialog', { name: '悬浮提示窗' })).not.toBeInTheDocument()
  })

  it('keeps the picture-in-picture video mounted while the setting is off', () => {
    useUiPrefsStore.setState({ interviewOverlayEnabled: false })
    const { container } = render(<MobileInterviewOverlay />)

    expect(screen.queryByRole('dialog', { name: '悬浮提示窗' })).not.toBeInTheDocument()
    expect(container.querySelector('video')).toBeInTheDocument()
    expect(container.querySelector('canvas')).toBeInTheDocument()
  })

  it('forces the scan overlay visible in expanded mode without exposing a close control', () => {
    useUiPrefsStore.setState({ interviewOverlayEnabled: false })
    render(<MobileInterviewOverlay forceEnabled expanded showClose={false} />)

    const dialog = screen.getByRole('dialog', { name: '悬浮提示窗' })
    expect(dialog).toHaveStyle({ height: 'calc(100dvh - 2rem)' })
    expect(screen.queryByRole('button', { name: '关闭悬浮提示窗' })).not.toBeInTheDocument()
  })
})
