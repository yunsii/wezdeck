import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { useLocale } from '#/lib/locale-context'
import { hostWrite } from '#/lib/runtime-client'
import type { SessionCard } from './session-card'

export function useDeleteSession() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const client = useQueryClient()
  const navigate = useNavigate()
  return async (session: SessionCard, selected: boolean) => {
    const title = session.title || session.agent
    if (
      !window.confirm(
        t`Delete “${title}”? This stops its agent. An empty, clean worktree may be removed. The conversation history is kept.`,
      )
    ) {
      return
    }
    try {
      const result = (await hostWrite('session.delete', {
        id: session.id,
        confirm: true,
      })) as { worktree_outcome: string }
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
        undelivered: t`Session deleted. The worktree has changes outside the default branch.`,
      }
      toast(messages[result.worktree_outcome] ?? t`Session deleted`)
    } catch (error) {
      toast.error((error as Error).message)
    }
  }
}
