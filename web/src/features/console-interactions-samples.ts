// Sample data for 交互调试 (console-interactions.tsx): one of each special
// interaction the session page renders, fed to the real components.
import type { Message } from './chat-thread'
import type { Elicitation } from './session-elicitation'
import type { PendingCall } from './session-permission'
import type { BgTask } from './session-background'

export const ASK_ONE: Elicitation = {
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
export const ASK_MANY: Elicitation = {
  questions: [
    ...ASK_ONE.questions,
    {
      header: '范围',
      question: '统计哪几周？',
      options: [{ label: '本周' }, { label: '近四周' }],
    },
  ],
}
export const BASH: PendingCall = {
  tool: 'Bash',
  text: 'Bash git push origin master',
  body: 'git push origin master',
}
export const EDIT: PendingCall = {
  tool: 'Edit',
  text: 'Edit /r/web/src/lib/upload.ts',
  file: '/r/web/src/lib/upload.ts',
  body: '@@ -8,3 +8,3 @@\n // a phone screenshot is megabytes of PNG\n-const LONG_EDGE = 1600\n+const LONG_EDGE = 1920\n export async function shrinkImage(file: Blob) {',
}
export const PLAN: PendingCall = {
  tool: 'ExitPlanMode',
  text: 'ExitPlanMode',
  plan: true,
  body: '## 计划\n\n1. relay 下发等待确认的工具调用\n2. 网页渲染确认卡片\n3. 交互调试页加入对照',
}
export const SCREEN =
  ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don’t ask again for git push commands\n   3. No, and tell Claude what to do differently (esc)'
export const COMPACT: Array<Message> = [
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
export const SLASH: Array<Message> = [
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
/** a running foreground Bash: its row offers 转到后台 (short and long command) */
export const RUNNING = (command: string): Array<Message> => [
  {
    role: 'tool',
    tool: 'Bash',
    kind: 'command',
    text: `Bash ${command}`,
    pending: true,
  },
]
export const RUNNING_SHORT = 'pnpm test'
export const RUNNING_LONG =
  'cd /home/yuns/github/wezterm-config/web && corepack pnpm exec lingui extract >/dev/null 2>&1; cd .. && scripts/dev/check-web.sh 2>&1 | tail -2'
/** background tasks: a described Bash with output, a long Monitor, an id only */
export const BACKGROUND: Array<BgTask> = [
  {
    id: 'b7k2m9',
    type: 'shell',
    summary: 'task:b7k2m9',
    tool: 'Bash',
    label: 'Run the web cdp tests',
    command:
      'scripts/dev/web-affected-tests.sh --run web/tests/chat-stream.cdp.test.ts',
    started: new Date(Date.now() - 95_000).toISOString(),
    at: 3,
    tail: [
      '✓ tests/chat-stream.cdp.test.ts (1 test) 4446ms',
      ' Test Files  1 passed (1)',
    ],
  },
  {
    id: 'mon4x1',
    type: 'monitor',
    summary: 'task:mon4x1',
    tool: 'Monitor',
    label: 'Watch the relay log for git_status rows slower than 300 ms',
    command:
      'tail -F ~/.local/state/wezterm-runtime/logs/relay.log | grep --line-buffered git_status',
    started: new Date(Date.now() - 12 * 60_000).toISOString(),
  },
  { id: 'q93hz0', type: 'shell', summary: 'task:q93hz0' },
]
