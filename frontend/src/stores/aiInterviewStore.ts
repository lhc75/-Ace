import { create } from 'zustand'
import type {
  AIInterviewSession,
  InterviewQuestion,
  AnswerScore,
  STARTemplate,
  STARCompletionGuide,
} from '@/types/ai-interview'

interface AIInterviewState {
  // 会话状态
  session: AIInterviewSession | null
  currentQuestion: InterviewQuestion | null

  // UI状态
  isLoading: boolean
  error: string | null
  showSTARGuide: boolean

  // 当前答案状态
  currentAnswer: string
  currentSTAR: STARTemplate | null
  starGuide: STARCompletionGuide | null

  // 倒计时
  timeRemaining: number
  timerRunning: boolean

  // Actions
  setSession: (session: AIInterviewSession | null) => void
  setCurrentQuestion: (question: InterviewQuestion | null) => void
  setIsLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setShowSTARGuide: (show: boolean) => void
  setCurrentAnswer: (answer: string) => void
  setCurrentSTAR: (star: STARTemplate | null) => void
  setSTARGuide: (guide: STARCompletionGuide | null) => void
  setTimeRemaining: (time: number) => void
  setTimerRunning: (running: boolean) => void

  // 复合操作
  startTimer: () => void
  stopTimer: () => void
  resetCurrentAnswer: () => void
  resetSession: () => void
}

export const useAIInterviewStore = create<AIInterviewState>((set, get) => ({
  // 初始状态
  session: null,
  currentQuestion: null,
  isLoading: false,
  error: null,
  showSTARGuide: false,
  currentAnswer: '',
  currentSTAR: null,
  starGuide: null,
  timeRemaining: 0,
  timerRunning: false,

  // Setters
  setSession: (session) => set({ session }),
  setCurrentQuestion: (question) => set({ currentQuestion: question }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  setShowSTARGuide: (show) => set({ showSTARGuide: show }),
  setCurrentAnswer: (answer) => set({ currentAnswer: answer }),
  setCurrentSTAR: (star) => set({ currentSTAR: star }),
  setSTARGuide: (guide) => set({ starGuide: guide }),
  setTimeRemaining: (time) => set({ timeRemaining: time }),
  setTimerRunning: (running) => set({ timerRunning: running }),

  // 复合操作
  startTimer: () => {
    const { currentQuestion } = get()
    if (!currentQuestion) return

    set({
      timeRemaining: currentQuestion.time_limit_seconds,
      timerRunning: true,
    })
  },

  stopTimer: () => {
    set({ timerRunning: false })
  },

  resetCurrentAnswer: () => {
    set({
      currentAnswer: '',
      currentSTAR: null,
      starGuide: null,
      timeRemaining: 0,
      timerRunning: false,
    })
  },

  resetSession: () => {
    set({
      session: null,
      currentQuestion: null,
      isLoading: false,
      error: null,
      showSTARGuide: false,
      currentAnswer: '',
      currentSTAR: null,
      starGuide: null,
      timeRemaining: 0,
      timerRunning: false,
    })
  },
}))
