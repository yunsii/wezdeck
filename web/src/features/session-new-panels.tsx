import { useLingui } from '@lingui/react/macro'
import { Check, ChevronRight, FolderGit2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { Sheet } from '#/components/ui/sheet'
import { cn } from '#/lib/utils'
import { trace } from '#/lib/client-trace'
import { AgentAvatar } from './agent-avatar'
import type { AgentProfile } from './agent-profiles'
import type { NewSessionStage } from './session-new-route'

type Repo = { root: string; label: string; visited?: number }
export type PickerOption = {
  value: string
  label: string
  disabled?: boolean
  icon?: React.ReactNode
}

export function useAgentSelection(
  profiles: Array<AgentProfile>,
  preferred: string,
) {
  const [picked, setPicked] = useState<string | null>(null)
  const available = profiles.filter((profile) => !profile.disabled)
  const defaultDisabled = profiles.some(
    (profile) => profile.default && profile.disabled,
  )
  const requested = picked ?? preferred
  const selected = available.some((profile) => profile.id === requested)
    ? requested
    : defaultDisabled
      ? available[0]?.id || ''
      : ''
  return { available, defaultDisabled, selected, setPicked }
}

export function useNewSessionPicker() {
  const [picker, setPicker] = useState<'repo' | 'agent' | null>(null)
  const openPicker = (next: 'repo' | 'agent') => {
    trace('session-new-picker', { action: 'open', mode: next })
    setPicker(next)
  }
  const backToForm = (action: 'back' | 'pick' = 'back') => {
    const previous = picker
    if (previous) trace('session-new-picker', { action, mode: previous })
    setPicker(null)
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-new-session-picker-trigger="${previous}"]`,
        )
        ?.focus()
    })
  }
  return { picker, openPicker, backToForm }
}

export function useNewSessionAgentOptions(
  agentProfiles: Array<AgentProfile>,
  defaultAgentDisabled: boolean,
): Array<PickerOption> {
  const { t } = useLingui()
  return [
    ...(defaultAgentDisabled
      ? []
      : [
          {
            value: '',
            label: t`Repository default`,
            icon: <AgentAvatar size={24} />,
          },
        ]),
    ...agentProfiles
      .filter((profile) => !profile.disabled)
      .map((profile) => ({
        value: profile.id,
        icon: <AgentAvatar profile={profile.id} size={24} />,
        label:
          profile.id === 'claude_kimi' && !profile.configured
            ? `${profile.label} (${t`Not configured`})`
            : profile.default
              ? `${profile.label} (${t`host default`})`
              : profile.label,
      })),
  ]
}

export function NewSessionPicker({
  title,
  options,
  value,
  onPick,
}: {
  title: string
  options: Array<PickerOption>
  value: string
  onPick: (value: string) => void
}) {
  const { t } = useLingui()
  const [query, setQuery] = useState('')
  const shown = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  return (
    <div data-testid="new-session-picker" className="grid gap-2 px-4 pb-2">
      <Input
        variant="field"
        type="search"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={t`Search`}
        placeholder={t`Search`}
      />
      <div role="listbox" aria-label={title} className="grid gap-0.5">
        {shown.map((option) => (
          <Button
            variant="plain"
            type="button"
            role="option"
            aria-selected={option.value === value}
            key={option.value || '__default'}
            disabled={option.disabled}
            onClick={() => onPick(option.value)}
            className="flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-body text-brand-text hover:bg-brand-surface disabled:opacity-40 aria-selected:bg-brand-surface"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              {option.icon ? (
                <span aria-hidden className="inline-flex shrink-0">
                  {option.icon}
                </span>
              ) : null}
              <span className="min-w-0 break-words">{option.label}</span>
            </span>
            {option.value === value ? (
              <Check
                size={18}
                className="shrink-0 text-brand-running"
                aria-hidden
              />
            ) : null}
          </Button>
        ))}
        {shown.length === 0 ? (
          <p className="py-8 text-center text-caption text-brand-muted">
            {t`Nothing matches`}
          </p>
        ) : null}
      </div>
    </div>
  )
}

type StageJob = {
  stage: NewSessionStage
  branch?: string
  error?: string
  mode?: 'new' | 'parallel' | 'reuse' | 'group'
}

export function useStageText() {
  const { t } = useLingui()
  return (job: StageJob) => {
    const reason = job.error ?? ''
    return job.stage === 'creating'
      ? job.mode === 'reuse'
        ? t`Resetting the workstation onto the latest main branch…`
        : job.mode === 'group'
          ? t`Starting the agent…`
          : t`Creating the session group…`
      : job.stage === 'starting'
        ? t`Starting the agent…`
        : job.stage === 'waiting_trust'
          ? t`Agy is waiting for this worktree to be trusted.`
          : job.stage === 'sending'
            ? t`Sending the first message…`
            : job.stage === 'done'
              ? t`Started. Opening the session when the agent picks it up…`
              : t`Could not create it: ${reason}`
  }
}

export function NewSessionSetupCard({
  mobile,
  sending,
  picker,
  onOpenPicker,
  repositories,
  repo,
  repoLabel,
  onRepo,
  group,
  nameGroup,
  resolvedGroupName,
  onGroupName,
  showAgents,
  agentOptions,
  agentProfile,
  onAgentProfile,
}: {
  mobile: boolean
  sending: boolean
  picker: 'repo' | 'agent' | null
  onOpenPicker: (next: 'repo' | 'agent') => void
  repositories: Array<Repo>
  repo: string
  repoLabel: string
  onRepo: (next: string) => void
  group?: string
  nameGroup: boolean
  resolvedGroupName: string
  onGroupName: (next: string) => void
  showAgents: boolean
  agentOptions: Array<PickerOption>
  agentProfile: string
  onAgentProfile: (next: string) => void
}) {
  const { t } = useLingui()
  const selectedAgent = agentOptions.find(
    (option) => option.value === agentProfile,
  )
  return (
    <section data-testid="new-session-setup" className="grid gap-3">
      <div
        className={cn('grid grid-cols-1 gap-3', showAgents && 'sm:grid-cols-2')}
      >
        <div className="grid min-w-0 gap-1.5 text-caption text-brand-muted">
          <span className="px-0.5">{t`Repository`}</span>
          {mobile ? (
            <Button
              variant="plain"
              type="button"
              role="combobox"
              data-new-session-picker-trigger="repo"
              aria-label={t`Repository`}
              aria-haspopup="listbox"
              aria-expanded={picker === 'repo'}
              disabled={sending || Boolean(group) || repositories.length < 2}
              onClick={() => onOpenPicker('repo')}
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl bg-brand-surface px-3 text-left text-body text-brand-text disabled:opacity-60"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FolderGit2
                  size={20}
                  aria-hidden
                  className="shrink-0 text-brand-label"
                />
                <span className="min-w-0 truncate">{repoLabel}</span>
              </span>
              <ChevronRight
                size={16}
                aria-hidden
                className="shrink-0 text-brand-label"
              />
            </Button>
          ) : (
            <Select
              value={repo}
              disabled={sending || Boolean(group) || repositories.length < 2}
              onValueChange={onRepo}
              size="lg"
              aria-label={t`Repository`}
              options={
                group
                  ? [
                      {
                        value: repo,
                        label: repoLabel,
                        icon: (
                          <FolderGit2 size={20} className="text-brand-label" />
                        ),
                      },
                    ]
                  : repositories.map(({ root, label }) => ({
                      value: root,
                      label,
                      icon: (
                        <FolderGit2 size={20} className="text-brand-label" />
                      ),
                    }))
              }
            />
          )}
        </div>

        {showAgents ? (
          <div className="grid min-w-0 gap-1.5 text-caption text-brand-muted">
            <span className="px-0.5">{t`Agent`}</span>
            {mobile ? (
              <Button
                variant="plain"
                type="button"
                role="combobox"
                data-new-session-picker-trigger="agent"
                aria-label={t`Agent`}
                aria-haspopup="listbox"
                aria-expanded={picker === 'agent'}
                disabled={sending}
                onClick={() => onOpenPicker('agent')}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl bg-brand-surface px-3 text-left text-body text-brand-text disabled:opacity-60"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {selectedAgent?.icon ? (
                    <span aria-hidden className="inline-flex shrink-0">
                      {selectedAgent.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">
                    {selectedAgent?.label}
                  </span>
                </span>
                <ChevronRight
                  size={16}
                  aria-hidden
                  className="shrink-0 text-brand-label"
                />
              </Button>
            ) : (
              <Select
                value={agentProfile}
                disabled={sending}
                onValueChange={onAgentProfile}
                size="lg"
                aria-label={t`Agent`}
                options={agentOptions}
              />
            )}
          </div>
        ) : null}
      </div>

      {nameGroup ? (
        <label className="grid min-w-0 gap-1.5 text-caption text-brand-muted">
          <span className="px-0.5">{t`Group name`}</span>
          <Input
            variant="field"
            value={resolvedGroupName}
            onChange={(event) => onGroupName(event.target.value)}
            disabled={sending}
            maxLength={60}
            data-testid="new-session-group-name"
          />
        </label>
      ) : group ? (
        <p className="truncate px-0.5 text-caption text-brand-muted">{group}</p>
      ) : null}
    </section>
  )
}

export function NewSessionPickerSheet({
  picker,
  repositories,
  repo,
  agentOptions,
  agentProfile,
  onPickRepo,
  onPickAgent,
  onBack,
}: {
  picker: 'repo' | 'agent' | null
  repositories: Array<Repo>
  repo: string
  agentOptions: Array<PickerOption>
  agentProfile: string
  onPickRepo: (value: string) => void
  onPickAgent: (value: string) => void
  onBack: (action?: 'back' | 'pick') => void
}) {
  const { t } = useLingui()
  const title = picker === 'repo' ? t`Repository` : t`Agent`
  return (
    <Sheet
      open={Boolean(picker)}
      onOpenChange={(next) => {
        if (!next) onBack()
      }}
      title={title}
      onBack={() => onBack()}
      testId="new-session-picker-sheet"
    >
      {picker ? (
        <NewSessionPicker
          key={picker}
          title={title}
          options={
            picker === 'repo'
              ? repositories.map(({ root, label }) => ({
                  value: root,
                  label,
                  icon: <FolderGit2 size={20} />,
                }))
              : agentOptions
          }
          value={picker === 'repo' ? repo : agentProfile}
          onPick={(value) => {
            if (picker === 'repo') onPickRepo(value)
            else onPickAgent(value)
            onBack('pick')
          }}
        />
      ) : null}
    </Sheet>
  )
}
