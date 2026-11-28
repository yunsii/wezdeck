// 我的: an index of groups (connection, write access, usage, appearance, app),
// each row showing how it stands, each group a pushed page (/console/me/$page;
// back returns to the index, the tab bar stays). On the host, local links too.
import { useLingui } from '@lingui/react/macro'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Activity, ChevronRight, Network } from 'lucide-react'
import { BackButton } from '#/components/deck/back-button'
import { SplitColumn } from '#/components/deck/split-column'
import { StickyBar } from '#/components/deck/sticky-bar'

import { Field, FieldList } from '#/components/ui/field'
import { rememberLocale } from '#/lib/locale-pref'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { buildId } from '#/lib/pwa'
import { useTheme } from '#/lib/theme-provider'
import { useCaretShape } from '#/lib/caret-pref'
import { useEnterMode } from '#/lib/enter-pref'
import { useConsoleMode, useRemoteState } from './console-mode'
import { Segmented } from '#/components/deck/segmented'
import { useDeviceState } from './device-state'
import { DeviceAccess } from './me-device-access'
import { RemoteBadge } from './remote-badge'
import { UsageCard } from './console-usage'
import { HostPage, useHostSummary } from './me-host'
import { InstallEntry, Row, UpdateCheck } from './me-app'
import { InteractionsPage, useInteractionsBack } from './console-interactions'
import { usePreferredAgentProfile } from './agent-profiles'
import { AgentsPage } from './me-agents'
import { RepositoriesPage } from './me-repositories'
import { AutoTitlePage, useAutoTitleSummary } from './me-autotitle'
import { HabitsPage } from './me-habits'
import { SchedulePage } from './me-schedule'
import { EntryRow } from './me-entry-row'
import { NotificationsPage, useNotificationsSummary } from './me-notifications'

/** 我的 › …: one page per group, pushed from the index */
export const ME_PAGES = [
  'connection',
  'writing',
  'notifications',
  'usage',
  'appearance',
  'app',
  'host',
  'interactions',
  'agents',
  'repositories',
  'autotitle',
  'habits',
  'schedule',
] as const
export type MePage = (typeof ME_PAGES)[number]

function useMeTitles(): Record<MePage, string> {
  const { t } = useLingui()
  return {
    connection: t`Connection`,
    writing: t`Device access`,
    notifications: t`Notifications`,
    usage: t`Usage`,
    appearance: t`Appearance`,
    app: t`App`,
    host: t`This computer`,
    interactions: t`Interaction debugging`,
    agents: t`Agents`,
    repositories: t`Repositories`,
    autotitle: t`Auto titles`,
    habits: t`Development habits`,
    schedule: t`Scheduled tasks`,
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
  const [enterMode, setEnterMode] = useEnterMode()
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
      <div className="grid gap-1.5">
        <span className="text-caption text-brand-muted">{t`Enter key`}</span>
        <Segmented
          label={t`Enter key`}
          value={enterMode}
          onChange={setEnterMode}
          options={[
            { value: 'auto', label: t`Auto` },
            { value: 'newline', label: t`Newline` },
            { value: 'send', label: t`Send` },
          ]}
        />
        <span className="text-meta text-brand-label">
          {t`Auto sends on desktop and tablet keyboards, and breaks lines on phones. Shift+Enter always breaks lines; Ctrl/⌘+Enter always sends.`}
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
  const autoTitleSummary = useAutoTitleSummary()
  const notificationsSummary = useNotificationsSummary()
  const theme =
    mode === 'light' ? t`Light` : mode === 'dark' ? t`Dark` : t`System`
  const group = 'me-list border-b border-brand-edge bg-brand-surface'
  return (
    <div className="grid content-start gap-2.5 bg-brand-deck pb-4 md:pb-0">
      <ul className={group}>
        <EntryRow
          page="agents"
          active={active === 'agents'}
          title={titles.agents}
          value={preferredAgent || t`Repository default`}
        />
        <EntryRow
          page="repositories"
          active={active === 'repositories'}
          title={titles.repositories}
          value={t`Agent defaults`}
        />
        {authorized ? (
          <EntryRow
            page="autotitle"
            active={active === 'autotitle'}
            title={titles.autotitle}
            value={autoTitleSummary}
          />
        ) : null}
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
        <EntryRow
          page="notifications"
          active={active === 'notifications'}
          title={titles.notifications}
          value={notificationsSummary}
        />
        {remote.mode === 'unpaired' || device.state !== 'approved' ? null : (
          <EntryRow
            page="usage"
            active={active === 'usage'}
            title={titles.usage}
          />
        )}
        {authorized ? (
          <EntryRow
            page="habits"
            active={active === 'habits'}
            title={titles.habits}
          />
        ) : null}
        {authorized ? (
          <EntryRow
            page="schedule"
            active={active === 'schedule'}
            title={titles.schedule}
          />
        ) : null}
      </ul>
      <ul className={cn(group, 'border-t border-brand-edge')}>
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
        <li>
          <Link
            to="/{-$locale}/architecture"
            params={{ locale: localeParam }}
            data-me="architecture"
            className="list-row flex min-h-13 items-center gap-3 px-4 py-2.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset md:px-3"
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
        <ul className={cn(group, 'border-t border-brand-edge')}>
          <EntryRow
            page="host"
            active={active === 'host'}
            title={titles.host}
            value={consoleMode === 'local' ? hostSummary : undefined}
          />
          {consoleMode === 'local' ? (
            <li>
              <Link
                to="/{-$locale}/console/diagnostics"
                params={{ locale: localeParam }}
                data-me="diagnostics"
                className="list-row flex min-h-13 items-center gap-3 px-4 py-2.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset md:px-3"
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
    notifications: <NotificationsPage />,
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
    repositories: <RepositoriesPage />,
    autotitle: <AutoTitlePage />,
    habits: <HabitsPage />,
    schedule: <SchedulePage />,
  }[page]
  return (
    <div
      // 交互调试 lays out a list beside its detail: give it the room
      className={cn(
        'grid min-w-0 grid-cols-1 content-start gap-3',
        page === 'interactions' || page === 'agents' || page === 'habits'
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
      {/* Sectioned pages (交互调试, Agents, 本机, 自动标题) bring their own
          surface cards on bg-brand-deck — no redundant outer surface card */}
      {page === 'interactions' ||
      page === 'agents' ||
      page === 'host' ||
      page === 'autotitle' ||
      page === 'habits' ||
      page === 'schedule' ||
      page === 'notifications' ? (
        body
      ) : (
        <section className="grid min-w-0 grid-cols-1 gap-3 rounded-2xl bg-brand-surface p-4 md:rounded-none md:bg-transparent md:p-0">
          {body}
        </section>
      )}
    </div>
  )
}

export function ConsoleMePage() {
  const { t } = useLingui()
  const { page } = useParams({ strict: false })
  const known = ME_PAGES.find((name) => name === page)
  const wide = useIsWidePhoneFirst()
  // a desk-sized window: the groups on the left in a SplitColumn, the chosen one beside them
  if (wide)
    return (
      // independent scroll panes: divider runs the full window height
      <div className="grid h-[100cqh] grid-cols-[minmax(260px,320px)_minmax(0,1fr)] items-stretch overflow-hidden">
        <SplitColumn
          label={t`Settings`}
          className="bg-brand-deck [--split-pad:0.75rem]"
          head={
            <div className="flex min-h-9 items-center">
              <h1 className="text-body font-semibold">{t`Settings`}</h1>
            </div>
          }
        >
          <MeIndex active={known ?? 'connection'} />
        </SplitColumn>
        <div
          data-testid="me-pane"
          className={cn(
            'vt-split-pane h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain border-l border-brand-edge',
            known === 'interactions' || known === 'agents'
              ? 'py-[var(--page-x)] pr-[var(--page-x)]'
              : 'p-[var(--page-x)] md:px-6 md:py-5',
          )}
        >
          <MeSubPage page={known ?? 'connection'} />
        </div>
      </div>
    )
  if (known) return <MeSubPage page={known} />
  return (
    <div className="flex min-h-full w-full flex-1 flex-col bg-brand-deck">
      <StickyBar className="top-0 mx-0 my-0 border-b border-brand-edge bg-brand-surface/95 px-4 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2.5">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h1 className="truncate text-title font-semibold">{t`Settings`}</h1>
        </div>
      </StickyBar>
      <MeIndex />
    </div>
  )
}
