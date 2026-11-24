// Session tags (the session list rows, the session header): coloured by what
// they say and carrying an icon where one reads faster than the word. An
// agent wears its own colour (deck.css --agent-*) and a mark: Claude a
// starburst, Codex a terminal, Grok a bolt; 主 is the accent, 副 neutral; a
// status takes its tone (running / waiting / done); a branch and a repo are
// neutral with their git icons. They all used to be the same grey pill.
import {
  Asterisk,
  Check,
  Bot,
  FolderGit2,
  GitBranch,
  SquareTerminal,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

import type { LedTone } from '#/components/deck/led'
import { cn } from '#/lib/utils'

type Tone =
  'neutral' | 'accent' | 'waiting' | 'done' | 'claude' | 'codex' | 'grok'

export function SessionTag({
  tone = 'neutral',
  icon: Icon,
  mono = false,
  hint,
  className,
  children,
}: {
  tone?: Tone
  icon?: LucideIcon
  mono?: boolean
  /** hover text when the tag itself is shorthand */
  hint?: string
  className?: string
  children: string
}) {
  return (
    <span
      data-tone={tone}
      title={hint ?? children}
      className={cn('session-tag text-meta', mono && 'font-mono', className)}
    >
      {Icon ? <Icon size={11} aria-hidden className="shrink-0" /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

const AGENTS: Partial<Record<string, { tone: Tone; icon: LucideIcon }>> = {
  claude: { tone: 'claude', icon: Asterisk },
  codex: { tone: 'codex', icon: SquareTerminal },
  grok: { tone: 'grok', icon: Zap },
}

export function AgentTag({ agent }: { agent: string }) {
  const known = AGENTS[agent.replace(/\.real$/, '')]
  return (
    <SessionTag tone={known?.tone ?? 'neutral'} icon={known?.icon ?? Bot} mono>
      {agent}
    </SessionTag>
  )
}

/** 主 (primary) the accent, 副 (secondary) neutral */
export function RoleTag({ role, label }: { role: string; label: string }) {
  return (
    <SessionTag tone={role === 'primary' ? 'accent' : 'neutral'}>
      {label}
    </SessionTag>
  )
}

const STATUS_TONE: Record<LedTone, Tone> = {
  running: 'accent',
  waiting: 'waiting',
  done: 'done',
  error: 'waiting',
  muted: 'neutral',
}

export function StatusTag({ tone, label }: { tone: LedTone; label: string }) {
  return <SessionTag tone={STATUS_TONE[tone]}>{label}</SessionTag>
}

export function BranchTag({ branch }: { branch: string }) {
  return (
    <SessionTag icon={GitBranch} mono>
      {branch}
    </SessionTag>
  )
}

export type GitStatus = {
  staged: number
  unstaged: number
  untracked: number
  upstream: boolean
  ahead: number
  behind: number
}

/**
 * Working-tree status beside the branch, the tmux status line's counts
 * (+staged ~unstaged ?untracked, by file) with ↑ahead ↓behind; ✓ when clean
 * and level with upstream. The hover spells it out.
 */
export function GitStatusTag({ git }: { git: GitStatus }) {
  const { t } = useLingui()
  const { staged, unstaged, untracked, ahead, behind } = git
  const parts = [
    git.staged ? `+${git.staged}` : '',
    git.unstaged ? `~${git.unstaged}` : '',
    git.untracked ? `?${git.untracked}` : '',
    git.ahead ? `↑${git.ahead}` : '',
    git.behind ? `↓${git.behind}` : '',
  ].filter(Boolean)
  const hint = [
    t`${staged} staged, ${unstaged} modified, ${untracked} untracked`,
    git.upstream
      ? t`${ahead} ahead, ${behind} behind upstream`
      : t`no upstream`,
  ].join(' · ')
  if (parts.length)
    return (
      <SessionTag tone="accent" mono hint={hint} className="shrink-0">
        {parts.join(' ')}
      </SessionTag>
    )
  // nothing to commit: a word, not a lone ✓ (too small to read as a state);
  // "synced" only with an upstream to be level with
  return (
    <SessionTag
      tone={git.upstream ? 'done' : 'neutral'}
      icon={Check}
      hint={hint}
      className="shrink-0"
    >
      {git.upstream
        ? t({ message: 'Synced', context: 'git' })
        : t({ message: 'No changes', context: 'git' })}
    </SessionTag>
  )
}

/**
 * The tag line, the same in the session list row and the session header:
 * it wraps, and one tag takes at most a whole line (then truncates, the full
 * text on hover) — the header used to squeeze them into one line (「* c…」).
 */
export function TagLine({
  children,
  className,
  testId,
}: {
  children: React.ReactNode
  className?: string
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-1 text-meta text-brand-label',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function RepoTag({ repo }: { repo: string }) {
  return <SessionTag icon={FolderGit2}>{repo}</SessionTag>
}
