import { useEffect } from 'react'
import { useInterviewStore } from '@/stores/configStore'

// 笔试隐身模式：笔试模式 + 录制中（即“开始笔试”之后）时通知桌面端进入隐身——
// 隐藏菜单栏/系统托盘图标、悬浮窗鼠标穿透（点击落到考试窗口，不抢焦点）；
// 结束笔试（任一条件不再满足）即恢复。浏览器/网络模式没有 electronAPI，天然 no-op。
export function useStealthModeSync() {
  const isRecording = useInterviewStore((s) => s.isRecording)
  const isExamMode = useInterviewStore((s) => s.config?.written_exam_mode === true)

  useEffect(() => {
    if (!window.electronAPI?.syncStealthMode) return
    window.electronAPI
      .syncStealthMode({ active: isExamMode && isRecording })
      .catch(() => {})
  }, [isExamMode, isRecording])
}
