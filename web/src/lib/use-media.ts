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
