import { useEffect, useState } from 'react'
import { ArrowDownToLine, X, RefreshCw, ExternalLink, PackageCheck } from 'lucide-react'
import type { UpdateStatePayload } from '@/types/electron'

/**
 * 桌面端更新提示卡：主进程检查到 Gitee 上有新 Release 时通过 update-state 事件推送。
 * 流程: available → (立即升级) downloading → ready → 打开 dmg 手动拖装。
 * macOS 未签名包无法 Squirrel 自动替换, 故采用下载 + 引导安装。
 */
export function UpdateNotifier() {
  const [state, setState] = useState<UpdateStatePayload | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!window.electronAPI?.onUpdateState) return
    return window.electronAPI.onUpdateState((payload) => {
      setState(payload)
      if (payload.phase === 'available') setDismissedVersion(null)
    })
  }, [])

  if (!state || state.phase === 'idle' || state.phase === 'checking') return null
  if (state.phase === 'available' && state.version && dismissedVersion === state.version) return null
  if (state.phase === 'none') return null

  const version = state.version ?? ''

  return (
    <div
      className="fixed bottom-4 right-4 z-[70] w-[320px] animate-fade-up rounded-xl border border-border-subtle/80 bg-bg-secondary/95 p-4 shadow-2xl shadow-black/20 backdrop-blur"
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent-blue/10 text-accent-blue">
          {state.phase === 'ready' ? <PackageCheck className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          {state.phase === 'available' && (
            <>
              <p className="text-sm font-semibold text-text-primary">发现新版本 v{version}</p>
              {state.notes && (
                <p className="mt-1 max-h-16 overflow-hidden text-[11px] leading-relaxed text-text-muted line-clamp-3">
                  {state.notes.split('\n').filter(Boolean).slice(0, 3).join('；')}
                </p>
              )}
            </>
          )}
          {state.phase === 'downloading' && (
            <>
              <p className="text-sm font-semibold text-text-primary">正在下载 v{version}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-hover">
                <div
                  className="h-full rounded-full bg-accent-blue transition-[width] duration-200"
                  style={{ width: `${state.percent ?? 0}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] font-mono tabular-nums text-text-muted">{state.percent ?? 0}%</p>
            </>
          )}
          {state.phase === 'ready' && (
            <>
              <p className="text-sm font-semibold text-text-primary">v{version} 已下载完成</p>
              <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                点击「安装并重启」自动完成更新。
                {state.error ? <span className="text-accent-red"> 自动安装失败：{state.error}</span> : null}
              </p>
            </>
          )}
          {(state.phase === 'installing' || state.phase === 'restarting') && (
            <p className="text-sm font-semibold text-text-primary">
              {state.phase === 'installing' ? '正在安装新版本…' : '安装完成，正在重启…'}
            </p>
          )}
          {state.phase === 'error' && (
            <>
              <p className="text-sm font-semibold text-text-primary">更新检查失败</p>
              <p className="mt-1 truncate text-[11px] text-accent-red" title={state.error}>{state.error}</p>
            </>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭更新提示"
          className="flex-shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          onClick={() => {
            if (state.phase === 'available' && version) setDismissedVersion(version)
            setState(null)
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {state.phase === 'available' && (
          <>
            <button
              type="button"
              className="rounded-md px-2.5 py-1.5 text-[11px] font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary"
              onClick={() => {
                if (version) void window.electronAPI?.skipUpdateVersion?.(version)
                setState(null)
              }}
            >
              跳过此版本
            </button>
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold"
              onClick={() => {
                if (state.plan && version) {
                  void window.electronAPI?.downloadUpdate?.({ plan: state.plan, version })
                }
              }}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              立即升级
            </button>
          </>
        )}
        {state.phase === 'ready' && state.dmgPath && (
          <>
            <button
              type="button"
              className="rounded-md px-2.5 py-1.5 text-[11px] font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary"
              title="自动安装失败时手动安装"
              onClick={() => {
                const dmgPath = state.dmgPath
                if (dmgPath) void window.electronAPI?.openUpdateInstaller?.(dmgPath)
              }}
            >
              打开安装包
            </button>
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold"
              onClick={() => {
                const dmgPath = state.dmgPath
                if (dmgPath) void window.electronAPI?.installUpdate?.({ dmgPath, version })
              }}
            >
              安装并重启
            </button>
          </>
        )}
        {state.phase === 'error' && (
          <>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary"
              onClick={() => void window.electronAPI?.openReleasePage?.(state.pageUrl)}
            >
              <ExternalLink className="h-3 w-3" />
              前往下载页
            </button>
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold"
              onClick={() => void window.electronAPI?.checkForUpdates?.({ manual: true })}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </button>
          </>
        )}
      </div>
    </div>
  )
}
