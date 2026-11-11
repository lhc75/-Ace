import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Briefcase,
  CheckCircle2,
  ChevronRight,
  Clock,
  Layers,
  Lightbulb,
  ListChecks,
  MessageSquare,
  Mic,
  Play,
  RotateCcw,
  ShieldCheck,
  Target,
  Trophy,
  UserRound,
  Video,
} from 'lucide-react'
import { useAIInterviewStore } from '@/stores/aiInterviewStore'
import { aiInterviewAPI } from '@/lib/aiInterviewAPI'
import type { StartAIInterviewRequest, SubmitAnswerRequest } from '@/lib/aiInterviewAPI'
import type { AnswerScore, InterviewQuestion } from '@/types/ai-interview'

const SCORE_DIMENSIONS = [
  {
    title: '沟通表达',
    aiLooksAt: '条理是否清晰、语言是否流畅',
    howToShow: '用“第一、第二、第三”结构化表达',
    icon: MessageSquare,
  },
  {
    title: '逻辑思维',
    aiLooksAt: '观点是否有论证和例子支撑',
    howToShow: '每个观点跟一个具体例子',
    icon: Layers,
  },
  {
    title: '岗位匹配',
    aiLooksAt: '回答是否命中 JD 关键词',
    howToShow: '回答前从 JD 提炼关键词并主动带入',
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
    aiLooksAt: '自信度与抗压表现',
    howToShow: '语速放缓、保持微笑、直视镜头',
    icon: ShieldCheck,
  },
] as const

const TRAINING_STEPS = [
  {
    time: '3 分钟',
    title: '自我介绍',
    detail: '录 60 秒版本，再用 90 秒版本补齐经历和动机。',
    icon: UserRound,
  },
  {
    time: '4 分钟',
    title: '行为经历',
    detail: '讲一次团队合作经历，按 STAR 结构作答，结果必须有数字。',
    icon: Layers,
  },
  {
    time: '3 分钟',
    title: '动机匹配',
    detail: '回答为什么选择这个行业和岗位，带入公司具体业务关键词。',
    icon: Briefcase,
  },
  {
    time: '5 分钟',
    title: '录像复盘',
    detail: '回看自己的表达，对照右侧清单逐项打分，写下最低项改进计划。',
    icon: Video,
  },
] as const

const QUESTION_PLAYBOOKS = [
  {
    index: '01',
    title: '自我介绍',
    tag: '出现率最高',
    structure: '标签开场 → 两段匹配经历 → 一句动机收尾',
    detail: '准备 60 秒和 90 秒两版。不要复述简历，经历必须与目标岗位匹配。',
    icon: UserRound,
  },
  {
    index: '02',
    title: '行为经历',
    tag: '必须 STAR',
    structure: '情境 → 任务 → 行动 → 结果',
    detail: '结果必须出现数字。失败题要落到“学到什么、后来怎么改”。',
    icon: Layers,
  },
  {
    index: '03',
    title: '情景与动机',
    tag: '命中 JD 关键词',
    structure: '先稳住局面 → 再找原因 → 最后给方案',
    detail: '动机题要说清公司具体业务，空泛表达会直接低分。',
    icon: Briefcase,
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

const QUESTION_TYPE_LABELS: Record<string, string> = {
  self_intro: '自我介绍',
  behavioral: '行为经历',
  project: '项目经历',
  motivation: '动机匹配',
  technical: '专业能力',
  algorithm: '算法',
  system_design: '系统设计',
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

function scoreTone(score: number): string {
  if (score >= 4.5) return 'text-accent-green'
  if (score >= 3.8) return 'text-accent-blue'
  return 'text-accent-amber'
}

function scoreBarTone(score: number): string {
  if (score >= 0.8) return 'bg-accent-green'
  if (score >= 0.6) return 'bg-accent-blue'
  return 'bg-accent-amber'
}

function scoreLabel(score: number): string {
  if (score >= 5) return '优秀'
  if (score >= 4) return '良好'
  if (score >= 3) return '合格'
  return '需重写'
}

export default function AIInterviewMode() {
  const {
    session,
    currentQuestion,
    isLoading,
    error,
    currentAnswer,
    showSTARGuide,
    starGuide,
    timeRemaining,
    timerRunning,
    setSession,
    setCurrentQuestion,
    setIsLoading,
    setError,
    setCurrentAnswer,
    setShowSTARGuide,
    setSTARGuide,
    startTimer,
    stopTimer,
    resetCurrentAnswer,
    resetSession,
  } = useAIInterviewStore()

  const [view, setView] = useState<'welcome' | 'guide' | 'interview' | 'feedback' | 'summary'>('welcome')
  const [guideMessage, setGuideMessage] = useState('')
  const [currentScore, setCurrentScore] = useState<AnswerScore | null>(null)
  const [summary, setSummary] = useState<any>(null)

  useEffect(() => {
    if (!timerRunning || timeRemaining <= 0) return

    const timer = window.setInterval(() => {
      useAIInterviewStore.setState((state) => ({
        timeRemaining: Math.max(0, state.timeRemaining - 1),
      }))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [timerRunning, timeRemaining])

  const handleStartInterview = async (config: StartAIInterviewRequest) => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await aiInterviewAPI.startInterview(config)
      setSession(result.session)
      setGuideMessage(result.guide_message)
      setView('guide')
    } catch (err) {
      setError(errorMessage(err, '开始面试失败'))
    } finally {
      setIsLoading(false)
    }
  }

  const loadSummary = async () => {
    try {
      const result = await aiInterviewAPI.completeInterview()
      setSummary(result.summary)
      setSession(result.session)
    } catch (err) {
      setError(errorMessage(err, '加载总结失败'))
    }
  }

  const handleNextQuestion = async () => {
    setIsLoading(true)
    setError(null)
    resetCurrentAnswer()

    try {
      const result = await aiInterviewAPI.nextQuestion()
      if (result.has_more && result.question) {
        setCurrentQuestion(result.question)
        setSession(result.session)
        setView('interview')
        startTimer()
        setShowSTARGuide(Boolean(result.question.requires_star))
      } else {
        setView('summary')
        await loadSummary()
      }
    } catch (err) {
      setError(errorMessage(err, '获取题目失败'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmitAnswer = async () => {
    if (!currentQuestion || !currentAnswer.trim()) {
      setError('请先输入回答内容')
      return
    }

    stopTimer()
    setIsLoading(true)
    setError(null)

    try {
      const request: SubmitAnswerRequest = {
        question_id: currentQuestion.id,
        answer_text: currentAnswer,
        time_used_seconds: Math.max(0, currentQuestion.time_limit_seconds - timeRemaining),
      }

      if (showSTARGuide && starGuide?.sections) {
        request.star_situation = starGuide.sections.situation.filled ? currentAnswer : ''
        request.star_task = starGuide.sections.task.filled ? currentAnswer : ''
        request.star_action = starGuide.sections.action.filled ? currentAnswer : ''
        request.star_result = starGuide.sections.result.filled ? currentAnswer : ''
      }

      const result = await aiInterviewAPI.submitAnswer(request)
      setCurrentScore(result.score)
      setSession(result.session)
      setView('feedback')
    } catch (err) {
      setError(errorMessage(err, '提交回答失败'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleCheckSTAR = useCallback(async () => {
    if (!currentAnswer.trim()) {
      setError('先写下回答，再检查 STAR 完整度')
      return
    }

    try {
      const result = await aiInterviewAPI.checkSTAR(currentAnswer)
      setSTARGuide(result.guide)
    } catch (err) {
      setError(errorMessage(err, 'STAR 检查失败'))
    }
  }, [currentAnswer, setError, setSTARGuide])

  const handleRestart = async () => {
    try {
      await aiInterviewAPI.resetSession()
    } catch {
      // A local reset is still safe when no active server session exists.
    }
    resetSession()
    setSummary(null)
    setGuideMessage('')
    setCurrentScore(null)
    setView('welcome')
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      {session && view !== 'welcome' && (
        <SessionBar
          session={session}
          timeRemaining={timeRemaining}
          running={timerRunning}
          onRestart={handleRestart}
        />
      )}

      {error && (
        <div className="mx-4 mt-3 flex items-start gap-3 rounded-lg border border-accent-red/25 bg-accent-red/8 px-4 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-red" />
          <p className="flex-1 text-xs leading-relaxed text-text-secondary">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs font-medium text-text-muted hover:text-text-primary"
          >
            关闭
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'welcome' && (
          <WelcomeView onStart={handleStartInterview} isLoading={isLoading} />
        )}
        {view === 'guide' && (
          <GuideView
            guideMessage={guideMessage}
            onNext={handleNextQuestion}
            isLoading={isLoading}
          />
        )}
        {view === 'interview' && currentQuestion && (
          <InterviewView
            question={currentQuestion}
            answer={currentAnswer}
            onAnswerChange={setCurrentAnswer}
            showSTARGuide={showSTARGuide}
            starGuide={starGuide}
            onCheckSTAR={handleCheckSTAR}
            onSubmit={handleSubmitAnswer}
            isLoading={isLoading}
          />
        )}
        {view === 'feedback' && currentScore && (
          <FeedbackView score={currentScore} onNext={handleNextQuestion} isLoading={isLoading} />
        )}
        {view === 'summary' && summary && (
          <SummaryView summary={summary} session={session} onRestart={handleRestart} />
        )}
      </div>
    </div>
  )
}

function SessionBar({
  session,
  timeRemaining,
  running,
  onRestart,
}: {
  session: any
  timeRemaining: number
  running: boolean
  onRestart: () => void
}) {
  const total = session.questions?.length || 0
  const current = Math.max(0, Math.min(total, session.current_question_index + 1))

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-bg-tertiary bg-bg-secondary/75 px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-text-primary">进度</span>
        <span className="rounded-md bg-bg-tertiary/70 px-2 py-1 font-mono text-[11px] text-text-secondary">
          {current} / {total}
        </span>
      </div>
      <div className="hidden h-4 w-px bg-bg-tertiary sm:block" />
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <BarChart3 className="h-3.5 w-3.5 text-accent-green" />
        平均分
        <span className={`font-semibold ${scoreTone(session.average_score || 0)}`}>
          {(session.average_score || 0).toFixed(1)}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        {session.show_timer && (
          <div className={`flex items-center gap-1.5 text-xs font-medium ${timeRemaining < 30 ? 'text-accent-red' : 'text-text-secondary'}`}>
            <Clock className="h-3.5 w-3.5" />
            <span className="font-mono text-sm">{formatTime(timeRemaining)}</span>
            <span className="hidden text-[10px] text-text-muted sm:inline">{running ? '计时中' : '已暂停'}</span>
          </div>
        )}
        <button
          type="button"
          onClick={onRestart}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重新开始
        </button>
      </div>
    </div>
  )
}

function WelcomeView({
  onStart,
  isLoading,
}: {
  onStart: (config: StartAIInterviewRequest) => void
  isLoading: boolean
}) {
  const [config, setConfig] = useState<StartAIInterviewRequest>({
    position: '后端开发',
    question_count: 3,
    total_time_minutes: 15,
    enable_star_guide: true,
    show_timer: true,
  })

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <main className="min-w-0 lg:flex-1 lg:overflow-y-auto">
        <section className="border-b border-bg-tertiary px-5 py-5 lg:px-7">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
            <span className="rounded-md bg-accent-green/10 px-2 py-1 text-accent-green">AI Interview Lab</span>
            <span>3 题 · 15 分钟 · 录像复盘</span>
          </div>
          <div className="mt-3 flex items-start gap-4">
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-accent-green/12 text-accent-green">
              <Trophy className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-text-primary">AI模拟面试</h1>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
                按真实 AI 面试的五个维度训练：先说结论，再用结构化表达和具体例子证明自己。
              </p>
            </div>
          </div>
        </section>

        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(280px,.92fr)] lg:px-7">
          <section className="rounded-lg border border-bg-tertiary bg-bg-secondary/45 p-4">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-accent-green" />
              <h2 className="text-sm font-semibold">本轮配置</h2>
            </div>

            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">目标岗位</span>
                <select
                  value={config.position}
                  onChange={(event) => setConfig({ ...config, position: event.target.value })}
                  className="h-9 w-full rounded-md border border-bg-hover/50 bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent-green/60"
                >
                  <option value="后端开发">后端开发</option>
                  <option value="前端开发">前端开发</option>
                  <option value="全栈开发">全栈开发</option>
                  <option value="算法工程师">算法工程师</option>
                  <option value="测试开发">测试开发</option>
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-text-secondary">题目数量</span>
                  <input
                    type="number"
                    min={3}
                    max={20}
                    value={config.question_count}
                    onChange={(event) => setConfig({
                      ...config,
                      question_count: Math.max(3, Number.parseInt(event.target.value, 10) || 3),
                    })}
                    className="h-9 w-full rounded-md border border-bg-hover/50 bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent-green/60"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-text-secondary">总时长</span>
                  <div className="relative">
                    <input
                      type="number"
                      min={10}
                      max={180}
                      value={config.total_time_minutes}
                      onChange={(event) => setConfig({
                        ...config,
                        total_time_minutes: Math.max(10, Number.parseInt(event.target.value, 10) || 15),
                      })}
                      className="h-9 w-full rounded-md border border-bg-hover/50 bg-bg-primary px-3 pr-8 text-sm text-text-primary outline-none focus:border-accent-green/60"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-text-muted">min</span>
                  </div>
                </label>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-bg-hover/40 bg-bg-primary/70 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={config.enable_star_guide}
                    onChange={(event) => setConfig({ ...config, enable_star_guide: event.target.checked })}
                    className="h-3.5 w-3.5 accent-[rgb(var(--c-accent-green))]"
                  />
                  <span className="text-xs text-text-secondary">启用 STAR 引导</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-bg-hover/40 bg-bg-primary/70 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={config.show_timer}
                    onChange={(event) => setConfig({ ...config, show_timer: event.target.checked })}
                    className="h-3.5 w-3.5 accent-[rgb(var(--c-accent-green))]"
                  />
                  <span className="text-xs text-text-secondary">显示倒计时</span>
                </label>
              </div>

              <button
                type="button"
                onClick={() => onStart(config)}
                disabled={isLoading}
                className="flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-accent-green px-5 text-sm font-semibold text-white transition-colors hover:bg-accent-green/90 disabled:cursor-wait disabled:opacity-60"
              >
                {isLoading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    正在准备面试
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    开始 15 分钟训练
                  </>
                )}
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-bg-tertiary bg-bg-secondary/35 p-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-accent-green" />
              <h2 className="text-sm font-semibold">课堂实战流程</h2>
              <span className="ml-auto text-[10px] font-mono text-text-muted">15 MIN</span>
            </div>
            <div className="mt-3 divide-y divide-bg-tertiary">
              {TRAINING_STEPS.map((step, index) => {
                const Icon = step.icon
                return (
                  <div key={step.title} className="flex gap-3 py-2.5 first:pt-1 last:pb-1">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-bg-primary text-text-muted">
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-text-muted">{String(index + 1).padStart(2, '0')}</span>
                        <span className="text-xs font-semibold text-text-primary">{step.title}</span>
                        <span className="ml-auto text-[10px] text-accent-green">{step.time}</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{step.detail}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </div>

        <section className="px-5 pb-6 lg:px-7">
          <div className="mb-3 flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-accent-green" />
            <h2 className="text-sm font-semibold">三类高频题，按这个结构答</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {QUESTION_PLAYBOOKS.map((playbook) => {
              const Icon = playbook.icon
              return (
                <article key={playbook.index} className="rounded-lg border border-bg-tertiary bg-bg-secondary/35 p-3.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-text-muted">{playbook.index}</span>
                    <Icon className="h-3.5 w-3.5 text-accent-green" />
                    <h3 className="text-xs font-semibold">{playbook.title}</h3>
                    <span className="ml-auto rounded bg-accent-green/10 px-1.5 py-0.5 text-[9px] text-accent-green">
                      {playbook.tag}
                    </span>
                  </div>
                  <p className="mt-3 text-xs font-medium leading-relaxed text-text-primary">{playbook.structure}</p>
                  <p className="mt-2 text-[11px] leading-relaxed text-text-muted">{playbook.detail}</p>
                </article>
              )
            })}
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-md border border-accent-amber/20 bg-accent-amber/7 px-3 py-2 text-[11px] leading-relaxed text-text-secondary">
            <Lightbulb className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-accent-amber" />
            自测方法：把回答转成文字，数一数 JD 关键词出现了几次；少于 3 次就重写。
          </div>
        </section>
      </main>

      <InsightSidebar />
    </div>
  )
}

function GuideView({
  guideMessage,
  onNext,
  isLoading,
}: {
  guideMessage: string
  onNext: () => void
  isLoading: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <main className="min-w-0 p-5 lg:flex-1 lg:overflow-y-auto lg:p-7">
        <section className="mx-auto max-w-3xl">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-green/12 text-accent-green">
              <ListChecks className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold">开始前，先看评分规则</h2>
              <p className="text-xs text-text-muted">AI 不只听内容，也会看结构、岗位匹配和表达状态。</p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              ['3 分', '基本回答', '覆盖部分要点，表达能听懂'],
              ['4 分', '较为充分', '覆盖主要要点，有例子支撑'],
              ['5 分', '完善回答', '结构清楚，有量化结果和岗位关键词'],
            ].map(([score, label, detail]) => (
              <div key={score} className="rounded-lg border border-bg-tertiary bg-bg-secondary/45 px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-accent-green">{score}</span>
                  <span className="text-xs font-semibold">{label}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-text-muted">{detail}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 rounded-lg border border-bg-tertiary bg-bg-secondary/35 p-4">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-accent-green" />
              <h3 className="text-sm font-semibold">系统提示</h3>
            </div>
            <div className="mt-3 whitespace-pre-wrap text-xs leading-6 text-text-secondary">
              {guideMessage}
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-accent-green/20 bg-accent-green/7 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-accent-green">
              <Mic className="h-4 w-4" />
              建议同时打开手机录音或录像
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
              面试结束后回看录像，重点检查结论是否在 10 秒内出现、眼神是否看镜头、语速是否平稳。
            </p>
          </div>

          <button
            type="button"
            onClick={onNext}
            disabled={isLoading}
            className="mt-5 flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-accent-green px-5 text-sm font-semibold text-white hover:bg-accent-green/90 disabled:opacity-60"
          >
            {isLoading ? '正在出题…' : '进入第 1 题'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </section>
      </main>
      <InsightSidebar />
    </div>
  )
}

function InterviewView({
  question,
  answer,
  onAnswerChange,
  showSTARGuide,
  starGuide,
  onCheckSTAR,
  onSubmit,
  isLoading,
}: {
  question: InterviewQuestion
  answer: string
  onAnswerChange: (answer: string) => void
  showSTARGuide: boolean
  starGuide: any
  onCheckSTAR: () => void
  onSubmit: () => void
  isLoading: boolean
}) {
  const typeLabel = QUESTION_TYPE_LABELS[question.type] || question.category || '面试题'
  const guide = questionGuide(question)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <main className="min-w-0 p-5 lg:flex-1 lg:overflow-y-auto lg:p-6">
        <section className="mx-auto max-w-4xl">
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <span className="rounded bg-accent-green/10 px-2 py-1 font-medium text-accent-green">{typeLabel}</span>
            <span className="rounded bg-bg-tertiary/70 px-2 py-1 text-text-secondary">
              {question.difficulty === 'easy' ? '基础' : question.difficulty === 'hard' ? '进阶' : '中等'}
            </span>
            <span className="ml-auto flex items-center gap-1 text-text-muted">
              <Clock className="h-3 w-3" />
              {formatTime(question.time_limit_seconds)}
            </span>
          </div>

          <h2 className="mt-4 text-lg font-semibold leading-relaxed text-text-primary">{question.content}</h2>

          <div className="mt-4 rounded-lg border border-accent-green/20 bg-accent-green/7 px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-accent-green">
              <Target className="h-4 w-4" />
              {guide.title}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-secondary">{guide.structure}</p>
            <p className="mt-1 text-[10px] leading-relaxed text-text-muted">{guide.tip}</p>
          </div>

          {showSTARGuide && (
            <div className="mt-4 rounded-lg border border-bg-tertiary bg-bg-secondary/35 p-4">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-accent-green" />
                <h3 className="text-xs font-semibold">STAR 完整度</h3>
                <button
                  type="button"
                  onClick={onCheckSTAR}
                  className="ml-auto rounded-md border border-bg-hover/50 px-2.5 py-1 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  检查当前回答
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(['situation', 'task', 'action', 'result'] as const).map((key) => {
                  const labels = { situation: 'S 情境', task: 'T 任务', action: 'A 行动', result: 'R 结果' }
                  const filled = Boolean(starGuide?.sections?.[key]?.filled)
                  return (
                    <div
                      key={key}
                      className={`rounded-md border px-2 py-2 text-[10px] ${
                        filled
                          ? 'border-accent-green/30 bg-accent-green/8 text-accent-green'
                          : 'border-bg-hover/35 bg-bg-primary/60 text-text-muted'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 font-semibold">
                        {filled ? <CheckCircle2 className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {labels[key]}
                      </div>
                      <p className="mt-1 text-[9px] leading-relaxed">
                        {key === 'result' ? '必须有数字结果' : starGuide?.sections?.[key]?.prompt || '按结构补充'}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="mt-4 rounded-lg border border-bg-tertiary bg-bg-secondary/30">
            <div className="flex items-center justify-between border-b border-bg-tertiary px-4 py-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <MessageSquare className="h-4 w-4 text-accent-green" />
                你的回答
              </div>
              <span className="text-[10px] font-mono text-text-muted">{answer.length} 字</span>
            </div>
            <textarea
              aria-label="面试回答"
              value={answer}
              onChange={(event) => onAnswerChange(event.target.value)}
              placeholder={guide.placeholder}
              className="min-h-[260px] w-full resize-none bg-transparent px-4 py-3 text-sm leading-7 text-text-primary outline-none placeholder:text-text-muted/70"
            />
            <div className="flex items-center justify-between gap-3 border-t border-bg-tertiary px-4 py-3">
              <p className="text-[10px] leading-relaxed text-text-muted">
                先给结论，再展开。行为题用 STAR，结果必须有数字。
              </p>
              <button
                type="button"
                onClick={onSubmit}
                disabled={isLoading || !answer.trim()}
                className="inline-flex min-h-[36px] flex-shrink-0 items-center gap-1.5 rounded-md bg-accent-green px-4 text-xs font-semibold text-white hover:bg-accent-green/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? '评分中…' : '提交回答'}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </section>
      </main>
      <InsightSidebar />
    </div>
  )
}

function questionGuide(question: InterviewQuestion): {
  title: string
  structure: string
  tip: string
  placeholder: string
} {
  if (question.type === 'self_intro') {
    return {
      title: '自我介绍：标签开场，不背简历',
      structure: '一句话标签定位 → 两段与岗位匹配的经历 → 一句动机收尾',
      tip: '准备 60 秒和 90 秒两版；先说你是谁、做过什么、为什么匹配。',
      placeholder: '先用一句话定位自己，再用两段匹配经历证明，最后补充求职动机……',
    }
  }
  if (question.type === 'motivation') {
    return {
      title: '动机题：说清公司业务和岗位选择',
      structure: '选择原因 → 对公司业务的理解 → 个人能力如何匹配 → 稳定性',
      tip: '至少带入 3 个公司或岗位具体关键词，避免“平台好、想成长”这类空话。',
      placeholder: '我选择这个岗位，是因为……我关注到贵公司的……这与我的……经历相匹配……',
    }
  }
  if (question.requires_star || question.type === 'behavioral' || question.type === 'project') {
    return {
      title: '行为经历：按 STAR 讲完整故事',
      structure: '情境 Situation → 任务 Task → 行动 Action → 结果 Result',
      tip: '结果必须有数字；失败题要落到“学到了什么、后来怎么改”。',
      placeholder: '情境是……我的任务是……我具体做了三步……最终结果是（数字）……',
    }
  }
  return {
    title: '专业题：先结论，再分点解释',
    structure: '第一说核心结论 → 第二讲原因或机制 → 第三给场景或例子',
    tip: '每一点只讲一个观点，主动带入岗位相关的技术关键词。',
    placeholder: '先给结论……第一……第二……第三……结合实际场景……',
  }
}

function FeedbackView({
  score,
  onNext,
  isLoading,
}: {
  score: AnswerScore
  onNext: () => void
  isLoading: boolean
}) {
  const details = [
    ['完整度', score.completeness],
    ['相关性', score.relevance],
    ['深度', score.depth],
    ['结构', score.structure],
  ] as const

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <main className="min-w-0 p-5 lg:flex-1 lg:overflow-y-auto lg:p-7">
        <section className="mx-auto max-w-4xl">
          <div className="flex flex-wrap items-end gap-4 border-b border-bg-tertiary pb-5">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Question Score</p>
              <div className={`mt-1 font-mono text-4xl font-bold ${scoreTone(score.score)}`}>
                {score.score}
                <span className="ml-1 text-sm font-medium text-text-muted">/ 5</span>
              </div>
            </div>
            <div className="pb-1">
              <span className="rounded-md bg-accent-green/10 px-2 py-1 text-xs font-semibold text-accent-green">
                {scoreLabel(score.score)}
              </span>
              <p className="mt-2 text-xs text-text-muted">AI 已按结构、内容深度和岗位相关性评分。</p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <section>
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-accent-green" />
                <h2 className="text-sm font-semibold">评分明细</h2>
              </div>
              <div className="mt-3 space-y-3">
                {details.map(([label, value]) => (
                  <div key={label}>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-text-secondary">{label}</span>
                      <span className="font-mono text-text-muted">{Math.round((value || 0) * 100)}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                      <div
                        className={`h-full rounded-full ${scoreBarTone(value || 0)}`}
                        style={{ width: `${Math.max(4, Math.round((value || 0) * 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-accent-green" />
                <h2 className="text-sm font-semibold">AI 检查结果</h2>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  ['命中关键点', score.has_key_points],
                  ['有具体例子', score.has_examples],
                  ['有量化数字', score.has_quantitative_data],
                  ['长度合适', score.length_appropriate],
                ].map(([label, passed]) => (
                  <div
                    key={String(label)}
                    className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-[10px] ${
                      passed
                        ? 'border-accent-green/25 bg-accent-green/8 text-accent-green'
                        : 'border-accent-amber/25 bg-accent-amber/8 text-accent-amber'
                    }`}
                  >
                    {passed ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                    {label}
                  </div>
                ))}
              </div>
            </section>
          </div>

          {score.improvement_suggestions?.length > 0 && (
            <section className="mt-5 rounded-lg border border-accent-amber/20 bg-accent-amber/6 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Lightbulb className="h-4 w-4 text-accent-amber" />
                下一遍重点改这些
              </div>
              <ul className="mt-2 space-y-2">
                {score.improvement_suggestions.map((suggestion, index) => (
                  <li key={`${suggestion}-${index}`} className="flex items-start gap-2 text-[11px] leading-relaxed text-text-secondary">
                    <span className="mt-0.5 font-mono text-[9px] text-accent-amber">{String(index + 1).padStart(2, '0')}</span>
                    {suggestion}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <button
            type="button"
            onClick={onNext}
            disabled={isLoading}
            className="mt-5 flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-accent-green px-5 text-sm font-semibold text-white hover:bg-accent-green/90 disabled:opacity-60"
          >
            {isLoading ? '正在准备下一题…' : '进入下一题'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </section>
      </main>
      <InsightSidebar />
    </div>
  )
}

function SummaryView({
  summary,
  session,
  onRestart,
}: {
  summary: any
  session: any
  onRestart: () => void
}) {
  const stats = summary.statistics || {}
  const answers = session?.answers || []
  const average = (key: 'completeness' | 'relevance' | 'depth' | 'structure') => {
    const values = answers
      .map((item: any) => Number(item.score?.[key]))
      .filter((value: number) => Number.isFinite(value))
    return values.length ? values.reduce((sum: number, value: number) => sum + value, 0) / values.length : 0
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <main className="min-w-0 p-5 lg:flex-1 lg:overflow-y-auto lg:p-7">
        <section className="mx-auto max-w-4xl">
          <div className="flex items-center gap-3 border-b border-bg-tertiary pb-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-green/12 text-accent-green">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold">{summary.message}</h2>
              <p className="mt-1 text-xs text-text-muted">{summary.comment}</p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-3">
            {[
              ['平均分', stats.average_score ?? 0],
              ['完成题数', stats.total_questions ?? 0],
              ['用时', `${Math.max(1, Math.round((stats.total_time_seconds || 0) / 60))}m`],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg border border-bg-tertiary bg-bg-secondary/40 px-3 py-3">
                <div className="font-mono text-xl font-semibold text-accent-green">{value}</div>
                <div className="mt-1 text-[10px] text-text-muted">{label}</div>
              </div>
            ))}
          </div>

          <section className="mt-5 rounded-lg border border-bg-tertiary bg-bg-secondary/30 p-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-accent-green" />
              <h3 className="text-sm font-semibold">五维能力复盘</h3>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {[
                ['表达完整度', average('completeness')],
                ['岗位相关性', average('relevance')],
                ['回答深度', average('depth')],
                ['结构清晰度', average('structure')],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-text-secondary">{label}</span>
                    <span className="font-mono text-text-muted">{Math.round(Number(value) * 100)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                    <div
                      className={`h-full rounded-full ${scoreBarTone(Number(value))}`}
                      style={{ width: `${Math.max(4, Math.round(Number(value) * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="mt-5 rounded-lg border border-accent-green/20 bg-accent-green/7 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-accent-green">
              <Video className="h-4 w-4" />
              最后一步：回看录像
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
              对照右侧清单逐项打分，把最低分项写成一个下一轮可执行的改进计划。
            </p>
          </div>

          <button
            type="button"
            onClick={onRestart}
            className="mt-5 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-bg-hover/50 bg-bg-secondary px-4 text-sm font-semibold text-text-primary hover:bg-bg-hover"
          >
            <RotateCcw className="h-4 w-4" />
            再练一轮
          </button>
        </section>
      </main>
      <InsightSidebar />
    </div>
  )
}

function InsightSidebar() {
  return (
    <aside className="border-t border-bg-tertiary bg-bg-secondary/30 lg:min-h-0 lg:w-[340px] lg:flex-shrink-0 lg:overflow-y-auto lg:border-l lg:border-t-0">
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
                  <span className="text-xs font-semibold text-text-primary">{dimension.title}</span>
                </div>
                <p className="mt-1 pl-5 text-[10px] leading-relaxed text-text-muted">
                  {dimension.aiLooksAt}
                </p>
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
          <h2 className="text-sm font-semibold">AI 视角自检清单</h2>
        </div>
        <ul className="mt-3 space-y-2">
          {SELF_CHECK_ITEMS.map((item) => (
            <li key={item} className="flex items-start gap-2 text-[11px] leading-relaxed text-text-secondary">
              <span className="mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border border-bg-hover/60">
                <CheckCircle2 className="h-2.5 w-2.5 text-transparent" />
              </span>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section className="border-t border-bg-tertiary p-4">
        <div className="flex items-start gap-2 rounded-md border border-accent-amber/20 bg-accent-amber/7 px-3 py-2.5">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-accent-amber" />
          <p className="text-[10px] leading-relaxed text-text-secondary">
            得分最低的一项，才是下一轮最值得练的地方。不要平均用力。
          </p>
        </div>
      </section>
    </aside>
  )
}
