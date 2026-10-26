import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import {
  X,
  ArrowLeft,
  LayoutGrid,
  Mic,
  BrainCircuit,
  Search,
  BookOpen,
  Info,
} from 'lucide-react'
import { useUiSettings } from '@/stores/hooks'
import { useKbStore } from '@/stores/kbStore'
import { INPUT_FIELD_STYLE, SettingsSearchContext } from './shared'
import PreferencesTab from './PreferencesTab'

const SpeechTab = lazy(() => import('./SpeechTab'))
const ModelsTab = lazy(() => import('./ModelsTab'))
const KbTab = lazy(() => import('./KbTab'))
const AboutTab = lazy(() => import('./AboutTab'))

export default function SettingsDrawer() {
  const { settingsOpen, closeSettings: closeSettingsAction, settingsDrawerTab, setSettingsDrawerTab } = useUiSettings()
  const kbStatus = useKbStore((s) => s.status)

  const drawerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const previousActiveRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  const dirtyExplicitCountRef = useRef(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [noResults, setNoResults] = useState(false)
  const [dirtyExplicitSections, setDirtyExplicitSections] = useState<Record<string, boolean>>({})
  const dirtyExplicitCount = Object.values(dirtyExplicitSections).filter(Boolean).length
  const dirtyExplicitLabels = [
    dirtyExplicitSections.speech ? '语音配置' : null,
    dirtyExplicitSections.models ? '模型配置' : null,
  ].filter(Boolean)

  useEffect(() => {
    const handleDirtyChange = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; dirty?: boolean }>).detail
      if (!detail?.key) return
      setDirtyExplicitSections((prev) => ({ ...prev, [detail.key as string]: !!detail.dirty }))
    }
    window.addEventListener('settings-dirty-change', handleDirtyChange)
    return () => window.removeEventListener('settings-dirty-change', handleDirtyChange)
  }, [])

  useEffect(() => {
    dirtyExplicitCountRef.current = dirtyExplicitCount
  }, [dirtyExplicitCount])

  const closeSettings = useCallback(() => {
    if (dirtyExplicitCountRef.current > 0 && !window.confirm('有未保存更改，关闭后会丢失。')) {
      return false
    }
    closeSettingsAction()
    return true
  }, [closeSettingsAction])

  const changeTab = useCallback((tab: typeof settingsDrawerTab) => {
    if (tab === settingsDrawerTab) return
    if (dirtyExplicitCountRef.current > 0 && !window.confirm('有未保存更改，切换后会丢失。')) {
      return
    }
    setSettingsDrawerTab(tab)
  }, [setSettingsDrawerTab, settingsDrawerTab])

  // 检查搜索是否有命中 (仅 general/config tab 判断, 兼容 lazy tab 的挂载时序)
  useEffect(() => {
    if (!settingsOpen) return
    if (!searchQuery.trim() || settingsDrawerTab === 'models' || settingsDrawerTab === 'kb') {
      setNoResults(false)
      return
    }
    let cancelled = false
    const checkHits = () => {
      if (cancelled) return
      const hits = contentRef.current?.querySelectorAll('[data-search-title]')
      setNoResults(!hits || hits.length === 0)
    }
    // 多次检查覆盖 lazy load / React batch 时序
    const timers = [
      setTimeout(checkHits, 0),
      setTimeout(checkHits, 60),
      setTimeout(checkHits, 200),
    ]
    const observer = contentRef.current ? new MutationObserver(checkHits) : null
    if (contentRef.current && observer) {
      observer.observe(contentRef.current, { childList: true, subtree: true })
    }
    return () => {
      cancelled = true
      timers.forEach((t) => clearTimeout(t))
      observer?.disconnect()
    }
  }, [searchQuery, settingsDrawerTab, settingsOpen])

  useEffect(() => {
    if (!settingsOpen) {
      if (wasOpenRef.current) {
        previousActiveRef.current?.focus()
        wasOpenRef.current = false
      }
      return
    }
    if (!wasOpenRef.current) {
      previousActiveRef.current = document.activeElement as HTMLElement | null
      wasOpenRef.current = true
    }
  }, [settingsOpen])

  useEffect(() => {
    if (!settingsOpen || !drawerRef.current) return
    const root = drawerRef.current

    // 涵盖原生表单元素 + 可编辑元素 + ARIA 自定义控件 + 显式 tabindex 节点
    const FOCUSABLE_SELECTOR = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[contenteditable]:not([contenteditable="false"])',
      '[role="checkbox"]:not([aria-disabled="true"])',
      '[role="switch"]:not([aria-disabled="true"])',
      '[role="radio"]:not([aria-disabled="true"])',
      '[role="menuitem"]',
      '[role="tab"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')

    const collectFocusable = (): HTMLElement[] => {
      const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      return nodes.filter((el) => {
        if (el.hasAttribute('disabled')) return false
        if (el.getAttribute('aria-hidden') === 'true') return false
        if (el.getAttribute('tabindex') === '-1') return false
        if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) {
          return false
        }
        return true
      })
    }

    const initial = collectFocusable()
    initial[0]?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSettings()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = collectFocusable()
      if (nodes.length === 0) return
      const idx = nodes.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey) {
        if (idx <= 0) {
          e.preventDefault()
          nodes[nodes.length - 1].focus()
        }
      } else {
        if (idx === -1 || idx >= nodes.length - 1) {
          e.preventDefault()
          nodes[0].focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [settingsOpen, closeSettings])

  if (!settingsOpen) return null

  const kbNeedsDocs = !!kbStatus?.enabled && (kbStatus?.total_docs ?? 0) === 0
  const searchEnabled = settingsDrawerTab === 'general' || settingsDrawerTab === 'config'

  const tabs: { key: typeof settingsDrawerTab; label: string; icon: React.ReactNode; dot?: boolean }[] = [
    { key: 'general', label: '常用', icon: <LayoutGrid className="w-4 h-4" /> },
    { key: 'config', label: '语音', icon: <Mic className="w-4 h-4" /> },
    { key: 'models', label: '模型', icon: <BrainCircuit className="w-4 h-4" /> },
    { key: 'kb', label: '知识库', icon: <BookOpen className="w-4 h-4" />, dot: kbNeedsDocs },
    { key: 'about', label: '关于', icon: <Info className="w-4 h-4" /> },
  ]

  const activeTabLabel = tabs.find((t) => t.key === settingsDrawerTab)?.label ?? ''

  return (
    <>
      {/* Cherry 设置页: 全屏页面, 左侧菜单列 + 右侧内容列 */}
      <div ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" className="app-no-drag fixed inset-0 z-50 flex bg-bg-primary">
        {/* ── 左侧菜单列 ── */}
        <div className="flex w-[200px] md:w-[230px] flex-shrink-0 flex-col border-r-[0.5px] border-bg-hover bg-bg-tertiary/40">
          <div className="app-drag-region flex h-12 items-center gap-1 px-2.5 flex-shrink-0">
            <button
              type="button"
              onClick={closeSettings}
              className="flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-text-primary/5 hover:text-text-primary"
              aria-label="返回"
              title="返回"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h2 id="settings-title" className="text-sm font-medium text-text-primary">设置</h2>
          </div>
          <div className="px-2.5 pb-2 flex-shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchQuery) {
                    e.stopPropagation()
                    setSearchQuery('')
                  }
                }}
                placeholder={searchEnabled ? '搜索设置项' : '当前页不支持搜索'}
                aria-label="搜索设置项"
                className="w-full text-xs pl-8 pr-7 py-1.5 rounded-md bg-transparent border-[0.5px] border-bg-hover text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-blue transition"
                disabled={!searchEnabled}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-accent-red"
                  aria-label="清空搜索"
                  title="清空搜索 (Esc)"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Cherry MenuList: 32px 高 / 10px 圆角 / hover+选中灰底 */}
          <nav className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 px-2.5 pb-2.5" aria-label="设置分组">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                data-active={settingsDrawerTab === t.key}
                onClick={() => changeTab(t.key)}
                className={`relative flex h-8 items-center gap-2.5 rounded-[10px] px-2.5 text-sm transition-colors [&_svg]:size-4 ${
                  settingsDrawerTab === t.key
                    ? 'bg-text-primary/10 font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-text-primary/5 hover:text-text-primary'
                }`}
              >
                {t.icon}
                {t.label}
                {t.dot && (
                  <span
                    aria-hidden
                    className="ml-auto w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse"
                    title="知识库已开启但还没有文档"
                  />
                )}
              </button>
            ))}
          </nav>

          {dirtyExplicitLabels.length > 0 && (
            <div className="px-4 py-2.5 border-t-[0.5px] border-bg-hover flex-shrink-0">
              <p className="text-[11px] font-medium text-accent-amber">
                未保存：{dirtyExplicitLabels.join(' · ')}
              </p>
            </div>
          )}
        </div>

        {/* ── 右侧内容列 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="app-drag-region flex h-12 flex-shrink-0 items-center border-b-[0.5px] border-bg-hover px-5">
            <span className="text-sm font-medium text-text-primary">{activeTabLabel}</span>
          </div>
          <div ref={contentRef} className="flex-1 overflow-y-auto min-h-0">
            <div className="mx-auto w-full max-w-3xl p-6">
              <SettingsSearchContext.Provider value={searchEnabled ? searchQuery : ''}>
                <Suspense fallback={<div className="flex items-center justify-center py-12 text-text-muted text-sm">加载中…</div>}>
                  {settingsDrawerTab === 'general' && <PreferencesTab />}
                  {settingsDrawerTab === 'config' && <SpeechTab />}
                  {settingsDrawerTab === 'models' && <ModelsTab />}
                  {settingsDrawerTab === 'kb' && <KbTab />}
                  {settingsDrawerTab === 'about' && <AboutTab />}
                </Suspense>
                {noResults && (
                  <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                    <Search className="w-8 h-8 text-text-muted/40" />
                    <div>
                      <p className="text-sm text-text-primary font-medium">没有找到匹配 "{searchQuery}" 的设置项</p>
                      <p className="text-[11px] text-text-muted mt-1">
                        可以试试 "VAD / KB / 截图 / 主题 / 快捷词"，或切到其它分组
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-bg-tertiary text-xs text-text-primary hover:bg-bg-hover transition"
                    >
                      <X className="w-3 h-3" />
                      清空搜索
                    </button>
                  </div>
                )}
              </SettingsSearchContext.Provider>
            </div>
          </div>
        </div>
      </div>

      <style>{INPUT_FIELD_STYLE}</style>
    </>
  )
}
