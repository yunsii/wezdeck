// What this session's agent can do: the 能力 chip above the composer opens a
// sheet of the skills the agent was actually shown (`session.skills`,
// native/wezdeck-wsl/session_skills.go), grouped by where they come from; a
// tap puts `/name ` in the composer. Typing the trigger (`/`, Codex `$`) in
// the composer opens the same list as a completion (skill-complete.ts).
// Read on demand; the session poll's `skills_rev` says when to read again.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'

import { Input } from '#/components/ui/input'
import { Sheet } from '#/components/ui/sheet'
import { Button } from '#/components/ui/button'
import { hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import {
  CLAUDE_COMMANDS,
  ORIGIN_ORDER,
  completionEntries,
  matchCompletions,
} from './skill-complete'
import type { Completion, SkillOrigin, SkillsReply } from './skill-complete'

export function useSessionSkills(
  id: string,
  rev: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    // rev in the key: a changed list (a skill added, /clear) reads again
    queryKey: ['remote', 'session-skills', id, rev ?? ''],
    enabled: enabled && typeof window !== 'undefined',
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () =>
      (await hostRead('session.skills', { id })) as SkillsReply,
  })
}

export function useOriginLabels(): Record<SkillOrigin | 'command', string> {
  const { t } = useLingui()
  return {
    wezdeck: t`WezDeck`,
    project: t`This repo`,
    user: t`User`,
    plugin: t`Plugin`,
    builtin: t`Built in`,
    command: t`Command`,
  }
}

/** Claude's own commands, described in the page language */
export function useAgentCommands(agent: string | undefined) {
  const { t } = useLingui()
  if (agent !== 'claude') return []
  const hints: Record<(typeof CLAUDE_COMMANDS)[number], string> = {
    compact: t`summarise the context`,
    new: t`start a fresh conversation`,
    clear: t`start a fresh conversation`,
    resume: t`pick an earlier one`,
    context: t`context usage`,
    usage: t`cost and limits`,
    model: t`switch the model`,
    rename: t`name this session`,
  }
  return CLAUDE_COMMANDS.map((name) => ({ name, description: hints[name] }))
}

/** every entry the composer completes: commands, then skills */
export function useCompletions(reply: SkillsReply | undefined, agent?: string) {
  return completionEntries(reply, useAgentCommands(agent))
}

/**
 * The completion list above the input. Rows are buttons that never take
 * focus (mousedown is prevented), so the caret stays in the textarea while
 * ↑ ↓ move the highlight and Tab / Enter pick.
 */
export function CompletionList({
  items,
  active,
  onPick,
  onHover,
}: {
  items: Array<Completion>
  active: number
  onPick: (item: Completion) => void
  onHover: (index: number) => void
}) {
  const { t } = useLingui()
  const labels = useOriginLabels()
  return (
    <div
      role="listbox"
      id="composer-completions"
      aria-label={t`Commands and skills`}
      data-testid="composer-completions"
      className="grid max-h-72 gap-0.5 overflow-y-auto rounded-2xl bg-brand-surface p-1.5"
    >
      {items.map((item, index) => (
        <Button
          variant="plain"
          type="button"
          role="option"
          id={`composer-completion-${index}`}
          key={item.insert}
          aria-selected={index === active}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(item)}
          className={cn(
            'grid gap-0.5 rounded-xl px-3 py-2 text-left',
            index === active && 'bg-brand-deck',
          )}
        >
          <span className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="truncate font-mono text-caption">
              {item.insert}
            </span>
            <span className="shrink-0 text-meta text-brand-label">
              {labels[item.kind]}
            </span>
          </span>
          {item.description ? (
            <span className="line-clamp-1 text-meta text-brand-muted">
              {item.description}
            </span>
          ) : null}
        </Button>
      ))}
    </div>
  )
}

/** The 能力 chip in the composer toolbar (styled like its neighbours). */
export function SkillsChip({
  count,
  onOpen,
}: {
  count?: number
  onOpen: () => void
}) {
  const { t } = useLingui()
  return (
    <Button
      variant="plain"
      type="button"
      data-testid="skills-chip"
      aria-haspopup="dialog"
      title={t`Skills this agent was given`}
      onClick={onOpen}
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-brand-surface px-2.5 text-caption text-brand-muted"
    >
      <Sparkles size={14} aria-hidden />
      {t`Skills`}
      {count ? (
        <span className="text-meta tabular-nums opacity-80">{count}</span>
      ) : null}
    </Button>
  )
}

/** The 能力 sheet: search, then the skills by origin; a tap drafts `/name `. */
export function SkillsSheet({
  open,
  onOpenChange,
  reply,
  error,
  agent,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** session.skills; undefined while loading */
  reply?: SkillsReply
  error?: string
  agent?: string
  onPick: (insert: string) => void
}) {
  const { t } = useLingui()
  const labels = useOriginLabels()
  const [query, setQuery] = useState('')
  const entries = useCompletions(reply, agent)
  const shown = query.trim()
    ? matchCompletions(entries, query.trim(), entries.length)
    : entries
  const groups: Array<SkillOrigin | 'command'> = ['command', ...ORIGIN_ORDER]
  const count = reply?.skills.length ?? 0
  const trigger = reply?.trigger || '/'
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t`Skills · ${count}`}
      testId="skills-sheet"
    >
      {/* the body has no side padding of its own: px-4 lines the text,
          search and rows up with the title */}
      <div data-testid="skills-body" className="px-4">
        <p className="pb-2 text-caption text-brand-label">
          {t`What this session's agent was given, read from its own record. Tap one to put it in the message; type ${trigger} in the message to complete.`}
        </p>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`Search name or description`}
          aria-label={t`Search skills`}
          className="mb-2"
        />
        {error ? (
          <p className="py-6 text-center text-body text-brand-error">{error}</p>
        ) : !reply ? (
          <p className="py-6 text-center text-caption text-brand-muted">{t`Loading…`}</p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-caption text-brand-muted">
            {count ? t`Nothing matches` : t`This agent lists no skills yet`}
          </p>
        ) : (
          <div className="grid gap-3 pb-2">
            {groups.map((group) => {
              const rows = shown.filter((item) => item.kind === group)
              if (!rows.length) return null
              return (
                <section key={group} className="grid gap-1.5">
                  <h3 className="text-meta text-brand-label">
                    {labels[group]} · {rows.length}
                  </h3>
                  <ul className="grid gap-1.5">
                    {rows.map((item) => (
                      <li key={item.insert}>
                        <Button
                          variant="plain"
                          type="button"
                          data-skill={item.name}
                          onClick={() => onPick(item.insert)}
                          className="grid w-full gap-0.5 rounded-xl bg-brand-surface px-3.5 py-2.5 text-left"
                        >
                          <span className="truncate font-mono text-caption">
                            {item.insert}
                          </span>
                          {item.description ? (
                            <span className="line-clamp-3 text-caption text-brand-muted">
                              {item.description}
                            </span>
                          ) : null}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </Sheet>
  )
}
