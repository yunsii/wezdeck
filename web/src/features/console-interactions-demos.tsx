// 交互调试 demos that need the session page's own layout to show their
// behaviour: a scroller with the thread, its end sentinel and the sticky
// footer, driven by the real useChatScroll.
import { useEffect, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { useChatScroll } from './chat-scroll'
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'
import { SessionSubagents } from './session-subagents'
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
  useChatScroll(end, count)
  return (
    <div
      data-testid={testId}
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
    // arrives after the page settled: a new reply streams, an old one does not
    const timer = setTimeout(
      () =>
        setMessages((list) => [
          ...list,
          { role: 'user', text: `重放 ${round + 1}` },
          { role: 'assistant', text: LONG_REPLY },
        ]),
      600,
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
