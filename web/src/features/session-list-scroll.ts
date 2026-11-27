import { useRouter } from '@tanstack/react-router'
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

import { trace } from '#/lib/client-trace'

const isSessionList = (path: string) => /\/console\/sessions\/?$/.test(path)

export function useSessionListScroll(
  scroller: RefObject<HTMLDivElement | null>,
) {
  const router = useRouter()
  const savedTop = useRef(0)
  const restorePending = useRef(false)

  useLayoutEffect(() => {
    const stopSaving = router.subscribe(
      'onBeforeLoad',
      ({ fromLocation, toLocation }) => {
        if (
          !fromLocation ||
          !isSessionList(fromLocation.pathname) ||
          isSessionList(toLocation.pathname)
        )
          return
        savedTop.current = scroller.current?.scrollTop ?? 0
        restorePending.current = true
        trace('session-list-scroll-save', {
          top: savedTop.current,
          from: fromLocation.pathname,
          to: toLocation.pathname,
        })
      },
    )
    const stopRestoring = router.subscribe(
      'onRendered',
      ({ fromLocation, toLocation }) => {
        if (!isSessionList(toLocation.pathname)) return
        if (
          !restorePending.current &&
          fromLocation &&
          isSessionList(fromLocation.pathname)
        )
          return
        const el = scroller.current
        if (!el) return
        const target = restorePending.current ? savedTop.current : 0
        el.scrollTop = target
        restorePending.current = false
        trace('session-list-scroll-restore', { target, actual: el.scrollTop })
      },
    )
    return () => {
      stopSaving()
      stopRestoring()
    }
  }, [router, scroller])
}
