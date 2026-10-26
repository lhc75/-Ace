import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  Camera,
  CheckCircle2,
  Code2,
  Monitor,
  Send,
  Wifi,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  formatLatency,
  isRecord,
  normalizeStatusSteps,
  PreflightAnswerPreview,
  PreflightError,
  PreflightHeader,
  PreflightRunButton,
  PreflightStepGrid,
  PreflightSummary,
  usePreflightWs,
  type PreflightStepMeta,
  type StepState,
  type StepStatus,
} from './preflightShared'
import { useInterviewStore } from '@/stores/configStore'


interface ExamPreflightStatus {
  running?: boolean
  steps?: unknown
  error?: unknown
  finished_at?: unknown
  preflight_id?: unknown
}

interface ExamPreflightRunResponse {
  ok?: boolean
  preflight_id?: unknown
}

type TerminalOutcome = 'success' | 'failure'

const FIXED_QUESTION = '代码题：给定整数数组 nums 和目标值 target，返回两数之和的下标。'
const STATUS_POLL_INTERVAL_MS = 1000

const STEP_META: PreflightStepMeta[] = [
  { key: 'screenshot', label: '固定截图代码题', icon: Camera },
  { key: 'submit', label: '题目提交', icon: Send },
  { key: 'llm', label: 'LLM 模型', icon: Brain },
  { key: 'ws', label: '实时推送', icon: Wifi },
  { key: 'ui', label: 'UI 展示', icon: Monitor },
]

const TERMINAL_STEP_STATUSES = new Set<StepStatus>(['pass', 'fail', 'skip', 'done'])

function isTerminalStepStatus(status: unknown): status is StepStatus {
  return typeof status === 'string' && TERMINAL_STEP_STATUSES.has(status as StepStatus)
}

function normalizeStepStatus(status: unknown, fallback: StepStatus = 'idle'): StepStatus {
  if (status === 'idle' || status === 'running' || status === 'pass' || status === 'fail' || status === 'warn' || status === 'skip' || status === 'done') {
    return status
  }
  return fallback
}

/**
 * WebSocket and status hydration can report the same step through different
 * paths.  A completed step is a monotonic state: a late `running` event must
 * never erase its answer or make the panel look unfinished again.
 */
function mergeStepState(
  previous: StepState | undefined,
  incoming: Partial<StepState>,
): StepState {
  const current = previous ?? { status: 'idle' as StepStatus, detail: '' }
  const nextStatus = normalizeStepStatus(incoming.status, current.status)
  if (isTerminalStepStatus(current.status)) {
    if (!isTerminalStepStatus(nextStatus) || nextStatus !== current.status) return current
  }

  const next = { ...current, status: nextStatus }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) {
      ;(next as Record<string, unknown>)[key] = value
    }
  }
  return next
}

function mergeStepEntries(
  previous: Record<string, StepState>,
  incoming: Record<string, Partial<StepState>>,
): Record<string, StepState> {
  const next = { ...previous }
  for (const [key, value] of Object.entries(incoming)) {
    next[key] = mergeStepState(previous[key], value)
  }
  return next
}

function applyFailureSteps(prev: Record<string, StepState>, message: string): Record<string, StepState> {
  const next = { ...prev }
  if (!isTerminalStepStatus(next.llm?.status)) {
    next.llm = mergeStepState(next.llm, { status: 'fail', detail: message })
  }
  if (!isTerminalStepStatus(next.ui?.status)) {
    next.ui = mergeStepState(next.ui, { status: 'fail', detail: '未收到可展示的笔试答案' })
  }
  return next
}

function applyRequestFailureSteps(prev: Record<string, StepState>, message: string): Record<string, StepState> {
  return applyFailureSteps(
    {
      ...prev,
      submit: mergeStepState(prev.submit, {
        status: 'fail',
        detail: message,
        question: FIXED_QUESTION,
      }),
    },
    message,
  )
}

export default function WrittenExamTest() {
  const config = useInterviewStore((s) => s.config)
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Record<string, StepState>>({})
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const activePreflightIdRef = useRef<string | null>(null)
  const awaitingPreflightStartRef = useRef(false)
  const runRequestRef = useRef(false)
  const preflightGenerationRef = useRef(0)
  const terminalPreflightIdRef = useRef<string | null>(null)
  const terminalOutcomeRef = useRef<TerminalOutcome | null>(null)
  const hydrationRequestRef = useRef(0)
  const appliedHydrationRequestRef = useRef(0)

  const setCurrentPreflightId = useCallback((preflightId: string | null) => {
    activePreflightIdRef.current = preflightId
  }, [])

  const markTerminal = useCallback((preflightId: string, outcome: TerminalOutcome) => {
    const currentId = terminalPreflightIdRef.current
    if (currentId && currentId !== preflightId) return
    if (!currentId) terminalPreflightIdRef.current = preflightId
    if (!terminalOutcomeRef.current) terminalOutcomeRef.current = outcome
  }, [])

  const isTerminalFor = useCallback((preflightId: string): boolean => (
    terminalPreflightIdRef.current === preflightId && Boolean(terminalOutcomeRef.current)
  ), [])

  const shouldAcceptPreflightEvent = useCallback((preflightId: string): boolean => {
    const currentPreflightId = activePreflightIdRef.current
    if (currentPreflightId) return preflightId === currentPreflightId
    if (awaitingPreflightStartRef.current) return false
    setCurrentPreflightId(preflightId)
    return true
  }, [setCurrentPreflightId])

  const hydrateStatus = useCallback(async () => {
    const generation = preflightGenerationRef.current
    const requestId = ++hydrationRequestRef.current
    try {
      const status = await api.examPreflightStatus() as ExamPreflightStatus
      if (
        generation !== preflightGenerationRef.current
        || requestId < appliedHydrationRequestRef.current
      ) return
      const statusSteps = normalizeStatusSteps(status?.steps)
      const statusPreflightId = status?.preflight_id ? String(status.preflight_id) : null
      const currentPreflightId = activePreflightIdRef.current
      if (!currentPreflightId && awaitingPreflightStartRef.current) return
      if (currentPreflightId && statusPreflightId && statusPreflightId !== currentPreflightId) return
      if (currentPreflightId && !statusPreflightId && Object.keys(statusSteps).length === 0 && !status?.error) return
      const statusError = status?.error ? String(status.error) : null
      const errorStep = isRecord(statusSteps.error) ? statusSteps.error : null
      const failureMessage = statusError || (errorStep?.detail ? String(errorStep.detail) : null)
      const statusIsRunning = Boolean(status?.running)
      const statusIsDone = !statusIsRunning && statusSteps.done?.status === 'done'
      const statusOutcome: TerminalOutcome | null = failureMessage
        ? 'failure'
        : statusIsDone
          ? 'success'
          : null
      if (statusPreflightId && statusOutcome) markTerminal(statusPreflightId, statusOutcome)
      if (statusPreflightId) {
        setCurrentPreflightId(statusPreflightId)
      }
      const terminalId = terminalPreflightIdRef.current
      const terminalOutcome = terminalOutcomeRef.current
      const terminalStatusMatches = Boolean(
        terminalId
        && terminalOutcome
        && (!statusPreflightId || statusPreflightId === terminalId),
      )
      const isRunning = terminalStatusMatches ? false : statusIsRunning
      const isDone = terminalStatusMatches
        ? terminalOutcome === 'success'
        : statusIsDone
      const effectiveFailureMessage = terminalStatusMatches && terminalOutcome === 'success'
        ? null
        : failureMessage
      appliedHydrationRequestRef.current = requestId
      setSteps((prev) => {
        const hydrated = mergeStepEntries(prev, statusSteps)
        return effectiveFailureMessage ? applyFailureSteps(hydrated, effectiveFailureMessage) : hydrated
      })
      setRunning(isRunning)
      setDone(isDone || Boolean(effectiveFailureMessage && !isRunning))
      if (effectiveFailureMessage) setErrorMsg(effectiveFailureMessage)
      else if (!terminalStatusMatches) setErrorMsg(null)
      if (!isRunning && (isDone || effectiveFailureMessage)) runRequestRef.current = false
    } catch {
      /* status hydration is best-effort; WS has the primary progress stream */
    }
  }, [markTerminal, setCurrentPreflightId])

  const handleMessage = useCallback((msg: Record<string, any>) => {
      if (msg.exam_preflight_id) {
        const eventPreflightId = String(msg.exam_preflight_id)
        if (!shouldAcceptPreflightEvent(eventPreflightId)) return
        if (msg.type === 'answer_start') {
          if (isTerminalFor(eventPreflightId)) return
          setRunning(true)
          setSteps((prev) => ({
            ...prev,
            submit: mergeStepState(prev.submit, {
              status: 'pass',
              detail: '真实答题 worker 已开始流式回答',
              question: FIXED_QUESTION,
              model_name: msg.model_name,
            }),
            llm: mergeStepState(prev.llm, {
              status: 'running',
              detail: '正在通过真实答题流生成代码答案…',
              question: FIXED_QUESTION,
              model_name: msg.model_name,
            }),
            ws: mergeStepState(prev.ws, {
              status: 'running',
              detail: '已收到答题启动事件，等待模型流式片段…',
            }),
          }))
          return
        }
        if (msg.type === 'answer_think_chunk' || msg.type === 'answer_chunk') {
          if (isTerminalFor(eventPreflightId)) return
          setSteps((prev) => ({
            ...prev,
            ws: mergeStepState(prev.ws, {
              status: 'running',
              detail: '已收到真实答题 WebSocket 流式片段，等待模型生成完成…',
            }),
          }))
          return
        }
        if (msg.type === 'answer_done') {
          const answer = typeof msg.answer === 'string' ? msg.answer : ''
          if (!answer.trim()) {
            if (terminalOutcomeRef.current === 'success') return
            markTerminal(eventPreflightId, 'failure')
            const message = '模型未返回有效答案，请重试或更换模型。'
            runRequestRef.current = false
            setRunning(false)
            setDone(true)
            setErrorMsg(message)
            setSteps((prev) => ({
              ...applyFailureSteps(prev, message),
              ws: mergeStepState(prev.ws, {
                status: 'pass',
                detail: '已收到真实答题结果事件',
              }),
            }))
            return
          }
          if (terminalOutcomeRef.current === 'failure') return
          markTerminal(eventPreflightId, 'success')
          runRequestRef.current = false
          setRunning(false)
          setDone(true)
          setErrorMsg(null)
          setSteps((prev) => ({
            ...prev,
            llm: mergeStepState(prev.llm, {
              status: 'pass',
              detail: `首 token ${msg.first_token_ms ?? 0}ms · 完整 ${msg.total_ms ?? 0}ms`,
              answer: msg.answer,
              question: FIXED_QUESTION,
              first_token_ms: msg.first_token_ms,
              total_ms: msg.total_ms,
              model_name: msg.model_name,
            }),
            ws: mergeStepState(prev.ws, {
              status: 'pass',
              detail: '真实答题 WebSocket 完整推送正常',
            }),
            ui: mergeStepState(prev.ui, {
              status: 'pass',
              detail: '真实答题结果已在检测面板渲染',
            }),
          }))
          void hydrateStatus()
          return
        }
        if (msg.type === 'answer_error' || msg.type === 'answer_cancelled') {
          if (terminalOutcomeRef.current === 'success') return
          const message = msg.message || '笔试链路检测被取消或失败'
          markTerminal(eventPreflightId, 'failure')
          runRequestRef.current = false
          setRunning(false)
          setDone(true)
          setErrorMsg(message)
          setSteps((prev) => ({
            ...applyFailureSteps(prev, message),
            ws: mergeStepState(prev.ws, {
              status: 'pass',
              detail: '已收到真实答题错误事件',
            }),
          }))
          return
        }
        return
      }
      if (msg.type !== 'exam_preflight_step') return
      const { step, status, detail, answer, question, first_token_ms, total_ms, model_name } = msg
      const eventPreflightId = msg.preflight_id ? String(msg.preflight_id) : null
      if (msg.preflight_id) {
        if (!shouldAcceptPreflightEvent(eventPreflightId)) return
      }
      if (step === 'done') {
        if (terminalOutcomeRef.current === 'failure') return
        if (eventPreflightId) markTerminal(eventPreflightId, 'success')
        runRequestRef.current = false
        setDone(true)
        setRunning(false)
        void hydrateStatus()
        return
      }
      if (step === 'error') {
        if (terminalOutcomeRef.current === 'success') return
        const message = detail || '笔试链路检测失败，请检查模型配置'
        if (eventPreflightId) markTerminal(eventPreflightId, 'failure')
        runRequestRef.current = false
        setRunning(false)
        setDone(true)
        setErrorMsg(message)
        setSteps((prev) => applyFailureSteps(prev, message))
        return
      }
      setSteps((prev) => ({
        ...prev,
        [step]: mergeStepState(prev[step], {
          status,
          detail,
          answer,
          question,
          first_token_ms,
          total_ms,
          model_name,
        }),
      }))
  }, [hydrateStatus, isTerminalFor, markTerminal, shouldAcceptPreflightEvent])

  usePreflightWs(handleMessage)

  useEffect(() => {
    void hydrateStatus()
  }, [hydrateStatus])

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      void hydrateStatus()
    }, STATUS_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [hydrateStatus, running])

  useEffect(() => () => {
    preflightGenerationRef.current += 1
  }, [])

  const handleRun = async () => {
    if (runRequestRef.current || running) return
    const generation = preflightGenerationRef.current + 1
    preflightGenerationRef.current = generation
    runRequestRef.current = true
    setRunning(true)
    setDone(false)
    setSteps({})
    setErrorMsg(null)
    setCurrentPreflightId(null)
    terminalPreflightIdRef.current = null
    terminalOutcomeRef.current = null
    awaitingPreflightStartRef.current = true
    try {
      const response = await api.examPreflightRun() as ExamPreflightRunResponse
      if (generation !== preflightGenerationRef.current) return
      const preflightId = response?.preflight_id ? String(response.preflight_id) : null
      if (preflightId) setCurrentPreflightId(preflightId)
      awaitingPreflightStartRef.current = false
      if (preflightId) void hydrateStatus()
    } catch (error: any) {
      if (generation !== preflightGenerationRef.current) return
      const message = error?.message || '笔试链路检测请求失败，请确认后端服务已启动'
      runRequestRef.current = false
      awaitingPreflightStartRef.current = false
      setRunning(false)
      setDone(true)
      setErrorMsg(message)
      setSteps((prev) => applyRequestFailureSteps(prev, message))
    }
  }

  const hasAnyResult = Object.keys(steps).length > 0
  const allPassed = done && STEP_META.every((s) => {
    const step = steps[s.key]
    return step && (step.status === 'pass' || step.status === 'skip')
  })

  const llmStep = steps.llm
  const llmAnswer = llmStep?.answer
  const llmQuestion = llmStep?.question ?? steps.submit?.question ?? FIXED_QUESTION
  const firstToken = formatLatency(llmStep?.first_token_ms)
  const total = formatLatency(llmStep?.total_ms)
  const modelName = llmStep?.model_name ?? steps.submit?.model_name ?? config?.model_name
  const hasVisionModel = Boolean(config?.models?.some((model) => model.enabled !== false && model.supports_vision))

  return (
    <div className="preflight-panel animate-fade-up">
      <PreflightHeader
        icon={Code2}
        tone="green"
        subtitle="开始前，跑固定截图代码题并检查 截图 → 提交 → LLM → 实时推送 → UI 展示"
      />

      <div className="flex items-start gap-2 mb-4">
        <div className="flex-1 min-w-0 rounded-xl border border-accent-blue/20 bg-accent-blue/5 px-3 py-2">
          <div className="text-[10px] font-semibold text-accent-blue mb-1">固定截图代码题</div>
          <p className="text-xs text-text-primary leading-relaxed">{FIXED_QUESTION}</p>
        </div>

        <PreflightRunButton
          running={running}
          hasAnyResult={hasAnyResult}
          disabled={running}
          startIcon={Code2}
          onRun={handleRun}
        />
      </div>

      {errorMsg && <PreflightError message={errorMsg} />}

      {!hasVisionModel && !hasAnyResult && (
        <div className="flex items-center gap-2 text-xs text-accent-amber bg-accent-amber/10 px-3 py-2 rounded-lg mb-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>固定截图代码题需要支持视觉的模型。</span>
        </div>
      )}

      <PreflightStepGrid stepMeta={STEP_META} steps={steps} gridClassName="grid-cols-1 sm:grid-cols-2" />

      {llmAnswer && (
        <PreflightAnswerPreview
          answer={llmAnswer}
          question={llmQuestion}
          modelName={modelName}
          firstToken={firstToken}
          total={total}
          answerClassName="line-clamp-5 whitespace-pre-wrap"
        />
      )}

      {done && <PreflightSummary allPassed={allPassed} successText="笔试链路畅通，可以开始了！" />}

      {!hasAnyResult && config && (
        <div className="mt-3 space-y-1 text-[10px] text-text-muted/70 px-1">
          <div>当前模型：{config.models?.[config.active_model]?.name ?? config.model_name ?? 'N/A'}</div>
          <div>检测会走固定截图代码题，不写入正式答题记录</div>
        </div>
      )}
    </div>
  )
}
