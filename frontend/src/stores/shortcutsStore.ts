import { create } from 'zustand'
import {
  defaultShortcuts,
  mergeShortcutConfigs,
  type ShortcutAction,
  type ShortcutConfig,
} from '@/lib/shortcuts'

type ShortcutsState = {
  shortcuts: Record<ShortcutAction, ShortcutConfig>
  setShortcuts: (shortcuts: Record<string, Record<string, unknown>> | undefined) => void
  resetShortcuts: () => void
}

export const useShortcutsStore = create<ShortcutsState>((set) => ({
  shortcuts: defaultShortcuts,
  setShortcuts: (shortcuts) => set({ shortcuts: mergeShortcutConfigs(shortcuts) }),
  resetShortcuts: () => set({ shortcuts: defaultShortcuts }),
}))
