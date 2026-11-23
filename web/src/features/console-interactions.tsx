// 交互调试: every special interaction of the session page, rendered with
// sample data by the real components. Each says where the page learns it
// from (always the transcript or a hook — never the screen) and which keys a
// tap sends; here the keys only go to the log at the top, nothing reaches a
// pane. Debug copy is bilingual inline (like the architecture page), not in
// the message catalogs.
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
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

export function ConsoleInteractionsPage() {
  const { locale } = useLocale()
  const p = (text: Text) => (locale === 'zh' ? text.zh : text.en)
  const [log, setLog] = useState<Array<string>>([])
  const keyFor = (name: string) => (key: string) => {
    setLog((rows) => [`${name} → ${key}`, ...rows].slice(0, 8))
    return Promise.resolve()
  }
  const sections = buildSections(keyFor, Date.now())
  return (
    <div className="grid max-w-3xl content-start gap-5 pb-10">
      <div className="grid gap-1.5">
        <h1 className="text-base font-semibold">
          {p({ zh: '交互调试', en: 'Interaction debugging' })}
        </h1>
        <p className="text-[13.5px] leading-relaxed text-brand-muted">
          {p({
            zh: '会话页的每种特殊交互，用示例数据和真实组件渲染。这里点按钮不会发到任何窗格，只记在下面的日志里。',
            en: 'Every special interaction of the session page, real components with sample data. Taps here reach no pane; they only go to the log below.',
          })}
        </p>
      </div>
      <div
        data-testid="interaction-log"
        className="sticky top-0 z-10 grid gap-1 rounded-[14px] border border-brand-edge bg-brand-surface px-3.5 py-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-semibold text-brand-label">
            {p({ zh: '按键日志', en: 'Key log' })}
          </span>
          <Button
            variant="plain"
            type="button"
            onClick={() => setLog([])}
            className="text-[12.5px] text-brand-running"
          >
            {p({ zh: '清空', en: 'Clear' })}
          </Button>
        </div>
        <p className="min-h-5 font-mono text-[12.5px] whitespace-pre-wrap text-brand-muted">
          {log.length
            ? log.join('\n')
            : p({ zh: '还没有按键', en: 'No keys yet' })}
        </p>
      </div>
      <nav className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="text-brand-running hover:underline"
          >
            {p(section.title)}
          </a>
        ))}
      </nav>
      {sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className="grid scroll-mt-24 gap-2"
        >
          <h2 className="text-[15px] font-semibold">{p(section.title)}</h2>
          <dl className="grid gap-0.5 text-[12.5px]">
            <div className="flex gap-2">
              <dt className="shrink-0 text-brand-label">
                {p({ zh: '识别', en: 'Source' })}
              </dt>
              <dd className="text-brand-muted">{p(section.source)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-brand-label">
                {p({ zh: '按键', en: 'Keys' })}
              </dt>
              <dd className="text-brand-muted">{p(section.keys)}</dd>
            </div>
          </dl>
          <div className="rounded-[16px] border border-dashed border-brand-edge p-2">
            {section.demo}
          </div>
        </section>
      ))}
    </div>
  )
}

type Section = {
  id: string
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
  return [...promptSections(keyFor), ...streamSections(now)]
}

/** what the agent waits on: questions, permission prompts, plans, keys */
function promptSections(
  keyFor: (name: string) => (key: string) => Promise<void>,
): Array<Section> {
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
function streamSections(now: number): Array<Section> {
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
