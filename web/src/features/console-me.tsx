// 我的: connection, install, version, appearance, and (on the host) links to
// the local-only console sections.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import {
  buildId,
  checkForUpdate,
  promptInstall,
  useInstallState,
} from '#/lib/pwa'
import { useTheme } from '#/lib/theme-provider'
import { useConsoleMode, useRemoteState } from './console-mode'
import { LanguageSwitcher, ThemeSwitcher } from './console-shared'
import { RemoteBadge } from './remote-badge'

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-3 border border-brand-border bg-brand-surface p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 text-sm">
      <span className="text-brand-label">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs">
        {value}
      </span>
    </div>
  )
}

function InstallEntry() {
  const { t } = useLingui()
  const state = useInstallState()
  if (state === 'installed') return <Row label={t`App`} value={t`Installed`} />
  if (state === 'prompt')
    return (
      <Button onClick={() => void promptInstall()} className="min-h-11">
        {t`Install WezDeck`}
      </Button>
    )
  const hint = {
    ios: t`In Safari tap Share, then “Add to Home Screen”.`,
    'in-app': t`Open this page in the system browser first, then install it from there.`,
    unavailable: t`Use the browser menu: “Install app” / “Add to Home screen”.`,
  }[state]
  return <p className="text-sm text-brand-muted">{hint}</p>
}

function UpdateCheck() {
  const { t } = useLingui()
  const [result, setResult] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Row label={t`Version`} value={buildId} />
      <Button
        variant="outline"
        className="min-h-11"
        onClick={() =>
          void checkForUpdate().then((r) =>
            setResult(
              r === 'new'
                ? t`New version ready, reload to use it`
                : r === 'offline'
                  ? t`Offline, try again later`
                  : t`Already the latest`,
            ),
          )
        }
      >
        {t`Check for updates`}
      </Button>
      {result ? (
        <span role="status" className="text-xs text-brand-muted">
          {result}
        </span>
      ) : null}
    </div>
  )
}

export function ConsoleMePage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const consoleMode = useConsoleMode()
  const remote = useRemoteState()
  const localeParam = locale === 'en' ? undefined : locale
  const since = remote.hostSince
    ? new Date(remote.hostSince).toLocaleString()
    : '—'
  return (
    <div className="grid max-w-2xl content-start gap-4">
      <h1 className="text-base font-semibold">{t`Settings`}</h1>
      <Section title={t`Connection`}>
        {consoleMode === 'local' ? (
          <Row label={t`Mode`} value={t`This computer (local Runtime)`} />
        ) : remote.mode === 'unpaired' ? (
          <p className="text-sm text-brand-muted">
            {t`This device is not paired. On the host run scripts/dev/install-remote-relay.sh --pair and scan the code.`}
          </p>
        ) : (
          <>
            <RemoteBadge />
            <Row label={t`Host up since`} value={since} />
            <Row
              label={t`Requests (WebRTC / relay)`}
              value={`${remote.rpcCount.webrtc} / ${remote.rpcCount.websocket}`}
            />
            {remote.rtcNote ? (
              <p className="text-xs text-brand-muted">
                {t`Last direct attempt`}: {remote.rtcNote}
              </p>
            ) : null}
          </>
        )}
      </Section>
      <Section title={t`App`}>
        <InstallEntry />
        <UpdateCheck />
      </Section>
      <Section title={t`Appearance`}>
        <div className="flex items-center gap-2">
          <LanguageSwitcher locale={locale} side="bottom" />
          <ThemeSwitcher mode={mode} onChange={setMode} side="bottom" />
        </div>
      </Section>
      {consoleMode === 'local' ? (
        <Section title={t`This computer`}>
          <nav className="grid gap-1 text-sm" aria-label={t`Host sections`}>
            <Link
              to="/{-$locale}/console"
              params={{ locale: localeParam }}
              className="min-h-10 py-2 text-brand-running"
            >
              {t`Overview`}
            </Link>
            <Link
              to="/{-$locale}/console/development"
              params={{ locale: localeParam }}
              className="min-h-10 py-2 text-brand-running"
            >
              {t`Development`}
            </Link>
            <Link
              to="/{-$locale}/console/diagnostics"
              params={{ locale: localeParam }}
              className="min-h-10 py-2 text-brand-running"
            >
              {t`Diagnostics`}
            </Link>
          </nav>
        </Section>
      ) : null}
    </div>
  )
}
