import { useState } from 'react'
import {
  AlertCircle,
  Briefcase,
  CheckCircle2,
  Eye,
  Layers,
  ListChecks,
  MessageSquare,
  Mic,
  MicOff,
  ShieldCheck,
  Smartphone,
  Target,
  Video,
  X,
} from 'lucide-react'
import AnswerMarkdownContent from '@/components/AnswerMarkdownContent'
import AnswerPanel from '@/components/AnswerPanel'
import ControlBar from '@/components/ControlBar'
import TranscriptionPanel from '@/components/TranscriptionPanel'
import { useMobileAudioCapture } from '@/hooks/useMobileAudioCapture'
import { useInterviewStore } from '@/stores/configStore'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

const SCORE_DIMENSIONS = [
  {
    title: '沟通表达',
    aiLooksAt: '条理清晰度、语言流畅度',
    howToShow: '用“第一、第二、第三”结构化表达',
    icon: MessageSquare,
  },
  {
    title: '逻辑思维',
    aiLooksAt: '观点有没有论证支撑',
    howToShow: '每个观点跟一个具体例子',
    icon: Layers,
  },
  {
    title: '岗位匹配',
    aiLooksAt: '回答是否命中 JD 关键词',
    howToShow: '提前从 JD 提炼关键词并主动带入',
    icon: Target,
  },
  {
    title: '动机稳定性',
    aiLooksAt: '求职动机是否真实可信',
    howToShow: '讲清“为什么选这家公司这个岗位”',
    icon: Briefcase,
  },
  {
    title: '情绪状态',
    aiLooksAt: '自信度、抗压表现',
    howToShow: '语速放缓、微笑、直视镜头',
    icon: ShieldCheck,
  },
] as const

const SELF_CHECK_ITEMS = [
  '开口 10 秒内给出结论',
  '使用“第一、第二、第三”组织表达',
  '结果里有具体数字',
  '主动带入至少 3 个 JD 关键词',
  '语速平稳，无口头禅',
  '眼神看镜头不少于 80%',
  '全程在时限内完成',
] as const

const ANSWER_RULES = [
  {
    title: '自我介绍',
    rule: '标签开场 → 两段匹配经历 → 一句动机收尾',
    detail: '准备 60 秒和 90 秒两版，不复述完整简历。',
  },
  {
    title: '行为经历',
    rule: 'S 情境 → T 任务 → A 行动 → R 结果',
    detail: '结果必须有数字；失败题要讲学到什么、后来怎么改。',
  },
  {
    title: '情景与动机',
    rule: '稳住局面 → 找原因 → 给方案',
    detail: '动机必须带入公司具体业务关键词，空话会直接低分。',
  },
] as const

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
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-bg-tertiary bg-bg-secondary/55 px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded bg-accent-green/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-accent-green">
                Live AI Interview
              </span>
              <h1 className="truncate text-sm font-semibold">在线 AI 面试辅助</h1>
            </div>
            <p className="mt-1 text-[10px] text-text-muted">
              手机采集外放声音，电脑实时转写并生成结构化回答；两端内容实时同步。
            </p>
          </div>
          <div className="hidden items-center gap-2 text-[10px] text-text-muted xl:flex">
            <Smartphone className="h-3.5 w-3.5 text-accent-green" />
            手机负责收音，电脑负责显示
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="hidden w-[39%] min-w-[280px] max-w-[520px] flex-col border-r border-bg-tertiary md:flex">
            <TranscriptionPanel forceInterviewMode />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <AnswerPanel forceInterviewMode />
          </div>
        </div>
        <ControlBar forceInterviewMode />
      </div>
      <InsightSidebar />
    </div>
  )
}

function MobileAIInterview() {
  const capture = useMobileAudioCapture()
  const [tab, setTab] = useState<'transcript' | 'answer'>('answer')
  const [overlayOpen, setOverlayOpen] = useState(false)
  const isRecording = useInterviewStore((s) => s.isRecording)
  const isRecordingNow = capture.state === 'recording' || isRecording

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
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
            else void capture.start()
          }}
          disabled={capture.state === 'starting' || capture.state === 'stopping'}
          className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white disabled:opacity-60 ${
            isRecordingNow ? 'bg-accent-red' : 'bg-accent-green'
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
          <Mic className="h-3.5 w-3.5 text-accent-green" />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
            <div
              className="h-full rounded-full bg-accent-green transition-[width] duration-100"
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
          className={`flex-1 py-2 text-xs font-medium ${tab === 'transcript' ? 'border-b-2 border-accent-green text-accent-green' : 'text-text-muted'}`}
        >
          实时转录
        </button>
        <button
          type="button"
          onClick={() => setTab('answer')}
          className={`flex-1 py-2 text-xs font-medium ${tab === 'answer' ? 'border-b-2 border-accent-green text-accent-green' : 'text-text-muted'}`}
        >
          AI 回答
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'transcript'
          ? <TranscriptionPanel forceInterviewMode />
          : <AnswerPanel forceInterviewMode />}
      </div>

      <button
        type="button"
        onClick={() => setOverlayOpen(true)}
        className="fixed bottom-20 right-4 z-30 inline-flex min-h-[42px] items-center gap-2 rounded-full border border-accent-green/35 bg-accent-green/90 px-4 text-xs font-semibold text-white shadow-xl backdrop-blur"
      >
        <Eye className="h-4 w-4" />
        悬浮答案
      </button>

      {overlayOpen && <MobileFloatingAnswer onClose={() => setOverlayOpen(false)} />}
    </div>
  )
}

function MobileFloatingAnswer({ onClose }: { onClose: () => void }) {
  const qaPairs = useInterviewStore((s) => s.qaPairs)
  const currentStreamingId = useInterviewStore((s) => s.currentStreamingId)
  const colorScheme = useUiPrefsStore((s) => s.colorScheme)
  const latest = qaPairs[qaPairs.length - 1]
  const streaming = qaPairs.find((qa) => qa.id === currentStreamingId)
  const answer = streaming?.answer || latest?.answer || ''
  const question = streaming?.question || latest?.question || ''

  return (
    <div className="fixed inset-x-3 top-32 z-40 flex max-h-[52vh] flex-col overflow-hidden rounded-xl border border-accent-green/35 bg-bg-secondary/88 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center gap-2 border-b border-bg-tertiary px-3 py-2">
        <Eye className="h-3.5 w-3.5 text-accent-green" />
        <span className="text-xs font-semibold">实时答案</span>
        <span className="ml-auto rounded bg-accent-green/10 px-1.5 py-0.5 text-[9px] text-accent-green">
          {streaming ? '生成中' : '最新'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary"
          aria-label="关闭悬浮答案"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto px-3 py-2">
        {question && (
          <p className="mb-2 border-l-2 border-accent-green/40 pl-2 text-[10px] leading-relaxed text-text-muted">
            {question}
          </p>
        )}
        {answer ? (
          <AnswerMarkdownContent answer={answer} colorScheme={colorScheme} stream={Boolean(streaming)} />
        ) : (
          <div className="py-8 text-center text-xs text-text-muted">等待面试官问题或 AI 回答…</div>
        )}
      </div>
    </div>
  )
}

function InsightSidebar() {
  return (
    <aside className="hidden min-h-0 w-[330px] flex-shrink-0 overflow-y-auto border-l border-bg-tertiary bg-bg-secondary/30 xl:block">
      <section className="p-4">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-accent-green" />
          <h2 className="text-sm font-semibold">AI 在看什么</h2>
          <span className="ml-auto text-[9px] font-mono text-text-muted">5 DIMENSIONS</span>
        </div>
        <div className="mt-3 divide-y divide-bg-tertiary">
          {SCORE_DIMENSIONS.map((dimension) => {
            const Icon = dimension.icon
            return (
              <div key={dimension.title} className="py-2.5 first:pt-0">
                <div className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-accent-green" />
                  <span className="text-xs font-semibold">{dimension.title}</span>
                </div>
                <p className="mt-1 pl-5 text-[10px] leading-relaxed text-text-muted">{dimension.aiLooksAt}</p>
                <p className="mt-0.5 pl-5 text-[10px] leading-relaxed text-text-secondary">
                  怎么呈现：{dimension.howToShow}
                </p>
              </div>
            )
          })}
        </div>
      </section>

      <section className="border-t border-bg-tertiary p-4">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-accent-green" />
          <h2 className="text-sm font-semibold">回答格式</h2>
        </div>
        <div className="mt-3 space-y-3">
          {ANSWER_RULES.map((item) => (
            <div key={item.title}>
              <p className="text-[11px] font-semibold text-text-primary">{item.title}</p>
              <p className="mt-1 text-[10px] leading-relaxed text-accent-green">{item.rule}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-bg-tertiary p-4">
        <div className="flex items-center gap-2">
          <Video className="h-4 w-4 text-accent-green" />
          <h2 className="text-sm font-semibold">AI 视角自检</h2>
        </div>
        <ul className="mt-3 space-y-2">
          {SELF_CHECK_ITEMS.map((item) => (
            <li key={item} className="flex items-start gap-2 text-[10px] leading-relaxed text-text-secondary">
              <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-accent-green/70" />
              {item}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}
