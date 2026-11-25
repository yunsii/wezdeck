// 新会话 — wezdeck's Ctrl+k g d/t/h from the phone: pick a repository, the
// lifecycle (dev / task / hotfix), a subject and the first message; the host
// creates the worktree and its agent in tmux and hands the agent the message
// (native session_new.go). Creation outlasts an RPC, so the host answers a
// job id and the sheet follows its stages, then opens the session once it
// is listed. `c` on the session list opens it with a keyboard.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Segmented } from '#/components/deck/segmented'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { recordVisit } from '#/lib/session-visits'
import { useSessions } from './console-sessions'
import { jumpPending } from './console-jump-keys'
import { useDeviceState } from './device-state'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { Select } from '#/components/ui/select'
import { Sheet } from '#/components/ui/sheet'

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
  // a fresh form per opening (key), while the sheet stays mounted on close
  // so it can play its exit
  const [round, setRound] = useState(0)
  const show = () => {
    setRound((n) => n + 1)
    setOpen(true)
  }
  // `c` on the list: Ctrl+k g at the desk. Ctrl/⌘+N too, even from the
  // composer — where the browser lets the page have it (an installed app
  // window); a plain tab may keep it for a new window, `c` still works.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.code === 'KeyN'
      ) {
        event.preventDefault()
        show()
        return
      }
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
      show()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (device.state !== 'approved') return null
  return (
    <>
      <Button
        variant="solid"
        type="button"
        onClick={show}
        data-testid="new-session"
        title={t`New session (c)`}
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 px-3 text-body md:min-h-9"
      >
        <Plus size={18} aria-hidden />
        <span className="sr-only md:not-sr-only">{t`New session`}</span>
      </Button>
      {round > 0 ? (
        <NewSessionSheet
          key={round}
          open={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function NewSessionSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const stageText = useStageText()
  const repos = useQuery({
    queryKey: ['remote', 'repos'],
    queryFn: async () =>
      (await hostRead('repos', {})) as { repos: Array<Repo> },
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
      (await hostRead('session.new.job', { job: jobId })) as {
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
  // once per job: `listed` is a new row on every sessions poll, and this
  // sheet stays mounted beside the session on a wide window, so without
  // this each poll opened the new session again — switching to another one
  // bounced straight back (2026-11-25)
  const opened = useRef('')
  useEffect(() => {
    if (!listed || opened.current === jobId) return
    opened.current = jobId
    recordVisit(listed.worktree || listed.cwd)
    onClose()
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: listed.id },
    })
  }, [listed, jobId, navigate, locale, onClose])
  const busy = Boolean(jobId) && current?.stage !== 'failed'
  const name = subject.trim()
  const ready =
    Boolean(chosen) && Boolean(subject.trim()) && Boolean(prompt.trim())
  const submit = async () => {
    setError('')
    try {
      const res = (await hostWrite('session.new', {
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
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t`New session`}
      testId="new-session-sheet"
      write
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4">
        <label className="grid gap-1 text-caption text-brand-muted">
          {t`Repository`}
          <Select
            size="lg"
            value={chosen}
            disabled={busy}
            onValueChange={setRepo}
            options={(repos.data?.repos ?? []).map((r) => ({
              value: r.root,
              label: r.label,
            }))}
          />
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
          <p className="px-1 text-meta text-brand-label">{kinds[kind]}</p>
        </div>
        <label className="grid gap-1 text-caption text-brand-muted">
          {t`Subject`}
          <Input
            variant="field"
            value={subject}
            disabled={busy}
            maxLength={60}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t`e.g. phone-create`}
          />
          <span className="px-1 text-meta text-brand-label">
            {subject.trim()
              ? t`Worktree ${kind}-${name}, branch ${kind}/${name} (the host makes the final names; a taken one gets -2)`
              : t`Becomes the worktree and branch name, like Ctrl+k g at the desk.`}
          </span>
        </label>
        <label className="grid gap-1 text-caption text-brand-muted">
          {t`First message to the agent`}
          <Textarea
            value={prompt}
            disabled={busy}
            rows={4}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t`What should it work on?`}
          />
        </label>
        {current ? (
          <p
            role="status"
            data-testid="new-session-stage"
            data-stage={current.stage}
            className={
              current.stage === 'failed'
                ? 'rounded-xl bg-brand-error/10 px-3 py-2 text-caption text-brand-error'
                : 'rounded-xl bg-brand-surface px-3 py-2 text-caption'
            }
          >
            {stageText(current)}
            {current.branch ? (
              <span className="block text-meta text-brand-label">
                {current.branch}
              </span>
            ) : null}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-caption text-brand-error">
            {error}
          </p>
        ) : null}
        <Button
          variant="solid"
          type="button"
          disabled={!ready || busy}
          onClick={() => void submit()}
          className="min-h-12 px-3 text-body disabled:opacity-40"
        >
          {t`Create session`}
        </Button>
      </div>
    </Sheet>
  )
}
