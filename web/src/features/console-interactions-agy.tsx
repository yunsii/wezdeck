// 交互调试 entries for Antigravity CLI (agy): command permission approval,
// ask_question elicitation, collapsible thinking + rich tool details, and the
// status bar execution-mode tags (Auto / 未开 Auto / plan / full-access).
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'
import type { Detail } from './console-sessions'
import type { Section } from './console-interactions-sections'
import { AskCard } from './session-ask-claude'
import type { Elicitation } from './session-elicitation'
import { PermissionCard } from './session-permission'
import type { PendingCall } from './session-permission'
import { SessionStatusBar } from './session-statusbar'

const AGY_RUN_COMMAND: PendingCall = {
  tool: 'run_command',
  text: 'run_command [unsandboxed] Release relay and web console after checking affected tests and validating i18n catalogs',
  summary:
    'Release relay and web console after checking affected tests and validating i18n catalogs (full summary wraps cleanly without ellipsis)',
  flags: ['bypass-sandbox'],
  body: [
    'set -euo pipefail',
    'cd /home/yuns/github/wezterm-config',
    'git status --short',
    'bash scripts/dev/check-web.sh',
    'cd native/wezdeck-wsl && go test -count=1 ./...',
    'cd /home/yuns/github/wezterm-config',
    'for step in build push relay web reload; do',
    '  printf "[release] checking %s\\n" "$step"',
    'done',
    '# verify remote stack & Playwright CDP suite before deploy',
    'WEZDECK_TEST_STACK_PORT=3055 bash scripts/dev/remote-test-stack.sh start',
    'cd web && corepack pnpm exec vitest run --config vitest.cdp.config.ts tests/interactions.cdp.test.ts',
    'cd /home/yuns/github/wezterm-config',
    'WEZDECK_TEST_STACK_PORT=3055 bash scripts/dev/remote-test-stack.sh stop',
    '# land and deploy',
    'bash /home/yuns/github/wezterm-config/scripts/dev/wezdeck-release.sh --land HEAD',
    'echo "RELEASE_SCRIPT_END_MARKER"',
  ].join('\n'),
}

const AGY_PERMISSION_SCREEN =
  ' Run this command?\n   bash /home/yuns/github/wezterm-config/scripts/dev/wezdeck-release.sh\n   Reason: BypassSandbox requested\n > Yes, run command\n   Yes, and always allow for commands that start with "bash"\n   No, deny'

const AGY_ASK: Elicitation = {
  tool_call_id: 'agy-step-12',
  questions: [
    {
      question: '优先落哪一项优化？',
      options: [
        { label: '权限审批卡片' },
        { label: '思考摘要折叠行' },
        { label: '快捷命令面板' },
      ],
    },
    {
      question: '需要顺带同步哪些验证？',
      multi_select: true,
      options: [
        { label: 'Go 单元测试' },
        { label: 'Web 单元测试' },
        { label: '交互调试页' },
      ],
    },
  ],
}

const AGY_THREAD: Array<Message> = [
  { role: 'user', text: '检查 Agy 的工具调用和思考摘要在 Web 中的展示' },
  {
    role: 'system',
    kind: 'thought',
    text: '先读取 agent_agy.go 与 agent_agy_state.go，确认工具参数与权限判定。',
    body: '先读取 agent_agy.go 与 agent_agy_state.go，确认工具参数与权限判定。\n1. 核对 PLANNER_RESPONSE.thinking 映射为 thought 行\n2. 核对 GENERIC 结果按 FIFO 配对到工具调用\n3. 确认权限弹窗只匹配独立菜单行，不误伤正文',
  },
  {
    role: 'tool',
    tool: 'read_file',
    kind: 'read',
    text: 'read_file native/wezdeck-wsl/agent_agy_state.go:102-176',
    result:
      'Showing lines 102-176 of 250\n102: func agyStripMenuPrefix(line string) ...',
  },
  {
    role: 'tool',
    tool: 'run_command',
    kind: 'command',
    text: 'run_command Run Go tests (bypass sandbox)',
    body: 'go test -count=1 -v -run TestAgy ./...',
    result:
      '=== RUN   TestAgyThinkingAndScreenPermissionCard\n--- PASS: TestAgyThinkingAndScreenPermissionCard (0.00s)\nPASS',
  },
  {
    role: 'assistant',
    text: '思考摘要可按需展开，工具调用保留了行号范围、命令正文与结果输出。',
  },
]

const AGY_MODES: Array<{ label: string; mode: string }> = [
  { label: 'Auto 开启（--mode auto）', mode: 'auto' },
  { label: '未开 Auto（default）', mode: 'default' },
  { label: '计划模式（plan）', mode: 'plan' },
  { label: '完全访问（full-access）', mode: 'full-access' },
]

const AGY_STATUS_BASE: Detail = {
  id: 'agy-sample',
  status: 'running',
  agent: 'agy',
  branch: 'dev/observablity-2',
  usage: {
    model: 'gemini-2.5-pro',
    context: 182_000,
    context_limit: 1_000_000,
    input: 4_200,
    output: 12_600,
    cache_read: 0,
    turns: 9,
  },
  git: {
    staged: 0,
    unstaged: 2,
    untracked: 1,
    upstream: true,
    ahead: 1,
    behind: 0,
  },
}

function AgyModeBarDemo() {
  return (
    <div data-testid="agy-mode-bar-demo" className="grid gap-3">
      {AGY_MODES.map(({ label, mode }) => (
        <div
          key={mode}
          className="grid gap-1 rounded-2xl border border-brand-edge px-2.5 py-2"
        >
          <span className="text-meta text-brand-label">{label}</span>
          <SessionStatusBar data={{ ...AGY_STATUS_BASE, mode }} />
        </div>
      ))}
    </div>
  )
}

export function agySections(
  keyFor: (name: string) => (key: string) => Promise<void>,
): Array<Section> {
  return [
    {
      id: 'agy-permission',
      group: 'prompt',
      tags: ['agy'],
      title: {
        zh: 'Agy 权限确认（命令）',
        en: 'Agy permission prompt (command)',
      },
      source: {
        zh: 'Agy 无 PermissionRequest hook：会话处于 running 且全量转录存在未返回工具调用、同时终端末尾出现独立确认菜单行时下发（agent_agy_state.go）',
        en: 'Agy has no PermissionRequest hook: surfaced while running with an unanswered tool call in the full transcript and dedicated confirmation menu lines at the pane tail (agent_agy_state.go)',
      },
      keys: {
        zh: '允许 = Enter（确认默认高亮的 Yes 项）；拒绝 = Esc。持久化白名单规则留在终端选择',
        en: 'Allow = Enter (confirms the highlighted Yes option); Deny = Esc. Persistent allow rules stay at the terminal',
      },
      demo: (
        <PermissionCard
          agent="agy"
          call={AGY_RUN_COMMAND}
          screen={AGY_PERMISSION_SCREEN}
          disabled={false}
          onKey={keyFor('agy-permission')}
        />
      ),
    },
    {
      id: 'agy-ask',
      group: 'prompt',
      tags: ['agy'],
      title: {
        zh: 'Agy 问答（单选 / 多选）',
        en: 'Agy questions (single / multi-select)',
      },
      source: {
        zh: 'PreToolUse hook（ask_question）将 attention 置为 waiting / elicitation_dialog，转录里尚未配对结果的 ask_question 提供题目与选项（agent_agy_state.go）',
        en: 'PreToolUse hook (ask_question) sets attention to waiting / elicitation_dialog; the unanswered ask_question in transcript_full.jsonl supplies questions and options (agent_agy_state.go)',
      },
      keys: {
        zh: '选项序号 1–4；多选切换后 Enter 提交',
        en: 'Option digit 1–4; Enter submits after toggling multi-select choices',
      },
      demo: (
        <AskCard
          agent="agy"
          elicitation={AGY_ASK}
          disabled={false}
          sendKey={keyFor('agy-ask')}
        />
      ),
    },
    {
      id: 'agy-thought',
      group: 'stream',
      tags: ['agy'],
      title: {
        zh: 'Agy 思考摘要与工具细节',
        en: 'Agy thinking & tool details',
      },
      source: {
        zh: 'PLANNER_RESPONSE.thinking 映射为可折叠的 thought 行（ThoughtRow），run_command / read_file 等提取路径行号、命令正文与 FIFO 配对的 GENERIC 结果（agent_agy.go）',
        en: 'PLANNER_RESPONSE.thinking maps to a collapsible thought row (ThoughtRow); run_command / read_file extract path ranges, command body and FIFO-paired GENERIC results (agent_agy.go)',
      },
      keys: {
        zh: '无（点开思考行或工具行查看详情）',
        en: 'None (tap a thought or tool row)',
      },
      demo: <ChatThread messages={AGY_THREAD} start={0} busy={false} />,
    },
    {
      id: 'agy-mode-bar',
      group: 'stream',
      tags: ['agy'],
      title: { zh: 'Agy 状态栏与 Auto 模式', en: 'Agy status bar & Auto mode' },
      source: {
        zh: 'resolveAgyMode 按「会话内切换 > /proc 启动参数 > settings.json > 默认」解析执行模式，底栏高亮区分 Auto 与未开 Auto（session-statusbar.tsx）',
        en: 'resolveAgyMode resolves in-session toggle > /proc launch flags > settings.json > default; the status bar highlights Auto vs not-Auto (session-statusbar.tsx)',
      },
      keys: { zh: '无（四种模式对照）', en: 'None (all four mode states)' },
      demo: <AgyModeBarDemo />,
    },
  ]
}
