// 新工单 from the phone (host ticket_new.go → `ticket create`): from one
// repository to another — both from the ticket config's targets — with the
// assumption gate's two fields, what you saw and what you assume. "Start
// now" runs it in its own systemd unit on the host. The + beside the status
// filter (`n` with a keyboard) opens it; the new ticket opens after.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useLocale } from '#/lib/locale-context'
import { remoteLink } from '#/lib/remote-link'
import { hostRead } from '#/lib/runtime-client'
import { jumpPending } from './console-jump-keys'
import { useDeviceState } from './device-state'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { Select } from '#/components/ui/select'
import { Checkbox } from '#/components/ui/checkbox'
import { Sheet } from '#/components/ui/sheet'

type Target = { key: string; path: string }

export function NewTicketButton() {
  const { t } = useLingui()
  const device = useDeviceState()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'n' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        jumpPending()
      )
        return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (device.state !== 'approved') return null
  return (
    <>
      <Button
        variant="solid"
        type="button"
        onClick={() => setOpen(true)}
        data-testid="new-ticket"
        title={t`New ticket (n)`}
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 px-3 text-[14px] md:min-h-9"
      >
        <Plus size={18} aria-hidden />
        <span className="sr-only md:not-sr-only">{t`New ticket`}</span>
      </Button>
      {open ? <NewTicketSheet onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function NewTicketSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const client = useQueryClient()
  const targets = useQuery({
    queryKey: ['remote', 'ticket.targets'],
    queryFn: async () =>
      (await hostRead('ticket.targets', {})) as {
        targets: Array<Target>
      },
  })
  const keys = (targets.data?.targets ?? []).map((target) => target.key)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [title, setTitle] = useState('')
  const [observed, setObserved] = useState('')
  const [assumed, setAssumed] = useState('')
  const [run, setRun] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fromKey = from || keys[0] || ''
  const toKey = to || keys.find((key) => key !== fromKey) || ''
  const ready =
    Boolean(fromKey) &&
    Boolean(toKey) &&
    fromKey !== toKey &&
    Boolean(title.trim()) &&
    Boolean(observed.trim()) &&
    Boolean(assumed.trim())
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const res = (await remoteLink.write('ticket.new', {
        from: fromKey,
        to: toKey,
        title: title.trim(),
        observed: observed.trim(),
        assumed: assumed.trim(),
        run,
      })) as { id: string; run: string; run_error?: string }
      await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
      onClose()
      void navigate({
        to: '/{-$locale}/console/collab/$id',
        params: { locale: locale === 'en' ? undefined : locale, id: res.id },
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const repoSelect = (
    value: string,
    onChange: (value: string) => void,
    label: string,
  ) => (
    <label className="grid min-w-0 gap-1 text-[13px] text-brand-muted">
      {label}
      <Select
        size="lg"
        value={value}
        disabled={busy}
        onValueChange={onChange}
        options={keys.map((key) => ({ value: key, label: key }))}
      />
    </label>
  )
  return (
    <Sheet
      open={true}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t`New ticket`}
      testId="new-ticket-sheet"
      write
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 sm:gap-2">
          {repoSelect(fromKey, setFrom, t`From`)}
          {repoSelect(toKey, setTo, t`To`)}
        </div>
        {fromKey && fromKey === toKey ? (
          <p className="text-[12px] text-brand-error">
            {t`A ticket goes to another repository.`}
          </p>
        ) : null}
        <label className="grid gap-1 text-[13px] text-brand-muted">
          {t`Title`}
          <Input
            variant="field"
            value={title}
            disabled={busy}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t`What the other repository should do`}
          />
        </label>
        <label className="grid gap-1 text-[13px] text-brand-muted">
          {t`What you saw`}
          <Textarea
            value={observed}
            disabled={busy}
            rows={3}
            onChange={(event) => setObserved(event.target.value)}
            placeholder={t`The behaviour, error or data you actually observed`}
          />
        </label>
        <label className="grid gap-1 text-[13px] text-brand-muted">
          {t`What you assume`}
          <Textarea
            value={assumed}
            disabled={busy}
            rows={3}
            onChange={(event) => setAssumed(event.target.value)}
            placeholder={t`The contract or behaviour you expect from it — the target checks this first`}
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-[14px]">
          <Checkbox checked={run} disabled={busy} onCheckedChange={setRun} />
          {t`Start working on it now (a headless run on the host)`}
        </label>
        {error ? (
          <p role="alert" className="text-[13px] text-brand-error">
            {error}
          </p>
        ) : null}
        <Button
          variant="solid"
          type="button"
          disabled={!ready || busy}
          onClick={() => void submit()}
          className="min-h-12 px-3 text-[15px] disabled:opacity-40"
        >
          {busy ? t`Creating…` : t`Create ticket`}
        </Button>
      </div>
    </Sheet>
  )
}
