// A Claude / Agy / Codex / Grok permission prompt as a card (host
// permission.go / agent_agy_state.go): the call the agent is blocked on —
// complete summary, risk flags, and command / diff / write / structured args
// from the transcript, not the screen. Clicking Allow / Deny
// locks the card, shows immediate sending → waiting feedback
// (prompt-action-state.tsx), and clears once the host poll settles.
import { useLingui } from '@lingui/react/macro'
import { Copy, Maximize2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Sheet } from '#/components/ui/sheet'
import { cn } from '#/lib/utils'
import { ToolBody } from './chat-diff'
import { ChatMarkdown } from './chat-markdown'
import {
  PromptActionStatus,
  promptButtonClass,
  usePromptAction,
} from './prompt-action-state'
import type { PromptResolveFn } from './session-elicitation'

export type PermissionOption = {
  label: string
  kind: 'allow' | 'always' | 'deny'
  keys: Array<string>
}

export type PendingCall = {
  tool: string
  text: string
  summary?: string
  flags?: Array<string>
  body?: string
  file?: string
  plan?: boolean
  truncated?: boolean
  options?: Array<PermissionOption>
}

/** the keys each answer sends, also listed on the 交互调试 page */
export const PERMISSION_KEYS = { allow: '1', deny: 'Escape' } as const

/** Extract the rule scope from an Agy "Yes, and always allow ..." label. */
export function alwaysAllowScope(label: string): string {
  return label
    .trim()
    .replace(/^Yes,\s*(?:and\s+)?always allow\s*/i, '')
    .replace(/^Always allow\s*/i, '')
    .trim()
}

/** Send a multi-key permission sequence (e.g. Down → Enter), stopping on error. */
export async function sendPermissionKeys(
  keys: Array<string>,
  onKey: (key: string) => Promise<unknown> | void,
  settleMs = 60,
): Promise<boolean> {
  for (let i = 0; i < keys.length; i++) {
    if ((await onKey(keys[i])) === false) return false
    if (i < keys.length - 1 && settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs))
    }
  }
  return true
}

function FlagPills({ flags }: { flags?: Array<string> }) {
  const { t } = useLingui()
  if (!flags?.length) return null
  return (
    <>
      {flags.map((flag) => {
        const isRisk = flag === 'bypass-sandbox'
        const label =
          flag === 'bypass-sandbox'
            ? t`Bypass sandbox`
            : flag === 'daemon'
              ? t`Daemon`
              : flag === 'background'
                ? t`Background`
                : flag
        return (
          <span
            key={flag}
            data-permission-flag={flag}
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-meta font-medium',
              isRisk
                ? 'bg-brand-waiting/15 text-brand-waiting'
                : 'bg-brand-soft text-brand-muted',
            )}
          >
            {label}
          </span>
        )
      })}
    </>
  )
}

function PermissionDetailSheet({
  call,
  summary,
  open,
  onOpenChange,
  onCopy,
}: {
  call: PendingCall
  summary: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCopy: () => void
}) {
  const { t } = useLingui()
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      testId="permission-detail-sheet"
      title={call.tool}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <FlagPills flags={call.flags} />
          </div>
          {call.body ? (
            <Button
              variant="key"
              type="button"
              onClick={onCopy}
              className="inline-flex min-h-9 items-center gap-1.5 px-3 text-caption"
            >
              <Copy size={14} aria-hidden />
              {t`Copy`}
            </Button>
          ) : null}
        </div>
        {summary ? (
          <p
            className={cn(
              'min-w-0 text-caption leading-snug break-words whitespace-pre-wrap text-brand-text',
              call.file && summary.includes(call.file) && 'font-mono',
            )}
          >
            {summary}
          </p>
        ) : null}
        {call.plan ? (
          <div className="rounded-xl bg-brand-surface px-3 py-2">
            <ChatMarkdown text={call.body ?? ''} />
          </div>
        ) : call.body ? (
          <ToolBody
            text={call.body}
            file={call.file}
            className="max-h-none bg-brand-surface"
          />
        ) : null}
        {call.truncated ? (
          <p className="text-meta text-brand-label">
            {t`Truncated at 64 KB — check the terminal for the full payload.`}
          </p>
        ) : null}
      </div>
    </Sheet>
  )
}

function PermissionActions({
  isPlan,
  allowKeys,
  alwaysOptions,
  disabled,
  pending,
  run,
  onKey,
  promptKey,
  onResolve,
}: {
  isPlan: boolean
  allowKeys: Array<string>
  alwaysOptions: Array<PermissionOption>
  disabled: boolean
  pending: ReturnType<typeof usePromptAction>['pending']
  run: ReturnType<typeof usePromptAction>['run']
  onKey: (key: string) => Promise<unknown> | void
  promptKey: string
  onResolve?: PromptResolveFn
}) {
  const { t } = useLingui()
  const triggerAllow = () => {
    if (onResolve) {
      void onResolve({
        kind: 'prompt-submit',
        promptKey,
        execute: () => sendPermissionKeys(allowKeys, onKey),
      })
      return
    }
    void run('allow', () => sendPermissionKeys(allowKeys, onKey))
  }
  const triggerDeny = () => {
    if (onResolve) {
      void onResolve({
        kind: 'prompt-cancel',
        promptKey,
        execute: async () => (await onKey(PERMISSION_KEYS.deny)) !== false,
      })
      return
    }
    void run('deny', () => onKey(PERMISSION_KEYS.deny), { kind: 'cancel' })
  }
  const triggerAlways = (actionId: string, keys: Array<string>) => {
    if (onResolve) {
      void onResolve({
        kind: 'prompt-submit',
        promptKey,
        execute: () => sendPermissionKeys(keys, onKey),
      })
      return
    }
    void run(actionId, () => sendPermissionKeys(keys, onKey))
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="solid"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={triggerAllow}
          className={cn(
            'flex min-h-11 items-center justify-center px-3 text-body disabled:opacity-40',
            promptButtonClass(pending, 'allow', 'solid'),
          )}
        >
          {isPlan ? t`Approve the plan` : t`Allow`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={triggerDeny}
          className={cn(
            'flex min-h-11 items-center justify-center px-3 text-body disabled:opacity-40',
            promptButtonClass(pending, 'deny'),
          )}
        >
          {isPlan ? t`Keep planning` : t`Deny`}
        </Button>
      </div>
      {alwaysOptions.length > 0 ? (
        <div className="grid gap-1.5">
          {alwaysOptions.map((opt, idx) => {
            const scope = alwaysAllowScope(opt.label)
            const actionId = `always-${idx}`
            return (
              <Button
                key={`${idx}-${opt.label}`}
                variant="key"
                type="button"
                data-testid="permission-always"
                disabled={disabled || Boolean(pending)}
                onClick={() => triggerAlways(actionId, opt.keys)}
                className={cn(
                  'grid min-h-11 gap-0.5 px-3 py-2 text-left disabled:opacity-40',
                  promptButtonClass(pending, actionId),
                )}
              >
                <span className="text-body font-medium text-brand-text">
                  {t`Always allow`}
                </span>
                {scope ? (
                  <span className="font-mono text-meta leading-snug break-words text-brand-muted">
                    {scope}
                  </span>
                ) : null}
              </Button>
            )
          })}
        </div>
      ) : null}
    </>
  )
}

export function PermissionCard({
  agent,
  call,
  screen,
  disabled,
  onKey,
  promptKey: hostPromptKey,
  onResolve,
}: {
  agent?: string
  call: PendingCall
  screen?: string
  disabled: boolean
  onKey: (key: string) => Promise<unknown> | void
  promptKey?: string
  onResolve?: PromptResolveFn
}) {
  const { t } = useLingui()
  const [expanded, setExpanded] = useState(false)
  const isAgy = agent === 'agy'
  const options = call.options ?? []
  const allowOpt = options.find((opt) => opt.kind === 'allow')
  const alwaysOptions = call.plan
    ? []
    : options.filter((opt) => opt.kind === 'always' && opt.keys.length > 0)
  const allowKeys =
    allowOpt && allowOpt.keys.length > 0
      ? allowOpt.keys
      : [isAgy ? 'Enter' : PERMISSION_KEYS.allow]
  const promptKey =
    hostPromptKey ??
    `${agent ?? ''}:${call.tool}:${call.text}:${call.summary ?? ''}:${call.body ?? ''}`
  const { pending, run } = usePromptAction(promptKey)
  const fallbackTarget = call.text.startsWith(`${call.tool} `)
    ? call.text.slice(call.tool.length + 1)
    : ''
  const summary =
    call.summary !== undefined
      ? call.summary
      : fallbackTarget && fallbackTarget !== call.body
        ? fallbackTarget
        : ''
  const idleHint = call.plan
    ? t`Approve takes Claude's first option (its default edit mode). After keep planning, say in the box below what to change.`
    : isAgy
      ? alwaysOptions.length > 0
        ? t`Allow runs once; Always allow saves the shown rule; Deny sends Esc.`
        : t`Allow confirms the highlighted Yes option (Enter); Deny sends Esc. Persistent allow rules stay at the terminal.`
      : t`After deny, say in the box below what to do instead. "Don't ask again" and other options are at the desk.`

  const copyBody = () => {
    const text = call.body || summary
    if (!text) return
    void navigator.clipboard
      .writeText(text)
      .then(() => toast(t`Copied`))
      .catch(() => toast.error(t`Could not copy to clipboard`))
  }

  return (
    <div
      data-write
      data-testid="permission-card"
      aria-busy={Boolean(pending)}
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 rounded-2xl bg-brand-surface p-3',
        pending && 'pointer-events-none',
      )}
    >
      <p className="text-body font-medium">
        {call.plan
          ? t`Claude wants to leave plan mode and start on this plan`
          : isAgy
            ? t`Antigravity asks to run this`
            : t`Claude asks to run this`}
      </p>
      {call.plan ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-caption text-brand-label">
              {call.tool}
            </span>
            {call.body ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="plain"
                  type="button"
                  data-testid="permission-copy"
                  onClick={copyBody}
                  className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-meta text-brand-muted hover:bg-brand-soft hover:text-brand-text"
                >
                  <Copy size={13} aria-hidden />
                  {t`Copy`}
                </Button>
                <Button
                  variant="plain"
                  type="button"
                  data-testid="permission-expand"
                  onClick={() => setExpanded(true)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-meta text-brand-muted hover:bg-brand-soft hover:text-brand-text"
                >
                  <Maximize2 size={13} aria-hidden />
                  {t`Full view`}
                </Button>
              </div>
            ) : null}
          </div>
          <div
            data-testid="permission-body"
            className="max-h-[45dvh] overflow-hidden rounded-xl bg-brand-deck px-3 py-2"
          >
            <ChatMarkdown text={call.body ?? ''} />
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="shrink-0 font-mono text-caption text-brand-label">
                {call.tool}
              </span>
              <FlagPills flags={call.flags} />
            </div>
            {call.body ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="plain"
                  type="button"
                  data-testid="permission-copy"
                  onClick={copyBody}
                  className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-meta text-brand-muted hover:bg-brand-soft hover:text-brand-text"
                >
                  <Copy size={13} aria-hidden />
                  {t`Copy`}
                </Button>
                <Button
                  variant="plain"
                  type="button"
                  data-testid="permission-expand"
                  onClick={() => setExpanded(true)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-meta text-brand-muted hover:bg-brand-soft hover:text-brand-text"
                >
                  <Maximize2 size={13} aria-hidden />
                  {t`Full view`}
                </Button>
              </div>
            ) : null}
          </div>
          {summary ? (
            <p
              data-testid="permission-summary"
              className={cn(
                'min-w-0 text-caption leading-snug break-words whitespace-pre-wrap text-brand-text',
                call.file && summary.includes(call.file) && 'font-mono',
              )}
            >
              {summary}
            </p>
          ) : null}
          {call.body ? (
            <ToolBody
              testId="permission-body"
              text={call.body}
              file={call.file}
              scrollable={false}
              className="max-h-[45dvh]"
            />
          ) : null}
          {call.truncated ? (
            <p className="text-meta text-brand-label">
              {t`Truncated at 64 KB — check the terminal for the full payload.`}
            </p>
          ) : null}
        </div>
      )}
      <PermissionActions
        isPlan={Boolean(call.plan)}
        allowKeys={allowKeys}
        alwaysOptions={alwaysOptions}
        disabled={disabled}
        pending={pending}
        run={run}
        onKey={onKey}
        promptKey={promptKey}
        onResolve={onResolve}
      />
      <PromptActionStatus pending={pending} idle={idleHint} />
      {screen ? (
        <Disclosure
          title={t`Terminal`}
          triggerClassName="min-h-8 text-caption font-normal text-brand-label"
        >
          <pre className="max-h-64 overflow-auto overscroll-contain font-mono text-meta leading-snug text-brand-muted">
            {screen}
          </pre>
        </Disclosure>
      ) : null}
      <PermissionDetailSheet
        call={call}
        summary={summary}
        open={expanded}
        onOpenChange={setExpanded}
        onCopy={copyBody}
      />
    </div>
  )
}
