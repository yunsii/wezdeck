// A session with no conversation yet (a fresh `/new`, a Grok just started):
// say which agent is ready and where, from structured data — the session
// meta and usage the relay reads from the agent's own files (a Grok's model
// and effort come from its summary.json) — not from the pane's screen. The
// raw screen used to be the whole view: for a fullscreen TUI a status line,
// forty blank rows and an input box, which read as broken. The screen stays
// only as the fallback when not even the agent is known.
import { useLingui } from '@lingui/react/macro'

import { Field, FieldList } from '#/components/ui/field'
import type { Detail } from './console-sessions'

/** the captured screen without its blank margins (the unknown-agent fallback) */
export function compactScreen(screen: string) {
  const rows = screen.split('\n').map((row) => row.trimEnd())
  const out: Array<string> = []
  for (const row of rows) {
    if (!row && (!out.length || !out.at(-1))) continue
    out.push(row)
  }
  while (out.length && !out.at(-1)) out.pop()
  return out.join('\n')
}

/** one row of the relay's session meta (`remote_meta.go`) */
export function metaValue(data: Detail, group: string, key: string) {
  return (
    data.meta
      ?.find((g) => g.name === group)
      ?.rows.find((row) => row.key === key)?.value ?? ''
  )
}

export function EmptySession({ data }: { data: Detail }) {
  const { t } = useLingui()
  const agent = data.agent && data.agent !== 'agent' ? data.agent : ''
  const known = Boolean(agent)
  const name =
    agent === 'agy'
      ? 'Antigravity'
      : agent
        ? agent.charAt(0).toUpperCase() + agent.slice(1)
        : 'Agent'
  const model = data.usage?.model || metaValue(data, 'session', 'model')
  const effort = metaValue(data, 'session', 'effort')
  const facts: Array<[string, string, boolean]> = [
    [t`Model`, [model, effort].filter(Boolean).join(' · '), false],
    [t`Directory`, metaValue(data, 'location', 'cwd'), true],
    [t`Session`, data.id, true],
  ]
  const screen = !known && data.screen ? compactScreen(data.screen) : ''
  return (
    <div data-testid="session-empty" className="grid gap-3">
      <div className="grid gap-1 px-1">
        <p className="text-body text-brand-text">
          {t`${name} is ready, no conversation yet.`}
        </p>
        <p className="text-caption text-brand-muted">
          {t`Send the first message below.`}
        </p>
      </div>
      <FieldList>
        {facts
          .filter(([, value]) => value)
          .map(([label, value, mono]) => (
            <Field key={label} label={label} value={value} mono={mono} />
          ))}
      </FieldList>
      {screen ? (
        <pre
          aria-label={t`Terminal screen`}
          className="overflow-x-auto rounded-xl bg-brand-surface p-3 font-mono text-meta leading-snug text-brand-muted"
        >
          {screen}
        </pre>
      ) : null}
    </div>
  )
}
