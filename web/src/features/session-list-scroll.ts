import { useRouter } from '@tanstack/react-router'
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

import { trace } from '#/lib/client-trace'

const isSessionList = (path: string) => /\/console\/sessions\/?$/.test(path)

// Android can close the detail's keyboard after the list renders, and that
// viewport resize can scroll the shared page back to the detail's bottom.
function settleAfterReturn(el: HTMLDivElement, target: number) {
  let active = true
  let frame = 0
  const correct = (reason: string) => {
    if (!active || !isSessionList(window.location.pathname)) return
    const before = el.scrollTop
    if (Math.abs(before - target) < 2) return
    el.scrollTop = target
    trace('session-list-scroll-correct', {
      reason,
      before,
      target,
      actual: el.scrollTop,
      height: el.scrollHeight,
      client: el.clientHeight,
    })
  }
  const onResize = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => correct('viewport'))
  }
  const stop = () => {
    if (!active) return
    active = false
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    window.removeEventListener('resize', onResize)
    window.visualViewport?.removeEventListener('resize', onResize)
    window.removeEventListener('pointerdown', stop, true)
    window.removeEventListener('wheel', stop, true)
    window.removeEventListener('keydown', stop, true)
  }
  const timer = window.setTimeout(() => {
    correct('settled')
    stop()
  }, 1_000)
  window.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('resize', onResize)
  window.addEventListener('pointerdown', stop, true)
  window.addEventListener('wheel', stop, { capture: true, passive: true })
  window.addEventListener('keydown', stop, true)
  return stop
}

export function useSessionListScroll(
  scroller: RefObject<HTMLDivElement | null>,
) {
  const router = useRouter()
  const savedTop = useRef(0)
  const restorePending = useRef(false)

  useLayoutEffect(() => {
    let stopSettling: (() => void) | undefined
    const stopSaving = router.subscribe(
      'onBeforeLoad',
      ({ fromLocation, toLocation }) => {
        if (
          !fromLocation ||
          !isSessionList(fromLocation.pathname) ||
          isSessionList(toLocation.pathname)
        )
          return
        stopSettling?.()
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
        stopSettling?.()
        stopSettling = settleAfterReturn(el, target)
      },
    )
    return () => {
      stopSettling?.()
      stopSaving()
      stopRestoring()
    }
  }, [router, scroller])
}
