// 工单's search, split out of the list: the field (always shown on a wide
// screen, opened from an icon on a phone) and the phone's list actions — the
// search toggle and 新建 — which sit in the page head's link row
// (collab-top-bar) so the status filter has a row of its own on a narrow
// screen: four counted segments + two buttons ran past a 360 px phone.
import { useLingui } from '@lingui/react/macro'
import { Search } from 'lucide-react'

import { NewTicketButton } from './ticket-new'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

export function TicketListActions({
  searching,
  onSearching,
}: {
  searching: boolean
  onSearching: (next: boolean) => void
}) {
  const { t } = useLingui()
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        type="button"
        aria-label={t`Filter tickets`}
        aria-pressed={searching}
        onClick={() => onSearching(!searching)}
        className="size-11 shrink-0 rounded-xl"
      >
        <Search size={18} aria-hidden />
      </Button>
      <NewTicketButton />
    </>
  )
}

export function SearchBox({
  value,
  onChange,
  autoFocus = false,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  const { t } = useLingui()
  return (
    <label
      data-text-field
      className="flex min-h-11 flex-1 items-center gap-2 rounded-xl bg-brand-deck px-3 text-body md:min-h-9 md:text-body"
    >
      <Search size={15} aria-hidden className="text-brand-label" />
      <Input
        variant="bare"
        data-search
        autoFocus={autoFocus}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t`Filter by title, repo or id`}
        aria-label={t`Filter tickets`}
        className="min-w-0 flex-1 bg-transparent py-1.5 outline-none placeholder:text-brand-label"
      />
    </label>
  )
}
