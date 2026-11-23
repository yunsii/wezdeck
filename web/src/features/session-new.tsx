// 新会话 — wezdeck's Ctrl+k g d/t/h from the phone: pick a repository, the
// lifecycle (dev / task / hotfix), a subject and the first message; the host
// creates the worktree and its agent in tmux and hands the agent the message
// (native session_new.go). Creation outlasts an RPC, so the host answers a
// job id and the sheet follows its stages, then opens the session once it
// is listed. `c` on the session list opens it with a keyboard.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { Segmented } from '#/components/deck/segmented'
import { useLocale } from '#/lib/locale-context'
import { remoteLink } from '#/lib/remote-link'
import { recordVisit } from '#/lib/session-visits'
import { useSessions } from './console-sessions'
import { jumpPending } from './console-jump-keys'
import { useDeviceState } from './device-state'

type Repo = { root: string; label: string; visited?: number }
type Kind = 'dev' | 'task' | 'hotfix'
type Job = {
  job: string
  stage: 'creating' | 'starting' | 'sending' | 'done' | 'failed'
  worktree?: string
  branch?: string
  error?: string
}

function useStageText() {
  const { t } = useLingui()
  return (job: Job) => {
    const reason = job.error ?? ''
    return job.stage === 'creating'
      ? t`Creating the worktree…`
      : job.stage === 'starting'
        ? t`Starting the agent…`
        : job.stage === 'sending'
          ? t`Sending the first message…`
          : job.stage === 'done'
            ? t`Started. Opening the session when the agent picks it up…`
            : t`Could not create it: ${reason}`
  }
}

export function NewSessionButton() {
  const { t } = useLingui()
  const device = useDeviceState()
  const [open, setOpen] = useState(false)
  // `c` on the list: Ctrl+k g at the desk
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'c' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        jumpPending()
      )
        return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (device.state !== 'approved') return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="new-session"
        title={t`New session (c)`}
        className="key-press inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[12px] bg-brand-text px-3 text-[14px] font-semibold text-brand-deck md:min-h-9"
      >
        <Plus size={18} aria-hidden />
        <span className="sr-only md:not-sr-only">{t`New session`}</span>
      </button>
      {open ? <NewSessionSheet onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function NewSessionSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const stageText = useStageText()
  const repos = useQuery({
    queryKey: ['remote', 'repos'],
    queryFn: async () =>
      (await remoteLink.rpc('repos', {})) as { repos: Array<Repo> },
  })
  const sessions = useSessions()
  const [repo, setRepo] = useState('')
  const [kind, setKind] = useState<Kind>('dev')
  const [subject, setSubject] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [jobId, setJobId] = useState('')
  const job = useQuery({
    queryKey: ['remote', 'session.new.job', jobId],
    enabled: Boolean(jobId),
    refetchInterval: (query) =>
      query.state.data &&
      ['done', 'failed'].includes(query.state.data.job.stage)
        ? false
        : 1_000,
    queryFn: async () =>
      (await remoteLink.rpc('session.new.job', { job: jobId })) as {
        job: Job
      },
  })
  const chosen = repo || repos.data?.repos[0]?.root || ''
  const current = job.data?.job
  // once listed (the agent answered its first prompt), open the session
  const listed =
    current?.stage === 'done' && current.worktree
      ? sessions.data?.sessions.find((row) => row.worktree === current.worktree)
      : undefined
  useEffect(() => {
    if (!listed) return
    recordVisit(listed.worktree || listed.cwd)
    onClose()
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: listed.id },
    })
  }, [listed, navigate, locale, onClose])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const busy = Boolean(jobId) && current?.stage !== 'failed'
  const name = subject.trim()
  const ready =
    Boolean(chosen) && Boolean(subject.trim()) && Boolean(prompt.trim())
  const submit = async () => {
    setError('')
    try {
      const res = (await remoteLink.write('session.new', {
        repo: chosen,
        type: kind,
        subject: subject.trim(),
        prompt: prompt.trim(),
      })) as { job: string }
      setJobId(res.job)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const kinds: Record<Kind, string> = {
    dev: t`dev: a long-lived workstation for parallel work`,
    task: t`task: a short focused change, reclaimed after delivery`,
    hotfix: t`hotfix: an urgent fix`,
  }
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/30"
      onClick={onClose}
      data-deck
    >
      <div
        role="dialog"
        aria-label={t`New session`}
        data-testid="new-session-sheet"
        data-write
        onClick={(event) => event.stopPropagation()}
        className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-brand-deck pb-[max(env(safe-area-inset-bottom),1rem)] text-brand-text"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-brand-deck px-4 pt-3 pb-2">
          <h2 className="text-[16px] font-semibold">{t`New session`}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t`Close`}
            className="inline-flex size-9 items-center justify-center rounded-full text-brand-muted"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4">
          <label className="grid gap-1 text-[13px] text-brand-muted">
            {t`Repository`}
            <select
              value={chosen}
              disabled={busy}
              onChange={(event) => setRepo(event.target.value)}
              className="min-h-11 rounded-[10px] bg-brand-surface px-3 text-[15px] text-brand-text"
            >
              {(repos.data?.repos ?? []).map((r) => (
                <option key={r.root} value={r.root}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-1">
            <Segmented
              label={t`Kind`}
              value={kind}
              onChange={(value) => !busy && setKind(value)}
              options={[
                { value: 'dev', label: 'dev' },
                { value: 'task', label: 'task' },
                { value: 'hotfix', label: 'hotfix' },
              ]}
            />
            <p className="px-1 text-[12px] text-brand-label">{kinds[kind]}</p>
          </div>
          <label className="grid gap-1 text-[13px] text-brand-muted">
            {t`Subject`}
            <input
              value={subject}
              disabled={busy}
              maxLength={60}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={t`e.g. phone-create`}
              className="min-h-11 rounded-[10px] bg-brand-surface px-3 text-[15px] text-brand-text outline-none placeholder:text-brand-label"
            />
            <span className="px-1 text-[12px] text-brand-label">
              {subject.trim()
                ? t`Worktree ${kind}-${name}, branch ${kind}/${name} (the host makes the final names; a taken one gets -2)`
                : t`Becomes the worktree and branch name, like Ctrl+k g at the desk.`}
            </span>
          </label>
          <label className="grid gap-1 text-[13px] text-brand-muted">
            {t`First message to the agent`}
            <textarea
              value={prompt}
              disabled={busy}
              rows={4}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t`What should it work on?`}
              className="rounded-[10px] bg-brand-surface px-3 py-2 text-[15px] text-brand-text outline-none placeholder:text-brand-label"
            />
          </label>
          {current ? (
            <p
              role="status"
              data-testid="new-session-stage"
              data-stage={current.stage}
              className={
                current.stage === 'failed'
                  ? 'rounded-[10px] bg-brand-error/10 px-3 py-2 text-[13px] text-brand-error'
                  : 'rounded-[10px] bg-brand-surface px-3 py-2 text-[13px]'
              }
            >
              {stageText(current)}
              {current.branch ? (
                <span className="block text-[12px] text-brand-label">
                  {current.branch}
                </span>
              ) : null}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-[13px] text-brand-error">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => void submit()}
            className="key-press min-h-12 rounded-[12px] bg-brand-text px-3 text-[15px] font-semibold text-brand-deck disabled:opacity-40"
          >
            {t`Create session`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
