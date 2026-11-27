// Live guided view for an in-flight (or failed) session creation job:
// /console/sessions/job-<jobId>. Shows the user's first message immediately,
// tracks creating → starting → waiting_trust → sending → done, handles Agy/CLI
// trust confirmation and failure recovery in place, and replaces the URL with
// the real session id only while the user is still viewing this job.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, RotateCcw, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { BackButton } from '#/components/deck/back-button'
import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { trace } from '#/lib/client-trace'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { recordVisit } from '#/lib/session-visits'
import { cn } from '#/lib/utils'
import { prefetchSession, useSessions } from './console-sessions'
import { useStageText } from './session-new-panels'
import {
  NEW_SESSION_ID,
  clearJobSeed,
  isUnknownNewSessionJob,
  jobSessionId,
  readJobSeed,
  rememberJobSeed,
  resolveJobTargetSessionId,
  setNewSessionDraft,
  stageStepState,
} from './session-new-route'
import type { NewSessionJob, NewSessionStage } from './session-new-route'

function useAgyTrust(jobId: string, setError: (message: string) => void) {
  const [trusting, setTrusting] = useState(false)
  const trust = async () => {
    setTrusting(true)
    setError('')
    try {
      await hostWrite('session.new.trust', { job: jobId, confirm: true })
      trace('session-new', { action: 'trust', job: jobId })
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setTrusting(false)
    }
  }
  return { trust, trusting }
}

function StepRow({
  state,
  label,
  detail,
}: {
  state: 'done' | 'active' | 'pending' | 'error'
  label: string
  detail?: string
}) {
  return (
    <li className="flex items-center gap-2.5 text-caption">
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        {state === 'done' ? (
          <Check size={14} className="text-brand-done" aria-hidden />
        ) : (
          <Led
            tone={
              state === 'error'
                ? 'error'
                : state === 'active'
                  ? 'running'
                  : 'muted'
            }
            size={8}
          />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1',
          state === 'pending' ? 'text-brand-label' : 'text-brand-text',
        )}
      >
        {label}
      </span>
      {detail ? (
        <span className="truncate font-mono text-meta text-brand-label">
          {detail}
        </span>
      ) : null}
    </li>
  )
}

function JobProgressCard({
  current,
  effectiveStage,
  unknown,
  agentProfile,
  errorMessage,
  failed,
  canRetry,
  retrying,
  trusting,
  onTrust,
  onRetry,
  onEdit,
}: {
  current?: NewSessionJob
  effectiveStage: NewSessionStage
  unknown: boolean
  agentProfile: string
  errorMessage: string
  failed: boolean
  canRetry: boolean
  retrying: boolean
  trusting: boolean
  onTrust: () => void
  onRetry: () => void
  onEdit: () => void
}) {
  const { t } = useLingui()
  const stageText = useStageText()
  const statusLed =
    effectiveStage === 'failed' || unknown
      ? 'error'
      : effectiveStage === 'waiting_trust'
        ? 'waiting'
        : effectiveStage === 'done'
          ? 'done'
          : 'running'
  return (
    <section className="grid gap-3 rounded-2xl bg-brand-surface p-4">
      <div
        role="status"
        data-testid="new-session-stage"
        data-stage={effectiveStage}
        className="flex items-center gap-2 text-body font-medium text-brand-text"
      >
        <Led tone={statusLed} size={10} />
        <span>
          {unknown
            ? t`The previous session request expired. Start a new one.`
            : stageText({
                stage: effectiveStage,
                branch: current?.branch,
                error: current?.error,
                mode: current?.mode,
              })}
        </span>
      </div>

      {!unknown ? (
        <ol className="grid gap-2 pl-0.5">
          <StepRow
            state={stageStepState(effectiveStage, 'workspace')}
            label={
              current?.mode === 'group'
                ? t`Open window in session group`
                : current?.mode === 'reuse'
                  ? t`Prepare workstation`
                  : t`Create workspace`
            }
            detail={current?.branch}
          />
          <StepRow
            state={stageStepState(effectiveStage, 'agent')}
            label={t`Start agent`}
            detail={agentProfile || undefined}
          />
          <StepRow
            state={stageStepState(effectiveStage, 'send')}
            label={t`Deliver first message`}
          />
        </ol>
      ) : null}

      {effectiveStage === 'waiting_trust' ? (
        <div className="grid gap-2 pt-1">
          <Button
            type="button"
            variant="solid"
            onClick={onTrust}
            disabled={trusting}
            className="inline-flex min-h-11 items-center justify-center justify-self-start gap-2 px-3 whitespace-nowrap"
            data-testid="agy-trust-worktree"
          >
            <ShieldCheck size={16} aria-hidden />
            {t`Trust this worktree and continue`}
          </Button>
        </div>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="text-caption text-brand-error">
          {errorMessage}
        </p>
      ) : null}

      {failed ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {canRetry ? (
            <Button
              type="button"
              variant="solid"
              disabled={retrying}
              onClick={onRetry}
              data-testid="new-session-retry"
              className="inline-flex min-h-11 items-center justify-center gap-1.5 px-3 whitespace-nowrap"
            >
              <RotateCcw size={15} aria-hidden />
              {t`Retry`}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={onEdit}
            data-testid="new-session-edit"
            className="min-h-11 px-3"
          >
            {t`Edit and resend`}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export function NewSessionJobView({ jobId }: { jobId: string }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const back = useGoBack({
    to: '/{-$locale}/console/sessions',
    params: { locale: localeParam },
  })
  const seed = useMemo(() => readJobSeed(jobId), [jobId])
  const before = useMemo(() => new Set(seed?.before ?? []), [seed])
  const [actionError, setActionError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const { trust, trusting } = useAgyTrust(jobId, setActionError)
  const sessions = useSessions()

  const job = useQuery({
    queryKey: ['remote', 'session.new.job', jobId],
    enabled: typeof window !== 'undefined' && Boolean(jobId),
    retry: (count, failure) => !isUnknownNewSessionJob(failure) && count < 2,
    refetchInterval: (query) => {
      const stage = query.state.data?.job.stage
      return stage === 'done' || stage === 'failed' ? false : 1_000
    },
    queryFn: async () =>
      (await hostRead('session.new.job', { job: jobId })) as {
        job: NewSessionJob
      },
  })

  const listedJob = sessions.data?.creating_jobs?.find((j) => j.job === jobId)
  const current = job.data?.job ?? listedJob
  const unknown = isUnknownNewSessionJob(job.error)

  useEffect(() => {
    if (current?.stage !== 'done') return
    void queryClient.invalidateQueries({ queryKey: ['remote', 'sessions'] })
  }, [current?.stage, queryClient])

  const lastStage = useRef('')
  useEffect(() => {
    const stage = current?.stage ?? (unknown ? 'unknown' : '')
    if (!stage || stage === lastStage.current) return
    lastStage.current = stage
    trace('session-new', { action: 'stage', job: jobId, stage })
  }, [current?.stage, unknown, jobId])

  const { targetId, visitPath } = resolveJobTargetSessionId(
    current,
    sessions.data?.sessions,
    before,
  )

  const handedOff = useRef('')
  useEffect(() => {
    if (!targetId || handedOff.current === jobId) return
    handedOff.current = jobId
    clearJobSeed(jobId)
    if (visitPath) recordVisit(visitPath)
    if (current?.warning) toast.warning(current.warning)
    prefetchSession(queryClient, targetId)
    void queryClient.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    trace('session-new', { action: 'handoff', job: jobId, id: targetId })
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: localeParam, id: targetId },
      replace: true,
    })
  }, [
    targetId,
    visitPath,
    current?.warning,
    jobId,
    localeParam,
    navigate,
    queryClient,
  ])

  const prompt = current?.prompt || seed?.prompt || ''
  const repo = current?.repo || seed?.repo || ''
  const repoLabel =
    current?.repo_label || seed?.repoLabel || repo.split('/').pop() || ''
  const groupName = current?.group_name || seed?.groupName || ''
  const agentProfile = current?.agent_profile || seed?.agentProfile || ''
  const anchor = current?.anchor_session_id || seed?.anchor || ''
  const effectiveStage: NewSessionStage =
    current?.stage ?? (unknown ? 'failed' : 'creating')
  const failed = effectiveStage === 'failed' || unknown
  const errorMessage = unknown
    ? t`The previous session request expired. Start a new one.`
    : current?.error || actionError

  const editAndResend = () => {
    clearJobSeed(jobId)
    setNewSessionDraft({
      preset:
        seed?.preset ??
        (anchor ? { repo, anchor, group: groupName || repoLabel } : undefined),
      repo: anchor ? undefined : repo,
      agent: agentProfile,
      prompt,
      groupName: groupName || undefined,
      notice: unknown
        ? t`The previous session request expired. Start a new one.`
        : undefined,
    })
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: localeParam, id: NEW_SESSION_ID },
      replace: true,
    })
  }

  const retry = async () => {
    if (retrying || !prompt.trim() || (!repo && !anchor)) return
    setRetrying(true)
    setActionError('')
    try {
      const res = (await hostWrite('session.new', {
        ...(anchor
          ? { anchor_session_id: anchor, group_name: groupName || undefined }
          : { repo, new_group: true }),
        prompt: prompt.trim(),
        agent_profile: agentProfile || undefined,
      })) as { job: string }
      clearJobSeed(jobId)
      rememberJobSeed(res.job, {
        repo,
        repoLabel,
        agentProfile,
        prompt: prompt.trim(),
        groupName: groupName || undefined,
        anchor: anchor || undefined,
        preset: seed?.preset,
        before: seed?.before ?? [],
      })
      trace('session-new', { action: 'retry', job: res.job })
      void queryClient.invalidateQueries({ queryKey: ['remote', 'sessions'] })
      void navigate({
        to: '/{-$locale}/console/sessions/$id',
        params: { locale: localeParam, id: jobSessionId(res.job) },
        replace: true,
      })
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setRetrying(false)
    }
  }

  const headerTitle =
    groupName ||
    (repoLabel ? `${t`New session`} · ${repoLabel}` : t`New session`)

  return (
    <div
      data-testid="new-session-job-view"
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
        <div className="grid min-w-0 flex-1">
          <h1 className="truncate text-title leading-tight font-semibold">
            {headerTitle}
          </h1>
          {current?.branch ? (
            <span className="truncate font-mono text-meta text-brand-label">
              {current.branch}
            </span>
          ) : null}
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 py-4">
        {prompt ? (
          <div className="flex justify-end">
            <div
              data-testid="new-session-first-prompt"
              className="max-w-[88%] rounded-2xl bg-brand-text px-3.5 py-2.5 text-body whitespace-pre-wrap break-words text-brand-deck"
            >
              {prompt}
            </div>
          </div>
        ) : null}

        <JobProgressCard
          current={current}
          effectiveStage={effectiveStage}
          unknown={unknown}
          agentProfile={agentProfile}
          errorMessage={errorMessage}
          failed={failed}
          canRetry={Boolean(prompt.trim() && (repo || anchor))}
          retrying={retrying}
          trusting={trusting}
          onTrust={() => void trust()}
          onRetry={() => void retry()}
          onEdit={editAndResend}
        />
      </div>

      <div className="sticky bottom-0 -mx-2.5 -mb-4 border-t border-brand-edge bg-brand-deck px-3 pt-2.5 pb-[max(calc(env(safe-area-inset-bottom)+0.5rem),0.75rem)] md:-ml-2.5 md:mr-0 md:mb-0">
        <p className="rounded-xl bg-brand-surface px-3 py-2.5 text-caption text-brand-label">
          {failed
            ? t`Creation did not finish. Retry or edit your message above.`
            : t`You can continue chatting here as soon as the session is ready…`}
        </p>
      </div>
    </div>
  )
}
