import { useLingui } from '@lingui/react/macro'

import { BackButton } from '#/components/deck/back-button'
import { AgentAvatar } from './agent-avatar'

export function NewSessionHeader({
  back,
  anchor,
  agent,
}: {
  back: () => void
  anchor?: string
  agent: string
}) {
  const { t } = useLingui()
  return (
    <header
      data-testid="new-session-header"
      className="sticky top-[env(safe-area-inset-top)] z-30 -mx-2.5 -mt-1 flex min-h-13 items-center gap-1 border-b border-brand-edge bg-brand-deck px-2.5 py-1.5 md:static md:mx-0 md:mt-0 md:shrink-0 md:px-4"
    >
      <BackButton
        onClick={back}
        label={t({ message: 'Sessions', context: 'nav' })}
        className="-ml-2 md:hidden"
      />
      {agent ? (
        <AgentAvatar profile={agent} size={32} />
      ) : (
        <span
          aria-hidden
          className="size-8 shrink-0 rounded-full bg-brand-surface"
        />
      )}
      <h1 className="min-w-0 flex-1 truncate text-title leading-tight font-semibold">
        {anchor ? t`New session in this group` : t`New session`}
      </h1>
    </header>
  )
}
