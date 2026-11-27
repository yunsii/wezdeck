import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'

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

export function SessionInputUnavailable() {
  const { t } = useLingui()
  return (
    <p role="status" className="text-meta text-brand-label">
      {t`This conversation is read-only.`}
    </p>
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
