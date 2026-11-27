// Top of 工单: on a wide screen, title + 24 h metrics summary button + new
// ticket in the split column head; on a phone, compact icon buttons (metrics
// sheet, ticket activity link, new ticket) sharing row 1 with the search box.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { ChartColumn, ListTree } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { useLocale } from '#/lib/locale-context'
import { useIsWide } from '#/lib/use-media'
import { useMetricsSummary } from './collab-metrics'
import { NewTicketButton } from './ticket-new'

export function CollabTopBar({
  band,
  search,
}: {
  band: React.ReactNode
  /** phone: always-visible search box placed on the same compact top row */
  search?: React.ReactNode
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const wide = useIsWide()
  const summary = useMetricsSummary()
  if (wide)
    // the split column's head: compact title + icon actions matching the phone
    // row (24h summary sits in the metrics icon's tooltip; clicking opens the
    // full sheet), keeping the 300–360 px column uncramped
    return (
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h1 className="truncate text-body font-semibold">
          {t({ message: 'Tickets', context: 'nav' })}
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            title={`${t`Runs, cache hit and cost`} · ${summary}`}
            aria-label={t`Runs, cache hit and cost`}
            data-testid="collab-metrics-button"
            className="size-9 shrink-0 rounded-xl text-brand-muted"
          >
            <ChartColumn size={18} aria-hidden />
          </Button>
          <Link
            to="/{-$locale}/console/activity"
            params={{ locale: locale === 'en' ? undefined : locale }}
            aria-label={t`Ticket activity`}
            title={`${t`Ticket activity`} (g a)`}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-brand-muted outline-none transition-colors hover:bg-brand-soft hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
          >
            <ListTree size={18} aria-hidden />
          </Link>
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
  // phone: compact single row matching 会话 (search + metrics icon + activity
  // icon + new ticket), sized to fit 320 px with zero horizontal overflow
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {search}
      <Button
        variant="ghost"
        size="icon"
        type="button"
        aria-haspopup="dialog"
        aria-label={t`Runs and cost`}
        title={t`Runs and cost`}
        onClick={() => setOpen(true)}
        className="size-9 shrink-0 rounded-xl text-brand-muted"
      >
        <ChartColumn size={18} aria-hidden />
      </Button>
      <Link
        to="/{-$locale}/console/activity"
        params={{ locale: locale === 'en' ? undefined : locale }}
        aria-label={t`Ticket activity`}
        title={t`Ticket activity`}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-brand-muted outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        <ListTree size={18} aria-hidden />
      </Link>
      <NewTicketButton />
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t`Runs, cache hit and cost`}
      >
        <div className="px-3 pb-3">{band}</div>
      </Sheet>
    </div>
  )
}
