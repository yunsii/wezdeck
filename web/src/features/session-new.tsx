// 新会话 — wezdeck's Ctrl+k g d from the phone: pick a repository, name a
// new workstation (one direction: ux, ci, i18n …) with a one-line purpose,
// and write the first message; the host creates the worktree (directory
// <name>, branch dev/<name>, the purpose as its git branch description) and
// its agent in tmux and hands the agent the message (native
// session_new.go). Creation outlasts an RPC, so the host answers a
// job id and the sheet follows its stages, then opens the session once it
// is listed. `c` on the session list opens it with a keyboard.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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
import {
  DirectionPicker,
  defaultDirection,
  useDirectionPlan,
  useDirections,
} from './session-new-direction'
import type { DirectionPick } from './session-new-direction'

type Repo = { root: string; label: string; visited?: number }

/**
 * The directory / branch name the host makes of a typed name
 * (open-task-window → wt_slugify): a dev- or dev/ typed out of habit goes,
 * then lower case, every run of other characters one '-', trimmed. "" when
 * nothing usable is left (a name of only Chinese, say).
 */
export function workstationSlug(name: string) {
  return name
    .trim()
    .replace(/^dev[-/]/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
type Job = {
  job: string
  stage: 'creating' | 'starting' | 'sending' | 'done' | 'failed'
  /** new direction, one more parallel slot, or an idle slot reused */
  mode?: 'new' | 'parallel' | 'reuse'
  worktree?: string
  branch?: string
  error?: string
}

function useStageText() {
  const { t } = useLingui()
  return (job: Job) => {
    const reason = job.error ?? ''
    return job.stage === 'creating'
      ? job.mode === 'reuse'
        ? t`Resetting the workstation onto the latest main branch…`
        : t`Creating the worktree…`
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
  const [name, setName] = useState('')
  // the chosen direction: null until picked (then the default applies),
  // '' for a new one
  const [picked, setPicked] = useState<DirectionPick | null>(null)
  // sessions already in the worktree when submitted: a reused one has its
  // last round listed, which is not the new session
  const before = useRef<Set<string>>(new Set())
  const [description, setDescription] = useState('')
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
  const directions = useDirections(chosen)
  const dirs = directions.data?.directions ?? []
  const pick = picked ?? defaultDirection(dirs)
  const pickedDir = dirs.find((d) => d.name === pick)
  const plan = useDirectionPlan()
  const current = job.data?.job
  // once listed (the agent answered its first prompt), open the session
  const listed =
    current?.stage === 'done' && current.worktree
      ? sessions.data?.sessions.find(
          (row) =>
            row.worktree === current.worktree && !before.current.has(row.id),
        )
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
  const slug = workstationSlug(name)
  const ready =
    Boolean(chosen) && Boolean(pick || slug) && Boolean(prompt.trim())
  const submit = async () => {
    setError('')
    try {
      // the workstation a reuse will pick: the most recent idle one (host
      // workstations.go idleSlot); its listed sessions are not the new one
      const reused = pickedDir?.slots.find((s) => s.state === 'idle')?.path
      before.current = new Set(
        (sessions.data?.sessions ?? [])
          .filter((row) => reused && row.worktree === reused)
          .map((row) => row.id),
      )
      const res = (await hostWrite('session.new', {
        repo: chosen,
        name: pick || name.trim(),
        description: pick ? '' : description.trim(),
        prompt: prompt.trim(),
      })) as { job: string }
      setJobId(res.job)
    } catch (e) {
      setError((e as Error).message)
    }
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
        <div className="grid gap-1 text-caption text-brand-muted">
          {t`Direction`}
          <DirectionPicker
            directions={dirs}
            value={pick}
            onChange={setPicked}
            disabled={busy}
          />
          {pickedDir ? (
            <span
              className="px-1 text-meta text-brand-label"
              data-testid="new-session-plan"
            >
              {plan(pickedDir)}
            </span>
          ) : null}
        </div>
        {pick === '' ? (
          <>
            <label className="grid gap-1 text-caption text-brand-muted">
              {t`New direction`}
              <Input
                variant="field"
                value={name}
                disabled={busy}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                placeholder={t`e.g. ux, ci, i18n`}
              />
              <span
                className={
                  name.trim() && !slug
                    ? 'px-1 text-meta text-brand-error'
                    : 'px-1 text-meta text-brand-label'
                }
                data-testid="new-session-slug"
              >
                {!name.trim()
                  ? t`A new workstation for this direction, off the latest main branch, like Ctrl+k g d at the desk.`
                  : slug
                    ? t`Worktree ${slug}, branch dev/${slug} (a taken name gets -2)`
                    : t`Needs letters or digits: it becomes the directory and branch. Put the rest in the description.`}
              </span>
            </label>
            <label className="grid gap-1 text-caption text-brand-muted">
              {t`Description`}
              <Input
                variant="field"
                value={description}
                disabled={busy}
                maxLength={120}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t`What this workstation is for, one line`}
              />
            </label>
          </>
        ) : null}
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
