// Guided in-session creation (/console/sessions/new): clicking + / pressing c
// or Ctrl+N enters the session view immediately without a blocking modal.
// Picking repo + agent and sending the first message starts the async host job
// and replaces the URL with /console/sessions/job-<id> right away.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Plus, SendHorizontal } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { BackButton } from '#/components/deck/back-button'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { trace } from '#/lib/client-trace'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'
import { jumpPending } from './console-jump-keys'
import { useSessions } from './console-sessions'
import { useDeviceState } from './device-state'
import {
  NewSessionPickerSheet,
  NewSessionSetupCard,
  useAgentSelection,
  useNewSessionAgentOptions,
  useNewSessionPicker,
} from './session-new-panels'
import {
  NEW_SESSION_ID,
  isNewSessionId,
  jobSessionId,
  rememberJobSeed,
  setNewSessionDraft,
  useNewSessionDraft,
} from './session-new-route'
import type { NewSessionPreset } from './session-new-route'
import { worktreeKey } from './session-order'

export type { NewSessionPreset }

type Repo = { root: string; label: string; visited?: number }

type NewSessionRequest = { round: number; preset?: NewSessionPreset }
let newSessionReq: NewSessionRequest = { round: 0 }
const newSessionListeners = new Set<() => void>()

/** Navigate into the guided 新会话 view; optional preset locks the group. */
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

const desktopEnterSends = () =>
  typeof window !== 'undefined' &&
  !window.matchMedia('(pointer: coarse)').matches

export function NewSessionButton() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const device = useDeviceState()
  const navigate = useNavigate()
  const { id: currentId } = useParams({ strict: false })
  const req = useNewSessionRequest()

  const openNew = useCallback(
    (preset?: NewSessionPreset) => {
      setNewSessionDraft({ preset })
      trace('session-new', {
        action: 'enter',
        mode: preset?.anchor ? 'group' : 'new',
      })
      void navigate({
        to: '/{-$locale}/console/sessions/$id',
        params: { locale: localeParam, id: NEW_SESSION_ID },
        replace: isNewSessionId(currentId),
      })
    },
    [navigate, localeParam, currentId],
  )

  const seenReq = useRef(0)
  useEffect(() => {
    if (req.round === 0 || req.round === seenReq.current) return
    seenReq.current = req.round
    openNew(req.preset)
  }, [req, openNew])

  // `c` on the list: Ctrl+k g at the desk. Ctrl/⌘+N too, even from the
  // composer — where the browser lets the page have it (an installed app
  // window); a plain tab may keep it for a new window, `c` still works.
  useEffect(() => {
    if (device.state !== 'approved') return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.code === 'KeyN'
      ) {
        if (/\/console\/sessions\/[^/]+$/.test(window.location.pathname)) return
        event.preventDefault()
        openNew()
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
      openNew()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [device.state, openNew])

  if (device.state !== 'approved') return null
  return (
    <Button
      variant="solid"
      type="button"
      onClick={() => openNew()}
      data-testid="new-session"
      title={t`New session (c)`}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 px-3 text-body md:min-h-9"
    >
      <Plus size={18} aria-hidden />
      <span className="sr-only md:not-sr-only">{t`New session`}</span>
    </Button>
  )
}

function useEscapeToBack(blocked: boolean, back: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || blocked) return
      if (document.querySelector('[role="dialog"]')) return
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLTextAreaElement &&
        target.value.trim().length > 0
      ) {
        target.blur()
        return
      }
      event.preventDefault()
      back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [blocked, back])
}

function NewSessionComposer({
  prompt,
  onPrompt,
  sending,
  ready,
  onSubmit,
}: {
  prompt: string
  onPrompt: (next: string) => void
  sending: boolean
  ready: boolean
  onSubmit: () => void
}) {
  const { t } = useLingui()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      className="sticky bottom-0 -mx-2.5 -mb-4 grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-brand-edge bg-brand-deck px-2.5 pt-2.5 pb-[max(calc(env(safe-area-inset-bottom)+0.25rem),0.75rem)] shadow-[0_-12px_24px_-16px_rgb(0_0_0/0.22)] md:-ml-2.5 md:mr-0 md:mb-0"
    >
      <Textarea
        value={prompt}
        disabled={sending}
        rows={3}
        autoFocus
        aria-label={t`What do you want to solve?`}
        onChange={(event) => onPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (
            event.key === 'Enter' &&
            (event.metaKey ||
              event.ctrlKey ||
              (!event.shiftKey && desktopEnterSends()))
          ) {
            event.preventDefault()
            onSubmit()
          }
        }}
        placeholder={t`What should it work on?`}
      />
      <div className="flex justify-end">
        <Button
          variant="solid"
          type="submit"
          disabled={!ready || sending}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 px-4 text-body whitespace-nowrap disabled:opacity-40"
        >
          <SendHorizontal size={16} aria-hidden />
          {t`Create session`}
        </Button>
      </div>
    </form>
  )
}

export function NewSessionGuidedView() {
  const seed = useNewSessionDraft()
  return <NewSessionGuidedForm key={seed.round} seed={seed} />
}

function NewSessionGuidedForm({
  seed,
}: {
  seed: ReturnType<typeof useNewSessionDraft>
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const mobile = !useIsWidePhoneFirst()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const back = useGoBack({
    to: '/{-$locale}/console/sessions',
    params: { locale: localeParam },
  })
  const { picker, openPicker, backToForm } = useNewSessionPicker()
  const preset = seed.preset
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
    seed.agent ?? lastAgent ?? preferredAgent,
  )
  const [repo, setRepo] = useState(
    () => seed.repo ?? readPreference(preferenceKeys.repo) ?? '',
  )
  const [prompt, setPrompt] = useState(() => seed.prompt ?? '')
  const [groupName, setGroupName] = useState<string | null>(
    () => seed.groupName ?? null,
  )
  const [error, setError] = useState(() => seed.notice ?? '')
  const submitting = useRef(false)
  const [sending, setSending] = useState(false)

  useEscapeToBack(Boolean(picker), back)

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
  const ready =
    Boolean(
      (anchor || chosen) &&
      prompt.trim() &&
      (!nameGroup || resolvedGroupName.trim()),
    ) &&
    (!agentProfiles.data || availableProfiles.length > 0)

  const submit = async () => {
    if (submitting.current || sending || !ready) return
    submitting.current = true
    setSending(true)
    setError('')
    try {
      const trimmed = prompt.trim()
      const reused = anchor
        ? sessionRows.find((row) => row.id === anchor)?.worktree
        : undefined
      const before = sessionRows
        .filter((row) => reused && row.worktree === reused)
        .map((row) => row.id)
      const res = (await hostWrite('session.new', {
        ...(anchor
          ? {
              anchor_session_id: anchor,
              group_name: nameGroup ? resolvedGroupName.trim() : undefined,
            }
          : { repo: chosen, new_group: true }),
        prompt: trimmed,
        agent_profile: selectedAgent || undefined,
      })) as { job: string }
      rememberSessionChoices(anchor ? undefined : chosen, selectedAgent)
      rememberJobSeed(res.job, {
        repo: chosen,
        repoLabel,
        agentProfile: selectedAgent,
        prompt: trimmed,
        groupName: nameGroup ? resolvedGroupName.trim() : preset?.group,
        anchor,
        preset,
        before,
      })
      trace('session-new', {
        action: 'submit',
        job: res.job,
        mode: anchor ? 'group' : 'new',
      })
      void queryClient.invalidateQueries({ queryKey: ['remote', 'sessions'] })
      void navigate({
        to: '/{-$locale}/console/sessions/$id',
        params: { locale: localeParam, id: jobSessionId(res.job) },
        replace: true,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  return (
    <div
      data-testid="new-session-view"
      className="flex min-h-full w-full flex-1 flex-col"
    >
      <header
        data-testid="new-session-header"
        className="sticky top-[env(safe-area-inset-top)] z-30 -mx-2.5 -mt-1 flex items-center gap-1 border-b border-brand-edge bg-brand-deck px-2.5 pt-1 pb-2 md:-ml-2.5 md:mr-0 md:mt-0"
      >
        <BackButton
          onClick={back}
          label={t({ message: 'Sessions', context: 'nav' })}
          className="-ml-2 md:hidden"
        />
        <h1 className="min-w-0 flex-1 truncate text-title leading-tight font-semibold">
          {anchor ? t`New session in this group` : t`New session`}
        </h1>
      </header>

      <div className="flex flex-1 flex-col gap-3 py-4">
        <NewSessionSetupCard
          mobile={mobile}
          sending={sending}
          picker={picker}
          onOpenPicker={openPicker}
          repositories={repositories}
          repo={chosen}
          repoLabel={repoLabel}
          onRepo={setRepo}
          group={preset?.group}
          nameGroup={nameGroup}
          resolvedGroupName={resolvedGroupName}
          onGroupName={setGroupName}
          showAgents={Boolean(agentProfiles.data?.profiles.length)}
          agentOptions={agentOptions}
          agentProfile={selectedAgent}
          onAgentProfile={setAgentProfile}
        />

        <p className="px-1 text-caption text-brand-label">
          {t`Send the first message below to create the workspace and start the agent.`}
        </p>

        {error ? (
          <p role="alert" className="px-1 text-caption text-brand-error">
            {error}
          </p>
        ) : null}
      </div>

      <NewSessionComposer
        prompt={prompt}
        onPrompt={setPrompt}
        sending={sending}
        ready={ready}
        onSubmit={() => void submit()}
      />

      <NewSessionPickerSheet
        picker={picker}
        repositories={repositories}
        repo={chosen}
        agentOptions={agentOptions}
        agentProfile={selectedAgent}
        onPickRepo={setRepo}
        onPickAgent={setAgentProfile}
        onBack={backToForm}
      />
    </div>
  )
}
