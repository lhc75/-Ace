export const THINK_EFFORT_OPTIONS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

type ThinkEffort = typeof THINK_EFFORT_OPTIONS[number]

const THINK_EFFORT_LABELS: Record<ThinkEffort, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultra: '极限',
}

export function normalizeThinkEffort(value: unknown): ThinkEffort {
  const normalized = String(value ?? '').trim().toLowerCase()
  return THINK_EFFORT_OPTIONS.includes(normalized as ThinkEffort)
    ? normalized as ThinkEffort
    : 'off'
}

export function thinkEffortLabel(value: unknown): string {
  const effort = normalizeThinkEffort(value)
  if (effort === 'off') return THINK_EFFORT_LABELS.off
  return `${THINK_EFFORT_LABELS[effort]} · ${effort}`
}
