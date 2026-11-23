// 我的: an index of groups — connection, write access, usage, appearance,
// app — each row showing how it stands now, each group its own pushed page
// (/console/me/$page, back returns to the index; the tab bar stays, like a
// settings tab). On the host, links to the local-only console sections.
import { useLingui } from '@lingui/react/macro'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { rememberLocale } from '#/lib/locale-pref'
import { useGoBack } from '#/lib/go-back'
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
        {t`Enabled. This device can send messages to sessions and reply to tickets. Each device (phone, tablet, another browser) is enabled on its own.`}
        <span className="mt-1 block font-mono text-xs text-brand-label">
          {device.id}
        </span>
      </p>
    )
  if (device.state === 'none')
    return (
      <div className="grid gap-2">
        <p className="text-sm text-brand-muted">
          {t`Lets this device send messages to agent sessions and reply to tickets. A key is created in this browser and stays here; the host approves each device once.`}
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
        {t`Waiting for the host to approve this device. On the host run:`}
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

/** 我的 › …: one page per group, pushed from the index */
export const ME_PAGES = [
  'connection',
  'writing',
  'usage',
  'appearance',
  'app',
] as const
export type MePage = (typeof ME_PAGES)[number]

function useMeTitles(): Record<MePage, string> {
  const { t } = useLingui()
  return {
    connection: t`Connection`,
    writing: t`Write access`,
    usage: t`Usage`,
    appearance: t`Appearance`,
    app: t`App`,
  }
}

function ConnectionPage() {
  const { t } = useLingui()
  const consoleMode = useConsoleMode()
  const remote = useRemoteState()
  const since = remote.hostSince
    ? new Date(remote.hostSince).toLocaleString()
    : '—'
  if (consoleMode === 'local')
    return <Row label={t`Mode`} value={t`This computer (local Runtime)`} />
  if (remote.mode === 'unpaired')
    return (
      <p className="text-sm text-brand-muted">
        {t`This device is not paired. On the host run scripts/dev/install-remote-relay.sh --pair and scan the code.`}
      </p>
    )
  return (
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
  )
}

function AppearancePage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  return (
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
              params: { ...params, locale: next === 'en' ? undefined : next },
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
  )
}

/** one row of the index: what it is, how it stands now, › */
function EntryRow({
  page,
  title,
  value,
}: {
  page: MePage
  title: string
  value?: React.ReactNode
}) {
  const { locale } = useLocale()
  return (
    <li className="border-b border-brand-edge last:border-b-0">
      <Link
        to="/{-$locale}/console/me/$page"
        params={{ locale: locale === 'en' ? undefined : locale, page }}
        data-me={page}
        className="key-press flex min-h-13 items-center gap-3 px-4 py-2.5"
      >
        <span className="flex-1 text-[16px]">{title}</span>
        <span className="min-w-0 truncate text-[14px] text-brand-muted">
          {value}
        </span>
        <ChevronRight
          size={18}
          aria-hidden
          className="shrink-0 text-brand-label"
        />
      </Link>
    </li>
  )
}

function MeIndex() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode } = useTheme()
  const consoleMode = useConsoleMode()
  const remote = useRemoteState()
  const device = useDeviceState()
  const titles = useMeTitles()
  const localeParam = locale === 'en' ? undefined : locale
  const writing =
    device.state === 'approved'
      ? t`Enabled`
      : device.state === 'pending'
        ? t`Waiting for the host`
        : device.state === 'none'
          ? t`Off`
          : ''
  const theme =
    mode === 'light' ? t`Light` : mode === 'dark' ? t`Dark` : t`System`
  const group = 'overflow-hidden rounded-[16px] bg-brand-surface'
  return (
    <div className="grid max-w-2xl content-start gap-4">
      <h1 className="hidden text-base font-semibold md:block">{t`Settings`}</h1>
      <ul className={group}>
        <EntryRow
          page="connection"
          title={titles.connection}
          value={
            consoleMode === 'local' ? (
              t`This computer`
            ) : remote.mode === 'unpaired' ? (
              t`Not paired`
            ) : (
              <RemoteBadge compact />
            )
          }
        />
        <EntryRow page="writing" title={titles.writing} value={writing} />
        {remote.mode === 'unpaired' ? null : (
          <EntryRow page="usage" title={titles.usage} />
        )}
      </ul>
      <ul className={group}>
        <EntryRow
          page="appearance"
          title={titles.appearance}
          value={`${locale === 'zh' ? '中文' : 'English'}, ${theme}`}
        />
        {/* the commit only; the full build id is on the page */}
        <EntryRow page="app" title={titles.app} value={buildId.split('-')[0]} />
      </ul>
      {consoleMode === 'local' ? (
        <nav className={group} aria-label={t`Host sections`}>
          {(
            [
              ['/{-$locale}/console', t`Overview`],
              ['/{-$locale}/console/development', t`Development`],
              ['/{-$locale}/console/diagnostics', t`Diagnostics`],
            ] as const
          ).map(([to, label]) => (
            <Link
              key={to}
              to={to}
              params={{ locale: localeParam }}
              className="key-press flex min-h-13 items-center justify-between border-b border-brand-edge px-4 text-[16px] last:border-b-0"
            >
              {label}
              <ChevronRight
                size={18}
                aria-hidden
                className="text-brand-label"
              />
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  )
}

/** a pushed 我的 page: its own back bar (the shell drops the big title) */
function MeSubPage({ page }: { page: MePage }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const titles = useMeTitles()
  const back = useGoBack({
    to: '/{-$locale}/console/me',
    params: { locale: locale === 'en' ? undefined : locale },
  })
  const body = {
    connection: <ConnectionPage />,
    writing: <PhoneWriting />,
    usage: <UsageCard />,
    appearance: <AppearancePage />,
    app: (
      <>
        <InstallEntry />
        <UpdateCheck />
      </>
    ),
  }[page]
  return (
    <div className="grid max-w-2xl content-start gap-3" data-me-page={page}>
      <div className="-ml-2 flex items-center gap-1 pt-1">
        <button
          type="button"
          onClick={back}
          aria-label={t`Back`}
          className="inline-flex size-11 shrink-0 items-center justify-center text-brand-muted"
        >
          <ChevronLeft size={22} aria-hidden />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[20px] font-semibold">
          {titles[page]}
        </h1>
        {/* the same link chip as every first-level page, top right */}
        <span className="md:hidden">
          <RemoteBadge compact />
        </span>
      </div>
      <section className="key grid gap-3 rounded-[16px] p-4">{body}</section>
    </div>
  )
}

export function ConsoleMePage() {
  const { page } = useParams({ strict: false })
  const known = ME_PAGES.find((name) => name === page)
  return known ? <MeSubPage page={known} /> : <MeIndex />
}
