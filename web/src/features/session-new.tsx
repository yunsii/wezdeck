// 新会话 — wezdeck's Ctrl+k g d from the phone, layered so the common path
// stays one screen: a location summary bar + the first message. Tap the bar
// for the place layer (repository + directions with idle/busy); "+ New
// direction" opens a third layer for the name and purpose. The host creates
// or reuses the worktree (native session_new.go / workstations.go), starts
// its agent in tmux and hands it the message. Creation outlasts an RPC, so
// the host answers a job id and the sheet follows its stages, then opens
// the session once it is listed. `c` on the session list opens it with a
// keyboard.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { BackButton } from '#/components/deck/back-button'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { recordVisit } from '#/lib/session-visits'
import { useSessions } from './console-sessions'
import { jumpPending } from './console-jump-keys'
import { useDeviceState } from './device-state'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import {
  defaultDirection,
  useDirectionPlan,
  useDirectionPlanShort,
  useDirections,
} from './session-new-direction'
import type { DirectionPick } from './session-new-direction'
import {
  ComposeLayer,
  NewDirectionLayer,
  PlaceLayer,
} from './session-new-panels'

type Repo = { root: string; label: string; visited?: number }

/** compose = message; place = repo + directions; new = name a new direction */
type Layer = 'compose' | 'place' | 'new'

/** open 新会话 already on a repo + direction (chat row 「新一轮」) */
export type NewSessionPreset = { repo: string; direction: string }

type NewSessionRequest = { round: number; preset?: NewSessionPreset }
let newSessionReq: NewSessionRequest = { round: 0 }
const newSessionListeners = new Set<() => void>()

/** open the 新会话 sheet; optional preset locks the place bar to that chat */
export function requestNewSession(preset?: NewSessionPreset) {
  newSessionReq = { round: newSessionReq.round + 1, preset }
  for (const listener of newSessionListeners) listener()
}

function useNewSessionRequest() {
  return useSyncExternalStore(
    (listener) => {
      newSessionListeners.add(listener)
      return () => newSessionListeners.delete(listener)
    },
    () => newSessionReq,
    () => newSessionReq,
  )
}

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
  stage:
    'creating' | 'starting' | 'waiting_trust' | 'sending' | 'done' | 'failed'
  /** new direction, one more parallel slot, or an idle slot reused */
  mode?: 'new' | 'parallel' | 'reuse'
  worktree?: string
  branch?: string
  error?: string
}

const pendingJobKey = 'wezdeck.pending-new-session-job'

function readPendingJob(): { job: string; before: string[] } | null {
  if (typeof window === 'undefined') return null
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(pendingJobKey) || 'null',
    )
    if (
      typeof value === 'object' &&
      value !== null &&
      'job' in value &&
      typeof value.job === 'string' &&
      'before' in value &&
      Array.isArray(value.before) &&
      value.before.every((id) => typeof id === 'string')
    )
      return { job: value.job, before: value.before }
  } catch {
    sessionStorage.removeItem(pendingJobKey)
  }
  return null
}

function useStageText() {
  const { t } = useLingui()
  return (job: Pick<Job, 'stage' | 'mode' | 'error'>) => {
    const reason = job.error ?? ''
    return job.stage === 'creating'
      ? job.mode === 'reuse'
        ? t`Resetting the workstation onto the latest main branch…`
        : t`Creating the worktree…`
      : job.stage === 'starting'
        ? t`Starting the agent…`
        : job.stage === 'waiting_trust'
          ? t`Agy is waiting for this worktree to be trusted.`
          : job.stage === 'sending'
            ? t`Sending the first message…`
            : job.stage === 'done'
              ? t`Started. Opening the session when the agent picks it up…`
              : t`Could not create it: ${reason}`
  }
}

function useAgyTrust(jobId: string, setError: (message: string) => void) {
  const [trusting, setTrusting] = useState(false)
  const trust = async () => {
    setTrusting(true)
    setError('')
    try {
      await hostWrite('session.new.trust', { job: jobId, confirm: true })
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setTrusting(false)
    }
  }
  return { trust, trusting }
}

function useSheetTitle(layer: Layer, placeLocked: boolean, onBack: () => void) {
  const { t } = useLingui()
  if (layer === 'compose') return placeLocked ? t`New round` : t`New session`
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <BackButton
        label={layer === 'new' ? t`Back to place` : t`Back to message`}
        onClick={onBack}
        className="-ml-2"
      />
      <span className="truncate">
        {layer === 'place' ? t`Where` : t`New direction`}
      </span>
    </span>
  )
}

export function NewSessionButton() {
  const { t } = useLingui()
  const device = useDeviceState()
  const req = useNewSessionRequest()
  const [open, setOpen] = useState(false)
  // a fresh form per opening (key), while the sheet stays mounted on close
  // so it can play its exit
  const [round, setRound] = useState(0)
  const [preset, setPreset] = useState<NewSessionPreset | undefined>()
  const show = (next?: NewSessionPreset) => {
    setPreset(next)
    setRound((n) => n + 1)
    setOpen(true)
  }
  // chat row 「新一轮」 / requestNewSession — only on a new request id
  const seenReq = useRef(0)
  useEffect(() => {
    if (req.round === 0 || req.round === seenReq.current) return
    seenReq.current = req.round
    show(req.preset)
  }, [req])
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
        onClick={() => show()}
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
          preset={preset}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function NewSessionSheet({
  open,
  onClose,
  preset,
}: {
  open: boolean
  onClose: () => void
  preset?: NewSessionPreset
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const stageText = useStageText()
  const plan = useDirectionPlan()
  const planShort = useDirectionPlanShort()
  const placeLocked = Boolean(preset?.repo && preset.direction)
  const repos = useQuery({
    queryKey: ['remote', 'repos'],
    queryFn: async () =>
      (await hostRead('repos', {})) as { repos: Array<Repo> },
  })
  const sessions = useSessions()
  const agentProfiles = useAgentProfiles()
  const [preferredAgent] = usePreferredAgentProfile()
  const [agentProfile, setAgentProfile] = useState('')
  const selectedAgent = agentProfiles.data?.profiles.some(
    (profile) => profile.id === (agentProfile || preferredAgent),
  )
    ? agentProfile || preferredAgent
    : ''
  const [layer, setLayer] = useState<Layer>('compose')
  const [repo, setRepo] = useState(preset?.repo ?? '')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<DirectionPick | null>(
    preset?.direction ?? null,
  )
  const [pending] = useState(readPendingJob)
  const before = useRef<Set<string>>(new Set(pending?.before ?? []))
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [jobId, setJobId] = useState(pending?.job ?? '')
  const { trust, trusting } = useAgyTrust(jobId, setError)
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
  const repoLabel =
    (repos.data?.repos ?? []).find((r) => r.root === chosen)?.label ||
    chosen.split('/').pop() ||
    ''
  const directions = useDirections(chosen)
  const dirs = directions.data?.directions ?? []
  const pick = picked ?? defaultDirection(dirs)
  const pickedDir = dirs.find((d) => d.name === pick)
  const isNew = pick === ''
  const current = job.data?.job
  useEffect(() => {
    if (current?.stage === 'done' || current?.stage === 'failed')
      sessionStorage.removeItem(pendingJobKey)
  }, [current?.stage])
  const listed =
    current?.stage === 'done' && current.worktree
      ? sessions.data?.sessions.find(
          (row) =>
            row.worktree === current.worktree && !before.current.has(row.id),
        )
      : undefined
  // A poll must not reopen a completed job after the user switches away.
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
  // Esc backs a layer before the drawer closes the sheet
  useEffect(() => {
    if (!open || layer === 'compose') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setLayer(layer === 'new' ? 'place' : 'compose')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, layer])
  const busy = Boolean(jobId) && current?.stage !== 'failed'
  const slug = workstationSlug(name)
  const ready =
    Boolean(chosen) && Boolean(pick || slug) && Boolean(prompt.trim())
  const locationClause = isNew
    ? slug || t`+ New direction`
    : pick || t`Direction`
  const locationHint = planShort(pickedDir, isNew)
  const submit = async () => {
    setError('')
    try {
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
        agent_profile: selectedAgent || undefined,
      })) as { job: string }
      sessionStorage.setItem(
        pendingJobKey,
        JSON.stringify({ job: res.job, before: [...before.current] }),
      )
      setJobId(res.job)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const title = useSheetTitle(layer, placeLocked, () =>
    setLayer(layer === 'new' ? 'place' : 'compose'),
  )
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={title}
      testId="new-session-sheet"
      write
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4">
        {layer === 'compose' ? (
          <ComposeLayer
            busy={busy}
            repoLabel={repoLabel}
            locationClause={locationClause}
            locationHint={locationHint}
            placeLocked={placeLocked}
            prompt={prompt}
            setPrompt={setPrompt}
            isNew={isNew}
            name={name}
            slug={slug}
            current={current}
            stageText={stageText}
            error={error}
            ready={ready}
            onPlace={() => {
              if (!placeLocked) setLayer('place')
            }}
            onSubmit={() => void submit()}
            onTrust={() => void trust()}
            trusting={trusting}
            agentProfiles={agentProfiles.data?.profiles ?? []}
            agentProfile={selectedAgent}
            onAgentProfile={setAgentProfile}
          />
        ) : null}
        {layer === 'place' && !placeLocked ? (
          <PlaceLayer
            busy={busy}
            chosen={chosen}
            repos={repos.data?.repos ?? []}
            dirs={dirs}
            pick={pick}
            pickedDir={pickedDir}
            plan={plan}
            onRepo={(next) => {
              setRepo(next)
              setPicked(null)
              setName('')
              setDescription('')
            }}
            onPick={(next) => {
              setPicked(next)
              if (next === '') {
                setLayer('new')
                return
              }
              setName('')
              setDescription('')
              setLayer('compose')
            }}
          />
        ) : null}
        {layer === 'new' ? (
          <NewDirectionLayer
            busy={busy}
            name={name}
            slug={slug}
            setName={setName}
            description={description}
            setDescription={setDescription}
            onDone={() => setLayer('compose')}
          />
        ) : null}
      </div>
    </Sheet>
  )
}
