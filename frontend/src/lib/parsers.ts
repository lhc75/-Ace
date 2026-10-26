/**
 * 跨模块共享的宽容解析工具: 后端 JSON 字段类型不稳定, 统一在这里做兜底转换。
 * review/types.ts 与 job-tracker/types.ts 原先各存一份。
 */

export function finiteNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseNumber(value: unknown, fallback = 0): number {
  return finiteNumber(value) ?? fallback
}

export function parseNullableNumber(value: unknown): number | null {
  return finiteNumber(value)
}

export interface VisionVerifyResult {
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN'
  reason: string
}

/** 解析截图自检结果(实时答案卡与复盘详情共用), 非法输入返回 undefined */
export function parseVisionVerify(raw: unknown): VisionVerifyResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const data = raw as { verdict?: unknown; reason?: unknown }
  const verdict = String(data.verdict || '').toUpperCase()
  if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'UNKNOWN') return undefined
  return { verdict, reason: String(data.reason ?? '').trim() }
}
