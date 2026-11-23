import { useSyncExternalStore } from 'react'

/** matchMedia as state. SSR / first paint assume desktop (the console's data is client-only anyway). */
export function useMediaQuery(query: string, serverValue = true) {
  return useSyncExternalStore(
    (listener) => {
      const list = matchMedia(query)
      list.addEventListener('change', listener)
      return () => list.removeEventListener('change', listener)
    },
    () => matchMedia(query).matches,
    () => serverValue,
  )
}

/** ≥768px: split list/detail + sidebar; below: phone shell (docs/web-pwa.md). */
export const useIsWide = () => useMediaQuery('(min-width: 768px)')

/**
 * The same, phone first: hydration renders the phone layout. For pages whose
 * wide form is a different tree (会话 / 我的 splits): assuming desktop there
 * flashed the split on a phone and mounted the session twice.
 */
export const useIsWidePhoneFirst = () =>
  useMediaQuery('(min-width: 768px)', false)
