import { cn } from '#/lib/utils'

export type InspectorItem = {
  id: string
  name: string
  detail?: string
  status?: string
  tone?: 'running' | 'waiting' | 'done' | 'error' | 'muted'
}

const toneClass = {
  running: 'text-brand-running',
  waiting: 'text-brand-waiting',
  done: 'text-brand-done',
  error: 'text-brand-error',
  muted: 'text-brand-label',
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
    <div className="grid h-full min-h-0 border border-brand-border bg-brand-surface max-[899px]:grid-cols-1 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-brand-border max-[899px]:border-r-0 max-[899px]:border-b">
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
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                move(1)
              } else if (event.key === 'ArrowUp') {
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
                <button
                  key={item.id}
                  id={`inspector-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={cn(
                    'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-brand-border px-3 py-2.5 text-left text-sm',
                    active
                      ? 'bg-brand-soft text-brand-text'
                      : 'text-brand-muted hover:bg-brand-soft/70',
                  )}
                  disabled={item.id.startsWith('workspace-')}
                  onClick={() => onSelect(item.id)}
                >
                  <span
                    className={cn(
                      'row-span-2 size-1.5 shrink-0 rounded-full bg-current',
                      toneClass[item.tone ?? 'muted'],
                    )}
                  />
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
                </button>
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
  kicker?: string
  title: string
  body?: string
  facts?: Array<{ label: string; value: string }>
  children?: React.ReactNode
}) {
  return (
    <div className="grid content-start gap-4">
      {kicker ? (
        <p className="font-mono text-xs text-brand-running">{kicker}</p>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight text-brand-text">
        {title}
      </h1>
      {body ? (
        <p className="max-w-prose text-sm leading-6 text-brand-muted">{body}</p>
      ) : null}
      {facts?.length ? (
        <dl className="grid gap-px bg-brand-border sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="bg-brand-deck px-3 py-2">
              <dt className="text-xs text-brand-label">{fact.label}</dt>
              <dd className="mt-1 truncate font-mono text-sm text-brand-text">
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
