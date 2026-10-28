import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStealthModeSync } from './useStealthModeSync'
import { useInterviewStore } from '@/stores/configStore'

const noopAsync = () => Promise.resolve({ ok: true })

function Harness() {
  useStealthModeSync()
  return null
}

function setStoreState(isRecording: boolean, writtenExamMode: boolean) {
  useInterviewStore.setState({
    isRecording,
    config: { written_exam_mode: writtenExamMode } as never,
  })
}

beforeEach(() => {
  setStoreState(false, false)
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe('useStealthModeSync', () => {
  it('activates stealth only while recording in written-exam mode', () => {
    const syncStealthMode = vi.fn(noopAsync)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { syncStealthMode }

    const { rerender } = render(<Harness />)
    expect(syncStealthMode).toHaveBeenLastCalledWith({ active: false })

    // 只开笔试模式、未开始录制：不隐身
    setStoreState(false, true)
    rerender(<Harness />)
    expect(syncStealthMode).toHaveBeenLastCalledWith({ active: false })

    // 开始笔试（笔试模式 + 录制中）：进入隐身
    setStoreState(true, true)
    rerender(<Harness />)
    expect(syncStealthMode).toHaveBeenLastCalledWith({ active: true })

    // 结束笔试：恢复
    setStoreState(false, true)
    rerender(<Harness />)
    expect(syncStealthMode).toHaveBeenLastCalledWith({ active: false })
  })

  it('stays inactive for plain interview recording (non-exam)', () => {
    const syncStealthMode = vi.fn(noopAsync)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { syncStealthMode }

    const { rerender } = render(<Harness />)
    setStoreState(true, false)
    rerender(<Harness />)
    expect(syncStealthMode).toHaveBeenLastCalledWith({ active: false })
  })

  it('is a no-op without electronAPI (browser mode)', () => {
    expect(() => render(<Harness />)).not.toThrow()
  })
})
