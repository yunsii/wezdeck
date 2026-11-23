// Claude slash commands from the phone: the composer's 命令 panel (the
// common ones, sent as the TUI would take them) and 恢复会话, a list of the
// project's earlier conversations — Claude's own /resume picker is a TUI
// list a phone cannot drive. Picking one sends `/resume <id>`; the
// SessionStart resume hook marks this session cleared_to that one and the
// page follows (session-send.ts useFollowReplacement). Everything comes from
// transcripts and hooks (native/wezdeck-wsl/session_history.go), nothing is
// read off the screen.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'

type HistoryItem = {
  id: string
  title?: string
  prompt?: string
  at: number
  open?: boolean
}

/** the bare `/resume` (no session named): the sheet, not the TUI picker */
export const isBareResume = (text: string) =>
  /^\/(resume|continue)$/i.test(text.trim())

export function useResumeSheet(
  id: string,
  send: (text: string) => Promise<boolean>,
) {
  const [open, setOpen] = useState(false)
  return {
    open: () => setOpen(true),
    element: (
      <ResumeSheet
        id={id}
        open={open}
        onOpenChange={setOpen}
        onPick={(target) => {
          setOpen(false)
          void send(`/resume ${target}`)
        }}
      />
    ),
  }
}

function useAgo() {
  const { t } = useLingui()
  return (ms: number) => {
    const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000))
    if (minutes < 1) return t`just now`
    if (minutes < 60) return t`${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return t`${hours} h ago`
    const days = Math.round(hours / 24)
    return t`${days} d ago`
  }
}

function ResumeSheet({
  id,
  open,
  onOpenChange,
  onPick,
}: {
  id: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (id: string) => void
}) {
  const { t } = useLingui()
  const ago = useAgo()
  const history = useQuery({
    queryKey: ['remote', 'session-history', id],
    enabled: open,
    staleTime: 10_000,
    queryFn: async () =>
      (
        (await hostRead('session.history', { id })) as {
          sessions: Array<HistoryItem>
        }
      ).sessions,
  })
  const items = history.data ?? []
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t`Resume a conversation`}
      testId="resume-sheet"
      write
    >
      <p className="px-1 pb-2 text-[12.5px] text-brand-label">
        {t`Earlier conversations of this project. The pane switches to the one you pick; this page follows.`}
      </p>
      {history.isPending ? (
        <p className="py-6 text-center text-sm text-brand-muted">{t`Loading…`}</p>
      ) : history.isError ? (
        <p className="py-6 text-center text-sm text-brand-error">
          {history.error.message}
        </p>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-brand-muted">
          {t`No earlier conversations in this project`}
        </p>
      ) : (
        <ul className="grid gap-1.5 pb-2">
          {items.map((item) => (
            <li key={item.id}>
              <Button
                variant="plain"
                type="button"
                disabled={item.open}
                data-resume={item.id}
                onClick={() => onPick(item.id)}
                className="grid w-full gap-0.5 rounded-[14px] bg-brand-surface px-3.5 py-2.5 text-left disabled:opacity-50"
              >
                <span className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="truncate text-[15px] font-medium">
                    {item.title || item.prompt || item.id.slice(0, 8)}
                  </span>
                  <span className="shrink-0 text-xs text-brand-label">
                    {item.open ? t`open in a pane` : ago(item.at)}
                  </span>
                </span>
                {item.title && item.prompt ? (
                  <span className="line-clamp-2 text-[13px] text-brand-muted">
                    {item.prompt}
                  </span>
                ) : null}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

/**
 * The common Claude commands as taps. Each is sent as typed would be; the
 * ones that print (/context, /usage, /model) show their output in the
 * conversation as a command row (chat-command.tsx).
 */
export function CommandPanel({
  disabled,
  onCommand,
  onDraft,
  onResume,
  onClose,
}: {
  disabled: boolean
  onCommand: (text: string) => void
  /** put text in the composer to add to before sending */
  onDraft: (text: string) => void
  onResume: () => void
  onClose: () => void
}) {
  const { t } = useLingui()
  const commands: Array<{ label: string; hint: string; run: () => void }> = [
    {
      label: '/compact',
      hint: t`summarise the context`,
      run: () => onCommand('/compact'),
    },
    {
      label: '/compact …',
      hint: t`with what to keep`,
      run: () => onDraft('/compact '),
    },
    {
      label: '/new',
      hint: t`start a fresh conversation`,
      run: () => onCommand('/new'),
    },
    { label: '/resume', hint: t`pick an earlier one`, run: onResume },
    {
      label: '/context',
      hint: t`context usage`,
      run: () => onCommand('/context'),
    },
    {
      label: '/usage',
      hint: t`cost and limits`,
      run: () => onCommand('/usage'),
    },
  ]
  const models = ['opus', 'sonnet', 'haiku', 'default']
  const key =
    'grid h-12 place-content-center gap-0.5 rounded-[10px] px-1 disabled:opacity-40'
  return (
    <div
      data-write
      className="grid gap-1.5 rounded-[16px] bg-brand-surface p-2"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[11.5px] text-brand-label">
          {disabled
            ? t`Turn on write access in Settings to send commands`
            : t`Claude commands, sent into the pane`}
        </span>
        <Button
          variant="plain"
          type="button"
          onClick={onClose}
          aria-label={t`Close commands`}
          className="inline-flex size-7 items-center justify-center rounded-full text-brand-muted"
        >
          <X size={14} aria-hidden />
        </Button>
      </div>
      <div
        role="group"
        aria-label={t`Commands`}
        data-testid="session-commands"
        className="grid grid-cols-3 gap-1.5"
      >
        {commands.map((command) => (
          <Button
            variant="key"
            key={command.label}
            type="button"
            disabled={disabled}
            onClick={() => {
              command.run()
              onClose()
            }}
            className={key}
          >
            <span className="font-mono text-[13.5px] leading-none">
              {command.label}
            </span>
            <span className="text-[11px] leading-none text-brand-label">
              {command.hint}
            </span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
        <span className="text-[11.5px] text-brand-label">/model</span>
        {models.map((model) => (
          <Button
            variant="key"
            key={model}
            type="button"
            disabled={disabled}
            onClick={() => {
              onCommand(`/model ${model}`)
              onClose()
            }}
            className={cn('h-8 rounded-full px-3 font-mono text-[12.5px]')}
          >
            {model}
          </Button>
        ))}
      </div>
    </div>
  )
}
