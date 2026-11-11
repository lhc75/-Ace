import { useState } from 'react'
import { AlertCircle, Mic, MicOff } from 'lucide-react'
import AnswerPanel from '@/components/AnswerPanel'
import ControlBar from '@/components/ControlBar'
import TranscriptionPanel from '@/components/TranscriptionPanel'
import MobileInterviewOverlay from '@/components/mobile/MobileInterviewOverlay'
import { useMobileAudioCapture } from '@/hooks/useMobileAudioCapture'
import { requestInterviewOverlayPip } from '@/lib/interviewOverlay'
import { useInterviewStore } from '@/stores/configStore'

function isMobileSurface(): boolean {
  const query = new URLSearchParams(window.location.search)
  if (query.get('mobile') === '1') return true
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 767px)').matches
    : false
}

export default function AIInterviewMode() {
  const [mobile] = useState(isMobileSurface)
  return mobile ? <MobileAIInterview /> : <DesktopAIInterview />
}

function DesktopAIInterview() {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ai-interview-mode">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="hidden w-[39%] min-w-[280px] max-w-[520px] flex-col border-r border-bg-tertiary md:flex">
          <TranscriptionPanel forceInterviewMode />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <AnswerPanel forceInterviewMode />
        </div>
      </div>
      <ControlBar forceInterviewMode />
    </div>
  )
}

function MobileAIInterview() {
  const capture = useMobileAudioCapture()
  const [tab, setTab] = useState<'transcript' | 'answer'>('answer')
  const isRecording = useInterviewStore((s) => s.isRecording)
  const isRecordingNow = capture.state === 'recording' || isRecording

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden" data-testid="ai-interview-mode">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-bg-tertiary px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${isRecordingNow ? 'bg-accent-red animate-pulse' : 'bg-text-muted/40'}`} />
            <span className="text-xs font-semibold">在线 AI 面试</span>
            <span className="rounded bg-bg-tertiary/70 px-1.5 py-0.5 text-[9px] text-text-muted">
              {capture.isSecure ? 'HTTPS 安全采集' : 'HTTP 仅查看'}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-text-muted">
            {isRecordingNow ? '正在采集手机麦克风中的面试官声音' : '开始后请让手机外放面试官声音，保持页面打开'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (isRecordingNow) void capture.stop()
            else {
              requestInterviewOverlayPip()
              void capture.start()
            }
          }}
          disabled={capture.state === 'starting' || capture.state === 'stopping'}
          className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white disabled:opacity-60 ${
            isRecordingNow ? 'bg-accent-red' : 'bg-accent-blue'
          }`}
        >
          {isRecordingNow ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {capture.state === 'starting' ? '连接中' : capture.state === 'stopping' ? '停止中' : isRecordingNow ? '停止' : '开始采集'}
        </button>
      </div>

      {capture.error && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-accent-red/25 bg-accent-red/8 px-3 py-2 text-[10px] leading-relaxed text-text-secondary">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-accent-red" />
          {capture.error}
        </div>
      )}

      {isRecordingNow && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-md bg-bg-secondary/60 px-3 py-1.5">
          <Mic className="h-3.5 w-3.5 text-accent-blue" />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
            <div
              className="h-full rounded-full bg-accent-blue transition-[width] duration-100"
              style={{ width: `${Math.min(100, capture.level * 1200)}%` }}
            />
          </div>
          <span className="text-[9px] text-text-muted">手机麦克风</span>
        </div>
      )}

      <div className="mt-2 flex flex-shrink-0 border-b border-bg-tertiary">
        <button
          type="button"
          onClick={() => setTab('transcript')}
          className={`flex-1 py-2 text-xs font-medium ${tab === 'transcript' ? 'border-b-2 border-accent-blue text-accent-blue' : 'text-text-muted'}`}
        >
          实时转录
        </button>
        <button
          type="button"
          onClick={() => setTab('answer')}
          className={`flex-1 py-2 text-xs font-medium ${tab === 'answer' ? 'border-b-2 border-accent-blue text-accent-blue' : 'text-text-muted'}`}
        >
          AI 回答
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'transcript'
          ? <TranscriptionPanel forceInterviewMode />
          : <AnswerPanel forceInterviewMode />}
      </div>

      <ControlBar forceInterviewMode />
      {!window.electronAPI && <MobileInterviewOverlay />}
    </div>
  )
}
