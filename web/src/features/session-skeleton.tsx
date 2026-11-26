// The session list while its first read is in flight: same outer shell as
// the loaded IM rail (session-chats grid + repo card), so gutters match.
// Row padding is pl-4 pr-14 like ChatRow (trailing actions column) — never
// px-4 alone, which left the skeleton flush on the right.
import { useLingui } from '@lingui/react/macro'

const bar = 'rounded-full bg-brand-deck'

export function SessionListSkeleton() {
  const { t } = useLingui()
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)] gap-3"
      data-testid="session-chats"
    >
      <div
        role="status"
        aria-label={t`Loading…`}
        data-testid="session-skeleton"
        className="animate-pulse overflow-hidden rounded-2xl bg-brand-surface motion-reduce:animate-none"
      >
        <div className="border-b border-brand-edge py-2 pr-14 pl-4">
          <div className={`${bar} h-3 w-24`} />
        </div>
        {[0.58, 0.42, 0.5].map((width, index) => (
          <div
            key={width}
            className="flex items-start gap-3 border-b border-brand-edge py-2.5 pr-14 pl-4 last:border-b-0"
          >
            <div className="mt-0.5 size-10 shrink-0 rounded-full bg-brand-deck" />
            <div className="grid min-w-0 flex-1 gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <div
                  className={`${bar} h-4 min-w-0`}
                  style={{ width: `${width * 100}%` }}
                />
                <div className={`${bar} h-3 w-10 shrink-0`} />
              </div>
              <div
                className={`${bar} h-3 max-w-full`}
                style={{ width: `${[0.72, 0.55, 0.64][index] * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
