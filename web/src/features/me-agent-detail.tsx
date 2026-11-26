import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { hostWrite } from '#/lib/runtime-client'
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

function KimiSettings({ profile }: { profile: AgentProfile }) {
  const { t } = useLingui()
  const [token, setToken] = useState('')
  const [model, setModel] = useState(profile.model || '')
  const { saving, message, save } = useSaveState()
  return (
    <form
      className="grid max-w-lg gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save('agent.profile.configure', { token, model }).then((ok) => {
          if (ok) setToken('')
        })
      }}
    >
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Kimi API key`}
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
          placeholder="kimi-k3[1m]"
          onChange={(event) => setModel(event.target.value)}
          required
        />
      </label>
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
  )
}

function ModelSettings({ profile }: { profile: AgentProfile }) {
  const { t } = useLingui()
  const [model, setModel] = useState(profile.model_override || '')
  const { saving, message, save } = useSaveState()
  return (
    <form
      className="grid max-w-lg gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save('agent.profile.model', { profile: profile.id, model })
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
      {message ? (
        <p role="status" className="text-meta text-brand-muted">
          {message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={saving || model === (profile.model_override || '')}
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
                if (ok) setModel('')
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
        <div className="min-w-0">
          <h2 className="truncate text-body font-semibold text-brand-text">
            {profile.label}
          </h2>
          <p className="truncate font-mono text-meta text-brand-label">
            {profile.id}
          </p>
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
