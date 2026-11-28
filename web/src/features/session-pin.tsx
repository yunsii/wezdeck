import { ContextMenu } from '@base-ui/react/context-menu'
import { useLingui } from '@lingui/react/macro'
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
} from '@tanstack/react-query'
import { Pin, PinOff } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'

import { trace } from '#/lib/client-trace'
import { hostWrite } from '#/lib/runtime-client'
import type { SessionCard } from './session-card'
import type { SessionsReply } from './session-delete-state'

const pinAction = 'session.pin'
const sessionsKey = ['remote', 'sessions']
type PinRequest = { id: string; pinned: boolean }

export function useSessionPinRows(rows: Array<SessionCard>) {
  const pending = useMutationState({
    filters: { mutationKey: [pinAction], status: 'pending' },
    select: ({ state }) => ({
      ...(state.variables as PinRequest),
      at: state.submittedAt,
    }),
  })
  if (!pending.length) return rows
  const byId = new Map(pending.map((operation) => [operation.id, operation]))
  return rows.map((row) => {
    const operation = byId.get(row.id)
    return operation
      ? { ...row, pinned_at: operation.pinned ? operation.at : undefined }
      : row
  })
}

export function openSessionRowMenu(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
    return
  event.preventDefault()
  const row = event.currentTarget
  const { left, bottom } = row.getBoundingClientRect()
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: left + 12,
      clientY: bottom,
    }),
  )
}

export function SessionPinMenuItem({
  row,
  className,
}: {
  row: SessionCard
  className: string
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const mutationKey = [pinAction, row.id]
  const busy = useIsMutating({ mutationKey }) > 0
  const mutation = useMutation({
    mutationKey,
    mutationFn: (request: PinRequest) =>
      hostWrite(pinAction, request) as Promise<{
        id: string
        pinned_at: number
      }>,
    onSuccess: async (reply, request) => {
      await client.cancelQueries({ queryKey: sessionsKey })
      client.setQueryData<SessionsReply>(
        sessionsKey,
        (current) =>
          current && {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === reply.id || session.id === request.id
                ? { ...session, pinned_at: reply.pinned_at || undefined }
                : session,
            ),
          },
      )
      trace('web-write', {
        action: pinAction,
        id: reply.id,
        stage: 'host-accepted',
      })
      void client.invalidateQueries({ queryKey: sessionsKey })
    },
    onError: (_, request) => {
      trace('web-write', { action: pinAction, id: request.id, stage: 'failed' })
      toast.error(t`Could not save session pin`)
    },
  })
  const pinned = Boolean(row.pinned_at)
  return (
    <ContextMenu.Item
      className={className}
      data-testid="session-row-pin"
      disabled={busy}
      onClick={() => mutation.mutate({ id: row.id, pinned: !pinned })}
    >
      {pinned ? (
        <PinOff size={14} aria-hidden />
      ) : (
        <Pin size={14} aria-hidden />
      )}
      {pinned ? t`Unpin session` : t`Pin in this repository`}
    </ContextMenu.Item>
  )
}
