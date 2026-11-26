// 交互调试 demo: opening a newly completed (`done`) session whose latest reply
// is taller than the viewport lands at the start of that reply (not its tail);
// later visits (`idle`) with the same long reply land directly at the bottom.
import { ArrowDown } from 'lucide-react'
import { useRef } from 'react'

import { Button } from '#/components/ui/button'
import { shouldLandLatestTop } from './chat-landing'
import { useChatScroll } from './chat-scroll'
import { StickyPrompt } from './chat-sticky'
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'

const EARLIER: Array<Message> = Array.from({ length: 14 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  text:
    i % 2 === 0
      ? `历史提问 #${i / 2 + 1}`
      : `历史回复 #${Math.floor(i / 2) + 1}，用于触发渐进补全。`,
}))

const LONG_FINAL = [
  '【最新回复开头】这里列出本次排查的完整结论与修改项：',
  ...Array.from(
    { length: 18 },
    (_, i) =>
      `${i + 1}. 第 ${i + 1} 项详细说明：刚完成的会话若最新回复超过一屏，应从这条回复开头开始展示，而不是只露底部几行尾巴。`,
  ),
  '【最新回复结尾】如需继续调整，直接回复即可。',
].join('\n\n')

const LONG_THREAD: Array<Message> = [
  ...EARLIER,
  { role: 'user', text: '把这次长回复的落点问题完整梳理一下' },
  { role: 'assistant', text: LONG_FINAL },
]

function LandingFrame({
  testId,
  messages,
  status,
  label,
}: {
  testId: string
  messages: Array<Message>
  status: 'done' | 'idle'
  label: string
}) {
  const end = useRef<HTMLDivElement>(null)
  const preferLatestTop = shouldLandLatestTop({
    status,
    pendingCount: 0,
    hasPrompt: false,
  })
  const follow = useChatScroll(end, messages.length + 1, preferLatestTop)
  return (
    <div
      data-testid={testId}
      data-pinned={follow.pinned}
      className="grid h-[26rem] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-xl border border-brand-edge"
    >
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start overflow-y-auto px-2.5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-end gap-2 py-2">
          <StickyPrompt
            end={end}
            messages={messages}
            start={0}
            following={follow.pinned}
          />
          <ChatThread
            messages={messages}
            start={0}
            busy={false}
            status={status}
          />
          <div ref={end} data-testid={`${testId}-end`} />
        </div>
        <div className="sticky bottom-0 -mx-2.5 border-t border-brand-edge bg-brand-deck px-2.5 py-2">
          {!follow.pinned ? (
            <Button
              variant="plain"
              type="button"
              onClick={follow.jump}
              data-testid={`${testId}-jump`}
              className="absolute -top-11 left-1/2 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-brand-edge bg-brand-surface px-3.5 text-caption font-medium text-brand-text shadow-[0_8px_24px_rgb(0_0_0/0.22)]"
            >
              <ArrowDown size={14} aria-hidden />
              最新
            </Button>
          ) : null}
          <span className="text-meta text-brand-label">
            {label} · {follow.pinned ? '已贴底' : '停在最新回复开头'}
          </span>
        </div>
      </div>
    </div>
  )
}

export function LongReplyLandingDemo() {
  return (
    <div className="grid gap-3">
      <LandingFrame
        testId="landing-done-demo"
        messages={LONG_THREAD}
        status="done"
        label="刚完成（done）"
      />
      <LandingFrame
        testId="landing-idle-demo"
        messages={LONG_THREAD}
        status="idle"
        label="后续再看（idle）"
      />
    </div>
  )
}
