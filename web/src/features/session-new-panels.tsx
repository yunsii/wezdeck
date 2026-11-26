import { useLingui } from '@lingui/react/macro'
import { Check, ChevronRight, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { Select } from '#/components/ui/select'
import { trace } from '#/lib/client-trace'
import type { AgentProfile } from './agent-profiles'

type Repo = { root: string; label: string; visited?: number }
export type PickerOption = { value: string; label: string; disabled?: boolean }

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
    { value: '', label: t`Repository default`, disabled: defaultAgentDisabled },
    ...agentProfiles.map((profile) => ({
      value: profile.id,
      disabled: profile.disabled,
      label: profile.disabled
        ? `${profile.label} (${t`Disabled`})`
        : profile.id === 'claude_kimi' && !profile.configured
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
            <span className="min-w-0 break-words">{option.label}</span>
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
  stage:
    'creating' | 'starting' | 'waiting_trust' | 'sending' | 'done' | 'failed'
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

export function ComposeLayer({
  busy,
  repoLabel,
  repositories,
  repo,
  onRepo,
  group,
  groupName,
  onGroupName,
  prompt,
  setPrompt,
  current,
  stageText,
  error,
  ready,
  onSubmit,
  onTrust,
  trusting,
  agentProfiles,
  agentOptions,
  agentProfile,
  onAgentProfile,
  mobile,
  onOpenPicker,
}: {
  busy: boolean
  repoLabel: string
  repositories: Array<Repo>
  repo: string
  onRepo: (repo: string) => void
  group?: string
  groupName?: string
  onGroupName: (name: string) => void
  prompt: string
  setPrompt: (next: string) => void
  current?: StageJob
  stageText: (job: StageJob) => string
  error: string
  ready: boolean
  onSubmit: () => void
  onTrust: () => void
  trusting: boolean
  agentProfiles: Array<AgentProfile>
  agentOptions: Array<PickerOption>
  agentProfile: string
  onAgentProfile: (next: string) => void
  mobile: boolean
  onOpenPicker: (picker: 'repo' | 'agent') => void
}) {
  const { t } = useLingui()
  return (
    <>
      <div className="grid gap-1 text-caption text-brand-muted">
        <span>{t`Repository`}</span>
        {mobile ? (
          <Button
            variant="plain"
            type="button"
            role="combobox"
            data-new-session-picker-trigger="repo"
            aria-label={t`Repository`}
            aria-haspopup="listbox"
            aria-expanded={false}
            disabled={busy || Boolean(group) || repositories.length < 2}
            onClick={() => onOpenPicker('repo')}
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl bg-brand-surface px-3 text-left text-body text-brand-text disabled:opacity-60"
          >
            <span className="min-w-0 truncate">{repoLabel}</span>
            <ChevronRight
              size={16}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
          </Button>
        ) : (
          <Select
            value={repo}
            disabled={busy || Boolean(group) || repositories.length < 2}
            onValueChange={onRepo}
            size="lg"
            aria-label={t`Repository`}
            options={
              group
                ? [{ value: repo, label: repoLabel }]
                : repositories.map(({ root, label }) => ({
                    value: root,
                    label,
                  }))
            }
          />
        )}
      </div>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`What do you want to solve?`}
        <Textarea
          value={prompt}
          disabled={busy}
          rows={4}
          autoFocus
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t`What should it work on?`}
        />
      </label>
      {groupName !== undefined ? (
        <label className="grid gap-1 text-caption text-brand-muted">
          {t`Group name`}
          <Input
            value={groupName}
            onChange={(event) => onGroupName(event.target.value)}
            disabled={busy}
            maxLength={60}
            data-testid="new-session-group-name"
          />
        </label>
      ) : group ? (
        <p className="truncate text-caption text-brand-muted">{group}</p>
      ) : null}
      {agentProfiles.length > 0 ? (
        <div className="grid gap-1 text-caption text-brand-muted">
          <span>{t`Agent`}</span>
          {mobile ? (
            <Button
              variant="plain"
              type="button"
              role="combobox"
              data-new-session-picker-trigger="agent"
              aria-label={t`Agent`}
              aria-haspopup="listbox"
              aria-expanded={false}
              disabled={busy}
              onClick={() => onOpenPicker('agent')}
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl bg-brand-surface px-3 text-left text-body text-brand-text disabled:opacity-60"
            >
              <span className="min-w-0 truncate">
                {
                  agentOptions.find((option) => option.value === agentProfile)
                    ?.label
                }
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
              disabled={busy}
              onValueChange={onAgentProfile}
              size="lg"
              aria-label={t`Agent`}
              options={agentOptions}
            />
          )}
        </div>
      ) : null}
      {current ? (
        <p
          role="status"
          data-testid="new-session-stage"
          data-stage={current.stage}
          className={
            current.stage === 'failed'
              ? 'rounded-xl bg-brand-error/10 px-3 py-2 text-caption text-brand-error'
              : 'rounded-xl bg-brand-surface px-3 py-2 text-caption'
          }
        >
          {stageText(current)}
        </p>
      ) : null}
      {current?.stage === 'waiting_trust' ? (
        <Button
          type="button"
          onClick={onTrust}
          disabled={trusting}
          className="min-h-11 justify-self-start gap-2 px-3"
          data-testid="agy-trust-worktree"
        >
          <ShieldCheck size={16} aria-hidden />
          {t`Trust this worktree and continue`}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-brand-error">
          {error}
        </p>
      ) : null}
      {current?.stage !== 'waiting_trust' ? (
        <Button
          variant="solid"
          type="button"
          disabled={!ready || busy}
          onClick={onSubmit}
          className="min-h-12 px-3 text-body disabled:opacity-40"
        >
          {t`Create session`}
        </Button>
      ) : null}
    </>
  )
}
