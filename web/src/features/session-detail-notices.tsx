import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'

export function SessionInputUnavailable() {
  const { t } = useLingui()
  return (
    <p role="status" className="text-meta text-brand-label">
      {t`Web sending is unavailable for this session.`}
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
