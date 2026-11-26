import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { hostWrite } from '#/lib/runtime-client'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'

export function AgentsPage() {
  const { t } = useLingui()
  const client = useQueryClient()
  const profiles = useAgentProfiles()
  const [preferred, setPreferred] = usePreferredAgentProfile()
  const [token, setToken] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const kimi = profiles.data?.profiles.find(
    (profile) => profile.id === 'claude_kimi',
  )
  useEffect(() => {
    if (kimi?.model) setModel((current) => current || kimi.model || '')
  }, [kimi?.model])

  const saveKimi = async () => {
    setSaving(true)
    setMessage('')
    try {
      await hostWrite('agent.profile.configure', { token, model })
      setToken('')
      setMessage(t`Saved`)
      await client.invalidateQueries({ queryKey: ['remote', 'agent.profiles'] })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (profiles.isLoading)
    return <p className="text-caption text-brand-muted">{t`Loading…`}</p>
  if (profiles.isError)
    return (
      <p
        role="alert"
        className="text-caption text-brand-error"
      >{t`Could not read agent profiles.`}</p>
    )

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h2 className="text-caption font-semibold">{t`Default agent for new sessions in this browser`}</h2>
        <div
          role="radiogroup"
          aria-label={t`Default agent`}
          className="grid gap-1"
        >
          <Button
            type="button"
            variant="plain"
            size="none"
            role="radio"
            aria-checked={!preferred}
            onClick={() => setPreferred('')}
            className="min-h-11 border-b border-brand-edge py-2 text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
          >
            {t`Repository default`}
          </Button>
          {(profiles.data?.profiles ?? []).map((profile) => (
            <Button
              key={profile.id}
              type="button"
              variant="plain"
              size="none"
              role="radio"
              aria-checked={preferred === profile.id}
              onClick={() => setPreferred(profile.id)}
              className="flex min-h-11 items-center justify-between gap-3 border-b border-brand-edge py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running last:border-b-0"
            >
              <span className="min-w-0 text-body">{profile.label}</span>
              <span className="shrink-0 font-mono text-meta text-brand-label">
                {profile.id}
                {profile.default ? ` · ${t`host default`}` : ''}
              </span>
            </Button>
          ))}
        </div>
      </section>
      {kimi ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void saveKimi()
          }}
        >
          <div className="flex items-center justify-between gap-3 border-b border-brand-edge pb-2">
            <h2 className="text-body font-semibold">Claude · Kimi</h2>
            <span className="text-meta text-brand-label">
              {kimi.configured ? t`Configured` : t`Not configured`}
            </span>
          </div>
          <label className="grid gap-1 text-caption text-brand-muted">
            {t`Kimi API key`}
            <Input
              variant="field"
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required={!kimi.configured}
              minLength={8}
              placeholder={
                kimi.configured ? t`Leave blank to keep current key` : ''
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
              (!kimi.configured && token.trim().length < 8) ||
              !model.trim()
            }
            className="min-h-11 justify-self-start px-4"
          >
            {saving ? t`Saving…` : t`Save`}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
