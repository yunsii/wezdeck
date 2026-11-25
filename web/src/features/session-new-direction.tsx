// 新会话's first choice: the direction (native workstations.go). Each
// direction says whether one of its workstations is idle — then the new
// session reuses it: same directory, branch and purpose, reset onto the
// latest main branch with a blank agent — or, when all are busy, that one
// more parallel workstation will be opened. The last row starts a new
// direction (name + purpose).
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'

import { Button } from '#/components/ui/button'
import { hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'

export type Slot = {
  path: string
  name: string
  branch: string
  state: string
  reason?: string
  visited?: number
}
export type Direction = {
  name: string
  description?: string
  idle: number
  visited?: number
  slots: Array<Slot>
}

/** '' = a new direction */
export type DirectionPick = string

export function useDirections(repo: string) {
  return useQuery({
    queryKey: ['remote', 'workstations', repo],
    enabled: Boolean(repo),
    queryFn: async () =>
      (await hostRead('workstations', { repo })) as {
        directions: Array<Direction>
      },
  })
}

/** the default: the latest-visited direction with an idle workstation */
export const defaultDirection = (dirs: Array<Direction> = []): DirectionPick =>
  dirs.find((d) => d.idle > 0)?.name ?? ''

function useStateText() {
  const { t } = useLingui()
  return (d: Direction) => {
    const count = d.slots.length
    if (d.idle > 0) return count > 1 ? t`idle · ${count} workstations` : t`idle`
    const why: Record<string, string> = {
      running: t`running`,
      waiting: t`waiting for you`,
      dirty: t`uncommitted changes`,
      undelivered: t`commits not in main yet`,
    }
    const state = d.slots[0]?.state ?? ''
    const reason = why[state] ?? state
    return t`${reason} · opens one more`
  }
}

export function DirectionPicker({
  directions,
  value,
  onChange,
  disabled,
}: {
  directions: Array<Direction>
  value: DirectionPick
  onChange: (next: DirectionPick) => void
  disabled?: boolean
}) {
  const { t } = useLingui()
  const stateText = useStateText()
  const row = (
    key: string,
    selected: boolean,
    body: React.ReactNode,
    pick: DirectionPick,
  ) => (
    <Button
      key={key}
      variant="plain"
      size="none"
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      data-direction={key}
      onClick={() => onChange(pick)}
      className={cn(
        'flex w-full min-w-0 items-baseline gap-2 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
        selected ? 'bg-brand-surface text-brand-text' : 'text-brand-muted',
      )}
    >
      <span aria-hidden className="shrink-0">
        {selected ? '●' : '○'}
      </span>
      {body}
    </Button>
  )
  return (
    <div
      role="radiogroup"
      aria-label={t`Direction`}
      className="grid gap-0.5"
      data-testid="new-session-directions"
    >
      {directions.map((d) =>
        row(
          d.name,
          value === d.name,
          <>
            <span className="shrink-0 font-medium">{d.name}</span>
            {d.description ? (
              <span className="min-w-0 truncate text-meta">
                {d.description}
              </span>
            ) : null}
            <span
              className={cn(
                'ml-auto shrink-0 text-meta',
                d.idle > 0 ? 'text-brand-running' : 'text-brand-label',
              )}
              data-testid="direction-state"
            >
              {stateText(d)}
            </span>
          </>,
          d.name,
        ),
      )}
      {row(
        '+new',
        value === '',
        <span className="font-medium">{t`+ New direction`}</span>,
        '',
      )}
    </div>
  )
}

/** what creating will do, for the line under the picker */
export function useDirectionPlan() {
  const { t } = useLingui()
  return (d: Direction | undefined) => {
    if (!d) return ''
    const slot = d.slots.find((s) => s.state === 'idle')?.name
    const direction = d.name
    return slot
      ? t`Reuses ${slot}: reset onto the latest main branch, a blank agent (the last conversation stays resumable).`
      : t`Every ${direction} workstation is busy: opens one more in parallel, with the same purpose.`
  }
}
