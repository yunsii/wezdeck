// The host allocates the checkout and starts the agent as an observable job.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { recordVisit } from '#/lib/session-visits'
import { useSessions } from './console-sessions'
import { worktreeKey } from './session-order'
import { jumpPending } from './console-jump-keys'
import { useDeviceState } from './device-state'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import {
  ComposeLayer,
  NewSessionPicker,
  useAgentSelection,
  useNewSessionAgentOptions,
  useNewSessionPicker,
  useStageText,
} from './session-new-panels'

type Repo = { root: string; label: string; visited?: number }

export type NewSessionPreset = { repo: string; anchor: string; group: string }

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

export function suggestGroupName(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]
  if (/^(?:https?:\/\/|```|[<{[])/.test(firstLine)) return ''
  const subject = firstLine
    .replace(/^\s*(?:[-*] |#+\s+)/, '')
    .replace(/^(?:请(?:帮我)?|帮我|please\s+|could you\s+)/i, '')
    .split(/[。！？；]|[.!?;](?:\s|$)/, 1)[0]
    .trim()
  if (
    /^(?:继续|好的|开始|continue|please continue|go ahead|ok)$/i.test(subject)
  )
    return ''
  const characters = Array.from(subject)
  return characters.length <= 32
    ? subject
    : characters.slice(0, 31).join('') + '…'
}

type Job = {
  job: string
  stage:
    'creating' | 'starting' | 'waiting_trust' | 'sending' | 'done' | 'failed'
  /** new direction, one more parallel slot, or an idle slot reused */
  mode?: 'new' | 'parallel' | 'reuse' | 'group'
  worktree?: string
  branch?: string
  session_id?: string
  error?: string
  warning?: string
}

const preferenceKeys = {
  repo: 'wezdeck.new-session.repo',
  agent: 'wezdeck.new-session.agent',
}

function readPreference(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function rememberSessionChoices(repo: string | undefined, agent: string) {
  try {
    if (repo) localStorage.setItem(preferenceKeys.repo, repo)
    localStorage.setItem(preferenceKeys.agent, agent)
  } catch {
    // Creating a session still works if the browser blocks local storage.
  }
}

const pendingJobKey = 'wezdeck.pending-new-session-job'

function isUnknownJob(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes('session.new.job: unknown job')
  )
}

function useAutoOpenNewSession({
  current,
  jobId,
  sessions,
  before,
  onClose,
}: {
  current?: Job
  jobId: string
  sessions?: Array<{ id: string; worktree?: string; cwd: string }>
  before: Set<string>
  onClose: () => void
}) {
  const { locale } = useLocale()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const opened = useRef('')
  useEffect(() => {
    if (current?.stage === 'failed') sessionStorage.removeItem(pendingJobKey)
  }, [current?.stage])
  const listed =
    current?.stage === 'done' && current.worktree
      ? sessions?.find(
          (row) => row.worktree === current.worktree && !before.has(row.id),
        )
      : undefined
  const targetId =
    current?.stage === 'done' ? current.session_id || listed?.id : undefined
  // A poll must not reopen a completed job after the user switches away.
  useEffect(() => {
    if (!targetId || opened.current === jobId) return
    opened.current = jobId
    sessionStorage.removeItem(pendingJobKey)
    const visitPath = listed?.worktree || listed?.cwd || current?.worktree
    if (visitPath) recordVisit(visitPath)
    if (current?.warning) toast.warning(current.warning)
    void queryClient.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    onClose()
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: targetId },
    })
  }, [
    targetId,
    listed,
    current?.worktree,
    current?.warning,
    jobId,
    navigate,
    locale,
    onClose,
    queryClient,
  ])
}

function usePendingJobRecovery(
  jobId: string,
  jobError: unknown,
  setJobId: (id: string) => void,
  setError: (message: string) => void,
) {
  const { t } = useLingui()
  useEffect(() => {
    if (!jobId || !isUnknownJob(jobError)) return
    sessionStorage.removeItem(pendingJobKey)
    setJobId('')
    setError(t`The previous session request expired. Start a new one.`)
  }, [jobId, jobError, setJobId, setError, t])
}

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
  // The group menu opens the form once per request.
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
  const mobile = !useIsWidePhoneFirst()
  const stageText = useStageText()
  const { picker, openPicker, backToForm } = useNewSessionPicker()
  const anchor = preset?.anchor
  const repos = useQuery({
    queryKey: ['remote', 'repos'],
    queryFn: async () =>
      (await hostRead('repos', {})) as { repos: Array<Repo> },
  })
  const sessions = useSessions()
  const agentProfiles = useAgentProfiles()
  const [preferredAgent] = usePreferredAgentProfile()
  const [lastAgent] = useState(() => readPreference(preferenceKeys.agent))
  const {
    available: availableProfiles,
    defaultDisabled,
    selected: selectedAgent,
    setPicked: setAgentProfile,
  } = useAgentSelection(
    agentProfiles.data?.profiles ?? [],
    lastAgent ?? preferredAgent,
  )
  const [repo, setRepo] = useState(
    () => readPreference(preferenceKeys.repo) ?? '',
  )
  const submitting = useRef(false)
  const [sending, setSending] = useState(false)
  const [pending] = useState(readPendingJob)
  const before = useRef<Set<string>>(new Set(pending?.before ?? []))
  const [prompt, setPrompt] = useState('')
  const [groupName, setGroupName] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [jobId, setJobId] = useState(pending?.job ?? '')
  const { trust, trusting } = useAgyTrust(jobId, setError)
  const job = useQuery({
    queryKey: ['remote', 'session.new.job', jobId],
    enabled: Boolean(jobId),
    retry: (count, failure) => !isUnknownJob(failure) && count < 2,
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
  const repositories = repos.data?.repos ?? []
  const agentOptions = useNewSessionAgentOptions(
    agentProfiles.data?.profiles ?? [],
    defaultDisabled,
  )
  const chosen =
    preset?.repo ??
    (repositories.some(({ root }) => root === repo)
      ? repo
      : repositories[0]?.root || '')
  const repoLabel =
    repositories.find((r) => r.root === chosen)?.label ||
    chosen.split('/').pop() ||
    ''
  const sessionRows = sessions.data?.sessions ?? []
  const source = sessionRows.find((row) => row.id === anchor)
  const firstSibling =
    source &&
    sessionRows.filter((row) => worktreeKey(row) === worktreeKey(source))
      .length === 1
  const managedName =
    source &&
    !/^(ticket|claw)-/.test(worktreeKey(source).split('/').at(-1) ?? '')
  const nameGroup = Boolean(firstSibling && managedName)
  const suggestedName =
    suggestGroupName(source?.title ?? '') ||
    suggestGroupName(source?.last_prompt ?? '') ||
    suggestGroupName(source?.worktree_description ?? '') ||
    t`New session group`
  const resolvedGroupName = groupName ?? suggestedName
  const current = job.data?.job
  usePendingJobRecovery(jobId, job.error, setJobId, setError)
  useAutoOpenNewSession({
    current,
    jobId,
    sessions: sessions.data?.sessions,
    before: before.current,
    onClose,
  })
  const busy = sending || (Boolean(jobId) && current?.stage !== 'failed')
  const ready =
    Boolean(
      (anchor || chosen) &&
      prompt.trim() &&
      (!nameGroup || resolvedGroupName.trim()),
    ) &&
    (!agentProfiles.data || availableProfiles.length > 0)
  const submit = async () => {
    if (submitting.current || busy || !ready) return
    submitting.current = true
    setSending(true)
    setError('')
    try {
      const reused = anchor
        ? sessions.data?.sessions.find((row) => row.id === anchor)?.worktree
        : undefined
      before.current = new Set(
        (sessions.data?.sessions ?? [])
          .filter((row) => reused && row.worktree === reused)
          .map((row) => row.id),
      )
      const res = (await hostWrite('session.new', {
        ...(anchor
          ? {
              anchor_session_id: anchor,
              group_name: nameGroup ? resolvedGroupName.trim() : undefined,
            }
          : { repo: chosen, new_group: true }),
        prompt: prompt.trim(),
        agent_profile: selectedAgent || undefined,
      })) as { job: string }
      rememberSessionChoices(anchor ? undefined : chosen, selectedAgent)
      sessionStorage.setItem(
        pendingJobKey,
        JSON.stringify({ job: res.job, before: [...before.current] }),
      )
      setJobId(res.job)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      submitting.current = false
      setSending(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (picker) backToForm()
          else onClose()
        }
      }}
      title={
        picker === 'repo'
          ? t`Repository`
          : picker === 'agent'
            ? t`Agent`
            : anchor
              ? t`New session in this group`
              : t`New session`
      }
      onBack={picker ? () => backToForm() : undefined}
      testId="new-session-sheet"
      write
    >
      <div
        hidden={Boolean(picker)}
        className={
          picker ? 'hidden' : 'grid grid-cols-[minmax(0,1fr)] gap-3 px-4'
        }
      >
        <ComposeLayer
          busy={busy}
          repoLabel={repoLabel}
          repositories={repositories}
          repo={chosen}
          onRepo={setRepo}
          group={preset?.group}
          groupName={nameGroup ? resolvedGroupName : undefined}
          onGroupName={setGroupName}
          prompt={prompt}
          setPrompt={setPrompt}
          current={current}
          stageText={stageText}
          error={error}
          ready={ready}
          onSubmit={() => void submit()}
          onTrust={() => void trust()}
          trusting={trusting}
          agentProfiles={agentProfiles.data?.profiles ?? []}
          agentOptions={agentOptions}
          agentProfile={selectedAgent}
          onAgentProfile={setAgentProfile}
          mobile={mobile}
          onOpenPicker={openPicker}
        />
      </div>
      {picker ? (
        <NewSessionPicker
          key={picker}
          title={picker === 'repo' ? t`Repository` : t`Agent`}
          options={
            picker === 'repo'
              ? repositories.map(({ root, label }) => ({ value: root, label }))
              : agentOptions
          }
          value={picker === 'repo' ? chosen : selectedAgent}
          onPick={(value) => {
            if (picker === 'repo') setRepo(value)
            else setAgentProfile(value)
            backToForm('pick')
          }}
        />
      ) : null}
    </Sheet>
  )
}
