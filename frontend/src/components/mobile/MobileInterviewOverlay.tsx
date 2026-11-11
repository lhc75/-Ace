import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Eye, PictureInPicture2, X } from 'lucide-react'
import AnswerMarkdownContent from '@/components/AnswerMarkdownContent'
import { INTERVIEW_OVERLAY_PIP_REQUEST_EVENT } from '@/lib/interviewOverlay'
import { useInterviewStore } from '@/stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

type WebkitPictureInPictureVideo = HTMLVideoElement & {
  webkitPresentationMode?: 'inline' | 'picture-in-picture'
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture') => void
}

function answerTextForOverlay(answer: string): string {
  return answer
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, '').trim())
    .replace(/[*_#>`]/g, '')
    .trim()
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      lines.push('')
      continue
    }
    let line = ''
    for (const char of Array.from(paragraph)) {
      const next = line + char
      if (line && context.measureText(next).width > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

export default function MobileInterviewOverlay() {
  const qaPairs = useInterviewStore((s) => s.qaPairs)
  const currentStreamingId = useInterviewStore((s) => s.currentStreamingId)
  const colorScheme = useUiPrefsStore((s) => s.colorScheme)
  const enabled = useUiPrefsStore((s) => s.interviewOverlayEnabled)
  const opacity = useUiPrefsStore((s) => s.interviewOverlayOpacity)
  const fontSize = useUiPrefsStore((s) => s.interviewOverlayFontSize)
  const fontColor = useUiPrefsStore((s) => s.interviewOverlayFontColor)
  const overlayMode = useUiPrefsStore((s) => s.interviewOverlayMode)
  const focusWidthPct = useUiPrefsStore((s) => s.interviewOverlayFocusWidthPct)
  const focusHeightPct = useUiPrefsStore((s) => s.interviewOverlayFocusHeightPct)
  const promptMaxWidth = useUiPrefsStore((s) => s.interviewOverlayPromptMaxWidth)
  const maxLines = useUiPrefsStore((s) => s.interviewOverlayMaxLines)
  const setOverlayEnabled = useUiPrefsStore((s) => s.setInterviewOverlayEnabled)

  const videoRef = useRef<WebkitPictureInPictureVideo | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [pipActive, setPipActive] = useState(false)
  const [pipMessage, setPipMessage] = useState<string | null>(null)

  const latest = useMemo(() => {
    const streaming = qaPairs.find((qa) => qa.id === currentStreamingId)
    return streaming ?? qaPairs[qaPairs.length - 1] ?? null
  }, [currentStreamingId, qaPairs])
  const answer = latest?.answer?.trim() || ''
  const fallbackText = latest
    ? latest.isThinking
      ? '思考中…'
      : '正在组织回答…'
    : '等待面试官问题或 AI 回答…'
  const displayText = answer || fallbackText

  const supportsPip = typeof document !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && (
      (document.pictureInPictureEnabled && typeof HTMLVideoElement !== 'undefined')
      || typeof (HTMLVideoElement.prototype as WebkitPictureInPictureVideo).webkitSetPresentationMode === 'function'
    )

  const enterPip = useCallback(async () => {
    const video = videoRef.current
    if (!video) return false
    try {
      setPipMessage(null)
      if (video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode('picture-in-picture')
        setPipActive(video.webkitPresentationMode === 'picture-in-picture')
        return true
      }
      if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function') {
        setPipMessage('当前浏览器不支持跨应用悬浮窗，请使用 Chrome 或 Edge')
        return false
      }
      if (document.pictureInPictureElement === video) return true
      void video.play().catch(() => undefined)
      await video.requestPictureInPicture()
      setPipActive(true)
      return true
    } catch {
      setPipMessage('浏览器未允许自动开启，请点击悬浮窗右上角按钮')
      return false
    }
  }, [])

  const exitPip = useCallback(async () => {
    const video = videoRef.current
    try {
      if (video?.webkitSetPresentationMode && video.webkitPresentationMode === 'picture-in-picture') {
        video.webkitSetPresentationMode('inline')
      } else if (video && document.pictureInPictureElement === video) {
        await document.exitPictureInPicture()
      }
    } catch {
      /* Browser already closed the system window. */
    } finally {
      setPipActive(false)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || !supportsPip || typeof canvas.captureStream !== 'function') return
    try {
      const stream = canvas.captureStream(8)
      streamRef.current = stream
      video.srcObject = stream
      void video.play().catch(() => undefined)
    } catch {
      setPipMessage('当前浏览器无法创建实时悬浮画面')
    }
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      video.srcObject = null
    }
  }, [supportsPip])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const width = canvas.width
    const height = canvas.height
    const isFocus = overlayMode === 'focus'
    const foreground = isFocus ? '#263241' : fontColor
    const background = isFocus ? '#f8fafc' : '#111827'
    const secondary = isFocus ? '#64748b' : '#94a3b8'

    context.clearRect(0, 0, width, height)
    const gradient = context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, background)
    gradient.addColorStop(1, isFocus ? '#e2e8f0' : '#1e293b')
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)

    context.fillStyle = '#34d399'
    context.fillRect(0, 0, width, 8)
    context.font = '600 28px "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillStyle = foreground
    context.fillText('AI 面试实时答案', 38, 62)
    context.font = '400 22px "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillStyle = secondary
    context.fillText(latest ? (currentStreamingId ? '正在同步生成' : '最新回答') : '等待识别', 38, 101)

    context.font = `500 ${Math.max(30, Math.min(46, fontSize * 2.2))}px "PingFang SC", "Microsoft YaHei", sans-serif`
    context.fillStyle = foreground
    const lines = wrapCanvasText(context, answerTextForOverlay(displayText), width - 76)
    const lineHeight = Math.max(48, Math.min(72, fontSize * 3.4))
    const maxVisibleLines = Math.max(1, Math.floor((height - 150) / lineHeight))
    lines.slice(0, maxVisibleLines).forEach((line, index) => {
      context.fillText(line, 38, 164 + index * lineHeight)
    })
  }, [currentStreamingId, displayText, fontColor, fontSize, latest, overlayMode])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onEnter = () => setPipActive(true)
    const onLeave = () => setPipActive(false)
    video.addEventListener('enterpictureinpicture', onEnter)
    video.addEventListener('leavepictureinpicture', onLeave)
    video.addEventListener('webkitpresentationmodechanged', onLeave)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter)
      video.removeEventListener('leavepictureinpicture', onLeave)
      video.removeEventListener('webkitpresentationmodechanged', onLeave)
    }
  }, [])

  useEffect(() => {
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail
      if (detail?.enabled) void enterPip()
      else void exitPip()
    }
    window.addEventListener('interview-overlay-toggle', onToggle)
    return () => window.removeEventListener('interview-overlay-toggle', onToggle)
  }, [enterPip, exitPip])

  useEffect(() => {
    const onPipRequest = () => {
      if (enabled) void enterPip()
    }
    const onVisibilityChange = () => {
      if (enabled && document.visibilityState === 'hidden') void enterPip()
    }
    window.addEventListener(INTERVIEW_OVERLAY_PIP_REQUEST_EVENT, onPipRequest)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener(INTERVIEW_OVERLAY_PIP_REQUEST_EVENT, onPipRequest)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, enterPip])

  useEffect(() => {
    if (!enabled) void exitPip()
  }, [enabled, exitPip])

  useEffect(() => () => {
    if (videoRef.current && document.pictureInPictureElement === videoRef.current) {
      void document.exitPictureInPicture().catch(() => undefined)
    }
  }, [])

  const focusColor = overlayMode === 'focus' ? '#263241' : fontColor
  const surfaceStyle: CSSProperties = {
    color: focusColor,
    opacity: overlayMode === 'prompt' ? opacity : 1,
    maxWidth: overlayMode === 'prompt'
      ? `min(calc(100vw - 1.25rem), ${promptMaxWidth}px)`
      : overlayMode === 'focus'
        ? `${focusWidthPct}%`
        : undefined,
    width: overlayMode === 'focus' ? `${focusWidthPct}%` : undefined,
    backgroundColor: overlayMode === 'prompt'
      ? 'transparent'
      : overlayMode === 'focus'
        ? `rgba(248, 250, 252, ${opacity})`
        : `rgba(15, 23, 42, ${opacity})`,
    backdropFilter: overlayMode === 'glass' ? 'blur(18px)' : undefined,
    WebkitBackdropFilter: overlayMode === 'glass' ? 'blur(18px)' : undefined,
    maxHeight: overlayMode === 'focus' ? `${focusHeightPct}dvh` : '46dvh',
  }
  const answerStyle: CSSProperties = {
    fontSize: `${fontSize}px`,
    maxHeight: maxLines > 0 ? `${Math.ceil(fontSize * 1.65 * maxLines)}px` : undefined,
  }

  return (
    <>
      {enabled && (
        <section
          role="dialog"
          aria-label="悬浮提示窗"
          data-testid="mobile-floating-answer"
          className={`fixed inset-x-2.5 top-[7.75rem] z-40 ml-auto flex flex-col overflow-hidden rounded-xl border shadow-2xl ${
            overlayMode === 'prompt'
              ? 'border-transparent'
              : overlayMode === 'focus'
                ? 'border-slate-300'
                : 'border-white/15'
          }`}
          style={surfaceStyle}
        >
          <div className={`flex items-center gap-2 border-b px-3 py-2 ${
            overlayMode === 'prompt'
              ? 'border-transparent bg-slate-950/25 text-slate-100'
              : overlayMode === 'focus'
                ? 'border-slate-300/80 text-slate-700'
                : 'border-white/10 text-slate-100'
          }`}>
            <Eye className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
            <span className="text-xs font-semibold">实时答案</span>
            <span className="ml-auto rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] text-emerald-400">
              {currentStreamingId ? '生成中' : '最新'}
            </span>
            {supportsPip && (
              <button
                type="button"
                onClick={() => {
                  if (pipActive) void exitPip()
                  else void enterPip()
                }}
                className="inline-flex h-7 items-center justify-center gap-1 rounded-md px-1.5 hover:bg-white/10"
                aria-label={pipActive ? '退出系统悬浮窗' : '打开系统悬浮窗'}
                title={pipActive ? '退出系统悬浮窗' : '打开系统悬浮窗'}
              >
                <PictureInPicture2 className="h-4 w-4" />
                <span className="text-[10px] font-medium">
                  {pipActive ? '返回浏览器' : '跨 App 悬浮'}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setOverlayEnabled(false)}
              className="inline-flex size-7 items-center justify-center rounded-md hover:bg-white/10"
              aria-label="关闭悬浮提示窗"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5" style={answerStyle}>
            {answer ? (
              <AnswerMarkdownContent answer={answer} colorScheme={colorScheme} stream={Boolean(currentStreamingId)} />
            ) : (
              <div className="py-8 text-center text-xs text-current/70">{fallbackText}</div>
            )}
          </div>
          {pipMessage && (
            <div className={`border-t px-3 py-1.5 text-[10px] leading-snug ${
              overlayMode === 'focus'
                ? 'border-slate-300 text-amber-700'
                : 'border-white/10 text-amber-300'
            }`}>
              {pipMessage}
            </div>
          )}
        </section>
      )}
      <canvas ref={canvasRef} width={720} height={1000} className="hidden" aria-hidden />
      <video
        ref={videoRef}
        className="pointer-events-none fixed h-px w-px opacity-0"
        autoPlay
        muted
        playsInline
        aria-hidden
      />
    </>
  )
}
