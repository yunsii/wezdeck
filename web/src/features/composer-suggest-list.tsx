// Floating suggestion list above the session composer for `#` repo ticket
// mentions and host-backed sent-history autocomplete (reuses `.composer-picker`).
import { useLingui } from '@lingui/react/macro'
import { History, ImageIcon, Ticket } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import type { SentSuggestion, TicketSuggestion } from './composer-suggest'

function compactTime(ms: number) {
  const date = new Date(ms)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

export function TicketSuggestList({
  items,
  active,
  onPick,
  onHover,
}: {
  items: Array<TicketSuggestion>
  active: number
  onPick: (item: TicketSuggestion) => void
  onHover: (index: number) => void
}) {
  const { t } = useLingui()
  return (
    <div
      role="listbox"
      id="composer-suggestions"
      aria-label={t`Repo tickets`}
      data-testid="composer-ticket-suggestions"
      className="composer-picker grid max-h-64 gap-0.5 overflow-y-auto bg-brand-surface p-1.5"
    >
      {items.map((item, index) => (
        <Button
          variant="plain"
          size="none"
          key={item.id}
          id={`composer-suggestion-${index}`}
          role="option"
          type="button"
          aria-selected={index === active}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(item)}
          className={cn(
            'grid min-h-10 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2.5 py-1.5 text-left',
            index === active ? 'bg-brand-soft' : 'hover:bg-brand-soft/60',
          )}
        >
          <Ticket size={14} aria-hidden className="shrink-0 text-brand-muted" />
          <span className="grid min-w-0">
            <span className="truncate text-caption font-medium text-brand-text">
              {item.title}
            </span>
            <span className="truncate font-mono text-meta text-brand-label">
              {item.id}
            </span>
          </span>
          {item.attachmentsCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-meta text-brand-label">
              <ImageIcon size={12} aria-hidden />
              {item.attachmentsCount}
            </span>
          ) : null}
        </Button>
      ))}
    </div>
  )
}

export function SentSuggestList({
  items,
  active,
  onPick,
  onHover,
}: {
  items: Array<SentSuggestion>
  active: number
  onPick: (item: SentSuggestion) => void
  onHover: (index: number) => void
}) {
  const { t } = useLingui()
  return (
    <div
      role="listbox"
      id="composer-suggestions"
      aria-label={t`Recent sent messages`}
      data-testid="composer-sent-suggestions"
      className="composer-picker grid max-h-56 gap-0.5 overflow-y-auto bg-brand-surface p-1.5"
    >
      {items.map((item, index) => {
        const oneLine = item.text.replace(/\s+/g, ' ').trim()
        const attCount = item.attachments.length
        return (
          <Button
            variant="plain"
            size="none"
            key={item.id}
            id={`composer-suggestion-${index}`}
            role="option"
            type="button"
            aria-selected={index === active}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(item)}
            className={cn(
              'grid min-h-9 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2.5 py-1.5 text-left',
              index === active ? 'bg-brand-soft' : 'hover:bg-brand-soft/60',
            )}
          >
            <History
              size={13}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
            <span className="truncate text-caption text-brand-text">
              {oneLine}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-meta text-brand-label tabular-nums">
              {attCount > 0 ? (
                <span className="inline-flex items-center gap-0.5">
                  <ImageIcon size={11} aria-hidden />
                  {attCount}
                </span>
              ) : null}
              {active < 0 && index === 0 ? (
                <kbd className="hidden rounded border border-brand-border bg-brand-deck px-1 py-px font-mono text-meta md:inline">
                  Tab
                </kbd>
              ) : (
                <span>{compactTime(item.createdAt)}</span>
              )}
            </span>
          </Button>
        )
      })}
    </div>
  )
}
