// Every keyboard shortcut of the console in one list, shown by `?` and the
// sidebar's 快捷键 entry (desktop). The listeners stay with their pages
// (console-jump-keys.ts, session-split.tsx, session-switcher.tsx,
// session-new.tsx, composer-keys.ts, …); a key added there is added here
// too. `host` names the desk's key for the same thing (wezterm-x/commands/
// manifest.json), so the two keyboards read as one.
import { useLingui } from '@lingui/react/macro'
import { Keyboard } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useConsoleMode } from './console-mode'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'

/** host: true when the desk uses the same keys, else the desk's keys */
type Key = { keys: Array<string>; what: string; host?: true | string }
type Group = { title: string; items: Array<Key> }

function useKeyGroups(): Array<Group> {
  const { t } = useLingui()
  // `o` reaches the loopback Runtime (session-focus.tsx): this computer only
  const local = useConsoleMode() === 'local'
  return [
    {
      title: t`Anywhere`,
      items: [
        {
          keys: ['g', t`letter`],
          what: t`Go to a section: s Sessions, c Tickets, a Activity, x Diagnostics, m Me`,
        },
        { keys: ['/'], what: t`Search or filter the list` },
        { keys: ['?'], what: t`This list of shortcuts` },
        {
          keys: ['Esc'],
          what: t`Close a sheet, or let go of a focused button`,
        },
      ],
    },
    {
      title: t`Session pages`,
      items: [
        { keys: ['j', 'k'], what: t`Next / previous session in the list` },
        { keys: ['y'], what: t`Copy the open session's reference` },
        {
          keys: ['l'],
          what: t`Repository links (GitHub / CNB and project links)`,
          host: 'Ctrl+K l',
        },
        ...(local
          ? [
              {
                keys: ['o'],
                what: t`Open in terminal: switch WezTerm to this session's tmux window`,
                host: 'Alt+/ Enter',
              },
            ]
          : []),
        {
          keys: ['Alt+J'],
          what: t`Next session waiting on you`,
          host: true,
        },
        { keys: ['Alt+K'], what: t`Next finished session`, host: true },
        {
          keys: ['Alt+L', 'Alt+Shift+L'],
          what: t`Next / previous running session`,
          host: true,
        },
        {
          keys: ['Alt+G', 'Alt+X', 'Alt+/'],
          what: t`Focus session search or return to list`,
          host: true,
        },
        {
          keys: ['Ctrl+N'],
          what: t`Start /new in the current agent`,
        },
        {
          keys: ['Ctrl+Shift+N'],
          what: t`Start a blank agent process in this pane`,
        },
        {
          keys: ['Alt+F5'],
          what: t`Restart the agent and resume this conversation`,
          host: 'F5',
        },
        {
          keys: ['c'],
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
        { keys: ['y'], what: t`Copy the open ticket's reference` },
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

/**
 * Esc lets go of a focused button or link (no sheet open): closing a sheet
 * hands focus back to what opened it, which then stayed lit and kept Space
 * (it pressed the button again) from reaching the composer.
 */
function useEscBlur() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role=dialog], [role=alertdialog]')) return
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !active.closest('input, textarea, select, [contenteditable="true"]')
      )
        active.blur()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
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
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
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

/** the desk's keys: a small tag when they are the same, else the keys */
function HostKey({ host }: { host: true | string }) {
  const { t } = useLingui()
  if (host === true)
    return (
      <span className="rounded-full bg-brand-soft px-1.5 py-px text-meta whitespace-nowrap text-brand-label">
        {t`Same at the desk`}
      </span>
    )
  return (
    <span className="text-meta text-brand-label">
      {t`At the desk: ${host}`}
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
      className="md:max-w-4xl"
    >
      <div className="grid gap-4 px-4">
        <p className="text-meta text-brand-label">
          {t`Letter keys work when the caret is not in a text box. Chrome may keep Ctrl+N for a new window; c does the same.`}
        </p>
        {/* two columns on a desk-sized window: the whole list without scrolling */}
        <div className="gap-4 md:columns-2">
          {groups.map((group) => (
            <section
              key={group.title}
              className="mb-4 grid break-inside-avoid gap-1.5 last:mb-0"
            >
              {/* stays on top while its group scrolls under it (phone) */}
              <h3 className="sticky top-0 z-10 bg-brand-deck px-1 py-1 text-caption font-semibold text-brand-muted">
                {group.title}
              </h3>
              <ul className="overflow-hidden rounded-xl bg-brand-surface">
                {group.items.map((item) => (
                  <li
                    key={item.what}
                    className="flex items-center gap-3 border-b border-brand-edge px-3 py-2 last:border-b-0"
                  >
                    <span className="grid min-w-0 flex-1 justify-items-start gap-0.5">
                      <span className="text-body">{item.what}</span>
                      {item.host ? <HostKey host={item.host} /> : null}
                    </span>
                    <Keys keys={item.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
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
  useEscBlur()
  return (
    <>
      <Button
        variant="plain"
        size="none"
        type="button"
        onClick={show}
        data-testid="keys-entry"
        title={`${t`Keyboard shortcuts`} (?)`}
        aria-label={t`Keyboard shortcuts`}
        className="flex min-h-11 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-1.5 text-center text-brand-muted transition-colors outline-none hover:bg-brand-soft hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        <Keyboard size={18} aria-hidden />
        <span className="max-w-full truncate text-meta leading-tight">
          {t`Shortcuts`}
        </span>
      </Button>
      <KeysSheet open={open} onOpenChange={setOpen} />
    </>
  )
}
