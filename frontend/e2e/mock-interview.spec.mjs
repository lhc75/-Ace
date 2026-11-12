import { test, expect } from '@playwright/test'
import { installMocks, COMMON_WS_BOOTSTRAP } from './fixtures/setup.mjs'

const now = () => Date.now() / 1000

function makeQuestion(overrides = {}) {
  return {
    id: 'mock-q-1',
    session_id: 7,
    main_index: 1,
    turn_index: 1,
    kind: 'main',
    parent_id: null,
    category: 'resume_project',
    question_text: '请说明你在订单系统中做过的一次缓存优化。',
    answer_time_limit_seconds: 120,
    prep_seconds: 15,
    phase: 'answering',
    prep_started_at: now() - 20,
    answer_started_at: now(),
    answer_deadline_at: now() + 120,
    draft_text: '',
    answer_text: '',
    auto_submitted: false,
    score: null,
    evaluation: {},
    asked_at: now(),
    answered_at: null,
    ...overrides,
  }
}

function makeSession(overrides = {}) {
  const question = makeQuestion()
  return {
    id: 7,
    status: 'in_progress',
    position: 'Java 后端开发',
    company: '示例公司',
    job_description: '',
    difficulty: 'medium',
    focus: 'balanced',
    resume_filename: '张三_后端开发.pdf',
    model_name: 'GPT-4.1 Mini',
    main_index: 1,
    turn_count: 1,
    current_question_id: question.id,
    total_score: null,
    report: null,
    self_rating: null,
    self_note: '',
    self_tags: [],
    error_message: null,
    created_at: now(),
    updated_at: now(),
    completed_at: null,
    has_resume: true,
    main_question_target: 10,
    max_follow_ups: 3,
    answered_count: 0,
    main_answered_count: 0,
    current_question: question,
    questions: [question],
    ...overrides,
  }
}

function completedSession() {
  return makeSession({
    status: 'completed',
    current_question_id: null,
    current_question: null,
    questions: [],
    total_score: 82,
    answered_count: 10,
    main_answered_count: 10,
    completed_at: now(),
    report: {
      total_score: 82,
      dimensions: [
        { key: 'professional_accuracy', label: '专业准确度', score: 84, weight: 25 },
        { key: 'project_depth', label: '项目深度与真实性', score: 80, weight: 20 },
        { key: 'logical_structure', label: '逻辑与结构', score: 83, weight: 20 },
        { key: 'communication', label: '沟通表达', score: 81, weight: 15 },
        { key: 'adaptability', label: '应变与追问', score: 78, weight: 10 },
        { key: 'role_motivation', label: '岗位动机与匹配', score: 80, weight: 10 },
      ],
      summary_markdown: '整体表现稳定，项目细节和技术取舍表达清楚。',
      strengths: ['项目细节完整', '能解释技术取舍'],
      risks: ['量化结果不足'],
      improvements: ['补充缓存命中率和 P99 变化'],
      next_practice_plan: ['准备一个高并发项目复盘'],
      question_reviews: [],
      answered_count: 10,
      main_question_target: 10,
      max_follow_ups: 3,
    },
  })
}

test.describe('AI mock interview', () => {
  test('runs setup, answer, report, self-assessment and delete flow', async ({ page }) => {
    await page.context().route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort())
    const state = { list: [], current: null, completed: null, rated: null }
    await installMocks(page.context(), {
      messages: COMMON_WS_BOOTSTRAP,
      localStorage: { 'ia-color-scheme': 'vscode-light-plus' },
      apiOverrides: async (pathname, method) => {
        if (pathname === '/api/mock-interview/sessions' && method === 'GET') {
          return { items: state.list }
        }
        if (pathname === '/api/mock-interview/sessions' && method === 'POST') {
          state.current = makeSession()
          state.list = [state.current]
          return state.current
        }
        if (pathname === '/api/mock-interview/sessions/7' && method === 'GET') {
          return state.rated || state.completed || state.current
        }
        if (pathname === '/api/mock-interview/sessions/7/start-answer') {
          return state.current
        }
        if (pathname === '/api/mock-interview/sessions/7/draft') {
          return { ok: true, saved_at: now() }
        }
        if (pathname === '/api/mock-interview/sessions/7/answers') {
          const ready = makeSession({
            status: 'ready_to_finish',
            current_question_id: null,
            current_question: null,
            answered_count: 10,
            main_answered_count: 10,
          })
          state.current = ready
          state.list = [ready]
          return { assessment: {}, ready_to_finish: true, session: ready }
        }
        if (pathname === '/api/mock-interview/sessions/7/finish') {
          state.completed = completedSession()
          state.list = [state.completed]
          return state.completed
        }
        if (pathname === '/api/mock-interview/sessions/7/self-assessment') {
          state.rated = { ...state.completed, self_rating: 4, self_note: '节奏合适', self_tags: ['节奏合适'] }
          state.list = [state.rated]
          return state.rated
        }
        if (pathname === '/api/mock-interview/sessions/7' && method === 'DELETE') {
          state.list = []
          return { ok: true }
        }
        return undefined
      },
    })

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'AI模拟面试' }).click()
    await expect(page.getByRole('heading', { name: 'AI 模拟面试' })).toBeVisible()

    await page.getByRole('button', { name: '开始 AI 模拟面试' }).click()
    await expect(page.getByText('请说明你在订单系统中做过的一次缓存优化。')).toBeVisible()

    await page.getByTestId('mock-answer-input').fill('我先定位热点 Key，再通过互斥锁重建缓存，并补充随机过期时间。')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('模拟面试诊断报告')).toBeVisible({ timeout: 8000 })
    await expect(page.getByText('整体表现稳定，项目细节和技术取舍表达清楚。')).toBeVisible()

    await page.getByRole('button', { name: '4 星' }).click()
    await page.getByPlaceholder('补充一点你这场面试的真实感受（可选）…').fill('节奏合适')
    await page.getByRole('button', { name: '保存我的感受' }).click()
    await expect(page.getByTestId('mock-self-assessment').getByText('已保存')).toBeVisible()

    await page.getByRole('button', { name: '返回模拟面试列表' }).click()
    await expect(page.getByText(/Java 后端开发/)).toBeVisible()
    await expect(page.getByText(/主问题 10\/10/)).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: '删除模拟面试记录' }).click()
    await expect(page.getByText('还没有模拟面试记录')).toBeVisible()
  })
})

test('renders the mock interview setup without horizontal overflow on mobile', async ({ page }) => {
  await page.context().route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort())
  await installMocks(page.context(), { messages: COMMON_WS_BOOTSTRAP })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '切换功能模块' }).click()
  await page.getByRole('menuitem', { name: 'AI模拟面试' }).click()

  await expect(page.getByRole('heading', { name: 'AI 模拟面试' })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('button', { name: '开始 AI 模拟面试' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
