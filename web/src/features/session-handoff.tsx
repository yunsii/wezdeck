// 接力 / 空白切换: replace this pane's agent with another. Handoff pastes a
// continuation brief built from the source transcript; a blank switch does not
// read it or send a first prompt. Relay `session.handoff` →
// scripts/runtime/session-handoff.sh (sticks the target agent on the window for
// later F5). Same agent → use 新开会话 instead.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRightLeft } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { trace } from '#/lib/client-trace'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { useSessions } from './console-sessions'
import { useAgentProfiles } from './agent-profiles'
import { seedQueuedPending } from './session-send'

const AGENTS = ['claude', 'codex', 'grok', 'agy'] as const
type Agent = (typeof AGENTS)[number]

type Job = {
  job: string
  stage: 'starting' | 'sending' | 'done' | 'failed'
  from_id: string
  to_agent: string
  worktree?: string
  pane?: string
  mode: 'handoff' | 'switch'
  session_id?: string
  /** pasted brief — seed a queued bubble before the transcript poll */
  brief?: string
  error?: string
}

type SessionRow = { id: string; tmux_pane?: string; worktree?: string }

type HandoffMode = 'handoff' | 'switch'

function ModeSelector({
  mode,
  onChange,
}: {
  mode: HandoffMode
  onChange: (mode: HandoffMode) => void
}) {
  const { t } = useLingui()
  return (
    <div
      className="grid grid-cols-2 gap-1.5"
      role="radiogroup"
      aria-label={t`Switch mode`}
    >
      {(
        [
          ['handoff', t`Hand off`, t`Carry a brief`],
          ['switch', t`Blank switch`, t`Start without context`],
        ] as const
      ).map(([value, label, description]) => (
        <Button
          key={value}
          type="button"
          variant="plain"
          role="radio"
          aria-checked={mode === value}
          onClick={() => onChange(value)}
          className={`grid min-h-12 cursor-pointer content-center justify-start rounded-xl border px-2 py-1.5 text-left ${
            mode === value
              ? 'border-brand-running bg-brand-running/10'
              : 'border-brand-border'
          }`}
        >
          <span className="text-caption font-medium">{label}</span>
          <span className="text-meta text-brand-muted">{description}</span>
        </Button>
      ))}
    </div>
  )
}

function followHandoffId(
  job: Job | undefined,
  id: string,
  before: Set<string>,
  rows: Array<SessionRow> | undefined,
) {
  if (job?.stage !== 'done') return undefined
  if (job.session_id) return job.session_id
  return (
    rows?.find(
      (row) =>
        row.tmux_pane === job.pane && !before.has(row.id) && row.id !== id,
    )?.id ||
    rows?.find(
      (row) =>
        row.worktree &&
        row.worktree === job.worktree &&
        !before.has(row.id) &&
        row.id !== id,
    )?.id
  )
}

export function HandoffActions({
  id,
  agent,
  disabled,
  onDone,
}: {
  id: string
  agent?: string
  disabled: boolean
  onDone: () => void
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const client = useQueryClient()
  const sessions = useSessions()
  const profiles = useAgentProfiles()
  const normalized = (agent || '').replace(/\.real$/, '')
  const current: Agent | '' = AGENTS.includes(normalized as Agent)
    ? (normalized as Agent)
    : ''
  const targets = AGENTS.filter(
    (candidate) =>
      candidate !== current &&
      profiles.data?.profiles.some(
        (profile) => profile.id === candidate && !profile.disabled,
      ),
  )
  const [to, setTo] = useState<Agent | null>(null)
  const [mode, setMode] = useState<HandoffMode>('handoff')
  const [note, setNote] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const [jobId, setJobId] = useState('')
  const before = useRef<Set<string>>(new Set())
  const opened = useRef('')

  const job = useQuery({
    queryKey: ['remote', 'session.handoff.job', jobId],
    enabled: Boolean(jobId),
    refetchInterval: (query) =>
      query.state.data &&
      ['done', 'failed'].includes(query.state.data.job.stage)
        ? false
        : 800,
    queryFn: async () =>
      (await hostRead('session.handoff.job', { job: jobId })) as { job: Job },
  })
  const currentJob = job.data?.job
  const followId = followHandoffId(
    currentJob,
    id,
    before.current,
    sessions.data?.sessions,
  )

  useEffect(() => {
    if (!followId || !jobId || opened.current === jobId) return
    opened.current = jobId
    if (currentJob?.brief) {
      seedQueuedPending(followId, currentJob.brief, { note: t`Handoff brief` })
    }
    void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    void client.invalidateQueries({ queryKey: ['remote', 'session', followId] })
    onDone()
    const toAgent = currentJob?.to_agent ?? 'agent'
    toast(
      currentJob?.mode === 'switch'
        ? t`Switched to ${toAgent}`
        : t`Handed off to ${toAgent}`,
    )
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: followId },
    })
  }, [followId, jobId, navigate, locale, onDone, currentJob, client, t])

  useEffect(() => {
    if (currentJob?.stage !== 'failed') return
    setError(currentJob.error || t`Handoff failed`)
    setJobId('')
  }, [currentJob?.stage, currentJob?.error, t])
  if (!current || targets.length === 0) {
    return null
  }

  const action =
    'flex h-10 items-center justify-center gap-1.5 rounded-xl px-2 text-caption disabled:opacity-40'
  const busy = Boolean(jobId) && currentJob?.stage !== 'failed'

  if (busy) {
    const progress =
      currentJob?.stage === 'sending'
        ? t`Sending the handoff brief…`
        : t`Switching agent…`
    return (
      <div
        data-testid="session-handoff-progress"
        className="grid gap-1.5 rounded-xl bg-brand-deck p-2"
      >
        <p className="px-1 text-caption text-brand-muted">{progress}</p>
      </div>
    )
  }

  if (asking && to) {
    const run = async () => {
      setError('')
      trace('session-handoff', { from: current, to })
      before.current = new Set(
        (sessions.data?.sessions ?? []).map((row) => row.id),
      )
      try {
        const res = (await hostWrite('session.handoff', {
          id,
          to,
          note: note.trim(),
          mode,
        })) as { job: string }
        setJobId(res.job)
        setAsking(false)
      } catch (e) {
        setError((e as Error).message)
      }
    }
    return (
      <div
        role="group"
        aria-label={t`Hand off`}
        data-testid="session-handoff-confirm"
        className="grid gap-1.5 rounded-xl bg-brand-deck p-2"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setAsking(false)
        }}
      >
        <ModeSelector mode={mode} onChange={setMode} />
        <p className="px-1 text-caption text-brand-muted">
          {mode === 'handoff'
            ? t`Replace this pane with ${to}. The source transcript stays on disk; a short brief is pasted as the first message. Later F5 keeps ${to}. Does not recycle the worktree.`
            : t`Replace this pane with a blank ${to}. No continuation brief or first message is sent, and the old transcript is not read. The worktree stays unchanged; later F5 keeps ${to}.`}
        </p>
        {mode === 'handoff' ? (
          <label className="grid gap-1 px-1 text-caption text-brand-muted">
            {t`Optional note`}
            <Input
              data-testid="session-handoff-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              placeholder={t`What should the next agent do first?`}
            />
          </label>
        ) : null}
        {error ? (
          <p className="px-1 text-caption text-brand-danger">{error}</p>
        ) : null}
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            variant="key"
            type="button"
            data-handoff-cancel
            onClick={() => setAsking(false)}
            className={action}
          >
            {t`Cancel`}
          </Button>
          <Button
            variant="solid"
            type="button"
            data-handoff-confirm
            autoFocus
            disabled={disabled || !targets.includes(to)}
            onClick={() => void run()}
            className={action}
          >
            {mode === 'handoff' ? t`Hand off to ${to}` : t`Switch to ${to}`}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      role="group"
      aria-label={t`Hand off to another agent`}
      data-testid="session-handoff"
      className="grid gap-1.5"
    >
      <div className="grid gap-1 px-1">
        <p className="text-meta text-brand-label">{t`Hand off / switch`}</p>
        <div data-testid="session-handoff-mode">
          <ModeSelector mode={mode} onChange={setMode} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {targets.map((target) => (
          <Button
            key={target}
            variant="key"
            type="button"
            disabled={disabled}
            data-handoff={target}
            title={t`Replace this pane with ${target}; choose a handoff brief or a blank switch`}
            onClick={() => {
              setTo(target)
              setAsking(true)
              setError('')
            }}
            className={action}
          >
            <ArrowRightLeft size={14} aria-hidden />
            {target}
          </Button>
        ))}
      </div>
      {error ? (
        <p className="px-1 text-caption text-brand-danger">{error}</p>
      ) : null}
    </div>
  )
}
