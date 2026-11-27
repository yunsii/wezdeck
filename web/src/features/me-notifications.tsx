// 我的 › 通知: unified Web Push settings for sessions and collab tickets.
// Handles PWA / iOS support detection, PushManager subscription, granular
// per-event toggles, desk-active quiet mode, and end-to-end test delivery.
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, Radio, Send } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { trace } from '#/lib/client-trace'
import { remoteLink } from '#/lib/remote-link'
import {
  DEFAULT_PUSH_PREFS,
  detectPushSupport,
  fetchPushStatus,
  isPushServiceError,
  sendTestPush,
  subscribeDevicePush,
  subscribeWsFallbackPush,
  unsubscribeDevicePush,
  updatePushPrefs,
} from '#/lib/push-client'
import type { PushPrefs } from '#/lib/push-client'

const QUERY_KEY = ['push', 'status'] as const

export function useNotificationsSummary(): string {
  const { t } = useLingui()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const support = mounted ? detectPushSupport() : 'unpaired'
  const status = useQuery({
    queryKey: QUERY_KEY,
    enabled: mounted && support !== 'unpaired',
    staleTime: 30_000,
    retry: false,
    queryFn: fetchPushStatus,
  })
  if (!mounted || support === 'unpaired') return t`Pair first`
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
          label={t`Quiet while active on another device`}
          hint={t`Suppress popups while you are typing in WezTerm or viewing WezDeck in the foreground on any device (still syncs badge).`}
          checked={prefs.quiet_when_desk_active}
          disabled={disabled}
          onChange={(v) => onChange('quiet_when_desk_active', v)}
        />
      </section>
    </>
  )
}

function PushErrorCallout({
  errorText,
  wsPending,
  onEnableWs,
}: {
  errorText: string
  wsPending: boolean
  onEnableWs: () => void
}) {
  const { t } = useLingui()
  if (!errorText) return null
  if (!isPushServiceError(errorText)) {
    return (
      <p role="alert" className="text-meta text-brand-error">
        {errorText}
      </p>
    )
  }
  return (
    <div
      role="alert"
      data-testid="push-service-error-guide"
      className="grid gap-2.5 rounded-xl border border-brand-waiting/40 bg-brand-waiting/10 p-3 text-caption text-brand-text"
    >
      <p className="font-medium">
        {t`Browser push service (FCM/GMS) is unreachable on this device.`}
      </p>
      <p className="text-meta text-brand-muted">
        {t`Chrome Web Push requires mtalk.google.com:5228 (and Google Play Services on Android). Check chrome://gcm-internals, route FCM through your proxy, switch to Firefox/Edge, or use background WebSocket notifications below without FCM.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="solid"
          size="sm"
          type="button"
          data-testid="push-fallback-ws-button"
          disabled={wsPending}
          onClick={onEnableWs}
          className="inline-flex items-center gap-1.5"
        >
          <Radio size={14} aria-hidden />
          <span>
            {wsPending
              ? t`Enabling…`
              : t`Use background keepalive notifications (no FCM)`}
          </span>
        </Button>
      </div>
    </div>
  )
}

function PushSupportBanner({ support }: { support: string }) {
  const { t } = useLingui()
  if (support === 'unpaired') {
    return (
      <p className="rounded-xl bg-brand-deck px-3 py-2.5 text-caption text-brand-muted">
        {t`Pair this device with your host first to enable remote push notifications.`}
      </p>
    )
  }
  if (support === 'ios-install-required') {
    return (
      <p className="rounded-xl bg-brand-waiting/10 px-3 py-2.5 text-caption text-brand-text">
        {t`On iOS 16.4+, tap Share → “Add to Home Screen”, then open WezDeck from the Home Screen to enable push notifications.`}
      </p>
    )
  }
  if (support === 'unsupported') {
    return (
      <p className="rounded-xl bg-brand-deck px-3 py-2.5 text-caption text-brand-muted">
        {t`This browser does not support Web Push notifications.`}
      </p>
    )
  }
  return (
    <p className="rounded-xl bg-brand-error/10 px-3 py-2.5 text-caption text-brand-error">
      {t`Notification permission is blocked in browser settings. Re-enable notifications for this site to subscribe.`}
    </p>
  )
}

export function NotificationsPage() {
  const { t } = useLingui()
  const client = useQueryClient()
  const [mounted, setMounted] = useState(false)
  // Re-evaluate push support once remoteLink adopts a `#pair=` hash or connects.
  useSyncExternalStore(
    remoteLink.subscribe,
    remoteLink.snapshot,
    remoteLink.snapshot,
  )
  useEffect(() => {
    setMounted(true)
    remoteLink.start()
  }, [])
  const support = mounted ? detectPushSupport() : 'unpaired'
  const [errorText, setErrorText] = useState('')

  const statusQuery = useQuery({
    queryKey: QUERY_KEY,
    enabled: mounted && support !== 'unpaired',
    retry: false,
    queryFn: fetchPushStatus,
  })

  const subscribed = Boolean(statusQuery.data?.subscribed)
  const mode = statusQuery.data?.mode ?? (subscribed ? 'webpush' : null)
  const relayEnabled = statusQuery.data?.enabled ?? true
  const prefs: PushPrefs = statusQuery.data?.prefs ?? DEFAULT_PUSH_PREFS

  const enableMutation = useMutation({
    mutationFn: () => subscribeDevicePush(prefs),
    onSuccess: () => {
      setErrorText('')
      trace('push-perm', { action: 'subscribed', mode: 'webpush' })
      toast(t`Notifications enabled on this device`)
      void client.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  const enableWsMutation = useMutation({
    mutationFn: () => subscribeWsFallbackPush(prefs),
    onSuccess: () => {
      setErrorText('')
      trace('push-perm', { action: 'subscribed', mode: 'ws' })
      toast(t`Background keepalive notifications enabled`)
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

        {support !== 'ready' && support !== 'ws-only' ? (
          <PushSupportBanner support={support} />
        ) : (
          <div className="grid gap-2.5">
            {subscribed && mode === 'ws' ? (
              <p
                data-testid="push-ws-mode-hint"
                className="rounded-xl bg-brand-deck px-3 py-2 text-meta text-brand-muted"
              >
                {t`Active channel: Background keepalive (WebSocket, no FCM). Alerts only pop while WezDeck stays alive in the background and stay silent in the foreground.`}
              </p>
            ) : null}
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
                <>
                  {support === 'ready' && relayEnabled ? (
                    <Button
                      variant="solid"
                      type="button"
                      data-testid="push-enable-button"
                      disabled={
                        enableMutation.isPending || statusQuery.isPending
                      }
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
                  ) : null}
                  <Button
                    variant={
                      support === 'ready' && relayEnabled ? 'outline' : 'solid'
                    }
                    type="button"
                    data-testid="push-ws-enable-button"
                    disabled={
                      enableWsMutation.isPending || statusQuery.isPending
                    }
                    onClick={() => enableWsMutation.mutate()}
                    className="inline-flex min-h-10 items-center gap-1.5"
                  >
                    <Radio size={15} aria-hidden />
                    <span>
                      {enableWsMutation.isPending
                        ? t`Enabling…`
                        : t`Background keepalive (no FCM)`}
                    </span>
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        <PushErrorCallout
          errorText={errorText}
          wsPending={enableWsMutation.isPending}
          onEnableWs={() => enableWsMutation.mutate()}
        />
      </section>

      <NotificationPrefsSections
        prefs={prefs}
        disabled={!subscribed || prefsMutation.isPending}
        onChange={setPref}
      />
    </div>
  )
}
