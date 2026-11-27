// Claude slash commands from the phone: the composer's 命令 Sheet (the
// common ones, sent as the TUI would take them) and 恢复会话, a list of the
// project's earlier conversations — Claude's own /resume picker is a TUI
// list a phone cannot drive. Picking one sends `/resume <id>`; the
// SessionStart resume hook marks this session cleared_to that one and the
// page follows (session-send.ts useFollowReplacement). Everything comes from
// transcripts and hooks (native/wezdeck-wsl/session_history.go), nothing is
// read off the screen.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import type { Outgoing } from './session-composer'

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

/**
 * `/new` / `/clear` with text after it: Claude names the new session with that
 * text, and the name then rides every later /clear in the pane, so Claude never
 * generates a title again. The composer asks before sending one.
 */
export const namedClear = (text: string) =>
  /^\/(new|clear)\s+(\S[\s\S]*)$/i.exec(text.trim())?.[2]?.trim() ?? ''

/**
 * The 恢复会话 sheet, and `onSend` for the composer: a bare /resume opens the
 * sheet instead of the TUI picker; a Claude /new or /clear with text asks first.
 */
export function useResumeSheet(
  id: string,
  send: (message: Outgoing) => Promise<boolean>,
  agent?: string,
) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const onSend = (message: Outgoing) => {
    if (isBareResume(message.text)) {
      setOpen(true)
      return Promise.resolve(true)
    }
    const name = agent === 'claude' ? namedClear(message.text) : ''
    if (
      name &&
      !window.confirm(
        t`The text after the command becomes the new session's name ("${name}"), carried across every later /clear, and Claude stops generating titles. Send anyway?`,
      )
    )
      return Promise.resolve(false)
    return send(message)
  }
  return {
    onSend,
    open: () => setOpen(true),
    element: (
      <ResumeSheet
        id={id}
        open={open}
        onOpenChange={setOpen}
        onPick={(target) => {
          setOpen(false)
          void send({ text: `/resume ${target}`, attachments: [], note: '' })
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
      <p className="px-1 pb-2 text-caption text-brand-label">
        {t`Earlier conversations of this project. The pane switches to the one you pick; this page follows.`}
      </p>
      {history.isPending ? (
        <p className="py-6 text-center text-caption text-brand-muted">{t`Loading…`}</p>
      ) : history.isError ? (
        <p className="py-6 text-center text-body text-brand-error">
          {history.error.message}
        </p>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-caption text-brand-muted">
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
                className="grid w-full gap-0.5 rounded-xl bg-brand-surface px-3.5 py-2.5 text-left disabled:opacity-50"
              >
                <span className="flex min-w-0 items-baseline justify-between gap-3">
                  <span
                    className={cn(
                      'truncate text-body font-medium',
                      !item.title && 'text-brand-label',
                    )}
                  >
                    {item.title || t`Untitled session`}
                  </span>
                  <span className="shrink-0 text-meta text-brand-label">
                    {item.open ? t`open in a pane` : ago(item.at)}
                  </span>
                </span>
                {item.prompt ? (
                  <span className="line-clamp-2 text-caption text-brand-muted">
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
  open,
  agent,
  disabled,
  onCommand,
  onDraft,
  onResume,
  onClose,
}: {
  open: boolean
  agent?: string
  disabled: boolean
  onCommand: (text: string) => void
  /** put text in the composer to add to before sending */
  onDraft: (text: string) => void
  onResume: () => void
  onClose: () => void
}) {
  const { t } = useLingui()
  const isAgy = agent === 'agy'
  const commands: Array<{ label: string; hint: string; run: () => void }> =
    isAgy
      ? [
          {
            label: '/compact',
            hint: t`summarise the context`,
            run: () => onCommand('/compact'),
          },
          {
            label: '/new',
            hint: t`start a fresh conversation`,
            run: () => onCommand('/new'),
          },
          {
            label: '/plan …',
            hint: t`outline a plan before editing`,
            run: () => onDraft('/plan '),
          },
          {
            label: '/config',
            hint: t`agent settings and execution mode`,
            run: () => onCommand('/config'),
          },
          {
            label: '/permissions',
            hint: t`manage tool permission rules`,
            run: () => onCommand('/permissions'),
          },
          {
            label: '/model',
            hint: t`switch the model`,
            run: () => onDraft('/model '),
          },
        ]
      : [
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
  const models = isAgy ? [] : ['opus', 'sonnet', 'haiku', 'default']
  const key =
    'grid h-12 place-content-center gap-0.5 rounded-xl px-1 disabled:opacity-40'
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={isAgy ? t`Antigravity commands` : t`Claude commands`}
      testId="session-commands-sheet"
      write
    >
      <div className="grid gap-3 px-4">
        <p className="text-meta text-brand-label">
          {disabled
            ? t`Turn on write access in Settings to send commands`
            : isAgy
              ? t`Antigravity commands, sent into the pane`
              : t`Claude commands, sent into the pane`}
        </p>
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
              title={command.label === '/new' ? 'Ctrl/⌘+N' : undefined}
              aria-keyshortcuts={
                command.label === '/new' ? 'Control+N Meta+N' : undefined
              }
              onClick={() => {
                command.run()
                onClose()
              }}
              className={key}
            >
              <span className="font-mono text-caption leading-none">
                {command.label}
              </span>
              <span className="text-meta leading-none text-brand-label">
                {command.hint}
              </span>
            </Button>
          ))}
        </div>
        {models.length ? (
          <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
            <span className="text-meta text-brand-label">/model</span>
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
                className={cn('h-8 rounded-full px-3 font-mono text-caption')}
              >
                {model}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </Sheet>
  )
}
