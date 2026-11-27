// 我的 › 通知: unified Web Push settings for sessions and collab tickets.
// Handles PWA / iOS support detection, PushManager subscription, granular
// per-event toggles, desk-active quiet mode, and end-to-end test delivery.
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { trace } from '#/lib/client-trace'
import {
  DEFAULT_PUSH_PREFS,
  detectPushSupport,
  fetchPushStatus,
  sendTestPush,
  subscribeDevicePush,
  unsubscribeDevicePush,
  updatePushPrefs,
} from '#/lib/push-client'
import type { PushPrefs } from '#/lib/push-client'

const QUERY_KEY = ['push', 'status'] as const

export function useNotificationsSummary(): string {
  const { t } = useLingui()
  const support = detectPushSupport()
  const status = useQuery({
    queryKey: QUERY_KEY,
    enabled: support !== 'unpaired',
    staleTime: 30_000,
    retry: false,
    queryFn: fetchPushStatus,
  })
  if (support === 'unpaired') return t`Pair first`
  if (status.data?.subscribed) return t`On`
  return t`Off`
}

function PrefRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex min-h-12 cursor-pointer items-start justify-between gap-3 py-2.5">
      <span className="grid min-w-0 gap-0.5">
        <span className="text-body font-medium text-brand-text">{label}</span>
        <span className="text-meta text-brand-muted">{hint}</span>
      </span>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(Boolean(v))}
        className="mt-1 shrink-0"
      />
    </label>
  )
}

function NotificationPrefsSections({
  prefs,
  disabled,
  onChange,
}: {
  prefs: PushPrefs
  disabled: boolean
  onChange: <TKey extends keyof PushPrefs>(
    key: TKey,
    value: PushPrefs[TKey],
  ) => void
}) {
  const { t } = useLingui()
  return (
    <>
      <section className="grid divide-y divide-brand-edge rounded-2xl bg-brand-surface px-4 py-1">
        <div className="py-2.5">
          <h3 className="text-caption font-semibold text-brand-label">
            {t`Sessions`}
          </h3>
        </div>
        <PrefRow
          label={t`Waiting for approval or reply`}
          hint={t`Permission prompts, Ask questions, and plan approvals.`}
          checked={prefs.session_waiting}
          disabled={disabled}
          onChange={(v) => onChange('session_waiting', v)}
        />
        <div className="grid gap-2 py-2.5">
          <PrefRow
            label={t`Long turn completed`}
            hint={t`Notify when a long agent turn finishes (off by default).`}
            checked={prefs.session_done}
            disabled={disabled}
            onChange={(v) => onChange('session_done', v)}
          />
          {prefs.session_done ? (
            <div className="flex items-center justify-between gap-3 pb-1">
              <span className="text-meta text-brand-muted">
                {t`Minimum duration`}
              </span>
              <Segmented
                label={t`Minimum duration`}
                dense
                value={String(prefs.session_done_min_s)}
                onChange={(v) => onChange('session_done_min_s', Number(v))}
                options={[
                  { value: '60', label: '60s' },
                  { value: '180', label: '3m' },
                  { value: '300', label: '5m' },
                ]}
              />
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid divide-y divide-brand-edge rounded-2xl bg-brand-surface px-4 py-1">
        <div className="py-2.5">
          <h3 className="text-caption font-semibold text-brand-label">
            {t`Collab tickets`}
          </h3>
        </div>
        <PrefRow
          label={t`Split proposal ready`}
          hint={t`A multi-repo fanout proposal is waiting for your approval.`}
          checked={prefs.ticket_proposal}
          disabled={disabled}
          onChange={(v) => onChange('ticket_proposal', v)}
        />
        <PrefRow
          label={t`Ticket waiting on you`}
          hint={t`A worker raised a question or challenge needing your decision.`}
          checked={prefs.ticket_waiting}
          disabled={disabled}
          onChange={(v) => onChange('ticket_waiting', v)}
        />
        <PrefRow
          label={t`Failure or merge conflict`}
          hint={t`Integration conflict, verification failure, or run error.`}
          checked={prefs.ticket_error}
          disabled={disabled}
          onChange={(v) => onChange('ticket_error', v)}
        />
        <PrefRow
          label={t`Ready to deliver`}
          hint={t`Integration verification passed and awaits delivery confirmation.`}
          checked={prefs.ticket_verify}
          disabled={disabled}
          onChange={(v) => onChange('ticket_verify', v)}
        />
      </section>

      <section className="grid divide-y divide-brand-edge rounded-2xl bg-brand-surface px-4 py-1">
        <div className="py-2.5">
          <h3 className="text-caption font-semibold text-brand-label">
            {t`Noise control`}
          </h3>
        </div>
        <PrefRow
          label={t`Quiet while active at desk`}
          hint={t`Suppress popup banners while you are actively typing in WezTerm (still updates app badge).`}
          checked={prefs.quiet_when_desk_active}
          disabled={disabled}
          onChange={(v) => onChange('quiet_when_desk_active', v)}
        />
      </section>
    </>
  )
}

export function NotificationsPage() {
  const { t } = useLingui()
  const client = useQueryClient()
  const support = detectPushSupport()
  const [errorText, setErrorText] = useState('')

  const statusQuery = useQuery({
    queryKey: QUERY_KEY,
    enabled: support !== 'unpaired',
    retry: false,
    queryFn: fetchPushStatus,
  })

  const subscribed = Boolean(statusQuery.data?.subscribed)
  const relayEnabled = statusQuery.data?.enabled ?? true
  const prefs: PushPrefs = statusQuery.data?.prefs ?? DEFAULT_PUSH_PREFS

  const enableMutation = useMutation({
    mutationFn: () => subscribeDevicePush(prefs),
    onSuccess: () => {
      setErrorText('')
      trace('push-perm', { action: 'subscribed' })
      toast(t`Notifications enabled on this device`)
      void client.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  const disableMutation = useMutation({
    mutationFn: unsubscribeDevicePush,
    onSuccess: () => {
      setErrorText('')
      trace('push-perm', { action: 'unsubscribed' })
      toast(t`Notifications disabled on this device`)
      void client.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  const prefsMutation = useMutation({
    mutationFn: (patch: Partial<PushPrefs>) => updatePushPrefs(patch),
    onSuccess: (res) => {
      setErrorText('')
      client.setQueryData(QUERY_KEY, (prev: typeof statusQuery.data) =>
        prev ? { ...prev, prefs: res.prefs } : prev,
      )
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  const testMutation = useMutation({
    mutationFn: sendTestPush,
    onSuccess: () => {
      setErrorText('')
      toast(t`Test notification sent`)
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  const setPref = <TKey extends keyof PushPrefs>(
    key: TKey,
    value: PushPrefs[TKey],
  ) => {
    if (!subscribed) return
    prefsMutation.mutate({ [key]: value })
  }

  return (
    <div data-testid="notifications-page" className="grid gap-4">
      <section className="grid gap-3 rounded-2xl bg-brand-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="text-body font-semibold text-brand-text">
              {t`This device`}
            </h2>
            <p className="text-caption text-brand-muted">
              {t`Push alerts only carry clipped titles and status labels — never prompts, source code, or diffs.`}
            </p>
          </div>
          {subscribed ? (
            <Bell
              size={20}
              aria-hidden
              className="shrink-0 text-brand-running"
            />
          ) : (
            <BellOff
              size={20}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
          )}
        </div>

        {support === 'unpaired' ? (
          <p className="rounded-xl bg-brand-deck px-3 py-2.5 text-caption text-brand-muted">
            {t`Pair this device with your host first to enable remote push notifications.`}
          </p>
        ) : support === 'ios-install-required' ? (
          <p className="rounded-xl bg-brand-waiting/10 px-3 py-2.5 text-caption text-brand-text">
            {t`On iOS 16.4+, tap Share → “Add to Home Screen”, then open WezDeck from the Home Screen to enable push notifications.`}
          </p>
        ) : support === 'unsupported' ? (
          <p className="rounded-xl bg-brand-deck px-3 py-2.5 text-caption text-brand-muted">
            {t`This browser does not support Web Push notifications.`}
          </p>
        ) : support === 'denied' ? (
          <p className="rounded-xl bg-brand-error/10 px-3 py-2.5 text-caption text-brand-error">
            {t`Notification permission is blocked in browser settings. Re-enable notifications for this site to subscribe.`}
          </p>
        ) : !relayEnabled ? (
          <p className="rounded-xl bg-brand-waiting/10 px-3 py-2.5 text-caption text-brand-text">
            {t`VAPID push keys are not configured on the relay Worker yet.`}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {subscribed ? (
              <>
                <Button
                  variant="solid"
                  type="button"
                  data-testid="push-test-button"
                  disabled={testMutation.isPending}
                  onClick={() => testMutation.mutate()}
                  className="inline-flex min-h-10 items-center gap-1.5"
                >
                  <Send size={14} aria-hidden />
                  <span>
                    {testMutation.isPending
                      ? t`Sending…`
                      : t`Send test notification`}
                  </span>
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  data-testid="push-disable-button"
                  disabled={disableMutation.isPending}
                  onClick={() => disableMutation.mutate()}
                  className="min-h-10"
                >
                  {t`Disable on this device`}
                </Button>
              </>
            ) : (
              <Button
                variant="solid"
                type="button"
                data-testid="push-enable-button"
                disabled={enableMutation.isPending || statusQuery.isPending}
                onClick={() => enableMutation.mutate()}
                className="inline-flex min-h-10 items-center gap-1.5"
              >
                <Bell size={15} aria-hidden />
                <span>
                  {enableMutation.isPending
                    ? t`Enabling…`
                    : t`Enable notifications`}
                </span>
              </Button>
            )}
          </div>
        )}

        {errorText ? (
          <p role="alert" className="text-meta text-brand-error">
            {errorText}
          </p>
        ) : null}
      </section>

      <NotificationPrefsSections
        prefs={prefs}
        disabled={!subscribed || prefsMutation.isPending}
        onChange={setPref}
      />
    </div>
  )
}
