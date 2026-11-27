import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { Button } from '#/components/ui/button'

export function SessionStaleNotice({
  staleAt,
  message,
}: {
  staleAt: string
  message?: string
}) {
  const { t } = useLingui()
  return (
    <p
      role="status"
      data-testid="session-stale"
      className="rounded-xl bg-brand-waiting/10 px-3 py-1.5 text-meta text-brand-text"
    >
      {t`Can't get the latest from the host, showing ${staleAt}:`}{' '}
      {message ?? t`this device is offline`}
    </p>
  )
}

export function SessionInputUnavailable({
  onRecover,
  recovering,
}: {
  onRecover?: () => void
  recovering: boolean
}) {
  const { t } = useLingui()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="status" className="text-meta text-brand-label">
        {onRecover
          ? t`Codex is no longer running in this terminal.`
          : t`This conversation is read-only.`}
      </p>
      {onRecover ? (
        <Button type="button" disabled={recovering} onClick={onRecover}>
          {recovering ? t`Resuming conversation…` : t`Resume this conversation`}
        </Button>
      ) : null}
    </div>
  )
}

export function SessionBlockedNotice({
  blocked,
  approved,
  locale,
}: {
  blocked: string
  approved: boolean
  locale: 'zh' | 'en'
}) {
  const { t } = useLingui()
  return (
    <p className="text-meta text-brand-muted">
      {blocked}{' '}
      {!approved ? (
        <Link
          to="/{-$locale}/console/me/$page"
          params={{
            locale: locale === 'en' ? undefined : locale,
            page: 'writing',
          }}
          className="text-brand-running"
        >
          {t`Open settings`}
        </Link>
      ) : null}
    </p>
  )
}
