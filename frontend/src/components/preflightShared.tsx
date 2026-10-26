import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Monitor, RotateCcw, Sparkles, XCircle, type LucideIcon } from 'lucide-react'
import { buildWsUrl } from '@/lib/backendUrl'

/** SoundTest / WrittenExamTest 共用的预检步骤状态与工具 */

export type StepStatus = 'idle' | 'running' | 'pass' | 'fail' | 'warn' | 'skip' | 'done'

export interface StepState {
  status: StepStatus
  detail: string
  answer?: string
  question?: string
  transcript?: string
  expected_phrase?: string
  first_token_ms?: number
  total_ms?: number
  model_name?: string
}

export function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-4 h-4 text-accent-blue animate-spin" />
    case 'pass':
      return <CheckCircle2 className="w-4 h-4 text-accent-green" />
    case 'fail':
      return <XCircle className="w-4 h-4 text-accent-red" />
    case 'warn':
      return <AlertTriangle className="w-4 h-4 text-accent-amber" />
    case 'skip':
      return <div className="w-4 h-4 rounded-full border-2 border-text-muted/30" />
    default:
      return <div className="w-4 h-4 rounded-full border-2 border-bg-hover" />
  }
}

export function statusColor(status: StepStatus): string {
  switch (status) {
    case 'running': return 'border-accent-blue/40 bg-accent-blue/5'
    case 'pass': return 'border-accent-green/30 bg-accent-green/5'
    case 'fail': return 'border-accent-red/30 bg-accent-red/5'
    case 'warn': return 'border-accent-amber/30 bg-accent-amber/5'
    default: return 'border-bg-hover/50 bg-transparent'
  }
}

export function formatLatency(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}



export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeStatusSteps(value: unknown): Record<string, Partial<StepState>> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, step]) => isRecord(step)),
  ) as Record<string, Partial<StepState>>
}


/* ------------------------------------------------------------------ */
/* SoundTest / WrittenExamTest 共用的面板 UI 与 WS 连接                 */
/* ------------------------------------------------------------------ */

/** 链路检测面板的 WS 连接: 自动应答 ping, JSON 只解析一次, 坏帧直接丢弃 */
export function usePreflightWs(onMessage: (msg: Record<string, any>) => void) {
  useEffect(() => {
    const ws = new WebSocket(buildWsUrl('/ws'))
    ws.onmessage = (event) => {
      let msg: Record<string, any>
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg?.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }
      onMessage(msg)
    }
    return () => { ws.close() }
  }, [onMessage])
}

export interface PreflightStepMeta {
  key: string
  label: string
  icon: LucideIcon
}

/** 步骤网格: 每张卡片 = 图标 + 名称 + 状态 + 一行 detail */
export function PreflightStepGrid({ stepMeta, steps, gridClassName = 'grid-cols-2' }: {
  stepMeta: PreflightStepMeta[]
  steps: Record<string, StepState>
  gridClassName?: string
}) {
  return (
    <div className={`grid ${gridClassName} gap-2`}>
      {stepMeta.map(({ key, label, icon: Icon }, i) => {
        const step = steps[key]
        const status = step?.status ?? 'idle'
        return (
          <div
            key={key}
            className={`relative rounded-xl border px-3 py-2.5 transition-all duration-300 ${statusColor(status)}`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="flex items-center gap-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                status === 'pass' ? 'bg-accent-green/15' :
                status === 'fail' ? 'bg-accent-red/15' :
                status === 'running' ? 'bg-accent-blue/15' :
                'bg-bg-tertiary/50'
              }`}>
                <Icon className={`w-3.5 h-3.5 ${
                  status === 'pass' ? 'text-accent-green' :
                  status === 'fail' ? 'text-accent-red' :
                  status === 'running' ? 'text-accent-blue' :
                  'text-text-muted/60'
                }`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-text-primary">{label}</span>
                  <StatusIcon status={status} />
                </div>
                {step?.detail && (
                  <p className="text-[10px] text-text-muted mt-0.5 line-clamp-1">{step.detail}</p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 面板头部: 图标 + 「链路检测」标题 + 一句说明 */
export function PreflightHeader({ icon: Icon, tone, subtitle }: {
  icon: LucideIcon
  tone: 'blue' | 'green'
  subtitle: string
}) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
        tone === 'blue' ? 'border-accent-blue/60 text-accent-blue' : 'border-accent-green/60 text-accent-green'
      }`}>
        <Icon className="w-5 h-5" strokeWidth={2} />
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-bold text-text-primary tracking-tight flex items-center gap-1.5">
          链路检测
          <Sparkles className="w-3 h-3 text-accent-amber/80" />
        </h3>
        <p className="text-[10px] text-text-muted mt-0.5">{subtitle}</p>
      </div>
    </div>
  )
}

/** 开始/重新检测按钮: 首次主按钮, 之后次按钮 */
export function PreflightRunButton({ running, hasAnyResult, disabled, startIcon: StartIcon, onRun }: {
  running: boolean
  hasAnyResult: boolean
  disabled: boolean
  startIcon: LucideIcon
  onRun: () => void
}) {
  if (!hasAnyResult) {
    return (
      <button
        type="button"
        onClick={onRun}
        disabled={disabled}
        className="flex items-center gap-1.5 px-4 py-2 sd-btn sd-btn--primary text-xs font-semibold disabled:opacity-50 flex-shrink-0 whitespace-nowrap"
      >
        {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StartIcon className="w-3.5 h-3.5" />}
        开始检测
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={disabled}
      className="flex items-center gap-1.5 px-3 py-2 sd-btn text-xs font-medium disabled:opacity-50 flex-shrink-0"
    >
      {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
      重新
    </button>
  )
}

/** 红色错误条 */
export function PreflightError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-accent-red bg-accent-red/10 px-3 py-2 rounded-lg mb-2">
      <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  )
}

/** 结束后的汇总横幅 */
export function PreflightSummary({ allPassed, successText }: { allPassed: boolean; successText: string }) {
  return (
    <div className={`mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium animate-fade-up ${
      allPassed
        ? 'bg-accent-green/10 text-accent-green border border-accent-green/20'
        : 'bg-accent-amber/10 text-accent-amber border border-accent-amber/20'
    }`}>
      {allPassed ? (
        <>
          <CheckCircle2 className="w-4 h-4" />
          {successText}
        </>
      ) : (
        <>
          <AlertTriangle className="w-4 h-4" />
          部分环节异常，请检查配置后重试
        </>
      )}
    </div>
  )
}

/** LLM 答案预览卡 (UI 展示验证) */
export function PreflightAnswerPreview({ answer, question, modelName, firstToken, total, answerClassName }: {
  answer: string
  question?: string
  modelName?: string
  firstToken: string | null
  total: string | null
  answerClassName: string
}) {
  return (
    <div className="mt-3 rounded-xl border border-accent-green/20 bg-accent-green/5 p-3 animate-fade-up">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5">
          <Monitor className="w-3 h-3 text-accent-green" />
          <span className="text-[10px] font-semibold text-accent-green">UI 展示验证</span>
        </div>
        {(firstToken || total) && (
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted whitespace-nowrap">
            {firstToken && <span>首 token {firstToken}</span>}
            {firstToken && total && <span className="text-text-muted/40">/</span>}
            {total && <span>完整 {total}</span>}
          </div>
        )}
      </div>
      {question && (
        <p className="text-[11px] text-text-muted mb-1">
          <span className="text-accent-blue font-semibold">Q:</span> {question}
        </p>
      )}
      {modelName && (
        <p className="text-[10px] text-text-muted/80 mb-1">模型：{modelName}</p>
      )}
      <p className={`text-xs text-text-primary leading-relaxed ${answerClassName}`}>{answer}</p>
    </div>
  )
}
