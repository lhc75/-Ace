/** 面试Ace 配色方案 id（与 index.css / data-theme 一致） */
const COLOR_SCHEME_IDS = [
  'ace-light',
  'ace-dark',
  'ace-hc',
  'nord',
  'editorial-glass',
  'solarized-dark',
] as const

export type ColorSchemeId = typeof COLOR_SCHEME_IDS[number]

/** localStorage key，与 index.html 内联脚本一致 */
export const COLOR_SCHEME_STORAGE_KEY = 'ia-color-scheme'
const DEFAULT_COLOR_SCHEME_ID: ColorSchemeId = 'ace-light'

export const COLOR_SCHEME_OPTIONS: { id: ColorSchemeId; label: string; hint: string }[] = [
  { id: 'ace-light', label: '霁白', hint: '默认浅色，冷白纸面 + 霁蓝强调，日间作答首选' },
  { id: 'ace-dark', label: '墨夜', hint: '品牌深色，墨蓝黑底 + 亮霁蓝，夜间低刺激' },
  { id: 'ace-hc', label: '高对比', hint: '黑底高对比，低视力 / 强光场景' },
  { id: 'nord', label: 'Nord', hint: '北欧冷灰蓝，低饱和长时间作答不累眼' },
  { id: 'editorial-glass', label: '纸墨', hint: '纸感留白与玻璃层次，适合阅读' },
  { id: 'solarized-dark', label: 'Solarized Dark', hint: '经典暖黄护眼深色，弱蓝光夜间友好' },
]

function isColorSchemeId(value: unknown): value is ColorSchemeId {
  return typeof value === 'string' && (COLOR_SCHEME_IDS as readonly string[]).includes(value)
}

function resolveColorSchemeId(value: unknown): ColorSchemeId {
  return isColorSchemeId(value) ? value : DEFAULT_COLOR_SCHEME_ID
}

export function readStoredColorScheme(): ColorSchemeId {
  try {
    return resolveColorSchemeId(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY))
  } catch {
    return DEFAULT_COLOR_SCHEME_ID
  }
}

export function applyColorSchemeToDocument(id: ColorSchemeId) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', id)
}

export function applyStoredColorSchemeToDocument(): ColorSchemeId {
  const id = readStoredColorScheme()
  applyColorSchemeToDocument(id)
  return id
}

export function isLightColorScheme(id: ColorSchemeId): boolean {
  return id === 'ace-light' || id === 'editorial-glass'
}
