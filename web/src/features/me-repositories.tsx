import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { FolderGit2 } from 'lucide-react'
import { useState } from 'react'

import { Select } from '#/components/ui/select'
import { hostWrite } from '#/lib/runtime-client'
import { AgentAvatar, agentLabel } from './agent-avatar'
import { useAgentProfiles } from './agent-profiles'
import type { AgentProfile } from './agent-profiles'
import { useDeviceState } from './device-state'
import { useRepositories } from './repo-agent-settings'
import type { Repository } from './repo-agent-settings'

function RepositoryRow({
  repo,
  profiles,
  writable,
  onSaved,
}: {
  repo: Repository
  profiles: Array<AgentProfile>
  writable: boolean
  onSaved: () => Promise<unknown>
}) {
  const { t } = useLingui()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const options = profiles
    .filter((profile) => !profile.disabled || profile.id === repo.agent_profile)
    .map((profile) => ({
      value: profile.id,
      label: profile.disabled
        ? `${profile.label} (${t`Disabled`})`
        : profile.label,
      icon: <AgentAvatar profile={profile.id} size={24} />,
      disabled:
        profile.disabled ||
        (profile.id === 'claude_kimi' && !profile.configured),
    }))
  const selected =
    repo.agent_source === 'override' ? repo.agent_profile || '' : ''
  const save = async (profile: string) => {
    setSaving(true)
    setError('')
    try {
      await hostWrite('repo.agent.set', { repo: repo.root, profile })
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <li className="grid gap-2 border-b border-brand-edge px-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)] md:items-center md:gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <FolderGit2
          size={20}
          className="shrink-0 text-brand-label"
          aria-hidden
        />
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-brand-text">
            {repo.label}
          </div>
          <div
            className="truncate font-mono text-meta text-brand-label"
            title={repo.root}
          >
            {repo.root}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-caption text-brand-muted">
            <AgentAvatar profile={repo.agent_profile} size={18} />
            <span>{agentLabel('', repo.agent_profile)}</span>
            <span>
              ·{' '}
              {repo.agent_source === 'override'
                ? t`Web default`
                : t`Workspace default`}
            </span>
          </div>
        </div>
      </div>
      <div className="grid gap-1">
        <Select
          aria-label={`${repo.label} · ${t`Default agent`}`}
          size="lg"
          value={selected}
          disabled={saving || !writable}
          onValueChange={(value) => void save(value)}
          options={[
            {
              value: '',
              label: t`Follow workspace setting`,
              icon: (
                <AgentAvatar
                  profile={
                    repo.agent_source === 'workspace'
                      ? repo.agent_profile
                      : undefined
                  }
                  size={24}
                />
              ),
            },
            ...options,
          ]}
        />
        {error ? (
          <p role="alert" className="text-meta text-brand-error">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  )
}

export function RepositoriesPage() {
  const { t } = useLingui()
  const repos = useRepositories()
  const profiles = useAgentProfiles()
  const device = useDeviceState()
  const client = useQueryClient()
  if (repos.isError)
    return (
      <p
        role="alert"
        className="text-caption text-brand-error"
      >{t`Could not read repositories.`}</p>
    )
  return (
    <div data-testid="repositories-page" className="min-w-0">
      {repos.data?.settings_error ? (
        <p role="alert" className="px-3 pb-3 text-caption text-brand-error">
          {t`Repository agent settings could not be read on the host. Workspace defaults are shown; saving is unavailable.`}
        </p>
      ) : null}
      <p className="px-3 pb-3 text-caption text-brand-muted">
        {t`The web default applies to new sessions from this console. Follow workspace setting uses the agent configured for the repository on the host.`}
      </p>
      <ul className="border-t border-brand-edge bg-brand-surface">
        {(repos.data?.repos ?? []).map((repo) => (
          <RepositoryRow
            key={repo.root}
            repo={repo}
            profiles={profiles.data?.profiles ?? []}
            writable={
              device.state === 'approved' && !repos.data?.settings_error
            }
            onSaved={() =>
              client.invalidateQueries({ queryKey: ['remote', 'repos'] })
            }
          />
        ))}
      </ul>
      {repos.isLoading ? (
        <p className="px-3 py-4 text-caption text-brand-muted">{t`Loading…`}</p>
      ) : null}
      {repos.data?.repos.length === 0 ? (
        <p className="px-3 py-4 text-caption text-brand-muted">{t`No repositories yet`}</p>
      ) : null}
    </div>
  )
}
