import type {
  CreateMockInterviewRequest,
  MockInterviewSession,
} from '@/types/mock-interview'
import { buildApiUrl } from './backendUrl'
import { getAuthToken } from './auth'

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getAuthToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(buildApiUrl(path), {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body
      ? String((body as { detail?: unknown }).detail || '')
      : String(body || '')
    throw new Error(detail || `请求失败 (${res.status})`)
  }
  return body as T
}

export const mockInterviewAPI = {
  listSessions: () =>
    request<{ items: MockInterviewSession[] }>('/api/mock-interview/sessions'),

  createSession: (payload: CreateMockInterviewRequest) =>
    request<MockInterviewSession>('/api/mock-interview/sessions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getSession: (sessionId: number) =>
    request<MockInterviewSession>(`/api/mock-interview/sessions/${sessionId}`),

  startAnswer: (sessionId: number, questionId: string) =>
    request<MockInterviewSession>(`/api/mock-interview/sessions/${sessionId}/start-answer`, {
      method: 'POST',
      body: JSON.stringify({ question_id: questionId }),
    }),

  saveDraft: (sessionId: number, questionId: string, draftText: string) =>
    request<{ ok: boolean; saved_at: number }>(`/api/mock-interview/sessions/${sessionId}/draft`, {
      method: 'PATCH',
      body: JSON.stringify({ question_id: questionId, draft_text: draftText }),
    }),

  submitAnswer: (
    sessionId: number,
    questionId: string,
    answerText: string,
    autoSubmitted: boolean,
  ) =>
    request<{
      assessment: unknown
      ready_to_finish: boolean
      next_question?: unknown
      session: MockInterviewSession
    }>(`/api/mock-interview/sessions/${sessionId}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        question_id: questionId,
        answer_text: answerText,
        auto_submitted: autoSubmitted,
      }),
    }),

  finishSession: (sessionId: number) =>
    request<MockInterviewSession>(`/api/mock-interview/sessions/${sessionId}/finish`, {
      method: 'POST',
    }),

  saveSelfAssessment: (
    sessionId: number,
    rating: number,
    note: string,
    tags: string[],
  ) =>
    request<MockInterviewSession>(`/api/mock-interview/sessions/${sessionId}/self-assessment`, {
      method: 'POST',
      body: JSON.stringify({ rating, note, tags }),
    }),

  deleteSession: (sessionId: number) =>
    request<{ ok: boolean }>(`/api/mock-interview/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
}
