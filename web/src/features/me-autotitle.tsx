// 我的 › 自动标题: status and controls for the host's background session
// auto-titler (session.autotitle.status / session.autotitle.update).
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Lock, RefreshCw, Unlock } from 'lucide-react'
import { toast } from 'sonner'

import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Field, FieldList } from '#/components/ui/field'
import { SectionHeading } from '#/components/ui/section-heading'
import { Select } from '#/components/ui/select'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { AgentAvatar } from './agent-avatar'
import { useConsoleMode, useRemoteState } from './console-mode'
import { useDeviceState } from './device-state'

type AutoTitleProvider = {
  id: string
  available: boolean
  model: string
}

type AutoTitleItem = {
  session_id: string
  agent: string
  title: string
  source: 'auto' | 'locked' | 'native'
  provider?: string
  updated_at?: number
  user_turns?: number
  locked?: boolean
  active: boolean
}

export type AutoTitleStatus = {
  enabled: boolean
  provider: string
  effective_provider: string
  effective_model: string
  interval_s: number
  providers: Array<AutoTitleProvider>
  entries: Array<AutoTitleItem>
}

const PROVIDER_LABELS: Record<string, string> = {
  grok: 'Grok',
  claude: 'Claude',
  codex: 'Codex',
}

function providerLabel(id?: string) {
  if (!id) return ''
  return PROVIDER_LABELS[id] ?? id
}

function useAutoTitleReachable() {
  const mode = useConsoleMode()
  const remote = useRemoteState()
  const device = useDeviceState()
  const authorized = mode === 'local' || device.state === 'approved'
  const reachable =
    mode === 'local' ||
    (mode === 'remote' &&
      (remote.mode === 'websocket' || remote.mode === 'webrtc') &&
      device.state === 'approved')
  return { mode, device, authorized, reachable }
}

export function useAutoTitleStatus(pollMs = 15_000) {
  const { mode, device, reachable } = useAutoTitleReachable()
  return useQuery({
    queryKey: ['session.autotitle.status', mode, device.id],
    queryFn: async () =>
      (await hostRead('session.autotitle.status')) as AutoTitleStatus,
    enabled: reachable,
    refetchInterval: pollMs,
    retry: false,
  })
}

export function useAutoTitleSummary() {
  const { t } = useLingui()
  const { authorized } = useAutoTitleReachable()
  const status = useAutoTitleStatus(60_000)
  if (!authorized || !status.data) return undefined
  if (!status.data.enabled) return t`Off`
  const eff = providerLabel(status.data.effective_provider)
  if (!eff) return t`On`
  return status.data.provider ? eff : t`Auto · ${eff}`
}

function formatUpdated(ms?: number) {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function AutoTitleEntryList({
  entries,
  localeParam,
  reachable,
  busy,
  onAction,
}: {
  entries: Array<AutoTitleItem>
  localeParam: 'en' | 'zh' | undefined
  reachable: boolean
  busy: boolean
  onAction: (payload: Record<string, unknown>) => void
}) {
  const { t } = useLingui()
  if (entries.length === 0) {
    return (
      <p className="px-1 text-caption text-brand-muted">
        {t`No session titles recorded yet.`}
      </p>
    )
  }
  return (
    <ul className="overflow-hidden rounded-xl border border-brand-edge bg-brand-surface">
      {entries.map((item) => {
        const eff = providerLabel(item.provider)
        const turns = item.user_turns
        const sourceText =
          item.source === 'locked'
            ? t`Manual /rename`
            : item.source === 'auto'
              ? eff
                ? t`Auto · ${eff}`
                : t`Auto`
              : t`Native`
        const metaParts = [
          sourceText,
          item.active ? t`Active` : t`Archived`,
          item.updated_at ? formatUpdated(item.updated_at) : '',
          turns ? t`${turns} turns` : '',
        ].filter(Boolean)
        return (
          <li
            key={item.session_id}
            className="flex items-center gap-3 border-b border-brand-edge px-3 py-2.5 last:border-b-0"
          >
            <AgentAvatar agent={item.agent} size={32} />
            <div className="min-w-0 flex-1">
              {item.active ? (
                <Link
                  to="/{-$locale}/console/sessions/$id"
                  params={{ locale: localeParam, id: item.session_id }}
                  className="block truncate text-body font-medium hover:underline"
                >
                  {item.title}
                </Link>
              ) : (
                <p className="truncate text-body font-medium text-brand-muted">
                  {item.title}
                </p>
              )}
              <p className="truncate text-meta text-brand-label">
                {metaParts.join(' · ')}
              </p>
            </div>
            {item.locked ? (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={!reachable || busy}
                title={t`Unlock to resume auto-titling`}
                onClick={() =>
                  onAction({ op: 'unlock', session_id: item.session_id })
                }
              >
                <Unlock size={14} aria-hidden />
                {t`Unlock`}
              </Button>
            ) : item.active ? (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={!reachable || busy}
                title={t`Regenerate title now`}
                onClick={() =>
                  onAction({ op: 'refresh', session_id: item.session_id })
                }
              >
                <RefreshCw size={14} aria-hidden />
                {t`Regenerate`}
              </Button>
            ) : (
              <Lock
                size={14}
                aria-hidden
                className="mr-2 shrink-0 text-brand-label opacity-0"
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function AutoTitlePage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const { mode, device, authorized, reachable } = useAutoTitleReachable()
  const queryClient = useQueryClient()
  const queryKey = ['session.autotitle.status', mode, device.id]
  const status = useAutoTitleStatus(10_000)

  const mutate = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      (await hostWrite('session.autotitle.update', payload)) as
        AutoTitleStatus | { ok: boolean; queued: number | string },
    onSuccess: (res, vars) => {
      if ('enabled' in res) {
        queryClient.setQueryData(queryKey, res)
      }
      if (vars.op === 'refresh') {
        toast(
          vars.session_id
            ? t`Regenerating title for this session…`
            : t`Refreshing session titles in the background…`,
        )
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey })
          void queryClient.invalidateQueries({ queryKey: ['remote'] })
        }, 4_000)
      } else if (vars.op === 'unlock') {
        toast(t`Title unlocked; auto-titling will resume.`)
      } else {
        toast(t`Auto-title settings saved`)
      }
      void queryClient.invalidateQueries({ queryKey })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err))
    },
  })

  if (!authorized) {
    return (
      <p className="text-caption text-brand-muted">
        {t`Approve this device in Device access to manage auto titles.`}
      </p>
    )
  }

  if (status.isError) {
    return (
      <p role="alert" className="text-caption text-brand-error">
        {t`Could not read auto-title status.`}
      </p>
    )
  }

  const data = status.data
  if (!data) {
    return <p className="text-caption text-brand-muted">{t`Loading…`}</p>
  }

  const providers = data.providers
  const effectiveText = data.effective_provider
    ? data.effective_model
      ? `${providerLabel(data.effective_provider)} (${data.effective_model})`
      : providerLabel(data.effective_provider)
    : t`No local CLI available`

  const intervalValue =
    data.interval_s <= 30 ? '20' : data.interval_s <= 90 ? '60' : '180'

  return (
    <div className="grid gap-4" data-testid="autotitle-page">
      <p className="text-caption text-brand-muted">
        {t`Runs in the host relay using a local agent CLI to keep active session titles aligned with your latest task. Manual /rename titles are never overwritten.`}
      </p>

      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <span className="text-caption text-brand-muted">{t`Background auto-titling`}</span>
          <Segmented
            label={t`Background auto-titling`}
            value={data.enabled ? 'on' : 'off'}
            onChange={(next) =>
              mutate.mutate({ op: 'configure', enabled: next === 'on' })
            }
            options={[
              { value: 'on', label: t`On` },
              { value: 'off', label: t`Off` },
            ]}
          />
        </div>

        <div className="grid gap-1.5">
          <span className="text-caption text-brand-muted">{t`Agent CLI used to generate titles`}</span>
          <Select
            aria-label={t`Auto-title agent CLI`}
            size="lg"
            value={data.provider}
            disabled={!reachable || mutate.isPending}
            onValueChange={(next) =>
              mutate.mutate({ op: 'configure', provider: next })
            }
            options={[
              {
                value: '',
                label: t`Auto (Grok → Claude → Codex)`,
                icon: <AgentAvatar size={24} />,
              },
              ...providers.map((p) => ({
                value: p.id,
                icon: <AgentAvatar agent={p.id} size={24} />,
                label: p.available
                  ? `${providerLabel(p.id)} · ${p.model}`
                  : `${providerLabel(p.id)} (${t`Unavailable`})`,
                disabled: !p.available,
              })),
            ]}
          />
        </div>

        <div className="grid gap-1.5">
          <span className="text-caption text-brand-muted">{t`Scan interval`}</span>
          <Segmented
            label={t`Scan interval`}
            value={intervalValue}
            onChange={(next) =>
              mutate.mutate({ op: 'configure', interval_s: Number(next) })
            }
            options={[
              { value: '20', label: '20s' },
              { value: '60', label: '60s' },
              { value: '180', label: '180s' },
            ]}
          />
        </div>
      </div>

      <section className="grid gap-1">
        <SectionHeading as="h2" className="bg-brand-key">
          {t`Current runner`}
        </SectionHeading>
        <FieldList>
          <Field label={t`Active CLI`} value={effectiveText} mono />
          <Field
            label={t`Tracked titles`}
            value={String(data.entries.length)}
            mono
          />
        </FieldList>
        <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={!reachable || mutate.isPending || !data.enabled}
            onClick={() => mutate.mutate({ op: 'refresh' })}
          >
            <RefreshCw size={14} aria-hidden />
            {t`Refresh active sessions now`}
          </Button>
        </div>
      </section>

      <section className="grid gap-1.5">
        <SectionHeading as="h2" className="bg-brand-key">
          {t`Session titles`}
        </SectionHeading>
        <AutoTitleEntryList
          entries={data.entries}
          localeParam={localeParam}
          reachable={reachable}
          busy={mutate.isPending}
          onAction={(payload) => mutate.mutate(payload)}
        />
      </section>
    </div>
  )
}
