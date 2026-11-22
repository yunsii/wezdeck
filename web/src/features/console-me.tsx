// 我的: connection, install, version, appearance, and (on the host) links to
// the local-only console sections.
import { useLingui } from '@lingui/react/macro'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { rememberLocale } from '#/lib/locale-pref'
import { useLocale } from '#/lib/locale-context'
import {
  buildId,
  checkForUpdate,
  promptInstall,
  useInstallState,
} from '#/lib/pwa'
import { useTheme } from '#/lib/theme-provider'
import { useConsoleMode, useRemoteState } from './console-mode'
import { Segmented } from '#/components/deck/segmented'
import { useDeviceState } from './device-state'
import { RemoteBadge } from './remote-badge'
import { UsageCard } from './console-usage'

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="key grid gap-3 rounded-[16px] p-4">
      <h2 className="text-[15px] font-semibold">{title}</h2>
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

function PhoneWriting() {
  const { t } = useLingui()
  const device = useDeviceState()
  const command = `scripts/dev/install-remote-relay.sh --approve ${device.id ?? ''}`
  if (device.state === 'checking')
    return <p className="text-sm text-brand-muted">{t`Checking…`}</p>
  if (device.state === 'approved')
    return (
      <p className="text-sm">
        {t`Enabled. This phone can send messages to sessions and reply to tickets.`}
        <span className="mt-1 block font-mono text-xs text-brand-label">
          {device.id}
        </span>
      </p>
    )
  if (device.state === 'none')
    return (
      <div className="grid gap-2">
        <p className="text-sm text-brand-muted">
          {t`Lets this phone send messages to agent sessions and reply to tickets. A key is created on this phone and stays here; the host approves it once.`}
        </p>
        <Button className="min-h-11" onClick={() => void device.enable()}>
          {t`Enable writing`}
        </Button>
        {device.error ? (
          <p role="alert" className="text-xs text-brand-error">
            {device.error}
          </p>
        ) : null}
      </div>
    )
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        {t`Waiting for the host to approve this phone. On the host run:`}
      </p>
      <code className="block rounded-[10px] bg-brand-deck px-3 py-2 font-mono text-xs break-all select-all">
        {command}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() =>
            void navigator.clipboard.writeText(command).catch(() => undefined)
          }
        >
          {t`Copy command`}
        </Button>
        <Button className="min-h-11" onClick={() => void device.refresh()}>
          {t`Check again`}
        </Button>
      </div>
      {device.error ? (
        <p role="alert" className="text-xs text-brand-error">
          {device.error}
        </p>
      ) : null}
    </div>
  )
}

export function ConsoleMePage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const consoleMode = useConsoleMode()
  const remote = useRemoteState()
  const localeParam = locale === 'en' ? undefined : locale
  const since = remote.hostSince
    ? new Date(remote.hostSince).toLocaleString()
    : '—'
  return (
    <div className="grid max-w-2xl content-start gap-4">
      <h1 className="hidden text-base font-semibold md:block">{t`Settings`}</h1>
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
      <Section title={t`Phone writing`}>
        <PhoneWriting />
      </Section>
      {remote.mode === 'unpaired' ? null : (
        <Section title={t`Usage`}>
          <UsageCard />
        </Section>
      )}
      <Section title={t`Appearance`}>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <span className="text-sm text-brand-muted">{t`Language`}</span>
            <Segmented
              label={t`Language`}
              value={locale === 'zh' ? 'zh' : 'en'}
              onChange={(next) => {
                rememberLocale(next)
                void navigate({
                  to: '.',
                  replace: true,
                  params: {
                    ...params,
                    locale: next === 'en' ? undefined : next,
                  },
                })
              }}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm text-brand-muted">{t`Theme`}</span>
            <Segmented
              label={t`Theme`}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'system', label: t`System` },
                { value: 'light', label: t`Light` },
                { value: 'dark', label: t`Dark` },
              ]}
            />
          </div>
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
