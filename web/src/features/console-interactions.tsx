// 交互调试 (我的 › 交互调试): every special interaction of the session page, rendered with
// sample data by the real components. Each says where the page learns it
// from (always the transcript or a hook — never the screen) and which keys a
// tap sends; here the keys only go to the log at the top, nothing reaches a
// pane. Debug copy is bilingual inline (like the architecture page), not in
// the message catalogs.
import { useCanGoBack, useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { SlashCommandRow } from './chat-command'
import { ToolBody } from './chat-diff'
import { ChatThread } from './chat-thread'
import { AskCard } from './session-ask-claude'
import { SessionPermissionKeys, SessionPlanReview } from './session-elicitation'
import { PermissionCard } from './session-permission'
import {
  ASK_ONE,
  ASK_MANY,
  BASH,
  EDIT,
  PLAN,
  SCREEN,
  COMPACT,
  SLASH,
} from './console-interactions-samples'

type Text = { zh: string; en: string }

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
  // the selection is the URL hash, through the router: on a phone opening
  // one pushes a history entry, so the header's back (and the system back)
  // returns to the list instead of leaving 我的 › 交互调试
  const navigate = useNavigate()
  const hash = useLocation({ select: (location) => location.hash })
  const selected = IDS.has(hash) ? hash : null
  useEffect(() => {
    setLog([])
  }, [selected])
  const pick = (id: string) =>
    void navigate({
      to: '/{-$locale}/console/me/$page',
      params: {
        locale: locale === 'en' ? undefined : locale,
        page: 'interactions',
      },
      hash: id,
      replace: wide,
    })
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
          {/* the phone list sits on a .key card, the wide sidebar on the page */}
          <SectionHeading
            as="h2"
            className={cn(
              'px-2 text-brand-label',
              wide ? 'bg-brand-deck' : 'bg-brand-key',
            )}
          >
            {p(group.title)}
          </SectionHeading>
          {/* a phone gets the 我的 list row (ink, a rule between rows); a
              wide screen keeps the sidebar look beside the detail */}
          <ul className={cn('grid', wide ? 'gap-0.5' : '')}>
            {sections
              .filter((s) => s.group === group.id)
              .map((s) => (
                <li
                  key={s.id}
                  className={
                    wide
                      ? undefined
                      : 'border-b border-brand-edge last:border-b-0'
                  }
                >
                  <Button
                    variant="plain"
                    type="button"
                    data-interaction={s.id}
                    aria-current={current?.id === s.id ? 'true' : undefined}
                    onClick={() => pick(s.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-2.5 text-left text-body',
                      !wide
                        ? 'key-press min-h-13 text-brand-text'
                        : current?.id === s.id
                          ? 'min-h-10 rounded-xl bg-brand-surface font-medium text-brand-text'
                          : 'min-h-10 rounded-xl text-brand-muted hover:bg-brand-soft',
                    )}
                  >
                    {p(s.title)}
                    {wide ? null : (
                      <ChevronRight
                        size={18}
                        aria-hidden
                        className="shrink-0 text-brand-label"
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
      <h2 className="text-title font-semibold">{p(current.title)}</h2>
      <dl className="grid gap-1.5 text-caption">
        <div className="grid gap-0.5">
          <dt className="text-meta text-brand-label">
            {p({ zh: '怎么识别', en: 'Where it comes from' })}
          </dt>
          <dd className="leading-relaxed text-brand-muted">
            {p(current.source)}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-meta text-brand-label">
            {p({ zh: '点了发什么', en: 'What a tap sends' })}
          </dt>
          <dd className="leading-relaxed text-brand-muted">
            {p(current.keys)}
          </dd>
        </div>
      </dl>
      {current.demo}
      <div
        data-testid="interaction-log"
        className="grid gap-0.5 border-t border-brand-edge pt-2"
      >
        <span className="text-meta text-brand-label">
          {p({
            zh: '按键日志（这里不会发到任何窗格）',
            en: 'Key log (nothing here reaches a pane)',
          })}
        </span>
        <p className="min-h-5 font-mono text-caption whitespace-pre-wrap text-brand-muted">
          {log.length
            ? log.join('\n')
            : p({ zh: '还没有按键', en: 'No keys yet' })}
        </p>
      </div>
    </section>
  ) : null
  if (!wide)
    return detail ?? <div className="key rounded-2xl px-2 py-3">{list}</div>
  return (
    <div className="grid grid-cols-[12.5rem_minmax(0,1fr)] gap-6">
      <div className="border-r border-brand-edge pr-3">{list}</div>
      {detail}
    </div>
  )
}

/** every interaction id (the hash a link may carry) */
const IDS = new Set(
  buildSections(() => () => Promise.resolve(), 0).map((s) => s.id),
)

/**
 * The 我的 page header's back: an open interaction (#id, pushed from its
 * list) returns to the list; otherwise `leave` (back to 我的).
 */
export function useInteractionsBack(active: boolean, leave: () => void) {
  const navigate = useNavigate()
  const canGoBack = useCanGoBack()
  const { locale } = useLocale()
  const hash = useLocation({ select: (location) => location.hash })
  if (!active || !hash) return leave
  return () =>
    canGoBack
      ? window.history.back()
      : void navigate({
          to: '/{-$locale}/console/me/$page',
          params: {
            locale: locale === 'en' ? undefined : locale,
            page: 'interactions',
          },
          replace: true,
        })
}

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
