import dayjs from 'dayjs'

/** 日期输入框 <-> unix 秒 转换（job-tracker 共用） */

export function toDateInput(unix: number | null): string {
  return unix != null ? dayjs.unix(Math.floor(unix)).format('YYYY-MM-DD') : ''
}

export function fromDateInput(value: string): number | null {
  return value ? dayjs(value).startOf('day').unix() : null
}

export function formatDate(unix: number | null, fallback = '--') {
  return unix != null ? dayjs.unix(Math.floor(unix)).format('YYYY-MM-DD') : fallback
}
