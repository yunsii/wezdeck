import { useLingui } from '@lingui/react/macro'
import { ShieldCheck } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { Select } from '#/components/ui/select'
import type { AgentProfile } from './agent-profiles'

type Repo = { root: string; label: string; visited?: number }

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
  agentProfile,
  defaultAgentDisabled,
  onAgentProfile,
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
  agentProfile: string
  defaultAgentDisabled: boolean
  onAgentProfile: (next: string) => void
}) {
  const { t } = useLingui()
  return (
    <>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Repository`}
        <Select
          value={repo}
          disabled={busy || Boolean(group) || repositories.length < 2}
          onValueChange={onRepo}
          size="lg"
          aria-label={t`Repository`}
          options={
            group
              ? [{ value: repo, label: repoLabel }]
              : repositories.map(({ root, label }) => ({ value: root, label }))
          }
        />
      </label>
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
        <label className="grid gap-1 text-caption text-brand-muted">
          {t`Agent`}
          <Select
            value={agentProfile}
            disabled={busy}
            onValueChange={onAgentProfile}
            size="lg"
            aria-label={t`Agent`}
            options={[
              {
                value: '',
                label: t`Repository default`,
                disabled: defaultAgentDisabled,
              },
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
            ]}
          />
        </label>
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
