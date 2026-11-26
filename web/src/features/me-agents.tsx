import { useLingui } from '@lingui/react/macro'
import { ArrowLeft, ChevronRight, Hash } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { OverlayScroll } from '#/components/deck/overlay-scroll'
import { Select } from '#/components/ui/select'
import { useMediaQuery } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { AgentAvatar } from './agent-avatar'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'
import { AgentDetail } from './me-agent-detail'
import { CopyKey, useCopyAgentReference } from './copy-reference'

export function AgentsPage() {
  const { t } = useLingui()
  const profiles = useAgentProfiles()
  const [preferred, setPreferred] = usePreferredAgentProfile()
  const [picked, setPicked] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const desktop = useMediaQuery('(min-width: 1280px)', false)
  const rows = profiles.data?.profiles ?? []
  const selected = rows.find((profile) => profile.id === picked) ?? rows[0]
  const copyReference = useCopyAgentReference(rows)

  if (profiles.isError)
    return (
      <p
        role="alert"
        className="text-caption text-brand-error"
      >{t`Could not read agent profiles.`}</p>
    )

  return (
    <div className="min-w-0" data-testid="agents-page">
      {rows.length > 0 && (desktop || mobileDetail) ? (
        <CopyKey id={selected.id} copy={copyReference} />
      ) : null}
      <div
        className={cn(
          'mb-4 grid max-w-lg gap-1.5 md:ml-[var(--page-x)]',
          mobileDetail && !desktop && 'hidden',
        )}
      >
        <span className="text-caption text-brand-muted">{t`Default agent for new sessions in this browser`}</span>
        <Select
          aria-label={t`Default agent`}
          size="lg"
          value={
            rows.some(
              (profile) => profile.id === preferred && !profile.disabled,
            )
              ? preferred
              : ''
          }
          onValueChange={setPreferred}
          options={[
            {
              value: '',
              label: t`Repository default`,
              disabled: rows.some(
                (profile) => profile.default && profile.disabled,
              ),
            },
            ...rows.map((profile) => ({
              value: profile.id,
              label: profile.disabled
                ? `${profile.label} (${t`Disabled`})`
                : profile.label,
              disabled: profile.disabled,
            })),
          ]}
        />
      </div>
      <div className="grid min-h-[26rem] min-w-0 xl:grid-cols-[15rem_minmax(0,1fr)] xl:border-t xl:border-brand-edge">
        <OverlayScroll
          className={cn(
            'min-w-0 xl:border-r xl:border-brand-edge',
            mobileDetail && !desktop && 'hidden',
          )}
        >
          {profiles.isLoading ? (
            <p className="py-4 text-caption text-brand-muted">{t`Loading…`}</p>
          ) : (
            <div className="grid content-start" aria-label={t`Agents`}>
              {rows.map((profile) => (
                <div
                  key={profile.id}
                  className={cn(
                    'list-row flex min-w-0 items-center border-b border-brand-edge',
                    selected.id === profile.id && 'row-selected',
                  )}
                >
                  <Button
                    variant="plain"
                    size="none"
                    type="button"
                    aria-current={
                      selected.id === profile.id ? 'true' : undefined
                    }
                    data-agent-profile={profile.id}
                    onClick={() => {
                      setPicked(profile.id)
                      setMobileDetail(true)
                    }}
                    className={cn(
                      'flex min-h-14 min-w-0 flex-1 items-center gap-2.5 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                      selected.id === profile.id
                        ? 'text-brand-text'
                        : 'text-brand-muted',
                    )}
                  >
                    <AgentAvatar profile={profile.id} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body">
                        {profile.label}
                      </span>
                      {profile.disabled || profile.note ? (
                        <span className="block truncate text-meta text-brand-label">
                          {profile.disabled ? t`Disabled` : ''}
                          {profile.disabled && profile.note ? ' · ' : ''}
                          {profile.note}
                        </span>
                      ) : null}
                    </span>
                    {profile.id === 'claude_kimi' && !profile.configured ? (
                      <span className="shrink-0 text-meta text-brand-label">{t`Not configured`}</span>
                    ) : null}
                    <ChevronRight
                      size={16}
                      aria-hidden
                      className="shrink-0 text-brand-label xl:hidden"
                    />
                  </Button>
                  <Button
                    variant="plain"
                    size="none"
                    type="button"
                    aria-label={`${t`Copy reference`}: ${profile.label}`}
                    title={t`Copy reference`}
                    data-testid="agent-copy-reference"
                    onClick={() => void copyReference(profile.id)}
                    className="mr-1 grid size-10 shrink-0 place-items-center rounded-lg text-brand-label outline-none hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running xl:size-8"
                  >
                    <Hash size={16} aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </OverlayScroll>
        <div
          className={cn(
            'min-w-0 pt-3 md:max-xl:pl-[var(--page-x)] xl:pl-4',
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
            <AgentDetail
              key={selected.id}
              profile={selected}
              onCopy={() => void copyReference(selected.id)}
            />
          ) : (
            <div className="min-h-[24rem]" aria-hidden />
          )}
        </div>
      </div>
    </div>
  )
}
