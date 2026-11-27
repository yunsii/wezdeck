// The session list while its first read is in flight: same outer shell as
// the loaded IM rail (session-chats grid + repo card), so gutters match.
// Row padding is pl-4 pr-14 like ChatRow (trailing actions column) — never
// px-4 alone, which left the skeleton flush on the right.
import { useLingui } from '@lingui/react/macro'

import { SkeletonGroup } from '#/components/ui/skeleton'

const bar = 'rounded-full bg-brand-deck'

export function SessionListSkeleton() {
  const { t } = useLingui()
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)] bg-brand-surface"
      data-testid="session-chats"
    >
      <div
        role="status"
        aria-label={t`Loading…`}
        data-testid="session-skeleton"
        className="bg-brand-surface"
      >
        <SkeletonGroup>
          <div className="flex h-8 items-center border-b border-brand-edge bg-brand-deck px-3">
            <div className="h-3 w-24 rounded-full bg-brand-edge" />
          </div>
          <ul className="chat-list">
            {[0.58, 0.42, 0.5].map((width, index) => (
              <li
                key={width}
                className="flex min-h-16 items-center gap-3 px-3 py-2"
              >
                <div className="size-10 shrink-0 rounded-full bg-brand-deck" />
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
              </li>
            ))}
          </ul>
        </SkeletonGroup>
      </div>
    </div>
  )
}
