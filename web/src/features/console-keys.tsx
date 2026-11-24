// Every keyboard shortcut of the console in one list, shown by `?` and the
// sidebar's 快捷键 entry (desktop). The listeners stay with their pages
// (console-jump-keys.ts, session-split.tsx, session-switcher.tsx,
// session-new.tsx, composer-keys.ts, …); a key added there is added here
// too. `host` names the desk's key for the same thing (wezterm-x/commands/
// manifest.json), so the two keyboards read as one.
import { useLingui } from '@lingui/react/macro'
import { Keyboard } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'

type Key = { keys: Array<string>; what: string; host?: string }
type Group = { title: string; items: Array<Key> }

function useKeyGroups(): Array<Group> {
  const { t } = useLingui()
  return [
    {
      title: t`Anywhere`,
      items: [
        {
          keys: ['g s', 'g c', 'g a', 'g x', 'g m'],
          what: t`Go to Sessions / Tickets / Activity / Diagnostics / Me`,
        },
        { keys: ['/'], what: t`Search or filter the list` },
        { keys: ['?'], what: t`This list of shortcuts` },
        { keys: ['Esc'], what: t`Close a sheet or dialog` },
      ],
    },
    {
      title: t`Session pages`,
      items: [
        { keys: ['j', 'k'], what: t`Next / previous session in the list` },
        {
          keys: ['Alt+J'],
          what: t`Next session waiting on you`,
          host: 'Alt+J',
        },
        { keys: ['Alt+K'], what: t`Next finished session`, host: 'Alt+K' },
        {
          keys: ['Alt+L', 'Alt+Shift+L'],
          what: t`Next / previous running session`,
          host: 'Alt+L / Alt+Shift+L',
        },
        {
          keys: ['Alt+G', 'Alt+X', 'Alt+/'],
          what: t`Pick a session (grouped by repository)`,
          host: 'Alt+G · Alt+/',
        },
        {
          keys: ['Ctrl+N', 'c'],
          what: t`New session (a worktree and an agent)`,
          host: 'Ctrl+K g d / t',
        },
      ],
    },
    {
      title: t`Composer`,
      items: [
        { keys: ['Space'], what: t`Put the caret in the composer` },
        { keys: ['Enter'], what: t`Send` },
        { keys: ['Shift+Enter'], what: t`New line` },
        {
          keys: ['Ctrl+Enter'],
          what: t`Send (also on a touch screen, where Enter is a new line)`,
        },
      ],
    },
    {
      title: t`Ticket pages`,
      items: [
        { keys: ['j', 'k'], what: t`Next / previous ticket` },
        { keys: ['n'], what: t`New ticket` },
      ],
    },
    {
      title: t`Image viewer`,
      items: [
        { keys: ['←', '→'], what: t`Previous / next image` },
        { keys: ['Esc'], what: t`Close the viewer` },
      ],
    },
  ]
}

/** `?` (not while typing) opens the list */
function useHelpKey(open: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== '?' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      event.preventDefault()
      open()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}

function Keys({ keys }: { keys: Array<string> }) {
  return (
    <span className="flex flex-wrap gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="rounded-md border border-brand-border bg-brand-deck px-1.5 py-0.5 font-mono text-meta text-brand-text"
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}

/** the desk's key for the same action */
function HostKey({ keys }: { keys: string }) {
  const { t } = useLingui()
  return (
    <span className="col-span-2 text-meta text-brand-label">
      {t`At the desk: ${keys}`}
    </span>
  )
}

function KeysSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useLingui()
  const groups = useKeyGroups()
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t`Keyboard shortcuts`}
      testId="keys-sheet"
    >
      <div className="grid gap-4">
        <p className="text-meta text-brand-label">
          {t`Letter keys work when no text box has the caret. "At the desk" is the same action in WezTerm on the host. Chrome may keep Ctrl+N for a new window; c does the same.`}
        </p>
        {groups.map((group) => (
          <section key={group.title} className="grid gap-1.5">
            <h3 className="text-caption font-semibold text-brand-muted">
              {group.title}
            </h3>
            <ul className="overflow-hidden rounded-xl bg-brand-surface">
              {group.items.map((item) => (
                <li
                  key={item.what}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-brand-edge px-3 py-2 last:border-b-0"
                >
                  <span className="text-body">{item.what}</span>
                  <Keys keys={item.keys} />
                  {item.host ? <HostKey keys={item.host} /> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  )
}

/**
 * The sidebar's 快捷键 row (wide screens) and the `?` key (anywhere, a
 * keyboard on a phone too): both open the list.
 */
export function KeysEntry() {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const show = useCallback(() => setOpen(true), [])
  useHelpKey(show)
  return (
    <>
      <Button
        variant="plain"
        type="button"
        onClick={show}
        data-testid="keys-entry"
        className="m-2.5 mt-auto flex min-h-9 items-center gap-2.5 rounded-xl px-3 text-body text-brand-muted outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        <Keyboard size={16} aria-hidden />
        <span className="flex-1 text-left">{t`Shortcuts`}</span>
        <kbd className="text-meta text-brand-label">?</kbd>
      </Button>
      <KeysSheet open={open} onOpenChange={setOpen} />
    </>
  )
}
