import { useLingui } from '@lingui/react/macro'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Hash,
} from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { OverlayScroll } from '#/components/deck/overlay-scroll'
import { Select } from '#/components/ui/select'
import { useMediaQuery } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { AgentAvatar } from './agent-avatar'
import type { AgentProfile } from './agent-profiles'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'
import { AgentDetail } from './me-agent-detail'
import { CopyKey, useCopyAgentReference } from './copy-reference'

function AgentProfileRow({
  profile,
  selected,
  onSelect,
  onCopy,
}: {
  profile: AgentProfile
  selected: boolean
  onSelect: () => void
  onCopy: () => void
}) {
  const { t } = useLingui()
  return (
    <div
      className={cn(
        'list-row flex min-w-0 items-center border-b border-brand-edge',
        profile.disabled && 'opacity-75',
        selected && 'row-selected opacity-100',
      )}
    >
      <Button
        variant="plain"
        size="none"
        type="button"
        aria-current={selected ? 'true' : undefined}
        data-agent-profile={profile.id}
        onClick={onSelect}
        className={cn(
          'flex min-h-14 min-w-0 flex-1 items-center gap-2.5 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
          selected ? 'text-brand-text' : 'text-brand-muted',
        )}
      >
        <AgentAvatar profile={profile.id} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body">{profile.label}</span>
          {profile.disabled ? (
            <span className="block truncate text-meta text-brand-label">
              {t`Disabled`}
              {profile.note ? ` · ${profile.note}` : ''}
            </span>
          ) : profile.note ? (
            <span className="block truncate text-meta text-brand-label">
              {profile.note}
            </span>
          ) : null}
        </span>
        {!profile.disabled &&
        profile.id === 'claude_kimi' &&
        !profile.configured ? (
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
        onClick={onCopy}
        className="mr-1 grid size-10 shrink-0 place-items-center rounded-lg text-brand-label outline-none hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running xl:size-8"
      >
        <Hash size={16} aria-hidden />
      </Button>
    </div>
  )
}

export function AgentsPage() {
  const { t } = useLingui()
  const profiles = useAgentProfiles()
  const [preferred, setPreferred] = usePreferredAgentProfile()
  const [picked, setPicked] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const [showDisabled, setShowDisabled] = useState(false)
  const desktop = useMediaQuery('(min-width: 1280px)', false)
  const rows = profiles.data?.profiles ?? []
  const enabledRows = rows.filter((profile) => !profile.disabled)
  const disabledRows = rows.filter((profile) => profile.disabled)
  const selected =
    rows.find((profile) => profile.id === picked) ??
    enabledRows.at(0) ??
    rows.at(0)
  const disabledExpanded =
    showDisabled || Boolean(selected?.disabled && picked === selected.id)
  const disabledCount = disabledRows.length
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
      {selected && (desktop || mobileDetail) ? (
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
            ...(rows.some((profile) => profile.default && profile.disabled)
              ? []
              : [
                  {
                    value: '',
                    label: t`Repository default`,
                    icon: <AgentAvatar size={24} />,
                  },
                ]),
            ...rows
              .filter((profile) => !profile.disabled)
              .map((profile) => ({
                value: profile.id,
                icon: <AgentAvatar profile={profile.id} size={24} />,
                label: profile.label,
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
              {enabledRows.map((profile) => (
                <AgentProfileRow
                  key={profile.id}
                  profile={profile}
                  selected={selected?.id === profile.id}
                  onSelect={() => {
                    setPicked(profile.id)
                    setMobileDetail(true)
                  }}
                  onCopy={() => void copyReference(profile.id)}
                />
              ))}
              {disabledCount > 0 ? (
                <>
                  <Button
                    type="button"
                    variant="plain"
                    size="none"
                    data-testid="agents-disabled-toggle"
                    aria-expanded={disabledExpanded}
                    onClick={() => setShowDisabled((prev) => !prev)}
                    className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-brand-edge px-3 text-left text-caption text-brand-label transition-colors hover:bg-brand-soft hover:text-brand-text"
                  >
                    <span>{t`Unavailable agents (${disabledCount})`}</span>
                    {disabledExpanded ? (
                      <ChevronUp size={15} aria-hidden className="shrink-0" />
                    ) : (
                      <ChevronDown size={15} aria-hidden className="shrink-0" />
                    )}
                  </Button>
                  {disabledExpanded
                    ? disabledRows.map((profile) => (
                        <AgentProfileRow
                          key={profile.id}
                          profile={profile}
                          selected={selected?.id === profile.id}
                          onSelect={() => {
                            setPicked(profile.id)
                            setMobileDetail(true)
                          }}
                          onCopy={() => void copyReference(profile.id)}
                        />
                      ))
                    : null}
                </>
              ) : null}
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
          {selected ? (
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
