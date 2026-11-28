// Guided in-session creation (/console/sessions/new): clicking + / pressing c
// or Ctrl+N enters the session view immediately without a blocking modal.
// Picking repo + agent and sending the first message starts the async host job
// and replaces the URL with /console/sessions/job-<id> right away.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Plus, SendHorizontal } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { trace } from '#/lib/client-trace'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { hostWrite } from '#/lib/runtime-client'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { useAgentProfiles, usePreferredAgentProfile } from './agent-profiles'
import { useRepositories } from './repo-agent-settings'
import { NewSessionHeader } from './session-new-header'
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

const preferenceKeys = { repo: 'wezdeck.new-session.repo' }

function readPreference(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function rememberSessionChoices(repo: string | undefined) {
  try {
    if (repo) localStorage.setItem(preferenceKeys.repo, repo)
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
  const canCreate = device.state === 'approved'
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
    if (!canCreate) return
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
  }, [canCreate, openNew])

  return (
    <Button
      variant="solid"
      type="button"
      disabled={!canCreate}
      onClick={() => openNew()}
      data-testid="new-session"
      title={t`New session (c)`}
      className={cn(
        'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 px-3 text-body md:min-h-9',
        !canCreate && 'invisible',
      )}
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
      data-testid="new-session-composer"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)]"
    >
      <div
        data-text-field
        className="grid min-w-0 rounded-2xl bg-brand-surface"
      >
        <Textarea
          variant="bare"
          value={prompt}
          disabled={sending}
          rows={4}
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
          className="min-h-28 max-h-60 w-full resize-none bg-transparent px-3.5 pt-3 pb-2 text-body text-brand-text outline-none [field-sizing:content] placeholder:text-brand-label disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-3 px-3 pt-1 pb-2.5">
          <span className="hidden text-meta text-brand-label md:inline">
            {t`Enter to send · Shift+Enter for newline`}
          </span>
          <Button
            variant="solid"
            type="submit"
            disabled={!ready || sending}
            className="ml-auto inline-flex min-h-10 items-center justify-center gap-1.5 px-4 text-body whitespace-nowrap disabled:opacity-40 md:min-h-9"
          >
            <SendHorizontal size={16} aria-hidden />
            {t`Create session`}
          </Button>
        </div>
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
  const repos = useRepositories()
  const sessions = useSessions()
  const agentProfiles = useAgentProfiles()
  const [preferredAgent] = usePreferredAgentProfile()
  const {
    available: availableProfiles,
    selected: selectedAgent,
    setPicked: setAgentProfile,
  } = useAgentSelection(
    agentProfiles.data?.profiles ?? [],
    seed.agent ?? preferredAgent,
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
  const chosen =
    preset?.repo ??
    (repositories.some(({ root }) => root === repo)
      ? repo
      : repositories[0]?.root || '')
  const repoLabel =
    repositories.find((r) => r.root === chosen)?.label ||
    chosen.split('/').pop() ||
    ''
  const repoDefault =
    repositories.find((r) => r.root === chosen)?.agent_profile || ''
  const settingsError = Boolean(repos.data?.settings_error)
  const defaultDisabled = Boolean(
    agentProfiles.data?.profiles.some(
      (profile) =>
        profile.id === repoDefault &&
        (profile.disabled ||
          (profile.id === 'claude_kimi' && !profile.configured)),
    ),
  )
  const selectableAgentOptions = useNewSessionAgentOptions(
    agentProfiles.data?.profiles ?? [],
    defaultDisabled || settingsError,
    repoDefault,
  )
  const agentOptions = settingsError
    ? [
        { value: '', label: t`Choose an agent`, disabled: true },
        ...selectableAgentOptions,
      ]
    : selectableAgentOptions
  const chosenAgent =
    selectedAgent ||
    (defaultDisabled && !settingsError ? availableProfiles[0]?.id || '' : '')
  const effectiveAgent = chosenAgent || (settingsError ? '' : repoDefault)
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
    (!agentProfiles.data || availableProfiles.length > 0) &&
    (!defaultDisabled || Boolean(chosenAgent)) &&
    (!settingsError || Boolean(selectedAgent))

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
        agent_profile: chosenAgent || undefined,
      })) as { job: string }
      rememberSessionChoices(anchor ? undefined : chosen)
      rememberJobSeed(res.job, {
        repo: chosen,
        repoLabel,
        agentProfile: effectiveAgent,
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
      className="flex min-h-full w-full flex-1 flex-col md:h-full md:min-h-0"
    >
      <NewSessionHeader back={back} anchor={anchor} agent={effectiveAgent} />

      <div className="flex flex-1 flex-col py-4 md:min-h-0 md:overflow-y-auto md:overscroll-contain md:px-6 md:py-10">
        <div className="mx-auto grid w-full max-w-2xl gap-4 md:my-auto md:pb-12">
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
            agentProfile={chosenAgent}
            onAgentProfile={setAgentProfile}
          />

          {settingsError ? (
            <p role="alert" className="px-1 text-caption text-brand-error">
              {t`Repository agent settings could not be read. Select an agent explicitly.`}
            </p>
          ) : null}

          <NewSessionComposer
            prompt={prompt}
            onPrompt={setPrompt}
            sending={sending}
            ready={ready}
            onSubmit={() => void submit()}
          />

          {error ? (
            <p role="alert" className="px-1 text-caption text-brand-error">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <NewSessionPickerSheet
        picker={picker}
        repositories={repositories}
        repo={chosen}
        agentOptions={agentOptions}
        agentProfile={chosenAgent}
        onPickRepo={setRepo}
        onPickAgent={setAgentProfile}
        onBack={backToForm}
      />
    </div>
  )
}
