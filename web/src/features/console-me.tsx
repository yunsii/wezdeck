// 我的: an index of groups — connection, write access, usage, appearance,
// app — each row showing how it stands now, each group its own pushed page
// (/console/me/$page, back returns to the index; the tab bar stays, like a
// settings tab). On the host, links to the local-only console sections.
import { useLingui } from '@lingui/react/macro'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Field, FieldList } from '#/components/ui/field'
import { rememberLocale } from '#/lib/locale-pref'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { useIsWide, useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
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
import { HostPage, useHostSummary } from './me-host'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-baseline justify-between gap-3 py-2 text-sm">
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
  const [checking, setChecking] = useState(false)
  const check = () => {
    setChecking(true)
    void checkForUpdate()
      .then((r) =>
        setResult(
          r === 'new'
            ? t`New version ready, reload to use it`
            : r === 'offline'
              ? t`Offline, try again later`
              : t`Already the latest`,
        ),
      )
      .finally(() => setChecking(false))
  }
  // one settings row: 版本 on the left, the build and a quiet text action on
  // the right — not a big outlined button
  return (
    <div className="grid gap-1">
      <div className="flex min-h-9 items-baseline justify-between gap-3 py-2 text-sm">
        <span className="shrink-0 whitespace-nowrap text-brand-label">
          {t`Version`}
        </span>
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 truncate font-mono text-xs">{buildId}</span>
          <Button
            variant="plain"
            type="button"
            disabled={checking}
            onClick={check}
            className="shrink-0 text-sm text-brand-running disabled:opacity-50"
          >
            {checking ? t`Checking…` : t`Check for updates`}
          </Button>
        </span>
      </div>
      {result ? (
        <p role="status" className="text-right text-xs text-brand-muted">
          {result}
        </p>
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
  if (device.state === 'approved' && device.id === 'local')
    return (
      <p className="text-sm">
        {t`Enabled on this computer: writes go through the local Runtime, with no device key to create or approve. Phones, tablets and other computers are enabled on their own.`}
      </p>
    )
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
  'host',
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
    host: t`This computer`,
  }
}

function ConnectionPage() {
  const { t } = useLingui()
  const consoleMode = useConsoleMode()
  const remote = useRemoteState()
  const since = remote.hostSince
    ? new Date(remote.hostSince).toLocaleString()
    : '—'
  if (consoleMode === 'local' && remote.mode === 'unpaired')
    return (
      <div className="grid gap-4">
        <Row label={t`Mode`} value={t`This computer (local Runtime)`} />
        <p className="text-sm text-brand-muted">
          {t`This computer reads and writes sessions and tickets through the local Runtime directly; there is nothing to pair here.`}
        </p>
        <section className="grid gap-1.5">
          <h2 className="text-[13px] font-semibold text-brand-muted">
            {t`Phone or tablet`}
          </h2>
          <p className="text-[13px] text-brand-muted">
            {t`Run this on the host, then open the link it prints on that device:`}
          </p>
          <FieldList>
            <Field
              label={t`Pairing command`}
              value="scripts/dev/install-remote-relay.sh --pair"
              mono
            />
          </FieldList>
        </section>
      </div>
    )
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
  active,
}: {
  page: MePage
  title: string
  value?: React.ReactNode
  /** the group shown beside the list (wide screens) */
  active?: boolean
}) {
  const { locale } = useLocale()
  const wide = useIsWide()
  return (
    <li className="border-b border-brand-edge last:border-b-0">
      <Link
        to="/{-$locale}/console/me/$page"
        params={{ locale: locale === 'en' ? undefined : locale, page }}
        // beside the list a group is a tab, not a page: no history pile-up
        replace={wide}
        aria-current={active ? 'page' : undefined}
        data-me={page}
        className={cn(
          'key-press flex min-h-13 items-center gap-3 px-4 py-2.5',
          active && 'bg-brand-soft',
        )}
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

function MeIndex({ active }: { active?: MePage }) {
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
      ? device.id === 'local'
        ? t`Enabled on this computer`
        : t`Enabled`
      : device.state === 'pending'
        ? t`Waiting for the host`
        : device.state === 'none'
          ? t`Off`
          : ''
  const hostSummary = useHostSummary()
  const theme =
    mode === 'light' ? t`Light` : mode === 'dark' ? t`Dark` : t`System`
  const group = 'overflow-hidden rounded-[16px] bg-brand-surface'
  return (
    <div className="grid max-w-2xl content-start gap-4">
      <h1 className="hidden text-base font-semibold md:block">{t`Settings`}</h1>
      <ul className={group}>
        <EntryRow
          page="connection"
          active={active === 'connection'}
          title={titles.connection}
          value={
            // on this computer pairing is beside the point: no "not paired"
            consoleMode === 'local' ? (
              t`This computer`
            ) : remote.mode === 'unpaired' ? (
              t`Not paired`
            ) : (
              <RemoteBadge compact />
            )
          }
        />
        <EntryRow
          page="writing"
          active={active === 'writing'}
          title={titles.writing}
          value={writing}
        />
        {remote.mode === 'unpaired' ? null : (
          <EntryRow
            page="usage"
            active={active === 'usage'}
            title={titles.usage}
          />
        )}
      </ul>
      <ul className={group}>
        <EntryRow
          page="appearance"
          active={active === 'appearance'}
          title={titles.appearance}
          value={`${locale === 'zh' ? '中文' : 'English'}, ${theme}`}
        />
        {/* the commit only; the full build id is on the page */}
        <EntryRow
          page="app"
          active={active === 'app'}
          title={titles.app}
          value={buildId.split('-')[0]}
        />
        {/* sample data only: useful on any device */}
        <li className="border-b border-brand-edge last:border-b-0">
          <Link
            to="/{-$locale}/console/interactions"
            params={{ locale: localeParam }}
            className="key-press flex min-h-13 items-center justify-between px-4 text-[16px]"
          >
            {t`Interaction debugging`}
            <ChevronRight size={18} aria-hidden className="text-brand-label" />
          </Link>
        </li>
      </ul>
      {consoleMode === 'local' ? (
        <ul className={group}>
          <EntryRow
            page="host"
            active={active === 'host'}
            title={titles.host}
            value={hostSummary}
          />
          <li className="border-b border-brand-edge last:border-b-0">
            <Link
              to="/{-$locale}/console/diagnostics"
              params={{ locale: localeParam }}
              className="key-press flex min-h-13 items-center justify-between px-4 text-[16px]"
            >
              {t`Diagnostics`}
              <ChevronRight
                size={18}
                aria-hidden
                className="text-brand-label"
              />
            </Link>
          </li>
        </ul>
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
    host: <HostPage />,
  }[page]
  return (
    <div className="grid max-w-2xl content-start gap-3" data-me-page={page}>
      <div className="-ml-2 flex items-center gap-1 pt-1 md:ml-0 md:min-h-11">
        <Button
          variant="plain"
          type="button"
          onClick={back}
          aria-label={t`Back`}
          // beside the list on a wide screen there is nothing to go back to
          className="inline-flex size-11 shrink-0 items-center justify-center text-brand-muted md:hidden"
        >
          <ChevronLeft size={22} aria-hidden />
        </Button>
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
  const wide = useIsWidePhoneFirst()
  // a desk-sized window: the groups on the left, the chosen one beside them
  if (wide)
    return (
      <div className="grid max-w-5xl grid-cols-[minmax(240px,300px)_minmax(0,1fr)] items-start gap-6">
        <div className="vt-split-list">
          <MeIndex active={known ?? 'connection'} />
        </div>
        <div className="vt-split-pane min-w-0">
          <MeSubPage page={known ?? 'connection'} />
        </div>
      </div>
    )
  return known ? <MeSubPage page={known} /> : <MeIndex />
}
