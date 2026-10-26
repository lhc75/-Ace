import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ExternalLink, PackageCheck, RefreshCw } from 'lucide-react'
import { BrandMark } from '@/components/app/BrandMark'
import { useInterviewStore } from '@/stores/configStore'
import type { UpdateStatePayload } from '@/types/electron'

/* Cherry Switch 样式开关 */
function Switch({ checked, onChange, disabled, ariaLabel }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 flex-shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50 ${
        checked ? 'bg-accent-green' : 'bg-text-primary/15'
      }`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[20px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}

/**
 * 设置 → 关于: Cherry「关于我们」式页面 — 品牌卡片 + 版本徽章 + 更新检查 + 自动更新开关 + 更新日志。
 * 仅桌面端可用 (需要 electronAPI)。
 */
export default function AboutTab() {
  const supported = typeof window !== 'undefined' && Boolean(window.electronAPI?.getAppVersion)
  const [version, setVersion] = useState<string | null>(null)
  const [autoCheck, setAutoCheck] = useState(true)
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!supported) return
    void window.electronAPI?.getAppVersion?.().then(setVersion).catch(() => {})
    void window.electronAPI?.getUpdateAutoCheck?.().then(setAutoCheck).catch(() => {})
  }, [supported])

  useEffect(() => {
    if (!supported || !window.electronAPI?.onUpdateState) return
    return window.electronAPI.onUpdateState((payload) => {
      setUpdateState(payload)
      if (payload.phase === 'none') {
        useInterviewStore.getState().pushToast(`当前已是最新版本 (v${payload.version ?? ''})`, 'success')
      }
    })
  }, [supported])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  if (!supported) {
    return (
      <div className="rounded-xl border-[0.5px] border-bg-hover bg-bg-secondary p-5 shadow-sm">
        <div className="flex items-center gap-4">
          <BrandMark className="h-14 w-14 flex-shrink-0 rounded-2xl shadow-sm" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-text-primary">面试Ace</h3>
            <p className="mt-0.5 text-[13px] text-text-muted">你的实时面试辅助助手</p>
          </div>
        </div>
        <p className="mt-4 border-t-[0.5px] border-bg-hover pt-3 text-xs text-text-muted">
          浏览器模式不提供应用更新功能，桌面端可在此检查更新。
        </p>
      </div>
    )
  }

  const checking = updateState?.phase === 'checking'
  const handleCheck = () => {
    if (checking) return
    setUpdateState({ phase: 'checking' })
    void window.electronAPI?.checkForUpdates?.({ manual: true })
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      setUpdateState((prev) => (prev?.phase === 'checking' ? null : prev))
    }, 15000)
  }

  const handleAutoCheckChange = (next: boolean) => {
    setAutoCheck(next)
    void window.electronAPI?.setUpdateAutoCheck?.(next).catch(() => {})
  }

  return (
    <div className="space-y-4">
      {/* 品牌卡片: 图标 + 名称 + 标语 + 版本徽章 + 更新按钮 (Cherry 关于我们) */}
      <div className="rounded-xl border-[0.5px] border-bg-hover bg-bg-secondary p-5 shadow-sm">
        <div className="flex items-center gap-4">
          <BrandMark className="h-14 w-14 flex-shrink-0 rounded-2xl shadow-sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-text-primary">面试Ace</h3>
              {version && (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-strong">
                  v{version}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[13px] text-text-muted">你的实时面试辅助助手</p>
          </div>
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-accent-green px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-all hover:brightness-105 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
            {checking ? '检查中…' : '检查更新'}
          </button>
        </div>

        <div className="mt-4 border-t-[0.5px] border-bg-hover pt-1">
          <div className="flex min-h-11 items-center justify-between gap-4">
            <span className="text-sm text-text-primary">自动检查更新</span>
            <Switch checked={autoCheck} onChange={handleAutoCheckChange} ariaLabel="自动检查更新" />
          </div>
          <p className="-mt-1 pb-2 text-xs text-text-muted">开启后每 6 小时自动检查一次新版本</p>
        </div>
      </div>

      {/* 更新状态卡: 有新版本时显示版本号 + 更新日志 + 升级操作 */}
      {updateState && ['available', 'downloading', 'ready', 'installing', 'restarting', 'error'].includes(updateState.phase) && (
        <div className="rounded-xl border-[0.5px] border-bg-hover bg-bg-secondary p-5 shadow-sm">
          {updateState.phase === 'available' && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">发现新版本 {updateState.version}</span>
                <span className="h-2 w-2 rounded-full bg-accent-green" aria-hidden />
              </div>
              {updateState.notes && (
                <div className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">
                  {updateState.notes}
                </div>
              )}
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  onClick={() => {
                    if (updateState.version) void window.electronAPI?.skipUpdateVersion?.(updateState.version)
                    setUpdateState(null)
                  }}
                >
                  跳过此版本
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent-green px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-all hover:brightness-105"
                  onClick={() => {
                    if (updateState.plan && updateState.version) {
                      void window.electronAPI?.downloadUpdate?.({ plan: updateState.plan, version: updateState.version })
                    }
                  }}
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  立即升级
                </button>
              </div>
            </>
          )}
          {updateState.phase === 'downloading' && (
            <>
              <p className="text-sm font-semibold text-text-primary">正在下载 v{updateState.version}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-hover">
                <div
                  className="h-full rounded-full bg-accent-green transition-[width] duration-200"
                  style={{ width: `${updateState.percent ?? 0}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs tabular-nums text-text-muted">{updateState.percent ?? 0}%</p>
            </>
          )}
          {updateState.phase === 'ready' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <PackageCheck className="h-5 w-5 text-accent-green" />
                  <div>
                    <p className="text-sm font-semibold text-text-primary">v{updateState.version} 已下载完成</p>
                    <p className="mt-0.5 text-xs text-text-muted">点击「安装并重启」，自动完成安装并重启应用。</p>
                  </div>
                </div>
                {updateState.dmgPath && (
                  <button
                    type="button"
                    className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-accent-green px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-all hover:brightness-105"
                    onClick={() => {
                      const dmgPath = updateState.dmgPath
                      if (dmgPath) {
                        void window.electronAPI?.installUpdate?.({ dmgPath, version: updateState.version })
                      }
                    }}
                  >
                    安装并重启
                  </button>
                )}
              </div>
              {updateState.error && (
                <p className="text-xs text-accent-red">自动安装失败：{updateState.error}</p>
              )}
              {updateState.dmgPath && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-primary"
                  onClick={() => {
                    const dmgPath = updateState.dmgPath
                    if (dmgPath) void window.electronAPI?.openUpdateInstaller?.(dmgPath)
                  }}
                >
                  <ExternalLink className="h-3 w-3" />
                  自动安装失败时：打开安装包手动拖入「应用程序」
                </button>
              )}
            </div>
          )}
          {(updateState.phase === 'installing' || updateState.phase === 'restarting') && (
            <div className="flex items-center gap-2.5">
              <RefreshCw className="h-5 w-5 animate-spin text-accent-green" />
              <p className="text-sm font-semibold text-text-primary">
                {updateState.phase === 'installing' ? '正在安装新版本…' : '安装完成，正在重启…'}
              </p>
            </div>
          )}
          {updateState.phase === 'error' && (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">更新检查失败</p>
                <p className="mt-0.5 truncate text-xs text-accent-red" title={updateState.error}>{updateState.error}</p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  onClick={() => void window.electronAPI?.openReleasePage?.(updateState.pageUrl)}
                >
                  <ExternalLink className="h-3 w-3" />
                  前往下载页
                </button>
                <button
                  type="button"
                  className="sd-btn !min-h-[30px] !text-xs"
                  onClick={handleCheck}
                >
                  重试
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
