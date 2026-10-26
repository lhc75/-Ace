import { useState, useEffect, useCallback, useRef } from 'react'
import {
  AudioWaveform,
  Mic,
  Brain,
  CheckCircle2,
  Wifi,
  Star,
  ChevronDown,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  normalizeStatusSteps,
  PreflightAnswerPreview,
  PreflightError,
  PreflightHeader,
  PreflightRunButton,
  PreflightStepGrid,
  PreflightSummary,
  usePreflightWs,
  formatLatency,
  type PreflightStepMeta,
  type StepState,
} from './preflightShared'
import { useInterviewStore } from '@/stores/configStore'
import { pickDefaultAudioDevice } from './control-bar/audioDevices'


interface Scenario {
  id: string
  label: string
  question: string
  recommended: boolean
}

const STEP_META: PreflightStepMeta[] = [
  { key: 'playback', label: '播放测试音频', icon: AudioWaveform },
  { key: 'capture', label: '捕获输入音频', icon: Mic },
  { key: 'stt', label: '语音识别', icon: Mic },
  { key: 'match', label: '短句匹配', icon: CheckCircle2 },
  { key: 'llm', label: 'LLM 模型', icon: Brain },
  { key: 'ws', label: '实时推送', icon: Wifi },
]

export default function SoundTest() {
  const devices = useInterviewStore((s) => s.devices)
  const config = useInterviewStore((s) => s.config)
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [selectedScenario, setSelectedScenario] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Record<string, StepState>>({})
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const runRequestRef = useRef(false)

  useEffect(() => {
    api.preflightScenarios().then((res) => {
      setScenarios(res.scenarios)
      const rec = res.scenarios.find((s) => s.recommended)
      if (rec) setSelectedScenario(rec.id)
      else if (res.scenarios.length) setSelectedScenario(res.scenarios[0].id)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const handleMessage = useCallback((msg: Record<string, any>) => {
    if (msg.type !== 'preflight_step') return
    const { step, status, detail, answer, question, transcript, expected_phrase, first_token_ms, total_ms, model_name } = msg
    if (step === 'done') {
      runRequestRef.current = false
      setDone(true)
      setRunning(false)
      void api.preflightStatus().then((status) => {
        const statusSteps = normalizeStatusSteps(status?.steps)
        setSteps((prev) => ({
          ...prev,
          ...Object.fromEntries(
            Object.entries(statusSteps).map(([key, value]) => [
              key,
              { ...(prev[key] ?? { status: 'idle', detail: '' }), ...value },
            ]),
          ),
          match: {
            ...(prev.match ?? { status: 'idle', detail: '' }),
            ...statusSteps.match,
            transcript: status?.captured_transcript ?? prev.match?.transcript,
            expected_phrase: status?.expected_phrase ?? prev.match?.expected_phrase,
          },
        }))
      }).catch(() => {})
      return
    }
    if (step === 'error') {
      runRequestRef.current = false
      setRunning(false)
      setErrorMsg(detail || '试音失败，请检查设备和配置')
      return
    }
    setSteps((prev) => ({
      ...prev,
      [step]: { status, detail, answer, question, transcript, expected_phrase, first_token_ms, total_ms, model_name },
    }))
  }, [])

  usePreflightWs(handleMessage)

  const selectedDevice = pickDefaultAudioDevice(devices)

  const handleRun = async () => {
    if (runRequestRef.current || running) return
    runRequestRef.current = true
    setRunning(true)
    setDone(false)
    setSteps({})
    setErrorMsg(null)
    try {
      await api.preflightRun(selectedScenario, selectedDevice)
    } catch (e: any) {
      runRequestRef.current = false
      setRunning(false)
      setErrorMsg(e?.message || '试音请求失败，请检查服务是否启动')
    }
  }

  const allPassed = done && STEP_META.every((s) => {
    const st = steps[s.key]
    return st && (st.status === 'pass' || st.status === 'skip')
  })

  const llmAnswer = steps['llm']?.answer
  const llmQuestion = steps['llm']?.question
  const llmFirstToken = formatLatency(steps['llm']?.first_token_ms)
  const llmTotal = formatLatency(steps['llm']?.total_ms)
  const llmModelName = steps['llm']?.model_name
  const transcript = steps['match']?.transcript ?? steps['stt']?.transcript
  const expectedPhrase = steps['match']?.expected_phrase
  const selected = scenarios.find((s) => s.id === selectedScenario)

  const hasAnyResult = Object.keys(steps).length > 0

  return (
    <div className="preflight-panel animate-fade-up">
      <PreflightHeader
        icon={AudioWaveform}
        tone="blue"
        subtitle="开始前，播放固定测试短句并检查 播放 → 捕获 → STT → LLM → 实时推送 是否畅通"
      />

      {/* Scenario selector + Run button */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setShowDropdown(!showDropdown)}
            disabled={running}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-bg-hover/60 bg-bg-tertiary/40 text-xs text-text-primary hover:border-accent-blue/30 transition-colors disabled:opacity-50"
          >
            <span className="flex items-center gap-1.5 truncate">
              {selected?.recommended && <Star className="w-3 h-3 text-accent-amber fill-accent-amber" />}
              {selected?.label ?? '选择 LLM 检测场景'}
            </span>
            <ChevronDown className={`w-3.5 h-3.5 text-text-muted transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
          </button>
          {showDropdown && (
            <div className="absolute top-full left-0 right-0 mt-1 glass border border-bg-hover/50 rounded-xl shadow-xl shadow-black/20 z-50 py-1 animate-fade-up">
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => { setSelectedScenario(s.id); setShowDropdown(false) }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors hover:bg-bg-tertiary/50 ${
                    s.id === selectedScenario ? 'text-accent-blue bg-accent-blue/5' : 'text-text-primary'
                  }`}
                >
                  {s.recommended && <Star className="w-3 h-3 text-accent-amber fill-accent-amber flex-shrink-0" />}
                  <span className="flex-1 truncate">{s.label}</span>
                  <span className="text-[10px] text-text-muted truncate max-w-[120px]">{s.question}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <PreflightRunButton
          running={running}
          hasAnyResult={hasAnyResult}
          disabled={running || !selectedScenario}
          startIcon={AudioWaveform}
          onRun={handleRun}
        />
      </div>

      {errorMsg && <PreflightError message={errorMsg} />}

      <PreflightStepGrid stepMeta={STEP_META} steps={steps} />

      {expectedPhrase && (
        <div className="mt-3 rounded-xl border border-accent-blue/20 bg-accent-blue/5 p-3 animate-fade-up space-y-1">
          <p className="text-[10px] font-semibold text-accent-blue">固定测试短句</p>
          <p className="text-xs text-text-primary leading-relaxed">{expectedPhrase}</p>
          {transcript && (
            <>
              <p className="text-[10px] font-semibold text-text-muted pt-1">识别结果</p>
              <p className="text-xs text-text-primary leading-relaxed">{transcript}</p>
            </>
          )}
        </div>
      )}

      {llmAnswer && (
        <PreflightAnswerPreview
          answer={llmAnswer}
          question={llmQuestion}
          modelName={llmModelName}
          firstToken={llmFirstToken}
          total={llmTotal}
          answerClassName="line-clamp-3"
        />
      )}

      {done && <PreflightSummary allPassed={allPassed} successText="链路畅通，可以开始了！" />}

      {/* Model info hint */}
      {!hasAnyResult && config && (
        <div className="mt-3 space-y-1 text-[10px] text-text-muted/70 px-1">
          <div>{'当前: '}{config.stt_provider} + {config.models?.[config.active_model]?.name ?? 'N/A'}</div>
          <div>{selectedDevice != null && devices.find((d) => d.id === selectedDevice)?.is_loopback ? '推荐使用系统音频设备进行真实链路检测' : '当前将使用默认设备进行真实链路检测'}</div>
        </div>
      )}
    </div>
  )
}
