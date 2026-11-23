// A slash command in the conversation (/model, /compact, /resume …) and what
// it printed — native/wezdeck-wsl/claude_command.go, kind "slash". A quiet
// row like the compaction divider, not a bubble: nobody said it to the
// agent. Long output folds.
import { useLingui } from '@lingui/react/macro'
import { SquareSlash } from 'lucide-react'
import { useEffect } from 'react'

import { Disclosure } from '#/components/ui/disclosure'
import type { Message } from './chat-thread'

export function SlashCommandRow({
  message,
  onShown,
}: {
  message: Message
  /** the reveal cursor sits here: nothing to animate, move on */
  onShown?: () => void
}) {
  const { t } = useLingui()
  useEffect(() => {
    onShown?.()
  }, [onShown])
  const command = message.text || t`Command output`
  const output = message.body ?? ''
  const head = (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-brand-label">
      <SquareSlash size={13} aria-hidden className="shrink-0" />
      <span className="truncate font-mono text-brand-muted">{command}</span>
    </span>
  )
  const short = output && !output.includes('\n') && output.length <= 120
  return (
    <div className="grid gap-1 py-0.5" data-testid="slash-command">
      {!output ? (
        head
      ) : short ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {head}
          <span className="text-[12.5px] text-brand-muted">{output}</span>
        </span>
      ) : (
        <Disclosure chevron={false} title={head} triggerClassName="w-auto">
          <pre className="mt-1 max-h-72 overflow-auto rounded-[10px] bg-brand-surface px-3 py-2 font-mono text-[12px] leading-snug whitespace-pre-wrap text-brand-muted">
            {output}
          </pre>
        </Disclosure>
      )}
    </div>
  )
}
