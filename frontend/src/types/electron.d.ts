import type { OverlayStatePayload } from '@/lib/interviewOverlay'

export {}

export interface UpdateDownloadPlan {
  fileName: string
  urls: string[]
}

export interface UpdateStatePayload {
  phase: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'installing' | 'restarting' | 'error'
  version?: string
  notes?: string
  plan?: UpdateDownloadPlan
  percent?: number
  dmgPath?: string
  error?: string
  pageUrl?: string
}

declare global {
  interface Window {
    electronAPI?: {
    minimizeWindow: () => Promise<void>
    quitApp: () => Promise<void>
      askFromServerScreen?: (payload?: { override_think_mode?: boolean }) => Promise<unknown>
      getShortcuts: () => Promise<Record<string, { action: string; key: string; defaultKey: string; label: string; category: string; status?: string }>>
      updateShortcuts: (shortcuts: Array<{ action: string; key: string }>) => Promise<{ ok: boolean; error?: string; shortcuts: Record<string, unknown> }>
      resetShortcuts: () => Promise<{ ok: boolean; error?: string; shortcuts: Record<string, unknown> }>
      syncOverlayWindow?: (payload: Partial<OverlayStatePayload> & { visible?: boolean }) => Promise<{ ok: boolean; visible: boolean }>
      resizeOverlayWindow?: (payload: { width?: number; height?: number }) => Promise<{ ok: boolean; width?: number; height?: number; skipped?: boolean }>
      destroyOverlay?: () => Promise<{ ok: boolean }>
      getOverlayState?: () => Promise<(OverlayStatePayload & { visible: boolean }) | null>
      onOverlayState?: (callback: (payload: OverlayStatePayload) => void) => (() => void)
      onShortcuts?: (callback: (payload: Record<string, Record<string, unknown>> | undefined) => void) => (() => void)
      onFocusTabCommand?: (callback: (direction: 'prev' | 'next') => void) => (() => void)
      onOverlayQuestionCommand?: (callback: (direction: 'prev' | 'next') => void) => (() => void)
      onDesktopToast?: (callback: (payload: { message: string; level?: 'info' | 'success' | 'warn' | 'error' } | string) => void) => (() => void)
      onConfigUpdated?: (callback: (payload: Record<string, unknown>) => void) => (() => void)
      getAppVersion?: () => Promise<string>
      getUpdateAutoCheck?: () => Promise<boolean>
      setUpdateAutoCheck?: (enabled: boolean) => Promise<boolean>
      checkForUpdates?: (opts?: { manual?: boolean }) => Promise<void>
      downloadUpdate?: (payload: { plan: UpdateDownloadPlan; version: string }) => Promise<void>
      openUpdateInstaller?: (dmgPath: string) => Promise<string>
      installUpdate?: (payload: { dmgPath: string; version?: string }) => Promise<{ ok: boolean; error?: string }>
      openReleasePage?: (pageUrl?: string) => Promise<void>
      skipUpdateVersion?: (version: string) => Promise<void>
      onUpdateState?: (callback: (payload: UpdateStatePayload) => void) => (() => void)
    }
  }
}
