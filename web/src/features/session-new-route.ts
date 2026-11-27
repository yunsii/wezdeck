// Virtual session ids and lightweight client-side seed state for in-session
// guided creation (/console/sessions/new → /console/sessions/job-<id> → real id).
import { useSyncExternalStore } from 'react'

export const NEW_SESSION_ID = 'new'
export const JOB_SESSION_PREFIX = 'job-'

export function isNewSessionId(id?: string): boolean {
  return id === NEW_SESSION_ID
}

export function jobIdFromSessionId(id?: string): string | null {
  if (!id || !id.startsWith(JOB_SESSION_PREFIX)) return null
  const jobId = id.slice(JOB_SESSION_PREFIX.length)
  return jobId ? jobId : null
}

export function isVirtualSessionId(id?: string): boolean {
  return isNewSessionId(id) || jobIdFromSessionId(id) !== null
}

export function jobSessionId(jobId: string): string {
  return `${JOB_SESSION_PREFIX}${jobId}`
}

export type NewSessionStage =
  'creating' | 'starting' | 'waiting_trust' | 'sending' | 'done' | 'failed'

export type NewSessionJob = {
  job: string
  stage: NewSessionStage
  mode?: 'new' | 'parallel' | 'reuse' | 'group'
  repo?: string
  repo_label?: string
  agent_profile?: string
  prompt?: string
  group_name?: string
  anchor_session_id?: string
  created_at?: number
  worktree?: string
  branch?: string
  session_id?: string
  error?: string
  warning?: string
}

export type NewSessionPreset = { repo: string; anchor: string; group: string }

export type NewSessionDraftSeed = {
  round: number
  preset?: NewSessionPreset
  repo?: string
  agent?: string
  prompt?: string
  groupName?: string
  notice?: string
}

export type NewSessionJobSeed = {
  repo?: string
  repoLabel?: string
  agentProfile?: string
  prompt?: string
  groupName?: string
  anchor?: string
  preset?: NewSessionPreset
  before: Array<string>
}

let draftSeed: NewSessionDraftSeed = { round: 0 }
const draftListeners = new Set<() => void>()

export function setNewSessionDraft(
  next: Omit<NewSessionDraftSeed, 'round'>,
): NewSessionDraftSeed {
  draftSeed = { ...next, round: draftSeed.round + 1 }
  for (const listener of draftListeners) listener()
  return draftSeed
}

export function useNewSessionDraft(): NewSessionDraftSeed {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener)
      return () => draftListeners.delete(listener)
    },
    () => draftSeed,
    () => draftSeed,
  )
}

const JOB_SEED_PREFIX = 'wezdeck.new-session.job.'
const jobSeeds = new Map<string, NewSessionJobSeed>()

export function rememberJobSeed(jobId: string, seed: NewSessionJobSeed) {
  jobSeeds.set(jobId, seed)
  try {
    sessionStorage.setItem(`${JOB_SEED_PREFIX}${jobId}`, JSON.stringify(seed))
  } catch {
    // Rendering still works from host job metadata when storage is blocked.
  }
}

export function readJobSeed(jobId: string): NewSessionJobSeed | null {
  const cached = jobSeeds.get(jobId)
  if (cached) return cached
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(`${JOB_SEED_PREFIX}${jobId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<NewSessionJobSeed> | null
    if (!parsed || typeof parsed !== 'object') return null
    const seed: NewSessionJobSeed = {
      repo: typeof parsed.repo === 'string' ? parsed.repo : undefined,
      repoLabel:
        typeof parsed.repoLabel === 'string' ? parsed.repoLabel : undefined,
      agentProfile:
        typeof parsed.agentProfile === 'string'
          ? parsed.agentProfile
          : undefined,
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
      groupName:
        typeof parsed.groupName === 'string' ? parsed.groupName : undefined,
      anchor: typeof parsed.anchor === 'string' ? parsed.anchor : undefined,
      preset:
        parsed.preset &&
        typeof parsed.preset.repo === 'string' &&
        typeof parsed.preset.anchor === 'string' &&
        typeof parsed.preset.group === 'string'
          ? parsed.preset
          : undefined,
      before: Array.isArray(parsed.before)
        ? parsed.before.filter((id): id is string => typeof id === 'string')
        : [],
    }
    jobSeeds.set(jobId, seed)
    return seed
  } catch {
    return null
  }
}

export function clearJobSeed(jobId: string) {
  jobSeeds.delete(jobId)
  try {
    sessionStorage.removeItem(`${JOB_SEED_PREFIX}${jobId}`)
  } catch {
    // Ignore storage failures on cleanup.
  }
}

export function isUnknownNewSessionJob(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('session.new.job: unknown job')
  )
}

/**
 * Resolves the real session id once a creation job completes, falling back to
 * a newly listed session on the same worktree when the host reported done
 * before the agent's first-prompt hook wrote attention.json.
 */
export function resolveJobTargetSessionId(
  current: Pick<NewSessionJob, 'stage' | 'session_id' | 'worktree'> | undefined,
  sessions: Array<{ id: string; worktree?: string; cwd: string }> | undefined,
  before: ReadonlySet<string>,
): { targetId?: string; visitPath?: string } {
  if (current?.stage !== 'done') return {}
  if (current.session_id) {
    const match = sessions?.find((row) => row.id === current.session_id)
    return {
      targetId: current.session_id,
      visitPath: match?.worktree || match?.cwd || current.worktree,
    }
  }
  if (!current.worktree) return {}
  const listed = sessions?.find(
    (row) => row.worktree === current.worktree && !before.has(row.id),
  )
  if (!listed) return {}
  return {
    targetId: listed.id,
    visitPath: listed.worktree || listed.cwd || current.worktree,
  }
}

export function stageStepState(
  stage: NewSessionStage | undefined,
  step: 'workspace' | 'agent' | 'send',
): 'done' | 'active' | 'pending' | 'error' {
  if (!stage || stage === 'creating') {
    return step === 'workspace' ? 'active' : 'pending'
  }
  if (stage === 'starting' || stage === 'waiting_trust') {
    if (step === 'workspace') return 'done'
    return step === 'agent' ? 'active' : 'pending'
  }
  if (stage === 'sending') {
    return step === 'send' ? 'active' : 'done'
  }
  if (stage === 'done') return 'done'
  return step === 'workspace' ? 'error' : 'pending'
}
