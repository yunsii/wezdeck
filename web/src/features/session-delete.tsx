import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { useLocale } from '#/lib/locale-context'
import { hostWrite } from '#/lib/runtime-client'
import type { SessionCard } from './session-card'

export function useDeleteSession() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [request, setRequest] = useState<{
    session: SessionCard
    selected: boolean
    options?: { force?: boolean; onReview?: () => void }
  }>()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    if (!request || !open || busy) return
    const { session, selected, options } = request
    setBusy(true)
    try {
      const result = (await hostWrite('session.delete', {
        id: session.id,
        confirm: true,
        ...(options?.force ? { force: true } : {}),
      })) as { worktree_outcome: string }
      if (result.worktree_outcome === 'review_required') {
        setOpen(false)
        if (options?.onReview) {
          options.onReview()
        } else {
          toast.warning(
            t`This worktree has local changes. Review them in the session before deleting.`,
            {
              action: {
                label: t`Open session`,
                onClick: () =>
                  void navigate({
                    to: '/{-$locale}/console/sessions/$id',
                    params: {
                      locale: locale === 'en' ? undefined : locale,
                      id: session.id,
                    },
                  }),
              },
            },
          )
        }
        return
      }
      setOpen(false)
      if (selected) {
        await navigate({
          to: '/{-$locale}/console/sessions',
          params: { locale: locale === 'en' ? undefined : locale },
          replace: true,
        })
      }
      await client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
      const messages: Record<string, string> = {
        removed: t`Session deleted and worktree removed`,
        dirty: t`Session deleted. The worktree has local changes.`,
        in_use: t`Session deleted. Another process is using the worktree.`,
        retained: t`Session deleted. The worktree could not be removed.`,
        undelivered: t`Session deleted. The worktree has changes outside the default branch.`,
      }
      toast(messages[result.worktree_outcome] ?? t`Session deleted`)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
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
      options?: { force?: boolean; onReview?: () => void },
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
        onOpenChange={(open) => {
          if (!open && !busy) setOpen(false)
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
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t`Cancel`}
            </Button>
            <Button
              type="button"
              variant="solid"
              className="bg-brand-error text-white"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {action}
            </Button>
          </div>
        </div>
      </Sheet>
    ) : null,
  }
}
