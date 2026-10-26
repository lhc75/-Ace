import { useShallow } from 'zustand/react/shallow'
import { useInterviewStore } from './configStore'
import type { RootState } from './slices/rootState'

/**
 * 领域级 hook 工厂，统一在 useShallow 下选择字段，避免大解构订阅整个 store。
 *
 * 使用：
 *   const settings = useUiSettings()
 *
 * 选择 action 时也要走 hook（Zustand 的 action 引用稳定，但走 useShallow 不会有额外开销）。
 */

function makeShallowHook<T extends object>(selector: (s: RootState) => T) {
  return () => useInterviewStore(useShallow(selector))
}

// ---- 设置抽屉 ---------------------------------------------------------------
export const useUiSettings = makeShallowHook((s) => ({
  settingsOpen: s.settingsOpen,
  settingsDrawerTab: s.settingsDrawerTab,
  toggleSettings: s.toggleSettings,
  closeSettings: s.closeSettings,
  setSettingsDrawerTab: s.setSettingsDrawerTab,
}))
