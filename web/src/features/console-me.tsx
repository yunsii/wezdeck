// 我的: an index of groups (connection, write access, usage, appearance, app),
// each row showing how it stands, each group a pushed page (/console/me/$page;
// back returns to the index, the tab bar stays). On the host, local links too.
import { useLingui } from '@lingui/react/macro'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Activity, ChevronRight, Network } from 'lucide-react'
import { BackButton } from '#/components/deck/back-button'

import { Button } from '#/components/ui/button'
import { Field, FieldList } from '#/components/ui/field'
import { rememberLocale } from '#/lib/locale-pref'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { buildId } from '#/lib/pwa'
import { useTheme } from '#/lib/theme-provider'
import { useCaretShape } from '#/lib/caret-pref'
import { useConsoleMode, useRemoteState } from './console-mode'
import { Segmented } from '#/components/deck/segmented'
import { useDeviceState } from './device-state'
import { DeviceList } from './me-devices'
import { RemoteBadge } from './remote-badge'
import { UsageCard } from './console-usage'
import { HostPage, useHostSummary } from './me-host'
import { InstallEntry, Row, UpdateCheck } from './me-app'
import { InteractionsPage, useInteractionsBack } from './console-interactions'
import { usePreferredAgentProfile } from './agent-profiles'
import { AgentsPage } from './me-agents'
import { EntryRow } from './me-entry-row'

function DeviceAccess() {
  const { t } = useLingui()
  const device = useDeviceState()
  const command = `scripts/dev/install-remote-relay.sh --approve ${device.id ?? ''}`
  if (device.state === 'checking')
    return <p className="text-caption text-brand-muted">{t`Checking…`}</p>
  if (device.state === 'approved' && device.id === 'local')
    return (
      <div className="grid gap-4">
        <p className="text-body">
          {t`Enabled on this computer: writes go through the local Runtime, with no device key to create or approve. Phones, tablets and other computers are enabled on their own.`}
        </p>
        <DeviceList />
      </div>
    )
  if (device.state === 'approved')
    return (
      <p className="text-body">
        {t`Approved. This device can read the host's sessions and tickets, send messages and reply. Each device (phone, tablet, another browser) is approved on its own, and revoking it on the host cuts reading and writing at once.`}
        <span className="mt-1 block font-mono text-meta text-brand-label">
          {device.id}
        </span>
      </p>
    )
  if (device.state === 'none')
    return (
      <div className="grid gap-2">
        <p className="text-caption text-brand-muted">
          {t`This device sees nothing from the host until it is approved — the pairing link alone is not enough. A key is created in this browser and stays here; the host approves each device once, for reading and writing.`}
        </p>
        <Button className="min-h-11" onClick={() => void device.enable()}>
          {t`Request access`}
        </Button>
        {device.error ? (
          <p role="alert" className="text-meta text-brand-error">
            {device.error}
          </p>
        ) : null}
      </div>
    )
  return (
    <div className="grid gap-2">
      <p className="text-body">
        {t`Waiting for the host to approve this device. On the host run:`}
      </p>
      <code className="block rounded-xl bg-brand-deck px-3 py-2 font-mono text-meta break-all select-all">
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
        <p role="alert" className="text-meta text-brand-error">
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
  'interactions',
  'agents',
] as const
export type MePage = (typeof ME_PAGES)[number]

function useMeTitles(): Record<MePage, string> {
  const { t } = useLingui()
  return {
    connection: t`Connection`,
    writing: t`Device access`,
    usage: t`Usage`,
    appearance: t`Appearance`,
    app: t`App`,
    host: t`This computer`,
    interactions: t`Interaction debugging`,
    agents: t`Agents`,
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
        <p className="text-caption text-brand-muted">
          {t`This computer reads and writes sessions and tickets through the local Runtime directly; there is nothing to pair here.`}
        </p>
        <section className="grid gap-1.5">
          <h2 className="text-caption font-semibold text-brand-muted">
            {t`Phone or tablet`}
          </h2>
          <p className="text-caption text-brand-muted">
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
      <p className="text-caption text-brand-muted">
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
        <p className="text-meta text-brand-muted">
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
  const [caret, setCaret] = useCaretShape()
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <span className="text-caption text-brand-muted">{t`Language`}</span>
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
        <span className="text-caption text-brand-muted">{t`Theme`}</span>
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
      <div className="grid gap-1.5">
        <span className="text-caption text-brand-muted">{t`Text caret`}</span>
        <Segmented
          label={t`Text caret`}
          value={caret}
          onChange={setCaret}
          options={[
            { value: 'bar', label: t`Bar` },
            { value: 'block', label: t`Block` },
            { value: 'underscore', label: t`Underscore` },
          ]}
        />
        <span className="text-meta text-brand-label">
          {t`Block and underscore need Chrome 144 or later; other browsers keep the bar.`}
        </span>
      </div>
    </div>
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
  const [preferredAgent] = usePreferredAgentProfile()
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
  const authorized = consoleMode === 'local' || device.state === 'approved'
  const hostSummary = useHostSummary()
  const theme =
    mode === 'light' ? t`Light` : mode === 'dark' ? t`Dark` : t`System`
  const group = 'overflow-hidden rounded-2xl bg-brand-surface md:rounded-none'
  return (
    <div className="grid max-w-2xl content-start gap-4 md:max-w-none md:gap-0">
      <h1 className="hidden text-body font-semibold md:block md:border-b md:border-brand-edge md:px-[var(--page-x)] md:py-3">
        {t`Settings`}
      </h1>
      <ul className={group}>
        <EntryRow
          page="agents"
          active={active === 'agents'}
          title={titles.agents}
          value={preferredAgent || t`Repository default`}
        />
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
        {remote.mode === 'unpaired' || device.state !== 'approved' ? null : (
          <EntryRow
            page="usage"
            active={active === 'usage'}
            title={titles.usage}
          />
        )}
      </ul>
      <ul className={cn(group, 'md:mt-3')}>
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
        <EntryRow
          page="interactions"
          active={active === 'interactions'}
          title={titles.interactions}
        />
        {/* how it all works, device access included: the public page,
            with a ‹ back here */}
        <li className="border-b border-brand-edge last:border-b-0">
          <Link
            to="/{-$locale}/architecture"
            params={{ locale: localeParam }}
            data-me="architecture"
            className="key-press flex min-h-13 items-center gap-3 px-4 text-body"
          >
            <Network
              size={18}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
            <span className="min-w-0 flex-1 truncate">{t`How it fits together`}</span>
            <ChevronRight
              size={18}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
          </Link>
        </li>
      </ul>
      {authorized ? (
        <ul className={cn(group, 'md:mt-3')}>
          <EntryRow
            page="host"
            active={active === 'host'}
            title={titles.host}
            value={consoleMode === 'local' ? hostSummary : undefined}
          />
          {consoleMode === 'local' ? (
            <li className="border-b border-brand-edge last:border-b-0">
              <Link
                to="/{-$locale}/console/diagnostics"
                params={{ locale: localeParam }}
                data-me="diagnostics"
                className="key-press flex min-h-13 items-center gap-3 px-4 text-body"
              >
                <Activity
                  size={18}
                  aria-hidden
                  className="shrink-0 text-brand-label"
                />
                <span className="min-w-0 flex-1 truncate">{t`Diagnostics`}</span>
                <ChevronRight
                  size={18}
                  aria-hidden
                  className="shrink-0 text-brand-label"
                />
              </Link>
            </li>
          ) : null}
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
  const leave = useGoBack({
    to: '/{-$locale}/console/me',
    params: { locale: locale === 'en' ? undefined : locale },
  })
  const back = useInteractionsBack(page === 'interactions', leave)
  const body = {
    connection: <ConnectionPage />,
    writing: <DeviceAccess />,
    usage: <UsageCard />,
    appearance: <AppearancePage />,
    app: (
      <>
        <InstallEntry />
        <UpdateCheck />
      </>
    ),
    host: <HostPage />,
    interactions: <InteractionsPage />,
    agents: <AgentsPage />,
  }[page]
  return (
    <div
      // 交互调试 lays out a list beside its detail: give it the room
      className={cn(
        'grid content-start gap-3',
        page === 'interactions' || page === 'agents'
          ? 'max-w-none'
          : 'max-w-2xl',
      )}
      data-me-page={page}
    >
      <div
        className={cn(
          '-ml-2 flex items-center gap-1 pt-1 md:ml-0 md:min-h-11',
          (page === 'interactions' || page === 'agents') &&
            'md:px-[var(--page-x)]',
        )}
      >
        {/* beside the list on a wide screen there is nothing to go back to */}
        <BackButton
          onClick={back}
          label={t`Back`}
          className={page === 'interactions' ? 'xl:hidden' : 'md:hidden'}
        />
        <h1 className="min-w-0 flex-1 truncate text-heading font-semibold">
          {titles[page]}
        </h1>
      </div>
      {/* 交互调试 brings its own cards (the real components): no card around them */}
      {page === 'interactions' || page === 'agents' ? (
        body
      ) : (
        <section className="grid gap-3 rounded-2xl bg-brand-surface p-4 md:rounded-none md:bg-transparent md:p-0">
          {body}
        </section>
      )}
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
      // the divider runs the window's height, as beside 会话 and 工单
      <div className="grid grid-cols-[minmax(240px,300px)_minmax(0,1fr)] items-stretch">
        <div className="vt-split-list self-start">
          <MeIndex active={known ?? 'connection'} />
        </div>
        <div
          data-testid="me-pane"
          className={cn(
            'vt-split-pane min-h-[100cqh] min-w-0 border-l border-brand-edge',
            known === 'interactions' || known === 'agents'
              ? 'py-[var(--page-x)] pr-[var(--page-x)]'
              : 'p-[var(--page-x)]',
          )}
        >
          <MeSubPage page={known ?? 'connection'} />
        </div>
      </div>
    )
  return known ? <MeSubPage page={known} /> : <MeIndex />
}
