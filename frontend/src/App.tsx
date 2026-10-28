import { useCallback, useEffect, useState, useRef, lazy, Suspense } from 'react'
import {
  Settings,
  SlidersHorizontal,
  MonitorSmartphone,
  PanelLeftClose,
  PanelLeftOpen,
  Minus,
  X,
  ChevronDown,
  AudioLines,
  History,
  Radar,
  NotebookPen,
  Briefcase,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useInterviewStore, type AppConfig } from '@/stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'
import { useShortcutsStore } from '@/stores/shortcutsStore'
import { useInterviewWS } from '@/hooks/useInterviewWS'
import { useAppBootstrap } from '@/hooks/useAppBootstrap'
import { useOverlayWindowSync } from '@/hooks/useOverlayWindowSync'
import { useStealthModeSync } from '@/hooks/useStealthModeSync'
import { useAssistSplit } from '@/hooks/useAssistSplit'
import { api } from '@/lib/api'
import TranscriptionPanel from '@/components/TranscriptionPanel'
import AnswerPanel from '@/components/AnswerPanel'
import ControlBar from '@/components/ControlBar'
import SettingsDrawer from '@/components/settings'
import SessionSettingsPopover from '@/components/SessionSettingsPopover'
import { AppToastStack } from '@/components/app/AppToastStack'
import { BrandMark } from '@/components/app/BrandMark'
import { InitErrorScreen } from '@/components/app/InitErrorScreen'
import { UpdateNotifier } from '@/components/app/UpdateNotifier'
const ReviewMode = lazy(() => import('@/components/ReviewMode'))
const KnowledgeMap = lazy(() => import('@/components/KnowledgeMap'))
const ResumeOptimizer = lazy(() => import('@/components/ResumeOptimizer'))
const JobTracker = lazy(() => import('@/components/JobTracker'))

const APP_MODE_TABS = [
  ['assist', '实时辅助', AudioLines],
  ['review', '面试复盘', History],
  ['knowledge', '能力分析', Radar],
  ['resume-opt', '简历优化', NotebookPen],
  ['job-tracker', '求职看板', Briefcase],
] as const

export default function App() {
  useInterviewWS()
  // 精确订阅, 避免 store 任意字段变化(LLM token 流式 / toast 等)触发 App 重渲染
  const { config, toggleSettings, openModelsDrawer } = useInterviewStore(
    useShallow((s) => ({
      config: s.config,
      toggleSettings: s.toggleSettings,
      openModelsDrawer: s.openModelsDrawer,
    })),
  )
  const sttLoaded = useInterviewStore((s) => s.sttLoaded)
  const sttLoading = useInterviewStore((s) => s.sttLoading)
  const sttActiveProvider = useInterviewStore((s) => s.sttActiveProvider)
  const sttFallbackLoaded = useInterviewStore((s) => s.sttFallbackLoaded)
  const isRecording = useInterviewStore((s) => s.isRecording)
  const isPaused = useInterviewStore((s) => s.isPaused)
  const currentStreamingId = useInterviewStore((s) => s.currentStreamingId)
  const isExamMode = config?.written_exam_mode === true
  const [mobileTab, setMobileTab] = useState<'transcript' | 'answer'>('transcript')
  const lastMobileStreamingIdRef = useRef<string | null>(null)
  const appMode = useUiPrefsStore((s) => s.appMode)
  const setAppMode = useUiPrefsStore((s) => s.setAppMode)
  const assistTranscriptCollapsed = useUiPrefsStore((s) => s.assistTranscriptCollapsed)
  const toggleAssistTranscriptCollapsed = useUiPrefsStore((s) => s.toggleAssistTranscriptCollapsed)
  useOverlayWindowSync()
  useStealthModeSync()

  const [serverScreenLoading, setServerScreenLoading] = useState(false)
  const [sessionPopoverOpen, setSessionPopoverOpen] = useState(false)
  const [moduleMenuOpen, setModuleMenuOpen] = useState(false)
  const serverScreenAskRef = useRef(false)
  const sessionAnchorRef = useRef<HTMLButtonElement | null>(null)
  const moduleMenuRef = useRef<HTMLDivElement | null>(null)

  const {
    assistSplitContainerRef,
    assistSplitDragging,
    assistSplitPct,
    assistSplitPctRef,
    persistAssistSplitPct,
  } = useAssistSplit()

  const { initError } = useAppBootstrap()

  useEffect(() => {
    if (!moduleMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!moduleMenuRef.current?.contains(event.target as Node)) {
        setModuleMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [moduleMenuOpen])

  useEffect(() => {
    setModuleMenuOpen(false)
  }, [appMode])

  // 笔试题提交后优先展示答案流，避免手机端仍停留在「答题记录」而看不到
  // 正在生成的结果。用户仍可手动切回记录页；同一题的后续 token 不会强制抢回焦点。
  useEffect(() => {
    if (!isExamMode) {
      lastMobileStreamingIdRef.current = currentStreamingId
      return
    }
    // During the very first layout pass some embedded/browser surfaces briefly
    // report width 0. Treat that as unknown rather than mobile; otherwise a
    // desktop answer panel can be mounted twice and duplicate its cards.
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0
    const isMobileViewport = viewportWidth > 0 && viewportWidth < 768
    if (
      isMobileViewport
      && currentStreamingId
      && currentStreamingId !== lastMobileStreamingIdRef.current
    ) {
      setMobileTab('answer')
    }
    lastMobileStreamingIdRef.current = currentStreamingId
  }, [currentStreamingId, isExamMode])

  useEffect(() => {
    if (!window.electronAPI?.getShortcuts) return
    window.electronAPI.getShortcuts()
      .then((shortcuts) => useShortcutsStore.getState().setShortcuts(shortcuts))
      .catch(() => {})
  }, [])

  // Desktop main-process shortcuts (think toggle / force think) push toast + config
  // updates over IPC because POST /api/config does not broadcast over WS.
  useEffect(() => {
    const unsubToast = window.electronAPI?.onDesktopToast?.((payload) => {
      const msg = typeof payload === 'string' ? payload : payload?.message
      if (!msg) return
      const level = typeof payload === 'object' && payload ? payload.level : undefined
      if (level) {
        useInterviewStore.getState().pushToast(msg, level)
      } else {
        useInterviewStore.getState().setToastMessage(msg)
      }
    })
    const unsubConfig = window.electronAPI?.onConfigUpdated?.((nextConfig) => {
      if (!nextConfig || typeof nextConfig !== 'object') return
      useInterviewStore.getState().setConfig(nextConfig as unknown as AppConfig)
    })
    return () => {
      unsubToast?.()
      unsubConfig?.()
    }
  }, [])

  const hasGuided = useRef(false)
  useEffect(() => {
    if (!config || hasGuided.current) return
    if (!config.api_key_set) {
      hasGuided.current = true
      openModelsDrawer()
    }
  }, [config, openModelsDrawer])

  // Cmd+Shift+J / Ctrl+Shift+J: 切换实时转录面板显隐
  // 注: Chrome 等浏览器把 Cmd+J / Ctrl+J 保留给「下载」, 故叠加 Shift 降低冲突.
  // 仅桌面端 assist 模式下生效; 输入框/contenteditable 内按键忽略.
  useEffect(() => {
    if (appMode !== 'assist') return
    const onKeyDown = (e: KeyboardEvent) => {
      const isToggle =
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'j' || e.key === 'J')
      if (!isToggle) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      e.preventDefault()
      toggleAssistTranscriptCollapsed()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [appMode, toggleAssistTranscriptCollapsed])

  const handleServerScreenAsk = useCallback(async () => {
    if (serverScreenAskRef.current) return
    if (useInterviewStore.getState().isPaused) {
      useInterviewStore.getState().setToastMessage('当前已暂停，请继续后再截图审题')
      return
    }
    serverScreenAskRef.current = true
    setServerScreenLoading(true)
    try {
      await api.askFromServerScreen()
      useInterviewStore.getState().setToastMessage('已按当前截图区域配置提交服务端截图审题，请在答案区查看')
    } catch (e: unknown) {
      useInterviewStore.getState().setToastMessage(e instanceof Error ? e.message : '提交失败')
    } finally {
      serverScreenAskRef.current = false
      setServerScreenLoading(false)
    }
  }, [])

  const fallbackToast = useInterviewStore((s) => s.fallbackToast)
  const toasts = useInterviewStore((s) => s.toasts)
  const dismissToast = useInterviewStore((s) => s.dismissToast)
  const wsIsLeader = useInterviewStore((s) => s.wsIsLeader)
  const currentAppMode = APP_MODE_TABS.find(([key]) => key === appMode) ?? APP_MODE_TABS[0]
  const currentAppModeLabel = currentAppMode[1]

  useEffect(() => {
    if (!fallbackToast) return
    const timer = setTimeout(() => useInterviewStore.getState().setFallbackToast(null), 4000)
    return () => clearTimeout(timer)
  }, [fallbackToast])

  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useEffect(() => {
    const timers = toastTimersRef.current
    const currentIds = new Set(toasts.map((t) => t.id))
    for (const [id, timer] of timers) {
      if (!currentIds.has(id)) { clearTimeout(timer); timers.delete(id) }
    }
    for (const t of toasts) {
      if (!timers.has(t.id)) {
        const timer = setTimeout(() => useInterviewStore.getState().dismissToast(t.id), t.ttlMs)
        timers.set(t.id, timer)
      }
    }
  }, [toasts])
  useEffect(() => () => {
    for (const timer of toastTimersRef.current.values()) clearTimeout(timer)
    toastTimersRef.current.clear()
  }, [])


/** STT 短状态标签: 侧栏与移动顶栏共用 */
function sttStatusLabel(sttLoaded: boolean, sttLoading: boolean, activeProvider: string, fallbackLoaded: boolean): string {
  if (!sttLoaded) return sttLoading ? '加载中' : '未加载'
  if (activeProvider === 'whisper') return 'Whisper'
  return fallbackLoaded ? 'STT ✓' : 'STT 就绪'
}

  // 状态指示: 录音中优先显示 REC/PAUSED, 否则显示 STT 加载状态 (标题文案两版布局共用)
  const statusTitle = isRecording
    ? isPaused
      ? isExamMode ? '笔试已暂停' : `录音已暂停 · STT ${sttLoaded ? (sttActiveProvider === 'whisper' ? 'Whisper' : '就绪') : sttLoading ? '加载中' : '未加载'}`
      : isExamMode ? '笔试进行中' : `正在录音中 · STT ${sttLoaded ? (sttActiveProvider === 'whisper' ? 'Whisper' : '就绪') : sttLoading ? '加载中' : '未加载'}`
    : isExamMode
    ? '笔试模式 · 等待提问'
    : sttLoaded
    ? sttActiveProvider === 'whisper' ? 'STT 已降级至 Whisper · 等待录音' : sttFallbackLoaded ? 'STT 就绪 · Whisper 降级已预加载' : 'STT 就绪 · 等待录音'
    : sttLoading
    ? sttActiveProvider === 'whisper' ? 'Whisper 降级加载中…' : 'STT 模型加载中…'
    : 'STT 模型尚未加载,首次录音时会自动加载'

  if (initError) {
    return <InitErrorScreen initError={initError} />
  }

  return (
    <div className="h-screen flex app-shell overflow-hidden">
      {/* ── 桌面端左侧导航栏 (Cherry 侧栏: 浅灰底 + 灰底选中) ── */}
      <aside className="app-drag-region app-sidebar hidden md:flex w-48 flex-col flex-shrink-0">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-4 side-brand">
          <BrandMark className="w-8 h-8 flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight leading-none side-brand-title">面试Ace</h1>
            <p className="mt-1 text-[9px] font-mono font-medium uppercase tracking-[0.22em] side-brand-sub">Interview Ace</p>
          </div>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-2.5 py-3 space-y-0.5" role="tablist" aria-orientation="vertical" aria-label="功能模块">
          {APP_MODE_TABS.map(([key, label, Icon]) => (
            <button
              key={key}
              role="tab"
              aria-selected={appMode === key}
              onClick={() => setAppMode(key)}
              className={`side-nav-item ${appMode === key ? 'side-nav-item--active' : ''}`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" aria-hidden />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav>

        {/* Cherry 侧栏底部: 设置入口 + 状态指示 */}
        <div className="px-2.5 pb-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={toggleSettings}
            className="side-nav-item w-full"
            aria-label="打开设置"
          >
            <Settings className="w-4 h-4 flex-shrink-0" aria-hidden />
            <span className="truncate">设置</span>
          </button>
        </div>

        {/* 状态指示 (桌面端沉底) */}
        <div className="px-3 py-3 side-status-zone">
          {isRecording ? (
            <div
              className={`side-status ${isPaused ? 'side-status--paused' : 'side-status--rec'}`}
              role="status"
              aria-live="polite"
              title={statusTitle}
            >
              <span className="relative inline-flex w-1.5 h-1.5 flex-shrink-0">
                {!isPaused && (
                  <span className="absolute inset-0 rounded-full bg-current opacity-75 motion-safe:animate-ping" aria-hidden />
                )}
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-current" aria-hidden />
              </span>
              <span className="text-[10px] font-semibold leading-none tracking-wider">
                {isPaused ? 'PAUSED' : isExamMode ? 'EXAM' : 'REC'}
              </span>
            </div>
          ) : (
            <div className="side-status side-status--idle" title={statusTitle}>
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  sttLoaded
                    ? sttActiveProvider === 'whisper' ? 'side-dot-amber' : 'side-dot-green'
                    : sttLoading ? 'side-dot-amber animate-pulse' : 'side-dot-red'
                }`}
                aria-hidden
              />
              <span className="text-[10px] font-medium tracking-wide">
                {sttStatusLabel(sttLoaded, sttLoading, sttActiveProvider, sttFallbackLoaded)}
              </span>
            </div>
          )}
        </div>
      </aside>

      {/* ── 右侧主区: Cherry AppShell 圆角内容卡片 ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 md:py-1.5 md:pr-1.5">
       <div className="app-main-card flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {/* 顶条: 移动端承载品牌/模块菜单/状态, 桌面端显示当前模块 + 全局操作 */}
        <header className="app-drag-region app-topbar flex flex-row items-center justify-between gap-2 px-3 md:px-4 h-12 flex-shrink-0 min-w-0">
          <div className="flex items-center gap-2 flex-shrink min-w-0 overflow-hidden">
            {/* 移动端: 模块菜单 (品牌标识在桌面侧边栏, 移动端宽度有限不重复展示) */}
            <div className="relative md:hidden" ref={moduleMenuRef}>
              <button
                type="button"
                onClick={() => setModuleMenuOpen((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={moduleMenuOpen}
                aria-label="切换功能模块"
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  moduleMenuOpen
                    ? 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue'
                    : 'border-bg-hover/30 bg-bg-tertiary/60 text-text-primary'
                }`}
              >
                <MonitorSmartphone className="h-3.5 w-3.5" />
                <span className="max-w-[88px] truncate">{currentAppModeLabel}</span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${moduleMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {moduleMenuOpen ? (
                <div
                  role="menu"
                  aria-label="功能模块"
                  className="absolute left-0 top-[calc(100%+0.5rem)] z-40 min-w-[180px] rounded-xl border border-bg-hover/50 bg-bg-secondary/95 p-2 shadow-2xl shadow-black/10 backdrop-blur"
                >
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">模块</div>
                  <div className="mt-1 space-y-1">
                    {APP_MODE_TABS.map(([key, label, Icon]) => (
                      <button
                        key={key}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setAppMode(key)
                          setModuleMenuOpen(false)
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          appMode === key
                            ? 'brand-tab-active'
                            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                        <span>{label}</span>
                        {appMode === key ? <span className="ml-auto text-[11px] font-semibold">当前</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {/* 移动端状态 chip */}
            <div className="md:hidden">
              {isRecording ? (
                <div
                  className={`flex items-center gap-1.5 flex-shrink-0 rounded-md px-2 py-1 border animate-fade-up ${
                    isPaused
                      ? 'bg-accent-amber/10 border-accent-amber/30'
                      : 'bg-accent-red/10 border-accent-red/30'
                  }`}
                  role="status"
                  aria-live="polite"
                  title={statusTitle}
                >
                  <span className="relative inline-flex w-1.5 h-1.5 flex-shrink-0">
                    {!isPaused && (
                      <span className="absolute inset-0 rounded-full bg-accent-red opacity-75 motion-safe:animate-ping" aria-hidden />
                    )}
                    <span
                      className={`relative inline-flex w-1.5 h-1.5 rounded-full ${isPaused ? 'bg-accent-amber' : 'bg-accent-red'}`}
                      aria-hidden
                    />
                  </span>
                  <span
                    className={`text-[10px] font-semibold leading-none hidden sm:inline ${isPaused ? 'text-accent-amber' : 'text-accent-red'}`}
                  >
                    {isPaused ? 'PAUSED' : isExamMode ? 'EXAM' : 'REC'}
                  </span>
                </div>
              ) : (
                <div
                  className="flex items-center gap-1.5 flex-shrink-0 bg-bg-tertiary/30 rounded-md px-2 py-1 border border-bg-hover/20"
                  title={statusTitle}
                >
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sttLoaded ? (sttActiveProvider === 'whisper' ? 'bg-accent-amber' : 'bg-accent-green') : sttLoading ? 'bg-accent-amber animate-pulse' : 'bg-accent-red'}`} />
                  <span className="text-[10px] text-text-muted hidden sm:inline font-medium">
                    {sttStatusLabel(sttLoaded, sttLoading, sttActiveProvider, sttFallbackLoaded)}
                  </span>
                </div>
              )}
            </div>

            {/* 桌面端: 当前模块标题 */}
            <div className="hidden md:flex items-baseline gap-2 min-w-0">
              <span className="text-sm font-bold tracking-tight text-text-primary truncate">{currentAppModeLabel}</span>
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-text-muted/70">{currentAppMode[0]}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0 flex-nowrap justify-end">
            {/* 会场设置:聚合 Think + 岗位 + 语言 + Token */}
            <div className="relative">
              <button
                ref={sessionAnchorRef}
                type="button"
                onClick={() => setSessionPopoverOpen((v) => !v)}
                title="会场设置:Think 思考模式 / 岗位 / 语言 / Token 用量"
                aria-haspopup="dialog"
                aria-expanded={sessionPopoverOpen}
                aria-label="打开会场设置"
                className={`relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs border transition-all duration-200 flex-shrink-0
                  ${sessionPopoverOpen
                    ? 'border-accent-blue/50 bg-accent-blue/10 text-accent-blue shadow-sm shadow-accent-blue/10'
                    : 'border-bg-hover/50 bg-bg-tertiary/50 text-text-secondary hover:border-accent-blue/40 hover:text-text-primary'}`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span className="font-medium hidden sm:inline">会场</span>
                {config?.think_mode && (
                  <span
                    className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-green ring-2 ring-bg-primary shadow-[0_0_6px] shadow-accent-green/60"
                    aria-hidden
                    title="Think 已开启"
                  />
                )}
              </button>
              <SessionSettingsPopover
                open={sessionPopoverOpen}
                onClose={() => setSessionPopoverOpen(false)}
                anchorRef={sessionAnchorRef}
              />
            </div>

            {appMode === 'assist' && (
              <button
                type="button"
                onClick={toggleAssistTranscriptCollapsed}
                className="hidden md:inline-flex items-center justify-center min-h-[32px] min-w-[32px] p-1.5 rounded-lg hover:bg-bg-tertiary/60 text-text-muted hover:text-accent-blue transition-all duration-200 border border-transparent hover:border-accent-blue/20 flex-shrink-0"
                title={assistTranscriptCollapsed ? '显示实时转录面板 (⌘⇧J / Ctrl+⇧+J)' : '隐藏实时转录面板 (⌘⇧J / Ctrl+⇧+J)'}
                aria-label={assistTranscriptCollapsed ? '显示实时转录面板' : '隐藏实时转录面板'}
                aria-expanded={!assistTranscriptCollapsed}
              >
                {assistTranscriptCollapsed ? (
                  <PanelLeftOpen className="w-4 h-4" />
                ) : (
                  <PanelLeftClose className="w-4 h-4" />
                )}
              </button>
            )}
            {/* 设置入口在桌面端左侧栏底部; 移动端无侧栏, 顶栏保留 */}
            <button
              type="button"
              onClick={toggleSettings}
              className="md:hidden inline-flex items-center justify-center min-h-[32px] min-w-[32px] p-1.5 rounded-lg hover:bg-bg-tertiary/60 text-text-muted hover:text-text-primary transition-all duration-200 border border-transparent hover:border-bg-hover/40"
              title="设置中心 (外观 / 偏好 / 模型 / 隐私 / 快捷键)"
              aria-label="打开设置"
            >
              <Settings className="w-4 h-4" />
            </button>
            {window.electronAPI && (
              <>
                <button
                  type="button"
                  onClick={() => window.electronAPI?.minimizeWindow()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-bg-hover/60 text-text-muted hover:text-text-primary transition-colors duration-150"
                  title="最小化"
                  aria-label="最小化窗口"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => window.electronAPI?.quitApp()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-accent-red/80 text-text-muted hover:text-white transition-colors duration-150"
                  title="退出"
                  aria-label="退出应用"
                >
                  <X className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </header>

        {/* ── Assist Mode ── */}
        {appMode === 'assist' && (
          <>
            {/* Mobile tab switcher */}
            <div className="flex md:hidden border-b border-bg-tertiary flex-shrink-0">
              <button onClick={() => setMobileTab('transcript')}
                className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${mobileTab === 'transcript' ? 'text-accent-blue border-b-2 border-accent-blue' : 'text-text-muted'}`}>
                {isExamMode ? '答题记录' : '实时转录'}
              </button>
              <button onClick={() => setMobileTab('answer')}
                className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${mobileTab === 'answer' ? 'text-accent-blue border-b-2 border-accent-blue' : 'text-text-muted'}`}>
                AI 答案
              </button>
            </div>

            <div
              ref={assistSplitContainerRef}
              className="flex-1 hidden md:flex overflow-hidden min-h-0"
            >
              {!assistTranscriptCollapsed && (
                <>
              <div
                className="flex flex-col min-w-0 flex-shrink-0 border-r border-bg-tertiary"
                style={{
                  width: `${assistSplitPct}%`,
                  minWidth: '220px',
                  maxWidth: '70%',
                }}
              >
                <TranscriptionPanel />
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="拖动调节转录区与答案区宽度"
                aria-valuemin={24}
                aria-valuemax={62}
                aria-valuenow={Math.round(assistSplitPct)}
                tabIndex={0}
                className="w-1 flex-shrink-0 cursor-col-resize group relative z-10 outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50 focus-visible:ring-inset bg-bg-hover/30 hover:bg-accent-blue/20 active:bg-accent-blue/40 transition-all duration-150"
                title="拖动调节左右宽度；双击恢复默认比例"
                onMouseDown={(e) => {
                  e.preventDefault()
                  assistSplitDragging.current = true
                  document.body.style.cursor = 'col-resize'
                  document.body.style.userSelect = 'none'
                }}
                onDoubleClick={(e) => {
                  e.preventDefault()
                  const c = 32
                  assistSplitPctRef.current = c
                  persistAssistSplitPct(c)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault()
                    const delta = e.key === 'ArrowLeft' ? -2 : 2
                    const c = Math.min(62, Math.max(24, assistSplitPctRef.current + delta))
                    assistSplitPctRef.current = c
                    persistAssistSplitPct(c)
                  }
                  if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault()
                    const c = e.key === 'Home' ? 24 : 62
                    assistSplitPctRef.current = c
                    persistAssistSplitPct(c)
                  }
                }}
              >
                <span
                  className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-bg-hover group-hover:bg-accent-blue/50 pointer-events-none"
                  aria-hidden
                />
              </div>
                </>
              )}
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <AnswerPanel />
              </div>
            </div>

            <div className="flex-1 flex md:hidden overflow-hidden min-h-0">
              {mobileTab === 'transcript' ? <TranscriptionPanel /> : <AnswerPanel />}
            </div>

            {/* Desktop and mobile: Electron captures the real primary screen before sending it to VL. */}
            {(isExamMode || mobileTab === 'answer') && (
              <div className="flex-shrink-0 px-3 py-2.5 md:px-4 border-t border-bg-tertiary bg-bg-secondary/95 backdrop-blur-sm">
                <button
                  type="button"
                  disabled={serverScreenLoading}
                  onClick={handleServerScreenAsk}
                  className="w-full md:max-w-sm md:ml-auto flex items-center justify-center gap-3 min-h-[44px] py-2.5 rounded-lg bg-accent-blue text-white text-sm font-semibold shadow-sm disabled:opacity-60 active:scale-[0.99] transition-transform"
                >
                  <MonitorSmartphone className="w-5 h-5 flex-shrink-0" />
                  {serverScreenLoading ? '截图审题提交中…' : '服务端截图审题'}
                </button>
                <p className="text-[10px] text-text-muted text-center md:text-right mt-1.5 leading-snug px-0.5">
                  桌面端会临时隐藏助手窗口后截取 Safari 当前画面；快捷键不可用时可点击这里。
                </p>
              </div>
            )}

            <ControlBar />
          </>
        )}

        {/* ── Review Mode ── */}
        {appMode === 'review' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-sm text-text-muted">加载面试复盘中…</div>}>
            <ReviewMode />
          </Suspense>
        )}

        {/* ── Knowledge Map ── */}
        {appMode === 'knowledge' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-sm text-text-muted">加载能力分析中…</div>}>
            <KnowledgeMap />
          </Suspense>
        )}

        {/* ── Resume Optimizer ── */}
        {appMode === 'resume-opt' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-sm text-text-muted">加载简历优化中…</div>}>
            <ResumeOptimizer />
          </Suspense>
        )}

        {/* ── Job tracker ── */}
        {appMode === 'job-tracker' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-sm text-text-muted">加载求职看板中…</div>}>
            <JobTracker />
          </Suspense>
        )}
       </div>
      </div>

      <AppToastStack
        wsIsLeader={wsIsLeader}
        fallbackToast={fallbackToast}
        toasts={toasts}
        dismissToast={dismissToast}
      />
      <UpdateNotifier />

      <SettingsDrawer />
    </div>
  )
}
