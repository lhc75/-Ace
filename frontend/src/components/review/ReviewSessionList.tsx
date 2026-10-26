import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ComponentType } from 'react'
import dayjs from 'dayjs'
import {
  AlertCircle,
  CheckCircle,
  Clock,
  XCircle,
  Settings,
  Sparkles,
  RotateCw,
  Loader2,
  Upload,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { api, getErrorMessage } from '../../lib/api'
import { useInterviewStore } from '../../stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'
import { StageBadge } from '@/components/job-tracker/stageConfig'
import { isLightColorScheme } from '@/lib/colorScheme'
import type { ReviewSession, ReviewSessionsResponse } from './types'
import { parseReviewSessionsResponse } from './types'
import { getReviewSourceMeta, isWrittenExamReview } from './sourceMeta'

const STATUS_LABELS: Record<ReviewSession['status'], string> = {
  recording: '录制中',
  recorded: '待生成',
  analyzing: '分析中',
  completed: '已完成',
  partial_capture: '部分录制',
  analysis_failed: '分析失败',
}

const STATUS_ICONS: Record<ReviewSession['status'], ComponentType<{ className?: string }>> = {
  recording: Clock,
  recorded: Sparkles,
  analyzing: Loader2,
  completed: CheckCircle,
  partial_capture: AlertCircle,
  analysis_failed: XCircle,
}

const STATUS_COLORS: Record<ReviewSession['status'], string> = {
  recording: 'text-blue-500',
  recorded: 'text-amber-500',
  analyzing: 'text-blue-500',
  completed: 'text-green-500',
  partial_capture: 'text-yellow-500',
  analysis_failed: 'text-red-500',
}

const FIELD_CLASS = 'w-full rounded-lg border border-bg-hover bg-bg-tertiary px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none transition focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/10 disabled:cursor-not-allowed disabled:opacity-50'
const REVIEW_LIST_POLL_MS = 7000
const PAGE_SIZE = 20

type AsrSelfTestResult = {
  ok: boolean
  model_name: string
  model: string
  original: string
  corrected: string
  changed: boolean
  detail?: string
}

type ReviewListFocus = 'all' | 'attention' | 'active' | 'done'

type SessionGroup = {
  key: Exclude<ReviewListFocus, 'all'>
  title: string
  items: ReviewSession[]
}

type SessionCluster = {
  key: string
  application: ReviewSession['application'] | null
  items: ReviewSession[]
}

function sessionHasGeneratedAnalysis(session: ReviewSession) {
  return Boolean(session.summary_markdown) || session.avg_score != null
}

interface Props {
  onViewDetail: (sessionId: number) => void
}

export default function ReviewSessionList({ onViewDetail }: Props) {
  const latestLoadIdRef = useRef(0)
  const reviewConfigSaveSeqRef = useRef(0)
  const triggeringIdsRef = useRef<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ReviewSessionsResponse | null>(null)
  const [page, setPage] = useState(1)
  const [showSettings, setShowSettings] = useState(false)
  const [showManualImport, setShowManualImport] = useState(false)
  const [triggeringIds, setTriggeringIds] = useState<Set<number>>(new Set())
  const [clearingAll, setClearingAll] = useState(false)
  const [focusFilter, setFocusFilter] = useState<ReviewListFocus>('all')
  const [pendingReviewEnabled, setPendingReviewEnabled] = useState<boolean | null>(null)
  const [pendingReviewModelIndex, setPendingReviewModelIndex] = useState<number | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())

  const config = useInterviewStore((s) => s.config)
  const setConfig = useInterviewStore((s) => s.setConfig)
  const setToastMessage = useInterviewStore((s) => s.setToastMessage)
  const colorScheme = useUiPrefsStore((s) => s.colorScheme)
  const setAppMode = useUiPrefsStore((s) => s.setAppMode)
  const setJobTrackerDeepLink = useUiPrefsStore((s) => s.setJobTrackerDeepLink)
  const isLight = isLightColorScheme(colorScheme)

  const reviewEnabled = config?.review_enabled ?? false
  const reviewModelIndex = config?.review_model_index ?? 0
  const models = config?.models ?? []
  const displayedReviewEnabled = pendingReviewEnabled ?? reviewEnabled
  const displayedReviewModelIndex = pendingReviewModelIndex ?? reviewModelIndex

  const loadSessions = useCallback(async (p: number, options?: { silent?: boolean }) => {
    const loadId = latestLoadIdRef.current + 1
    latestLoadIdRef.current = loadId
    let redirectedToValidPage = false
    if (!options?.silent) setLoading(true)
    try {
      const resp = await api.reviewSessions(p, PAGE_SIZE)
      if (loadId !== latestLoadIdRef.current) return
      const parsed = parseReviewSessionsResponse(resp)
      const lastPage = Math.max(1, Math.ceil(parsed.total / PAGE_SIZE))
      if (p > lastPage) {
        redirectedToValidPage = true
        setPage(lastPage)
        return
      }
      setData(parsed)
    } catch (err) {
      if (loadId === latestLoadIdRef.current && !options?.silent) {
        setToastMessage(getErrorMessage(err, '加载复盘列表失败'))
      }
    } finally {
      if (loadId === latestLoadIdRef.current && !options?.silent && !redirectedToValidPage) {
        setLoading(false)
      }
    }
  }, [setToastMessage])

  useEffect(() => {
    loadSessions(page)
  }, [page, loadSessions])

  const toggleManualImport = useCallback(() => {
    setShowManualImport((prev) => {
      const next = !prev
      if (next) setShowSettings(false)
      return next
    })
  }, [])

  const toggleSettings = useCallback(() => {
    setShowSettings((prev) => {
      const next = !prev
      if (next) setShowManualImport(false)
      return next
    })
  }, [])

  const handleToggleReview = async (enabled: boolean) => {
    const saveSeq = reviewConfigSaveSeqRef.current + 1
    reviewConfigSaveSeqRef.current = saveSeq
    setPendingReviewEnabled(enabled)
    try {
      const updated = await api.updateConfig({ review_enabled: enabled })
      if (saveSeq !== reviewConfigSaveSeqRef.current) return
      setConfig(updated)
      setToastMessage(enabled ? '已开启自动生成复盘' : '已关闭自动生成复盘')
    } catch (err) {
      if (saveSeq === reviewConfigSaveSeqRef.current) {
        setToastMessage(getErrorMessage(err, '开关切换失败'))
      }
    } finally {
      if (saveSeq === reviewConfigSaveSeqRef.current) {
        setPendingReviewEnabled(null)
      }
    }
  }

  const handleChangeModel = async (modelIndex: number) => {
    const saveSeq = reviewConfigSaveSeqRef.current + 1
    reviewConfigSaveSeqRef.current = saveSeq
    setPendingReviewModelIndex(modelIndex)
    try {
      const updated = await api.updateConfig({ review_model_index: modelIndex })
      if (saveSeq !== reviewConfigSaveSeqRef.current) return
      setConfig(updated)
      const modelName = updated.models?.[modelIndex]?.name ?? models[modelIndex]?.name ?? '当前模型'
      setToastMessage(`已切换复盘模型为 ${modelName}`)
    } catch (err) {
      if (saveSeq === reviewConfigSaveSeqRef.current) {
        setToastMessage(getErrorMessage(err, '模型切换失败'))
      }
    } finally {
      if (saveSeq === reviewConfigSaveSeqRef.current) {
        setPendingReviewModelIndex(null)
      }
    }
  }

  const handleTriggerAnalysis = async (sessionId: number) => {
    if (triggeringIdsRef.current.has(sessionId)) return
    triggeringIdsRef.current.add(sessionId)
    setTriggeringIds(prev => new Set(prev).add(sessionId))
    try {
      const result = await api.reviewTriggerAnalysis(sessionId)
      if (result.status === 'started' || result.status === 'pending') {
        setData(prev => {
          if (!prev) return prev
          return {
            ...prev,
            items: prev.items.map(s =>
              s.id === sessionId ? { ...s, status: 'analyzing' as const } : s
            ),
          }
        })
        setToastMessage('已加入复盘生成队列')
      } else if (result.status === 'done') {
        setToastMessage('复盘已完成')
        void loadSessions(page, { silent: true })
      }
    } catch (err) {
      setToastMessage(getErrorMessage(err, '触发分析失败'))
    } finally {
      triggeringIdsRef.current.delete(sessionId)
      setTriggeringIds(prev => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }

  const handleDeleteSession = async (session: ReviewSession) => {
    if (deletingIds.has(session.id)) return
    const title = session.title || session.company || '这场复盘'
    if (!window.confirm(`确定删除“${title}”吗？删除后不可恢复。`)) return
    setDeletingIds((prev) => new Set(prev).add(session.id))
    try {
      await api.reviewDeleteSession(session.id)
      setToastMessage('复盘已删除')
      await loadSessions(page)
    } catch (err) {
      setToastMessage(getErrorMessage(err, '删除复盘失败'))
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(session.id)
        return next
      })
    }
  }

  const handleDeleteAllSessions = async () => {
    const totalCount = data?.total ?? 0
    if (clearingAll || totalCount === 0) return
    if (!window.confirm(`确定删除全部 ${totalCount} 场复盘吗？删除后不可恢复。`)) return
    setClearingAll(true)
    try {
      const result = await api.reviewDeleteAllSessions()
      setToastMessage(`已清空 ${result.deleted} 场复盘`)
      setPage(1)
      await loadSessions(1)
    } catch (err) {
      setToastMessage(getErrorMessage(err, '清空复盘失败'))
    } finally {
      setClearingAll(false)
    }
  }

  const handleOpenApplication = useCallback((session: ReviewSession) => {
    if (!session.application?.id) return
    setJobTrackerDeepLink({
      applicationId: session.application.id,
      openReviews: true,
      highlightReviewId: session.id,
    })
    setAppMode('job-tracker')
  }, [setAppMode, setJobTrackerDeepLink])

  const sessions = data?.items ?? []
  const hasAnalyzingSession = sessions.some((session) => session.status === 'analyzing')
  const total = data?.total ?? 0
  const groups = useMemo(() => buildSessionGroups(sessions), [sessions])
  const hasSessions = total > 0
  const linkedReviewCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const session of sessions) {
      const applicationId = session.application?.id
      if (applicationId == null) continue
      counts.set(applicationId, (counts.get(applicationId) ?? 0) + 1)
    }
    return counts
  }, [sessions])
  const linkedTimelineLabels = useMemo(() => {
    const grouped = new Map<number, ReviewSession[]>()
    for (const session of sessions) {
      const applicationId = session.application?.id
      if (applicationId == null) continue
      const current = grouped.get(applicationId) ?? []
      current.push(session)
      grouped.set(applicationId, current)
    }
    const labels = new Map<number, string>()
    for (const appSessions of grouped.values()) {
      appSessions.forEach((session, index) => {
        labels.set(session.id, describeTimelinePosition(index, appSessions.length))
      })
    }
    return labels
  }, [sessions])
  const focusOptions = [
    { key: 'all' as ReviewListFocus, label: '全部', count: sessions.length },
    {
      key: 'attention' as ReviewListFocus,
      label: '先处理',
      count: groups.find((group) => group.key === 'attention')?.items.length ?? 0,
    },
    {
      key: 'active' as ReviewListFocus,
      label: '进行中',
      count: groups.find((group) => group.key === 'active')?.items.length ?? 0,
    },
    {
      key: 'done' as ReviewListFocus,
      label: '已完成',
      count: groups.find((group) => group.key === 'done')?.items.length ?? 0,
    },
  ].filter((item) => item.key === 'all' || item.count > 0 || item.key === focusFilter)
  const currentFocusOption = focusOptions.find((item) => item.key === focusFilter) ?? focusOptions[0]
  const configPanels = (showManualImport || showSettings) ? (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
      {showManualImport && (
        <ManualImportPanel
          onCreated={(sessionId) => {
            setShowManualImport(false)
            void loadSessions(1)
            setPage(1)
            onViewDetail(sessionId)
          }}
          onToast={setToastMessage}
        />
      )}
      {showSettings && (
        <ReviewSettingsPanel
          reviewEnabled={displayedReviewEnabled}
          reviewModelIndex={displayedReviewModelIndex}
          reviewToggleSaving={pendingReviewEnabled != null}
          models={models}
          onToggle={handleToggleReview}
          onChangeModel={handleChangeModel}
        />
      )}
    </section>
  ) : null
  const reviewWorkspaceShellClass = isLight
    ? 'border-bg-hover bg-white'
    : 'border-white/[0.08] bg-bg-secondary/42'

  useEffect(() => {
    if (!hasAnalyzingSession) return undefined

    const timer = window.setInterval(() => {
      void loadSessions(page, { silent: true })
    }, REVIEW_LIST_POLL_MS)
    return () => window.clearInterval(timer)
  }, [hasAnalyzingSession, loadSessions, page])

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-muted text-sm">加载中...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 p-5 lg:p-6">
        <header className="deck-header -mx-5 -mt-5 lg:-mx-6 lg:-mt-6 mb-1">
          <span className="deck-header-tag">R-01 · REVIEW LOG</span>
          <h2 className="deck-header-title">面试复盘</h2>
          {!reviewEnabled ? (
            <span className="text-[10px] sd-num uppercase tracking-wider text-text-muted">自动生成未启用</span>
          ) : null}
          <div className="deck-header-aside">
            <button
              type="button"
              onClick={() => void loadSessions(page)}
              aria-label="刷新复盘列表"
              title="刷新"
              className="sd-btn !min-h-[30px] !px-2.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {hasSessions && (
              <button
                type="button"
                onClick={() => void handleDeleteAllSessions()}
                disabled={clearingAll}
                aria-label="一键删除全部复盘"
                title="一键删除全部复盘"
                className="sd-btn !min-h-[30px] !px-2.5 !text-[11px] !text-red-500 hover:!bg-red-500/10 disabled:opacity-50"
              >
                {clearingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                清空
              </button>
            )}
            <button
              type="button"
              onClick={toggleManualImport}
              aria-expanded={showManualImport}
              className={`sd-btn !min-h-[30px] !text-[11px] ${showManualImport ? '!bg-text-primary !text-bg-primary' : ''}`}
            >
              <Upload className="h-3.5 w-3.5" />
              {showManualImport ? '收起导入' : '手动复盘'}
            </button>
            <button
              type="button"
              onClick={toggleSettings}
              aria-expanded={showSettings}
              className={`sd-btn !min-h-[30px] !text-[11px] ${showSettings ? '!bg-text-primary !text-bg-primary' : ''}`}
            >
              <Settings className="h-3.5 w-3.5" />
              {showSettings ? '收起配置' : '配置'}
            </button>
          </div>
        </header>

        {hasSessions ? (
          <div className={`rounded-lg border ${reviewWorkspaceShellClass}`}>
            <div className="min-w-0 space-y-3 p-3 lg:p-4">
              <section className="border-b border-bg-hover/80 px-1 pb-3">
                <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <h3 className="text-sm font-semibold text-text-primary">复盘队列</h3>
                      <span className="text-[11px] text-text-muted">
                        {currentFocusOption.label} · {total} 场
                      </span>
                    </div>
                  </div>
                  <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:max-w-[420px] lg:justify-end lg:overflow-visible lg:px-0 lg:pb-0">
                    {focusOptions.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => setFocusFilter(item.key)}
                        className={`inline-flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          focusFilter === item.key
                            ? 'border-bg-hover bg-transparent text-accent-blue'
                            : 'border-bg-hover bg-bg-secondary/50 text-text-secondary hover:bg-bg-hover'
                        }`}
                      >
                        <span>{item.label}</span>
                        <span className={`text-[10px] ${focusFilter === item.key ? 'text-accent-blue' : 'text-text-muted'}`}>
                          {item.count}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {configPanels}

              <SessionTable
                sessions={sessions}
                focusFilter={focusFilter}
                linkedReviewCounts={linkedReviewCounts}
                linkedTimelineLabels={linkedTimelineLabels}
                triggeringIds={triggeringIds}
                onViewDetail={onViewDetail}
                onOpenApplication={handleOpenApplication}
                onTriggerAnalysis={handleTriggerAnalysis}
                deletingIds={deletingIds}
                onDeleteSession={handleDeleteSession}
              />

              {total > PAGE_SIZE && (
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                    className="h-9 rounded-lg border border-bg-hover bg-bg-secondary px-4 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50 hover:bg-bg-hover"
                  >
                    上一页
                  </button>
                  <span className="text-sm text-text-muted">
                    {page} / {Math.ceil(total / PAGE_SIZE)}
                  </span>
                  <button
                    type="button"
                    disabled={page >= Math.ceil(total / PAGE_SIZE)}
                    onClick={() => setPage(page + 1)}
                    className="h-9 rounded-lg border border-bg-hover bg-bg-secondary px-4 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50 hover:bg-bg-hover"
                  >
                    下一页
                  </button>
                </div>
                )}
            </div>
          </div>
        ) : (
          <ReviewZeroState
            reviewEnabled={reviewEnabled}
            showManualImport={showManualImport}
            showSettings={showSettings}
            onManual={toggleManualImport}
            onSettings={toggleSettings}
          />
        )}
        {!hasSessions ? configPanels : null}

      </div>
    </div>
  )
}

function ReviewZeroState({
  reviewEnabled,
  showManualImport,
  showSettings,
  onManual,
  onSettings,
}: {
  reviewEnabled: boolean
  showManualImport: boolean
  showSettings: boolean
  onManual: () => void
  onSettings: () => void
}) {
  return (
    <section className="border-l border-bg-hover/80 py-2 pl-3">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">暂无复盘记录</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span>自动生成 {reviewEnabled ? '已启用' : '未启用'}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onManual}
            aria-expanded={showManualImport}
            className={`sd-btn !min-h-[36px] ${showManualImport ? '' : 'sd-btn--primary'}`}
          >
            <Upload className="h-4 w-4" />
            {showManualImport ? '收起导入' : '手动复盘'}
          </button>
          <button
            type="button"
            onClick={onSettings}
            aria-expanded={showSettings}
            className={`sd-btn !min-h-[36px] ${showSettings ? '!bg-text-primary !text-bg-primary' : ''}`}
          >
            <Settings className="h-4 w-4" />
            {showSettings ? '收起配置' : '配置'}
          </button>
        </div>
      </div>
    </section>
  )
}

function ManualImportPanel({
  onCreated,
  onToast,
}: {
  onCreated: (sessionId: number) => void
  onToast: (message: string | null) => void
}) {
  const [form, setForm] = useState({
    title: '',
    company: '',
    role: '',
    transcript: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  const canSubmit = form.transcript.trim().length >= 12

  const handleSubmit = async () => {
    if (!canSubmit) return
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const result = await api.reviewCreateManual({
        title: form.title || undefined,
        company: form.company || undefined,
        role: form.role || undefined,
        transcript: form.transcript,
        analyze: true,
      })
      onToast('已创建手动复盘，并开始分析')
      onCreated(result.session_id)
    } catch (err) {
      onToast(getErrorMessage(err, '创建手动复盘失败'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="deck-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">手动复盘导入</h3>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <input
          value={form.title}
          onChange={(event) => setForm({ ...form, title: event.target.value })}
          placeholder="标题"
          className={FIELD_CLASS}
        />
        <input
          value={form.company}
          onChange={(event) => setForm({ ...form, company: event.target.value })}
          placeholder="公司"
          className={FIELD_CLASS}
        />
        <input
          value={form.role}
          onChange={(event) => setForm({ ...form, role: event.target.value })}
          placeholder="岗位"
          className={FIELD_CLASS}
        />
      </div>
      <textarea
        value={form.transcript}
        onChange={(event) => setForm({ ...form, transcript: event.target.value })}
        rows={8}
        placeholder={'面试官: 请介绍一下 Redis 缓存穿透。\n候选人: 我会用布隆过滤器和空值缓存...\nQ2: 讲讲索引失效场景。\nA2: ...'}
        className={`${FIELD_CLASS} mt-3 min-h-[180px] resize-y font-mono leading-relaxed`}
      />
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent-blue px-4 text-xs font-medium text-white hover:bg-accent-blue/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {submitting ? '创建中' : '创建并分析'}
        </button>
      </div>
    </div>
  )
}

function ReviewSettingsPanel({
  reviewEnabled,
  reviewModelIndex,
  reviewToggleSaving,
  models,
  onToggle,
  onChangeModel,
}: {
  reviewEnabled: boolean
  reviewModelIndex: number
  reviewToggleSaving: boolean
  models: { name: string; enabled?: boolean }[]
  onToggle: (enabled: boolean) => void
  onChangeModel: (modelIndex: number) => void
}) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AsrSelfTestResult | null>(null)

  const handleSelfTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.reviewAsrCorrectionTest()
      setTestResult(result)
    } catch (err) {
      setTestResult({
        ok: false,
        model_name: models[reviewModelIndex]?.name ?? '复盘模型',
        model: '',
        original: '',
        corrected: '',
        changed: false,
        detail: getErrorMessage(err, '自检失败'),
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="deck-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-primary">复盘配置</h3>
          <div className="mt-0.5 text-[11px] text-text-muted">
            {reviewEnabled ? '结束后自动生成分析' : '只保存记录，手动生成分析'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onToggle(!reviewEnabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            reviewEnabled ? 'bg-green-500' : 'bg-bg-hover'
          }`}
          role="switch"
          aria-checked={reviewEnabled}
          aria-busy={reviewToggleSaving}
        >
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-sm transition-transform ${
              reviewEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          >
            {reviewToggleSaving ? <Loader2 className="h-3 w-3 animate-spin text-text-muted" /> : null}
          </span>
        </button>
      </div>
      <label className="mb-2 block text-xs font-medium text-text-secondary">
        复盘分析模型
      </label>
      <select
        value={reviewModelIndex}
        onChange={(event) => onChangeModel(Number(event.target.value))}
        disabled={!reviewEnabled}
        className={FIELD_CLASS}
      >
        {models.map((model, idx) => (
          <option key={idx} value={idx} disabled={!model.enabled}>
            {model.name} {!model.enabled ? '(未启用)' : ''}
          </option>
        ))}
      </select>
      <div className="mt-3 border-t border-bg-hover/80 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text-primary">ASR 纠错自检</div>
          </div>
          <button
            type="button"
            onClick={handleSelfTest}
            disabled={testing}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-bg-hover bg-transparent px-3 text-[11px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {testing ? '检测中' : '检测'}
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 rounded-lg border p-3 ${
            testResult.ok
              ? 'border-green-500/20 bg-green-500/10'
              : 'border-red-500/20 bg-red-500/10'
          }`}>
            <div className="flex items-center gap-2">
              {testResult.ok ? (
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 text-red-500" />
              )}
              <span className={`text-xs font-medium ${testResult.ok ? 'text-green-500' : 'text-red-500'}`}>
                {testResult.ok ? (testResult.changed ? '纠错可用，样例已修正' : '模型可用，样例未变化') : '纠错不可用'}
              </span>
            </div>
            <div className="mt-2 text-[11px] text-text-muted">
              {testResult.model_name}{testResult.model ? ` / ${testResult.model}` : ''}
            </div>
            {testResult.detail && (
              <div className="mt-1 break-words text-[11px] leading-relaxed text-text-secondary">{testResult.detail}</div>
            )}
            {testResult.ok && (
              <div className="mt-3 grid gap-2">
                <div className="rounded-md bg-bg-primary/40 p-2">
                  <div className="mb-1 text-[10px] font-medium text-text-muted">原始样例</div>
                  <div className="text-[11px] leading-relaxed text-text-secondary">{testResult.original}</div>
                </div>
                <div className="rounded-md bg-bg-primary/40 p-2">
                  <div className="mb-1 text-[10px] font-medium text-text-muted">纠错结果</div>
                  <div className="text-[11px] leading-relaxed text-text-primary">{testResult.corrected}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SessionTable({
  sessions,
  focusFilter,
  linkedReviewCounts,
  linkedTimelineLabels,
  triggeringIds,
  onViewDetail,
  onOpenApplication,
  onTriggerAnalysis,
  deletingIds,
  onDeleteSession,
}: {
  sessions: ReviewSession[]
  focusFilter: ReviewListFocus
  linkedReviewCounts: Map<number, number>
  linkedTimelineLabels: Map<number, string>
  triggeringIds: Set<number>
  onViewDetail: (sessionId: number) => void
  onOpenApplication: (session: ReviewSession) => void
  onTriggerAnalysis: (sessionId: number) => void
  deletingIds: Set<number>
  onDeleteSession: (session: ReviewSession) => void
}) {
  const groups = buildSessionGroups(sessions)
  const visibleGroups = groups.filter((group) => focusFilter === 'all' || group.key === focusFilter)

  if (visibleGroups.length === 0) {
    return (
      <div className="px-1 py-6 text-sm text-text-muted">
        没有复盘记录
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {visibleGroups.map((group) => (
        <section key={group.key} className="space-y-2">
          <div className="flex items-start justify-between gap-3 px-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-text-primary">{group.title}</h3>
              <span className="text-[11px] text-text-muted">{group.items.length} 场</span>
            </div>
          </div>
          <div className="divide-y divide-bg-hover/70 border-y border-bg-hover/70">
            {buildSessionClusters(group.items).map((cluster) => (
              <ReviewTimelineCluster
                key={cluster.key}
                cluster={cluster}
                linkedReviewCounts={linkedReviewCounts}
                linkedTimelineLabels={linkedTimelineLabels}
                triggeringIds={triggeringIds}
                onViewDetail={onViewDetail}
                onOpenApplication={onOpenApplication}
                onTriggerAnalysis={onTriggerAnalysis}
                deletingIds={deletingIds}
                onDeleteSession={onDeleteSession}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function ReviewTimelineCluster({
  cluster,
  linkedReviewCounts,
  linkedTimelineLabels,
  triggeringIds,
  onViewDetail,
  onOpenApplication,
  onTriggerAnalysis,
  deletingIds,
  onDeleteSession,
}: {
  cluster: SessionCluster
  linkedReviewCounts: Map<number, number>
  linkedTimelineLabels: Map<number, string>
  triggeringIds: Set<number>
  onViewDetail: (sessionId: number) => void
  onOpenApplication: (session: ReviewSession) => void
  onTriggerAnalysis: (sessionId: number) => void
  deletingIds: Set<number>
  onDeleteSession: (session: ReviewSession) => void
}) {
  const timelineCount = cluster.application?.id != null ? linkedReviewCounts.get(cluster.application.id) ?? cluster.items.length : cluster.items.length
  const showTimelineHeader = Boolean(cluster.application?.id) && cluster.items.length > 1

  return (
    <section>
      {showTimelineHeader ? (
        <div className="border-b border-bg-hover px-3 py-2">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-text-primary">
                  {cluster.application?.company || '未命名公司'} · {cluster.application?.position || '岗位未填写'}
                </h4>
                <StageBadge stage={cluster.application?.stage || 'applied'} />
                <span className="text-[11px] text-text-muted">
                  同岗位 {timelineCount} 场复盘
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="divide-y divide-bg-hover/70">
        {cluster.items.map((session, index) => {
          const { statusColor, StatusIcon, isTriggering, showTriggerButton } = getSessionUiState(session, triggeringIds)
          return (
            <ReviewQueueRow
              key={session.id}
              session={session}
              linkedReviewCount={session.application?.id != null ? linkedReviewCounts.get(session.application.id) ?? 1 : null}
              statusColor={statusColor}
              StatusIcon={StatusIcon}
              isTriggering={isTriggering}
              showTriggerButton={showTriggerButton}
              timelineLabel={linkedTimelineLabels.get(session.id) ?? (showTimelineHeader ? describeTimelinePosition(index, cluster.items.length) : null)}
              compactLinkedApplication={showTimelineHeader}
              onViewDetail={onViewDetail}
              onOpenApplication={onOpenApplication}
              onTriggerAnalysis={onTriggerAnalysis}
              deletingIds={deletingIds}
              onDeleteSession={onDeleteSession}
            />
          )
        })}
      </div>
    </section>
  )
}

function ReviewQueueRow({
  session,
  linkedReviewCount,
  statusColor,
  StatusIcon,
  isTriggering,
  showTriggerButton,
  timelineLabel,
  compactLinkedApplication,
  onViewDetail,
  onOpenApplication,
  onTriggerAnalysis,
  deletingIds,
  onDeleteSession,
}: {
  session: ReviewSession
  linkedReviewCount: number | null
  statusColor: string
  StatusIcon: ComponentType<{ className?: string }>
  isTriggering: boolean
  showTriggerButton: boolean
  timelineLabel: string | null
  compactLinkedApplication: boolean
  onViewDetail: (sessionId: number) => void
  onOpenApplication: (session: ReviewSession) => void
  onTriggerAnalysis: (sessionId: number) => void
  deletingIds: Set<number>
  onDeleteSession: (session: ReviewSession) => void
}) {
  const showLinkedApplication = Boolean(session.application)
  const showScore = session.avg_score != null
  const sourceMeta = getReviewSourceMeta(session.source)
  const isWrittenExam = isWrittenExamReview(session.source)
  const title = session.title || session.company || '未命名复盘'
  const roleText = session.role || (isWrittenExam ? '截图题' : '岗位未填写')
  const timeText = dayjs.unix(Math.floor(session.started_at)).format('MM-DD HH:mm')
  const turnsText = `${session.turn_count}${sourceMeta.unit}`
  const summary = sessionSummary(session)
  const hasPrimaryTrigger = showTriggerButton || isTriggering
  const linkedApplicationName = `${session.application?.company || '未命名公司'} · ${session.application?.position || '岗位'}`
  const metaParts = [
    timeText,
    turnsText,
    session.auto_sync_eligible === false ? '短样本' : null,
  ].filter((item): item is string => Boolean(item))

  return (
    <article
      onClick={() => onViewDetail(session.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onViewDetail(session.id)
        }
      }}
      role="button"
      tabIndex={0}
      className={`cursor-pointer px-3 py-2 outline-none transition-colors hover:bg-bg-tertiary/18 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-blue/30`}
      aria-label={`打开 ${title} 复盘详情`}
    >
      <div className="flex gap-3">
        <div className={`hidden w-1 shrink-0 md:block ${sessionRailTone(session.status)}`} />
        {showScore ? (
          <div className="hidden sm:flex flex-col items-center justify-start pt-0.5 w-12 flex-shrink-0 border-r border-text-primary/15 pr-3">
            <span className="deck-stat-value !text-[22px] text-accent-blue">{session.avg_score?.toFixed(1)}</span>
            <span className="deck-stat-label mt-1">SCORE</span>
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className={`grid gap-2 ${hasPrimaryTrigger ? 'xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start' : ''}`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h4 className="text-sm font-semibold tracking-tight text-text-primary">{title}</h4>
                <span className={`border px-1.5 py-0.5 text-[10px] font-semibold ${sourceMeta.badgeClassName}`} style={{ borderRadius: 2 }}>
                  {sourceMeta.label}
                </span>
                <span className="text-xs text-text-secondary">{roleText}</span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-text-muted">
                <span className={`inline-flex items-center gap-1 font-medium ${STATUS_COLORS[session.status]}`}>
                  <StatusIcon className={`h-3.5 w-3.5 ${session.status === 'analyzing' ? 'animate-spin' : ''} ${statusColor}`} />
                  {STATUS_LABELS[session.status]}
                </span>
                {showScore ? (
                  <span className="sm:hidden sd-num font-semibold text-accent-blue">{session.avg_score?.toFixed(1)}分</span>
                ) : null}
                {metaParts.map((part) => (
                  <span key={part} className="sd-num">{part}</span>
                ))}
              </div>
              {showLinkedApplication ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                  <span className="font-medium text-accent-blue">{compactLinkedApplication ? '同岗位' : '岗位'}</span>
                  <span className="font-medium text-text-primary">{linkedApplicationName}</span>
                  <StageBadge stage={session.application?.stage || 'applied'} />
                  {linkedReviewCount != null && linkedReviewCount > 1 ? (
                    <span className="font-medium text-text-muted">
                      {linkedReviewCount} 场
                    </span>
                  ) : null}
                  {timelineLabel ? (
                    <span className="font-medium text-accent-blue">
                      {timelineLabel}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`查看 ${linkedApplicationName} 岗位`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenApplication(session)
                    }}
                    className="text-[11px] font-medium text-text-muted transition-colors hover:text-accent-blue hover:underline"
                  >
                    岗位
                  </button>
                </div>
              ) : null}

              {summary ? (
                <p className={`text-xs leading-relaxed text-text-secondary ${showLinkedApplication ? 'mt-2 line-clamp-2' : 'mt-1 line-clamp-2'}`}>
                  {summary}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 xl:min-w-[240px] xl:flex-col xl:items-end xl:justify-start">
                {showTriggerButton ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onTriggerAnalysis(session.id)
                    }}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium ${
                      session.status === 'analysis_failed'
                        ? 'border-red-500/20 bg-red-500/10 text-red-500 hover:bg-red-500/15'
                        : 'border-green-500/20 bg-green-500/10 text-green-500 hover:bg-green-500/15'
                    }`}
                  >
                    {session.status === 'analysis_failed' ? <RotateCw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {session.status === 'analysis_failed' ? '重试生成' : '生成复盘'}
                  </button>
                ) : null}

                {isTriggering ? (
                  <span className="inline-flex h-9 items-center gap-1.5 px-2 text-xs text-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    提交中
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`删除 ${title} 复盘`}
                  title="删除复盘"
                  disabled={deletingIds.has(session.id) || session.status === 'analyzing' || session.status === 'recording'}
                  onClick={(event) => {
                    event.stopPropagation()
                    void onDeleteSession(session)
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-500/20 px-2.5 text-xs font-medium text-red-500 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingIds.has(session.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  删除
                </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}

function getSessionUiState(
  session: ReviewSession,
  triggeringIds: Set<number>,
) {
  const StatusIcon = STATUS_ICONS[session.status]
  const statusColor = STATUS_COLORS[session.status]
  const isTriggering = triggeringIds.has(session.id)
  const canTrigger = session.status === 'analysis_failed' ||
    session.status === 'partial_capture' ||
    session.status === 'recorded' ||
    session.status === 'recording' ||
    (session.status === 'completed' && !sessionHasGeneratedAnalysis(session))
  const showTriggerButton = canTrigger && !isTriggering
  return {
    StatusIcon,
    statusColor,
    isTriggering,
    showTriggerButton,
  }
}

function sessionRailTone(status: ReviewSession['status']) {
  switch (status) {
    case 'analysis_failed':
      return 'bg-red-500'
    case 'partial_capture':
    case 'recorded':
      return 'bg-yellow-500'
    case 'analyzing':
    case 'recording':
      return 'bg-blue-500'
    case 'completed':
      return 'bg-emerald-500'
    default:
      return 'bg-zinc-400'
  }
}

function sessionSummary(session: ReviewSession): string | null {
  const isWrittenExam = isWrittenExamReview(session.source)
  const normalized = String(session.summary_markdown ?? '')
    .replace(/[#>*`_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized) return normalized
  if (session.status === 'analysis_failed') {
    return '生成失败'
  }
  if (session.status === 'partial_capture') {
    return '采集不完整'
  }
  if (session.status === 'recorded') {
    if (isWrittenExam) {
      return session.auto_sync_eligible === false
        ? '短样本笔试记录'
        : '待生成笔试报告'
    }
    return session.auto_sync_eligible === false
      ? '短样本'
      : '待生成'
  }
  if (session.status === 'analyzing') {
    return isWrittenExam ? '整理笔试报告中' : '整理中'
  }
  if (session.status === 'recording') {
    return isWrittenExam ? '笔试记录中' : '录制中'
  }
  return null
}

function buildSessionClusters(sessions: ReviewSession[]): SessionCluster[] {
  const ordered: SessionCluster[] = []
  const clusterByApplicationId = new Map<number, SessionCluster>()

  for (const session of sessions) {
    const applicationId = session.application?.id
    if (applicationId == null) {
      ordered.push({
        key: `session-${session.id}`,
        application: null,
        items: [session],
      })
      continue
    }

    const existing = clusterByApplicationId.get(applicationId)
    if (existing) {
      existing.items.push(session)
      continue
    }

    const nextCluster: SessionCluster = {
      key: `application-${applicationId}`,
      application: session.application,
      items: [session],
    }
    clusterByApplicationId.set(applicationId, nextCluster)
    ordered.push(nextCluster)
  }

  return ordered
}

function describeTimelinePosition(index: number, total: number) {
  if (total <= 1) return '唯一一场'
  if (index === 0) return '最近一场'
  if (index === total - 1) return '更早一场'
  return '中间场'
}

function buildSessionGroups(
  sessions: ReviewSession[],
): SessionGroup[] {
  return [
    {
      key: 'attention' as const,
      title: '先处理',
      items: sessions.filter((session) =>
        session.status === 'analysis_failed' ||
        session.status === 'partial_capture' ||
        session.status === 'recorded' ||
        (session.status === 'completed' && !sessionHasGeneratedAnalysis(session)),
      ),
    },
    {
      key: 'active' as const,
      title: '进行中',
      items: sessions.filter((session) =>
        session.status === 'analyzing' || session.status === 'recording',
      ),
    },
    {
      key: 'done' as const,
      title: '已完成',
      items: sessions.filter((session) =>
        session.status === 'completed' && sessionHasGeneratedAnalysis(session),
      ),
    },
  ].filter((group) => group.items.length > 0)
}
