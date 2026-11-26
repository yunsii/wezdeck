// Follow a pane's current session when the host says this URL was replaced
// (/new, /clear, /resume, handoff). Two channels: detail `replaced_by` (fast
// poll) and sessions `redirects` (list poll — works even if the detail never
// mounted). Same toast, deduped so both channels do not fire twice.
import { useLingui } from '@lingui/react/macro'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'

import { useLocale } from '#/lib/locale-context'

import { useSessions } from './console-sessions'

const toasted = new Set<string>()

function followKey(from: string, to: string) {
  return `${from}>${to}`
}

export function sessionIdFromPath(path: string) {
  return /\/console\/sessions\/([^/]+)\/?$/.exec(path)?.[1]
}

function useNavigateToSession() {
  const { t } = useLingui()
  const navigate = useNavigate()
  const { locale } = useLocale()
  return useCallback(
    (from: string, to: string) => {
      const key = followKey(from, to)
      const first = !toasted.has(key)
      if (first) {
        toasted.add(key)
        toast(t`This pane switched sessions`)
      }
      void navigate({
        to: '/{-$locale}/console/sessions/$id',
        params: { locale: locale === 'en' ? undefined : locale, id: to },
        replace: true,
      })
    },
    [navigate, locale, t],
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
