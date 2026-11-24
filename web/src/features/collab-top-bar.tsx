// Top of 工单: the run / cache / cost band, folded — eleven cells, mostly —
// between runs, held the list half a screen down. On a phone it is a text
// link next to ticket activity (no sidebar there); on a wide screen a button
// in the list column's head that opens it in a dialog (the sidebar links
// activity).
import { useLingui } from '@lingui/react/macro'
import { ChartColumn } from 'lucide-react'
import { useState } from 'react'

import { Sheet } from '#/components/ui/sheet'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { ActivityLink } from './console-activity'
import { useMetricsSummary } from './collab-metrics'
import { NewTicketButton } from './ticket-new'
import { Button } from '#/components/ui/button'

export function CollabTopBar({
  band,
  actions,
}: {
  band: React.ReactNode
  /** phone: the list's search and new-ticket buttons, at the end of the link
   * row (they crowded the filter row past a narrow screen's edge) */
  actions?: React.ReactNode
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const wide = useIsWide()
  const summary = useMetricsSummary()
  if (wide)
    // the split column's head: the title and the band one click away in a
    // dialog — unfolded inline it pushed the list half a column down
    return (
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-body font-semibold">{t`Cross-repo collab`}</h1>
        <div className="flex min-w-0 items-center gap-1.5">
          {/* the band in short (24h): runs · cache hit · cost; the full one
              opens in a dialog. The long 「运行、缓存命中与花费」 crowded the
              title row once the new-ticket button moved up here */}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setOpen(true)}
            title={t`Runs, cache hit and cost`}
            aria-label={t`Runs, cache hit and cost`}
            className="min-w-0 gap-1 text-caption text-brand-muted"
          >
            <ChartColumn size={14} aria-hidden className="shrink-0" />
            <span className="truncate tabular-nums">{summary}</span>
          </Button>
          <NewTicketButton />
        </div>
        <Sheet
          open={open}
          onOpenChange={setOpen}
          title={t`Runs, cache hit and cost`}
          className="md:max-w-5xl"
        >
          <div className="px-3 pb-3">{band}</div>
        </Sheet>
      </div>
    )
  // phone: one quiet line of two text links, not two cards — the list
  // starts higher (it held the first screen to three tickets)
  const link =
    'inline-flex min-h-9 items-center gap-1 text-caption text-brand-muted'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <div className="-mt-2 flex items-center gap-5">
        <Button
          variant="plain"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={link}
        >
          {t`Runs and cost`}
          <span aria-hidden className={cn('transition', open && 'rotate-90')}>
            ›
          </span>
        </Button>
        <ActivityLink className={link} />
        {actions ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {actions}
          </div>
        ) : null}
      </div>
      {open ? <div className="key rounded-xl p-2">{band}</div> : null}
    </div>
  )
}
