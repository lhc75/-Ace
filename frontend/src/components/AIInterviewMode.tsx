import { useState, useEffect, useCallback } from 'react'
import { useAIInterviewStore } from '@/stores/aiInterviewStore'
import { aiInterviewAPI } from '@/lib/aiInterviewAPI'
import type { StartAIInterviewRequest, SubmitAnswerRequest } from '@/lib/aiInterviewAPI'
import {
  Play,
  Clock,
  Trophy,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  RotateCcw,
  Home,
} from 'lucide-react'

export default function AIInterviewMode() {
  const {
    session,
    currentQuestion,
    isLoading,
    error,
    currentAnswer,
    showSTARGuide,
    starGuide,
    timeRemaining,
    timerRunning,
    setSession,
    setCurrentQuestion,
    setIsLoading,
    setError,
    setCurrentAnswer,
    setShowSTARGuide,
    setSTARGuide,
    startTimer,
    stopTimer,
    resetCurrentAnswer,
    resetSession,
  } = useAIInterviewStore()

  const [view, setView] = useState<'welcome' | 'guide' | 'interview' | 'feedback' | 'summary'>('welcome')
  const [guideMessage, setGuideMessage] = useState('')
  const [currentScore, setCurrentScore] = useState<any>(null)
  const [summary, setSummary] = useState<any>(null)

  // 倒计时效果
  useEffect(() => {
    if (!timerRunning || timeRemaining <= 0) return

    const timer = setInterval(() => {
      useAIInterviewStore.setState((state) => ({
        timeRemaining: Math.max(0, state.timeRemaining - 1),
      }))
    }, 1000)

    return () => clearInterval(timer)
  }, [timerRunning, timeRemaining])

  // 开始面试
  const handleStartInterview = async (config: StartAIInterviewRequest) => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await aiInterviewAPI.startInterview(config)
      setSession(result.session)
      setGuideMessage(result.guide_message)
      setView('guide')
    } catch (err: any) {
      setError(err.response?.data?.detail || '开始面试失败')
    } finally {
      setIsLoading(false)
    }
  }

  // 获取下一题
  const handleNextQuestion = async () => {
    setIsLoading(true)
    setError(null)
    resetCurrentAnswer()

    try {
      const result = await aiInterviewAPI.nextQuestion()
      if (result.has_more && result.question) {
        setCurrentQuestion(result.question)
        setSession(result.session)
        setView('interview')
        startTimer()

        // 如果需要STAR，显示引导
        if (result.question.requires_star) {
          setShowSTARGuide(true)
        }
      } else {
        // 没有更多题目
        setView('summary')
        await loadSummary()
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || '获取题目失败')
    } finally {
      setIsLoading(false)
    }
  }

  // 提交答案
  const handleSubmitAnswer = async () => {
    if (!currentQuestion || !currentAnswer.trim()) {
      setError('请先输入答案')
      return
    }

    stopTimer()
    setIsLoading(true)
    setError(null)

    try {
      const timeUsed = currentQuestion.time_limit_seconds - timeRemaining

      const request: SubmitAnswerRequest = {
        question_id: currentQuestion.id,
        answer_text: currentAnswer,
        time_used_seconds: timeUsed,
      }

      // 如果有STAR数据
      if (showSTARGuide && starGuide?.star) {
        request.star_situation = starGuide.star.situation
        request.star_task = starGuide.star.task
        request.star_action = starGuide.star.action
        request.star_result = starGuide.star.result
      }

      const result = await aiInterviewAPI.submitAnswer(request)
      setCurrentScore(result.score)
      setSession(result.session)
      setView('feedback')
    } catch (err: any) {
      setError(err.response?.data?.detail || '提交答案失败')
    } finally {
      setIsLoading(false)
    }
  }

  // 检查STAR完成度
  const handleCheckSTAR = useCallback(async () => {
    if (!currentAnswer.trim()) return

    try {
      const result = await aiInterviewAPI.checkSTAR(currentAnswer)
      setSTARGuide(result.guide)
    } catch (err) {
      console.error('检查STAR失败', err)
    }
  }, [currentAnswer, setSTARGuide])

  // 加载总结
  const loadSummary = async () => {
    try {
      const result = await aiInterviewAPI.completeInterview()
      setSummary(result.summary)
      setSession(result.session)
    } catch (err: any) {
      setError(err.response?.data?.detail || '加载总结失败')
    }
  }

  // 重新开始
  const handleRestart = async () => {
    try {
      await aiInterviewAPI.resetSession()
      resetSession()
      setSummary(null)
      setGuideMessage('')
      setCurrentScore(null)
      setView('welcome')
    } catch (err: any) {
      setError(err.response?.data?.detail || '重置失败')
    }
  }

  // 格式化时间
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* 头部状态栏 */}
      {session && view !== 'welcome' && (
        <div className="bg-white border-b px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="text-sm">
              <span className="text-gray-500">进度：</span>
              <span className="font-medium">
                {session.current_question_index + 1} / {session.questions.length}
              </span>
            </div>
            <div className="text-sm">
              <span className="text-gray-500">平均分：</span>
              <span className="font-medium text-blue-600">{session.average_score.toFixed(1)}</span>
            </div>
          </div>

          {session.show_timer && view === 'interview' && (
            <div className={`flex items-center gap-2 ${timeRemaining < 30 ? 'text-red-600' : 'text-gray-700'}`}>
              <Clock className="w-4 h-4" />
              <span className="font-mono text-lg font-medium">{formatTime(timeRemaining)}</span>
            </div>
          )}
        </div>
      )}

      {/* 主内容区 */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="mx-6 mt-4 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-red-800">{error}</p>
              <button
                onClick={() => setError(null)}
                className="mt-2 text-xs text-red-600 hover:text-red-700 underline"
              >
                关闭
              </button>
            </div>
          </div>
        )}

        {view === 'welcome' && <WelcomeView onStart={handleStartInterview} isLoading={isLoading} />}
        {view === 'guide' && (
          <GuideView guideMessage={guideMessage} onNext={handleNextQuestion} isLoading={isLoading} />
        )}
        {view === 'interview' && currentQuestion && (
          <InterviewView
            question={currentQuestion}
            answer={currentAnswer}
            onAnswerChange={setCurrentAnswer}
            showSTARGuide={showSTARGuide}
            starGuide={starGuide}
            onCheckSTAR={handleCheckSTAR}
            onSubmit={handleSubmitAnswer}
            isLoading={isLoading}
          />
        )}
        {view === 'feedback' && currentScore && (
          <FeedbackView score={currentScore} onNext={handleNextQuestion} isLoading={isLoading} />
        )}
        {view === 'summary' && summary && (
          <SummaryView summary={summary} session={session} onRestart={handleRestart} />
        )}
      </div>
    </div>
  )
}

// 欢迎页面组件
function WelcomeView({ onStart, isLoading }: { onStart: (config: StartAIInterviewRequest) => void; isLoading: boolean }) {
  const [config, setConfig] = useState<StartAIInterviewRequest>({
    position: '后端开发',
    question_count: 5,
    total_time_minutes: 30,
    enable_star_guide: true,
    show_timer: true,
  })

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-full mb-4">
          <Trophy className="w-8 h-8 text-blue-600" />
        </div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">AI模拟面试</h1>
        <p className="text-gray-600">智能评分 · STAR引导 · 实时改进建议</p>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-6 space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">职位</label>
          <select
            value={config.position}
            onChange={(e) => setConfig({ ...config, position: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="后端开发">后端开发</option>
            <option value="前端开发">前端开发</option>
            <option value="全栈开发">全栈开发</option>
            <option value="算法工程师">算法工程师</option>
            <option value="测试开发">测试开发</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">题目数量</label>
            <input
              type="number"
              min="1"
              max="20"
              value={config.question_count}
              onChange={(e) => setConfig({ ...config, question_count: parseInt(e.target.value) || 5 })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">总时长（分钟）</label>
            <input
              type="number"
              min="10"
              max="180"
              value={config.total_time_minutes}
              onChange={(e) => setConfig({ ...config, total_time_minutes: parseInt(e.target.value) || 30 })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.enable_star_guide}
              onChange={(e) => setConfig({ ...config, enable_star_guide: e.target.checked })}
              className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">启用STAR模板引导</span>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.show_timer}
              onChange={(e) => setConfig({ ...config, show_timer: e.target.checked })}
              className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">显示倒计时</span>
          </label>
        </div>

        <button
          onClick={() => onStart(config)}
          disabled={isLoading}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors"
        >
          {isLoading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>准备中...</span>
            </>
          ) : (
            <>
              <Play className="w-5 h-5" />
              <span>开始面试</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}

// 引导页面组件（占位，其他组件类似简化实现）
function GuideView({ guideMessage, onNext, isLoading }: any) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="bg-white rounded-lg shadow-sm p-8">
        <h2 className="text-2xl font-bold mb-4">面试须知</h2>
        <div className="prose prose-sm max-w-none mb-8 whitespace-pre-wrap text-gray-700">
          {guideMessage}
        </div>
        <button
          onClick={onNext}
          disabled={isLoading}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-lg flex items-center gap-2"
        >
          下一题 <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// 面试页面（简化）
function InterviewView({ question, answer, onAnswerChange, onSubmit, isLoading }: any) {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="flex items-start gap-3 mb-4">
          <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-700">
            {question.category}
          </span>
          <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-700">
            {question.difficulty === 'easy' ? '简单' : question.difficulty === 'medium' ? '中等' : '困难'}
          </span>
        </div>
        <h3 className="text-xl font-semibold text-gray-900">{question.content}</h3>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-6">
        <textarea
          value={answer}
          onChange={(e) => onAnswerChange(e.target.value)}
          placeholder="请输入您的答案..."
          className="w-full h-64 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
        <div className="mt-4 flex justify-end">
          <button
            onClick={onSubmit}
            disabled={isLoading || !answer.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-lg"
          >
            提交答案
          </button>
        </div>
      </div>
    </div>
  )
}

// 反馈页面（简化）
function FeedbackView({ score, onNext, isLoading }: any) {
  const getScoreColor = (s: number) => {
    if (s >= 5) return 'text-green-600'
    if (s >= 4) return 'text-blue-600'
    return 'text-yellow-600'
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="bg-white rounded-lg shadow-sm p-8">
        <div className="text-center mb-8">
          <div className={`text-6xl font-bold ${getScoreColor(score.score)} mb-2`}>
            {score.score} / 5
          </div>
          <p className="text-gray-600">本题得分</p>
        </div>

        {score.improvement_suggestions.length > 0 && (
          <div className="mb-6">
            <h3 className="font-semibold text-gray-900 mb-3">改进建议</h3>
            <ul className="space-y-2">
              {score.improvement_suggestions.map((suggestion: string, idx: number) => (
                <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                  <AlertCircle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                  <span>{suggestion}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={onNext}
          disabled={isLoading}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-3 rounded-lg flex items-center justify-center gap-2"
        >
          下一题 <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// 总结页面（简化）
function SummaryView({ summary, session, onRestart }: any) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="bg-white rounded-lg shadow-sm p-8 text-center">
        <CheckCircle2 className="w-16 h-16 text-green-600 mx-auto mb-4" />
        <h2 className="text-2xl font-bold mb-2">{summary.message}</h2>
        <p className="text-gray-600 mb-8">{summary.comment}</p>

        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-blue-600">{summary.statistics.average_score}</div>
            <div className="text-sm text-gray-600">平均分</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-green-600">{summary.statistics.total_questions}</div>
            <div className="text-sm text-gray-600">完成题数</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-purple-600">
              {Math.floor(summary.statistics.total_time_seconds / 60)}m
            </div>
            <div className="text-sm text-gray-600">用时</div>
          </div>
        </div>

        <button
          onClick={onRestart}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg flex items-center gap-2 mx-auto"
        >
          <RotateCcw className="w-4 h-4" />
          <span>重新开始</span>
        </button>
      </div>
    </div>
  )
}
