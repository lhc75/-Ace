// AI面试相关类型定义

export type QuestionType = 'technical' | 'project' | 'behavioral' | 'algorithm' | 'system_design'

export type InterviewPhase = 'init' | 'guide' | 'questioning' | 'answering' | 'scoring' | 'feedback' | 'completed'

export type DifficultyLevel = 'easy' | 'medium' | 'hard'

export interface STARTemplate {
  situation: string
  task: string
  action: string
  result: string
}

export interface AnswerScore {
  score: number // 3/4/5分
  completeness: number
  relevance: number
  depth: number
  structure: number
  has_key_points: boolean
  has_examples: boolean
  has_quantitative_data: boolean
  length_appropriate: boolean
  improvement_suggestions: string[]
  missing_points: string[]
}

export interface InterviewQuestion {
  id: string
  type: QuestionType
  content: string
  category: string
  difficulty: DifficultyLevel
  time_limit_seconds: number
  requires_star: boolean
  key_points: string[]
  reference_answer: string
}

export interface InterviewAnswer {
  question_id: string
  answer_text: string
  star_data?: STARTemplate
  score?: AnswerScore
  time_used_seconds: number
  timestamp: number
}

export interface AIInterviewSession {
  session_id: string
  phase: InterviewPhase
  current_question_index: number
  questions: InterviewQuestion[]
  answers: InterviewAnswer[]
  position: string
  total_time_limit_seconds: number
  show_timer: boolean
  enable_star_guide: boolean
  start_time: number
  is_active: boolean
  total_score: number
  average_score: number
  elapsed_time: number
  remaining_time: number
}

export interface STARGuideSection {
  title: string
  filled: boolean
  valid: boolean | null
  message: string
  prompt: string
  examples: string[]
}

export interface STARCompletionGuide {
  completion_score: number
  is_complete: boolean
  next_section: string | null
  sections: {
    situation: STARGuideSection
    task: STARGuideSection
    action: STARGuideSection
    result: STARGuideSection
  }
}
