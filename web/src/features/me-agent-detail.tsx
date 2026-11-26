import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { hostWrite } from '#/lib/runtime-client'
import { AgentAvatar } from './agent-avatar'
import type { AgentProfile } from './agent-profiles'

function useSaveState() {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const client = useQueryClient()
  const { t } = useLingui()
  const save = async (action: string, args: Record<string, unknown>) => {
    setSaving(true)
    setMessage('')
    try {
      await hostWrite(action, args)
      setMessage(t`Saved`)
      await client.invalidateQueries({ queryKey: ['remote', 'agent.profiles'] })
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }
  return { saving, message, save }
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 border-b border-brand-edge text-caption">
      <span className="shrink-0 text-brand-muted">{label}</span>
      <code className="min-w-0 break-all text-right font-mono text-brand-text">
        {value}
      </code>
    </div>
  )
}

function KimiStatus({ profile }: { profile: AgentProfile }) {
  const { t } = useLingui()
  if (!profile.configured) return null
  const tiers = [
    profile.opus_model,
    profile.sonnet_model,
    profile.haiku_model,
    profile.fable_model,
    profile.subagent_model,
  ].filter(Boolean)
  const sameTier =
    tiers.length > 0 && tiers.every((value) => value === tiers[0])
  return (
    <div className="grid max-w-lg gap-0" data-testid="kimi-status">
      <StatusRow label={t`Base URL`} value={profile.base_url || t`Not set`} />
      <StatusRow
        label={t`Login`}
        value={
          profile.masked_key
            ? t`API Key · ${profile.masked_key}`
            : t`Not configured`
        }
      />
      <StatusRow label={t`Model`} value={profile.model || t`Not set`} />
      <StatusRow label={t`Effort`} value={profile.effort_level || t`Not set`} />
      <StatusRow
        label={t`Auto compact`}
        value={profile.auto_compact_window || t`Not set`}
      />
      <StatusRow
        label={t`Max context`}
        value={profile.max_context_tokens || t`Not set`}
      />
      <StatusRow
        label={t`Auto mode server`}
        value={
          profile.auto_mode_server === '0'
            ? t`Off (client classifier)`
            : profile.auto_mode_server || t`Not set`
        }
      />
      {sameTier ? (
        <StatusRow label={t`All tiers`} value={tiers[0] || ''} />
      ) : (
        <>
          {profile.opus_model ? (
            <StatusRow label={t`Opus tier`} value={profile.opus_model} />
          ) : null}
          {profile.sonnet_model ? (
            <StatusRow label={t`Sonnet tier`} value={profile.sonnet_model} />
          ) : null}
          {profile.haiku_model ? (
            <StatusRow label={t`Haiku tier`} value={profile.haiku_model} />
          ) : null}
          {profile.fable_model ? (
            <StatusRow label={t`Fable tier`} value={profile.fable_model} />
          ) : null}
          {profile.subagent_model ? (
            <StatusRow label={t`Sub-agent`} value={profile.subagent_model} />
          ) : null}
        </>
      )}
    </div>
  )
}

function KimiSettings({ profile }: { profile: AgentProfile }) {
  const { t } = useLingui()
  const [token, setToken] = useState('')
  const [model, setModel] = useState(profile.model || 'k3.1-pro')
  const { saving, message, save } = useSaveState()
  return (
    <div className="grid max-w-lg gap-6">
      <KimiStatus profile={profile} />
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save('agent.profile.configure', { token, model }).then((ok) => {
            if (ok) setToken('')
          })
        }}
      >
        <label className="grid gap-1 text-caption text-brand-muted">
          {profile.configured ? t`Replace API key` : t`Kimi API key`}
          <Input
            variant="field"
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required={!profile.configured}
            minLength={8}
            placeholder={
              profile.configured ? t`Leave blank to keep current key` : ''
            }
          />
        </label>
        <label className="grid gap-1 text-caption text-brand-muted">
          {t`Model ID`}
          <Input
            variant="field"
            value={model}
            placeholder="k3.1-pro"
            onChange={(event) => setModel(event.target.value)}
            required
          />
        </label>
        <p className="text-meta text-brand-label">
          {t`Saving writes api.kimi.ai/coding/, ANTHROPIC_API_KEY, all Claude tiers, effort=high, and compact/max-context (262144 or 1048576 for [1m]). Restart the Kimi pane for /status to refresh.`}
        </p>
        {message ? (
          <p role="status" className="text-meta text-brand-muted">
            {message}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={
            saving ||
            (!profile.configured && token.trim().length < 8) ||
            !model.trim()
          }
          className="min-h-11 justify-self-start px-4"
        >
          {saving ? t`Saving…` : t`Save`}
        </Button>
      </form>
    </div>
  )
}

function ModelSettings({ profile }: { profile: AgentProfile }) {
  const { t } = useLingui()
  const currentModel = profile.model_override || profile.default_model || ''
  const [model, setModel] = useState(currentModel)
  const { saving, message, save } = useSaveState()
  return (
    <form
      className="grid max-w-lg gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save('agent.profile.model', { profile: profile.id, model }).then(
          (ok) => {
            if (ok && !model.trim()) setModel(profile.default_model || '')
          },
        )
      }}
    >
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Model ID`}
        <Input
          variant="field"
          value={model}
          placeholder={t`Use CLI default`}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <p className="text-meta text-brand-label">
        {profile.model_override
          ? t`Managed override`
          : profile.default_model
            ? t`CLI default`
            : t`CLI selects automatically`}
      </p>
      {profile.id === 'claude_sub2api' ? (
        <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 border-b border-brand-edge text-caption">
          <span className="text-brand-muted">{t`Current API key`}</span>
          <code className="min-w-0 break-all text-right font-mono text-brand-text">
            {profile.masked_key || t`Not configured`}
          </code>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-meta text-brand-muted">
          {message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={saving || model === currentModel}
          className="min-h-11 px-4"
        >
          {saving ? t`Saving…` : t`Save`}
        </Button>
        {profile.model_override ? (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            className="min-h-11 px-4"
            onClick={() => {
              void save('agent.profile.model', {
                profile: profile.id,
                model: '',
              }).then((ok) => {
                if (ok) setModel(profile.default_model || '')
              })
            }}
          >
            {t`Use CLI default`}
          </Button>
        ) : null}
      </div>
    </form>
  )
}

export function AgentDetail({ profile }: { profile: AgentProfile }) {
  const { t } = useLingui()
  return (
    <section className="min-h-[24rem] min-w-0 pb-6" data-testid="agent-detail">
      <div className="mb-5 flex min-h-14 min-w-0 items-center justify-between gap-3 border-b border-brand-edge pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar profile={profile.id} size={44} />
          <div className="min-w-0">
            <h2 className="truncate text-body font-semibold text-brand-text">
              {profile.label}
            </h2>
            <p className="truncate font-mono text-meta text-brand-label">
              {profile.id}
            </p>
          </div>
        </div>
        {profile.id === 'claude_kimi' ? (
          <span className="shrink-0 text-meta text-brand-muted">
            {profile.configured ? t`Configured` : t`Not configured`}
          </span>
        ) : null}
      </div>
      {profile.id === 'claude_kimi' ? (
        <KimiSettings profile={profile} />
      ) : ['claude', 'claude_sub2api', 'codex', 'grok'].includes(profile.id) ? (
        <ModelSettings profile={profile} />
      ) : (
        <p className="text-caption text-brand-muted">{t`Managed in host configuration`}</p>
      )}
    </section>
  )
}
