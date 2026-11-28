// 会话信息: Telegram-profile style 3-tier sheet opened from the header's ⓘ.
//   1. Quick action icon bar (copy reference, rename, repo links, local host
//      terminal / VS Code) + mark-read bar when unread;
//   2. First-screen overview (status/mode, model, directory) & usage summary;
//   3. Group management (new sibling, destructive red delete) + collapsible
//      Technical details keeping every host meta / capability row tap-to-copy.
import { useLingui } from '@lingui/react/macro'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { AgentTag, TagLine } from '#/components/deck/session-tags'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Field, FieldList } from '#/components/ui/field'
import { SectionHeading } from '#/components/ui/section-heading'
import { Sheet } from '#/components/ui/sheet'
import { copyText } from '#/lib/clipboard'
import { AgentAvatar } from './agent-avatar'
import type { Detail } from './console-sessions'
import { useSessions } from './console-sessions'
import { useDeviceState } from './device-state'
import { RepoLinksSheet, useRepoLinksKey } from './repo-links'
import type { RepoLinksTarget } from './repo-links'
import { chatTone } from './session-chats'
import { ClearButton } from './session-clear'
import { useDeleteSession } from './session-delete'
import { useSessionDeleteReview } from './session-delete-state'
import { useFocusKey } from './session-focus'
import { GitStatusButton } from './session-git'
import { SessionInfoQuickActions } from './session-info-actions'
import {
  buildOverviewRows,
  buildTechnicalGroups,
  buildUsageSummaryRows,
  formatMetaValue,
  metaValue,
} from './session-info-meta'
import { requestNewSession } from './session-new'
import { worktreeKey } from './session-order'
import { useStatusText } from './session-status-text'
import { SessionTitleHistorySection } from './session-title-history'
import { SessionDocumentsSection } from './host-file-context'
import { WorktreeManager } from './session-worktree-manager'

export { metaValue }
export type { MetaGroup } from './session-info-meta'

function useLabels() {
  const { t } = useLingui()
  const groups: Record<string, string> = {
    session: t`Session`,
    location: t`Where it runs`,
    transcript: t`Transcript`,
    state: t`State`,
    usage: t`Usage`,
    capabilities: t`Capabilities`,
  }
  const keys: Record<string, string> = {
    id: t`Session id`,
    agent: 'Agent',
    title: t`Title`,
    title_source: t`Title source`,
    agent_name: t`Agent name`,
    window: t`tmux window`,
    model: t`Model`,
    cwd: t`Directory`,
    repo: t`Repository`,
    repo_root: t`Repository root`,
    worktree: t`Worktree`,
    branch: t`Branch`,
    tmux_socket: 'tmux socket',
    tmux_session: t`tmux session`,
    tmux_pane: t`tmux pane`,
    pane_role: t`Pane role`,
    pane_command: t`Running in pane`,
    pane: t`Pane`,
    path: t`File`,
    bytes: t`Size`,
    modified: t`Modified`,
    messages: t`Messages`,
    loaded: t`Loaded on this page`,
    compactions: t`Context compactions`,
    first_turn: t`First turn`,
    last_turn: t`Last turn`,
    status: t`Status`,
    mode: t`Execution mode`,
    reason: t`Reason`,
    running_kind: t`Running substate`,
    waiting_kind: t`Waiting for`,
    status_updated: t`Status updated`,
    desk_idle: t`Desk idle for`,
    background_tasks: t`Background tasks`,
    context: t`Context`,
    output: t`Output`,
    output_rate: t`Output rate`,
    cache_hit: t`Cache hit`,
    limits: t`Limits`,
    five_hour: t`5-hour limit`,
    seven_day: t`7-day limit`,
    ask_options: t`Tappable Ask options`,
    plan_review: t`Plan review`,
    usage_source: t`Usage from`,
    account_limits: t`Account limits`,
    mid_turn_input: t`A message sent mid-turn`,
    names_sessions: t`Names sessions`,
  }
  return { groups, keys, yes: t`yes`, no: t`no` }
}

function TechnicalDetailsSection({
  groups,
  worktrees,
  groupLabels,
  keys,
  humanStatus,
}: {
  groups: ReturnType<typeof buildTechnicalGroups>
  worktrees: NonNullable<Detail['worktrees']>
  groupLabels: Record<string, string>
  keys: Record<string, string>
  humanStatus: string
}) {
  const { t } = useLingui()
  if (!groups.length && worktrees.length <= 1) return null
  return (
    <Disclosure
      data-testid="session-tech-details"
      title={
        <span className="grid gap-0.5 text-left">
          <span className="text-caption font-medium text-brand-text">
            {t`Technical details`}
          </span>
          <span className="text-meta font-normal text-brand-label">
            {t`Session ID, tmux, transcript file and capabilities`}
          </span>
        </span>
      }
      triggerClassName="rounded-xl bg-brand-surface px-3 py-2.5 transition-colors hover:bg-brand-soft"
      panelClassName="grid gap-3 pt-2"
    >
      <p className="px-1 text-meta text-brand-label">
        {t`Tap a row to copy its value; long-press or right-click for more.`}
      </p>
      {worktrees.length > 1 ? (
        <section className="grid gap-1">
          <SectionHeading className="bg-brand-deck">
            {t`Worktrees`}
          </SectionHeading>
          <WorktreeManager list={worktrees} repoPath={worktrees[0].path} />
        </section>
      ) : null}
      {groups.map((group) => (
        <section key={group.name} className="grid gap-1">
          <SectionHeading className="bg-brand-deck">
            {groupLabels[group.name] ?? group.name}
          </SectionHeading>
          <FieldList>
            {group.rows.map((row) => (
              <Field
                key={row.key}
                label={keys[row.key] ?? row.key}
                value={
                  row.key === 'status'
                    ? humanStatus
                    : formatMetaValue(row.key, row.value)
                }
                mono
              />
            ))}
          </FieldList>
        </section>
      ))}
    </Disclosure>
  )
}

function SessionInfoHeader({
  data,
  profile,
}: {
  data: Detail
  profile?: string
}) {
  const { t } = useLingui()
  const fullTitle = data.title?.trim() || ''
  const tone = chatTone({
    status: data.status,
    running_kind: data.running_kind,
    waiting_kind: data.waiting_kind,
    ts: data.ts ?? 0,
    restart_pending: data.restart_pending,
  })
  const copyTitle = () => {
    if (!fullTitle) return
    void copyText(fullTitle).then(() => {
      const shown =
        fullTitle.length > 40 ? `${fullTitle.slice(0, 39)}…` : fullTitle
      toast(t`Copied: ${shown}`)
    })
  }
  return (
    <div className="flex items-start gap-3 px-1">
      <AgentAvatar
        agent={data.agent}
        profile={profile}
        size={44}
        tone={tone}
        className="mt-0.5"
      />
      <div className="grid min-w-0 flex-1 gap-1.5">
        {fullTitle ? (
          <Button
            variant="plain"
            size="none"
            type="button"
            data-testid="session-info-title"
            title={t`Copy value`}
            onClick={copyTitle}
            className="text-left text-title leading-snug font-semibold break-words text-brand-text"
          >
            {fullTitle}
          </Button>
        ) : (
          <p
            data-testid="session-info-title"
            className="text-title leading-snug font-semibold text-brand-label"
          >
            {t`Untitled session`}
          </p>
        )}
        {data.agent || data.git ? (
          <TagLine testId="info-tags">
            {data.agent && data.agent !== 'agent' ? (
              <AgentTag agent={data.agent} />
            ) : null}
            {data.git ? <GitStatusButton id={data.id} git={data.git} /> : null}
          </TagLine>
        ) : null}
      </div>
    </div>
  )
}

export function SessionInfo({
  data,
  open,
  onClose,
  onRename,
  renameDisabled,
}: {
  data: Detail
  open: boolean
  onClose: () => void
  /** paste `/rename <title>` into the agent TUI (Claude and Grok honor it) */
  onRename?: (title: string) => void
  renameDisabled?: boolean
}) {
  const { t } = useLingui()
  const { groups: groupLabels, keys, yes, no } = useLabels()
  const statusText = useStatusText()
  const sessions = useSessions()
  const card = sessions.data?.sessions.find((row) => row.id === data.id)
  const { ask: deleteSession, confirmation } = useDeleteSession()
  const device = useDeviceState()
  const reviewRequired = useSessionDeleteReview(data.id)
  const [linksOpen, setLinksOpen] = useState(false)
  const cwd = metaValue(data, 'cwd')
  const linksTarget = sessionLinksTarget(data, card)
  useFocusKey(data.focus)
  useRepoLinksKey(Boolean(linksTarget), () => setLinksOpen(true))
  if (typeof document === 'undefined') return null

  const humanStatus = statusText(
    data.status,
    data.waiting_kind,
    data.running_kind,
    data.background?.length ?? 0,
    data.restart_pending,
  )
  const overviewRows = buildOverviewRows(data, humanStatus)
  const usageRows = buildUsageSummaryRows(data, {
    compacted: t`Just compacted; updates after the next reply`,
    cache: t`Cache`,
  })
  const technicalGroups = buildTechnicalGroups(data, {
    yes,
    no,
    steer: t`joins the current turn`,
    queue: t`is queued`,
  })

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
        title={t`Session info`}
        testId="session-info"
      >
        <div className="grid gap-3 px-3 pb-2">
          <SessionInfoHeader data={data} profile={card?.agent_profile} />

          <SessionInfoQuickActions
            data={data}
            cwd={cwd}
            linksTarget={linksTarget}
            onRename={onRename}
            renameDisabled={renameDisabled}
            onOpenLinks={() => {
              onClose()
              setLinksOpen(true)
            }}
          />

          <ClearButton
            id={data.id}
            status={data.status}
            waitingKind={data.waiting_kind}
          />

          {overviewRows.length ? (
            <section className="grid gap-1">
              <SectionHeading className="bg-brand-deck">
                {t`Overview`}
              </SectionHeading>
              <FieldList>
                {overviewRows.map((row) => (
                  <Field
                    key={row.key}
                    label={keys[row.key] ?? row.key}
                    value={row.value}
                    mono={row.key === 'cwd'}
                  />
                ))}
              </FieldList>
            </section>
          ) : null}

          <SessionDocumentsSection
            messages={data.messages}
            onSelect={onClose}
          />

          <SessionTitleHistorySection history={data.title_history} />

          {usageRows.length ? (
            <section className="grid gap-1">
              <SectionHeading className="bg-brand-deck">
                {groupLabels.usage}
              </SectionHeading>
              <FieldList>
                {usageRows.map((row) => (
                  <Field
                    key={row.key}
                    label={keys[row.key] ?? row.key}
                    value={row.value}
                    mono
                  />
                ))}
              </FieldList>
            </section>
          ) : null}

          {card?.tmux_pane && device.state === 'approved' ? (
            <section className="grid gap-2">
              <div className="divide-y divide-brand-edge overflow-hidden rounded-xl bg-brand-surface">
                <Button
                  type="button"
                  variant="plain"
                  size="none"
                  onClick={() => {
                    onClose()
                    requestNewSession({
                      repo: card.repo_root || card.cwd,
                      anchor: card.id,
                      group:
                        card.worktree_description ||
                        worktreeKey(card).split('/').at(-1) ||
                        card.cwd,
                    })
                  }}
                  className="flex min-h-12 w-full items-center gap-2.5 px-3 text-left text-body font-medium text-brand-text transition-colors hover:bg-brand-soft active:bg-brand-soft"
                >
                  <Plus
                    size={16}
                    aria-hidden
                    className="shrink-0 text-brand-muted"
                  />
                  <span className="flex-1">{t`New session in this group`}</span>
                  <ChevronRight
                    size={16}
                    aria-hidden
                    className="shrink-0 text-brand-label"
                  />
                </Button>
                <Button
                  type="button"
                  variant="plain"
                  size="none"
                  onClick={() => deleteSession(card, true)}
                  className="flex min-h-12 w-full items-center gap-2.5 px-3 text-left text-body font-medium text-brand-error transition-colors hover:bg-brand-error/10 active:bg-brand-error/10"
                >
                  <Trash2 size={16} aria-hidden className="shrink-0" />
                  <span className="flex-1">{t`Delete session`}</span>
                  <ChevronRight
                    size={16}
                    aria-hidden
                    className="shrink-0 opacity-60"
                  />
                </Button>
              </div>
              {reviewRequired ? (
                <div className="grid gap-2 rounded-xl bg-brand-surface p-3">
                  <p role="status" className="text-caption text-brand-muted">
                    {t`This is the last session and the worktree has local changes. Inspect Git status above or return to the conversation and ask the agent to review the changes.`}
                  </p>
                  <Button
                    type="button"
                    variant="plain"
                    className="min-h-11 text-brand-error"
                    onClick={() => deleteSession(card, true, { force: true })}
                  >
                    {t`Force delete session and worktree`}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}

          <TechnicalDetailsSection
            groups={technicalGroups}
            worktrees={data.worktrees ?? []}
            groupLabels={groupLabels}
            keys={keys}
            humanStatus={humanStatus}
          />
        </div>
      </Sheet>
      {confirmation}
      <RepoLinksSheet
        open={linksOpen}
        onOpenChange={setLinksOpen}
        target={linksTarget}
      />
    </>
  )
}

function sessionLinksTarget(
  data: Detail,
  card:
    | { repo_root?: string; cwd?: string; repo_label?: string; repo?: string }
    | undefined,
): RepoLinksTarget | null {
  const repoRoot = card?.repo_root || metaValue(data, 'repo_root')
  const cwd = metaValue(data, 'cwd') || card?.cwd || ''
  if (!repoRoot && !cwd) return null
  return {
    label: card?.repo_label || card?.repo || metaValue(data, 'repo') || '',
    repo: repoRoot || undefined,
    cwd: cwd || undefined,
  }
}
