import { useLingui } from '@lingui/react/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { useLocale } from '#/lib/locale-context'
import { hostWrite } from '#/lib/runtime-client'
import { hideDeletedSessions, sessionDeleteKey } from './session-delete-state'
import type {
  SessionDeleteReply,
  SessionDeleteRequest,
  SessionsReply,
} from './session-delete-state'
import type { SessionCard } from './session-card'

export function useDeleteSession() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [request, setRequest] = useState<{
    session: SessionCard
    selected: boolean
    options?: { force?: boolean }
  }>()
  const [open, setOpen] = useState(false)
  const goToSession = (id: string) =>
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id },
    })
  const mutation = useMutation({
    mutationKey: sessionDeleteKey,
    retry: false,
    mutationFn: async ({ id, force }: SessionDeleteRequest) =>
      (await hostWrite('session.delete', {
        id,
        confirm: true,
        ...(force ? { force: true } : {}),
      })) as SessionDeleteReply,
    onSuccess: async ({ worktree_outcome: outcome }, { id }) => {
      if (outcome === 'review_required') {
        toast.warning(
          t`This worktree has local changes. Review them in the session before deleting.`,
          {
            action: { label: t`Open session`, onClick: () => goToSession(id) },
          },
        )
        return
      }
      const key = ['remote', 'sessions']
      await client.cancelQueries({ queryKey: key })
      client.setQueryData<SessionsReply>(
        key,
        (data) => data && hideDeletedSessions(data, new Set([id])),
      )
      const messages: Record<string, string> = {
        removed: t`Session deleted and worktree removed`,
        dirty: t`Session deleted. The worktree has local changes.`,
        in_use: t`Session deleted. Another process is using the worktree.`,
        retained: t`Session deleted. The worktree could not be removed.`,
        undelivered: t`Session deleted. The worktree has changes outside the default branch.`,
      }
      toast(messages[outcome] ?? t`Session deleted`)
    },
    onError: (error, { id }) => {
      toast.error(error.message, {
        action: { label: t`Open session`, onClick: () => goToSession(id) },
      })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    },
  })
  const confirm = () => {
    if (!request || !open) return
    const { session, selected, options } = request
    setOpen(false)
    if (
      client.isMutating({
        mutationKey: sessionDeleteKey,
        predicate: (pending) =>
          (pending.state.variables as SessionDeleteRequest).id === session.id,
      })
    )
      return
    mutation.mutate({ id: session.id, force: options?.force })
    if (selected) {
      void navigate({
        to: '/{-$locale}/console/sessions',
        params: { locale: locale === 'en' ? undefined : locale },
        replace: true,
      })
    }
  }
  const title = request?.session.title || request?.session.agent || ''
  const force = request?.options?.force
  const action = force
    ? t`Force delete session and worktree`
    : t`Delete session`
  return {
    ask: (
      session: SessionCard,
      selected: boolean,
      options?: { force?: boolean },
    ) => {
      setRequest({ session, selected, options })
      setOpen(true)
    },
    confirmation: request ? (
      <Sheet
        open={open}
        write
        title={action}
        testId="session-delete-confirm"
        onOpenChange={(next) => {
          if (!next) setOpen(false)
        }}
      >
        <div className="grid gap-4 px-4">
          <p className="text-body text-brand-muted">
            {force
              ? t`Force delete “${title}” and its worktree? This discards uncommitted changes and local files. The branch and conversation history are kept.`
              : t`Delete “${title}”? This stops its agent. An empty, clean worktree may be removed. The conversation history is kept.`}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="plain"
              onClick={() => setOpen(false)}
            >
              {t`Cancel`}
            </Button>
            <Button
              type="button"
              variant="solid"
              className="bg-brand-error text-white"
              onClick={confirm}
            >
              {action}
            </Button>
          </div>
        </div>
      </Sheet>
    ) : null,
  }
}
