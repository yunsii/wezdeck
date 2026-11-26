import { useLingui } from '@lingui/react/macro'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Select } from '#/components/ui/select'
import { useMediaQuery } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { AgentAvatar } from './agent-avatar'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'
import { AgentDetail } from './me-agent-detail'

export function AgentsPage() {
  const { t } = useLingui()
  const profiles = useAgentProfiles()
  const [preferred, setPreferred] = usePreferredAgentProfile()
  const [picked, setPicked] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const desktop = useMediaQuery('(min-width: 1024px)', false)
  const rows = profiles.data?.profiles ?? []
  const selected = rows.find((profile) => profile.id === picked) ?? rows[0]

  if (profiles.isError)
    return (
      <p
        role="alert"
        className="text-caption text-brand-error"
      >{t`Could not read agent profiles.`}</p>
    )

  return (
    <div className="min-w-0" data-testid="agents-page">
      <div
        className={cn(
          'mb-4 grid gap-1.5',
          mobileDetail && !desktop && 'hidden',
        )}
      >
        <span className="text-caption text-brand-muted">{t`Default agent for new sessions in this browser`}</span>
        <Select
          aria-label={t`Default agent`}
          size="lg"
          value={
            rows.some((profile) => profile.id === preferred) ? preferred : ''
          }
          onValueChange={setPreferred}
          options={[
            { value: '', label: t`Repository default` },
            ...rows.map((profile) => ({
              value: profile.id,
              label: profile.label,
            })),
          ]}
        />
      </div>
      <div className="grid min-h-[26rem] min-w-0 lg:grid-cols-[minmax(180px,210px)_minmax(0,1fr)] lg:border-t lg:border-brand-edge">
        <div
          className={cn(
            'min-w-0 lg:border-r lg:border-brand-edge lg:pr-3',
            mobileDetail && !desktop && 'hidden',
          )}
        >
          {profiles.isLoading ? (
            <p className="py-4 text-caption text-brand-muted">{t`Loading…`}</p>
          ) : (
            <div className="grid content-start" aria-label={t`Agents`}>
              {rows.map((profile) => (
                <Button
                  key={profile.id}
                  variant="plain"
                  size="none"
                  type="button"
                  aria-current={selected.id === profile.id ? 'true' : undefined}
                  data-agent-profile={profile.id}
                  onClick={() => {
                    setPicked(profile.id)
                    setMobileDetail(true)
                  }}
                  className={cn(
                    'flex min-h-14 w-full min-w-0 items-center gap-2.5 border-b border-brand-edge px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                    selected.id === profile.id
                      ? 'bg-brand-soft text-brand-text'
                      : 'text-brand-muted',
                  )}
                >
                  <AgentAvatar profile={profile.id} size={36} />
                  <span className="min-w-0 flex-1 truncate text-body">
                    {profile.label}
                  </span>
                  {profile.id === 'claude_kimi' && !profile.configured ? (
                    <span className="shrink-0 text-meta text-brand-label">{t`Not configured`}</span>
                  ) : null}
                  <ChevronRight
                    size={16}
                    aria-hidden
                    className="shrink-0 text-brand-label lg:hidden"
                  />
                </Button>
              ))}
            </div>
          )}
        </div>
        <div
          className={cn(
            'min-w-0 pt-3 lg:pl-5',
            !desktop && !mobileDetail && 'hidden',
          )}
        >
          {!desktop ? (
            <Button
              type="button"
              variant="plain"
              onClick={() => setMobileDetail(false)}
              className="mb-2 inline-flex min-h-11 items-center gap-1.5 px-1 text-caption text-brand-muted"
            >
              <ArrowLeft size={16} aria-hidden />
              {t`Back to agents`}
            </Button>
          ) : null}
          {rows.length > 0 ? (
            <AgentDetail key={selected.id} profile={selected} />
          ) : (
            <div className="min-h-[24rem]" aria-hidden />
          )}
        </div>
      </div>
    </div>
  )
}
