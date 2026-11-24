// 交互调试 entries: one per special interaction of the session page, each with
// where the page learns it from, what a tap sends, a live demo and tags. The
// list orders each group by tag priority (TAGS) so one agent's entries sit
// together instead of scattered by when they were added.
import { SlashCommandRow } from './chat-command'
import { ToolBody } from './chat-diff'
import { ChatThread } from './chat-thread'
import { AskCard } from './session-ask-claude'
import { SessionPermissionKeys, SessionPlanReview } from './session-elicitation'
import { PermissionCard } from './session-permission'
import { StreamDemo, SubagentsDemo } from './console-interactions-demos'
import {
  ASK_ONE,
  ASK_MANY,
  BASH,
  EDIT,
  PLAN,
  SCREEN,
  COMPACT,
  SLASH,
  RUNNING,
  RUNNING_SHORT,
  RUNNING_LONG,
} from './console-interactions-samples'

export type Text = { zh: string; en: string }

/** tag priority: the list sorts each group by an entry's first tag */
export const TAGS = [
  { id: 'claude', label: { zh: 'Claude', en: 'Claude' } },
  { id: 'grok', label: { zh: 'Grok', en: 'Grok' } },
  { id: 'common', label: { zh: '通用', en: 'Any agent' } },
] as const
export type Tag = (typeof TAGS)[number]['id']
const rank = (tags: ReadonlyArray<Tag>) =>
  TAGS.findIndex((tag) => tag.id === tags[0])

export const GROUPS: Array<{ id: Section['group']; title: Text }> = [
  { id: 'prompt', title: { zh: '等待你处理的', en: 'Waiting on you' } },
  { id: 'stream', title: { zh: '对话里显示的', en: 'In the conversation' } },
]

export type Section = {
  id: string
  group: 'prompt' | 'stream'
  tags: ReadonlyArray<Tag>
  title: Text
  source: Text
  keys: Text
  demo: React.ReactNode
}

/** one entry per interaction: where it comes from, what a tap sends, a live demo */
export function buildSections(
  keyFor: (name: string) => (key: string) => Promise<void>,
  now: number,
): Array<Section> {
  const all: Array<Section> = [
    ...promptSections(keyFor).map((s) => ({ ...s, group: 'prompt' as const })),
    ...streamSections(now, keyFor).map((s) => ({
      ...s,
      group: 'stream' as const,
    })),
  ]
  // stable: within a tag the authored order stays
  return all.sort((a, b) => rank(a.tags) - rank(b.tags))
}

/** what the agent waits on: questions, permission prompts, plans, keys */
function promptSections(
  keyFor: (name: string) => (key: string) => Promise<void>,
): Array<Omit<Section, 'group'>> {
  return [
    {
      id: 'claude-ask',
      tags: ['claude'],
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
      tags: ['claude'],
      title: {
        zh: 'Claude 问答（多题，提交页）',
        en: 'Claude questions (several, submit page)',
      },
      source: {
        zh: '转录里尚未有结果的 AskUserQuestion 调用（多个问题）；全部答完后 TUI 停在「Submit answers」提交页，review 为 true',
        en: 'An AskUserQuestion call without a result, several questions; once all are answered the TUI waits on “Submit answers” (review)',
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
      tags: ['grok'],
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
      tags: ['claude'],
      title: { zh: '权限确认（命令）', en: 'Permission prompt (command)' },
      source: {
        zh: 'attention 为 waiting / permission_prompt 时，转录里最新一个未返回的工具调用（permission.go）',
        en: 'While attention is waiting / permission_prompt: the newest tool call without a result (permission.go)',
      },
      keys: {
        zh: '允许 = 1（第一个 Yes）；拒绝 = Esc。「不再询问」等中间选项因工具而异，不在网页端提供',
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
      tags: ['claude'],
      title: {
        zh: '权限确认（编辑，带 diff）',
        en: 'Permission prompt (edit, with diff)',
      },
      source: {
        zh: 'attention 为 waiting / permission_prompt 时，转录里最新一个未返回的 Edit 调用（permission.go），输入渲染成 diff',
        en: 'While attention is waiting / permission_prompt: the newest Edit call without a result (permission.go), its input as a diff',
      },
      keys: {
        zh: '允许 = 1（第一个 Yes）；拒绝 = Esc',
        en: 'Allow = 1 (the first Yes); Deny = Esc',
      },
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
      tags: ['claude'],
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
      tags: ['grok'],
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
      tags: ['common'],
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
function streamSections(
  now: number,
  keyFor: (name: string) => (key: string) => Promise<void>,
): Array<Omit<Section, 'group'>> {
  return [
    {
      id: 'progress',
      tags: ['common'],
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
      id: 'stream',
      tags: ['common'],
      title: { zh: '长回复流式写出', en: 'Long reply streaming in' },
      source: {
        zh: '新到的回复按阅读速度逐批显示（chat-stream.ts）；回复容器平滑长高，运行中状态行不动（chat-scroll.ts）',
        en: 'a new reply is revealed in reading-pace batches (chat-stream.ts); its box grows smoothly while the turn line stays put (chat-scroll.ts)',
      },
      keys: { zh: '无（重放可再看一次）', en: 'None (Replay runs it again)' },
      demo: <StreamDemo />,
    },
    {
      id: 'subagents',
      tags: ['claude'],
      title: { zh: '子 agent 面板', en: 'Subagents panel' },
      source: {
        zh: '会话回复的 subagents（agent_subagents.go 读各子 agent 自己的转录）；面板在底部固定栏里，展开收起不应带动对话滚动',
        en: 'subagents in the session reply (agent_subagents.go reads each one’s own transcript); the panel sits in the sticky footer and folding it must not scroll the thread',
      },
      keys: { zh: '无（点开看列表）', en: 'None (tap for the list)' },
      demo: <SubagentsDemo />,
    },
    {
      id: 'to-background',
      tags: ['claude'],
      title: { zh: '转到后台', en: 'Run in background' },
      source: {
        zh: '本轮最新一条是未返回的前台 Bash / Agent（foregroundCall）',
        en: 'the newest call is a pending foreground Bash / Agent (foregroundCall)',
      },
      keys: {
        zh: 'C-b（Claude Code 的转后台键）',
        en: 'C-b (Claude Code’s background key)',
      },
      demo: (
        <div className="grid gap-2">
          {[RUNNING_SHORT, RUNNING_LONG].map((command) => (
            <ChatThread
              key={command}
              messages={RUNNING(command)}
              start={0}
              busy
              onBackground={() => void keyFor('to-background')('C-b')}
            />
          ))}
        </div>
      ),
    },
    {
      id: 'compaction',
      tags: ['claude'],
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
      tags: ['claude'],
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
      tags: ['common'],
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
