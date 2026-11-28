// Per-device preference for what plain Enter does in the message composer:
//   - 'auto' (default): desktop & tablet hardware keyboard send, touch phones
//     and open soft keyboards insert a newline
//   - 'newline': plain Enter always inserts a newline (Ctrl/⌘+Enter sends)
//   - 'send': plain Enter always sends, e.g. phone with a physical keyboard
//     (Shift+Enter / Alt+Enter still insert a newline; IME composing never sends)
import { useSyncExternalStore } from 'react'

import { trace } from '#/lib/client-trace'

export const ENTER_MODES = ['auto', 'newline', 'send'] as const
export type EnterMode = (typeof ENTER_MODES)[number]

const KEY = 'wezdeck-enter-mode'
const listeners = new Set<() => void>()

export function parseEnterMode(raw: string | null | undefined): EnterMode {
  return ENTER_MODES.includes(raw as EnterMode) ? (raw as EnterMode) : 'auto'
}

export function readEnterMode(): EnterMode {
  if (typeof localStorage === 'undefined') return 'auto'
  try {
    return parseEnterMode(localStorage.getItem(KEY))
  } catch {
    return 'auto'
  }
}

export function writeEnterMode(next: EnterMode) {
  try {
    if (next === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // storage blocked: keep in-memory subscribers synced until reload
  }
  trace('enter-mode-change', { mode: next })
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useEnterMode() {
  const mode = useSyncExternalStore<EnterMode>(
    subscribe,
    readEnterMode,
    () => 'auto',
  )
  return [mode, writeEnterMode] as const
}
