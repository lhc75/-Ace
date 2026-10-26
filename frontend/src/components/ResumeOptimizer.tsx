import { useEffect, useState } from 'react'
import { useInterviewStore } from '@/stores/configStore'
import { useShallow } from 'zustand/react/shallow'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'
import { isLightColorScheme } from '@/lib/colorScheme'
import { api } from '@/lib/api'
import { Clipboard, FileSearch, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ResumeMountPanel } from '@/components/resume/ResumeMount'

const JD_STORAGE_KEY = 'ia-resume-opt-jd-draft'

function readStorage(key: string, fallback = ''): string {
  try {
    return window.localStorage?.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function extractRewriteSuggestions(text: string): string {
  const normalized = String(text || '').trim()
  if (!normalized) return ''
  const match = normalized.match(/^#{2,3}\s*(?:✏️|📝)?\s*(?:简历)?改写建议.*$/m)
  if (!match || match.index == null) return normalized
  return normalized.slice(match.index).trim()
}

export default function ResumeOptimizer() {
  const [jdText, setJdText] = useState(() => readStorage(JD_STORAGE_KEY))
  const [optimizingLocal, setOptimizingLocal] = useState(false)
  const { config, resumeOptStreaming, resumeOptResult, resumeOptLoading, setToastMessage, resetResumeOpt } =
    useInterviewStore(
      useShallow((s) => ({
        config: s.config,
        resumeOptStreaming: s.resumeOptStreaming,
        resumeOptResult: s.resumeOptResult,
        resumeOptLoading: s.resumeOptLoading,
        setToastMessage: s.setToastMessage,
        resetResumeOpt: s.resetResumeOpt,
      })),
    )
  const colorScheme = useUiPrefsStore((s) => s.colorScheme)
  const lightMarkdown = isLightColorScheme(colorScheme)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const displayText = resumeOptResult || resumeOptStreaming
  const isAnalyzing = resumeOptLoading || optimizingLocal
  const analysisState = isAnalyzing ? '分析中' : displayText ? '已生成' : '待开始'

  useEffect(() => {
    writeStorage(JD_STORAGE_KEY, jdText)
  }, [jdText])

  useEffect(() => {
    if (!optimizingLocal) return
    if (resumeOptLoading || displayText) {
      setOptimizingLocal(false)
    }
  }, [displayText, optimizingLocal, resumeOptLoading])

  const handleAnalyze = async () => {
    if (!jdText.trim()) return
    if (!config?.has_resume) {
      setUploadError('请先上传简历')
      return
    }
    try {
      setUploadError(null)
      setOptimizingLocal(true)
      resetResumeOpt('__pending__')
      await api.resumeOptimize(jdText.trim())
    } catch (e: any) {
      setOptimizingLocal(false)
      setUploadError(e.message || '分析失败')
    }
  }

  const handleCopy = async () => {
    if (!displayText) return
    try {
      await navigator.clipboard.writeText(displayText)
      setToastMessage('分析结果已复制')
    } catch {
      setToastMessage('复制失败，请检查浏览器权限')
    }
  }

  const handleCopyRewrite = async () => {
    if (!displayText) return
    const rewrite = extractRewriteSuggestions(displayText)
    try {
      await navigator.clipboard.writeText(rewrite || displayText)
      setToastMessage(rewrite && rewrite !== displayText ? '改写建议已复制' : '未识别到改写建议，已复制完整结果')
    } catch {
      setToastMessage('复制失败，请检查浏览器权限')
    }
  }

  return (
    <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
      {/* 左栏: 素材箱 */}
      <div className="md:w-[35%] md:min-w-[320px] border-b md:border-b-0 md:border-r-2 md:border-text-primary/70 flex flex-col flex-shrink-0 min-h-0">
        <div className="deck-header">
          <span className="deck-header-tag">CV-01 · MATERIAL</span>
          <h3 className="deck-header-title">简历优化工作台</h3>
        </div>
        <div className="flex-1 flex flex-col p-4 gap-3 min-h-0 overflow-y-auto">
          {/* 状态指标行 */}
          <div className="grid grid-cols-3 gap-3">
            <div className="border-l-2 border-accent-blue/70 pl-2.5">
              <p className="deck-stat-label">简历状态</p>
              <p className={`sd-num mt-1.5 text-base font-bold ${config?.has_resume ? 'text-accent-green' : 'text-text-primary'}`}>
                {config?.has_resume ? '已挂载' : '未上传'}
              </p>
            </div>
            <div className="border-l-2 border-accent-blue/70 pl-2.5">
              <p className="deck-stat-label">JD 字数</p>
              <p className="sd-num mt-1.5 text-base font-bold text-text-primary">{jdText.trim().length}</p>
            </div>
            <div className="border-l-2 border-accent-blue/70 pl-2.5">
              <p className="deck-stat-label">当前阶段</p>
              <p className="sd-num mt-1.5 text-base font-bold text-accent-blue">{analysisState}</p>
            </div>
          </div>

          <ResumeMountPanel
            title="Resume Mount"
            description="这里的分析直接使用当前挂载简历，不会维护另一份独立副本。"
            sharedNote="和主流程、面试复盘共用同一份简历历史与当前挂载记录。"
            variant="light"
          />

          {uploadError && (
            <div className="flex items-center gap-2 border-l-[3px] border-accent-red bg-accent-red/10 text-accent-red text-xs px-3 py-2">
              <span className="flex-1">{uploadError}</span>
              <button onClick={() => setUploadError(null)} aria-label="关闭错误提示"><X className="w-3 h-3" /></button>
            </div>
          )}

          <div className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex items-center justify-between gap-2">
              <label className="deck-stat-label !text-accent-blue">粘贴目标岗位 JD</label>
              <span className="text-[11px] sd-num text-text-muted">{jdText.length} chars</span>
            </div>
            <textarea
              value={jdText}
              onChange={e => setJdText(e.target.value)}
              placeholder="将招聘 JD 粘贴到这里..."
              className="flex-1 min-h-[180px] md:min-h-0 bg-bg-secondary text-text-primary text-xs p-3 border-[0.5px] border-bg-hover focus:outline-none focus:border-accent-blue resize-none font-mono leading-relaxed"
              style={{ borderRadius: 3 }}
            />
            <div className="flex flex-wrap gap-1.5">
              <span className="sd-chip !cursor-default">职责范围</span>
              <span className="sd-chip !cursor-default">技术关键词</span>
              <span className="sd-chip !cursor-default">结果导向</span>
            </div>
          </div>

          <button
            onClick={handleAnalyze}
            disabled={isAnalyzing || !jdText.trim() || !config?.has_resume}
            className="sd-btn sd-btn--primary w-full !min-h-[40px]"
          >
            {isAnalyzing ? '分析中...' : '开始分析'}
          </button>
        </div>
      </div>

      {/* 右栏: 批注输出 */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="deck-header">
          <span className="deck-header-tag">CV-02 · ANALYSIS DESK</span>
          <h4 className="deck-header-title">输出结果</h4>
          <div className="deck-header-aside">
            <span className="border-[0.5px] border-bg-hover px-2 py-0.5 text-[10px] sd-num uppercase tracking-wider text-text-secondary" style={{ borderRadius: 2 }}>
              {analysisState}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!displayText}
              className="sd-btn !min-h-[28px] !px-2.5 !text-[11px]"
            >
              <Clipboard className="w-3.5 h-3.5" />
              复制
            </button>
            {displayText && (
              <button
                type="button"
                onClick={handleCopyRewrite}
                className="sd-btn !min-h-[28px] !px-2.5 !text-[11px]"
              >
                <Clipboard className="w-3.5 h-3.5" />
                复制改写建议
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 md:p-5">
        {!displayText && isAnalyzing ? (
          <div className="space-y-3 max-w-xl" aria-busy="true" aria-live="polite">
            <span className="sr-only">正在分析简历与 JD 的匹配度…</span>
            <div className="flex items-center gap-2 text-xs text-accent-blue sd-num uppercase tracking-wider">
              <span className="inline-block w-2 h-2 bg-accent-blue animate-pulse" />
              正在分析简历与 JD 的匹配度…
            </div>
            {/* 模拟"标题 + 段落 + 小节"骨架 */}
            {[0.7, 0.95, 0.85, 0.6, 0.9, 0.8].map((w, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-1/4 bg-bg-tertiary/80 animate-pulse" style={{ animationDelay: `${i * 120}ms` }} />
                <div className="h-2 bg-bg-tertiary/50 animate-pulse" style={{ animationDelay: `${i * 120 + 40}ms`, width: `${w * 100}%` }} />
                <div className="h-2 bg-bg-tertiary/50 animate-pulse" style={{ animationDelay: `${i * 120 + 80}ms`, width: `${(w - 0.15) * 100}%` }} />
              </div>
            ))}
          </div>
        ) : !displayText ? (
          <div className="h-full flex items-center justify-center text-text-muted text-xs">
            <div className="max-w-md border-[0.5px] border-bg-hover p-6">
              <FileSearch className="w-8 h-8 mb-3 text-text-muted/50" />
              <p className="text-sm font-bold text-text-primary">先把材料放齐，再开始分析。</p>
              <ol className="mt-3 space-y-2 text-left">
                {[
                  '上传当前简历，确保内容已挂载。',
                  '粘贴目标岗位 JD，把关键词和职责写完整。',
                  '点击"开始分析"，等待模型生成修改建议。',
                ].map((item, i) => (
                  <li key={item} className="flex items-baseline gap-2.5 text-[11px] text-text-secondary">
                    <span className="sd-num text-[10px] text-accent-blue">{String(i + 1).padStart(2, '0')}</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 border-t border-dashed border-text-muted/30 pt-2 text-[10px]">结果会聚焦匹配度、改写方向和更像"能投出去"的表达。</p>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {['JD 关键能力', '命中 / 缺失', '改写建议'].map((label) => (
                <span key={label} className="sd-chip !cursor-default">
                  {label}
                </span>
              ))}
            </div>
            <div
              className={`prose prose-sm max-w-none markdown-body
              ${lightMarkdown ? '' : 'prose-invert'}
              prose-headings:text-text-primary prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
              prose-p:text-text-secondary prose-p:text-xs prose-p:leading-relaxed
              prose-li:text-text-secondary prose-li:text-xs
              prose-strong:text-text-primary
              prose-table:text-xs
              prose-th:text-text-primary prose-th:bg-bg-tertiary prose-th:px-2 prose-th:py-1
              prose-td:text-text-secondary prose-td:px-2 prose-td:py-1 prose-td:border-bg-hover
            `}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
              {isAnalyzing && (
                <span className="inline-block w-1.5 h-3 bg-accent-blue animate-pulse ml-0.5" />
              )}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
