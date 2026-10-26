import { useCallback, useEffect, useRef, useState } from 'react'
import { Files, Search, History, RefreshCw } from 'lucide-react'
import { useKbStore } from '@/stores/kbStore'
import { api } from '@/lib/api'
import KbFilesPanel from '../kb/KbFilesPanel'
import KbSearchTestPanel from '../kb/KbSearchTestPanel'
import KbRecentHitsPanel from '../kb/KbRecentHitsPanel'
import KbStatusHeader from '../kb/KbStatusHeader'

type Tab = 'files' | 'search' | 'recent'

/**
 * 知识库设置页 (Cherry 风格: 状态头部 + 分段切换 + 面板)。
 * 从原右侧抽屉迁入设置中心。
 */
export default function KbTab() {
  const setStatus = useKbStore((s) => s.setStatus)
  const setDocs = useKbStore((s) => s.setDocs)
  const setRecentHits = useKbStore((s) => s.setRecentHits)
  const refreshingRef = useRef(false)
  const queuedRefreshRef = useRef(false)
  const mountedRef = useRef(true)
  const [tab, setTab] = useState<Tab>('files')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (options?: { queueIfBusy?: boolean }) => {
    if (refreshingRef.current) {
      if (options?.queueIfBusy) queuedRefreshRef.current = true
      return
    }
    refreshingRef.current = true
    if (mountedRef.current) setRefreshing(true)
    try {
      do {
        queuedRefreshRef.current = false
        if (mountedRef.current) setError(null)
        try {
          const [s, d, r] = await Promise.all([
            api.kbStatus(),
            api.kbDocs(),
            api.kbHitsRecent(50),
          ])
          if (!mountedRef.current) return
          setStatus(s)
          setDocs(d.items)
          setRecentHits(r.items)
        } catch (e) {
          if (!mountedRef.current) return
          setError(e instanceof Error ? e.message : '加载失败')
        }
      } while (queuedRefreshRef.current)
    } finally {
      refreshingRef.current = false
      if (mountedRef.current) setRefreshing(false)
    }
  }, [setDocs, setRecentHits, setStatus])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'files', label: '文件', icon: <Files className="w-3.5 h-3.5" /> },
    { key: 'search', label: '检索测试', icon: <Search className="w-3.5 h-3.5" /> },
    { key: 'recent', label: '最近命中', icon: <History className="w-3.5 h-3.5" /> },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-xs text-text-muted">
          让 AI 回答引用你的本地笔记；支持 DOCX / PDF / OCR。
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          title="刷新"
          aria-label="刷新知识库"
          className="flex size-7 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <KbStatusHeader />

      {error && (
        <div className="mx-1 rounded-lg border-[0.5px] border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
          {error}
        </div>
      )}

      {/* Cherry 分段切换: muted 底 + 白色滑块 */}
      <div className="relative">
        <div className="flex rounded-lg bg-bg-tertiary p-1 gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 px-2 text-xs transition-colors ${
                tab === t.key ? 'text-text-primary font-medium' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <div
          className="absolute top-1 bottom-1 rounded-md bg-bg-secondary shadow-sm transition-all duration-200 ease-out"
          style={{
            left: `calc(${tabs.findIndex((t) => t.key === tab)} * ${100 / tabs.length}% + 4px)`,
            width: `calc(${100 / tabs.length}% - 8px)`,
          }}
        />
      </div>

      <div>
        {tab === 'files' && <KbFilesPanel onChanged={async () => { await refresh({ queueIfBusy: true }) }} />}
        {tab === 'search' && <KbSearchTestPanel />}
        {tab === 'recent' && <KbRecentHitsPanel />}
      </div>
    </div>
  )
}
