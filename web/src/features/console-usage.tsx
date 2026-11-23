// 用量 (我的 page): today's Cloudflare usage of the phone link against the
// Workers Free limits — Worker requests, relay Durable Object requests and
// duration, WebSocket messages — plus the billing rules in plain words.
// Data: /relay/usage (relay/usage.ts), refreshed by the Worker every 5
// minutes. Over a limit, that kind of call fails until 08:00 Beijing time;
// nothing is ever billed on the Free plan.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'

import { remoteLink } from '#/lib/remote-link'
import { cn } from '#/lib/utils'
import { useAgo } from './tickets-view'
import { Disclosure } from '#/components/ui/disclosure'

const fmt = (n: number) => n.toLocaleString('zh-CN')

function Meter({
  label,
  used,
  limit,
  unit = '',
  hint,
}: {
  label: string
  used: number | null
  limit: number
  unit?: string
  hint?: string
}) {
  const share = used === null ? 0 : Math.min(100, (used / limit) * 100)
  const fill =
    share >= 90
      ? 'bg-brand-error'
      : share >= 75
        ? 'bg-brand-waiting'
        : 'bg-brand-running'
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs text-brand-muted tabular-nums">
          {used === null ? '—' : `${fmt(used)}${unit}`} / {fmt(limit)}
          {unit}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-brand-deck"
        aria-hidden
      >
        <div
          className={cn('h-full rounded-full', fill)}
          style={{ width: `${Math.max(share, used ? 1 : 0)}%` }}
        />
      </div>
      {hint ? <p className="text-[11.5px] text-brand-label">{hint}</p> : null}
    </div>
  )
}

export function UsageCard() {
  const { t } = useLingui()
  const ago = useAgo()
  const usage = useQuery({
    queryKey: ['remote', 'usage'],
    enabled: typeof window !== 'undefined' && Boolean(remoteLink.token()),
    staleTime: 60_000,
    refetchInterval: 300_000,
    queryFn: () => remoteLink.usage(),
  })
  if (usage.isPending)
    return <p className="text-sm text-brand-muted">{t`Loading…`}</p>
  if (usage.isError)
    return <p className="text-sm text-brand-error">{usage.error.message}</p>
  const u = usage.data
  const doUnit = u.durableObject
  const billableIn = doUnit.wsIn === null ? null : Math.ceil(doUnit.wsIn / 20)
  const at = ago(u.at)
  const day = u.day
  const missing = u.errors.join('; ')
  const wsIn = fmt(doUnit.wsIn ?? 0)
  const wsOut = fmt(doUnit.wsOut ?? 0)
  const billable = fmt(billableIn ?? 0)
  const other = fmt(doUnit.otherRequests ?? 0)
  const active = fmt(doUnit.activeSeconds ?? 0)
  return (
    <div className="grid gap-3">
      {u.analytics === 'unconfigured' ? (
        <p className="rounded-[12px] bg-brand-waiting/10 px-3 py-2 text-[12.5px]">
          {t`Not connected yet: the Worker needs a read-only Cloudflare analytics token (secrets CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN, permission "Account Analytics: Read").`}
        </p>
      ) : null}
      {u.errors.length ? (
        <p className="rounded-[12px] bg-brand-waiting/10 px-3 py-2 text-[12px] break-all">
          {t`Some numbers are missing: ${missing}`}
        </p>
      ) : null}
      <Meter
        label={t`Worker requests`}
        used={u.worker.requests}
        limit={u.limits.workerRequestsPerDay}
        hint={t`Pages, the relay handshake and the usage check; static files are free.`}
      />
      <Meter
        label={t`Relay requests (Durable Object)`}
        used={doUnit.requests}
        limit={u.limits.doRequestsPerDay}
        hint={
          billableIn === null
            ? undefined
            : t`Counted: ${other} calls + ${wsIn} incoming WebSocket messages ÷ 20 (≈ ${billable}); ${wsOut} outgoing messages are free.`
        }
      />
      <Meter
        label={t`Relay duration`}
        used={doUnit.durationGbs}
        limit={u.limits.doDurationGbsPerDay}
        unit=" GB-s"
        hint={
          doUnit.activeSeconds === null
            ? undefined
            : t`Active ${active} s × 128 MB; an idle relay hibernates and is not counted.`
        }
      />
      <p className="text-[11.5px] text-brand-label">
        {t`Today (UTC) ${day}, updated ${at}. Limits reset at 08:00 Beijing time; going over only fails that kind of call until then, nothing is billed.`}
      </p>
      <Disclosure
        className="text-[12.5px] text-brand-muted"
        triggerClassName="min-h-9 text-[12.5px] font-normal text-brand-text"
        title={t`How the WebSocket is billed`}
      >
        <ul className="mt-1.5 grid list-disc gap-1 pl-4">
          <li>{t`Opening the connection is one request.`}</li>
          <li>
            {t`Every 20 messages the relay receives count as one request; messages it sends and protocol pings are free.`}
          </li>
          <li>
            {t`Time counts only while the relay is busy (128 MB × seconds); between messages it hibernates and costs nothing, even with a device connected.`}
          </li>
          <li>
            {t`A direct WebRTC link skips the relay entirely and costs nothing.`}
          </li>
        </ul>
      </Disclosure>
    </div>
  )
}
