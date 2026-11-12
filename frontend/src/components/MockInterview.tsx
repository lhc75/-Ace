import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  FileText,
  History,
  Loader2,
  Mic,
  MicOff,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Trophy,
  UserRound,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useShallow } from 'zustand/react/shallow'

import { ResumeMountPanel } from '@/components/resume/ResumeMount'
import { useMockInterviewAudio } from '@/hooks/useMockInterviewAudio'
import { getErrorMessage } from '@/lib/api'
import { mockInterviewAPI } from '@/lib/mockInterviewAPI'
import { useInterviewStore } from '@/stores/configStore'
import type {
  CreateMockInterviewRequest,
  MockInterviewQuestion,
  MockInterviewSession,
  MockQuestionCategory,
} from '@/types/mock-interview'

const CATEGORY_META: Record<MockQuestionCategory, { label: string; tone: string }> = {
  resume_project: { label: '简历深挖', tone: 'border-accent-blue/25 bg-accent-blue/8 text-accent-blue' },
  technical: { label: '专业技术', tone: 'border-accent-green/25 bg-accent-green/8 text-accent-green' },
  behavioral: { label: '行为协作', tone: 'border-accent-amber/25 bg-accent-amber/8 text-accent-amber' },
  scenario: { label: '情景应变', tone: 'border-accent-red/25 bg-accent-red/8 text-accent-red' },
  motivation: { label: '动机匹配', tone: 'border-accent-blue/25 bg-accent-blue/8 text-accent-blue' },
}

const STATUS_LABEL: Record<string, string> = {
  in_progress: '进行中',
  ready_to_finish: '待生成报告',
  completed: '已完成',
  failed: '生成失败',
}

const SELF_TAGS = ['节奏合适', '题目有挑战', '紧张但投入', '表达不够顺畅', '还需要更多练习', '体验很好']

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSeconds(total: number): string {
  const safe = Math.max(0, Math.ceil(total))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

export function appendTranscript(current: string, segment: string): string {
  const next = segment.trim()
  if (!next) return current
  const text = current.trimEnd()
  if (!text) return next
  if (text.endsWith(next)) return text
  const needsSpace = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(next)
  return `${text}${needsSpace ? ' ' : ''}${next}`
}

function scoreTone(score: number): string {
  if (score >= 85) return 'text-accent-green'
  if (score >= 70) return 'text-accent-blue'
  if (score >= 60) return 'text-accent-amber'
  return 'text-accent-red'
}

function SessionRow({
  session,
  onOpen,
  onDelete,
}: {
  session: MockInterviewSession
  onOpen: () => void
  onDelete: () => void
}) {
  const active = session.status === 'in_progress' || session.status === 'ready_to_finish'
  return (
    <div className="group rounded-xl border border-bg-hover/50 bg-bg-secondary/55 p-3 transition-colors hover:border-accent-blue/35">
      <div className="flex items-start gap-3">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">
              {session.company ? `${session.company} · ` : ''}{session.position}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${
              active ? 'bg-accent-blue/10 text-accent-blue' : 'bg-bg-tertiary text-text-muted'
            }`}>
              {STATUS_LABEL[session.status] || session.status}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-muted">
            {formatDateTime(session.created_at)} · 主问题 {session.main_answered_count}/{session.main_question_target}
            {session.total_score != null ? ` · ${Math.round(session.total_score)} 分` : ''}
          </p>
        </button>
        <div className="flex items-center gap-1">
          <span className={`sd-num text-lg font-black ${scoreTone(session.total_score || 0)}`}>
            {session.total_score != null ? Math.round(session.total_score) : active ? '···' : '—'}
          </span>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-2 text-text-muted opacity-70 hover:bg-accent-red/10 hover:text-accent-red group-hover:opacity-100"
            aria-label="删除模拟面试记录"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function SetupView({
  sessions,
  creating,
  error,
  onStart,
  onOpen,
  onDelete,
}: {
  sessions: MockInterviewSession[]
  creating: boolean
  error: string | null
  onStart: (payload: CreateMockInterviewRequest) => void
  onOpen: (id: number) => void
  onDelete: (session: MockInterviewSession) => void
}) {
  const { config } = useInterviewStore(useShallow((s) => ({ config: s.config })))
  const [position, setPosition] = useState(config?.position || '后端开发')
  const [company, setCompany] = useState('')
  const [jd, setJd] = useState('')
  const [difficulty, setDifficulty] = useState<CreateMockInterviewRequest['difficulty']>('medium')
  const [focus, setFocus] = useState<CreateMockInterviewRequest['focus']>('balanced')

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
        <section className="deck-panel overflow-hidden">
          <div className="border-b border-bg-hover/50 bg-bg-secondary px-4 py-4 md:px-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">
                MOCK-02 · INTERVIEW
              </span>
              <h2 className="text-sm font-semibold text-text-primary md:text-base">AI 模拟面试</h2>
            </div>
            <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-text-muted">
              10 个主问题，每个最多 3 次追问。AI 根据简历出题，也混合技术、行为、情景和动机问题。
              每道题先思考 15 秒，再进入回答倒计时。
            </p>
          </div>
          <div className="grid gap-4 p-4 md:grid-cols-[1.15fr_.85fr] md:p-5">
            <div className="space-y-4">
              <ResumeMountPanel
                title="简历素材"
                description="有简历时优先深挖项目；未挂载简历时会自动切换到岗位随机题。"
                historyMode="popover"
                sharedNote="模拟面试只保存创建时的简历文字快照，不保存音频。"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs text-text-secondary">
                  <span className="font-medium">目标岗位</span>
                  <input
                    value={position}
                    onChange={(event) => setPosition(event.target.value)}
                    className="w-full rounded-lg border border-bg-hover/60 bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent-blue"
                    placeholder="例如：Java 后端开发"
                  />
                </label>
                <label className="space-y-1.5 text-xs text-text-secondary">
                  <span className="font-medium">目标公司（可选）</span>
                  <input
                    value={company}
                    onChange={(event) => setCompany(event.target.value)}
                    className="w-full rounded-lg border border-bg-hover/60 bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent-blue"
                    placeholder="例如：字节跳动"
                  />
                </label>
                <label className="space-y-1.5 text-xs text-text-secondary">
                  <span className="font-medium">难度</span>
                  <select
                    value={difficulty}
                    onChange={(event) => setDifficulty(event.target.value as CreateMockInterviewRequest['difficulty'])}
                    className="w-full rounded-lg border border-bg-hover/60 bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent-blue"
                  >
                    <option value="easy">基础</option>
                    <option value="medium">标准</option>
                    <option value="hard">进阶</option>
                  </select>
                </label>
                <label className="space-y-1.5 text-xs text-text-secondary">
                  <span className="font-medium">侧重点</span>
                  <select
                    value={focus}
                    onChange={(event) => setFocus(event.target.value as CreateMockInterviewRequest['focus'])}
                    className="w-full rounded-lg border border-bg-hover/60 bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent-blue"
                  >
                    <option value="balanced">技术与综合均衡</option>
                    <option value="technical">技术强化</option>
                    <option value="comprehensive">综合强化</option>
                  </select>
                </label>
              </div>
              <label className="block space-y-1.5 text-xs text-text-secondary">
                <span className="font-medium">目标 JD（可选，用于提高题目匹配度）</span>
                <textarea
                  value={jd}
                  onChange={(event) => setJd(event.target.value)}
                  rows={4}
                  className="w-full resize-y rounded-lg border border-bg-hover/60 bg-bg-primary px-3 py-2.5 text-sm leading-relaxed text-text-primary outline-none focus:border-accent-blue"
                  placeholder="粘贴岗位职责和任职要求…"
                />
              </label>
              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-accent-red/20 bg-accent-red/8 px-3 py-2 text-xs text-accent-red">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <button
                type="button"
                disabled={creating || !position.trim()}
                onClick={() => onStart({
                  position: position.trim(),
                  company: company.trim(),
                  job_description: jd.trim(),
                  difficulty,
                  focus,
                })}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent-blue px-4 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {creating ? 'AI 正在生成 10 道主问题…' : '开始 AI 模拟面试'}
              </button>
            </div>

            <aside className="space-y-3">
              <div className="rounded-xl border border-bg-hover/50 bg-bg-primary/45 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <ShieldCheck className="h-4 w-4 text-accent-green" />
                  面试规则
                </div>
                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-text-secondary">
                  <li>· 面试官问题只显示纯文本，不播放语音。</li>
                  <li>· 每题 15 秒思考，随后自动开始录音和回答倒计时。</li>
                  <li>· 语音会分段拼接成可编辑文字；发送前可自行修改。</li>
                  <li>· 倒计时结束自动提交；也可提前点击发送。</li>
                  <li>· 每题回答完才进入追问或下一题。</li>
                  <li>· 只保存文字、评分和报告，不保存音频。</li>
                </ul>
              </div>
              <div className="rounded-xl border border-bg-hover/50 bg-bg-secondary/55 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                    <History className="h-4 w-4 text-accent-blue" />
                    最近记录
                  </div>
                  <span className="text-[10px] text-text-muted">{sessions.length} 场</span>
                </div>
                <div className="mt-3 max-h-[310px] space-y-2 overflow-y-auto pr-1">
                  {sessions.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-bg-hover/60 px-3 py-7 text-center text-xs text-text-muted">
                      还没有模拟面试记录
                    </p>
                  ) : sessions.slice(0, 8).map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      onOpen={() => onOpen(session.id)}
                      onDelete={() => onDelete(session)}
                    />
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </div>
  )
}

function ConversationItem({ question }: { question: MockInterviewQuestion }) {
  const meta = CATEGORY_META[question.category] || CATEGORY_META.technical
  const answered = question.phase === 'evaluated' || question.phase === 'submitted_pending_eval'
  return (
    <article className={`space-y-2 ${question.kind === 'followup' ? 'ml-4 border-l border-accent-amber/25 pl-3 md:ml-7' : ''}`}>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent-blue/10 text-accent-blue">
          <BrainCircuit className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1 rounded-xl border border-bg-hover/55 bg-bg-secondary/65 px-3.5 py-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-medium ${meta.tone}`}>{meta.label}</span>
            {question.kind === 'followup' && <span className="text-[10px] text-accent-amber">追问</span>}
            <span className="text-[10px] text-text-muted">主问题 {question.main_index}/10</span>
          </div>
          <p className="text-sm leading-relaxed text-text-primary">{question.question_text}</p>
        </div>
      </div>
      {answered && (
        <div className="ml-9 flex items-start gap-2.5">
          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-text-muted">
            <UserRound className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1 rounded-xl border border-bg-hover/35 bg-bg-primary/55 px-3.5 py-3 text-sm leading-relaxed text-text-secondary whitespace-pre-wrap">
            {question.answer_text || '（未作答）'}
            {question.phase === 'submitted_pending_eval' && (
              <span className="mt-2 flex items-center gap-1.5 text-[10px] text-accent-amber">
                <Loader2 className="h-3 w-3 animate-spin" /> AI 正在评分并决定下一题
              </span>
            )}
          </div>
        </div>
      )}
    </article>
  )
}

function InterviewView({
  session,
  answerText,
  setAnswerText,
  submitting,
  finishing,
  error,
  onStartAnswer,
  onSubmit,
  onFinish,
  onBack,
  onReload,
}: {
  session: MockInterviewSession
  answerText: string
  setAnswerText: (value: string) => void
  submitting: boolean
  finishing: boolean
  error: string | null
  onStartAnswer: () => void
  onSubmit: (autoSubmitted: boolean) => void
  onFinish: () => void
  onBack: () => void
  onReload: () => void
}) {
  const [clock, setClock] = useState(() => Date.now() / 1000)
  const startGuardRef = useRef('')
  const autoSubmitGuardRef = useRef('')
  const question = session.current_question
  const answerRef = useRef(answerText)
  answerRef.current = answerText

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now() / 1000), 250)
    return () => window.clearInterval(timer)
  }, [])

  const onSegment = useCallback((text: string) => {
    const next = appendTranscript(answerRef.current, text)
    answerRef.current = next
    setAnswerText(next)
  }, [setAnswerText])

  const audio = useMockInterviewAudio({
    active: question?.phase === 'answering' && !submitting,
    sessionId: session.id,
    questionId: question?.id || null,
    onSegment,
  })

  const prepRemaining = question?.phase === 'thinking' && question.prep_started_at
    ? Math.max(0, question.prep_started_at + question.prep_seconds - clock)
    : 0
  const answerRemaining = question?.phase === 'answering' && question.answer_deadline_at
    ? Math.max(0, question.answer_deadline_at - clock)
    : question?.answer_time_limit_seconds || 0

  useEffect(() => {
    if (!question || question.phase !== 'thinking' || prepRemaining > 0) return
    if (startGuardRef.current === question.id) return
    startGuardRef.current = question.id
    onStartAnswer()
  }, [onStartAnswer, prepRemaining, question])

  useEffect(() => {
    if (!question || question.phase !== 'answering' || answerRemaining > 0) return
    if (autoSubmitGuardRef.current === question.id) return
    autoSubmitGuardRef.current = question.id
    void audio.stopAndFlush().then(() => onSubmit(true))
  }, [answerRemaining, audio, onSubmit, question])

  const phaseLabel = question?.phase === 'thinking'
    ? '思考中'
    : question?.phase === 'answering'
      ? '回答中'
      : question?.phase === 'submitted_pending_eval'
        ? 'AI 评分中'
        : '准备下一题'
  const timerValue = question?.phase === 'thinking' ? prepRemaining : answerRemaining
  const totalForRing = question?.phase === 'thinking'
    ? Math.max(1, question.prep_seconds)
    : Math.max(1, question?.answer_time_limit_seconds || 1)
  const progressPct = Math.max(0, Math.min(100, (timerValue / totalForRing) * 100))
  const canSubmit = answerText.trim().length > 0
    && !submitting
    && !finishing
    && (question?.phase === 'answering' || question?.phase === 'submitted_pending_eval')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-bg-tertiary px-4 py-3">
        <button type="button" onClick={onBack} className="rounded-lg p-2 text-text-muted hover:bg-bg-hover/50 hover:text-text-primary" aria-label="返回模拟面试列表">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-text-primary">
              {session.company ? `${session.company} · ` : ''}{session.position} AI 模拟面试
            </h2>
            <span className="rounded-full bg-accent-blue/10 px-2 py-0.5 text-[9px] text-accent-blue">
              {STATUS_LABEL[session.status] || session.status}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-text-muted">
            {session.has_resume ? `简历：${session.resume_filename || '已挂载'}` : '无简历 · 岗位随机题'} · 模型：{session.model_name || '当前模型'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void audio.stopAndFlush().then(onFinish)}
          disabled={finishing || session.answered_count === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-bg-hover/70 px-3 py-2 text-xs text-text-secondary hover:border-accent-red/30 hover:bg-accent-red/8 hover:text-accent-red disabled:opacity-40"
        >
          {finishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleStop className="h-3.5 w-3.5" />}
          结束面试
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto max-w-3xl space-y-4">
              {session.questions.map((item) => <ConversationItem key={item.id} question={item} />)}
              {question?.phase === 'thinking' && (
                <div className="rounded-xl border border-accent-amber/25 bg-accent-amber/8 px-4 py-3 text-xs text-accent-amber">
                  你有 15 秒读题和思考时间，倒计时结束后会自动开始录音。
                </div>
              )}
              {session.error_message && (
                <div className="flex items-start gap-2 rounded-xl border border-accent-red/20 bg-accent-red/8 px-4 py-3 text-xs text-accent-red">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div className="flex-1">
                    <p>{session.error_message}</p>
                    <button type="button" onClick={onReload} className="mt-2 inline-flex items-center gap-1 font-medium underline underline-offset-2">
                      <RefreshCw className="h-3 w-3" /> 重新加载会话
                    </button>
                  </div>
                </div>
              )}
              {session.status === 'ready_to_finish' && (
                <div className="rounded-xl border border-accent-blue/25 bg-accent-blue/8 px-4 py-4 text-center">
                  <CheckCircle2 className="mx-auto h-7 w-7 text-accent-blue" />
                  <p className="mt-2 text-sm font-semibold text-text-primary">10 个主问题已完成</p>
                  <p className="mt-1 text-xs text-text-muted">{finishing ? '正在生成完整诊断报告…' : '报告生成失败，可点击“结束面试”重试。'}</p>
                </div>
              )}
            </div>
          </div>

          <div className="flex-shrink-0 border-t border-bg-tertiary bg-bg-secondary/80 p-3 md:p-4">
            <div className="mx-auto max-w-3xl">
              {error && (
                <div className="mb-2 flex items-start gap-2 rounded-lg border border-accent-red/20 bg-accent-red/8 px-3 py-2 text-xs text-accent-red">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {audio.error && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent-amber/20 bg-accent-amber/8 px-3 py-2 text-xs text-accent-amber">
                  <MicOff className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="flex-1">{audio.error}</span>
                  <button type="button" onClick={() => void audio.start()} className="font-medium underline underline-offset-2">重试麦克风</button>
                </div>
              )}
              <div className="rounded-xl border border-bg-hover/60 bg-bg-primary shadow-sm focus-within:border-accent-blue/55">
                <textarea
                  value={answerText}
                  onChange={(event) => setAnswerText(event.target.value)}
                  disabled={!question || question.phase === 'submitted_pending_eval' || submitting}
                  rows={5}
                  data-testid="mock-answer-input"
                  placeholder={question?.phase === 'thinking'
                    ? '可以先整理思路，15 秒后开始录音…'
                    : '语音识别结果会追加到这里，也可以直接修改或输入…'}
                  className="w-full resize-none rounded-t-xl bg-transparent px-4 py-3 text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-muted disabled:opacity-60"
                />
                <div className="flex flex-wrap items-center gap-2 border-t border-bg-tertiary px-3 py-2">
                  <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] ${
                    audio.state === 'recording'
                      ? 'bg-accent-red/10 text-accent-red'
                      : audio.state === 'starting'
                        ? 'bg-accent-blue/10 text-accent-blue'
                        : 'bg-bg-tertiary text-text-muted'
                  }`}>
                    {audio.state === 'recording' ? <Mic className="h-3 w-3 animate-pulse" /> : <MicOff className="h-3 w-3" />}
                    {audio.state === 'recording' ? '正在听你回答' : audio.state === 'starting' ? '连接麦克风' : audio.state === 'error' ? '麦克风异常' : '未录音'}
                    {audio.transcribing && <span className="text-accent-blue">· 转写中</span>}
                  </div>
                  <span className="text-[10px] text-text-muted">文字可编辑，点击发送后才会进入下一题</span>
                  <span className="ml-auto text-[10px] text-text-muted">{answerText.trim().length} 字</span>
                  <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => void audio.stopAndFlush().then(() => onSubmit(false))}
                    className="ml-1 inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-accent-blue px-3 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    {submitting ? '评分中' : question?.phase === 'submitted_pending_eval' ? '重试评分' : '发送'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="w-full flex-shrink-0 border-t border-bg-tertiary bg-bg-primary/55 p-4 md:w-[300px] md:border-l md:border-t-0">
          <div className="space-y-4">
            <div className="rounded-2xl border border-bg-hover/50 bg-bg-secondary/60 p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted">当前阶段</span>
                <span className={`text-xs font-semibold ${
                  question?.phase === 'thinking' ? 'text-accent-amber' : question?.phase === 'answering' ? 'text-accent-red' : 'text-accent-blue'
                }`}>{phaseLabel}</span>
              </div>
              <div className="relative mx-auto mt-4 flex h-36 w-36 items-center justify-center rounded-full"
                style={{ background: `conic-gradient(rgb(var(--accent-blue)) ${progressPct}%, rgba(148,163,184,.13) 0)` }}>
                <div className="flex h-[118px] w-[118px] flex-col items-center justify-center rounded-full bg-bg-secondary">
                  <Clock3 className="mb-1 h-4 w-4 text-text-muted" />
                  <span className="sd-num text-3xl font-black text-text-primary">{formatSeconds(timerValue)}</span>
                  <span className="mt-1 text-[9px] text-text-muted">
                    {question?.phase === 'thinking' ? '思考倒计时' : '回答倒计时'}
                  </span>
                </div>
              </div>
              {question?.phase === 'thinking' && (
                <button type="button" onClick={onStartAnswer} className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent-amber/25 bg-accent-amber/8 px-3 py-2 text-xs font-medium text-accent-amber">
                  <Play className="h-3.5 w-3.5" /> 提前开始回答
                </button>
              )}
              {question?.phase === 'answering' && (
                <div className="mt-4 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                    <div className="h-full rounded-full bg-accent-blue transition-[width] duration-100" style={{ width: `${Math.min(100, audio.level * 1200)}%` }} />
                  </div>
                  <span className="text-[9px] text-text-muted">麦克风</span>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-bg-hover/50 bg-bg-secondary/55 p-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">面试进度</p>
              <div className="mt-2 flex items-end justify-between">
                <span className="sd-num text-2xl font-black text-text-primary">{Math.min(10, session.main_index)}<span className="text-sm text-text-muted">/10</span></span>
                <span className="text-[10px] text-text-muted">主问题</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                <div className="h-full rounded-full bg-accent-green" style={{ width: `${Math.min(100, (session.main_answered_count / 10) * 100)}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-bg-primary/60 px-2 py-2">
                  <p className="sd-num text-base font-bold text-text-primary">{session.answered_count}</p>
                  <p className="text-[9px] text-text-muted">已答问题</p>
                </div>
                <div className="rounded-lg bg-bg-primary/60 px-2 py-2">
                  <p className="sd-num text-base font-bold text-text-primary">{question?.main_index != null ? Math.min(3, session.questions.filter((q) => q.kind === 'followup' && q.main_index === question.main_index).length) : 0}</p>
                  <p className="text-[9px] text-text-muted">本题追问</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-bg-hover/50 bg-bg-primary/45 p-3 text-[11px] leading-relaxed text-text-muted">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-text-secondary">
                <FileText className="h-3.5 w-3.5" /> 回答建议
              </div>
              先给结论，再用 2–3 个要点展开；项目题说明你的动作、取舍和结果，不必复述整份简历。
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function ReportView({
  session,
  onBack,
  onDelete,
  onSelfAssessment,
}: {
  session: MockInterviewSession
  onBack: () => void
  onDelete: () => void
  onSelfAssessment: (rating: number, note: string, tags: string[]) => Promise<void>
}) {
  const report = session.report
  const [rating, setRating] = useState(session.self_rating || 0)
  const [note, setNote] = useState(session.self_note || '')
  const [tags, setTags] = useState<string[]>(session.self_tags || [])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(Boolean(session.self_rating))

  if (!report) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-accent-red/20 bg-accent-red/8 p-6 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-accent-red" />
          <h2 className="mt-3 text-base font-semibold text-text-primary">报告尚未生成</h2>
          <p className="mt-2 text-xs text-text-muted">{session.error_message || '请返回后重新进入会话生成报告。'}</p>
          <button type="button" onClick={onBack} className="mt-4 rounded-lg bg-accent-blue px-4 py-2 text-xs font-medium text-white">返回列表</button>
        </div>
      </div>
    )
  }

  const toggleTag = (tag: string) => {
    setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag].slice(0, 8))
    setSaved(false)
  }

  const save = async () => {
    if (rating < 1) return
    setSaving(true)
    try {
      await onSelfAssessment(rating, note.trim(), tags)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="rounded-lg p-2 text-text-muted hover:bg-bg-hover/50 hover:text-text-primary" aria-label="返回模拟面试列表">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold text-text-primary">模拟面试诊断报告</h2>
            <p className="text-xs text-text-muted">{session.company ? `${session.company} · ` : ''}{session.position} · {formatDateTime(session.completed_at || session.updated_at)}</p>
          </div>
          <button type="button" onClick={onDelete} className="inline-flex items-center gap-1.5 rounded-lg border border-accent-red/20 px-3 py-2 text-xs text-accent-red hover:bg-accent-red/8">
            <Trash2 className="h-3.5 w-3.5" /> 删除
          </button>
        </div>

        <section className="overflow-hidden rounded-2xl border border-bg-hover/55 bg-bg-secondary/60">
          <div className="grid gap-4 p-5 md:grid-cols-[200px_1fr] md:p-6">
            <div className="flex flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-accent-blue/15 to-accent-green/10 p-5 text-center">
              <Trophy className="h-6 w-6 text-accent-blue" />
              <p className={`sd-num mt-2 text-6xl font-black ${scoreTone(report.total_score)}`}>{Math.round(report.total_score)}</p>
              <p className="mt-1 text-xs text-text-muted">综合得分 / 100</p>
              <span className="mt-3 rounded-full bg-bg-primary/55 px-3 py-1 text-[10px] text-text-secondary">
                完成 {report.answered_count} 个问题
              </span>
            </div>
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Sparkles className="h-4 w-4 text-accent-blue" /> 能力维度
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {report.dimensions.map((dimension) => (
                  <div key={dimension.key}>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-text-secondary">{dimension.label}</span>
                      <span className={`sd-num font-bold ${scoreTone(dimension.score)}`}>{Math.round(dimension.score)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                      <div className="h-full rounded-full bg-accent-blue" style={{ width: `${dimension.score}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
          <section className="rounded-2xl border border-bg-hover/55 bg-bg-secondary/55 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><BrainCircuit className="h-4 w-4 text-accent-blue" /> 整体评价</h3>
            <div className="prose prose-sm mt-3 max-w-none text-text-secondary prose-headings:text-text-primary prose-strong:text-text-primary prose-li:my-1">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.summary_markdown || '暂无总结'}</ReactMarkdown>
            </div>
          </section>
          <div className="space-y-4">
            <section className="rounded-2xl border border-accent-green/20 bg-accent-green/6 p-5">
              <h3 className="text-sm font-semibold text-accent-green">亮点</h3>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-text-secondary">
                {report.strengths.map((item) => <li key={item}>· {item}</li>)}
              </ul>
            </section>
            <section className="rounded-2xl border border-accent-amber/20 bg-accent-amber/6 p-5">
              <h3 className="text-sm font-semibold text-accent-amber">改进方向</h3>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-text-secondary">
                {report.improvements.map((item) => <li key={item}>· {item}</li>)}
              </ul>
            </section>
          </div>
        </div>

        <section className="rounded-2xl border border-bg-hover/55 bg-bg-secondary/55 p-5">
          <h3 className="text-sm font-semibold text-text-primary">逐题复盘</h3>
          <div className="mt-3 space-y-2">
            {report.question_reviews.map((item, index) => (
              <details key={item.question_id || `${index}`} className="group rounded-xl border border-bg-hover/45 bg-bg-primary/45">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-[10px] font-bold text-text-secondary">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{item.question}</span>
                  <span className={`sd-num text-sm font-bold ${scoreTone(item.score)}`}>{Math.round(item.score)}</span>
                  <ChevronDown className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-bg-hover/40 px-4 py-3 text-xs leading-relaxed text-text-secondary">
                  <p className="text-text-muted">你的回答</p>
                  <p className="mt-1 whitespace-pre-wrap">{item.answer || '（未作答）'}</p>
                  {item.improvement && <p className="mt-3 rounded-lg bg-accent-blue/8 px-3 py-2 text-accent-blue">改进：{item.improvement}</p>}
                </div>
              </details>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-accent-blue/20 bg-accent-blue/6 p-5">
          <h3 className="text-sm font-semibold text-text-primary">下一轮练习计划</h3>
          <ol className="mt-3 grid gap-2 text-xs leading-relaxed text-text-secondary sm:grid-cols-2">
            {report.next_practice_plan.map((item, index) => <li key={item} className="rounded-lg bg-bg-primary/45 px-3 py-2">{index + 1}. {item}</li>)}
          </ol>
        </section>

        <section className="rounded-2xl border border-bg-hover/55 bg-bg-secondary/55 p-5" data-testid="mock-self-assessment">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">这场面试你的感觉怎么样？</h3>
              <p className="mt-1 text-[11px] text-text-muted">你的主观感受会和 AI 评分一起保存，帮助对比真实体验。</p>
            </div>
            {saved && <span className="inline-flex items-center gap-1 text-[10px] text-accent-green"><CheckCircle2 className="h-3 w-3" /> 已保存</span>}
          </div>
          <div className="mt-4 flex gap-1">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => { setRating(value); setSaved(false) }}
                className={`rounded-lg p-2 transition-colors ${value <= rating ? 'text-accent-amber' : 'text-text-muted hover:text-accent-amber'}`}
                aria-label={`${value} 星`}
              >
                <Star className={`h-6 w-6 ${value <= rating ? 'fill-current' : ''}`} />
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {SELF_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={`rounded-full border px-3 py-1.5 text-[10px] ${
                  tags.includes(tag)
                    ? 'border-accent-blue/30 bg-accent-blue/10 text-accent-blue'
                    : 'border-bg-hover/60 text-text-muted hover:text-text-secondary'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(event) => { setNote(event.target.value); setSaved(false) }}
            rows={3}
            className="mt-3 w-full resize-y rounded-lg border border-bg-hover/60 bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-primary outline-none focus:border-accent-blue"
            placeholder="补充一点你这场面试的真实感受（可选）…"
          />
          <button
            type="button"
            disabled={rating < 1 || saving}
            onClick={() => void save()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent-blue px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            保存我的感受
          </button>
        </section>
      </div>
    </div>
  )
}

export default function MockInterview() {
  const [sessions, setSessions] = useState<MockInterviewSession[]>([])
  const [current, setCurrent] = useState<MockInterviewSession | null>(null)
  const [answerText, setAnswerTextState] = useState('')
  const answerRef = useRef('')
  const currentQuestionIdRef = useRef('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const finishGuardRef = useRef<number | null>(null)

  const setAnswerText = useCallback((value: string) => {
    answerRef.current = value
    setAnswerTextState(value)
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      const result = await mockInterviewAPI.listSessions()
      setSessions(result.items)
      return result.items
    } catch (err) {
      setError(getErrorMessage(err, '加载模拟面试记录失败'))
      return []
    }
  }, [])

  const {
    config,
    setToastMessage,
  } = useInterviewStore(useShallow((s) => ({
    config: s.config,
    setToastMessage: s.setToastMessage,
  })))

  useEffect(() => {
    let mounted = true
    void (async () => {
      const items = await refreshSessions()
      if (!mounted) return
      const resumable = items.find((item) => item.status === 'in_progress' || item.status === 'ready_to_finish')
      if (resumable) {
        try {
          const detail = await mockInterviewAPI.getSession(resumable.id)
          if (mounted) setCurrent(detail)
        } catch {
          /* keep list visible */
        }
      }
      if (mounted) setLoading(false)
    })()
    return () => { mounted = false }
  }, [refreshSessions])

  const question = current?.current_question || null
  const questionKey = question ? `${current?.id}:${question.id}:${question.phase}` : current ? `${current.id}:${current.status}` : ''

  useEffect(() => {
    const qid = question?.id || ''
    if (qid === currentQuestionIdRef.current) return
    currentQuestionIdRef.current = qid
    setAnswerText(question?.draft_text || '')
    setError(null)
  }, [question?.draft_text, question?.id, setAnswerText])

  useEffect(() => {
    if (!current || !question || question.phase === 'submitted_pending_eval' || submitting || finishing) return
    const qid = question.id
    const timer = window.setTimeout(() => {
      if (currentQuestionIdRef.current !== qid) return
      void mockInterviewAPI.saveDraft(current.id, qid, answerRef.current).catch(() => undefined)
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [answerText, current, finishing, question, submitting])

  const openSession = async (id: number) => {
    setError(null)
    try {
      const detail = await mockInterviewAPI.getSession(id)
      setCurrent(detail)
    } catch (err) {
      setError(getErrorMessage(err, '打开模拟面试失败'))
    }
  }

  const startSession = async (payload: CreateMockInterviewRequest) => {
    setCreating(true)
    setError(null)
    try {
      const detail = await mockInterviewAPI.createSession(payload)
      setCurrent(detail)
      await refreshSessions()
    } catch (err) {
      setError(getErrorMessage(err, '创建模拟面试失败'))
    } finally {
      setCreating(false)
    }
  }

  const startAnswer = useCallback(async () => {
    if (!current || !question || question.phase !== 'thinking') return
    try {
      setError(null)
      const detail = await mockInterviewAPI.startAnswer(current.id, question.id)
      setCurrent(detail)
    } catch (err) {
      setError(getErrorMessage(err, '开始回答失败'))
    }
  }, [current, question])

  const submitAnswer = useCallback(async (autoSubmitted: boolean) => {
    if (!current || !question || submitting || finishing) return
    if (!autoSubmitted && !answerRef.current.trim()) {
      setError('请先输入或说出一段回答，再点击发送')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await mockInterviewAPI.submitAnswer(
        current.id,
        question.id,
        answerRef.current.trim(),
        autoSubmitted,
      )
      setCurrent(result.session)
      await refreshSessions()
    } catch (err) {
      setError(getErrorMessage(err, '提交回答失败，答案已保存，可重试'))
      try {
        const detail = await mockInterviewAPI.getSession(current.id)
        setCurrent(detail)
      } catch {
        /* keep local error */
      }
    } finally {
      setSubmitting(false)
    }
  }, [current, finishing, question, refreshSessions, submitting])

  const finishSession = useCallback(async () => {
    if (!current || finishing) return
    if (finishGuardRef.current === current.id) return
    finishGuardRef.current = current.id
    setFinishing(true)
    setError(null)
    try {
      const detail = await mockInterviewAPI.finishSession(current.id)
      setCurrent(detail)
      await refreshSessions()
      setToastMessage('模拟面试报告已生成')
    } catch (err) {
      setError(getErrorMessage(err, '生成面试报告失败，请重试'))
    } finally {
      setFinishing(false)
    }
  }, [current, finishing, refreshSessions, setToastMessage])

  useEffect(() => {
    if (current?.status === 'ready_to_finish' && !finishing) void finishSession()
  }, [current?.status, finishSession, finishing])

  const requestFinish = () => {
    if (!current) return
    if (current.answered_count === 0) {
      setError('至少完成一道题后才能生成报告')
      return
    }
    if (!window.confirm('确定结束本场模拟面试并生成诊断报告吗？')) return
    finishGuardRef.current = null
    void finishSession()
  }

  const deleteSession = async (session: MockInterviewSession) => {
    if (!window.confirm(`确定删除 ${session.position} 的模拟面试记录吗？此操作不可恢复。`)) return
    try {
      await mockInterviewAPI.deleteSession(session.id)
      if (current?.id === session.id) {
        setCurrent(null)
        currentQuestionIdRef.current = ''
      }
      await refreshSessions()
      setToastMessage('模拟面试记录已删除')
    } catch (err) {
      setError(getErrorMessage(err, '删除模拟面试记录失败'))
    }
  }

  const saveSelfAssessment = async (rating: number, note: string, tags: string[]) => {
    if (!current) return
    try {
      const detail = await mockInterviewAPI.saveSelfAssessment(current.id, rating, note, tags)
      setCurrent(detail)
      setToastMessage('你的面试感受已保存')
    } catch (err) {
      setError(getErrorMessage(err, '保存面试感受失败'))
    }
  }

  const reload = async () => {
    if (!current) return
    try {
      const detail = await mockInterviewAPI.getSession(current.id)
      setCurrent(detail)
      setError(null)
    } catch (err) {
      setError(getErrorMessage(err, '重新加载失败'))
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载 AI 模拟面试…
      </div>
    )
  }

  if (!current) {
    return (
      <SetupView
        sessions={sessions}
        creating={creating}
        error={error}
        onStart={(payload) => void startSession(payload)}
        onOpen={(id) => void openSession(id)}
        onDelete={(session) => void deleteSession(session)}
      />
    )
  }

  if (current.status === 'completed') {
    return (
      <ReportView
        session={current}
        onBack={() => { setCurrent(null); void refreshSessions() }}
        onDelete={() => void deleteSession(current)}
        onSelfAssessment={saveSelfAssessment}
      />
    )
  }

  return (
    <>
      <InterviewView
        key={questionKey}
        session={current}
        answerText={answerText}
        setAnswerText={setAnswerText}
        submitting={submitting}
        finishing={finishing}
        error={error}
        onStartAnswer={() => void startAnswer()}
        onSubmit={(auto) => void submitAnswer(auto)}
        onFinish={requestFinish}
        onBack={() => { setCurrent(null); void refreshSessions() }}
        onReload={() => void reload()}
      />
      {config?.has_resume === false && (
        <span className="sr-only">当前未挂载简历，模拟面试将使用岗位随机题。</span>
      )}
    </>
  )
}
