// AI面试API封装
import { api } from './api'
import type {
  AIInterviewSession,
  InterviewQuestion,
  AnswerScore,
  STARCompletionGuide,
} from '@/types/ai-interview'

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
    const response = await api.post('/ai-interview/start', req)
    return response.data
  },

  // 获取当前会话
  async getSession(): Promise<{ session: AIInterviewSession | null }> {
    const response = await api.get('/ai-interview/session')
    return response.data
  },

  // 下一题
  async nextQuestion(): Promise<{
    has_more: boolean
    question?: InterviewQuestion
    session: AIInterviewSession
  }> {
    const response = await api.post('/ai-interview/next-question')
    return response.data
  },

  // 提交答案
  async submitAnswer(req: SubmitAnswerRequest): Promise<{
    score: AnswerScore
    session: AIInterviewSession
  }> {
    const response = await api.post('/ai-interview/submit-answer', req)
    return response.data
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
    const response = await api.post('/ai-interview/check-star', { answer_text })
    return response.data
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
    const response = await api.post('/ai-interview/complete')
    return response.data
  },

  // 重置会话
  async resetSession(): Promise<void> {
    await api.post('/ai-interview/reset')
  },

  // 预览题库
  async previewQuestions(
    position: string,
    count: number = 10,
    difficulty?: 'easy' | 'medium' | 'hard'
  ): Promise<{ questions: InterviewQuestion[] }> {
    const params = new URLSearchParams({ position, count: count.toString() })
    if (difficulty) params.set('difficulty', difficulty)
    const response = await api.get(`/ai-interview/questions/preview?${params}`)
    return response.data
  },
}
