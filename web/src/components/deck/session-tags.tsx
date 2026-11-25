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
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

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
  const expandable = useContext(Expandable)
  const text = useRef<HTMLSpanElement>(null)
  // cut: the text is truncated right now; open: shown whole (a tap)
  const [cut, setCut] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!expandable || open || !el || typeof ResizeObserver === 'undefined')
      return
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // cut swaps <span> for <button>: the text node is a new element, so
    // observe that one (the detached old one measured 0 and flipped it back)
  }, [expandable, open, cut, children])
  const body = (
    <>
      {Icon ? <Icon size={11} aria-hidden className="shrink-0" /> : null}
      <span
        ref={text}
        className={cn('min-w-0', open ? 'break-all' : 'truncate')}
      >
        {children}
      </span>
    </>
  )
  const classes = cn('session-tag text-meta', mono && 'font-mono', className)
  // a truncated tag opens to its whole text in place (a phone has no hover)
  if (expandable && (cut || open))
    return (
      <button
        type="button"
        data-tone={tone}
        data-expanded={open ? '' : undefined}
        aria-expanded={open}
        title={hint ?? children}
        onClick={() => setOpen(!open)}
        className={cn(
          classes,
          'cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
        )}
      >
        {body}
      </button>
    )
  return (
    <span data-tone={tone} title={hint ?? children} className={classes}>
      {body}
    </span>
  )
}

/** false inside a link (a session list row): no button within it */
const Expandable = createContext(true)

/** tags inside another control (the git tag's button) never open */
export function NoExpand({ children }: { children: React.ReactNode }) {
  return <Expandable.Provider value={false}>{children}</Expandable.Provider>
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

/** about the width .session-tag-fill keeps before the tag wraps (7rem) */
const FILL_CHARS = 14

/**
 * A long branch shares the line and truncates (`.session-tag-fill`): it
 * only drops to a line of its own when less than ~7rem is left for it. A
 * short one keeps its own width.
 */
export function BranchTag({ branch }: { branch: string }) {
  return (
    <SessionTag
      icon={GitBranch}
      mono
      className={branch.length > FILL_CHARS ? 'session-tag-fill' : undefined}
    >
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
 * one line first — a long tag (a branch) truncates to fit beside the others,
 * which keep their size — and it wraps only when the long one would get
 * less than ~7rem; a tag never exceeds a whole line (full text on hover).
 * The header used to squeeze the agent to 「* c…」, then to stack every tag.
 */
export function TagLine({
  children,
  className,
  testId,
  expandable = true,
}: {
  children: React.ReactNode
  className?: string
  testId?: string
  /** tap a truncated tag to see it whole; off inside a link (list rows) */
  expandable?: boolean
}) {
  return (
    <Expandable.Provider value={expandable}>
      <span
        data-testid={testId}
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-1 text-meta text-brand-label',
          className,
        )}
      >
        {children}
      </span>
    </Expandable.Provider>
  )
}

export function RepoTag({ repo }: { repo: string }) {
  return <SessionTag icon={FolderGit2}>{repo}</SessionTag>
}
