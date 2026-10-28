import { lazy, memo, Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { Bot, ChevronRight, Ban, AlertCircle, Layers, ArrowDown, Keyboard, ClipboardPaste, Mic, MonitorSmartphone, Pencil, Check, X, ExternalLink, ShieldCheck, ShieldAlert, Shield, Copy } from 'lucide-react'
import { useInterviewStore, QAPair } from '@/stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'
import KbReferenceBanner from '@/components/kb/KbReferenceBanner'
import { BrandMark } from '@/components/app/BrandMark'
import type { ColorSchemeId } from '@/lib/colorScheme'
import { api, getErrorMessage } from '@/lib/api'

const SoundTest = lazy(() => import('./SoundTest'))
const WrittenExamTest = lazy(() => import('./WrittenExamTest'))
const AnswerMarkdownContent = lazy(() => import('./AnswerMarkdownContent'))

function scrollElementIntoView(element: Element | null, options?: ScrollIntoViewOptions) {
  if (typeof element?.scrollIntoView === 'function') {
    element.scrollIntoView(options)
  }
}

function VisionVerifyBadge({ verdict, reason }: { verdict: 'PASS' | 'FAIL' | 'UNKNOWN'; reason: string }) {
  const palette =
    verdict === 'PASS'
      ? {
          icon: <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />,
          label: '截图自检通过',
          ring: 'border-accent-green/50 bg-accent-green/10 text-accent-green',
        }
      : verdict === 'FAIL'
        ? {
            icon: <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />,
            label: '截图自检不一致,请人工复核',
            ring: 'border-accent-amber/60 bg-accent-amber/10 text-accent-amber',
          }
        : {
            icon: <Shield className="w-3.5 h-3.5 flex-shrink-0" />,
            label: '截图自检无定论',
            ring: 'border-text-muted/40 bg-bg-tertiary/40 text-text-muted',
          }
  return (
    <div className={`mt-3 flex items-start gap-2 rounded-lg border-[0.5px] px-3 py-2 text-[11px] leading-snug ${palette.ring}`}>
      {palette.icon}
      <div className="min-w-0">
        <div className="font-medium">{palette.label}</div>
        {reason && <div className="opacity-80 mt-0.5 break-words">{reason}</div>}
      </div>
    </div>
  )
}

function WebSources({ sources }: { sources: NonNullable<QAPair['webSources']> }) {
  if (!sources.length) return null
  return (
    <div className="mt-3 border-t border-bg-hover pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
        <ExternalLink className="h-3 w-3 text-accent-strong" />
        联网参考来源
      </div>
      <div className="space-y-1">
        {sources.map((source) => (
          <a
            key={`${source.rank}:${source.url}`}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 items-start gap-2 text-[11px] leading-snug text-text-muted transition-colors hover:text-accent-blue"
            title={`${source.title}\n${source.url}`}
          >
            <span className="sd-num flex-shrink-0 border-b border-accent-blue/40 text-[10px] text-accent-blue">
              {source.rank}.
            </span>
            <span className="min-w-0 break-words">{source.title}</span>
          </a>
        ))}
      </div>
    </div>
  )
}

/* Cherry MessageActionButton: 26px 圆角小图标按钮, muted → hover 灰底 */
function CopyAnswerButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])
  if (!text) return null
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          if (timerRef.current !== null) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setCopied(false), 2000)
        } catch { /* ignore */ }
      }}
      className="flex size-[26px] items-center justify-center rounded-md bg-transparent p-1 text-text-muted transition-all duration-150 hover:bg-bg-tertiary hover:text-text-primary"
      title={copied ? '已复制' : '复制答案'}
      aria-label={copied ? '已复制答案' : '复制答案'}
    >
      {copied ? <Check className="h-[15px] w-[15px] text-accent-green" /> : <Copy className="h-[15px] w-[15px]" />}
    </button>
  )
}

/* Cherry ThinkingBlock: 13px muted 标题行(思考中=跳动圆点, 完成=已深度思考) + 灰底圆角面板 */
function ThinkBlock({ content, isThinking }: { content: string; isThinking: boolean }) {
  const [collapsed, setCollapsed] = useState(!isThinking)
  const contentRef = useRef<HTMLDivElement>(null)
  const maxH = 'max-h-[min(32rem,60dvh)]'

  // 思考结束后默认折叠 (Cherry thought_auto_collapse)
  useEffect(() => {
    if (!isThinking) setCollapsed(true)
    else setCollapsed(false)
  }, [isThinking])

  useEffect(() => {
    if (isThinking && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [content, isThinking])

  if (!content) return null

  return (
    <div className="mb-2" data-testid="think-block">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className="flex min-h-7 w-full items-center gap-1.5 overflow-hidden rounded-lg px-2 py-0.5 text-[13px] text-text-muted select-none transition-colors hover:bg-bg-tertiary/70"
      >
        {isThinking ? (
          <>
            <span className="think-dots" aria-hidden>
              <span /><span /><span />
            </span>
            <span className="font-normal">让我认真想一想…</span>
            <span className="truncate text-text-tertiary">{content.slice(-60)}</span>
          </>
        ) : (
          <>
            <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 text-text-tertiary transition-transform duration-200 ${!collapsed ? 'rotate-90' : ''}`} />
            <span className="font-normal">已深度思考</span>
            <span className="text-text-tertiary text-xs">({content.length} 字)</span>
          </>
        )}
      </button>
      <div className={`transition-all duration-300 ease-in-out overflow-hidden ${collapsed ? 'max-h-0' : maxH}`}>
        <div
          ref={contentRef}
          className={`mt-1.5 overflow-y-auto rounded-xl bg-bg-tertiary px-4 py-3 text-[13px] leading-5 text-text-muted whitespace-pre-wrap select-text ${maxH}`}
        >
          {content}
        </div>
      </div>
    </div>
  )
}

const SOURCE_LABELS: Record<string, string> = {
  asr: '实时转写',
  conversation_loopback: '会议拾音',
  conversation_mic: '本机麦克风',
  manual_text: '键盘速记',
  manual_image: '截图审题',
  server_screen_left: '服务端截图审题',
  server_screen_multi: '连续截图审题',
  server_screen_exam_preflight: '笔试链路检测',
}

function sourceLabel(source?: string): string | null {
  if (!source) return null
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source]
  if (source.startsWith('server_screen_')) return '服务端截图审题'
  return null
}

function renderAnswerBody(
  qa: QAPair,
  isStreaming: boolean,
  stream: boolean,
  colorScheme: ColorSchemeId,
) {
  const qaStatus = qa.status ?? (qa.answer ? 'done' : 'streaming')
  return (
    <>
      {qa.thinkContent && <ThinkBlock content={qa.thinkContent} isThinking={qa.isThinking} />}
      {qaStatus === 'cancelled' ? (
        <div className="flex items-center gap-1.5 text-text-muted italic text-sm">
          <Ban className="w-3.5 h-3.5 flex-shrink-0" />
          <span>已取消</span>
        </div>
      ) : qaStatus === 'error' ? (
        <div className="space-y-2">
          {qa.answer && (
            <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap break-words opacity-60">
              {qa.answer}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-accent-red text-sm font-medium">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{qa.errorMessage || '答案保存失败'}</span>
          </div>
        </div>
      ) : qa.answer ? (
        /* Cherry 式流式渲染: 生成期间也直接渲染 markdown(块级增量解析), 不再先显示原始符号 */
        <Suspense fallback={<div className="text-sm text-text-muted">渲染答案中…</div>}>
          <AnswerMarkdownContent answer={qa.answer} colorScheme={colorScheme} stream={stream} />
        </Suspense>
      ) : isStreaming && !qa.isThinking ? (
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <span className="shimmer-text font-medium">正在生成…</span>
        </div>
      ) : null}
      {qa.visionVerify && qaStatus !== 'cancelled' && qaStatus !== 'error' && (
        <VisionVerifyBadge verdict={qa.visionVerify.verdict} reason={qa.visionVerify.reason} />
      )}
      {qa.webSources?.length && qaStatus !== 'cancelled' && qaStatus !== 'error' ? (
        <WebSources sources={qa.webSources} />
      ) : null}
    </>
  )
}

type QACardProps = {
  qa: QAPair
  isStreaming: boolean
  stream: boolean
  colorScheme: ColorSchemeId
  animate: boolean
}

const QACard = memo(function QACard({ qa, isStreaming, stream, colorScheme, animate }: QACardProps) {
  const beginAnswerReplacement = useInterviewStore((s) => s.beginAnswerReplacement)
  const restoreAnswerReplacement = useInterviewStore((s) => s.restoreAnswerReplacement)
  const updateTranscription = useInterviewStore((s) => s.updateTranscription)
  const pushToast = useInterviewStore((s) => s.pushToast)
  const [editing, setEditing] = useState(false)
  const [editedQuestion, setEditedQuestion] = useState(qa.question)
  const [resending, setResending] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const srcLabel = sourceLabel(qa.questionSource)
  const baseClass = animate ? 'animate-fade-up' : ''
  const canEditQuestion = !qa.questionSource?.includes('image') && !qa.questionSource?.startsWith('server_screen_')

  useEffect(() => {
    if (!editing) setEditedQuestion(qa.question)
  }, [qa.question, editing])

  const handleStartEdit = () => {
    if (isStreaming || qa.isResending || !canEditQuestion) return
    setEditedQuestion(qa.question)
    setEditing(true)
  }

  const handleCancelEdit = () => {
    if (resending) return
    setEditedQuestion(qa.question)
    setEditing(false)
  }

  const handleResend = async () => {
    const nextQuestion = editedQuestion.trim()
    if (!nextQuestion || resending || isStreaming) return
    setResending(true)
    setEditing(false)
    beginAnswerReplacement(qa.id, nextQuestion)
    try {
      await api.ask(nextQuestion, undefined, { replaceQaId: qa.id })
      for (const transcriptionId of qa.sourceTranscriptionIds ?? []) {
        updateTranscription(transcriptionId, nextQuestion)
      }
    } catch (err) {
      restoreAnswerReplacement(qa.id)
      setEditedQuestion(qa.question)
      setEditing(true)
      pushToast(getErrorMessage(err, '重新发送失败'), 'error')
    } finally {
      setResending(false)
    }
  }

  const questionContent = editing ? (
    <div className="w-full space-y-2">
      <textarea
        value={editedQuestion}
        onChange={(event) => setEditedQuestion(event.target.value)}
        rows={3}
        autoFocus
        disabled={resending}
        className="w-full resize-y rounded-lg border border-accent-blue/60 bg-bg-secondary px-3 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-accent-blue disabled:opacity-60"
        aria-label="编辑面试官问题"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleResend()}
          disabled={resending || !editedQuestion.trim()}
          className="sd-btn sd-btn--primary !min-h-[28px] !px-2.5 !text-[11px]"
        >
          <Check className="h-3.5 w-3.5" />
          重新发送
        </button>
        <button
          type="button"
          onClick={handleCancelEdit}
          disabled={resending}
          className="sd-btn !min-h-[28px] !px-2.5 !text-[11px]"
        >
          <X className="h-3.5 w-3.5" />
          取消
        </button>
      </div>
    </div>
  ) : (
    <p className="min-w-0 text-sm text-text-primary leading-relaxed whitespace-pre-wrap break-words">{qa.question}</p>
  )

  const latencyInfo = [
    qa.firstTokenMs != null ? `首字 ${qa.firstTokenMs}ms` : null,
    qa.totalMs != null ? `${qa.totalMs}ms` : null,
  ].filter(Boolean).join(' · ')

  /* Cherry 消息结构: 用户右气泡 + AI 头像/名字/全文宽正文 + hover 操作栏 */
  const messageBody = (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 flex size-[26px] flex-shrink-0 items-center justify-center overflow-hidden rounded-full border-[0.5px] border-bg-hover/60 bg-bg-secondary">
        <BrandMark className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold leading-5 text-text-primary">
            {qa.modelLabel || 'AI 助手'}
          </span>
          {latencyInfo && (
            <span className="sd-num text-[10px] text-text-tertiary opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
              {latencyInfo}
            </span>
          )}
          {isStreaming && (
            <span className="text-[10px] text-accent-strong font-medium">输出中</span>
          )}
        </div>
        <div className="mt-1.5">
          <KbReferenceBanner qaId={qa.id} />
          {renderAnswerBody(qa, isStreaming, stream, colorScheme)}
        </div>
        {/* Cherry MessageFooter: hover 淡入(Cherry 同款 menubar) */}
        <div
          className={`mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ${
            isStreaming ? '' : 'group-hover/message:opacity-100'
          }`}
        >
          <CopyAnswerButton text={qa.answer} />
        </div>
      </div>
    </div>
  )

  /* 用户气泡: 右对齐灰底 (Cherry --chat-user), stream/卡片两种布局共用 */
  const questionBubble = (
    <div className="flex w-full flex-col items-end">
      {srcLabel && (
        <div className="mb-1 mr-1 text-[10px] text-text-tertiary">{srcLabel}</div>
      )}
      {editing ? (
        questionContent
      ) : (
        <div
          className="max-w-[85%] rounded-[10px] px-4 py-2.5"
          style={{ background: 'rgb(var(--c-chat-user-bg, 0 0 0) / var(--c-chat-user-alpha, 0.05))' }}
        >
          {questionContent}
          {qa.images && qa.images.length > 0 && (
            <div className="mt-2 flex flex-wrap justify-end gap-1.5">
              {qa.images.map((img, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => setPreviewImage(img)}
                  className="overflow-hidden rounded-md border border-bg-hover/60 transition-opacity hover:opacity-80"
                  title={`查看截图 ${index + 1}`}
                  aria-label={`查看截图 ${index + 1}`}
                >
                  <img src={img} alt={`题目截图 ${index + 1}`} className="h-20 w-auto object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {canEditQuestion && !isStreaming && !qa.isResending && !editing && (
        <div className="mt-0.5 mr-1 flex items-center opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
          <button
            type="button"
            onClick={handleStartEdit}
            className="flex size-6 items-center justify-center rounded-md text-text-muted transition-all hover:bg-bg-tertiary hover:text-text-primary"
            title="编辑问题后重新发送"
            aria-label="编辑问题后重新发送"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )

  /* 截图预览灯箱：点击缩略图后全屏查看，点任意处关闭 */
  const imageLightbox = previewImage ? (
    <div
      className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/70 p-6"
      onClick={() => setPreviewImage(null)}
      role="dialog"
      aria-label="截图预览"
    >
      <img
        src={previewImage}
        alt="题目截图预览"
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  ) : null

  if (stream) {
    return (
      <article className={`group/message ${baseClass}`}>
        {questionBubble}
        <div className="mt-2.5">{messageBody}</div>
        {imageLightbox}
      </article>
    )
  }

  /* 卡片(考卷页): 柔和面板包裹同样的消息结构 */
  return (
    <article className={`deck-panel group/message px-4 py-3.5 ${baseClass}`}>
      {questionBubble}
      <div className="mt-2.5 max-h-[320px] overflow-y-auto">{messageBody}</div>
      {imageLightbox}
    </article>
  )
})

export default function AnswerPanel() {
  const qaPairs = useInterviewStore((s) => s.qaPairs)
  const streamingIds = useInterviewStore((s) => s.streamingIds)
  const config = useInterviewStore((s) => s.config)
  const isRecording = useInterviewStore((s) => s.isRecording)
  const isExamMode = config?.written_exam_mode === true
  const toggleSettings = useInterviewStore((s) => s.toggleSettings)
  const answerPanelLayout = useUiPrefsStore((s) => s.answerPanelLayout)
  const colorScheme = useUiPrefsStore((s) => s.colorScheme)
  const stream = answerPanelLayout === 'stream'
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)

  const scrollThreshold = Math.max(4, Math.min(400, config?.answer_autoscroll_bottom_px ?? 40))
  const [nearBottom, setNearBottom] = useState(true)

  const updateNearBottom = useCallback((fromUserScroll = true) => {
    const el = scrollContainerRef.current
    if (!el) return
    const d = el.scrollHeight - el.scrollTop - el.clientHeight
    const nextNearBottom = d <= scrollThreshold
    if (fromUserScroll) {
      autoFollowRef.current = nextNearBottom
      setNearBottom(nextNearBottom)
      return
    }
    // ResizeObserver and layout changes are not user intent. Preserve the
    // follow preference instead of falsely showing “manual scroll paused”.
    setNearBottom(autoFollowRef.current || nextNearBottom)
  }, [scrollThreshold])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    autoFollowRef.current = true
    setNearBottom(true)
    scrollElementIntoView(bottomRef.current, { behavior })
    requestAnimationFrame(() => updateNearBottom(false))
  }, [updateNearBottom])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el || !bottomRef.current) return
    if (autoFollowRef.current) {
      // Streaming/layout updates should never temporarily mark the user as
      // scrolled away from the latest answer. `auto` also avoids intermediate
      // scroll events from smooth scrolling toggling the follow state.
      requestAnimationFrame(() => scrollToLatest('auto'))
    } else {
      setNearBottom(false)
    }
  }, [qaPairs, streamingIds, scrollToLatest])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    updateNearBottom(false)
    const onScroll = () => updateNearBottom(true)
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => {
      if (autoFollowRef.current) {
        requestAnimationFrame(() => scrollToLatest('auto'))
      } else {
        updateNearBottom(false)
      }
    })
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [qaPairs.length, scrollToLatest, updateNearBottom])

  const hasActiveGeneration =
    streamingIds.length > 0 || qaPairs.some((q) => q.isThinking)
  // 用户向上滚动且远离底部时即显示 "回到最新"; 生成中则补充旋转指示器
  const showScrollToLatestFab = qaPairs.length > 0 && !nearBottom

  const needsConfig = config && (!config.models?.length || !config.api_key_set)
  const multiStream = streamingIds.length > 1

  const isIdle = !isRecording

  if (qaPairs.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="deck-header">
          <span className="deck-header-tag">{isExamMode ? 'A-EXAM' : 'A-01 · ANSWER DECK'}</span>
          <span className="deck-header-title">AI {isExamMode ? '笔试助手' : '面试助手'}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* 待机画面: Cherry 首页式居中欢迎布局 */}
          <div className="flex min-h-full flex-col items-center justify-center px-6 py-10">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent-strong shadow-sm">
              <Bot className="h-7 w-7" />
            </div>
            <p className="mt-4 text-lg font-semibold tracking-tight text-text-primary">
              AI {isExamMode ? '笔试助手' : '面试助手'}
            </p>
            <p className="mt-1.5 max-w-sm text-center text-[13px] leading-relaxed text-text-muted">
              {isExamMode ? '截图或输入题目后自动生成答案' : '识别到问题后自动生成回答，也可以手动输入或截图审题'}
            </p>

            {needsConfig && (
              <div className="mt-6 flex flex-col items-center gap-2">
                <p className="text-xs text-text-muted">{'请先在设置中配置模型与 API Key'}</p>
                <button
                  type="button"
                  onClick={() => toggleSettings()}
                  className="sd-btn sd-btn--primary !min-h-[32px] !px-4 !text-xs"
                >
                  {'去设置 →'}
                </button>
              </div>
            )}
            {!needsConfig && (
              <div className="mt-7 grid w-full max-w-md grid-cols-3 gap-2.5">
                {(isExamMode
                  ? [
                      { icon: Keyboard, label: '键盘输入', hint: '底部输入框 + Enter' },
                      { icon: ClipboardPaste, label: '粘贴截图', hint: '输入框内 Ctrl/⌘+V' },
                      { icon: MonitorSmartphone, label: '开始笔试', hint: '截图审题或输入问题' },
                    ]
                  : [
                      { icon: Keyboard, label: '键盘输入', hint: '底部输入框 + Enter' },
                      { icon: ClipboardPaste, label: '粘贴截图', hint: '输入框内 Ctrl/⌘+V' },
                      { icon: Mic, label: '开始面试', hint: '录音自动识别问题' },
                    ]
                ).map(({ icon: Icon, label, hint }) => (
                  <div
                    key={label}
                    title={hint}
                    className="flex flex-col items-center gap-1.5 rounded-xl border-[0.5px] border-bg-hover bg-bg-secondary px-3 py-3.5 text-center shadow-sm transition-colors hover:border-bg-hover/80 hover:bg-bg-tertiary/40"
                  >
                    <Icon className="h-4 w-4 text-text-muted" />
                    <span className="text-xs font-medium text-text-primary">{label}</span>
                    <span className="text-[10px] leading-snug text-text-tertiary">{hint}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Sound Test - only show when idle (not recording) */}
            {isIdle && !isExamMode && (
              <div className="mt-8 w-full max-w-md">
                <Suspense fallback={<div className="text-center text-xs text-text-muted">加载链路检测中…</div>}>
                  <SoundTest />
                </Suspense>
              </div>
            )}
            {isIdle && isExamMode && (
              <div className="mt-8 w-full max-w-md">
                <Suspense fallback={<div className="text-center text-xs text-text-muted">加载链路检测中…</div>}>
                  <WrittenExamTest />
                </Suspense>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0 flex flex-col">
      <div className="deck-header">
        <span className="deck-header-tag">{isExamMode ? 'A-EXAM' : 'A-01 · ANSWER DECK'}</span>
        <span className="deck-header-title">AI {isExamMode ? '笔试助手' : '面试助手'}</span>
        <div className="deck-header-aside sd-num text-[10px] text-text-muted uppercase tracking-wider">
          {qaPairs.length} 条问答
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        className={`flex-1 min-h-0 overflow-y-auto px-3 py-3 md:px-5 md:py-4 ${stream ? 'space-y-10' : 'space-y-5'}`}
        onWheel={(event) => {
          event.currentTarget.scrollTop += event.deltaY
        }}
      >
      {multiStream && (
        <div className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border-[0.5px] border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-accent-amber text-xs font-medium backdrop-blur-sm">
          <Layers className="w-4 h-4 flex-shrink-0" />
          <span>
            {streamingIds.length} 路模型同时生成中，答案自上而下依次出现，请向下滚动查看各路输出
          </span>
        </div>
      )}

      {qaPairs.map((qa, idx) => {
        const isStreaming = streamingIds.includes(qa.id)
        const isLatest = idx === qaPairs.length - 1
        // 只给最新一项播入场动画,避免历史项在 store 更新时反复重播
        const animate = isLatest
        return (
          <QACard
            key={qa.id}
            qa={qa}
            isStreaming={isStreaming}
            stream={stream}
            colorScheme={colorScheme}
            animate={animate}
          />
        )
      })}
      <div ref={bottomRef} />
      </div>

      {showScrollToLatestFab && (
        <div className="pointer-events-none absolute bottom-4 right-3 sm:right-5 z-20 animate-fade-up flex flex-col items-end gap-1.5">
          {hasActiveGeneration && (
            <div
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-bg-hover bg-bg-secondary px-2.5 py-1 text-[10px] font-medium text-text-muted shadow-sm"
              role="status"
              aria-live="polite"
              title="你手动上滑了页面，自动跟随已暂停；点击下方按钮继续跟随"
            >
              <span className="inline-flex w-1.5 h-1.5 rounded-full bg-accent-blue motion-safe:animate-pulse" aria-hidden />
              <span>生成中 · 已暂停跟随</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => scrollToLatest()}
            title={hasActiveGeneration ? '下方正在生成，点击继续跟随' : '回到最新答案'}
            aria-label={hasActiveGeneration ? '继续跟随最新生成内容' : '滚动到最新答案'}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border-[0.5px] border-bg-hover bg-bg-secondary text-text-secondary shadow-md transition-all hover:text-text-primary hover:shadow-lg"
          >
            <ArrowDown className="h-4 w-4" strokeWidth={2.25} />
            <span className="sr-only">
              {hasActiveGeneration ? '正在生成，继续跟随最新' : '跳到最新答案'}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
