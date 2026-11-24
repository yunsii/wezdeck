// The session list while its first read is in flight: the shape of a repo
// card with three rows (dot, title, prompt, a row of tags), so the column
// holds its layout instead of a lone 「加载中…」 line that the real list then
// pushed away. Pulses gently; still under reduced motion.
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
      <div className="border-b border-brand-edge px-4 py-2.5">
        <div className={`${bar} h-3 w-24`} />
      </div>
      {[0.72, 0.55, 0.64].map((width) => (
        <div
          key={width}
          className="flex gap-3 border-b border-brand-edge px-4 py-3 last:border-b-0"
        >
          <div className="mt-1.5 size-3 shrink-0 rounded-full bg-brand-deck" />
          <div className="grid min-w-0 flex-1 gap-2">
            <div
              className={`${bar} h-4`}
              style={{ width: `${width * 100}%` }}
            />
            <div className={`${bar} h-3 w-4/5`} />
            <div className="flex gap-1.5">
              <div className={`${bar} h-4 w-8`} />
              <div className={`${bar} h-4 w-14`} />
              <div className={`${bar} h-4 w-12`} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
