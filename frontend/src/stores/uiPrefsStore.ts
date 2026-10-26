import { create } from 'zustand'
import type { ColorSchemeId } from '@/lib/colorScheme'
import {
  COLOR_SCHEME_STORAGE_KEY,
  readStoredColorScheme,
  applyColorSchemeToDocument,
  applyStoredColorSchemeToDocument,
} from '@/lib/colorScheme'
import {
  INTERVIEW_OVERLAY_PROMPT_DEFAULT_WIDTH,
  INTERVIEW_OVERLAY_PROMPT_MAX_WIDTH,
  INTERVIEW_OVERLAY_PROMPT_MIN_WIDTH,
  INTERVIEW_OVERLAY_STORAGE_KEYS,
  isOverlayMode,
  overlayModeToShowBg,
  showBgToOverlayMode,
  type OverlayMode,
  type OverlayStatePayload,
} from '@/lib/interviewOverlay'

const ANSWER_LAYOUT_KEY = 'ia_answer_panel_layout'
const ASSIST_SPLIT_KEY = 'ia_assist_split_pct'
const ASSIST_TRANSCRIPT_COLLAPSED_KEY = 'ia_assist_transcript_collapsed'
const APP_MODE_KEY = 'ia_app_mode'

type AppMode = 'assist' | 'review' | 'knowledge' | 'resume-opt' | 'job-tracker'
type JobTrackerDeepLink = {
  applicationId: number
  openReviews?: boolean
  highlightReviewId?: number | null
}

export const __UI_PREFS_TEST_KEYS = {
  overlayEnabled: INTERVIEW_OVERLAY_STORAGE_KEYS.enabled,
  overlayOpacity: INTERVIEW_OVERLAY_STORAGE_KEYS.opacity,
  overlayFontSize: INTERVIEW_OVERLAY_STORAGE_KEYS.fontSize,
  overlayFontColor: INTERVIEW_OVERLAY_STORAGE_KEYS.fontColor,
  overlayShowBg: INTERVIEW_OVERLAY_STORAGE_KEYS.showBg,
  overlayMode: INTERVIEW_OVERLAY_STORAGE_KEYS.mode,
  overlayFocusWidthPct: INTERVIEW_OVERLAY_STORAGE_KEYS.focusWidthPct,
  overlayFocusHeightPct: INTERVIEW_OVERLAY_STORAGE_KEYS.focusHeightPct,
  overlayPromptMaxWidth: INTERVIEW_OVERLAY_STORAGE_KEYS.promptMaxWidth,
  overlayPromptAutoFollow: INTERVIEW_OVERLAY_STORAGE_KEYS.promptAutoFollow,
  overlayMaxLines: INTERVIEW_OVERLAY_STORAGE_KEYS.maxLines,
}

const APP_MODE_VALUES: ReadonlySet<AppMode> = new Set([
  'assist',
  'review',
  'knowledge',
  'resume-opt',
  'job-tracker',
])

/* ── localStorage 读取/归一化助手 ─────────────────────────────
 * 所有 read* 共享同一模式: 缺失或非法值回退 fallback, 数值夹取到 [min, max]。 */

function readStoredNumber(key: string, fallback: number, min: number, max: number, round = true): number {
  try {
    const raw = localStorage.getItem(key)
    const value = raw == null ? fallback : Number(raw)
    if (Number.isFinite(value)) {
      const next = round ? Math.round(value) : value
      return Math.max(min, Math.min(max, next))
    }
  } catch {
    /* ignore */
  }
  return fallback
}

function readStoredFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    /* ignore */
  }
  return false
}

function clampNumberOrNull(value: unknown, min: number, max: number, round = true): number | null {
  const next = Number(value)
  if (!Number.isFinite(next)) return null
  const clamped = round ? Math.round(next) : next
  return Math.max(min, Math.min(max, clamped))
}

function readAppMode(): AppMode {
  try {
    const v = localStorage.getItem(APP_MODE_KEY)
    if (v && APP_MODE_VALUES.has(v as AppMode)) return v as AppMode
  } catch {
    /* ignore */
  }
  return 'assist'
}

function readAnswerPanelLayout(): 'cards' | 'stream' {
  try {
    const v = localStorage.getItem(ANSWER_LAYOUT_KEY)
    if (v === 'stream' || v === 'cards') return v
  } catch {
    /* ignore */
  }
  return 'cards'
}

function readOverlayFontColor(): string {
  try {
    const raw = localStorage.getItem(INTERVIEW_OVERLAY_STORAGE_KEYS.fontColor)
    if (raw && /^#[0-9a-fA-F]{6}$/.test(raw)) return raw
  } catch { /* ignore */ }
  return '#e2e8f0'
}

function readOverlayMode(): OverlayMode {
  try {
    const raw = localStorage.getItem(INTERVIEW_OVERLAY_STORAGE_KEYS.mode)
    if (isOverlayMode(raw)) return raw
  } catch { /* ignore */ }
  // 旧版只有 showBg 布尔开关, 迁移为 mode
  let legacyShowBg = true
  try {
    if (localStorage.getItem(INTERVIEW_OVERLAY_STORAGE_KEYS.showBg) === '0') legacyShowBg = false
  } catch { /* ignore */ }
  return showBgToOverlayMode(legacyShowBg)
}

function persistOverlayPref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('interview-overlay-prefs-updated'))
}

function persistOverlayPrefSilently(key: string, value: string) {
  try {
    if (localStorage.getItem(key) === value) return
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

interface UiPrefsState {
  appMode: AppMode
  jobTrackerDeepLink: JobTrackerDeepLink | null
  reviewDeepLinkSessionId: number | null
  setAppMode: (mode: AppMode) => void
  setJobTrackerDeepLink: (payload: JobTrackerDeepLink | null) => void
  clearJobTrackerDeepLink: () => void
  setReviewDeepLinkSessionId: (sessionId: number | null) => void
  clearReviewDeepLinkSessionId: () => void
  answerPanelLayout: 'cards' | 'stream'
  colorScheme: ColorSchemeId
  assistSplitPct: number
  assistTranscriptCollapsed: boolean

  interviewOverlayEnabled: boolean
  interviewOverlayOpacity: number
  interviewOverlayFontSize: number
  interviewOverlayFontColor: string
  interviewOverlayShowBg: boolean
  interviewOverlayMode: OverlayMode
  interviewOverlayFocusWidthPct: number
  interviewOverlayFocusHeightPct: number
  interviewOverlayPromptMaxWidth: number
  interviewOverlayPromptAutoFollow: boolean
  interviewOverlayMaxLines: number
  interviewOverlayVisible: boolean

  setAnswerPanelLayout: (layout: 'cards' | 'stream') => void
  setColorScheme: (id: ColorSchemeId) => void
  setAssistSplitPct: (pct: number) => void
  persistAssistSplitPct: (pct: number) => void
  toggleAssistTranscriptCollapsed: () => void

  setInterviewOverlayEnabled: (enabled: boolean) => void
  setInterviewOverlayOpacity: (opacity: number) => void
  setInterviewOverlayFontSize: (size: number) => void
  setInterviewOverlayFontColor: (color: string) => void
  setInterviewOverlayMode: (mode: OverlayMode) => void
  setInterviewOverlayFocusWidthPct: (pct: number) => void
  setInterviewOverlayFocusHeightPct: (pct: number) => void
  setInterviewOverlayPromptMaxWidth: (width: number) => void
  setInterviewOverlayPromptAutoFollow: (enabled: boolean) => void
  setInterviewOverlayMaxLines: (lines: number) => void
  syncInterviewOverlayPrefs: () => void
  applyInterviewOverlayState: (payload: OverlayStatePayload, options?: { persistStyle?: boolean }) => void
}

function clampAssistSplitPct(value: number): number {
  return Math.min(62, Math.max(24, value))
}

const KEYS = INTERVIEW_OVERLAY_STORAGE_KEYS

const readOverlayEnabled = () => readStoredFlag(KEYS.enabled)
const readOverlayOpacity = () => readStoredNumber(KEYS.opacity, 0.88, 0, 1, false)
const readOverlayFontSize = () => readStoredNumber(KEYS.fontSize, 14, 10, 48)
const readOverlayShowBg = () => overlayModeToShowBg(readOverlayMode())
const readOverlayFocusWidthPct = () => readStoredNumber(KEYS.focusWidthPct, 96, 50, 100)
const readOverlayFocusHeightPct = () => readStoredNumber(KEYS.focusHeightPct, 90, 35, 100)
const readOverlayPromptMaxWidth = () =>
  readStoredNumber(KEYS.promptMaxWidth, INTERVIEW_OVERLAY_PROMPT_DEFAULT_WIDTH, INTERVIEW_OVERLAY_PROMPT_MIN_WIDTH, INTERVIEW_OVERLAY_PROMPT_MAX_WIDTH)
const readOverlayPromptAutoFollow = () => readStoredFlag(KEYS.promptAutoFollow)
const readOverlayMaxLines = () => readStoredNumber(KEYS.maxLines, 0, 0, 50)

export const useUiPrefsStore = create<UiPrefsState>((set) => ({
  appMode: readAppMode(),
  jobTrackerDeepLink: null,
  reviewDeepLinkSessionId: null,
  setAppMode: (mode) => {
    if (!APP_MODE_VALUES.has(mode)) return
    try {
      localStorage.setItem(APP_MODE_KEY, mode)
    } catch {
      /* ignore */
    }
    set({ appMode: mode })
  },
  setJobTrackerDeepLink: (payload) => set({ jobTrackerDeepLink: payload }),
  clearJobTrackerDeepLink: () => set({ jobTrackerDeepLink: null }),
  setReviewDeepLinkSessionId: (sessionId) => set({ reviewDeepLinkSessionId: sessionId }),
  clearReviewDeepLinkSessionId: () => set({ reviewDeepLinkSessionId: null }),
  answerPanelLayout: readAnswerPanelLayout(),
  colorScheme: readStoredColorScheme(),
  assistSplitPct: clampAssistSplitPct(readStoredNumber(ASSIST_SPLIT_KEY, 32, 24, 62, false)),
  assistTranscriptCollapsed: readStoredFlag(ASSIST_TRANSCRIPT_COLLAPSED_KEY),

  interviewOverlayEnabled: readOverlayEnabled(),
  interviewOverlayOpacity: readOverlayOpacity(),
  interviewOverlayFontSize: readOverlayFontSize(),
  interviewOverlayFontColor: readOverlayFontColor(),
  interviewOverlayShowBg: readOverlayShowBg(),
  interviewOverlayMode: readOverlayMode(),
  interviewOverlayFocusWidthPct: readOverlayFocusWidthPct(),
  interviewOverlayFocusHeightPct: readOverlayFocusHeightPct(),
  interviewOverlayPromptMaxWidth: readOverlayPromptMaxWidth(),
  interviewOverlayPromptAutoFollow: readOverlayPromptAutoFollow(),
  interviewOverlayMaxLines: readOverlayMaxLines(),
  interviewOverlayVisible: false,

  setAnswerPanelLayout: (layout) => {
    try {
      localStorage.setItem(ANSWER_LAYOUT_KEY, layout)
    } catch {
      /* ignore */
    }
    set({ answerPanelLayout: layout })
  },
  setColorScheme: (id) => {
    try {
      localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
    applyColorSchemeToDocument(id)
    set({ colorScheme: id })
  },
  setAssistSplitPct: (pct) => {
    const next = clampAssistSplitPct(pct)
    set((state) => (state.assistSplitPct === next ? state : { assistSplitPct: next }))
  },
  persistAssistSplitPct: (pct) => {
    const next = clampAssistSplitPct(pct)
    try {
      localStorage.setItem(ASSIST_SPLIT_KEY, String(Math.round(next * 10) / 10))
    } catch {
      /* ignore */
    }
    set((state) => (state.assistSplitPct === next ? state : { assistSplitPct: next }))
  },
  toggleAssistTranscriptCollapsed: () => {
    set((state) => {
      const next = !state.assistTranscriptCollapsed
      try {
        localStorage.setItem(ASSIST_TRANSCRIPT_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return { assistTranscriptCollapsed: next }
    })
  },

  setInterviewOverlayEnabled: (enabled) => {
    persistOverlayPref(KEYS.enabled, enabled ? '1' : '0')
    set({ interviewOverlayEnabled: enabled })
  },
  setInterviewOverlayOpacity: (opacity) => {
    const next = clampNumberOrNull(opacity, 0, 1, false) ?? 0.88
    persistOverlayPref(KEYS.opacity, String(next))
    set({ interviewOverlayOpacity: next })
  },
  setInterviewOverlayFontSize: (size) => {
    const next = clampNumberOrNull(size, 10, 48) ?? 14
    persistOverlayPref(KEYS.fontSize, String(next))
    set({ interviewOverlayFontSize: next })
  },
  setInterviewOverlayFontColor: (color) => {
    const next = typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#e2e8f0'
    persistOverlayPref(KEYS.fontColor, next)
    set({ interviewOverlayFontColor: next })
  },
  setInterviewOverlayMode: (mode) => {
    const next = isOverlayMode(mode) ? mode : 'glass'
    const showBg = overlayModeToShowBg(next)
    persistOverlayPref(KEYS.mode, next)
    persistOverlayPref(KEYS.showBg, showBg ? '1' : '0')
    set({ interviewOverlayMode: next, interviewOverlayShowBg: showBg })
  },
  setInterviewOverlayFocusWidthPct: (pct) => {
    const next = clampNumberOrNull(pct, 50, 100) ?? 96
    persistOverlayPref(KEYS.focusWidthPct, String(next))
    set({ interviewOverlayFocusWidthPct: next })
  },
  setInterviewOverlayFocusHeightPct: (pct) => {
    const next = clampNumberOrNull(pct, 35, 100) ?? 90
    persistOverlayPref(KEYS.focusHeightPct, String(next))
    set({ interviewOverlayFocusHeightPct: next })
  },
  setInterviewOverlayPromptMaxWidth: (width) => {
    const next = clampNumberOrNull(width, INTERVIEW_OVERLAY_PROMPT_MIN_WIDTH, INTERVIEW_OVERLAY_PROMPT_MAX_WIDTH) ?? INTERVIEW_OVERLAY_PROMPT_DEFAULT_WIDTH
    persistOverlayPref(KEYS.promptMaxWidth, String(next))
    set({ interviewOverlayPromptMaxWidth: next })
  },
  setInterviewOverlayPromptAutoFollow: (enabled) => {
    const next = typeof enabled === 'boolean' ? enabled : false
    persistOverlayPref(KEYS.promptAutoFollow, next ? '1' : '0')
    set({ interviewOverlayPromptAutoFollow: next })
  },
  setInterviewOverlayMaxLines: (lines) => {
    const next = clampNumberOrNull(lines, 0, 50) ?? 0
    persistOverlayPref(KEYS.maxLines, String(next))
    set({ interviewOverlayMaxLines: next })
  },

  syncInterviewOverlayPrefs: () =>
    set({
      interviewOverlayEnabled: readOverlayEnabled(),
      interviewOverlayOpacity: readOverlayOpacity(),
      interviewOverlayFontSize: readOverlayFontSize(),
      interviewOverlayFontColor: readOverlayFontColor(),
      interviewOverlayShowBg: readOverlayShowBg(),
      interviewOverlayMode: readOverlayMode(),
      interviewOverlayFocusWidthPct: readOverlayFocusWidthPct(),
      interviewOverlayFocusHeightPct: readOverlayFocusHeightPct(),
      interviewOverlayPromptMaxWidth: readOverlayPromptMaxWidth(),
      interviewOverlayPromptAutoFollow: readOverlayPromptAutoFollow(),
      interviewOverlayMaxLines: readOverlayMaxLines(),
    }),
  applyInterviewOverlayState: (payload, options = {}) => {
    const shouldApplyStyle = options.persistStyle === true || payload.initialized === true
    const visible = typeof payload.visible === 'boolean' ? payload.visible : null
    const enabled = shouldApplyStyle && typeof payload.enabled === 'boolean' ? payload.enabled : null
    const opacity = shouldApplyStyle ? clampNumberOrNull(payload.opacity, 0, 1, false) : null
    const fontSize = shouldApplyStyle ? clampNumberOrNull(payload.fontSize, 10, 48) : null
    const fontColor =
      shouldApplyStyle && typeof payload.fontColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.fontColor)
        ? payload.fontColor
        : null
    const payloadMode = shouldApplyStyle && isOverlayMode(payload.mode) ? payload.mode : null
    const payloadShowBg = shouldApplyStyle && typeof payload.showBg === 'boolean' ? payload.showBg : null
    const mode = payloadMode ?? (payloadShowBg === null ? null : showBgToOverlayMode(payloadShowBg))
    const showBg = mode === null ? null : overlayModeToShowBg(mode)
    const focusWidthPct = shouldApplyStyle ? clampNumberOrNull(payload.focusWidthPct, 50, 100) : null
    const focusHeightPct = shouldApplyStyle ? clampNumberOrNull(payload.focusHeightPct, 35, 100) : null
    const promptMaxWidth = shouldApplyStyle
      ? clampNumberOrNull(payload.promptMaxWidth, INTERVIEW_OVERLAY_PROMPT_MIN_WIDTH, INTERVIEW_OVERLAY_PROMPT_MAX_WIDTH)
      : null
    const promptAutoFollow = shouldApplyStyle && typeof payload.promptAutoFollow === 'boolean' ? payload.promptAutoFollow : null
    const maxLines = shouldApplyStyle ? clampNumberOrNull(payload.maxLines, 0, 50) : null

    if (enabled !== null) persistOverlayPrefSilently(KEYS.enabled, enabled ? '1' : '0')
    if (opacity !== null) persistOverlayPrefSilently(KEYS.opacity, String(opacity))
    if (fontSize !== null) persistOverlayPrefSilently(KEYS.fontSize, String(fontSize))
    if (fontColor !== null) persistOverlayPrefSilently(KEYS.fontColor, fontColor)
    if (mode !== null) persistOverlayPrefSilently(KEYS.mode, mode)
    if (showBg !== null) persistOverlayPrefSilently(KEYS.showBg, showBg ? '1' : '0')
    if (focusWidthPct !== null) persistOverlayPrefSilently(KEYS.focusWidthPct, String(focusWidthPct))
    if (focusHeightPct !== null) persistOverlayPrefSilently(KEYS.focusHeightPct, String(focusHeightPct))
    if (promptMaxWidth !== null) persistOverlayPrefSilently(KEYS.promptMaxWidth, String(promptMaxWidth))
    if (promptAutoFollow !== null) persistOverlayPrefSilently(KEYS.promptAutoFollow, promptAutoFollow ? '1' : '0')
    if (maxLines !== null) persistOverlayPrefSilently(KEYS.maxLines, String(maxLines))

    set((state) => ({
      interviewOverlayEnabled: enabled ?? state.interviewOverlayEnabled,
      interviewOverlayOpacity: opacity ?? state.interviewOverlayOpacity,
      interviewOverlayFontSize: fontSize ?? state.interviewOverlayFontSize,
      interviewOverlayFontColor: fontColor ?? state.interviewOverlayFontColor,
      interviewOverlayShowBg: showBg ?? state.interviewOverlayShowBg,
      interviewOverlayMode: mode ?? state.interviewOverlayMode,
      interviewOverlayFocusWidthPct: focusWidthPct ?? state.interviewOverlayFocusWidthPct,
      interviewOverlayFocusHeightPct: focusHeightPct ?? state.interviewOverlayFocusHeightPct,
      interviewOverlayPromptMaxWidth: promptMaxWidth ?? state.interviewOverlayPromptMaxWidth,
      interviewOverlayPromptAutoFollow: promptAutoFollow ?? state.interviewOverlayPromptAutoFollow,
      interviewOverlayMaxLines: maxLines ?? state.interviewOverlayMaxLines,
      interviewOverlayVisible: visible ?? state.interviewOverlayVisible,
    }))
  },
}))

applyStoredColorSchemeToDocument()
