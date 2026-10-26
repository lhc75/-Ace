import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Activity, Volume2, Radio, Languages, ClipboardPaste, Keyboard, Brain, ArrowDown, Trash2 } from 'lucide-react'
import { api, getErrorMessage } from '@/lib/api'
import { useInterviewStore } from '@/stores/configStore'

export default function TranscriptionPanel() {
  const transcriptions = useInterviewStore((s) => s.transcriptions)
  const interimTranscription = useInterviewStore((s) => s.interimTranscription)
  const deleteTranscription = useInterviewStore((s) => s.deleteTranscription)
  const setToastMessage = useInterviewStore((s) => s.setToastMessage)
  const isRecording = useInterviewStore((s) => s.isRecording)
  const audioLevel = useInterviewStore((s) => s.audioLevel)
  const isTranscribing = useInterviewStore((s) => s.isTranscribing)
  const config = useInterviewStore((s) => s.config)
  const isExamMode = config?.written_exam_mode === true
  const contentRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)

  const updateAutoFollow = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 36
    autoFollowRef.current = nearBottom
    setShowJumpToLatest(!nearBottom && transcriptions.length > 0)
  }, [transcriptions.length])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = contentRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    autoFollowRef.current = true
    setShowJumpToLatest(false)
  }, [])

  useEffect(() => {
    if (!autoFollowRef.current) {
      setShowJumpToLatest(transcriptions.length > 0)
      return
    }
    requestAnimationFrame(() => scrollToLatest('auto'))
    // 进行中文字也要纳入依赖：它每 200ms 变化一次，用户停在底部时应跟着滚动
  }, [scrollToLatest, transcriptions, interimTranscription])

  useEffect(() => {
    updateAutoFollow()
  }, [updateAutoFollow])

  const levelPercent = Math.min(audioLevel * 500, 100)

  return (
    <div className="flex flex-col h-full">
      {/* 台标条: 编号 · 英文标签 + 标题 + 电平 */}
      <div className="deck-header">
        <span className="deck-header-tag">{isExamMode ? 'T-EXAM' : 'T-01 · TRANSCRIPT'}</span>
        <span className="deck-header-title">
          {isRecording ? (isExamMode ? '答题中' : '正在录音') : (isExamMode ? '答题记录' : '实时转录')}
        </span>
        <div className="deck-header-aside">
          {isRecording ? (
            <>
              {isTranscribing && (
                <span className="flex items-center gap-1 text-[10px] sd-num text-accent-amber font-semibold uppercase tracking-wider">
                  <Activity className="w-3 h-3 animate-pulse" />
                  转写中
                </span>
              )}
              <div className="flex items-end gap-[2px] h-4" aria-hidden>
                {[0.6, 1.0, 0.75, 0.9, 0.5].map((scale, i) => (
                  <div
                    key={i}
                    className="w-[3px] bg-accent-green/80 transition-all duration-75"
                    style={{
                      height: `${Math.max(15, Math.min(100, levelPercent * scale))}%`,
                      opacity: levelPercent > 5 ? 0.5 + (levelPercent / 200) : 0.2,
                    }}
                  />
                ))}
              </div>
              <span className="text-[10px] text-text-muted sd-num w-8 text-right">
                {Math.round(levelPercent)}%
              </span>
              <span className="relative inline-flex w-2 h-2" title="录音中">
                <span className="absolute inset-0 bg-accent-red motion-safe:animate-ping opacity-60" aria-hidden />
                <span className="relative inline-flex w-2 h-2 bg-accent-red" aria-hidden />
              </span>
            </>
          ) : (
            <MicOff className="w-3.5 h-3.5 text-text-muted" aria-hidden />
          )}
        </div>
      </div>

      <div
        ref={contentRef}
        aria-label="转写记录"
        className="relative flex-1 overflow-y-auto py-2"
        onScroll={updateAutoFollow}
        onWheel={(event) => {
          event.currentTarget.scrollTop += event.deltaY
        }}
      >
        {transcriptions.length === 0 && !interimTranscription ? (
          <div className="flex flex-col items-center justify-center h-full gap-5 px-6">
            {/* 待机画面: Cherry 空态 */}
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-bg-tertiary">
              {isRecording ? (
                <Activity className="w-6 h-6 text-accent-amber animate-pulse" />
              ) : (
                <Mic className="w-6 h-6 text-text-tertiary" />
              )}
            </div>
            <div className="text-center space-y-1.5">
              <p className="text-text-primary text-sm font-semibold">
                {isRecording ? (isExamMode ? '等待截图或手动输入…' : '等待语音输入…') : (isExamMode ? '笔试答题记录' : '实时语音转录')}
              </p>
              <p className="text-text-muted text-xs leading-relaxed max-w-[240px]">
                {isRecording
                  ? isExamMode
                    ? '截图审题或手动输入问题后，AI 会自动生成答案'
                    : '检测到语音会自动分段转录,问题会发给 AI 生成答案'
                  : isExamMode
                  ? '点击「开始笔试」，通过截图或输入题目获取答案'
                  : '选择音频设备后,点击「开始面试」启动实时识别'}
              </p>
            </div>
            {!isRecording && (
              <div className="w-full max-w-[260px] border-t border-bg-hover pt-3 space-y-1.5">
                {(isExamMode
                  ? [
                      { icon: ClipboardPaste, label: '截图审题', hint: '输入框 Ctrl/⌘+V 粘贴' },
                      { icon: Keyboard, label: '手动输入', hint: '底部输入框 + Enter' },
                      { icon: Brain, label: 'AI 答题', hint: '自动识别题目类型并生成答案' },
                    ]
                  : [
                      { icon: Volume2, label: '会议拾音', hint: '优先选 BlackHole / 系统音频 (loopback), 可录远端声音' },
                      { icon: Radio, label: '自动断句', hint: 'VAD 静音超阈值即切段并识别' },
                      { icon: Languages, label: '中英混读', hint: '默认中文优先, 英文术语保留原样' },
                    ]
                ).map(({ icon: Icon, label, hint }) => (
                  <div key={label} title={hint} className="flex items-center gap-2.5 text-xs text-text-secondary">
                    <Icon className="w-3.5 h-3.5 text-text-tertiary" />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* 转写列表: Cherry 简洁行 */}
            <div className="px-2 space-y-0.5">
              {transcriptions.map((entry, i) => (
                <div
                  key={entry.id}
                  className="group transcription-item relative flex items-start gap-2.5 px-2 py-2 text-sm leading-relaxed text-text-primary"
                  style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                >
                  <span className="sd-num text-[10px] text-text-tertiary select-none pt-[5px] w-6 text-right flex-shrink-0">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1">{entry.text}</span>
                  <button
                    type="button"
                    aria-label={`删除第 ${i + 1} 条转录`}
                    title="删除转录及关联问答"
                    className="shrink-0 rounded-md p-1 text-text-muted opacity-0 transition-all hover:bg-accent-red/10 hover:text-accent-red group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={async () => {
                      if (!window.confirm('删除这条转录？关联的 AI 问答也会删除。')) return
                      try {
                        const result = await api.deleteTranscription(entry.id)
                        deleteTranscription(entry.id, result.qa_ids)
                        setToastMessage('已删除转录及关联问答')
                      } catch (error) {
                        setToastMessage(getErrorMessage(error, '删除转录失败'))
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {/* 进行中的实时转写：暗色、无序号、无删除按钮，定稿后由后端清空并被正式转写替换 */}
              {interimTranscription && (
                <div
                  data-testid="interim-transcription-row"
                  className="relative flex items-start gap-2.5 px-2 py-2 text-sm leading-relaxed text-text-muted opacity-60"
                >
                  <Activity className="w-3.5 h-3.5 mt-1 shrink-0 text-accent-amber animate-pulse" />
                  <span className="min-w-0 flex-1">{interimTranscription}</span>
                </div>
              )}
            </div>
          </>
        )}
        {showJumpToLatest && (
          <button
            type="button"
            onClick={() => scrollToLatest()}
            className="sticky bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border-[0.5px] border-bg-hover bg-bg-secondary px-3 py-1.5 text-[11px] font-medium text-text-secondary shadow-md"
            aria-label="回到最新转写"
          >
            <ArrowDown className="h-3 w-3" />
            回到最新转写
          </button>
        )}
      </div>
    </div>
  )
}
