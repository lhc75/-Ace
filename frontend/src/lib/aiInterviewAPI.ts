// AI面试API封装
import type {
  AIInterviewSession,
  InterviewQuestion,
  AnswerScore,
  STARCompletionGuide,
} from '@/types/ai-interview'
import { buildApiUrl } from './backendUrl'
import { getAuthToken } from './auth'

async function request<T = any>(url: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getAuthToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(buildApiUrl(url), {
    ...opts,
    headers: { ...headers, ...(opts?.headers as Record<string, string> | undefined) },
  })

  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`请求失败 (${res.status}): ${errorText}`)
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

export interface StartAIInterviewRequest {
  position: string
  question_count: number
  difficulty?: 'easy' | 'medium' | 'hard'
  total_time_minutes: number
  enable_star_guide: boolean
  show_timer: boolean
}

export interface SubmitAnswerRequest {
  question_id: string
  answer_text: string
  star_situation?: string
  star_task?: string
  star_action?: string
  star_result?: string
  time_used_seconds: number
}

export const aiInterviewAPI = {
  // 开始AI面试
  async startInterview(req: StartAIInterviewRequest): Promise<{
    session: AIInterviewSession
    guide_message: string
  }> {
    return request('/api/ai-interview/start', {
      method: 'POST',
      body: JSON.stringify(req),
    })
  },

  // 获取当前会话
  async getSession(): Promise<{ session: AIInterviewSession | null }> {
    return request('/api/ai-interview/session')
  },

  // 下一题
  async nextQuestion(): Promise<{
    has_more: boolean
    question?: InterviewQuestion
    session: AIInterviewSession
  }> {
    return request('/api/ai-interview/next-question', { method: 'POST' })
  },

  // 提交答案
  async submitAnswer(req: SubmitAnswerRequest): Promise<{
    score: AnswerScore
    session: AIInterviewSession
  }> {
    return request('/api/ai-interview/submit-answer', {
      method: 'POST',
      body: JSON.stringify(req),
    })
  },

  // 检查STAR完成度
  async checkSTAR(answer_text: string): Promise<{
    star: {
      situation: string
      task: string
      action: string
      result: string
    }
    guide: STARCompletionGuide
  }> {
    return request('/api/ai-interview/check-star', {
      method: 'POST',
      body: JSON.stringify({ answer_text }),
    })
  },

  // 完成面试
  async completeInterview(): Promise<{
    session: AIInterviewSession
    summary: {
      message: string
      comment: string
      statistics: {
        total_questions: number
        average_score: number
        total_score: number
        score_distribution: Record<string, number>
        average_time_seconds: number
        total_time_seconds: number
      }
    }
  }> {
    return request('/api/ai-interview/complete', { method: 'POST' })
  },

  // 重置会话
  async resetSession(): Promise<void> {
    await request('/api/ai-interview/reset', { method: 'POST' })
  },

  // 预览题库
  async previewQuestions(
    position: string,
    count: number = 10,
    difficulty?: 'easy' | 'medium' | 'hard'
  ): Promise<{ questions: InterviewQuestion[] }> {
    const params = new URLSearchParams({ position, count: count.toString() })
    if (difficulty) params.set('difficulty', difficulty)
    return request(`/api/ai-interview/questions/preview?${params}`)
  },
}
