// 交互调试 demos that need the session page's own layout to show their
// behaviour: a scroller with the thread, its end sentinel and the sticky
// footer, driven by the real useChatScroll.
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  AgentTag,
  BranchTag,
  GitStatusTag,
  RepoTag,
  RoleTag,
  StatusTag,
  TagLine,
} from '#/components/deck/session-tags'
import { Button } from '#/components/ui/button'
import { useChatScroll } from './chat-scroll'
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'
import { SessionSubagents } from './session-subagents'
import { SessionUsageAlerts } from './session-header'
import { SessionStatusBar } from './session-statusbar'
import type { Detail } from './console-sessions'
import { BACKGROUND } from './console-interactions-samples'
import type { Subagent } from './session-subagents'

const THREAD: Array<Message> = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  text:
    i % 2
      ? `第 ${i} 段回复：子 agent 在后台跑审查，主会话继续说明进度。展开或收起底部的子 agent 面板时，这段对话应当停在原位，最后一条贴着底部。`
      : `第 ${i} 条消息`,
}))

const AGENTS: Array<Subagent> = [
  {
    id: 'a1',
    name: 'code-review',
    description: 'Review the diff',
    type: 'general-purpose',
    background: true,
    state: 'running',
    tools: 6,
    last_tool: 'Bash Show docs diff and new tests',
    started_at: new Date(Date.now() - 39_000).toISOString(),
    active_at: Date.now(),
  },
  {
    id: 'a2',
    description: 'Find callers of useChatScroll',
    type: 'Explore',
    background: false,
    state: 'running',
    tools: 3,
    last_tool: 'Grep useChatScroll',
    started_at: new Date(Date.now() - 12_000).toISOString(),
    active_at: Date.now(),
  },
]

/** a session-shaped scroller: thread + end sentinel, then a sticky footer */
function SessionFrame({
  testId,
  thread,
  count,
  footer,
}: {
  testId: string
  thread: React.ReactNode
  count: number
  footer: React.ReactNode
}) {
  const end = useRef<HTMLDivElement>(null)
  // pinned = the session page would show no 回到最新
  const { pinned } = useChatScroll(end, count)
  return (
    <div
      data-testid={testId}
      data-pinned={pinned}
      className="grid h-[26rem] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-xl border border-brand-edge"
    >
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start overflow-y-auto px-2.5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-end gap-2 py-2">
          {thread}
          <div ref={end} data-testid={`${testId}-end`} />
        </div>
        <div className="sticky bottom-0 -mx-2.5 border-t border-brand-edge bg-brand-deck px-2.5 py-2">
          {footer}
        </div>
      </div>
    </div>
  )
}

/**
 * The subagents panel in a session-shaped scroller: folding it (it lives in
 * the sticky footer) must leave the thread where it is — pinned to its last
 * message — and lend no blank room under it.
 */
export function SubagentsDemo() {
  return (
    <SessionFrame
      testId="subagents-demo"
      count={THREAD.length}
      thread={<ChatThread messages={THREAD} start={0} busy={false} />}
      footer={<SessionAgentsFooter />}
    />
  )
}

function SessionAgentsFooter() {
  return <SessionSubagents agents={AGENTS} />
}

const LONG_REPLY = Array.from(
  { length: 14 },
  (_, i) =>
    `${i + 1}. 这是一段很长的回复，按阅读速度逐段写出：每一批文字换行时，回复的容器应当平滑长高，下面的运行中状态行停在原处不跟着跳。`,
).join('\n\n')

/**
 * A long reply streaming in while the agent works: the reply grows, the turn
 * line under it (运行中) stays put on screen. 重放 streams it again.
 */
export function StreamDemo() {
  const [round, setRound] = useState(0)
  return (
    <div className="grid gap-2">
      <Button
        variant="plain"
        type="button"
        data-testid="stream-replay"
        onClick={() => setRound((n) => n + 1)}
        className="justify-self-start rounded-full bg-brand-surface px-3 py-1 text-caption"
      >
        重放 / Replay
      </Button>
      {/* a fresh thread each round: one that already held the full reply
          treats it as there when the page opened and shows it still */}
      <StreamRound key={round} round={round} />
    </div>
  )
}

function StreamRound({ round }: { round: number }) {
  const [messages, setMessages] = useState<Array<Message>>(() =>
    THREAD.slice(0, 4),
  )
  useEffect(() => {
    // arrives after the page settled (the first 1.5 s land without easing,
    // chat-grow.tsx): a new reply streams, an old one does not
    const timer = setTimeout(
      () =>
        setMessages((list) => [
          ...list,
          { role: 'user', text: `重放 ${round + 1}` },
          { role: 'assistant', text: LONG_REPLY },
        ]),
      1_800,
    )
    return () => clearTimeout(timer)
  }, [round])
  return (
    <SessionFrame
      testId="stream-demo"
      count={messages.length}
      thread={
        <ChatThread
          messages={messages}
          start={0}
          busy
          activity={{ since: Date.now() - 42_000, tokens: 1_830 }}
        />
      }
      footer={
        <p className="px-1 text-meta text-brand-label">
          （输入框位置 / composer）
        </p>
      }
    />
  )
}

const CALLS = [
  'Read web/src/features/chat-scroll.ts',
  'Grep useChatScroll',
  'Bash pnpm exec tsc --noEmit',
  'Edit web/src/features/chat-grow.tsx',
  'Read web/src/features/chat-thread.tsx',
  'Bash scripts/dev/web-affected-tests.sh --run',
  'Grep data-growing',
  'Read docs/web-pwa.md',
]

/**
 * Tool calls arriving one by one while the agent works (a new call every
 * 700 ms, a short reply between runs): the turn line under them stays put.
 */
export function ToolsDemo() {
  const [round, setRound] = useState(0)
  return (
    <div className="grid gap-2">
      <Button
        variant="plain"
        type="button"
        data-testid="tools-replay"
        onClick={() => setRound((n) => n + 1)}
        className="justify-self-start rounded-full bg-brand-surface px-3 py-1 text-caption"
      >
        重放 / Replay
      </Button>
      <ToolsRound key={round} />
    </div>
  )
}

function ToolsRound() {
  // a full screen already: the turn line starts at the bottom
  const [messages, setMessages] = useState<Array<Message>>(() => THREAD)
  useEffect(() => {
    let n = 0
    const timer = setInterval(() => {
      const text = CALLS[n % CALLS.length] ?? ''
      const tool = text.split(' ')[0] ?? 'Bash'
      setMessages((list) => [
        ...list,
        ...(n === 4
          ? [
              {
                role: 'assistant' as const,
                text: '先看一下测试结果，再继续改。',
              },
            ]
          : []),
        { role: 'tool', tool, text, kind: 'other' },
      ])
      n += 1
      if (n >= CALLS.length) clearInterval(timer)
    }, 700)
    return () => clearInterval(timer)
  }, [])
  return (
    <SessionFrame
      testId="tools-demo"
      count={messages.length}
      thread={
        <ChatThread
          messages={messages}
          start={0}
          busy
          activity={{ since: Date.now() - 42_000, tokens: 1_830 }}
        />
      }
      footer={
        <p className="px-1 text-meta text-brand-label">
          （输入框位置 / composer）
        </p>
      }
    />
  )
}

const LONG_RESULT = Array.from(
  { length: 40 },
  (_, i) => `line ${i + 1}: ok  web/tests/case-${i + 1}.cdp.test.ts`,
).join('\n')

/**
 * Opening and closing a call's details at the bottom of a live thread: the
 * tapped row stays where it is, closing keeps the room it gave up (up to
 * half a screen) without leaving the bottom — no 回到最新 — and anything
 * more glides away with the row kept on screen.
 */
export function ToggleDemo() {
  const messages: Array<Message> = [
    ...THREAD,
    {
      role: 'tool',
      tool: 'Read',
      text: 'Read web/src/features/chat-scroll.ts',
      kind: 'read',
    },
    {
      role: 'tool',
      tool: 'Bash',
      text: 'Bash scripts/dev/web-affected-tests.sh --run',
      body: 'scripts/dev/web-affected-tests.sh --run',
      result: LONG_RESULT,
      kind: 'command',
    },
  ]
  return (
    <SessionFrame
      testId="toggle-demo"
      count={messages.length}
      thread={
        <ChatThread
          messages={messages}
          start={0}
          busy
          activity={{ since: Date.now() - 42_000, tokens: 1_830 }}
        />
      }
      footer={
        <p className="px-1 text-meta text-brand-label">
          （输入框位置 / composer）
        </p>
      }
    />
  )
}

const LONG_BRANCH =
  'feat/cli-secret-stdin-for-webhooks-and-env-import-long-branch-name'

type TagPlace = 'list' | 'head' | 'crowded' | 'info'

/** the tags of one session, as each place shows them */
function SampleTags({ place }: { place: TagPlace }) {
  const extra = place === 'crowded' || place === 'list'
  return (
    <TagLine
      testId={`tags-${place}`}
      expandable={place !== 'list'}
      maxLines={place === 'head' || place === 'crowded' ? 2 : undefined}
    >
      {extra ? <RoleTag role="primary" label="主" /> : null}
      <AgentTag agent="claude" />
      {extra ? <StatusTag tone="running" label="运行中" /> : null}
      <BranchTag branch={LONG_BRANCH} />
      {place === 'crowded' ? (
        <>
          <RepoTag repo="ai-video-collection" />
          <BranchTag branch="hotfix/resources-query-retry-after-timeout" />
          <StatusTag tone="waiting" label="等你" />
        </>
      ) : null}
      <GitStatusTag
        git={{
          staged: 1,
          unstaged: 2,
          untracked: 0,
          upstream: true,
          ahead: 1,
          behind: 0,
        }}
      />
    </TagLine>
  )
}

function TagPlaceFrame({
  label,
  surface,
  children,
}: {
  label: string
  surface?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1">
      <span className="px-1 text-meta text-brand-label">{label}</span>
      <div
        className={
          surface
            ? 'grid gap-1 rounded-2xl bg-brand-surface px-3.5 py-3'
            : 'grid gap-1 border-b border-brand-edge px-1 pb-2'
        }
      >
        <span className="text-title font-semibold">Gavin 最新消息排查</span>
        {children}
      </div>
    </div>
  )
}

/**
 * Session tags in every place with a long branch: one line first (the
 * branch truncates beside the others), the header at most two lines with
 * the rest behind +N in a panel over the page, 会话信息 without a limit.
 */
export function TagsDemo() {
  return (
    <div className="grid gap-4">
      <TagPlaceFrame label="会话列表的一行（行是链接，标签不可点）" surface>
        <SampleTags place="list" />
      </TagPlaceFrame>
      <TagPlaceFrame label="会话详情顶部（点或悬停被省略的标签，浮出全文）">
        <SampleTags place="head" />
      </TagPlaceFrame>
      <TagPlaceFrame label="顶部 · 标签较多（最多两行，其余在 +N 里）">
        <SampleTags place="crowded" />
      </TagPlaceFrame>
      <TagPlaceFrame
        label="会话信息（不限行数，被省略的标签同样浮出全文）"
        surface
      >
        <SampleTags place="info" />
      </TagPlaceFrame>
    </div>
  )
}

const TOASTS: Array<{ id: string; label: string; show: () => void }> = [
  { id: 'plain', label: '普通', show: () => toast('已复制引用') },
  {
    id: 'action',
    label: '带撤销',
    show: () =>
      toast('已清空输入', { action: { label: '撤销', onClick: () => {} } }),
  },
  {
    id: 'error',
    label: '错误',
    show: () => toast.error('复制引用失败：剪贴板不可用'),
  },
  {
    id: 'sticky',
    label: '常驻（新版本）',
    show: () =>
      toast('有新版本', {
        id: 'demo-sticky',
        duration: Infinity,
        action: { label: '刷新', onClick: () => {} },
      }),
  },
  {
    id: 'long',
    label: '长文本',
    show: () =>
      toast(
        '已在 tmux 中打开：wezterm-config / dev-agent（会话 primary），终端窗口已切到前台',
      ),
  },
]

/**
 * Every kind of toast the console shows, from the real Toaster: an ink card
 * like the user's message, its action a pill, an error with its icon. On the
 * session page they drop in under the top bar (--toast-top), never over it.
 */
export function ToastDemo() {
  return (
    <div className="flex flex-wrap gap-2">
      {TOASTS.map((kind) => (
        <Button
          key={kind.id}
          variant="plain"
          type="button"
          data-toast-kind={kind.id}
          onClick={kind.show}
          className="rounded-full bg-brand-surface px-3 py-1.5 text-caption"
        >
          {kind.label}
        </Button>
      ))}
    </div>
  )
}

const STATUS_SAMPLE: Detail = {
  id: 'sample',
  status: 'running',
  agent: 'claude',
  branch: 'docs/test-internal-domain',
  usage: {
    model: 'claude-opus-5-5',
    context: 104_000,
    context_limit: 200_000,
    input: 1_200,
    output: 18_300,
    cache_read: 98_000,
    turns: 12,
  },
  account: {
    five_hour: { used_percentage: 23, resets_at: Date.now() / 1000 + 3 * 3600 },
    seven_day: {
      used_percentage: 83,
      resets_at: Date.now() / 1000 + 111 * 3600,
    },
    at: Date.now(),
  },
  git: {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    upstream: true,
    ahead: 1,
    behind: 3,
  },
  worktrees: [
    {
      path: '/home/yuns/github/wezterm-config',
      branch: 'master',
      current: true,
    },
    {
      path: '/home/yuns/github/.worktrees/wezterm-config/dev-agent',
      branch: 'dev/agent',
    },
    {
      path: '/home/yuns/github/.worktrees/wezterm-config/task-probe',
      branch: '(detached)',
    },
  ],
  background: BACKGROUND.slice(0, 2),
}

/**
 * The status bar under the composer, as on a phone: agent, branch, git,
 * node, worktrees, background tasks on one line; worktrees and background
 * tasks open upward over the conversation.
 */
export function StatusBarDemo() {
  const [visibleUsage, setVisibleUsage] = useState('')
  return (
    <div className="grid gap-1.5 rounded-2xl border-t border-brand-edge px-1 pt-2 pb-3">
      <SessionUsageAlerts data={STATUS_SAMPLE} visibleUsage={visibleUsage} />
      <div className="flex items-end gap-2 rounded-3xl bg-brand-surface p-1.5">
        <span className="min-h-10 flex-1 px-3 py-2 text-body text-brand-label">
          发消息
        </span>
      </div>
      <SessionStatusBar data={STATUS_SAMPLE} onVisibleUsage={setVisibleUsage} />
    </div>
  )
}

/**
 * Git counts changing every 250 ms under a bottom-pinned composer, as when
 * the agent edits files: the git tag keeps its width (fixed segments, two
 * digits each), so the tags after it hold still and the bar stays one line.
 */
export function GitChurnDemo() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 250)
    return () => clearInterval(timer)
  }, [])
  // deterministic churn: widths from one to three digits
  const pick = (k: number, span: number) => (tick * 7919 + k * 104729) % span
  // a short branch (nothing to truncate) and a clean state every few
  // ticks: the widths that used to swing ("已同步" ↔ "+12 ~98 ?8 ↑11")
  const clean = tick % 4 === 0
  const sample: Detail = {
    ...STATUS_SAMPLE,
    branch: 'master',
    git: {
      staged: clean ? 0 : pick(2, 15),
      unstaged: clean ? 0 : pick(3, 99),
      untracked: clean ? 0 : pick(5, 9),
      upstream: true,
      ahead: clean ? 0 : pick(6, 12),
      behind: 0,
    },
  }
  return (
    <div
      data-testid="git-churn"
      className="flex h-56 flex-col justify-end rounded-2xl border-t border-brand-edge px-1 pb-3"
    >
      <div
        data-testid="git-churn-field"
        className="flex items-end gap-2 rounded-3xl bg-brand-surface p-1.5"
      >
        <span className="min-h-10 flex-1 px-3 py-2 text-body text-brand-label">
          发消息
        </span>
      </div>
      <SessionStatusBar data={sample} />
    </div>
  )
}
