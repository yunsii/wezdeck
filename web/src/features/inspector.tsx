import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { Button } from '#/components/ui/button'

export type InspectorItem = {
  id: string
  name: string
  detail?: string
  status?: string
  tone?: 'running' | 'waiting' | 'done' | 'error' | 'muted'
}

export function Inspector({
  label,
  items,
  selected,
  onSelect,
  onActivate,
  onKey,
  toolbar,
  empty,
  reading,
}: {
  label: string
  items: InspectorItem[]
  selected: string
  onSelect: (id: string) => void
  onActivate?: (id: string) => void
  onKey?: (key: string, id: string) => void
  toolbar?: React.ReactNode
  empty?: string
  reading: React.ReactNode
}) {
  function move(step: number) {
    const index = items.findIndex((item) => item.id === selected)
    if (index < 0) return
    for (
      let cursor = index + step;
      cursor >= 0 && cursor < items.length;
      cursor += step
    ) {
      const next = items.at(cursor)
      if (next && !next.id.startsWith('workspace-')) {
        onSelect(next.id)
        return
      }
    }
  }

  return (
    <div className="grid h-full min-h-0 overflow-hidden rounded-[16px] border border-brand-edge bg-brand-surface max-md:grid-cols-1 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-brand-border max-md:border-r-0 max-md:border-b">
        {toolbar ? (
          <div className="border-b border-brand-border p-3">{toolbar}</div>
        ) : null}
        {items.length === 0 ? (
          <p className="p-4 text-sm text-brand-muted">{empty}</p>
        ) : (
          <div
            role="listbox"
            aria-label={label}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'j') {
                event.preventDefault()
                move(1)
              } else if (event.key === 'ArrowUp' || event.key === 'k') {
                event.preventDefault()
                move(-1)
              } else if (event.key === 'Enter' && onActivate) {
                event.preventDefault()
                onActivate(selected)
              } else if (event.altKey && onKey && event.key.length === 1) {
                event.preventDefault()
                onKey(event.key.toLowerCase(), selected)
              }
            }}
          >
            {items.map((item) => {
              const active = item.id === selected
              return (
                <Button
                  variant="plain"
                  key={item.id}
                  id={`inspector-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={cn(
                    'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-brand-border px-3 py-2.5 text-left text-sm',
                    active
                      ? 'bg-brand-deck text-brand-text shadow-[inset_3px_0_0_var(--brand-running)]'
                      : 'text-brand-muted hover:bg-brand-soft/70',
                  )}
                  disabled={item.id.startsWith('workspace-')}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="row-span-2 self-start pt-1">
                    <Led tone={item.tone ?? 'muted'} size={11} />
                  </span>
                  <span className="min-w-0 truncate">{item.name}</span>
                  {item.status ? (
                    <span className="max-w-24 truncate font-mono text-xs text-brand-label">
                      {item.status}
                    </span>
                  ) : (
                    <span />
                  )}
                  {item.detail ? (
                    <span className="col-start-2 truncate text-xs text-brand-label">
                      {item.detail}
                    </span>
                  ) : null}
                </Button>
              )
            })}
          </div>
        )}
      </div>
      <div className="min-w-0 p-5">{reading}</div>
    </div>
  )
}

export function Reading({
  kicker,
  title,
  body,
  facts,
  children,
}: {
  kicker?: React.ReactNode
  title: string
  body?: string
  /** wide: the fact takes the whole row and may wrap (a repo route) */
  facts?: Array<{ label: string; value: React.ReactNode; wide?: boolean }>
  children?: React.ReactNode
}) {
  // empty facts say nothing; an odd one out spans the row instead of
  // leaving a blank grey cell beside it
  const shownFacts = (facts ?? []).filter((fact) => fact.value !== '—')
  const halves = shownFacts.filter((fact) => !fact.wide)
  const lonely = halves.length % 2 ? halves.at(-1) : undefined
  return (
    <div className="grid content-start gap-4">
      {kicker ? <div className="text-sm">{kicker}</div> : null}
      <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-balance text-brand-text md:text-2xl">
        {title}
      </h1>
      {body ? (
        <p className="max-w-prose text-sm leading-6 text-brand-muted">{body}</p>
      ) : null}
      {shownFacts.length ? (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-brand-edge bg-brand-edge">
          {shownFacts.map((fact) => (
            <div
              key={fact.label}
              className={cn(
                'bg-brand-key px-3 py-2.5',
                (fact.wide || fact === lonely) && 'col-span-2',
              )}
            >
              <dt className="text-xs text-brand-label">{fact.label}</dt>
              <dd
                className={cn(
                  'mt-1 text-sm text-brand-text',
                  fact.wide ? 'break-words' : 'truncate',
                )}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </div>
  )
}
