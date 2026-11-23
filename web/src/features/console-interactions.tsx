// 交互调试 (我的 › 交互调试): every special interaction of the session page, rendered with
// sample data by the real components. Each says where the page learns it
// from (always the transcript or a hook — never the screen) and which keys a
// tap sends; here the keys only go to the log at the top, nothing reaches a
// pane. Debug copy is bilingual inline (like the architecture page), not in
// the message catalogs.
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { SlashCommandRow } from './chat-command'
import { ToolBody } from './chat-diff'
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'
import { AskCard } from './session-ask-claude'
import { SessionPermissionKeys, SessionPlanReview } from './session-elicitation'
import type { Elicitation } from './session-elicitation'
import { PermissionCard } from './session-permission'
import type { PendingCall } from './session-permission'

type Text = { zh: string; en: string }

const ASK_ONE: Elicitation = {
  questions: [
    {
      header: '数据源',
      question: '周报读哪张表？',
      options: [
        { label: 'dev_report', description: '开发周报明细' },
        { label: 'team_stat', description: '团队统计汇总' },
        { label: '都读', description: '合并两张表' },
      ],
    },
  ],
}
const ASK_MANY: Elicitation = {
  questions: [
    ...ASK_ONE.questions,
    {
      header: '范围',
      question: '统计哪几周？',
      options: [{ label: '本周' }, { label: '近四周' }],
    },
  ],
}
const BASH: PendingCall = {
  tool: 'Bash',
  text: 'Bash git push origin master',
  body: 'git push origin master',
}
const EDIT: PendingCall = {
  tool: 'Edit',
  text: 'Edit /r/web/src/lib/upload.ts',
  file: '/r/web/src/lib/upload.ts',
  body: '@@ -8,3 +8,3 @@\n // a phone screenshot is megabytes of PNG\n-const LONG_EDGE = 1600\n+const LONG_EDGE = 1920\n export async function shrinkImage(file: Blob) {',
}
const PLAN: PendingCall = {
  tool: 'ExitPlanMode',
  text: 'ExitPlanMode',
  plan: true,
  body: '## 计划\n\n1. relay 下发等待确认的工具调用\n2. 网页渲染确认卡片\n3. 交互调试页加入对照',
}
const SCREEN =
  ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don’t ask again for git push commands\n   3. No, and tell Claude what to do differently (esc)'
const COMPACT: Array<Message> = [
  { role: 'user', text: '继续上一轮的重构' },
  {
    role: 'system',
    kind: 'compact',
    text: 'auto',
    body: '上下文摘要：已完成 A、B，待做 C。',
    ts: '2026-11-23T10:00:00Z',
  },
  { role: 'assistant', text: '好的，接着做 C。' },
]
const SLASH: Array<Message> = [
  {
    role: 'system',
    kind: 'slash',
    text: '/model opus',
    body: 'Set model to Opus 5.5',
  },
  {
    role: 'system',
    kind: 'slash',
    text: '/context',
    body: 'Context usage\n  System prompt   3.1k\n  Messages       48.2k\n  Free           120k',
  },
]

/**
 * 我的 › 交互调试: a list of interactions beside (wide) or before (phone)
 * the selected one — what it is, where it comes from, which keys a tap
 * sends, the live component and its own key log. The selection rides the
 * URL hash so a link can point at one interaction.
 */
export function InteractionsPage() {
  const { locale } = useLocale()
  const p = (text: Text) => (locale === 'zh' ? text.zh : text.en)
  // phone first: hydration must not flash the split on a phone
  const wide = useIsWidePhoneFirst()
  const [log, setLog] = useState<Array<string>>([])
  const keyFor = (name: string) => (key: string) => {
    setLog((rows) => [`${name} → ${key}`, ...rows].slice(0, 8))
    return Promise.resolve()
  }
  const sections = buildSections(keyFor, Date.now())
  const [selected, setSelected] = useState<string | null>(() => {
    const hash =
      typeof window === 'undefined' ? '' : window.location.hash.slice(1)
    return sections.some((s) => s.id === hash) ? hash : null
  })
  // a link to another #interaction on this page changes only the hash
  useEffect(() => {
    const follow = () => {
      const hash = window.location.hash.slice(1)
      if (IDS.has(hash)) {
        setSelected(hash)
        setLog([])
      }
    }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  const pick = (id: string | null) => {
    setSelected(id)
    setLog([])
    if (typeof window !== 'undefined')
      window.history.replaceState(null, '', id ? `#${id}` : ' ')
  }
  // a wide screen always shows one; a phone starts on the list
  const current =
    sections.find((s) => s.id === selected) ?? (wide ? sections[0] : undefined)
  const list = (
    <nav
      aria-label={p({ zh: '交互列表', en: 'Interactions' })}
      className="grid content-start gap-4"
    >
      {GROUPS.map((group) => (
        <div key={group.id} className="grid gap-1">
          <h2 className="px-2 text-[12.5px] font-semibold text-brand-label">
            {p(group.title)}
          </h2>
          <ul className="grid gap-0.5">
            {sections
              .filter((s) => s.group === group.id)
              .map((s) => (
                <li key={s.id}>
                  <Button
                    variant="plain"
                    type="button"
                    data-interaction={s.id}
                    aria-current={current?.id === s.id ? 'true' : undefined}
                    onClick={() => pick(s.id)}
                    className={cn(
                      'flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] px-2.5 text-left text-[14px]',
                      current?.id === s.id
                        ? // the 我的 page sits on a surface card: the deck colour stands out
                          'bg-brand-deck font-medium text-brand-text'
                        : 'text-brand-muted hover:bg-brand-soft',
                    )}
                  >
                    {p(s.title)}
                    {wide ? null : (
                      <ChevronRight
                        size={16}
                        aria-hidden
                        className="text-brand-label"
                      />
                    )}
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  )
  const detail = current ? (
    <section
      key={current.id}
      data-testid="interaction-detail"
      data-interaction={current.id}
      className="grid min-w-0 content-start gap-3"
    >
      {wide ? null : (
        <Button
          variant="plain"
          type="button"
          onClick={() => pick(null)}
          className="-ml-1 inline-flex min-h-9 w-fit items-center gap-1 text-[13px] text-brand-running"
        >
          <ChevronLeft size={16} aria-hidden />
          {p({ zh: '全部交互', en: 'All interactions' })}
        </Button>
      )}
      <h2 className="text-[17px] font-semibold">{p(current.title)}</h2>
      <dl className="grid gap-1 rounded-[12px] bg-brand-deck px-3 py-2.5 text-[13px]">
        <div className="grid gap-0.5">
          <dt className="text-[12px] text-brand-label">
            {p({ zh: '怎么识别', en: 'Where it comes from' })}
          </dt>
          <dd className="leading-relaxed text-brand-muted">
            {p(current.source)}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-[12px] text-brand-label">
            {p({ zh: '点了发什么', en: 'What a tap sends' })}
          </dt>
          <dd className="leading-relaxed text-brand-muted">
            {p(current.keys)}
          </dd>
        </div>
      </dl>
      <div className="rounded-[16px] border border-dashed border-brand-edge p-2">
        {current.demo}
      </div>
      <div
        data-testid="interaction-log"
        className="grid gap-1 rounded-[12px] border border-brand-edge px-3 py-2"
      >
        <span className="text-[12px] text-brand-label">
          {p({
            zh: '按键日志（这里不会发到任何窗格）',
            en: 'Key log (nothing here reaches a pane)',
          })}
        </span>
        <p className="min-h-5 font-mono text-[12.5px] whitespace-pre-wrap text-brand-muted">
          {log.length
            ? log.join('\n')
            : p({ zh: '还没有按键', en: 'No keys yet' })}
        </p>
      </div>
    </section>
  ) : null
  if (!wide) return current ? detail : list
  return (
    <div className="grid grid-cols-[12.5rem_minmax(0,1fr)] gap-5">
      {list}
      {detail}
    </div>
  )
}

/** every interaction id (the hash a link may carry) */
const IDS = new Set(
  buildSections(() => () => Promise.resolve(), 0).map((s) => s.id),
)

const GROUPS: Array<{ id: Section['group']; title: Text }> = [
  { id: 'prompt', title: { zh: '等待你处理的', en: 'Waiting on you' } },
  { id: 'stream', title: { zh: '对话里显示的', en: 'In the conversation' } },
]

type Section = {
  id: string
  group: 'prompt' | 'stream'
  title: Text
  source: Text
  keys: Text
  demo: React.ReactNode
}

/** one entry per interaction: where it comes from, what a tap sends, a live demo */
function buildSections(
  keyFor: (name: string) => (key: string) => Promise<void>,
  now: number,
): Array<Section> {
  return [
    ...promptSections(keyFor).map((s) => ({ ...s, group: 'prompt' as const })),
    ...streamSections(now).map((s) => ({ ...s, group: 'stream' as const })),
  ]
}

/** what the agent waits on: questions, permission prompts, plans, keys */
function promptSections(
  keyFor: (name: string) => (key: string) => Promise<void>,
): Array<Omit<Section, 'group'>> {
  return [
    {
      id: 'claude-ask',
      title: { zh: 'Claude 问答（单题）', en: 'Claude question (one)' },
      source: {
        zh: '转录里尚未有结果的 AskUserQuestion 调用（agent_claude_ask.go）',
        en: 'An AskUserQuestion call without a result in the transcript (agent_claude_ask.go)',
      },
      keys: {
        zh: '选项序号 1–4；超出则方向键移动后 Enter',
        en: 'Option digit 1–4; beyond that arrows then Enter',
      },
      demo: (
        <AskCard
          agent="claude"
          elicitation={ASK_ONE}
          disabled={false}
          sendKey={keyFor('claude-ask')}
        />
      ),
    },
    {
      id: 'claude-ask-review',
      title: {
        zh: 'Claude 问答（多题，提交页）',
        en: 'Claude questions (several, submit page)',
      },
      source: {
        zh: '同上；全部答完后 TUI 停在「Submit answers」，review 为 true',
        en: 'As above; once all are answered the TUI waits on “Submit answers” (review)',
      },
      keys: {
        zh: '每题一个序号，最后 Enter 提交',
        en: 'A digit per question, then Enter to submit',
      },
      demo: (
        <AskCard
          agent="claude"
          elicitation={{ ...ASK_MANY, review: true }}
          disabled={false}
          sendKey={keyFor('claude-ask-review')}
        />
      ),
    },
    {
      id: 'grok-ask',
      title: { zh: 'Grok 问答', en: 'Grok question' },
      source: {
        zh: 'updates.jsonl 里未答复的 ask_user_question（agent_grok.go）',
        en: 'An unanswered ask_user_question in updates.jsonl (agent_grok.go)',
      },
      keys: { zh: '每题序号 + Enter', en: 'Digit + Enter per question' },
      demo: (
        <AskCard
          agent="grok"
          elicitation={ASK_ONE}
          disabled={false}
          sendKey={keyFor('grok-ask')}
        />
      ),
    },
    {
      id: 'permission-bash',
      title: { zh: '权限确认（命令）', en: 'Permission prompt (command)' },
      source: {
        zh: 'attention 为 waiting / permission_prompt 时，转录里最新一个未返回的工具调用（permission.go）',
        en: 'While attention is waiting / permission_prompt: the newest tool call without a result (permission.go)',
      },
      keys: {
        zh: '允许 = 1（第一个 Yes）；拒绝 = Esc。「不再询问」等中间选项因工具而异，不在手机上提供',
        en: 'Allow = 1 (the first Yes); Deny = Esc. Middle options vary by tool and are not offered',
      },
      demo: (
        <PermissionCard
          call={BASH}
          screen={SCREEN}
          disabled={false}
          onKey={(key) => void keyFor('permission-bash')(key)}
        />
      ),
    },
    {
      id: 'permission-edit',
      title: {
        zh: '权限确认（编辑，带 diff）',
        en: 'Permission prompt (edit, with diff)',
      },
      source: {
        zh: '同上；Edit 的输入渲染成 diff',
        en: 'As above; the Edit input rendered as a diff',
      },
      keys: { zh: '同上', en: 'As above' },
      demo: (
        <PermissionCard
          call={EDIT}
          disabled={false}
          onKey={(key) => void keyFor('permission-edit')(key)}
        />
      ),
    },
    {
      id: 'plan-approval',
      title: { zh: 'Claude 计划审批', en: 'Claude plan approval' },
      source: {
        zh: '等待确认的调用是 ExitPlanMode，计划正文在它的输入里',
        en: 'The blocked call is ExitPlanMode; the plan is its input',
      },
      keys: {
        zh: '批准 = 1（Claude 的第一个 Yes 选项，随模式变化）；继续规划 = Esc',
        en: 'Approve = 1 (Claude’s first Yes option, varies by mode); Keep planning = Esc',
      },
      demo: (
        <PermissionCard
          call={PLAN}
          disabled={false}
          onKey={(key) => void keyFor('plan-approval')(key)}
        />
      ),
    },
    {
      id: 'grok-plan',
      title: { zh: 'Grok 计划审阅', en: 'Grok plan review' },
      source: {
        zh: '旁边的 plan.md 与未完成的 exit_plan_mode（agent_grok.go）',
        en: 'Sibling plan.md and an open exit_plan_mode (agent_grok.go)',
      },
      keys: {
        zh: 'a 批准 · s 要求修改 · q 退出',
        en: 'a approve · s request changes · q quit',
      },
      demo: (
        <SessionPlanReview
          excerpt={PLAN.body}
          awaitingApproval
          disabled={false}
          onKey={(key) => void keyFor('grok-plan')(key)}
        />
      ),
    },
    {
      id: 'generic-keys',
      title: { zh: '通用按键（兜底）', en: 'Generic keys (fallback)' },
      source: {
        zh: 'waiting 但没有结构化数据时（如 Codex 的审批）：显示终端画面，只给按键，不做解析',
        en: 'Waiting without structured data (e.g. Codex approvals): the terminal is shown, keys only, nothing parsed',
      },
      keys: {
        zh: '1 / 2 / 3 / Enter / Esc / Ctrl+C',
        en: '1 / 2 / 3 / Enter / Esc / Ctrl+C',
      },
      demo: (
        <SessionPermissionKeys
          screen={SCREEN}
          disabled={false}
          onKey={(key) => void keyFor('generic-keys')(key)}
        />
      ),
    },
  ]
}

/** what shows in the conversation itself: progress, compaction, commands, diffs */
function streamSections(now: number): Array<Omit<Section, 'group'>> {
  return [
    {
      id: 'progress',
      title: {
        zh: '进度行（运行中 / 压缩中）',
        en: 'Progress line (working / compacting)',
      },
      source: {
        zh: 'attention 的 turn_started / compact_started（hook）与转录里本轮的输出 token',
        en: 'attention turn_started / compact_started (hooks) and the turn’s output tokens from the transcript',
      },
      keys: { zh: '无', en: 'None' },
      demo: (
        <div className="grid gap-2">
          <ChatThread
            messages={[]}
            start={0}
            busy
            activity={{ since: now - 279_000, tokens: 19_120 }}
          />
          <ChatThread
            messages={[]}
            start={0}
            busy
            activity={{ since: now - 300_000, compactSince: now - 36_000 }}
          />
        </div>
      ),
    },
    {
      id: 'compaction',
      title: { zh: '压缩分隔线', en: 'Compaction divider' },
      source: {
        zh: '转录里的 compact_boundary 与摘要行',
        en: 'compact_boundary and the summary line in the transcript',
      },
      keys: { zh: '无（点开看摘要）', en: 'None (tap for the summary)' },
      demo: <ChatThread messages={COMPACT} start={0} busy={false} />,
    },
    {
      id: 'slash',
      title: { zh: '斜杠命令记录', en: 'Slash command rows' },
      source: {
        zh: '转录里的 <command-name> 与 <local-command-stdout>（claude_command.go）',
        en: '<command-name> and <local-command-stdout> lines (claude_command.go)',
      },
      keys: {
        zh: '无；命令面板发送的就是这些命令',
        en: 'None; the 命令 panel sends these commands',
      },
      demo: (
        <div className="grid gap-1">
          {SLASH.map((message) => (
            <SlashCommandRow key={message.text} message={message} />
          ))}
        </div>
      ),
    },
    {
      id: 'diff',
      title: { zh: '工具 diff', en: 'Tool diff' },
      source: {
        zh: '工具结果里的 structuredPatch（tool_patch.go），语法着色在浏览器做',
        en: 'structuredPatch from the tool result (tool_patch.go), coloured in the browser',
      },
      keys: { zh: '无', en: 'None' },
      demo: <ToolBody text={EDIT.body ?? ''} file={EDIT.file} />,
    },
  ]
}
