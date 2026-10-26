import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SessionSettingsPopover from './SessionSettingsPopover'
import { useInterviewStore } from '@/stores/configStore'

const configSyncMock = vi.hoisted(() => ({
  updateConfigAndRefresh: vi.fn(),
}))

vi.mock('@/lib/configSync', () => configSyncMock)

function renderPopover() {
  return render(
    <SessionSettingsPopover
      open
      onClose={vi.fn()}
      anchorRef={{ current: document.createElement('button') }}
    />,
  )
}

describe('SessionSettingsPopover custom language', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configSyncMock.updateConfigAndRefresh.mockResolvedValue({})
    useInterviewStore.setState({
      config: {
        language: 'Python',
        position: '后端开发',
        think_mode: false,
      },
      options: {
        languages: ['Python', 'Java', 'Go'],
        positions: ['后端开发'],
        think_efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      tokenUsage: {
        prompt: 0,
        completion: 0,
        total: 0,
        byModel: {},
      },
    } as any)
  })

  it('saves a custom language and closes the editor after success', async () => {
    renderPopover()

    fireEvent.click(screen.getByTitle('自定义语言'))
    const input = screen.getByPlaceholderText('输入自定义语言')
    fireEvent.change(input, { target: { value: '  Rust 2024  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => {
      expect(configSyncMock.updateConfigAndRefresh).toHaveBeenCalledWith({
        language: 'Rust 2024',
      })
    })
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('输入自定义语言')).not.toBeInTheDocument()
    })
  })

  it('keeps the editor open and shows the backend error when saving fails', async () => {
    configSyncMock.updateConfigAndRefresh.mockRejectedValueOnce(
      new Error('请求失败 (422): 目标语言格式不正确'),
    )
    renderPopover()

    fireEvent.click(screen.getByTitle('自定义语言'))
    const input = screen.getByPlaceholderText('输入自定义语言')
    fireEvent.change(input, { target: { value: 'Rust' } })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('目标语言格式不正确')
    expect(input).toHaveValue('Rust')
  })

  it('does not allow confirming an empty custom language', () => {
    renderPopover()

    fireEvent.click(screen.getByTitle('自定义语言'))
    fireEvent.change(screen.getByPlaceholderText('输入自定义语言'), { target: { value: '' } })

    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled()
  })

  it('updates the universal thinking effort from the session popover', async () => {
    renderPopover()

    const effortSelect = screen.getByRole('combobox', { name: '思考强度' })
    expect(effortSelect).toHaveValue('off')
    fireEvent.change(effortSelect, { target: { value: 'ultra' } })

    await waitFor(() => {
      expect(configSyncMock.updateConfigAndRefresh).toHaveBeenCalledWith({
        think_mode: true,
        think_effort: 'ultra',
      })
    })
  })
})
