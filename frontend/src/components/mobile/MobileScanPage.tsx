import MobileInterviewOverlay from '@/components/mobile/MobileInterviewOverlay'
import { requestInterviewOverlayPip } from '@/lib/interviewOverlay'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

type ScanMode = 'ai-interview' | 'assist'

export default function MobileScanPage() {
  const appMode = useUiPrefsStore((s) => s.appMode)
  const setAppMode = useUiPrefsStore((s) => s.setAppMode)
  const overlayMode = useUiPrefsStore((s) => s.interviewOverlayMode)
  const selectedMode: ScanMode = appMode === 'ai-interview' ? 'ai-interview' : 'assist'
  const isFocusSurface = overlayMode === 'focus'

  const selectMode = (mode: ScanMode) => {
    setAppMode(mode)
    requestInterviewOverlayPip()
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('mode', mode)
      window.history.replaceState(null, '', url)
    } catch {
      /* URL updates are cosmetic for the scan page. */
    }
  }

  const toolbar = (
    <div className={`px-2.5 py-2 ${
      isFocusSurface ? 'text-slate-700' : 'text-slate-100'
    }`}>
      <div
        role="tablist"
        aria-label="选择手机辅助模式"
        className={`grid grid-cols-2 gap-1 rounded-lg p-1 ${
          isFocusSurface ? 'bg-slate-200/80' : 'bg-black/20'
        }`}
      >
        {([
          ['ai-interview', 'AI 面试'],
          ['assist', '实时辅助'],
        ] as const).map(([mode, label]) => {
          const active = selectedMode === mode
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectMode(mode)}
              className={`rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                active
                  ? isFocusSurface
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'bg-white/15 text-white'
                  : isFocusSurface
                    ? 'text-slate-500 hover:text-slate-800'
                    : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className="min-h-[100dvh] bg-bg-primary" data-testid="mobile-scan-page">
      <MobileInterviewOverlay
        forceEnabled
        expanded
        showClose={false}
        positionClassName="top-4"
        toolbar={toolbar}
        title={selectedMode === 'ai-interview' ? 'AI 面试实时答案' : '实时辅助答案'}
      />
    </div>
  )
}
