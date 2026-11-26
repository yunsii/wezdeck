// The session list while its first read is in flight: the shape of the IM
// chat rail (repo head + avatar rows with title / preview / time), so the
// column holds its layout. Matches ChatRow padding (including pr-14 for the
// trailing actions column). Pulses gently; still under reduced motion.
import { useLingui } from '@lingui/react/macro'

const bar = 'rounded-full bg-brand-deck'

export function SessionListSkeleton() {
  const { t } = useLingui()
  return (
    <div
      role="status"
      aria-label={t`Loading…`}
      data-testid="session-skeleton"
      className="animate-pulse overflow-hidden rounded-2xl bg-brand-surface motion-reduce:animate-none"
    >
      <div className="border-b border-brand-edge px-4 py-2">
        <div className={`${bar} h-3 w-24`} />
      </div>
      {[0.58, 0.42, 0.5].map((width, index) => (
        <div
          key={width}
          className="flex items-start gap-3 border-b border-brand-edge px-4 py-2.5 pr-14 last:border-b-0"
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
              className={`${bar} h-3`}
              style={{ width: `${[0.72, 0.55, 0.64][index] * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
