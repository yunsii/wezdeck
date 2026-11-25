// Top of a session page, pinned while the thread scrolls under it: back,
// which session this is (the title) and whether it needs you. The model,
// context, limits, branch, git and background tasks moved to the status bars
// under the composer (session-statusbar.tsx). The header's height is shared
// as --session-head so the sticky prompt (chat-sticky.tsx) sits under it.
import { useLingui } from '@lingui/react/macro'
import { ChevronDown, Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BackButton } from '#/components/deck/back-button'

import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { useStatusText } from './console-sessions'
import type { Detail } from './console-sessions'
import { SessionInfo } from './session-info'
import {
  NextWaitingChip,
  SessionSwitcher,
  useSessionKeys,
  useSessionNav,
} from './session-switcher'
import { Button } from '#/components/ui/button'

export function SessionHeader({
  id,
  data,
  onBack,
  onRename,
  renameDisabled,
}: {
  id: string
  data: Detail | undefined
  onBack: () => void
  /** Paste `/rename <title>` into the agent TUI (Claude and Grok both honor it). */
  onRename?: (title: string) => void
  renameDisabled?: boolean
}) {
  const { t } = useLingui()
  const statusText = useStatusText()
  const [infoOpen, setInfoOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const openSwitcher = useCallback(() => setSwitcherOpen(true), [])
  const nav = useSessionNav(id)
  useSessionKeys(nav.jump, openSwitcher)
  const head = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = head.current
    const page = document.getElementById('console-main')
    if (!el || !page || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const observer = new ResizeObserver(() => {
      page.style.setProperty('--session-head', `${el.offsetHeight}px`)
      // toasts drop in under this bar, not over its back button (pwa-boot)
      root.style.setProperty(
        '--toast-top',
        `${Math.round(el.getBoundingClientRect().bottom)}px`,
      )
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      page.style.removeProperty('--session-head')
      root.style.removeProperty('--toast-top')
    }
  }, [])
  const title = data ? data.title || t`Untitled session` : ''
  // the page shows running (the working line) and done (the reply) by itself;
  // the header only speaks up when the agent needs the human
  const long = data
    ? statusText(
        data.status,
        data.waiting_kind,
        data.running_kind,
        data.background?.length ?? 0,
      )
    : undefined
  return (
    <header
      ref={head}
      data-testid="session-header"
      className="sticky top-[env(safe-area-inset-top)] z-30 -mx-2.5 -mt-1 grid gap-1.5 border-b border-brand-edge bg-brand-deck/95 px-2.5 pt-1 pb-2 backdrop-blur"
    >
      <div className="flex min-w-0 items-center gap-1">
        {/* the list sits beside the conversation on a wide screen */}
        <BackButton
          onClick={onBack}
          label={t({ message: 'Sessions', context: 'nav' })}
          className="-ml-2 md:hidden"
        />
        <div className="grid min-w-0 flex-1">
          {/* Alt+g / Alt+x at the desk: pick another session */}
          <Button
            variant="plain"
            type="button"
            onClick={openSwitcher}
            aria-haspopup="dialog"
            data-testid="session-title"
            data-session-id={data?.id}
            title={t`Switch session (Alt+g)`}
            className="flex min-w-0 items-center gap-1 text-left text-title leading-tight font-semibold"
          >
            <span
              className={cn(
                'truncate',
                data && !data.title && 'text-brand-label',
              )}
            >
              {title || t`Loading…`}
            </span>
            <ChevronDown
              size={15}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
          </Button>
          {/* agent, branch, git, node, worktrees and background tasks
              live in the status bar under the composer (session-statusbar) */}
        </div>
        {data?.waiting_kind ? (
          <span
            title={long}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-waiting/15 px-2 py-0.5 text-caption text-brand-text"
          >
            <Led tone="waiting" size={10} />
            {t`Needs you`}
          </span>
        ) : (
          <NextWaitingChip
            count={nav.otherWaiting.length}
            onNext={() => nav.jump('waiting')}
          />
        )}
        {data ? (
          <Button
            variant="plain"
            type="button"
            onClick={() => setInfoOpen(true)}
            aria-label={t`Session info`}
            aria-haspopup="dialog"
            data-testid="session-info-button"
            className="-mr-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-brand-muted"
          >
            <Info size={19} aria-hidden />
          </Button>
        ) : null}
      </div>
      {/* model, ctx, limits and background tasks: the agent status bar
          under the composer (session-statusbar.tsx) */}
      {data ? (
        <SessionInfo
          data={data}
          open={infoOpen}
          onClose={() => setInfoOpen(false)}
          onRename={onRename}
          renameDisabled={renameDisabled}
        />
      ) : null}
      <SessionSwitcher
        current={id}
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
      />
    </header>
  )
}
