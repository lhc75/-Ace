import type { StateCreator } from 'zustand'
import type { RootState } from './rootState'
import type { QAPair, QAStatus, TranscriptEntry, WebSource } from './types'
import { parseVisionVerify } from '@/lib/parsers'

const CHUNK_THROTTLE_MS = 50
const MAX_TRANSCRIPTIONS = 200
const MAX_CANDIDATE_TRANSCRIPTIONS = 200

const _chunkBuffer: Map<string, { answer: string; think: string }> = new Map()
let _chunkFlushTimer: ReturnType<typeof setTimeout> | null = null
let _candidateSegmentIds: Array<string | null> = []

function takeTail<T>(items: T[], maxItems: number): T[] {
  return items.length > maxItems ? items.slice(-maxItems) : items
}

function normalizeWebSources(raw: unknown): WebSource[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const sources = raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item, index) => ({
      rank: Number.isFinite(Number(item.rank)) ? Number(item.rank) : index + 1,
      title: String(item.title ?? '').trim(),
      url: String(item.url ?? '').trim(),
      snippet: String(item.snippet ?? ''),
      site_name: String(item.site_name ?? ''),
      date: String(item.date ?? ''),
      authority: Number.isFinite(Number(item.authority)) ? Number(item.authority) : -1,
    }))
    .filter((item) => item.title && /^https?:\/\//i.test(item.url))
  return sources.length ? sources : undefined
}

function _scheduleChunkFlush(set: (fn: (s: RootState) => Partial<RootState>) => void) {
  if (_chunkFlushTimer !== null) return
  _chunkFlushTimer = setTimeout(() => {
    _chunkFlushTimer = null
    const pending = new Map(_chunkBuffer)
    _chunkBuffer.clear()
    if (pending.size === 0) return
    set((s) => {
      const activeStreamingIds = new Set(s.streamingIds)
      return {
        qaPairs: s.qaPairs.map((qa) => {
          const buf = pending.get(qa.id)
          if (!buf || qa.status !== 'streaming' || !activeStreamingIds.has(qa.id)) return qa
          return {
            ...qa,
            thinkContent: buf.think ? qa.thinkContent + buf.think : qa.thinkContent,
            answer: buf.answer ? qa.answer + buf.answer : qa.answer,
            isThinking: buf.answer ? false : buf.think ? true : qa.isThinking,
          }
        }),
      }
    })
  }, CHUNK_THROTTLE_MS)
}

interface InterviewSliceState {
  isRecording: boolean
  isPaused: boolean
  audioLevel: number
  isTranscribing: boolean
  transcriptions: TranscriptEntry[]
  // 面试官“正在说、还没定稿”的那一行，单独存一份字符串而不是塞进 transcriptions：
  // 它会被反复覆盖、没有后端 id，也不参与问答关联。空串表示当前没有进行中的句子。
  interimTranscription: string
  candidateTranscriptions: string[]
  qaPairs: QAPair[]
  streamingIds: string[]
  currentStreamingId: string | null
}

interface InterviewSliceActions {
  setRecording: (v: boolean) => void
  setPaused: (v: boolean) => void
  setAudioLevel: (v: number) => void
  setTranscribing: (v: boolean) => void
  // 更新/清空进行中的转写行（后端节流后推送，最频繁约 5 次/秒，无需再本地节流）
  setInterimTranscription: (text: string) => void
  addTranscription: (entry: TranscriptEntry | string) => void
  updateTranscription: (id: string, text: string) => void
  deleteTranscription: (id: string, qaIds?: string[]) => void
  addCandidateTranscription: (text: string, meta?: { segmentId?: string; isFinal?: boolean }) => void
  startAnswer: (
    id: string,
    question: string,
    meta?: {
      source?: string
      modelName?: string
      sourceTranscriptionIds?: string[]
      replacement?: boolean
      images?: string[]
    },
  ) => void
  appendThinkChunk: (id: string, chunk: string, replacement?: boolean) => void
  appendAnswerChunk: (id: string, chunk: string, replacement?: boolean) => void
  finalizeAnswer: (
    id: string,
    question: string,
    answer: string,
    thinkContent?: string,
    modelName?: string,
    firstTokenMs?: number,
    totalMs?: number,
    replacement?: boolean,
    sourceTranscriptionIds?: string[],
    webSources?: WebSource[],
    images?: string[],
  ) => void
  cancelAnswer: (id: string) => void
  errorAnswer: (id: string, message: string, replacement?: boolean) => void
  beginAnswerReplacement: (id: string, question: string) => void
  restoreAnswerReplacement: (id: string) => void
  setVisionVerify: (id: string, verdict: 'PASS' | 'FAIL' | 'UNKNOWN', reason: string) => void
  setInitData: (data: any) => void
  clearSession: () => void
}

export type InterviewSlice = InterviewSliceState & InterviewSliceActions

export const createInterviewSlice: StateCreator<RootState, [], [], InterviewSlice> = (set, get) => {
  /** 重新发送中的卡片忽略旧流式消息(非 replacement) */
  const isIgnoredResend = (id: string, replacement: boolean) => {
    const qa = get().qaPairs.find((item) => item.id === id)
    return Boolean(qa?.isResending && !replacement)
  }

  const appendChunk = (id: string, chunk: string, field: 'answer' | 'think', replacement: boolean) => {
    if (isIgnoredResend(id, replacement)) return
    const buf = _chunkBuffer.get(id) ?? { answer: '', think: '' }
    buf[field] += chunk
    _chunkBuffer.set(id, buf)
    _scheduleChunkFlush(set)
  }

  return {
  isRecording: false,
  isPaused: false,
  audioLevel: 0,
  isTranscribing: false,
  transcriptions: [],
  interimTranscription: '',
  candidateTranscriptions: [],
  qaPairs: [],
  streamingIds: [],
  currentStreamingId: null,

  // 停止录音或暂停时顺手清掉进行中的那行，避免残留一句永远定不下来的文字
  setRecording: (v) => set(() => (v ? { isRecording: v } : { isRecording: v, interimTranscription: '' })),
  setPaused: (v) => set(() => (v ? { isPaused: v, interimTranscription: '' } : { isPaused: v })),
  setAudioLevel: (v) => set({ audioLevel: v }),
  setTranscribing: (v) => set({ isTranscribing: v }),
  setInterimTranscription: (text) => set({ interimTranscription: text }),
  addTranscription: (entry) => set((s) => {
    const normalized = typeof entry === 'string'
      ? { id: `legacy-${Date.now()}-${s.transcriptions.length}`, text: entry }
      : entry
    return { transcriptions: takeTail([...s.transcriptions, normalized], MAX_TRANSCRIPTIONS) }
  }),
  updateTranscription: (id, text) => set((s) => ({
    transcriptions: s.transcriptions.map((item) =>
      item.id === id ? { ...item, text } : item,
    ),
  })),
  deleteTranscription: (id, qaIds = []) => set((s) => ({
    transcriptions: s.transcriptions.filter((item) => item.id !== id),
    qaPairs: qaIds.length
      ? s.qaPairs.filter((qa) => !qaIds.includes(qa.id))
      : s.qaPairs,
  })),
  addCandidateTranscription: (text, meta) => set((s) => {
    const segmentId = meta?.segmentId || null
    if (segmentId) {
      const existingIndex = _candidateSegmentIds.lastIndexOf(segmentId)
      if (existingIndex >= 0 && existingIndex < s.candidateTranscriptions.length) {
        const next = [...s.candidateTranscriptions]
        next[existingIndex] = text
        return { candidateTranscriptions: next }
      }
    }
    if (s.candidateTranscriptions[s.candidateTranscriptions.length - 1] === text) {
      return { candidateTranscriptions: s.candidateTranscriptions }
    }
    const nextTranscriptions = [...s.candidateTranscriptions, text]
    const nextSegmentIds = [..._candidateSegmentIds, segmentId]
    const overflow = Math.max(0, nextTranscriptions.length - MAX_CANDIDATE_TRANSCRIPTIONS)
    _candidateSegmentIds = overflow > 0 ? nextSegmentIds.slice(overflow) : nextSegmentIds
    return {
      candidateTranscriptions: overflow > 0
        ? nextTranscriptions.slice(overflow)
        : nextTranscriptions,
    }
  }),

  startAnswer: (id, question, meta) =>
    set((s) => {
      const existing = s.qaPairs.find((qa) => qa.id === id)
      if (existing) {
        // 重发中或非流式状态的卡片不接收新的 startAnswer
        if ((existing.isResending && !meta?.replacement) || existing.status !== 'streaming') return s
        const streamingIds = s.streamingIds.includes(id) ? s.streamingIds : [...s.streamingIds, id]
        return {
          currentStreamingId: id,
          streamingIds,
          qaPairs: s.qaPairs.map((qa) =>
            qa.id === id
              ? {
                  ...qa,
                  question,
                  questionSource: meta?.source ?? qa.questionSource,
                  modelLabel: meta?.modelName ?? qa.modelLabel,
                  sourceTranscriptionIds:
                    meta?.sourceTranscriptionIds ?? qa.sourceTranscriptionIds,
                  images: meta?.images ?? qa.images,
                }
              : qa,
          ),
        }
      }
      return {
        currentStreamingId: id,
        streamingIds: [...s.streamingIds, id],
        qaPairs: [
          ...s.qaPairs,
          {
            id,
            question,
            answer: '',
            thinkContent: '',
            isThinking: false,
            timestamp: Date.now() / 1000,
            questionSource: meta?.source,
            modelLabel: meta?.modelName,
            sourceTranscriptionIds: meta?.sourceTranscriptionIds,
            images: meta?.images,
            status: 'streaming' as QAStatus,
          },
        ],
      }
    }),

  appendThinkChunk: (id, chunk, replacement = false) => appendChunk(id, chunk, 'think', replacement),

  appendAnswerChunk: (id, chunk, replacement = false) => appendChunk(id, chunk, 'answer', replacement),

  finalizeAnswer: (
    id,
    question,
    answer,
    thinkContent,
    modelName,
    firstTokenMs,
    totalMs,
    replacement = false,
    sourceTranscriptionIds,
    webSources,
    images,
  ) => {
    if (isIgnoredResend(id, replacement)) return
    _chunkBuffer.delete(id)
    set((s) => {
      const next = s.streamingIds.filter((x) => x !== id)
      const existing = s.qaPairs.some((qa) => qa.id === id)
      const qaPairs = existing
        ? s.qaPairs.map((qa) =>
            qa.id === id
              ? {
                  ...qa,
                  question,
                  answer,
                  thinkContent: thinkContent ?? qa.thinkContent,
                  isThinking: false,
                  modelLabel: modelName ?? qa.modelLabel,
                  firstTokenMs: firstTokenMs ?? qa.firstTokenMs,
                  totalMs: totalMs ?? qa.totalMs,
                  sourceTranscriptionIds:
                    sourceTranscriptionIds ?? qa.sourceTranscriptionIds,
                  webSources: normalizeWebSources(webSources) ?? [],
                  images: images ?? qa.images,
                  status: 'done' as QAStatus,
                  isResending: false,
                  resendOriginal: undefined,
                }
              : qa,
          )
        : [
            ...s.qaPairs,
            {
              id,
              question,
              answer,
              thinkContent: thinkContent ?? '',
              isThinking: false,
              timestamp: Date.now() / 1000,
              modelLabel: modelName,
              firstTokenMs,
              totalMs,
              sourceTranscriptionIds,
              webSources: normalizeWebSources(webSources) ?? [],
              images,
              status: 'done' as QAStatus,
            },
          ]
      return {
        currentStreamingId: next.length ? next[next.length - 1] : null,
        streamingIds: next,
        qaPairs,
      }
    })
  },

  cancelAnswer: (id) => {
    _chunkBuffer.delete(id)
    set((s) => {
      const next = s.streamingIds.filter((x) => x !== id)
      return {
        currentStreamingId: next.length ? next[next.length - 1] : null,
        streamingIds: next,
        qaPairs: s.qaPairs.map((qa) =>
          qa.id === id ? { ...qa, isThinking: false, status: 'cancelled' as QAStatus } : qa,
        ),
      }
    })
  },

  errorAnswer: (id, message) => {
    _chunkBuffer.delete(id)
    set((s) => {
      const next = s.streamingIds.filter((x) => x !== id)
      return {
        currentStreamingId: next.length ? next[next.length - 1] : null,
        streamingIds: next,
        qaPairs: s.qaPairs.map((qa) =>
          qa.id === id
            ? { ...qa, isThinking: false, status: 'error' as QAStatus, errorMessage: message }
            : qa,
        ),
      }
    })
  },

  beginAnswerReplacement: (id, question) => {
    _chunkBuffer.delete(id)
    set((s) => ({
      currentStreamingId: id,
      streamingIds: s.streamingIds.includes(id) ? s.streamingIds : [...s.streamingIds, id],
      qaPairs: s.qaPairs.map((qa) =>
        qa.id === id
          ? {
              ...qa,
              question,
              answer: '',
              thinkContent: '',
              isThinking: false,
              status: 'streaming' as QAStatus,
              errorMessage: undefined,
              isResending: true,
                  resendOriginal: {
                    question: qa.question,
                    answer: qa.answer,
                    thinkContent: qa.thinkContent,
                    isThinking: qa.isThinking,
                    questionSource: qa.questionSource,
                    modelLabel: qa.modelLabel,
                    firstTokenMs: qa.firstTokenMs,
                    totalMs: qa.totalMs,
                    sourceTranscriptionIds: qa.sourceTranscriptionIds,
                    visionVerify: qa.visionVerify,
                    webSources: qa.webSources,
                    status: qa.status,
                    errorMessage: qa.errorMessage,
              },
            }
          : qa,
      ),
    }))
  },

  restoreAnswerReplacement: (id) => {
    _chunkBuffer.delete(id)
    set((s) => {
      const next = s.streamingIds.filter((x) => x !== id)
      return {
        currentStreamingId: next.length ? next[next.length - 1] : null,
        streamingIds: next,
        qaPairs: s.qaPairs.map((qa) => {
          if (qa.id !== id || !qa.resendOriginal) return qa
          const original = qa.resendOriginal
          return {
            ...qa,
            ...original,
            isResending: false,
            resendOriginal: undefined,
          }
        }),
      }
    })
  },

  setVisionVerify: (id, verdict, reason) =>
    set((s) => ({
      qaPairs: s.qaPairs.map((qa) =>
        qa.id === id ? { ...qa, visionVerify: { verdict, reason } } : qa,
      ),
    })),

  setInitData: (data) => {
    _chunkBuffer.clear()
    const candidateSegments = Array.isArray(data.candidate_answer_segments)
      ? data.candidate_answer_segments
      : []
    const restoredCandidatePairs: Array<{ text: string; segmentId: string | null }> = candidateSegments.length > 0
      ? candidateSegments
          .map((segment: any) => ({
            text: String(segment?.text ?? '').trim(),
            segmentId: segment?.segment_id ? String(segment.segment_id) : null,
          }))
          .filter((segment: { text: string; segmentId: string | null }) => Boolean(segment.text))
      : (data.candidate_transcriptions ?? [])
          .map((text: unknown) => ({ text: String(text ?? '').trim(), segmentId: null }))
          .filter((segment: { text: string; segmentId: string | null }) => Boolean(segment.text))
    const restoredCandidatePairsTail = takeTail(restoredCandidatePairs, MAX_CANDIDATE_TRANSCRIPTIONS)
    const restoredCandidateTranscriptions = restoredCandidatePairsTail.map((segment) => segment.text)
    _candidateSegmentIds = restoredCandidatePairsTail.map((segment) => segment.segmentId)
    if (_chunkFlushTimer !== null) {
      clearTimeout(_chunkFlushTimer)
      _chunkFlushTimer = null
    }
    set({
      transcriptions: takeTail(
        (data.transcriptions ?? []).map((item: any, index: number) =>
          typeof item === 'string'
            ? { id: `legacy-${index}`, text: item }
            : { id: String(item.id), text: String(item.text ?? ''), timestamp: item.timestamp },
        ),
      MAX_TRANSCRIPTIONS),
      candidateTranscriptions: restoredCandidateTranscriptions,
      qaPairs: (data.qa_pairs ?? []).map(
        (qa: Partial<QAPair> & { id: string; question: string; answer: string }) => {
          const visionVerify = parseVisionVerify((qa as any).visionVerify ?? (qa as any).vision_verify)
          const webSources = normalizeWebSources((qa as any).web_sources ?? (qa as any).webSources)
          return {
            ...qa,
            thinkContent: qa.thinkContent ?? '',
            isThinking: false,
            timestamp: qa.timestamp ?? Date.now() / 1000,
            questionSource: (qa as any).source ?? qa.questionSource,
            modelLabel: (qa as any).model_name ?? qa.modelLabel,
            sourceTranscriptionIds: (qa as any).source_transcription_ids ?? qa.sourceTranscriptionIds ?? [],
            images: Array.isArray((qa as any).images) ? (qa as any).images : [],
            status: qa.status ?? 'done' as QAStatus,
            ...(visionVerify ? { visionVerify } : {}),
            ...(webSources ? { webSources } : {}),
          }
        },
      ),
      currentStreamingId: null,
      streamingIds: [],
      isRecording: data.is_recording ?? false,
      isPaused: data.is_paused ?? false,
      isTranscribing: data.is_transcribing ?? false,
      sttLoaded: data.stt_loaded ?? false,
      sttLoading: data.stt_loading ?? false,
      sttActiveProvider: data.stt_provider ?? '',
      candidateSttLoaded: false,
      candidateSttLoading: false,
      candidateSttProvider: '',
    })
  },

  clearSession: () => {
    _chunkBuffer.clear()
    _candidateSegmentIds = []
    if (_chunkFlushTimer !== null) {
      clearTimeout(_chunkFlushTimer)
      _chunkFlushTimer = null
    }
    set({
      transcriptions: [],
      interimTranscription: '',
      candidateTranscriptions: [],
      qaPairs: [],
      currentStreamingId: null,
      streamingIds: [],
      candidateSttLoaded: false,
      candidateSttLoading: false,
      candidateSttProvider: '',
    })
  },
  }
}
