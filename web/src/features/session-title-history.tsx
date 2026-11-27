// 会话任务轨迹: chronological history of title changes recorded by the host's
// background auto-titler and manual /rename, shown newest-first in SessionInfo
// and expandable in 我的 › 自动标题.
import { useLingui } from '@lingui/react/macro'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { copyText } from '#/lib/clipboard'
import type { TitleHistoryItem } from './console-sessions'

const PROVIDER_LABELS: Record<string, string> = {
  grok: 'Grok',
  claude: 'Claude',
  codex: 'Codex',
}

function formatHistoryTime(ms: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function TitleHistoryTimeline({
  history,
  defaultLimit = 4,
  compact = false,
  testId = 'session-title-history',
}: {
  history: Array<TitleHistoryItem>
  defaultLimit?: number
  compact?: boolean
  testId?: string
}) {
  const { t } = useLingui()
  const [expanded, setExpanded] = useState(false)
  if (history.length === 0) return null

  const ordered = [...history].reverse()
  const total = ordered.length
  const hasMore = total > defaultLimit
  const visible = expanded ? ordered : ordered.slice(0, defaultLimit)

  const copyTitle = (title: string) => {
    void copyText(title).then(() => {
      const shown = title.length > 40 ? `${title.slice(0, 39)}…` : title
      toast(t`Copied: ${shown}`)
    })
  }

  return (
    <div
      data-testid={testId}
      className={
        compact
          ? 'grid gap-1.5 pt-2'
          : 'grid gap-1.5 rounded-xl bg-brand-surface px-3 py-2.5'
      }
    >
      <ol className="relative grid gap-2.5 pl-4">
        {visible.map((item, idx) => {
          const isCurrent = idx === 0 && !item.ended_at
          const isLast = idx === visible.length - 1
          const provider = item.provider
            ? (PROVIDER_LABELS[item.provider] ?? item.provider)
            : ''
          const sourceText =
            item.source === 'manual'
              ? t`Manual`
              : item.source === 'native'
                ? t`Native`
                : provider
                  ? t`Auto · ${provider}`
                  : t`Auto`
          const turns = item.user_turns
          const metaParts = [
            formatHistoryTime(item.at),
            isCurrent ? t`Current` : '',
            turns ? t`Turn ${turns}` : '',
            sourceText,
          ].filter(Boolean)

          return (
            <li
              key={`${item.at}-${idx}`}
              className="relative grid min-w-0 gap-0.5"
            >
              {!isLast ? (
                <span
                  aria-hidden
                  className="absolute top-3 -bottom-3 -left-[11px] w-px bg-brand-edge"
                />
              ) : null}
              <span
                aria-hidden
                className={
                  isCurrent
                    ? 'absolute top-1.5 -left-[14px] h-[7px] w-[7px] rounded-full bg-brand-accent ring-2 ring-brand-accent/25'
                    : 'absolute top-1.5 -left-[13.5px] h-1.5 w-1.5 rounded-full bg-brand-label/50'
                }
              />
              <Button
                type="button"
                variant="plain"
                size="none"
                title={t`Copy value`}
                onClick={() => copyTitle(item.title)}
                className={
                  isCurrent
                    ? 'text-left text-caption leading-snug font-medium break-words text-brand-text hover:underline'
                    : 'text-left text-caption leading-snug font-normal break-words text-brand-muted hover:text-brand-text hover:underline'
                }
              >
                {item.title}
              </Button>
              <span className="text-meta text-brand-label tabular-nums">
                {metaParts.join(' · ')}
              </span>
            </li>
          )
        })}
      </ol>
      {hasMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          className="justify-self-start px-1.5 text-meta text-brand-muted"
        >
          {expanded ? (
            <>
              <ChevronUp size={13} aria-hidden />
              {t`Show fewer`}
            </>
          ) : (
            <>
              <ChevronDown size={13} aria-hidden />
              {t`Show all ${total} tasks`}
            </>
          )}
        </Button>
      ) : null}
    </div>
  )
}

export function SessionTitleHistorySection({
  history,
}: {
  history?: Array<TitleHistoryItem>
}) {
  const { t } = useLingui()
  if (!history || history.length === 0) return null
  const count = history.length
  return (
    <section className="grid gap-1">
      <SectionHeading className="bg-brand-deck">
        {t`Task history (${count})`}
      </SectionHeading>
      <TitleHistoryTimeline history={history} defaultLimit={4} />
    </section>
  )
}
