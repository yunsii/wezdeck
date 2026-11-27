// Data helpers and host RPC calls for QuickTicketForm (target discovery,
// 0-wait quick creation, synchronous AI draft structuring, and manual create).
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { trace } from '#/lib/client-trace'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { materializeAttachments } from './composer-images'
import type { MessagePayload } from './composer-images'
import { useRichDraft } from './message-composer'
import type { TicketDraftPreviewData } from './ticket-quick-manual'

export type TicketTarget = { key: string; path: string }

export type TicketTargetsReply = {
  v: number
  ok: boolean
  targets: Array<TicketTarget>
  session_target?: string
}

export type TicketCreatedInfo = {
  id: string
  to: string
  run: string
  enriching: boolean
}

const LAST_TARGET_KEY = 'wezdeck-last-ticket-to'

export function readLastTicketTarget() {
  if (typeof window === 'undefined') return ''
  try {
    return localStorage.getItem(LAST_TARGET_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveLastTicketTarget(key: string) {
  if (typeof window === 'undefined' || !key) return
  try {
    localStorage.setItem(LAST_TARGET_KEY, key)
  } catch {
    // ignore storage quota errors
  }
}

export function useTicketTargets(session?: string, enabled = true) {
  return useQuery({
    queryKey: ['remote', 'ticket.targets', session ?? ''],
    enabled: enabled && typeof window !== 'undefined',
    staleTime: 30_000,
    queryFn: async () =>
      (await hostRead(
        'ticket.targets',
        session ? { session } : {},
      )) as TicketTargetsReply,
  })
}

export async function requestTicketDraft({
  toKey,
  text,
  attachments,
  sessionId,
  includeContext,
}: {
  toKey: string
  text: string
  attachments: Array<string>
  sessionId?: string
  includeContext: boolean
}): Promise<TicketDraftPreviewData> {
  const res = (await hostWrite('ticket.draft', {
    to: toKey,
    text,
    attachments,
    session: sessionId || undefined,
    include_context: Boolean(sessionId && includeContext),
  })) as {
    title: string
    summary: string
    observed: string
    assumed: string
    suggested_to?: string
    provider?: string
  }
  trace('ticket-quick', {
    action: 'draft',
    to: toKey,
    attachments: attachments.length,
    suggested: Boolean(res.suggested_to),
  })
  return {
    title: res.title,
    summary: res.summary,
    observed: res.observed,
    assumed: res.assumed,
    suggestedTo: res.suggested_to ?? '',
    provider: res.provider ?? '',
    originalText: text,
    attachments,
  }
}

export async function createTicketAndSync(
  client: QueryClient,
  args: Record<string, unknown>,
  opts: {
    toKey: string
    mode: 'quick' | 'preview' | 'manual'
    attachmentsCount: number
    withManager: boolean
    run?: boolean
  },
): Promise<TicketCreatedInfo> {
  const res = (await hostWrite('ticket.new', args)) as {
    id: string
    run: string
    enriching?: boolean
  }
  if (opts.withManager && res.id) {
    await hostWrite('ticket.manager.start', { id: res.id }).catch(
      () => undefined,
    )
  }
  saveLastTicketTarget(opts.toKey)
  trace('ticket-quick', {
    action: 'create',
    mode: opts.mode,
    to: opts.toKey,
    attachments: opts.attachmentsCount,
    enriching: Boolean(res.enriching),
    run: Boolean(opts.run),
  })
  await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
  return {
    id: res.id,
    to: opts.toKey,
    run: res.run,
    enriching: Boolean(res.enriching),
  }
}

export function useQuickTicketController({
  sessionId,
  defaultTo,
  initialPayload,
  draftKey,
  onCreated,
}: {
  sessionId?: string
  defaultTo?: string
  initialPayload?: MessagePayload
  draftKey: string
  onCreated?: (info: TicketCreatedInfo) => void
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const targets = useTicketTargets(sessionId)
  const keys = (targets.data?.targets ?? []).map((item) => item.key)
  const resolvedDefault =
    defaultTo ||
    targets.data?.session_target ||
    readLastTicketTarget() ||
    keys[0] ||
    ''

  const [mode, setMode] = useState<'quick' | 'manual'>('quick')
  const [toOverride, setToOverride] = useState('')
  const [fromKey, setFromKey] = useState('web')
  const [includeContext, setIncludeContext] = useState(Boolean(sessionId))
  const [run, setRun] = useState(false)
  const [withManager, setWithManager] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<TicketDraftPreviewData | null>(null)
  const [manualTitle, setManualTitle] = useState('')
  const [manualObserved, setManualObserved] = useState('')
  const [manualAssumed, setManualAssumed] = useState('')

  const toKey =
    (toOverride && keys.includes(toOverride) ? toOverride : '') ||
    (resolvedDefault && keys.includes(resolvedDefault)
      ? resolvedDefault
      : '') ||
    keys[0] ||
    ''

  const onToSelect = (next: string) => {
    setToOverride(next)
    saveLastTicketTarget(next)
  }

  const runPreview = async (payload: MessagePayload) => {
    if (!toKey) {
      setError(t`Select a target repository first.`)
      return false
    }
    setDrafting(true)
    setError('')
    try {
      setPreview(
        await requestTicketDraft({
          toKey,
          text: payload.text,
          attachments: payload.attachments,
          sessionId,
          includeContext,
        }),
      )
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setDrafting(false)
    }
  }

  const draft = useRichDraft({
    storageKey: `wezdeck-ticket-draft:${draftKey}`,
    imageKey: `ticket:${draftKey}`,
    onSend: async (outgoing) => {
      if (run) return runPreview(outgoing)
      if (!toKey) {
        setError(t`Select a target repository first.`)
        return false
      }
      setBusy(true)
      setError('')
      try {
        const info = await createTicketAndSync(
          client,
          {
            mode: 'quick',
            from: targets.data?.session_target || 'web',
            to: toKey,
            text: outgoing.text,
            attachments: outgoing.attachments,
            origin_session: sessionId || undefined,
            include_context: Boolean(sessionId && includeContext),
            run: false,
          },
          {
            toKey,
            mode: 'quick',
            attachmentsCount: outgoing.attachments.length,
            withManager,
          },
        )
        onCreated?.(info)
        return true
      } catch (e) {
        setError((e as Error).message)
        return false
      } finally {
        setBusy(false)
      }
    },
  })

  const seededRef = useRef('')
  useEffect(() => {
    if (!initialPayload) return
    const sig = `${initialPayload.text}::${initialPayload.attachments.join(',')}`
    if (seededRef.current === sig) return
    seededRef.current = sig
    draft.replacePayload(initialPayload)
  }, [initialPayload])

  const triggerManualPreview = async () => {
    if (!draft.ready || busy || drafting) return
    setDrafting(true)
    setError('')
    try {
      const attachments = await materializeAttachments(draft.images)
      if (await runPreview({ text: draft.text.trim(), attachments })) {
        draft.setText('')
      }
    } catch (e) {
      setError((e as Error).message)
      setDrafting(false)
    }
  }

  const submitStructured = async (
    args: Record<string, unknown>,
    opts: { mode: 'preview' | 'manual'; attachmentsCount: number },
  ) => {
    if (!toKey) return
    setBusy(true)
    setError('')
    try {
      const info = await createTicketAndSync(client, args, {
        ...opts,
        toKey,
        withManager,
        run,
      })
      setPreview(null)
      onCreated?.(info)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return {
    targets,
    keys,
    mode,
    setMode,
    toKey,
    onToSelect,
    fromKey,
    setFromKey,
    includeContext,
    setIncludeContext,
    run,
    setRun,
    withManager,
    setWithManager,
    busy,
    drafting,
    error,
    setError,
    preview,
    setPreview,
    manualTitle,
    setManualTitle,
    manualObserved,
    setManualObserved,
    manualAssumed,
    setManualAssumed,
    draft,
    triggerManualPreview,
    submitStructured,
  }
}
