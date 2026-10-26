import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SettingsDrawer from './index'
import { useInterviewStore } from '@/stores/configStore'

describe('SettingsDrawer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 120,
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 32,
    })
    HTMLElement.prototype.getClientRects = vi.fn(() => [{ width: 120, height: 32 }] as any)

    useInterviewStore.setState({
      settingsOpen: true,
      settingsDrawerTab: 'config',
      config: {
        stt_provider: 'whisper',
        whisper_model: 'base',
        whisper_language: 'auto',
        whisper_preload: false,
        doubao_stt_app_id: '',
        doubao_stt_access_token: '',
        doubao_stt_api_key: '',
        doubao_stt_resource_id: '',
        doubao_stt_boosting_table_id: '',
        generic_stt_api_base_url: '',
        generic_stt_api_key: '',
        generic_stt_model: '',
        generic_stt_custom_headers: '',
        candidate_asr_enabled: false,
        candidate_stt_provider: 'whisper',
        candidate_whisper_model: '',
        candidate_whisper_language: '',
        candidate_remote_stt_enabled: false,
        candidate_context_enabled: true,
        candidate_context_wait_ms: 200,
        candidate_context_max_chars: 900,
        candidate_context_min_chars: 6,
        candidate_streaming_asr_enabled: true,
        candidate_streaming_asr_interval_ms: 1500,
        candidate_mic_compatibility_mode: true,
        silence_threshold: 0.01,
        silence_duration: 1.2,
        transcription_min_sig_chars: 2,
        assist_transcription_merge_gap_sec: 2,
        assist_transcription_merge_max_sec: 12,
        assist_high_churn_short_answer: false,
        auto_detect: true,
      },
      options: {
        stt_providers: ['whisper', 'doubao', 'generic'],
        whisper_models: ['tiny', 'base'],
      },
    } as any)
  })

  it('closes clean settings explicitly and restores opener focus', async () => {
    const outsideButton = document.createElement('button')
    outsideButton.textContent = 'outside'
    document.body.appendChild(outsideButton)
    outsideButton.focus()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<SettingsDrawer />)

    expect(screen.getByRole('dialog')).toHaveClass('app-no-drag')
    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(useInterviewStore.getState().settingsOpen).toBe(false)
      expect(document.activeElement).toBe(outsideButton)
    })
    expect(confirmSpy).not.toHaveBeenCalled()

    useInterviewStore.getState().closeSettings()
    expect(useInterviewStore.getState().settingsOpen).toBe(false)
    outsideButton.remove()
  })

  it('closes clean settings with Escape', async () => {
    render(<SettingsDrawer />)

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(useInterviewStore.getState().settingsOpen).toBe(false)
    })
  })

  it('clears search with the first Escape without closing settings', () => {
    useInterviewStore.setState({ settingsDrawerTab: 'general' })
    render(<SettingsDrawer />)
    const search = screen.getByRole('searchbox', { name: '搜索设置项' })

    fireEvent.change(search, { target: { value: '主题' } })
    fireEvent.keyDown(search, { key: 'Escape' })

    expect(search).toHaveValue('')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(useInterviewStore.getState().settingsOpen).toBe(true)
  })

  it('keeps the draft open when dirty close is cancelled by return or Escape', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SettingsDrawer />)

    const modelSelect = await screen.findByDisplayValue('base')
    fireEvent.change(modelSelect, { target: { value: 'tiny' } })
    await screen.findByText('未保存：语音配置')

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(confirmSpy).toHaveBeenCalledWith('有未保存更改，关闭后会丢失。')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(modelSelect).toHaveValue('tiny')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(useInterviewStore.getState().settingsOpen).toBe(true)
    expect(modelSelect).toHaveValue('tiny')
  })

  it('keeps focus on the active field when dirty state changes', async () => {
    const outsideButton = document.createElement('button')
    outsideButton.textContent = 'outside'
    document.body.appendChild(outsideButton)
    outsideButton.focus()

    render(<SettingsDrawer />)

    const modelSelect = await screen.findByDisplayValue('base')
    modelSelect.focus()
    fireEvent.change(modelSelect, { target: { value: 'tiny' } })

    await waitFor(() => {
      expect(screen.getAllByText('有未保存更改').length).toBeGreaterThan(0)
    })
    expect(document.activeElement).not.toBe(outsideButton)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)

    outsideButton.remove()
  })

  it('restores focus to the opener after dirty state changes and close is confirmed', async () => {
    const outsideButton = document.createElement('button')
    outsideButton.textContent = 'outside'
    document.body.appendChild(outsideButton)
    outsideButton.focus()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<SettingsDrawer />)

    const modelSelect = await screen.findByDisplayValue('base')
    fireEvent.change(modelSelect, { target: { value: 'tiny' } })
    await waitFor(() => {
      expect(screen.getAllByText('有未保存更改').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(useInterviewStore.getState().settingsOpen).toBe(false)
      expect(document.activeElement).toBe(outsideButton)
    })
    outsideButton.remove()
  })

  it('asks before switching tabs with unsaved explicit settings', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SettingsDrawer />)

    const modelSelect = await screen.findByDisplayValue('base')
    fireEvent.change(modelSelect, { target: { value: 'tiny' } })
    await waitFor(() => {
      expect(screen.getAllByText('有未保存更改').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByRole('button', { name: /模型/ }))

    expect(confirmSpy).toHaveBeenCalledWith('有未保存更改，切换后会丢失。')
    expect(screen.getByText('语音链路')).toBeInTheDocument()
  })

  it('shows explicit unsaved sections in the drawer header', async () => {
    render(<SettingsDrawer />)

    const modelSelect = await screen.findByDisplayValue('base')
    fireEvent.change(modelSelect, { target: { value: 'tiny' } })

    expect(await screen.findByText('未保存：语音配置')).toBeInTheDocument()
  })

  it('keeps header bars draggable so the window can move while settings is open', () => {
    render(<SettingsDrawer />)

    const dialog = screen.getByRole('dialog')
    // 全屏设置页盖住主窗口的拖区域, 左右两条顶栏必须自己提供 drag region
    expect(screen.getByRole('heading', { name: '设置' }).closest('.app-drag-region')).not.toBeNull()
    expect(dialog.querySelector('.flex-1 > .app-drag-region')).not.toBeNull()
    // 返回按钮在 drag region 内仍保持 no-drag (index.css 后代规则), 可正常点击
    expect(screen.getByRole('button', { name: '返回' }).closest('.app-drag-region')).not.toBeNull()
  })
})
