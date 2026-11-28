import { useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HardDrive, RotateCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { SectionHeading } from '#/components/ui/section-heading'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { useDeviceState } from './device-state'
import { useConsoleMode, useRemoteState } from './console-mode'

type Progress = {
  task_id: string
  phase: string
  updated_at?: string
  active_attention?: number
  snapshot_windows?: number
  reclaimed_bytes?: number
  vhdx_reduced_bytes?: number
  compact_elapsed_seconds?: number
  after_vhdx_bytes?: number
  after_free_bytes?: number
  failed_stage?: string
  error?: string
  history?: Array<{ phase: string; at: string }>
}
type Reply = { phase: string; task?: Progress }

function localDeviceId() {
  if (typeof window === 'undefined') return 'local'
  try {
    const key = 'wezdeck-disk-reclaim-device'
    let id = window.localStorage.getItem(key)
    if (!id) {
      id = crypto.randomUUID()
      window.localStorage.setItem(key, id)
    }
    return id
  } catch {
    return 'local'
  }
}

const activePhases = new Set([
  'queued',
  'preparing',
  'preflight',
  'trimming',
  'compacting',
  'restarting',
  'verifying',
])

export function DiskReclaimControl() {
  const { t } = useLingui()
  const mode = useConsoleMode()
  const remote = useRemoteState()
  const device = useDeviceState()
  const client = useQueryClient()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [localId] = useState(localDeviceId)
  const targetDevice = mode === 'local' ? localId : (device.id ?? '')
  const reachable =
    mode === 'local' ||
    ((remote.mode === 'websocket' || remote.mode === 'webrtc') &&
      device.state === 'approved')
  const key = useMemo(
    () => ['disk.reclaim.status', targetDevice],
    [targetDevice],
  )
  const status = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await hostRead('disk.reclaim.status', {
        target_device: targetDevice,
      })) as Reply,
    enabled: reachable && Boolean(targetDevice),
    refetchInterval: 3_000,
    retry: false,
  })
  useEffect(() => {
    const onProgress = (event: Event) => {
      const next = (event as CustomEvent<Progress>).detail
      if (!next.task_id) return
      client.setQueryData<Reply>(key, (current) => {
        if (!current?.task || current.task.task_id !== next.task_id)
          return current
        return { phase: next.phase, task: { ...current.task, ...next } }
      })
      void client.invalidateQueries({ queryKey: key })
    }
    window.addEventListener('wezdeck:disk-reclaim-progress', onProgress)
    return () =>
      window.removeEventListener('wezdeck:disk-reclaim-progress', onProgress)
  }, [client, key])
  const start = useMutation({
    mutationFn: async () =>
      (await hostWrite('disk.reclaim.start', {
        confirm: true,
        target_device: targetDevice,
      })) as {
        task_id: string
      },
    onSuccess: ({ task_id }) => {
      setConfirmOpen(false)
      client.setQueryData<Reply>(key, {
        phase: 'queued',
        task: { task_id, phase: 'queued' },
      })
      void client.invalidateQueries({ queryKey: key })
    },
    onError: (error) => toast.error(error.message),
  })
  const progress = status.data?.task
  const reclaimedGiB = ((progress?.reclaimed_bytes ?? 0) / 1024 ** 3).toFixed(1)
  const observedGiB = ((progress?.vhdx_reduced_bytes ?? 0) / 1024 ** 3).toFixed(
    1,
  )
  const compactSeconds = Math.floor(progress?.compact_elapsed_seconds ?? 0)
  const compactMinutes = Math.floor(compactSeconds / 60)
  const compactRemainder = compactSeconds % 60
  const phaseLabel: Record<string, string> = {
    queued: t`Queued`,
    preparing: t`Preparing`,
    preflight: t`Checking`,
    trimming: t`Reclaiming guest blocks`,
    compacting: t`Compacting VHDX`,
    restarting: t`Restarting WSL`,
    verifying: t`Checking services`,
    complete: t`Completed`,
    failed: t`Failed`,
    blocked: t`Blocked`,
  }
  if (mode !== 'local' && device.state !== 'approved') return null
  return (
    <section className="grid gap-2">
      <SectionHeading
        as="h2"
        className="bg-brand-deck"
      >{t`WSL disk`}</SectionHeading>
      <div className="flex flex-wrap items-center gap-3 px-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            !reachable ||
            start.isPending ||
            activePhases.has(progress?.phase ?? '')
          }
          onClick={() => setConfirmOpen(true)}
        >
          <HardDrive size={16} aria-hidden />
          {t`Compact and restart WSL`}
        </Button>
        {progress ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-meta text-brand-muted"
          >
            {activePhases.has(progress.phase) ? (
              <RotateCw size={14} className="animate-spin" aria-hidden />
            ) : null}
            {phaseLabel[progress.phase] ?? progress.phase}
          </span>
        ) : null}
      </div>
      {progress?.phase === 'complete' ? (
        <p className="px-1 text-meta text-brand-muted">
          {t`D drive recovered ${reclaimedGiB} GiB`}
        </p>
      ) : null}
      {progress?.phase === 'compacting' ? (
        <p className="px-1 text-meta tabular-nums text-brand-muted">
          {t`Elapsed ${compactMinutes}m ${compactRemainder}s`}
          {' · '}
          {t`Observed VHDX reduction ${observedGiB} GiB`}
        </p>
      ) : null}
      {!reachable && progress && activePhases.has(progress.phase) ? (
        <p role="status" className="px-1 text-meta text-brand-muted">
          {t`WSL offline; progress resumes after reconnect`}
        </p>
      ) : null}
      {progress?.phase === 'failed' ? (
        <p role="alert" className="break-words px-1 text-meta text-brand-error">
          {progress.failed_stage ? `${progress.failed_stage}: ` : ''}
          {progress.error || t`Recovery failed`}
        </p>
      ) : null}
      {progress?.history?.length ? (
        <ol className="grid gap-0.5 px-1 text-meta text-brand-muted">
          {progress.history.slice(-5).map((step) => (
            <li key={`${step.phase}:${step.at}`}>
              {new Date(step.at).toLocaleTimeString()} ·{' '}
              {phaseLabel[step.phase] ?? step.phase}
            </li>
          ))}
        </ol>
      ) : null}
      <Sheet
        open={confirmOpen}
        write
        title={t`Compact and restart WSL`}
        onOpenChange={setConfirmOpen}
      >
        <div className="grid gap-4 px-4">
          <p className="text-body text-brand-muted">
            {t`This stops every WSL session, including active agents. Tmux windows will be recreated, but in-progress agent turns will be interrupted.`}
          </p>
          <div className="flex flex-col-reverse gap-2.5 md:flex-row md:justify-end">
            <Button
              type="button"
              variant="key"
              size="md"
              onClick={() => setConfirmOpen(false)}
            >{t`Cancel`}</Button>
            <Button
              type="button"
              variant="solid"
              size="md"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              <HardDrive size={16} aria-hidden /> {t`Confirm and start`}
            </Button>
          </div>
        </div>
      </Sheet>
    </section>
  )
}
