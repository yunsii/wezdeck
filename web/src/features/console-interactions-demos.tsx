// 交互调试 demos that need the session page's own layout to show their
// behaviour: a scroller with the thread, its end sentinel and the sticky
// footer, driven by the real useChatScroll.
import { useRef } from 'react'

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

/**
 * The subagents panel in a session-shaped scroller: folding it (it lives in
 * the sticky footer) must leave the thread where it is — pinned to its last
 * message — and lend no blank room under it.
 */
export function SubagentsDemo() {
  const end = useRef<HTMLDivElement>(null)
  useChatScroll(end, THREAD.length)
  return (
    <div
      data-testid="subagents-demo"
      className="grid h-[26rem] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-xl border border-brand-edge"
    >
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start overflow-y-auto px-2.5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-end gap-2 py-2">
          <ChatThread messages={THREAD} start={0} busy={false} />
          <div ref={end} data-testid="subagents-demo-end" />
        </div>
        <div className="sticky bottom-0 -mx-2.5 border-t border-brand-edge bg-brand-deck px-2.5 py-2">
          <SessionSubagents agents={AGENTS} />
        </div>
      </div>
    </div>
  )
}
