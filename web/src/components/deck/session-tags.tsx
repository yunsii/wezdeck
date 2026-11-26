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
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { useLingui } from '@lingui/react/macro'
import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import type { LedTone } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { PopoverContent } from '#/components/ui/popover'

type Tone =
  'neutral' | 'accent' | 'waiting' | 'done' | 'claude' | 'codex' | 'grok'

export function SessionTag({
  tone = 'neutral',
  icon: Icon,
  mono = false,
  hint,
  label,
  className,
  children,
}: {
  tone?: Tone
  icon?: LucideIcon
  mono?: boolean
  /** hover text when the tag itself is shorthand */
  hint?: string
  /** what a reader says when the tag shows only an icon */
  label?: string
  className?: string
  children: string
}) {
  const expand = useContext(Expandable)
  const measures = expand.mode === 'inline' || expand.mode === 'overlay'
  const text = useRef<HTMLSpanElement>(null)
  // the text is truncated right now
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!measures || !el || typeof ResizeObserver === 'undefined') return
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // cut swaps <span> for the tip's trigger: the text node is a new
    // element, so observe that one (the detached old one measured 0)
  }, [measures, cut, children])
  const body = (
    <>
      {Icon ? <Icon size={11} aria-hidden className="shrink-0" /> : null}
      <span
        ref={text}
        className={cn(
          'min-w-0',
          expand.mode === 'full' ? 'break-all' : 'truncate',
        )}
      >
        {children}
      </span>
    </>
  )
  const classes = cn('session-tag text-meta', mono && 'font-mono', className)
  // truncated: the whole text in a tip over the page (a tap on a phone,
  // hover on a desk) — opening it in place moved the layout
  if (measures && cut)
    return (
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger
          openOnHover
          delay={250}
          data-tone={tone}
          aria-label={hint ?? children}
          className={cn(
            classes,
            'cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
          )}
        >
          {body}
        </PopoverPrimitive.Trigger>
        <PopoverContent
          side="bottom"
          sideOffset={6}
          className={cn(
            'max-w-[min(22rem,calc(100vw-2rem))] px-2.5 py-1.5 text-meta break-all',
            mono && 'font-mono',
          )}
        >
          <span data-testid="tag-tip">{children}</span>
        </PopoverContent>
      </PopoverPrimitive.Root>
    )
  return (
    <span
      data-tone={tone}
      title={hint ?? children}
      aria-label={label}
      role={label ? 'img' : undefined}
      className={classes}
    >
      {body}
    </span>
  )
}

/** px two tag tops may differ by and still share a row */
const ROW_SLACK = 6

/** the tags as a list: fragments opened, empty slots dropped */
function flatChildren(children: React.ReactNode): Array<React.ReactNode> {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ children?: React.ReactNode }>(child) &&
    child.type === Fragment
      ? flatChildren(child.props.children)
      : [child],
  )
}

/**
 * How a truncated tag shows its whole text: `inline` / `overlay` in a tip
 * (overlay: the line also folds behind +N), `full` (inside the +N panel)
 * shows every tag whole, `none` never (inside a link or another control).
 */
type ExpandMode = 'inline' | 'overlay' | 'full' | 'none'
const Expandable = createContext<{ mode: ExpandMode }>({
  mode: 'inline',
})

/** tags inside another control (the git tag's button) never open */
export function NoExpand({ children }: { children: React.ReactNode }) {
  return (
    <Expandable.Provider value={{ mode: 'none' }}>
      {children}
    </Expandable.Provider>
  )
}

export const AGENT_MARKS: Partial<
  Record<string, { tone: Tone; icon: LucideIcon }>
> = {
  claude: { tone: 'claude', icon: Asterisk },
  codex: { tone: 'codex', icon: SquareTerminal },
  grok: { tone: 'grok', icon: Zap },
}

/** compact: the agent's mark alone (the status bar), its name on hover */
export function AgentTag({
  agent,
  compact = false,
}: {
  agent: string
  compact?: boolean
}) {
  const known = AGENT_MARKS[agent.replace(/\.real$/, '')]
  return (
    <SessionTag
      tone={known?.tone ?? 'neutral'}
      icon={known?.icon ?? Bot}
      mono
      hint={compact ? agent : undefined}
      label={compact ? agent : undefined}
      className={compact ? 'session-tag-icon' : undefined}
    >
      {compact ? '' : agent}
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
export function GitStatusTag({
  git,
  fixed = false,
}: {
  git: GitStatus
  /** the status bar: every segment always (zeros dimmed), so its width holds */
  fixed?: boolean
}) {
  const { t } = useLingui()
  const { staged, unstaged, untracked, ahead, behind } = git
  if (fixed) return <GitStatusFixed git={git} />
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
 * The tag line, the same in the session list row, the session header and
 * 会话信息: one line first — a long tag (a branch) truncates to fit beside
 * the others, which keep their size — and it wraps only when the long one
 * would get less than ~7rem; a tag never exceeds a whole line.
 * `maxLines` (the header: 2) folds what does not fit behind +N, which opens
 * a panel over the page with every tag whole — the header's height never
 * changes. A truncated tag shows its text in a tip (tap / hover), nothing
 * moves. Without `maxLines` the line wraps freely (会话信息).
 */
export function TagLine({
  children,
  className,
  testId,
  expandable = true,
  maxLines,
  panelSide = 'bottom',
  onVisibleTags,
}: {
  children: React.ReactNode
  className?: string
  testId?: string
  /** false inside a link (list rows): no tag opens */
  expandable?: boolean
  maxLines?: number
  /** where the +N panel opens: under the line, or above it (a bottom bar) */
  panelSide?: 'top' | 'bottom'
  onVisibleTags?: (ids: string) => void
}) {
  const { t } = useLingui()
  const line = useRef<HTMLSpanElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // first: the index of the first folded tag; -1 when the count of laid-out
  // tags does not match the children (then the panel shows them all)
  const [fold, setFold] = useState({ height: 0, hidden: 0, first: 0 })
  const [panel, setPanel] = useState(false)
  useLayoutEffect(() => {
    const el = line.current
    if (!maxLines || !el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      // tags only: an open tip's popover drops 1×1 focus guards in beside
      // its trigger (top -1), which counted as a row of their own (+1)
      const tags = [...el.children].filter(
        (c): c is HTMLElement =>
          c instanceof HTMLElement &&
          !c.hasAttribute('data-base-ui-focus-guard') &&
          (c.classList.contains('session-tag') ||
            c.querySelector('.session-tag') !== null),
      )
      // rows in wrap order, a few px of slack: centred tags of different
      // heights (an icon-only one) sit 1–2 px apart on the same row, and
      // counting those as rows hid the whole status bar
      let row = 0
      let rowTop = tags[0]?.offsetTop ?? 0
      const rows = tags.map((tag) => {
        if (tag.offsetTop > rowTop + ROW_SLACK) {
          row += 1
          rowTop = tag.offsetTop
        }
        return row
      })
      const firstHidden = rows.findIndex((r) => r >= maxLines)
      const shown = tags.filter((_, k) => rows[k] < maxLines)
      if (onVisibleTags) {
        tags.forEach((tag, index) => {
          tag.inert = rows[index] >= maxLines
        })
        onVisibleTags(
          shown
            .map((tag) => tag.dataset.tagId)
            .filter(Boolean)
            .join(' '),
        )
      }
      const bottom = Math.max(
        ...shown.map((tag) => tag.offsetTop + tag.offsetHeight),
      )
      const next =
        firstHidden < 0
          ? { height: 0, hidden: 0, first: 0 }
          : {
              // the line's height down to the last shown row's bottom
              height: bottom,
              hidden: tags.length - firstHidden,
              // tags wrap in order: the folded ones are a tail
              // one laid-out tag per child (else show them all)
              first:
                tags.length === flatChildren(children).length
                  ? firstHidden
                  : -1,
            }
      setFold((now) =>
        now.height === next.height &&
        now.hidden === next.hidden &&
        now.first === next.first
          ? now
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    // children come and go without a resize (those guards): measure again
    const added = new MutationObserver(measure)
    added.observe(el, { childList: true })
    return () => {
      observer.disconnect()
      added.disconnect()
    }
  }, [maxLines, children, onVisibleTags])
  useEffect(() => {
    if (!panel) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanel(false)
    }
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setPanel(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [panel])
  const mode: ExpandMode = !expandable
    ? 'none'
    : maxLines
      ? 'overlay'
      : 'inline'
  const folded = fold.hidden > 0
  return (
    <div ref={box} className="relative min-w-0">
      <Expandable.Provider value={{ mode }}>
        <span
          ref={line}
          data-testid={testId}
          data-folded={folded ? fold.hidden : undefined}
          style={
            folded ? { maxHeight: fold.height, overflow: 'hidden' } : undefined
          }
          className={cn(
            'relative flex min-w-0 flex-wrap items-center gap-1 text-meta text-brand-label',
            // room for +N at the end of the last row shown
            folded && 'pr-10',
            className,
          )}
        >
          {children}
        </span>
      </Expandable.Provider>
      {folded ? (
        <button
          type="button"
          data-testid={testId ? `${testId}-more` : undefined}
          aria-haspopup="dialog"
          aria-expanded={panel}
          aria-label={t`Show all tags`}
          onClick={() => setPanel(!panel)}
          className="session-tag absolute right-0 bottom-0 cursor-pointer text-meta outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
          data-tone="neutral"
        >
          +{fold.hidden}
        </button>
      ) : null}
      {panel ? (
        // over the page, not in the header's flow: its height stays
        <div
          role="dialog"
          aria-label={t`All tags`}
          data-testid={testId ? `${testId}-panel` : undefined}
          className={cn(
            'absolute left-0 z-30 w-full min-w-56 rounded-xl bg-brand-surface p-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.3)]',
            panelSide === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
        >
          <Expandable.Provider value={{ mode: 'full' }}>
            {/* only what the line folded away: the rest is in view */}
            <span className="tag-panel flex min-w-0 flex-wrap items-center gap-1 text-meta text-brand-label">
              {fold.first >= 0
                ? flatChildren(children).slice(fold.first)
                : children}
            </span>
          </Expandable.Provider>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The status bar's git tag, like the terminal's (+0,~0,?0,^1,v3): every
 * segment always, a zero dimmed, digits of one width — the agent editing
 * files changed the counts every few seconds, and a tag that grew and
 * shrank (segments coming and going) pushed the bar onto another line.
 */
function GitStatusFixed({ git }: { git: GitStatus }) {
  const { t } = useLingui()
  const { staged, unstaged, untracked, ahead, behind } = git
  const segments: Array<[string, number]> = [
    ['+', staged],
    ['~', unstaged],
    ['?', untracked],
    ...(git.upstream
      ? ([
          ['↑', ahead],
          ['↓', behind],
        ] as Array<[string, number]>)
      : []),
  ]
  const clean = segments.every(([, n]) => n === 0)
  const hint = [
    t`${staged} staged, ${unstaged} modified, ${untracked} untracked`,
    git.upstream
      ? t`${ahead} ahead, ${behind} behind upstream`
      : t`no upstream`,
  ].join(' · ')
  return (
    <span
      data-tone={clean ? 'done' : 'accent'}
      data-testid="git-fixed"
      title={hint}
      className="session-tag shrink-0 font-mono text-meta tabular-nums"
    >
      {segments.map(([mark, n]) => (
        // a mark and two digits wide: counts under 100 never move the tags
        // after it
        <span
          key={mark}
          // a zero steps back only beside real counts: on a clean tree
          // every segment is zero, and dimming them all on the green fill
          // left too little contrast (light theme)
          className={cn(
            'inline-block min-w-[3ch]',
            n === 0 && !clean && 'opacity-55',
          )}
        >
          {mark}
          {n}
        </span>
      ))}
    </span>
  )
}

export function RepoTag({ repo }: { repo: string }) {
  return <SessionTag icon={FolderGit2}>{repo}</SessionTag>
}
