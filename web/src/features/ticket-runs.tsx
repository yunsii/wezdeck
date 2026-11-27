// Compact flat run summary rows for the ticket body + bottom/dialog RunDetail
// sheet so tapping a run inspects its transcript, final output, launch details
// and initial prompt without bloating the main ticket page.
import { useLingui } from '@lingui/react/macro'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { Sheet } from '#/components/ui/sheet'
import type { CollabRunSummary } from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { num, pct, secs, usd } from './console-collab-format'
import { RunDetail } from './console-collab-run'

export function TicketRuns({
  runs,
  poll,
}: {
  runs: Array<CollabRunSummary>
  poll: number
}) {
  const { t } = useLingui()
  const [selected, setSelected] = useState<string | null>(null)
  const activeRun = selected
    ? (runs.find((item) => item.run === selected) ?? null)
    : null

  if (runs.length === 0) {
    return (
      <p className="text-caption text-brand-muted">{t`No headless runs recorded for this ticket.`}</p>
    )
  }

  return (
    <section className="grid gap-1.5">
      <div className="flex items-center justify-between px-1">
        <SectionHeading className="bg-transparent px-0">
          {t`Runs`}
        </SectionHeading>
        <span className="font-mono text-meta text-brand-label tabular-nums">
          {runs.length}
        </span>
      </div>
      <ul
        aria-label={t`Runs`}
        className="ticket-list overflow-hidden rounded-xl bg-brand-surface"
      >
        {runs.map((item) => {
          const tone =
            item.exit == null ? 'running' : item.exit === 0 ? 'done' : 'error'
          const turns = num(item.turns)
          return (
            <li key={item.run}>
              <Button
                variant="plain"
                size="none"
                type="button"
                aria-haspopup="dialog"
                data-testid="ticket-run-row"
                data-run={item.run}
                onClick={() => setSelected(item.run)}
                className="list-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset"
              >
                <span className="row-span-2 self-start pt-1">
                  <Led tone={tone} size={11} />
                </span>
                <span className="flex min-w-0 items-center gap-2 text-body">
                  <span className="truncate font-medium text-brand-text">
                    {item.phase ?? '—'}
                  </span>
                  {item.session?.reuse ? (
                    <span className="truncate text-meta text-brand-label">
                      {item.session.reuse}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0 font-mono text-meta text-brand-label">
                    {item.run.slice(-6)}
                  </span>
                </span>
                <ChevronRight
                  size={15}
                  aria-hidden
                  className="row-span-2 text-brand-label"
                />
                <span className="truncate font-mono text-meta text-brand-muted tabular-nums">
                  {t`${turns} turns`} · {pct(item.cache_hit_rate)} ·{' '}
                  {usd(item.cost_usd)} · {secs(item.wall_ms)}
                </span>
              </Button>
            </li>
          )
        })}
      </ul>
      <Sheet
        open={Boolean(activeRun)}
        onOpenChange={(next) => {
          if (!next) setSelected(null)
        }}
        title={
          activeRun
            ? `${activeRun.phase ?? t`Run`} · ${activeRun.run.slice(-6)}`
            : t`Run detail`
        }
        testId="ticket-run-sheet"
        className="md:max-w-3xl"
      >
        <div className="px-3 pb-4">
          {activeRun ? (
            <RunDetail run={activeRun.run} poll={poll} defaultOpenTranscript />
          ) : null}
        </div>
      </Sheet>
    </section>
  )
}

/** Full tabular run metrics kept inside TicketInfo's Technical details. */
export function RunMetricsTable({ runs }: { runs: Array<CollabRunSummary> }) {
  const { t } = useLingui()
  return (
    <div className="overflow-x-auto rounded-xl border border-brand-edge bg-brand-surface">
      <table
        className="w-full text-left font-mono text-meta"
        aria-label={t`Run metrics`}
      >
        <thead className="bg-brand-deck text-brand-label">
          <tr>
            {[
              t`Run`,
              t`Phase`,
              t`Session`,
              t`Turns`,
              t`Cache hit`,
              t`Cost`,
              t`Wall`,
              t`RSS`,
              t`Exit`,
            ].map((head) => (
              <th key={head} className="px-2 py-1.5 font-normal">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((item) => (
            <tr key={item.run} className="border-t border-brand-border">
              <td className="px-2 py-1.5">{item.run.slice(-6)}</td>
              <td className="px-2 py-1.5">{item.phase ?? '—'}</td>
              <td className="px-2 py-1.5">
                {item.session?.reuse ?? '—'}
                {item.session?.reason ? ` · ${item.session.reason}` : ''}
              </td>
              <td className="px-2 py-1.5">{num(item.turns)}</td>
              <td className="px-2 py-1.5">{pct(item.cache_hit_rate)}</td>
              <td className="px-2 py-1.5">{usd(item.cost_usd)}</td>
              <td className="px-2 py-1.5">{secs(item.wall_ms)}</td>
              <td className="px-2 py-1.5">{num(item.rss_peak_mb)}</td>
              <td
                className={cn(
                  'px-2 py-1.5',
                  item.exit !== 0 && item.exit != null && 'text-brand-error',
                )}
              >
                {item.exit ?? '…'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
