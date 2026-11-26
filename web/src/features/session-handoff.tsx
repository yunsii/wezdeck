// 接力: replace this pane's agent with another (claude → grok / codex),
// paste a continuation brief built from the source transcript. Relay
// `session.handoff` → scripts/runtime/session-handoff.sh (sticks the target
// agent on the window for later F5). Same agent → use 新开会话 instead.
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
import { seedQueuedPending } from './session-send'

const AGENTS = ['claude', 'codex', 'grok'] as const
type Agent = (typeof AGENTS)[number]

type Job = {
  job: string
  stage: 'starting' | 'sending' | 'done' | 'failed'
  from_id: string
  to_agent: string
  worktree?: string
  pane?: string
  session_id?: string
  /** pasted brief — seed a queued bubble before the transcript poll */
  brief?: string
  error?: string
}

type SessionRow = { id: string; tmux_pane?: string; worktree?: string }

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
  const normalized = (agent || '').replace(/\.real$/, '')
  const current: Agent | '' = AGENTS.includes(normalized as Agent)
    ? (normalized as Agent)
    : ''
  const targets = AGENTS.filter((a) => a !== current)
  const [to, setTo] = useState<Agent | null>(null)
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
    toast(t`Handed off to ${toAgent}`)
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
        <p className="px-1 text-caption text-brand-muted">
          {t`Replace this pane with ${to}. The source transcript stays on disk; a short brief is pasted as the first message. Later F5 keeps ${to}. Does not recycle the worktree.`}
        </p>
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
            disabled={disabled}
            onClick={() => void run()}
            className={action}
          >
            {t`Hand off to ${to}`}
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
      <p className="px-1 text-meta text-brand-label">{t`Hand off`}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {targets.map((target) => (
          <Button
            key={target}
            variant="key"
            type="button"
            disabled={disabled}
            data-handoff={target}
            title={t`Replace this pane with ${target} and paste a continuation brief`}
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
