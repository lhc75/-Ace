export type MockInterviewStatus =
  | 'in_progress'
  | 'ready_to_finish'
  | 'completed'
  | 'failed'

export type MockQuestionCategory =
  | 'resume_project'
  | 'technical'
  | 'behavioral'
  | 'scenario'
  | 'motivation'

export type MockQuestionKind = 'main' | 'followup'
export type MockQuestionPhase = 'pending' | 'thinking' | 'answering' | 'submitted_pending_eval' | 'evaluated'

export interface MockInterviewEvaluation {
  score: number
  strengths: string[]
  risks: string[]
  improvement: string
  follow_up_question?: string | null
  follow_up_reason?: string | null
  follow_up_time_limit_seconds?: number
}

export interface MockInterviewQuestion {
  id: string
  session_id: number
  main_index: number
  turn_index: number | null
  kind: MockQuestionKind
  parent_id: string | null
  category: MockQuestionCategory
  question_text: string
  answer_time_limit_seconds: number
  prep_seconds: number
  phase: MockQuestionPhase
  prep_started_at: number | null
  answer_started_at: number | null
  answer_deadline_at: number | null
  draft_text: string
  answer_text: string
  auto_submitted: boolean
  score: number | null
  evaluation: MockInterviewEvaluation | Record<string, never>
  asked_at: number | null
  answered_at: number | null
}

export interface MockInterviewDimension {
  key: string
  label: string
  score: number
  weight: number
}

export interface MockInterviewQuestionReview {
  question_id: string
  kind: MockQuestionKind
  main_index: number
  category: MockQuestionCategory
  question: string
  answer: string
  score: number
  strengths: string[]
  risks: string[]
  improvement: string
}

export interface MockInterviewReport {
  total_score: number
  dimensions: MockInterviewDimension[]
  summary_markdown: string
  strengths: string[]
  risks: string[]
  improvements: string[]
  next_practice_plan: string[]
  question_reviews: MockInterviewQuestionReview[]
  answered_count: number
  main_question_target: number
  max_follow_ups: number
}

export interface MockInterviewSession {
  id: number
  status: MockInterviewStatus
  position: string
  company: string
  job_description: string
  difficulty: 'easy' | 'medium' | 'hard'
  focus: 'balanced' | 'technical' | 'comprehensive'
  resume_filename: string
  model_name: string
  main_index: number
  turn_count: number
  current_question_id: string | null
  total_score: number | null
  report: MockInterviewReport | null
  self_rating: number | null
  self_note: string
  self_tags: string[]
  error_message: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  has_resume: boolean
  main_question_target: number
  max_follow_ups: number
  answered_count: number
  main_answered_count: number
  current_question: MockInterviewQuestion | null
  questions: MockInterviewQuestion[]
}

export interface CreateMockInterviewRequest {
  position: string
  company: string
  job_description: string
  difficulty: 'easy' | 'medium' | 'hard'
  focus: 'balanced' | 'technical' | 'comprehensive'
}
