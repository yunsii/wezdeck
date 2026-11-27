// Follow a pane's current session when the host says this URL was replaced
// (/new, /clear, /resume, handoff). Two channels: detail `replaced_by` (fast
// poll) and sessions `redirects` (list poll — works even if the detail never
// mounted). Same toast, deduped so both channels do not fire twice.
//
// Cycle guard: once this page has left a session id by following, never
// auto-navigate back to it. Mutual cleared_to / replaced_by (A→B and B→A)
// used to bounce the URL forever; toast dedupe alone still called navigate.
import { useLingui } from '@lingui/react/macro'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'

import { trace } from '#/lib/client-trace'
import { useLocale } from '#/lib/locale-context'

import { useSessions } from './console-sessions'
import { transferPending } from './session-send'

const toasted = new Set<string>()
/** Session ids this page already left via an auto-follow (cycle break). */
const leftViaFollow = new Set<string>()

function followKey(from: string, to: string) {
  return `${from}>${to}`
}

/**
 * Whether the page should auto-navigate `from` → `to`. Refuses a hop onto a
 * session this page already left by following — that closes A↔B (and longer)
 * redirect cycles without blocking a later handoff out of a fresh id.
 */
export function canFollowSession(
  from: string,
  to: string,
  left: ReadonlySet<string> = leftViaFollow,
): boolean {
  if (!from || !to || from === to) return false
  if (left.has(to)) return false
  return true
}

/** Test helper: clear module follow state between cases. */
export function resetSessionFollowState() {
  toasted.clear()
  leftViaFollow.clear()
}

export function isPendingResolution(from: string, to: string) {
  return from.startsWith('pending-') && !to.startsWith('pending-')
}

export function sessionIdFromPath(path: string) {
  return /\/console\/sessions\/([^/]+)\/?$/.exec(path)?.[1]
}

export function useNavigateToSession() {
  const { t } = useLingui()
  const navigate = useNavigate()
  const router = useRouter()
  const { locale } = useLocale()
  return useCallback(
    (from: string, to: string) => {
      if (sessionIdFromPath(router.state.location.pathname) !== from) return
      if (!canFollowSession(from, to)) {
        trace('session-follow', {
          id: to,
          action: from,
          skipped: 'cycle',
        })
        return
      }
      leftViaFollow.add(from)
      const resolvingPending = isPendingResolution(from, to)
      if (resolvingPending) transferPending(from, to)
      const key = followKey(from, to)
      const first = !toasted.has(key)
      if (first && !resolvingPending) {
        toasted.add(key)
        toast(t`This pane switched sessions`)
      }
      trace('session-follow', { id: to, action: from })
      void navigate({
        to: '/{-$locale}/console/sessions/$id',
        params: { locale: locale === 'en' ? undefined : locale, id: to },
        replace: true,
      })
    },
    [navigate, router, locale, t],
  )
}

/**
 * Detail poll: host answers the old id with replaced_by. Follow in place.
 */
export function useFollowReplacement(replacedBy?: string) {
  const id = useRouterState({
    select: (s) =>
      sessionIdFromPath((s.resolvedLocation ?? s.location).pathname),
  })
  const go = useNavigateToSession()
  useEffect(() => {
    if (!replacedBy || !id || replacedBy === id) return
    go(id, replacedBy)
  }, [replacedBy, id, go])
}

/**
 * Sessions list poll: `redirects: [{from,to}]`. Covers a detail URL that
 * never got replaced_by while the user stayed on `/console/sessions/$from`.
 */
export function useFollowSessionRedirect() {
  const sessions = useSessions()
  const id = useRouterState({
    select: (s) =>
      sessionIdFromPath((s.resolvedLocation ?? s.location).pathname),
  })
  const go = useNavigateToSession()
  const redirects = sessions.data?.redirects
  useEffect(() => {
    if (!id || !redirects?.length) return
    const hit = redirects.find((r) => r.from === id && r.to && r.to !== id)
    if (!hit) return
    go(hit.from, hit.to)
  }, [id, redirects, go])
}
