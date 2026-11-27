// Scroll-up automatic preloading for earlier session messages, plus one-shot
// backfill when a stale cached snapshot has no user message loaded yet.
// Manual loading in ThreadPagingBar remains as fallback (and for pre-compaction
// history, where auto-preload intentionally stops).
import { useCallback, useEffect, useRef, useState } from 'react'

import { trace } from '#/lib/client-trace'
import { PAGE } from '#/lib/session-cache'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { useKeepPlace } from './chat-scroll'

export const PRELOAD_MIN_PX = 480
export const PRELOAD_VIEWPORT_RATIO = 0.8
const MAX_ENSURE_USER_PAGES = 2

export type AutoPreloadInput = {
  start: number
  pagingIn: boolean
  atCompaction: boolean
  failedAt: number | null
  scrollTop: number
  prevScrollTop: number
  clientHeight: number
  scrollHeight: number
  userScrolled: boolean
}

/** Pure trigger rule for automatic scroll-up preloading (unit-tested). */
export function shouldAutoPreload({
  start,
  pagingIn,
  atCompaction,
  failedAt,
  scrollTop,
  prevScrollTop,
  clientHeight,
  scrollHeight,
  userScrolled,
}: AutoPreloadInput): boolean {
  if (start <= 0 || pagingIn || atCompaction) return false
  if (failedAt !== null && failedAt === start) return false
  if (!userScrolled) return false
  if (scrollHeight <= clientHeight + 24) return false
  const threshold = Math.max(
    PRELOAD_MIN_PX,
    Math.round(clientHeight * PRELOAD_VIEWPORT_RATIO),
  )
  if (scrollTop > threshold) return false
  return scrollTop < prevScrollTop || scrollTop <= 48
}

/** How many earlier messages to request, respecting the compaction boundary. */
export function earlierPageSize(
  start: number,
  compactedAt: number | undefined,
  atCompaction: boolean,
): number {
  if (atCompaction || compactedAt === undefined) return PAGE
  return Math.min(PAGE, Math.max(1, start - compactedAt))
}

export function useAutoPreloadEarlier({
  id,
  end,
  start,
  hasUserMessage,
  pagingIn,
  syncing,
  atCompaction,
  failedAt,
  onPreload,
}: {
  id: string
  end: React.RefObject<HTMLDivElement | null>
  start: number
  hasUserMessage: boolean
  pagingIn: boolean
  syncing: boolean
  atCompaction: boolean
  failedAt: number | null
  onPreload: (trigger: 'auto' | 'ensure-user') => void
}) {
  const stateRef = useRef({
    id,
    start,
    pagingIn,
    syncing,
    atCompaction,
    failedAt,
    onPreload,
  })
  stateRef.current = {
    id,
    start,
    pagingIn,
    syncing,
    atCompaction,
    failedAt,
    onPreload,
  }
  const ensureTries = useRef<{ id: string; tries: number }>({ id, tries: 0 })
  if (ensureTries.current.id !== id) ensureTries.current = { id, tries: 0 }

  // Backfill stale IndexedDB snapshots that landed without the latest user
  // prompt (e.g. cached before sessionWindow's latest-user extension).
  useEffect(() => {
    if (
      syncing ||
      pagingIn ||
      hasUserMessage ||
      start <= 0 ||
      atCompaction ||
      failedAt === start ||
      ensureTries.current.tries >= MAX_ENSURE_USER_PAGES
    ) {
      return
    }
    ensureTries.current.tries += 1
    trace('chat-preload', {
      id,
      trigger: 'ensure-user',
      before: start,
      attempt: ensureTries.current.tries,
    })
    onPreload('ensure-user')
  }, [
    id,
    syncing,
    pagingIn,
    hasUserMessage,
    start,
    atCompaction,
    failedAt,
    onPreload,
  ])

  // Auto-preload when the reader scrolls up into the top preload zone.
  // Depend on `wide` because desktop adds `.overflow-y-auto` onto session-pane
  // after phone-first hydration (session-split.tsx), switching the active scroller.
  const wide = useIsWidePhoneFirst()
  useEffect(() => {
    const el = end.current?.closest<HTMLElement>('.overflow-y-auto')
    if (!el) return
    let userScrolled = false
    let prevScrollTop = el.scrollTop
    let frame = 0

    const markUser = () => {
      userScrolled = true
    }
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) userScrolled = true
    }
    const check = () => {
      frame = 0
      const s = stateRef.current
      const curTop = el.scrollTop
      const prevTop = prevScrollTop
      prevScrollTop = curTop
      if (s.syncing) return
      if (
        shouldAutoPreload({
          start: s.start,
          pagingIn: s.pagingIn,
          atCompaction: s.atCompaction,
          failedAt: s.failedAt,
          scrollTop: curTop,
          prevScrollTop: prevTop,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          userScrolled,
        })
      ) {
        trace('chat-preload', {
          id: s.id,
          trigger: 'auto',
          before: s.start,
          scrollTop: Math.round(curTop),
        })
        s.onPreload('auto')
      }
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }

    el.addEventListener('wheel', markUser, { passive: true })
    el.addEventListener('touchmove', markUser, { passive: true })
    el.addEventListener('pointerdown', markUser, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('wheel', markUser)
      el.removeEventListener('touchmove', markUser)
      el.removeEventListener('pointerdown', markUser)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [end, id, wide])
}

/**
 * Coordinates earlier-page loading for SessionDetail: preserves scroll anchor
 * right before prepended messages commit, runs automatic scroll-up preloading
 * and stale-cache user-prompt backfill, and exposes manual fallback + retry state.
 */
export function useSessionPaging({
  id,
  end,
  start,
  compactedAt,
  atCompaction,
  hasUserMessage,
  pagingIn,
  syncing,
  loadEarlier,
  onManualError,
}: {
  id: string
  end: React.RefObject<HTMLDivElement | null>
  start: number
  compactedAt: number | undefined
  atCompaction: boolean
  hasUserMessage: boolean
  pagingIn: boolean
  syncing: boolean
  loadEarlier: (count: number, onBeforeMerge?: () => void) => Promise<boolean>
  onManualError: (message: string) => void
}) {
  const keepPlace = useKeepPlace(end, start)
  const [failedAt, setFailedAt] = useState<number | null>(null)
  const trigger = useCallback(
    (kind: 'auto' | 'ensure-user' | 'manual') => {
      const count = earlierPageSize(start, compactedAt, atCompaction)
      if (kind === 'manual') {
        setFailedAt(null)
        trace('chat-preload', { id, trigger: 'manual', before: start, count })
      }
      loadEarlier(count, keepPlace)
        .then((loaded) => {
          if (loaded) setFailedAt(null)
        })
        .catch((e: unknown) => {
          if (kind === 'manual') onManualError((e as Error).message)
          else setFailedAt(start)
          trace('chat-preload-error', {
            id,
            trigger: kind,
            before: start,
            error: e instanceof Error ? e.message : String(e),
          })
        })
    },
    [
      atCompaction,
      compactedAt,
      id,
      keepPlace,
      loadEarlier,
      onManualError,
      start,
    ],
  )
  useAutoPreloadEarlier({
    id,
    end,
    start,
    hasUserMessage,
    pagingIn,
    syncing,
    atCompaction,
    failedAt,
    onPreload: trigger,
  })
  return {
    autoFailed: failedAt === start,
    loadManual: useCallback(() => trigger('manual'), [trigger]),
  }
}
