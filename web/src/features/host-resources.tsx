import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { Activity, HardDrive, MemoryStick, Search } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { hostRead } from '#/lib/runtime-client'
import { useDeviceState } from './device-state'
import { useConsoleMode, useRemoteState } from './console-mode'

type Volume = {
  mount: string
  level: string
  avail_bytes: number
  size_bytes: number
}
type Resources = {
  sampled_at: number
  system: Volume
  wsl: Volume
  vhdx_bytes: number
  guest_used_bytes: number
  gap_bytes: number
  memory: {
    sampled_at: number
    level: string
    used_pct: number
    total_mib: number
    swap_used_pct: number
    loadavg_1: number
    loadavg_5: number
    cpus: number
  }
}
type Candidate = {
  label: string
  path: string
  bytes: number
  kind: string
  count?: number
  volume: 'system' | 'wsl'
}
type CandidateReply = { items: Array<Candidate>; partial: boolean }

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
const driveLabel = (mount: string) =>
  /^\/mnt\/[a-z]$/.test(mount) ? `${mount.at(-1)?.toUpperCase()}:` : mount
const pressure = (volume: Volume) =>
  volume.level === 'warn' ||
  volume.level === 'crit' ||
  (volume.size_bytes > 0 && volume.avail_bytes / volume.size_bytes <= 0.2)

function Meter({ value, tone }: { value: number; tone: string }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-sm bg-brand-edge"
      aria-hidden
    >
      <div
        className={
          tone === 'crit'
            ? 'h-full bg-brand-error'
            : tone === 'warn'
              ? 'h-full bg-brand-waiting'
              : 'h-full bg-brand-running'
        }
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

export function HostResources() {
  const { t } = useLingui()
  const mode = useConsoleMode()
  const remote = useRemoteState()
  const device = useDeviceState()
  const [showCandidates, setShowCandidates] = useState(false)
  const reachable =
    mode === 'local' ||
    ((remote.mode === 'websocket' || remote.mode === 'webrtc') &&
      device.state === 'approved')
  const resources = useQuery({
    queryKey: ['host.resources'],
    queryFn: async () => (await hostRead('host.resources')) as Resources,
    enabled: reachable,
    refetchInterval: 15_000,
    retry: false,
  })
  const candidates = useQuery({
    queryKey: ['host.disk.candidates'],
    queryFn: async () =>
      (await hostRead('host.disk.candidates')) as CandidateReply,
    enabled: reachable && showCandidates,
    staleTime: 60_000,
    retry: false,
  })
  const data = resources.data
  const now = Date.now()
  const diskFresh = Boolean(
    data?.sampled_at && now - data.sampled_at < 13 * 60_000,
  )
  const memoryFresh = Boolean(
    data?.memory.sampled_at && now - data.memory.sampled_at < 90_000,
  )
  const volumes = [
    { label: t`System disk`, value: data?.system },
    { label: t`WSL disk`, value: data?.wsl },
  ]
  const needsCleanup = volumes.some(({ value }) => value && pressure(value))
  const relevantCandidates = candidates.data?.items.filter((item) =>
    item.volume === 'system'
      ? Boolean(data?.system && pressure(data.system))
      : Boolean(data?.wsl && pressure(data.wsl)),
  )
  const candidateLabel = (item: Candidate) => {
    if (item.kind === 'dependencies') {
      const count = item.count ?? 0
      return t`Web dependencies in ${count} worktrees`
    }
    return (
      {
        'Go build cache': t`Go build cache`,
        'npm cache': t`npm cache`,
        'pnpm metadata cache': t`pnpm metadata cache`,
        'Chrome Service Worker cache': t`Chrome Service Worker cache`,
      }[item.label] ?? item.label
    )
  }
  const vhdxSize = gib(data?.vhdx_bytes ?? 0)
  const reusable = gib(data?.gap_bytes ?? 0)
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <SectionHeading
        as="h2"
        className="bg-brand-deck"
      >{t`Resources`}</SectionHeading>
      <div className="grid gap-px overflow-hidden rounded-md bg-brand-edge sm:grid-cols-2">
        {volumes.map(({ label, value }) => {
          const used = value?.size_bytes
            ? 100 * (1 - value.avail_bytes / value.size_bytes)
            : 0
          return (
            <div
              key={label}
              className="grid min-w-0 content-start gap-2 bg-brand-surface px-3 py-3"
            >
              <div className="flex items-center justify-between gap-2 text-caption">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                  <HardDrive size={15} aria-hidden />
                  {label}
                </span>
                <span className="shrink-0 text-brand-muted">
                  {value?.mount ? driveLabel(value.mount) : '—'}
                </span>
              </div>
              <div className="text-body tabular-nums">
                {diskFresh && value?.size_bytes ? (
                  <>
                    {gib(value.avail_bytes)}{' '}
                    <span className="text-brand-muted">
                      / {gib(value.size_bytes)}
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </div>
              <Meter value={diskFresh ? used : 0} tone={value?.level ?? ''} />
            </div>
          )
        })}
        <div className="grid min-w-0 content-start gap-2 bg-brand-surface px-3 py-3">
          <div className="inline-flex items-center gap-1.5 text-caption font-medium">
            <Activity size={15} aria-hidden />
            {t`WSL CPU load`}
          </div>
          <div className="text-body tabular-nums">
            {memoryFresh
              ? `${data?.memory.loadavg_1.toFixed(1)} / ${data?.memory.cpus}`
              : '—'}
          </div>
          <span className="text-meta text-brand-muted">{t`1-minute load / logical CPUs`}</span>
        </div>
        <div className="grid min-w-0 content-start gap-2 bg-brand-surface px-3 py-3">
          <div className="inline-flex items-center gap-1.5 text-caption font-medium">
            <MemoryStick size={15} aria-hidden />
            {t`WSL memory`}
          </div>
          <div className="text-body tabular-nums">
            {memoryFresh && data
              ? `${data.memory.used_pct.toFixed(0)}% · ${(data.memory.total_mib / 1024).toFixed(1)} GiB`
              : '—'}
          </div>
          <Meter
            value={memoryFresh ? (data?.memory.used_pct ?? 0) : 0}
            tone={data?.memory.level ?? ''}
          />
        </div>
      </div>
      {diskFresh && data ? (
        <p className="px-1 text-meta text-brand-muted tabular-nums">
          {t`VHDX ${vhdxSize} · reusable inside ${reusable}`}
        </p>
      ) : null}
      {diskFresh && needsCleanup ? (
        <div className="grid gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={() => {
              if (showCandidates) void candidates.refetch()
              else setShowCandidates(true)
            }}
          >
            <Search size={15} aria-hidden />
            {t`Inspect reclaimable files`}
          </Button>
          {showCandidates ? (
            <div className="divide-y divide-brand-edge bg-brand-surface">
              {relevantCandidates?.map((item) => (
                <div
                  key={item.path}
                  className="flex min-w-0 items-start justify-between gap-3 px-3 py-2 text-caption"
                >
                  <span className="min-w-0">
                    <span className="block">{candidateLabel(item)}</span>
                    <span
                      className="block truncate text-meta text-brand-muted"
                      title={item.path}
                    >
                      {item.path}
                    </span>
                    {item.kind === 'dependencies' ? (
                      <span className="block text-meta text-brand-muted">{t`Shared hardlinks; reclaim may be smaller`}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {item.bytes > 0 ? gib(item.bytes) : '—'}
                  </span>
                </div>
              ))}
              {candidates.isPending ? (
                <p className="px-3 py-2 text-caption text-brand-muted">{t`Scanning…`}</p>
              ) : null}
              {candidates.isError ? (
                <p
                  role="alert"
                  className="px-3 py-2 text-caption text-brand-error"
                >{t`Scan unavailable`}</p>
              ) : null}
              {candidates.data && !relevantCandidates?.length ? (
                <p className="px-3 py-2 text-caption text-brand-muted">{t`No large rebuildable cache found`}</p>
              ) : null}
              {candidates.data?.partial ? (
                <p className="px-3 py-2 text-meta text-brand-muted">{t`Partial scan`}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
